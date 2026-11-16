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
      workerAccount:'account-a',models:{},keys:{},accounts:[{id:'account-a',label:'Studio / 123456',status:'enabled'}],account:'account-a',cloud:''};
    await page.evaluate(c=>aiConnections.receive(c),config);
    const click=name=>page.getByRole('button',{name,exact:true}).click();
    const healthy={codex:'signedIn',claude:'signedIn',agy:'installed'};
    const updateHealth=workerHealth=>page.evaluate(value=>{aiConnections.receive(value);aiConnections.checked()},{...config,choice:'local',workerHealth});
    const capture=async name=>{
      if(process.env.TASKTAP_SCREENSHOTS)await page.locator('#modal').screenshot({path:path.join(process.env.TASKTAP_SCREENSHOTS,name),animations:'disabled'});
    };
    await updateHealth(healthy);
    await click('Preferences');
    const overview=page.locator('#agent-setup-link');
    assert.equal(await overview.locator('small').isVisible(),false);
    await page.getByRole('button',{name:/Request preparation/}).click();
    assert.equal(await page.getByText('Accounts used by workers').count(),0);
    assert.equal(await page.getByRole('button',{name:'Save connection'}).count(),0);
    await capture('capture-preparation-local.png');
    await click('Back');
    await overview.click();
    await updateHealth(healthy);
    assert.equal(await page.locator('.agent-row').getByText('Signed in',{exact:true}).count(),2);
    assert.equal(await page.locator('.agent-row button').count(),0);
    await updateHealth({...healthy,codex:'missing'});
    await click('Installation guide for Codex');
    assert.deepEqual(await page.evaluate(()=>sent.at(-1)),{type:'worker-install',agent:'codex'});
    await updateHealth({...healthy,codex:'signedOut'});
    await capture('agent-setup-sign-in.png');
    await click('Sign in to Codex');
    assert.deepEqual(await page.evaluate(()=>sent.at(-1)),{type:'worker-login',agent:'codex'});
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    assert.equal(await page.evaluate(()=>sent.at(-1).type),'ai-refresh');
    await updateHealth(healthy);
    assert.equal(await page.locator('.agent-row button').count(),0);
    await updateHealth({...healthy,codex:'missing'});
    await click('Back');
    assert.equal(await overview.locator('small').isVisible(),false);
    await updateHealth({...healthy,claude:'signedOut'});
    assert.match(await overview.innerText(),/Sign in to Claude Code/);
    await page.getByRole('button',{name:'Session models',exact:true}).click();
    assert.ok(await page.getByRole('button',{name:'Sign in to Claude Code'}).isVisible());
    await page.locator('#default-agent').selectOption('codex');
    assert.equal(await page.getByRole('button',{name:'Sign in to Claude Code'}).count(),0);
    await page.evaluate(()=>prefs());
    await overview.click();
    await updateHealth({...healthy,claude:'missing',codex:'signedOut',agy:'unknown'});
    await page.setViewportSize({width:340,height:700});
    assert.ok(await page.getByRole('button',{name:'Installation guide for Claude Code'}).isVisible());
    assert.ok(await page.locator('.agent-list').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    assert.equal(await page.locator('[data-agent-health="agy"] button').count(),0);
    await page.setViewportSize({width:1024,height:780});
    await click('Back');
    await page.getByRole('button',{name:/Request preparation/}).click();
    await page.locator('#ai-route').selectOption('codex');
    assert.ok(await page.getByRole('button',{name:'Sign in to Codex'}).isVisible());
    await page.getByText('Model override',{exact:true}).click();
    await page.locator('#ai-model').fill('keep-my-edit');
    await updateHealth(healthy);
    assert.equal(await page.locator('#ai-model').inputValue(),'keep-my-edit');
    assert.equal(await page.locator('#ai-settings [data-action="worker-login"]').count(),0);
    await page.evaluate(c=>{aiConnections.receive(c);aiConnections.checked()},config);
    await click('Back');
    await page.getByRole('button',{name:/Request preparation/}).click();
    if (process.env.TASKTAP_SCREENSHOTS) {
      await page.locator('#ai-route').click();
      await page.getByRole('listbox').getByRole('option',{name:/Claude Code with cloud billing/}).waitFor();
      await page.screenshot({path:path.join(process.env.TASKTAP_SCREENSHOTS,'ai-connections.png'),animations:'disabled'});
      await page.keyboard.press('Escape');
    }
    await page.locator('#ai-route').selectOption('openai');
    await page.locator('#ai-key').fill('fixture-unsaved');
    await page.locator('#ai-model').fill('fixture-model');
    await click('Save connection');
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
    await click('Diagnostics');
    assert.ok((await page.locator('#review-diagnostics').innerText()).includes('no cloud usage'));
    await page.evaluate(()=>{editDraft();});
    await click('Review capture');
    await click('Send to ChatGPT plan');
    const call=await page.evaluate(()=>sent.findLast(m=>m.type==='route'));
    assert.equal(call.provider,'chatgpt');
    assert.equal(call.confirmed,true);
    assert.deepEqual(call.input.projects,[[0,'Lighting']]);
    await page.evaluate(id=>finishRouting(id,{source:'error',message:'Usage limit reached.'}),call.id);
    await click('Continue on this Mac');
    await click('Diagnostics');
    assert.ok((await page.locator('#review-diagnostics').innerText()).includes('Studio / 123456'));
    assert.equal(await page.evaluate(()=>sent.filter(m=>m.type==='route').length),1);
    // This branch deliberately covers an external terminal and its manual nudge fallback.
    await page.evaluate(()=>{draft.agent='codex';draft.host='terminal';review()});
    const trust=page.getByRole('checkbox',{name:'Use project settings'});
    assert.ok(await trust.isChecked());
    await trust.uncheck();
    await click('Start session');
    const job=await page.evaluate(()=>sent.findLast(m=>m.type==='enqueue').job);
    assert.equal(job.reviewedFolder,undefined);
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
    await click('Diagnostics');
    assert.ok((await page.locator('#review-diagnostics').innerText()).includes('Codex / Terminal / Existing session'));
    await click('Back to review');
    await click('Copy nudge & open session');
    assert.equal((await page.evaluate(()=>sent.findLast(m=>m.type==='enqueue').job)).manual,true);
    const peers=page.locator('#modal [data-project-peers]');
    await page.evaluate(()=>{
      const project='/projects/Lighting';
      state.projects.push({id:'lighting-alias',name:'Alias',folder:'/projects/Alias',checkout:project});
      const row=(id,state,more={})=>({id,project,agent:'codex',state,task:id,log:[],...more});
      state.sessions=[
        row('glass & <lens>','Running'),row('solver','Needs input'),row('stale','Running',{available:false}),
        row('different project','Running',{project:'/projects/Unrelated'}),row('finished','Complete'),
        row('unknown','Connected'),row('idle','Idle'),row('launching','Opening',{project:'lighting-alias'})
      ];
      newDraft('',project);
      draft.quick=true;draft.text=draft.brief='Balance the lighting';draft.agent='codex';review();
    });
    assert.match(await page.locator('.review-decisions').innerText(),/3 other sessions are active/);
    await click('View active work');
    assert.equal(await page.locator('.review-peers li').count(),3);
    assert.match(await page.locator('.review-peers').innerText(),/glass & <lens>/);
    await click('Back to review');
    const reviewed=await page.evaluate(()=>({
      outgoing:deliveryText(draft),instructions:deliveryInstructions(draft)
    }));
    assert.match(reviewed.instructions,/current checkout and branch/);
    assert.match(reviewed.outgoing,/glass & <lens>/);
    assert.doesNotMatch(reviewed.outgoing,/different project|finished|stale|unknown|idle/);
    assert.doesNotMatch(await page.locator('#handoff-review').innerText(),/current checkout and branch/,'worker instructions stay out of ordinary review');
    await click('Diagnostics');
    const diagnostic=JSON.parse(await page.locator('#review-diagnostics').innerText());
    assert.equal(diagnostic.delivery.outgoing,reviewed.outgoing);
    assert.equal(diagnostic.delivery.instructions,reviewed.instructions);
    await click('Back to review');
    // The outgoing handoff must match the reviewed snapshot, even as peers complete.
    await page.evaluate(()=>{state.sessions[0].state='Complete'});
    await click('Start session');
    const withPeers=await page.evaluate(()=>sent.findLast(m=>m.type==='enqueue').job);
    assert.equal(withPeers.reviewedFolder,'/projects/Lighting');
    assert.equal(withPeers.outgoing,reviewed.outgoing);
    assert.equal(withPeers.instructions,reviewed.instructions);
    await page.evaluate(()=>{draft=null;showSession('solver')});
    assert.equal(await peers.locator('summary').innerText(),'1 other session in Lighting');
    await peers.locator('summary').click();
    await peers.getByRole('button',{name:/launching/}).focus();
    await page.evaluate(()=>showSession('solver'));
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.id),'launching');
    await peers.getByRole('button',{name:/launching/}).click();
    assert.equal(await page.locator('#dialog-heading').innerText(),'launching');
    const routes=await page.evaluate(()=>{
      const d={project:'/projects/Lighting',brief:'Add a cue',strokes:[],peerTasks:[{agent:'Codex',state:'Running',task:'solver'}]};
      return {
        others:['pi','cursor-agent','agy'].map(agent=>deliveryText({...d,agent,mode:'ask'})),
        nudge:deliveryText({...d,agent:'pi',mode:'nudge'}),
        isolated:['@scratch','@new','missing'].every(id=>projectPeers(id).length===0)
      };
    });
    for(const text of routes.others){assert.match(text,/current checkout and branch/);assert.match(text,/solver/)}
    assert.equal(routes.nudge,'Add a cue');assert.ok(routes.isolated);
    const identity=await page.evaluate(()=>{
      const folder='/projects/Lighting',thread='discovered-thread',owned='owned-session';
      const external={id:thread,conversation:thread,source:'terminal',agent:'codex',folder,task:'Starting',state:'Running'};
      externalSessions([external]);
      externalSessions([external,{...external,id:owned,owned:'yes',available:'yes',host:'ghostty',task:'Finish the lights'}]);
      return [Boolean(sess(owned)),Boolean(sess(thread))];
    });
    assert.deepEqual(identity,[true,false],'A newly identified worker should appear once in Sessions');
    await page.evaluate(()=>{
      dismissCard();
      externalSessions([{id:'owned-session',owned:'yes',agent:'codex',folder:'/projects/Lighting',task:'Finish the lights',
        host:'ghostty',conversation:'discovered-thread',state:'Complete',available:'no',resumable:'yes',updatedAt:'1794669251000'}]);
      state.captures.unshift({id:'saved-nudge',session:'owned-session',brief:'Polish the reflections',kind:'Session nudge'});
      go('sessions');
    });
    const filter=page.getByLabel('Find a session');
    await filter.fill('Lighting reflections');
    assert.equal(await page.locator('#session-history .session-row').count(),1);
    await page.locator('#session-history .session-row').click();
    await click('Resume in Ghostty');
    assert.deepEqual(await page.evaluate(()=>sent.at(-1)),{type:'reopen-session',id:'owned-session'});
    await page.setViewportSize({width:390,height:750});
    await page.evaluate(()=>aiConnections.show('chatgpt'));
    assert.ok(await page.locator('#ai-route').isVisible());
    assert.ok(await page.evaluate(()=>document.querySelector('#ai-settings').scrollWidth<=document.querySelector('#ai-settings').clientWidth+1));
    assert.deepEqual(errors,[]);
    console.log('Agent setup, consent, saved nudge identity, same-project peers and reviewed Git guidance passed.');
  } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
