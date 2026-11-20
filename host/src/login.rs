//! Opening Tasktap when the computer starts (Settings › Thoughts, under the capture key, which does nothing until
//! Tasktap runs). It is the system's own item for the app, so that the person finds it where the system lists such
//! things and can remove it there, and its state is always read back from the system, never kept by Tasktap.
//!
//! - **Mac**: `SMAppService.mainAppService` (macOS 13), which System Settings › General › Login Items lists under the
//!   app's name. Only a bundled app with a code signature can be one; any other copy says so.
//! - **Windows**: the person's own Run entry, `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `Tasktap`,
//!   which needs no administrator and which Settings › Apps › Startup lists, where the person can turn it off
//!   (`…\Explorer\StartupApproved\Run`, read back here too). Only the installed app (its uninstaller beside it) is
//!   written there, with `--login` after it.
//!
//! A review build ("Tasktap Review") and a check's run (`TASKTAP_PASSIVE`) never ask the system for anything here: not
//! to register, and not even for the state. Started at login the app opens no window: only the notch (on Windows the
//! tab) and its icon (`started_at_login`).
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

/// Why this copy cannot be opened at login.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Why {
    /// Tasktap Review, which runs beside the person's own Tasktap.
    Review,
    /// A check's run.
    Check,
    /// Mac: not a bundled app with a code signature, so the system has no app to open.
    Unsigned,
    /// Windows: not the copy the installer put in place.
    Uninstalled,
}

/// Where things stand, as the system says.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Login {
    /// The computer starts without Tasktap.
    Off,
    /// Tasktap opens when the person logs in.
    On,
    /// Mac: set, and macOS waits for the person to allow it in Login Items.
    Approve,
    /// This copy cannot be opened at login.
    Unavailable { why: Why },
}

/// What this copy is, as far as opening at login goes.
#[derive(Clone, Copy, Debug)]
pub struct Copy {
    pub review: bool,
    pub passive: bool,
    /// Mac: a bundled app with a code signature. Windows: installed by its installer.
    pub app: bool,
    pub mac: bool,
}

impl Copy {
    /// Why the system may not be asked about this copy; none when it may.
    pub fn refused(&self) -> Option<Why> {
        if self.review {
            Some(Why::Review)
        } else if self.passive {
            Some(Why::Check)
        } else if !self.app {
            Some(if self.mac { Why::Unsigned } else { Why::Uninstalled })
        } else {
            None
        }
    }
}

/// What turning it on or off asks of the system, as the call that would be made; nothing when it is so already.
#[derive(Clone, Debug, PartialEq)]
pub enum Act {
    Nothing,
    /// Mac: `[[SMAppService mainAppService] registerAndReturnError:]`.
    Register,
    /// Mac: `[[SMAppService mainAppService] unregisterAndReturnError:]`.
    Unregister,
    /// Windows: the Run value written, and the person's own Off in Startup apps (its StartupApproved value) removed,
    /// so that the entry is on.
    Write {
        key: &'static str,
        name: &'static str,
        data: String,
        approved: &'static str,
    },
    /// Windows: the Run value removed, and its StartupApproved value with it.
    Remove {
        key: &'static str,
        name: &'static str,
        approved: &'static str,
    },
}

/// The person's own Run entries, which Windows reads at sign-in.
pub const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
/// Where Startup apps keeps what the person turned off there.
pub const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
/// The entry's name, which Startup apps shows.
pub const NAME: &str = "Tasktap";
/// What the Run entry adds to the program, so that a start at sign-in knows itself.
pub const AT_LOGIN: &str = "--login";

/// The Run entry's value for the program at `exe`.
pub fn run_entry(exe: &str) -> String {
    format!("\"{exe}\" {AT_LOGIN}")
}

/// What `on` asks of the system, from where things stand now (`now`): for a copy that cannot be opened at login, only
/// the reason, and the system is not asked. `exe`: this program, for the Windows entry.
pub fn decide(copy: &Copy, on: bool, now: &Login, exe: &str) -> Result<Act, Why> {
    if let Some(why) = copy.refused() {
        return Err(why);
    }
    let set = matches!(now, Login::On | Login::Approve);
    Ok(match (copy.mac, on) {
        _ if set == on => Act::Nothing,
        (true, true) => Act::Register,
        (true, false) => Act::Unregister,
        (false, true) => Act::Write { key: RUN, name: NAME, data: run_entry(exe), approved: APPROVED },
        (false, false) => Act::Remove { key: RUN, name: NAME, approved: APPROVED },
    })
}

/// The Mac's state from `SMAppService.status`: 0 not registered, 1 enabled, 2 requires approval, 3 not found.
#[cfg_attr(windows, allow(dead_code))]
pub fn from_status(status: isize) -> Login {
    match status {
        1 => Login::On,
        2 => Login::Approve,
        _ => Login::Off,
    }
}

/// The Windows state from the Run value (`run`) and the StartupApproved value (`approved`) for this program (`exe`):
/// on when the entry starts this program and the person has not turned it off in Startup apps, whose value then has
/// an odd first byte.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn from_registry(run: Option<&str>, approved: Option<&[u8]>, exe: &str) -> Login {
    let ours = run.is_some_and(|r| r.trim() == run_entry(exe) || r.trim().trim_matches('"') == exe);
    let off_there = approved.and_then(|a| a.first()).is_some_and(|b| b % 2 == 1);
    if ours && !off_there {
        Login::On
    } else {
        Login::Off
    }
}

/// Whether this start is the one the system made at login. Windows: `--login` among the arguments, which only the
/// Run entry gives. Mac: the open event says so (`keyAELaunchedAsLogInItem`), or else, while the login item is
/// enabled, the app started within two minutes of the person's login.
pub fn at_login(args: &[String], said: bool, enabled: bool, since_login: Option<Duration>) -> bool {
    args.iter().any(|a| a == AT_LOGIN) || said || (enabled && since_login.is_some_and(|d| d < Duration::from_secs(120)))
}

/// This copy, as it runs.
fn this_copy() -> Copy {
    let passive = std::env::var_os("TASKTAP_PASSIVE").is_some();
    let exe = std::env::current_exe().unwrap_or_default();
    #[cfg(target_os = "macos")]
    let app = exe.ancestors().nth(3).filter(|b| b.extension().is_some_and(|e| e == "app")).is_some_and(|bundle| {
        bundle.join("Contents/Info.plist").is_file() && bundle.join("Contents/_CodeSignature/CodeResources").is_file()
    });
    #[cfg(windows)]
    let app = exe.with_file_name("uninstall.exe").is_file();
    Copy { review: crate::REVIEW, passive, app, mac: cfg!(target_os = "macos") }
}

fn exe() -> String {
    std::env::current_exe().map(|e| e.display().to_string()).unwrap_or_default()
}

/// Where things stand, read from the system; for a copy that cannot be opened at login, why, the system not asked.
pub fn state() -> Login {
    let copy = this_copy();
    if let Some(why) = copy.refused() {
        return Login::Unavailable { why };
    }
    system::state(&exe())
}

/// Whether this start is the one the system made at login: then the app opens no window. Never in a check's run or a
/// review build, which the system never starts.
pub fn started_at_login() -> bool {
    let copy = this_copy();
    if copy.refused().is_some() {
        return false;
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(target_os = "macos")]
    let (said, enabled, since) = (system::opened_at_login(), system::state(&exe()) == Login::On, system::since_login());
    #[cfg(windows)]
    let (said, enabled, since) = (false, false, None);
    at_login(&args, said, enabled, since)
}

/// `host.login {on?, open?}`. With `on`, Tasktap is opened at login or no longer (`decide`, then the system's own
/// call); with `open` (Mac), System Settings shows Login Items, where macOS asks the person to allow it. The reply is
/// where things stand now, read back from the system: `{state, why?}`.
pub fn call(args: &Value) -> Result<Value, String> {
    if args["open"].as_bool() == Some(true) {
        system::open_settings();
    }
    if let Some(on) = args["on"].as_bool() {
        let now = state();
        match decide(&this_copy(), on, &now, &exe()) {
            Ok(act) => {
                crate::log(json!({"event": "login", "on": on, "act": format!("{act:?}")}));
                system::apply(&act)?;
            }
            Err(why) => return Err(refused(why).into()),
        }
    }
    serde_json::to_value(state()).map_err(|e| e.to_string())
}

/// What the person is told when this copy cannot be opened at login.
fn refused(why: Why) -> &'static str {
    match why {
        Why::Review => "Tasktap Review never opens by itself",
        Why::Check => "A check's run never opens by itself",
        Why::Unsigned => "macOS can open only a signed Tasktap app when you log in",
        Why::Uninstalled => "Windows can open only the Tasktap its installer put in place",
    }
}

#[cfg(target_os = "macos")]
mod system {
    use super::{from_status, Act, Login};
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::time::{Duration, SystemTime};

    // SMAppService is ServiceManagement's (macOS 13).
    #[link(name = "ServiceManagement", kind = "framework")]
    extern "C" {}

    fn service() -> Option<*mut AnyObject> {
        let class = AnyClass::get(c"SMAppService")?;
        // SAFETY: a class method of SMAppService that returns the app's own service, or nil.
        let service: *mut AnyObject = unsafe { msg_send![class, mainAppService] };
        (!service.is_null()).then_some(service)
    }

    pub fn state(_exe: &str) -> Login {
        match service() {
            // SAFETY: `status` of a service SMAppService gave; it is an NSInteger.
            Some(service) => from_status(unsafe { msg_send![service, status] }),
            None => Login::Off,
        }
    }

    pub fn apply(act: &Act) -> Result<(), String> {
        let Some(service) = service() else { return Err("This Mac has no login items for apps".into()) };
        let mut error: *mut AnyObject = std::ptr::null_mut();
        // SAFETY: SMAppService's own methods, with an out-parameter for the error.
        let done: bool = unsafe {
            match act {
                Act::Register => msg_send![service, registerAndReturnError: &mut error],
                Act::Unregister => msg_send![service, unregisterAndReturnError: &mut error],
                _ => return Ok(()),
            }
        };
        if done || error.is_null() {
            return Ok(());
        }
        // SAFETY: the NSError the call gave; its description is an NSString.
        let said: *mut objc2_foundation::NSString = unsafe { msg_send![error, localizedDescription] };
        // SAFETY: the description, borrowed for as long as the error lives.
        Err(unsafe { said.as_ref() }.map_or_else(|| "macOS refused".into(), |s| s.to_string()))
    }

    pub fn open_settings() {
        if let Some(class) = AnyClass::get(c"SMAppService") {
            // SAFETY: a class method with no arguments that opens System Settings at Login Items.
            let _: () = unsafe { msg_send![class, openSystemSettingsLoginItems] };
        }
    }

    /// Whether the open event of this start says the system opened the app as a login item.
    pub fn opened_at_login() -> bool {
        const OPEN_APPLICATION: u32 = u32::from_be_bytes(*b"oapp");
        const PROP_DATA: u32 = u32::from_be_bytes(*b"prdt");
        const LOGIN_ITEM: u32 = u32::from_be_bytes(*b"lgit");
        let Some(class) = AnyClass::get(c"NSAppleEventManager") else { return false };
        // SAFETY: the shared manager and the event it is handling, which may be nil; four-character codes are u32.
        unsafe {
            let manager: *mut AnyObject = msg_send![class, sharedAppleEventManager];
            let event: *mut AnyObject = msg_send![manager, currentAppleEvent];
            if event.is_null() {
                return false;
            }
            let id: u32 = msg_send![event, eventID];
            let data: *mut AnyObject = msg_send![event, paramDescriptorForKeyword: PROP_DATA];
            if id != OPEN_APPLICATION || data.is_null() {
                return false;
            }
            let value: u32 = msg_send![data, enumCodeValue];
            value == LOGIN_ITEM
        }
    }

    /// How long ago the person logged in at this Mac's screen, as the system's login records say.
    pub fn since_login() -> Option<Duration> {
        let me = std::env::var("USER").ok()?;
        let mut at: Option<SystemTime> = None;
        // SAFETY: the system's own walk over its login records, ended before it returns; each entry read in its turn.
        unsafe {
            libc::setutxent();
            loop {
                let e = libc::getutxent();
                if e.is_null() {
                    break;
                }
                let e = &*e;
                let line = std::ffi::CStr::from_ptr(e.ut_line.as_ptr()).to_bytes();
                let user = std::ffi::CStr::from_ptr(e.ut_user.as_ptr()).to_bytes();
                if e.ut_type == libc::USER_PROCESS && line == b"console" && user == me.as_bytes() {
                    let t = SystemTime::UNIX_EPOCH + Duration::from_secs(e.ut_tv.tv_sec.max(0) as u64);
                    at = at.max(Some(t));
                }
            }
            libc::endutxent();
        }
        SystemTime::now().duration_since(at?).ok()
    }
}

#[cfg(windows)]
mod system {
    use super::{from_registry, Act, Login, APPROVED, NAME, RUN};
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_BINARY, RRF_RT_REG_SZ,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain([0]).collect()
    }

    /// A value of the person's own registry: its bytes, or none.
    fn value(key: &str, name: &str, kind: u32) -> Option<Vec<u8>> {
        let (key, name) = (wide(key), wide(name));
        let mut len = 0u32;
        // SAFETY: the size asked first, then the value read into a buffer of that size.
        unsafe {
            let asked = RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                kind,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut len,
            );
            if asked != ERROR_SUCCESS {
                return None;
            }
            let mut bytes = vec![0u8; len as usize];
            let read = RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                kind,
                std::ptr::null_mut(),
                bytes.as_mut_ptr().cast(),
                &mut len,
            );
            (read == ERROR_SUCCESS).then(|| {
                bytes.truncate(len as usize);
                bytes
            })
        }
    }

    fn text(bytes: &[u8]) -> String {
        let units: Vec<u16> = bytes.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect();
        String::from_utf16_lossy(&units).trim_end_matches('\0').to_owned()
    }

    pub fn state(exe: &str) -> Login {
        let run = value(RUN, NAME, RRF_RT_REG_SZ).map(|b| text(&b));
        let approved = value(APPROVED, NAME, RRF_RT_REG_BINARY);
        from_registry(run.as_deref(), approved.as_deref(), exe)
    }

    fn remove(key: &str, name: &str) -> Result<(), String> {
        let (key, name) = (wide(key), wide(name));
        // SAFETY: removes one value of the person's own registry, if it is there.
        match unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()) } {
            ERROR_SUCCESS | ERROR_FILE_NOT_FOUND => Ok(()),
            e => Err(format!("Windows refused to change its startup apps (error {e})")),
        }
    }

    pub fn apply(act: &Act) -> Result<(), String> {
        match act {
            Act::Write { key, name, data, approved } => {
                let (k, n, d) = (wide(key), wide(name), wide(data));
                // SAFETY: writes one text value, with its ending nul, of the person's own registry.
                let done = unsafe {
                    RegSetKeyValueW(
                        HKEY_CURRENT_USER,
                        k.as_ptr(),
                        n.as_ptr(),
                        REG_SZ,
                        d.as_ptr().cast(),
                        (d.len() * 2) as u32,
                    )
                };
                if done != ERROR_SUCCESS {
                    return Err(format!("Windows refused to change its startup apps (error {done})"));
                }
                remove(approved, name)
            }
            Act::Remove { key, name, approved } => remove(key, name).and_then(|()| remove(approved, name)),
            _ => Ok(()),
        }
    }

    pub fn open_settings() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Users\person\AppData\Local\Tasktap\tasktap-app.exe";

    fn copy(mac: bool) -> Copy {
        Copy { review: false, passive: false, app: true, mac }
    }

    #[test]
    fn a_review_build_a_checks_run_and_a_copy_that_is_no_app_never_ask_the_system() {
        for mac in [true, false] {
            for on in [true, false] {
                let review = Copy { review: true, ..copy(mac) };
                assert_eq!(decide(&review, on, &Login::Off, EXE), Err(Why::Review));
                // A review build that is also a check's run is refused as the review build it is.
                assert_eq!(decide(&Copy { passive: true, ..review }, on, &Login::Off, EXE), Err(Why::Review));
                assert_eq!(decide(&Copy { passive: true, ..copy(mac) }, on, &Login::On, EXE), Err(Why::Check));
                let loose = Copy { app: false, ..copy(mac) };
                assert_eq!(
                    decide(&loose, on, &Login::Off, EXE),
                    Err(if mac { Why::Unsigned } else { Why::Uninstalled })
                );
            }
        }
        // And this run, a test's, is no app: the state is the reason, and the system is never asked.
        assert!(matches!(state(), Login::Unavailable { .. }), "{:?}", state());
        assert!(!started_at_login());
        assert!(refused(Why::Unsigned).starts_with("macOS"));
        assert!(refused(Why::Uninstalled).starts_with("Windows"));
    }

    #[test]
    fn on_a_mac_the_app_is_its_own_login_item_and_its_state_is_the_systems() {
        assert_eq!(decide(&copy(true), true, &Login::Off, EXE), Ok(Act::Register));
        assert_eq!(decide(&copy(true), false, &Login::On, EXE), Ok(Act::Unregister));
        // Waiting for the person to allow it counts as set: Off takes it away again, On asks nothing more.
        assert_eq!(decide(&copy(true), false, &Login::Approve, EXE), Ok(Act::Unregister));
        assert_eq!(decide(&copy(true), true, &Login::Approve, EXE), Ok(Act::Nothing));
        assert_eq!(decide(&copy(true), true, &Login::On, EXE), Ok(Act::Nothing));
        // SMAppServiceStatus: not registered, enabled, requires approval, not found.
        let states = [0, 1, 2, 3].map(from_status);
        assert_eq!(states, [Login::Off, Login::On, Login::Approve, Login::Off]);
    }

    #[test]
    fn on_windows_the_run_entry_starts_the_installed_app_and_startup_apps_can_turn_it_off() {
        let entry = format!("\"{EXE}\" --login");
        assert_eq!(run_entry(EXE), entry);
        assert_eq!(
            decide(&copy(false), true, &Login::Off, EXE),
            Ok(Act::Write { key: RUN, name: "Tasktap", data: entry.clone(), approved: APPROVED })
        );
        assert_eq!(
            decide(&copy(false), false, &Login::On, EXE),
            Ok(Act::Remove { key: RUN, name: "Tasktap", approved: APPROVED })
        );
        assert_eq!(decide(&copy(false), false, &Login::Off, EXE), Ok(Act::Nothing));
        assert_eq!(RUN, r"Software\Microsoft\Windows\CurrentVersion\Run");
        // Read back: the entry for this program is on, unless Startup apps turned it off (an odd first byte).
        assert_eq!(from_registry(Some(&entry), None, EXE), Login::On);
        assert_eq!(from_registry(Some(&format!("\"{EXE}\"")), None, EXE), Login::On);
        assert_eq!(from_registry(Some(&entry), Some(&[2, 0, 0, 0]), EXE), Login::On);
        assert_eq!(from_registry(Some(&entry), Some(&[3, 0, 0, 0, 1, 2, 3, 4]), EXE), Login::Off);
        assert_eq!(from_registry(None, None, EXE), Login::Off);
        // An entry for another copy is not this one's.
        assert_eq!(from_registry(Some(r#""D:\Old\tasktap-app.exe" --login"#), None, EXE), Login::Off);
    }

    #[test]
    fn a_start_at_login_is_known_by_its_argument_or_the_systems_word() {
        let none: Vec<String> = Vec::new();
        assert!(at_login(&["--login".into()], false, false, None), "the Run entry's argument");
        assert!(at_login(&none, true, false, None), "the Mac's open event");
        assert!(at_login(&none, false, true, Some(Duration::from_secs(20))), "enabled, and just after login");
        assert!(!at_login(&none, false, true, Some(Duration::from_secs(600))), "enabled, long after login");
        assert!(!at_login(&none, false, false, Some(Duration::from_secs(5))), "not enabled");
        assert!(!at_login(&["--other".into()], false, false, None));
    }

    #[test]
    fn the_state_is_told_as_a_page_reads_it() {
        assert_eq!(serde_json::to_value(Login::On).unwrap(), json!({"state": "on"}));
        assert_eq!(serde_json::to_value(Login::Approve).unwrap(), json!({"state": "approve"}));
        assert_eq!(
            serde_json::to_value(Login::Unavailable { why: Why::Unsigned }).unwrap(),
            json!({"state": "unavailable", "why": "unsigned"})
        );
    }
}
