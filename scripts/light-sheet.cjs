// The window's light, rendered from ui/dist in headless Chromium on fixture records, for judging it by eye and by
// number: Home in its quiet, normal and busy states in each palette,
// with and without the chrome, at 1x and 2x, beside a workspace with terminals; every line of text measured against
// the brightest pixel behind it; and clips of the light breathing, of a change of state, and of the wake of glyphs
// (the sidebar, a sheet) at normal and quarter speed. Writes PNGs, WebM clips and manifest.json into <outdir>.
// usage: node scripts/light-sheet.cjs <outdir> [--quick]
const fs = require('node:fs');
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
const { scene } = require('./instrument-fixtures.cjs');

const settle = (page, ms = 900) => page.waitForTimeout(ms);
const prefs = (palette, hue = 265) => [{ id: 'motion_palette', value: palette, rev: 1 }, { id: 'motion_hue', value: hue, rev: 1 }];
const set = (page, o) => page.evaluate((o) => (Object.assign(window.__motion.debug, o), window.__motion.redraw()), o);

/** Every line of text in the page against the brightest pixel behind it: the lowest ratio, and the text it is for. */
async function contrast(page) {
  await page.addStyleTag({ content: '.contrast-hide body *,.contrast-hide *::placeholder{color:transparent!important;-webkit-text-fill-color:transparent!important;caret-color:transparent!important}.contrast-hide kbd,.contrast-hide .st,.contrast-hide .wave,.contrast-hide .btn{visibility:hidden!important}' });
  const lines = await page.evaluate(() => {
    const out = [], range = document.createRange();
    const walk = document.createTreeWalker(document.querySelector('.hx') ?? document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent.trim() || n.parentElement.closest('kbd,.btn')) continue;
      const color = getComputedStyle(n.parentElement).color;
      range.selectNodeContents(n);
      // The glyphs' own band: a line box's top and bottom pixels can touch a neighbouring hairline, which no letter sits on.
      // A text cut with an ellipsis reports its whole run: only what its element shows counts.
      const box = n.parentElement.getBoundingClientRect();
      for (const r of range.getClientRects()) {
        const x = Math.max(r.left, box.left) + 1, w = Math.min(r.right, box.right) - x - 1;
        if (w > 1 && r.height > 4) out.push({ x, y: r.top + 2, w, h: r.height - 4, color, text: n.textContent.trim().slice(0, 40) });
      }
    }
    for (const i of document.querySelectorAll('.hx input, .hx textarea')) {
      const r = i.getBoundingClientRect(), s = getComputedStyle(i, '::placeholder');
      if (!i.value) out.push({ x: r.left, y: r.top, w: Math.min(r.width, 200), h: r.height, color: s.color, text: i.placeholder });
    }
    document.documentElement.classList.add('contrast-hide');
    return out;
  });
  const png = 'data:image/png;base64,' + (await page.screenshot()).toString('base64');
  await page.evaluate(() => document.documentElement.classList.remove('contrast-hide'));
  return page.evaluate(async ({ lines, png }) => {
    const img = new Image();
    img.src = png;
    await img.decode();
    const c = document.createElement('canvas');
    [c.width, c.height] = [img.width, img.height];
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const P = g.getImageData(0, 0, c.width, c.height).data, k = img.width / innerWidth;
    const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const L = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    let worst = { ratio: Infinity };
    for (const l of lines) {
      let m = 0;
      for (let y = Math.floor(l.y * k); y < Math.ceil((l.y + l.h) * k); y++)
        for (let x = Math.floor(l.x * k); x < Math.ceil((l.x + l.w) * k); x++) {
          const i = (y * c.width + x) * 4;
          m = Math.max(m, L(P[i], P[i + 1], P[i + 2]));
        }
      const [r, gg, b, a = 1] = l.color.match(/[\d.]+/g).map(Number);
      if (a === 0) continue;
      const t = L(r, gg, b), ratio = (Math.max(t, m) + 0.05) / (Math.min(t, m) + 0.05);
      if (ratio < worst.ratio) worst = { ratio: Math.round(ratio * 100) / 100, text: l.text, color: l.color, ground: Math.round(m * 10000) / 10000 };
    }
    return worst;
  }, { lines, png });
}

async function main(out, quick) {
  const { chromium } = require('playwright');
  fs.mkdirSync(out, { recursive: true });
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true });
  const manifest = { stills: [], contrast: [], clips: [] };
  const page1 = async (state, palette, dpr, extra = {}) => {
    const r = scene(state);
    r.prefs = prefs(palette);
    const page = await open(browser, { label: 'workspace', records: r, url: server.url, dpr, ...extra });
    await page.addStyleTag({ content: 'body::after{content:"";position:fixed;z-index:99;left:14px;top:13px;width:12px;height:12px;border-radius:50%;background:#ff5f57;box-shadow:20px 0 #febc2e,40px 0 #28c840;pointer-events:none}' });
    return { page, r };
  };
  try {
    const palettes = quick ? ['chromatic'] : ['chrome', 'chromatic', 'warm', 'cool', 'custom'];
    const states = ['quiet', 'normal', 'busy'];
    for (const dpr of quick ? [1] : [1, 2])
      for (const palette of palettes)
        for (const state of states)
          for (const strength of ['default']) {
            const { page } = await page1(state, palette, dpr);
            await settle(page, 1500);
            const name = `home-${state}-${palette}-${strength}@${dpr}x.png`;
            await page.screenshot({ path: path.join(out, name) });
            manifest.stills.push({ name, state, palette, strength, dpr, chrome: true });
            if (dpr === 1) manifest.contrast.push({ state, palette, strength, ...(await contrast(page)) });
            if (palette === 'chromatic' && strength === 'default') {
              await page.addStyleTag({ content: '.band{visibility:hidden!important}' });
              await settle(page, 300);
              const bare = `home-${state}-${palette}-${strength}-pools@${dpr}x.png`;
              await page.screenshot({ path: path.join(out, bare) });
              manifest.stills.push({ name: bare, state, palette, strength, dpr, chrome: false });
              if (dpr === 1) manifest.contrast.push({ state, palette, strength: `${strength}, pools only`, ...(await contrast(page)) });
              await page.addStyleTag({ content: '.light{visibility:hidden!important}' });
              await settle(page, 200);
              const none = `home-${state}-none@${dpr}x.png`;
              await page.screenshot({ path: path.join(out, none) });
              manifest.stills.push({ name: none, state, palette: 'none', dpr, chrome: false });
            }
            await page.context().close();
            console.log(name);
          }
    // Beside terminals: the sidebar's zone is the only light in the window.
    for (const dpr of quick ? [1] : [1, 2])
      for (const [state, s] of [['idle', 'quiet'], ['working', 'normal'], ['needs', 'busy']]) {
        const { page, r } = await page1(s, 'chromatic', dpr);
        await page.evaluate((id) => window.__ws.show(id), r.ids.projects.cuegrid);
        await settle(page, 1500);
        const name = `workspace-${state}@${dpr}x.png`;
        await page.screenshot({ path: path.join(out, name) });
        manifest.stills.push({ name, state, palette: 'chromatic', dpr, workspace: true });
        await page.context().close();
      }
    // Clips: breathing (10 s), a change of state, and the wake of glyphs at normal and quarter speed.
    const clip = async (name, state, act, secs, opts = {}) => {
      const dir = fs.mkdtempSync(path.join(out, '.rec-'));
      const r = scene(state);
      r.prefs = prefs('chromatic');
      const page = await open(browser, { label: 'workspace', records: r, url: server.url, dpr: 1, video: { dir, size: { width: 1180, height: 760 } } });
      if (opts.slow) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Animation.enable');
        await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.25 });
      }
      await act(page, r);
      await page.waitForTimeout(secs * 1000);
      const video = page.video();
      await page.context().close();
      fs.renameSync(await video.path(), path.join(out, name));
      fs.rmSync(dir, { recursive: true, force: true });
      manifest.clips.push({ name, state, secs, ...opts });
      console.log(name);
    };
    if (!quick) {
      await clip('breathing.webm', 'normal', (p) => set(p, { breathe: true }), 12);
      await clip('state-change.webm', 'quiet', async (p, r) => {
        await settle(p, 1500);
        await p.evaluate(() => (window.__motion.debug.state = 'working', window.__motion.redraw()));
        await settle(p, 4000);
        await p.evaluate(() => (window.__motion.debug.state = 'needs', window.__motion.redraw()));
        await settle(p, 4000);
        await p.evaluate(() => (window.__motion.debug.state = 'done', window.__motion.redraw()));
      }, 5);
      await clip('sidebar-glyphs-working.webm', 'normal', (p, r) => p.evaluate((id) => (window.__ws.show(id), window.__motion.debug.state = 'working', window.__motion.debug.breathe = true, window.__motion.redraw()), r.ids.projects.cuegrid), 8);
      for (const slow of [false, true]) {
        const sfx = slow ? '-quarter' : '';
        await clip(`wiper-sidebar${sfx}.webm`, 'normal', async (p) => {
          await settle(p, 800);
          await p.evaluate(() => window.__ws.command('sidebar'));
          await settle(p, slow ? 2400 : 900);
          await p.evaluate(() => window.__ws.command('sidebar'));
        }, slow ? 3 : 1.5, { slow });
        await clip(`wiper-sheet${sfx}.webm`, 'normal', async (p) => {
          await settle(p, 800);
          await p.evaluate(() => window.__ws.command('settings'));
        }, slow ? 3 : 1.5, { slow });
        await clip(`wiper-off-sheet${sfx}.webm`, 'normal', async (p) => {
          await settle(p, 800);
          await p.evaluate(() => window.__fake.push({ t: 'change', rev: 999, sets: [{ c: 'prefs', put: [{ id: 'motion_ambient', value: 'off', rev: 999 }] }] }));
          await settle(p, 600);
          await p.evaluate(() => window.__ws.command('settings'));
        }, slow ? 3 : 1.5, { slow });
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
  const worst = manifest.contrast.reduce((a, b) => (b.ratio < a.ratio ? b : a), { ratio: Infinity });
  console.log('lowest text contrast over the light:', JSON.stringify(worst));
}

if (require.main === module) {
  if (!process.argv[2]) (console.error('usage: node scripts/light-sheet.cjs <outdir> [--quick]'), process.exit(2));
  main(path.resolve(process.argv[2]), process.argv.includes('--quick')).catch((e) => (console.error(e), process.exit(1)));
}
