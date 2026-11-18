//! The capture key: the global shortcut that opens capture from any app (design §12). It is what the
//! `capture_key` preference says, or with none this system's own (`Shortcut::capture`), and the host
//! registers it whenever the core's records say it changed. The system may refuse a combination,
//! because another app holds it: the key registered before then stays registered and goes on working.
//!
//! Settings changes the key with `host.capture_key {key}` rather than with a `put` of its own, so that
//! it hears the refusal at once: the host asks the system first, stores the preference only when the
//! system took the key, and answers with the key that is registered now. `host.capture_key {}` only
//! answers, which is how a page learns that the stored key was refused at start.
use crate::Host;
use serde_json::{json, Value};
use std::str::FromStr;
use std::sync::Mutex;
use std::time::Duration;
use tasktap_proto::{Outcome, Shortcut as Key};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

pub const TAKEN: &str = "That key is taken by the system or another app";

/// The key registered now: none before the core's records arrived, and while the system refuses
/// the only key asked for so far.
pub static CAPTURE: Mutex<Option<Key>> = Mutex::new(None);

/// The key as the system's hot keys name it. Every key the rule of a shortcut lets through is one.
pub fn system(key: &Key) -> Option<Shortcut> {
    let held = [
        (key.control, Modifiers::CONTROL),
        (key.alt, Modifiers::ALT),
        (key.shift, Modifiers::SHIFT),
        (key.meta, Modifiers::SUPER),
    ];
    let mods = held.into_iter().filter(|(on, _)| *on).fold(Modifiers::empty(), |all, (_, m)| all | m);
    Some(Shortcut::new(Some(mods), Code::from_str(&key.code).ok()?))
}

/// Makes `wanted` the registered key: registered first and the old one let go after, so that a
/// refusal, by the rule of a shortcut or by `set` (the system), leaves the old one as it was.
pub fn follow(
    held: &mut Option<Key>,
    wanted: Key,
    mut set: impl FnMut(&Key, bool) -> Result<(), String>,
) -> Result<(), String> {
    if held.as_ref() == Some(&wanted) {
        return Ok(());
    }
    if let Some(why) = wanted.refused() {
        return Err(why.into());
    }
    set(&wanted, true)?;
    if let Some(old) = held.replace(wanted) {
        let _ = set(&old, false);
    }
    Ok(())
}

/// Puts back the key that was registered `before` a change the core then refused: the one registered
/// meanwhile is let go, and the old one is asked for again.
pub fn back(held: &mut Option<Key>, before: Option<Key>, mut set: impl FnMut(&Key, bool) -> Result<(), String>) {
    if *held == before {
        return;
    }
    if let Some(now) = held.take() {
        let _ = set(&now, false);
    }
    if let Some(before) = before {
        let _ = follow(held, before, set);
    }
}

/// Registers a key with the system, or lets it go. Whatever the system's reason, the person is told
/// the key is taken; the reason goes to the log.
fn register(app: &AppHandle) -> impl FnMut(&Key, bool) -> Result<(), String> + '_ {
    move |key, on| {
        let shortcut = system(key).ok_or(Key::NO_KEY)?;
        let done = match on {
            true => app.global_shortcut().register(shortcut),
            false => app.global_shortcut().unregister(shortcut),
        };
        done.map_err(|e| {
            crate::log(json!({"event": "capture-key", "ok": false, "key": key, "why": e.to_string()}));
            TAKEN.to_owned()
        })
    }
}

/// The preference as the core's records have it now: `None` is this system's own key.
pub fn prefer(app: &AppHandle, key: Option<Key>) {
    let wanted = key.unwrap_or_else(|| Key::capture(cfg!(target_os = "macos")));
    if follow(&mut CAPTURE.lock().unwrap(), wanted.clone(), register(app)).is_ok() {
        crate::log(json!({"event": "capture-key", "ok": true, "key": wanted}));
    }
}

/// `host.capture_key {key?}`. With `key`, a shortcut or null for this system's own: the system is
/// asked for it, and only when it took it the preference is stored (or deleted, for null); the core's
/// refusal, or its silence, puts back what was registered before. The reply is `{key}`, the key
/// registered now, or null when none is.
pub fn call(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let Some(key) = args.get("key") else {
        return Ok(json!({"key": *CAPTURE.lock().unwrap()}));
    };
    let key: Option<Key> = serde_json::from_value(key.clone()).map_err(|e| e.to_string())?;
    let wanted = key.clone().unwrap_or_else(|| Key::capture(cfg!(target_os = "macos")));
    let before = CAPTURE.lock().unwrap().clone();
    follow(&mut CAPTURE.lock().unwrap(), wanted.clone(), register(app))?;
    let (name, stored) = match &key {
        Some(key) => ("put", json!({"c": "prefs", "id": "capture_key", "patch": key})),
        None => ("delete", json!({"c": "prefs", "id": "capture_key"})),
    };
    let (tell, told) = std::sync::mpsc::channel();
    app.state::<Host>().link.call(name, stored, move |outcome| drop(tell.send(outcome)));
    let refused = match told.recv_timeout(Duration::from_secs(2)) {
        Ok(Outcome::Ok(_)) => return Ok(json!({"key": wanted})),
        Ok(Outcome::Err(e)) => e.message,
        Err(_) => "The core did not answer, so the key was not changed".into(),
    };
    back(&mut CAPTURE.lock().unwrap(), before, register(app));
    Err(refused)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(control: bool, alt: bool, code: &str) -> Key {
        Key { control, alt, shift: false, meta: false, code: code.into() }
    }

    /// The system, for a test: it holds what was registered, and another app holds `taken`.
    struct System {
        taken: Vec<Key>,
        registered: Vec<Key>,
    }

    impl System {
        fn set(&mut self) -> impl FnMut(&Key, bool) -> Result<(), String> + '_ {
            |key, on| {
                if on && (self.taken.contains(key) || self.registered.contains(key)) {
                    return Err(TAKEN.into());
                }
                self.registered.retain(|k| k != key);
                if on {
                    self.registered.push(key.clone());
                }
                Ok(())
            }
        }
    }

    #[test]
    fn a_key_the_system_refuses_leaves_the_old_one_registered_and_says_it_is_taken() {
        let (first, other, taken) = (Key::capture(true), key(true, false, "KeyK"), key(false, true, "Space"));
        let mut system = System { taken: vec![taken.clone()], registered: Vec::new() };
        let mut held = None;
        // The first key, as the preference's default is registered at start.
        assert_eq!(follow(&mut held, first.clone(), system.set()), Ok(()));
        assert_eq!((held.clone(), system.registered.clone()), (Some(first.clone()), vec![first.clone()]));
        // The same again asks the system for nothing.
        assert_eq!(follow(&mut held, first.clone(), |_, _| Err("asked".into())), Ok(()));
        // Another app has the next one: said so, and the old one is still the registered one.
        assert_eq!(follow(&mut held, taken.clone(), system.set()), Err(TAKEN.into()));
        assert_eq!((held.clone(), system.registered.clone()), (Some(first.clone()), vec![first.clone()]));
        // One the rule of a shortcut refuses never reaches the system.
        let bare = key(false, false, "Space");
        assert_eq!(follow(&mut held, bare, |_, _| Err("asked".into())), Err(Key::BARE.into()));
        assert_eq!(held, Some(first.clone()));
        // A free one replaces it, and the old one is let go.
        assert_eq!(follow(&mut held, other.clone(), system.set()), Ok(()));
        assert_eq!((held.clone(), system.registered.clone()), (Some(other.clone()), vec![other.clone()]));
        // With none registered, because the system refused the first, the next free one is taken.
        let (mut held, mut system) = (None, System { taken: vec![first.clone()], registered: Vec::new() });
        assert_eq!(follow(&mut held, first, system.set()), Err(TAKEN.into()));
        assert_eq!(held, None);
        assert_eq!(follow(&mut held, other.clone(), system.set()), Ok(()));
        assert_eq!(held, Some(other));
    }

    #[test]
    fn a_change_the_core_refuses_puts_back_the_key_that_was_registered() {
        let (first, other) = (Key::capture(true), key(true, false, "KeyK"));
        let mut system = System { taken: Vec::new(), registered: Vec::new() };
        let mut held = None;
        follow(&mut held, first.clone(), system.set()).unwrap();
        // Another key was taken by the system, and then the core refused to store it.
        let before = held.clone();
        follow(&mut held, other.clone(), system.set()).unwrap();
        back(&mut held, before.clone(), system.set());
        assert_eq!((held.clone(), system.registered.clone()), (Some(first.clone()), vec![first.clone()]));
        // The same key asked for again, and refused by the core: nothing was changed, nothing is put back.
        back(&mut held, before, |_, _| panic!("the system was asked"));
        assert_eq!(held, Some(first.clone()));
        // With none registered before, none is afterwards.
        let (mut held, mut system) = (None, System { taken: Vec::new(), registered: Vec::new() });
        follow(&mut held, other, system.set()).unwrap();
        back(&mut held, None, system.set());
        assert_eq!((held, system.registered.len()), (None, 0));
    }

    #[test]
    fn every_key_a_shortcut_can_end_in_is_one_the_system_registers() {
        let letters = (b'A'..=b'Z').map(|c| format!("Key{}", c as char));
        let digits = (0..=9).map(|n| format!("Digit{n}"));
        let functions = (1..=12).map(|n| format!("F{n}"));
        let named = [
            "Space",
            "Enter",
            "Tab",
            "Escape",
            "Backspace",
            "Delete",
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "Minus",
            "Equal",
            "BracketLeft",
            "BracketRight",
            "Backslash",
            "Semicolon",
            "Quote",
            "Backquote",
            "Comma",
            "Period",
            "Slash",
        ];
        for code in letters.chain(digits).chain(functions).chain(named.map(String::from)) {
            let key = Key { control: true, alt: false, shift: true, meta: true, code: code.clone() };
            // Refused by the rule or not, a key the rule knows has a name the system knows.
            assert_ne!(key.refused(), Some(Key::NO_KEY), "{code}");
            let shortcut = system(&key).unwrap_or_else(|| panic!("{code} is no key of the system"));
            assert_eq!(shortcut.mods, Modifiers::CONTROL | Modifiers::SHIFT | Modifiers::SUPER, "{code}");
        }
        assert_eq!(system(&Key::capture(true)), Some(crate::keys(Code::Space)));
        assert_eq!(system(&key(true, false, "Nothing")), None);
    }
}
