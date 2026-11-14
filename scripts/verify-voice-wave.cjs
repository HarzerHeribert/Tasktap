// The bridge is stubbed here so deterministic meter values never require microphone access.
const {chromium}=require('playwright');
const {createHash}=require('node:crypto');
const path=require('node:path');
const assert=require('node:assert/strict');

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || undefined});
  try {
    const page=await browser.newPage({viewport:{width:850,height:720},reducedMotion:'no-preference'});
    await page.addInitScript(()=>{
      window.spriteDraws=0;
      const draw=CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage=function(source,...args){
        if(source instanceof HTMLImageElement && source.src.endsWith('/glyph/type.png'))window.spriteDraws++;
        return draw.call(this,source,...args);
      };
      window.messages=[];
      window.webkit={messageHandlers:{workspace:{postMessage:m=>window.messages.push(m)}}};
    });
    // Same-origin fixture assets let us compare the waveform pixels independently
    // of the OS pointer, focus rings, and compositor animations around the canvas.
    await page.route('https://tasktap.test/**',route=>{
      const relative=new URL(route.request().url()).pathname;
      return route.fulfill({path:path.join(__dirname,'../prototype',relative)});
    });
    await page.goto('https://tasktap.test/index.html#workspace');
    const mic=page.getByRole('button',{name:'Hold to talk',exact:true});
    const holdPointer=async()=>{
      await mic.hover();
      await page.mouse.down();
      await page.mouse.move(1,1);
      return page.evaluate(()=>recording.id);
    };
    const holdShortcut=async(id)=>{
      await page.evaluate(id=>workspaceCommand('hw-capture',id),id);
      await page.waitForFunction(id=>recording?.id===id,id);
      return id;
    };
    const releaseShortcut=id=>page.evaluate(id=>workspaceCommand('hw-capture-end',id),id);
    const openCapture=async()=>{
      await page.locator('#modal [aria-label="Close dialog"]').click({timeout:100}).catch(()=>{});
      await page.locator('[data-action="capture"]').click();
      return holdPointer();
    };
    const send=(id,phase,text='')=>page.evaluate(([id,phase,text])=>dictationEvent(id,phase,text),[id,phase,text]);
    const sample=(id,value,count=1)=>page.evaluate(([id,value,count])=>{
      for(let n=0;n<count;n++)dictationLevel(id,value);
    },[id,value,count]);
    const pixels=async()=>{
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const image=await page.locator('canvas.voice-wave').evaluate(canvas=>canvas.toDataURL());
      return createHash('sha256').update(image).digest('hex');
    };

    // Global capture from a completed handoff in Workspace always lands in the notch.
    await page.evaluate(()=>{
      state.firstRun={done:true};
      state.sessions=[{id:'old',project:'old-project',task:'Old finished session',agent:'claude',state:'Complete',result:'Old answer',log:[]}];
      state.captures=[{id:'old-turn',session:'old',receipt:'Complete',brief:'Old finished session',text:'Old finished session',instructions:'internal secrets',project:'old-project'}];
      detailCapture('old-turn');
    });
    assert.equal(await page.getByText('Old finished session',{exact:true}).count(),1);
    assert.equal(await page.locator('#modal').getByText('Old answer').count(),1);
    assert.ok(!(await page.locator('#modal').innerText()).includes('internal secrets'));
    await page.evaluate(()=>{workspaceCommand('hw-capture','tap');workspaceCommand('hw-capture-end','tap')});
    await page.waitForTimeout(220);
    assert.ok(await page.evaluate(()=>document.activeElement.id==='transcript' && !messages.some(m=>m.type==='dictation-start')));
    const shortcut=await holdShortcut('first-hold');
    await page.evaluate(()=>workspaceCommand('hw-capture','first-hold'));
    assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='dictation-start').length),1);
    assert.ok(await page.evaluate(()=>firstMode() && document.activeElement.id==='transcript' && !draft.session));
    await send(shortcut,'recording');
    await send(shortcut,'partial','Plan');
    await send(shortcut,'partial','Plan the lighting');
    assert.equal(await page.locator('#transcript').inputValue(),'Plan the lighting');
    await page.locator('#transcript').press('End');
    await page.keyboard.type(' pass');
    assert.equal(await page.evaluate(()=>recording),null);
    await send(shortcut,'text','Late speech');
    assert.equal(await page.locator('#transcript').inputValue(),'Plan the lighting pass');
    await releaseShortcut(shortcut);
    const field=page.locator('#transcript');
    await field.evaluate(el=>el.setSelectionRange(9,17));
    await holdShortcut('warm-up');await releaseShortcut('warm-up');
    assert.equal(await page.evaluate(()=>recording.phase),'finishing');
    await send('warm-up','stopped');
    const resumed=await holdShortcut('second-hold');
    await releaseShortcut('first-hold');
    assert.equal(await page.evaluate(()=>recording.phase),'starting');
    await send(resumed,'recording');await send(resumed,'partial','render');
    await releaseShortcut(resumed);
    assert.equal(await page.evaluate(()=>messages.at(-1).type),'dictation-finish');
    await send(resumed,'text','render');
    assert.equal(await field.inputValue(),'Plan the render pass');
    if(process.env.TASKTAP_SCREENSHOTS)await page.locator('#modal').screenshot({path:path.join(process.env.TASKTAP_SCREENSHOTS,'quick-capture.png')});
    await page.evaluate(()=>workspaceCommand('workspace'));
    const first=await openCapture();
    assert.equal(await page.locator('.voice-wave').count(),0);
    await send(first,'recording');
    const empty=await pixels();
    await sample(first,0,64);assert.equal(await pixels(),empty);
    await sample(first,.82,28);assert.notEqual(await pixels(),empty);
    await page.waitForFunction(()=>window.spriteDraws>0);
    await sample(first,0,64);assert.equal(await pixels(),empty);
    await page.emulateMedia({reducedMotion:'reduce'});
    const reduced=await pixels();
    await sample(first,1,64);assert.equal(await pixels(),reduced);
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.mouse.move(1,1);await page.mouse.up();
    assert.equal(await page.evaluate(()=>recording.phase),'finishing');
    await send(first,'processing');
    assert.equal(await page.locator('.voice-wave').count(),0);
    await sample(first,1);assert.equal(await page.locator('.voice-wave').count(),0);
    await send(first,'text','A voice test');
    assert.equal(await page.locator('#transcript').inputValue(),'A voice test');

    const second=await openCapture();await send(second,'recording');
    const silent=await pixels();
    await sample(first,1,64);assert.equal(await pixels(),silent);
    await send(first,'text','Stale result');
    assert.equal(await page.locator('#transcript').inputValue(),'');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.ok(await page.evaluate(id=>window.messages.some(m=>m.type==='dictation-cancel' && m.id===id),second));

    const third=await openCapture();await send(third,'recording');
    await page.evaluate(()=>document.querySelector('#transcript').remove());
    await page.waitForFunction(()=>recording===null);
    await page.mouse.up();
    assert.equal(await page.locator('.voice-wave').count(),0);
    assert.ok(await page.evaluate(id=>window.messages.some(m=>m.type==='dictation-cancel' && m.id===id),third));
    await page.locator('#modal [aria-label="Close dialog"]').click();
    await page.evaluate(()=>{
      const q=receiveAgentQuestion({requestId:'ask',sessionId:'studio',agent:'claude',workspace:'/fixture/voice',question:'Use the new mix?'});
      showNotch(q.id);
    });
    await page.getByRole('button',{name:'Talk it through'}).click();
    await mic.focus();await page.keyboard.down('Space');
    const discussion=await page.evaluate(()=>recording.id);await send(discussion,'recording');
    assert.equal(await page.locator('#comment + canvas.voice-wave').count(),1);
    await send(discussion,'error','Microphone disconnected');
    assert.equal(await page.locator('.voice-wave').count(),0);
    await page.keyboard.up('Space');
    assert.equal(await mic.count(),1);
    await page.getByRole('button',{name:'Back to decision'}).click();
    await page.getByRole('button',{name:'Answer by voice'}).click();
    assert.equal(await page.evaluate(()=>recording),null);
    const answer=await holdPointer();await send(answer,'recording');
    assert.equal(await page.locator('#answer + canvas.voice-wave').count(),1);
    await page.keyboard.press('Escape');await page.mouse.up();
    assert.ok(await page.evaluate(id=>window.messages.some(m=>m.type==='dictation-cancel' && m.id===id),answer));
    await page.route('**/assets/motion/glyph/type.png',route=>route.abort());
    await page.reload();
    const offline=await openCapture();await send(offline,'recording');
    const baseline=await pixels();await sample(offline,1,25);
    assert.notEqual(await pixels(),baseline);
    assert.equal(await page.evaluate(()=>window.spriteDraws),0);
    console.log('Shortcut tap, hold, repeat and release, pointer capture, keyboard holds, voice meter atlas, asset fallback, silence, speech history, Reduce Motion, transcriptions, decisions, discussion, stale events and error cleanup passed.');
  } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
