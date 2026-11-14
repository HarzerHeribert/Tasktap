import Foundation
import WebKit
import Darwin

// Requests are immutable. The adapter keeps its request until it has consumed the reply.
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
            repeat {
                again=false
                let dir=directory.appendingPathComponent("requests")
                let files=(try? FileManager.default.contentsOfDirectory(at:dir,includingPropertiesForKeys:[.fileSizeKey,.isRegularFileKey,.isSymbolicLinkKey],options:.skipsHiddenFiles)) ?? []
                let active=Set(files.map(\.lastPathComponent))
                lastResponses=lastResponses.filter{active.contains($0.key)};settled.formIntersection(active)
                for file in files where file.pathExtension=="json" && UUID(uuidString:file.deletingPathExtension().lastPathComponent) != nil {
                    if settled.contains(file.lastPathComponent){continue}
                    do {
                        let saved=directory.appendingPathComponent("responses").appendingPathComponent(file.lastPathComponent)
                        if lastResponses[file.lastPathComponent]==nil,let data=try? Data(contentsOf:saved),
                           let response=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],response["status"] as? String=="answered" {
                            settled.insert(file.lastPathComponent);continue
                        }
                        let info=try file.resourceValues(forKeys:[.fileSizeKey,.isRegularFileKey,.isSymbolicLinkKey])
                        guard info.isRegularFile==true,info.isSymbolicLink != true,(info.fileSize ?? 0)<=65536 else {continue}
                        let event=try JSONSerialization.jsonObject(with:Data(contentsOf:file))
                        guard let web else {return}
                        let reply:Any? = try await withCheckedThrowingContinuation { continuation in
                            web.callAsyncJavaScript("return receiveAgentQuestion(event)",arguments:["event":event],in:nil,in:.page) { result in
                                switch result {
                                case .success(let value):continuation.resume(returning:value)
                                case .failure(let error):continuation.resume(throwing:error)
                                }
                            }
                        }
                        guard let result=reply as? [String:Any] else {continue}
                        try store(result,for:file)
                        if result["status"] as? String=="answered"{settled.insert(file.lastPathComponent)}
                    } catch {
                        // A failed load can recover after relaunch. Keep the original request intact.
                        NSLog("Question inbox: %@",error.localizedDescription)
                    }
                }
            } while again
            scanning=false
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
