// Feed the same callbacks that the native queue sends. Read back the live light so
// a phase label or an unrelated decorative movie cannot satisfy this check.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || undefined});
  try {
    const page=await browser.newPage({viewport:{width:900,height:820}});
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{
      window.outbox=[];
      window.webkit={messageHandlers:{workspace:{postMessage:m=>window.outbox.push(m)}}};
    });
    await page.goto(pathToFileURL(path.join(__dirname,'../prototype/index.html')).href+'#workspace');
    const folder='/fixture/Lightbox';
    const review=page.locator('.review-rail tasktap-relay');
    await page.evaluate(folder=>{projectsDiscovered([{name:'Lightbox',folder}]);newDraft('',folder)},folder);
    await page.locator('#transcript').fill('Ask Codex to inspect the light rig');
    await page.getByRole('button',{name:'Review session'}).click();
    assert.equal(await review.getAttribute('data-agent'),'codex');
    const capture=await review.getAttribute('data-capture');
    assert.equal(await review.getAttribute('data-phase'),'review');
    await page.getByRole('button',{name:'Start session'}).click();
    assert.equal(await review.getAttribute('data-phase'),'submitting');
    await page.evaluate(capture=>acceptLive({capture,error:'Fixture folder unavailable'}),capture);
    assert.equal(await review.getAttribute('data-phase'),'failed');
    await page.getByRole('button',{name:'Start session'}).click();
    const job=await page.evaluate(()=>window.outbox.findLast(m=>m.type==='enqueue').job);
    assert.equal(job.capture,capture);
    await page.evaluate(job=>acceptLive({capture:job.capture,folder:job.folder,task:job.task,name:'Lightbox'}),job);
    const light=page.locator('.capture-card tasktap-relay');
    const point=async target=>target.locator('canvas').evaluate(canvas=>{
      const {data}=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height);
      let x=0,y=0,n=0;
      for(let i=0;i<data.length;i+=4){
        if(data[i+3]>245 && data[i]>246 && data[i+1]>230){
          x+=(i/4)%canvas.width;y+=Math.floor(i/4/canvas.width);n++;
        }
      }
      if(!n)throw Error('Receipt light missing');
      return [x/n,y/n];
    });
    assert.equal(await light.getAttribute('data-phase'),'queued');
    await page.waitForTimeout(550);
    const queued=await point(light);
    await page.waitForTimeout(550);
    assert.deepEqual(await point(light),queued);
    const receipt=state=>page.evaluate(([job,state])=>agentReceipt({session:job.session,capture:job.capture,state,message:state}),[job,state]);
    await receipt('Running');
    await page.waitForTimeout(120);
    const intermediate=await point(light);
    await page.waitForTimeout(430);
    const running=await point(light);
    assert.ok(queued[0]<intermediate[0] && intermediate[0]<running[0]);
    await page.emulateMedia({reducedMotion:'reduce'});
    await receipt('Complete');
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const complete=await point(light);
    assert.ok(complete[0]>running[0]+80);
    await page.getByRole('button',{name:'View capture'}).click();
    assert.equal(await page.locator('#modal tasktap-relay').getAttribute('data-phase'),'complete');
    await page.getByRole('button',{name:'Open session'}).click();
    assert.equal(await page.locator('#modal tasktap-relay').getAttribute('data-agent'),'codex');
    await page.getByRole('button',{name:'Follow up'}).click();
    await page.locator('#transcript').fill('Check the reflection too.');
    await page.getByRole('button',{name:'Review capture'}).click();
    const next=await review.getAttribute('data-capture');
    assert.notEqual(next,capture);
    await page.getByRole('button',{name:'Copy nudge & open session'}).click();
    const nudge=await page.evaluate(()=>window.outbox.findLast(m=>m.type==='enqueue').job);
    assert.equal(nudge.session,job.session);
    await page.evaluate(nudge=>{
      agentReceipt({...nudge,state:'Delivered',message:'Accepted by the inbox'});
      acceptLive({capture:nudge.capture,name:'Lightbox',task:nudge.task,folder:nudge.folder});
    },nudge);
    assert.equal(await light.getAttribute('data-phase'),'delivered');
    assert.equal(await page.evaluate(id=>state.captures.filter(c=>c.id===id).length,next),1);
    await page.reload();
    assert.equal(await light.getAttribute('data-phase'),'delivered');
    await page.evaluate(()=>showHome());
    assert.equal(await page.locator('#notch-home tasktap-relay').getAttribute('data-capture'),next);
    await page.evaluate(folder=>{
      showHome(false);newDraft('',folder);
      draft.text='Check the material';draft.brief=draft.text;review();commitCapture();
      const job=window.outbox.at(-1).job;
      acceptLive({capture:job.capture,folder:job.folder,name:'Lightbox',task:job.task});
    },folder);
    assert.ok(await page.locator('#notch-home').isVisible());
    assert.equal(await page.locator('#notch-home tasktap-relay').getAttribute('data-phase'),'queued');
    await page.locator('#notch-home').waitFor({state:'hidden',timeout:6000});
    await page.evaluate(folder=>{showWorkspace();newDraft('',folder);draft.mode='note';draft.text='Note';draft.brief='Note';review()},folder);
    assert.equal(await page.locator('#modal tasktap-relay').count(),0);
    assert.deepEqual(errors,[]);
    console.log('Reviewed target, submission, retry, queue, one-shot movement, Reduce Motion, nudge isolation, reordered receipts, relaunch and static notes passed.');
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
