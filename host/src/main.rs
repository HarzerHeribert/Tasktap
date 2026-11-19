// A window's program on Windows: started from the Start menu it opens no console.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
//! Tasktap Next: the host, on the Mac and on Windows. It starts the core, gives each page one pass-through to it
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
#[cfg_attr(windows, path = "windows.rs")]
mod native;
mod notch;
mod open;
mod speech;
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
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

struct Host {
    core: Arc<Core>,
    link: Arc<Link>,
    /// Each page's connection to the core, by window label.
    pages: Mutex<HashMap<String, Stream>>,
    /// The question `glance` names, which affirm and deny act on.
    question: Mutex<Option<QuestionId>>,
}

/// Control-Option and a key, as in 1.2: J, Y and N answer while a question waits. The capture key is
/// a preference (keys.rs), by default Space with the same two on a Mac.
fn keys(code: Code) -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), code)
}
const ANSWER_KEYS: [Code; 3] = [Code::KeyY, Code::KeyN, Code::KeyJ];

fn log(value: Value) {
    println!("{value}");
}

/// The app, for window events that carry none, set once its state is managed; and when it started, for the launch
/// measure.
static APP: OnceLock<AppHandle> = OnceLock::new();
static START: OnceLock<Instant> = OnceLock::new();
fn since_start() -> u128 {
    START.get().map_or(0, |s| s.elapsed().as_millis())
}

/// Opens this page's connection; the core's bytes reach the page on `frames` as they arrive,
/// whole frames or not. An empty message means the connection ended.
#[tauri::command]
fn bridge_open(
    webview: tauri::Webview,
    frames: Channel<InvokeResponseBody>,
    host: tauri::State<Host>,
) -> Result<(), String> {
    let label = webview.label().to_owned();
    let (stream, first) = host.core.connect(Role::Page, &format!("tasktap-next {label}")).map_err(|e| e.to_string())?;
    let mut reader = stream.try_clone().map_err(|e| e.to_string())?;
    if let Some(old) = host.pages.lock().unwrap().insert(label, stream) {
        let _ = old.shutdown(Shutdown::Both);
    }
    let _ = frames.send(InvokeResponseBody::Raw(first));
    std::thread::spawn(move || {
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
    if let Some(stream) = app.state::<Host>().pages.lock().unwrap().remove(label) {
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
            notch::request(app, args);
            Ok(Value::Null)
        }
        "host.show" => workspace::show(app, args["at"].as_str()).map(|_| Value::Null).map_err(|e| e.to_string()),
        "host.ready" => {
            workspace::ready(app);
            Ok(Value::Null)
        }
        // The system's own folder panel, or the folder a check names instead.
        "host.pick" => match std::env::var("TASKTAP_PICK") {
            Ok(folder) => Ok(json!(folder)),
            #[cfg(not(windows))]
            Err(_) => Ok(json!(native::pick_folder())),
            // Modal to the window that asks: the workspace's, or the tab's, whose sheet stays open behind it.
            #[cfg(windows)]
            Err(_) => {
                edge::picking(true);
                let chosen =
                    native::pick_folder(app.get_webview_window(page).and_then(|w| w.hwnd().ok()).map(|w| w.0 as isize));
                edge::picking(false);
                chosen.map(|folder| json!(folder))
            }
        },
        "host.window" => workspace::window(app, args["do"].as_str().unwrap_or_default()),
        "host.clipboard" => Ok(json!(native::clipboard(args["text"].as_str(), notch::NOTCH.lock().unwrap().passive))),
        "host.power" => Ok(json!(native::low_power())),
        // A web address, or what is inside a folder the person opened or a copy Tasktap made of one (open.rs).
        "host.open" => {
            let host = app.state::<Host>();
            let mut roots: Vec<_> =
                host.link.folders.lock().unwrap().iter().map(|(_, folder)| folder.clone()).collect();
            roots.push(host.core.data.join("worktrees"));
            open::open(args, &roots, notch::NOTCH.lock().unwrap().passive)
        }
        "host.capture_key" => keys::call(app, args),
        // The capture key was pressed with the workspace in front and it has no field of its own in view: what
        // the key opens from another app. Without a notch or a tab that is New Task.
        "host.capture" => {
            // (The lock is let go before the notch is asked: it takes it itself.)
            let panel = notch::NOTCH.lock().unwrap().panel;
            match panel {
                0 => workspace::on_menu(app, "new-task"),
                _ => notch::capture(app),
            }
            Ok(Value::Null)
        }
        // Windows: which display the tab hangs on, or none.
        #[cfg(windows)]
        "host.tab" => edge::setting(app, args),
        // Where a preview's frame loads a file from (frames.rs): given only once the web view is held to this
        // machine's own addresses.
        "host.frame" if !workspace::CONFINED.load(std::sync::atomic::Ordering::Relaxed) => {
            Err("Showing a page here is not ready yet".into())
        }
        "host.frame" => {
            let host = app.state::<Host>();
            let (link, worktrees) = (host.link.clone(), host.core.data.join("worktrees"));
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

/// Affirm and deny act on the question `glance` names, from any app.
fn input(app: &AppHandle, action: &str) {
    let host = app.state::<Host>();
    let Some(question) = *host.question.lock().unwrap() else { return };
    let action = action.to_owned();
    host.link.call("input", json!({"action": action, "question": question}), move |outcome| {
        log(json!({"event": "input", "action": action, "outcome": outcome}))
    });
}

/// The answer shortcuts exist only while a question waits, so they take no keys from other
/// apps the rest of the time. On Windows the icon in the notification area follows the counts.
fn glance(app: &AppHandle, g: tasktap_proto::Glance) {
    #[cfg(windows)]
    tray::set(Some([g.working, g.needs_you, g.done, g.failed]));
    let question = g.question;
    let host = app.state::<Host>();
    let before = std::mem::replace(&mut *host.question.lock().unwrap(), question);
    if before.is_some() == question.is_some() {
        return;
    }
    let answer = ANSWER_KEYS.map(keys);
    let done = match question {
        Some(_) => app.global_shortcut().register_multiple(answer),
        None => app.global_shortcut().unregister_multiple(answer),
    };
    log(json!({"event": "answer-keys", "on": question.is_some(), "ok": done.is_ok()}));
}

/// A thought from anywhere: the notch opens with the keyboard in its field, on Windows the tab. Where there is
/// neither (Windows, with the tab switched off) the workspace comes in front with a field for it.
pub(crate) fn capture(app: &AppHandle) {
    // (The lock is let go before the notch is asked: it takes it itself.)
    let panel = notch::NOTCH.lock().unwrap().panel;
    match panel {
        0 => workspace::capture(app),
        _ => notch::capture(app),
    }
}

fn shortcut(app: &AppHandle, shortcut: &Shortcut) {
    let capture_key = keys::CAPTURE.lock().unwrap().as_ref().and_then(keys::system);
    let panel = notch::NOTCH.lock().unwrap().panel;
    match shortcut.key {
        // The capture key puts the caret where a thought is typed (plan, "The capture key on Home"). With the
        // workspace in front that is its page's to say: Home has a field of its own.
        _ if capture_key.as_ref() == Some(shortcut) && workspace::in_front(app) => workspace::capture(app),
        _ if capture_key.as_ref() == Some(shortcut) => capture(app),
        Code::KeyJ if panel == 0 => drop(workspace::show(app, None)),
        Code::KeyJ => notch::answer(app),
        Code::KeyY => input(app, "answer.affirm"),
        Code::KeyN => input(app, "answer.deny"),
        _ => {}
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
                "workspace": workspace}),
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
            app.state::<Host>().link.call(
                &name.clone(),
                serde_json::from_str(args).unwrap_or_default(),
                move |outcome| log(json!({"event": "reply", "name": name, "outcome": outcome})),
            );
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
            .join("Library/Application Support/Tasktap Next"),
        // The person's own, never roaming: the core's database and its pipe belong to this machine.
        #[cfg(windows)]
        None => std::path::Path::new(&std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("Tasktap Next"),
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
    // The core starts while the app and its windows are made: macOS takes a tenth of a second over the first run of
    // a new copy of it, and nothing needs it before a page asks.
    let starting = std::thread::spawn(|| -> std::io::Result<(Arc<Core>, Arc<Link>)> {
        // The core this app bundles, next to its own program; a check may name another.
        let (exe, build) = match (std::env::var_os("TASKTAP_CORE_EXE"), std::env::var("TASKTAP_CORE_BUILD")) {
            (Some(exe), Ok(build)) => (exe.into(), build),
            _ => (
                std::env::current_exe()?.with_file_name(format!("tasktap{}", std::env::consts::EXE_SUFFIX)),
                env!("TASKTAP_CORE_BUILD").to_owned(),
            ),
        };
        let core = Arc::new(Core::prepare(data_folder(), &exe, build)?);
        let link = Link::start(
            core.clone(),
            |g| {
                let app = APP.wait();
                let _ = app.run_on_main_thread(move || glance(app, g));
            },
            // The capture key is registered once the core's records say which it is, and again
            // whenever they change. A key the system refuses leaves the app running without it,
            // so that the person can choose another in Settings.
            |key| {
                let app = APP.wait();
                let _ = app.run_on_main_thread(move || keys::prefer(app, key));
            },
        )?;
        Ok((core, link))
    });
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(false);
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
            // counterpart yet, and so no notch page either: there the workspace window is the app.
            #[cfg(target_os = "macos")]
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
            #[cfg(target_os = "macos")]
            let handle = app.handle().clone();
            #[cfg(target_os = "macos")]
            window.with_webview(move |webview| {
                let mut st = notch::NOTCH.lock().unwrap();
                st.panel = native::make_panel(webview.inner() as usize);
                notch::position(&handle, &mut st);
            })?;
            // A passive run (the checks) is driven by its debug channel alone: the person's own
            // pointer passing the notch must not open or hold it while a check reads it.
            #[cfg(target_os = "macos")]
            if !notch::NOTCH.lock().unwrap().passive {
                let handle = app.handle().clone();
                native::watch_pointer(move || notch::moved(&handle));
            }

            // Windows: the helper window, the icon in the notification area and what says when to hide the tab.
            // The tab's own window is made once the workspace has drawn (workspace::ready).
            #[cfg(windows)]
            edge::start(passive);

            // The workspace's effects rest while the Mac is in Low Power Mode.
            let handle = app.handle().clone();
            native::watch_power(move || {
                let _ = handle.emit_to(workspace::LABEL, "ui", json!({"do": "power", "low": native::low_power()}));
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
            workspace::show(app.handle(), None)?;
            let (core, link) = starting.join().expect("the core's start panicked")?;
            log(json!({"event": "ready", "data": core.data}));
            app.manage(Host { core, link, pages: Mutex::default(), question: Mutex::default() });
            let _ = APP.set(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tasktap Next failed to start");
    // Closing the workspace never quits: the notch's own (hidden) Tauri window stays open. The
    // Dock icon brings the workspace back; Quit in the menu ends the app. On Windows the app stays in the
    // notification area, with or without the tab: its icon brings the workspace back, and Quit in the icon's menu
    // or Exit in the window's ends it. A check's run has no icon and ends with its last window, as before.
    #[cfg_attr(windows, allow(unused_variables))]
    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => drop(workspace::show(app, None)),
        #[cfg(windows)]
        RunEvent::ExitRequested { code: None, api, .. } if !notch::NOTCH.lock().unwrap().passive => api.prevent_exit(),
        RunEvent::ExitRequested { .. } => {
            workspace::quit();
            log(json!({"event": "quitting"}))
        }
        RunEvent::Exit => {
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
