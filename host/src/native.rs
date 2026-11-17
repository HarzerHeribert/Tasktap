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
        p.setCollectionBehavior(Behavior::CanJoinAllSpaces | Behavior::FullScreenAuxiliary);
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
pub fn frame(ptr: usize) -> Rect {
    rect(panel(ptr).frame())
}
pub fn set_frame(ptr: usize, r: Rect) {
    let target = NSRect::new(NSPoint::new(r.x, r.y), NSSize::new(r.w, r.h));
    if panel(ptr).frame() != target {
        panel(ptr).setFrame_display(target, true)
    }
}
pub fn show(ptr: usize) {
    panel(ptr).orderFrontRegardless()
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
/// Whether this app is the active one, as other apps see it (not `NSApp.isActive`, which a key
/// non-activating panel also sets; see trials/tauri-notch/RESULT.md).
pub fn app_active() -> bool {
    objc2_app_kit::NSRunningApplication::currentApplication().isActive()
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
            "io.github.harzerheribert.tasktap.next.checks",
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

/// A folder panel, in front of every app; the person chose to open it.
pub fn pick_folder() -> Option<PathBuf> {
    let mtm = mtm();
    let open = NSOpenPanel::openPanel(mtm);
    open.setCanChooseDirectories(true);
    open.setCanChooseFiles(false);
    open.setAllowsMultipleSelection(false);
    open.setCanCreateDirectories(true);
    // The panel needs this app active; the app the person was in gets it back afterwards, so the
    // notch can take the keyboard again without activating anything.
    let previous = objc2_app_kit::NSWorkspace::sharedWorkspace().frontmostApplication();
    #[allow(deprecated)]
    NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
    let chosen = open.runModal() == NSModalResponseOK;
    #[allow(deprecated)]
    if let Some(app) = previous {
        app.activateWithOptions(objc2_app_kit::NSApplicationActivationOptions::empty());
    }
    chosen.then(|| open.URL().and_then(|url| url.path()).map(|p| PathBuf::from(p.to_string()))).flatten()
}
