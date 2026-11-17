//! The agents the core knows (design §7): how a run of each starts, what its
//! hooks say in the core's one vocabulary, and what a hook that waited
//! prints for its agent. The hook half runs in `tasktap hook`, so a payload
//! the core would not understand never reaches it; the launcher reads the
//! rest.
//!
//! An adapter is data and small pure functions: `event` and `reply` do no
//! I/O. What must run a program, telling whether an agent is installed and
//! signed in and the check some agents need before a run starts, is
//! described by the adapter and run by [`checks`]. This module and its
//! children are the only place that names an agent; the list below is the
//! registry, and its first entry is the default agent.

pub mod checks;
pub mod claude;
pub mod codex;
pub mod rules;

use std::ffi::OsString;
use std::path::Path;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tasktap_proto::{Answer, Ask, Event, ReplyVia, SessionEvent, SessionId};

/// What one hook says.
#[derive(Debug)]
pub enum Heard {
    /// Reported, and the hook exits.
    Event(SessionEvent),
    /// Asked through the core: the agent lets this hook decide, so it waits
    /// for the answer and prints [`Agent::reply`].
    Wait(Ask),
}

/// What an agent's runs can do, read where the core decides.
#[derive(Clone, Copy, Debug)]
pub struct Caps {
    /// Its runs report through hooks. One that does not finishes its work
    /// by exiting 0 (design §5, `exited`).
    pub events: bool,
    /// A new run can continue the conversation of an ended session, from
    /// the handle its hooks report.
    pub resume: bool,
    /// Where its permission requests are answered: `Core` when a hook may
    /// decide them; none when none are heard.
    pub permissions: Option<ReplyVia>,
    /// Where the questions it asks the person are answered.
    pub questions: Option<ReplyVia>,
}

/// A new run, as the launcher starts it.
pub struct Run<'a> {
    pub session: SessionId,
    /// The folder it runs in.
    pub cwd: &'a Path,
    pub prompt: &'a str,
    pub model: Option<&'a str>,
    /// The agent's handle of the conversation this run continues.
    pub resume: Option<&'a str>,
    /// This program, which the hooks run as `<hook> hook <id>`.
    pub hook: &'a Path,
}

/// How to tell whether an agent is installed and signed in: two of its own
/// commands, run by [`checks::detect`], and how to read what they print.
pub struct Detect {
    /// Arguments with which its program prints its version.
    pub version: &'static [&'static str],
    /// Reads the version from what that printed.
    pub version_of: fn(&str) -> Option<String>,
    /// Arguments with which it says whether it is signed in.
    pub account: &'static [&'static str],
    /// Reads that check's exit code and output: whether it is signed in,
    /// none when that cannot be told, and whom or how.
    pub account_of: AccountOf,
}

/// Reads an account check: whether it is signed in, and whom or how.
pub type AccountOf = fn(Option<i32>, &str) -> (Option<bool>, Option<String>);

/// Reads one line of a probe's output: none to read on, else the end, the
/// arguments it adds or why the run cannot start.
pub type Reader = Box<dyn FnMut(&str) -> Option<Result<Vec<String>, String>> + Send>;

/// A check that must pass before a run starts (design §7), run by
/// [`checks::probe`] on a thread of its own: a program, what is written to
/// its standard input, and how its output becomes more arguments for the
/// run, which go right after the program.
pub struct Probe {
    /// The program, a name looked up on the terminals' PATH, then its arguments.
    pub argv: Vec<String>,
    pub input: String,
    pub read: Reader,
}

pub trait Agent: Sync {
    /// Its name: the shim's program name and the `<agent>` of `tasktap hook`.
    fn id(&self) -> &'static str;

    /// Its program, found on the PATH of the terminals.
    fn program(&self) -> &'static str;

    fn caps(&self) -> Caps;

    /// The command line of a run, new or continuing `run.resume`: first the
    /// program, then its arguments, with the hooks attached as
    /// [`Agent::attach`] does. The core starts it as the terminal's direct
    /// child, with no shell around it.
    fn launch(&self, run: &Run) -> Vec<String>;

    /// Arguments, put before the person's own, with which a run of the agent
    /// calls `<exe> hook <id>` on its hook events.
    fn attach(&self, exe: &Path) -> Vec<OsString>;

    /// The check a run in `cwd` needs before it starts, with its hooks
    /// calling `exe`; none for most agents.
    fn probe(&self, _exe: &Path, _cwd: &Path) -> Option<Probe> {
        None
    }

    fn detect(&self) -> Detect;

    /// Variables of the core's own environment that its runs need, such as
    /// the key a person signs it in with (design §7, §9): the only ones a
    /// terminal gets beyond the fixed list. None for most agents.
    fn variables(&self) -> &'static [&'static str] {
        &[]
    }

    /// What a hook says, from the arguments after `hook <id>` and the
    /// payload on standard input: `None` when nothing the core keeps, `Err`
    /// only when it is no payload at all, which the hook reports and exits.
    fn event(&self, args: &[String], payload: &[u8]) -> Result<Option<Heard>, String>;

    /// What a hook that asked prints for its agent once the answer came;
    /// none prints nothing, which leaves the decision to the agent.
    fn reply(&self, args: &[String], payload: &[u8], answer: &Answer) -> Option<String>;
}

/// The agent named `id`.
pub fn find(id: &str) -> Option<&'static dyn Agent> {
    AGENTS.iter().copied().find(|agent| agent.id() == id)
}

/// Every agent this build has, the default first.
pub fn all() -> &'static [&'static dyn Agent] {
    AGENTS
}

/// The variables every agent declares it needs, each once.
pub fn variables() -> Vec<&'static str> {
    let mut all: Vec<&'static str> = AGENTS.iter().flat_map(|a| a.variables()).copied().collect();
    all.sort_unstable();
    all.dedup();
    all
}

/// The registry: the one list that names agents outside their adapters.
const AGENTS: &[&dyn Agent] = &[
    &claude::Claude,
    &codex::Codex,
    #[cfg(feature = "fixtures")]
    &Fixture {
        events: true,
        probed: false,
    },
    #[cfg(feature = "fixtures")]
    &Fixture {
        events: false,
        probed: false,
    },
    #[cfg(feature = "fixtures")]
    &Fixture {
        events: true,
        probed: true,
    },
];

/// A hook payload: one JSON object.
pub(crate) struct Payload(Map<String, Value>);

impl Payload {
    pub(crate) fn parse(bytes: &[u8]) -> Result<Payload, String> {
        match serde_json::from_slice(bytes) {
            Ok(Value::Object(fields)) => Ok(Payload(fields)),
            Ok(_) => Err("the payload is no JSON object".into()),
            Err(e) => Err(format!("the payload is no JSON: {e}")),
        }
    }

    pub(crate) fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    /// A text field, when it is one and not empty.
    pub(crate) fn str(&self, key: &str) -> Option<&str> {
        self.0.get(key)?.as_str().filter(|s| !s.is_empty())
    }
}

/// A short digest of `parts`, for an id a payload does not carry: the same
/// parts give the same id, so a repeat is still told apart from a new one.
pub(crate) fn digest(parts: &[&[u8]]) -> String {
    let mut h = Sha256::new();
    for part in parts {
        h.update((part.len() as u64).to_be_bytes());
        h.update(part);
    }
    h.finalize()[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `text` cut at a character boundary so that it takes at most `limit`
/// bytes as a JSON string, which is how the protocol bounds a text.
pub(crate) fn fit(text: &str, limit: usize) -> String {
    let json = |s: &str| serde_json::to_string(s).map_or(usize::MAX, |j| j.len());
    let mut end = text.len().min(limit);
    loop {
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let over = json(&text[..end]).saturating_sub(limit);
        if over == 0 {
            return text[..end].to_owned();
        }
        end = end.saturating_sub(over.max(1));
    }
}

/// The first line of `text`, cut to `chars` characters, with an ellipsis
/// when anything was left out.
pub(crate) fn line(text: &str, chars: usize) -> String {
    let first = text.trim().lines().next().unwrap_or_default().trim();
    let cut: String = first.chars().take(chars).collect();
    if cut.len() < text.trim().len() {
        format!("{cut}…")
    } else {
        cut
    }
}

/// A `session.event` from a hook, with the id that makes a repeat ignored.
pub(crate) fn said(id: String, subagent: bool, resume: Option<&str>, event: Event) -> Heard {
    Heard::Event(SessionEvent {
        id,
        turn: None,
        subagent,
        resume: resume.map(|r| fit(r, 256)),
        event,
    })
}

/// The field of a tool's input that says best what it does.
fn gist(input: Option<&Value>) -> Option<&str> {
    let input = input?;
    [
        "description",
        "command",
        "file_path",
        "path",
        "pattern",
        "url",
        "query",
    ]
    .iter()
    .find_map(|key| input.get(key)?.as_str().filter(|s| !s.trim().is_empty()))
}

/// One line of activity for a tool the agent runs: its name and what it does.
pub(crate) fn activity(tool: &str, input: Option<&Value>) -> String {
    match gist(input) {
        Some(what) => line(&format!("{tool}: {}", line(what, 160)), 200),
        None => line(tool, 200),
    }
}

/// A permission request as a confirm question: its prompt and, in its
/// detail, the tool's whole input.
pub(crate) fn permission(agent: &str, request: String, tool: &str, input: Option<&Value>) -> Ask {
    let what = match input.and_then(|i| i.get("command")?.as_str()) {
        Some(command) => format!("run {}", line(command, 200)),
        None => match gist(input) {
            Some(what) => format!("use {tool}: {}", line(what, 200)),
            None => format!("use {tool}"),
        },
    };
    let detail = input.map(|i| serde_json::to_string_pretty(i).unwrap_or_default());
    Ask {
        request,
        kind: tasktap_proto::QuestionKind::Confirm,
        prompt: fit(&format!("{agent} asks to {what}"), 1000),
        detail: detail.map(|d| fit(&d, 16 << 10)),
        source: Some(tasktap_proto::QuestionSource::Permission),
    }
}

/// `exe` quoted for the shell an agent runs its hook commands with.
pub(crate) fn quoted(exe: &Path) -> String {
    let exe = exe.to_string_lossy();
    if cfg!(windows) {
        format!("\"{exe}\"")
    } else {
        format!("'{}'", exe.replace('\'', r"'\''"))
    }
}

/// The stand-in agent of the tests: the program `fixture-agent`, this
/// binary under that name (design §13). As `fixture` its payloads are
/// already in the core's words: a `session.event`'s arguments, and a
/// question with `"wait": true` waits. As `fixture-silent` it has no hooks
/// and reports only by exiting. As `fixture-probed` its runs need a check
/// before they start, which runs `fixture-agent` once and adds `--probed`.
#[cfg(feature = "fixtures")]
struct Fixture {
    events: bool,
    probed: bool,
}

#[cfg(feature = "fixtures")]
impl Fixture {
    fn said(payload: &[u8]) -> Result<(bool, SessionEvent), String> {
        let mut said: serde_json::Value =
            serde_json::from_slice(payload).map_err(|e| e.to_string())?;
        let wait = (said.as_object_mut())
            .and_then(|fields| fields.remove("wait"))
            .is_some_and(|wait| wait == true);
        Ok((
            wait,
            serde_json::from_value(said).map_err(|e| e.to_string())?,
        ))
    }
}

#[cfg(feature = "fixtures")]
impl Agent for Fixture {
    fn id(&self) -> &'static str {
        match (self.events, self.probed) {
            (_, true) => "fixture-probed",
            (true, false) => "fixture",
            (false, false) => "fixture-silent",
        }
    }

    fn program(&self) -> &'static str {
        crate::roles::fixture::PROGRAM
    }

    fn caps(&self) -> Caps {
        Caps {
            events: self.events,
            resume: false,
            permissions: None,
            questions: self.events.then_some(ReplyVia::Core),
        }
    }

    fn launch(&self, run: &Run) -> Vec<String> {
        let hooks = self.events.then(|| self.attach(run.hook));
        let hooks = hooks.into_iter().flatten();
        let mut argv = vec![self.program().to_owned()];
        argv.extend(hooks.map(|a| a.to_string_lossy().into_owned()));
        argv.push(run.prompt.to_owned());
        argv
    }

    fn attach(&self, exe: &Path) -> Vec<OsString> {
        vec!["--hook".into(), exe.into()]
    }

    fn variables(&self) -> &'static [&'static str] {
        &["FIXTURE_AGENT_KEY"]
    }

    fn probe(&self, _: &Path, _: &Path) -> Option<Probe> {
        self.probed.then(|| Probe {
            argv: vec![self.program().into(), "print:probed".into()],
            input: String::new(),
            read: Box::new(|line| (line.trim() == "probed").then(|| Ok(vec!["--probed".into()]))),
        })
    }

    fn detect(&self) -> Detect {
        Detect {
            version: &["print:fixture 1.0"],
            version_of: |out| out.lines().last().map(|l| l.trim().to_owned()),
            account: &["print:signed in as fixture"],
            account_of: |code, out| {
                let signed = out.contains("signed in as fixture");
                (
                    Some(code == Some(0) && signed),
                    signed.then(|| "fixture".into()),
                )
            },
        }
    }

    fn event(&self, _: &[String], payload: &[u8]) -> Result<Option<Heard>, String> {
        match Self::said(payload)? {
            (false, event) => Ok(Some(Heard::Event(event))),
            (
                true,
                SessionEvent {
                    event: Event::Question { question },
                    ..
                },
            ) => Ok(Some(Heard::Wait(question))),
            (true, _) => Err("only a question waits".into()),
        }
    }

    fn reply(&self, _: &[String], payload: &[u8], answer: &Answer) -> Option<String> {
        use tasktap_proto::QuestionKind;
        let choices = match Self::said(payload).ok()?.1.event {
            Event::Question { question } => match question.kind {
                QuestionKind::Choice { choices } => choices,
                _ => Vec::new(),
            },
            _ => Vec::new(),
        };
        Some(crate::roles::said(answer, &choices))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_text_is_cut_to_fit_its_bound_as_json() {
        assert_eq!(fit("short", 100), "short");
        let quotes = "\"".repeat(100);
        let cut = fit(&quotes, 50);
        assert!(serde_json::to_string(&cut).unwrap().len() <= 50, "{cut}");
        let wide = "é".repeat(100);
        let cut = fit(&wide, 51);
        assert!(serde_json::to_string(&cut).unwrap().len() <= 51);
        assert!(cut.chars().all(|c| c == 'é'));
    }

    #[test]
    fn the_same_parts_give_the_same_digest() {
        assert_eq!(digest(&[b"a", b"bc"]), digest(&[b"a", b"bc"]));
        assert_ne!(digest(&[b"a", b"bc"]), digest(&[b"ab", b"c"]));
    }

    #[test]
    fn the_default_agent_is_the_registrys_first() {
        assert_eq!(all()[0].id(), "claude");
        for agent in all() {
            assert_eq!(find(agent.id()).map(|a| a.id()), Some(agent.id()));
        }
    }
}
