//! The agents the core knows (design §7): how a run of each starts, what its
//! hooks say in the core's one vocabulary, and what a hook that waited
//! prints for its agent. The hook half runs in `tasktap hook`, so a payload
//! the core would not understand never reaches it; the launcher reads the
//! rest.
//!
//! An adapter is data and small pure functions: `event` and `reply` do no
//! I/O. What must run a program, telling whether an agent is installed and
//! signed in and the check some agents need before a run starts, is
//! described by the adapter and run by [`checks`]; so is asking an agent's
//! tool one question without a session, which is how a thought is routed
//! and its brief written (design §8). This module and its
//! children are the only place that names an agent; the list below is the
//! registry, and its first entry is the default agent.

pub mod antigravity;
pub mod checks;
pub mod claude;
pub mod codex;
pub mod opencode;
pub mod pi;
pub mod plain;
pub mod rules;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tasktap_proto::{AgentHealth, Answer, Ask, Event, ReplyVia, SessionEvent, SessionId};

/// What one hook says.
#[derive(Debug)]
pub enum Heard {
    /// Reported, and the hook exits.
    Event(SessionEvent),
    /// Asked through the core: the agent lets this hook decide, so it waits
    /// for the answer and prints [`Agent::reply`].
    Wait(Ask),
    /// Reported once the hook has read the end of a file its agent keeps:
    /// what the payload leaves out, such as the turn's last message, is
    /// there. `fill` completes the event from the end of the first of
    /// `files` that can be read, or says none while the agent has not yet
    /// written what the event needs, and the hook reads again for a moment.
    /// With no file, or nothing in it by then, it is reported as it is.
    Read {
        event: SessionEvent,
        files: Vec<PathBuf>,
        fill: fn(&SessionEvent, &str) -> Option<SessionEvent>,
    },
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
    /// What it is told: the thought's brief, or its text.
    pub prompt: &'a str,
    /// The person's own words, when `prompt` is a brief that says them
    /// differently (design §8).
    pub words: Option<&'a str>,
    pub model: Option<&'a str>,
    /// The agent's handle of the conversation this run continues.
    pub resume: Option<&'a str>,
    /// This program, which the hooks run as `<hook> hook <id>`.
    pub hook: &'a Path,
    /// The folder of Tasktap's own that holds this agent's files
    /// ([`Agent::files`]): `<data>/agents/<id>`.
    pub home: &'a Path,
    /// What the person lets agents do beyond their default: the
    /// `agent_options` preference, each `<agent>.<option>`.
    pub allowed: &'a [String],
}

/// Something an agent does only when the person lets it ([`Agent::options`]):
/// a switch in its row in Settings, off until they turn it on.
pub struct Choice {
    pub id: &'static str,
    /// The switch's name.
    pub name: &'static str,
    /// What turning it on allows, as a sentence for the person.
    pub allows: &'static str,
}

impl Run<'_> {
    /// Whether the person lets `agent` do what its option `id` is.
    pub fn allows(&self, agent: &dyn Agent, id: &str) -> bool {
        let named = |allowed: &String| {
            let option = allowed.strip_prefix(agent.id())?.strip_prefix('.')?;
            Some(option == id)
        };
        self.allowed.iter().any(|a| named(a) == Some(true))
    }

    /// The prompt as `agent` takes it: with the person's own words after
    /// the brief, when there are both.
    pub fn told(&self, agent: &dyn Agent) -> String {
        match self.words {
            Some(words) => agent.told(self.prompt, words),
            None => self.prompt.to_owned(),
        }
    }
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

/// How an agent's tool answers one question without a session (design §8,
/// the command provider): [`checks::ask`] runs it in an empty folder with
/// the question on its standard input. It gets no tools, saves nothing and
/// reads none of the person's instructions or settings.
pub struct Headless {
    /// The model it asks, the smallest fast one its tool offers. The
    /// person's consent names it.
    pub model: &'static str,
    /// Longest it may take to answer.
    pub limit: Duration,
    /// Its arguments for one question whose answer must fit `schema`.
    pub args: fn(&Schema) -> Vec<String>,
    /// The question as its standard input takes it: as it is for most.
    pub stdin: fn(&str) -> String,
    /// The answer, a JSON text, in what it printed; or why it gave none.
    /// It is asked each time more was printed, and the first answer ends
    /// the tool: it must find none in a part of one.
    pub answer: fn(&str) -> Result<String, String>,
    /// Whether what it printed, and the last line it said beside that,
    /// when it gave no answer, mean it no longer offers the model.
    pub gone: fn(&str, &str) -> bool,
}

/// The JSON schema an answer must fit: as text, and as a file that holds it.
pub struct Schema<'a> {
    pub text: &'a str,
    pub file: &'a Path,
}

/// What every agent's own words frame says about the two texts.
pub(crate) const WORDS: &str = "The text above is a brief written from what the person said. \
     What they said follows, word for word; where the two differ, their words count.";

/// Something an agent shows in its terminal and waits on there before it
/// is ready.
#[derive(Debug, PartialEq, Eq)]
pub struct Prompt {
    /// Words its terminal shows then, as text: a control sequence or a run
    /// of spaces between them is one space.
    pub shows: &'static str,
    /// The question's prompt.
    pub asks: &'static str,
}

/// Reads a terminal's output for the prompts of its agent: the text without
/// the terminal's control sequences, each prompt found once. The core reads
/// with it only until the agent is ready, never to follow its work.
pub struct Watch {
    prompts: &'static [Prompt],
    found: Vec<bool>,
    /// The end of the text read so far.
    tail: Vec<u8>,
    escape: Escape,
}

#[derive(Clone, Copy, PartialEq)]
enum Escape {
    No,
    Esc,
    /// `ESC [` up to its final byte.
    Csi,
    /// `ESC ]` up to BEL or `ESC \`.
    Osc,
    OscEsc,
}

impl Watch {
    /// None for an agent that shows nothing to wait on.
    pub fn new(prompts: &'static [Prompt]) -> Option<Watch> {
        (!prompts.is_empty()).then(|| Watch {
            prompts,
            found: vec![false; prompts.len()],
            tail: Vec::new(),
            escape: Escape::No,
        })
    }

    /// Reads more output: the first prompt it completes, once.
    pub fn read(&mut self, bytes: &[u8]) -> Option<&'static Prompt> {
        let longest = self
            .prompts
            .iter()
            .map(|p| p.shows.len())
            .max()
            .unwrap_or(0);
        let mut first = None;
        for &b in bytes {
            let (escape, text) = match (self.escape, b) {
                (Escape::No, 0x1b) => (Escape::Esc, None),
                (Escape::No, b) if b <= b' ' || b == 0x7f => (Escape::No, Some(b' ')),
                (Escape::No, b) => (Escape::No, Some(b)),
                (Escape::Esc, b'[') => (Escape::Csi, None),
                (Escape::Esc, b']') => (Escape::Osc, None),
                (Escape::Esc, _) => (Escape::No, Some(b' ')),
                (Escape::Csi, 0x40..=0x7e) => (Escape::No, Some(b' ')),
                (Escape::Csi, _) => (Escape::Csi, None),
                (Escape::Osc, 0x07) => (Escape::No, Some(b' ')),
                (Escape::Osc, 0x1b) => (Escape::OscEsc, None),
                (Escape::Osc, _) => (Escape::Osc, None),
                (Escape::OscEsc, _) => (Escape::No, Some(b' ')),
            };
            self.escape = escape;
            let Some(c) = text else { continue };
            if c == b' ' && self.tail.last() == Some(&b' ') {
                continue;
            }
            self.tail.push(c);
            if self.tail.len() > 2 * longest {
                self.tail.drain(..self.tail.len() - longest);
            }
            for (i, p) in self.prompts.iter().enumerate() {
                if !self.found[i] && self.tail.ends_with(p.shows.as_bytes()) {
                    self.found[i] = true;
                    first = first.or(Some(p));
                }
            }
        }
        first
    }
}

pub trait Agent: Sync {
    /// Its name: the shim's program name and the `<agent>` of `tasktap hook`.
    fn id(&self) -> &'static str;

    /// Its name as a person knows it: what every sentence about it says.
    fn name(&self) -> &'static str;

    /// Whether it runs on this system. One that does not yet is listed and
    /// says so, runs nothing and has no shim.
    fn supported(&self) -> bool {
        true
    }

    /// The person added it: it can be changed and removed.
    fn own(&self) -> bool {
        false
    }

    /// What a person should know of it that nothing else in its row says,
    /// as a sentence; nothing for most agents.
    fn note(&self) -> Option<&'static str> {
        None
    }

    /// What it does only when the person lets it; nothing for most agents.
    fn options(&self) -> &'static [Choice] {
        &[]
    }

    /// Its program, found on the PATH of the terminals.
    fn program(&self) -> &'static str;

    fn caps(&self) -> Caps;

    /// The command line of a run, new or continuing `run.resume`: first the
    /// program, then its arguments, with the hooks attached as
    /// [`Agent::attach`] does. The core starts it as the terminal's direct
    /// child, with no shell around it.
    fn launch(&self, run: &Run) -> Vec<String>;

    /// Arguments, put before the person's own, with which a run of the agent
    /// calls `<exe> hook <id>` on its hook events. `home` is the folder its
    /// files are in, for an agent that is given them by a path.
    fn attach(&self, exe: &Path, home: &Path) -> Vec<OsString>;

    /// Files its runs read their hooks from, for an agent that takes them
    /// from a file and not from its arguments: a plugin, an extension, a
    /// settings file. Each is a path below a folder of Tasktap's own for
    /// this agent (`<data>/agents/<id>`, `home` above) with its content.
    /// The launcher and the shim write them before a run ([`checks::keep`]):
    /// nothing of the person's is written, and their project gets no file.
    fn files(&self, _exe: &Path) -> Vec<(&'static str, String)> {
        Vec::new()
    }

    /// Variables its runs are given beside the terminal's own, for an
    /// agent that is told by its environment where its settings are or how
    /// to reach what listens to it. Never a secret: the terminal's record
    /// does not keep them, but its children all get them.
    fn environment(&self, _exe: &Path, _home: &Path) -> Vec<(&'static str, String)> {
        Vec::new()
    }

    /// The check a run in `cwd` needs before it starts, with its hooks
    /// calling `exe`; none for most agents.
    fn probe(&self, _exe: &Path, _cwd: &Path) -> Option<Probe> {
        None
    }

    fn detect(&self) -> Detect;

    /// How its tool answers one question without a session; none when it
    /// cannot, and then it routes no thought.
    fn headless(&self) -> Option<Headless> {
        None
    }

    /// What a run is told when a brief was written from the person's
    /// words (design §8): the brief, then their words as they said them,
    /// marked as theirs, so the agent can check one against the other.
    fn told(&self, brief: &str, words: &str) -> String;

    /// Variables of the core's own environment that its runs need, such as
    /// the key a person signs it in with (design §7, §9): the only ones a
    /// terminal gets beyond the fixed list. None for most agents.
    fn variables(&self) -> &'static [&'static str] {
        &[]
    }

    /// What it may show in its terminal and wait on there before it is
    /// ready, before any hook runs (design §7): a question the core opens,
    /// answered in that terminal. None for most agents.
    fn prompts(&self) -> &'static [Prompt] {
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

/// The agent named `id`: one this core has, or one the person removed,
/// which still has its name and says what its runs were ([`removed`]).
pub fn find(id: &str) -> Option<&'static dyn Agent> {
    let own = OWN.read().unwrap_or_else(|e| e.into_inner());
    let own = own.iter().map(|agent| *agent as &dyn Agent);
    let mut all = AGENTS.iter().copied().chain(own);
    all.find(|agent| agent.id() == id)
}

/// The agent named `id`, when this core has it now: not one the person
/// removed.
pub fn live(id: &str) -> Option<&'static dyn Agent> {
    all().into_iter().find(|agent| agent.id() == id)
}

/// The option `<agent>.<option>` names, when an agent has it.
pub fn option(name: &str) -> Option<&'static Choice> {
    let (agent, option) = name.split_once('.')?;
    find(agent)?.options().iter().find(|o| o.id == option)
}

/// Whether a capture may name the agent, by what detection last found of
/// it (`health`, its row of the `agents` collection): not while it is
/// known to be missing or signed out, so that no other agent runs the
/// thought in its place. While nothing is known, because no detection
/// has finished or the agent would not say whether it is signed in, it
/// may: a run that cannot start fails and says why.
pub fn usable(agent: &dyn Agent, health: Option<&AgentHealth>) -> Result<(), String> {
    let name = agent.name();
    if let Some(why) = removed(agent.id()) {
        return Err(why);
    }
    match health {
        _ if !agent.supported() => Err(format!("{name} does not run on this system yet")),
        Some(h) if !h.installed => Err(format!("{name} is not installed on this computer")),
        // What was said before this look, and not since, refuses nothing:
        // the person may have signed in meanwhile.
        Some(h) if h.signed_in == Some(false) && !h.stale => {
            Err(format!("{name} is not signed in"))
        }
        _ => Ok(()),
    }
}

/// What a new look at an agent leaves of the last one. When its commands
/// could not say this time whether it is signed in, as with no network, or
/// have not run at all, as when a core starts, what they last said stands,
/// marked as such (`stale`), with the time they said it and the version
/// they named; otherwise the new look, as of `now`.
pub fn merged(
    last: Option<&AgentHealth>,
    found: AgentHealth,
    now: tasktap_proto::Time,
) -> AgentHealth {
    match last.filter(|last| last.signed_in.is_some()) {
        Some(last) if found.installed && found.supported && found.signed_in.is_none() => {
            AgentHealth {
                checked: last.checked,
                version: found.version.or_else(|| last.version.clone()),
                signed_in: last.signed_in,
                identity: last.identity.clone(),
                stale: true,
                ..found
            }
        }
        _ => AgentHealth {
            checked: now,
            ..found
        },
    }
}

/// The folder of Tasktap's own for the files of `agent`, in the data folder.
pub fn home(data: &Path, agent: &dyn Agent) -> PathBuf {
    data.join("agents").join(agent.id())
}

/// Every agent this core has, the default first: the build's own, then the
/// ones the person added and has not removed.
pub fn all() -> Vec<&'static dyn Agent> {
    let own = OWN.read().unwrap_or_else(|e| e.into_inner());
    let own = own.iter().filter(|agent| !agent.removed);
    let own = own.map(|agent| *agent as &dyn Agent);
    AGENTS.iter().copied().chain(own).collect()
}

/// Why the agent named `id` runs nothing, when it is one the person added
/// and then removed: said where a thought or a follow-up names it, with
/// the way back.
pub fn removed(id: &str) -> Option<String> {
    let own = OWN.read().unwrap_or_else(|e| e.into_inner());
    let agent = own.iter().find(|agent| agent.id == id && agent.removed)?;
    let name = agent.name;
    Some(format!(
        "{name} is no longer set up: add it back in Settings \u{203a} Agents"
    ))
}

/// The agents the person added (the `own_agents` preference), which only
/// the core's own process knows: none of them has a hook or a shim.
static OWN: std::sync::RwLock<Vec<&'static plain::Plain>> = std::sync::RwLock::new(Vec::new());

/// Takes the agents the person added as they are now, or says why one of
/// them cannot be an agent and leaves the ones before. One that did not
/// change stays the adapter it was.
pub fn set_own(list: &[tasktap_proto::OwnAgent]) -> Result<(), String> {
    let checked = plain::own(list)?;
    let mut own = OWN.write().unwrap_or_else(|e| e.into_inner());
    let was = std::mem::take(&mut *own);
    let adapter = |agent: plain::Own| match was.iter().find(|plain| agent.is(plain)) {
        Some(plain) => *plain,
        None => agent.adapter(),
    };
    *own = checked.into_iter().map(adapter).collect();
    Ok(())
}

/// The agents a core lists as it starts and looks at by itself, the first
/// time it gives one a thought (`agents` collection, design §7): every
/// one, except in a build with the test fixtures, where only the fixture
/// agents, so that a test never runs a real agent's commands.
pub fn at_start() -> Vec<&'static dyn Agent> {
    // The person's own are listed in any build: they have no commands.
    #[cfg(feature = "fixtures")]
    let detected = |a: &&dyn Agent| a.program() == crate::roles::fixture::PROGRAM || a.own();
    #[cfg(not(feature = "fixtures"))]
    let detected = |_: &&dyn Agent| true;
    all().into_iter().filter(detected).collect()
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
    &antigravity::Antigravity,
    &pi::Pi,
    &opencode::OpenCode,
    &plain::AIDER,
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

    fn name(&self) -> &'static str {
        match self.id() {
            "fixture" => "Fixture agent",
            other => other,
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

    /// One thing it does only when let, as an agent with such a switch has it.
    fn options(&self) -> &'static [Choice] {
        const MORE: &[Choice] = &[Choice {
            id: "more",
            name: "More",
            allows: "The fixture agent is started with --more.",
        }];
        if self.events && !self.probed {
            MORE
        } else {
            &[]
        }
    }

    fn launch(&self, run: &Run) -> Vec<String> {
        let hooks = self.events.then(|| self.attach(run.hook, run.home));
        let hooks = hooks.into_iter().flatten();
        let mut argv = vec![self.program().to_owned()];
        argv.extend(hooks.map(|a| a.to_string_lossy().into_owned()));
        argv.extend(run.allows(self, "more").then(|| "--more".to_owned()));
        argv.push(run.told(self));
        argv
    }

    fn attach(&self, exe: &Path, _: &Path) -> Vec<OsString> {
        vec!["--hook".into(), exe.into()]
    }

    /// One file and one variable, as an agent that reads its hooks from a
    /// plugin folder would have them.
    fn files(&self, _: &Path) -> Vec<(&'static str, String)> {
        match self.events {
            true => vec![("kept/note.txt", "kept for the fixture agent\n".into())],
            false => Vec::new(),
        }
    }

    fn environment(&self, _: &Path, home: &Path) -> Vec<(&'static str, String)> {
        match self.events {
            true => vec![("FIXTURE_AGENT_HOME", home.to_string_lossy().into_owned())],
            false => Vec::new(),
        }
    }

    fn variables(&self) -> &'static [&'static str] {
        &["FIXTURE_AGENT_KEY"]
    }

    fn prompts(&self) -> &'static [Prompt] {
        const TRUST: &[Prompt] = &[Prompt {
            shows: "Do you trust the files in this folder?",
            asks: "The fixture agent is asking whether to trust this folder",
        }];
        if self.events { TRUST } else { &[] }
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

    /// Asked a question, it keeps what it was asked as `asked` in its
    /// folder and runs the steps a test wrote there as `ask`; the last
    /// line it prints is its answer. The silent one is given a second, so
    /// that a test of the time limit is short.
    fn headless(&self) -> Option<Headless> {
        Some(Headless {
            model: "fixture-small",
            limit: Duration::from_secs(if self.events { 20 } else { 1 }),
            args: |_| vec!["keep:asked".into(), "script:ask".into()],
            stdin: str::to_owned,
            answer: |out| {
                let last = out.lines().last().unwrap_or_default().trim();
                match (
                    last.strip_prefix("error:"),
                    serde_json::from_str::<Value>(last),
                ) {
                    (Some(why), _) => Err(why.into()),
                    (None, Ok(Value::Object(_))) if out.ends_with('\n') => Ok(last.into()),
                    _ => Err("it printed no answer".into()),
                }
            },
            gone: |printed, _| printed.trim_end().ends_with("error:no such model"),
        })
    }

    /// The brief alone: a test scripts the fixture agent with it, a step
    /// to a line, so nothing may follow it. What the real agents are told
    /// is proven on their adapters.
    fn told(&self, brief: &str, _: &str) -> String {
        brief.to_owned()
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
