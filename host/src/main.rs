//! Tasktap Next: the Mac host. It starts the core, gives each page one pass-through to it
//! (design §12), answers the page's `host.*` calls, places the notch panel and binds the global
//! shortcuts. Everything else is the core's or the page's.
mod core;
mod geometry;
mod native;
mod notch;
mod workspace;

use crate::core::{Core, Link};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tasktap_proto::{QuestionId, Role};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

struct Host {
    core: Arc<Core>,
    link: Arc<Link>,
    /// Each page's connection to the core, by window label.
    pages: Mutex<HashMap<String, UnixStream>>,
    /// The question `glance` names, which affirm and deny act on.
    question: Mutex<Option<QuestionId>>,
}

/// Control-Option and a key, as in 1.2: Space captures; J, Y and N answer while a question waits.
fn keys(code: Code) -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), code)
}
const ANSWER_KEYS: [Code; 3] = [Code::KeyY, Code::KeyN, Code::KeyJ];

fn log(value: Value) {
    println!("{value}");
}

/// The app, for window events that carry none; and when it started, for the launch measure.
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
#[tauri::command]
fn bridge_host(app: AppHandle, frame: String) -> String {
    let call: Value = serde_json::from_str(&frame).unwrap_or_default();
    let (id, args) = (call["id"].clone(), &call["args"]);
    let outcome = match call["name"].as_str().unwrap_or_default() {
        "host.notch" => {
            notch::request(&app, args);
            Ok(Value::Null)
        }
        "host.show" => workspace::show(&app, args["at"].as_str()).map(|_| Value::Null).map_err(|e| e.to_string()),
        "host.ready" => {
            workspace::ready(&app);
            Ok(Value::Null)
        }
        "host.pick" => Ok(match std::env::var("TASKTAP_PICK") {
            Ok(folder) => json!(folder),
            Err(_) => json!(native::pick_folder()),
        }),
        "host.clipboard" => Ok(json!(native::clipboard(args["text"].as_str(), notch::NOTCH.lock().unwrap().passive))),
        "host.appearance" => Ok(workspace::appearance(&app, args)),
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
/// apps the rest of the time.
fn glance(app: &AppHandle, question: Option<QuestionId>) {
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

fn shortcut(app: &AppHandle, shortcut: &Shortcut) {
    match shortcut.key {
        Code::Space => notch::capture(app),
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
        "menu" => workspace::on_menu(app, rest),
        "close" => {
            if let Some(window) = app.get_webview_window(rest) {
                let _ = window.close();
            }
        }
        "state" => {
            let workspace = app.get_webview_window(workspace::LABEL).and_then(|w| w.ns_window().ok());
            log(
                json!({"event": "state", "notch": notch::state(), "question": *app.state::<Host>().question.lock().unwrap(),
                "workspace": workspace.map(|w| native::ns_window_number(w as usize))}),
            )
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
        None => std::path::Path::new(&std::env::var_os("HOME").unwrap_or_default())
            .join("Library/Application Support/Tasktap Next"),
    }
}

fn main() {
    START.get_or_init(Instant::now);
    let app = tauri::Builder::default()
        .activate_ignoring_other_apps(false)
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, s, event| {
                    if event.state == ShortcutState::Pressed {
                        shortcut(app, s)
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![bridge_open, bridge_send, bridge_host, debug_report])
        .on_menu_event(|app, event| workspace::on_menu(app, event.id().as_ref()))
        .setup(|app| {
            let passive = std::env::var_os("TASKTAP_PASSIVE").is_some();
            notch::NOTCH.lock().unwrap().passive = passive;
            // In the Dock with a menu, as 1.2 was; a passive run (the checks) stays out of both.
            app.set_activation_policy(if passive {
                tauri::ActivationPolicy::Accessory
            } else {
                tauri::ActivationPolicy::Regular
            });
            let _ = APP.set(app.handle().clone());
            // The core this app bundles, next to its own program; a check may name another.
            let (exe, build) = match (std::env::var_os("TASKTAP_CORE_EXE"), std::env::var("TASKTAP_CORE_BUILD")) {
                (Some(exe), Ok(build)) => (exe.into(), build),
                _ => (std::env::current_exe()?.with_file_name("tasktap"), env!("TASKTAP_CORE_BUILD").to_owned()),
            };
            let core = Arc::new(Core::prepare(data_folder(), &exe, build)?);
            let handle = app.handle().clone();
            let link = Link::start(core.clone(), move |g| {
                let inner = handle.clone();
                let _ = handle.run_on_main_thread(move || glance(&inner, g.question));
            })?;
            workspace::start(app.handle(), core.data.clone());
            app.set_menu(workspace::menu(app.handle())?)?;
            app.manage(Host { core, link, pages: Mutex::default(), question: Mutex::default() });
            app.global_shortcut().register(keys(Code::Space))?;

            // Tauri's own window stays hidden; its web view moves into a real non-activating panel,
            // shown once the page asks: tao makes every window visible at launch key.
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
                let mut st = notch::NOTCH.lock().unwrap();
                st.panel = native::make_panel(webview.inner() as usize);
                notch::position(&handle, &mut st);
            })?;
            // A passive run (the checks) is driven by its debug channel alone: the person's own
            // pointer passing the notch must not open or hold it while a check reads it.
            if !notch::NOTCH.lock().unwrap().passive {
                let handle = app.handle().clone();
                native::watch_pointer(move || notch::moved(&handle));
            }

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
            log(json!({"event": "ready", "data": app.state::<Host>().core.data}));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tasktap Next failed to start");
    // Closing the workspace never quits: the notch's own (hidden) Tauri window stays open. The
    // Dock icon brings the workspace back; Quit in the menu ends the app.
    app.run(|app, event| match event {
        RunEvent::Reopen { .. } => drop(workspace::show(app, None)),
        RunEvent::ExitRequested { .. } => workspace::quit(),
        _ => {}
    });
}
