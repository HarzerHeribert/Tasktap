// The bridge is stubbed here so deterministic meter values never require microphone access.
const {chromium}=require('playwright');
const {pathToFileURL}=require('node:url');
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
    await page.goto(pathToFileURL(path.join(__dirname,'../prototype/index.html')).href+'#workspace');
    const openCapture=async()=>{
      await page.locator('#modal [aria-label="Close dialog"]').click({timeout:100}).catch(()=>{});
      await page.locator('[data-action="capture"]').click();
      await page.getByRole('button',{name:'Dictate',exact:true}).click();
      return page.evaluate(()=>recording.id);
    };
    const send=(id,phase,text='')=>page.evaluate(([id,phase,text])=>dictationEvent(id,phase,text),[id,phase,text]);
    const sample=(id,value,count=1)=>page.evaluate(([id,value,count])=>{
      for(let n=0;n<count;n++)dictationLevel(id,value);
    },[id,value,count]);
    const pixels=async()=>{
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      return (await page.locator('.voice-wave').screenshot()).toString('base64');
    };

    const first=await openCapture();
    assert.equal(await page.locator('.voice-wave').count(),0);
    await send(first,'recording');
    const empty=await pixels();
    await sample(first,0,64);assert.equal(await pixels(),empty);
    await sample(first,.82,28);assert.notEqual(await pixels(),empty);
    await page.waitForFunction(()=>window.spriteDraws>0);
    await sample(first,0,64);assert.equal(await pixels(),empty);
    await page.emulateMedia({reducedMotion:'reduce'});
    await sample(first,1,64);assert.equal(await pixels(),empty);
    await page.emulateMedia({reducedMotion:'no-preference'});
    await send(first,'processing');
    assert.equal(await page.locator('.voice-wave').count(),0);
    await sample(first,1);assert.equal(await page.locator('.voice-wave').count(),0);
    await send(first,'text','A voice test');
    assert.equal(await page.locator('#transcript').inputValue(),'A voice test');

    const second=await openCapture();await send(second,'recording');
    await sample(first,1,64);assert.equal(await pixels(),empty);
    await send(first,'text','Stale result');
    assert.equal(await page.locator('#transcript').inputValue(),'');
    await page.locator('#modal [aria-label="Close dialog"]').click();
    assert.ok(await page.evaluate(id=>window.messages.some(m=>m.type==='dictation-cancel' && m.id===id),second));

    const third=await openCapture();await send(third,'recording');
    await page.evaluate(()=>document.querySelector('#transcript').remove());
    await page.waitForFunction(()=>recording===null);
    assert.equal(await page.locator('.voice-wave').count(),0);
    assert.ok(await page.evaluate(id=>window.messages.some(m=>m.type==='dictation-cancel' && m.id===id),third));
    await page.locator('#modal [aria-label="Close dialog"]').click();
    await page.evaluate(()=>{
      const q=receiveAgentQuestion({requestId:'ask',sessionId:'studio',agent:'claude',workspace:'/fixture/voice',question:'Use the new mix?'});
      showNotch(q.id);
    });
    await page.getByRole('button',{name:'Talk it through'}).click();
    await page.getByRole('button',{name:'Dictate',exact:true}).click();
    const discussion=await page.evaluate(()=>recording.id);await send(discussion,'recording');
    assert.equal(await page.locator('#comment + canvas.voice-wave').count(),1);
    await send(discussion,'error','Microphone disconnected');
    assert.equal(await page.locator('.voice-wave').count(),0);
    assert.equal(await page.getByRole('button',{name:'Dictate',exact:true}).count(),1);
    await page.getByRole('button',{name:'Back to decision'}).click();
    await page.getByRole('button',{name:'Answer by voice'}).click();
    const answer=await page.evaluate(()=>recording.id);await send(answer,'recording');
    assert.equal(await page.locator('#answer + canvas.voice-wave').count(),1);
    await page.getByRole('button',{name:'Close decision'}).click();
    assert.ok(await page.evaluate(id=>window.messages.some(m=>m.type==='dictation-cancel' && m.id===id),answer));
    await page.route('**/assets/motion/glyph/type.png',route=>route.abort());
    await page.reload();
    const offline=await openCapture();await send(offline,'recording');
    const baseline=await pixels();await sample(offline,1,25);
    assert.notEqual(await pixels(),baseline);
    assert.equal(await page.evaluate(()=>window.spriteDraws),0);
    console.log('Voice meter atlas, asset fallback, silence, speech history, Reduce Motion, transcriptions, decisions, discussion, stale events and error cleanup passed.');
  } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
