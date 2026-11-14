// Exercise the same repository subpath used by GitHub Pages without external services.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '../build/pages');
const types = {'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.webp':'image/webp','.jpg':'image/jpeg','.png':'image/png','.mp4':'video/mp4'};
const originPath = '/Tasktap/';

(async () => {
  const server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (!name.startsWith(originPath)) { res.writeHead(404).end(); return; }
    const file = path.join(root, name.slice(originPath.length), name.endsWith('/') ? 'index.html' : '');
    try { res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); res.end(await fs.readFile(file)); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE || undefined});
    const page = await browser.newPage({reducedMotion:'reduce'});
    const url = 'http://127.0.0.1:'+server.address().port+originPath;
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('response',res=>{if(res.status()>=400) errors.push(res.url());});
    for(const width of [1280,390,320]) {
      await page.setViewportSize({width,height:860});
      for(const suffix of ['', 'docs/']) {
        await page.goto(url+suffix);
        assert.equal(await page.locator('h1').count(),1);
        const mark=page.locator('[data-brand-motion]');
        assert.ok((await mark.getAttribute('src')).endsWith('tasktap-icon.png'));
        assert.ok(await mark.evaluate(async img=>{await img.decode();return img.naturalWidth>0}));
        assert.equal(await page.getByRole('button',{name:'Pause logo animation'}).isVisible(),false);
        await page.keyboard.press('Tab');
        assert.equal(await page.locator(':focus').textContent(),'Skip to content');
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        const refs=await page.locator('a[href]').evaluateAll(links=>links.map(a=>a.href));
        for(const ref of refs.filter(ref=>ref.startsWith(url))) {
          const target=new URL(ref);
          assert.equal((await page.request.get(target.href)).status(),200, target.href);
          if(target.hash && target.pathname===new URL(page.url()).pathname)
            assert.equal(await page.locator(target.hash).count(),1);
        }
      }
    }
    await page.goto(url);
    const film = page.locator('video');
    assert.equal(await film.getAttribute('poster'), 'assets/glyph.jpg');
    assert.equal(await film.getAttribute('src'), null);
    assert.equal((await page.request.get(await film.evaluate(v => v.poster))).status(), 200);
    const start = page.getByRole('button', {name:'Start example session'});
    const replay = page.getByRole('button', {name:'Replay example'});
    for (const width of [320, 390, 820, 1280]) {
      await page.setViewportSize({width,height:860});
      await start.focus();
      const frame = await page.locator('.desktop').boundingBox();
      const control = await start.boundingBox();
      await page.keyboard.press('Enter');
      await page.getByText('Claude Code connected', {exact:true}).waitFor({state:'visible'});
      assert.equal(await page.locator('#example-content').isVisible(), false);
      assert.deepEqual(await page.locator('.desktop').boundingBox(), frame);
      assert.equal((await replay.boundingBox()).y, control.y);
      await page.keyboard.press('Enter');
      await start.waitFor({state:'visible'});
      assert.equal(await page.locator('#example-receipt').isVisible(), false);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    }
    const notchToggle = page.locator('.notch-toggle');
    await notchToggle.click();
    assert.equal(await notchToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#notch-details').evaluate(el=>el.inert), true);
    await page.keyboard.press('Enter');
    assert.equal(await notchToggle.getAttribute('aria-expanded'), 'true');
    await start.focus();
    await page.keyboard.press('Escape');
    assert.ok(await notchToggle.evaluate(el=>el===document.activeElement));
    await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('link',{name:/Get for Mac/}).getAttribute('href'),'https://github.com/HarzerHeribert/Tasktap/releases/latest');
    await page.goto(url+'docs/#install');
    assert.equal(await page.getByRole('heading',{name:'Get for Mac',exact:true}).count(),1);
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.evaluate(()=>window.scrollTo(0,0));
    const logo=page.locator('[data-brand-motion]');
    await page.waitForFunction(()=>document.querySelector('[data-brand-motion]').src.endsWith('.webp'));
    await logo.evaluate(img=>img.decode());
    await page.getByRole('button',{name:'Pause logo animation'}).click();
    assert.ok((await logo.getAttribute('src')).endsWith('.png'));
    await page.getByRole('button',{name:'Play logo animation'}).click();
    await page.waitForFunction(()=>document.querySelector('[data-brand-motion]').src.endsWith('.webp'));
    await page.goto(url);
    const rate=async width=>{
      await page.locator('video').evaluate((v,w)=>{v.style.width=w+'px';v.scrollIntoView({block:'center'});},width);
      await page.waitForFunction(w=>Math.abs(document.querySelector('video').playbackRate-artworkPlaybackRate(w))<0.001,width);
      return page.locator('video').evaluate(v=>v.playbackRate);
    };
    assert.ok(await rate(110)>await rate(295));
    await page.waitForFunction(() => document.querySelector('video').currentTime > 0);
    await page.getByRole('button', {name:'Pause wave'}).click();
    assert.equal(await film.evaluate(v=>v.paused), true);
    await page.getByRole('button', {name:'Play wave'}).click();
    await page.waitForFunction(() => !document.querySelector('video').paused);
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForFunction(() => !document.querySelector('video').hasAttribute('src'));
    await page.setViewportSize({width:1280,height:900});
    await page.goto(url); await page.emulateMedia({reducedMotion:'reduce'});
    if(process.env.TASKTAP_SCREENSHOTS) await page.screenshot({path:path.join(process.env.TASKTAP_SCREENSHOTS,'landing.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('Pages navigation, guides, example handoff, keyboard, responsive layout and capture motion passed.');
  } finally { if(browser) await browser.close(); server.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
