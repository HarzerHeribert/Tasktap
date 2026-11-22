// The product page's story, scrolled as a person scrolls it, on the built site (build/pages: python3 scripts/build-site.py
// first), in Chromium and in WebKit. Each part below is one promise the page keeps; every part runs, and the run fails
// if any did. What it holds the page to:
//   first screen     the headline, the install line with its Copy and what Tasktap runs on, without scrolling, at the
//                    usual window sizes; where the stage is held the visitor's window is the screen: the notch hangs
//                    from its top edge, in the middle, 420 px wide as in the app, showing a task being said, and the
//                    first screen's words stand clear of it; the install line never breaks inside its address
//   story            each chapter in view puts the app's notch in that chapter's state, forwards and backwards; one
//                    chapter's words stand at a time, whole, clear of the notch and of the chrome's rings; the rings'
//                    seats name their projects; the list of chapters says which and goes there; the whole story with
//                    its first screen is at most four and a half screens
//   the chrome       with a graphics card: the mark is drawn by the chrome (its still is never fetched), every chapter
//                    has a form of its own and so has the way between two, nothing is drawn at rest, a working ring's
//                    light turns, and scrolled back the first screen is the very picture it was (a renderer on the
//                    processor is allowed 2 of 255 where the chrome draws; the check prints what draws the chrome, how
//                    many pixels differ, by how much and where); without one: each chapter's still of the chrome stands
//                    in its place, and scrolled back the first screen is the picture it was, pixel for pixel
//   a reader         in the held layout the accessibility tree holds, wherever the page is scrolled: every chapter's
//                    words in their order, each with what its pictures show; the headline, the install line and
//                    Copy; never the canvas, the live notch or the seats. The keyboard reaches the first screen's
//                    Copy from a chapter, and the page goes there
//   by touch         phones 360 and 430 wide, one on its side (844 by 390) and one 320 wide, and a tablet at 1024 by
//                    768, each with touch and a mobile viewport: no sideways scroll; every link a finger needs at least
//                    44 px tall; no text under 12 px; the notch's stills at the screen's own density, none shown larger
//                    than drawn or taller than the window, and at their own size on the narrowest; turning the phone
//                    keeps the reader's place; the tablet holds the stage
//   layout shift     none while the story is scrolled, counted where a browser reports it (Chromium), with the seats
//                    shown; WebKit reports none, and the check says so instead of asserting nothing
//   quick returns    the stage always ends in the state of the chapter in view, however quickly the reader turns back
//   still until live until the live notch stands in the chapter's state, the stage shows that chapter's still: with
//                    Save-Data, with the notch's page blocked, on a slow connection
//   in sight only    a jump past the story asks the notch for nothing and loads no notch; back in sight, the stage
//                    goes to its chapter's state at once
//   stills           never wider than their place or larger than drawn; fetched only as they come near
//   place kept       switching Reduce Motion, or the window crossing the stage's width, keeps the chapter in view
//   copy             each Copy names its line, says what it did, and says how to copy where it could only select
//   keys             the keys in the chapters are the visitor's system's
//   phone, Reduce Motion, no sideways scroll, no layout shift, the facts one click past the story, Tasktap's window,
//   still at rest (Chromium's trace), the words with scripts off: six at most to a chapter, 45 at most in the story
// usage: node scripts/story-check.cjs [chromium|webkit]   TASKTAP_PAGES=<dir> checks another build;
//        TASKTAP_SCREENSHOTS=<dir> keeps a picture of the places checked; TASKTAP_NO_CARD=1 runs Chromium's part on
//        the chrome without the graphics card, as a server runs it (the stills' path).
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(process.env.TASKTAP_PAGES || path.join(__dirname, '../build/pages'));
const prefix = '/Tasktap/';
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const STEPS = ['say', 'place', 'work', 'ask', 'result'];
const NAMES = { say: 'Say', place: 'Place', work: 'Work', ask: 'Answer', result: 'Keep' };
const PICTURE = { rest: 'open', say: 'say', place: 'place', work: 'work', ask: 'ask', result: 'result' };
const MAC = 'curl -fsSL https://harzerheribert.github.io/Tasktap/install.sh | sh', WIN = 'irm https://harzerheribert.github.io/Tasktap/install.ps1 | iex';
/** Where the stage is held: a window wide and tall enough for the notch with the chrome under it, or beside it. */
const holds = (w, h) => (w >= 1000 && h >= 700) || (w >= 1280 && h >= 600);
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** What the notch shows, read from inside its page: which of the story's states it is in. */
function state() {
  const d = document.querySelector('.notch iframe')?.contentDocument;
  if (!d || !d.getElementById('tab')) return { step: null };
  const open = d.getElementById('tab').getAttribute('aria-expanded') === 'true';
  const text = (s) => d.querySelector(s)?.textContent ?? '';
  const rows = [...d.querySelectorAll('#sheet .row')];
  const says = {
    open,
    heard: text('#sheet .hear-t'),
    listening: !!d.querySelector('#sheet .cap-row.hear'),
    way: text('#sheet .way'),
    working: rows.filter((r) => r.dataset.status === 'working' && r.querySelector('.ring-o .turn')).length,
    asks: !!d.querySelector('#sheet [data-question] .qp'),
    answers: d.querySelectorAll('#sheet [data-question] .ans').length,
    result: text('#sheet .result'),
    settled: rows.filter((r) => r.dataset.status === 'done').length,
  };
  // The state each chapter names, as the notch draws it.
  says.step = says.listening && says.heard === 'Make the rehearsal' ? 'rest'
    : says.listening && /on phones$/.test(says.heard) ? 'say'
    : /Starting in\s*cuegrid/.test(says.way) ? 'place'
    : says.asks && says.answers === 2 ? 'ask'
    : /Keep/.test(says.result) && /3 files/.test(says.result) && says.settled >= 1 ? 'result'
    : says.working === 3 && !says.result ? 'work'
    : 'between';
  return says;
}

(async () => {
  const server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (!name.startsWith(prefix)) return void res.writeHead(404).end();
    const file = path.join(root, name.slice(prefix.length), name.endsWith('/') ? 'index.html' : '');
    try {
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(await fs.readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}${prefix}`;
  const shots = process.env.TASKTAP_SCREENSHOTS;
  if (shots) await fs.mkdir(shots, { recursive: true });
  const playwright = require('playwright');
  const which = process.argv[2] ? [process.argv[2]] : ['chromium', 'webkit'];
  const results = [];

  for (const kind of which) {
    const browser = await playwright[kind].launch({ executablePath: kind === 'chromium' ? process.env.BROWSER_EXECUTABLE || undefined : undefined });
    const errors = [];
    /** A page of the site: every shift of the layout counted from the first paint, every message the notch's page is
     *  sent kept in it (`__got`), errors noted. */
    const open = async (options = {}, { hash = '', init, route, wait = true } = {}) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
      await context.addInitScript(() => {
        window.__shift = 0;
        try {
          new PerformanceObserver((list) => list.getEntries().forEach((e) => !e.hadRecentInput && (window.__shift += e.value))).observe({ type: 'layout-shift', buffered: true });
        } catch {}
        window.__got = [];
        addEventListener('message', (e) => e.data && e.data.tasktap === 'page' && window.__got.push(`${e.data.do}:${e.data.step ?? e.data.held ?? ''}`));
      });
      if (init) await context.addInitScript(init);
      if (route) await route(context);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(url + hash, { waitUntil: wait ? 'load' : 'commit' });
      return page;
    };
    const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    const inView = (page, selector) => page.locator(selector).evaluateAll((all) => all.filter((el) => el.getClientRects().length).map((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight && r.width > 0;
    }));
    /** A chapter in view: where the stage is held, the place in the page's scroll where the chapter rests, its words
     *  beside the chrome; elsewhere the chapter's start at the top. */
    const centre = (page, id) => page.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'start', behavior: 'instant' }), id);
    const settle = async (page, want, what) => {
      for (let t = 0; t < 8000; t += 100) {
        const s = await page.evaluate(state);
        if (s.step === want) return s;
        await page.waitForTimeout(100);
      }
      assert.fail(`${what}: the notch never showed ${want} (${JSON.stringify(await page.evaluate(state))})`);
    };
    const live = (page) => page.locator('.stage.live').waitFor();
    const got = (page) => page.evaluate(() => document.querySelector('.notch iframe')?.contentWindow.__got ?? null);
    const forget = (page) => page.evaluate(() => { const w = document.querySelector('.notch iframe')?.contentWindow; if (w) w.__got = []; });
    /** Every chapter's two stills put in, as scrolling past each would. */
    const inflate = async (page) => {
      for (const id of STEPS) for (const which of ['form', 'shot']) {
        await page.evaluate(([id, which]) => document.querySelector(`#${id} .slot.${which}`).scrollIntoView({ block: 'center' }), [id, which]);
        await page.waitForFunction(([id, which]) => !!document.querySelector(`#${id} .slot.${which} img`)?.complete, [id, which]);
      }
      await page.evaluate(() => scrollTo(0, 0));
    };
    /** The notch's sheet, in the window: where the first screen's words and a chapter's must not stand. */
    const SHEET = `(() => { const f = document.querySelector('.notch iframe').getBoundingClientRect(), d = document.querySelector('.notch iframe').contentDocument.getElementById('sheet').getBoundingClientRect(); return { left: f.left + d.left, right: f.left + d.right, top: f.top + d.top, bottom: f.top + d.bottom, width: d.width }; })()`;
    const part = async (name, run) => {
      const t0 = Date.now();
      try {
        await run();
        results.push([kind, name, 'PASS', Date.now() - t0]);
      } catch (e) {
        results.push([kind, name, `FAIL: ${String(e.message || e).split('\n')[0]}`, Date.now() - t0]);
      }
      for (const context of browser.contexts()) await context.close();
    };

    await part('first screen', async () => {
      for (const [width, height] of [[1440, 900], [1280, 720], [1366, 768], [1366, 650], [1000, 700], [1000, 620], [390, 844]]) {
        const size = `${width}×${height}`, held = holds(width, height);
        const page = await open({ viewport: { width, height } });
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains('held')), held, `${size}: the stage is ${held ? '' : 'not '}held`);
        assert.equal((await page.locator('h1').innerText()).replace(/\s+/g, ' '), 'Tell any coding agent what to do, out loud.', `${size}: the headline`);
        assert.deepEqual(await inView(page, 'h1'), [true], `${size}: the headline is on the first screen`);
        assert.deepEqual(await inView(page, '.top pre'), [true], `${size}: the install line is on the first screen`);
        assert.deepEqual(await inView(page, '.top .copy'), [true], `${size}: and its Copy`);
        assert.deepEqual(await inView(page, '.top .runs'), [true], `${size}: and what Tasktap runs on`);
        if (held) {
          // The visitor's window is the screen: the notch hangs from its top edge, in the middle, at the app's own size.
          const n = await page.locator('.notch').evaluate((el) => { const r = el.getBoundingClientRect(); return [r.top, Math.abs(r.left + r.width / 2 - innerWidth / 2) <= 0.5]; });
          assert.deepEqual(n, [0, true], `${size}: the notch hangs from the window's top edge, in its middle`);
          // A task being said: the still of that frame, then the live notch standing in it.
          assert.match(await page.locator('.notch-still img').evaluate((i) => i.currentSrc), /story-open/, `${size}: the notch shows a task being said`);
          await live(page);
          await settle(page, 'rest', `${size} at the top`);
          const sheet = await page.evaluate(SHEET);
          assert.deepEqual([sheet.width, sheet.top], [420, 0], `${size}: the notch is 420 px wide, as in the app, whatever the window's width`);
          const under = await page.evaluate((s) => [...document.querySelectorAll('.top-text h1, .top-text .lead, .top-text pre, .top-text .get-row > *')].filter((el) => el.getClientRects().length).filter((el) => {
            const r = el.getBoundingClientRect();
            return !(r.top >= s.bottom || r.right <= s.left || r.left >= s.right);
          }).map((el) => el.className || el.tagName), sheet);
          assert.deepEqual(under, [], `${size}: the first screen's words stand clear of the notch`);
          // From the first paint, before any script or picture has come: the notch's first still is not put off (no
          // lazy loading: it is on the first screen), and the mark's place holds the mark, small, in the page's styles.
          assert.equal(await page.locator('.notch-still img').getAttribute('loading'), null, `${size}: the notch's first still is fetched at once`);
          const small = await page.locator('.mark-big').evaluate((el) => { const b = getComputedStyle(el, '::before'); return [/^url\("data:image\/webp;base64,/.test(b.backgroundImage), b.backgroundImage.length < 4096, Math.round(parseFloat(b.width)) === Math.round(el.getBoundingClientRect().width)]; });
          assert.deepEqual(small, [true, true, true], `${size}: the mark's place holds a small picture of the mark from the first paint, as large as the place, under 4 KiB`);
          // The mark, large: drawn by the chrome, or where that cannot be drawn, its still.
          await page.waitForFunction(() => document.querySelector('#stage.drawn') || document.querySelector('.mark-big img')?.complete);
          assert.deepEqual(await inView(page, '.mark-big'), [true], `${size}: the mark is on the first screen`);
        } else assert.equal(await page.locator('.notch iframe').count(), 0, `${size}: no live notch where nothing is held`);
        assert.ok(await fits(page), `${size}: no sideways scroll`);
        if (shots && kind === 'chromium') await page.screenshot({ path: path.join(shots, `story-${width}x${height}-first.png`) });
        await page.context().close();
      }
      const page = await open({ viewport: { width: 900, height: 900 } });
      for (let width = 900; width <= 1440; width += 20) {
        await page.setViewportSize({ width, height: 900 });
        const lines = await page.evaluate(() => {
          const code = document.querySelector('.top pre.for-mac code').firstChild, at = code.textContent.indexOf('https://');
          const range = document.createRange();
          range.setStart(code, at);
          range.setEnd(code, code.textContent.indexOf(' ', at));
          return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
        });
        assert.equal(lines, 1, `at ${width}px the install line breaks inside its address`);
      }
    });

    await part('story forwards and backwards', async () => {
      const page = await open();
      await live(page);
      await settle(page, 'rest', 'at the top');
      const long = await page.locator('#story').evaluate((el) => el.getBoundingClientRect().height / innerHeight);
      assert.ok(long <= 4.5, `the story, its first screen with it, is ${long.toFixed(2)} screens long`);
      await page.waitForFunction(() => document.querySelector('#stage.drawn, #stage.flat'));
      const drawn = !!(await page.locator('#stage.drawn').count());
      for (const order of [STEPS, [...STEPS].reverse()]) {
        for (const step of order) {
          const back = order[0] === 'result' ? ', scrolled back' : '';
          await centre(page, step);
          await settle(page, step, `at ${step}${back}`);
          assert.equal(await page.locator('.chapters-nav [aria-current]').textContent(), NAMES[step], `the list of chapters says ${NAMES[step]}`);
          // One chapter's words stand, whole, in the window, clear of the notch and of the chrome's rings.
          const words = await page.evaluate(([step, s]) => {
            const shown = [], out = [], stage = document.getElementById('stage').getBoundingClientRect();
            const rings = [...document.querySelectorAll('.seat')].filter((el) => +getComputedStyle(el).opacity > 0.5).map((el) => stage.left + new DOMMatrix(getComputedStyle(el).transform).e - 100 * new DOMMatrix(el.querySelector('svg').style.transform || 'scale(.6)').a);
            for (const ch of document.querySelectorAll('.chapter')) {
              const t = ch.querySelector('.ch-text'), o = +getComputedStyle(t).opacity;
              if (o > 0.01) shown.push(o > 0.99 ? ch.id : `${ch.id} at ${o}`);
              if (ch.id !== step) continue;
              const r = t.getBoundingClientRect();
              if (r.top < 0 || r.bottom > innerHeight || r.left < 0) out.push('outside the window');
              if (!(r.top >= s.bottom || r.right <= s.left || r.left >= s.right)) out.push('under the notch');
              if (rings.length && r.right > Math.min(...rings)) out.push('over the rings');
            }
            return { shown, out };
          }, [step, await page.evaluate(SHEET)]);
          assert.deepEqual(words, { shown: [step], out: [] }, `at ${step}${back}: the chapter's words alone, clear of the notch and the rings`);
          // The rings' seats, over the live chrome and over its still alike: from Place on, three, named for their
          // projects in words (never in the picture), and what changed only under the result.
          const seats = await page.locator('.seat').evaluateAll((all) => all.filter((el) => +getComputedStyle(el).opacity > 0.99).map((el) => {
            const r = el.querySelector('b').getBoundingClientRect(), u = el.querySelector('u');
            return `${el.querySelector('b').textContent}${r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight ? '' : ' (cut)'}${u && +getComputedStyle(u).opacity > 0.99 ? ' ' + u.textContent : ''}`;
          }));
          assert.deepEqual(seats, step === 'say' ? [] : step === 'result' ? ['cuegrid 3 files +21 −6', 'fieldnotes', 'ledger-api'] : ['cuegrid', 'fieldnotes', 'ledger-api'], `at ${step}${back}: the rings' seats`);
          if (!drawn) {
            // No graphics card: the chapter's still of the chrome, never shown larger than it was drawn.
            await page.waitForFunction((step) => { const i = document.querySelector('.form-still'); return i && i.complete && i.naturalWidth > 0 && i.currentSrc.includes(`chrome-${step}`); }, step);
            const still = await page.locator('.form-still').evaluate((i) => [Math.round(i.clientWidth * devicePixelRatio), i.naturalWidth]);
            assert.ok(still[0] <= still[1] + 1, `at ${step}${back}: the chrome's still is shown ${still[0]} device pixels wide, drawn ${still[1]}`);
          }
          assert.ok(await fits(page), `no sideways scroll at ${step}`);
          if (shots && kind === 'chromium' && order[0] === 'say') await page.screenshot({ path: path.join(shots, `story-1440-${STEPS.indexOf(step) + 1}-${step}.png`) });
        }
      }
      await page.evaluate(() => scrollTo(0, 0));
      await settle(page, 'rest', 'back at the top');
      await page.locator('.chapters-nav a', { hasText: 'Answer' }).click();
      await settle(page, 'ask', "by the list's Answer");
      // WebKit reports no layout shift at all: asserted where it can be measured, and said where it cannot.
      if (kind === 'chromium') {
        const shift = await page.evaluate(() => window.__shift);
        assert.ok(shift < 0.005, `the layout shifted by ${shift}`);
      } else console.log(`${kind}: this browser reports no layout shift, so none is asserted here (Chromium's run asserts it)`);
    });

    await part('the chrome', async () => {
      // With a graphics card (a Mac's own; a server has none) the chrome is drawn live; without one, its stills stand.
      const metal = kind === 'chromium' && process.platform === 'darwin' && !process.env.TASKTAP_NO_CARD ? await playwright.chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] }) : null;
      try {
        const page = await (await (metal || browser).newContext({ viewport: { width: 1440, height: 900 } })).newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(url);
        await page.waitForFunction(() => document.querySelector('#stage.drawn, #stage.flat'));
        const drawn = !!(await page.locator('#stage.drawn').count());
        console.log(`${kind}: the chrome is ${drawn ? 'drawn live' : 'shown as stills (no graphics card to draw it with)'}`);
        // The story scrolled from end to end by the wheel and back by steps, with the seats shown and moving: nothing
        // of the layout shifts. Every shift counts, whatever the browser thinks caused it.
        if (kind === 'chromium') {
          await page.evaluate(() => { window.__all = 0; new PerformanceObserver((list) => list.getEntries().forEach((e) => (window.__all += e.value))).observe({ type: 'layout-shift', buffered: true }); });
          const end = await page.evaluate(() => document.getElementById('story').offsetHeight - innerHeight);
          await page.mouse.move(400, 500);
          for (let i = 0; i < 120; i++) (await page.mouse.wheel(0, end / 120), await page.waitForTimeout(16));
          for (let i = 60; i >= 0; i--) (await page.evaluate((y) => scrollTo(0, y), (end * i) / 60), await page.waitForTimeout(16));
          await page.waitForTimeout(600);
          const shift = await page.evaluate(() => window.__all);
          console.log(`${kind}: layout shift while the story is scrolled, chrome ${drawn ? 'drawn' : 'as stills'}: ${shift.toFixed(4)}`);
          assert.ok(shift < 0.001, `scrolling the story shifted the layout by ${shift.toFixed(4)}`);
          assert.ok(await page.locator('.seat').evaluateAll((all) => all.length === 3), 'with the three seats in the page');
        } else console.log(`${kind}: this browser reports no layout shift, so the story's shift is not measured here (Chromium's run measures it)`);
        if (metal) assert.ok(drawn, 'with a graphics card the chrome is drawn');
        /** The part of the window the chrome's forms stand in at this size, as it looks now. */
        const CLIP = { x: 520, y: 300, width: 900, height: 560 };
        const look = async () => (await page.screenshot({ clip: CLIP })).toString('base64');
        /** How two of those pictures differ: how many pixels, by how much at most (of 255, any channel), within which
         *  box of the window, and how many of them lie where the chrome draws the mark (the mark's place) and outside. */
        const differs = async (a, z) => page.evaluate(async ([a, z, clip]) => {
          const load = (s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = 'data:image/png;base64,' + s; });
          const [ia, iz] = [await load(a), await load(z)], w = ia.width, h = ia.height, k = w / clip.width;
          const px = (i) => { const g = Object.assign(document.createElement('canvas'), { width: w, height: h }).getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, w, h).data; };
          const da = px(ia), dz = px(iz), m = document.querySelector('.mark-big').getBoundingClientRect();
          const out = { pixels: 0, of: w * h, most: 0, mark: 0, elsewhere: 0, box: null };
          let x0 = w, y0 = h, x1 = -1, y1 = -1;
          for (let i = 0; i < da.length; i += 4) {
            const d = Math.max(Math.abs(da[i] - dz[i]), Math.abs(da[i + 1] - dz[i + 1]), Math.abs(da[i + 2] - dz[i + 2]));
            if (!d) continue;
            const x = (i / 4) % w, y = Math.floor(i / 4 / w), wx = clip.x + x / k, wy = clip.y + y / k;
            out.pixels++;
            out.most = Math.max(out.most, d);
            wx >= m.left - 8 && wx <= m.right + 8 && wy >= m.top - 8 && wy <= m.bottom + 8 ? out.mark++ : out.elsewhere++;
            (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
          }
          if (out.pixels) out.box = [x0, y0, x1, y1].map((v, i) => Math.round((i % 2 ? clip.y : clip.x) + v / k));
          return out;
        }, [a, z, CLIP]);
        const said = (d) => (d.pixels ? `differs in ${d.pixels} of ${d.of} pixels, by at most ${d.most} of 255, within ${d.box[0]},${d.box[1]} to ${d.box[2]},${d.box[3]} of the window; ${d.mark} of them where the chrome draws the mark, ${d.elsewhere} elsewhere` : 'is the same, pixel for pixel');
        const frames = () => page.evaluate(() => window.__story.frames);
        const rest = (id) => (id ? centre(page, id) : page.evaluate(() => scrollTo(0, 0))).then(() => page.waitForTimeout(900));
        if (drawn) {
          await page.waitForTimeout(600);
          assert.equal(await page.locator('.mark-big img').count(), 0, 'the chrome draws the mark: its still is never fetched');
          const first = await look(), seen = new Set([first]);
          for (const step of STEPS) {
            await rest(step);
            const now = await look();
            assert.ok(!seen.has(now), `at ${step} the chrome has a form of its own`);
            seen.add(now);
          }
          // Between two chapters the chrome is neither chapter's picture: it is on its way from one to the other.
          for (const at of [0.45, 1.8, 2.5]) {
            await page.evaluate((at) => scrollTo(0, at * document.querySelector('.chapter').offsetHeight), at);
            await page.waitForTimeout(500);
            assert.ok(!seen.has(await look()), `${at} chapters in, the chrome is on its way: no chapter's picture`);
          }
          // Still at rest; a ring whose agent works has its light, as in the app.
          await rest('place');
          let f0 = await frames();
          await page.waitForTimeout(1200);
          assert.equal(await frames(), f0, 'at rest at Place, no frame of the chrome is drawn');
          await rest('work');
          f0 = await frames();
          await page.waitForTimeout(1000);
          assert.ok((await frames()) - f0 >= 20, 'at Work the rings\' light turns');
          // Scrolled back, everything has played backwards: the first screen is the picture it was. Pixel for pixel
          // where a graphics card draws the chrome (here: Chromium started with one, and any browser on a Mac): the
          // same numbers give the same picture. A renderer on the processor (a server's WebKit draws the chrome that
          // way, by a name the page cannot tell from a card's) may round a blend's last bits otherwise from one frame
          // to the next: there the picture may differ by 2 of 255 at most, and only where the chrome draws the mark. A
          // first screen that really differs (no mark, an earlier form left standing, a still in the chrome's place)
          // differs by tens of levels over thousands of pixels, and by words elsewhere.
          const renderer = await page.evaluate(() => window.__story.renderer), exact = !!metal || process.platform === 'darwin';
          await rest();
          const back = await differs(first, await look());
          console.log(`${kind}: the chrome is drawn by “${renderer}”, ${exact ? 'taken for a graphics card' : 'taken for a renderer on the processor'}; scrolled back to the top, the first screen ${said(back)}`);
          if (back.pixels) {
            // What would tell an earlier frame left in the picture from a renderer's rounding: one more frame of the
            // same place, and the picture again.
            await page.evaluate(() => (scrollBy(0, 1), new Promise((ok) => requestAnimationFrame(() => (scrollBy(0, -1), ok())))));
            await page.waitForTimeout(700);
            console.log(`${kind}: after one more frame drawn at the top, the first screen ${said(await differs(first, await look()))}`);
          }
          if (exact) assert.equal(back.pixels, 0, `scrolled back to the top, the first screen ${said(back)}`);
          else assert.ok(back.most <= 2 && !back.elsewhere, `scrolled back to the top, the first screen ${said(back)} (a renderer on the processor may differ by 2 of 255 where the chrome draws, no more)`);
          f0 = await frames();
          await page.waitForTimeout(1200);
          assert.equal(await frames(), f0, 'at rest at the top, no frame of the chrome is drawn');
        } else {
          assert.ok(await page.locator('.mark-big img').evaluate(async (i) => (await i.decode(), i.naturalWidth > 0 && i.clientWidth <= i.naturalWidth)), 'the mark\'s still stands on the first screen, no larger than drawn');
          await page.waitForTimeout(400);
          const first = await look();
          for (const step of STEPS) {
            await centre(page, step);
            await page.waitForFunction((step) => { const i = document.querySelector('.form-still'); return i && i.complete && i.naturalWidth > 0 && i.currentSrc.includes(`chrome-${step}`) && +getComputedStyle(i).opacity > 0.99; }, step);
          }
          await rest();
          assert.ok(await page.locator('.form-still').evaluate((i) => +getComputedStyle(i).opacity < 0.01), 'back at the top, the mark alone');
          // Stills are pictures: scrolled back, the first screen is the picture it was, pixel for pixel.
          const back = await differs(first, await look());
          console.log(`${kind}: the chrome's stills stand for it; scrolled back to the top, the first screen ${said(back)}`);
          assert.equal(back.pixels, 0, `scrolled back to the top, the first screen ${said(back)}`);
        }
      } finally {
        if (metal) await metal.close();
      }
    });

    await part('a reader and the keyboard', async () => {
      const page = await open();
      await live(page);
      await settle(page, 'rest', 'at the top');
      const HEADS = ['Say the task.', 'Tasktap finds the project.', 'Agents work while you work.', 'A question comes to you.', 'Keep the change, or discard it.'];
      // What each chapter's two stills say, from the page's own source: the words a reader is to find.
      const alts = await page.evaluate(() => [...document.querySelectorAll('.chapter')].map((ch) => [...ch.querySelectorAll('noscript')].flatMap((n) => {
        const t = document.createElement('template');
        t.innerHTML = n.textContent;
        return [...t.content.querySelectorAll('img')].map((i) => i.alt.replace(/\s+/g, ' ').slice(0, 40));
      })));
      assert.deepEqual(alts.map((a) => a.length), [2, 2, 2, 2, 2], 'every chapter has two pictures with words for them');
      for (const where of ['rest', ...STEPS]) {
        if (where === 'rest') await page.evaluate(() => scrollTo(0, 0));
        else await centre(page, where);
        await settle(page, where, `at ${where}`);
        const tree = (await page.locator('body').ariaSnapshot()).replace(/\s+/g, ' ');
        let last = -1;
        for (const [i, head] of HEADS.entries()) {
          const at = tree.indexOf(`heading "${head}" [level=3]`);
          assert.ok(at > last, `at ${where}: a reader finds “${head}”, in its order`);
          for (const alt of alts[i]) assert.ok(tree.indexOf(alt, at) > at, `at ${where}: and under “${head}” what its picture shows (“${alt}…”)`);
          last = at;
        }
        assert.ok(tree.includes('heading "Tell any coding agent what to do, out loud." [level=1]'), `at ${where}: the headline`);
        assert.ok(tree.includes(MAC), `at ${where}: the install line`);
        assert.ok(tree.includes('button "Copy the Mac install line"'), `at ${where}: and its Copy`);
        assert.ok(tree.includes('Tasktap runs on Macs with Apple silicon'), `at ${where}: and what Tasktap runs on`);
        assert.equal(/- iframe|- img "?Tasktap’s notch/.test(tree), false, `at ${where}: the live notch is not in the tree`);
        assert.deepEqual(await page.locator('#chrome, .notch, .seats').evaluateAll((all) => all.map((el) => el.getAttribute('aria-hidden'))), ['true', 'true', 'true'], 'the canvas, the notch and the seats are kept from a reader');
        // None of it is seen: what a picture shows is told in a place of one pixel.
        assert.deepEqual(await page.locator('.told').evaluateAll((all) => all.map((el) => { const r = el.getBoundingClientRect(); return r.width <= 1 && r.height <= 1; })), Array(6).fill(true), `at ${where}: six tellings (the mark's and five chapters'), none seen`);
        assert.equal(tree.split('Tasktap’s mark: a slab of polished chrome').length - 1, 1, `at ${where}: the mark is told, once`);
      }
      // The keyboard, from a chapter: with the keyboard in the bar (where Tab from the page's start has brought it),
      // the next Tab comes to the first screen's Copy, though the first screen is scrolled away, and the page goes
      // to the first screen.
      await centre(page, 'work');
      await settle(page, 'work', 'at work');
      // (A Mac's WebKit goes to buttons and links by Option+Tab unless the system's keyboard navigation is switched
      // on; where plain Tab finds nothing, that is the key.)
      for (const key of ['Tab', 'Alt+Tab']) {
        await page.locator('.bar-nav a').last().focus();
        await page.keyboard.press(key);
        if (await page.evaluate(() => document.activeElement !== document.body)) break;
        await centre(page, 'work');
        await page.waitForTimeout(300);
      }
      assert.ok(await page.evaluate(() => !!document.activeElement?.matches('.top .copy')), `from Work, Tab after the bar reaches the first screen's Copy (it reached ${await page.evaluate(() => document.activeElement?.textContent.trim().slice(0, 30))})`);
      await page.waitForFunction(() => scrollY === 0 && +getComputedStyle(document.querySelector('.top-text')).opacity > 0.99);
      assert.deepEqual(await inView(page, '.top .copy'), [true], 'and the page has gone to the first screen, Copy in view');
    });

    await part('phones and a tablet, by touch', async () => {
      const touch = { hasTouch: true, isMobile: true };
      /** The links a finger needs, each fragment of them, that are lower than 44 px. */
      const low = (page, which) => page.locator(which).evaluateAll((all) => all.filter((el) => el.getClientRects().length).map((el) => [el.textContent.trim().slice(0, 28) || el.getAttribute('aria-label'), Math.round(Math.min(...[...el.getClientRects()].map((r) => r.height)))]).filter(([, h]) => h < 44));
      /** Words set smaller than 12 px, wherever they are shown. */
      const small = (page) => page.evaluate(() => [...new Set([...document.querySelectorAll('body *')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && el.getClientRects().length && !el.closest('.sr, .skip, noscript') && parseFloat(getComputedStyle(el).fontSize) < 12)
        .map((el) => `${el.tagName.toLowerCase()}.${el.className} “${el.textContent.trim().slice(0, 20)}” ${getComputedStyle(el).fontSize}`))]);
      for (const [width, height, dpr] of [[360, 780, 3], [430, 932, 3], [844, 390, 3], [320, 640, 2]]) {
        const size = `${width}×${height}`;
        const page = await open({ viewport: { width, height }, deviceScaleFactor: dpr, ...touch });
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains('held')), false, `${size}: nothing is held`);
        assert.ok(await page.evaluate(() => matchMedia('(hover:none),(pointer:coarse)').matches), `${size}: the browser says a finger points`);
        assert.ok(await fits(page), `${size}: no sideways scroll`);
        assert.deepEqual(await low(page, '.bar-nav a, .brand, .past, .runs a'), [], `${size}: every link a finger needs is 44 px tall`);
        await inflate(page);
        await page.locator('#terminals').scrollIntoViewIfNeeded();
        await page.waitForFunction(() => !!document.querySelector('#terminals img')?.complete);
        assert.deepEqual(await small(page), [], `${size}: no text under 12 px`);
        const pictures = await page.locator('.still img, #terminals img').evaluateAll((all) => all.map((i) => ({ src: i.currentSrc.replace(/.*shots\//, ''), shown: i.clientWidth, tall: i.clientHeight, natural: i.naturalWidth })));
        assert.equal(pictures.length, 11, `${size}: every chapter's two stills, and Tasktap's window`);
        for (const p of pictures) {
          assert.ok(p.natural > 0 && p.shown <= p.natural + 1, `${size}: ${p.src} is shown ${p.shown} px wide, drawn ${p.natural}`);
          assert.ok(p.tall <= height, `${size}: ${p.src} is ${p.tall} px tall in a window of ${height}`);
          // The notch's stills hold small words: on a narrow screen they come at the screen's own density.
          if (/^story-/.test(p.src) && width <= 520) assert.ok(p.src.includes(`@${dpr}x`), `${size}: ${p.src} is the ${dpr}x picture`);
          // And on the narrowest they keep their size, so their words are as large as the app draws them.
          if (/^story-/.test(p.src) && width < 368 && height > 600) assert.equal(p.shown, 328, `${size}: ${p.src} keeps its own size`);
        }
        for (const id of [...STEPS, 'facts', 'install']) {
          await page.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'start', behavior: 'instant' }), id);
          assert.ok(await fits(page), `${size}: no sideways scroll at ${id}`);
        }
        if (shots && kind === 'chromium') await page.screenshot({ path: path.join(shots, `touch-${width}x${height}.png`), fullPage: true });
        await page.context().close();
      }
      // Turning a phone on its side and back keeps the reader's place.
      const phone = await open({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, ...touch });
      const reading = () => phone.evaluate(() => {
        const line = innerHeight / 2;
        return [...document.querySelectorAll('#top, .chapter, #terminals, #facts, #install')].find((el) => { const r = el.getBoundingClientRect(); return r.top <= line && r.bottom > line; })?.id;
      });
      for (const id of ['work', 'result', 'facts']) {
        await phone.evaluate((id) => { const el = document.getElementById(id), r = el.getBoundingClientRect(); scrollBy({ top: r.top + r.height / 2 - innerHeight / 2, behavior: 'instant' }); }, id);
        await phone.waitForTimeout(400);
        assert.equal(await reading(), id, `the phone reads ${id}`);
        await phone.setViewportSize({ width: 844, height: 390 });
        await phone.waitForTimeout(700);
        assert.equal(await reading(), id, `turned on its side at ${id}, the phone still reads ${id}`);
        await phone.setViewportSize({ width: 390, height: 844 });
        await phone.waitForTimeout(700);
        assert.equal(await reading(), id, `turned back at ${id}, the phone still reads ${id}`);
      }
      await phone.context().close();
      // A tablet with touch, wide and tall enough: the stage is held, a finger reaches the chapters' list.
      const tablet = await open({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 2, ...touch });
      assert.ok(await tablet.evaluate(() => document.documentElement.classList.contains('held')), 'the tablet holds the stage');
      await live(tablet);
      await settle(tablet, 'rest', 'the tablet at the top');
      assert.deepEqual(await low(tablet, '.bar-nav a, .brand, .chapters-nav a, .runs a'), [], 'the tablet: every link a finger needs is 44 px tall');
      for (const step of STEPS) {
        await centre(tablet, step);
        await settle(tablet, step, `the tablet at ${step}`);
        assert.ok(await fits(tablet), `the tablet: no sideways scroll at ${step}`);
        assert.deepEqual(await small(tablet), [], `the tablet at ${step}: no text under 12 px`);
        const cut = await tablet.locator('.seat').evaluateAll((all) => all.filter((el) => +getComputedStyle(el).opacity > 0.99).flatMap((el) => [...el.querySelectorAll('b, em, u')].filter((t) => +getComputedStyle(t).opacity > 0.5).map((t) => { const r = t.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight ? '' : t.textContent; })).filter(Boolean));
        assert.deepEqual(cut, [], `the tablet at ${step}: the seats' words are in the window`);
      }
      await tablet.locator('.chapters-nav a', { hasText: 'Place' }).tap();
      await settle(tablet, 'place', 'the tablet, Place tapped in the list');
    });

    await part('quick returns', async () => {
      const page = await open();
      await live(page);
      await settle(page, 'rest', 'at the top');
      for (const [a, b] of [['work', 'ask'], ['ask', 'work'], ['place', 'work'], ['result', 'ask']]) {
        for (const gap of [60, 200, 300]) {
          await centre(page, a);
          await settle(page, a, `at ${a}`);
          await page.waitForTimeout(300);
          await page.evaluate(([b, a, gap]) => new Promise((done) => {
            const go = (id) => document.getElementById(id).scrollIntoView({ block: 'start', behavior: 'instant' });
            go(b);
            setTimeout(() => (go(a), done()), gap);
          }), [b, a, gap]);
          await page.waitForTimeout(2800);
          const s = await page.evaluate(state);
          assert.equal(s.step, a, `${a}, then ${b}, back to ${a} after ${gap} ms: the notch shows ${s.step}`);
        }
      }
      // Keep in the list within 0.6 s of going to the top.
      await centre(page, 'work');
      await settle(page, 'work', 'at work');
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(500);
      await page.locator('.chapters-nav a', { hasText: 'Keep' }).click();
      await page.waitForTimeout(2800);
      assert.equal((await page.evaluate(state)).step, 'result', 'Keep clicked 0.5 s after going to the top');
    });

    await part('still until live', async () => {
      const shown = (page) => page.locator('.notch-still img').evaluate((i) => (i.parentElement.classList.contains('loading') ? '' : i.currentSrc));
      const frame = (page) => page.locator('#stage').evaluate((el) => JSON.stringify(el.getBoundingClientRect()));
      for (const [what, settings] of [
        ['with Save-Data', { init: () => Object.defineProperty(Navigator.prototype, 'connection', { get: () => ({ saveData: true }) }) }],
        ['with the notch blocked', { route: (c) => c.route('**/app/notch.html', (r) => r.abort()) }],
      ]) {
        const page = await open({}, settings);
        const box = await frame(page);
        for (const step of ['rest', ...STEPS]) {
          if (step === 'rest') await page.evaluate(() => scrollTo(0, 0));
          else await centre(page, step);
          await page.waitForTimeout(500);
          assert.match(await shown(page), new RegExp(`story-${PICTURE[step]}`), `${what}, at ${step}: the stage shows the chapter's still`);
          if (step === 'rest') assert.equal(await frame(page), box, `${what}: the stage keeps its place`);
        }
        await page.waitForTimeout(1500);
        assert.equal(await page.locator('.stage.live').count(), 0, `${what}: the still stays`);
      }
      // A slow connection, opened at a chapter: the chapter's still until the live notch stands in that chapter's state.
      const page = await open({}, { hash: '#work', wait: false, route: (c) => c.route('**/*', async (r) => (await new Promise((ok) => setTimeout(ok, 1500)), r.continue())) });
      let sawStill = false;
      for (let t = 0; t < 40000; t += 150) {
        // The chapter at the reading line, as the page is now (before the jump to #work it is the first screen).
        const now = await page.evaluate(() => {
          const ch = document.querySelectorAll('.chapter'), b = -document.getElementById('story').getBoundingClientRect().top / (ch[0].offsetHeight || 1);
          const at = b < 0.5 ? 'open' : ch[Math.min(5, Math.floor(b + 0.5)) - 1].id;
          return { at, live: !!document.querySelector('.stage.live'), still: document.querySelector('.notch-still:not(.loading) img')?.currentSrc ?? '' };
        }).then(async (n) => ({ ...n, notch: await page.evaluate(state) })).catch(() => null);
        if (!now) { await page.waitForTimeout(150); continue; }
        if (!now.live && /story-/.test(now.still)) {
          assert.match(now.still, new RegExp(`story-${now.at}`), `on a slow connection, beside ${now.at} the stage shows ${now.still.replace(/.*shots\//, '')}`);
          if (now.at === 'work') sawStill = true;
        }
        if (now.live) {
          assert.equal(now.notch.step, 'work', 'the live notch takes the still\'s place in the Work state');
          break;
        }
        await page.waitForTimeout(150);
        if (t + 150 >= 40000) assert.fail('the live notch never came');
      }
      assert.ok(sawStill, 'the Work still was shown first');
    });

    await part('in sight only', async () => {
      // Install, then Back: the first screen's frame, and nothing else on the way.
      let page = await open();
      await live(page);
      await settle(page, 'rest', 'at the top');
      await forget(page);
      await page.locator('.bar a', { hasText: 'Install' }).click();
      for (let i = 0; i < 10; i++) (assert.equal((await page.evaluate(state)).step, 'rest', 'away at Install, the notch stays where it was'), await page.waitForTimeout(150));
      await page.goBack();
      for (let i = 0; i < 14; i++) (assert.equal((await page.evaluate(state)).step, 'rest', 'back from Install, the first screen\'s frame'), await page.waitForTimeout(150));
      assert.deepEqual((await got(page)).filter((m) => m.startsWith('scene') && m !== 'scene:rest'), [], 'no other state was asked for');
      // The link past the story asks the notch for nothing.
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(300);
      await page.locator('.story .past').locator('visible=true').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await forget(page);
      await page.locator('.story .past').locator('visible=true').click();
      await page.waitForTimeout(800);
      assert.deepEqual((await got(page)).filter((m) => m.startsWith('scene')), [], 'the link past the story asks for no state');
      assert.ok(await page.locator('#facts').evaluate((el) => el.getBoundingClientRect().top < 120), 'the facts are at the top after one click');
      await page.context().close();
      // Arriving at the install lines loads no notch; back at the top, the notch goes straight to its frame.
      page = await open({}, { hash: '#install' });
      await page.waitForTimeout(1500);
      assert.equal(await page.locator('.notch iframe').count(), 0, 'arriving at #install loads no notch');
      await page.evaluate(() => scrollTo(0, 0));
      await live(page);
      await settle(page, 'rest', 'back at the top');
      assert.deepEqual((await got(page)).filter((m) => m.startsWith('scene')), ['scene:rest'], 'back in sight, the stage goes to its chapter at once');
    });

    await part('stills fit their frames', async () => {
      for (const [from, to, by] of [[521, 553, 4], [1000, 1135, 15]]) {
        const page = await open({ viewport: { width: from, height: 900 }, reducedMotion: 'reduce' });
        for (let width = from; width <= to; width += by) {
          await page.setViewportSize({ width, height: 900 });
          await inflate(page);
          const out = await page.locator('.still img').evaluateAll((all) => all.map((i) => {
            const r = i.getBoundingClientRect(), s = i.closest('.slot').getBoundingClientRect();
            return r.left >= s.left - 1 && r.right <= s.right + 1 && s.left >= 0 && s.right <= innerWidth && i.clientWidth <= i.naturalWidth ? '' : `${i.closest('.chapter').id} ${i.currentSrc.replace(/.*shots\//, '')} ${Math.round(r.left)}..${Math.round(r.right)} of ${innerWidth}, ${i.clientWidth} of ${i.naturalWidth}`;
          }).filter(Boolean));
          assert.deepEqual(out, [], `at ${width}px a still is wider than its place, or larger than it was drawn`);
        }
        await page.context().close();
      }
      const page = await open({ viewport: { width: 1000, height: 800 } });
      for (let width = 1000; width <= 1135; width += 15) {
        await page.setViewportSize({ width, height: 800 });
        const cut = await page.locator('.notch-still img').evaluate((i) => { const r = i.getBoundingClientRect(); return [Math.round(r.left), Math.round(innerWidth - r.right)]; });
        assert.ok(cut[0] >= -1 && cut[1] >= -1, `at ${width}px the stage's still is cut by ${cut}`);
      }
    });

    await part('stills load when near', async () => {
      const asked = [];
      const page = await open({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 }, { route: (c) => c.route('**/*', (r) => (asked.push(r.request().url()), r.continue())) });
      await page.waitForTimeout(3000);
      // The first chapter begins on a phone's first screen, so its two stills are in view; nothing further down is fetched.
      const early = asked.filter((u) => /story-(open|place|work|ask|result)|chrome-(?!say-s)|chrome\.js|notch\.html|notch-|stage\.js|changes-|workspace/.test(u.replace(/.*\//, ''))).map((u) => u.replace(/.*\//, ''));
      assert.ok(asked.some((u) => /site\.js$/.test(u)) && asked.length >= 5, 'the phone\'s requests are seen');
      assert.deepEqual(early, [], 'a phone that has not scrolled fetches no still below its first screen, nor the chrome, its mark, the notch\'s still or the notch\'s page');
      await page.evaluate(() => document.getElementById('say').scrollIntoView());
      await page.waitForFunction(() => [...document.querySelectorAll('#say .slot')].every((s) => s.querySelector('img')?.complete));
      assert.ok(asked.some((u) => /story-say/.test(u)) && asked.some((u) => /chrome-say-s/.test(u)), 'scrolled near, the chapter\'s two stills come');
      if (kind === 'chromium') {
        const shift = await page.evaluate(() => window.__shift);
        assert.ok(shift < 0.005, `the still came without moving the page (${shift})`);
      } else console.log(`${kind}: this browser reports no layout shift, so the stills' coming is not measured here`);
    });

    await part('place kept', async () => {
      const page = await open({ viewport: { width: 1440, height: 900 } });
      const seen = (id) => page.evaluate((id) => { const r = document.querySelector(`#${id} h3`).getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }, id);
      await centre(page, 'work');
      await page.waitForTimeout(400);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForTimeout(600);
      assert.ok(await seen('work'), 'Reduce Motion switched on: the Work chapter is still in view');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.waitForTimeout(600);
      assert.ok(await seen('work'), 'Reduce Motion switched off: the Work chapter is still in view');
      await page.setViewportSize({ width: 1100, height: 900 });
      await centre(page, 'ask');
      await page.waitForTimeout(400);
      await page.setViewportSize({ width: 990, height: 900 });
      await page.waitForTimeout(600);
      assert.ok(await seen('ask'), 'the window narrowed past 1000 px: the Answer chapter is still in view');
      await page.setViewportSize({ width: 1100, height: 900 });
      await page.waitForTimeout(600);
      assert.ok(await seen('ask'), 'the window widened past 1000 px: the Answer chapter is still in view');
    });

    await part('copy', async () => {
      const clip = () => Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => ({ writeText: (t) => ((window.__clip = t), Promise.resolve()) }) });
      let page = await open({}, { init: clip });
      assert.equal(await page.locator('.top .copy').getAttribute('aria-label'), 'Copy the Mac install line');
      assert.deepEqual(await page.locator('#install .copy').evaluateAll((all) => all.map((b) => b.getAttribute('aria-label'))), ['Copy the Mac install line', 'Copy the Windows install line']);
      await page.locator('.top .copy').click();
      assert.equal(await page.evaluate(() => window.__clip), MAC);
      assert.equal(await page.locator('.top .copy').textContent(), 'Copied');
      assert.equal(await page.locator('[role=status]#said').textContent(), 'Copied the Mac install line', 'Copied is said to a screen reader');
      await page.context().close();
      page = await open({}, { init: () => Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => ({ writeText: () => Promise.reject(new Error('refused')) }) }) });
      await page.locator('.top .copy').click();
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => getSelection().toString()), MAC, 'refused, the line is selected');
      assert.match(await page.locator('#said').textContent(), /^Selected: press (⌘C|Ctrl\+C)$/, 'and the page says how to copy it');
      assert.match(await page.locator('.top .copy').textContent(), /^Selected: press/);
      // The stage's figure is read once: its caption, not also a label pointing at the caption.
      assert.equal(await page.locator('#stage').getAttribute('aria-labelledby'), null, 'the stage is read once');
    });

    await part('keys by system', async () => {
      let page = await open({ userAgent: WINDOWS });
      assert.equal(await page.locator('#ask kbd').first().textContent(), 'Alt+Shift+J', 'on Windows the key to the question is Windows\' own');
      // Windows has no notch: nothing in a chapter's words there speaks of one.
      assert.equal((await page.locator('#say .caps').innerText()).replace(/\s+/g, ' ').trim(), 'Alt+Shift+Space opens Tasktap over any app', 'on Windows, Say\'s key opens Tasktap');
      assert.equal(/notch/i.test((await page.locator('.ch-text h3, .ch-text .caps').allInnerTexts()).join(' ')), false, 'on Windows no chapter\'s words speak of a notch');
      assert.equal(await page.locator('.top .copy').getAttribute('aria-label'), 'Copy the Windows install line');
      assert.deepEqual(await page.locator('.top pre').evaluateAll((all) => all.filter((el) => el.getClientRects().length).map((el) => el.textContent)), [WIN]);
      await page.context().close();
      page = await open();
      assert.equal(await page.locator('#ask kbd').first().textContent(), '⌃⌥J', 'on a Mac, the Mac\'s');
    });

    await part('phone and Reduce Motion', async () => {
      const page = await open({ viewport: { width: 390, height: 844 } });
      for (const step of STEPS) {
        await page.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'start' }), step);
        await page.waitForFunction((id) => [...document.querySelectorAll(`#${id} .slot`)].every((s) => s.querySelector('img')?.complete), step);
        assert.deepEqual(await page.locator(`#${step} .still img`).evaluateAll((all) => all.map((i) => i.naturalWidth > 0 && i.getBoundingClientRect().top < innerHeight)), [true, true], `390: ${step} has its two stills, in view`);
        assert.ok(await fits(page), `390: no sideways scroll at ${step}`);
        if (shots && kind === 'chromium') await page.screenshot({ path: path.join(shots, `story-390-${STEPS.indexOf(step) + 1}-${step}.png`) });
      }
      assert.equal(await page.locator('.notch iframe').count(), 0, '390: no live notch where nothing is held');
      for (const [width, height] of [[1440, 900], [390, 844]]) {
        const calm = await open({ viewport: { width, height }, reducedMotion: 'reduce' });
        assert.equal(await calm.evaluate(() => document.documentElement.classList.contains('held')), false, `${width}, Reduce Motion: nothing is held`);
        assert.equal(await calm.locator('#stage').evaluate((el) => getComputedStyle(el).position), 'static', `${width}, Reduce Motion: the stage scrolls with the page`);
        assert.equal(await calm.locator('.notch iframe').count(), 0, `${width}, Reduce Motion: no live notch`);
        await inflate(calm);
        assert.equal(await calm.locator('.still img').count(), 10, `${width}, Reduce Motion: every chapter has its two stills`);
        assert.equal(await calm.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length), 0, `${width}, Reduce Motion: nothing animates`);
        assert.ok(await fits(calm), `${width}, Reduce Motion: no sideways scroll`);
        if (shots && kind === 'chromium') await calm.screenshot({ path: path.join(shots, `story-${width}-reduced.png`), fullPage: true });
      }
    });

    await part("Tasktap's window", async () => {
      for (const [width, height] of [[1440, 900], [390, 844]]) {
        const page = await open({ viewport: { width, height } });
        await page.locator('#terminals').scrollIntoViewIfNeeded();
        await page.locator('#terminals img').evaluate(async (i) => (i.loading = 'eager', await i.decode()));
        // Past the story the stage has gone with it: nothing of the stage lies over Tasktap's window.
        await page.evaluate(() => document.getElementById('terminals').scrollIntoView({ block: 'start', behavior: 'instant' }));
        await page.waitForTimeout(200);
        assert.ok(await page.locator('#terminals img').evaluate((i) => { const r = i.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, Math.min(innerHeight - 4, r.top + 40)) === i; }), `${width}: Tasktap's window is seen, with nothing of the stage over it`);
        const w = await page.locator('#terminals').evaluate((f) => {
          const p = f.querySelector('picture'), i = f.querySelector('img'), pr = p.getBoundingClientRect();
          return { left: pr.left, right: pr.right, shown: i.clientWidth, drawn: i.naturalWidth / (i.currentSrc.includes('@2x') ? 2 : 1), overflow: getComputedStyle(p).overflowX };
        });
        assert.ok(w.left >= 0 && w.right <= width, `${width}: Tasktap's window stands inside the screen`);
        assert.ok(w.shown <= w.drawn + 1, `${width}: never larger than it was drawn`);
        assert.ok(w.shown >= Math.min(w.right - w.left, 0.69 * w.drawn) - 1, `${width}: shown at ${Math.round((100 * w.shown) / w.drawn)} % of its size`);
        assert.notEqual(w.overflow, 'auto', `${width}: never panned`);
        assert.notEqual(w.overflow, 'scroll', `${width}: never panned`);
        assert.ok(await fits(page), `${width}: no sideways scroll`);
      }
    });

    await part('facts one click past the story', async () => {
      for (const [width, height] of [[1440, 900], [390, 844]]) {
        const page = await open({ viewport: { width, height } });
        const link = page.locator('.story .past').locator('visible=true');
        assert.ok(await link.evaluate((a) => a.getBoundingClientRect().top + scrollY < innerHeight * 1.5), `${width}: the link past the story stands at the story's start`);
        await link.scrollIntoViewIfNeeded();
        await page.evaluate(() => ((window.__scrolls = 0), addEventListener('scroll', () => window.__scrolls++, { passive: true })));
        await link.click();
        const top = await page.evaluate(() => document.getElementById('facts').getBoundingClientRect().top);
        assert.ok(top >= 0 && top < 120, `${width}: the facts are at the top after one click (${top})`);
        await page.waitForTimeout(400);
        assert.ok((await page.evaluate(() => window.__scrolls)) <= 2, `${width}: the page jumped to the facts, not through the story`);
        assert.ok(await fits(page), `${width}: no sideways scroll at the facts`);
        await page.evaluate(() => scrollTo(0, 0));
        await page.locator('.bar a', { hasText: 'Install' }).click();
        assert.ok(await page.locator('#install').evaluate((el) => el.getBoundingClientRect().top < innerHeight / 2), `${width}: the bar's Install reaches the install lines`);
      }
    });

    if (kind === 'chromium') {
      await part('still at rest', async () => {
        const page = await open();
        await live(page);
        await settle(page, 'rest', 'at the top');
        /** Frames drawn and script run in ten seconds without scrolling, from Chromium's own trace. */
        const idle = async () => {
          await page.waitForTimeout(1500);
          await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame'] });
          await page.waitForTimeout(10000);
          const trace = JSON.parse((await browser.stopTracing()).toString());
          const events = trace.traceEvents || trace;
          const SCRIPT = new Set(['FunctionCall', 'EvaluateScript', 'TimerFire', 'FireAnimationFrame', 'EventDispatch', 'RunMicrotasks']);
          return { frames: events.filter((e) => e.name === 'DrawFrame').length, script: events.filter((e) => SCRIPT.has(e.name) && e.ph === 'X' && e.dur).reduce((sum, e) => sum + e.dur, 0) / 1000 };
        };
        const top = await idle();
        await page.evaluate(() => document.getElementById('facts').scrollIntoView());
        const facts = await idle();
        console.log(`at rest, ten seconds: the first screen ${top.frames} frames and ${top.script.toFixed(1)} ms of script; the facts ${facts.frames} frames and ${facts.script.toFixed(1)} ms`);
        assert.equal(top.frames, 0, `at rest at the top, ${top.frames} frames`);
        assert.ok(top.script < 5, `at rest at the top, ${top.script} ms of script`);
        assert.equal(facts.frames, 0, `at rest at the facts, ${facts.frames} frames`);
        assert.ok(facts.script < 5, `at rest at the facts, ${facts.script} ms of script`);
      });

      await part('words with scripts off', async () => {
        const page = await open({ javaScriptEnabled: false });
        const words = await page.locator('.chapter .ch-text').evaluateAll((all) => all.map((t) => [t.querySelector('h3').textContent.replace(/\s+/g, ' '), t.textContent.replace(/\s+/g, ' ').trim()]));
        assert.equal(words.length, 5);
        const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
        let total = 0;
        for (const [head, all] of words) {
          assert.ok(head.split(' ').length <= 6, `“${head}” is six words at most`);
          assert.ok(text.includes(head), `“${head}” is in the page's text`);
          total += all.split(' ').length;
        }
        assert.ok(total <= 45, `the story's chapters are ${total} words in all`);
        assert.equal(/·/.test(text), false, 'no “·” between two things');
        assert.equal(await page.locator('#ask kbd').first().textContent(), '⌃⌥J', 'with scripts off, the Mac\'s keys');
        const stills = await page.locator('.still img').evaluateAll((all) => Promise.all(all.map(async (i) => (await i.decode(), i.naturalWidth > 0))));
        assert.deepEqual(stills, Array(10).fill(true), 'with scripts off every chapter has its two stills');
        assert.ok(await page.locator('.mark-big img').evaluate(async (i) => (await i.decode(), i.naturalWidth > 0)), 'and the first screen the mark');
      });
    }
    if (errors.length) results.push([kind, 'browser errors', `FAIL: ${[...new Set(errors)].join(' | ')}`, 0]);
    await browser.close();
  }
  server.close();
  for (const [kind, name, said, ms] of results) console.log(`${kind.padEnd(9)} ${name.padEnd(30)} ${said} (${(ms / 1000).toFixed(1)} s)`);
  const failed = results.filter((r) => r[2] !== 'PASS');
  if (failed.length) {
    console.error(`FAIL: ${failed.length} of ${results.length}`);
    process.exitCode = 1;
  } else console.log(`PASS: ${results.length} parts in ${which.join(' and ')}: the first screen, the story forwards and backwards, the chrome and the layout's rest, a reader and the keyboard, phones and a tablet by touch, quick returns, the still until the live notch, the stage driven only in sight, stills that fit and come when near, the reader's place kept, Copy, keys by system, phone and Reduce Motion, Tasktap's window, the facts one click past the story, still at rest, the words with scripts off.`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
