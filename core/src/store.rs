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
//!
//! A record is stored as its serde document in a `data` column, beside the
//! columns the store keeps itself (`id`, `rev`, `live`) and the values only
//! the core reads (token and key hashes, request keys, result bodies). The
//! keys a query, a unique index or a foreign key needs are columns SQLite
//! reads from the document. So a field added to a record needs no migration,
//! and a document a newer build wrote reads here with the fields it does not
//! know ignored.

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::types::{FromSql, Type};
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Params, Row, ToSql, TransactionBehavior, ffi, params,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tasktap_proto::{
    Answer, AttemptId, Change, Collection, CoreId, Device, DeviceId, HistoryPage, Layout, Limit,
    Outcome, Phase, Pref, PrefKey, PrefValue, Project, ProjectId, Question, QuestionId,
    QuestionState, Reason, ResultId, Rev, Rows, Session, SessionId, SessionState, Set, Status,
    Terminal, TerminalId, TerminalState, Thought, ThoughtId, Time, TurnResult,
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
            [key(&store.core)?],
        )?;
        let (core, boot, rev): (String, i64, i64) = tx.query_row(
            "UPDATE meta SET boot = boot + 1 RETURNING core_id, boot, rev",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        (store.core, store.boot, store.rev) = (parse(&core)?, boot as u64, rev as u64);
        let mut tx = Tx::new(tx, &mut store.rev, store.boot)?;
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

impl Table {
    fn name(self) -> &'static str {
        match self {
            Table::Thoughts => "thoughts",
            Table::Projects => "projects",
            Table::Sessions => "sessions",
            Table::Terminals => "terminals",
            Table::Questions => "questions",
            Table::Results => "results",
            Table::Layouts => "layouts",
            Table::Prefs => "prefs",
            Table::Devices => "devices",
        }
    }
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
            ($($table:ident),*) => {
                $(self.emit(&seen, Table::$table, Set::$table, &mut sets)?;)*
            };
        }
        emit!(
            Thoughts, Projects, Sessions, Terminals, Questions, Results, Layouts, Prefs, Devices
        );
        self.db
            .execute("UPDATE meta SET rev = ?1", [self.rev as i64])?;
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
        let rev = self.rev as i64;
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
            params![rev, cutoff],
        )? {
            flipped.push((id, false));
        }
        for id in self.ids(
            "UPDATE thoughts SET live = 1, rev = ?1 WHERE live = 0 AND finished = 0 RETURNING id",
            [rev],
        )? {
            flipped.push((id, true));
        }
        for id in self.ids(
            "UPDATE thoughts SET live = 1, rev = ?1 \
             WHERE live = 0 AND finished = 1 AND id >= ?2 RETURNING id",
            params![rev, cutoff],
        )? {
            flipped.push((id, true));
        }
        Ok(flipped)
    }

    fn children(&self, table: Table, thought: &str) -> Result<Vec<(String, bool)>> {
        let sql = format!(
            "SELECT id, live FROM {} WHERE thought_id = ?1",
            table.name()
        );
        let mut stmt = self.db.prepare_cached(&sql)?;
        let rows = stmt.query_map([thought], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn emit<R: DeserializeOwned, I: DeserializeOwned>(
        &self,
        seen: &Seen,
        table: Table,
        wrap: fn(Rows<R, I>) -> Set,
        sets: &mut Vec<Set>,
    ) -> Result<()> {
        let mut rows = Rows {
            put: Vec::new(),
            del: Vec::new(),
        };
        for ((_, id), &(before, wrote)) in seen.iter().filter(|((t, _), _)| *t == table) {
            match self.select(table, "WHERE id = ?1", [id])?.pop() {
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
    fn write(&mut self, table: Table, id: &str, sql: &str, params: impl Params) -> Result<bool> {
        let before: Option<bool> = self
            .db
            .prepare_cached(sql)?
            .query_row(params, |r| r.get(0))
            .optional()?;
        if let Some(before) = before {
            self.wrote.entry((table, id.to_owned())).or_insert(before);
        }
        Ok(before.is_some())
    }

    /// Writes a record with a statement that binds its id, the revision and
    /// its [`document`] as ?1 to ?3 and `extra` after them; see [`Tx::write`].
    fn put(
        &mut self,
        table: Table,
        record: &impl Serialize,
        sql: &str,
        extra: &[&dyn ToSql],
    ) -> Result<bool> {
        let (id, data) = document(record)?;
        let rev = self.rev as i64;
        let base: [&dyn ToSql; 3] = [&id, &rev, &data];
        let params: Vec<_> = base.into_iter().chain(extra.iter().copied()).collect();
        self.write(table, &id, sql, params.as_slice())
    }

    fn insert(&mut self, table: Table, record: &impl Serialize) -> Result<()> {
        let sql = format!(
            "INSERT INTO {} (id, rev, data) VALUES (?1, ?2, ?3) RETURNING 0",
            table.name()
        );
        self.put(table, record, &sql, &[]).map(drop)
    }

    /// False when there is no such row.
    fn update(&mut self, table: Table, record: &impl Serialize) -> Result<bool> {
        let sql = format!(
            "UPDATE {} SET rev = ?2, data = ?3 WHERE id = ?1 RETURNING live",
            table.name()
        );
        self.put(table, record, &sql, &[])
    }

    /// Writes a row that is always live, inserting or replacing it.
    fn upsert(&mut self, table: Table, record: &impl Serialize) -> Result<()> {
        if !self.update(table, record)? {
            self.insert(table, record)?;
        }
        Ok(())
    }

    fn delete(&mut self, table: Table, id: &impl Serialize) -> Result<bool> {
        let sql = format!("DELETE FROM {} WHERE id = ?1 RETURNING live", table.name());
        let id = key(id)?;
        self.write(table, &id, &sql, [&id])
    }

    /// The recovery pass (design §3): nothing of an earlier boot still runs,
    /// so it closes what was left open and never opens or starts anything.
    fn recover(&mut self, now: Time) -> Result<()> {
        let running = "WHERE state = 'running' AND boot < ?1";
        for t in self.all::<Terminal>(Table::Terminals, running, [self.boot as i64])? {
            self.update_terminal(&Terminal {
                state: TerminalState::Lost,
                ..t
            })?;
        }
        // A session lives only through a running terminal of this core; that
        // also ends one whose launch was committed but whose terminal never was.
        let orphaned = "WHERE state <> 'ended' AND NOT EXISTS \
             (SELECT 1 FROM terminals t WHERE t.id = sessions.terminal_id AND t.state = 'running')";
        for s in self.all::<Session>(Table::Sessions, orphaned, [])? {
            self.update_session(&Session {
                state: SessionState::Ended,
                ..s
            })?;
        }
        let interrupted: Vec<Thought> = self.all(
            Table::Thoughts,
            "WHERE phase = 'working' AND NOT EXISTS \
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
            if ended || interrupted.iter().any(|t| Some(t.id) == q.thought_id) {
                self.set_question_state(q.id, QuestionState::Withdrawn)?;
            }
        }
        // Every open question of these was just withdrawn, so none needs you.
        for t in interrupted {
            self.update_thought(&Thought {
                phase: Phase::Failed,
                reason: Some(Reason::Interrupted),
                status: Status::Failed,
                updated: now,
                ..t
            })?;
        }
        // Hold timers are not restored: a held thought waits for Start.
        let held = "WHERE data ->> 'hold_until' IS NOT NULL";
        for t in self.all::<Thought>(Table::Thoughts, held, [])? {
            self.update_thought(&Thought {
                hold_until: None,
                ..t
            })?;
        }
        self.db.execute(
            "UPDATE attempts SET outcome = '\"interrupted\"' WHERE outcome IS NULL",
            [],
        )?;
        // Every session of an earlier boot has just ended, so no event of one can count.
        self.db.execute("DELETE FROM seen_events", [])?;
        Ok(())
    }

    // Reads.

    /// The records a clause selects from a table, each with whether a client can see it.
    fn select<R: DeserializeOwned>(
        &self,
        table: Table,
        clause: &'static str,
        params: impl Params,
    ) -> Result<Vec<(R, bool)>> {
        let sql = match table {
            // Clients see the answer inside the question.
            Table::Questions => format!(
                "SELECT q.data, rev, live, a.data \
                 FROM questions q LEFT JOIN answers a ON a.question_id = q.id {clause}"
            ),
            _ => format!(
                "SELECT data, rev, live, NULL FROM {} {clause}",
                table.name()
            ),
        };
        let mut stmt = self.db.prepare_cached(&sql)?;
        let rows = stmt.query_map(params, record)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn all<R: DeserializeOwned>(
        &self,
        table: Table,
        clause: &'static str,
        params: impl Params,
    ) -> Result<Vec<R>> {
        let rows = self.select(table, clause, params)?;
        Ok(rows.into_iter().map(|(row, _)| row).collect())
    }

    fn one<R: DeserializeOwned>(
        &self,
        table: Table,
        clause: &'static str,
        params: impl Params,
    ) -> Result<Option<R>> {
        Ok(self.all(table, clause, params)?.into_iter().next())
    }

    fn get<R: DeserializeOwned>(&self, table: Table, id: &impl Serialize) -> Result<Option<R>> {
        self.one(table, "WHERE id = ?1", [key(id)?])
    }

    /// A value only the core reads, from the row with the id.
    fn value<T: FromSql>(&self, sql: &str, id: &impl Serialize) -> Result<Option<T>> {
        let mut stmt = self.db.prepare_cached(sql)?;
        Ok(stmt.query_row([key(id)?], |r| r.get(0)).optional()?)
    }

    pub fn thought(&self, id: ThoughtId) -> Result<Option<Thought>> {
        self.get(Table::Thoughts, &id)
    }

    /// The session's thoughts that are captured, routed or working, oldest first.
    pub fn thoughts_in_flight(&self, session: SessionId) -> Result<Vec<Thought>> {
        let clause = "WHERE session_id = ?1 AND phase IN ('captured', 'routed', 'working') \
                      ORDER BY id";
        self.all(Table::Thoughts, clause, [key(&session)?])
    }

    pub fn project(&self, id: ProjectId) -> Result<Option<Project>> {
        self.get(Table::Projects, &id)
    }

    /// The project that holds a canonical folder.
    pub fn project_by_folder(&self, folder: &str) -> Result<Option<Project>> {
        self.one(Table::Projects, "WHERE folder = ?1", [folder])
    }

    pub fn session(&self, id: SessionId) -> Result<Option<Session>> {
        self.get(Table::Sessions, &id)
    }

    /// The newest session in a terminal that has not ended.
    pub fn terminal_session(&self, terminal: TerminalId) -> Result<Option<Session>> {
        let clause = "WHERE terminal_id = ?1 AND state <> 'ended' ORDER BY id DESC LIMIT 1";
        self.one(Table::Sessions, clause, [key(&terminal)?])
    }

    pub fn terminal(&self, id: TerminalId) -> Result<Option<Terminal>> {
        self.get(Table::Terminals, &id)
    }

    /// The terminal a session token was minted for.
    pub fn terminal_by_token(&self, token_hash: &Hash) -> Result<Option<Terminal>> {
        self.one(Table::Terminals, "WHERE token_hash = ?1", [token_hash])
    }

    pub fn question(&self, id: QuestionId) -> Result<Option<Question>> {
        self.get(Table::Questions, &id)
    }

    pub fn question_by_request(&self, request_key: &str) -> Result<Option<Question>> {
        self.one(Table::Questions, "WHERE request_key = ?1", [request_key])
    }

    /// The key a question was asked under, which only the core reads.
    pub fn request_key(&self, question: QuestionId) -> Result<Option<String>> {
        self.value("SELECT request_key FROM questions WHERE id = ?1", &question)
    }

    /// Every open question, oldest first.
    pub fn open_questions(&self) -> Result<Vec<Question>> {
        self.all(Table::Questions, "WHERE state = 'open' ORDER BY id", [])
    }

    /// Whether a thought has an open question, read without loading one.
    pub fn asking(&self, thought: ThoughtId) -> Result<bool> {
        let sql =
            "SELECT EXISTS (SELECT 1 FROM questions WHERE thought_id = ?1 AND state = 'open')";
        Ok(self.value(sql, &thought)?.unwrap_or(false))
    }

    /// How many questions a session has open, and all sessions together.
    pub fn open_asked(&self, session: SessionId) -> Result<(usize, usize)> {
        let sql = "SELECT count(*) FILTER (WHERE session_id = ?1), count(*) FROM questions \
                   WHERE state = 'open' AND session_id IS NOT NULL";
        let mut stmt = self.db.prepare_cached(sql)?;
        let (mine, all): (i64, i64) =
            stmt.query_row([key(&session)?], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok((mine as usize, all as usize))
    }

    /// A result's body, which is not part of the record.
    pub fn result_body(&self, id: ResultId) -> Result<Option<String>> {
        self.value("SELECT body FROM results WHERE id = ?1", &id)
    }

    pub fn layout(&self, project: ProjectId) -> Result<Option<Layout>> {
        self.get(Table::Layouts, &project)
    }

    pub fn pref(&self, key: PrefKey) -> Result<Option<Pref>> {
        self.get(Table::Prefs, &key)
    }

    /// A device with the hash of its key.
    pub fn device(&self, id: DeviceId) -> Result<Option<(Device, Hash)>> {
        let key_hash = self.value("SELECT key_hash FROM devices WHERE id = ?1", &id)?;
        Ok(self.get(Table::Devices, &id)?.zip(key_hash))
    }

    pub fn attempt(&self, id: AttemptId) -> Result<Option<Attempt>> {
        let sql = "SELECT kind, target, args_hash, started, outcome FROM attempts WHERE id = ?1";
        let row = self
            .db
            .prepare_cached(sql)?
            .query_row([key(&id)?], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get(2)?,
                    r.get::<_, i64>(3)?,
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
            started: Time::new(started as u64)
                .ok_or_else(|| Error::Corrupt(format!("attempt start {started}")))?,
            outcome,
        }))
    }

    /// Every live row of a stored collection, oldest first; `None` for one kept in memory.
    pub fn live(&self, c: Collection) -> Result<Option<Set>> {
        macro_rules! live {
            ($($table:ident),*) => {
                match c {
                    $(Collection::$table => Set::$table(Rows {
                        put: self.all(Table::$table, "WHERE live = 1 ORDER BY id", [])?,
                        del: Vec::new(),
                    }),)*
                    Collection::Glance => return Ok(None),
                }
            };
        }
        Ok(Some(live!(
            Thoughts, Projects, Sessions, Terminals, Questions, Results, Layouts, Prefs, Devices
        )))
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
        let of_page = concat!(
            "WHERE thought_id IN (SELECT id FROM thoughts ",
            page!(),
            ") ORDER BY id"
        );
        Ok(HistoryPage {
            thoughts: self.all(Table::Thoughts, page!(), params)?,
            questions: self.all(Table::Questions, of_page, params)?,
            results: self.all(Table::Results, of_page, params)?,
        })
    }

    // Writes. An update or delete of a row that is not there is `NotFound`;
    // a failed write changes nothing, but the caller should drop the transaction.

    pub fn insert_thought(&mut self, t: &Thought) -> Result<()> {
        self.insert(Table::Thoughts, t)
    }

    pub fn update_thought(&mut self, t: &Thought) -> Result<()> {
        found(self.update(Table::Thoughts, t)?)
    }

    /// Removes a thought with its questions, their answers, and its results.
    /// A session whose current thought it is makes this `Reference`.
    pub fn delete_thought(&mut self, id: ThoughtId) -> Result<bool> {
        let key = key(&id)?;
        let named: bool = self
            .db
            .prepare_cached("SELECT EXISTS (SELECT 1 FROM sessions WHERE thought_id = ?1)")?
            .query_row([&key], |r| r.get(0))?;
        if named {
            return Err(Error::Reference);
        }
        for table in [Table::Questions, Table::Results] {
            let sql = format!(
                "DELETE FROM {} WHERE thought_id = ?1 RETURNING id, live",
                table.name()
            );
            let mut stmt = self.db.prepare_cached(&sql)?;
            let gone = stmt
                .query_map([&key], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            for (child, before) in gone {
                self.wrote.entry((table, child)).or_insert(before);
            }
        }
        self.delete(Table::Thoughts, &id)
    }

    pub fn insert_project(&mut self, p: &Project) -> Result<()> {
        self.insert(Table::Projects, p)
    }

    pub fn update_project(&mut self, p: &Project) -> Result<()> {
        found(self.update(Table::Projects, p)?)
    }

    pub fn insert_session(&mut self, s: &Session) -> Result<()> {
        self.insert(Table::Sessions, s)
    }

    pub fn update_session(&mut self, s: &Session) -> Result<()> {
        found(self.update(Table::Sessions, s)?)
    }

    /// Records a terminal of this boot, with the hash of its session token if it has one.
    pub fn insert_terminal(&mut self, t: &Terminal, token_hash: Option<&Hash>) -> Result<()> {
        let sql = "INSERT INTO terminals (id, rev, data, boot, token_hash) \
                   VALUES (?1, ?2, ?3, ?4, ?5) RETURNING 0";
        let boot = self.boot as i64;
        self.put(Table::Terminals, t, sql, &[&boot, &token_hash])
            .map(drop)
    }

    /// Updates a terminal and marks it as written by this boot; its token stays.
    pub fn update_terminal(&mut self, t: &Terminal) -> Result<()> {
        let sql =
            "UPDATE terminals SET rev = ?2, data = ?3, boot = ?4 WHERE id = ?1 RETURNING live";
        let boot = self.boot as i64;
        found(self.put(Table::Terminals, t, sql, &[&boot])?)
    }

    /// Inserts a question under the asker's key, which no other question may hold.
    pub fn insert_question(&mut self, q: &Question, request_key: &str) -> Result<()> {
        let sql = "INSERT INTO questions (id, rev, data, request_key) \
                   VALUES (?1, ?2, ?3, ?4) RETURNING 0";
        self.put(Table::Questions, q, sql, &[&request_key])
            .map(drop)
    }

    /// A question's state is the only part of it that changes.
    pub fn set_question_state(&mut self, id: QuestionId, state: QuestionState) -> Result<()> {
        let (rev, id) = (self.rev as i64, key(&id)?);
        found(self.write(
            Table::Questions,
            &id,
            "UPDATE questions SET rev = ?1, data = json_set(data, '$.state', ?2) \
             WHERE id = ?3 RETURNING live",
            params![rev, key(&state)?, id],
        )?)
    }

    /// Stores the answer to a question. A second answer to it is `Duplicate`.
    pub fn insert_answer(&mut self, question: QuestionId, a: &Answer) -> Result<()> {
        self.db
            .prepare_cached("INSERT INTO answers (question_id, data) VALUES (?1, ?2)")?
            .execute([key(&question)?, serde_json::to_string(a)?])?;
        self.touch_question(question)
    }

    /// Records when the waiter confirmed it received the answer.
    pub fn set_delivered(&mut self, question: QuestionId, at: Time) -> Result<()> {
        let n = self
            .db
            .prepare_cached(
                "UPDATE answers SET data = json_set(data, '$.delivered', ?1) WHERE question_id = ?2",
            )?
            .execute(params![at.get() as i64, key(&question)?])?;
        if n == 0 {
            return Err(Error::NotFound);
        }
        self.touch_question(question)
    }

    /// Stamps a question whose answer changed, since clients see the answer inside it.
    fn touch_question(&mut self, id: QuestionId) -> Result<()> {
        let (rev, id) = (self.rev as i64, key(&id)?);
        found(self.write(
            Table::Questions,
            &id,
            "UPDATE questions SET rev = ?1 WHERE id = ?2 RETURNING live",
            params![rev, id],
        )?)
    }

    /// Stores a result; results never change.
    pub fn insert_result(&mut self, r: &TurnResult, body: &str) -> Result<()> {
        let sql = "INSERT INTO results (id, rev, data, body) VALUES (?1, ?2, ?3, ?4) RETURNING 0";
        self.put(Table::Results, r, sql, &[&body]).map(drop)
    }

    pub fn put_layout(&mut self, l: &Layout) -> Result<()> {
        self.upsert(Table::Layouts, l)
    }

    pub fn delete_layout(&mut self, project: ProjectId) -> Result<bool> {
        self.delete(Table::Layouts, &project)
    }

    pub fn put_pref(&mut self, value: &PrefValue) -> Result<()> {
        self.upsert(Table::Prefs, value)
    }

    pub fn delete_pref(&mut self, pref: PrefKey) -> Result<bool> {
        self.delete(Table::Prefs, &pref)
    }

    /// Registers a device with the hash of its key.
    pub fn insert_device(&mut self, d: &Device, key_hash: &Hash) -> Result<()> {
        let sql =
            "INSERT INTO devices (id, rev, data, key_hash) VALUES (?1, ?2, ?3, ?4) RETURNING 0";
        self.put(Table::Devices, d, sql, &[key_hash]).map(drop)
    }

    /// Updates a device; its key stays.
    pub fn update_device(&mut self, d: &Device) -> Result<()> {
        found(self.update(Table::Devices, d)?)
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
            .execute(params![
                key(&a.id)?,
                kind,
                target,
                a.args_hash,
                a.started.get() as i64
            ])?;
        if let Some(outcome) = &a.outcome {
            self.set_outcome(a.id, outcome)?;
        }
        Ok(())
    }

    /// Remembers that a session's event was applied; false when it already was.
    /// Not a record, so it takes no revision.
    pub fn see_event(&mut self, session: SessionId, event: &str) -> Result<bool> {
        let n = self
            .db
            .prepare_cached(
                "INSERT INTO seen_events (session_id, event) VALUES (?1, ?2) ON CONFLICT DO NOTHING",
            )?
            .execute(params![key(&session)?, event])?;
        Ok(n == 1)
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
            .execute(params![text, key(&id)?])?;
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

// Documents. Ids and words are their wire text, so the database reads like
// the protocol.

/// A record's id, and its serde document without the fields the store keeps
/// as columns (`rev`, a thought's `live`) or beside it (a question's
/// `answer`), and with a session's memory-only `activity` empty.
fn document(record: &impl Serialize) -> Result<(String, String)> {
    let Value::Object(mut doc) = serde_json::to_value(record)? else {
        return Err(Error::Corrupt("a record that is not an object".into()));
    };
    for field in ["rev", "live", "answer"] {
        doc.remove(field);
    }
    if let Some(activity) = doc.get_mut("activity") {
        *activity = Value::Array(Vec::new());
    }
    let Some(Value::String(id)) = doc.get("id") else {
        return Err(Error::Corrupt("a record without an id".into()));
    };
    Ok((id.clone(), serde_json::to_string(&doc)?))
}

/// Reads a row selected as `data, rev, live, answer` into its record and
/// whether a client can see it. The fields [`document`] took out are written
/// in front of the document's own, so serde reads the record in one pass; it
/// ignores `live` on a record without one, as it does fields a newer build
/// added.
fn record<R: DeserializeOwned>(r: &Row) -> rusqlite::Result<(R, bool)> {
    let (rev, live): (i64, bool) = (r.get(1)?, r.get(2)?);
    let answer = match r.get_ref(3)?.as_str_or_null()? {
        Some(answer) => format!(r#""answer":{answer},"#),
        None => String::new(),
    };
    // A document is an object with at least an id; anything else fails to parse.
    let fields = r.get_ref(0)?.as_str()?.strip_prefix('{');
    let text = format!(
        r#"{{"rev":{rev},"live":{live},{answer}{}"#,
        fields.unwrap_or_default()
    );
    let record = serde_json::from_str(&text)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, Type::Text, e.into()))?;
    Ok((record, live))
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
///
/// A record table holds the record's document in `data` and the store's
/// `live`: whether clients see the row, always for some tables, otherwise set
/// by each commit (a new row is not live until then). The columns after
/// `data` are read from it: the keys the core queries, constrains or
/// references. `finished` is the live rule's test of a thought, kept in an
/// index so the rule needs no scan.
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
    live INTEGER NOT NULL AS (1),
    data TEXT NOT NULL,
    folder TEXT NOT NULL UNIQUE AS (data ->> 'folder')
) STRICT;

CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    rev INTEGER NOT NULL,
    live INTEGER NOT NULL AS (1),
    data TEXT NOT NULL,
    key_hash BLOB NOT NULL
) STRICT;

CREATE TABLE terminals (
    id TEXT PRIMARY KEY,
    rev INTEGER NOT NULL,
    live INTEGER NOT NULL AS (1),
    data TEXT NOT NULL,
    boot INTEGER NOT NULL,
    token_hash BLOB UNIQUE,
    project_id TEXT AS (data ->> 'project_id') REFERENCES projects (id),
    state TEXT NOT NULL AS (data ->> 'state')
) STRICT;

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    rev INTEGER NOT NULL,
    live INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    project_id TEXT NOT NULL AS (data ->> 'project_id') REFERENCES projects (id),
    terminal_id TEXT AS (data ->> 'terminal_id') REFERENCES terminals (id),
    thought_id TEXT AS (data ->> 'thought_id') REFERENCES thoughts (id),
    state TEXT NOT NULL AS (data ->> 'state')
) STRICT;
CREATE INDEX sessions_thought ON sessions (thought_id);
CREATE INDEX sessions_terminal ON sessions (terminal_id);

-- The ids of session events already applied (design §5: event ids are
-- deduplicated). Cleared at start, when every session of the boot before has ended.
CREATE TABLE seen_events (
    session_id TEXT NOT NULL REFERENCES sessions (id),
    event TEXT NOT NULL,
    PRIMARY KEY (session_id, event)
) STRICT, WITHOUT ROWID;

CREATE TABLE thoughts (
    id TEXT PRIMARY KEY,
    rev INTEGER NOT NULL,
    live INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    project_id TEXT AS (data ->> 'project_id') REFERENCES projects (id),
    session_id TEXT AS (data ->> 'session_id') REFERENCES sessions (id),
    phase TEXT NOT NULL AS (data ->> 'phase'),
    finished INTEGER NOT NULL AS (phase IN ('done', 'failed') AND data ->> 'read'
        AND coalesce(data ->> '$.workdir.changes', '') <> 'pending')
) STRICT;
CREATE INDEX thoughts_finished ON thoughts (finished, id);
CREATE INDEX thoughts_live ON thoughts (live, finished, id);
CREATE INDEX thoughts_session ON thoughts (session_id);

CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    rev INTEGER NOT NULL,
    live INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    request_key TEXT NOT NULL UNIQUE,
    thought_id TEXT AS (data ->> 'thought_id') REFERENCES thoughts (id),
    session_id TEXT AS (data ->> 'session_id') REFERENCES sessions (id),
    state TEXT NOT NULL AS (data ->> 'state')
) STRICT;
CREATE INDEX questions_thought ON questions (thought_id);
CREATE INDEX questions_open ON questions (id) WHERE state = 'open';

-- Written once, apart from `delivered`; clients see it inside the question.
CREATE TABLE answers (
    question_id TEXT PRIMARY KEY REFERENCES questions (id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    device_id TEXT AS (data ->> 'device_id') REFERENCES devices (id)
) STRICT;

CREATE TABLE results (
    id TEXT PRIMARY KEY,
    rev INTEGER NOT NULL,
    live INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    body TEXT NOT NULL,
    thought_id TEXT NOT NULL AS (data ->> 'thought_id') REFERENCES thoughts (id),
    session_id TEXT AS (data ->> 'session_id') REFERENCES sessions (id)
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
    id TEXT PRIMARY KEY REFERENCES projects (id),
    rev INTEGER NOT NULL,
    live INTEGER NOT NULL AS (1),
    data TEXT NOT NULL
) STRICT;

CREATE TABLE prefs (
    id TEXT PRIMARY KEY,
    rev INTEGER NOT NULL,
    live INTEGER NOT NULL AS (1),
    data TEXT NOT NULL
) STRICT;
"#;
