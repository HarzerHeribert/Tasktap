//! `tasktap`: one binary, several roles (design §4). The program's name
//! names a shim; otherwise the first argument names the role.

use std::ffi::OsString;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use tasktap_core::roles::{self, shim};
use tasktap_core::serve::{self, Options};

const USAGE: &str = "usage: tasktap serve --data <folder> | event <kind> [TEXT] | \
                     hook <agent> | ask [PROMPT...]";

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
/// launch's program and history write waits that long first) and
/// `--fixture-token <64 hex digits>`.
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
    };
    serve::run(opts).map_err(|e| e.to_string())
}

/// A delay given in milliseconds.
#[cfg(feature = "fixtures")]
fn ms(value: OsString) -> Result<std::time::Duration, String> {
    let ms = value.to_str().and_then(|ms| ms.parse().ok());
    let ms = ms.ok_or("a delay is given in milliseconds")?;
    Ok(std::time::Duration::from_millis(ms))
}
