//! The workspace window and the application around it: a real titled window whose close,
//! minimise and zoom buttons sit over the page's own top row (1.2's layout), its frame kept in
//! `<data>/host.json` between launches; the application menu; the Dock icon that brings the
//! window back. Closing the window leaves the notch running.
use crate::notch;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::utils::config::{BackgroundThrottlingPolicy, WindowEffectsConfig};
use tauri::utils::{WindowEffect, WindowEffectState};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, TitleBarStyle, WebviewUrl, WebviewWindowBuilder,
    WindowEvent, Wry,
};

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
    let effects = WindowEffectsConfig {
        effects: vec![WindowEffect::UnderWindowBackground],
        state: Some(WindowEffectState::FollowsWindowActiveState),
        ..Default::default()
    };
    let frame = with(|st| st.settings.frame).filter(|f| on_screen(app, f));
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(path.into()))
        .title("Tasktap")
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(LogicalPosition::new(16.0, 18.0))
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
    builder = match frame {
        Some([x, y, w, h]) => builder.position(x, y).inner_size(w, h),
        None => builder.inner_size(1180.0, 760.0).center(),
    };
    let window = builder.build()?;
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
fn about() -> AboutMetadata<'static> {
    AboutMetadata {
        credits: Some(
            "Terminal text is set in Hack 3.003 (MIT and Bitstream Vera licences), with symbols from Nerd Fonts 3.4.0 (MIT). \
             Their licences are in the app, under licenses/."
                .to_owned(),
        ),
        ..Default::default()
    }
}

/// The application menu: Quit, the Edit commands a web view needs for ⌘C and ⌘V, and the
/// workspace's own commands, which go to its page (`command` in ui/src/workspace/main.tsx).
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
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
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
