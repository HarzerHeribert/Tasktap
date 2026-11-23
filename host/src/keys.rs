//! The keys a person records (design §12). Four are global: the capture key, which opens capture from any app, and
//! the three keys that answer a waiting question from any app (one goes to the question, one says yes, one says no).
//! The fifth, the key held to talk, is the page's own and heard only in Tasktap. Each is what its preference says
//! (`capture_key`, `question_key`, `yes_key`, `no_key`, `talk_key`), or with none this system's own
//! (`Shortcut::usual`). The host registers the global ones whenever the core's records say they changed: the capture
//! key always, the answer keys only while a question waits, so that they take no keys from other apps the rest of
//! the time. A review build takes no global key at all, chosen or not: they are the person's own Tasktap's, which it
//! runs beside, and its pages name none (`takes` in the replies below).
//!
//! Settings records every key through the host (`host.capture_key {key}`, `host.answer_key {which, key}`,
//! `host.talk_key {key}`) rather than with a `put` of its own, so that it hears a refusal at once and the key in use
//! stays. Each is held, in this order, to the rule of a shortcut (`Shortcut::refused`), to Tasktap's other keys as they
//! are now (`tasktap_proto::clash`, whose sentence names the key that has it already), and to the system: a key another
//! app holds is refused when it is recorded, whichever key it is and whether or not a question waits. The capture key,
//! and an answer key while a question waits, is registered in place of the old one, which is let go only once the new
//! one is held; an answer key while none waits, and the talk key, is registered and let go at once, only to ask. A
//! registration the system refuses is a refusal: "That key is taken by the system or another app", and the key before
//! stays. Only then is the preference stored; the core's refusal, or its silence, puts back what was before. Without
//! `key` each call only answers, which is how a page learns the keys in use, and that the stored capture key was
//! refused at start.
use crate::Host;
use serde_json::{json, Value};
use std::str::FromStr;
use std::sync::Mutex;
use std::time::Duration;
use tasktap_proto::{clash, AnswerKey as Which, Outcome, PrefKey, Shortcut as Key};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

pub const TAKEN: &str = "That key is taken by the system or another app";
/// What a review build answers when asked to take a global key.
pub const NONE_HERE: &str = "Tasktap Review takes no keys from other apps";

/// The capture key registered now: none before the core's records arrived, while the system refuses the only key
/// asked for so far, and always in a review build.
pub static CAPTURE: Mutex<Option<Key>> = Mutex::new(None);

/// The answer keys, as the preferences and this system say, and what of them is registered.
pub static ANSWERS: Mutex<Answers> =
    Mutex::new(Answers { keys: [None, None, None], held: [None, None, None], asking: false });

/// The key held to talk, as the preference says or the pages' own: never registered, only kept apart from the others.
pub static TALK: Mutex<Option<Key>> = Mutex::new(None);

/// Whether this copy takes global keys: every copy but a review build.
pub const TAKES: bool = !crate::REVIEW;

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

/// Whether `key` may be the key preference `id` before the system is asked: the rule of a shortcut, then no key of
/// Tasktap's own window (`own_key`), then none of Tasktap's other keys as they are now (`others`), then, for a key
/// taken from other apps, none every app has (`every_app`).
fn allowed(id: PrefKey, key: &Key, others: &[(PrefKey, Key)]) -> Result<(), String> {
    if let Some(why) = key.refused() {
        return Err(why.into());
    }
    let mac = cfg!(target_os = "macos");
    if let Some(why) = tasktap_proto::own_key(id, key, mac) {
        return Err(why);
    }
    match clash(id, key, others).or_else(|| tasktap_proto::every_app(id, key, mac)) {
        Some(why) => Err(why.into()),
        None => Ok(()),
    }
}

/// Asks the system whether another app holds `key`, as a person records it: registered and let go at once. A
/// registration that fails is a refusal.
fn ask_free(key: &Key, mut set: impl FnMut(&Key, bool) -> Result<(), String>) -> Result<(), String> {
    set(key, true)?;
    let _ = set(key, false);
    Ok(())
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

/// A global key as it is to be: the person's (`stored`) or this system's own (`usual`); in a review build none.
fn global(stored: Option<Key>, usual: impl FnOnce() -> Key) -> Option<Key> {
    TAKES.then(|| stored.unwrap_or_else(usual))
}

/// The capture key with none chosen.
fn usual() -> Key {
    Key::capture(cfg!(target_os = "macos"))
}

/// The talk key, as the preference says or the pages' own.
fn talk_key(stored: Option<Key>) -> Key {
    stored.unwrap_or_else(|| Key::talk(cfg!(target_os = "macos")))
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

/// Makes `key` (none: this system's own) the capture key, beside Tasktap's other keys (`others`): the rule, the
/// others, then the system, which registers it in place of the key before; a refusal leaves that one registered. The
/// key before.
fn take_capture(
    held: &mut Option<Key>,
    key: Option<Key>,
    others: &[(PrefKey, Key)],
    set: impl FnMut(&Key, bool) -> Result<(), String>,
) -> Result<Option<Key>, String> {
    if !TAKES {
        return Err(NONE_HERE.into());
    }
    let wanted = key.unwrap_or_else(usual);
    allowed(PrefKey::CaptureKey, &wanted, others)?;
    let before = held.clone();
    follow(held, wanted, set)?;
    Ok(before)
}

/// Makes `key` (none: the pages' own) the talk key, beside Tasktap's other keys (`others`): the rule, the others, then
/// the system, asked whether another app holds it, which would never let it reach Tasktap. The key before.
fn take_talk(
    now: &mut Option<Key>,
    key: Option<Key>,
    others: &[(PrefKey, Key)],
    set: impl FnMut(&Key, bool) -> Result<(), String>,
) -> Result<Option<Key>, String> {
    let wanted = talk_key(key);
    allowed(PrefKey::TalkKey, &wanted, others)?;
    if now.as_ref() != Some(&wanted) {
        ask_free(&wanted, set)?;
    }
    Ok(now.replace(wanted))
}

/// The preference as the core's records have it now: `None` is the usual key.
pub fn prefer(app: &AppHandle, key: Option<Key>) {
    let wanted = global(key, usual);
    if *CAPTURE.lock().unwrap() == wanted {
        return;
    }
    if hold(&mut CAPTURE.lock().unwrap(), wanted.clone(), register(app, "capture-key")).is_ok() {
        crate::log(json!({"event": "capture-key", "ok": true, "key": wanted}));
    }
}

/// The talk key's preference as the core's records have it now.
pub fn talk(key: Option<Key>) {
    *TALK.lock().unwrap() = Some(talk_key(key));
}

/// Tasktap's keys but the one `except` names, as the host has them now: the capture key registered, the answer keys,
/// the talk key.
fn others(except: PrefKey) -> Vec<(PrefKey, Key)> {
    let capture = CAPTURE.lock().unwrap().clone().map(|k| (PrefKey::CaptureKey, k));
    let talk = TALK.lock().unwrap().clone().map(|k| (PrefKey::TalkKey, k));
    let answers = ANSWERS.lock().unwrap().in_use();
    capture.into_iter().chain(answers).chain(talk).filter(|(id, _)| *id != except).collect()
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
    let Some(link) = app.state::<Host>().link.get().cloned() else {
        return Err("Tasktap's core is still starting, so the key was not changed".into());
    };
    link.call(name, stored, move |outcome| drop(tell.send(outcome)));
    match told.recv_timeout(Duration::from_secs(2)) {
        Ok(Outcome::Ok(_)) => Ok(()),
        Ok(Outcome::Err(e)) => Err(e.message),
        Err(_) => Err("The core did not answer, so the key was not changed".into()),
    }
}

/// `host.capture_key {key?}`. With `key`, a shortcut or null for this system's own: `take_capture`, and only when the
/// system took it the preference is stored (or deleted, for null); the core's refusal, or its silence, puts back what
/// was registered before. The reply is `{key, takes}`: the key registered now, or null when none is, and whether this
/// copy takes global keys at all.
pub fn call(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let Some(key) = args.get("key") else {
        return Ok(json!({"key": *CAPTURE.lock().unwrap(), "takes": TAKES}));
    };
    let key: Option<Key> = serde_json::from_value(key.clone()).map_err(|e| e.to_string())?;
    let others = others(PrefKey::CaptureKey);
    let before = take_capture(&mut CAPTURE.lock().unwrap(), key.clone(), &others, register(app, "capture-key"))?;
    let now = CAPTURE.lock().unwrap().clone();
    match store(app, PrefKey::CaptureKey, &key) {
        Ok(()) => {
            crate::log(json!({"event": "capture-key", "ok": true, "key": now}));
            Ok(json!({"key": now, "takes": TAKES}))
        }
        Err(refused) => {
            back(&mut CAPTURE.lock().unwrap(), before, register(app, "capture-key"));
            Err(refused)
        }
    }
}

/// `host.talk_key {key?}`. With `key`, a shortcut or null for the pages' own: `take_talk`, then the preference stored
/// (or deleted, for null); the core's refusal puts back the key before. The reply is `{key}`, the talk key now. Each
/// change goes to the log as `talk-key`, with what was asked when it was refused and how long it took.
pub fn talk_call(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let Some(key) = args.get("key") else {
        return Ok(json!({"key": *TALK.lock().unwrap()}));
    };
    let key: Option<Key> = serde_json::from_value(key.clone()).map_err(|e| e.to_string())?;
    let others = others(PrefKey::TalkKey);
    let at = std::time::Instant::now();
    // (The lock is let go before the store: the core's link may hand the changed preference to `talk` before it hands
    // over the answer, and `talk` takes the lock.)
    let taken = take_talk(&mut TALK.lock().unwrap(), key.clone(), &others, register(app, "talk-key"));
    let done =
        taken.and_then(|before| store(app, PrefKey::TalkKey, &key).inspect_err(|_| *TALK.lock().unwrap() = before));
    let now = TALK.lock().unwrap().clone();
    let ms = at.elapsed().as_millis() as u64;
    match done {
        Ok(()) => {
            crate::log(json!({"event": "talk-key", "ok": true, "key": now, "ms": ms}));
            Ok(json!({"key": now}))
        }
        Err(why) => {
            crate::log(json!({"event": "talk-key", "ok": false, "asked": key, "key": now, "why": why, "ms": ms}));
            Err(why)
        }
    }
}

/// The three answer keys, in the order of `Which::ALL`.
pub struct Answers {
    /// Each key as it is now: the person's, or this system's own; none in a review build.
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
            let mac = cfg!(target_os = "macos");
            self.keys[which as usize] = global(stored[which as usize].clone(), || Key::answer(mac, which));
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

    /// The answer keys as they are now, each by its preference.
    fn in_use(&self) -> Vec<(PrefKey, Key)> {
        Which::ALL.into_iter().filter_map(|w| Some((w.pref(), self.keys[w as usize].clone()?))).collect()
    }

    /// Makes `key` (none: this system's own) the `which` key, beside Tasktap's other keys but the answer keys
    /// (`others`): the rule, every other key, then the system. While a question waits it is registered in place of
    /// the old one; otherwise the system is asked for it and it is let go at once. A refusal leaves the key before.
    /// The key it was before.
    fn try_key(
        &mut self,
        which: Which,
        key: Option<Key>,
        others: &[(PrefKey, Key)],
        mut set: impl FnMut(&Key, bool) -> Result<(), String>,
    ) -> Result<Option<Key>, String> {
        if !TAKES {
            return Err(NONE_HERE.into());
        }
        let i = which as usize;
        let wanted = key.unwrap_or_else(|| Key::answer(cfg!(target_os = "macos"), which));
        let all: Vec<_> = others.iter().cloned().chain(self.in_use()).collect();
        allowed(which.pref(), &wanted, &all)?;
        if self.asking {
            follow(&mut self.held[i], wanted.clone(), &mut set)?;
        } else if self.keys[i].as_ref() != Some(&wanted) {
            ask_free(&wanted, &mut set)?;
        }
        Ok(self.keys[i].replace(wanted))
    }

    /// Puts back `before` as the `which` key, after a change the core refused to store.
    fn put_back(&mut self, which: Which, before: Option<Key>, set: impl FnMut(&Key, bool) -> Result<(), String>) {
        let i = which as usize;
        self.keys[i] = before.clone();
        if self.asking {
            back(&mut self.held[i], before, set);
        }
    }

    /// The keys in use, as a page is told them: `{question, yes, no, takes}`, each a shortcut or null, and whether
    /// this copy takes global keys at all.
    fn told(&self) -> Value {
        let [question, yes, no] = &self.keys;
        json!({"question": question, "yes": yes, "no": no, "takes": TAKES})
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
/// system's own: `Answers::try_key`, and only when the system took it the preference is stored (or deleted, for
/// null); the core's refusal, or its silence, puts back the key before. The reply is the keys in use,
/// `{question, yes, no, takes}`.
pub fn answer_call(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let which = match args["which"].as_str() {
        None => return Ok(ANSWERS.lock().unwrap().told()),
        Some("question") => Which::Question,
        Some("yes") => Which::Yes,
        Some("no") => Which::No,
        Some(other) => return Err(format!("there is no answer key {other}")),
    };
    let key: Option<Key> = serde_json::from_value(args["key"].clone()).map_err(|e| e.to_string())?;
    let mut others = others(which.pref());
    others.retain(|(id, _)| Which::of(*id).is_none());
    let before = ANSWERS.lock().unwrap().try_key(which, key.clone(), &others, register(app, "answer-keys"))?;
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

    /// A key for a test: with Control, Shift too, so that it is a key on either system (Control alone with a key is
    /// every app's on Windows).
    fn key(control: bool, alt: bool, code: &str) -> Key {
        Key { control, alt, shift: control, meta: false, code: code.into() }
    }

    /// The system, for a test: the host's seam where it registers a key or lets it go. It holds what was registered,
    /// another app holds `taken`, and every request is kept, in order, as the call that would be made: the key and
    /// whether it is registered or let go. No key of the person's own apps is ever asked for.
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

    const NEVER: fn(&Key, bool) -> Result<(), String> = |_, _| panic!("the system was asked");

    #[test]
    fn a_key_the_system_refuses_leaves_the_old_one_registered_and_says_it_is_taken() {
        let (first, other, taken) = (Key::capture(true), key(true, false, "KeyU"), key(false, true, "Space"));
        let mut system = System::new(vec![taken.clone()]);
        let mut held = None;
        // The first key, as the preference's default is registered at start.
        assert_eq!(follow(&mut held, first.clone(), system.set()), Ok(()));
        assert_eq!((held.clone(), system.registered.clone()), (Some(first.clone()), vec![first.clone()]));
        // The same again asks the system for nothing.
        assert_eq!(follow(&mut held, first.clone(), NEVER), Ok(()));
        // Another app has the next one: said so, and the old one is still the registered one.
        assert_eq!(follow(&mut held, taken.clone(), system.set()), Err(TAKEN.into()));
        assert_eq!((held.clone(), system.registered.clone()), (Some(first.clone()), vec![first.clone()]));
        // One the rule of a shortcut refuses never reaches the system.
        let bare = key(false, false, "Space");
        assert_eq!(follow(&mut held, bare, NEVER), Err(Key::BARE.into()));
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
        let (first, other) = (Key::capture(true), key(true, false, "KeyU"));
        let mut system = System::new(Vec::new());
        let mut held = None;
        follow(&mut held, first.clone(), system.set()).unwrap();
        // Another key was taken by the system, and then the core refused to store it.
        let before = held.clone();
        follow(&mut held, other.clone(), system.set()).unwrap();
        back(&mut held, before.clone(), system.set());
        assert_eq!((held.clone(), system.registered.clone()), (Some(first.clone()), vec![first.clone()]));
        // The same key asked for again, and refused by the core: nothing was changed, nothing is put back.
        back(&mut held, before, NEVER);
        assert_eq!(held, Some(first.clone()));
        // With none registered before, none is afterwards.
        let (mut held, mut system) = (None, System::new(Vec::new()));
        follow(&mut held, other, system.set()).unwrap();
        back(&mut held, None, system.set());
        assert_eq!((held, system.registered.len()), (None, 0));
    }

    #[test]
    fn a_review_build_takes_no_global_key_chosen_or_not() {
        let mine = key(true, false, "KeyU");
        assert_eq!(TAKES, !crate::REVIEW);
        assert_eq!(global(Some(mine.clone()), usual), TAKES.then(|| mine.clone()));
        assert_eq!(global(None, usual), TAKES.then(usual));
        // Every global key a review build is asked to take is refused before the system is asked; the talk key is
        // the page's own and is not one.
        let mut held = None;
        let capture = take_capture(&mut held, Some(mine.clone()), &[], |_, _| Ok(()));
        assert_eq!(capture.is_err(), crate::REVIEW);
        let mut answers = Answers { keys: [None, None, None], held: [None, None, None], asking: false };
        answers.want([Some(mine.clone()), None, None], NEVER);
        assert_eq!(answers.in_use().is_empty(), crate::REVIEW);
        if crate::REVIEW {
            assert_eq!(capture, Err(NONE_HERE.into()));
            assert_eq!(answers.try_key(Which::Yes, None, &[], NEVER), Err(NONE_HERE.into()));
            assert_eq!(answers.ask(true, NEVER), Vec::new());
        }
    }

    /// The answer keys with none stored, as the core's records first say them.
    fn defaults() -> Answers {
        let mut answers = Answers { keys: [None, None, None], held: [None, None, None], asking: false };
        answers.want([None, None, None], NEVER);
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
        let others = [(PrefKey::CaptureKey, Key::capture(mac)), (PrefKey::TalkKey, Key::talk(mac))];
        let (mine, taken) = (key(true, false, "KeyU"), key(true, false, "KeyH"));
        // No question waits: the system is asked for the key and it is let go at once; nothing stays registered.
        let mut answers = defaults();
        let mut system = System::new(vec![taken.clone()]);
        let old = answers.try_key(Which::Yes, Some(mine.clone()), &others, system.set());
        assert_eq!(old, Ok(Some(Key::answer(mac, Which::Yes))));
        assert_eq!(system.asked, vec![(mine.clone(), true), (mine.clone(), false)]);
        assert!(system.registered.is_empty());
        assert_eq!(answers.keys[1], Some(mine.clone()));
        // The same refusals as the capture key's: no modifier, Tasktap's own other keys (each named), and the key
        // another app holds, also with no question waiting; each leaves the key before, and only the last asks the
        // system.
        let refusals = [
            (key(false, false, "KeyN"), Key::BARE),
            (Key::capture(mac), Key::taken(PrefKey::CaptureKey).unwrap()),
            (Key::talk(mac), Key::taken(PrefKey::TalkKey).unwrap()),
            (mine.clone(), Key::taken(PrefKey::YesKey).unwrap()),
        ];
        for (k, why) in refusals {
            assert_eq!(answers.try_key(Which::No, Some(k.clone()), &others, NEVER), Err(why.into()), "{k:?}");
        }
        system.asked.clear();
        assert_eq!(answers.try_key(Which::No, Some(taken.clone()), &others, system.set()), Err(TAKEN.into()));
        assert_eq!((system.asked.clone(), system.registered.len()), (vec![(taken.clone(), true)], 0));
        assert_eq!(answers.keys[2], Some(Key::answer(mac, Which::No)), "a refused key changes nothing");

        // A question waits: the new key is registered and the one before let go, at once.
        let mut system = System::new(Vec::new());
        answers.ask(true, system.set());
        let other = key(true, false, "KeyQ");
        system.asked.clear();
        answers.try_key(Which::Yes, Some(other.clone()), &others, system.set()).unwrap();
        assert_eq!(system.asked, vec![(other.clone(), true), (mine.clone(), false)]);
        assert!(system.registered.contains(&other) && !system.registered.contains(&mine));
        // Another app holds the next one while a question waits: refused, and the key before stays registered.
        let mut busy = System::new(vec![taken.clone()]);
        busy.registered = system.registered.clone();
        assert_eq!(answers.try_key(Which::Yes, Some(taken.clone()), &others, busy.set()), Err(TAKEN.into()));
        assert_eq!((answers.keys[1].clone(), answers.held[1].clone()), (Some(other.clone()), Some(other.clone())));
        // The core refused to store it: the one before is registered again.
        answers.put_back(Which::Yes, Some(mine.clone()), system.set());
        assert!(system.registered.contains(&mine) && !system.registered.contains(&other));
        // Back to this system's own (null), and a preference changed elsewhere follows at once too.
        answers.try_key(Which::Yes, None, &others, system.set()).unwrap();
        assert_eq!(answers.held[1], Some(Key::answer(mac, Which::Yes)));
        let refused = answers.want([Some(other.clone()), None, None], system.set());
        assert_eq!((refused, answers.held[0].clone()), (Vec::new(), Some(other.clone())));
        assert!(system.registered.contains(&other) && !system.registered.contains(&Key::answer(mac, Which::Question)));
        // Answered: nothing of them stays registered.
        answers.ask(false, system.set());
        assert!(system.registered.is_empty());
        assert_eq!(answers.told()["question"], serde_json::to_value(&other).unwrap());
        assert_eq!(answers.told()["takes"], json!(true));
    }

    #[test]
    fn the_capture_key_another_app_holds_is_refused_and_the_one_before_stays() {
        if crate::REVIEW {
            return;
        }
        let mac = cfg!(target_os = "macos");
        let (first, mine, taken) = (Key::capture(mac), key(true, false, "KeyU"), key(true, false, "KeyH"));
        let others = [(PrefKey::NoKey, Key::answer(mac, Which::No)), (PrefKey::TalkKey, Key::talk(mac))];
        let mut system = System::new(vec![taken.clone()]);
        let mut held = None;
        assert_eq!(take_capture(&mut held, None, &others, system.set()), Ok(None));
        assert_eq!(system.registered, vec![first.clone()]);
        // Tasktap's other keys are refused before the system is asked, each named.
        for (k, id) in [(Key::answer(mac, Which::No), PrefKey::NoKey), (Key::talk(mac), PrefKey::TalkKey)] {
            assert_eq!(take_capture(&mut held, Some(k), &others, NEVER), Err(Key::taken(id).unwrap().into()));
        }
        // Another app's: the registration fails, which is the refusal, and the key before is still the one held.
        assert_eq!(take_capture(&mut held, Some(taken.clone()), &others, system.set()), Err(TAKEN.into()));
        assert_eq!((held.clone(), system.registered.clone()), (Some(first.clone()), vec![first.clone()]));
        // A free one: registered first, then the one before let go.
        system.asked.clear();
        assert_eq!(take_capture(&mut held, Some(mine.clone()), &others, system.set()), Ok(Some(first.clone())));
        assert_eq!(system.asked, vec![(mine.clone(), true), (first, false)]);
        assert_eq!(held, Some(mine));
    }

    #[test]
    fn the_talk_key_another_app_holds_is_refused_and_none_stays_registered() {
        let mac = cfg!(target_os = "macos");
        let (mine, taken) = (key(true, false, "KeyU"), key(true, false, "KeyH"));
        let others = [(PrefKey::CaptureKey, Key::capture(mac)), (PrefKey::YesKey, Key::answer(mac, Which::Yes))];
        let mut now = Some(Key::talk(mac));
        // Another app holds it globally, so it would never reach Tasktap: refused, the talk key before stays.
        let mut system = System::new(vec![taken.clone()]);
        assert_eq!(take_talk(&mut now, Some(taken.clone()), &others, system.set()), Err(TAKEN.into()));
        assert_eq!(now, Some(Key::talk(mac)));
        // Tasktap's other keys, and the rule, are refused before the system is asked.
        let yes = Key::answer(mac, Which::Yes);
        assert_eq!(take_talk(&mut now, Some(yes), &others, NEVER), Err(Key::taken(PrefKey::YesKey).unwrap().into()));
        assert_eq!(take_talk(&mut now, Some(key(false, false, "KeyH")), &others, NEVER), Err(Key::BARE.into()));
        // A free one: asked for and let go at once; it is the page's own, so nothing stays registered.
        system.asked.clear();
        assert_eq!(take_talk(&mut now, Some(mine.clone()), &others, system.set()), Ok(Some(Key::talk(mac))));
        assert_eq!(
            (system.asked.clone(), system.registered.len()),
            (vec![(mine.clone(), true), (mine.clone(), false)], 0)
        );
        // The same again, and the pages' own when nothing else holds it.
        assert_eq!(take_talk(&mut now, Some(mine.clone()), &others, NEVER), Ok(Some(mine.clone())));
        assert_eq!(take_talk(&mut now, None, &others, system.set()), Ok(Some(mine)));
        assert_eq!(now, Some(Key::talk(mac)));
    }

    #[test]
    fn a_key_of_tasktaps_own_window_or_of_every_app_is_refused_before_the_system_is_asked() {
        if crate::REVIEW {
            return;
        }
        let mac = cfg!(target_os = "macos");
        let own = |k: &str| tasktap_proto::keys::shortcut(k, mac).unwrap();
        let says = |k: &str, name: &str| format!("Tasktap uses {} for {name}", tasktap_proto::keys::spell(k, mac));
        // ⌘N (Control-Shift-N on Windows) and ⌘J, for each key a person records.
        let mut held = None;
        assert_eq!(take_capture(&mut held, Some(own("⌘N")), &[], NEVER), Err(says("⌘N", "New task")));
        let mut answers = defaults();
        assert_eq!(answers.try_key(Which::Yes, Some(own("⌘J")), &[], NEVER), Err(says("⌘J", "the list of agents")));
        let mut talk = None;
        assert_eq!(take_talk(&mut talk, Some(own("⌘,")), &[], NEVER), Err(says("⌘,", "Settings")));
        // The system's command modifier alone takes a key from every app: refused for a global key, not to talk.
        let alone = Key { control: !mac, alt: false, shift: false, meta: mac, code: "KeyB".into() };
        let refused = answers.try_key(Which::No, Some(alone.clone()), &[], NEVER).unwrap_err();
        assert!(refused.starts_with("Other apps use"), "{refused}");
        let mut system = System::new(Vec::new());
        assert_eq!(take_talk(&mut talk, Some(alone.clone()), &[], system.set()), Ok(None));
        assert_eq!(talk, Some(alone));
        // A text field's own key is refused to talk: Select all.
        let all = Key { control: !mac, alt: false, shift: false, meta: mac, code: "KeyA".into() };
        let field = take_talk(&mut talk, Some(all), &[], NEVER).unwrap_err();
        assert!(field.starts_with("A text field uses") && field.ends_with("for Select all"), "{field}");
        assert_eq!((held, answers.keys[2].clone()), (None, Some(Key::answer(mac, Which::No))));
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
