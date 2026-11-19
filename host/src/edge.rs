//! The tab on Windows: what `native.rs` is to the Mac's notch panel (plan, "The notch on Windows"). The same page
//! (`notch.html`) in a window of Tauri's that hangs from the top edge of a display, placed by the same `notch.rs`
//! through the arithmetic of `tab.rs`. What Windows needs that the Mac does not:
//!
//! - **The window.** Frameless, transparent, above every window, with no taskbar button, no place in Alt+Tab, no
//!   shadow, corner or animation of the system's, and never activated by being shown. Tauri's own setters would
//!   put its styles back and show it with `SW_SHOW`, which activates, so after it is made its styles, place and
//!   showing are set here directly and never through Tauri.
//! - **The pointer.** Windows lets the pointer through a whole window or none of it. At rest the window lets it
//!   through everywhere. Under the tab lies a second window that draws nothing and has the outline's own shape
//!   (a window region, from the outline the page sends): the system tells it when the pointer reaches the tab, and
//!   until then nothing of this app runs. From that moment, and while the sheet is open, a timer reads the pointer
//!   sixty times a second against the outline, as the Mac's pointer events do, and the window takes the pointer
//!   inside the outline and lets it through outside; the timer ends when the pointer has left a collapsed tab.
//! - **The keyboard.** The capture key, the answer key and the icon open the sheet with the keyboard: the window
//!   is made the one in front, which Windows allows after a hot key or a click on the icon, and the window that was
//!   in front gets the keyboard back at the fold. Open, a click on the sheet gives it the keyboard as a click on any
//!   window does; collapsed, nothing ever does. When the keyboard goes elsewhere the page is told (`away`): the
//!   timer that reads the pointer for an open sheet also looks at which window is in front.
//! - **Staying out of the way.** While Windows says a full-screen window, a presentation or an exclusive Direct3D
//!   program is in front, or nobody is at the desktop (`SHQueryUserNotificationState`), the tab is hidden; a sheet
//!   the person asked for with the key still shows. The state is asked for when the window in front changes and when
//!   the shell says a full-screen window came or went, never on a timer. The lock screen is another desktop: no
//!   window of this one is drawn there.
//! - **One helper window** that is never shown hears what the shell and the system say: the icon's clicks, a new
//!   taskbar, displays, the work area, the scale, the colour mode.
use crate::geometry::{Geometry, Rect};
use crate::notch::{self, NOTCH};
use crate::tab::Display;
use crate::{tray, workspace};
use serde_json::{json, Value};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicIsize, AtomicU32, Ordering::Relaxed};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_TRANSITIONS_FORCEDISABLED, DWMWA_WINDOW_CORNER_PREFERENCE,
    DWMWCP_DONOTROUND,
};
use windows_sys::Win32::Graphics::Gdi::{
    CreatePolygonRgn, EnumDisplayMonitors, GetMonitorInfoW, GetStockObject, SetWindowRgn, ALTERNATE, BLACK_BRUSH, HDC,
    HMONITOR, MONITORINFOEXW,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentProcessId;
use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON};
use windows_sys::Win32::UI::Shell::{
    DefSubclassProc, RemoveWindowSubclass, SHAppBarMessage, SHQueryUserNotificationState, SetWindowSubclass, ABM_NEW,
    ABM_REMOVE, ABN_FULLSCREENAPP, APPBARDATA, NIN_BALLOONUSERCLICK, NIN_SELECT, QUNS_BUSY, QUNS_NOT_PRESENT,
    QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetClassNameW, GetCursorPos, GetForegroundWindow, GetMessageTime, GetShellWindow,
    GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, KillTimer,
    PostMessageW, RegisterClassExW, RegisterWindowMessageW, SetForegroundWindow, SetLayeredWindowAttributes, SetTimer,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, EVENT_SYSTEM_FOREGROUND, GWL_EXSTYLE, GWL_STYLE, HWND_TOPMOST,
    LWA_ALPHA, MA_NOACTIVATE, MONITORINFOF_PRIMARY, SPI_SETWORKAREA, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, WA_INACTIVE, WINEVENT_OUTOFCONTEXT,
    WM_ACTIVATE, WM_APP, WM_CLOSE, WM_CONTEXTMENU, WM_DISPLAYCHANGE, WM_DPICHANGED, WM_LBUTTONDOWN, WM_MOUSEACTIVATE,
    WM_MOUSEMOVE, WM_NCDESTROY, WM_SETTINGCHANGE, WM_TIMER, WNDCLASSEXW, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
    WS_EX_APPWINDOW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
    WS_EX_WINDOWEDGE, WS_POPUP, WS_VISIBLE,
};

/// The notch page's window, as Tauri knows it.
const LABEL: &str = "notch";
/// The key of the icon when it is chosen with the keyboard: `NIN_SELECT` with the flag for a key.
const NIN_KEYSELECT: u32 = NIN_SELECT | 1;
/// What the helper window is told: by the shell about the icon and about full-screen windows, and by this file's
/// own windows when what they heard needs the notch, which may be busy at that moment.
const TRAY: u32 = WM_APP + 1;
const APPBAR: u32 = WM_APP + 2;
const AWAY: u32 = WM_APP + 3;
const PLACE: u32 = WM_APP + 4;
/// Another window came in front: whether it is the workspace's (presence.rs).
const FRONT: u32 = WM_APP + 5;
/// The helper's timers: the pointer while it is on the tab or the sheet is open, one more look at what the
/// shell says after the window in front changed,
const WATCH: usize = 1;
const AGAIN: usize = 2;
/// And the moment the tab's window is made, a little after the workspace's window is shown.
const MAKE: usize = 3;

static HELPER: AtomicIsize = AtomicIsize::new(0);
static STRIP: AtomicIsize = AtomicIsize::new(0);
static TAB: AtomicIsize = AtomicIsize::new(0);
/// The strip has a shape to take the pointer with.
static SHAPED: AtomicBool = AtomicBool::new(false);
/// The window the keyboard goes back to, and the last one in front that is neither the tab nor the taskbar.
static PRIOR: AtomicIsize = AtomicIsize::new(0);
static FOREIGN: AtomicIsize = AtomicIsize::new(0);
/// Windows says not to show the tab now.
static BUSY: AtomicBool = AtomicBool::new(false);
static WATCHING: AtomicBool = AtomicBool::new(false);
/// For how many looks of the watch the tab's window, which was the one in front, has not been: at the second the
/// keyboard has left it. Below zero, it was not in front.
static LEFT: AtomicI32 = AtomicI32::new(-1);
/// A dialog of the tab's own is open: the keyboard is with it, not elsewhere.
static PICKING: AtomicBool = AtomicBool::new(false);
/// A check's run: no icon, no strip, no timer, and the tab is never hidden.
static PASSIVE: AtomicBool = AtomicBool::new(false);
/// The pointer as the timer last read it: x, y, and whether a button was down.
static SEEN: [AtomicI32; 3] = [AtomicI32::new(i32::MIN), AtomicI32::new(0), AtomicI32::new(0)];
/// The message Explorer sends every window when its taskbar is made anew.
static TASKBAR: AtomicU32 = AtomicU32::new(0);
/// When the icon was last chosen: the Return key is told twice.
static CHOSEN: AtomicU32 = AtomicU32::new(0);

pub type Screen = Display;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}
fn helper() -> HWND {
    HELPER.load(Relaxed) as HWND
}
fn post(message: u32) {
    // SAFETY: a message to a window of this app; nothing is passed by address.
    unsafe { PostMessageW(helper(), message, 0, 0) };
}

// ---------------------------------------------------------------------------------------------
// The displays.

struct Monitor {
    /// The system's own name for it (`\\.\DISPLAY1`): what the setting keeps for a named display.
    name: String,
    primary: bool,
    display: Display,
}

fn monitors() -> Vec<Monitor> {
    unsafe extern "system" fn each(monitor: HMONITOR, _: HDC, _: *mut RECT, all: LPARAM) -> BOOL {
        let all = &mut *(all as *mut Vec<Monitor>);
        let mut info: MONITORINFOEXW = std::mem::zeroed();
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(monitor, (&raw mut info).cast()) != 0 {
            let (mut dpi, mut other) = (96u32, 96u32);
            GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi, &mut other);
            let pixels = |r: RECT| [r.left as f64, r.top as f64, (r.right - r.left) as f64, (r.bottom - r.top) as f64];
            let named = info.szDevice.iter().position(|c| *c == 0).unwrap_or(info.szDevice.len());
            all.push(Monitor {
                name: String::from_utf16_lossy(&info.szDevice[..named]),
                primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
                display: Display {
                    area: pixels(info.monitorInfo.rcMonitor),
                    work: pixels(info.monitorInfo.rcWork),
                    scale: dpi.max(24) as f64 / 96.0,
                },
            });
        }
        1
    }
    let mut all: Vec<Monitor> = Vec::new();
    // SAFETY: `each` is called during the call, with the list this call lends it.
    unsafe { EnumDisplayMonitors(null_mut(), null(), Some(each), (&raw mut all) as LPARAM) };
    all
}

pub fn screens() -> Vec<Display> {
    monitors().into_iter().map(|m| m.display).collect()
}
/// A display's place among the displays, in pixels: what tells one from another.
pub fn screen_frame(d: &Display) -> Rect {
    let [x, y, w, h] = d.area;
    Rect { x, y, w, h }
}
pub fn geometry(d: &Display) -> Geometry {
    d.geometry()
}
/// The display the collapsed tab hangs on, by the setting: the main one, a named one (the main one while that is
/// not connected), or none for "the one the pointer is on", which is wherever the tab was last opened.
pub fn home() -> Option<Rect> {
    let all = monitors();
    let main = || all.iter().find(|m| m.primary).or(all.first());
    match workspace::tab().as_str() {
        "pointer" => None,
        "main" | "off" => main(),
        name => all.iter().find(|m| m.name == name).or_else(main),
    }
    .map(|m| screen_frame(&m.display))
}

/// The pointer among the displays, in pixels, and whether a button is held.
pub fn pointer() -> (f64, f64, bool) {
    let mut at = POINT { x: 0, y: 0 };
    // SAFETY: `at` is a valid place for the point; the keys are asked for by number.
    unsafe {
        GetCursorPos(&mut at);
        let down = [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON].iter().any(|key| GetAsyncKeyState(i32::from(*key)) < 0);
        (f64::from(at.x), f64::from(at.y), down)
    }
}
/// A point among the displays in a display's own geometry.
pub fn within(d: &Display, x: f64, y: f64) -> (f64, f64) {
    d.point(x, y)
}

// ---------------------------------------------------------------------------------------------
// The tab's window, as notch.rs asks for it.

fn pixels(window: HWND) -> [i32; 4] {
    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    // SAFETY: `r` is a valid place for the rectangle; a window that is gone leaves it empty.
    unsafe { GetWindowRect(window, &mut r) };
    [r.left, r.top, r.right - r.left, r.bottom - r.top]
}
pub fn frame(panel: usize, d: &Display) -> Rect {
    d.rect(pixels(panel as HWND))
}
pub fn set_frame(panel: usize, d: &Display, r: Rect) {
    let window = panel as HWND;
    let [x, y, w, h] = d.place(r);
    if !window.is_null() && pixels(window) != [x, y, w, h] {
        // SAFETY: a window of this app; neither its order nor who has the keyboard changes.
        unsafe { SetWindowPos(window, null_mut(), x, y, w, h, SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER) };
    }
}

fn styles(window: HWND, set: u32, clear: u32) {
    // SAFETY: a window of this app; only its extended styles are read and written.
    unsafe {
        let now = GetWindowLongPtrW(window, GWL_EXSTYLE) as u32;
        let want = (now | set) & !clear;
        if !window.is_null() && want != now {
            SetWindowLongPtrW(window, GWL_EXSTYLE, want as isize);
        }
    }
}
/// Lets the pointer and its clicks through the whole window, or takes them.
pub fn ignore_mouse(panel: usize, ignore: bool) {
    let (set, clear) = if ignore { (WS_EX_TRANSPARENT, 0) } else { (0, WS_EX_TRANSPARENT) };
    styles(panel as HWND, set, clear);
}
/// Whether a click on the window gives it the keyboard: open, as a click on any window does; collapsed, never.
pub fn focusable(panel: usize, on: bool) {
    let (set, clear) = if on { (0, WS_EX_NOACTIVATE) } else { (WS_EX_NOACTIVATE, 0) };
    styles(panel as HWND, set, clear);
}

/// Shows the tab above every window without giving it the keyboard, with the strip under it; or hides both while
/// Windows says not to show it and the person did not ask for it with the key.
pub fn show(panel: usize) {
    let (tab, strip) = (panel as HWND, STRIP.load(Relaxed) as HWND);
    if tab.is_null() {
        return;
    }
    let shown = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW;
    // SAFETY: windows of this app, shown, hidden and ordered; none is activated.
    unsafe {
        if hidden(panel) {
            if IsWindowVisible(tab) != 0 {
                ShowWindow(tab, SW_HIDE);
            }
            ShowWindow(strip, SW_HIDE);
            return;
        }
        SetWindowPos(tab, HWND_TOPMOST, 0, 0, 0, 0, shown);
        if SHAPED.load(Relaxed) && !PASSIVE.load(Relaxed) {
            SetWindowPos(strip, tab, 0, 0, 0, 0, shown);
        }
    }
}

/// Whether the tab is hidden now: Tasktap's window is in front (presence.rs), or Windows says not to show it and it
/// is not a sheet the person asked for with the key. Hidden, the pointer where the tab would be is on nothing.
pub fn hidden(panel: usize) -> bool {
    // SAFETY: asks which window is in front.
    crate::presence::front() || (BUSY.load(Relaxed) && unsafe { GetForegroundWindow() } != panel as HWND)
}

/// Whether a window is the taskbar or the notification area's overflow: in front for the moment of a click on the
/// icon, and never where the keyboard should go back to.
fn bar(window: HWND) -> bool {
    let mut name = [0u16; 64];
    // SAFETY: `name` is as long as the call is told.
    let n = unsafe { GetClassNameW(window, name.as_mut_ptr(), name.len() as i32) }.max(0) as usize;
    let name = String::from_utf16_lossy(&name[..n]);
    name.starts_with("Shell_") || name.contains("Overflow")
}

/// The sheet opened with the keyboard: the window in front, as Windows allows after a hot key or a click on the
/// icon, and whoever was in front remembered.
pub fn make_key(panel: usize) {
    let tab = panel as HWND;
    if tab.is_null() {
        return;
    }
    // SAFETY: windows are only asked about, and this app's own is shown and put in front.
    unsafe {
        let front = GetForegroundWindow();
        if front != tab {
            let prior = if front.is_null() || bar(front) { FOREIGN.load(Relaxed) } else { front as isize };
            PRIOR.store(prior, Relaxed);
        }
        focusable(panel, true);
        SetWindowPos(tab, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        SetForegroundWindow(tab);
    }
}
pub fn is_key(panel: usize) -> bool {
    // SAFETY: asks which window is in front.
    panel != 0 && unsafe { GetForegroundWindow() } == panel as HWND
}
/// The keyboard goes back to the window that had it; when that is gone, to nobody (the desktop).
pub fn give_back_key(panel: usize) {
    if !is_key(panel) {
        return;
    }
    let prior = PRIOR.load(Relaxed) as HWND;
    // The sheet is folding by itself: the keyboard is handed back, not lost.
    LEFT.store(-1, Relaxed);
    // SAFETY: windows are only asked about, and one is put in front, which this app may while it is in front.
    unsafe {
        let there = IsWindow(prior) != 0 && IsWindowVisible(prior) != 0 && IsIconic(prior) == 0;
        SetForegroundWindow(if there { prior } else { GetShellWindow() });
    }
}
/// The window's handle, for a check to find it by.
pub fn window_number(panel: usize) -> isize {
    panel as isize
}
/// Whether the window in front is one of this app's.
pub fn app_active() -> bool {
    let mut process = 0;
    // SAFETY: `process` is a valid place for the number.
    unsafe {
        GetWindowThreadProcessId(GetForegroundWindow(), &mut process);
        process == GetCurrentProcessId()
    }
}

/// Gives the strip under the tab the outline the page draws towards (`hit`: from the tab's centre line and down
/// from the top edge, in points), so that the system says when the pointer reaches it.
pub fn outline(panel: usize, d: &Display, g: &Geometry, hit: &[(f64, f64)]) {
    let strip = STRIP.load(Relaxed) as HWND;
    if strip.is_null() || PASSIVE.load(Relaxed) {
        return;
    }
    // A watch that runs reads the pointer against the new outline at its next turn, moved or not.
    SEEN[0].store(i32::MIN, Relaxed);
    let s = d.scale.max(0.25);
    let [centre, top, _, _] = d.place(Rect { x: g.tab.mid_x(), y: g.tab.max_y(), w: 0.0, h: 0.0 });
    let points: Vec<POINT> = hit
        .iter()
        .map(|(x, y)| POINT { x: centre + (x * s).round() as i32, y: top + (y.max(0.0) * s).round() as i32 })
        .collect();
    let (left, right) = (points.iter().map(|p| p.x).min(), points.iter().map(|p| p.x).max());
    let bottom = points.iter().map(|p| p.y).max();
    let (Some(left), Some(right), Some(bottom)) = (left, right, bottom) else {
        return shapeless(strip);
    };
    if panel == 0 || points.len() < 3 || right <= left || bottom <= top {
        return shapeless(strip);
    }
    let inside: Vec<POINT> = points.iter().map(|p| POINT { x: p.x - left, y: p.y - top }).collect();
    // SAFETY: the region is made from points this call owns and is the window's from then on; the strip is put
    // under the tab without activating either.
    unsafe {
        let region = CreatePolygonRgn(inside.as_ptr(), inside.len() as i32, ALTERNATE);
        SetWindowPos(strip, panel as HWND, left, top, right - left, bottom - top, SWP_NOACTIVATE);
        SetWindowRgn(strip, region, 0);
    }
    SHAPED.store(true, Relaxed);
}
fn shapeless(strip: HWND) {
    SHAPED.store(false, Relaxed);
    // SAFETY: a window of this app.
    unsafe { ShowWindow(strip, SW_HIDE) };
}

/// Reads the pointer sixty times a second while it is on the tab or the sheet is open, and not otherwise.
pub fn watching(_panel: usize, on: bool) {
    if PASSIVE.load(Relaxed) || helper().is_null() || WATCHING.swap(on, Relaxed) == on {
        return;
    }
    SEEN[0].store(i32::MIN, Relaxed);
    // SAFETY: a timer of the helper window, started or ended.
    unsafe {
        match on {
            true => SetTimer(helper(), WATCH, 16, None),
            false => KillTimer(helper(), WATCH) as usize,
        };
    }
}

/// A dialog owned by the tab opens or has closed: the keyboard going to it is not the keyboard going elsewhere.
pub fn picking(on: bool) {
    PICKING.store(on, Relaxed);
}

// ---------------------------------------------------------------------------------------------
// Staying out of the way.

/// Whether Windows says not to show the tab: a full-screen window, a presentation or an exclusive Direct3D
/// program is in front, or nobody is at the desktop (it is locked, or a screen saver runs).
fn quiet() -> bool {
    let mut state = 0;
    // SAFETY: `state` is a valid place for the answer.
    let asked = unsafe { SHQueryUserNotificationState(&mut state) };
    asked == 0 && matches!(state, QUNS_NOT_PRESENT | QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE)
}

/// Asks Windows again, and hides or shows the tab when the answer changed.
fn rule() {
    if PASSIVE.load(Relaxed) {
        return;
    }
    let busy = quiet();
    if BUSY.swap(busy, Relaxed) != busy {
        crate::log(json!({"event": "tab", "hidden": busy}));
        post(PLACE);
        // The same answer says where a question goes: the notch, or a notification (rule 6).
        if let Some(app) = crate::APP.get() {
            crate::presence::full(app, busy);
        }
    }
}

/// Another window came in front: remembered as where the keyboard goes back to, and what Windows says is asked
/// now and once more in a moment, since the shell decides what is full screen after the window is in front.
unsafe extern "system" fn foreground(_: HWINEVENTHOOK, _: u32, window: HWND, _: i32, _: i32, _: u32, _: u32) {
    if !window.is_null() && window as isize != TAB.load(Relaxed) && window != helper() && !bar(window) {
        FOREIGN.store(window as isize, Relaxed);
    }
    post(FRONT);
    rule();
    SetTimer(helper(), AGAIN, 700, None);
}

// ---------------------------------------------------------------------------------------------
// The windows of this file.

/// The helper: never shown, a top-level window so that it hears what is said to every window.
unsafe extern "system" fn helper_proc(window: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    let Some(app) = crate::APP.get() else { return DefWindowProcW(window, message, w, l) };
    match message {
        TRAY => {
            let (event, x, y) = ((l & 0xffff) as u32, (w & 0xffff) as i16 as i32, ((w >> 16) & 0xffff) as i16 as i32);
            match event {
                // A click, or Return or Space on the icon: the sheet, with the keyboard.
                NIN_SELECT | NIN_KEYSELECT => {
                    let now = GetMessageTime() as u32;
                    if now.wrapping_sub(CHOSEN.swap(now, Relaxed)) > 400 {
                        crate::capture(app);
                    }
                }
                // The icon's notification was clicked: the window, at its question.
                NIN_BALLOONUSERCLICK => crate::notify::clicked_balloon(app),
                WM_CONTEXTMENU => {
                    let front = GetForegroundWindow();
                    let chosen = tray::menu(window as isize, x, y);
                    crate::log(json!({"event": "tray", "menu": chosen}));
                    match chosen {
                        1 => drop(workspace::show(app, None)),
                        2 => workspace::on_menu(app, "settings"),
                        3 => {
                            workspace::quit();
                            app.exit(0)
                        }
                        // Closed with nothing chosen: whoever was in front is in front again.
                        _ => {
                            let back = if bar(front) { FOREIGN.load(Relaxed) as HWND } else { front };
                            if GetForegroundWindow() == window && IsWindow(back) != 0 && IsIconic(back) == 0 {
                                SetForegroundWindow(back);
                            }
                        }
                    }
                }
                _ => {}
            }
            0
        }
        // A full-screen window came or went on this display.
        APPBAR => {
            if w as u32 == ABN_FULLSCREENAPP {
                rule();
                SetTimer(window, AGAIN, 700, None);
            }
            0
        }
        // The keyboard left the tab's window: the page folds a sheet that had it.
        AWAY => {
            let tab = TAB.load(Relaxed) as HWND;
            let open = NOTCH.try_lock().is_ok_and(|st| st.panel != 0 && !st.is_collapsed());
            if open && !PICKING.load(Relaxed) && !tab.is_null() && GetForegroundWindow() != tab {
                crate::log(json!({"event": "tab", "away": true}));
                notch::tell(app, json!({"do": "away"}));
            }
            0
        }
        PLACE => {
            notch::place(app);
            0
        }
        // Whether the window in front is the workspace's: the one notice of it on Windows.
        FRONT => {
            let workspace = app.get_webview_window(workspace::LABEL).and_then(|w| w.hwnd().ok());
            let front = workspace.is_some_and(|w| std::ptr::eq(GetForegroundWindow(), w.0));
            crate::presence::told(app, Some(front), Some(front));
            0
        }
        WM_TIMER if w == WATCH => {
            // The keyboard was in the open sheet and is in another window now, by a click there or a key: said
            // once, at the second look, since for a moment between two windows none is in front.
            let tab = TAB.load(Relaxed) as HWND;
            if !tab.is_null() && GetForegroundWindow() == tab {
                LEFT.store(0, Relaxed);
            } else if LEFT.load(Relaxed) >= 0 && !PICKING.load(Relaxed) && LEFT.fetch_add(1, Relaxed) >= 1 {
                LEFT.store(-1, Relaxed);
                post(AWAY);
            }
            let (x, y, down) = pointer();
            let now = [x as i32, y as i32, i32::from(down)];
            if SEEN.iter().zip(now).fold(false, |moved, (seen, now)| (seen.swap(now, Relaxed) != now) | moved) {
                notch::moved(app);
            }
            0
        }
        WM_TIMER if w == AGAIN => {
            KillTimer(window, AGAIN);
            rule();
            0
        }
        WM_TIMER if w == MAKE => {
            KillTimer(window, MAKE);
            if TAB.load(Relaxed) == 0 && workspace::tab() != "off" {
                if let Err(e) = make(app) {
                    crate::log(json!({"event": "tab", "made": false, "why": e.to_string()}));
                }
            }
            0
        }
        // The displays, the scale, the taskbar's place or the colour mode changed.
        WM_DISPLAYCHANGE | WM_SETTINGCHANGE => {
            if message == WM_DISPLAYCHANGE || w as u32 == SPI_SETWORKAREA {
                post(PLACE);
            }
            tray::set(None);
            DefWindowProcW(window, message, w, l)
        }
        // Explorer started anew and has forgotten every icon.
        _ if message == TASKBAR.load(Relaxed) && message != 0 => {
            tray::add(window as isize, TRAY);
            0
        }
        _ => DefWindowProcW(window, message, w, l),
    }
}

/// The strip: the pointer reached the tab's outline.
unsafe extern "system" fn strip_proc(window: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    match message {
        WM_MOUSEMOVE | WM_LBUTTONDOWN => {
            if let Some(app) = crate::APP.get() {
                notch::moved(app);
            }
            0
        }
        WM_MOUSEACTIVATE => MA_NOACTIVATE as LRESULT,
        _ => DefWindowProcW(window, message, w, l),
    }
}

/// The tab's window, watched: what its keyboard and its display do.
unsafe extern "system" fn tab_proc(window: HWND, message: u32, w: WPARAM, l: LPARAM, _: usize, _: usize) -> LRESULT {
    match message {
        // Alt+F4 with the keyboard in the sheet folds it. The window is the app's to end, not the person's.
        WM_CLOSE => {
            post(AWAY);
            if GetForegroundWindow() == window {
                give_back_key(window as usize);
            }
            return 0;
        }
        WM_ACTIVATE if (w & 0xffff) as u32 == WA_INACTIVE => post(AWAY),
        WM_NCDESTROY => {
            RemoveWindowSubclass(window, Some(tab_proc), 1);
        }
        _ => {}
    }
    let result = DefSubclassProc(window, message, w, l);
    // After Tauri has sized the window for a new scale, it is placed again by the arithmetic.
    if message == WM_DPICHANGED {
        post(PLACE);
    }
    result
}

fn class(name: &[u16], proc: unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT) {
    // SAFETY: the class is registered once with a NUL-terminated name that outlives the call.
    unsafe {
        let mut class: WNDCLASSEXW = std::mem::zeroed();
        class.cbSize = size_of::<WNDCLASSEXW>() as u32;
        class.lpfnWndProc = Some(proc);
        class.hInstance = GetModuleHandleW(null());
        class.hbrBackground = GetStockObject(BLACK_BRUSH);
        class.lpszClassName = name.as_ptr();
        RegisterClassExW(&class);
    }
}

/// Makes the helper and the strip, puts the icon into the notification area and starts listening to the shell.
/// A check's run (`passive`) has the helper alone: no icon, no strip, and nothing that hides the tab.
pub fn start(passive: bool) {
    PASSIVE.store(passive, Relaxed);
    let (helper_class, strip_class) = (wide("TASKTAP_SHELL"), wide("TASKTAP_TAB_EDGE"));
    class(&helper_class, helper_proc);
    class(&strip_class, strip_proc);
    // SAFETY: both windows are made from classes registered above, with names that outlive the calls; the hook's
    // function and the bar's window live as long as the app.
    unsafe {
        let instance = GetModuleHandleW(null());
        let helper = CreateWindowExW(
            WS_EX_TOOLWINDOW,
            helper_class.as_ptr(),
            wide("Tasktap").as_ptr(),
            WS_POPUP,
            0,
            0,
            0,
            0,
            null_mut(),
            null_mut(),
            instance,
            null(),
        );
        HELPER.store(helper as isize, Relaxed);
        // The strip draws nothing a person could see: one part in 255 of black, under the tab's own black.
        let strip = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
            strip_class.as_ptr(),
            wide("").as_ptr(),
            WS_POPUP,
            0,
            0,
            0,
            0,
            null_mut(),
            null_mut(),
            instance,
            null(),
        );
        SetLayeredWindowAttributes(strip, 0, 1, LWA_ALPHA);
        STRIP.store(strip as isize, Relaxed);
        if passive || helper.is_null() {
            return;
        }
        TASKBAR.store(RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()), Relaxed);
        let icon = tray::add(helper as isize, TRAY);
        // The shell tells a registered bar when a full-screen window comes or goes. This one is never given a
        // place, so it takes no room on the screen.
        let mut told: APPBARDATA = std::mem::zeroed();
        told.cbSize = size_of::<APPBARDATA>() as u32;
        told.hWnd = helper;
        told.uCallbackMessage = APPBAR;
        let told = SHAppBarMessage(ABM_NEW, &mut told) != 0;
        let hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            null_mut(),
            Some(foreground),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        let front = GetForegroundWindow();
        if !front.is_null() && !bar(front) {
            FOREIGN.store(front as isize, Relaxed);
        }
        BUSY.store(quiet(), Relaxed);
        crate::log(json!({"event": "tab", "icon": icon, "full-screen-told": told, "front-told": !hook.is_null(),
            "hidden": BUSY.load(Relaxed)}));
    }
}

/// Takes the icon away and stops listening: at quit.
pub fn end() {
    tray::remove();
    let helper = helper();
    if !helper.is_null() && !PASSIVE.load(Relaxed) {
        // SAFETY: a structure of numbers; the shell reads the window.
        unsafe {
            let mut told: APPBARDATA = std::mem::zeroed();
            told.cbSize = size_of::<APPBARDATA>() as u32;
            told.hWnd = helper;
            SHAppBarMessage(ABM_REMOVE, &mut told);
        }
    }
}

/// The workspace has drawn and its window is shown: the tab's page is made a moment later. Making a second web
/// view holds the app for a tenth of a second or two; made before the window it would hold up its first picture,
/// and made in the same turn as the window is shown it left the window white until it was done (the desktop
/// round caught that once in five starts).
pub fn ready(app: &AppHandle) {
    crate::presence::full(app, BUSY.load(Relaxed));
    if TAB.load(Relaxed) == 0 && !helper().is_null() {
        // SAFETY: a timer of the helper window, which ends it at its first turn.
        unsafe { SetTimer(helper(), MAKE, 700, None) };
    }
}

/// Makes the tab's window with the notch page in it and hands it to the notch, which places it. It is shown when
/// the page first asks for its place.
fn make(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("notch.html".into()))
        .title("Tasktap tab")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .focused(false)
        .visible(false)
        // Every web view of the app shares one browser, which takes a second view only with the same arguments.
        .additional_browser_args(crate::frames::BROWSER)
        .inner_size(232.0, 56.0)
        .build()?;
    let tab = window.hwnd()?.0 as HWND;
    // SAFETY: a window this app just made. Its styles become a bare popup's: no frame for the system to round,
    // shade or animate, no taskbar button, no place in Alt+Tab, never activated by a click or by being shown, and
    // the pointer passes through it until the notch says otherwise.
    unsafe {
        let style = GetWindowLongPtrW(tab, GWL_STYLE) as u32;
        SetWindowLongPtrW(
            tab,
            GWL_STYLE,
            ((style & WS_VISIBLE) | WS_POPUP | WS_CLIPCHILDREN | WS_CLIPSIBLINGS) as isize,
        );
        let ex = GetWindowLongPtrW(tab, GWL_EXSTYLE) as u32;
        let ex = (ex & !(WS_EX_APPWINDOW | WS_EX_WINDOWEDGE))
            | WS_EX_TOOLWINDOW
            | WS_EX_NOACTIVATE
            | WS_EX_LAYERED
            | WS_EX_TRANSPARENT
            | WS_EX_TOPMOST;
        SetWindowLongPtrW(tab, GWL_EXSTYLE, ex as isize);
        for (attribute, value) in [
            (DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND as u32),
            (DWMWA_TRANSITIONS_FORCEDISABLED, 1),
            // No border colour at all.
            (DWMWA_BORDER_COLOR, 0xffff_fffe),
        ] {
            DwmSetWindowAttribute(tab, attribute as u32, (&raw const value).cast(), size_of::<u32>() as u32);
        }
        SetWindowPos(
            tab,
            null_mut(),
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
        SetWindowSubclass(tab, Some(tab_proc), 1, 0);
    }
    TAB.store(tab as isize, Relaxed);
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            gone();
            crate::forget_page(&handle, LABEL);
        }
    });
    notch::adopt(app, tab as usize);
    crate::log(json!({"event": "tab", "made": true, "window": tab as isize}));
    Ok(())
}

/// The tab's window is gone, or about to be: the notch has no panel, and nothing watches for the pointer.
fn gone() {
    TAB.store(0, Relaxed);
    notch::orphan();
    watching(0, false);
    let strip = STRIP.load(Relaxed) as HWND;
    if !strip.is_null() {
        shapeless(strip);
    }
}

/// `host.tab {display?}`: which display the tab hangs on. With `display` ("main", "pointer", a display's name, or
/// "off" for no tab at all) the choice is kept in the host's own file, since a display belongs to this machine,
/// and carried out. The reply is the choice and the displays there are to choose from.
pub fn setting(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let all = monitors();
    if let Some(display) = args.get("display").and_then(Value::as_str) {
        if !matches!(display, "main" | "pointer" | "off") && !all.iter().any(|m| m.name == display) {
            return Err("That display is not connected".into());
        }
        workspace::set_tab(display);
        match display {
            "off" => {
                if let Some(window) = app.get_webview_window(LABEL) {
                    gone();
                    let _ = window.destroy();
                }
            }
            _ if TAB.load(Relaxed) == 0 => make(app).map_err(|e| e.to_string())?,
            _ => notch::place(app),
        }
    }
    let displays: Vec<Value> = all
        .iter()
        .map(|m| json!({"name": m.name, "primary": m.primary, "width": m.display.area[2], "height": m.display.area[3]}))
        .collect();
    Ok(json!({"display": workspace::tab(), "displays": displays}))
}

/// What a check may know: the windows, whether Windows says to hide, and the icon.
pub fn state() -> Value {
    let strip = STRIP.load(Relaxed) as HWND;
    // SAFETY: asks about windows of this app.
    let (tab_shown, strip_shown) =
        unsafe { (IsWindowVisible(TAB.load(Relaxed) as HWND) != 0, IsWindowVisible(strip) != 0) };
    let displays: Vec<Value> = monitors()
        .iter()
        .map(|m| json!({"name": m.name, "primary": m.primary, "area": m.display.area, "work": m.display.work, "scale": m.display.scale}))
        .collect();
    json!({"event": "tab", "window": TAB.load(Relaxed), "shown": tab_shown, "pixels": pixels(TAB.load(Relaxed) as HWND),
        "strip": strip as isize, "strip-shown": strip_shown, "strip-pixels": pixels(strip), "helper": HELPER.load(Relaxed),
        "hidden": BUSY.load(Relaxed), "watching": WATCHING.load(Relaxed), "setting": workspace::tab(),
        "displays": displays, "icon": tray::state()})
}
