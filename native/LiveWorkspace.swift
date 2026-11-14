import AppKit
import Foundation

final class LiveWorkspace {
    let root:URL
    let data:URL
    private var workers=[String:Process]()
    private var seen=[URL:Date]()
    private var historical=Set<URL>()
    private var pending=[URL:[String:String]]()
    private var timer:Timer?
    private var externalScan:Process?
    var externalChanged:([[String:String]])->Void = {_ in}
    private var cliEnvironment:[String:String]{
        var env=ProcessInfo.processInfo.environment
        env["PATH"]=[fm.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin").path,"/opt/homebrew/bin","/usr/local/bin",env["PATH"] ?? "/usr/bin:/bin"].joined(separator:":")
        return env
    }
    func refreshExternal() {
        guard externalScan==nil, let script=Bundle.main.url(forResource:"cmux-sessions",withExtension:nil) else{return}
        let process=Process()
        let output=Pipe()
        process.executableURL=script;process.arguments=["list",root.path];process.environment=cliEnvironment
        process.standardOutput=output;process.standardError=FileHandle.nullDevice
        externalScan=process
        DispatchQueue.global(qos:.utility).async {
            var rows=[[String:String]]()
            do {
                try process.run()
                let bytes=output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                rows=(try JSONSerialization.jsonObject(with:bytes) as? [[String:String]]) ?? []
            } catch {}
            let result=rows
            DispatchQueue.main.async {self.externalScan=nil;self.externalChanged(result)}
        }
    }
    var changed:([String:Any])->Void = {_ in}
    var projectsChanged:([[String:String]])->Void = {_ in}
    private var previousProjects=[[String:String]]()
    private let fm=FileManager.default
    init(root:URL,data:URL){self.root=root;self.data=data}
    enum Failure:LocalizedError {
        case reason(String)
        var errorDescription:String? {if case .reason(let message)=self{return message};return nil}
    }
    func start()throws {
        try fm.createDirectory(at:data,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        try fm.createDirectory(at:root,withIntermediateDirectories:true)
        refresh()
        for folder in try fm.contentsOfDirectory(at:data,includingPropertiesForKeys:nil) where UUID(uuidString:folder.lastPathComponent) != nil {
            for job in (try? fm.contentsOfDirectory(at:folder,includingPropertiesForKeys:nil)) ?? [] where job.pathExtension=="job" {
                let receipt=job.deletingPathExtension().appendingPathExtension("receipt")
                if let meta=try? JSONSerialization.jsonObject(with:Data(contentsOf:job)) as? [String:Any],let cid=meta["capture"] as? String{
                    pending[receipt]=["session":folder.lastPathComponent,"capture":cid]
                    if ["Complete","Failed","Delivered"].contains(readState(receipt) ?? "") {historical.insert(receipt)}
                }
            }
            if pending.keys.contains(where:{ $0.deletingLastPathComponent().path==folder.path && readState($0) != "Complete" && !["Failed","Delivered"].contains(readState($0) ?? "") }) {try launch(folder)}
        }
        timer=Timer.scheduledTimer(withTimeInterval:0.7,repeats:true){[weak self] _ in self?.poll()}
    }
    private func readState(_ url:URL)->String? {
        guard let b=try? Data(contentsOf:url),let r=try? JSONSerialization.jsonObject(with:b) as? [String:Any] else {return nil}
        return r["state"] as? String
    }
    func refresh(){
        let list=((try? fm.contentsOfDirectory(at:root,includingPropertiesForKeys:[.isDirectoryKey],options:.skipsHiddenFiles)) ?? [])
            .filter{(try? $0.resourceValues(forKeys:[.isDirectoryKey]).isDirectory)==true}
            .map{["name":$0.lastPathComponent,"folder":$0.standardizedFileURL.path]}
            .sorted{$0["name"]! < $1["name"]!}
        if previousProjects != list {previousProjects=list;projectsChanged(list)}
    }
    func enqueue(_ job:[String:Any])throws -> [String:String] {
        guard let session=job["session"] as? String,UUID(uuidString:session) != nil,let capture=job["capture"] as? String,UUID(uuidString:capture) != nil,
              let path=job["folder"] as? String,let mode=job["mode"] as? String,["ask","nudge","note"].contains(mode),
              let provider=job["agent"] as? String,["claude","codex","agy"].contains(provider) else {throw Failure.reason("Invalid handoff.")}
        let scratch=data.deletingLastPathComponent().appendingPathComponent("Scratch",isDirectory:true)
        let dir=path=="@scratch" ? scratch : URL(fileURLWithPath:path,isDirectory:true).standardizedFileURL
        guard dir==scratch || dir.deletingLastPathComponent().standardizedFileURL.path==root.standardizedFileURL.path else {throw Failure.reason("Choose a folder directly under ~/projects.")}
        if !fm.fileExists(atPath:dir.path),job["create"] as? Bool==true || dir==scratch {
            try fm.createDirectory(at:dir,withIntermediateDirectories:false)
        }
        guard (try? dir.resourceValues(forKeys:[.isDirectoryKey]).isDirectory)==true else {throw Failure.reason("Workspace folder is missing.")}
        if mode=="note" || job["keep"] as? Bool==true {
            let notes=(dir==scratch ? scratch:data.deletingLastPathComponent().appendingPathComponent("Notes"))
            try fm.createDirectory(at:notes,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
            let note:[String:Any]=["workspace":dir.path,"text":job["note"] ?? "","strokes":job["strokes"] ?? [],"saved":ISO8601DateFormatter().string(from:Date())]
            try JSONSerialization.data(withJSONObject:note).write(to:notes.appendingPathComponent(capture+".json"),options:.atomic)
        }
        if mode != "note" {
            let folder=data.appendingPathComponent(session,isDirectory:true)
            try fm.createDirectory(at:folder,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
            let files=try fm.contentsOfDirectory(at:folder,includingPropertiesForKeys:nil)
            let existing=files.first{$0.lastPathComponent.hasSuffix(capture+".job")}
            let url=existing ?? folder.appendingPathComponent(String(Int(Date().timeIntervalSince1970*1000000))+"-"+capture+".job")
            var record=job;record["folder"]=dir.path;record["resume"]=mode=="nudge"
            if existing==nil {try JSONSerialization.data(withJSONObject:record).write(to:url,options:.atomic)}
            pending[url.deletingPathExtension().appendingPathExtension("receipt")]=["session":session,"capture":capture]
            try launch(folder)
        }
        refresh()
        return ["folder":dir.path,"name":dir.lastPathComponent]
    }
    func assignNote(_ capture:String,folder:String)throws {
        let project=URL(fileURLWithPath:folder,isDirectory:true).standardizedFileURL
        guard UUID(uuidString:capture) != nil, project.deletingLastPathComponent().path==root.standardizedFileURL.path,
              (try? project.resourceValues(forKeys:[.isDirectoryKey]).isDirectory)==true else {throw Failure.reason("Choose an existing project.")}
        let base=data.deletingLastPathComponent()
        let source=base.appendingPathComponent("Scratch").appendingPathComponent(capture+".json")
        let notes=base.appendingPathComponent("Notes")
        let dest=notes.appendingPathComponent(capture+".json")
        let original=fm.fileExists(atPath:source.path) ? source:dest
        var note=(try JSONSerialization.jsonObject(with:Data(contentsOf:original)) as? [String:Any]) ?? [:]
        note["workspace"]=project.path
        try fm.createDirectory(at:notes,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        try JSONSerialization.data(withJSONObject:note).write(to:dest,options:.atomic)
        if fm.fileExists(atPath:source.path) {try fm.removeItem(at:source)}
    }
    private func launch(_ folder:URL)throws {
        if workers[folder.path] != nil{return}
        guard let url=Bundle.main.url(forResource:"run-agent",withExtension:nil) else {throw Failure.reason("The bundled agent runner is missing.")}
        let p=Process();p.executableURL=url;p.arguments=[folder.path]
        var env=cliEnvironment
        env["WORKSPACE_ASSISTANT_INBOX"]=data.deletingLastPathComponent().appendingPathComponent("Agent Inbox").path
        p.environment=env;p.standardInput=FileHandle.nullDevice
        p.terminationHandler={ [weak self] _ in DispatchQueue.main.async {
            guard let self else{return};self.workers[folder.path]=nil;self.poll()
            let waiting=self.pending.keys.contains{$0.deletingLastPathComponent().path==folder.path && !self.fm.fileExists(atPath:$0.path)}
            if waiting && p.terminationStatus==0 {try? self.launch(folder)}
            if p.terminationStatus != 0 {
                for (receipt,meta) in self.pending where receipt.deletingLastPathComponent().path==folder.path && self.readState(receipt) != "Complete" && self.readState(receipt) != "Failed" {
                    let failure=["state":"Failed","message":"Agent runner exited. Check Python 3 and your CLI installation."]
                    try? JSONSerialization.data(withJSONObject:failure).write(to:receipt,options:.atomic)
                    self.changed(meta.merging(failure){_,b in b})
                }
            }
        }}
        try p.run();workers[folder.path]=p
    }
    private func poll(){
        for url in pending.keys.sorted(by:{$0.lastPathComponent < $1.lastPathComponent}) {
            guard let meta=pending[url] else {continue}
            guard let date=try? url.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate,date != seen[url],
                  let bytes=try? Data(contentsOf:url),let receipt=try? JSONSerialization.jsonObject(with:bytes) as? [String:String] else {continue}
            seen[url]=date
            var event=meta.merging(receipt){_,b in b}
            if historical.remove(url) != nil {event["recovered"]="true"}
            if let bytes=try? Data(contentsOf:url.deletingPathExtension().appendingPathExtension("job")),
               let job=try? JSONSerialization.jsonObject(with:bytes) as? [String:Any] {
                event["scratch"]=(job["folder"] as? String==data.deletingLastPathComponent().appendingPathComponent("Scratch").path) ? "true":"false"
                event["external"]=(job["external"] as? Bool==true) ? "true":"false"
                for key in ["task","folder","agent","brief","mode"] {event[key]=job[key] as? String}
            }
            changed(event)
        }
    }
    func stop(){timer?.invalidate()}
}
