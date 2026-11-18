//! The checks that run an agent's own program, as its adapter describes
//! them (design §7): whether it is installed and signed in, and the probe a
//! run of some agents needs before it starts. Each blocks, so the core runs
//! them on threads of their own; each ends its program when its time is up.
//! The programs get the environment the core's terminals get, without the
//! core's own variables, and are found on the same PATH.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use tasktap_proto::AgentHealth;

use super::{Agent, Headless, Probe, Schema, fit, line};

/// Longest one detection command runs.
pub const LIMIT: Duration = Duration::from_secs(4);
/// Longest a probe runs (1.2 allowed Codex's app server 12 s).
pub const PROBE_LIMIT: Duration = Duration::from_secs(12);
/// Most bytes read from a check's output.
const MAX_OUTPUT: u64 = 4 << 20;
/// Most bytes of an answer to a headless question; more is no answer.
const MAX_ANSWER: u64 = 64 << 10;

/// Why a headless question got no answer.
#[derive(Debug, PartialEq, Eq)]
pub enum Failed {
    /// Its tool no longer offers the model it is asked for.
    Gone,
    Why(String),
}

impl From<String> for Failed {
    fn from(why: String) -> Failed {
        Failed::Why(why)
    }
}

/// What ends the wait for a headless question's answer.
pub enum Asked {
    /// Everything it printed on standard output.
    Printed(Vec<u8>),
    /// Nobody wants the answer any more.
    Stop,
}

/// Whether `agent` is installed and signed in, as its own commands say.
pub fn detect(agent: &dyn Agent) -> AgentHealth {
    let caps = agent.caps();
    let mut health = AgentHealth {
        id: agent.id().into(),
        // Stamped once the collection takes the row.
        rev: tasktap_proto::Rev::ZERO,
        checked: tasktap_proto::Time::ZERO,
        installed: false,
        version: None,
        signed_in: None,
        identity: None,
        events: caps.events,
        resume: caps.resume,
        permissions: caps.permissions,
        questions: caps.questions,
    };
    let Some(program) = crate::terminal::find(agent.program()) else {
        return health;
    };
    health.installed = true;
    let checks = agent.detect();
    if let Ok((_, out)) = output(&program, checks.version) {
        health.version = (checks.version_of)(&out).map(|v| fit(&v, 200));
    }
    if let Ok((code, out)) = output(&program, checks.account) {
        let (signed_in, identity) = (checks.account_of)(code, &out);
        health.signed_in = signed_in;
        health.identity = identity.map(|i| fit(&i, 200));
    }
    health
}

/// [`detect`] for each of `agents`, all at once, each on a thread of its own.
pub fn detect_all(agents: &[&'static dyn Agent]) -> Vec<AgentHealth> {
    std::thread::scope(|scope| {
        let checks: Vec<_> = (agents.iter())
            .map(|agent| scope.spawn(|| detect(*agent)))
            .collect();
        let found = checks.into_iter().filter_map(|c| c.join().ok());
        found.collect()
    })
}

/// Runs a probe in `cwd` and returns the arguments it adds to the run.
pub fn probe(mut probe: Probe, cwd: &Path) -> Result<Vec<String>, String> {
    let Some((name, args)) = probe.argv.split_first() else {
        return Err("the check names no program".into());
    };
    // A shim names the agent it found itself.
    let program = match Path::new(name).is_absolute() {
        true => Some(Path::new(name).to_owned()),
        false => crate::terminal::find(name),
    };
    let program =
        program.ok_or_else(|| format!("{name} is not installed: no folder of the PATH has it"))?;
    let spawned = crate::sys::Tree::spawn(
        command(&program, args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null()),
    );
    let (mut child, tree) = spawned.map_err(|e| format!("{name} could not run: {e}"))?;
    // Kept open until the end: a server may take its input's end as the
    // sign to stop before it answered.
    let mut input = child.stdin.take();
    if let Some(stdin) = &mut input {
        let _ = stdin.write_all(probe.input.as_bytes());
        let _ = stdin.flush();
    }
    let (lines, read) = mpsc::channel();
    let out = child.stdout.take();
    std::thread::spawn(move || {
        let Some(out) = out else { return };
        for line in BufReader::new(out.take(MAX_OUTPUT)).lines() {
            if lines.send(line).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + PROBE_LIMIT;
    let result = loop {
        match read.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Ok(line)) => {
                if let Some(done) = (probe.read)(&line) {
                    break done;
                }
            }
            Ok(Err(e)) => break Err(format!("{name} could not be read: {e}")),
            Err(RecvTimeoutError::Timeout) => {
                let secs = PROBE_LIMIT.as_secs();
                break Err(format!("{name} did not answer within {secs} s"));
            }
            Err(RecvTimeoutError::Disconnected) => {
                break Err(format!("{name} ended without an answer"));
            }
        }
    };
    drop(input);
    end(&mut child, &tree);
    result
}

/// Asks `agent`'s tool one question (design §8): `question` on its standard
/// input, in `folder`, which is made if it is not there and holds nothing
/// but the schema's file, within the time its adapter gives it. The answer
/// is the JSON text its adapter reads from what it printed. A `Stop` sent
/// to `heard`, whose other end is `hear`, ends the tool at once.
pub fn ask(
    agent: &dyn Agent,
    how: &Headless,
    question: String,
    schema: &str,
    folder: &Path,
    (hear, heard): (mpsc::Sender<Asked>, mpsc::Receiver<Asked>),
) -> Result<String, Failed> {
    let name = agent.program();
    let program = crate::terminal::find(name)
        .ok_or_else(|| format!("{name} is not installed: no folder of the PATH has it"))?;
    let file = folder.join("schema.json");
    // Written whole or not at all, since another question may read it now.
    if std::fs::read_to_string(&file).ok().as_deref() != Some(schema) {
        let new = folder.join(format!("schema.{}.json", std::process::id()));
        std::fs::create_dir_all(folder)
            .and_then(|()| std::fs::write(&new, schema))
            .and_then(|()| std::fs::rename(&new, &file))
            .map_err(|e| format!("its folder could not be written: {e}"))?;
    }
    let schema = Schema {
        text: schema,
        file: &file,
    };
    let spawned = crate::sys::Tree::spawn(
        command(&program, &(how.args)(&schema))
            .current_dir(folder)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    );
    let (mut child, tree) = spawned.map_err(|e| format!("{name} could not run: {e}"))?;
    let (input, mut out, err) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let question = (how.stdin)(&question);
    // The question is written beside the reading, so a tool that prints
    // before it has read everything never stops both.
    std::thread::spawn(move || {
        if let Some(mut input) = input {
            let _ = input.write_all(question.as_bytes());
        }
    });
    // The answer is taken as soon as it is whole: a tool may stay on long
    // after it printed it (Claude Code was seen to, for 8 minutes).
    let whole = how.answer;
    std::thread::spawn(move || {
        let (mut printed, mut chunk) = (Vec::new(), [0; 8192]);
        while let Some(Ok(n @ 1..)) = out.as_mut().map(|out| out.read(&mut chunk)) {
            printed.extend_from_slice(&chunk[..n]);
            let large = printed.len() as u64 > MAX_ANSWER;
            if large || whole(&String::from_utf8_lossy(&printed)).is_ok() {
                break;
            }
        }
        let _ = hear.send(Asked::Printed(printed));
    });
    // What it says beside its answer is read to its end, and only the end
    // of it kept: the last line says why a tool gave no answer.
    let said = std::thread::spawn(move || {
        let mut tail = Vec::new();
        if let Some(err) = err {
            for line in BufReader::new(err.take(MAX_OUTPUT))
                .lines()
                .map_while(Result::ok)
            {
                if !line.trim().is_empty() {
                    tail = line.into_bytes();
                }
            }
        }
        String::from_utf8_lossy(&tail).into_owned()
    });
    let printed = match heard.recv_timeout(how.limit) {
        Ok(Asked::Printed(printed)) => Ok(printed),
        Ok(Asked::Stop) | Err(RecvTimeoutError::Disconnected) => {
            Err("it was not waited for".to_owned())
        }
        Err(RecvTimeoutError::Timeout) => Err(format!(
            "it did not answer within {} s",
            how.limit.as_secs()
        )),
    };
    // It has printed everything or is no longer wanted: either way it ends.
    end(&mut child, &tree);
    let printed = printed?;
    if printed.len() as u64 > MAX_ANSWER {
        return Err("its answer is too large".to_owned().into());
    }
    let printed = String::from_utf8_lossy(&printed);
    (how.answer)(&printed).map_err(|why| {
        let said = said.join().unwrap_or_default();
        match said.trim() {
            _ if (how.gone)(&printed, &said) => Failed::Gone,
            "" => Failed::Why(why),
            last => Failed::Why(format!("{why} ({})", line(last, 200))),
        }
    })
}

/// `program` with `args` in the checks' environment.
fn command(program: &Path, args: &[impl AsRef<std::ffi::OsStr>]) -> Command {
    let mut command = Command::new(program);
    command
        .args(args)
        .env_clear()
        .envs(crate::terminal::environment_of_checks());
    command
}

/// Runs `program` with `args`, and returns its exit code and what it
/// printed on either output, within [`LIMIT`].
fn output(program: &Path, args: &[&str]) -> Result<(Option<i32>, String), String> {
    let spawned = crate::sys::Tree::spawn(
        command(program, args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    );
    let (mut child, tree) = spawned.map_err(|e| e.to_string())?;
    let (done, ended) = mpsc::channel();
    for out in [
        child
            .stdout
            .take()
            .map(|o| Box::new(o) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|e| Box::new(e) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let done = done.clone();
        std::thread::spawn(move || {
            let mut text = Vec::new();
            let _ = out.take(MAX_OUTPUT).read_to_end(&mut text);
            let _ = done.send(text);
        });
    }
    drop(done);
    let deadline = Instant::now() + LIMIT;
    let mut text = Vec::new();
    for _ in 0..2 {
        match ended.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(part) => text.extend(part),
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {
                end(&mut child, &tree);
                return Err(format!("it did not answer within {} s", LIMIT.as_secs()));
            }
        }
    }
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                end(&mut child, &tree);
                break None;
            }
        }
    };
    Ok((code, String::from_utf8_lossy(&text).into_owned()))
}

/// Ends the program and, on Windows, what it started: a tool installed as
/// a batch file is the command prompt running the tool.
fn end(child: &mut Child, tree: &crate::sys::Tree) {
    tree.kill();
    let _ = child.kill();
    let _ = child.wait();
}
