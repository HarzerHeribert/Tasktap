//! The agents heard through one dialect of hooks (design §7). Several tools
//! took their hooks from Claude Code's and changed them a little: a command
//! is run on a named event with one JSON object on standard input, which
//! names the event (`hook_event_name` or `event`), the conversation
//! (`session_id`), a tool and what it is given (`tool_name`, `tool_input`),
//! what the agent last said (`last_assistant_message`) and why a turn failed
//! (`error`). One adapter reads them all. What differs from tool to tool is
//! a table: which of its events says what, where a prompt is, how a run is
//! started, and how that one run is given its hooks, from a file in a
//! folder of Tasktap's that the run is pointed at, so that nothing is
//! written to the person's configuration or to their project.
//!
//! Qwen Code, Goose and Crush speak it, each proved on the real tool (their
//! recorded payloads are the tests' fixtures). Two kinds of run:
//!
//! - **Qwen Code stays**: its terminal interface runs the first prompt and
//!   takes what is typed after it, as Claude Code's does. What it asks, a
//!   permission or a question, it asks in its terminal; the request is
//!   heard and shown, and answered there.
//! - **Goose and Crush run one task and end**: their form for one prompt,
//!   which does the work and exits, heard through their hooks while it
//!   runs. Their own terminal interfaces cannot be started with a prompt
//!   (Crush) or say nothing when a turn fails (Goose); the one-task form
//!   has neither gap, since its exit says the rest. A follow-up continues
//!   the conversation in a new run, by the session's id. Such a run asks
//!   for no approval, as the runs of the other agents are started.
//!
//! Qwen Code's payloads carry the time, which with the event's name is its
//! id. Goose's and Crush's carry nothing that tells one turn's events from
//! the next's, and need nothing: a run of theirs is one turn, and an event
//! is told from a repeat within its run, so its name is its id (and a
//! tool's use is named by its call).

use std::ffi::OsString;
use std::path::Path;

use serde_json::{Value, json};
use tasktap_proto::{Answer, Ask, Event, MAX_LINE, MAX_TEXT, QuestionKind, ReplyVia};

use super::{Agent, Caps, Detect, Heard, Payload, Run, WORDS};
use super::{activity, fit, line, permission, quoted, said};

/// What one of a tool's hook events says.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Says {
    /// The run is there.
    Ready,
    /// A turn begins; with its prompt, where the tool names it.
    Started,
    /// A tool is about to be used: a line of activity.
    Tool,
    /// It asks the person in its terminal: a permission, or a question of
    /// its question tool.
    Asks,
    /// What it asked was answered there.
    Answered,
    /// The turn ended, with what it last said.
    Finished,
    /// The turn failed, with why.
    Failed,
    /// The person interrupted the turn.
    Interrupted,
}

/// A run as its tool's arguments are made from it.
pub struct Start<'a> {
    /// What it is told, safe to pass as it is.
    pub told: &'a str,
    pub model: Option<&'a str>,
    /// The conversation it continues, by the id its hooks named.
    pub resume: Option<&'a str>,
    /// Tasktap's folder for this agent.
    pub home: &'a Path,
}

pub struct Dialect {
    pub id: &'static str,
    pub name: &'static str,
    pub program: &'static str,
    /// What each of its hook events says, by name. One not here says nothing.
    pub events: &'static [(&'static str, Says)],
    /// The field a turn's start has its prompt in; none: it names no prompt.
    /// An event that has the field empty is no start of a turn.
    pub prompt: &'static str,
    /// The field that names a tool's call.
    pub call: &'static str,
    /// Its tool for asking the person a question; none: it has none.
    pub question: &'static str,
    /// A run's arguments after the program.
    pub args: fn(&Start) -> Vec<String>,
    /// The files a run reads its hooks from, below Tasktap's folder for the
    /// agent, for the command a hook runs.
    pub files: fn(&str) -> Vec<(&'static str, String)>,
    /// The variables that point a run at them.
    pub environment: fn(&Path) -> Vec<(&'static str, String)>,
    /// First characters with which it takes what it is told for a command
    /// of its own, or for a file's name: a run told something that starts
    /// with one is told it after [`LEAD`].
    pub commands: &'static str,
    /// Its terminal interface stays and takes what is typed into it; one
    /// that does not runs one task and ends.
    pub stays: bool,
    pub version: &'static [&'static str],
    pub variables: &'static [&'static str],
    pub note: Option<&'static str>,
}

/// What stands before a prompt its tool would take for a command.
pub const LEAD: &str = "Task: ";

/// Qwen Code, as `qwen` 0.28.0 runs it (the npm package
/// `@qwen-code/qwen-code`): a settings file of Tasktap's, named by a
/// variable, carries the hooks. The conversation's id is its own, which its
/// hooks name (it takes one of ours only when that is a UUID of version 4,
/// which a session's id is not); it continues with `--resume`, and its
/// model is named again, since it keeps none. Its approval mode is the
/// person's own (by default a classifier of its own decides). A turn the
/// person interrupts fires no hook.
pub const QWEN: Dialect = Dialect {
    id: "qwen",
    name: "Qwen Code",
    program: "qwen",
    events: QWEN_EVENTS,
    prompt: "prompt",
    call: "tool_use_id",
    question: "ask_user_question",
    args: |run| {
        let mut args = Vec::new();
        if let Some(model) = run.model {
            args.extend(["-m".into(), model.into()]);
        }
        if let Some(handle) = run.resume {
            args.extend(["--resume".into(), handle.into()]);
        }
        args.push(format!("--prompt-interactive={}", run.told));
        args
    },
    files: |command| {
        let hook = |event: &str| {
            json!([{ "matcher": "*", "hooks": [
                { "type": "command", "command": command, "name": format!("tasktap-{event}") },
            ] }])
        };
        let hooks: serde_json::Map<String, Value> = (QWEN_EVENTS.iter())
            .map(|(event, _)| ((*event).to_owned(), hook(event)))
            .collect();
        // The version it would otherwise write into the file itself.
        let settings = json!({ "$version": 4, "hooks": hooks });
        vec![(QWEN_SETTINGS, settings.to_string())]
    },
    environment: |home| {
        let settings = home.join(QWEN_SETTINGS).to_string_lossy().into_owned();
        vec![("QWEN_CODE_SYSTEM_DEFAULTS_PATH", settings)]
    },
    // `/` begins a command of its own, `@` pastes a file, `?` a side command.
    commands: "/@?",
    stays: true,
    version: &["--version"],
    #[rustfmt::skip]
    variables: &[
        "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "QWEN_MODEL", "QWEN_HOME",
        "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "DASHSCOPE_API_KEY", "DEEPSEEK_API_KEY",
    ],
    note: None,
};

const QWEN_SETTINGS: &str = "system-defaults.json";
const QWEN_EVENTS: &[(&str, Says)] = &[
    ("SessionStart", Says::Ready),
    ("UserPromptSubmit", Says::Started),
    ("PreToolUse", Says::Tool),
    ("PermissionRequest", Says::Asks),
    ("PostToolUse", Says::Answered),
    ("PostToolUseFailure", Says::Answered),
    ("PostToolBatch", Says::Answered),
    ("Stop", Says::Finished),
    ("StopFailure", Says::Failed),
];

impl Dialect {
    /// The question its question tool asks, as one answered in its terminal.
    fn question(request: String, input: Option<&Value>) -> Ask {
        let first = input.and_then(|i| i.get("questions")?.get(0));
        let asked = first.and_then(|q| q.get("question")?.as_str());
        Ask {
            request,
            kind: QuestionKind::Text,
            prompt: fit(asked.unwrap_or("It asks a question in its terminal"), 2000),
            detail: None,
            source: None,
        }
    }
}

impl Agent for Dialect {
    fn id(&self) -> &'static str {
        self.id
    }

    fn name(&self) -> &'static str {
        self.name
    }

    /// Not there yet: none of them has been run on Windows.
    fn supported(&self) -> bool {
        !cfg!(windows)
    }

    fn note(&self) -> Option<&'static str> {
        self.note
    }

    fn typed(&self) -> bool {
        self.stays
    }

    fn program(&self) -> &'static str {
        self.program
    }

    fn caps(&self) -> Caps {
        let asks = self.stays.then_some(ReplyVia::Terminal);
        Caps {
            events: true,
            resume: true,
            permissions: asks,
            questions: asks.filter(|_| !self.question.is_empty()),
        }
    }

    fn launch(&self, run: &Run) -> Vec<String> {
        let told = run.told(self);
        let command = told.trim_start().starts_with(|c| self.commands.contains(c));
        let told = match command {
            true => format!("{LEAD}{told}"),
            false => told,
        };
        let start = Start {
            told: &told,
            model: run.model,
            resume: run.resume,
            home: run.home,
        };
        let mut argv = vec![self.program.to_owned()];
        argv.extend((self.args)(&start));
        argv
    }

    /// Its hooks are in its files, and a run is pointed at them by its
    /// arguments or its variables: one typed by hand has none.
    fn attach(&self, _: &Path, _: &Path) -> Vec<OsString> {
        Vec::new()
    }

    fn files(&self, exe: &Path) -> Vec<(&'static str, String)> {
        (self.files)(&format!("{} hook {}", quoted(exe), self.id))
    }

    fn environment(&self, _: &Path, home: &Path) -> Vec<(&'static str, String)> {
        (self.environment)(home)
    }

    /// Its version, as it prints it. None of them has a command that says,
    /// without asking a model, whether it is signed in.
    fn detect(&self) -> Detect {
        Detect {
            version: self.version,
            // "0.28.0", " 1.60.1", "crush version v0.101.0"
            version_of: |out| {
                let line = out.lines().find(|line| !line.trim().is_empty())?;
                let last = line.split_whitespace().last()?;
                Some(last.trim_start_matches('v').to_owned())
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

    fn event(&self, _: &[String], payload: &[u8]) -> Result<Option<Heard>, String> {
        let p = Payload::parse(payload)?;
        let Some(name) = p.str("hook_event_name").or_else(|| p.str("event")) else {
            return Ok(None);
        };
        let Some((_, says)) = self.events.iter().find(|(event, _)| *event == name) else {
            return Ok(None);
        };
        let resume = p.str("session_id");
        let (tool, input) = (p.str("tool_name").unwrap_or_default(), p.get("tool_input"));
        let asks = !self.question.is_empty() && tool == self.question;
        // What tells this event from a repeat of it: its name and the time
        // its tool gives it; its name alone in a run that is one turn.
        let own = format!("{name}:{}", p.str("timestamp").unwrap_or_default());
        let (id, event) = match says {
            Says::Ready => (own, Event::Ready),
            Says::Started => {
                let prompt = p.str(self.prompt).map(|t| fit(t, MAX_TEXT));
                // Named, and empty: the turn goes on after its tools.
                if !self.prompt.is_empty() && prompt.is_none() {
                    return Ok(None);
                }
                (own, Event::TurnStarted { prompt })
            }
            // Its request to be let asks.
            Says::Tool if asks => return Ok(None),
            Says::Tool => {
                let text = activity(tool, input);
                let call = p.str(self.call).map(|call| format!("{name}:{call}"));
                (call.unwrap_or(own), Event::Activity { text })
            }
            Says::Asks => {
                let question = match asks {
                    true => Self::question(own.clone(), input),
                    false => permission(self.name, own.clone(), tool, input),
                };
                (own, Event::Question { question })
            }
            Says::Answered => (own, Event::Continued { request: None }),
            Says::Finished => {
                let answer = p.str("last_assistant_message");
                let answer = answer.map(|a| fit(a, 512 << 10));
                (own, Event::TurnFinished { answer })
            }
            Says::Failed => {
                let why = p.str("error_details").or_else(|| p.str("error"));
                let error = why.map(|e| fit(&line(e, 500), MAX_LINE));
                (own, Event::TurnFailed { error })
            }
            Says::Interrupted => (own, Event::TurnInterrupted),
        };
        Ok(Some(said(id, false, resume, event)))
    }

    /// No hook of theirs waits for the person.
    fn reply(&self, _: &[String], _: &[u8], _: &Answer) -> Option<String> {
        None
    }
}
