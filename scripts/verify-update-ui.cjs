const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:800},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.sent=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>sent.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href+'#workspace');
  await page.evaluate(()=>{state.firstRun={done:true};showWorkspace();});
  const badge=page.locator('#app-update-badge');
  assert.ok(await badge.isHidden());
  await page.evaluate(()=>appUpdates.receive({available:true,version:'1.0.3',automatic:true}));
  assert.ok(await badge.isVisible());
  assert.equal(await badge.getAttribute('aria-label'),'Update available, version 1.0.3');
  assert.deepEqual(await page.evaluate(()=>sent.filter(m=>m.type==='check-updates')),[],'a background reminder does not start an install or steal focus');
  await badge.click();
  assert.equal(await page.evaluate(()=>sent.filter(m=>m.type==='check-updates').length),1);
  await page.getByRole('button',{name:'Preferences',exact:true}).click();
  const setting=page.getByLabel('Automatically check for updates',{exact:true});
  assert.ok(await setting.isChecked());await setting.uncheck();
  assert.deepEqual(await page.evaluate(()=>sent.filter(m=>m.type==='automatic-updates').at(-1)),{type:'automatic-updates',enabled:false});
  await page.evaluate(()=>appUpdates.receive({available:true,version:'1.0.3',automatic:false,readyToRestart:true}));
  assert.ok(!(await setting.isChecked()));
  await page.keyboard.press('Escape');
  assert.equal(await badge.innerText(),'Restart to update');
  await page.evaluate(()=>render());assert.ok(await badge.isVisible(),'workspace refresh retains the reminder');
  for(const theme of ['dark','light']){
   await page.evaluate(theme=>appAppearance.setTheme(theme),theme);
   await page.setViewportSize({width:390,height:844});
   await page.evaluate(()=>document.body.classList.add('nav-open'));
   assert.ok(await badge.isVisible());
   assert.ok(await badge.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
   if(process.env.TASKTAP_SCREENSHOTS)await page.screenshot({path:path.join(process.env.TASKTAP_SCREENSHOTS,'update-badge-'+theme+'.png')});
  }
  await page.evaluate(()=>appUpdates.receive({available:false,automatic:false}));
  assert.ok(await badge.isHidden(),'dismissed, skipped or failed update clears the reminder');
  assert.deepEqual(errors,[]);
  console.log('Update reminder passed: native availability, explicit click, restart state, automatic-check setting, refresh persistence and narrow themes.');
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
