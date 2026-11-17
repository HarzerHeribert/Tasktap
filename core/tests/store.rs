//! The store's promises (design §3, §5), proven through its public API on
//! temporary folders.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::json;
use tasktap_core::store::{
    Attempt, AttemptKind, AttemptOutcome, Error, LIVE_FINISHED, MIGRATIONS, Store, Tx,
};
use tasktap_proto::{
    Answer, AttemptId, Change, Collection, Device, DeviceId, Isolate, Layout, Limit, Mode, Outcome,
    Phase, PrefKey, PrefValue, Project, ProjectId, ProjectKind, Question, QuestionId, QuestionKind,
    QuestionSource, QuestionState, Reason, ReplyVia, Response, ResultId, ResultKind, Rev, Rows,
    Session, SessionId, SessionState, Set, Source, Status, Terminal, TerminalId, TerminalKind,
    TerminalState, Thought, ThoughtId, Time, TurnResult,
};

/// A fresh folder under the system's temporary folder, removed afterwards.
struct Dir(PathBuf);

impl Dir {
    fn new(name: &str) -> Dir {
        let path =
            std::env::temp_dir().join(format!("tasktap-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Dir(path)
    }

    fn db(&self) -> PathBuf {
        self.0.join("core.db")
    }

    fn listing(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(&self.0)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The time each open gives the store for what its recovery pass stamps.
const OPENED: u64 = 1_000_000;

fn open(path: &Path) -> (Store, Option<Change>) {
    Store::open(path, at(OPENED)).unwrap()
}

fn rev(n: u64) -> Rev {
    Rev::new(n).unwrap()
}

fn at(ms: u64) -> Time {
    Time::new(ms).unwrap()
}

fn project(folder: &str) -> Project {
    Project {
        id: ProjectId::mint(),
        rev: Rev::ZERO,
        name: folder.into(),
        folder: folder.into(),
        kind: ProjectKind::Folder,
        color: "teal".into(),
        aliases: vec!["work".into()],
        git: true,
        isolate: Isolate::Busy,
        open: true,
        available: true,
    }
}

fn thought(project: Option<ProjectId>, phase: Phase) -> Thought {
    Thought {
        id: ThoughtId::mint(),
        rev: Rev::ZERO,
        text: "fix the build".into(),
        strokes: vec![vec![[1.0, 2.5], [3.0, 4.0]]],
        source: Source::Typed,
        mode: Mode::Ask,
        phase,
        status: phase.into(),
        reason: None,
        live: false,
        project_id: project,
        session_id: None,
        brief: Some("brief".into()),
        agent: Some("claude".into()),
        model: None,
        workdir: None,
        hold_until: None,
        read: false,
        created: at(1),
        updated: at(2),
    }
}

/// Done and read: finished, so subject to the live bound.
fn finished(project: ProjectId) -> Thought {
    Thought {
        read: true,
        ..thought(Some(project), Phase::Done)
    }
}

fn terminal(project: Option<ProjectId>, state: TerminalState) -> Terminal {
    Terminal {
        id: TerminalId::mint(),
        rev: Rev::ZERO,
        project_id: project,
        kind: TerminalKind::Agent,
        title: "claude".into(),
        cwd: "/work".into(),
        argv: vec!["claude".into(), "--".into(), "hi".into()],
        cols: 80,
        rows: 24,
        state,
        exit: None,
        offset: tasktap_proto::Offset::ZERO,
    }
}

fn session(
    project: ProjectId,
    terminal: Option<TerminalId>,
    thought: Option<ThoughtId>,
    state: SessionState,
) -> Session {
    Session {
        id: SessionId::mint(),
        rev: Rev::ZERO,
        project_id: project,
        agent: "claude".into(),
        terminal_id: terminal,
        adopted: false,
        state,
        thought_id: thought,
        turn: 1,
        resume: None,
        name: None,
        named_at: None,
        model: None,
        cwd: "/work".into(),
        exit: None,
        error: None,
        activity: Vec::new(),
    }
}

fn question(thought: Option<ThoughtId>, session: Option<SessionId>) -> Question {
    Question {
        id: QuestionId::mint(),
        rev: Rev::ZERO,
        thought_id: thought,
        session_id: session,
        turn: session.map(|_| 1),
        source: QuestionSource::Agent,
        kind: QuestionKind::Choice {
            choices: vec!["yes".into(), "no".into()],
        },
        prompt: "Deploy?".into(),
        detail: None,
        reply_via: ReplyVia::Terminal,
        state: QuestionState::Open,
        answer: None,
    }
}

fn result(thought: ThoughtId) -> TurnResult {
    TurnResult {
        id: ResultId::mint(),
        rev: Rev::ZERO,
        thought_id: thought,
        session_id: None,
        turn: Some(1),
        kind: ResultKind::Answer,
        summary: "done".into(),
    }
}

/// What a client is sent for a row a commit wrote: the row, stamped.
fn sent<T: Clone>(row: &T, stamp: impl FnOnce(&mut T)) -> T {
    let mut row = row.clone();
    stamp(&mut row);
    row
}

fn puts<R, I>(put: Vec<R>) -> Rows<R, I> {
    Rows {
        put,
        del: Vec::new(),
    }
}

fn dels<R, I>(del: Vec<I>) -> Rows<R, I> {
    Rows {
        put: Vec::new(),
        del,
    }
}

fn live_thoughts(store: &mut Store) -> Vec<Thought> {
    match store.begin().unwrap().live(Collection::Thoughts).unwrap() {
        Some(Set::Thoughts(rows)) => rows.put,
        other => panic!("{other:?}"),
    }
}

#[test]
fn an_empty_start_has_only_the_scratch_project_and_a_core_id() {
    let dir = Dir::new("empty");
    let (mut store, recovered) = open(&dir.db());
    assert_eq!(recovered, None);
    assert_eq!(store.rev(), Rev::ZERO);
    assert_eq!(store.boot(), 1);
    let core = store.core_id();
    let tx = store.begin().unwrap();
    // The one built-in scratch project comes with the store, its folder beside the database.
    let projects = tx.live(Collection::Projects).unwrap();
    let Some(Set::Projects(rows)) = &projects else {
        panic!("{projects:?}")
    };
    let [scratch] = rows.put.as_slice() else {
        panic!("{rows:?}")
    };
    let folder = fs::canonicalize(dir.0.join("scratch")).unwrap();
    assert_eq!(
        (scratch.kind, scratch.folder.as_str()),
        (ProjectKind::Scratch, folder.to_str().unwrap())
    );
    for c in [
        Collection::Thoughts,
        Collection::Sessions,
        Collection::Terminals,
        Collection::Questions,
        Collection::Results,
        Collection::Layouts,
        Collection::Prefs,
        Collection::Devices,
    ] {
        let set = tx.live(c).unwrap().unwrap();
        assert!(
            serde_json::to_value(&set).unwrap().get("put").is_none(),
            "{c:?} is not empty"
        );
    }
    assert_eq!(tx.live(Collection::Glance).unwrap(), None);
    let page = tx.history(None, None, Limit::MAX, usize::MAX).unwrap();
    assert!(page.thoughts.is_empty() && page.questions.is_empty() && page.results.is_empty());
    assert!(tx.open_questions().unwrap().is_empty());
    assert_eq!(tx.commit().unwrap(), None, "a read takes no revision");
    drop(store);

    let (mut store, _) = open(&dir.db());
    assert_eq!(store.core_id(), core, "the core id is minted once");
    assert_eq!(store.boot(), 2);
    assert_eq!(store.rev(), Rev::ZERO);
    let again = store.begin().unwrap().live(Collection::Projects).unwrap();
    assert_eq!(again, projects, "the scratch project is seeded once");
}

#[test]
fn reopening_keeps_every_row_and_the_revision() {
    let dir = Dir::new("reopen");
    let (mut store, _) = open(&dir.db());
    let p = project("/work/reopen");
    let mut t = thought(Some(p.id), Phase::Captured);
    t.workdir = Some(tasktap_proto::Workdir {
        path: "/data/worktrees/a".into(),
        branch: "tasktap/a".into(),
        destination: Some("main".into()),
        base: "abc123".into(),
        left_out: true,
        changes: tasktap_proto::Changes::Clean,
        files: 0,
        insertions: 0,
        deletions: 0,
    });
    let device = Device {
        id: DeviceId::mint(),
        rev: Rev::ZERO,
        name: "Mac".into(),
        last_seen: Some(at(5)),
        revoked: false,
    };
    let layout = Layout {
        id: p.id,
        rev: Rev::ZERO,
        tree: json!({"split": "row", "tabs": [1, 2]}),
    };
    let mut tx = store.begin().unwrap();
    tx.insert_project(&p).unwrap();
    tx.insert_thought(&t).unwrap();
    tx.insert_device(&device, &[9; 32]).unwrap();
    tx.put_layout(&layout).unwrap();
    tx.put_pref(&PrefValue::Hold(5)).unwrap();
    tx.commit().unwrap();
    let mut tx = store.begin().unwrap();
    t.text = "fix the build, then ship".into();
    tx.update_thought(&t).unwrap();
    let change = tx.commit().unwrap().unwrap();
    assert_eq!(change.rev, rev(2));
    let before: Vec<_> = {
        let tx = store.begin().unwrap();
        [
            Collection::Thoughts,
            Collection::Projects,
            Collection::Layouts,
            Collection::Prefs,
            Collection::Devices,
        ]
        .map(|c| tx.live(c).unwrap())
        .into()
    };
    drop(store);

    let (mut store, recovered) = open(&dir.db());
    assert_eq!(recovered, None);
    assert_eq!(store.rev(), rev(2), "the high-water mark survives");
    let tx = store.begin().unwrap();
    let after: Vec<_> = [
        Collection::Thoughts,
        Collection::Projects,
        Collection::Layouts,
        Collection::Prefs,
        Collection::Devices,
    ]
    .map(|c| tx.live(c).unwrap())
    .into();
    assert_eq!(after, before);
    assert_eq!(
        tx.thought(t.id).unwrap().unwrap().text,
        "fix the build, then ship"
    );
    assert_eq!(tx.device(device.id).unwrap().unwrap().1, [9; 32]);
    assert_eq!(
        tx.pref(PrefKey::Hold).unwrap().unwrap().value,
        PrefValue::Hold(5)
    );
    drop(tx);
    let mut tx = store.begin().unwrap();
    tx.update_project(&p).unwrap();
    assert_eq!(
        tx.commit().unwrap().unwrap().rev,
        rev(3),
        "the next write follows on"
    );
}

#[test]
fn memory_revisions_share_the_counter() {
    let dir = Dir::new("memory-rev");
    let (mut store, _) = open(&dir.db());
    assert_eq!(store.take_rev().unwrap(), rev(1));
    assert_eq!(store.take_rev().unwrap(), rev(2));
    assert_eq!(store.rev(), rev(2));
    let mut tx = store.begin().unwrap();
    tx.insert_project(&project("/work/m")).unwrap();
    assert_eq!(tx.commit().unwrap().unwrap().rev, rev(3));
    assert_eq!(store.take_rev().unwrap(), rev(4));
}

#[test]
fn a_newer_schema_is_refused_and_left_untouched() {
    let dir = Dir::new("newer");
    drop(open(&dir.db()));
    let known = MIGRATIONS.len() as u32;
    let wal = dir.0.join("core.db-wal");
    let refused = || {
        let err = Store::open(&dir.db(), at(OPENED)).err().unwrap();
        assert!(
            matches!(err, Error::Newer { found, known: k } if found == known + 1 && k == known),
            "{err}"
        );
        assert!(err.to_string().contains("newer"), "{err}");
    };

    // A newer core that stopped with its migration still in the write-ahead
    // log: refusing must not even checkpoint it.
    let newer = rusqlite::Connection::open(dir.db()).unwrap();
    newer.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    newer
        .pragma_update(None, "user_version", known + 1)
        .unwrap();
    let (bytes, logged, listing) = (
        fs::read(dir.db()).unwrap(),
        fs::read(&wal).unwrap(),
        dir.listing(),
    );
    assert!(!logged.is_empty());
    refused();
    assert_eq!(fs::read(dir.db()).unwrap(), bytes);
    assert_eq!(fs::read(&wal).unwrap(), logged);
    assert_eq!(dir.listing(), listing);
    drop(newer);

    // Checkpointed: SQLite may leave its empty companion files, the database stays as it was.
    let bytes = fs::read(dir.db()).unwrap();
    refused();
    assert_eq!(fs::read(dir.db()).unwrap(), bytes);
    assert!(fs::read(&wal).unwrap_or_default().is_empty());
}

const V2: &str = "CREATE TABLE extra (x INTEGER) STRICT; INSERT INTO extra VALUES (1);";

fn tables(path: &Path) -> (u32, Vec<String>) {
    let db = rusqlite::Connection::open(path).unwrap();
    let version = db
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    let mut stmt = db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .unwrap();
    let names = stmt
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    (version, names)
}

#[test]
fn a_migration_backs_up_first_and_applies() {
    let dir = Dir::new("migrate");
    let p = project("/work/migrate");
    {
        let (mut store, _) = Store::open_with(&dir.db(), &MIGRATIONS[..1], at(OPENED)).unwrap();
        let mut tx = store.begin().unwrap();
        tx.insert_project(&p).unwrap();
        tx.commit().unwrap();
    }
    let (mut store, _) = Store::open_with(&dir.db(), &[MIGRATIONS[0], V2], at(OPENED)).unwrap();
    assert_eq!(
        store
            .begin()
            .unwrap()
            .project(p.id)
            .unwrap()
            .unwrap()
            .folder,
        p.folder
    );
    drop(store);

    let (version, names) = tables(&dir.db());
    assert_eq!(version, 2);
    assert!(names.contains(&"extra".into()));
    // The backup is the database as it was before the migration.
    let backup = dir.0.join("core.v1.db");
    let (version, names) = tables(&backup);
    assert_eq!(version, 1);
    assert!(!names.contains(&"extra".into()));
    let (mut old, _) = Store::open_with(&backup, &MIGRATIONS[..1], at(OPENED)).unwrap();
    assert!(old.begin().unwrap().project(p.id).unwrap().is_some());
}

#[test]
fn a_migration_that_fails_halfway_changes_nothing() {
    let dir = Dir::new("migrate-fail");
    let p = project("/work/fail");
    {
        let (mut store, _) = Store::open_with(&dir.db(), &MIGRATIONS[..1], at(OPENED)).unwrap();
        let mut tx = store.begin().unwrap();
        tx.insert_project(&p).unwrap();
        tx.commit().unwrap();
    }
    let bytes = fs::read(dir.db()).unwrap();
    // The first two statements succeed; the third breaks a NOT NULL column.
    let broken = "CREATE TABLE extra (x INTEGER); INSERT INTO extra VALUES (1); \
                  INSERT INTO projects (id) VALUES ('x');";
    let err = Store::open_with(&dir.db(), &[MIGRATIONS[0], broken], at(OPENED))
        .err()
        .unwrap();
    assert!(matches!(err, Error::Migration { version: 2, .. }), "{err}");

    assert_eq!(fs::read(dir.db()).unwrap(), bytes);
    let (version, names) = tables(&dir.db());
    assert_eq!(version, 1);
    assert!(!names.contains(&"extra".into()));
    let (mut store, _) = Store::open_with(&dir.db(), &MIGRATIONS[..1], at(OPENED)).unwrap();
    assert_eq!(
        store
            .begin()
            .unwrap()
            .project(p.id)
            .unwrap()
            .unwrap()
            .folder,
        p.folder
    );
}

#[test]
fn a_change_is_exactly_what_the_transaction_wrote() {
    let dir = Dir::new("changes");
    let (mut store, _) = open(&dir.db());
    let p = project("/work/changes");
    let mut t = thought(Some(p.id), Phase::Working);
    let term = terminal(Some(p.id), TerminalState::Running);
    let s = session(p.id, Some(term.id), Some(t.id), SessionState::Working);
    let q = question(Some(t.id), Some(s.id));
    let device = Device {
        id: DeviceId::mint(),
        rev: Rev::ZERO,
        name: "Mac".into(),
        last_seen: None,
        revoked: false,
    };

    let mut tx = store.begin().unwrap();
    tx.insert_project(&p).unwrap();
    tx.insert_thought(&t).unwrap();
    tx.insert_terminal(&term, Some(&[7; 32])).unwrap();
    tx.insert_session(&s).unwrap();
    // Written twice in one transaction: sent once, as it ends up.
    t.session_id = Some(s.id);
    t.status = Status::NeedsYou;
    tx.update_thought(&t).unwrap();
    tx.insert_question(&q, "request-1").unwrap();
    tx.insert_device(&device, &[1; 32]).unwrap();
    let change = tx.commit().unwrap().unwrap();
    let r1 = rev(1);
    assert_eq!(change.rev, r1);
    assert!(!change.snap);
    assert_eq!(
        change.sets,
        vec![
            Set::Thoughts(puts(vec![sent(&t, |t| {
                t.rev = r1;
                t.live = true;
            })])),
            Set::Projects(puts(vec![sent(&p, |p| p.rev = r1)])),
            Set::Sessions(puts(vec![sent(&s, |s| s.rev = r1)])),
            Set::Terminals(puts(vec![sent(&term, |t| t.rev = r1)])),
            Set::Questions(puts(vec![sent(&q, |q| q.rev = r1)])),
            Set::Devices(puts(vec![sent(&device, |d| d.rev = r1)])),
        ]
    );
    {
        let tx = store.begin().unwrap();
        assert_eq!(tx.terminal_by_token(&[7; 32]).unwrap().unwrap().id, term.id);
        assert_eq!(tx.terminal_session(term.id).unwrap().unwrap().id, s.id);
        assert_eq!(
            tx.question_by_request("request-1").unwrap().unwrap().id,
            q.id
        );
        assert_eq!(
            tx.thoughts_in_flight(s.id).unwrap(),
            vec![sent(&t, |t| {
                t.rev = r1;
                t.live = true;
            })]
        );
    }

    // An answer is seen inside its question.
    let answer = Answer {
        response: Response::Choice { choice: 1 },
        device_id: Some(device.id),
        created: at(10),
        delivered: None,
    };
    let mut tx = store.begin().unwrap();
    tx.insert_answer(q.id, &answer).unwrap();
    tx.set_question_state(q.id, QuestionState::Answered)
        .unwrap();
    tx.set_delivered(q.id, at(11)).unwrap();
    let change = tx.commit().unwrap().unwrap();
    let answered = sent(&q, |q| {
        q.rev = rev(2);
        q.state = QuestionState::Answered;
        q.answer = Some(Answer {
            delivered: Some(at(11)),
            ..answer.clone()
        });
    });
    assert_eq!(
        change.sets,
        vec![Set::Questions(puts(vec![answered.clone()]))]
    );
    assert_eq!(
        store.begin().unwrap().question(q.id).unwrap(),
        Some(answered)
    );

    // Plain data: put twice is one put; a delete is a del; a row added and
    // removed in one transaction is not sent at all.
    let layout = Layout {
        id: p.id,
        rev: Rev::ZERO,
        tree: json!(["a"]),
    };
    let mut tx = store.begin().unwrap();
    tx.put_pref(&PrefValue::Hold(3)).unwrap();
    tx.put_pref(&PrefValue::Hold(4)).unwrap();
    tx.put_layout(&layout).unwrap();
    tx.delete_layout(p.id).unwrap();
    let change = tx.commit().unwrap().unwrap();
    assert_eq!(
        change.sets,
        vec![Set::Prefs(puts(vec![tasktap_proto::Pref {
            value: PrefValue::Hold(4),
            rev: rev(3),
        }]))]
    );
    let mut tx = store.begin().unwrap();
    assert!(tx.delete_pref(PrefKey::Hold).unwrap());
    assert!(!tx.delete_pref(PrefKey::Hold).unwrap());
    let change = tx.commit().unwrap().unwrap();
    assert_eq!(change.sets, vec![Set::Prefs(dels(vec![PrefKey::Hold]))]);

    // A thought deleted with its question leaves as two dels.
    let note = thought(Some(p.id), Phase::Captured);
    let nq = question(Some(note.id), None);
    let mut tx = store.begin().unwrap();
    tx.insert_thought(&note).unwrap();
    tx.insert_question(&nq, "request-2").unwrap();
    tx.commit().unwrap();
    let mut tx = store.begin().unwrap();
    assert!(tx.delete_thought(note.id).unwrap());
    let change = tx.commit().unwrap().unwrap();
    assert_eq!(
        change.sets,
        vec![
            Set::Thoughts(dels(vec![note.id])),
            Set::Questions(dels(vec![nq.id]))
        ]
    );
}

#[test]
fn a_rolled_back_transaction_takes_no_revision_and_sends_nothing() {
    let dir = Dir::new("rollback");
    let (mut store, _) = open(&dir.db());
    let p = project("/work/rollback");
    let mut tx = store.begin().unwrap();
    tx.insert_project(&p).unwrap();
    drop(tx);
    assert_eq!(store.rev(), Rev::ZERO);
    assert_eq!(store.begin().unwrap().project(p.id).unwrap(), None);

    // A failed write is dropped by its caller, which undoes the writes before it.
    let mut tx = store.begin().unwrap();
    tx.insert_project(&p).unwrap();
    assert!(matches!(tx.insert_project(&p), Err(Error::Duplicate(_))));
    drop(tx);
    assert_eq!(store.rev(), Rev::ZERO);
    assert_eq!(store.begin().unwrap().project(p.id).unwrap(), None);

    let mut tx = store.begin().unwrap();
    tx.insert_project(&p).unwrap();
    assert_eq!(tx.commit().unwrap().unwrap().rev, rev(1));

    // Attempts are not records: writing one commits but takes no revision.
    let mut tx = store.begin().unwrap();
    tx.insert_attempt(&Attempt {
        id: AttemptId::mint(),
        kind: AttemptKind::Terminal(TerminalId::mint()),
        args_hash: [0; 32],
        started: at(1),
        outcome: None,
    })
    .unwrap();
    assert_eq!(tx.commit().unwrap(), None);
    assert_eq!(store.rev(), rev(1));
}

#[test]
fn finished_thoughts_beyond_the_bound_leave_as_deletes_and_page_back() {
    let dir = Dir::new("live");
    let (mut store, _) = open(&dir.db());
    let p = project("/work/live");
    let mut old: Vec<Thought> = (0..LIVE_FINISHED).map(|_| finished(p.id)).collect();
    old.sort_by_key(|t| t.id);
    let oldest = old[0].clone();
    let s = session(p.id, None, Some(oldest.id), SessionState::Ended);
    let q = question(Some(oldest.id), Some(s.id));
    let r = result(oldest.id);
    let note = thought(Some(p.id), Phase::Captured);

    let mut tx = store.begin().unwrap();
    tx.insert_project(&p).unwrap();
    tx.insert_thought(&note).unwrap();
    for t in &old {
        tx.insert_thought(t).unwrap();
    }
    tx.insert_session(&s).unwrap();
    tx.insert_question(&q, "q").unwrap();
    tx.insert_result(&r, "the whole answer").unwrap();
    let change = tx.commit().unwrap().unwrap();
    assert!(matches!(&change.sets[0], Set::Thoughts(rows) if rows.put.len() == old.len() + 1));
    assert_eq!(live_thoughts(&mut store).len(), old.len() + 1);

    // One more finished thought pushes the oldest out, with its session,
    // question and result. The unfinished note stays however old it is.
    let newest = finished(p.id);
    let mut tx = store.begin().unwrap();
    tx.insert_thought(&newest).unwrap();
    let change = tx.commit().unwrap().unwrap();
    let r2 = change.rev;
    assert_eq!(
        change.sets,
        vec![
            Set::Thoughts(Rows {
                put: vec![sent(&newest, |t| {
                    t.rev = r2;
                    t.live = true;
                })],
                del: vec![oldest.id],
            }),
            Set::Sessions(dels(vec![s.id])),
            Set::Questions(dels(vec![q.id])),
            Set::Results(dels(vec![r.id])),
        ]
    );
    let live = live_thoughts(&mut store);
    assert_eq!(live.len(), old.len() + 1);
    assert!(live.iter().any(|t| t.id == note.id));
    assert!(!live.iter().any(|t| t.id == oldest.id));

    let left = sent(&oldest, |t| {
        t.rev = r2;
        t.live = false;
    });
    let page = store
        .begin()
        .unwrap()
        .history(None, None, Limit::MAX, usize::MAX)
        .unwrap();
    assert_eq!(page.thoughts, vec![left.clone()]);
    assert_eq!(page.questions, vec![sent(&q, |q| q.rev = rev(1))]);
    assert_eq!(page.results, vec![sent(&r, |r| r.rev = rev(1))]);
    assert_eq!(
        store.begin().unwrap().result_body(r.id).unwrap().as_deref(),
        Some("the whole answer")
    );

    // A write to a row out of the live set takes a revision but sends nothing.
    let mut tx = store.begin().unwrap();
    tx.update_thought(&sent(&left, |t| t.text = "renamed".into()))
        .unwrap();
    assert_eq!(tx.commit().unwrap().unwrap().sets, vec![]);

    // Marked unread, it is not finished any more and comes back with its rows.
    let mut tx = store.begin().unwrap();
    let unread = sent(&left, |t| {
        t.text = "renamed".into();
        t.read = false;
    });
    tx.update_thought(&unread).unwrap();
    let change = tx.commit().unwrap().unwrap();
    let r4 = change.rev;
    assert_eq!(
        change.sets,
        vec![
            Set::Thoughts(puts(vec![sent(&unread, |t| {
                t.rev = r4;
                t.live = true;
            })])),
            Set::Sessions(puts(vec![sent(&s, |s| s.rev = rev(1))])),
            Set::Questions(puts(vec![sent(&q, |q| q.rev = rev(1))])),
            Set::Results(puts(vec![sent(&r, |r| r.rev = rev(1))])),
        ]
    );

    // History pages newest first, by id.
    let more: Vec<Thought> = (0..3).map(|_| finished(p.id)).collect();
    let mut tx = store.begin().unwrap();
    for t in &more {
        tx.insert_thought(t).unwrap();
    }
    let change = tx.commit().unwrap().unwrap();
    let Set::Thoughts(rows) = &change.sets[0] else {
        panic!("{change:?}")
    };
    let mut evicted = rows.del.clone();
    evicted.sort();
    evicted.reverse();
    assert_eq!(evicted.len(), 3);
    let tx = store.begin().unwrap();
    let first = tx
        .history(None, None, Limit::new(2).unwrap(), usize::MAX)
        .unwrap();
    let ids: Vec<_> = first.thoughts.iter().map(|t| t.id).collect();
    assert_eq!(ids, evicted[..2]);
    let second = tx
        .history(Some(ids[1]), None, Limit::new(2).unwrap(), usize::MAX)
        .unwrap();
    let ids: Vec<_> = second.thoughts.iter().map(|t| t.id).collect();
    assert_eq!(ids, evicted[2..]);
    assert!(second.thoughts.iter().all(|t| !t.live));
}

/// Rows in every state the recovery pass must tell apart.
struct Scene {
    running: Terminal,
    exited: Terminal,
    working: Session,
    starting: Session,
    ended: Session,
    interrupted: Thought,
    unlaunched: Thought,
    held: Thought,
    done: Thought,
    captured: Thought,
    asked: Question,
    answered: Question,
    router: Question,
    pending: Attempt,
    replied: Attempt,
}

fn scene(store: &mut Store) -> Scene {
    let p = project("/work/recover");
    let running = terminal(Some(p.id), TerminalState::Running);
    let exited = Terminal {
        exit: Some(0),
        ..terminal(Some(p.id), TerminalState::Exited)
    };
    let interrupted = thought(Some(p.id), Phase::Working);
    // Its launch was committed, but the core stopped before its terminal was.
    let unlaunched = thought(Some(p.id), Phase::Working);
    let held = Thought {
        hold_until: Some(at(99)),
        ..thought(Some(p.id), Phase::Routed)
    };
    let done = finished(p.id);
    let captured = thought(Some(p.id), Phase::Captured);
    let working = session(
        p.id,
        Some(running.id),
        Some(interrupted.id),
        SessionState::Working,
    );
    let starting = session(p.id, None, Some(unlaunched.id), SessionState::Starting);
    let ended = session(p.id, Some(exited.id), Some(done.id), SessionState::Ended);
    let asked = question(Some(interrupted.id), Some(working.id));
    let answered = question(Some(interrupted.id), Some(working.id));
    let router = Question {
        source: QuestionSource::Router,
        reply_via: ReplyVia::Core,
        ..question(Some(captured.id), None)
    };
    let pending = Attempt {
        id: AttemptId::mint(),
        kind: AttemptKind::Launch(unlaunched.id),
        args_hash: [3; 32],
        started: at(4),
        outcome: None,
    };
    let replied = Attempt {
        id: AttemptId::mint(),
        kind: AttemptKind::Launch(interrupted.id),
        args_hash: [4; 32],
        started: at(3),
        outcome: Some(AttemptOutcome::Reply(Outcome::Ok(json!({"rev": 1})))),
    };

    let mut tx = store.begin().unwrap();
    tx.insert_project(&p).unwrap();
    tx.insert_terminal(&running, Some(&[1; 32])).unwrap();
    tx.insert_terminal(&exited, None).unwrap();
    for t in [&interrupted, &unlaunched, &held, &done, &captured] {
        tx.insert_thought(t).unwrap();
    }
    for s in [&working, &starting, &ended] {
        tx.insert_session(s).unwrap();
    }
    tx.insert_question(&asked, "asked").unwrap();
    tx.insert_question(&answered, "answered").unwrap();
    tx.insert_question(&router, "router").unwrap();
    tx.insert_answer(
        answered.id,
        &Answer {
            response: Response::Affirm,
            device_id: None,
            created: at(5),
            delivered: None,
        },
    )
    .unwrap();
    tx.set_question_state(answered.id, QuestionState::Answered)
        .unwrap();
    tx.insert_attempt(&pending).unwrap();
    tx.insert_attempt(&replied).unwrap();
    tx.commit().unwrap();
    Scene {
        running,
        exited,
        working,
        starting,
        ended,
        interrupted,
        unlaunched,
        held,
        done,
        captured,
        asked,
        answered,
        router,
        pending,
        replied,
    }
}

fn everything(store: &mut Store) -> Vec<Option<Set>> {
    let tx = store.begin().unwrap();
    [
        Collection::Thoughts,
        Collection::Projects,
        Collection::Sessions,
        Collection::Terminals,
        Collection::Questions,
        Collection::Results,
    ]
    .map(|c| tx.live(c).unwrap())
    .into()
}

#[test]
fn recovery_closes_exactly_what_an_earlier_boot_left_open() {
    let dir = Dir::new("recover");
    let (mut store, _) = open(&dir.db());
    let s = scene(&mut store);
    let r1 = store.rev();
    let before = everything(&mut store);
    drop(store);

    let (mut store, recovered) = open(&dir.db());
    let change = recovered.unwrap();
    let r = change.rev;
    assert_eq!(r, rev(r1.get() + 1));
    let fail = |t: &Thought| {
        sent(t, |t| {
            t.rev = r;
            t.live = true;
            t.phase = Phase::Failed;
            t.status = Status::Failed;
            t.reason = Some(Reason::Interrupted);
        })
    };
    let Set::Thoughts(thoughts) = &change.sets[0] else {
        panic!("{change:?}")
    };
    let mut thoughts = thoughts.clone();
    for t in &mut thoughts.put {
        assert!(t.updated == at(OPENED) || t.id == s.held.id);
        t.updated = s.interrupted.updated;
    }
    let mut expected = vec![
        fail(&s.interrupted),
        fail(&s.unlaunched),
        sent(&s.held, |t| {
            t.rev = r;
            t.live = true;
            t.hold_until = None;
        }),
    ];
    expected.sort_by_key(|t| t.id);
    assert_eq!(thoughts, puts(expected));
    let mut ended = vec![
        sent(&s.working, |x| {
            x.rev = r;
            x.state = SessionState::Ended;
        }),
        sent(&s.starting, |x| {
            x.rev = r;
            x.state = SessionState::Ended;
        }),
    ];
    ended.sort_by_key(|x| x.id);
    assert_eq!(
        change.sets[1..],
        [
            Set::Sessions(puts(ended)),
            Set::Terminals(puts(vec![sent(&s.running, |t| {
                t.rev = r;
                t.state = TerminalState::Lost;
            })])),
            Set::Questions(puts(vec![sent(&s.asked, |q| {
                q.rev = r;
                q.state = QuestionState::Withdrawn;
            })])),
        ]
    );

    // Nothing else moved: the rows it did not name are as they were.
    let after = everything(&mut store);
    let untouched = |sets: &[Option<Set>]| -> Vec<String> {
        let changed = [
            s.interrupted.id.uuid(),
            s.unlaunched.id.uuid(),
            s.held.id.uuid(),
            s.working.id.uuid(),
            s.starting.id.uuid(),
            s.running.id.uuid(),
            s.asked.id.uuid(),
        ]
        .map(|id| id.to_string());
        let text = serde_json::to_value(sets).unwrap();
        let mut rows = Vec::new();
        for set in text.as_array().unwrap() {
            for row in set["put"].as_array().into_iter().flatten() {
                if !changed.contains(&row["id"].as_str().unwrap().to_owned()) {
                    rows.push(row.to_string());
                }
            }
        }
        rows
    };
    assert_eq!(untouched(&after), untouched(&before));
    for row in [
        s.exited.id.uuid(),
        s.ended.id.uuid(),
        s.done.id.uuid(),
        s.captured.id.uuid(),
    ]
    .map(|id| id.to_string())
    {
        assert!(
            untouched(&after).iter().any(|r| r.contains(&row)),
            "{row} is still there"
        );
    }
    let tx = store.begin().unwrap();
    assert_eq!(
        tx.question(s.router.id).unwrap().unwrap().state,
        QuestionState::Open
    );
    assert_eq!(
        tx.question(s.answered.id).unwrap().unwrap().state,
        QuestionState::Answered
    );
    assert_eq!(
        tx.attempt(s.pending.id).unwrap().unwrap().outcome,
        Some(AttemptOutcome::Interrupted)
    );
    assert_eq!(tx.attempt(s.replied.id).unwrap().unwrap(), s.replied);
    // It closes and never opens: nothing runs, works or waits on a session.
    assert!(tx.terminal_session(s.running.id).unwrap().is_none());
    assert_eq!(tx.open_questions().unwrap().len(), 1);
    drop(tx);

    // A second pass finds nothing to do.
    let r2 = store.rev();
    drop(store);
    let (store, recovered) = open(&dir.db());
    assert_eq!(recovered, None);
    assert_eq!(store.rev(), r2);
    assert_eq!(store.boot(), 3);
}

#[test]
fn recovery_withdraws_every_open_question_of_an_interrupted_thought() {
    let dir = Dir::new("recover-thought");
    let (mut store, _) = open(&dir.db());
    let p = project("/work/needs");
    let t = Thought {
        status: Status::NeedsYou,
        ..thought(Some(p.id), Phase::Working)
    };
    // Bound to no session: it closes because its thought was interrupted.
    let q = question(Some(t.id), None);
    let mut tx = store.begin().unwrap();
    tx.insert_project(&p).unwrap();
    tx.insert_thought(&t).unwrap();
    tx.insert_question(&q, "unbound").unwrap();
    tx.commit().unwrap();
    drop(store);
    let (mut store, _) = open(&dir.db());
    let tx = store.begin().unwrap();
    let t = tx.thought(t.id).unwrap().unwrap();
    assert_eq!((t.phase, t.status), (Phase::Failed, Status::Failed));
    assert_eq!(
        tx.question(q.id).unwrap().unwrap().state,
        QuestionState::Withdrawn
    );
}

#[test]
fn constraint_violations_are_typed() {
    let dir = Dir::new("constraints");
    let (mut store, _) = open(&dir.db());
    let p = project("/work/c");
    let t = thought(Some(p.id), Phase::Captured);
    let q = question(Some(t.id), None);
    let mut tx = store.begin().unwrap();
    tx.insert_project(&p).unwrap();
    tx.insert_thought(&t).unwrap();
    tx.insert_question(&q, "request").unwrap();
    tx.commit().unwrap();

    let mut tx = store.begin().unwrap();
    assert!(matches!(tx.insert_project(&p), Err(Error::Duplicate(_))));
    let same_folder = Project {
        id: ProjectId::mint(),
        ..p.clone()
    };
    let err = tx.insert_project(&same_folder).err().unwrap();
    assert!(
        matches!(&err, Error::Duplicate(what) if what.contains("projects.folder")),
        "{err}"
    );
    assert!(matches!(tx.insert_thought(&t), Err(Error::Duplicate(_))));
    let again = question(Some(t.id), None);
    let err = tx.insert_question(&again, "request").err().unwrap();
    assert!(
        matches!(&err, Error::Duplicate(what) if what.contains("request_key")),
        "{err}"
    );

    let stray = thought(Some(ProjectId::mint()), Phase::Captured);
    assert!(matches!(tx.insert_thought(&stray), Err(Error::Reference)));
    let orphan = question(Some(ThoughtId::mint()), None);
    assert!(matches!(
        tx.insert_question(&orphan, "orphan"),
        Err(Error::Reference)
    ));
    let answer = Answer {
        response: Response::Deny,
        device_id: None,
        created: at(1),
        delivered: None,
    };
    assert!(matches!(
        tx.insert_answer(QuestionId::mint(), &answer),
        Err(Error::Reference)
    ));
    tx.insert_answer(q.id, &answer).unwrap();
    assert!(matches!(
        tx.insert_answer(q.id, &answer),
        Err(Error::Duplicate(_))
    ));
    let unknown_device = Answer {
        device_id: Some(DeviceId::mint()),
        ..answer.clone()
    };
    let other = question(Some(t.id), None);
    tx.insert_question(&other, "other").unwrap();
    assert!(matches!(
        tx.insert_answer(other.id, &unknown_device),
        Err(Error::Reference)
    ));

    let s = session(p.id, None, Some(t.id), SessionState::Idle);
    tx.insert_session(&s).unwrap();
    assert!(matches!(tx.delete_thought(t.id), Err(Error::Reference)));
    assert!(
        tx.question(q.id).unwrap().is_some(),
        "a refused delete removes nothing"
    );

    assert!(matches!(tx.update_thought(&stray), Err(Error::NotFound)));
    assert!(matches!(
        tx.set_question_state(QuestionId::mint(), QuestionState::Withdrawn),
        Err(Error::NotFound)
    ));
    assert!(matches!(
        tx.set_delivered(other.id, at(2)),
        Err(Error::NotFound)
    ));

    let attempt = Attempt {
        id: AttemptId::mint(),
        kind: AttemptKind::Settle(t.id),
        args_hash: [2; 32],
        started: at(1),
        outcome: None,
    };
    tx.insert_attempt(&attempt).unwrap();
    assert!(matches!(
        tx.insert_attempt(&attempt),
        Err(Error::Duplicate(_))
    ));
    let first = AttemptOutcome::Reply(Outcome::Err(tasktap_proto::Error::new(
        tasktap_proto::Code::Conflict,
        "session still running",
    )));
    tx.set_outcome(attempt.id, &first).unwrap();
    assert!(matches!(
        tx.set_outcome(attempt.id, &AttemptOutcome::Interrupted),
        Err(Error::NotFound)
    ));
    assert_eq!(
        tx.attempt(attempt.id).unwrap().unwrap().outcome,
        Some(first)
    );
}

#[test]
fn a_session_event_is_seen_once_and_forgotten_at_start() {
    let dir = Dir::new("seen");
    let (mut store, _) = open(&dir.db());
    let p = project("/work/seen");
    let s = session(p.id, None, None, SessionState::Idle);
    let other = session(p.id, None, None, SessionState::Idle);
    let mut tx = store.begin().unwrap();
    tx.insert_project(&p).unwrap();
    tx.insert_session(&s).unwrap();
    tx.insert_session(&other).unwrap();
    tx.commit().unwrap();

    let mut tx = store.begin().unwrap();
    assert!(tx.see_event(s.id, "event-1").unwrap());
    assert!(!tx.see_event(s.id, "event-1").unwrap());
    // Ids are the sender's, so they are only unique within a session.
    assert!(tx.see_event(other.id, "event-1").unwrap());
    // Remembering an event is not a record change.
    assert_eq!(tx.commit().unwrap(), None);
    let mut tx = store.begin().unwrap();
    assert!(!tx.see_event(s.id, "event-1").unwrap());
    drop(tx);

    // Every session of the boot before has ended, so the next start forgets them.
    drop(store);
    let (mut store, _) = open(&dir.db());
    assert!(store.begin().unwrap().see_event(s.id, "event-1").unwrap());
}

#[test]
fn a_request_key_reads_back_by_question() {
    let dir = Dir::new("request-key");
    let (mut store, _) = open(&dir.db());
    let q = question(None, None);
    let mut tx = store.begin().unwrap();
    tx.insert_question(&q, "router 1 n:2").unwrap();
    assert_eq!(
        tx.request_key(q.id).unwrap().as_deref(),
        Some("router 1 n:2")
    );
    assert_eq!(tx.request_key(QuestionId::mint()).unwrap(), None);
}

/// Records are stored as documents, so a field a newer build added reads here
/// ignored, and a field added after a document was written reads as absent
/// (`None`) without a migration.
#[test]
fn documents_read_across_builds_without_a_migration() {
    let dir = Dir::new("documents");
    let (mut store, _) = open(&dir.db());
    let p = project("/work/documents");
    let t = thought(Some(p.id), Phase::Captured);
    let s = Session {
        activity: vec!["memory only".into()],
        ..session(p.id, None, None, SessionState::Idle)
    };
    let q = question(Some(t.id), None);
    let answer = Answer {
        response: Response::Choice { choice: 1 },
        device_id: None,
        created: at(3),
        delivered: None,
    };
    let mut tx = store.begin().unwrap();
    tx.insert_project(&p).unwrap();
    tx.insert_thought(&t).unwrap();
    tx.insert_session(&s).unwrap();
    tx.insert_question(&q, "documents").unwrap();
    tx.insert_answer(q.id, &answer).unwrap();
    tx.commit().unwrap();
    let tx = store.begin().unwrap();
    let (t, q) = (
        tx.thought(t.id).unwrap().unwrap(),
        tx.question(q.id).unwrap().unwrap(),
    );
    assert_eq!(q.answer.as_ref(), Some(&answer));
    let stored = tx.session(s.id).unwrap().unwrap();
    assert!(stored.activity.is_empty(), "activity was stored");
    drop(tx);
    drop(store);

    let db = rusqlite::Connection::open(dir.db()).unwrap();
    let newer = "json_set(data, '$.routing', json('{\"via\": \"router\"}'))";
    for table in ["thoughts", "questions", "answers"] {
        let sql = format!("UPDATE {table} SET data = {newer}");
        assert_eq!(db.execute(&sql, []).unwrap(), 1);
    }
    let older = "UPDATE thoughts SET data = json_remove(data, '$.brief')";
    assert_eq!(db.execute(older, []).unwrap(), 1);
    drop(db);

    let (mut store, _) = open(&dir.db());
    let tx = store.begin().unwrap();
    assert_eq!(
        tx.thought(t.id).unwrap().unwrap(),
        Thought { brief: None, ..t }
    );
    assert_eq!(tx.question(q.id).unwrap().unwrap(), q);
}

const CHILD: &str = "TASKTAP_STORE_CHILD";

/// Run by the next test as a child process: writes until it is killed.
#[test]
#[ignore = "run as a child of killed_writer_loses_no_commit"]
fn killed_writer_child() {
    let Some(path) = std::env::var_os(CHILD) else {
        return;
    };
    let (mut store, _) = open(Path::new(&path));
    loop {
        let mut tx = store.begin().unwrap();
        // Two rows a page each, so a kill can land between them.
        for _ in 0..2 {
            tx.insert_thought(&Thought {
                text: "x".repeat(8000),
                ..thought(None, Phase::Captured)
            })
            .unwrap();
        }
        let change = tx.commit().unwrap().unwrap();
        println!("committed {}", change.rev.get());
    }
}

#[test]
fn killed_writer_loses_no_commit() {
    let dir = Dir::new("killed");
    drop(open(&dir.db()));
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "killed_writer_child",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD, dir.db())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut last = 0;
    let mut seen = 0;
    for line in BufReader::new(child.stdout.take().unwrap()).lines() {
        if let Some(n) = line.unwrap().strip_prefix("committed ") {
            last = n.parse().unwrap();
            seen += 1;
            if seen == 40 {
                break;
            }
        }
    }
    child.kill().unwrap();
    child.wait().unwrap();
    assert_eq!(seen, 40, "the child stopped writing early");

    let (mut store, _) = open(&dir.db());
    let committed = store.rev().get();
    assert!(
        committed >= last,
        "a reported commit was lost: {committed} < {last}"
    );
    // Each transaction took one revision and wrote two rows: none is half there.
    assert_eq!(live_thoughts(&mut store).len() as u64, 2 * committed);
}

/// Runs `f` `n` times after a tenth of that to warm up, and prints its median cost.
fn time(what: &str, n: u32, mut f: impl FnMut()) {
    for _ in 0..n / 10 {
        f();
    }
    let mut took: Vec<_> = (0..n)
        .map(|_| {
            let start = std::time::Instant::now();
            f();
            start.elapsed()
        })
        .collect();
    took.sort();
    let us = took[took.len() / 2].as_secs_f64() * 1e6;
    println!("{what}: {us:.1} µs");
}

/// Prints what the store's hot paths cost, to compare two builds of it:
/// `cargo test --release --test store -- --ignored --nocapture hot_path_timings`.
#[test]
#[ignore = "prints timings; run by hand"]
fn hot_path_timings() {
    let dir = Dir::new("timings");
    let (mut store, _) = open(&dir.db());
    let p = project("/work/timings");
    let mut working = thought(Some(p.id), Phase::Working);
    let mut s = session(p.id, None, Some(working.id), SessionState::Working);
    let mut tx = store.begin().unwrap();
    tx.insert_project(&p).unwrap();
    tx.insert_thought(&working).unwrap();
    tx.insert_session(&s).unwrap();
    working.session_id = Some(s.id);
    tx.update_thought(&working).unwrap();
    // The live bound's worth of finished thoughts, and a history page beyond it.
    for i in 0..LIVE_FINISHED + u32::from(Limit::MAX) {
        let t = finished(p.id);
        tx.insert_thought(&t).unwrap();
        let q = Question {
            state: QuestionState::Answered,
            ..question(Some(t.id), None)
        };
        tx.insert_question(&q, &format!("timings {i}")).unwrap();
        tx.insert_result(&result(t.id), "the answer").unwrap();
    }
    tx.commit().unwrap();

    let mut n = 0;
    let mut step = |tx: &mut Tx<'_>| {
        n += 1;
        working.updated = at(n);
        s.turn = n as u32;
        tx.update_thought(&working).unwrap();
        tx.update_session(&s).unwrap();
    };
    time("transition, thought and session, committed", 500, || {
        let mut tx = store.begin().unwrap();
        step(&mut tx);
        tx.commit().unwrap().unwrap();
    });
    time("transition, thought and session, rolled back", 2000, || {
        step(&mut store.begin().unwrap());
    });
    let live = live_thoughts(&mut store).len();
    time(&format!("snapshot of {live} live thoughts"), 1000, || {
        std::hint::black_box(store.begin().unwrap().live(Collection::Thoughts)).unwrap();
    });
    let page = store
        .begin()
        .unwrap()
        .history(None, None, Limit::MAX, usize::MAX)
        .unwrap();
    let what = format!(
        "history page of {} thoughts, {} questions, {} results",
        page.thoughts.len(),
        page.questions.len(),
        page.results.len()
    );
    time(&what, 1000, || {
        std::hint::black_box(
            store
                .begin()
                .unwrap()
                .history(None, None, Limit::MAX, usize::MAX),
        )
        .unwrap();
    });
}
