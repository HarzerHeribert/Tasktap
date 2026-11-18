//! The workspace window and the application around it: a real titled window whose close,
//! minimise and zoom buttons sit over the page's own top row (1.2's layout), its frame kept in
//! `<data>/host.json` between launches; the application menu; the Dock icon that brings the
//! window back. Closing the window leaves the notch running.
use crate::notch;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::utils::config::{BackgroundThrottlingPolicy, WindowEffectsConfig};
use tauri::utils::{WindowEffect, WindowEffectState};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
#[cfg(target_os = "macos")]
use tauri::Wry;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const LABEL: &str = "workspace";

/// What the host keeps between launches.
#[derive(Serialize, Deserialize)]
struct Settings {
    /// The window's frame in points: x, y, width, height.
    frame: Option<[f64; 4]>,
}

struct State {
    path: PathBuf,
    settings: Settings,
    /// The page's first paint showed the window.
    shown: bool,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

/// The web view loads nothing from the network but this machine's own addresses (frames.rs `RULES`): only then is a
/// preview given a frame.
pub static CONFINED: AtomicBool = AtomicBool::new(false);
/// The page the window shows: where its top frame is sent back to, should it ever be anywhere else.
static HOME: Mutex<Option<Url>> = Mutex::new(None);

/// A place a frame may not go, or a window one asked for: said in the log, and, when it is an address of the web,
/// to the page, which offers it to the person for the browser. Nothing is opened here.
fn stopped(app: &AppHandle, url: &str) -> bool {
    crate::log(json!({"event": "frame", "stopped": url}));
    if tasktap_proto::web(url) == tasktap_proto::Web::Remote {
        let _ = app.emit_to(LABEL, "ui", json!({"do": "stopped", "url": url}));
    }
    false
}

fn with<T>(f: impl FnOnce(&mut State) -> T) -> T {
    f(STATE.lock().unwrap().as_mut().expect("workspace::start ran"))
}

fn save() {
    with(|st| {
        let _ = std::fs::write(&st.path, serde_json::to_vec(&st.settings).unwrap_or_default());
    })
}

/// Reads the settings.
pub fn start(data: PathBuf) {
    let path = data.join("host.json");
    let settings =
        std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Settings { frame: None });
    *STATE.lock().unwrap() = Some(State { path, settings, shown: false });
}

/// Shows the workspace window, made the first time; with `at`, the page shows that session's or
/// terminal's tab. A passive run (the checks) never gives it the keyboard.
pub fn show(app: &AppHandle, at: Option<&str>) -> tauri::Result<()> {
    let passive = notch::NOTCH.lock().unwrap().passive;
    if let Some(window) = app.get_webview_window(LABEL) {
        if let Some(at) = at {
            window.emit("ui", json!({"do": "focus", "at": at}))?;
        }
        window.unminimize()?;
        window.show()?;
        if !passive {
            window.set_focus()?;
        }
        return Ok(());
    }
    let path = match at {
        Some(at) => format!("workspace.html?focus={at}"),
        None => "workspace.html".to_owned(),
    };
    // On Windows the page is told whose title bar the window has: its own top row, or the system's (chrome.rs).
    #[cfg(windows)]
    let path = format!(
        "{path}{}chrome={}",
        if path.contains('?') { '&' } else { '?' },
        if crate::chrome::own() { "own" } else { "native" }
    );
    let effects = WindowEffectsConfig {
        // Each system's own backdrop: the Mac's under-window material, Windows 11's Mica.
        effects: vec![
            #[cfg(target_os = "macos")]
            WindowEffect::UnderWindowBackground,
            #[cfg(windows)]
            WindowEffect::Mica,
        ],
        state: Some(WindowEffectState::FollowsWindowActiveState),
        ..Default::default()
    };
    let frame = with(|st| st.settings.frame).filter(|f| on_screen(app, f));
    let (to, asks) = (app.clone(), app.clone());
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(path.into()))
        // What a preview's frame is held to (frames.rs): it goes to this machine's own addresses and nowhere else,
        // it opens no window, and the top frame stays on the app's own pages.
        .on_navigation(move |url| crate::frames::allowed(url.as_str()) || stopped(&to, url.as_str()))
        .on_new_window(move |url, _| {
            stopped(&asks, url.as_str());
            NewWindowResponse::Deny
        })
        .on_page_load(|window, load| {
            if load.event() != PageLoadEvent::Started {
                return;
            }
            let mut home = HOME.lock().unwrap();
            if crate::frames::own(load.url().as_str()) {
                *home = Some(load.url().clone());
            } else if let Some(home) = home.clone() {
                crate::log(json!({"event": "frame", "top": load.url().as_str()}));
                let _ = window.navigate(home);
            }
        })
        .title("Tasktap")
        .min_inner_size(640.0, 400.0)
        .transparent(true)
        .effects(effects)
        .visible(false)
        .focused(!passive)
        // A check reads the terminal while the window sits behind the person's own apps, where
        // WebKit would stop drawing it.
        .background_throttling(if passive {
            BackgroundThrottlingPolicy::Disabled
        } else {
            BackgroundThrottlingPolicy::Suspend
        });
    // The Mac's buttons sit over the page's own top row, and its menu is the application's. On
    // Windows the page's top row is the title bar, with the window's buttons and a menu button of
    // the page's own in it (chrome.rs), and the window is dark whatever the system's setting is:
    // its backdrop, its menus and what it shows before the page has drawn.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 18.0));
    }
    #[cfg(windows)]
    {
        builder = builder.theme(Some(tauri::Theme::Dark)).decorations(!crate::chrome::own());
    }
    builder = match frame {
        Some([x, y, w, h]) => builder.position(x, y).inner_size(w, h),
        None => builder.inner_size(1180.0, 760.0).center(),
    };
    let window = builder.build()?;
    #[cfg(windows)]
    crate::chrome::dress(app, &window);
    CONFINED.store(false, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    {
        let rules = with(|st| st.path.with_file_name("frames"));
        window.with_webview(move |view| {
            crate::native::confine(view.inner(), crate::frames::RULES, &rules, |ok| {
                CONFINED.store(ok, Ordering::Relaxed);
                crate::log(json!({"event": "frame", "confined": ok}));
            })
        })?;
    }
    #[cfg(windows)]
    {
        let to = app.clone();
        window.with_webview(move |view| {
            let ok = crate::native::confine(&view, move |url| {
                stopped(&to, url);
            });
            CONFINED.store(ok, Ordering::Relaxed);
            crate::log(json!({"event": "frame", "confined": ok}));
        })?;
    }
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::CloseRequested { .. } = event {
            remember();
        }
        if let WindowEvent::Destroyed = event {
            save();
            with(|st| st.shown = false);
            crate::forget_page(&handle, LABEL);
        }
    });
    // Shown once the page has drawn, or after 3 s if it never says so.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || ready(&inner));
    });
    Ok(())
}

/// `host.ready`: the page has drawn its first frame; the window appears with it, not blank.
pub fn ready(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    if with(|st| std::mem::replace(&mut st.shown, true)) {
        return;
    }
    let passive = notch::NOTCH.lock().unwrap().passive;
    let _ = window.show();
    if !passive {
        let _ = window.set_focus();
    }
    println!("{}", json!({"event": "window", "ms": crate::since_start()}));
}

/// The window's frame in points, kept in memory as it changes and written at close and at quit.
fn remember() {
    let Some(app) = crate::APP.get() else { return };
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let (Ok(pos), Ok(size), Ok(scale)) = (window.outer_position(), window.inner_size(), window.scale_factor()) else {
        return;
    };
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let p = pos.to_logical::<f64>(scale);
    let s: LogicalSize<f64> = size.to_logical(scale);
    with(|st| st.settings.frame = Some([p.x, p.y, s.width, s.height]));
}
pub fn quit() {
    remember();
    save();
}

/// A remembered frame whose top-left corner is on a screen this Mac still has.
fn on_screen(app: &AppHandle, f: &[f64; 4]) -> bool {
    app.available_monitors().unwrap_or_default().iter().any(|m| {
        let (p, s) = (m.position().to_logical::<f64>(m.scale_factor()), m.size().to_logical::<f64>(m.scale_factor()));
        f[0] >= p.x - 20.0 && f[0] < p.x + s.width - 40.0 && f[1] >= p.y - 20.0 && f[1] < p.y + s.height - 40.0
    })
}

/// The About panel's notices: the terminal's typefaces, whose licences ship in the app's pages (licenses/).
#[cfg(target_os = "macos")]
fn about() -> AboutMetadata<'static> {
    AboutMetadata {
        credits: Some(
            "Terminal text is set in Hack 3.003 (MIT and Bitstream Vera licences), with symbols from Nerd Fonts 3.4.0 (MIT). \
             Speech on this Mac is written down by whisper.cpp 1.9.5 (MIT) with OpenAI's Whisper model (MIT). \
             Their licences are in the app, under licenses/."
                .to_owned(),
        ),
        ..Default::default()
    }
}

/// `host.window`: the window minimised, maximised or put back, or closed, for the page's own caption buttons and
/// its menu (Windows; the buttons' window in chrome.rs does the same for the pointer).
pub fn window(app: &AppHandle, what: &str) -> Result<serde_json::Value, String> {
    let window = app.get_webview_window(LABEL).ok_or("the window is not open")?;
    match what {
        "minimize" => window.minimize(),
        "maximize" if window.is_maximized().unwrap_or(false) => window.unmaximize(),
        "maximize" => window.maximize(),
        "close" => window.close(),
        _ => return Err(format!("a window cannot {what}")),
    }
    .map(|_| serde_json::Value::Null)
    .map_err(|e| e.to_string())
}

/// The Mac's application menu: Quit, the Edit commands a web view needs for ⌘C and ⌘V, and the
/// workspace's own commands, which go to its page (`command` in ui/src/workspace/main.tsx). On
/// Windows the page has the same commands behind its menu button, each with its Windows key
/// (ui/src/workspace/chrome.tsx).
#[cfg(target_os = "macos")]
pub fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let item = |id: &str, text: &str, keys: Option<&str>| MenuItem::with_id(app, id, text, true, keys);
    let sep = || PredefinedMenuItem::separator(app);
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                "Tasktap",
                true,
                &[
                    &PredefinedMenuItem::about(app, Some("About Tasktap"), Some(about()))?,
                    &sep()?,
                    #[cfg(target_os = "macos")]
                    &PredefinedMenuItem::hide(app, None)?,
                    #[cfg(target_os = "macos")]
                    &PredefinedMenuItem::hide_others(app, None)?,
                    #[cfg(target_os = "macos")]
                    &PredefinedMenuItem::show_all(app, None)?,
                    #[cfg(target_os = "macos")]
                    &sep()?,
                    &PredefinedMenuItem::quit(app, Some("Quit Tasktap"))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &item("new-task", "New Task", Some("CmdOrCtrl+N"))?,
                    &item("new-terminal", "New Terminal", Some("CmdOrCtrl+T"))?,
                    &item("open-workspace", "Open Workspace…", Some("CmdOrCtrl+O"))?,
                    &sep()?,
                    &item("close-tab", "Close Tab", Some("CmdOrCtrl+W"))?,
                    &PredefinedMenuItem::close_window(app, Some("Close Window"))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &sep()?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                    &sep()?,
                    &item("find", "Find in Terminal…", Some("CmdOrCtrl+F"))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &item("sidebar", "Toggle Sidebar", Some("CmdOrCtrl+Ctrl+S"))?,
                    &item("focus", "Focus Surface", None)?,
                    &item("split-right", "Split Right", Some("CmdOrCtrl+D"))?,
                    &item("split-down", "Split Down", Some("CmdOrCtrl+Shift+D"))?,
                    &sep()?,
                    &item("preview", "Switch Terminal and Preview", Some("CmdOrCtrl+P"))?,
                    &item("reload-preview", "Reload Preview", Some("CmdOrCtrl+R"))?,
                    &sep()?,
                    &item("bigger", "Increase Text Size", Some("CmdOrCtrl+="))?,
                    &item("smaller", "Decrease Text Size", Some("CmdOrCtrl+-"))?,
                    &item("reset", "Reset Text Size", Some("CmdOrCtrl+0"))?,
                    &sep()?,
                    &item("settings", "Settings…", Some("CmdOrCtrl+,"))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
                    &sep()?,
                    &item("show", "Workspace", None)?,
                ],
            )?,
        ],
    )
}

/// A menu command: the window's own are its page's; New Task, New Terminal and Open Workspace
/// open the window first. Commands for a tab act only while the workspace is the key window, so
/// ⌘W in the notch never closes a tab behind it.
pub fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "show" => drop(show(app, None)),
        "new-task" | "new-terminal" | "open-workspace" | "settings" => {
            let _ = show(app, None);
            let _ = app.emit_to(LABEL, "ui", json!({"do": "menu", "id": id}));
        }
        _ => {
            let focused = app.get_webview_window(LABEL).is_some_and(|w| w.is_focused().unwrap_or(false));
            if focused {
                let _ = app.emit_to(LABEL, "ui", json!({"do": "menu", "id": id}));
            }
        }
    }
}
