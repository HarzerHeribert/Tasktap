const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const shots=process.env.TASKTAP_SCREENSHOTS||'/tmp';
require('node:fs').mkdirSync(shots,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',e=>{errors.push(String(e));console.error(String(e))});
  await page.addInitScript(()=>{window.messages=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>messages.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.evaluate(()=>{
   state.firstRun={done:true};state.projects=[{id:'cuegrid',name:'Cuegrid',folder:'/tmp/cuegrid',aliases:[]}];state.notes=[];
   const row=(id,task,result,extra={})=>({id,project:'cuegrid',agent:'codex',host:'tasktap',interactive:true,available:true,state:'Complete',task,result,log:[],...extra});
   state.sessions=[
    row('unknown','Make Cuegrid feel calm, fast, and native. The current implementation needs a complete pass over every interaction, especially how users switch between tracks, move clips, and discover the keyboard shortcuts.','External result',{host:'',inbox:'manual',updatedAt:Date.now()}),
    row('older','Rework Cuegrid’s onboarding into a clear first-run experience. Every step should teach one thing and lead people naturally into their first useful project without adding distractions.','Earlier completed result'),
    row('newest','Please go through the complete Cuegrid application and improve the polish in every screen. Make it consistent and carefully test the edge cases.','Latest completed result',{sessionName:'Refine Cuegrid’s multi-track timeline and keyboard shortcuts'}),
    row('hidden-result','An earlier archived result','Archived result'),
    row('running','Make Cuegrid’s export flow clear and dependable. Handle every format carefully, keep progress visible, and provide a useful result when the export finishes.',null,{agent:'claude',state:'Running'}),
    row('decision','Review the Cuegrid launch checklist and release plan',null,{agent:'claude',state:'Needs input'})
   ];
   state.decisions=[{id:'question',session:'decision',q:'Should the first Cuegrid release include cloud sharing, or should we keep this release focused on editing and exports so the core experience feels complete?',choices:['Include sharing','Focus on editing']}];
   state.captures=[{id:'request-clock',session:'unknown',receipt:'Complete',result:'External result',time:'23:59'}];
   Object.assign(state.workspaceDeck,{sidebarHidden:false,openProjects:['cuegrid'],navigationExpanded:{cuegrid:false},layouts:{cuegrid:{groups:[{id:'cuegrid-pane',tabs:[],active:null}],selected:0}},activity:[
    {id:'newest',kind:'complete',body:'Latest completed result',time:Date.now()-15*60*1000,read:true},
    {id:'older',kind:'complete',body:'Earlier completed result',time:Date.now()-25*60*60*1000,read:true},
    {id:'unknown',kind:'complete',body:'A previous result that has been replaced',time:Date.now()+60000,read:true}
   ]});
   appAppearance.setTheme('dark');showWorkspace();go('overview');
  });
  const results=page.locator('[data-home-section="results"]');
  assert.deepEqual(await results.locator('.session-row').evaluateAll(rows=>rows.map(el=>el.dataset.id)),['newest','older','unknown'],'only matching completion receipts determine result ordering');
  assert.equal(await results.getByText('Result ready',{exact:true}).count(),0,'results do not repeat an unhelpful status column');
  assert.equal(await results.locator('.row-state').count(),0);
  assert.equal(await results.locator('[data-id="unknown"] time').count(),0,'request clock, unrelated old receipts, and session modification times are not completion dates');
  assert.equal(await results.locator('time').count(),2);
  assert.match(await results.locator('time').first().getAttribute('title'),/^Result received /);
  const unnamed=results.locator('[data-id="unknown"]');
  assert.equal(await unnamed.locator('.row-title').innerText(),'Make Cuegrid feel calm, fast, and native.','only an unnamed prompt with a clear sentence boundary is shortened for display');
  assert.match(await unnamed.locator('.row-title').getAttribute('title'),/complete pass over every interaction/);
  assert.match(await unnamed.getAttribute('aria-label'),/complete pass over every interaction/,'assistive technology retains the full title');
  assert.equal(await results.locator('[data-id="newest"] .row-title').innerText(),'Refine Cuegrid’s multi-track timeline and keyboard shortcuts','a session name remains unchanged');
  assert.ok(await results.locator('.row-title').evaluateAll(rows=>rows.every(el=>getComputedStyle(el).whiteSpace==='nowrap'&&getComputedStyle(el).textOverflow==='ellipsis')));
  assert.ok(await results.locator('.session-row').evaluateAll(rows=>rows.every(el=>el.getBoundingClientRect().height<=64)),'result rows stay compact');
  assert.equal(await page.locator('[data-home-section="attention"] .session-row').getAttribute('data-action'),'notch');
  assert.equal(await page.locator('[data-home-section="attention"] .session-row').getAttribute('data-id'),'question');
  assert.equal(await page.locator('[data-home-section="attention"] .row-title').evaluate(el=>getComputedStyle(el).whiteSpace),'normal','decision questions remain fully readable');
  assert.match(await page.locator('[data-home-section="progress"] .row-state').innerText(),/Running/);
  await results.locator('[data-id="newest"]').focus();
  assert.equal(await results.locator('[data-id="newest"]').evaluate(el=>el.matches(':focus-visible')),true);
  await page.evaluate(()=>document.activeElement.blur());await results.locator('[data-id="newest"]').hover();
  await page.screenshot({path:path.join(shots,'tasktap-home-overview-desktop.png')});
  await results.locator('[data-id="newest"]').click();
  assert.match(await page.locator('.deck-document').innerText(),/Latest completed result/,'managed results still open the exact session report');
  await page.evaluate(()=>go('overview'));
  await page.locator('[data-home-section="results"] [data-id="unknown"]').click();
  assert.match(await page.locator('#dialog-heading').innerText(),/complete pass over every interaction/,'results without a Tasktap terminal still open their session details');
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.locator('[data-home-section="results"]').getByRole('button',{name:'History',exact:true}).click();
  assert.equal(await page.evaluate(()=>view),'sessions');
  assert.equal(await page.locator('#main .home-session-row').count(),0,'session history keeps its existing presentation');
  assert.match(await page.locator('#main .session-row[data-id="unknown"] .row-title').innerText(),/complete pass over every interaction/,'history does not shorten prompt titles');
  for(const theme of ['light','ocean','dark']){
   await page.evaluate(theme=>{appAppearance.setTheme(theme);go('overview')},theme);
   const colors=await page.locator('.home-row-project').first().evaluate(el=>({fg:getComputedStyle(el).color,bg:getComputedStyle(document.querySelector('.shell')).backgroundColor}));
   assert.notEqual(colors.fg,colors.bg,theme+' metadata remains visible');
  }
  await page.setViewportSize({width:430,height:1100});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Home does not overflow a narrow viewport');
  assert.ok(await page.locator('.home-row-project').evaluateAll(rows=>rows.every(el=>getComputedStyle(el).display!=='none'&&el.getBoundingClientRect().width>20)),'project identity stays visible at narrow widths');
  assert.ok(await page.locator('[data-home-section="results"] .row-title').evaluateAll(rows=>rows.every(el=>el.getBoundingClientRect().height<24)),'narrow result titles remain a single line');
  await page.evaluate(()=>document.activeElement.blur());await page.mouse.move(0,0);
  await page.screenshot({path:path.join(shots,'tasktap-home-overview-narrow.png')});
  assert.deepEqual(errors,[]);
  console.log('PASS: compact Home rows, full title access, project metadata, safe completion dates/order, exact result routes, history isolation, and narrow layout.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
