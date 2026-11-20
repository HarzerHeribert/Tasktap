//! Where Tasktap shows itself (plan, "Notch", "Where Tasktap shows itself"): in one place at a time, where the
//! person is. The rule is a pure function of the situation (`Situation`), tested below on both systems; the rest of
//! this file keeps the situation as the system and the pages tell it, and sends the verdict to both pages at once,
//! so that the notch's page and the window's never disagree about where Tasktap is.
//!
//! "The window in front" is decided here and nowhere else: Tasktap is the active app and its workspace window is
//! the one with the keyboard, as the system tells it (on the Mac the app's activate and resign notices and the
//! window's key notices, on Windows the window in front as the foreground hook tells it). Nothing is polled.
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// The systems the rule is the same on. On Windows the tab can be switched off; then there is no notch at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum System {
    #[cfg_attr(windows, allow(dead_code))]
    Mac,
    Windows {
        tab: bool,
    },
}

impl System {
    fn notch(self) -> bool {
        self != System::Windows { tab: false }
    }

    /// This system, with the tab's setting as it is now. A review build (`crate::REVIEW`) has no notch and no tab
    /// (the person's own Tasktap's is in their place): the rule is then the one for a system without either.
    pub fn this() -> System {
        if crate::REVIEW {
            return System::Windows { tab: false };
        }
        #[cfg(windows)]
        return System::Windows { tab: crate::workspace::tab() != "off" };
        #[cfg(not(windows))]
        System::Mac
    }
}

/// What the workspace window shows, as its page says it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Shows {
    /// There is no window.
    #[default]
    Closed,
    /// Home, with no sheet over it: its Composer and Needs you.
    Home,
    /// The New Task sheet, over whatever is under it.
    NewTask,
    /// A workspace's panes: the sessions whose terminals are shown, each with its strip.
    Terminals(Vec<String>),
    /// Anything else: Settings, another sheet, Earlier.
    Elsewhere,
}

/// The question the answer keys act on (`glance`), as far as the rule needs it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Asks {
    pub id: String,
    /// The session whose terminal it is asked in; none for the router's question.
    pub session: Option<String>,
    /// Only its terminal can answer it: a trust or sign-in prompt, or a question the agent asked there.
    pub terminal: bool,
    /// A yes-or-no question, which Yes answers.
    pub confirm: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Situation {
    /// Tasktap's window is in front.
    pub front: bool,
    pub shows: Shows,
    pub question: Option<Asks>,
    /// A full-screen app or a presentation is in front, or nobody is at the desktop.
    pub full: bool,
    /// The notch is open because the person opened it (in full screen too, where nothing else opens it).
    pub open: bool,
    pub system: System,
}

/// Where a waiting question is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Place {
    /// In Needs you on Home.
    NeedsYou,
    /// In the strip under its terminal.
    Strip,
    /// A quiet line at the window's top that leads to it.
    Line,
    /// In the notch: it opens by itself without the keyboard, or its glance glows.
    Notch,
    /// A system notification: nothing of Tasktap's can be seen.
    Notification,
    /// Only the icon in the notification area changes (Windows, with the tab switched off).
    Icon,
}

impl Place {
    pub fn word(self) -> &'static str {
        match self {
            Place::NeedsYou => "needs-you",
            Place::Strip => "strip",
            Place::Line => "line",
            Place::Notch => "notch",
            Place::Notification => "notification",
            Place::Icon => "icon",
        }
    }
}

/// The keys that work from any app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Capture,
    /// ⌃⌥J: the waiting question.
    Answer,
    /// ⌃⌥Y.
    Yes,
    /// ⌃⌥N.
    No,
}

/// What a key does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Goes {
    /// The caret in the field of Home, or of New Task where that is open; the window in front.
    Field,
    /// New Task opens over what the window shows.
    NewTask,
    /// The notch opens with the keyboard in its field.
    NotchField,
    /// The notch opens with the keyboard on the question.
    NotchQuestion,
    /// The window comes forward at the question: its terminal, or Home for the router's.
    Question(String),
    /// The core answers as the person said: `answer.affirm` or `answer.deny`.
    Core(&'static str),
    Nothing,
}

impl Situation {
    /// Whether the notch is where Tasktap is: its glance shows, and a question opens it by itself. Not while the
    /// window is in front (rule 1), nor in full screen unless the person opened it (rule 6).
    pub fn notch(&self) -> bool {
        self.system.notch() && !self.front && (!self.full || self.open)
    }

    /// Whether a question that opens now is a system notification: a full-screen app or a presentation is in
    /// front and nothing of Tasktap's can be seen (rule 6). The only notification Tasktap sends.
    pub fn notifies(&self) -> bool {
        !self.front && self.full && !self.notch()
    }

    /// Where the waiting question is (rules 1, 2, 3 and 6). None while nothing waits.
    pub fn question(&self) -> Option<Place> {
        let q = self.question.as_ref()?;
        Some(match &self.shows {
            _ if self.notch() => Place::Notch,
            _ if self.notifies() => Place::Notification,
            _ if !self.front => Place::Icon,
            Shows::Home => Place::NeedsYou,
            Shows::Terminals(shown) if q.session.as_ref().is_some_and(|s| shown.contains(s)) => Place::Strip,
            _ => Place::Line,
        })
    }

    /// What a key from any app does (rules 1, 2 and 5).
    pub fn key(&self, key: Key) -> Goes {
        let ask = || match &self.question {
            None => Goes::Nothing,
            // A question only its terminal answers: the window at that terminal, wherever the person is.
            Some(q) if q.terminal => Goes::Question(q.id.clone()),
            Some(q) if self.front => Goes::Question(q.id.clone()),
            Some(_) if self.system.notch() => Goes::NotchQuestion,
            Some(q) => Goes::Question(q.id.clone()),
        };
        match key {
            Key::Capture if self.front => match self.shows {
                Shows::Home | Shows::NewTask => Goes::Field,
                _ => Goes::NewTask,
            },
            Key::Capture if self.system.notch() => Goes::NotchField,
            // No tab (Windows): the window comes forward, with Home's field where it shows Home.
            Key::Capture => match self.shows {
                Shows::Closed | Shows::Home | Shows::NewTask => Goes::Field,
                _ => Goes::NewTask,
            },
            Key::Answer => ask(),
            Key::Yes => match &self.question {
                Some(q) if !q.terminal && q.confirm => Goes::Core("answer.affirm"),
                // Yes does not answer a question with choices or words: the keys bring the person to it instead.
                _ => ask(),
            },
            Key::No => match &self.question {
                Some(q) if !q.terminal => Goes::Core("answer.deny"),
                _ => ask(),
            },
        }
    }
}

// How long a notch that opened by itself stays open untouched (rule 4) is the notch page's (`UNTOUCHED` in
// ui/src/notch/main.tsx): the host never folds it on a timer.

// ---------------------------------------------------------------------------------------------
// The situation as the system and the pages tell it.

struct State {
    /// The app is the active one, as the system said last (the Mac's activate and resign notices).
    active: bool,
    /// The workspace window has the keyboard, as it said last.
    key: bool,
    /// Some of the workspace window is on screen, as the Mac says it (native.rs `watch_seen`); Windows asks it with the
    /// window in front (edge.rs).
    seen: bool,
    /// A check's run says where the window is instead of the system, which never puts a passive run in front.
    told: Option<bool>,
    /// While the window's own dialog is open (the folder chooser) the window stays as it was.
    paused: bool,
    front: bool,
    full: bool,
    told_full: Option<bool>,
    open: bool,
    shows: Shows,
    question: Option<Asks>,
    /// What the pages were told last.
    sent: Value,
}

static STATE: Mutex<State> = Mutex::new(State {
    active: false,
    key: false,
    seen: true,
    told: None,
    paused: false,
    front: false,
    full: false,
    told_full: None,
    open: false,
    shows: Shows::Closed,
    question: None,
    sent: Value::Null,
});

fn with<T>(f: impl FnOnce(&mut State) -> T) -> T {
    f(&mut STATE.lock().unwrap())
}

pub fn situation() -> Situation {
    with(|st| Situation {
        front: st.front,
        shows: st.shows.clone(),
        question: st.question.clone(),
        full: st.told_full.unwrap_or(st.full),
        open: st.open,
        system: System::this(),
    })
}

/// Whether the window is in front now.
pub fn front() -> bool {
    with(|st| st.front)
}

/// What both pages are told: where Tasktap is, and where the waiting question is.
fn verdict(s: &Situation) -> Value {
    json!({"do": "where", "front": s.front, "full": s.full, "notch": s.notch(),
        "place": s.question().map(Place::word), "question": s.question.as_ref().map(|q| q.id.clone())})
}

/// Something changed: the pages are told when what they would be told changed, and the notch's window is shown or
/// hidden. The window coming in front folds an open notch (its page folds when told); going behind, the glance is
/// back, glowing while a question waits (rule 3).
fn changed(app: &AppHandle) {
    let s = situation();
    let now = verdict(&s);
    let before = with(|st| std::mem::replace(&mut st.sent, now.clone()));
    if before == now {
        return;
    }
    crate::log(json!({"event": "where", "front": s.front, "full": s.full, "notch": s.notch(),
        "place": now["place"], "shows": format!("{:?}", s.shows)}));
    let _ = app.emit("ui", now);
    if before.get("front") != Some(&json!(s.front)) || before.get("notch") != Some(&json!(s.notch())) {
        crate::notch::refresh(app);
    }
}

/// The system's account of the window changed: the app became active or stopped being it (`active`), or the
/// workspace window took the keyboard or lost it (`key`). Windows tells both at once, from the window in front.
pub fn told(app: &AppHandle, active: Option<bool>, key: Option<bool>) {
    let moved = with(|st| {
        st.active = active.unwrap_or(st.active);
        st.key = key.unwrap_or(st.key);
        let front = st.told.unwrap_or(st.active && st.key && st.seen);
        let moved = !st.paused && front != st.front;
        if moved {
            st.front = front;
        }
        moved
    });
    if moved {
        changed(app);
    }
}

/// Whether any of the workspace window can be seen (the Mac): a window on another Space, minimised or hidden is not in
/// front, whatever has the keyboard.
pub fn seen(app: &AppHandle, seen: bool) {
    if with(|st| std::mem::replace(&mut st.seen, seen)) != seen {
        told(app, None, None);
    }
}

/// The workspace window is gone: nothing of it is in front, and it shows nothing.
pub fn closed(app: &AppHandle) {
    with(|st| {
        st.key = false;
        st.shows = Shows::Closed;
        if st.told.is_none() {
            st.front = false;
        }
    });
    changed(app);
}

/// A check says where the window is (`where front|behind`), or gives it back to the system (`where system`).
pub fn tell(app: &AppHandle, front: Option<bool>) {
    with(|st| {
        st.told = front;
        st.front = front.unwrap_or(st.active && st.key && st.seen);
    });
    changed(app);
}

/// A check says whether a full-screen app is in front, or gives it back to the system.
pub fn tell_full(app: &AppHandle, full: Option<bool>) {
    with(|st| st.told_full = full);
    changed(app);
}

/// The window's own dialog opens or has closed: while it is open the window counts as it did before.
pub fn pause(on: bool) {
    with(|st| st.paused = on);
}

/// Whether a full-screen app, a presentation or nobody is in front, as the system says.
pub fn full(app: &AppHandle, full: bool) {
    if with(|st| std::mem::replace(&mut st.full, full)) != full {
        changed(app);
    }
}

/// The person opened the notch, or it folded.
pub fn opened(app: &AppHandle, open: bool) {
    if with(|st| std::mem::replace(&mut st.open, open)) != open {
        changed(app);
    }
}

/// What the workspace window shows, from its page.
pub fn shows(app: &AppHandle, shows: Shows) {
    if with(|st| std::mem::replace(&mut st.shows, shows.clone())) != shows {
        changed(app);
    }
}

/// The waiting question changed (`glance`, or the question's own row).
pub fn question(app: &AppHandle, question: Option<Asks>) {
    if with(|st| std::mem::replace(&mut st.question, question.clone())) != question {
        changed(app);
    }
}

/// `host.where {shows?, terminals?}` from a page: with `shows`, what the workspace window shows now ("home",
/// "new-task", "terminals" with the sessions shown, or "elsewhere"). The reply is what the pages are told.
pub fn call(app: &AppHandle, args: &Value) -> Value {
    if let Some(word) = args.get("shows").and_then(Value::as_str) {
        let terminals = || {
            let all = args.get("terminals").and_then(Value::as_array);
            all.into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
        };
        shows(
            app,
            match word {
                "home" => Shows::Home,
                "new-task" => Shows::NewTask,
                "terminals" => Shows::Terminals(terminals()),
                _ => Shows::Elsewhere,
            },
        );
    }
    verdict(&situation())
}

/// What a check may know.
pub fn state() -> Value {
    let s = situation();
    let (active, key, seen, told) = with(|st| (st.active, st.key, st.seen, st.told));
    json!({"front": s.front, "active": active, "key": key, "seen": seen, "told": told, "full": s.full, "open": s.open,
        "notch": s.notch(), "shows": format!("{:?}", s.shows), "place": s.question().map(Place::word),
        "question": s.question.as_ref().map(|q| q.id.clone())})
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAC: System = System::Mac;
    const WINDOWS: System = System::Windows { tab: true };
    const NO_TAB: System = System::Windows { tab: false };

    fn asks(session: Option<&str>, terminal: bool, confirm: bool) -> Option<Asks> {
        Some(Asks { id: "q".into(), session: session.map(str::to_owned), terminal, confirm })
    }
    fn at(front: bool, shows: Shows, question: Option<Asks>, full: bool, system: System) -> Situation {
        Situation { front, shows, question, full, open: false, system }
    }
    fn terminals(sessions: &[&str]) -> Shows {
        Shows::Terminals(sessions.iter().map(|s| s.to_string()).collect())
    }
    /// The same situation on both systems gives the same answer (rule 6).
    fn both(f: impl Fn(System) -> Situation, check: impl Fn(&Situation)) {
        for system in [MAC, WINDOWS] {
            check(&f(system));
        }
    }

    #[test]
    fn with_the_window_in_front_there_is_no_notch_and_a_question_is_where_the_person_is() {
        both(
            |system| at(true, Shows::Home, asks(Some("s"), false, true), false, system),
            |s| {
                assert!(!s.notch());
                assert_eq!(s.question(), Some(Place::NeedsYou));
            },
        );
        // Under its terminal, the strip; anywhere else in the window, the quiet line, also over a full-screen app.
        let s = at(true, terminals(&["s", "t"]), asks(Some("s"), false, true), false, MAC);
        assert_eq!(s.question(), Some(Place::Strip));
        let s = at(true, terminals(&["t"]), asks(Some("s"), false, true), false, WINDOWS);
        assert_eq!(s.question(), Some(Place::Line));
        for shows in [Shows::Elsewhere, Shows::NewTask] {
            let s = at(true, shows, asks(Some("s"), true, false), true, MAC);
            assert_eq!(s.question(), Some(Place::Line));
        }
        // The router's question has no terminal: Home shows it, the line leads to it from anywhere else.
        assert_eq!(at(true, Shows::Home, asks(None, false, false), false, MAC).question(), Some(Place::NeedsYou));
        assert_eq!(at(true, terminals(&["s"]), asks(None, false, false), false, MAC).question(), Some(Place::Line));
    }

    #[test]
    fn with_the_window_in_front_the_capture_key_puts_the_caret_in_home_or_opens_new_task_over_what_shows() {
        for system in [MAC, WINDOWS, NO_TAB] {
            for (shows, goes) in [
                (Shows::Home, Goes::Field),
                (Shows::NewTask, Goes::Field),
                (terminals(&["s"]), Goes::NewTask),
                (Shows::Elsewhere, Goes::NewTask),
            ] {
                assert_eq!(at(true, shows, None, false, system).key(Key::Capture), goes);
            }
        }
    }

    #[test]
    fn with_another_app_in_front_or_the_window_closed_the_notch_is_the_interface() {
        for shows in [Shows::Closed, Shows::Home, terminals(&["s"]), Shows::Elsewhere] {
            both(
                |system| at(false, shows.clone(), asks(Some("s"), false, true), false, system),
                |s| {
                    assert!(s.notch());
                    assert_eq!(s.key(Key::Capture), Goes::NotchField);
                    assert_eq!(s.key(Key::Answer), Goes::NotchQuestion);
                    // The question opens it by itself, and is in no other place (rule 3).
                    assert_eq!(s.question(), Some(Place::Notch));
                    assert_eq!(s.key(Key::Yes), Goes::Core("answer.affirm"));
                    assert_eq!(s.key(Key::No), Goes::Core("answer.deny"));
                },
            );
        }
        // With nothing waiting nothing opens and the answer keys do nothing (they are not even registered then).
        let s = at(false, Shows::Home, None, false, MAC);
        assert_eq!((s.question(), s.key(Key::Answer), s.key(Key::Yes)), (None, Goes::Nothing, Goes::Nothing));
    }

    #[test]
    fn a_waiting_question_moves_between_the_window_and_the_notch_with_the_window() {
        let mut s = at(false, terminals(&["s"]), asks(Some("s"), false, true), false, MAC);
        assert_eq!(s.question(), Some(Place::Notch));
        s.front = true;
        assert_eq!((s.notch(), s.question()), (false, Some(Place::Strip)));
        s.front = false;
        assert_eq!((s.notch(), s.question()), (true, Some(Place::Notch)));
    }

    #[test]
    fn the_answer_keys_always_do_something_and_a_terminal_question_brings_the_window_to_its_terminal() {
        for front in [false, true] {
            for shows in [Shows::Closed, Shows::Home, Shows::Elsewhere] {
                both(
                    |system| at(front, shows.clone(), asks(Some("s"), true, false), false, system),
                    |s| {
                        for key in [Key::Answer, Key::Yes, Key::No] {
                            assert_eq!(s.key(key), Goes::Question("q".into()), "{key:?} {s:?}");
                        }
                    },
                );
            }
        }
        // Yes on a question with choices brings the person to it: the notch from another app, the window in front.
        let choice = asks(Some("s"), false, false);
        assert_eq!(at(false, Shows::Home, choice.clone(), false, MAC).key(Key::Yes), Goes::NotchQuestion);
        assert_eq!(at(true, Shows::Home, choice.clone(), false, WINDOWS).key(Key::Yes), Goes::Question("q".into()));
        assert_eq!(at(true, Shows::Home, choice.clone(), false, WINDOWS).key(Key::No), Goes::Core("answer.deny"));
        // ⌃⌥J with the window in front goes to the question in the window, never to a notch.
        assert_eq!(at(true, Shows::Elsewhere, choice, false, MAC).key(Key::Answer), Goes::Question("q".into()));
    }

    #[test]
    fn in_full_screen_there_is_no_notch_and_a_question_is_a_system_notification_on_both_systems() {
        both(
            |system| at(false, Shows::Home, asks(Some("s"), false, true), true, system),
            |s| {
                assert!(!s.notch());
                assert_eq!(s.question(), Some(Place::Notification));
                // The person asked: the capture key and ⌃⌥J still open the notch.
                assert_eq!(s.key(Key::Capture), Goes::NotchField);
                assert_eq!(s.key(Key::Answer), Goes::NotchQuestion);
            },
        );
        // A notch the person opened over a full-screen app is where the question is.
        let mut s = at(false, Shows::Closed, asks(None, false, false), true, WINDOWS);
        s.open = true;
        assert_eq!((s.notch(), s.question()), (true, Some(Place::Notch)));
        // Tasktap's own window in full screen is the window in front.
        let s = at(true, Shows::Home, asks(None, false, false), true, MAC);
        assert_eq!(s.question(), Some(Place::NeedsYou));
    }

    #[test]
    fn on_windows_without_the_tab_the_window_comes_forward_and_the_icon_says_a_question_waits() {
        let s = at(false, Shows::Closed, asks(Some("s"), false, true), false, NO_TAB);
        assert!(!s.notch());
        assert_eq!(s.question(), Some(Place::Icon));
        assert_eq!(s.key(Key::Capture), Goes::Field);
        assert_eq!(s.key(Key::Answer), Goes::Question("q".into()));
        assert_eq!(at(false, Shows::Elsewhere, None, false, NO_TAB).key(Key::Capture), Goes::NewTask);
        assert_eq!(
            at(false, Shows::Home, asks(None, false, false), true, NO_TAB).question(),
            Some(Place::Notification)
        );
    }
}
