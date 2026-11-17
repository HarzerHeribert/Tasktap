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

use super::{Agent, Probe, fit};

/// Longest one detection command runs.
pub const LIMIT: Duration = Duration::from_secs(4);
/// Longest a probe runs (1.2 allowed Codex's app server 12 s).
pub const PROBE_LIMIT: Duration = Duration::from_secs(12);
/// Most bytes read from a check's output.
const MAX_OUTPUT: u64 = 4 << 20;

/// Whether `agent` is installed and signed in, as its own commands say.
pub fn detect(agent: &dyn Agent) -> AgentHealth {
    let caps = agent.caps();
    let mut health = AgentHealth {
        id: agent.id().into(),
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
    let mut child = command(&program, args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{name} could not run: {e}"))?;
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
    end(&mut child);
    result
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
    let mut child = command(program, args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
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
                end(&mut child);
                return Err(format!("it did not answer within {} s", LIMIT.as_secs()));
            }
        }
    }
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                end(&mut child);
                break None;
            }
        }
    };
    Ok((code, String::from_utf8_lossy(&text).into_owned()))
}

fn end(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}
