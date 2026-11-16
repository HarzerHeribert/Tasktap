const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:820}});page.setDefaultTimeout(5000);
  await page.addInitScript(()=>{window.messages=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>messages.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.evaluate(async()=>{
   state.firstRun={done:true};state.projects=[{id:'p',folder:'/tmp/viewport-fixture',name:'Viewport fixture',aliases:[]}];state.sessions=[];state.captures=[];state.decisions=[];
   Object.assign(state.workspaceDeck,{layouts:{},media:{},sidebarHidden:false,preferences:{shell:'default',followGhostty:true}});
   await workspaceDeck.receive([{event:'sessions',sessions:[{id:'grid',cwd:'/tmp/viewport-fixture',title:'Full-screen fixture',kind:'shell',running:true}]}]);
   showWorkspace();workspaceDeck.open('terminal:grid','p');
   await workspaceDeck.receive([{event:'replay',id:'grid',seq:0,cols:80,rows:24,data:''}]);
   window.gridSequence=0;
  });
  async function check(label){
   // Wait until ResizeObserver's fit and xterm's renderer agree. Fill the last
   // row advertised to the PTY, rather than a conveniently short transcript.
   await page.waitForTimeout(150);
   const size=await page.evaluate(()=>messages.filter(m=>m.op==='resize'&&m.id==='grid').at(-1));
   assert.ok(size,label+' sends PTY dimensions');
   await page.evaluate(async size=>{const content='\x1b[?1049h\x1b[2J\x1b[1;1HVIEWPORT '+size.rows+'x'+size.cols+'\x1b['+size.rows+';1HBOTTOM\x1b['+size.rows+';'+(size.cols-3)+'HEDGE';await workspaceDeck.receive([{event:'output',id:'grid',seq:++window.gridSequence,data:btoa(content)}])},size);
   await page.waitForTimeout(50);
   const m=await page.evaluate(()=>workspaceDeck.terminalMetrics('grid'));
   assert.equal(m.rows,size.rows,label+' renderer rows match PTY');assert.equal(m.cols,size.cols,label+' renderer columns match PTY');
   assert.match(m.lastLine,/^BOTTOM.*EDGE$/,label+' final row is in the terminal buffer');
   assert.ok(m.screen.bottom<=m.content.bottom+.5,`${label}: bottom row is clipped: ${JSON.stringify(m)}`);
   assert.ok(m.screen.right<=m.content.right+.5,`${label}: final columns are clipped: ${JSON.stringify(m)}`);
   assert.ok(m.screen.top>=m.content.top-.5&&m.screen.left>=m.content.left-.5,label+' preserves top/left padding');
   assert.ok(m.content.bottom<=m.pane.bottom+.5&&m.content.right<=m.pane.right+.5,label+' terminal content stays within its pane');
   assert.ok(m.pane.bottom<=m.viewport.height+.5&&m.pane.right<=m.viewport.width+.5,label+' pane stays within the window viewport');
  }
  await check('initial');
  for(const [fontSize,padding] of [[14,[12,12,12,12]],[19,[24,18,30,28]],[11,[0,0,0,0]]]){
   await page.evaluate(({fontSize,padding})=>workspaceDeck.appearanceLoaded({source:'Ghostty',fontFamilies:['Menlo'],fontSize,padding}),{fontSize,padding});
   await check('font '+fontSize+' padding '+padding.join('/'));
  }
  await page.setViewportSize({width:882,height:617});await check('resized window');
  await page.evaluate(()=>{const l=state.workspaceDeck.layouts.p;workspaceLayout.split(l,l.groups[0].id,'y','lower');l.selected=0;render()});await check('horizontal split');
  await page.evaluate(()=>{const l=state.workspaceDeck.layouts.p;workspaceLayout.split(l,l.groups[0].id,'x','right');l.selected=0;render()});await check('nested vertical split');
  await page.evaluate(()=>workspaceDeck.appearanceLoaded({source:'Ghostty',fontFamilies:['Menlo'],fontSize:16,padding:[12,20,24,8]}));await check('nested font/padding change');
  await page.locator('.deck-tab[data-id="terminal:grid"]').click();
  await page.keyboard.press('Meta+=');await check('selected terminal text enlarged');
  await page.keyboard.press('Meta+-');await check('selected terminal text reduced');
  await page.keyboard.press('Meta+0');await check('selected terminal text reset');
  await page.locator('.deck-tools [data-action="deck-focus"]').click();await check('focused pane');
  await page.locator('.deck-tools [data-action="deck-focus"]').click();await check('restored splits');
  await page.evaluate(()=>{state.decisions=[{id:'decision',session:'grid',q:'A decision reduces the terminal viewport.',choices:['Continue']}];render()});await check('decision banner');
  console.log('Terminal viewport passed: last row and final columns visible with PTY-matching geometry across padding, fonts, window resizing, nested splits, focus and decisions.');
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
