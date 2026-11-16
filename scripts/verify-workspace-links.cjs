const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:820}}),errors=[];
  page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{window.messages=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>messages.push(m)}}}});
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
  await page.evaluate(async()=>{
   state.firstRun={done:true};state.projects=[{id:'p',folder:'/tmp/link-project',name:'Link project'}];state.sessions=[];state.captures=[];state.decisions=[];
   showWorkspace();await workspaceDeck.receive([{event:'sessions',sessions:[{id:'links',cwd:'/tmp/link-project',kind:'shell',running:true,title:'Links'}]}]);workspaceDeck.open('terminal:links','p');
  });
  async function output(text){
   await page.mouse.move(0,0);
   await page.evaluate(async text=>{messages.length=0;await workspaceDeck.receive([{event:'replay',id:'links',seq:1,cols:80,rows:24,data:btoa(unescape(encodeURIComponent(text)))}])},text);
  }
  // Real mouse hit testing exercises xterm's built-in OSC 8 provider and our
  // provider together. Click a cell without depending on private xterm APIs.
  async function clickCell(row,col,alt=false){
   const m=await page.evaluate(()=>workspaceDeck.terminalMetrics('links'));
   const point={x:m.screen.left+(col+.5)*(m.screen.right-m.screen.left)/m.cols,y:m.screen.top+(row+.5)*(m.screen.bottom-m.screen.top)/m.rows};
   if(alt)await page.keyboard.down('Alt');
   await page.waitForTimeout(50);await page.mouse.move(point.x+20,point.y+20);await page.mouse.move(point.x,point.y);await page.waitForTimeout(100);await page.mouse.click(point.x,point.y);
   if(alt)await page.keyboard.up('Alt');
   return page.evaluate(()=>messages.findLast(m=>m.type==='workspace-open-link'));
  }
  await output('https://example.com/docs?q=yes#section\r\n');
  assert.deepEqual(await clickCell(0,5),{type:'workspace-open-link',href:'https://example.com/docs?q=yes#section',project:'p',cwd:'/tmp/link-project',external:false});
  await output('src/main.swift:42:7\r\n');
  assert.equal((await clickCell(0,5)).href,'src/main.swift:42:7');
  assert.equal((await clickCell(0,5,true)).external,true);
  await output('\x1b]8;;https://example.com/hidden\x07Click here\x1b]8;;\x07\r\n');
  assert.equal((await clickCell(0,4)).href,'https://example.com/hidden');
  await output('\x1b]8;;file:///tmp/My%20notes.md\x07Open notes\x1b]8;;\x07\r\n');
  assert.equal((await clickCell(0,4)).href,'file:///tmp/My%20notes.md');
  await output('\x1b]7;file://localhost/tmp/link-project/subdir\x07./README.md\r\n');
  assert.equal((await clickCell(0,4)).cwd,'/tmp/link-project/subdir');
  const url='https://example.com/'+('long-path/'.repeat(12))+'end?q=yes';
  await output(url+'\r\n');
  assert.equal((await clickCell(1,4)).href,url,'soft-wrapped URLs retain the full address');
  await output('界界 src/main.swift:12\r\n');
  assert.equal((await clickCell(0,8)).href,'src/main.swift:12','wide cells keep the correct hit range');
  await output('"/tmp/My notes.md"\r\n');
  assert.equal((await clickCell(0,8)).href,'/tmp/My notes.md');
  await output('/tmp/Über.md:2\r\n');
  assert.equal((await clickCell(0,8)).href,'/tmp/Über.md:2');
  await output('\x1b]8;;javascript:alert(1)\x07Unsafe\x1b]8;;\x07\r\n');
  assert.equal(await clickCell(0,3),undefined,'OSC 8 cannot bypass scheme validation');
  await page.evaluate(()=>{window.article=document.createElement('article');article.id='link-report';document.body.append(article);resultPresentation.render(article,'[Source](src/main.swift:12) [Website](https://example.com/) [Email](mailto:hello@example.com) [Encoded source](My%20notes.md)','p');messages.length=0});
  await page.locator('#link-report').getByRole('link',{name:'Source',exact:true}).click();
  assert.equal(await page.evaluate(()=>messages.at(-1).cwd),'/tmp/link-project');
  await page.locator('#link-report').getByRole('link',{name:'Website (opens in workspace)'}).click();
  assert.equal(await page.evaluate(()=>messages.at(-1).href),'https://example.com/');
  await page.locator('#link-report').getByRole('link',{name:'Email',exact:true}).click();
  assert.equal(await page.evaluate(()=>messages.at(-1).href),'mailto:hello@example.com');
  await page.locator('#link-report').getByRole('link',{name:'Encoded source',exact:true}).click();
  assert.equal(await page.evaluate(()=>messages.at(-1).href),'My notes.md');
  await page.evaluate(()=>{messages.length=0;article.querySelector('a').click()});
  assert.deepEqual(await page.evaluate(()=>messages),[],'synthetic activations cannot open apps');
  await page.evaluate(()=>{document.querySelector('#link-report').remove();workspaceDeck.openWeb('p','https://example.com/');workspaceDeck.openWeb('p','https://example.com/')});
  assert.equal(await page.evaluate(()=>Object.values(state.workspaceDeck.media).filter(f=>f.url==='https://example.com/').length),1,'repeated web links reuse the workspace tab');
  assert.equal(await page.getByRole('button',{name:'Open in default browser',exact:true}).count(),1);
  await page.evaluate(()=>{workspaceDeck.addFiles('p',[{id:'source',path:'/tmp/link-project/main.swift',title:'main.swift',kind:'text',url:'tasktap-preview://source/main.swift',sourceLine:'2'}]);workspaceDeck.textLoaded('source','first\nsecond\nthird')});
  assert.equal(await page.locator('.deck-document mark').textContent(),'second');
  await page.evaluate(()=>{workspaceDeck.addFiles('p',[{id:'same-source',path:'/tmp/link-project/main.swift',title:'main.swift',kind:'text',url:'tasktap-preview://same-source/main.swift',sourceLine:'3'}]);workspaceDeck.textLoaded('source','first\nsecond\nthird')});
  assert.equal(await page.locator('.deck-document mark').textContent(),'third','new line locations update the existing tab');
  assert.equal(await page.evaluate(()=>Object.values(state.workspaceDeck.media).filter(f=>f.path==='/tmp/link-project/main.swift').length),1);
  await page.evaluate(()=>workspaceDeck.addFiles('p',[{id:'html',path:'/tmp/link-project/index.html',title:'Local HTML',kind:'web',url:'tasktap-preview://html/index.html'}]));
  assert.equal(await page.locator('iframe[title="Local HTML"]').getAttribute('sandbox'),'allow-scripts allow-forms','local HTML cannot create popups');
  assert.deepEqual(errors,[]);
  console.log('Workspace links passed: real terminal clicks, OSC 8, wrapped URLs, wide cells, cwd, file positions, report links, external modifier, tab reuse, scheme validation.');
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
