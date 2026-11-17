//! Claude Code (design §7), as `claude` 2.1 runs it.
//!
//! A run gets its hooks through `--settings` as JSON, so nothing is written
//! to the person's own settings, the session id is ours (`--session-id`),
//! and the approval policy is `--permission-mode auto`, as 1.2 had it. Its
//! hooks run `<exe> hook claude` with the payload on standard input.
//!
//! | Hook | Heard |
//! | --- | --- |
//! | `SessionStart` | `ready` |
//! | `UserPromptSubmit` | `turn_started` with the prompt |
//! | `PreToolUse` | `activity`, the tool and what it does |
//! | `PermissionRequest` | a permission request: a confirm question the hook waits on |
//! | `PermissionRequest` of `AskUserQuestion` | its one question, with its options as choices, waited on; with several questions or many answers, a question answered in the terminal |
//! | `PostToolUse` of `AskUserQuestion` | `continued` |
//! | `Notification` `elicitation_dialog` | a question answered in the terminal |
//! | `Stop` | `turn_finished` with the last message |
//! | `StopFailure` | `turn_failed` with the error |
//!
//! Each event's id is the hook's name with the prompt id Claude Code gives
//! every hook of a turn, and the tool call's id where there is one, so a
//! repeat is ignored. Claude Code numbers no turns, so none is sent. A
//! payload with `agent_id` comes from a sub-agent. Every payload carries
//! the session id, the handle `--resume` takes.
//!
//! A `PermissionRequest` hook may decide (the trial of design §14 D): Claude
//! Code shows its own dialog in the terminal meanwhile, and the first answer,
//! the person's in the terminal or the hook's, is taken. The hook allows or
//! denies with `hookSpecificOutput.decision`, and answers `AskUserQuestion`
//! by allowing it with its input and `answers`, the question's text mapped
//! to the chosen option's label or to the text given.

use std::ffi::OsString;
use std::path::Path;

use serde_json::{Value, json};
use tasktap_proto::{Answer, Ask, Event, MAX_LINE, MAX_TEXT, QuestionKind, ReplyVia, Response};

use super::rules::Rules;
use super::{
    Agent, Caps, Detect, Heard, Payload, Run, activity, digest, fit, line, permission, quoted, said,
};

pub struct Claude;

#[rustfmt::skip]
pub const RULES: Rules = Rules {
    agent: "claude",
    passthrough: &["auth", "doctor", "install", "mcp", "plugin", "plugins", "setup-token",
        "update", "upgrade", "help"],
    noninteractive: &["-p"],
    policy: &["--permission-mode", "--dangerously-skip-permissions", "--permission-prompt-tool"],
    default: &["--permission-mode", "auto"],
};

/// Seconds a hook that asked may wait for the person before Claude Code
/// gives up on it and leaves the answer to its own dialog.
pub const WAIT: u32 = 600;

/// The hook events a run reports, with the seconds Claude Code lets each run.
const HOOKS: &[(&str, u32)] = &[
    ("SessionStart", 30),
    ("UserPromptSubmit", 30),
    ("PreToolUse", 30),
    ("PostToolUse", 30),
    ("PermissionRequest", WAIT),
    ("Notification", 30),
    ("Stop", 30),
    ("StopFailure", 30),
];

/// The tool with which Claude Code asks the person.
const QUESTION: &str = "AskUserQuestion";

impl Claude {
    /// `--settings` with the hooks.
    fn settings(exe: &Path) -> String {
        let command = format!("{} hook claude", quoted(exe));
        let hooks: serde_json::Map<String, Value> = (HOOKS.iter())
            .map(|(name, timeout)| {
                let hook = json!({ "type": "command", "command": command, "timeout": timeout });
                ((*name).to_owned(), json!([{ "hooks": [hook] }]))
            })
            .collect();
        json!({ "hooks": hooks }).to_string()
    }

    /// The question `AskUserQuestion` asks, when the hook can wait on it:
    /// one question with one answer.
    fn question(input: Option<&Value>) -> Option<(&str, Vec<String>)> {
        let [question] = input?.get("questions")?.as_array()?.as_slice() else {
            return None;
        };
        if question.get("multiSelect") == Some(&Value::Bool(true)) {
            return None;
        }
        let text = question.get("question")?.as_str()?;
        let labels = (question.get("options")?.as_array()?.iter())
            .filter_map(|o| Some(o.get("label")?.as_str()?.to_owned()))
            .collect();
        Some((text, labels))
    }

    /// The key of an `AskUserQuestion` call: its turn and its questions,
    /// which its permission request and its result both carry.
    fn request(turn: &str, input: Option<&Value>) -> String {
        let questions = input.and_then(|i| i.get("questions"));
        let questions = questions.map(Value::to_string).unwrap_or_default();
        format!("{QUESTION}:{turn}:{}", digest(&[questions.as_bytes()]))
    }

    /// `AskUserQuestion` heard through its permission request.
    fn asked(request: String, input: Option<&Value>) -> Result<Ask, Ask> {
        match Self::question(input) {
            Some((text, labels)) => {
                let detail = (input.and_then(|i| i["questions"][0]["options"].as_array()))
                    .map(|options| {
                        let lines = options.iter().filter_map(|o| {
                            let label = o.get("label")?.as_str()?;
                            let about = o.get("description").and_then(Value::as_str);
                            Some(about.map_or(label.into(), |a| format!("{label}: {a}")))
                        });
                        lines.collect::<Vec<_>>().join("\n")
                    })
                    .filter(|d| !d.is_empty());
                let kind = match labels.is_empty() {
                    true => QuestionKind::Text,
                    false => QuestionKind::Choice {
                        choices: labels.iter().map(|l| fit(l, 200)).collect(),
                    },
                };
                Ok(Ask {
                    request,
                    kind,
                    prompt: fit(text, 2000),
                    detail: detail.map(|d| fit(&d, 16 << 10)),
                })
            }
            None => {
                let texts: Vec<&str> = (input.and_then(|i| i.get("questions")?.as_array()))
                    .into_iter()
                    .flatten()
                    .filter_map(|q| q.get("question")?.as_str())
                    .collect();
                let prompt = texts
                    .first()
                    .copied()
                    .unwrap_or("Claude Code asks you something");
                Err(Ask {
                    request,
                    kind: QuestionKind::Text,
                    prompt: fit(prompt, 2000),
                    detail: (texts.len() > 1).then(|| fit(&texts.join("\n"), 16 << 10)),
                })
            }
        }
    }
}

impl Agent for Claude {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn program(&self) -> &'static str {
        "claude"
    }

    fn caps(&self) -> Caps {
        Caps {
            events: true,
            resume: true,
            permissions: Some(ReplyVia::Core),
            questions: Some(ReplyVia::Core),
        }
    }

    fn launch(&self, run: &Run) -> Vec<String> {
        let mut argv = vec![self.program().to_owned()];
        // As 1.2: a resumed conversation keeps its model.
        if let (Some(model), None) = (run.model, run.resume) {
            argv.extend(["--model".into(), model.into()]);
        }
        let attached = self.attach(run.hook).into_iter();
        argv.extend(attached.map(|a| a.to_string_lossy().into_owned()));
        match run.resume {
            Some(handle) => argv.extend(["--resume".into(), handle.into()]),
            None => argv.extend(["--session-id".into(), run.session.uuid().to_string()]),
        }
        argv.extend(RULES.default.iter().map(|a| (*a).to_owned()));
        argv.extend(["--".into(), run.prompt.to_owned()]);
        argv
    }

    fn attach(&self, exe: &Path) -> Vec<OsString> {
        vec!["--settings".into(), Self::settings(exe).into()]
    }

    fn detect(&self) -> Detect {
        Detect {
            // "2.1.326 (Claude Code)"
            version: &["--version"],
            version_of: |out| out.split_whitespace().next().map(Into::into),
            account: &["auth", "status", "--json"],
            account_of: |code, out| match serde_json::from_str::<Value>(out.trim()) {
                Ok(status) => {
                    let signed_in = status.get("loggedIn").and_then(Value::as_bool);
                    let who = ["email", "authMethod", "apiProvider"]
                        .iter()
                        .find_map(|key| status.get(key)?.as_str().filter(|s| !s.is_empty()));
                    (signed_in, signed_in.filter(|s| *s).and(who.map(Into::into)))
                }
                // Older versions print no JSON: only a failure says anything.
                Err(_) => ((code.is_some() && code != Some(0)).then_some(false), None),
            },
        }
    }

    fn event(&self, _: &[String], payload: &[u8]) -> Result<Option<Heard>, String> {
        let p = Payload::parse(payload)?;
        let Some(name) = p.str("hook_event_name") else {
            return Ok(None);
        };
        let subagent = p.str("agent_id").is_some();
        let resume = p.str("session_id");
        // The turn's id; a payload without one is told apart by its content.
        let turn = p.str("prompt_id").map(Into::into);
        let turn = turn.unwrap_or_else(|| digest(&[payload]));
        let tool = p.str("tool_name").unwrap_or_default();
        let input = p.get("tool_input");
        let call = p.str("tool_use_id").unwrap_or_default();
        let heard = match name {
            "SessionStart" => {
                let source = p.str("source").unwrap_or("startup");
                let id = format!("{name}:{}:{source}", resume.unwrap_or_default());
                said(id, subagent, resume, Event::Ready)
            }
            "UserPromptSubmit" => {
                let prompt = p.str("prompt").map(|t| fit(t, MAX_TEXT));
                let id = format!("{name}:{turn}");
                said(id, subagent, resume, Event::TurnStarted { prompt })
            }
            // Its permission request asks.
            "PreToolUse" if tool == QUESTION => return Ok(None),
            "PreToolUse" => {
                let text = activity(tool, input);
                said(
                    format!("{name}:{call}"),
                    subagent,
                    resume,
                    Event::Activity { text },
                )
            }
            // Answered, in the terminal or through its hook: a hook that
            // still waits on it is told it was answered in the terminal.
            "PostToolUse" if tool == QUESTION => {
                let request = Some(Self::request(&turn, input));
                said(
                    format!("{name}:{call}"),
                    subagent,
                    resume,
                    Event::Continued { request },
                )
            }
            "PermissionRequest" if tool == QUESTION => {
                let request = Self::request(&turn, input);
                match Self::asked(request.clone(), input) {
                    Ok(ask) => Heard::Wait(ask),
                    Err(ask) => {
                        let event = Event::Question { question: ask };
                        said(request, subagent, resume, event)
                    }
                }
            }
            "PermissionRequest" => {
                let what = input.map(Value::to_string).unwrap_or_default();
                let what = digest(&[tool.as_bytes(), what.as_bytes()]);
                let request = format!("{name}:{turn}:{what}");
                Heard::Wait(permission("Claude Code", request, tool, input))
            }
            "Notification" if p.str("notification_type") == Some("elicitation_dialog") => {
                let message = p.str("message").unwrap_or("An MCP server asks for input");
                let request = format!("elicitation:{turn}:{}", digest(&[message.as_bytes()]));
                let ask = Ask {
                    request: request.clone(),
                    kind: QuestionKind::Text,
                    prompt: fit(message, 2000),
                    detail: None,
                };
                said(request, subagent, resume, Event::Question { question: ask })
            }
            "Stop" => {
                let answer = p.str("last_assistant_message").map(|a| fit(a, 512 << 10));
                said(
                    format!("{name}:{turn}"),
                    subagent,
                    resume,
                    Event::TurnFinished { answer },
                )
            }
            "StopFailure" => {
                let error = ["error_details", "error"]
                    .iter()
                    .find_map(|key| match p.get(key)? {
                        Value::String(s) => Some(s.clone()),
                        Value::Null => None,
                        other => Some(other.to_string()),
                    })
                    .map(|e| fit(&line(&e, 500), MAX_LINE));
                said(
                    format!("{name}:{turn}"),
                    subagent,
                    resume,
                    Event::TurnFailed { error },
                )
            }
            _ => return Ok(None),
        };
        Ok(Some(heard))
    }

    fn reply(&self, _: &[String], payload: &[u8], answer: &Answer) -> Option<String> {
        let p = Payload::parse(payload).ok()?;
        if p.str("hook_event_name") != Some("PermissionRequest") {
            return None;
        }
        let input = p.get("tool_input");
        let deny = |message: &str| json!({ "behavior": "deny", "message": message });
        let decision = if p.str("tool_name") == Some(QUESTION) {
            let (question, labels) = Self::question(input)?;
            let said = match &answer.response {
                Response::Choice { choice } => labels.get(*choice as usize)?.clone(),
                Response::Text { text } => text.clone(),
                Response::Deny => return Some(output(deny("The person chose not to answer."))),
                Response::Affirm | Response::Terminal => return None,
            };
            let mut updated = input.cloned().unwrap_or_else(|| json!({}));
            updated["answers"] = json!({ question: said });
            json!({ "behavior": "allow", "updatedInput": updated })
        } else {
            match &answer.response {
                Response::Affirm => json!({ "behavior": "allow" }),
                Response::Deny => deny("The person denied this in Tasktap."),
                // "No, and tell Claude what to do differently".
                Response::Text { text } => deny(text),
                Response::Choice { .. } | Response::Terminal => return None,
            }
        };
        Some(output(decision))
    }
}

fn output(decision: Value) -> String {
    json!({
        "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision }
    })
    .to_string()
}
