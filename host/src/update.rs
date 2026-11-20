//! New versions (Tauri's updater, with a key pair of the app's own, not Apple's). The feed is `latest.json` on the
//! newest GitHub Release; the version it names is downloaded and its signature checked against the public key built
//! into this app, and it is installed only when the person says so (Settings › About).
//!
//! When it looks: when About is shown, and at the first capture of a day (the capture key, or the notch taking the
//! keyboard), while the person lets it (the `update_checks` preference, Settings › About); with that off, only when
//! they ask for one check there. Never at start, so the window waits for nothing, and never on a timer: at rest the
//! app wakes for nothing, and after a look nothing of it is left running. Only a build of the release workflow looks
//! at all (`TASKTAP_UPDATES`); every build made on a person's own machine, and every check's, never does.
//!
//! The public key is in one place: tauri.conf.json, `plugins.updater.pubkey` (the content of the `.pub` file Tauri's
//! signer writes). The release workflow's dry run builds with a key pair made for the run (`TASKTAP_UPDATE_KEY`).
//!
//! What it says goes to every page as the `ui` event `update`, and is the reply to `host.update`; the pages put it
//! in words (About, and one quiet line in the workspace's rail while a new version waits).
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Error, Update, UpdaterExt};

/// Whether this build updates itself: the release workflow's builds do.
const RELEASED: bool = option_env!("TASKTAP_UPDATES").is_some();
/// A key in place of the one in tauri.conf.json: the dry run's own.
const KEY: Option<&str> = option_env!("TASKTAP_UPDATE_KEY");
/// Whether the updater is on in this run (`configure`).
static ON: AtomicBool = AtomicBool::new(false);
/// Whether the person lets it ask by itself (`update_checks`): not until the core's records have said so.
static ALLOWED: AtomicBool = AtomicBool::new(false);
/// "Once a day": a capture this long after the last look looks again.
const DAY: Duration = Duration::from_secs(20 * 60 * 60);
/// The longest a look or a download may stall before it is given up.
const STALL: Duration = Duration::from_secs(60);

#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum State {
    /// This build does not update itself.
    Off,
    /// Not looked yet.
    Unknown,
    Looking,
    /// Nothing newer than this version.
    Current {
        version: String,
    },
    Available {
        version: String,
        notes: String,
    },
    Downloading {
        version: String,
        percent: Option<u8>,
    },
    /// Downloaded and checked; being put in place (on Windows the installer takes over).
    Installing {
        version: String,
    },
    Failed {
        why: String,
        version: Option<String>,
    },
}

struct Updates {
    state: State,
    looked: Option<Instant>,
    found: Option<Update>,
}

static UPDATES: Mutex<Updates> = Mutex::new(Updates { state: State::Unknown, looked: None, found: None });

/// Whether the updater is on, its configuration (tauri.conf.json's `plugins.updater`) made final before the app is
/// built: a key in place of the file's when the build was given one, and a check's own feed
/// (`TASKTAP_UPDATE_FEED`, on this machine) in place of the release's.
pub fn configure(config: &mut tauri::Config) -> bool {
    // A review build (`crate::REVIEW`) never updates: it is tried beside the person's own Tasktap, which does.
    let Some(updater) = config.plugins.0.get_mut("updater").filter(|_| RELEASED && !crate::REVIEW) else {
        return false;
    };
    if let Some(key) = KEY.map(str::trim).filter(|k| !k.is_empty()) {
        updater["pubkey"] = json!(key);
    }
    if updater["pubkey"].as_str().is_none_or(|k| k.trim().is_empty()) {
        return false;
    }
    if let Ok(feed) = std::env::var("TASKTAP_UPDATE_FEED") {
        // Plain http on this machine only; what it names is still checked against the key.
        updater["dangerousInsecureTransportProtocol"] = json!(feed.starts_with("http://127.0.0.1:"));
        updater["endpoints"] = json!([feed]);
    }
    ON.store(true, Ordering::Relaxed);
    true
}

fn set(app: &AppHandle, state: State) {
    UPDATES.lock().unwrap().state = state.clone();
    let mut said = serde_json::to_value(&state).unwrap_or_default();
    said["do"] = json!("update");
    let _ = app.emit("ui", said);
}

/// The `update_checks` preference, as the core's records have it now.
pub fn allow(on: bool) {
    ALLOWED.store(on, Ordering::Relaxed);
}

/// What sets a look off: About shown (`look`) while the person lets the app ask by itself, or the person's own
/// Check now (`look` and `now`), which asks once whatever the preference says.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Asked {
    About,
    Now,
    Capture { due: bool },
}

/// Whether to ask GitHub now: only in a build that updates itself, and only by itself while the person lets it.
fn asks(on: bool, allowed: bool, asked: Asked) -> bool {
    on && match asked {
        Asked::Now => true,
        Asked::About => allowed,
        Asked::Capture { due } => allowed && due,
    }
}

/// The state, for `host.update`; with `look`, a look begins unless one is under way and the person let it (`now`: they
/// asked for this one). With `install`, the version found is downloaded and installed: the person said so.
pub fn call(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let on = ON.load(Ordering::Relaxed);
    if !on {
        return Ok(serde_json::to_value(State::Off).unwrap_or_default());
    }
    let asked = if args["now"].as_bool() == Some(true) { Asked::Now } else { Asked::About };
    if args["install"].as_bool() == Some(true) {
        install(app)?;
    } else if args["look"].as_bool() == Some(true) && asks(on, ALLOWED.load(Ordering::Relaxed), asked) {
        look(app);
    }
    Ok(serde_json::to_value(&UPDATES.lock().unwrap().state).unwrap_or_default())
}

/// At a capture: a look, if none was made in the last day and the person lets the app ask by itself.
pub fn daily(app: &AppHandle) {
    let due = UPDATES.lock().unwrap().looked.is_none_or(|at| at.elapsed() >= DAY);
    if asks(ON.load(Ordering::Relaxed), ALLOWED.load(Ordering::Relaxed), Asked::Capture { due }) {
        look(app);
    }
}

fn look(app: &AppHandle) {
    {
        let mut u = UPDATES.lock().unwrap();
        if matches!(u.state, State::Looking | State::Downloading { .. } | State::Installing { .. }) {
            return;
        }
        u.looked = Some(Instant::now());
    }
    set(app, State::Looking);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let checked = match app.updater_builder().timeout(STALL).build() {
            Ok(updater) => updater.check().await,
            Err(e) => Err(e),
        };
        let current = app.package_info().version.to_string();
        let state = match checked {
            Ok(Some(update)) => {
                let state = State::Available {
                    version: update.version.clone(),
                    notes: update.body.clone().unwrap_or_default(),
                };
                UPDATES.lock().unwrap().found = Some(update);
                state
            }
            // No release names a version yet (the newest has no feed): nothing newer.
            Ok(None) | Err(Error::ReleaseNotFound) => State::Current { version: current },
            Err(e) => State::Failed { why: plain(&e), version: None },
        };
        set(&app, state);
    });
}

fn install(app: &AppHandle) -> Result<(), String> {
    let update = {
        let u = UPDATES.lock().unwrap();
        match (&u.state, &u.found) {
            (State::Downloading { .. } | State::Installing { .. }, _) => return Ok(()),
            (_, Some(update)) => update.clone(),
            (_, None) => return Err("There is no new version to install".into()),
        }
    };
    let version = update.version.clone();
    set(app, State::Downloading { version: version.clone(), percent: None });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (mut got, mut said) = (0u64, None);
        let (progress, done) = (app.clone(), app.clone());
        let installed = update
            .download_and_install(
                |chunk, total| {
                    got += chunk as u64;
                    let percent = total.filter(|t| *t > 0).map(|t| (got * 100 / t).min(100) as u8);
                    if percent != said {
                        said = percent;
                        set(&progress, State::Downloading { version: update.version.clone(), percent });
                    }
                },
                || set(&done, State::Installing { version: update.version.clone() }),
            )
            .await;
        match installed {
            // The new version starts in this one's place; the core and its sessions run on.
            Ok(()) => restart(&app),
            Err(e) => set(&app, State::Failed { why: plain(&e), version: Some(version) }),
        }
    });
    Ok(())
}

/// Starts the version just installed in this one's place. Tauri starts it through LaunchServices on a Mac, which gives
/// it none of this run's environment: right for a person, wrong for a check (`TASKTAP_PASSIVE`), whose run would then
/// start on the person's own data folder, in front. A check's run is started again as it was started.
fn restart(app: &AppHandle) {
    if std::env::var_os("TASKTAP_PASSIVE").is_none() {
        app.restart();
    }
    crate::log(json!({"event": "updated"}));
    match std::env::current_exe().and_then(|exe| std::process::Command::new(exe).spawn()) {
        Ok(_) => std::process::exit(0),
        Err(e) => set(app, State::Failed { why: format!("The new version could not be started: {e}"), version: None }),
    }
}

/// What went wrong, as a person would say it.
fn plain(e: &Error) -> String {
    match e {
        Error::Reqwest(_) | Error::Network(_) => {
            "Tasktap could not reach GitHub, where new versions are published".into()
        }
        Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) => {
            "The new version's signature does not match Tasktap's, so it was not installed".into()
        }
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => "The new version has no copy for this computer".into(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_the_switch_off_nothing_asks_github_but_the_persons_own_check() {
        // On, as it is by default: About asks, and the first capture of a day.
        assert!(asks(true, true, Asked::About));
        assert!(asks(true, true, Asked::Capture { due: true }));
        assert!(!asks(true, true, Asked::Capture { due: false }), "a capture within the day asks again");
        // Off: neither About nor a capture, whenever it is due; Check now asks, once each time.
        assert!(!asks(true, false, Asked::About));
        assert!(!asks(true, false, Asked::Capture { due: true }));
        assert!(asks(true, false, Asked::Now));
        // A build made on this computer never asks, whatever the switch and whoever asks.
        for allowed in [true, false] {
            for asked in [Asked::About, Asked::Now, Asked::Capture { due: true }] {
                assert!(!asks(false, allowed, asked), "{asked:?}");
            }
        }
        // Until the core's records have said, the app asks nothing by itself.
        assert!(!ALLOWED.load(Ordering::Relaxed));
    }
}
