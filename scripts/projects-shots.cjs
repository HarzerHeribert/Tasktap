// Renders what Tasktap knows of a person's projects (ui/src/workspace/projects.tsx) from ui/dist in headless Chromium,
// on fixture records (projects-fixtures.cjs), no host: Settings ›
// Projects (as it opens, a project opened with its copies, folders that are gone, too full or empty, and the ones set
// aside), at 1x and 2x, Home also 720 px wide. With --check it also holds every state to the align and type checks'
// own measures (scripts/align-check.cjs, scripts/type-check.cjs), and says where a word is cut short.
// The text size is TEXT's (small, default, large; as scripts/text-sizes.sh sets it); --sizes renders all three.
// usage: node scripts/projects-shots.cjs <outdir> [dpr...] [--only a,b] [--check] [--sizes] [--dist <folder>]
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { serve, open, scaled, TEXT } = require('./motion-pages.cjs');
const { projects } = require('./projects-fixtures.cjs');

const settings = (page) => page.evaluate(() => ((window.__ws.ui.sheet = { kind: 'settings', at: 'projects' }), window.__motion.redraw()));
const wait = (ms) => (page) => page.waitForTimeout(ms);
const allow = async (page) => {
  await page.waitForSelector('.sheet .sh-f .key');
  await page.click('.sheet .sh-f .key');
};
const search = (p) => p.click('.sheet .sh-f >> text=Search in a folder…');
const both = (...fs) => async (page) => { for (const f of fs) await f(page); };
/** Scrolls Settings' pane so that what `sel` names is at its top. */
const scrollTo = (sel, by = 0) => (page) => page.evaluate(([s, b]) => {
  const pane = document.querySelector('.set-pane'), el = document.querySelector(s);
  if (pane && el) pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - b;
}, [sel, by]);
const NARROW = { width: 720, height: 540 };

/** Each state: its records, what is done to the page, and how long it settles before it is taken. */
function shots() {
  return {
    'settings': { records: projects('settings'), act: settings },
    'settings-narrow': { records: projects('settings'), act: settings, viewport: NARROW },
    'settings-list': { records: projects('settings'), act: both(settings, wait(300), scrollTo('.set-pane .field', 40)) },
    'settings-open': { records: projects('settings-open'), act: both(settings, wait(300), (p) => p.click('.line.pj >> text=cuegrid'), wait(200), scrollTo('.line.pj[aria-expanded=true]', 40)) },
    'settings-open-narrow': { records: projects('settings-open'), viewport: NARROW, act: both(settings, wait(300), (p) => p.click('.line.pj >> text=cuegrid'), wait(200), scrollTo('.line.pj[aria-expanded=true]', 40)) },
    // Settings says what the first run's sheet says of a search that found nothing.
    'settings-gone': { records: projects('settings-gone'), act: settings,
      says: ['Too many folders in Downloads', 'Over 5,000 folders in ~/Downloads. Choose the folder inside Downloads that holds your projects.',
        'No projects found in src',
        'Tasktap may not read code', 'macOS keeps Tasktap out of ~/Documents/code. Allow Tasktap under System Settings › Privacy & Security › Files and Folders, then search code again.',
        'git could not be read', '/Volumes/nas/git: Input/output error.'] },
    'settings-remove': { records: projects('settings-gone'), act: both(settings, wait(300), (p) => p.click('.line.pl:has(.t.path:text("~/projects")) >> text=Remove'), wait(100), scrollTo('.line-n.ask', 160)) },
    'settings-hidden': { records: projects('settings-hidden'), act: both(settings, wait(300), scrollTo('.list:last-child', 0), (p) => p.click('text=Not projects (2)'), wait(200), (p) => p.evaluate(() => { const s = document.querySelector('.set-pane'); s.scrollTop = s.scrollHeight; })) },
  };
}

// The checks' own measures, run here on these states: their in-page functions, read from their files as they are, so
// that this holds the pages to exactly what they hold every other state to.
function from(file, names) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/^main\(\)\.catch\(.*$/m, '');
  const m = { exports: {} };
  new Function('require', 'module', '__dirname', '__filename', `${src}\nmodule.exports = { ${names.join(', ')} };`)(require, m, __dirname, path.join(__dirname, file));
  return m.exports;
}
// In the page: the first run is a sheet of the sheet family, never words loose under the Composer (NOTES §13): a
// headline, at most three facts, the full sentence behind "What exactly is read", and the keys; nothing of it on Home.
function begins() {
  const bad = [];
  if (document.querySelector('.hx.first > :not(.capture, .cols, .finish)')) bad.push('first run: something stands loose under the Composer that is not the "Finish setup" line');
  const sheet = document.querySelector('.sheet');
  if (!sheet) return bad;
  const facts = sheet.querySelectorAll('.facts > li');
  if (facts.length > 3) bad.push(`first run: its sheet says ${facts.length} facts, not three at most`);
  if (sheet.querySelector('.facts') && !sheet.querySelector('.more-l')) bad.push('first run: its sheet has no "What exactly is read"');
  return bad;
}
// In the page: the owner's decisions of 2026-11-19 (docs/projects-design.md): every project found is a row, at the
// first run and in Settings, and nothing says "and N more"; the first run's list scrolls inside itself and Home does
// not; and what Tasktap says it reads says all it reads, and what may go to a model. In Settings a note says it in one
// sentence and the rest behind the "What exactly is read" that follows it, which the check has opened by a click: the
// note is read with the text that fold shows.
function promises() {
  const bad = [], every = [...window.__ws.records.cards.values()].filter((c) => !c.copy_of && !c.inside), cards = every.filter((c) => !c.hidden);
  const text = (sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent).join(' ');
  if (/\band \d+ more\b/i.test(text('.found, .set-pane'))) bad.push('a list of projects says "and N more"');
  const found = document.querySelector('.sheet .found .fr-s');
  if (found && document.querySelectorAll('.found .fr').length !== every.length) bad.push(`the first run shows ${document.querySelectorAll('.found .fr').length} of ${every.length} projects found`);
  if (document.querySelector('.home .found, .home .fr')) bad.push('what was found stands on Home, not in its sheet');
  const rows = document.querySelectorAll('.pjs > .line.pj');
  if (document.querySelector('.pjs') && !document.querySelector('.set-pane .field input')?.value && rows.length !== cards.length) bad.push(`Settings › Projects shows ${rows.length} of ${cards.length} projects`);
  const parts = [...document.querySelectorAll('.set-pane .note, .set-pane .more-l')];
  for (const p of document.querySelectorAll('.sheet .facts-all, .set-pane .note')) {
    if (!/reads/.test(p.textContent)) continue;
    let said = p.textContent;
    const fold = parts.slice(parts.indexOf(p) + 1).find((e) => e.matches('.more-l'));
    if (p.closest('.set-pane') && fold) {
      if (fold.getAttribute('aria-expanded') !== 'true') bad.push(`"What exactly is read" after "${p.textContent.slice(0, 40)}…" was not opened`);
      const shown = parts[parts.indexOf(fold) + 1];
      if (shown?.matches('.note')) said += ` ${shown.textContent}`;
    }
    if (!['README', 'package file', 'Git remote', 'first commit', 'model', 'up to 8'].every((w) => said.includes(w))) bad.push(`what it reads leaves something out: "${p.textContent.slice(0, 60)}…"`);
  }
  return bad;
}
// In the page: the words a state must say, in the sheet or Settings' pane, and those it must not.
function said([says, unsaid]) {
  const text = [...document.querySelectorAll('.sheet, .set-pane')].map((e) => e.textContent).join('\n');
  return [...says.filter((w) => !text.includes(w)).map((w) => `it does not say "${w}"`), ...unsaid.filter((w) => text.includes(w)).map((w) => `it says "${w}"`)];
}
async function unfold(page) {
  const fold = page.locator('.set-pane .more-l[aria-expanded=false]');
  for (let i = await fold.count(); i > 0; i--) {
    const f = fold.first();
    await f.scrollIntoViewIfNeeded();
    const b = await f.boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(150);
  }
}
// In the page: words cut short with an ellipsis, in what these pages draw.
function cut() {
  return [...document.querySelectorAll('.sheet *, .set-pane *')]
    .filter((el) => el.offsetParent && el.children.length === 0 && el.textContent.trim() && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow === 'ellipsis')
    .map((el) => `"${el.textContent.trim().slice(0, 48)}" (.${String(el.className).split(' ')[0] || el.tagName.toLowerCase()})`);
}

async function main(out, dprs, only, check) {
  const { chromium } = require('playwright');
  fs.mkdirSync(out, { recursive: true });
  const dist = process.argv.includes('--dist') ? process.argv[process.argv.indexOf('--dist') + 1] : path.join(__dirname, '../ui/dist');
  const server = await serve(path.resolve(dist));
  const browser = await chromium.launch({ headless: true });
  const align = check && from('align-check.cjs', ['audit', 'weights', 'LISTS']);
  const type = check && from('type-check.cjs', ['roles', 'fonts']);
  // The key role, with the floor no text size takes it under (as align-check.cjs reads it).
  const [, weight, floor, size] = /--f-key:(\d+) (?:max\(([\d.]+)px,)?round\(([\d.]+)px/.exec(fs.readFileSync(path.join(__dirname, '../ui/src/tokens.css'), 'utf8'));
  const KEY = { size: Math.max(Number(floor ?? 0), scaled(Number(size))), weight: Number(weight) };
  const all = type && type.roles();
  // Where two roles compute alike (at the small text size a label comes to the key's 12 px and weight), a key is taken
  // as the key's and the rest as the other's, as type-check.cjs takes them.
  const role = (key, isKey) => {
    const [face, sz, w, sp] = key.split(' ');
    const alike = all.filter((r) => r.name !== 'term' && r.face === face && r.size === Number(sz) && r.weight === w && Math.abs(r.spacing - Number(sp)) < 0.01);
    return alike.find((r) => (r.name === 'key') === isKey) ?? alike[0];
  };
  const failures = [], notes = [];
  try {
    for (const dpr of dprs) {
      for (const [name, s] of Object.entries(shots())) {
        if (only && !only.includes(name)) continue;
        const page = await open(browser, { label: 'workspace', records: structuredClone(s.records), url: server.url, dpr, viewport: s.viewport, system: s.system });
        // The window's own buttons are the system's; drawn here so a capture reads as the window.
        await page.addStyleTag({ content: 'body::after{content:"";position:fixed;z-index:99;left:14px;top:13px;width:12px;height:12px;border-radius:50%;background:#ff5f57;box-shadow:20px 0 #febc2e,40px 0 #28c840;pointer-events:none}' });
        if (s.act) await s.act(page);
        await page.waitForTimeout(s.settle ?? 600);
        await page.evaluate(() => document.fonts.ready);
        const file = `projects-${name}-${TEXT}@${dpr}x.png`;
        await page.screenshot({ path: path.join(out, file) });
        if (check && dpr === dprs[0]) {
          const r = await page.evaluate(align.audit, [align.LISTS, KEY]);
          const w = await page.evaluate(align.weights);
          const first = await page.evaluate(begins);
          await unfold(page);
          const own = [...first, ...await page.evaluate(promises), ...await page.evaluate(said, [s.says ?? [], s.unsaid ?? []])];
          for (const b of [...r.bad, ...w.bad, ...own]) failures.push(`${name} (${TEXT}): ${b}`);
          for (const [key, where] of Object.entries(await page.evaluate(type.fonts))) {
            const rl = role(key, where.some((w) => /\bkbd\b/.test(w))), width = key.split(' ')[4];
            if (width !== '100%') failures.push(`${name} (${TEXT}): text at width ${width} (${where.slice(0, 3).join(', ')})`);
            else if (!rl) failures.push(`${name} (${TEXT}): "${key.split(' ').slice(0, 4).join(' ')}" is no role's (${where.slice(0, 3).join(', ')})`);
            for (const at of where) if (/\bkbd\b/.test(at) !== (role(key, /\bkbd\b/.test(at))?.name === 'key') && !/(ring-o|amark) text/.test(at)) failures.push(`${name} (${TEXT}): ${/\bkbd\b/.test(at) ? 'a key outside the key role' : 'the key role on what is no key'} (${at})`);
          }
          for (const c of await page.evaluate(cut)) notes.push(`${name} (${TEXT}): cut short ${c}`);
        }
        for (const e of page.errors) failures.push(`${name}: the page said ${e}`);
        await page.context().close();
        console.log(file);
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  for (const n of [...new Set(notes)]) console.log('NOTE  ' + n);
  for (const f of [...new Set(failures)]) console.log('FAIL  ' + f);
  if (check) console.log(failures.length ? `FAIL  projects (${TEXT}): ${new Set(failures).size} things` : `PASS  projects (${TEXT}): every state keeps the align and type checks' rules`);
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (f) => (args.includes(f) ? (args.splice(args.indexOf(f), 1), true) : false);
  const check = flag('--check'), sizes = flag('--sizes');
  const at = args.indexOf('--only');
  const only = at >= 0 ? args.splice(at, 2)[1].split(',') : null;
  // --dist <folder>: the pages built elsewhere than ui/dist (read in main, from the process's own arguments).
  const di = args.indexOf('--dist'), dist = di >= 0 ? args.splice(di, 2) : [];
  const [out, ...d] = args;
  if (!out) (console.error('usage: node scripts/projects-shots.cjs <outdir> [dpr...] [--only a,b] [--check] [--sizes]'), process.exit(2));
  if (sizes) {
    // The three text sizes side by side, each in a process of its own: the size is read once, when a page module loads.
    const runs = ['small', 'default', 'large'].map((text) => new Promise((done) => {
      const p = spawn(process.execPath, [__filename, out, ...d, ...(only ? ['--only', only.join(',')] : []), ...(check ? ['--check'] : []), ...dist], { env: { ...process.env, TEXT: text }, stdio: 'inherit' });
      p.on('exit', (code) => done(code));
    }));
    Promise.all(runs).then((codes) => (process.exitCode = codes.some(Boolean) ? 1 : 0));
  } else main(path.resolve(out), d.length ? d.map(Number) : [1, 2], only, check).catch((e) => (console.error(e), process.exit(1)));
}
module.exports = { shots };
