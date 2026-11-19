//! The plain agents (design §7): tools that tell nobody what they do. One
//! adapter runs them all from a command line: the program, then its
//! arguments, with `{prompt}` where what the run is told goes. A run is
//! started in the tool's form for one task, the one that does the work and
//! exits, so that its end is the end of the work: exit 0 is done, anything
//! else failed (design §5, `exited`). Tasktap hears nothing else of it: no
//! turn, no question, no approval, no handle to continue with. What the tool
//! asks, it asks in its terminal.
//!
//! The ones Tasktap brings are a table here; the ones a person adds are the
//! `own_agents` preference, a name and a command line each. Neither has a
//! shim, so one typed by hand in a Tasktap shell runs as typed, and neither
//! places a thought.

use std::ffi::OsString;
use std::path::Path;

use tasktap_proto::{Answer, OwnAgent};

use super::{Agent, Caps, Detect, Heard, Run, WORDS};

/// Where what a run is told goes in a command line.
pub const PROMPT: &str = "{prompt}";
/// Where a run's model goes in the words that name it.
const MODEL: &str = "{model}";
/// Most agents a person has added and not removed, and most they have
/// with the removed ones.
pub const MOST: usize = 16;
pub const KEPT: usize = 64;

pub struct Plain {
    pub id: &'static str,
    pub name: &'static str,
    /// Its command line, word by word: first the program.
    pub command: &'static [&'static str],
    /// The words that name a run's model, put after the program when the
    /// run has one; none for a tool that is not told its model.
    pub model: &'static [&'static str],
    /// The arguments with which it prints its version; none: it is not asked.
    pub version: &'static [&'static str],
    /// The variables of the core's environment its runs need.
    pub variables: &'static [&'static str],
    /// First characters with which it reads what it is told as a command
    /// of its own: a run told something that starts with one is told it
    /// after a space.
    pub commands: &'static str,
    /// What a person should know of it that nothing else in its row says.
    pub note: Option<&'static str>,
    /// It has been run on Windows.
    pub windows: bool,
    /// The person added it.
    pub own: bool,
    /// The person removed it: it runs nothing, and is known only so that
    /// what it ran says who ran it.
    pub removed: bool,
}

/// Aider, as 0.86.2 runs one task (`--message`): it does the work, commits
/// it as the person's configuration says (by default each edit), and exits.
///
/// It asks before much of what it does and would wait on each question in
/// its terminal, where Tasktap hears nothing, so a run is started with
/// `--yes-always`, which says yes to all but a shell command, as the runs
/// of the other agents are started with their own "do not ask". Four more
/// flags keep that yes from doing what nobody asked for: joining its
/// analytics, upgrading itself in place of the task, opening its release
/// notes in a browser, and fetching a web address a thought names (for
/// which it would install a browser of its own). The first run in a
/// project adds `.aider*` to that project's `.gitignore`, as Aider
/// recommends, and its history files are written there.
///
/// It exits with 0 whether it did the work, its key was refused or it was
/// interrupted (seen in runs): the thought is then done as far as Tasktap
/// can tell, and the row says so.
pub const AIDER: Plain = Plain {
    id: "aider",
    name: "Aider",
    #[rustfmt::skip]
    command: &[
        "aider", "--yes-always", "--no-analytics", "--no-check-update",
        "--no-show-release-notes", "--no-detect-urls", "--message={prompt}",
    ],
    model: &["--model", MODEL],
    version: &["--version"],
    // The keys and addresses its documentation names for the providers it
    // runs on with one of each, for a person who signs it in that way and
    // not in its files. Those that need several (Azure, Bedrock, Vertex)
    // are signed in through its own.
    #[rustfmt::skip]
    variables: &[
        "ANTHROPIC_API_KEY", "COHERE_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY",
        "GROQ_API_KEY", "LM_STUDIO_API_BASE", "LM_STUDIO_API_KEY", "MISTRAL_API_KEY",
        "OLLAMA_API_BASE", "OLLAMA_API_KEY", "OPENAI_API_BASE", "OPENAI_API_KEY",
        "OPENROUTER_API_KEY", "XAI_API_KEY",
    ],
    // `/` begins a command of its own, `!` a shell command.
    commands: "/!",
    note: Some("Its terminal says whether it did the work: Aider ends the same way either way."),
    windows: false,
    own: false,
    removed: false,
};

impl Agent for Plain {
    fn id(&self) -> &'static str {
        self.id
    }

    fn name(&self) -> &'static str {
        self.name
    }

    fn own(&self) -> bool {
        self.own
    }

    fn supported(&self) -> bool {
        self.windows || !cfg!(windows)
    }

    fn note(&self) -> Option<&'static str> {
        self.note
    }

    /// It runs one task and ends.
    fn typed(&self) -> bool {
        false
    }

    fn program(&self) -> &'static str {
        self.command[0]
    }

    fn caps(&self) -> Caps {
        Caps {
            events: false,
            resume: false,
            permissions: None,
            questions: None,
        }
    }

    fn launch(&self, run: &Run) -> Vec<String> {
        let told = run.told(self);
        let told = match told.starts_with(|c| self.commands.contains(c)) {
            true => format!(" {told}"),
            false => told,
        };
        let model = run.model.filter(|_| !self.model.is_empty());
        let model = model.map(|m| self.model.iter().map(move |word| word.replace(MODEL, m)));
        let (program, args) = (self.command[0], &self.command[1..]);
        let mut argv = vec![program.to_owned()];
        argv.extend(model.into_iter().flatten());
        argv.extend(args.iter().map(|word| word.replace(PROMPT, &told)));
        argv
    }

    /// It has no hooks.
    fn attach(&self, _: &Path, _: &Path) -> Vec<OsString> {
        Vec::new()
    }

    /// Its version, where it has a way to print it, and nothing on whether
    /// it is signed in: such a tool has its keys where Tasktap does not look.
    fn detect(&self) -> Detect {
        Detect {
            version: self.version,
            // "aider 0.86.1"
            version_of: |out| {
                let line = out.lines().find(|line| !line.trim().is_empty())?;
                line.split_whitespace().last().map(Into::into)
            },
            account: &[],
            account_of: |_, _| (None, None),
        }
    }

    fn told(&self, brief: &str, words: &str) -> String {
        format!("{brief}\n\n---\n{WORDS}\n\n{words}")
    }

    fn variables(&self) -> &'static [&'static str] {
        self.variables
    }

    fn event(&self, _: &[String], _: &[u8]) -> Result<Option<Heard>, String> {
        Ok(None)
    }

    fn reply(&self, _: &[String], _: &[u8], _: &Answer) -> Option<String> {
        None
    }
}

/// The words of a command line: apart by spaces, with single or double
/// quotes around one that has spaces. No shell reads it, so nothing in it
/// is expanded and a backslash is itself.
pub fn words(line: &str) -> Result<Vec<String>, String> {
    let (mut words, mut word, mut open, mut begun) = (Vec::new(), String::new(), None, false);
    for c in line.chars() {
        match (open, c) {
            (Some(quote), c) if c == quote => open = None,
            (Some(_), c) => word.push(c),
            (None, '"' | '\'') => (open, begun) = (Some(c), true),
            (None, c) if c.is_whitespace() => {
                if begun {
                    words.push(std::mem::take(&mut word));
                }
                begun = false;
            }
            (None, c) => {
                word.push(c);
                begun = true;
            }
        }
    }
    if open.is_some() {
        return Err("A quote in the command is not closed".into());
    }
    if begun {
        words.push(word);
    }
    Ok(words)
}

/// An agent a person added, checked: its id, its name, its command line
/// word by word, and whether they removed it.
#[derive(PartialEq, Eq)]
pub struct Own(String, String, Vec<String>, bool);

impl Own {
    /// Whether `plain` is this agent as it is now.
    pub fn is(&self, plain: &Plain) -> bool {
        (self.0.as_str(), self.1.as_str(), self.3) == (plain.id, plain.name, plain.removed)
            && self.2.iter().eq(plain.command.iter())
    }

    /// Its adapter, which lives as long as the core does: a thought or a
    /// run may name it for as long.
    pub fn adapter(self) -> &'static Plain {
        let kept = |text: String| -> &'static str { Box::leak(text.into_boxed_str()) };
        let command: Vec<&'static str> = self.2.into_iter().map(kept).collect();
        Box::leak(Box::new(Plain {
            id: kept(self.0),
            name: kept(self.1),
            command: Box::leak(command.into_boxed_slice()),
            model: &[],
            version: &[],
            variables: &[],
            commands: "",
            note: None,
            windows: true,
            own: true,
            removed: self.3,
        }))
    }
}

/// The agents a person added, checked, or why one cannot be an agent: a
/// sentence the interface shows as it is.
pub fn own(list: &[OwnAgent]) -> Result<Vec<Own>, String> {
    if list.iter().filter(|agent| !agent.removed).count() > MOST {
        return Err(format!("Tasktap keeps at most {MOST} agents of your own"));
    }
    if list.len() > KEPT {
        return Err("Forget an agent you removed before you add another".into());
    }
    let mut all = Vec::new();
    for (i, agent) in list.iter().enumerate() {
        let code = agent.id.strip_prefix("own-").unwrap_or_default();
        let coded = code
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
        if !(1..=16).contains(&code.len()) || !coded {
            return Err("An agent of your own has an id Tasktap did not give it".into());
        }
        if list[..i].iter().any(|other| other.id == agent.id) {
            return Err("Two agents of your own have the same id".into());
        }
        let plain = |text: &str| !text.chars().any(char::is_control);
        let name = agent.name.trim();
        if !(1..=40).contains(&name.chars().count()) || !plain(name) {
            return Err("Give the agent a name of up to 40 characters".into());
        }
        if agent.command.len() > 2000 || !plain(&agent.command) {
            return Err(format!(
                "The command of {name} is too long, or not one line"
            ));
        }
        let command = words(&agent.command)?;
        match command.split_first() {
            None => return Err(format!("{name} needs a command")),
            Some((program, _)) if program.contains(PROMPT) => {
                return Err(format!(
                    "The command of {name} needs a program before {PROMPT}"
                ));
            }
            Some((_, args)) if !args.iter().any(|word| word.contains(PROMPT)) => {
                return Err(format!(
                    "The command of {name} needs {PROMPT} where the thought goes"
                ));
            }
            Some(_) => {}
        }
        all.push(Own(
            agent.id.clone(),
            name.to_owned(),
            command,
            agent.removed,
        ));
    }
    Ok(all)
}
