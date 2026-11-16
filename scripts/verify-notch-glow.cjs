/* Inspect attached bloom at native point sizes and both display pixel densities. */
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 const output=process.env.TASKTAP_SCREENSHOTS||'/tmp/tasktap-glow-review';fs.mkdirSync(output,{recursive:true});
 try{
  for(const scale of [1,2]){
   const context=await browser.newContext({viewport:{width:600,height:140},deviceScaleFactor:scale,reducedMotion:'reduce'});
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(()=>{window.webkit={messageHandlers:{workspace:{postMessage:()=>{}}}}});
   await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
   for(const [name,width,height,corner] of [['synthetic',104,16,4],['physical',220,38,10]]){
    await page.evaluate(({width,height,corner})=>{
     state.firstRun={done:true};firstRun.visible=false;document.body.classList.add('native-host','notch-first');
     updateNotchGeometry({width,height,corner,offset:0,pixel:1/devicePixelRatio,shoulder:13,surfaceWidth:528,surfaceOffset:0,available:100,compact:1});
     document.body.classList.add('needs-decision');document.activeElement?.blur();
     document.documentElement.style.background='#202329';document.body.style.background='transparent';
    },{width,height,corner});
    const edge=await page.locator('#islandToggle').evaluate(el=>{
     const near=getComputedStyle(el,'::after'),bloom=getComputedStyle(el,'::before');
     return {inset:[near.top,near.right,near.bottom,near.left],blur:near.filter,bloomBlur:bloom.filter,shadow:bloom.boxShadow,animation:near.animationName,opacity:near.opacity,pointer:bloom.pointerEvents};
    });
    assert.deepEqual(edge.inset,['0px','0px','0px','0px'],'highlight touches actual housing');
    assert.notEqual(edge.blur,'none');assert.notEqual(edge.bloomBlur,'none');assert.notEqual(edge.shadow,'none');assert.equal(edge.animation,'none');assert.equal(edge.pointer,'none');assert.ok(Number(edge.opacity)>0);
    await page.screenshot({path:path.join(output,'glow-'+name+'-'+scale+'x.png')});
    await page.evaluate(()=>document.body.classList.add('notch-open'));
    assert.equal(await page.locator('#islandToggle').evaluate(el=>getComputedStyle(el,'::before').visibility),'hidden');
    await page.evaluate(()=>document.body.classList.remove('notch-open','needs-decision'));
    assert.equal(await page.locator('#islandToggle').evaluate(el=>getComputedStyle(el,'::before').opacity),'0');
   }
   assert.deepEqual(errors,[]);await context.close();
  }
  console.log('PASS: attached diffuse bloom, housing-edge highlight, silent idle/open states, Reduce Motion, and synthetic/physical screenshots at1x/2x.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
