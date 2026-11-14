import Foundation
import WebKit
import Darwin

// Requests are immutable. An answered receipt is durable so an adapter can retry.
final class QuestionInbox {
    let directory:URL
    private weak var web:WKWebView?
    private var source:DispatchSourceFileSystemObject?
    private var scanning=false
    private var again=false
    private var lastResponses=[String:Data]()
    private var settled=Set<String>()
    init(directory:URL){self.directory=directory}

    func start(web:WKWebView) throws {
        self.web=web
        let fm=FileManager.default
        try fm.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        for name in ["requests","responses"] {
            try fm.createDirectory(at:directory.appendingPathComponent(name),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        }
        let fd=open(directory.appendingPathComponent("requests").path,O_EVTONLY)
        guard fd >= 0 else {throw CocoaError(.fileReadUnknown)}
        let watcher=DispatchSource.makeFileSystemObjectSource(fileDescriptor:fd,eventMask:[.write,.rename],queue:.main)
        watcher.setEventHandler{[weak self] in self?.scan()}
        watcher.setCancelHandler{Darwin.close(fd)}
        watcher.resume();source=watcher;scan()
    }

    func scan(){
        if scanning {again=true;return}
        scanning=true
        Task { @MainActor in
            defer {scanning=false}
            repeat {
                again=false
                do { try await synchronize() }
                catch {NSLog("Question inbox: %@",error.localizedDescription)}
            } while again
        }
    }

    @MainActor private func synchronize() async throws {
        guard let web else { return }
        let fm=FileManager.default, requestDir=directory.appendingPathComponent("requests")
        // A failed directory read must not retire live questions. Reconcile the web
        // snapshot only after every pending file has been read and acknowledged.
        let files=try fm.contentsOfDirectory(at:requestDir,includingPropertiesForKeys:[.fileSizeKey,.isRegularFileKey,.isSymbolicLinkKey],options:.skipsHiddenFiles)
            .filter{$0.pathExtension=="json" && UUID(uuidString:$0.deletingPathExtension().lastPathComponent) != nil}
            .sorted{$0.lastPathComponent<$1.lastPathComponent}
        let names=Set(files.map(\.lastPathComponent))
        lastResponses=lastResponses.filter{names.contains($0.key)};settled.formIntersection(names)
        var activeKeys=[String](), complete=true
        for file in files where !settled.contains(file.lastPathComponent) {
            let name=file.lastPathComponent
            do {
                let responseFile=directory.appendingPathComponent("responses").appendingPathComponent(name)
                var stored:[String:Any]?
                if lastResponses[name]==nil, fm.fileExists(atPath:responseFile.path) {
                    stored=try JSONSerialization.jsonObject(with:Data(contentsOf:responseFile)) as? [String:Any]
                    if stored?["status"] as? String=="answered" {settled.insert(name);continue}
                }
                let info=try file.resourceValues(forKeys:[.fileSizeKey,.isRegularFileKey,.isSymbolicLinkKey])
                guard info.isRegularFile==true,info.isSymbolicLink != true,(info.fileSize ?? 0)<=65536 else {continue}
                let event=try JSONSerialization.jsonObject(with:Data(contentsOf:file))
                let reply=try await web.callAsyncJavaScript("return receiveAgentQuestion(event, prior)",arguments:["event":event,"prior":stored ?? [:]],in:nil,contentWorld:.page)
                guard var result=reply as? [String:Any], let key=result.removeValue(forKey:"producerKey") as? String else {
                    complete=false;continue
                }
                try store(result,for:file)
                if result["status"] as? String=="answered" {settled.insert(name)} else {activeKeys.append(key)}
            } catch {
                complete=false
                NSLog("Question inbox: %@",error.localizedDescription)
            }
        }
        if complete {
            _ = try await web.callAsyncJavaScript("reconcileAgentQuestions(keys)",arguments:["keys":activeKeys],in:nil,contentWorld:.page)
        }
    }

    private func store(_ result:[String:Any],for file:URL)throws{
        let name=file.lastPathComponent
        let data=try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys])
        if lastResponses[name] != data {
            try data.write(to:directory.appendingPathComponent("responses").appendingPathComponent(name),options:.atomic)
            lastResponses[name]=data
        }
    }
    func stop(){source?.cancel();source=nil}
}
