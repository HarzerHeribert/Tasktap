// Activity indexes current work and exact receipts; report prose stays in the reader.
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
const shots=process.env.TASKTAP_SCREENSHOTS||'/tmp';
require('node:fs').mkdirSync(shots,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:900},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.sent=[];window.webkit={messageHandlers:{workspace:{postMessage:message=>sent.push(message)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href+'#workspace');
  await page.evaluate(()=>{
   state.firstRun={done:true};state.projects=[{id:'tasktap',name:'Tasktap',folder:'/tmp/activity-tasktap',aliases:[]},{id:'cuegrid',name:'Cuegrid',folder:'/tmp/activity-cuegrid',aliases:[]}];
   const session=(id,task,status,extra={})=>({id,project:'tasktap',agent:'codex',host:'tasktap',interactive:true,available:true,task,state:status,log:[],...extra});
   state.sessions=[session('notch','Show usage plans in the notch. This task originally had a long rambling description.','Complete',{sessionName:'Refine the notch glow and top edge',result:'Latest report body.'}),session('working','Improve request preparation','Running'),session('question','Review the export destination','Needs input',{project:'cuegrid',agent:'claude'}),session('idle','An open connection is not ongoing work','Connected'),session('stale','An unavailable session is not ongoing work','Running',{available:false}),session('interrupted','Check the display geometry','Interrupted')];
   state.decisions=[{id:'destination-question',session:'question',q:'Which export folder should this project use?',choices:['Documents','Project folder']}];
   state.captures=[{id:'new-report',session:'notch',project:'tasktap',receipt:'Complete',result:'Latest report body.'},{id:'old-report',session:'notch',project:'tasktap',receipt:'Complete',result:'Earlier delivery report. Implementation was delegated, not completed.'}];
   Object.assign(state.workspaceDeck,{activity:[{kind:'complete',id:'notch',capture:'new-report',title:'A stale title',body:'Latest report body.',time:Date.now(),read:false},{kind:'complete',id:'notch',capture:'old-report',title:'An even older title',body:'Earlier delivery report. Implementation was delegated, not completed.',time:Date.now()-60000,read:false},{kind:'failure',id:'missing',capture:'missing-report',title:'Check the installer',project:'cuegrid',agent:'claude',body:'Fixture failure: the installer could not open.',time:Date.now()-120000,read:false}],layouts:{},openProjects:['tasktap','cuegrid'],background:{},closedWorkspaces:{}});
   appAppearance.setTheme('dark');showWorkspace();go('overview');workspaceDeck.activity();
  });
  const feed=page.locator('#activity-feed');
  assert.deepEqual(await feed.locator('[data-activity-section]').evaluateAll(sections=>sections.map(section=>section.dataset.activitySection)),['attention','working','reports']);
  assert.equal(await feed.locator('[data-activity-section="working"] .activity-row').count(),1,'connected and unavailable sessions do not masquerade as work');
  assert.match(await feed.locator('[data-activity-section="working"]').innerText(),/Improve request preparation/);
  assert.match(await feed.locator('[data-activity-section="attention"]').innerText(),/Which export folder.*Interrupted/s);
  assert.equal(await feed.locator('[data-activity-session="notch"]').count(),1,'repeated receipts are grouped into one conversation');
  assert.equal(await feed.locator('[data-activity-session="notch"] > .activity-row').count(),1);
  assert.match(await feed.locator('[data-activity-session="notch"] > .activity-row').innerText(),/Refine the notch glow and top edge/,'the real current session name replaces stale saved titles');
  assert.ok(!(await feed.innerText()).includes('Latest report body.'),'report paragraphs are absent from the work index');
  assert.ok(!(await feed.innerText()).includes('Implementation was delegated'),'reports remain intact behind an explicit read action');
  assert.equal(await page.evaluate(()=>state.workspaceDeck.activity.length),3,'grouping preserves receipt history');
  assert.equal(await page.evaluate(()=>sent.filter(message=>message.type==='enqueue').length),0,'opening activity starts no work');
  await page.evaluate(()=>{
   for(const [id,task,status,extra] of [['queued','Prepare the reviewed request','Queued',{}],['opening','Open the selected agent','Opening',{}]])state.sessions.push({id,task,state:status,project:'tasktap',agent:'codex',host:'tasktap',available:true,interactive:true,log:[],...extra});
   workspaceDeck.refreshActivity();
  });
  const handoffs=feed.locator('[data-activity-section="handoffs"]');
  assert.equal(await feed.locator('[data-activity-section="working"] .activity-row').count(),1,'queued and opening handoffs are not counted as actual work');
  assert.equal(await handoffs.locator('.activity-row').count(),2,'every in-flight handoff remains visible');
  assert.deepEqual(await handoffs.locator('.activity-state').allTextContents(),['Queued','Opening']);
  assert.match(await feed.locator('.activity-summary').innerText(),/^1 working · 2 handoffs/);
  await page.evaluate(()=>{
   state.sessions=state.sessions.filter(session=>!['queued','opening'].includes(session.id));
   state.captures=state.captures.filter(capture=>capture.id!=='sending-receipt');workspaceDeck.refreshActivity();
  });
  const current=feed.locator('[data-activity-section="working"] .activity-row');await current.focus();
  await page.evaluate(()=>{state.sessions.find(session=>session.id==='notch').sessionName='Refine the notch on external displays';workspaceDeck.refreshActivity()});
  assert.equal(await current.evaluate(element=>element===document.activeElement),true,'background updates preserve the exact focused control');
  const history=feed.locator('[data-activity-history="notch"]');await history.locator('summary').click();
  assert.equal(await history.locator('[data-id="old-report"]').isVisible(),true);
  await page.evaluate(()=>{state.sessions.find(session=>session.id==='working').task='Prepare a faithful work package';workspaceDeck.refreshActivity()});
  assert.ok(await history.evaluate(element=>element.open),'background updates preserve expanded report history');
  await history.locator('[data-id="old-report"]').click();
  assert.match(await page.locator('.deck-preview:not([hidden]) .deck-document').innerText(),/Earlier delivery report/,'an earlier report opens its exact receipt instead of the latest session result');
  assert.ok(!(await page.locator('.deck-preview:not([hidden]) .deck-document').innerText()).includes('Latest report body.'));
  await page.evaluate(()=>workspaceDeck.activity());
  await feed.locator('[data-id="missing-report"]').click();
  assert.match(await page.locator('.result-prose').innerText(),/installer could not open/,'reports survive removal of their source session');
  await page.evaluate(()=>workspaceDeck.activity());
  await feed.locator('[data-id="destination-question"]').click();
  assert.match(await page.locator('#notch').innerText(),/Which export folder/,'a question opens that exact request');
  await page.evaluate(()=>{if($('#notch').open)$('#notch').close();workspaceDeck.activity()});
  for(const variant of [{width:1200,height:900,name:'desktop'},{width:430,height:800,name:'notch'},{width:320,height:700,name:'narrow'}]){
   await page.setViewportSize(variant);
   assert.ok(await feed.evaluate(element=>element.scrollWidth<=element.clientWidth+1),'activity fits '+variant.name);
   assert.ok(await page.locator('#modal').evaluate(element=>element.scrollWidth<=element.clientWidth+1),'dialog fits '+variant.name);
   assert.ok(await feed.locator('.activity-row').evaluateAll(rows=>rows.every(row=>row.getBoundingClientRect().height>=44)),'actions remain usable '+variant.name);
   await page.screenshot({path:path.join(shots,'tasktap-activity-'+variant.name+'.png')});
  }
  await page.setViewportSize({width:640,height:900});await page.evaluate(()=>document.documentElement.style.zoom='2');
  assert.ok(await feed.evaluate(element=>element.scrollWidth<=element.clientWidth+1),'activity fits 200% zoom');
  await page.evaluate(()=>{document.documentElement.style.zoom='';state.sessions=[];state.decisions=[];state.workspaceDeck.activity=[];workspaceDeck.refreshActivity()});
  assert.match(await feed.innerText(),/You’re all caught up/);assert.equal(await feed.locator('.activity-row').count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS: current work and questions, truthful interrupted/unavailable states, grouped receipts, exact historical/orphan reports, keyboard focus, live refresh and responsive Activity.');
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
