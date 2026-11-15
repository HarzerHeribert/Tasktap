// UI/bridge fixtures only: this test does not request macOS permission or deliver an OS notification.
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:800},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',error=>errors.push(String(error)));
  await page.addInitScript(()=>{window.messages=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>messages.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.evaluate(()=>{state.firstRun={done:true};showWorkspace();state.alerts=true;notifications()});
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='notification-status').length),1);
  assert.equal(await page.evaluate(()=>messages.some(m=>m.type==='authorize')),false,'viewing settings never asks permission');
  await page.evaluate(()=>notificationStatus({authorization:'denied',alerts:'disabled',center:'disabled'}));
  assert.match(await page.locator('#notification-status').innerText(),/blocked in macOS Settings/);
  assert.equal(await page.getByRole('button',{name:'Enable notifications',exact:true}).count(),0);
  await page.getByRole('button',{name:'Open notification settings',exact:true}).click();
  assert.equal(await page.evaluate(()=>messages.at(-1).type),'notification-settings');
  assert.equal(await page.evaluate(()=>messages.some(m=>m.type==='authorize')),false,'denied state offers named settings navigation');
  await page.evaluate(()=>notificationStatus({authorization:'authorized',alerts:'disabled',center:'enabled'}));
  assert.match(await page.locator('#notification-status').innerText(),/Banners: off.*Notification Center: allowed/s);
  assert.match(await page.locator('#notification-preferences').innerText(),/Focus.*cannot confirm that a banner was shown/s);
  await page.getByRole('button',{name:'Turn off alerts',exact:true}).click();
  assert.equal(await page.evaluate(()=>state.alerts),false);
  assert.equal(await page.evaluate(()=>messages.at(-1).type),'disableNotifications');
  await page.getByRole('button',{name:'Enable notifications',exact:true}).click();
  assert.equal(await page.evaluate(()=>messages.at(-1).type),'authorize','only the explicit enable action asks permission');
  await page.evaluate(()=>workspaceCommand('notification-denied'));
  assert.equal(await page.evaluate(()=>state.alerts),false);
  await page.evaluate(()=>notificationStatus({authorization:'notDetermined',alerts:'disabled',center:'disabled'}));
  assert.match(await page.locator('#notification-status').innerText(),/Permission has not been requested/);
  await page.evaluate(()=>notificationDeliveryFailed('capture-1','complete','Could not schedule <script>window.compromised=true</script>'));
  assert.match(await page.locator('#notification-error').innerText(),/Could not schedule <script>/);
  assert.equal(await page.evaluate(()=>!!window.compromised),false);
  const failure=await page.evaluate(()=>state.notificationFailure);
  assert.equal(failure.id,'capture-1');assert.equal(failure.kind,'complete');
  for(const [width,zoom] of [[360,1],[720,2]]){
   await page.setViewportSize({width,height:900});await page.evaluate(zoom=>document.documentElement.style.zoom=zoom,zoom);
   assert.ok(await page.locator('#notification-preferences').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'notification settings fit narrow/200% viewport');
   const open=page.getByRole('button',{name:'Open notification settings',exact:true});await open.scrollIntoViewIfNeeded();
   assert.ok(await open.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.height>20}));
  }
  await page.reload();await page.evaluate(()=>{showWorkspace();notifications()});
  assert.equal(await page.evaluate(()=>state.notificationFailure.id),'capture-1','delivery failure remains inspectable after relaunch');
  await page.getByRole('button',{name:'Dismiss error',exact:true}).click();
  assert.equal(await page.evaluate(()=>state.notificationFailure),undefined);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='notify').length),0,'status and error feedback never retries a notification');
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();

  await page.evaluate(()=>{
   document.hasFocus=()=>false;state.alerts=true;
   state.projects=[{id:'p',name:'Fixture',folder:'/fixture/project',aliases:[]}];
   state.sessions=[{id:'s',task:'Fixture session',project:'p',agent:'codex',host:'tasktap',state:'Complete',result:'Second report',log:[]}];
   state.captures=[{id:'first',session:'s',project:'p',receipt:'Complete',result:'First exact report'},{id:'second',session:'s',project:'p',receipt:'Complete',result:'Second report'}];
   workspaceDeck.outcome({session:'s',capture:'first',state:'Complete',message:'First exact report'});
   workspaceDeck.outcome({session:'s',capture:'first',state:'Complete',message:'First exact report'});
   workspaceDeck.outcome({session:'s',capture:'second',state:'Complete',message:'Second report',recovered:true});
  });
  const notices=await page.evaluate(()=>messages.filter(m=>m.type==='notify'));
  assert.equal(notices.length,1,'receipt-keyed dedupe and recovered-event suppression remain intact');
  assert.equal(notices[0].id,'first');
  await page.evaluate(()=>workspaceCommand('notice-result','first'));
  assert.match(await page.locator('.deck-document').innerText(),/First exact report/);
  assert.doesNotMatch(await page.locator('.deck-document').innerText(),/Second report/,'notification opens its capture, not the newer report');
  assert.deepEqual(errors,[]);
  console.log('PASS: current authorization/alert status, explicit settings/permission actions, persisted safe error feedback, narrow/200% controls, receipt dedupe, recovered-event silence, and exact result routing. No OS delivery exercised.');
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
