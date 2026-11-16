import Foundation

/// A short, explicitly enabled local trace. Never accept text, key values,
/// clipboard contents, terminal output, or paths from the renderer.
final class TerminalInputDiagnostics {
    private let directory:URL
    private var rows:[[String:Any]]=[]
    init(directory:URL=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("Tasktap/Diagnostics")){self.directory=directory}
    var until:Double {
        guard let value=try? String(contentsOf:directory.appendingPathComponent("input-trace-until"),encoding:.utf8),
              let time=Double(value.trimmingCharacters(in:.whitespacesAndNewlines)),
              time>Date().timeIntervalSince1970,time<Date().timeIntervalSince1970+3600 else {return 0}
        return time*1000
    }
    func receive(_ events:[[String:Any]]) {
        guard until>0 else {return}
        let types:Set<String>=["keydown","keypress","keyup","beforeinput","input","compositionstart","compositionupdate","compositionend","outbound","blocked"]
        let inputs:Set<String>=["insertText","insertReplacementText","insertCompositionText","insertFromComposition","insertFromPaste","deleteContentBackward","deleteContentForward","other"]
        for event in events.prefix(128) {
            guard let type=event["event"] as? String,types.contains(type) else {continue}
            var row:[String:Any]=["event":type]
            for key in ["stream","time","length","valueLength","selectionLength"] {
                if let number=event[key] as? Double,number.isFinite,number>=0,number<=1e12 {row[key]=number}
            }
            for key in ["composing","sessionComposing","trusted","repeat"] {if let value=event[key] as? Bool {row[key]=value}}
            if let value=event["inputType"] as? String,inputs.contains(value) {row["inputType"]=value}
            if let value=event["keyClass"] as? String,["text","control","process"].contains(value){row["keyClass"]=value}
            rows.append(row)
        }
        rows=Array(rows.suffix(512))
        do {
            try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
            let file=directory.appendingPathComponent("terminal-input-events.json")
            try JSONSerialization.data(withJSONObject:["events":rows],options:[.sortedKeys]).write(to:file,options:.atomic)
            try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
        } catch {NSLog("Terminal event trace unavailable")}
    }
}
