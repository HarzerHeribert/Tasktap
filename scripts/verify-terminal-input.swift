// Run from the repository root: swiftc -target arm64-apple-macosx26.0 scripts/verify-terminal-input.swift -o /tmp/tasktap-webkit-input-check
import AppKit
import WebKit

final class Check: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var web: WKWebView!
    var window: NSWindow!
    var input = ""
    var checks = 0
    var failure: String?
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let config=WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self,name:"workspace")
        config.userContentController.addUserScript(WKUserScript(source:"window.tasktapSurface='workspace'",injectionTime:.atDocumentStart,forMainFrameOnly:true))
        web=WKWebView(frame:NSRect(x:0,y:0,width:1100,height:800),configuration:config)
        web.navigationDelegate=self
        window=NSWindow(contentRect:web.frame,styleMask:[.titled],backing:.buffered,defer:false)
        window.contentView=web;window.orderBack(nil)
        let url=URL(fileURLWithPath:FileManager.default.currentDirectoryPath).appendingPathComponent("prototype/index.html")
        web.loadFileURL(url,allowingReadAccessTo:url.deletingLastPathComponent())
        DispatchQueue.main.asyncAfter(deadline:.now()+20){fputs("WebKit input check timed out.\n",stderr);exit(1)}
    }
    func userContentController(_ controller:WKUserContentController,didReceive message:WKScriptMessage){
        guard let m=message.body as? [String:Any] else{return}
        if m["type"] as? String == "fixture-reset" {input=""}
        if m["type"] as? String == "workspace-terminal",m["op"] as? String == "input",let b=m["data"] as? String,let bytes=Data(base64Encoded:b),let text=String(data:bytes,encoding:.utf8){input+=text}
        if m["type"] as? String == "fixture-check",let expected=m["expected"] as? String {
            checks+=1;if input != expected {failure="\(m["label"] ?? "input"): expected \(expected.debugDescription), received \(input.debugDescription)"}
        }
    }
    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!){
        Task { @MainActor in
            do {
                _ = try await web.callAsyncJavaScript("""
                const pause=()=>new Promise(resolve=>setTimeout(resolve,30));
                const check=(label,expected)=>postHost('fixture-check',{label,expected});
                state.firstRun={done:true};state.decisions=[];state.projects=[{id:'native-input',folder:'/tmp/native-input',name:'Native input',aliases:[]}];
                await workspaceDeck.receive([{event:'sessions',sessions:[{id:'native-fixture',cwd:'/tmp/native-input',title:'Native fixture',kind:'shell',running:true}]}]);
                showWorkspace();workspaceDeck.open('terminal:native-fixture','native-input');
                await workspaceDeck.receive([{event:'replay',id:'native-fixture',seq:0,cols:100,rows:30,data:''}]);
                const area=document.querySelector('.deck-terminal:not([hidden]) .xterm-helper-textarea');area.focus();
                area.value='good find out that my prompt is gettg';area.setSelectionRange(area.value.length,area.value.length);
                postHost('fixture-reset');
                area.dispatchEvent(new KeyboardEvent('keydown',{key:'Process',keyCode:229,bubbles:true,cancelable:true}));
                area.value=area.value.replace('gettg','getting');await pause();check('correction emits no terminal input','');
                if(!area.value.endsWith('gettg'))throw Error('Mirror not restored');
                area.dispatchEvent(new KeyboardEvent('keydown',{key:'Process',keyCode:229,bubbles:true,cancelable:true}));
                area.value+='!';area.dispatchEvent(new InputEvent('input',{data:'!',inputType:'insertText',bubbles:true}));
                await pause();check('229 addition once','!');
                postHost('fixture-reset');
                area.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));area.value+='日本';
                area.dispatchEvent(new CompositionEvent('compositionupdate',{data:'日本',bubbles:true}));await pause();
                area.dispatchEvent(new CompositionEvent('compositionend',{data:'日本',bubbles:true}));await pause();check('IME commit once','日本');
                postHost('fixture-reset');workspaceCommand('menu-pane-compose');
                const editor=document.querySelector('#terminal-compose-text');editor.value='A reviewed prompt';editor.dispatchEvent(new Event('input',{bubbles:true}));
                check('composer does not stream','');document.querySelector('#terminal-compose-form').requestSubmit();await pause();check('insert without Enter','A reviewed prompt');
                return true;
                """,arguments:[:],in:nil,contentWorld:.page)
                guard failure==nil,checks==5 else {throw NSError(domain:failure ?? "Missing checks: \(checks)",code:1)}
                print("PASS: native WKWebView correction guard, accessibility mirror, 229 text, IME composition, and composer paste without Enter.")
                NSApp.terminate(nil)
            } catch {fputs("WebKit input check failed: \(error)\n",stderr);exit(1)}
        }
    }
}
let app=NSApplication.shared
let check=Check();app.delegate=check;app.run()
