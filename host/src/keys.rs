//! The global keys (design §12): the capture key, which opens capture from any app, and the three keys that answer a
//! waiting question from any app (one goes to the question, one says yes, one says no). Each is what its preference
//! says (`capture_key`, `question_key`, `yes_key`, `no_key`), or with none this system's own (`Shortcut::capture`,
//! `Shortcut::answer`), and the host registers it whenever the core's records say it changed: the capture key always,
//! the answer keys only while a question waits, so that they take no keys from other apps the rest of the time. The
//! system may refuse a combination, because another app holds it: the key registered before then stays registered and
//! goes on working.
//!
//! Settings changes a key with `host.capture_key {key}` or `host.answer_key {which, key}` rather than with a `put` of
//! its own, so that it hears the refusal at once: the host applies the rule of a shortcut and keeps Tasktap's keys
//! apart (`tasktap_proto::clash`), asks the system, stores the preference only when the system took the key, and
//! answers with the keys in use now. An answer key is asked for even while no question waits: registered and let go
//! at once, only so that a key another app holds is refused when it is recorded, not when the next question comes.
//! `host.capture_key {}` and `host.answer_key {}` only answer, which is how a page learns that the stored capture key
//! was refused at start.
use crate::Host;
use serde_json::{json, Value};
use std::str::FromStr;
use std::sync::Mutex;
use std::time::Duration;
use tasktap_proto::{clash, AnswerKey as Which, Outcome, PrefKey, Shortcut as Key};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

pub const TAKEN: &str = "That key is taken by the system or another app";

/// The key registered now: none before the core's records arrived, and while the system refuses
/// the only key asked for so far.
pub static CAPTURE: Mutex<Option<Key>> = Mutex::new(None);

/// The answer keys, as the preferences and this system say, and what of them is registered.
pub static ANSWERS: Mutex<Answers> =
    Mutex::new(Answers { keys: [None, None, None], held: [None, None, None], asking: false });

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
/// the key is taken; the reason goes to the log, as `event`.
fn register<'a>(app: &'a AppHandle, event: &'static str) -> impl FnMut(&Key, bool) -> Result<(), String> + 'a {
    move |key, on| {
        let shortcut = system(key).ok_or(Key::NO_KEY)?;
        let done = match on {
            true => app.global_shortcut().register(shortcut),
            false => app.global_shortcut().unregister(shortcut),
        };
        done.map_err(|e| {
            crate::log(json!({"event": event, "ok": false, "key": key, "why": e.to_string()}));
            TAKEN.to_owned()
        })
    }
}

/// The key with none chosen: this system's own; in a review build none, so that it never takes the key of the
/// person's own Tasktap, which it runs beside.
fn usual() -> Option<Key> {
    (!crate::REVIEW).then(|| Key::capture(cfg!(target_os = "macos")))
}

/// An answer key with none chosen: this system's own (Control-Option on a Mac, Alt-Shift elsewhere), and in a review
/// build none, as `usual`.
fn usual_answer(which: Which) -> Option<Key> {
    (!crate::REVIEW).then(|| Key::answer(cfg!(target_os = "macos"), which))
}

/// Makes `wanted` the registered key as `follow` does, or with none lets the registered one go.
fn hold(
    held: &mut Option<Key>,
    wanted: Option<Key>,
    set: impl FnMut(&Key, bool) -> Result<(), String>,
) -> Result<(), String> {
    match wanted {
        Some(wanted) => follow(held, wanted, set),
        None => {
            back(held, None, set);
            Ok(())
        }
    }
}

/// The preference as the core's records have it now: `None` is the usual key.
pub fn prefer(app: &AppHandle, key: Option<Key>) {
    let wanted = key.or_else(usual);
    if *CAPTURE.lock().unwrap() == wanted {
        return;
    }
    if hold(&mut CAPTURE.lock().unwrap(), wanted.clone(), register(app, "capture-key")).is_ok() {
        crate::log(json!({"event": "capture-key", "ok": true, "key": wanted}));
    }
}

/// Stores a key preference through the host's own connection, `id` set to `key` or with none deleted, and waits for
/// the core: the sentence of its refusal, or of its silence.
fn store(app: &AppHandle, id: PrefKey, key: &Option<Key>) -> Result<(), String> {
    let id = serde_json::to_value(id).map_err(|e| e.to_string())?;
    let (name, stored) = match key {
        Some(key) => ("put", json!({"c": "prefs", "id": id, "patch": key})),
        None => ("delete", json!({"c": "prefs", "id": id})),
    };
    let (tell, told) = std::sync::mpsc::channel();
    app.state::<Host>().link.call(name, stored, move |outcome| drop(tell.send(outcome)));
    match told.recv_timeout(Duration::from_secs(2)) {
        Ok(Outcome::Ok(_)) => Ok(()),
        Ok(Outcome::Err(e)) => Err(e.message),
        Err(_) => Err("The core did not answer, so the key was not changed".into()),
    }
}

/// `host.capture_key {key?}`. With `key`, a shortcut or null for the usual key (`usual`): the rule of a shortcut, then
/// the answer keys, which it may not be, then the system, and only when the system took it the preference is stored
/// (or deleted, for null); the core's refusal, or its silence, puts back what was registered before. The reply is
/// `{key}`, the key registered now, or null when none is.
pub fn call(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let Some(key) = args.get("key") else {
        return Ok(json!({"key": *CAPTURE.lock().unwrap()}));
    };
    let key: Option<Key> = serde_json::from_value(key.clone()).map_err(|e| e.to_string())?;
    let wanted = key.clone().or_else(usual);
    if let Some(why) = wanted.as_ref().and_then(|w| ANSWERS.lock().unwrap().clash(PrefKey::CaptureKey, w, None)) {
        return Err(why.into());
    }
    let before = CAPTURE.lock().unwrap().clone();
    hold(&mut CAPTURE.lock().unwrap(), wanted.clone(), register(app, "capture-key"))?;
    match store(app, PrefKey::CaptureKey, &key) {
        Ok(()) => {
            crate::log(json!({"event": "capture-key", "ok": true, "key": wanted}));
            Ok(json!({"key": wanted}))
        }
        Err(refused) => {
            back(&mut CAPTURE.lock().unwrap(), before, register(app, "capture-key"));
            Err(refused)
        }
    }
}

/// The three answer keys, in the order of `Which::ALL`.
pub struct Answers {
    /// Each key as it is now: the person's, or this system's own (`usual_answer`); none in a review build until the
    /// person records one.
    keys: [Option<Key>; 3],
    /// What the system holds of them now: each key while a question waits, nothing otherwise.
    held: [Option<Key>; 3],
    /// A question waits.
    asking: bool,
}

impl Answers {
    /// The keys the preferences say now (`stored`, none for this system's own): while a question waits a changed key
    /// is registered at once and the one before let go. The keys the system refused.
    fn want(&mut self, stored: [Option<Key>; 3], set: impl FnMut(&Key, bool) -> Result<(), String>) -> Vec<Which> {
        for which in Which::ALL {
            self.keys[which as usize] = stored[which as usize].clone().or_else(|| usual_answer(which));
        }
        let asking = self.asking;
        self.ask(asking, set)
    }

    /// A question began to wait (`on`), or none waits any more: each key is registered, or let go. A key the system
    /// refuses is left out, and the others work; the keys refused.
    fn ask(&mut self, on: bool, mut set: impl FnMut(&Key, bool) -> Result<(), String>) -> Vec<Which> {
        self.asking = on;
        let mut refused = Vec::new();
        for which in Which::ALL {
            let i = which as usize;
            match (on, self.keys[i].clone()) {
                (true, Some(key)) => {
                    if follow(&mut self.held[i], key, &mut set).is_err() {
                        refused.push(which);
                    }
                }
                _ => back(&mut self.held[i], None, &mut set),
            }
        }
        refused
    }

    /// Why `key` cannot be the key preference `id` beside the answer keys as they are and the capture key `capture`
    /// (none: not asked; the capture key itself is checked by the caller).
    fn clash(&self, id: PrefKey, key: &Key, capture: Option<&Key>) -> Option<&'static str> {
        let answers = Which::ALL.into_iter().filter_map(|w| Some((w.pref(), self.keys[w as usize].clone()?)));
        let in_use: Vec<_> = capture.map(|k| (PrefKey::CaptureKey, k.clone())).into_iter().chain(answers).collect();
        clash(id, key, &in_use)
    }

    /// Makes `key` (none: this system's own) the `which` key, beside the capture key `capture`: the rule of a
    /// shortcut, then Tasktap's other keys, then the system. While a question waits it is registered in place of the
    /// old one; otherwise the system is only asked for it, and it is let go at once. The key it was before.
    fn try_key(
        &mut self,
        which: Which,
        key: Option<Key>,
        capture: Option<&Key>,
        mut set: impl FnMut(&Key, bool) -> Result<(), String>,
    ) -> Result<Option<Key>, String> {
        let i = which as usize;
        let wanted = key.or_else(|| usual_answer(which));
        if let Some(wanted) = &wanted {
            if let Some(why) = wanted.refused().or_else(|| self.clash(which.pref(), wanted, capture)) {
                return Err(why.into());
            }
            if self.asking {
                follow(&mut self.held[i], wanted.clone(), &mut set)?;
            } else if self.keys[i].as_ref() != Some(wanted) {
                set(wanted, true)?;
                let _ = set(wanted, false);
            }
        } else if self.asking {
            back(&mut self.held[i], None, &mut set);
        }
        Ok(std::mem::replace(&mut self.keys[i], wanted))
    }

    /// Puts back `before` as the `which` key, after a change the core refused to store.
    fn put_back(&mut self, which: Which, before: Option<Key>, set: impl FnMut(&Key, bool) -> Result<(), String>) {
        let i = which as usize;
        self.keys[i] = before.clone();
        if self.asking {
            back(&mut self.held[i], before, set);
        }
    }

    /// The keys in use, as a page is told them: `{question, yes, no}`, each a shortcut or null.
    fn told(&self) -> Value {
        let [question, yes, no] = &self.keys;
        json!({"question": question, "yes": yes, "no": no})
    }
}

/// The answer keys' preferences as the core's records have them now, in the order of `Which::ALL`.
pub fn answers(app: &AppHandle, stored: [Option<Key>; 3]) {
    let mut answers = ANSWERS.lock().unwrap();
    let before = answers.keys.clone();
    let refused = answers.want(stored, register(app, "answer-keys"));
    if answers.keys != before {
        crate::log(
            json!({"event": "answer-keys", "keys": answers.told(), "on": answers.asking, "ok": refused.is_empty()}),
        );
    }
}

/// A question began to wait, or none waits any more.
pub fn asking(app: &AppHandle, on: bool) {
    let mut answers = ANSWERS.lock().unwrap();
    let refused = answers.ask(on, register(app, "answer-keys"));
    let refused: Vec<_> = refused.iter().map(|w| format!("{w:?}")).collect();
    crate::log(json!({"event": "answer-keys", "on": on, "ok": refused.is_empty(), "refused": refused}));
}

/// Which answer key a key the system reported is: one registered now.
pub fn answering(shortcut: &Shortcut) -> Option<Which> {
    let answers = ANSWERS.lock().unwrap();
    Which::ALL.into_iter().find(|w| answers.held[*w as usize].as_ref().and_then(system).as_ref() == Some(shortcut))
}

/// `host.answer_key {which?, key?}`. With `which` (`question`, `yes` or `no`) and `key`, a shortcut or null for this
/// system's own: tried as `Answers::try_key` does, and only when the system took it the preference is stored (or
/// deleted, for null); the core's refusal, or its silence, puts back the key before. The reply is the keys in use,
/// `{question, yes, no}`.
pub fn answer_call(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let which = match args["which"].as_str() {
        None => return Ok(ANSWERS.lock().unwrap().told()),
        Some("question") => Which::Question,
        Some("yes") => Which::Yes,
        Some("no") => Which::No,
        Some(other) => return Err(format!("there is no answer key {other}")),
    };
    let key: Option<Key> = serde_json::from_value(args["key"].clone()).map_err(|e| e.to_string())?;
    let capture = CAPTURE.lock().unwrap().clone();
    let before = ANSWERS.lock().unwrap().try_key(which, key.clone(), capture.as_ref(), register(app, "answer-keys"))?;
    match store(app, which.pref(), &key) {
        Ok(()) => {
            let answers = ANSWERS.lock().unwrap();
            crate::log(json!({"event": "answer-keys", "keys": answers.told(), "on": answers.asking, "ok": true}));
            Ok(answers.told())
        }
        Err(refused) => {
            ANSWERS.lock().unwrap().put_back(which, before, register(app, "answer-keys"));
            Err(refused)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(control: bool, alt: bool, code: &str) -> Key {
        Key { control, alt, shift: false, meta: false, code: code.into() }
    }

    /// The system, for a test: it holds what was registered, and another app holds `taken`. Every request is kept, in
    /// order, as the call that would be made: the key and whether it is registered or let go.
    struct System {
        taken: Vec<Key>,
        registered: Vec<Key>,
        asked: Vec<(Key, bool)>,
    }

    impl System {
        fn new(taken: Vec<Key>) -> System {
            System { taken, registered: Vec::new(), asked: Vec::new() }
        }
        fn set(&mut self) -> impl FnMut(&Key, bool) -> Result<(), String> + '_ {
            |key, on| {
                self.asked.push((key.clone(), on));
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
        let mut system = System::new(vec![taken.clone()]);
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
        let (mut held, mut system) = (None, System::new(vec![first.clone()]));
        assert_eq!(follow(&mut held, first, system.set()), Err(TAKEN.into()));
        assert_eq!(held, None);
        assert_eq!(follow(&mut held, other.clone(), system.set()), Ok(()));
        assert_eq!(held, Some(other));
    }

    #[test]
    fn a_change_the_core_refuses_puts_back_the_key_that_was_registered() {
        let (first, other) = (Key::capture(true), key(true, false, "KeyK"));
        let mut system = System::new(Vec::new());
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
        let (mut held, mut system) = (None, System::new(Vec::new()));
        follow(&mut held, other, system.set()).unwrap();
        back(&mut held, None, system.set());
        assert_eq!((held, system.registered.len()), (None, 0));
    }

    #[test]
    fn a_review_build_takes_no_key_until_one_is_chosen() {
        let other = key(true, false, "KeyK");
        assert_eq!(usual(), (!crate::REVIEW).then(|| Key::capture(cfg!(target_os = "macos"))));
        let mut system = System::new(Vec::new());
        let mut held = None;
        hold(&mut held, usual(), system.set()).unwrap();
        assert_eq!(system.registered.len(), usize::from(!crate::REVIEW));
        // A key chosen is registered in either build, and the usual one asked for again lets it go in a review build.
        hold(&mut held, Some(other.clone()), system.set()).unwrap();
        assert_eq!((held.clone(), system.registered.clone()), (Some(other.clone()), vec![other]));
        hold(&mut held, usual(), system.set()).unwrap();
        assert_eq!((held.clone(), system.registered.clone()), (usual(), usual().into_iter().collect::<Vec<_>>()));
        // Nor an answer key.
        for which in Which::ALL {
            assert_eq!(usual_answer(which), (!crate::REVIEW).then(|| Key::answer(cfg!(target_os = "macos"), which)));
        }
    }

    /// The answer keys with none stored, as the core's records first say them.
    fn defaults() -> Answers {
        let mut answers = Answers { keys: [None, None, None], held: [None, None, None], asking: false };
        answers.want([None, None, None], |_, _| panic!("the system was asked with no question waiting"));
        answers
    }

    #[test]
    fn the_answer_keys_are_each_systems_own_and_registered_only_while_a_question_waits() {
        if crate::REVIEW {
            return;
        }
        let mac = cfg!(target_os = "macos");
        // This system's own: Control-Option on a Mac; Alt-Shift on Windows, where Control-Alt is AltGr.
        let mut answers = defaults();
        let codes = ["KeyJ", "KeyY", "KeyN"];
        for (i, code) in codes.into_iter().enumerate() {
            let k = answers.keys[i].clone().unwrap();
            assert_eq!((k.control, k.alt, k.shift, k.meta, k.code.as_str()), (mac, true, !mac, false, code));
        }
        for (mac, written) in [(true, [true, true, false]), (false, [false, true, true])] {
            for (which, code) in Which::ALL.into_iter().zip(codes) {
                let k = Key::answer(mac, which);
                assert_eq!(([k.control, k.alt, k.shift], k.code.as_str()), (written, code), "{which:?}");
            }
        }
        // No question waits: nothing is registered, and the system is not asked.
        let mut system = System::new(Vec::new());
        assert_eq!(answers.ask(false, system.set()), Vec::new());
        assert!(system.asked.is_empty() && answers.held.iter().all(Option::is_none));
        // A question waits: all three are registered; it is answered: all three are let go.
        assert_eq!(answers.ask(true, system.set()), Vec::new());
        assert_eq!(system.registered, answers.keys.iter().flatten().cloned().collect::<Vec<_>>());
        assert_eq!(answers.ask(false, system.set()), Vec::new());
        assert!(system.registered.is_empty() && answers.held.iter().all(Option::is_none));
        // Another app holds the Yes key: the other two still work while a question waits.
        let yes = answers.keys[1].clone().unwrap();
        let mut system = System::new(vec![yes.clone()]);
        assert_eq!(answers.ask(true, system.set()), vec![Which::Yes]);
        assert_eq!(system.registered.len(), 2);
        assert_eq!(answers.held[1], None);
    }

    #[test]
    fn a_changed_answer_key_takes_effect_at_once_and_the_old_one_is_let_go() {
        if crate::REVIEW {
            return;
        }
        let mac = cfg!(target_os = "macos");
        let capture = Key::capture(mac);
        let (mine, taken) = (key(true, false, "KeyK"), key(true, false, "KeyT"));
        // No question waits: the system is asked for the key and it is let go at once; nothing stays registered.
        let mut answers = defaults();
        let mut system = System::new(vec![taken.clone()]);
        let old = answers.try_key(Which::Yes, Some(mine.clone()), Some(&capture), system.set());
        assert_eq!(old, Ok(Some(Key::answer(mac, Which::Yes))));
        assert_eq!(system.asked, vec![(mine.clone(), true), (mine.clone(), false)]);
        assert!(system.registered.is_empty());
        assert_eq!(answers.keys[1], Some(mine.clone()));
        // The same refusals as the capture key's: taken by another app, no modifier, and Tasktap's own other keys.
        assert_eq!(answers.try_key(Which::No, Some(taken.clone()), Some(&capture), system.set()), Err(TAKEN.into()));
        let bare = key(false, false, "KeyN");
        assert_eq!(answers.try_key(Which::No, Some(bare), Some(&capture), system.set()), Err(Key::BARE.into()));
        let to_capture = answers.try_key(Which::No, Some(capture.clone()), Some(&capture), system.set());
        assert_eq!(to_capture, Err(Key::CAPTURES.into()));
        let to_yes = answers.try_key(Which::Question, Some(mine.clone()), Some(&capture), system.set());
        assert_eq!(to_yes, Err(Key::ANSWERS.into()));
        assert_eq!(answers.clash(PrefKey::CaptureKey, &mine, None), Some(Key::ANSWERS));
        assert_eq!(answers.keys[2], Some(Key::answer(mac, Which::No)), "a refused key changes nothing");

        // A question waits: the new key is registered and the one before let go, at once.
        let mut system = System::new(Vec::new());
        answers.ask(true, system.set());
        let other = key(true, false, "KeyL");
        system.asked.clear();
        answers.try_key(Which::Yes, Some(other.clone()), Some(&capture), system.set()).unwrap();
        assert_eq!(system.asked, vec![(other.clone(), true), (mine.clone(), false)]);
        assert!(system.registered.contains(&other) && !system.registered.contains(&mine));
        // The core refused to store it: the one before is registered again.
        answers.put_back(Which::Yes, Some(mine.clone()), system.set());
        assert!(system.registered.contains(&mine) && !system.registered.contains(&other));
        // Back to this system's own (null), and a preference changed elsewhere follows at once too.
        answers.try_key(Which::Yes, None, Some(&capture), system.set()).unwrap();
        assert_eq!(answers.held[1], Some(Key::answer(mac, Which::Yes)));
        let refused = answers.want([Some(other.clone()), None, None], system.set());
        assert_eq!((refused, answers.held[0].clone()), (Vec::new(), Some(other.clone())));
        assert!(system.registered.contains(&other) && !system.registered.contains(&Key::answer(mac, Which::Question)));
        // Answered: nothing of them stays registered.
        answers.ask(false, system.set());
        assert!(system.registered.is_empty());
        assert_eq!(answers.told()["question"], serde_json::to_value(&other).unwrap());
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
        let control_alt = Some(Modifiers::CONTROL | Modifiers::ALT);
        assert_eq!(system(&Key::capture(true)), Some(Shortcut::new(control_alt, Code::Space)));
        assert_eq!(system(&key(true, false, "Nothing")), None);
        // The answer keys, on both systems.
        assert_eq!(system(&Key::answer(true, Which::Question)), Some(Shortcut::new(control_alt, Code::KeyJ)));
        let alt_shift = Some(Modifiers::ALT | Modifiers::SHIFT);
        assert_eq!(system(&Key::answer(false, Which::Yes)), Some(Shortcut::new(alt_shift, Code::KeyY)));
    }
}
