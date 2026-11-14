import AppKit
import Darwin
import Foundation

final class LiveWorkspace {
    let root:URL
    let data:URL
    private var workers=[String:Process]()
    private var seen=[URL:Date]()
    private var historical=Set<URL>()
    private var opening=Set<URL>()
    private var pending=[URL:[String:String]]()
    private var timer:Timer?
    private var externalScan:Process?
    private var discoveryTimer:Timer?
    private var lastDiscovery:[[String:String]]?
    func watchSessions(){
        refreshExternal()
        discoveryTimer=Timer.scheduledTimer(withTimeInterval:8,repeats:true){[weak self] _ in self?.refreshExternal()}
    }
    var externalChanged:([[String:String]])->Void = {_ in}
    static var cliEnvironment:[String:String]{
        var env=ProcessInfo.processInfo.environment
        env["PATH"]=[FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin").path,"/opt/homebrew/bin","/usr/local/bin",env["PATH"] ?? "/usr/bin:/bin"].joined(separator:":")
        return env
    }
    func refreshExternal() {
        guard externalScan==nil, let script=Bundle.main.url(forResource:"cmux-sessions",withExtension:nil) else{return}
        let process=Process()
        let output=Pipe()
        process.executableURL=script;process.arguments=["list",root.path,data.deletingLastPathComponent().appendingPathComponent("desktop-activity.json").path,data.path];process.environment=Self.cliEnvironment
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
            DispatchQueue.main.async {self.externalScan=nil;if self.lastDiscovery != result {self.lastDiscovery=result;self.externalChanged(result)}}
        }
    }
    var changed:([String:Any])->Void = {_ in}
    var projectsChanged:([[String:String]])->Void = {_ in}
    private var previousProjects:[[String:String]]?
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
                    if ["Complete","Failed","Delivered","Opened","Copied","Opening","Closed"].contains(readState(receipt) ?? "") {historical.insert(receipt)}
                }
            }
            if pending.keys.contains(where:{ $0.deletingLastPathComponent().path==folder.path && readState($0) != "Complete" && !["Failed","Delivered","Opened","Copied","Opening","Closed"].contains(readState($0) ?? "") }) {try launch(folder)}
        }
        timer=Timer.scheduledTimer(withTimeInterval:0.7,repeats:true){[weak self] _ in self?.poll()}
    }
    private func readState(_ url:URL)->String? {
        guard let b=try? Data(contentsOf:url),let r=try? JSONSerialization.jsonObject(with:b) as? [String:Any] else {return nil}
        return r["state"] as? String
    }
    func failedHandoff(session:String,capture:String)throws -> [String:Any] {
        let unavailable=Failure.reason("This handoff is no longer available to retry. Check its session in the workspace.")
        guard UUID(uuidString:session) != nil, UUID(uuidString:capture) != nil, session != capture else {throw unavailable}
        let folder=data.appendingPathComponent(session)
        let jobs=try fm.contentsOfDirectory(at:folder,includingPropertiesForKeys:nil).filter{$0.pathExtension=="job"}
        guard jobs.count==1,let path=jobs.first, readState(path.deletingPathExtension().appendingPathExtension("receipt"))=="Failed",
              let job=try JSONSerialization.jsonObject(with:Data(contentsOf:path)) as? [String:Any],
              job["session"] as? String==session, job["capture"] as? String==capture, job["mode"] as? String=="ask",
              job["delivery"] as? String=="interactive", job["external"] as? Bool != true else {throw unavailable}
        // A timeout can arrive while the original presenter still owns its terminal.
        // An established conversation can contain partial work, even after it exits.
        for name in ["thread.json","claude-turn-started"] where fm.fileExists(atPath:folder.appendingPathComponent(name).path) {throw unavailable}
        let lock=folder.appendingPathComponent("surface.lock").path
        let fd=open(lock,O_RDONLY)
        if fd>=0 {
            defer {close(fd)}
            guard flock(fd,LOCK_EX|LOCK_NB)==0 else {throw unavailable}
        } else if errno != ENOENT {throw unavailable}
        return job
    }
    func refresh(){
        let list=((try? fm.contentsOfDirectory(at:root,includingPropertiesForKeys:[.isDirectoryKey],options:.skipsHiddenFiles)) ?? [])
            .filter{(try? $0.resourceValues(forKeys:[.isDirectoryKey]).isDirectory)==true}
            .map{["name":$0.lastPathComponent,"folder":$0.standardizedFileURL.path,"checkout":$0.resolvingSymlinksInPath().standardizedFileURL.path]}
            .sorted{$0["name"]! < $1["name"]!}
        if previousProjects != list {previousProjects=list;projectsChanged(list)}
    }
    func enqueue(_ job:[String:Any])throws -> [String:String] {
        guard let session=job["session"] as? String,UUID(uuidString:session) != nil,let capture=job["capture"] as? String,UUID(uuidString:capture) != nil,
              let path=job["folder"] as? String,let mode=job["mode"] as? String,["ask","nudge","note"].contains(mode),
              let provider=job["agent"] as? String,["claude","codex","agy","cursor-agent","pi"].contains(provider) else {throw Failure.reason("Invalid handoff.")}
        if mode != "note" {
            guard job["delivery"] as? String=="interactive", (job["planAccount"] as? String ?? "").isEmpty,
                  let host=job["host"] as? String, (TerminalCatalog.applications[host] != nil || host=="desktop"),
                  mode != "ask" || host != "desktop",
                  let outgoing=job["outgoing"] as? String, !outgoing.isEmpty,
                  job["instructions"] is String else {throw Failure.reason("Review the handoff to a visible agent session.")}
        }
        if let original=job["retryOf"] as? String {
            guard mode=="ask" else {throw Failure.reason("Only a new session can retry this handoff.")}
            // The failed capture is the stable ID of its replacement session. Reopening
            // the same review cannot create a second worker for the original handoff.
            _=try failedHandoff(session:original,capture:session)
            let destination=data.appendingPathComponent(session)
            if fm.fileExists(atPath:destination.path) {
                let jobs=try fm.contentsOfDirectory(at:destination,includingPropertiesForKeys:nil).filter{$0.pathExtension=="job"}
                if !jobs.isEmpty && !jobs.contains(where:{$0.lastPathComponent.hasSuffix("-"+capture+".job")}) {
                    throw Failure.reason("This handoff has already been retried. Open the new session in the workspace.")
                }
            }
        }
        if mode=="ask",let host=job["host"] as? String, TerminalCatalog.app(host)==nil {
            throw Failure.reason("Your chosen terminal is unavailable. Choose an installed app in Preferences → Session models.")
        }
        let scratch=data.deletingLastPathComponent().appendingPathComponent("Scratch",isDirectory:true)
        let dir=path=="@scratch" ? scratch : URL(fileURLWithPath:path,isDirectory:true).standardizedFileURL
        guard dir==scratch || dir.deletingLastPathComponent().standardizedFileURL.path==root.standardizedFileURL.path else {throw Failure.reason("Choose a folder directly under ~/projects.")}
        if !fm.fileExists(atPath:dir.path),job["create"] as? Bool==true || dir==scratch {
            try fm.createDirectory(at:dir,withIntermediateDirectories:false)
        }
        guard (try? dir.resourceValues(forKeys:[.isDirectoryKey]).isDirectory)==true else {throw Failure.reason("Workspace folder is missing.")}
        var reviewedFolder:String?
        if let reviewed=job["reviewedFolder"] as? String {
            let canonical=dir.resolvingSymlinksInPath().standardizedFileURL.path
            let newFolder="~/projects/"+dir.lastPathComponent
            let matchesNew=job["create"] as? Bool==true && reviewed==newFolder &&
                dir.deletingLastPathComponent().resolvingSymlinksInPath().appendingPathComponent(dir.lastPathComponent).standardizedFileURL.path==canonical
            let matchesScratch=dir==scratch && reviewed=="@scratch" &&
                scratch.deletingLastPathComponent().resolvingSymlinksInPath().appendingPathComponent("Scratch").standardizedFileURL.path==canonical
            guard mode=="ask", provider=="codex", reviewed==canonical || matchesNew || matchesScratch else {
                throw Failure.reason("The folder changed. Review its location again before starting Codex.")
            }
            reviewedFolder=canonical
        }
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
            record["reviewedFolder"]=reviewedFolder
            record["hostApp"]=(record["host"] as? String).flatMap(TerminalCatalog.app)?.path
            if mode=="nudge", job["external"] as? Bool != true {
                guard let first=files.filter({$0.pathExtension=="job"}).sorted(by:{$0.lastPathComponent<$1.lastPathComponent}).first,
                      let owner=try JSONSerialization.jsonObject(with:Data(contentsOf:first)) as? [String:Any],
                      owner["mode"] as? String=="ask", owner["delivery"] as? String=="interactive",
                      owner["agent"] as? String==provider,owner["folder"] as? String==dir.path,(owner["host"] as? String)==(job["host"] as? String)
                else {throw Failure.reason("Select the original interactive session for this nudge.")}
            }
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
        var env=Self.cliEnvironment
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
    func focusSession(_ id:String, completion:@escaping (String?)->Void) {
        guard UUID(uuidString:id) != nil else {completion("Invalid session.");return}
        let external=lastDiscovery?.first{$0["id"]==id && $0["owned"] != "yes"}
        let script=external == nil ? "run-agent" : "cmux-sessions"
        guard let url=Bundle.main.url(forResource:script,withExtension:nil) else {completion("Session helper is unavailable.");return}
        let arguments:[String]
        if let external {
            if external["source"]=="desktop",let thread=external["conversation"],UUID(uuidString:thread) != nil,let url=URL(string:"codex://threads/"+thread) {
                completion(NSWorkspace.shared.open(url) ? nil:"Could not open this ChatGPT chat.");return
            }
            guard external["surface"] != nil else {completion("Open this conversation in its original client.");return}
            arguments=["focus",root.path,id]
        } else {arguments=["focus",data.appendingPathComponent(id).path]}
        DispatchQueue.global(qos:.userInitiated).async {
            let p=Process(),pipe=Pipe()
            p.executableURL=url;p.arguments=arguments
            var env=Self.cliEnvironment
            if external != nil {env["TASKTAP_TERMINAL_APP"]=TerminalCatalog.app("cmux")?.path}
            p.environment=env;p.standardError=pipe;p.standardOutput=FileHandle.nullDevice
            let problem:String?
            do {try p.run();let bytes=pipe.fileHandleForReading.readDataToEndOfFile();p.waitUntilExit()
                problem=p.terminationStatus==0 ? nil : String(data:bytes,encoding:.utf8)?.trimmingCharacters(in:.whitespacesAndNewlines) ?? "Could not open this session."
            } catch {problem=error.localizedDescription}
            DispatchQueue.main.async {completion(problem)}
        }
    }
    private func poll(){
        for url in pending.keys.sorted(by:{$0.lastPathComponent < $1.lastPathComponent}) {
            guard let meta=pending[url] else {continue}
            if opening.contains(url), readState(url)=="Opening", !fm.fileExists(atPath:url.deletingLastPathComponent().appendingPathComponent("surface.json").path),
               let started=try? url.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate,
               Date().timeIntervalSince(started)>90 {
                let failure=["state":"Failed","message":"The terminal did not confirm opening. Check its window and review the handoff again."]
                try? JSONSerialization.data(withJSONObject:failure).write(to:url,options:.atomic)
            }
            guard let date=try? url.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate,date != seen[url],
                  let bytes=try? Data(contentsOf:url),let receipt=try? JSONSerialization.jsonObject(with:bytes) as? [String:String] else {continue}
            if receipt["state"]=="Opening"{opening.insert(url)}else{opening.remove(url)}
            seen[url]=date
            var event=meta.merging(receipt){_,b in b}
            if historical.remove(url) != nil {event["recovered"]="true"}
            if let bytes=try? Data(contentsOf:url.deletingPathExtension().appendingPathExtension("job")),
               let job=try? JSONSerialization.jsonObject(with:bytes) as? [String:Any] {
                event["scratch"]=(job["folder"] as? String==data.deletingLastPathComponent().appendingPathComponent("Scratch").path) ? "true":"false"
                event["external"]=(job["external"] as? Bool==true) ? "true":"false"
                for key in ["task","folder","agent","brief","mode","accounts","planAccount","host","delivery","outgoing","instructions","routingEvidence","routingPayload","transcript"] {event[key]=job[key] as? String}
                if event["model"]==nil {event["model"]=job["model"] as? String}
            }
            changed(event)
        }
    }
    func resumeCommand(_ id:String)throws -> String {
        guard UUID(uuidString:id) != nil else {throw Failure.reason("Invalid session.")}
        let folder=data.appendingPathComponent(id)
        let jobs=try fm.contentsOfDirectory(at:folder,includingPropertiesForKeys:nil).filter{$0.pathExtension=="job"}.sorted{$0.lastPathComponent<$1.lastPathComponent}
        guard let first=jobs.first,
              jobs.allSatisfy({["Complete","Failed"].contains(readState($0.deletingPathExtension().appendingPathExtension("receipt")) ?? "")}),
              let job=try JSONSerialization.jsonObject(with:Data(contentsOf:first)) as? [String:Any],
              (job["planAccount"] as? String ?? "").isEmpty,job["external"] as? Bool != true,let provider=job["agent"] as? String,["claude","codex"].contains(provider),
              let cwd=job["folder"] as? String,
              let conversation=try JSONSerialization.jsonObject(with:Data(contentsOf:folder.appendingPathComponent("conversation.json"))) as? [String:String],
              let handle=conversation["id"],UUID(uuidString:handle) != nil else {
            throw Failure.reason("Wait for the session to finish before opening it in Terminal.")
        }
        let quoted=cwd.replacingOccurrences(of:"'",with:"'\"'\"'")
        return "cd -- '"+quoted+"' && "+provider+(provider=="claude" ? " --resume ":" resume ")+handle
    }
    func stop(){timer?.invalidate();discoveryTimer?.invalidate()}
}
