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
use std::path::{Path, PathBuf};

use crate::map::{self, Within, Worked};
use std::time::Duration;

use serde_json::{Value, json};
use tasktap_proto::{Answer, Ask, Event, MAX_LINE, MAX_TEXT, QuestionKind, ReplyVia, Response};

use super::rules::Rules;
use super::{
    Agent, Caps, Detect, Headless, Heard, Payload, Prompt, Run, WORDS, activity, digest, fit, line,
    permission, quota, quoted, said,
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
    // Another conversation, its session's id, the settings its hooks are in,
    // its model; the task after `--`.
    #[rustfmt::skip]
    taken: &["-c", "--continue", "-r", "--resume", "--session-id", "--settings", "--model", "--"],
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

/// The model a headless question asks: Claude Code's alias for its
/// smallest, fastest one.
const SMALL: &str = "haiku";

/// The system prompt of a headless question, in place of Claude Code's
/// own: one line, so that it is one argument on every system. The
/// question itself, with its instructions, is on standard input.
const SYSTEM: &str = "You follow the instructions in the message exactly \
     and answer only with the JSON they ask for.";

/// Whether what `claude -p` printed says the person's plan or key has
/// reached its usage limit: its one JSON object is an error whose result
/// begins as Claude Code's own program (2.1.328) begins every such message
/// ("You've hit your 5-hour limit · resets 4pm (Europe/Berlin)", "You've
/// hit your weekly limit · resets Nov 21, 4pm (…)", "You've hit your
/// monthly spend limit", "You're out of usage credits", "Your org is out of
/// usage · …"), as versions before 2.1 wrote it ("Claude AI usage limit
/// reached|1760000000"), or the provider's own 429.
fn spent(printed: &str, _: &str) -> Option<quota::Back> {
    const BEGINS: &[&str] = &[
        "You've hit your",
        "You’ve hit your",
        "You've reached your",
        "You’ve reached your",
        "You're out of",
        "You’re out of",
        "Your org is out of usage",
    ];
    let said: Value = serde_json::from_str(printed.trim()).ok()?;
    let result = said
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let limited = BEGINS.iter().any(|b| result.starts_with(b))
        || result.to_ascii_lowercase().contains("usage limit reached")
        || said.get("api_error_status").and_then(Value::as_u64) == Some(429)
        || said.get("api_error_type").and_then(Value::as_str) == Some("rate_limit_error");
    let error = said.get("is_error") == Some(&Value::Bool(true));
    (error && limited).then(|| quota::back(result))
}

/// Reads what `claude -p --output-format json` printed: one JSON object,
/// whose `structured_output` is the answer that fits the schema.
fn answer(out: &str) -> Result<String, String> {
    let said: Value =
        serde_json::from_str(out.trim()).map_err(|_| "it printed no JSON result".to_owned())?;
    let text = |key: &str| said.get(key).and_then(Value::as_str).unwrap_or_default();
    match said.get("structured_output") {
        Some(answer @ Value::Object(_)) if said.get("is_error") == Some(&Value::Bool(false)) => {
            Ok(answer.to_string())
        }
        _ => Err(match (text("result"), text("subtype")) {
            ("", "") => "its result holds no answer".into(),
            ("", kind) => format!("it ended with {kind}"),
            (why, _) => line(why, 200),
        }),
    }
}

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
                    source: None,
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
                    source: None,
                })
            }
        }
    }
}

impl Agent for Claude {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn name(&self) -> &'static str {
        "Claude Code"
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
        let attached = self.attach(run.hook, run.home).into_iter();
        argv.extend(attached.map(|a| a.to_string_lossy().into_owned()));
        match run.resume {
            Some(handle) => argv.extend(["--resume".into(), handle.into()]),
            None => argv.extend(["--session-id".into(), run.session.uuid().to_string()]),
        }
        argv.extend(RULES.approval(run.args).iter().map(|a| (*a).to_owned()));
        argv.extend(["--".into(), run.told(self)]);
        argv
    }

    fn attach(&self, exe: &Path, _: &Path) -> Vec<OsString> {
        vec!["--settings".into(), Self::settings(exe).into()]
    }

    /// `claude -p` (2.1): no tools, no MCP servers, no skills or commands,
    /// nothing of the person's customisations or the folder's instructions
    /// (`--safe-mode`), no session saved, a short system prompt instead of
    /// Claude Code's own, and the answer held to the schema. `--bare` would
    /// be less still, but it never reads the sign-in of a subscription. The
    /// model thinks before it answers, about 500 tokens for a spoken
    /// thought, which is most of the time it takes; neither `--effort low`,
    /// `alwaysThinkingEnabled` nor `MAX_THINKING_TOKENS=0` turns that off.
    fn history(&self) -> Option<&'static dyn crate::map::History> {
        Some(&History)
    }

    fn headless(&self) -> Option<Headless> {
        Some(Headless {
            model: SMALL,
            limit: Duration::from_secs(12),
            #[rustfmt::skip]
            args: |schema| {
                ["-p", "--model", SMALL, "--tools", "", "--strict-mcp-config",
                 "--disable-slash-commands", "--safe-mode", "--no-session-persistence",
                 "--output-format", "json", "--system-prompt", SYSTEM,
                 "--json-schema", schema.text]
                .map(Into::into)
                .into()
            },
            stdin: str::to_owned,
            answer,
            // Its one JSON object says so: the provider knows no such model.
            gone: |printed, _| {
                let said = serde_json::from_str::<Value>(printed.trim()).unwrap_or_default();
                said.get("api_error_type").and_then(Value::as_str) == Some("not_found_error")
            },
            quota: spent,
        })
    }

    /// The person's words in a tag, which Claude reads as a quoted document.
    fn told(&self, brief: &str, words: &str) -> String {
        format!("{brief}\n\n{WORDS}\n<persons_words>\n{words}\n</persons_words>")
    }

    /// Its sign-in when it is not in the keychain: an API key, the
    /// long-lived token `claude setup-token` makes for a subscription, and
    /// the folder it keeps its sign-in and settings in when moved.
    fn variables(&self) -> &'static [&'static str] {
        &[
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CONFIG_DIR",
        ]
    }

    /// Its folder-trust dialog, which it shows before anything else in a
    /// folder it does not trust, and before any hook runs (design §7: it has
    /// no way to trust a folder for one run).
    fn prompts(&self) -> &'static [Prompt] {
        &[Prompt {
            shows: "Yes, I trust this folder",
            asks: "Claude Code is asking whether to trust this folder",
        }]
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
            // A sub-agent's request is the sub-agent's, which the core does not
            // follow (design §5, the guards): no hook waits for it, and
            // Claude Code asks in its own terminal.
            "PermissionRequest" if subagent => return Ok(None),
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
                Heard::Wait(permission(self.name(), request, tool, input))
            }
            "Notification" if p.str("notification_type") == Some("elicitation_dialog") => {
                let message = p.str("message").unwrap_or("An MCP server asks for input");
                let request = format!("elicitation:{turn}:{}", digest(&[message.as_bytes()]));
                let ask = Ask {
                    request: request.clone(),
                    kind: QuestionKind::Text,
                    prompt: fit(message, 2000),
                    detail: None,
                    source: None,
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

/// Claude Code's record of where it was started (docs/projects-design.md):
/// `<config>/projects` holds one folder per working folder, named by the
/// path with every character but letters and digits made `-`, which
/// cannot be read back; so the path is the `cwd` field near the start of
/// the newest session file in it, read until that field and no further,
/// and the date is that file's modified time. Nothing else of the file is
/// kept, and `~/.claude.json`, which holds the account, is not read.
pub struct History;

impl crate::map::History for History {
    fn folder(&self, home: &Path) -> PathBuf {
        let config = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from);
        config
            .unwrap_or_else(|| home.join(".claude"))
            .join("projects")
    }

    fn read(&self, home: &Path, within: &mut Within) -> Result<Vec<Worked>, String> {
        let folder = self.folder(home);
        let entries = std::fs::read_dir(&folder)
            .map_err(|e| format!("{} could not be read: {e}", folder.display()))?;
        let mut worked = Vec::new();
        for entry in entries.filter_map(|e| e.ok()) {
            let Ok(files) = std::fs::read_dir(entry.path()) else {
                continue;
            };
            let mut sessions: Vec<(u64, PathBuf)> = (files.filter_map(|f| f.ok()))
                .filter(|f| f.file_name().to_string_lossy().ends_with(".jsonl"))
                .filter_map(|f| Some((map::modified(&f.metadata().ok()?), f.path())))
                .collect();
            sessions.sort_by_key(|s| std::cmp::Reverse(s.0));
            let Some(&(when, _)) = sessions.first() else {
                continue;
            };
            // The newest that says where it started, of the newest three.
            for (_, file) in sessions.iter().take(3) {
                if !within.more() {
                    return Ok(worked);
                }
                let cwd = map::head(file, map::HISTORY_BYTES, |b| map::field(b, "cwd"));
                if let Some(cwd) = cwd.filter(|c| Path::new(c).is_absolute()) {
                    let folder = PathBuf::from(cwd);
                    worked.push(Worked { folder, when });
                    break;
                }
            }
        }
        Ok(worked)
    }
}
