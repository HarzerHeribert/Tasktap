const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

(async()=>{
  const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||undefined,headless:true});
  try{
    const context=await browser.newContext({viewport:{width:850,height:600},reducedMotion:'reduce'});
    await context.addInitScript(()=>{
      window.events=[];
      window.webkit={messageHandlers:{workspace:{postMessage:message=>events.push(message)}}};
    });
    const page=await context.newPage();
    await page.goto(pathToFileURL(path.resolve(__dirname,'../prototype/index.html')).href);
    const event={agent:'codex',workspace:'/test/projects/example',sessionId:'example',requestId:'first',question:'Keep the detail?'};
    const signal=()=>page.evaluate(()=>({on:document.body.classList.contains('needs-decision'),caption:document.querySelector('#islandLabel').textContent,
      animation:getComputedStyle(document.querySelector('#islandToggle'),'::after').animationName,
      count:window.events.filter(m=>m.type==='status').at(-1)?.count}));
    assert.equal((await signal()).on,false);
    await page.evaluate(()=>{projectsDiscovered([{folder:'/test/projects/example',name:'Example'}]);externalSessions([{id:'external',agent:'claude',source:'claude',folder:'/test/projects/example',task:'External terminal',state:'Needs input'}])});
    assert.equal((await signal()).count,0);
    const first=await page.evaluate(event=>receiveAgentQuestion(event,{id:'restored-first',status:'pending',discussion:['Earlier clarification']}),event);
    assert.equal(first.id,'restored-first');assert.deepEqual(first.discussion,['Earlier clarification']);
    const second=await page.evaluate(event=>receiveAgentQuestion({...event,requestId:'second',question:'Increase detail?'}),event);
    assert.deepEqual(await signal(),{on:true,caption:'2 decisions',animation:'none',count:2});
    const duplicate=await page.evaluate(event=>receiveAgentQuestion(event),event);
    assert.equal(first.id,duplicate.id);
    await page.evaluate(()=>{openRequest();hardware('back');showWorkspace();showHome(false)});
    assert.equal((await signal()).count,2);
    await page.evaluate(id=>decide(id,1),second.id);
    assert.equal((await signal()).count,1);
    await page.reload();
    assert.deepEqual(await signal(),{on:true,caption:'1 decision',animation:'none',count:1});
    await page.evaluate(key=>{reconcileAgentQuestions([key]);openRequest()},first.producerKey);
    assert.equal(await page.locator('#notch').getAttribute('data-request'),first.id);
    await page.evaluate(()=>reconcileAgentQuestions([]));
    assert.ok(!await page.locator('#notch').isVisible());
    assert.deepEqual(await signal(),{on:false,caption:'All clear',animation:'none',count:0});
    assert.ok(await page.evaluate(id=>events.some(e=>e.type==='clear'&&e.id===id),first.id));
    console.log('Actionable inbox edge, external waiting, retries, multiple decisions, deferral, relaunch, withdrawal and Reduce Motion verified.');
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
