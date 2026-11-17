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
    ] {
        round_trip::<call::Delete>(target, at, seen);
    }
    let page = HistoryPage {
        thoughts: vec![thought()],
        questions: vec![question()],
        results: vec![result()],
    };
    round_trip::<call::History>(
        History {
            before: Some(id(1)),
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
        Event::Continued,
        Event::TurnFinished { answer: None },
        Event::TurnFailed {
            error: Some("rate limited".into()),
        },
        Event::TurnInterrupted,
    ] {
        round_trip::<call::SessionEvent>(
            SessionEvent {
                id: "e".into(),
                event,
            },
            (),
            seen,
        );
    }
    let add = AddProject {
        id: id(2),
        folder: "/Users/someone/tasktap".into(),
        name: None,
    };
    round_trip::<call::ProjectAdd>(add, id(2), seen);
    round_trip::<call::ProjectScan>(Empty {}, (), seen);
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

    seen.dedup();
    assert_eq!(seen.as_slice(), Name::ALL, "every call in table order");
    assert_eq!(Name::ALL.len(), 21);
}

#[test]
fn names_parse_back_and_unknown_names_do_not() {
    for &name in Name::ALL {
        assert_eq!(Name::parse(name.as_str()), Some(name));
    }
    assert_eq!(Name::parse("terminal.open"), None);
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
    assert_eq!(by(Access::Anyone), ["core.status", "core.retire"]);
    assert_eq!(
        by(Access::Session),
        [
            "question.ask",
            "question.withdraw",
            "question.received",
            "session.event"
        ]
    );
    assert_eq!(by(Access::Device).len(), 15);
    for (access, allowed) in [
        (Access::Anyone, [true, true, true]),
        (Access::Device, [true, false, false]),
        (Access::Session, [false, true, false]),
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
