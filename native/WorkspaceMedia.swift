import AppKit
import UniformTypeIdentifiers
import WebKit
import PDFKit

/// Only explicitly chosen local files are exposed through this scheme. Preview
/// frames have no native bridge and run in an opaque sandbox origin.
final class WorkspaceMedia: NSObject, WKURLSchemeHandler {
    private enum LinkFailure:LocalizedError {
        case unavailable
        var errorDescription:String? {"This linked file is unavailable or outside this document’s folder. Use Open file to choose it directly."}
    }
    private var files = [String:String]()
    private let lock = NSLock()
    private var cancelled = Set<ObjectIdentifier>()
    private var manifest: URL {
        FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("Tasktap/WorkspaceMedia.json")
    }
    override init() {
        super.init()
        if let data = try? Data(contentsOf:manifest), let saved = try? JSONDecoder().decode([String:String].self,from:data) { files = saved }
    }
    func choose(project:String, completion:@escaping ([[String:String]])->Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories=false;panel.allowsMultipleSelection=true
        panel.message="Open files beside your sessions. Your originals stay in place."
        if !project.isEmpty {panel.directoryURL=URL(fileURLWithPath:project)}
        panel.begin { [weak self] response in
            guard let self, response == .OK else {return}
            completion(self.register(panel.urls))
        }
    }
    func register(_ urls:[URL], persist:Bool=true)->[[String:String]] {
        let values = urls.map { url -> [String:String] in
            let id=UUID().uuidString.lowercased()
            lock.lock();files[id]=url.path;lock.unlock()
            let type=UTType(filenameExtension:url.pathExtension)
            let kind=type?.conforms(to:.image)==true ? "image" : type?.conforms(to:.movie)==true ? "video" : type?.conforms(to:.audio)==true ? "audio" : url.pathExtension.lowercased()=="pdf" ? "pdf" : ["html","htm"].contains(url.pathExtension.lowercased()) ? "web" : ["md","markdown"].contains(url.pathExtension.lowercased()) ? "markdown" : "text"
            return ["id":id,"title":url.lastPathComponent,"path":url.path,"kind":kind,"url":"tasktap-preview://"+id+"/"+(url.lastPathComponent.addingPercentEncoding(withAllowedCharacters:.urlPathAllowed) ?? "file")]
        }
        if persist {
            try? FileManager.default.createDirectory(at:manifest.deletingLastPathComponent(),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
            if let data=try? JSONEncoder().encode(files) {try? data.write(to:manifest,options:.atomic)}
        }
        return values
    }
    /// An explicit document link can open a sibling as a new surface. Resolving
    /// real paths before checking the boundary also blocks symlink escapes.
    func openRelative(_ id:String,href:String,persist:Bool=true)throws->[[String:String]] {
        lock.lock();let path=files[id];lock.unlock()
        guard let path,let originalURL=URL(string:"tasktap-preview://"+id+"/"+(URL(fileURLWithPath:path).lastPathComponent.addingPercentEncoding(withAllowedCharacters:.urlPathAllowed) ?? "file")),
              let request=URL(string:href,relativeTo:originalURL)?.absoluteURL,
              request.scheme=="tasktap-preview",request.host==id,
              let file=try? resource(original:path,request:request,linkedDocument:true) else {throw LinkFailure.unavailable}
        return register([file],persist:persist)
    }
    private func resource(original path:String,request:URL,linkedDocument:Bool=false)throws->URL {
        let original=URL(fileURLWithPath:path).resolvingSymlinksInPath()
        let parent=original.deletingLastPathComponent()
        let file=parent.appendingPathComponent(String(request.path.dropFirst())).standardizedFileURL.resolvingSymlinksInPath()
        let ext=original.pathExtension.lowercased(),html=["html","htm"].contains(ext),markdown=["md","markdown"].contains(ext)
        let local=file.path.hasPrefix(parent.path+"/")
        let image=UTType(filenameExtension:file.pathExtension)?.conforms(to:.image)==true
        // A Markdown capability serves only its document and local images;
        // explicit clicks register other files separately. HTML may load its
        // own directory's assets, always behind an opaque iframe sandbox.
        guard file==original || local && (html || markdown && (image || linkedDocument)) else {throw CocoaError(.fileReadNoPermission)}
        guard (try FileManager.default.attributesOfItem(atPath:file.path))[.type] as? FileAttributeType == .typeRegular else {throw CocoaError(.fileReadUnsupportedScheme)}
        return file
    }
    func pdfPage(_ id:String,page index:Int,completion:@escaping ([String:Any])->Void) {
        guard let path=files[id],URL(fileURLWithPath:path).pathExtension.lowercased()=="pdf" else {completion(["error":"This PDF is unavailable."]);return}
        DispatchQueue.global(qos:.userInitiated).async {
            guard let document=PDFDocument(url:URL(fileURLWithPath:path)), !document.isLocked,
                  let page=document.page(at:max(0,min(index,document.pageCount-1))) else {
                DispatchQueue.main.async {completion(["error":"This PDF is unavailable or password protected. Open the original to view it."])};return
            }
            let bounds=page.bounds(for:.mediaBox)
            let width:CGFloat=1400, height=min(2400,1400*bounds.height/max(1,bounds.width))
            let image=page.thumbnail(of:NSSize(width:width,height:height),for:.mediaBox)
            guard let tiff=image.tiffRepresentation,let bitmap=NSBitmapImageRep(data:tiff),let data=bitmap.representation(using:.png,properties:[:]) else {
                DispatchQueue.main.async {completion(["error":"Could not render this page."])};return
            }
            let result:[String:Any]=["image":"data:image/png;base64,"+data.base64EncodedString(),"page":max(0,min(index,document.pageCount-1)),"pages":document.pageCount,"text":String((page.string ?? "PDF page").prefix(20000))]
            DispatchQueue.main.async {completion(result)}
        }
    }
    func readText(_ id:String, completion:@escaping (String)->Void) {
        guard let path=files[id] else {completion("This file is no longer available.");return}
        DispatchQueue.global(qos:.userInitiated).async {
            let text:String
            do {
                let handle=try FileHandle(forReadingFrom:URL(fileURLWithPath:path));defer{try? handle.close()}
                let data=try handle.read(upToCount:2*1024*1024+1) ?? Data()
                if data.count>2*1024*1024 {text="This file is too large for the text preview. Open it in its usual editor."}
                else if data.contains(0) {text="This format does not have a text preview. Open the original in its usual app."}
                else {text=String(data:data,encoding:.utf8) ?? "This file is not UTF-8 text. Open it in its usual editor."}
            } catch {text="This file is no longer available. Choose it again or locate the original in Finder."}
            DispatchQueue.main.async {completion(text)}
        }
    }
    private func deliver(_ token:ObjectIdentifier,_ body:()->Void)->Bool {
        lock.lock();defer{lock.unlock()}
        guard !cancelled.contains(token) else {return false}
        body();return true
    }
    func reveal(_ id:String) {
        guard let path=files[id] else {return}
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath:path)])
    }
    func webView(_ webView:WKWebView,start task:WKURLSchemeTask) {
        let token=ObjectIdentifier(task)
        lock.lock();cancelled.remove(token)
        let path=task.request.url?.host.flatMap { files[$0] }
        lock.unlock()
        DispatchQueue.global(qos:.userInitiated).async { [weak self] in
            guard let self else {return}
            do {
                guard let path, let requestURL=task.request.url else {throw CocoaError(.fileReadNoPermission)}
                let file=try self.resource(original:path,request:requestURL)
                let attrs=try FileManager.default.attributesOfItem(atPath:file.path)
                guard attrs[.type] as? FileAttributeType == .typeRegular else {throw CocoaError(.fileReadUnsupportedScheme)}
                let size=(attrs[.size] as? NSNumber)?.uint64Value ?? 0
                let mime=UTType(filenameExtension:file.pathExtension)?.preferredMIMEType ?? "text/plain"
                var start:UInt64=0, end=size>0 ? size-1:0, partial=false
                if let range=task.request.value(forHTTPHeaderField:"Range"),range.hasPrefix("bytes=") {
                    let parts=range.dropFirst(6).split(separator:"-",omittingEmptySubsequences:false)
                    if parts.count==2,let offset=UInt64(parts[0]),offset<size {
                        let requestedEnd=min(UInt64(parts[1]) ?? end,end)
                        guard requestedEnd>=offset else {throw URLError(.badServerResponse)}
                        start=offset;end=requestedEnd;partial=true
                    }
                }
                // A sandboxed document has an opaque origin: 'self' would
                // reject even its own sibling assets. Scope resource loading
                // to this registry capability's exact authority instead.
                let source="tasktap-preview://"+(requestURL.host ?? "")
                var headers=["Content-Type":mime,"Content-Length":String(size==0 ? 0:end-start+1),"Accept-Ranges":"bytes","X-Content-Type-Options":"nosniff","Cache-Control":"no-store",
                    "Content-Security-Policy":"sandbox allow-scripts; default-src 'none'; script-src \(source) 'unsafe-inline'; style-src \(source) 'unsafe-inline'; img-src \(source) data: blob:; font-src \(source) data:; media-src \(source) data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"]
                if partial {headers["Content-Range"]="bytes \(start)-\(end)/\(size)"}
                let response=HTTPURLResponse(url:requestURL,statusCode:partial ? 206:200,httpVersion:"HTTP/1.1",headerFields:headers)!
                guard self.deliver(token,{task.didReceive(response)}) else {return}
                let handle=try FileHandle(forReadingFrom:file);defer{try? handle.close()}
                try handle.seek(toOffset:start)
                var remaining=size==0 ? 0:end-start+1
                while remaining>0 {
                    guard let chunk=try handle.read(upToCount:Int(min(65536,remaining))),!chunk.isEmpty else {break}
                    guard self.deliver(token,{task.didReceive(chunk)}) else {return};remaining-=UInt64(chunk.count)
                }
                _ = self.deliver(token,{task.didFinish()})
            } catch {
                self.lock.lock();defer{self.lock.unlock()}
                if !self.cancelled.contains(token){task.didFailWithError(error)}
            }
        }
    }
    func webView(_ webView:WKWebView,stop task:WKURLSchemeTask) {
        lock.lock();cancelled.insert(ObjectIdentifier(task));lock.unlock()
    }
}
