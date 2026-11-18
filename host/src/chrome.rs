//! The workspace window's chrome on Windows. The Mac's window has its three buttons over the
//! page's own top row and its menu in the system's bar; here the window has no frame of the
//! system's drawing either: the page's top row is the title bar, with a menu button at its left
//! and the three caption buttons at its right, and the window is dark as a whole.
//!
//! The window keeps the styles of a titled one (tao takes only the frame's drawing away), so
//! Windows still snaps it, animates it, gives it its shadow and round corners, and opens its
//! menu on Alt-Space. The page marks its top row as the place to drag by (`app-region: drag`,
//! which WebView2 takes as the title bar: drag, double-click, the window's menu on a right
//! click), and Tauri puts the resize border along the top edge. What is left is here:
//!
//! - **The caption buttons.** The page draws them, but a web view is a window of its own and
//!   Windows never asks the frame what lies under the pointer there, so hovering the page's
//!   Maximize would never open the Snap layouts. A child window that draws nothing lies over
//!   the three buttons and answers for them (`HTMINBUTTON`, `HTMAXBUTTON`, `HTCLOSE`), as
//!   Windows Terminal's does over its own; what the pointer does there is told to the page,
//!   which lights the button, and a click is carried out here.
//! - **Dark menus.** A menu Windows draws is light unless the program asks otherwise.
//! - **The frame's hairline**, in the page's own line colour.
use serde_json::json;
use std::ffi::c_void;
use std::ptr::{null, null_mut};
use tauri::{AppHandle, Emitter, WebviewWindow};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
};
use windows_sys::Win32::System::LibraryLoader::{
    GetModuleHandleW, GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32,
};
use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetClientRect, GetParent, GetWindowLongPtrW, GetWindowRect, IsZoomed,
    PostMessageW, RegisterClassExW, SetWindowLongPtrW, SetWindowPos, CREATESTRUCTW, GWLP_USERDATA, HTCLOSE,
    HTMAXBUTTON, HTMINBUTTON, HTTRANSPARENT, HWND_TOP, SC_CLOSE, SC_MAXIMIZE, SC_MINIMIZE, SC_RESTORE,
    SM_CXPADDEDBORDER, SM_CYFRAME, SWP_NOACTIVATE, WM_CREATE, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDBLCLK,
    WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_SIZE, WM_SYSCOMMAND, WNDCLASSEXW, WS_CHILD,
    WS_CLIPSIBLINGS, WS_VISIBLE,
};

/// The page's colours (ui/src/tokens.css `--bg`, `--line`, `--fg2`) as Windows writes one: blue, green, red.
const GROUND: u32 = 0x000b_0a0a;
const LINE: u32 = 0x0024_201f;
const TEXT: u32 = 0x00aa_a4a3;
/// A caption button as the page draws it (window.css `.wbs`), in the page's own pixels: as wide as Windows 11's,
/// as high as the top row.
const WIDE: i32 = 46;
const HIGH: i32 = 38;

/// Whether the page's top row is the title bar. `TASKTAP_CHROME=native` keeps the system's own title bar instead,
/// in the page's colours: the same window with a tenth of the code, for comparing the two.
pub fn own() -> bool {
    std::env::var("TASKTAP_CHROME").as_deref() != Ok("native")
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

/// Menus the system draws for this program are dark, whatever the system's own setting: the context menus and the
/// window's menu. Windows has no documented way to ask; this is the one its own programs use (uxtheme's
/// `SetPreferredAppMode` and `FlushMenuThemes`, by their ordinals), and a system without it keeps light menus.
fn dark_menus() {
    const FORCE_DARK: i32 = 2;
    // SAFETY: the library is the system's own, loaded from its folder; an ordinal is passed as a name the way
    // `GetProcAddress` takes one; the two functions have had these signatures since Windows 10 1903.
    unsafe {
        let theme = LoadLibraryExW(wide("uxtheme.dll").as_ptr(), null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32);
        if theme.is_null() {
            return;
        }
        let (set, flush) = (GetProcAddress(theme, 135 as *const u8), GetProcAddress(theme, 136 as *const u8));
        if let (Some(set), Some(flush)) = (set, flush) {
            let set: unsafe extern "system" fn(i32) -> i32 = std::mem::transmute(set);
            let flush: unsafe extern "system" fn() = std::mem::transmute(flush);
            set(FORCE_DARK);
            flush();
        }
    }
}

fn colour(window: HWND, attribute: u32, colour: u32) {
    // SAFETY: the window is open and the attribute is one colour, read during the call.
    unsafe { DwmSetWindowAttribute(window, attribute, (&raw const colour).cast(), size_of::<u32>() as u32) };
}

/// Dresses the window once it is made: dark menus, the frame's hairline, and either the caption buttons' window
/// (the page's top row is the title bar) or the system's title bar in the page's colours.
pub fn dress(app: &AppHandle, window: &WebviewWindow) {
    dark_menus();
    let Ok(frame) = window.hwnd() else { return };
    let frame = frame.0 as HWND;
    colour(frame, DWMWA_BORDER_COLOR as u32, LINE);
    if own() {
        buttons(app, frame);
    } else {
        colour(frame, DWMWA_CAPTION_COLOR as u32, GROUND);
        colour(frame, DWMWA_TEXT_COLOR as u32, TEXT);
    }
}

/// What the buttons' window keeps: the app to tell, the button under the pointer and the one held down (hit-test
/// codes, 0 for none), and whether the pointer's leaving is asked for.
struct Buttons {
    app: AppHandle,
    over: u32,
    down: u32,
    tracked: bool,
}

/// Says to the page what its caption buttons are to show (ui/src/workspace/chrome.tsx).
fn tell(app: &AppHandle, frame: HWND, over: u32, down: u32) {
    let name = |hit: u32| match hit {
        HTMINBUTTON => "minimize",
        HTMAXBUTTON => "maximize",
        HTCLOSE => "close",
        _ => "",
    };
    // SAFETY: asks one thing of a window that is open.
    let max = unsafe { IsZoomed(frame) } != 0;
    let _ = app.emit_to(
        crate::workspace::LABEL,
        "ui",
        json!({"do": "caption", "over": name(over), "down": name(down), "max": max}),
    );
}

/// Puts the buttons' window where the page draws them: the top right corner, three buttons wide.
fn place(frame: HWND, buttons: HWND) {
    let mut client = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    // SAFETY: both windows are open, and `client` is a valid place for the rectangle.
    unsafe {
        if GetClientRect(frame, &mut client) == 0 {
            return;
        }
        let scale = |px: i32| (px * GetDpiForWindow(frame) as i32 + 48) / 96;
        let (w, h) = (3 * scale(WIDE), scale(HIGH));
        SetWindowPos(buttons, HWND_TOP, client.right - w, 0, w, h, SWP_NOACTIVATE);
    }
}

fn buttons(app: &AppHandle, frame: HWND) {
    let name = wide("TASKTAP_CAPTION_BUTTONS");
    // SAFETY: the class and the window are made with valid, NUL-terminated names that outlive the calls; the
    // window takes ownership of the boxed `Buttons` in WM_CREATE and frees it in WM_NCDESTROY; the frame's
    // subclass only reads the child's handle, which it is given as a number.
    unsafe {
        let instance = GetModuleHandleW(null());
        let mut class: WNDCLASSEXW = std::mem::zeroed();
        class.cbSize = size_of::<WNDCLASSEXW>() as u32;
        class.lpfnWndProc = Some(buttons_proc);
        class.hInstance = instance;
        class.lpszClassName = name.as_ptr();
        RegisterClassExW(&class);
        let data = Box::into_raw(Box::new(Buttons { app: app.clone(), over: 0, down: 0, tracked: false }));
        // It draws nothing, and the web view under it is drawn over whatever its siblings are: the page's buttons
        // show, and the pointer meets this window first. (Tauri's resize border along the top edge is such a window.)
        let child = CreateWindowExW(
            0,
            name.as_ptr(),
            name.as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
            0,
            0,
            0,
            0,
            frame,
            null_mut(),
            instance,
            data as *const c_void,
        );
        if child.is_null() {
            drop(Box::from_raw(data));
            crate::log(
                json!({"event": "chrome", "buttons": false, "error": std::io::Error::last_os_error().to_string()}),
            );
            return;
        }
        place(frame, child);
        SetWindowSubclass(frame, Some(frame_proc), 1, child as usize);
        crate::log(json!({"event": "chrome", "buttons": true}));
    }
}

/// The frame, watched: its buttons follow its size, and the page hears whether it is maximised.
unsafe extern "system" fn frame_proc(
    frame: HWND,
    message: u32,
    w: WPARAM,
    l: LPARAM,
    _: usize,
    child: usize,
) -> LRESULT {
    let result = DefSubclassProc(frame, message, w, l);
    if message == WM_SIZE {
        let child = child as HWND;
        place(frame, child);
        let data = GetWindowLongPtrW(child, GWLP_USERDATA) as *const Buttons;
        if let Some(data) = data.as_ref() {
            tell(&data.app, frame, data.over, data.down);
        }
    }
    result
}

unsafe extern "system" fn buttons_proc(child: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if message == WM_CREATE {
        let made = l as *const CREATESTRUCTW;
        SetWindowLongPtrW(child, GWLP_USERDATA, (*made).lpCreateParams as isize);
        return 0;
    }
    let data = GetWindowLongPtrW(child, GWLP_USERDATA) as *mut Buttons;
    let frame = GetParent(child);
    let Some(data) = data.as_mut() else { return DefWindowProcW(child, message, w, l) };
    let say = |data: &mut Buttons, over: u32, down: u32| {
        if (data.over, data.down) != (over, down) {
            (data.over, data.down) = (over, down);
            tell(&data.app, frame, over, down);
        }
    };
    match message {
        WM_NCHITTEST => {
            let (x, y) = ((l & 0xffff) as i16 as i32, ((l >> 16) & 0xffff) as i16 as i32);
            let mut at = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            if GetWindowRect(child, &mut at) == 0 || at.right <= at.left {
                return HTTRANSPARENT as LRESULT;
            }
            // The top edge resizes a window that is not maximised: the resize border under this window answers.
            let dpi = GetDpiForWindow(child);
            let edge = GetSystemMetricsForDpi(SM_CYFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
            if IsZoomed(frame) == 0 && y < at.top + edge {
                return HTTRANSPARENT as LRESULT;
            }
            let hit = match (x - at.left) * 3 / (at.right - at.left) {
                0 => HTMINBUTTON,
                1 => HTMAXBUTTON,
                _ => HTCLOSE,
            };
            hit as LRESULT
        }
        WM_NCMOUSEMOVE => {
            if !data.tracked {
                let mut track = TRACKMOUSEEVENT {
                    cbSize: size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE | TME_NONCLIENT,
                    hwndTrack: child,
                    dwHoverTime: 0,
                };
                data.tracked = TrackMouseEvent(&mut track) != 0;
            }
            let down = data.down;
            say(data, w as u32, down);
            0
        }
        WM_NCMOUSELEAVE => {
            data.tracked = false;
            say(data, 0, 0);
            0
        }
        WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK => {
            say(data, w as u32, w as u32);
            0
        }
        WM_NCLBUTTONUP => {
            let (hit, down) = (w as u32, data.down);
            say(data, hit, 0);
            if hit == down {
                let command = match hit {
                    HTMINBUTTON => SC_MINIMIZE,
                    HTMAXBUTTON if IsZoomed(frame) != 0 => SC_RESTORE,
                    HTMAXBUTTON => SC_MAXIMIZE,
                    _ => SC_CLOSE,
                };
                PostMessageW(frame, WM_SYSCOMMAND, command as WPARAM, 0);
            }
            0
        }
        WM_NCDESTROY => {
            SetWindowLongPtrW(child, GWLP_USERDATA, 0);
            drop(Box::from_raw(data));
            DefWindowProcW(child, message, w, l)
        }
        _ => DefWindowProcW(child, message, w, l),
    }
}
