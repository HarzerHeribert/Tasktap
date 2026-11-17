//! `tasktap fixture-agent`: the scripted stand-in agent of the tests (design
//! §13), in a build with the test fixtures only. It behaves as a real agent
//! does in any terminal, on every system, with no shell script: it reports
//! through its hooks, which a launch or a shim attaches as `--hook <exe>`,
//! by running `<exe> hook fixture` with the payload on standard input.
//!
//! `tasktap fixture-agent [--hook EXE] [STEP]...`, or the same program named
//! `fixture-agent` as the core launches it, first prints `fixture-agent` and
//! its arguments, then runs the steps in order; with none among its
//! arguments, it reads them one per line from standard input. Other
//! arguments, an agent's flags and subcommands, are ignored.
//!
//! | Step | Does |
//! | --- | --- |
//! | `print:TEXT` | prints the text |
//! | `keep:PATH` | writes everything on its standard input to the file at `PATH` in its working folder, and prints `kept:` and the path |
//! | `script:PATH` | runs the steps the file at `PATH` in its working folder holds, one per line, before any that follow; without the file it prints `error:` and why, and exits with 1 |
//! | `write:PATH:TEXT` | writes the text, `\n` in it a line break, to the file at `PATH` in its working folder, making its folders; prints `wrote:` and the path |
//! | `event:KIND[:TEXT]` | reports the event, the text in the field its kind has; `\n` in it is a line break |
//! | `ask:PROMPT` | asks through a hook that waits, and prints `answer:` and what it printed |
//! | `wait` | reads a line of standard input and prints `read:` and the line |
//! | `sleep:MS` | sleeps |
//! | `nohup` | ignores hang-up from then on |
//! | `detach:MS` | prints `detaching`, lets go of its terminal (its standard input, output and error become the null device) and sleeps; Mac and Linux |
//! | `stall:MS` | prints `stalling`, makes its terminal raw, so input it does not read fills the terminal, sleeps and exits with 0, having read none (Mac and Linux) |
//! | `query` | asks its terminal what it is, where the cursor is and its two colors, as a program that waits for the answers does, and prints `answered:` and the answers, escaped (Mac and Linux) |
//! | `exit:CODE` | exits with the code; after the last step it exits with 0 |
//!
//! A line of standard input that is no step, or that was pasted as a
//! terminal pastes (bracketed paste), is a prompt, as one typed into a real
//! agent: it prints `prompt:` and the text and reports `turn_started` with
//! it. Lines read by `wait` lose their paste brackets too.
//!
//! Without a hook, as when it runs unobserved, `event` and `ask` do nothing.

use std::ffi::{OsStr, OsString};
use std::io::{self, BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::Duration;

use serde_json::{Value, json};

/// The test agent's name: its shim and `tasktap hook fixture`.
pub const AGENT: &str = "fixture";
/// The program the core launches for it: this binary under that name.
pub const PROGRAM: &str = "fixture-agent";
/// Set by a shim on the agent it runs: the program named [`AGENT`] that sees
/// it is the agent itself, not another shim.
pub const REAL: &str = "TASKTAP_FIXTURE_AGENT";
/// Set by a test: a shim takes pipes for a terminal a person types in.
pub const TTY: &str = "TASKTAP_FIXTURE_TTY";

const STEPS: [&str; 13] = [
    "print", "event", "ask", "wait", "sleep", "nohup", "detach", "stall", "query", "write", "exit",
    "keep", "script",
];
/// What `query` asks: primary and secondary device attributes, the cursor
/// position, and the foreground and background colors, one ended with ST
/// and one with BEL.
const QUERIES: &str = "\x1b[c\x1b[>c\x1b[6n\x1b]10;?\x1b\\\x1b]11;?\x07";
const PASTED: (&str, &str) = ("\x1b[200~", "\x1b[201~");

/// Whether this program runs as [`PROGRAM`].
pub fn named(program: &OsStr) -> bool {
    Path::new(program).file_stem() == Some(OsStr::new(PROGRAM))
}

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
    let mut input = io::stdin().lock();
    let scripted = !steps.is_empty();
    let mut steps = std::collections::VecDeque::from(steps);
    let mut asked = 0;
    loop {
        let step = match scripted {
            true => steps.pop_front(),
            false => line(&mut input),
        };
        let Some(step) = step else {
            return ExitCode::SUCCESS;
        };
        let (verb, rest) = step.split_once(':').unwrap_or((step.as_str(), ""));
        asked += 1;
        // Pasted, or with its brackets taken by a Windows console.
        let prompt = pasted(&step).or((!scripted && !STEPS.contains(&verb)).then_some(&*step));
        if let Some(prompt) = prompt.filter(|p| !p.is_empty()) {
            println!("prompt:{prompt}");
            if let Some(hook) = &hook {
                hooked(hook, &said("turn_started", prompt, asked));
            }
            let _ = io::stdout().flush();
            continue;
        }
        match verb {
            "print" => println!("{rest}"),
            "write" => {
                let (path, text) = rest.split_once(':').unwrap_or((rest, ""));
                let path = Path::new(path);
                let folder = path.parent().filter(|p| !p.as_os_str().is_empty());
                let made = folder.map_or(Ok(()), std::fs::create_dir_all);
                match made.and_then(|()| std::fs::write(path, text.replace("\\n", "\n"))) {
                    Ok(()) => println!("wrote:{}", path.display()),
                    Err(e) => println!("not written:{e}"),
                }
            }
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
            "keep" => {
                let mut all = Vec::new();
                let _ = io::Read::read_to_end(&mut input, &mut all);
                match std::fs::write(rest, all) {
                    Ok(()) => println!("kept:{rest}"),
                    Err(e) => println!("not kept:{e}"),
                }
            }
            "script" => match std::fs::read_to_string(rest) {
                Ok(script) => script
                    .lines()
                    .rev()
                    .for_each(|step| steps.push_front(step.to_owned())),
                Err(e) => {
                    println!("error:no steps in {rest}: {e}");
                    return ExitCode::FAILURE;
                }
            },
            "wait" => {
                let line = line(&mut input).unwrap_or_default();
                println!("read:{}", pasted(&line).unwrap_or(&line));
            }
            "sleep" => std::thread::sleep(Duration::from_millis(rest.parse().unwrap_or(0))),
            "nohup" => crate::sys::ignore_hangup(),
            "stall" => {
                println!("stalling");
                let _ = io::stdout().flush();
                let _ = Command::new("stty").args(["raw", "-echo"]).status();
                std::thread::sleep(Duration::from_millis(rest.parse().unwrap_or(0)));
                return ExitCode::SUCCESS;
            }
            "detach" => {
                println!("detaching");
                let _ = io::stdout().flush();
                crate::sys::let_go();
                std::thread::sleep(Duration::from_millis(rest.parse().unwrap_or(0)));
            }
            "query" => println!("answered:{}", query(&mut input).escape_ascii()),
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

/// The next line of standard input, without its line break, as `lines` reads it.
fn line(input: &mut io::StdinLock) -> Option<String> {
    let mut line = String::new();
    input.read_line(&mut line).ok().filter(|&n| n > 0)?;
    let line = line.strip_suffix('\n').unwrap_or(&line);
    Some(line.strip_suffix('\r').unwrap_or(line).to_owned())
}

/// Asks the terminal [`QUERIES`] with its input raw, as a program that
/// draws its own screen does, and waits for an answer to each.
fn query(input: &mut io::StdinLock) -> Vec<u8> {
    let modes = crate::sys::modes();
    let raw = Command::new("stty").args(["raw", "-echo"]).status();
    if !raw.is_ok_and(|s| s.success()) {
        return b"no raw terminal".to_vec();
    }
    print!("{QUERIES}");
    let _ = io::stdout().flush();
    // Each answer is a CSI sequence or an OSC one, ended with BEL or ST.
    let (mut got, mut answers, mut byte) = (Vec::new(), 0, [0]);
    while answers < 5 && input.read(&mut byte).is_ok_and(|n| n == 1) {
        got.push(byte[0]);
        let csi = got.iter().rposition(|&b| b == 0x1b).is_some_and(|at| {
            let seq = &got[at..];
            seq.len() > 2 && seq[1] == b'[' && (0x40..=0x7e).contains(&byte[0])
        });
        let osc = byte[0] == 0x07 || got.ends_with(b"\x1b\\");
        if csi || osc {
            answers += 1;
        }
    }
    if let Some(modes) = modes {
        crate::sys::restore(&modes, false);
    }
    got
}

/// The text of a line pasted as a terminal pastes, without its brackets.
fn pasted(line: &str) -> Option<&str> {
    let line = line.trim_end_matches('\r');
    line.strip_prefix(PASTED.0)?.strip_suffix(PASTED.1)
}

/// The payload of one hook: a `session.event`'s arguments.
fn said(kind: &str, text: &str, n: usize) -> Value {
    let id = format!("{}-{n}", std::process::id());
    let mut said = json!({ "id": id, "kind": kind });
    let text = text.replace("\\n", "\n");
    let text = Some(text.as_str()).filter(|t| !t.is_empty());
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
