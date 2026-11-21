// A window's program on Windows: started from the Start menu it opens no console.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
//! Tasktap: the host, on the Mac and on Windows. It starts the core, gives each page one pass-through to it
//! (design §12), answers the page's `host.*` calls, places the notch panel (on Windows the tab at the top edge,
//! with its icon in the notification area) and binds the global shortcuts. Everything else is the core's or the
//! page's.
#[cfg(windows)]
mod chrome;
mod core;
// The tab's window on Windows: what native.rs is to the Mac's notch panel.
#[cfg(windows)]
mod edge;
// Windows shows no frame yet: what holds one to this machine there is not built, so its server is not called.
#[cfg_attr(windows, allow(dead_code))]
mod frames;
mod geometry;
mod keys;
// Opening Tasktap when the computer starts: the system's own login item, or Run entry on Windows.
mod login;
#[cfg_attr(windows, path = "windows.rs")]
mod native;
mod notch;
mod notify;
mod open;
// Where Tasktap shows itself: the notch, or the window, or a system notification (plan, "Notch").
mod presence;
mod speech;
mod takeover;
mod update;
// Where the tab hangs on a Windows display: arithmetic, tested on every system.
#[cfg(any(windows, test))]
mod tab;
// The notification-area icon: its picture and its words are tested on every system.
#[cfg(any(windows, test))]
#[cfg_attr(not(windows), allow(dead_code))]
mod tray;
mod workspace;

use crate::core::{Core, Link, Stream};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::net::Shutdown;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tasktap_proto::{QuestionId, Role};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{AppHandle, Emitter, Manager, RunEvent};
#[cfg(target_os = "macos")]
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};

/// The app's own state. The core and the host's connection to it are there once the core has started, which the
/// app does not wait for: its windows show what their pages draw meanwhile, and what needs the core waits for it.
struct Host {
    core: OnceLock<Arc<Core>>,
    link: OnceLock<Arc<Link>>,
    /// Each page's connection to the core, by window label.
    pages: Mutex<Pages<Stream>>,
    /// The question `glance` names, which affirm and deny act on.
    question: Mutex<Option<QuestionId>>,
}

/// Which app this is. A build with the `review` feature (only `scripts/build-review.sh` sets it, with
/// `tauri.review.conf.json` for the bundle's name and identifier) is Tasktap Review: the same app, to try beside the
/// person's own Tasktap while it runs. It has a data folder of its own, and with it its own core, socket or pipe,
/// copy of the core and device key; no notch (on Windows no tab until one is chosen in its Settings), since the
/// person's own is in the same place; and no global key at all, recorded or not, which its pages then name none of.
pub(crate) const REVIEW: bool = cfg!(feature = "review");
pub(crate) const NAME: &str = if REVIEW { "Tasktap Review" } else { "Tasktap" };

fn log(value: Value) {
    println!("{value}");
}

/// The app, for window events that carry none, set once its state is managed; and when it started, for the launch
/// measure.
static APP: OnceLock<AppHandle> = OnceLock::new();
/// The app once the core has started: what the host's connection hears is acted on from then on, as it was when the
/// app waited for the core before its event loop ran.
fn up() -> &'static AppHandle {
    let app = APP.wait();
    app.state::<Host>().link.wait();
    app
}
static START: OnceLock<Instant> = OnceLock::new();
fn since_start() -> u128 {
    START.get().map_or(0, |s| s.elapsed().as_millis())
}

/// Each page's connection to the core, by window label. A page asks for one as it loads, and it is made once the core
/// is there, which at a start may be a while: only the page that asked last for a label holds that label's
/// connection, and none is held for a window that is gone.
struct Pages<T> {
    held: HashMap<String, T>,
    asked: HashMap<String, u64>,
    next: u64,
}

impl<T> Default for Pages<T> {
    fn default() -> Self {
        Pages { held: HashMap::new(), asked: HashMap::new(), next: 0 }
    }
}

impl<T> Pages<T> {
    /// A page asks for its connection: the number that connection is held under.
    fn ask(&mut self, label: &str) -> u64 {
        self.next += 1;
        self.asked.insert(label.to_owned(), self.next);
        self.next
    }

    /// Holds the connection made for ask `n`, giving back the one it replaces; or, when a page asked for the label
    /// since (reloaded, or its window made again), gives it back itself, to be closed.
    fn hold(&mut self, label: &str, n: u64, connection: T) -> Result<Option<T>, T> {
        match self.asked.get(label) == Some(&n) {
            true => Ok(self.held.insert(label.to_owned(), connection)),
            false => Err(connection),
        }
    }

    /// The window of ask `n` is gone: the connection held for it, to be closed.
    fn gone(&mut self, label: &str, n: u64) -> Option<T> {
        if self.asked.get(label) != Some(&n) {
            return None;
        }
        self.asked.remove(label);
        self.held.remove(label)
    }

    /// The window is gone: its connection, to be closed.
    fn forget(&mut self, label: &str) -> Option<T> {
        self.held.remove(label)
    }

    fn get_mut(&mut self, label: &str) -> Option<&mut T> {
        self.held.get_mut(label)
    }
}

/// Opens this page's connection; the core's bytes reach the page on `frames` as they arrive,
/// whole frames or not. An empty message means the connection ended. Made on a thread of its own once the core is
/// there, which at a start may be a while: the page waits for its welcome, and the app does not.
#[tauri::command]
fn bridge_open(webview: tauri::Webview, frames: Channel<InvokeResponseBody>, app: AppHandle) -> Result<(), String> {
    let label = webview.label().to_owned();
    let asked = app.state::<Host>().pages.lock().unwrap().ask(&label);
    std::thread::spawn(move || {
        let host = app.state::<Host>();
        let opened = host.core.wait().connect(Role::Page, &format!("tasktap-app {label}"));
        let Ok((stream, first)) = opened else {
            // As a refused connection always ended: the page starts over a moment later.
            let _ = frames.send(InvokeResponseBody::Raw(Vec::new()));
            return;
        };
        let Ok(mut reader) = stream.try_clone() else {
            let _ = frames.send(InvokeResponseBody::Raw(Vec::new()));
            return;
        };
        // Held first, then the window looked at: a window closed before the hold is found gone, one closed after it
        // lets go of it as its page is forgotten. Either way no connection the core would keep streams for is held
        // for a window that is gone.
        let held = host.pages.lock().unwrap().hold(&label, asked, stream);
        let replaced = match held {
            Ok(replaced) => replaced,
            // A page that asked since holds the label's connection: this one is no one's.
            Err(superseded) => {
                let _ = superseded.shutdown(Shutdown::Both);
                return;
            }
        };
        if let Some(old) = replaced {
            let _ = old.shutdown(Shutdown::Both);
        }
        if app.get_webview_window(&label).is_none() {
            if let Some(stream) = host.pages.lock().unwrap().gone(&label, asked) {
                let _ = stream.shutdown(Shutdown::Both);
            }
            return;
        }
        let _ = frames.send(InvokeResponseBody::Raw(first));
        let mut buf = vec![0u8; 64 << 10];
        while let Ok(n @ 1..) = reader.read(&mut buf) {
            if frames.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                break;
            }
        }
        let _ = frames.send(InvokeResponseBody::Raw(Vec::new()));
    });
    Ok(())
}

/// A page whose window is gone lets go of its connection, so the core stops holding its streams
/// for it and answers its terminals' questions again while no window is attached (design §9).
fn forget_page(app: &AppHandle, label: &str) {
    if let Some(stream) = app.state::<Host>().pages.lock().unwrap().forget(label) {
        let _ = stream.shutdown(Shutdown::Both);
    }
}

/// Frames from the page to the core, already encoded; the host does not read them.
#[tauri::command]
fn bridge_send(webview: tauri::Webview, request: tauri::ipc::Request, host: tauri::State<Host>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("frames travel as bytes".into()) };
    let mut pages = host.pages.lock().unwrap();
    let stream = pages.get_mut(webview.label()).ok_or("no connection")?;
    stream.write_all(bytes).map_err(|e| e.to_string())
}

/// A `host.*` call from the page, answered here: the reply frame.
#[cfg(not(windows))]
#[tauri::command]
fn bridge_host(webview: tauri::Webview, app: AppHandle, frame: String) -> String {
    host_call(&app, webview.label(), &frame)
}

/// On Windows a call is answered from the event loop, not from inside the web view's own callback, where Tauri
/// would run it: the folder dialog runs a message loop of its own until it is closed, and WebView2 allows none
/// inside one of its callbacks.
#[cfg(windows)]
#[tauri::command]
async fn bridge_host(webview: tauri::Webview, app: AppHandle, frame: String) -> String {
    let (answer, mut answered) = tauri::async_runtime::channel(1);
    let (to, page) = (app.clone(), webview.label().to_owned());
    let asked = app.run_on_main_thread(move || drop(answer.try_send(host_call(&to, &page, &frame))));
    match (asked, answered.recv().await) {
        (Ok(()), Some(reply)) => reply,
        _ => {
            json!({"t": "reply", "id": null, "err": {"code": "unknown", "message": "the app is quitting"}}).to_string()
        }
    }
}

/// `page` is the window whose page asks.
#[cfg_attr(not(windows), allow(unused_variables))]
fn host_call(app: &AppHandle, page: &str, frame: &str) -> String {
    let call: Value = serde_json::from_str(frame).unwrap_or_default();
    let (id, args) = (call["id"].clone(), &call["args"]);
    let outcome = match call["name"].as_str().unwrap_or_default() {
        "host.notch" => {
            // The notch takes the keyboard for a thought: a capture, at which the updater looks once a day.
            if args["key"].as_bool() == Some(true) {
                update::daily(app);
            }
            notch::request(app, args);
            Ok(Value::Null)
        }
        "host.show" => workspace::show(app, args["at"].as_str()).map(|_| Value::Null).map_err(|e| e.to_string()),
        "host.ready" => {
            // Said even when the fallback showed the window already: when the page's word came, and before what.
            log(json!({"event": "page-ready", "ms": since_start()}));
            workspace::ready(app, "ready");
            Ok(Value::Null)
        }
        // The system's own folder panel, or the folder a check names instead. `at`: the folder it opens in, where the
        // person keeps their projects.
        "host.pick" => match std::env::var("TASKTAP_PICK") {
            Ok(folder) => Ok(json!(folder)),
            // The window's own folder panel: while it is open the window counts as in front still.
            #[cfg(not(windows))]
            Err(_) => {
                presence::pause(page == workspace::LABEL);
                let chosen = native::pick_folder(args["at"].as_str());
                presence::pause(false);
                Ok(json!(chosen))
            }
            // Modal to the window that asks: the workspace's, or the tab's, whose sheet stays open behind it.
            #[cfg(windows)]
            Err(_) => {
                edge::picking(true);
                presence::pause(page == workspace::LABEL);
                let chosen = native::pick_folder(
                    app.get_webview_window(page).and_then(|w| w.hwnd().ok()).map(|w| w.0 as isize),
                    args["at"].as_str(),
                );
                presence::pause(false);
                edge::picking(false);
                chosen.map(|folder| json!(folder))
            }
        },
        "host.window" => workspace::window(app, args["do"].as_str().unwrap_or_default()),
        "host.clipboard" => Ok(json!(native::clipboard(args["text"].as_str(), notch::NOTCH.lock().unwrap().passive))),
        "host.power" => Ok(json!(native::low_power())),
        // What each key prints in the keyboard layout in use, by its place: a Mac's web view cannot say (keys.ts
        // `watchLayout`); on Windows the page asks its own web view.
        #[cfg(target_os = "macos")]
        "host.layout" => Ok(Value::Object(native::layout())),
        // A web address, or what is inside a folder the person opened or a copy Tasktap made of one (open.rs).
        "host.open" => match started(app) {
            Some((core, link)) => {
                let mut roots: Vec<_> = link.folders.lock().unwrap().iter().map(|(_, folder)| folder.clone()).collect();
                roots.push(core.data.join("worktrees"));
                open::open(args, &roots, notch::NOTCH.lock().unwrap().passive)
            }
            None => Err(STARTING.into()),
        },
        "host.capture_key" => keys::call(app, args),
        // The keys that answer a waiting question from any app: the ones in use, or one changed (keys.rs).
        "host.answer_key" => keys::answer_call(app, args),
        // The key held to talk: asked of the system as it is recorded, so that one another app holds is refused.
        "host.talk_key" => keys::talk_call(app, args),
        // Whether Tasktap opens when the computer starts, as the system says; or set (login.rs).
        "host.login" => login::call(args),
        // Where Tasktap shows itself; with `shows`, what the workspace window shows now (presence.rs).
        "host.where" => Ok(presence::call(app, args)),
        // New versions: what is known, a look (About is shown), or the install the person asked for (update.rs).
        "host.update" => update::call(app, args),
        // Windows: which display the tab hangs on, or none.
        #[cfg(windows)]
        "host.tab" => edge::setting(app, args),
        // Where a preview's frame loads a file from (frames.rs): given only once the web view is held to this
        // machine's own addresses.
        "host.frame" if !workspace::CONFINED.load(std::sync::atomic::Ordering::Relaxed) => {
            Err("Showing a page here is not ready yet".into())
        }
        "host.frame" => {
            let Some((core, link)) = started(app) else { return reply_to(&id, Err(STARTING.into())) };
            let worktrees = core.data.join("worktrees");
            frames::base(move || {
                let mut roots: Vec<_> = link.folders.lock().unwrap().iter().map(|(_, folder)| folder.clone()).collect();
                roots.push(worktrees.clone());
                roots
            })
            // With `listens`, a local web address: whether anything answers there now.
            .map(|base| match args["listens"].as_str() {
                Some(address) => json!({"base": base, "listens": frames::listens(address)}),
                None => json!({"base": base}),
            })
        }
        name => Err(format!("this host has no {name}")),
    };
    reply_to(&id, outcome)
}

/// What a page's `host.*` call is answered with, as a frame.
fn reply_to(id: &Value, outcome: Result<Value, String>) -> String {
    match outcome {
        Ok(ok) => json!({"t": "reply", "id": id, "ok": ok}),
        Err(message) => json!({"t": "reply", "id": id, "err": {"code": "unknown", "message": message}}),
    }
    .to_string()
}

#[tauri::command]
fn debug_report(label: String, data: Value) {
    log(json!({"event": "report", "label": label, "data": data}));
}

/// The core and the host's connection to it, once the core has started.
fn started(app: &AppHandle) -> Option<(Arc<Core>, Arc<Link>)> {
    let host = app.state::<Host>();
    Some((host.core.get()?.clone(), host.link.get()?.clone()))
}

/// What a call that needs the core is told while it starts.
const STARTING: &str = "Tasktap's core is still starting";

/// Affirm and deny act on the question `glance` names, from any app.
fn input(app: &AppHandle, action: &str) {
    let host = app.state::<Host>();
    let Some(question) = *host.question.lock().unwrap() else { return };
    let Some(link) = host.link.get() else { return };
    let action = action.to_owned();
    link.call("input", json!({"action": action, "question": question}), move |outcome| {
        log(json!({"event": "input", "action": action, "outcome": outcome}))
    });
}

/// The question the answer keys act on, as the rule needs it. One the host has not heard the row of yet is
/// answered as before: the core says whether the answer fits.
fn asks(app: &AppHandle) -> Option<presence::Asks> {
    let host = app.state::<Host>();
    let id = (*host.question.lock().unwrap())?;
    let known = host.link.get().and_then(|link| link.questions.lock().unwrap().get(&id).cloned());
    Some(known.unwrap_or(presence::Asks { id: id.uuid().to_string(), session: None, terminal: false, confirm: true }))
}

/// What the host's own connection heard besides `glance`: the open questions changed, or a question opened.
fn heard(app: &AppHandle, heard: core::Heard) {
    match heard {
        core::Heard::Questions => {
            presence::question(app, asks(app));
            let open: Vec<String> = match app.state::<Host>().link.get() {
                Some(link) => link.questions.lock().unwrap().values().map(|q| q.id.clone()).collect(),
                None => Vec::new(),
            };
            notify::settle(&open);
        }
        core::Heard::Notify(args) => notify::asked(&args),
    }
}

/// The answer keys are registered only while a question waits, so they take no keys from other
/// apps the rest of the time (keys.rs). On Windows the icon in the notification area follows the counts.
fn glance(app: &AppHandle, g: tasktap_proto::Glance) {
    #[cfg(windows)]
    tray::set(Some([g.working, g.needs_you, g.done, g.failed]));
    let question = g.question;
    let host = app.state::<Host>();
    let before = std::mem::replace(&mut *host.question.lock().unwrap(), question);
    presence::question(app, asks(app));
    // A review build has none of them (keys.rs `TAKES`): they are the person's own Tasktap's.
    if before.is_some() != question.is_some() {
        keys::asking(app, question.is_some());
    }
}

/// A thought from anywhere: what the capture key does, also from the icon in the notification area (Windows).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn capture(app: &AppHandle) {
    pressed(app, presence::Key::Capture);
}

/// A key from any app, where the rule sends it (plan, "Where Tasktap shows itself"): with the window in front the
/// caret goes to Home's field or New Task opens over what shows, and ⌃⌥J goes to the question in the window; from
/// another app the notch opens with the keyboard; a question only its terminal answers brings the window to that
/// terminal on J, Y and N alike; Yes and No are the core's to carry out otherwise, which never answers for the person.
fn pressed(app: &AppHandle, key: presence::Key) {
    // The first capture of a day is when a new version is looked for (update.rs).
    if key == presence::Key::Capture {
        update::daily(app);
    }
    let goes = presence::situation().key(key);
    log(json!({"event": "key", "key": format!("{key:?}"), "goes": format!("{goes:?}")}));
    match goes {
        presence::Goes::Field => workspace::capture(app, "field"),
        presence::Goes::NewTask => workspace::capture(app, "new-task"),
        presence::Goes::NotchField => notch::capture(app),
        presence::Goes::NotchQuestion => notch::answer(app),
        presence::Goes::Question(id) => drop(workspace::show(app, Some(&format!("question:{id}")))),
        presence::Goes::Core(action) => input(app, action),
        presence::Goes::Nothing => {}
    }
}

fn shortcut(app: &AppHandle, shortcut: &Shortcut) {
    let capture_key = keys::CAPTURE.lock().unwrap().as_ref().and_then(keys::system);
    if capture_key.as_ref() == Some(shortcut) {
        return pressed(app, presence::Key::Capture);
    }
    match keys::answering(shortcut) {
        Some(tasktap_proto::AnswerKey::Question) => pressed(app, presence::Key::Answer),
        Some(tasktap_proto::AnswerKey::Yes) => pressed(app, presence::Key::Yes),
        Some(tasktap_proto::AnswerKey::No) => pressed(app, presence::Key::No),
        None => {}
    }
}

/// The Mac: whether a full-screen app or a presentation is in front, asked when the system says the space or the app
/// in front changed, and once more a moment later, since a space takes its time to settle. Never on a timer.
#[cfg(target_os = "macos")]
fn full_screen(app: &AppHandle, again: bool) {
    let panel = notch::NOTCH.try_lock().map(|st| st.panel).unwrap_or(0);
    presence::full(app, native::full_screen(panel));
    if again {
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(700));
            let inner = handle.clone();
            let _ = handle.run_on_main_thread(move || full_screen(&inner, false));
        });
    }
}

/// The debug channel (TASKTAP_DEBUG=1): one command per line on standard input, so a check can
/// drive this app through its own process, never through the keyboard or pointer.
fn command(app: &AppHandle, line: &str) {
    let (verb, rest) = line.split_once(' ').unwrap_or((line, ""));
    let (label, arg) = rest.split_once(' ').unwrap_or((rest, ""));
    let eval = |js: String| match app.get_webview_window(label) {
        Some(w) => drop(w.eval(&js)),
        None => log(json!({"event": "report", "label": label, "data": null})),
    };
    // The value of an expression, awaited when it is a promise (a measurement), as one report.
    let report = |expr: String| {
        eval(format!("(async()=>{{try{{return await ({expr})}}catch(e){{return 'error: '+e}}}})().then(data=>window.__TAURI_INTERNALS__.invoke('debug_report',{{label:{label:?},data:data??null}}))"))
    };
    match verb {
        "capture" => notch::capture(app),
        "answer" => notch::answer(app),
        "affirm" => input(app, "answer.affirm"),
        "deny" => input(app, "answer.deny"),
        "hover" => notch::tell(app, json!({"do": if rest == "in" { "hover-enter" } else { "hover-exit" }})),
        "show" => drop(workspace::show(app, (!rest.is_empty()).then_some(rest))),
        // `front`: the workspace window in front of every other, with the keyboard left where it is: a measurement
        // needs the window seen, and a passive one opens behind the app in use.
        #[cfg(target_os = "macos")]
        "front" => {
            if let Some(window) = app.get_webview_window(workspace::LABEL).and_then(|w| w.ns_window().ok()) {
                native::order_front(window as usize)
            }
        }
        // `back`: behind the other windows again, once a check has seen what it brought the window forward for.
        #[cfg(target_os = "macos")]
        "back" => {
            if let Some(window) = app.get_webview_window(workspace::LABEL).and_then(|w| w.ns_window().ok()) {
                native::order_back(window as usize)
            }
        }
        // `where`: where Tasktap shows itself now. A check's run is never put in front by the system, so it says where
        // the window is instead, as the system would: `where front|behind|system`, `where full on|off|system`.
        "where" => match (label, arg) {
            ("front" | "behind", _) => presence::tell(app, Some(label == "front")),
            ("system", _) => presence::tell(app, None),
            ("full", "on" | "off") => presence::tell_full(app, Some(arg == "on")),
            ("full", _) => presence::tell_full(app, None),
            _ => log(json!({"event": "where", "state": presence::state()})),
        },
        // `hotkey <capture|j|y|n>`: a key from any app, as the system tells of it.
        "hotkey" => pressed(
            app,
            match rest {
                "j" => presence::Key::Answer,
                "y" => presence::Key::Yes,
                "n" => presence::Key::No,
                _ => presence::Key::Capture,
            },
        ),
        // `elsewhere`: a click outside the app, as the Mac's monitor tells of it (Windows: the keyboard went to another
        // window, as its watch tells of it).
        #[cfg(target_os = "macos")]
        "elsewhere" => notch::elsewhere(app),
        #[cfg(windows)]
        "elsewhere" => notch::tell(app, json!({"do": "away"})),
        "menu" => workspace::on_menu(app, rest),
        // `shortcut`: the capture key, as the system tells of it.
        "shortcut" => {
            if let Some(key) = keys::CAPTURE.lock().unwrap().as_ref().and_then(keys::system) {
                shortcut(app, &key)
            }
        }
        // `tab`: what the tab's windows and the icon are now. `tab <display>`: the setting, as Settings sets it.
        // `fullscreen on|off`: the workspace window over the whole display, as a film or a game is.
        #[cfg(windows)]
        "tab" if rest.is_empty() => log(edge::state()),
        #[cfg(windows)]
        "tab" => log(json!({"event": "tab", "set": edge::setting(app, &json!({"display": rest}))})),
        #[cfg(windows)]
        "fullscreen" => {
            if let Some(window) = app.get_webview_window(workspace::LABEL) {
                let _ = window.set_fullscreen(rest == "on");
            }
        }
        "close" => {
            if let Some(window) = app.get_webview_window(rest) {
                let _ = window.close();
            }
        }
        "state" => {
            let workspace = app.get_webview_window(workspace::LABEL);
            #[cfg(target_os = "macos")]
            let workspace = workspace.and_then(|w| w.ns_window().ok()).map(|w| native::ns_window_number(w as usize));
            #[cfg(windows)]
            let workspace = workspace.and_then(|w| w.hwnd().ok()).map(|w| w.0 as isize);
            log(
                json!({"event": "state", "notch": notch::state(), "question": *app.state::<Host>().question.lock().unwrap(),
                "workspace": workspace, "where": presence::state()}),
            )
        }
        // `snapshot <page> <file>`: the page as it is drawn, as PNG.
        #[cfg(windows)]
        "snapshot" => {
            let path = std::path::PathBuf::from(arg);
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.with_webview(move |view| {
                    let file = path.display().to_string();
                    native::snapshot(&view, &path, move |ok| log(json!({"event": "snapshot", "file": file, "ok": ok})))
                });
            }
        }
        #[cfg(target_os = "macos")]
        "snapshot" => {
            let path = std::path::PathBuf::from(arg);
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.with_webview(move |view| {
                    let file = path.display().to_string();
                    native::snapshot(view.inner(), path, move |ok| {
                        log(json!({"event": "snapshot", "file": file, "ok": ok}))
                    })
                });
            }
        }
        // `tabkey <page> [back]`: Tab (Shift-Tab) pressed in that page's web view, as the keyboard presses it there.
        #[cfg(target_os = "macos")]
        "tabkey" => {
            if let Some(window) = app.get_webview_window(label) {
                let back = arg == "back";
                let _ = window.with_webview(move |view| native::press_tab(view.inner(), back));
            }
        }
        "text" => report(format!("document.querySelector({arg:?})?.innerText ?? null")),
        "eval" => report(arg.to_owned()),
        "type" => report(format!("document.execCommand('insertText',false,{arg:?})")),
        "key" => {
            let code = match arg {
                "Enter" => 13,
                "Escape" => 27,
                "Tab" => 9,
                "ArrowUp" => 38,
                "ArrowDown" => 40,
                _ => arg.chars().next().map_or(0, |c| c.to_ascii_uppercase() as u32),
            };
            report(format!("(()=>{{const t=document.activeElement||document.body;for(const type of ['keydown','keyup']){{const e=new KeyboardEvent(type,{{key:{arg:?},bubbles:true,cancelable:true}});Object.defineProperty(e,'keyCode',{{get:()=>{code}}});t.dispatchEvent(e)}}return t.id||t.className||t.tagName}})()"))
        }
        "click" => report(format!("(()=>{{const e=document.querySelector({arg:?});e?.click();return !!e}})()")),
        "call" => {
            let (name, args) = rest.split_once(' ').unwrap_or((rest, "{}"));
            let name = name.to_owned();
            match app.state::<Host>().link.get() {
                Some(link) => {
                    link.call(&name.clone(), serde_json::from_str(args).unwrap_or_default(), move |outcome| {
                        log(json!({"event": "reply", "name": name, "outcome": outcome}))
                    })
                }
                None => log(json!({"event": "reply", "name": name, "refused": STARTING})),
            }
        }
        "quit" => {
            workspace::quit();
            app.exit(0)
        }
        _ => log(json!({"event": "unknown-command", "line": line})),
    }
}

fn data_folder() -> std::path::PathBuf {
    match std::env::var_os("TASKTAP_DATA") {
        Some(dir) => dir.into(),
        #[cfg(target_os = "macos")]
        None => std::path::Path::new(&std::env::var_os("HOME").unwrap_or_default())
            .join("Library/Application Support")
            .join(NAME),
        // The person's own, never roaming: the core's database and its pipe belong to this machine.
        #[cfg(windows)]
        None => std::path::Path::new(&std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join(NAME),
    }
}

/// Whether a page is given what its web view asks the system for. The microphone, and nothing else a web view can
/// ask for; and in a passive run (the checks: `TASKTAP_PASSIVE`) not the microphone either, whatever a check does:
/// one that forgot its stand-in for the microphone is refused and hears nothing.
fn granted(passive: bool, kind: PermissionKind) -> bool {
    !passive && kind == PermissionKind::Microphone
}

fn main() {
    START.get_or_init(Instant::now);
    let passive = std::env::var_os("TASKTAP_PASSIVE").is_some();
    // The core this app bundles, next to its own program; a check may name another.
    let (exe, build): (std::path::PathBuf, String) =
        match (std::env::var_os("TASKTAP_CORE_EXE"), std::env::var("TASKTAP_CORE_BUILD")) {
            (Some(exe), Ok(build)) => (exe.into(), build),
            _ => (
                std::env::current_exe()
                    .unwrap_or_default()
                    .with_file_name(format!("tasktap{}", std::env::consts::EXE_SUFFIX)),
                env!("TASKTAP_CORE_BUILD").to_owned(),
            ),
        };
    // The first start after the rename takes over Tasktap Next's folder, before anything is made in this app's own
    // (two looks at the disk when there is nothing to take over). While Tasktap Next runs, the app does not start.
    let moved = match takeover::before_start(&data_folder(), &exe) {
        takeover::Outcome::Nothing => None,
        takeover::Outcome::Moved(words) => {
            log(json!({"event": "takeover", "moved": words.body}));
            Some(words)
        }
        takeover::Outcome::Stopped(words) => {
            log(json!({"event": "takeover", "stopped": words.title, "why": words.body}));
            if !passive {
                takeover::tell(&words);
            }
            return;
        }
    };
    // The core starts while the app and its windows are made: macOS takes a tenth of a second over the first run of
    // a new copy of it, and nothing needs it before a page asks.
    let starting = std::thread::spawn(move || -> std::io::Result<(Arc<Core>, Arc<Link>)> {
        let core = Arc::new(Core::prepare(data_folder(), &exe, build)?);
        let link = Link::start(
            core.clone(),
            |g| {
                let app = up();
                let _ = app.run_on_main_thread(move || glance(app, g));
            },
            // The capture key is registered once the core's records say which it is, and again
            // whenever they change. A key the system refuses leaves the app running without it,
            // so that the person can choose another in Settings. The updater asks GitHub by itself
            // only while the person lets it.
            |prefs| {
                let app = up();
                update::allow(prefs.checks);
                keys::talk(prefs.talk);
                let _ = app.run_on_main_thread(move || {
                    keys::prefer(app, prefs.capture);
                    keys::answers(app, prefs.answers);
                });
            },
            |told| {
                let app = up();
                let _ = app.run_on_main_thread(move || heard(app, told));
            },
        )?;
        Ok((core, link))
    });
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(false);
    // The updater, in a build that has its key (update.rs).
    let mut context = tauri::generate_context!();
    let builder = match update::configure(context.config_mut()) {
        true => builder.plugin(tauri_plugin_updater::Builder::new().build()),
        false => builder,
    };
    let app = builder
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, s, event| {
                    if event.state == ShortcutState::Pressed {
                        shortcut(app, s)
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            bridge_open,
            bridge_send,
            bridge_host,
            debug_report,
            speech::speech_model,
            speech::speech_listen,
            speech::speech_audio,
            speech::speech_end
        ])
        // The pages may hear the microphone (hold to talk, which the page records itself so it is the same on every
        // system, and the appearance panel's trial; the person starts both, and macOS then asks them once, with
        // Info.plist's reason), and nothing else a web view can ask for.
        .on_permission_request(|_, kind| match granted(std::env::var_os("TASKTAP_PASSIVE").is_some(), kind) {
            true => PermissionResponse::Allow,
            false => PermissionResponse::Deny,
        })
        .on_menu_event(|app, event| workspace::on_menu(app, event.id().as_ref()))
        .setup(move |app| {
            let passive = std::env::var_os("TASKTAP_PASSIVE").is_some();
            notch::NOTCH.lock().unwrap().passive = passive;
            // In the Dock with a menu, as 1.2 was; a passive run (the checks) stays out of both.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(if passive {
                tauri::ActivationPolicy::Accessory
            } else {
                tauri::ActivationPolicy::Regular
            });
            workspace::start(data_folder());
            // On Windows the menu belongs to the workspace window (workspace::show).
            #[cfg(target_os = "macos")]
            app.set_menu(workspace::menu(app.handle())?)?;

            // Tauri's own window stays hidden; its web view moves into a real non-activating panel,
            // shown once the page asks: tao makes every window visible at launch key. Windows has no
            // counterpart yet, and so no notch page either: there the workspace window is the app. A review
            // build has none either, as on Windows: the person's own Tasktap has its notch in the same place, and
            // the capture key, once one is chosen, opens the workspace's.
            #[cfg(target_os = "macos")]
            if !REVIEW {
                let window = WebviewWindowBuilder::new(app, "notch", WebviewUrl::App("notch.html".into()))
                    .decorations(false)
                    .transparent(true)
                    .shadow(false)
                    .resizable(false)
                    .focused(false)
                    .visible(false)
                    .accept_first_mouse(true)
                    .visible_on_all_workspaces(true)
                    .inner_size(246.0, 54.0)
                    .build()?;
                let handle = app.handle().clone();
                window.with_webview(move |webview| {
                    native::tab_to_controls(webview.inner());
                    let mut st = notch::NOTCH.lock().unwrap();
                    st.panel = native::make_panel(webview.inner() as usize);
                    notch::position(&handle, &mut st);
                })?;
                // A passive run (the checks) is driven by its debug channel alone: the person's own
                // pointer passing the notch must not open or hold it while a check reads it.
                // What the system says of where the person is, which decides where Tasktap shows itself
                // (presence.rs): a full-screen app or a presentation coming or going, a click outside the app or
                // the panel losing the keyboard. A passive run hears none of it and is told by its check.
                if !notch::NOTCH.lock().unwrap().passive {
                    let handle = app.handle().clone();
                    native::watch_pointer(move || notch::moved(&handle));
                    let handle = app.handle().clone();
                    native::watch_spaces(move || full_screen(&handle, true));
                    full_screen(app.handle(), false);
                    let (handle, panel) = (app.handle().clone(), notch::NOTCH.lock().unwrap().panel);
                    native::watch_elsewhere(panel, move || notch::elsewhere(&handle));
                }
            }
            // This app becoming the active one or not (a review build's too, which has no notch: its window is
            // where it shows itself).
            #[cfg(target_os = "macos")]
            if !notch::NOTCH.lock().unwrap().passive {
                let handle = app.handle().clone();
                native::watch_active(move |active| presence::told(&handle, Some(active), None));
                presence::told(app.handle(), Some(native::app_active()), None);
            }

            // Windows: the helper window, the icon in the notification area and what says when to hide the tab.
            // The tab's own window is made once the workspace has drawn (workspace::ready).
            #[cfg(windows)]
            edge::start(passive);

            // The effects rest while the Mac is in Low Power Mode: the window's light and the notch's glow.
            let handle = app.handle().clone();
            native::watch_power(move || {
                let _ = handle.emit("ui", json!({"do": "power", "low": native::low_power()}));
            });

            if std::env::var_os("TASKTAP_DEBUG").is_some() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
                        let inner = handle.clone();
                        let _ = handle.run_on_main_thread(move || command(&inner, line.trim()));
                    }
                });
            }
            // The app's state, there before any window: the core and the link join it once the core has started.
            app.manage(Host {
                core: OnceLock::new(),
                link: OnceLock::new(),
                pages: Mutex::default(),
                question: Mutex::default(),
            });
            let _ = APP.set(app.handle().clone());
            // Opened by the system at login: no window, only the notch (on Windows the tab, made now as the window's
            // first picture would have made it) and the icon. The capture key and the icon bring the window.
            if login::started_at_login() {
                log(json!({"event": "login-start"}));
                #[cfg(windows)]
                edge::ready(app.handle());
            } else {
                workspace::show(app.handle(), None)?;
            }
            // The core may take a while to start (a first start's copy of it, a virus scanner's first look at it): nothing
            // here waits for it, so the event loop runs and the window shows as soon as its page has drawn, or after
            // 3 s. A core that cannot start ends the app as it always has, with why on standard error.
            let handle = app.handle().clone();
            std::thread::spawn(move || match starting.join() {
                Ok(Ok((core, link))) => {
                    log(json!({"event": "ready", "data": core.data}));
                    // The link first: a page connects once the core is there, and finds the link there too.
                    let host = handle.state::<Host>();
                    let _ = host.link.set(link);
                    let _ = host.core.set(core);
                    // Said once the window is there: what the first start did with Tasktap Next's folder.
                    if let Some(words) = moved.filter(|_| !passive) {
                        let _ = handle.run_on_main_thread(move || takeover::tell(&words));
                    }
                }
                // Why, and then out through the app's own exit, as a quit goes: the window's frame is kept and, on
                // Windows, the icon taken away.
                Ok(Err(e)) if !core::abandoned() => {
                    eprintln!("Tasktap failed to start: {e}");
                    handle.exit(101);
                }
                Ok(Err(_)) => {}
                Err(_) => {
                    eprintln!("Tasktap failed to start: the core's start panicked");
                    handle.exit(101);
                }
            });
            Ok(())
        })
        .build(context)
        .expect("Tasktap failed to start");
    // Closing the workspace never quits: the notch's own (hidden) Tauri window stays open. The
    // Dock icon brings the workspace back; Quit in the menu ends the app. On Windows the app stays in the
    // notification area, with or without the tab: its icon brings the workspace back, and Quit in the icon's menu
    // or Exit in the window's ends it. A check's run has no icon and ends with its last window, as before. A review
    // build on the Mac has no notch window, so closing the workspace leaves it in the Dock in the same way.
    #[cfg_attr(windows, allow(unused_variables))]
    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => drop(workspace::show(app, None)),
        RunEvent::ExitRequested { code: None, api, .. }
            if (cfg!(windows) || REVIEW) && !notch::NOTCH.lock().unwrap().passive =>
        {
            api.prevent_exit()
        }
        RunEvent::ExitRequested { .. } => {
            // A core still starting is ended: none starts after the app that asked for it has gone. Here already,
            // and not only at the end, since over SSH (no desktop) the event loop is never seen to end.
            core::abandon();
            workspace::quit();
            log(json!({"event": "quitting"}))
        }
        RunEvent::Exit => {
            core::abandon();
            #[cfg(windows)]
            edge::end();
            log(json!({"event": "quit"}))
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_closed_while_its_page_waited_for_the_core_keeps_no_connection() {
        let mut pages = Pages::default();
        let asked = pages.ask("workspace");
        // Closed before the connection is held: forgetting the page finds nothing, the look after the hold the window
        // gone.
        assert_eq!(pages.forget("workspace"), None);
        assert_eq!(pages.hold("workspace", asked, 1), Ok(None));
        assert_eq!(pages.gone("workspace", asked), Some(1));
        assert_eq!(pages.get_mut("workspace"), None);
    }

    #[test]
    fn only_the_page_that_asked_last_holds_its_windows_connection() {
        let mut pages = Pages::default();
        let first = pages.ask("workspace");
        let reloaded = pages.ask("workspace");
        // The page reloaded while both waited for the core: the first page's connection, made last, is not held.
        assert_eq!(pages.hold("workspace", reloaded, 2), Ok(None));
        assert_eq!(pages.hold("workspace", first, 1), Err(1));
        assert_eq!(pages.get_mut("workspace"), Some(&mut 2));
        // A window made again holds its own, and gives back the one it replaces; the look for the earlier window
        // finding it gone takes nothing from the new one.
        let again = pages.ask("workspace");
        assert_eq!(pages.hold("workspace", again, 3), Ok(Some(2)));
        assert_eq!(pages.gone("workspace", reloaded), None);
        assert_eq!(pages.get_mut("workspace"), Some(&mut 3));
    }

    #[test]
    fn a_passive_run_is_never_given_the_microphone_and_no_run_anything_else() {
        assert!(granted(false, PermissionKind::Microphone), "the person's own run may hear, once they hold to talk");
        for kind in [PermissionKind::Microphone, PermissionKind::Camera, PermissionKind::Geolocation] {
            assert!(!granted(true, kind), "{kind:?} in a passive run");
        }
        for kind in [PermissionKind::Camera, PermissionKind::Geolocation] {
            assert!(!granted(false, kind), "{kind:?}");
        }
    }
}
