import AppKit
import Carbon
import UserNotifications
import WebKit

// Physical keys on a separate Micro layer emit these same global shortcuts.
let bindings: [(action: String, key: Int)] = [
    ("capture", kVK_Space), ("requests", kVK_ANSI_J), ("previous", kVK_ANSI_K),
    ("next", kVK_ANSI_L), ("confirm", kVK_Return), ("back", kVK_Escape),
    ("yes", kVK_ANSI_Y), ("no", kVK_ANSI_N), ("discuss", kVK_ANSI_T)
]
let binaryActions:Set<String>=["yes","no","discuss"]
let hotKeySignature: OSType = 0x57534150 // WSAP

final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}
final class NotchWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
final class WorkspaceWindow: NSWindow {
    var closeCardOrWindow: () -> Void = {}
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
           event.charactersIgnoringModifiers?.lowercased() == "w" {
            closeCardOrWindow()
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}
final class Assistant: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler,
                       WKNavigationDelegate, UNUserNotificationCenterDelegate {
    private let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let notifications = UNUserNotificationCenter.current()
    private var panel: NSPanel!
    private lazy var workspace: WorkspaceWindow = {
        let window = WorkspaceWindow(contentRect:NSRect(x:0,y:0,width:1020,height:680),
                                     styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false)
        window.title="Tasktap"
        window.minSize=NSSize(width:560,height:400)
        window.isReleasedWhenClosed=false
        window.delegate=self
        window.center()
        if !verifying {window.setFrameAutosaveName("TasktapWorkspace")}
        window.closeCardOrWindow={ [weak self] in self?.deliver("close-front",reveal:false) }
        return window
    }()
    private var web: WKWebView!
    private var entry: URL!
    private let liveTest = CommandLine.arguments.contains("--verify-live")
    private let verifying = CommandLine.arguments.contains("--verify-interface")
    private var ready = false
    private var routeTask: Task<Void, Never>?
    private var routeID: String?
    private var queue: [(String, String)] = []
    private var pendingCount = 0
    private var isWorkspace = false
    private var height: CGFloat = 290
    private var collapsed = true
    private var anchorScreen: NSScreen?
    private var hoverTimer: Timer?
    private var pointerInside = false
    private var hotKeys: [Int:EventHotKeyRef] = [:]
    private var binaryID=""
    private var lightingEnabled=false
    private var lightingActive=false
    private let micro=Micro()
    private let screenContext=ScreenContext()
    @MainActor private lazy var dictation=Dictation()
    private lazy var runtime=LiveWorkspace(root:(liveTest ? inbox.directory.deletingLastPathComponent():FileManager.default.homeDirectoryForCurrentUser).appendingPathComponent("projects"),data:inbox.directory.deletingLastPathComponent().appendingPathComponent("Runs"))
    private func js(_ name:String,_ args:[String:Any]){
        web.callAsyncJavaScript(name,arguments:args,in:nil,in:.page){result in if case .failure(let error)=result {NSLog("Interface: %@",error.localizedDescription)}}
    }
    @MainActor private lazy var narration=Narration()
    private lazy var inbox:QuestionInbox = {
        let root = (verifying || liveTest) ? FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("Agent Inbox") :
            FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("Tasktap/Agent Inbox")
        return QuestionInbox(directory:root)
    }()
    private var verifiedLights:[Bool]=[]
    private var handler: EventHandlerRef?
    private var held: Set<UInt32> = []
    private var unavailable: [String] = []
    private var screenObserver: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        if CommandLine.arguments.contains("--verify-kokoro") {
            var played=false
            narration.changed={ phase in
                if phase=="speaking" {played=true}
                if played && phase=="idle" {print("Kokoro preview played to completion.");NSApp.terminate(nil)}
                if !["idle","preparing","speaking"].contains(phase){fputs(phase+"\n",stderr);exit(1)}
            }
            narration.speak("Tasktap is ready.",voice:"kokoro")
            DispatchQueue.main.asyncAfter(deadline:.now()+60){fputs("Kokoro playback timed out.\n",stderr);exit(1)}
            return
        }
        if !verifying && !liveTest {screenContext.start()}
        notifications.delegate = self
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = .audio
        if liveTest {config.websiteDataStore = .nonPersistent()}
        if verifying {
            config.websiteDataStore = .nonPersistent()
            config.userContentController.addUserScript(WKUserScript(source:"window.fixtureMode=true",injectionTime:.atDocumentStart,forMainFrameOnly:true))
        }
        config.userContentController.add(self, name: "workspace")
        web = NotchWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        panel = NotchPanel(contentRect: NSRect(x: 0,y: 0,width: 440,height: 290),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces,.fullScreenAuxiliary]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.delegate = self
        panel.contentView = web
        status.button?.image = TasktapMark.menuImage()
        updateMenu()
        micro.statusChanged={ [weak self] s in self?.deliver("micro-status",s,reveal:false) }
        micro.keyPressed={ [weak self] action in
            guard let self,!self.binaryID.isEmpty else {return}
            self.deliver("hw-"+action,self.binaryID,reveal:action=="discuss")
        }
        narration.changed={ [weak self] s in self?.deliver("narration-status",s,reveal:false) }
        narration.kokoroStatus={ [weak self] status,detail in self?.js("updateKokoro(status,detail)",["status":status,"detail":detail]) }
        registerKeys()
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.anchorScreen=nil
            self?.position()
        }
        guard let url = Bundle.main.url(forResource:"index", withExtension:"html", subdirectory:"prototype") else {
            NSLog("Missing bundled interface"); NSApp.terminate(nil); return
        }
        entry = url
        web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        if verifying {
            DispatchQueue.main.asyncAfter(deadline:.now()+12) {
                fputs("Timed out waiting for native interface verification.\n",stderr);exit(1)
            }
        }
    }

    private func cameraRegion(_ screen: NSScreen) -> NSRect {
        guard screen.safeAreaInsets.top > 0, let left=screen.auxiliaryTopLeftArea,
              let right=screen.auxiliaryTopRightArea, right.minX > left.maxX else { return .zero }
        return NSRect(x:left.maxX,y:screen.frame.maxY-screen.safeAreaInsets.top,
                      width:right.minX-left.maxX,height:screen.safeAreaInsets.top)
    }

    private func position() {
        guard let screen = anchorScreen ?? NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main else { return }
        anchorScreen=screen
        let area = screen.visibleFrame
        let camera=cameraRegion(screen)
        let tabWidth=camera.isEmpty ? 174 : camera.width
        let tabHeight=camera.isEmpty ? 34 : camera.height
        // The transparent margin contains the glow on actual display pixels.
        let glowMargin:CGFloat=8
        let w = min(collapsed ? tabWidth+2*glowMargin : max(440,tabWidth+2*glowMargin), area.width)
        let maxHeight = Int(area.height) - 40
        if ready {
            let geometry="""
                document.documentElement.style.setProperty('--available-panel-height','\(maxHeight)px');
                document.documentElement.style.setProperty('--native-tab-width','\(tabWidth)px');
                document.documentElement.style.setProperty('--camera-height','\(tabHeight)px')
                """
            web.evaluateJavaScript(geometry,completionHandler:nil)
        }
        let h = min(collapsed ? tabHeight+glowMargin : max(tabHeight,height), area.height)
        let top=camera.isEmpty ? area.maxY : camera.maxY
        let center=camera.isEmpty ? area.midX : camera.midX
        let y = top - h
        let frame=NSRect(x:center-w/2,y:y,width:w,height:h)
        if panel.frame != frame { panel.setFrame(frame, display:true) }
    }

    private func updateHover(at point: NSPoint, dragging: Bool) {
        guard ready, !isWorkspace, panel.isVisible else { panel.ignoresMouseEvents=false;pointerInside=false;return }
        // The wide, transparent shoulders above an open card can overlap system menu items.
        let camera=anchorScreen.map(cameraRegion) ?? .zero
        let transparentShoulder = !camera.isEmpty && point.y>=camera.minY && !camera.contains(point)
        panel.ignoresMouseEvents=transparentShoulder
        var inside=panel.frame.contains(point)
        if transparentShoulder {inside=false}
        if !inside, let screen=NSScreen.screens.first(where:{ cameraRegion($0).contains(point) }),
           screen == anchorScreen || collapsed {
            inside=true
            if !dragging && screen != anchorScreen { anchorScreen=screen;position() }
        }
        if inside && dragging {
            if !collapsed { return }
            inside=false
        }
        guard inside != pointerInside else { return }
        pointerInside=inside
        // Passive peeks only change layout. No activation, first responder, or pointer synthesis.
        deliver(inside ? "hover-enter":"hover-exit",reveal:false)
    }

    private func observeHover() {
        // A camera housing is outside our web view. Read pointer position only;
        // this does not install an event tap or subscribe to other apps' input.
        let timer=Timer(timeInterval:0.08,repeats:true) { [weak self] _ in
            self?.updateHover(at:NSEvent.mouseLocation,dragging:NSEvent.pressedMouseButtons != 0)
        }
        timer.tolerance=0.025
        RunLoop.main.add(timer,forMode:.common)
        hoverTimer=timer
    }

    private func deliver(_ action: String, _ id: String = "", reveal: Bool = true) {
        guard ready else { queue.append((action,id)); return }
        if reveal {
            anchorScreen=NSScreen.screens.first(where:{ $0.frame.contains(NSEvent.mouseLocation) }) ?? anchorScreen
            position()
            if isWorkspace {
                if workspace.isMiniaturized {workspace.deminiaturize(nil)}
                workspace.makeKeyAndOrderFront(nil)
            } else {
                panel.orderFrontRegardless()
                panel.makeKey()
                panel.makeFirstResponder(web)
            }
        }
        web.callAsyncJavaScript("window.workspaceCommand(action, id)", arguments:["action":action,"id":id],
                                in:nil, in:.page) { result in
            if case let .failure(error) = result { NSLog("Workspace command failed: %@", error.localizedDescription) }
        }
    }

    private func add(_ name: String, _ command: String, to menu: NSMenu) {
        let item = NSMenuItem(title:name, action:#selector(menuAction(_:)), keyEquivalent:"")
        item.target=self; item.representedObject=command; menu.addItem(item)
    }
    private func updateMenu() {
        let menu=NSMenu()
        add("Show Notch", "home", to:menu)
        add("New Capture  ⌃⌥Space", "capture", to:menu)
        add("Review Decisions (\(pendingCount))  ⌃⌥J", "requests", to:menu)
        menu.addItem(.separator())
        add("Open Workspace", "workspace", to:menu)
        add("Preferences…", "prefs", to:menu)
        add("Notifications…", "notifications", to:menu)
        add("Codex Micro Controls…", "controller", to:menu)
        if !unavailable.isEmpty {
            menu.addItem(NSMenuItem(title:"Shortcut conflict: "+unavailable.joined(separator:", "), action:nil, keyEquivalent:""))
        }
        menu.addItem(.separator()); add("Quit Tasktap", "quit", to:menu)
        status.menu=menu
        status.button?.toolTip="Tasktap · \(pendingCount) pending decisions"
        status.button?.title=pendingCount>0 ? " \(pendingCount)" : ""
    }
    @objc private func menuAction(_ sender: NSMenuItem) {
        guard let command=sender.representedObject as? String else { return }
        if command=="quit" { NSApp.terminate(nil); return }
        deliver(command)
    }
    private func registerKeys(){
        var types=[EventTypeSpec(eventClass: OSType(kEventClassKeyboard),eventKind: UInt32(kEventHotKeyPressed)),
                   EventTypeSpec(eventClass: OSType(kEventClassKeyboard),eventKind: UInt32(kEventHotKeyReleased))]
        let installed=InstallEventHandler(GetApplicationEventTarget(), { _,event,userData in
            guard let event,let userData else { return OSStatus(eventNotHandledErr) }
            var hotKeyID=EventHotKeyID()
            guard GetEventParameter(event,EventParamName(kEventParamDirectObject),EventParamType(typeEventHotKeyID),
                                    nil,MemoryLayout<EventHotKeyID>.size,nil,&hotKeyID)==noErr,
                  hotKeyID.signature==hotKeySignature else { return OSStatus(eventNotHandledErr) }
            let owner=Unmanaged<Assistant>.fromOpaque(userData).takeUnretainedValue()
            owner.onKey(hotKeyID.id, pressed:GetEventKind(event)==UInt32(kEventHotKeyPressed))
            return noErr
        },2,&types,Unmanaged.passUnretained(self).toOpaque(),&handler)
        if installed==noErr {
            for (index,binding) in bindings.enumerated() where !binaryActions.contains(binding.action){registerKey(index)}
        } else {unavailable=bindings.map(\.action)}
        updateMenu()
    }
    private func registerKey(_ index:Int){
        let binding=bindings[index]
        var ref:EventHotKeyRef?
        let result=RegisterEventHotKey(UInt32(binding.key),UInt32(controlKey|optionKey),
            EventHotKeyID(signature:hotKeySignature,id:UInt32(index)),GetApplicationEventTarget(),0,&ref)
        if result==noErr,let ref {hotKeys[index]=ref}
        else if !unavailable.contains(binding.action){unavailable.append(binding.action)}
    }
    private func setBinary(_ id:String){
        guard id != binaryID else { return }
        let hadCard = !binaryID.isEmpty
        binaryID=id
        if hadCard != !id.isEmpty, handler != nil {
            for (index,binding) in bindings.enumerated() where binaryActions.contains(binding.action){
                if id.isEmpty {
                    if let ref=hotKeys.removeValue(forKey:index){UnregisterEventHotKey(ref)}
                    held.remove(UInt32(index));unavailable.removeAll{$0==binding.action}
                } else {registerKey(index)}
            }
            updateMenu()
        }
        syncLighting()
    }
    private func syncLighting(){
        let active=lightingEnabled && !binaryID.isEmpty
        guard active != lightingActive else {return}
        lightingActive=active
        if verifying {verifiedLights.append(active)}
        else {micro.setDecision(active)}
    }
    private func onKey(_ index: UInt32, pressed: Bool) {
        guard bindings.indices.contains(Int(index)) else { return }
        if !pressed { held.remove(index); return }
        guard held.insert(index).inserted else { return }
        let action=bindings[Int(index)].action
        if binaryActions.contains(action){
            if !binaryID.isEmpty {deliver("hw-"+action,binaryID,reveal:action=="discuss")}
            return
        }
        if ["previous","next","confirm","back"].contains(action) && !isWorkspace && !panel.isVisible { return }
        deliver("hw-"+action, reveal:["capture","requests"].contains(action))
    }

    func userContentController(_ controller: WKUserContentController,didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.webView === web,
              message.frameInfo.request.url?.standardizedFileURL == entry?.standardizedFileURL,
              let data=message.body as? [String:Any],let type=data["type"] as? String else { return }
        switch type {
        case "ready":
            ready=true;position();panel.orderFrontRegardless()
            if !verifying {
                observeHover()
                dictation.event={ [weak self] id,phase,text in self?.js("dictationEvent(id,phase,text)",["id":id,"phase":phase,"text":text]) }
                runtime.projectsChanged={ [weak self] rows in self?.js("projectsDiscovered(rows)",["rows":rows]) }
                runtime.changed={ [weak self] receipt in self?.js("agentReceipt(e)",["e":receipt]) }
                runtime.externalChanged={ [weak self] rows in self?.js("externalSessions(rows)",["rows":rows]) }
                do {try runtime.start();if !liveTest {runtime.watchSessions()}} catch {deliver("live-error",error.localizedDescription,reveal:false)}
            }
            do {try inbox.start(web:web)} catch {NSLog("Could not start agent inbox: %@",error.localizedDescription)}
            let voices=narration.voices
            web.callAsyncJavaScript("configureVoices(voices)",arguments:["voices":voices],in:nil,in:.page){_ in}
            let buffered=queue;queue.removeAll()
            for (action,id) in buffered { deliver(action,id) }
            if verifying { Task { @MainActor in await self.verifyInterface() } }
            if liveTest { Task { @MainActor in await self.verifyLive() } }
        case "layout":
            let needsWorkspace=data["workspace"] as? Bool ?? false
            if needsWorkspace != isWorkspace {
                isWorkspace=needsWorkspace
                if isWorkspace {
                    panel.orderOut(nil)
                    panel.contentView=nil
                    workspace.contentView=web
                    NSApp.activate()
                    workspace.makeKeyAndOrderFront(nil)
                    workspace.makeFirstResponder(web)
                } else {
                    workspace.orderOut(nil)
                    workspace.contentView=nil
                    panel.contentView=web
                    panel.orderFrontRegardless()
                }
            }
            collapsed=data["collapsed"] as? Bool ?? false
            height=CGFloat(data["height"] as? Double ?? 290)
            position()
        case "context-begin":
            if !verifying && !liveTest, let id=data["id"] as? String {screenContext.begin(id)}
        case "context-resolve":
            guard let id=data["id"] as? String, let request=data["request"] as? String,let kind=data["kind"] as? String else {return}
            if verifying || liveTest {js("captureContext.receive(id,result)",["id":request,"result":["message":"Choose a reference for this test."]]);return}
            screenContext.resolve(id,kind:kind,allowPermission:data["allowPermission"] as? Bool==true) { [weak self] result in
                self?.js("captureContext.receive(id,result)",["id":request,"result":result])
            }
        case "context-file":
            guard !verifying && !liveTest,let request=data["request"] as? String else {return}
            let chooser=NSOpenPanel();chooser.canChooseDirectories=true;chooser.allowsMultipleSelection=false
            chooser.begin { [weak self] response in
                if response == .OK,let file=chooser.url {
                    self?.js("captureContext.receive(id,result)",["id":request,"result":["kind":"file","value":file.path,"app":"Chosen file"]])
                }
            }
        case "dictation-start":if let id=data["id"] as? String {dictation.start(id)}
        case "dictation-finish":if let id=data["id"] as? String {dictation.finish(id)}
        case "dictation-cancel":dictation.cancel()
        case "refresh":if !verifying {runtime.refresh();if !liveTest {runtime.refreshExternal()}}
        case "route":
            guard let id=data["id"] as? String,let input=data["input"] as? [String:Any] else {return}
            routeTask?.cancel()
            routeID = id
            routeTask = Task { @MainActor in
                let result = await HandoffRouter.suggest(input) { event in
                    guard self.routeID == id, !Task.isCancelled else { return }
                    self.js("routingProgress(id,event)", ["id":id,"event":event])
                }
                guard routeID == id, !Task.isCancelled else { return }
                routeID = nil
                routeTask = nil
                js("finishRouting(id,r)",["id":id,"r":result])
            }
        case "cancel-route":
            if let id=data["id"] as? String, id == routeID {
                routeID = nil
                routeTask?.cancel()
                routeTask = nil
            }
        case "assign-note":
            guard let id=data["id"] as? String,let capture=data["capture"] as? String,let folder=data["folder"] as? String else {return}
            do {try runtime.assignNote(capture,folder:folder);js("noteAssigned(id,project)",["id":id,"project":folder])}
            catch {deliver("live-error",error.localizedDescription,reveal:false)}
        case "enqueue":
            guard !verifying,var job=data["job"] as? [String:Any],let capture=job["capture"] as? String else {return}
            if let path=job["folder"] as? String,path.hasPrefix("~/projects/"){job["folder"]=runtime.root.appendingPathComponent(String(path.dropFirst("~/projects/".count))).standardizedFileURL.path}
            do {
                var result=try runtime.enqueue(job)
                result["capture"]=capture;result["task"]=job["task"] as? String
                js("acceptLive(data)",["data":result])
            } catch {js("acceptLive(data)",["data":["capture":capture,"error":error.localizedDescription]])}
        case "open-desktop-chat":
            guard let id=data["id"] as? String, UUID(uuidString:id) != nil, let url=URL(string:"codex://threads/"+id) else{return}
            if !NSWorkspace.shared.open(url){deliver("live-error","Install the ChatGPT desktop app to open this chat.",reveal:false)}
        case "resume-terminal","copy-resume":
            guard let id=data["id"] as? String else{return}
            do {
                let command=try runtime.resumeCommand(id)
                if type=="copy-resume"{
                    NSPasteboard.general.clearContents();NSPasteboard.general.setString(command,forType:.string)
                    deliver("live-error","Resume command copied.",reveal:false)
                } else {
                    let file=runtime.data.appendingPathComponent(id).appendingPathComponent("Resume.command")
                    try ("#!/bin/zsh\n"+command+"\n").write(to:file,atomically:true,encoding:.utf8)
                    try FileManager.default.setAttributes([.posixPermissions:0o700],ofItemAtPath:file.path)
                    guard let terminal=NSWorkspace.shared.urlForApplication(withBundleIdentifier:"com.apple.Terminal") else{throw LiveWorkspace.Failure.reason("Terminal is unavailable. Use Copy resume command.")}
                    NSWorkspace.shared.open([file],withApplicationAt:terminal,configuration:.init()){[weak self] _,error in
                        if let error{DispatchQueue.main.async{self?.deliver("live-error",error.localizedDescription,reveal:false)}}
                    }
                }
            } catch {deliver("live-error",error.localizedDescription,reveal:false)}
        case "open-result":
            guard let id=data["id"] as? String,UUID(uuidString:id) != nil,let text=data["text"] as? String,let viewer=data["viewer"] as? String else {return}
            do {
                let url=try ResultDocument.write(text,to:runtime.data.appendingPathComponent(id),for:viewer)
                if viewer=="Finder"{NSWorkspace.shared.activateFileViewerSelecting([url])}
                else if let app=NSWorkspace.shared.urlForApplication(withBundleIdentifier:viewer=="Xcode" ? "com.apple.dt.Xcode":"com.apple.Preview"){
                    NSWorkspace.shared.open([url],withApplicationAt:app,configuration:NSWorkspace.OpenConfiguration()){[weak self] _,error in
                        if let error {DispatchQueue.main.async{self?.deliver("live-error",error.localizedDescription,reveal:false)}}
                    }
                } else {deliver("live-error",viewer+" is unavailable on this Mac.",reveal:false)}
            } catch {deliver("live-error",error.localizedDescription,reveal:false)}
        case "status":pendingCount=data["count"] as? Int ?? 0;updateMenu()
        case "binary":if let id=data["id"] as? String {setBinary(id)}
        case "lightingPreference":
            lightingEnabled=data["enabled"] as? Bool ?? false
            if !verifying {micro.enable(lightingEnabled)}
            syncLighting()
        case "questionUpdated":inbox.scan()
        case "speak":
            if let text=data["text"] as? String,let voice=data["voice"] as? String {narration.speak(text,voice:voice)}
        case "check-kokoro":narration.reportKokoro()
        case "install-kokoro":narration.installKokoro()
        case "stopSpeech":narration.stop()
        case "authorize":
            notifications.requestAuthorization(options:[.alert,.sound]) { [weak self] ok,_ in
                DispatchQueue.main.async { self?.deliver(ok ? "notification-granted":"notification-denied",reveal:false) }
            }
        case "notify":
            guard let id=data["id"] as? String,let kind=data["kind"] as? String,
                  let title=data["title"] as? String,let body=data["body"] as? String else { return }
            let content=UNMutableNotificationContent();content.title=title;content.body=body
            content.categoryIdentifier=kind=="request" ? "decision":"result"
            content.userInfo=["id":id,"kind":kind]
            notifications.add(UNNotificationRequest(identifier:kind+"."+id,content:content,trigger:nil)) { error in
                if let error { NSLog("Notification delivery: %@",error.localizedDescription) }
            }
        case "clear":
            if let id=data["id"] as? String,let kind=data["kind"] as? String {
                notifications.removePendingNotificationRequests(withIdentifiers:[kind+"."+id])
                notifications.removeDeliveredNotifications(withIdentifiers:[kind+"."+id])
            }
        case "disableNotifications":
            notifications.removeAllPendingNotificationRequests();notifications.removeAllDeliveredNotifications()
        default:break
        }
    }
    // Run the packaged web view with ephemeral storage and synthetic controller commands.
    @MainActor private func verifyInterface() async {
        do {
            guard Micro.verifyWire() else {throw Check.failed(#line)}
            let start = try await web.evaluateJavaScript("document.body.classList.contains('native-host') && document.querySelector('#notch-home').hidden")
            guard start as? Bool == true else { throw Check.failed(#line) }
            let front=NSWorkspace.shared.frontmostApplication?.processIdentifier
            let responder=panel.firstResponder
            let key=panel.isKeyWindow
            let compactWidth=panel.frame.width
            let compactTop=panel.frame.maxY
            let outside=NSPoint(x:panel.frame.midX+450,y:panel.frame.minY-30)
            // Inject coordinates into the same observation path without moving the user's mouse.
            updateHover(at:NSPoint(x:panel.frame.midX,y:panel.frame.midY),dragging:true)
            guard !pointerInside else { throw Check.failed(#line) }
            let hotRegion=anchorScreen.map(cameraRegion) ?? .zero
            let point=hotRegion.isEmpty ? NSPoint(x:panel.frame.midX,y:panel.frame.midY) : NSPoint(x:hotRegion.midX,y:hotRegion.midY)
            updateHover(at:point,dragging:false)
            try await Task.sleep(nanoseconds:550_000_000)
            let peek=try await web.evaluateJavaScript("!document.querySelector('#notch-home').hidden")
            guard peek as? Bool == true, panel.frame.width>compactWidth, abs(panel.frame.maxY-compactTop)<1,
                  panel.isKeyWindow==key, panel.firstResponder===responder,
                  NSWorkspace.shared.frontmostApplication?.processIdentifier==front else { throw Check.failed(#line) }
            updateHover(at:outside,dragging:false)
            try await Task.sleep(nanoseconds:650_000_000)
            let shut=try await web.evaluateJavaScript("document.querySelector('#notch-home').hidden")
            guard shut as? Bool == true, panel.frame.width==compactWidth, panel.isKeyWindow==key,
                  NSWorkspace.shared.frontmostApplication?.processIdentifier==front else { throw Check.failed(#line) }
            for action in ["requests","next","confirm"] {
                let index = bindings.firstIndex(where: { $0.action == action })!
                onKey(UInt32(index),pressed:true);onKey(UInt32(index),pressed:false)
                try await Task.sleep(nanoseconds:180_000_000)
            }
            let resolved = try await web.evaluateJavaScript("state.decisions.length === 0 && sess('s2').log.filter(x => x.includes('Clear glass')).length === 1")
            guard resolved as? Bool == true else { throw Check.failed(#line) }
            let file=inbox.directory.appendingPathComponent("requests/75d25406-e98e-43f2-bf12-665fb0cccedd.json")
            let event=["agent":"claude","workspace":"~/projects/glasshouse","sessionId":"smoke","requestId":"lighting","question":"Keep the rim light?"]
            try JSONSerialization.data(withJSONObject:event).write(to:file,options:.atomic)
            try await Task.sleep(nanoseconds:350_000_000)
            _ = try await web.evaluateJavaScript("postHost('lightingPreference',{enabled:true});openRequest(state.decisions[0].id);true")
            try await Task.sleep(nanoseconds:220_000_000)
            let id=binaryID
            guard !id.isEmpty,lightingActive else {throw Check.failed(#line)}
            let cutout=anchorScreen.map(cameraRegion) ?? .zero
            if !cutout.isEmpty {
                let offset=try await web.evaluateJavaScript("document.querySelector('#notch').getBoundingClientRect().top")
                guard let top=offset as? Double, panel.frame.maxY-top <= cutout.minY+1 else {throw Check.failed(#line)}
            }
            let talk=UInt32(bindings.firstIndex{$0.action=="discuss"}!)
            onKey(talk,pressed:true);onKey(talk,pressed:false)
            try await Task.sleep(nanoseconds:180_000_000)
            guard binaryID.isEmpty,!lightingActive else {throw Check.failed(#line)}
            _ = try await web.evaluateJavaScript("document.querySelector('#comment').value='What changes?';document.querySelector('#discussion').requestSubmit();document.querySelector('[data-action=notch][type=button]').click();true")
            try await Task.sleep(nanoseconds:150_000_000)
            guard binaryID==id else {throw Check.failed(#line)}
            let yes=UInt32(bindings.firstIndex{$0.action=="yes"}!)
            onKey(yes,pressed:true);onKey(yes,pressed:false)
            try await Task.sleep(nanoseconds:250_000_000)
            let response=inbox.directory.appendingPathComponent("responses").appendingPathComponent(file.lastPathComponent)
            let reply=try JSONSerialization.jsonObject(with:Data(contentsOf:response)) as? [String:Any]
            let binaryResolved=try await web.evaluateJavaScript("state.decisions.length===0")
            guard reply?["answer"] as? String=="Yes",reply?["discussion"] as? [String]==["What changes?"] else {throw Check.failed(#line)}
            guard binaryResolved as? Bool==true, binaryID.isEmpty, !lightingActive,
                  verifiedLights==[true,false,true,false] else {throw Check.failed(#line)}
            deliver("hw-capture");try await Task.sleep(nanoseconds:180_000_000)
            let captured = try await web.evaluateJavaScript("document.querySelector('#modal').open && !!document.querySelector('#transcript')")
            guard captured as? Bool == true else { throw Check.failed(#line) }
            deliver("workspace")
            try await Task.sleep(nanoseconds:300_000_000)
            guard isWorkspace,workspace.isVisible,workspace.standardWindowButton(.closeButton) != nil,workspace.styleMask.contains(.resizable) else {throw Check.failed(#line)}
            var motionReady=false
            for _ in 0..<42 {
                let value=try await web.evaluateJavaScript("""
                    (()=>{const v=document.querySelector('[data-film=stage]');
                    return !!v && (matchMedia('(prefers-reduced-motion: reduce)').matches ?
                        !v.hasAttribute('src') && !!v.poster : v.currentTime>0 && !v.paused)})()
                    """)
                if value as? Bool==true {motionReady=true;break}
                try await Task.sleep(nanoseconds:120_000_000)
            }
            if !motionReady {
                let diagnostic=try await web.evaluateJavaScript("""
                    (()=>{const v=document.querySelector('[data-film=stage]');
                    return JSON.stringify({view,hidden:document.hidden,modal:!!document.querySelector('dialog[open]'),
                        video:v?{src:v.currentSrc,state:v.readyState,error:v.error?.message,paused:v.paused,time:v.currentTime}:null})})()
                    """)
                print("Motion verification",diagnostic ?? "unavailable")
                throw Check.failed(#line)
            }
            workspace.setContentSize(NSSize(width:760,height:480))
            let resized=workspace.frame
            deliver("prefs")
            try await Task.sleep(nanoseconds:200_000_000)
            _ = try await web.evaluateJavaScript("document.querySelector('#modal [aria-label=\"Close dialog\"]').click();true")
            let cardClosed=try await web.evaluateJavaScript("!document.querySelector('#modal').open")
            guard cardClosed as? Bool==true,workspace.frame==resized else {throw Check.failed(#line)}
            workspace.performClose(nil)
            try await Task.sleep(nanoseconds:250_000_000)
            guard !isWorkspace,!workspace.isVisible,panel.isVisible else {throw Check.failed(#line)}
            print("Workspace resized, dialog dismissed, and native close returned to the resident notch.")
            print("Passive hover, focus, decisions, discussion, agent inbox round trip and four lighting state changes and capture verified. Shortcut conflicts: \(unavailable)")
            NSApp.terminate(nil)
        } catch { fputs("Native interface verification failed: \(error)\n",stderr);exit(1) }
    }
    @MainActor private func verifyLive() async {
        do {
            let folder=runtime.root.appendingPathComponent("test-lighting")
            try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
            runtime.refresh()
            _ = try await web.evaluateJavaScript("""
                showWorkspace();go('projects');
                if(document.querySelector('#project-list button'))throw Error('Idle project visible before opting in');
                document.querySelector('#include-idle').click();
                document.querySelector('#project-list button').click();
                document.querySelector('[data-action="start-session"]').click();
                draft.text='Ask Codex to respond with exactly READY and do not use tools.';
                document.querySelector('#transcript').value=draft.text;document.querySelector('#transcript').dispatchEvent(new Event('input'));document.querySelector('[data-action=review]').click();true
                """)
            let review=try await web.evaluateJavaScript("!!document.querySelector('#review-brief') && draft.agent==='codex' && draft.project.endsWith('test-lighting')")
            guard review as? Bool==true else {throw Check.failed(#line)}
            _ = try await web.evaluateJavaScript("document.querySelector('[data-action=commit-review]').click();true")
            for _ in 0..<120 {
                try await Task.sleep(nanoseconds:1_000_000_000)
                let result=try await web.evaluateJavaScript("state.sessions[0]?.state||''")
                if result as? String=="Failed" {throw Check.failed(#line)}
                if result as? String=="Complete" {
                    let actual=try await web.evaluateJavaScript("state.sessions[0].result.trim()")
                    guard actual as? String=="READY" else {throw Check.failed(#line)}
                    guard let id=try await web.evaluateJavaScript("state.sessions[0].id") as? String,
                          try runtime.resumeCommand(id).contains("codex resume ") else {throw Check.failed(#line)}
                    print("Idle project → selected workspace → reviewed Codex session → real completed result passed.")
                    NSApp.terminate(nil);return
                }
            }
            throw Check.failed(#line)
        } catch {fputs("Live integration failed: \(error)\n",stderr);exit(1)}
    }
    private enum Check: Error { case failed(Int) }
    func applicationWillFinishLaunching(_ notification: Notification){
        let review=UNNotificationAction(identifier:"review",title:"Review in notch",options:[.foreground])
        let open=UNNotificationAction(identifier:"open",title:"View result",options:[.foreground])
        notifications.setNotificationCategories([
            UNNotificationCategory(identifier:"decision",actions:[review],intentIdentifiers:[],options:[]),
            UNNotificationCategory(identifier:"result",actions:[open],intentIdentifiers:[],options:[])
        ])
    }
    func userNotificationCenter(_ center:UNUserNotificationCenter,willPresent notification:UNNotification,
                                withCompletionHandler handler:@escaping (UNNotificationPresentationOptions)->Void){handler([.banner,.list])}
    func userNotificationCenter(_ center:UNUserNotificationCenter,didReceive response:UNNotificationResponse,
                                withCompletionHandler handler:@escaping ()->Void){
        defer { handler() }
        let info=response.notification.request.content.userInfo
        guard response.actionIdentifier != UNNotificationDismissActionIdentifier,
              let id=info["id"] as? String,let kind=info["kind"] as? String else { return }
        DispatchQueue.main.async { self.deliver(kind=="request" ? "notice-request":"notice-result",id) }
    }
    func webView(_ webView:WKWebView,decidePolicyFor navigationAction:WKNavigationAction,
                 decisionHandler:@escaping (WKNavigationActionPolicy)->Void){
        decisionHandler(navigationAction.request.url?.standardizedFileURL==entry?.standardizedFileURL ? .allow:.cancel)
    }
    func windowShouldClose(_ sender:NSWindow)->Bool { deliver("collapse",reveal:false);return false }
    func applicationWillTerminate(_ notification:Notification){
        hoverTimer?.invalidate()
        lightingEnabled=false;syncLighting()
        narration.changed={_ in};micro.stop();inbox.stop();narration.stop();dictation.cancel();if !verifying{runtime.stop()}
        for key in hotKeys.values { UnregisterEventHotKey(key) }
        if let handler { RemoveEventHandler(handler) }
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
    }
}
let app=NSApplication.shared
let delegate=Assistant()
app.delegate=delegate
app.run()
