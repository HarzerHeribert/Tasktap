// Native bridge fixtures exercise capture identity and the real context controls, without app access.
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:800},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{window.messages=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>messages.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.evaluate(()=>{
   state.firstRun={done:true};state.useScreenContext=true;state.projects=[{id:'p',folder:'/fixture/project',name:'Fixture',aliases:[]}];showWorkspace();
   routingPrompt=()=>dialog('Review captured reference','Fixture',captureContext.review(draft,{editable:true})+button('Done','close'));
   captureDraft('','p');draft.text=draft.brief='Explain this website';
   captureContext.resolve(draft,routingPrompt);
  });
  const lookup=()=>page.evaluate(()=>messages.findLast(m=>m.type==='context-resolve'));
  const first=await lookup();assert.equal(first.refresh,false);
  const original='https://example.test/original?selected='+('a'.repeat(200));
  await page.evaluate(({id,value})=>captureContext.receive(id,{kind:'website',value,app:'Fixture browser',sourceID:'test.fixture:123',observedAt:new Date().toISOString(),origin:'capture',freshness:'changed'}),{id:first.request,value:original});
  assert.equal(await page.evaluate(()=>draft.reference.value),original);
  assert.match(await page.locator('#capture-reference').innerText(),/source has changed.*keeps the reference captured earlier/is);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='context-resolve').length),1,'displaying a changed source does not refresh it');
  for(const [width,zoom] of [[1100,1],[360,1],[720,2]]){
   await page.setViewportSize({width,height:820});await page.evaluate(zoom=>document.documentElement.style.zoom=zoom,zoom);
   assert.ok(await page.locator('#capture-reference').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'long reference wraps at narrow and 200% widths');
   for(const name of ['Change reference','Refresh source','Remove reference']){
    const button=page.getByRole('button',{name,exact:true});await button.scrollIntoViewIfNeeded();
    assert.ok(await button.evaluate(el=>{const r=el.getBoundingClientRect();return r.width>20&&r.height>20&&r.left>=0&&r.right<=innerWidth+1}),name+' stays readable and reachable');
   }
  }
  await page.evaluate(()=>document.documentElement.style.zoom=1);await page.setViewportSize({width:1100,height:800});
  await page.getByRole('button',{name:'Refresh source',exact:true}).click();
  const refresh=await lookup();assert.equal(refresh.refresh,true);assert.equal(refresh.id,first.id);
  await page.evaluate(id=>captureContext.receive(id,{kind:'website',value:'https://example.test/changed',app:'Fixture browser',sourceID:'test.fixture:123',observedAt:new Date().toISOString(),origin:'refresh',freshness:'refreshed'}),refresh.request);
  assert.equal(await page.evaluate(()=>draft.reference.value),'https://example.test/changed');
  assert.match(await page.locator('#capture-reference').innerText(),/Refreshed at/);
  assert.equal(await page.evaluate(()=>draft.project),'p','explicit refresh preserves the reviewed destination');
  await page.getByRole('button',{name:'Change reference',exact:true}).click();
  await page.getByLabel('Website URL').fill('https://user:secret@example.test/manual');
  await page.getByRole('button',{name:'Use reference',exact:true}).click();
  assert.equal(await page.evaluate(()=>draft.reference.value),'https://example.test/manual');
  assert.equal(await page.getByRole('button',{name:'Refresh source',exact:true}).count(),0,'manual choices are not silently linked to the old source');
  assert.equal(await page.evaluate(()=>draft.project),'p');

  await page.evaluate(()=>{captureDraft('','p');draft.text='Explain this file';captureContext.resolve(draft,routingPrompt)});
  const denied=await lookup();
  await page.evaluate(id=>captureContext.receive(id,{permission:'automation',message:'No reference was available when capture started.'}),denied.request);
  await page.getByRole('button',{name:'Allow source app access',exact:true}).click();
  const permission=await lookup();assert.equal(permission.allowPermission,true);
  await page.evaluate(id=>captureContext.receive(id,{kind:'file',value:'/fixture/wrong.md'}),denied.request);
  assert.equal(await page.locator('#dialog-heading').innerText(),'Finding your reference','late replies cannot replace a later request');
  await page.getByRole('button',{name:'Enter reference',exact:true}).click();
  await page.getByRole('button',{name:'Read current source',exact:true}).click();
  const cancelled=await lookup();
  assert.equal(cancelled.refresh,true,'missing initial observation requires explicit read');
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.evaluate(id=>captureContext.receive(id,{kind:'file',value:'/fixture/stale.md'}),cancelled.request);
  assert.equal(await page.locator('#modal').isVisible(),false,'a dismissed lookup cannot reopen review');
  await page.evaluate(()=>editDraft());
  const editorTitle=await page.locator('#dialog-heading').innerText();
  await page.evaluate(id=>captureContext.receive(id,{kind:'file',value:'/fixture/stale.md'}),cancelled.request);
  assert.equal(await page.locator('#dialog-heading').innerText(),editorTitle,'a late reply cannot hijack a reopened editor for the same draft');
  assert.equal(await page.evaluate(()=>draft.reference),undefined);

  // The notch's draft is created only on Review; voice must capture context before microphone start.
  await page.evaluate(()=>{firstRun.visible=true;dialog('Composer fixture','', '<textarea id="guide-input"></textarea>');messages.length=0;startDictation('#guide-input','fixture','voice-fixture')});
  const voice=await page.evaluate(()=>messages.filter(m=>['context-begin','dictation-start'].includes(m.type)));
  assert.deepEqual(voice.map(m=>m.type),['context-begin','dictation-start']);
  await page.evaluate(()=>{dictationEvent('voice-fixture','recording','');dictationEvent('voice-fixture','text','Explain this website');captureDraft('','p',document.querySelector('#guide-input').value)});
  assert.equal(await page.evaluate(()=>draft.contextID),voice[0].id,'review adopts the snapshot from before speech');
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='context-begin').length),1,'review cannot replace the speaking snapshot');

  await page.evaluate(()=>{dialog('Composer fixture','', '<textarea id="guide-input"></textarea>');messages.length=0});
  await page.locator('#guide-input').pressSequentially('Explain this file');
  const typed=await page.evaluate(()=>messages.filter(m=>m.type==='context-begin'));
  assert.equal(typed.length,1,'typed capture freezes on first input, not every keystroke');
  await page.locator('#guide-input').fill('');
  await page.locator('#guide-input').pressSequentially('Explain this website');
  const restarted=await page.evaluate(()=>messages.filter(m=>m.type==='context-begin'));
  assert.equal(restarted.length,2,'clearing the composer starts a new capture on the next input');
  await page.evaluate(()=>captureDraft('','p',document.querySelector('#guide-input').value));
  assert.equal(await page.evaluate(()=>draft.contextID),restarted[1].id);
  await page.evaluate(()=>{state.useScreenContext=false;dialog('Composer fixture','', '<textarea id="guide-input"></textarea>');messages.length=0;startDictation('#guide-input','fixture','off');stopDictation()});
  assert.equal(await page.evaluate(()=>messages.some(m=>m.type==='context-begin')),false,'disabled context never starts native reading');
  assert.deepEqual(errors,[]);
  console.log('PASS: captured reference provenance, explicit refresh, stale-response isolation, narrow/200% controls, pre-speech and first-keystroke snapshots, and disabled-context privacy. Native bridge fixtures only.');
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
