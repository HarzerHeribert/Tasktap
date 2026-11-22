//! The workspace windows and the application around it: the main window, which holds Home and every workspace that is
//! not out, and a window of its own for each workspace that is (`pop`). Each is a real titled window whose close,
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

/// The main window's label; a window of a workspace's own is `ws-<project>`.
pub const LABEL: &str = "workspace";
const PREFIX: &str = "ws-";

pub fn label_of(project: &str) -> String {
    format!("{PREFIX}{project}")
}

/// Whether `label` is the main window or a workspace's own.
pub fn is_window(label: &str) -> bool {
    label == LABEL || label.starts_with(PREFIX)
}

/// A workspace that is out, in a window of its own: its project, and where that window stood.
#[derive(Serialize, Deserialize)]
struct Out {
    project: String,
    frame: Option<[f64; 4]>,
}

/// What the host keeps between launches.
#[derive(Default, Serialize, Deserialize)]
struct Settings {
    /// The window's frame in points: x, y, width, height.
    frame: Option<[f64; 4]>,
    /// Windows: the display the tab hangs on ("main", "pointer" or a display's own name), or "off" for no tab.
    /// Kept here and not among the core's preferences: a display belongs to this machine. None is "main".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tab: Option<String>,
    /// The workspaces that were out, which come back in their windows at the next start.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    windows: Vec<Out>,
}

struct State {
    path: PathBuf,
    settings: Settings,
    /// The windows whose page's first paint showed them.
    shown: Vec<String>,
    /// The workspaces to bring back in their windows, one after another as each window shows.
    queue: Vec<String>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

/// The web view loads nothing from the network but this machine's own addresses (frames.rs `RULES`): only then is a
/// preview given a frame.
pub static CONFINED: AtomicBool = AtomicBool::new(false);
/// The page each window shows: where its top frame is sent back to, should it ever be anywhere else.
static HOME: Mutex<Vec<(String, Url)>> = Mutex::new(Vec::new());
/// The app is ending: windows that go with it are not workspaces put back.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// A place a frame may not go, or a window one asked for: said in the log, and, when it is an address of the web,
/// to the page, which offers it to the person for the browser. Nothing is opened here.
fn stopped(app: &AppHandle, label: &str, url: &str) -> bool {
    crate::log(json!({"event": "frame", "stopped": url}));
    if tasktap_proto::web(url) == tasktap_proto::Web::Remote {
        let _ = app.emit_to(label, "ui", json!({"do": "stopped", "url": url}));
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
    let settings: Settings =
        std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let queue = settings.windows.iter().map(|w| w.project.clone()).collect();
    *STATE.lock().unwrap() = Some(State { path, settings, shown: Vec::new(), queue });
}

/// Windows: where the tab hangs, as the person chose it ("main" until they do; in a review build "off", since the
/// person's own Tasktap has its tab there).
#[cfg(windows)]
pub fn tab() -> String {
    let default = if crate::REVIEW { "off" } else { "main" };
    STATE.lock().unwrap().as_ref().and_then(|st| st.settings.tab.clone()).unwrap_or_else(|| default.into())
}
#[cfg(windows)]
pub fn set_tab(display: &str) {
    with(|st| st.settings.tab = Some(display.to_owned()));
    save();
}

/// The window the keys and the menu speak of: the one that has or last had the keyboard, else the main window.
fn keyed(app: &AppHandle) -> String {
    let last = crate::presence::last();
    if app.get_webview_window(&last).is_some() {
        last
    } else {
        LABEL.to_owned()
    }
}

/// The capture key, for the workspace's page to carry out (plan, "Where Tasktap shows itself"): the window that has
/// the keyboard comes in front, and the page puts the caret in Home's own field or New Task's (`to` "field"), or opens
/// New Task over what it shows ("new-task"). A window made for it is told so as it opens.
pub fn capture(app: &AppHandle, to: &str) {
    let label = keyed(app);
    if app.get_webview_window(&label).is_none() {
        let _ = raise(app, &label, Some(&format!("capture:{to}")));
        return;
    }
    let _ = raise(app, &label, None);
    // Not `capture`: that is what the notch's page is told, and a page hears what any page is told.
    let _ = app.emit_to(&label, "ui", json!({"do": "capture-key", "to": to}));
}

/// Shows the main window, made the first time; with `at`, the page shows that session's or terminal's tab (a
/// workspace that is out has the window that shows it brought forward by that page). A passive run (the checks)
/// never gives it the keyboard.
pub fn show(app: &AppHandle, at: Option<&str>) -> tauri::Result<()> {
    raise(app, LABEL, at)
}

fn raise(app: &AppHandle, label: &str, at: Option<&str>) -> tauri::Result<()> {
    let passive = notch::NOTCH.lock().unwrap().passive;
    if let Some(window) = app.get_webview_window(label) {
        if let Some(at) = at {
            app.emit_to(label, "ui", json!({"do": "focus", "at": at}))?;
        }
        window.unminimize()?;
        window.show()?;
        if !passive {
            window.set_focus()?;
        }
        return Ok(());
    }
    let mut query = Vec::new();
    if let Some(project) = label.strip_prefix(PREFIX) {
        query.push(format!("project={project}"));
    }
    if let Some(at) = at {
        query.push(format!("focus={at}"));
    }
    // On Windows the page is told whose title bar the window has: its own top row, or the system's (chrome.rs).
    #[cfg(windows)]
    query.push(format!("chrome={}", if crate::chrome::own() { "own" } else { "native" }));
    let path =
        if query.is_empty() { "workspace.html".to_owned() } else { format!("workspace.html?{}", query.join("&")) };
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
    let frame = frame_of(label).filter(|f| on_screen(app, f));
    let (to, asks, here, there) = (app.clone(), app.clone(), label.to_owned(), label.to_owned());
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(path.into()))
        // What a preview's frame is held to (frames.rs): it goes to this machine's own addresses and nowhere else,
        // it opens no window, and the top frame stays on the app's own pages.
        .on_navigation(move |url| crate::frames::allowed(url.as_str()) || stopped(&to, &here, url.as_str()))
        .on_new_window(move |url, _| {
            stopped(&asks, &there, url.as_str());
            NewWindowResponse::Deny
        })
        // A preview's frame shows no scrollbar, as nothing in the app does, where a page's own styles leave that to
        // the app (frames.rs BARS); the app's own page is left as it is.
        .initialization_script_for_all_frames(crate::frames::BARS)
        .on_page_load(|window, load| {
            if load.event() != PageLoadEvent::Started {
                return;
            }
            let mut homes = HOME.lock().unwrap();
            let at = homes.iter().position(|(label, _)| label == window.label());
            if crate::frames::own(load.url().as_str()) {
                match at {
                    Some(at) => homes[at].1 = load.url().clone(),
                    None => homes.push((window.label().to_owned(), load.url().clone())),
                }
            } else if let Some(at) = at {
                crate::log(json!({"event": "frame", "top": load.url().as_str()}));
                let _ = window.navigate(homes[at].1.clone());
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
        builder = builder
            .theme(Some(tauri::Theme::Dark))
            .decorations(!crate::chrome::own())
            .additional_browser_args(crate::frames::BROWSER);
    }
    builder = match frame {
        Some([x, y, w, h]) => builder.position(x, y).inner_size(w, h),
        None => builder.inner_size(1180.0, 760.0).center(),
    };
    let label = label.to_owned();
    let window = builder.build()?;
    #[cfg(windows)]
    crate::chrome::dress(app, &window);
    CONFINED.store(false, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    {
        let rules = with(|st| st.path.with_file_name("frames"));
        window.with_webview(move |view| {
            crate::native::tab_to_controls(view.inner());
            crate::native::confine(view.inner(), crate::frames::RULES, &rules, |ok| {
                CONFINED.store(ok, Ordering::Relaxed);
                crate::log(json!({"event": "frame", "confined": ok}));
            })
        })?;
    }
    #[cfg(windows)]
    {
        let (to, label) = (app.clone(), label.clone());
        window.with_webview(move |view| {
            let ok = crate::native::confine(&view, move |url| {
                stopped(&to, &label, url);
            });
            CONFINED.store(ok, Ordering::Relaxed);
            crate::log(json!({"event": "frame", "confined": ok}));
        })?;
    }
    let handle = app.clone();
    #[cfg(windows)]
    let view = window.clone();
    let named = label.clone();
    window.on_window_event(move |event| {
        let label = &named;
        if let WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::CloseRequested { .. } = event {
            remember(label);
        }
        // Minimised, its web view is out of sight as WebView2 knows it, which it does not learn from the window: the
        // page is hidden and given no frames, whatever moves in it, until the window is put back.
        #[cfg(windows)]
        if let WindowEvent::Resized(_) = event {
            crate::native::seen(&view, !view.is_minimized().unwrap_or(false));
        }
        // Whether the window is in front (presence.rs): on the Mac the window taking or losing the keyboard, beside the
        // app's own activation (main.rs); on Windows the window in front, as the foreground hook tells it (edge.rs).
        #[cfg(target_os = "macos")]
        if let WindowEvent::Focused(key) = event {
            focused(&handle, label, *key);
        }
        if let WindowEvent::Destroyed = event {
            with(|st| st.shown.retain(|l| l != label));
            HOME.lock().unwrap().retain(|(l, _)| l != label);
            crate::forget_page(&handle, label);
            crate::presence::closed(&handle, label);
            #[cfg(target_os = "macos")]
            focused(&handle, label, false);
            if let Some(project) = label.strip_prefix(PREFIX).filter(|_| !QUITTING.load(Ordering::Relaxed)) {
                put_back(&handle, project);
            }
            save();
        }
    });
    // And whether any of it can be seen: on the Mac a window on another Space can stay the key window of the active
    // app (presence.rs `seen`); on Windows the window in front is asked as it is minimised and put back (edge.rs).
    #[cfg(target_os = "macos")]
    if let Ok(ptr) = window.ns_window() {
        let (handle, label) = (app.clone(), label.clone());
        crate::native::watch_seen(ptr as usize, move |seen| crate::presence::seen(&handle, &label, seen));
    }
    // Shown once the page has drawn, or after 3 s if it never says so.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || ready(&inner, &label, "fallback"));
    });
    Ok(())
}

/// A window took the keyboard, or lost it (the Mac). Where it went to another of Tasktap's windows, that window says
/// so at once and nothing was ever in between: the one that has it is looked at a moment after the other let go.
#[cfg(target_os = "macos")]
fn focused(app: &AppHandle, label: &str, key: bool) {
    if key {
        return crate::presence::told(app, None, Some(Some(label)));
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(40));
        let inner = app.clone();
        let _ = app.run_on_main_thread(move || {
            let has =
                inner.webview_windows().into_iter().find(|(l, w)| is_window(l) && w.is_focused().unwrap_or(false));
            crate::presence::told(&inner, None, Some(has.as_ref().map(|(l, _)| l.as_str())));
        });
    });
}

/// Where a window of its own stood, or where the main window did.
fn frame_of(label: &str) -> Option<[f64; 4]> {
    with(|st| match label.strip_prefix(PREFIX) {
        Some(project) => st.settings.windows.iter().find(|w| w.project == project).and_then(|w| w.frame),
        None => st.settings.frame,
    })
}

/// The projects whose windows are shown now: the workspaces that are out.
fn out() -> Vec<String> {
    with(|st| {
        let shown = |w: &&Out| st.shown.contains(&label_of(&w.project));
        st.settings.windows.iter().filter(shown).map(|w| w.project.clone()).collect()
    })
}

/// The main window's page hears which workspaces are out, and which came back (`back`: it shows it).
fn tell_out(app: &AppHandle, back: Option<&str>) {
    let _ = app.emit_to(LABEL, "ui", json!({"do": "windows", "out": out(), "back": back}));
}

/// A workspace's window is gone and the app is not: the workspace is in the main window again, which is brought forward
/// if it is there. Nothing in it stops.
fn put_back(app: &AppHandle, project: &str) {
    with(|st| st.settings.windows.retain(|w| w.project != project));
    tell_out(app, Some(project));
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Takes a workspace out of the main window into a window of its own, which stands over the main window's
/// content area (`size`) a little to its side, so that its terminals keep their size. The main window lets go of the
/// workspace when this one is shown (`ready`).
fn pop(app: &AppHandle, project: &str, size: Option<(f64, f64)>) -> Result<(), String> {
    let label = label_of(project);
    if app.get_webview_window(&label).is_some() {
        return raise(app, &label, None).map_err(|e| e.to_string());
    }
    let frame = app.get_webview_window(LABEL).and_then(|main| {
        let (pos, scale) = (main.outer_position().ok()?, main.scale_factor().ok()?);
        let at = pos.to_logical::<f64>(scale);
        size.map(|(w, h)| [at.x + 32.0, at.y + 32.0, w, h])
    });
    with(|st| {
        st.settings.windows.retain(|w| w.project != project);
        st.settings.windows.push(Out { project: project.to_owned(), frame });
    });
    save();
    raise(app, &label, None).map_err(|e| {
        with(|st| st.settings.windows.retain(|w| w.project != project));
        e.to_string()
    })
}

/// `host.ready`: the page has drawn its first frame; the window appears with it, not blank. `by` says which showed it:
/// the page (`ready`) or the fallback 3 s after the window was made (`fallback`). A workspace's window shown tells the
/// main window, which lets go of the workspace, and starts the next window that was open at the last quit.
pub fn ready(app: &AppHandle, label: &str, by: &str) {
    let Some(window) = app.get_webview_window(label) else { return };
    if with(|st| {
        st.shown.iter().any(|l| l == label) || {
            st.shown.push(label.to_owned());
            false
        }
    }) {
        return;
    }
    let passive = notch::NOTCH.lock().unwrap().passive;
    let _ = window.show();
    if !passive {
        let _ = window.set_focus();
    }
    println!("{}", json!({"event": "window", "label": label, "ms": crate::since_start(), "by": by}));
    if label.starts_with(PREFIX) {
        tell_out(app, None);
    }
    // The tab's page is made after the window's first picture, not before it.
    #[cfg(windows)]
    if label == LABEL {
        crate::edge::ready(app);
    }
    let next = with(|st| (!st.queue.is_empty()).then(|| st.queue.remove(0)));
    if let Some(project) = next {
        let _ = raise(app, &label_of(&project), None);
    }
}

/// The window's frame in points, kept in memory as it changes and written at close and at quit.
fn remember(label: &str) {
    let Some(app) = crate::APP.get() else { return };
    let Some(window) = app.get_webview_window(label) else { return };
    let (Ok(pos), Ok(size), Ok(scale)) = (window.outer_position(), window.inner_size(), window.scale_factor()) else {
        return;
    };
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let p = pos.to_logical::<f64>(scale);
    let s: LogicalSize<f64> = size.to_logical(scale);
    let frame = Some([p.x, p.y, s.width, s.height]);
    with(|st| match label.strip_prefix(PREFIX) {
        Some(project) => st.settings.windows.iter_mut().filter(|w| w.project == project).for_each(|w| w.frame = frame),
        None => st.settings.frame = frame,
    });
}
pub fn quit() {
    QUITTING.store(true, Ordering::Relaxed);
    if let Some(app) = crate::APP.get() {
        for label in app.webview_windows().keys().filter(|l| is_window(l)) {
            remember(label);
        }
    }
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

/// `host.window`, for the window whose page asks (`page`): `do` minimize, maximize or close, for the page's own caption
/// buttons and its menu (Windows; the buttons' window in chrome.rs does the same for the pointer); `quit`, for the
/// menu's Exit: closing the window leaves the app in the notification area, as it leaves the notch on a Mac. And
/// `pop {project, w, h}`: the workspace goes out into a window of its own; `front {project, at?}`: that window comes
/// forward, at `at`; `title {text}`: the window's name, the project's; `out`: the projects whose windows are shown;
/// `menu {id}`: a command that only the main window carries out.
pub fn window(app: &AppHandle, page: &str, args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let what = args["do"].as_str().unwrap_or_default();
    let project = args["project"].as_str().filter(|p| !p.is_empty() && *p != "loose");
    match (what, project) {
        ("quit", _) => {
            quit();
            app.exit(0);
            return Ok(serde_json::Value::Null);
        }
        ("out", _) => return Ok(json!(out())),
        ("menu", _) => {
            on_menu(app, args["id"].as_str().unwrap_or_default());
            return Ok(serde_json::Value::Null);
        }
        ("pop", Some(project)) => {
            let size = args["w"].as_f64().zip(args["h"].as_f64());
            return pop(app, project, size).map(|_| serde_json::Value::Null);
        }
        ("front", Some(project)) => {
            return raise(app, &label_of(project), args["at"].as_str())
                .map(|_| serde_json::Value::Null)
                .map_err(|e| e.to_string());
        }
        _ => {}
    }
    let window = app.get_webview_window(page).ok_or("the window is not open")?;
    match what {
        "minimize" => window.minimize(),
        "maximize" if window.is_maximized().unwrap_or(false) => window.unmaximize(),
        "maximize" => window.maximize(),
        "close" => window.close(),
        "title" => window.set_title(args["text"].as_str().unwrap_or("Tasktap")),
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
                    &item("pop-out", "Open Workspace in New Window", Some("CmdOrCtrl+Shift+N"))?,
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

/// A menu command: the window's own are its page's, the window being the one that has or last had the keyboard; New
/// Task and New Terminal open it first; Open Workspace and Settings are the main window's. Commands for a tab act
/// only while a workspace window is the key window, so ⌘W in the notch never closes a tab behind it.
pub fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "show" => drop(show(app, None)),
        "new-task" | "new-terminal" => {
            let label = keyed(app);
            let _ = raise(app, &label, None);
            let _ = app.emit_to(&label, "ui", json!({"do": "menu", "id": id}));
        }
        "open-workspace" | "settings" => {
            let _ = show(app, None);
            let _ = app.emit_to(LABEL, "ui", json!({"do": "menu", "id": id}));
        }
        _ => {
            if crate::presence::front() {
                let _ = app.emit_to(keyed(app), "ui", json!({"do": "menu", "id": id}));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workspace_window_is_named_by_its_project_and_no_other_page_is_a_workspace_window() {
        assert_eq!(label_of("p1"), "ws-p1");
        assert!(is_window(LABEL) && is_window("ws-p1"));
        assert!(!is_window("notch"));
    }

    #[test]
    fn the_windows_that_were_out_are_kept_with_their_frames_and_an_older_file_has_none() {
        let kept = Settings {
            windows: vec![Out { project: "p1".into(), frame: Some([1.0, 2.0, 3.0, 4.0]) }],
            ..Default::default()
        };
        let back: Settings = serde_json::from_slice(&serde_json::to_vec(&kept).unwrap()).unwrap();
        assert_eq!((back.windows[0].project.as_str(), back.windows[0].frame), ("p1", Some([1.0, 2.0, 3.0, 4.0])));
        let older: Settings = serde_json::from_str(r#"{"frame":[0,0,9,9]}"#).unwrap();
        assert!(older.windows.is_empty());
        assert!(!serde_json::to_string(&older).unwrap().contains("windows"));
    }
}
