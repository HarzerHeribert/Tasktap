//! The agents heard through one dialect of hooks (design §7): Qwen Code,
//! Goose and Crush. Every payload here is one the real tool sent in a run
//! in a home of its own (`fixtures/agents/<tool>`, paths replaced), of Qwen
//! Code 0.28.0, Goose 1.60.1 and Crush 0.101.0 on DeepSeek's `deepseek-chat`.

mod common;

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use common::*;
use serde_json::Value;
use tasktap_core::agents::{self, Agent, Heard, Run};
use tasktap_proto::{
    Event, QuestionKind, QuestionSource, QuestionState, ReplyVia, SessionEvent, SessionId, Status,
};

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

#[test]
fn goose_runs_one_task_in_a_root_of_tasktaps_and_its_hooks_say_what_it_does() {
    let goose = agent("goose");
    // Its payloads carry no time and nothing that numbers a turn: the id is
    // left open for the hook that reports it (it ends in `:`).
    let ready = event("goose", "SessionStart-headless");
    assert_eq!(
        (ready.event, ready.id.as_str()),
        (Event::Ready, "SessionStart:")
    );
    assert_eq!(ready.resume.as_deref(), Some("20261119_1"));
    let prompt = "Tasktap test: add the comment line # hello as the first line of hello.py";
    assert_eq!(
        event("goose", "UserPromptSubmit").event,
        Event::TurnStarted {
            prompt: Some(prompt.into())
        }
    );
    let used = event("goose", "PreToolUse");
    let text = "shell: ls -la hello.py 2>&1; cat hello.py 2>&1".to_owned();
    assert_eq!(used.event, Event::Activity { text });
    assert_eq!(used.id, "PreToolUse:call_00_1yOWbbvVhdUVT2JBSAaj6448");
    let Event::TurnFinished { answer } = event("goose", "Stop").event else {
        panic!("the turn's end");
    };
    assert!(
        answer
            .unwrap()
            .starts_with("Done. `hello.py` now starts with:")
    );
    for nothing in ["PreToolUseResult-allow", "PostToolUse", "SessionEnd"] {
        assert!(heard("goose", nothing).is_none(), "{nothing}");
    }
    // It asks for nothing in this form, and reads nothing that is typed.
    let caps = goose.caps();
    assert!(caps.events && caps.resume);
    assert_eq!((caps.permissions, caps.questions), (None, None));
    assert!(!goose.typed());
    assert!(goose.note().unwrap().contains("in Tasktap's folder"));

    assert_eq!(
        goose.launch(&run("Fix it", None, None)),
        ["goose", "run", "--text=Fix it"]
    );
    #[rustfmt::skip]
    assert_eq!(
        goose.launch(&run("Go on", Some("deepseek-chat"), Some("20261119_1"))),
        ["goose", "run", "--resume", "--session-id", "20261119_1", "--model", "deepseek-chat",
         "--text=Go on"]
    );
    // `!` would run the rest in a shell at once, `/` is a command of its own.
    let last = |told: &str| goose.launch(&run(told, None, None)).pop().unwrap();
    assert_eq!(last("!rm -rf build"), "--text=Task: !rm -rf build");
    assert_eq!(
        last("  /status of the build"),
        "--text=Task:   /status of the build"
    );
    assert_eq!(last("-x"), "--text=-x");
    // Its hooks are a plugin below a root of Tasktap's.
    let files = goose.files(Path::new("/opt/tasktap/tasktap"));
    let names: Vec<_> = files.iter().map(|(name, _)| *name).collect();
    assert_eq!(
        names,
        [
            ".agents/plugins/tasktap/plugin.json",
            ".agents/plugins/tasktap/hooks/hooks.json"
        ]
    );
    let hooks: Value = serde_json::from_str(&files[1].1).unwrap();
    let stop = &hooks["hooks"]["Stop"][0]["hooks"][0];
    assert_eq!(stop["type"], "command");
    #[cfg(unix)]
    assert_eq!(stop["command"], "'/opt/tasktap/tasktap' hook goose");
    assert_eq!(hooks["hooks"].as_object().unwrap().len(), 4);
    // The root, its mode that asks nothing, no telemetry, and the person's
    // own configuration read beside it.
    let home = Path::new("/data/agents/goose");
    let env = goose.environment(Path::new("/x"), home);
    let value = |name: &str| {
        env.iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.as_str())
    };
    assert_eq!(value("GOOSE_PATH_ROOT"), home.to_str());
    assert_eq!(value("GOOSE_MODE"), Some("auto"));
    assert_eq!(value("GOOSE_TELEMETRY_OFF"), Some("1"));
    let own = value("GOOSE_ADDITIONAL_CONFIG_FILES").unwrap();
    assert!(Path::new(own).ends_with("goose/config.yaml"), "{own}");
    let detect = goose.detect();
    assert_eq!((detect.version_of)(" 1.60.1\n").as_deref(), Some("1.60.1"));
}

#[test]
fn crush_runs_one_task_with_a_data_folder_of_tasktaps_and_its_hooks_say_what_it_does() {
    let crush = agent("crush");
    const SESSION: &str = "2370ef69-c43c-4cd3-b3eb-e063cdded8dc";
    let ready = event("crush", "SessionStart-startup");
    assert_eq!(
        (ready.event, ready.id.as_str()),
        (Event::Ready, "SessionStart:")
    );
    assert_eq!(ready.resume.as_deref(), Some(SESSION));
    // Its turn's start names no prompt: it is the one Tasktap gave.
    let started = event("crush", "TurnStart");
    assert_eq!(started.event, Event::TurnStarted { prompt: None });
    assert_eq!(started.id, "TurnStart:");
    assert!(matches!(
        event("crush", "PreToolUse-edit").event,
        Event::Activity { text } if text == "edit: /work/repo1/hello.py"
    ));
    let answer = Some("Done".into());
    assert_eq!(
        event("crush", "TurnEnd").event,
        Event::TurnFinished { answer }
    );
    let Event::TurnFailed { error } = event("crush", "StopFailure-wrong-key").event else {
        panic!("a failed turn");
    };
    assert!(
        error
            .unwrap()
            .starts_with("unauthorized: Authentication Fails")
    );
    assert_eq!(
        event("crush", "Interrupt-escape").event,
        Event::TurnInterrupted
    );
    for nothing in ["PostToolUse-edit", "SessionEnd-run"] {
        assert!(heard("crush", nothing).is_none(), "{nothing}");
    }
    let caps = crush.caps();
    assert!(caps.events && caps.resume && !crush.typed());
    assert_eq!((caps.permissions, caps.questions), (None, None));

    #[rustfmt::skip]
    assert_eq!(
        crush.launch(&run("Fix it", None, None)),
        ["crush", "run", "-q", "--data-dir", "/data/agents/x", "--", "Fix it"]
    );
    #[rustfmt::skip]
    assert_eq!(
        crush.launch(&run("-v is noisy", Some("deepseek/deepseek-v4-flash"), Some(SESSION))),
        ["crush", "run", "-q", "--data-dir", "/data/agents/x", "-m", "deepseek/deepseek-v4-flash",
         "-s", SESSION, "--", "-v is noisy"]
    );
    let last = |told: &str| crush.launch(&run(told, None, None)).pop().unwrap();
    assert_eq!(last("!make clean"), "Task: !make clean");
    let files = crush.files(Path::new("/opt/tasktap/tasktap"));
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].0, "crush.json");
    let config: Value = serde_json::from_str(&files[0].1).unwrap();
    let end = &config["hooks"]["TurnEnd"][0];
    assert_eq!(end["name"], "tasktap");
    #[cfg(unix)]
    assert_eq!(end["command"], "'/opt/tasktap/tasktap' hook crush");
    assert_eq!(config["hooks"].as_object().unwrap().len(), 6);
    assert!(
        crush
            .environment(Path::new("/x"), Path::new("/y"))
            .is_empty()
    );
    let detect = crush.detect();
    let version = (detect.version_of)("crush version v0.101.0\n");
    assert_eq!(version.as_deref(), Some("0.101.0"));
    let row = agents::checks::found(crush);
    assert!(row.events && row.resume && !row.checks);
    assert!(row.note.unwrap().starts_with("It runs one task and ends"));
}

#[test]
fn droid_runs_one_task_and_the_end_of_its_turn_is_read_from_its_transcript() {
    let droid = agent("droid");
    const SESSION: &str = "5329867a-65ce-4bde-9332-5817783e4b8b";
    let ready = event("droid", "SessionStart");
    assert_eq!(ready.event, Event::Ready);
    assert_eq!(ready.resume.as_deref(), Some(SESSION));
    assert!(matches!(
        event("droid", "UserPromptSubmit").event,
        Event::TurnStarted { prompt: Some(prompt) } if prompt.starts_with("Tasktap test: add the comment line")
    ));
    assert!(matches!(
        event("droid", "PreToolUse-Execute").event,
        Event::Activity { text } if text == "Execute: echo hi && cd /work && git add hello.py && git commit -m tasktap-test"
    ));
    assert!(matches!(
        event("droid", "PreToolUse-Edit").event,
        Event::Activity { text } if text == "Edit: /work/hello.py"
    ));
    assert!(heard("droid", "SessionEnd").is_none());
    // Its `Stop` names a line of its transcript and says nothing else, and
    // it comes when the turn failed too: what the turn's end is, is read.
    let ends = |name: &str| {
        let stop = droid.event(&[], &payload("droid", name)).unwrap();
        let Some(Heard::Read { event, files, fill }) = stop else {
            panic!("{name}: the end of a turn is read from the transcript");
        };
        assert_eq!(event.event, Event::TurnFinished { answer: None });
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].extension().unwrap(), "jsonl", "{files:?}");
        let transcript = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/agents/droid")
            .join(format!("transcript-at-{name}.jsonl"));
        let transcript = std::fs::read_to_string(transcript).unwrap();
        // While the line is not written, the hook reads again.
        assert!(fill(&event, "").is_none());
        assert!(fill(&event, "{\"type\":\"session_start\"}\nnot json\n").is_none());
        (event.id.clone(), fill(&event, &transcript).unwrap())
    };
    let (id, done) = ends("Stop");
    assert_eq!(id, "Stop:a052f0f4-b52a-4e1b-abad-1d4fff9026f2");
    assert_eq!((done.id, done.resume.as_deref()), (id, Some(SESSION)));
    let Event::TurnFinished { answer } = done.event else {
        panic!("what its model said last is the answer");
    };
    assert!(
        answer
            .unwrap()
            .starts_with("Added `# hello` as the first line of hello.py")
    );
    // A notice of its own in place of an answer: the turn failed, and why.
    let (_, failed) = ends("Stop-failed-wrong-key");
    let Event::TurnFailed { error } = failed.event else {
        panic!("a refused key fails the turn");
    };
    assert!(
        error
            .unwrap()
            .starts_with("BYOK Error: 401 Authentication Fails")
    );
    // Its own sentence that the run ended, which no model wrote: failed.
    let (_, early) = ends("Stop-ended-early");
    let Event::TurnFailed { error } = early.event else {
        panic!("a run that ended early failed");
    };
    assert!(
        error
            .unwrap()
            .starts_with("Exec ended early: insufficient permission to proceed")
    );

    let caps = droid.caps();
    assert!(caps.events && caps.resume && !droid.typed());
    assert_eq!((caps.permissions, caps.questions), (None, None));
    let settings = Path::new("/data/agents/x").join("settings.json");
    let settings = settings.to_string_lossy();
    // A settings file of Tasktap's, merged for the one run; edits in the
    // project and no more, until the person lets it run more.
    #[rustfmt::skip]
    assert_eq!(
        droid.launch(&run("-x and /y", None, None)),
        ["droid", "exec", "--settings", &settings, "--auto", "low", "--",
         "-x and /y"]
    );
    let allowed = ["pi.project".to_owned(), "droid.commands".to_owned()];
    let more = Run {
        allowed: &allowed,
        ..run("Go on", Some("custom:DeepSeek-Chat-0"), Some(SESSION))
    };
    #[rustfmt::skip]
    assert_eq!(
        droid.launch(&more),
        ["droid", "exec", "--settings", &settings, "-m",
         "custom:DeepSeek-Chat-0", "--auto", "medium", "-s", SESSION, "--", "Go on"]
    );
    let option = &droid.options()[0];
    assert_eq!(
        (option.id, option.name),
        ("commands", "Build without asking")
    );
    assert!(agents::option("droid.commands").is_some());
    let files = droid.files(Path::new("/opt/tasktap/tasktap"));
    assert_eq!(files[0].0, "settings.json");
    let settings: Value = serde_json::from_str(&files[0].1).unwrap();
    let stop = &settings["hooks"]["Stop"][0]["hooks"][0];
    assert_eq!(
        (&stop["type"], &stop["timeout"]),
        (&Value::from("command"), &Value::from(120))
    );
    #[cfg(unix)]
    assert_eq!(stop["command"], "'/opt/tasktap/tasktap' hook droid");
    assert_eq!(settings["hooks"].as_object().unwrap().len(), 4);
    let detect = droid.detect();
    assert_eq!((detect.version_of)("1.14.0\n").as_deref(), Some("1.14.0"));
    assert!(
        droid
            .note()
            .unwrap()
            .contains("shows nothing until the end")
    );
}

// Through the binary.

#[test]
fn a_crush_hook_tells_the_core_what_its_run_does() {
    let mut s = Scene::new("dc");
    let hook = |socket: &Path, token: &str, name: &str| {
        let mut hook = Command::new(EXE);
        hook.args(["hook", "crush"])
            .env("TASKTAP_SOCKET", socket)
            .env("TASKTAP_TOKEN", token)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        let mut child = hook.spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(&payload("crush", name)).unwrap();
        drop(stdin);
        let out = child.wait_with_output().unwrap();
        assert!(out.stdout.is_empty(), "{name}: it prints nothing");
        assert_eq!(out.status.code(), Some(0), "{name}");
    };
    let socket = s.data.0.join("core.sock");
    let (thought, session, _agent) = s.launch("tidy up");
    let log = s.log();
    let launched = log.launched.iter().find(|l| l.session == session);
    let token = serde_json::to_value(&launched.unwrap().token).unwrap();
    let token = token.as_str().unwrap();
    for name in ["SessionStart-startup", "TurnStart", "PreToolUse-edit"] {
        hook(&socket, token, name);
    }
    let edit = "edit: /work/repo1/hello.py";
    s.w.until("the turn runs", |m| {
        m.session(session).activity.last().map(String::as_str) == Some(edit)
    });
    // The end of a turn told twice is one end.
    hook(&socket, token, "TurnEnd");
    hook(&socket, token, "TurnEnd");
    s.w.until("the turn is done", |m| m.status(thought) == Status::Done);
    let said = s.w.model.results_of(thought);
    assert_eq!((said.len(), said[0].summary.as_str()), (1, "Done"));
    // The conversation's id, with which a follow-up goes on in a new run.
    let handle = s.w.model.session(session).resume.clone();
    assert_eq!(
        handle.as_deref(),
        Some("2370ef69-c43c-4cd3-b3eb-e063cdded8dc")
    );

    // Another run, whose turn fails: its hooks say what the first run's
    // said, byte for byte, and are that run's own all the same.
    let (failed, session, _agent) = s.launch("and the docs");
    let log = s.log();
    let launched = log.launched.iter().find(|l| l.session == session);
    let token = serde_json::to_value(&launched.unwrap().token).unwrap();
    let token = token.as_str().unwrap();
    for name in ["SessionStart-startup", "TurnStart", "StopFailure-wrong-key"] {
        hook(&socket, token, name);
    }
    s.w.until("the turn failed", |m| m.status(failed) == Status::Failed);
    let why = s.w.model.session(session).error.clone().unwrap();
    assert!(
        why.starts_with("unauthorized: Authentication Fails"),
        "{why}"
    );
    assert_eq!(
        s.w.model.thought(failed).reason,
        Some(tasktap_proto::Reason::TurnFailed)
    );
    assert_eq!(s.w.model.status(thought), Status::Done);
    let open = |m: &Model| m.questions.values().any(|q| q.state == QuestionState::Open);
    assert!(!open(&s.w.model));
}
