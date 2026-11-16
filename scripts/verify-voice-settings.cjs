const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];
  page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(String(error)));
  await page.addInitScript(()=>{window.sent=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>sent.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.evaluate(()=>{state.firstRun={done:true};showWorkspace();prefs('voice');window.voiceFixture={configuration:{mode:'local',localEngine:'recommended',provider:'openai',language:'auto',models:{}},recommendedEngine:'apple-dictation',supported:true,ready:false,microphone:'unknown',phase:'idle',detail:'',progress:null,appleLanguage:'German'};voiceSettings.receive(voiceFixture)});
  const receive=patch=>page.evaluate(patch=>{Object.assign(voiceFixture,patch);voiceSettings.receive(voiceFixture)},patch);
  const last=type=>page.evaluate(type=>sent.findLast(m=>m.type===type),type);
  assert.ok((await page.locator('#modal').boundingBox()).width>1000,'spacious Preferences window');
  assert.equal(await page.locator('#voice-settings .primary').count(),1,'one initial setup action');
  assert.equal(await last('speech-install'),undefined,'opening settings never downloads');
  await page.getByRole('button',{name:'Download & set up',exact:true}).click();assert.ok(await last('speech-install'));
  await receive({phase:'downloading',progress:.45,detail:'Downloading speech assets…'});
  assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),'45');
  await page.getByRole('button',{name:'Cancel download',exact:true}).click();assert.ok(await last('speech-cancel-install'));
  await receive({phase:'idle',ready:true,progress:null});
  await page.getByRole('button',{name:'Allow microphone',exact:true}).click();assert.ok(await last('speech-microphone'));
  await receive({microphone:'allowed'});
  await page.getByRole('button',{name:'Try dictation',exact:true}).click();
  const control=page.getByRole('button',{name:'Hold to dictate',exact:true});
  await control.focus();await page.keyboard.down('Space');
  const request=await last('dictation-start');assert.ok(request);
  await page.evaluate(id=>{dictationEvent(id,'recording','');dictationEvent(id,'partial','Mach den Button');dictationEvent(id,'partial','Mach den Button größer');dictationEvent(id,'partial','Mach den Button größer, but keep the shortcut.')},request.id);
  assert.equal(await page.getByLabel('Test transcript').inputValue(),'Mach den Button größer, but keep the shortcut.','partial updates replace complete hypotheses');
  await page.keyboard.up('Space');assert.equal((await last('dictation-finish')).id,request.id);
  await page.evaluate(id=>dictationEvent(id,'text','Mach den Button größer, but keep the shortcut.'),request.id);
  assert.equal(await last('enqueue'),undefined,'test dictation never launches an agent');
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await receive({ready:true,microphone:'denied'});
  await page.getByRole('button',{name:'Open microphone settings',exact:true}).click();assert.ok(await last('speech-microphone-settings'));
  await receive({ready:false,microphone:'allowed'});
  await page.getByRole('button',{name:'Use a cloud provider instead',exact:true}).click();
  const saved=await last('speech-save');assert.equal(saved.configuration.mode,'cloud');
  await receive({configuration:saved.configuration});
  await page.getByLabel('API key',{exact:true}).fill('speech-fixture-key');
  await page.getByRole('button',{name:'Save API key',exact:true}).click();
  assert.equal((await last('speech-connect')).key,'speech-fixture-key');
  assert.equal(await page.getByLabel('API key',{exact:true}).inputValue(),'','clear key immediately');
  assert.equal(await page.evaluate(()=>JSON.stringify(state).includes('speech-fixture-key')||Object.values(localStorage).some(v=>v.includes('speech-fixture-key'))),false,'keys never reach durable web state');
  await receive({ready:true});
  await page.getByText('More options',{exact:true}).click();
  await page.getByLabel('Speech model',{exact:true}).selectOption('gpt-4o-transcribe');
  const pinned=await last('speech-save');assert.equal(pinned.configuration.models.openai,'gpt-4o-transcribe');
  await receive({configuration:pinned.configuration,recommendedModels:{openai:'gpt-transcribe',deepgram:'nova-3',elevenlabs:'scribe_v3'}});
  assert.equal(await page.getByLabel('Speech model',{exact:true}).inputValue(),'gpt-4o-transcribe','recommendation does not rewrite explicit model');
  await page.getByRole('button',{name:'Use on-device dictation',exact:true}).click();await receive({configuration:(await last('speech-save')).configuration});
  await page.getByLabel('Speech engine',{exact:true}).selectOption('apple-speech');
  const engine=await last('speech-save');await receive({configuration:engine.configuration,recommendedEngine:'whisper-turbo'});
  assert.equal(await page.getByLabel('Speech engine',{exact:true}).inputValue(),'apple-speech');
  await page.evaluate(()=>prefs('agents'));
  await page.getByLabel('Reply language',{exact:true}).selectOption('english');
  const text=await page.evaluate(()=>deliveryText({mode:'ask',agent:'agy',brief:'Mach den Button größer.',strokes:[]}));
  assert.ok(text.startsWith('Mach den Button größer.'));assert.match(text,/final response in English/);
  await page.getByLabel('Reply language',{exact:true}).selectOption('request');
  assert.match(await page.evaluate(()=>agentLanguageGuidance()),/language of the user’s request/);
  for(const [width,height] of [[1440,1000],[1000,800],[640,450],[390,844],[320,700]]){
   await page.setViewportSize({width,height});
   for(const group of ['general','agents','workspaces','capture','voice','notifications','appearance']){
    await page.evaluate(group=>prefs(group),group);
    const overflow=await page.locator('#modal').evaluate(e=>({x:e.getBoundingClientRect().x,right:e.getBoundingClientRect().right,width:e.clientWidth,scroll:e.scrollWidth,main:e.querySelector('.preferences-main').scrollWidth,mainWidth:e.querySelector('.preferences-main').clientWidth}));
    assert.ok(overflow.x>=-1&&overflow.right<=width+1,group+' window fits '+width);
    assert.ok(overflow.scroll<=overflow.width+1&&overflow.main<=overflow.mainWidth+1,group+' content fits '+width);
   }
  }
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>prefs('voice'));
  if(process.env.TASKTAP_SCREENSHOTS)await page.locator('#modal').screenshot({path:path.join(process.env.TASKTAP_SCREENSHOTS,'preferences-voice.png')});
  await page.evaluate(()=>sessionModelSettings());assert.equal(await page.locator('#modal').evaluate(e=>e.classList.contains('preferences-dialog')),false,'secondary editors keep their own geometry');
  assert.deepEqual(errors,[]);
  console.log('PASS: real Preferences navigation and responsive layout, explicit download/mic setup, cancellation, cloud-key isolation, pinned models across recommendation changes, reply-language guidance, and live transcript replacement. Native bridge fixtures; no audio upload or model download.');
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
