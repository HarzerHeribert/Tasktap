const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{window.sent=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>sent.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href+'#workspace');
  await page.evaluate(()=>{
   state.firstRun={done:true};state.decisions=[];
   aiConnections.receive({choice:'local',workerHealth:{claude:'signedIn',codex:'signedIn'},workers:{claude:'Claude plan login',codex:'API key login'},accounts:[]});
  });
  assert.equal(await page.locator('.usage-workspace .usage-meter').count(),1,'API key sign-ins are excluded');
  assert.match(await page.locator('.usage-workspace .usage-meter').getAttribute('aria-label'),/unavailable/);
  await page.evaluate(()=>{
   aiConnections.receive({choice:'local',workerHealth:{claude:'signedIn',codex:'signedIn'},workers:{claude:'Claude plan login',codex:'ChatGPT login'},accounts:[]});
   const now=Date.now()/1000;
   workerRouting.receive({checkedAt:now,agents:{claude:[{remaining:32,minutes:10080,resetsAt:now+172800},{remaining:58,minutes:300,resetsAt:now+7200}]},subscriptions:Object.fromEntries(['codex','gemini','cursor','grok','glm'].map(id=>[id,{plan:'Fixture paid plan',windows:[{remaining:75,minutes:id==='gemini'?1440:10080,label:'Daily',resetsAt:now+86400}]}]))});
  });
  assert.equal(await page.locator('.usage-workspace .usage-meter').count(),6);
  await page.evaluate(()=>{state.projects=[{id:'usage-project',name:'Usage project',folder:'/tmp/usage-project',aliases:[]}];go('usage-project')});
  await page.waitForTimeout(30);
  assert.equal(await page.locator('.deck-project:not([hidden]) .usage-deck .usage-meter').count(),6,'persistent meters are in the actual terminal workspace toolbar');
  await page.evaluate(()=>go('overview'));
  assert.equal(await page.locator('.usage-workspace [data-usage-agent=claude] .usage-progress').first().getAttribute('stroke-dasharray'),'68 100');
  await page.locator('.usage-workspace [data-usage-agent=gemini]').click();
  assert.match(await page.locator('.usage-details-host').innerText(),/Daily.*75|Daily.*25/s);
  assert.equal(await page.locator('.usage-details-host').count(),1);
  await page.getByRole('button',{name:'Close usage details',exact:true}).click();
  assert.equal(await page.locator('.usage-details-host').count(),0);
  const out='output/usage-app';fs.mkdirSync(out,{recursive:true});
  for(const width of [1280,560,390,320]){
   await page.setViewportSize({width,height:900});
   await page.evaluate(()=>{showHome(true);captureDraft('','','Check the usage rings.');Object.assign(draft,{brief:draft.text,agent:'codex',agentChoice:'manual'});review();updateBounds(true)});
   await page.waitForTimeout(50);
   assert.equal(await page.locator('.usage-modal .usage-meter').count(),6);
   assert.ok(await page.locator('#modal').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'review fits '+width);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page fits '+width);
   const b=await page.locator('.usage-modal .usage-meter>svg').first().boundingBox();assert.ok(b.width<=32&&b.width>=26);
   await page.locator('#modal').screenshot({path:out+'/review-'+width+'.png'});
   await page.evaluate(()=>{dismissCard();showHome(false);updateBounds(true)});
   await page.waitForTimeout(50);
   assert.ok(await page.locator('#island>.usage-notch').evaluate(el=>el.inert&&getComputedStyle(el).visibility==='hidden'),'collapsed notch hides and disables usage');
   await page.evaluate(()=>showHome(true));
   const camera=await page.locator('#islandToggle').boundingBox();
   const boxes=await page.locator('#island>.usage-notch .usage-meter').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}}));
   for(const box of boxes)assert.ok(box.left>=camera.x-.5&&box.right<=camera.x+camera.width+.5&&box.top>=camera.y+camera.height-.5,'meters stay below the camera and within its width '+width);
  }
  await page.setViewportSize({width:1280,height:900});
  await page.evaluate(()=>{showWorkspace();appAppearance.setTheme('dark')});
  await page.screenshot({path:out+'/workspace.png'});
  await page.evaluate(()=>{workerRouting.receive({checkedAt:Date.now()/1000-301,subscriptions:{gemini:{plan:'stale paid'}}})});
  assert.equal(await page.locator('.usage-workspace .usage-meter').count(),1,'stale automatic subscription results expire');
  assert.deepEqual(errors,[]);
  console.log('PASS: six-provider toolbar/review sizing, below-camera placement, usage math, paid account gating, stale data and accessible details.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
