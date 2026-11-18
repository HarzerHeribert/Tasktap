//! Records (design §1): each test starts the real binary on its own folder
//! and watches it through `client.rs`, as a page would. Rows that only the
//! state machine writes come from the binary's test-only `fixture.records`.

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::sync::atomic::{AtomicBool, Ordering};
use tasktap_core::client::Client;
use tasktap_proto::call::{self, Call, Code};
use tasktap_proto::{
    Answer, CallId, Change, Collection, Control, Delete, DeviceId, FixtureClock, FixtureRecords,
    Frame, Glance, HEADER, History, Isolate, LayoutPatch, Limit, Mode, NotePatch, Phase, Pref,
    PrefKey, PrefPatch, PrefValue, Project, ProjectId, ProjectKind, ProjectPatch, Put, PutTarget,
    Question, QuestionId, QuestionKind, QuestionSource, QuestionState, ReplyVia, Response,
    ResultId, ResultKind, Rev, Rows, SessionId, Set, Source, Status, Subscribe, Thought, ThoughtId,
    Time, TurnResult, encode_control,
};

mod common;

use common::*;

/// Most bytes of JSON in one snapshot chunk (design §1).
const CHUNK: usize = 256 << 10;

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
    let after = None;
    let page = c.call::<call::History>(&History {
        before,
        after,
        limit,
    });
    page.unwrap().unwrap().thoughts
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
        route: None,
        placed: None,
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
        failed: 0,
        question: None,
        retiring: false,
    }
}

fn row(value: &impl serde::Serialize) -> Value {
    serde_json::to_value(value).unwrap()
}

#[test]
fn two_subscribers_see_the_same_changes_in_order_with_no_gap() {
    let data = Folder::new("tr");
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
    let data = Folder::new("tr");
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
    let data = Folder::new("tr");
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
    let data = Folder::new("tr");
    let core = Core::start(&data);
    let id = DeviceId::mint();
    drop(core.device_as(id, 1, Some("laptop")).unwrap());
    let mut s = core.device();
    let before = subscribe(&mut s, &ALL);

    drop(core.device_as(id, 1, None).unwrap());
    drop(core.device_as(id, 1, None).unwrap());
    let after = subscribe(&mut s, &ALL);
    assert!(after.before.is_empty(), "{:?}", after.before);
    assert_eq!((after.rev, after.model), (before.rev, before.model));

    // A day later the next connect records it once.
    let day = 24 * 60 * 60 * 1000;
    let now = Time::new(wall_ms() + day + 1000).unwrap();
    let clock = call::FixtureClock::request(CallId(7), &FixtureClock { now });
    s.send(&clock).unwrap();
    assert!(matches!(
        s.recv().unwrap(),
        Frame::Control(Control::Reply(_))
    ));
    drop(core.device_as(id, 1, None).unwrap());
    let Set::Devices(rows) = one(&mut s, Rev::new(after.rev.get() + 1).unwrap()) else {
        panic!("expected the device");
    };
    assert_eq!((rows.put[0].id, rows.put[0].last_seen), (id, Some(now)));
}

#[test]
fn put_writes_each_plain_collection_and_the_writer_sees_its_own_change() {
    let data = Folder::new("tr");
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
    let data = Folder::new("tr");
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
    for (args, want) in puts {
        assert_eq!(code(raw(&mut w, "put", args.clone())), want, "put {args}");
    }
    let deletes = [
        (json!({"c": "thoughts", "id": tid}), Code::Invalid),
        (json!({"c": "projects", "id": pid}), Code::Invalid),
        (
            json!({"c": "thoughts", "id": ThoughtId::mint()}),
            Code::Gone,
        ),
    ];
    for (args, want) in deletes {
        assert_eq!(
            code(raw(&mut w, "delete", args.clone())),
            want,
            "delete {args}"
        );
    }

    let after = subscribe(&mut s, &ALL);
    assert!(after.before.is_empty(), "{:?}", after.before);
    assert_eq!((after.rev, after.model), (before.rev, before.model));
}

/// The settings the redesigned Settings sheet needed a preference for,
/// through the binary: each takes a value, shows it to a subscriber, keeps
/// it across a restart, refuses what is not one in a sentence and leaves the
/// row as it was, and is at its default again once deleted.
#[test]
fn the_settings_preferences_are_stored_refused_in_a_sentence_and_restored_by_delete() {
    let data = Folder::new("tr");
    let core = Core::start(&data);
    let mut w = core.device();
    let key = json!({"control": false, "alt": true, "shift": true, "meta": false, "code": "KeyK"});
    let held = |control: bool, code: &str| json!({"control": control, "alt": false, "shift": false, "meta": false, "code": code});
    let settings = [
        ("return_sends", json!(false)),
        ("capture_key", key.clone()),
        ("talk_key", held(true, "Space")),
        ("keep_days", json!(30)),
        ("terminal_bold_bright", json!(false)),
        ("terminal_contrast", json!(false)),
        ("text_size", json!("small")),
    ];
    for (id, value) in &settings {
        let args = json!({"c": "prefs", "id": id, "patch": value});
        assert!(
            matches!(raw(&mut w, "put", args), tasktap_proto::Outcome::Ok(_)),
            "{id}"
        );
    }
    let stored = |c: &mut Client| {
        let snap = subscribe(c, &[Collection::Prefs]);
        let value = |id: &str| snap.model.get("prefs", id).map(|row| row["value"].clone());
        settings.clone().map(|(id, _)| value(id))
    };
    let wanted = settings.clone().map(|(_, value)| Some(value));
    assert_eq!(stored(&mut w), wanted);

    // What is refused, with the sentence the interface shows.
    let said = |c: &mut Client, id: &str, patch: Value| match raw(
        c,
        "put",
        json!({"c": "prefs", "id": id, "patch": patch}),
    ) {
        tasktap_proto::Outcome::Err(e) => (e.code, e.message),
        ok => panic!("{id} took {ok:?}"),
    };
    let invalid = |why: &str| (Code::Invalid, why.to_owned());
    for id in ["capture_key", "talk_key"] {
        for (patch, why) in [
            (held(false, "Space"), tasktap_proto::Shortcut::BARE),
            (held(true, "Hyper"), tasktap_proto::Shortcut::NO_KEY),
            (held(true, "Escape"), tasktap_proto::Shortcut::RESERVED),
            (
                json!({"control": true, "alt": true, "shift": false, "meta": false, "code": "KeyY"}),
                tasktap_proto::Shortcut::ANSWERS,
            ),
        ] {
            assert_eq!(said(&mut w, id, patch), invalid(why), "{id}");
        }
        assert_eq!(said(&mut w, id, json!("Control+Space")).0, Code::Invalid);
    }
    assert_eq!(
        said(&mut w, "keep_days", json!(3651)),
        invalid("Finished thoughts are kept for 1 to 3650 days, or for ever with 0")
    );
    for (id, patch) in [
        ("return_sends", json!("always")),
        ("keep_days", json!(-1)),
        ("terminal_bold_bright", json!(1)),
        ("terminal_contrast", json!(null)),
        ("text_size", json!("huge")),
    ] {
        assert_eq!(said(&mut w, id, patch).0, Code::Invalid, "{id}");
    }
    assert_eq!(stored(&mut w), wanted, "a refused value changed a row");

    // None is a value: the system's own key again.
    let unset = json!({"c": "prefs", "id": "capture_key", "patch": null});
    assert!(matches!(
        raw(&mut w, "put", unset),
        tasktap_proto::Outcome::Ok(_)
    ));
    let restored = json!({"c": "prefs", "id": "capture_key", "patch": key});
    assert!(matches!(
        raw(&mut w, "put", restored),
        tasktap_proto::Outcome::Ok(_)
    ));

    drop(w);
    core.stop();
    let core = Core::start(&data);
    let mut w = core.device();
    assert_eq!(stored(&mut w), wanted, "after a restart");
    for (id, _) in &settings {
        let deleted = raw(&mut w, "delete", json!({"c": "prefs", "id": id}));
        assert!(matches!(deleted, tasktap_proto::Outcome::Ok(_)), "{id}");
    }
    assert_eq!(stored(&mut w), settings.clone().map(|_| None));
}

/// `keep_days` as the core starts: what is older than the person keeps it
/// goes before the first client is answered, with its results; what is
/// newer, unread or kept for ever stays. Setting the limit removed nothing.
#[test]
fn a_core_that_starts_prunes_what_is_older_than_the_limit_before_anyone_sees_it() {
    const DAY: u64 = 24 * 60 * 60 * 1000;
    let data = Folder::new("tr");
    let core = Core::start(&data);
    let mut w = core.device();
    let aged = |days: u64, read: bool| Thought {
        read,
        updated: Time::new(wall_ms() - days * DAY).unwrap(),
        ..finished(ThoughtId::mint(), "long ago")
    };
    let (old, edge, new, unread) = (
        aged(40, true),
        aged(29, true),
        aged(1, true),
        aged(40, false),
    );
    let result = TurnResult {
        id: ResultId::mint(),
        rev: Rev::ZERO,
        thought_id: old.id,
        session_id: None,
        turn: None,
        kind: ResultKind::Answer,
        summary: "Done.".into(),
    };
    let all = vec![old.clone(), edge.clone(), new.clone(), unread.clone()];
    let results = Set::Results(Rows {
        put: vec![result.clone()],
        del: Vec::new(),
    });
    fixture(&mut w, vec![thoughts(all), results]);
    let keep = |days| PutTarget::Prefs(PrefPatch::KeepDays(days));
    put(&mut w, keep(30), None).unwrap();
    let there = |c: &mut Client| {
        let snap = subscribe(c, &ALL);
        let has = |t: &Thought| snap.model.get("thoughts", t.id).is_some();
        let result = snap.model.get("results", result.id).is_some();
        ([&old, &edge, &new, &unread].map(has), result)
    };
    assert_eq!(
        there(&mut w),
        ([true; 4], true),
        "nothing goes when the limit is set"
    );

    drop(w);
    core.stop();
    let core = Core::start(&data);
    let mut w = core.device();
    assert_eq!(there(&mut w), ([false, true, true, true], false));
    let page = History {
        before: None,
        after: None,
        limit: Limit::MAX,
    };
    let history = w.call::<call::History>(&page).unwrap().unwrap();
    assert!(history.thoughts.is_empty() && history.results.is_empty());

    // Kept for ever again, a start removes nothing, however old.
    delete(
        &mut w,
        Delete::Prefs {
            id: PrefKey::KeepDays,
        },
    )
    .unwrap();
    drop(w);
    core.stop();
    let core = Core::start(&data);
    let mut w = core.device();
    assert_eq!(there(&mut w), ([false, true, true, true], false));
    // With 28 days kept, the next start takes the one of 29 days ago too.
    put(&mut w, keep(28), None).unwrap();
    drop(w);
    core.stop();
    let core = Core::start(&data);
    let mut w = core.device();
    assert_eq!(there(&mut w), ([false, false, true, true], false));
}

#[test]
fn if_rev_writes_only_over_the_revision_the_caller_saw() {
    let data = Folder::new("tr");
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
    let data = Folder::new("tr");
    let core = Core::start(&data);
    let mut w = core.device();
    let p = project("a");
    let n = note("a note");
    // Working: the state machine's, not plain data.
    let t = thought(ThoughtId::mint(), Mode::Ask, Phase::Working, "a task");
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
    let mut s = Scene::new("note-clock");
    let id = ThoughtId::mint();
    let note = tasktap_proto::Capture {
        mode: Some(Mode::Note),
        ..typed(id, "milk")
    };
    s.w.ok::<call::ThoughtCapture>(&note);
    // A minute ahead of the wall clock.
    s.tick(60_000);
    let put = Put {
        target: retext(id, "oat milk"),
        if_rev: None,
    };
    s.w.ok::<call::Put>(&put);
    assert_eq!(s.w.model.thought(id).updated, time(s.now));
}

#[test]
fn a_thought_leaving_the_live_set_is_a_delete_and_then_history() {
    let data = Folder::new("tr");
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
        after: None,
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
    let data = Folder::new("tr");
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
        assert_eq!(code(raw(&mut w, "history", args)), Code::Invalid);
    }
}

#[test]
fn history_pages_the_questions_and_results_of_a_thought_that_do_not_fit_one_reply() {
    let data = Folder::new("tr");
    let core = Core::start(&data);
    let mut w = core.device();
    let (older, many) = (ThoughtId::mint(), ThoughtId::mint());
    fixture(
        &mut w,
        vec![thoughts(vec![
            finished(older, "older"),
            finished(many, "many"),
        ])],
    );
    // Six answered questions and six results of about 128 KiB, taking
    // turns: 1.5 MB, more than a frame.
    let long = |i: usize| format!("{}", i % 10).repeat(64 << 10);
    let mut rows = Vec::new();
    for i in 0..12 {
        let set = if i % 2 == 0 {
            let q = Question {
                id: QuestionId::mint(),
                rev: Rev::ZERO,
                thought_id: Some(many),
                session_id: None,
                turn: None,
                source: QuestionSource::Agent,
                kind: QuestionKind::Text,
                places: None,
                prompt: "?".into(),
                detail: Some(long(i)),
                reply_via: ReplyVia::Core,
                state: QuestionState::Answered,
                answer: Some(Answer {
                    response: Response::Text { text: long(i + 1) },
                    device_id: None,
                    created: Time::new(1).unwrap(),
                    delivered: None,
                }),
            };
            rows.push(q.id.uuid());
            Set::Questions(Rows {
                put: vec![q],
                del: vec![],
            })
        } else {
            let r = TurnResult {
                id: ResultId::mint(),
                rev: Rev::ZERO,
                thought_id: many,
                session_id: None,
                turn: None,
                kind: ResultKind::Answer,
                summary: long(i).repeat(2),
            };
            rows.push(r.id.uuid());
            Set::Results(Rows {
                put: vec![r],
                del: vec![],
            })
        };
        fixture(&mut w, vec![set]);
    }
    let newer = (0..200).map(|_| finished(ThoughtId::mint(), "newer"));
    fixture(&mut w, vec![thoughts(newer.collect())]);

    // Each page fits a frame; one cut among the rows of `many` says where
    // the next goes on, which brings the rest once each and in order, then
    // the older thought.
    let (mut before, mut after) = (None, None);
    let (mut got, mut seen, mut cut) = (Vec::new(), Vec::new(), 0);
    loop {
        let limit = Limit::MAX;
        let ask = History {
            before,
            after,
            limit,
        };
        let page = w.call::<call::History>(&ask).unwrap().unwrap();
        if page.thoughts.is_empty() && page.questions.is_empty() && page.results.is_empty() {
            break;
        }
        let mut ids: Vec<_> = (page.questions.iter().map(|q| q.id.uuid()))
            .chain(page.results.iter().map(|r| r.id.uuid()))
            .collect();
        ids.sort();
        seen.extend(ids);
        got.extend(page.thoughts.iter().map(|t| t.id));
        before = page.thoughts.last().map(|t| t.id).or(before);
        after = page.after;
        cut += usize::from(after.is_some());
    }
    assert_eq!(got, [many, older]);
    assert_eq!(seen, rows);
    assert!(cut >= 5, "{cut} pages cut among the rows");
}

#[test]
fn a_large_snapshot_arrives_in_chunks_and_whole() {
    let data = Folder::new("tr");
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
    let (last, before) = snap.frames.split_last().unwrap();
    assert!(before.iter().all(|f| f.more) && !last.more);
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
fn a_change_larger_than_a_frame_arrives_in_parts_of_one_revision_the_last_unmarked() {
    let data = Folder::new("tr");
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
    let mut watch = Watch::new(core.device());
    let mut late = core.device();
    let mut s = core.device();
    let mut model = subscribe(&mut s, &ALL).model;
    assert!(model.get("thoughts", big[0].id).is_none());

    // Unread, the newer ones are no longer finished, so one small write
    // brings the six back: a change of more than a frame.
    let unread = newer.into_iter().map(|t| Thought { read: false, ..t });
    let rev = fixture(&mut w, vec![thoughts(unread.collect())]);

    // Its parts come in a row, each but the last marked `more`: no later
    // write is needed to tell where it ends.
    let mut parts: Vec<Change> = Vec::new();
    while parts.last().is_none_or(|part| part.more) {
        let part = change(&mut s);
        assert_eq!(part.rev, rev);
        let mut bytes = Vec::new();
        encode_control(&Control::Change(part.clone()), &mut bytes).unwrap();
        let len = bytes.len() - HEADER;
        assert!(len <= CHUNK, "a part of {len} bytes");
        model.apply(&part.sets);
        parts.push(part);
    }
    assert!(parts.len() >= 6, "{} parts", parts.len());
    assert!(big.iter().all(|t| model.get("thoughts", t.id).is_some()));
    // `glance` follows in a change of its own.
    let fresh = subscribe(&mut late, &ALL);
    for c in until(&mut s, fresh.rev) {
        model.apply(&c.sets);
    }
    assert!(model == fresh.model);
    // The shared model applies it whole, once its last part is in.
    watch.until("the six are back", |m| {
        big.iter().all(|t| m.thoughts.contains_key(&t.id))
    });
    assert_eq!(watch.model.rev, rev.get());
}

#[test]
fn a_snapshot_larger_than_the_queue_bound_reaches_a_slow_reader_with_every_change_after_it() {
    let data = Folder::new("tr");
    let core = Core::start(&data);
    let mut w = core.device();
    // 160 finished thoughts of 200 KiB: 32 MiB live, four times what may be
    // queued for one connection.
    let big: Vec<Thought> = (0..160)
        .map(|i| finished(ThoughtId::mint(), &format!("{}", i % 10).repeat(200 << 10)))
        .collect();
    for batch in big.chunks(4) {
        fixture(&mut w, vec![thoughts(batch.to_vec())]);
    }
    let mut late = core.device();
    let mut slow = core.device();
    let id = CallId(u32::MAX);
    let sub = Subscribe {
        collections: ALL.to_vec(),
    };
    slow.send(&call::Sub::request(id, &sub)).unwrap();
    let mut model = Model::default();
    let Frame::Control(Control::Change(first)) = slow.recv().unwrap() else {
        panic!("no snapshot")
    };
    model.apply(&first.sets);

    // The snapshot is taken. While the reader reads nothing more, a writer goes on.
    let written: Vec<Rev> = (0..50).map(|i| hold(&mut w, i)).collect();

    // Then it gets the whole snapshot, its reply, and every change after
    // it, once each and in order.
    let mut chunks = 1;
    loop {
        match slow.recv().unwrap() {
            Frame::Control(Control::Change(c)) => {
                assert!(
                    c.snap && c.rev == first.rev,
                    "{:?} inside the snapshot",
                    c.rev
                );
                model.apply(&c.sets);
                chunks += 1;
            }
            Frame::Control(Control::Reply(reply)) if reply.id == id => {
                assert_eq!(call::Sub::result(reply.outcome).unwrap().rev, first.rev);
                break;
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    assert!(chunks >= 128, "{chunks} chunks");
    assert_eq!(model.count("thoughts"), big.len());
    let changes = until(&mut slow, *written.last().unwrap());
    let revs: Vec<Rev> = changes.iter().map(|c| c.rev).collect();
    assert_eq!(revs, written);
    for c in &changes {
        model.apply(&c.sets);
    }
    assert!(model == subscribe(&mut late, &ALL).model);
}

#[test]
fn a_subscriber_that_stops_reading_is_dropped_and_the_others_get_everything() {
    const WRITES: usize = 80;
    let data = Folder::new("tr");
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
    let data = Folder::new("tr");
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
    let data = Folder::new("tr");
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
    // Counted again from the stored rows, in which recovery failed the four
    // working ones, unread.
    let g: Glance = serde_json::from_value(after.model.get("glance", "").unwrap().clone()).unwrap();
    assert_eq!(
        Glance {
            rev: Rev::ZERO,
            ..g
        },
        Glance {
            done: 2,
            failed: 4,
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
