//! Live runs of the real agents through the core (design §14 D). Every test
//! here is ignored by default: each runs a real agent, signed in on
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
    repository(folder)
}

/// A new git repository at `folder`, made anew.
fn repository(folder: PathBuf) -> PathBuf {
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
    let (pid, label) = (core.pid(), what.to_owned());
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
            watchdog::kill(pid);
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
        Self::in_folder(prefix, project())
    }

    /// The same with the project in `folder`.
    fn in_folder(prefix: &str, folder: PathBuf) -> Live {
        let data = Folder::new(prefix);
        let core = Core::live(&data.0, PATIENCE);
        Self::on(core, data, folder)
    }

    /// The same on a core that was started already, as with variables of
    /// its own.
    fn on(core: Core, data: Folder, folder: PathBuf) -> Live {
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

/// Antigravity says what state it is in (design §7): a question it asks is
/// shown and answered in its terminal, its last message is read from its
/// transcript, and its conversation is resumed by the id its state names.
/// Asked of its smallest model, since its default is the person's largest.
#[test]
#[ignore = "runs Antigravity for three turns on this computer's subscription"]
fn antigravity_runs_asks_follows_up_and_resumes() {
    let mut s = Live::new("live-agy");
    let t = ThoughtId::mint();
    let text = "Tasktap test: use your ask_question tool to ask me which of two colors I prefer, \
                red or blue. Then reply with only the color I picked.";
    let capture = Capture {
        project_id: Some(s.project),
        agent: Some("agy".into()),
        model: Some("gemini-3.8-flash-low".into()),
        ..typed(t, text)
    };
    s.w.ok::<call::ThoughtCapture>(&capture);
    say(&format!("captured a thought for agy: {text:?}"));
    let (session, tty) = s.started(t);
    // Its dialog's foot: Return takes the first option.
    tty.when("enter Select", b"\r");
    let q = s.question(&tty);
    let asked = s.w.model.question(q).clone();
    say(&format!(
        "question: {:?} {:?} via {:?}; answering it in the terminal",
        asked.prompt, asked.kind, asked.reply_via
    ));
    assert_eq!(asked.reply_via, ReplyVia::Terminal);
    let result = s.done(t, &tty);
    let q = s.w.model.question(q).clone();
    say(&format!("the question ended {:?}", q.state));
    assert_ne!(q.state, QuestionState::Open);
    assert!(result.to_lowercase().contains("red"), "{result}");
    let handle = s.w.model.session(session).resume.clone();
    say(&format!("resume handle (the conversation id): {handle:?}"));
    assert!(handle.is_some());

    let f = s.nudge(
        session,
        "Tasktap test: now say only this word and nothing else: followed",
    );
    let result = s.done(f, &tty);
    assert!(result.to_lowercase().contains("followed"), "{result}");

    s.end(session, &tty);
    let r = s.nudge(
        session,
        "Tasktap test: now say only this word and nothing else: resumed",
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

/// A tool with which the model asks the person, as an extension of the
/// person's own may add one. Pi has none itself, so its live run is given
/// this one, in a Pi folder of its own.
const PI_ASKS: &str = r#"import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "ask_person",
    label: "Ask",
    description: "Ask the person one question with a few options and get their choice.",
    parameters: Type.Object({ question: Type.String(), options: Type.Array(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const choice = await ctx.ui.select(params.question, params.options);
      return { content: [{ type: "text", text: choice ?? "(no answer)" }], details: {} };
    },
  });
}
"#;

/// Pi runs on whichever provider the person signed it in with, so the run
/// names its model (`TASKTAP_LIVE_PI_MODEL`, as `provider/model`) and is
/// signed in by that provider's key in this test's environment, which the
/// core passes on. Its core has a home of its own: Pi keeps its sessions
/// and settings there, and reads none of the person's settings, extensions
/// or skills, whose names it would send to the provider.
#[test]
#[ignore = "runs Pi for three turns on a key of this test's environment"]
fn pi_runs_asks_follows_up_and_resumes() {
    let model = std::env::var("TASKTAP_LIVE_PI_MODEL")
        .expect("TASKTAP_LIVE_PI_MODEL names the model, as provider/model");
    let home = Folder::new("live-pi-home");
    let extensions = home.0.join(".pi/agent/extensions");
    std::fs::create_dir_all(&extensions).unwrap();
    std::fs::write(extensions.join("ask.ts"), PI_ASKS).unwrap();
    let data = Folder::new("live-pi");
    let env = [("HOME", home.0.to_str().unwrap())];
    let core = Core::start_patient(&data.0, &[], &env, PATIENCE);
    let folder = project();
    let mut s = Live::on(core, data, folder.clone());

    let t = ThoughtId::mint();
    let text = "Tasktap test: use the ask_person tool to ask me 'Tea or coffee?' with the options \
                Tea and Coffee. Then reply with only my choice.";
    let capture = Capture {
        project_id: Some(s.project),
        agent: Some("pi".into()),
        model: Some(model.clone()),
        ..typed(t, text)
    };
    s.w.ok::<call::ThoughtCapture>(&capture);
    say(&format!("captured a thought for pi on {model}: {text:?}"));
    let (session, tty) = s.started(t);
    // Its dialog's foot: Return takes the first option.
    tty.when("enter select", b"\r");
    let q = s.question(&tty);
    let asked = s.w.model.question(q).clone();
    say(&format!(
        "question: {:?} {:?} via {:?}; answering it in the terminal",
        asked.prompt, asked.kind, asked.reply_via
    ));
    assert_eq!(asked.prompt, "Tea or coffee?");
    assert_eq!(asked.reply_via, ReplyVia::Terminal);
    let result = s.done(t, &tty);
    let q = s.w.model.question(q).clone();
    say(&format!("the question ended {:?}", q.state));
    assert_ne!(q.state, QuestionState::Open);
    assert!(result.to_lowercase().contains("tea"), "{result}");
    let handle = s.w.model.session(session).resume.clone();
    say(&format!("resume handle (Pi's session id): {handle:?}"));
    assert!(handle.is_some());
    // The extension is in Tasktap's folder, and the project got no file.
    assert!(s._data.0.join("agents/pi/tasktap.mjs").is_file());
    let made: Vec<_> = std::fs::read_dir(&folder).unwrap().flatten().collect();
    let names: Vec<_> = made.iter().map(|entry| entry.file_name()).collect();
    assert_eq!(names, [".git"], "nothing is written to the project");

    let f = s.nudge(
        session,
        "Tasktap test: now say only this word and nothing else: followed",
    );
    let result = s.done(f, &tty);
    assert!(result.to_lowercase().contains("followed"), "{result}");

    s.end(session, &tty);
    let r = s.nudge(
        session,
        "Tasktap test: now say only this word and nothing else: resumed",
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

/// A home of its own for a tool that is not the person's: an empty folder
/// with the tool, named by `variable`, on the PATH of its terminals as
/// `program`. Nothing of the person's home is read or written by its runs.
fn own_home(prefix: &str, variable: &str, program: &str) -> Folder {
    let tool = std::env::var(variable)
        .unwrap_or_else(|_| panic!("{variable} names the {program} program to run"));
    let home = Folder::new(prefix);
    let bin = home.0.join(".local/bin");
    std::fs::create_dir_all(&bin).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&tool, bin.join(program)).unwrap();
    #[cfg(not(unix))]
    std::fs::copy(&tool, bin.join(program)).unwrap();
    home
}

/// A thought for `agent` on `model`, captured in the project.
fn ask_on(s: &mut Live, agent: &str, model: Option<&str>, text: &str) -> ThoughtId {
    let id = ThoughtId::mint();
    let capture = Capture {
        project_id: Some(s.project),
        agent: Some(agent.into()),
        model: model.map(Into::into),
        ..typed(id, text)
    };
    s.w.ok::<call::ThoughtCapture>(&capture);
    say(&format!(
        "captured a thought for {agent} on {model:?}: {text:?}"
    ));
    id
}

/// A run of one task, heard through its hooks, and a follow-up that goes on
/// in a new run: what Goose and Crush are (`agents/dialect.rs`). The tool
/// runs in a home of its own on the key in the environment.
fn one_task_and_another(agent: &str, home: &Folder, env: &[(&str, &str)], model: Option<&str>) {
    let data = Folder::new(&format!("live-{agent}"));
    let mut all = vec![("HOME", home.0.to_str().unwrap())];
    all.extend_from_slice(env);
    let core = Core::start_patient(&data.0, &[], &all, PATIENCE);
    let folder = project();
    let mut s = Live::on(core, data, folder.clone());

    let text = format!(
        "Tasktap test: use your shell tool to run the command `echo tasktap-{agent}`, \
         then reply with only this word and nothing else: started"
    );
    let t = ask_on(&mut s, agent, model, &text);
    let (session, tty) = s.started(t);
    let result = s.done(t, &tty);
    assert!(result.to_lowercase().contains("started"), "{result}");
    let ran = s.w.model.session(session).clone();
    say(&format!(
        "activity heard: {:?}; resume handle: {:?}",
        ran.activity, ran.resume
    ));
    assert!(
        (ran.activity.iter()).any(|line| line.to_lowercase().contains("echo")),
        "its use of the shell is heard: {:?}",
        ran.activity
    );
    assert!(ran.resume.is_some());
    // It ends by itself: one task.
    until(
        &s.core,
        &mut s.w,
        Some(&tty),
        "the run ended by itself",
        Duration::from_secs(60),
        |m| m.session(session).state == SessionState::Ended,
    );
    say(&format!("exit: {:?}", s.w.model.session(session).exit));
    assert_eq!(s.w.model.session(session).exit, Some(0));
    // Its hooks are in Tasktap's folder, and the project got no file.
    let made: Vec<_> = std::fs::read_dir(&folder).unwrap().flatten().collect();
    let names: Vec<_> = made.iter().map(|entry| entry.file_name()).collect();
    assert_eq!(names, [".git"], "nothing is written to the project");
    assert!(s._data.0.join("agents").join(agent).is_dir());

    let r = s.nudge(
        session,
        "Tasktap test: what was the word I asked you to reply with before? \
         Reply with only that word and then the word again, as in: word again",
    );
    let (again, tty) = s.started(r);
    assert_ne!(again, session, "a follow-up is a new run");
    let result = s.done(r, &tty);
    assert!(
        result.to_lowercase().contains("started"),
        "it goes on with the same conversation: {result}"
    );
    assert_eq!(
        s.w.model.session(again).resume,
        ran.resume,
        "the same conversation"
    );
    s.core.stop();
}

/// Goose, in a root of Tasktap's: `live-agents.sh` says where its program
/// is (TASKTAP_LIVE_GOOSE) and gives it a provider's key in the environment.
#[test]
#[ignore = "runs Goose for two turns on a key in the environment"]
fn goose_runs_one_task_and_goes_on_in_a_new_run() {
    let home = own_home("live-goose-home", "TASKTAP_LIVE_GOOSE", "goose");
    let provider = std::env::var("GOOSE_PROVIDER").expect("GOOSE_PROVIDER names its provider");
    let model = std::env::var("GOOSE_MODEL").expect("GOOSE_MODEL names its model");
    let env = [
        ("GOOSE_PROVIDER", provider.as_str()),
        ("GOOSE_MODEL", model.as_str()),
        // Never the system's keyring: the key is in the environment.
        ("GOOSE_DISABLE_KEYRING", "1"),
    ];
    one_task_and_another("goose", &home, &env, None);
    // Its own folders are Tasktap's root: the home got none of them.
    assert!(!home.0.join(".config/goose").exists());
    assert!(!home.0.join(".local/share/goose").exists());
}

/// Crush, with a data folder of Tasktap's (TASKTAP_LIVE_CRUSH names its
/// program, TASKTAP_LIVE_CRUSH_MODEL its model as provider/model).
#[test]
#[ignore = "runs Crush for two turns on a key in the environment"]
fn crush_runs_one_task_and_goes_on_in_a_new_run() {
    let home = own_home("live-crush-home", "TASKTAP_LIVE_CRUSH", "crush");
    let model = std::env::var("TASKTAP_LIVE_CRUSH_MODEL")
        .expect("TASKTAP_LIVE_CRUSH_MODEL names the model, as provider/model");
    // The stand-in person's own configuration: no metrics to its maker.
    let config = home.0.join(".config/crush");
    std::fs::create_dir_all(&config).unwrap();
    let own = r#"{"options":{"disable_metrics":true}}"#;
    std::fs::write(config.join("crush.json"), own).unwrap();
    one_task_and_another("crush", &home, &[], Some(&model));
    // The one thing it writes outside Tasktap's folder: its list of projects.
    let projects = home.0.join(".local/share/crush/projects.json");
    say(&format!(
        "its list of projects is there: {}",
        projects.is_file()
    ));
    assert!(!folder_has(&project(), ".crush"));
}

fn folder_has(folder: &std::path::Path, name: &str) -> bool {
    folder.join(name).exists()
}

/// Droid, in its form for one task, with a settings file of Tasktap's
/// merged for the run: the end of its turn is read from its transcript.
/// TASKTAP_LIVE_DROID names its program, TASKTAP_LIVE_DROID_SETTINGS a
/// settings file for the stand-in person's home (a model of their own at
/// the service whose key is in the environment) and TASKTAP_LIVE_DROID_MODEL
/// that model's id.
#[test]
#[ignore = "runs Droid for two turns on a key in the environment"]
fn droid_runs_one_task_and_goes_on_in_a_new_run() {
    let home = own_home("live-droid-home", "TASKTAP_LIVE_DROID", "droid");
    let settings = std::env::var("TASKTAP_LIVE_DROID_SETTINGS")
        .expect("TASKTAP_LIVE_DROID_SETTINGS names a settings file with a model");
    let model = std::env::var("TASKTAP_LIVE_DROID_MODEL")
        .expect("TASKTAP_LIVE_DROID_MODEL names the model's id");
    std::fs::create_dir_all(home.0.join(".factory")).unwrap();
    std::fs::copy(&settings, home.0.join(".factory/settings.json")).unwrap();
    let own = std::fs::read(home.0.join(".factory/settings.json")).unwrap();
    // No sound, no update of itself, never the system's keyring; and a
    // proxy, where the environment names one.
    let proxy = std::env::var("HTTPS_PROXY").ok();
    let mut env = vec![
        ("DROID_DISABLE_SOUNDS", "1"),
        ("FACTORY_DROID_AUTO_UPDATE_ENABLED", "false"),
        ("FACTORY_DISABLE_KEYRING", "1"),
    ];
    env.extend(proxy.as_deref().map(|proxy| ("HTTPS_PROXY", proxy)));
    one_task_and_another("droid", &home, &env, Some(&model));
    // The person's own settings are as they were.
    assert_eq!(
        std::fs::read(home.0.join(".factory/settings.json")).unwrap(),
        own
    );
}

/// Qwen Code, with the settings file of Tasktap's that a variable names: it
/// asks to be let run a command, which is shown and answered in its
/// terminal; a follow-up is typed there; a resume goes on with the same
/// conversation. TASKTAP_LIVE_QWEN names its program, TASKTAP_LIVE_QWEN_MODEL
/// its model; the key and the address of an OpenAI-compatible service are in
/// the environment.
#[test]
#[ignore = "runs Qwen Code for three turns on a key in the environment"]
fn qwen_runs_asks_follows_up_and_resumes() {
    let home = own_home("live-qwen-home", "TASKTAP_LIVE_QWEN", "qwen");
    let model =
        std::env::var("TASKTAP_LIVE_QWEN_MODEL").expect("TASKTAP_LIVE_QWEN_MODEL names the model");
    // The stand-in person's own settings: the service of the key in the
    // environment, asked before a command, and nothing sent to its maker.
    let own = r#"{"$version":4,"security":{"auth":{"selectedType":"openai"}},"tools":{"approvalMode":"default"},"general":{"enableAutoUpdate":false},"privacy":{"usageStatisticsEnabled":false},"telemetry":{"enabled":false},"model":{"catalogRefresh":false},"ui":{"autoModeAcknowledged":true,"enableFollowupSuggestions":false},"memory":{"enableManagedAutoMemory":false,"enableManagedAutoDream":false}}"#;
    std::fs::create_dir_all(home.0.join(".qwen")).unwrap();
    std::fs::write(home.0.join(".qwen/settings.json"), own).unwrap();
    let data = Folder::new("live-qwen");
    let env = [("HOME", home.0.to_str().unwrap())];
    let core = Core::start_patient(&data.0, &[], &env, PATIENCE);
    let folder = project();
    let mut s = Live::on(core, data, folder.clone());

    let text = "Tasktap test: use your shell tool to run the command `touch tasktap-live.txt`, \
                then reply with only this word and nothing else: started";
    let t = ask_on(&mut s, "qwen", Some(&model), text);
    let (session, tty) = s.started(t);
    let q = s.question(&tty);
    let asked = s.w.model.question(q).clone();
    say(&format!(
        "question: {:?} {:?} via {:?}; answering it in the terminal",
        asked.prompt, asked.kind, asked.reply_via
    ));
    assert!(
        asked.prompt.starts_with("Qwen Code asks to run touch"),
        "{}",
        asked.prompt
    );
    assert_eq!(asked.reply_via, ReplyVia::Terminal);
    // Its dialog: the first option allows it once.
    tty.when("allow once", b"\r");
    let result = s.done(t, &tty);
    let q = s.w.model.question(q).clone();
    say(&format!("the question ended {:?}", q.state));
    assert_ne!(q.state, QuestionState::Open);
    assert!(result.to_lowercase().contains("started"), "{result}");
    assert!(folder.join("tasktap-live.txt").is_file(), "the command ran");
    let handle = s.w.model.session(session).resume.clone();
    say(&format!("resume handle (its session id): {handle:?}"));
    assert!(handle.is_some());
    // Its hooks are a file of Tasktap's, as Tasktap wrote it; its own
    // settings are as they were.
    let settings = s._data.0.join("agents/qwen/system-defaults.json");
    let kept = std::fs::read_to_string(&settings).unwrap();
    assert!(kept.starts_with(r#"{"$version":4,"hooks":{"#), "{kept}");
    assert_eq!(
        std::fs::read_to_string(home.0.join(".qwen/settings.json")).unwrap(),
        own
    );

    let f = s.nudge(
        session,
        "Tasktap test: now say only this word and nothing else: followed",
    );
    let result = s.done(f, &tty);
    assert!(result.to_lowercase().contains("followed"), "{result}");

    s.end(session, &tty);
    let r = s.nudge(
        session,
        "Tasktap test: now say only this word and nothing else: resumed",
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

/// OpenCode, with the plugin of Tasktap's in its terminal interface: its
/// question and its approval are answered from the core, and an approval in
/// its terminal settles the one the core shows. The run's own server must
/// ask before a shell command, which `live-agents.sh` tells it for these
/// runs alone (`OPENCODE_CONFIG_CONTENT`), with a model that costs nothing.
#[test]
#[ignore = "runs OpenCode for three turns on this computer's account"]
fn opencode_runs_asks_follows_up_and_resumes() {
    let mut s = Live::new("live-opencode");
    // A new run; its question is answered from the core.
    let t = s.ask(
        "opencode",
        "Tasktap test: use your question tool to ask me which of two colors I prefer, \
         Red or Blue. Then reply with only the color I picked.",
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
    say(&format!("resume handle (the session id): {handle:?}"));
    assert!(handle.as_deref().is_some_and(|h| h.starts_with("ses_")));

    // A follow-up typed into the live session; its approval is given from
    // the core.
    let f = s.nudge(
        session,
        "Tasktap test: run the shell command `echo followed` and reply with only its output.",
    );
    let q2 = s.question(&tty);
    let asked = s.w.model.question(q2).clone();
    say(&format!(
        "approval: {:?} {:?} via {:?}",
        asked.prompt, asked.kind, asked.reply_via
    ));
    assert_eq!(asked.prompt, "OpenCode asks to run echo followed");
    assert_eq!(asked.reply_via, ReplyVia::Core);
    assert_eq!(asked.kind, QuestionKind::Confirm);
    let answer = AnswerQuestion {
        id: q2,
        response: Response::Affirm,
    };
    s.w.ok::<call::QuestionAnswer>(&answer);
    say("approved from the core");
    let result = s.done(f, &tty);
    assert!(result.contains("followed"), "{result}");

    // The session ends; a follow-up resumes its conversation in a new run,
    // whose approval is given in the terminal, as a person there would.
    s.end(session, &tty);
    let r = s.nudge(
        session,
        "Tasktap test: run the shell command `echo resumed` and reply with only its output.",
    );
    let (again, tty) = s.started(r);
    assert_ne!(again, session, "a resume is a new session");
    // Its dialog's foot: Return allows once.
    tty.when("enter confirm", b"\r");
    let q3 = s.question(&tty);
    let result = s.done(r, &tty);
    let q3 = s.w.model.question(q3).clone();
    say(&format!(
        "the approval given in the terminal ended {:?}",
        q3.state
    ));
    assert_ne!(q3.state, QuestionState::Open);
    assert!(result.contains("resumed"), "{result}");
    assert_eq!(
        s.w.model.session(again).resume,
        handle,
        "the same conversation"
    );
    s.end(again, &tty);
    s.core.stop();
}

/// Claude Code in a folder it has not seen stops at its folder-trust dialog
/// before any hook runs (design §7): the core sees the dialog in the
/// terminal and asks the person to answer it there, so the thought does
/// not sit silently working. The dialog is left unanswered and the run
/// stopped, so no turn is used.
#[test]
#[ignore = "starts Claude Code in a folder it has not seen; uses no turn"]
fn claude_in_a_new_folder_asks_to_be_trusted_there() {
    let unique = format!("tasktap-live-trust/{}", ThoughtId::mint().uuid());
    let folder = repository(std::env::temp_dir().join(unique));
    let mut s = Live::in_folder("live-claude-trust", folder.clone());
    let t = s.ask("claude", "Reply with the single word trusted.");
    until(
        &s.core,
        &mut s.w,
        None,
        "a question opened",
        Duration::from_secs(60),
        |m| m.glance().question.is_some(),
    );
    let q =
        s.w.model
            .question(s.w.model.glance().question.unwrap())
            .clone();
    say(&format!(
        "question: {:?}, reply via {:?}",
        q.prompt, q.reply_via
    ));
    assert!(q.prompt.contains("trust"), "{q:?}");
    assert_eq!(q.reply_via, ReplyVia::Terminal);
    assert_eq!(s.w.model.status(t), Status::NeedsYou);
    let session = s.w.model.thought(t).session_id.unwrap();
    assert_eq!(s.w.model.session(session).state, SessionState::Starting);
    let terminal = s.w.model.session(session).terminal_id.unwrap();
    let tty = Tty::attach(&s.core, terminal);
    s.end(session, &tty);
    assert_eq!(s.w.model.question(q.id).state, QuestionState::Withdrawn);
    s.core.stop();
    let _ = std::fs::remove_dir_all(folder);
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
        said: None,
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
