//! New versions (Tauri's updater, with a key pair of the app's own, not Apple's). The feed is `latest.json` on the
//! newest GitHub Release; the version it names is downloaded and its signature checked against the public key built
//! into this app, and it is installed only when the person says so (Settings › About).
//!
//! When it looks: when About is shown, and at the first capture of a day (the capture key, or the notch taking the
//! keyboard). Never at start, so the window waits for nothing, and never on a timer: at rest the app wakes for
//! nothing, and after a look nothing of it is left running. Only a build of the release workflow looks at all
//! (`TASKTAP_UPDATES`); every build made on a person's own machine, and every check's, never does.
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
    let Some(updater) = config.plugins.0.get_mut("updater").filter(|_| RELEASED) else {
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

/// The state, for `host.update`; with `look`, a look begins unless one is under way. With `install`, the version
/// found is downloaded and installed: the person said so.
pub fn call(app: &AppHandle, args: &Value) -> Result<Value, String> {
    if !ON.load(Ordering::Relaxed) {
        return Ok(serde_json::to_value(State::Off).unwrap_or_default());
    }
    if args["install"].as_bool() == Some(true) {
        install(app)?;
    } else if args["look"].as_bool() == Some(true) {
        look(app);
    }
    Ok(serde_json::to_value(&UPDATES.lock().unwrap().state).unwrap_or_default())
}

/// At a capture: a look, if none was made in the last day.
pub fn daily(app: &AppHandle) {
    let due = UPDATES.lock().unwrap().looked.is_none_or(|at| at.elapsed() >= DAY);
    if ON.load(Ordering::Relaxed) && due {
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
            Ok(()) => app.restart(),
            Err(e) => set(&app, State::Failed { why: plain(&e), version: Some(version) }),
        }
    });
    Ok(())
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
