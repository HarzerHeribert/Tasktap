const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{window.tasktapSurface='workspace';window.messages=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>messages.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.evaluate(async()=>{
   state.firstRun={done:true};state.projects=[{id:'typing',folder:'/tmp/tasktap-input-fixture',name:'Typing fixture',aliases:[]}];state.sessions=[];state.decisions=[];
   await workspaceDeck.receive([{event:'sessions',sessions:[{id:'input-fixture',cwd:'/tmp/tasktap-input-fixture',title:'Typing fixture',kind:'shell',running:true}]}]);
   showWorkspace();workspaceDeck.open('terminal:input-fixture','typing');
   await workspaceDeck.receive([{event:'replay',id:'input-fixture',seq:0,cols:100,rows:30,data:''}]);messages=[];
  });
  const area=page.locator('.deck-terminal:not([hidden]) .xterm-helper-textarea').first();
  const data=()=>page.evaluate(()=>messages.filter(m=>m.type==='workspace-terminal'&&m.op==='input').map(m=>atob(m.data)).join(''));
  const reset=()=>page.evaluate(()=>messages=[]);
  const settle=()=>page.waitForTimeout(30);
  await area.focus();const typed='good find out that when I type my prompt bar is gettg';
  await page.keyboard.type(typed);assert.equal(await data(),typed,'ordinary physical typing arrives exactly once');
  assert.equal(await area.inputValue(),typed,'accessibility input mirror is preserved');
  for(const replacement of ['getting','getTx','g']){
   await reset();
   await area.evaluate((el,replacement)=>{
    el.dispatchEvent(new KeyboardEvent('keydown',{key:'Process',keyCode:229,bubbles:true,cancelable:true}));
    el.value=el.value.replace('gettg',replacement);el.setSelectionRange(el.value.length,el.value.length);
   },replacement);
   await settle();assert.equal(await data(),'','correction never replays or edits a shell command');
   assert.equal(await area.inputValue(),typed,'rejected correction restores only the hidden input field');
  }
  assert.match(await page.locator('#toast').innerText(),/correction skipped/);
  await reset();
  await area.evaluate(el=>{
   const e=new InputEvent('beforeinput',{inputType:'insertReplacementText',data:'getting',bubbles:true,cancelable:true});
   el.dispatchEvent(e);window.replacementPrevented=e.defaultPrevented;
  });
  assert.ok(await page.evaluate(()=>replacementPrevented));assert.equal(await data(),'');
  await reset();
  await area.evaluate(el=>{
   el.dispatchEvent(new KeyboardEvent('keydown',{key:'Process',keyCode:229,bubbles:true,cancelable:true}));
   el.value+='!';el.dispatchEvent(new InputEvent('input',{data:'!',inputType:'insertText',bubbles:true}));
  });
  await settle();assert.equal(await data(),'!','new non-composing 229 text is delivered once');
  await reset();
  await area.evaluate(el=>{
   for(const char of ['1','2']){
    el.dispatchEvent(new KeyboardEvent('keydown',{key:'Process',keyCode:229,bubbles:true,cancelable:true}));
    el.value+=char;el.setSelectionRange(el.value.length,el.value.length);
   }
  });
  await settle();assert.equal(await data(),'12','rapid fallback keydowns do not replay or drop text');
  await reset();
  await area.evaluate(async el=>{
   el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
   el.dispatchEvent(new KeyboardEvent('keydown',{key:'Process',keyCode:229,isComposing:true,bubbles:true,cancelable:true}));
   el.value+='日本';
   el.dispatchEvent(new CompositionEvent('compositionupdate',{data:'日本',bubbles:true}));
   await new Promise(resolve=>setTimeout(resolve,0));
   el.dispatchEvent(new CompositionEvent('compositionend',{data:'日本',bubbles:true}));
  });
  await settle();assert.equal(Buffer.from(await data(),'binary').toString('utf8'),'日本','genuine IME commits stay with xterm and arrive once');
  await page.keyboard.type('Z');assert.ok((await data()).endsWith('Z'));
  await reset();
  const openComposer=()=>page.evaluate(()=>workspaceCommand('menu-pane-compose'));
  await openComposer();const editor=page.locator('#terminal-compose-text');
  assert.ok(await editor.isVisible());assert.equal(await editor.getAttribute('autocorrect'),'on');
  await editor.fill('Fix teh typo');assert.equal(await data(),'','composing does not send raw terminal input');
  await editor.evaluate(el=>{
   el.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertReplacementText',data:'the',bubbles:true,cancelable:true}));
   el.value='Fix the typo';el.dispatchEvent(new InputEvent('input',{inputType:'insertReplacementText',data:'the',bubbles:true}));
  });
  assert.match(await page.locator('#terminal-compose-change').innerText(),/Replaced “teh” with “the”/);
  fs.mkdirSync('output/terminal-input',{recursive:true});
  await page.screenshot({path:'output/terminal-input/composer.png'});
  assert.equal(await page.evaluate(()=>prepareForAppUpdate()),false,'updates wait for unfinished composed text');
  await page.getByRole('button',{name:'Undo correction',exact:true}).click();assert.equal(await editor.inputValue(),'Fix teh typo');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await openComposer();
  assert.equal(await editor.inputValue(),'Fix teh typo','cancelled drafts remain attached to their terminal');
  await editor.fill('First line\nsecond line');await page.getByRole('button',{name:'Insert text',exact:true}).click();
  assert.equal(await data(),'','unprotected multiline paste cannot execute shell commands');
  assert.match(await page.locator('#terminal-compose-error').innerText(),/one line/);
  await editor.fill('x'.repeat(65000));await page.getByRole('button',{name:'Insert text',exact:true}).click();
  assert.equal(await data(),'');assert.match(await page.locator('#terminal-compose-error').innerText(),/too large/);
  await editor.fill('bad\x1bcommand');await page.getByRole('button',{name:'Insert text',exact:true}).click();
  assert.equal(await data(),'');assert.match(await page.locator('#terminal-compose-error').innerText(),/control characters/);
  await editor.fill('Fix the typo');await page.getByRole('button',{name:'Insert text',exact:true}).click();
  assert.equal(await data(),'Fix the typo','insert uses one paste and never sends Enter');
  await reset();
  await page.evaluate(()=>workspaceDeck.receive([{event:'output',id:'input-fixture',seq:1,data:btoa('\x1b[?2004h')}]))
  await openComposer();await editor.fill('First line\nsecond line');await page.getByRole('button',{name:'Insert text',exact:true}).click();
  assert.equal(await data(),'\x1b[200~First line\rsecond line\x1b[201~','protected multiline paste is bracketed without a submit key');
  await reset();await openComposer();await editor.fill('Retain this draft');
  await page.evaluate(()=>workspaceDeck.receive([{event:'disconnected',error:'Fixture disconnected'}]));
  await page.getByRole('button',{name:'Insert text',exact:true}).click();assert.equal(await data(),'');
  assert.match(await page.locator('#terminal-compose-error').innerText(),/unavailable/);
  assert.deepEqual(errors,[]);
  console.log('PASS: physical typing once; replacement/replay blocked; 229 additions and genuine IME preserved; correction notice/undo; per-terminal drafts; no Enter or unsafe multiline; disconnected destination blocked.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
