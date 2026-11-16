import Foundation

@main struct WorkspaceLinkChecks {
    static func main()throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("tasktap-links-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer{try? FileManager.default.removeItem(at:root)}
        let file=root.appendingPathComponent("My notes.md")
        try "First\nSecond\nThird".write(to:file,atomically:true,encoding:.utf8)
        func checkFile(_ href:String,_ expectedLine:Int?=nil,_ expectedColumn:Int?=nil)throws {
            guard case .file(let url,let line,let column)=try WorkspaceLinks.resolve(href,cwd:root.path) else {fatalError("Not a file: "+href)}
            precondition(url==file && line==expectedLine && column==expectedColumn,"Wrong file location: "+href)
        }
        try checkFile("My notes.md")
        try checkFile("./My notes.md:2:3",2,3)
        try checkFile(file.path+"#L3C2",3,2)
        try checkFile(file.absoluteString)
        try checkFile(file.absoluteString+":2",2)
        guard case .web(let web)=try WorkspaceLinks.resolve("https://example.com/docs?q=one#section",cwd:"") else {fatalError("Not web")}
        precondition(web.fragment=="section" && web.query=="q=one")
        guard case .app(let mail)=try WorkspaceLinks.resolve("mailto:hello@example.com",cwd:"") else {fatalError("Not mail")}
        precondition(mail.scheme=="mailto")
        for href in ["javascript:alert(1)","data:text/html,evil","tasktap-preview://other/file","https://user:secret@example.com","file://remote/tmp/file","missing.txt","relative.md","//example.com","https://","line\nbreak"] {
            do {_ = try WorkspaceLinks.resolve(href,cwd:"");fatalError("Accepted invalid link: "+href)} catch {}
        }
        print("Native workspace links passed: local/relative/encoded paths, line and column locations, web/app routing, invalid targets.")
    }
}
