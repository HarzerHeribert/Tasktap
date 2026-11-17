//! Codex (design §7), as `codex` 0.169 runs it.
//!
//! A run gets its hooks as `-c hooks.<Event>=…` settings of that run only.
//! Codex runs a hook only once it is trusted, so before a run starts a probe
//! asks Codex's app server (`codex app-server`, `hooks/list`) for the hash of
//! each of these hooks, and the run trusts exactly those with `-c
//! hooks.state=…`, keeping the trust the person gave their own hooks. The
//! run's folder is trusted for the run with `-c projects=…`, as 1.2 trusted
//! a folder the person had chosen, so that Codex does not stop at its trust
//! prompt and nothing is written to `~/.codex`; the setting adds that folder
//! to the person's own trusted folders, which still apply. It runs without the shared
//! background server (`--no-daemon`), so these settings are its own, and
//! with `--approve-for-me`, as 1.2 had it.
//!
//! | Hook | Heard |
//! | --- | --- |
//! | `SessionStart` | `ready` |
//! | `UserPromptSubmit` | `turn_started` with the prompt |
//! | `PreToolUse` | `activity`; for `request_user_input`, a question answered in the terminal |
//! | `PostToolUse` of `request_user_input` | `continued` |
//! | `PermissionRequest` | a permission request: a confirm question the hook waits on |
//! | `Stop` | `turn_finished` with the last message |
//! | `Interrupt` | `turn_interrupted` |
//!
//! Each event's id is the hook's name with the turn id Codex gives every
//! hook of a turn, and the tool call's id where there is one. Codex's turn
//! ids are not numbers, so none is sent. A payload with `agent_id` comes from
//! a sub-agent. Every payload carries the thread id, which `codex resume`
//! takes.
//!
//! A `PermissionRequest` hook may decide (the trial of design §14 D): Codex
//! waits for it before it shows its own approval, and takes
//! `hookSpecificOutput.decision`. `request_user_input` cannot be answered by
//! a hook: no hook runs between the question and its answer except
//! `PreToolUse`, whose output can allow, deny or change the call's input but
//! not give its result. It is shown and answered in the terminal; the tool
//! exists only in plan mode unless `default_mode_request_user_input` is on.

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use tasktap_proto::{Answer, Ask, Event, MAX_TEXT, QuestionKind, ReplyVia, Response};

use super::rules::Rules;
use super::{
    Agent, Caps, Detect, Headless, Heard, Payload, Probe, Run, WORDS, activity, digest, fit,
    permission, quoted, said,
};

pub struct Codex;

#[rustfmt::skip]
pub const RULES: Rules = Rules {
    agent: "codex",
    passthrough: &["agents", "exec", "e", "review", "login", "logout", "mcp", "plugin",
        "app-server", "remote-control", "app", "completion", "update", "doctor", "sandbox",
        "debug", "apply", "queue", "archive", "delete", "migrate-rollouts", "migrate-nfs-db",
        "unarchive", "cloud", "exec-server", "features", "help"],
    noninteractive: &[],
    // Settings given with `-c` are the last three, prefixes of any argument.
    policy: &["--approve-for-me", "--ask-for-approval", "-a",
        "--dangerously-bypass-approvals-and-sandbox", "--sandbox", "-s",
        "approval_policy=", "approvals_reviewer=", "sandbox_mode="],
    default: &["--approve-for-me"],
};

/// Seconds a hook that asked may wait for the person; Codex shows its own
/// approval only after that.
pub const WAIT: u32 = 600;

/// The hook events a run reports, with the seconds Codex lets each run
/// (it allows an `Interrupt` hook 3 s at most).
const HOOKS: &[(&str, u32)] = &[
    ("SessionStart", 30),
    ("UserPromptSubmit", 30),
    ("PreToolUse", 30),
    ("PostToolUse", 30),
    ("PermissionRequest", WAIT),
    ("Stop", 30),
    ("Interrupt", 3),
];

/// The model a headless question asks: the smallest, fastest one Codex
/// lists (`codex debug models`), which has no alias that follows it.
const SMALL: &str = "gpt-6-luna";

/// What gives a Codex model tools, each turned off for a headless question.
const TOOLS: &[&str] = &[
    "shell_tool",
    "unified_exec",
    "plugins",
    "hooks",
    "apps",
    "browser_use",
    "computer_use",
    "in_app_browser",
    "skill_search",
    "tool_suggest",
    "sleep_tool",
    "goals",
    "incremental_tools",
];

/// The tool with which Codex asks the person.
const QUESTION: &str = "request_user_input";

/// `text` as a TOML basic string: JSON's escapes, and DEL escaped as TOML
/// requires.
fn toml(text: &str) -> String {
    serde_json::to_string(text)
        .unwrap_or_default()
        .replace('\u{7f}', "\\u007f")
}

/// The command each hook runs.
fn command(exe: &Path) -> String {
    format!("{} hook codex", quoted(exe))
}

/// Reads the app server's answer to `hooks/list`: the trust of these hooks,
/// and of every hook the person trusted, as one `hooks.state` setting.
fn trusted(line: &str, command: &str) -> Option<Result<Vec<String>, String>> {
    let message: Value = serde_json::from_str(line).ok()?;
    if message.get("id") != Some(&json!(2)) {
        return None;
    }
    if let Some(e) = message.get("error") {
        let why = e
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("no reason");
        return Some(Err(format!("Codex did not list its hooks: {why}")));
    }
    let hooks = (message["result"]["data"].as_array().into_iter().flatten())
        .flat_map(|folder| folder["hooks"].as_array().into_iter().flatten());
    let (mut ours, mut state) = (0, Vec::new());
    for hook in hooks {
        let (Some(key), Some(hash)) = (hook["key"].as_str(), hook["currentHash"].as_str()) else {
            continue;
        };
        let mine = hook["source"] == "sessionFlags" && hook["command"] == command;
        if mine {
            ours += 1;
        } else if hook["trustStatus"] != "trusted" {
            continue;
        }
        state.push(format!("{}={{trusted_hash={}}}", toml(key), toml(hash)));
    }
    if ours != HOOKS.len() {
        return Some(Err(format!(
            "Codex listed {ours} of the {} hooks Tasktap attaches, so none was trusted",
            HOOKS.len()
        )));
    }
    Some(Ok(vec![
        "-c".into(),
        format!("hooks.state={{{}}}", state.join(",")),
    ]))
}

impl Agent for Codex {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn program(&self) -> &'static str {
        "codex"
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
        let cwd = run.cwd.to_string_lossy();
        let mut argv: Vec<String> = vec![self.program().into(), "--no-daemon".into()];
        // An inline table, which Codex adds to the person's `projects`; the
        // dotted `projects.<folder>.trust_level` breaks on a folder with a
        // dot, since Codex splits the key on every one.
        argv.extend([
            "-c".into(),
            format!("projects={{{}={{trust_level=\"trusted\"}}}}", toml(&cwd)),
        ]);
        // As 1.2: a resumed conversation keeps its model.
        if let (Some(model), None) = (run.model, run.resume) {
            argv.extend(["--model".into(), model.into()]);
        }
        let attached = self.attach(run.hook).into_iter();
        argv.extend(attached.map(|a| a.to_string_lossy().into_owned()));
        argv.extend(RULES.default.iter().map(|a| (*a).to_owned()));
        if let Some(handle) = run.resume {
            argv.extend(["resume".into(), handle.into()]);
        }
        argv.extend(["--".into(), run.told(self)]);
        argv
    }

    fn attach(&self, exe: &Path) -> Vec<OsString> {
        let command = toml(&command(exe));
        (HOOKS.iter())
            .flat_map(|(name, timeout)| {
                let hook = format!(
                    "hooks.{name}=[{{hooks=[{{type=\"command\",command={command},timeout={timeout}}}]}}]"
                );
                ["-c".into(), hook.into()]
            })
            .collect()
    }

    /// `codex exec` (0.169) with the question on standard input: none of
    /// the person's settings, rules or project instructions, nothing that
    /// gives the model a tool, no web search, a read-only sandbox, no
    /// session saved (`--ephemeral`), the least reasoning the model does,
    /// and the answer held to the schema. It prints the answer alone on
    /// standard output. Turning the tools off is also what makes it fast:
    /// 4.4 s against 6.6 s with them on.
    fn headless(&self) -> Option<Headless> {
        Some(Headless {
            model: SMALL,
            limit: Duration::from_secs(15),
            args: |schema| {
                let mut args: Vec<String> = ["--ask-for-approval", "never", "exec"]
                    .map(Into::into)
                    .into();
                args.extend(
                    ["--ignore-user-config", "--ignore-rules", "--ephemeral"].map(Into::into),
                );
                args.extend(TOOLS.iter().flat_map(|t| ["--disable".into(), (*t).into()]));
                #[rustfmt::skip]
                args.extend([
                    "-c", "project_doc_max_bytes=0", "-c", "web_search=\"disabled\"",
                    "-c", "model_reasoning_effort=\"low\"", "--sandbox", "read-only",
                    "--skip-git-repo-check", "--color", "never", "--model", SMALL,
                    "--output-schema",
                ].map(Into::into));
                args.extend([schema.file.to_string_lossy().into_owned(), "-".into()]);
                args
            },
            answer: |out| match serde_json::from_str::<Value>(out.trim()) {
                Ok(Value::Object(_)) => Ok(out.trim().into()),
                _ => Err("it printed no answer".into()),
            },
        })
    }

    /// The person's words under a rule and a plain label.
    fn told(&self, brief: &str, words: &str) -> String {
        format!("{brief}\n\n---\n{WORDS}\n\n{words}")
    }

    /// Its sign-in with an API key, and the folder it keeps its sign-in and
    /// settings in when moved.
    fn variables(&self) -> &'static [&'static str] {
        &["OPENAI_API_KEY", "CODEX_HOME"]
    }

    fn probe(&self, exe: &Path, cwd: &Path) -> Option<Probe> {
        let mut argv = vec![self.program().to_owned()];
        argv.extend(
            self.attach(exe)
                .into_iter()
                .map(|a| a.to_string_lossy().into_owned()),
        );
        argv.extend(["app-server".into(), "--listen".into(), "stdio://".into()]);
        let client = json!({ "name": "tasktap", "version": env!("CARGO_PKG_VERSION") });
        let lines = [
            json!({ "id": 1, "method": "initialize",
                    "params": { "clientInfo": client, "capabilities": { "experimentalApi": true } } }),
            json!({ "method": "initialized" }),
            json!({ "id": 2, "method": "hooks/list",
                    "params": { "cwds": [cwd.to_string_lossy()] } }),
        ];
        let input = lines.iter().map(|l| format!("{l}\n")).collect();
        let command = command(exe);
        Some(Probe {
            argv,
            input,
            read: Box::new(move |line| trusted(line, &command)),
        })
    }

    fn detect(&self) -> Detect {
        Detect {
            // "codex-cli 0.169.0"
            version: &["--version"],
            version_of: |out| {
                out.lines()
                    .next()?
                    .split_whitespace()
                    .last()
                    .map(Into::into)
            },
            // "Logged in using ChatGPT", or "Not logged in" and exit 1.
            account: &["login", "status"],
            account_of: |code, out| {
                let said = out.lines().map(str::trim).find(|l| !l.is_empty());
                match (code, said) {
                    (Some(0), Some(said)) => {
                        let how = said.strip_prefix("Logged in using ").unwrap_or(said);
                        (Some(true), Some(how.into()))
                    }
                    (Some(0), None) => (Some(true), None),
                    (Some(_), Some(said)) if said.contains("Not logged in") => (Some(false), None),
                    _ => (None, None),
                }
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
        let turn = p.str("turn_id").map(Into::into);
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
                said(
                    format!("{name}:{turn}"),
                    subagent,
                    resume,
                    Event::TurnStarted { prompt },
                )
            }
            "PreToolUse" if tool == QUESTION => {
                let question = asked(format!("{QUESTION}:{call}"), input);
                said(
                    format!("{name}:{call}"),
                    subagent,
                    resume,
                    Event::Question { question },
                )
            }
            "PreToolUse" => {
                let text = activity(tool, input);
                said(
                    format!("{name}:{call}"),
                    subagent,
                    resume,
                    Event::Activity { text },
                )
            }
            "PostToolUse" if tool == QUESTION => {
                let event = Event::Continued { request: None };
                said(format!("{name}:{call}"), subagent, resume, event)
            }
            // A sub-agent's request is the sub-agent's, which the core does not
            // follow (design §5, the guards): no hook waits for it, and Codex
            // asks in its own terminal.
            "PermissionRequest" if subagent => return Ok(None),
            "PermissionRequest" => {
                let what = input.map(Value::to_string).unwrap_or_default();
                let request = format!(
                    "{name}:{turn}:{}",
                    digest(&[tool.as_bytes(), what.as_bytes()])
                );
                Heard::Wait(permission("Codex", request, tool, input))
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
            "Interrupt" => said(
                format!("{name}:{turn}"),
                subagent,
                resume,
                Event::TurnInterrupted,
            ),
            _ => return Ok(None),
        };
        Ok(Some(heard))
    }

    fn reply(&self, _: &[String], payload: &[u8], answer: &Answer) -> Option<String> {
        let p = Payload::parse(payload).ok()?;
        if p.str("hook_event_name") != Some("PermissionRequest") {
            return None;
        }
        let deny = |message: &str| json!({ "behavior": "deny", "message": message });
        let decision = match &answer.response {
            Response::Affirm => json!({ "behavior": "allow" }),
            Response::Deny => deny("The person denied this in Tasktap."),
            Response::Text { text } => deny(text),
            Response::Choice { .. } | Response::Terminal => return None,
        };
        let output = json!({
            "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision }
        });
        Some(output.to_string())
    }
}

/// `request_user_input`'s questions as one question shown in the notch:
/// the first, with its options as choices when it is the only one.
fn asked(request: String, input: Option<&Value>) -> Ask {
    let questions: Vec<&Value> = (input.and_then(|i| i.get("questions")?.as_array()))
        .into_iter()
        .flatten()
        .collect();
    let text = |q: &Value| q.get("question").and_then(Value::as_str).map(str::to_owned);
    let prompt = questions.first().and_then(|q| text(q));
    let labels: Vec<String> = match questions.as_slice() {
        [only] => (only
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten())
        .filter_map(|o| Some(fit(o.get("label")?.as_str()?, 200)))
        .collect(),
        _ => Vec::new(),
    };
    let all: Vec<String> = questions.iter().filter_map(|q| text(q)).collect();
    Ask {
        request,
        kind: match labels.is_empty() {
            true => QuestionKind::Text,
            false => QuestionKind::Choice { choices: labels },
        },
        prompt: fit(
            &prompt.unwrap_or_else(|| "Codex asks you something".into()),
            2000,
        ),
        detail: (all.len() > 1).then(|| fit(&all.join("\n"), 16 << 10)),
        source: None,
    }
}
