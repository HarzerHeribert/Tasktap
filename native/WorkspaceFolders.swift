import Foundation

/// Folder choices made by the user, separate from whichever views are open.
/// The selected root authorizes its immediate child directories (including
/// established project aliases). Other locations require an explicit picker.
final class WorkspaceFolders {
    struct Folder: Codable, Equatable {
        var name: String
        var folder: String
        var checkout: String
    }
    private struct Stored: Codable {
        var root: String
        var rootCheckout: String?
        var approved: [Folder]
        var known: [Folder]
        var externalDiscovery: Bool?
    }
    enum Failure: LocalizedError {
        case reason(String)
        var errorDescription: String? {if case .reason(let message)=self{return message};return nil}
    }
    static var defaultRoot: URL {FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("projects",isDirectory:true)}
    static func canonical(_ url:URL)->URL {url.standardizedFileURL.resolvingSymlinksInPath().standardizedFileURL}
    private let fm=FileManager.default
    private let storage:URL?
    private var rootCheckout:String
    private var approved=[Folder]()
    private var known=[Folder]()
    private(set) var root:URL
    private(set) var externalDiscovery=false

    init(storage:URL,defaultRoot:URL=WorkspaceFolders.defaultRoot) {
        self.storage=storage;root=defaultRoot.standardizedFileURL;rootCheckout=Self.canonical(defaultRoot).path
        if let bytes=try? Data(contentsOf:storage),let saved=try? JSONDecoder().decode(Stored.self,from:bytes),saved.root.hasPrefix("/") {
            root=URL(fileURLWithPath:saved.root,isDirectory:true).standardizedFileURL
            rootCheckout=saved.rootCheckout?.hasPrefix("/")==true ? saved.rootCheckout! : Self.canonical(root).path
            approved=saved.approved.filter{$0.folder.hasPrefix("/") && $0.checkout.hasPrefix("/")}
            known=saved.known.filter{URL(fileURLWithPath:$0.folder).deletingLastPathComponent().standardizedFileURL.path==root.path}
            externalDiscovery=saved.externalDiscovery ?? false
        }
    }
    /// An isolated, non-persisting catalog for fixtures and verification builds.
    init(root:URL) {storage=nil;self.root=root.standardizedFileURL;rootCheckout=Self.canonical(root).path}

    private func directory(_ url:URL)->Bool {
        var value=ObjCBool(false)
        return url.isFileURL && fm.fileExists(atPath:url.path,isDirectory:&value) && value.boolValue
    }
    private var rootAvailable:Bool {directory(root) && Self.canonical(root).path==rootCheckout}
    private func record(_ url:URL)->Folder {
        Folder(name:url.lastPathComponent,folder:url.standardizedFileURL.path,checkout:Self.canonical(url).path)
    }
    private func save()throws {
        guard let storage else{return}
        let encoder=JSONEncoder();encoder.outputFormatting=[.prettyPrinted,.sortedKeys]
        let bytes=try encoder.encode(Stored(root:root.path,rootCheckout:rootCheckout,approved:approved,known:known,externalDiscovery:externalDiscovery))
        try fm.createDirectory(at:storage.deletingLastPathComponent(),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        try bytes.write(to:storage,options:.atomic)
        try fm.setAttributes([.posixPermissions:0o600],ofItemAtPath:storage.path)
    }
    var configuration:[String:Any] {
        ["root":root.path,"rootAvailable":rootAvailable,"externalDiscovery":externalDiscovery,
         "additionalFolders":approved.map{["name":$0.name,"folder":$0.folder,"checkout":$0.checkout]}]
    }
    func setExternalDiscovery(_ enabled:Bool)throws {
        let previous=externalDiscovery;externalDiscovery=enabled
        do {try save()}catch{externalDiscovery=previous;throw error}
    }
    func setRoot(_ selected:URL)throws {
        let url=selected.standardizedFileURL
        guard directory(url) else{throw Failure.reason("Choose an existing folder for your workspaces.")}
        _=projects()
        let previous=(root,rootCheckout,known,approved)
        // Changing the default location must not revoke existing workspaces.
        // Pin their current identities as individual approvals, retaining missing
        // rows too so layouts can reconnect if that same folder returns.
        for value in known {
            let old=URL(fileURLWithPath:value.folder,isDirectory:true)
            let retained=allowsExisting(old) ? record(old):value
            approved.removeAll{$0.folder==retained.folder};approved.append(retained)
        }
        root=url;rootCheckout=Self.canonical(url).path;known=[]
        do {try save()}catch{(root,rootCheckout,known,approved)=previous;throw error}
    }
    @discardableResult func authorize(_ selected:URL)throws -> URL {
        let url=selected.standardizedFileURL
        guard directory(url) else{throw Failure.reason("Choose an existing workspace folder.")}
        let value=record(url)
        if let existing=approved.first(where:{$0.folder==value.folder && $0.checkout==value.checkout}) {
            return URL(fileURLWithPath:existing.folder,isDirectory:true)
        }
        let previous=approved
        approved.removeAll{$0.folder==value.folder};approved.append(value)
        do {try save()}catch{approved=previous;throw error}
        return url
    }
    func allowsExisting(_ candidate:URL)->Bool {
        let url=candidate.standardizedFileURL
        guard directory(url) else{return false}
        // Keep logical project aliases under the chosen root working. The bridge
        // may not use an arbitrary outside path merely because one alias exists.
        if rootAvailable && url.deletingLastPathComponent().path==root.path{return true}
        let checkout=Self.canonical(url).path
        return approved.contains{$0.checkout==checkout}
    }
    func projects()->[[String:String]] {
        var records=Dictionary(known.map{($0.folder,$0)},uniquingKeysWith:{_,latest in latest})
        if rootAvailable {
            let children=(try? fm.contentsOfDirectory(at:root,includingPropertiesForKeys:[.isDirectoryKey],options:.skipsHiddenFiles)) ?? []
            for child in children where directory(child) {records[child.standardizedFileURL.path]=record(child)}
        }
        let discovered=records.values.sorted{$0.folder<$1.folder}
        if discovered != known {known=discovered;try? save()}
        for extra in approved where records[extra.folder]==nil {records[extra.folder]=extra}
        return records.values.map{value in
            let url=URL(fileURLWithPath:value.folder,isDirectory:true)
            let extra=approved.first{$0.folder==value.folder}
            let inRoot=rootAvailable && url.deletingLastPathComponent().path==root.path
            let available=allowsExisting(url) && (inRoot || extra==nil || Self.canonical(url).path==extra?.checkout)
            var row=["name":value.name,"folder":value.folder,"checkout":value.checkout,"available":available ? "true":"false"]
            if !available {row["unavailableReason"]="Folder is unavailable. Choose its current location to reopen it."}
            return row
        }.sorted{($0["name"] ?? "").localizedStandardCompare($1["name"] ?? "") == .orderedAscending}
    }
    @discardableResult func create(name:String)throws -> URL {
        guard !name.isEmpty,name==name.trimmingCharacters(in:.whitespacesAndNewlines),name != ".",name != "..",
              !name.contains("/"),!name.contains("\\"),!name.contains("\0"),name.utf8.count<=255 else {
            throw Failure.reason("Choose a folder name without slashes or parent-directory shortcuts.")
        }
        guard rootAvailable else{throw Failure.reason("Your workspace folder is unavailable. Choose an existing folder in Preferences.")}
        let url=root.appendingPathComponent(name,isDirectory:true).standardizedFileURL
        guard url.deletingLastPathComponent().path==root.path,!fm.fileExists(atPath:url.path),
              (try? fm.destinationOfSymbolicLink(atPath:url.path))==nil else {
            throw Failure.reason("A file or folder with that name already exists.")
        }
        try fm.createDirectory(at:url,withIntermediateDirectories:false)
        _=projects()
        return url
    }
}
