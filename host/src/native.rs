//! The native code the notch needs under Tauri (from trials/tauri-notch): a real non-activating
//! NSPanel that hosts Tauri's WKWebView, placement in AppKit points, pointer events and the
//! keyboard handed back at fold; plus the folder panel. Public AppKit API only.
use crate::geometry::{Geometry, Rect};
use block2::RcBlock;
use objc2::{define_class, msg_send, rc::Retained, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSBackingStoreType, NSColor, NSEvent, NSEventMask, NSModalResponseOK, NSOpenPanel, NSPanel,
    NSResponder, NSScreen, NSStatusWindowLevel, NSView, NSWindow, NSWindowCollectionBehavior as Behavior,
    NSWindowStyleMask as Style,
};
use objc2_foundation::{NSObject, NSPoint, NSRect, NSSize};
use std::{path::PathBuf, ptr::NonNull};

define_class!(
    // NotchPanel in main.swift: borderless panels refuse key status unless a subclass allows it.
    #[unsafe(super(NSPanel, NSWindow, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "TasktapNotchPanel"]
    struct NotchPanel;
    impl NotchPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key(&self) -> bool { true }
        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main(&self) -> bool { false }
    }
);

pub fn mtm() -> MainThreadMarker {
    MainThreadMarker::new().expect("main thread")
}

fn panel(ptr: usize) -> &'static NSPanel {
    unsafe { &*(ptr as *const NSPanel) }
}

/// Creates the panel non-activating from the start (only then does AppKit keep the app inactive
/// when it becomes key) and moves Tauri's WKWebView into it. Tauri's own window stays hidden.
pub fn make_panel(webview: usize) -> usize {
    unsafe {
        let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(246.0, 54.0));
        let p: Retained<NotchPanel> = msg_send![NotchPanel::alloc(mtm()), initWithContentRect: rect,
            styleMask: Style::Borderless | Style::NonactivatingPanel, backing: NSBackingStoreType::Buffered, defer: false];
        p.setReleasedWhenClosed(false);
        p.setFloatingPanel(true);
        p.setHidesOnDeactivate(false);
        p.setLevel(NSStatusWindowLevel + 1);
        // On every space, and not on a full-screen app's (plan, "Where Tasktap shows itself", rule 6): there it shows
        // only while the person has opened it (`over_full_screen`).
        p.setCollectionBehavior(Behavior::CanJoinAllSpaces);
        p.setBackgroundColor(Some(&NSColor::clearColor()));
        p.setOpaque(false);
        p.setHasShadow(false);
        p.setAcceptsMouseMovedEvents(true);
        let view = &*(webview as *const NSView);
        view.removeFromSuperview();
        p.setContentView(Some(view));
        Retained::into_raw(p) as usize
    }
}

fn rect(r: NSRect) -> Rect {
    Rect { x: r.origin.x, y: r.origin.y, w: r.size.width, h: r.size.height }
}

pub fn geometry(s: &NSScreen) -> Geometry {
    Geometry::new(
        rect(s.frame()),
        rect(s.visibleFrame()),
        s.safeAreaInsets().top,
        rect(s.auxiliaryTopLeftArea()),
        rect(s.auxiliaryTopRightArea()),
        s.backingScaleFactor(),
    )
}
pub fn screens() -> Vec<Retained<NSScreen>> {
    NSScreen::screens(mtm()).iter().collect()
}
pub fn screen_frame(s: &NSScreen) -> Rect {
    rect(s.frame())
}
pub fn pointer() -> (f64, f64, bool) {
    let p = NSEvent::mouseLocation();
    (p.x, p.y, NSEvent::pressedMouseButtons() != 0)
}
/// A screen, as the notch is anchored to one. Every screen of a Mac is in one set of coordinates, the pointer's
/// and the panel's too, so nothing here asks which screen; Windows does (edge.rs).
pub type Screen = Retained<NSScreen>;
pub fn within(_: &NSScreen, x: f64, y: f64) -> (f64, f64) {
    (x, y)
}
/// What only the tab on Windows needs: its outline as a window's shape, a click that gives the open sheet the
/// keyboard, and the pointer read while it is open. A panel has all three from AppKit.
pub fn outline(_: usize, _: &NSScreen, _: &Geometry, _: &[(f64, f64)]) {}
pub fn focusable(_: usize, _: bool) {}
pub fn watching(_: usize, _: bool) {}
/// The panel is put away while Tasktap's window is in front (presence.rs). A full-screen app's space is one it does
/// not join, so there it is not drawn without being hidden.
pub fn hidden(_: usize) -> bool {
    crate::presence::front()
}
/// Whether the panel shows over a full-screen app's space: only while the person has it open there. Ordered out and
/// in again when that changes, so that the system places it anew.
pub fn over_full_screen(ptr: usize, on: bool) {
    let p = panel(ptr);
    let want = if on { Behavior::CanJoinAllSpaces | Behavior::FullScreenAuxiliary } else { Behavior::CanJoinAllSpaces };
    if p.collectionBehavior() != want {
        p.setCollectionBehavior(want);
        if p.isVisible() {
            p.orderOut(None);
            p.orderFrontRegardless();
        }
    }
}
/// Whether a full-screen app or a presentation is in front: what the active app has put into effect for the whole
/// system (full screen, or the menu bar hidden as a presentation hides it), or a full-screen space the folded panel
/// is not on.
pub fn full_screen(ptr: usize) -> bool {
    use objc2_app_kit::NSApplicationPresentationOptions as Options;
    let options = NSApplication::sharedApplication(mtm()).currentSystemPresentationOptions();
    let away = ptr != 0 && {
        let p = panel(ptr);
        p.isVisible() && !p.collectionBehavior().contains(Behavior::FullScreenAuxiliary) && !p.isOnActiveSpace()
    };
    options.intersects(Options::FullScreen | Options::HideMenuBar) || away
}
pub fn frame(ptr: usize, _: &NSScreen) -> Rect {
    rect(panel(ptr).frame())
}
pub fn set_frame(ptr: usize, _: &NSScreen, r: Rect) {
    let target = NSRect::new(NSPoint::new(r.x, r.y), NSSize::new(r.w, r.h));
    if panel(ptr).frame() != target {
        panel(ptr).setFrame_display(target, true)
    }
}
pub fn show(ptr: usize) {
    match hidden(ptr) {
        true => panel(ptr).orderOut(None),
        false => panel(ptr).orderFrontRegardless(),
    }
}
pub fn ignore_mouse(ptr: usize, ignore: bool) {
    if panel(ptr).ignoresMouseEvents() != ignore {
        panel(ptr).setIgnoresMouseEvents(ignore)
    }
}
/// The 1.2 shortcut path: the panel becomes key without activating the app.
pub fn make_key(ptr: usize) {
    panel(ptr).orderFrontRegardless();
    panel(ptr).makeKeyWindow()
}
pub fn is_key(ptr: usize) -> bool {
    panel(ptr).isKeyWindow()
}
/// Ordering the panel out and straight back in hands the keyboard back to the app in use,
/// where 1.2 kept it in the closed notch.
pub fn give_back_key(ptr: usize) {
    let p = panel(ptr);
    if p.isKeyWindow() {
        p.orderOut(None);
        p.orderFrontRegardless()
    }
}
pub fn window_number(ptr: usize) -> isize {
    panel(ptr).windowNumber()
}
/// The number of an ordinary window, as `screencapture -l` takes it.
pub fn ns_window_number(ptr: usize) -> isize {
    unsafe { &*(ptr as *const NSWindow) }.windowNumber()
}
/// Puts a window in front of every app's, without making this app the active one or the window key.
pub fn order_front(ptr: usize) {
    unsafe { &*(ptr as *const NSWindow) }.orderFrontRegardless()
}
/// Puts a window behind every other of its level, where a passive run's window opens.
pub fn order_back(ptr: usize) {
    unsafe { &*(ptr as *const NSWindow) }.orderBack(None)
}
/// Whether this app is the active one, as other apps see it (not `NSApp.isActive`, which a key
/// non-activating panel also sets; see trials/tauri-notch/RESULT.md).
pub fn app_active() -> bool {
    objc2_app_kit::NSRunningApplication::currentApplication().isActive()
}

/// Whether the Mac is in Low Power Mode.
pub fn low_power() -> bool {
    objc2_foundation::NSProcessInfo::processInfo().isLowPowerModeEnabled()
}

/// Calls `changed` on the main thread whenever Low Power Mode begins or ends; nothing runs between.
pub fn watch_power(changed: impl Fn() + 'static) {
    let block = RcBlock::new(move |_: NonNull<objc2_foundation::NSNotification>| changed());
    let center = objc2_foundation::NSNotificationCenter::defaultCenter();
    let name = objc2_foundation::NSString::from_str("NSProcessInfoPowerStateDidChangeNotification");
    let queue = objc2_foundation::NSOperationQueue::mainQueue();
    // The observer lives as long as the app.
    std::mem::forget(unsafe {
        center.addObserverForName_object_queue_usingBlock(Some(&name), None, Some(&queue), &block)
    });
}

/// Calls `changed` on the main thread with each of the system's own notices `names` (from the app's notification
/// centre, or with `workspace` the workspace's); nothing runs between. The observers live as long as the app.
fn observe(
    names: &[&str],
    object: Option<&objc2::runtime::AnyObject>,
    workspace: bool,
    changed: impl Fn(&str) + 'static,
) {
    let changed = std::rc::Rc::new(changed);
    let center = match workspace {
        true => objc2_app_kit::NSWorkspace::sharedWorkspace().notificationCenter(),
        false => objc2_foundation::NSNotificationCenter::defaultCenter(),
    };
    let queue = objc2_foundation::NSOperationQueue::mainQueue();
    for name in names {
        let (told, said) = (changed.clone(), name.to_string());
        let block = RcBlock::new(move |_: NonNull<objc2_foundation::NSNotification>| told(&said));
        let name = objc2_foundation::NSString::from_str(name);
        // SAFETY: the block takes the notification as AppKit hands it, on the main queue.
        std::mem::forget(unsafe {
            center.addObserverForName_object_queue_usingBlock(Some(&name), object, Some(&queue), &block)
        });
    }
}

/// Calls `changed` with whether the window `ptr` can be seen at all, whenever AppKit says that changed: none of it is
/// on screen while it is minimised, hidden with the app, on another Space, or wholly covered. The app can stay the
/// active one, and the window the key one, through a switch to an empty Space. The observer lives as long as the app,
/// and hears only that window.
pub fn watch_seen(ptr: usize, changed: impl Fn(bool) + 'static) {
    let block = RcBlock::new(move |notice: NonNull<objc2_foundation::NSNotification>| {
        // SAFETY: AppKit hands the notice on the main queue; its object is the window it is about, alive while it says so.
        let window = unsafe { notice.as_ref() }.object().and_then(|o| o.downcast::<NSWindow>().ok());
        changed(window.is_none_or(|w| w.occlusionState().contains(objc2_app_kit::NSWindowOcclusionState::Visible)));
    });
    let center = objc2_foundation::NSNotificationCenter::defaultCenter();
    let name = objc2_foundation::NSString::from_str("NSWindowDidChangeOcclusionStateNotification");
    let queue = objc2_foundation::NSOperationQueue::mainQueue();
    let object: &objc2::runtime::AnyObject = unsafe { &*(ptr as *const NSWindow) }.as_ref();
    // SAFETY: the block takes the notification as AppKit hands it, on the main queue.
    std::mem::forget(unsafe {
        center.addObserverForName_object_queue_usingBlock(Some(&name), Some(object), Some(&queue), &block)
    });
}

/// Calls `changed` when this app becomes the active one (true) or stops being it (false), as the system says it: a
/// non-activating panel taking the keyboard is neither.
pub fn watch_active(changed: impl Fn(bool) + 'static) {
    let names = ["NSApplicationDidBecomeActiveNotification", "NSApplicationDidResignActiveNotification"];
    observe(&names, None, false, move |name| changed(name == names[0]));
}

/// Calls `changed` when the space in front or the app in front changes: when a full-screen app may have come or gone.
pub fn watch_spaces(changed: impl Fn() + 'static) {
    let names = ["NSWorkspaceActiveSpaceDidChangeNotification", "NSWorkspaceDidActivateApplicationNotification"];
    observe(&names, None, true, move |_| changed());
}

/// Calls `elsewhere` when the person clicks anywhere outside this app (a global monitor sees only other apps'
/// events), and when the panel loses the keyboard: what folds an open sheet on Windows folds the notch here too.
pub fn watch_elsewhere(ptr: usize, elsewhere: impl Fn() + 'static) {
    let elsewhere = std::rc::Rc::new(elsewhere);
    let clicked = elsewhere.clone();
    let mask = NSEventMask::LeftMouseDown | NSEventMask::RightMouseDown | NSEventMask::OtherMouseDown;
    let block = RcBlock::new(move |_: NonNull<NSEvent>| clicked());
    std::mem::forget(NSEvent::addGlobalMonitorForEventsMatchingMask_handler(mask, &block));
    let object: &objc2::runtime::AnyObject = panel(ptr).as_ref();
    observe(&["NSWindowDidResignKeyNotification"], Some(object), false, move |_| elsewhere());
}

/// The folder panel is open: the keyboard going to it is not the keyboard going elsewhere.
static PICKING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub fn picking() -> bool {
    PICKING.load(std::sync::atomic::Ordering::Relaxed)
}

/// Calls `moved` on the main thread for every pointer move or drag, in any app; nothing runs
/// while the pointer rests. Global monitors see events sent to other apps, the local one ours.
pub fn watch_pointer(moved: impl Fn() + 'static) {
    let mask = NSEventMask::MouseMoved
        | NSEventMask::LeftMouseDragged
        | NSEventMask::RightMouseDragged
        | NSEventMask::OtherMouseDragged
        | NSEventMask::LeftMouseUp;
    let moved = std::rc::Rc::new(moved);
    let other = moved.clone();
    let global = RcBlock::new(move |_: NonNull<NSEvent>| other());
    let local = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        moved();
        event.as_ptr()
    });
    // The monitors live as long as the app; AppKit keeps them.
    std::mem::forget(NSEvent::addGlobalMonitorForEventsMatchingMask_handler(mask, &global));
    std::mem::forget(unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &local) });
}

/// The clipboard's text, or with `text`, the clipboard set to it (the workspace's Copy and Paste
/// buttons; ⌘C and ⌘V go through the Edit menu).
pub fn clipboard(text: Option<&str>, private: bool) -> Option<String> {
    // A passive run (the checks) uses a pasteboard of its own, never the person's.
    let board = if private {
        objc2_app_kit::NSPasteboard::pasteboardWithName(&objc2_foundation::NSString::from_str(
            "io.github.harzerheribert.tasktap.checks",
        ))
    } else {
        objc2_app_kit::NSPasteboard::generalPasteboard()
    };
    // SAFETY: a constant AppKit exports.
    let kind = unsafe { objc2_app_kit::NSPasteboardTypeString };
    match text {
        Some(text) => {
            board.clearContents();
            board.setString_forType(&objc2_foundation::NSString::from_str(text), kind);
            None
        }
        None => board.stringForType(kind).map(|s| s.to_string()),
    }
}

/// A picture of a page as its web view draws it now, written to `path` as PNG at the display's own scale, then
/// `done`. The app pictures its own view, so a check's captures need no screen recording permission.
pub fn snapshot(webview: *mut std::ffi::c_void, path: PathBuf, done: impl Fn(bool) + 'static) {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    let written = RcBlock::new(move |image: *mut NSImage, _error: *mut AnyObject| {
        // SAFETY: WebKit hands the block an NSImage or nil.
        let png = unsafe { image.as_ref() }.and_then(|image| {
            let tiff = image.TIFFRepresentation()?;
            let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
            // SAFETY: PNG takes no properties.
            unsafe {
                rep.representationUsingType_properties(
                    NSBitmapImageFileType::PNG,
                    &objc2_foundation::NSDictionary::new(),
                )
            }
        });
        done(png.is_some_and(|png| std::fs::write(&path, png.to_vec()).is_ok()));
    });
    // SAFETY: `webview` is the window's WKWebView; a nil configuration pictures all of it.
    let _: () = unsafe {
        msg_send![webview as *mut AnyObject, takeSnapshotWithConfiguration: std::ptr::null::<AnyObject>(), completionHandler: &*written]
    };
}

/// Tab reaches every control of the app's own pages, its buttons too, and not only its fields: a WKWebView leaves
/// buttons and links out of Tab's reach unless the person turned on the system's keyboard navigation, and every
/// control of the pages is a button (the review found the Composer's chip, agent control and microphone out of reach).
/// WKPreferences `tabFocusesLinks` is the web view's own word for it; the page's preferences follow it at once.
pub fn tab_to_controls(webview: *mut std::ffi::c_void) {
    use objc2::runtime::AnyObject;
    // SAFETY: `webview` is the window's WKWebView; its configuration holds the preferences its pages run under, the
    // same object the view keeps, so setting one there sets it for the view.
    unsafe {
        let configuration: *mut AnyObject = msg_send![webview as *mut AnyObject, configuration];
        let preferences: *mut AnyObject = msg_send![configuration, preferences];
        let _: () = msg_send![preferences, setTabFocusesLinks: true];
    }
}

/// Tab (Shift-Tab with `back`) pressed in a web view, handed to that view as the keyboard would hand it, and to nothing
/// else: the debug channel's `tabkey`, so a check sees where Tab takes the keyboard in the app's own engine without
/// the system's keyboard or the app in front.
pub fn press_tab(webview: *mut std::ffi::c_void, back: bool) {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSEventModifierFlags, NSEventType};
    let tab = objc2_foundation::NSString::from_str("\t");
    let flags = if back { NSEventModifierFlags::Shift } else { NSEventModifierFlags::empty() };
    // SAFETY: `webview` is the window's WKWebView, an NSView in that window; a key event made for its window.
    unsafe {
        let window: *mut AnyObject = msg_send![webview as *mut AnyObject, window];
        let number: isize = if window.is_null() { 0 } else { msg_send![window, windowNumber] };
        // The view is its window's first responder, as it is once clicked: within the window only, the app in front
        // and the system's keyboard untouched.
        if !window.is_null() {
            let _: bool = msg_send![window, makeFirstResponder: webview as *mut AnyObject];
        }
        for down in [true, false] {
            let kind = if down { NSEventType::KeyDown } else { NSEventType::KeyUp };
            let Some(event) = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                kind, NSPoint::new(0.0, 0.0), flags, 0.0, number, None, &tab, &tab, false, 48,
            ) else {
                continue;
            };
            if down {
                let _: () = msg_send![webview as *mut AnyObject, keyDown: &*event];
            } else {
                let _: () = msg_send![webview as *mut AnyObject, keyUp: &*event];
            }
        }
    }
}

/// Holds a web view to `rules`, a content rule list (frames.rs): compiled into `store`, a folder of this app's data,
/// and added to the view's own controller, so it holds for every load in every frame from then on. `done` hears
/// whether it holds.
pub fn confine(webview: *mut std::ffi::c_void, rules: &str, store: &std::path::Path, done: impl Fn(bool) + 'static) {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSString, NSURL};
    let view = webview as usize;
    let compiled = RcBlock::new(move |list: *mut AnyObject, _error: *mut AnyObject| {
        if !list.is_null() {
            // SAFETY: `view` is the window's WKWebView, alive as long as its window, and `list` a WKContentRuleList.
            unsafe {
                let configuration: *mut AnyObject = msg_send![view as *mut AnyObject, configuration];
                let controller: *mut AnyObject = msg_send![configuration, userContentController];
                let _: () = msg_send![controller, addContentRuleList: list];
            }
        }
        done(!list.is_null());
    });
    let at = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&store.display().to_string()), true);
    // SAFETY: public WebKit API, on the main thread; the block is copied by the store.
    unsafe {
        let store: *mut AnyObject = msg_send![objc2::class!(WKContentRuleListStore), storeWithURL: &*at];
        let _: () = msg_send![store, compileContentRuleListForIdentifier: &*NSString::from_str("tasktap-frames"),
            encodedContentRuleList: &*NSString::from_str(rules), completionHandler: &*compiled];
    }
}

/// A folder panel, in front of every app; the person chose to open it. It opens in `at` where one is given.
pub fn pick_folder(at: Option<&str>) -> Option<PathBuf> {
    use objc2_foundation::{NSString, NSURL};
    let mtm = mtm();
    let open = NSOpenPanel::openPanel(mtm);
    open.setCanChooseDirectories(true);
    open.setCanChooseFiles(false);
    open.setAllowsMultipleSelection(false);
    open.setCanCreateDirectories(true);
    if let Some(at) = at {
        open.setDirectoryURL(Some(&NSURL::fileURLWithPath_isDirectory(&NSString::from_str(at), true)));
    }
    // The panel needs this app active; the app the person was in gets it back afterwards, so the
    // notch can take the keyboard again without activating anything.
    let previous = objc2_app_kit::NSWorkspace::sharedWorkspace().frontmostApplication();
    #[allow(deprecated)]
    NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
    PICKING.store(true, std::sync::atomic::Ordering::Relaxed);
    let chosen = open.runModal() == NSModalResponseOK;
    PICKING.store(false, std::sync::atomic::Ordering::Relaxed);
    #[allow(deprecated)]
    if let Some(app) = previous {
        app.activateWithOptions(objc2_app_kit::NSApplicationActivationOptions::empty());
    }
    chosen.then(|| open.URL().and_then(|url| url.path()).map(|p| PathBuf::from(p.to_string()))).flatten()
}

/// The places of the keys whose name is what they print, as the Mac numbers them (its virtual key codes) and as a
/// web page does (`KeyboardEvent.code`, WebKit's table): letters, digits and the signs.
#[rustfmt::skip]
const PLACES: [(u16, &str); 50] = [
    (0x00, "KeyA"), (0x01, "KeyS"), (0x02, "KeyD"), (0x03, "KeyF"), (0x04, "KeyH"), (0x05, "KeyG"), (0x06, "KeyZ"),
    (0x07, "KeyX"), (0x08, "KeyC"), (0x09, "KeyV"), (0x0A, "IntlBackslash"), (0x0B, "KeyB"), (0x0C, "KeyQ"),
    (0x0D, "KeyW"), (0x0E, "KeyE"), (0x0F, "KeyR"), (0x10, "KeyY"), (0x11, "KeyT"), (0x12, "Digit1"), (0x13, "Digit2"),
    (0x14, "Digit3"), (0x15, "Digit4"), (0x16, "Digit6"), (0x17, "Digit5"), (0x18, "Equal"), (0x19, "Digit9"),
    (0x1A, "Digit7"), (0x1B, "Minus"), (0x1C, "Digit8"), (0x1D, "Digit0"), (0x1E, "BracketRight"), (0x1F, "KeyO"),
    (0x20, "KeyU"), (0x21, "BracketLeft"), (0x22, "KeyI"), (0x23, "KeyP"), (0x25, "KeyL"), (0x26, "KeyJ"),
    (0x27, "Quote"), (0x28, "KeyK"), (0x29, "Semicolon"), (0x2A, "Backslash"), (0x2B, "Comma"), (0x2C, "Slash"),
    (0x2D, "KeyN"), (0x2E, "KeyM"), (0x2F, "Period"), (0x32, "Backquote"), (0x5D, "IntlYen"), (0x5E, "IntlRo"),
];

/// What each of those keys prints with no modifier, by its place, in the keyboard layout in use (`host.layout`): the
/// page names a key bound by its place as the person's keyboard prints it (keys.ts `learnLayout`), which a Mac's web
/// view cannot say itself. A dead key is given as its mark. Empty when the layout has no Unicode table to read. On
/// the main thread, where the text input sources must be asked.
pub fn layout() -> serde_json::Map<String, serde_json::Value> {
    use std::ffi::c_void;
    #[link(name = "Carbon", kind = "framework")]
    unsafe extern "C" {
        fn TISCopyCurrentKeyboardLayoutInputSource() -> *mut c_void;
        fn TISGetInputSourceProperty(source: *mut c_void, key: *const c_void) -> *const c_void;
        fn LMGetKbdType() -> u8;
        fn UCKeyTranslate(
            layout: *const c_void,
            code: u16,
            action: u16,
            modifiers: u32,
            keyboard: u32,
            options: u32,
            dead: *mut u32,
            most: usize,
            length: *mut usize,
            chars: *mut u16,
        ) -> i32;
        static kTISPropertyUnicodeKeyLayoutData: *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
        fn CFRelease(object: *const c_void);
    }
    // kUCKeyActionDisplay, and kUCKeyTranslateNoDeadKeysMask: a dead key gives its own mark.
    const DISPLAY: u16 = 3;
    const NO_DEAD_KEYS: u32 = 1;
    let mut out = serde_json::Map::new();
    // SAFETY: public Carbon API, on the main thread (`host.layout` is answered there); the source is released once
    // read, and the layout data is the source's, read while it is held.
    unsafe {
        let source = TISCopyCurrentKeyboardLayoutInputSource();
        if source.is_null() {
            return out;
        }
        let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
        if !data.is_null() {
            let table = CFDataGetBytePtr(data) as *const c_void;
            let keyboard = u32::from(LMGetKbdType());
            for (code, place) in PLACES {
                let (mut dead, mut length, mut chars) = (0u32, 0usize, [0u16; 4]);
                let status = UCKeyTranslate(
                    table,
                    code,
                    DISPLAY,
                    0,
                    keyboard,
                    NO_DEAD_KEYS,
                    &mut dead,
                    chars.len(),
                    &mut length,
                    chars.as_mut_ptr(),
                );
                let printed = String::from_utf16_lossy(&chars[..length.min(chars.len())]);
                if status == 0 && printed.chars().count() == 1 && !printed.trim().is_empty() {
                    out.insert(place.into(), printed.to_lowercase().into());
                }
            }
        }
        CFRelease(source);
    }
    out
}
