// Exercise a new install and an upgrade using the same entry points as the macOS menu.
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||undefined});
  try {
    const page=await browser.newPage({viewport:{width:980,height:760},reducedMotion:'reduce'});
    page.setDefaultTimeout(4000);
    const errors=[];
    page.on('pageerror',e=>errors.push(String(e)));
    await page.addInitScript(()=>{window.sent=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>sent.push(m)}}}});
    await page.goto(pathToFileURL(path.join(__dirname,'../prototype/index.html')).href);
    const cmd=c=>page.evaluate(c=>workspaceCommand(c),c);
    const click=name=>page.getByRole('button',{name,exact:true}).click();
    const wizard=page.locator('#setup-wizard');
    const stateOf=()=>page.evaluate(()=>({context:state.useScreenContext,host:state.sessionHost,agent:sessionModelPolicy().defaultAgent,art:TasktapArt.current()}));
    const before=await stateOf();
    await page.evaluate(()=>projectsDiscovered([{name:'Cuegrid',folder:'/fixture/projects/cuegrid'}]));
    await cmd('open-app');await cmd('open-app');
    await wizard.waitFor();
    const shots=process.env.TASKTAP_SCREENSHOTS;
    const shot=async name=>{if(shots)await page.locator('#modal').screenshot({path:path.join(shots,'setup-'+name+'.png')})};
    await shot('capture');
    await page.getByLabel('Find the website or file I mention').uncheck();
    await click('Continue');
    await page.evaluate(()=>terminalHosts.receive({terminal:'',ghostty:''}));
    assert.ok(await page.locator('#setup-host option[value=warp]').isDisabled());
    await page.locator('#setup-agent').selectOption('codex');
    await page.locator('#setup-host').selectOption('ghostty');
    await click('Back');
    assert.ok(!await page.getByLabel('Find the website or file I mention').isChecked());
    await click('Continue');
    assert.equal(await page.locator('#setup-agent').inputValue(),'codex');
    await shot('sessions');
    await click('Continue');
    assert.ok(await page.locator('#setup-voice').isDisabled());
    await page.evaluate(()=>configureVoices([{id:'siri-local',name:'Local Siri voice'}]));
    await page.locator('#setup-voice').selectOption('siri-local');
    await page.getByRole('radio',{name:'Phase field'}).check();
    await shot('feedback');
    assert.equal(await page.locator('.setup-stage video').getAttribute('data-study'),'phase');
    assert.equal(await page.locator('.setup-stage').evaluate(el=>el.getAnimations({subtree:true}).length),0);
    assert.deepEqual(await stateOf(),before,'Preview changes only the draft');
    await click('Save & try capture');
    await page.locator('#guide-input').waitFor();
    const saved={context:false,host:'ghostty',agent:'codex',art:'phase'};
    assert.deepEqual(await stateOf(),saved);
    assert.ok(await page.evaluate(()=>state.speak && state.voiceEngine==='siri-local'));
    assert.ok(!(await page.evaluate(()=>sent.some(m=>['ai-save','enqueue','dictation-start','authorize','context-begin'].includes(m.type)))));
    // Finish the separate notch tutorial and check Finder reopens the workspace.
    await cmd('guide-finish');await page.reload();await cmd('open-app');
    assert.equal(await wizard.count(),0);
    assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('notch-first')),false);
    assert.deepEqual(await stateOf(),saved);
    await cmd('prefs');await click('Appearance');await click('Run setup…');
    assert.ok(!await page.getByLabel('Find the website or file I mention').isChecked());
    await click('Continue');assert.equal(await page.locator('#setup-host').inputValue(),'ghostty');
    await click('Continue');
    await page.getByRole('radio',{name:'Signal globe'}).check();await page.keyboard.press('Escape');
    assert.ok(await page.getByRole('button',{name:'Run setup…'}).evaluate(el=>el===document.activeElement));
    assert.equal(await page.locator('#preferences [aria-pressed=true]').textContent(),'Appearance');
    assert.deepEqual(await stateOf(),saved);
    await click('Close dialog');
    await page.evaluate(()=>{state.workerRouting={automatic:true,ranked:['codex'],reserve:23};state.sessionModels.adaptive=true;persist()});
    await cmd('run-setup');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await click('Continue');
    const bounds=await page.locator('.setup-stage').evaluate(el=>{
      const rect=()=>[el.offsetLeft,el.offsetTop,el.offsetWidth,el.offsetHeight];
      const frames=[];
      const animations=el.getAnimations({subtree:true});
      for(const fraction of [0,.5,1]){
        for(const a of animations){a.pause();a.currentTime=a.effect.getTiming().duration*fraction}
        frames.push(rect());
      }
      return {frames,count:animations.length};
    });
    assert.ok(bounds.count>=2,'Handoff changes artwork with a crossfade');
    assert.deepEqual(bounds.frames[0],bounds.frames[1]);assert.deepEqual(bounds.frames[1],bounds.frames[2]);
    await click('Continue');
    for(const [width,zoom] of [[375,1],[420,2]]){
      await page.setViewportSize({width,height:760});
      await page.evaluate(z=>document.documentElement.style.zoom=z,zoom);
      assert.ok(await page.locator('#modal').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'No horizontal scrolling');
      assert.ok(await page.getByRole('button',{name:'Save settings'}).isVisible());
    }
    await page.evaluate(()=>document.documentElement.style.zoom=1);
    await page.getByRole('radio',{name:'Relay'}).check();await page.locator('#setup-voice').selectOption('');await click('Save settings');
    assert.ok(await page.evaluate(()=>!state.speak && state.voiceEngine==='siri-local'));
    assert.equal((await stateOf()).art,'relay');
    assert.ok(await page.evaluate(()=>state.sessionModels.adaptive && state.workerRouting.reserve===23 && state.firstRun.done));
    // Older installations already have state but no setup marker.
    await page.evaluate(()=>{delete state.setupSeen;persist()});await page.reload();await cmd('open-app');
    assert.equal(await wizard.count(),0);
    assert.deepEqual(errors,[]);
    console.log('Setup passed: first launch, replay, native discovery, persistence, cancel, motion and compact layout.');
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
