//! The agents heard through one dialect of hooks (design §7): Qwen Code,
//! Goose and Crush. Every payload here is one the real tool sent in a run
//! in a home of its own (`fixtures/agents/<tool>`, paths replaced), of Qwen
//! Code 0.28.0, Goose 1.60.1 and Crush 0.101.0 on DeepSeek's `deepseek-chat`.

mod common;

use std::path::Path;

use serde_json::Value;
use tasktap_core::agents::{self, Agent, Heard, Run};
use tasktap_proto::{Event, QuestionKind, QuestionSource, ReplyVia, SessionEvent, SessionId};

const RUN: &str = "01930000-0000-7000-8000-0000000000aa";

fn agent(id: &str) -> &'static dyn Agent {
    agents::find(id).unwrap()
}

fn payload(tool: &str, name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/agents")
        .join(tool)
        .join(format!("{name}.json"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn heard(tool: &str, name: &str) -> Option<SessionEvent> {
    match agent(tool).event(&[], &payload(tool, name)).unwrap() {
        Some(Heard::Event(event)) => Some(event),
        None => None,
        Some(other) => panic!("{name}: {other:?}"),
    }
}

fn event(tool: &str, name: &str) -> SessionEvent {
    heard(tool, name).unwrap_or_else(|| panic!("{tool} {name} says nothing"))
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
        home: Path::new("/data/agents/x"),
        allowed: &[],
    }
}

#[test]
fn qwen_codes_hooks_map_to_the_one_vocabulary() {
    const SESSION: &str = "11111111-2222-4333-8444-555555555501";
    let ready = event("qwen", "SessionStart");
    assert_eq!(ready.event, Event::Ready);
    // Every payload carries the session's id, the handle `--resume` takes,
    // and the time, which with the hook's name is the event's id.
    assert_eq!(ready.resume.as_deref(), Some(SESSION));
    assert_eq!(ready.id, "SessionStart:2026-11-19T02:54:10.668Z");
    assert!(!ready.subagent);
    assert_eq!(event("qwen", "SessionStart-resume").event, Event::Ready);
    let prompt = "Tasktap test: add the comment line # hello as the first line of hello.py";
    assert_eq!(
        event("qwen", "UserPromptSubmit").event,
        Event::TurnStarted {
            prompt: Some(prompt.into())
        }
    );
    // The same hook fires again with no prompt after each batch of tools:
    // the turn goes on, and none begins.
    assert!(heard("qwen", "UserPromptSubmit-continuation").is_none());
    let shell = event("qwen", "PreToolUse-run_shell_command");
    let text = "run_shell_command: List files in the working directory".to_owned();
    assert_eq!(shell.event, Event::Activity { text });
    assert_eq!(shell.id, "PreToolUse:toolu_1795056941434_c30ppkwdb");
    assert!(matches!(
        event("qwen", "PreToolUse-edit").event,
        Event::Activity { text } if text == "edit: /work/repo/hello.py"
    ));
    // What it asks to be let do it asks in its terminal: heard, shown, and
    // answered there.
    let Event::Question { question } = event("qwen", "PermissionRequest-shell-unanswered").event
    else {
        panic!("a permission request is a question");
    };
    assert_eq!(
        question.prompt,
        "Qwen Code asks to run touch tasktap-dialog.txt"
    );
    assert_eq!(question.kind, QuestionKind::Confirm);
    assert_eq!(question.source, Some(QuestionSource::Permission));
    assert!(question.detail.unwrap().contains("tasktap-dialog.txt"));
    // Its question tool asks through the same request: the question, to be
    // answered in its terminal; the tool's own start says nothing more.
    assert!(heard("qwen", "PreToolUse-ask_user_question").is_none());
    let Event::Question { question } = event("qwen", "PermissionRequest-ask_user_question").event
    else {
        panic!("its question is a question");
    };
    assert_eq!(
        (question.prompt.as_str(), question.source),
        ("Red or blue?", None)
    );
    // Answered there, by the tool's end or the batch's.
    for answered in [
        "PostToolUse-run_shell_command",
        "PostToolBatch-cancelled-in-terminal",
    ] {
        let e = event("qwen", answered).event;
        assert_eq!(e, Event::Continued { request: None }, "{answered}");
    }
    let answer = Some("Added `# hello` as the first line of `hello.py`.".into());
    assert_eq!(event("qwen", "Stop").event, Event::TurnFinished { answer });
    let Event::TurnFailed { error } = event("qwen", "StopFailure").event else {
        panic!("a failed turn");
    };
    assert!(
        error
            .unwrap()
            .starts_with("400 The supported API model names are")
    );
    // What says nothing: the end of the session (the process's end says
    // it), and its notice that it waits, which is all an interrupted turn
    // leaves and also comes in the middle of one.
    assert!(heard("qwen", "SessionEnd").is_none());
    assert!(heard("qwen", "Notification-idle_prompt-after-escape").is_none());
    assert!(agent("qwen").event(&[], b"{}").unwrap().is_none());
    assert!(agent("qwen").event(&[], b"no json").is_err());

    let caps = agent("qwen").caps();
    assert!(caps.events && caps.resume);
    assert_eq!(caps.permissions, Some(ReplyVia::Terminal));
    assert_eq!(caps.questions, Some(ReplyVia::Terminal));
    assert!(agent("qwen").typed());
}

#[test]
fn a_qwen_code_run_is_pointed_at_tasktaps_settings_and_given_its_id() {
    let qwen = agent("qwen");
    assert_eq!((qwen.name(), qwen.program()), ("Qwen Code", "qwen"));
    #[rustfmt::skip]
    assert_eq!(
        qwen.launch(&run("Fix it", Some("deepseek-chat"), None)),
        ["qwen", "-m", "deepseek-chat", "--prompt-interactive=Fix it"]
    );
    // A resume, with its model named again: it keeps none.
    #[rustfmt::skip]
    assert_eq!(
        qwen.launch(&run("Go on", Some("deepseek-chat"), Some("abc"))),
        ["qwen", "-m", "deepseek-chat", "--resume", "abc", "--prompt-interactive=Go on"]
    );
    // The prompt is one argument with its flag, so `-` begins no option;
    // `/` would be a command of its own, `@` a file to paste and `?` a side
    // command, also after spaces: such a thought is told after a word.
    let last = |told: &str| qwen.launch(&run(told, None, None)).pop().unwrap();
    assert_eq!(last("-v is noisy"), "--prompt-interactive=-v is noisy");
    assert_eq!(
        last("/quit is broken"),
        "--prompt-interactive=Task: /quit is broken"
    );
    assert_eq!(
        last(" @anna said so"),
        "--prompt-interactive=Task:  @anna said so"
    );
    assert_eq!(last("!important"), "--prompt-interactive=!important");
    // Its hooks are a settings file in Tasktap's folder, which a variable
    // names: nothing is written to `~/.qwen` or to the project.
    let files = qwen.files(Path::new("/Applications/Task tap/it's"));
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].0, "system-defaults.json");
    let settings: Value = serde_json::from_str(&files[0].1).unwrap();
    assert_eq!(settings["$version"], 4);
    let stop = &settings["hooks"]["Stop"][0];
    assert_eq!(stop["matcher"], "*");
    #[cfg(unix)]
    assert_eq!(
        stop["hooks"][0]["command"],
        r"'/Applications/Task tap/it'\''s' hook qwen"
    );
    assert_eq!(settings["hooks"].as_object().unwrap().len(), 9);
    let env = qwen.environment(Path::new("/x"), Path::new("/data/agents/qwen"));
    let settings = Path::new("/data/agents/qwen").join("system-defaults.json");
    assert_eq!(
        env,
        [(
            "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
            settings.to_string_lossy().into_owned()
        )]
    );
    assert!(qwen.attach(Path::new("/x"), Path::new("/y")).is_empty());
    assert!(qwen.headless().is_none() && qwen.note().is_none());
    let detect = qwen.detect();
    assert_eq!((detect.version_of)("0.28.0\n").as_deref(), Some("0.28.0"));
    assert!(detect.account.is_empty());
    assert!(qwen.variables().contains(&"OPENAI_BASE_URL"));
    assert_eq!(qwen.supported(), !cfg!(windows));
}
