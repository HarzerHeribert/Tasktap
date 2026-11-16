const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:820},reducedMotion:'reduce'}),errors=[];
  page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{
   window.tasktapSurface='workspace';window.messages=[];window.clipboardText='';window.clipboardCalls=[];
   window.webkit={messageHandlers:{workspace:{postMessage:m=>messages.push(m)},terminalClipboard:{postMessage:async m=>{
    clipboardCalls.push(m);if(window.clipboardError)throw Error('fixture unavailable');
    if(m.op==='copy'){clipboardText=m.text;return true}
    if(window.delayClipboard)return await new Promise(resolve=>window.finishClipboard=resolve);
    return clipboardText;
   }}}};
  });
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.evaluate(async()=>{
   state.firstRun={done:true};state.projects=[{id:'clip',folder:'/tmp/tasktap-clipboard-fixture',name:'Clipboard fixture',aliases:[]}];state.sessions=[];state.captures=[];state.decisions=[];state.notes=[];
   Object.assign(state.workspaceDeck,{layouts:{},media:{}});
   await workspaceDeck.receive([{event:'sessions',sessions:['left','right'].map(id=>({id,cwd:'/tmp/tasktap-clipboard-fixture',title:id+' prompt',running:true,kind:'shell'}))}]);
   showWorkspace();workspaceDeck.open('terminal:left','clip');
   const l=state.workspaceDeck.layouts.clip,right=workspaceLayout.split(l,l.groups[0].id,'x','right-pane');
   right.tabs=['terminal:right'];right.active='terminal:right';render();
   for(const id of ['left','right'])await workspaceDeck.receive([{event:'replay',id,seq:0,cols:80,rows:24,data:btoa(id+' terminal output\r\n$ ')}]);
   messages=[];
  });
  const tab=id=>page.locator('.deck-tab[data-id="terminal:'+id+'"]');
  const input=()=>page.evaluate(()=>messages.filter(m=>m.op==='input').map(m=>({id:m.id,text:new TextDecoder().decode(Uint8Array.from(atob(m.data),c=>c.charCodeAt(0)))})));
  const reset=()=>page.evaluate(()=>{messages=[];clipboardCalls=[]});
  await tab('left').click();await page.evaluate(()=>clipboardText='Fix the résumé ✓');
  await page.keyboard.press('Meta+v');await page.waitForFunction(()=>messages.some(m=>m.op==='input'));
  assert.deepEqual(await input(),[{id:'left',text:'Fix the résumé ✓'}],'Command-V pastes once into the selected terminal without Enter');
  await reset();await page.evaluate(()=>clipboardText='right prompt');
  await page.locator('[data-action="deck-paste"][data-id="right"]').click();await page.waitForFunction(()=>messages.some(m=>m.op==='input'));
  assert.deepEqual(await input(),[{id:'right',text:'right prompt'}],'toolbar paste targets its own pane');
  assert.equal(await page.evaluate(()=>document.activeElement.closest('.deck-group').dataset.groupId),'right-pane');
  await reset();await page.evaluate(async()=>{clipboardText='first\nsecond';await workspaceDeck.receive([{event:'output',id:'right',seq:1,data:btoa('\x1b[?2004h')}])});
  await page.keyboard.press('Meta+v');await page.waitForFunction(()=>messages.some(m=>m.op==='input'));
  assert.deepEqual(await input(),[{id:'right',text:'\x1b[200~first\rsecond\x1b[201~'}],'CLI bracketed paste is preserved');
  await reset();await page.keyboard.press('Control+c');
  assert.deepEqual(await input(),[{id:'right',text:'\x03'}],'Control-C still interrupts the terminal');
  await tab('left').click();
  await page.locator('.deck-group.selected .xterm-screen').click({position:{x:30,y:8},clickCount:3});
  await reset();await page.keyboard.press('Meta+c');
  await page.waitForFunction(()=>clipboardCalls.some(m=>m.op==='copy'));
  assert.match(await page.evaluate(()=>clipboardText),/left terminal output/,'Command-C copies xterm selection');
  assert.deepEqual(await input(),[],'copy does not send control characters');
  await reset();await page.locator('[data-action="deck-copy"][data-id="left"]').click();
  await page.waitForFunction(()=>clipboardCalls.some(m=>m.op==='copy'));
  // Native Edit falls through to ordinary editing in dialogs and preview documents.
  await page.evaluate(()=>workspaceDeck.preferences());await reset();
  assert.equal(await page.evaluate(()=>workspaceDeck.clipboardCommand('paste',true)),false);
  await page.keyboard.press('Meta+v');assert.deepEqual(await page.evaluate(()=>clipboardCalls),[]);
  await page.evaluate(()=>dismissCard());await tab('left').click();
  await page.evaluate(()=>{clipboardText='';messages=[]});await page.keyboard.press('Meta+v');
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('no text'));assert.deepEqual(await input(),[]);
  await page.evaluate(()=>clipboardText='x'.repeat(64001));await page.keyboard.press('Meta+v');
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('too large'));assert.deepEqual(await input(),[]);
  await page.evaluate(()=>{clipboardError=true});await page.keyboard.press('Meta+v');
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Clipboard access failed'));assert.deepEqual(await input(),[]);
  await page.evaluate(()=>{clipboardError=false;delayClipboard=true;messages=[]});await page.keyboard.press('Meta+v');
  await page.waitForFunction(()=>!!window.finishClipboard);await tab('right').click();
  await page.evaluate(()=>{finishClipboard('captured destination');delayClipboard=false});
  await page.waitForFunction(()=>messages.some(m=>m.op==='input'));
  assert.deepEqual(await input(),[{id:'left',text:'captured destination'}],'delayed read keeps the original destination');
  assert.equal(await page.evaluate(()=>document.activeElement.closest('.deck-group').dataset.groupId),'right-pane','late paste does not steal focus');
  await reset();await page.evaluate(()=>workspaceDeck.receive([{event:'disconnected',error:'Fixture disconnected'}]));
  await page.keyboard.press('Meta+v');assert.deepEqual(await input(),[]);assert.deepEqual(await page.evaluate(()=>clipboardCalls),[]);
  assert.deepEqual(errors,[]);
  console.log('PASS: terminal Command-V/Command-C, toolbar targeting, Unicode, no Enter, bracketed paste, Control-C, dialog fallback, empty/large/failed clipboard, delayed destination and disconnect handling.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
