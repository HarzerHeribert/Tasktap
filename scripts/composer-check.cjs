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
// - where a thought goes (docs/projects-design.md, "What is there today"): the folder of a workspace the capture sheet
//   was opened in holds after that sheet is put away, or on Home's own Composer; the newest thought's folder, or
//   Scratch, is a default anywhere; the chip does not say where the thought goes and why in its few words, or its list
//   has no Scratch, or marks no row or another than the chip says; a pick holds for more than its thought, or the chip
//   goes back from it without saying so; or what is sent is not what the chip said.
// usage: node scripts/composer-check.cjs [--dist folder]   (ui/dist must be built)
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
const { scene, flow } = require('./instrument-fixtures.cjs');
const dist = path.resolve(process.argv.includes('--dist') ? process.argv[process.argv.indexOf('--dist') + 1] : path.join(__dirname, '../ui/dist'));
const GEO = { do: 'geometry', width: 104, height: 16, cutout: false, surfaceWidth: 420, surfaceOffset: 0, span: 560, pixel: 1, corner: 10, offset: 0, available: 700, collapsed: false };
const FIELD = '#capture-input';

async function main() {
  const { chromium } = require('playwright');
  const server = await serve(dist), browser = await chromium.launch({ headless: true }), failures = [];
  const expect = (ok, what) => ok || failures.push(what);
  // Home, with a thought that waits (held) and a core that answers as `core` says.
  const home = async (core) => {
    const page = await open(browser, { label: 'workspace', records: { ...flow(scene('normal'), 'held'), ...core }, url: server.url, dpr: 1 });
    await page.focus(FIELD);
    return page;
  };
  const value = (page) => page.inputValue(FIELD);
  const calls = (page, name) => page.evaluate((n) => window.__fake.calls.filter((c) => c === n).length, name);
  try {
    // Typing through a capture, and Return twice.
    let page = await home({ slow: 500 });
    await page.keyboard.type('first thought');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('and the next');
    expect((await value(page)) === 'and the next', `typed while a capture was on its way: the field holds "${await value(page)}", not "and the next"`);
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
    await page.waitForTimeout(800);
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
        try {
          await target.first().click({ timeout: 2000 });
        } catch {
          failures.push(`there is no ${name ? `"${name}" in ` : ''}${at} to click`);
        }
        await page.waitForTimeout(150);
      };
      const focused = (page) => page.evaluate(() => (document.activeElement?.closest('.cap-list') ? 'the list' : document.activeElement?.id || document.activeElement?.tagName));
      const chip = (page, at = '') => page.evaluate((s) => [...document.querySelectorAll(`${s}#dest-chip > b, ${s}#dest-chip > span`)].map((e) => e.textContent).join(' · '), at);
      // The list's rows, the one marked with a star; the list is put away again.
      const rows = async (page, at = '') => {
        await click(page, `${at}#dest-chip`);
        const all = await page.evaluate((s) => [...document.querySelectorAll(`${s}.cap-list > button`)].map((b) => (b.getAttribute('aria-selected') === 'true' ? '*' : '') + b.textContent), at);
        const into = await focused(page);
        expect(all.length > 0 && into === 'the list', `${at || 'Home '}: a click on the chip leaves ${all.length ? 'the list without the keyboard' : 'no list open'} (the keyboard is on ${into})`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);
        const back = await focused(page);
        expect(back === 'capture-input', `${at || 'Home '}: Escape in the list leaves the keyboard on ${back}, not the field`);
        return all.join(', ');
      };
      const says = async (page, words, where, at = '') => {
        const now = await chip(page, at);
        expect(now === words, `${where}: the chip says "${now}", not "${words}"`);
      };
      const marks = async (page, row, where, at = '') => {
        const all = await rows(page, at), marked = all.split(', ').filter((x) => x.startsWith('*'));
        expect(marked.length === 1 && marked[0] === `*${row}`, `${where}: the list marks ${marked.join(' and ') || 'no row'}, not "${row}" (${all})`);
        expect(all.split(', ').includes('Scratch') || all.split(', ').includes('*Scratch'), `${where}: the list has no Scratch to choose (${all})`);
      };
      const typed = async (page, text) => (await page.keyboard.type(text), await page.waitForTimeout(400));
      const sent = (page) => page.evaluate(() => window.__fake.sent);

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
      await page.waitForTimeout(150);
      const opened = await focused(page);
      expect(opened === 'the list', `Home: Tab and an arrow on the chip leave the keyboard on ${opened}, not in the list`);
      for (let i = 0; i < 6 && !(await page.evaluate(() => document.activeElement?.textContent === 'fieldnotes')); i++) await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
      const chosen = await focused(page);
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
      page = await open(browser, { label: 'workspace', records: { ...structuredClone(r), prefs: [...(r.prefs || []), { id: 'route_by', value: { agent: 'claude', model: 'haiku' }, rev: 2 }] }, url: server.url, dpr: 1 });
      const model = await chip(page);
      expect(/^Tasktap decides · .+ reads it$/.test(model), `Home, placing by a model agreed to: the chip says "${model}", not who reads the thought`);
      await page.focus(FIELD);
      await typed(page, 'fix the export in ledger-api');
      await says(page, 'ledger-api · named in it', 'Home, placing by a model agreed to, a thought that names ledger-api');
      await page.context().close();

      // One folder open (Scratch not counted): it is where a thought that names none goes, on Home and in the notch.
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
      const line = await kept(page);
      expect(line.startsWith('It named no folder; saved for later') && line.includes('Undo') && line.includes('Send to a folder'), `a thought kept for later by its words: its line says "${line}", without Undo and Send to a folder`);
      await click(page, '.capture .cap-said button', '⌘ZUndo');
      expect((await page.inputValue(FIELD)) === 'buy milk', `Undo on a thought kept for later by its words leaves "${await page.inputValue(FIELD)}" in the field`);
      await page.fill(FIELD, '');
      await keep('buy bread');
      await page.focus(FIELD);
      await page.keyboard.press('Meta+z');
      await page.waitForTimeout(300);
      expect((await page.inputValue(FIELD)) === 'buy bread', `⌘Z on a thought kept for later by its words leaves "${await page.inputValue(FIELD)}" in the field`);
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
      await says(page, 'No folder yet · saved for later', 'Home, no folder open');
      await page.context().close();

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
      const height = () => page.evaluate((f) => document.querySelector(f).getBoundingClientRect().height, field);
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
        await page.keyboard.type(' and words enough to wrap onto a second line here, and then onto a third');
        const wide = await height();
        await page.setViewportSize({ width: 400, height: 760 });
        await page.waitForTimeout(300);
        expect((await height()) > wide, `${where}: the field did not follow its width (${wide} px high, then ${await height()} in a narrower window)`);
      }
      for (const e of page.errors) failures.push(`${where}: ${e}`);
      await page.context().close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? `FAIL  the Composer's field: ${failures.length} things wrong` : 'PASS  the Composer\'s field takes every key while a capture is on its way, keeps what was typed for the next thought, sends a thought once, takes one back with ⌘Z, gets a refused one\'s words back, and is measured only when its words or its width change, growing and shrinking a line at a time; its chip says where a thought goes and why, never defaults to Scratch or the newest thought\'s folder, keeps a workspace\'s folder to the sheet opened there, marks its choice in a list that has Scratch and that a click or the keyboard opens and leaves with the field\'s keyboard back, says when a choice has gone with its thought, places by a name before the workspace and by the one folder open, gives a thought kept for later by its words Undo and Send to a folder, and keeps the microphone\'s key hint whole on its line or drops it before the chip\'s place is cut');
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
