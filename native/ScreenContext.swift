import AppKit
import ApplicationServices

/// Keeps one source app in memory. Its tab, selection or document is read only for a capture that asks for it.
final class ScreenContext {
    private var observer: NSObjectProtocol?
    private var previousApp: NSRunningApplication?
    private var leftAppAt = Date.distantPast
    private var captureID = ""
    private var source: NSRunningApplication?

    private func external(_ app: NSRunningApplication?) -> NSRunningApplication? {
        guard let app, !app.isTerminated, app.activationPolicy == .regular,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return nil }
        return app
    }

    func start() {
        previousApp = external(NSWorkspace.shared.frontmostApplication)
        observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
            object: nil, queue: .main) { [weak self] note in
            guard let self else { return }
            if let app = self.external(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication) {
                self.previousApp = app
            }
            self.leftAppAt = Date()
        }
    }

    func begin(_ id: String) {
        captureID = id
        source = external(NSWorkspace.shared.frontmostApplication)
        if source == nil, Date().timeIntervalSince(leftAppAt) < 300 { source = external(previousApp) }
    }

    func resolve(_ id: String, kind: String, allowPermission: Bool, completion: @escaping ([String:String]) -> Void) {
        guard id == captureID, ["file", "website"].contains(kind), let app = source, !app.isTerminated else {
            completion(["message":"Choose the reference you meant."]); return
        }
        let name = app.localizedName ?? "Source app", bundle = app.bundleIdentifier ?? "", pid = app.processIdentifier
        DispatchQueue.global(qos: .userInitiated).async {
            var result = Self.read(pid: pid, bundle: bundle, kind: kind, allowPermission: allowPermission)
            result["app"] = name
            let reply = result
            DispatchQueue.main.async { completion(reply) }
        }
    }

    private enum ReaderError: Error { case empty }
    private static let chromium: Set<String> = ["com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary", "org.chromium.Chromium", "com.microsoft.edgemac", "com.brave.Browser", "com.vivaldi.Vivaldi"]

    private static func read(pid: pid_t, bundle: String, kind: String, allowPermission: Bool) -> [String:String] {
        let finder = bundle == "com.apple.finder", safari = ["com.apple.Safari", "com.apple.SafariTechnologyPreview"].contains(bundle)
        let fallback = ["message":kind == "file" ? "Choose a file or enter its path." : "Paste the URL of the page you mean."]
        if finder && kind != "file" { return fallback }
        if !finder, AXIsProcessTrusted(), let value = focusedDocument(pid), let result = normalized(value, kind: kind) {
            return ["value":result, "kind":kind]
        }
        if !finder && !safari && !chromium.contains(bundle) { return fallback }
        let target = NSAppleEventDescriptor(processIdentifier: pid)
        do {
            let raw: String?
            if finder {
                let selection = try get(property("sele"), from: target, allowPermission: allowPermission)
                let item: NSAppleEventDescriptor?
                if selection.descriptorType == typeAEList {
                    guard selection.numberOfItems == 1 else { return ["message":"Choose one file from the Finder selection."] }
                    item = selection.atIndex(1)
                } else { item = selection }
                guard let item else { return fallback }
                raw = try get(property("pURL", of: item), from: target, allowPermission: allowPermission).stringValue
            } else {
                let window = specifier(code("cwin"), form: OSType(formAbsolutePosition), key: NSAppleEventDescriptor(int32: 1), in: .null())
                let tab = property(safari ? "cTab" : "acTa", of: window)
                raw = try get(property(safari ? "pURL" : "URL ", of: tab), from: target, allowPermission: allowPermission).stringValue
            }
            guard let raw, let value = normalized(raw, kind: kind) else { return fallback }
            return ["value":value, "kind":kind]
        } catch {
            let status = (error as NSError).code
            if status == errAEEventWouldRequireUserConsent { return ["permission":"automation", "message":"Allow macOS Automation to read this reference, or enter it below."] }
            if status == errAEEventNotPermitted { return ["message":"Automation access is off. Enter the reference or enable access in System Settings."] }
            return fallback
        }
    }

    static func normalized(_ raw: String, kind: String) -> String? {
        guard raw.utf8.count <= 8192, raw.rangeOfCharacter(from: .controlCharacters) == nil,
              let url = URL(string: raw) else { return nil }
        if kind == "file" {
            guard url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost" else { return nil }
            let path = url.standardizedFileURL.path
            return path.hasPrefix("/") && path.rangeOfCharacter(from: .controlCharacters) == nil ? path : nil
        }
        guard ["https", "http"].contains(url.scheme?.lowercased()), url.host?.isEmpty == false,
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        parts.user = nil; parts.password = nil
        return parts.string
    }

    private static func focusedDocument(_ pid: pid_t) -> String? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.6)
        var window: CFTypeRef?, document: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &window) == .success,
              let window, CFGetTypeID(window) == AXUIElementGetTypeID() else { return nil }
        let element = window as! AXUIElement
        AXUIElementSetMessagingTimeout(element, 0.6)
        guard AXUIElementCopyAttributeValue(element, kAXDocumentAttribute as CFString, &document) == .success else { return nil }
        return document as? String ?? (document as? URL)?.absoluteString
    }

    // These are read-only object specifiers from the Safari, Chromium and Finder scripting dictionaries.
    private static func code(_ text: String) -> OSType { text.utf8.reduce(0) { ($0 << 8) | UInt32($1) } }
    private static func specifier(_ desired: OSType, form: OSType, key: NSAppleEventDescriptor, in parent: NSAppleEventDescriptor) -> NSAppleEventDescriptor {
        let record = NSAppleEventDescriptor.record()
        record.setDescriptor(.init(typeCode: desired), forKeyword: AEKeyword(keyAEDesiredClass))
        record.setDescriptor(.init(enumCode: form), forKeyword: AEKeyword(keyAEKeyForm))
        record.setDescriptor(key, forKeyword: AEKeyword(keyAEKeyData))
        record.setDescriptor(parent, forKeyword: AEKeyword(keyAEContainer))
        return record.coerce(toDescriptorType: typeObjectSpecifier)!
    }
    private static func property(_ name: String, of parent: NSAppleEventDescriptor = .null()) -> NSAppleEventDescriptor {
        specifier(typeProperty, form: OSType(formPropertyID), key: .init(typeCode: code(name)), in: parent)
    }
    private static func get(_ object: NSAppleEventDescriptor, from target: NSAppleEventDescriptor, allowPermission: Bool) throws -> NSAppleEventDescriptor {
        let event = NSAppleEventDescriptor(eventClass: kAECoreSuite, eventID: kAEGetData, targetDescriptor: target,
                                           returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
        event.setParam(object, forKeyword: keyDirectObject)
        var options: NSAppleEventDescriptor.SendOptions = [.waitForReply, .neverInteract]
        if !allowPermission { options.insert(.init(rawValue: UInt(kAEDoNotPromptForUserConsent))) }
        let reply = try event.sendEvent(options: options, timeout: allowPermission ? 60 : 2)
        if let error = reply.paramDescriptor(forKeyword: keyErrorNumber), error.int32Value != 0 {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(error.int32Value))
        }
        guard let result = reply.paramDescriptor(forKeyword: keyDirectObject) else { throw ReaderError.empty }
        return result
    }
    deinit { if let observer { NSWorkspace.shared.notificationCenter.removeObserver(observer) } }
}
