// Real shared app UI with an explicitly illustrative project and reviewed task.
// Agent terminal imagery is captured from the installed Mac app, never recreated here.
const {chromium}=require('playwright');
const {pathToFileURL}=require('node:url');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..'),dest=path.join(root,'site/assets/product');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});try{
 const page=await browser.newPage({viewport:{width:464,height:1000},deviceScaleFactor:2,reducedMotion:'reduce'});
 await page.addInitScript(()=>{window.messages=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>messages.push(m)}}}});
 await page.goto(pathToFileURL(path.join(root,'prototype/index.html')).href);
 await page.evaluate(()=>{
  document.body.classList.add('workspace-snapshot');state.firstRun={done:true};state.setupSeen=true;firstRun.visible=false;
  state.projects=[{id:'cuegrid',folder:'/Users/example/projects/cuegrid',name:'Cuegrid',aliases:[],available:true}];
  state.sessions=[{id:'product-agent',project:'cuegrid',agent:'codex',host:'tasktap',interactive:true,available:true,state:'Connected',task:'Refine the rehearsal view',log:[]}];
  state.captures=[];state.decisions=[];appAppearance.setTheme('dark');
  aiConnections.receive({choice:'local',workers:{codex:'Existing CLI account',claude:'Existing CLI account'},workerHealth:{codex:'signedIn',claude:'signedIn'},models:{},keys:{},accounts:[],account:''});aiConnections.checked();
  document.body.style.setProperty('--native-surface-width','432px');showHome(true);
  captureDraft('','cuegrid','In Cuegrid, the rehearsal timer is hard to read on my phone. Make it clearer, but keep the keyboard shortcuts.');
  draft.mode='ask';draft.project='cuegrid';draft.agent='codex';draft.agentChoice='named';draft.brief='Make the rehearsal timer easier to read on mobile. Keep the keyboard shortcuts.';
  draft.reference={kind:'website',value:'http://localhost:3000/rehearsal',app:'Safari',observedAt:Date.now()/1000};review();
 });
 const regions={},parts={
  review:{header:'.dialog-title',request:'.review-group[aria-label="Task"]',destination:'.review-group[aria-label="Destination"]',reference:'.review-group[aria-label="Context"]',trust:'.review-decisions',action:'.review-footer'},
  capture:{header:'.dialog-title',request:'.quick-editor',action:'.quick-actions'},
  question:{header:'.dialog-title',request:'.decision-body h3',reference:'.decision-body>.hint',action:'.decision-choices'},
  result:{header:'.dialog-title',destination:'.result-task',request:'.result-prose',action:'.result-reader-actions'}
 };
 const capture=async(selector,name)=>{
  await page.evaluate(()=>{document.activeElement?.blur();return document.fonts.ready});
  regions[name]=await page.locator(selector).evaluate((root,mapping)=>{
   const r=root.getBoundingClientRect(),parts={};
   for(const [key,selector]of Object.entries(mapping)){
    const el=root.querySelector(selector);if(!el)continue;const b=el.getBoundingClientRect();
    parts[key]={x:(b.x-r.x)/r.width,y:(b.y-r.y)/r.height,w:b.width/r.width,h:b.height/r.height};
   }
   return {width:r.width,height:r.height,parts};
  },parts[name.replace('-mobile','')]);
  await page.locator(selector).screenshot({path:dest+'/'+name+'.png',omitBackground:true,
   style:'html,body{background:transparent!important}body>:not(dialog){visibility:hidden!important}dialog{box-shadow:none!important}dialog::backdrop{background:transparent!important;backdrop-filter:none!important}'});
 };
 await capture('#modal','review-mobile');
 await page.setViewportSize({width:592,height:1000});await page.evaluate(()=>{document.body.style.setProperty('--native-surface-width','560px');updateBounds()});await capture('#modal','review');
 await page.setViewportSize({width:464,height:1000});await page.evaluate(()=>{document.body.style.setProperty('--native-surface-width','432px');dismissCard();draft.quick=true;editDraft()});await capture('#modal','capture');
 await page.evaluate(()=>{dismissCard();state.decisions=[{id:'product-question',session:'product-agent',q:'Keep the timer running when you switch views?',choices:['Keep it running','Pause when I leave'],detail:'You can check your notes while the rehearsal continues.'}];showHome(true);showNotch('product-question')});await capture('#notch','question');
 await page.evaluate(()=>{
  dismissCard();showWorkspace();
  const s=sess('product-agent');s.result='# Rehearsal view updated\n\nThe timer stays readable on a narrow screen. Space still pauses the timer, and R resets it.\n\n## Changed\n\n- Larger timer at small window sizes\n- Controls stay within reach\n- Existing keyboard shortcuts preserved\n\n## Check next\n\nTry the rehearsal view on your phone before the next session.\n';
  state.captures=[{id:'product-result',session:s.id,project:'cuegrid',brief:'Make the rehearsal timer easier to read on mobile. Keep the keyboard shortcuts.',result:s.result,receipt:'Complete',kind:'Agent question',time:'Today'}];
  resultPresentation.show('product-result');
 });
 await capture('#modal','result-mobile');
 await page.setViewportSize({width:680,height:780});await capture('#modal','result');
 fs.writeFileSync(dest+'/regions.js','// Bounds measured from the real interface at capture time.\nwindow.tasktapCaptureRegions='+JSON.stringify(regions)+';\n');
 console.log(dest);
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
