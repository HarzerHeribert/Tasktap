//! GitHub Copilot's command line agent (design §7), as `copilot` 1.0.114
//! runs it: its terminal interface, which stays and takes what is typed.
//!
//! A run is given a plugin of Tasktap's own with `--plugin-dir`, a folder
//! below Tasktap's folder for the agent ([`Agent::files`]), whose
//! `hooks/hooks.json` has the tool run `<exe> hook copilot <event>` through
//! bash with the payload on standard input. Nothing is written to the
//! person's `~/.copilot` or to their project. Each command ends in
//! `|| true`: Copilot denies a tool whose `preToolUse` hook exits with
//! anything but 0, and Tasktap's hook must never deny the person's tools
//! when it cannot reach the core.
//!
//! | Hook | Heard |
//! | --- | --- |
//! | `sessionStart` | `ready` (a new session and a resumed one) |
//! | `userPromptSubmitted` | `turn_started` with the prompt |
//! | `preToolUse` | `activity`, the tool and what it does; for `ask_user`, its question, answered in the terminal |
//! | `permissionRequest` | a permission request: a confirm question the hook waits on |
//! | `postToolUse`, `postToolUseFailure` of `ask_user` | `continued`, naming its question |
//! | `agentStop` | `turn_finished` with the last message, read from its transcript |
//! | `errorOccurred` | `activity` while it tries again; `turn_failed` once its transcript says the turn ended on that error |
//!
//! The event's name is the hook's argument, since most of its payloads do
//! not name it; each event's id is that name with the time in milliseconds
//! every payload carries, or the tool call's id, so a repeat is ignored.
//! Every payload names the session (`sessionId`), the handle `--resume`
//! takes.
//!
//! A `permissionRequest` hook decides: Copilot shows its own dialog only
//! once the hook has answered nothing, so while the hook waits the person
//! answers from the notch. `{"behavior": "allow"}` allows, and `"deny"`
//! with a `message` denies and tells the model why.
//!
//! What it does not tell: a turn the person interrupts (Ctrl+C) fires no
//! hook, so its thought stays working until the next prompt ends it as
//! interrupted or the session ends; and a turn that failed says so only in
//! its transcript (`session.error`), which the hook of its last error reads.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tasktap_proto::{
    Answer, Ask, Event, MAX_LINE, MAX_TEXT, QuestionKind, ReplyVia, Response, SessionEvent,
};

use super::rules::Rules;
use super::{
    Agent, Caps, Detect, Heard, Payload, Prompt, Run, WORDS, activity, digest, fit, line,
    permission, quoted, said,
};

pub struct Copilot;

#[rustfmt::skip]
pub const RULES: Rules = Rules {
    agent: "copilot",
    passthrough: &["app", "login", "help", "init", "config", "update", "version", "workflow",
        "sessions", "memories", "plugin", "mcp", "skill", "instruction", "lsp", "sandbox",
        "completion"],
    noninteractive: &["-p", "--prompt", "--prompt=", "--acp", "-v", "--connect", "--connect="],
    policy: &["--allow-all", "--yolo", "--allow-all-tools", "--allow-tool", "--allow-tool=",
        "--autopilot", "--mode", "--mode=", "--assisted-approval"],
    // Its own default stands: the approvals the person set.
    default: &[],
};

/// Seconds a hook that asked may wait for the person before Copilot gives
/// up on it and shows its own dialog.
pub const WAIT: u32 = 600;

/// The hook events a run reports, with the seconds Copilot lets each run.
const HOOKS: &[(&str, u32)] = &[
    ("sessionStart", 30),
    ("userPromptSubmitted", 30),
    ("preToolUse", 30),
    ("permissionRequest", WAIT),
    ("postToolUse", 30),
    ("postToolUseFailure", 30),
    ("agentStop", 30),
    ("errorOccurred", 30),
];

/// The plugin's folder below the agent's own.
const PLUGIN: &str = "plugin";

/// The tool with which Copilot asks the person.
const QUESTION: &str = "ask_user";

/// First characters with which its terminal takes a prompt for a command
/// of its own: `/` one of its commands, `!` a shell command run at once.
const COMMANDS: &str = "/!";

/// What stands before a prompt it would take for a command.
const LEAD: &str = "Task: ";

/// The lines of a transcript from its end back to the last prompt, as JSON.
fn since_prompt(transcript: &str) -> impl Iterator<Item = Value> + '_ {
    let rows = transcript.lines().rev();
    let rows = rows.filter_map(|row| serde_json::from_str::<Value>(row).ok());
    rows.take_while(|row| row["type"] != "user.message")
}

/// The end of a turn, from its transcript (`events.jsonl` of its session):
/// what the agent said last before the step that ran this hook. Every
/// step of the model ends in the transcript as a turn does, so the turn's
/// end is that step (`hook.start` of `agentStop` at the event's time): none
/// while it is not written yet. A turn that only used its tools ends with
/// no answer.
fn ended(event: &SessionEvent, transcript: &str) -> Option<SessionEvent> {
    let (_, at) = event.id.split_once(':')?;
    let at: u64 = at.parse().ok()?;
    let mut rows = since_prompt(transcript).skip_while(|row| {
        let input = &row["data"]["input"];
        !(row["type"] == "hook.start"
            && row["data"]["hookType"] == "agentStop"
            && input["timestamp"].as_u64() == Some(at))
    });
    rows.next()?;
    // A sub-agent's message is the sub-agent's.
    let said = rows.find_map(|row| {
        let data = &row["data"];
        let main = row["type"] == "assistant.message" && data["parentToolCallId"].is_null();
        let text = data["content"].as_str().unwrap_or_default().trim();
        (main && !text.is_empty()).then(|| fit(text, 512 << 10))
    });
    Some(SessionEvent {
        event: Event::TurnFinished { answer: said },
        ..event.clone()
    })
}

/// A turn that ended on its error: the transcript says so after the error's
/// last attempt (`session.error`). None while it tries again.
fn failed(event: &SessionEvent, transcript: &str) -> Option<SessionEvent> {
    let error = since_prompt(transcript).find(|row| row["type"] == "session.error")?;
    let why = error["data"]["message"].as_str().unwrap_or_default();
    let error = (!why.trim().is_empty()).then(|| fit(&line(why, 500), MAX_LINE));
    Some(SessionEvent {
        event: Event::TurnFailed { error },
        ..event.clone()
    })
}

impl Copilot {
    /// The id of `ask_user`'s call, which its question and its result share.
    fn asked(call: &str) -> String {
        format!("{QUESTION}:{call}")
    }

    /// The question `ask_user` asks, answered in the terminal: its message,
    /// and the choices its form offers, where it has any.
    fn question(request: String, input: Option<&Value>) -> Ask {
        let message = input.and_then(|i| i.get("message")?.as_str());
        let fields = input.and_then(|i| i.get("requestedSchema")?.get("properties")?.as_object());
        let choices: Vec<&str> = (fields.into_iter().flat_map(|f| f.values()))
            .filter_map(|field| field.get("enum")?.as_array())
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        Ask {
            request,
            kind: QuestionKind::Text,
            prompt: fit(message.unwrap_or("Copilot asks you something"), 2000),
            detail: (!choices.is_empty()).then(|| fit(&choices.join("\n"), 16 << 10)),
            source: None,
        }
    }
}

impl Agent for Copilot {
    fn id(&self) -> &'static str {
        "copilot"
    }

    fn name(&self) -> &'static str {
        "Copilot"
    }

    /// Not there yet: it runs a hook through PowerShell on Windows, where
    /// it was not run.
    fn supported(&self) -> bool {
        !cfg!(windows)
    }

    fn program(&self) -> &'static str {
        "copilot"
    }

    fn caps(&self) -> Caps {
        Caps {
            events: true,
            resume: true,
            permissions: Some(ReplyVia::Core),
            questions: Some(ReplyVia::Terminal),
        }
    }

    fn launch(&self, run: &Run) -> Vec<String> {
        let mut argv = vec![self.program().to_owned()];
        if let Some(model) = run.model {
            argv.extend(["--model".into(), model.into()]);
        }
        let attached = self.attach(run.hook, run.home).into_iter();
        argv.extend(attached.map(|a| a.to_string_lossy().into_owned()));
        if let Some(handle) = run.resume {
            argv.push(format!("--resume={handle}"));
        }
        let told = run.told(self);
        let told = match told.trim_start().starts_with(|c| COMMANDS.contains(c)) {
            true => format!("{LEAD}{told}"),
            false => told,
        };
        // One argument with its flag: a prompt that starts with `-` is no
        // option.
        argv.push(format!("--interactive={told}"));
        argv
    }

    fn attach(&self, _: &Path, home: &Path) -> Vec<OsString> {
        vec!["--plugin-dir".into(), home.join(PLUGIN).into()]
    }

    /// The plugin: its manifest and its hooks. The hook of an error is told
    /// where Copilot keeps its sessions, as the shell it runs in knows it.
    fn files(&self, exe: &Path) -> Vec<(&'static str, String)> {
        let hooks: serde_json::Map<String, Value> = (HOOKS.iter())
            .map(|(event, timeout)| {
                let home = match *event {
                    "errorOccurred" => r#" "${COPILOT_HOME:-$HOME/.copilot}""#,
                    _ => "",
                };
                let command = format!("{} hook copilot {event}{home} || true", quoted(exe));
                let hook = json!({ "type": "command", "bash": command, "timeoutSec": timeout });
                ((*event).to_owned(), json!([hook]))
            })
            .collect();
        let manifest = json!({
            "name": "tasktap",
            "version": "1.0.0",
            "description": "Tells Tasktap what a run it started is doing.",
        });
        vec![
            ("plugin/plugin.json", format!("{manifest:#}\n")),
            (
                "plugin/hooks/hooks.json",
                format!("{:#}\n", json!({ "version": 1, "hooks": hooks })),
            ),
        ]
    }

    fn detect(&self) -> Detect {
        Detect {
            // "GitHub Copilot CLI 1.0.114."
            version: &["--version"],
            version_of: |out| {
                let line = out.lines().find(|l| l.contains("Copilot CLI"))?;
                let version = line.split_whitespace().last()?.trim_end_matches('.');
                Some(version.to_owned())
            },
            // It has no command that says whether it is signed in.
            account: &[],
            account_of: |_, _| (None, None),
        }
    }

    fn told(&self, brief: &str, words: &str) -> String {
        format!("{brief}\n\n---\n{WORDS}\n\n{words}")
    }

    /// Its sign-in, where it is not in the system's keychain, and its own
    /// endpoint for a person who runs it on their own models.
    #[rustfmt::skip]
    fn variables(&self) -> &'static [&'static str] {
        &[
            "COPILOT_HOME", "COPILOT_CACHE_HOME", "COPILOT_GITHUB_TOKEN", "GH_TOKEN",
            "GITHUB_TOKEN", "GH_HOST", "COPILOT_GH_HOST", "COPILOT_MODEL", "COPILOT_OFFLINE",
            "COPILOT_AUTO_UPDATE", "COPILOT_PROVIDERS_CONFIG", "COPILOT_PROVIDER_BASE_URL",
            "COPILOT_PROVIDER_TYPE", "COPILOT_PROVIDER_API_KEY", "COPILOT_PROVIDER_BEARER_TOKEN",
            "COPILOT_PROVIDER_WIRE_API", "COPILOT_PROVIDER_MODEL_ID", "COPILOT_PROVIDER_WIRE_MODEL",
        ]
    }

    /// It asks whether to trust every folder it has not been told is
    /// trusted for good, and so every copy of the project a thought runs in
    /// alone, which is a new folder each time. Neither its `--help` (1.0.83)
    /// nor its documentation ("Configuring GitHub Copilot CLI", 2026-11)
    /// names a flag or a variable that trusts a folder for one interactive
    /// run: only the `trustedFolders` list in its own `config.json`, which
    /// is the person's and which Tasktap does not write, and `COPILOT_HOME`,
    /// which would move their sign-in and sessions with it. So its row in
    /// Settings says so.
    fn note(&self) -> Option<&'static str> {
        Some(
            "Copilot asks to trust each copy of the project a task runs in: \
             Copilot has no way to be told so for one run, and Tasktap leaves its settings as they are.",
        )
    }

    /// What it stops at in its terminal before any hook runs: a folder it
    /// does not trust (it has no way to trust one for one interactive run:
    /// `note`), and, signed out, its notice, after which it drops the
    /// prompt.
    fn prompts(&self) -> &'static [Prompt] {
        &[
            Prompt {
                shows: "Do you trust the files in this folder?",
                asks: "Copilot is asking whether to trust this folder",
            },
            Prompt {
                shows: "Please use /login to sign in to use Copilot",
                asks: "Copilot is asking you to sign in",
            },
        ]
    }

    fn event(&self, args: &[String], payload: &[u8]) -> Result<Option<Heard>, String> {
        let p = Payload::parse(payload)?;
        let Some(name) = args.first().map(String::as_str) else {
            return Ok(None);
        };
        let resume = p.str("sessionId");
        // The time in milliseconds every payload has; a payload without it
        // is told apart by its content.
        let at = p.get("timestamp").filter(|t| t.is_number());
        let at = at.map_or_else(|| digest(&[payload]), Value::to_string);
        let own = format!("{name}:{at}");
        let tool = p.str("toolName").unwrap_or_default();
        let call = p.str("toolCallId").map(Into::into);
        let call = call.unwrap_or_else(|| digest(&[payload]));
        let heard = match name {
            "sessionStart" => said(own, false, resume, Event::Ready),
            "userPromptSubmitted" => {
                let prompt = p.str("prompt").map(|t| fit(t, MAX_TEXT));
                said(own, false, resume, Event::TurnStarted { prompt })
            }
            "preToolUse" if tool == QUESTION => {
                let ask = Self::question(Self::asked(&call), p.get("toolArgs"));
                said(
                    Self::asked(&call),
                    false,
                    resume,
                    Event::Question { question: ask },
                )
            }
            "preToolUse" => {
                let text = activity(tool, p.get("toolArgs"));
                said(
                    format!("{name}:{call}"),
                    false,
                    resume,
                    Event::Activity { text },
                )
            }
            "postToolUse" | "postToolUseFailure" if tool == QUESTION => {
                let request = Some(Self::asked(&call));
                said(
                    format!("{name}:{call}"),
                    false,
                    resume,
                    Event::Continued { request },
                )
            }
            "permissionRequest" => {
                let input = p.get("toolInput");
                let what = input.map(Value::to_string).unwrap_or_default();
                let request = format!("{own}:{}", digest(&[tool.as_bytes(), what.as_bytes()]));
                Heard::Wait(permission(self.name(), request, tool, input))
            }
            "agentStop" => {
                let Heard::Event(event) =
                    said(own, false, resume, Event::TurnFinished { answer: None })
                else {
                    return Ok(None);
                };
                let files = p.str("transcriptPath").map(PathBuf::from);
                let files = files.into_iter().collect();
                Heard::Read {
                    event,
                    files,
                    fill: ended,
                }
            }
            "errorOccurred" => {
                let error = p.get("error").and_then(|e| e.get("message")?.as_str());
                let text = line(&format!("Error: {}", error.unwrap_or("unknown")), 200);
                let Heard::Event(event) = said(own, false, resume, Event::Activity { text }) else {
                    return Ok(None);
                };
                // Its session's transcript, below the folder the hook's
                // second argument names.
                let transcript = (args.get(1).zip(resume)).map(|(home, session)| {
                    Path::new(home)
                        .join("session-state")
                        .join(session)
                        .join("events.jsonl")
                });
                Heard::Read {
                    event,
                    files: transcript.into_iter().collect(),
                    fill: failed,
                }
            }
            _ => return Ok(None),
        };
        Ok(Some(heard))
    }

    /// What a waiting `permissionRequest` hook prints.
    fn reply(&self, args: &[String], _: &[u8], answer: &Answer) -> Option<String> {
        if args.first().map(String::as_str) != Some("permissionRequest") {
            return None;
        }
        let deny = |message: &str| json!({ "behavior": "deny", "message": message });
        let decision = match &answer.response {
            Response::Affirm => json!({ "behavior": "allow" }),
            Response::Deny => deny("The person denied this in Tasktap."),
            // "No, and tell Copilot what to do differently".
            Response::Text { text } => deny(text),
            Response::Choice { .. } | Response::Terminal => return None,
        };
        Some(decision.to_string())
    }
}
