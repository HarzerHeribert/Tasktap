//! Pi's adapter (design §7), without the real tool: what its extension's
//! payloads mean, how a run is started and resumed, what detection reads,
//! how it is asked one question, and the words it stops at in its terminal.
//! The payloads, the answer and the terminal captures were recorded from
//! `pi` 1.5.2 with the extension as the adapter writes it, and sanitised.

mod common;

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use common::*;
use serde_json::{Value, json};
use tasktap_core::agents::{self, Agent, Heard, Run};
use tasktap_proto::{
    Answer, Event, QuestionKind, QuestionState, ReplyVia, Response, SessionEvent, SessionId,
    SessionState, Time,
};

const SESSION: &str = "01930000-0000-7000-8000-000000000001";
const RUN: &str = "01930000-0000-7000-8000-0000000000aa";

fn pi() -> &'static dyn Agent {
    agents::find("pi").unwrap()
}

fn fixture(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/agents/pi")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn payload(name: &str) -> Vec<u8> {
    fixture(&format!("{name}.json"))
}

/// The same payload with fields changed.
fn changed(name: &str, fields: Value) -> Vec<u8> {
    let mut p: Value = serde_json::from_slice(&payload(name)).unwrap();
    for (key, value) in fields.as_object().unwrap() {
        p[key] = value.clone();
    }
    p.to_string().into_bytes()
}

fn heard(bytes: &[u8]) -> Option<SessionEvent> {
    match pi().event(&[], bytes).unwrap() {
        Some(Heard::Event(event)) => Some(event),
        None => None,
        other => panic!("{other:?}"),
    }
}

fn event(name: &str) -> SessionEvent {
    heard(&payload(name)).unwrap_or_else(|| panic!("{name} says nothing"))
}

fn run<'a>(prompt: &'a str, model: Option<&'a str>, resume: Option<&'a str>) -> Run<'a> {
    Run {
        session: SessionId::try_from(RUN.parse::<tasktap_proto::Uuid>().unwrap()).unwrap(),
        cwd: Path::new("/tmp/project"),
        prompt,
        words: None,
        model,
        resume,
        hook: Path::new("/opt/tasktap/tasktap"),
        home: Path::new("/data/agents/pi"),
    }
}

#[test]
fn pis_events_map_to_the_one_vocabulary() {
    let ready = event("session-start");
    assert_eq!(ready.event, Event::Ready);
    assert_eq!(ready.id, "session_start:m0000000.1");
    // Every event names the session, the handle `--session` takes; none
    // comes from a sub-agent, and Pi numbers no turns.
    for name in [
        "session-start",
        "before-agent-start",
        "tool-call",
        "ui-prompt-start",
        "ui-prompt-end",
        "agent-settled",
        "agent-settled-aborted",
    ] {
        let e = event(name);
        assert_eq!(e.resume.as_deref(), Some(SESSION), "{name}");
        assert_eq!((e.subagent, e.turn), (false, None), "{name}");
    }
    // With no sign-in for its model it says nothing: the session stays
    // starting, and the core goes on reading its terminal, which says so.
    assert!(heard(&payload("session-start-unsigned")).is_none());

    let started = event("before-agent-start");
    let Event::TurnStarted { prompt } = &started.event else {
        panic!("{started:?}");
    };
    assert!(prompt.as_deref().unwrap().starts_with("Tasktap test: use"));

    let Event::Activity { text } = event("tool-call").event else {
        panic!();
    };
    assert_eq!(text, "bash: echo done");
    let Event::Activity { text } = event("tool-call-question").event else {
        panic!();
    };
    assert_eq!(text, "ask_person");

    // A dialog of an extension: shown, and answered in Pi's terminal.
    let asked = event("ui-prompt-start");
    let Event::Question { question } = &asked.event else {
        panic!("{asked:?}");
    };
    assert_eq!(question.prompt, "Tea or coffee?");
    assert_eq!(question.kind, QuestionKind::Text);
    assert_eq!(question.request, asked.id);
    assert_eq!(question.source, None);
    let confirm = changed("ui-prompt-start", json!({ "kind": "confirm" }));
    let Event::Question { question } = heard(&confirm).unwrap().event else {
        panic!();
    };
    assert_eq!(question.kind, QuestionKind::Confirm);
    let untitled = changed(
        "ui-prompt-start",
        json!({ "kind": "custom", "title": null }),
    );
    let Event::Question { question } = heard(&untitled).unwrap().event else {
        panic!();
    };
    assert_eq!(question.prompt, "Pi is waiting for you in its terminal");
    assert_eq!(
        event("ui-prompt-end").event,
        Event::Continued { request: None }
    );

    assert_eq!(
        event("agent-settled").event,
        Event::TurnFinished {
            answer: Some("Coffee".into())
        }
    );
    assert_eq!(event("agent-settled-aborted").event, Event::TurnInterrupted);
    let Event::TurnFailed { error } = event("agent-settled-error").event else {
        panic!();
    };
    let error = error.unwrap();
    assert!(error.starts_with("401: {\"message\":\"Authentication Fails"));
    assert!(!error.contains('\n'));
    assert!(
        error.contains("Your api key: (a key) is invalid"),
        "{error}"
    );
    // No part of a key a provider names in its error is kept.
    let named = json!({ "error": "Incorrect API key provided: sk-12*****cdef. Check it." });
    let Event::TurnFailed { error } = heard(&changed("agent-settled-error", named)).unwrap().event
    else {
        panic!();
    };
    assert_eq!(
        error.unwrap(),
        "Incorrect API key provided: (a key) Check it."
    );
    // A turn that ends with nothing said has no answer.
    let silent = changed("agent-settled", json!({ "text": "" }));
    assert_eq!(
        heard(&silent).unwrap().event,
        Event::TurnFinished { answer: None }
    );
}

#[test]
fn a_repeat_has_the_same_id_and_the_next_event_another() {
    let first = event("before-agent-start");
    assert_eq!(event("before-agent-start").id, first.id);
    // The next turn of the same session: the extension counts on.
    let next = changed("before-agent-start", json!({ "at": "m0000000.8" }));
    assert_ne!(heard(&next).unwrap().id, first.id);
    // The same number from another event is another id.
    let same = changed("agent-settled", json!({ "at": "m0000000.2" }));
    assert_ne!(heard(&same).unwrap().id, first.id);
    // Nothing the core keeps, and what is no payload at all.
    let other = changed("tool-call", json!({ "event": "turn_end" }));
    assert!(heard(&other).is_none());
    assert!(heard(b"{}").is_none());
    assert!(heard(br#"{"event": "agent_settled"}"#).is_none());
    assert!(pi().event(&[], b"[]").is_err());
    assert!(pi().event(&[], b"not json").is_err());
}

#[test]
fn nothing_pi_asks_is_answered_by_a_hook() {
    let answer = Answer {
        response: Response::Affirm,
        device_id: None,
        created: Time::ZERO,
        delivered: None,
    };
    let asked = payload("ui-prompt-start");
    assert!(pi().reply(&[], &asked, &answer).is_none());
    let caps = pi().caps();
    assert!(caps.events && caps.resume);
    // It asks for no approval, so none is heard; a dialog is only shown.
    assert_eq!(caps.permissions, None);
    assert_eq!(caps.questions, Some(ReplyVia::Terminal));
}

#[test]
fn pi_runs_with_tasktaps_extension_in_a_folder_it_is_told_to_trust() {
    let extension = Path::new("/data/agents/pi").join("tasktap.mjs");
    let extension = extension.to_string_lossy();
    let argv = pi().launch(&run("Fix it", None, None));
    assert_eq!(
        argv,
        ["pi", "-e", &extension, "--approve", "--", "Fix it"],
        "a new run"
    );
    let model = Some("deepseek/deepseek-flash");
    let argv = pi().launch(&run("Go on", model, Some(SESSION)));
    #[rustfmt::skip]
    assert_eq!(
        argv,
        ["pi", "--model", "deepseek/deepseek-flash", "-e", &extension, "--approve",
         "--session", SESSION, "--", "Go on"],
        "a resume, on the model its session had"
    );
    // Pi takes a message that starts with `@` for a file's name, and one
    // that starts with `-` for an option: neither is read so.
    let argv = pi().launch(&run("@anna asked for this", None, None));
    assert_eq!(argv[argv.len() - 2..], ["--", " @anna asked for this"]);
    let argv = pi().launch(&run("-v is wrong", None, None));
    assert_eq!(argv[argv.len() - 2..], ["--", "-v is wrong"]);
    // The person's words follow the brief.
    let mut both = run("The brief.", None, None);
    both.words = Some("what I said");
    let told = pi().launch(&both).pop().unwrap();
    assert!(told.starts_with("The brief.\n\n---\n") && told.ends_with("\n\nwhat I said"));

    // Typed by hand in a Tasktap shell: the extension alone. The folder's
    // trust is the person's to give.
    let attached = pi().attach(
        Path::new("/opt/tasktap/tasktap"),
        Path::new("/data/agents/pi"),
    );
    assert_eq!(attached, ["-e", &*extension]);
    assert!(pi().probe(Path::new("/x"), Path::new("/y")).is_none());
    assert!(
        pi().environment(Path::new("/x"), Path::new("/y"))
            .is_empty()
    );
    assert!(pi().supported());
}

#[test]
fn the_extension_is_a_file_of_tasktaps_own_that_runs_its_hook() {
    // A path with what a string in JavaScript must escape.
    let exe = Path::new(r#"/Applications/Task "tap"/it's\tasktap"#);
    let files = pi().files(exe);
    let [(name, text)] = files.as_slice() else {
        panic!("{files:?}");
    };
    assert_eq!(*name, "tasktap.mjs");
    let spawned = r#"spawn("/Applications/Task \"tap\"/it's\\tasktap", ["hook", "pi"], "#;
    assert!(text.contains(spawned), "{text}");
    assert!(!text.contains("EXE"));
    // The events it tells of are the ones the adapter knows, and it has no
    // handler that could decide or change anything of the run.
    for event in [
        "session_start",
        "before_agent_start",
        "tool_call",
        "ui_prompt_start",
        "ui_prompt_end",
        "agent_settled",
    ] {
        assert!(text.contains(&format!("tell(\"{event}\"")), "{event}");
    }
    for decides in ["block", "project_trust", "return {"] {
        assert!(!text.contains(decides), "{decides}");
    }
    // Kept in Tasktap's folder for Pi, whole, and left alone when it is there.
    let data = Folder::new("pi-files");
    let home = agents::home(&data.0, pi());
    assert_eq!(home, data.0.join("agents").join("pi"));
    agents::checks::keep(&home, &files).unwrap();
    assert_eq!(&std::fs::read_to_string(home.join(name)).unwrap(), text);
    agents::checks::keep(&home, &files).unwrap();
    let left: Vec<_> = std::fs::read_dir(&home).unwrap().collect();
    assert_eq!(left.len(), 1);
}

#[test]
fn its_runs_get_the_keys_it_is_signed_in_with_and_its_own_folders() {
    let own = pi().variables();
    for name in [
        "DEEPSEEK_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "PI_CODING_AGENT_DIR",
        "PI_CODING_AGENT_SESSION_DIR",
    ] {
        assert!(own.contains(&name), "{name}");
        assert!(agents::variables().contains(&name), "{name}");
    }
    // What a person turned off of its reporting stays off.
    for name in ["PI_OFFLINE", "PI_TELEMETRY", "PI_SKIP_VERSION_CHECK"] {
        assert!(own.contains(&name), "{name}");
    }
    // Where its program is, or a cloud account's sign-in, is not passed on.
    for name in ["PI_PACKAGE_DIR", "AWS_SECRET_ACCESS_KEY"] {
        assert!(!own.contains(&name), "{name}");
    }
}

#[test]
fn pi_is_signed_in_when_it_lists_a_model() {
    let pi = pi().detect();
    assert_eq!(pi.version, ["--version"]);
    assert_eq!((pi.version_of)("1.5.2\n").as_deref(), Some("1.5.2"));
    assert_eq!(pi.account, ["--offline", "--list-models"]);
    // As 1.5.2 printed them, with a key for one provider and with none.
    let listed = "provider  model            context  max-out  thinking  images\n\
                  deepseek  deepseek-flash   1M       384K     yes       yes   \n\
                  deepseek  deepseek-v4-pro  1M       384K     yes       no    \n";
    assert_eq!(
        (pi.account_of)(Some(0), listed),
        (Some(true), Some("deepseek".into()))
    );
    let two = format!("{listed}openai    gpt-6-luna       400K     128K     yes       yes   \n");
    assert_eq!(
        (pi.account_of)(Some(0), &two),
        (Some(true), Some("deepseek, openai".into()))
    );
    let none = "No models available. Use /login to log into a provider via OAuth or API key. See:\n  \
                /opt/pi/docs/providers.md\n  /opt/pi/docs/models.md\n";
    assert_eq!((pi.account_of)(Some(0), none), (Some(false), None));
    // Anything else says neither.
    for (code, said) in [
        (Some(0), ""),
        (Some(1), none),
        (Some(1), listed),
        (None, listed),
        (Some(0), "provider  model  context\n"),
        (Some(1), "Error: Unknown option --list-models"),
    ] {
        assert_eq!((pi.account_of)(code, said), (None, None), "{said}");
    }
}

#[test]
fn pi_places_no_thought() {
    // It has no flag that holds an answer to a schema, and was right in
    // 13 of the evaluation's 14 thoughts: it is not asked.
    assert!(pi().headless().is_none());
}

#[test]
fn what_pi_stops_at_is_read_from_its_terminal_once() {
    // Recorded from 1.5.2 with the folders replaced: a folder with a `.pi`
    // of its own that it was not told to trust; no sign-in for its model,
    // where it starts and drops the prompt; a conversation of another folder.
    for (capture, asks) in [
        (
            "trust-dialog.bin",
            "Pi is asking whether to trust this folder",
        ),
        ("sign-in.bin", "Pi is asking you to sign in"),
        (
            "fork.bin",
            "Pi is asking whether to continue this conversation in another folder",
        ),
    ] {
        let screen = fixture(capture);
        let mut watch = agents::Watch::new(pi().prompts()).unwrap();
        let found: Vec<_> = screen.chunks(7).filter_map(|c| watch.read(c)).collect();
        assert_eq!(found.len(), 1, "{capture}");
        assert_eq!(found[0].asks, asks);
        assert!(watch.read(&screen).is_none(), "{capture}");
    }
}

// Through the binary.

#[test]
fn a_pi_hook_tells_the_core_what_its_run_does() {
    let mut s = Scene::new("pi");
    let (thought, session, mut agent) = s.launch("tea or coffee");
    let log = s.log();
    let launched = log.launched.iter().find(|l| l.session == session);
    let token = serde_json::to_value(&launched.unwrap().token).unwrap();
    let socket = s.data.0.join("core.sock");
    let hook = |name: &str| {
        let mut hook = Command::new(EXE);
        hook.args(["hook", "pi"])
            .env("TASKTAP_SOCKET", &socket)
            .env("TASKTAP_TOKEN", token.as_str().unwrap())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        let mut child = hook.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&payload(name))
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.stdout.is_empty(), "{name}: it prints nothing");
        out.status.code()
    };
    assert_eq!(hook("tool-call"), Some(0));
    // A dialog waits: shown, to be answered in Pi's terminal.
    assert_eq!(hook("ui-prompt-start"), Some(0));
    let q = s.shown();
    let asked = s.w.model.question(q).clone();
    assert_eq!(asked.prompt, "Tea or coffee?");
    assert_eq!(asked.reply_via, ReplyVia::Terminal);
    // Told again, it is the same question.
    assert_eq!(hook("ui-prompt-start"), Some(0));
    assert_eq!(hook("ui-prompt-end"), Some(0));
    s.w.until("the dialog closes", |m| {
        m.question(q).state == QuestionState::Answered
    });
    assert_eq!(s.w.model.session(session).state, SessionState::Working);
    // Settled: the turn finished with what it said last.
    assert_eq!(hook("agent-settled"), Some(0));
    s.w.until("the result", |m| !m.results_of(thought).is_empty());
    assert_eq!(s.w.model.results_of(thought)[0].summary, "Coffee");
    assert_eq!(s.w.model.session(session).resume.as_deref(), Some(SESSION));
    assert_eq!(s.w.model.session(session).state, SessionState::Idle);
    // A sign-in that is missing is no event, and no failure of the hook.
    assert_eq!(hook("session-start-unsigned"), Some(0));
    agent.sync();
}
