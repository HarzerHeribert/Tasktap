/* A current screenshot inventory. Fixtures never imply a live provider passed. */
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
const destination=path.resolve(process.env.TASKTAP_AUDIT||'output/ui-audit/second-pass');
const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
(async()=>{
 fs.mkdirSync(destination,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 const page=await browser.newPage({viewport:{width:1280,height:960},reducedMotion:'reduce'}),errors=[],screens=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.sent=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>sent.push(m)}}}});
 async function reset(width,theme,zoom=1,height=960){
  await page.setViewportSize({width,height});await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.evaluate(({theme,zoom})=>{
   state=structuredClone(seed);state.firstRun={done:true};state.setupSeen=true;firstRun.visible=false;
   state.projects.forEach(p=>p.available=true);
   state.sessions.forEach(s=>Object.assign(s,{managed:true,interactive:true,available:true,host:'ghostty',startup:'confirmed',conversation:s.id}));
   state.captures[0].session='s1';
   aiConnections.receive({choice:'local',workers:{codex:'Existing CLI account',claude:'Existing CLI account'},workerHealth:{codex:'signedIn',claude:'signedIn',agy:'missing','cursor-agent':'missing',pi:'missing'},models:{},keys:{},accounts:[],account:'',cloud:''});aiConnections.checked();
   terminalHosts.receive({terminal:'',cmux:'',ghostty:'',iterm:'',warp:'',wezterm:'',kitty:''});workerRouting.receive({checkedAt:Date.now()/1000,agents:{}});
   configureVoices([{id:'fixture-voice',name:'Local voice'}]);state.voiceEngine='fixture-voice';
   document.body.style.zoom=zoom;appAppearance.setTheme(theme);showWorkspace();go('overview');
  },{theme,zoom});
 }
 const review="captureDraft('','glass','Fix the mobile layout. Keep the navigation and keyboard shortcuts intact.');draft.mode='ask';draft.project='glass';draft.agent='codex';draft.agentChoice='named';draft.brief=draft.text;review()";
 const cases=[
  ['home','Home',"go('overview')"],['history','Session history',"go('sessions')"],['notebook','Notebook',"go('notes')"],
  ['workspaces','Open a workspace',"workspaceNavigation.openChooser()"],
  ['review','Task review',review],
  ['notch-review','Compact notch review',"showHome(true);"+review],
  ['long-review','Long task and reference',review+";draft.brief=Array(6).fill('Keep the toolbar readable and preserve every keyboard shortcut when the window becomes narrow.').join(' ');draft.reference={kind:'website',value:'https://example.com/mobile/a-very-long-page-name-for-checking-the-reference-layout',app:'Safari',observedAt:Date.now()/1000};review()"],
  ['manual-followup','Manual follow-up',"newDraft('s1');draft.text='Check the reflections before finishing.';draft.brief=draft.text;draft.mode='nudge';review()"],
  ['ambiguous','Choose the matching conversation',"captureDraft('','','Tell the lighting session to check the reflections.');draft.mode='nudge';routeDecision([sess('s1'),sess('s2')],false)"],
  ['diagnostics','Separate diagnostics',review+";handoffReview.diagnostics()"],
  ['question','Agent decision',"showNotch('q1')"],
  ['session','Session details',"showSession('s4')"],
  ['failure','Failed session',"Object.assign(sess('s1'),{state:'Failed',available:false});showSession('s1')"],
  ['report','Full report',"sess('s4').result='# Layout review\\n\\nThe workspace remains readable at narrow sizes.\\n\\n- Sidebar titles stay compact.\\n- Buttons align on shared rows.\\n\\n## Remaining checks\\n\\nA live provider round trip remains to be verified.';resultPresentation.show('s4')"],
  ['agents','Agents preferences',"prefs('agents')"],['capture','Capture preferences',"prefs('capture')"],
  ['workspace-settings','Workspace preferences',"prefs('workspaces')"],['voice','Voice and alerts',"prefs('voice')"],['appearance','Appearance',"prefs('appearance')"],
  ['notifications','Notification availability',"notifications();notificationStatus({authorization:'denied',alerts:'disabled',center:'disabled'})"],
  ['models','Adaptive model settings',"state.sessionModels={adaptive:true};sessionModelSettings()"],
  ['routing','Agent routing',"state.workerRouting={automatic:true,ranked:['codex','claude'],reserve:10};workerRouting.settings()"],
  ['preparation','Request preparation',"aiConnections.show('local')"],
  ['setup','Setup',"setupWizard.open('preferences')"]
 ];
 try{
  for(const variant of [{id:'desktop',width:1280,theme:'dark'},{id:'narrow',width:390,theme:'light'},{id:'zoom',width:640,height:480,theme:'ocean'}]){
   for(const [id,title,expression] of cases){
    await reset(variant.width,variant.theme,variant.zoom,variant.height);await page.evaluate(expression);await page.waitForTimeout(60);
    const modal=page.locator('dialog[open]').last(),target=await modal.count()?modal:page.locator('.shell');
    const geometry=await target.evaluate(element=>({width:element.clientWidth,scroll:element.scrollWidth}));
    assert.ok(geometry.scroll<=geometry.width+2,`${id}/${variant.id} horizontal overflow: ${JSON.stringify(geometry)}`);
    const file=`${id}-${variant.id}.png`;await target.screenshot({path:path.join(destination,file),animations:'disabled'});
    screens.push({title,variant:variant.id,file,geometry});
   }
  }
  assert.deepEqual(errors,[]);
  const intro='Current shared UI with fictional projects, local browser rendering and an intercepted native bridge. Desktop, narrow, and a 640×480 CSS viewport equivalent to 200% zoom in a 1280×960 window; dark, light and Ocean themes; Reduce Motion enabled. No live agent, OS permission, notification, or model-accuracy claim.';
  fs.writeFileSync(path.join(destination,'screens.json'),JSON.stringify({generated:new Date().toISOString(),method:intro,screens,errors},null,2));
  fs.writeFileSync(path.join(destination,'index.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tasktap — second UI review</title><style>body{margin:0;background:#101217;color:#e6e8ec;font:16px/1.6 system-ui}main{max-width:1200px;margin:auto;padding:32px 24px}h1{letter-spacing:-.04em;line-height:1.15}p{max-width:78ch;color:#b0b8c7}nav{display:flex;gap:16px;flex-wrap:wrap}a{color:#abc4ff}section{margin-top:40px}article{border:1px solid #343944;border-radius:10px;padding:20px;margin:16px 0;min-width:0}h3{margin:0 0 16px;font-size:16px}img{display:block;max-width:100%;height:auto;margin:auto}details summary{cursor:pointer;padding:8px}a:focus-visible,summary:focus-visible{outline:2px solid #abc4ff;outline-offset:4px}</style><main><h1>Tasktap: second UI review</h1><p>'+intro+'</p><p>Applied findings and outstanding work are recorded in the <a href="../implementation-gap-plan.html">updated implementation plan</a>. This gallery captures the current interface; the <a href="../index.html">original audit</a> is retained as historical evidence.</p><nav>'+cases.map(([id,title])=>'<a href="#'+id+'">'+escape(title)+'</a>').join('')+'</nav>'+cases.map(([id,title])=>'<section id="'+id+'"><h2>'+escape(title)+'</h2>'+screens.filter(s=>s.file.startsWith(id+'-')&&s.title===title).map((s,i)=>'<details '+(!i?'open':'')+'><summary>'+escape(s.variant)+'</summary><article><img loading="lazy" src="'+s.file+'" alt="'+escape(title+' · '+s.variant)+'"></article></details>').join('')+'</section>').join('')+'</main></html>');
  console.log(`Second UI review captured ${screens.length} screens without horizontal overflow or script errors: ${destination}/index.html`);
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
