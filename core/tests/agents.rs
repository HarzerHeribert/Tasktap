//! The adapters of Claude Code and Codex (design §7, §14 D): what their
//! hooks say in the core's one vocabulary, what a hook that waited prints
//! for each, their command lines, Codex's hook-trust probe and detection.
//! The payloads are recorded from the real tools (Claude Code 2.1.326, Codex
//! 0.169.0) in `tests/fixtures/agents/`, with paths, ids and anything
//! personal replaced, so the suite needs neither tool. The live runs are in
//! `tests/live.rs`, ignored by default.
//!
//! The adapters are pure functions, called here as the `tasktap hook` role
//! calls them; the tests after them go through the binary: a hook that
//! waits on the core, the agent a capture names, detection and a run whose
//! agent needs a check before it starts.

mod common;

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use common::*;
use serde_json::{Value, json};
use tasktap_core::agents::{self, Heard, Run};
use tasktap_proto::call;
use tasktap_proto::{
    Agents, Answer, Ask, Capture, DetectAgents, Event, Mode, PrefPatch, Put, PutTarget,
    QuestionKind, Response, SessionEvent, SessionId, Status, Time,
};

fn payload(agent: &str, name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/agents")
        .join(agent)
        .join(format!("{name}.json"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// The same payload with fields changed.
fn changed(agent: &str, name: &str, fields: Value) -> Vec<u8> {
    let mut p: Value = serde_json::from_slice(&payload(agent, name)).unwrap();
    for (key, value) in fields.as_object().unwrap() {
        p[key] = value.clone();
    }
    p.to_string().into_bytes()
}

fn heard(agent: &str, bytes: &[u8]) -> Option<Heard> {
    let adapter = agents::find(agent).unwrap();
    adapter.event(&[], bytes).unwrap()
}

fn event(agent: &str, name: &str) -> SessionEvent {
    match heard(agent, &payload(agent, name)) {
        Some(Heard::Event(e)) => e,
        other => panic!("{agent} {name}: {other:?}"),
    }
}

fn waits(agent: &str, name: &str) -> Ask {
    match heard(agent, &payload(agent, name)) {
        Some(Heard::Wait(ask)) => ask,
        other => panic!("{agent} {name}: {other:?}"),
    }
}

fn reply(agent: &str, bytes: &[u8], response: Response) -> Option<Value> {
    let answer = Answer {
        response,
        device_id: None,
        created: Time::ZERO,
        delivered: None,
    };
    let adapter = agents::find(agent).unwrap();
    let out = adapter.reply(&[], bytes, &answer)?;
    Some(serde_json::from_str(&out).unwrap())
}

const SESSION: &str = "00000000-0000-4000-8000-000000000001";
const TURN: &str = "00000000-0000-4000-8000-000000000002";
/// A session of the core, whose id a new Claude Code run takes.
const RUN: &str = "01930000-0000-7000-8000-000000000001";

#[test]
fn claude_hooks_map_to_the_one_vocabulary() {
    let ready = event("claude", "session-start");
    assert_eq!(ready.event, Event::Ready);
    assert_eq!(ready.id, format!("SessionStart:{SESSION}:startup"));
    assert_eq!(
        ready.resume.as_deref(),
        Some(SESSION),
        "the handle --resume takes"
    );
    assert!(!ready.subagent && ready.turn.is_none());

    let started = event("claude", "user-prompt-submit");
    let Event::TurnStarted {
        prompt: Some(prompt),
    } = &started.event
    else {
        panic!("{started:?}")
    };
    assert!(prompt.starts_with("First use the AskUserQuestion tool"));
    assert_eq!(started.id, format!("UserPromptSubmit:{TURN}"));

    // Its permission request asks; the tool's own hooks only report.
    assert!(heard("claude", &payload("claude", "pre-tool-use-question")).is_none());
    let asked = waits("claude", "permission-request-question");
    assert_eq!(asked.prompt, "Which color do you prefer?");
    assert_eq!(
        asked.kind,
        QuestionKind::Choice {
            choices: vec!["Red".into(), "Blue".into()]
        }
    );
    assert_eq!(
        asked.detail.as_deref(),
        Some("Red: Choose red.\nBlue: Choose blue.")
    );
    let went_on = event("claude", "post-tool-use-question");
    assert_eq!(
        went_on.event,
        Event::Continued {
            request: Some(asked.request.clone())
        },
        "names the question its hook may still wait on"
    );

    let activity = event("claude", "pre-tool-use-bash");
    assert_eq!(
        activity.event,
        Event::Activity {
            text: "Bash: Write trial text to trial.txt".into()
        }
    );
    let permission = waits("claude", "permission-request-bash");
    assert_eq!(permission.kind, QuestionKind::Confirm);
    assert_eq!(
        permission.prompt,
        "Claude Code asks to run echo trial > trial.txt"
    );
    assert!(
        permission
            .detail
            .unwrap()
            .contains("\"command\": \"echo trial > trial.txt\"")
    );
    assert!(
        permission
            .request
            .starts_with(&format!("PermissionRequest:{TURN}:"))
    );
    assert!(heard("claude", &payload("claude", "post-tool-use-bash")).is_none());
    // Its own hook asked already.
    assert!(heard("claude", &payload("claude", "notification-permission")).is_none());

    let finished = event("claude", "stop");
    assert_eq!(
        finished.event,
        Event::TurnFinished {
            answer: Some("Blue".into())
        }
    );
    assert_eq!(finished.id, format!("Stop:{TURN}"));
}

#[test]
fn claude_payloads_name_their_ids_sub_agents_and_failures() {
    // The same payload is the same event; another turn is another.
    let again = event("claude", "stop");
    assert_eq!(again.id, event("claude", "stop").id);
    let other = changed("claude", "stop", json!({ "prompt_id": "another" }));
    let Some(Heard::Event(other)) = heard("claude", &other) else {
        panic!()
    };
    assert_ne!(other.id, again.id);
    // A sub-agent's hook says so.
    let sub = changed("claude", "pre-tool-use-bash", json!({ "agent_id": "a1" }));
    let Some(Heard::Event(sub)) = heard("claude", &sub) else {
        panic!()
    };
    assert!(sub.subagent);
    // StopFailure, as Claude Code 2.1.326 builds it (not recorded: it
    // needs a failing request).
    let failed = changed(
        "claude",
        "stop",
        json!({ "hook_event_name": "StopFailure", "error": "rate_limit",
                "error_details": "429 Too many requests\nretry later" }),
    );
    let Some(Heard::Event(failed)) = heard("claude", &failed) else {
        panic!()
    };
    assert_eq!(
        failed.event,
        Event::TurnFailed {
            error: Some("429 Too many requests…".into())
        }
    );
    // An MCP server's question is answered in the terminal.
    let elicited = changed(
        "claude",
        "notification-permission",
        json!({ "notification_type": "elicitation_dialog", "message": "Pick a repository" }),
    );
    let Some(Heard::Event(elicited)) = heard("claude", &elicited) else {
        panic!()
    };
    let Event::Question { question } = elicited.event else {
        panic!()
    };
    assert_eq!(
        (question.kind, question.prompt.as_str()),
        (QuestionKind::Text, "Pick a repository")
    );
    // Nothing the core keeps, and nothing that disturbs the tool.
    for name in ["SessionEnd", "SubagentStop", "PreCompact", "NoSuchHook"] {
        let other = changed("claude", "stop", json!({ "hook_event_name": name }));
        assert!(heard("claude", &other).is_none(), "{name}");
    }
    assert!(heard("claude", b"{}").is_none());
    let claude = agents::find("claude").unwrap();
    assert!(claude.event(&[], b"not json").is_err());
    assert!(claude.event(&[], b"[1]").is_err());
}

#[test]
fn claude_hooks_decide_in_its_own_format() {
    let bash = payload("claude", "permission-request-bash");
    let decision = |response| reply("claude", &bash, response).unwrap();
    assert_eq!(
        decision(Response::Affirm),
        json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest",
                "decision": { "behavior": "allow" } } })
    );
    assert_eq!(
        decision(Response::Deny)["hookSpecificOutput"]["decision"]["behavior"],
        "deny"
    );
    // A text answer is "no, and do this instead".
    assert_eq!(
        decision(Response::Text {
            text: "Use a temp file.".into()
        })["hookSpecificOutput"]["decision"],
        json!({ "behavior": "deny", "message": "Use a temp file." })
    );
    assert!(reply("claude", &bash, Response::Terminal).is_none());

    // A question is answered by allowing it with its answers.
    let question = payload("claude", "permission-request-question");
    let input: Value = serde_json::from_slice::<Value>(&question).unwrap()["tool_input"].clone();
    for (response, said) in [
        (Response::Choice { choice: 1 }, "Blue"),
        (
            Response::Text {
                text: "Otter".into(),
            },
            "Otter",
        ),
    ] {
        let out = reply("claude", &question, response).unwrap();
        let decision = &out["hookSpecificOutput"]["decision"];
        assert_eq!(decision["behavior"], "allow");
        assert_eq!(decision["updatedInput"]["questions"], input["questions"]);
        assert_eq!(
            decision["updatedInput"]["answers"],
            json!({ "Which color do you prefer?": said })
        );
    }
    // Only a permission request is answered.
    assert!(reply("claude", &payload("claude", "stop"), Response::Affirm).is_none());
}

#[test]
fn codex_hooks_map_to_the_one_vocabulary() {
    let ready = event("codex", "session-start");
    assert_eq!(ready.event, Event::Ready);
    assert_eq!(
        ready.resume.as_deref(),
        Some(SESSION),
        "the thread codex resume takes"
    );
    let started = event("codex", "user-prompt-submit");
    assert!(matches!(
        started.event,
        Event::TurnStarted { prompt: Some(_) }
    ));
    assert_eq!(started.id, format!("UserPromptSubmit:{TURN}"));

    // request_user_input is shown, and answered in the terminal.
    let asked = event("codex", "pre-tool-use-question");
    let Event::Question { question } = &asked.event else {
        panic!("{asked:?}")
    };
    assert_eq!(question.prompt, "Which color do you prefer?");
    assert_eq!(
        question.kind,
        QuestionKind::Choice {
            choices: vec!["Red".into(), "Blue".into()]
        }
    );
    assert_eq!(
        event("codex", "post-tool-use-question").event,
        Event::Continued { request: None }
    );

    assert_eq!(
        event("codex", "pre-tool-use-bash").event,
        Event::Activity {
            text: "Bash: echo trial > trial.txt".into()
        }
    );
    let permission = waits("codex", "permission-request-bash");
    assert_eq!(permission.kind, QuestionKind::Confirm);
    assert_eq!(
        permission.prompt,
        "Codex asks to run echo trial > trial.txt"
    );
    assert!(heard("codex", &payload("codex", "post-tool-use-bash")).is_none());

    let finished = event("codex", "stop");
    assert_eq!(
        finished.event,
        Event::TurnFinished {
            answer: Some("Red".into())
        }
    );
    // Interrupt, as Codex 0.169 describes its input (not recorded).
    let interrupted = changed("codex", "stop", json!({ "hook_event_name": "Interrupt" }));
    let Some(Heard::Event(interrupted)) = heard("codex", &interrupted) else {
        panic!()
    };
    assert_eq!(interrupted.event, Event::TurnInterrupted);
    assert_eq!(interrupted.id, format!("Interrupt:{TURN}"));
    let sub = changed("codex", "pre-tool-use-bash", json!({ "agent_id": "a1" }));
    let Some(Heard::Event(sub)) = heard("codex", &sub) else {
        panic!()
    };
    assert!(sub.subagent);
    for name in ["SessionEnd", "SubagentStart", "PostCompact"] {
        let other = changed("codex", "stop", json!({ "hook_event_name": name }));
        assert!(heard("codex", &other).is_none(), "{name}");
    }
}

#[test]
fn codex_hooks_decide_in_its_own_format() {
    let bash = payload("codex", "permission-request-bash");
    assert_eq!(
        reply("codex", &bash, Response::Affirm).unwrap(),
        json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest",
                "decision": { "behavior": "allow" } } })
    );
    let denied = reply("codex", &bash, Response::Deny).unwrap();
    assert_eq!(denied["hookSpecificOutput"]["decision"]["behavior"], "deny");
    assert!(reply("codex", &bash, Response::Terminal).is_none());
}

fn run<'a>(prompt: &'a str, model: Option<&'a str>, resume: Option<&'a str>) -> Run<'a> {
    Run {
        session: SessionId::try_from(uuid(RUN)).unwrap(),
        cwd: Path::new("/tmp/project"),
        prompt,
        words: None,
        model,
        resume,
        hook: Path::new("/opt/tasktap/tasktap"),
    }
}

fn uuid(text: &str) -> tasktap_proto::Uuid {
    text.parse().unwrap()
}

#[test]
fn claude_runs_with_its_hooks_its_id_and_auto_approval() {
    let claude = agents::find("claude").unwrap();
    let argv = claude.launch(&run("Fix it", Some("sonnet"), None));
    let settings: Value = serde_json::from_str(&argv[4]).unwrap();
    let rest: Vec<&str> = argv.iter().map(String::as_str).collect();
    assert_eq!(rest[..4], ["claude", "--model", "sonnet", "--settings"]);
    assert_eq!(
        rest[5..],
        [
            "--session-id",
            RUN,
            "--permission-mode",
            "auto",
            "--",
            "Fix it"
        ]
    );
    let hooks = settings["hooks"].as_object().unwrap();
    assert_eq!(hooks.len(), 8);
    let stop = &hooks["Stop"][0]["hooks"][0];
    assert_eq!(
        stop["command"],
        format!("{} hook claude", quoted("/opt/tasktap/tasktap"))
    );
    assert_eq!(hooks["PermissionRequest"][0]["hooks"][0]["timeout"], 600);
    // A resumed run continues the conversation, with the model it had.
    let argv = claude.launch(&run("Go on", Some("sonnet"), Some("abc")));
    let rest: Vec<&str> = argv.iter().map(String::as_str).collect();
    assert_eq!(rest[0], "claude");
    assert_eq!(
        rest[3..],
        [
            "--resume",
            "abc",
            "--permission-mode",
            "auto",
            "--",
            "Go on"
        ]
    );
    assert!(claude.probe(Path::new("/x"), Path::new("/y")).is_none());
}

/// `exe` as the adapters quote it for the shell that runs a hook command.
fn quoted(exe: &str) -> String {
    if cfg!(windows) {
        format!("\"{exe}\"")
    } else {
        format!("'{exe}'")
    }
}

/// The app server's answer to `hooks/list`, recorded on a Mac with the
/// hooks of `/tmp/tasktap`, its commands quoted as this system's adapter
/// quotes them.
fn recorded_hooks() -> String {
    let list = String::from_utf8(payload("codex", "hooks-list")).unwrap();
    let recorded = json!("'/tmp/tasktap' hook codex").to_string();
    let here = json!(format!("{} hook codex", quoted("/tmp/tasktap"))).to_string();
    list.trim().replace(&recorded, &here)
}

#[test]
fn codex_runs_trusted_with_its_hooks_after_a_probe() {
    let codex = agents::find("codex").unwrap();
    let argv = codex.launch(&run("Fix it", Some("o3"), None));
    let rest: Vec<&str> = argv.iter().map(String::as_str).collect();
    assert_eq!(
        rest[..6],
        [
            "codex",
            "--no-daemon",
            "-c",
            r#"projects={"/tmp/project"={trust_level="trusted"}}"#,
            "--model",
            "o3"
        ]
    );
    assert_eq!(rest[rest.len() - 3..], ["--approve-for-me", "--", "Fix it"]);
    let hooks: Vec<&str> = (rest.iter())
        .filter(|a| a.starts_with("hooks."))
        .copied()
        .collect();
    assert_eq!(hooks.len(), 7);
    assert_eq!(
        hooks[4],
        format!(
            "hooks.PermissionRequest=[{{hooks=[{{type=\"command\",command={},timeout=600}}]}}]",
            json!(format!("{} hook codex", quoted("/opt/tasktap/tasktap")))
        )
    );
    let argv = codex.launch(&run("Go on", Some("o3"), Some("t-1")));
    let rest: Vec<&str> = argv.iter().map(String::as_str).collect();
    assert!(
        !rest.contains(&"--model"),
        "a resumed thread keeps its model"
    );
    assert_eq!(
        rest[rest.len() - 5..],
        ["--approve-for-me", "resume", "t-1", "--", "Go on"]
    );

    // The probe asks the app server about the same hooks, and trusts
    // exactly those, with the hashes it gives, plus any the person trusted.
    let probe = codex
        .probe(Path::new("/tmp/tasktap"), Path::new("/tmp/project"))
        .unwrap();
    assert_eq!(probe.argv[0], "codex");
    assert_eq!(
        probe.argv[probe.argv.len() - 3..],
        ["app-server", "--listen", "stdio://"]
    );
    let asked: Vec<Value> = (probe.input.lines())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(asked[2]["method"], "hooks/list");
    assert_eq!(asked[2]["params"]["cwds"], json!(["/tmp/project"]));
    let mut read = probe.read;
    assert!(read(r#"{"id":1,"result":{}}"#).is_none());
    let list = recorded_hooks();
    let more = read(list.trim()).unwrap().unwrap();
    assert_eq!(more[0], "-c");
    let state = &more[1];
    assert!(state.starts_with("hooks.state={"), "{state}");
    assert_eq!(
        state.matches("trusted_hash=\"sha256:").count(),
        7,
        "{state}"
    );
    assert!(state.contains(r#""/<session-flags>/config.toml:stop:0:0"={trusted_hash="#));

    let mut listed: Value = serde_json::from_str(&list).unwrap();
    let hooks = listed["result"]["data"][0]["hooks"].as_array_mut().unwrap();
    let mut own = hooks[0].clone();
    hooks.truncate(6);
    own["key"] = "/Users/person/.codex/config.toml:stop:0:0".into();
    own["source"] = "user".into();
    own["trustStatus"] = "trusted".into();
    let mut untrusted = own.clone();
    untrusted["key"] = "/tmp/project/.codex/config.toml:stop:0:0".into();
    untrusted["trustStatus"] = "untrusted".into();
    hooks.extend([own, untrusted]);
    let probe = codex.probe(Path::new("/tmp/tasktap"), Path::new("/tmp/project"));
    let mut read = probe.unwrap().read;
    let refused = read(&listed.to_string()).unwrap().unwrap_err();
    assert_eq!(
        refused,
        "Codex listed 6 of the 7 hooks Tasktap attaches, so none was trusted"
    );
    let hooks = listed["result"]["data"][0]["hooks"].as_array_mut().unwrap();
    let list: Value = serde_json::from_str(&recorded_hooks()).unwrap();
    hooks.push(list["result"]["data"][0]["hooks"][6].clone());
    let probe = codex.probe(Path::new("/tmp/tasktap"), Path::new("/tmp/project"));
    let mut read = probe.unwrap().read;
    let state = read(&listed.to_string()).unwrap().unwrap()[1].clone();
    assert!(
        state.contains("/Users/person/.codex/config.toml:stop:0:0"),
        "the person's trust is kept"
    );
    assert!(
        !state.contains("/tmp/project/.codex"),
        "nothing else is trusted"
    );
    let error = r#"{"id":2,"error":{"code":-32601,"message":"no such method"}}"#;
    let mut read = codex.probe(Path::new("/x"), Path::new("/y")).unwrap().read;
    assert_eq!(
        read(error).unwrap().unwrap_err(),
        "Codex did not list its hooks: no such method"
    );
}

#[test]
fn each_agent_says_whether_it_is_signed_in_and_as_whom() {
    let claude = agents::find("claude").unwrap().detect();
    assert_eq!(claude.version, ["--version"]);
    assert_eq!(
        (claude.version_of)("2.1.326 (Claude Code)\n").as_deref(),
        Some("2.1.326")
    );
    let status = r#"{"loggedIn": true, "authMethod": "claude.ai", "email": "person@example.com"}"#;
    assert_eq!(
        (claude.account_of)(Some(0), status),
        (Some(true), Some("person@example.com".into()))
    );
    assert_eq!(
        (claude.account_of)(Some(1), r#"{"loggedIn": false}"#),
        (Some(false), None)
    );
    assert_eq!((claude.account_of)(Some(0), "fine"), (None, None));

    let codex = agents::find("codex").unwrap().detect();
    assert_eq!(
        (codex.version_of)("codex-cli 0.169.0\n").as_deref(),
        Some("0.169.0")
    );
    assert_eq!(
        (codex.account_of)(Some(0), "Logged in using ChatGPT\n"),
        (Some(true), Some("ChatGPT".into()))
    );
    assert_eq!(
        (codex.account_of)(Some(1), "Not logged in\n"),
        (Some(false), None)
    );
    assert_eq!((codex.account_of)(None, ""), (None, None));
}

// Through the binary.

#[test]
fn a_claude_hook_waits_on_the_core_and_prints_the_decision() {
    let mut s = Scene::new("ah");
    let (_, session, mut agent) = s.launch("tidy up");
    let log = s.log();
    let token = log
        .launched
        .iter()
        .find(|l| l.session == session)
        .unwrap()
        .token
        .clone();
    let mut hook = Command::new(EXE);
    hook.args(["hook", "claude"])
        .env("TASKTAP_SOCKET", s.data.0.join("core.sock"))
        .env(
            "TASKTAP_TOKEN",
            serde_json::to_value(&token).unwrap().as_str().unwrap(),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut child = hook.spawn().unwrap();
    let request = payload("claude", "permission-request-bash");
    child.stdin.take().unwrap().write_all(&request).unwrap();
    let q = s.shown();
    let asked = s.w.model.question(q).clone();
    assert_eq!(
        asked.prompt,
        "Claude Code asks to run echo trial > trial.txt"
    );
    assert_eq!(asked.reply_via, tasktap_proto::ReplyVia::Core);
    // Stored as what it is: the agent's permission request (design §5).
    assert_eq!(asked.source, tasktap_proto::QuestionSource::Permission);
    let answer = tasktap_proto::AnswerQuestion {
        id: q,
        response: Response::Affirm,
    };
    s.w.ok::<call::QuestionAnswer>(&answer);
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    let printed: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        printed["hookSpecificOutput"]["decision"]["behavior"],
        "allow"
    );
    s.w.until("the receipt", |m| {
        m.question(q)
            .answer
            .as_ref()
            .is_some_and(|a| a.delivered.is_some())
    });
    agent.sync();
}

#[test]
fn claudes_trust_dialog_is_read_from_its_terminal_once() {
    // Claude Code 2.1.326 in a folder it does not trust shows this before
    // anything else, and runs no hook until it is answered; it has no way
    // to trust a folder for one run (design §7). Recorded with the folder
    // replaced; each word is placed with a cursor move, not a space.
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agents/claude/trust-dialog.bin");
    let dialog = std::fs::read(path).unwrap();
    let claude = agents::find("claude").unwrap();
    let mut watch = agents::Watch::new(claude.prompts()).unwrap();
    // In pieces, as the terminal delivers it.
    let found: Vec<_> = dialog.chunks(7).filter_map(|c| watch.read(c)).collect();
    assert_eq!(found.len(), 1);
    assert_eq!(
        found[0].asks,
        "Claude Code is asking whether to trust this folder"
    );
    // Drawn again, it is the same question: nothing new.
    assert!(watch.read(&dialog).is_none());
    let mut other = agents::Watch::new(claude.prompts()).unwrap();
    assert!(other.read(b"Yes, I trust that folder").is_none());
    // Codex is trusted for each run (`-c projects=`): it shows nothing to wait on.
    let codex = agents::find("codex").unwrap();
    assert!(agents::Watch::new(codex.prompts()).is_none());
}

#[test]
fn a_sub_agents_permission_request_opens_nothing_and_waits_for_nothing() {
    // The guards drop what a sub-agent reports; a hook that waited would ask
    // past them, as the main agent.
    for agent in ["claude", "codex"] {
        let sub = changed(
            agent,
            "permission-request-bash",
            json!({ "agent_id": "a1" }),
        );
        assert!(heard(agent, &sub).is_none(), "{agent}");
    }
    let mut s = Scene::new("as");
    let (_, session, mut agent) = s.launch("tidy up");
    let log = s.log();
    let token = log
        .launched
        .iter()
        .find(|l| l.session == session)
        .unwrap()
        .token
        .clone();
    let mut hook = Command::new(EXE);
    hook.args(["hook", "claude"])
        .env("TASKTAP_SOCKET", s.data.0.join("core.sock"))
        .env(
            "TASKTAP_TOKEN",
            serde_json::to_value(&token).unwrap().as_str().unwrap(),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut child = hook.spawn().unwrap();
    let sub = changed(
        "claude",
        "permission-request-bash",
        json!({ "agent_id": "a1" }),
    );
    child.stdin.take().unwrap().write_all(&sub).unwrap();
    let began = std::time::Instant::now();
    while child.try_wait().unwrap().is_none() {
        if began.elapsed() > std::time::Duration::from_secs(10) {
            let _ = child.kill();
            panic!("the hook of a sub-agent waits");
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stdout.is_empty(), "it leaves the decision to the agent");
    agent.sync();
    s.w.sync();
    assert!(s.w.model.questions.is_empty(), "no question opened");
}

#[test]
fn a_new_run_uses_the_captures_agent_else_the_preference_else_the_first() {
    let data = Folder::new("aa");
    let core = Core::start(&data.0);
    let mut w = core.watch();
    let note = |w: &mut Watch, agent: Option<&str>, model: Option<&str>| {
        let id = tasktap_proto::ThoughtId::mint();
        let capture = Capture {
            mode: Some(Mode::Note),
            agent: agent.map(Into::into),
            model: model.map(Into::into),
            ..typed(id, "an idea")
        };
        w.call::<call::ThoughtCapture>(&capture).map(|()| {
            let t = w.model.thought(id);
            (t.agent.clone().unwrap(), t.model.clone())
        })
    };
    assert_eq!(note(&mut w, None, None).unwrap().0, "claude");
    assert_eq!(
        note(&mut w, Some("codex"), Some("o3")).unwrap(),
        ("codex".into(), Some("o3".into()))
    );
    let prefer = |w: &mut Watch, agent: &str| {
        let target = PutTarget::Prefs(PrefPatch::Agent(Some(agent.into())));
        w.ok::<call::Put>(&Put {
            target,
            if_rev: None,
        });
    };
    prefer(&mut w, "codex");
    assert_eq!(note(&mut w, None, None).unwrap().0, "codex");
    assert_eq!(note(&mut w, Some("claude"), None).unwrap().0, "claude");
    // A preference for an agent this build lacks is passed over.
    prefer(&mut w, "nobody");
    assert_eq!(note(&mut w, None, None).unwrap().0, "claude");
    for (agent, model) in [
        (Some("nobody"), None),
        (None, Some("--yolo")),
        (None, Some("")),
    ] {
        let e = note(&mut w, agent, model).unwrap_err();
        assert_eq!(e.code, tasktap_proto::Code::Invalid, "{agent:?} {model:?}");
    }
}

#[test]
fn detection_runs_each_agents_own_commands() {
    let data = Folder::new("ad");
    let core = Core::with_agents(&data.0);
    let mut c = core.device();
    let asked = DetectAgents {
        agents: Some(vec!["fixture".into()]),
    };
    let Agents { agents } = c.call::<call::AgentsDetect>(&asked).unwrap().unwrap();
    assert_eq!(agents.len(), 1);
    let fixture = &agents[0];
    assert_eq!(fixture.id, "fixture");
    assert!(fixture.installed && fixture.events);
    assert_eq!(fixture.version.as_deref(), Some("fixture 1.0"));
    assert_eq!(
        (fixture.signed_in, fixture.identity.as_deref()),
        (Some(true), Some("fixture"))
    );
    let unknown = DetectAgents {
        agents: Some(vec!["nobody".into()]),
    };
    let e = c.call::<call::AgentsDetect>(&unknown).unwrap().unwrap_err();
    assert_eq!(e.code, tasktap_proto::Code::Invalid);
}

#[test]
fn the_agents_are_detected_as_the_core_starts_and_again_when_asked() {
    let data = Folder::new("aa");
    let path = path_with(&agents(&data.0));
    let core = Core::start_env(&data.0, &["--detect"], &[("PATH", &path)]);
    let mut w = core.watch();
    // Detected off the core's thread as it starts: the rows come as a change.
    w.until("the agents are detected", |m| m.agents.len() == 3);
    // A build with the test fixtures detects only the fixture agents, so no
    // test runs a real agent's commands.
    let ids: Vec<&str> = w.model.agents.keys().map(String::as_str).collect();
    assert_eq!(ids, ["fixture", "fixture-probed", "fixture-silent"]);
    let fixture = w.model.agents["fixture"].clone();
    assert!(fixture.installed && fixture.events);
    assert_eq!(
        (
            fixture.version.as_deref(),
            fixture.signed_in,
            fixture.identity.as_deref()
        ),
        (Some("fixture 1.0"), Some(true), Some("fixture"))
    );
    assert!(fixture.checked > tasktap_proto::Time::ZERO);
    // A fresh subscriber's snapshot holds them.
    assert_eq!(core.watch().model.agents.len(), 3);
    // agents.detect puts the rows it found again, at a new revision.
    let asked = DetectAgents {
        agents: Some(vec!["fixture".into()]),
    };
    let Agents { agents } = w.ok::<call::AgentsDetect>(&asked);
    assert_eq!(agents.len(), 1);
    assert!(agents[0].rev > fixture.rev);
    w.until("the row changes", |m| {
        m.agents["fixture"].rev == agents[0].rev
    });
    assert_eq!(w.model.agents["fixture"], agents[0]);

    // Without being asked to, such a build detects nothing as it starts.
    let quiet = Folder::new("ab");
    let core = Core::start_env(&quiet.0, &[], &[("PATH", &path)]);
    let mut w = core.watch();
    w.sync();
    assert!(w.model.agents.is_empty());
}

#[test]
fn a_run_whose_agent_needs_a_check_starts_once_it_passed() {
    let mut s = Scene::real("ap", "fixture-probed");
    let t = s.capture("tidy up");
    s.tick(HOLD_MS);
    assert_eq!(s.w.model.status(t), Status::Working);
    let session = s.w.model.thought(t).session_id.unwrap();
    s.w.until("the run starts after its check", |m| {
        m.session(session).terminal_id.is_some()
    });
    let terminal = s.w.model.session(session).terminal_id.unwrap();
    let argv = &s.w.model.terminals[&terminal].argv;
    assert_eq!(
        argv[1], "--probed",
        "the check's arguments follow the program: {argv:?}"
    );
    let mut screen = Screen::open(&s.core, terminal);
    screen.until("fixture-agent --probed --hook");
    screen.line("event:ready");
    s.w.until("its hooks report", |m| {
        m.session(session).state == tasktap_proto::SessionState::Idle
    });
}

// Asked headless (design §8): the command line of each tool, its answer in
// what it really printed, and what a run is told with a brief.

/// What a tool printed for a routing question, as recorded from it.
fn printed(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/agents")
        .join(name);
    std::fs::read_to_string(path).unwrap()
}

fn headless(agent: &str) -> agents::Headless {
    agents::find(agent).unwrap().headless().unwrap()
}

#[test]
fn each_tool_is_asked_with_no_tools_nothing_saved_and_its_smallest_model() {
    let schema = agents::Schema {
        text: r#"{"type":"object"}"#,
        file: Path::new("/data/route/schema.json"),
    };
    let has = |args: &[String], flags: &[&str]| args.windows(flags.len()).any(|w| w == flags);

    let claude = headless("claude");
    let args = (claude.args)(&schema);
    assert_eq!(claude.model, "haiku");
    let flags: [&[&str]; 9] = [
        &["-p"],
        &["--model", "haiku"],
        &["--tools", ""],
        &["--strict-mcp-config"],
        &["--disable-slash-commands"],
        &["--safe-mode"],
        &["--no-session-persistence"],
        &["--output-format", "json"],
        &["--json-schema", schema.text],
    ];
    for flag in flags {
        assert!(has(&args, flag), "{flag:?} in {args:?}");
    }
    // Every argument is one line, so a shell wrapper around the tool takes it.
    assert!(args.iter().all(|a| !a.contains('\n')), "{args:?}");

    let codex = headless("codex");
    let args = (codex.args)(&schema);
    assert_eq!(codex.model, "gpt-6-luna");
    assert_eq!(args[..3], ["--ask-for-approval", "never", "exec"]);
    let flags: [&[&str]; 9] = [
        &["--ignore-user-config"],
        &["--ignore-rules"],
        &["--ephemeral"],
        &["--disable", "shell_tool"],
        &["--disable", "unified_exec"],
        &["-c", "project_doc_max_bytes=0"],
        &["-c", "web_search=\"disabled\""],
        &["--sandbox", "read-only"],
        &["--model", "gpt-6-luna"],
    ];
    for flag in flags {
        assert!(has(&args, flag), "{flag:?} in {args:?}");
    }
    // The schema as a file, and the question on standard input.
    assert_eq!(
        args[args.len() - 3..],
        ["--output-schema", "/data/route/schema.json", "-"]
    );
}

#[test]
fn each_tools_answer_is_read_from_what_it_really_printed() {
    let claude = headless("claude");
    let all = printed("claude/headless-answer.json");
    let answer: Value = serde_json::from_str(&(claude.answer)(&all).unwrap()).unwrap();
    assert_eq!(
        (answer["confidence"].as_str(), answer["to"].as_str()),
        (Some("clear"), Some("p3"))
    );
    assert!(answer["brief"].as_str().unwrap().contains("paginate"));
    // The core takes it as it is.
    assert_eq!(answer.as_object().unwrap().len(), 6);
    // A part of it is no answer: the tool is read until one is whole.
    assert!((claude.answer)(&all[..all.len() / 2]).is_err());
    assert!((claude.answer)("").is_err());
    // What it prints when it reached no model says why.
    let why = (claude.answer)(&printed("claude/headless-error.json")).unwrap_err();
    assert!(why.contains("issue with the selected model"), "{why}");

    let codex = headless("codex");
    let all = printed("codex/headless-answer.json");
    let answer: Value = serde_json::from_str(&(codex.answer)(&all).unwrap()).unwrap();
    assert_eq!(
        (answer["confidence"].as_str(), answer["to"].as_str()),
        (Some("clear"), Some("s1"))
    );
    assert!((codex.answer)(&all[..all.len() / 2]).is_err());
    // It prints nothing there when it fails; why is on its other output.
    assert!((codex.answer)("\n").is_err());
}

#[test]
fn the_persons_words_follow_the_brief_as_each_agent_takes_them() {
    let (brief, words) = ("Fix the stutter.", "um, that thing, it stutters, fix it");
    let frame = "The text above is a brief written from what the person said. \
                 What they said follows, word for word; where the two differ, their words count.";
    let claude = agents::find("claude").unwrap();
    assert_eq!(
        claude.told(brief, words),
        format!("{brief}\n\n{frame}\n<persons_words>\n{words}\n</persons_words>")
    );
    let codex = agents::find("codex").unwrap();
    assert_eq!(
        codex.told(brief, words),
        format!("{brief}\n\n---\n{frame}\n\n{words}")
    );
    // A run is told both, as its last argument; without a brief that
    // differs, the words alone, once.
    for agent in [claude, codex] {
        let both = Run {
            words: Some(words),
            ..run(brief, None, None)
        };
        assert_eq!(agent.launch(&both).last(), Some(&agent.told(brief, words)));
        let argv = agent.launch(&run(words, None, None));
        assert_eq!(argv.last().map(String::as_str), Some(words));
    }
}
