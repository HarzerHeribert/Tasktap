const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const fs=require('node:fs');
const shots=process.env.TASKTAP_SCREENSHOTS||'output';
fs.mkdirSync(shots,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{window.messages=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>messages.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.evaluate(async()=>{
   state.firstRun={done:true};state.projects=[{id:'p',folder:'/tmp/nested-workspace',name:'Nested workspace',aliases:[]}];state.sessions=[];state.captures=[];state.decisions=[];state.notes=[];
   Object.assign(state.workspaceDeck,{layouts:{},media:{},sidebarHidden:false,navigationExpanded:{p:true}});
   await workspaceDeck.receive([{event:'sessions',sessions:[{id:'initial',cwd:'/tmp/nested-workspace',title:'Original shell',kind:'shell',running:true}]}]);
   showWorkspace();workspaceDeck.open('terminal:initial','p');
   await workspaceDeck.receive([{event:'replay',id:'initial',seq:0,cols:100,rows:30,data:btoa('Original shell ready\r\n')}]);
   const html='<html><body>Persistent preview<script>const nonce=Math.random().toString(36);addEventListener("message",e=>{if(e.data==="workspace-ping")e.source.postMessage({type:"workspace-pong",nonce},"*")})<\/script></body></html>';
   workspaceDeck.addFiles('p',[{id:'web',kind:'web',title:'Persistent preview',path:'/tmp/nested-workspace/preview.html',url:'data:text/html,'+encodeURIComponent(html)}]);
   workspaceDeck.textLoaded('web',html);
  });
  const original=await page.evaluate(()=>state.workspaceDeck.layouts.p.groups[0].id);
  const initialNonce=await iframeNonce(page);
  await page.getByRole('button',{name:'Source',exact:true}).click();
  assert.equal(await page.locator('.deck-preview iframe').isVisible(),false);
  assert.equal(await page.locator('.deck-document').innerText(),await page.evaluate(()=>decodeURIComponent(state.workspaceDeck.media.web.url.slice('data:text/html,'.length))),'HTML Source preserves the original document text');
  await page.getByRole('button',{name:'Preview',exact:true}).click();
  assert.equal(await iframeNonce(page),initialNonce,'HTML source and preview round-trip keeps the original live document');
  const pending=[];
  async function split(action){
   const before=await page.evaluate(()=>({groups:state.workspaceDeck.layouts.p.groups.length,starts:messages.filter(m=>m.type==='workspace-terminal'&&m.op==='start').length}));
   if(action==='right'||action==='down')await page.locator('.deck-tools [data-action="deck-split-'+action+'"]').click();
   else await page.keyboard.press(action);
   const result=await page.evaluate(()=>{const l=state.workspaceDeck.layouts.p,g=l.groups[l.selected],starts=messages.filter(m=>m.type==='workspace-terminal'&&m.op==='start');return {groups:l.groups.length,group:g.id,tabs:g.tabs,start:starts.at(-1),starts:starts.length}});
   assert.equal(result.groups,before.groups+1,'each split immediately creates a pane');assert.equal(result.starts,before.starts+1,'each split starts one shell');
   assert.deepEqual(result.tabs,[],'new pane is empty until its own shell arrives');
   assert.equal(await page.evaluate(()=>document.activeElement?.closest('.deck-group')?.dataset.groupId),result.group,'a pending split takes keyboard focus away from the previous terminal');
   assert.equal(result.start.cwd,'/tmp/nested-workspace');assert.equal(result.start.shell,'default');
   assert.match(await page.locator('.deck-group[data-group-id="'+result.group+'"] .deck-empty').innerText(),/Opening terminal/);
   pending.push({id:result.start.id,group:result.group});return result;
  }
  await split('right');await split('down');await split('Meta+d');await split('Meta+Shift+d');
  assert.equal(await page.locator('.deck-group').count(),5,'splits support more than two panes');
  assert.equal(await iframeNonce(page),initialNonce,'nested splits preserve the embedded document');
  await page.locator('[data-action="deck-tab"][data-id="terminal:initial"]').click();
  await page.waitForFunction(()=>document.activeElement?.classList.contains('xterm-helper-textarea'));
  for(const request of [...pending].reverse()){
   await page.evaluate(async({id})=>{await workspaceDeck.receive([{event:'session',session:{id,cwd:'/tmp/nested-workspace',kind:'shell',title:'Shell '+id.slice(0,6),running:true}}]);await workspaceDeck.receive([{event:'replay',id,seq:0,cols:70,rows:20,data:btoa('Split shell ready\r\n')}]);},request);
   assert.equal(await page.evaluate(id=>state.workspaceDeck.layouts.p.groups.find(g=>g.tabs.includes('terminal:'+id))?.id,request.id),request.group,'out-of-order shell replies attach to the requesting pane');
   assert.equal(await page.evaluate(()=>state.workspaceDeck.layouts.p.groups[state.workspaceDeck.layouts.p.selected].id),original,'late shell replies do not steal pane selection');
  }
  await page.waitForFunction(id=>document.activeElement?.closest('.deck-group')?.dataset.groupId===id,original);
  const order=await page.evaluate(()=>{const l=state.workspaceDeck.layouts.p,leaves=n=>n.group?[n.group]:[...leaves(n.first),...leaves(n.second)];return {flat:l.groups.map(g=>g.id),tree:leaves(l.tree)}});
  assert.deepEqual(order.flat,order.tree,'sidebar leaf order matches the spatial split tree');
  const boxes=await geometry(page);
  assert.equal(boxes.length,5);assert.ok(boxes.every(b=>b.width>30&&b.height>30));
  assert.ok(new Set(boxes.map(b=>Math.round(b.x))).size>1&&new Set(boxes.map(b=>Math.round(b.y))).size>1,'both axes have real pane geometry');
  for(const axis of ['x','y']){
   const separator=page.locator('.deck-divider[data-axis="'+axis+'"]').first(),r=await separator.boundingBox(),old=Number(await separator.getAttribute('aria-valuenow'));
   await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width/2+(axis==='x'?-35:0),r.y+r.height/2+(axis==='y'?-35:0));await page.mouse.up();
   assert.ok(Number(await separator.getAttribute('aria-valuenow'))<old,axis+' separator drags its own branch');
   await separator.focus();await page.keyboard.press('Home');assert.equal(await separator.getAttribute('aria-valuenow'),'10');
   await page.keyboard.press('End');assert.equal(await separator.getAttribute('aria-valuenow'),'90');
   await separator.dblclick();assert.equal(await separator.getAttribute('aria-valuenow'),'50');
  }
  const beforeFocus=await geometry(page);
  await page.locator('.deck-tools [data-action="deck-focus"]').click();
  assert.equal(await page.locator('.deck-group:visible').count(),1);
  assert.equal(await page.locator('.deck-divider:visible').count(),0);
  const focused=await page.locator('.deck-group:visible').boundingBox(),area=await page.locator('.deck-groups').boundingBox();
  assert.ok(Math.abs(focused.width-area.width)<1&&Math.abs(focused.height-area.height)<1,'focus fills the entire surface');
  await page.locator('.deck-tools [data-action="deck-focus"]').click();
  assert.deepEqual(await geometry(page),beforeFocus,'exiting focus restores all branch dimensions');
  await page.locator('[data-action="deck-tab"][data-id="media:web"]').click();
  assert.equal(await iframeNonce(page),initialNonce,'resizes, responses and focus preserve the iframe document');
  for(const [from,to] of [[original,pending[2].group],[pending[2].group,original]]){
   await page.locator('.deck-group[data-group-id="'+from+'"] [aria-label="Pane actions"]').click();
   await page.getByRole('button',{name:'Move tab to…',exact:true}).click();
   await page.locator('#modal [data-action="deck-move-to"][data-id="'+to+'"]').click();
   assert.equal(await iframeNonce(page),initialNonce,'moving a preview across panes preserves its document state');
  }
  await page.screenshot({path:path.join(shots,'workspace-nested-splits.png')});
  // Move a terminal by an explicit destination; preserve the existing process.
  const moving=pending[0],target=pending.at(-1);
  await page.locator('.deck-group[data-group-id="'+moving.group+'"] [aria-label="Pane actions"]').click();
  await page.getByRole('button',{name:'Move tab to…',exact:true}).click();
  await page.locator('#modal [data-action="deck-move-to"][data-id="'+target.group+'"]').click();
  assert.equal(await page.evaluate(id=>state.workspaceDeck.layouts.p.groups.find(g=>g.tabs.includes('terminal:'+id))?.id,moving.id),target.group);
  assert.match(await page.evaluate(id=>workspaceDeck.terminalText(id),moving.id),/Split shell ready/,'moving a terminal keeps its existing buffer');
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.op==='start').length),4,'move does not spawn a terminal');
  const countBeforeClose=await page.locator('.deck-group').count();
  await page.locator('.deck-group[data-group-id="'+target.group+'"] [aria-label="Pane actions"]').click();
  await page.getByRole('button',{name:'Close pane',exact:true}).click();
  assert.equal(await page.locator('.deck-group').count(),countBeforeClose-1);
  assert.equal(await page.evaluate(()=>messages.some(m=>m.op==='stop')),false,'closing a pane never stops its terminal processes');
  // Closing a pending split must not resurrect it when the service replies.
  const late=await split('down');
  await page.locator('.deck-group[data-group-id="'+late.group+'"] [aria-label="Pane actions"]').click();
  await page.getByRole('button',{name:'Close pane',exact:true}).click();
  const countAfterClose=await page.locator('.deck-group').count();
  await page.evaluate(id=>workspaceDeck.receive([{event:'session',session:{id,cwd:'/tmp/nested-workspace',title:'Late shell',kind:'shell',running:true}}]),late.start.id);
  assert.equal(await page.locator('.deck-group').count(),countAfterClose);
  assert.equal(await page.evaluate(id=>state.workspaceDeck.layouts.p.groups.some(g=>g.tabs.includes('terminal:'+id)),late.start.id),false,'closed pending panes stay closed');
  await page.evaluate(()=>go('sessions'));
  assert.equal(await page.locator('[data-action="deck-open"][data-id="'+late.start.id+'"]').count(),1,'late shell remains available in Session history');
  const persisted=await page.evaluate(()=>{persist();return JSON.parse(JSON.stringify(state.workspaceDeck.layouts.p))});
  await page.reload();await page.evaluate(()=>{state.firstRun={done:true};showWorkspace();go('p')});
  assert.equal(await page.evaluate(()=>messages.some(m=>m.op==='start')),false,'restoring a layout does not create processes');
  const restored=await page.evaluate(()=>state.workspaceDeck.layouts.p);
  assert.deepEqual(restored,persisted,'split tree, leaf order, tabs and selection survive reload');
  assert.equal(await page.locator('.deck-group').count(),persisted.groups.length);
  assert.deepEqual(errors,[]);
  console.log('PASS: nested splits in both axes, shortcuts, pending shell identity, focus stability, separators, iframe persistence, move/close lifecycle, and restore without process creation.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
async function geometry(page){return page.locator('.deck-group:visible').evaluateAll(nodes=>nodes.map(el=>{const r=el.getBoundingClientRect();return {id:el.dataset.groupId,x:r.x,y:r.y,width:r.width,height:r.height}}))}
async function iframeNonce(page){
 return page.evaluate(()=>new Promise((resolve,reject)=>{
  const frame=document.querySelector('.deck-preview iframe'),deadline=setTimeout(()=>{clearInterval(timer);removeEventListener('message',receive);reject(Error('Preview did not respond'))},3000);
  function receive(event){if(event.source===frame.contentWindow&&event.data?.type==='workspace-pong'){clearTimeout(deadline);clearInterval(timer);removeEventListener('message',receive);resolve(event.data.nonce)}}
  addEventListener('message',receive);const timer=setInterval(()=>frame.contentWindow.postMessage('workspace-ping','*'),25);frame.contentWindow.postMessage('workspace-ping','*');
 }));
}
