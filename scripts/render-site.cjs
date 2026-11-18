// Makes what the public site takes from the app, into site/app (committed, so the site is published exactly as it was
// looked at; scripts/build-site.py only copies it):
//   embed   the app's own notch page from ui/dist with a stand-in for the host and the core (site/src/stage.js and
//           motion-pages.cjs `fakeRuntime`), which the site plays live
//   chrome  the app's motion engine and its styles, bundled from ui/src/motion (site/src/chrome.ts)
//   shots   pictures of the app's pages on fixture records (instrument-fixtures.cjs), at the sizes the site shows
//           them and at 1x and 2x, never scaled; and of the notch and the chrome for where scripts are off
// Run on a Mac, where the system face is the app's: (cd ui && npm run build) && node scripts/render-site.cjs
// usage: node scripts/render-site.cjs [embed] [chrome] [shots] [--only name,name]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'ui/dist');
const out = path.join(root, 'site/app');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function embed() {
  if (!fs.existsSync(path.join(dist, 'notch.html'))) throw new Error('ui/dist is not built: (cd ui && npm run build)');
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(out)) if (/^(notch|motion)-.*\.(js|css)$|^(notch\.html|stage\.js)$/.test(f)) fs.rmSync(path.join(out, f));
  // The page's own files, as built: its script, the chunk it shares, its two stylesheets.
  const html = fs.readFileSync(path.join(dist, 'notch.html'), 'utf8');
  const files = [...html.matchAll(/(?:src|href)="\.\/assets\/([^"]+)"/g)].map((m) => m[1]);
  for (const f of files) fs.copyFileSync(path.join(dist, 'assets', f), path.join(out, f));
  const script = files.find((f) => /^notch-.*\.js$/.test(f));
  // The stand-in for the host and the core, as the app's own checks use it, and the protocol version it greets with.
  const pages = read('scripts/motion-pages.cjs');
  const start = pages.indexOf('function fakeRuntime(');
  const runtime = pages.slice(start, pages.indexOf('\n}\n', start) + 2);
  const version = Number(/export const VERSION = (\d+)/.exec(read('core/proto/protocol.ts'))[1]);
  const calls = /const CALLS = (\[[^\]]*\]);/.exec(pages)[1];
  const terms = "{ route: { instructions: '', sends: [], tools: [{ agent: 'claude', model: 'haiku' }] }, speech: { sent: [], path: '/v1/audio/transcriptions', seconds: 300 } }";
  const stage = read('site/src/stage.js').replace('/*FAKE_RUNTIME*/', `(${runtime})({ label: 'notch', records, welcome: { v: ${version}, calls: ${calls} }, terms: ${terms} });`);
  if (!stage.includes('__TAURI_INTERNALS__')) throw new Error('fakeRuntime was not found in scripts/motion-pages.cjs');
  fs.writeFileSync(path.join(out, 'stage.js'), stage);
  const links = files.filter((f) => f.endsWith('.css')).map((f) => `<link rel="stylesheet" href="${f}">`).join('');
  // While the page around it says hold (out of sight, or the tab hidden), what loops in here stands still too.
  const style = '<style>html{background:transparent}[data-held] *,[data-held] ::before,[data-held] ::after{animation-play-state:paused!important}</style>';
  fs.writeFileSync(path.join(out, 'notch.html'),
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Tasktap’s notch, live</title>\n${links}${style}\n<script src="stage.js"></script>\n<script type="module" src="${script}"></script>\n</head>\n<body class="native-host notch-first">\n</body>\n</html>\n`);
  // The app's token file, as it is: the site names no colour, size or duration of its own.
  fs.copyFileSync(path.join(root, 'ui/src/tokens.css'), path.join(out, 'tokens.css'));
  const commit = execFileSync('git', ['-C', root, 'log', '-1', '--format=%h', '--', 'ui', 'scripts/motion-pages.cjs'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(out, 'SOURCE'), `Made by scripts/render-site.cjs from ui/ at ${commit}.\n`);
  console.log('embed', files.join(' '));
}

async function chrome() {
  const { build } = require(path.join(root, 'ui/node_modules/rolldown'));
  fs.mkdirSync(out, { recursive: true });
  await build({ input: path.join(root, 'site/src/chrome.ts'), logLevel: 'warn', output: { file: path.join(out, 'chrome.js'), format: 'esm', minify: true } });
  console.log('chrome', fs.statSync(path.join(out, 'chrome.js')).size, 'bytes');
}

// ---- pictures ----
// The app's pages, on fixture records, at the size the site shows each: nothing is scaled, and each is taken at 1x and 2x.
// Parts of Home are cut out of the page with nothing behind them (the effects at Off, no ground), so on the site they
// stand on the site's own ground as they stand on the window's.
const TRAFFIC = 'body::after{content:"";position:fixed;z-index:99;left:14px;top:13px;width:12px;height:12px;border-radius:50%;background:#ff5f57;box-shadow:20px 0 #febc2e,40px 0 #28c840;pointer-events:none}';
const off = (records) => ((records.prefs = (records.prefs || []).filter((p) => p.id !== 'motion_ambient').concat({ id: 'motion_ambient', value: 'off', rev: 70 })), records);
function pictures() {
  const { scene, flow } = require('./instrument-fixtures.cjs');
  const show = (key) => async (page, r) => page.evaluate((id) => window.__ws.show(id), r.ids.projects[key]);
  return {
    // A spoken thought on its way: where it goes, its brief, the words as said, Undo. The Composer 600 wide.
    held: { records: () => off(flow(scene('normal'), 'held', {})), fit: ['.capture.raised', 600], cut: '.capture.raised', pad: [10, 24, 12, 24], clear: true },
    // Home's first layer while much goes on: what needs the person, changes waiting, what runs.
    home: { records: () => off(scene('busy')), fit: ['.cols', 1040], cut: '.cols > .col', pad: [8, 0, 8, 0], clear: true, height: 1100 },
    'home-640': { records: () => off(scene('busy')), fit: ['.cols', 640], cut: '.cols > .col', pad: [8, 0, 8, 0], clear: true, height: 1100 },
    // The workspace: terminals in splits, a question under its terminal.
    workspace: { records: () => scene('workspace'), viewport: [1040, 700], act: show('cuegrid'), style: TRAFFIC },
    'workspace-720': { records: () => scene('workspace'), viewport: [720, 540], act: show('cuegrid'), style: TRAFFIC },
  };
}
/** The notch from the site's own embed, as a picture for where it cannot run: [name, step, width, height]. */
const STILLS = [['notch-rest', 'rest', 200, 40], ['notch', 'ask', 480, 400], ['notch-320', 'ask', 328, 440]];
/** The chrome at rest, from the site's own page, for where it is not drawn live: [name, the page's width]. */
const BANDS = [['band', 1280], ['band-s', 390]];

async function shots(only) {
  const { chromium } = require('playwright');
  const { serve, open, GPU } = require('./motion-pages.cjs');
  const dir = path.join(out, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const app = await serve(dist), site = await serve(path.join(root, 'site'));
  const browser = await chromium.launch({ headless: true, args: GPU });
  const sizes = {};
  // Words and lines are kept exactly; the chrome is a picture of metal, where a little loss cannot be seen.
  const save = async (page, name, dpr, opts, lossy) => {
    const png = path.join(dir, `${name}.png`), webp = path.join(dir, `${name}${dpr === 2 ? '@2x' : ''}.webp`);
    await page.screenshot({ path: png, ...opts });
    execFileSync('cwebp', ['-quiet', ...(lossy ? ['-q', '90', '-alpha_q', '95', '-sharp_yuv'] : ['-lossless', '-exact', '-q', '100']), '-m', '6', png, '-o', webp]);
    fs.rmSync(png);
    console.log(path.relative(root, webp), fs.statSync(webp).size);
  };
  try {
    for (const [name, p] of Object.entries(pictures())) {
      if (only && !only.includes(name)) continue;
      for (const dpr of [1, 2]) {
        const [w, h] = p.viewport || [1180, p.height || 900];
        const records = p.records();
        const page = await open(browser, { label: 'workspace', records, url: app.url, dpr, viewport: { width: w, height: h } });
        if (p.style) await page.addStyleTag({ content: p.style });
        if (p.act) await p.act(page, records);
        if (p.fit) {
          // The window is made as wide as gives the part its width on the site.
          for (let i = 0; i < 4; i++) {
            const have = await page.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().width, p.fit[0]);
            if (Math.abs(have - p.fit[1]) < 0.5) break;
            const v = page.viewportSize();
            await page.setViewportSize({ width: Math.round(v.width + p.fit[1] - have), height: v.height });
            await page.waitForTimeout(150);
          }
        }
        await page.waitForTimeout(900);
        await page.evaluate(() => document.fonts.ready);
        let clip;
        if (p.cut) {
          const b = await page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }, p.cut);
          const [t, r, bo, l] = p.pad;
          clip = { x: Math.round(b[0]) - l, y: Math.round(b[1]) - t, width: Math.round(b[2]) + l + r, height: Math.round(b[3]) + t + bo };
        }
        sizes[name] = clip ? [clip.width, clip.height] : [page.viewportSize().width, page.viewportSize().height];
        await save(page, name, dpr, { clip, omitBackground: !!p.clear });
        for (const e of page.errors) console.error(`${name}: ${e}`);
        await page.context().close();
      }
    }
    for (const [name, step, w, h] of STILLS) {
      if (only && !only.includes(name)) continue;
      for (const dpr of [1, 2]) {
        const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, reducedMotion: 'reduce' });
        const page = await context.newPage();
        await page.goto(`${site.url}/app/notch.html?show=${step}`);
        await page.waitForTimeout(1500);
        const bottom = step === 'rest' ? h : 44 + await page.evaluate(() => Math.ceil(document.getElementById('sheet').getBoundingClientRect().bottom));
        sizes[name] = [w, bottom];
        await save(page, name, dpr, { clip: { x: 0, y: 0, width: w, height: bottom }, omitBackground: true });
        await context.close();
      }
    }
    for (const [name, w] of BANDS) {
      if (only && !only.includes(name)) continue;
      for (const dpr of [1, 2]) {
        const context = await browser.newContext({ viewport: { width: w, height: 800 }, deviceScaleFactor: dpr, reducedMotion: 'reduce' });
        const page = await context.newPage();
        await page.goto(`${site.url}/index.html`);
        await page.addStyleTag({ content: 'html,body{background:transparent!important}.top-in,.bar,.pool{visibility:hidden}.band{-webkit-mask-image:none!important;mask-image:none!important}' });
        await page.waitForSelector('#band.drawn', { timeout: 15000 });
        await page.waitForTimeout(600);
        const b = await page.evaluate(() => { const r = document.getElementById('band').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
        sizes[name] = [b.width, b.height];
        await save(page, name, dpr, { clip: b, omitBackground: true }, true);
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await app.close();
    await site.close();
  }
  // The sizes the site's markup gives each picture, so nothing shifts as they load.
  console.log('sizes', JSON.stringify(sizes));
}

async function main(args) {
  const at = args.indexOf('--only');
  const only = at >= 0 ? args.splice(at, 2)[1].split(',') : null;
  const all = !args.length;
  if (all || args.includes('embed')) embed();
  if (all || args.includes('chrome')) await chrome();
  if (all || args.includes('shots')) await shots(only);
}
main(process.argv.slice(2)).catch((e) => (console.error(e), process.exit(1)));
