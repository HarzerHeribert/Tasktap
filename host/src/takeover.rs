//! Taking over from "Tasktap Next", the name this app was built under before it was Tasktap: once, at the first start
//! of Tasktap, when Tasktap Next's data folder exists and Tasktap's does not, the folder is moved whole to Tasktap's
//! place by the bundled core (`tasktap move-data`: after a copy of the database beside it, with every path its records
//! keep rewritten and the projects' copies told where they are). Never while anything of Tasktap Next runs: the app
//! asked the system, its core by the locks in its folder; then the person is told in a sentence to quit it first, and
//! Tasktap does not start, so that its own folder is not made empty in the meantime. Builds named Tasktap Next are not
//! supported afterwards; this one move is all there is.
//!
//! A check names a fixture's folder with `TASKTAP_TAKEOVER_FROM` (and its own `TASKTAP_DATA`); the person's own folder
//! is never involved in a check, and a check's run looks for no app of the person's.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

/// The name the folder and the app had.
const OLD: &str = "Tasktap Next";
#[cfg(target_os = "macos")]
const OLD_ID: &str = "io.github.harzerheribert.tasktap.next";

/// What became of the move, in words for the person where they need any.
pub enum Outcome {
    /// Nothing to take over.
    Nothing,
    /// Taken over; the words say so.
    Moved(Words),
    /// Not now, and Tasktap does not start: the words say why and what to do.
    Stopped(Words),
}

/// What the person is told: a title and what follows it.
pub struct Words {
    pub title: String,
    pub body: String,
}

fn words(title: &str, body: impl Into<String>) -> Words {
    Words { title: title.into(), body: body.into() }
}

const AGAIN: &str =
    "then open Tasktap again. Tasktap then moves Tasktap Next's tasks, sessions and settings over, once.";

/// The folder to take over, if there is one to take over now: Tasktap Next's, beside this app's own, while this app's
/// does not exist yet. Only Tasktap's own folder takes over: a build of another identity (one made for review, with a
/// folder of its own) never does.
fn old_folder(data: &Path) -> Option<(PathBuf, bool)> {
    let (old, check) = match std::env::var_os("TASKTAP_TAKEOVER_FROM") {
        Some(from) => (PathBuf::from(from), true),
        // A folder a check named is its own, with nothing to take over.
        None if std::env::var_os("TASKTAP_DATA").is_some() => return None,
        None if data.file_name().is_none_or(|name| name != "Tasktap") => return None,
        None => (data.with_file_name(OLD), false),
    };
    (old.is_dir() && data.symlink_metadata().is_err()).then_some((old, check))
}

/// Takes over Tasktap Next's folder if there is one to take over. Called before anything is made in `data`.
pub fn before_start(data: &Path, core: &Path) -> Outcome {
    let Some((old, check)) = old_folder(data) else {
        return Outcome::Nothing;
    };
    if !check && running() {
        let body = format!("Tasktap Next is still open. Quit it (Tasktap Next › Quit Tasktap Next), {AGAIN}");
        return Outcome::Stopped(words("Quit Tasktap Next first", body));
    }
    let ran = Command::new(core)
        .arg("move-data")
        .arg("--from")
        .arg(&old)
        .arg("--data")
        .arg(data)
        .stdin(std::process::Stdio::null())
        .output();
    let out = match ran {
        Ok(out) => out,
        Err(e) => return Outcome::Stopped(words(FAILED, format!("{e}. Nothing was changed."))),
    };
    let said = String::from_utf8_lossy(&out.stderr);
    let said = said.trim().trim_start_matches("tasktap: ");
    match out.status.code() {
        Some(0) => {
            let moved: Value = serde_json::from_slice(&out.stdout).unwrap_or(json!({}));
            Outcome::Moved(moved_words(&old, data, &moved))
        }
        // A core of Tasktap Next runs in its folder: its terminals keep it running after the app is quit.
        Some(77) => Outcome::Stopped(words(
            "Tasktap Next's sessions are still running",
            format!("Its terminals keep it running after it is quit. Open Tasktap Next, end its sessions and quit it, {AGAIN}"),
        )),
        _ => Outcome::Stopped(words(
            FAILED,
            format!("{}. Tasktap Next's folder is as it was, at {}.", capital(said), old.display()),
        )),
    }
}

const FAILED: &str = "Tasktap could not take over from Tasktap Next";

fn capital(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

fn moved_words(old: &Path, data: &Path, moved: &Value) -> Words {
    let mut body = format!(
        "Tasktap Next's tasks, sessions, results and settings are here now. Its folder moved from {} to {}, with a copy of its \
         database as it was (core.before-move.db). Tasktap Next is no longer needed: do not open it again, and you can \
         move it to the Bin.",
        old.display(),
        data.display()
    );
    if let Some(unrepaired) = moved["unrepaired"].as_array().filter(|u| !u.is_empty()) {
        body.push_str(&format!(
            " Git could not be told where {} of the copies of your projects now are; Keep and Discard may refuse them.",
            unrepaired.len()
        ));
    }
    words("Tasktap has taken over from Tasktap Next", body)
}

/// Whether Tasktap Next's app runs, as the system knows it (it is asked, never signalled).
#[cfg(target_os = "macos")]
fn running() -> bool {
    use objc2_app_kit::NSRunningApplication;
    use objc2_foundation::NSString;
    NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(OLD_ID)).count() > 0
}

#[cfg(windows)]
fn running() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let wanted: Vec<u16> = "tasktap next.exe".encode_utf16().collect();
    // SAFETY: a snapshot of the processes, read entry by entry into a structure of its own size, and closed.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = false;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more && !found {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();
            found = name.encode_utf16().eq(wanted.iter().copied());
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        found
    }
}

/// Tells the person, in the system's own alert, and waits for them to read it.
#[cfg(target_os = "macos")]
pub fn tell(words: &Words) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAlert, NSApplication};
    use objc2_foundation::NSString;
    let Some(mtm) = MainThreadMarker::new() else { return };
    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str(&words.title));
    alert.setInformativeText(&NSString::from_str(&words.body));
    #[allow(deprecated)]
    NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
    alert.runModal();
}

#[cfg(windows)]
pub fn tell(words: &Words) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND};
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    // SAFETY: two strings ending in a zero, alive for the call.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            wide(&words.body).as_ptr(),
            wide(&words.title).as_ptr(),
            MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND,
        )
    };
}
