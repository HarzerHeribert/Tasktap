// Helper for the Tauri notch trial. Built together with the 1.2 sources it compares against:
// native/NotchGeometry.swift, native/WorkspaceDecisionRim.swift and native/WorkspaceBackdrop.swift.
import AppKit
import ApplicationServices
import WebKit

let args = Array(CommandLine.arguments.dropFirst())
let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
func cg(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: primaryTop - y) } // AppKit points to CG global
func num(_ i: Int) -> Double { Double(args.count > i ? args[i] : "") ?? 0 }
func json(_ value: Any) { print(String(data: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!) }
func f(_ r: CGRect) -> String { String(format: "%.3f,%.3f,%.3f,%.3f", r.minX, r.minY, r.width, r.height) }
func line(_ name: String, _ g: NotchGeometry) -> String {
    "\(name) tab=\(f(g.tab)) cut=\(g.hasCutout ? 1 : 0) compact=\(g.compact ? 1 : 0) corner=\(String(format: "%.3f", g.corner)) rim=\(String(format: "%.3f", g.rimOffset)) "
        + "collapsed=\(f(g.panelFrame(collapsed: true, requestedHeight: 200))) open=\(f(g.panelFrame(collapsed: false, requestedHeight: 260))) "
        + "review=\(f(g.panelFrame(collapsed: false, requestedHeight: 540, requestedWidth: 560))) wide=\(f(g.panelFrame(collapsed: false, requestedHeight: 260, requestedWidth: 10_000))) "
        + "tall=\(f(g.panelFrame(collapsed: false, requestedHeight: 10_000)))"
}
func post(_ events: [CGEvent?]) { for e in events { e?.post(tap: .cghidEventTap); usleep(30_000) } }

final class Bench: NSObject, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    var web: WKWebView!
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let body = m.body as? [String: Any], let type = body["type"] as? String else { return }
        if ProcessInfo.processInfo.environment["TRIAL_DEBUG"] != nil { FileHandle.standardError.write("message \(type) \(body["size"] ?? "")\n".data(using: .utf8)!) }
        switch type {
        case "push": // 1.2 terminal output: base64 in JSON events, delivered with callAsyncJavaScript, awaited per batch.
            let size = body["size"] as! Int, frames = body["frames"] as! Int
            let events: [[String: Any]] = [["event": "output", "id": "bench", "data": Data(repeating: 97, count: size).base64EncodedString()]]
            var left = frames
            func next() {
                guard left > 0 else { return }
                left -= 1
                web.callAsyncJavaScript("return await receive(events)", arguments: ["events": events], in: nil, in: .page) { _ in next() }
            }
            if body["awaited"] as? Bool == true { next() } else { while left > 0 { left -= 1; web.callAsyncJavaScript("return await receive(events)", arguments: ["events": events], in: nil, in: .page) { _ in } } }
        case "key": web.callAsyncJavaScript("echo(k)", arguments: ["k": body["k"] ?? ""], in: nil, in: .page) { _ in }
        case "report": json(["event": "bench", "data": body["data"] ?? [:]]); exit(0)
        default: break
        }
    }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        replyHandler((m.body as? [String: Any])?["k"], nil)
    }
}

func runApp(seconds: Double) {
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { exit(0) }
    NSApplication.shared.run()
}

let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main!
switch args.first ?? "" {
case "locked":
    let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
    print((session["CGSSessionScreenIsLocked"] as? Bool ?? false) ? 1 : 0)
case "access":
    json(["screenCapture": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()])
case "geometry": // The synthetic displays of scripts/verify-notch-geometry.swift.
    func cutout(_ frame: CGRect, width: CGFloat, depth: CGFloat, insetX: CGFloat, scale: CGFloat) -> NotchGeometry {
        let x = frame.minX + insetX, y = frame.maxY - depth
        return NotchGeometry(frame: frame, visible: frame.insetBy(dx: 0, dy: depth), safeTop: depth,
                             left: CGRect(x: frame.minX, y: y, width: insetX, height: depth),
                             right: CGRect(x: x + width, y: y, width: frame.maxX - x - width, height: depth), scale: scale)
    }
    let external = CGRect(x: 1800, y: 350, width: 1920, height: 1080)
    print(line("laptop", cutout(CGRect(x: 0, y: 0, width: 1800, height: 1169), width: 220, depth: 38, insetX: 790, scale: 2)))
    print(line("offset", cutout(CGRect(x: -1512, y: 900, width: 1512, height: 982), width: 180, depth: 32, insetX: 666, scale: 2)))
    print(line("asym", cutout(CGRect(x: 1800, y: -600, width: 1440, height: 900), width: 134.3, depth: 29.1, insetX: 30.2, scale: 2)))
    print(line("external", NotchGeometry(frame: external, visible: CGRect(x: 1800, y: 400, width: 1920, height: 1006), safeTop: 0, left: nil, right: nil, scale: 1)))
    print(line("sidedock", NotchGeometry(frame: external, visible: CGRect(x: 1880, y: 400, width: 1840, height: 1006), safeTop: 0, left: nil, right: nil, scale: 1)))
    for (i, frame) in [CGRect(x: 0, y: 0, width: 1440, height: 900), CGRect(x: -2560, y: -1440, width: 2560, height: 1440), CGRect(x: 0, y: 1080, width: 3840, height: 2160)].enumerated() {
        for top: CGFloat in [0, 24, 38] {
            let visible = CGRect(x: frame.minX, y: frame.minY + 40, width: frame.width, height: frame.height - 40 - top)
            print(line("plain\(i)-\(Int(top))", NotchGeometry(frame: frame, visible: visible, safeTop: 0, left: nil, right: nil, scale: 2)))
        }
    }
case "screens":
    for (i, s) in NSScreen.screens.enumerated() { print(line("screen\(i)", NotchGeometry(screen: s))) }
case "windows": // Every window of a process as the window server reports it (layer = window level).
    let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
    for w in list where (w[kCGWindowOwnerPID as String] as? Int) == Int(num(1)) {
        json(["id": w[kCGWindowNumber as String] ?? 0, "layer": w[kCGWindowLayer as String] ?? 0, "bounds": w[kCGWindowBounds as String] ?? [:],
              "onscreen": w[kCGWindowIsOnscreen as String] ?? false, "alpha": w[kCGWindowAlpha as String] ?? 0, "name": w[kCGWindowName as String] ?? ""])
    }
case "frontmost":
    let app = NSWorkspace.shared.frontmostApplication
    var result: [String: Any] = ["bundle": app?.bundleIdentifier ?? "", "pid": app?.processIdentifier ?? 0, "accessibility": AXIsProcessTrusted()]
    if AXIsProcessTrusted(), let pid = app?.processIdentifier {
        let element = AXUIElementCreateApplication(pid)
        var value: CFTypeRef?
        for (key, attribute) in [("focusedWindow", kAXFocusedWindowAttribute), ("focusedElement", kAXFocusedUIElementAttribute)] {
            guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success, let item = value else { continue }
            var role: CFTypeRef?, title: CFTypeRef?
            AXUIElementCopyAttributeValue(item as! AXUIElement, kAXRoleAttribute as CFString, &role)
            AXUIElementCopyAttributeValue(item as! AXUIElement, kAXTitleAttribute as CFString, &title)
            result[key] = "\(role as? String ?? "?") \(title as? String ?? "")"
        }
    }
    json(result)
case "pointer": let p = NSEvent.mouseLocation; json(["x": p.x, "y": p.y, "top": primaryTop])
case "warp": CGWarpMouseCursorPosition(cg(num(1), num(2)))
case "click":
    let p = cg(num(1), num(2))
    post([CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left),
          CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left),
          CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)])
case "drag": // Press at (x1,y1), drag through (x2,y2), release back at (x1,y1).
    let a = cg(num(1), num(2)), b = cg(num(3), num(4))
    var events: [CGEvent?] = [CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: a, mouseButton: .left)]
    for t in stride(from: 0.0, through: 1.0, by: 0.1) {
        events.append(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t), mouseButton: .left))
    }
    events += Array(repeating: CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: b, mouseButton: .left), count: 10)
    events.append(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: a, mouseButton: .left))
    events.append(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: a, mouseButton: .left))
    post(events)
case "type", "typeonly": // Unicode keystrokes; "type" ends with Return.
    for ch in (args.count > 1 ? args[1] : "").utf16 {
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true), up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        var c = ch
        down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c); up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)
        post([down, up])
    }
    if args[0] == "type" { post([CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: true), CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: false)]) }
case "key": // key CODE [ctrl,alt,cmd,shift]: one press, e.g. "key 49 ctrl,alt" is 1.2's capture shortcut, "key 53" is Escape.
    let mods = args.count > 2 ? args[2] : ""
    var flags = CGEventFlags()
    if mods.contains("ctrl") { flags.insert(.maskControl) }; if mods.contains("alt") { flags.insert(.maskAlternate) }
    if mods.contains("cmd") { flags.insert(.maskCommand) }; if mods.contains("shift") { flags.insert(.maskShift) }
    let down = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(num(1)), keyDown: true), up = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(num(1)), keyDown: false)
    down?.flags = flags; up?.flags = flags
    post([down, up])
case "state": // How the system sees a process. The same outside measurement for the trial and for 1.2.
    let pid = pid_t(num(1)), ws = NSWorkspace.shared
    var focused: CFTypeRef?, focusedPid: pid_t = 0
    if AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &focused) == .success, let f = focused {
        AXUIElementGetPid(f as! AXUIElement, &focusedPid)
    }
    json(["runningActive": NSRunningApplication(processIdentifier: pid)?.isActive ?? false, "frontmost": ws.frontmostApplication?.bundleIdentifier ?? "",
          "menuBarOwner": ws.menuBarOwningApplication?.bundleIdentifier ?? "", "keyboardFocusPid": focusedPid, "keyboardFocusIsTarget": focusedPid == pid])
case "axvalue": // The text of an app's focused element, e.g. the TextEdit document.
    var focused: CFTypeRef?, value: CFTypeRef?
    if AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid_t(num(1))), kAXFocusedUIElementAttribute as CFString, &focused) == .success, let f = focused {
        AXUIElementCopyAttributeValue(f as! AXUIElement, kAXValueAttribute as CFString, &value)
    }
    print(value as? String ?? "")
case "ax": // ax PID [ROLE]: elements with role, label and frame in top-left points, to find a field to click.
    var count = 0
    func walk(_ e: AXUIElement, _ depth: Int) {
        guard depth < 40, count < 600 else { return }
        func attr(_ name: String) -> CFTypeRef? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil }
        let role = attr(kAXRoleAttribute) as? String ?? ""
        var p = CGPoint.zero, s = CGSize.zero
        if let v = attr(kAXPositionAttribute) { AXValueGetValue(v as! AXValue, .cgPoint, &p) }
        if let v = attr(kAXSizeAttribute) { AXValueGetValue(v as! AXValue, .cgSize, &s) }
        if args.count < 3 || role.contains(args[2]) {
            count += 1
            let label = [attr(kAXTitleAttribute), attr(kAXDescriptionAttribute), attr(kAXValueAttribute)].compactMap { $0 as? String }.filter { !$0.isEmpty }.first ?? ""
            json(["role": role, "label": String(label.prefix(40)), "x": p.x, "y": p.y, "w": s.width, "h": s.height,
                  "focused": attr(kAXFocusedAttribute) as? Bool ?? false])
        }
        for child in attr(kAXChildrenAttribute) as? [AXUIElement] ?? [] { walk(child, depth + 1) }
    }
    walk(AXUIElementCreateApplication(pid_t(num(1))), 0)
case "frontwindow": // frontwindow PID [TITLE]: the frontmost normal window of a process, optionally by title prefix.
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    print(list.first { ($0[kCGWindowOwnerPID as String] as? Int) == Int(num(1)) && ($0[kCGWindowLayer as String] as? Int) == 0
        && (args.count < 3 || (($0[kCGWindowName as String] as? String) ?? "").hasPrefix(args[2])) }?[kCGWindowNumber as String] ?? 0)
case "closedoc": // closedoc PID PATH: close the window of an app whose accessibility document is PATH.
    var windows: CFTypeRef?
    AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid_t(num(1))), kAXWindowsAttribute as CFString, &windows)
    for w in windows as? [AXUIElement] ?? [] {
        var doc: CFTypeRef?, button: CFTypeRef?
        AXUIElementCopyAttributeValue(w, kAXDocumentAttribute as CFString, &doc)
        guard let url = doc as? String, URL(string: url)?.path == args[2],
              AXUIElementCopyAttributeValue(w, kAXCloseButtonAttribute as CFString, &button) == .success, let b = button else { continue }
        print(AXUIElementPerformAction(b as! AXUIElement, kAXPressAction as CFString) == .success ? "closed" : "not closed")
    }
case "keylook": // Whether a window shows the key appearance: a red close button at the top left of its capture.
    let file = NSTemporaryDirectory() + "keylook-\(getpid()).png"
    let capture = Process()
    capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture"); capture.arguments = ["-x", "-o", "-l\(Int(num(1)))", file]
    try? capture.run(); capture.waitUntilExit()
    guard let rep = NSBitmapImageRep(data: (try? Data(contentsOf: URL(fileURLWithPath: file))) ?? Data()) else { json(["error": "no capture"]); break }
    var red = 0
    for y in 0..<min(rep.pixelsHigh, 120) { for x in 0..<min(rep.pixelsWide, 200) {
        if let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB), c.redComponent > 0.8, c.greenComponent < 0.5, c.blueComponent < 0.5 { red += 1 }
    } }
    try? FileManager.default.removeItem(atPath: file)
    json(["window": Int(num(1)), "redPixels": red, "keyAppearance": red > 20])
case "panelprobe": // A plain AppKit non-activating panel with a text field, no Tauri: panelprobe accessory|regular SECONDS [HANDBACK].
    NSApplication.shared.setActivationPolicy(args.count > 1 && args[1] == "regular" ? .regular : .accessory)
    final class KeyPanel: NSPanel { override var canBecomeKey: Bool { true } }
    let frame = NSRect(x: screen.frame.midX - 160, y: screen.visibleFrame.maxY - 220, width: 320, height: 90)
    let panel = KeyPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
    let field = NSTextField(frame: NSRect(x: 20, y: 30, width: 280, height: 28))
    panel.contentView?.addSubview(field)
    panel.backgroundColor = .darkGray
    panel.orderFrontRegardless()
    // An optional third argument: after that many seconds, give the key focus back by ordering out and in again.
    if num(3) > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + num(3)) { panel.orderOut(nil); panel.orderFrontRegardless() } }
    json(["event": "panelprobe", "fieldX": frame.minX + 160, "fieldY": frame.minY + 44, "pid": getpid()])
    fflush(stdout)
    runApp(seconds: num(2) > 0 ? num(2) : 30)
case "rim": // The real 1.2 decision rim, for side-by-side captures.
    NSApplication.shared.setActivationPolicy(.accessory)
    let rim = WorkspaceDecisionRim()
    rim.update(screen: screen, visible: true)
    let window = NSApp.windows.first { $0.isVisible }
    json(["event": "rim", "window": window?.windowNumber ?? 0, "frame": f(window?.frame ?? .zero)])
    fflush(stdout)
    runApp(seconds: num(1))
case "backdrop": // The real 1.2 workspace backdrop with its default tint, at top-left (x, y) like the Tauri window.
    NSApplication.shared.setActivationPolicy(.accessory)
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 320), styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
    let backdrop = WorkspaceBackdrop(frame: window.contentLayoutRect)
    window.contentView = backdrop
    let label = NSTextField(labelWithString: "Swift 1.2 backdrop\nWorkspaceBackdrop.swift, tint #0d1117 at 0.93")
    label.alignment = .center; label.textColor = NSColor(white: 0.9, alpha: 1)
    backdrop.host(label)
    window.titleVisibility = .hidden
    window.setFrameTopLeftPoint(NSPoint(x: num(1), y: primaryTop - num(2)))
    window.orderFrontRegardless()
    json(["event": "backdrop", "window": window.windowNumber])
    fflush(stdout)
    runApp(seconds: num(3))
case "bench": // The 1.2 bridge mechanism in a panel shaped like the notch, loading the shared bench page.
    NSApplication.shared.setActivationPolicy(.accessory)
    let bench = Bench(), config = WKWebViewConfiguration()
    config.userContentController.add(bench, name: "bench")
    config.userContentController.addScriptMessageHandler(bench, contentWorld: .page, name: "benchReply")
    config.preferences.inactiveSchedulingPolicy = .none // matches Tauri's background_throttling(Disabled)
    let frame = NotchGeometry(screen: screen).panelFrame(collapsed: true, requestedHeight: 0)
    let panel = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
    bench.web = WKWebView(frame: .zero, configuration: config)
    panel.contentView = bench.web
    panel.orderFrontRegardless()
    let page = URL(fileURLWithPath: args[1])
    bench.web.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    runApp(seconds: 240)
default:
    print("usage: trialtool locked|access|geometry|screens|windows PID|frontmost|state PID|ax PID [ROLE]|axvalue PID|frontwindow PID|closedoc PID PATH|keylook WINDOW|key CODE [MODS]|typeonly TEXT|panelprobe POLICY SECONDS|pointer|warp X Y|click X Y|drag X1 Y1 X2 Y2|type TEXT|rim SECONDS|backdrop X Y SECONDS|bench PAGE")
}
