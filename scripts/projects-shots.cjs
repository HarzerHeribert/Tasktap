// Renders what Tasktap knows of a person's projects (ui/src/workspace/projects.tsx) from ui/dist in headless Chromium,
// on fixture records (projects-fixtures.cjs), no host: the first run on Home (the agents' history offered, what was
// found filling in and done, the folder most of them are in suggested, a person with no agent history) and Settings ›
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
  await page.waitForSelector('.begin .key');
  await page.click('.begin .key');
};
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
    'first-agents': { records: projects('first-agents') },
    'first-agents-narrow': { records: projects('first-agents'), viewport: NARROW },
    'first-filling': { records: projects('first-found'), act: both(allow, wait(440)), settle: 0 },
    'first-found': { records: projects('first-found'), act: both(allow, wait(1400)) },
    'first-found-narrow': { records: projects('first-found'), act: both(allow, wait(1400)), viewport: NARROW },
    'first-many': { records: projects('first-many'), act: both(allow, wait(4000)) },
    // The list of all of them, scrolled by the wheel: it dissolves at both edges, and Home stays where it is.
    'first-many-scrolled': { records: projects('first-many'), act: both(allow, wait(4000), (p) => p.hover('.found > .fr-s'), (p) => p.mouse.wheel(0, 100)) },
    'first-many-narrow': { records: projects('first-many'), act: both(allow, wait(4000)), viewport: NARROW },
    'first-folders': { records: projects('first-folders') },
    'first-folders-narrow': { records: projects('first-folders'), viewport: NARROW },
    'settings': { records: projects('settings'), act: settings },
    'settings-narrow': { records: projects('settings'), act: settings, viewport: NARROW },
    'settings-list': { records: projects('settings'), act: both(settings, wait(300), scrollTo('.set-pane .field', 40)) },
    'settings-open': { records: projects('settings-open'), act: both(settings, wait(300), (p) => p.click('.line.pj >> text=cuegrid'), wait(200), scrollTo('.line.pj[aria-expanded=true]', 40)) },
    'settings-open-narrow': { records: projects('settings-open'), viewport: NARROW, act: both(settings, wait(300), (p) => p.click('.line.pj >> text=cuegrid'), wait(200), scrollTo('.line.pj[aria-expanded=true]', 40)) },
    'settings-gone': { records: projects('settings-gone'), act: settings },
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
// In the page: the first run's composition, held to what the align check holds the line it replaces to (whose own
// selector, `.attach`, this composition does not have): its answer on the edge of the Composer's key, its words on the
// edge of the Composer's text, and what was found on the Composer's edges, as For later is.
function begins() {
  const bad = [], box = (e) => e.getBoundingClientRect();
  const cap = document.querySelector('.home .capture.raised .cap'), block = document.querySelector('.hx.first > :is(.begin, .found)');
  if (!cap || !block) return bad;
  if (block.matches('.begin')) {
    const answer = block.querySelector('.begin-f')?.lastElementChild, go = cap.querySelector('.cap-row .key');
    if (!answer || !go || Math.abs(box(answer).right - box(go).right) > 0.5) bad.push('first run: its answer is not on the edge of the Composer\'s key');
    for (const words of block.querySelectorAll(':scope > h3, :scope > p, :scope > .ticks, .begin-f > :first-child'))
      if (Math.abs(box(words).left - box(cap.querySelector('textarea')).left - 10) > 0.5) bad.push(`first run: "${words.textContent.trim().slice(0, 30)}" is not on the edge of the Composer's text`);
  } else if (Math.abs(box(block).left - box(cap).left) > 0.5 || Math.abs(box(block).right - box(cap).right) > 0.5) bad.push('first run: what was found is not on the Composer\'s edges');
  return bad;
}
// In the page: the owner's decisions of 2026-11-19 (docs/projects-design.md): every project found is a row, at the
// first run and in Settings, and nothing says "and N more"; the first run's list scrolls inside itself and Home does
// not; and what Tasktap says it reads says all it reads, and what may go to a model.
function promises() {
  const bad = [], cards = [...window.__ws.records.cards.values()].filter((c) => !c.copy_of && !c.inside && !c.hidden);
  const text = (sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent).join(' ');
  if (/\band \d+ more\b/i.test(text('.found, .set-pane'))) bad.push('a list of projects says "and N more"');
  const found = document.querySelector('.hx.first > .found .fr-s'), home = document.querySelector('.room > .home');
  if (found && document.querySelectorAll('.found .fr').length !== cards.length) bad.push(`the first run shows ${document.querySelectorAll('.found .fr').length} of ${cards.length} projects found`);
  // (Unless the window is too short for its least, three rows.)
  const row = found?.querySelector('.fr')?.getBoundingClientRect().height ?? 0;
  if (found && home && home.scrollHeight > home.clientHeight + 1 && found.clientHeight > 3 * row + 1) bad.push('Home scrolls under what was found, not the list');
  const rows = document.querySelectorAll('.pjs > .line.pj');
  if (document.querySelector('.pjs') && !document.querySelector('.set-pane .field input')?.value && rows.length !== cards.length) bad.push(`Settings › Projects shows ${rows.length} of ${cards.length} projects`);
  for (const p of document.querySelectorAll('.begin > p, .set-pane .note'))
    if (/reads/.test(p.textContent) && !['README', 'package file', 'Git remote', 'first commit', 'model', 'up to 8'].every((w) => p.textContent.includes(w))) bad.push(`what it reads leaves something out: "${p.textContent.slice(0, 60)}…"`);
  return bad;
}
// In the page: words cut short with an ellipsis, in what these pages draw.
function cut() {
  return [...document.querySelectorAll('.begin *, .found *, .set-pane *')]
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
  const [, weight, size] = /--f-key:(\d+) round\(([\d.]+)px/.exec(fs.readFileSync(path.join(__dirname, '../ui/src/tokens.css'), 'utf8'));
  const KEY = { size: scaled(Number(size)), weight: Number(weight) };
  const all = type && type.roles();
  const role = (key) => { const [face, sz, w, sp] = key.split(' '); return all.find((r) => r.name !== 'term' && r.face === face && r.size === Number(sz) && r.weight === w && Math.abs(r.spacing - Number(sp)) < 0.01); };
  const failures = [], notes = [];
  try {
    for (const dpr of dprs) {
      for (const [name, s] of Object.entries(shots())) {
        if (only && !only.includes(name)) continue;
        const page = await open(browser, { label: 'workspace', records: structuredClone(s.records), url: server.url, dpr, viewport: s.viewport });
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
          const own = [...await page.evaluate(begins), ...await page.evaluate(promises)], mine = await page.evaluate(() => !!document.querySelector('.hx.first > :is(.begin, .found)'));
          for (const b of [...r.bad.filter((x) => !(mine && /^first run: Open a folder/.test(x))), ...w.bad, ...own]) failures.push(`${name} (${TEXT}): ${b}`);
          for (const [key, where] of Object.entries(await page.evaluate(type.fonts))) {
            const rl = role(key), width = key.split(' ')[4];
            if (width !== '100%') failures.push(`${name} (${TEXT}): text at width ${width} (${where.slice(0, 3).join(', ')})`);
            else if (!rl) failures.push(`${name} (${TEXT}): "${key.split(' ').slice(0, 4).join(' ')}" is no role's (${where.slice(0, 3).join(', ')})`);
            for (const at of where) if (/\bkbd\b/.test(at) !== (rl?.name === 'key') && !/ring-o text/.test(at)) failures.push(`${name} (${TEXT}): ${/\bkbd\b/.test(at) ? 'a key outside the key role' : 'the key role on what is no key'} (${at})`);
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
