// Renders what Tasktap knows of a person's projects (ui/src/workspace/projects.tsx) from ui/dist in headless Chromium,
// on fixture records (projects-fixtures.cjs), no host: the first run, Setup's first step as its sheet (the agents'
// history offered, what exactly is read opened, what was found filling in and done, the folder most of them are in
// suggested, a person with no agent history; design/ui-directions/NOTES.md §13) and Settings ›
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
    'first-details': { records: projects('first-agents'), act: both(wait(300), (p) => p.click('.sheet .more-l')) },
    'first-filling': { records: projects('first-found'), act: both(allow, wait(440)), settle: 0 },
    'first-found': { records: projects('first-found'), act: both(allow, wait(1400)) },
    'first-found-narrow': { records: projects('first-found'), act: both(allow, wait(1400)), viewport: NARROW },
    'first-many': { records: projects('first-many'), act: both(allow, wait(4000)) },
    // The list of all of them, scrolled by the wheel: it dissolves at both edges, and Home stays where it is.
    'first-many-scrolled': { records: projects('first-many'), act: both(allow, wait(4000), (p) => p.hover('.found > .fr-s'), (p) => p.mouse.wheel(0, 100)) },
    'first-many-narrow': { records: projects('first-many'), act: both(allow, wait(4000)), viewport: NARROW },
    'first-folders': { records: projects('first-folders') },
    'first-folders-narrow': { records: projects('first-folders'), viewport: NARROW },
    // A search in a folder that found nothing says why, in the sheet and in Setup's line, with the way to another folder.
    'first-denied': { records: projects('first-searched', { end: { state: 'denied', note: 'Operation not permitted' } }), act: allow,
      says: ['Tasktap may not read git', 'macOS keeps Tasktap out of ~/git. Allow Tasktap under System Settings › Privacy & Security › Files and Folders, then search git again.', 'Choose another folder…'],
      setup: 'Tasktap may not read git' },
    'first-denied-windows': { records: projects('first-searched', { end: { state: 'denied', note: 'Access is denied.' } }), act: allow, system: 'windows',
      says: ['Tasktap may not read git', 'Windows keeps Tasktap out of ~/git. Search git again once your account may read it.', 'Choose another folder…'] },
    // A folder's own rights (EACCES) are a read error like any other, in the system's words; `denied` is its privacy rule.
    'first-unreadable': { records: projects('first-searched', { end: { state: 'failed', note: 'Permission denied' } }), act: allow,
      says: ['git could not be read', '~/git: Permission denied.', 'Choose another folder…'], setup: 'git could not be read' },
    'first-too-many': { records: projects('first-searched', { end: { state: 'many' } }), act: allow,
      says: ['Too many folders in git', 'Over 5,000 folders in ~/git. Choose the folder inside git that holds your projects.', 'Choose another folder…'], setup: 'Too many folders in git' },
    'first-gone': { records: projects('first-searched', { end: { state: 'gone' } }), act: allow,
      says: ['git is not there now', 'Nothing is at ~/git now. Tasktap searches git again when git is back.', 'Choose another folder…'], setup: 'git is not there now' },
    'first-none': { records: projects('first-searched', { end: { state: 'ready' } }), act: allow,
      says: ['Found no projects in git', 'A folder counts as a project when it has Git or a package file in it, or when an agent worked there.', 'Choose another folder…'],
      setup: 'Found no projects in git' },
    // Choose another folder… asks the system's folder panel, searches the folder chosen there, and speaks of that one.
    'first-another': { records: { ...projects('first-searched', { end: { state: 'ready' } }), pick: '/Users/someone/code' },
      act: both(allow, wait(600), (p) => p.click('.found-s .btn'), wait(600)), says: ['Found no projects in code'], unsaid: ['in git'], setup: 'Found no projects in code' },
    // A search that stopped at its budget keeps what it found, and says it stopped.
    'first-stopped': { records: projects('first-searched', { some: 3, end: { state: 'ready', note: 'Tasktap searched the first 5,000 folders in git and stopped there. Add the folder inside git that holds the rest of your projects.' } }),
      act: both(allow, wait(800)), says: ['Found 3 projects', 'Tasktap searched the first 5,000 folders in git and stopped there.'] },
    'settings': { records: projects('settings'), act: settings },
    'settings-narrow': { records: projects('settings'), act: settings, viewport: NARROW },
    'settings-list': { records: projects('settings'), act: both(settings, wait(300), scrollTo('.set-pane .field', 40)) },
    'settings-open': { records: projects('settings-open'), act: both(settings, wait(300), (p) => p.click('.line.pj >> text=cuegrid'), wait(200), scrollTo('.line.pj[aria-expanded=true]', 40)) },
    'settings-open-narrow': { records: projects('settings-open'), viewport: NARROW, act: both(settings, wait(300), (p) => p.click('.line.pj >> text=cuegrid'), wait(200), scrollTo('.line.pj[aria-expanded=true]', 40)) },
    // Settings says what the first run's sheet says of a search that found nothing.
    'settings-gone': { records: projects('settings-gone'), act: settings,
      says: ['Too many folders in Downloads', 'Over 5,000 folders in ~/Downloads. Choose the folder inside Downloads that holds your projects.',
        'Found no projects in src', 'A folder counts as a project when it has Git or a package file in it, or when an agent worked there.',
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
  if (document.querySelector('.hx.first > :not(.capture, .setup, .cols)')) bad.push('first run: something stands loose under the Composer that is not Setup');
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
  const bad = [], cards = [...window.__ws.records.cards.values()].filter((c) => !c.copy_of && !c.inside && !c.hidden);
  const text = (sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent).join(' ');
  if (/\band \d+ more\b/i.test(text('.found, .set-pane'))) bad.push('a list of projects says "and N more"');
  const found = document.querySelector('.sheet .found .fr-s');
  if (found && document.querySelectorAll('.found .fr').length !== cards.length) bad.push(`the first run shows ${document.querySelectorAll('.found .fr').length} of ${cards.length} projects found`);
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
/** What Setup's line for the projects says once the sheet is put away by Done and Setup is open. */
async function setupSays(page) {
  await page.click('.sheet .sh-f .key');
  await page.waitForTimeout(300);
  if (await page.$('.setup .fold-h[aria-expanded=false]')) await page.click('.setup .fold-h');
  return page.textContent('.setup .line.st[data-step=projects] .x');
}
/** Opens Settings' "What exactly is read" as a person does, by the pointer on it, before the promises are read. */
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
  return [...document.querySelectorAll('.sheet *, .setup *, .set-pane *')]
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
          const line = s.setup && await setupSays(page);
          if (line !== s.setup) failures.push(`${name} (${TEXT}): Setup's line says "${line}", not "${s.setup}"`);
          for (const b of [...r.bad, ...w.bad, ...own]) failures.push(`${name} (${TEXT}): ${b}`);
          for (const [key, where] of Object.entries(await page.evaluate(type.fonts))) {
            const rl = role(key, where.some((w) => /\bkbd\b/.test(w))), width = key.split(' ')[4];
            if (width !== '100%') failures.push(`${name} (${TEXT}): text at width ${width} (${where.slice(0, 3).join(', ')})`);
            else if (!rl) failures.push(`${name} (${TEXT}): "${key.split(' ').slice(0, 4).join(' ')}" is no role's (${where.slice(0, 3).join(', ')})`);
            for (const at of where) if (/\bkbd\b/.test(at) !== (role(key, /\bkbd\b/.test(at))?.name === 'key') && !/ring-o text/.test(at)) failures.push(`${name} (${TEXT}): ${/\bkbd\b/.test(at) ? 'a key outside the key role' : 'the key role on what is no key'} (${at})`);
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
