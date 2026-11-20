//! Pi (design §7), the `pi` coding agent, as 1.5 runs it.
//!
//! Pi has no hooks a run is given as commands; it has extensions, modules it
//! loads and calls on its events. A run is given one of Tasktap's own with
//! `-e <home>/tasktap.mjs`, a file the core keeps in its own folder
//! ([`Agent::files`]), so nothing is written to `~/.pi` or to the project.
//! The extension runs `<exe> hook pi` once for each event, one after the
//! other, with a payload of its own making on standard input:
//!
//! | Event | Heard |
//! | --- | --- |
//! | `session_start` | `ready`; nothing while its model has no sign-in, so that the core goes on reading its terminal, which says so |
//! | `before_agent_start` | `turn_started` with the prompt |
//! | `tool_call` | `activity`, the tool and what it does |
//! | `ui_prompt_start` | a question answered in the terminal: a dialog of an extension waits for the person |
//! | `ui_prompt_end` | `continued` |
//! | `agent_settled` | `turn_finished` with the last message; `turn_interrupted` when it was aborted; `turn_failed` with the error its last message ended on |
//!
//! `agent_end` is not the end of a turn, since Pi may still try again or go
//! on with what was typed meanwhile: the extension keeps its last message
//! and sends it with `agent_settled`. What is typed while a turn runs is
//! part of that turn. Every payload carries the session's id, the handle
//! `--session` takes, and a number of the extension's own (`at`), which is
//! the event's id.
//!
//! Pi asks for no approval before it uses a tool, and has no tool with which
//! its model asks the person. An extension the person added may do either
//! with a dialog; such a dialog is heard and shown, and answered in Pi's
//! terminal, since nothing lets another extension answer it.
//!
//! It places no thought (`headless` is none). `pi -p` answers one question
//! with no tools and nothing saved, but it has no flag that holds the answer
//! to a schema and no model of its own: asked that way on DeepSeek's small
//! model it was right in 13 of the evaluation's 14 thoughts, where the
//! agents that place were right in all (design §8).

use std::ffi::OsString;
use std::path::Path;

use serde_json::Value;
use tasktap_proto::{Answer, Ask, Event, MAX_LINE, MAX_TEXT, QuestionKind, ReplyVia};

use super::rules::Rules;
use super::{Agent, Caps, Choice, Detect, Heard, Payload, Prompt, Run, WORDS, activity};
use super::{fit, line, said};

pub struct Pi;

#[rustfmt::skip]
pub const RULES: Rules = Rules {
    agent: "pi",
    passthrough: &["auth", "config", "install", "list", "mcp", "remove", "uninstall", "update"],
    noninteractive: &["-p", "-v", "--mode", "--export", "--list-models"],
    // It asks for no approval: there is no policy to state, and none to add.
    policy: &[],
    default: &[],
};

/// The option that lets a run read its project's own `.pi`.
const PROJECT: &str = "project";

/// The extension, below Tasktap's folder for Pi.
const FILE: &str = "tasktap.mjs";

/// The extension. `EXE` is this program, as a JSON string.
const EXTENSION: &str = r#"// Tasktap's extension for Pi: it tells Tasktap what this run does, by running
// Tasktap's hook once for each thing that happens, one after the other. It
// decides nothing and changes nothing of the run. Tasktap writes this file.
import { spawn } from "node:child_process";

const BORN = Date.now().toString(36);

export default function (pi) {
  let sent = Promise.resolve();
  let count = 0;
  let said = {};
  const tell = (event, ctx, more) => {
    const session = ctx.sessionManager.getSessionId();
    const payload = JSON.stringify({ event, session, at: `${BORN}.${++count}`, ...more });
    sent = sent.then(
      () =>
        new Promise((done) => {
          const hook = spawn(EXE, ["hook", "pi"], { stdio: ["pipe", "ignore", "ignore"] });
          hook.on("error", done);
          hook.on("close", done);
          hook.stdin.on("error", () => {});
          hook.stdin.end(payload);
        }),
    );
  };
  pi.on("session_start", (event, ctx) => {
    const signed = !!ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model);
    tell("session_start", ctx, { reason: event.reason, signed });
  });
  pi.on("before_agent_start", (event, ctx) => tell("before_agent_start", ctx, { prompt: event.prompt }));
  pi.on("tool_call", (event, ctx) => tell("tool_call", ctx, { tool: event.toolName, input: event.input }));
  pi.on("ui_prompt_start", (event, ctx) => tell("ui_prompt_start", ctx, { kind: event.kind, title: event.title }));
  pi.on("ui_prompt_end", (_event, ctx) => tell("ui_prompt_end", ctx));
  // The last thing it said in this run, and how that ended.
  pi.on("agent_end", (event) => {
    const last = event.messages.findLast((message) => message.role === "assistant") ?? {};
    const text = (last.content ?? []).filter((part) => part.type === "text").map((part) => part.text);
    said = { stop: last.stopReason, error: last.errorMessage, text: text.join("\n") };
  });
  // Only now is the run over: after `agent_end` Pi may still try again.
  pi.on("agent_settled", (event, ctx) => tell("agent_settled", ctx, { aborted: event.aborted, ...said }));
  // What was told arrives before Pi exits.
  pi.on("session_shutdown", () => sent);
}
"#;

/// The dialog an extension shows and waits on, as a question answered in
/// the terminal: the payload has its title and kind, not its options.
fn dialog(request: String, p: &Payload) -> Ask {
    Ask {
        request,
        kind: match p.str("kind") {
            Some("confirm") => QuestionKind::Confirm,
            _ => QuestionKind::Text,
        },
        prompt: fit(
            p.str("title")
                .unwrap_or("Pi is waiting for you in its terminal"),
            2000,
        ),
        detail: None,
        source: None,
    }
}

/// An error as a provider words it, without the part of a key some name in
/// it ("Incorrect API key provided: sk-…abcd", "Your api key: ****abcd is
/// invalid"): no part of one is kept.
fn unkeyed(error: &str) -> String {
    let keyed = |word: &str| word.contains("sk-") || word.starts_with("**");
    let words = error.split(' ').map(|word| match keyed(word) {
        true => "(a key)",
        false => word,
    });
    words.collect::<Vec<_>>().join(" ")
}

impl Agent for Pi {
    fn id(&self) -> &'static str {
        "pi"
    }

    fn name(&self) -> &'static str {
        "Pi"
    }

    fn program(&self) -> &'static str {
        "pi"
    }

    /// It asks for no approval, so none is heard. What an extension of the
    /// person's asks in a dialog is shown, and answered in its terminal.
    fn caps(&self) -> Caps {
        Caps {
            events: true,
            resume: true,
            permissions: None,
            questions: Some(ReplyVia::Terminal),
        }
    }

    /// Not there yet: nothing of it has been run on Windows.
    fn supported(&self) -> bool {
        !cfg!(windows)
    }

    fn options(&self) -> &'static [Choice] {
        &[Choice {
            id: PROJECT,
            name: "Load project extensions",
            allows: "Pi then loads the extensions, skills and settings in a project's .pi folder; \
                     an extension is that project's code, and runs as you.",
        }]
    }

    fn launch(&self, run: &Run) -> Vec<String> {
        let mut argv = vec![self.program().to_owned()];
        // Also for a resume, which is then on the model its session had.
        if let Some(model) = run.model {
            argv.extend(["--model".into(), model.into()]);
        }
        let attached = self.attach(run.hook, run.home).into_iter();
        argv.extend(attached.map(|a| a.to_string_lossy().into_owned()));
        // What a project's own `.pi` holds is code of that project's, which
        // would run as the person: it is read for this run only when they
        // said so (`options`), and otherwise passed over without a question.
        let project = run.allows(self, PROJECT);
        argv.push(if project { "--approve" } else { "--no-approve" }.into());
        if let Some(handle) = run.resume {
            argv.extend(["--session".into(), handle.into()]);
        }
        // Pi reads a message that starts with `@` as the name of a file.
        let told = run.told(self);
        let told = match told.starts_with('@') {
            true => format!(" {told}"),
            false => told,
        };
        argv.extend(["--".into(), told]);
        argv
    }

    fn attach(&self, _: &Path, home: &Path) -> Vec<OsString> {
        vec!["-e".into(), home.join(FILE).into()]
    }

    fn files(&self, exe: &Path) -> Vec<(&'static str, String)> {
        let exe = Value::from(exe.to_string_lossy()).to_string();
        vec![(FILE, EXTENSION.replace("EXE", &exe))]
    }

    /// The person's words after a rule, as Codex is told them.
    fn told(&self, brief: &str, words: &str) -> String {
        format!("{brief}\n\n---\n{WORDS}\n\n{words}")
    }

    /// The keys Pi's help names for the providers that take one key, for a
    /// person who signs it in that way and not with `/login`; the two
    /// folders it keeps its settings and its sessions in when moved; and
    /// the three with which a person keeps it from the network as it
    /// starts, so that what they turned off is not on again in Tasktap.
    /// Providers that need several variables (Azure, Bedrock, Cloudflare)
    /// are signed in through its own files.
    #[rustfmt::skip]
    fn variables(&self) -> &'static [&'static str] {
        &[
            "AI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN",
            "ANT_LING_API_KEY", "BASETEN_API_KEY", "CEREBRAS_API_KEY", "DEEPSEEK_API_KEY",
            "FIREWORKS_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "KIMI_API_KEY", "META_API_KEY",
            "MINIMAX_API_KEY", "MISTRAL_API_KEY", "MOONSHOT_API_KEY", "NVIDIA_API_KEY",
            "OPENAI_API_KEY", "OPENCODE_API_KEY", "OPENROUTER_API_KEY", "QWEN_TOKEN_PLAN_API_KEY",
            "QWEN_TOKEN_PLAN_CN_API_KEY", "TOGETHER_API_KEY", "XAI_API_KEY", "XIAOMI_API_KEY",
            "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_CN_API_KEY",
            "XIAOMI_TOKEN_PLAN_SGP_API_KEY", "ZAI_API_KEY", "ZAI_CODING_CN_API_KEY",
            "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_OFFLINE",
            "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY",
        ]
    }

    /// What it shows in its terminal and waits on, or stops at, with no
    /// event to say so.
    fn prompts(&self) -> &'static [Prompt] {
        &[
            // A folder with a `.pi` of its own that it was not told to
            // trust: a run the core starts is told, one typed by hand asks.
            Prompt {
                shows: "Trust project folder?",
                asks: "Pi is asking whether to trust this folder",
            },
            // With no sign-in for its model it starts all the same and
            // drops the prompt: a run started while detection could not tell.
            Prompt {
                shows: "Use /login to log into a provider",
                asks: "Pi is asking you to sign in",
            },
            // A conversation continued in another folder than it was in.
            Prompt {
                shows: "Fork this session into current directory?",
                asks: "Pi is asking whether to continue this conversation in another folder",
            },
        ]
    }

    fn detect(&self) -> Detect {
        Detect {
            // "1.5.2"
            version: &["--version"],
            version_of: |out| out.split_whitespace().next().map(Into::into),
            // It has no command that says whether it is signed in at all,
            // only one that asks about a provider one names. Listing its
            // models needs no network and lists those of the providers it
            // has a sign-in or a key for, a model to a line after a
            // heading; with none it says "No models available". The
            // providers are how it is signed in; no account is named.
            account: &["--offline", "--list-models"],
            account_of: |code, out| {
                let rows = out.lines().skip_while(|l| !l.starts_with("provider "));
                let mut providers: Vec<&str> = rows
                    .skip(1)
                    .filter_map(|row| row.split_whitespace().next())
                    .collect();
                providers.dedup();
                match code {
                    Some(0) if !providers.is_empty() => {
                        (Some(true), Some(line(&providers.join(", "), 80)))
                    }
                    Some(0) if out.contains("No models available") => (Some(false), None),
                    _ => (None, None),
                }
            },
        }
    }

    fn event(&self, _: &[String], payload: &[u8]) -> Result<Option<Heard>, String> {
        let p = Payload::parse(payload)?;
        let (Some(name), Some(at)) = (p.str("event"), p.str("at")) else {
            return Ok(None);
        };
        let id = format!("{name}:{at}");
        let event = match name {
            "session_start" if p.get("signed") == Some(&Value::Bool(false)) => return Ok(None),
            "session_start" => Event::Ready,
            "before_agent_start" => Event::TurnStarted {
                prompt: p.str("prompt").map(|t| fit(t, MAX_TEXT)),
            },
            "tool_call" => Event::Activity {
                text: activity(p.str("tool").unwrap_or("a tool"), p.get("input")),
            },
            "ui_prompt_start" => Event::Question {
                question: dialog(id.clone(), &p),
            },
            "ui_prompt_end" => Event::Continued { request: None },
            "agent_settled" => match p.str("stop") {
                _ if p.get("aborted") == Some(&Value::Bool(true)) => Event::TurnInterrupted,
                Some("aborted") => Event::TurnInterrupted,
                Some("error") => Event::TurnFailed {
                    error: p
                        .str("error")
                        .map(|e| fit(&line(&unkeyed(e), 500), MAX_LINE)),
                },
                _ => Event::TurnFinished {
                    answer: p.str("text").map(|a| fit(a, 512 << 10)),
                },
            },
            _ => return Ok(None),
        };
        Ok(Some(said(id, false, p.str("session"), event)))
    }

    /// Nothing it asks is answered through a hook.
    fn reply(&self, _: &[String], _: &[u8], _: &Answer) -> Option<String> {
        None
    }
}
