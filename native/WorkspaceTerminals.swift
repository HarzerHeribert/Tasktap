import Foundation

/// A bounded stdio client of the private PTY service. The service owns processes;
/// this object only owns a connection, so quitting Tasktap leaves work running.
final class WorkspaceTerminals {
    var events: ([[String:Any]], @escaping () -> Void) -> Void = { _, done in done() }
    private var process: Process?
    private var input: FileHandle?
    private let writes = DispatchQueue(label: "Tasktap.terminal-input")
    private var queued = [[String:Any]]()

    static func pythonExecutable(environment: [String:String]) throws -> URL {
        for directory in (environment["PATH"] ?? "").split(separator:":",omittingEmptySubsequences:true) {
            let candidate=URL(fileURLWithPath:String(directory),isDirectory:true).appendingPathComponent("python3")
            var isDirectory:ObjCBool=false
            if FileManager.default.fileExists(atPath:candidate.path,isDirectory:&isDirectory), !isDirectory.boolValue,
               FileManager.default.isExecutableFile(atPath:candidate.path) {return candidate}
        }
        throw LiveWorkspace.Failure.reason("Python 3 is required for built-in terminals. Install Python 3, then choose Reconnect.")
    }

    func connect() throws {
        guard process == nil else { return }
        guard let script = Bundle.main.url(forResource:"workspace_terminal",withExtension:"py") else {
            throw LiveWorkspace.Failure.reason("The terminal service is missing. Rebuild Tasktap.")
        }
        let task = Process(), stdin = Pipe(), stdout = Pipe()
        let environment=LiveWorkspace.cliEnvironment
        task.executableURL = try Self.pythonExecutable(environment:environment)
        task.arguments = ["-u", script.path, "bridge"]
        task.environment = environment
        task.standardInput = stdin; task.standardOutput = stdout; task.standardError = FileHandle.nullDevice
        try task.run()
        process = task; input = stdin.fileHandleForWriting
        let waiting = queued; queued.removeAll()
        waiting.forEach(send)
        DispatchQueue.global(qos:.userInitiated).async { [weak self] in
            var buffer = Data(), connected = false
            while true {
                let bytes = stdout.fileHandleForReading.availableData
                if bytes.isEmpty { break }
                buffer.append(bytes)
                var batch = [[String:Any]]()
                while let end = buffer.firstIndex(of:10) {
                    let line = buffer[..<end]; buffer.removeSubrange(...end)
                    if let value = try? JSONSerialization.jsonObject(with:line) as? [String:Any] { batch.append(value) }
                }
                if buffer.count > 6 * 1024 * 1024 { break }
                if !batch.isEmpty {
                    connected = true
                    let semaphore = DispatchSemaphore(value:0), values = batch
                    DispatchQueue.main.async { [weak self] in
                        guard let self else {semaphore.signal();return}
                        self.events(values) { semaphore.signal() }
                    }
                    // Backpressure includes terminal parsing, not just JS delivery.
                    if semaphore.wait(timeout:.now()+15) == .timedOut { break }
                }
            }
            if task.isRunning {task.terminate()}
            let message=connected ? "Terminal connection lost. Sessions may still be running. Reconnect to restore them."
                : "The terminal service could not start. Check that Python 3 is installed and working, then choose Reconnect."
            DispatchQueue.main.async { [weak self] in
                self?.process = nil; self?.input = nil
                self?.events([["event":"disconnected","error":message]], {})
            }
        }
    }

    func send(_ message:[String:Any]) {
        guard let input else {
            if queued.count < 100 { queued.append(message) }
            do {try connect()} catch {events([["event":"error","error":error.localizedDescription]], {})}
            return
        }
        guard var bytes = try? JSONSerialization.data(withJSONObject:message) else {return}
        bytes.append(10)
        writes.async { try? input.write(contentsOf:bytes) }
    }

    func handle(_ message:[String:Any], folders:WorkspaceFolders, runs:URL) throws {
        guard let op = message["op"] as? String else {return}
        if op == "reconnect" { try connect(); send(["op":"watch"]); return }
        if ["open-workspace","stop-workspace"].contains(op) {
            guard let path=message["cwd"] as? String, path.hasPrefix("/") else {
                throw LiveWorkspace.Failure.reason("Select a valid workspace folder.")
            }
            let cwd=URL(fileURLWithPath:path).standardizedFileURL
            if op == "open-workspace", !folders.allowsExisting(cwd) {
                throw LiveWorkspace.Failure.reason("This workspace folder is unavailable.")
            }
            // Stop only touches PTYs owned by our service. It remains available
            // when a folder has disappeared or its approval is no longer valid.
            let ids=message["ids"] as? [String] ?? []
            guard ids.count<=10000, ids.allSatisfy({UUID(uuidString:$0) != nil}) else {
                throw LiveWorkspace.Failure.reason("Select valid workspace sessions.")
            }
            send(["op":op,"cwd":cwd.path,"ids":ids]);return
        }
        guard let id = message["id"] as? String, UUID(uuidString:id) != nil else {
            throw LiveWorkspace.Failure.reason("Select a valid terminal session.")
        }
        if op == "start" {
            guard let path = message["cwd"] as? String else {return}
            let cwd = URL(fileURLWithPath:path).standardizedFileURL
            guard folders.allowsExisting(cwd) else {
                throw LiveWorkspace.Failure.reason("Open an available workspace folder before starting a terminal.")
            }
            let preference = message["shell"] as? String ?? "default"
            let shells = ["zsh":"/bin/zsh", "bash":"/bin/bash", "fish":"/opt/homebrew/bin/fish"]
            let shell = shells[preference] ?? ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
            guard FileManager.default.isExecutableFile(atPath:shell) else {
                throw LiveWorkspace.Failure.reason("That shell is not installed. Choose another in Terminal preferences.")
            }
            let runner=try SessionHelpers.runner(),python=try Self.pythonExecutable(environment:LiveWorkspace.cliEnvironment)
            let integration=runner.deletingLastPathComponent().appendingPathComponent("tasktap_shell.py")
            send(["op":"start","id":id,"cwd":cwd.path,"argv":[python.path,integration.path,"shell",shell,id,runs.path],"kind":"shell","title":"Terminal","cols":message["cols"] ?? 100,"rows":message["rows"] ?? 30])
        } else if ["attach","detach","input","resize","stop"].contains(op) {
            var request:[String:Any] = ["op":op,"id":id]
            if op == "input" {
                guard let data = message["data"] as? String, data.count <= 90000, Data(base64Encoded:data) != nil else {return}
                request["data"] = data
            }
            if op == "resize" { request["cols"] = message["cols"]; request["rows"] = message["rows"] }
            send(request)
        }
    }
}
