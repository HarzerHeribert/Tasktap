const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{window.messages=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>messages.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.evaluate(async()=>{
   const NativeTerminal=Terminal;window.Terminal=function(...args){window.testTerm=new NativeTerminal(...args);return testTerm};
   state.firstRun={done:true};state.projects=[{id:'p',folder:'/tmp/protocol',name:'Protocol',aliases:[]}];state.sessions=[];state.decisions=[];
   await workspaceDeck.receive([{event:'sessions',sessions:[{id:'pty',cwd:'/tmp/protocol',title:'Terminal',kind:'shell',running:true}]}]);
   showWorkspace();workspaceDeck.open('terminal:pty','p');
  });
  const queries='\x1b[5n\x1b[6n\x1b[?6n\x1b[c\x1b[>c\x1b]10;?\x07\x1b]11;?\x1b\\\x1b]12;?\x07\x1b]4;2;?\x07\x1b]4;2;#123456;3;?\x07\x1b[?1000$p\x1bP$qm\x1b\\\x1b[?1004h';
  await page.evaluate(async queries=>{messages=[];await workspaceDeck.receive([{event:'replay',id:'pty',seq:1,cols:90,rows:30,data:btoa('History before CLI\r\n'+queries+'History after CLI\r\n$ ')}])},queries);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.op==='input').length),0,'historical queries must never write protocol replies into the live shell');
  assert.match(await page.evaluate(()=>workspaceDeck.terminalText('pty')),/History before CLI/);
  assert.match(await page.evaluate(()=>workspaceDeck.terminalText('pty')),/History after CLI/);
  await page.evaluate(async queries=>{messages=[];await workspaceDeck.receive([{event:'output',id:'pty',seq:2,data:btoa(queries)}])},queries);
  const replies=await page.evaluate(()=>messages.filter(m=>m.op==='input').map(m=>atob(m.data)).join(''));
  assert.match(replies,/\x1b\[[0-9]+;[0-9]+R/,'live cursor reports still reach the CLI');
  assert.match(replies,/\x1b\[\?1;2c/,'live device attributes still reach the CLI');
  assert.match(replies,/rgb:/,'live color reports still reach the CLI');
  assert.match(replies,/4;2;rgb:1212\/3434\/5656/,'replay preserves color setters in mixed set/query batches');
  const area=page.locator('.deck-terminal:not([hidden]) .xterm-helper-textarea');
  await area.focus();await page.evaluate(()=>messages=[]);await page.keyboard.type('genuine input');
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.op==='input').map(m=>atob(m.data)).join('')),'genuine input');
  // Reconnect while the terminal is visible: old queries remain display-only.
  await page.evaluate(async queries=>{messages=[];await workspaceDeck.receive([{event:'replay',id:'pty',seq:3,cols:90,rows:30,data:btoa(queries+'Reconnected shell\r\n')}])},queries);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.op==='input').length),0);
  await page.evaluate(async queries=>{
   messages=[];
   const replay=workspaceDeck.receive([{event:'replay',id:'pty',seq:4,cols:90,rows:30,data:btoa('Preserved history\r\n'+queries)}]);
   testTerm.input('real typing\x1b[1;2R',true);
   await replay;
  },queries);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.op==='input').map(m=>atob(m.data)).join('')),'real typing\x1b[1;2R','actual input queued during replay survives byte-for-byte, including reply-shaped text');
  assert.equal(await area.evaluate(el=>getComputedStyle(el).outlineStyle),'none','the hidden input must not paint a pane-sized focus ring');
  await page.evaluate(async queries=>{
   messages=[];await workspaceDeck.receive([
    {event:'replay',id:'pty',seq:5,cols:90,rows:30,data:btoa('Preserved history\r\n'+queries)},
    {event:'output',id:'pty',seq:6,data:btoa(queries)},
    {event:'replay',id:'pty',seq:6,cols:90,rows:30,data:btoa('Preserved history\r\n'+queries)}
   ]);
  },queries);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.op==='input').map(m=>atob(m.data)).join('').split('\x1b[?1;2c').length-1),1,'a live handshake directly following replay in the same batch is answered exactly once');
  await page.evaluate(()=>workspaceDeck.receive([{event:'output',id:'pty',seq:7,data:btoa('\x1b[?1049h\x1b[?1003;1006;1004;2004h\x1b[?25lStuck CLI')}]))
  assert.equal(await page.evaluate(()=>testTerm.modes.mouseTrackingMode),'any');
  assert.equal(await page.evaluate(()=>testTerm.modes.bracketedPasteMode),true);
  await page.locator('.deck-tab[aria-selected="true"]').click({button:'right'});
  await page.evaluate(()=>messages=[]);
  await page.getByRole('button',{name:'Release mouse capture',exact:true}).click();
  await page.waitForFunction(()=>testTerm.modes.mouseTrackingMode==='none'&&testTerm.buffer.active.type==='normal');
  assert.equal(await page.evaluate(()=>testTerm.modes.bracketedPasteMode),false);
  assert.match(await page.evaluate(()=>workspaceDeck.terminalText('pty')),/Preserved history/,'recovery preserves normal scrollback');
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.op==='input').length),0,'release does not send commands or characters to the CLI');
  for(const selector of ['.xterm-screen','.xterm-scrollable-element','canvas']){
   if(!await page.locator('.deck-terminal:not([hidden]) '+selector).count())continue;
   await page.locator('.deck-terminal:not([hidden]) '+selector).first().evaluate(el=>{el.tabIndex=0;el.focus()});
   assert.equal(await page.locator('.deck-terminal:not([hidden]) '+selector).first().evaluate(el=>getComputedStyle(el).outlineStyle),'none','terminal rendering surfaces do not paint focus rectangles');
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: replayed cursor/device/color/mode/status queries are display-only, live handshakes and typing survive, reconnect stays clean and terminal input has no focus frame.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
