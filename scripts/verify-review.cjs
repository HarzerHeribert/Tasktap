const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const fs=require('node:fs');
const shots=process.env.TASKTAP_SCREENSHOTS||'/tmp';fs.mkdirSync(shots,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',e=>{errors.push(String(e));console.error(e)});
  await page.addInitScript(()=>{window.sent=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>sent.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href+'#workspace');
  await page.evaluate(()=>{
   state.firstRun={done:true};state.projects=[{id:'cuegrid',name:'Cuegrid',folder:'/tmp/cuegrid',aliases:[]},{id:'lightbox',name:'Lightbox',folder:'/tmp/lightbox',aliases:[]}];state.captures=[];state.decisions=[];
   state.sessions=[{id:'peer',project:'cuegrid',agent:'claude',host:'tasktap',task:'Improve keyboard navigation',state:'Running',available:true,interactive:true,managed:true,log:[]},{id:'external',project:'cuegrid',agent:'codex',host:'iterm2',task:'Review the export pipeline',state:'Connected',available:true,interactive:true,external:true,inbox:'manual',log:[]}];
   aiConnections.receive({choice:'local',workerHealth:{codex:'signedIn',claude:'signedIn'},accounts:[],workers:{},models:{},keys:{}});state.workerRouting={automatic:false};
   captureDraft('','cuegrid','Improve the Cuegrid timeline. Preserve keyboard shortcuts and make the active clip clear.');
   Object.assign(draft,{brief:draft.text,agent:'codex',agentChoice:'manual',host:'tasktap',modelOverride:{agent:'codex',value:'review-model'},captureId:'review-capture',reference:{kind:'file',value:'/tmp/cuegrid/Timeline.swift',app:'Finder'},strokes:[[[1,2],[3,4]]],keep:true,note:'Timeline review',routingSource:'apple'});review();appAppearance.setTheme('dark');
  });
  const click=name=>page.getByRole('button',{name,exact:true}).click();
  let text=await page.locator('#handoff-review').innerText();
  for(const value of ['Your request','Destination','Reference','Cuegrid','Codex','Tasktap','review-model','New conversation','Timeline.swift'])assert.ok(text.includes(value),value+' is visible without disclosure');
  assert.equal(await page.locator('#handoff-review details').count(),0);
  assert.equal(await page.locator('#handoff-review [data-action="commit-review"]').count(),1);
  assert.ok(!/report_result|list_project_sessions|current checkout and branch|review-capture/.test(text),'ordinary review excludes delivery instructions and receipt IDs');
  assert.equal(await page.getByRole('button',{name:'Change reference',exact:true}).count(),0,'context has one focused edit action');
  assert.ok(await page.locator('#review-brief').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=16));
  await page.screenshot({path:path.join(shots,'tasktap-review-summary.png')});
  const preserved=await page.evaluate(()=>({project:draft.project,agent:draft.agent,host:draft.host,capture:draft.captureId,reference:draft.reference,model:draft.modelOverride,strokes:draft.strokes}));
  await click('Edit task');await page.getByLabel('Task',{exact:true}).fill('Refine the timeline controls and preserve every keyboard shortcut.');await click('Save task');
  assert.deepEqual(await page.evaluate(()=>({project:draft.project,agent:draft.agent,host:draft.host,capture:draft.captureId,reference:draft.reference,model:draft.modelOverride,strokes:draft.strokes})),preserved);
  assert.match(await page.evaluate(()=>draft.text),/^Improve the Cuegrid timeline/,'original capture remains in audit');
  await click('Change destination');await page.getByLabel('Workspace',{exact:true}).selectOption('@new');await page.getByLabel('New project name').fill('..');await click('Review changes');assert.equal(await page.locator('#dialog-heading').innerText(),'Change destination');assert.equal(await page.getByLabel('New project name').evaluate(el=>el.validity.valid),false);await page.getByLabel('Workspace',{exact:true}).selectOption('lightbox');await page.getByLabel('Open this session in').selectOption('terminal');await click('Review changes');
  assert.equal(await page.evaluate(()=>draft.project),'lightbox');assert.equal(await page.evaluate(()=>draft.keep),true);assert.equal(await page.evaluate(()=>draft.note),'Timeline review');assert.equal(await page.evaluate(()=>draft.reference.value),'/tmp/cuegrid/Timeline.swift');
  assert.match(await page.locator('#review-brief').innerText(),/^Refine the timeline/);
  await click('Edit context');await page.getByLabel('URL or file path').fill('/tmp/cuegrid/Timeline-v2.swift');await click('Save context');
  assert.equal(await page.evaluate(()=>draft.project),'lightbox','editing context does not reroute reviewed destination');
  assert.equal(await page.evaluate(()=>draft.captureId),'review-capture');
  await click('Change destination');await page.getByLabel('Workspace',{exact:true}).selectOption('cuegrid');await click('Review changes');
  await click('View active work');assert.match(await page.locator('#modal').innerText(),/Improve keyboard navigation/);assert.equal(await page.locator('#modal pre').count(),0);await click('Back to review');
  // Actual outgoing payload retains the instructions and peer context hidden from ordinary review.
  await page.locator('#folder-trust').uncheck();await click('Start session');
  assert.ok(await page.getByRole('button',{name:'Edit task',exact:true}).isDisabled(),'pending handoff cannot be edited');
  assert.ok(await page.getByRole('button',{name:'Change destination',exact:true}).isDisabled());
  assert.ok(await page.getByRole('button',{name:'Remove reference',exact:true}).isDisabled());
  assert.ok(await page.getByRole('button',{name:'Start session',exact:true}).isDisabled(),'pending handoff cannot be submitted twice');
  let job=await page.evaluate(()=>sent.findLast(m=>m.type==='enqueue').job);
  assert.match(job.instructions,/report_result.*review-capture/);assert.match(job.outgoing,/current checkout and branch/);assert.match(job.outgoing,/review-only, planning-only and no-commit/);assert.equal(job.outgoing.match(/Complete the authorized scope/g).length,1,'the shared completion contract is sent once');assert.doesNotMatch(job.instructions,/Complete the authorized scope/);assert.match(job.outgoing,/Other sessions in this checkout/);assert.equal(job.reviewedFolder,undefined);
  await page.evaluate(()=>acceptLive({capture:draft.captureId,error:'Fixture: terminal could not open.'}));
  assert.ok(await page.getByRole('button',{name:'Edit task',exact:true}).isEnabled(),'failed handoff restores editing');
  assert.match(await page.locator('#handoff-error').innerText(),/request is preserved.*Change destination/);assert.equal(await page.evaluate(()=>draft.brief),'Refine the timeline controls and preserve every keyboard shortcut.');
  assert.equal(await page.locator('.review-footer .primary').count(),1);
  await click('Edit task');await click('Save task');assert.match(await page.locator('#handoff-error').innerText(),/terminal could not open/,'failure remains actionable after a focused edit');
  await page.locator('#folder-trust').check();await click('Start session');
  job=await page.evaluate(()=>sent.findLast(m=>m.type==='enqueue').job);assert.equal(job.reviewedFolder,'/tmp/cuegrid');
  await page.evaluate(()=>acceptLive({capture:draft.captureId,error:'Fixture: retry remains available.'}));
  // Diagnostics deliberately use representative credentials in user/protocol text, never real secrets.
  await page.evaluate(()=>{draft.remoteAttempts=[{label:'Remote preparation',account:'Configured account',payload:'{"api_key":"fixture-api-secret","safe":"keep-this","token":"fixture-token-secret"}\nAuthorization: Bearer fixture-bearer-secret\nhttps://name:fixture-url-secret@example.com/path?access_token=fixture-query-secret\nsk-fixtureCredential123456789\nCookie: session=fixture-cookie-secret; refresh=fixture-refresh-secret\nghp_fixtureGithubCredential123456'}];review()});
  assert.match(await page.locator('#handoff-review').innerText(),/Preparation was requested from Remote preparation/);
  await click('Diagnostics');const diagnostic=await page.locator('#review-diagnostics').innerText(),data=JSON.parse(diagnostic);
  assert.match(data.delivery.instructions,/report_result.*review-capture/);assert.match(diagnostic,/keep-this/);assert.match(diagnostic,/\[redacted\]/);
  for(const secret of ['fixture-api-secret','fixture-token-secret','fixture-bearer-secret','fixture-url-secret','fixture-query-secret','sk-fixtureCredential123456789','fixture-cookie-secret','fixture-refresh-secret','ghp_fixtureGithubCredential123456'])assert.ok(!diagnostic.includes(secret),secret+' is redacted');
  await click('Copy diagnostics');await click('Export diagnostics');
  const copies=await page.evaluate(()=>sent.filter(m=>['copy-diagnostics','export-diagnostics'].includes(m.type)));
  assert.equal(copies.length,2);assert.equal(copies[0].text,diagnostic);assert.equal(copies[1].text,diagnostic);
  assert.match(await page.evaluate(()=>draft.remoteAttempts[0].payload),/fixture-api-secret/,'redaction never mutates actual delivery');
  await click('Back to review');
  // Existing manual sessions retain exact identity and disclose paste immediately beside confirmation.
  await click('Change destination');await page.getByLabel('Action',{exact:true}).selectOption('nudge');await page.getByLabel('Existing session',{exact:true}).selectOption('external');await click('Review changes');
  assert.match(await page.locator('.review-footer .review-manual').innerText(),/paste.*iTerm2.*press Return/);
  assert.match(await page.locator('[aria-label="Destination"]').innerText(),/Existing conversation.*Review the export pipeline/s);
  await click('Copy nudge & open session');job=await page.evaluate(()=>sent.findLast(m=>m.type==='enqueue').job);assert.equal(job.session,'external');assert.equal(job.mode,'nudge');assert.equal(job.manual,true);
  await page.evaluate(()=>{draft.submitting=false;draft.brief=Array(8).fill('Refine the Cuegrid timeline, preserve keyboard shortcuts, and make every control easy to understand.').join(' ');review()});
  for(const variant of [{width:1280,zoom:'',compact:false,name:'desktop'},{width:560,zoom:'',compact:true,name:'notch'},{width:390,zoom:'',compact:false,name:'narrow'},{width:640,height:450,zoom:'',compact:false,name:'zoom'}]){
   await page.setViewportSize({width:variant.width,height:variant.height||900});await page.evaluate(v=>{document.documentElement.style.zoom=v.zoom;document.body.classList.toggle('notch-first',v.compact);review()},variant);
   if(variant.compact){
    await page.evaluate(()=>updateBounds(true));
    assert.equal(await page.evaluate(()=>sent.findLast(m=>m.type==='layout').width),560,'native review requests room for the summary sections');
    await click('Edit task');await page.evaluate(()=>updateBounds(true));
    assert.equal(await page.evaluate(()=>sent.findLast(m=>m.type==='layout').width),432,'focused editor returns to the smaller notch');
    await click('Back to review');
   }
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page fits '+variant.name);
   assert.ok(await page.locator('#modal').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'dialog fits '+variant.name);
   assert.ok(await page.locator('#review-brief').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=16),'task is readable '+variant.name);
   await page.locator('[data-action="commit-review"]').scrollIntoViewIfNeeded();
   const primary=await page.locator('[data-action="commit-review"]').boundingBox(),notice=await page.locator('.review-manual').boundingBox();
   assert.ok(primary.y>=0&&primary.y+primary.height<=(variant.height||900)+1,'submit visible '+variant.name);assert.ok(notice.y>=0&&notice.y+notice.height<=primary.y+1,'paste consequence stays beside submit '+variant.name);
   await page.screenshot({path:path.join(shots,'tasktap-review-'+variant.name+'.png')});
  }
  await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>{document.body.classList.remove('notch-first');state.workerRouting={automatic:true,ranked:['codex'],reserve:12};workerRouting.receive({checkedAt:Date.now()/1000,agents:{codex:[{remaining:0,minutes:300,resetsAt:Date.now()/1000+3600}]}});captureDraft('','cuegrid','Inspect timeline');draft.brief=draft.text;review()});
  assert.ok(await page.locator('[data-action="commit-review"]').isDisabled());await click('Change destination');await page.getByLabel('Keep in reserve (%)').fill('42');
  await page.evaluate(()=>workerRouting.receive({checkedAt:Date.now()/1000,agents:{codex:[{remaining:90,minutes:300,resetsAt:Date.now()/1000+3600}]}}));
  assert.equal(await page.locator('#dialog-heading').innerText(),'Change destination');assert.equal(await page.getByLabel('Keep in reserve (%)').inputValue(),'42','async quota refresh preserves the open editor');
  await click('Review changes');assert.ok(await page.locator('[data-action="commit-review"]').isEnabled());
  // Short metadata stays on one line, with aligned sections and edit controls.
  await page.evaluate(()=>{
   state.workerRouting={automatic:false};state.sessions=[];showHome(true);
   captureDraft('','cuegrid','Make the rehearsal timer easier to read on mobile. Keep the keyboard shortcuts.');
   Object.assign(draft,{brief:draft.text,agent:'codex',agentChoice:'manual',host:'tasktap',reference:{kind:'website',value:'http://localhost:3000/rehearsal',app:'Safari'}});
   document.body.style.setProperty('--native-surface-width','560px');review();
  });
  for(const width of [592,390,320]){
   await page.setViewportSize({width,height:1000});
   await page.evaluate(()=>document.activeElement?.blur());
   assert.ok(await page.locator('#modal').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'summary fits '+width);
   assert.ok(await page.locator('.review-group-heading').evaluateAll(headings=>headings.every(heading=>{
    const title=heading.querySelector('h3').getBoundingClientRect(),edit=heading.querySelector('button').getBoundingClientRect();
    return Math.abs((title.top+title.bottom)/2-(edit.top+edit.bottom)/2)<1;
   })),'heading and edit controls align at '+width);
   assert.ok(await page.locator('.review-group-heading h3>span,.review-agent>span,.review-host,.review-conversation,.reference-address,.reference-origin').evaluateAll(items=>items.every(item=>{
    const range=document.createRange();range.selectNodeContents(item);return range.getClientRects().length===1;
   })),'short descriptors stay on one line at '+width);
   if(width===592){
    const cards=await page.locator('.review-destination,.review-reference').evaluateAll(items=>items.map(item=>{const r=item.getBoundingClientRect();return {top:r.top,bottom:r.bottom}}));
    assert.ok(Math.abs(cards[0].top-cards[1].top)<1&&Math.abs(cards[0].bottom-cards[1].bottom)<1,'summary sections share top and bottom edges');
   }
   await page.locator('#modal').screenshot({path:path.join(shots,'review-summary-'+width+'.png')});
  }
  await page.evaluate(()=>{draft.reference.value='https://example.com/a-very-long-reference-that-must-remain-readable-in-one-line/and-keep-its-complete-path';review()});
  const address=page.locator('.reference-address');
  assert.ok(await address.evaluate(el=>el.scrollWidth>el.clientWidth&&el.clientHeight<=24),'long reference scrolls instead of breaking into fragments');
  assert.match(await address.getAttribute('title'),/and-keep-its-complete-path$/,'complete reference remains available');
  assert.deepEqual(errors,[]);
  console.log('PASS: visible Task/Destination/Context, focused edits preserve draft, exact outgoing instructions, trust and failure retry, manual follow-up identity/consequence, redacted JSON copy/export, compact/narrow/200%-equivalent review.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
