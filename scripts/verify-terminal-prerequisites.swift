// Compile with WorkspaceFolders, LiveWorkspace and WorkspaceTerminals.
// This fixture only resolves disposable executable paths; no interpreter or terminal is started.
import Foundation
enum SessionHelpers {static func runner() throws -> URL {URL(fileURLWithPath:"/usr/bin/true")}}
@main struct TerminalPrerequisites {
    static func main() throws {
        let fm=FileManager.default,root=fm.temporaryDirectory.appendingPathComponent("tasktap-python-check-"+UUID().uuidString)
        try fm.createDirectory(at:root,withIntermediateDirectories:true);defer{try? fm.removeItem(at:root)}
        let first=root.appendingPathComponent("first"),second=root.appendingPathComponent("folder with spaces")
        for folder in [first,second] {try fm.createDirectory(at:folder,withIntermediateDirectories:true)}
        let environment=["PATH":first.path+":"+second.path]
        do {_ = try WorkspaceTerminals.pythonExecutable(environment:environment);fatalError("Missing interpreter accepted.")}
        catch {precondition(error.localizedDescription.contains("Python 3") && error.localizedDescription.contains("Reconnect"))}
        let ignored=first.appendingPathComponent("python3"),python=second.appendingPathComponent("python3")
        try "fixture, never executed".write(to:ignored,atomically:true,encoding:.utf8)
        try fm.setAttributes([.posixPermissions:0o600],ofItemAtPath:ignored.path)
        try "fixture, never executed".write(to:python,atomically:true,encoding:.utf8)
        try fm.setAttributes([.posixPermissions:0o700],ofItemAtPath:python.path)
        let executable=try WorkspaceTerminals.pythonExecutable(environment:environment)
        precondition(executable==python,"Non-executable candidates must be skipped.")
        try fm.removeItem(at:ignored);try fm.createDirectory(at:ignored,withIntermediateDirectories:false)
        let notDirectory=try WorkspaceTerminals.pythonExecutable(environment:environment)
        precondition(notDirectory==python,"Directories are not interpreters.")
        try fm.removeItem(at:ignored);try fm.createSymbolicLink(at:ignored,withDestinationURL:python)
        let ordered=try WorkspaceTerminals.pythonExecutable(environment:environment)
        precondition(ordered==ignored,"PATH priority and executable symlinks are preserved.")
        print("Terminal prerequisites passed: missing Python gives actionable recovery, only executable files are accepted, PATH order and paths with spaces are preserved. No Python process launched.")
    }
}
