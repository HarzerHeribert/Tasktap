//! Fixed values every test shares; `samples()` is also what the committed
//! files in `samples/` must hold.

use serde::de::DeserializeOwned;
use serde_json::json;
use tasktap_proto::*;

/// A UUID v7 that differs only in its last byte, so samples stay readable.
pub fn id<T: DeserializeOwned>(n: u8) -> T {
    serde_json::from_value(json!(format!("01930000-0000-7000-8000-0000000000{n:02x}"))).unwrap()
}

pub fn rev(n: u64) -> Rev {
    Rev::new(n).unwrap()
}

pub fn time(after: u64) -> Time {
    Time::new(1_794_873_600_000 + after).unwrap()
}

pub fn thought() -> Thought {
    Thought {
        id: id(1),
        rev: rev(7),
        text: "Fix the login redirect".into(),
        // Not whole numbers, so every JSON writer prints them the same way.
        strokes: vec![vec![[12.5, 40.25], [13.75, 41.5]]],
        source: Source::Typed,
        mode: Mode::Ask,
        phase: Phase::Working,
        status: Status::NeedsYou,
        reason: None,
        live: true,
        project_id: Some(id(2)),
        card_id: None,
        session_id: Some(id(3)),
        brief: Some("Make the login page return to the page that sent the person there".into()),
        agent: Some("claude".into()),
        model: None,
        workdir: Some(Workdir {
            path: "/data/worktrees/login".into(),
            branch: "tasktap/login".into(),
            destination: Some("main".into()),
            base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904".into(),
            left_out: false,
            changes: Changes::Pending,
            files: 2,
            insertions: 14,
            deletions: 3,
        }),
        route: None,
        placed: None,
        hold_until: None,
        read: false,
        created: time(0),
        updated: time(1500),
    }
}

pub fn question() -> Question {
    Question {
        id: id(5),
        rev: rev(8),
        thought_id: Some(id(1)),
        session_id: Some(id(3)),
        turn: Some(1),
        source: QuestionSource::Agent,
        kind: QuestionKind::Choice {
            choices: vec!["Keep the cookie".into(), "Use a header".into()],
        },
        places: None,
        notes: None,
        prompt: "How should the redirect be remembered?".into(),
        detail: None,
        reply_via: ReplyVia::Core,
        state: QuestionState::Answered,
        answer: Some(answer()),
        create: None,
    }
}

pub fn answer() -> Answer {
    Answer {
        response: Response::Choice { choice: 1 },
        device_id: Some(id(9)),
        created: time(2000),
        delivered: None,
    }
}

pub fn result() -> TurnResult {
    TurnResult {
        id: id(6),
        rev: rev(9),
        thought_id: id(1),
        session_id: Some(id(3)),
        turn: Some(1),
        kind: ResultKind::Answer,
        summary: "The login page now returns to the page that sent the person there.".into(),
    }
}

/// One change that puts a row in every Phase 1 collection.
pub fn change() -> Change {
    let project = Project {
        id: id(2),
        rev: rev(3),
        name: "Tasktap".into(),
        folder: "/Users/someone/tasktap".into(),
        kind: ProjectKind::Folder,
        color: "#a8c3ae".into(),
        aliases: vec!["tt".into()],
        git: true,
        isolate: Isolate::Busy,
        open: true,
        available: true,
    };
    let session = Session {
        id: id(3),
        rev: rev(5),
        project_id: id(2),
        agent: "claude".into(),
        terminal_id: Some(id(4)),
        adopted: false,
        state: SessionState::Working,
        thought_id: Some(id(1)),
        turn: 1,
        resume: None,
        name: Some("Login redirect".into()),
        named_at: Some(time(900)),
        model: None,
        cwd: "/Users/someone/tasktap".into(),
        exit: None,
        error: None,
        activity: vec!["Reading src/login.ts".into()],
    };
    let terminal = Terminal {
        id: id(4),
        rev: rev(4),
        project_id: Some(id(2)),
        kind: TerminalKind::Agent,
        title: "Login redirect".into(),
        cwd: "/Users/someone/tasktap".into(),
        argv: vec![
            "claude".into(),
            "--session-id".into(),
            "01930000-0000-7000-8000-000000000003".into(),
        ],
        cols: 120,
        rows: 40,
        state: TerminalState::Running,
        exit: None,
        offset: Offset::new(18_432).unwrap(),
    };
    Change {
        rev: rev(9),
        snap: true,
        more: false,
        sets: vec![
            Set::Thoughts(Rows {
                put: vec![thought()],
                del: vec![id(10)],
            }),
            Set::Projects(rows(vec![project])),
            Set::Sessions(rows(vec![session])),
            Set::Terminals(rows(vec![terminal])),
            Set::Questions(rows(vec![question()])),
            Set::Results(rows(vec![result()])),
            Set::Layouts(rows(vec![Layout {
                id: id(2),
                rev: rev(2),
                tree: json!({"split": "row", "tabs": ["01930000-0000-7000-8000-000000000004"]}),
            }])),
            Set::Prefs(rows(vec![Pref {
                value: PrefValue::Hold(5),
                rev: rev(1),
            }])),
            Set::Devices(rows(vec![Device {
                id: id(9),
                rev: rev(6),
                name: "Mac host".into(),
                last_seen: Some(time(100)),
                revoked: false,
            }])),
            Set::Glance {
                put: vec![Glance {
                    rev: rev(9),
                    working: 1,
                    needs_you: 0,
                    done: 3,
                    failed: 1,
                    question: None,
                    retiring: false,
                }],
            },
        ],
    }
}

fn rows<R, I>(put: Vec<R>) -> Rows<R, I> {
    Rows { put, del: vec![] }
}

/// Every committed sample: one per frame kind, the bootstrap frames, and a few calls.
pub fn samples() -> Vec<(&'static str, Frame)> {
    let control = Frame::Control;
    let secret = Secret(std::array::from_fn(|i| i as u8));
    vec![
        (
            "hello.json",
            control(Control::Hello(Hello {
                v: Versions(1, 1),
                role: Role::Host,
                client: "Tasktap 2.0.0 (mac)".into(),
                auth: Some(Auth::Device {
                    device: id(9),
                    key: secret,
                    register: Some(Register {
                        name: "Mac host".into(),
                    }),
                }),
                abilities: vec!["host.show".into(), "host.notify".into()],
            })),
        ),
        // The case the contract exists for; a list of every call would change as calls are added.
        (
            "welcome.json",
            control(Control::Welcome(Welcome {
                v: NO_SHARED_VERSION,
                core: id(0),
                build: "2.0.0 (1a2b3c4)".into(),
                identity: Identity::Anonymous,
                calls: [call::CoreStatus::NAME, call::CoreRetire::NAME]
                    .map(|name| name.as_str().to_owned())
                    .to_vec(),
            })),
        ),
        (
            "refuse.json",
            control(Control::Refuse(Refuse {
                why: RefuseWhy::Revoked,
            })),
        ),
        (
            "call-core.status.json",
            control(call::CoreStatus::request(CallId(1), &Empty {})),
        ),
        (
            "reply-core.status.json",
            control(call::CoreStatus::reply(
                CallId(1),
                Ok(CoreStatus {
                    build: "2.0.0 (1a2b3c4)".into(),
                    v: Versions(1, 1),
                    terminals: 2,
                }),
            )),
        ),
        (
            "call-core.retire.json",
            control(call::CoreRetire::request(
                CallId(2),
                &Retire { when: When::Idle },
            )),
        ),
        (
            "reply-core.retire.json",
            control(call::CoreRetire::reply(CallId(2), Ok(()))),
        ),
        (
            "call-thought.capture.json",
            control(call::ThoughtCapture::request(
                CallId(3),
                &Capture {
                    id: id(1),
                    text: "Fix the login redirect".into(),
                    strokes: vec![],
                    source: Source::Voice,
                    mode: None,
                    project_id: Some(id(2)),
                    card_id: None,
                    session_id: None,
                    agent: Some("claude".into()),
                    model: None,
                    current: None,
                    view: None,
                },
            )),
        ),
        (
            "call-put.json",
            control(call::Put::request(
                CallId(4),
                &Put {
                    target: PutTarget::Prefs(PrefPatch::Hold(5)),
                    if_rev: Some(rev(1)),
                },
            )),
        ),
        (
            "call-question.ask.json",
            control(call::QuestionAsk::request(
                CallId(5),
                &Ask {
                    request: "redirect-storage".into(),
                    kind: QuestionKind::Choice {
                        choices: vec!["Keep the cookie".into(), "Use a header".into()],
                    },
                    prompt: "How should the redirect be remembered?".into(),
                    detail: None,
                    source: None,
                },
            )),
        ),
        (
            "reply-question.ask.json",
            control(call::QuestionAsk::reply(CallId(5), Ok(answer()))),
        ),
        (
            "call-question.answer.json",
            control(call::QuestionAnswer::request(
                CallId(6),
                &AnswerQuestion {
                    id: id(5),
                    response: Response::Choice { choice: 1 },
                },
            )),
        ),
        (
            "call-session.event.json",
            control(call::SessionEvent::request(
                CallId(7),
                &SessionEvent {
                    id: "stop-1".into(),
                    turn: None,
                    subagent: false,
                    event: Event::TurnFinished {
                        answer: Some("Done: the redirect is kept in a cookie.".into()),
                    },
                    resume: None,
                },
            )),
        ),
        (
            "reply-err.json",
            control(call::ThoughtStart::reply(
                CallId(8),
                Err(Error::new(
                    Code::Conflict,
                    "attempt reused with other arguments",
                )),
            )),
        ),
        ("change.json", control(Control::Change(change()))),
        (
            "credit.json",
            control(Control::Credit(Credit {
                s: StreamId(3),
                n: 65_536,
            })),
        ),
        (
            "mark.json",
            control(Control::Mark(Mark {
                s: StreamId(3),
                at: Offset::new(18_432).unwrap(),
                size: Some(Size(120, 40)),
                live: true,
                gap: true,
                from: Some(Offset::new(2 << 20).unwrap()),
                exit: Some(Some(0)),
            })),
        ),
        (
            "close.json",
            control(Control::Close(Close {
                s: StreamId(3),
                why: Some(CloseWhy::Done),
            })),
        ),
        (
            "data.bin",
            Frame::Data(Data {
                s: StreamId(3),
                bytes: b"\x1b[32mok\x1b[0m\r\n".to_vec(),
            }),
        ),
    ]
}

pub fn encoded(frame: &Frame) -> Vec<u8> {
    let mut out = Vec::new();
    encode(frame, &mut out).unwrap();
    out
}

/// Decodes bytes that must hold exactly one frame.
pub fn decoded(bytes: &[u8]) -> Frame {
    let mut decoder = Decoder::new();
    decoder.push(bytes);
    let frame = decoder.next_frame().unwrap().expect("a whole frame");
    assert!(
        decoder.next_frame().unwrap().is_none(),
        "nothing after the frame"
    );
    frame
}
