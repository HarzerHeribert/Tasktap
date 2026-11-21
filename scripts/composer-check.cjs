// The Composer's field belongs to the person at every moment (ui/src/capture.tsx, way.ts `leave`). Headless, from
// ui/dist on fixture records, with real keys, against a stand-in core that answers a capture late or refuses it. It
// fails when
// - a key typed while a capture is on its way to the core is refused, lost or out of order, or what was typed then is
//   not the beginning of the next thought once the capture has arrived;
// - Return pressed twice sends the thought twice, or starts another thought that waits;
// - ⌘Z pressed while a capture is on its way does not bring its words back once it has arrived;
// - the words of a capture the core refuses are not back in the field, before what was typed since;
// - on Home, in the capture sheet or in the notch, a render that changed neither the field's words nor its width
//   measures the field (which makes the page lay itself out there and then), or the field does not grow and shrink a
//   line at a time up to its most lines, or does not follow its width;
// - where a thought goes (docs/projects-design.md, "What is there today" and the owner's decisions): a project Tasktap
//   knows and has not opened is a row of the list unasked, is not found by its own field, or a pick of one is not sent
//   by its card; a name said as speech writes it is not said so on the chip; the folder of a workspace the capture sheet
//   was opened in holds after that sheet is put away, or on Home's own Composer; the newest thought's folder, or
//   Scratch, is a default anywhere; the chip does not say where the thought goes and why in its few words, or its list
//   has no Scratch, or marks no row or another than the chip says; a pick holds for more than its thought, or the chip
//   goes back from it without saying so; or what is sent is not what the chip said;
// - after the owner's first trial and its independent review (design/ui-directions/NOTES.md §13, docs/trial-checklist.md
//   R1–R15): the question about a thought just sent is not asked once, at the Composer it was sent from (Home's, the
//   New Task sheet's, the notch's), with the field keeping the keyboard; its rows are not numbered 1 to 5 with no
//   letters; a number, the arrows and Return do not answer it while the field is empty; Return answers it within 600 ms
//   of its coming, or a key held down does; a letter typed after it came is lost or answers it, or it stays at the
//   Composer; Escape, Tab or leaving Home does not leave it in Needs you with the field's keyboard; the metal key does
//   not say and do what Return does; a placed thought is not one line with its brief behind a closed disclosure; Undo
//   shows ⌘Z while the field holds words; the notch shows caps without the keyboard; the first start's sheet is not in
//   Home's first picture, comes after a key or a click, takes a key within 600 ms of another, swallows the letters
//   typed at it, or is not Not now when put away by a click beside it, ⌘O or Escape; Setup does not say "Setup · n of
//   3 done" with its actions quiet on one edge, or Hide drops the keyboard or does not say where Setup went; the agent
//   control has no key ⌘J, Tab does not reach the foot's controls, "co" does not put Codex first, or a signed-out usual
//   agent keeps the list shut; the chip's reason is cut; or a real pointer's click on "Open another folder…" or a
//   project in the chip's list does not land (also in WebKit, the Mac's engine, where Playwright's WebKit is installed:
//   at a desk without it a NOTE says what was not tried; where CI is set a missing WebKit is a failure);
// - the empty field's line (lines.ts): a fresh start does not show "What's next?" on Home, in the New Task sheet and in
//   the notch, or the notch opened again does not show the next line; the line does not roll to the next about every 5 s with the field empty, holding the keyboard, the window
//   in front and the effects Full, or its roll is seen by a screen reader or changes the field's name; a timer runs, or
//   anything moves, with the window behind, the keyboard elsewhere, words in the field, a dictation, a composition, the
//   effects at Still or Off, or Reduce Motion, or the roll does not start again once that is over; a task handed off
//   does not show the next line, or shows it with a roll at Still, Off or Reduce Motion; the line with the key held to
//   talk does not say the key as set (as Windows names it there), or is there without voice; or a line is wider than
//   the notch's field at any text size.
// Every step waits for what it acts on or reads by the page, never for a fixed time; SLOW_CORE (ms) makes the stand-in
// core answer that much later and CPU_THROTTLE (n) runs the Chromium pages n times slower, to prove it.
// usage: [SLOW_CORE=400] [CPU_THROTTLE=6] node scripts/composer-check.cjs [--dist folder] [--review]   (ui/dist must be built)
const path = require('node:path');
const { serve, open: openPage, findCore } = require('./motion-pages.cjs');
// Every page of the check, with a watch on each Composer's chip (Home's, New Task's, the notch's): once there, it
// leaves its Composer only while something else has the foot's row (the list of places, the agents, the recording),
// never while its words change; a moment without it, after a render, is a click a person could miss.
const chipGone = [];
// A page of the check that starts over by itself (a form sent by the browser, the bridge reopened): never wanted.
const restarted = [];
const CHIP_WATCH = `addEventListener('submit', (e) => queueMicrotask(() => console.info('submit ' + e.target.className + (e.defaultPrevented ? ', kept by the page' : ', NOT kept by the page'))));
addEventListener('DOMContentLoaded', () => new MutationObserver(() => {
  for (const cap of document.querySelectorAll('form.capture')) {
    if (cap.querySelector('#dest-chip')) cap.dataset.hadChip = '';
    else if ('hadChip' in cap.dataset && !cap.querySelector('.cap-row.cap-list, .cap-row.hear')) console.info('chip-gone ' + cap.outerHTML.replace(/\\s+/g, ' ').slice(0, 300));
  }
}).observe(document.body, { subtree: true, childList: true }));`;
async function open(browser, o) {
  const page = await openPage(browser, { ...o, init: [CHIP_WATCH, typeof o.init === 'string' ? o.init : ''].join(';\n') });
  page.on('console', (m) => m.text().startsWith('chip-gone ') && chipGone.push(m.text().slice(10)));
  // (With the last form the browser was asked to send, and whether the page kept it: a form sent is a page loaded.)
  let submitted = 'none';
  page.on('console', (m) => m.text().startsWith('submit ') && (submitted = m.text().slice(7)));
  page.on('request', (r) => r.isNavigationRequest() && r.frame() === page.mainFrame() && restarted.push(`the ${o.label} page started over by itself: ${r.method()} ${r.url()}; the last form sent: ${submitted}`));
  // Home with what the core holds (unless a step times the records itself, `subMs`): before it, the chip says that no
  // project is known yet, and a click on it opens a folder, as it should.
  if (o.label === 'workspace' && !o.records?.subMs) await page.waitForFunction(() => window.__ws?.ui.ready, null, { timeout: 15000 }).catch(() => {});
  return page;
}
const { scene, flow } = require('./instrument-fixtures.cjs');
const dist = path.resolve(process.argv.includes('--dist') ? process.argv[process.argv.indexOf('--dist') + 1] : path.join(__dirname, '../ui/dist'));
const GEO = { do: 'geometry', width: 104, height: 16, cutout: false, surfaceWidth: 420, surfaceOffset: 0, span: 560, pixel: 1, corner: 10, offset: 0, available: 700, collapsed: false };
const FIELD = '#capture-input';
const REVIEW = process.argv.includes('--review');

async function main() {
  const { chromium } = require('playwright');
  // The list's field finds what the core's own code finds (core/examples/find.rs), not a stand-in's.
  findCore();
  const server = await serve(dist), browser = await chromium.launch({ headless: true }), failures = [];
  const expect = (ok, what) => ok || failures.push(what);
  // A value the page shows in its own time (an answer of the core, a render), read until it is what is wanted, at the
  // page's pace, or for 15 s: never once after a fixed wait, which a slow machine or a slow core outruns.
  const until = async (read, ok, ms = 15000) => {
    const end = Date.now() + ms;
    let v = await read();
    while (!ok(v) && Date.now() < end) (await new Promise((r) => setTimeout(r, 50)), (v = await read()));
    return v;
  };
  // An element the next step acts on, waited for by the page (there, shown, enabled, still), never for a fixed time:
  // a slow machine takes longer, and means the same. If it never comes, the failure says what the Composer showed.
  const shown = (page) => page.evaluate(() => (document.querySelector('.sheet[role=dialog] .capture') ?? document.querySelector('.capture') ?? document.body).outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').replace(/\s+/g, ' ').slice(0, 1500)).catch(() => '(the page is gone)');
  const whenThere = async (page, target, what) => {
    const at = typeof target === 'string' ? page.locator(target).first() : target;
    const ok = await at.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false);
    if (!ok) failures.push(`there is no ${what} to act on after 15 s; the Composer showed: ${await shown(page)}`);
    return ok ? at : null;
  };
  const clickWhenThere = async (page, target, what) => {
    const at = await whenThere(page, target, what);
    return !!at && at.click({ timeout: 15000 }).then(() => true, async () => (failures.push(`${what} would not take a click in 15 s; the Composer showed: ${await shown(page)}`), false));
  };
  /** WebKit is not there for Playwright: a NOTE at a desk, a failure where CI is set, which must try the Mac's engine. */
  const noWebKit = (what) => (process.env.CI ? failures.push(`WebKit is not installed for Playwright, so ${what}`) : console.log(`NOTE  WebKit is not installed for Playwright: ${what}`));
  // Home, with a thought that waits (held) and a core that answers as `core` says.
  const home = async (core) => {
    const page = await open(browser, { label: 'workspace', records: { ...flow(scene('normal'), 'held'), ...core }, url: server.url, dpr: 1 });
    await page.focus(FIELD);
    return page;
  };
  const value = (page) => page.inputValue(FIELD);
  const calls = (page, name) => page.evaluate((n) => window.__fake.calls.filter((c) => c === n).length, name);
  try {
    // `--review`: the review's rules alone (the last part), for trying each by breaking it.
    if (!REVIEW) {
    // Typing through a capture, and Return twice.
    let page = await home({ slow: 500 });
    await page.keyboard.type('first thought');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('and the next');
    const through = await until(() => value(page), (v) => v === 'and the next');
    expect(through === 'and the next', `typed while a capture was on its way: the field holds "${through}", not "and the next"`);
    await page.waitForTimeout(800);
    expect((await value(page)) === 'and the next', `after the capture arrived the field holds "${await value(page)}", not what was typed meanwhile`);
    expect((await calls(page, 'thought.capture')) === 1 && (await page.evaluate(() => window.__fake.sent.text)) === 'first thought', 'Return twice: the thought was not captured once, as it was typed');
    expect((await calls(page, 'thought.start')) === 0, 'Return twice: the second started the thought that waited');
    await page.context().close();

    // ⌘Z while the capture is on its way: its record arrives before its answer, as the core sends them.
    page = await home({ slow: 500 });
    await page.keyboard.type('take this back');
    await page.keyboard.press('Enter');
    await page.evaluate(() => {
      const like = window.__fake.records.thoughts.find((t) => t.phase === 'routed'), sent = window.__fake.sent;
      window.__fake.push({ t: 'change', rev: 9000, sets: [{ c: 'thoughts', put: [{ ...like, id: sent.id, text: sent.text, brief: sent.text, rev: 9000, created: Date.now(), hold_until: Date.now() + 5000 }] }] });
    });
    await page.keyboard.press('Meta+z');
    expect((await value(page)) === '', `⌘Z while a capture was on its way changed the field to "${await value(page)}" before it had arrived`);
    await until(async () => [await value(page), await calls(page, 'thought.stop')], ([v, n]) => v === 'take this back' && n === 1);
    expect((await value(page)) === 'take this back' && (await calls(page, 'thought.stop')) === 1, `⌘Z while a capture was on its way: the field holds "${await value(page)}", not the thought taken back`);
    await page.context().close();

    // A capture the core refuses.
    page = await home({ slow: 300, refuse: 'The core could not take it' });
    await page.keyboard.type('keep these words');
    await page.keyboard.press('Enter');
    await page.keyboard.type('and these');
    await page.waitForTimeout(600);
    expect((await value(page)) === 'keep these words\nand these', `a refused capture: the field holds ${JSON.stringify(await value(page))}`);
    expect((await page.locator('.capture .way.failed').textContent().catch(() => '')).includes('could not take it'), 'a refused capture: the core\'s sentence is not shown under the field');
    await page.context().close();

    // Where it goes: the chip's words, the row its list marks, and what is sent.
    {
      const r = scene('normal'), P = r.ids.projects, now = Date.now();
      // Scratch is open, and the newest thought reached it: by hand, or by a router that offered it.
      r.projects = r.projects.map((p) => (p.id === P.scratch ? { ...p, open: true } : p));
      const last = r.thoughts.reduce((a, b) => (a.created > b.created ? a : b));
      r.thoughts = [...r.thoughts, { ...last, id: '019a8b6c-7d10-7000-8000-00000000f00d', project_id: P.scratch, session_id: null, phase: 'done', status: 'done', live: false, created: now, updated: now }];
      r.hints = {
        'fix the export in ledger-api': { confidence: 'clear', to: { project: P.ledger }, brief: 'fix the export in ledger-api' },
        'and the timer too': { confidence: 'clear', to: { session: r.ids.timer.session }, brief: 'and the timer too' },
        'move the timer from cuegrid to fieldnotes': { confidence: 'ambiguous', prompt: 'Where should this go?', candidates: [{ label: 'cuegrid', to: { project: P.cuegrid } }, { label: 'fieldnotes', to: { project: P.fieldnotes } }] },
      };
      // Clicked with the pointer, as a person clicks: Chromium's click focuses the chip, which the list then replaces.
      const exact = (name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
      const click = async (page, at, name) => {
        const target = name ? page.locator(at).filter({ hasText: exact(name) }) : page.locator(at);
        await clickWhenThere(page, target.first(), `${name ? `"${name}" in ` : ''}${at}`);
        await page.waitForTimeout(150);
      };
      // The core has said which places the thought's words describe (projects.find), and the list shows its answer.
      const described = (page) => page.waitForFunction(() => { const c = window.__speech.cap; return !!c.found?.thought && c.found.text === c.draft.trim(); }, null, { timeout: 15000 }).catch(() => {});
      const focused = (page) => page.evaluate(() => (document.activeElement?.closest('.cap-list') ? 'the list' : document.activeElement?.id || document.activeElement?.tagName));
      const chip = (page, at = '') => page.evaluate((s) => [...document.querySelectorAll(`${s}#dest-chip > b, ${s}#dest-chip > span`)].map((e) => e.textContent).join(' · '), at);
      // The list's rows by their names, the one marked with a star; the list is put away again.
      const rows = async (page, at = '') => {
        await click(page, `${at}#dest-chip`);
        await whenThere(page, `${at}.cap-list > button`, `${at || 'Home '}: the chip's list`);
        const all = await page.evaluate((s) => [...document.querySelectorAll(`${s}.cap-list > button`)].map((b) => (b.getAttribute('aria-selected') === 'true' ? '*' : '') + (b.querySelector('span')?.textContent ?? b.textContent)), at);
        const into = await focused(page);
        expect(all.length > 0 && into === 'the list', `${at || 'Home '}: a click on the chip leaves ${all.length ? 'the list without the keyboard' : 'no list open'} (the keyboard is on ${into})`);
        await page.keyboard.press('Escape');
        const back = await until(() => focused(page), (v) => v === 'capture-input');
        expect(back === 'capture-input', `${at || 'Home '}: Escape in the list leaves the keyboard on ${back}, not the field`);
        return all.join(', ');
      };
      const says = async (page, words, where, at = '') => {
        const now = await until(() => chip(page, at), (v) => v === words);
        expect(now === words, `${where}: the chip says "${now}", not "${words}"`);
      };
      const marks = async (page, row, where, at = '') => {
        const all = await rows(page, at), marked = all.split(', ').filter((x) => x.startsWith('*'));
        expect(marked.length === 1 && marked[0] === `*${row}`, `${where}: the list marks ${marked.join(' and ') || 'no row'}, not "${row}" (${all})`);
        expect(all.split(', ').includes('Scratch') || all.split(', ').includes('*Scratch'), `${where}: the list has no Scratch to choose (${all})`);
      };
      // Typed, and the core asked where it would go and answered (the page's own hint for the words in the field).
      const typed = async (page, text) => {
        await page.keyboard.type(text);
        await page.waitForFunction(() => { const c = window.__speech?.cap; return !c || !c.draft.trim() || c.hint?.text === c.draft.trim(); }, null, { timeout: 15000 }).catch(() => {});
      };
      // What the last Return sent: the next capture the core was asked for, once it was asked.
      const capturesSeen = new WeakMap();
      const sent = async (page) => {
        const n = await until(() => calls(page, 'thought.capture'), (v) => v > (capturesSeen.get(page) ?? 0), 5000);
        capturesSeen.set(page, n);
        return page.evaluate(() => window.__fake.sent);
      };

      // Home: nothing chosen and no model agreed to; Scratch is not the default though the newest thought is there.
      page = await open(browser, { label: 'workspace', records: structuredClone(r), url: server.url, dpr: 1 });
      await says(page, 'Tasktap decides · by its words', 'Home, the newest thought in Scratch');
      await marks(page, 'Tasktap decides', 'Home');
      await page.focus(FIELD);
      await typed(page, 'fix the export in ledger-api');
      await says(page, 'ledger-api · named in it', 'Home, a thought that names ledger-api');
      await marks(page, 'ledger-api', 'Home, a thought that names ledger-api');
      await page.fill(FIELD, '');
      await page.focus(FIELD);
      await typed(page, 'move the timer from cuegrid to fieldnotes');
      await says(page, 'cuegrid or fieldnotes · you will be asked which', 'Home, a thought that names two');
      await marks(page, 'Tasktap decides', 'Home, a thought that names two');
      await page.fill(FIELD, '');
      await page.focus(FIELD);
      await typed(page, 'and the timer too');
      const follow = await chip(page);
      expect(/^Follow-up: .+ · named in it$/.test(follow), `Home, a thought that names a session: the chip says "${follow}"`);
      await page.fill(FIELD, '');
      await page.focus(FIELD);
      await typed(page, 'buy milk');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      const asked = await sent(page);
      expect(asked && !asked.project_id && asked.mode !== 'note', `Home: a thought with the chip at "Tasktap decides" was sent ${JSON.stringify(asked && { project_id: asked.project_id, mode: asked.mode })}, not for the router to place`);
      // A pick is for its thought alone, and the chip says it went back.
      // By the keyboard: Tab from the field to the chip, an arrow opens the list, the arrows move, Return chooses, and the
      // field has the keyboard again.
      await page.focus(FIELD);
      await page.keyboard.press('Tab');
      await page.keyboard.press('ArrowDown');
      const opened = await until(() => focused(page), (v) => v === 'the list');
      expect(opened === 'the list', `Home: Tab and an arrow on the chip leave the keyboard on ${opened}, not in the list`);
      for (let i = 0; i < 6 && !(await page.evaluate(() => document.activeElement?.textContent === 'fieldnotes')); i++) await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      const chosen = await until(() => focused(page), (v) => v === 'capture-input');
      expect(chosen === 'capture-input', `Home: a place chosen by the keyboard leaves the keyboard on ${chosen}, not the field`);
      await says(page, 'fieldnotes · your choice', 'Home, fieldnotes chosen');
      await marks(page, 'fieldnotes', 'Home, fieldnotes chosen');
      await page.focus(FIELD);
      await typed(page, 'a thought for fieldnotes');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      expect((await sent(page))?.project_id === P.fieldnotes, 'Home: the thought sent with fieldnotes chosen did not go to fieldnotes');
      await says(page, 'Back to Tasktap decides · by its words', 'Home, after the thought with fieldnotes chosen was sent');
      await typed(page, 'the next one');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      const next = (await sent(page))?.project_id;
      expect(!next, `Home: the thought after a chosen one was sent to ${next === P.fieldnotes ? 'the folder chosen for that one' : 'a folder nobody chose'}`);
      await says(page, 'Tasktap decides · by its words', 'Home, after a thought nobody chose a place for');
      // Scratch, chosen.
      await click(page, '#dest-chip');
      await click(page, '.cap-list > button', 'Scratch');
      await says(page, 'Scratch · your choice', 'Home, Scratch chosen');
      await page.focus(FIELD);
      await typed(page, 'try something');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      expect((await sent(page))?.project_id === P.scratch, 'Home: the thought sent with Scratch chosen did not go to Scratch');

      // New Task in a workspace: its folder, for that sheet; put away, Home's Composer has none of it.
      await page.evaluate((p) => (window.__ws.show(p), window.__ws.command('new-task')), P.cuegrid);
      await page.waitForTimeout(400);
      await says(page, 'cuegrid · you are in it', 'New Task in cuegrid', '.sheet ');
      await marks(page, 'cuegrid', 'New Task in cuegrid', '.sheet ');
      await page.focus(`.sheet ${FIELD}`);
      await typed(page, 'fix the export in ledger-api');
      await says(page, 'ledger-api · named in it', 'New Task in cuegrid, a thought that names ledger-api', '.sheet ');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      const named = await sent(page);
      expect(named && !named.project_id && named.mode !== 'note', `New Task in cuegrid: a thought that names ledger-api was sent ${JSON.stringify(named && { project_id: named.project_id, mode: named.mode })}, not for the match on names to place`);
      await page.evaluate((p) => (window.__ws.show(p), window.__ws.command('new-task')), P.cuegrid);
      await page.waitForTimeout(400);
      await page.evaluate(() => window.__ws.dismiss());
      await page.evaluate(() => window.__ws.show('home'));
      await page.waitForTimeout(300);
      await says(page, 'Tasktap decides · by its words', 'Home, after New Task in cuegrid was put away');
      await page.evaluate((p) => (window.__ws.show(p), window.__ws.command('new-task')), P.scratch);
      await page.waitForTimeout(400);
      await says(page, 'Tasktap decides · by its words', 'New Task in Scratch', '.sheet ');
      await page.evaluate(() => (window.__ws.dismiss(), window.__ws.show('home')));
      await page.waitForTimeout(300);
      await says(page, 'Tasktap decides · by its words', 'Home, after New Task in Scratch was put away');
      for (const e of page.errors) failures.push(`where it goes: ${e}`);
      await page.context().close();

      // Placing by a model agreed to: Tasktap decides, and says who reads it.
      page = await open(browser, { label: 'workspace', records: { ...structuredClone(r), prefs: [...(r.prefs || []), { id: 'route_by', value: { agents: [{ agent: 'claude', model: 'haiku', on: true }], terms: 3 }, rev: 2 }] }, url: server.url, dpr: 1 });
      // (Who reads it is known once the core has said which agents are signed in.)
      const model = await until(() => chip(page), (v) => /^Tasktap decides · .+ reads it$/.test(v));
      expect(/^Tasktap decides · .+ reads it$/.test(model), `Home, placing by a model agreed to: the chip says "${model}", not who reads the thought`);
      await page.focus(FIELD);
      await typed(page, 'fix the export in ledger-api');
      await says(page, 'ledger-api · named in it', 'Home, placing by a model agreed to, a thought that names ledger-api');
      await page.context().close();

      // One project known, one folder open (Scratch not counted): it is where a thought that names none goes, on Home
      // and in the notch.
      const one = { ...structuredClone(r), projects: r.projects.map((p) => ({ ...p, open: p.kind === 'scratch' || p.id === P.cuegrid })) };
      page = await open(browser, { label: 'workspace', records: structuredClone(one), url: server.url, dpr: 1 });
      await says(page, 'cuegrid · the only folder open', 'Home, one folder open');
      await page.focus(FIELD);
      await typed(page, 'buy milk');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      expect((await sent(page))?.project_id === P.cuegrid, 'Home, one folder open: a thought that names none was not sent to it');
      await page.context().close();
      page = await open(browser, { label: 'notch', records: structuredClone(one), url: server.url, dpr: 1 });
      await page.evaluate((g) => window.__fake.emit(g), GEO);
      await page.evaluate(() => window.__fake.emit({ do: 'capture' }));
      await page.waitForTimeout(600);
      await says(page, 'cuegrid · the only folder open', 'the notch, one folder open');
      await page.context().close();
      // One project Tasktap knows and no folder open: never a default; a thought that names none is asked about.
      {
        const lone = { id: '019a8b6c-7d10-7000-8000-0000000c0009', rev: 1, folder: '/Users/someone/projects/tidepool', name: 'tidepool', names: [], about: 'A photo library', about_from: 'README.md',
          why: ['agent', 'git'], agents: ['claude'], repo: null, copy_of: null, inside: null, project_id: null, used: now, looks: [], hidden: false, main: false, available: true };
        page = await open(browser, { label: 'workspace', records: { ...structuredClone(r), projects: r.projects.map((p) => ({ ...p, open: p.kind === 'scratch' })), cards: [lone] }, url: server.url, dpr: 1 });
        await says(page, 'Tasktap decides · by its words', 'Home, one project known and no folder open');
        await page.focus(FIELD);
        await typed(page, 'buy milk');
        await says(page, 'Tasktap decides · asks you if unsure', 'Home, one project known, a thought that names none');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        const asked = await sent(page);
        expect(asked && !asked.project_id && !asked.card_id && asked.mode !== 'note', `Home, one project known: a thought that names none was sent ${JSON.stringify(asked && { project_id: asked.project_id, card_id: asked.card_id })}, not for the router to ask`);
        await page.context().close();
      }

      // A thought kept for later because its words named no folder: Undo, as for one saved for later by choice, and
      // Send to a folder from its line.
      page = await open(browser, { label: 'workspace', records: { ...structuredClone(r), keep: true }, url: server.url, dpr: 1 });
      const kept = (page) => page.evaluate(() => document.querySelector('.capture .cap-said')?.textContent ?? '');
      const keep = async (words) => {
        await page.focus(FIELD);
        await typed(page, words);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
      };
      await keep('buy milk');
      const line = await until(() => kept(page), (t) => t.startsWith('It named no folder'));
      expect(line.startsWith('It named no folder; saved for later') && line.includes('Undo') && line.includes('Send to a folder'), `a thought kept for later by its words: its line says "${line}", without Undo and Send to a folder`);
      await click(page, '.capture .cap-said button', '⌘ZUndo');
      const milk = await until(() => page.inputValue(FIELD), (v) => v === 'buy milk');
      expect(milk === 'buy milk', `Undo on a thought kept for later by its words leaves "${milk}" in the field`);
      await page.fill(FIELD, '');
      await keep('buy bread');
      await page.focus(FIELD);
      await page.keyboard.press('Meta+z');
      const bread = await until(() => page.inputValue(FIELD), (v) => v === 'buy bread');
      expect(bread === 'buy bread', `⌘Z on a thought kept for later by its words leaves "${bread}" in the field`);
      await page.fill(FIELD, '');
      await keep('buy cheese');
      await click(page, '.capture .cap-said button', 'Send to a folder…');
      const to = await page.evaluate(() => [...document.querySelectorAll('.cap-list > button')].map((b) => b.textContent).join(', '));
      expect(/fieldnotes/.test(to) && !/For later|Tasktap decides/.test(to), `Send to a folder on a kept thought's line opens ${to ? `"${to}"` : 'no list'}, not the folders`);
      await click(page, '.cap-list > button', 'fieldnotes');
      const moved = await page.evaluate(() => window.__fake.updated);
      expect(moved?.project_id === P.fieldnotes, `Send to a folder, fieldnotes chosen: the kept thought was ${moved ? `sent to ${moved.project_id}` : 'not sent anywhere'}`);
      expect((await focused(page)) === 'capture-input', 'Send to a folder: the field does not have the keyboard again');
      for (const e of page.errors) failures.push(`kept for later: ${e}`);
      await page.context().close();

      // Where the foot is short of room: the chip's reason gives way first, then the microphone's key hint goes, and
      // only then does the chip's place shorten. The hint is never on a line of its own, and nothing wraps.
      // (With a model agreed to, and then with a follow-up's long name typed for.)
      const busy = flow(scene('busy'), 'session');
      busy.hints = { 'and the timer too': { confidence: 'clear', to: { session: busy.ids.timer.session }, brief: 'and the timer too' } };
      page = await open(browser, { label: 'workspace', records: busy, url: server.url, dpr: 1, viewport: { width: 1180, height: 800 } });
      for (const words of ['', 'and the timer too']) {
        if (words) (await page.focus(FIELD), await typed(page, words));
        for (let width = 1180; width >= 640; width -= 30) {
          await page.setViewportSize({ width, height: 800 });
          await page.waitForTimeout(120);
          const f = await page.evaluate(() => {
            const row = document.querySelector('.home .cap-row'), place = row?.querySelector('#dest-chip b'), hint = row?.querySelector('.mic kbd'), icon = row?.querySelector('.mic .i');
            if (!place || !icon) return null;
            const mid = (e) => { const b = e.getBoundingClientRect(); return b.top + b.height / 2; };
            const shown = !!hint && hint.getClientRects().length > 0 && getComputedStyle(hint).display !== 'none';
            const squeezed = [...row.querySelectorAll('#dest-chip .i')].some((i) => i.getBoundingClientRect().width < 11);
            const chip = row.querySelector('#dest-chip'), over = chip.scrollWidth > chip.clientWidth + 1;
            return { cut: place.scrollWidth > place.clientWidth, shown, off: shown ? Math.abs(mid(hint) - mid(icon)) : 0, squeezed, over };
          });
          if (!f) continue;
          const at = `Home ${width} px${words ? ', a follow-up typed for' : ''}`;
          expect(f.off <= 1.5, `${at}: the microphone's key hint is ${f.off.toFixed(1)} px off its icon's line`);
          expect(!(f.shown && f.cut), `${at}: the chip's place is cut short while the microphone's key hint is shown`);
          expect(!f.squeezed, `${at}: the chip's icons are squeezed`);
          expect(!f.over, `${at}: the chip's words run out of the chip`);
        }
      }
      await page.context().close();

      // No folder open: saved for later, and the chip says so.
      page = await open(browser, { label: 'workspace', records: { ...structuredClone(r), projects: r.projects.map((p) => ({ ...p, open: p.kind === 'scratch' })) }, url: server.url, dpr: 1 });
      await says(page, 'No projects yet · saved for later', 'Home, no folder open');
      await page.context().close();

      // Projects Tasktap knows and has not opened (docs/projects-design.md, the owner's decisions of 2026-11-19): never
      // rows of the list until something asks for them; a name said as speech writes it is placed with the words it was
      // as written or joined (its parts said apart) is placed with the words it was said in and the chip says it is not
      // open yet; ⌘K opens the list from the field, whose own field finds a project by what is typed (the core's own
      // answer) and Return takes the first, or says none has that name; a pick of one is sent by its card, and opens at
      // its start; with a thought already written the list's first rows are the places its words name or describe, and
      // none when they point at none: never one only because it was worked on lately.
      {
        const k = structuredClone(r), day = 86400000;
        const card = (n, name, about, used, more = {}) => ({ id: `019a8b6c-7d10-7000-8000-0000000c000${n}`, rev: 1, folder: `/Users/someone/projects/${name}`, name, names: [], about, about_from: 'README.md',
          why: ['agent', 'git'], agents: ['claude'], repo: null, copy_of: null, inside: null, project_id: null, used: now - n * day, looks: [], hidden: false, main: false, available: true, ...more });
        const [pyrite, kiln, harbor] = [card(1, 'pyrite', 'Property-based testing helpers for Python'), card(2, 'kiln', 'A static site generator with incremental builds'), card(3, 'harbormaster', 'Deploys containers to a small fleet over SSH')];
        k.cards = [pyrite, kiln, harbor, card(4, 'pyrite-old', '', 0, { copy_of: pyrite.id }), card(5, 'secret-notes', '', 0, { hidden: true })];
        k.hints = { ...k.hints, 'roll back the deploy in harbor master': { confidence: 'clear', to: { card: harbor.id }, brief: 'roll back the deploy in harbor master', said: 'harbor master' } };
        page = await open(browser, { label: 'workspace', records: k, url: server.url, dpr: 1 });
        const all = await rows(page);
        expect(!/pyrite|kiln|harbormaster|secret/.test(all), `Home: the list shows a project that is not open, unasked (${all})`);
        await page.focus(FIELD);
        await typed(page, 'roll back the deploy in harbor master');
        await says(page, 'harbormaster · said as “harbor master” · not open yet', 'Home, a known project said with its parts apart');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        const spoken = await sent(page);
        expect(spoken && !spoken.project_id && !spoken.card_id && spoken.mode !== 'note', `Home: a thought naming a known project was sent ${JSON.stringify(spoken && { project_id: spoken.project_id, card_id: spoken.card_id })}, not for the match on names to place`);
        // ⌘K from the field; the list's field finds one by part of its name; Return takes it.
        await page.focus(FIELD);
        await typed(page, 'roll out the new release');
        await page.keyboard.press('Meta+k');
        const into = await until(() => page.evaluate(() => document.activeElement?.id), (v) => v === 'cap-find');
        expect(into === 'cap-find', `Home: ⌘K from the field leaves the keyboard on ${into}, not the list's field`);
        await page.keyboard.type('harbor');
        const found = await until(() => page.evaluate(() => [...document.querySelectorAll('.cap-list > button[role=option]')].map((b) => b.textContent)), (f) => !!f[0]?.startsWith('harbormaster'));
        expect(found[0]?.startsWith('harbormaster') && found.every((f) => !/pyrite|kiln/.test(f)), `Home: "harbor" in the list's field finds ${JSON.stringify(found)}`);
        expect(found.every((f) => !/Tasktap decides|For later/.test(f)), `Home: while something is typed in the list's field it shows more than what it found (${found.join(', ')})`);
        // A name no project has: none found, and the list says so; then the one that matches.
        await page.fill('#cap-find', 'zebra');
        const none = await until(() => page.evaluate(() => ({ rows: document.querySelectorAll('.cap-list > button[role=option]').length, said: document.querySelector('.cap-none')?.textContent })), (n) => n.rows === 0 && n.said === 'No project by that name.');
        expect(none.rows === 0 && none.said === 'No project by that name.', `Home: "zebra" in the list's field finds ${none.rows} and says ${JSON.stringify(none.said)}`);
        await page.fill('#cap-find', 'harb');
        await until(() => page.evaluate(() => document.querySelector('.cap-list > button[role=option]')?.textContent ?? ''), (t) => t.startsWith('harbormaster'));
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        await says(page, 'harbormaster · your choice · opens it', 'Home, a known project chosen');
        await page.focus(FIELD);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        const picked = await sent(page);
        expect(picked?.card_id === harbor.id && !picked?.project_id, `Home: a known project chosen was sent ${JSON.stringify(picked && { project_id: picked.project_id, card_id: picked.card_id })}, not by its card`);
        // A thought already written: the places its words describe first, then what is in use; for one whose words
        // point at no project, only what is in use.
        await page.focus(FIELD);
        await typed(page, 'the static site rebuilds every page');
        await click(page, '#dest-chip');
        await whenThere(page, '.cap-list > button[role=option]', 'the chip\'s list for a thought already written');
        await described(page);
        const first = await page.evaluate(() => [...document.querySelectorAll('.cap-list > button[role=option]')].map((b) => b.querySelector('span')?.textContent));
        expect(first[0] === 'kiln' && !first.some((f) => /pyrite|harbormaster/.test(f)) && first.filter((f) => f === 'kiln').length === 1,
          `Home, a thought already written: the list begins ${first.slice(0, 4).join(', ')}, not with the one place its words describe, once, and nothing unasked`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        await page.fill(FIELD, '');
        await typed(page, 'rename the variables before lunch');
        await click(page, '#dest-chip');
        await whenThere(page, '.cap-list > button[role=option]', 'the chip\'s list for a thought that names no project');
        await described(page);
        const plain = await page.evaluate(() => [...document.querySelectorAll('.cap-list > button[role=option]')].map((b) => b.querySelector('span')?.textContent));
        expect(!plain.some((f) => /pyrite|kiln|harbormaster/.test(f)), `Home, a thought that points at no project: the list shows a project not open (${plain.join(', ')})`);
        const rowsShown = await page.evaluate(() => document.querySelectorAll('.cap-list > *').length);
        expect(rowsShown <= 1 + 3 + 1 + 6 + 1 + 1 + 1, `Home: the list has ${rowsShown} rows: more than its field, three guesses, Tasktap decides, six open folders, Scratch, another folder and For later`);
        await page.keyboard.press('Escape');
        for (const e of page.errors) failures.push(`known projects: ${e}`);
        await page.context().close();
      }

      // The notch: never the newest thought's folder.
      page = await open(browser, { label: 'notch', records: structuredClone(r), url: server.url, dpr: 1 });
      await page.evaluate((g) => window.__fake.emit(g), GEO);
      await page.evaluate(() => window.__fake.emit({ do: 'capture' }));
      await page.waitForTimeout(600);
      await says(page, 'Tasktap decides · by its words', 'the notch, the newest thought in Scratch');
      await page.focus(FIELD);
      await marks(page, 'Tasktap decides', 'the notch');
      for (const e of page.errors) failures.push(`the notch: ${e}`);
      await page.context().close();
    }

    // The field's height: measured when its words or its width change, and at no other time.
    for (const where of ['Home', 'the capture sheet', 'the notch']) {
      const notch = where === 'the notch', field = where === 'the capture sheet' ? `.sheet ${FIELD}` : FIELD, most = where === 'Home' ? 6 : 3;
      page = await open(browser, { label: notch ? 'notch' : 'workspace', records: scene('normal'), url: server.url, dpr: 1 });
      if (notch) (await page.evaluate((g) => window.__fake.emit(g), GEO), await page.evaluate(() => window.__fake.emit({ do: 'capture' })));
      else if (field !== FIELD) await page.evaluate(() => (window.__ws.ui.sheet = { kind: 'capture' }, window.__motion.redraw()));
      await page.waitForTimeout(800);
      await page.focus(field);
      // To a hundredth of a pixel: a sheet still settling under its transform reads 39.999996 for 40.
      const height = () => page.evaluate((f) => Math.round(document.querySelector(f).getBoundingClientRect().height * 100) / 100, field);
      const up = [await height()];
      for (let line = 1; line <= most + 2; line++) {
        if (line > 1) await page.keyboard.press('Shift+Enter');
        await page.keyboard.type('line');
        up.push(await height());
      }
      const down = [];
      for (let line = most + 2; line > 1; line--) {
        for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
        down.push(await height());
      }
      const step = up[2] - up[1], grows = up.every((h, i) => (i < 2 ? h === up[0] : i <= most ? h - up[i - 1] === step : h === up[most]));
      expect(step > 10 && grows, `${where}: the field does not grow a line at a time up to ${most} lines and no further (its height by lines, from none: ${up.join(' ')})`);
      expect(down.reverse().every((h, i) => h === up[i + 1]), `${where}: the field does not shrink as it grew (${up.join(' ')} up, ${down.join(' ')} by lines after)`);
      // Renders that change nothing: the measure writes the field's height, so none is to be written.
      const measured = await page.evaluate(async ([f, redraw]) => {
        let n = 0;
        const watch = new MutationObserver((ms) => (n += ms.length));
        watch.observe(document.querySelector(f), { attributes: true, attributeFilter: ['style'] });
        for (let i = 0; i < 20; i++) (redraw ? window.__look({}) : window.__motion.redraw(), await new Promise((ok) => requestAnimationFrame(ok)));
        n += watch.takeRecords().length;
        return n;
      }, [field, notch]);
      expect(measured === 0, `${where}: 20 renders that changed nothing measured the field ${measured / 2} times`);
      if (!notch) {
        // Words up to the end of the line and no further, however wide the field is at this width and text size: in
        // a narrower window they need another line.
        const one = await height();
        for (const word of 'and words enough to wrap onto a second line here and then onto a third and on'.split(' ')) {
          await page.keyboard.type(` ${word}`);
          if ((await height()) === one) continue;
          for (let i = 0; i <= word.length; i++) await page.keyboard.press('Backspace');
          break;
        }
        const wide = await height();
        await page.setViewportSize({ width: 400, height: 760 });
        await page.waitForTimeout(300);
        expect((await height()) > wide, `${where}: the field did not follow its width (${wide} px high, then ${await height()} in a narrower window)`);
      }
      for (const e of page.errors) failures.push(`${where}: ${e}`);
      await page.context().close();
    }
    }
    // ——— After the owner's first trial and its independent review (NOTES §13; docs/trial-checklist.md R1–R15) ———
    // The question about a thought just sent is asked at the Composer it was sent from, in one place only; the field
    // keeps the keyboard, and while it is empty its keys answer: a row's number, the arrows and Return, which takes the
    // row the arrows are on once 600 ms passed without a key since the question came, and never on a key held down.
    // Any other key types, and the question waits in Needs you; Escape and Tab give it there. The metal key does what
    // Return does and says so. The first start's sheet is part of Home's first picture or does not come at all; a key
    // counts only after 600 ms without one; one it does not take types into the Composer; put away in any way it is
    // Not now. A cap shows only where its key works.
    {
      const { projects } = require('./projects-fixtures.cjs');
      const NOTES = ['named in it', 'where your last task went', 'worked on last'];
      const asking = async (o = {}, extra = {}) => {
        const page = await open(browser, { label: 'workspace', records: { ...scene('normal'), asks: { notes: NOTES, ...o }, ...extra }, url: server.url, dpr: 1 });
        await page.focus(FIELD);
        return page;
      };
      const sendIt = async (page, text = 'make the export faster') => (await page.keyboard.type(text), await page.keyboard.press('Enter'));
      // Waits by the page, never by the script's clock (a slow machine runs both at its own pace): the question come,
      // and the moment its Return acts, which the page says by the key no longer waiting (capture.tsx `answers`).
      const arrived = (page) => page.waitForFunction(() => document.querySelector('.capture .cap-ask'), null, { timeout: 15000 }).then(() => true, () => false);
      const ready = (page, sel = '.home .capture .cap-row > .key') => page.waitForFunction((s) => {
        const k = document.querySelector(s);
        return !!document.querySelector('.capture .cap-ask') && !!k && !k.hasAttribute('data-waits');
      }, sel, { timeout: 15000 }).then(() => true, () => false);
      // Where the question is now: at a Composer (in the sheet or not), in Needs you, and how many times it is shown.
      const where = (page) => page.evaluate(() => [...document.querySelectorAll('[data-question]')].filter((q) => q.offsetParent).map((q) => `${q.closest('.sheet[role=dialog]') ? 'sheet ' : ''}${q.closest('.capture') ? 'composer' : q.closest('.needs') ? 'needs' : 'elsewhere'}`).join(', '));
      const inField = (page) => page.evaluate(() => document.activeElement?.id === 'capture-input');
      const caps = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(`${s} kbd.keycap`)].filter((k) => k.offsetParent).map((k) => k.textContent.trim()).join(' '), sel);
      const answered = (page) => page.evaluate(() => window.__fake.answered ?? null);
      const choice = async (page) => { const a = await answered(page); return !a ? 'none' : a.kind === 'choice' ? a.choice : a.kind; };
      // A click on what may be missing or not take one (as in the build before): said as a failure, never a crash.
      const tap = (page, sel, what) => clickWhenThere(page, sel, `${what} (${sel})`);
      const metal = (k) => !!k && /linear-gradient/.test(getComputedStyle(k).backgroundImage) && getComputedStyle(k).color === 'rgb(13, 13, 14)';
      const key = (page, sel = '.home .capture .cap-row:not(.hear) > .key') => page.evaluate(([s, m]) => { const k = document.querySelector(s); return k ? `${(0, eval)(m)(k) ? 'metal' : 'quiet'} "${k.textContent.trim()}"` : 'none'; }, [sel, String(metal)]);

      // R2, R10: asked at the Composer, the field keeping the keyboard; its rows numbered 1 to 5, the last two
      // "Another project…" and "Keep for later"; the metal key says what Return will do.
      let page = await asking();
      expect((await key(page)).startsWith('metal'), 'Home, empty: the Composer\'s key is not the metal key');
      await sendIt(page);
      await arrived(page);
      expect((await where(page)) === 'composer', `a question about the thought just sent, the field empty: it is shown ${await where(page) || 'nowhere'}, not once at the Composer`);
      expect(await inField(page), 'a question asked at the Composer took the keyboard from the field');
      expect((await caps(page, '.cap-ask')) === '1 2 3 4 5', `the question at the Composer shows the caps "${await caps(page, '.cap-ask')}", not 1 2 3 4 5 (every row a number, no letters)`);
      await ready(page);
      expect((await key(page)) === 'metal "Start in cuegrid"', `with the question at the Composer its key is ${await key(page)}, not the metal key saying "Start in cuegrid"`);
      expect(await page.evaluate(() => [...document.querySelectorAll('.cap-ask .qa > .ans')].every((a, i, all) => !i || a.getBoundingClientRect().top >= all[i - 1].getBoundingClientRect().bottom - 0.5)), 'the question\'s places are not one under another');
      await page.keyboard.press('1');
      await page.waitForTimeout(400);
      expect((await choice(page)) === 0 && (await value(page)) === '' && (await inField(page)), `1 at the Composer's question: answered ${JSON.stringify(await answered(page))}, the field "${await value(page)}", the keyboard ${await inField(page) ? 'in' : 'not in'} it`);
      await page.context().close();

      // The arrows move the row Return takes, and the key says which; Return takes it.
      page = await asking();
      await sendIt(page);
      await ready(page);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(100);
      expect((await key(page)) === 'metal "Start in ledger-api"', `↓ ↓ at the Composer's question: its key says ${await key(page)}, not "Start in ledger-api"`);
      await page.waitForTimeout(700);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      expect((await choice(page)) === 2, `↓ ↓ then Return at the Composer's question answered ${JSON.stringify(await answered(page))}, not its third place`);
      await page.context().close();

      // The key, clicked, does what Return does: the first row.
      page = await asking();
      await sendIt(page);
      await ready(page);
      await tap(page, '.home .capture .cap-row > .key', 'the Composer\'s key with the question there');
      await page.waitForTimeout(400);
      expect((await choice(page)) === 0, `the Composer's key clicked with the question there answered ${JSON.stringify(await answered(page))}, not its first place`);
      await page.context().close();

      // Return twice to send: the second, 300 ms after the question came (600 ms after the first), does not answer it;
      // Return after 600 ms of quiet takes the first row. Timed in the page; a machine too slow to press in time is
      // tried again rather than taken for a pass.
      let timed = false;
      for (let attempt = 0; attempt < 3 && !timed; attempt++) {
        page = await asking();
        await page.evaluate(() => {
          new MutationObserver(() => (window.__came ||= document.querySelector('.capture .cap-ask') ? performance.now() : 0)).observe(document.body, { childList: true, subtree: true });
          document.addEventListener('keydown', (e) => e.key === 'Enter' && (window.__enters ??= []).push(performance.now()), true);
        });
        await sendIt(page);
        await arrived(page);
        const wait = await page.evaluate(() => 300 - (performance.now() - window.__came));
        if (wait > 0) await page.waitForTimeout(wait);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(80);
        const [sent, second, came] = await page.evaluate(() => [...window.__enters, window.__came]);
        if (second - came >= 200 && second - came < 560 && second - sent >= 0) {
          timed = true;
          expect((await choice(page)) === 'none', `Return ${Math.round(second - came)} ms after the question came (a Return pressed twice to send) answered it`);
          await page.waitForTimeout(700);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(400);
          expect((await choice(page)) === 0, `Return after 600 ms of quiet at the Composer's question answered ${JSON.stringify(await answered(page))}, not its first place`);
        }
        await page.context().close();
      }
      if (!timed) console.log('NOTE  this machine could not press Return 300 ms after the question came, three times; the Return guard was not measured');

      // A Return held down since it sent the thought, the system's repeat slow (a second's delay): never an answer.
      page = await asking();
      await page.keyboard.type('make the export faster');
      await page.keyboard.down('Enter');
      await page.waitForTimeout(1000);
      await page.keyboard.down('Enter');
      await page.waitForTimeout(200);
      await page.keyboard.up('Enter');
      expect((await choice(page)) === 'none' && (await calls(page, 'thought.capture')) === 1, `Return held down from sending, repeating after a second, answered the question (${JSON.stringify(await answered(page))}) or sent twice`);
      await page.context().close();

      // Letters typed after the question came are the next thought, every one; the question waits in Needs you, its
      // caps not shown there (the keyboard is the field's). A digit typed after a letter is text.
      page = await asking();
      await sendIt(page);
      await arrived(page);
      await page.keyboard.type('look at the logs 2', { delay: 30 });
      await until(async () => [await value(page), await where(page)], ([v, w]) => v === 'look at the logs 2' && w === 'needs');
      expect((await value(page)) === 'look at the logs 2' && (await choice(page)) === 'none', `typing after the question came: the field holds "${await value(page)}", answered ${JSON.stringify(await answered(page))}`);
      expect((await where(page)) === 'needs' && (await caps(page, '.needs')) === '', `typing after the question came: it is ${await where(page)} with caps "${await caps(page, '.needs')}", not waiting in Needs you without caps`);
      expect((await key(page)) === 'metal "Start"', `typing after the question came: the key says ${await key(page)}, not Start again`);
      await page.context().close();

      // The next thought begun before the question came: it never takes the field, and its digits are text.
      page = await asking({ ms: 900 });
      await sendIt(page);
      await page.waitForTimeout(150);
      await page.keyboard.type('1 more thing');
      await page.waitForTimeout(1200);
      await page.keyboard.type(' and 2');
      await until(async () => [await value(page), await where(page)], ([v, w]) => v === '1 more thing and 2' && w === 'needs');
      expect((await value(page)) === '1 more thing and 2' && (await choice(page)) === 'none' && (await where(page)) === 'needs', `typing the next thought as the question came: the field holds "${await value(page)}", answered ${JSON.stringify(await answered(page))}, the question ${await where(page)}`);
      await page.context().close();

      // Escape and Tab give the field back: the question waits in Needs you, and 1 is text.
      for (const k of ['Escape', 'Tab']) {
        page = await asking();
        await sendIt(page);
        await arrived(page);
        await page.keyboard.press(k);
        await until(async () => [await inField(page), await where(page)], ([f, w]) => f && w === 'needs');
        expect((await inField(page)) && (await where(page)) === 'needs', `${k} at the Composer's question: the keyboard ${await inField(page) ? 'is' : 'is not'} in the field, the question ${await where(page)}`);
        await page.keyboard.type('1');
        await page.waitForTimeout(150);
        expect((await value(page)) === '1' && (await choice(page)) === 'none', `after ${k}, 1 is not text in the field ("${await value(page)}", ${JSON.stringify(await answered(page))})`);
        await page.context().close();
      }

      // R5: Home left for a workspace and back: the question waits in Needs you, and the field has the keyboard.
      page = await asking();
      await sendIt(page);
      await arrived(page);
      await page.evaluate(() => (window.__ws.show([...window.__ws.records.projects.values()].find((x) => x.open).id), window.__motion.redraw()));
      await page.waitForTimeout(300);
      await page.evaluate(() => (window.__ws.show('home'), window.__motion.redraw()));
      await page.waitForTimeout(300);
      expect((await where(page)) === 'needs' && (await inField(page)), `back on Home after a workspace: the question is ${await where(page)}, the keyboard ${await inField(page) ? 'in' : 'not in'} the field`);
      await page.context().close();

      // R3, R9: a thought sent from New Task: its question in the sheet only, the sheet's field keeping the keyboard;
      // Home's key quiet behind the sheet, the sheet's the one metal key.
      page = await asking();
      await page.keyboard.press('Meta+n');
      await page.waitForTimeout(300);
      await sendIt(page);
      await arrived(page);
      expect((await where(page)) === 'sheet composer', `a thought sent from New Task: its question is shown ${await where(page) || 'nowhere'}, not once in the sheet`);
      expect(await page.evaluate(() => document.activeElement?.id === 'capture-input' && !!document.activeElement.closest('.sheet[role=dialog]')), 'a thought sent from New Task: the keyboard is not in the sheet\'s field');
      await ready(page, '.sheet .capture .cap-row > .key');
      expect((await key(page, '.sheet .capture .cap-row > .key')) === 'metal "Start in cuegrid"' && (await key(page)).startsWith('quiet'), `New Task asking: the sheet's key is ${await key(page, '.sheet .capture .cap-row > .key')}, Home's behind it ${await key(page)}`);
      await page.keyboard.press('1');
      await page.waitForTimeout(400);
      expect((await choice(page)) === 0, `1 in the New Task sheet answered ${JSON.stringify(await answered(page))}, not its first place`);
      await page.context().close();

      // R3: the notch's capture line: the question under its field, its keys the field's, the notch's view unchanged.
      page = await open(browser, { label: 'notch', records: { ...scene('normal'), asks: { notes: NOTES } }, url: server.url, dpr: 1 });
      await page.evaluate((g) => window.__fake.emit(g), GEO);
      await page.evaluate(() => window.__fake.emit({ do: 'capture' }));
      await page.waitForTimeout(600);
      await sendIt(page);
      await arrived(page);
      expect((await where(page)) === 'composer' && (await inField(page)), `the notch: a thought sent from its capture line has its question ${await where(page) || 'nowhere'}, the keyboard ${await inField(page) ? 'in' : 'not in'} the field`);
      await page.keyboard.press('2');
      await page.waitForTimeout(400);
      expect((await choice(page)) === 1, `the notch: 2 at its capture line's question answered ${JSON.stringify(await answered(page))}, not its second place`);
      await page.context().close();

      // R12: a thought placed, under the Composer: one line, where it starts, who placed it, Undo; the brief and the
      // person's words behind one disclosure, closed.
      page = await open(browser, { label: 'workspace', records: flow(scene('normal'), 'held'), url: server.url, dpr: 1 });
      await page.waitForTimeout(300);
      const under = () => page.evaluate(() => {
        const w = document.querySelector('.home .ways');
        return { line: w?.querySelector('.way-h')?.innerText.replace(/\s+/g, ' ').trim(), more: [...(w?.querySelectorAll('.way-b, .way-w, .way-n') ?? [])].filter((x) => x.offsetParent).length, open: w?.querySelector('.way-more')?.getAttribute('aria-expanded') };
      });
      let u = await until(under, (x) => /^Starting in cuegrid\s*·?\s*placed by Claude Code\b.*Undo$/.test(x.line ?? ''));
      expect(/^Starting in cuegrid\s*·?\s*placed by Claude Code\b.*Undo$/.test(u.line ?? '') && u.more === 0 && u.open === 'false', `a thought placed: under the Composer "${u.line}", ${u.more} more lines shown, its disclosure ${u.open}`);
      await tap(page, '.home .way-more', 'a thought placed: its disclosure');
      await page.waitForTimeout(150);
      u = await under();
      expect(u.more >= 2 && u.open === 'true', `a thought placed: its disclosure opened shows ${u.more} lines`);
      // R15: ⌘Z's cap shows while the field is empty and has the keyboard, and not while it holds words.
      await page.focus(FIELD);
      await page.waitForTimeout(100);
      expect((await caps(page, '.ways')) === '⌘Z', `a thought placed, the field empty: Undo's cap is "${await caps(page, '.ways')}", not ⌘Z`);
      await page.keyboard.type('abc');
      await page.waitForTimeout(100);
      expect((await caps(page, '.ways')) === '', `a thought placed, the field holding words: Undo still shows the cap "${await caps(page, '.ways')}", which is the field's undo now`);
      await page.context().close();

      // R15: in the notch, a question that opened it by itself shows no caps until the notch has the keyboard.
      page = await open(browser, { label: 'notch', records: scene('busy'), url: server.url, dpr: 1 });
      await page.evaluate((g) => window.__fake.emit(g), GEO);
      await page.waitForTimeout(900);
      // The page may have put the keyboard on its first answer; the panel itself has none (another app is in front).
      await page.evaluate(() => (document.querySelector('#sheet [data-question] .ans')?.focus(), (document.hasFocus = () => false), window.dispatchEvent(new Event('blur'))));
      await page.waitForTimeout(100);
      const away = await caps(page, '#sheet');
      await page.evaluate(() => ((document.hasFocus = () => true), document.querySelector('#sheet [data-question] .ans')?.focus(), window.dispatchEvent(new Event('focus'))));
      await page.waitForTimeout(100);
      expect(away === '' && (await caps(page, '#sheet')) !== '', `the notch: its question shows the caps "${away}" without the keyboard, and "${await caps(page, '#sheet')}" with it`);
      await page.context().close();

      // The first start (R1, R4). The sheet is decided from what is stored, before Home's first picture with the
      // records, and is in that picture; with the core slow to answer, every frame is watched until the records come.
      const allowed = (page) => page.evaluate(() => window.__fake.records.looks?.some((l) => l.on) ?? false);
      const notNow = (page) => page.evaluate(() => (window.__fake.records.prefs ?? []).some((p) => p.id === 'setup_hidden') || (window.__fake.records.looks ?? []).length > 0);
      const sheetUp = (page) => page.evaluate(() => window.__ws.ui.sheet?.kind === 'setup' && window.__ws.ui.sheet.auto === true);
      const first = async (o = {}) => open(browser, { label: 'workspace', records: { ...projects('first-agents'), ...o }, url: server.url, dpr: 1 });
      // The sheet that came by itself, up long enough by the page's clock to take a key: its answer (the key of its
      // foot) there and unchanged for 650 ms since the page first saw it so, which is no earlier than it came.
      const settled = (page) => page.evaluate(() => new Promise((done) => {
        const end = performance.now() + 15000;
        let was = null, since = 0;
        const look = () => {
          const k = document.querySelector('.sheet[role=dialog] .sh-f .key')?.textContent ?? null;
          if (k !== was) (was = k, (since = performance.now()));
          return (k !== null && performance.now() - since >= 650) || performance.now() > end ? done() : setTimeout(look, 10);
        };
        look();
      }));
      page = await first({ subMs: 900, offerHeld: true });
      await page.evaluate(() => {
        const look = () => (window.__ws.ui.ready ? (window.__firstFrame = !!document.querySelector('.sheet[role=dialog]')) : requestAnimationFrame(look));
        requestAnimationFrame(look);
      });
      await until(() => page.evaluate(() => window.__firstFrame), (v) => v !== undefined);
      expect((await page.evaluate(() => window.__firstFrame)) === true, 'the first start: the projects step\'s sheet is not in Home\'s first picture with the records');
      expect(/Searching .* for your agents’ history/.test(await until(() => page.evaluate(() => document.querySelector('.sheet')?.textContent ?? ''), (t) => /Searching .* for your agents’ history/.test(t))), 'the first start: the sheet does not say it is looking while the core has not said what there is');
      await page.evaluate(() => window.__fake.offer());
      await until(() => page.evaluate(() => document.querySelector('.sheet')?.textContent ?? ''), (t) => /Tasktap reads which folders/.test(t));
      expect(/Tasktap reads which folders Claude Code.* worked in, and when\..*It never reads what was said\..*And the first lines of each project's README\./.test(await page.evaluate(() => document.querySelector('.sheet')?.textContent ?? '')), 'the first start: the sheet\'s facts did not fill in, or not in their words');
      await page.context().close();

      // Typing at it: the first letter puts it away (Not now) and types into the Composer, every letter is there, and
      // Return sends the thought; nothing is allowed.
      page = await first();
      await settled(page);
      expect(await sheetUp(page), 'the first start: the projects step is not up');
      await page.keyboard.type('fix the export menu', { delay: 40 });
      await page.keyboard.press('Enter');
      await until(() => page.evaluate(() => window.__fake.sent?.text), (t) => t === 'fix the export menu');
      expect(!(await allowed(page)) && !(await page.evaluate(() => window.__ws.ui.sheet)) && (await page.evaluate(() => window.__fake.sent?.text)) === 'fix the export menu' && (await notNow(page)),
        `typing at the first start: allowed ${await allowed(page)}, the sheet ${await page.evaluate(() => window.__ws.ui.sheet?.kind ?? 'gone')}, sent "${await page.evaluate(() => window.__fake.sent?.text)}", kept as Not now ${await notNow(page)}`);
      await page.context().close();

      // A key counts only after 600 ms without one: Return 300 ms after ← is held back and said so; once quiet it
      // allows. Timed in the page, tried again on a machine too busy to press in time.
      let quietMeasured = false;
      for (let attempt = 0; attempt < 3 && !quietMeasured; attempt++) {
        page = await first();
        await settled(page);
        await page.evaluate(() => document.addEventListener('keydown', (e) => (window.__keys ??= []).push(performance.now()), true));
        await page.keyboard.press('ArrowLeft');
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(80);
        const [shift, enter] = await page.evaluate(() => window.__keys.slice(-2));
        if (enter - shift >= 200 && enter - shift < 560) {
          quietMeasured = true;
          expect(!(await allowed(page)), `the first start: Return ${Math.round(enter - shift)} ms after another key allowed it`);
          expect(/press Return again/.test(await page.evaluate(() => document.querySelector('.sheet .sh-held')?.textContent ?? '')), 'the first start: a Return held back is not said in the sheet');
          await page.waitForTimeout(700);
          await page.keyboard.press('Enter');
          expect(await until(() => allowed(page), (v) => v), 'the first start: Return after 600 ms of quiet did not allow it');
        }
        await page.context().close();
      }
      if (!quietMeasured) console.log('NOTE  this machine could not press Return 300 ms after another key, three times; the first start\'s guard was not measured');

      // A key pressed, or a click, before the records came: no sheet comes by itself, then or later. The core is slow
      // here (4 s), and what was done counts only where it was done before the records came (a busy machine is tried
      // again rather than taken for a pass or a failure).
      for (const [how, act] of [['a key', (p) => p.keyboard.press('Escape')], ['a letter in the field', async (p) => (await p.focus(FIELD), await p.keyboard.type('a'))], ['a click in the field', (p) => p.click(FIELD, { timeout: 2000 })]]) {
        let done = false;
        for (let attempt = 0; attempt < 3 && !done; attempt++) {
          page = await first({ subMs: 4000 });
          const early = await act(page).then(() => page.evaluate(() => !window.__ws.ui.ready), () => false);
          if (early) {
            done = true;
            await page.waitForFunction(() => window.__ws.ui.ready, null, { timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(1500);
            expect(!(await page.evaluate(() => window.__ws.ui.sheet)) && (await page.evaluate(() => !!document.querySelector('.setup [data-step=projects]'))), `the first start, ${how} before the records came: a sheet came by itself, or Setup does not show the step`);
          }
          await page.context().close();
        }
        if (!done) console.log(`NOTE  the first start: ${how} could not be done before the records came, three times; not measured`);
      }

      // R4: put away by a click beside it, by ⌘O or by Escape, it is Not now, kept.
      for (const [how, act] of [['a click beside it', (p) => { const v = p.viewportSize(); return p.mouse.click(v.width - 20, v.height - 40); }], ['⌘O', (p) => p.keyboard.press('Meta+o')], ['Escape', (p) => p.keyboard.press('Escape')]]) {
        page = await first();
        await settled(page);
        await act(page);
        await page.waitForTimeout(400);
        expect((await page.evaluate(() => window.__ws.ui.sheet?.kind !== 'setup')) && (await notNow(page)) && !(await allowed(page)), `the first start put away by ${how}: it is not kept as Not now, and would come again`);
        await page.context().close();
      }

      // Setup (R11, R13): "Setup · 1 of 3 done", quiet actions on one edge, its words; Hide gives the field the
      // keyboard and says for a moment where Setup went.
      page = await open(browser, { label: 'workspace', records: scene('normal'), url: server.url, dpr: 1 });
      await whenThere(page, '.home .setup [data-step=placing]', 'Setup\'s placing step');
      const setup = await page.evaluate(() => {
        const s = document.querySelector('.home .setup'), acts = [...(s?.querySelectorAll('.setup-b [data-step] button') ?? [])];
        return { head: s?.querySelector('.fold-h')?.innerText.replace(/\s+/g, ' ').trim(), quiet: acts.every((b) => b.matches('.act')), edges: [...new Set(acts.map((b) => Math.round(b.getBoundingClientRect().right * 2) / 2))], placing: s?.querySelector('[data-step=placing] .t')?.textContent };
      });
      expect(/^Setup\s*·?\s*\d of \d done/.test(setup.head ?? '') && setup.quiet && setup.edges.length === 1 && setup.placing === 'Let an agent choose the project', `Setup says "${setup.head}", its actions ${setup.quiet ? 'quiet' : 'not all quiet'} on ${setup.edges.length} edges, its placing step "${setup.placing}"`);
      await tap(page, '.home .setup-h .act', 'Setup\'s Hide');
      const gone = await until(() => page.evaluate(() => document.querySelector('.home .setup-gone')?.textContent ?? ''), (t) => t === 'Setup is in Settings › About.');
      await until(() => page.evaluate(() => window.__ws.records.prefs.get('setup_hidden')?.value), (v) => v === true);
      expect((await inField(page)) && gone === 'Setup is in Settings › About.' && (await page.evaluate(() => window.__ws.records.prefs.get('setup_hidden')?.value)) === true, `Hide: the keyboard ${await inField(page) ? 'is' : 'is not'} in the field, Setup's place says "${gone}"`);
      // Gone after its five seconds, by the page's own clock: a timer of that length and 300 ms more, set after the
      // page's own (setup.tsx GONE_FOR), fires after it however slow the machine, and then the line is off Home.
      const lingers = await page.evaluate(() => new Promise((done) => setTimeout(() => setTimeout(() => done(!!document.querySelector('.home .setup, .home .setup-gone'))), 5300)));
      expect(!lingers, 'Hide: Setup, or what its place said, is still on Home after a few seconds');
      await page.evaluate(() => ((window.__ws.ui.sheet = { kind: 'settings', at: 'about' }), window.__motion.redraw()));
      await whenThere(page, '.settings .set', 'Settings › About');
      const about = await page.evaluate(() => [...document.querySelectorAll('.settings .set')].find((r) => r.querySelector('.t')?.textContent === 'Setup')?.textContent ?? '');
      expect(/of \d done/.test(about) && /Show on Home/.test(about), `Settings › About does not say where Setup is ("${about}")`);
      await clickWhenThere(page, page.locator('.settings .set button', { hasText: 'Show on Home' }).first(), 'Show on Home in Settings › About');
      expect(await until(() => page.evaluate(() => !!document.querySelector('.home .setup')), (v) => v), 'Show on Home does not bring Setup back');
      await page.context().close();

      // Agreed to placing under older terms: Setup's placing step says so and is not done, and no thought carries the
      // core's sentence about it (it is said in that one place).
      {
        const r = { ...flow(scene('normal'), 'held'), prefs: [{ id: 'route_by', value: { agents: [{ agent: 'claude', model: 'haiku', on: true }], terms: 2 }, rev: 9 }] };
        for (const t of r.thoughts) if (t.route) t.route = { ...t.route, fallback: 'the agreement was to what was sent before: placing now asks your agents one after another, and asks you again' };
        page = await open(browser, { label: 'workspace', records: r, url: server.url, dpr: 1 });
        await whenThere(page, '.home .setup [data-step=placing]', 'Setup\'s placing step under older terms');
        // (The terms the core holds now come with its first words; the step says so once they are there.)
        await until(() => page.evaluate(() => document.querySelector('.setup [data-step=placing]')?.textContent ?? ''), (t) => /The terms changed/.test(t));
        const step = await page.evaluate(() => { const s = document.querySelector('.setup [data-step=placing]'); return s ? `${s.hasAttribute('data-done')} ${s.textContent}` : ''; });
        expect(/^false .*The terms changed\. Agree again to keep it on\./.test(step), `an agreement to older terms: Setup's placing step says "${step}", not that the terms changed, undone`);
        expect(!(await page.evaluate(() => /the agreement/.test(document.querySelector('.home').innerText))), 'an agreement to older terms: a thought on Home carries the sentence about it');
        await page.context().close();
      }

      // The agent control by keyboard: six agents, no field; eleven, a field that narrows them.
      const { agents } = require('./home-shots.cjs');
      for (const n of [6, 11]) {
        page = await open(browser, { label: 'workspace', records: agents(scene('normal'), n), url: server.url, dpr: 1 });
        await page.focus('.cap-agent');
        await page.keyboard.press('ArrowDown');
        await whenThere(page, '.agent-list [role=option]', `${n} agents: the agent list`);
        const rows = await page.evaluate(() => [...document.querySelectorAll('.agent-list [role=option]')].map((b) => b.dataset.agent));
        expect(rows.length === n, `${n} agents: the list has ${rows.length} rows`);
        expect(!(await page.evaluate(() => !!document.querySelector('.cap-row select, .rings'))), `${n} agents: a row of rings or a system menu is still there`);
        if (n > 6) {
          expect(await page.evaluate(() => document.activeElement?.id === 'agent-find'), `${n} agents: the list's field does not have the keyboard`);
          await page.keyboard.type('gem');
          expect((await until(() => page.evaluate(() => [...document.querySelectorAll('.agent-list [role=option]')].map((b) => b.dataset.agent).join(' ')), (v) => v === 'gemini')) === 'gemini', `${n} agents: typing "gem" does not narrow the list to Gemini CLI`);
          await page.keyboard.press('Enter');
        } else {
          expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-selected') === 'true'), `${n} agents: the chosen agent's row does not have the keyboard`);
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('Enter');
        }
        const now = await until(() => page.evaluate(() => document.querySelector('.cap-agent')?.dataset.agent), (v) => v === (n > 6 ? 'gemini' : rows[2]));
        expect(now === (n > 6 ? 'gemini' : rows[2]), `${n} agents: the agent picked by keyboard is ${now}, not ${n > 6 ? 'gemini' : rows[2]}`);
        expect(await until(() => page.evaluate(() => document.activeElement?.id === 'capture-input'), (v) => v), `${n} agents: once picked, the field does not have the keyboard back`);
        await page.focus('.cap-agent');
        await page.keyboard.press('ArrowDown');
        await whenThere(page, '.agent-list [role=option]', `${n} agents: the agent list, again`);
        await page.keyboard.press('Escape');
        await until(() => page.evaluate(() => !!document.querySelector('.agent-list')), (v) => !v);
        expect(!(await page.evaluate(() => !!document.querySelector('.agent-list'))) && (await page.evaluate(() => document.querySelector('.cap-agent')?.dataset.agent)) === now, `${n} agents: Escape did not leave the list as it was`);
        await page.context().close();
      }

      // The agent control (R6, R7, R14): its key ⌘J, shown where there is room, opens the list from the field; Tab
      // reaches every control of the foot; typing "co" puts Codex first; with the usual agent signed out the list still
      // opens, other agents can be picked, and signing in is a row of it.
      page = await open(browser, { label: 'workspace', records: agents(scene('normal'), 11), url: server.url, dpr: 1 });
      await page.focus(FIELD);
      await page.keyboard.type('tidy the export menu');
      expect((await page.evaluate(() => [...document.querySelectorAll('.home .cap-agent kbd')].filter((k) => k.offsetParent).map((k) => k.textContent).join())) === '⌘J', 'the agent control does not show its key ⌘J at 1180 px');
      const order = [];
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Tab');
        order.push(await page.evaluate(() => { const a = document.activeElement; return a.id || a.className.split(' ')[0]; }));
      }
      expect(order.join(' ') === 'dest-chip cap-agent mic key', `Tab from the field reaches ${order.join(', ')}, not the chip, the agent control, the microphone and the key`);
      await page.focus(FIELD);
      await page.keyboard.press('Meta+j');
      expect(await until(() => page.evaluate(() => !!document.querySelector('.agent-list') && document.activeElement?.id === 'agent-find'), (v) => v), '⌘J in the field does not open the agent list with its field');
      await page.keyboard.type('co');
      const firstRow = await until(() => page.evaluate(() => document.querySelector('.agent-list [role=option]')?.dataset.agent), (v) => v === 'codex');
      expect(firstRow === 'codex', `typing "co" in the agent list puts ${firstRow} first, not Codex`);
      await page.keyboard.press('Enter');
      await until(async () => [await page.evaluate(() => document.querySelector('.cap-agent')?.dataset.agent), await inField(page)], ([a, f]) => a === 'codex' && f);
      expect((await page.evaluate(() => document.querySelector('.cap-agent')?.dataset.agent)) === 'codex' && (await inField(page)), 'typing "co" and Return does not pick Codex and give the field its keyboard back');
      await page.context().close();
      {
        const r = agents(scene('normal'), 6);
        r.agents[0].signed_in = false;
        page = await open(browser, { label: 'workspace', records: r, url: server.url, dpr: 1 });
        await tap(page, '.home .cap-agent', 'the agent control');
        await whenThere(page, '.agent-list [data-agent=codex]', 'the usual agent signed out: the agent list');
        const list = await page.evaluate(() => ({ open: !!document.querySelector('.agent-list'), sheet: window.__ws.ui.sheet?.kind ?? null, sign: [...document.querySelectorAll('.agent-list button')].map((b) => b.textContent.trim()).find((t) => /^Sign in/.test(t)) ?? null }));
        expect(list.open && !list.sheet && list.sign === 'Sign in to Claude Code…', `the usual agent signed out: a click on the control opens ${list.open ? 'the list' : 'no list'}${list.sheet ? ` and the ${list.sheet} sheet` : ''}, its sign-in row "${list.sign}"`);
        await tap(page, '.agent-list [data-agent=codex]', 'the usual agent signed out: Codex in the list');
        expect((await until(() => page.evaluate(() => document.querySelector('.cap-agent')?.dataset.agent), (v) => v === 'codex')) === 'codex', 'the usual agent signed out: another agent cannot be picked');
        await page.context().close();
      }

      // R8: the chip's reason is whole or not there, never cut ("asks y…"), at every width of window, in the sheet and
      // in the notch.
      for (const w of [540, 600, 660, 720, 800, 900, 1180]) {
        page = await open(browser, { label: 'workspace', records: agents(scene('normal'), 6), url: server.url, dpr: 1, viewport: { width: w, height: 700 } });
        await page.focus(FIELD);
        await page.keyboard.type('tidy the export menu');
        await page.waitForTimeout(250);
        const reasons = await page.evaluate(() => [...document.querySelectorAll('#dest-chip > span')].filter((s) => s.offsetParent && getComputedStyle(s).display !== 'none').map((s) => ({ cut: s.scrollWidth > s.clientWidth + 0.5 || s.getBoundingClientRect().width < 1, text: s.textContent })));
        for (const r of reasons) expect(!r.cut, `${w} px: the chip's reason "${r.text}" is cut, not whole or gone`);
        await page.context().close();
      }

      // The notch's capture row follows Home's rules: one agent control, and its key metal with nothing typed.
      page = await open(browser, { label: 'notch', records: agents(scene('normal'), 6), url: server.url, dpr: 1 });
      await page.evaluate((g) => window.__fake.emit(g), GEO);
      await page.evaluate(() => window.__fake.emit({ do: 'capture' }));
      await page.waitForTimeout(600);
      const notch = await page.evaluate(() => {
        const k = document.querySelector('.cap-row > .key');
        return [!!k && /linear-gradient/.test(getComputedStyle(k).backgroundImage) && getComputedStyle(k).color === 'rgb(13, 13, 14)', !!document.querySelector('.cap-agent'), !document.querySelector('.rings, .cap-row select')].join(' ');
      });
      expect(notch === 'true true true', `the notch's capture row: its key metal, one agent control, no rings: ${notch}`);
      await page.keyboard.type('tidy the export menu');
      await page.waitForTimeout(200);
      const cut = await page.evaluate(() => [...document.querySelectorAll('#dest-chip > span')].some((s) => s.offsetParent && getComputedStyle(s).display !== 'none' && (s.scrollWidth > s.clientWidth + 0.5 || s.getBoundingClientRect().width < 1)));
      expect(!cut, 'the notch: the chip\'s reason is cut');
      await page.context().close();

      // ——— The review's second pass (NOTES §13): the notch's next thought, the key metal exactly when Return acts, a
      // sheet that came by itself on two clocks, ⌘J from anywhere on Home, a long place's name, and every way of
      // putting text in at the first start ———
      const wk = await require('playwright').webkit.launch({ headless: true }).catch(() => null);
      if (!wk) noWebKit('the second pass is checked in Chromium only');
      const both = [['chromium', browser], ...(wk ? [['webkit', wk]] : [])];
      const at0 = (page) => page.evaluate(() => new MutationObserver(() => (window.__came ||= document.querySelector('.capture .cap-ask') ? performance.now() : 0)).observe(document.body, { childList: true, subtree: true }));

      // N1: one set of next thoughts, typed after the question came, at every Composer (Home, New Task, the notch) and
      // in both engines: every character is in the field, the field keeps the keyboard, nothing is answered, and the
      // notch keeps showing its capture line.
      const NEXT = [['Look at the logs', 60], ['tidy up', 150], ['x', 0], [' and a space first', 30]];
      const surface = async (b, at, records = { ...scene('normal'), asks: { notes: NOTES, ms: 300 } }) => {
        const p = await open(b, { label: at === 'notch' ? 'notch' : 'workspace', records, url: server.url, dpr: 1, ...(at === 'notch' ? { viewport: { width: 560, height: 520 } } : {}) });
        if (at === 'notch') (await p.evaluate((g) => window.__fake.emit(g), GEO), await p.evaluate(() => window.__fake.emit({ do: 'capture' })), await p.waitForTimeout(700));
        else if (at === 'sheet') (await p.evaluate(() => ((window.__ws.ui.sheet = { kind: 'capture' }), window.__motion.redraw())), await p.waitForTimeout(500), await p.focus(`.sheet ${FIELD}`));
        else await p.focus(FIELD);
        return p;
      };
      const SURFACES = { home: 'Home', sheet: 'New Task', notch: 'the notch' };
      for (const [engine, b] of both)
        for (const at of Object.keys(SURFACES))
          for (const [text, delay] of NEXT) {
            const p = await surface(b, at);
            await sendIt(p);
            await arrived(p);
            for (const ch of text) (await p.keyboard.type(ch), delay && (await p.waitForTimeout(delay)));
            await p.waitForTimeout(400);
            const got = await p.evaluate((sel) => ({ field: document.querySelector(sel)?.value ?? null, keyboard: document.activeElement === document.querySelector(sel), view: document.querySelector('#sheet')?.getAttribute('aria-label') ?? '' }), at === 'sheet' ? `.sheet ${FIELD}` : FIELD);
            const answer = await choice(p);
            expect(got.field === text && got.keyboard && answer === 'none' && (at !== 'notch' || got.view === 'Tasktap'),
              `${engine}, ${SURFACES[at]}: "${text}" typed after the question came: the field holds "${got.field}", the keyboard ${got.keyboard ? 'in it' : 'elsewhere'}, answered ${JSON.stringify(answer)}${at === 'notch' ? `, the notch shows ${got.view === 'Tasktap' ? 'its capture line' : 'the question'}` : ''}`);
            await p.context().close();
          }

      // N2: the key is metal exactly when Return acts: quiet for 600 ms after the question came (Return then does
      // nothing, nor a click on the key), metal from then on; an arrow pressed on the question starts no wait again.
      page = await asking();
      await at0(page);
      await sendIt(page);
      await arrived(page);
      const looks = await page.evaluate(async ([times, m]) => {
        const metal = (0, eval)(m), out = [];
        for (const t of times) {
          await new Promise((r) => setTimeout(r, Math.max(0, window.__came + t - performance.now())));
          const t0 = performance.now() - window.__came, key = () => metal(document.querySelector('.home .capture .cap-row > .key'));
          // Once Return acts the key is drawn metal in the next render: on a loaded machine that may be a frame late.
          if (t0 >= 604) for (const end = performance.now() + 60; !key() && performance.now() < end; ) await new Promise((r) => setTimeout(r, 4));
          out.push([Math.round(t0), key()]);
        }
        return out;
      }, [[100, 300, 590, 610], String(metal)]);
      for (const [t, m] of looks) expect(t < 597 ? !m : t < 604 || m, `the key ${t} ms after the question came is ${m ? 'metal' : 'quiet'}, while Return ${t < 600 ? 'does nothing' : 'answers'}`);
      await page.context().close();
      for (const [T, how] of [[100, 'Return'], [300, 'Return'], [590, 'Return'], [610, 'Return'], [300, 'a click on the key']]) {
        page = await asking();
        await at0(page);
        await sendIt(page);
        await arrived(page);
        const t = await page.evaluate(async ([T, click]) => {
          await new Promise((r) => setTimeout(r, Math.max(0, window.__came + T - performance.now())));
          const t = Math.round(performance.now() - window.__came);
          if (click) document.querySelector('.home .capture .cap-row > .key').click();
          else document.querySelector('#capture-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
          return t;
        }, [T, how !== 'Return']).catch(async (e) => {
          await new Promise((r) => setTimeout(r, 500));
          failures.push(`${how} ${T} ms after the question came: ${String(e).split('\n')[0]}; ${restarted.splice(0).join('; ') || 'nothing said why'}`);
          return null;
        });
        if (t === null) {
          await page.context().close();
          continue;
        }
        // An answer reaches the stand-in core in the page's time: waited for where one is due, a moment where none is.
        const c = await until(() => choice(page), (v) => v !== 'none', t < 597 ? 600 : 5000);
        expect(t < 597 ? c === 'none' : t < 604 || c === 0, `${how} ${t} ms after the question came ${c === 'none' ? 'did nothing' : `answered ${JSON.stringify(c)}`}, while the key was ${t < 600 ? 'quiet' : 'metal'}`);
        await page.context().close();
      }
      // The row Return takes changed by the core (the question's places in another order): the key is quiet again, and
      // Return 50 ms after it changed does nothing, 650 ms after it answers the row now first. Timed in the page.
      for (const T of [50, 650]) {
        let t = Infinity;
        for (let attempt = 0; attempt < 3 && (T < 600 ? !(t < 597) : !(t >= 604)); attempt++) {
          page = await asking();
          await sendIt(page);
          await ready(page);
          t = await page.evaluate((T) => new Promise((done) => {
            const k = document.querySelector('.home .capture .cap-row > .key'), was = k.textContent, q = window.__fake.asked, order = q.choices.map((_, i) => (i < 2 ? 1 - i : i));
            const watch = new MutationObserver(() => {
              if (k.textContent === was) return;
              watch.disconnect();
              const at = performance.now();
              setTimeout(() => {
                document.querySelector('#capture-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
                done(Math.round(performance.now() - at));
              }, T);
            });
            watch.observe(k, { childList: true, subtree: true, characterData: true });
            window.__fake.push({ t: 'change', rev: 1e9, sets: [{ c: 'questions', put: [{ ...q, rev: 1e9, choices: order.map((i) => q.choices[i]), places: order.map((i) => q.places[i]), notes: order.map((i) => q.notes[i]) }] }] });
          }), T);
          const c = await until(() => choice(page), (v) => v !== 'none', T < 600 ? 600 : 5000);
          if (T < 600 && t < 597) expect(c === 'none', `the question's first row changed by the core: Return ${t} ms after answered ${JSON.stringify(c)}`);
          if (T > 600 && t >= 604) expect(c === 0, `the question's first row changed by the core: Return ${t} ms after answered ${JSON.stringify(c)}, not the row now first`);
          await page.context().close();
        }
        if (T < 600 ? !(t < 597) : !(t >= 604)) console.log(`NOTE  this machine could not press Return ${T} ms after the question's row changed, three times (${t} ms); not measured`);
      }
      page = await asking();
      await sendIt(page);
      await ready(page);
      await page.keyboard.press('ArrowDown');
      const down = await key(page);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      expect(down.startsWith('metal') && (await choice(page)) === 1, `↓ on the question, then Return at once: the key was ${down}, and Return answered ${JSON.stringify(await answered(page))}, not the second row`);
      await page.context().close();

      // N3: a sheet that came by itself takes no key in its first 600 ms, also when no key was pressed before it, nor
      // within 600 ms of the last key; then Return answers it.
      // (Watched from before the page's own script runs, so the moment it came is known however soon that is.)
      const watchUp = 'addEventListener("DOMContentLoaded", () => new MutationObserver(() => (window.__up ||= document.querySelector(".sheet[role=dialog]") ? performance.now() : 0)).observe(document.body, { childList: true, subtree: true }))';
      // (And when the sheet's answer, the key of its foot, appeared or last changed: Return counts from then too.)
      const watchKey = 'addEventListener("DOMContentLoaded", () => { let was = null; new MutationObserver(() => { const k = document.querySelector(".sheet[role=dialog] .sh-f .key")?.textContent ?? null; if (k !== was) ((was = k), (window.__keyAt = k === null ? undefined : performance.now())); }).observe(document.body, { childList: true, subtree: true, characterData: true }); });';
      // Pressed in the page at 55 ms; a machine too busy to press that soon is tried again, never taken for a pass.
      let press, early = Infinity;
      for (let attempt = 0; attempt < 3 && !(early < 500); attempt++) {
      if (attempt) await page.context().close();
      page = await open(browser, { label: 'workspace', records: { ...projects('first-agents'), subMs: 700 }, url: server.url, dpr: 1, init: `${watchUp};\n${watchKey}` });
      await page.waitForFunction(() => window.__up > 0, null, { timeout: 4000 }).catch(() => {});
      press = (T) => page.evaluate(async (T) => {
        await new Promise((r) => setTimeout(r, Math.max(0, window.__up + T - performance.now())));
        (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        return Math.round(performance.now() - window.__up);
      }, T);
      early = await press(55);
      await page.waitForTimeout(200);
      if (early < 500) expect(!(await allowed(page)) && (await sheetUp(page)), `the first start's sheet: Return ${early} ms after it came, no key before, ${(await allowed(page)) ? 'allowed it' : 'put it away'}`);
      }
      if (!(early < 500)) console.log(`NOTE  this machine could not press Return within 500 ms of the first start's sheet, three times (${early} ms); its own clock was not measured`);
      // (After the early Return, quiet as long as the rule asks, by the page's clock: on a slow page the early one may
      // itself have come late.)
      await page.waitForFunction(() => window.__keyAt > 0, null, { timeout: 15000 }).catch(() => {});
      const late = await press(Math.max(1400, (early || 0) + 700, Math.round((await page.evaluate(() => window.__keyAt - window.__up)) + 700) || 0));
      expect(await until(() => allowed(page), (v) => v), `the first start's sheet: Return ${late} ms after it came, quiet since, did not allow it`);
      // What was found: one key puts it away (Done; Escape too), not two that do the same.
      await page.evaluate(() => window.__fake.offer?.());
      await until(() => page.evaluate(() => document.querySelector('.sheet #sheet-title')?.textContent ?? ''), (t) => /^Found/.test(t));
      const foot = await page.evaluate(() => [...document.querySelectorAll('.sheet .sh-f :is(.act, .key)')].filter((b) => b.offsetParent).map((b) => b.textContent.trim()));
      expect(!(foot.some((t) => /Close/.test(t)) && foot.some((t) => /Done/.test(t))), `what was found: its foot shows ${foot.join(', ')}, two keys that do the same`);
      await page.context().close();

      // The quiet clock restarts when what Return would do appears or changes by itself: the stand-in core says what
      // there is 100, 700 and 1500 ms after the first start's sheet came ("Searching…" until then, with nothing for
      // Return to do); Return 50 ms after the sheet's answer (Allow) appears is held back with the usual sentence, 650 ms
      // after it allows. In both engines, timed in the page; a machine too busy to press within 597 ms is tried again.
      for (const [engine, b] of both)
        for (const D of [100, 700, 1500])
          for (const T of [50, 650]) {
            let t = Infinity;
            for (let attempt = 0; attempt < 3 && (T < 600 ? !(t < 597) : !(t >= 604)); attempt++) {
              const p = await open(b, { label: 'workspace', records: { ...projects('first-agents'), offerHeld: true }, url: server.url, dpr: 1, init: `${watchUp};\n${watchKey}` });
              await p.waitForFunction(() => window.__up > 0 && !!window.__fake.offer, null, { timeout: 15000 }).catch(() => {});
              t = await p.evaluate(([D, T]) => new Promise((done) => {
                setTimeout(() => window.__fake.offer(), Math.max(0, window.__up + D - performance.now()));
                const end = performance.now() + 15000;
                const wait = () => (window.__keyAt > 0 ? setTimeout(() => {
                  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
                  done(Math.round(performance.now() - window.__keyAt));
                }, Math.max(0, window.__keyAt + T - performance.now())) : performance.now() > end ? done(-1) : setTimeout(wait, 2));
                wait();
              }), [D, T]);
              if (t < 0) expect(false, `${engine}: the first start's sheet, the core answering ${D} ms after it came: its answer never appeared`);
              else if (T < 600 && t < 597) {
                const said = await until(() => p.evaluate(() => document.querySelector('.sheet .sh-held')?.textContent ?? ''), (x) => !!x, 3000);
                expect(!(await allowed(p)) && said === 'You were typing: press Return again to allow.',
                  `${engine}: the first start's sheet, the core answering ${D} ms after it came: Return ${t} ms after Allow appeared ${(await allowed(p)) ? 'allowed it' : 'was held back'}, the sheet saying "${said}"`);
              } else if (T > 600 && t >= 604)
                expect(await until(() => allowed(p), (v) => v), `${engine}: the first start's sheet, the core answering ${D} ms after it came: Return ${t} ms after Allow appeared, quiet since, did not allow it`);
              await p.context().close();
            }
            if (T < 600 ? !(t < 597) : !(t >= 604)) console.log(`NOTE  ${engine}: this machine could not press Return ${T} ms after the first start's answer appeared (core at ${D} ms), three times (${t} ms); not measured`);
          }

      // N4: ⌘J on Home wherever the keyboard is: the agent list opens in the Composer; behind a sheet its key is hidden.
      page = await open(browser, { label: 'workspace', records: scene('busy'), url: server.url, dpr: 1 });
      await page.waitForSelector('.home .hx .hr', { timeout: 15000 }).catch(() => {});
      // A control of Home outside the Composer (a row's answer, a heading's fold, Setup's line).
      await page.evaluate(() => [...document.querySelectorAll('.home .hx button, .home .hx [tabindex="0"]')].find((b) => !b.closest('form.capture') && b.offsetParent)?.focus());
      const from = await page.evaluate(() => (document.activeElement?.closest('form.capture') ? 'the Composer (wrong) ' : '') + (document.activeElement?.textContent.trim().slice(0, 30) || document.activeElement?.tagName));
      await page.keyboard.press('Meta+KeyJ');
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => !!document.querySelector('.home .agent-list') && !!document.activeElement?.closest('.home .capture')),
        `⌘J on Home with the keyboard on ${from}: the agent list ${(await page.evaluate(() => !!document.querySelector('.home .agent-list'))) ? 'opened, the keyboard not in it' : 'did not open'}`);
      await page.keyboard.press('Escape');
      await page.evaluate(() => (window.__ws.open({ kind: 'settings', at: 'thoughts' }), 1));
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => { const k = document.querySelector('.home .cap-agent>kbd'); return !k || getComputedStyle(k).visibility === 'hidden' || !k.offsetParent; }), 'behind Settings, the agent control on Home still shows its key ⌘J');
      await page.context().close();

      // N5: a long place's name, everywhere the foot is (Home from 540 px, New Task, the notch): on the key cut after
      // 16 characters or not there ("Start"), nothing overlapping or past the Composer's edge, the chip never below
      // its arrow and three characters, and never cut while the key says the place.
      const LONG = 'customer-portal-frontend-legacy-migration';
      const longRecords = () => { const r = { ...scene('normal'), asks: { notes: NOTES, ms: 300 } }; const f = r.projects.find((p) => p.open && p.kind === 'folder'); if (f) f.name = LONG; return r; };
      const footOf = (page, sel) => page.evaluate((sel) => {
        const row = document.querySelector(`${sel} .cap-row:not(.hear)`), cap = row.closest('.cap') ?? row, rr = cap.getBoundingClientRect();
        const kids = [...row.children].filter((k) => k.getBoundingClientRect().width > 0 && getComputedStyle(k).visibility !== 'hidden');
        const boxes = kids.map((k) => k.getBoundingClientRect()), bad = [];
        boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b, j) => a.right > b.left + 0.5 && b.right > a.left + 0.5 && bad.push(`${kids[i].className} over ${kids[i + 1 + j].className}`)));
        boxes.forEach((b, i) => (b.left < rr.left - 0.5 || b.right > rr.right + 0.5) && bad.push(`${kids[i].className} past the Composer's edge`));
        const place = row.querySelector('#dest-chip b'), ctx = document.createElement('canvas').getContext('2d');
        ctx.font = getComputedStyle(place).font;
        if (place.getBoundingClientRect().width + 0.5 < ctx.measureText(place.textContent.slice(0, 3)).width) bad.push(`the chip shows less than three characters of "${place.textContent}"`);
        const key = row.querySelector('.key'), says = key.innerText.replace(/\s+/g, ' ').trim();
        const placeShown = !!key.querySelector('.k-in') && getComputedStyle(key.querySelector('.k-in')).display !== 'none';
        if (placeShown && place.scrollWidth > place.clientWidth + 0.5) bad.push(`the chip is cut ("${place.textContent}") while the key says "${says}"`);
        return { says, bad };
      }, sel);
      const footAt = [...[540, 600, 660, 720, 900, 1180].map((w) => ['home', w]), ['sheet', 1180], ['notch', 560]];
      for (const [engine, b] of both)
        for (const [at, w] of footAt) {
          const p = await open(b, { label: at === 'notch' ? 'notch' : 'workspace', records: longRecords(), url: server.url, dpr: 1, viewport: { width: w, height: at === 'notch' ? 520 : 800 } });
          if (at === 'notch') (await p.evaluate((g) => window.__fake.emit(g), GEO), await p.evaluate(() => window.__fake.emit({ do: 'capture' })), await p.waitForTimeout(700));
          else if (at === 'sheet') (await p.evaluate(() => ((window.__ws.ui.sheet = { kind: 'capture' }), window.__motion.redraw())), await p.waitForTimeout(500), await p.focus(`.sheet ${FIELD}`));
          else await p.focus(FIELD);
          await sendIt(p);
          await arrived(p);
          await p.waitForTimeout(100);
          const f = await footOf(p, at === 'sheet' ? '.sheet' : at === 'home' ? '.home' : '');
          expect(['Start in customer-portal-f…', 'Start'].includes(f.says.replace(/^\S*\s*(?=Start)/, '')) && !f.bad.length,
            `${engine}, ${SURFACES[at]} at ${w} px, "${LONG}" first: the key says "${f.says}"${f.bad.length ? `; ${f.bad.join('; ')}` : ''}`);
          await p.context().close();
        }

      // Every way of putting text in at the first start's sheet reaches the Composer, and puts the sheet away as Not
      // now: a space first, a character with Option or with AltGr, a paste (as the Edit menu does it), in both engines.
      for (const [engine, b] of both)
        for (const [how, act, want] of [
          ['a space first', (p) => p.keyboard.type(' hello', { delay: 40 }), (v) => v === ' hello'],
          ['Option-e, then e', async (p) => (await p.keyboard.press('Alt+KeyE'), await p.keyboard.type('e', { delay: 40 })), (v) => v.length >= 1 && v.endsWith('e')],
          ['AltGr-q, then x', async (p) => (await p.keyboard.press('Control+Alt+KeyQ'), await p.keyboard.type('x', { delay: 40 })), (v) => v.length >= 1 && v.endsWith('x')],
          ['a paste', (p) => p.keyboard.insertText('pasted thought'), (v) => v === 'pasted thought'],
        ]) {
          const p = await open(b, { label: 'workspace', records: projects('first-agents'), url: server.url, dpr: 1 });
          await settled(p);
          await act(p);
          await p.waitForTimeout(300);
          const v = await value(p);
          expect(want(v) && !(await allowed(p)) && !(await p.evaluate(() => window.__ws.ui.sheet)) && (await notNow(p)),
            `${engine}, the first start, ${how}: the Composer holds "${v}", the sheet ${await p.evaluate(() => window.__ws.ui.sheet?.kind ?? 'gone')}, allowed ${await allowed(p)}`);
          await p.context().close();
        }
      if (wk) await wk.close();

      // ——— The review's third pass: what was found put away by typing, the held-back sentence for every sheet, a sheet
      // that leaves the keyboard in the Composer not modal, "you chose it", Setup only its header under a step's sheet ———
      const firstUp = (records = projects('first-agents')) => open(browser, { label: 'workspace', records, url: server.url, dpr: 1 });
      const sheetSays = (page) => page.evaluate(() => document.querySelector('.sheet #sheet-title')?.textContent ?? '');
      const toFound = async (page) => {
        await settled(page);
        await page.keyboard.press('Enter');
        await until(() => allowed(page), (v) => v);
        await page.evaluate(() => window.__fake.offer?.());
        await page.waitForFunction(() => /^Found/.test(document.querySelector('.sheet #sheet-title')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
      };
      // What was found: the first text typed into the Composer under it puts it away and stays; Return with the field
      // empty is Done.
      page = await firstUp();
      await toFound(page);
      await page.waitForTimeout(800);
      const foundTitle = await sheetSays(page);
      await page.keyboard.type('a thought', { delay: 30 });
      await page.waitForTimeout(300);
      expect(/^Found/.test(foundTitle) && !(await page.evaluate(() => window.__ws.ui.sheet)) && (await value(page)) === 'a thought',
        `typing on "${foundTitle}": the sheet ${await page.evaluate(() => window.__ws.ui.sheet?.kind ?? 'gone')}, the Composer holds "${await value(page)}"`);
      await page.context().close();
      page = await firstUp();
      await toFound(page);
      await page.waitForTimeout(800);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      expect(!(await page.evaluate(() => window.__ws.ui.sheet)) && (await calls(page, 'thought.capture')) === 0, `Return with the field empty on what was found: the sheet ${await page.evaluate(() => window.__ws.ui.sheet?.kind ?? 'gone')}, ${await calls(page, 'thought.capture')} thoughts sent`);
      await page.context().close();

      // The held-back sentence reads as a sentence on every sheet that comes by itself: what Return will do, as a verb.
      // (Return pressed in the page the moment the title is there; a machine too busy for that to be within the sheet's
      // first 600 ms says nothing held back, and is tried again.)
      const heldSays = async (page, untilTitle) => {
        await page.evaluate((t) => new Promise((done) => {
          const end = performance.now() + 15000;
          const tick = () => ((new RegExp(t).test(document.querySelector('.sheet #sheet-title')?.textContent ?? '') && document.querySelector('.sheet .sh-f .key')) || performance.now() > end ? done() : setTimeout(tick, 4));
          tick();
        }).then(() => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))), untilTitle);
        return until(() => page.evaluate(() => document.querySelector('.sheet .sh-held')?.textContent ?? ''), (x) => !!x, 1000);
      };
      for (const [records, title, verb] of [[projects('first-agents'), '^Find your projects', 'allow'], [projects('first-folders'), '^Choose where', 'search there']]) {
        let said = '';
        for (let attempt = 0; attempt < 3 && !said; attempt++) {
          page = await open(browser, { label: 'workspace', records: { ...records, subMs: 400 }, url: server.url, dpr: 1 });
          said = await heldSays(page, title);
          await page.context().close();
        }
        expect(said === `You were typing: press Return again to ${verb}.`, `Return at once on "${title.slice(1)}…": the sheet says "${said}", not "You were typing: press Return again to ${verb}."`);
      }
      let foundSaid = '';
      for (let attempt = 0; attempt < 3 && !foundSaid; attempt++) {
        if (attempt) await page.context().close();
        page = await firstUp();
        await settled(page);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        await page.evaluate(() => window.__fake.offer?.());
        foundSaid = await heldSays(page, '^Found');
      }
      expect(foundSaid === 'You were typing: press Return again to close.', `Return at once on what was found: the sheet says "${foundSaid}", not "You were typing: press Return again to close."`);
      await page.context().close();

      // With the keyboard in the Composer under it, the sheet is not modal, the field is described by it, and its
      // arrival is said once; Tab into it makes it modal; Shift-Tab from its first control gives the Composer back.
      page = await firstUp();
      await settled(page);
      await page.waitForTimeout(150);
      const aria = () => page.evaluate(() => {
        const s = document.querySelector('.sheet[role=dialog]'), f = document.querySelector('.home #capture-input'), by = f?.getAttribute('aria-describedby') ?? '';
        return { modal: s?.getAttribute('aria-modal'), field: document.activeElement === f, by, described: !!by && by.split(' ').every((id) => document.getElementById(id)?.textContent.trim()), said: document.getElementById('sheet-said')?.textContent ?? '' };
      });
      const sr = await aria();
      expect(sr.field && sr.modal === 'false' && sr.described && /Find your projects/.test(sr.said),
        `the first start's sheet with the keyboard in the Composer: aria-modal ${sr.modal}, the field ${sr.described ? 'described by it' : `not described (${sr.by || 'none'})`}, said "${sr.said.slice(0, 40)}"`);
      await page.keyboard.press('Tab');
      await page.waitForTimeout(150);
      const inSheet = await aria(), inIt = await page.evaluate(() => !!document.activeElement?.closest('.sheet'));
      expect(inIt && inSheet.modal === 'true' && !inSheet.by, `Tab into the first start's sheet: the keyboard ${inIt ? 'in it' : 'elsewhere'}, aria-modal ${inSheet.modal}, the field still described by "${inSheet.by}"`);
      await page.keyboard.press('Shift+Tab');
      await page.waitForTimeout(150);
      const back = await aria();
      expect(back.field && back.modal === 'false', `Shift-Tab from the sheet's first control: the keyboard ${back.field ? 'in the Composer' : 'not in the Composer'}, aria-modal ${back.modal}`);
      // While a step's sheet is up, Setup under it is its header line only: "Find your projects" is said once.
      const twice = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.offsetParent && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() === 'Find your projects')).length);
      expect(twice === 1 && !(await page.evaluate(() => !!document.querySelector('.home .setup-b'))), `the first start: "Find your projects" is shown ${twice} times, Setup ${(await page.evaluate(() => !!document.querySelector('.home .setup-b'))) ? 'open under the sheet' : 'folded'}`);
      await page.context().close();

      // An answered thought on its way says who chose: "you chose it".
      page = await asking();
      await sendIt(page);
      await arrived(page);
      await page.keyboard.press('1');
      await page.waitForTimeout(600);
      const chose = await page.evaluate(() => document.querySelector('.home .way-h')?.innerText.replace(/\s+/g, ' ').trim() ?? '');
      expect(/you chose it/.test(chose) && !/your answer/.test(chose), `an answered thought on its way says "${chose}", not "· you chose it"`);
      await page.context().close();

      // On Windows (the page told so), the same key: metal, its arrow in its ink, and its keys in Windows' words.
      page = await open(browser, { label: 'workspace', records: scene('normal'), url: server.url, dpr: 1, system: 'windows' });
      await page.focus(FIELD);
      await page.keyboard.type('a thought');
      const win = await page.evaluate(() => {
        const k = document.querySelector('.home .cap-row > .key'), arrow = k?.querySelector('svg.i');
        return [getComputedStyle(k).color, arrow && getComputedStyle(arrow).stroke, /linear-gradient/.test(getComputedStyle(k).backgroundImage), document.querySelector('.home .mic kbd')?.textContent].join(' | ');
      });
      const [ink, arrow, face, talkWords] = win.split(' | ');
      expect(ink === 'rgb(13, 13, 14)' && arrow === ink && face === 'true' && !!talkWords && !/[⌥⌘⌃⇧]/.test(talkWords), `on Windows the Composer's key, its arrow and the microphone's key say "${win}": not metal with its arrow in its ink, or a key in a Mac's signs`);
      await page.context().close();

      // The empty field's line (lines.ts).
      {
        const placeholderOf = (p, sel = '#capture-input') => p.evaluate((s) => document.querySelector(s)?.placeholder, sel);
        const rolling = (p) => p.evaluate(() => window.__lines.rolling);
        const front = (p, on) => p.evaluate((on) => window.__fake.emit({ do: 'where', front: on, notch: !on }), on);
        const setPref = (p, id, value) => p.evaluate(([id, value]) => window.__fake.push({ t: 'change', rev: (window.__rev = (window.__rev ?? 90000) + 1), sets: [{ c: 'prefs', put: [{ id, value, rev: window.__rev }] }] }), [id, value]);
        // Every roll that starts, counted from here (two copies laid over the field, hidden from screen readers).
        const watchRolls = (p) => p.evaluate(() => {
          window.__rolls = [];
          new MutationObserver((m) => m.forEach((r) => r.addedNodes.forEach((n) => n.classList?.contains('cap-lines') && window.__rolls.push({ hidden: n.getAttribute('aria-hidden') === 'true' && n.inert, name: document.querySelector('#capture-input').getAttribute('aria-label') }))))
            .observe(document.body, { childList: true, subtree: true });
        });
        const rolls = (p) => p.evaluate(() => window.__rolls.length);
        // A whole round of lines, from the one shown: until "What's next?" comes back.
        const round = (p) => p.evaluate(() => {
          const seen = [window.__lines.line];
          for (let k = 0; k < 100; k++) {
            window.__lines.next(false);
            if (window.__lines.line === "What's next?") break;
            seen.push(window.__lines.line);
          }
          return seen;
        });
        // A fresh start: "What's next?" on Home, in the New Task sheet and in the notch.
        page = await open(browser, { label: 'workspace', records: scene('normal'), url: server.url, dpr: 1 });
        expect((await placeholderOf(page)) === "What's next?", `a fresh start: Home's field says "${await placeholderOf(page)}", not "What's next?"`);
        await page.evaluate(() => ((window.__ws.ui.sheet = { kind: 'capture' }), window.__motion.redraw()));
        await whenThere(page, `.sheet ${FIELD}`, 'the New Task sheet\'s field');
        expect((await placeholderOf(page, `.sheet ${FIELD}`)) === "What's next?", `a fresh start: the New Task sheet's field says "${await placeholderOf(page, `.sheet ${FIELD}`)}", not "What's next?"`);
        await page.context().close();
        page = await open(browser, { label: 'notch', records: scene('normal'), url: server.url, dpr: 1 });
        await page.evaluate((g) => window.__fake.emit(g), GEO);
        await page.evaluate(() => window.__fake.emit({ do: 'capture' }));
        await whenThere(page, FIELD, 'the notch\'s field');
        expect((await placeholderOf(page)) === "What's next?", `a fresh start: the notch's field says "${await placeholderOf(page)}", not "What's next?"`);
        // Folded and opened again: the next line.
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.__fake.emit({ do: 'capture' }));
        const again = await until(() => placeholderOf(page), (v) => !!v && v !== "What's next?", 3000);
        expect(!!again && again !== "What's next?" && again === (await page.evaluate(() => window.__lines.line)), `the notch opened again: its field says "${again}", not the next line`);
        // No line is wider than the notch's field, at any text size.
        for (const size of ['small', 'default', 'large']) {
          await setPref(page, 'text_size', size);
          await until(() => page.evaluate(() => document.documentElement.dataset.text), (v) => v === size);
          const wide = await page.evaluate(() => {
            const f = document.querySelector('#capture-input'), cs = getComputedStyle(f), x = document.createElement('canvas').getContext('2d');
            x.font = cs.font;
            const room = f.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), out = [];
            const lines = [window.__lines.line];
            for (let k = 0; k < 100; k++) {
              window.__lines.next(false);
              if (window.__lines.line === "What's next?") break;
              lines.push(window.__lines.line);
            }
            for (const l of lines) {
              const w = x.measureText(l).width + l.length * (parseFloat(cs.letterSpacing) || 0);
              if (w > room) out.push(`"${l}" ${Math.ceil(w)} px in ${Math.floor(room)}`);
            }
            return out;
          });
          expect(!wide.length, `the notch at ${size} text: ${wide.join(', ')} is wider than its field`);
        }
        await page.context().close();

        // Home in front, the keyboard in its field, the effects Full: the line rolls about every 5 s, by copies that
        // screen readers do not see, the field's name staying "New task".
        page = await open(browser, { label: 'workspace', records: scene('normal'), url: server.url, dpr: 1 });
        await watchRolls(page);
        await front(page, true);
        // (Timed by the page from the moment the field takes the keyboard, which is when its timer starts.)
        const took = await page.evaluate(() => new Promise((done) => {
          const f = document.querySelector('#capture-input'), was = f.placeholder;
          f.focus();
          const t0 = performance.now();
          const look = () => (f.placeholder !== was ? done([Math.round(performance.now() - t0), f.placeholder]) : performance.now() - t0 > 9000 ? done([-1, was]) : setTimeout(look, 20));
          look();
        }));
        const first = await rolls(page), seen = await page.evaluate(() => window.__rolls[0] ?? null);
        expect(took[0] > 4900 && took[0] < 8000 && took[1] !== "What's next?" && first === 1 && seen?.hidden && seen?.name === 'New task',
          `Home in front with the keyboard: the line rolled after ${took[0]} ms to "${took[1]}" by ${first} rolls (${JSON.stringify(seen)}), not after about 5 s, once, by copies screen readers do not see, the field still "New task"`);
        // Every way it holds still: the timer goes at once and nothing rolls; once that is over, it rolls again.
        const DICTATION = '019a8b6c-7d10-7000-8000-0000000d1c7a';
        for (const [why, stop, go] of [
          ['the window behind', (p) => front(p, false), (p) => front(p, true)],
          ['the keyboard elsewhere', (p) => p.evaluate(() => document.activeElement.blur()), (p) => p.focus(FIELD)],
          ['words in the field', (p) => p.keyboard.type('a'), (p) => p.keyboard.press('Backspace')],
          ['a dictation', (p) => p.evaluate((id) => window.__fake.push({ t: 'change', rev: 95001, sets: [{ c: 'dictations', put: [{ id, rev: 95001, phase: 'recording', text: '', level: 0, target: { kind: 'thought' }, error: null }] }] }), DICTATION),
            (p) => p.evaluate((id) => window.__fake.push({ t: 'change', rev: 95002, sets: [{ c: 'dictations', del: [id] }] }), DICTATION)],
          ['a composition', (p) => p.evaluate(() => document.activeElement.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))), (p) => p.evaluate(() => document.querySelector('#capture-input').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))],
          ['Effects at Still', (p) => setPref(p, 'motion_ambient', 'still'), (p) => setPref(p, 'motion_ambient', 'breathing')],
          ['Effects Off', (p) => setPref(p, 'motion_ambient', 'off'), (p) => setPref(p, 'motion_ambient', 'breathing')],
          ['Reduce Motion', (p) => p.emulateMedia({ reducedMotion: 'reduce' }), (p) => p.emulateMedia({ reducedMotion: 'no-preference' })],
        ]) {
          await stop(page);
          const off = await until(() => rolling(page), (v) => !v, 3000);
          expect(!off, `with ${why} the line's timer still runs`);
          await go(page);
          const on = await until(() => rolling(page), (v) => v, 3000);
          expect(on, `after ${why} the line does not roll again`);
        }
        // Held still long enough to roll twice, nothing moves (the window behind).
        const before = await rolls(page);
        await front(page, false);
        await page.waitForTimeout(11000);
        expect((await rolls(page)) === before, 'with the window behind for 11 s, the line rolled');
        await front(page, true);
        await page.focus(FIELD);
        // A task handed off: the next line, rolled in at Full; simply there at Still, Off and Reduce Motion.
        for (const [how, set, unset] of [
          ['Full', () => {}, () => {}],
          ['Still', (p) => setPref(p, 'motion_ambient', 'still'), (p) => setPref(p, 'motion_ambient', 'breathing')],
          ['Off', (p) => setPref(p, 'motion_ambient', 'off'), (p) => setPref(p, 'motion_ambient', 'breathing')],
          ['Reduce Motion', (p) => p.emulateMedia({ reducedMotion: 'reduce' }), (p) => p.emulateMedia({ reducedMotion: 'no-preference' })],
        ]) {
          await set(page);
          await until(() => page.evaluate(() => document.documentElement.dataset.effects), (v) => (how === 'Full' ? v === 'full' : v !== 'full'), 3000);
          const was = await placeholderOf(page), n = await rolls(page);
          await page.keyboard.type(`a task handed off at ${how}`);
          await page.keyboard.press('Enter');
          const next = await until(() => placeholderOf(page), (v) => v !== was, 3000);
          const rolled = (await rolls(page)) - n;
          expect(next !== was && (how === 'Full' ? rolled === 1 : rolled === 0), `a task handed off at ${how}: the field says "${next}" after "${was}", by ${rolled} rolls`);
          await unset(page);
        }
        await page.context().close();

        // The line with the key held to talk: the key as set, on a Mac and as Windows names it; not there without voice.
        for (const [system, says] of [['mac', 'Hold ⌃⌥T and talk'], ['windows', 'Hold Ctrl+Alt+T and talk']]) {
          const voice = { ...scene('normal') };
          voice.prefs = [...(voice.prefs || []).filter((x) => !['speech_by', 'talk_key'].includes(x.id)), { id: 'speech_by', value: { server: 'https://api.openai.com', model: 'gpt-transcribe' }, rev: 1 }, { id: 'talk_key', value: { control: true, alt: true, shift: false, meta: false, code: 'KeyT' }, rev: 1 }];
          page = await open(browser, { label: 'workspace', records: voice, url: server.url, dpr: 1, system });
          const lines = await round(page);
          expect(lines[0] === "What's next?" && lines.includes(says) && !lines.some((l) => /and talk/.test(l) && l !== says), `${system}, voice set up and ⌃⌥T to talk: a round of lines is ${JSON.stringify(lines)}, without "${says}"`);
          await setPref(page, 'speech_by', null);
          const none = await round(page);
          expect(!none.some((l) => /and talk/.test(l)), `${system}, no voice: a round of lines still has ${none.filter((l) => /and talk/.test(l)).join(', ')}`);
          await page.context().close();
        }
      }

      // "Open another folder…" in the chip's list, clicked with a real pointer, asks for the folder panel and the chip
      // takes what was chosen. In WebKit (the Mac's engine) where it is installed: there a button takes no keyboard on
      // a click, and the list closed under the pointer before.
      const engines = [['chromium', browser]];
      try {
        engines.push(['webkit', await require('playwright').webkit.launch({ headless: true })]);
      } catch {
        noWebKit('"Open another folder…" is clicked in Chromium only');
      }
      for (const [name, b] of engines) {
        page = await open(b, { label: 'workspace', records: { ...scene('normal'), pick: '/Users/example/projects/inkwell' }, url: server.url, dpr: 1 });
        await page.click(FIELD);
        await clickWhenThere(page, '#dest-chip', `${name}: the chip`);
        const other = await whenThere(page, '.cap-list button:has-text("Open another folder")', `${name}: "Open another folder…" in the chip's list`);
        const box = other && (await other.boundingBox());
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(400);
        expect((await page.evaluate(() => window.__fake.picked.length)) === 1, `${name}: a click on "Open another folder…" did not ask for the folder panel`);
        // A project row of the list, clicked: it is chosen.
        await clickWhenThere(page, '#dest-chip', `${name}: the chip, again`);
        const one = await whenThere(page, '.cap-list [role=option]:has-text("fieldnotes")', `${name}: fieldnotes in the chip's list`);
        const row = one && (await one.boundingBox());
        if (row) await page.mouse.click(row.x + row.width / 2, row.y + row.height / 2);
        await page.waitForTimeout(200);
        expect((await page.evaluate(() => document.querySelector('#dest-chip b')?.textContent)) === 'fieldnotes', `${name}: a click on a project in the chip's list did not choose it`);
        await page.context().close();
        if (b !== browser) await b.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  failures.push(...restarted);
  // The chip never left its Composer while nothing else had its row.
  if (chipGone.length) failures.push(`a Composer's chip left it ${chipGone.length} times while nothing else had its row (a click there would miss); the first time the Composer was: ${chipGone[0]}`);
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? `FAIL  the Composer's field: ${failures.length} things wrong` : 'PASS  the Composer\'s field takes every key while a capture is on its way, keeps what was typed for the next thought, sends a thought once, takes one back with ⌘Z, gets a refused one\'s words back, and is measured only when its words or its width change, growing and shrinking a line at a time; its chip says where a thought goes and why, never defaults to Scratch or the newest thought\'s folder, keeps a workspace\'s folder to the sheet opened there, marks its choice in a list that has Scratch and that a click or the keyboard opens and leaves with the field\'s keyboard back, says when a choice has gone with its thought, places by a name before the workspace and by the one folder open, gives a thought kept for later by its words Undo and Send to a folder, and keeps the microphone\'s key hint whole on its line or drops it before the chip\'s place is cut; asks a just-sent thought\'s question once, at the Composer it was sent from, the field keeping the keyboard (a row\'s number, the arrows and Return answer while it is empty, Return only after 600 ms of quiet and never held down; any other key types and leaves it in Needs you), its key saying and doing what Return does; says a placed thought in one line; shows no cap where its key does nothing; puts the first start\'s sheet in Home\'s first picture or not at all, lets nothing typed land on Allow or be lost, keeps it as Not now however it is put away; says Setup quietly and where it went; reaches the agent control by ⌘J, Tab and a list that always opens, Codex first for "co"; never cuts the chip\'s reason; and lands a click on Open another folder…');
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), restarted.forEach((r) => console.log('FAIL  ' + r)), process.exit(1)));
