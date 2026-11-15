// Product imagery renders actual shared UI with fictional data and an intercepted native bridge.
// The sample transcript illustrates a session; it is not evidence of a live agent run.
const {chromium}=require('playwright');
const {pathToFileURL}=require('node:url');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const dest=path.join(root,'site/assets/product');fs.mkdirSync(dest,{recursive:true});
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});try{
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1,reducedMotion:'reduce'});
await page.addInitScript(()=>{window.messages=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>messages.push(m)}}}});
await page.goto(pathToFileURL(path.join(root,'prototype/index.html')).href);
await page.evaluate(()=>{
 document.body.classList.add('workspace-snapshot');state.firstRun={done:true};state.setupSeen=true;firstRun.visible=false;
 state.projects=[{id:'cuegrid',folder:'/Users/example/projects/cuegrid',name:'Cuegrid',aliases:[],available:true},{id:'fieldnotes',folder:'/Users/example/projects/fieldnotes',name:'Fieldnotes',aliases:[],available:true}];
 state.sessions=[{id:'product-agent',project:'cuegrid',agent:'codex',host:'tasktap',interactive:true,available:true,state:'Connected',task:'Refine the rehearsal view',log:[]}];
 state.captures=[];state.decisions=[];state.workspaceDeck.sidebarHidden=false;state.workspaceDeck.openProjects=['cuegrid','fieldnotes'];state.workspaceDeck.navigationExpanded={cuegrid:true,fieldnotes:false};
 state.workspaceDeck.preferences.fontSize=15;state.workspaceDeck.preferences.translucent=false;
 state.workspaceDeck.layouts.cuegrid={groups:[{id:'agent',tabs:['terminal:product-agent'],active:'terminal:product-agent'},{id:'preview',tabs:[],active:null},{id:'notes',tabs:[],active:null}],selected:1,focus:false,tree:{id:'split-main',axis:'x',ratio:45,first:{group:'agent'},second:{id:'split-preview',axis:'y',ratio:64,first:{group:'preview'},second:{group:'notes'}}}};
 appAppearance.setTheme('dark');showWorkspace();go('cuegrid');
});
await page.evaluate(()=>workspaceDeck.receive([{event:'sessions',sessions:[{id:'product-agent',cwd:'/Users/example/projects/cuegrid',title:'Refine the rehearsal view',kind:'agent',running:true}]}]));
await page.evaluate(()=>workspaceDeck.receive([{event:'replay',id:'product-agent',seq:1,cols:78,rows:40,data:btoa(unescape(encodeURIComponent('\x1b[38;2;166;185;223m> Refine the rehearsal view. Keep the timer readable\r\n  on mobile and preserve the keyboard shortcuts.\x1b[0m\r\n\r\nI\'ll simplify the controls and check the small-screen\r\nlayout.\r\n\r\n\x1b[38;2;151;185;158m\u2022\x1b[0m Updated the rehearsal layout\r\n  src/rehearsal.css\r\n\r\n\x1b[38;2;151;185;158m\u2022\x1b[0m Checked keyboard navigation\r\n  Space to pause, R to reset\r\n\r\n\x1b[38;2;151;185;158m\u2022\x1b[0m Ran responsive checks\r\n  390px, 768px, 1440px\r\n\r\nThe timer now stays centered as the window narrows.\r\nThe preview is ready beside this session.\r\n\r\n\x1b[2mExample project \u00b7 illustration of a session\x1b[0m\r\n\r\n\x1b[38;2;166;185;223m>\x1b[0m ')))}]));
await page.evaluate(()=>{
 const html='<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;background:#eae6de;color:#292724;font:14px system-ui;padding:28px 32px}header{display:flex;justify-content:space-between;align-items:center;font-size:12px;letter-spacing:.1em}header b{font-size:15px;letter-spacing:-.04em}main{margin:35px auto 0;max-width:500px}small{display:block;font-size:11px;letter-spacing:.11em;color:#736c62}h1{font-size:28px;letter-spacing:-.05em;font-weight:520;margin:7px 0 17px}.timer{font-size:85px;font-weight:480;letter-spacing:-.065em;line-height:1.15;font-variant-numeric:tabular-nums}.rail{height:4px;background:#d3cec4;border-radius:4px;margin:18px 0}.rail span{display:block;width:67%;height:100%;background:#8b6c46}footer{display:flex;justify-content:space-between;align-items:center;margin-top:20px;color:#6c665d;font-size:12px}button{border:1px solid #c5beb1;border-radius:30px;padding:9px 18px;background:transparent;color:inherit;font:inherit}i{display:inline-block;width:6px;height:6px;background:#8d7657;border-radius:50%;margin-right:6px}</style><header><b>cuegrid</b><span>REHEARSAL 04</span></header><main><small>UP NEXT / OPENING NOTES</small><h1>A little space to find your rhythm.</h1><div class="timer">08:42</div><div class="rail"><span></span></div><footer><span><i></i>Rehearsal in progress</span><button>Pause &nbsp; II</button></footer></main>';
 workspaceDeck.addFiles('cuegrid',[{id:'preview',kind:'web',title:'localhost:3000',url:'data:text/html;charset=utf-8,'+encodeURIComponent(html)}]);
 state.workspaceDeck.layouts.cuegrid.selected=2;
 workspaceDeck.addFiles('cuegrid',[{id:'brief',kind:'text',title:'Rehearsal notes.md',path:'/Users/example/projects/cuegrid/Rehearsal notes.md',url:'tasktap-preview://product/notes.md'}]);
 workspaceDeck.textLoaded('brief','# Ready for rehearsal\n\nKeep the essentials in view.\n\n- [x] Readable timer at every window size\n- [x] Keyboard controls stay within reach\n- [ ] Try it with the rest of the team\n');
 state.workspaceDeck.layouts.cuegrid.selected=0;render();
});
await page.waitForTimeout(250);await page.evaluate(()=>document.activeElement?.blur());await page.locator('.shell').screenshot({path:dest+'/workspace.png'});await page.setViewportSize({width:464,height:1000});
await page.evaluate(()=>{
 aiConnections.receive({choice:'local',workers:{codex:'Existing CLI account',claude:'Existing CLI account'},workerHealth:{codex:'signedIn',claude:'signedIn'},models:{},keys:{},accounts:[],account:''});aiConnections.checked();
 document.body.style.setProperty('--native-surface-width','432px');showHome(true);captureDraft('','cuegrid','Make the rehearsal timer easier to read on mobile. Keep the keyboard shortcuts.');draft.mode='ask';draft.project='cuegrid';draft.agent='codex';draft.agentChoice='named';draft.brief=draft.text;draft.reference={kind:'website',value:'http://localhost:3000/rehearsal',app:'Safari',observedAt:Date.now()/1000};review();
});
await page.evaluate(()=>document.activeElement?.blur());await page.locator('#modal').screenshot({path:dest+'/review.png'});
await page.evaluate(()=>{dismissCard();state.decisions=[{id:'product-question',session:'product-agent',q:'Keep the timer running when you switch views?',choices:['Keep it running','Pause when I leave'],detail:'The timer can continue in the background while you check your notes.'}];showHome(true);showNotch('product-question')});
await page.evaluate(()=>document.activeElement?.blur());await page.locator('#notch').screenshot({path:dest+'/question.png'});
await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>{dismissCard();showWorkspace();go('cuegrid');appAppearance.setTheme('ocean');prefs('appearance')});
await page.locator('.appearance-choices').screenshot({path:dest+'/appearance.png'});
console.log(dest);
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
