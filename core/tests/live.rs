//! Live runs of the real agents through the core (design §14 D). Every test
//! here is ignored by default: each runs Claude Code or Codex, signed in on
//! this computer, for a few short turns on the person's own subscription.
//! `core/scripts/live-agents.sh` runs them and says what they did.
//!
//! Each test captures thoughts through the protocol, lets the real launcher
//! start the agent in a real terminal, and follows the records to the
//! result. The project is a throwaway git repository at one fixed place
//! (`<temp>/tasktap-live-agents/project`, or `TASKTAP_LIVE_PROJECT`), made
//! anew each time, so that an agent that asks once whether to trust a folder
//! asks about this one only; the data folder is a new temporary one. A
//! terminal client stands in for the workspace page: it answers the
//! terminal's queries as a terminal does, and types what a test tells it to
//! when the screen shows something.

mod common;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use tasktap_proto::call;
use tasktap_proto::{
    AnswerQuestion, Capture, Control, Frame, Mode, OpenTerminal, PrefPatch, Put, PutTarget,
    QuestionId, QuestionKind, QuestionState, Ref, ReplyVia, Response, SessionId, SessionState,
    Status, TerminalId, ThoughtId,
};

/// Longest a live test may hold its core.
const PATIENCE: Duration = Duration::from_secs(15 * 60);

/// The throwaway project, made anew.
fn project() -> PathBuf {
    let folder = std::env::var_os("TASKTAP_LIVE_PROJECT").map_or_else(
        || std::env::temp_dir().join("tasktap-live-agents/project"),
        PathBuf::from,
    );
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    let init = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(&folder)
        .status()
        .unwrap();
    assert!(init.success(), "git init");
    let folder = std::fs::canonicalize(&folder).unwrap();
    say(&format!(
        "project: a new git repository at {}",
        folder.display()
    ));
    folder
}

fn say(what: &str) {
    eprintln!("live: {what}");
}

/// A terminal client, as the workspace page is one: it answers the queries
/// a program asks its terminal (device attributes, colors, cursor), which
/// Codex waits for before it starts, and types keys when the screen shows a
/// marker it was given.
struct Tty {
    seen: Arc<Mutex<Vec<u8>>>,
    rules: Arc<Mutex<Vec<Rule>>>,
    closed: Arc<AtomicBool>,
}

struct Rule {
    /// Only what arrived after this many bytes counts.
    after: usize,
    marker: String,
    keys: Vec<u8>,
    fired: bool,
}

impl Tty {
    fn attach(core: &Core, id: TerminalId) -> Tty {
        let mut c = core.device();
        patient(&mut c);
        let open = OpenTerminal {
            id,
            start: None,
            cols: 120,
            rows: 40,
            from: None,
            credit: 1 << 20,
        };
        let opened = c.opened::<call::TerminalOpen>(&open, 1 << 20, true);
        let s = opened.unwrap().expect("the terminal opens").s;
        let tty = Tty {
            seen: Arc::default(),
            rules: Arc::default(),
            closed: Arc::default(),
        };
        let (seen, rules, closed) = (tty.seen.clone(), tty.rules.clone(), tty.closed.clone());
        std::thread::spawn(move || {
            loop {
                match c.recv() {
                    Ok(Frame::Data(d)) if d.s == s => {
                        let mut reply = Vec::new();
                        for (query, answer) in [
                            (&b"\x1b[c"[..], &b"\x1b[?62;22c"[..]),
                            (b"\x1b[0c", b"\x1b[?62;22c"),
                            (b"\x1b[6n", b"\x1b[1;1R"),
                            (b"\x1b]10;?", b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\"),
                            (b"\x1b]11;?", b"\x1b]11;rgb:0000/0000/0000\x1b\\"),
                        ] {
                            if d.bytes.windows(query.len()).any(|w| w == query) {
                                reply.extend_from_slice(answer);
                            }
                        }
                        let mut seen = seen.lock().unwrap();
                        seen.extend_from_slice(&d.bytes);
                        for rule in rules.lock().unwrap().iter_mut().filter(|r| !r.fired) {
                            let text = plain(&seen[rule.after.min(seen.len())..]);
                            if text.contains(&rule.marker) {
                                rule.fired = true;
                                say(&format!("the screen shows {:?}: typing", rule.marker));
                                std::thread::sleep(Duration::from_millis(800));
                                reply.extend_from_slice(&rule.keys);
                            }
                        }
                        drop(seen);
                        if !reply.is_empty() && c.write(s, &reply).is_err() {
                            break;
                        }
                    }
                    Ok(Frame::Control(Control::Close(close))) if close.s == s => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            closed.store(true, Ordering::SeqCst);
        });
        tty
    }

    /// Types `keys` once the screen shows `marker` in what arrives from now.
    fn when(&self, marker: &str, keys: &[u8]) {
        let after = self.seen.lock().unwrap().len();
        self.rules.lock().unwrap().push(Rule {
            after,
            marker: marker.into(),
            keys: keys.into(),
            fired: false,
        });
    }
}

/// Follows a device's records until `ready`. Past `limit` it says what
/// the terminal showed and ends the core, which fails the wait.
fn until(
    core: &Core,
    w: &mut Watch,
    tty: Option<&Tty>,
    what: &str,
    limit: Duration,
    ready: impl Fn(&Model) -> bool,
) {
    let start = Instant::now();
    let done = Arc::new(AtomicBool::new(false));
    let seen = tty.map(|t| t.seen.clone());
    let (pid, label) = (core.pid().to_string(), what.to_owned());
    std::thread::spawn({
        let done = done.clone();
        move || {
            while start.elapsed() < limit {
                std::thread::sleep(Duration::from_millis(200));
                if done.load(Ordering::SeqCst) {
                    return;
                }
            }
            let shows = seen.map(|s| tail(&s.lock().unwrap())).unwrap_or_default();
            say(&format!(
                "{label}: not within {limit:?}; the terminal shows:\n{shows}"
            ));
            #[cfg(unix)]
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid])
                .status();
            #[cfg(windows)]
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/PID", &pid])
                .status();
        }
    });
    w.until(what, ready);
    done.store(true, Ordering::SeqCst);
    say(&format!("{what} ({:.1} s)", start.elapsed().as_secs_f32()));
}

/// The last of what a terminal showed.
fn tail(bytes: &[u8]) -> String {
    let text = plain(bytes);
    let start = text.len().saturating_sub(1500);
    let start = (start..text.len())
        .find(|&i| text.is_char_boundary(i))
        .unwrap_or(text.len());
    text[start..].to_owned()
}

/// The scene of a live test: a core, a device following every record, the
/// throwaway project, no hold.
struct Live {
    core: Core,
    w: Watch,
    project: tasktap_proto::ProjectId,
    _data: Folder,
}

impl Live {
    fn new(prefix: &str) -> Live {
        let folder = project();
        let data = Folder::new(prefix);
        let core = Core::live(&data.0, PATIENCE);
        let mut w = core.watch();
        patient(&mut w.c);
        let add = tasktap_proto::AddProject {
            id: tasktap_proto::ProjectId::mint(),
            folder: folder.to_str().unwrap().into(),
            name: None,
        };
        let project = w.ok::<call::ProjectAdd>(&add);
        let target = PutTarget::Prefs(PrefPatch::Hold(0));
        w.ok::<call::Put>(&Put {
            target,
            if_rev: None,
        });
        Live {
            core,
            w,
            project,
            _data: data,
        }
    }

    /// Captures a new run of `agent` in the project.
    fn ask(&mut self, agent: &str, text: &str) -> ThoughtId {
        let id = ThoughtId::mint();
        let capture = Capture {
            project_id: Some(self.project),
            agent: Some(agent.into()),
            ..typed(id, text)
        };
        self.w.ok::<call::ThoughtCapture>(&capture);
        say(&format!("captured a thought for {agent}: {text:?}"));
        id
    }

    /// Captures a follow-up to `session`.
    fn nudge(&mut self, session: SessionId, text: &str) -> ThoughtId {
        let id = ThoughtId::mint();
        let capture = Capture {
            mode: Some(Mode::Nudge),
            session_id: Some(session),
            ..typed(id, text)
        };
        self.w.ok::<call::ThoughtCapture>(&capture);
        say(&format!("captured a follow-up to its session: {text:?}"));
        id
    }

    /// The session a thought started, once its terminal runs, and a client on that terminal.
    fn started(&mut self, t: ThoughtId) -> (SessionId, Tty) {
        until(
            &self.core,
            &mut self.w,
            None,
            "the run started in a terminal",
            Duration::from_secs(60),
            |m| {
                let s = m.thoughts.get(&t).and_then(|t| t.session_id);
                s.and_then(|s| m.sessions.get(&s))
                    .is_some_and(|s| s.terminal_id.is_some())
                    || m.thoughts
                        .get(&t)
                        .is_some_and(|t| t.status == Status::Failed)
            },
        );
        let th = self.w.model.thought(t).clone();
        assert_ne!(
            th.status,
            Status::Failed,
            "the run failed: {:?}",
            self.w.model.results_of(t)
        );
        let session = th.session_id.unwrap();
        let terminal = self.w.model.session(session).terminal_id.unwrap();
        say(&format!(
            "terminal argv: {}",
            shown(&self.w.model.terminals[&terminal].argv)
        ));
        (session, Tty::attach(&self.core, terminal))
    }

    /// Follows a thought to done and returns its result.
    fn done(&mut self, t: ThoughtId, tty: &Tty) -> String {
        until(
            &self.core,
            &mut self.w,
            Some(tty),
            "the thought is done",
            Duration::from_secs(150),
            |m| matches!(m.status(t), Status::Done | Status::Failed),
        );
        let results = self.w.model.results_of(t);
        assert_eq!(self.w.model.status(t), Status::Done, "{results:?}");
        assert_eq!(results.len(), 1, "one result, tied to the thought");
        let summary = results[0].summary.clone();
        say(&format!(
            "result: {summary:?}; statuses {:?}",
            self.w.statuses[&t]
        ));
        summary
    }

    /// Ends a session's agent, as closing it would.
    fn end(&mut self, session: SessionId, tty: &Tty) {
        let terminal = self.w.model.session(session).terminal_id.unwrap();
        self.w.ok::<call::TerminalStop>(&Ref { id: terminal });
        until(
            &self.core,
            &mut self.w,
            Some(tty),
            "the session ended",
            Duration::from_secs(30),
            |m| m.session(session).state == SessionState::Ended,
        );
    }

    /// The question glance shows, once one opens.
    fn question(&mut self, tty: &Tty) -> QuestionId {
        until(
            &self.core,
            &mut self.w,
            Some(tty),
            "a question opened",
            Duration::from_secs(150),
            |m| m.glance().question.is_some(),
        );
        self.w.model.glance().question.unwrap()
    }
}

/// A client that waits as long as a turn takes: the tests' connections
/// give up after 20 s without a frame.
fn patient(c: &mut tasktap_core::client::Client) {
    #[cfg(unix)]
    c.stream().set_read_timeout(None).unwrap();
    #[cfg(not(unix))]
    let _ = c;
}

/// An argument list, with long arguments cut, for the log.
fn shown(argv: &[String]) -> String {
    let cut = |a: &String| match a.chars().count() > 60 {
        true => format!("{}…", a.chars().take(57).collect::<String>()),
        false => a.clone(),
    };
    argv.iter().map(cut).collect::<Vec<_>>().join(" ")
}

#[test]
#[ignore = "runs Claude Code for three turns on this computer's subscription"]
fn claude_runs_asks_follows_up_and_resumes() {
    let mut s = Live::new("live-claude");
    // A new run; its question is answered from the core (the trial).
    let t = s.ask(
        "claude",
        "Use the AskUserQuestion tool to ask me which of two colors I prefer, Red or Blue. \
         Then reply with only the color I picked.",
    );
    let (session, tty) = s.started(t);
    let q = s.question(&tty);
    let asked = s.w.model.question(q).clone();
    say(&format!(
        "question: {:?} {:?} via {:?}",
        asked.prompt, asked.kind, asked.reply_via
    ));
    assert_eq!(asked.reply_via, ReplyVia::Core);
    let QuestionKind::Choice { choices } = &asked.kind else {
        panic!("a choice: {asked:?}")
    };
    let blue = choices
        .iter()
        .position(|c| c == "Blue")
        .expect("Blue is a choice") as u32;
    let answer = AnswerQuestion {
        id: q,
        response: Response::Choice { choice: blue },
    };
    s.w.ok::<call::QuestionAnswer>(&answer);
    say("answered Blue from the core");
    let result = s.done(t, &tty);
    assert!(result.contains("Blue"), "{result}");
    let receipt = s.w.model.question(q).answer.clone().unwrap();
    assert!(receipt.delivered.is_some(), "the hook confirmed the answer");
    let handle = s.w.model.session(session).resume.clone();
    say(&format!("resume handle: {handle:?}"));
    assert_eq!(handle, Some(session.uuid().to_string()), "the id is ours");

    // A follow-up typed into the live session; its question is answered
    // in the terminal, as a person at the terminal would.
    // Its dialog's foot, which the follow-up's own text does not have.
    tty.when("Enter to select", b"\r");
    let f = s.nudge(
        session,
        "Use the AskUserQuestion tool to ask me which way, Up or Down. \
         Then reply with only the way I picked.",
    );
    let q2 = s.question(&tty);
    let asked = s.w.model.question(q2).clone();
    say(&format!(
        "question: {:?} via {:?}; answering it in the terminal",
        asked.prompt, asked.reply_via
    ));
    let result = s.done(f, &tty);
    let q2 = s.w.model.question(q2).clone();
    say(&format!(
        "the question answered in the terminal ended {:?}",
        q2.state
    ));
    assert_ne!(q2.state, QuestionState::Open);
    assert!(result.contains("Up"), "{result}");

    // The session ends; a follow-up resumes its conversation in a new run.
    s.end(session, &tty);
    let r = s.nudge(
        session,
        "Reply with the single word resumed. Do not use any tools.",
    );
    let (again, tty) = s.started(r);
    assert_ne!(again, session, "a resume is a new session");
    let result = s.done(r, &tty);
    assert!(result.to_lowercase().contains("resumed"), "{result}");
    assert_eq!(
        s.w.model.session(again).resume,
        handle,
        "the same conversation"
    );
    s.end(again, &tty);
    s.core.stop();
}

#[test]
#[ignore = "runs Codex for three turns on this computer's subscription"]
fn codex_runs_follows_up_and_resumes() {
    let mut s = Live::new("live-codex");
    let t = s.ask(
        "codex",
        "Reply with the single word ready. Do not use any tools.",
    );
    let (session, tty) = s.started(t);
    until(
        &s.core,
        &mut s.w,
        Some(&tty),
        "the session is ready or working",
        Duration::from_secs(120),
        |m| m.session(session).state != SessionState::Starting,
    );
    let result = s.done(t, &tty);
    assert!(result.to_lowercase().contains("ready"), "{result}");
    let handle = s.w.model.session(session).resume.clone();
    say(&format!("resume handle (the thread id): {handle:?}"));
    assert!(handle.is_some());

    let f = s.nudge(
        session,
        "Reply with the single word again. Do not use any tools.",
    );
    let result = s.done(f, &tty);
    assert!(result.to_lowercase().contains("again"), "{result}");

    s.end(session, &tty);
    let r = s.nudge(
        session,
        "Reply with the single word resumed. Do not use any tools.",
    );
    let (again, tty) = s.started(r);
    let result = s.done(r, &tty);
    assert!(result.to_lowercase().contains("resumed"), "{result}");
    assert_eq!(s.w.model.session(again).resume, handle, "the same thread");
    s.end(again, &tty);
    s.core.stop();
}

/// A Codex run that no window shows (design §9): the core answers what
/// Codex asks its terminal when it starts, so it starts, takes its prompt
/// and finishes, all before any client attaches.
#[test]
#[ignore = "runs Codex for one turn on this computer's subscription"]
fn codex_runs_with_no_window() {
    let mut s = Live::new("live-codex-alone");
    let t = s.ask(
        "codex",
        "Reply with the single word alone. Do not use any tools.",
    );
    until(
        &s.core,
        &mut s.w,
        None,
        "the thought is done, with no client attached",
        Duration::from_secs(150),
        |m| matches!(m.status(t), Status::Done | Status::Failed),
    );
    let results = s.w.model.results_of(t);
    assert_eq!(s.w.model.status(t), Status::Done, "{results:?}");
    let summary = results[0].summary.clone();
    say(&format!(
        "result: {summary:?}; statuses {:?}",
        s.w.statuses[&t]
    ));
    assert!(summary.to_lowercase().contains("alone"), "{summary}");
    let session = s.w.model.thought(t).session_id.unwrap();
    let terminal = s.w.model.session(session).terminal_id.unwrap();
    let tty = Tty::attach(&s.core, terminal);
    s.end(session, &tty);
    s.core.stop();
}

/// The loop check (design §13, `tests/loop.rs`) with Claude Code as its
/// agent: a device captures a thought, the fixture router sends it on, the
/// hold passes, Claude Code runs in the terminal the real launcher started,
/// asks through its hook, gets the device's answer from the core and
/// finishes; then the core crashes and starts again, every record is still
/// there and nothing runs again.
///
/// What a real agent leaves open: whether it asks at all, and how (Claude
/// Code asks with `AskUserQuestion`, a choice, where the fixture asks a
/// confirm question), and the words of its answer. The test answers the
/// choice that says yes and checks the answer contains the words asked for;
/// the statuses, the result tied to the thought, the delivered receipt and
/// the restart are asserted as in the loop.
#[test]
#[ignore = "runs Claude Code for one turn on this computer's subscription"]
fn the_loop_on_claude() {
    use Status::{Captured, Done, NeedsYou, Routed, Working};
    let folder = project();
    let data = Folder::new("live-loop");
    let core = Core::live(&data.0, PATIENCE);
    let mut s = Scene::in_folder(core, data, &folder, "claude");
    patient(&mut s.w.c);
    // The fixture router's brief is what the run is asked.
    let brief = "Use the AskUserQuestion tool to ask me whether to deploy to staging, with the \
                 options Yes and No. Then reply with exactly: Deployed to staging. \
                 Do not use any other tool.";
    let route = tasktap_proto::Route::Clear {
        to: tasktap_proto::Place::Project(s.project),
        brief: brief.into(),
    };
    s.script(route, None);
    let t = s.capture("deploy to staging once I say so");
    assert_eq!(s.w.model.status(t), Routed);
    s.tick(HOLD_MS);
    let session = s.w.model.thought(t).session_id.unwrap();
    until(
        &s.core,
        &mut s.w,
        None,
        "the run started",
        Duration::from_secs(60),
        |m| m.session(session).terminal_id.is_some(),
    );
    let terminal = s.w.model.session(session).terminal_id.unwrap();
    let tty = Tty::attach(&s.core, terminal);
    until(
        &s.core,
        &mut s.w,
        Some(&tty),
        "the thought needs you",
        Duration::from_secs(150),
        |m| m.status(t) == NeedsYou && m.glance().needs_you == 1,
    );
    let q =
        s.w.model
            .glance()
            .question
            .expect("glance names the question");
    let asked = s.w.model.question(q).clone();
    assert_eq!(
        (asked.thought_id, asked.reply_via),
        (Some(t), ReplyVia::Core)
    );
    let response = match &asked.kind {
        QuestionKind::Choice { choices } => {
            let yes = choices
                .iter()
                .position(|c| c.to_lowercase().starts_with("yes"));
            Response::Choice {
                choice: yes.expect("a choice says yes") as u32,
            }
        }
        _ => Response::Affirm,
    };
    say(&format!(
        "question {:?} {:?}: answering {response:?}",
        asked.prompt, asked.kind
    ));
    s.w.ok::<call::QuestionAnswer>(&AnswerQuestion {
        id: q,
        response: response.clone(),
    });
    until(
        &s.core,
        &mut s.w,
        Some(&tty),
        "the thought is done",
        Duration::from_secs(150),
        |m| m.status(t) == Done,
    );
    s.w.sync();
    let m = &s.w.model;
    assert_eq!(
        s.w.statuses[&t],
        [Captured, Routed, Working, NeedsYou, Working, Done]
    );
    let results = m.results_of(t);
    assert_eq!(results.len(), 1, "one result, tied to the thought");
    assert_eq!(results[0].session_id, Some(session));
    assert!(
        results[0].summary.contains("Deployed to staging"),
        "{:?}",
        results[0]
    );
    say(&format!("result: {:?}", results[0].summary));
    let receipt = m.question(q).answer.clone().expect("the answer is stored");
    assert_eq!(receipt.response, response);
    assert!(
        receipt.delivered.is_some(),
        "the receipt is marked delivered"
    );
    let g = m.glance();
    assert_eq!(
        (g.working, g.needs_you, g.done, g.question),
        (0, 0, 1, None)
    );

    // The core crashes with Claude Code running; every record is still there
    // and nothing runs again.
    let before = s.w.model.clone();
    let Scene { core, data, w, .. } = s;
    drop((w, core));
    let core = Core::live(&data.0, PATIENCE);
    let mut s = Scene::in_folder(core, data, &folder, "claude");
    assert_eq!(s.w.model.stored(), before.stored());
    assert_eq!(s.w.model.status(t), Done);
    s.tick(10 * HOLD_MS);
    s.w.sync();
    let after = &s.w.model;
    assert_eq!(
        after.sessions.len(),
        before.sessions.len(),
        "no new session"
    );
    assert_eq!(
        after.terminals.len(),
        before.terminals.len(),
        "no new terminal"
    );
    assert!(
        after
            .sessions
            .values()
            .all(|s| s.state == SessionState::Ended)
    );
    let status = s.w.ok::<call::CoreStatus>(&tasktap_proto::Empty {});
    assert_eq!(status.terminals, 0, "no terminal runs");
    say("restarted: every record kept, nothing ran again");
    s.core.stop();
}
