const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
  page.setDefaultTimeout(15000);
 page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{window.messages=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>messages.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.evaluate(async()=>{
   state.firstRun={done:true};state.projects=[{id:'p',folder:'/tmp/workspace-navigation',name:'Tasktap project',aliases:[]},{id:'q',folder:'/tmp/workspace-secondary',name:'Another workspace',aliases:[]}];
   state.sessions=[];
   state.sessions.push({id:'agent',project:'p',agent:'codex',host:'tasktap',interactive:true,available:true,state:'Connected',task:'Implement a detailed workspace request with an intentionally long title that must fit on one line',log:[],result:'Result of this task'});
   state.decisions=[];state.captures=[];state.notes=[];
   Object.assign(state.workspaceDeck,{layouts:{p:{groups:[{id:'left',tabs:['terminal:agent','media:doc'],active:'terminal:agent'},{id:'right',tabs:['result:agent'],active:'result:agent'}],selected:0,ratio:50},q:{groups:[{id:'qgroup',tabs:['media:other'],active:'media:other'}],selected:0}},media:{doc:{id:'doc',project:'p',title:'Research document.md',kind:'text'},other:{id:'other',project:'q',title:'Reference image.png',kind:'image'}},openProjects:['p','q'],sidebarHidden:false,navigationExpanded:{p:true,q:true}});
   workspaceSettings.receive({root:'/tmp'});
   await workspaceDeck.receive([{event:'sessions',sessions:[{id:'agent',cwd:'/tmp/workspace-navigation',kind:'agent',title:'Agent',running:true},{id:'closed-view',cwd:'/tmp/workspace-navigation',kind:'shell',title:'Shell with a closed view',running:true}]}]);
   showWorkspace();go('p');
  });
  assert.equal(await page.locator('#nav .nav-workspace').count(),2);
  assert.equal(await page.locator('#nav [data-surface],#nav .nav-pane-label,#nav [data-action="workspace-expand"]').count(),0,'workspaces never duplicate tabs, surface descriptions, or disclosure controls');
  const row=page.locator('#nav [data-workspace="p"]'),project=row.locator('[data-action="workspace-project"]');
  assert.equal(await project.getAttribute('title'),'/tmp/workspace-navigation');
  assert.equal(await project.getAttribute('aria-current'),'page');
  const before=await page.evaluate(()=>messages.filter(m=>m.type==='workspace-terminal'&&['start','create'].includes(m.op)).length);
  await page.evaluate(()=>{workspaceDeck.outcome({session:'agent',state:'Complete',capture:'done',message:'Ready'});render()});
  assert.equal(await row.getAttribute('data-status'),'complete');
  assert.equal(await row.getByRole('img',{name:'Result ready'}).count(),1);
  await page.evaluate(()=>{state.decisions=[{id:'question',session:'agent',q:'Choose a direction',choices:['A','B']}];render()});
  assert.equal(await row.getAttribute('data-status'),'input','pending input outranks an unread completion');
  await page.emulateMedia({reducedMotion:'reduce'});
  // A pending terminal refresh can replace the sidebar while media styles settle.
  await page.waitForFunction(()=>{
    const status=document.querySelector('#nav [data-workspace="p"] .nav-workspace-status');
    return status?.isConnected && getComputedStyle(status).animationName==='none';
  });
  await project.click();
  assert.equal(await row.getAttribute('data-status'),'input','opening the workspace cannot dismiss a pending decision');
  await page.waitForFunction(()=>document.activeElement?.classList.contains('xterm-helper-textarea'));
  await page.evaluate(()=>{state.decisions=[];render()});
  assert.equal(await row.getAttribute('data-status'),null,'acknowledged results do not leave a stale badge');
  await page.evaluate(()=>{workspaceDeck.outcome({session:'agent',state:'Complete',capture:'old',message:'Old result',recovered:true});render()});
  assert.equal(await row.getAttribute('data-status'),null,'historical recovery does not claim a new completion');
  await page.evaluate(()=>{workspaceDeck.outcome({session:'agent',state:'Failed',capture:'failed',message:'Could not finish'});go('overview')});
  assert.equal(await row.getAttribute('data-status'),'failure','attention remains visible away from the workspace');
  await project.click();
  await page.waitForFunction(()=>document.activeElement?.classList.contains('xterm-helper-textarea'));
  assert.equal(await row.getAttribute('data-status'),null);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='workspace-terminal'&&['start','create'].includes(m.op)).length),before,'workspace navigation never spawns a process');
  const width=(await page.locator('#sidebar').boundingBox()).width;
  await page.locator('#nav [data-action="view"][data-id="overview"]').click();
  assert.equal((await page.locator('#sidebar').boundingBox()).width,width,'Home uses the same sidebar geometry');
  assert.equal(await project.isVisible(),true,'the compact workspace row remains available on Home');
  await page.getByRole('button',{name:'Toggle sidebar',exact:true}).click();
  assert.equal(await page.locator('#sidebar').isVisible(),false);
  await page.evaluate(()=>go('p'));
  assert.equal(await page.locator('#sidebar').isVisible(),false,'collapsed preference survives entering a workspace');
  await page.getByRole('button',{name:'Toggle sidebar',exact:true}).click();
  await page.evaluate(()=>go('sessions'));
  assert.equal((await page.locator('#sidebar').boundingBox()).width,width,'History uses the same sidebar geometry');
  assert.equal(await page.getByRole('button',{name:'Toggle sidebar',exact:true}).getAttribute('aria-expanded'),'true');
  await page.setViewportSize({width:620,height:760});
  await page.getByRole('button',{name:'Toggle sidebar',exact:true}).click();
  assert.equal(await page.locator('#sidebar').isVisible(),true,'compact viewport reveals the same sidebar');
  await page.evaluate(()=>go('p'));
  await page.getByRole('button',{name:'Focus surface',exact:true}).click();
  assert.equal(await page.evaluate(()=>state.workspaceDeck.layouts.p.focus),true);
  await page.getByRole('button',{name:'Toggle sidebar',exact:true}).click();
  assert.equal(await page.evaluate(()=>state.workspaceDeck.layouts.p.focus),false,'compact sidebar toggle exits focus mode');
  assert.equal(await page.locator('#sidebar').isVisible(),true);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);
  console.log('PASS: workspace rows only, attention/result priority, reduced motion, stable focus, unified sidebar state..');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
async function expectCount(locator,count){await locator.nth(count-1).waitFor();assert.equal(await locator.count(),count)}
