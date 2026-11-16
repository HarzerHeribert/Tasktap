import Foundation
import CryptoKit

// Content-addressed helpers survive replacement of the app while a terminal agent is running.
enum SessionHelpers {
    static func runner() throws -> URL {
        let fm = FileManager.default
        guard let resources = Bundle.main.resourceURL else { throw CocoaError(.fileNoSuchFile) }
        var files = try fm.contentsOfDirectory(at: resources, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "py" || ["run-agent", "agent-tools", "ask-user", "cmux-sessions", "router-provider", "kokoro-voice"].contains($0.lastPathComponent) }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        let observers=resources.appendingPathComponent("observers",isDirectory:true)
        if let entries=fm.enumerator(at:observers,includingPropertiesForKeys:[.isRegularFileKey]) {
            for case let file as URL in entries where (try? file.resourceValues(forKeys:[.isRegularFileKey]).isRegularFile)==true {files.append(file)}
        }
        files.sort{$0.path<$1.path}
        func relative(_ file:URL)->String {String(file.path.dropFirst(resources.path.count+1))}
        var hash = SHA256()
        for file in files { hash.update(data: Data(relative(file).utf8)); hash.update(data: try Data(contentsOf: file)) }
        let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Tasktap/Helpers")
        try fm.createDirectory(at: base, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let target = base.appendingPathComponent(digest)
        if !fm.fileExists(atPath: target.path) {
            let staging = base.appendingPathComponent(UUID().uuidString)
            try fm.createDirectory(at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            defer { try? fm.removeItem(at: staging) }
            for file in files {
                let destination=staging.appendingPathComponent(relative(file))
                try fm.createDirectory(at:destination.deletingLastPathComponent(),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
                try fm.copyItem(at:file,to:destination)
            }
            do { try fm.moveItem(at: staging, to: target) }
            catch { if !fm.fileExists(atPath: target.path) { throw error } }
        }
        return target.appendingPathComponent("run-agent")
    }
}
