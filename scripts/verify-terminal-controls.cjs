const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const fs=require('node:fs');
const shots=process.env.TASKTAP_SCREENSHOTS||'output';fs.mkdirSync(shots,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:820}}),errors=[];
  page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{window.messages=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>messages.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.evaluate(async()=>{
   state.firstRun={done:true};state.projects=[{id:'p',folder:'/tmp/terminal-controls',name:'Terminal controls',aliases:[]}];state.sessions=[];state.captures=[];state.decisions=[];state.notes=[];
   Object.assign(state.workspaceDeck,{layouts:{},media:{},terminalFontSizes:{},preferences:{shell:'default',followGhostty:true,appearanceVersion:1}});
   await workspaceDeck.receive([{event:'sessions',sessions:['left','right'].map(id=>({id,cwd:'/tmp/terminal-controls',title:id+' terminal',kind:'shell',running:true}))}]);
   showWorkspace();workspaceDeck.open('terminal:left','p');
   const l=state.workspaceDeck.layouts.p,second=workspaceLayout.split(l,l.groups[0].id,'x','right-pane');
   l.groups[0].tabs=['terminal:left'];l.groups[0].active='terminal:left';second.tabs=['terminal:right'];second.active='terminal:right';
   workspaceDeck.appearanceLoaded({source:'Ghostty',fontFamilies:['Menlo'],fontSize:14,padding:[8,8,8,8]});
   showWorkspace();go('p');
   for(const id of ['left','right'])await workspaceDeck.receive([{event:'replay',id,seq:0,cols:80,rows:24,data:btoa(Array.from({length:120},(_,i)=>id+' line '+i+'\r\n').join(''))}]);
  });
  const tab=id=>page.locator('.deck-tab[data-id="terminal:'+id+'"]');
  const metrics=id=>page.evaluate(id=>workspaceDeck.terminalMetrics(id),id);
  const size=async(id,expected)=>{
   await page.waitForFunction(({id,expected})=>workspaceDeck.terminalMetrics(id)?.fontSize===expected,{id,expected});
  };
  await tab('left').click();
  await page.waitForFunction(()=>document.activeElement?.classList.contains('xterm-helper-textarea'));
  const initial=await metrics('left');
  await page.keyboard.press('Meta+=');await size('left',15);await size('right',14);
  await page.keyboard.press('Meta+Shift+=');await size('left',16);
  await page.waitForFunction(initial=>{const m=workspaceDeck.terminalMetrics('left');return m.cols<initial.cols&&m.rows<initial.rows},initial);
  assert.deepEqual(await page.evaluate(()=>state.workspaceDeck.preferences),{shell:'default',followGhostty:true,appearanceVersion:1},'shortcuts leave the global default unchanged');
  await tab('right').click();await page.keyboard.press('Meta+-');await size('right',13);await size('left',16);
  await page.keyboard.press('Meta+0');await size('right',14);
  assert.equal(await page.evaluate(()=>Object.hasOwn(state.workspaceDeck.terminalFontSizes,'right')),false,'reset removes the per-terminal override');
  assert.equal(await page.evaluate(()=>messages.some(m=>m.op==='input')),false,'text-size keys never reach the PTY');
  assert.equal(await page.evaluate(()=>visualViewport.scale),1,'text-size keys do not zoom the workspace');
  await page.screenshot({path:path.join(shots,'terminal-controls-split.png')});
  // The same controls are reachable from the tab menu without touching other panes.
  await tab('right').click({button:'right'});
  await page.locator('.deck-tab-menu[open] [data-action="deck-text-increase"]').click();await size('right',15);await size('left',16);
  assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('xterm-helper-textarea')),true,'menu control returns typing focus');
  await page.evaluate(()=>workspaceDeck.appearanceLoaded({source:'Ghostty',fontFamilies:['Menlo'],fontSize:18,padding:[8,8,8,8]}));
  await size('left',16);await size('right',15);
  await page.keyboard.press('Meta+0');await size('right',18);
  await page.evaluate(()=>{state.workspaceDeck.preferences.font=20;document.dispatchEvent(new Event('appearance-changed'))});
  await size('left',16);await size('right',20);
  await page.keyboard.press('Meta+-');await size('right',19);
  await tab('right').click({button:'right'});
  await page.locator('.deck-tab-menu[open] [data-action="deck-text-decrease"]').click();await size('right',18);
  await tab('right').click({button:'right'});
  await page.locator('.deck-tab-menu[open] [data-action="deck-text-reset"]').click();await size('right',20);
  await tab('left').click();
  for(let i=0;i<40;i++)await page.keyboard.press('Meta+=');await size('left',40);
  for(let i=0;i<40;i++)await page.keyboard.press('Meta+-');await size('left',8);
  await page.keyboard.press('Meta+0');await size('left',20);
  await page.keyboard.press('Meta+=');await size('left',21);
  // Dialog inputs and modified chords must keep their ordinary keyboard behavior.
  await page.evaluate(()=>workspaceDeck.preferences());
  await page.keyboard.press('Meta+=');await size('left',21);
  await page.evaluate(()=>dismissCard());await tab('left').click();
  await page.keyboard.press('Meta+Alt+=');await size('left',21);
  // Moving a terminal and recreating its engine retain that terminal's size.
  await tab('left').click({button:'right'});
  await page.locator('.deck-tab-menu[open] [data-action="deck-move"]').click();
  await page.locator('[data-action="deck-move-to"][data-id="right-pane"]').click();
  await size('left',21);await size('right',20);
  await page.reload();await page.evaluate(()=>{state.firstRun={done:true};showWorkspace();go('p')});
  await size('left',21);
  await tab('right').click();await size('right',20);
  assert.equal(await page.evaluate(()=>messages.some(m=>m.op==='start')),false,'reload never starts a replacement process');
  await page.evaluate(()=>workspaceDeck.closeWorkspace('p'));
  await page.evaluate(()=>workspaceDeck.openWorkspace('p'));await size('right',20);
  await tab('left').click();await size('left',21);
  // Scrollback still works with an invisible track and a slim, draggable thumb.
  await page.evaluate(async()=>{
   await workspaceDeck.receive([{event:'replay',id:'left',seq:0,cols:80,rows:24,data:btoa(Array.from({length:200},(_,i)=>'Scrollback line '+i+'\r\n').join(''))}]);
  });
  const terminal=page.locator('.deck-group.selected .deck-terminal:not([hidden])');
  const track=terminal.locator('.scrollbar.vertical'),thumb=track.locator('.slider');
  await page.mouse.move(1,1);
  await page.waitForFunction(()=>!document.querySelector('.deck-group.selected .deck-terminal:not([hidden])')?.classList.contains('is-scrolling'));
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.deck-group.selected .deck-terminal:not([hidden]) .scrollbar.vertical>.slider')).opacity==='0');
  const trackBox=await track.boundingBox();
  // Enter the terminal first so xterm reveals its scrollbar hit target.
  await page.mouse.move(trackBox.x-20,trackBox.y+trackBox.height/2);
  await track.evaluate(el=>new Promise(done=>requestAnimationFrame(done)));
  await page.mouse.move(trackBox.x+trackBox.width-3,trackBox.y+trackBox.height/2);
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.deck-group.selected .deck-terminal:not([hidden]) .scrollbar.vertical>.slider')).opacity==='1');
  const thumbBox=await thumb.boundingBox();assert.equal(thumbBox.width,4,'visible thumb is four pixels wide');
  assert.ok(trackBox.width>=10,'drag target remains wider than the visual thumb');
  assert.equal(await track.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)','scrollbar track stays transparent');
  const before=(await metrics('left')).firstLine;
  await page.mouse.move(thumbBox.x+2,thumbBox.y+thumbBox.height/2);await page.mouse.down();
  await page.mouse.move(thumbBox.x+2,trackBox.y+10,{steps:8});await page.mouse.up();
  await page.waitForFunction(before=>workspaceDeck.terminalMetrics('left').firstLine!==before,before);
  await page.mouse.move(trackBox.x-60,trackBox.y+trackBox.height/2);await page.mouse.wheel(0,300);
  await page.waitForFunction(()=>document.querySelector('.deck-group.selected .deck-terminal:not([hidden])')?.classList.contains('is-scrolling'));
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await thumb.evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
  await page.screenshot({path:path.join(shots,'terminal-controls.png')});
  assert.deepEqual(errors,[]);
  console.log('PASS: per-terminal size shortcuts/menu, reset/defaults, limits, PTY isolation, move/restore, scrollbar fade/hover/drag, scrollback and reduced motion.');
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
