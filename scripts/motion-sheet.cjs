// The backdrop's placements on the real pages, for the owner to choose from: every placement of the notch sheet and
// of Home, with each style, Lumen on and off, in idle, working, needs you and done, the notch at 2x and Home at 1x
// (with a 2x and a 1x row of each), short clips of each placement moving, the text's contrast over the backdrop
// against the same page without it, and the notch's shape opening on a display without a camera cutout.
// node scripts/motion-sheet.cjs <outdir>   (ui/dist must be built; ffmpeg turns the clips into mp4)
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { serve, open, fixtures } = require('./motion-pages.cjs');
const root = path.resolve(__dirname, '..');
const { chromium } = require('playwright');

const STYLES = ['slats', 'glyphs', 'resonator'];
const PLACES = { notch: ['crown', 'rise', 'glass'], home: ['header', 'low', 'wash'] };
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

async function notchPage(browser, url, { state, style, lumen, place, dpr, video, cutout = true }) {
  const page = await open(browser, { label: 'notch', records: records(state, style, lumen), url, dpr, viewport: { width: 560, height: 640 }, video });
  await page.evaluate((p) => (window.__motion.place.notch = p), place);
  if (cutout) await page.evaluate(housing);
  await page.evaluate((g) => window.__fake.emit(g), GEOMETRY(cutout));
  await page.evaluate((s) => window.__fake.emit({ do: s === 'needs' ? 'answer' : 'capture' }), state);
  return page;
}
async function homePage(browser, url, { state, style, lumen, place, dpr, video }) {
  const page = await open(browser, { label: 'workspace', records: records(state, style, lumen), url, dpr, video });
  await page.evaluate((p) => ((window.__motion.place.home = p), window.__motion.redraw()), place);
  return page;
}
const sheetClip = (page) => page.evaluate(() => {
  const b = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-bottom')) || 400;
  return { x: 52, y: 0, width: 456, height: Math.min(640, b + 14) };
});

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
  const browser = await chromium.launch({ headless: true, args: GPU });
  const manifest = { stills: [], clips: [], contrast: [], shape: [] };
  const errors = [];
  const done = async (page, name) => {
    errors.push(...page.errors.map((e) => `${name}: ${e}`));
    await page.context().close();
  };
  try {
    // Stills: the notch at 2x, Home at 1x, and a row of the other scale for working with Lumen on.
    for (const [surface, places] of Object.entries(PLACES))
      for (const place of places)
        for (const style of STYLES)
          for (const lumen of [true, false])
            for (const state of STATES)
              for (const dpr of [1, 2]) {
                const main = surface === 'notch' ? 2 : 1;
                if (dpr !== main && !(state === 'working' && lumen)) continue;
                const o = { state, style, lumen, place, dpr };
                const page = surface === 'notch' ? await notchPage(browser, server.url, o) : await homePage(browser, server.url, o);
                await page.waitForTimeout(state === 'done' ? 2200 : 1500);
                await page.evaluate(() => document.fonts.ready);
                const file = `${surface}-${place}-${style}-${lumen ? 'lumen' : 'plain'}-${state}-${dpr}x.jpg`;
                await page.screenshot({ path: path.join(out, file), type: 'jpeg', quality: 84, clip: surface === 'notch' ? await sheetClip(page) : undefined });
                manifest.stills.push({ surface, place, style, lumen, state, dpr, file });
                if (style === 'slats' && dpr === main)
                  manifest.contrast.push({ surface, place, lumen, state, ...(await contrast(page, surface === 'notch' ? '#notch-home:not([hidden]),#notch[open]' : '.work>.toolbar,#main')) });
                await done(page, file);
              }
    console.log(`${manifest.stills.length} stills`);

    // Clips: each placement with each style, working, Lumen on and off, about three seconds.
    for (const [surface, places] of Object.entries(PLACES))
      for (const place of places)
        for (const style of STYLES)
          for (const lumen of [true, false]) {
            const size = surface === 'notch' ? { width: 560, height: 520 } : { width: 1180, height: 760 };
            const video = { dir: path.join(out, 'raw'), size: surface === 'notch' ? size : { width: 944, height: 608 } };
            const o = { state: 'working', style, lumen, place, dpr: 1, video };
            const page = surface === 'notch' ? await notchPage(browser, server.url, o) : await homePage(browser, server.url, o);
            await page.waitForTimeout(4200);
            const raw = await page.video().path();
            await done(page, 'clip');
            const file = `${surface}-${place}-${style}-${lumen ? 'lumen' : 'plain'}.mp4`;
            const crop = surface === 'notch' ? 'crop=456:520:52:0,' : '';
            execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', '1.2', '-i', raw, '-t', '3', '-vf', `${crop}fps=25,format=yuv420p`, '-c:v', 'libx264',
              '-crf', '27', '-preset', 'slow', '-movflags', '+faststart', '-an', path.join(out, file)]);
            manifest.clips.push({ surface, place, style, lumen, file });
          }
    fs.rmSync(path.join(out, 'raw'), { recursive: true, force: true });
    console.log(`${manifest.clips.length} clips`);

    // The shape opening on a display without a cutout: the tab, two steps, the open rectangle. The page's clock is
    // held so each step is taken at its moment.
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
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
  const worst = manifest.contrast.reduce((m, c) => Math.min(m, c.worst.ratio), Infinity);
  console.log(`contrast with the backdrop against without, worst line: ${worst}`);
  for (const e of errors) console.error(e);
  if (errors.length) process.exitCode = 1;
}

if (require.main === module) {
  if (!process.argv[2]) { console.error('usage: node scripts/motion-sheet.cjs <outdir>'); process.exit(2); }
  main(path.resolve(process.argv[2])).catch((e) => { console.error(e); process.exit(1); });
}
