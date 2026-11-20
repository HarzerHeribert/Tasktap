// Settings' words (docs/trial-checklist.md, items 32 and 33): every row in every section has a label that reads by
// itself and one sentence under it of what changes for the person, about twenty words; no label is one of the
// fragments the rows had before; and none of the words a person does not use is anywhere in Settings or on the two
// sheets it opens, but in the core's own list of what is sent. On a Mac and on Windows, where nothing names a Mac's
// keys or its notch. This renders the workspace from ui/dist on fixture records, in the states that change a row's
// words: placing off, agreed, agreed again; speech on this machine in each of its states, and at a service; the update
// row in each of its states; an agent of the person's own, one removed, one signed out, the switches of Pi and Droid.
// Appearance is left out: the owner froze its words. A row that only reports (no control) needs no sentence; nor does
// a licence, whose words are behind its own line, or the row of a form's buttons.
// usage: node scripts/words-check.cjs   (exit status 1 on a failure; ui/dist must be built)
const fs = require('node:fs');
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
const { scene, flow } = require('./instrument-fixtures.cjs');
const { projects } = require('./projects-fixtures.cjs');

/** The labels the rows had before, which did not read by themselves or did not name what the person decides. */
const OLD = ['From any app', 'A sent thought starts', 'Placing', 'Return in a thought', 'Finished thoughts are kept', 'Tab at the top of the screen', 'Turned into text', 'Key',
  'Hold to talk', 'Sign-in', 'Name', 'Command', 'Font', 'Size', 'Line height', 'Bold text in bright colours', 'Keep text readable', 'Tasktap', 'Updates', 'Voice',
  'Thoughts and history', "A service's key", 'Looked', 'Where your agents have worked', 'Folders Tasktap looks in', 'Workspace'];
/** Words a person does not use (the checklist's rule): placing may stay, its row says what it is. */
const WORDS = /\b(briefs?|briefed|sessions?|harness|router|worktrees?|isolated?|cards?|look|looks|looked|looking)\b/i;
const SECTIONS = ['thoughts', 'agents', 'projects', 'voice', 'terminal', 'about'];
const MB = 574_000_000;

/** An agent's switch as the core words it, from its own source: what the row shows. */
function option(file, id) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const m = new RegExp(`id: "?${id}"?,\\s*name: "([^"]+)",\\s*allows: "((?:[^"\\\\]|\\\\\\n\\s*)+)"`).exec(src);
  if (!m) throw new Error(`no switch ${id} in ${file}`);
  return { id, name: m[1], allows: m[2].replace(/\\\n\s*/g, '') };
}

function states() {
  const busy = () => scene('busy');
  const agreed = () => flow(scene('normal'), 'plain');
  const speech = (s) => () => ({ ...scene('busy'), speech: { supported: true, have: 0, of: MB, error: null, ...s } });
  const update = (u) => () => ({ ...scene('busy'), update: u });
  const agents = () => {
    const r = scene('busy'), now = Date.now(), base = r.agents[0];
    const add = (o) => r.agents.push({ ...base, rev: 6, identity: null, version: '1.0.0', ...o });
    add({ id: 'pi', name: 'Pi', options: [option('core/src/agents/pi.rs', 'PROJECT')] });
    add({ id: 'droid', name: 'Droid', options: [option('core/src/agents/dialect.rs', 'commands')], note: 'It runs one task and ends; a follow-up goes on in a new run.' });
    add({ id: 'opencode', name: 'OpenCode', signed_in: false, checked: now - 3 * 864e5 });
    add({ id: 'goose', name: 'Goose', installed: false, signed_in: null, version: null });
    add({ id: 'own-abc', name: 'My agent', own: true, checks: false, signed_in: null });
    r.prefs = [...r.prefs.filter((p) => p.id !== 'own_agents'), { id: 'own_agents', rev: 7, value: [{ id: 'own-abc', name: 'My agent', command: 'my-agent {prompt}', removed: false }, { id: 'own-old', name: 'Old one', command: 'old {prompt}', removed: true }] }];
    return r;
  };
  const tab = (display) => () => ({ ...scene('busy'), tab: { display, displays: [{ name: '\\\\.\\DISPLAY1', primary: true, width: 2560, height: 1440 }, { name: '\\\\.\\DISPLAY2', primary: false, width: 1920, height: 1080 }] } });
  return [
    ['placing off', busy, SECTIONS], ['placing agreed', agreed, ['projects', 'about', 'voice']],
    ['placing agreed before', () => { const r = agreed(); r.prefs = r.prefs.map((p) => (p.id === 'route_by' ? { ...p, value: { ...p.value, terms: 2 } } : p)); return r; }, ['projects']],
    ['no agent can place', () => ({ ...scene('busy'), tools: [] }), ['projects']],
    ...[['none', {}], ['part', { have: MB / 4 }], ['fetching', { model: 'fetching', have: MB / 3 }], ['failed', { model: 'failed', have: MB / 3, error: 'No network: the model could not be fetched' }], ['ready', { model: 'ready', have: MB }], ['unsupported', { supported: false }]]
      .map(([name, s]) => [`speech here ${name}`, speech({ model: 'none', ...s }), ['voice', 'about']]),
    ...[['off'], ['current', '1.3.0'], ['available', '1.3.0'], ['downloading', '1.3.0'], ['installing', '1.3.0'], ['failed', '1.3.0']]
      .map(([state, version]) => [`update ${state}`, update({ state, version, notes: '', percent: 40, why: 'GitHub could not be reached' }), ['about']]),
    // The person turned off asking by itself: never checked, checking once at their word, and found nothing newer.
    ...[['unknown'], ['looking'], ['current', '1.3.0'], ['available', '1.3.0']].map(([state, version]) => [`update ${state}, asking by itself off`, () => {
      const r = update({ state, version, notes: '', percent: 40, why: '' })();
      r.prefs = [...(r.prefs || []), { id: 'update_checks', rev: 9, value: false }];
      return r;
    }, ['about']]),
    ['agents of every kind', agents, ['agents']],
    // A project's details opened: where its agent works, with Git and without.
    ['a project\'s details', () => projects('settings'), ['projects']], ['a project\'s details, no Git', () => projects('settings'), ['projects']],
    ['finished thoughts kept 30 days, a key kept', () => { const r = flow(scene('busy'), 'plain'); r.prefs.push({ id: 'keep_days', rev: 9, value: 30 }, { id: 'hold', rev: 9, value: 0 }, { id: 'return_sends', rev: 9, value: false }); return r; }, ['thoughts', 'about', 'voice']],
    ['the capture key taken', () => ({ ...scene('busy'), capture: null }), ['thoughts']],
    // Opening at login, in each state the system can be in, and each copy that cannot.
    ...[{ state: 'off' }, { state: 'on' }, { state: 'approve' }, ...['review', 'check', 'unsigned'].map((why) => ({ state: 'unavailable', why }))]
      .map((login) => [`opening at login ${login.state}${login.why ? `, ${login.why}` : ''}`, () => ({ ...scene('busy'), login }), ['thoughts']]),
    ...[{ state: 'off' }, { state: 'on' }, { state: 'unavailable', why: 'uninstalled' }]
      .map((login) => [`Windows, opening at login ${login.state}`, () => ({ ...scene('busy'), login }), ['thoughts'], 'windows']),
    ['Windows, opening at login, no tab', () => ({ ...tab('off')(), login: { state: 'on' } }), ['thoughts'], 'windows'],
    ['Windows', busy, SECTIONS, 'windows'], ['Windows, the tab on Display 2', tab('\\\\.\\DISPLAY2'), ['thoughts'], 'windows'],
    ['Windows, no tab', tab('off'), ['thoughts'], 'windows'], ['Windows, the tab where last opened', tab('pointer'), ['thoughts'], 'windows'],
  ];
}

// In the page: every row of the section shown, as the rule reads it.
function rows() {
  const text = (e) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return [...document.querySelectorAll('.set-pane .set')].map((r) => {
    const c = r.querySelector(':scope>.c');
    const controls = [...c.querySelectorAll('button, input, [role=radio], [role=switch], .rec')].filter((b) => !b.matches('.disc, .disc *'));
    return { label: text(r.querySelector(':scope>.t')), help: [...c.querySelectorAll(':scope>.hint:not(.err)')].map(text), controls: controls.length,
      buttonsOnly: controls.every((b) => b.matches('.btn')), lines: [...r.querySelectorAll(':scope>.c .line .t')].map(text) };
  }).concat([...document.querySelectorAll('.set-pane>.list .line')].map((l) => ({ label: text(l.querySelector('.t')), help: ['(a line of a list)'], controls: 1, buttonsOnly: false, line: true })));
}
// In the page: what a person reads in the sheet, and what a control says to a screen reader, but the core's list of
// what is sent and the instructions it gives a model.
function words() {
  const sheet = document.querySelector('.sheet');
  if (!sheet) return '';
  const copy = sheet.cloneNode(true);
  copy.querySelectorAll('.sends, .instr, datalist').forEach((e) => e.remove());
  const said = [...copy.querySelectorAll('[aria-label], [title], [placeholder]')].map((e) => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('placeholder')].filter(Boolean).join(' '));
  return `${copy.textContent} ${said.join(' ')}`.replace(/\s+/g, ' ');
}

async function main() {
  const { chromium } = require('playwright');
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true });
  const failures = new Set();
  let seen = 0, helped = 0, sheets = 0;
  const longest = { n: 0, at: '' };
  try {
    for (const [state, records, sections, system] of states()) {
      const page = await open(browser, { label: 'workspace', records: records(), url: server.url, dpr: 1, system });
      for (const at of sections) {
        await page.evaluate((a) => ((window.__ws.ui.sheet = { kind: 'settings', at: a }), window.__motion.redraw()), at);
        await page.waitForTimeout(450);
        // The form of an agent of the person's own, and the agents folded away.
        if (at === 'agents' && state === 'agents of every kind') {
          await page.evaluate(() => [...document.querySelectorAll('.set-pane .fold-l')].forEach((b) => b.click()));
          await page.waitForTimeout(250);
        }
        if (state.startsWith('a project\'s details')) {
          const name = state.endsWith('no Git') ? 'dotfiles' : 'cuegrid';
          await page.evaluate((n) => [...document.querySelectorAll('.set-pane .line.pj')].find((b) => b.querySelector('.t')?.textContent === n)?.click(), name);
          await page.waitForTimeout(250);
          if (!await page.evaluate(() => document.querySelector('.pj-c')?.textContent.includes('Where its agent works'))) failures.add(`${state}: no Where its agent works`);
        }
        const where = `${state}, ${at}`;
        const found = await page.evaluate(rows);
        if (!found.some((r) => !r.line)) failures.add(`${where}: no row`);
        for (const r of found) {
          seen++;
          if (!r.label && !r.buttonsOnly) failures.add(`${where}: a row has no label (${r.help[0] ?? 'and no help'})`);
          if (OLD.includes(r.label)) failures.add(`${where}: "${r.label}" is one of the fragments the rows had before`);
          if (r.line) continue;
          if (r.controls && !(r.buttonsOnly && !r.label) && r.help.length !== 1) failures.add(`${where}: "${r.label}" has ${r.help.length} sentences of help under it, not one`);
          for (const h of r.help) {
            helped++;
            const ends = (h.match(/[.!?](?=\s|$)/g) ?? []).length, n = h.split(' ').length;
            if (ends !== 1 || !/[.!?]$/.test(h)) failures.add(`${where}: the help of "${r.label}" is not one sentence: "${h}"`);
            if (n > 26) failures.add(`${where}: the help of "${r.label}" is ${n} words, not about twenty: "${h}"`);
            if (n > longest.n) Object.assign(longest, { n, at: `${r.label}: ${h}` });
          }
        }
        const text = await page.evaluate(words);
        const bad = WORDS.exec(text);
        if (bad) failures.add(`${where}: "${bad[0]}" in Settings (…${text.slice(Math.max(0, bad.index - 60), bad.index + 40)}…)`);
        if (system === 'windows') {
          const mac = /[⌘⌥⌃]|\bnotch\b|\bthis Mac\b|\bmacOS\b|\bReturn\b/.exec(text);
          if (mac) failures.add(`${where}: Windows is told "${mac[0]}" (…${text.slice(Math.max(0, mac.index - 60), mac.index + 40)}…)`);
        } else {
          const win = /\bCtrl\+|\bthis PC\b|\bEnter key\b/.exec(text);
          if (win) failures.add(`${where}: a Mac is told "${win[0]}"`);
        }
      }
      // The two sheets Settings opens: what placing sends, and a speech service.
      if (state === 'placing agreed' || state === 'placing off') {
        for (const kind of ['placing', 'speech']) {
          await page.evaluate((k) => ((window.__ws.ui.sheet = { kind: k }), window.__motion.redraw()), kind);
          await page.waitForTimeout(450);
          sheets++;
          const text = await page.evaluate(words), bad = WORDS.exec(text);
          if (bad) failures.add(`${state}, the ${kind} sheet: "${bad[0]}" (…${text.slice(Math.max(0, bad.index - 60), bad.index + 40)}…)`);
        }
      }
      for (const e of page.errors) failures.add(`${state}: page: ${e}`);
      await page.context().close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(`longest help: ${longest.n} words (${longest.at})`);
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.size ? `FAIL  Settings' words: ${failures.size} rows or words outside the rule`
    : `PASS  ${seen} rows of Settings in ${states().length} states, on a Mac and on Windows: each with a label that is none of the ${OLD.length} fragments it replaced, ${helped} sentences of help of one sentence each, and none of the words a person does not use, here or on ${sheets} sheets it opens`);
  process.exitCode = failures.size ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
