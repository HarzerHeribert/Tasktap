//! Kills a test's core when the test holds it too long.

use std::process::Child;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::Duration;
use tasktap_core::client::Said;

/// Longest a test may hold a core.
pub const PATIENCE: Duration = Duration::from_secs(60);

/// Ends process `pid` at once.
#[cfg(unix)]
pub fn kill(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status();
}

/// Ends process `pid` at once. Not by `taskkill`: it asks the system's
/// management service, which refuses a standard account signed in over SSH,
/// and a watchdog that cannot kill lets its test wait for ever.
#[cfg(windows)]
pub fn kill(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess};
    // SAFETY: OpenProcess returns a handle or null; a handle is used once
    // and closed once.
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !process.is_null() {
            TerminateProcess(process, 1);
            CloseHandle(process);
        }
    }
}

/// Kills a test's core if the test still holds it after [`PATIENCE`]. A
/// Windows pipe opened for blocking I/O has no read or write timeout, so
/// killing the other end is what turns a read, a write or a wait for the
/// core to exit that would never return into an error at that line, on
/// every platform alike. Dropping the watchdog disarms it.
pub struct Watchdog {
    _armed: Sender<()>,
}

impl Watchdog {
    pub fn new(core: &Child, said: Said) -> Watchdog {
        Self::patient(core, PATIENCE, said)
    }

    /// The same, after `patience`: a live agent's turn takes minutes.
    /// `said`: what the core wrote, which it says too.
    pub fn patient(core: &Child, patience: Duration, said: Said) -> Watchdog {
        let (armed, disarmed) = mpsc::channel();
        let pid = core.id();
        let test = std::thread::current().name().unwrap_or("a test").to_owned();
        std::thread::spawn(move || {
            if disarmed.recv_timeout(patience) == Err(RecvTimeoutError::Timeout) {
                eprintln!("{test} still holds its core after {patience:?}: killing it");
                eprintln!("what it did until then:\n{}", super::notes(&test));
                eprintln!("{}", super::last_words(&said));
                kill(pid);
            }
        });
        Watchdog { _armed: armed }
    }
}
