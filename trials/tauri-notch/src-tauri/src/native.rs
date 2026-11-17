//! The native code the notch still needs under Tauri: a real non-activating NSPanel that hosts
//! Tauri's WKWebView, placement in AppKit points, and pointer and focus state.
#![allow(unused_unsafe)]
use crate::geometry::{Geometry, Rect};
use objc2::{define_class, msg_send, rc::Retained, runtime::{Bool, Sel}, sel, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSApplication, NSBackingStoreType, NSColor, NSEvent, NSPanel, NSResponder, NSScreen, NSStatusWindowLevel, NSView,
    NSWindow, NSWindowCollectionBehavior as Behavior, NSWindowStyleMask as Style, NSWorkspace};
use objc2_foundation::{NSObject, NSPoint, NSRect, NSSize};
use serde_json::{json, Value};

define_class!(
    // NotchPanel in main.swift: borderless panels refuse key status unless a subclass allows it.
    #[unsafe(super(NSPanel, NSWindow, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "TrialNotchPanel"]
    struct NotchPanel;
    impl NotchPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key(&self) -> bool { true }
        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main(&self) -> bool { false }
    }
);

pub fn panel(ptr: usize) -> &'static NSPanel { unsafe { &*(ptr as *const NSPanel) } }

/// Creates the panel as main.swift does and moves Tauri's WKWebView into it. AppKit sets the
/// window server's activation-prevention tag only when a panel is created non-activating, so
/// re-classing Tauri's NSWindow (the tauri-nspanel route) needs the private _setPreventsActivation:.
pub fn make_panel(mtm: MainThreadMarker, webview: usize) -> usize {
    unsafe {
        let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(246.0, 54.0));
        let p: Retained<NotchPanel> = msg_send![NotchPanel::alloc(mtm), initWithContentRect: rect,
            styleMask: Style::Borderless | Style::NonactivatingPanel, backing: NSBackingStoreType::Buffered, defer: false];
        p.setReleasedWhenClosed(false);
        p.setFloatingPanel(true);
        p.setHidesOnDeactivate(false);
        p.setLevel(NSStatusWindowLevel + 1);
        p.setCollectionBehavior(Behavior::CanJoinAllSpaces | Behavior::FullScreenAuxiliary);
        p.setBackgroundColor(Some(&NSColor::clearColor()));
        p.setOpaque(false);
        p.setHasShadow(false);
        let view = &*(webview as *const NSView);
        view.removeFromSuperview();
        p.setContentView(Some(view));
        Retained::into_raw(p) as usize
    }
}

fn rect(r: NSRect) -> Rect { Rect { x: r.origin.x, y: r.origin.y, w: r.size.width, h: r.size.height } }

pub fn geometry(s: &NSScreen) -> Geometry {
    Geometry::new(rect(s.frame()), rect(s.visibleFrame()), s.safeAreaInsets().top,
        rect(s.auxiliaryTopLeftArea()), rect(s.auxiliaryTopRightArea()), s.backingScaleFactor())
}
pub fn screens(mtm: MainThreadMarker) -> Vec<Retained<NSScreen>> { NSScreen::screens(mtm).iter().collect() }
pub fn screen_frame(s: &NSScreen) -> Rect { rect(s.frame()) }
pub fn pointer() -> (f64, f64, bool) { let p = NSEvent::mouseLocation(); (p.x, p.y, NSEvent::pressedMouseButtons() != 0) }
pub fn frame(ptr: usize) -> Rect { rect(panel(ptr).frame()) }
pub fn set_frame(ptr: usize, r: Rect) {
    let target = NSRect::new(NSPoint::new(r.x, r.y), NSSize::new(r.w, r.h));
    if panel(ptr).frame() != target { panel(ptr).setFrame_display(target, true) }
}
pub fn ignore_mouse(ptr: usize, ignore: bool) { if panel(ptr).ignoresMouseEvents() != ignore { panel(ptr).setIgnoresMouseEvents(ignore) } }
/// The 1.2 shortcut path: panel.orderFrontRegardless(); panel.makeKey() without activating the app.
pub fn make_key(ptr: usize) { panel(ptr).orderFrontRegardless(); panel(ptr).makeKeyWindow() }
pub fn reduce_transparency() -> bool { NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceTransparency() }

pub fn focus(mtm: MainThreadMarker, ptr: usize) -> Value {
    let front = NSWorkspace::sharedWorkspace().frontmostApplication();
    json!({"frontmost": front.as_ref().and_then(|a| a.bundleIdentifier()).map(|s| s.to_string()),
        "frontmostPid": front.map(|a| a.processIdentifier()), "appActive": NSApplication::sharedApplication(mtm).isActive(),
        "panelKey": panel(ptr).isKeyWindow()})
}

pub fn probe(ptr: usize) -> Value {
    let p = panel(ptr);
    // Diagnostic only, never used to drive behavior: AppKit's private flag behind the non-activating style.
    let private: Option<bool> = unsafe {
        let s: Sel = sel!(_preventsActivation);
        let responds: bool = msg_send![p, respondsToSelector: s];
        if responds { let b: Bool = msg_send![p, _preventsActivation]; Some(b.as_bool()) } else { None }
    };
    json!({"class": p.class().name().to_string_lossy(), "level": p.level(), "collectionBehavior": p.collectionBehavior().0,
        "styleMask": p.styleMask().0, "nonactivating": p.styleMask().contains(Style::NonactivatingPanel),
        "floatingPanel": p.isFloatingPanel(), "hidesOnDeactivate": p.hidesOnDeactivate(), "hasShadow": p.hasShadow(),
        "opaque": p.isOpaque(), "canBecomeKey": p.canBecomeKeyWindow(), "becomesKeyOnlyIfNeeded": p.becomesKeyOnlyIfNeeded(),
        "windowNumber": p.windowNumber(), "frame": frame(ptr).text(), "visible": p.isVisible(),
        "preventsActivationPrivateDiagnostic": private})
}
