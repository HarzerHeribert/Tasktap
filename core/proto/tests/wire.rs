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

/// The design's table of core calls (`docs/core-design.md` §1) names as
/// built exactly the calls this crate has, marks every other "not built",
/// and counts both in its heading.
#[test]
fn the_designs_table_of_core_calls_agrees_with_the_calls_that_exist() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/core-design.md");
    let Ok(design) = std::fs::read_to_string(path) else {
        // Built from the crate alone, as in a container that mounts only `core`.
        eprintln!("skipped: the design is not beside this crate");
        return;
    };
    let mut lines = design.lines();
    let heading = lines
        .find(|line| line.starts_with("| Area | Core calls ("))
        .expect("the table of core calls");
    let (mut built, mut to_come) = (Vec::new(), Vec::new());
    for row in lines.skip(1).take_while(|line| line.starts_with('|')) {
        // A call is a name in backticks; what follows it up to the next says how it stands.
        let calls = row.split('|').nth(2).expect("the row's calls");
        let mut parts = calls.split('`').skip(1);
        while let (Some(name), Some(mark)) = (parts.next(), parts.next()) {
            match mark.contains("not built") {
                true => to_come.push(name),
                false => built.push(name),
            }
        }
    }
    let mut exist: Vec<&str> = (Name::ALL.iter())
        .filter(|name| name.access() != Access::Ability)
        .map(|name| name.as_str())
        .filter(|name| !name.starts_with("fixture."))
        .collect();
    exist.sort_unstable();
    built.sort_unstable();
    assert_eq!(built, exist, "the calls the design's table says are built");
    assert!(to_come.iter().all(|name| Name::parse(name).is_none()));
    let counted = format!(
        "({}: {} built, {} not built)",
        built.len() + to_come.len(),
        built.len(),
        to_come.len()
    );
    assert!(heading.contains(&counted), "{heading} should say {counted}");
}

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
        card_id: None,
        session_id: Some(id(3)),
        agent: None,
        model: Some("sonnet".into()),
        current: Some(id(4)),
    };
    round_trip::<call::ThoughtCapture>(capture, (), seen);
    round_trip::<call::ThoughtUpdate>(
        Assign {
            id: id(1),
            project_id: Some(id(2)),
            card_id: None,
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
    let diff = Diff {
        stream: Opened {
            s: StreamId(4),
            credit: 0,
            from: None,
        },
        files: vec![ChangedFile {
            path: "src/login.ts".into(),
            change: FileChange::Modified,
            insertions: Some(14),
            deletions: Some(3),
        }],
        more: 0,
        size: 1200,
        cut: false,
    };
    for path in [None, Some("src/login.ts".to_owned())] {
        let read = ReadChanges {
            id: id(1),
            credit: 1 << 20,
            path,
        };
        round_trip::<call::ThoughtChanges>(read, diff.clone(), seen);
    }
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
        said: None,
    };
    round_trip::<call::RouteHint>(hint, route, seen);
    let terms = RouteTerms {
        instructions: "You are the router of Tasktap.".into(),
        sends: vec!["the thought, as you said or typed it".into()],
        terms: 3,
        tools: vec![PlaceTool {
            agent: "claude".into(),
            model: "haiku".into(),
            pays: Pays::Plan,
            ms: Some(3700),
        }],
    };
    round_trip::<call::RouteTerms>(Empty {}, terms, seen);
    let health = AgentHealth {
        id: "codex".into(),
        name: "Codex".into(),
        supported: true,
        own: false,
        note: None,
        checks: true,
        options: Vec::new(),
        stale: false,
        rev: rev(7),
        checked: time(42),
        installed: true,
        version: Some("0.169.0".into()),
        signed_in: Some(true),
        identity: Some("ChatGPT".into()),
        limited: Some(time(3_600_042)),
        events: true,
        resume: true,
        permissions: Some(ReplyVia::Core),
        questions: Some(ReplyVia::Terminal),
    };
    let detect = DetectAgents {
        agents: Some(vec!["codex".into()]),
        unchecked: false,
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
    // What Tasktap knows of the person's projects (docs/projects-design.md).
    let look = AddLook {
        id: id(9),
        folder: None,
        agent: Some("claude".into()),
        on: Some(true),
    };
    round_trip::<call::LookAdd>(look, id(9), seen);
    let offer = Offer {
        agents: vec![OfferedAgent {
            agent: "codex".into(),
            name: "Codex".into(),
        }],
        places: vec![OfferedPlace {
            folder: "/Users/someone/projects".into(),
            projects: 9,
        }],
    };
    round_trip::<call::ProjectsOffer>(Empty {}, offer, seen);
    let looked = Looked {
        projects: 14,
        ms: 47,
    };
    round_trip::<call::ProjectsLook>(Empty {}, looked, seen);
    let find = Find {
        text: "queue grid".into(),
        limit: Some(3),
        thought: true,
    };
    let found = Finds {
        found: vec![Found {
            to: Place::Card(id(7)),
            name: "cuegrid".into(),
            folder: "~/projects/cuegrid".into(),
            why: "said as “queue grid”".into(),
        }],
    };
    round_trip::<call::ProjectsFind>(find, found, seen);
    for (unless, stream) in [
        (None, Some(diff.stream)),
        (Some("18a9c2f0-4d2".to_owned()), None),
    ] {
        let read = ReadFile {
            path: "/work/app/report.html".into(),
            credit: 1 << 20,
            unless,
        };
        let file = FileRead {
            stream,
            size: 1234,
            kind: FileKind::Html,
            encoding: Some(Encoding::Utf8),
            cut: false,
            stamp: "18a9c2f0-4d2".into(),
        };
        round_trip::<call::FileRead>(read, file, seen);
    }
    for (terminal, target, cwd) in [
        (Some(id(3)), "http://localhost:5173/", None),
        (None, "out/report.html", Some("/work/app".to_owned())),
    ] {
        let open = OpenPreview {
            terminal,
            target: target.into(),
            cwd,
        };
        round_trip::<call::PreviewOpen>(open, id(9), seen);
    }
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
    let spoken = Capture {
        id: id(1),
        text: String::new(),
        strokes: vec![],
        source: Source::Voice,
        mode: None,
        project_id: Some(id(2)),
        card_id: None,
        session_id: None,
        agent: None,
        model: None,
        current: None,
    };
    for (target, stream) in [
        (
            DictationTarget::Thought(Box::new(spoken)),
            Some(Opened {
                s: StreamId(3),
                credit: MAX_CREDIT,
                from: None,
            }),
        ),
        (DictationTarget::Text, None),
    ] {
        let start = StartDictation {
            id: id(6),
            target,
            local: stream.is_none(),
        };
        let listening = Listening {
            stream,
            seconds: 300,
        };
        round_trip::<call::DictationStart>(start, listening, seen);
    }
    for (text, level) in [(Some("Hallo".to_owned()), None), (None, Some(40))] {
        let report = ReportDictation {
            id: id(6),
            text,
            level,
        };
        round_trip::<call::DictationReport>(report, (), seen);
    }
    let finish = FinishDictation {
        id: id(6),
        words: Some(FinishAs::Text),
    };
    round_trip::<call::DictationFinish>(finish, (), seen);
    // As words only is said with `as`; without it a finish names its dictation alone.
    assert_eq!(
        serde_json::to_value(finish).unwrap(),
        json!({"id": "01930000-0000-7000-8000-000000000006", "as": "text"})
    );
    let plain = json!({"id": "01930000-0000-7000-8000-000000000006"});
    let plain: FinishDictation = serde_json::from_value(plain).unwrap();
    assert_eq!(plain.words, None);
    round_trip::<call::DictationCancel>(Ref { id: id(6) }, (), seen);
    let terms = SpeechTerms {
        sent: vec!["The recording".into()],
        path: "/v1/audio/transcriptions".into(),
        seconds: 300,
    };
    round_trip::<call::SpeechTerms>(Empty {}, terms, seen);
    let server = || "https://api.openai.com".to_owned();
    let set = SetKey {
        server: server(),
        key: "sk-not-a-key".into(),
    };
    // Printing the arguments never shows the key.
    assert!(!format!("{set:?}").contains("sk-not-a-key"));
    round_trip::<call::KeySet>(set, (), seen);
    round_trip::<call::KeyRemove>(Server { server: server() }, (), seen);
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
    for session in [Some(SessionId::mint()), None] {
        let notify = HostNotify {
            question: QuestionId::mint(),
            title: "Fixture agent asks".into(),
            body: "Go on?".into(),
            session,
        };
        round_trip::<call::HostNotify>(notify, (), seen);
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
            said: None,
        },
        Route::Ambiguous {
            prompt: "Where?".into(),
            candidates: vec![Candidate {
                label: "app".into(),
                to: Place::Session(id(3)),
                why: String::new(),
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
    assert_eq!(Name::ALL.len(), 51);
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
    assert_eq!(by(Access::Device).len(), 42);
    // An agent shows a preview beside its own terminal, as a device does beside any.
    assert_eq!(by(Access::Either), ["preview.open"]);
    assert_eq!(by(Access::Ability), ["shim.hold", "host.notify"]);
    for (access, allowed) in [
        (Access::Anyone, [true, true, true]),
        (Access::Device, [true, false, false]),
        (Access::Session, [false, true, false]),
        (Access::Either, [true, true, false]),
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

#[test]
fn motion_preferences_put_as_the_wire_says() {
    let cases = [
        (
            json!({"c": "prefs", "id": "motion_style", "patch": "glyphs"}),
            PrefPatch::MotionStyle(MotionStyle::Glyphs),
            PrefKey::MotionStyle,
        ),
        (
            json!({"c": "prefs", "id": "motion_palette", "patch": "custom"}),
            PrefPatch::MotionPalette(MotionPalette::Custom),
            PrefKey::MotionPalette,
        ),
        (
            json!({"c": "prefs", "id": "motion_hue", "patch": 120}),
            PrefPatch::MotionHue(120),
            PrefKey::MotionHue,
        ),
        (
            json!({"c": "prefs", "id": "motion_lumen", "patch": true}),
            PrefPatch::MotionLumen(true),
            PrefKey::MotionLumen,
        ),
    ];
    for (wire, patch, key) in cases {
        let target: PutTarget = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(target, PutTarget::Prefs(patch.clone()));
        assert_eq!(serde_json::to_value(&target).unwrap(), wire);
        assert_eq!(PrefValue::from(patch).key(), key);
    }
    for bad in [
        json!({"c": "prefs", "id": "motion_style", "patch": "drop"}),
        json!({"c": "prefs", "id": "motion_hue", "patch": -1}),
    ] {
        assert!(serde_json::from_value::<PutTarget>(bad).is_err());
    }
}

/// The rule of which web addresses a preview loads (design §12), as the
/// table every side shares: `tests/addresses.json`, each address with what
/// it is. A page that mirrors the rule runs the same table.
#[test]
fn only_this_machines_own_addresses_are_local_by_the_shared_table() {
    let table: Vec<(String, Web)> = serde_json::from_str(include_str!("addresses.json")).unwrap();
    assert!(table.len() > 60);
    for (address, is) in &table {
        assert_eq!(web(address), *is, "{address:?}");
    }
    // Every kind is in the table, and local only where the host is this machine.
    for kind in [Web::Local, Web::Remote, Web::Broken, Web::No] {
        assert!(table.iter().any(|(_, is)| *is == kind), "{kind:?}");
    }
    let long = format!("http://localhost/{}", "a".repeat(MAX_ADDRESS));
    assert_eq!(web(&long), Web::Broken);
    let fits = format!("http://localhost/{}", "a".repeat(MAX_ADDRESS - 17));
    assert_eq!((fits.len(), web(&fits)), (MAX_ADDRESS, Web::Local));
}

/// The rule of what is read, shown and opened on disk (design §12): the
/// whole path a target names, and whether it is inside a folder the person
/// opened once every link is followed.
#[test]
fn a_path_is_inside_a_folder_the_person_opened_only_with_its_links_followed() {
    use std::fs;
    let base = std::env::temp_dir().join(format!("tasktap-rules-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let (project, other) = (base.join("my project"), base.join("other"));
    fs::create_dir_all(project.join("src")).unwrap();
    fs::create_dir_all(&other).unwrap();
    fs::write(project.join("src/größe.md"), "# Größe\n").unwrap();
    fs::write(other.join("secret.txt"), "no").unwrap();
    let real = project.canonicalize().unwrap();
    let roots = [project.clone()];

    let file = real.join("src/größe.md");
    assert_eq!(
        inside(&project.join("src/größe.md"), &roots),
        Ok(file.clone())
    );
    assert_eq!(
        inside(&project.join("src/../src/größe.md"), &roots),
        Ok(file.clone())
    );
    assert_eq!(inside(&project, &roots), Ok(real.clone()));
    assert_eq!(
        inside(&project.join("src/none.md"), &roots),
        Err(Outside::Missing)
    );
    let secret = other.join("secret.txt");
    let out = Outside::Outside(secret.canonicalize().unwrap());
    assert_eq!(inside(&secret, &roots), Err(out.clone()));
    assert_eq!(
        inside(&project.join("../other/secret.txt"), &roots),
        Err(out.clone())
    );
    // A folder whose name only begins like the person's is another folder.
    fs::create_dir_all(base.join("my project too")).unwrap();
    assert!(inside(&base.join("my project too"), &roots).is_err());
    // With no folder opened nothing is inside, and a root that is gone is none.
    assert!(inside(&file, &[]).is_err());
    assert!(inside(&file, &[base.join("gone")]).is_err());
    #[cfg(unix)]
    {
        // A link out of the folder is followed first; one into it from outside is fine.
        std::os::unix::fs::symlink(&secret, project.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(&other, project.join("away")).unwrap();
        std::os::unix::fs::symlink(&project, other.join("back")).unwrap();
        assert_eq!(inside(&project.join("link.txt"), &roots), Err(out.clone()));
        assert_eq!(inside(&project.join("away/secret.txt"), &roots), Err(out));
        assert_eq!(
            inside(&other.join("back/src/größe.md"), &roots),
            Ok(file.clone())
        );
        // A root given through a link is the folder it leads to.
        assert_eq!(inside(&file, &[other.join("back")]), Ok(file.clone()));
    }
    assert!(Outside::Missing.sentence(&file).ends_with("does not exist"));
    let said = Outside::Outside(secret.clone()).sentence(&file);
    assert!(
        said.ends_with("is outside the folders you opened in Tasktap"),
        "{said}"
    );

    // The whole path a target names.
    let home = Some(base.as_path());
    let cwd = project.to_str();
    assert_eq!(
        whole(file.to_str().unwrap(), None, None),
        Some(file.clone())
    );
    assert_eq!(
        whole("src/größe.md", cwd, None),
        Some(project.join("src/größe.md"))
    );
    assert_eq!(whole("~/other/secret.txt", None, home), Some(secret));
    assert_eq!(whole("src/größe.md", None, home), None);
    assert_eq!(whole("src/größe.md", Some("my project"), home), None);
    // Without a home folder `~` is a folder's name like any other.
    assert_eq!(whole("~/x", cwd, None), Some(project.join("~/x")));
    let _ = fs::remove_dir_all(base);
}

/// The settings the redesigned Settings sheet lacked a preference for.
#[test]
fn the_keys_the_history_and_the_text_preferences_put_as_the_wire_says() {
    let key = |control, alt, shift, meta, code: &str| Shortcut {
        control,
        alt,
        shift,
        meta,
        code: code.into(),
    };
    let wire_key =
        json!({"control": false, "alt": true, "shift": true, "meta": false, "code": "KeyK"});
    let cases = [
        (
            json!({"c": "prefs", "id": "return_sends", "patch": false}),
            PrefPatch::ReturnSends(false),
            PrefKey::ReturnSends,
        ),
        (
            json!({"c": "prefs", "id": "capture_key", "patch": wire_key}),
            PrefPatch::CaptureKey(Some(key(false, true, true, false, "KeyK"))),
            PrefKey::CaptureKey,
        ),
        (
            json!({"c": "prefs", "id": "capture_key", "patch": null}),
            PrefPatch::CaptureKey(None),
            PrefKey::CaptureKey,
        ),
        (
            json!({"c": "prefs", "id": "talk_key", "patch": wire_key}),
            PrefPatch::TalkKey(Some(key(false, true, true, false, "KeyK"))),
            PrefKey::TalkKey,
        ),
        (
            json!({"c": "prefs", "id": "keep_days", "patch": 30}),
            PrefPatch::KeepDays(30),
            PrefKey::KeepDays,
        ),
        (
            json!({"c": "prefs", "id": "terminal_bold_bright", "patch": false}),
            PrefPatch::TerminalBoldBright(false),
            PrefKey::TerminalBoldBright,
        ),
        (
            json!({"c": "prefs", "id": "terminal_contrast", "patch": false}),
            PrefPatch::TerminalContrast(false),
            PrefKey::TerminalContrast,
        ),
        (
            json!({"c": "prefs", "id": "text_size", "patch": "large"}),
            PrefPatch::TextSize(TextSize::Large),
            PrefKey::TextSize,
        ),
    ];
    for (wire, patch, key) in cases {
        let target: PutTarget = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(target, PutTarget::Prefs(patch.clone()));
        assert_eq!(serde_json::to_value(&target).unwrap(), wire);
        assert_eq!(PrefValue::from(patch).key(), key);
    }
    // Each default keeps what the app did before the preference existed.
    for (key, default) in [
        (PrefKey::ReturnSends, json!(true)),
        (PrefKey::CaptureKey, json!(null)),
        (PrefKey::TalkKey, json!(null)),
        (PrefKey::KeepDays, json!(0)),
        (PrefKey::TerminalBoldBright, json!(true)),
        (PrefKey::TerminalContrast, json!(true)),
        (PrefKey::TextSize, json!("default")),
    ] {
        assert_eq!(
            serde_json::to_value(key.default()).unwrap()["value"],
            default
        );
    }
    for bad in [
        json!({"c": "prefs", "id": "return_sends", "patch": "yes"}),
        json!({"c": "prefs", "id": "capture_key", "patch": "Control+Space"}),
        json!({"c": "prefs", "id": "capture_key", "patch": {"alt": true, "code": "Space"}}),
        json!({"c": "prefs", "id": "talk_key", "patch":
            {"control": true, "alt": false, "shift": false, "meta": false, "code": "Space", "hyper": true}}),
        json!({"c": "prefs", "id": "talk_key", "patch":
            {"control": true, "alt": false, "shift": false, "meta": false, "code": "x".repeat(40)}}),
        json!({"c": "prefs", "id": "keep_days", "patch": 3651}),
        json!({"c": "prefs", "id": "keep_days", "patch": -1}),
        json!({"c": "prefs", "id": "keep_days", "patch": "forever"}),
        json!({"c": "prefs", "id": "terminal_bold_bright", "patch": 1}),
        json!({"c": "prefs", "id": "text_size", "patch": "huge"}),
    ] {
        assert!(
            serde_json::from_value::<PutTarget>(bad.clone()).is_err(),
            "{bad}"
        );
    }
    let days = json!({"c": "prefs", "id": "keep_days", "patch": 4000});
    let why = serde_json::from_value::<PutTarget>(days).unwrap_err();
    assert_eq!(
        why.to_string(),
        "Finished thoughts are kept for 1 to 3650 days, or for ever with 0"
    );

    // The rule of a shortcut, as a table: the modifiers held, the key, and why not.
    let rule = [
        // Today's keys, and each system's default for capture.
        ((true, true, false, false, "Space"), None),
        ((false, true, true, false, "Space"), None),
        ((false, true, false, false, "Space"), None),
        ((false, false, false, true, "KeyK"), None),
        ((true, false, true, false, "F5"), None),
        ((true, false, false, false, "Digit1"), None),
        ((true, true, true, true, "Slash"), None),
        ((false, true, false, false, "F12"), None),
        // Not a bare key, and Shift alone does not make one a shortcut.
        ((false, false, false, false, "Space"), Some(Shortcut::BARE)),
        ((false, false, true, false, "KeyA"), Some(Shortcut::BARE)),
        ((false, false, false, false, "F5"), Some(Shortcut::BARE)),
        // A key by its code, of the keys every host registers.
        ((true, false, false, false, "space"), Some(Shortcut::NO_KEY)),
        ((true, false, false, false, " "), Some(Shortcut::NO_KEY)),
        ((true, false, false, false, ""), Some(Shortcut::NO_KEY)),
        ((true, false, false, false, "KeyÄ"), Some(Shortcut::NO_KEY)),
        ((true, false, false, false, "Keya"), Some(Shortcut::NO_KEY)),
        ((true, false, false, false, "KeyAB"), Some(Shortcut::NO_KEY)),
        (
            (true, false, false, false, "Digit10"),
            Some(Shortcut::NO_KEY),
        ),
        ((true, false, false, false, "F0"), Some(Shortcut::NO_KEY)),
        ((true, false, false, false, "F01"), Some(Shortcut::NO_KEY)),
        ((true, false, false, false, "F13"), Some(Shortcut::NO_KEY)),
        (
            (true, false, false, false, "ControlLeft"),
            Some(Shortcut::NO_KEY),
        ),
        (
            (true, false, false, false, "⌃Space"),
            Some(Shortcut::NO_KEY),
        ),
        // What a system keeps, whichever system this is.
        (
            (false, false, false, true, "Space"),
            Some(Shortcut::RESERVED),
        ),
        ((false, false, false, true, "Tab"), Some(Shortcut::RESERVED)),
        ((false, true, false, false, "Tab"), Some(Shortcut::RESERVED)),
        (
            (false, false, false, true, "KeyQ"),
            Some(Shortcut::RESERVED),
        ),
        ((false, true, false, false, "F4"), Some(Shortcut::RESERVED)),
        (
            (true, true, false, false, "Delete"),
            Some(Shortcut::RESERVED),
        ),
        (
            (true, false, true, false, "Escape"),
            Some(Shortcut::RESERVED),
        ),
        (
            (false, false, true, true, "Digit4"),
            Some(Shortcut::RESERVED),
        ),
        // With one more modifier it is another combination.
        ((true, false, false, true, "Space"), None),
        // The keys that answer a waiting question.
        ((true, true, false, false, "KeyY"), Some(Shortcut::ANSWERS)),
        ((true, true, false, false, "KeyN"), Some(Shortcut::ANSWERS)),
        ((true, true, false, false, "KeyJ"), Some(Shortcut::ANSWERS)),
        ((true, true, true, false, "KeyJ"), None),
    ];
    for ((control, alt, shift, meta, code), why) in rule {
        let shortcut = key(control, alt, shift, meta, code);
        assert_eq!(shortcut.refused(), why, "{shortcut:?}");
    }
    // The default is a shortcut by its own rule on each system, and never
    // Control-Alt off the Mac, which is AltGr on many keyboards.
    assert_eq!(
        Shortcut::capture(true),
        key(true, true, false, false, "Space")
    );
    assert_eq!(
        Shortcut::capture(false),
        key(false, true, true, false, "Space")
    );
    for mac in [true, false] {
        assert_eq!(Shortcut::capture(mac).refused(), None);
    }
}

#[test]
fn ambient_and_terminal_preferences_put_as_the_wire_says_within_their_bounds() {
    let cases = [
        (
            json!({"c": "prefs", "id": "motion_ambient", "patch": "still"}),
            PrefPatch::MotionAmbient(MotionAmbient::Still),
            PrefKey::MotionAmbient,
        ),
        (
            json!({"c": "prefs", "id": "terminal_font", "patch": "JetBrains Mono"}),
            PrefPatch::TerminalFont("JetBrains Mono".into()),
            PrefKey::TerminalFont,
        ),
        (
            json!({"c": "prefs", "id": "terminal_size", "patch": 16}),
            PrefPatch::TerminalSize(16),
            PrefKey::TerminalSize,
        ),
        (
            json!({"c": "prefs", "id": "terminal_line_height", "patch": 120}),
            PrefPatch::TerminalLineHeight(120),
            PrefKey::TerminalLineHeight,
        ),
        (
            json!({"c": "prefs", "id": "speech_by", "patch":
                {"server": "https://api.groq.com/openai", "model": "whisper-large-v3-turbo"}}),
            PrefPatch::SpeechBy(Some(SpeechBy {
                server: "https://api.groq.com/openai".into(),
                model: "whisper-large-v3-turbo".into(),
            })),
            PrefKey::SpeechBy,
        ),
        (
            json!({"c": "prefs", "id": "speech_languages", "patch": ["de", "en"]}),
            PrefPatch::SpeechLanguages(vec!["de".into(), "en".into()]),
            PrefKey::SpeechLanguages,
        ),
    ];
    // The servers a key is stored for are the core's to write: no patch names them.
    let keys = json!({"c": "prefs", "id": "keys", "patch": ["https://api.openai.com"]});
    assert!(serde_json::from_value::<PutTarget>(keys).is_err());
    for (wire, patch, key) in cases {
        let target: PutTarget = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(target, PutTarget::Prefs(patch.clone()));
        assert_eq!(serde_json::to_value(&target).unwrap(), wire);
        assert_eq!(PrefValue::from(patch).key(), key);
    }
    for (key, default) in [
        (PrefKey::MotionAmbient, json!("breathing")),
        (PrefKey::TerminalFont, json!("")),
        (PrefKey::TerminalSize, json!(14)),
        (PrefKey::TerminalLineHeight, json!(100)),
    ] {
        assert_eq!(
            serde_json::to_value(key.default()).unwrap()["value"],
            default
        );
    }
    for bad in [
        json!({"c": "prefs", "id": "motion_ambient", "patch": "strong"}),
        json!({"c": "prefs", "id": "terminal_font", "patch": "x".repeat(200)}),
        json!({"c": "prefs", "id": "terminal_size", "patch": 7}),
        json!({"c": "prefs", "id": "terminal_size", "patch": 33}),
        json!({"c": "prefs", "id": "terminal_line_height", "patch": 99}),
        json!({"c": "prefs", "id": "terminal_line_height", "patch": 201}),
    ] {
        assert!(serde_json::from_value::<PutTarget>(bad).is_err());
    }
}

#[test]
fn the_agreement_to_place_by_models_and_a_thoughts_route_are_as_the_wire_says() {
    let placer = |agent: &str, model: &str, on| Placer {
        agent: agent.into(),
        model: model.into(),
        on,
    };
    let by = RouteBy {
        agents: vec![
            placer("codex", "gpt-6-luna", true),
            placer("claude", "haiku", false),
        ],
        terms: 3,
    };
    let agents = json!([
        {"agent": "codex", "model": "gpt-6-luna", "on": true},
        {"agent": "claude", "model": "haiku", "on": false},
    ]);
    let wire = json!({"c": "prefs", "id": "route_by", "patch": {"agents": agents, "terms": 3}});
    let target: PutTarget = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(
        target,
        PutTarget::Prefs(PrefPatch::RouteBy(Some(by.clone())))
    );
    assert_eq!(serde_json::to_value(&target).unwrap(), wire);
    // Taken back with none.
    let none = json!({"c": "prefs", "id": "route_by", "patch": null});
    let target: PutTarget = serde_json::from_value(none).unwrap();
    assert_eq!(target, PutTarget::Prefs(PrefPatch::RouteBy(None)));
    assert_eq!(PrefKey::RouteBy.default(), PrefValue::RouteBy(None));
    let value = PrefValue::from(PrefPatch::RouteBy(Some(by)));
    assert_eq!(value.key(), PrefKey::RouteBy);
    let row = Pref { value, rev: rev(3) };
    assert_eq!(
        serde_json::to_value(&row).unwrap(),
        json!({"id": "route_by", "value": {"agents": agents, "terms": 3}, "rev": 3})
    );
    // An agreement lists agents, each with its model and its switch, and
    // nothing else; the wire takes no consent to one agent as a core
    // before this one kept it (only the store reads that, as a list).
    for patch in [
        json!("claude"),
        json!({"agent": "claude", "model": "haiku", "terms": 2}),
        json!({"agents": [{"agent": "claude", "model": "haiku"}], "terms": 3}),
        json!({"agents": [{"agent": "claude", "model": "haiku", "on": true, "server": "x"}], "terms": 3}),
        json!({"agents": [], "terms": 3, "server": "example.com"}),
        json!({"agents": []}),
    ] {
        let bad = json!({"c": "prefs", "id": "route_by", "patch": patch});
        assert!(serde_json::from_value::<PutTarget>(bad).is_err());
    }

    // How a thought was routed; one stored before there was such a record has none.
    let route = Routing {
        by: "claude".into(),
        model: Some("haiku".into()),
        pending: false,
        fallback: None,
        quote: Some("that thing from before".into()),
        title: Some("Login redirect".into()),
        ms: Some(2300),
    };
    let routed = Thought {
        route: Some(route),
        ..thought()
    };
    let mut wire = serde_json::to_value(&routed).unwrap();
    assert_eq!(
        wire["route"],
        json!({"by": "claude", "model": "haiku", "pending": false, "fallback": null,
               "quote": "that thing from before", "title": "Login redirect", "ms": 2300})
    );
    // A route stored before a model gave titles reads with none.
    let mut untitled = wire["route"].clone();
    untitled.as_object_mut().unwrap().remove("title");
    let untitled: Routing = serde_json::from_value(untitled).unwrap();
    assert_eq!(untitled.title, None);
    assert_eq!(
        serde_json::from_value::<Thought>(wire.clone()).unwrap(),
        routed
    );
    wire.as_object_mut().unwrap().remove("route");
    assert_eq!(
        serde_json::from_value::<Thought>(wire.clone()).unwrap(),
        thought()
    );

    // How a thought's place came about is one word of a closed set; a
    // thought stored before it was recorded reads with none.
    let words: Vec<_> = (Placed::ALL.iter())
        .map(|p| serde_json::to_value(p).unwrap())
        .collect();
    assert_eq!(
        json!(words),
        json!([
            "picked",
            "name",
            "model",
            "follow_up",
            "answer",
            "kept",
            "kept_answer",
            "kept_name",
            "kept_model"
        ])
    );
    let placed = Thought {
        placed: Some(Placed::FollowUp),
        ..thought()
    };
    assert_eq!(
        serde_json::to_value(&placed).unwrap()["placed"],
        "follow_up"
    );
    assert_eq!(wire["placed"], json!(null));
    wire.as_object_mut().unwrap().remove("placed");
    assert_eq!(serde_json::from_value::<Thought>(wire).unwrap(), thought());

    // A router's question says what each choice is beside its label; any
    // other question, and one stored before the field, has none.
    let asked = Question {
        source: QuestionSource::Router,
        places: Some(vec![Place::Project(id(2)), Place::Session(id(3))]),
        ..question()
    };
    let mut wire = serde_json::to_value(&asked).unwrap();
    assert_eq!(
        (&wire["choices"], &wire["places"]),
        (
            &json!(["Keep the cookie", "Use a header"]),
            &json!([{"project": "01930000-0000-7000-8000-000000000002"},
                    {"session": "01930000-0000-7000-8000-000000000003"}])
        )
    );
    assert_eq!(
        serde_json::from_value::<Question>(wire.clone()).unwrap(),
        asked
    );
    assert_eq!(
        serde_json::to_value(question()).unwrap()["places"],
        json!(null)
    );
    wire.as_object_mut().unwrap().remove("places");
    let old: Question = serde_json::from_value(wire).unwrap();
    assert_eq!((old.places, old.source), (None, QuestionSource::Router));

    // `route.terms` is a device's call with no arguments.
    assert_eq!(call::RouteTerms::NAME.as_str(), "route.terms");
    assert_eq!(call::RouteTerms::NAME.access(), Access::Device);
}
