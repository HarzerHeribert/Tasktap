//! The adapter of OpenCode (design §7): what its plugin's payloads say in
//! the core's one vocabulary, what a hook that waited prints for the
//! plugin, its command lines, the file and the variable a run is given, and
//! detection. The payloads are what the plugin gave the hook in runs of
//! the real tool (OpenCode 2.3.0), kept in `tests/fixtures/agents/opencode`
//! with their ids replaced, so the suite needs no OpenCode. Its live run is
//! in `tests/live.rs`, ignored by default.

mod common;

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use common::*;
use serde_json::{Value, json};
use tasktap_core::agents::{self, Agent, Heard, Run};
use tasktap_proto::call;
use tasktap_proto::{
    Answer, Ask, Event, QuestionKind, QuestionSource, ReplyVia, Response, SessionEvent, SessionId,
    Time,
};

const TALK: &str = "ses_01fixture";

fn opencode() -> &'static dyn Agent {
    agents::find("opencode").unwrap()
}

fn recorded(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/agents/opencode")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn payload(name: &str) -> Vec<u8> {
    recorded(&format!("{name}.json"))
}

/// The same payload with a value changed, at a JSON pointer.
fn changed(name: &str, pointer: &str, value: Value) -> Vec<u8> {
    let mut p: Value = serde_json::from_slice(&payload(name)).unwrap();
    *p.pointer_mut(pointer).unwrap() = value;
    p.to_string().into_bytes()
}

fn heard(bytes: &[u8]) -> Option<Heard> {
    opencode().event(&[], bytes).unwrap()
}

fn event(name: &str) -> SessionEvent {
    match heard(&payload(name)) {
        Some(Heard::Event(e)) => e,
        other => panic!("{name}: {other:?}"),
    }
}

fn waits(bytes: &[u8]) -> Ask {
    match heard(bytes) {
        Some(Heard::Wait(ask)) => ask,
        other => panic!("{other:?}"),
    }
}

fn reply(bytes: &[u8], response: Response) -> Option<Value> {
    let answer = Answer {
        response,
        device_id: None,
        created: Time::ZERO,
        delivered: None,
    };
    let out = opencode().reply(&[], bytes, &answer)?;
    assert!(!out.contains('\n'), "one line: {out}");
    Some(serde_json::from_str(&out).unwrap())
}

fn run<'a>(prompt: &'a str, model: Option<&'a str>, resume: Option<&'a str>) -> Run<'a> {
    Run {
        session: SessionId::try_from(
            "01930000-0000-7000-8000-000000000001"
                .parse::<tasktap_proto::Uuid>()
                .unwrap(),
        )
        .unwrap(),
        cwd: Path::new("/tmp/project"),
        prompt,
        words: None,
        model,
        resume,
        hook: Path::new("/opt/tasktap/tasktap"),
        home: Path::new("/data/agents/opencode"),
        allowed: &[],
        args: &[],
    }
}

#[test]
fn its_events_map_to_the_one_vocabulary() {
    // The plugin is set up: ready, before any session.
    let ready = event("ready");
    assert_eq!((ready.id.as_str(), &ready.event), ("ready", &Event::Ready));
    assert_eq!(ready.resume, None);
    // What a person tells it, at its start or typed in its terminal, opens
    // a turn with those words.
    let told = event("inbox-enqueued");
    let Event::TurnStarted {
        prompt: Some(prompt),
    } = &told.event
    else {
        panic!("{told:?}");
    };
    assert!(prompt.starts_with("Tasktap test: run the shell command"));
    assert_eq!(told.resume.as_deref(), Some(TALK));
    // What a sub-agent brings back is given to it the same way, and is no
    // prompt.
    let brought = changed("inbox-enqueued", "/data/item/type", json!("synthetic"));
    assert!(heard(&brought).is_none());
    // Its work starts: the turn the prompt opened goes on, or one starts by
    // itself, as when a sub-agent it left at work is done.
    let started = event("execution-started");
    assert_eq!(started.event, Event::TurnStarted { prompt: None });
    // Each event has the id the server gave it and the session's, which
    // `--session` takes; it numbers no turns, and none is a sub-agent's.
    assert_eq!(started.id, "evt_01fixture");
    assert_eq!(started.resume.as_deref(), Some(TALK));
    assert_eq!((started.turn, started.subagent), (None, false));
    // A tool it runs, named by the plugin: the call itself names none.
    let shell = event("tool-called-shell");
    let text = "shell: echo Red".to_owned();
    assert_eq!(shell.event, Event::Activity { text });
    assert_eq!(shell.resume.as_deref(), Some(TALK));
    // Its question tool is no activity: the form it makes asks.
    assert!(heard(&payload("tool-called-question")).is_none());
    // The turn's end, with the last text it said.
    let finished = event("execution-succeeded");
    let answer = Some("You chose red, and the echo command confirmed it.".to_owned());
    assert_eq!(finished.event, Event::TurnFinished { answer });
    assert_eq!(finished.resume.as_deref(), Some(TALK));
    // A turn that said nothing has no answer.
    let mut silent: Value = serde_json::from_slice(&payload("execution-succeeded")).unwrap();
    silent.as_object_mut().unwrap().remove("text");
    let Some(Heard::Event(silent)) = heard(silent.to_string().as_bytes()) else {
        panic!("an event");
    };
    assert_eq!(silent.event, Event::TurnFinished { answer: None });
    // A failure says why in its first line; one without a message, as it is.
    let failed = event("execution-failed");
    let Event::TurnFailed { error: Some(why) } = &failed.event else {
        panic!("{failed:?}");
    };
    assert!(why.starts_with("Authentication Fails, Your api key: ****test is invalid"));
    let bare = changed("execution-failed", "/data/error", json!({ "type": "x" }));
    let Some(Heard::Event(bare)) = heard(&bare) else {
        panic!("an event");
    };
    let error = Some(r#"{"type":"x"}"#.to_owned());
    assert_eq!(bare.event, Event::TurnFailed { error });
    // Stopped by the person, or by a question they dismissed.
    assert_eq!(event("execution-interrupted").event, Event::TurnInterrupted);
    // Ended because a new prompt took its place: that prompt said so.
    let superseded = changed("execution-interrupted", "/data/reason", json!("superseded"));
    assert!(heard(&superseded).is_none());
    // Every event has its own id, so a repeat is ignored and the next is not.
    let ids: Vec<String> = [
        "inbox-enqueued",
        "execution-started",
        "tool-called-shell",
        "permission-replied",
        "form-replied",
        "execution-succeeded",
    ]
    .iter()
    .map(|name| event(name).id)
    .collect();
    let mut once = ids.clone();
    once.sort();
    once.dedup();
    assert_eq!(once.len(), ids.len(), "{ids:?}");
    assert_eq!(event("execution-started").id, started.id);
    // What the core keeps nothing of, and what is no payload at all.
    for other in [
        json!({ "id": "evt_1", "type": "session.text.ended", "data": { "sessionID": TALK } }),
        json!({ "id": "evt_1", "type": "session.execution.started" }),
        json!({ "type": "session.execution.started", "data": { "sessionID": TALK } }),
        json!({ "data": {} }),
    ] {
        assert!(heard(other.to_string().as_bytes()).is_none(), "{other}");
    }
    assert!(opencode().event(&[], b"not json").is_err());
}

#[test]
fn a_permission_request_waits_and_is_decided_by_what_the_hook_prints() {
    let request = payload("permission-asked");
    let ask = waits(&request);
    assert_eq!(ask.request, "per_01fixture");
    assert_eq!(ask.prompt, "OpenCode asks to run echo Red");
    assert_eq!(ask.kind, QuestionKind::Confirm);
    assert_eq!(ask.source, Some(QuestionSource::Permission));
    assert!(ask.detail.unwrap().contains("echo Red"));
    // Another action names what it touches.
    let edit = changed("permission-asked", "/data/action", json!("edit"));
    assert_eq!(waits(&edit).prompt, "OpenCode asks to use edit: echo Red");
    // Allowed once; denied, with the person's reason when they gave one.
    assert_eq!(
        reply(&request, Response::Affirm),
        Some(json!({ "decision": "once" }))
    );
    let denied = reply(&request, Response::Deny).unwrap();
    assert_eq!(denied["decision"], "reject");
    assert_eq!(denied["message"], "The person denied this in Tasktap.");
    let text = "use printf".to_owned();
    assert_eq!(
        reply(&request, Response::Text { text }),
        Some(json!({ "decision": "reject", "message": "use printf" }))
    );
    // Answered in its terminal first: the hook prints nothing.
    assert!(reply(&request, Response::Terminal).is_none());
    assert!(reply(&request, Response::Choice { choice: 0 }).is_none());
    // Its answer, there or through the hook, settles the request.
    let request = Some("per_01fixture".to_owned());
    assert_eq!(
        event("permission-replied").event,
        Event::Continued { request }
    );
}

#[test]
fn a_form_with_one_question_waits_and_is_answered_by_what_the_hook_prints() {
    let form = payload("form-created");
    let ask = waits(&form);
    assert_eq!(ask.request, "frm_01fixture");
    assert_eq!(ask.prompt, "Do you prefer red or blue?");
    let choices = vec!["Red".to_owned(), "Blue".to_owned()];
    assert_eq!(ask.kind, QuestionKind::Choice { choices });
    assert_eq!(
        ask.detail.as_deref(),
        Some("Red: Choose red\nBlue: Choose blue")
    );
    assert_eq!(ask.source, None);
    // The chosen option's value, or the person's own text, under the
    // field's key.
    assert_eq!(
        reply(&form, Response::Choice { choice: 1 }),
        Some(json!({ "answer": { "q0": "Blue" } }))
    );
    let text = "green".to_owned();
    assert_eq!(
        reply(&form, Response::Text { text }),
        Some(json!({ "answer": { "q0": "green" } }))
    );
    // Not answered: the form is dismissed, as Escape does in its dialog.
    assert_eq!(
        reply(&form, Response::Deny),
        Some(json!({ "cancel": true }))
    );
    for none in [
        Response::Terminal,
        Response::Affirm,
        Response::Choice { choice: 2 },
    ] {
        assert!(reply(&form, none.clone()).is_none(), "{none:?}");
    }
    // A question with no options takes a text; a yes or no, a confirmation.
    let open = changed("form-created", "/data/form/fields/0/options", json!([]));
    assert_eq!(waits(&open).kind, QuestionKind::Text);
    let field = json!({ "key": "ok", "title": "Go on?", "type": "boolean" });
    let yes_or_no = changed("form-created", "/data/form/fields", json!([field]));
    let ask = waits(&yes_or_no);
    assert_eq!(
        (ask.prompt.as_str(), ask.kind),
        ("Go on?", QuestionKind::Confirm)
    );
    assert_eq!(
        reply(&yes_or_no, Response::Affirm),
        Some(json!({ "answer": { "ok": true } }))
    );
    assert_eq!(
        reply(&yes_or_no, Response::Deny),
        Some(json!({ "answer": { "ok": false } }))
    );
    let text = "maybe".to_owned();
    assert!(reply(&yes_or_no, Response::Text { text }).is_none());
    // Answered or dismissed, there or through the hook, it is settled.
    let request = Some("frm_01fixture".to_owned());
    assert_eq!(event("form-replied").event, Event::Continued { request });
    let request = Some("frm_01fixture".to_owned());
    assert_eq!(event("form-cancelled").event, Event::Continued { request });
}

#[test]
fn a_form_with_several_questions_is_answered_in_the_terminal() {
    let several = event("form-created-several");
    assert_eq!(several.id, "evt_01fixture");
    assert_eq!(several.resume.as_deref(), Some(TALK));
    let Event::Question { question } = several.event else {
        panic!("{several:?}");
    };
    assert_eq!(question.request, "frm_01fixture");
    assert_eq!(question.prompt, "What is your favourite colour?");
    assert_eq!(question.kind, QuestionKind::Text);
    assert_eq!(
        question.detail.as_deref(),
        Some("What is your favourite colour?\nWhich fruits do you like? (several may be chosen)")
    );
    // No hook waits on it, so none prints an answer.
    let form = payload("form-created-several");
    assert!(reply(&form, Response::Choice { choice: 0 }).is_none());
    // So is one question with several answers.
    let mut one: Value = serde_json::from_slice(&form).unwrap();
    one["data"]["form"]["fields"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    let Some(Heard::Event(many)) = heard(one.to_string().as_bytes()) else {
        panic!("answered in the terminal");
    };
    assert!(matches!(many.event, Event::Question { .. }));
}

#[test]
fn it_runs_with_a_server_of_its_own_and_its_plugin_named_by_a_variable() {
    let agent = opencode();
    assert_eq!(
        (agent.id(), agent.name(), agent.program()),
        ("opencode", "OpenCode", "opencode")
    );
    // A new run: a server of its own, which ends with its terminal, and
    // the prompt as one argument, so that it may begin with a dash. Its
    // interface takes no model.
    let argv = agent.launch(&run("--fix it", Some("deepseek/deepseek-flash"), None));
    assert_eq!(argv, ["opencode", "--standalone", "--prompt=--fix it"]);
    // A resumed run continues the session.
    let argv = agent.launch(&run("Go on", None, Some("ses_abc")));
    assert_eq!(
        argv,
        [
            "opencode",
            "--standalone",
            "--session",
            "ses_abc",
            "--prompt=Go on"
        ]
    );
    // Typed by hand it gets no argument: the server is the person's choice.
    let (exe, home) = (
        Path::new("/opt/tasktap/tasktap"),
        Path::new("/data/agents/opencode"),
    );
    assert!(agent.attach(exe, home).is_empty());
    assert!(agent.probe(exe, Path::new("/y")).is_none());
    // The plugin is one file in Tasktap's folder, the part OpenCode's
    // terminal interface loads, and runs this program's hook.
    let space = Path::new("/Applications/Task tap/it's \"tasktap\"");
    let files = agent.files(space);
    let [(path, plugin)] = files.as_slice() else {
        panic!("one file: {files:?}");
    };
    assert_eq!(*path, "plugin/tui.js");
    assert!(plugin.contains(r#"const TASKTAP = "/Applications/Task tap/it's \"tasktap\"";"#));
    assert!(!plugin.contains("@TASKTAP@"));
    assert!(plugin.contains(r#"spawn(TASKTAP, ["hook", "opencode"]"#));
    // Every event the adapter reads is one the plugin gives the hook.
    for kind in [
        "session.inbox.enqueued",
        "session.execution.started",
        "session.execution.succeeded",
        "session.execution.failed",
        "session.execution.interrupted",
        "session.tool.called",
        "permission.asked",
        "permission.replied",
        "form.created",
        "form.replied",
        "form.cancelled",
    ] {
        assert!(plugin.contains(&format!("\"{kind}\"")), "{kind}");
    }
    // Its folder is named for the run by the variable OpenCode lays over
    // the person's own settings of its interface: nothing of theirs is
    // written.
    let env = agent.environment(exe, Path::new("/data dir/agents/opencode"));
    let [(name, value)] = env.as_slice() else {
        panic!("one variable: {env:?}");
    };
    assert_eq!(*name, "OPENCODE_CLI_CONFIG_CONTENT");
    let settings: Value = serde_json::from_str(value).unwrap();
    // As this system writes the path of a folder in it.
    let folder = Path::new("/data dir/agents/opencode").join("plugin");
    assert_eq!(settings, json!({ "plugins": [folder.to_string_lossy()] }));
    let caps = agent.caps();
    assert!(caps.events && caps.resume);
    let core = Some(ReplyVia::Core);
    assert_eq!((caps.permissions, caps.questions), (core, core));
    // It shows nothing to wait on before it is ready: it asks for no trust
    // in a folder and runs signed out, on the models it offers for free.
    assert!(agents::Watch::new(agent.prompts()).is_none());
    // It answers no question without a session: `opencode run` keeps one
    // in the person's store, so it places no thought.
    assert!(agent.headless().is_none());
    assert_eq!(
        agent.told("Brief.", "my words"),
        agents::find("agy").unwrap().told("Brief.", "my words")
    );
}

#[test]
fn it_is_signed_in_when_it_lists_an_account() {
    let detect = opencode().detect();
    assert_eq!(detect.version, ["--version"]);
    assert_eq!(
        (detect.version_of)("opencode v2.3.0\n").as_deref(),
        Some("2.3.0")
    );
    assert_eq!(
        detect.account,
        ["auth", "list", "--standalone", "--format", "json"]
    );
    // What it listed, with the account's own id and label replaced: the
    // integration's name is all that is kept.
    let listed = String::from_utf8(recorded("auth-list.json")).unwrap();
    assert_eq!(
        (detect.account_of)(Some(0), &listed),
        (Some(true), Some("OpenCode Console".into()))
    );
    // No account says nothing either way: it runs without one. Neither
    // does a failure, or an integration with no connection.
    let unconnected = r#"[{"id":"opencode","name":"OpenCode Console","connections":[]}]"#;
    for (code, out) in [
        (Some(0), "[]\n"),
        (Some(0), unconnected),
        (Some(1), listed.as_str()),
        (Some(0), "No authenticated integrations\n"),
        (None, ""),
    ] {
        assert_eq!((detect.account_of)(code, out), (None, None), "{out}");
    }
}

// Through the binary.

#[test]
fn its_hook_waits_on_the_core_and_prints_the_answer_for_the_plugin() {
    let mut s = Scene::new("oc");
    let (_, session, mut agent) = s.launch("tidy up");
    let log = s.log();
    let launched = log.launched.iter().find(|l| l.session == session);
    let token = launched.unwrap().token.clone();
    let mut hook = Command::new(EXE);
    hook.args(["hook", "opencode"])
        .env("TASKTAP_SOCKET", s.data.0.join("core.sock"))
        .env(
            "TASKTAP_TOKEN",
            serde_json::to_value(&token).unwrap().as_str().unwrap(),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut child = hook.spawn().unwrap();
    let form = payload("form-created");
    child.stdin.take().unwrap().write_all(&form).unwrap();
    let q = s.shown();
    let asked = s.w.model.question(q).clone();
    assert_eq!(asked.prompt, "Do you prefer red or blue?");
    assert_eq!(asked.reply_via, ReplyVia::Core);
    let answer = tasktap_proto::AnswerQuestion {
        id: q,
        response: Response::Choice { choice: 1 },
    };
    s.w.ok::<call::QuestionAnswer>(&answer);
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    let printed: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(printed, json!({ "answer": { "q0": "Blue" } }));
    s.w.until("the receipt", |m| {
        let answer = m.question(q).answer.as_ref();
        answer.is_some_and(|a| a.delivered.is_some())
    });
    agent.sync();
}
