//! Cursor (design §7), its command line agent `cursor-agent`, as 2026.09.28
//! is built. NOT yet run signed in: on the computer it was written on the
//! tool was signed out, so what follows is read from the tool's own code
//! and from what it does signed out, and no payload here was recorded from
//! a turn.
//!
//! It reads hooks from the person's `~/.cursor/hooks.json` and from the
//! project's `.cursor/hooks.json`, neither of which Tasktap writes, and
//! from plugins. A run is given a plugin of Tasktap's own, a folder below
//! its folder in the data folder ([`Agent::files`]), with `--plugin-dir`:
//! its `hooks/hooks.json` has the tool run `<exe> hook cursor-agent` with
//! the payload on standard input.
//!
//! | Hook | Heard |
//! | --- | --- |
//! | `sessionStart` | `ready` (a new chat only: a resumed one runs none) |
//! | `beforeSubmitPrompt` | `turn_started` with the prompt |
//! | `preToolUse` | `activity`, the tool and what it does |
//! | `stop`, `completed` | `turn_finished` with the last message, read from the transcript |
//! | `stop`, `aborted` | `turn_interrupted` |
//! | `stop`, `error` | `turn_failed` |
//!
//! Each event's id is the hook's name with the id Cursor gives the request
//! (`generation_id`) or the tool call, so a repeat is ignored. The chat's id
//! (`conversation_id`) is the handle `--resume` takes; it is taken from the
//! three hooks the terminal itself runs, not from a tool's, which a
//! sub-agent's may run under an id of its own. A tool's payload with
//! `parent_tool_call_id` comes from a sub-agent.
//!
//! `stop` carries no text. The transcript Cursor keeps is named in the
//! payload once the file exists, one JSON object to a line, and the hook
//! reads its end ([`Heard::Read`]).
//!
//! Nothing it asks is heard. No hook runs when it waits for an approval:
//! `beforeShellExecution` runs before every command, before Cursor has
//! decided whether to ask, its `allow` does not approve (Cursor still asks
//! where it would have) and its `ask` only forces the question in the
//! terminal; only `deny` decides. So a waiting hook could not answer as the
//! tool would have, and none waits.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tasktap_proto::{Answer, Event, MAX_TEXT, SessionEvent};

use super::rules::Rules;
use super::{Agent, Caps, Detect, Heard, Payload, Prompt, Run, WORDS, activity, digest, fit, said};

pub struct Cursor;

#[rustfmt::skip]
pub const RULES: Rules = Rules {
    agent: "cursor-agent",
    passthrough: &["about", "acp", "bedrock", "create-chat", "generate-rule", "help",
        "install-shell-integration", "login", "logout", "mcp", "models", "persist", "plugin",
        "rule", "status", "team", "uninstall-shell-integration", "update", "whoami", "worker"],
    noninteractive: &["-p", "-v", "--list-models"],
    policy: &["-f", "--force", "--yolo", "--auto-review"],
    // Its own default stands: the approval mode the person set.
    default: &[],
};

/// The hook events a run reports, with the seconds Cursor lets each run.
const HOOKS: &[(&str, u32)] = &[
    ("sessionStart", 30),
    ("beforeSubmitPrompt", 30),
    ("preToolUse", 30),
    ("stop", 30),
];

/// The plugin's folder below the agent's own.
const PLUGIN: &str = "plugin";

/// The last thing it said since the person's prompt, from the end of its
/// transcript; none while that is not written yet.
fn fill(heard: &SessionEvent, transcript: &str) -> Option<SessionEvent> {
    let lines = transcript.lines().rev();
    let lines = lines.filter_map(|l| serde_json::from_str::<Value>(l).ok());
    let turn = lines.take_while(|l| l["role"] != "user");
    let mut said = turn.filter(|l| l["role"] == "assistant").map(|l| {
        let parts = l["message"]["content"].as_array().cloned();
        let texts = parts.into_iter().flatten();
        let texts = texts.filter_map(|p| Some(p.get("text")?.as_str()?.trim().to_owned()));
        texts.collect::<Vec<_>>().join("\n")
    });
    let last = said.find(|text| !text.is_empty())?;
    let mut heard = heard.clone();
    heard.event = Event::TurnFinished {
        answer: Some(fit(&last, 512 << 10)),
    };
    Some(heard)
}

impl Agent for Cursor {
    fn id(&self) -> &'static str {
        "cursor-agent"
    }

    fn name(&self) -> &'static str {
        "Cursor"
    }

    /// Cursor runs a hook command through a shell of its own choosing,
    /// PowerShell on Windows, where it could not be tried: there it is
    /// listed and says that it does not run yet.
    fn supported(&self) -> bool {
        !cfg!(windows)
    }

    fn program(&self) -> &'static str {
        "cursor-agent"
    }

    /// What it asks, an approval or a question, no hook hears: it asks in
    /// its terminal and the thought shows what it last did.
    fn caps(&self) -> Caps {
        Caps {
            events: true,
            resume: true,
            permissions: None,
            questions: None,
        }
    }

    fn launch(&self, run: &Run) -> Vec<String> {
        let mut argv = vec![self.program().to_owned()];
        // Also for a resume: nothing says a chat keeps the model it had.
        if let Some(model) = run.model {
            argv.extend(["--model".into(), model.into()]);
        }
        let attached = self.attach(run.hook, run.home).into_iter();
        argv.extend(attached.map(|a| a.to_string_lossy().into_owned()));
        if let Some(handle) = run.resume {
            argv.extend(["--resume".into(), handle.into()]);
        }
        // A prompt that is one word would be read as a subcommand of that
        // name (`update`, `logout`), also after `--`: a line break after it
        // makes it none.
        let mut told = run.told(self);
        if !told.trim().contains(char::is_whitespace) {
            told.push('\n');
        }
        argv.extend(["--".into(), told]);
        argv
    }

    fn attach(&self, _: &Path, home: &Path) -> Vec<OsString> {
        vec!["--plugin-dir".into(), home.join(PLUGIN).into()]
    }

    /// The plugin: its manifest and its hooks.
    fn files(&self, exe: &Path) -> Vec<(&'static str, String)> {
        let command = format!("{} hook cursor-agent", super::quoted(exe));
        let hooks: serde_json::Map<String, Value> = (HOOKS.iter())
            .map(|(name, timeout)| {
                let hook = json!({ "command": command, "timeout": timeout });
                ((*name).to_owned(), json!([hook]))
            })
            .collect();
        let manifest = json!({
            "name": "tasktap",
            "version": "1.0.0",
            "description": "Tells Tasktap what a run it started is doing.",
        });
        vec![
            (
                "plugin/.cursor-plugin/plugin.json",
                format!("{manifest:#}\n"),
            ),
            (
                "plugin/hooks/hooks.json",
                format!("{:#}\n", json!({ "version": 1, "hooks": hooks })),
            ),
        ]
    }

    /// The person's words after a rule, as Codex is told them.
    fn told(&self, brief: &str, words: &str) -> String {
        format!("{brief}\n\n---\n{WORDS}\n\n{words}")
    }

    /// Its sign-in is in the system's keyring; a key signs in the one who
    /// set it.
    fn variables(&self) -> &'static [&'static str] {
        &["CURSOR_API_KEY"]
    }

    /// What it stops at before any hook runs. Signed out, its first screen
    /// (recorded). In a folder it does not trust, its trust dialog (its
    /// words read from its code, not seen): it has a flag that trusts a
    /// folder, `--trust`, but that writes the trust down for good, so a run
    /// is not given it and the person answers.
    fn prompts(&self) -> &'static [Prompt] {
        &[
            Prompt {
                shows: "Press any key to log in...",
                asks: "Cursor is asking you to sign in",
            },
            Prompt {
                shows: "Do you trust the contents of this directory?",
                asks: "Cursor is asking whether to trust this folder",
            },
        ]
    }

    fn detect(&self) -> Detect {
        Detect {
            // "2026.09.28-64d2043"
            version: &["--version"],
            version_of: |out| out.split_whitespace().next().map(Into::into),
            // One JSON object: `isAuthenticated`, and `userInfo.email` when
            // its servers said who.
            account: &["status", "--format", "json"],
            account_of: |_, out| match serde_json::from_str::<Value>(out.trim()) {
                Ok(status) => {
                    let signed_in = status.get("isAuthenticated").and_then(Value::as_bool);
                    let who = status
                        .get("userInfo")
                        .and_then(|u| u.get("email")?.as_str());
                    let who = who.filter(|w| !w.is_empty()).map(Into::into);
                    (signed_in, signed_in.filter(|s| *s).and(who))
                }
                Err(_) => (None, None),
            },
        }
    }

    fn event(&self, _: &[String], payload: &[u8]) -> Result<Option<Heard>, String> {
        let p = Payload::parse(payload)?;
        let Some(name) = p.str("hook_event_name") else {
            return Ok(None);
        };
        let resume = p.str("conversation_id");
        // The request's id; a payload without one is told apart by its content.
        let turn = p.str("generation_id").map(Into::into);
        let turn = turn.unwrap_or_else(|| digest(&[payload]));
        let heard = match name {
            "sessionStart" => {
                let id = format!("{name}:{}", resume.unwrap_or_default());
                said(id, false, resume, Event::Ready)
            }
            "beforeSubmitPrompt" => {
                let prompt = p.str("prompt").map(|t| fit(t, MAX_TEXT));
                let id = format!("{name}:{turn}");
                said(id, false, resume, Event::TurnStarted { prompt })
            }
            "preToolUse" => {
                let tool = p.str("tool_name").unwrap_or_default();
                let text = activity(tool, p.get("tool_input"));
                let call = p.str("tool_use_id").map(Into::into);
                let call = call.unwrap_or_else(|| digest(&[payload]));
                let subagent = p.str("parent_tool_call_id").is_some();
                said(
                    format!("{name}:{call}"),
                    subagent,
                    None,
                    Event::Activity { text },
                )
            }
            "stop" => {
                // A follow-up another hook of the person's has it go on with
                // ends again under the same request: its count tells them apart.
                let again = p.get("loop_count").and_then(Value::as_u64).unwrap_or(0);
                let id = format!("{name}:{turn}:{again}");
                match p.str("status") {
                    Some("aborted") => said(id, false, resume, Event::TurnInterrupted),
                    Some("error") => said(id, false, resume, Event::TurnFailed { error: None }),
                    _ => match said(id, false, resume, Event::TurnFinished { answer: None }) {
                        Heard::Event(event) => Heard::Read {
                            event,
                            files: p
                                .str("transcript_path")
                                .map(PathBuf::from)
                                .into_iter()
                                .collect(),
                            fill,
                        },
                        other => other,
                    },
                }
            }
            _ => return Ok(None),
        };
        Ok(Some(heard))
    }

    /// Nothing it asks is answered through a hook.
    fn reply(&self, _: &[String], _: &[u8], _: &Answer) -> Option<String> {
        None
    }
}
