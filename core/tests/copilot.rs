//! The adapter of GitHub Copilot's command line agent (design §7), `copilot`
//! 1.0.114. Every payload, transcript and screen in
//! `tests/fixtures/agents/copilot/` is one the real tool wrote, run in a home
//! of its own on DeepSeek's `deepseek-flash` through its own-endpoint
//! settings: a run whose command was allowed by its `permissionRequest`
//! hook, a follow-up whose `ask_user` question was answered in its terminal,
//! and a resume on a refused key. The transcripts keep the steps of a turn
//! and leave out the system prompt.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tasktap_core::agents::{self, Agent, Heard, Run};
use tasktap_proto::{
    AgentHealth, Answer, Event, QuestionKind, QuestionSource, ReplyVia, Response, SessionEvent,
    SessionId, Time, Uuid,
};

const ID: &str = "copilot";
const SESSION: &str = "e4af4090-8156-45c1-9003-6e53a49e3f8e";
const CALL: &str = "call_00_ET_mdd5LS0GCNGj6ULGNAIq0195";

fn copilot() -> &'static dyn Agent {
    agents::find(ID).unwrap()
}

fn fixture(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/agents/copilot")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn text(name: &str) -> String {
    String::from_utf8(fixture(name)).unwrap()
}

fn payload(name: &str) -> Vec<u8> {
    fixture(&format!("{name}.json"))
}

/// What the hook of `event` hears of the payload `name`.
fn heard(event: &str, name: &str) -> Option<Heard> {
    copilot().event(&[event.into()], &payload(name)).unwrap()
}

fn event(event: &str, name: &str) -> SessionEvent {
    match heard(event, name) {
        Some(Heard::Event(e)) => e,
        other => panic!("{name}: {other:?}"),
    }
}

fn run<'a>(prompt: &'a str, model: Option<&'a str>, resume: Option<&'a str>) -> Run<'a> {
    let session: Uuid = "01930000-0000-7000-8000-000000000001".parse().unwrap();
    Run {
        session: SessionId::try_from(session).unwrap(),
        cwd: Path::new("/tmp/project"),
        prompt,
        words: None,
        model,
        resume,
        hook: Path::new("/opt/tasktap/tasktap"),
        home: Path::new("/data/agents/copilot"),
        allowed: &[],
        args: &[],
    }
}

#[test]
fn its_hooks_map_to_the_one_vocabulary() {
    let ready = event("sessionStart", "session-start");
    assert_eq!(ready.event, Event::Ready);
    // Every payload names the session, the handle `--resume` takes, and
    // the time in milliseconds, which with the hook's name is the id.
    assert_eq!(ready.resume.as_deref(), Some(SESSION));
    assert_eq!(ready.id, "sessionStart:1795077323027");
    assert!(!ready.subagent);
    // A resumed session starts again, and says so.
    let again = event("sessionStart", "session-start-resume");
    assert_eq!(again.event, Event::Ready);
    assert_ne!(again.id, ready.id);

    let prompt = "Tasktap test: use your shell tool to run the command `touch tasktap-live.txt`, \
                  then reply with only this word and nothing else: started";
    assert_eq!(
        event("userPromptSubmitted", "user-prompt-submitted").event,
        Event::TurnStarted {
            prompt: Some(prompt.into())
        }
    );
    let shell = event("preToolUse", "pre-tool-use-bash");
    assert_eq!(
        shell.event,
        Event::Activity {
            text: "bash: Create tasktap-live.txt file".into()
        }
    );
    assert!(shell.id.starts_with("preToolUse:call_"), "{}", shell.id);

    // Its question tool asks in its terminal: shown, with what it offers.
    let asked = event("preToolUse", "pre-tool-use-ask-user");
    assert_eq!(asked.id, format!("ask_user:{CALL}"));
    let Event::Question { question } = asked.event else {
        panic!("a question: {asked:?}")
    };
    assert_eq!(question.request, format!("ask_user:{CALL}"));
    assert_eq!(question.prompt, "Tea or coffee?");
    assert_eq!(question.kind, QuestionKind::Text);
    assert_eq!(question.detail.as_deref(), Some("Tea\nCoffee"));
    assert_eq!(question.source, None);
    // Its result closes it, as answered in the terminal.
    let answered = event("postToolUse", "post-tool-use-ask-user");
    assert_eq!(
        answered.event,
        Event::Continued {
            request: Some(format!("ask_user:{CALL}"))
        }
    );
    let failed = copilot()
        .event(
            &["postToolUseFailure".into()],
            &payload("post-tool-use-ask-user"),
        )
        .unwrap();
    assert!(matches!(
        failed,
        Some(Heard::Event(SessionEvent {
            event: Event::Continued { .. },
            ..
        }))
    ));
}

#[test]
fn what_it_does_not_report_maps_to_nothing() {
    // Another tool's result, its notice that it asks (the question is heard
    // from its tool), the end of the session (the core sees the exit), and
    // a hook it was not given.
    assert!(heard("postToolUse", "post-tool-use-bash").is_none());
    assert!(heard("notification", "notification-elicitation").is_none());
    assert!(heard("sessionEnd", "session-end").is_none());
    assert!(heard("subagentStop", "agent-stop").is_none());
    // With no event named, nothing; with no JSON object, an error.
    assert!(
        copilot()
            .event(&[], &payload("agent-stop"))
            .unwrap()
            .is_none()
    );
    assert!(copilot().event(&["agentStop".into()], b"[1]").is_err());
}

#[test]
fn its_permission_request_is_answered_from_the_core() {
    let Some(Heard::Wait(ask)) = heard("permissionRequest", "permission-request-bash") else {
        panic!("its permission request waits")
    };
    assert_eq!(ask.prompt, "Copilot asks to run touch tasktap-live.txt");
    assert_eq!(ask.kind, QuestionKind::Confirm);
    assert_eq!(ask.source, Some(QuestionSource::Permission));
    assert!(ask.request.starts_with("permissionRequest:1795077324768:"));
    assert!(ask.detail.unwrap().contains("touch tasktap-live.txt"));
    let args = ["permissionRequest".to_owned()];
    let reply = |response| {
        let answer = Answer {
            response,
            device_id: None,
            created: Time::ZERO,
            delivered: None,
        };
        copilot().reply(&args, &payload("permission-request-bash"), &answer)
    };
    let printed = |response| serde_json::from_str::<Value>(&reply(response).unwrap()).unwrap();
    assert_eq!(printed(Response::Affirm), json!({ "behavior": "allow" }));
    assert_eq!(
        printed(Response::Deny),
        json!({ "behavior": "deny", "message": "The person denied this in Tasktap." })
    );
    // "No, and tell Copilot what to do differently".
    let text = Response::Text {
        text: "not now".into(),
    };
    assert_eq!(
        printed(text),
        json!({ "behavior": "deny", "message": "not now" })
    );
    // Answered in its terminal: the hook prints nothing and Copilot asks there.
    assert!(reply(Response::Terminal).is_none());
    // No other hook prints anything.
    let other = ["agentStop".to_owned()];
    let answer = Answer {
        response: Response::Affirm,
        device_id: None,
        created: Time::ZERO,
        delivered: None,
    };
    assert!(
        copilot()
            .reply(&other, &payload("agent-stop"), &answer)
            .is_none()
    );
    assert_eq!(copilot().caps().permissions, Some(ReplyVia::Core));
    assert_eq!(copilot().caps().questions, Some(ReplyVia::Terminal));
}

#[test]
fn a_turns_end_is_read_from_its_transcript() {
    let Some(Heard::Read { event, files, fill }) = heard("agentStop", "agent-stop") else {
        panic!("its end is read")
    };
    let transcript =
        format!("/tmp/tt-live/copilot/home/.copilot/session-state/{SESSION}/events.jsonl");
    assert_eq!(files, [PathBuf::from(transcript)]);
    assert_eq!(event.id, "agentStop:1795077326316");
    assert_eq!(event.resume.as_deref(), Some(SESSION));
    let finished = |answer: &str| Event::TurnFinished {
        answer: Some(answer.into()),
    };
    let read = |name: &str| fill(&event, &text(name)).map(|e| e.event);
    assert_eq!(
        read("transcript-at-agent-stop.jsonl"),
        Some(finished("started"))
    );
    // The next turn's end, by its own stop.
    let Some(Heard::Read { event: next, .. }) = heard("agentStop", "agent-stop-ask-user") else {
        panic!("its end is read")
    };
    let after = fill(&next, &text("transcript-at-agent-stop-ask-user.jsonl"));
    assert_eq!(after.map(|e| e.event), Some(finished("Tea")));
    assert_eq!(read("transcript-at-agent-stop-ask-user.jsonl"), None);
    // Not written yet: the turn has not ended. Each step of the model ends
    // as a turn does; only the step that ran this hook is the turn's end.
    let whole = text("transcript-at-agent-stop.jsonl");
    let step = whole.find("assistant.turn_end").unwrap();
    let step = &whole[..step + whole[step..].find('\n').unwrap() + 1];
    assert!(step.contains("\"turnId\":\"0\"}"), "{step}");
    assert_eq!(fill(&event, step), None);
    let early: String = whole.lines().take(4).map(|l| format!("{l}\n")).collect();
    assert_eq!(fill(&event, &early), None);
    // Another stop's step is not this one's.
    let other = whole.replace("1795077326316", "1795077326999");
    assert_eq!(fill(&event, &other), None);
    // A turn that only used its tools ends with no answer.
    let quiet: String = (whole.lines())
        .filter(|l| !l.contains("\"content\":\"started\""))
        .map(|l| format!("{l}\n"))
        .collect();
    assert_eq!(
        fill(&event, &quiet).map(|e| e.event),
        Some(Event::TurnFinished { answer: None })
    );
}

#[test]
fn a_failed_turn_is_read_from_its_transcript_after_its_last_attempt() {
    let args = [
        "errorOccurred".to_owned(),
        "/Users/person/.copilot".to_owned(),
    ];
    let heard = copilot().event(&args, &payload("error-occurred")).unwrap();
    let Some(Heard::Read { event, files, fill }) = heard else {
        panic!("an error is read")
    };
    let transcript = format!("/Users/person/.copilot/session-state/{SESSION}/events.jsonl");
    assert_eq!(files, [PathBuf::from(transcript)]);
    // While it tries again, a line of activity.
    let Event::Activity { text: said } = &event.event else {
        panic!("{event:?}")
    };
    assert!(said.starts_with("Error: "), "{said}");
    assert!(said.contains("Authentication Fails"), "{said}");
    assert_eq!(
        fill(&event, &text("transcript-at-error-retrying.jsonl")),
        None
    );
    // Its last attempt failed: the turn failed, in its own sentence.
    let failed = fill(&event, &text("transcript-at-error-failed.jsonl")).unwrap();
    let Event::TurnFailed { error: Some(why) } = failed.event else {
        panic!("{failed:?}")
    };
    assert!(
        why.starts_with("Authentication failed with provider at http://127.0.0.1:8771 (HTTP 401)"),
        "{why}"
    );
    assert_eq!(failed.id, event.id);
    // Not told where its sessions are: the error is a line of activity.
    let alone = copilot()
        .event(&args[..1], &payload("error-occurred"))
        .unwrap();
    let Some(Heard::Read { files, .. }) = alone else {
        panic!()
    };
    assert!(files.is_empty());
}

#[test]
fn a_repeat_has_the_same_id_and_the_next_one_another() {
    let first = event("userPromptSubmitted", "user-prompt-submitted");
    assert_eq!(
        first.id,
        event("userPromptSubmitted", "user-prompt-submitted").id
    );
    let mut later: Value = serde_json::from_slice(&payload("user-prompt-submitted")).unwrap();
    later["timestamp"] = json!(1795077329376u64);
    let later = copilot()
        .event(
            &["userPromptSubmitted".into()],
            &serde_json::to_vec(&later).unwrap(),
        )
        .unwrap();
    let Some(Heard::Event(later)) = later else {
        panic!()
    };
    assert_ne!(later.id, first.id);
}

#[test]
fn it_runs_with_tasktaps_plugin_and_the_persons_own_approvals() {
    // Below its folder, joined as this system joins a path.
    let plugin = Path::new("/data/agents/copilot").join("plugin");
    let plugin = plugin.to_str().unwrap();
    let new = copilot().launch(&run("Fix the bug", None, None));
    assert_eq!(
        new,
        [
            "copilot",
            "--plugin-dir",
            plugin,
            "--interactive=Fix the bug"
        ]
    );
    let resumed = copilot().launch(&run("Go on", Some("gpt-5.4-mini"), Some(SESSION)));
    assert_eq!(
        resumed,
        [
            "copilot",
            "--model",
            "gpt-5.4-mini",
            "--plugin-dir",
            plugin,
            &format!("--resume={SESSION}"),
            "--interactive=Go on"
        ]
    );
    // Its terminal takes `/` and `!` at the start for its own commands: such
    // a prompt is told after "Task: ". A dash is safe in the one argument.
    let last = |prompt: &str| copilot().launch(&run(prompt, None, None)).pop().unwrap();
    assert_eq!(last("/exit"), "--interactive=Task: /exit");
    assert_eq!(last("  !rm -rf x"), "--interactive=Task:   !rm -rf x");
    assert_eq!(last("-x hello"), "--interactive=-x hello");
    assert_eq!(last("@README.md say hi"), "--interactive=@README.md say hi");
    // The person's words follow a brief, marked as theirs.
    let told = copilot().told("Rename the file", "rename it");
    assert!(told.starts_with("Rename the file\n\n---\n") && told.ends_with("\n\nrename it"));
}

#[test]
fn its_plugin_is_kept_in_tasktaps_folder_and_runs_the_hook() {
    let exe = Path::new("/opt/tasktap/tasktap");
    let files = copilot().files(exe);
    let names: Vec<&str> = files.iter().map(|(name, _)| *name).collect();
    assert_eq!(names, ["plugin/plugin.json", "plugin/hooks/hooks.json"]);
    let manifest: Value = serde_json::from_str(&files[0].1).unwrap();
    assert_eq!(manifest["name"], "tasktap");
    let hooks: Value = serde_json::from_str(&files[1].1).unwrap();
    assert_eq!(hooks["version"], 1);
    let named: Vec<&String> = hooks["hooks"].as_object().unwrap().keys().collect();
    assert_eq!(
        named,
        [
            "agentStop",
            "errorOccurred",
            "permissionRequest",
            "postToolUse",
            "postToolUseFailure",
            "preToolUse",
            "sessionStart",
            "userPromptSubmitted"
        ]
    );
    for (name, list) in hooks["hooks"].as_object().unwrap() {
        let [hook] = list.as_array().unwrap().as_slice() else {
            panic!("{name}")
        };
        assert_eq!(hook["type"], "command");
        let command = hook["bash"].as_str().unwrap();
        // Quoted as every agent's hook is on this system (`agents::quoted`).
        let exe = match cfg!(windows) {
            true => r#""/opt/tasktap/tasktap""#,
            false => "'/opt/tasktap/tasktap'",
        };
        assert!(
            command.starts_with(&format!("{exe} hook copilot {name}")),
            "{command}"
        );
        // Tasktap's hook never denies a tool, whatever happens to it.
        assert!(command.ends_with(" || true"), "{command}");
        let wait = if name == "permissionRequest" { 600 } else { 30 };
        assert_eq!(hook["timeoutSec"], wait, "{name}");
    }
    // Written below its folder in the data folder, where `--plugin-dir`
    // points, and written again only when it differs.
    let home = std::env::temp_dir().join(format!("tasktap-copilot-test-{}", std::process::id()));
    agents::checks::keep(&home, &files).unwrap();
    let plugin = PathBuf::from(&copilot().attach(exe, &home)[1]);
    for (name, content) in &files {
        let inside = Path::new(name).strip_prefix("plugin").unwrap();
        assert_eq!(
            &std::fs::read_to_string(plugin.join(inside)).unwrap(),
            content
        );
    }
    agents::checks::keep(&home, &files).unwrap();
    std::fs::remove_dir_all(&home).unwrap();
}

/// The commands as bash runs them, with a program in place of Tasktap's
/// that says what it was given and fails: the hook of an error is told where
/// Copilot keeps its sessions, and a failing hook exits 0.
#[cfg(unix)]
#[test]
fn its_hook_commands_are_told_where_its_sessions_are_and_never_fail() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("tasktap-copilot-sh-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let exe = dir.join("it's tasktap");
    std::fs::write(&exe, "#!/bin/sh\nprintf '%s|' \"$@\"\nexit 69\n").unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
    let files = copilot().files(&exe);
    let hooks: Value = serde_json::from_str(&files[1].1).unwrap();
    let command = |name: &str| hooks["hooks"][name][0]["bash"].as_str().unwrap().to_owned();
    let bash = |name: &str, home: Option<&str>| {
        let mut c = std::process::Command::new("bash");
        c.args(["-c", &command(name)])
            .env("HOME", "/Users/person")
            .env_remove("COPILOT_HOME");
        if let Some(home) = home {
            c.env("COPILOT_HOME", home);
        }
        let out = c.output().unwrap();
        (out.status.code(), String::from_utf8(out.stdout).unwrap())
    };
    assert_eq!(
        bash("errorOccurred", None),
        (
            Some(0),
            "hook|copilot|errorOccurred|/Users/person/.copilot|".into()
        )
    );
    assert_eq!(
        bash("errorOccurred", Some("/elsewhere/copilot home")),
        (
            Some(0),
            "hook|copilot|errorOccurred|/elsewhere/copilot home|".into()
        )
    );
    assert_eq!(
        bash("preToolUse", None),
        (Some(0), "hook|copilot|preToolUse|".into())
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn its_row_says_it_asks_to_trust_each_copy_of_the_project() {
    // It is told no folder is trusted for a run (it has no way to be), so a
    // thought run in a copy of the project stops at its trust question each
    // time, and its row in Settings › Agents says so before that surprises.
    let launched = copilot().launch(&run("Fix the bug", None, None)).join(" ");
    assert!(!launched.contains("trust"), "{launched}");
    let trusts = copilot()
        .prompts()
        .iter()
        .any(|p| p.asks.contains("trust this folder"));
    let note = copilot().note().unwrap_or_default();
    assert!(
        trusts && note.contains("asks to trust each copy of the project"),
        "{note}"
    );
}

#[test]
fn what_it_waits_on_before_any_hook_is_read_from_its_terminal_once() {
    // Recorded: a folder it does not trust; and signed out, the same, then
    // its notice, after which it drops the prompt.
    let trust = "Copilot is asking whether to trust this folder";
    for (screen, asks) in [
        ("trust-dialog.bin", &[trust][..]),
        ("sign-in.bin", &[trust, "Copilot is asking you to sign in"]),
    ] {
        let screen = fixture(screen);
        let mut watch = agents::Watch::new(copilot().prompts()).unwrap();
        let found: Vec<_> = screen.chunks(7).filter_map(|c| watch.read(c)).collect();
        let found: Vec<_> = found.iter().map(|p| p.asks).collect();
        assert_eq!(found, asks);
        assert!(watch.read(&screen).is_none());
    }
}

#[test]
fn it_says_its_version_and_not_whether_it_is_signed_in() {
    let detect = copilot().detect();
    assert_eq!(detect.version, ["--version"]);
    let printed = "GitHub Copilot CLI 1.0.114.\nRun 'copilot update' to check for updates.\n";
    assert_eq!((detect.version_of)(printed).as_deref(), Some("1.0.114"));
    assert!(detect.account.is_empty());
    assert!(copilot().headless().is_none());
}

#[test]
fn every_sentence_names_it_as_people_know_it() {
    assert_eq!(
        (copilot().id(), copilot().name(), copilot().program()),
        (ID, "Copilot", ID)
    );
    let row = |installed, signed_in| AgentHealth {
        installed,
        signed_in,
        ..agents::checks::found(copilot())
    };
    let said = |row| agents::usable(copilot(), Some(&row)).unwrap_err();
    if copilot().supported() {
        assert_eq!(
            said(row(false, None)),
            "Copilot is not installed on this computer"
        );
        assert_eq!(agents::usable(copilot(), Some(&row(true, None))), Ok(()));
    } else {
        assert_eq!(
            said(row(true, None)),
            "Copilot does not run on this system yet"
        );
    }
    assert_eq!(cfg!(windows), !copilot().supported());
    // In the registry, and never the default.
    assert_ne!(agents::all()[0].id(), ID);
    // Its sign-in and its own endpoint reach its runs.
    for name in ["COPILOT_HOME", "GH_TOKEN", "COPILOT_PROVIDER_BASE_URL"] {
        assert!(copilot().variables().contains(&name), "{name}");
    }
}
