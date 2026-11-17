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
    ResultKind, Route, SessionId, SessionState, Status, TerminalId, TerminalKind, TerminalState,
    ThoughtId,
};

/// A thought launched once its hold passed, with its session and terminal.
fn started(s: &mut Scene, text: &str) -> (ThoughtId, SessionId, TerminalId) {
    let t = s.capture(text);
    s.tick(HOLD_MS);
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
    s.script(Route::Clear { to, brief }, None);
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
fn the_agents_exit_code_ends_its_session_and_terminal() {
    let mut s = Scene::real("lx", "fixture");
    // An agent that reports events has not finished by exiting, even with 0.
    for code in [3, 0] {
        brief(&mut s, &format!("exit:{code}"));
        let (t, session, terminal) = started(&mut s, "fix the build");
        s.w.until("the terminal ends", |m| {
            m.terminals[&terminal].state == TerminalState::Exited
        });
        let m = &s.w.model;
        let ended = m.session(session);
        assert_eq!((ended.state, ended.exit), (SessionState::Ended, Some(code)));
        assert_eq!(m.terminals[&terminal].exit, Some(code));
        let th = m.thought(t);
        assert_eq!(
            (th.status, th.reason),
            (Status::Failed, Some(Reason::Exited))
        );
    }
    assert_eq!(running(&mut s), 0);
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

#[test]
fn a_follow_up_whose_agent_exits_before_it_is_typed_is_never_typed() {
    let mut s = Scene::real("le", "fixture");
    let (_, session, terminal) = started(&mut s, "fix the build");
    let mut agent = screen(&s, terminal);
    agent.line("event:ready");
    s.w.until("the session is ready", |m| {
        m.session(session).state == SessionState::Idle
    });
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
    agent.ended();
    assert!(!agent.text().contains("rm -rf"), "{}", agent.text());
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

    let f = follow_up(&mut s, session, "and the tests");
    screen.until("prompt:and the tests");
    s.w.until("the follow-up runs", |m| {
        m.session(session).thought_id == Some(f)
    });
    screen.line("event:turn_finished:Tests added.");
    s.w.until("the follow-up is done", |m| m.status(f) == Status::Done);

    // Stopping a run of it ends the session and never the person's shell.
    let g = follow_up(&mut s, session, "and the docs");
    screen.until("prompt:and the docs");
    s.w.until("the next follow-up runs", |m| {
        m.session(session).thought_id == Some(g)
    });
    s.w.ok::<call::ThoughtStop>(&Ref { id: g });
    assert_eq!(s.w.model.session(session).state, SessionState::Ended);
    // Nothing was sent to the terminal: the agent, unobserved now, goes on.
    screen.line("wait");
    screen.line("still here");
    screen.until("read:still here");
    assert_eq!(s.w.model.terminals[&shell].state, TerminalState::Running);
    screen.line("exit:0");
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
    let run = |t: ThoughtId| {
        let session = s.w.model.thought(t).session_id.unwrap();
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
