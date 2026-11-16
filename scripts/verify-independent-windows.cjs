const {chromium}=require('playwright');
const assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
  const pages={},messages=[],errors=[];
  for(const role of ['workspace','notch']){
   const page=await context.newPage();pages[role]=page;
   page.on('pageerror',e=>errors.push(String(e)));
   await page.exposeFunction('nativeMessage',async message=>{
    messages.push({role,...message});
    if(message.type==='shared-state'){
     const peer=pages[role==='workspace'?'notch':'workspace'];
     if(peer)await peer.evaluate(patch=>sharedState.apply(patch),message.patch);
    }
   });
   await page.addInitScript(role=>{window.tasktapSurface=role;window.webkit={messageHandlers:{workspace:{postMessage:m=>window.nativeMessage(m)}}}},role);
   await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  }
  await pages.workspace.evaluate(()=>{state.firstRun={done:true};state.projects=[{id:'dual',name:'Dual',folder:'/tmp/dual',aliases:[]}];state.sessions=[];state.notes=[];state.decisions=[];persist();go('dual')});
  await pages.notch.evaluate(()=>sharedState.snapshot(JSON.parse(localStorage.getItem(storageKey))));
  assert.equal(await pages.workspace.evaluate(()=>document.body.classList.contains('notch-first')),false);
  assert.equal(await pages.notch.evaluate(()=>document.body.classList.contains('notch-first')),true);
  await pages.workspace.evaluate(()=>{window.originalDeck=document.querySelector('.deck-project:not([hidden])');showHome(true)});
  assert.ok(messages.some(m=>m.role==='workspace'&&m.type==='show-notch'));
  assert.ok(await pages.workspace.evaluate(()=>!document.body.classList.contains('notch-first')&&originalDeck===document.querySelector('.deck-project:not([hidden])')));
  await pages.notch.evaluate(()=>showHome(true));
  await pages.notch.evaluate(()=>{state.notes.unshift({id:'notch-note',text:'notch'});persist()});
  await pages.workspace.evaluate(()=>{state.notes.unshift({id:'workspace-note',text:'workspace'});persist()});
  await pages.workspace.waitForFunction(()=>state.notes.some(n=>n.id==='notch-note')&&state.notes.some(n=>n.id==='workspace-note'));
  await pages.notch.waitForFunction(()=>state.notes.some(n=>n.id==='notch-note')&&state.notes.some(n=>n.id==='workspace-note'));
  await pages.notch.evaluate(()=>{state.notes=state.notes.filter(n=>n.id!=='notch-note');persist()});
  await pages.workspace.waitForFunction(()=>!state.notes.some(n=>n.id==='notch-note')&&state.notes.some(n=>n.id==='workspace-note'));
  await pages.notch.evaluate(()=>{workspaceDeck.open('terminal:fixture','dual');showWorkspace()});
  assert.ok(messages.some(m=>m.role==='notch'&&m.type==='workspace-open'));
  assert.ok(messages.some(m=>m.role==='notch'&&m.type==='show-workspace'));
  assert.equal(messages.filter(m=>m.role==='notch'&&m.type==='workspace-terminal').length,0,'notch never owns terminal connections');
  assert.ok(await pages.workspace.evaluate(()=>originalDeck===document.querySelector('.deck-project:not([hidden])')));
  await pages.workspace.evaluate(()=>{state.workspaceDeck.preferences.font=18;persist()});
  await pages.notch.waitForFunction(()=>state.workspaceDeck.preferences.font===18);
  await pages.notch.evaluate(()=>{state.workspaceDeck.preferences.font=19;persist()});
  await pages.workspace.waitForFunction(()=>state.workspaceDeck.preferences.font===19);
  assert.deepEqual(errors,[]);
  await context.close();console.log('PASS: independent view roles, workspace stays mounted, bidirectional record merge/removal, shared preferences and notch-to-workspace terminal delegation.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
