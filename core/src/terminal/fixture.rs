//! `tasktap fixture-terminal <step>…`: a program to run in a terminal under
//! test, the same on every platform, so the terminal tests need no shell
//! tools (design §13). Only a build with the test fixtures has it.
//!
//! Each argument is one step, run in order: `print <n>` writes the next `n`
//! lines of [`line`]; `serve` answers each line of input until it ends (a
//! number prints that many more lines, `size` the terminal's size, `exit
//! <code>` exits, `sum` the count and [`fold`] of the other lines so far,
//! which come back as `<text>`); `env` lists, as `env:<name>|`, the
//! names of its environment; `find <program>` prints, as `found:<path>|`,
//! where its PATH finds the program; `sleep <ms>`; `ignore-hup`; `spawn <steps>`
//! starts this role again with the steps given, separated by `;`, in the
//! same process group and away from the terminal; `lock <file>` holds an
//! exclusive lock on the file until the process ends; `mark <file>` adds a
//! line to the file; `exit <code>`.

use std::ffi::OsString;
use std::io::{self, BufRead, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

/// Line `i` of what `print` writes, without its line ending: printable and
/// shorter than a terminal is wide, so no terminal alters it.
pub fn line(i: u64) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-";
    let body = (0..63).map(|j| ALPHABET[((i * 7 + j * 13) % 64) as usize] as char);
    format!("{:08} {}", i % 100_000_000, body.collect::<String>())
}

pub fn run(args: impl Iterator<Item = OsString>) -> Result<(), String> {
    let steps: Vec<String> = args.map(|a| a.to_string_lossy().into_owned()).collect();
    let mut out = io::BufWriter::new(io::stdout().lock());
    let mut next = 0;
    // Locks are held until the process ends.
    let mut held = Vec::new();
    for step in &steps {
        let (name, arg) = step.split_once(' ').unwrap_or((step, ""));
        let number = || {
            arg.trim()
                .parse::<u64>()
                .map_err(|_| format!("{name} needs a number"))
        };
        match name {
            "print" => print(&mut out, &mut next, number()?)?,
            "serve" => serve(&mut out, &mut next)?,
            "env" => {
                let mut keys: Vec<_> = std::env::vars_os().map(|(k, _)| k).collect();
                keys.sort();
                // Each name ends with `|`, which no line break a terminal
                // makes can hide.
                for key in keys {
                    writeln!(out, "env:{}|", key.to_string_lossy()).map_err(text)?;
                }
            }
            "find" => {
                let path = std::env::var_os("PATH").unwrap_or_default();
                let found = crate::roles::shim::find(arg, &path, |_, _| true);
                let found = found.map(|f| f.display().to_string()).unwrap_or_default();
                writeln!(out, "found:{found}|").map_err(text)?;
            }
            "sleep" => std::thread::sleep(Duration::from_millis(number()?)),
            "ignore-hup" => ignore_hang_up()?,
            "spawn" => {
                let mut child = Command::new(std::env::current_exe().map_err(text)?);
                child.arg("fixture-terminal").args(arg.split(';'));
                child
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                #[cfg(windows)]
                {
                    // Without a console, closing the terminal's leaves it
                    // running: only its job can end it.
                    use std::os::windows::process::CommandExt;
                    child.creation_flags(0x0000_0008); // DETACHED_PROCESS
                }
                child.spawn().map_err(text)?;
            }
            "lock" => {
                let file = std::fs::File::create(arg).map_err(text)?;
                file.lock().map_err(text)?;
                held.push(file);
            }
            "mark" => {
                let mut file = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(arg);
                writeln!(file.as_mut().map_err(text)?, "ran").map_err(text)?;
            }
            "exit" => {
                out.flush().map_err(text)?;
                std::process::exit(number()? as i32);
            }
            _ => return Err(format!("no step {name}")),
        }
        out.flush().map_err(text)?;
    }
    Ok(())
}

fn print(out: &mut impl Write, next: &mut u64, n: u64) -> Result<(), String> {
    for i in *next..*next + n {
        writeln!(out, "{}", line(i)).map_err(text)?;
    }
    *next += n;
    Ok(())
}

fn serve(out: &mut impl Write, next: &mut u64) -> Result<(), String> {
    // What came back so far, as `sum` reports it: a terminal mixes its own
    // echo of the input into the output, so the echoes alone prove little.
    let (mut lines, mut hash) = (0, FNV);
    for input in io::stdin().lock().lines() {
        let input = input.map_err(text)?;
        let input = input.trim_end_matches(['\r', '\n']);
        if let Ok(n) = input.parse() {
            print(out, next, n)?;
        } else if input == "size" {
            let (cols, rows) = crate::sys::window().ok_or("no terminal")?;
            writeln!(out, "size {cols}x{rows}").map_err(text)?;
        } else if let Some(code) = input.strip_prefix("exit ") {
            out.flush().map_err(text)?;
            std::process::exit(code.parse().map_err(text)?);
        } else if input == "sum" {
            writeln!(out, "sum {lines} {hash:016x}").map_err(text)?;
        } else {
            writeln!(out, "<{input}>").map_err(text)?;
            lines += 1;
            hash = fold(hash, input);
        }
        out.flush().map_err(text)?;
    }
    Ok(())
}

const FNV: u64 = 0xcbf2_9ce4_8422_2325;

/// FNV-1a over a line and its end.
pub fn fold(hash: u64, line: &str) -> u64 {
    let bytes = line.bytes().chain(*b"\n");
    bytes.fold(hash, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3)
    })
}

/// A handler that does nothing replaces the default, which ends the
/// process, for the rest of its life.
fn ignore_hang_up() -> Result<(), String> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .build();
    let rt = rt.map_err(text)?;
    #[cfg(unix)]
    rt.block_on(async {
        use tokio::signal::unix::{SignalKind, signal};
        signal(SignalKind::hangup()).map(drop)
    })
    .map_err(text)?;
    #[cfg(windows)]
    rt.block_on(async { tokio::signal::windows::ctrl_close().map(drop) })
        .map_err(text)?;
    Ok(())
}

fn text(e: impl std::fmt::Display) -> String {
    e.to_string()
}
