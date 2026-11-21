// Makes what the public site takes from the app, into site/app (committed, so the site is published exactly as it was
// looked at; scripts/build-site.py only copies it):
//   embed   the app's own notch page from ui/dist with a stand-in for the host and the core (site/src/stage.js and
//           motion-pages.cjs `fakeRuntime`), which the site plays live
//   chrome  the app's motion engine and its styles, bundled from ui/src/motion (site/src/chrome.ts)
//   shots   pictures of the app's pages on fixture records (instrument-fixtures.cjs), at the sizes the site shows
//           them and at 1x and 2x, never scaled; and of the notch and the chrome for where scripts are off
//   stamp   what it was all made from (`inputs`), into site/app/SOURCE, which verify-pages.cjs holds the pictures to
// Run on a Mac, where the system face is the app's: (cd ui && npm run build) && node scripts/render-site.cjs
// usage: node scripts/render-site.cjs [embed] [chrome] [shots] [stamp] [--only name,name]   (with no step: all four)
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'ui/dist');
const out = path.join(root, 'site/app');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/** What the site's part of the app is made from: the app's pages and their dependencies, the stand-in for the host and
 *  the core with its records, the protocol, the fixtures and this recipe. One hash of every file's path and bytes, in
 *  order; tests left out. When it differs from the one in site/app/SOURCE, something here would make other pictures. */
const INPUTS = ['ui/src', 'ui/public', 'ui/notch.html', 'ui/workspace.html', 'ui/vite.config.ts', 'ui/package-lock.json', 'site/src',
  'scripts/render-site.cjs', 'scripts/motion-pages.cjs', 'scripts/instrument-fixtures.cjs', 'core/proto/protocol.ts'];
function inputs(base = root) {
  // The files git keeps, so a stray local file counts for nothing, read as they are in the working tree.
  const files = execFileSync('git', ['-C', base, 'ls-files', '-z', '--', ...INPUTS], { encoding: 'utf8' }).split('\0').filter((f) => f && !/\.test\.ts$/.test(f));
  const hash = require('node:crypto').createHash('sha256');
  for (const rel of files.sort()) hash.update(rel + '\0').update(fs.readFileSync(path.join(base, rel))).update('\0');
  return hash.digest('hex');
}
/** The hash site/app/SOURCE says the pictures were made from. */
const stamped = (dir = out) => (/^inputs ([0-9a-f]{64})$/m.exec(fs.existsSync(path.join(dir, 'SOURCE')) ? fs.readFileSync(path.join(dir, 'SOURCE'), 'utf8') : '') || [])[1] || null;
function stamp() {
  const commit = execFileSync('git', ['-C', root, 'log', '-1', '--format=%h', '--', 'ui', 'site/src', 'scripts/motion-pages.cjs'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(out, 'SOURCE'), `Made by scripts/render-site.cjs from ui/ at ${commit}.\ninputs ${inputs()}\n`);
  console.log('stamp', stamped());
}

function embed() {
  if (!fs.existsSync(path.join(dist, 'notch.html'))) throw new Error('ui/dist is not built: (cd ui && npm run build)');
  fs.mkdirSync(out, { recursive: true });
  // What the page was made of before goes, whatever the bundler named its chunks then (motion-…, changes-…): every
  // script and stylesheet here but the chrome and the tokens, which are made below.
  for (const f of fs.readdirSync(out)) if (/\.(js|css)$|^notch\.html$/.test(f) && !['chrome.js', 'tokens.css'].includes(f)) fs.rmSync(path.join(out, f));
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
  const terms = "{ route: { instructions: '', sends: [], terms: 3, tools: [{ agent: 'claude', model: 'haiku', pays: 'plan', ms: 3700 }] }, speech: { sent: [], path: '/v1/audio/transcriptions', seconds: 300 } }";
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
/* The list alone: the Composer above it would leave its shadow in the picture's top edge. */
const ALONE = '.capture{visibility:hidden}';
// The effects at Off also hold the empty field's line still (ui/src/lines.ts `rolls` wants Full), so the Composer is
// always taken at its first line, "What's next?". The notch's stills cannot roll either: the stage keeps the keyboard
// out of the field and they are taken under Reduce Motion.
const off = (records) =>((records.prefs = (records.prefs || []).filter((p) => p.id !== 'motion_ambient').concat({ id: 'motion_ambient', value: 'off', rev: 70 })), records);
function pictures() {
  const { scene, flow } = require('./instrument-fixtures.cjs');
  const show = (key) => async (page, r) => page.evaluate((id) => window.__ws.show(id), r.ids.projects[key]);
  const both = (...acts) => async (page, r) => { for (const a of acts) await a(page, r); };
  // As a click puts it there: no focus ring, which only the keyboard's way there draws, and nothing scrolled, which a
  // window that never scrolls must not be (in the narrow window the question stands below what is drawn).
  const held = async (page) => (await page.waitForSelector('.ask-pane[data-question]'),
    await page.evaluate(() => document.querySelector('.ask-pane[data-question]').focus({ focusVisible: false, preventScroll: true })));
  return {
    // A spoken thought on its way: where it goes, its brief, the words as said, Undo. The Composer 600 wide.
    held: { records: () => off(flow(scene('normal'), 'held', {})), fit: ['.capture.raised', 600], cut: '.capture.raised', pad: [10, 20, 12, 20], clear: true },
    // Home's first layer while much goes on: what needs the person, changes waiting, what runs. One column, at the
    // Composer's width (tokens.css --home-w), as a window of any usual width shows it.
    home: { records: () => off(scene('busy')), fit: ['.cols', 720], cut: '.cols > .col', pad: [8, 0, 8, 0], clear: true, height: 1100, style: ALONE },
    // The workspace: terminals in splits, a question under its terminal, with the keyboard in it as when the person
    // answers it there: its answers' caps show only then (page.ts markHeld, parts.css "A key cap shows only…").
    workspace: { records: () => scene('workspace'), viewport: [1040, 700], act: both(show('cuegrid'), held), style: TRAFFIC },
    'workspace-720': { records: () => scene('workspace'), viewport: [720, 540], act: both(show('cuegrid'), held), style: TRAFFIC },
  };
}
/** The notch from the site's own embed, as a picture for where it cannot run: [name, step, width, height]. */
const STILLS = [['notch-rest', 'rest', 200, 40], ['notch', 'ask', 480, 400], ['notch-320', 'ask', 328, 440]];
/** The chrome at rest, from the site's own page, for where it is not drawn live: [name, the page's width]. */
const BANDS = [['band', 1440], ['band-s', 600]];

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
    execFileSync('cwebp', ['-quiet', ...(lossy ? ['-q', '84', '-alpha_q', '90', '-sharp_yuv'] : ['-lossless', '-exact', '-q', '100']), '-m', '6', png, '-o', webp]);
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
        // At rest, as the page is first seen: the notch is kept from starting, so nothing is going on.
        const context = await browser.newContext({ viewport: { width: w, height: 800 }, deviceScaleFactor: dpr });
        const page = await context.newPage();
        await page.route('**/app/notch.html', (r) => r.abort());
        await page.goto(`${site.url}/index.html`);
        await page.addStyleTag({ content: 'html,body{background:transparent!important}.words,.notch,.steps,.bar,.pool{visibility:hidden}.band{-webkit-mask-image:none!important;mask-image:none!important}' });
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
  if (all || args.includes('stamp')) stamp();
}
if (require.main === module) main(process.argv.slice(2)).catch((e) => (console.error(e), process.exit(1)));
module.exports = { inputs, stamped, INPUTS };
