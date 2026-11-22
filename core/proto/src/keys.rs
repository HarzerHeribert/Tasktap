//! The keys Tasktap uses in its own window, in one table that the core, the host and the pages read (the pages
//! through `protocol.ts`, generated from it): each command's key as the Mac has it, and the key Windows has for it by
//! one rule (`local`, the rule `ui/src/keys.ts` applies). From it, what a key a person records may not be
//! (`own_key`): a command of Tasktap's own window, since the key would take it from there; for the key held to talk,
//! a text field's own key too, since it is held in one; and for a key taken from other apps, the system's command
//! modifier alone with one key, which belongs to every app.
use crate::records::{PrefKey, Shortcut};

/// A command Tasktap has a key for in its own window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AppKey {
    /// The command, as the pages and the menus name it (`new-task`).
    pub id: &'static str,
    /// Its key, as the Mac has it (`⌘N`): the modifiers ⌃⌥⇧⌘, then the key.
    pub key: &'static str,
    /// What it does, as a sentence says it after "for" (`New task`).
    pub name: &'static str,
    /// It is in the menu (the Mac's, and the page's own on Windows): the pages act on it by its id.
    pub menu: bool,
}

const fn app(id: &'static str, key: &'static str, name: &'static str, menu: bool) -> AppKey {
    AppKey {
        id,
        key,
        name,
        menu,
    }
}

/// Every key Tasktap's own window acts on with Command (Control on Windows): the menu's commands, Settings' sections,
/// the field for a thought's lists, and the keys a terminal and a sheet take.
pub const APP_KEYS: &[AppKey] = &[
    app("new-task", "⌘N", "New task", true),
    app("new-terminal", "⌘T", "New terminal", true),
    app("open-workspace", "⌘O", "Open workspace", true),
    app("pop-out", "⇧⌘N", "Open workspace in new window", true),
    app("close-tab", "⌘W", "Close tab", true),
    app("find", "⌘F", "Find in terminal", true),
    app("sidebar", "⌃⌘S", "Toggle sidebar", true),
    app("split-right", "⌘D", "Split right", true),
    app("split-down", "⇧⌘D", "Split down", true),
    app("preview", "⌘P", "Switch terminal and preview", true),
    app("reload-preview", "⌘R", "Reload preview", true),
    app("bigger", "⌘=", "Increase text size", true),
    app("smaller", "⌘-", "Decrease text size", true),
    app("reset", "⌘0", "Reset text size", true),
    app("settings", "⌘,", "Settings", true),
    app("back", "⌘[", "Back", true),
    app("session", "⌘I", "Details", true),
    app("section-thoughts", "⌘1", "Tasks in Settings", false),
    app("section-agents", "⌘2", "Agents in Settings", false),
    app("section-projects", "⌘3", "Projects in Settings", false),
    app("section-voice", "⌘4", "Voice in Settings", false),
    app("section-appearance", "⌘5", "Appearance in Settings", false),
    app("section-terminal", "⌘6", "Terminal in Settings", false),
    app("section-about", "⌘7", "About in Settings", false),
    app("agents", "⌘J", "the list of agents", false),
    app("places", "⌘K", "the list of places", false),
    app("weights", "⌘L", "the list of weights", false),
    app("undo", "⌘Z", "Undo", false),
    app("copy", "⌘C", "Copy", false),
    app("paste", "⌘V", "Paste", false),
    app("stop", "⌘⌫", "Stop where a sheet asks", false),
    app("end", "⌘↓", "the end of a terminal", false),
];

/// A key a text field keeps for itself, on each system.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FieldKey {
    pub mac: &'static str,
    pub windows: &'static str,
    pub name: &'static str,
}

const fn field(mac: &'static str, windows: &'static str, name: &'static str) -> FieldKey {
    FieldKey { mac, windows, name }
}

/// The keys a text field keeps, which the key held to talk (held in a field) may not be. Written in a Mac's signs on
/// both systems; on Windows these are Control's own, not Command's turned into it.
pub const FIELD_KEYS: &[FieldKey] = &[
    field("⌘A", "⌃A", "Select all"),
    field("⌘X", "⌃X", "Cut"),
    field("⌘C", "⌃C", "Copy"),
    field("⌘V", "⌃V", "Paste"),
    field("⌘Z", "⌃Z", "Undo"),
    field("⇧⌘Z", "⌃Y", "Redo"),
    field("⌘←", "⌃←", "the start of a line"),
    field("⌘→", "⌃→", "the end of a line"),
    field("⌥←", "⌃⇧←", "the word before"),
    field("⌥→", "⌃⇧→", "the word after"),
    field("⌥⌫", "⌃⌫", "deleting a word"),
    field("⌘↑", "⌃↖", "the start of the text"),
    field("⌘↓", "⌃↘", "the end of the text"),
];

/// The few keys Windows has its own way (ui/src/keys.ts, rule 4): the Mac's key, and Windows' in a Mac's signs.
pub const WINDOWS_KEYS: &[(&str, &str)] = &[
    // ⌘D is Ctrl+Shift+D already: the split below it takes the key beside it.
    ("⇧⌘D", "⌃⇧E"),
    // ⌘N is Ctrl+Shift+N already: opening a workspace in a window takes the key beside it.
    ("⇧⌘N", "⌃⇧M"),
    // Back, as Windows has it; Ctrl+[ is Escape to a terminal.
    ("⌘[", "⌥←"),
    // To the end, as Windows has it.
    ("⌘↓", "⌃End"),
    // Undo is Ctrl+Z wherever text is typed.
    ("⌘Z", "⌃Z"),
];

/// The Mac's signs for the modifiers, in the order a Mac writes them.
const SIGNS: [char; 4] = ['⌃', '⌥', '⇧', '⌘'];

/// Modifiers and a key in a Mac's signs: control, alt, shift, meta and the key.
fn parse(k: &str) -> (bool, bool, bool, bool, String) {
    let held = |c| k.contains(c);
    let key: String = k.chars().filter(|c| !SIGNS.contains(c)).collect();
    (held('⌃'), held('⌥'), held('⇧'), held('⌘'), key)
}

/// The place of a key written as the code writes it, as a keyboard event names it (by a US keyboard's places).
fn code(key: &str) -> Option<String> {
    let named = match key {
        "," => "Comma",
        "." => "Period",
        "=" => "Equal",
        "-" => "Minus",
        "[" => "BracketLeft",
        "]" => "BracketRight",
        "/" => "Slash",
        ";" => "Semicolon",
        "↑" => "ArrowUp",
        "↓" => "ArrowDown",
        "←" => "ArrowLeft",
        "→" => "ArrowRight",
        "⌫" => "Backspace",
        "⌦" => "Delete",
        "↖" | "Home" => "Home",
        "↘" | "End" => "End",
        "↩" => "Enter",
        "Space" => "Space",
        _ => {
            let mut chars = key.chars();
            return match (chars.next(), chars.next()) {
                (Some(c), None) if c.is_ascii_alphabetic() => {
                    Some(format!("Key{}", c.to_ascii_uppercase()))
                }
                (Some(c), None) if c.is_ascii_digit() => Some(format!("Digit{c}")),
                _ => None,
            };
        }
    };
    Some(named.into())
}

/// The key this system has for one written as the Mac has it (ui/src/keys.ts `local`): on a Mac the same; on
/// Windows Control where the Mac has Command, with Shift too before a letter, but for `WINDOWS_KEYS`.
fn local(k: &str, mac: bool) -> (bool, bool, bool, bool, String) {
    let (control, alt, shift, meta, key) = parse(k);
    if mac || !meta {
        return (control, alt, shift, meta, key);
    }
    if let Some((_, windows)) = WINDOWS_KEYS.iter().find(|(m, _)| *m == ordered(k)) {
        return parse(windows);
    }
    let letter = key.chars().count() == 1 && key.chars().all(|c| c.is_ascii_alphabetic());
    (true, alt, shift || letter, false, key)
}

/// A key in a Mac's order: the modifiers ⌃⌥⇧⌘, then the key.
fn ordered(k: &str) -> String {
    let (control, alt, shift, meta, key) = parse(k);
    let signs = [(control, '⌃'), (alt, '⌥'), (shift, '⇧'), (meta, '⌘')];
    signs
        .iter()
        .filter(|(on, _)| *on)
        .map(|(_, s)| *s)
        .chain(key.chars())
        .collect()
}

/// The shortcut, by its place, of a key as a Mac's signs write it, on this system as `local` turns it.
pub fn shortcut(k: &str, mac: bool) -> Option<Shortcut> {
    let (control, alt, shift, meta, key) = local(k, mac);
    Some(Shortcut {
        control,
        alt,
        shift,
        meta,
        code: code(&key)?,
    })
}

/// A key as this system writes it (ui/src/keys.ts `spell`): "⇧⌘D" on a Mac, "Ctrl+Shift+E" on Windows.
pub fn spell(k: &str, mac: bool) -> String {
    let (control, alt, shift, meta, key) = local(k, mac);
    let key = match key.as_str() {
        "⌫" if !mac => "Backspace".to_owned(),
        "⌦" if !mac => "Del".to_owned(),
        "↖" if !mac => "Home".to_owned(),
        "↘" if !mac => "End".to_owned(),
        k if k.chars().count() == 1 => k.to_uppercase(),
        k => k.to_owned(),
    };
    if mac {
        let signs = [(control, '⌃'), (alt, '⌥'), (shift, '⇧'), (meta, '⌘')];
        return signs
            .iter()
            .filter(|(on, _)| *on)
            .map(|(_, s)| s.to_string())
            .chain([key])
            .collect();
    }
    let words = [
        (meta, "Win"),
        (control, "Ctrl"),
        (alt, "Alt"),
        (shift, "Shift"),
    ];
    let held = words
        .iter()
        .filter(|(on, _)| *on)
        .map(|(_, w)| (*w).to_owned());
    held.chain([key]).collect::<Vec<_>>().join("+")
}

/// Whether a key preference is taken from other apps (registered with the system): every key a person records but the
/// one held to talk, which only Tasktap's window hears.
fn global(id: PrefKey) -> bool {
    id != PrefKey::TalkKey
}

/// Why `key` cannot be the key preference `id` on this system (`mac`) beside Tasktap's own window: the key of one of
/// its commands ("Tasktap uses ⌘N for New task"), and for the key held to talk, which is held in a text field, one of a
/// field's own keys ("A text field uses ⌘A for Select all"). None when it may be. That it is none of Tasktap's other
/// recorded keys is `clash`, asked next; that it is no key every app has is `every_app`, asked last.
pub fn own_key(id: PrefKey, key: &Shortcut, mac: bool) -> Option<String> {
    let is = |k: &str| shortcut(k, mac).as_ref() == Some(key);
    if let Some(c) = APP_KEYS.iter().find(|c| is(c.key)) {
        return Some(format!("Tasktap uses {} for {}", spell(c.key, mac), c.name));
    }
    if global(id) {
        return None;
    }
    let mine = |f: &FieldKey| if mac { f.mac } else { f.windows };
    // A field's own keys are written in Control's own on Windows: placed as they stand.
    let field = FIELD_KEYS
        .iter()
        .find(|f| shortcut(mine(f), true).as_ref() == Some(key));
    field.map(|f| format!("A text field uses {} for {}", spell(mine(f), mac), f.name))
}

/// Why `key` cannot be the key preference `id` on this system (`mac`) when it is taken from other apps: the system's
/// command modifier alone with one key (⌘ on a Mac, Ctrl on Windows) belongs to every app. The key held to talk, which
/// only Tasktap's window hears, may be one. None when it may be.
pub fn every_app(id: PrefKey, key: &Shortcut, mac: bool) -> Option<&'static str> {
    let alone = [key.control, key.alt, key.shift, key.meta]
        .iter()
        .filter(|on| **on)
        .count()
        == 1;
    match (global(id), mac) {
        (true, true) if alone && key.meta => {
            Some("Other apps use ⌘ with a single key: hold Control or Option as well")
        }
        (true, false) if alone && key.control => {
            Some("Other apps use Ctrl with a single key: hold Alt or Shift as well")
        }
        _ => None,
    }
}
