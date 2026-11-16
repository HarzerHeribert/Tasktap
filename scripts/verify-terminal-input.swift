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
        config.userContentController.addUserScript(WKUserScript(source:"window.tasktapSurface='workspace';window.tasktapScreenReaderEnabled=true",injectionTime:.atDocumentStart,forMainFrameOnly:true))
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
                area.dispatchEvent(new KeyboardEvent('keydown',{key:'Process',keyCode:229,isComposing:true,bubbles:true,cancelable:true}));
                area.value=area.value.replace('gettg','getting');
                area.dispatchEvent(new InputEvent('input',{data:'getting',inputType:'insertReplacementText',isComposing:true,bubbles:true}));
                await pause();check('orphan composing flag does not replay','');
                if(!area.value.endsWith('gettg'))throw Error('Orphan replacement mirror not restored');
                if(getComputedStyle(document.querySelector('.xterm-viewport')).overflowY!=='hidden')throw Error('Redundant native scrollbar');
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
                guard failure==nil,checks==6 else {throw NSError(domain:failure ?? "Missing checks: \(checks)",code:1)}
                input=""
                _ = try await web.evaluateJavaScript("workspaceDeck.accessibilityChanged(false);document.querySelector('.xterm-helper-textarea').value='';document.querySelector('.xterm-helper-textarea').focus();true")
                window.makeFirstResponder(web)
                let typed="ordinary typing repeats no words words ABC 123."
                for character in typed {
                    let text=String(character)
                    for type in [NSEvent.EventType.keyDown,.keyUp] {
                        let event=NSEvent.keyEvent(with:type,location:.zero,modifierFlags:[],timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:window.windowNumber,context:nil,characters:text,charactersIgnoringModifiers:text,isARepeat:false,keyCode:0)!
                        window.sendEvent(event)
                    }
                    try await Task.sleep(nanoseconds:15_000_000)
                }
                try await Task.sleep(nanoseconds:100_000_000)
                guard input==typed else {throw NSError(domain:"Native typing mismatch: \(input.debugDescription)",code:1)}
                let empty=try await web.evaluateJavaScript("document.querySelector('.xterm-helper-textarea').value==='' && !document.querySelector('.xterm-accessibility')")
                guard empty as? Bool == true else {let debug=try await web.evaluateJavaScript("JSON.stringify({value:document.querySelector('.xterm-helper-textarea').value,mode:workspaceDeck.terminalMetrics('native-fixture').screenReaderMode,accessible:!!document.querySelector('.xterm-accessibility')})");throw NSError(domain:"Ordinary typing mirror: \(debug ?? "missing")",code:1)}
                input=""
                _ = try await web.callAsyncJavaScript("""
                const area=document.querySelector('.xterm-helper-textarea');
                area.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));area.value='日本';
                area.dispatchEvent(new CompositionEvent('compositionupdate',{data:'日本',bubbles:true}));await new Promise(resolve=>setTimeout(resolve,30));
                area.dispatchEvent(new CompositionEvent('compositionend',{data:'日本',bubbles:true}));await new Promise(resolve=>setTimeout(resolve,30));
                return true;
                """,arguments:[:],in:nil,contentWorld:.page)
                guard input=="日本" else {throw NSError(domain:"Ordinary-mode IME mismatch",code:1)}
                print("PASS: native WKWebView keyboard typing once, correction/orphan-composition replay guards, IME, composer paste, and no redundant native scrollbar.")
                NSApp.terminate(nil)
            } catch {fputs("WebKit input check failed: \(error)\n",stderr);exit(1)}
        }
    }
}
let app=NSApplication.shared
let check=Check();app.delegate=check;app.run()
