/* Exercise the server wizard and exact endpoint confirmation without reading user credentials. */
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
  try {
    const page=await browser.newPage({viewport:{width:1080,height:860},reducedMotion:'reduce'});
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{window.sent=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>sent.push(m)}}}});
    await page.goto(pathToFileURL(path.join(__dirname,'../prototype/index.html')).href+'#workspace');
    const config={choice:'local',serverKind:'ollama',serverProfiles:{},workers:{},models:{},keys:{},accounts:[],account:''};
    await page.evaluate(c=>aiConnections.receive(c),config);
    await page.getByRole('button',{name:'Preferences',exact:true}).click();
    await page.getByRole('button',{name:'Agents & connections',exact:true}).click();
    await page.getByRole('button',{name:/Request preparation/}).click();
    await page.locator('#ai-route').selectOption('server');
    const radio=k=>page.locator('[name=server-kind][value="'+k+'"]');
    const button=name=>page.getByRole('button',{name,exact:true});
    for (const [kind,port] of [['vllm',8000],['litellm',4000],['ollama',11434]]) {
      await radio(kind).check();
      assert.equal(await page.locator('#server-url').inputValue(),'http://localhost:'+port+'/v1');
    }
    if (process.env.TASKTAP_SCREENSHOTS) await page.locator('#modal').screenshot({path:path.join(process.env.TASKTAP_SCREENSHOTS,'model-server-setup.png'),animations:'disabled'});
    await button('Find models').click();
    const probe=await page.evaluate(()=>sent.at(-1));
    assert.equal(probe.type,'ai-model-list');assert.equal(probe.key,'');assert.ok(!probe.input);
    await radio('litellm').check();
    await page.evaluate(id=>serverSetup.receive(id,{models:['stale-model']}),probe.id);
    assert.ok(await page.locator('#server-models').isHidden());
    await page.getByText('API key Optional',{exact:true}).click();
    await page.locator('#server-key').fill('test-key');
    await button('Find models').click();
    await page.evaluate(()=>serverSetup.receive(sent.at(-1).id,{error:'Access denied. Check the server’s API key.'}));
    assert.match(await page.locator('#server-status').innerText(),/Access denied/);
    await button('Find models').click();
    await page.evaluate(()=>serverSetup.receive(sent.at(-1).id,{models:['studio-local','second-model']}));
    assert.equal(await page.locator('#ai-model').inputValue(),'studio-local');
    const selected={kind:'litellm',url:'http://localhost:4000/v1',model:'studio-local',hasKey:'yes'};
    await button('Save connection').click();
    const saved=await page.evaluate(()=>sent.at(-1));
    assert.equal(saved.key,'test-key');assert.deepEqual(saved.server,{kind:'litellm',url:selected.url,useSaved:false});
    assert.ok(!(await page.evaluate(()=>JSON.stringify(localStorage))).includes('test-key'));
    await page.evaluate(({config,selected})=>aiConnections.receive({...config,choice:'server',serverKind:'litellm',serverProfiles:{litellm:selected}},'Saved.',true),{config,selected});
    await button('Edit connection').click();
    await page.locator('#server-url').fill('https://example.invalid/proxy/v1');
    await button('Find models').click();
    const changed=await page.evaluate(()=>sent.at(-1));
    assert.ok(!changed.useSaved && !changed.key);
    await button('Enter model ID').click();
    await page.locator('#ai-model').fill('manual-alias');
    assert.ok(await button('Save connection').isVisible());
    await page.evaluate(()=>{
      projectsDiscovered([{name:'Lighting',folder:'/projects/Lighting'}]);newDraft('');
      draft.text='Investigate reflections in Lighting';$('#transcript').value=draft.text;
    });
    await button('Review capture').click();
    assert.match(await page.locator('#modal').innerText(),/paid upstream/);
    assert.match(await page.locator('#modal').innerText(),/studio-local/);
    assert.equal(await page.evaluate(()=>sent.filter(m=>m.type==='route').length),0);
    await button('Send to LiteLLM').click();
    assert.equal(await page.evaluate(()=>sent.at(-1).server.url),selected.url);
    await page.evaluate(()=>aiConnections.show('server'));
    await button('Edit connection').click();
    await page.setViewportSize({width:390,height:780});
    assert.ok(await page.locator('#server-setup').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    await page.locator('#modal').evaluate(el=>el.style.zoom='2');
    assert.ok(await page.locator('#server-setup').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    assert.deepEqual(errors,[]);
    console.log('Server presets, stale discovery, denied keys, discovery/manual models, endpoint binding, consent and narrow layout passed.');
  } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
