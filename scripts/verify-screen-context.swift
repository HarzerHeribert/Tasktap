// swiftc native/ScreenContext.swift scripts/verify-screen-context.swift -o /tmp/verify-screen-context
// Injected app metadata verifies native capture semantics; it never reads a real app or requests access.
import Foundation

private final class Fixture {
    let lock = NSLock()
    let observed = DispatchSemaphore(value: 0)
    var value: [String:String] = ["kind":"website", "value":"https://example.test/original"]
    var calls: [(String,Bool)] = []
    func set(_ next: [String:String]) { lock.lock();value = next;lock.unlock() }
    func read(_ pid: pid_t, _ bundle: String, _ kind: String, _ permission: Bool) -> [String:String] {
        lock.lock();calls.append((kind,permission));let result = value;lock.unlock()
        if kind == "reference" { observed.signal() }
        return result
    }
    func captured() { precondition(observed.wait(timeout: .now()+3) == .success) }
}

@main struct ContextChecks {
    static let source = ScreenContext.Source(pid: 123, bundle: "test.fixture", name: "Fixture browser")
    static func resolve(_ context: ScreenContext, _ id: String = "capture", kind: String = "website", refresh: Bool = false, permission: Bool = false) -> [String:String] {
        var reply: [String:String]?
        context.resolve(id, kind: kind, allowPermission: permission, refresh: refresh) { reply = $0 }
        let deadline = Date().addingTimeInterval(4)
        while reply == nil && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        precondition(reply != nil, "A frozen read must resolve.")
        return reply!
    }
    static func main() {
        let fixture = Fixture(), context = ScreenContext(reader: { fixture.read($0,$1,$2,$3) })
        context.begin("capture", source: source);fixture.captured()
        precondition(fixture.calls.count == 1 && fixture.calls[0].0 == "reference" && !fixture.calls[0].1,
                     "Capture freezes one identity without asking for permissions.")
        fixture.set(["kind":"website","value":"https://example.test/switched-tab"])
        let switched = resolve(context)
        precondition(switched["value"] == "https://example.test/original" && switched["freshness"] == "changed",
                     "Switching the active tab while speaking must preserve the original reference.")
        precondition(switched["sourceID"] == "test.fixture:123" && switched["observedAt"] != nil)
        let refreshed = resolve(context, refresh: true)
        precondition(refreshed["value"] == "https://example.test/switched-tab" && refreshed["origin"] == "refresh")
        fixture.set(["message":"Source app has closed."])
        let unavailable = resolve(context)
        precondition(unavailable["value"] == refreshed["value"] && unavailable["freshness"] == "unavailable")

        fixture.set(["kind":"file","value":"/fixture/Original.md"])
        context.begin("file", source: source, at: Date().addingTimeInterval(-600));fixture.captured()
        precondition(resolve(context,"file",kind:"file")["freshness"] == "stale")
        fixture.set(["kind":"file","value":"/fixture/Other.md"])
        let changedFile = resolve(context,"file",kind:"file")
        precondition(changedFile["value"] == "/fixture/Original.md" && changedFile["freshness"] == "changed")
        precondition(resolve(context,"capture")["value"] == nil, "An old capture cannot borrow the newest snapshot.")
        precondition(resolve(context,"file",kind:"website")["value"] == nil, "A file observation cannot supply a website.")

        fixture.set(["permission":"automation"])
        context.begin("denied", source: source);fixture.captured()
        fixture.set(["kind":"website","value":"https://example.test/new-after-denial"])
        let denied = resolve(context,"denied")
        precondition(denied["value"] == nil && denied["permission"] == "automation",
                     "Missing capture-time access must never silently substitute the current page.")
        let allowed = resolve(context,"denied",permission:true)
        precondition(allowed["value"] == "https://example.test/new-after-denial" && allowed["freshness"] == "refreshed")
        precondition(fixture.calls.last?.1 == true)
        context.begin("none", source:nil)
        precondition(resolve(context,"none")["value"] == nil)

        // A blocked old read must not delay or overwrite a newer capture's independent snapshot.
        let entered = DispatchSemaphore(value:0), release = DispatchSemaphore(value:0)
        let concurrent = ScreenContext(reader: { pid,_,_,_ in
            if pid == 1 { entered.signal();_ = release.wait(timeout:.now()+4) }
            return ["kind":"website","value":"https://example.test/"+String(pid)]
        })
        concurrent.begin("old",source:.init(pid:1,bundle:"fixture",name:"Old"))
        precondition(entered.wait(timeout:.now()+2) == .success)
        concurrent.begin("new",source:.init(pid:2,bundle:"fixture",name:"New"))
        precondition(resolve(concurrent,"new")["value"] == "https://example.test/2")
        release.signal()
        precondition(resolve(concurrent,"old")["value"] == nil)

        precondition(ScreenContext.normalized("https://user:secret@example.test/page",kind:"reference") == "https://example.test/page")
        precondition(ScreenContext.normalized("file:///fixture/Notes.md",kind:"reference") == "/fixture/Notes.md")
        precondition(ScreenContext.normalized("javascript:alert(1)",kind:"reference") == nil)
        print("Native context fixtures passed: frozen tab/document, explicit refresh, stale/unavailable source, permission denial, capture isolation and credential stripping. No real provider or app access exercised.")
    }
}
