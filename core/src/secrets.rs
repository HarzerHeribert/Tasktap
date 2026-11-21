//! Keys in the system's credential store (design §8, "Keys"): the macOS
//! Keychain through `/usr/bin/security`, the Windows Credential Manager
//! through its own calls (`sys.rs`), the Secret Service on Linux through
//! `secret-tool` where it is installed. A key is set, read and removed by
//! name, and this is the only code that touches one at rest: none is ever
//! written to the core's database, a record, a reply or a log.
//!
//! Every method blocks for a moment (a tool is started, or the store is
//! asked), so the core calls them off its thread.

use std::sync::Arc;

/// The service the core's keys are stored under: another for a build made
/// to try beside the person's own app (`host/scripts/build-review.sh`), so
/// that it never reads or replaces that app's keys.
pub const SERVICE: &str = match option_env!("TASKTAP_KEY_SERVICE") {
    Some(service) => service,
    None => "Tasktap",
};

/// A store of keys by name.
pub trait Vault: Send + Sync {
    /// Stores `key` under `name`, in place of any before.
    fn set(&self, name: &str, key: &str) -> Result<(), String>;
    /// The key under `name`, or none.
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    /// Removes the key under `name`; none there is no failure.
    fn remove(&self, name: &str) -> Result<(), String>;
}

/// Whether `text` can be a name or a key: 1 to 512 printable ASCII
/// characters, none a space, a quote or a backslash, so that it needs no
/// escaping wherever it is written (a tool's command, curl's
/// configuration) and reads back as it was stored.
pub fn plain(text: &str) -> bool {
    let fits = |b: u8| b.is_ascii_graphic() && b != b'"' && b != b'\\';
    (1..=512).contains(&text.len()) && text.bytes().all(fits)
}

/// The store this core keeps its keys in: the system's, or in a build with
/// the test fixtures one in memory, so that no test reaches the real one.
pub fn vault() -> Arc<dyn Vault> {
    #[cfg(feature = "fixtures")]
    return Arc::new(Memory::default());
    #[cfg(not(feature = "fixtures"))]
    Arc::new(System(SERVICE))
}

/// Keys in memory, gone with the process: what the tests use. It keeps
/// nothing while the file `TASKTAP_VAULT_REFUSES` names is there, as a
/// store that is locked or full.
#[cfg(feature = "fixtures")]
#[derive(Default)]
pub struct Memory(std::sync::Mutex<std::collections::HashMap<String, String>>);

#[cfg(feature = "fixtures")]
impl Vault for Memory {
    fn set(&self, name: &str, key: &str) -> Result<(), String> {
        let refuses = std::env::var_os("TASKTAP_VAULT_REFUSES");
        if refuses.is_some_and(|file| std::path::Path::new(&file).exists()) {
            return Err("the credential store refused to keep it (a test's refusal)".into());
        }
        let mut keys = self.0.lock().map_err(|e| e.to_string())?;
        keys.insert(name.into(), key.into());
        Ok(())
    }

    fn get(&self, name: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().map_err(|e| e.to_string())?.get(name).cloned())
    }

    fn remove(&self, name: &str) -> Result<(), String> {
        self.0.lock().map_err(|e| e.to_string())?.remove(name);
        Ok(())
    }
}

/// The system's credential store, under a service's name.
pub struct System(pub &'static str);

impl System {
    fn checked(name: &str, key: Option<&str>) -> Result<(), String> {
        match plain(name) && key.is_none_or(plain) {
            true => Ok(()),
            false => Err("a key and its name are 1 to 512 printable characters, \
                 none a space, a quote or a backslash"
                .into()),
        }
    }
}

impl Vault for System {
    fn set(&self, name: &str, key: &str) -> Result<(), String> {
        System::checked(name, Some(key))?;
        store::set(self.0, name, key)?;
        // Read back: the Mac's tool reports no failure of its own.
        match store::get(self.0, name)? {
            Some(kept) if kept == key => Ok(()),
            _ => Err("the system's credential store did not keep the key".into()),
        }
    }

    fn get(&self, name: &str) -> Result<Option<String>, String> {
        System::checked(name, None)?;
        store::get(self.0, name)
    }

    fn remove(&self, name: &str) -> Result<(), String> {
        System::checked(name, None)?;
        store::remove(self.0, name)
    }
}

/// Runs one of the system's credential tools, within 10 s, and returns its
/// exit code and what it printed.
#[cfg(not(windows))]
fn tool(program: &str, args: &[&str], input: String) -> Result<(Option<i32>, String), String> {
    use crate::command::{Failed, run};
    let mut command = std::process::Command::new(program);
    command.args(args);
    let limit = std::time::Duration::from_secs(10);
    match run(
        command,
        input.into_bytes(),
        limit,
        4096,
        std::sync::mpsc::channel(),
    ) {
        Ok(ran) => Ok((ran.code, String::from_utf8_lossy(&ran.out).into_owned())),
        Err(Failed::Missing) => Err(format!(
            "This system has no credential store Tasktap can use ({program} is not installed)"
        )),
        Err(Failed::Slow) => Err("The system's credential store did not answer within 10 s; \
             it may be locked or waiting for you"
            .into()),
        Err(why) => Err(format!("{program} could not be used: {why:?}")),
    }
}

/// The Keychain, through the tool macOS ships. An entry it makes is its
/// own, so it reads it back without a dialog whatever build of the core
/// asks, which an entry the core made itself would not allow an ad-hoc
/// signed app after an update (design §8).
#[cfg(target_os = "macos")]
mod store {
    use super::tool;

    const SECURITY: &str = "/usr/bin/security";
    /// What `security` exits with when the Keychain has no such entry.
    const NOT_FOUND: i32 = 44;

    pub fn set(service: &str, name: &str, key: &str) -> Result<(), String> {
        // The command is read from standard input (`-i`), so the key is in
        // no argument and no process list. Neither value needs escaping:
        // `plain` allows no quote and no backslash.
        let command =
            format!("add-generic-password -U -s \"{service}\" -a \"{name}\" -w \"{key}\"\n");
        tool(SECURITY, &["-i"], command).map(|_| ())
    }

    pub fn get(service: &str, name: &str) -> Result<Option<String>, String> {
        let args = ["find-generic-password", "-s", service, "-a", name, "-w"];
        match tool(SECURITY, &args, String::new())? {
            (Some(0), key) => Ok(Some(key.trim_end_matches('\n').to_owned())),
            (Some(NOT_FOUND), _) => Ok(None),
            (code, _) => Err(format!(
                "the Keychain refused (security exited with {code:?})"
            )),
        }
    }

    pub fn remove(service: &str, name: &str) -> Result<(), String> {
        let args = ["delete-generic-password", "-s", service, "-a", name];
        match tool(SECURITY, &args, String::new())? {
            (Some(0 | NOT_FOUND), _) => Ok(()),
            (code, _) => Err(format!(
                "the Keychain refused (security exited with {code:?})"
            )),
        }
    }
}

/// The Secret Service, through libsecret's tool where it is installed.
#[cfg(all(unix, not(target_os = "macos")))]
mod store {
    use super::tool;

    const TOOL: &str = "secret-tool";

    pub fn set(service: &str, name: &str, key: &str) -> Result<(), String> {
        let label = format!("{service}: {name}");
        let args = [
            "store", "--label", &label, "service", service, "account", name,
        ];
        // The key is read from standard input.
        match tool(TOOL, &args, key.to_owned())? {
            (Some(0), _) => Ok(()),
            (code, _) => Err(format!(
                "the Secret Service refused (secret-tool exited with {code:?})"
            )),
        }
    }

    pub fn get(service: &str, name: &str) -> Result<Option<String>, String> {
        let args = ["lookup", "service", service, "account", name];
        match tool(TOOL, &args, String::new())? {
            (Some(0), key) if !key.is_empty() => Ok(Some(key.trim_end_matches('\n').to_owned())),
            // It exits with 1 and prints nothing when there is no such entry.
            (Some(0 | 1), _) => Ok(None),
            (code, _) => Err(format!(
                "the Secret Service refused (secret-tool exited with {code:?})"
            )),
        }
    }

    pub fn remove(service: &str, name: &str) -> Result<(), String> {
        let args = ["clear", "service", service, "account", name];
        tool(TOOL, &args, String::new()).map(|_| ())
    }
}

/// The Credential Manager: a generic credential named `<service>:<name>`.
#[cfg(windows)]
mod store {
    use crate::sys::credential;

    fn target(service: &str, name: &str) -> String {
        format!("{service}:{name}")
    }

    pub fn set(service: &str, name: &str, key: &str) -> Result<(), String> {
        credential::write(&target(service, name), key.as_bytes()).map_err(|e| e.to_string())
    }

    pub fn get(service: &str, name: &str) -> Result<Option<String>, String> {
        let found = credential::read(&target(service, name)).map_err(|e| e.to_string())?;
        Ok(found.map(|key| String::from_utf8_lossy(&key).into_owned()))
    }

    pub fn remove(service: &str, name: &str) -> Result<(), String> {
        credential::delete(&target(service, name)).map_err(|e| e.to_string())
    }
}
