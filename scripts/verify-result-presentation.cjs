const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||undefined,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{window.messages=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>messages.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  const report='# Layout review\n\nThe sidebar now stays compact while the report uses a readable column.\n\n'+Array.from({length:12},(_,i)=>'- Check '+(i+1)+': reviewed the narrow layout and preserved the original conversation.').join('\n')+'\n\n## Remaining issue\n\nThe export still needs a real provider check.\n\n<script>window.reportEscaped=true</script>\n\n[Unsafe](javascript:alert(1))\n\n[Fake artifact](/tmp/not-an-artifact.txt)\n\n![Remote image](https://example.test/private.png)';
  await page.evaluate(report=>{
   state.firstRun={done:true};firstRun.visible=false;state.projects=[{id:'p',name:'Glasshouse',folder:'/tmp/glasshouse'}];
   state.sessions=[{id:'one',project:'p',task:'Improve the mobile layout and ensure the controls remain readable across all supported themes',sessionName:'Mobile layout review',agent:'codex',host:'ghostty',managed:true,interactive:true,available:true,state:'Complete',log:['Session started.','Agent reported an outcome.'],result:report}];
   state.captures=[{id:'capture',session:'one',project:'p',kind:'Agent question',receipt:'Complete',brief:'Review the mobile layout.',result:report}];state.decisions=[];
   showWorkspace();showSession('one');
  },report);
  assert.ok((await page.locator('.result-summary .result-excerpt').innerText()).split(/\s+/).length<=80);
  assert.equal(await page.locator('.result-summary .hint').innerText(),'Excerpt');
  assert.equal(await page.locator('.session-activity').getAttribute('open'),null);
  const dest=process.env.TASKTAP_SCREENSHOTS||'/tmp/tasktap-audit-refinement';fs.mkdirSync(dest,{recursive:true});
  for(const width of [1280,650,390]){
   await page.setViewportSize({width,height:900});
   assert.ok(await page.locator('#modal').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
   const buttons=await page.locator('.session-actions > button').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {top:r.top,height:r.height,width:r.width}}));
   for(const a of buttons)for(const b of buttons)if(Math.abs(a.top-b.top)<1)assert.ok(Math.abs(a.height-b.height)<1,'actions align on each row');
   await page.locator('#modal').screenshot({path:path.join(dest,'session-'+width+'.png')});
  }
  await page.getByRole('button',{name:'Read full report',exact:true}).click();
  assert.match(await page.locator('.result-prose').innerText(),/Remaining issue/);
  assert.equal(await page.getByRole('button',{name:'Export summary',exact:true}).count(),1);
  assert.equal(await page.locator('.result-prose h1').innerText(),'Layout review');
  assert.equal(await page.locator('.result-prose script,.result-prose img[src],.result-prose a[href^="javascript:"]').count(),0);
  assert.equal(await page.locator('.result-prose a[href^="file:"],.result-prose [data-action]').count(),0);
  assert.equal(await page.evaluate(()=>window.reportEscaped),undefined);
  assert.ok(await page.locator('#modal').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
  await page.setViewportSize({width:1280,height:900});
  await page.locator('#modal').screenshot({path:path.join(dest,'full-report.png')});
  await page.evaluate(()=>{state.captures[0].result='Earlier outcome for the original request.';configureVoices([{id:'fixture-voice',name:'Fixture voice'}]);state.voiceEngine='fixture-voice';resultPresentation.show('capture')});
  await page.getByRole('button',{name:'Copy report',exact:true}).click();
  assert.equal(await page.evaluate(()=>messages.at(-1).text),'Earlier outcome for the original request.');
  await page.getByRole('button',{name:'Export summary',exact:true}).click();
  assert.equal(await page.evaluate(()=>messages.at(-1).text),'Earlier outcome for the original request.');
  await page.getByRole('button',{name:'Read aloud',exact:true}).click();
  assert.equal(await page.evaluate(()=>messages.findLast(m=>m.type==='speak').text),'Earlier outcome for the original request.','narration stays with the exact report, not the latest session result');
  await page.evaluate(report=>{state.captures[0].result=report},report);
  await page.evaluate(()=>{dismissCard();sess('one').host='tasktap';workspaceDeck.openResult('capture')});
  assert.equal(await page.locator('.deck-report h1').innerText(),'Layout review');
  assert.match(await page.locator('.deck-report').innerText(),/Remaining issue/);
  assert.equal(await page.locator('.deck-report script,.deck-report img[src]').count(),0);
  assert.equal(await page.evaluate(()=>sess('one').result),report,'report source remains exact');
  await page.evaluate(()=>{
   delete sess('one').host;sess('one').sessionName='A deliberately long session title that describes many details without forcing the history list into a wall of text. '.repeat(4);go('sessions');
  });
  await page.setViewportSize({width:390,height:900});
  assert.ok(await page.locator('#session-history .row-title').evaluate(e=>e.clientHeight<=parseFloat(getComputedStyle(e).lineHeight)*2+1));
  assert.ok(await page.locator('.row-compact-project').isVisible(),'project identity remains visible at narrow widths');
  await page.locator('#session-history .session-row').click();
  assert.match(await page.locator('#dialog-heading').innerText(),/many details/);
  await page.evaluate(()=>{dismissCard();state.notes=[{id:'long-note',project:'p',title:'A note worth reading',text:'Preserve this sentence exactly. '.repeat(80)}];go('notes')});
  assert.ok(await page.locator('.note>.hint').evaluate(e=>e.clientHeight<=parseFloat(getComputedStyle(e).lineHeight)*3+1));
  await page.getByRole('button',{name:'Glasshouse / A note worth reading',exact:true}).click();
  assert.equal(await page.locator('#modal .body-copy').innerText(),'Preserve this sentence exactly. '.repeat(80),'opening a compact note retains its full contents');
  assert.deepEqual(errors,[]);console.log('Result presentation: bounded excerpt, exact full report, aligned responsive actions, honest export label and safe Markdown passed.');
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
