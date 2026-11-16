const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const shots=process.env.TASKTAP_SCREENSHOTS||'output';
require('node:fs').mkdirSync(shots,{recursive:true});

(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{window.messages=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>messages.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.evaluate(async()=>{
   state.firstRun={done:true};state.projects=[{id:'p',folder:'/tmp/drag-workspace',name:'Drag workspace',aliases:[]}];state.sessions=[];state.captures=[];state.decisions=[];
   Object.assign(state.workspaceDeck,{layouts:{},media:{},sidebarHidden:false});
   await workspaceDeck.receive([{event:'sessions',sessions:[{id:'shell',cwd:'/tmp/drag-workspace',kind:'shell',title:'Original shell',running:true}]}]);
   showWorkspace();workspaceDeck.open('terminal:shell','p');
   await workspaceDeck.receive([{event:'replay',id:'shell',seq:0,cols:100,rows:30,data:btoa('Keep this buffer\r\n')}]);
   workspaceDeck.addFiles('p',[{id:'web',kind:'web',title:'Live preview',url:'data:text/html,'+encodeURIComponent('<html><body>Live preview<script>const nonce=Math.random();addEventListener("message",e=>{if(e.data==="ping")e.source.postMessage({nonce},"*")})<\/script></body></html>')},{id:'notes',kind:'text',title:'Notes',url:''}]);
   workspaceDeck.textLoaded('notes','Keep this document');
   window.originalTerminal=document.querySelector('.deck-terminal');window.originalPreview=document.querySelector('.deck-preview iframe');
  });
  const original=await owner('terminal:shell');
  const nonce=await previewNonce();
  // Reorder inactive tabs in either direction, without a trailing click undoing selection.
  await drag('terminal:shell',()=>tabPoint('media:notes',.9));
  assert.deepEqual(await tabs(original),['media:web','media:notes','terminal:shell']);
  assert.equal(await active(original),'terminal:shell');
  await drag('terminal:shell',()=>tabPoint('media:web',.1));
  assert.deepEqual(await tabs(original),['terminal:shell','media:web','media:notes']);
  // A click and a small hand movement still select the tab normally.
  await tab('media:notes').click();assert.equal(await active(original),'media:notes');
  const small=await tabPoint('media:web');await page.mouse.move(small.x,small.y);await page.mouse.down();await page.mouse.move(small.x+2,small.y+1);await page.mouse.up();
  assert.equal(await active(original),'media:web');assert.equal(await page.locator('.deck-drag-overlay').count(),0);
  // Move a preview out into its own split. No new shell is launched.
  await drag('media:web',()=>surfacePoint(original,'right'));
  const right=await owner('media:web');assert.notEqual(right,original);
  assert.equal(await previewNonce(),nonce,'splitting a web preview keeps its live document');
  assert.equal(await page.evaluate(()=>state.workspaceDeck.layouts.p.tree.axis),'x');
  // Cross a sandboxed iframe and drop into its center to join tabs.
  await drag('terminal:shell',()=>surfacePoint(right));
  assert.equal(await owner('terminal:shell'),right);assert.equal(await active(right),'terminal:shell');
  assert.equal(await page.evaluate(()=>window.originalTerminal===document.querySelector('.deck-terminal')),true);
  assert.match(await page.evaluate(()=>workspaceDeck.terminalText('shell')),/Keep this buffer/);
  // Insert before a chosen tab on another surface; collapse the empty source.
  await drag('media:notes',()=>tabPoint('media:web',.1));
  assert.deepEqual(await tabs(right),['media:notes','media:web','terminal:shell']);
  assert.equal(await page.locator('.deck-group').count(),1);
  // All edge placements work, including inserting before the target leaf.
  for(const edge of ['left','top','bottom','right']){
   await drag('media:notes',()=>surfacePoint(right,edge));
   const split=await owner('media:notes');assert.notEqual(split,right);
   const geometry=await page.evaluate(()=>state.workspaceDeck.layouts.p.tree);
   assert.equal(geometry.axis,['left','right'].includes(edge)?'x':'y');
   assert.equal(geometry[['left','top'].includes(edge)?'first':'second'].group,split);
   await drag('media:notes',()=>surfacePoint(right));
   assert.equal(await page.locator('.deck-group').count(),1);
  }
  await tab('media:web').click();assert.equal(await previewNonce(),nonce);
  // Escape, an outside drop, and pointer cancellation leave ownership unchanged.
  for(const cancel of ['escape','outside','pointercancel']){
   const before=await page.evaluate(()=>JSON.stringify(state.workspaceDeck.layouts.p));
   const start=await tabPoint('media:notes'),end=await surfacePoint(right,'left');
   await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:12});
   assert.equal(await page.locator('.deck-drop-marker:visible').count(),1);
   if(cancel==='escape')await page.keyboard.press('Escape');
   if(cancel==='outside')await page.mouse.move(10,10,{steps:6});
   if(cancel==='pointercancel')await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointercancel')));
   await page.mouse.up();
   assert.equal(await page.locator('.deck-drag-overlay').count(),0);
   assert.equal(await page.evaluate(()=>JSON.stringify(state.workspaceDeck.layouts.p)),before,cancel+' does not change the layout');
  }
  // The last tab cannot be split away from its own surface into an empty sibling.
  await drag('media:notes',()=>surfacePoint(right,'right'));
  const lone=await owner('media:notes'),beforeLone=await page.evaluate(()=>JSON.stringify(state.workspaceDeck.layouts.p));
  await drag('media:notes',()=>surfacePoint(lone,'left'),false);
  assert.equal(await page.evaluate(()=>JSON.stringify(state.workspaceDeck.layouts.p)),beforeLone);
  // Pending launch ownership follows the tab, even if the original surface collapses.
  await page.locator('.deck-group[data-group-id="'+lone+'"] [data-action="deck-terminal"]').click();
  const pending=await page.evaluate(()=>messages.filter(m=>m.op==='start').at(-1).id);
  await drag('terminal:'+pending,()=>surfacePoint(right));
  await drag('media:notes',()=>surfacePoint(right));
  await page.evaluate(id=>workspaceDeck.receive([{event:'session',session:{id,cwd:'/tmp/drag-workspace',kind:'shell',title:'Late terminal',running:true}}]),pending);
  assert.equal(await owner('terminal:'+pending),right);
  assert.equal(await page.locator('.deck-tab[data-id="terminal:'+pending+'"]').count(),1,'late replies never duplicate a moved pending tab');
  assert.equal(await page.locator('.deck-group').count(),1);
  assert.equal(await active(right),'media:notes','late launch does not steal selection');
  const operations=await page.evaluate(()=>messages.filter(m=>['start','stop','detach'].includes(m.op)).map(m=>m.op));
  assert.deepEqual(operations,['start'],'only the explicitly requested terminal creates a process; drags do not detach or stop it');
  await tab('media:web').click();assert.equal(await previewNonce(),nonce);
  const persisted=await page.evaluate(()=>{persist();return JSON.parse(JSON.stringify(state.workspaceDeck.layouts.p))});
  await page.reload();await page.evaluate(()=>{state.firstRun={done:true};showWorkspace();go('p')});
  assert.deepEqual(await page.evaluate(()=>state.workspaceDeck.layouts.p),persisted,'tab order and geometry persist');
  assert.deepEqual(errors,[]);
  console.log('PASS: real pointer tab reordering, cross-surface moves over iframes, all four split edges, cancellation, small clicks, pending launch ownership, live view identity and persisted layout.');

  function tab(key){return page.locator('.deck-tab[data-id="'+key+'"]')}
  async function owner(key){return page.evaluate(key=>state.workspaceDeck.layouts.p.groups.find(g=>g.tabs.includes(key))?.id,key)}
  async function tabs(id){return page.evaluate(id=>state.workspaceDeck.layouts.p.groups.find(g=>g.id===id)?.tabs,id)}
  async function active(id){return page.evaluate(id=>state.workspaceDeck.layouts.p.groups.find(g=>g.id===id)?.active,id)}
  async function tabPoint(key,fraction=.5){const r=await tab(key).boundingBox();return {x:r.x+r.width*fraction,y:r.y+r.height/2}}
  async function surfacePoint(id,edge){const r=await page.locator('.deck-group[data-group-id="'+id+'"] .deck-surface').boundingBox();return {x:edge==='left'?r.x+10:edge==='right'?r.x+r.width-10:r.x+r.width/2,y:edge==='top'?r.y+10:edge==='bottom'?r.y+r.height-10:r.y+r.height/2}}
  async function drag(key,destination,marker=true){
   const start=await tabPoint(key),end=await destination();
   await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:15});
   assert.equal(await page.locator('.deck-drop-marker:visible').count(),marker?1:0);
   if(key==='media:web')await page.screenshot({path:path.join(shots,'workspace-drag.png')});
   await page.mouse.up();assert.equal(await page.locator('.deck-drag-overlay').count(),0);
  }
  async function previewNonce(){return page.evaluate(()=>new Promise((resolve,reject)=>{
   const frame=window.originalPreview,timeout=setTimeout(()=>{clearInterval(timer);removeEventListener('message',receive);reject(Error('Preview stopped responding'))},3000);
   function receive(e){if(e.source===frame.contentWindow&&e.data?.nonce){clearTimeout(timeout);clearInterval(timer);removeEventListener('message',receive);resolve(e.data.nonce)}}
   addEventListener('message',receive);const timer=setInterval(()=>frame.contentWindow.postMessage('ping','*'),25);
  }))}
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
