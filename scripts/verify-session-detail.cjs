const { chromium }=require('playwright');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
 const page=await browser.newPage({viewport:{width:1100,height:850}});
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(()=>{window.messages=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>messages.push(m)}}}});
 await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
 await page.evaluate(()=>{
 document.body.classList.remove('notch-first','native-host');
 state.projects=[{id:'test',name:'Tapped',folder:'/Users/example/projects/tapped'}];state.firstRun={done:true};firstRun.visible=false;
 state.sessions=[{id:'one',project:'test',agent:'codex',task:'Make Tasktap icons reflect the app and share the same artwork across GitHub and Pages',host:'tasktap',interactive:true,available:true,state:'Running',log:[]},{id:'two',project:'test',agent:'claude',task:'Fix the running session setup and keep the interface consistent',interactive:true,available:true,state:'Running',log:[]}];state.decisions=[];state.captures=[];showSession('one');
 });
 assert.equal(await page.getByRole('button',{name:'Open in Tasktap',exact:true}).count(),1);
 await page.locator('[data-project-peers] summary').click();
 await page.locator('#modal').screenshot({path:'/tmp/tasktap-session-detail.png'});
 await page.locator('.peer-session').click();assert.match(await page.locator('#dialog-heading').innerText(),/Fix the running/);
 await page.evaluate(()=>{
 state.captures=[{id:'receipt',session:'one',receipt:'Queued',kind:'Agent question'}];sess('one').sessionName='A newer generated session title';showSession('one');
 });
 assert.equal(await page.locator('.session-receipt tasktap-relay').getAttribute('data-phase'),'queued');
 for(const state of ['Running','Complete']){
 await page.evaluate(state=>agentReceipt({session:'one',capture:'receipt',state,message:state}),state);
 if(state==='Complete'){assert.equal(await page.locator('.session-receipt tasktap-relay').count(),0);assert.match(await page.locator('.result-summary').innerText(),/Complete/)}
 else assert.equal(await page.locator('.session-receipt tasktap-relay').getAttribute('data-phase'),state.toLowerCase());
 }
 await page.setViewportSize({width:360,height:740});
 await page.evaluate(()=>showSession('two'));
 assert.ok(await page.locator('#modal').evaluate(e=>e.scrollWidth<=e.clientWidth));
 await page.keyboard.press('Escape');assert.equal(await page.locator('#modal').isVisible(),false);
 assert.deepEqual(errors,[]);console.log('Session detail: Tasktap terminal action, peer navigation and narrow layout passed.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
