import AppKit
import Carbon
import UserNotifications
import WebKit
import ServiceManagement
import UniformTypeIdentifiers

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
    private(set) var dividerCursorAxis:String?
    func setDividerCursor(_ axis:String?) {
        let next=["x","y"].contains(axis ?? "") ? axis:nil,previous=dividerCursorAxis
        dividerCursorAxis=next
        if next=="x" {NSCursor.resizeLeftRight.set()}
        else if next=="y" {NSCursor.resizeUpDown.set()}
        else if previous != nil {NSCursor.arrow.set()}
    }
    private var headerMouseDown:NSEvent?
    override func sendEvent(_ event:NSEvent) {
        if event.type == .leftMouseDown {headerMouseDown=event}
        if event.type == .leftMouseUp {headerMouseDown=nil}
        super.sendEvent(event)
        if [.mouseMoved,.leftMouseDragged,.leftMouseDown,.leftMouseUp].contains(event.type),dividerCursorAxis != nil {setDividerCursor(dividerCursorAxis)}
    }
    func dragHeader() {
        guard let event=headerMouseDown,NSEvent.pressedMouseButtons & 1 != 0 else {return}
        if event.clickCount==2 {performZoom(nil)} else {performDrag(with:event)}
        headerMouseDown=nil
    }
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
                       WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply, UNUserNotificationCenterDelegate, NSMenuItemValidation {
    private let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let notifications = UNUserNotificationCenter.current()
    private var panel: NSPanel!
    private lazy var workspace: WorkspaceWindow = {
        let window = WorkspaceWindow(contentRect:NSRect(x:0,y:0,width:1280,height:820),
                                     styleMask:[.titled,.closable,.miniaturizable,.resizable,.fullSizeContentView],backing:.buffered,defer:false)
        window.title="Tasktap"
        window.titleVisibility = .hidden
        window.minSize=NSSize(width:560,height:400)
        window.isReleasedWhenClosed=false
        window.acceptsMouseMovedEvents=true
        window.delegate=self
        window.center()
        if !verifying {window.setFrameAutosaveName("TasktapWorkspace")}
        window.closeCardOrWindow={ [weak self] in self?.deliver("close-front",reveal:false) }
        return window
    }()
    private let terminals = WorkspaceTerminals()
    private let workspaceMedia = WorkspaceMedia()
    private let workspaceBackdrop = WorkspaceBackdrop(frame:.zero)
    private var appearanceLoading=false
    private var web: WKWebView!
    private var notchWeb: WKWebView?
    private var notchReady = false
    private var notchQueue: [(String,String)] = []
    private var independentVerification: Bool {CommandLine.arguments.contains("--verify-independent-windows")}
    private var independentWindows: Bool {(!verifying && !liveTest) || independentVerification}
    private var entry: URL!
    private let liveTest = CommandLine.arguments.contains("--verify-live")
    private let workspaceVerification = CommandLine.arguments.contains("--verify-workspace") || CommandLine.arguments.contains("--verify-terminal-clipboard")
    private let verifying = CommandLine.arguments.contains("--verify-interface") || CommandLine.arguments.contains("--verify-workspace") || CommandLine.arguments.contains("--verify-independent-windows") || CommandLine.arguments.contains("--verify-terminal-clipboard")
    private lazy var terminalPasteboard: NSPasteboard = verifying ? .withUniqueName() : .general
    private var ready = false
    private var routeTask: Task<Void, Never>?
    private let sessionNames = SessionNames()
    private var updates: AppUpdates?
    private var routeID: String?
    @MainActor private lazy var routingProviders = RoutingProviders()
    private var serverProbe: Task<Void, Never>?
    private var connectionTask: Task<Void, Never>?
    private var workerCheck: Task<Void, Never>?
    private var workerLogin: Task<Void, Never>?
    private var identityCheck: Task<Void, Never>?
    private var queue: [(String, String)] = []
    private var pendingCount = 0
    private let decisionRim = WorkspaceDecisionRim()
    private var isWorkspace = false
    private var height: CGFloat = 290
    private var surfaceWidth: CGFloat = 432
    private var collapsed = true
    private var anchorScreen: NSScreen?
    private var hoverTimer: Timer?
    private var pointerInside = false
    private var menuWorkspaceAvailable = false
    private var hotKeys: [Int:EventHotKeyRef] = [:]
    private var binaryID=""
    private let screenContext=ScreenContext()
    @MainActor private lazy var dictation=Dictation()
    @MainActor private lazy var speech=SpeechService(directory:inbox.directory.deletingLastPathComponent().appendingPathComponent("Speech"))
    private var sendingVoiceLevel=false
    private lazy var runtime:LiveWorkspace = {
        let base=inbox.directory.deletingLastPathComponent(),data=base.appendingPathComponent("Runs")
        if verifying || liveTest {return LiveWorkspace(root:base.appendingPathComponent("projects"),data:data)}
        return LiveWorkspace(folders:WorkspaceFolders(storage:base.appendingPathComponent("WorkspaceFolders.json")),data:data)
    }()
    private func publishWorkspaceConfiguration(){
        js("workspaceSettings.receive(config)",["config":runtime.folders.configuration])
    }
    private func publishApplicationSettings(){
        js("preferencesPanel.receiveApplicationSettings(config)",["config":["launchAtLogin":SMAppService.mainApp.status == .enabled,"requiresApproval":SMAppService.mainApp.status == .requiresApproval]])
    }
    private func chooseWorkspaceFolder(asRoot:Bool){
        let chooser=NSOpenPanel();chooser.canChooseDirectories=true;chooser.canChooseFiles=false;chooser.allowsMultipleSelection=false;chooser.canCreateDirectories=true
        chooser.title=asRoot ? "Default workspace folder":"Open workspace"
        chooser.message=asRoot ? "Choose where Tasktap should create new workspaces. Existing workspaces stay where they are.":"Open this folder as a workspace. Your files stay in place."
        chooser.prompt=asRoot ? "Choose":"Open workspace"
        if FileManager.default.fileExists(atPath:runtime.root.path){chooser.directoryURL=runtime.root}
        chooser.begin { [weak self] response in
            guard let self,response == .OK,let url=chooser.url else{return}
            do {
                if asRoot {try self.runtime.folders.setRoot(url);self.publishWorkspaceConfiguration();self.runtime.refresh()}
                else {let selected=try self.runtime.folders.authorize(url);self.runtime.refresh();self.js("workspaceSettings.opened(row)",["row":["folder":selected.path,"name":selected.lastPathComponent,"checkout":selected.resolvingSymlinksInPath().path,"available":"true"]])}
            } catch {self.deliver("live-error",error.localizedDescription,reveal:false)}
        }
    }
    private func js(_ name:String,_ args:[String:Any]){
        for target in [web,notchReady ? notchWeb:nil].compactMap({$0}) {
            target.callAsyncJavaScript(name,arguments:args,in:nil,in:.page){result in if case .failure(let error)=result {NSLog("Interface: %@",error.localizedDescription)}}
        }
    }
    @MainActor private lazy var narration=Narration()
    private lazy var inbox=QuestionInbox(directory:((verifying || liveTest) ? FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) : LiveWorkspace.appData).appendingPathComponent("Agent Inbox"))
    private var handler: EventHandlerRef?
    private var held: Set<UInt32> = []
    private var capturePress: String?
    private var unavailable: [String] = []
    private var screenObserver: NSObjectProtocol?
    private var voiceOverObserver:NSKeyValueObservation?
    private let inputDiagnostics=TerminalInputDiagnostics(directory:LiveWorkspace.appData.appendingPathComponent("Diagnostics"))

    func applicationDidFinishLaunching(_ notification: Notification) {
        if !verifying && !liveTest,
           let identifier = Bundle.main.bundleIdentifier,
           let existing = NSRunningApplication.runningApplications(withBundleIdentifier: identifier).first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            existing.activate(options: [.activateAllWindows])
            NSApp.terminate(nil)
            return
        }
        NSApp.setActivationPolicy((verifying || liveTest) ? .accessory : .regular)
        ApplicationMenu.install(target:self,action:#selector(menuAction(_:)))
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
            config.userContentController.addUserScript(WKUserScript(source:(workspaceVerification || independentVerification) ? "window.fixtureMode=false" : "window.fixtureMode=true",injectionTime:.atDocumentStart,forMainFrameOnly:true))
        }
        if independentWindows {config.userContentController.addUserScript(WKUserScript(source:"window.tasktapSurface='workspace'",injectionTime:.atDocumentStart,forMainFrameOnly:true))}
        config.userContentController.addUserScript(WKUserScript(source:"window.tasktapScreenReaderEnabled=\(NSWorkspace.shared.isVoiceOverEnabled)",injectionTime:.atDocumentStart,forMainFrameOnly:true))
        if !verifying && !liveTest {config.userContentController.addUserScript(WKUserScript(source:"window.tasktapInputTraceUntil=\(inputDiagnostics.until)",injectionTime:.atDocumentStart,forMainFrameOnly:true))}
        config.userContentController.add(self, name: "workspace")
        config.userContentController.addScriptMessageHandler(self,contentWorld:.page,name:"terminalClipboard")
        config.setURLSchemeHandler(workspaceMedia, forURLScheme:"tasktap-preview")
        web = NotchWebView(frame: .zero, configuration: config)
        web.focusRingType = .none
        web.navigationDelegate = self
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        voiceOverObserver=NSWorkspace.shared.observe(\.isVoiceOverEnabled,options:[.new]) { [weak self] workspace,_ in
            let enabled=workspace.isVoiceOverEnabled
            DispatchQueue.main.async {self?.js("workspaceDeck.accessibilityChanged(enabled)",["enabled":enabled])}
        }
        panel = NotchPanel(contentRect: NSRect(x: 0,y: 0,width: 440,height: 290),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.level = NSWindow.Level(rawValue:NSWindow.Level.statusBar.rawValue + 1)
        panel.collectionBehavior = [.canJoinAllSpaces,.fullScreenAuxiliary]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.delegate = self
        if independentWindows {
            let notchConfig=WKWebViewConfiguration()
            notchConfig.websiteDataStore=config.websiteDataStore
            notchConfig.mediaTypesRequiringUserActionForPlayback = .audio
            notchConfig.userContentController.add(self,name:"workspace")
            notchConfig.userContentController.addUserScript(WKUserScript(source:"window.tasktapSurface='notch'",injectionTime:.atDocumentStart,forMainFrameOnly:true))
            if verifying {notchConfig.userContentController.addUserScript(WKUserScript(source:"window.fixtureMode=false",injectionTime:.atDocumentStart,forMainFrameOnly:true))}
            notchConfig.setURLSchemeHandler(workspaceMedia,forURLScheme:"tasktap-preview")
            let notch=NotchWebView(frame:.zero,configuration:notchConfig)
            notch.focusRingType = .none
            notch.navigationDelegate=self;notch.uiDelegate=self;notch.setValue(false,forKey:"drawsBackground")
            notchWeb=notch;panel.contentView=notch
            workspace.contentView=workspaceBackdrop;workspaceBackdrop.host(web)
        } else {panel.contentView=web}
        status.button?.image = TasktapMark.menuImage()
        updateMenu()
        narration.changed={ [weak self] s in self?.deliver("narration-status",s,reveal:false) }
        narration.kokoroStatus={ [weak self] status,detail in self?.js("updateKokoro(status,detail)",["status":status,"detail":detail]) }
        registerKeys()
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            let number = NSDeviceDescriptionKey("NSScreenNumber")
            let previous = self.anchorScreen?.deviceDescription[number] as? NSNumber
            self.anchorScreen = NSScreen.screens.first { ($0.deviceDescription[number] as? NSNumber) == previous }
            self.position()
        }
        guard let url = Bundle.main.url(forResource:"index", withExtension:"html", subdirectory:"prototype") else {
            NSLog("Missing bundled interface"); NSApp.terminate(nil); return
        }
        entry = url
        web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        notchWeb?.loadFileURL(url,allowingReadAccessTo:url.deletingLastPathComponent())
        if verifying {
            DispatchQueue.main.asyncAfter(deadline:.now()+((workspaceVerification || independentVerification) ? 60:12)) {
                fputs("Timed out waiting for native interface verification.\n",stderr);exit(1)
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if independentWindows {showWorkspaceWindow()} else {deliver("open-app")}
        return true
    }

    private func position() {
        guard let screen = anchorScreen ?? NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main else { return }
        anchorScreen = screen
        let geometry = NotchGeometry(screen: screen)
        let frame = geometry.panelFrame(collapsed: collapsed, requestedHeight: height, requestedWidth: surfaceWidth)
        if panel.frame != frame { panel.setFrame(frame, display: true) }
        decisionRim.update(screen: isWorkspace ? workspace.screen ?? screen : screen, visible: (independentWindows ? workspace.isVisible:isWorkspace) && pendingCount > 0)
        if ready {
            let expanded = geometry.panelFrame(collapsed:false,requestedHeight:height,requestedWidth:surfaceWidth)
            let metrics = ["width":geometry.tab.width, "height":geometry.tab.height, "shoulder":geometry.shoulder,
                           "compact":geometry.compact ? CGFloat(1) : CGFloat(0),
                           "surfaceWidth":expanded.width - 2 * geometry.shoulder,
                           "surfaceOffset":expanded.midX - geometry.tab.midX,
                           "pixel":geometry.pixel, "corner":geometry.corner, "rimOffset":geometry.rimOffset,
                           "offset":geometry.tab.midX - frame.midX,
                           "available":max(1,geometry.availableContentHeight)]
            (notchWeb ?? web).callAsyncJavaScript("updateNotchGeometry(metrics)",arguments:["metrics":metrics],in:nil,in:.page){_ in}
        }
    }

    private func updateHover(at point: NSPoint, dragging: Bool) {
        guard ready, (independentWindows || !isWorkspace), panel.isVisible else { panel.ignoresMouseEvents=false;pointerInside=false;return }
        guard var geometry = anchorScreen.map({NotchGeometry(screen:$0)}) else {return}
        if collapsed && !dragging, let destination = NSScreen.screens.first(where: {
            $0 != anchorScreen && NotchGeometry(screen:$0).panelFrame(collapsed:true, requestedHeight:0).contains(point)
        }) {
            anchorScreen = destination
            position()
            geometry=NotchGeometry(screen:destination)
        }
        let topBand = point.y >= geometry.tab.minY && point.y <= geometry.tab.maxY
        let inside = geometry.contains(point,in:panel.frame,collapsed:collapsed)
        // The shoulders are decorative. Menu items keep their mouse input even during a peek.
        panel.ignoresMouseEvents = !inside || (topBand && !geometry.tab.contains(point))
        if dragging {return}
        guard inside != pointerInside else { return }
        pointerInside=inside
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

    private func showWorkspaceWindow() {
        guard ready else {queue.append(("workspace",""));return}
        if workspace.isMiniaturized {workspace.deminiaturize(nil)}
        NSApp.activate();workspace.makeKeyAndOrderFront(nil);workspace.makeFirstResponder(web)
        if let screen=workspace.screen ?? anchorScreen ?? NSScreen.main {decisionRim.update(screen:screen,visible:pendingCount > 0)}
    }
    private func bootstrapNotch() {
        guard ready,notchReady,let notchWeb else {return}
        web.callAsyncJavaScript("return JSON.parse(JSON.stringify(state))",arguments:[:],in:nil,in:.page){ result in
            if case .success(let value)=result {notchWeb.callAsyncJavaScript("sharedState.snapshot(value)",arguments:["value":value],in:nil,in:.page){_ in}}
        }
        publishWorkspaceConfiguration();sendConnections();refreshUsage();speech.publish()
        let buffered=notchQueue;notchQueue.removeAll()
        for (action,id) in buffered {deliver(action,id)}
    }
    private func deliver(_ action: String, _ id: String = "", reveal: Bool = true, at point:NSPoint? = nil) {
        guard ready else { queue.append((action,id)); return }
        if independentWindows {
            let notchActions:Set<String>=["home","collapse","capture","requests","notice-request","hover-enter","hover-exit","hw-capture","hw-capture-end","hw-yes","hw-no","hw-discuss","hw-previous","hw-next","hw-confirm","hw-back","notch-onboarding"]
            let useNotch=notchActions.contains(action)
            if useNotch && !notchReady {notchQueue.append((action,id));return}
            let target=useNotch ? notchWeb!:web!
            if reveal {
                if useNotch {
                    anchorScreen=NSScreen.screens.first(where:{$0.frame.contains(point ?? NSEvent.mouseLocation)}) ?? anchorScreen
                    position();panel.orderFrontRegardless();panel.makeKey();panel.makeFirstResponder(target)
                }
                else {showWorkspaceWindow()}
            }
            target.callAsyncJavaScript("window.workspaceCommand(action,id)",arguments:["action":action=="notch-onboarding" ? "open-app":action,"id":id],in:nil,in:.page){_ in}
            return
        }
        if reveal {
            anchorScreen=NSScreen.screens.first(where:{ $0.frame.contains(point ?? NSEvent.mouseLocation) }) ?? anchorScreen
            position()
            if isWorkspace {
                if !["capture","hw-capture"].contains(action) {
                    if workspace.isMiniaturized {workspace.deminiaturize(nil)}
                    workspace.makeKeyAndOrderFront(nil)
                }
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
        add("Launch at Login", "launch-at-login", to:menu)
        menu.items.last?.state = SMAppService.mainApp.status == .enabled ? .on : .off
        if SMAppService.mainApp.status == .requiresApproval {
            menu.items.last?.title = "Approve Launch at Login…"
        }
        add(updates?.availableVersion.map { "Update to \($0)…" } ?? "Check for Updates…", "updates", to:menu)
        add("Automatically Check for Updates", "automatic-updates", to:menu)
        menu.items.last?.state = updates?.automaticallyChecks == true ? .on : .off
        add("Run Setup…", "run-setup", to:menu)
        add("Notifications…", "notifications", to:menu)
        if !unavailable.isEmpty {
            menu.addItem(NSMenuItem(title:"Shortcut conflict: "+unavailable.joined(separator:", "), action:nil, keyEquivalent:""))
        }
        menu.addItem(.separator()); add("Quit Tasktap", "quit", to:menu)
        status.menu=menu
        let hasUpdate = updates?.availableVersion != nil
        status.button?.toolTip="Tasktap / \(pendingCount) pending decisions" + (hasUpdate ? " / Update available" : "")
        status.button?.title=(pendingCount>0 ? " \(pendingCount)" : "") + (hasUpdate ? " ↑" : "")
    }
    @objc private func menuAction(_ sender: NSMenuItem) {
        guard let command=sender.representedObject as? String else { return }
        if command=="menu-edit-copy" || command=="menu-edit-paste" {
            let action=command=="menu-edit-copy" ? "copy":"paste"
            guard let target=NSApp.keyWindow === panel ? (notchWeb ?? web):web else {return}
            target.callAsyncJavaScript("return workspaceDeck.clipboardCommand(action,true)",arguments:["action":action],in:nil,in:.page){result in
                if case let .success(handled)=result,handled as? Bool == true {return}
                // Forms and the prompt composer keep WebKit's normal editing.
                NSApp.sendAction(NSSelectorFromString(action+":"),to:nil,from:sender)
            }
            return
        }
        if command=="menu-help" {
            NSWorkspace.shared.open(URL(string:"https://harzerheribert.github.io/Tasktap/docs/")!);return
        }
        if command=="menu-close" {
            guard let target=NSApp.keyWindow === panel ? (notchWeb ?? web):web else {return}
            target.callAsyncJavaScript("window.workspaceCommand('close-front')",arguments:[:],in:nil,in:.page){_ in}
            return
        }
        if command=="updates" { checkUpdates(); return }
        if command=="automatic-updates" {
            startUpdates()
            if let updates { updates.setAutomaticallyChecks(!updates.automaticallyChecks) }
            return
        }
        if command=="quit" { NSApp.terminate(nil); return }
        if command=="launch-at-login" {
            guard !verifying && !liveTest else { return }
            do {
                switch SMAppService.mainApp.status {
                case .enabled: try SMAppService.mainApp.unregister()
                case .requiresApproval: SMAppService.openSystemSettingsLoginItems()
                default:
                    try SMAppService.mainApp.register()
                    if SMAppService.mainApp.status == .requiresApproval {
                        SMAppService.openSystemSettingsLoginItems()
                    }
                }
            } catch {
                let alert = NSAlert()
                alert.messageText = "Couldn’t change Launch at Login"
                alert.informativeText = error.localizedDescription
                alert.runModal()
            }
            updateMenu()
            return
        }
        deliver(command)
    }
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard let command=menuItem.representedObject as? String else {return true}
        if command.hasPrefix("menu-pane-") {
            return ready && menuWorkspaceAvailable && (!independentWindows || NSApp.keyWindow === workspace)
        }
        if command=="menu-close" {return ready && (NSApp.keyWindow === panel || NSApp.keyWindow === workspace)}
        return ["quit","updates","automatic-updates","launch-at-login","menu-help"].contains(command) || ready
    }
    private func startUpdates() {
            guard !verifying && !liveTest, Bundle.main.object(forInfoDictionaryKey:"SUFeedURL") != nil else { return }
            if updates == nil {
                updates = AppUpdates()
                updates?.changed = { [weak self] in
                    guard let self, let updates=self.updates else { return }
                    self.js("appUpdates.receive(snapshot)",["snapshot":updates.snapshot])
                    self.updateMenu()
                }
                updates?.prepareToRestart = { [weak self] install in
                    guard let self else { return }
                    let views=[self.web,self.notchReady ? self.notchWeb:nil].compactMap{$0}
                    func prepare(_ index:Int) {
                        if index==views.count {install();return}
                        views[index].callAsyncJavaScript("return prepareForAppUpdate()",arguments:[:],in:nil,in:.page){result in
                            if case .success(let ready)=result,ready as? Bool==true {prepare(index+1)}
                            else {
                                let alert=NSAlert();alert.messageText="Finish your capture or handoff first"
                                alert.informativeText="Your update is ready. Finish capture, setup, review edits or sending, then click the update badge to install and restart."
                                alert.runModal()
                            }
                        }
                    }
                    prepare(0)
                }
                updates?.start()
            }
    }
    private func checkUpdates() {
        startUpdates()
        updates?.check()
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
    }
    private func onKey(_ index: UInt32, pressed: Bool) {
        guard bindings.indices.contains(Int(index)) else { return }
        let action=bindings[Int(index)].action
        if !pressed {
            guard held.remove(index) != nil else {return}
            if action=="capture", let id=capturePress {
                capturePress=nil
                dictation.finish(id)
                deliver("hw-capture-end",id,reveal:false)
            }
            return
        }
        guard held.insert(index).inserted else { return }
        if action=="capture" {
            let id=UUID().uuidString
            capturePress=id
            deliver("hw-capture",id)
            return
        }
        if binaryActions.contains(action){
            if !binaryID.isEmpty {deliver("hw-"+action,binaryID,reveal:action=="discuss")}
            return
        }
        if ["previous","next","confirm","back"].contains(action) && !isWorkspace && !panel.isVisible { return }
        deliver("hw-"+action, reveal:action=="requests")
    }

    @MainActor private func sendConnections(_ note: String = "", finished: Bool = false, success: Bool = true, request: String = "", account: String = "") {
        js("aiConnections.receive(value,note,finished,success,request,account)",["value":routingProviders.state(),"note":note,"finished":finished,"success":success,"request":request,"account":account])
    }
    private var workersChecked = Date.distantPast
    private var usageCheck:Task<Void,Never>?
    private var usageSnapshot:RouterJSON = [:]
    private var usageAgents: [String] = []
    private var usageChecked = Date.distantPast
    @MainActor private func refreshUsage() {
        guard !verifying,!liveTest,usageCheck == nil else {return}
        usageCheck=Task { @MainActor in
            if Date().timeIntervalSince(workersChecked) >= 120 {refreshWorkers()}
            if let workerCheck {await workerCheck.value}
            let eligible=["claude","codex"].filter {
                routingProviders.workerHealth[$0]=="signedIn" && routingProviders.workers[$0]==($0 == "codex" ? "ChatGPT login" : "Claude plan login")
            }
            if eligible != usageAgents || Date().timeIntervalSince(usageChecked) >= 120 {
                usageSnapshot=(try? await RouterCLI.call("usage",["agents":eligible])) ?? [:]
                usageChecked=Date()
                usageAgents=eligible
            }
            usageCheck=nil
            js("workerRouting.receive(data)",["data":usageSnapshot])
        }
    }

    @MainActor private func refreshWorkers() {
        guard !verifying, !liveTest, workerCheck == nil else {return}
        workerCheck=Task { @MainActor in
            await routingProviders.detectWorkers()
            workersChecked=Date()
            workerCheck=nil
            sendConnections()
            js("aiConnections.checked()",[:])
        }
    }

    private func refreshTerminalAppearance() {
        guard !appearanceLoading else {return};appearanceLoading=true
        GhosttyAppearance.load { [weak self] value in
            self?.appearanceLoading=false
            self?.js("workspaceDeck.appearanceLoaded(value)",["value":value])
        }
    }
    func userContentController(_ controller: WKUserContentController,didReceive message: WKScriptMessage,replyHandler: @escaping (Any?,String?)->Void) {
        guard message.name=="terminalClipboard",message.frameInfo.isMainFrame,message.webView === web,
              message.frameInfo.request.url?.standardizedFileURL == entry?.standardizedFileURL,
              let data=message.body as? [String:Any] else {replyHandler(nil,"Clipboard unavailable");return}
        if data["op"] as? String == "paste" {
            replyHandler(terminalPasteboard.string(forType:.string) ?? "",nil)
        } else if data["op"] as? String == "copy",let text=data["text"] as? String,text.utf8.count<=4_000_000 {
            terminalPasteboard.clearContents()
            if terminalPasteboard.setString(text,forType:.string){replyHandler(true,nil)}
            else {replyHandler(nil,"Could not copy text")}
        } else {replyHandler(nil,"Unsupported clipboard operation")}
    }
    func userContentController(_ controller: WKUserContentController,didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, (message.webView === web || message.webView === notchWeb),
              message.frameInfo.request.url?.standardizedFileURL == entry?.standardizedFileURL,
              let data=message.body as? [String:Any],let type=data["type"] as? String else { return }
        switch type {
        case "application-menu-state":
            if message.webView === web {menuWorkspaceAvailable=data["workspace"] as? Bool == true}
        case "workspace-cursor":
            guard message.webView === web else{return}
            workspace.setDividerCursor(data["axis"] as? String)
        case "workspace-drag":
            if message.webView === web,web.window === workspace {workspace.dragHeader()}
        case "shared-state":
            guard independentWindows,let patch=data["patch"] as? [String:Any] else {return}
            let target=message.webView === web ? (notchReady ? notchWeb:nil):web
            target?.callAsyncJavaScript("sharedState.apply(patch)",arguments:["patch":patch],in:nil,in:.page){_ in}
        case "show-workspace":showWorkspaceWindow()
        case "application-settings":publishApplicationSettings()
        case "launch-at-login":
            guard !verifying,!liveTest,let enabled=data["enabled"] as? Bool else {publishApplicationSettings();return}
            do {
                if enabled {
                    if SMAppService.mainApp.status == .requiresApproval {SMAppService.openSystemSettingsLoginItems()}
                    else if SMAppService.mainApp.status != .enabled {
                        try SMAppService.mainApp.register()
                        if SMAppService.mainApp.status == .requiresApproval {SMAppService.openSystemSettingsLoginItems()}
                    }
                } else if SMAppService.mainApp.status != .notRegistered {try SMAppService.mainApp.unregister()}
                updateMenu()
            } catch {js("toast(message)",["message":"Couldn’t change Launch at Login. "+error.localizedDescription])}
            publishApplicationSettings()
        case "preferences-open":
            showWorkspaceWindow();web.callAsyncJavaScript("prefs(group)",arguments:["group":data["group"] as? String ?? "general"],in:nil,in:.page){_ in}
        case "hide-workspace":workspace.orderOut(nil);if let screen=workspace.screen ?? anchorScreen ?? NSScreen.main {decisionRim.update(screen:screen,visible:false)}
        case "notch-onboarding":deliver("notch-onboarding")
        case "show-notch":deliver(data["open"] as? Bool == false ? "collapse":"home")
        case "workspace-view":
            if let view=data["view"] as? String {showWorkspaceWindow();web.callAsyncJavaScript("go(view)",arguments:["view":view],in:nil,in:.page){_ in}}
        case "workspace-open":
            if data["activate"] as? Bool != false {showWorkspaceWindow()}
            web.callAsyncJavaScript("workspaceDeck.open(key,project,activate)",arguments:["key":data["key"] as? String ?? "","project":data["project"] as? String ?? "","activate":data["activate"] as? Bool ?? true],in:nil,in:.page){_ in}
        case "workspace-open-terminal","workspace-open-result":
            showWorkspaceWindow();web.callAsyncJavaScript(type=="workspace-open-terminal" ? "workspaceDeck.openTerminal(id)":"workspaceDeck.openResult(id)",arguments:["id":data["id"] as? String ?? ""],in:nil,in:.page){_ in}
        case "ready":
            if message.webView === notchWeb {notchReady=true;bootstrapNotch();return}
            ready=true;position();panel.orderFrontRegardless();publishWorkspaceConfiguration()
            speech.changed={ [weak self] snapshot in self?.js("voiceSettings.receive(snapshot)",["snapshot":snapshot]) }
            speech.publish()
            terminals.events = { [weak self] events, done in
                guard let self else {done();return}
                self.web.callAsyncJavaScript("return await workspaceDeck.receive(events)",arguments:["events":events],in:nil,in:.page) { _ in done() }
            }
            if (!verifying || workspaceVerification || independentVerification) && !liveTest {try? terminals.connect()}
            if !verifying || workspaceVerification || independentVerification {refreshTerminalAppearance()}
            if !verifying {
                observeHover()
                dictation.event={ [weak self] id,phase,text in self?.js("dictationEvent(id,phase,text)",["id":id,"phase":phase,"text":text]) }
                dictation.level={ [weak self] id,level in
                    guard let self, !sendingVoiceLevel, web.window?.occlusionState.contains(.visible)==true || notchWeb?.window?.occlusionState.contains(.visible)==true else {return}
                    sendingVoiceLevel=true
                    let views=[web,notchReady ? notchWeb:nil].compactMap{$0}
                    var remaining=views.count
                    for target in views {target.callAsyncJavaScript("dictationLevel(id,level)",arguments:["id":id,"level":level],in:nil,in:.page){[weak self] _ in
                        remaining-=1;if remaining==0 {self?.sendingVoiceLevel=false}
                    }}
                }
                runtime.projectsChanged={ [weak self] rows in self?.js("projectsDiscovered(rows)",["rows":rows]) }
                runtime.changed={ [weak self] receipt in self?.js("agentReceipt(e)",["e":receipt]) }
                sessionNames.generate = { [weak self] input in
                    guard let self else { throw RouterFailure("Tasktap closed") }
                    return try await self.routingProviders.nameSession(input)
                }
                sessionNames.changed = { [weak self] id, name, fingerprint in
                    self?.js("sessionNameChanged(id,name,fingerprint)",["id":id,"name":name,"fingerprint":fingerprint])
                }
                runtime.sessionsChanged={ [weak self] rows in
                    self?.js("sessionRows(rows)",["rows":rows.map { $0.filter { $0.key != "activity" } }])
                    if self?.liveTest == false { self?.sessionNames.receive(rows) }
                }
                do {try runtime.start();if !liveTest {runtime.watchSessions()}} catch {deliver("live-error",error.localizedDescription,reveal:false)}
            }
            do {try inbox.start(web:web)} catch {NSLog("Could not start agent inbox: %@",error.localizedDescription)}
            let voices=narration.voices
            web.callAsyncJavaScript("configureVoices(voices)",arguments:["voices":voices],in:nil,in:.page){_ in}
            let buffered=queue;queue.removeAll()
            if !verifying && !liveTest && buffered.isEmpty {deliver("open-app",reveal:false)}
            for (action,id) in buffered {deliver(action,id,reveal:action != "hw-capture-end")}
            if independentWindows {isWorkspace=true;showWorkspaceWindow();bootstrapNotch()}
            if verifying { Task { @MainActor in if self.workspaceVerification || self.independentVerification {await self.verifyWorkspace()}else{await self.verifyInterface()} } }
            if liveTest { Task { @MainActor in await self.verifyLive() } }
            if !verifying && !liveTest {
                startUpdates()
                sendConnections()
                refreshWorkers()
            }
        case "workspace-open-folder":
            guard !verifying,!liveTest else{return};chooseWorkspaceFolder(asRoot:false)
        case "workspace-choose-root":
            guard !verifying,!liveTest else{return};chooseWorkspaceFolder(asRoot:true)
        case "workspace-create-folder":
            guard !verifying,!liveTest,let name=data["name"] as? String else{return}
            do {let folder=try runtime.folders.create(name:name);runtime.refresh()
                js("workspaceSettings.opened(row)",["row":["folder":folder.path,"name":folder.lastPathComponent,"checkout":folder.resolvingSymlinksInPath().path,"available":"true"]])
            } catch {js("workspaceSettings.failed(message)",["message":error.localizedDescription])}
        case "workspace-appearance":refreshTerminalAppearance()
        case "terminal-input-trace":
            if !verifying,!liveTest,message.webView === web,let events=data["events"] as? [[String:Any]] {inputDiagnostics.receive(events)}
        case "workspace-chrome":if message.webView === web {workspaceBackdrop.configure(data)}
        case "workspace-terminal":
            guard !verifying || workspaceVerification || independentVerification,!liveTest,message.webView === web else {return}
            do {try terminals.handle(data,folders:runtime.folders,runs:runtime.data)}
            catch {js("workspaceDeck.receive(events)",["events":[["event":"error","id":data["id"] as? String ?? "","cwd":data["cwd"] as? String ?? "","op":data["op"] as? String ?? "","error":error.localizedDescription]]])}
        case "observer-answer":
            guard !verifying || workspaceVerification || independentVerification,!liveTest,message.webView === web || message.webView === notchWeb,let id=data["id"] as? String,let turn=data["turn"] as? Int else{return}
            do {let text=try runtime.observerAnswer(id,turn:turn)
                js("sessionObservation.showAnswer(id,turn,text)",["id":id,"turn":turn,"text":text])
            } catch {deliver("live-error",error.localizedDescription,reveal:false)}
        case "workspace-file":
            guard !verifying,!liveTest else {return}
            let project=data["project"] as? String ?? ""
            workspaceMedia.choose(project:project) { [weak self] files in
                self?.js("workspaceDeck.addFiles(project,files)",["project":project,"files":files])
            }
        case "workspace-open-relative":
            guard let id=data["id"] as? String,let href=data["href"] as? String,let project=data["project"] as? String else {return}
            do {let files=try workspaceMedia.openRelative(id,href:href)
                js("workspaceDeck.addFiles(project,files)",["project":project,"files":files])
            } catch {deliver("live-error",error.localizedDescription,reveal:false)}
        case "workspace-open-link":
            guard !verifying,!liveTest,message.webView === web || message.webView === notchWeb,
                  let href=data["href"] as? String else {return}
            let project=data["project"] as? String ?? "",cwd=data["cwd"] as? String ?? ""
            do {
                let destination=try WorkspaceLinks.resolve(href,cwd:cwd)
                switch destination {
                case .web(let url):
                    if data["external"] as? Bool == true || project.isEmpty {
                        if !NSWorkspace.shared.open(url){throw WorkspaceLinks.Failure.invalid}
                    } else {
                        showWorkspaceWindow()
                        web.callAsyncJavaScript("workspaceDeck.openWeb(project,url)",arguments:["project":project,"url":url.absoluteString],in:nil,in:.page){_ in}
                    }
                case .app(let url):
                    if !NSWorkspace.shared.open(url){throw WorkspaceLinks.Failure.invalid}
                case .file(let url,let line,let column):
                    let type=UTType(filenameExtension:url.pathExtension)
                    let directory=(try? url.resourceValues(forKeys:[.isDirectoryKey]).isDirectory)==true
                    let executable=["app","command","sh","bash","zsh","fish","workflow","scpt"].contains(url.pathExtension.lowercased())
                    let preview=type?.conforms(to:.text)==true || type?.conforms(to:.image)==true || type?.conforms(to:.movie)==true || type?.conforms(to:.audio)==true || ["pdf","md","markdown","json","yaml","yml","toml","log","swift","ts","tsx","jsx","py","rs","go"].contains(url.pathExtension.lowercased())
                    if directory || executable || !preview && FileManager.default.isExecutableFile(atPath:url.path) {NSWorkspace.shared.activateFileViewerSelecting([url])}
                    else if data["external"] as? Bool == true || !preview || project.isEmpty {
                        if !NSWorkspace.shared.open(url){throw WorkspaceLinks.Failure.invalid}
                    } else {
                        var files=workspaceMedia.register([url])
                        if let line {files[0]["sourceLine"]=String(line)}
                        if let column {files[0]["sourceColumn"]=String(column)}
                        showWorkspaceWindow()
                        web.callAsyncJavaScript("workspaceDeck.addFiles(project,files)",arguments:["project":project,"files":files],in:nil,in:.page){_ in}
                    }
                }
            } catch {deliver("live-error",error.localizedDescription,reveal:false)}
        case "workspace-pdf-page":
            if let id=data["id"] as? String {workspaceMedia.pdfPage(id,page:data["page"] as? Int ?? 0) { [weak self] result in
                self?.js("workspaceDeck.pdfLoaded(id,result)",["id":id,"result":result])
            }}
        case "workspace-read-text":
            if let id=data["id"] as? String {workspaceMedia.readText(id) { [weak self] text in
                self?.js("workspaceDeck.textLoaded(id,text)",["id":id,"text":text])
            }}
        case "workspace-reveal":
            if let id=data["id"] as? String {workspaceMedia.reveal(id)}
        case "workspace-open-url":
            guard let value=data["url"] as? String,let url=URL(string:value),["http","https"].contains(url.scheme?.lowercased() ?? "") else {return}
            NSWorkspace.shared.open(url)
        case "ai-refresh":
            refreshWorkers()
        case "worker-usage":
            refreshUsage()
        case "check-updates":
            checkUpdates()
        case "automatic-updates":
            guard !verifying,!liveTest,let enabled=data["enabled"] as? Bool else {return}
            startUpdates()
            updates?.setAutomaticallyChecks(enabled)
        case "open-docs":
            guard !verifying,!liveTest,let section=data["section"] as? String,
                  ["agents","capture","voice","appearance","install"].contains(section),
                  let url=URL(string:"https://harzerheribert.github.io/Tasktap/docs/#"+section) else {return}
            if !NSWorkspace.shared.open(url){deliver("live-error","Couldn’t open the documentation.",reveal:false)}
        case "worker-install":
            let guides=["codex":"https://learn.chatgpt.com/docs/cli","claude":"https://code.claude.com/docs/en/setup","agy":"https://antigravity.google/docs/getting-started?tab=cli","cursor-agent":"https://cursor.com/docs/cli/installation","pi":"https://docs.pi.dev/latest/quickstart","opencode":"https://opencode.ai/docs/"]
            guard !verifying,!liveTest,let agent=data["agent"] as? String,let page=guides[agent],let url=URL(string:page) else {return}
            if !NSWorkspace.shared.open(url){deliver("live-error","Couldn’t open the installation guide.",reveal:false)}
        case "worker-login":
            guard !verifying,!liveTest,workerLogin==nil,let agent=data["agent"] as? String,["claude","codex","cursor-agent"].contains(agent) else {return}
            workerLogin=Task { @MainActor in
                do {_ = try await RouterCLI.call("worker-login",["agent":agent])}
                catch {deliver("live-error",error.localizedDescription,reveal:false)}
                workerLogin=nil
                refreshWorkers()
            }
        case "ai-settings":
            if !verifying && !liveTest { sendConnections() }
        case "ai-codex-identity":
            guard !verifying,!liveTest,let id=data["id"] as? String else {return}
            identityCheck?.cancel()
            identityCheck=Task { @MainActor in
                let value=try? await RouterCLI.call("codex-identity",[:])
                if !Task.isCancelled {js("setupPreparation.identity(id,label)",["id":id,"label":value?["label"] as? String ?? ""])}
            }
        case "ai-model-list":
            guard !verifying, !liveTest, let id=data["id"] as? String else {return}
            serverProbe?.cancel()
            serverProbe=Task { @MainActor in
                let result:RouterJSON
                do {result=["models":try await routingProviders.serverModels(data)]}
                catch {result=["error":error.localizedDescription]}
                if !Task.isCancelled {js("serverSetup.receive(id,result)",["id":id,"result":result])}
            }
        case "ai-save", "ai-login", "ai-account", "ai-disconnect", "ai-remove":
            guard !verifying, !liveTest else {return}
            let request=data["request"] as? String ?? ""
            guard connectionTask == nil, routeID == nil else {
                sendConnections("Finish the current connection or capture, then try again.",finished:true,success:false,request:request);return
            }
            let choice = data["route"] as? String ?? ""
            connectionTask = Task { @MainActor in
                var note = ""
                var success = true, account = ""
                do {
                    switch type {
                    case "ai-save":
                        try routingProviders.configure(choice, model:data["model"] as? String ?? "", key:data["key"] as? String ?? "", server:data["server"] as? RouterJSON ?? [:], account:data["account"] as? String)
                        note = "Routing preference saved."
                    case "ai-login":
                        account = try await routingProviders.chat.login(client:data["account"] as? String ?? "", activate:request.isEmpty)
                        note = "ChatGPT sign-in finished. Check plan access below."
                    case "ai-account": try routingProviders.chat.select(data["account"] as? String ?? "")
                    case "ai-disconnect": try await routingProviders.chat.disconnect()
                    default: try routingProviders.removeKey(choice)
                    }
                } catch { note = error.localizedDescription;success=false }
                connectionTask = nil
                sendConnections(note, finished:true,success:success,request:request,account:account)
            }
        case "ai-usage":
            NSWorkspace.shared.open(URL(string:"https://chatgpt.com/settings/usage")!)
        case "layout":
            if independentWindows {
                if message.webView === notchWeb {
                    collapsed=data["collapsed"] as? Bool ?? true
                    height=CGFloat(data["height"] as? Double ?? 290)
                    surfaceWidth=CGFloat(data["width"] as? Double ?? 432)
                    position()
                }
                return
            }
            let needsWorkspace=data["workspace"] as? Bool ?? false
            if needsWorkspace != isWorkspace {
                isWorkspace=needsWorkspace
                if isWorkspace {
                    panel.orderOut(nil)
                    panel.contentView=nil
                    workspace.contentView=workspaceBackdrop
                    workspaceBackdrop.host(web)
                    NSApp.activate()
                    workspace.makeKeyAndOrderFront(nil)
                    workspace.makeFirstResponder(web)
                } else {
                    workspace.orderOut(nil)
                    web.removeFromSuperview()
                    workspace.contentView=nil
                    panel.contentView=web
                    panel.orderFrontRegardless()
                }
            }
            collapsed=data["collapsed"] as? Bool ?? false
            height=CGFloat(data["height"] as? Double ?? 290)
            surfaceWidth=CGFloat(data["width"] as? Double ?? 432)
            position()
        case "context-begin":
            if !verifying && !liveTest, let id=data["id"] as? String {screenContext.begin(id)}
        case "context-resolve":
            guard let id=data["id"] as? String, let request=data["request"] as? String,let kind=data["kind"] as? String else {return}
            if verifying || liveTest {js("captureContext.receive(id,result)",["id":request,"result":["message":"Choose a reference for this test."]]);return}
            screenContext.resolve(id,kind:kind,allowPermission:data["allowPermission"] as? Bool==true,refresh:data["refresh"] as? Bool==true) { [weak self] result in
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
        case "focus-capture":
            if independentWindows {
                if message.webView === notchWeb {panel.orderFrontRegardless();panel.makeKey();panel.makeFirstResponder(notchWeb)}
                message.webView?.callAsyncJavaScript("document.querySelector('#modal[open] #transcript')?.focus({preventScroll:true})",arguments:[:],in:nil,in:.page){_ in}
            } else if !isWorkspace {
                panel.orderFrontRegardless()
                panel.makeKey()
                panel.makeFirstResponder(web)
                js("document.querySelector('#modal[open] #transcript')?.focus({preventScroll:true})",[:])
            }
        case "dictation-start":
            guard let id=data["id"] as? String else {return}
            if data["shortcut"] as? Bool == true && id != capturePress {
                js("dictationEvent(id,'stopped','')",["id":id])
            } else {dictation.start(id,service:speech)}
        case "dictation-finish":if let id=data["id"] as? String {dictation.finish(id)}
        case "dictation-cancel":dictation.cancel(data["id"] as? String)
        case "speech-status":speech.publish()
        case "speech-save":if let config=data["configuration"] as? [String:Any] {speech.save(config)}
        case "speech-install":speech.install()
        case "speech-cancel-install":speech.cancelInstall()
        case "speech-microphone":speech.microphone()
        case "speech-connect":if let provider=data["provider"] as? String,let key=data["key"] as? String {speech.connect(provider:provider,key:key)}
        case "speech-disconnect":if let provider=data["provider"] as? String {speech.disconnect(provider:provider)}
        case "speech-remove-model":if !dictation.isActive {speech.removeWhisper()} else {speech.reportError("Finish dictation before removing its model.")}
        case "speech-microphone-settings":
            if let url=URL(string:"x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {NSWorkspace.shared.open(url)}
        case "refresh":if !verifying {runtime.refresh();if !liveTest {runtime.refreshSessions()}}
        case "route":
            guard let id=data["id"] as? String,let input=data["input"] as? [String:Any] else {return}
            routeTask?.cancel()
            routeID = id
            routeTask = Task { @MainActor in
                let provider = data["provider"] as? String ?? "local"
                let result: [String:Any]
                if provider == "local" {
                    result = await HandoffRouter.suggest(input) { event in
                        guard self.routeID == id, !Task.isCancelled else { return }
                        self.js("routingProgress(id,event)", ["id":id,"event":event])
                    }
                } else if !verifying && !liveTest && data["confirmed"] as? Bool == true {
                    do { result = try await routingProviders.suggest(provider,input:input,reviewedServer:data["server"] as? RouterJSON ?? [:]) }
                    catch { result = ["source":"error","message":error.localizedDescription] }
                } else { result = ["source":"error","message":"Cloud routing requires confirmation."] }
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
        case "review-failed-handoff":
            guard !verifying,let session=data["session"] as? String,let capture=data["capture"] as? String else {return}
            do {let job=try runtime.failedHandoff(session:session,capture:capture);js("reviewFailedHandoff(job)",["job":job])}
            catch {deliver("live-error",error.localizedDescription,reveal:false)}
        case "enqueue":
            guard !verifying,var job=data["job"] as? [String:Any],let capture=job["capture"] as? String else {return}
            if let path=job["folder"] as? String,path.hasPrefix("~/"){
                job["folder"]=(liveTest && path.hasPrefix("~/projects/") ? runtime.root.appendingPathComponent(String(path.dropFirst("~/projects/".count))):FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(String(path.dropFirst(2)))).standardizedFileURL.path
            }
            do {
                var result=try runtime.enqueue(job)
                result["capture"]=capture;result["task"]=job["task"] as? String
                js("acceptLive(data)",["data":result])
            } catch {js("acceptLive(data)",["data":["capture":capture,"error":error.localizedDescription]])}
        case "reopen-session":
            guard let id=data["id"] as? String else {return}
            runtime.reopenSession(id){[weak self] error in
                if let error {self?.deliver("live-error",error,reveal:false)}
                else {self?.deliver("session-focused",id,reveal:false)}
            }
        case "copy-report":
            guard !verifying,!liveTest,let text=data["text"] as? String,text.utf8.count<=1_000_000 else{return}
            NSPasteboard.general.clearContents();NSPasteboard.general.setString(text,forType:.string)
            deliver("live-error","Report copied.",reveal:false)
        case "copy-diagnostics", "export-diagnostics":
            guard !verifying,!liveTest,let text=data["text"] as? String,text.utf8.count<=1_000_000,
                  let bytes=text.data(using:.utf8),(try? JSONSerialization.jsonObject(with:bytes)) != nil else{return}
            if type=="copy-diagnostics" {
                NSPasteboard.general.clearContents();NSPasteboard.general.setString(text,forType:.string)
                deliver("live-error","Diagnostics copied.",reveal:false)
            } else {
                let chooser=NSSavePanel();chooser.title="Export diagnostics";chooser.nameFieldStringValue="tasktap-diagnostics.json"
                chooser.allowedContentTypes=[.json];chooser.canCreateDirectories=true
                chooser.begin { [weak self] response in
                    guard response == .OK,let url=chooser.url else{return}
                    do {try bytes.write(to:url,options:.atomic);self?.deliver("live-error","Diagnostics exported.",reveal:false)}
                    catch {self?.deliver("live-error",error.localizedDescription,reveal:false)}
                }
            }
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
        case "status":
            guard !independentWindows || message.webView === web else {return}
            let count = data["count"] as? Int ?? 0
            if count != pendingCount {
                pendingCount = count
                updateMenu()
                position()
            }
        case "binary":if (!independentWindows || message.webView === notchWeb),let id=data["id"] as? String {setBinary(id)}
        case "questionUpdated":inbox.scan()
        case "speak":
            if let text=data["text"] as? String,let voice=data["voice"] as? String {narration.speak(text,voice:voice)}
        case "check-kokoro":narration.reportKokoro()
        case "install-kokoro":narration.installKokoro()
        case "stopSpeech":narration.stop()
        case "notification-status": updateNotificationStatus()
        case "notification-settings":
            // Open the system's registered preference pane; this does not change any permission.
            let pane=URL(fileURLWithPath:"/System/Library/PreferencePanes/Notifications.prefPane")
            if !NSWorkspace.shared.open(pane) {
                NSWorkspace.shared.open(URL(fileURLWithPath:"/System/Applications/System Settings.app"))
                js("toast('In System Settings, choose Notifications, then Tasktap.')",[:])
            }
        case "authorize":
            notifications.requestAuthorization(options:[.alert,.sound]) { [weak self] ok,error in
                DispatchQueue.main.async {
                    guard let self else {return}
                    if let error {
                        self.js("notificationDeliveryFailed('', 'settings', message)",["message":error.localizedDescription])
                        self.updateNotificationStatus()
                    } else {self.deliver(ok ? "notification-granted":"notification-denied",reveal:false)}
                }
            }
        case "notify":
            guard let id=data["id"] as? String,let kind=data["kind"] as? String,
                  let title=data["title"] as? String,let body=data["body"] as? String else { return }
            let content=UNMutableNotificationContent();content.title=title;content.body=body
            content.categoryIdentifier=kind=="request" ? "decision":kind=="failure" ? "failure":"result"
            content.userInfo=["id":id,"kind":kind]
            notifications.add(UNNotificationRequest(identifier:kind+"."+id,content:content,trigger:nil)) { [weak self] error in
                guard let error else {return} // Accepted by macOS does not mean a banner was displayed.
                DispatchQueue.main.async {self?.js("notificationDeliveryFailed(id,kind,message)",["id":id,"kind":kind,"message":error.localizedDescription])}
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
    @MainActor private func verifyWorkspace() async {
        let id=UUID().uuidString.lowercased()
        do {
            guard let root=ProcessInfo.processInfo.environment["TASKTAP_TERMINAL_ROOT"],root.contains("tasktap-workspace-test") else {
                throw LiveWorkspace.Failure.reason("Set TASKTAP_TERMINAL_ROOT to a new folder whose path contains tasktap-workspace-test.")
            }
            let folder=runtime.root.appendingPathComponent("fixture")
            try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
            _ = try await web.callAsyncJavaScript("state.firstRun={done:true}; state.projects=[{id:folder,folder,name:'Workspace verification',aliases:[]}]; showWorkspace();go(folder);return true",arguments:["folder":folder.path],in:nil,contentWorld:.page)
            terminals.send(["op":"start","id":id,"cwd":folder.path,"argv":["/bin/sh","-i"],"kind":"shell","title":"Verification shell"])
            try await Task.sleep(nanoseconds:500_000_000)
            _ = try await web.callAsyncJavaScript("workspaceDeck.open('terminal:'+id,folder);return true",arguments:["id":id,"folder":folder.path],in:nil,contentWorld:.page)
            terminals.send(["op":"input","id":id,"data":Data("printf 'TASKTAP_%s\\n' READY\n".utf8).base64EncodedString()])
            var ready=false
            for _ in 0..<60 {
                try await Task.sleep(nanoseconds:100_000_000)
                let value=try await web.callAsyncJavaScript("return workspaceDeck.terminalText(id).includes('TASKTAP_READY')",arguments:["id":id],in:nil,contentWorld:.page)
                if value as? Bool == true {ready=true;break}
            }
            guard ready else {throw Check.failed(#line)}
            try await verifyTerminalClipboard(id:id)
            if CommandLine.arguments.contains("--verify-terminal-clipboard") {
                terminals.send(["op":"stop","id":id]);try await Task.sleep(nanoseconds:400_000_000)
                terminalPasteboard.releaseGlobally()
                print("PASS: native Command-V menu → clipboard bridge → xterm → real PTY, and native clipboard copy with an isolated pasteboard.")
                NSApp.terminate(nil);return
            }
            _ = try await web.evaluateJavaScript("document.querySelector('[data-action=deck-close]').click();true")
            _ = try await web.callAsyncJavaScript("workspaceDeck.open('terminal:'+id,folder);return true",arguments:["id":id,"folder":folder.path],in:nil,contentWorld:.page)
            try await Task.sleep(nanoseconds:400_000_000)
            let restored=try await web.callAsyncJavaScript("return workspaceDeck.terminalText(id).includes('TASKTAP_READY')",arguments:["id":id],in:nil,contentWorld:.page)
            guard restored as? Bool == true else {throw Check.failed(#line)}
            let restoredTab=try await web.callAsyncJavaScript("return !!document.querySelector('.deck-tab[data-id=\"terminal:'+id+'\"]') && document.querySelectorAll('#nav [data-surface]').length===0 && document.querySelectorAll('#nav .nav-workspace').length===1 && document.querySelectorAll('.deck-group .deck-pane-tools > button').length===8",arguments:["id":id],in:nil,contentWorld:.page)
            guard restoredTab as? Bool == true else {throw Check.failed(#line)}
            try await verifyTerminalViewport(folder:folder)
            try await verifyDividerCursors(folder:folder)
            let file=folder.appendingPathComponent("Preview.txt")
            try "Native preview works. <script>Untrusted text stays text.</script>".write(to:file,atomically:true,encoding:.utf8)
            let media=workspaceMedia.register([file],persist:false)
            _ = try await web.callAsyncJavaScript("workspaceDeck.addFiles(folder,files);return true",arguments:["folder":folder.path,"files":media],in:nil,contentWorld:.page)
            try await Task.sleep(nanoseconds:400_000_000)
            let text=try await web.evaluateJavaScript("document.querySelector('.deck-document').textContent")
            guard (text as? String)?.contains("Native preview works.")==true else {throw Check.failed(#line)}
            let svg=folder.appendingPathComponent("Preview.svg")
            try "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"240\" height=\"120\"><rect width=\"240\" height=\"120\" fill=\"#234738\"/><text x=\"20\" y=\"65\" fill=\"white\">Workspace preview</text></svg>".write(to:svg,atomically:true,encoding:.utf8)
            let images=workspaceMedia.register([svg],persist:false)
            _ = try await web.callAsyncJavaScript("workspaceDeck.addFiles(folder,files);return true",arguments:["folder":folder.path,"files":images],in:nil,contentWorld:.page)
            try await Task.sleep(nanoseconds:400_000_000)
            let loaded=try await web.evaluateJavaScript("document.querySelector('.deck-preview:not([hidden]) img')?.naturalWidth>0")
            guard loaded as? Bool == true else {throw Check.failed(#line)}
            try await verifyWorkspaceDocuments(folder:folder)
            let pdf=try ResultDocument.write("A native PDF preview.\n\nReadable beside your terminal.",to:folder,for:"Preview")
            let pdfs=workspaceMedia.register([pdf],persist:false)
            _ = try await web.callAsyncJavaScript("workspaceDeck.addFiles(folder,files);return true",arguments:["folder":folder.path,"files":pdfs],in:nil,contentWorld:.page)
            var pdfLoaded=false
            for _ in 0..<30 {
                try await Task.sleep(nanoseconds:100_000_000)
                let value=try await web.evaluateJavaScript("document.querySelector('.deck-pdf-page')?.naturalWidth>0")
                if value as? Bool == true {pdfLoaded=true;break}
            }
            guard pdfLoaded else {throw Check.failed(#line)}
            // A single native backdrop hosts the renderer; opacity never dims
            // text. Accessibility's Reduce Transparency wins over preferences.
            guard web.superview===workspaceBackdrop,workspace.alphaValue==1 else {throw Check.failed(#line)}
            workspaceBackdrop.configure(["background":"#0d1117","opacity":0.93,"blur":true])
            guard workspaceBackdrop.blurActive == !NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency else {throw Check.failed(#line)}
            try verifyWorkspaceChrome()
            let originalFrame=workspace.frame
            for size in [NSSize(width:760,height:480),NSSize(width:1440,height:900)] {
                workspace.setContentSize(size)
                try verifyWorkspaceChrome()
            }
            workspace.setFrame(originalFrame,display:true)
            try verifyWorkspaceChrome()
            workspaceBackdrop.configure(["opacity":1.0,"blur":false])
            guard !workspaceBackdrop.blurActive,workspace.isOpaque else {throw Check.failed(#line)}
            _ = try await web.evaluateJavaScript("workspaceDeck.appearanceLoaded(state.workspaceDeck.appearance||{});true")
            // System must inherit AppKit's appearance rather than stay pinned
            // to the preceding theme. Simulate changes only in this test app.
            let originalAppearance=NSApp.appearance
            let originalTheme=try await web.evaluateJavaScript("state.appearanceTheme") as? String ?? "ghostty"
            _ = try await web.evaluateJavaScript("appAppearance.setTheme('system');true")
            for (name,dark) in [(NSAppearance.Name.aqua,false),(.darkAqua,true)] {
                NSApp.appearance=NSAppearance(named:name)
                var follows=false
                for _ in 0..<30 {
                    try await Task.sleep(nanoseconds:100_000_000)
                    let value=try await web.evaluateJavaScript("appAppearance.current().dark")
                    if value as? Bool == dark && workspace.appearance == nil {follows=true;break}
                }
                guard follows else {throw Check.failed(#line)}
            }
            NSApp.appearance=originalAppearance
            _ = try await web.callAsyncJavaScript("appAppearance.setTheme(theme);return true",arguments:["theme":originalTheme],in:nil,contentWorld:.page)
            // Validate WebKit's media loading through the private scheme too;
            // these codecs take a different path from images and PDFKit.
            let wav=folder.appendingPathComponent("Audio.wav")
            var audio=Data("RIFF".utf8)
            func word<T:FixedWidthInteger>(_ value:T) {var little=value.littleEndian;withUnsafeBytes(of:&little) {audio.append(contentsOf:$0)}}
            word(UInt32(16036));audio.append(Data("WAVEfmt ".utf8));word(UInt32(16));word(UInt16(1));word(UInt16(1));word(UInt32(8000));word(UInt32(16000));word(UInt16(2));word(UInt16(16));audio.append(Data("data".utf8));word(UInt32(16000));audio.append(Data(repeating:0,count:16000));try audio.write(to:wav)
            let video=Bundle.main.resourceURL!.appendingPathComponent("prototype/assets/motion/relay/miniature.mp4")
            for url in [wav,video] {
                let files=workspaceMedia.register([url],persist:false)
                _ = try await web.callAsyncJavaScript("workspaceDeck.addFiles(folder,files);return true",arguments:["folder":folder.path,"files":files],in:nil,contentWorld:.page)
                var playable=false
                for _ in 0..<30 {
                    try await Task.sleep(nanoseconds:100_000_000)
                    let value=try await web.evaluateJavaScript("(()=>{const m=document.querySelector('.deck-preview:not([hidden]) audio,.deck-preview:not([hidden]) video');return !!m && m.readyState>=1 && m.duration>0 && !m.error})()")
                    if value as? Bool == true {playable=true;break}
                }
                guard playable else {throw Check.failed(#line)}
                _ = try await web.callAsyncJavaScript("document.querySelector('[data-action=deck-close][data-id=\"media:'+id+'\"]').click();return true",arguments:["id":files[0]["id"]!],in:nil,contentWorld:.page)
            }
            if let destination=ProcessInfo.processInfo.environment["TASKTAP_WORKSPACE_SNAPSHOT"] {
                _ = try await web.callAsyncJavaScript("""
                    const l=state.workspaceDeck.layouts[folder],pdf=l.groups[0].active;
                    l.groups[0].tabs=l.groups[0].tabs.filter(key=>key!==pdf);l.groups[0].active='terminal:'+id;
                    l.groups.push({id:crypto.randomUUID(),tabs:[pdf],active:pdf});l.selected=0;render();document.querySelector('.deck-terminal:not([hidden]) .xterm-helper-textarea')?.focus();return true;
                    """,arguments:["folder":folder.path,"id":id],in:nil,contentWorld:.page)
                try await Task.sleep(nanoseconds:300_000_000)
                // WebKit snapshots exclude native materials. Give the test
                // image its base color; the live window keeps the native blur.
                _ = try await web.evaluateJavaScript("document.body.classList.add('workspace-snapshot');true")
                let image=try await web.takeSnapshot(configuration:nil)
                _ = try await web.evaluateJavaScript("document.body.classList.remove('workspace-snapshot');true")
                if let tiff=image.tiffRepresentation,let bitmap=NSBitmapImageRep(data:tiff),let bytes=bitmap.representation(using:.png,properties:[:]) {
                    try bytes.write(to:URL(fileURLWithPath:destination))
                }
            }
            if independentVerification {try await verifyIndependentWindows(folder:folder,id:id)}
            try await verifySessionObservation(folder:folder)
            terminals.send(["op":"stop","id":id])
            try await Task.sleep(nanoseconds:400_000_000)
            print("Native workspace passed: real PTY → WebKit/xterm, observer permission/answer events and exact saved-answer retrieval, terminal replay, native media previews, appearance, resizing and explicit stop.")
            NSApp.terminate(nil)
        } catch {
            terminals.send(["op":"stop","id":id])
            print("Native workspace failed:",error)
            exit(1)
        }
    }
    @MainActor private func verifySessionObservation(folder:URL) async throws {
        let fm=FileManager.default,id=UUID().uuidString.lowercased(),capture=UUID().uuidString.lowercased()
        guard ["claude","codex","pi","opencode"].allSatisfy({LiveWorkspace.observes(agent:$0)}),!LiveWorkspace.observes(agent:"agy") else {throw Check.failed(#line)}
        let run=runtime.data.appendingPathComponent(id)
        try fm.createDirectory(at:run,withIntermediateDirectories:true)
        let job:[String:Any]=["agent":"claude","observer":true,"session":id,"capture":capture,
            "mode":"ask","delivery":"interactive","folder":folder.path,"outgoing":"Native observer fixture","instructions":"","task":"Observed fixture"]
        let file=run.appendingPathComponent("1-\(capture).job")
        try JSONSerialization.data(withJSONObject:job).write(to:file)
        try JSONSerialization.data(withJSONObject:["state":"Opening"]).write(to:file.deletingPathExtension().appendingPathExtension("receipt"))
        let fake=run.appendingPathComponent("fixture-cli")
        try #"""
        #!/usr/bin/env python3
        import json,os,shlex,subprocess,sys,time
        from pathlib import Path
        assert sys.stdin.isatty() and '--mcp-config' not in sys.argv
        settings=json.loads(sys.argv[sys.argv.index('--settings')+1])
        def emit(name,**values):
            command=shlex.split(settings['hooks'][name][0]['hooks'][0]['command'])
            result=subprocess.run(command,input=json.dumps(dict(hook_event_name=name,session_id='native-fixture',**values)),text=True,capture_output=True)
            assert result.returncode==0 and not result.stdout and not result.stderr
        emit('SessionStart');emit('UserPromptSubmit');emit('PreToolUse',tool_name='Read')
        emit('PermissionRequest',tool_name='Bash')
        root=Path(__file__).parent
        while not (root/'continue').exists():time.sleep(.05)
        emit('PostToolUse',tool_name='Bash')
        emit('Stop',last_assistant_message='Native **observer** answer.\n')
        while True:time.sleep(.1)
        """#.write(to:fake,atomically:true,encoding:.utf8)
        try fm.setAttributes([.posixPermissions:0o700],ofItemAtPath:fake.path)
        let runner=try SessionHelpers.runner(),python=try WorkspaceTerminals.pythonExecutable(environment:LiveWorkspace.cliEnvironment)
        guard fm.fileExists(atPath:runner.deletingLastPathComponent().appendingPathComponent("observers/pi.mjs").path),
              fm.fileExists(atPath:runner.deletingLastPathComponent().appendingPathComponent("observers/opencode/index.mjs").path) else {throw Check.failed(#line)}
        terminals.send(["op":"start","id":id,"cwd":folder.path,"kind":"agent","title":"Observed fixture",
                        "argv":[python.path,runner.path,"present",file.path,fake.path]])
        defer {terminals.send(["op":"stop","id":id])}
        func waitFor(_ source:String) async throws {
            for _ in 0..<70 {
                try await Task.sleep(nanoseconds:100_000_000)
                if try await web.callAsyncJavaScript(source,arguments:["id":id],in:nil,contentWorld:.page) as? Bool == true {return}
            }
            throw LiveWorkspace.Failure.reason("Timed out waiting for native observer fixture: " + source)
        }
        try await waitFor("return sessionObservation.get(id)?.state==='needsPermission'")
        _ = try await web.callAsyncJavaScript("workspaceDeck.open('terminal:'+id,state.projects.find(p=>p.folder===folder).id);return true",arguments:["id":id,"folder":folder.path],in:nil,contentWorld:.page)
        try await waitFor("return document.querySelector('[data-session-id=\"'+id+'\"]')?.dataset.sessionState==='permission'")
        _ = try await web.evaluateJavaScript("document.activeElement?.blur();true")
        try Data().write(to:run.appendingPathComponent("continue"))
        try await waitFor("return sessionObservation.get(id)?.state==='ready' && sessionObservation.get(id)?.answers?.length===1")
        guard try runtime.observerAnswer(id,turn:1)=="Native **observer** answer.\n" else {throw Check.failed(#line)}
        _ = try await web.callAsyncJavaScript("sessionObservation.openAnswer(id,1);return true",arguments:["id":id],in:nil,contentWorld:.page)
        try await waitFor("return document.querySelector('.observer-answer-body')?.textContent.includes('Native observer answer.')===true")
        _ = try await web.evaluateJavaScript("dismissCard();true")
    }
    @MainActor private func verifyTerminalClipboard(id:String) async throws {
        let text="TASKTAP_PASTE_✓_fixture"
        terminalPasteboard.clearContents();terminalPasteboard.setString(text,forType:.string)
        _ = try await web.evaluateJavaScript("document.querySelector('.deck-terminal:not([hidden]) .xterm-helper-textarea').focus();true")
        let event=NSEvent.keyEvent(with:.keyDown,location:.zero,modifierFlags:.command,timestamp:0,windowNumber:web.window?.windowNumber ?? 0,context:nil,characters:"v",charactersIgnoringModifiers:"v",isARepeat:false,keyCode:UInt16(kVK_ANSI_V))!
        guard NSApp.mainMenu?.performKeyEquivalent(with:event)==true else {throw Check.failed(#line)}
        var pasted=false
        for _ in 0..<40 {
            try await Task.sleep(nanoseconds:100_000_000)
            if try await web.callAsyncJavaScript("return workspaceDeck.terminalText(id).includes(text)",arguments:["id":id,"text":text],in:nil,contentWorld:.page) as? Bool == true {pasted=true;break}
        }
        guard pasted else {throw Check.failed(#line)}
        _ = try await web.callAsyncJavaScript("return await window.webkit.messageHandlers.terminalClipboard.postMessage({op:'copy',text})",arguments:["text":text],in:nil,contentWorld:.page)
        guard terminalPasteboard.string(forType:.string)==text else {throw Check.failed(#line)}
        terminals.send(["op":"input","id":id,"data":Data([0x15]).base64EncodedString()])
    }
    @MainActor private func verifyIndependentWindows(folder:URL,id:String) async throws {
        enum Check:Error {case failed(Int)}
        for _ in 0..<50 {if notchReady {break};try await Task.sleep(nanoseconds:100_000_000)}
        guard notchReady,let notchWeb,web.window===workspace,notchWeb.window===panel else {throw Check.failed(#line)}
        let frame=workspace.frame
        _ = try await web.evaluateJavaScript("window.independentTerminal=document.querySelector('.deck-terminal:not([hidden])');true")
        deliver("home")
        try await Task.sleep(nanoseconds:600_000_000)
        guard workspace.isVisible,workspace.frame==frame,web.window===workspace else {throw Check.failed(#line)}
        let notchOpen=try await notchWeb.evaluateJavaScript("document.body.classList.contains('notch-first') && !document.querySelector('#notch-home').hidden")
        guard notchOpen as? Bool==true else {throw Check.failed(#line)}
        // Exercise the same invocation path at each display's coordinates without
        // moving the user's pointer, including displays left of/below the primary.
        for screen in NSScreen.screens {
            deliver("home",at:NSPoint(x:screen.frame.midX,y:screen.frame.midY))
            try await Task.sleep(nanoseconds:250_000_000)
            let geometry=NotchGeometry(screen:screen)
            guard anchorScreen === screen, panel.frame.maxY == screen.frame.maxY,
                  abs(panel.frame.midX-geometry.tab.midX)<1,
                  workspace.frame==frame else {throw Check.failed(#line)}
        }
        print("Notch invocation follows all \(NSScreen.screens.count) connected displays at their top edge.")
        terminals.send(["op":"input","id":id,"data":Data("printf 'TASKTAP_%s\\n' DUAL_LIVE\n".utf8).base64EncodedString()])
        var live=false
        for _ in 0..<30 {
            try await Task.sleep(nanoseconds:100_000_000)
            let value=try await web.callAsyncJavaScript("return workspaceDeck.terminalText(id).includes('TASKTAP_DUAL_LIVE')",arguments:["id":id],in:nil,contentWorld:.page)
            if value as? Bool==true {live=true;break}
        }
        guard live else {throw Check.failed(#line)}
        _ = try await notchWeb.evaluateJavaScript("state.notes.unshift({id:'notch-dual-note',text:'From notch'});persist();true")
        _ = try await web.evaluateJavaScript("state.notes.unshift({id:'workspace-dual-note',text:'From workspace'});persist();true")
        try await Task.sleep(nanoseconds:300_000_000)
        let both=try await web.evaluateJavaScript("state.notes.some(n=>n.id==='notch-dual-note') && state.notes.some(n=>n.id==='workspace-dual-note') && independentTerminal===document.querySelector('.deck-terminal:not([hidden])')")
        guard both as? Bool==true else {throw Check.failed(#line)}
        deliver("capture")
        try await Task.sleep(nanoseconds:300_000_000)
        _ = try await notchWeb.evaluateJavaScript("(()=>{const input=document.querySelector('#transcript');input.value='Keep this notch draft';input.dispatchEvent(new Event('input',{bubbles:true}));return true})()")
        guard workspace.isVisible,web.window===workspace else {throw Check.failed(#line)}
        workspace.performClose(nil)
        for _ in 0..<40 {
            if !workspace.isVisible {break}
            try await Task.sleep(nanoseconds:50_000_000)
        }
        let retained=try await notchWeb.evaluateJavaScript("document.querySelector('#transcript')?.value==='Keep this notch draft'")
        guard !workspace.isVisible,panel.isVisible,retained as? Bool==true else {throw Check.failed(#line)}
        showWorkspaceWindow()
        try await Task.sleep(nanoseconds:200_000_000)
        let same=try await web.evaluateJavaScript("independentTerminal===document.querySelector('.deck-terminal:not([hidden])')")
        guard workspace.isVisible,same as? Bool==true else {throw Check.failed(#line)}
        print("Independent windows passed: live PTY and DOM persist during notch use; shared notes merge; closing/reopening workspace preserves the notch draft and tabs.")
    }
    @MainActor private func verifyDividerCursors(folder:URL) async throws {
        _ = try await web.callAsyncJavaScript("window.cursorVerification=JSON.parse(JSON.stringify(state.workspaceDeck.layouts[folder]));return true",arguments:["folder":folder.path],in:nil,contentWorld:.page)
        for axis in ["x","y"] {
            _ = try await web.callAsyncJavaScript("const l=state.workspaceDeck.layouts[folder];workspaceLayout.split(l,l.groups[0].id,axis,'cursor-'+axis);render();document.querySelector('.deck-divider[data-axis=\"'+axis+'\"]').dispatchEvent(new PointerEvent('pointerenter'));return true",arguments:["folder":folder.path,"axis":axis],in:nil,contentWorld:.page)
            try await Task.sleep(nanoseconds:150_000_000)
            let expected=axis=="x" ? NSCursor.resizeLeftRight:NSCursor.resizeUpDown
            guard workspace.dividerCursorAxis==axis,let pixels=expected.image.tiffRepresentation,NSCursor.current.image.tiffRepresentation==pixels else {throw Check.failed(#line)}
            _ = try await web.callAsyncJavaScript("document.querySelector('.deck-divider[data-axis=\"'+axis+'\"]').dispatchEvent(new PointerEvent('pointerleave'));return true",arguments:["axis":axis],in:nil,contentWorld:.page)
            try await Task.sleep(nanoseconds:100_000_000)
            guard workspace.dividerCursorAxis==nil else {throw Check.failed(#line)}
        }
        _ = try await web.callAsyncJavaScript("state.workspaceDeck.layouts[folder]=window.cursorVerification;delete window.cursorVerification;render();return true",arguments:["folder":folder.path],in:nil,contentWorld:.page)
        print("Native divider cursors passed: DOM hover → AppKit horizontal/vertical cursor images, and release on leave.")
    }
    @MainActor private func verifyTerminalViewport(folder:URL) async throws {
        let id=UUID().uuidString.lowercased(),originalFrame=workspace.frame
        let fixture="""
            import os, signal, sys, time
            def draw(*args):
                cols, rows = os.get_terminal_size(0)
                sys.stdout.write(f'\\x1b[?1049h\\x1b[2J\\x1b[1;1HPTY {rows}x{cols}\\x1b[{rows};1HBOTTOM\\x1b[{rows};{max(1,cols-3)}HEDGE')
                sys.stdout.flush()
            signal.signal(signal.SIGWINCH, draw)
            draw()
            while True: time.sleep(1)
            """
        _ = try await web.callAsyncJavaScript("window.viewportVerification={layout:JSON.parse(JSON.stringify(state.workspaceDeck.layouts[folder])),appearance:state.workspaceDeck.appearance};return true",arguments:["folder":folder.path],in:nil,contentWorld:.page)
        terminals.send(["op":"start","id":id,"cwd":folder.path,"argv":["/usr/bin/env","python3","-u","-c",fixture],"kind":"shell","title":"Full-screen viewport fixture"])
        defer {terminals.send(["op":"stop","id":id]);workspace.setFrame(originalFrame,display:true)}
        try await Task.sleep(nanoseconds:300_000_000)
        _ = try await web.callAsyncJavaScript("workspaceDeck.open('terminal:'+id,folder);return true",arguments:["id":id,"folder":folder.path],in:nil,contentWorld:.page)
        for scenario in 0..<4 {
            if scenario==1 {workspace.setContentSize(NSSize(width:902,height:617))}
            if scenario==2 {
                _ = try await web.callAsyncJavaScript("const l=state.workspaceDeck.layouts[folder];workspaceLayout.split(l,l.groups[l.selected].id,'y','viewport-lower');l.selected=0;render();return true",arguments:["folder":folder.path],in:nil,contentWorld:.page)
            }
            if scenario==3 {
                _ = try await web.callAsyncJavaScript("const l=state.workspaceDeck.layouts[folder];workspaceLayout.split(l,l.groups[0].id,'x','viewport-right');l.selected=0;workspaceDeck.appearanceLoaded({...state.workspaceDeck.appearance,fontFamilies:['Menlo'],fontSize:18,padding:[18,24,22,28]});render();return true",arguments:["folder":folder.path],in:nil,contentWorld:.page)
            }
            var fits=false
            for _ in 0..<35 {
                try await Task.sleep(nanoseconds:100_000_000)
                let value=try await web.callAsyncJavaScript("const m=workspaceDeck.terminalMetrics(id);return !!m && m.firstLine==='PTY '+m.rows+'x'+m.cols && /^BOTTOM.*EDGE$/.test(m.lastLine) && m.screen.bottom<=m.content.bottom+.5 && m.screen.right<=m.content.right+.5 && m.screen.top>=m.content.top-.5 && m.screen.left>=m.content.left-.5 && m.content.bottom<=m.pane.bottom+.5 && m.content.right<=m.pane.right+.5 && m.pane.bottom<=m.viewport.height+.5 && m.pane.right<=m.viewport.width+.5",arguments:["id":id],in:nil,contentWorld:.page)
                if value as? Bool == true {fits=true;break}
            }
            if !fits {print("Terminal viewport scenario",scenario,try await web.callAsyncJavaScript("return JSON.stringify(workspaceDeck.terminalMetrics(id))",arguments:["id":id],in:nil,contentWorld:.page) ?? "unavailable")}
            guard fits else {throw Check.failed(#line)}
        }
        _ = try await web.callAsyncJavaScript("document.querySelector('[data-action=deck-close][data-id=\"terminal:'+id+'\"]')?.click();state.workspaceDeck.layouts[folder]=window.viewportVerification.layout;workspaceDeck.appearanceLoaded(window.viewportVerification.appearance||{});delete window.viewportVerification;render();return true",arguments:["id":id,"folder":folder.path],in:nil,contentWorld:.page)
        print("Native terminal viewport passed: real PTY final-row and column markers remain visible with matching dimensions after window resize, nested splits and font/padding changes.")
    }
    @MainActor private func verifyWorkspaceDocuments(folder:URL) async throws {
        let markdown=folder.appendingPathComponent("Readme.md"),sibling=folder.appendingPathComponent("Details.md")
        try "# Native Markdown\n\n- [x] Ready\n\n| Preview | State |\n| --- | --- |\n| Markdown | Rendered |\n\n![Local diagram](Preview.svg)\n\n[Details](Details.md)\n".write(to:markdown,atomically:true,encoding:.utf8)
        try "# Local details".write(to:sibling,atomically:true,encoding:.utf8)
        let files=workspaceMedia.register([markdown],persist:false),id=files[0]["id"]!
        guard files[0]["kind"]=="markdown",try workspaceMedia.openRelative(id,href:"Details.md",persist:false).count==1 else {throw Check.failed(#line)}
        let outside=folder.deletingLastPathComponent().appendingPathComponent("Outside.md"),escape=folder.appendingPathComponent("Escape.md")
        try "Outside selected folder".write(to:outside,atomically:true,encoding:.utf8)
        try? FileManager.default.removeItem(at:escape)
        try FileManager.default.createSymbolicLink(at:escape,withDestinationURL:outside)
        defer {try? FileManager.default.removeItem(at:outside);try? FileManager.default.removeItem(at:escape)}
        for href in ["../Outside.md","%2e%2e/Outside.md","Escape.md","file:///etc/passwd","https://example.com/file.md"] {
            guard (try? workspaceMedia.openRelative(id,href:href,persist:false))==nil else {throw Check.failed(#line)}
        }
        _ = try await web.callAsyncJavaScript("workspaceDeck.addFiles(folder,files);return true",arguments:["folder":folder.path,"files":files],in:nil,contentWorld:.page)
        var rendered=false
        for _ in 0..<30 {
            try await Task.sleep(nanoseconds:100_000_000)
            let value=try await web.evaluateJavaScript("(()=>{const d=document.querySelector('.deck-preview:not([hidden]) .workspace-document');return d?.querySelector('h1')?.textContent==='Native Markdown' && d.querySelector('img')?.naturalWidth>0 && !!d.querySelector('table') && !!d.querySelector('input:checked')})()")
            if value as? Bool == true {rendered=true;break}
        }
        guard rendered else {throw Check.failed(#line)}
        let nonce=UUID().uuidString,html=folder.appendingPathComponent("Interactive.html")
        try "window.localPreviewScript=true;".write(to:folder.appendingPathComponent("preview.js"),atomically:true,encoding:.utf8)
        try "#fixture{border-top:7px solid blue}".write(to:folder.appendingPathComponent("preview.css"),atomically:true,encoding:.utf8)
        try """
            <!doctype html><script>window.previewViolations=[];document.addEventListener('securitypolicyviolation',event=>previewViolations.push({blocked:event.blockedURI,directive:event.effectiveDirective}))</script><link rel="stylesheet" href="preview.css"><style>#fixture{color:rgb(12, 34, 56)}</style>
            <h1 id="fixture">Interactive HTML</h1><img id="local" src="Preview.svg"><script src="preview.js"></script>
            <script>addEventListener('load',()=>{let isolated=false;try{void parent.document.body}catch{isolated=true}const s=getComputedStyle(document.querySelector('#fixture'));parent.postMessage({probe:'\(nonce)',inline:true,sibling:window.localPreviewScript===true,image:document.querySelector('#local').naturalWidth>0,color:s.color,border:s.borderTopWidth,isolated,violations:previewViolations},'*')})</script>
            """.write(to:html,atomically:true,encoding:.utf8)
        _ = try await web.callAsyncJavaScript("window.workspaceHTMLProbe=null;window.workspaceHTMLListener=event=>{if(event.data?.probe===nonce)window.workspaceHTMLProbe={...event.data,origin:event.origin}};window.addEventListener('message',window.workspaceHTMLListener);return true",arguments:["nonce":nonce],in:nil,contentWorld:.page)
        let pages=workspaceMedia.register([html],persist:false)
        _ = try await web.callAsyncJavaScript("workspaceDeck.addFiles(folder,files);return true",arguments:["folder":folder.path,"files":pages],in:nil,contentWorld:.page)
        var htmlReady=false
        for _ in 0..<30 {
            try await Task.sleep(nanoseconds:100_000_000)
            let value=try await web.evaluateJavaScript("(()=>{const p=window.workspaceHTMLProbe;return !!p && p.inline && p.sibling && p.image && p.color==='rgb(12, 34, 56)' && p.border==='7px' && p.isolated && p.origin==='null'})()")
            if value as? Bool == true {htmlReady=true;break}
        }
        if !htmlReady {print("HTML preview probe",try await web.evaluateJavaScript("JSON.stringify(window.workspaceHTMLProbe)") ?? "unavailable")}
        _ = try await web.evaluateJavaScript("window.removeEventListener('message',window.workspaceHTMLListener);delete window.workspaceHTMLListener;delete window.workspaceHTMLProbe;true")
        guard htmlReady else {throw Check.failed(#line)}
        print("Native document previews passed: rendered Markdown and local images, explicit sibling links confined against traversal/symlinks, sandboxed HTML with inline and sibling scripts/styles.")
    }
    @MainActor private func verifyWorkspaceChrome() throws {
        workspaceBackdrop.layoutSubtreeIfNeeded()
        let bounds=workspaceBackdrop.bounds
        let content=workspaceBackdrop.convert(workspace.contentLayoutRect,from:nil)
        let titlebar=NSRect(x:bounds.minX,y:content.maxY,width:bounds.width,height:bounds.maxY-content.maxY)
        let backgrounds=workspaceBackdrop.subviews.filter {$0 !== web}
        guard workspace.styleMask.contains(.fullSizeContentView),workspace.contentView===workspaceBackdrop,
              web.superview===workspaceBackdrop,web.frame==bounds,workspace.titleVisibility == .hidden,titlebar.height>0,
              backgrounds.count==2,backgrounds.allSatisfy({$0.frame.contains(titlebar) && $0.frame==bounds}),
              backgrounds.contains(where:{$0.layer?.backgroundColor?.alpha ?? 0 >= 0.93}) else {throw Check.failed(#line)}
        // Header controls must receive input through the transparent native titlebar.
        guard let frameView=workspaceBackdrop.superview,
              let hit=frameView.hitTest(frameView.convert(NSPoint(x:bounds.midX,y:bounds.maxY-16),from:workspaceBackdrop)),
              hit.isDescendant(of:web) else {throw Check.failed(#line)}
    }
    // Run the packaged web view with ephemeral storage and synthetic shortcut commands.
    @MainActor private func verifyInterface() async {
        do {
            let start = try await web.evaluateJavaScript("document.body.classList.contains('native-host') && document.querySelector('#notch-home').hidden")
            guard start as? Bool == true else { throw Check.failed(#line) }
            guard let screen = anchorScreen else { throw Check.failed(#line) }
            let geometry = NotchGeometry(screen:screen)
            let rimMatches = try await web.callAsyncJavaScript("""
                const el=document.querySelector('#islandToggle'), box=el.getBoundingClientRect(), rim=getComputedStyle(el,'::after'), bloom=getComputedStyle(el,'::before');
                return Math.abs(box.width-width)<0.51 && Math.abs(box.height-depth)<0.51 &&
                    [rim.top,rim.left,rim.right,rim.bottom].every(value=>Math.abs(parseFloat(value))<0.51) &&
                    parseFloat(rim.borderBottomWidth)>0 && rim.filter.includes('blur(') &&
                    bloom.filter.includes('blur(') && bloom.boxShadow!=='none' &&
                    rim.pointerEvents==='none' && bloom.pointerEvents==='none';
                """,arguments:["width":geometry.tab.width,"depth":geometry.tab.height],in:nil,contentWorld:.page)
            guard rimMatches as? Bool == true, panel.frame.contains(geometry.tab), abs(panel.frame.maxY-geometry.tab.maxY) <= geometry.pixel else {
                print("Cutout bounds",geometry.tab,"actual compact panel",panel.frame)
                throw Check.failed(#line)
            }
            let front=NSWorkspace.shared.frontmostApplication?.processIdentifier
            let responder=panel.firstResponder
            let key=panel.isKeyWindow
            let compactWidth=panel.frame.width
            let compactTop=panel.frame.maxY
            let outside=NSPoint(x:panel.frame.midX+450,y:panel.frame.minY-30)
            // Inject coordinates into the same observation path without moving the user's mouse.
            updateHover(at:NSPoint(x:panel.frame.midX,y:panel.frame.midY),dragging:true)
            guard !pointerInside else { throw Check.failed(#line) }
            let hotRegion=anchorScreen.map { NotchGeometry(screen:$0).tab } ?? .zero
            let point=hotRegion.isEmpty ? NSPoint(x:panel.frame.midX,y:panel.frame.midY) : NSPoint(x:hotRegion.midX,y:hotRegion.midY)
            updateHover(at:point,dragging:false)
            try await Task.sleep(nanoseconds:800_000_000)
            let peek=try await web.evaluateJavaScript("!document.querySelector('#notch-home').hidden")
            guard peek as? Bool == true, panel.frame.width>compactWidth, abs(panel.frame.maxY-compactTop)<1,
                  panel.isKeyWindow==key, panel.firstResponder===responder,
                  NSWorkspace.shared.frontmostApplication?.processIdentifier==front else { throw Check.failed(#line) }
            let wrapsHousing = try await web.callAsyncJavaScript("""
                const box=document.querySelector('#islandToggle').getBoundingClientRect(),
                      shell=document.querySelector('#notch-shell'), surface=shell.getBoundingClientRect(),
                      sheet=document.querySelector('#notch-home').getBoundingClientRect();
                return Math.abs(box.width-width)<0.51 && Math.abs(box.height-depth)<0.51 &&
                    Math.abs(box.left-tabLeft)<0.51 && Math.abs(sheet.top-box.bottom)<0.51 &&
                    Math.abs(surface.left-sheet.left)<0.51 && Math.abs(surface.right-sheet.right)<0.51 &&
                    Math.abs(sheet.bottom-surface.bottom)<1.01 && surface.top===0 &&
                    parseFloat(getComputedStyle(shell,'::before').left)===0;
                """, arguments:["width":geometry.tab.width,"depth":geometry.tab.height,
                                "tabLeft":geometry.tab.minX-panel.frame.minX],in:nil,contentWorld:.page)
            guard wrapsHousing as? Bool == true else {
                let bounds=try await web.evaluateJavaScript("""
                    JSON.stringify({state:document.body.className,tab:document.querySelector('#islandToggle').getBoundingClientRect(),
                      shell:document.querySelector('#notch-shell').getBoundingClientRect(),sheet:document.querySelector('#notch-home').getBoundingClientRect()})
                    """)
                print("Expanded hardware and panel bounds",geometry.tab,panel.frame,bounds ?? "")
                throw Check.failed(#line)
            }
            if geometry.hasCutout {
                updateHover(at:NSPoint(x:geometry.tab.minX-geometry.shoulder/2,y:geometry.tab.midY),dragging:false)
                guard pointerInside, panel.ignoresMouseEvents else {throw Check.failed(#line)}
            }
            print("Measured \(geometry.hasCutout ? "cutout" : "fallback") \(geometry.tab.width) × \(geometry.tab.height) pt at \(screen.backingScaleFactor)×.")
            updateHover(at:outside,dragging:false)
            try await Task.sleep(nanoseconds:800_000_000)
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
            _ = try await web.evaluateJavaScript("openRequest(state.decisions[0].id);true")
            try await Task.sleep(nanoseconds:220_000_000)
            let id=binaryID
            guard !id.isEmpty else {throw Check.failed(#line)}
            let cutout=anchorScreen.flatMap { screen -> CGRect? in
                let geometry=NotchGeometry(screen:screen);return geometry.hasCutout ? geometry.tab : nil
            } ?? .zero
            if !cutout.isEmpty {
                let offset=try await web.evaluateJavaScript("document.querySelector('#notch').getBoundingClientRect().top")
                guard let top=offset as? Double, panel.frame.maxY-top <= cutout.minY+1 else {throw Check.failed(#line)}
            }
            let talk=UInt32(bindings.firstIndex{$0.action=="discuss"}!)
            onKey(talk,pressed:true);onKey(talk,pressed:false)
            try await Task.sleep(nanoseconds:180_000_000)
            guard binaryID.isEmpty else {throw Check.failed(#line)}
            _ = try await web.evaluateJavaScript("document.querySelector('#comment').value='What changes?';document.querySelector('#comment').dispatchEvent(new Event('input'));document.querySelector('[data-action=notch][type=button]').click();true")
            try await Task.sleep(nanoseconds:150_000_000)
            guard binaryID==id else {throw Check.failed(#line)}
            onKey(talk,pressed:true);onKey(talk,pressed:false)
            _ = try await web.evaluateJavaScript("document.querySelector('#discussion').requestSubmit();true")
            try await Task.sleep(nanoseconds:250_000_000)
            let response=inbox.directory.appendingPathComponent("responses").appendingPathComponent(file.lastPathComponent)
            let reply=try JSONSerialization.jsonObject(with:Data(contentsOf:response)) as? [String:Any]
            let binaryResolved=try await web.evaluateJavaScript("state.decisions.length===0")
            guard reply?["answer"] as? String=="What changes?",reply?["answerKind"] as? String=="freeform" else {throw Check.failed(#line)}
            guard binaryResolved as? Bool==true, binaryID.isEmpty else {throw Check.failed(#line)}
            let captureKey=UInt32(bindings.firstIndex(where:{$0.action=="capture"})!)
            onKey(captureKey,pressed:true)
            let press=capturePress
            onKey(captureKey,pressed:true)
            guard press != nil, capturePress==press else {throw Check.failed(#line)}
            try await Task.sleep(nanoseconds:180_000_000)
            let captured = try await web.evaluateJavaScript("document.querySelector('#modal').open && !!document.querySelector('#transcript')")
            let heldInPage=try await web.evaluateJavaScript("shortcutHold?.id")
            guard captured as? Bool == true, heldInPage as? String == press else {throw Check.failed(#line)}
            onKey(captureKey,pressed:false)
            try await Task.sleep(nanoseconds:80_000_000)
            let released=try await web.evaluateJavaScript("shortcutHold===null && document.activeElement?.id==='transcript'")
            guard capturePress==nil,released as? Bool==true else {throw Check.failed(#line)}
            deliver("workspace")
            try await Task.sleep(nanoseconds:300_000_000)
            guard isWorkspace,workspace.isVisible,workspace.standardWindowButton(.closeButton) != nil,workspace.styleMask.contains(.resizable) else {throw Check.failed(#line)}
            var motionReady=false
            for _ in 0..<42 {
                let value=try await web.evaluateJavaScript("""
                    (()=>{const v=document.querySelector('[data-film=home]');
                    if(!v || !v.poster)return false;
                    if(matchMedia('(prefers-reduced-motion: reduce)').matches)return !v.hasAttribute('src') && v.paused;
                    return document.hidden ? v.paused : v.currentTime>0 && !v.paused && v.playbackRate===1 && v.duration>=15.9})()
                    """)
                if value as? Bool==true {motionReady=true;break}
                try await Task.sleep(nanoseconds:120_000_000)
            }
            if !motionReady {
                let diagnostic=try await web.evaluateJavaScript("""
                    (()=>{const v=document.querySelector('[data-film=home]');
                    return JSON.stringify({view,hidden:document.hidden,modal:!!document.querySelector('dialog[open]'),
                        video:v?{src:v.currentSrc,state:v.readyState,error:v.error?.message,paused:v.paused,time:v.currentTime}:null})})()
                    """)
                print("Motion verification",diagnostic ?? "unavailable")
                throw Check.failed(#line)
            }
            workspace.setContentSize(NSSize(width:760,height:480))
            try verifyWorkspaceChrome()
            let resized=workspace.frame
            deliver("prefs")
            try await Task.sleep(nanoseconds:200_000_000)
            let providerPicker=try await web.evaluateJavaScript("""
                (()=>{
                    document.querySelector('#modal [data-action="prefs-group"][data-id="agents"]').click();
                    document.querySelector('#modal [data-action="session-models"]').click();
                    document.querySelector('#default-agent').click();
                    const list=[...document.querySelectorAll('#modal [role="listbox"]')].find(el=>el.getClientRects().length);
                    const choice=[...(list?.querySelectorAll('[role="option"]') || [])].find(el=>el.textContent.includes('Codex'));
                    if(!choice)return false;
                    choice.click();
                    return document.querySelector('#default-agent').value==='codex';
                })()
                """)
            guard providerPicker as? Bool==true else {throw Check.failed(#line)}
            _ = try await web.evaluateJavaScript("document.querySelector('#modal [aria-label=\"Close dialog\"]').click();true")
            let cardClosed=try await web.evaluateJavaScript("!document.querySelector('#modal').open")
            guard cardClosed as? Bool==true,workspace.frame==resized else {throw Check.failed(#line)}
            let workspaceResponder=workspace.firstResponder
            var later=event
            later["requestId"]="rim-workspace";later["question"]="Keep the new finish?"
            let incoming=inbox.directory.appendingPathComponent("requests").appendingPathComponent(UUID().uuidString+".json")
            try JSONSerialization.data(withJSONObject:later).write(to:incoming,options:.atomic)
            for _ in 0..<24 where !decisionRim.isVisible {try await Task.sleep(nanoseconds:50_000_000)}
            guard isWorkspace,decisionRim.isVisible,pendingCount==1,workspace.firstResponder===workspaceResponder else {throw Check.failed(#line)}
            let stillClosed=try await web.evaluateJavaScript("!document.querySelector('dialog[open]') && document.body.classList.contains('needs-decision')")
            guard stillClosed as? Bool==true else {throw Check.failed(#line)}
            try FileManager.default.removeItem(at:incoming)
            for _ in 0..<24 where decisionRim.isVisible {try await Task.sleep(nanoseconds:50_000_000)}
            guard pendingCount==0,!decisionRim.isVisible,workspace.firstResponder===workspaceResponder else {throw Check.failed(#line)}
            print("Real inbox question illuminated the native workspace rim and withdrawal cleared it without moving focus.")
            onKey(captureKey,pressed:true)
            onKey(captureKey,pressed:false)
            try await Task.sleep(nanoseconds:250_000_000)
            let inputFocused=try await web.evaluateJavaScript("document.body.classList.contains('notch-first') && document.activeElement?.id==='transcript'")
            // The lock screen owns the key window even when WebKit has focused its editor.
            let locked=NSWorkspace.shared.frontmostApplication?.bundleIdentifier=="com.apple.loginwindow"
            guard !isWorkspace,panel.isVisible,web.window===panel,inputFocused as? Bool==true,
                  panel.isKeyWindow || locked else {throw Check.failed(#line)}
            if locked {print("Mac locked. Verified the focused editor and panel transfer; system keyboard delivery requires an unlocked desktop.")}
            deliver("workspace")
            try await Task.sleep(nanoseconds:200_000_000)
            try verifyWorkspaceChrome()
            workspace.performClose(nil)
            try await Task.sleep(nanoseconds:250_000_000)
            guard !isWorkspace,!workspace.isVisible,panel.isVisible else {throw Check.failed(#line)}
            print("Workspace resized, dialog dismissed, and native close returned to the resident notch.")
            print("Passive hover, focus, decisions, discussion, agent inbox round trip and capture verified. Shortcut conflicts: \(unavailable)")
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
                draft.text='Ask Codex to respond with exactly READY and report READY through the Tasktap completion tool.';
                document.querySelector('#transcript').value=draft.text;document.querySelector('#transcript').dispatchEvent(new Event('input'));document.querySelector('[data-action=review]').click();true
                """)
            let review=try await web.evaluateJavaScript("""
                !!document.querySelector('#review-brief') && draft.agent==='codex' && draft.project.endsWith('test-lighting') &&
                !!document.querySelector('#modal tasktap-relay[data-agent="codex"][data-phase="review"]')
                """)
            guard review as? Bool==true else {throw Check.failed(#line)}
            _ = try await web.evaluateJavaScript("document.querySelector('[data-action=commit-review]').click();true")
            for _ in 0..<120 {
                try await Task.sleep(nanoseconds:1_000_000_000)
                let result=try await web.evaluateJavaScript("state.sessions[0]?.state||''")
                if result as? String=="Failed" {throw Check.failed(#line)}
                if result as? String=="Complete" {
                    let actual=try await web.evaluateJavaScript("state.sessions[0].result.trim()")
                    guard actual as? String=="READY" else {throw Check.failed(#line)}
                    let visible=try await web.evaluateJavaScript("state.sessions[0].interactive && state.sessions[0].host==='terminal'")
                    guard visible as? Bool==true else {throw Check.failed(#line)}
                    let relay=try await web.evaluateJavaScript("""
                        (()=>{go('sessions');document.querySelector('.session-row[data-action="session"][data-id="'+state.sessions[0].id+'"]').click();
                        return document.querySelector('#modal tasktap-relay[data-phase="complete"][data-agent="codex"]')?.dataset.capture===state.captures[0].id})()
                        """)
                    guard relay as? Bool==true else {throw Check.failed(#line)}
                    print("Reviewed Codex rail, native queue, real completed result and matching final receipt light verified.")
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
        let inspect=UNNotificationAction(identifier:"inspect",title:"Open session",options:[.foreground])
        notifications.setNotificationCategories([
            UNNotificationCategory(identifier:"decision",actions:[review],intentIdentifiers:[],options:[]),
            UNNotificationCategory(identifier:"result",actions:[open],intentIdentifiers:[],options:[]),
            UNNotificationCategory(identifier:"failure",actions:[inspect],intentIdentifiers:[],options:[])
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
        DispatchQueue.main.async { self.deliver(kind=="request" ? "notice-request":kind=="answer" ? "notice-answer":["failure","attention"].contains(kind) ? "notice-session":"notice-result",id) }
    }
    func webView(_ webView:WKWebView,decidePolicyFor navigationAction:WKNavigationAction,
                 decisionHandler:@escaping (WKNavigationActionPolicy)->Void){
        if navigationAction.targetFrame?.isMainFrame == false,
           let scheme=navigationAction.request.url?.scheme?.lowercased(),
           ["tasktap-preview","http","https","about","blob"].contains(scheme) {decisionHandler(.allow);return}
        if navigationAction.request.url?.standardizedFileURL==entry?.standardizedFileURL {decisionHandler(.allow);return}
        openActivatedExternalLink(navigationAction)
        decisionHandler(.cancel)
    }
    // Sandboxed web previews keep normal navigation in their frame. Explicit
    // new-window and associated-app links use the system handler; scripts alone
    // cannot launch another application or create an unowned WKWebView.
    private func openActivatedExternalLink(_ action:WKNavigationAction) {
        guard !verifying,!liveTest,action.navigationType == .linkActivated,
              let value=action.request.url?.absoluteString,
              let target=try? WorkspaceLinks.resolve(value,cwd:"") else {return}
        switch target {
        case .web(let url),.app(let url):
            if !NSWorkspace.shared.open(url){deliver("live-error","Could not open this link in its default app.",reveal:false)}
        case .file:break
        }
    }
    func webView(_ webView:WKWebView,createWebViewWith configuration:WKWebViewConfiguration,
                 for navigationAction:WKNavigationAction,windowFeatures:WKWindowFeatures)->WKWebView? {
        openActivatedExternalLink(navigationAction)
        return nil
    }
    func windowDidChangeScreen(_ notification: Notification) {
        guard isWorkspace, let window = notification.object as? WorkspaceWindow, let screen = window.screen else { return }
        decisionRim.update(screen:screen, visible:pendingCount > 0)
    }
    func windowDidResignKey(_ notification:Notification) {
        if notification.object as? WorkspaceWindow === workspace {workspace.setDividerCursor(nil)}
    }
    func windowShouldClose(_ sender:NSWindow)->Bool {
        if independentWindows,sender === workspace {workspace.orderOut(nil);if let screen=workspace.screen ?? anchorScreen ?? NSScreen.main {decisionRim.update(screen:screen,visible:false)};return false}
        deliver("collapse",reveal:false);return false
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    private func updateNotificationStatus() {
        notifications.getNotificationSettings { [weak self] settings in
            let authorization: String
            switch settings.authorizationStatus {
            case .notDetermined: authorization="notDetermined"
            case .denied: authorization="denied"
            case .authorized: authorization="authorized"
            case .provisional: authorization="provisional"
            @unknown default: authorization="unknown"
            }
            func setting(_ value: UNNotificationSetting) -> String {
                switch value {case .enabled:return "enabled";case .disabled:return "disabled";default:return "unavailable"}
            }
            let status=["authorization":authorization,"alerts":setting(settings.alertSetting),"center":setting(settings.notificationCenterSetting)]
            DispatchQueue.main.async {self?.js("notificationStatus(status)",["status":status])}
        }
    }
    func applicationDidBecomeActive(_ notification: Notification) {
        if ready {
            updateMenu()
            speech.publish();publishApplicationSettings()
            js("if(document.querySelector('#notification-preferences'))postHost('notification-status')",[:])
        }
    }
    func applicationWillTerminate(_ notification:Notification){
        connectionTask?.cancel();routeTask?.cancel();serverProbe?.cancel();identityCheck?.cancel()
        hoverTimer?.invalidate()
        narration.changed={_ in};speech.changed={_ in};speech.cancelInstall();inbox.stop();narration.stop();dictation.cancel();if !verifying{runtime.stop()}
        for key in hotKeys.values { UnregisterEventHotKey(key) }
        if let handler { RemoveEventHandler(handler) }
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
    }
}
setenv("TASKTAP_DATA",LiveWorkspace.appData.path,1)
let app=NSApplication.shared
let delegate=Assistant()
app.delegate=delegate
app.run()
