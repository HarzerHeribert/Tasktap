// Home's motion on the real pages, for the owner to judge: the form as an object in the free space at the foot of Home
// (its content held to a left column, as the Folds layout will have it), each style with Lumen on and off in idle,
// working, needs you and done at 1x and 2x; the moving backdrop it replaces, for comparison; the open notch, which
// carries no form; clips of what moves and when; the text's contrast with and without the motion; the lab's hero and
// the app's object side by side at the same pixel size; and the notch opening on a display without a camera cutout.
// node scripts/motion-sheet.cjs <outdir>   (ui/dist must be built, or DIST names a copy; ffmpeg makes the clips)
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { serve, open, fixtures } = require('./motion-pages.cjs');
const root = path.resolve(__dirname, '..');
const { chromium } = require('playwright');

const STYLES = ['slats', 'glyphs', 'resonator'];
const STATES = ['idle', 'working', 'needs', 'done'];
const GPU = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
const GEOMETRY = (cutout) => ({ do: 'geometry', width: cutout ? 185 : 120, height: cutout ? 32 : 20, cutout, compact: false, surfaceWidth: 432,
  surfaceOffset: 0, span: 560, pixel: 2, corner: 10, offset: 0, available: 700, collapsed: false });

/** The records that put the product in each state, with the content a person would see then. */
function records(state, style, lumen) {
  const all = fixtures({ question: state === 'needs' });
  const keep = { idle: [], working: [1, 2, 5], needs: [4, 1], done: [5, 6] }[state];
  const ids = new Set(keep.map((n) => all.thoughts[n - 1].id));
  all.thoughts = all.thoughts.filter((t) => ids.has(t.id)).map((t) => {
    // Working: what finished earlier was read. Done: the latest result is unread, the one before it read.
    if (state === 'working' && t.status === 'done') return { ...t, read: true };
    if (state === 'done' && t.id === all.thoughts[5].id) return { ...t, read: true, updated: t.updated - 900 };
    return t;
  });
  all.sessions = all.sessions.filter((s) => ids.has(s.thought_id));
  all.results = all.results.filter((r) => ids.has(r.thought_id));
  const count = (s) => all.thoughts.filter((t) => t.status === s && !(t.read && (s === 'done' || s === 'failed'))).length;
  all.glance = { ...all.glance, working: count('working'), needs_you: count('needs_you'), done: count('done'), failed: count('failed') };
  all.prefs = [{ id: 'motion_style', value: style, rev: 2 }, { id: 'motion_lumen', value: lumen, rev: 2 }];
  return all;
}

// The camera housing, which on a display with a cutout hides the sheet's top middle: drawn in so the captures show
// what a person sees there.
const housing = () => {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:0;left:calc(50% - 92.5px);width:185px;height:32px;background:#000;border-radius:0 0 10px 10px;z-index:99';
  document.body.append(el);
};

async function notchPage(browser, url, { state, lumen, dpr, video, cutout = true }) {
  const page = await open(browser, { label: 'notch', records: records(state, 'slats', lumen), url, dpr, viewport: { width: 560, height: 640 }, video });
  if (cutout) await page.evaluate(housing);
  await page.evaluate((g) => window.__fake.emit(g), GEOMETRY(cutout));
  await page.evaluate((s) => window.__fake.emit({ do: s === 'needs' ? 'answer' : 'capture' }), state);
  return page;
}
// Home with its content in a left column of 824 pixels plus its gutter, where the Folds layout will put it.
async function homePage(browser, url, { state, style, lumen, place = 'object', pace = null, dpr, video }) {
  const page = await open(browser, { label: 'workspace', records: records(state, style, lumen), url, dpr, video });
  await page.addStyleTag({ content: '.work>main{max-width:896px}' });
  await page.evaluate(([p, q]) => ((window.__motion.place.home = p), (window.__motion.debug.pace = q), window.__motion.redraw()), [place, pace]);
  return page;
}
const sheetClip = (page) => page.evaluate(() => {
  const el = document.querySelector('#notch[open]') || document.querySelector('#notch-home');
  return { x: 52, y: 0, width: 456, height: Math.min(640, Math.ceil(el.getBoundingClientRect().bottom) + 14) };
});
const finish = (page) => page.evaluate(() => {
  // Everything working finishes, unread: the motion's change of state, as it happens in the app.
  const f = window.__fake, now = Date.now();
  const thoughts = f.records.thoughts.filter((t) => t.status === 'working').map((t) => ({ ...t, status: 'done', phase: 'done', read: false, updated: now, rev: t.rev + 100 }));
  const sessions = f.records.sessions.map((s) => ({ ...s, state: 'idle', rev: s.rev + 100 }));
  f.push({ t: 'change', rev: 900, sets: [{ c: 'thoughts', put: thoughts }, { c: 'sessions', put: sessions }] });
});
const encode = (raw, out, from, secs, crop = '') => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', String(from), '-i', raw, '-t', String(secs),
  '-vf', `${crop}fps=25,format=yuv420p`, '-c:v', 'libx264', '-crf', '24', '-preset', 'slow', '-movflags', '+faststart', '-an', out]);

// Contrast: every line of text against the brightest pixel behind it, with the backdrop and without it.
async function contrast(page, roots) {
  const shot = async () => 'data:image/png;base64,' + (await page.screenshot()).toString('base64');
  await page.addStyleTag({ content: '.contrast-hide *,.contrast-hide *::placeholder{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important}' });
  const lines = await page.evaluate((roots) => {
    const out = [];
    const range = document.createRange();
    for (const root of document.querySelectorAll(roots)) {
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (!n.textContent.trim()) continue;
        const color = getComputedStyle(n.parentElement).color;
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) if (r.width > 1 && r.height > 1) out.push({ x: r.left, y: r.top, w: r.width, h: r.height, color, text: n.textContent.trim().slice(0, 30) });
      }
    }
    document.documentElement.classList.add('contrast-hide');
    return out;
  }, roots);
  const withBackdrop = await shot();
  await page.addStyleTag({ content: '.backdrop-box{visibility:hidden!important}' });
  const without = await shot();
  const result = await page.evaluate(async ({ lines, a, b }) => {
    const pixels = async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      [c.width, c.height] = [img.width, img.height];
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      return { data: g.getImageData(0, 0, c.width, c.height).data, w: c.width, k: img.width / innerWidth };
    };
    const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const L = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const [A, B] = [await pixels(a), await pixels(b)];
    const brightest = (P, l) => {
      let m = 0;
      for (let y = Math.floor(l.y * P.k); y < Math.ceil((l.y + l.h) * P.k); y++)
        for (let x = Math.floor(l.x * P.k); x < Math.ceil((l.x + l.w) * P.k); x++) {
          const i = (y * P.w + x) * 4;
          m = Math.max(m, L(P.data[i], P.data[i + 1], P.data[i + 2]));
        }
      return m;
    };
    let worst = { ratio: Infinity }, lowest = Infinity;
    for (const l of lines) {
      const [r, g, bl] = l.color.match(/[\d.]+/g).map(Number);
      const t = L(r, g, bl), ca = (Math.max(t, brightest(A, l)) + 0.05) / (Math.min(t, brightest(A, l)) + 0.05);
      const cb = (Math.max(t, brightest(B, l)) + 0.05) / (Math.min(t, brightest(B, l)) + 0.05);
      lowest = Math.min(lowest, ca);
      if (ca / cb < worst.ratio) worst = { ratio: ca / cb, text: l.text, with: +ca.toFixed(2), without: +cb.toFixed(2) };
    }
    return { lines: lines.length, lowest: +lowest.toFixed(2), worst: { ...worst, ratio: +worst.ratio.toFixed(4) } };
  }, { lines, a: withBackdrop, b: without });
  return result;
}

async function main(out) {
  fs.mkdirSync(out, { recursive: true });
  const server = await serve(process.env.DIST || path.join(root, 'ui/dist'));
  const lab = await serve(path.join(root, 'design/motion-lab'));
  const browser = await chromium.launch({ headless: true, args: GPU });
  const manifest = { stills: [], clips: [], contrast: [], shape: [], pairs: [] };
  const errors = [];
  const done = async (page, name) => {
    errors.push(...page.errors.map((e) => `${name}: ${e}`));
    await page.context().close();
  };
  try {
    // Home: the object in every style, state and Lumen setting at 1x and 2x; the wash with Slats at 1x.
    for (const place of ['object', 'wash'])
      for (const style of place === 'wash' ? ['slats'] : STYLES)
        for (const lumen of [true, false])
          for (const state of STATES)
            for (const dpr of place === 'wash' ? [1] : [1, 2]) {
              const page = await homePage(browser, server.url, { state, style, lumen, place, dpr });
              await page.waitForTimeout(state === 'done' ? 3600 : state === 'needs' ? 5400 : 2600);
              await page.evaluate(() => document.fonts.ready);
              const file = `home-${place}-${style}-${lumen ? 'lumen' : 'plain'}-${state}-${dpr}x.png`;
              await page.screenshot({ path: path.join(out, file) });
              manifest.stills.push({ surface: 'home', place, style, lumen, state, dpr, file });
              if (style === 'slats' && dpr === 1) manifest.contrast.push({ surface: 'home', place, lumen, state, ...(await contrast(page, '.work>.toolbar,#main')) });
              await done(page, file);
            }
    // The open notch, which carries no form: its glow takes Lumen's colours when a question waits.
    for (const lumen of [true, false])
      for (const state of STATES) {
        const page = await notchPage(browser, server.url, { state, lumen, dpr: 2 });
        await page.waitForTimeout(1500);
        const file = `notch-${lumen ? 'lumen' : 'plain'}-${state}-2x.png`;
        await page.screenshot({ path: path.join(out, file), clip: await sheetClip(page) });
        manifest.stills.push({ surface: 'notch', place: 'none', style: 'slats', lumen, state, dpr: 2, file });
        await done(page, file);
      }
    console.log(`${manifest.stills.length} stills`);

    // The lab's hero and the app's object at the same pixel size, side by side at 100 %, at 1x and 2x.
    for (const style of STYLES)
      for (const dpr of [1, 2]) {
        const page = await homePage(browser, server.url, { state: 'idle', style, lumen: false, dpr });
        await page.waitForTimeout(1200);
        const box = await page.locator('.home-backdrop').boundingBox();
        await page.screenshot({ path: path.join(out, `pair-${style}-${dpr}x-app.png`), clip: box });
        await done(page, 'pair');
        const lp = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: dpr });
        await lp.goto(`${lab.url}/index.html#c=${style}&s=idle&p=irid`);
        await lp.addStyleTag({ content: `.hero canvas{width:${box.width}px!important;height:${box.height}px!important;display:block;border-radius:0!important}` });
        await lp.waitForTimeout(1200);
        await lp.locator('.hero canvas').first().screenshot({ path: path.join(out, `pair-${style}-${dpr}x-lab.png`) });
        await lp.close();
        manifest.pairs.push({ style, dpr, app: `pair-${style}-${dpr}x-app.png`, lab: `pair-${style}-${dpr}x-lab.png`, size: `${box.width} × ${box.height}` });
      }

    // Clips: what moves and when. The object while work finishes (its blend, done's pass of light, then still), the
    // object breathing while it works, the moving backdrop, and the notch's glow while a question waits.
    const clips = [
      ...STYLES.map((style) => ({ name: `home-object-${style}-lumen-finish`, style, lumen: true, finish: true, line: 'Still while it works; when the work finishes, the blend and done’s pass of light play for about three seconds, then it holds still.' })),
      { name: 'home-object-slats-plain-finish', style: 'slats', lumen: false, finish: true, line: 'The same with Lumen off: the form alone.' },
      { name: 'home-object-slats-lumen-breathe', style: 'slats', lumen: true, pace: 'breathe', line: 'Breathing while it works: its own motion at a fifth of its pace, ten frames a second, for as long as the work runs.' },
      { name: 'home-wash-slats-lumen-working', style: 'slats', lumen: true, place: 'wash', line: 'The moving backdrop, for comparison: thirty frames a second behind the whole view for as long as anything works.' },
    ];
    for (const c of clips) {
      const video = { dir: path.join(out, 'raw'), size: { width: 944, height: 608 } };
      const page = await homePage(browser, server.url, { state: 'working', style: c.style, lumen: c.lumen, place: c.place ?? 'object', pace: c.pace ?? null, dpr: 1, video });
      await page.waitForTimeout(3500);
      if (c.finish) await finish(page);
      await page.waitForTimeout(c.finish ? 5000 : 4000);
      const raw = await page.video().path();
      await done(page, 'clip');
      encode(raw, path.join(out, `${c.name}.mp4`), c.finish ? 2.5 : 3, c.finish ? 6.5 : 4);
      manifest.clips.push({ ...c, file: `${c.name}.mp4` });
    }
    {
      const video = { dir: path.join(out, 'raw'), size: { width: 560, height: 520 } };
      const page = await notchPage(browser, server.url, { state: 'needs', lumen: true, dpr: 1, video });
      await page.waitForTimeout(5000);
      const raw = await page.video().path();
      await done(page, 'clip');
      encode(raw, path.join(out, 'notch-glow-lumen-needs.mp4'), 1.2, 3.5, 'crop=456:520:52:0,');
      manifest.clips.push({ name: 'notch-glow-lumen-needs', file: 'notch-glow-lumen-needs.mp4', line: 'The open notch carries no form. While a question waits its light breathes behind the sheet, in Lumen’s colours when Lumen is on.' });
    }
    fs.rmSync(path.join(out, 'raw'), { recursive: true, force: true });
    console.log(`${manifest.clips.length} clips`);

    // The shape opening on a display without a cutout: the tab, two steps, the open rectangle, the page's clock held.
    {
      const page = await open(browser, { label: 'notch', records: records('idle', 'slats', false), url: server.url, dpr: 2, viewport: { width: 560, height: 360 }, clock: true });
      await page.evaluate((g) => window.__fake.emit(g), GEOMETRY(false));
      await page.clock.runFor(200);
      const shoot = async (name, label) => {
        await page.screenshot({ path: path.join(out, name), clip: { x: 40, y: 0, width: 480, height: 300 } });
        manifest.shape.push({ file: name, label });
      };
      await shoot('shape-0-collapsed.png', 'Collapsed tab');
      await page.evaluate(() => window.__fake.emit({ do: 'capture' }));
      await page.clock.runFor(60);
      await shoot('shape-1-step.png', 'Opening, 60 ms in');
      await page.clock.runFor(70);
      await shoot('shape-2-step.png', 'Opening, 130 ms in');
      await page.clock.runFor(900);
      await shoot('shape-3-open.png', 'Open: a plain rectangle');
      await done(page, 'shape');
    }
  } finally {
    await browser.close();
    await server.close();
    await lab.close();
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
  const worst = manifest.contrast.reduce((m, c) => Math.min(m, c.worst.ratio), Infinity);
  console.log(`contrast with the motion against without, worst line: ${worst}`);
  for (const e of errors) console.error(e);
  if (errors.length) process.exitCode = 1;
}

if (require.main === module) {
  if (!process.argv[2]) { console.error('usage: node scripts/motion-sheet.cjs <outdir>'); process.exit(2); }
  main(path.resolve(process.argv[2])).catch((e) => { console.error(e); process.exit(1); });
}
