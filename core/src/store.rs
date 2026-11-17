//! The store: one SQLite file that only the core writes (design §3, §5).
//!
//! Every write happens in a [`Tx`]. Committing one takes the next revision,
//! stamps it on every row the transaction wrote, and returns the change a
//! subscribed client must be sent: the rows it can see afterwards that are
//! new or changed, whole, and the ids of rows it could see before and no
//! longer can. A read is a `Tx` that is dropped.
//!
//! The live rule (design §1): a thought is live unless it is finished (done or
//! failed, read, and with no changes pending) and [`LIVE_FINISHED`] newer
//! finished thoughts exist, newer meaning a greater id. A question or result
//! is live with its thought, a question without a thought always. A session
//! is live while it has not ended or while its current thought is live.
//! Projects, terminals, layouts, prefs and devices are always live. Thoughts
//! that left are paged back with [`Tx::history`].

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::types::{Null, ToSqlOutput, Type, ValueRef};
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Params, Row, ToSql, TransactionBehavior, ffi,
    named_params, params,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tasktap_proto::{
    Answer, AttemptId, Change, Changes, Collection, CoreId, Device, DeviceId, HistoryPage, Layout,
    Limit, Outcome, Phase, Pref, PrefKey, PrefValue, Project, ProjectId, Question, QuestionId,
    QuestionState, ResultId, Rev, Rows, Session, SessionId, SessionState, Set, Status, Terminal,
    TerminalId, TerminalState, Thought, ThoughtId, Time, TurnResult,
};

/// Finished thoughts kept live, newest first; older ones leave for history.
pub const LIVE_FINISHED: u32 = 200;

/// The schema, oldest first: entry `n` brings `user_version` from `n` to `n + 1`.
pub const MIGRATIONS: &[&str] = &[SCHEMA_V1];

/// A SHA-256 digest: of a device key, a session token or a call's arguments.
pub type Hash = [u8; 32];

/// Everything the store can fail with.
#[derive(Debug)]
pub enum Error {
    /// The file was written by a newer build; it was left as it was.
    Newer { found: u32, known: u32 },
    /// A migration failed and was rolled back; the file is at the version before it.
    Migration { version: u32, reason: String },
    /// A primary key or unique column already holds the value; SQLite names which.
    Duplicate(String),
    /// A reference names a row that does not exist, or a delete would leave one dangling.
    Reference,
    /// The row to change does not exist.
    NotFound,
    /// A stored value this build cannot read back.
    Corrupt(String),
    /// A file beside the database could not be handled: the backup, or the log.
    Io(std::io::Error),
    /// Any other SQLite failure, such as a full disk.
    Sqlite(rusqlite::Error),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Newer { found, known } => write!(
                f,
                "the database has schema {found}, written by a newer Tasktap; this build knows \
                 schema {known} and left the file untouched"
            ),
            Error::Migration { version, reason } => {
                write!(
                    f,
                    "migration to schema {version} failed and was rolled back: {reason}"
                )
            }
            Error::Duplicate(what) => write!(f, "already exists: {what}"),
            Error::Reference => f.write_str("a reference names a row that does not exist"),
            Error::NotFound => f.write_str("no such row"),
            Error::Corrupt(what) => write!(f, "unreadable stored value: {what}"),
            Error::Io(e) => write!(f, "{e}"),
            Error::Sqlite(e) => write!(f, "sqlite: {e}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(e) => Some(e),
            Error::Sqlite(e) => Some(e),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        use rusqlite::Error as E;
        match &e {
            E::SqliteFailure(f, msg) => match f.extended_code {
                ffi::SQLITE_CONSTRAINT_PRIMARYKEY | ffi::SQLITE_CONSTRAINT_UNIQUE => {
                    Error::Duplicate(msg.clone().unwrap_or_default())
                }
                ffi::SQLITE_CONSTRAINT_FOREIGNKEY => Error::Reference,
                _ => Error::Sqlite(e),
            },
            E::FromSqlConversionFailure(..)
            | E::InvalidColumnType(..)
            | E::IntegralValueOutOfRange(..)
            | E::Utf8Error(..) => Error::Corrupt(e.to_string()),
            _ => Error::Sqlite(e),
        }
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Corrupt(e.to_string())
    }
}

/// An attempt to start a process, committed before the process is spawned (design §3).
#[derive(Clone, Debug, PartialEq)]
pub struct Attempt {
    pub id: AttemptId,
    pub kind: AttemptKind,
    pub args_hash: Hash,
    pub started: Time,
    pub outcome: Option<AttemptOutcome>,
}

/// What an attempt starts, and the record it starts it for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttemptKind {
    Launch(ThoughtId),
    Resume(SessionId),
    Terminal(TerminalId),
    Settle(ThoughtId),
}

#[derive(Clone, Debug, PartialEq)]
pub enum AttemptOutcome {
    /// The reply the first call got, which a repeat of it gets again.
    Reply(Outcome),
    /// The core stopped before an outcome was recorded.
    Interrupted,
}

/// The open database. Only one may be open per file; the core's lock sees to that.
pub struct Store {
    db: Connection,
    rev: u64,
    boot: u64,
    core: CoreId,
}

impl Store {
    /// Opens or creates the database, migrates it, starts a new boot and runs
    /// the recovery pass. Returns the change the recovery made, if any.
    pub fn open(path: &Path) -> Result<(Store, Option<Change>)> {
        Self::open_with(path, MIGRATIONS)
    }

    /// [`Store::open`] with another schema list. Tests use it to prove that
    /// migrations are backed up and atomic.
    #[doc(hidden)]
    pub fn open_with(path: &Path, migrations: &[&str]) -> Result<(Store, Option<Change>)> {
        let known = migrations.len() as u32;
        if path.exists() {
            // Read-only, so a refused file is not even checkpointed.
            let probe = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let found = user_version(&probe)?;
            if found > known {
                return Err(Error::Newer { found, known });
            }
        }
        let mut db = Connection::open(path)?;
        let mode: String = db.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            let why = format!("the file system refused a write-ahead log (journal mode {mode})");
            return Err(Error::Io(std::io::Error::other(why)));
        }
        db.pragma_update(None, "synchronous", "FULL")?;
        migrate(&mut db, path, migrations)?;
        db.pragma_update(None, "foreign_keys", true)?;

        let mut store = Store {
            db,
            rev: 0,
            boot: 0,
            core: CoreId::mint(),
        };
        let tx = store
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO meta (one, core_id, boot, rev) VALUES (1, ?1, 0, 0) ON CONFLICT DO NOTHING",
            [W(&store.core)],
        )?;
        let (core, boot, rev) = tx.query_row(
            "UPDATE meta SET boot = boot + 1 RETURNING core_id, boot, rev",
            [],
            |r| Ok((word(r, 0)?, word(r, 1)?, word(r, 2)?)),
        )?;
        (store.core, store.boot, store.rev) = (core, boot, rev);
        let mut tx = Tx::new(tx, &mut store.rev, boot)?;
        tx.recover(now())?;
        let change = tx.commit()?;
        Ok((store, change))
    }

    /// Starts a transaction. Dropping it without [`Tx::commit`] rolls it back.
    pub fn begin(&mut self) -> Result<Tx<'_>> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        Tx::new(tx, &mut self.rev, self.boot)
    }

    /// Takes the next revision for a change to a memory-only collection.
    /// It is not written: revisions order changes within one run of the core,
    /// and stored rows only ever carry revisions above the stored high-water mark.
    pub fn take_rev(&mut self) -> Result<Rev> {
        let rev = next(self.rev)?;
        self.rev = rev.get();
        Ok(rev)
    }

    /// The last revision taken.
    pub fn rev(&self) -> Rev {
        Rev::new(self.rev).unwrap_or(Rev::ZERO)
    }

    /// This run of the core: one more than the run before.
    pub fn boot(&self) -> u64 {
        self.boot
    }

    pub fn core_id(&self) -> CoreId {
        self.core
    }
}

fn next(rev: u64) -> Result<Rev> {
    Rev::new(rev + 1).ok_or_else(|| Error::Corrupt("the revision counter is exhausted".into()))
}

fn user_version(db: &Connection) -> Result<u32> {
    Ok(db.pragma_query_value(None, "user_version", |r| r.get(0))?)
}

fn migrate(db: &mut Connection, path: &Path, migrations: &[&str]) -> Result<()> {
    let found = user_version(db)?;
    let known = migrations.len() as u32;
    if found > known {
        return Err(Error::Newer { found, known });
    }
    if found == known {
        return Ok(());
    }
    if found > 0 {
        backup(db, path, found)?;
    }
    // Off so that a migration may rebuild a table; checked below before each commit.
    db.pragma_update(None, "foreign_keys", false)?;
    for (version, sql) in (1..).zip(migrations).skip(found as usize) {
        let failed = |e: rusqlite::Error| Error::Migration {
            version,
            reason: e.to_string(),
        };
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(failed)?;
        tx.execute_batch(sql).map_err(failed)?;
        if tx.prepare("PRAGMA foreign_key_check")?.exists([])? {
            return Err(Error::Migration {
                version,
                reason: "it leaves a reference to a missing row".into(),
            });
        }
        tx.pragma_update(None, "user_version", version)
            .map_err(failed)?;
        tx.commit().map_err(failed)?;
    }
    Ok(())
}

/// Copies the database beside itself as `<name>.v<version>.db` before a migration.
fn backup(db: &Connection, path: &Path, version: u32) -> Result<()> {
    let to = path.with_extension(format!("v{version}.db"));
    // VACUUM INTO refuses an existing file; one left by an earlier attempt is
    // a copy of this same version and is superseded.
    match std::fs::remove_file(&to) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(Error::Io(e)),
        _ => {}
    }
    let to = to.to_str().ok_or_else(|| {
        Error::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the backup path is not UTF-8",
        ))
    })?;
    db.execute("VACUUM INTO ?1", [to])?;
    Ok(())
}

fn now() -> Time {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    Time::new(ms).unwrap_or(Time::ZERO)
}

/// The tables clients see, in the order a change lists them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Table {
    Thoughts,
    Projects,
    Sessions,
    Terminals,
    Questions,
    Results,
    Layouts,
    Prefs,
    Devices,
}

/// A row seen by a commit: whether a client could see it before, and whether the transaction wrote it.
type Seen = BTreeMap<(Table, String), (bool, bool)>;

/// One transaction. Fields the store owns are ignored in the rows passed in:
/// `rev`, a thought's `live`, a session's `activity` and a question's `answer`.
pub struct Tx<'s> {
    db: rusqlite::Transaction<'s>,
    counter: &'s mut u64,
    rev: u64,
    boot: u64,
    /// Rows written so far, each with whether a client could see it before.
    wrote: BTreeMap<(Table, String), bool>,
}

impl<'s> Tx<'s> {
    fn new(db: rusqlite::Transaction<'s>, counter: &'s mut u64, boot: u64) -> Result<Self> {
        let rev = next(*counter)?.get();
        Ok(Tx {
            db,
            counter,
            rev,
            boot,
            wrote: BTreeMap::new(),
        })
    }

    /// Commits. Returns `None` when no record changed, which takes no revision.
    /// Otherwise the change's sets are empty only when every row it wrote is
    /// out of the live set.
    pub fn commit(mut self) -> Result<Option<Change>> {
        if self.wrote.is_empty() {
            self.db.commit()?;
            return Ok(None);
        }
        let mut seen: Seen = self
            .wrote
            .iter()
            .map(|(key, &before)| (key.clone(), (before, true)))
            .collect();
        if self.wrote.keys().any(|(t, _)| *t == Table::Thoughts) {
            for (id, live) in self.relive()? {
                for table in [Table::Sessions, Table::Questions, Table::Results] {
                    for (child, before) in self.children(table, &id)? {
                        seen.entry((table, child)).or_insert((before, false));
                    }
                }
                seen.entry((Table::Thoughts, id)).or_insert((!live, false));
            }
        }
        for (table, id) in seen.keys() {
            if let Some(sql) = follow(*table) {
                self.db.prepare_cached(sql)?.execute([id])?;
            }
        }
        let mut sets = Vec::new();
        macro_rules! emit {
            ($($set:ident $read:ident),*) => {
                $(self.emit(&seen, Table::$set, $read, Set::$set, &mut sets)?;)*
            };
        }
        emit!(Thoughts read_thought, Projects read_project, Sessions read_session,
              Terminals read_terminal, Questions read_question, Results read_result,
              Layouts read_layout, Prefs read_pref, Devices read_device);
        self.db
            .execute("UPDATE meta SET rev = ?1", [W(&self.rev)])?;
        let Tx {
            db, counter, rev, ..
        } = self;
        db.commit()?;
        *counter = rev;
        Ok(Some(Change {
            rev: Rev::new(rev).unwrap_or(Rev::ZERO),
            snap: false,
            sets,
        }))
    }

    /// Brings every thought's live flag in line with the rule, stamping those
    /// that flip. Returns them with their new flag.
    fn relive(&mut self) -> Result<Vec<(String, bool)>> {
        let rev = self.rev;
        // With fewer finished thoughts than the bound the cutoff is "", below every id.
        let cutoff: String = self
            .db
            .prepare_cached(
                "SELECT id FROM thoughts WHERE finished = 1 ORDER BY id DESC LIMIT 1 OFFSET ?1",
            )?
            .query_row([LIVE_FINISHED - 1], |r| r.get(0))
            .optional()?
            .unwrap_or_default();
        let mut flipped = Vec::new();
        for id in self.ids(
            "UPDATE thoughts SET live = 0, rev = ?1 \
             WHERE live = 1 AND finished = 1 AND id < ?2 RETURNING id",
            params![W(&rev), cutoff],
        )? {
            flipped.push((id, false));
        }
        for id in self.ids(
            "UPDATE thoughts SET live = 1, rev = ?1 WHERE live = 0 AND finished = 0 RETURNING id",
            params![W(&rev)],
        )? {
            flipped.push((id, true));
        }
        for id in self.ids(
            "UPDATE thoughts SET live = 1, rev = ?1 \
             WHERE live = 0 AND finished = 1 AND id >= ?2 RETURNING id",
            params![W(&rev), cutoff],
        )? {
            flipped.push((id, true));
        }
        Ok(flipped)
    }

    fn children(&self, table: Table, thought: &str) -> Result<Vec<(String, bool)>> {
        let sql = match table {
            Table::Sessions => "SELECT id, live FROM sessions WHERE thought_id = ?1",
            Table::Questions => "SELECT id, live FROM questions WHERE thought_id = ?1",
            _ => "SELECT id, live FROM results WHERE thought_id = ?1",
        };
        let mut stmt = self.db.prepare_cached(sql)?;
        let rows = stmt.query_map([thought], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn emit<R, I: DeserializeOwned>(
        &self,
        seen: &Seen,
        table: Table,
        read: Reader<R>,
        wrap: fn(Rows<R, I>) -> Set,
        sets: &mut Vec<Set>,
    ) -> Result<()> {
        let mut rows = Rows {
            put: Vec::new(),
            del: Vec::new(),
        };
        for ((_, id), &(before, wrote)) in seen.iter().filter(|((t, _), _)| *t == table) {
            match read(&self.db, id)? {
                Some((row, true)) => {
                    if wrote || !before {
                        rows.put.push(row);
                    }
                }
                _ if before => rows.del.push(parse(id)?),
                _ => {}
            }
        }
        if !rows.put.is_empty() || !rows.del.is_empty() {
            sets.push(wrap(rows));
        }
        Ok(())
    }

    fn ids(&self, sql: &str, params: impl Params) -> Result<Vec<String>> {
        let mut stmt = self.db.prepare_cached(sql)?;
        let rows = stmt.query_map(params, |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Runs a write whose statement returns whether a client could see the
    /// row before, and remembers the row. False when no row matched.
    fn write(&mut self, table: Table, id: String, sql: &str, params: impl Params) -> Result<bool> {
        let before: Option<bool> = self
            .db
            .prepare_cached(sql)?
            .query_row(params, |r| r.get(0))
            .optional()?;
        if let Some(before) = before {
            self.wrote.entry((table, id)).or_insert(before);
        }
        Ok(before.is_some())
    }

    /// Writes a row that is always live, inserting or replacing it.
    fn upsert(
        &mut self,
        table: Table,
        id: String,
        exists: &str,
        sql: &str,
        params: impl Params,
    ) -> Result<()> {
        let before: bool = self
            .db
            .prepare_cached(exists)?
            .query_row([&id], |r| r.get(0))?;
        self.db.prepare_cached(sql)?.execute(params)?;
        self.wrote.entry((table, id)).or_insert(before);
        Ok(())
    }

    /// The recovery pass (design §3): nothing of an earlier boot still runs,
    /// so it closes what was left open and never opens or starts anything.
    fn recover(&mut self, now: Time) -> Result<()> {
        let running = self.ids(
            "SELECT id FROM terminals WHERE state = 'running' AND boot < ?1",
            [W(&self.boot)],
        )?;
        for id in running {
            if let Some((mut t, _)) = read_terminal(&self.db, &id)? {
                t.state = TerminalState::Lost;
                self.update_terminal(&t)?;
            }
        }
        // A session lives only through a running terminal of this core; that
        // also ends one whose launch was committed but whose terminal never was.
        let orphaned = self.ids(
            "SELECT id FROM sessions WHERE state <> 'ended' AND NOT EXISTS \
             (SELECT 1 FROM terminals t WHERE t.id = sessions.terminal_id AND t.state = 'running')",
            [],
        )?;
        for id in orphaned {
            if let Some((mut s, _)) = read_session(&self.db, &id)? {
                s.state = SessionState::Ended;
                self.update_session(&s)?;
            }
        }
        let interrupted = self.ids(
            "SELECT id FROM thoughts WHERE phase = 'working' AND NOT EXISTS \
             (SELECT 1 FROM sessions s WHERE s.id = thoughts.session_id AND s.state <> 'ended')",
            [],
        )?;
        for q in self.open_questions()? {
            let ended = match q.session_id {
                Some(s) => self
                    .session(s)?
                    .is_some_and(|s| s.state == SessionState::Ended),
                None => false,
            };
            let thought = q.thought_id.map(|t| key(&t)).transpose()?;
            if ended || thought.is_some_and(|t| interrupted.contains(&t)) {
                self.set_question_state(q.id, QuestionState::Withdrawn)?;
            }
        }
        // Every open question of these was just withdrawn, so none needs you.
        for id in &interrupted {
            if let Some((mut t, _)) = read_thought(&self.db, id)? {
                t.phase = Phase::Failed;
                t.reason = Some(tasktap_proto::Reason::Interrupted);
                t.status = Status::Failed;
                t.updated = now;
                self.update_thought(&t)?;
            }
        }
        // Hold timers are not restored: a held thought waits for Start.
        for id in self.ids("SELECT id FROM thoughts WHERE hold_until IS NOT NULL", [])? {
            if let Some((mut t, _)) = read_thought(&self.db, &id)? {
                t.hold_until = None;
                self.update_thought(&t)?;
            }
        }
        self.db.execute(
            "UPDATE attempts SET outcome = '\"interrupted\"' WHERE outcome IS NULL",
            [],
        )?;
        Ok(())
    }

    // Reads.

    pub fn thought(&self, id: ThoughtId) -> Result<Option<Thought>> {
        Ok(read_thought(&self.db, &key(&id)?)?.map(|r| r.0))
    }

    /// The session's thoughts that are captured, routed or working, oldest first.
    pub fn thoughts_in_flight(&self, session: SessionId) -> Result<Vec<Thought>> {
        self.all(
            concat!(
                thought_select!(),
                " WHERE session_id = ?1 ",
                "AND phase IN ('captured', 'routed', 'working') ORDER BY id"
            ),
            [W(&session)],
            thought_row,
        )
    }

    pub fn project(&self, id: ProjectId) -> Result<Option<Project>> {
        Ok(read_project(&self.db, &key(&id)?)?.map(|r| r.0))
    }

    /// The project that holds a canonical folder.
    pub fn project_by_folder(&self, folder: &str) -> Result<Option<Project>> {
        let sql = concat!(project_select!(), " WHERE folder = ?1");
        Ok(one(&self.db, sql, folder, project_row)?.map(|r| r.0))
    }

    pub fn session(&self, id: SessionId) -> Result<Option<Session>> {
        Ok(read_session(&self.db, &key(&id)?)?.map(|r| r.0))
    }

    /// The newest session in a terminal that has not ended.
    pub fn terminal_session(&self, terminal: TerminalId) -> Result<Option<Session>> {
        let sql = concat!(
            session_select!(),
            " WHERE terminal_id = ?1 ",
            "AND state <> 'ended' ORDER BY id DESC LIMIT 1"
        );
        Ok(one(&self.db, sql, &key(&terminal)?, session_row)?.map(|r| r.0))
    }

    pub fn terminal(&self, id: TerminalId) -> Result<Option<Terminal>> {
        Ok(read_terminal(&self.db, &key(&id)?)?.map(|r| r.0))
    }

    /// The terminal a session token was minted for.
    pub fn terminal_by_token(&self, token_hash: &Hash) -> Result<Option<Terminal>> {
        let sql = concat!(terminal_select!(), " WHERE token_hash = ?1");
        Ok(self
            .db
            .prepare_cached(sql)?
            .query_row([token_hash], terminal_row)
            .optional()?
            .map(|r| r.0))
    }

    pub fn question(&self, id: QuestionId) -> Result<Option<Question>> {
        Ok(read_question(&self.db, &key(&id)?)?.map(|r| r.0))
    }

    pub fn question_by_request(&self, request_key: &str) -> Result<Option<Question>> {
        let sql = concat!(question_select!(), " WHERE q.request_key = ?1");
        Ok(one(&self.db, sql, request_key, question_row)?.map(|r| r.0))
    }

    /// Every open question, oldest first.
    pub fn open_questions(&self) -> Result<Vec<Question>> {
        let sql = concat!(question_select!(), " WHERE q.state = 'open' ORDER BY q.id");
        self.all(sql, [], question_row)
    }

    /// A result's body, which is not part of the record.
    pub fn result_body(&self, id: ResultId) -> Result<Option<String>> {
        let sql = "SELECT body FROM results WHERE id = ?1";
        Ok(self
            .db
            .prepare_cached(sql)?
            .query_row([W(&id)], |r| r.get(0))
            .optional()?)
    }

    pub fn layout(&self, project: ProjectId) -> Result<Option<Layout>> {
        Ok(read_layout(&self.db, &key(&project)?)?.map(|r| r.0))
    }

    pub fn pref(&self, key: PrefKey) -> Result<Option<Pref>> {
        Ok(read_pref(&self.db, &self::key(&key)?)?.map(|r| r.0))
    }

    /// A device with the hash of its key.
    pub fn device(&self, id: DeviceId) -> Result<Option<(Device, Hash)>> {
        let sql = concat!(device_select!(), " WHERE id = ?1");
        one(&self.db, sql, &key(&id)?, |r| {
            Ok((device_row(r)?.0, r.get(6)?))
        })
    }

    pub fn attempt(&self, id: AttemptId) -> Result<Option<Attempt>> {
        let sql = "SELECT kind, target, args_hash, started, outcome FROM attempts WHERE id = ?1";
        let row = self
            .db
            .prepare_cached(sql)?
            .query_row([W(&id)], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get(2)?,
                    word(r, 3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            })
            .optional()?;
        let Some((kind, target, args_hash, started, outcome)) = row else {
            return Ok(None);
        };
        let kind = match kind.as_str() {
            "launch" => AttemptKind::Launch(parse(&target)?),
            "resume" => AttemptKind::Resume(parse(&target)?),
            "terminal" => AttemptKind::Terminal(parse(&target)?),
            "settle" => AttemptKind::Settle(parse(&target)?),
            other => return Err(Error::Corrupt(format!("attempt kind {other}"))),
        };
        let outcome = match outcome {
            None => None,
            Some(text) => match serde_json::from_str::<Value>(&text)? {
                Value::String(s) if s == "interrupted" => Some(AttemptOutcome::Interrupted),
                reply => Some(AttemptOutcome::Reply(serde_json::from_value(reply)?)),
            },
        };
        Ok(Some(Attempt {
            id,
            kind,
            args_hash,
            started,
            outcome,
        }))
    }

    /// Every live row of a stored collection, oldest first; `None` for one kept in memory.
    pub fn live(&self, c: Collection) -> Result<Option<Set>> {
        macro_rules! all {
            ($set:ident, $select:ident, $rest:literal, $row:ident) => {
                Set::$set(Rows {
                    put: self.all(concat!($select!(), " ", $rest), [], $row)?,
                    del: Vec::new(),
                })
            };
        }
        Ok(Some(match c {
            Collection::Thoughts => all!(
                Thoughts,
                thought_select,
                "WHERE live = 1 ORDER BY id",
                thought_row
            ),
            Collection::Projects => all!(Projects, project_select, "ORDER BY id", project_row),
            Collection::Sessions => all!(
                Sessions,
                session_select,
                "WHERE live = 1 ORDER BY id",
                session_row
            ),
            Collection::Terminals => all!(Terminals, terminal_select, "ORDER BY id", terminal_row),
            Collection::Questions => {
                all!(
                    Questions,
                    question_select,
                    "WHERE q.live = 1 ORDER BY q.id",
                    question_row
                )
            }
            Collection::Results => all!(
                Results,
                result_select,
                "WHERE live = 1 ORDER BY id",
                result_row
            ),
            Collection::Layouts => all!(Layouts, layout_select, "ORDER BY project_id", layout_row),
            Collection::Prefs => all!(Prefs, pref_select, "ORDER BY key", pref_row),
            Collection::Devices => all!(Devices, device_select, "ORDER BY id", device_row),
            Collection::Glance => return Ok(None),
        }))
    }

    /// Thoughts that left the live set and are older than `before`, newest
    /// first, with their questions and results.
    pub fn history(&self, before: Option<ThoughtId>, limit: Limit) -> Result<HistoryPage> {
        // Every id sorts below "~", so no `before` means no bound.
        let before = before.map(|b| key(&b)).transpose()?;
        let params = params![before.as_deref().unwrap_or("~"), limit.get()];
        macro_rules! page {
            () => {
                "WHERE live = 0 AND finished = 1 AND id < ?1 ORDER BY id DESC LIMIT ?2"
            };
        }
        macro_rules! of_page {
            () => {
                concat!("IN (SELECT id FROM thoughts ", page!(), ")")
            };
        }
        Ok(HistoryPage {
            thoughts: self.all(
                concat!(thought_select!(), " ", page!()),
                params,
                thought_row,
            )?,
            questions: self.all(
                concat!(
                    question_select!(),
                    " WHERE q.thought_id ",
                    of_page!(),
                    " ORDER BY q.id"
                ),
                params,
                question_row,
            )?,
            results: self.all(
                concat!(
                    result_select!(),
                    " WHERE thought_id ",
                    of_page!(),
                    " ORDER BY id"
                ),
                params,
                result_row,
            )?,
        })
    }

    fn all<R>(&self, sql: &str, params: impl Params, f: Mapper<R>) -> Result<Vec<R>> {
        let mut stmt = self.db.prepare_cached(sql)?;
        let rows = stmt.query_map(params, |r| Ok(f(r)?.0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    // Writes. An update or delete of a row that is not there is `NotFound`;
    // a failed write changes nothing, but the caller should drop the transaction.

    pub fn insert_thought(&mut self, t: &Thought) -> Result<()> {
        self.write_thought(
            concat!(
                "INSERT INTO thoughts (id, rev, live, finished, text, strokes, source, mode, phase, ",
                "status, reason, project_id, session_id, brief, agent, model, workdir, hold_until, ",
                "read, created, updated) VALUES (:id, :rev, 0, :finished, :text, :strokes, :source, ",
                ":mode, :phase, :status, :reason, :project_id, :session_id, :brief, :agent, :model, ",
                ":workdir, :hold_until, :read, :created, :updated) RETURNING 0"
            ),
            t,
        )
        .map(drop)
    }

    pub fn update_thought(&mut self, t: &Thought) -> Result<()> {
        found(self.write_thought(
            concat!(
                "UPDATE thoughts SET rev = :rev, finished = :finished, text = :text, ",
                "strokes = :strokes, source = :source, mode = :mode, phase = :phase, ",
                "status = :status, reason = :reason, project_id = :project_id, ",
                "session_id = :session_id, brief = :brief, agent = :agent, model = :model, ",
                "workdir = :workdir, hold_until = :hold_until, read = :read, created = :created, ",
                "updated = :updated WHERE id = :id RETURNING live"
            ),
            t,
        )?)
    }

    fn write_thought(&mut self, sql: &str, t: &Thought) -> Result<bool> {
        let finished = matches!(t.phase, Phase::Done | Phase::Failed)
            && t.read
            && !t
                .workdir
                .as_ref()
                .is_some_and(|w| w.changes == Changes::Pending);
        let rev = self.rev;
        self.write(
            Table::Thoughts,
            key(&t.id)?,
            sql,
            named_params! {
                ":id": W(&t.id), ":rev": W(&rev), ":finished": finished, ":text": t.text,
                ":strokes": J(&t.strokes), ":source": W(&t.source), ":mode": W(&t.mode),
                ":phase": W(&t.phase), ":status": W(&t.status), ":reason": W(&t.reason),
                ":project_id": W(&t.project_id), ":session_id": W(&t.session_id),
                ":brief": t.brief, ":agent": t.agent, ":model": t.model,
                ":workdir": J(&t.workdir), ":hold_until": W(&t.hold_until), ":read": t.read,
                ":created": W(&t.created), ":updated": W(&t.updated),
            },
        )
    }

    /// Removes a thought with its questions, their answers, and its results.
    /// A session whose current thought it is makes this `Reference`.
    pub fn delete_thought(&mut self, id: ThoughtId) -> Result<bool> {
        let id = key(&id)?;
        let named: bool = self
            .db
            .prepare_cached("SELECT EXISTS (SELECT 1 FROM sessions WHERE thought_id = ?1)")?
            .query_row([&id], |r| r.get(0))?;
        if named {
            return Err(Error::Reference);
        }
        for (table, sql) in [
            (
                Table::Questions,
                "DELETE FROM questions WHERE thought_id = ?1 RETURNING id, live",
            ),
            (
                Table::Results,
                "DELETE FROM results WHERE thought_id = ?1 RETURNING id, live",
            ),
        ] {
            let mut stmt = self.db.prepare_cached(sql)?;
            let gone = stmt
                .query_map([&id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            for (child, before) in gone {
                self.wrote.entry((table, child)).or_insert(before);
            }
        }
        self.write(
            Table::Thoughts,
            id.clone(),
            "DELETE FROM thoughts WHERE id = ?1 RETURNING live",
            [&id],
        )
    }

    pub fn insert_project(&mut self, p: &Project) -> Result<()> {
        self.write_project(
            concat!(
                "INSERT INTO projects (id, rev, name, folder, kind, color, aliases, git, isolate, ",
                "open, available) VALUES (:id, :rev, :name, :folder, :kind, :color, :aliases, ",
                ":git, :isolate, :open, :available) RETURNING 0"
            ),
            p,
        )
        .map(drop)
    }

    pub fn update_project(&mut self, p: &Project) -> Result<()> {
        found(self.write_project(
            concat!(
                "UPDATE projects SET rev = :rev, name = :name, folder = :folder, kind = :kind, ",
                "color = :color, aliases = :aliases, git = :git, isolate = :isolate, open = :open, ",
                "available = :available WHERE id = :id RETURNING 1"
            ),
            p,
        )?)
    }

    fn write_project(&mut self, sql: &str, p: &Project) -> Result<bool> {
        let rev = self.rev;
        self.write(
            Table::Projects,
            key(&p.id)?,
            sql,
            named_params! {
                ":id": W(&p.id), ":rev": W(&rev), ":name": p.name, ":folder": p.folder,
                ":kind": W(&p.kind), ":color": p.color, ":aliases": J(&p.aliases), ":git": p.git,
                ":isolate": W(&p.isolate), ":open": p.open, ":available": p.available,
            },
        )
    }

    pub fn insert_session(&mut self, s: &Session) -> Result<()> {
        self.write_session(
            concat!(
                "INSERT INTO sessions (id, rev, live, project_id, agent, terminal_id, adopted, ",
                "state, thought_id, turn, resume, name, named_at, model, cwd, exit, error) VALUES ",
                "(:id, :rev, 0, :project_id, :agent, :terminal_id, :adopted, :state, :thought_id, ",
                ":turn, :resume, :name, :named_at, :model, :cwd, :exit, :error) RETURNING 0"
            ),
            s,
        )
        .map(drop)
    }

    pub fn update_session(&mut self, s: &Session) -> Result<()> {
        found(self.write_session(
            concat!(
                "UPDATE sessions SET rev = :rev, project_id = :project_id, agent = :agent, ",
                "terminal_id = :terminal_id, adopted = :adopted, state = :state, ",
                "thought_id = :thought_id, turn = :turn, resume = :resume, name = :name, ",
                "named_at = :named_at, model = :model, cwd = :cwd, exit = :exit, error = :error ",
                "WHERE id = :id RETURNING live"
            ),
            s,
        )?)
    }

    fn write_session(&mut self, sql: &str, s: &Session) -> Result<bool> {
        let rev = self.rev;
        self.write(
            Table::Sessions,
            key(&s.id)?,
            sql,
            named_params! {
                ":id": W(&s.id), ":rev": W(&rev), ":project_id": W(&s.project_id), ":agent": s.agent,
                ":terminal_id": W(&s.terminal_id), ":adopted": s.adopted, ":state": W(&s.state),
                ":thought_id": W(&s.thought_id), ":turn": s.turn, ":resume": s.resume,
                ":name": s.name, ":named_at": W(&s.named_at), ":model": s.model, ":cwd": s.cwd,
                ":exit": s.exit, ":error": s.error,
            },
        )
    }

    /// Records a terminal of this boot, with the hash of its session token if it has one.
    pub fn insert_terminal(&mut self, t: &Terminal, token_hash: Option<&Hash>) -> Result<()> {
        self.write_terminal(
            concat!(
                "INSERT INTO terminals (id, rev, project_id, kind, title, cwd, argv, cols, \"rows\", ",
                "state, exit, \"offset\", boot, token_hash) VALUES (:id, :rev, :project_id, :kind, ",
                ":title, :cwd, :argv, :cols, :rows, :state, :exit, :offset, :boot, :token_hash) ",
                "RETURNING 0"
            ),
            t,
            token_hash,
        )
        .map(drop)
    }

    /// Updates a terminal and marks it as written by this boot; its token stays.
    pub fn update_terminal(&mut self, t: &Terminal) -> Result<()> {
        found(self.write_terminal(
            concat!(
                "UPDATE terminals SET rev = :rev, project_id = :project_id, kind = :kind, ",
                "title = :title, cwd = :cwd, argv = :argv, cols = :cols, \"rows\" = :rows, ",
                "state = :state, exit = :exit, \"offset\" = :offset, boot = :boot, ",
                "token_hash = coalesce(:token_hash, token_hash) WHERE id = :id RETURNING 1"
            ),
            t,
            None,
        )?)
    }

    fn write_terminal(&mut self, sql: &str, t: &Terminal, token: Option<&Hash>) -> Result<bool> {
        let (rev, boot) = (self.rev, self.boot);
        self.write(
            Table::Terminals,
            key(&t.id)?,
            sql,
            named_params! {
                ":id": W(&t.id), ":rev": W(&rev), ":project_id": W(&t.project_id),
                ":kind": W(&t.kind), ":title": t.title, ":cwd": t.cwd, ":argv": J(&t.argv),
                ":cols": t.cols, ":rows": t.rows, ":state": W(&t.state), ":exit": t.exit,
                ":offset": W(&t.offset), ":boot": W(&boot), ":token_hash": token,
            },
        )
    }

    /// Inserts a question under the asker's key, which no other question may hold.
    pub fn insert_question(&mut self, q: &Question, request_key: &str) -> Result<()> {
        let rev = self.rev;
        self.write(
            Table::Questions,
            key(&q.id)?,
            concat!(
                "INSERT INTO questions (id, rev, live, thought_id, session_id, turn, source, kind, ",
                "prompt, detail, reply_via, request_key, state) VALUES (:id, :rev, 0, :thought_id, ",
                ":session_id, :turn, :source, :kind, :prompt, :detail, :reply_via, :request_key, ",
                ":state) RETURNING 0"
            ),
            named_params! {
                ":id": W(&q.id), ":rev": W(&rev), ":thought_id": W(&q.thought_id),
                ":session_id": W(&q.session_id), ":turn": q.turn, ":source": W(&q.source),
                ":kind": J(&q.kind), ":prompt": q.prompt, ":detail": q.detail,
                ":reply_via": W(&q.reply_via), ":request_key": request_key, ":state": W(&q.state),
            },
        )
        .map(drop)
    }

    /// A question's state is the only part of it that changes.
    pub fn set_question_state(&mut self, id: QuestionId, state: QuestionState) -> Result<()> {
        let rev = self.rev;
        found(self.write(
            Table::Questions,
            key(&id)?,
            "UPDATE questions SET state = ?1, rev = ?2 WHERE id = ?3 RETURNING live",
            params![W(&state), W(&rev), W(&id)],
        )?)
    }

    /// Stores the answer to a question. A second answer to it is `Duplicate`.
    pub fn insert_answer(&mut self, question: QuestionId, a: &Answer) -> Result<()> {
        self.db
            .prepare_cached(
                "INSERT INTO answers (question_id, response, device_id, created, delivered) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?
            .execute(params![
                W(&question),
                J(&a.response),
                W(&a.device_id),
                W(&a.created),
                W(&a.delivered)
            ])?;
        self.touch_question(question)
    }

    /// Records when the waiter confirmed it received the answer.
    pub fn set_delivered(&mut self, question: QuestionId, at: Time) -> Result<()> {
        let n = self
            .db
            .prepare_cached("UPDATE answers SET delivered = ?1 WHERE question_id = ?2")?
            .execute(params![W(&at), W(&question)])?;
        if n == 0 {
            return Err(Error::NotFound);
        }
        self.touch_question(question)
    }

    /// Stamps a question whose answer changed, since clients see the answer inside it.
    fn touch_question(&mut self, id: QuestionId) -> Result<()> {
        let rev = self.rev;
        found(self.write(
            Table::Questions,
            key(&id)?,
            "UPDATE questions SET rev = ?1 WHERE id = ?2 RETURNING live",
            params![W(&rev), W(&id)],
        )?)
    }

    /// Stores a result; results never change.
    pub fn insert_result(&mut self, r: &TurnResult, body: &str) -> Result<()> {
        let rev = self.rev;
        self.write(
            Table::Results,
            key(&r.id)?,
            concat!(
                "INSERT INTO results (id, rev, live, thought_id, session_id, turn, kind, summary, ",
                "body) VALUES (:id, :rev, 0, :thought_id, :session_id, :turn, :kind, :summary, ",
                ":body) RETURNING 0"
            ),
            named_params! {
                ":id": W(&r.id), ":rev": W(&rev), ":thought_id": W(&r.thought_id),
                ":session_id": W(&r.session_id), ":turn": r.turn, ":kind": W(&r.kind),
                ":summary": r.summary, ":body": body,
            },
        )
        .map(drop)
    }

    pub fn put_layout(&mut self, l: &Layout) -> Result<()> {
        let rev = self.rev;
        self.upsert(
            Table::Layouts,
            key(&l.id)?,
            "SELECT EXISTS (SELECT 1 FROM layouts WHERE project_id = ?1)",
            "INSERT INTO layouts (project_id, rev, tree) VALUES (?1, ?2, ?3) \
             ON CONFLICT (project_id) DO UPDATE SET rev = excluded.rev, tree = excluded.tree",
            params![W(&l.id), W(&rev), J(&l.tree)],
        )
    }

    pub fn delete_layout(&mut self, project: ProjectId) -> Result<bool> {
        let id = key(&project)?;
        self.write(
            Table::Layouts,
            id.clone(),
            "DELETE FROM layouts WHERE project_id = ?1 RETURNING 1",
            [&id],
        )
    }

    pub fn put_pref(&mut self, value: &PrefValue) -> Result<()> {
        let rev = self.rev;
        let id = key(&value.key())?;
        self.upsert(
            Table::Prefs,
            id.clone(),
            "SELECT EXISTS (SELECT 1 FROM prefs WHERE key = ?1)",
            "INSERT INTO prefs (key, rev, value) VALUES (?1, ?2, ?3) \
             ON CONFLICT (key) DO UPDATE SET rev = excluded.rev, value = excluded.value",
            params![id, W(&rev), J(value)],
        )
    }

    pub fn delete_pref(&mut self, pref: PrefKey) -> Result<bool> {
        let id = key(&pref)?;
        self.write(
            Table::Prefs,
            id.clone(),
            "DELETE FROM prefs WHERE key = ?1 RETURNING 1",
            [&id],
        )
    }

    /// Registers a device with the hash of its key.
    pub fn insert_device(&mut self, d: &Device, key_hash: &Hash) -> Result<()> {
        self.write_device(
            "INSERT INTO devices (id, rev, name, key_hash, last_seen, revoked) \
             VALUES (:id, :rev, :name, :key_hash, :last_seen, :revoked) RETURNING 0",
            d,
            Some(key_hash),
        )
        .map(drop)
    }

    /// Updates a device; its key stays.
    pub fn update_device(&mut self, d: &Device) -> Result<()> {
        found(self.write_device(
            "UPDATE devices SET rev = :rev, name = :name, key_hash = coalesce(:key_hash, key_hash), \
             last_seen = :last_seen, revoked = :revoked WHERE id = :id RETURNING 1",
            d,
            None,
        )?)
    }

    fn write_device(&mut self, sql: &str, d: &Device, key_hash: Option<&Hash>) -> Result<bool> {
        let rev = self.rev;
        self.write(
            Table::Devices,
            key(&d.id)?,
            sql,
            named_params! {
                ":id": W(&d.id), ":rev": W(&rev), ":name": d.name, ":key_hash": key_hash,
                ":last_seen": W(&d.last_seen), ":revoked": d.revoked,
            },
        )
    }

    /// Commits an attempt before its process is spawned; the same id twice is `Duplicate`.
    /// Attempts are not records, so writing one takes no revision.
    pub fn insert_attempt(&mut self, a: &Attempt) -> Result<()> {
        let (kind, target) = match a.kind {
            AttemptKind::Launch(t) => ("launch", key(&t)?),
            AttemptKind::Resume(s) => ("resume", key(&s)?),
            AttemptKind::Terminal(t) => ("terminal", key(&t)?),
            AttemptKind::Settle(t) => ("settle", key(&t)?),
        };
        self.db
            .prepare_cached(
                "INSERT INTO attempts (id, kind, target, args_hash, started, outcome) \
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
            )?
            .execute(params![W(&a.id), kind, target, a.args_hash, W(&a.started)])?;
        if let Some(outcome) = &a.outcome {
            self.set_outcome(a.id, outcome)?;
        }
        Ok(())
    }

    /// Records the outcome of an attempt that has none; `NotFound` otherwise,
    /// since the first outcome is the one every repeat gets.
    pub fn set_outcome(&mut self, id: AttemptId, outcome: &AttemptOutcome) -> Result<()> {
        let text = match outcome {
            AttemptOutcome::Reply(reply) => serde_json::to_string(reply)?,
            AttemptOutcome::Interrupted => "\"interrupted\"".into(),
        };
        let n = self
            .db
            .prepare_cached("UPDATE attempts SET outcome = ?1 WHERE id = ?2 AND outcome IS NULL")?
            .execute(params![text, W(&id)])?;
        if n == 0 {
            return Err(Error::NotFound);
        }
        Ok(())
    }
}

fn found(matched: bool) -> Result<()> {
    if matched {
        Ok(())
    } else {
        Err(Error::NotFound)
    }
}

/// The SQL that recomputes a row's live flag from its thought, for tables that follow one.
fn follow(table: Table) -> Option<&'static str> {
    Some(match table {
        Table::Sessions => {
            "UPDATE sessions SET live = (state <> 'ended' OR coalesce( \
             (SELECT live FROM thoughts t WHERE t.id = sessions.thought_id), 0)) WHERE id = ?1"
        }
        Table::Questions => {
            "UPDATE questions SET live = coalesce( \
             (SELECT live FROM thoughts t WHERE t.id = questions.thought_id), 1) WHERE id = ?1"
        }
        Table::Results => {
            "UPDATE results SET live = \
             (SELECT live FROM thoughts t WHERE t.id = results.thought_id) WHERE id = ?1"
        }
        _ => return None,
    })
}

// Rows. Each mapper returns the record and whether a client can see it,
// which every column list below ends with.

type Mapper<R> = fn(&Row) -> rusqlite::Result<(R, bool)>;
type Reader<R> = fn(&Connection, &str) -> Result<Option<(R, bool)>>;

fn one<R>(
    db: &Connection,
    sql: &str,
    id: &str,
    f: impl FnOnce(&Row) -> rusqlite::Result<R>,
) -> Result<Option<R>> {
    Ok(db.prepare_cached(sql)?.query_row([id], f).optional()?)
}

macro_rules! thought_select {
    () => {
        "SELECT id, rev, text, strokes, source, mode, phase, status, reason, live, project_id, \
         session_id, brief, agent, model, workdir, hold_until, read, created, updated, live \
         FROM thoughts"
    };
}
use thought_select;

fn thought_row(r: &Row) -> rusqlite::Result<(Thought, bool)> {
    let t = Thought {
        id: word(r, 0)?,
        rev: word(r, 1)?,
        text: r.get(2)?,
        strokes: json(r, 3)?,
        source: word(r, 4)?,
        mode: word(r, 5)?,
        phase: word(r, 6)?,
        status: word(r, 7)?,
        reason: word(r, 8)?,
        live: r.get(9)?,
        project_id: word(r, 10)?,
        session_id: word(r, 11)?,
        brief: r.get(12)?,
        agent: r.get(13)?,
        model: r.get(14)?,
        workdir: json(r, 15)?,
        hold_until: word(r, 16)?,
        read: r.get(17)?,
        created: word(r, 18)?,
        updated: word(r, 19)?,
    };
    Ok((t, r.get(20)?))
}

fn read_thought(db: &Connection, id: &str) -> Result<Option<(Thought, bool)>> {
    let sql = concat!(thought_select!(), " WHERE id = ?1");
    one(db, sql, id, thought_row)
}

macro_rules! project_select {
    () => {
        "SELECT id, rev, name, folder, kind, color, aliases, git, isolate, open, available, 1 \
         FROM projects"
    };
}
use project_select;

fn project_row(r: &Row) -> rusqlite::Result<(Project, bool)> {
    let p = Project {
        id: word(r, 0)?,
        rev: word(r, 1)?,
        name: r.get(2)?,
        folder: r.get(3)?,
        kind: word(r, 4)?,
        color: r.get(5)?,
        aliases: json(r, 6)?,
        git: r.get(7)?,
        isolate: word(r, 8)?,
        open: r.get(9)?,
        available: r.get(10)?,
    };
    Ok((p, r.get(11)?))
}

fn read_project(db: &Connection, id: &str) -> Result<Option<(Project, bool)>> {
    let sql = concat!(project_select!(), " WHERE id = ?1");
    one(db, sql, id, project_row)
}

macro_rules! session_select {
    () => {
        "SELECT id, rev, project_id, agent, terminal_id, adopted, state, thought_id, turn, resume, \
         name, named_at, model, cwd, exit, error, live FROM sessions"
    };
}
use session_select;

fn session_row(r: &Row) -> rusqlite::Result<(Session, bool)> {
    let s = Session {
        id: word(r, 0)?,
        rev: word(r, 1)?,
        project_id: word(r, 2)?,
        agent: r.get(3)?,
        terminal_id: word(r, 4)?,
        adopted: r.get(5)?,
        state: word(r, 6)?,
        thought_id: word(r, 7)?,
        turn: r.get(8)?,
        resume: r.get(9)?,
        name: r.get(10)?,
        named_at: word(r, 11)?,
        model: r.get(12)?,
        cwd: r.get(13)?,
        exit: r.get(14)?,
        error: r.get(15)?,
        activity: Vec::new(),
    };
    Ok((s, r.get(16)?))
}

fn read_session(db: &Connection, id: &str) -> Result<Option<(Session, bool)>> {
    let sql = concat!(session_select!(), " WHERE id = ?1");
    one(db, sql, id, session_row)
}

macro_rules! terminal_select {
    () => {
        "SELECT id, rev, project_id, kind, title, cwd, argv, cols, \"rows\", state, exit, \"offset\", 1 \
         FROM terminals"
    };
}
use terminal_select;

fn terminal_row(r: &Row) -> rusqlite::Result<(Terminal, bool)> {
    let t = Terminal {
        id: word(r, 0)?,
        rev: word(r, 1)?,
        project_id: word(r, 2)?,
        kind: word(r, 3)?,
        title: r.get(4)?,
        cwd: r.get(5)?,
        argv: json(r, 6)?,
        cols: r.get(7)?,
        rows: r.get(8)?,
        state: word(r, 9)?,
        exit: r.get(10)?,
        offset: word(r, 11)?,
    };
    Ok((t, r.get(12)?))
}

fn read_terminal(db: &Connection, id: &str) -> Result<Option<(Terminal, bool)>> {
    let sql = concat!(terminal_select!(), " WHERE id = ?1");
    one(db, sql, id, terminal_row)
}

macro_rules! question_select {
    () => {
        "SELECT q.id, q.rev, q.thought_id, q.session_id, q.turn, q.source, q.kind, q.prompt, q.detail, \
         q.reply_via, q.state, a.response, a.device_id, a.created, a.delivered, q.live \
         FROM questions q LEFT JOIN answers a ON a.question_id = q.id"
    };
}
use question_select;

fn question_row(r: &Row) -> rusqlite::Result<(Question, bool)> {
    let answer = match r.get_ref(11)? {
        ValueRef::Null => None,
        _ => Some(Answer {
            response: json(r, 11)?,
            device_id: word(r, 12)?,
            created: word(r, 13)?,
            delivered: word(r, 14)?,
        }),
    };
    let q = Question {
        id: word(r, 0)?,
        rev: word(r, 1)?,
        thought_id: word(r, 2)?,
        session_id: word(r, 3)?,
        turn: r.get(4)?,
        source: word(r, 5)?,
        kind: json(r, 6)?,
        prompt: r.get(7)?,
        detail: r.get(8)?,
        reply_via: word(r, 9)?,
        state: word(r, 10)?,
        answer,
    };
    Ok((q, r.get(15)?))
}

fn read_question(db: &Connection, id: &str) -> Result<Option<(Question, bool)>> {
    let sql = concat!(question_select!(), " WHERE q.id = ?1");
    one(db, sql, id, question_row)
}

macro_rules! result_select {
    () => {
        "SELECT id, rev, thought_id, session_id, turn, kind, summary, live FROM results"
    };
}
use result_select;

fn result_row(r: &Row) -> rusqlite::Result<(TurnResult, bool)> {
    let t = TurnResult {
        id: word(r, 0)?,
        rev: word(r, 1)?,
        thought_id: word(r, 2)?,
        session_id: word(r, 3)?,
        turn: r.get(4)?,
        kind: word(r, 5)?,
        summary: r.get(6)?,
    };
    Ok((t, r.get(7)?))
}

fn read_result(db: &Connection, id: &str) -> Result<Option<(TurnResult, bool)>> {
    let sql = concat!(result_select!(), " WHERE id = ?1");
    one(db, sql, id, result_row)
}

macro_rules! layout_select {
    () => {
        "SELECT project_id, rev, tree, 1 FROM layouts"
    };
}
use layout_select;

fn layout_row(r: &Row) -> rusqlite::Result<(Layout, bool)> {
    let l = Layout {
        id: word(r, 0)?,
        rev: word(r, 1)?,
        tree: json(r, 2)?,
    };
    Ok((l, r.get(3)?))
}

fn read_layout(db: &Connection, id: &str) -> Result<Option<(Layout, bool)>> {
    let sql = concat!(layout_select!(), " WHERE project_id = ?1");
    one(db, sql, id, layout_row)
}

macro_rules! pref_select {
    () => {
        "SELECT key, rev, value, 1 FROM prefs"
    };
}
use pref_select;

fn pref_row(r: &Row) -> rusqlite::Result<(Pref, bool)> {
    let p = Pref {
        value: json(r, 2)?,
        rev: word(r, 1)?,
    };
    Ok((p, r.get(3)?))
}

fn read_pref(db: &Connection, id: &str) -> Result<Option<(Pref, bool)>> {
    let sql = concat!(pref_select!(), " WHERE key = ?1");
    one(db, sql, id, pref_row)
}

macro_rules! device_select {
    () => {
        // The key hash comes last, after the columns of the record; only `device` reads it.
        "SELECT id, rev, name, last_seen, revoked, 1, key_hash FROM devices"
    };
}
use device_select;

fn device_row(r: &Row) -> rusqlite::Result<(Device, bool)> {
    let d = Device {
        id: word(r, 0)?,
        rev: word(r, 1)?,
        name: r.get(2)?,
        last_seen: word(r, 3)?,
        revoked: r.get(4)?,
    };
    Ok((d, r.get(5)?))
}

fn read_device(db: &Connection, id: &str) -> Result<Option<(Device, bool)>> {
    let sql = concat!(device_select!(), " WHERE id = ?1");
    one(db, sql, id, device_row)
}

// Values. Ids and words are stored as their wire text, so the database reads
// like the protocol; lists and nested values as JSON text.

/// Binds a value by its serde form: text, an integer, or NULL for `None`.
struct W<'a, T>(&'a T);

impl<T: Serialize> ToSql for W<'_, T> {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        let fail = |why: String| rusqlite::Error::ToSqlConversionFailure(why.into());
        Ok(
            match serde_json::to_value(self.0).map_err(|e| fail(e.to_string()))? {
                Value::Null => ToSqlOutput::from(Null),
                Value::Bool(b) => ToSqlOutput::from(b),
                Value::Number(n) => {
                    ToSqlOutput::from(n.as_i64().ok_or_else(|| fail(n.to_string()))?)
                }
                Value::String(s) => ToSqlOutput::from(s),
                other => return Err(fail(format!("{other} is not a scalar"))),
            },
        )
    }
}

/// Binds a value as JSON text.
struct J<'a, T>(&'a T);

impl<T: Serialize> ToSql for J<'_, T> {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        let text = serde_json::to_string(self.0)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
        Ok(ToSqlOutput::from(text))
    }
}

/// Reads a column bound with [`W`].
fn word<T: DeserializeOwned>(r: &Row, i: usize) -> rusqlite::Result<T> {
    let value = match r.get_ref(i)? {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => Value::from(n),
        ValueRef::Text(t) => Value::String(
            std::str::from_utf8(t)
                .map_err(|e| rusqlite::Error::FromSqlConversionFailure(i, Type::Text, e.into()))?
                .to_owned(),
        ),
        other => {
            return Err(rusqlite::Error::InvalidColumnType(
                i,
                String::new(),
                other.data_type(),
            ));
        }
    };
    serde_json::from_value(value)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(i, Type::Text, e.into()))
}

/// Reads a column bound with [`J`].
fn json<T: DeserializeOwned>(r: &Row, i: usize) -> rusqlite::Result<T> {
    let text: String = r.get(i)?;
    serde_json::from_str(&text)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(i, Type::Text, e.into()))
}

/// The wire text of an id or a word.
fn key(v: &impl Serialize) -> Result<String> {
    match serde_json::to_value(v)? {
        Value::String(s) => Ok(s),
        other => Err(Error::Corrupt(format!("{other} is not a key"))),
    }
}

fn parse<T: DeserializeOwned>(text: &str) -> Result<T> {
    Ok(serde_json::from_value(Value::String(text.to_owned()))?)
}

/// Schema version 1 (design §5): every table without a later-phase mark.
/// `live` is the store's: whether clients see the row. `finished` is derived
/// from a thought on every write so the live rule can use an index.
const SCHEMA_V1: &str = r#"
CREATE TABLE meta (
    one INTEGER PRIMARY KEY CHECK (one = 1),
    core_id TEXT NOT NULL,
    boot INTEGER NOT NULL,
    rev INTEGER NOT NULL
) STRICT;

CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    rev INTEGER NOT NULL,
    name TEXT NOT NULL,
    folder TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    color TEXT NOT NULL,
    aliases TEXT NOT NULL,
    git INTEGER NOT NULL,
    isolate TEXT NOT NULL,
    open INTEGER NOT NULL,
    available INTEGER NOT NULL
) STRICT;

CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    rev INTEGER NOT NULL,
    name TEXT NOT NULL,
    key_hash BLOB NOT NULL,
    last_seen INTEGER,
    revoked INTEGER NOT NULL
) STRICT;

CREATE TABLE terminals (
    id TEXT PRIMARY KEY,
    rev INTEGER NOT NULL,
    project_id TEXT REFERENCES projects (id),
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    cwd TEXT NOT NULL,
    argv TEXT NOT NULL,
    cols INTEGER NOT NULL,
    "rows" INTEGER NOT NULL,
    state TEXT NOT NULL,
    exit INTEGER,
    "offset" INTEGER NOT NULL,
    boot INTEGER NOT NULL,
    token_hash BLOB UNIQUE
) STRICT;

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    rev INTEGER NOT NULL,
    live INTEGER NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects (id),
    agent TEXT NOT NULL,
    terminal_id TEXT REFERENCES terminals (id),
    adopted INTEGER NOT NULL,
    state TEXT NOT NULL,
    thought_id TEXT REFERENCES thoughts (id),
    turn INTEGER NOT NULL,
    resume TEXT,
    name TEXT,
    named_at INTEGER,
    model TEXT,
    cwd TEXT NOT NULL,
    exit INTEGER,
    error TEXT
) STRICT;
CREATE INDEX sessions_thought ON sessions (thought_id);
CREATE INDEX sessions_terminal ON sessions (terminal_id);

CREATE TABLE thoughts (
    id TEXT PRIMARY KEY,
    rev INTEGER NOT NULL,
    live INTEGER NOT NULL,
    finished INTEGER NOT NULL,
    text TEXT NOT NULL,
    strokes TEXT NOT NULL,
    source TEXT NOT NULL,
    mode TEXT NOT NULL,
    phase TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    project_id TEXT REFERENCES projects (id),
    session_id TEXT REFERENCES sessions (id),
    brief TEXT,
    agent TEXT,
    model TEXT,
    workdir TEXT NOT NULL,
    hold_until INTEGER,
    read INTEGER NOT NULL,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
) STRICT;
CREATE INDEX thoughts_finished ON thoughts (finished, id);
CREATE INDEX thoughts_live ON thoughts (live, finished, id);
CREATE INDEX thoughts_session ON thoughts (session_id);

CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    rev INTEGER NOT NULL,
    live INTEGER NOT NULL,
    thought_id TEXT REFERENCES thoughts (id),
    session_id TEXT REFERENCES sessions (id),
    turn INTEGER,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    prompt TEXT NOT NULL,
    detail TEXT,
    reply_via TEXT NOT NULL,
    request_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL
) STRICT;
CREATE INDEX questions_thought ON questions (thought_id);
CREATE INDEX questions_open ON questions (id) WHERE state = 'open';

CREATE TABLE answers (
    question_id TEXT PRIMARY KEY REFERENCES questions (id) ON DELETE CASCADE,
    response TEXT NOT NULL,
    device_id TEXT REFERENCES devices (id),
    created INTEGER NOT NULL,
    delivered INTEGER
) STRICT;

CREATE TABLE results (
    id TEXT PRIMARY KEY,
    rev INTEGER NOT NULL,
    live INTEGER NOT NULL,
    thought_id TEXT NOT NULL REFERENCES thoughts (id),
    session_id TEXT REFERENCES sessions (id),
    turn INTEGER,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    body TEXT NOT NULL
) STRICT;
CREATE INDEX results_thought ON results (thought_id);

CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    args_hash BLOB NOT NULL,
    started INTEGER NOT NULL,
    outcome TEXT
) STRICT;

CREATE TABLE layouts (
    project_id TEXT PRIMARY KEY REFERENCES projects (id),
    rev INTEGER NOT NULL,
    tree TEXT NOT NULL
) STRICT;

CREATE TABLE prefs (
    key TEXT PRIMARY KEY,
    rev INTEGER NOT NULL,
    value TEXT NOT NULL
) STRICT;
"#;
