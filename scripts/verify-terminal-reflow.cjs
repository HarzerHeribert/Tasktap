const {chromium}=require('playwright');
const {spawn}=require('node:child_process');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const readline=require('node:readline');const {pathToFileURL}=require('node:url');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tasktap-reflow-'));fs.mkdirSync(root+'/zsh');
 const env={...process.env,TASKTAP_TERMINAL_ROOT:root+'/Terminals',ZDOTDIR:root+'/zsh',PS1:'LEFT_PROMPT> ',RPROMPT:'25.2'};
 const serve=spawn('python3',[process.env.TASKTAP_LEGACY_SERVER||'scripts/workspace_terminal.py','serve'],{env,stdio:'ignore'});
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE});const page=await browser.newPage({viewport:{width:1400,height:900}});
 let bridge,ready=false,chain=Promise.resolve(),startup=[],lastSeq=0;
 try{
  for(let n=0;n<50&&!fs.existsSync(root+'/Terminals/session.sock');n++)await new Promise(r=>setTimeout(r,30));
  bridge=spawn('python3',['scripts/workspace_terminal.py','bridge'],{env,stdio:['pipe','pipe','inherit']});
  const send=m=>bridge.stdin.write(JSON.stringify(m)+'\n');
  const deliver=e=>{if(e.seq)lastSeq=e.seq;if(!e.event)return;if(!ready){startup.push(e);return}chain=chain.then(()=>page.evaluate(e=>workspaceDeck.receive([e]),e));};
  readline.createInterface({input:bridge.stdout}).on('line',line=>deliver(JSON.parse(line)));
  await page.exposeFunction('nativeMessage',m=>{if(m.type==='workspace-terminal')send(m)});
  await page.addInitScript(()=>{window.webkit={messageHandlers:{workspace:{postMessage:m=>window.nativeMessage(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.evaluate(folder=>{state.firstRun={done:true};state.projects=[{id:'p',folder,name:'Reflow fixture',aliases:[]}];state.sessions=[];state.decisions=[];showWorkspace();go('p')},root);
  ready=true;for(const e of startup)deliver(e);
  send({op:'start',id:'aaaaaaaa-1111-4111-8111-111111111111',cwd:root,kind:'shell',title:'Reflow fixture',cols:100,rows:30,argv:process.env.TASKTAP_REFLOW_SHELL!=='bash'&&fs.existsSync('/bin/zsh')?['/bin/zsh','-f','-i']:['/bin/bash','--noprofile','--norc','-i']});
  await page.waitForFunction(()=>workspaceDeck.terminalText('aaaaaaaa-1111-4111-8111-111111111111')?.includes('LEFT_PROMPT'));
  await page.evaluate(()=>workspaceDeck.open('terminal:aaaaaaaa-1111-4111-8111-111111111111','p'));
  await page.waitForTimeout(200);
  send({op:'input',id:'aaaaaaaa-1111-4111-8111-111111111111',data:Buffer.from("for n in {1..18}; do printf 'HISTORY_MARKER_%s\\n' $n; done\n").toString('base64')});
  await page.waitForFunction(()=>workspaceDeck.terminalText('aaaaaaaa-1111-4111-8111-111111111111').includes('HISTORY_MARKER_18'));
  for(const width of [850,540,1200,480,1350,600]){await page.setViewportSize({width,height:900});await page.waitForTimeout(250);}
  await chain;
  const before=await page.evaluate(()=>workspaceDeck.terminalText('aaaaaaaa-1111-4111-8111-111111111111'));
  send({op:'attach',id:'aaaaaaaa-1111-4111-8111-111111111111'});await page.waitForTimeout(500);await chain;
  const after=await page.evaluate(()=>workspaceDeck.terminalText('aaaaaaaa-1111-4111-8111-111111111111'));
  require('node:assert/strict').equal(after,before,'real shell screen must replay identically after width changes');
  const old=bridge;old.stdin.end();await new Promise(resolve=>old.once('exit',resolve));
  bridge=spawn('python3',['scripts/workspace_terminal.py','bridge'],{env,stdio:['pipe','pipe','inherit']});
  readline.createInterface({input:bridge.stdout}).on('line',line=>deliver(JSON.parse(line)));
  await page.waitForTimeout(500);await chain;
  require('node:assert/strict').equal(await page.evaluate(()=>workspaceDeck.terminalText('aaaaaaaa-1111-4111-8111-111111111111')),before,'a new bridge restores the same screen from its private checkpoint');
  require('node:assert/strict').equal(fs.statSync(root+'/Terminals/Replay/aaaaaaaa-1111-4111-8111-111111111111.json').mode&0o077,0,'checkpoints stay private');
  console.log('PASS: real shell + PTY bridge, repeated width changes, exact history/prompt replay, new bridge recovery and private checkpoints.');
 }finally{if(bridge){bridge.stdin.end();bridge.kill()}serve.kill();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
