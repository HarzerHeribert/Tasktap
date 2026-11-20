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
//! Qwen Code, Goose, Crush and Droid speak it, each proved on the real tool
//! (their recorded payloads are the tests' fixtures). Two kinds of run:
//!
//! - **Qwen Code stays**: its terminal interface runs the first prompt and
//!   takes what is typed after it, as Claude Code's does. What it asks, a
//!   permission or a question, it asks in its terminal; the request is
//!   heard and shown, and answered there.
//! - **Goose, Crush and Droid run one task and end**: their form for one
//!   prompt, which does the work and exits, heard through their hooks
//!   while it runs. Their own terminal interfaces cannot be started with a
//!   prompt (Crush), say nothing when a turn fails (Goose) or want an
//!   account of their maker's first (Droid); the one-task form has none of
//!   these gaps, since its exit says the rest. A follow-up continues the
//!   conversation in a new run, by the session's id. Such a run asks for
//!   no approval, as the runs of the other agents are started.
//!
//! Qwen Code's payloads carry the time, which with the event's name is its
//! id. Goose's and Crush's carry nothing that tells one turn's events from
//! the next's, and need nothing: a run of theirs is one turn, and an event
//! is told from a repeat within its run, so its name is its id (and a
//! tool's use is named by its call).

use std::ffi::OsString;
use std::path::Path;

use serde_json::{Value, json};
use tasktap_proto::{Answer, Ask, Event, MAX_LINE, MAX_TEXT, QuestionKind, ReplyVia, SessionEvent};

use super::{Agent, Caps, Choice, Detect, Heard, Payload, Run, WORDS};
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
    /// What the person lets agents do beyond their default
    /// (`<agent>.<option>`).
    pub allowed: &'a [String],
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
    /// What it does only when the person lets it.
    pub options: &'static [Choice],
    /// For a tool whose end of a turn does not say what it last said: what
    /// the turn's end is, from the end of the transcript its payload names
    /// (`transcript_path`). The event it is given has the id `<event>:`
    /// and the message the payload names (`message_id`).
    pub ends: Option<fn(&SessionEvent, &str) -> Option<SessionEvent>>,
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
    options: &[],
    ends: None,
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
const GOOSE_EVENTS: &[(&str, Says)] = &[
    ("SessionStart", Says::Ready),
    ("UserPromptSubmit", Says::Started),
    ("PreToolUse", Says::Tool),
    ("Stop", Says::Finished),
];
const CRUSH_EVENTS: &[(&str, Says)] = &[
    ("SessionStart", Says::Ready),
    ("TurnStart", Says::Started),
    ("PreToolUse", Says::Tool),
    ("TurnEnd", Says::Finished),
    ("StopFailure", Says::Failed),
    ("Interrupt", Says::Interrupted),
];

/// Goose, as `goose` 1.60.1 runs one task (`goose run --text=`). Its hooks
/// come only from a plugin folder below its root, so a run is given a root
/// of Tasktap's (`GOOSE_PATH_ROOT`) with the person's own configuration
/// read beside it (`GOOSE_ADDITIONAL_CONFIG_FILES`): its sessions and logs
/// are then in Tasktap's folder, apart from the person's own Goose's. A run
/// is started in its mode that asks for no approval, the only one its
/// one-task form runs in, and with its telemetry off, since the root has no
/// answer of the person's to its question about it.
pub const GOOSE: Dialect = Dialect {
    id: "goose",
    name: "Goose",
    program: "goose",
    events: GOOSE_EVENTS,
    prompt: "message",
    call: "tool_call_id",
    question: "",
    args: |run| {
        let mut args = vec!["run".to_owned()];
        if let Some(handle) = run.resume {
            args.extend(["--resume".into(), "--session-id".into(), handle.into()]);
        }
        if let Some(model) = run.model {
            args.extend(["--model".into(), model.into()]);
        }
        args.push(format!("--text={}", run.told));
        args
    },
    files: |command| {
        let hook = json!([{ "hooks": [{ "type": "command", "command": command }] }]);
        let hooks: serde_json::Map<String, Value> = (GOOSE_EVENTS.iter())
            .map(|(event, _)| ((*event).to_owned(), hook.clone()))
            .collect();
        let plugin = json!({
            "name": "tasktap", "version": "1.0.0",
            "description": "Tells Tasktap what this run does",
        });
        vec![
            (".agents/plugins/tasktap/plugin.json", plugin.to_string()),
            (
                ".agents/plugins/tasktap/hooks/hooks.json",
                json!({ "hooks": hooks }).to_string(),
            ),
        ]
    },
    environment: |home| {
        // Where the person's own Goose keeps what they chose: read, never written.
        // On Windows in the roaming application data (`%APPDATA%\Block\goose\
        // config`), where no `HOME` is set; elsewhere in the XDG folder.
        let set = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty());
        let own = match cfg!(windows) {
            true => set("APPDATA").map(|folder| {
                let parts = ["Block", "goose", "config", "config.yaml"];
                parts
                    .iter()
                    .fold(std::path::PathBuf::from(folder), |p, part| p.join(part))
            }),
            false => (set("XDG_CONFIG_HOME").map(std::path::PathBuf::from))
                .or_else(|| Some(Path::new(&set("HOME")?).join(".config")))
                .map(|folder| folder.join("goose/config.yaml")),
        };
        let mut all = vec![
            ("GOOSE_PATH_ROOT", home.to_string_lossy().into_owned()),
            ("GOOSE_MODE", "auto".to_owned()),
            ("GOOSE_TELEMETRY_OFF", "1".to_owned()),
        ];
        all.extend(own.map(|file| {
            (
                "GOOSE_ADDITIONAL_CONFIG_FILES",
                file.to_string_lossy().into_owned(),
            )
        }));
        all
    },
    // `!` runs the rest in a shell at once, `/` begins a command of its own.
    commands: "!/",
    stays: false,
    version: &["--version"],
    #[rustfmt::skip]
    variables: &[
        "GOOSE_PROVIDER", "GOOSE_MODEL", "GOOSE_DISABLE_KEYRING", "ANTHROPIC_API_KEY",
        "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "OPENAI_HOST", "OPENAI_BASE_PATH",
        "OPENROUTER_API_KEY", "XAI_API_KEY",
    ],
    note: Some(
        "It runs one task and ends; a follow-up goes on in a new run. \
         Its sessions are kept in Tasktap's folder, apart from your own Goose's.",
    ),
    options: &[],
    ends: None,
};

/// Crush, as `crush` 0.101.0 runs one task (`crush run`). A run's data
/// folder is Tasktap's (`--data-dir`), whose `crush.json` carries the hooks
/// and is read beside the person's own; its sessions are then kept there,
/// apart from the person's own Crush's in the project. Its one-task form
/// allows everything for its session.
pub const CRUSH: Dialect = Dialect {
    id: "crush",
    name: "Crush",
    program: "crush",
    events: CRUSH_EVENTS,
    prompt: "",
    call: "tool_use_id",
    question: "",
    args: |run| {
        let home = run.home.to_string_lossy().into_owned();
        let mut args = vec!["run".to_owned(), "-q".into(), "--data-dir".into(), home];
        if let Some(model) = run.model {
            args.extend(["-m".into(), model.into()]);
        }
        if let Some(handle) = run.resume {
            args.extend(["-s".into(), handle.into()]);
        }
        args.extend(["--".into(), run.told.into()]);
        args
    },
    files: |command| {
        let hook = json!([{ "name": "tasktap", "command": command }]);
        let hooks: serde_json::Map<String, Value> = (CRUSH_EVENTS.iter())
            .map(|(event, _)| ((*event).to_owned(), hook.clone()))
            .collect();
        vec![("crush.json", json!({ "hooks": hooks }).to_string())]
    },
    environment: |_| Vec::new(),
    // In its terminal interface `!` runs the rest in a shell at once.
    commands: "!",
    stays: false,
    version: &["--version"],
    #[rustfmt::skip]
    variables: &[
        "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY",
        "OPENAI_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY",
    ],
    note: Some(
        "It runs one task and ends; a follow-up goes on in a new run. \
         Its sessions are kept in Tasktap's folder, apart from your own Crush's.",
    ),
    options: &[],
    ends: None,
};

/// Droid, as `droid` 1.14.0 runs one task (`droid exec`), which needs no
/// account of Factory's for a model of the person's own. A settings file
/// of Tasktap's is merged for the one run (`--settings`); its sessions stay
/// with the person's own. How much a run may do without asking is a level:
/// it is started at `low`, which edits files in the project, and at
/// `medium` (installs, builds, tests, local git) once the person lets it;
/// what is beyond its level ends the run, which says so. Which command is
/// of which level its model says itself.
///
/// Its `Stop` says nothing of what was said, and comes when a turn failed
/// too: the end is read from its transcript ([`droid_ended`]).
pub const DROID: Dialect = Dialect {
    id: "droid",
    name: "Droid",
    program: "droid",
    events: DROID_EVENTS,
    prompt: "prompt",
    call: "",
    question: "",
    args: |run| {
        let settings = run.home.join(DROID_SETTINGS).to_string_lossy().into_owned();
        let mut args = vec!["exec".to_owned(), "--settings".into(), settings];
        if let Some(model) = run.model {
            args.extend(["-m".into(), model.into()]);
        }
        let more = run
            .allowed
            .iter()
            .any(|allowed| allowed == "droid.commands");
        args.extend(["--auto".into(), if more { "medium" } else { "low" }.into()]);
        if let Some(handle) = run.resume {
            args.extend(["-s".into(), handle.into()]);
        }
        args.extend(["--".into(), run.told.into()]);
        args
    },
    files: |command| {
        let hook = json!([{ "hooks": [
            { "type": "command", "command": command, "timeout": 120 },
        ] }]);
        let hooks: serde_json::Map<String, Value> = (DROID_EVENTS.iter())
            .map(|(event, _)| ((*event).to_owned(), hook.clone()))
            .collect();
        vec![(DROID_SETTINGS, json!({ "hooks": hooks }).to_string())]
    },
    environment: |_| Vec::new(),
    // Its one-task form takes `/`, `!` and `@` as they are.
    commands: "",
    stays: false,
    version: &["--version"],
    #[rustfmt::skip]
    variables: &[
        "FACTORY_API_KEY", "FACTORY_DISABLE_KEYRING", "FACTORY_DROID_AUTO_UPDATE_ENABLED",
        "DROID_DISABLE_SOUNDS", "HTTPS_PROXY", "NO_PROXY", "ANTHROPIC_API_KEY",
        "DEEPSEEK_API_KEY", "OPENAI_API_KEY",
    ],
    note: Some(
        "It runs one task and ends; a follow-up goes on in a new run. \
         Its terminal shows nothing until the end.",
    ),
    options: &[Choice {
        id: "commands",
        name: "Build without asking",
        allows: "Droid then installs packages, builds, tests and makes local Git commits on its own; \
                 which commands count, its own model decides.",
    }],
    ends: Some(droid_ended),
};

const DROID_SETTINGS: &str = "settings.json";
const DROID_EVENTS: &[(&str, Says)] = &[
    ("SessionStart", Says::Ready),
    ("UserPromptSubmit", Says::Started),
    ("PreToolUse", Says::Tool),
    ("Stop", Says::Finished),
];

/// The end of a turn of Droid's, from its transcript: the line its `Stop`
/// names. What its model said is the turn's answer. Any other line is why
/// the turn failed: a notice of its own (a key refused, a model not there)
/// or its sentence that the run ended early, which no model wrote. None
/// while the line is not written yet.
fn droid_ended(event: &SessionEvent, transcript: &str) -> Option<SessionEvent> {
    let (_, id) = event.id.split_once(':')?;
    let rows = transcript.lines().rev();
    let mut rows = rows.filter_map(|row| serde_json::from_str::<Value>(row).ok());
    let row = rows.find(|row| row.get("id").and_then(Value::as_str) == Some(id))?;
    let message = row.get("message")?;
    let texts = message.get("content")?.as_array()?.iter();
    let texts = texts.filter_map(|part| part.get("text")?.as_str());
    let said = texts.collect::<Vec<_>>().join("\n");
    let answered = message.get("role").and_then(Value::as_str) == Some("assistant")
        && message.get("modelId").is_some();
    let ended = match answered {
        true => Event::TurnFinished {
            answer: Some(fit(&said, 512 << 10)),
        },
        false => Event::TurnFailed {
            error: Some(fit(&line(&said, 500), MAX_LINE)),
        },
    };
    Some(SessionEvent {
        event: ended,
        ..event.clone()
    })
}

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

    fn options(&self) -> &'static [Choice] {
        self.options
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
            allowed: run.allowed,
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
                // Not said in the payload: read where it is written.
                if let (None, Some(fill), Some(file)) =
                    (&answer, self.ends, p.str("transcript_path"))
                {
                    let id = format!("{name}:{}", p.str("message_id").unwrap_or_default());
                    let Heard::Event(event) =
                        said(id, false, resume, Event::TurnFinished { answer })
                    else {
                        return Ok(None);
                    };
                    let files = vec![file.into()];
                    return Ok(Some(Heard::Read { event, files, fill }));
                }
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
