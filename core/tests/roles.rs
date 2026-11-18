//! The roles (design §4) through the real binary: `event`, `hook`, `ask`, the
//! shim and the fixture agent, each run as a process with a terminal's
//! session token, as an agent's hook or a person's shell runs them.
//!
//! The shims run without a terminal process: the core's fixture token names
//! a shell terminal that has only its record, the shim takes the test's pipes
//! for a terminal (`TASKTAP_FIXTURE_TTY`), and the fixture launcher plays the
//! terminal a follow-up is typed into.

mod common;

use common::*;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};
use tasktap_core::client::{self, Client};
use tasktap_core::roles::{self, shim};
use tasktap_proto::call::{self, Call, Code};
use tasktap_proto::{
    Adopt, AnswerQuestion, Auth, Capture, Control, Event as Said, Frame, Hello, Mode, QuestionId,
    QuestionKind, QuestionState, Reason, Ref, Response, Role, Secret, Session, SessionEvent,
    SessionId, SessionState, ShimHold, Status, TerminalKind, ThoughtId, VERSION, Versions,
};
#[cfg(unix)]
use tasktap_proto::{OpenTerminal, StartTerminal, TerminalId, TerminalState};

/// The fixture shell's token.
const SHELL: Secret = Secret([7; 32]);

fn hex(token: &Secret) -> String {
    serde_json::to_value(token)
        .unwrap()
        .as_str()
        .unwrap()
        .into()
}

/// The binary run as a role with the token of a terminal of `data`'s core,
/// and nothing else of Tasktap's in its environment.
fn role(data: &Path, token: &Secret, args: &[&str]) -> Command {
    in_terminal(Path::new(EXE), data, token, args)
}

/// `program` run in a terminal of `data`'s core whose token is `token`.
fn in_terminal(program: &Path, data: &Path, token: &Secret, args: &[&str]) -> Command {
    let mut c = bare(program, args);
    c.env(roles::SOCKET, data.join("core.sock"));
    c.env(roles::TOKEN, hex(token));
    c
}

/// `program` with no Tasktap environment at all, as outside its terminals.
fn bare(program: &Path, args: &[&str]) -> Command {
    let mut c = Command::new(program);
    c.args(args);
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("TASKTAP_") {
            c.env_remove(name);
        }
    }
    c
}

fn run(mut c: Command, stdin: &str) -> Output {
    c.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = c.spawn().unwrap();
    let written = child.stdin.take().unwrap().write_all(stdin.as_bytes());
    // A role that refuses its arguments may exit before it reads.
    if let Err(e) = written {
        assert_eq!(e.kind(), std::io::ErrorKind::BrokenPipe, "{e}");
    }
    child.wait_with_output().unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// The token of the session the fixture launcher started.
fn token(s: &mut Scene, session: SessionId) -> Secret {
    let log = s.log();
    let launch = log.launched.iter().find(|l| l.session == session).unwrap();
    launch.token.clone()
}

/// A thought launched after its hold; its session is still starting.
fn started(s: &mut Scene, text: &str) -> (ThoughtId, SessionId, Secret) {
    let t = s.capture(text);
    s.tick(HOLD_MS);
    let session = s.w.model.thought(t).session_id.unwrap();
    let token = token(s, session);
    (t, session, token)
}

fn answer(s: &mut Scene, id: QuestionId, response: Response) {
    s.w.ok::<call::QuestionAnswer>(&AnswerQuestion { id, response });
}

/// Whether `ready` holds within ten seconds, asking again every few
/// milliseconds: for what the core does without changing a record.
fn soon(mut ready: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if ready() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    false
}

// event

#[test]
fn event_reports_to_the_session_of_its_terminal() {
    let mut s = Scene::new("re");
    let (t, session, token) = started(&mut s, "fix the login");
    let data = s.data.0.clone();
    let event = |args: &[&str]| {
        let out = run(role(&data, &token, &[&["event"], args].concat()), "");
        assert!(out.status.success(), "{args:?}: {}", text(&out.stderr));
    };
    event(&["ready"]);
    s.w.until("ready", |m| m.session(session).state == SessionState::Idle);
    event(&["turn_started", "--id", "turn-1"]);
    s.w.until("the turn", |m| {
        m.session(session).state == SessionState::Working
    });
    assert_eq!(s.w.model.session(session).thought_id, Some(t));
    event(&["activity", "Editing", "src/login.ts"]);
    s.w.until("the activity", |m| {
        m.session(session).activity == [tasktap_core::state::TURN_STARTED, "Editing src/login.ts"]
    });
    event(&["turn_finished", "Fixed.\nThe login works again."]);
    s.w.until("the result", |m| m.status(t) == Status::Done);
    assert_eq!(s.w.model.results_of(t)[0].summary, "Fixed.");
    // The same id again is the same event; an exit only a shim reports.
    event(&["turn_started", "--id", "turn-1"]);
    event(&["exited", "3"]);
    s.w.sync();
    assert_eq!(s.w.model.session(session).state, SessionState::Idle);
    assert_eq!(s.w.model.session(session).turn, 1);
    // Wrong arguments are said before anything is sent.
    for args in [
        &["no_such_kind"][..],
        &["ready", "text"],
        &["turn_started", "--turn", "x"],
    ] {
        let out = run(role(&data, &token, &[&["event"], args].concat()), "");
        assert_eq!(out.status.code(), Some(roles::USAGE.into()), "{args:?}");
    }
}

// ask

#[test]
fn ask_prints_the_answer_a_device_gives_and_confirms_it() {
    let mut s = Scene::new("ra");
    let (_, session, mut agent) = s.launch("deploy");
    let token = token(&mut s, session);
    let mut ask = role(
        &s.data.0,
        &token,
        &["ask", "--choice", "staging", "--choice"],
    );
    ask.args([
        "production",
        "--detail",
        "after the tests",
        "Deploy",
        "where?",
    ]);
    let child = ask.stdout(Stdio::piped()).spawn().unwrap();
    let q = s.shown();
    let row = s.w.model.question(q).clone();
    assert_eq!(row.prompt, "Deploy where?");
    assert_eq!(row.detail.as_deref(), Some("after the tests"));
    assert_eq!(row.session_id, Some(session));
    let choices = vec!["staging".to_owned(), "production".into()];
    assert_eq!(row.kind, QuestionKind::Choice { choices });
    answer(&mut s, q, Response::Choice { choice: 1 });
    let out = child.wait_with_output().unwrap();
    assert_eq!(
        (out.status.code(), text(&out.stdout)),
        (Some(0), "production\n".into())
    );
    s.w.until("the receipt", |m| {
        m.question(q)
            .answer
            .as_ref()
            .is_some_and(|a| a.delivered.is_some())
    });

    // From standard input: the first line asks, the rest is the detail.
    let mut child = role(&s.data.0, &token, &["ask", "--request", "push"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"Push?\nto main\nnow\n")
        .unwrap();
    s.w.until("the second question", |m| m.questions.len() == 2);
    let (&q, row) =
        s.w.model
            .questions
            .iter()
            .find(|(id, _)| **id != q)
            .unwrap();
    assert_eq!(
        (row.prompt.as_str(), row.detail.as_deref()),
        ("Push?", Some("to main\nnow"))
    );
    assert_eq!(row.kind, QuestionKind::Confirm);
    answer(&mut s, q, Response::Deny);
    let out = child.wait_with_output().unwrap();
    assert_eq!(
        (out.status.code(), text(&out.stdout)),
        (Some(0), "no\n".into())
    );
    agent.sync();
}

#[test]
fn ask_ends_withdrawn_when_killed_or_when_its_turn_ends_and_a_key_asks_once() {
    let mut s = Scene::new("rw");
    let (_, session, mut agent) = s.launch("migrate");
    let token = token(&mut s, session);
    let data = s.data.0.clone();
    let ask = |request: &str| {
        let mut c = role(&data, &token, &["ask", "--request", request, "Go?"]);
        c.stdout(Stdio::piped()).stderr(Stdio::piped());
        c.spawn().unwrap()
    };

    // Killed: its question is withdrawn at once.
    let mut killed = ask("first");
    let q = s.shown();
    killed.kill().unwrap();
    killed.wait().unwrap();
    s.w.until("withdrawn", |m| {
        m.question(q).state == QuestionState::Withdrawn
    });

    // Asked again with its key while the turn lives: the same question.
    let again = ask("first");
    s.w.until("reopened", |m| m.question(q).state == QuestionState::Open);
    assert_eq!(s.w.model.questions.len(), 1);
    answer(&mut s, q, Response::Affirm);
    let out = again.wait_with_output().unwrap();
    assert_eq!(
        (out.status.code(), text(&out.stdout)),
        (Some(0), "yes\n".into())
    );
    // And once more: the stored answer, at once.
    let out = ask("first").wait_with_output().unwrap();
    assert_eq!(
        (out.status.code(), text(&out.stdout)),
        (Some(0), "yes\n".into())
    );
    assert_eq!(s.w.model.questions.len(), 1);

    // The turn ends under a waiting ask: withdrawn, exit 3.
    let waiting = ask("second");
    s.w.until("the second question", |m| m.questions.len() == 2);
    agent.finish("Done.");
    let out = waiting.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(roles::WITHDRAWN.into()));
    assert_eq!(text(&out.stdout), "");
    assert_eq!(text(&out.stderr).lines().count(), 1);
}

// hook

/// A waiting question in the fixture agent's words.
fn waiting(request: &str, choices: &[&str]) -> String {
    let question = serde_json::json!({
        "request": request, "kind": "choice", "choices": choices, "prompt": "Which?"
    });
    serde_json::json!({ "id": request, "kind": "question", "question": question, "wait": true })
        .to_string()
}

#[test]
fn a_hook_reports_or_waits_and_prints_its_adapters_reply() {
    let mut s = Scene::new("rh");
    let (_, session, mut agent) = s.launch("tidy up");
    let token = token(&mut s, session);
    let data = s.data.0.clone();
    let hook = || role(&data, &token, &["hook", "fixture"]);
    let activity = r#"{"id": "a1", "kind": "activity", "text": "Reading notes.md"}"#;
    assert!(run(hook(), activity).status.success());
    s.w.until("the activity", |m| {
        m.session(session)
            .activity
            .last()
            .is_some_and(|l| l == "Reading notes.md")
    });

    let mut waiter = hook();
    waiter.stdin(Stdio::piped()).stdout(Stdio::piped());
    let mut child = waiter.spawn().unwrap();
    let payload = waiting("tool-7", &["keep", "drop"]);
    child
        .stdin
        .take()
        .unwrap()
        .write_all(payload.as_bytes())
        .unwrap();
    let q = s.shown();
    assert_eq!(s.w.model.question(q).prompt, "Which?");
    answer(&mut s, q, Response::Choice { choice: 1 });
    let out = child.wait_with_output().unwrap();
    assert_eq!(
        (out.status.code(), text(&out.stdout)),
        (Some(0), "drop\n".into())
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
fn a_malformed_hook_payload_exits_cleanly_and_sends_nothing() {
    let mut s = Scene::new("rm");
    let (t, session, mut agent) = s.launch("tidy up");
    let token = token(&mut s, session);
    let before = (
        s.w.model.session(session).clone(),
        s.w.model.thought(t).clone(),
    );
    for payload in [
        "not json",
        r#"{"id": "x", "kind": "no_such_kind"}"#,
        "",
        "[1, 2]",
    ] {
        let out = run(role(&s.data.0, &token, &["hook", "fixture"]), payload);
        assert_eq!(
            out.status.code(),
            Some(roles::MALFORMED.into()),
            "{payload}"
        );
        assert_eq!(text(&out.stderr).lines().count(), 1, "{payload}");
        assert_eq!(text(&out.stdout), "");
    }
    let out = run(role(&s.data.0, &token, &["hook", "no-such-agent"]), "{}");
    assert_eq!(out.status.code(), Some(roles::USAGE.into()));
    s.w.sync();
    assert_eq!(
        (
            s.w.model.session(session).clone(),
            s.w.model.thought(t).clone()
        ),
        before
    );
    agent.say(Said::Activity {
        text: "still here".into(),
    });
}

#[test]
fn a_hook_whose_agent_never_closes_its_pipe_gives_up() {
    let mut s = Scene::new("rp");
    let (_, session, _agent) = s.launch("tidy up");
    let token = token(&mut s, session);
    let mut hook = role(&s.data.0, &token, &["hook", "fixture"]);
    let mut child = hook
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Held open, as by an agent that never finishes writing.
    let _input = child.stdin.take();
    let started = Instant::now();
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(roles::UNREACHABLE.into()));
    assert!(started.elapsed() < roles::WAIT + Duration::from_secs(5));
}

// Errors

#[test]
fn a_role_without_a_good_token_or_a_core_fails_fast_with_one_line() {
    let mut s = Scene::new("rt");
    let (_, session, _agent) = s.launch("tidy up");
    let data = s.data.0.clone();
    let good = token(&mut s, session);
    let cases: [(Command, u8); 5] = [
        (bare(Path::new(EXE), &["event", "ready"]), roles::OUTSIDE),
        (
            role(&data, &Secret([9; 32]), &["event", "ready"]),
            roles::REFUSED,
        ),
        (
            {
                let mut c = role(&data, &good, &["ask", "Go?"]);
                c.env(roles::TOKEN, "not a token");
                c
            },
            roles::REFUSED,
        ),
        (
            role(&data.join("nowhere"), &good, &["event", "ready"]),
            roles::UNREACHABLE,
        ),
        (role(&data, &good, &["nonsense"]), roles::USAGE),
    ];
    for (c, code) in cases {
        let started = Instant::now();
        let out = run(c, "");
        assert_eq!(
            out.status.code(),
            Some(code.into()),
            "{}",
            text(&out.stderr)
        );
        assert_eq!(text(&out.stderr).lines().count(), 1);
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}

// The shim

/// A core whose fixture token is a shell's, with the shims installed, and a
/// "real" fixture agent elsewhere on the PATH: a copy of the binary, since
/// a link to it would be the shim itself.
struct Shell {
    s: Scene,
    shims: PathBuf,
    real: PathBuf,
}

impl Shell {
    fn new(prefix: &str) -> Shell {
        let data = Folder::new(prefix);
        let core = Core::start_with(&data.0, &["--fixture-token", &hex(&SHELL)]);
        let shims = shim::install(&data.0, Path::new(EXE)).unwrap();
        let real = data.0.join("real");
        std::fs::create_dir_all(&real).unwrap();
        if as_batch_files() {
            batch_file(&real, "fixture");
        } else {
            let agent = real
                .join("fixture")
                .with_extension(std::env::consts::EXE_EXTENSION);
            std::fs::copy(EXE, agent).unwrap();
        }
        let s = Scene::on(core, data);
        Shell { s, shims, real }
    }

    /// `fixture ARGS` typed in the shell.
    fn shim(&self, args: &[&str]) -> Command {
        typed_in(&self.s.data.0, &self.shims, &self.real, args)
    }

    fn spawn(&self, args: &[&str]) -> Child {
        let mut c = self.shim(args);
        c.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c.spawn().unwrap()
    }

    /// The adopted session, once one is alive.
    fn adopted(&mut self) -> Session {
        self.s.w.until("an adopted session", |m| {
            m.sessions
                .values()
                .any(|s| s.adopted && s.state != SessionState::Ended)
        });
        let mut live = self.s.w.model.sessions.values();
        live.find(|s| s.adopted && s.state != SessionState::Ended)
            .unwrap()
            .clone()
    }

    /// The session once it has ended; `None` when it left the live records
    /// with that, having no thought that keeps it.
    fn ended(&mut self, session: SessionId) -> Option<Session> {
        let ended = |m: &Model| {
            m.sessions
                .get(&session)
                .is_none_or(|s| s.state == SessionState::Ended)
        };
        self.s.w.until("the session ends", ended);
        self.s.w.model.sessions.get(&session).cloned()
    }

    /// A follow-up for the session, routed and started once its hold ends.
    fn follow_up(&mut self, session: SessionId, text: &str) -> ThoughtId {
        let f = ThoughtId::mint();
        let capture = Capture {
            session_id: Some(session),
            ..typed(f, text)
        };
        self.s.w.ok::<call::ThoughtCapture>(&capture);
        assert_eq!(self.s.w.model.thought(f).mode, Mode::Nudge);
        self.s.tick(HOLD_MS);
        f
    }
}

/// `fixture ARGS` typed in a shell of `data`'s core, with the shims first
/// on the PATH and the real fixture agent after them.
fn typed_in(data: &Path, shims: &Path, real: &Path, args: &[&str]) -> Command {
    let program = shims
        .join("fixture")
        .with_extension(std::env::consts::EXE_EXTENSION);
    let mut c = in_terminal(&program, data, &SHELL, args);
    c.env("TASKTAP_FIXTURE_TTY", "1");
    c.env("PATH", std::env::join_paths([shims, real]).unwrap());
    c
}

/// The first line the fixture agent prints: `fixture-agent` and what it got.
fn got(out: &Output) -> String {
    text(&out.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned()
}

#[test]
fn a_shim_adopts_its_agent_attaches_its_hooks_and_reports_its_exit() {
    let mut sh = Shell::new("rs");
    let out = run(
        sh.shim(&[
            "event:ready",
            "event:turn_started:rename the module",
            "print:busy",
            "exit:4",
        ]),
        "",
    );
    assert_eq!(out.status.code(), Some(4), "{}", text(&out.stderr));
    // The hooks run `tasktap` from the shim folder, the policy comes before
    // the person's own arguments.
    let line = got(&out);
    let (hook, rest) = line
        .strip_prefix("fixture-agent --hook ")
        .and_then(|rest| rest.split_once(" --approve "))
        .unwrap_or_else(|| panic!("{line}"));
    let hook = Path::new(hook);
    assert_eq!(hook.file_stem().unwrap(), "tasktap");
    assert_eq!(
        std::fs::canonicalize(hook.parent().unwrap()).unwrap(),
        std::fs::canonicalize(&sh.shims).unwrap()
    );
    assert_eq!(
        rest,
        "event:ready event:turn_started:rename the module print:busy exit:4"
    );
    assert!(text(&out.stdout).contains("\nbusy\n"));
    // Its typed prompt's thought keeps it among the live records.
    let ended = |m: &Model| {
        m.sessions
            .values()
            .any(|s| s.adopted && s.state == SessionState::Ended)
    };
    sh.s.w.until("the adopted session ends", ended);
    let session =
        sh.s.w
            .model
            .sessions
            .values()
            .find(|s| s.adopted)
            .unwrap()
            .clone();
    let shell =
        sh.s.w
            .model
            .terminals
            .values()
            .find(|t| t.kind == TerminalKind::Shell)
            .unwrap();
    assert_eq!(session.terminal_id, Some(shell.id));
    assert_eq!(
        (session.agent.as_str(), session.exit, session.turn),
        ("fixture", Some(4), 1)
    );
    // The prompt typed by hand became a thought, which the exit ended.
    let t =
        sh.s.w
            .model
            .thoughts
            .values()
            .find(|t| t.text == "rename the module")
            .unwrap();
    assert_eq!((t.status, t.reason), (Status::Failed, Some(Reason::Exited)));

    // A policy of the person's own is kept, and no default is added.
    let out = run(sh.shim(&["--no-approve", "print:x"]), "");
    let words: Vec<String> = got(&out).split(' ').map(Into::into).collect();
    assert!(words.contains(&"--no-approve".into()) && !words.contains(&"--approve".into()));
}

/// The same in a real shell the core runs, which has the shims first on its
/// PATH: the agent's name typed there is adopted as a session of that shell.
#[cfg(unix)]
#[test]
fn an_agent_typed_in_a_shell_of_the_core_is_adopted() {
    let data = Folder::new("rq");
    let real = data.0.join("real");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::copy(EXE, real.join("fixture")).unwrap();
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let path = std::env::split_paths(&inherited).collect::<Vec<_>>();
    let path = std::env::join_paths([real].into_iter().chain(path)).unwrap();
    let env = [("SHELL", "/bin/sh"), ("PATH", path.to_str().unwrap())];
    let mut s = Scene::on(Core::start_env(&data.0, &[], &env), data);
    let mut c = s.core.device();
    let open = OpenTerminal {
        id: TerminalId::mint(),
        start: Some(StartTerminal {
            project: None,
            argv: Vec::new(),
            title: None,
        }),
        cols: 80,
        rows: 24,
        from: None,
        credit: 1 << 20,
    };
    let opened = c.opened::<call::TerminalOpen>(&open, 1 << 20, true);
    let shell = opened.unwrap().unwrap().s;
    // The first shell filled the shim folder: a shim for each agent with an
    // adapter, and tasktap; any other agent runs as typed.
    let mut shims: Vec<String> = std::fs::read_dir(s.data.0.join("shims"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    shims.sort();
    assert_eq!(shims, ["agy", "claude", "codex", "fixture", "tasktap"]);
    let typed = b"fixture event:ready event:turn_started:tidy exit:4\r";
    c.write(shell, typed).unwrap();
    let ended = |m: &Model| {
        m.sessions
            .values()
            .any(|s| s.adopted && s.state == SessionState::Ended)
    };
    s.w.until("the adopted session ends", ended);
    let session = s.w.model.sessions.values().find(|s| s.adopted).unwrap();
    assert_eq!(session.terminal_id, Some(open.id));
    assert_eq!((session.agent.as_str(), session.exit), ("fixture", Some(4)));
    assert_eq!(s.w.model.terminals[&open.id].state, TerminalState::Running);
}

#[test]
fn a_shim_steps_aside_where_no_one_types_or_an_agent_runs_already() {
    let mut sh = Shell::new("rx");
    // What `tasktap_shell.py` ran untouched still runs untouched.
    for args in [
        &["--version"][..],
        &["-h"],
        &["help", "me"],
        &["--json", "print:x"],
    ] {
        let out = run(sh.shim(args), "");
        assert!(out.status.success(), "{args:?}: {}", text(&out.stderr));
        assert_eq!(got(&out), format!("fixture-agent {}", args.join(" ")));
    }
    // Not a terminal, or not a Tasktap shell.
    let mut piped = sh.shim(&["print:x"]);
    piped.env_remove("TASKTAP_FIXTURE_TTY");
    let mut outside = sh.shim(&["print:x"]);
    outside.env_remove(roles::TOKEN);
    for c in [piped, outside] {
        assert_eq!(got(&run(c, "")), "fixture-agent print:x");
    }
    sh.s.w.sync();
    assert!(sh.s.w.model.sessions.is_empty());

    // An agent runs in this terminal: another one runs inside it, unobserved.
    let outer = sh.spawn(&["event:ready", "event:turn_started:outer", "wait"]);
    let session = sh.adopted();
    let inner = run(sh.shim(&["print:inside"]), "");
    assert_eq!(got(&inner), "fixture-agent print:inside");
    assert_eq!(text(&inner.stderr), "");
    outer.stdin.as_ref().unwrap().write_all(b"done\n").unwrap();
    let out = outer.wait_with_output().unwrap();
    assert!(text(&out.stdout).contains("read:done"));
    assert_eq!(sh.ended(session.id).unwrap().exit, Some(0));
    assert_eq!(sh.s.w.model.sessions.len(), 1);

    // Nothing to step aside to.
    let mut lost = sh.shim(&["print:x"]);
    lost.env("PATH", &sh.shims);
    let out = run(lost, "");
    assert_eq!(out.status.code(), Some(127));
    assert_eq!(text(&out.stderr).lines().count(), 1);
}

#[test]
fn a_shim_killed_ends_its_session_and_stopping_one_never_ends_the_shell() {
    let mut sh = Shell::new("rk");
    let mut child = sh.spawn(&["event:ready", "event:turn_started:task", "wait"]);
    let session = sh.adopted();
    sh.s.w
        .until("the turn", |m| m.session(session.id).turn == 1);
    child.kill().unwrap();
    child.wait().unwrap();
    assert_eq!(sh.ended(session.id).unwrap().exit, None);
    // The agent it left reads the end of its input and goes.
    drop(child.stdin.take());

    let mut child = sh.spawn(&["event:ready", "wait"]);
    let session = sh.adopted();
    sh.s.w.until("idle", |m| {
        m.session(session.id).state == SessionState::Idle
    });
    let f = sh.follow_up(session.id, "and the docs");
    assert!(soon(|| sh.s.log().delivered.contains(&f)));
    sh.s.w.ok::<call::ThoughtStop>(&Ref { id: f });
    // No terminal is stopped: the shim ends its agent, which waited to read
    // a line, and then itself, with the agent's end.
    let log = sh.s.log();
    assert!(log.killed.is_empty(), "{:?}", log.killed);
    sh.ended(session.id);
    // The session ends with the stop; the shim ends with its agent, which
    // must go without its input closing, as it would never close there.
    assert!(
        soon(|| child.try_wait().unwrap().is_some()),
        "the agent runs on"
    );
    let out = child.wait_with_output().unwrap();
    assert!(!out.status.success(), "{out:?}");
    assert!(!text(&out.stdout).contains("read:"), "{out:?}");
}

#[test]
fn a_follow_up_is_typed_while_the_shim_holds_and_never_after_its_agent_left() {
    let mut sh = Shell::new("rf");
    let child = sh.spawn(&["event:ready", "wait", "print:after"]);
    let session = sh.adopted();
    sh.s.w.until("idle", |m| {
        m.session(session.id).state == SessionState::Idle
    });
    let f = sh.follow_up(session.id, "and the tests");
    assert!(soon(|| sh.s.log().delivered.contains(&f)));
    assert_eq!(sh.s.w.model.status(f), Status::Working);
    child
        .stdin
        .as_ref()
        .unwrap()
        .write_all(b"and the tests\n")
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(text(&out.stdout).contains("read:and the tests\nafter\n"));
    sh.ended(session.id);

    // Its agent exits while the core types: the shim keeps the terminal
    // until the text is written.
    sh.s.pause = true;
    sh.s.log();
    let mut child = sh.spawn(&["event:ready", "wait"]);
    let session = sh.adopted();
    sh.s.w.until("idle", |m| {
        m.session(session.id).state == SessionState::Idle
    });
    let f = sh.follow_up(session.id, "and the changelog");
    assert!(soon(|| sh.s.log().held.contains(&f)));
    child.stdin.as_ref().unwrap().write_all(b"bye\n").unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        child.try_wait().unwrap().is_none(),
        "the shim left while held"
    );
    sh.s.w.sync();
    assert_ne!(sh.s.w.model.session(session.id).state, SessionState::Ended);
    sh.s.pause = false;
    assert!(sh.s.log().delivered.contains(&f));
    assert!(child.wait().unwrap().success());
    sh.ended(session.id);

    // After the agent's exit a follow-up to its session is never typed.
    let late = sh.follow_up(session.id, "and the readme");
    sh.s.w.sync();
    assert!(!sh.s.log().delivered.contains(&late));
}

/// A connection with the shell's token that adopts as a shim does, offering
/// `shim.hold` or not, and answers what the test says.
fn fake_shim(sh: &Shell, holds: bool) -> (Client, SessionId) {
    let stream = client::connect(&sh.s.data.0).unwrap();
    let hello = Hello {
        v: Versions(VERSION, VERSION),
        role: Role::Cli,
        client: "fake shim".into(),
        auth: Some(Auth::Session { token: SHELL }),
        abilities: holds.then(|| "shim.hold".into()).into_iter().collect(),
    };
    let mut c = Client::hello(stream, hello).unwrap().unwrap();
    let adopt = Adopt {
        agent: "fixture".into(),
        cwd: "/".into(),
    };
    let session = c.call::<call::SessionAdopt>(&adopt).unwrap().unwrap();
    let ready = SessionEvent {
        id: "ready".into(),
        turn: None,
        subagent: false,
        event: Said::Ready,
        resume: None,
    };
    c.call::<call::SessionEvent>(&ready).unwrap().unwrap();
    (c, session)
}

#[test]
fn a_follow_up_the_shim_cannot_hold_for_fails_and_is_never_typed() {
    let mut sh = Shell::new("rn");
    // The shim says its agent is gone.
    let (mut shim, session) = fake_shim(&sh, true);
    // A second adoption in the same shell is refused while this one lives.
    let mut twice = sh.s.core.agent(&SHELL);
    let adopt = serde_json::json!({ "agent": "fixture", "cwd": "/" });
    assert_eq!(code(twice.raw("session.adopt", adopt)), Code::Conflict);
    let f = sh.follow_up(session, "and the tests");
    let Frame::Control(Control::Call(request)) = shim.recv().unwrap() else {
        panic!("expected shim.hold");
    };
    assert_eq!(request.name, "shim.hold");
    assert_eq!(
        call::ShimHold::args(request.args).unwrap(),
        ShimHold {
            hold: true,
            stop: false
        }
    );
    let gone = tasktap_proto::Error::new(Code::Gone, "the agent has exited");
    shim.send(&call::ShimHold::reply(request.id, Err(gone)))
        .unwrap();
    sh.s.w.until("failed", |m| m.status(f) == Status::Failed);
    assert_eq!(sh.s.w.model.thought(f).reason, Some(Reason::Launch));
    assert!(!sh.s.log().delivered.contains(&f));
    // Its connection ends: the session it adopted ends.
    drop(shim);
    sh.ended(session);

    // A shim that cannot hold: the follow-up fails at once.
    let (_shim, session) = fake_shim(&sh, false);
    let f = sh.follow_up(session, "and the docs");
    sh.s.w.until("failed", |m| m.status(f) == Status::Failed);
    assert!(!sh.s.log().delivered.contains(&f));
}

// Many at once

/// Held by each test that starts processes by the hundred, so that no two
/// of them share the machine. A burst asks whether one core lets 200 clients
/// in within their 5 s; while another test starts thousands of processes
/// beside it on a small machine (the hosted Mac in CI), the processor is
/// what keeps them waiting, not the core.
static MACHINE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The machine to this test alone, among those that hold [`MACHINE`].
fn alone() -> std::sync::MutexGuard<'static, ()> {
    MACHINE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Spawns every command at once, as a burst of hooks does, and returns
/// their outputs.
fn burst(commands: Vec<Command>) -> Vec<Output> {
    let children: Vec<Child> = commands
        .into_iter()
        .map(|mut c| {
            c.stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            c.spawn().unwrap()
        })
        .collect();
    children
        .into_iter()
        .map(|c| c.wait_with_output().unwrap())
        .collect()
}

#[test]
fn two_hundred_roles_started_at_once_start_one_core_and_all_get_through() {
    let _alone = alone();
    let data = Folder::new("rb");
    let _core = Started(&data.0);
    let shims = shim::install(&data.0, Path::new(EXE)).unwrap();
    let real = data.0.join("real");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::copy(
        EXE,
        real.join("fixture")
            .with_extension(std::env::consts::EXE_EXTENSION),
    )
    .unwrap();
    let serve = format!("--fixture-token {} --idle-ms 600000", hex(&SHELL));
    // Shims, so each needs the core and gets through with a session: one
    // adopts its agent at a time, the others step aside.
    let commands = (0..200)
        .map(|i| {
            let mut c = typed_in(&data.0, &shims, &real, &[&format!("print:{i}")]);
            c.env("TASKTAP_FIXTURE_SERVE", &serve);
            c
        })
        .collect();
    let outs = burst(commands);
    for (i, out) in outs.iter().enumerate() {
        assert!(out.status.success(), "{i}: {}", text(&out.stderr));
        assert!(text(&out.stdout).contains(&format!("\n{i}\n")), "{i}");
        assert_eq!(text(&out.stderr), "", "{i}");
    }
    // Some adopted their agent, which then ran with its hooks.
    assert!(outs.iter().any(|out| got(out).contains("--hook")));
    let starts = std::fs::read_to_string(data.0.join("starts")).unwrap();
    assert_eq!(starts.lines().count(), 1, "{starts}");
}

#[test]
fn two_hundred_hooks_at_once_on_a_running_core_all_get_through() {
    let _alone = alone();
    let mut s = Scene::new("rq");
    let (_, session, _agent) = s.launch("tidy up");
    let token = token(&mut s, session);
    let commands = (0..200)
        .map(|i| {
            role(
                &s.data.0,
                &token,
                &["event", "activity", &format!("step {i}")],
            )
        })
        .collect();
    for (i, out) in burst(commands).iter().enumerate() {
        assert!(out.status.success(), "{i}: {}", text(&out.stderr));
    }
    let starts = std::fs::read_to_string(s.data.0.join("starts")).unwrap();
    assert_eq!(starts.lines().count(), 1, "{starts}");
}

/// macOS checks each program it starts by reading it, and kills the one it
/// cannot read. With a second name for the binary (a hard link) the name it
/// reads may be one link's name in another link's folder, a file that does
/// not exist: the shims, and the binary under its own name, must start
/// while other shim folders come and go, as each test's do.
#[cfg(target_os = "macos")]
#[test]
fn shims_start_while_other_shim_folders_come_and_go() {
    use std::os::unix::process::ExitStatusExt;
    let _alone = alone();
    let rounds: Vec<_> = (0..8)
        .map(|_| {
            std::thread::spawn(|| {
                let mut killed = Vec::new();
                for _ in 0..12 {
                    let data = Folder::new("rk");
                    let shims = shim::install(&data.0, Path::new(EXE)).unwrap();
                    let tasktap = shims.join("tasktap");
                    let runs: Vec<Child> = (0..80)
                        .map(|i| {
                            let program = if i % 2 == 0 { &tasktap } else { Path::new(EXE) };
                            let mut c = Command::new(program);
                            c.stdout(Stdio::null()).stderr(Stdio::null());
                            c.spawn().unwrap()
                        })
                        .collect();
                    for mut run in runs {
                        let status = run.wait().unwrap();
                        killed.extend(status.signal());
                    }
                }
                killed
            })
        })
        .collect();
    let killed: Vec<i32> = rounds.into_iter().flat_map(|r| r.join().unwrap()).collect();
    assert!(killed.is_empty(), "signals that ended a run: {killed:?}");
}

/// The core a role started on a folder: retired when this is dropped, also
/// when the test fails, so it never outlives its test by its idle delay.
struct Started<'a>(&'a Path);

impl Drop for Started<'_> {
    fn drop(&mut self) {
        let retire = tasktap_proto::Retire {
            when: tasktap_proto::When::Now,
        };
        // No panic here: it would abort the test that is already failing.
        if let Some(mut c) = device(self.0) {
            let _ = c.call::<call::CoreRetire>(&retire);
        }
    }
}

fn device(data: &Path) -> Option<Client> {
    let stream = client::connect(data).ok()?;
    let hello = Hello {
        v: Versions(VERSION, VERSION),
        role: Role::Cli,
        client: "test".into(),
        auth: Some(Auth::Device {
            device: tasktap_proto::DeviceId::mint(),
            key: Secret([1; 32]),
            register: Some(tasktap_proto::Register {
                name: "test".into(),
            }),
        }),
        abilities: Vec::new(),
    };
    Client::hello(stream, hello).ok()?.ok()
}

// Speed

/// `cargo test --release --test roles -- --ignored --nocapture`: start to
/// exit of `tasktap event` against a running core (design §10: 10 ms).
#[test]
#[ignore]
fn event_start_to_exit() {
    let mut s = Scene::new("rv");
    let (_, session, _agent) = s.launch("measure");
    let token = token(&mut s, session);
    let mut times: Vec<Duration> = (0..301)
        .map(|i| {
            let mut c = role(
                &s.data.0,
                &token,
                &["event", "activity", &format!("step {i}")],
            );
            c.stdout(Stdio::null()).stderr(Stdio::null());
            let started = Instant::now();
            assert!(c.status().unwrap().success());
            started.elapsed()
        })
        .collect();
    times.sort();
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    println!(
        "tasktap event, {} runs: median {:.2} ms, p90 {:.2} ms, max {:.2} ms (target 10 ms)",
        times.len(),
        ms(times[times.len() / 2]),
        ms(times[times.len() * 9 / 10]),
        ms(times[times.len() - 1]),
    );
}
