//! Antigravity (design §7), Google's `agy`, as 1.5 runs it.
//!
//! It has hooks, but none a run can be given for itself: it reads them from
//! the person's own `~/.gemini`, which Tasktap never writes, and from the
//! run's folders, of which the one first in the alphabet is where it works
//! (`--settings` refuses `hooks`). What does travel as an argument is its
//! title script: `--settings {"title": {"command": …}}` has it run
//! `<exe> hook agy` whenever its state changes, at most every 300 ms, with
//! that state on standard input. So a run says what state it is in, not
//! what happened, and the hook is told the same state many times:
//!
//! | State | Heard |
//! | --- | --- |
//! | `idle`, no conversation yet | `ready` |
//! | `working` | `turn_started` without a prompt: a turn starts, or the open one goes on |
//! | `tool_use` | a question answered in the terminal when it waits there for an approval (`tool_confirmation_pending`) or for an answer (its last step calls `ask_question`); else as `working` |
//! | `reviewing` | a question answered in the terminal |
//! | `idle`, in a conversation | `turn_finished` with the last message |
//! | `error` | `turn_failed` |
//!
//! Each event's id is the state with the conversation and its count of
//! output tokens, which stands still while a state lasts and has grown when
//! it comes again, so a repeat is ignored and the next turn is not. The
//! conversation's id is the handle `--conversation` takes.
//!
//! The state names no tool, no question and no message: those are in the
//! transcript Antigravity keeps, whose end the hook reads ([`Heard::Read`]).
//! Nothing answers an approval or a question from outside its terminal,
//! and its sub-agents report nothing.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use tasktap_proto::{Ask, Event, MAX_LINE, QuestionKind, QuestionSource, ReplyVia, SessionEvent};

use super::rules::Rules;
use super::{
    Agent, Caps, Detect, Headless, Heard, Payload, Prompt, Run, WORDS, fit, line, permission,
    quota, quoted, said,
};

pub struct Antigravity;

#[rustfmt::skip]
pub const RULES: Rules = Rules {
    agent: "agy",
    passthrough: &["acp", "agent", "agents", "changelog", "help", "install", "mcp", "mic-serve",
        "models", "plugin", "plugins", "remote-control", "update"],
    noninteractive: &["-p", "--prompt"],
    policy: &["--mode", "--dangerously-skip-permissions"],
    // Its own default stands: the mode the person set, `auto` where it has one.
    default: &[],
    // Where the task goes, the settings its hooks are in, the conversation it
    // continues, its model.
    taken: &["-i", "--prompt-interactive", "--settings", "--conversation", "--model"],
};

/// The model a headless question asks, the smallest fast one it lists
/// (`agy models`). It has no alias, so the name will age.
const SMALL: &str = "gemini-3.8-flash-low";

/// The tool with which it asks the person.
const QUESTION: &str = "ask_question";

/// `--settings`: the title script, and for a run the core starts, the
/// folder the person chose as trusted for this run. One flag holds both:
/// of two, Antigravity reads the last alone.
fn settings(exe: &Path, trusted: Option<&Path>) -> String {
    let command = format!("{} hook agy", quoted(exe));
    let mut settings = json!({ "title": { "type": "command", "command": command } });
    if let Some(folder) = trusted {
        settings["trustedWorkspaces"] = json!([folder.to_string_lossy()]);
    }
    settings.to_string()
}

/// Where the transcript is: beside the one the state names, the full one,
/// whose steps keep their tools' input as it was; and each below
/// `antigravity-cli`, where 1.5 keeps them while naming the other folder.
fn transcripts(p: &Payload) -> Vec<PathBuf> {
    let Some(named) = p.str("transcript_path") else {
        return Vec::new();
    };
    let kept = named.replacen("/antigravity/brain/", "/antigravity-cli/brain/", 1);
    let full = |path: &str| path.replacen("/transcript.jsonl", "/transcript_full.jsonl", 1);
    let mut files = vec![full(&kept), full(named), kept, named.to_owned()];
    files.dedup();
    files.into_iter().map(PathBuf::from).collect()
}

/// The steps at the end of a transcript, the last first: one JSON object
/// to a line, of which the first here may be cut.
fn steps(transcript: &str) -> impl Iterator<Item = Value> + '_ {
    let lines = transcript.lines().rev();
    lines.filter_map(|l| serde_json::from_str::<Value>(l).ok())
}

/// The tool its last step calls and waits on, with its input.
fn calls(transcript: &str) -> Option<(String, Value)> {
    let last = steps(transcript).next()?;
    let call = last.get("tool_calls")?.get(0)?;
    let mut input = call.get("args")?.clone();
    // The short transcript keeps a list or an object as its JSON text.
    let values = input
        .as_object_mut()
        .into_iter()
        .flat_map(|o| o.values_mut());
    for value in values {
        let listed = value.as_str().filter(|text| text.starts_with(['[', '{']));
        if let Some(whole) = listed.and_then(|text| serde_json::from_str(text).ok()) {
            *value = whole;
        }
    }
    Some((call.get("name")?.as_str()?.to_owned(), input))
}

/// Completes an event from the end of the transcript (the table above);
/// none while the step it is about is not written there yet.
fn fill(heard: &SessionEvent, transcript: &str) -> Option<SessionEvent> {
    let mut heard = heard.clone();
    match &mut heard.event {
        // The last thing it said since the person's prompt.
        Event::TurnFinished { answer } => {
            let turn = steps(transcript).take_while(|s| s["type"] != "USER_INPUT");
            let said = turn.filter(|s| s["type"] == "PLANNER_RESPONSE");
            let mut last = said.filter_map(|s| Some(s.get("content")?.as_str()?.trim().to_owned()));
            *answer = Some(fit(&last.find(|text| !text.is_empty())?, 512 << 10));
        }
        Event::TurnFailed { error } => {
            let why = steps(transcript).find_map(|s| Some(s.get("error")?.as_str()?.to_owned()));
            *error = (why.filter(|e| !e.is_empty())).map(|e| fit(&line(&e, 500), MAX_LINE));
        }
        Event::Question { question } => {
            let (tool, input) = calls(transcript)?;
            *question = match tool == QUESTION {
                true => asked(question.request.clone(), &input)?,
                false => approval(question.request.clone(), &tool, &input)?,
            };
        }
        // At work on a tool: unless that tool is its question to the person.
        Event::TurnStarted { .. } => {
            if let Some((_, input)) = calls(transcript).filter(|(tool, _)| tool == QUESTION) {
                let request = heard.id.replacen("working", "question", 1);
                let question = asked(request.clone(), &input)?;
                heard.id = request;
                heard.event = Event::Question { question };
            }
        }
        _ => {}
    }
    Some(heard)
}

/// `ask_question`, answered in its terminal: its one question with its
/// options, or the first of several with the rest as the detail. None
/// while its step holds no question yet.
fn asked(request: String, input: &Value) -> Option<Ask> {
    let questions = input.get("questions").and_then(Value::as_array);
    let questions: Vec<&Value> = questions.into_iter().flatten().collect();
    let text = |q: &&Value| Some(q.get("question")?.as_str()?.to_owned());
    let all: Vec<String> = questions.iter().filter_map(text).collect();
    let choices: Vec<String> = match questions.as_slice() {
        [only] => (only.get("options").and_then(Value::as_array))
            .into_iter()
            .flatten()
            .filter_map(|o| Some(fit(o.as_str()?, 200)))
            .collect(),
        _ => Vec::new(),
    };
    Some(Ask {
        request,
        kind: match choices.is_empty() {
            true => QuestionKind::Text,
            false => QuestionKind::Choice { choices },
        },
        prompt: fit(all.first()?, 2000),
        detail: (all.len() > 1).then(|| fit(&all.join("\n"), 16 << 10)),
        source: None,
    })
}

/// The approval it waits on in its terminal, said as the other agents'
/// permission requests are: its tools name their input in their own words.
/// None while its step names no input yet.
fn approval(request: String, tool: &str, input: &Value) -> Option<Ask> {
    input.as_object().filter(|fields| !fields.is_empty())?;
    let named = |key: &str| input.get(key).cloned().unwrap_or(Value::Null);
    let path = ["TargetFile", "AbsolutePath", "Path"].map(named);
    let said = json!({
        "command": named("CommandLine"),
        "description": named("toolSummary"),
        "path": path.into_iter().find(Value::is_string),
        "url": named("Url"),
    });
    let ask = permission("Antigravity", request, tool, Some(&said));
    let detail = serde_json::to_string_pretty(input).ok();
    Some(Ask {
        detail: detail.map(|d| fit(&d, 16 << 10)),
        ..ask
    })
}

/// What it waits on in its terminal when the transcript does not say.
fn waits(request: String, prompt: &str, source: Option<QuestionSource>) -> Ask {
    Ask {
        request,
        kind: QuestionKind::Confirm,
        prompt: prompt.into(),
        detail: None,
        source,
    }
}

/// Reads what `agy -p --output-format stream-json` printed: a JSON object
/// to a line, of which the last, `result`, holds the answer that fits the
/// schema as `structured_output`.
fn answer(out: &str) -> Result<String, String> {
    let whole = out.ends_with('\n').then(|| out.trim_end().lines().last());
    let last: Value = (whole.flatten())
        .and_then(|l| serde_json::from_str(l).ok())
        .ok_or("it printed no result")?;
    let result = last.get("result").ok_or("it printed no result")?;
    let text = |key: &str| result.get(key).and_then(Value::as_str).unwrap_or_default();
    match result.get("structured_output") {
        Some(answer @ Value::Object(_)) if text("status") == "SUCCESS" => Ok(answer.to_string()),
        _ => Err(match (text("error"), text("status")) {
            ("", "") => "its result holds no answer".into(),
            ("", status) => format!("it ended with {status}"),
            (why, _) => line(why, 200),
        }),
    }
}

/// Whether its result says the person's plan has reached its usage limit:
/// "You have exhausted your quota on this model." in the words of its
/// program (1.5), or the words of Google's service behind it
/// (`RESOURCE_EXHAUSTED`, a 429). It names no time there, so it is passed
/// over for an hour unless it says "reset after …".
fn spent(printed: &str, said: &str) -> Option<quota::Back> {
    let last = printed.trim_end().lines().last().unwrap_or_default();
    let result: Value = serde_json::from_str(last).unwrap_or_default();
    let error = result.pointer("/result/error").and_then(Value::as_str);
    let text = error.unwrap_or(said);
    let words = [
        "exhausted your quota",
        "exhausted your capacity",
        "RESOURCE_EXHAUSTED",
        "Quota exceeded",
    ];
    words
        .iter()
        .any(|w| text.contains(w))
        .then(|| quota::back(text))
}

impl Agent for Antigravity {
    fn id(&self) -> &'static str {
        "agy"
    }

    fn name(&self) -> &'static str {
        "Antigravity"
    }

    /// Its title script is a command it runs through `sh -c`. What it runs
    /// it through on Windows is not known and could not be tried there, so
    /// there it is listed and says that it does not run yet.
    fn supported(&self) -> bool {
        !cfg!(windows)
    }

    fn program(&self) -> &'static str {
        "agy"
    }

    /// What it asks, it asks in its terminal: the notch shows it and the
    /// person answers there.
    fn caps(&self) -> Caps {
        Caps {
            events: true,
            resume: true,
            permissions: Some(ReplyVia::Terminal),
            questions: Some(ReplyVia::Terminal),
        }
    }

    fn launch(&self, run: &Run) -> Vec<String> {
        let mut argv = vec![self.program().to_owned()];
        // Also for a resume: it continues a conversation on the person's
        // usual model, not on the one the conversation had.
        if let Some(model) = run.model {
            argv.extend(["--model".into(), model.into()]);
        }
        argv.extend(["--settings".into(), settings(run.hook, Some(run.cwd))]);
        if let Some(handle) = run.resume {
            argv.extend(["--conversation".into(), handle.into()]);
        }
        argv.extend(["--prompt-interactive".into(), run.told(self)]);
        argv
    }

    fn attach(&self, exe: &Path, _: &Path) -> Vec<OsString> {
        vec!["--settings".into(), settings(exe, None).into()]
    }

    /// `agy -p` (1.5) with the question as one message on standard input,
    /// which is the only way it reads one there, and the answer held to the
    /// schema. It has no flag that takes its tools away, leaves the
    /// conversation unsaved or passes over the person's rules: it asks
    /// before it changes anything, which nobody answers here, and every
    /// question is a conversation in the person's history.
    fn headless(&self) -> Option<Headless> {
        Some(Headless {
            model: SMALL,
            limit: Duration::from_secs(15),
            #[rustfmt::skip]
            args: |schema| {
                ["--model", SMALL, "--input-format", "stream-json", "--output-format",
                 "stream-json", "--disable-slash-commands", "--json-schema", schema.text,
                 "--print", ""]
                .map(Into::into)
                .into()
            },
            stdin: |question| {
                let text = json!({ "type": "text", "text": question });
                let message = json!({ "role": "user", "content": [text] });
                format!("{}\n", json!({ "event": "user", "message": message }))
            },
            answer,
            // Its result says so, and lists the models it does have.
            gone: |printed, _| printed.contains("is not recognized as a known model"),
            quota: spent,
        })
    }

    /// The person's words after a rule, as Codex is told them.
    fn told(&self, brief: &str, words: &str) -> String {
        format!("{brief}\n\n---\n{WORDS}\n\n{words}")
    }

    /// Its sign-in is in the system's keyring; a key signs in the one who
    /// set it to ask Gemini's API itself.
    fn variables(&self) -> &'static [&'static str] {
        &["GEMINI_API_KEY"]
    }

    /// Its folder-trust dialog, shown before anything else in a folder it
    /// does not trust. A run the core starts is told its folder is trusted,
    /// so only an agent typed by hand shows it.
    fn prompts(&self) -> &'static [Prompt] {
        &[
            Prompt {
                shows: "Do you trust the contents of this project?",
                asks: "Antigravity is asking whether to trust this folder",
            },
            // Signed out, it stops here before anything else and no state
            // follows: a run started while detection could not tell.
            Prompt {
                shows: "Select login method:",
                asks: "Antigravity is asking you to sign in",
            },
        ]
    }

    fn detect(&self) -> Detect {
        Detect {
            // "1.5.11"
            version: &["--version"],
            version_of: |out| out.split_whitespace().next().map(Into::into),
            // It has no command that says who is signed in. Listing its
            // models needs the sign-in and nothing else: a model to a line,
            // or "Please sign in to view available models" and exit 1.
            account: &["models"],
            account_of: |code, out| match code {
                Some(0) if out.lines().any(|l| l.contains('\t')) => (Some(true), None),
                Some(1) if out.contains("Please sign in") => (Some(false), None),
                _ => (None, None),
            },
        }
    }

    fn event(&self, _: &[String], payload: &[u8]) -> Result<Option<Heard>, String> {
        let p = Payload::parse(payload)?;
        let Some(state) = p.str("agent_state") else {
            return Ok(None);
        };
        let resume = p.str("conversation_id");
        let spoken = p
            .get("context_window")
            .and_then(|w| w.get("total_output_tokens"));
        let spoken = spoken.and_then(Value::as_u64).unwrap_or(0);
        let id = |what: &str| format!("{what}:{}:{spoken}", resume.unwrap_or_default());
        let read = |heard: Heard| match heard {
            Heard::Event(event) => Heard::Read {
                event,
                files: transcripts(&p),
                fill,
            },
            other => other,
        };
        let question = |ask: Ask| {
            let question = Event::Question { question: ask };
            said(id("question"), false, resume, question)
        };
        let heard = match (state, resume) {
            ("idle", None) => said("ready".into(), false, None, Event::Ready),
            (_, None) => return Ok(None),
            // Idle with nothing said in the whole conversation: it could not
            // work at all, as with no network, and its terminal says why.
            ("idle", _) if spoken == 0 => {
                let error = Some("It went idle without an answer; its terminal says why".into());
                said(id("idle"), false, resume, Event::TurnFailed { error })
            }
            ("idle", _) => read(said(
                id("idle"),
                false,
                resume,
                Event::TurnFinished { answer: None },
            )),
            ("error", _) => read(said(
                id("error"),
                false,
                resume,
                Event::TurnFailed { error: None },
            )),
            ("tool_use", _) if p.get("tool_confirmation_pending") == Some(&Value::Bool(true)) => {
                let prompt = "Antigravity is asking for an approval in its terminal";
                let source = Some(QuestionSource::Permission);
                read(question(waits(id("question"), prompt, source)))
            }
            ("reviewing", _) => {
                let prompt = "Antigravity is waiting for your review in its terminal";
                question(waits(id("question"), prompt, None))
            }
            ("working", _) => said(
                id("working"),
                false,
                resume,
                Event::TurnStarted { prompt: None },
            ),
            ("tool_use", _) => read(said(
                id("working"),
                false,
                resume,
                Event::TurnStarted { prompt: None },
            )),
            _ => return Ok(None),
        };
        Ok(Some(heard))
    }

    /// Nothing it asks is answered through a hook.
    fn reply(&self, _: &[String], _: &[u8], _: &tasktap_proto::Answer) -> Option<String> {
        None
    }
}
