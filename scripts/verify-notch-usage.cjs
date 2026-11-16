// A small synthetic resting tab must not squeeze the active provider controls.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:554,height:720},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.webkit={messageHandlers:{workspace:{postMessage:()=>{}}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.evaluate(()=>{
   state.firstRun={done:true};firstRun.visible=false;state.decisions=[];
   document.body.classList.add('native-host','notch-first');
   aiConnections.receive({choice:'local',workerHealth:{claude:'signedIn',codex:'signedIn'},workers:{claude:'Claude plan login',codex:'ChatGPT login'},accounts:[]});
   const now=Date.now()/1000;
   workerRouting.receive({checkedAt:now,subscriptions:Object.fromEntries(['claude','codex','gemini','cursor','grok','glm'].map(id=>[id,{plan:'Fixture paid plan',windows:[{remaining:75,minutes:10080,resetsAt:now+86400}]}]))});
  });
  for(const [name,width,height,usageWidth] of [['synthetic',104,16,200],['physical',220,38,220]]){
   await page.evaluate(({width,height,usageWidth})=>{
    updateNotchGeometry({width,height,usageWidth,shoulder:13,surfaceWidth:528,surfaceOffset:0,pixel:.5,corner:4,rimOffset:2,offset:0,available:650,compact:1});
    showHome(true);updateBounds(true);
   },{width,height,usageWidth});
   const fit=await page.evaluate(()=>{
    const camera=document.querySelector('#islandToggle').getBoundingClientRect(),sheet=document.querySelector('#notch-home').getBoundingClientRect();
    const row=document.querySelector('#island>.usage-notch'),box=row.getBoundingClientRect();
    return {cameraWidth:camera.width,rowWidth:box.width,visible:getComputedStyle(row).visibility,meters:[...row.querySelectorAll('.usage-meter')].map(el=>{
     const r=el.getBoundingClientRect();return {width:r.width,top:r.top,cameraBottom:camera.bottom,withinCamera:r.left>=camera.left&&r.right<=camera.right,withinSheet:r.left>=sheet.left&&r.right<=sheet.right};
    })};
   });
   assert.equal(fit.cameraWidth,width);assert.equal(fit.rowWidth,usageWidth);assert.equal(fit.visible,'visible');assert.equal(fit.meters.length,6);
   assert.ok(fit.meters.every(m=>m.width>=24&&m.width<=30&&m.top>=m.cameraBottom&&m.withinSheet),name+' meters stay readable inside the active sheet');
   if(name==='physical')assert.ok(fit.meters.every(m=>m.withinCamera),'physical camera row retains its original width');
   if(process.env.TASKTAP_SCREENSHOTS)await page.screenshot({path:path.join(process.env.TASKTAP_SCREENSHOTS,'notch-usage-'+name+'.png')});
   await page.evaluate(()=>{homeMode='closed';drawHome();updateBounds(true)});
   assert.ok(await page.locator('#island>.usage-notch').evaluate(el=>el.inert&&getComputedStyle(el).visibility==='hidden'));
   assert.equal(await page.locator('#islandToggle').evaluate(el=>el.getBoundingClientRect().width),width);
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: six readable providers on active synthetic and physical notches, exact physical camera bounds, small collapsed tabs and hidden/inert collapsed usage.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
