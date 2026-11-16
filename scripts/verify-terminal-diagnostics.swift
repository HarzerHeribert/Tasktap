import Foundation
@main struct VerifyTerminalDiagnostics {
    static func main() throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("tasktap-input-trace-\(UUID().uuidString)")
        defer {try? FileManager.default.removeItem(at:root)}
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        let trace=TerminalInputDiagnostics(directory:root)
        precondition(trace.until==0)
        try String(Date().timeIntervalSince1970+60).write(to:root.appendingPathComponent("input-trace-until"),atomically:true,encoding:.utf8)
        trace.receive([["event":"keydown","key":"secret","keyClass":"text","text":"secret","data":"secret","length":3], ["event":"secret","text":"secret"], ["event":"input","inputType":"secret","length":4]])
        let bytes=try Data(contentsOf:root.appendingPathComponent("terminal-input-events.json"))
        precondition(!String(decoding:bytes,as:UTF8.self).contains("secret"))
        let object=try JSONSerialization.jsonObject(with:bytes) as! [String:Any]
        precondition((object["events"] as! [[String:Any]]).count==2)
        trace.receive(Array(repeating:["event":"outbound","length":1],count:128))
        let permissions=try FileManager.default.attributesOfItem(atPath:root.appendingPathComponent("terminal-input-events.json").path)[.posixPermissions] as! NSNumber
        precondition(permissions.intValue==0o600)
        try "0".write(to:root.appendingPathComponent("input-trace-until"),atomically:true,encoding:.utf8)
        precondition(trace.until==0)
        print("PASS: expiring local input trace excludes content and unknown fields; private file permissions.")
    }
}
