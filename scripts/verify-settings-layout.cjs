// Render actual Preferences/setup UI with a mocked native bridge. The zoom case
// uses the effective layout viewport of a 1280×900 display at browser 200% zoom.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
  const shots=process.env.TASKTAP_SCREENSHOTS;
  if(shots)fs.mkdirSync(shots,{recursive:true});
  try{
    const variants=[['desktop',1280,1000,1],['narrow',390,844,1],['zoom200',640,450,2]];
    for(const [name,width,height,deviceScaleFactor] of variants){
      const page=await browser.newPage({viewport:{width,height},deviceScaleFactor,reducedMotion:'reduce'}),errors=[];
      page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(String(error)));
      await page.addInitScript(()=>{window.sent=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>sent.push(m)}}}});
      await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
      await page.evaluate(()=>{
        state.setupSeen=true;state.firstRun={done:true};state.voiceEngine='fixture-voice';
        aiConnections.receive({choice:'local',workers:{codex:'Existing CLI account',claude:'Existing CLI account'},workerHealth:{codex:'signedIn',claude:'signedIn',agy:'missing','cursor-agent':'missing',pi:'missing'},models:{},keys:{},accounts:[],account:'',cloud:''});aiConnections.checked();
        configureVoices([{id:'fixture-voice',name:'Example local voice'}]);updateKokoro('missing','Optional voice has not been installed.');
        workerRouting.receive({checkedAt:Date.now()/1000,agents:{}});
        appAppearance.setTheme('ocean');showWorkspace();go('overview');
      });
      const verify=async id=>{
        const result=await page.locator('#modal').evaluate(modal=>{
          const visible=el=>el.checkVisibility()&&!el.closest('[hidden]');
          const rect=modal.getBoundingClientRect(),form=modal.querySelector('.settings-form');
          const text=[...modal.querySelectorAll('.hint,.setting-field>label,.settings-jump small,.preference-groups button,.setup-progress li')].filter(visible).map(el=>({text:el.textContent.trim().slice(0,60),size:parseFloat(getComputedStyle(el).fontSize)}));
          const fields=[...modal.querySelectorAll('input:not([type=checkbox]):not([type=radio]),select,textarea')].filter(visible).map(el=>({id:el.id,size:parseFloat(getComputedStyle(el).fontSize),height:el.getBoundingClientRect().height,width:el.getBoundingClientRect().width,available:el.parentElement.getBoundingClientRect().width}));
          const category=modal.querySelector('.preference-groups');
          const active=category?.querySelector('[aria-pressed=true]');
          const categoryRect=category?.getBoundingClientRect(),activeRect=active?.getBoundingClientRect();
          return {width:modal.clientWidth,scroll:modal.scrollWidth,formWidth:form?.clientWidth,formScroll:form?.scrollWidth,rect:{x:rect.x,y:rect.y,right:rect.right,bottom:rect.bottom},vw:innerWidth,vh:innerHeight,text,fields,
            category:category&&{rows:new Set([...category.children].map(el=>el.getBoundingClientRect().y)).size,activeVisible:activeRect.x>=categoryRect.x-1&&activeRect.right<=categoryRect.right+1}};
        });
        assert.ok(result.scroll<=result.width+1,`${name}/${id}: modal horizontal overflow`);
        assert.ok(result.formScroll<=result.formWidth+1,`${name}/${id}: form horizontal overflow`);
        assert.ok(result.rect.x>=-1&&result.rect.right<=result.vw+1&&result.rect.y>=-1&&result.rect.bottom<=result.vh+1,`${name}/${id}: dialog fits effective viewport`);
        for(const item of result.text)assert.ok(item.size>=14,`${name}/${id}: reading text ${item.size}px: ${item.text}`);
        for(const field of result.fields){assert.ok(field.size>=16,`${name}/${id}: ${field.id} reading size`);assert.ok(field.height>=42,`${name}/${id}: ${field.id} control height`);assert.ok(field.width<=field.available+1,`${name}/${id}: ${field.id} field overflow`)}
        if(result.category){assert.equal(result.category.rows,1,`${name}/${id}: category buttons stay on one row`);assert.ok(result.category.activeVisible,`${name}/${id}: selected category is revealed`)}
        if(shots&&['agents','appearance','models-adaptive','preparation-server','setup-feedback'].includes(id))await page.locator('#modal').screenshot({path:path.join(shots,name+'-'+id+'.png'),animations:'disabled'});
      };
      for(const group of ['agents','workspaces','capture','voice','appearance']){await page.evaluate(group=>prefs(group),group);await verify(group)}
      const links=await page.locator('.preference-links>button').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().height));
      assert.ok(Math.max(...links)-Math.min(...links)<1,name+': preference footer actions align');
      if(width<420)assert.ok(links.every(value=>value<=43),name+': narrow footer labels fit on single lines');
      await page.evaluate(()=>sessionModelSettings());await verify('models-fixed');
      await page.locator('#difficulty-curve').check();await verify('models-adaptive');
      if(width<700)assert.equal(await page.locator('#model-fields').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),1,name+': models stack at narrow form widths');
      await page.locator('#default-agent').click();
      const popup=page.locator('.setting-options:visible');
      assert.ok(await popup.evaluate(el=>{const r=el.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth+1&&r.y>=0&&r.bottom<=innerHeight+1}),'picker remains inside viewport');
      await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
      assert.ok(await page.locator('#default-agent').evaluate(el=>el===document.activeElement),'picker returns keyboard focus');
      await page.evaluate(()=>aiConnections.show('server'));await verify('preparation-server');
      await page.evaluate(()=>aiConnections.setup());await verify('agent-setup');
      await page.evaluate(()=>{state.workerRouting={automatic:true,ranked:['codex','claude'],reserve:10};workerRouting.settings()});await verify('agent-routing');
      await page.evaluate(()=>{prefs('agents');setupWizard.open('preferences')});
      for(const step of ['capture','preparation','work','feedback']){
        if(step!=='capture')await page.locator('#setup-next').click();
        assert.equal(await page.locator('#modal').evaluate(el=>el.scrollTop),0,`${name}/${step}: a new step starts at its heading`);
        await verify('setup-'+step);
        const buttons=await page.locator('.setup-actions>button').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {y:r.y,height:r.height,width:r.width}}));
        assert.ok(buttons.every(button=>Math.abs(button.y-buttons[0].y)<1&&Math.abs(button.height-buttons[0].height)<1&&Math.abs(button.width-buttons[0].width)<1),`${name}/${step}: setup actions share equal geometry`);
      }
      await page.locator('#setup-next').scrollIntoViewIfNeeded();
      assert.ok(await page.locator('#setup-next').evaluate(el=>{const r=el.getBoundingClientRect();return r.y>=0&&r.bottom<=innerHeight}),'setup action is reachable by scrolling');
      assert.deepEqual(errors,[],name+': no browser errors');await page.close();
    }
    console.log('PASS: Preferences, models, connection setup, agent routing and setup steps fit desktop, narrow and 200%-equivalent layouts; ≥14px reading text, 16px fields, 42px controls, aligned actions, visible active categories and keyboard picker focus.');
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
