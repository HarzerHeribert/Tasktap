//! The adapter of Cursor's command line agent (design §7), `cursor-agent`
//! 2026.09.28, without the tool.
//!
//! The tool was signed out where this was written, so only two fixtures in
//! `tests/fixtures/agents/cursor-agent/` are recorded from it: `sign-in.bin`,
//! its first screen under a pseudo-terminal, and `status-signed-out.json`.
//! The hook payloads, the transcripts and `status-signed-in.json` are built
//! from the tool's own code, the fields its hook runner sends and the lines
//! its transcript writer writes, with made-up values: they hold the mapping
//! to what the code says, not to a turn that was seen.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tasktap_core::agents::{self, Agent, Heard, Run};
use tasktap_proto::{AgentHealth, Answer, Event, Response, SessionEvent, SessionId, Time, Uuid};

const ID: &str = "cursor-agent";
const CHAT: &str = "5d0c7c1e-1c64-4c7b-9f0a-6f2a3b1d9e01";
const TURN: &str = "9a4e2f77-0b1d-4e55-8c3a-1e7d5b6c2f02";

/// The adapter, which is not in the registry: Cursor is not offered until a
/// run signed in has shown that it can be heard (design §7).
fn cursor() -> &'static dyn Agent {
    &agents::cursor::Cursor
}

fn fixture(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/agents")
        .join(ID)
        .join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn text(name: &str) -> String {
    String::from_utf8(fixture(name)).unwrap()
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

fn heard(bytes: &[u8]) -> Option<Heard> {
    cursor().event(&[], bytes).unwrap()
}

fn event(bytes: &[u8]) -> SessionEvent {
    match heard(bytes) {
        Some(Heard::Event(e)) => e,
        other => panic!("{other:?}"),
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
        effort: None,
        resume,
        hook: Path::new("/opt/tasktap/tasktap"),
        home: Path::new("/data/agents/cursor-agent"),
        allowed: &[],
        args: &[],
    }
}

#[test]
fn its_hooks_map_to_the_one_vocabulary() {
    let ready = event(&payload("session-start"));
    assert_eq!(ready.event, Event::Ready);
    assert_eq!(ready.id, format!("sessionStart:{CHAT}"));
    assert_eq!(ready.resume.as_deref(), Some(CHAT));

    let started = event(&payload("prompt"));
    assert_eq!(started.id, format!("beforeSubmitPrompt:{TURN}"));
    assert_eq!(started.resume.as_deref(), Some(CHAT));
    let prompt = Some("Tasktap test: run git status and say what it shows.".into());
    assert_eq!(started.event, Event::TurnStarted { prompt });

    // A tool: what it does, and no handle, since a sub-agent's tool may run
    // under an id of its own, which must not become the chat's.
    let tool = event(&payload("tool-shell"));
    assert_eq!(tool.id, "preToolUse:tool_3f1b6c0a");
    let shell = Event::Activity {
        text: "Shell: git status".into(),
    };
    assert_eq!(tool.event, shell);
    assert!(!tool.subagent && tool.resume.is_none());
    let inner = event(&payload("tool-subagent"));
    assert!(inner.subagent && inner.resume.is_none());
    assert_eq!(
        inner.event,
        Event::Activity {
            text: "Grep: TODO".into()
        }
    );

    // The end of a turn names no message: it is read from the transcript.
    let Some(Heard::Read {
        event: finished,
        files,
        fill,
    }) = heard(&payload("stop"))
    else {
        panic!("stop does not read the transcript");
    };
    assert_eq!(finished.id, format!("stop:{TURN}:0"));
    assert_eq!(finished.resume.as_deref(), Some(CHAT));
    assert_eq!(finished.event, Event::TurnFinished { answer: None });
    let named =
        format!("/home/person/.cursor/projects/tmp-project/agent-transcripts/{CHAT}/{CHAT}.jsonl");
    assert_eq!(files, [PathBuf::from(named)]);
    let filled = fill(&finished, &text("transcript-finished.jsonl")).unwrap();
    let answer = Some("The tree is clean.\nNothing to commit.".into());
    assert_eq!(filled.event, Event::TurnFinished { answer });
    assert_eq!(
        (&filled.id, &filled.resume),
        (&finished.id, &finished.resume)
    );
    // Not written yet: the turn before this one's prompt is not its answer,
    // and a line cut at the start of what was read is passed over.
    assert!(fill(&finished, &text("transcript-working.jsonl")).is_none());
    assert!(fill(&finished, "").is_none());
    let cut = format!("ent\":[]}}}}\n{}", text("transcript-finished.jsonl"));
    assert_eq!(fill(&finished, &cut).unwrap().event, filled.event);
    // Before the file exists the payload names none: reported as it is.
    let unnamed = changed("stop", json!({ "transcript_path": null }));
    let Some(Heard::Read { files, .. }) = heard(&unnamed) else {
        panic!("stop does not read the transcript");
    };
    assert!(files.is_empty());

    let aborted = event(&changed("stop", json!({ "status": "aborted" })));
    assert_eq!(aborted.event, Event::TurnInterrupted);
    let failed = event(&changed("stop", json!({ "status": "error" })));
    assert_eq!(failed.event, Event::TurnFailed { error: None });
}

#[test]
fn a_repeat_has_the_same_id_and_the_next_one_another() {
    for name in ["session-start", "prompt", "tool-shell"] {
        assert_eq!(event(&payload(name)).id, event(&payload(name)).id);
    }
    let next = json!({ "generation_id": "00000000-0000-4000-8000-000000000003" });
    assert_ne!(
        event(&changed("prompt", next.clone())).id,
        event(&payload("prompt")).id
    );
    let id = |bytes: &[u8]| match heard(bytes) {
        Some(Heard::Read { event, .. }) => event.id,
        other => panic!("{other:?}"),
    };
    assert_eq!(id(&payload("stop")), id(&payload("stop")));
    assert_ne!(id(&changed("stop", next)), id(&payload("stop")));
    // A follow-up a hook of the person's own made it go on with ends again.
    assert_ne!(
        id(&changed("stop", json!({ "loop_count": 1 }))),
        id(&payload("stop"))
    );
    let other = json!({ "tool_use_id": "tool_0000" });
    assert_ne!(
        event(&changed("tool-shell", other)).id,
        event(&payload("tool-shell")).id
    );
    // Without the tool's own ids the payload's content tells two apart.
    let bare = |command: &str| {
        let input = json!({ "command": command });
        event(&changed(
            "tool-shell",
            json!({ "tool_use_id": null, "tool_input": input }),
        ))
        .id
    };
    assert_eq!(bare("ls"), bare("ls"));
    assert_ne!(bare("ls"), bare("pwd"));
}

#[test]
fn what_it_does_not_report_maps_to_nothing() {
    // Hooks the plugin does not name, should another source run the command.
    for name in [
        "afterAgentResponse",
        "beforeShellExecution",
        "subagentStop",
        "sessionEnd",
    ] {
        assert!(
            heard(&changed("stop", json!({ "hook_event_name": name }))).is_none(),
            "{name}"
        );
    }
    assert!(heard(b"{}").is_none());
    assert!(cursor().event(&[], b"[]").is_err());
    assert!(cursor().event(&[], b"not json").is_err());
    // Nothing it asks is answered through a hook, and none waits.
    for name in ["session-start", "prompt", "tool-shell", "stop"] {
        assert!(
            !matches!(heard(&payload(name)), Some(Heard::Wait(_))),
            "{name}"
        );
        let answer = Answer {
            response: Response::Affirm,
            device_id: None,
            created: Time::ZERO,
            delivered: None,
        };
        assert!(cursor().reply(&[], &payload(name), &answer).is_none());
    }
    let caps = cursor().caps();
    assert!(caps.events && caps.resume);
    assert!(caps.permissions.is_none() && caps.questions.is_none());
    assert!(cursor().headless().is_none());
    assert!(cursor().probe(Path::new("/x"), Path::new("/y")).is_none());
}

#[test]
fn it_runs_with_tasktaps_plugin_and_the_persons_own_policy() {
    let argv = cursor().launch(&run("Fix the bug", Some("auto"), None));
    #[rustfmt::skip]
    assert_eq!(argv, ["cursor-agent", "--model", "auto", "--plugin-dir",
        &Path::new("/data/agents/cursor-agent").join("plugin").to_string_lossy(), "--", "Fix the bug"]);
    // A resume names the chat, and its model again.
    let argv = cursor().launch(&run("Go on then", Some("auto"), Some(CHAT)));
    assert_eq!(argv[1..3], ["--model", "auto"]);
    assert_eq!(argv[5..], ["--resume", CHAT, "--", "Go on then"]);
    let argv = cursor().launch(&run("Go on then", None, Some(CHAT)));
    assert_eq!(argv[1], "--plugin-dir");
    // No approval policy of Tasktap's, and no trust written down for good.
    for flag in [
        "--force",
        "-f",
        "--yolo",
        "--auto-review",
        "--trust",
        "-p",
        "--print",
    ] {
        assert!(!argv.iter().any(|a| a == flag), "{flag}");
    }
    // One word would be a subcommand of that name: it is told with a line
    // break, which is none. A prompt that starts as a flag follows `--`.
    for word in ["update", "logout", " status "] {
        let argv = cursor().launch(&run(word, None, None));
        assert_eq!(
            argv[argv.len() - 2..],
            ["--".to_owned(), format!("{word}\n")]
        );
    }
    let argv = cursor().launch(&run("--help me fix this", None, None));
    assert_eq!(argv[argv.len() - 2..], ["--", "--help me fix this"]);
    // The person's words follow the brief.
    let both = Run {
        words: Some("what they said"),
        ..run("The brief.", None, None)
    };
    let told = cursor().launch(&both).pop().unwrap();
    assert!(told.starts_with("The brief.\n\n---\n") && told.ends_with("\n\nwhat they said"));

    let home = Path::new("/data/agents/cursor-agent");
    let attached = cursor().attach(Path::new("/opt/tasktap/tasktap"), home);
    assert_eq!(
        attached,
        ["--plugin-dir".into(), home.join("plugin").into_os_string()]
    );
    assert!(
        cursor()
            .environment(Path::new("/opt/tasktap/tasktap"), home)
            .is_empty()
    );
    assert_eq!(cursor().variables(), ["CURSOR_API_KEY"]);
}

#[test]
fn its_plugin_is_kept_in_tasktaps_folder_and_names_the_hook() {
    let files = cursor().files(Path::new("/opt/tasktap/tasktap"));
    let names: Vec<&str> = files.iter().map(|(name, _)| *name).collect();
    assert_eq!(
        names,
        [
            "plugin/.cursor-plugin/plugin.json",
            "plugin/hooks/hooks.json"
        ]
    );
    let manifest: Value = serde_json::from_str(&files[0].1).unwrap();
    assert_eq!(manifest["name"], "tasktap");
    let hooks: Value = serde_json::from_str(&files[1].1).unwrap();
    assert_eq!(hooks["version"], 1);
    let command = if cfg!(windows) {
        "\"/opt/tasktap/tasktap\" hook cursor-agent"
    } else {
        "'/opt/tasktap/tasktap' hook cursor-agent"
    };
    let named: Vec<&String> = hooks["hooks"].as_object().unwrap().keys().collect();
    assert_eq!(
        named,
        ["beforeSubmitPrompt", "preToolUse", "sessionStart", "stop"]
    );
    for (name, list) in hooks["hooks"].as_object().unwrap() {
        assert_eq!(list.as_array().unwrap().len(), 1, "{name}");
        assert_eq!(list[0]["command"], command, "{name}");
        assert_eq!(list[0]["timeout"], 30, "{name}");
        // Each hook the plugin names is one the adapter hears.
        let said = changed("stop", json!({ "hook_event_name": name }));
        assert!(heard(&said).is_some(), "{name}");
    }
    // Written below its folder in the data folder, where `--plugin-dir`
    // points, and written again only when it differs.
    let home = std::env::temp_dir().join(format!("tasktap-cursor-test-{}", std::process::id()));
    agents::checks::keep(&home, &files).unwrap();
    let plugin = PathBuf::from(&cursor().attach(Path::new("/x"), &home)[1]);
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

#[test]
fn it_says_whether_it_is_signed_in_and_as_whom() {
    let detect = cursor().detect();
    assert_eq!(detect.version, ["--version"]);
    let version = (detect.version_of)("2026.09.28-64d2043\n");
    assert_eq!(version.as_deref(), Some("2026.09.28-64d2043"));
    assert_eq!(detect.account, ["status", "--format", "json"]);
    // Recorded: signed out it says so and exits 0.
    let out = text("status-signed-out.json");
    assert_eq!((detect.account_of)(Some(0), &out), (Some(false), None));
    // Built from its code: signed in, with who its servers said it is.
    let signed = text("status-signed-in.json");
    let who = Some("person@example.com".to_owned());
    assert_eq!((detect.account_of)(Some(0), &signed), (Some(true), who));
    // Signed in while its servers could not be asked who: no identity.
    let unnamed = r#"{"status": "authenticated", "isAuthenticated": true, "message": "Logged in"}"#;
    assert_eq!((detect.account_of)(Some(0), unnamed), (Some(true), None));
    for (code, said) in [
        (Some(1), "Error: unknown option '--format'"),
        (None, ""),
        (Some(0), "{}"),
    ] {
        assert_eq!((detect.account_of)(code, said), (None, None), "{said}");
    }
}

#[test]
fn what_it_waits_on_before_any_hook_is_read_from_its_terminal_once() {
    // Recorded signed out under a pseudo-terminal: its logo, then the words.
    let screen = fixture("sign-in.bin");
    let mut watch = agents::Watch::new(cursor().prompts()).unwrap();
    let found: Vec<_> = screen.chunks(7).filter_map(|c| watch.read(c)).collect();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].asks, "Cursor is asking you to sign in");
    assert!(watch.read(&screen).is_none());
    // Its trust dialog, in its code's words (not seen: signed out, it never
    // comes to it).
    let dialog = "\x1b[1mWorkspace Trust Required\x1b[22m\r\n\x1b[2K  Cursor Agent can execute \
                  code and access files in this directory.\r\n  Do you trust the contents of \
                  this directory?\r\n\r\n  [a] Trust this workspace\r\n  [q] Quit\r\n";
    let mut watch = agents::Watch::new(cursor().prompts()).unwrap();
    let found = watch.read(dialog.as_bytes()).unwrap();
    assert_eq!(found.asks, "Cursor is asking whether to trust this folder");
}

#[test]
fn every_sentence_names_it_as_people_know_it() {
    assert_eq!(
        (cursor().id(), cursor().name(), cursor().program()),
        (ID, "Cursor", ID)
    );
    let row = |installed, signed_in| AgentHealth {
        installed,
        signed_in,
        ..agents::checks::found(cursor())
    };
    let said = |row| agents::usable(cursor(), Some(&row)).unwrap_err();
    if cursor().supported() {
        assert_eq!(
            said(row(false, None)),
            "Cursor is not installed on this computer"
        );
        assert_eq!(said(row(true, Some(false))), "Cursor is not signed in");
        assert_eq!(agents::usable(cursor(), Some(&row(true, None))), Ok(()));
    } else {
        assert_eq!(
            said(row(true, Some(true))),
            "Cursor does not run on this system yet"
        );
    }
    assert_eq!(cfg!(windows), !cursor().supported());
    // Not offered: no agent of the registry is it.
    assert!(agents::find(ID).is_none());
}
