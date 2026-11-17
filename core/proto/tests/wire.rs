//! The committed samples, every call through the codec, and the call table.

mod common;

use common::{answer, decoded, encoded, id, question, result, rev, samples, thought, time};
use serde_json::json;
use std::fmt::Debug;
use std::path::Path;
use tasktap_proto::*;

/// The bootstrap contract: these samples may never change.
const FROZEN: [&str; 7] = [
    "hello.json",
    "welcome.json",
    "refuse.json",
    "call-core.status.json",
    "reply-core.status.json",
    "call-core.retire.json",
    "reply-core.retire.json",
];

/// A JSON sample is the exact payload plus one newline; `data.bin` is a whole
/// frame. `BLESS=1` writes a missing sample but never rewrites one: changing a
/// sample means deleting it on purpose.
#[test]
fn samples_match_byte_for_byte() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("samples");
    let bless = std::env::var_os("BLESS").is_some();
    let samples = samples();
    assert!(
        FROZEN
            .iter()
            .all(|name| samples.iter().any(|(sample, _)| sample == name))
    );
    for (name, frame) in samples {
        let path = dir.join(name);
        let frame_bytes = encoded(&frame);
        let file = match &frame {
            Frame::Control(_) => [&frame_bytes[HEADER..], b"\n"].concat(),
            Frame::Data(_) => frame_bytes.clone(),
        };
        if bless && !path.exists() {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(&path, &file).unwrap();
        }
        let committed =
            std::fs::read(&path).unwrap_or_else(|_| panic!("{name} is missing: run with BLESS=1"));
        assert!(committed == file, "{name} no longer matches its sample");
        let payload = committed.strip_suffix(b"\n").unwrap_or(&committed);
        let whole = match &frame {
            Frame::Control(_) => [
                &(payload.len() as u32 + 1).to_le_bytes()[..],
                &[KIND_CONTROL],
                payload,
            ]
            .concat(),
            Frame::Data(_) => committed.clone(),
        };
        assert_eq!(decoded(&whole), frame, "{name} decodes to its value");
    }
}

/// Sends the call and its reply through the codec and back to typed values.
fn round_trip<C: Call>(args: C::Args, result: C::Result, seen: &mut Vec<Name>)
where
    C::Args: PartialEq + Debug,
    C::Result: PartialEq + Debug + Clone,
{
    let Frame::Control(Control::Call(request)) =
        decoded(&encoded(&Frame::Control(C::request(CallId(5), &args))))
    else {
        panic!("not a call")
    };
    assert_eq!(Name::parse(&request.name), Some(C::NAME));
    assert_eq!(C::args(request.args).unwrap(), args);
    let Frame::Control(Control::Reply(reply)) = decoded(&encoded(&Frame::Control(C::reply(
        CallId(5),
        Ok(result.clone()),
    )))) else {
        panic!("not a reply")
    };
    assert_eq!(reply.id, CallId(5));
    assert_eq!(C::result(reply.outcome).unwrap(), result);
    seen.push(C::NAME);
}

#[test]
fn every_call_round_trips() {
    let seen = &mut Vec::new();
    let at = Revision { rev: rev(42) };
    round_trip::<call::Sub>(
        Subscribe {
            collections: vec![Collection::Thoughts, Collection::Glance],
        },
        at,
        seen,
    );
    for target in [
        PutTarget::Prefs(PrefPatch::Hold(0)),
        PutTarget::Layouts {
            id: id(2),
            patch: LayoutPatch {
                tree: json!({"split": "column"}),
            },
        },
        PutTarget::Projects {
            id: id(2),
            patch: ProjectPatch {
                name: Some("Tasktap".into()),
                isolate: Some(Isolate::Always),
                ..Default::default()
            },
        },
        PutTarget::Thoughts {
            id: id(1),
            patch: NotePatch {
                text: Some("Buy milk".into()),
                strokes: None,
            },
        },
    ] {
        round_trip::<call::Put>(
            Put {
                target,
                if_rev: None,
            },
            at,
            seen,
        );
    }
    for target in [
        Delete::Prefs { id: PrefKey::Hold },
        Delete::Layouts { id: id(2) },
        Delete::Thoughts { id: id(1) },
        Delete::Terminals { id: id(4) },
    ] {
        round_trip::<call::Delete>(target, at, seen);
    }
    let after = Some(question().id.uuid());
    let page = HistoryPage {
        thoughts: vec![thought()],
        questions: vec![question()],
        results: vec![result()],
        after,
    };
    round_trip::<call::History>(
        History {
            before: Some(id(1)),
            after,
            limit: Limit::MAX,
        },
        page,
        seen,
    );
    let capture = Capture {
        id: id(1),
        text: "Note to self".into(),
        strokes: vec![vec![[1.5, 2.25]]],
        source: Source::Typed,
        mode: Some(Mode::Note),
        project_id: None,
        session_id: Some(id(3)),
        agent: None,
        model: Some("sonnet".into()),
        current: Some(id(4)),
    };
    round_trip::<call::ThoughtCapture>(capture, (), seen);
    round_trip::<call::ThoughtUpdate>(
        Assign {
            id: id(1),
            project_id: id(2),
        },
        (),
        seen,
    );
    round_trip::<call::ThoughtStart>(
        Start {
            id: id(1),
            attempt: id(11),
        },
        (),
        seen,
    );
    round_trip::<call::ThoughtStop>(Ref { id: id(1) }, (), seen);
    round_trip::<call::ThoughtRetry>(Ref { id: id(1) }, (), seen);
    round_trip::<call::ThoughtSettle>(
        Settle {
            id: id(1),
            attempt: id(12),
            keep: true,
        },
        (),
        seen,
    );
    round_trip::<call::ThoughtRead>(Ref { id: id(1) }, (), seen);
    for kind in [
        QuestionKind::Confirm,
        QuestionKind::Text,
        QuestionKind::Choice {
            choices: vec!["A".into()],
        },
    ] {
        let ask = Ask {
            request: "r".into(),
            kind,
            prompt: "Go on?".into(),
            detail: Some("Deletes build/".into()),
            source: None,
        };
        round_trip::<call::QuestionAsk>(ask, answer(), seen);
    }
    for response in [
        Response::Affirm,
        Response::Deny,
        Response::Choice { choice: 0 },
        Response::Text {
            text: "Use a header".into(),
        },
    ] {
        round_trip::<call::QuestionAnswer>(
            AnswerQuestion {
                id: id(5),
                response,
            },
            (),
            seen,
        );
    }
    round_trip::<call::QuestionWithdraw>(
        AskKey {
            request: "r".into(),
        },
        (),
        seen,
    );
    round_trip::<call::QuestionReceived>(
        AskKey {
            request: "r".into(),
        },
        (),
        seen,
    );
    round_trip::<call::QuestionFocus>(Ref { id: id(5) }, (), seen);
    for event in [
        Event::Ready,
        Event::TurnStarted {
            prompt: Some("Also fix the logout".into()),
        },
        Event::Activity {
            text: "Editing src/login.ts".into(),
        },
        Event::Continued { request: None },
        Event::Continued {
            request: Some("PermissionRequest:1:2".into()),
        },
        Event::TurnFinished { answer: None },
        Event::TurnFailed {
            error: Some("rate limited".into()),
        },
        Event::TurnInterrupted,
        Event::Exited { code: Some(130) },
        Event::Question {
            question: Ask {
                request: "call-7".into(),
                kind: QuestionKind::Confirm,
                prompt: "Allow rm?".into(),
                detail: None,
                source: None,
            },
        },
    ] {
        round_trip::<call::SessionEvent>(
            SessionEvent {
                id: "e".into(),
                turn: Some(2),
                subagent: true,
                event,
                resume: None,
            },
            (),
            seen,
        );
    }
    let adopt = Adopt {
        agent: "claude".into(),
        cwd: "/Users/someone/tasktap".into(),
    };
    round_trip::<call::SessionAdopt>(adopt, id(3), seen);
    let hint = Hint {
        text: "fix the header in folio".into(),
        current: Some(id(3)),
    };
    let route = Route::Clear {
        to: Place::Project(id(2)),
        brief: "fix the header in folio".into(),
    };
    round_trip::<call::RouteHint>(hint, route, seen);
    let health = AgentHealth {
        id: "codex".into(),
        rev: rev(7),
        checked: time(42),
        installed: true,
        version: Some("0.169.0".into()),
        signed_in: Some(true),
        identity: Some("ChatGPT".into()),
        events: true,
        resume: true,
        permissions: Some(ReplyVia::Core),
        questions: Some(ReplyVia::Terminal),
    };
    let detect = DetectAgents {
        agents: Some(vec!["codex".into()]),
    };
    let agents = Agents {
        agents: vec![health],
    };
    round_trip::<call::AgentsDetect>(detect, agents, seen);
    for (start, from) in [
        (None, None),
        (
            Some(StartTerminal {
                project: Some(id(2)),
                argv: vec!["claude".into(), "--".into(), "Fix it".into()],
                title: Some("Fix it".into()),
            }),
            Some(Offset::new(1 << 40).unwrap()),
        ),
    ] {
        let open = OpenTerminal {
            id: id(4),
            start,
            cols: 80,
            rows: 24,
            from,
            credit: 1 << 20,
        };
        let opened = Opened {
            s: StreamId(2),
            credit: 4096,
            from: Some(Offset::new(7).unwrap()),
        };
        round_trip::<call::TerminalOpen>(open, opened, seen);
    }
    let resize = ResizeTerminal {
        id: id(4),
        cols: 132,
        rows: 50,
    };
    round_trip::<call::TerminalResize>(resize, (), seen);
    round_trip::<call::TerminalStop>(Ref { id: id(4) }, (), seen);
    let add = AddProject {
        id: id(2),
        folder: "/Users/someone/tasktap".into(),
        name: None,
    };
    round_trip::<call::ProjectAdd>(add, id(2), seen);
    round_trip::<call::ProjectScan>(Empty {}, (), seen);
    round_trip::<call::ProjectClose>(
        CloseProject {
            id: id(2),
            stop: true,
        },
        (),
        seen,
    );
    for action in [Action::Affirm, Action::Deny] {
        round_trip::<call::Input>(
            Input {
                action,
                question: id(5),
            },
            (),
            seen,
        );
    }
    round_trip::<call::DeviceRevoke>(Ref { id: id(9) }, (), seen);
    let status = CoreStatus {
        build: "2.0.0".into(),
        v: Versions(1, 1),
        terminals: 0,
    };
    round_trip::<call::CoreStatus>(Empty {}, status, seen);
    round_trip::<call::CoreRetire>(Retire { when: When::Now }, (), seen);
    for (hold, stop) in [(true, false), (false, false), (false, true)] {
        round_trip::<call::ShimHold>(ShimHold { hold, stop }, (), seen);
    }
    let fixture = FixtureStream {
        credit: 7,
        send: Offset::new(1 << 40).unwrap(),
        receive: Offset::ZERO,
        chunk: 1,
        marks: vec![Offset::ZERO, Offset::new(9).unwrap()],
    };
    let opened = Opened {
        s: StreamId(3),
        credit: 0,
        from: None,
    };
    round_trip::<call::FixtureStream>(fixture, opened, seen);
    let to = Place::Project(id(2));
    for route in [
        Route::Clear {
            to,
            brief: "Fix it".into(),
        },
        Route::Ambiguous {
            prompt: "Where?".into(),
            candidates: vec![Candidate {
                label: "app".into(),
                to: Place::Session(id(3)),
            }],
        },
        Route::Unknown,
    ] {
        let log = FixtureLog {
            launched: vec![FixtureLaunch {
                thought: id(1),
                session: id(3),
                prompt: "Fix it".into(),
                token: Secret([9; 32]),
            }],
            ..FixtureLog::default()
        };
        let script = FixtureScript {
            route,
            refuse: Some("no".into()),
            unrecordable: true,
            pause: true,
            agent: Some("fixture".into()),
        };
        round_trip::<call::FixtureScript>(script, log, seen);
    }
    round_trip::<call::FixtureClock>(FixtureClock { now: time(5) }, (), seen);
    let sets = vec![Set::Thoughts(Rows {
        put: vec![thought()],
        del: vec![],
    })];
    round_trip::<call::FixtureRecords>(FixtureRecords { sets }, Revision { rev: rev(8) }, seen);

    seen.dedup();
    assert_eq!(seen.as_slice(), Name::ALL, "every call in table order");
    assert_eq!(Name::ALL.len(), 35);
}

#[test]
fn names_parse_back_and_unknown_names_do_not() {
    for &name in Name::ALL {
        assert_eq!(Name::parse(name.as_str()), Some(name));
    }
    assert_eq!(Name::parse("session.resume"), None);
    assert_eq!(Name::parse(""), None);
}

#[test]
fn access_follows_the_authorization_table() {
    let by = |access| {
        Name::ALL
            .iter()
            .filter(|name| name.access() == access)
            .map(|name| name.as_str())
            .collect::<Vec<_>>()
    };
    // With no shared version both bootstrap calls are anyone's (the core's
    // calls.rs); with one, retiring the core is a device's.
    assert_eq!(by(Access::Anyone), ["core.status"]);
    assert!(by(Access::Device).contains(&"core.retire"));
    assert_eq!(
        by(Access::Session),
        [
            "question.ask",
            "question.withdraw",
            "question.received",
            "session.event",
            "session.adopt"
        ]
    );
    assert_eq!(by(Access::Device).len(), 28);
    assert_eq!(by(Access::Ability), ["shim.hold"]);
    for (access, allowed) in [
        (Access::Anyone, [true, true, true]),
        (Access::Device, [true, false, false]),
        (Access::Session, [false, true, false]),
        (Access::Ability, [false, false, false]),
    ] {
        let who = [Identity::Device, Identity::Session, Identity::Anonymous];
        assert_eq!(who.map(|who| access.permits(who)), allowed, "{access:?}");
    }
}

#[test]
fn arguments_of_the_wrong_shape_are_invalid() {
    let err = call::ThoughtStart::args(json!({"id": "not an id"})).unwrap_err();
    assert_eq!(err.code, Code::Invalid);
    assert_eq!(
        call::History::args(json!({"limit": 0})).unwrap_err().code,
        Code::Invalid
    );
    assert_eq!(
        call::History::args(json!({"limit": 101})).unwrap_err().code,
        Code::Invalid
    );
    assert_eq!(
        call::History::args(json!({"limit": 100})).unwrap().limit,
        Limit::MAX
    );
    // A patch names only fields it has: the others belong to the state machine.
    let id: ProjectId = id(1);
    for (c, patch) in [
        ("projects", json!({"name": "ok", "open": false})),
        ("thoughts", json!({"text": "ok", "phase": "done"})),
        ("layouts", json!({"tree": {}, "rev": 1})),
    ] {
        let put = call::Put::args(json!({"c": c, "id": id, "patch": patch}));
        assert_eq!(put.unwrap_err().code, Code::Invalid, "{c}");
    }
}

#[test]
fn optional_arguments_may_be_left_out() {
    let capture = call::ThoughtCapture::args(
        json!({"id": id::<ThoughtId>(1), "text": "x", "source": "typed"}),
    )
    .unwrap();
    assert_eq!(
        (capture.mode, capture.project_id, capture.strokes.len()),
        (None, None, 0)
    );
    let put =
        call::Put::args(json!({"c": "projects", "id": id::<ProjectId>(2), "patch": {}})).unwrap();
    assert_eq!(put.if_rev, None);
    let fixture = call::FixtureStream::args(json!({"credit": 1, "chunk": 1})).unwrap();
    assert_eq!(
        (fixture.send, fixture.receive, fixture.marks.len()),
        (Offset::ZERO, Offset::ZERO, 0)
    );
}

#[test]
fn secrets_are_64_hex_digits_and_stay_out_of_logs() {
    let secret: Secret = serde_json::from_value(json!("AB".repeat(32))).unwrap();
    assert_eq!(secret, Secret([0xab; 32]));
    assert_eq!(
        serde_json::to_value(&secret).unwrap(),
        json!("ab".repeat(32))
    );
    assert!(serde_json::from_value::<Secret>(json!("ab".repeat(31))).is_err());
    assert!(serde_json::from_value::<Secret>(json!("zz".repeat(32))).is_err());
    assert_eq!(format!("{secret:?}"), "Secret(..)");
}

#[test]
fn the_shared_version_is_the_highest_in_both_ranges() {
    assert_eq!(Versions(1, 3).shared(Versions(2, 5)), 3);
    assert_eq!(Versions(1, 1).shared(Versions(1, 1)), 1);
    assert_eq!(Versions(1, 1).shared(Versions(2, 4)), NO_SHARED_VERSION);
}

/// An old core still reads a newer app's `hello`, and an old app a newer
/// core's `welcome` and `refuse`, whatever words they added (design §2).
#[test]
fn bootstrap_frames_from_a_newer_peer_still_decode() {
    let hello = |auth: serde_json::Value| {
        let frame = json!({"t": "hello", "v": [1, 9], "role": "watch", "client": "Tasktap 9",
            "auth": auth, "abilities": ["host.hologram"], "added": {"x": 1}});
        match serde_json::from_value(frame).unwrap() {
            Control::Hello(hello) => hello,
            other => panic!("{other:?}"),
        }
    };
    let future = json!({"pubkey": "ed25519:0f", "proof": "9a"});
    let h = hello(future.clone());
    assert_eq!((h.v, h.role), (Versions(1, 9), Role::Unknown));
    assert_eq!(h.auth, Some(Auth::Unknown(future)));
    // A known scheme that does not parse costs the identity, not the connection.
    for unreadable in [
        json!({"device": id::<DeviceId>(1), "key": "short"}),
        json!({"token": 7}),
        json!("bearer x"),
    ] {
        assert_eq!(
            hello(unreadable.clone()).auth,
            Some(Auth::Unknown(unreadable))
        );
    }
    let token = Auth::Session {
        token: Secret([0xab; 32]),
    };
    assert_eq!(hello(json!({"token": "ab".repeat(32)})).auth, Some(token));
    assert_eq!(hello(json!(null)).auth, None);

    let welcome = json!({"t": "welcome", "v": 0, "core": id::<CoreId>(0), "build": "9.0.0",
        "as": "remote", "calls": ["core.status", "core.retire"], "added": 1});
    match serde_json::from_value(welcome).unwrap() {
        Control::Welcome(w) => assert_eq!((w.v, w.identity), (0, Identity::Unknown)),
        other => panic!("{other:?}"),
    }
    let refuse: Control = serde_json::from_value(json!({"t": "refuse", "why": "paused"})).unwrap();
    assert_eq!(
        refuse,
        Control::Refuse(Refuse {
            why: RefuseWhy::Unknown
        })
    );
}

#[test]
fn every_preference_default_is_in_the_typescript() {
    let ts = include_str!("../protocol.ts");
    let line = ts
        .lines()
        .find(|l| l.starts_with("export const PREF_DEFAULTS"));
    let (_, json) = line.unwrap().split_once(" = ").unwrap();
    let defaults: serde_json::Value = serde_json::from_str(json.trim_end_matches(';')).unwrap();
    assert_eq!(defaults.as_object().unwrap().len(), PrefKey::ALL.len());
    for key in PrefKey::ALL {
        let pref = serde_json::to_value(key.default()).unwrap();
        assert_eq!(
            defaults[pref["id"].as_str().unwrap()],
            pref["value"],
            "{key:?}"
        );
    }
}

#[test]
fn status_follows_phase_and_prefs_name_their_key() {
    assert_eq!(Status::from(Phase::Routed), Status::Routed);
    assert_eq!(PrefValue::from(PrefPatch::Hold(3)), PrefValue::Hold(3));
    assert_eq!(PrefValue::Hold(3).key(), PrefKey::Hold);
    assert_eq!(
        serde_json::to_value(time(0)).unwrap(),
        json!(1_794_873_600_000u64)
    );
}
