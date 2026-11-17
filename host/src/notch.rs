//! The notch panel: where it sits, hover, opening and folding, and the keyboard. Ported from
//! trials/tauri-notch with the 80 ms pointer poll replaced by pointer events. The page decides
//! when to open and fold (`host.notch`); the host tells it what the pointer and keys did.
use crate::geometry::{self, Geometry, Rect};
use crate::native;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct Notch {
    pub panel: usize,
    anchor: Option<Rect>,
    frame: Rect,
    collapsed: bool,
    inside: bool,
    ignoring: bool,
    screens: usize,
    height: f64,
    wing: f64,
    generation: u64,
    /// Automated runs (TASKTAP_PASSIVE): the panel never takes the keyboard.
    pub passive: bool,
}

pub static NOTCH: Mutex<Notch> = Mutex::new(Notch {
    panel: 0,
    anchor: None,
    frame: Rect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 },
    collapsed: true,
    inside: false,
    ignoring: false,
    screens: 1,
    height: 260.0,
    wing: 0.0,
    generation: 0,
    passive: false,
});

/// Tells the notch page what happened: `{do: "hover-enter" | "hover-exit" | "capture" | ...}`.
pub fn tell(app: &AppHandle, what: Value) {
    let _ = app.emit_to("notch", "ui", what);
}

/// The anchor screen's geometry, as main.swift's position() chooses it.
fn anchored(st: &mut Notch) -> Geometry {
    let screens = native::screens();
    let (x, y, _) = native::pointer();
    st.screens = screens.len();
    let screen = (screens.iter().find(|s| Some(native::screen_frame(s)) == st.anchor))
        .or_else(|| screens.iter().find(|s| native::screen_frame(s).contains(x, y)))
        .unwrap_or(&screens[0]);
    st.anchor = Some(native::screen_frame(screen));
    native::geometry(screen).widen(st.wing)
}

pub fn position(app: &AppHandle, st: &mut Notch) {
    if st.panel == 0 {
        return;
    }
    let g = anchored(st);
    let frame = g.panel_frame(st.collapsed, st.height);
    native::set_frame(st.panel, frame);
    st.frame = frame;
    let open = g.panel_frame(false, st.height);
    tell(
        app,
        json!({"do": "geometry", "width": g.tab.w, "height": g.tab.h, "shoulder": geometry::SHOULDER,
        "compact": g.compact(), "surfaceWidth": open.w - 2.0 * geometry::SHOULDER,
        "surfaceOffset": open.mid_x() - g.tab.mid_x(), "pixel": g.pixel, "corner": g.corner(),
        "rimOffset": g.rim_offset(), "offset": g.tab.mid_x() - frame.mid_x(), "available": g.available().max(1.0),
        "tabLeft": g.tab.x - frame.x, "frameWidth": frame.w, "frameHeight": frame.h, "collapsed": st.collapsed}),
    );
}

/// Every pointer move or drag (main.swift's updateHover). With one screen and the pointer away
/// from the panel this returns after one read of the pointer.
pub fn moved(app: &AppHandle) {
    let mut st = NOTCH.lock().unwrap();
    if st.panel == 0 {
        return;
    }
    let (x, y, dragging) = native::pointer();
    let near = Rect { x: st.frame.x - 4.0, y: st.frame.y - 4.0, w: st.frame.w + 8.0, h: st.frame.h + 8.0 };
    if !st.inside && st.ignoring && st.screens == 1 && !near.contains(x, y) {
        return;
    }
    if st.collapsed && !dragging {
        let other = native::screens().into_iter().find(|s| {
            Some(native::screen_frame(s)) != st.anchor && native::geometry(s).panel_frame(true, 0.0).contains(x, y)
        });
        if let Some(s) = other {
            st.anchor = Some(native::screen_frame(&s));
            position(app, &mut st);
        }
    }
    let g = anchored(&mut st);
    let top_band = y >= g.tab.y && y <= g.tab.max_y();
    let inside = g.contains(x, y, native::frame(st.panel), st.collapsed);
    st.ignoring = !inside || (top_band && !g.tab.contains(x, y));
    native::ignore_mouse(st.panel, st.ignoring);
    if dragging || inside == st.inside {
        return;
    }
    st.inside = inside;
    tell(app, json!({"do": if inside { "hover-enter" } else { "hover-exit" }}));
}

/// `host.notch {open?, key?, height?, wing?}` from the page.
pub fn request(app: &AppHandle, args: &Value) {
    let mut st = NOTCH.lock().unwrap();
    if let Some(h) = args.get("height").and_then(Value::as_f64) {
        st.height = h;
    }
    if let Some(w) = args.get("wing").and_then(Value::as_f64) {
        st.wing = w.clamp(0.0, 160.0);
    }
    match args.get("open").and_then(Value::as_bool) {
        Some(true) => open(app, &mut st, args.get("key").and_then(Value::as_bool).unwrap_or(false)),
        Some(false) => fold(app, &mut st),
        None => position(app, &mut st),
    }
    native::show(st.panel);
}

pub fn open(app: &AppHandle, st: &mut Notch, key: bool) {
    st.generation += 1;
    st.collapsed = false;
    position(app, st);
    native::show(st.panel);
    if key && !st.passive {
        native::make_key(st.panel);
    }
}

/// The keyboard goes back to the app in use at once; the frame shrinks once the page's fold
/// animation (320 ms) is over.
fn fold(app: &AppHandle, st: &mut Notch) {
    native::give_back_key(st.panel);
    st.generation += 1;
    let (generation, handle) = (st.generation, app.clone());
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(360));
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let mut st = NOTCH.lock().unwrap();
            if st.generation == generation {
                st.collapsed = true;
                position(&inner, &mut st);
            }
        });
    });
}

/// The capture shortcut: open with the keyboard in the field.
pub fn capture(app: &AppHandle) {
    let mut st = NOTCH.lock().unwrap();
    st.anchor = None;
    open(app, &mut st, true);
    tell(app, json!({"do": "capture"}));
}

/// The answer shortcut: open on the waiting question with the keyboard.
pub fn answer(app: &AppHandle) {
    let mut st = NOTCH.lock().unwrap();
    open(app, &mut st, true);
    tell(app, json!({"do": "answer"}));
}

pub fn state() -> Value {
    let st = NOTCH.lock().unwrap();
    if st.panel == 0 {
        return Value::Null;
    }
    let f = native::frame(st.panel);
    json!({"collapsed": st.collapsed, "key": native::is_key(st.panel), "frame": [f.x, f.y, f.w, f.h],
        "window": native::window_number(st.panel), "wing": st.wing, "active": native::app_active()})
}
