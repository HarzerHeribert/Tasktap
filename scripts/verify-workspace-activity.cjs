/* Working indicators follow actual session state, never an open shell or old report. */
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const fs=require('node:fs');
const shots=process.env.TASKTAP_SCREENSHOTS||'/tmp/tasktap-workspace-activity';
fs.mkdirSync(shots,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:850},reducedMotion:'no-preference'}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{window.messages=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>messages.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.addStyleTag({path:path.resolve('prototype/workspace-activity.css')});
  await page.evaluate(async()=>{
   state.firstRun={done:true};state.projects=[{id:'p',name:'Tasktap',folder:'/fixture/tasktap',aliases:[]},{id:'q',name:'Other project',folder:'/fixture/tasktap-other',aliases:[]}];
   const row=(id,project,extra={})=>({id,project,task:id,agent:'codex',host:'tasktap',interactive:true,managed:true,available:true,state:'Running',log:[],...extra});
   state.sessions=[row('working','p',{sessionName:'Refine "tab" & glow'}),row('folder','/fixture/tasktap/',{task:'Check the top edge'}),row('other','q',{task:'Test sidebar links'}),
    row('connected','p',{state:'Connected'}),row('interrupted','p',{state:'Interrupted'}),row('unavailable','p',{available:false}),row('stopped','p'),
    row('in-transit','p')];
   state.captures=[];state.decisions=[];
   Object.assign(state.workspaceDeck,{openProjects:['p','q'],layouts:{},background:{},closedWorkspaces:{},activity:[],seen:{},sidebarHidden:false});
   await workspaceDeck.receive([{event:'sessions',sessions:[{id:'stopped',cwd:'/fixture/tasktap',kind:'agent',running:false},{id:'idle-shell',cwd:'/fixture/tasktap',kind:'shell',running:true}]}]);
   showWorkspace();go('overview');
  });
  assert.deepEqual(await page.evaluate(()=>workspaceNavigation.workingSessions().map(s=>s.id)),['working','folder','other','in-transit']);
  assert.deepEqual(await page.evaluate(()=>{state.workspaceDeck.closedWorkspaces.p=true;return workspaceNavigation.workingSessions().map(s=>s.id)}),['other']);
  await page.evaluate(()=>{delete state.workspaceDeck.closedWorkspaces.p});
  const workspace=page.locator('[data-workspace="p"]'),folderIcon=workspace.locator('.nav-workspace-name>.icon');
  assert.equal(await workspace.getAttribute('data-working'),'true');
  assert.equal(await workspace.getAttribute('data-status'),'working');
  assert.match(await workspace.locator('.nav-workspace-name').getAttribute('title'),/Refine "tab" & glow.*Check the top edge/);
  assert.equal(await folderIcon.evaluate(el=>getComputedStyle(el).animationName),'workspace-working');
  await page.evaluate(()=>document.body.classList.add('surface-hidden'));
  assert.equal(await folderIcon.evaluate(el=>getComputedStyle(el).animationPlayState),'paused');
  await page.evaluate(()=>document.body.classList.remove('surface-hidden'));
  // Saved attention retains priority without hiding concurrent working activity.
  await page.evaluate(()=>{state.workspaceDeck.activity=[{id:'working',kind:'failure',title:'Old failure',body:'Failure details',read:false,time:Date.now()}];render()});
  assert.equal(await workspace.getAttribute('data-status'),'failure');assert.equal(await workspace.getAttribute('data-working'),'true');
  assert.equal(await folderIcon.evaluate(el=>getComputedStyle(el).animationName),'workspace-working');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await folderIcon.evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.screenshot({path:path.join(shots,'workspace-working.png')});
  await page.evaluate(()=>{state.captures=[];sess('in-transit').state='Connected';showHome()});
  const home=page.locator('#notch-home');
  assert.equal(await home.locator('h1').innerText(),'Working now');
  assert.equal(await home.locator('.notch-work-row').count(),3);
  assert.match(await home.locator('.notch-work-row').first().innerText(),/Refine "tab" & glow.*Tasktap.*Codex/s);
  assert.equal(await page.locator('body').getAttribute('data-signal'),'working');
  const first=home.locator('.notch-work-row').first();await first.focus();
  await page.evaluate(()=>{sess('working').sessionName='Polish the top-edge tab';drawHome()});
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.id),'working','status refresh preserves the focused conversation');
  await first.click();
  assert.equal(await page.locator('[data-action="deck-tab"][data-id="terminal:working"]').count(),1,'the named notch action opens that exact managed session');
  assert.equal(await page.evaluate(()=>view),'p');
  await page.evaluate(()=>showHome());
  await page.setViewportSize({width:430,height:780});
  assert.ok(await home.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'task names fit a narrow notch');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await home.locator('.notch-work-mark').first().evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.screenshot({path:path.join(shots,'notch-working.png')});
  // Capture and decision signals remain ahead of background work.
  await page.evaluate(()=>{draft={routing:{id:'preparing'}};updateSignal()});
  assert.equal(await page.locator('body').getAttribute('data-signal'),'working');
  await page.evaluate(()=>{draft=null;state.captures=[{id:'delivery',session:'in-transit',receipt:'Queued'}];state.decisions=[{id:'question',session:'working',q:'Which approach?',choices:['One','Two']}];drawHome()});
  assert.equal(await home.locator('h1').innerText(),'Which approach?');
  assert.equal(await home.locator('.notch-work-row').count(),0);
  assert.equal(await page.locator('body').getAttribute('data-signal'),'sending','in-transit follow-up remains a delivery signal');
  await page.evaluate(()=>{state.captures=[];state.decisions=[];for(const s of state.sessions)s.state='Connected';drawHome();render()});
  assert.equal(await home.locator('h1').innerText(),'Ready to capture');
  assert.equal(await workspace.getAttribute('data-working'),'false');
  assert.equal(await page.locator('body').getAttribute('data-signal'),'idle','open shells and connected agents never claim active work');
  assert.deepEqual(errors,[]);
  console.log('PASS: project/folder working identity, lifecycle and discovery gates, attention priority, task-specific notch, stable focus, narrow layout and Reduce Motion.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
