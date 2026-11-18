// Exercises the built site (build/pages) under the repository subpath it is published at. No external service is
// contacted, and the run fails if the pages try to reach one. What it holds the site to:
//   - both pages at six sizes: one headline, the skip link first, no sideways scroll, every picture there and shown
//     at its own size (never scaled), every link and anchor inside the site resolving
//   - the words: nothing of what was true only of 1.2, the retired installer and update feed not published, the
//     download area honest about there being no download, and one metal key in view at a time
//   - with scripts off the page still explains the product; under Reduce Motion nothing moves by itself
//   - the live notch (the app's own page): it plays, it can be paused and stepped, it never takes the keyboard, and
//     it rests while the top is out of sight
//   - every word keeps the app's floor of 4.5 : 1 against what it stands on
// TASKTAP_SCREENSHOTS=<dir> keeps pictures of what was checked.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '../build/pages');
const prefix = '/Tasktap/';
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png' };
// True of 1.2 and not of this app (docs/rebuild-plan.md, "Repository cutover"): none of it may come back.
const RETIRED = /Python|Notebook|Activity view|Session history|review[- ]first|themes?\b|install\.sh|appcast|Sparkle|notariz|Homebrew|agents are not supported/i;
const SIZES = [[1440, 1000], [1024, 800], [820, 900], [390, 844], [320, 780], [640, 450]];

(async () => {
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
        const pictures = await page.locator('img').evaluateAll((images) => Promise.all(images.map(async (image) => {
          image.loading = 'eager';
          await image.decode();
          return { src: image.currentSrc, natural: image.naturalWidth, shown: image.clientWidth, attr: Number(image.getAttribute('width')), hidden: image.clientWidth === 0 };
        })));
        for (const p of pictures.filter((p) => !p.hidden && !/band/.test(p.src)))
          assert.equal(p.natural, p.shown, `${name} at ${width}px shows ${p.src} unscaled`);
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
      assert.equal(await page.locator('a[href*="releases"], a[href$=".zip"], a[href$=".dmg"]').count(), 0, 'no download is offered while there is none');
    }
    await page.goto(url);
    assert.match(await page.locator('#get').innerText(), /In development/);
    assert.match(await page.locator('#get').innerText(), /There is no download yet/);
    assert.match(await page.locator('#get pre').innerText(), /host\/scripts\/build\.sh/);
    assert.match(await page.locator('.foot .license').innerText(), /source-available under Apache License 2\.0 with the Commons Clause/);
    for (const gone of ['install.sh', 'appcast.xml']) assert.equal((await page.request.get(url + gone)).status(), 404, `${gone} is no longer published`);
    // One metal key in view: the page's two keys are further apart than any window is tall.
    const keys = await page.locator('a.key').evaluateAll((all) => all.map((k) => k.getBoundingClientRect().top + scrollY));
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
          let ground = el.closest('.top') ? [29, 26, 34] : [10, 10, 11];
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

    // ---- Reduce Motion: the notch shows one telling state, and nothing moves by itself ----
    await page.goto(url);
    const frame = page.frameLocator('.notch iframe');
    await frame.locator('[data-question] .qp').waitFor();
    assert.equal(await page.locator('.steps [aria-current]').textContent(), 'Needs you');
    assert.equal(await page.locator('.hold').isVisible(), false, 'nothing plays, so nothing is paused');
    await page.waitForTimeout(2500);
    assert.equal(await page.locator('.steps [aria-current]').textContent(), 'Needs you', 'it stays where it is');
    assert.equal(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length), 0, 'no animation runs');
    assert.equal(await page.locator('.light').getAttribute('data-moves'), 'false');
    await page.getByRole('button', { name: 'Result', exact: true }).click();
    await frame.locator('.result .qp').waitFor();
    assert.match(await frame.locator('.result').innerText(), /Keep/);
    await still.close();

    // ---- at 2x the sharper pictures are the ones shown ----
    const dense = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const sharp = watch(await dense.newPage());
    await sharp.goto(url);
    const chosen = await sharp.locator('.shot img').evaluateAll((images) => Promise.all(images.map(async (image) => {
      image.loading = 'eager';
      await image.decode();
      return [image.currentSrc, image.naturalWidth, image.clientWidth];
    })));
    assert.equal(chosen.length, 3);
    for (const [src, natural, shown] of chosen) assert.ok(src.includes('@2x') && natural === shown, `${src} is the 2x picture, unscaled`);
    await dense.close();

    // ---- scripts off: the page still explains the product ----
    const plain = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    const bare = watch(await plain.newPage());
    await bare.goto(url);
    assert.ok(await bare.locator('h1').isVisible());
    assert.ok(await bare.locator('.notch-ask img').evaluate(async (image) => (await image.decode(), image.naturalWidth > 0 && image.clientWidth > 0)), 'the notch is a picture');
    assert.ok(await bare.locator('.still-says').isVisible(), 'and its caption says what it shows');
    assert.equal(await bare.locator('.steps').isVisible(), false);
    assert.equal(await bare.locator('main section:visible').count(), 7);
    assert.ok(await bare.locator('#get pre').isVisible());
    assert.ok(await fits(bare));
    if (shots) await bare.screenshot({ path: path.join(shots, 'home-noscript-390.png'), fullPage: true });
    await bare.goto(url + 'docs/');
    assert.ok(await bare.locator('.contents a[href="#results"]').isVisible());
    assert.equal(await bare.locator('article section:visible').count(), 9);
    await plain.close();

    // ---- the live notch ----
    const moving = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const live = watch(await moving.newPage());
    await live.goto(url);
    const notch = live.frameLocator('.notch iframe');
    await live.locator('.stage.live').waitFor();
    // It plays: the thought is typed into the app's own capture line.
    await live.locator('.steps [aria-current]').filter({ hasText: 'Put in' }).waitFor();
    await live.waitForFunction(() => document.querySelector('.notch iframe').contentDocument.querySelector('#capture-input')?.value.length > 4);
    assert.notEqual(await live.evaluate(() => document.activeElement?.tagName), 'IFRAME', 'the notch never takes the keyboard');
    // Paused, it holds where it is.
    await live.getByRole('button', { name: 'Pause', exact: true }).click();
    await live.waitForTimeout(300);
    const typed = () => notch.locator('#capture-input').inputValue();
    const held = await typed();
    await live.waitForTimeout(900);
    assert.equal(await typed(), held, 'paused, the walk-through holds');
    assert.equal(await live.locator('.light').getAttribute('data-moves'), 'false');
    await live.getByRole('button', { name: 'Play', exact: true }).click();
    // A step can be chosen: the question, in full, in the app's own card.
    await live.getByRole('button', { name: 'Needs you', exact: true }).click();
    await notch.locator('[data-question] .qp').waitFor();
    await live.locator('.light[data-state=needs][data-moves=true]').waitFor();
    assert.equal(await notch.locator('[data-question] .ans').count(), 2);
    // The chrome: drawn live where the browser can, else its picture stands.
    const drawn = await live.locator('#band').evaluate((band) => !!band.querySelector('canvas') || band.querySelector('img').clientWidth > 0);
    assert.ok(drawn, 'the chrome is drawn, or its picture stands in');
    // Out of sight it rests.
    await live.locator('#get').scrollIntoViewIfNeeded();
    await live.locator('.light[data-moves=false]').waitFor();
    await live.evaluate(() => scrollTo(0, 0));
    await live.locator('.light[data-moves=true]').waitFor();
    if (shots) await live.screenshot({ path: path.join(shots, 'home-live-1280.png') });
    await moving.close();

    assert.deepEqual(outside, [], 'nothing outside the site is requested');
    assert.deepEqual(errors, []);
    console.log('PASS: the product page and the guide at six sizes (one headline, skip link, no sideways scroll, pictures present and unscaled at 1x and 2x, links and anchors); the words (nothing of 1.2, no installer or feed, an honest download area, one key in view, 4.5 : 1); scripts off; Reduce Motion; the live notch (plays, pauses, steps, keeps out of the keyboard, rests out of sight); nothing requested from outside; no browser errors.');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
