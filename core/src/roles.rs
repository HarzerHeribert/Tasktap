//! The roles agents, their hooks and shells run (design §4). Each says what
//! it has to the core with the session token of the terminal it runs in,
//! and exits. They run once per hook event, so they use the blocking client
//! and nothing else: no runtime, no store.
//!
//! | Exit | Meaning |
//! | --- | --- |
//! | 0 | done; for `ask` and a hook that waited, answered |
//! | 1 | the core refused the call, or the connection ended |
//! | 3 | no answer: the question was withdrawn, or its session has ended |
//! | 64 | wrong arguments |
//! | 65 | a hook payload its agent's adapter cannot read; nothing was sent |
//! | 69 | no core could be reached or started, or it did not answer in time |
//! | 77 | the core refused the session token, or it is not one |
//! | 78 | no session token: not run in a Tasktap terminal |
//!
//! None is 2, which Claude Code reads as a hook blocking its tool.

pub mod shim;

#[cfg(feature = "fixtures")]
pub mod fixture;

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use serde_json::{Value, json};
use tasktap_proto::call::{self, Code};
use tasktap_proto::{
    Answer, Ask, AskKey, Auth, Hello, QuestionKind, Response, Role, Secret, SessionEvent, Uuid,
    VERSION, Versions,
};

use crate::agents::{self, Heard};
use crate::client::{self, Client};

pub const FAILED: u8 = 1;
pub const WITHDRAWN: u8 = 3;
pub const USAGE: u8 = 64;
pub const MALFORMED: u8 = 65;
pub const UNREACHABLE: u8 = 69;
pub const REFUSED: u8 = 77;
pub const OUTSIDE: u8 = 78;

/// Where the core is: `<data>/core.sock`, on Windows too, where the pipe's
/// name is made from the folder.
pub const SOCKET: &str = "TASKTAP_SOCKET";
/// The terminal's session token, 64 hex digits.
pub const TOKEN: &str = "TASKTAP_TOKEN";

/// Longest a role waits for the core before it gives up: a hook never
/// holds up its agent.
pub const WAIT: Duration = Duration::from_secs(5);

/// The largest hook payload read; a tool's whole input may be in it.
const MAX_PAYLOAD: u64 = 16 << 20;
/// How much of the end of an agent's own file a hook reads.
const MAX_END: u64 = 1 << 20;
/// How often it reads it, an eighth of a second apart, until what an event
/// needs is there.
const READS: u32 = 8;

/// What the core puts in the environment of each terminal it starts.
pub fn environment(data: &Path, token: &Secret) -> [(&'static str, OsString); 2] {
    let token = serde_json::to_value(token).ok();
    let token = token.and_then(|t| t.as_str().map(Into::into));
    [
        (SOCKET, data.join("core.sock").into()),
        (TOKEN, token.unwrap_or_default()),
    ]
}

/// Why a role stopped: its exit code and the line it prints.
pub struct Fail(pub u8, pub String);

pub fn exit(result: Result<(), Fail>) -> ExitCode {
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(Fail(code, why)) => {
            let _ = writeln!(io::stderr(), "tasktap: {why}");
            ExitCode::from(code)
        }
    }
}

/// `tasktap event <kind> [TEXT] [--id ID] [--turn N] [--subagent]`, and for
/// a question also `[--request KEY] [--detail TEXT] [--choice TEXT]... [--text]`.
/// `continued`'s text is the key of the waited question it settles.
pub fn event(args: Vec<OsString>) -> ExitCode {
    exit(described(args).and_then(|event| {
        let _bound = Bound::new(UNREACHABLE.into());
        report(&mut session("event", Vec::new())?, &event)
    }))
}

/// `tasktap hook <agent> [ARG]...`, with the agent's payload on standard input.
pub fn hook(args: Vec<OsString>) -> ExitCode {
    exit((|| {
        let args = words(args)?;
        let Some((agent, args)) = args.split_first() else {
            return Err(usage("hook <agent>"));
        };
        let agent = agents::find(agent)
            .ok_or_else(|| Fail(USAGE, format!("no agent is called {agent}")))?;
        // Its agent writes the payload and closes the pipe; one that does
        // not is bounded like everything else.
        let bound = Bound::new(UNREACHABLE.into());
        let mut payload = Vec::new();
        let read = io::stdin().take(MAX_PAYLOAD + 1).read_to_end(&mut payload);
        let malformed = |why: String| Fail(MALFORMED, format!("{} hook: {why}", agent.id()));
        match read {
            Err(e) => return Err(malformed(e.to_string())),
            Ok(n) if n as u64 > MAX_PAYLOAD => {
                return Err(malformed("the payload is too large".into()));
            }
            Ok(_) => {}
        }
        match agent.event(args, &payload).map_err(malformed)? {
            None => Ok(()),
            Some(Heard::Event(event)) => report(&mut session("hook", Vec::new())?, &event),
            Some(Heard::Read { event, files, fill }) => {
                // Its agent may still be writing the step the event is about.
                let mut filled = None;
                for again in 0..READS {
                    let Some(end) = files.iter().find_map(|file| end_of(file)) else {
                        break;
                    };
                    filled = fill(&event, &end);
                    if filled.is_some() || again + 1 == READS {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(125));
                }
                report(&mut session("hook", Vec::new())?, &filled.unwrap_or(event))
            }
            Some(Heard::Wait(ask)) => {
                let mut c = session("hook", Vec::new())?;
                drop(bound);
                let answer = waited(&mut c, &ask)?;
                let reply = agent.reply(args, &payload, &answer);
                deliver(&mut c, &ask.request, reply.as_deref())
            }
        }
    })())
}

/// The end of a file an agent keeps, as text: at most [`MAX_END`] of it,
/// from the start of a line. None when it cannot be read.
fn end_of(file: &Path) -> Option<String> {
    use std::io::{Seek, SeekFrom};
    let mut file = std::fs::File::open(file).ok()?;
    let from = file.metadata().ok()?.len().saturating_sub(MAX_END);
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut end = Vec::new();
    file.take(MAX_END).read_to_end(&mut end).ok()?;
    let text = String::from_utf8_lossy(&end);
    let whole = match from {
        0 => &text[..],
        _ => text.split_once('\n').map_or("", |(_, rest)| rest),
    };
    Some(whole.to_owned())
}

/// `tasktap ask [--request KEY] [--detail TEXT] [--choice TEXT]... [--text]
/// [PROMPT...]`; without a prompt, standard input's first line is the prompt
/// and the rest the detail. Prints the answer: `yes` or `no`, the choice, or
/// the text.
pub fn ask(args: Vec<OsString>) -> ExitCode {
    exit((|| {
        let mut flags = Flags::parse(args, &["--text"])?;
        let mut prompt = flags.words.join(" ");
        if prompt.is_empty() {
            let mut input = String::new();
            let read = io::stdin().take(MAX_PAYLOAD).read_to_string(&mut input);
            read.map_err(|e| Fail(USAGE, format!("the question could not be read: {e}")))?;
            let (first, rest) = input.trim().split_once('\n').unwrap_or((input.trim(), ""));
            prompt = first.trim().into();
            if !rest.trim().is_empty() && !flags.has("--detail") {
                flags.pairs.push(("--detail".into(), rest.trim().into()));
            }
        }
        if prompt.is_empty() {
            return Err(usage("ask [PROMPT...]"));
        }
        let ask = flags.ask(prompt)?;
        flags.done()?;
        let bound = Bound::new(UNREACHABLE.into());
        let mut c = session("ask", Vec::new())?;
        drop(bound);
        let answer = waited(&mut c, &ask)?;
        let choices = match &ask.kind {
            QuestionKind::Choice { choices } => choices.as_slice(),
            _ => &[],
        };
        deliver(&mut c, &ask.request, Some(&said(&answer, choices)))
    })())
}

/// An answer as an agent reads it: `yes` or `no`, the choice's text, or the
/// text given.
pub fn said(answer: &Answer, choices: &[String]) -> String {
    match &answer.response {
        Response::Affirm => "yes".into(),
        Response::Deny => "no".into(),
        Response::Choice { choice } => {
            (choices.get(*choice as usize).cloned()).unwrap_or_else(|| choice.to_string())
        }
        Response::Text { text } => text.clone(),
        Response::Terminal => "answered in the terminal".into(),
    }
}

/// A connection with the session token of the terminal this runs in.
pub fn session(role: &str, abilities: Vec<String>) -> Result<Client, Fail> {
    let outside = |name| {
        Fail(
            OUTSIDE,
            format!("{name} is not set: this runs in a Tasktap terminal"),
        )
    };
    let socket = std::env::var_os(SOCKET).ok_or_else(|| outside(SOCKET))?;
    let token = std::env::var_os(TOKEN).ok_or_else(|| outside(TOKEN))?;
    let not_token = || Fail(REFUSED, format!("{TOKEN} is not a session token"));
    let token = token.into_string().map_err(|_| not_token())?;
    let token: Secret = serde_json::from_value(Value::String(token)).map_err(|_| not_token())?;
    let data = Path::new(&socket).parent().unwrap_or(Path::new(""));
    let exe = program()
        .map_err(|e| Fail(UNREACHABLE, format!("this program cannot find itself: {e}")))?;
    #[cfg_attr(not(feature = "fixtures"), allow(unused_mut))]
    let mut serve = client::serve_command(&exe, data);
    // The tests' way to have a core a role starts know their token.
    #[cfg(feature = "fixtures")]
    if let Some(extra) = std::env::var_os("TASKTAP_FIXTURE_SERVE") {
        serve.args(extra.to_string_lossy().split_whitespace());
    }
    let hello = Hello {
        v: Versions(VERSION, VERSION),
        role: Role::Cli,
        client: format!("tasktap {role}"),
        auth: Some(Auth::Session { token }),
        abilities,
    };
    match client::admit(serve, data, hello) {
        Ok(Ok(c)) => Ok(c),
        Ok(Err(_)) => Err(Fail(
            REFUSED,
            "the core refused this terminal's session token".into(),
        )),
        Err(e) => Err(Fail(
            UNREACHABLE,
            format!("no core could be reached at {}: {e}", data.display()),
        )),
    }
}

/// `tasktap preview <file or address>`: shows a file, or a web address of
/// this machine, beside the terminal it is run in (design §9, "Previews").
/// An agent says so what it made; what may be shown is the core's to
/// decide, and its refusal is printed.
pub fn preview(args: Vec<OsString>) -> ExitCode {
    exit((|| {
        let words = words(args)?;
        let [target] = words.as_slice() else {
            return Err(usage("preview <file or web address of this machine>"));
        };
        let cwd = std::env::current_dir().ok();
        let open = tasktap_proto::OpenPreview {
            terminal: None,
            target: target.clone(),
            cwd: cwd.and_then(|cwd| cwd.into_os_string().into_string().ok()),
        };
        let _bound = Bound::new(UNREACHABLE.into());
        match session("preview", Vec::new())?.call::<call::PreviewOpen>(&open) {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(Fail(FAILED, e.message)),
            Err(e) => Err(ended(e)),
        }
    })())
}

/// This program under its own name. A shim is it named after an agent, so
/// running it under that name would run the shim again: the shim folder
/// holds it as `tasktap` too.
pub fn program() -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let own = exe.with_file_name(format!("tasktap{}", std::env::consts::EXE_SUFFIX));
    Ok(if own.is_file() { own } else { exe })
}

/// Sends one `session.event`.
pub fn report(c: &mut Client, event: &SessionEvent) -> Result<(), Fail> {
    match c.call::<call::SessionEvent>(event) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(Fail(
            FAILED,
            format!("the core refused the event: {}", e.message),
        )),
        Err(e) => Err(ended(e)),
    }
}

/// Asks and waits for the answer, for as long as the connection lasts: the
/// core withdraws the question when this process ends.
fn waited(c: &mut Client, ask: &Ask) -> Result<Answer, Fail> {
    match c.call::<call::QuestionAsk>(ask) {
        Ok(Ok(answer)) => Ok(answer),
        Ok(Err(e)) if e.code == Code::Gone => Err(Fail(WITHDRAWN, e.message)),
        Ok(Err(e)) => Err(Fail(
            FAILED,
            format!("the core refused the question: {}", e.message),
        )),
        Err(e) => Err(ended(e)),
    }
}

/// Prints the answer and then confirms it arrived; an answer that could not
/// be printed is not confirmed.
fn deliver(c: &mut Client, request: &str, text: Option<&str>) -> Result<(), Fail> {
    if let Some(text) = text {
        let mut out = io::stdout().lock();
        let printed = writeln!(out, "{text}").and_then(|()| out.flush());
        printed.map_err(|e| Fail(FAILED, format!("the answer could not be printed: {e}")))?;
    }
    // The answer is out: a receipt that does not come back changes nothing for the agent.
    let _bound = Bound::new(0);
    let key = AskKey {
        request: request.into(),
    };
    if let Ok(Err(e)) = c.call::<call::QuestionReceived>(&key) {
        let _ = writeln!(
            io::stderr(),
            "tasktap: the answer's receipt was refused: {}",
            e.message
        );
    }
    Ok(())
}

fn ended(e: io::Error) -> Fail {
    Fail(FAILED, format!("the connection to the core ended: {e}"))
}

fn usage(what: &str) -> Fail {
    Fail(USAGE, format!("usage: tasktap {what}"))
}

fn words(args: Vec<OsString>) -> Result<Vec<String>, Fail> {
    let text = |a: OsString| {
        a.into_string()
            .map_err(|_| Fail(USAGE, "an argument is not text".into()))
    };
    args.into_iter().map(text).collect()
}

/// `event`'s arguments as the `session.event` they describe.
fn described(args: Vec<OsString>) -> Result<SessionEvent, Fail> {
    let mut flags = Flags::parse(args, &["--subagent", "--text"])?;
    let (kind, text) = match flags.words.as_slice() {
        [kind] => (kind.clone(), None),
        [kind, text @ ..] => (kind.clone(), Some(text.join(" "))),
        [] => return Err(usage("event <kind> [TEXT]")),
    };
    let id = flags
        .take("--id")
        .unwrap_or_else(|| Uuid::now_v7().to_string());
    let mut event = json!({ "id": id, "kind": kind });
    if let Some(turn) = flags.take("--turn") {
        let turn = turn
            .parse::<u32>()
            .map_err(|_| Fail(USAGE, "--turn takes a number".into()))?;
        event["turn"] = turn.into();
    }
    event["subagent"] = flags.has("--subagent").into();
    let field = match kind.as_str() {
        "turn_started" => "prompt",
        "activity" => "text",
        "turn_finished" => "answer",
        "turn_failed" => "error",
        "question" => "question",
        "continued" => "request",
        "exited" => "code",
        _ => "",
    };
    match (field, text) {
        ("question", Some(prompt)) => event[field] = json!(flags.ask(prompt)?),
        ("code", Some(code)) => {
            let code = code
                .parse::<u32>()
                .map_err(|_| Fail(USAGE, "exited takes a number".into()))?;
            event[field] = code.into();
        }
        ("", Some(_)) => return Err(Fail(USAGE, format!("event {kind} takes no text"))),
        (field, Some(text)) => event[field] = text.into(),
        (_, None) => {}
    }
    flags.done()?;
    serde_json::from_value(event).map_err(|e| Fail(USAGE, format!("event {kind}: {e}")))
}

/// `--name value` pairs, switches and the words between them.
struct Flags {
    words: Vec<String>,
    pairs: Vec<(String, String)>,
    switches: Vec<String>,
}

impl Flags {
    fn parse(args: Vec<OsString>, switches: &[&str]) -> Result<Flags, Fail> {
        let mut flags = Flags {
            words: Vec::new(),
            pairs: Vec::new(),
            switches: Vec::new(),
        };
        let mut args = words(args)?.into_iter();
        while let Some(arg) = args.next() {
            if arg == "--" {
                flags.words.extend(args.by_ref());
            } else if switches.contains(&arg.as_str()) {
                flags.switches.push(arg);
            } else if arg.starts_with("--") {
                let value = args
                    .next()
                    .ok_or_else(|| Fail(USAGE, format!("{arg} needs a value")))?;
                flags.pairs.push((arg, value));
            } else {
                flags.words.push(arg);
            }
        }
        Ok(flags)
    }

    fn take(&mut self, name: &str) -> Option<String> {
        let at = self.pairs.iter().position(|(n, _)| n == name)?;
        Some(self.pairs.remove(at).1)
    }

    fn has(&self, name: &str) -> bool {
        self.switches.iter().any(|s| s == name) || self.pairs.iter().any(|(n, _)| n == name)
    }

    /// The question these flags describe, under its key or a new one.
    fn ask(&mut self, prompt: String) -> Result<Ask, Fail> {
        let mut choices = Vec::new();
        while let Some(choice) = self.take("--choice") {
            choices.push(choice);
        }
        let kind = match (choices.is_empty(), self.has("--text")) {
            (false, false) => QuestionKind::Choice { choices },
            (true, true) => QuestionKind::Text,
            (true, false) => QuestionKind::Confirm,
            (false, true) => {
                return Err(Fail(USAGE, "a question has choices or takes text".into()));
            }
        };
        let ask = json!({
            "request": self.take("--request").unwrap_or_else(|| Uuid::now_v7().to_string()),
            "prompt": prompt,
            "detail": self.take("--detail"),
        });
        let mut ask: Value = ask;
        if let (Value::Object(fields), Ok(Value::Object(kind))) =
            (&mut ask, serde_json::to_value(kind))
        {
            fields.extend(kind);
        }
        // Through the protocol's own checks, so a prompt too long fails here.
        serde_json::from_value(ask).map_err(|e| Fail(USAGE, format!("the question: {e}")))
    }

    /// Fails on a flag nothing took.
    fn done(&self) -> Result<(), Fail> {
        match self.pairs.first() {
            Some((name, _)) => Err(Fail(USAGE, format!("{name} is not known here"))),
            None => Ok(()),
        }
    }
}

/// Ends this process with `code` unless dropped within [`WAIT`]: whatever
/// a role waits for, a lock, the core or its agent's pipe, it never waits
/// longer. Dropping it ends the thread that keeps the time.
pub struct Bound(#[allow(dead_code)] mpsc::Sender<()>);

impl Bound {
    pub fn new(code: i32) -> Bound {
        let (armed, disarmed) = mpsc::channel::<()>();
        std::thread::spawn(move || {
            if disarmed.recv_timeout(WAIT) == Err(RecvTimeoutError::Timeout) {
                let secs = WAIT.as_secs();
                let _ = writeln!(
                    io::stderr(),
                    "tasktap: the core did not answer within {secs} s"
                );
                std::process::exit(code);
            }
        });
        Bound(armed)
    }
}
