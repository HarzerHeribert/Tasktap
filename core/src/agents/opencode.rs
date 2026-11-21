//! OpenCode (design §7), as `opencode` 2.3 runs it.
//!
//! Its terminal interface is a client of a server of its own, and takes
//! plugins that run inside it. A run is given one of Tasktap's: a file in
//! Tasktap's folder for this agent ([`Agent::files`]), named for that run
//! alone by `OPENCODE_CLI_CONFIG_CONTENT` ([`Agent::environment`]), which
//! OpenCode lays over the person's own `cli.json` without writing it. The
//! plugin hears the server's events for the session on screen and runs
//! `<exe> hook opencode` with each that counts on standard input, as the
//! server sent it, with what that event leaves out: the tool's name and
//! the last text said.
//!
//! | Event | Heard |
//! | --- | --- |
//! | the plugin is set up | `ready` |
//! | `session.inbox.enqueued` of what a person told it | `turn_started` with the prompt |
//! | `session.execution.started` | `turn_started` without a prompt: the turn that prompt opened goes on, or one starts by itself, as when a sub-agent is done |
//! | `session.tool.called` | `activity`, the tool and what it does |
//! | `permission.asked` | a permission request: a confirm question the hook waits on |
//! | `form.created` | its one question, with its options as choices, waited on; with several questions or many answers, a question answered in the terminal |
//! | `permission.replied`, `form.replied`, `form.cancelled` | `continued` |
//! | `session.execution.succeeded` | `turn_finished` with the last text |
//! | `session.execution.failed` | `turn_failed` with the error |
//! | `session.execution.interrupted` | `turn_interrupted`; nothing when a new prompt took its place, which has said so |
//!
//! Each event's id is the one the server gave it, and the session's id is
//! the handle `--session` takes. A sub-agent is a session of its own, whose
//! events the plugin leaves out: what it asks, it asks in the terminal.
//!
//! The hook of an approval or a question waits, and the plugin gives what
//! it prints to the server as the terminal's own dialog would
//! (`permission.reply`, `form.reply`, `form.cancel`): the dialog is on
//! screen meanwhile, and the first answer, there or in Tasktap, is taken.
//!
//! A run the core starts has a server of its own (`--standalone`), which
//! ends with its terminal: on the background service the interface uses
//! otherwise, a turn goes on after its terminal is gone. An `opencode`
//! typed by hand keeps the server the person chose.

use std::ffi::OsString;
use std::path::Path;

use serde_json::{Value, json};
use tasktap_proto::{Answer, Ask, Event, MAX_LINE, MAX_TEXT, QuestionKind, ReplyVia, Response};

use super::rules::Rules;
use super::{
    Agent, Caps, Detect, Heard, Payload, Run, WORDS, activity, fit, line, permission, said,
};

pub struct OpenCode;

#[rustfmt::skip]
pub const RULES: Rules = Rules {
    agent: "opencode",
    // `mini` is another interface, which takes no plugin of this kind.
    passthrough: &["acp", "api", "auth", "debug", "mcp", "mini", "models", "pair", "plugin",
        "reload", "run", "serve", "service", "session", "stats", "uninstall", "update", "upgrade"],
    noninteractive: &["-v", "--completions", "--completions=", "--wizard"],
    policy: &["--auto"],
    // Its own default stands: the permissions the person configured.
    default: &[],
};

/// The plugin, with a placeholder where this program's path goes.
const PLUGIN: &str = include_str!("opencode.js");

/// Where the plugin is, below the agent's folder: a folder, since OpenCode
/// passes over a single file, with the part its terminal interface loads.
const FOLDER: &str = "plugin";

/// The tool with which it asks the person; its form is what asks.
const QUESTION: &str = "question";

/// The fields of a form a person fills in.
fn fields(form: &Value) -> Vec<&Value> {
    let all = form.get("fields").and_then(Value::as_array);
    let shown = |f: &&Value| f.get("hidden") != Some(&Value::Bool(true));
    all.into_iter().flatten().filter(shown).collect()
}

/// The field of a form the hook can wait on, with its key: its only one,
/// when that is a yes or no, or a text, which may have options.
fn field(form: &Value) -> Option<(&str, &Value)> {
    let [only] = fields(form)[..] else {
        return None;
    };
    let kind = only.get("type")?.as_str()?;
    matches!(kind, "string" | "boolean").then_some((only.get("key")?.as_str()?, only))
}

/// The options of a field.
fn options(field: &Value) -> impl Iterator<Item = &Value> {
    let options = field.get("options").and_then(Value::as_array);
    options.into_iter().flatten()
}

/// A form as a question: one the hook waits on, or, with several fields or
/// a field of many answers, one answered in the terminal.
fn asked(request: String, form: &Value) -> Result<Ask, Ask> {
    let text = |value: &Value, key: &str| {
        let text = value.get(key)?.as_str()?.trim();
        (!text.is_empty()).then(|| text.to_owned())
    };
    let question = |f: &&Value| text(f, "description").or_else(|| text(f, "title"));
    let all: Vec<String> = fields(form).iter().filter_map(question).collect();
    let prompt = (all.first().cloned())
        .or_else(|| text(form, "title"))
        .unwrap_or_else(|| "OpenCode asks you something".into());
    let ask = |kind, detail: Option<String>| Ask {
        request: request.clone(),
        kind,
        prompt: fit(&prompt, 2000),
        detail: detail.map(|d| fit(&d, 16 << 10)),
        source: None,
    };
    let Some((_, field)) = field(form) else {
        let detail = (all.len() > 1).then(|| all.join("\n"));
        return Err(ask(QuestionKind::Text, detail));
    };
    let label = |o: &Value| text(o, "label").or_else(|| text(o, "value"));
    let choices: Vec<String> = options(field).filter_map(label).collect();
    // What each option means, where it says more than its label.
    let about = options(field).filter_map(|o| {
        let (label, about) = (label(o)?, text(o, "description")?);
        (about != label).then(|| format!("{label}: {about}"))
    });
    let about = about.collect::<Vec<_>>().join("\n");
    let kind = match field["type"] == "boolean" {
        true => QuestionKind::Confirm,
        false if choices.is_empty() => QuestionKind::Text,
        false => QuestionKind::Choice {
            choices: choices.iter().map(|c| fit(c, 200)).collect(),
        },
    };
    Ok(ask(kind, (!about.is_empty()).then_some(about)))
}

impl Agent for OpenCode {
    fn id(&self) -> &'static str {
        "opencode"
    }

    fn name(&self) -> &'static str {
        "OpenCode"
    }

    fn program(&self) -> &'static str {
        "opencode"
    }

    /// The session it continues and where the task goes.
    fn refused(&self) -> &'static [&'static str] {
        &["--session", "--prompt"]
    }

    /// Not there yet: nothing of it has been run on Windows.
    fn supported(&self) -> bool {
        !cfg!(windows)
    }

    fn caps(&self) -> Caps {
        Caps {
            events: true,
            resume: true,
            permissions: Some(ReplyVia::Core),
            questions: Some(ReplyVia::Core),
        }
    }

    /// Its terminal interface takes no model: a run is on the one the
    /// person last chose there, or the one their settings name.
    fn launch(&self, run: &Run) -> Vec<String> {
        let mut argv = vec![self.program().to_owned(), "--standalone".into()];
        if let Some(handle) = run.resume {
            argv.extend(["--session".into(), handle.into()]);
        }
        // As one argument, so that a prompt may begin with a dash.
        argv.push(format!("--prompt={}", run.told(self)));
        argv
    }

    /// Nothing: the plugin is named by a variable.
    fn attach(&self, _: &Path, _: &Path) -> Vec<OsString> {
        Vec::new()
    }

    fn files(&self, exe: &Path) -> Vec<(&'static str, String)> {
        let exe = Value::from(exe.to_string_lossy()).to_string();
        vec![("plugin/tui.js", PLUGIN.replace("\"@TASKTAP@\"", &exe))]
    }

    /// The settings of its terminal interface for this run: the person's
    /// own, with the plugin's folder added.
    fn environment(&self, _: &Path, home: &Path) -> Vec<(&'static str, String)> {
        let folder = home.join(FOLDER).to_string_lossy().into_owned();
        let settings = json!({ "plugins": [folder] });
        vec![("OPENCODE_CLI_CONFIG_CONTENT", settings.to_string())]
    }

    /// The person's words after a rule, as Codex is told them.
    fn told(&self, brief: &str, words: &str) -> String {
        format!("{brief}\n\n---\n{WORDS}\n\n{words}")
    }

    /// Where its settings are when the person keeps them elsewhere or adds
    /// to them, which a server of the run's own reads. Its sign-ins are in
    /// its own store.
    fn variables(&self) -> &'static [&'static str] {
        &[
            "OPENCODE_CONFIG",
            "OPENCODE_CONFIG_CONTENT",
            "OPENCODE_CONFIG_DIR",
        ]
    }

    fn detect(&self) -> Detect {
        Detect {
            // "opencode v2.3.0"
            version: &["--version"],
            version_of: |out| {
                let last = out.split_whitespace().last()?;
                Some(last.trim_start_matches('v').to_owned())
            },
            // The accounts it keeps, as a JSON list, from a server of the
            // check's own: asked of its background service, it would start
            // one. An empty list says nothing either way: it runs without
            // an account, on the models it offers for free.
            account: &["auth", "list", "--standalone", "--format", "json"],
            account_of: |code, out| {
                let listed = serde_json::from_str::<Value>(out.trim()).ok();
                let (Some(0), Some(Value::Array(listed))) = (code, listed) else {
                    return (None, None);
                };
                let connected = |i: &&Value| {
                    let connections = i.get("connections").and_then(Value::as_array);
                    connections.is_some_and(|c| !c.is_empty())
                };
                let names = listed.iter().filter(connected);
                let names: Vec<&str> = names.filter_map(|i| i.get("name")?.as_str()).collect();
                match names.is_empty() {
                    true => (None, None),
                    false => (Some(true), Some(line(&names.join(", "), 200))),
                }
            },
        }
    }

    fn event(&self, _: &[String], payload: &[u8]) -> Result<Option<Heard>, String> {
        let p = Payload::parse(payload)?;
        let Some(kind) = p.str("type") else {
            return Ok(None);
        };
        if kind == "ready" {
            return Ok(Some(said("ready".into(), false, None, Event::Ready)));
        }
        let (Some(id), Some(data)) = (p.str("id"), p.get("data")) else {
            return Ok(None);
        };
        let text = |key: &str| data.get(key)?.as_str().filter(|s| !s.is_empty());
        let form = data.get("form");
        let resume = text("sessionID").or_else(|| form?.get("sessionID")?.as_str());
        let event = match kind {
            "session.inbox.enqueued" => {
                let item = data.get("item").filter(|i| i["type"] == "user");
                let Some(told) = item.and_then(|i| i.get("payload")?.get("text")?.as_str()) else {
                    return Ok(None);
                };
                let prompt = Some(fit(told, MAX_TEXT));
                Event::TurnStarted { prompt }
            }
            "session.execution.started" => Event::TurnStarted { prompt: None },
            // Its form asks.
            "session.tool.called" if p.str("tool") == Some(QUESTION) => return Ok(None),
            "session.tool.called" => Event::Activity {
                text: activity(p.str("tool").unwrap_or("tool"), data.get("input")),
            },
            "permission.asked" => {
                let Some(request) = text("id") else {
                    return Ok(None);
                };
                let action = text("action").unwrap_or("act");
                let resources = data.get("resources").and_then(Value::as_array);
                let resources = resources.into_iter().flatten().filter_map(Value::as_str);
                let what = resources.collect::<Vec<_>>().join(", ");
                let input = match action {
                    "shell" => json!({ "command": what }),
                    _ => json!({ "path": what }),
                };
                let ask = permission(self.name(), request.into(), action, Some(&input));
                return Ok(Some(Heard::Wait(ask)));
            }
            "form.created" => {
                let Some((form, request)) = form.and_then(|f| Some((f, f.get("id")?.as_str()?)))
                else {
                    return Ok(None);
                };
                match asked(request.into(), form) {
                    Ok(ask) => return Ok(Some(Heard::Wait(ask))),
                    Err(ask) => Event::Question { question: ask },
                }
            }
            // Answered, in the terminal or through its hook: a hook that
            // still waits on it is told it was answered in the terminal.
            "permission.replied" => Event::Continued {
                request: text("requestID").map(Into::into),
            },
            "form.replied" | "form.cancelled" => Event::Continued {
                request: text("id").map(Into::into),
            },
            "session.execution.succeeded" => Event::TurnFinished {
                answer: p.str("text").map(|a| fit(a, 512 << 10)),
            },
            "session.execution.failed" => {
                let error = data.get("error");
                let why = error.and_then(|e| e.get("message")?.as_str());
                let why = why.map(Into::into).or(error.map(Value::to_string));
                Event::TurnFailed {
                    error: why.map(|e| fit(&line(&e, 500), MAX_LINE)),
                }
            }
            // The prompt that took its place opened the next turn already.
            "session.execution.interrupted" if text("reason") == Some("superseded") => {
                return Ok(None);
            }
            "session.execution.interrupted" => Event::TurnInterrupted,
            _ => return Ok(None),
        };
        Ok(Some(said(id.into(), false, resume, event)))
    }

    /// One line of JSON, which the plugin gives to the server: a decision
    /// on a permission request, a form's answer, or that it is dismissed,
    /// which ends the turn as dismissing its dialog does.
    fn reply(&self, _: &[String], payload: &[u8], answer: &Answer) -> Option<String> {
        let p = Payload::parse(payload).ok()?;
        let reject = |message: &str| json!({ "decision": "reject", "message": message });
        let reply = match p.str("type")? {
            "permission.asked" => match &answer.response {
                Response::Affirm => json!({ "decision": "once" }),
                Response::Deny => reject("The person denied this in Tasktap."),
                // "No, and tell it what to do differently".
                Response::Text { text } => reject(text),
                Response::Choice { .. } | Response::Terminal => return None,
            },
            "form.created" => {
                let (key, field) = field(p.get("data")?.get("form")?)?;
                let yes_or_no = field["type"] == "boolean";
                let value = match &answer.response {
                    Response::Choice { choice } => {
                        let chosen = options(field).nth(*choice as usize)?;
                        chosen.get("value")?.clone()
                    }
                    Response::Text { text } if !yes_or_no => json!(text),
                    Response::Affirm if yes_or_no => json!(true),
                    Response::Deny if yes_or_no => json!(false),
                    Response::Deny => return Some(json!({ "cancel": true }).to_string()),
                    _ => return None,
                };
                json!({ "answer": { key: value } })
            }
            _ => return None,
        };
        Some(reply.to_string())
    }
}
