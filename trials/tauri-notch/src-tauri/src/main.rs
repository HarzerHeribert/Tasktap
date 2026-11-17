mod geometry;
mod native;

use base64::Engine;
use serde_json::{json, Value};
use std::{io::BufRead, sync::Mutex, thread, time::Duration};
use tauri::{ipc::{Channel, InvokeResponseBody}, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri::utils::{config::WindowEffectsConfig, WindowEffect, WindowEffectState};
use objc2::MainThreadMarker;

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");
const PAGE: &str = "trial://localhost/trials/tauri-notch/ui/";

struct Notch { panel: usize, anchor: Option<geometry::Rect>, collapsed: bool, inside: bool, height: f64, generation: u64, ready: bool }
static NOTCH: Mutex<Notch> = Mutex::new(Notch { panel: 0, anchor: None, collapsed: true, inside: false, height: 260.0, generation: 0, ready: false });

fn log(value: Value) { println!("{value}") }
fn mtm() -> MainThreadMarker { MainThreadMarker::new().expect("main thread") }
fn eval(app: &AppHandle, js: &str) { if let Some(w) = app.get_webview_window("notch") { let _ = w.eval(js); } }

/// The anchor screen's geometry, as main.swift's position() chooses it.
fn anchored(st: &mut Notch) -> geometry::Geometry {
    let screens = native::screens(mtm());
    let (x, y, _) = native::pointer();
    let screen = screens.iter().find(|s| Some(native::screen_frame(s)) == st.anchor)
        .or_else(|| screens.iter().find(|s| native::screen_frame(s).contains(x, y))).unwrap_or(&screens[0]);
    st.anchor = Some(native::screen_frame(screen));
    native::geometry(screen)
}

fn position(app: &AppHandle, st: &mut Notch) {
    let g = anchored(st);
    let frame = g.panel_frame(st.collapsed, st.height, 432.0);
    native::set_frame(st.panel, frame);
    let open = g.panel_frame(false, st.height, 432.0);
    let m = json!({"width": g.tab.w, "height": g.tab.h, "shoulder": geometry::SHOULDER, "compact": g.compact() as u8,
        "surfaceWidth": open.w - 2.0 * geometry::SHOULDER, "surfaceOffset": open.mid_x() - g.tab.mid_x(), "pixel": g.pixel,
        "corner": g.corner(), "rimOffset": g.rim_offset(), "offset": g.tab.mid_x() - frame.mid_x(), "available": g.available().max(1.0),
        "tabLeft": g.tab.x - frame.x, "frameWidth": frame.w, "frameHeight": frame.h, "collapsed": st.collapsed});
    eval(app, &format!("trial.geometry({m})"));
}

/// Port of main.swift updateHover(at:dragging:), driven by the same 80 ms pointer poll.
fn tick(app: &AppHandle) {
    let mut st = NOTCH.lock().unwrap();
    if !st.ready { return }
    let (x, y, dragging) = native::pointer();
    if st.collapsed && !dragging {
        if let Some(s) = native::screens(mtm()).iter().find(|s| Some(native::screen_frame(s)) != st.anchor
            && native::geometry(s).panel_frame(true, 0.0, 432.0).contains(x, y)) {
            st.anchor = Some(native::screen_frame(s));
            position(app, &mut st);
        }
    }
    let g = anchored(&mut st);
    let top_band = y >= g.tab.y && y <= g.tab.max_y();
    let inside = g.contains(x, y, native::frame(st.panel), st.collapsed);
    native::ignore_mouse(st.panel, !inside || (top_band && !g.tab.contains(x, y)));
    if dragging {
        if inside && !st.inside { log(json!({"event": "drag-cross", "x": x, "y": y})) }
        return;
    }
    if inside == st.inside { return }
    st.inside = inside;
    st.generation += 1;
    log(json!({"event": "hover", "inside": inside, "focus": native::focus(mtm(), st.panel)}));
    if inside { reveal(app, &mut st, "trial.hover(true)") } else { fold(app, &mut st) }
}

fn show(app: &AppHandle, st: &mut Notch) {
    position(app, st);
    native::panel(st.panel).orderFrontRegardless();
}

fn reveal(app: &AppHandle, st: &mut Notch, js: &str) {
    st.collapsed = false;
    position(app, st);
    eval(app, js);
}

fn fold(app: &AppHandle, st: &mut Notch) {
    eval(app, "trial.hover(false)");
    let (generation, handle) = (st.generation, app.clone());
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(360));
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let mut st = NOTCH.lock().unwrap();
            if st.generation != generation || st.inside { return }
            st.collapsed = true;
            position(&inner, &mut st);
            let handed_back = native::give_back_key(st.panel);
            log(json!({"event": "folded", "handedBackKey": handed_back, "focus": native::focus(mtm(), st.panel)}));
        });
    });
}

/// Commands on stdin let check.sh drive the trial: capture, rim on|off, glow on|off, probe, quit.
fn command(app: &AppHandle, line: &str) {
    let mut st = NOTCH.lock().unwrap();
    match line {
        "capture" => {
            st.anchor = None;
            reveal(app, &mut st, "trial.capture()");
            native::make_key(st.panel);
            log(json!({"event": "capture", "focus": native::focus(mtm(), st.panel)}));
        }
        "close" => { st.inside = false; st.generation += 1; fold(app, &mut st) }
        "rim on" | "rim off" | "glow on" | "glow off" => {
            let (what, on) = line.split_once(' ').unwrap();
            eval(app, &format!("trial.{what}({})", on == "on"));
        }
        "backdrop front" => if let Some(w) = app.get_webview_window("backdrop") { native::order_front(w.ns_window().unwrap() as usize) },
        "probe" => log(json!({"event": "probe", "panel": native::probe(st.panel), "focus": native::focus(mtm(), st.panel)})),
        "quit" => app.exit(0),
        _ => log(json!({"event": "unknown-command", "line": line})),
    }
}

#[tauri::command]
fn ready(app: AppHandle, webview: tauri::WebviewWindow) {
    if webview.label() != "notch" { return }
    let mut st = NOTCH.lock().unwrap();
    st.ready = true;
    if st.panel == 0 { return }
    show(&app, &mut st);
    let lines: Vec<String> = native::screens(mtm()).iter().enumerate()
        .map(|(i, s)| native::geometry(s).line(&format!("screen{i}"))).collect();
    log(json!({"event": "ready", "panel": native::probe(st.panel), "focus": native::focus(mtm(), st.panel), "screens": lines,
        "reduceTransparency": native::reduce_transparency()}));
}

#[tauri::command]
fn bounds(app: AppHandle, height: f64) {
    let mut st = NOTCH.lock().unwrap();
    st.height = height;
    if !st.collapsed { position(&app, &mut st) }
}

#[tauri::command]
fn typed(app: AppHandle, text: String) {
    let mut st = NOTCH.lock().unwrap();
    log(json!({"event": "typed", "text": text, "focus": native::focus(mtm(), st.panel)}));
    st.inside = false;
    st.generation += 1;
    fold(&app, &mut st);
}

#[tauri::command]
fn report(app: AppHandle, kind: String, data: Value) {
    log(json!({"event": kind, "data": data}));
    if kind == "bench" { app.exit(0) }
}

// Pass-through measurements. Each pushes `frames` frames of `size` bytes as fast as the mechanism allows.
#[tauri::command]
async fn push_channel(frames: u32, size: usize, sink: Channel<InvokeResponseBody>) {
    let frame = vec![b'a'; size];
    for _ in 0..frames { let _ = sink.send(InvokeResponseBody::Raw(frame.clone())); }
}

#[tauri::command]
async fn push_event(app: AppHandle, frames: u32, size: usize, encoding: String) {
    let frame = vec![b'a'; size];
    let text = base64::engine::general_purpose::STANDARD.encode(&frame);
    for _ in 0..frames {
        let _ = if encoding == "base64" { app.emit_to("notch", "frame", &text) } else { app.emit_to("notch", "frame", &frame) };
    }
}

#[tauri::command]
fn key(k: String) -> String { k }

#[tauri::command]
fn key_event(app: AppHandle, k: String) { let _ = app.emit_to("notch", "echo", k); }

fn serve(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let uri = request.uri();
    let path = uri.path().trim_start_matches('/');
    if path == "bytes" {
        let n: usize = uri.query().and_then(|q| q.strip_prefix("n=")).and_then(|n| n.parse().ok()).unwrap_or(0);
        return tauri::http::Response::builder().header("Content-Type", "application/octet-stream").body(vec![b'a'; n]).unwrap();
    }
    // Serve only the trial page and the existing prototype styles, straight from the repository.
    let allowed = (path.starts_with("trials/tauri-notch/ui/") || path.starts_with("prototype/")) && !path.contains("..");
    let file = if allowed { std::fs::read(format!("{ROOT}/{path}")).ok() } else { None };
    let mime = match path.rsplit('.').next() { Some("html") => "text/html", Some("css") => "text/css", Some("js") => "text/javascript", Some("svg") => "image/svg+xml", Some("woff2") => "font/woff2", _ => "application/octet-stream" };
    match file {
        Some(body) => tauri::http::Response::builder().header("Content-Type", mime).body(body).unwrap(),
        None => tauri::http::Response::builder().status(404).body(Vec::new()).unwrap(),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--geometry") {
        for (name, g) in geometry::cases() { println!("{}", g.line(&name)) }
        return;
    }
    let bench = args.iter().any(|a| a == "--bench");
    let backdrop = args.iter().any(|a| a == "--backdrop");
    tauri::Builder::default()
        .activate_ignoring_other_apps(false)
        .register_asynchronous_uri_scheme_protocol("trial", |_ctx, request, responder| {
            thread::spawn(move || responder.respond(serve(request)));
        })
        .invoke_handler(tauri::generate_handler![ready, bounds, typed, report, push_channel, push_event, key, key_event])
        .setup(move |app| {
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let page = if bench { "bench.html" } else { "notch.html" };
            let window = WebviewWindowBuilder::new(app, "notch", WebviewUrl::CustomProtocol(format!("{PAGE}{page}").parse()?))
                .decorations(false).transparent(true).shadow(false).resizable(false).focused(false).visible(false)
                .accept_first_mouse(true).visible_on_all_workspaces(true).inner_size(246.0, 54.0)
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .build()?;
            // Tauri's own window stays hidden; its web view moves into a real non-activating panel.
            let handle = app.handle().clone();
            window.with_webview(move |webview| {
                let mut st = NOTCH.lock().unwrap();
                st.panel = native::make_panel(mtm(), webview.inner() as usize);
                if st.ready || bench { show(&handle, &mut st) }
            })?;
            if backdrop {
                // Item 4: the workspace backdrop, NSVisualEffectView behind window, through Tauri's own window effects.
                let effects = (!native::reduce_transparency()).then(|| WindowEffectsConfig {
                    effects: vec![WindowEffect::UnderWindowBackground], state: Some(WindowEffectState::FollowsWindowActiveState), radius: None, color: None, ..Default::default() });
                WebviewWindowBuilder::new(app, "backdrop", WebviewUrl::CustomProtocol(format!("{PAGE}backdrop.html").parse()?))
                    .title("Backdrop trial").inner_size(520.0, 320.0).position(120.0, 160.0).transparent(true)
                    .title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true).focused(false).effects(effects.unwrap_or_default())
                    .build()?;
            }
            let handle = app.handle().clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_millis(80));
                let inner = handle.clone();
                if handle.run_on_main_thread(move || tick(&inner)).is_err() { break }
            });
            let handle = app.handle().clone();
            thread::spawn(move || for line in std::io::stdin().lock().lines().map_while(Result::ok) {
                let inner = handle.clone();
                let _ = handle.run_on_main_thread(move || command(&inner, line.trim()));
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("trial failed to start");
}
