// Model replies are fixtures: exercise real review/routing/delivery, without a paid worker.
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:900},reducedMotion:'reduce'}),errors=[];
  page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.sent=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>sent.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href+'#workspace');
  await page.evaluate(()=>{
   state.firstRun={done:true};state.projects=[{id:'tasktap',folder:'/projects/tapped',name:'Tasktap',aliases:['task tap']},{id:'cuegrid',folder:'/projects/cuegrid',name:'Cuegrid',aliases:[]}];
   const row=(id,task,project='tasktap')=>({id,project,task,agent:'codex',host:'tasktap',interactive:true,managed:true,available:true,inbox:'tasktap',state:'Running',log:[]});
   state.sessions=[row('testing','Verify monitor overlays'),row('adjustment','Adjust notch appearance'),row('cuegrid-session','Refine the timeline','cuegrid'),{...row('stopped','Interrupted overlay work'),state:'Interrupted'}];
   state.captures=[{id:'earlier',session:'testing',brief:'Test Tasktap on screens without a physical notch.',receipt:'Delivered'}];state.decisions=[];
   aiConnections.receive({choice:'local',workers:{},workerHealth:{codex:'signedIn'},models:{},keys:{},accounts:[]});state.workerRouting={automatic:false};
  });
  const begin=async(text,target='',project='')=>page.evaluate(({text,target,project})=>{
   dismissCard();view='overview';captureDraft(target,project,text);editDraft();interpret();prepareHandoff();
   return sent.findLast(m=>m.type==='route');
  },{text,target,project});
  const finish=async(reply)=>page.evaluate(reply=>finishRouting(draft.routing.id,{source:'apple',...reply}),reply);
  const response=(route,session,brief,quote)=>({mode:'nudge',project:route.input.projects.find(p=>p.name==='Tasktap').index,
   session:route.input.sessions.find(s=>s.originalTask===session).index,brief,routeConfidence:'clear',routeQuote:quote,
   routeEvidence:session+' matches the requested destination and the recent screen test.',sessionCandidates:[],projectCandidates:[],question:''});
  const text="So could you follow that up to the testing not adjustment session, the glow on the note should also be made better, just a small tab coming out of the screen top on screens without a notch, above the menu bar.";
  let route=await begin(text);
  assert.ok(route.input.sessions.some(s=>s.originalTask==='Verify monitor overlays'),'semantic candidates are not restricted to shared words');
  assert.ok(!route.input.sessions.some(s=>s.originalTask==='Interrupted overlay work'));
  assert.equal(route.input.recentCaptures[0].state,'Delivered');assert.equal(route.input.recentCaptures.length,1);
  const brief='Improve the notch glow. On displays without a physical notch, use a small tab attached to the top edge above the menu bar.\nVerify collapsed and expanded states.';
  await finish(response(route,'Verify monitor overlays',brief,'testing not adjustment session'));
  assert.equal(await page.locator('#review-brief').innerText(),brief);
  assert.equal(await page.evaluate(()=>draft.session),'testing');assert.equal(await page.evaluate(()=>draft.project),'tasktap');
  await page.getByText('Why this session?',{exact:true}).click();
  assert.match(await page.locator('.review-match').innerText(),/Verify monitor overlays.*testing/s);
  await page.getByText('Original capture',{exact:true}).click();assert.equal(await page.locator('.review-original p').innerText(),text);
  await page.getByRole('button',{name:'Use original request',exact:true}).click();assert.equal(await page.locator('#review-brief').innerText(),text);
  await page.getByRole('button',{name:'Use prepared task',exact:true}).click();assert.equal(await page.locator('#review-brief').innerText(),brief);
  await page.getByRole('button',{name:'Edit task',exact:true}).click();await page.getByLabel('Task',{exact:true}).fill(brief+' Keep the existing shortcuts.');await page.getByRole('button',{name:'Save task',exact:true}).click();
  assert.equal(await page.evaluate(()=>draft.session),'testing','editing wording preserves the target');
  assert.equal(await page.evaluate(()=>sent.filter(m=>m.type==='enqueue').length),0,'preparation never starts a worker');
  for(const width of [1100,390]){
   await page.setViewportSize({width,height:900});
   assert.ok(await page.locator('#modal').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
   if(process.env.TASKTAP_SCREENSHOTS)await page.screenshot({path:path.join(process.env.TASKTAP_SCREENSHOTS,'prepared-task-'+width+'.png')});
  }
  await page.setViewportSize({width:1100,height:900});
  await page.getByRole('button',{name:'Send nudge',exact:true}).click();
  const job=await page.evaluate(()=>sent.findLast(m=>m.type==='enqueue').job);
  assert.equal(job.session,'testing');assert.equal(job.transcript,text);assert.match(job.outgoing,/Keep the existing shortcuts/);assert.match(job.outgoing,/send acknowledgement confirms delivery only/);
  await page.evaluate(()=>draft.submitting=false);
  // Fixed UI destinations survive a different model suggestion.
  route=await begin('Improve the glow too.','adjustment');
  await finish(response(route,'Verify monitor overlays','Improve the glow.','glow'));
  assert.equal(await page.evaluate(()=>draft.session),'adjustment');
  route=await begin('Improve the glow too.','testing');
  const indexed=response(route,'Verify monitor overlays','Follow up to session '+route.input.sessions.find(s=>s.originalTask==='Verify monitor overlays').index+'. Improve the glow.','glow');
  await finish(indexed);assert.match(await page.locator('#review-brief').innerText(),/Verify monitor overlays/);assert.doesNotMatch(await page.locator('#review-brief').innerText(),/session \d/);
  route=await begin(text);
  await finish({...response(route,'Verify monitor overlays','Improve the notch glow.','testing not adjustment session'),constraints:['above the menu bar','above the menu bar','Invented requirement: remove all controls.']});
  const retained=await page.locator('#review-brief').innerText();
  assert.match(retained,/• above the menu bar/);assert.equal(retained.match(/above the menu bar/g).length,1);assert.doesNotMatch(retained,/Invented requirement/);
  route=await begin('Refine the timeline.','','tasktap');
  assert.ok(!route.input.projects.some(p=>p.name==='Cuegrid'),'a fixed workspace excludes unrelated project context');
  await finish({...response(route,'Verify monitor overlays','Refine the timeline.','timeline'),project:999});
  assert.equal(await page.evaluate(()=>draft.mode),'ask');assert.equal(await page.evaluate(()=>draft.project),'tasktap');assert.equal(await page.evaluate(()=>draft.session),'');
  // Ambiguity must replace a tentative lexical choice, never silently keep it.
  route=await begin('Follow up about the notch.');
  await finish({mode:'nudge',brief:'Check the notch.',project:-1,session:-1,routeConfidence:'ambiguous',routeQuote:'notch',routeEvidence:'Two conversations fit.',
   sessionCandidates:route.input.sessions.filter(s=>s.project===route.input.projects.find(p=>p.name==='Tasktap').index).map(s=>s.index),projectCandidates:[],question:'Send this to testing or appearance adjustments?'});
  assert.match(await page.locator('#notch h2').innerText(),/Verify monitor overlays.*Adjust notch appearance|Adjust notch appearance.*Verify monitor overlays/);
  assert.equal(await page.evaluate(()=>draft.session),'');
  await page.locator('#notch [data-action="choose-target"][data-id="testing"]').click();assert.equal(await page.evaluate(()=>draft.sessionChoice),'testing');
  // Out-of-range, ungrounded and stale results cannot select another session.
  for(const invalid of ['index','quote','stale','contradiction','name']){
   route=await begin('Follow up about the screen test.');
   const reply=response(route,'Verify monitor overlays','Check the screen test.','screen test');
   if(invalid==='index')reply.session=999;
   if(invalid==='quote')reply.routeQuote='not words the user supplied';
   if(invalid==='contradiction')reply.question='Is the adjustment session correct?';
   if(invalid==='name')reply.routeEvidence='A made up notch session matches.';
   if(invalid==='stale')await page.evaluate(()=>sess('testing').available=false);
   await finish(reply);assert.equal(await page.evaluate(()=>draft.session),'',invalid+' cannot select a target');
   await page.evaluate(()=>sess('testing').available=true);
  }
  // Unknown shorthand is a question; no arbitrary latest-session guess.
  await page.evaluate(()=>state.captures=[]);route=await begin('Yes do it.');
  await finish({mode:'nudge',brief:'Yes do it.',project:-1,session:-1,routeConfidence:'unknown',routeEvidence:'',routeQuote:'',sessionCandidates:[],projectCandidates:[],question:''});
  assert.equal(await page.evaluate(()=>draft.session),'');assert.equal(await page.locator('#notch h2').innerText(),'Which session?');
  // Remote context is disclosed before transport. Local fallback calls the local model.
  await page.evaluate(()=>aiConnections.receive({choice:'openai',workers:{},models:{openai:'fixture'},keys:{openai:true},accounts:[]}));
  const before=await page.evaluate(()=>sent.filter(m=>m.type==='route').length);await begin('Improve the timeline.');
  assert.equal(await page.evaluate(()=>sent.filter(m=>m.type==='route').length),before);
  assert.match(await page.locator('#modal').innerText(),/Prepare with OpenAI/);
  await page.getByText('What will be sent',{exact:true}).click();assert.match(await page.locator('#modal pre').innerText(),/recentCaptures/);
  await page.getByRole('button',{name:'Prepare on this Mac',exact:true}).click();
  assert.equal(await page.evaluate(()=>sent.findLast(m=>m.type==='route').provider),'local');
  assert.deepEqual(errors,[]);
  console.log('PASS: contextual candidates, faithful review/original toggle, explicit destinations, ambiguity, invalid/stale replies, shorthand, consent, and exact follow-up delivery. Model quality is not simulated by this fixture.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
