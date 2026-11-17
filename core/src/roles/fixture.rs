//! `tasktap fixture-agent`: the scripted stand-in agent of the tests (design
//! §13), in a build with the test fixtures only. It behaves as a real agent
//! does in any terminal, on every system, with no shell script: it reports
//! through its hooks, which a launch or a shim attaches as `--hook <exe>`,
//! by running `<exe> hook fixture` with the payload on standard input.
//!
//! `tasktap fixture-agent [--hook EXE] [STEP]...` first prints
//! `fixture-agent` and its arguments, then runs the steps in order; with
//! none among its arguments, it reads them one per line from standard input.
//! Other arguments, an agent's flags and subcommands, are ignored.
//!
//! | Step | Does |
//! | --- | --- |
//! | `print:TEXT` | prints the text |
//! | `event:KIND[:TEXT]` | reports the event, the text in the field its kind has |
//! | `ask:PROMPT` | asks through a hook that waits, and prints `answer:` and what it printed |
//! | `wait` | reads a line of standard input and prints `read:` and the line |
//! | `sleep:MS` | sleeps |
//! | `nohup` | ignores hang-up from then on |
//! | `exit:CODE` | exits with the code; after the last step it exits with 0 |
//!
//! Without a hook, as when it runs unobserved, `event` and `ask` do nothing.

use std::ffi::OsString;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::{Command, ExitCode, Stdio};
use std::time::Duration;

use serde_json::{Value, json};

/// The test agent's name: its shim and `tasktap hook fixture`.
pub const AGENT: &str = "fixture";
/// Set by a shim on the agent it runs: the program named [`AGENT`] that sees
/// it is the agent itself, not another shim.
pub const REAL: &str = "TASKTAP_FIXTURE_AGENT";
/// Set by a test: a shim takes pipes for a terminal a person types in.
pub const TTY: &str = "TASKTAP_FIXTURE_TTY";

const STEPS: [&str; 7] = ["print", "event", "ask", "wait", "sleep", "nohup", "exit"];

pub fn run(args: Vec<OsString>) -> ExitCode {
    let args: Vec<String> = (args.iter())
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    println!("fixture-agent {}", args.join(" "));
    let mut hook = None;
    let mut steps = Vec::new();
    let mut given = args.into_iter();
    while let Some(arg) = given.next() {
        match arg.as_str() {
            "--hook" => hook = given.next().map(PathBuf::from),
            step if STEPS.contains(&step.split(':').next().unwrap_or_default()) => steps.push(arg),
            _ => {}
        }
    }
    let mut lines = io::stdin().lock().lines();
    let scripted = !steps.is_empty();
    let mut steps = steps.into_iter();
    let mut asked = 0;
    loop {
        let step = match scripted {
            true => steps.next(),
            false => lines.next().and_then(Result::ok),
        };
        let Some(step) = step else {
            return ExitCode::SUCCESS;
        };
        let (verb, rest) = step.split_once(':').unwrap_or((step.as_str(), ""));
        asked += 1;
        match verb {
            "print" => println!("{rest}"),
            "event" => {
                let (kind, text) = rest.split_once(':').unwrap_or((rest, ""));
                if let Some(hook) = &hook {
                    let payload = said(kind, text, asked);
                    hooked(hook, &payload);
                }
            }
            "ask" => {
                if let Some(hook) = &hook {
                    let mut payload = said("question", rest, asked);
                    payload["wait"] = true.into();
                    let (code, out) = hooked(hook, &payload);
                    match code {
                        Some(0) => println!("answer:{}", out.trim_end()),
                        code => println!("no answer:{}", code.unwrap_or(-1)),
                    }
                }
            }
            "wait" => {
                let line = lines.next().and_then(Result::ok).unwrap_or_default();
                println!("read:{line}");
            }
            "sleep" => std::thread::sleep(Duration::from_millis(rest.parse().unwrap_or(0))),
            "nohup" => crate::sys::ignore_hangup(),
            "exit" => return ExitCode::from(rest.parse::<u8>().unwrap_or(0)),
            "" if !scripted => {}
            _ => {
                eprintln!("fixture-agent: no step {verb}");
                return ExitCode::from(super::USAGE);
            }
        }
        let _ = io::stdout().flush();
    }
}

/// The payload of one hook: a `session.event`'s arguments.
fn said(kind: &str, text: &str, n: usize) -> Value {
    let id = format!("{}-{n}", std::process::id());
    let mut said = json!({ "id": id, "kind": kind });
    let text = Some(text).filter(|t| !t.is_empty());
    match kind {
        "turn_started" => said["prompt"] = text.into(),
        "activity" => said["text"] = text.unwrap_or_default().into(),
        "turn_finished" => said["answer"] = text.into(),
        "turn_failed" => said["error"] = text.into(),
        "exited" => said["code"] = text.and_then(|t| t.parse::<u32>().ok()).into(),
        "question" => {
            said["question"] = json!({ "request": id, "kind": "confirm", "prompt": text });
        }
        _ => {}
    }
    said
}

/// Runs the hook as an agent does, and returns its exit code and output.
fn hooked(hook: &PathBuf, payload: &Value) -> (Option<i32>, String) {
    let child = Command::new(hook)
        .args(["hook", AGENT])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn();
    let Ok(mut child) = child else {
        return (None, String::new());
    };
    if let Some(mut input) = child.stdin.take() {
        let _ = input.write_all(payload.to_string().as_bytes());
    }
    match child.wait_with_output() {
        Ok(out) => (
            out.status.code(),
            String::from_utf8_lossy(&out.stdout).into(),
        ),
        Err(_) => (None, String::new()),
    }
}
