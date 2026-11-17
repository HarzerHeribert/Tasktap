// swiftc native/WorkspaceFolders.swift native/LiveWorkspace.swift
//   native/WorkspaceTerminals.swift
//   scripts/verify-workspace-folders.swift -o /tmp/verify-workspace-folders
// A harmless runner validates native handoffs without invoking an agent or app.
import Foundation
enum SessionHelpers {
    static var launches=0
    static func runner()throws -> URL {launches += 1;return URL(fileURLWithPath:"/usr/bin/true")}
}
@main struct WorkspaceFolderChecks {
    static let fm=FileManager.default
    static func mkdir(_ url:URL)throws {try fm.createDirectory(at:url,withIntermediateDirectories:true)}
    static func rejects(_ name:String,_ action:()throws->Void) {
        do {try action();fatalError("Unexpectedly accepted: "+name)}catch{}
    }
    static func job(folder:URL,mode:String="note")->[String:Any] {
        ["session":UUID().uuidString,"capture":UUID().uuidString,"folder":folder.path,"mode":mode,
         "agent":"codex","delivery":"interactive","outgoing":"Fixture request","instructions":"Fixture","note":"A saved note."]
    }
    static func main()throws {
        let base=fm.temporaryDirectory.appendingPathComponent("tasktap-folder-check-"+UUID().uuidString,isDirectory:true)
        try mkdir(base);defer{try? fm.removeItem(at:base)}
        let root=base.appendingPathComponent("Chosen workspaces"),outside=base.appendingPathComponent("Elsewhere/Independent project"),storage=base.appendingPathComponent("Preferences/folders.json")
        let missing=base.appendingPathComponent("Missing default")
        let missingCatalog=WorkspaceFolders(storage:base.appendingPathComponent("Missing prefs.json"),defaultRoot:missing)
        precondition(missingCatalog.projects().isEmpty && !fm.fileExists(atPath:missing.path))
        let missingRuntime=LiveWorkspace(folders:missingCatalog,data:base.appendingPathComponent("Missing test/Runs"))
        try missingRuntime.start();missingRuntime.stop()
        precondition(!fm.fileExists(atPath:missing.path),"App startup must not create the configured root.")
        rejects("creation under a missing root"){_ = try missingCatalog.create(name:"First workspace")}

        try mkdir(root);try mkdir(outside)
        let alpha=root.appendingPathComponent("Alpha"),alias=root.appendingPathComponent("Alias")
        try mkdir(alpha);try fm.createSymbolicLink(at:alias,withDestinationURL:outside)
        let folders=WorkspaceFolders(storage:storage,defaultRoot:root)
        precondition(folders.allowsExisting(alpha) && folders.allowsExisting(alias),"Logical root aliases remain valid projects.")
        precondition(!folders.allowsExisting(outside),"An alias does not authorize arbitrary bridge paths outside the root.")
        let initial=folders.projects()
        precondition(initial.count==2 && initial.allSatisfy{$0["available"]=="true"})
        precondition(initial.first{$0["folder"]==alias.path}?["checkout"]==WorkspaceFolders.canonical(outside).path)
        let nested=alpha.appendingPathComponent("Nested");try mkdir(nested)
        precondition(!folders.allowsExisting(nested),"Only immediate root children are implicitly authorized.")
        _=try folders.authorize(outside);precondition(folders.allowsExisting(outside))
        _=try folders.authorize(outside);precondition(folders.projects().filter{$0["folder"]==outside.path}.count==1)
        let reloaded=WorkspaceFolders(storage:storage,defaultRoot:missing)
        precondition(reloaded.root.path==root.path && reloaded.allowsExisting(outside))
        try fm.removeItem(at:alpha)
        precondition(reloaded.projects().first{$0["folder"]==alpha.path}?["available"]=="false","Missing folders remain identifiable.")
        precondition(WorkspaceFolders(storage:storage).projects().first{$0["folder"]==alpha.path}?["available"]=="false")

        let retained=try reloaded.create(name:"Keep workspace")
        let second=base.appendingPathComponent("New selected root");try mkdir(second)
        try reloaded.setRoot(second)
        precondition(reloaded.root.path==second.path && reloaded.allowsExisting(retained) && reloaded.allowsExisting(outside))
        precondition(reloaded.projects().first{$0["folder"]==retained.path}?["available"]=="true","Changing the default must retain existing workspaces.")
        let created=try reloaded.create(name:"Project with spaces")
        precondition(created.deletingLastPathComponent().path==second.path && reloaded.allowsExisting(created))
        for name in ["",".","..","../Escape","A/B","A\\B"," leading","trailing "] {rejects("unsafe name "+name){_=try reloaded.create(name:name)}}
        rejects("existing directory"){_=try reloaded.create(name:"Project with spaces")}
        let dangling=second.appendingPathComponent("Dangling")
        try fm.createSymbolicLink(at:dangling,withDestinationURL:base.appendingPathComponent("Does not exist"))
        rejects("dangling symlink"){_=try reloaded.create(name:"Dangling")}
        precondition(!fm.fileExists(atPath:base.appendingPathComponent("Escape").path))

        // Explicit outside picks retain the chosen target when a symlink changes.
        let pickedAlias=base.appendingPathComponent("Picked alias"),replacement=base.appendingPathComponent("Different target")
        try mkdir(replacement);try fm.createSymbolicLink(at:pickedAlias,withDestinationURL:outside)
        _=try reloaded.authorize(pickedAlias);try fm.removeItem(at:pickedAlias);try fm.createSymbolicLink(at:pickedAlias,withDestinationURL:replacement)
        precondition(!reloaded.allowsExisting(pickedAlias))
        precondition(reloaded.projects().first{$0["folder"]==pickedAlias.path}?["available"]=="false")
        let rootAlias=base.appendingPathComponent("Root alias")
        try fm.createSymbolicLink(at:rootAlias,withDestinationURL:second)
        let aliasCatalog=WorkspaceFolders(root:rootAlias)
        precondition(aliasCatalog.allowsExisting(rootAlias.appendingPathComponent(created.lastPathComponent)))
        try fm.removeItem(at:rootAlias);try fm.createSymbolicLink(at:rootAlias,withDestinationURL:replacement)
        precondition(aliasCatalog.configuration["rootAvailable"] as? Bool==false,"Changed root symlinks require a new selection.")

        let runtime=LiveWorkspace(folders:reloaded,data:base.appendingPathComponent("Runtime/Runs"))
        try runtime.start();defer{runtime.stop()}
        precondition(runtime.root.path==second.path)
        _=try runtime.enqueue(job(folder:outside))
        _=try runtime.enqueue(job(folder:retained))
        var retainedLaunch=job(folder:retained,mode:"ask");retainedLaunch["reviewedFolder"]=WorkspaceFolders.canonical(retained).path
        _=try runtime.enqueue(retainedLaunch)
        var outsideLaunch=job(folder:outside,mode:"ask");outsideLaunch["reviewedFolder"]=WorkspaceFolders.canonical(outside).path
        _=try runtime.enqueue(outsideLaunch)
        rejects("unapproved note path"){_=try runtime.enqueue(job(folder:replacement))}
        let createPath=second.appendingPathComponent("Reviewed new workspace")
        var create=job(folder:createPath,mode:"ask");create["create"]=true;create["reviewedFolder"]=createPath.path
        _=try runtime.enqueue(create)
        let records=try fm.contentsOfDirectory(at:runtime.data.appendingPathComponent(create["session"] as! String),includingPropertiesForKeys:nil).filter{$0.pathExtension=="job"}
        let recorded=try JSONSerialization.jsonObject(with:Data(contentsOf:records[0])) as! [String:Any]
        precondition(recorded["reviewedFolder"] as? String==WorkspaceFolders.canonical(createPath).path)
        var wrong=job(folder:outside,mode:"ask");wrong["create"]=true;wrong["reviewedFolder"]=second.appendingPathComponent(outside.lastPathComponent).path
        rejects("reviewed another location with same basename"){_=try runtime.enqueue(wrong)}
        wrong=job(folder:createPath,mode:"ask");wrong["reviewedFolder"]="~/projects/"+createPath.lastPathComponent
        rejects("hardcoded old root in a review"){_=try runtime.enqueue(wrong)}
        let runtimeAlias=second.appendingPathComponent("Reviewed alias")
        try fm.createSymbolicLink(at:runtimeAlias,withDestinationURL:outside)
        var aliasJob=job(folder:runtimeAlias,mode:"ask");aliasJob["reviewedFolder"]=WorkspaceFolders.canonical(outside).path
        _=try runtime.enqueue(aliasJob)
        try fm.removeItem(at:runtimeAlias);try fm.createSymbolicLink(at:runtimeAlias,withDestinationURL:replacement)
        aliasJob["session"]=UUID().uuidString;aliasJob["capture"]=UUID().uuidString
        rejects("alias changed after its location was reviewed"){_=try runtime.enqueue(aliasJob)}

        // The terminal bridge shares the same authorization, not a cwd string
        // from JavaScript. Valid fixture starts cannot find a bundled PTY helper.
        let terminals=WorkspaceTerminals()
        try mkdir(created.appendingPathComponent("Nested"))
        rejects("terminal outside the catalog"){try terminals.handle(["op":"start","id":UUID().uuidString,"cwd":replacement.path],folders:reloaded,runs:base.appendingPathComponent("Runs"))}
        rejects("terminal nested below an implicit root child"){try terminals.handle(["op":"start","id":UUID().uuidString,"cwd":created.appendingPathComponent("Nested").path],folders:reloaded,runs:base.appendingPathComponent("Runs"))}
        try terminals.handle(["op":"start","id":UUID().uuidString,"cwd":outside.path],folders:reloaded,runs:base.appendingPathComponent("Runs"))
        try terminals.handle(["op":"start","id":UUID().uuidString,"cwd":retained.path],folders:reloaded,runs:base.appendingPathComponent("Runs"))

        // Restored queued jobs must not start in a no-longer-authorized folder.
        let recoveryData=base.appendingPathComponent("Recovery/Runs"),session=UUID().uuidString,capture=UUID().uuidString
        let run=recoveryData.appendingPathComponent(session);try mkdir(run)
        var queued=job(folder:replacement,mode:"ask");queued["session"]=session;queued["capture"]=capture
        let queuedPath=run.appendingPathComponent("pending.job"),receipt=run.appendingPathComponent("pending.receipt")
        try JSONSerialization.data(withJSONObject:queued).write(to:queuedPath)
        try JSONSerialization.data(withJSONObject:["state":"Queued"]).write(to:receipt)
        let calls=SessionHelpers.launches,recovery=LiveWorkspace(folders:reloaded,data:recoveryData)
        try recovery.start();recovery.stop();precondition(SessionHelpers.launches==calls)
        let failure=try JSONSerialization.jsonObject(with:Data(contentsOf:receipt)) as! [String:String]
        precondition(failure["state"]=="Failed")
        rejects("retry in unapproved folder"){_=try recovery.failedHandoff(session:session,capture:capture)}
        var reopenError:String?
        recovery.reopenSession(session){reopenError=$0}
        precondition(reopenError?.contains("workspace folder is unavailable")==true && SessionHelpers.launches==calls)
        print("PASS: persisted roots and approvals, no startup root creation, root aliases, missing rows, safe creation, reviewed-folder identity, outside handoffs, terminal authorization, and recovery/retry scope.")
    }
}
