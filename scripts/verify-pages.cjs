// Exercises the built site (build/pages) under the repository subpath it is published at. No external service is
// contacted, and the run fails if the pages try to reach one. What it holds the site to:
//   - both pages at six sizes: one headline, the skip link first, no sideways scroll, every picture there and shown
//     at its own size (never scaled; the one picture of Tasktap's window is scaled to its column, never wider), every
//     link and anchor inside the site resolving
//   - the words: nothing of what was true only of 1.2, its update feed not published; downloads only by the release's
//     fixed names; both systems' download and install line, the visitor's system first, each in its order (a Mac's
//     download first, Windows' line first), with Copy, which selects the line where there is no clipboard; the install
//     scripts published as they are in site/, and as .txt to read; and one metal key in view at a time
//   - with scripts off the page still explains the product, every chapter of its story with its still picture; under
//     Reduce Motion nothing is held and nothing moves by itself
//   - the live notch (the app's own page), held beside the story, in Chromium and in WebKit: scrolled to a chapter it
//     shows that chapter's state, it never takes the keyboard (Tab goes through the page, a digit answers nothing), it
//     rests while out of sight, and it holds a question open past its own ten seconds
//   - every word keeps the app's floor of 4.5 : 1 against what it stands on
//   - what it shows of the app (site/app) is made from the app as it is: the sources scripts/render-site.cjs makes it
//     from hash as they did when it was made (site/app/SOURCE). Stale pictures are a NOTE, so work on the interface
//     goes on; with --fresh they fail the run, as where the site is published or a release made (the workflows).
// usage: node scripts/verify-pages.cjs [--fresh] [--stamp]   (--stamp: that last check alone, with no build or browser)
// TASKTAP_SCREENSHOTS=<dir> keeps pictures of what was checked.
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

// TASKTAP_PAGES=<dir> exercises another build, as story-check.cjs does.
const root = path.resolve(process.env.TASKTAP_PAGES || path.join(__dirname, '../build/pages'));
const prefix = '/Tasktap/';
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };
// True of 1.2 and not of this app (docs/rebuild-plan.md, "Repository cutover"): none of it may come back.
const RETIRED = /Python|Notebook|Activity view|Session history|review[- ]first|themes?\b|appcast|Sparkle|notariz|Homebrew|agents are not supported/i;
const SIZES = [[1440, 1000], [1024, 800], [820, 900], [390, 844], [320, 780], [640, 450]];

(async () => {
  // What the site shows of the app is made from the app as it is. Anything else there would make other pictures or
  // another notch: never published (--fresh), only noted while the interface is being worked on.
  const args = process.argv.slice(2);
  const { inputs, stamped } = require('./render-site.cjs');
  if (stamped() !== inputs()) {
    const stale = 'the site\'s pictures of the app (site/app) were made from other sources than these: run (cd ui && npm run build) && node scripts/render-site.cjs on a Mac, look at the result, and commit it';
    if (args.includes('--fresh')) (console.error('FAIL: ' + stale), process.exit(1));
    console.log('NOTE: ' + stale);
  } else if (args.includes('--stamp')) console.log('PASS: the site\'s pictures of the app are made from the app as it is');
  if (args.includes('--stamp')) return;
  const { chromium } = require('playwright');
  const server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (!name.startsWith(prefix)) return void res.writeHead(404).end();
    const file = path.join(root, name.slice(prefix.length), name.endsWith('/') ? 'index.html' : '');
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, url = origin + prefix;
  const shots = process.env.TASKTAP_SCREENSHOTS;
  if (shots) await fs.mkdir(shots, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
    const errors = [], outside = [];
    const watch = (page) => {
      page.setDefaultTimeout(10000);
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('response', (response) => response.status() >= 400 && errors.push(response.status() + ' ' + response.url()));
      page.on('request', (request) => !request.url().startsWith(origin) && !request.url().startsWith('data:') && outside.push(request.url()));
      return page;
    };
    const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    /** Every chapter's two stills put in, as scrolling past each does (site.js puts each in as it comes near). */
    const inflate = async (p) => {
      for (const id of ['say', 'place', 'work', 'ask', 'result']) for (const which of ['form', 'shot']) {
        await p.evaluate(([id, which]) => document.querySelector(`#${id} .slot.${which}`).scrollIntoView({ block: 'center' }), [id, which]);
        await p.waitForFunction(([id, which]) => !!document.querySelector(`#${id} .slot.${which} img`)?.complete, [id, which]);
      }
      await p.evaluate(() => scrollTo(0, 0));
    };

    // ---- both pages, at every size, at rest ----
    const still = await browser.newContext({ reducedMotion: 'reduce' });
    const page = watch(await still.newPage());
    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      for (const suffix of ['', 'docs/']) {
        const name = suffix ? 'guide' : 'home';
        await page.goto(url + suffix);
        assert.equal(await page.locator('h1').count(), 1, `${name} has one headline`);
        await page.keyboard.press('Tab');
        assert.equal(await page.locator(':focus').textContent(), 'Skip to content', `${name}: the skip link is first`);
        assert.ok(await fits(page), `${name} fits ${width}px`);
        // Every picture is there, and is shown at its own size (the browser gives a picture's width in CSS pixels,
        // whatever its density): one picture pixel to one screen pixel.
        // (Every picture: the chapters' stills and Tasktap's window come only as they are scrolled near, so the page
        // is scrolled from end to end first.)
        if (!suffix) (await inflate(page), await page.locator('#terminals').scrollIntoViewIfNeeded(), await page.waitForFunction(() => !!document.querySelector('#terminals img')), await page.evaluate(() => scrollTo(0, 0)));
        const pictures = await page.locator('img').evaluateAll((images) => Promise.all(images.map(async (image) => {
          image.loading = 'eager';
          await image.decode();
          return { src: image.currentSrc, natural: image.naturalWidth, shown: image.clientWidth, attr: Number(image.getAttribute('width')), hidden: image.clientWidth === 0 };
        })));
        // The notch's stills, the chrome's and Tasktap's window fit their place: shown smaller where the place is, never
        // larger.
        for (const p of pictures.filter((p) => !p.hidden))
          if (/story-|chrome-|workspace/.test(p.src)) assert.ok(p.shown <= p.natural, `${name} at ${width}px never shows ${p.src} larger than it was drawn`);
          else assert.equal(p.natural, p.shown, `${name} at ${width}px shows ${p.src} unscaled`);
        if (!suffix) assert.ok(pictures.filter((p) => !p.hidden && /story-/.test(p.src)).length === 5 && pictures.filter((p) => !p.hidden && /chrome-(say|place|work|ask|result)/.test(p.src)).length === 5 && pictures.some((p) => !p.hidden && /workspace/.test(p.src)), `home at ${width}px: every chapter's two stills and Tasktap's window were looked at (${pictures.length} pictures)`);
        // Tasktap's window: inside the screen, never panned.
        if (!suffix) {
          await page.locator('#terminals').scrollIntoViewIfNeeded();
          const w = await page.locator('#terminals img').evaluate(async (image) => {
            await image.decode();
            const slot = image.closest('.slot'), r = slot.getBoundingClientRect();
            return { inside: r.left >= 0 && r.right <= innerWidth + 1, overflow: getComputedStyle(slot).overflowX, larger: image.clientWidth > image.naturalWidth + 1 };
          });
          assert.ok(w.inside && w.overflow === 'clip' && !w.larger, `home at ${width}px shows Tasktap's window inside the screen, unpanned (${JSON.stringify(w)})`);
          await page.evaluate(() => scrollTo(0, 0));
        }
        const refs = await page.locator('a[href]').evaluateAll((links) => links.map((link) => link.href));
        for (const ref of new Set(refs.filter((ref) => ref.startsWith(url)))) {
          const target = new URL(ref), response = await page.request.get(target.href);
          assert.equal(response.status(), 200, target.href);
          if (target.hash) assert.ok((await response.text()).includes('id="' + decodeURIComponent(target.hash.slice(1)) + '"'), target.href + ' has its anchor');
        }
        await page.evaluate(() => (document.activeElement?.blur(), scrollTo(0, 0)));
        if (shots && [1440, 820, 390].includes(width)) await page.screenshot({ path: path.join(shots, `${name}-${width}.png`), fullPage: true });
      }
    }

    // ---- the words ----
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const suffix of ['', 'docs/']) {
      await page.goto(url + suffix);
      const text = await page.locator('body').innerText();
      assert.equal(RETIRED.exec(text), null, `${suffix || 'home'} says nothing that was true only of 1.2`);
      assert.equal(/!/.test(text), false, 'no exclamation marks');
      // A download only by the release's fixed names, which the install lines take too.
      for (const href of await page.locator('a[href*="releases"], a[href$=".zip"], a[href$=".dmg"], a[href$=".exe"]').evaluateAll((all) => all.map((a) => a.href)))
        assert.match(href, /^https:\/\/github\.com\/HarzerHeribert\/Tasktap\/releases\/latest\/download\/Tasktap_(aarch64\.dmg|x64-setup\.exe)$/, `${suffix || 'home'} offers ${href}`);
    }
    await page.goto(url);
    // Both systems, the visitor's first: anywhere but Windows the Mac's download, then its line; on Windows its line
    // first, since SmartScreen stops a browser's download of the installer, which is not code-signed.
    const MAC = 'curl -fsSL https://harzerheribert.github.io/Tasktap/install.sh | sh', WIN = 'irm https://harzerheribert.github.io/Tasktap/install.ps1 | iex';
    const offered = (p) => p.locator('#install :is(a[href*="releases"], pre)').evaluateAll((all) => all.filter((el) => el.getClientRects().length).map((el) => (el.tagName === 'PRE' ? el.textContent : el.href.split('/').pop())));
    assert.deepEqual(await offered(page), ['Tasktap_aarch64.dmg', MAC, WIN, 'Tasktap_x64-setup.exe']);
    assert.match(await page.locator('.top .runs').innerText(), /Windows on x64/, 'the top says Windows is offered too');
    // The first screen's line is the visitor's system's: anywhere but Windows, the Mac's.
    assert.deepEqual(await page.locator('.top pre').evaluateAll((all) => all.filter((el) => el.getClientRects().length).map((el) => el.textContent)), [MAC]);
    assert.match(await page.locator('.foot .license').innerText(), /source-available under Apache License 2\.0 with the Commons Clause/);
    // The scripts the lines run are published as they are in site/, and as a .txt copy a browser shows.
    for (const name of ['install.sh', 'install.ps1']) {
      const mine = await fs.readFile(path.resolve(__dirname, '../site', name));
      for (const served of [name, name + '.txt']) assert.ok((await (await page.request.get(url + served)).body()).equals(mine), `${served} is site/${name}`);
    }
    assert.equal((await page.request.get(url + 'appcast.xml')).status(), 404, '1.2\'s appcast.xml is no longer published');
    // On Windows, the line first; Copy puts it on the clipboard and says so.
    const windows = await browser.newContext({ viewport: { width: 1440, height: 1000 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });
    await windows.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const win = watch(await windows.newPage());
    await win.goto(url);
    assert.deepEqual(await offered(win), [WIN, 'Tasktap_x64-setup.exe', 'Tasktap_aarch64.dmg', MAC]);
    const copy = win.locator('#install .copy').first();
    await copy.click();
    assert.equal(await win.evaluate(() => navigator.clipboard.readText()), WIN, 'Copy puts the line on the clipboard');
    assert.equal(await copy.textContent(), 'Copied');
    // At the top, Windows' line, and its Copy copies that line.
    await win.evaluate(() => navigator.clipboard.writeText(''));
    await win.locator('.top .copy').click();
    assert.equal(await win.evaluate(() => navigator.clipboard.readText()), WIN, 'the top\'s Copy on Windows copies the PowerShell line');
    if (shots) await win.locator('#install').screenshot({ path: path.join(shots, 'install-windows-1440.png') });
    await windows.close();
    // Where there is no clipboard, Copy selects the line, and nothing goes wrong.
    const bareClip = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await bareClip.addInitScript(() => Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined }));
    const noClip = watch(await bareClip.newPage());
    await noClip.goto(url);
    await noClip.locator('#install .copy').first().click();
    assert.equal(await noClip.evaluate(() => getSelection().toString()), MAC, 'without a clipboard, Copy selects the line');
    await bareClip.close();
    // One metal key in view: the page's two keys shown (Copy at the top, the Mac's download) are further apart than
    // any window is tall.
    const keys = await page.locator('.key').evaluateAll((all) => all.filter((k) => k.getClientRects().length).map((k) => k.getBoundingClientRect().top + scrollY));
    assert.equal(keys.length, 2);
    assert.ok(keys[1] - keys[0] > 2000, 'the two keys never share a view');
    // The app's floor for words: 4.5 : 1 on what they stand on; in the top, on the light at its brightest.
    for (const suffix of ['', 'docs/']) {
      await page.goto(url + suffix);
      const low = await page.evaluate(() => {
        const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
        const lum = ([r, g, b]) => [r, g, b].map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        const out = [];
        for (const el of document.querySelectorAll('body *')) {
          if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || el.closest('.sr, .skip, noscript, [hidden]') || !el.getClientRects().length) continue;
          let ground = [10, 10, 11];
          if (el.closest('.key, kbd')) ground = [221, 224, 229];
          else for (let at = el; at; at = at.parentElement) {
            const c = rgb(getComputedStyle(at).backgroundColor);
            if (c.length === 3 || c[3] === 1) { ground = c; break; }
          }
          const ink = rgb(getComputedStyle(el).color), a = lum(ink), b = lum(ground), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          if (ratio < 4.5) out.push(`${el.tagName.toLowerCase()}.${el.className} “${el.textContent.trim().slice(0, 30)}” ${ratio.toFixed(2)}`);
        }
        return out;
      });
      assert.deepEqual(low, [], 'every word keeps 4.5 : 1');
    }

    // ---- Reduce Motion: nothing is held, every chapter stands with its still, and nothing moves by itself ----
    await page.goto(url);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('held')), false, 'under Reduce Motion the stage is not held');
    assert.equal(await page.locator('.notch iframe').count(), 0, 'and the live notch is not loaded');
    assert.equal(await page.locator('#stage').evaluate((el) => getComputedStyle(el).position), 'static', 'the stage scrolls with the page');
    await inflate(page);
    assert.equal(await page.locator('.still img').evaluateAll((all) => all.filter((i) => i.getClientRects().length).length), 10, 'every chapter has its two stills: the chrome\'s form, and the notch');
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length), 0, 'no animation runs');
    await still.close();

    // ---- at 2x the sharper pictures are the ones shown ----
    const dense = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const sharp = watch(await dense.newPage());
    await sharp.goto(url);
    await inflate(sharp);
    const chosen = await sharp.locator('.still img').evaluateAll((images) => Promise.all(images.map(async (image) => {
      image.loading = 'eager';
      await image.decode();
      return [image.currentSrc, image.naturalWidth, image.clientWidth];
    })));
    assert.equal(chosen.length, 10);
    for (const [src, natural, shown] of chosen) assert.ok(src.includes('@2x') && shown <= natural, `${src} is the 2x picture, never larger than drawn`);
    await dense.close();

    // ---- scripts off: the page still explains the product, each chapter with its still ----
    const plain = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    const bare = watch(await plain.newPage());
    await bare.goto(url);
    assert.ok(await bare.locator('h1').isVisible());
    const stills = await bare.locator('.still img').evaluateAll((all) => Promise.all(all.map(async (image) => {
      image.loading = 'eager';
      await image.decode();
      return image.naturalWidth > 0 && image.clientWidth > 0;
    })));
    assert.deepEqual(stills, Array(10).fill(true), 'every chapter has a picture of the chrome\'s form and one of the notch in that state');
    assert.equal(await bare.locator('.chapters-nav').isVisible(), false, 'nothing is held, so no list of chapters beside it');
    assert.equal(await bare.locator('main section:visible').count(), 3);
    assert.equal(await bare.locator('.top pre:visible').count(), 1, 'the first screen has one install line');
    assert.equal(await bare.locator('#install pre:visible').count(), 2, 'without scripts both lines stand');
    assert.equal(await bare.locator('.copy:visible').count(), 0, 'and no Copy, which needs a script');
    assert.ok(await fits(bare));
    if (shots) await bare.screenshot({ path: path.join(shots, 'home-noscript-390.png'), fullPage: true });
    await bare.goto(url + 'docs/');
    assert.ok(await bare.locator('.contents a[href="#results"]').isVisible());
    assert.equal(await bare.locator('article section:visible').count(), 11);
    await plain.close();

    // ---- no graphics card: the chrome's stills stand for the chrome, never larger than they were drawn ----
    for (const dpr of [1, 2]) {
      const bare = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: dpr });
      const flat = watch(await bare.newPage());
      await flat.goto(url);
      await flat.waitForFunction(() => document.querySelector('#stage.drawn, #stage.flat'));
      if (await flat.locator('#stage.flat').count()) {
        const mark = await flat.locator('.mark-big img').evaluate(async (i) => (await i.decode(), [i.clientWidth, i.naturalWidth]));
        assert.ok(mark[1] > 0 && mark[0] <= mark[1], `at ${dpr}x the mark's still is shown ${mark[0]} px wide, drawn ${mark[1]}`);
        for (const id of ['say', 'place', 'work', 'ask', 'result']) {
          await flat.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'start', behavior: 'instant' }), id);
          await flat.waitForFunction((id) => { const i = document.querySelector('.form-still'); return i && i.complete && i.naturalWidth > 0 && i.currentSrc.includes(`chrome-${id}`); }, id);
          const still = await flat.locator('.form-still').evaluate((i) => [Math.round(i.clientWidth * devicePixelRatio), i.naturalWidth]);
          assert.ok(still[0] <= still[1] + 1, `at ${dpr}x the chrome's still of ${id} is shown ${still[0]} device pixels wide, drawn ${still[1]}`);
          // Its words are words: the seats over it, not letters in the picture.
          if (id !== 'say') assert.equal(await flat.locator('.seat').evaluateAll((all) => all.filter((el) => +getComputedStyle(el).opacity > 0.99 && el.querySelector('b').getClientRects().length).length), 3, `at ${dpr}x the still of ${id} has its three seats' words over it`);
        }
      } else console.log(`NOTE: this browser draws the chrome itself, so its stills in the chrome's place were not looked at (at ${dpr}x)`);
      await bare.close();
    }

    // ---- the live notch and its clock, in Chromium and in WebKit ----
    const { webkit } = require('playwright');
    const other = await webkit.launch();
    try {
      for (const engine of [browser, other]) {
        const kind = engine === browser ? 'Chromium' : 'WebKit';
        // ---- the live notch, held beside the story ----
        const moving = await engine.newContext({ viewport: { width: 1280, height: 900 } });
        const live = watch(await moving.newPage());
        await live.goto(url);
        const notch = live.frameLocator('.notch iframe');
        const inside = () => live.evaluate(() => {
          const d = document.querySelector('.notch iframe')?.contentDocument;
          return { open: d?.getElementById('tab')?.getAttribute('aria-expanded') === 'true', asks: !!d?.querySelector('[data-question] .qp'), held: !!d?.documentElement.hasAttribute('data-held') };
        });
        /** A chapter's middle on the middle of the screen, where the page reads which chapter is on. */
        const to = (p, id) => p.evaluate((id) => {
          const r = document.getElementById(id).getBoundingClientRect();
          scrollBy(0, r.top + r.height / 2 - innerHeight / 2);
        }, id);
        await live.locator('.stage.live').waitFor();
        assert.ok(await live.evaluate(() => document.documentElement.classList.contains('held')), 'at 1280 by 900 the stage is held');
        await live.waitForTimeout(400);
        assert.ok(await live.evaluate(() => /^Make the rehearsal$/.test(document.querySelector('.notch iframe').contentDocument.querySelector('#sheet .hear-t')?.textContent ?? '')),
          'on the first screen the notch listens, with the first words of the task heard');
        await to(live, 'ask');
        await notch.locator('[data-question] .qp').waitFor();
        assert.equal(await live.locator('.chapters-nav [aria-current]').textContent(), 'Answer');
        assert.equal(await notch.locator('[data-question] .ans').count(), 2);
        await to(live, 'result');
        await notch.locator('.result .qp').waitFor();
        assert.match(await notch.locator('.result').innerText(), /Keep/);
        // The keyboard stays with the page: Tab goes through the page and never into the notch, and a digit pressed while
        // the question shows answers nothing.
        await to(live, 'ask');
        await notch.locator('[data-question] .qp').waitFor();
        for (let i = 0; i < 40; i++) {
          await live.keyboard.press('Tab');
          const at = await live.evaluate(() => ({ tag: document.activeElement?.tagName, inner: document.querySelector('.notch iframe').contentDocument.activeElement?.tagName }));
          assert.ok(at.tag !== 'IFRAME' && at.inner === 'BODY', `${kind}: Tab ${i + 1} stays with the page (${JSON.stringify(at)})`);
        }
        // Tab has moved the page to its links, the first screen among them: back at the question once the notch stands
        // in it again, the keyboard on the page itself.
        await live.evaluate(() => document.activeElement?.blur());
        await to(live, 'ask');
        await live.waitForTimeout(2500);
        await notch.locator('[data-question] .qp').waitFor();
        await live.keyboard.press('1');
        await live.waitForTimeout(600);
        const answered = await live.evaluate(() => document.querySelector('.notch iframe').contentWindow.__fake.calls.includes('question.answer'));
        assert.ok((await inside()).asks && !answered, `${kind}: a digit pressed on the page answers nothing in the notch`);
        await to(live, 'result');
        await notch.locator('.result .qp').waitFor();
        // Out of sight it rests: what loops in it (a working ring) stands still.
        await live.locator('#install').scrollIntoViewIfNeeded();
        await live.waitForFunction(() => document.querySelector('.notch iframe').contentDocument.documentElement.hasAttribute('data-held'));
        await to(live, 'work');
        await live.waitForFunction(() => !document.querySelector('.notch iframe').contentDocument.documentElement.hasAttribute('data-held'));
        if (shots) await live.screenshot({ path: path.join(shots, `home-live-1280-${kind}.png`) });
        await moving.close();

        // ---- on a virtual clock: the app's notch folds a question nobody touched after ten seconds; held at the
        // question's chapter, the page keeps it open for as long as the chapter is read ----
        const timed = await engine.newContext({ viewport: { width: 1280, height: 900 } });
        const p = watch(await timed.newPage());
        await p.clock.install();
        await p.goto(url);
        const until = async (want, what) => {
          for (let t = 0; t < 30000; t += 100) {
            await p.clock.runFor(100);
            if (await p.evaluate(want)) return;
          }
          assert.fail(`${what} never came`);
        };
        await until(() => document.querySelector('.stage.live'), 'the live notch');
        await to(p, 'ask');
        await until(() => !!document.querySelector('.notch iframe').contentDocument.querySelector('[data-question] .qp'), 'the question');
        await p.clock.fastForward(15000);
        await p.clock.runFor(500);
        const s = await p.evaluate(() => {
          const d = document.querySelector('.notch iframe').contentDocument;
          return { open: d.getElementById('tab').getAttribute('aria-expanded') === 'true', asks: !!d.querySelector('[data-question] .qp') };
        });
        assert.ok(s.asks && s.open, `past the notch's own ten seconds, the question is still shown (open ${s.open})`);
        await timed.close();
      }
    } finally {
      await other.close();
    }

    assert.deepEqual(outside, [], 'nothing outside the site is requested');
    assert.deepEqual(errors, []);
    console.log('PASS: the product page and the guide at six sizes (one headline, skip link, no sideways scroll, every picture after a full scroll present and never larger than drawn at 1x and 2x, links and anchors); the words (nothing of 1.2, no 1.2 feed, downloads by fixed names, both systems with the visitor first, each in its order, with Copy and its fallback, the install scripts as published, one key in view, 4.5 : 1); without a graphics card (the stills of the chrome in its place, never larger than drawn, their words as text); scripts off (every chapter with its still); Reduce Motion (nothing held, nothing moving); the live notch held beside the story in Chromium and WebKit (each chapter its state, keeps out of the keyboard under Tab and a digit, rests out of sight, holds its question open on a virtual clock); nothing requested from outside; no browser errors.');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
