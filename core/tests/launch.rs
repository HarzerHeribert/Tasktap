//! The launcher (design §7, §14 C) through the real binary: each run is
//! the fixture agent, found on the core's PATH as `fixture-agent`, started
//! by the real launcher as the direct child of a terminal of its own. Its
//! steps are typed into that terminal, and it reports through `tasktap hook`
//! with its session's token. The router is the fixture's.

mod common;

use common::*;
use std::path::Path;
use tasktap_proto::call;
use tasktap_proto::{
    Capture, Empty, Place, QuestionSource, QuestionState, Reason, Ref, ReplyVia, Response,
    ResultKind, Route, RunState, SessionId, SessionState, Status, TerminalId, TerminalKind,
    TerminalState, ThoughtId,
};

/// A command the shell runs, and what only running it prints.
#[cfg(unix)]
const SUM: (&str, &str) = ("echo tasktap-$((6*7))", "tasktap-42");
#[cfg(windows)]
const SUM: (&str, &str) = ("set /a 6*7+1300", "1342");

/// Waits until a thought's run has started in its terminal, or failed: the
/// launcher finds the program and runs its check off the core's thread.
fn launched(s: &mut Scene, t: ThoughtId) {
    s.w.until("the run started or failed", |m| {
        let th = &m.thoughts[&t];
        let session = th.session_id.and_then(|id| m.sessions.get(&id));
        th.status == Status::Failed || session.is_some_and(|s| s.terminal_id.is_some())
    });
}

/// A thought launched once its hold passed, with its session and terminal.
fn started(s: &mut Scene, text: &str) -> (ThoughtId, SessionId, TerminalId) {
    let t = s.capture(text);
    s.tick(HOLD_MS);
    launched(s, t);
    let th = s.w.model.thought(t);
    assert_eq!(th.status, Status::Working, "{th:?}");
    let session = th.session_id.unwrap();
    let terminal = s.w.model.session(session).terminal_id;
    (
        t,
        session,
        terminal.expect("the launch stored its terminal"),
    )
}

/// The agent of `terminal`, once it runs.
fn screen(s: &Scene, terminal: TerminalId) -> Screen {
    let mut screen = Screen::open(&s.core, terminal);
    screen.until("fixture-agent");
    screen
}

/// The router's brief, which is the prompt of each run from now on: the
/// fixture agent runs it as a step.
fn brief(s: &mut Scene, brief: &str) {
    let to = Place::Project(s.project);
    let brief = brief.into();
    s.script(
        Route::Clear {
            said: None,
            to,
            brief,
        },
        None,
    );
}

/// A follow-up for the session, started once its hold ends.
fn follow_up(s: &mut Scene, session: SessionId, text: &str) -> ThoughtId {
    let f = ThoughtId::mint();
    let capture = Capture {
        session_id: Some(session),
        ..typed(f, text)
    };
    s.w.ok::<call::ThoughtCapture>(&capture);
    s.tick(HOLD_MS);
    f
}

/// A core whose runs are the fixture agent, with a shell of it open in
/// `/bin/sh`, where typing `fixture` starts the "real" fixture agent, a
/// copy of the binary, through its shim.
#[cfg(unix)]
fn shell(prefix: &str) -> (Scene, TerminalId, Screen) {
    let data = Folder::new(prefix);
    let real = data.0.join("real");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::copy(EXE, real.join("fixture")).unwrap();
    let env = [("SHELL", "/bin/sh"), ("PATH", &path_with(&real))];
    let core = Core::start_env(&data.0, &[], &env);
    let s = Scene::on(core, data).running("fixture");
    let shell = TerminalId::mint();
    let start = tasktap_proto::StartTerminal {
        project: None,
        argv: Vec::new(),
        title: None,
    };
    let screen = Screen::start(&s.core, shell, Some(start));
    (s, shell, screen)
}

fn running(s: &mut Scene) -> u32 {
    s.w.ok::<call::CoreStatus>(&Empty {}).terminals
}

#[test]
fn a_run_is_the_direct_child_of_a_new_terminal_and_has_its_sessions_token() {
    let mut s = Scene::real("la", "fixture");
    let (_, session, terminal) = started(&mut s, "fix the build");
    let row = s.w.model.terminals[&terminal].clone();
    assert_eq!(
        (row.kind, row.state, row.project_id, row.title.as_str()),
        (
            TerminalKind::Agent,
            TerminalState::Running,
            Some(s.project),
            "fixture"
        )
    );
    assert_eq!(row.cwd, s.w.model.projects[&s.project].folder);
    // The adapter's command line, its program found on the PATH: no shell.
    let program = Path::new(&row.argv[0]);
    assert!(program.is_absolute(), "{:?}", row.argv);
    assert_eq!(program.file_stem().unwrap(), "fixture-agent");
    assert_eq!(row.argv[1], "--hook");
    let canonical = |p: &str| std::fs::canonicalize(p).unwrap();
    assert_eq!(canonical(&row.argv[2]), canonical(EXE));
    assert_eq!(row.argv[3..], ["Fix the failing build"]);
    // It runs, and its hooks reach its own session with its token.
    let mut agent = screen(&s, terminal);
    agent.until("fixture-agent --hook");
    agent.line("event:ready");
    s.w.until("the session is ready", |m| {
        m.session(session).state == SessionState::Idle
    });
}

#[test]
fn an_agent_not_installed_fails_its_run_says_why_and_leaves_nothing_running() {
    // A core whose PATH has no `fixture-agent`.
    let data = Folder::new("lm");
    let mut s = Scene::on(Core::start(&data.0), data).running("fixture");
    let t = s.capture("fix the build");
    s.tick(HOLD_MS);
    launched(&mut s, t);
    let th = s.w.model.thought(t).clone();
    assert_eq!(
        (th.status, th.reason),
        (Status::Failed, Some(Reason::Launch))
    );
    let why = s.w.model.results_of(t);
    assert_eq!((why.len(), why[0].kind), (1, ResultKind::Failure));
    let said = "fixture-agent is not installed: no folder of the PATH has it";
    assert_eq!(why[0].summary, said);
    let session = s.w.model.session(th.session_id.unwrap());
    assert_eq!(
        (session.state, session.terminal_id, session.error.as_deref()),
        (SessionState::Ended, None, Some(said))
    );
    assert!(s.w.model.terminals.is_empty());
    assert_eq!(running(&mut s), 0);
}

#[test]
fn what_an_agent_waits_on_in_its_terminal_before_it_is_ready_asks_to_be_answered_there() {
    // As Claude Code's folder-trust dialog: shown before any hook runs, so
    // the session stays starting and nothing else would say it waits.
    let mut s = Scene::real("lt", "fixture");
    let (t, session, terminal) = started(&mut s, "fix the build");
    let mut agent = screen(&s, terminal);
    agent.line("print:Do you trust the files in this folder?");
    let q = s.shown();
    let row = s.w.model.question(q).clone();
    assert_eq!(
        (row.prompt.as_str(), row.reply_via, row.source),
        (
            "The fixture agent is asking whether to trust this folder",
            ReplyVia::Terminal,
            QuestionSource::Agent
        )
    );
    assert_eq!((row.thought_id, row.session_id), (Some(t), Some(session)));
    assert_eq!(s.w.model.status(t), Status::NeedsYou);
    assert_eq!(s.w.model.session(session).state, SessionState::Starting);
    // Drawn again, it is the same question.
    agent.line("print:Do you trust the files in this folder?");
    // Answered in the terminal: the agent goes on and is ready.
    agent.line("event:ready");
    s.w.until("answered in the terminal", |m| {
        m.question(q).state == QuestionState::Answered
    });
    let m = &s.w.model;
    assert_eq!(m.questions.len(), 1, "one question");
    let answer = m.question(q).answer.as_ref().unwrap();
    assert_eq!(answer.response, Response::Terminal);
    assert_eq!(m.status(t), Status::Working);
    assert_eq!(m.session(session).state, SessionState::Idle);
    // Once ready, the same words are only output.
    agent.line("print:Do you trust the files in this folder?");
    agent.line("event:turn_started:fix the build");
    s.w.until("the turn started", |m| {
        m.session(session).state == SessionState::Working
    });
    assert_eq!(s.w.model.questions.len(), 1);
}

#[test]
fn a_run_finds_its_agents_own_files_and_variables() {
    // An agent that reads its hooks from a plugin folder or a settings file
    // is given them in a folder of Tasktap's own, written before the run,
    // and told where by its arguments or its environment (design §7).
    let mut s = Scene::real("lf", "fixture");
    let (_, _, terminal) = started(&mut s, "fix the build");
    let home = s.data.0.join("agents").join("fixture");
    let note = std::fs::read_to_string(home.join("kept").join("note.txt")).unwrap();
    assert_eq!(note, "kept for the fixture agent\n");
    let mut agent = screen(&s, terminal);
    agent.line("env:FIXTURE_AGENT_HOME");
    agent.until_bytes(format!("FIXTURE_AGENT_HOME={}", home.display()).as_bytes());
    // Whole or not at all, only when it differs, and never outside the folder.
    let keep = tasktap_core::agents::checks::keep;
    std::fs::write(home.join("kept").join("note.txt"), "changed").unwrap();
    keep(&home, &[("kept/note.txt", "kept again\n".into())]).unwrap();
    let note = std::fs::read_to_string(home.join("kept").join("note.txt")).unwrap();
    assert_eq!(note, "kept again\n");
    let left: Vec<_> = std::fs::read_dir(home.join("kept")).unwrap().collect();
    assert_eq!(left.len(), 1, "no part of a file is left beside it");
    for outside in ["../note.txt", "/tmp/note.txt", "kept/../../x", ""] {
        assert!(
            keep(&home, &[(outside, "x".into())]).is_err(),
            "{outside:?}"
        );
    }
}

/// The session ends with its agent's code; the terminal goes on as the
/// person's shell (design §7), which a stop ends.
#[test]
fn the_agents_exit_code_ends_its_session_and_its_terminal_goes_on_as_a_shell() {
    let mut s = Scene::real("lx", "fixture");
    // An agent that reports events has not finished by exiting, even with 0.
    for code in [3, 0] {
        brief(&mut s, &format!("exit:{code}"));
        let (t, session, terminal) = started(&mut s, "fix the build");
        s.w.until("the session ends", |m| {
            m.session(session).state == SessionState::Ended
        });
        s.w.until("the terminal goes on as a shell", |m| {
            m.terminals[&terminal].kind == TerminalKind::Shell
        });
        let m = &s.w.model;
        assert_eq!(m.session(session).exit, Some(code));
        let shell = &m.terminals[&terminal];
        assert_eq!((shell.state, shell.exit), (TerminalState::Running, None));
        #[cfg(unix)]
        assert_eq!(shell.argv, ["/bin/sh"]);
        let th = m.thought(t);
        assert_eq!(
            (th.status, th.reason),
            (Status::Failed, Some(Reason::Exited))
        );
        s.w.ok::<call::TerminalStop>(&Ref { id: terminal });
        s.w.until("a stop ends the shell", |m| {
            m.terminals[&terminal].state == TerminalState::Exited
        });
    }
    assert_eq!(running(&mut s), 0);
}

/// How each agent Tasktap starts in a terminal that stays ends, as the
/// real tool does when the person quits it (measured on Claude Code 2.1.328,
/// Codex 0.169, Antigravity 1.5.12, OpenCode 2.3.0 and Copilot 1.0.83 in a
/// terminal of their own; Pi and Qwen Code, not installed here, as the
/// terminal libraries they draw with leave it): the modes it turns on, the
/// teardown it writes, what it asks the terminal as it goes, its closing
/// lines and its code. Then one that crashes and restores nothing, as Codex
/// does when it is killed, and one of the agents that run one task and end,
/// whose terminal goes on as a shell too. `\e` is ESC, `\a` BEL (the
/// fixture agent's `emit`); `raw` leaves its terminal raw.
#[cfg(unix)]
const ENDINGS: &[(&str, &[&str])] = &[
    (
        "Claude Code",
        &[
            "emit:\\e[?2004h\\e[?2031h\\e[?1004h\\e[?1049h\\e[?1000h\\e[?1002h\\e[?1003h\\e[?1006h\\e[<u\\e[>5u\\e[>4;2m",
            "emit:\\e[?1006l\\e[?1003l\\e[?1002l\\e[?1000l\\e[?25h\\e[?1004l\\e[<u\\e[?1049l\\e[>4m\\e[>4m\\e[<u\\e[?2031l\\e[?2004l\\e[?1016l\\e[?7h\\e[?25h\\e7\\e[r\\e8\\e]0;\\a\\e[?25h",
            "exit:0",
        ],
    ),
    (
        "Codex",
        &[
            "emit:\\e[?2004h\\e[>4;0m\\e[>7u\\e[?1004h\\e[?1049h\\e[>4;0m\\e[>7u\\e[?1007l\\e[?1000h\\e[?1002h\\e[?1003h\\e[?1006h\\e[0 q",
            "emit:\\e[1;1H\\e[J\\e]0;\\a\\e[?1006l\\e[?1015l\\e[?1003l\\e[?1002l\\e[?1000l\\e[<1u\\e[?1007l\\e[?1049l\\e[<1u\\e[<u\\e[>4;0m\\e[?2004l\\e[?1004l",
            // What it asks its terminal as it ends, waiting for the answer.
            "query",
            "emit:\\e[0 q\\e[?25h\\e]7501;state=clear\\a\\e[0 q\\e[?25h",
            "print:Token usage: total=12,480 input=11,902 (+ 9,344 cached) output=578",
            "print:To continue this session, run codex resume 019a7c2e-5b3f-7d10-9e4a-2f6c8b1d0e37",
            "exit:0",
        ],
    ),
    (
        "Antigravity",
        &[
            "emit:\\e[>4m\\e[?1049h\\e[?25l\\e[?2004h\\e[>4;2m\\e[>5u",
            "emit:\\r\\n\\e[90mpress ctrl+c again to exit\\e[m",
            "emit:\\e[>4m\\e[<1u\\r\\e[30d\\e[?1049l\\e[?25h\\e[?2004l",
            "exit:0",
        ],
    ),
    (
        "OpenCode",
        &[
            "print:Starting background server...",
            "emit:\\e[?2031h\\e[?1049h\\e[>4;1m\\e[?2027h\\e[?2004h\\e[?1000h\\e[?1002h\\e[?1003h\\e[?1006h\\e[>4;0m\\e[>5u\\e[1 q",
            // It never turns 2027 off.
            "emit:\\e]0;\\a\\e]7501;state=clear\\a\\e[?25h\\e[0m\\e]22;\\a\\e[<u\\e[?1003l\\e[?1002l\\e[?1000l\\e[?1006l\\e[?2004l\\e[?1049l\\e[?2031l\\e]0;\\a\\e]12;default\\a\\e]112\\a\\e[0 q\\e[?25h\\e[?25h",
            "exit:0",
        ],
    ),
    (
        "Pi",
        &[
            "emit:\\e[?2004h\\e[>1u\\e[?25l",
            "print:",
            "emit:\\e[?2004l\\e[<u\\e[?25h",
            "exit:0",
        ],
    ),
    (
        "Qwen Code",
        &[
            "emit:\\e[?2004h\\e[?1004h\\e[?25l",
            "print:Agent powering down. Goodbye!",
            "print:Interaction Summary  Tool Calls: 0  Success Rate: 0.0%",
            "emit:\\e[?2004l\\e[?1004l\\e[?25h",
            "exit:0",
        ],
    ),
    (
        "Copilot",
        &[
            "emit:\\e[>4;2m\\e[?1049h\\e[?2004h\\e[?1004h\\e[?1003h\\e[?1006h\\e[=1;1u\\e[22;0t",
            "emit:\\e]111;\\a\\e]110;\\a\\e[23;0t\\e[?1006l\\e[?1003l\\e[?1002l\\e[?1004l\\e[?2004l\\e[=0;1u\\e[>4;0m\\e[?1049l\\e[?25h\\e]111;\\a\\e]110;\\a",
            "exit:0",
        ],
    ),
    (
        "a crash",
        &[
            "emit:\\e[?2004h\\e[>7u\\e[?1004h\\e[?1049h\\e[>7u\\e[?1000h\\e[?1002h\\e[?1003h\\e[?1006h\\e[?1h\\e=\\e[?25l",
            "raw",
            "print:thread 'main' panicked",
            "exit:101",
        ],
    ),
    (
        "a one-task agent",
        &[
            "print:Applied edit to src/app.js",
            "print:Commit 3f2a1c9 fix: the header of the shop",
            "exit:0",
        ],
    ),
];

/// When any agent ends by itself, its terminal is a usable shell again: the
/// modes it left on are turned off after what it wrote, the shell's prompt
/// is drawn, what is typed is echoed and runs, and closing it asks nothing.
#[cfg(unix)]
#[test]
fn when_any_agent_ends_its_terminal_is_a_usable_shell_again() {
    // The turning off the core writes, which no agent here writes itself.
    const RESET: &[u8] = b"\x1b[?9;1000;1002;1003;1004;1005;1006;1015;1016;2004;2026l";
    let mut s = Scene::real("lsh", "fixture");
    let folder = s.data.0.join("app");
    for (agent, steps) in ENDINGS {
        let script = format!("{}.steps", agent.replace(' ', "-"));
        std::fs::write(folder.join(&script), steps.join("\n")).unwrap();
        brief(&mut s, &format!("script:{script}"));
        let (_, session, terminal) = started(&mut s, &format!("try {agent}"));
        s.w.until(&format!("{agent}'s session ends"), |m| {
            m.session(session).state == SessionState::Ended
        });
        s.w.until(&format!("{agent}'s terminal goes on as a shell"), |m| {
            m.terminals[&terminal].kind == TerminalKind::Shell
        });
        let mut screen = Screen::open(&s.core, terminal);
        screen.until_after(RESET);
        screen.line("echo tasktap-$((6*7))");
        screen.until("tasktap-42");
        let bytes = screen.bytes();
        let reset = bytes.windows(RESET.len()).position(|w| w == RESET).unwrap();
        // What the agent printed last comes before the reset, and the
        // command, echoed as typed, after it.
        let printed = steps.iter().rev().find_map(|s| s.strip_prefix("print:"));
        if let Some(last) = printed.filter(|p| !p.is_empty()) {
            assert!(plain(&bytes[..reset]).contains(last), "{agent}");
        }
        let after = plain(&bytes[reset..]);
        assert!(
            after.contains("echo tasktap-$((6*7))"),
            "{agent}: {after:?}"
        );
        let m = &s.w.model;
        assert_eq!(m.terminals[&terminal].state, TerminalState::Running);
        // Its session has ended, and nothing runs in the shell: closing it
        // asks nothing.
        let runs = s.w.ok::<call::TerminalRuns>(&Ref { id: terminal });
        assert_eq!(
            (runs.state, runs.session),
            (RunState::Idle, None),
            "{agent}"
        );
        s.w.ok::<call::TerminalStop>(&Ref { id: terminal });
        screen.ended();
        let runs = s.w.ok::<call::TerminalRuns>(&Ref { id: terminal });
        assert_eq!(runs.state, RunState::Ended, "{agent}");
    }
}

#[test]
fn a_silent_agent_finishes_by_exiting_with_0_and_fails_otherwise() {
    let mut s = Scene::real("ls", "fixture-silent");
    for (code, status) in [(0, Status::Done), (2, Status::Failed)] {
        brief(&mut s, &format!("exit:{code}"));
        let (t, session, terminal) = started(&mut s, "tidy up");
        // No hooks are attached to it.
        assert_eq!(s.w.model.terminals[&terminal].argv.len(), 2);
        s.w.until("the session ends", |m| {
            m.session(session).state == SessionState::Ended
        });
        assert_eq!(s.w.model.status(t), status);
    }
}

#[test]
fn stop_ends_the_agent_and_its_terminal() {
    let mut s = Scene::real("lp", "fixture");
    let (t, session, terminal) = started(&mut s, "fix the build");
    let mut agent = screen(&s, terminal);
    s.w.ok::<call::ThoughtStop>(&Ref { id: t });
    let th = s.w.model.thought(t);
    assert_eq!(
        (th.status, th.reason),
        (Status::Failed, Some(Reason::Stopped))
    );
    assert_eq!(s.w.model.session(session).state, SessionState::Ended);
    s.w.until("the terminal ends", |m| {
        m.terminals[&terminal].state == TerminalState::Exited
    });
    agent.ended();
    assert_eq!(running(&mut s), 0);
}

#[test]
fn a_follow_up_is_typed_into_its_live_agent_which_takes_it_as_its_prompt() {
    let mut s = Scene::real("lf", "fixture");
    let (t, session, terminal) = started(&mut s, "fix the build");
    let mut agent = screen(&s, terminal);
    agent.line("event:ready");
    agent.line("event:turn_started");
    agent.line("event:turn_finished:Fixed.");
    s.w.until("the first turn is done", |m| {
        m.status(t) == Status::Done && m.session(session).state == SessionState::Idle
    });

    let f = follow_up(&mut s, session, "and the tests");
    agent.until("prompt:and the tests");
    s.w.until("the follow-up runs", |m| {
        let s = m.session(session);
        s.thought_id == Some(f) && s.state == SessionState::Working
    });
    agent.line("event:turn_finished:Tests added.");
    s.w.until("the follow-up is done", |m| m.status(f) == Status::Done);
    assert_eq!(s.w.model.results_of(f)[0].summary, "Tests added.");
    assert_eq!(agent.text().matches("prompt:").count(), 1, "typed once");
}

/// A follow-up's text is pasted with no control character in it but its
/// line breaks and tabs: whatever it holds, it cannot end the paste early,
/// start another sequence, or make the terminal interrupt, suspend or end
/// the agent's input. Each part below defeats a sanitizer that removes the
/// end of the paste once, or one that removes only escapes.
#[test]
fn a_follow_ups_text_cannot_end_its_paste_or_reach_the_terminal_as_keys() {
    let mut s = Scene::real("lx", "fixture");
    let (t, session, terminal) = started(&mut s, "fix the build");
    let mut agent = screen(&s, terminal);
    agent.line("event:ready");
    agent.line("event:turn_started");
    agent.line("event:turn_finished:Fixed.");
    s.w.until("the first turn is done", |m| {
        m.status(t) == Status::Done && m.session(session).state == SessionState::Idle
    });
    let parts = [
        // The end of the paste, rebuilt by removing it once.
        ("a\x1b[20\x1b[201~1~b", "a[20[201~1~b"),
        // Nested twice.
        ("\x1b[2\x1b[20\x1b[201~01~1~c", "[2[20[201~01~1~c"),
        // What the line discipline acts on: interrupt, suspend, quit, end of input, erase.
        ("stop\x03here\x1aand\x1cnow\x04end\x7f", "stophereandnowend"),
        // C1 controls, one of them CSI.
        ("\u{9b}31m\u{85}d", "31md"),
        // A title sequence ended with BEL.
        ("\x1b]0;t\x07e", "]0;te"),
    ];
    let text: Vec<&str> = parts.iter().map(|(sent, _)| *sent).collect();
    let typed: Vec<&str> = parts.iter().map(|(_, kept)| *kept).collect();
    let f = follow_up(&mut s, session, &text.join(" "));
    agent.until(&format!("prompt:{}", typed.join(" ")));
    s.w.until("the follow-up runs", |m| {
        m.session(session).thought_id == Some(f)
    });
    agent.line("event:turn_finished:Done.");
    s.w.until("the follow-up is done", |m| m.status(f) == Status::Done);
    assert_eq!(agent.text().matches("prompt:").count(), 1, "one paste");
}

/// A program that lets go of its terminal and goes on running takes no
/// input any more: the first write that fails ends the terminal's input.
/// Nothing a client types after that is granted back as written, and a
/// follow-up fails with the reason instead of being reported typed. On
/// the Mac such a write fails; Linux takes writes into a terminal nobody
/// holds and drops them, so there none fails, and Windows has no `let_go`.
#[cfg(target_os = "macos")]
#[test]
fn input_the_terminal_cannot_write_is_never_reported_written() {
    let mut s = Scene::real("lw", "fixture");
    let (t, session, terminal) = started(&mut s, "fix the build");
    let mut agent = screen(&s, terminal);
    agent.line("event:ready");
    agent.line("event:turn_started");
    agent.line("event:turn_finished:Fixed.");
    s.w.until("the first turn is done", |m| {
        m.status(t) == Status::Done && m.session(session).state == SessionState::Idle
    });
    agent.line("detach:30000");
    agent.until("detaching");
    // Once the terminal is let go of, a byte typed is not written.
    let wait = std::time::Duration::from_millis(300);
    let start = std::time::Instant::now();
    while agent.acknowledged(wait) {
        let waited = start.elapsed();
        assert!(
            waited.as_secs() < 10,
            "input still acknowledged after {waited:?}"
        );
    }
    assert!(!agent.acknowledged(wait), "nor anything after it");
    let f = follow_up(&mut s, session, "and the tests");
    s.w.until("the follow-up fails", |m| m.status(f) == Status::Failed);
    let why = &s.w.model.results_of(f)[0].summary;
    assert!(
        why.starts_with("the terminal no longer takes input")
            && why.ends_with("so the follow-up was not typed"),
        "{why}"
    );
    assert_eq!(s.w.model.session(session).state, SessionState::Idle);
    s.w.ok::<call::TerminalStop>(&Ref { id: terminal });
}

#[test]
fn a_follow_up_whose_agent_exits_before_it_is_typed_is_never_typed() {
    let mut s = Scene::real("le", "fixture");
    let (_, session, terminal) = started(&mut s, "fix the build");
    let mut agent = screen(&s, terminal);
    agent.line("event:ready");
    s.w.until("the session is ready", |m| {
        m.session(session).state == SessionState::Idle
    });
    // A run's live session runs in its terminal, also while it waits.
    let runs = s.w.ok::<call::TerminalRuns>(&Ref { id: terminal });
    assert_eq!(
        (runs.state, runs.what, runs.session),
        (
            RunState::Running,
            vec!["Fixture agent".into()],
            Some(session)
        )
    );
    // The follow-up is handed to the launcher while the agent runs, and
    // held back untyped...
    s.pause = true;
    s.log();
    let f = follow_up(&mut s, session, "rm -rf build");
    assert!(s.log().held.contains(&f));
    // ...while the agent exits, which ends its session at once.
    agent.line("exit:0");
    s.w.until("the session ends", |m| {
        m.session(session).state == SessionState::Ended
    });
    s.pause = false;
    s.log();
    let th = s.w.model.thought(f);
    assert_eq!(
        (th.status, th.reason),
        (Status::Failed, Some(Reason::Exited))
    );
    // Its terminal goes on as a shell in a terminal of its own, which
    // never gets the follow-up either.
    s.w.until("the terminal goes on as a shell", |m| {
        m.terminals[&terminal].kind == TerminalKind::Shell
    });
    agent.line(SUM.0);
    agent.until(SUM.1);
    assert!(!agent.text().contains("rm -rf"), "{}", agent.text());
    s.w.ok::<call::TerminalStop>(&Ref { id: terminal });
    agent.ended();
    // The row says exited once the history is on disk, which happens off
    // the core's thread after the stream has ended.
    s.w.until("the terminal's row says it exited", |m| {
        m.terminals[&terminal].state == TerminalState::Exited
    });
    assert!(s.w.model.terminals.len() == 1 && running(&mut s) == 0);
}

/// An agent a person started by hand in a shell of the core: its shim holds
/// the shell while the follow-up is typed, so the agent takes it and the
/// shell never sees it.
#[cfg(unix)]
#[test]
fn a_follow_up_to_an_agent_adopted_in_a_shell_is_typed_while_its_shim_holds_it() {
    let data = Folder::new("ld");
    let real = data.0.join("real");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::copy(EXE, real.join("fixture")).unwrap();
    let env = [("SHELL", "/bin/sh"), ("PATH", &path_with(&real))];
    let core = Core::start_env(&data.0, &[], &env);
    let mut s = Scene::on(core, data).running("fixture");
    let shell = TerminalId::mint();
    let start = tasktap_proto::StartTerminal {
        project: None,
        argv: Vec::new(),
        title: None,
    };
    let mut screen = Screen::start(&s.core, shell, Some(start));
    screen.line("fixture");
    screen.until("fixture-agent --hook");
    s.w.until("an adopted session", |m| {
        m.sessions.values().any(|s| s.adopted)
    });
    let session = s.w.model.sessions.values().find(|s| s.adopted).unwrap().id;
    screen.line("event:ready");
    s.w.until("the session is ready", |m| {
        m.session(session).state == SessionState::Idle
    });
    // An agent's live session runs in its shell, also while it waits.
    let runs = s.w.ok::<call::TerminalRuns>(&Ref { id: shell });
    assert_eq!(
        (runs.state, runs.what, runs.session),
        (
            RunState::Running,
            vec!["Fixture agent".into()],
            Some(session)
        )
    );

    let f = follow_up(&mut s, session, "and the tests");
    screen.until("prompt:and the tests");
    s.w.until("the follow-up runs", |m| {
        m.session(session).thought_id == Some(f)
    });
    screen.line("event:turn_finished:Tests added.");
    s.w.until("the follow-up is done", |m| m.status(f) == Status::Done);

    // Stopping a run of it has its shim end the agent, and never the
    // person's shell, which reads the next line: were the agent still
    // there, it would take the line as its prompt.
    let g = follow_up(&mut s, session, "and the docs");
    screen.until("prompt:and the docs");
    s.w.until("the next follow-up runs", |m| {
        m.session(session).thought_id == Some(g)
    });
    s.w.ok::<call::ThoughtStop>(&Ref { id: g });
    assert_eq!(s.w.model.session(session).state, SessionState::Ended);
    // The shim lets go of the terminal once its agent has gone, and the
    // shell's prompt follows.
    screen.until_after(b"\x1b[0m\x1b[?25h");
    screen.line("echo shell-$((2+3))");
    screen.until("shell-5");
    assert!(!screen.text().contains("prompt:echo shell"));
    assert_eq!(s.w.model.terminals[&shell].state, TerminalState::Running);
    // Its session ended: the shell has nothing running in it.
    let runs = s.w.ok::<call::TerminalRuns>(&Ref { id: shell });
    assert_eq!((runs.state, runs.session), (RunState::Idle, None));
    screen.line("exit");
}

/// An agent adopted in a shell that stops reading its input, with a
/// follow-up on its way that does not fit what the terminal holds, and then
/// exits: its shim holds the shell until the core has written all of it or
/// none is still to come, so none of it reaches the shell, which would run it.
#[cfg(unix)]
#[test]
fn a_follow_up_its_adopted_agent_never_read_never_reaches_the_shell() {
    let (mut s, shell, mut screen) = shell("lr");
    screen.line("fixture");
    screen.until("fixture-agent --hook");
    s.w.until("an adopted session", |m| {
        m.sessions.values().any(|s| s.adopted)
    });
    let session = s.w.model.sessions.values().find(|s| s.adopted).unwrap().id;
    screen.line("event:ready");
    s.w.until("the session is ready", |m| {
        m.session(session).state == SessionState::Idle
    });
    screen.line("stall:1500");
    screen.until("stalling");
    // Larger than any terminal holds unread, so the core is still writing
    // when the agent exits; its end is a command the shell would run.
    let text = format!("{} ; echo LEAKED-$((6*7))", "x".repeat(16 << 10));
    let f = follow_up(&mut s, session, &text);
    s.w.until("the agent has exited", |m| {
        (m.sessions.get(&session)).is_none_or(|s| s.state == SessionState::Ended)
    });
    s.w.until("the follow-up has ended", |m| m.status(f) == Status::Failed);
    // It failed as a follow-up whose agent exited before reading it.
    assert_eq!(s.w.model.thought(f).reason, Some(Reason::Exited));
    screen.line("echo back-$((1+1))");
    screen.until("back-2");
    assert!(!screen.text().contains("LEAKED-42"), "{}", screen.text());
    assert_eq!(s.w.model.terminals[&shell].state, TerminalState::Running);
    screen.line("exit");
}

/// A process with the shell's token that adopts as a shim does and says
/// yes to every hold, while the shell's own prompt has the terminal: the
/// core sees that the holder's group does not have the terminal's
/// foreground, and types nothing, so the shell never runs the follow-up.
#[cfg(unix)]
#[test]
fn a_follow_up_is_never_typed_for_a_holder_that_does_not_have_the_terminal() {
    use tasktap_core::client::{self, Client};
    use tasktap_proto::call::Call;
    use tasktap_proto::{
        Adopt, Auth, Control, Event as Said, Frame, Hello, Role, Secret, SessionEvent, ShimHold,
        VERSION, Versions,
    };
    let (mut s, _, mut screen) = shell("lb");
    // The shell's token, as anything the shell runs has it.
    screen.line("echo token=$TASKTAP_TOKEN.");
    let token = loop {
        let text = screen.text();
        let found = text.match_indices("token=").find_map(|(at, _)| {
            let hex = text.get(at + 6..at + 70)?;
            let ended = text.get(at + 70..at + 71) == Some(".");
            (ended && hex.bytes().all(|b| b.is_ascii_hexdigit())).then(|| hex.to_owned())
        });
        if let Some(hex) = found {
            break serde_json::from_value::<Secret>(hex.into()).unwrap();
        }
        assert!(screen.pump(), "the core went away");
    };
    let hello = Hello {
        v: Versions(VERSION, VERSION),
        role: Role::Cli,
        client: "not a shim".into(),
        auth: Some(Auth::Session { token }),
        abilities: vec!["shim.hold".into()],
    };
    let stream = client::connect(&s.data.0).unwrap();
    let mut holder = Client::hello(stream, hello).unwrap().unwrap();
    let adopt = Adopt {
        agent: "fixture".into(),
        cwd: "/".into(),
    };
    let session = holder.call::<call::SessionAdopt>(&adopt).unwrap().unwrap();
    let ready = SessionEvent {
        id: "ready".into(),
        turn: None,
        subagent: false,
        event: Said::Ready,
        resume: None,
    };
    holder.call::<call::SessionEvent>(&ready).unwrap().unwrap();
    let f = follow_up(&mut s, session, "echo TYPED-$((6*7))");
    let Frame::Control(Control::Call(request)) = holder.recv().unwrap() else {
        panic!("expected shim.hold");
    };
    assert_eq!(
        call::ShimHold::args(request.args).unwrap(),
        ShimHold {
            hold: true,
            stop: false
        }
    );
    holder
        .send(&call::ShimHold::reply(request.id, Ok(())))
        .unwrap();
    s.w.until("the follow-up fails", |m| m.status(f) == Status::Failed);
    assert_eq!(
        s.w.model.results_of(f)[0].summary,
        "the shim that holds the shell does not have its terminal, so the follow-up was not typed"
    );
    screen.line("echo back-$((1+1))");
    screen.until("back-2");
    assert!(!screen.text().contains("TYPED-42"), "{}", screen.text());
}

#[test]
fn a_restart_mid_run_interrupts_the_thought_and_starts_nothing() {
    // A crash loses the terminal; a clean restart ends it first.
    for (prefix, crash, left) in [
        ("lr", true, TerminalState::Lost),
        ("lc", false, TerminalState::Exited),
    ] {
        let mut s = Scene::real(prefix, "fixture");
        let (t, session, terminal) = started(&mut s, "fix the build");
        let mut agent = screen(&s, terminal);
        agent.line("event:ready");
        agent.line("event:turn_started");
        s.w.until("the turn runs", |m| {
            m.session(session).state == SessionState::Working
        });
        let Scene { core, data, w, .. } = s;
        drop(w);
        if crash {
            drop(core);
        } else {
            core.stop();
        }
        let mut s = Scene::on(Core::with_agents(&data.0), data).running("fixture");
        let th = s.w.model.thought(t);
        assert_eq!(
            (th.status, th.reason),
            (Status::Failed, Some(Reason::Interrupted)),
            "{prefix}"
        );
        assert_eq!(s.w.model.terminals[&terminal].state, left, "{prefix}");
        assert_eq!(s.w.model.session(session).state, SessionState::Ended);
        s.tick(10 * HOLD_MS);
        let m = &s.w.model;
        assert_eq!((m.sessions.len(), m.terminals.len()), (1, 1), "{prefix}");
        assert_eq!(running(&mut s), 0, "{prefix}");
    }
}

#[test]
fn two_thoughts_launched_at_once_in_one_project_each_get_their_own_terminal() {
    let mut s = Scene::real("l2", "fixture");
    let a = s.capture("fix the build");
    let b = s.capture("update the docs");
    // Both holds end at once.
    s.tick(HOLD_MS);
    launched(&mut s, a);
    launched(&mut s, b);
    // Both launched: neither failed, as one did when both wrote the agent's
    // files at once through one temporary file (`agents::checks::whole`).
    let run = |t: ThoughtId| {
        let th = s.w.model.thought(t);
        let why: Vec<_> = (s.w.model.results_of(t).iter())
            .map(|r| r.summary.clone())
            .collect();
        assert_ne!(
            th.status,
            Status::Failed,
            "{:?} did not launch: {why:?}",
            th.text
        );
        let session = th.session_id.unwrap();
        (session, s.w.model.session(session).terminal_id.unwrap())
    };
    let (first, second) = (run(a), run(b));
    assert_ne!(first.1, second.1);
    for (_, terminal) in [first, second] {
        let row = &s.w.model.terminals[&terminal];
        assert_eq!(
            (row.project_id, row.state),
            (Some(s.project), TerminalState::Running)
        );
    }
    assert_eq!(running(&mut s), 2);
    // Each reports to its own session.
    for (ready, (session, terminal)) in [first, second].into_iter().enumerate() {
        screen(&s, terminal).line("event:ready");
        s.w.until("the session is ready", |m| {
            m.session(session).state == SessionState::Idle
        });
        let others = [first.0, second.0].into_iter().filter(|&o| o != session);
        for other in others {
            let idle = s.w.model.session(other).state == SessionState::Idle;
            assert_eq!(idle, ready == 1, "only the agent that said so is ready");
        }
    }
}

/// An agent that the person interrupts in its terminal and that says
/// nothing of it, as Claude Code, which has no interrupt hook, takes the
/// next prompt: the open turn ends as interrupted first, and the answer of
/// the next turn is the next thought's, not the interrupted one's.
#[test]
fn a_turn_started_while_one_is_open_ends_the_open_one_as_interrupted() {
    let mut s = Scene::real("li", "fixture");
    brief(&mut s, "steps follow");
    let (t, session, terminal) = started(&mut s, "first");
    let mut screen = screen(&s, terminal);
    screen.line("event:ready");
    screen.line("the first prompt");
    s.w.until("the first turn runs", |m| {
        m.session(session).state == SessionState::Working
    });
    assert_eq!(s.w.model.session(session).thought_id, Some(t));
    screen.line("the second prompt");
    s.w.until("the first thought ends", |m| m.status(t) == Status::Failed);
    assert_eq!(s.w.model.thought(t).reason, Some(Reason::Interrupted));
    let second = s.w.model.session(session).thought_id.unwrap();
    assert_ne!(second, t);
    assert_eq!(s.w.model.thought(second).text, "the second prompt");
    screen.line("event:turn_finished:the second answer");
    s.w.until("the second thought is done", |m| {
        m.status(second) == Status::Done
    });
    let results = s.w.model.results_of(second);
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].summary, "the second answer");
    assert!(
        s.w.model.results_of(t).is_empty(),
        "no answer for the first"
    );
}

/// What the core answers a program's questions with while no client is
/// attached (`terminal/queries.rs`), as `fixture-agent query` prints it.
#[cfg(unix)]
const ANSWERED: &str = r"answered:\x1b[?62;22c\x1b[>0;276;0c\x1b[1;1R\x1b]10;rgb:e4e4/e6e6/eded\x1b\\\x1b]11;rgb:1111/1313/1818\x07";

/// A run that no window shows asks its terminal what it is, where its
/// cursor is and which colors it has, and waits for the answers before it
/// goes on, as Codex does when it starts: the core answers as a terminal
/// does (design §9). The fixture needs `stty` for a raw terminal, which
/// Windows has not.
#[cfg(unix)]
#[test]
fn the_core_answers_what_a_run_asks_its_terminal_while_no_client_is_attached() {
    let mut s = Scene::real("lq", "fixture");
    brief(&mut s, "query");
    let (_, session, terminal) = started(&mut s, "ask the terminal");
    s.w.until("the agent has its answers and exits", |m| {
        m.session(session).state == SessionState::Ended
    });
    let mut screen = Screen::open(&s.core, terminal);
    screen.until(ANSWERED);
}

/// Once a client is attached, the questions after its `live` mark are its
/// to answer: the core says nothing, so the program gets one answer to each
/// question, the client's.
#[cfg(unix)]
#[test]
fn a_client_attached_answers_what_a_run_asks_and_the_core_does_not() {
    let mut s = Scene::real("la", "fixture");
    brief(&mut s, "steps follow");
    let (_, _, terminal) = started(&mut s, "ask the terminal later");
    let mut screen = screen(&s, terminal);
    screen.line("query");
    screen.until_bytes(b"\x1b]11;?\x07");
    let answers = b"\x1b[?1;2c\x1b[>1;10;0c\x1b[5;9R\x1b]10;rgb:0/0/0\x1b\\\x1b]11;rgb:f/f/f\x07";
    screen.write(answers);
    screen.until(&format!("answered:{}", answers.escape_ascii()));
    assert!(!screen.text().contains(ANSWERED));
}
