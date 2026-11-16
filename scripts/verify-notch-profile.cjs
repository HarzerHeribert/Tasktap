/* Native metrics drive the same compact surface on a large logical display. */
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:554,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.webkit={messageHandlers:{workspace:{postMessage:()=>{}}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.evaluate(()=>{
   state.firstRun={done:true};firstRun.visible=false;
   document.body.classList.add('native-host','notch-first');
   updateNotchGeometry({width:104,height:16,shoulder:13,surfaceWidth:528,surfaceOffset:0,pixel:.5,corner:4,rimOffset:2,offset:0,available:700,compact:1});
   document.body.classList.add('needs-decision');
  });
  const tab=page.locator('#islandToggle');
  assert.deepEqual(await tab.evaluate(el=>{const r=el.getBoundingClientRect();return {width:r.width,height:r.height,top:r.top}}),{width:104,height:16,top:0});
  assert.equal(await tab.evaluate(el=>getComputedStyle(el,'::after').animationDuration),'4.8s');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await tab.evaluate(el=>getComputedStyle(el,'::after').animationName),'none');
  if(process.env.TASKTAP_SCREENSHOTS)await page.screenshot({path:path.join(process.env.TASKTAP_SCREENSHOTS,'notch-compact-rest.png')});
  await page.evaluate(()=>{showHome(true);updateBounds(true)});
  assert.equal(await tab.evaluate(el=>getComputedStyle(el,'::after').visibility),'hidden');
  assert.ok(await page.locator('.notch-action').first().evaluate(el=>el.getBoundingClientRect().height>=44));
  assert.equal(await page.evaluate(()=>document.body.classList.contains('notch-compact')),true);
  assert.equal(await page.locator('#notch-home').evaluate(el=>getComputedStyle(el).padding),'16px');
  if(process.env.TASKTAP_SCREENSHOTS)await page.screenshot({path:path.join(process.env.TASKTAP_SCREENSHOTS,'notch-compact-open.png')});
  await page.evaluate(()=>updateNotchGeometry({width:220,height:38,compact:0}));
  assert.deepEqual(await tab.evaluate(el=>{const r=el.getBoundingClientRect();return [r.width,r.height]}),[220,38]);
  assert.equal(await page.evaluate(()=>document.body.classList.contains('notch-compact')),false);
  assert.deepEqual(errors,[]);
  console.log('PASS: small top-edge tab, subtle glow, expanded glow suppression, readable controls, compact padding, physical cutout metrics and Reduce Motion.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
