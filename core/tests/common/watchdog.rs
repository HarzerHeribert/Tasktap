//! Kills a test's core when the test holds it too long.

use std::process::{Child, Command};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::Duration;

/// Longest a test may hold a core.
pub const PATIENCE: Duration = Duration::from_secs(60);

/// Kills a test's core if the test still holds it after [`PATIENCE`]. A
/// Windows pipe opened for blocking I/O has no read or write timeout, so
/// killing the other end is what turns a read, a write or a wait for the
/// core to exit that would never return into an error at that line, on
/// every platform alike. Dropping the watchdog disarms it.
pub struct Watchdog {
    _armed: Sender<()>,
}

impl Watchdog {
    pub fn new(core: &Child) -> Watchdog {
        let (armed, disarmed) = mpsc::channel();
        let pid = core.id().to_string();
        let test = std::thread::current().name().unwrap_or("a test").to_owned();
        std::thread::spawn(move || {
            if disarmed.recv_timeout(PATIENCE) == Err(RecvTimeoutError::Timeout) {
                eprintln!("{test} still holds its core after {PATIENCE:?}: killing it");
                #[cfg(unix)]
                let kill = Command::new("kill").args(["-9", &pid]).status();
                #[cfg(windows)]
                let kill = Command::new("taskkill").args(["/F", "/PID", &pid]).status();
                let _ = kill;
            }
        });
        Watchdog { _armed: armed }
    }
}
