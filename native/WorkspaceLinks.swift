import Foundation

/// Resolves explicit user activations without ever treating a link as a command.
enum WorkspaceLinks {
    enum Destination {case web(URL), app(URL), file(URL, line:Int?, column:Int?)}
    enum Failure:LocalizedError {
        case invalid, missing
        var errorDescription:String? {self == .missing ? "This linked file is no longer available. Check the path or open it directly." : "This link cannot be opened. Use a web address, local file, or supported app link."}
    }
    static func resolve(_ href:String,cwd:String)throws->Destination {
        var value=href.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !value.isEmpty,value.count<=16384,!value.unicodeScalars.contains(where:{$0.value<32 || $0.value==127}),!value.contains("\\") else {throw Failure.invalid}
        let scheme=URLComponents(string:value)?.scheme?.lowercased()
        if let scheme,["http","https"].contains(scheme) {
            guard let url=URL(string:value),let host=url.host,!host.isEmpty,url.user==nil,url.password==nil else {throw Failure.invalid}
            return .web(url)
        }
        if let scheme,["mailto","tel","sms","vscode","vscode-insiders","cursor","zed","xcode","obsidian","slack"].contains(scheme) {
            guard let url=URL(string:value) else {throw Failure.invalid};return .app(url)
        }
        var line:Int?,column:Int?
        if let range=value.range(of:#"(?::([0-9]+)(?::([0-9]+))?|#L([0-9]+)(?:C([0-9]+))?)$"#,options:.regularExpression) {
            let suffix=String(value[range]);value.removeSubrange(range)
            let numbers=suffix.split(whereSeparator:{!$0.isNumber}).compactMap{Int($0)}
            line=numbers.first;column=numbers.count>1 ? numbers[1]:nil
        }
        let file:URL
        if value.lowercased().hasPrefix("file:") {
            guard let url=URL(string:value),url.isFileURL,(url.host==nil || url.host=="" || url.host=="localhost"),url.user==nil,url.password==nil else {throw Failure.invalid}
            file=url
        } else {
            guard !value.hasPrefix("//"),!value.contains(":") else {throw Failure.invalid}
            if value.hasPrefix("~/") {value=FileManager.default.homeDirectoryForCurrentUser.path+String(value.dropFirst())}
            if value.hasPrefix("/") {file=URL(fileURLWithPath:value)}
            else {guard cwd.hasPrefix("/") else {throw Failure.invalid};file=URL(fileURLWithPath:cwd,isDirectory:true).appendingPathComponent(value)}
        }
        let url=file.standardizedFileURL
        guard FileManager.default.fileExists(atPath:url.path) else {throw Failure.missing}
        return .file(url,line:line,column:column)
    }
}
