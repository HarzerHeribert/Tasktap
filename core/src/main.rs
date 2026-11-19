//! `tasktap`: one binary, several roles (design §4). The program's name
//! names a shim; otherwise the first argument names the role.

use std::ffi::OsString;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use tasktap_core::roles::{self, shim};
use tasktap_core::serve::{self, Options};

const USAGE: &str = "usage: tasktap serve --data <folder> | event <kind> [TEXT] | \
                     hook <agent> | ask [PROMPT...] | preview <file or address> | \
                     move-data --from <folder> --data <folder>";

fn main() -> ExitCode {
    let mut args = std::env::args_os();
    let program = args.next();
    #[cfg(feature = "fixtures")]
    if program.as_deref().is_some_and(roles::fixture::named) {
        return roles::fixture::run(args.collect());
    }
    // A shim is this file named `claude`, `codex`, …
    if let Some(rules) = program.as_deref().and_then(shim::named) {
        return shim::run(rules, args.collect());
    }
    let result = match args.next().as_deref().and_then(|role| role.to_str()) {
        Some("serve") => serve(args),
        #[cfg(feature = "fixtures")]
        Some("fixture-terminal") => tasktap_core::fixture_terminal(args),
        Some("event") => return roles::event(args.collect()),
        Some("hook") => return roles::hook(args.collect()),
        Some("ask") => return roles::ask(args.collect()),
        Some("preview") => return roles::preview(args.collect()),
        Some("move-data") => return move_data(args),
        #[cfg(feature = "fixtures")]
        Some("fixture-agent") => return roles::fixture::run(args.collect()),
        _ => {
            let _ = writeln!(io::stderr(), "tasktap: {USAGE}");
            return ExitCode::from(roles::USAGE);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(why) => {
            // `client::start` reports the first line of this.
            let _ = writeln!(io::stderr(), "tasktap: {why}");
            ExitCode::FAILURE
        }
    }
}

/// `serve --data <folder>`; with the test fixtures also `--idle-ms <ms>`,
/// `--hello-ms <ms>`, `--check-ms <ms>` (each folder check, search for a
/// launch's program and history write waits that long first),
/// `--second-ms <ms>` (how long a second of a dictation's deadline and of
/// a web call's limit lasts),
/// `--fixture-token <64 hex digits>` and `--detect` (detect the fixture
/// agents as it starts, as a normal build detects every agent).
fn serve(mut args: impl Iterator<Item = OsString>) -> Result<(), String> {
    let mut data = None;
    let mut locked = false;
    #[cfg_attr(not(feature = "fixtures"), allow(unused_mut))]
    let mut idle = serve::IDLE;
    #[cfg_attr(not(feature = "fixtures"), allow(unused_mut))]
    let mut hello = serve::HELLO;
    #[cfg(feature = "fixtures")]
    let mut token = None;
    #[cfg(feature = "fixtures")]
    let mut check = std::time::Duration::ZERO;
    #[cfg(feature = "fixtures")]
    let mut second = std::time::Duration::from_secs(1);
    #[cfg_attr(not(feature = "fixtures"), allow(unused_mut))]
    let mut detect = !cfg!(feature = "fixtures");
    while let Some(flag) = args.next() {
        let mut value = || {
            args.next()
                .ok_or(format!("{} needs a value", flag.display()))
        };
        match flag.to_str() {
            Some("--data") => data = Some(PathBuf::from(value()?)),
            // Only `client::admit` passes it: it holds `start.lock` for this core.
            Some("--locked") => locked = true,
            #[cfg(feature = "fixtures")]
            Some("--idle-ms") => idle = ms(value()?)?,
            #[cfg(feature = "fixtures")]
            Some("--hello-ms") => hello = ms(value()?)?,
            #[cfg(feature = "fixtures")]
            Some("--check-ms") => check = ms(value()?)?,
            #[cfg(feature = "fixtures")]
            Some("--second-ms") => second = ms(value()?)?,
            #[cfg(feature = "fixtures")]
            Some("--detect") => detect = true,
            #[cfg(feature = "fixtures")]
            Some("--fixture-token") => {
                let hex = value()?.into_string().unwrap_or_default();
                token = Some(serde_json::from_value(hex.into()).map_err(|e| e.to_string())?);
            }
            _ => return Err(format!("unknown argument {}", flag.display())),
        }
    }
    let data = data.ok_or("serve needs --data <folder>; there is no default")?;
    let opts = Options {
        data,
        idle,
        hello,
        locked,
        #[cfg(feature = "fixtures")]
        token,
        #[cfg(feature = "fixtures")]
        check,
        #[cfg(feature = "fixtures")]
        second,
        detect,
    };
    serve::run(opts).map_err(|e| e.to_string())
}

/// `move-data --from <folder> --data <folder>`: moves a data folder whole
/// (`relocate`) and prints what it did as one line of JSON. Exits 77 when a
/// core runs in the folder or is starting there, having changed nothing.
fn move_data(mut args: impl Iterator<Item = OsString>) -> ExitCode {
    let (mut from, mut to, mut bad) = (None, None, false);
    while let Some(flag) = args.next() {
        match (flag.to_str(), args.next()) {
            (Some("--from"), Some(v)) => from = Some(PathBuf::from(v)),
            (Some("--data"), Some(v)) => to = Some(PathBuf::from(v)),
            _ => bad = true,
        }
    }
    let (Some(from), Some(to), false) = (from, to, bad) else {
        let _ = writeln!(io::stderr(), "tasktap: {USAGE}");
        return ExitCode::from(roles::USAGE);
    };
    match tasktap_core::relocate::run(&from, &to) {
        Ok(moved) => {
            let _ = writeln!(
                io::stdout(),
                "{}",
                serde_json::to_string(&moved).unwrap_or_default()
            );
            ExitCode::SUCCESS
        }
        Err(tasktap_core::relocate::Refused::Running) => {
            let _ = writeln!(io::stderr(), "tasktap: a core runs in {}", from.display());
            ExitCode::from(roles::REFUSED)
        }
        Err(tasktap_core::relocate::Refused::Failed(why)) => {
            let _ = writeln!(io::stderr(), "tasktap: {why}");
            ExitCode::from(roles::FAILED)
        }
    }
}

/// A delay given in milliseconds.
#[cfg(feature = "fixtures")]
fn ms(value: OsString) -> Result<std::time::Duration, String> {
    let ms = value.to_str().and_then(|ms| ms.parse().ok());
    let ms = ms.ok_or("a delay is given in milliseconds")?;
    Ok(std::time::Duration::from_millis(ms))
}
