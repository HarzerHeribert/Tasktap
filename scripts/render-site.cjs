// Makes what the public site takes from the app, into site/app (committed, so the site is published exactly as it was
// looked at; scripts/build-site.py only copies it):
//   embed   the app's own notch page from ui/dist with a stand-in for the host and the core (site/src/stage.js and
//           motion-pages.cjs `fakeRuntime`), which the site's story moves from state to state as the page scrolls;
//           and the site's chrome (site/src/chrome.js), with the head every style of the app's motion shares
//           (ui/src/motion/head.ts) pasted in as it is: the app's metal, its studio and its tone curve
//   shots   the notch from that embed in each state of the story, at the sizes the site shows them and at 1x and 2x,
//           never scaled: the first screen's frame, and the stills that stand in each chapter where nothing is held
//           (Reduce Motion, a phone, no scripts); the chrome's form in each chapter, and the mark, drawn by that
//           chrome with the seats the page lays by it; and the workspace with its terminals, on fixture records
//           (instrument-fixtures.cjs), the one picture of Tasktap's window the page shows
//   stamp   what it was all made from (`inputs`), into site/app/SOURCE, which verify-pages.cjs holds the pictures to
// Run on a Mac, where the system face is the app's: (cd ui && npm run build) && node scripts/render-site.cjs
// usage: node scripts/render-site.cjs [embed] [shots] [stamp] [--only name,name]   (with no step: all three)
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
const INPUTS = ['ui/src', 'ui/public', 'ui/notch.html', 'ui/workspace.html', 'ui/vite.config.ts', 'ui/package-lock.json', 'site/src', 'site/site.css', 'site/index.html',
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
  // script and stylesheet here but the tokens, which are copied below, and the mark's small picture, which the
  // pictures' step makes (app/mark.css).
  for (const f of fs.readdirSync(out)) if (/\.(js|css)$|^notch\.html$/.test(f) && f !== 'tokens.css' && f !== 'mark.css') fs.rmSync(path.join(out, f));
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
  // The site's chrome: its forms after the app's shader head, as that is, with what only a reader needs (comments,
  // indentation) left out of what is sent.
  const lean = (glsl) => glsl.split('\n').map((l) => l.replace(/\s*\/\/.*$/, '').trim()).filter(Boolean).join('\n');
  const head = read('ui/src/motion/head.ts'), chrome = read('site/src/chrome.js');
  const f0 = chrome.indexOf('const FRAG = `') + 14, f1 = chrome.indexOf('`;', f0);
  if (!chrome.includes("/*HEAD*/''") || f0 < 14 || f1 < 0 || !head.includes('export const HEAD = `')) throw new Error('site/src/chrome.js or ui/src/motion/head.ts is not as embed expects');
  const plain = (js) => js.split('\n').filter((l) => !/^\s*\/\/ /.test(l)).join('\n');
  fs.writeFileSync(path.join(out, 'chrome.js'), (plain(chrome.slice(0, f0)) + '\n' + lean(chrome.slice(f0, f1)) + plain(chrome.slice(f1)))
    .replace("/*HEAD*/''", JSON.stringify(lean(head.slice(head.indexOf('`') + 1, head.lastIndexOf('`'))))));
  // The app's token file, as it is: the site names no colour, size or duration of its own.
  fs.copyFileSync(path.join(root, 'ui/src/tokens.css'), path.join(out, 'tokens.css'));
  console.log('embed', files.join(' '));
}

// ---- pictures ----
/** The notch from the site's own embed, in each state of the story: the first screen's frame (a task being said, its
 *  first words heard), which stands until the live notch takes its place, and the stills of the chapters, for where
 *  nothing is held (Reduce Motion, a phone, no scripts): [name, step, width]. The wide one stands in a column of 480 px
 *  or more, the narrow one on a phone. */
const STILLS = [];
/** The narrow stills are for phones, whose screens have three device pixels to one: they are made at 3x too. */
for (const step of ['rest', 'say', 'place', 'work', 'ask', 'result']) STILLS.push([`story-${step === 'rest' ? 'open' : step}`, step, 480], ...(step === 'rest' ? [] : [[`story-${step}-s`, step, 328]]));
/** The chrome's form in each chapter, with the seats the page lays by it, for where nothing is held; and the mark as
 *  the first screen has it, which the live chrome takes the place of: [name, place in the story, width, height, the
 *  stage's measures (site.js `measure`)]. The wide one stands in a column of 560 px or more, the narrow one on a phone. */
const FORMS = [['chrome-mark', 0, 320, 460, { unit: 100, mark: { x: 160, y: 230, h: 460 * 0.86 }, mid: { x: 160, y: 230 } }]];
for (const [step, b] of [['say', 1], ['place', 2], ['work', 3], ['ask', 4], ['result', 5]]) {
  FORMS.push([`chrome-${step}`, b, 560, 380, { unit: 120, mark: { x: 280, y: 165, h: 160 }, mid: { x: 280, y: 165 } }]);
  FORMS.push([`chrome-${step}-s`, b, 328, 250, { unit: 76, mark: { x: 164, y: 108, h: 100 }, mid: { x: 164, y: 108 } }]);
}
/** The page those are drawn on: the site's own chrome and the seats' circles, on black; the seats' words are words in
 *  the page, laid over the picture (site.css .labs), so they keep their size wherever the picture is shown smaller. The chrome is light (the app's motion.css):
 *  the site lays each picture over the page as light, so its black is clear and its edges are nowhere. */
const poster = () => `<!doctype html><html class="held"><meta charset="utf-8"><link rel="stylesheet" href="app/tokens.css"><link rel="stylesheet" href="site.css">
<style>html,body{margin:0;background:#000!important}.poster{position:relative;width:100vw;height:100vh;overflow:hidden}.seat :is(b,em,u){visibility:hidden}</style>
<div class="poster"><canvas class="chrome"></canvas>${/<div class="seats"[\s\S]*?\n  <\/div>/.exec(read('site/index.html'))[0]}</div>
<script type="module">import { mount, pose, lay } from './app/chrome.js';
const chrome = mount(document.querySelector('canvas'));
window.draw = (b, G) => { chrome.size(innerWidth, innerHeight, devicePixelRatio); const P = pose(b, { W: innerWidth, H: innerHeight, ...G }); chrome.draw(P, 0.62); lay([...document.querySelectorAll('.seat')], P); return new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))); };
window.ready = !!chrome;</script>`;
/** The notch's clock in the pictures: 9:41, whenever they are made. */
const NINE_41 = () => { const d = new Date(); d.setHours(9, 41, 30, 0); return d; };
/** Tasktap's window: the workspace on fixture records, terminals in splits and a question under its terminal, with the
 *  keyboard in it as when the person answers it there (its answers' caps show only then: page.ts markHeld). The site
 *  scales it to its column: [name, width, height]. */
const WINDOWS = [['workspace', 1040, 700], ['workspace-720', 720, 540]];
const TRAFFIC = 'body::after{content:"";position:fixed;z-index:99;left:14px;top:13px;width:12px;height:12px;border-radius:50%;background:#ff5f57;box-shadow:20px 0 #febc2e,40px 0 #28c840;pointer-events:none}';

async function shots(only) {
  const { chromium } = require('playwright');
  const { serve, open } = require('./motion-pages.cjs');
  const dir = path.join(out, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const site = await serve(path.join(root, 'site')), app = await serve(dist);
  const browser = await chromium.launch({ headless: true });
  const sizes = {};
  // Words and lines are kept exactly; the chrome, which has neither, as near as the eye can tell.
  const save = async (page, name, dpr, opts, soft = false) => {
    const png = path.join(dir, `${name}.png`), webp = path.join(dir, `${name}${dpr > 1 ? `@${dpr}x` : ''}.webp`);
    await page.screenshot({ path: png, ...opts });
    execFileSync('cwebp', ['-quiet', ...(soft ? ['-q', '86', '-sharp_yuv'] : ['-lossless', '-exact', '-q', '100']), '-m', '6', png, '-o', webp]);
    fs.rmSync(png);
    console.log(path.relative(root, webp), fs.statSync(webp).size);
  };
  try {
    for (const [name, step, w] of STILLS) {
      if (only && !only.includes(name)) continue;
      for (const dpr of w < 400 ? [1, 2, 3] : [1, 2]) {
        const h = 520;
        const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, reducedMotion: 'reduce' });
        const page = await context.newPage();
        page.on('pageerror', (e) => console.error(`${name}: ${e.message}`));
        await page.clock.setFixedTime(NINE_41());
        await page.goto(`${site.url}/app/notch.html?show=${step}`);
        await page.waitForTimeout(1800);
        await page.evaluate(() => document.fonts.ready);
        // The sheet and the glow under it; the height a whole number of pixels at 1x, the same at 2x.
        const bottom = 28 + await page.evaluate(() => Math.ceil(document.getElementById('sheet').getBoundingClientRect().bottom));
        sizes[name] = [w, bottom];
        await save(page, name, dpr, { clip: { x: 0, y: 0, width: w, height: bottom }, omitBackground: true });
        await context.close();
      }
    }
    // The chrome is drawn by the graphics card, as a visitor's browser draws it (without one the page shows these
    // pictures instead: site/src/chrome.js `mount`).
    const metal = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
    for (const [name, b, w, h, G] of FORMS) {
      if (only && !only.includes(name)) continue;
      for (const dpr of [1, 2]) {
        const context = await metal.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
        await context.route('**/poster.html', (r) => r.fulfill({ contentType: 'text/html', body: poster() }));
        const page = await context.newPage();
        page.on('pageerror', (e) => console.error(`${name}: ${e.message}`));
        await page.goto(`${site.url}/poster.html`);
        await page.waitForFunction(() => window.ready !== undefined);
        if (!(await page.evaluate(() => window.ready))) throw new Error(`${name}: this browser cannot draw the chrome (it needs a graphics card)`);
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(([b, G]) => window.draw(b, G), [b, G]);
        sizes[name] = [w, h];
        await save(page, name, dpr, {}, true);
        // The mark's place on the first screen holds the mark from the first paint: a picture of it small enough to
        // travel with the page's styles, which the still covers and the live chrome takes the place of.
        if (name === 'chrome-mark' && dpr === 1) {
          const png = path.join(dir, 'mark-small.png'), webp = path.join(dir, 'mark-small.webp');
          await page.screenshot({ path: png });
          execFileSync('cwebp', ['-quiet', '-resize', '96', '138', '-q', '68', '-m', '6', png, '-o', webp]);
          fs.writeFileSync(path.join(out, 'mark.css'), `/* Made by scripts/render-site.cjs with app/shots/chrome-mark.webp: the mark, small, for its place until that picture or the live chrome is there. */\n.mark-big::before{background-image:url(data:image/webp;base64,${fs.readFileSync(webp).toString('base64')})}\n`);
          fs.rmSync(png);
          fs.rmSync(webp);
          console.log('site/app/mark.css', fs.statSync(path.join(out, 'mark.css')).size);
        }
        await context.close();
      }
    }
    await metal.close();
    const { scene } = require('./instrument-fixtures.cjs');
    for (const [name, w, h] of WINDOWS) {
      if (only && !only.includes(name)) continue;
      for (const dpr of [1, 2]) {
        const records = scene('workspace');
        const page = await open(browser, { label: 'workspace', records, url: app.url, dpr, viewport: { width: w, height: h }, fixed: NINE_41() });
        await page.addStyleTag({ content: TRAFFIC });
        await page.evaluate((id) => window.__ws.show(id), records.ids.projects.cuegrid);
        // As a click puts it there: no focus ring, which only the keyboard's way there draws, and nothing scrolled.
        await page.waitForSelector('.ask-pane[data-question]');
        // Its answers' caps show while the page sees the keyboard there (page.ts markHeld): given the keyboard again
        // until they still show after the page has settled.
        const focus = () => page.evaluate(() => document.querySelector('.ask-pane[data-question]').focus({ focusVisible: false, preventScroll: true }));
        for (let i = 0; i < 6; i++) {
          await focus();
          await page.waitForTimeout(900);
          if (await page.evaluate(() => !!document.querySelector('.ask-pane[data-held]'))) break;
        }
        await page.evaluate(() => document.fonts.ready);
        if (!(await page.evaluate(() => !!document.querySelector('.ask-pane[data-held]')))) throw new Error(`${name}: the question's keys did not show`);
        sizes[name] = [w, h];
        await save(page, name, dpr, {});
        for (const e of page.errors) console.error(`${name}: ${e}`);
        await page.context().close();
      }
    }
  } finally {
    await browser.close();
    await site.close();
    await app.close();
  }
  // The sizes the site's markup gives each picture, so nothing shifts as they load.
  console.log('sizes', JSON.stringify(sizes));
}

async function main(args) {
  const at = args.indexOf('--only');
  const only = at >= 0 ? args.splice(at, 2)[1].split(',') : null;
  const all = !args.length;
  if (all || args.includes('embed')) embed();
  if (all || args.includes('shots')) await shots(only);
  if (all || args.includes('stamp')) stamp();
}
if (require.main === module) main(process.argv.slice(2)).catch((e) => (console.error(e), process.exit(1)));
module.exports = { inputs, stamped, INPUTS };
