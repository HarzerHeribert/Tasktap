// Capture the actual renderer's native-notch geometry through an open/close cycle.
const {chromium}=require('playwright');
const path=require('node:path'),fs=require('node:fs');
const {pathToFileURL}=require('node:url');
(async()=>{
 const out=path.resolve('output/usage-animation');fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:800,height:510},deviceScaleFactor:2});
  await page.addInitScript(()=>{window.webkit={messageHandlers:{workspace:{postMessage(){}}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.evaluate(()=>{
   document.body.classList.add('native-host');document.body.style.background='#262a30';
   state.firstRun={done:true};state.decisions=[];state.captures=[];state.sessions=[];
   updateNotchGeometry({width:220,height:38,surfaceWidth:432,offset:0,surfaceOffset:0,shoulder:13,pixel:.5,corner:9.5,rimOffset:4,available:460});
   aiConnections.receive({choice:'local',workerHealth:{claude:'signedIn',codex:'signedIn'},workers:{claude:'Claude plan login',codex:'ChatGPT login'},accounts:[]});
   const now=Date.now()/1000,windows=[{remaining:27,minutes:10080,resetsAt:now+172800},{remaining:80,minutes:300,resetsAt:now+3600}];
   workerRouting.receive({checkedAt:now,subscriptions:{codex:{plan:'Pro',windows},gemini:{plan:'Google AI Ultra · agy',windows}},agents:{claude:windows}});
   showHome(false);updateBounds(true);
  });
  await page.waitForTimeout(400);
  let index=0;
  const frame=async()=>page.screenshot({path:path.join(out,'frame-'+String(index++).padStart(3,'0')+'.png'),clip:{x:100,y:0,width:600,height:260}});
  for(let i=0;i<8;i++){await frame();await page.waitForTimeout(50)}
  const baseline=await page.locator('#island>.usage-notch .usage-meter').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}));
  await page.evaluate(()=>{showHome(true);document.activeElement?.blur()});
  for(let i=0;i<16;i++){
   await frame();await page.waitForTimeout(35);
   const current=await page.locator('#island>.usage-notch .usage-meter').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}));
   if(JSON.stringify(current)!==JSON.stringify(baseline))throw Error('Usage moved during open animation');
  }
  await page.screenshot({path:path.join(out,'open.png'),clip:{x:100,y:0,width:600,height:260}});
  await page.evaluate(()=>{captureDraft('','','Make the rehearsal timer easier to read on mobile. Keep the keyboard shortcuts.');Object.assign(draft,{brief:draft.text,agent:'codex',agentChoice:'manual'});review()});
  await page.addStyleTag({content:'.native-host.notch-first #modal:has(#handoff-review){width:560px}'});await page.evaluate(()=>document.activeElement?.blur());await page.waitForTimeout(600);await page.screenshot({path:path.join(out,'review.png')});
  await page.evaluate(()=>{dismissCard();showHome(true)});await page.waitForTimeout(200);
  for(let i=0;i<8;i++){await frame();await page.waitForTimeout(50)}
  await page.evaluate(()=>{showHome(false);document.activeElement?.blur()});
  for(let i=0;i<16;i++){
   await frame();await page.waitForTimeout(35);
   const current=await page.locator('#island>.usage-notch .usage-meter').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}));
   if(JSON.stringify(current)!==JSON.stringify(baseline))throw Error('Usage moved during close animation');
  }
  await page.screenshot({path:path.join(out,'closed.png'),clip:{x:100,y:0,width:600,height:260}});
  console.log('PASS: provider positions remain identical through opening and closing; previews in '+out);
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
