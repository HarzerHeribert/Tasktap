import AppKit
import ApplicationServices

/// A capture owns an in-memory URL/path snapshot. Later reads only compare freshness;
/// replacing that snapshot requires the person's explicit Refresh / Allow action.
/// No page content, app inventory or permission prompts are collected at capture start.
final class ScreenContext {
    private var observer: NSObjectProtocol?
    private var previousApp: NSRunningApplication?
    private var leftAppAt = Date.distantPast
    struct Source {
        let pid: pid_t
        let bundle: String
        let name: String
    }
    typealias Reader = (pid_t, String, String, Bool) -> [String:String]
    private final class Snapshot {
        let id: String
        let source: Source?
        let observedAt: Date
        var references = [String:[String:String]]()
        // Each capture orders its reads without blocking the microphone or a newer capture.
        let queue = DispatchQueue(label: "tasktap.capture-context", qos: .userInitiated)
        init(id: String, source: Source?, observedAt: Date) {
            self.id = id; self.source = source; self.observedAt = observedAt
        }
    }
    private let reader: Reader
    private var snapshot: Snapshot?
    init(reader: Reader? = nil) { self.reader = reader ?? Self.read }

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
        var app = external(NSWorkspace.shared.frontmostApplication)
        if app == nil, Date().timeIntervalSince(leftAppAt) < 300 { app = external(previousApp) }
        let source = app.map { Source(pid: $0.processIdentifier, bundle: $0.bundleIdentifier ?? "", name: $0.localizedName ?? "Source app") }
        begin(id, source: source)
    }

    // Separate source selection from reading so the freeze can be verified without accessing real apps.
    func begin(_ id: String, source: Source?, at date: Date = Date()) {
        let frozen = Snapshot(id: id, source: source, observedAt: date)
        snapshot = frozen
        frozen.queue.async { [reader] in
            if let source {
                // Read one identity, not two sequential active-item reads that could disagree.
                let result = reader(source.pid, source.bundle, "reference", false)
                for kind in ["website", "file"] {
                    frozen.references[kind] = result["value"] == nil || result["kind"] == kind ? result : [:]
                }
            }
        }
    }

    func resolve(_ id: String, kind: String, allowPermission: Bool, refresh: Bool = false,
                 completion: @escaping ([String:String]) -> Void) {
        guard let frozen = snapshot, frozen.id == id, ["file", "website"].contains(kind) else {
            completion(["message":"Choose the reference you meant."]); return
        }
        frozen.queue.async { [reader] in
            var result = frozen.references[kind] ?? [:]
            let source = frozen.source
            let explicitRead = refresh || allowPermission
            // A granted permission cannot reconstruct a past tab. It deliberately reads the current source.
            if explicitRead, let source {
                result = reader(source.pid, source.bundle, kind, allowPermission)
                if result["value"] != nil {
                    let now = Date()
                    result["observedAt"] = ISO8601DateFormatter().string(from: now)
                    result["origin"] = "refresh"
                    frozen.references[kind] = result
                }
            }
            result["app"] = source?.name ?? "Source app"
            result["sourceID"] = source.map { $0.bundle + ":" + String($0.pid) } ?? ""
            result["observedAt"] = result["observedAt"] ?? ISO8601DateFormatter().string(from: frozen.observedAt)
            result["origin"] = result["origin"] ?? "capture"
            if result["value"] != nil {
                if explicitRead { result["freshness"] = "refreshed" }
                else if let source {
                    let current = reader(source.pid, source.bundle, kind, false)
                    if current["value"] == nil { result["freshness"] = "unavailable" }
                    else if current["value"] != result["value"] { result["freshness"] = "changed" }
                    else {
                        let observed = ISO8601DateFormatter().date(from: result["observedAt"] ?? "") ?? frozen.observedAt
                        result["freshness"] = Date().timeIntervalSince(observed) > 300 ? "stale" : "current"
                    }
                }
            } else if explicitRead {
                result["message"] = result["message"] ?? "The source app did not provide a reference. Enter it below."
            } else {
                // Never substitute a current tab if there was no usable capture-time observation.
                result["message"] = "No reference was available when this capture started. Enter it below, or explicitly read the current source app."
            }
            let reply = result
            DispatchQueue.main.async { completion(reply) }
        }
    }

    private enum ReaderError: Error { case empty }
    private static let chromium: Set<String> = ["com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary", "org.chromium.Chromium", "com.microsoft.edgemac", "com.brave.Browser", "com.vivaldi.Vivaldi"]

    private static func read(pid: pid_t, bundle: String, kind: String, allowPermission: Bool) -> [String:String] {
        let finder = bundle == "com.apple.finder", safari = ["com.apple.Safari", "com.apple.SafariTechnologyPreview"].contains(bundle)
        let fallback = ["message":kind == "file" ? "Choose a file or enter its path." : "Paste the URL of the page you mean."]
        if finder && kind != "file" && kind != "reference" { return fallback }
        if !finder, AXIsProcessTrusted(), let value = focusedDocument(pid), let result = normalized(value, kind: kind) {
            return ["value":result, "kind":kind == "reference" ? (result.hasPrefix("/") ? "file" : "website") : kind]
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
            return ["value":value, "kind":kind == "reference" ? (value.hasPrefix("/") ? "file" : "website") : kind]
        } catch {
            let status = (error as NSError).code
            if status == errAEEventWouldRequireUserConsent { return ["permission":"automation", "message":"Allow macOS Automation to read this reference, or enter it below."] }
            if status == errAEEventNotPermitted { return ["message":"Automation access is off. Enter the reference or enable access in System Settings."] }
            return fallback
        }
    }

    static func normalized(_ raw: String, kind: String) -> String? {
        if kind == "reference" { return normalized(raw, kind: "file") ?? normalized(raw, kind: "website") }
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
