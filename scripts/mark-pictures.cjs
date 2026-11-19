// Draws Tasktap's mark (ui/src/motion/mark.ts) into the pictures that show it, with the app's own motion engine in
// headless Chromium: the same metal, studio and palette as the chrome the window draws, drawn once here so that nothing
// draws it where it is shown. Each picture is drawn at sixteen times its size and halved four times, so its edges and
// its reflections are the average of what lies under each pixel; at 20 pixels and under the halved picture is then
// sharpened a little, by hand, so the slab's edges stay whole on a display with one pixel to a point.
//   ui/src/mark/       the pages' (ui.tsx Brand): at 14, 24 and 28 CSS pixels, drawn at 2x; at rest, and lit (the light
//                      moved along its face), which the pages fade to and back while the mark is at work
//   site/assets/       the site's header, at 1x and 2x, at rest and lit; and its favicon
//   host/icons/tray/   the notification area on Windows (host/src/tray.rs): 16, 20, 24 and 32 pixels, for a dark
//                      taskbar and a light one
// Its palette is the app's default (chromatic). Run on a Mac: node scripts/mark-pictures.cjs [--out folder] [--all]
// (--out writes everything under that folder instead, keeping the paths; --all also draws it in every palette, for
// looking at, into <out>/palettes).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

/** Where the light lies on the face: at rest the upper part of the slab is lit and a coloured horizon crosses it; lit,
 *  the face has turned and the horizon has gone down it. Over a light ground the face stands turned from the light,
 *  so the slab reads by its darker face rather than by its rim. */
const REST = -1.3, LIT = -0.5, PALE = -0.6;
const LOOK = { style: 'slats', palette: 'chromatic', hue: 265, lumen: false };

function pictures() {
  const out = [];
  for (const size of [14, 24, 28]) {
    out.push({ file: `ui/src/mark/mark-${size}.png`, px: size * 2, phase: REST });
    out.push({ file: `ui/src/mark/mark-${size}-lit.png`, px: size * 2, phase: LIT });
  }
  for (const [k, sfx] of [[1, ''], [2, '@2x']]) {
    out.push({ file: `site/assets/mark${sfx}.png`, px: 22 * k, phase: REST });
    out.push({ file: `site/assets/mark-lit${sfx}.png`, px: 22 * k, phase: LIT });
  }
  out.push({ file: 'site/assets/favicon.png', px: 32, phase: (REST + PALE) / 2 });
  for (const px of [16, 20, 24, 32]) {
    out.push({ file: `host/icons/tray/dark-${px}.png`, px, phase: REST });
    out.push({ file: `host/icons/tray/light-${px}.png`, px, phase: PALE });
  }
  return out;
}

async function bundle() {
  const { build } = require(path.join(root, 'ui/node_modules/rolldown'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasktap-mark-'));
  const entry = path.join(dir, 'entry.ts');
  fs.writeFileSync(entry, `import { still } from ${JSON.stringify(path.join(root, 'ui/src/motion/engine.ts'))};\n(window as any).still = still;\n`);
  await build({ input: entry, logLevel: 'warn', output: { file: path.join(dir, 'mark.js'), format: 'iife' } });
  const code = fs.readFileSync(path.join(dir, 'mark.js'), 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return code;
}

/** In the page: the mark at `px` pixels, as a PNG's data URL. */
function draw({ px, phase, light, look }) {
  const big = px * 16;
  let cv = window.still('mark', look, 'idle', big, 0, phase, light);
  if (!cv) return null;
  for (let n = big; n > px; ) {
    n = Math.max(px, n / 2);
    const half = document.createElement('canvas');
    half.width = half.height = n;
    const g = half.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(cv, 0, 0, n, n);
    cv = half;
  }
  if (px <= 20) {
    // By hand, at the smallest sizes: a light unsharp mask on the colour (an edge a little crisper, the face's light
    // and its horizon kept), and the faintest fringe of coverage dropped, so the outline is a line and not a haze.
    const g = cv.getContext('2d'), img = g.getImageData(0, 0, px, px), d = img.data, src = new Float32Array(d);
    const at = (x, y, c) => src[(Math.min(px - 1, Math.max(0, y)) * px + Math.min(px - 1, Math.max(0, x))) * 4 + c];
    for (let y = 0; y < px; y++)
      for (let x = 0; x < px; x++)
        for (let c = 0; c < 4; c++) {
          const i = (y * px + x) * 4 + c, blur = (at(x - 1, y, c) + at(x + 1, y, c) + at(x, y - 1, c) + at(x, y + 1, c) + 4 * at(x, y, c)) / 8;
          let v = src[i] + 0.45 * (src[i] - blur);
          if (c === 3 && v < 28) v = 0;
          d[i] = Math.max(0, Math.min(255, Math.round(v)));
        }
    g.putImageData(img, 0, 0);
  }
  return cv.toDataURL('image/png');
}

async function main() {
  const args = process.argv.slice(2), at = args.indexOf('--out');
  const base = at >= 0 ? path.resolve(args[at + 1]) : root;
  const { chromium } = require('playwright');
  const code = await bundle();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.setContent('<!doctype html><body style="background:#000">');
    await page.addScriptTag({ content: code });
    const list = pictures();
    if (args.includes('--all'))
      for (const [palette, hue] of [['chrome', 265], ['chromatic', 265], ['warm', 265], ['cool', 265], ['custom', 150]])
        for (const px of [16, 20, 24, 32, 44, 96]) list.push({ file: `palettes/${palette}-${px}.png`, px, phase: REST, look: { ...LOOK, palette, hue } });
    for (const p of list) {
      const url = await page.evaluate(draw, { px: p.px, phase: p.phase, light: 0, look: p.look ?? LOOK });
      if (!url) throw new Error(`no picture of ${p.file}: ${errors.join('; ') || 'the page has no WebGL 2'}`);
      const file = path.join(base, p.file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
      console.log(p.file, `${p.px} px`);
    }
    if (errors.length) throw new Error(errors.join('; '));
  } finally {
    await browser.close();
  }
}

main().catch((e) => (console.error(e), process.exit(1)));
