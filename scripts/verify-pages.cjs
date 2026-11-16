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
    if(!suffix){
     assert.ok(await page.locator('#terminals').isVisible(),'embedded workspace is visible without opening a chapter');
     assert.ok(await page.evaluate(()=>document.querySelector('#terminals').getBoundingClientRect().bottom<=document.querySelector('#workspace').getBoundingClientRect().top),'terminal workspace leads into the routing walkthrough');
     assert.ok(await page.locator('#theme-image').evaluate(i=>i.naturalWidth>=i.clientWidth*2-2),'the prominent workspace capture retains Retina resolution');
     assert.ok(await page.evaluate(()=>[...document.querySelectorAll('.story-panel img')].every(i=>i.getAttribute('src')!==document.querySelector('#theme-image').getAttribute('src'))),'each story capture adds a distinct product view');
     if(shots&&[1440,390,320].includes(width))await page.locator('#terminals').screenshot({path:path.join(shots,'terminals-'+width+'.png')});
    }
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
  const film=page.locator('.wave-field video');assert.equal(await film.getAttribute('poster'),'assets/motion/glyph.jpg');assert.equal(await film.getAttribute('src'),null);
  for(const artwork of ['glyph'])for(const extension of ['jpg','mp4']){
   const digest=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
   assert.equal(await digest(path.join(root,'assets/motion/'+artwork+'.'+extension)),await digest(path.resolve(__dirname,'../site/assets/motion/'+artwork+'.'+extension)),'public artwork uses the high-resolution site composition');
  }
  assert.equal(await page.getByRole('button',{name:'Pause artwork',exact:true}).isVisible(),false);
  assert.equal(await page.getByRole('button',{name:'Pause logo animation'}).isVisible(),false);
  for(const download of await page.locator('a.download-app').all())assert.equal(await download.getAttribute('href'),'https://github.com/HarzerHeribert/Tasktap/releases/latest');
  assert.match(await page.locator('#download').innerText(),/Python 3/);assert.match(await page.locator('#download').innerText(),/not Apple notarized/);
  assert.equal(await page.locator('[data-art],.signature-caption,.phase-transition').count(),0,'one hero background, no artwork chooser or decorative transition');
  assert.ok(!(await page.locator('body').innerText()).includes('·'),'no separator dots');
  assert.ok(await page.locator('#install-command').isVisible());
  assert.match(await page.locator('#install-command').innerText(),/curl -fL --proto '=https' --tlsv1\.2/);
  assert.equal((await page.request.get(url+'install.sh')).status(),200);
  await page.getByRole('button',{name:'Copy install command',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.copiedCommand),await page.locator('#install-command').innerText());
  assert.match(await page.locator('#install-status').innerText(),/Command copied/);
  // Progressive enhancement: the full story, download links, source and native
  // disclosure remain usable with JavaScript disabled.
  const staticContext=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}}),staticPage=await staticContext.newPage();
  await staticPage.goto(url);
  assert.ok(await staticPage.locator('#install-command').isVisible());
  assert.equal(await staticPage.locator('a.download-app').count(),1);
  assert.equal(await staticPage.locator('.story-panel:visible').count(),5);
  assert.equal(await staticPage.locator('[role=tablist]').count(),0);
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
  assert.equal(media.rate,1);assert.equal(media.width,1920);assert.equal(media.height,900);assert.ok(Math.abs(media.duration-16)<.1);
  await page.getByRole('button',{name:'Pause artwork',exact:true}).click();assert.equal(await film.evaluate(v=>v.paused),true);
  await page.getByRole('button',{name:'Play artwork',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.wave-field video').paused);
  await page.locator('#download').scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.wave-field video').paused);
  for(const width of [390,320]){await page.setViewportSize({width,height:844});await page.evaluate(()=>scrollTo(0,0));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'motion controls fit at '+width+'px');assert.equal(await film.evaluate(v=>v.playbackRate),1,'small artwork retains full-rate playback')}
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>!document.querySelector('.wave-field video').hasAttribute('src'));
  // Every chapter is reachable by keyboard and deep link; no hidden text is
  // exposed as a second active panel. All capture edges stay inside their frame.
  for(const width of [1440,820,390,320]){
   await page.setViewportSize({width,height:900});await page.goto(url);
   for(let i=0;i<5;i++){
    await page.locator('[data-step="'+i+'"]').click();
    assert.equal(await page.locator('.story-panel:visible').count(),1);
    assert.equal(await page.locator('[role=tab][aria-selected=true]').getAttribute('data-step'),String(i));
    const panel=page.locator('.story-panel:visible');
    await panel.locator('img').evaluateAll(images=>Promise.all(images.map(i=>i.decode())));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'chapter fits '+width);
    assert.ok(await panel.locator('.scene-figure').evaluate(el=>{const box=el.getBoundingClientRect(),parent=el.closest('.story-stage').getBoundingClientRect();return box.left>=parent.left&&box.right<=parent.right&&box.bottom<=parent.bottom}),'capture stays within the stage');
    if(await panel.locator('img').count())assert.ok(await panel.locator('img').evaluate(i=>i.naturalWidth>=i.clientWidth*2-2),'capture has at least 2× resolution');
    else assert.ok(await panel.locator('.prompt-result').isVisible(),'preparation uses readable live text');
    if(shots&&[1440,390].includes(width))await page.locator('#workspace').screenshot({path:path.join(shots,'story-'+i+'-'+width+'.png')});
   }
  }
  await page.locator('[data-step="0"]').focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('[role=tab][aria-selected=true]').getAttribute('data-step'),'1');
  await page.keyboard.press('End');assert.equal(await page.locator('[role=tab][aria-selected=true]').getAttribute('data-step'),'4');
  await page.goto(url+'#scene-review');assert.ok(await page.locator('#scene-review').isVisible());
  assert.equal(await page.locator('#story-play').isVisible(),false,'Reduce Motion leaves manual chapters');
  await page.locator('#theme-image').evaluate(i=>i.decode());
  assert.ok(await page.locator('#theme-image').evaluate(i=>i.currentSrc.endsWith('agents-native.jpg')&&i.naturalWidth===3600&&i.naturalHeight===2260),'all widths use the unmodified native Retina capture');
  assert.equal(await page.locator('[data-theme]').count(),0,'no reconstructed theme variants');
  await page.evaluate(()=>scrollTo(0,0));
  assert.equal(await film.getAttribute('poster'),'assets/motion/glyph.jpg');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.waitForFunction(()=>document.querySelector('.wave-field video').currentTime>0);
  assert.equal(await film.evaluate(v=>v.videoWidth),960,'small screens use the Retina mobile encode');
  await page.locator('#workspace').scrollIntoViewIfNeeded();
  await page.locator('#step-capture').click();
  await page.locator('#story-play').click();
  await page.waitForFunction(()=>document.querySelector('#step-prepare').getAttribute('aria-selected')==='true',{},{timeout:9000});
  await page.getByRole('button',{name:'Pause the walkthrough',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.morph-shell'));
  // Live preparation text joins the same morph as the captured interface, and
  // the selected chapter remains usable when navigation interrupts it.
  await page.locator('#step-review').click();
  await page.waitForSelector('.morph-shell');
  assert.ok(await page.locator('.morph-dom .prompt-result').count(),'the prepared prompt travels into review');
  await page.waitForFunction(()=>!document.querySelector('.morph-shell'));
  assert.ok(await page.locator('#scene-review .scene-figure').isVisible());
  await page.locator('#step-prepare').click();
  await page.waitForSelector('.morph-shell');
  await page.setViewportSize({width:390,height:900});
  await page.waitForFunction(()=>!document.querySelector('.morph-shell'));
  assert.ok(await page.locator('#scene-prepare .prompt-result').isVisible(),'resizing restores the live preparation content');
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#step-capture').click();
  await page.waitForFunction(()=>!document.querySelector('.morph-shell'));
  await page.locator('#step-review').click();
  await page.waitForSelector('.morph-shell');
  assert.ok(await page.locator('.morph-piece').count()>=5,'real interface regions reassemble within one moving frame');
  const frameMotion=await page.locator('.morph-shell').evaluate(el=>el.getAnimations()[0].effect.getKeyframes());
  assert.notEqual(frameMotion[0].width,frameMotion.at(-1).width,'capture expands into the wider review');
  assert.notEqual(frameMotion[0].height,frameMotion.at(-1).height,'shared frame changes shape');
  if(shots){
   await stagePause(page,true);
   assert.equal(await page.locator('.morph-base').last().evaluate(el=>getComputedStyle(el).opacity),'0','full capture stays hidden while its components move');
   await page.screenshot({path:path.join(shots,'morph-midpoint.png')});
   await stagePause(page,false);
  }
  await page.waitForFunction(()=>!document.querySelector('.morph-shell'));
  // Rapid navigation cancels stale frames and always reveals the chosen panel.
  await page.evaluate(()=>{document.querySelector('#step-work').click();document.querySelector('#step-decision').click()});
  assert.equal(await page.locator('.morph-shell').count(),1);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>!document.querySelector('.morph-shell'));
  assert.ok(await page.locator('#scene-decision .scene-figure').isVisible());
  assert.equal(await page.locator('.story-panel:visible').count(),1);
  async function stagePause(page,pause){await page.locator('.story-stage').evaluate((stage,pause)=>{for(const a of stage.getAnimations({subtree:true})){if(pause){a.pause();a.currentTime=500}else a.play()}},pause)}
  assert.deepEqual(errors,[]);
  console.log('PASS: component morphs and cancellation, product storytelling, all chapters at four widths, Retina captures, keyboard/deep links/no-JS, glyph background and native app capture, playback and reduced motion; product page and guide links/assets, five responsive sizes including 200%-equivalent viewport, visible keyboard/no-JS installer, source and clipboard, actual product images, download requirements, reduced-motion/visibility artwork controls; no browser errors.');
 }finally{if(browser)await browser.close();server.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
