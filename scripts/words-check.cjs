// Settings' words (docs/trial-checklist.md, items 32 and 33, and the owner's judgement of Agents, 2026-11-22): a row of
// Settings is its label and its control or value, and no sentence of explanation stands in it. What a row means is said
// in the foot of the window, in one place of a fixed height, and only while the row has the pointer or the keyboard:
// empty at rest, the hint of the row pointed at, the hint of the row focused once the pointer is away, empty again.
// No label is one of the fragments the rows had before; no "·" is rendered anywhere in Settings or on the two sheets it
// opens; no agent has a ring in a row (the ring is for an agent's remaining usage, and no row has one); and none of the
// words a person does not use is anywhere in Settings or on the two sheets it opens, but in the core's own list of what
// is sent. On a Mac and on Windows, where nothing names a Mac's keys or its notch. This renders the workspace from
// ui/dist on fixture records, in the states that change a row's words: placing off, agreed, agreed again; speech on this
// machine in each of its states, and at a service; the update row in each of its states; an agent of the person's own,
// one removed, one signed out, the switches of Pi and Droid, every agent's row opened. Appearance is left out: the owner
// froze its words. A row that only reports (no control) needs no hint.
// usage: node scripts/words-check.cjs   (exit status 1 on a failure; ui/dist must be built)
const fs = require('node:fs');
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
const { scene, flow } = require('./instrument-fixtures.cjs');
const { projects } = require('./projects-fixtures.cjs');

/** The labels the rows had before, which did not read by themselves or did not name what the person decides. */
const OLD = ['Key to put a thought in', 'Delete finished thoughts after', 'Wait before an agent starts a thought', 'From any app', 'A sent thought starts', 'Placing', 'Return in a thought', 'Finished thoughts are kept', 'Tab at the top of the screen', 'Turned into text', 'Key',
  'Hold to talk', 'Sign-in', 'Name', 'Command', 'Font', 'Size', 'Line height', 'Bold text in bright colours', 'Keep text readable', 'Tasktap', 'Updates', 'Voice',
  'Thoughts and history', "A service's key", 'Looked', 'Where your agents have worked', 'Folders Tasktap looks in', 'Workspace'];
/** Words a person does not use (the checklist's rule): placing may stay, its row says what it is. */
const WORDS = /\b(briefs?|briefed|sessions?|harness|router|worktrees?|isolated?|cards?|look|looks|looked|looking)\b/i;
/** The one sentence of placing, in the owner's words, which says what is sent in the words of what is sent (consent.tsx PLACING_SAYS). */
const SAYS = 'A task you do not place yourself is sent with the names of your projects and sessions to the model you choose here.';
const SECTIONS = ['thoughts', 'agents', 'projects', 'voice', 'terminal', 'about'];const MB = 574_000_000;

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
    add({ id: 'pi', name: 'Pi', program: 'pi', options: [option('core/src/agents/pi.rs', 'PROJECT')] });
    add({ id: 'droid', name: 'Droid', program: 'droid', options: [option('core/src/agents/dialect.rs', 'commands')], note: 'It runs one task and ends; a follow-up goes on in a new run.' });
    add({ id: 'opencode', name: 'OpenCode', program: 'opencode', signed_in: false, checked: now - 3 * 864e5 });
    add({ id: 'goose', name: 'Goose', program: 'goose', installed: false, signed_in: null, version: null });
    add({ id: 'own-abc', name: 'My agent', program: 'my-agent', own: true, checks: false, signed_in: null });
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
    // A copy that takes no keys from other apps (a review build): no recorder, and why.
    ['no keys from other apps', () => ({ ...scene('busy'), takes: false }), ['thoughts', 'voice']], ['Windows, no keys from other apps', () => ({ ...scene('busy'), takes: false }), ['thoughts'], 'windows'],
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
    // What stands in the row as a sentence of help (an error or a status is what wants the person, and stays).
    return { label: text(r.querySelector(':scope>.t')), help: [...c.querySelectorAll(':scope>.hint:not(.err):not([role=status])')].map(text), controls: controls.length,
      buttonsOnly: controls.every((b) => b.matches('.btn')), lines: [...r.querySelectorAll(':scope>.c .line .t')].map(text) };
  }).concat([...document.querySelectorAll('.set-pane>.list .line')].map((l) => ({ label: text(l.querySelector('.t')), help: [], controls: 1, buttonsOnly: false, line: true })));
}
/** In the page: where the pointer goes to be on row `i`, and the first control of it that takes the keyboard. */
function where(i) {
  const r = [...document.querySelectorAll('.set-pane .set')][i];
  r.scrollIntoView({ block: 'nearest' });
  const b = r.getBoundingClientRect();
  return { x: b.x + 6, y: b.y + b.height / 2, control: !!r.querySelector('.c :is(button, input):not(:disabled)') };
}
const focusRow = (i) => [...document.querySelectorAll('.set-pane .set')][i].querySelector('.c :is(button, input):not(:disabled)').focus();
/** In the page: the foot's hint, null where the window has none, and the height of its place. */
const footHint = () => { const h = document.querySelector('.sheet .sh-hint'); return h ? { text: h.textContent.trim(), height: h.offsetHeight } : null; };
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
  try {
    for (const [state, records, sections, system] of states()) {
      const page = await open(browser, { label: 'workspace', records: records(), url: server.url, dpr: 1, system });
      for (const at of sections) {
        await page.evaluate((a) => ((window.__ws.ui.sheet = { kind: 'settings', at: a }), window.__motion.redraw()), at);
        await page.waitForTimeout(450);
        // The form of an agent of the person's own, and the agents folded away.
        if (at === 'agents' && state === 'agents of every kind') {
          await page.evaluate(() => [...document.querySelectorAll('.set-pane :is(.fold-l, .chev)')].forEach((b) => b.click()));
          await page.waitForTimeout(250);
        }
        if (state.startsWith('a project\'s details')) {
          const name = state.endsWith('no Git') ? 'dotfiles' : 'cuegrid';
          await page.evaluate((n) => [...document.querySelectorAll('.set-pane .line.pj')].find((b) => b.querySelector('.t')?.textContent === n)?.click(), name);
          await page.waitForTimeout(250);
          if (!await page.evaluate(() => document.querySelector('.pj-c')?.textContent.includes('Where its agent works'))) failures.add(`${state}: no Where its agent works`);
        }
        const where_ = `${state}, ${at}`;
        const found = await page.evaluate(rows);
        if (!found.some((r) => !r.line)) failures.add(`${where_}: no row`);
        // (The form of an agent of one's own, opened above, takes the keyboard to its first field: it is let go of.)
        await page.evaluate(() => document.activeElement?.blur());
        let rest = null;
        for (const [i, r] of found.entries()) {
          seen++;
          if (!r.label && !r.buttonsOnly) failures.add(`${where_}: a row has no label (${r.help[0] ?? 'and no help'})`);
          if (OLD.includes(r.label)) failures.add(`${where_}: "${r.label}" is one of the fragments the rows had before`);
          if (r.line) continue;
          for (const h of r.help) failures.add(`${where_}: a sentence of help stands in the row "${r.label}": "${h}"`);
          // The foot: empty at rest, the pointed row's hint, the focused row's hint with the pointer away, empty again.
          await page.mouse.move(2, 2);
          const none = await page.evaluate(footHint);
          if (!none) failures.add(`${where_}: no place for a hint in the foot of the window`);
          else if (none.text) failures.add(`${where_}: the foot says "${none.text}" at rest`);
          rest ??= none;
          const at = await page.evaluate(where, i);
          await page.mouse.move(at.x, at.y);
          const pointed = await page.evaluate(footHint);
          if (pointed?.text) {
            helped++;
            if (/·/.test(pointed.text)) failures.add(`${where_}: a "·" in the hint of "${r.label}"`);
            if (pointed.height !== rest?.height) failures.add(`${where_}: the foot changes height for the hint of "${r.label}" (${rest?.height} to ${pointed.height})`);
          }
          await page.mouse.move(2, 2);
          if ((await page.evaluate(footHint))?.text) failures.add(`${where_}: the hint of "${r.label}" stays after the pointer left`);
          if (at.control) {
            await page.evaluate(focusRow, i);
            const focused = await page.evaluate(footHint);
            if ((focused?.text ?? '') !== (pointed?.text ?? '')) failures.add(`${where_}: the foot says "${focused?.text}" for the keyboard on "${r.label}", "${pointed?.text}" for the pointer`);
            await page.evaluate(() => document.activeElement?.blur());
            if ((await page.evaluate(footHint))?.text) failures.add(`${where_}: the hint of "${r.label}" stays after the keyboard left`);
          }
        }
        const text = await page.evaluate(words);
        const bad = WORDS.exec(text);
        if (/·/.test(text)) failures.add(`${where_}: a "·" in Settings (…${text.slice(Math.max(0, text.indexOf('·') - 40), text.indexOf('·') + 40)}…)`);
        if (await page.evaluate(() => document.querySelectorAll('.set-pane .ring-o').length)) failures.add(`${where_}: a ring in a row of Settings`);
        if (bad) failures.add(`${where_}: "${bad[0]}" in Settings (…${text.slice(Math.max(0, bad.index - 60), bad.index + 40)}…)`);
        if (system === 'windows') {
          const mac = /[⌘⌥⌃]|\bnotch\b|\bthis Mac\b|\bmacOS\b|\bReturn\b/.exec(text);
          if (mac) failures.add(`${where_}: Windows is told "${mac[0]}" (…${text.slice(Math.max(0, mac.index - 60), mac.index + 40)}…)`);
        } else {
          const win = /\bCtrl\+|\bthis PC\b|\bEnter key\b/.exec(text);
          if (win) failures.add(`${where_}: a Mac is told "${win[0]}"`);
        }
      }
      // The two sheets Settings opens: what placing sends, and a speech service.
      if (state === 'placing agreed' || state === 'placing off') {
        for (const kind of ['placing', 'speech']) {
          await page.evaluate((k) => ((window.__ws.ui.sheet = { kind: k }), window.__motion.redraw()), kind);
          await page.waitForTimeout(450);
          sheets++;
          const text = (await page.evaluate(words)).replace(SAYS, ''), bad = WORDS.exec(text);
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
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.size ? `FAIL  Settings' words: ${failures.size} rows or words outside the rule`
    : `PASS  ${seen} rows of Settings in ${states().length} states, on a Mac and on Windows: each with a label that is none of the ${OLD.length} fragments it replaced and no sentence in it, ${helped} hints that the foot says only while their row has the pointer or the keyboard, no "·" and no ring, and none of the words a person does not use, here or on ${sheets} sheets it opens`);
  process.exitCode = failures.size ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
