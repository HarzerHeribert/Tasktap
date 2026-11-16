const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1600,height:1000}});page.setDefaultTimeout(15000);
  await page.addInitScript(()=>{window.tasktapSurface='workspace';window.messages=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>messages.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve(process.env.TASKTAP_BENCH_ROOT||'.','prototype/index.html')).href);
  await page.evaluate(async()=>{
   state.firstRun={done:true};state.projects=[{id:'p',folder:'/tmp/resize-fixture',name:'Resize fixture',aliases:[]}];state.sessions=[];state.captures=[];state.notes=[];state.decisions=[];
   await workspaceDeck.receive([{event:'sessions',sessions:['a','b','c','d'].map(id=>({id,cwd:'/tmp/resize-fixture',title:id,kind:'shell',running:true}))}]);
   showWorkspace();workspaceDeck.open('terminal:a','p');
   const l=state.workspaceDeck.layouts.p,first=l.groups[0];
   const right=workspaceLayout.split(l,first.id,'x','right');
   const bottomLeft=workspaceLayout.split(l,first.id,'y','bottom-left');
   const bottomRight=workspaceLayout.split(l,right.id,'y','bottom-right');
   for(const [group,id] of [[first,'a'],[right,'b'],[bottomLeft,'c'],[bottomRight,'d']]){group.tabs=['terminal:'+id];group.active='terminal:'+id}
   render();
   const history=Array.from({length:5000},(_,i)=>'history '+i+' '+('text '.repeat(25))+'\r\n').join('');
   for(const id of ['a','b','c','d'])await workspaceDeck.receive([{event:'replay',id,seq:0,cols:120,rows:30,data:btoa(history)}]);
  });
  await page.waitForTimeout(250);
  const result=await page.evaluate(async()=>{
   const stages=document.querySelector('#workspace-stage'),original=Terminal.prototype.resize,frameTimes=[],cost=[];let calls=0;
   Terminal.prototype.resize=function(...args){const start=performance.now();calls++;try{return original.apply(this,args)}finally{cost.push(performance.now()-start)}};
   messages=[];const start=performance.now();let previous=start;
   for(let i=0;i<45;i++){
    await new Promise(requestAnimationFrame);const now=performance.now();frameTimes.push(now-previous);previous=now;
    stages.style.width=(1250-Math.sin(i/44*Math.PI)*450)+'px';stages.style.height=(850-Math.sin(i/44*Math.PI)*200)+'px';
   }
   await new Promise(resolve=>setTimeout(resolve,250));
   Terminal.prototype.resize=original;
   const sizes=Object.fromEntries(['a','b','c','d'].map(id=>[id,workspaceDeck.terminalMetrics(id)]));
   const resizes=messages.filter(m=>m.op==='resize');
   for(const [id,size] of Object.entries(sizes)){const last=resizes.filter(m=>m.id===id).at(-1);if(!last||last.cols!==size.cols||last.rows!==size.rows)throw Error('Final PTY size mismatch '+id)}
   const sorted=frameTimes.toSorted((a,b)=>a-b);
   return {frames:frameTimes.length,elapsedMs:Math.round(performance.now()-start),resizeCalls:calls,ptyResizes:resizes.length,reflowMs:Math.round(cost.reduce((a,b)=>a+b,0)),frameMedianMs:Math.round(sorted[Math.floor(sorted.length/2)]),frameP95Ms:Math.round(sorted[Math.floor(sorted.length*.95)]),maxFrameMs:Math.round(sorted.at(-1))};
  });
  if(!process.env.TASKTAP_BENCH_BASELINE)assert.ok(result.resizeCalls<=12,'continuous resize must coalesce expensive scrollback reflows: '+JSON.stringify(result));
  console.log(JSON.stringify(result));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
