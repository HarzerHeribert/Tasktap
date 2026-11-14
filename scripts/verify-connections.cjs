/* Exercise billing disclosure with the native bridge stubbed. No provider calls. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
  try {
    const page=await browser.newPage({viewport:{width:1024,height:780},reducedMotion:'reduce'});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{
      window.sent=[];
      window.webkit={messageHandlers:{workspace:{postMessage:m=>window.sent.push(m)}}};
    });
    await page.goto(pathToFileURL(path.join(__dirname,'../prototype/index.html')).href+'#workspace');
    const config={choice:'chatgpt',workers:{codex:'API key login',claude:'Billing source unverified',agy:'CLI missing'},
      workerAccount:'account-a',models:{},keys:{},accounts:[{id:'account-a',label:'Studio · 123456',status:'enabled'}],account:'account-a',cloud:''};
    await page.evaluate(c=>aiConnections.receive(c),config);
    const click=name=>page.getByRole('button',{name,exact:true}).click();
    await click('Preferences');
    await page.getByRole('button',{name:/AI connections/}).click();
    if (process.env.TASKTAP_SCREENSHOTS) {
      await page.locator('#ai-route').click();
      await page.getByRole('listbox').getByRole('option',{name:/Claude Code with cloud billing/}).waitFor();
      await page.screenshot({path:path.join(process.env.TASKTAP_SCREENSHOTS,'ai-connections.png'),animations:'disabled'});
      await page.keyboard.press('Escape');
    }
    await page.locator('#ai-route').selectOption('openai');
    await page.locator('#ai-key').fill('fixture-unsaved');
    await page.locator('#ai-model').fill('fixture-model');
    await click('Use this route');
    const save=await page.evaluate(()=>window.sent.at(-1));
    assert.equal(save.type,'ai-save');
    assert.equal(save.workerPlan,undefined);
    assert.equal(await page.locator('#ai-key').inputValue(),'');
    assert.ok(!(await page.evaluate(()=>JSON.stringify(localStorage))).includes('fixture-unsaved'));
    await page.evaluate(c=>aiConnections.receive(c,'Test complete.',true),config);
    await click('Back');
    await page.evaluate(()=>{
      projectsDiscovered([{name:'Lighting',folder:'/projects/Lighting'},{name:'Unrelated',folder:'/projects/Unrelated'}]);
      newDraft(''); draft.text='Investigate reflections in Lighting'; $('#transcript').value=draft.text;
    });
    await click('Review capture');
    await page.getByText('What will be sent').click();
    assert.ok((await page.locator('#modal details').innerText()).includes('Lighting'));
    assert.ok(!(await page.locator('#modal details').innerText()).includes('Unrelated'));
    assert.equal(await page.evaluate(()=>sent.filter(m=>m.type==='route').length),0);
    await click('Prepare on this Mac');
    assert.ok((await page.locator('#handoff-accounts').innerText()).includes('no cloud usage'));
    await page.evaluate(()=>{editDraft();});
    await click('Review capture');
    await click('Send to ChatGPT plan');
    const call=await page.evaluate(()=>sent.findLast(m=>m.type==='route'));
    assert.equal(call.provider,'chatgpt');
    assert.equal(call.confirmed,true);
    assert.deepEqual(call.input.projects,[[0,'Lighting']]);
    await page.evaluate(id=>finishRouting(id,{source:'error',message:'Usage limit reached.'}),call.id);
    await click('Continue on this Mac');
    assert.ok((await page.locator('#handoff-accounts').innerText()).includes('Studio · 123456'));
    assert.equal(await page.evaluate(()=>sent.filter(m=>m.type==='route').length),1);
    await page.evaluate(()=>{draft.agent='codex';review()});
    await click('Start session');
    const job=await page.evaluate(()=>sent.findLast(m=>m.type==='enqueue').job);
    assert.equal(job.planAccount,undefined);assert.equal(job.host,'terminal');assert.equal(job.delivery,'interactive');
    assert.ok(job.accounts.includes('Studio'));assert.match(job.routingPayload,/Lighting/);
    assert.ok(!job.routingPayload.includes('Unrelated'));assert.match(job.instructions,/report_result/);
    assert.equal(job.outgoing,job.brief);
    await page.evaluate(j=>acceptLive({capture:j.capture,folder:j.folder,name:'Lighting',task:j.task}),job);
    await page.evaluate(({c,j})=>{
      aiConnections.receive({...c,workerAccount:''});
      agentReceipt({...j,state:'Opened',message:'Interactive session opened in Terminal.'});
      newDraft(j.session);
      draft.text='Check the glass too.';draft.brief=draft.text;review();
    },{c:config,j:job});
    assert.ok((await page.locator('#handoff-accounts').innerText()).includes('Codex · Terminal · Existing session'));
    await click('Copy nudge & open session');
    assert.equal((await page.evaluate(()=>sent.findLast(m=>m.type==='enqueue').job)).manual,true);
    await page.setViewportSize({width:390,height:750});
    await page.evaluate(()=>aiConnections.show('chatgpt'));
    assert.ok(await page.locator('#ai-route').isVisible());
    assert.ok(await page.evaluate(()=>document.querySelector('#ai-settings').scrollWidth<=document.querySelector('#ai-settings').clientWidth+1));
    assert.deepEqual(errors,[]);
    console.log('Consent, local recovery, independent accounts, saved nudge identity and narrow layout passed.');
  } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
