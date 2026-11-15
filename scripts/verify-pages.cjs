// Exercise the deployed repository subpath. No external service is contacted.
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {createServer}=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'../build/pages');
const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.webp':'image/webp','.jpg':'image/jpeg','.png':'image/png','.mp4':'video/mp4'};
const prefix='/Tasktap/';
(async()=>{
 const server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname;
  if(!name.startsWith(prefix)){res.writeHead(404).end();return}
  const file=path.join(root,name.slice(prefix.length),name.endsWith('/')?'index.html':'');
  try{res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.end(await fs.readFile(file))}catch{res.writeHead(404).end()}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||undefined});
  const url='http://127.0.0.1:'+server.address().port+prefix;
  const page=await browser.newPage({reducedMotion:'reduce'}),errors=[];
  page.setDefaultTimeout(6000);
  page.on('pageerror',error=>errors.push(error.message));page.on('response',response=>{if(response.status()>=400)errors.push(response.url())});
  await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedCommand=text}}}));
  const shots=process.env.TASKTAP_SCREENSHOTS;if(shots)await fs.mkdir(shots,{recursive:true});
  for(const [width,height] of [[1440,1000],[820,900],[390,844],[320,780],[640,450]]){
   await page.setViewportSize({width,height});
   for(const suffix of ['','docs/']){
    await page.goto(url+suffix);
    assert.equal(await page.locator('h1').count(),1);
    const mark=page.locator('[data-brand-motion]');
    assert.ok((await mark.getAttribute('src')).endsWith('tasktap-icon.png'));
    assert.ok(await mark.evaluate(async image=>{await image.decode();return image.naturalWidth>0}));
    await page.keyboard.press('Tab');assert.equal(await page.locator(':focus').textContent(),'Skip to content');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${suffix||'home'} fits ${width}px`);
    // Lazy product imagery must also exist and decode when reached.
    await page.locator('img').evaluateAll(images=>Promise.all(images.map(async image=>{image.loading='eager';await image.decode()})));
    const refs=await page.locator('a[href]').evaluateAll(links=>links.map(link=>link.href));
    for(const ref of new Set(refs.filter(ref=>ref.startsWith(url)))){
     const target=new URL(ref),response=await page.request.get(target.href);assert.equal(response.status(),200,target.href);
     if(target.hash){const html=await response.text();assert.ok(html.includes('id="'+decodeURIComponent(target.hash.slice(1))+'"'),target.href+' anchor exists')}
    }
    await page.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0)});
    if(shots&&[1440,390,320].includes(width))await page.screenshot({path:path.join(shots,(suffix?'docs':'landing')+'-'+width+'.png'),fullPage:true});
   }
  }
  await page.setViewportSize({width:1280,height:900});await page.goto(url);
  const film=page.locator('.wave-field video');assert.equal(await film.getAttribute('poster'),'assets/glyph.jpg');assert.equal(await film.getAttribute('src'),null);
  for(const extension of ['jpg','mp4']){
   const digest=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
   assert.equal(await digest(path.join(root,'assets/glyph.'+extension)),await digest(path.resolve(__dirname,'../prototype/assets/motion/glyph/home.'+extension)),'public artwork uses the smooth wide home source');
  }
  assert.equal(await page.getByRole('button',{name:'Pause artwork',exact:true}).isVisible(),false);
  assert.equal(await page.getByRole('button',{name:'Pause logo animation'}).isVisible(),false);
  for(const download of await page.locator('a.download-app').all())assert.equal(await download.getAttribute('href'),'https://github.com/HarzerHeribert/Tasktap/releases/latest');
  assert.match(await page.locator('#download').innerText(),/Python 3/);assert.match(await page.locator('#download').innerText(),/not Apple notarized/);
  const terminal=page.locator('#terminal-install'),summary=terminal.locator('summary');
  await summary.focus();await page.keyboard.press('Enter');assert.ok(await terminal.evaluate(el=>el.open));
  assert.ok(await page.locator('#install-command').isVisible());
  assert.match(await page.locator('#install-command').innerText(),/curl -fL --proto '=https' --tlsv1\.2/);
  assert.equal((await page.request.get(url+'install.sh')).status(),200);
  await page.getByRole('button',{name:'Copy command',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.copiedCommand),await page.locator('#install-command').innerText());
  assert.match(await page.locator('#install-status').innerText(),/Command copied/);
  await summary.focus();await page.keyboard.press('Enter');assert.equal(await terminal.evaluate(el=>el.open),false);
  // Progressive enhancement: the full story, download links, source and native
  // disclosure remain usable with JavaScript disabled.
  const staticContext=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}}),staticPage=await staticContext.newPage();
  await staticPage.goto(url);await staticPage.locator('#terminal-install summary').click();
  assert.ok(await staticPage.locator('#install-command').isVisible());
  assert.equal(await staticPage.locator('a.download-app').count(),2);
  assert.ok(await staticPage.locator('a[href="install.sh"]').isVisible());
  assert.equal(await staticPage.locator('.wave-field video').getAttribute('src'),null);
  assert.ok(await staticPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  if(shots)await staticPage.screenshot({path:path.join(shots,'landing-nojs.png'),fullPage:true});await staticContext.close();
  // The guide keeps its grouped contents available without JavaScript and
  // reveals them by keyboard on a narrow screen with enhancement enabled.
  await page.setViewportSize({width:390,height:844});await page.goto(url+'docs/');
  const contents=page.locator('.contents');assert.equal(await contents.evaluate(el=>el.open),false);
  await contents.locator('summary').focus();await page.keyboard.press('Enter');assert.equal(await contents.evaluate(el=>el.open),true);
  await contents.locator('a[href="#workspaces"]').click();
  await page.waitForFunction(()=>document.querySelector('.contents a[href="#workspaces"]').getAttribute('aria-current')==='location');
  const guideStatic=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}}),guidePage=await guideStatic.newPage();
  await guidePage.goto(url+'docs/');assert.ok(await guidePage.locator('.contents a[href="#workspaces"]').isVisible());await guideStatic.close();
  // Artwork respects Reduce Motion and pause controls, preserving the cadence of
  // the slow 60 fps source at every size instead of lowering playback speed.
  await page.setViewportSize({width:1280,height:900});await page.emulateMedia({reducedMotion:'no-preference'});await page.goto(url);
  const logo=page.locator('[data-brand-motion]');
  await page.waitForFunction(()=>document.querySelector('[data-brand-motion]').src.endsWith('.webp'));
  await page.locator('.brand-lockup').hover();await page.getByRole('button',{name:'Pause logo animation'}).click();assert.ok((await logo.getAttribute('src')).endsWith('.png'));
  await page.getByRole('button',{name:'Play logo animation'}).click();
  await page.waitForFunction(()=>document.querySelector('[data-brand-motion]').src.endsWith('.webp'));
  await film.scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.wave-field video').currentTime>0);
  const media=await film.evaluate(v=>({rate:v.playbackRate,width:v.videoWidth,height:v.videoHeight,duration:v.duration}));
  assert.equal(media.rate,1);assert.equal(media.width,1200);assert.equal(media.height,240);assert.ok(Math.abs(media.duration-16)<.1);
  await page.getByRole('button',{name:'Pause artwork',exact:true}).click();assert.equal(await film.evaluate(v=>v.paused),true);
  await page.getByRole('button',{name:'Play artwork',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.wave-field video').paused);
  await page.locator('#download').scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.wave-field video').paused);
  for(const width of [390,320]){await page.setViewportSize({width,height:844});await page.evaluate(()=>scrollTo(0,0));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'motion controls fit at '+width+'px');assert.equal(await film.evaluate(v=>v.playbackRate),1,'small artwork retains full-rate playback')}
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>!document.querySelector('.wave-field video').hasAttribute('src'));
  assert.deepEqual(errors,[]);
  console.log('PASS: 1.0 product page and guide links/assets, five responsive sizes including 200%-equivalent viewport, keyboard/no-JS installer disclosure, source and clipboard, actual product images, download requirements, reduced-motion/visibility artwork controls; no browser errors.');
 }finally{if(browser)await browser.close();server.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
