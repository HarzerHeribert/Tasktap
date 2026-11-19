//! The notch panel: where it sits, hover, opening and folding, and the keyboard. Ported from
//! trials/tauri-notch with the 80 ms pointer poll replaced by pointer events. The page decides
//! when to open and fold (`host.notch`); the host tells it what the pointer and keys did.
//!
//! On Windows the panel is the tab's window (`edge.rs`), on a display without a camera housing: the same page,
//! the same geometry, the same rules. There a display has its own scale, so a display's geometry is in its own
//! points and the pointer and the window are read in the anchor display's terms (`native::within`, `native::frame`).
use crate::geometry::{self, Geometry, Rect};
use crate::native;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct Notch {
    /// The panel; 0 while there is none (Windows, with the tab switched off or not made yet).
    pub panel: usize,
    anchor: Option<Rect>,
    frame: Rect,
    collapsed: bool,
    inside: bool,
    ignoring: bool,
    screens: usize,
    height: f64,
    wing: f64,
    /// The line under a collapsed notch with a cutout that says who asks and what.
    line: f64,
    /// The outline the page is drawing towards (shape.ts), from the tab's centre line and down
    /// from the top edge: the notch takes the pointer only inside it.
    hit: Vec<(f64, f64)>,
    generation: u64,
    /// Automated runs (TASKTAP_PASSIVE): the panel never takes the keyboard.
    pub passive: bool,
}

impl Notch {
    #[cfg(windows)]
    pub fn is_collapsed(&self) -> bool {
        self.collapsed
    }
}

pub static NOTCH: Mutex<Notch> = Mutex::new(Notch {
    panel: 0,
    anchor: None,
    frame: Rect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 },
    collapsed: true,
    inside: false,
    ignoring: true,
    screens: 1,
    height: 260.0,
    wing: 0.0,
    line: 0.0,
    hit: Vec::new(),
    generation: 0,
    passive: false,
});

/// Tells the notch page what happened: `{do: "hover-enter" | "hover-exit" | "capture" | ...}`.
pub fn tell(app: &AppHandle, what: Value) {
    let _ = app.emit_to("notch", "ui", what);
}

/// The anchor screen and its geometry, as main.swift's position() chooses it: the screen the notch is on, else
/// the one the pointer is on, else the first. None while the system has no screen at all.
fn anchored(st: &mut Notch) -> Option<(native::Screen, Geometry)> {
    let screens = native::screens();
    let (x, y, _) = native::pointer();
    st.screens = screens.len();
    let screen = (screens.iter().find(|s| Some(native::screen_frame(s)) == st.anchor))
        .or_else(|| screens.iter().find(|s| native::screen_frame(s).contains(x, y)))
        .or(screens.first())
        .cloned()?;
    st.anchor = Some(native::screen_frame(&screen));
    let g = native::geometry(&screen).widen(st.wing);
    Some((screen, g))
}

/// Places the panel for the notch's state. A window that grows does so at once; one that shrinks
/// keeps holding the old frame until the page has drawn the shape in (its fold takes 320 ms), so
/// neither the shape nor its light is cut at the window's edge on the way.
pub fn position(app: &AppHandle, st: &mut Notch) {
    if st.panel == 0 {
        return;
    }
    let Some((screen, g)) = anchored(st) else { return };
    let want = g.panel_frame(st.collapsed, if st.collapsed { st.line } else { st.height });
    let held = native::frame(st.panel, &screen);
    let same_place = held.max_y() == want.max_y() && g.screen.contains(held.mid_x(), held.max_y() - 0.5);
    let frame = if same_place { held.union(want) } else { want };
    st.generation += 1;
    if frame != want {
        let (generation, handle) = (st.generation, app.clone());
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(360));
            let inner = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                let mut st = NOTCH.lock().unwrap();
                if st.generation == generation && st.panel != 0 {
                    if let Some((screen, _)) = anchored(&mut st) {
                        native::set_frame(st.panel, &screen, want);
                    }
                    st.frame = want;
                    describe(&inner, &st, &g, want);
                }
            });
        });
    }
    native::set_frame(st.panel, &screen, frame);
    st.frame = frame;
    // The panel passes the pointer through until a move lands on the shape; a passive run's
    // never takes it at all.
    native::ignore_mouse(st.panel, st.ignoring || st.passive);
    // Windows: the outline under the tab that says when the pointer reaches it, whether a click gives the open
    // sheet the keyboard, and the pointer read while the sheet is open.
    native::outline(st.panel, &screen, &g, &st.hit);
    native::focusable(st.panel, !st.collapsed && !st.passive);
    native::watching(st.panel, st.inside || !st.collapsed);
    describe(app, st, &g, frame);
}

/// Tells the page where the tab and the open sheet are, from the frame on screen.
fn describe(app: &AppHandle, st: &Notch, g: &Geometry, frame: Rect) {
    let open = g.panel_frame(false, st.height);
    let side = geometry::FLARE + geometry::BLOOM;
    tell(
        app,
        json!({"do": "geometry", "width": g.tab.w, "height": g.tab.h, "cutout": g.cutout,
        "surfaceWidth": open.w - 2.0 * side, "surfaceOffset": open.mid_x() - g.tab.mid_x(), "span": open.w,
        "pixel": g.pixel, "corner": g.corner(), "offset": g.tab.mid_x() - frame.mid_x(),
        "available": g.available().max(1.0), "collapsed": st.collapsed}),
    );
}

/// Every pointer move or drag (main.swift's updateHover). With one screen and the pointer away
/// from the panel this returns after one read of the pointer. (On Windows it is called only while the pointer
/// is on the tab or the sheet is open: edge.rs.)
pub fn moved(app: &AppHandle) {
    let Ok(mut st) = NOTCH.try_lock() else { return };
    if st.panel == 0 {
        return;
    }
    let (x, y, dragging) = native::pointer();
    // The Mac's screens share one set of coordinates, and its notch goes to the screen whose top the pointer
    // touches. On Windows the tab stays on the display the setting names.
    if cfg!(target_os = "macos") {
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
    }
    let Some((screen, g)) = anchored(&mut st) else { return };
    let (x, y) = native::within(&screen, x, y);
    let top_band = y >= g.tab.y && y <= g.tab.max_y();
    let hit = !native::hidden(st.panel)
        && match st.hit.is_empty() {
            true => g.tab.contains(x, y),
            false => geometry::inside(&st.hit, x - g.tab.mid_x(), g.tab.max_y() - y),
        };
    // Open, the top edge beside the tab keeps the notch open; everywhere outside the outline,
    // and on the Mac's top edge beside the tab (its menu bar), the pointer and its clicks go to what is beneath.
    let inside = hit || (!st.collapsed && top_band && native::frame(st.panel, &screen).contains(x, y));
    st.ignoring = !hit || (cfg!(target_os = "macos") && top_band && !g.tab.contains(x, y));
    native::ignore_mouse(st.panel, st.ignoring);
    if dragging || inside == st.inside {
        return;
    }
    st.inside = inside;
    native::watching(st.panel, st.inside || !st.collapsed);
    tell(app, json!({"do": if inside { "hover-enter" } else { "hover-exit" }}));
}

/// `host.notch {open?, key?, height?, wing?, line?, hit?}` from the page.
pub fn request(app: &AppHandle, args: &Value) {
    let mut st = NOTCH.lock().unwrap();
    if st.panel == 0 {
        return;
    }
    if let Some(points) = args.get("hit").and_then(Value::as_array) {
        st.hit = points.chunks(2).filter_map(|p| Some((p.first()?.as_f64()?, p.get(1)?.as_f64()?))).collect();
        if args.as_object().is_some_and(|o| o.len() == 1) {
            #[cfg(windows)]
            if let Some((screen, g)) = anchored(&mut st) {
                native::outline(st.panel, &screen, &g, &st.hit);
                native::show(st.panel);
            }
            return;
        }
    }
    if let Some(h) = args.get("height").and_then(Value::as_f64) {
        st.height = h;
    }
    if let Some(w) = args.get("wing").and_then(Value::as_f64) {
        st.wing = w.clamp(0.0, 160.0);
    }
    if let Some(l) = args.get("line").and_then(Value::as_f64) {
        st.line = l.clamp(0.0, 40.0);
    }
    match args.get("open").and_then(Value::as_bool) {
        Some(true) => open(app, &mut st, args.get("key").and_then(Value::as_bool).unwrap_or(false)),
        Some(false) => fold(app, &mut st),
        None => position(app, &mut st),
    }
    native::show(st.panel);
}

pub fn open(app: &AppHandle, st: &mut Notch, key: bool) {
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
    st.collapsed = true;
    position(app, st);
    // Windows: a sheet the key opened on the display under the pointer folds there, and the tab is then back on
    // the display the setting names.
    #[cfg(windows)]
    if native::home().is_some_and(|home| Some(home) != st.anchor) {
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(380));
            let inner = handle.clone();
            let _ = handle.run_on_main_thread(move || place(&inner));
        });
    }
}

/// The capture shortcut: open with the keyboard in the field.
pub fn capture(app: &AppHandle) {
    let mut st = NOTCH.lock().unwrap();
    if st.panel == 0 {
        return;
    }
    st.anchor = None;
    open(app, &mut st, true);
    tell(app, json!({"do": "capture"}));
}

/// The answer shortcut: open on the waiting question with the keyboard.
pub fn answer(app: &AppHandle) {
    let mut st = NOTCH.lock().unwrap();
    if st.panel == 0 {
        return;
    }
    open(app, &mut st, true);
    tell(app, json!({"do": "answer"}));
}

/// Windows: the tab's window is made. It hangs collapsed on the display the setting names.
#[cfg(windows)]
pub fn adopt(app: &AppHandle, panel: usize) {
    let mut st = NOTCH.lock().unwrap();
    st.panel = panel;
    (st.collapsed, st.inside, st.ignoring) = (true, false, true);
    (st.wing, st.line, st.height) = (0.0, 0.0, 260.0);
    st.hit.clear();
    st.anchor = native::home();
    position(app, &mut st);
}

/// Windows: the tab's window is gone (the setting says no tab).
#[cfg(windows)]
pub fn orphan() {
    if let Ok(mut st) = NOTCH.try_lock() {
        st.panel = 0;
        (st.collapsed, st.inside, st.ignoring) = (true, false, true);
        st.generation += 1;
    }
}

/// Windows: the displays, the taskbar, the scale or the setting changed, or Windows says to hide the tab or
/// to show it again. A collapsed tab goes to the display the setting names; an open sheet stays where it is.
#[cfg(windows)]
pub fn place(app: &AppHandle) {
    let Ok(mut st) = NOTCH.try_lock() else { return };
    if st.panel == 0 {
        return;
    }
    if st.collapsed {
        st.anchor = native::home();
    }
    position(app, &mut st);
    native::show(st.panel);
}

pub fn state() -> Value {
    let mut st = NOTCH.lock().unwrap();
    if st.panel == 0 {
        return Value::Null;
    }
    let Some((screen, _)) = anchored(&mut st) else { return Value::Null };
    let f = native::frame(st.panel, &screen);
    json!({"collapsed": st.collapsed, "key": native::is_key(st.panel), "frame": [f.x, f.y, f.w, f.h],
        "window": native::window_number(st.panel), "wing": st.wing, "active": native::app_active()})
}
