//! A program of the system run to its end within bounds: its input given
//! whole, its output kept up to a limit, its time limited, and stoppable
//! from another thread. The web calls (`http.rs`) and the credential tools
//! (`secrets.rs`) run so. It blocks, so the core calls it on a thread of
//! its own; the program is ended whenever it is not waited for any more.

use std::io::{ErrorKind, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

/// Most bytes kept of what a program says beside its output.
const MAX_ERR: u64 = 64 << 10;

/// What ends the wait for a program.
pub enum Signal {
    /// Everything it printed on standard output.
    Out(Vec<u8>),
    /// Nobody wants its output any more.
    Stop,
}

/// Both ends of the channel a run waits on. Whoever keeps a copy of the
/// sender can stop the run, before it began too.
pub type Wait = (Sender<Signal>, Receiver<Signal>);

/// A program that ran to its end.
pub struct Ran {
    /// None when a signal ended it.
    pub code: Option<i32>,
    pub out: Vec<u8>,
    /// What it said on standard error.
    pub err: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Failed {
    /// The system has no such program.
    Missing,
    /// It could not be started.
    Start(String),
    /// It did not end within its time.
    Slow,
    /// It was stopped.
    Stopped,
    /// It printed more than was asked for.
    Large,
}

/// Runs `command` with `input` on its standard input and returns once it
/// ended, with at most `most` bytes of output. After `limit`, or on a
/// [`Signal::Stop`], it is ended at once.
pub fn run(
    mut command: Command,
    input: Vec<u8>,
    limit: Duration,
    most: usize,
    (hear, heard): Wait,
) -> Result<Ran, Failed> {
    let deadline = Instant::now() + limit;
    let piped = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let (mut child, tree) = crate::sys::Tree::spawn(piped).map_err(|e| match e.kind() {
        ErrorKind::NotFound => Failed::Missing,
        _ => Failed::Start(e.to_string()),
    })?;
    let (stdin, out, err) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    // Written beside the reading, so a program that prints before it has
    // read everything never stops both.
    std::thread::spawn(move || {
        if let Some(mut stdin) = stdin {
            let _ = stdin.write_all(&input);
        }
    });
    std::thread::spawn(move || {
        let mut printed = Vec::new();
        if let Some(out) = out {
            let _ = out.take(most as u64 + 1).read_to_end(&mut printed);
        }
        let _ = hear.send(Signal::Out(printed));
    });
    let said = std::thread::spawn(move || {
        let mut said = Vec::new();
        if let Some(err) = err {
            let _ = err.take(MAX_ERR).read_to_end(&mut said);
        }
        String::from_utf8_lossy(&said).into_owned()
    });
    let out = match heard.recv_timeout(limit) {
        Ok(Signal::Out(out)) if out.len() <= most => Ok(out),
        Ok(Signal::Out(_)) => Err(Failed::Large),
        Ok(Signal::Stop) | Err(RecvTimeoutError::Disconnected) => Err(Failed::Stopped),
        Err(RecvTimeoutError::Timeout) => Err(Failed::Slow),
    };
    let out = out.inspect_err(|_| end(&mut child, &tree))?;
    // Its output ended, so it is about to: its code is waited for.
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(2)),
            _ => {
                end(&mut child, &tree);
                return Err(Failed::Slow);
            }
        }
    };
    let err = said.join().unwrap_or_default();
    Ok(Ran { code, out, err })
}

/// Ends the program and, on Windows, what it started.
fn end(child: &mut Child, tree: &crate::sys::Tree) {
    tree.kill();
    let _ = child.kill();
    let _ = child.wait();
}
