//! Records (design §1): each test starts the real binary on its own folder
//! and watches it through `client.rs`, as a page would. Rows that only the
//! state machine writes come from the binary's test-only `fixture.records`.

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tasktap_core::client::{self, Client};
use tasktap_proto::call::{self, Call, Code};
use tasktap_proto::{
    Auth, CallId, Change, Collection, Control, Delete, DeviceId, FixtureClock, FixtureRecords,
    Frame, Glance, HEADER, Hello, History, Isolate, LayoutPatch, Limit, Mode, NotePatch, Outcome,
    Phase, Pref, PrefKey, PrefPatch, PrefValue, Project, ProjectId, ProjectKind, ProjectPatch, Put,
    PutTarget, Register, Request, ResultId, ResultKind, Retire, Rev, Role, Rows, Secret, SessionId,
    Set, Source, Status, Subscribe, Thought, ThoughtId, Time, TurnResult, VERSION, Versions, When,
    encode_control,
};

mod common;

const EXE: &str = env!("CARGO_BIN_EXE_tasktap");
/// Most bytes of JSON in one snapshot chunk (design §1).
const CHUNK: usize = 256 << 10;
const ALL: [Collection; 10] = [
    Collection::Thoughts,
    Collection::Projects,
    Collection::Sessions,
    Collection::Terminals,
    Collection::Questions,
    Collection::Results,
    Collection::Layouts,
    Collection::Prefs,
    Collection::Devices,
    Collection::Glance,
];

/// A fresh data folder, removed afterwards.
struct Folder(PathBuf);

impl Folder {
    fn new() -> Folder {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        // Short: a socket path has a length limit.
        let path = std::env::temp_dir().join(format!("tr-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Folder(path)
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A core this test started; killed if the test ends with it still running.
struct Core {
    child: Child,
    data: PathBuf,
    _watchdog: common::Watchdog,
}

impl Core {
    fn start(data: &Folder) -> Core {
        let mut serve = client::serve_command(Path::new(EXE), &data.0);
        serve.args(["--idle-ms", "600000"]);
        let child = client::start(serve).unwrap();
        Core {
            _watchdog: common::Watchdog::new(&child),
            child,
            data: data.0.clone(),
        }
    }

    /// A new connection, as a newly registered device. A frame that never
    /// comes fails the test instead of hanging it.
    fn device(&self) -> Client {
        self.connect(DeviceId::mint(), Some("test"))
    }

    /// A new connection as the device `id`, registering it under `name` if given.
    fn connect(&self, id: DeviceId, name: Option<&str>) -> Client {
        let stream = client::connect(&self.data).unwrap();
        #[cfg(unix)]
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(20)))
            .unwrap();
        let hello = Hello {
            v: Versions(VERSION, VERSION),
            role: Role::Page,
            client: "records test".into(),
            auth: Some(Auth::Device {
                device: id,
                key: Secret([1; 32]),
                register: name.map(|name| Register { name: name.into() }),
            }),
            abilities: Vec::new(),
        };
        Client::hello(stream, hello).unwrap().unwrap()
    }

    /// Retires the core and waits until it has exited.
    fn stop(mut self) {
        let retire = Retire { when: When::Now };
        let mut c = self.device();
        c.call::<call::CoreRetire>(&retire).unwrap().unwrap();
        assert!(self.child.wait().unwrap().success());
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// What a client holds after applying a snapshot and changes: every row, by
/// collection and id (`glance`, which has none, under "").
#[derive(Clone, Debug, Default, PartialEq)]
struct Model(BTreeMap<(String, String), Value>);

impl Model {
    fn apply(&mut self, sets: &[Set]) {
        for set in sets {
            let set = serde_json::to_value(set).unwrap();
            let c = set["c"].as_str().unwrap().to_owned();
            for row in set["put"].as_array().into_iter().flatten() {
                let id = row["id"].as_str().unwrap_or_default().to_owned();
                self.0.insert((c.clone(), id), row.clone());
            }
            for id in set["del"].as_array().into_iter().flatten() {
                let key = (c.clone(), id.as_str().unwrap().to_owned());
                assert!(
                    self.0.remove(&key).is_some(),
                    "a delete of {key:?}, never put"
                );
            }
        }
    }

    fn get(&self, c: &str, id: impl serde::Serialize) -> Option<&Value> {
        let id = serde_json::to_value(id).unwrap();
        let id = id.as_str().unwrap_or_default().to_owned();
        self.0.get(&(c.to_owned(), id))
    }

    fn count(&self, c: &str) -> usize {
        self.0.keys().filter(|(k, _)| k == c).count()
    }
}

struct Snapshot {
    rev: Rev,
    model: Model,
    frames: Vec<Change>,
    /// Changes that arrived before this snapshot, sent for the subscription it replaced.
    before: Vec<Change>,
}

/// `sub`, keeping every frame up to its reply.
fn subscribe(c: &mut Client, collections: &[Collection]) -> Snapshot {
    let id = CallId(u32::MAX);
    let collections = collections.to_vec();
    let named = !collections.is_empty();
    c.send(&call::Sub::request(id, &Subscribe { collections }))
        .unwrap();
    let (mut frames, mut before) = (Vec::new(), Vec::new());
    loop {
        match c.recv().unwrap() {
            Frame::Control(Control::Change(change)) if change.snap => frames.push(change),
            Frame::Control(Control::Change(change)) => {
                assert!(frames.is_empty(), "a change inside a snapshot: {change:?}");
                before.push(change);
            }
            Frame::Control(Control::Reply(reply)) if reply.id == id => {
                let rev = call::Sub::result(reply.outcome).unwrap().rev;
                assert_eq!(!frames.is_empty(), named);
                let mut model = Model::default();
                for frame in &frames {
                    assert_eq!(frame.rev, rev);
                    model.apply(&frame.sets);
                }
                return Snapshot {
                    rev,
                    model,
                    frames,
                    before,
                };
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}

/// The next change.
fn change(c: &mut Client) -> Change {
    match c.recv().unwrap() {
        Frame::Control(Control::Change(change)) if !change.snap => change,
        other => panic!("expected a change, got {other:?}"),
    }
}

/// Changes up to and including revision `rev`.
fn until(c: &mut Client, rev: Rev) -> Vec<Change> {
    let mut changes = Vec::new();
    loop {
        let next = change(c);
        let done = next.rev >= rev;
        changes.push(next);
        if done {
            return changes;
        }
    }
}

/// The next change, which must be at `rev` and touch one collection.
fn one(c: &mut Client, rev: Rev) -> Set {
    let mut next = change(c);
    assert_eq!(next.rev, rev);
    assert_eq!(next.sets.len(), 1, "{next:?}");
    next.sets.pop().unwrap()
}

fn put(c: &mut Client, target: PutTarget, if_rev: Option<Rev>) -> Result<Rev, Code> {
    let result = c.call::<call::Put>(&Put { target, if_rev }).unwrap();
    result.map(|r| r.rev).map_err(|e| e.code)
}

fn delete(c: &mut Client, target: Delete) -> Result<Rev, Code> {
    let result = c.call::<call::Delete>(&target).unwrap();
    result.map(|r| r.rev).map_err(|e| e.code)
}

fn hold(c: &mut Client, seconds: u32) -> Rev {
    put(c, PutTarget::Prefs(PrefPatch::Hold(seconds)), None).unwrap()
}

fn layout(id: ProjectId, tree: Value) -> PutTarget {
    let patch = LayoutPatch { tree };
    PutTarget::Layouts { id, patch }
}

fn rename(id: ProjectId, name: &str) -> PutTarget {
    let patch = ProjectPatch {
        name: Some(name.into()),
        ..ProjectPatch::default()
    };
    PutTarget::Projects { id, patch }
}

fn retext(id: ThoughtId, text: &str) -> PutTarget {
    let patch = NotePatch {
        text: Some(text.into()),
        strokes: None,
    };
    PutTarget::Thoughts { id, patch }
}

fn history(c: &mut Client, before: Option<ThoughtId>, limit: u32) -> Vec<Thought> {
    let limit = Limit::new(limit).unwrap();
    let page = c.call::<call::History>(&History { before, limit });
    page.unwrap().unwrap().thoughts
}

/// A call by name, on a connection with no subscription: other frames are dropped.
fn raw(c: &mut Client, name: &str, args: Value) -> Outcome {
    let id = CallId(9000);
    let name = name.to_owned();
    c.send(&Control::Call(Request { id, name, args })).unwrap();
    loop {
        if let Frame::Control(Control::Reply(reply)) = c.recv().unwrap()
            && reply.id == id
        {
            return reply.outcome;
        }
    }
}

fn refused(outcome: Outcome) -> Code {
    match outcome {
        Outcome::Err(e) => e.code,
        Outcome::Ok(v) => panic!("expected an error, got {v}"),
    }
}

/// Writes rows only the state machine writes otherwise; returns the revision after.
fn fixture(c: &mut Client, sets: Vec<Set>) -> Rev {
    let written = c.call::<call::FixtureRecords>(&FixtureRecords { sets });
    written.unwrap().unwrap_or_else(|e| panic!("{e}")).rev
}

fn thoughts(put: Vec<Thought>) -> Set {
    let del = Vec::new();
    Set::Thoughts(Rows { put, del })
}

fn projects(put: Vec<Project>) -> Set {
    let del = Vec::new();
    Set::Projects(Rows { put, del })
}

fn project(name: &str) -> Project {
    Project {
        id: ProjectId::mint(),
        rev: Rev::ZERO,
        name: name.into(),
        folder: format!("/work/{name}"),
        kind: ProjectKind::Folder,
        color: "teal".into(),
        aliases: Vec::new(),
        git: true,
        isolate: Isolate::Busy,
        open: true,
        available: true,
    }
}

fn thought(id: ThoughtId, mode: Mode, phase: Phase, text: &str) -> Thought {
    Thought {
        id,
        rev: Rev::ZERO,
        text: text.into(),
        strokes: Vec::new(),
        source: Source::Typed,
        mode,
        phase,
        status: phase.into(),
        reason: None,
        live: true,
        project_id: None,
        session_id: None,
        brief: None,
        agent: None,
        model: None,
        workdir: None,
        hold_until: None,
        read: false,
        created: Time::new(1).unwrap(),
        updated: Time::new(1).unwrap(),
    }
}

fn note(text: &str) -> Thought {
    thought(ThoughtId::mint(), Mode::Note, Phase::Captured, text)
}

/// Done and read: finished, so only the newest 200 are live.
fn finished(id: ThoughtId, text: &str) -> Thought {
    Thought {
        read: true,
        ..thought(id, Mode::Ask, Phase::Done, text)
    }
}

fn glance(working: u32) -> Glance {
    Glance {
        rev: Rev::ZERO,
        working,
        needs_you: 0,
        done: 0,
        question: None,
        retiring: false,
    }
}

fn wall() -> u64 {
    let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH);
    since.unwrap().as_millis() as u64
}

fn row(value: &impl serde::Serialize) -> Value {
    serde_json::to_value(value).unwrap()
}

#[test]
fn two_subscribers_see_the_same_changes_in_order_with_no_gap() {
    let data = Folder::new();
    let core = Core::start(&data);
    let (mut a, mut b) = (core.device(), core.device());
    let (sa, sb) = (subscribe(&mut a, &ALL), subscribe(&mut b, &ALL));
    assert_eq!((sa.rev, &sa.model), (sb.rev, &sb.model));

    let mut w = core.device();
    let p = project("tasktap");
    fixture(&mut w, vec![projects(vec![p.clone()])]);
    let mut last = Rev::ZERO;
    for i in 0..30 {
        last = match i % 3 {
            0 => hold(&mut w, i),
            1 => put(&mut w, layout(p.id, json!({ "i": i })), None).unwrap(),
            _ => put(&mut w, rename(p.id, &format!("p{i}")), None).unwrap(),
        };
    }
    let (ca, cb) = (until(&mut a, last), until(&mut b, last));
    assert_eq!(ca, cb);
    let revs: Vec<u64> = ca.iter().map(|c| c.rev.get()).collect();
    assert_eq!(revs, (sa.rev.get() + 1..=last.get()).collect::<Vec<_>>());

    // Snapshot plus changes is what a fresh snapshot holds.
    let mut model = sa.model;
    let fresh = subscribe(&mut core.device(), &ALL);
    for c in ca.iter().chain(&until(&mut a, fresh.rev)) {
        model.apply(&c.sets);
    }
    assert_eq!(model, fresh.model);
}

#[test]
fn a_subscriber_that_joins_during_writes_misses_and_doubles_nothing() {
    const ROUNDS: usize = 100;
    let data = Folder::new();
    let core = Core::start(&data);
    let mut w = core.device();
    let stop = AtomicBool::new(false);
    std::thread::scope(|s| {
        let writer = s.spawn(|| {
            let mut log = Vec::new();
            for i in 0.. {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                log.push((hold(&mut w, i), i));
            }
            log
        });
        let mut rounds = Vec::new();
        let mut c = core.device();
        for round in 0..ROUNDS {
            // Every other round subscribes again on the same connection,
            // which replaces the subscription it has.
            if round % 2 == 0 {
                c = core.device();
            }
            let snap = subscribe(&mut c, &[Collection::Prefs]);
            let changes: Vec<Change> = (0..1 + round % 4).map(|_| change(&mut c)).collect();
            rounds.push((snap.rev, snap.model, changes));
        }
        stop.store(true, Ordering::Relaxed);
        let log = writer.join().unwrap();

        for (rev, model, changes) in rounds {
            let held = model
                .get("prefs", PrefKey::Hold)
                .map(|r| r["value"].clone());
            let at = log.partition_point(|&(r, _)| r <= rev);
            let wrote = at.checked_sub(1).map(|i| json!(log[i].1));
            assert_eq!(held, wrote, "the snapshot at {rev:?}");
            assert!(log.len() - at >= changes.len());
            for (change, &(rev, i)) in changes.iter().zip(&log[at..]) {
                let put = vec![Pref {
                    value: PrefValue::Hold(i),
                    rev,
                }];
                let expected = vec![Set::Prefs(Rows { put, del: vec![] })];
                assert_eq!((change.rev, &change.sets), (rev, &expected));
            }
        }
    });
}

#[test]
fn a_subscriber_sees_only_the_collections_it_named() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut w = core.device();
    let p = project("a");
    fixture(&mut w, vec![projects(vec![p.clone()])]);
    hold(&mut w, 1);

    let mut prefs = core.device();
    let snap = subscribe(&mut prefs, &[Collection::Prefs]);
    assert_eq!(snap.model.0.len(), 1);
    assert!(snap.model.get("prefs", PrefKey::Hold).is_some());
    let mut layouts = core.device();
    // A collection named twice counts once.
    let named = [Collection::Layouts, Collection::Glance, Collection::Layouts];
    let snap = subscribe(&mut layouts, &named);
    assert_eq!(snap.model.0.len(), 1);
    assert_eq!(snap.model.get("glance", ""), Some(&row(&glance(0))));
    let mut notes = core.device();
    subscribe(&mut notes, &[Collection::Thoughts]);
    let mut ended = core.device();
    subscribe(&mut ended, &[Collection::Prefs]);
    // An empty list ends the subscription.
    subscribe(&mut ended, &[]);

    let r1 = hold(&mut w, 5);
    let r2 = put(&mut w, layout(p.id, json!([1, 2])), None).unwrap();
    let renamed = Project {
        name: "b".into(),
        ..p.clone()
    };
    // One change that touches two collections reaches `notes` cut to one.
    let both = vec![projects(vec![renamed]), thoughts(vec![note("n")])];
    let r5 = fixture(&mut w, both);
    // A working thought: `glance` follows it at the next revision.
    let working = thought(ThoughtId::mint(), Mode::Ask, Phase::Working, "w");
    let r3 = fixture(&mut w, vec![thoughts(vec![working])]);
    let r4 = hold(&mut w, 6);

    // The next change: its revision and the collections it touches.
    let seen = |c: &mut Client| {
        let next = change(c);
        let named: Vec<String> = next.sets.iter().map(|s| row(s)["c"].to_string()).collect();
        (next.rev, named.join(","))
    };
    assert_eq!(seen(&mut prefs), (r1, r#""prefs""#.into()));
    assert_eq!(seen(&mut prefs), (r4, r#""prefs""#.into()));
    assert_eq!(seen(&mut layouts), (r2, r#""layouts""#.into()));
    let rg = Rev::new(r3.get() + 1).unwrap();
    assert_eq!(seen(&mut layouts), (rg, r#""glance""#.into()));
    assert_eq!(seen(&mut notes), (r5, r#""thoughts""#.into()));
    assert_eq!(seen(&mut notes), (r3, r#""thoughts""#.into()));
    // Nothing else was sent: subscribing again finds no change queued before it.
    for c in [&mut prefs, &mut layouts, &mut notes, &mut ended] {
        assert!(subscribe(c, &[Collection::Prefs]).before.is_empty());
    }
}

#[test]
fn a_device_that_connects_again_writes_and_sends_nothing() {
    let data = Folder::new();
    let core = Core::start(&data);
    let id = DeviceId::mint();
    drop(core.connect(id, Some("laptop")));
    let mut s = core.device();
    let before = subscribe(&mut s, &ALL);

    drop(core.connect(id, None));
    drop(core.connect(id, None));
    let after = subscribe(&mut s, &ALL);
    assert!(after.before.is_empty(), "{:?}", after.before);
    assert_eq!((after.rev, after.model), (before.rev, before.model));

    // A day later the next connect records it once.
    let day = 24 * 60 * 60 * 1000;
    let now = Time::new(wall() + day + 1000).unwrap();
    let clock = call::FixtureClock::request(CallId(7), &FixtureClock { now });
    s.send(&clock).unwrap();
    assert!(matches!(
        s.recv().unwrap(),
        Frame::Control(Control::Reply(_))
    ));
    drop(core.connect(id, None));
    let Set::Devices(rows) = one(&mut s, Rev::new(after.rev.get() + 1).unwrap()) else {
        panic!("expected the device");
    };
    assert_eq!((rows.put[0].id, rows.put[0].last_seen), (id, Some(now)));
}

#[test]
fn put_writes_each_plain_collection_and_the_writer_sees_its_own_change() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut w = core.device();
    let p = project("tasktap");
    let n = note("first");
    fixture(
        &mut w,
        vec![projects(vec![p.clone()]), thoughts(vec![n.clone()])],
    );
    let mut s = core.device();
    subscribe(&mut s, &ALL);
    subscribe(&mut w, &ALL);
    fn both(s: &mut Client, w: &mut Client, rev: Rev) -> Set {
        let set = one(s, rev);
        // The writer's change arrived before its reply, like everyone's.
        assert_eq!(one(w, rev), set);
        set
    }

    let r = hold(&mut w, 30);
    let put_ = vec![Pref {
        value: PrefValue::Hold(30),
        rev: r,
    }];
    assert_eq!(
        both(&mut s, &mut w, r),
        Set::Prefs(Rows {
            put: put_,
            del: vec![]
        })
    );

    let tree = json!({ "split": "row", "tabs": ["a", "b"] });
    let r = put(&mut w, layout(p.id, tree.clone()), None).unwrap();
    let put_ = vec![tasktap_proto::Layout {
        id: p.id,
        rev: r,
        tree,
    }];
    assert_eq!(
        both(&mut s, &mut w, r),
        Set::Layouts(Rows {
            put: put_,
            del: vec![]
        })
    );

    let patch = ProjectPatch {
        name: Some("renamed".into()),
        color: Some("red".into()),
        aliases: Some(vec!["tt".into()]),
        isolate: Some(Isolate::Never),
    };
    let r = put(&mut w, PutTarget::Projects { id: p.id, patch }, None).unwrap();
    let edited = Project {
        rev: r,
        name: "renamed".into(),
        color: "red".into(),
        aliases: vec!["tt".into()],
        isolate: Isolate::Never,
        ..p.clone()
    };
    let put_ = vec![edited.clone()];
    assert_eq!(
        both(&mut s, &mut w, r),
        Set::Projects(Rows {
            put: put_,
            del: vec![]
        })
    );
    // A field left out stays as it is.
    let r = put(&mut w, rename(p.id, "again"), None).unwrap();
    let edited = Project {
        rev: r,
        name: "again".into(),
        ..edited
    };
    let put_ = vec![edited.clone()];
    assert_eq!(
        both(&mut s, &mut w, r),
        Set::Projects(Rows {
            put: put_,
            del: vec![]
        })
    );

    let strokes = vec![vec![[1.0, 2.0], [3.5, 4.5]]];
    let patch = NotePatch {
        text: Some("second".into()),
        strokes: Some(strokes.clone()),
    };
    let r = put(&mut w, PutTarget::Thoughts { id: n.id, patch }, None).unwrap();
    let Set::Thoughts(Rows { put: got, del }) = both(&mut s, &mut w, r) else {
        panic!("not a thought")
    };
    assert!(del.is_empty());
    let edited_note = Thought {
        rev: r,
        text: "second".into(),
        strokes,
        updated: got[0].updated,
        ..n.clone()
    };
    assert_eq!(got, std::slice::from_ref(&edited_note));
    assert!(got[0].updated > n.updated);

    let fresh = subscribe(&mut core.device(), &ALL);
    assert_eq!(fresh.model.get("projects", p.id), Some(&row(&edited)));
    assert_eq!(fresh.model.get("thoughts", n.id), Some(&row(&edited_note)));
    let hold_row = fresh.model.get("prefs", PrefKey::Hold).unwrap();
    assert_eq!(hold_row["value"], 30);
    assert_eq!(
        fresh.model.get("layouts", p.id).unwrap()["tree"]["split"],
        "row"
    );
}

#[test]
fn put_refuses_what_is_not_plain_data_and_writes_nothing() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut w = core.device();
    let p = project("a");
    let n = note("a note");
    let t = thought(ThoughtId::mint(), Mode::Ask, Phase::Working, "a task");
    fixture(
        &mut w,
        vec![
            projects(vec![p.clone()]),
            thoughts(vec![n.clone(), t.clone()]),
        ],
    );
    let mut s = core.device();
    let before = subscribe(&mut s, &ALL);

    let (pid, nid, tid) = (p.id, n.id, t.id);
    let too_large = "x".repeat(300 << 10);
    let puts = [
        // Fields the state machine owns, beside editable ones or alone.
        (
            json!({"c": "projects", "id": pid, "patch": {"folder": "/elsewhere"}}),
            Code::Invalid,
        ),
        (
            json!({"c": "projects", "id": pid, "patch": {"name": "ok", "open": false}}),
            Code::Invalid,
        ),
        (
            json!({"c": "thoughts", "id": nid, "patch": {"phase": "done"}}),
            Code::Invalid,
        ),
        (
            json!({"c": "thoughts", "id": nid, "patch": {"text": "ok", "mode": "ask"}}),
            Code::Invalid,
        ),
        (
            json!({"c": "layouts", "id": pid, "patch": {"tree": {}, "rev": 1}}),
            Code::Invalid,
        ),
        // A thought that is not a note belongs to the state machine.
        (
            json!({"c": "thoughts", "id": tid, "patch": {"text": "mine now"}}),
            Code::Invalid,
        ),
        (
            json!({"c": "sessions", "id": SessionId::mint(), "patch": {"state": "ended"}}),
            Code::Invalid,
        ),
        (
            json!({"c": "glance", "patch": {"working": 1}}),
            Code::Invalid,
        ),
        (
            json!({"c": "prefs", "id": "hold", "patch": "soon"}),
            Code::Invalid,
        ),
        (
            json!({"c": "prefs", "id": "no_such_pref", "patch": 1}),
            Code::Invalid,
        ),
        (
            json!({"c": "layouts", "id": pid, "patch": {"tree": too_large}}),
            Code::Invalid,
        ),
        (
            json!({"c": "projects", "id": ProjectId::mint(), "patch": {"name": "x"}}),
            Code::Gone,
        ),
        (
            json!({"c": "thoughts", "id": ThoughtId::mint(), "patch": {"text": "x"}}),
            Code::Gone,
        ),
        (
            json!({"c": "layouts", "id": ProjectId::mint(), "patch": {"tree": {}}}),
            Code::Gone,
        ),
    ];
    for (args, code) in puts {
        assert_eq!(
            refused(raw(&mut w, "put", args.clone())),
            code,
            "put {args}"
        );
    }
    let deletes = [
        (json!({"c": "thoughts", "id": tid}), Code::Invalid),
        (json!({"c": "projects", "id": pid}), Code::Invalid),
        (
            json!({"c": "thoughts", "id": ThoughtId::mint()}),
            Code::Gone,
        ),
    ];
    for (args, code) in deletes {
        assert_eq!(
            refused(raw(&mut w, "delete", args.clone())),
            code,
            "delete {args}"
        );
    }

    let after = subscribe(&mut s, &ALL);
    assert!(after.before.is_empty(), "{:?}", after.before);
    assert_eq!((after.rev, after.model), (before.rev, before.model));
}

#[test]
fn if_rev_writes_only_over_the_revision_the_caller_saw() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut w = core.device();
    let p = project("a");
    let n = note("a note");
    let at = fixture(
        &mut w,
        vec![projects(vec![p.clone()]), thoughts(vec![n.clone()])],
    );
    let mut s = core.device();
    subscribe(&mut s, &ALL);
    let hold_at = |seconds| PutTarget::Prefs(PrefPatch::Hold(seconds));

    let r1 = hold(&mut w, 1);
    let r2 = put(&mut w, hold_at(2), Some(r1)).unwrap();
    assert_eq!(put(&mut w, hold_at(3), Some(r1)), Err(Code::Conflict));
    // A row that is not stored yet is at revision 0.
    let r3 = put(&mut w, layout(p.id, json!(1)), Some(Rev::ZERO)).unwrap();
    assert_eq!(
        put(&mut w, layout(p.id, json!(2)), Some(Rev::ZERO)),
        Err(Code::Conflict)
    );
    let r4 = put(&mut w, layout(p.id, json!(3)), Some(r3)).unwrap();
    assert_eq!(
        put(&mut w, rename(p.id, "x"), Some(Rev::ZERO)),
        Err(Code::Conflict)
    );
    let r5 = put(&mut w, rename(p.id, "y"), Some(at)).unwrap();
    assert_eq!(
        put(&mut w, rename(p.id, "z"), Some(at)),
        Err(Code::Conflict)
    );
    let r6 = put(&mut w, retext(n.id, "kept"), Some(at)).unwrap();
    assert_eq!(
        put(&mut w, retext(n.id, "lost"), Some(at)),
        Err(Code::Conflict)
    );

    let revs: Vec<Rev> = until(&mut s, r6).iter().map(|c| c.rev).collect();
    assert_eq!(revs, [r1, r2, r3, r4, r5, r6]);
    let fresh = subscribe(&mut s, &ALL).model;
    assert_eq!(fresh.get("prefs", PrefKey::Hold).unwrap()["value"], 2);
    assert_eq!(fresh.get("layouts", p.id).unwrap()["tree"], 3);
    assert_eq!(fresh.get("projects", p.id).unwrap()["name"], "y");
    assert_eq!(fresh.get("thoughts", n.id).unwrap()["text"], "kept");
}

#[test]
fn delete_restores_a_default_and_removes_a_note() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut w = core.device();
    let p = project("a");
    let n = note("a note");
    let t = thought(ThoughtId::mint(), Mode::Ask, Phase::Captured, "a task");
    fixture(
        &mut w,
        vec![
            projects(vec![p.clone()]),
            thoughts(vec![n.clone(), t.clone()]),
        ],
    );
    hold(&mut w, 9);
    put(&mut w, layout(p.id, json!({})), None).unwrap();
    let mut s = core.device();
    let snap = subscribe(&mut s, &ALL);
    assert_eq!(snap.model.get("prefs", PrefKey::Hold).unwrap()["value"], 9);

    let r = delete(&mut w, Delete::Prefs { id: PrefKey::Hold }).unwrap();
    let del = vec![PrefKey::Hold];
    assert_eq!(one(&mut s, r), Set::Prefs(Rows { put: vec![], del }));
    // At its default already: deleting again writes nothing and names the
    // current revision; a write that expects the default (revision 0) succeeds.
    assert_eq!(delete(&mut w, Delete::Prefs { id: PrefKey::Hold }), Ok(r));
    let hold_at = PutTarget::Prefs(PrefPatch::Hold(4));
    let r = put(&mut w, hold_at, Some(Rev::ZERO)).unwrap();
    assert!(matches!(one(&mut s, r), Set::Prefs(_)));

    let r = delete(&mut w, Delete::Layouts { id: p.id }).unwrap();
    assert_eq!(
        one(&mut s, r),
        Set::Layouts(Rows {
            put: vec![],
            del: vec![p.id]
        })
    );
    let r = delete(&mut w, Delete::Thoughts { id: n.id }).unwrap();
    assert_eq!(
        one(&mut s, r),
        Set::Thoughts(Rows {
            put: vec![],
            del: vec![n.id]
        })
    );
    assert_eq!(
        delete(&mut w, Delete::Thoughts { id: n.id }),
        Err(Code::Gone)
    );
    assert_eq!(
        delete(&mut w, Delete::Thoughts { id: t.id }),
        Err(Code::Invalid)
    );

    let fresh = subscribe(&mut s, &ALL);
    assert!(fresh.before.is_empty());
    assert_eq!(fresh.model.get("prefs", PrefKey::Hold).unwrap()["value"], 4);
    assert_eq!(fresh.model.count("layouts"), 0);
    assert!(fresh.model.get("thoughts", n.id).is_none());
    assert!(fresh.model.get("thoughts", t.id).is_some());
}

#[test]
fn a_note_edit_is_stamped_with_the_cores_clock() {
    let mut s = common::Scene::new("note-clock");
    let id = ThoughtId::mint();
    let note = tasktap_proto::Capture {
        mode: Some(Mode::Note),
        ..common::typed(id, "milk")
    };
    s.w.ok::<call::ThoughtCapture>(&note);
    // A minute ahead of the wall clock.
    s.tick(60_000);
    let put = Put {
        target: retext(id, "oat milk"),
        if_rev: None,
    };
    s.w.ok::<call::Put>(&put);
    assert_eq!(s.w.model.thought(id).updated, common::time(s.now));
}

#[test]
fn a_thought_leaving_the_live_set_is_a_delete_and_then_history() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut w = core.device();
    let mut ids: Vec<ThoughtId> = (0..201).map(|_| ThoughtId::mint()).collect();
    ids.sort();
    let (oldest, newest) = (ids[0], ids[200]);
    let result = TurnResult {
        id: ResultId::mint(),
        rev: Rev::ZERO,
        thought_id: oldest,
        session_id: None,
        turn: Some(1),
        kind: ResultKind::Answer,
        summary: "done".into(),
    };
    let first = ids[..200].iter().map(|&id| finished(id, "x")).collect();
    let results = Set::Results(Rows {
        put: vec![result.clone()],
        del: vec![],
    });
    fixture(&mut w, vec![thoughts(first), results]);
    let mut s = core.device();
    let snap = subscribe(&mut s, &[Collection::Thoughts, Collection::Results]);
    assert_eq!(snap.model.count("thoughts"), 200);
    assert!(snap.model.get("results", result.id).is_some());

    // The 201st finished thought pushes the oldest out.
    let rev = fixture(&mut w, vec![thoughts(vec![finished(newest, "y")])]);
    let next = change(&mut s);
    assert_eq!(next.rev, rev);
    let [Set::Thoughts(t), Set::Results(r)] = &next.sets[..] else {
        panic!("{next:?}")
    };
    assert_eq!(t.put.iter().map(|t| t.id).collect::<Vec<_>>(), [newest]);
    assert_eq!(t.del, [oldest]);
    assert_eq!((r.put.len(), &r.del[..]), (0, &[result.id][..]));

    let page = w.call::<call::History>(&History {
        before: None,
        limit: Limit::new(10).unwrap(),
    });
    let page = page.unwrap().unwrap();
    assert_eq!(
        page.thoughts.iter().map(|t| t.id).collect::<Vec<_>>(),
        [oldest]
    );
    assert!(!page.thoughts[0].live);
    assert_eq!(
        page.results.iter().map(|r| r.id).collect::<Vec<_>>(),
        [result.id]
    );
    let fresh = subscribe(&mut s, &[Collection::Thoughts]);
    assert_eq!(fresh.model.count("thoughts"), 200);
    assert!(fresh.model.get("thoughts", oldest).is_none());
}

#[test]
fn history_pages_newest_first_with_no_duplicates_or_holes() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut w = core.device();
    let mut ids: Vec<ThoughtId> = (0..330).map(|_| ThoughtId::mint()).collect();
    ids.sort();
    // The 130 oldest leave the live set; their long texts make a page of
    // 100 too large for one chunk, so pages are cut by size as well.
    let long = "x".repeat(4 << 10);
    let rows: Vec<Thought> = ids
        .iter()
        .enumerate()
        .map(|(i, &id)| finished(id, if i < 130 { &long } else { "short" }))
        .collect();
    for batch in rows.chunks(100) {
        fixture(&mut w, vec![thoughts(batch.to_vec())]);
    }
    let mut left = ids[..130].to_vec();
    left.reverse();

    for limit in [100, 7] {
        let (mut seen, mut before, mut cut) = (Vec::new(), None, false);
        loop {
            let page = history(&mut w, before, limit);
            let Some(last) = page.last() else { break };
            cut |= (page.len() as u32) < limit && seen.len() + page.len() < left.len();
            before = Some(last.id);
            seen.extend(page.iter().map(|t| t.id));
            assert!(seen.len() <= left.len(), "pages repeat");
        }
        assert_eq!(seen, left, "limit {limit}");
        assert_eq!(cut, limit == 100, "limit {limit}");
    }
    for limit in [0, 101] {
        let args = json!({ "limit": limit });
        assert_eq!(refused(raw(&mut w, "history", args)), Code::Invalid);
    }
}

#[test]
fn a_large_snapshot_arrives_in_chunks_and_whole() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut w = core.device();
    let ps: Vec<Project> = (0..12).map(|i| project(&format!("p{i}"))).collect();
    fixture(&mut w, vec![projects(ps.clone())]);
    let trees: Vec<Value> = (0..12)
        .map(|i| json!({ "i": i, "pad": "y".repeat(100 << 10) }))
        .collect();
    for (p, tree) in ps.iter().zip(&trees) {
        put(&mut w, layout(p.id, tree.clone()), None).unwrap();
    }

    let snap = subscribe(&mut core.device(), &ALL);
    assert!(snap.frames.len() >= 5, "{} chunks", snap.frames.len());
    for frame in &snap.frames {
        let mut bytes = Vec::new();
        encode_control(&Control::Change(frame.clone()), &mut bytes).unwrap();
        assert!(
            bytes.len() - HEADER <= CHUNK,
            "a chunk of {} bytes",
            bytes.len()
        );
    }
    assert_eq!(
        snap.model.count("projects"),
        12 + 1,
        "and the scratch project"
    );
    for (p, tree) in ps.iter().zip(&trees) {
        assert_eq!(snap.model.get("layouts", p.id).unwrap()["tree"], *tree);
    }
}

#[test]
fn a_change_larger_than_a_frame_arrives_whole_in_chunks_of_one_revision() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut w = core.device();
    // Six finished thoughts of 200 KiB each, out of the live set behind 200
    // newer finished ones. No call is over a frame.
    let big: Vec<Thought> = (0..6)
        .map(|i| finished(ThoughtId::mint(), &format!("{i}").repeat(200 << 10)))
        .collect();
    for t in &big {
        fixture(&mut w, vec![thoughts(vec![t.clone()])]);
    }
    let newer: Vec<Thought> = (0..200)
        .map(|i| finished(ThoughtId::mint(), &format!("new {i}")))
        .collect();
    fixture(&mut w, vec![thoughts(newer.clone())]);
    let mut s = core.device();
    let mut model = subscribe(&mut s, &ALL).model;
    assert!(model.get("thoughts", big[0].id).is_none());
    let mut late = core.device();

    // Unread, the newer ones are no longer finished, so one small write
    // brings the six back: a change of more than a frame.
    let unread = newer.into_iter().map(|t| Thought { read: false, ..t });
    let rev = fixture(&mut w, vec![thoughts(unread.collect())]);
    let after = hold(&mut w, 1);

    let changes = until(&mut s, after);
    let chunks = changes.iter().filter(|c| c.rev == rev).count();
    assert!(chunks >= 6, "{chunks} chunks");
    for change in &changes {
        let mut bytes = Vec::new();
        encode_control(&Control::Change(change.clone()), &mut bytes).unwrap();
        let len = bytes.len() - HEADER;
        assert!(len <= CHUNK, "a chunk of {len} bytes");
        model.apply(&change.sets);
    }
    assert!(big.iter().all(|t| model.get("thoughts", t.id).is_some()));
    assert_eq!(model, subscribe(&mut late, &ALL).model);
}

#[test]
fn a_subscriber_that_stops_reading_is_dropped_and_the_others_get_everything() {
    const WRITES: usize = 80;
    let data = Folder::new();
    let core = Core::start(&data);
    let mut w = core.device();
    let p = project("a");
    fixture(&mut w, vec![projects(vec![p.clone()])]);
    let mut stalled = core.device();
    subscribe(&mut stalled, &ALL);
    let mut reader = core.device();
    let snap = subscribe(&mut reader, &ALL);

    let changes = std::thread::scope(|s| {
        let reading = s.spawn(|| {
            let mut changes = Vec::new();
            loop {
                let next = change(&mut reader);
                let end = row(&next.sets)[0]["put"][0]["value"] == u32::MAX;
                changes.push(next);
                if end {
                    return changes;
                }
            }
        });
        // 16 MB in all, twice what one connection may have queued.
        for i in 0..WRITES {
            let tree = json!({ "i": i, "pad": "z".repeat(200 << 10) });
            put(&mut w, layout(p.id, tree), None).unwrap();
        }
        hold(&mut w, u32::MAX);
        reading.join().unwrap()
    });
    let revs: Vec<u64> = changes.iter().map(|c| c.rev.get()).collect();
    let expected: Vec<u64> = (snap.rev.get() + 1..).take(WRITES + 1).collect();
    assert_eq!(revs, expected);

    // What the socket held arrives, then the connection ends.
    let mut got = 0;
    let end = loop {
        match stalled.recv() {
            Ok(_) => got += 1,
            Err(e) => break e,
        }
    };
    assert!(
        matches!(
            end.kind(),
            ErrorKind::UnexpectedEof | ErrorKind::ConnectionReset
        ),
        "{end}"
    );
    assert!(got < WRITES, "the stalled subscriber got {got} frames");
}

#[test]
fn a_client_that_reconnects_gets_a_correct_fresh_snapshot() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut w = core.device();
    let p = project("a");
    let n = note("a note");
    fixture(
        &mut w,
        vec![projects(vec![p.clone()]), thoughts(vec![n.clone()])],
    );
    let mut watcher = core.device();
    let mut model = subscribe(&mut watcher, &ALL).model;

    let mut away = core.device();
    let first = subscribe(&mut away, &ALL);
    let r = hold(&mut w, 1);
    one(&mut away, r);
    drop(away);
    hold(&mut w, 2);
    put(&mut w, layout(p.id, json!(["x"])), None).unwrap();
    put(&mut w, rename(p.id, "renamed"), None).unwrap();
    delete(&mut w, Delete::Thoughts { id: n.id }).unwrap();

    let mut back = core.device();
    let fresh = subscribe(&mut back, &ALL);
    assert!(fresh.rev > first.rev);
    for c in until(&mut watcher, fresh.rev) {
        model.apply(&c.sets);
    }
    assert_eq!(fresh.model, model);
    assert_eq!(fresh.model.get("prefs", PrefKey::Hold).unwrap()["value"], 2);
    assert_eq!(
        fresh.model.get("projects", p.id).unwrap()["name"],
        "renamed"
    );
    assert!(fresh.model.get("thoughts", n.id).is_none());
}

#[test]
fn memory_rows_start_over_on_restart_while_stored_rows_and_the_revision_go_on() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut w = core.device();
    let mut s = core.device();
    let snap = subscribe(&mut s, &ALL);
    assert_eq!(snap.model.get("glance", ""), Some(&row(&glance(0))));

    // `glance` follows the rows: three working, one that needs you, two done and unread.
    let mut ts: Vec<Thought> = (0..3)
        .map(|_| thought(ThoughtId::mint(), Mode::Ask, Phase::Working, "w"))
        .collect();
    ts.push(Thought {
        status: Status::NeedsYou,
        ..thought(ThoughtId::mint(), Mode::Ask, Phase::Working, "q")
    });
    ts.extend((0..2).map(|_| thought(ThoughtId::mint(), Mode::Ask, Phase::Done, "d")));
    let rt = fixture(&mut w, vec![thoughts(ts)]);
    assert!(matches!(one(&mut s, rt), Set::Thoughts(_)));
    let rg = Rev::new(rt.get() + 1).unwrap();
    let sent = Glance {
        rev: rg,
        needs_you: 1,
        done: 2,
        ..glance(3)
    };
    assert_eq!(
        one(&mut s, rg),
        Set::Glance {
            put: vec![sent.clone()]
        }
    );
    // A write that leaves the counts as they were takes no revision for `glance`.
    let rp = hold(&mut w, 12);
    assert_eq!(
        rp.get(),
        rg.get() + 1,
        "memory and stored rows share one counter"
    );
    assert!(matches!(one(&mut s, rp), Set::Prefs(_)));
    let fresh = subscribe(&mut core.device(), &ALL);
    assert_eq!(fresh.model.get("glance", ""), Some(&row(&sent)));

    core.stop();
    let core = Core::start(&data);
    let mut c = core.device();
    let after = subscribe(&mut c, &ALL);
    // Counted again from the stored rows, in which recovery failed the working ones.
    let g: Glance = serde_json::from_value(after.model.get("glance", "").unwrap().clone()).unwrap();
    assert_eq!(
        Glance {
            rev: Rev::ZERO,
            ..g
        },
        Glance {
            done: 2,
            ..glance(0)
        }
    );
    let hold_row = json!({ "id": "hold", "value": 12, "rev": rp });
    assert_eq!(after.model.get("prefs", PrefKey::Hold), Some(&hold_row));
    assert!(after.rev >= rp);
    let next = hold(&mut c, 13);
    assert!(next > after.rev);
    assert_eq!(
        one(&mut c, next),
        Set::Prefs(Rows {
            put: vec![Pref {
                value: PrefValue::Hold(13),
                rev: next,
            }],
            del: vec![],
        })
    );
}
