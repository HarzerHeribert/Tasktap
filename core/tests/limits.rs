//! Bounds (design §1, §2): no row a client can be sent is larger than one
//! snapshot chunk. The protocol crate bounds what a call may write into a
//! row; a call over a bound is `invalid`, writes nothing and disturbs no
//! subscriber, and the largest row of every collection still goes out whole.

mod common;

use common::*;
use serde_json::Value;
use std::collections::BTreeMap;
use tasktap_core::client::Client;
use tasktap_proto::call::{self, Call, Code, Error};
use tasktap_proto::{
    AnswerQuestion, Ask, Capture, Change, Control, DeviceId, Empty, Event as Said, FixtureRecords,
    Frame, HEADER, Identity, Layout, LayoutPatch, MAX_FRAME, MAX_LINE, MAX_POINTS, MAX_TEXT, Place,
    Project, ProjectId, ProjectKind, ProjectPatch, Put, PutTarget, QuestionKind, Response,
    ResultId, Route, Rows, Set, Stroke, Subscribe, Thought, ThoughtId, encode_control, json_len,
};

/// Most bytes of JSON in one snapshot chunk (design §1).
const CHUNK: usize = 256 << 10;
/// Most bytes of JSON in a row: a chunk, less its envelope and a set's.
const MAX_ROW: usize = CHUNK - 64 - 32;

/// A text of exactly `n` bytes of JSON, quotes included.
fn text(n: usize) -> String {
    "x".repeat(n - 2)
}

/// The same, mostly control characters, which take six bytes each.
fn escaped(n: usize) -> String {
    let control = (n - 2) / 6;
    "\u{1}".repeat(control) + &"x".repeat(n - 2 - control * 6)
}

/// Choices of exactly `n` bytes of JSON together.
fn choices(n: usize) -> Vec<String> {
    vec!["Yes".into(), text(n - 8)]
}

/// The most points, each its own stroke at the longest a number is written.
fn strokes() -> Vec<Stroke> {
    vec![vec![[-2.2250738585072014e-308; 2]]; MAX_POINTS]
}

fn largest_ask(request: &str) -> Ask {
    Ask {
        request: request.into(),
        kind: QuestionKind::Choice {
            choices: choices(MAX_LINE),
        },
        prompt: escaped(MAX_LINE),
        detail: Some(escaped(MAX_TEXT)),
        source: None,
    }
}

/// Makes a call that must be refused as `invalid`. Afterwards nothing was
/// written, the other subscriber is still connected and was sent nothing,
/// and a new subscription gets every row.
fn refused(s: &mut Scene, other: &mut Watch, call: impl FnOnce(&mut Scene) -> Error) {
    other.sync();
    let rev = other.model.rev;
    let e = call(s);
    assert_eq!(e.code, Code::Invalid, "{e}");
    s.w.sync();
    other.sync();
    assert_eq!(other.model.rev, rev, "a refused call sent a change");
    assert_eq!(other.model, s.w.model);
    // The new subscriber's device is a change too.
    let fresh = s.core.watch();
    s.w.sync();
    assert_eq!(fresh.model, s.w.model);
}

#[test]
fn a_capture_at_the_bound_reaches_a_subscriber_whole_and_one_over_is_refused() {
    let mut s = Scene::new("limit-capture");
    let mut other = s.core.watch();
    let at = Capture {
        strokes: strokes(),
        ..typed(ThoughtId::mint(), &escaped(MAX_TEXT))
    };
    s.w.ok::<call::ThoughtCapture>(&at);
    other.sync();
    let row = other.model.thought(at.id);
    assert_eq!((&row.text, &row.strokes), (&at.text, &at.strokes));

    let over_text = typed(ThoughtId::mint(), &text(MAX_TEXT + 1));
    // The case that once dropped every subscriber: a row too large to send.
    let near_frame = typed(ThoughtId::mint(), &text(MAX_FRAME - 1024));
    let mut over_strokes = typed(ThoughtId::mint(), "drawn");
    over_strokes.strokes = vec![vec![[1.0, 2.0]]; MAX_POINTS - 1];
    // An empty stroke counts as a point.
    over_strokes.strokes.extend([vec![], vec![]]);
    for over in [over_text, near_frame, over_strokes] {
        refused(&mut s, &mut other, |s| {
            s.w.refused::<call::ThoughtCapture>(&over)
        });
    }
}

#[test]
fn no_write_stores_a_row_larger_than_a_chunk_as_it_would_be_sent() {
    let mut s = Scene::new("limit-commit");
    let mut other = s.core.watch();
    // The next write's revision has more digits than the 0 in the row a
    // call builds, so a layout row measured that way at the bound would be
    // stored one byte over it.
    let mut next = 0;
    while next < 10 {
        let hold = PutTarget::Prefs(tasktap_proto::PrefPatch::Hold(next as u32));
        next = put(&mut s, hold).unwrap().rev.get() + 1;
    }
    let id = s.project;
    let row = |n: usize| Layout {
        id,
        rev: tasktap_proto::Rev::new(next).unwrap(),
        tree: Value::String(text(n)),
    };
    let n = MAX_ROW + 1 - (json_len(&row(2)) - 2);
    assert_eq!(json_len(&row(n)), MAX_ROW + 1);
    let layout = |n: usize| PutTarget::Layouts {
        id,
        patch: LayoutPatch {
            tree: Value::String(text(n)),
        },
    };
    assert_eq!(put(&mut s, layout(n)).unwrap_err(), Code::Invalid);
    // One byte less is taken, at the revision the refused write did not use.
    assert_eq!(put(&mut s, layout(n - 1)).unwrap().rev.get(), next);

    // A path that bounds nothing itself, the test fixture, is refused too.
    let t = s.capture("short");
    let mut over = s.w.model.thought(t).clone();
    over.text = text(MAX_ROW);
    let sets = vec![Set::Thoughts(Rows {
        put: vec![over],
        del: Vec::new(),
    })];
    refused(&mut s, &mut other, |s| {
        s.w.refused::<call::FixtureRecords>(&FixtureRecords { sets })
    });
}

#[test]
fn the_largest_question_and_answer_are_taken_whole_and_larger_ones_refused() {
    let mut s = Scene::new("limit-question");
    let (_, _, mut agent) = s.launch("Fix the failing build");
    let mut other = s.core.watch();
    let largest = largest_ask("largest");
    let overs = [
        Ask {
            prompt: text(MAX_LINE + 1),
            ..largest.clone()
        },
        Ask {
            detail: Some(text(MAX_TEXT + 1)),
            ..largest.clone()
        },
        Ask {
            kind: QuestionKind::Choice {
                choices: choices(MAX_LINE + 1),
            },
            ..largest.clone()
        },
    ];
    // Asked to wait on the core, or reported as asked in the terminal.
    for over in overs {
        refused(&mut s, &mut other, |_| {
            agent.ask_now(over.clone()).unwrap_err()
        });
        let said = Said::Question { question: over };
        refused(&mut s, &mut other, |_| agent.try_say(said).unwrap_err());
    }

    agent.ask_with(largest.clone());
    let q = s.shown();
    other.sync();
    let row = other.model.question(q);
    assert_eq!((&row.kind, &row.prompt), (&largest.kind, &largest.prompt));
    assert_eq!(row.detail, largest.detail);

    let answer = |text| AnswerQuestion {
        id: q,
        response: Response::Text { text },
    };
    let over = answer(text(MAX_TEXT + 1));
    refused(&mut s, &mut other, |s| {
        s.w.refused::<call::QuestionAnswer>(&over)
    });

    let at = answer(escaped(MAX_TEXT));
    s.w.ok::<call::QuestionAnswer>(&at);
    assert_eq!(agent.reply("largest").unwrap().response, at.response);
    other.sync();
    let stored = other.model.question(q).answer.as_ref().unwrap();
    assert_eq!(stored.response, at.response);
    let fresh = s.core.watch();
    other.sync();
    assert_eq!(fresh.model, other.model);
}

/// Every row a subscriber holds, by collection and id, as JSON.
type Seen = BTreeMap<(String, String), Value>;

/// Takes changes until the reply to call `id`, checking that each frame is
/// within its bound: a chunk for a snapshot, a frame for a change.
fn take(c: &mut Client, rows: &mut Seen, id: u32) {
    loop {
        let change = match c.recv().unwrap() {
            Frame::Control(Control::Change(change)) => change,
            Frame::Control(Control::Reply(reply)) if reply.id.0 == id => return,
            other => panic!("unexpected {other:?}"),
        };
        let mut bytes = Vec::new();
        encode_control(&Control::Change(change.clone()), &mut bytes).unwrap();
        let (len, most) = (
            bytes.len() - HEADER,
            if change.snap { CHUNK } else { MAX_FRAME },
        );
        assert!(
            len <= most,
            "a frame of {len} bytes, where {most} is the most"
        );
        apply(rows, &change);
    }
}

fn apply(rows: &mut Seen, change: &Change) {
    for set in &change.sets {
        let set = serde_json::to_value(set).unwrap();
        let c = set["c"].as_str().unwrap().to_owned();
        for row in set["put"].as_array().into_iter().flatten() {
            rows.insert((c.clone(), row["id"].to_string()), row.clone());
        }
        for id in set["del"].as_array().into_iter().flatten() {
            rows.remove(&(c.clone(), id.to_string()));
        }
    }
}

fn key(id: impl serde::Serialize) -> String {
    serde_json::to_value(id).unwrap().to_string()
}

fn subscribe(c: &mut Client) -> Seen {
    let sub = Subscribe {
        collections: ALL.to_vec(),
    };
    c.send(&call::Sub::request(tasktap_proto::CallId(1), &sub))
        .unwrap();
    let mut rows = Seen::new();
    take(c, &mut rows, 1);
    rows
}

/// Takes what was sent so far: the core answers a call after it.
fn drain(c: &mut Client, rows: &mut Seen) {
    c.send(&call::CoreStatus::request(
        tasktap_proto::CallId(2),
        &Empty {},
    ))
    .unwrap();
    take(c, rows, 2);
}

fn put(s: &mut Scene, target: PutTarget) -> Result<tasktap_proto::Revision, Code> {
    let put = Put {
        target,
        if_rev: None,
    };
    s.w.call::<call::Put>(&put).map_err(|e| e.code)
}

#[test]
fn the_largest_row_of_every_collection_goes_out_in_a_snapshot_and_a_change() {
    let mut s = Scene::new("limit-largest");
    // The longest folder a project takes; no file system has one that long.
    let p = ProjectId::mint();
    let project = Project {
        id: p,
        rev: tasktap_proto::Rev::ZERO,
        name: "p".into(),
        folder: escaped(MAX_LINE),
        kind: ProjectKind::Folder,
        color: String::new(),
        aliases: Vec::new(),
        git: false,
        isolate: tasktap_proto::Isolate::Never,
        open: true,
        available: true,
    };
    let projects = Set::Projects(Rows {
        put: vec![project],
        del: Vec::new(),
    });
    let records = FixtureRecords {
        sets: vec![projects],
    };
    s.w.ok::<call::FixtureRecords>(&records);
    let patch = ProjectPatch {
        name: Some(escaped(MAX_LINE)),
        color: Some(escaped(MAX_LINE)),
        aliases: Some(vec![escaped(MAX_LINE - 2)]),
        isolate: None,
    };
    put(&mut s, PutTarget::Projects { id: p, patch }).unwrap();
    // The largest layout `put` takes; its last accepted write stays.
    let (mut taken, mut refused) = (0, CHUNK);
    while refused - taken > 1 {
        let n = (taken + refused) / 2;
        let tree = Value::String(text(n));
        let layout = PutTarget::Layouts {
            id: p,
            patch: LayoutPatch { tree },
        };
        match put(&mut s, layout) {
            Ok(_) => taken = n,
            Err(code) => (refused = n, assert_eq!(code, Code::Invalid)).0,
        }
    }

    let mut first = s.core.device();
    let mut seen = subscribe(&mut first);

    // A device with the longest name.
    let d = DeviceId::mint();
    let device = s.core.device_as(d, 2, Some(&escaped(MAX_LINE))).unwrap();
    assert_eq!(device.welcome.identity, Identity::Device);

    // The largest thought: the longest text, the most strokes and the
    // router's longest brief. Another, picked by the person, starts with its
    // whole text as the prompt in its terminal.
    let a = ThoughtId::mint();
    let picked = Capture {
        strokes: strokes(),
        project_id: Some(p),
        ..typed(a, &escaped(MAX_TEXT))
    };
    s.w.ok::<call::ThoughtCapture>(&picked);
    let brief = escaped(MAX_LINE);
    s.script(
        Route::Clear {
            to: Place::Project(p),
            brief,
        },
        None,
    );
    let b = ThoughtId::mint();
    let routed = Capture {
        strokes: strokes(),
        ..typed(b, &escaped(MAX_TEXT))
    };
    s.w.ok::<call::ThoughtCapture>(&routed);
    s.tick(HOLD_MS);
    drain(&mut first, &mut seen);

    // The largest session: the longest folder, every activity line at its
    // longest, the longest error; the largest question, answer and result.
    let session = s.w.model.thought(a).session_id.unwrap();
    let mut agent = s.agent(session);
    agent.ready();
    agent.begin();
    for _ in 0..50 {
        agent.say(Said::Activity {
            text: "\u{1}".repeat(300),
        });
    }
    drain(&mut first, &mut seen);
    agent.ask_with(largest_ask("largest"));
    let q = s.shown();
    let answer = AnswerQuestion {
        id: q,
        response: Response::Text {
            text: escaped(MAX_TEXT),
        },
    };
    s.w.ok::<call::QuestionAnswer>(&answer);
    agent.reply("largest").unwrap();
    agent.finish(&("\u{1}".repeat(300) + "\nand the rest"));
    agent.say(Said::TurnStarted {
        prompt: Some(escaped(MAX_TEXT)),
    });
    agent.say(Said::TurnFailed {
        error: Some(escaped(MAX_LINE)),
    });
    s.w.sync();
    drain(&mut first, &mut seen);

    // One change carrying the largest thoughts, project and result together.
    let m = &s.w.model;
    let thought = m.thought(b).clone();
    let copies = (0..3).map(|_| Thought {
        id: ThoughtId::mint(),
        ..thought.clone()
    });
    let mut result = m.results_of(a)[0].clone();
    result.id = ResultId::mint();
    let sets = vec![
        Set::Thoughts(Rows {
            put: [thought.clone()].into_iter().chain(copies).collect(),
            del: Vec::new(),
        }),
        Set::Projects(Rows {
            put: vec![m.projects[&p].clone()],
            del: Vec::new(),
        }),
        Set::Results(Rows {
            put: vec![result],
            del: Vec::new(),
        }),
    ];
    s.w.ok::<call::FixtureRecords>(&FixtureRecords { sets });
    drain(&mut first, &mut seen);

    let mut late = s.core.device();
    let snapshot = subscribe(&mut late);
    drain(&mut first, &mut seen);
    assert_eq!(snapshot, seen);
    // Each collection holds its largest row, whole.
    let m = &s.w.model;
    let largest = [
        ("thoughts", key(b)),
        ("projects", key(p)),
        ("sessions", key(session)),
        ("terminals", key(m.session(session).terminal_id)),
        ("questions", key(q)),
        ("results", key(m.results_of(a)[0].id)),
        ("layouts", key(p)),
        ("devices", key(d)),
    ];
    for (c, id) in largest {
        assert!(snapshot.contains_key(&(c.to_owned(), id)), "no {c} row");
    }
    let s_row = m.session(session);
    assert_eq!(s_row.activity.len(), 40);
    assert!(s_row.activity.iter().all(|l| l.chars().count() == 200));
    assert_eq!(s_row.error.as_deref(), Some(escaped(MAX_LINE).as_str()));
    assert_eq!(m.results_of(a)[0].summary, "\u{1}".repeat(200));
    assert_eq!(
        m.thought(b).brief.as_deref(),
        Some(escaped(MAX_LINE).as_str())
    );
    let layout = &snapshot[&("layouts".to_owned(), key(p))];
    assert_eq!(layout["tree"], Value::String(text(taken)));
}
