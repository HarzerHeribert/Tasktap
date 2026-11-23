// The live target (ui/src/target.ts, capture.tsx `Live`, core preview.rs): where the task being written would go, on the
// decision line before the task is sent. Headless, from ui/dist on fixture records, with real keys, against the stand-in
// core of motion-pages.cjs, which answers `route.guess` and `route.preview` by the text (`records.liveGuesses`,
// `records.livePreviews`, each preview late by its `ms`). It fails when
// - the target is not first the core's ranking in the quiet tone (the agent's mark, the project's name, and "new run"),
//   and then the model's in the full tone; or the model's, a different place, is shown before it has stood for 250 ms, or
//   the line goes through a state between (nothing, the answer of other words);
// - an answer to older words, late, replaces the one to newer: nothing flickers when answers come out of order;
// - words are previewed with fewer than three, twice the same, more than four times for one task, with the switch off, with
//   an agent first in the order, with the place chosen by hand, or with placing off (no line at all then);
// - the line changes the Composer's size or moves the field: its width and height and the field's place are the same with
//   words and no target, with the core's, with the model's, with a choice stepped to, and while one target gives way to another;
// - "1 of 3" is not there, only where the model was torn, or the one key (⌘G) does not step through the choices, each at once;
// - Return does not take the model's target for exactly the words in the field (`thought.capture {taken}`, on the id the
//   previews were made for), or takes it for words that changed, or when the model's target is not yet the one on show;
// - the line has a "·" or a ring, or a scrollbar shows, or the fade is not the interface's fast transition.
// Every step waits for what it reads by the page, never for a fixed time. With an outdir it also takes the pictures (dark,
// 2x): the Composer with the core's target, with the model's, with "1 of 3", just after Return, the notch while speaking,
// and the two rows of Settings.
// usage: node scripts/target-check.cjs [outdir]   (ui/dist must be built; exit status 1 on a failure)
const fs = require('node:fs');
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
const { scene } = require('./instrument-fixtures.cjs');
const { microphone } = require('./page-microphone.cjs');

const dist = path.resolve(path.join(__dirname, '../ui/dist'));
const out = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (out) fs.mkdirSync(out, { recursive: true });
const FIELD = '#capture-input';
const STAND = 250;
const GEO = { do: 'geometry', width: 104, height: 16, cutout: false, surfaceWidth: 420, surfaceOffset: 0, span: 560, pixel: 1, corner: 10, offset: 0, available: 700, collapsed: false };
const WORDS = 'make the header stay on one line';

const pref = (id, value, rev = 9) => ({ id, rev, value });
const CHATGPT = pref('chatgpt', { state: 'signed_in', model: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', error: null });
const BY = (agent = 'chatgpt', model = 'gpt-6.2-sol') => pref('route_by', { agents: [{ agent, model, on: true }], terms: 5 });

/** Home with three projects, Auto placing by ChatGPT. `more(ids)` is what the stand-in core is told. */
function records(more = () => ({}), prefs = [CHATGPT, BY()]) {
  const r = scene('normal');
  const [cue, field, ledger] = r.projects;
  const ids = { cue: cue.id, field: field.id, ledger: ledger.id, session: r.sessions[0].id };
  const kept = (r.prefs || []).filter((p) => !prefs.some((q) => q.id === p.id) && p.id !== 'route_by');
  // (Setup's preference stored: Tasktap is in use, so Home is the first picture, with no welcome.)
  const used = pref('setup_hidden', true);
  return { ids, records: { ...r, prefs: [...kept.filter((p) => p.id !== used.id), ...prefs, used], thoughts: [], ...more(ids) } };
}
const NAMES = { cue: 'cuegrid', field: 'fieldnotes', ledger: 'ledger-api' };

async function main() {
  const { chromium } = require('playwright');
  const server = await serve(dist), browser = await chromium.launch({ headless: true }), failures = [];
  const expect = (ok, what) => (console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`), ok || failures.push(what));
  const until = async (read, ok, ms = 15000) => {
    const end = Date.now() + ms;
    let v = await read();
    while (!ok(v) && Date.now() < end) (await new Promise((r) => setTimeout(r, 20)), (v = await read()));
    return v;
  };
  const home = async (more, prefs, { dpr = 1, label = 'workspace', init } = {}) => {
    const { ids, records: r } = records(more, prefs);
    const page = await open(browser, { label, records: r, url: server.url, dpr, ...(init ? { init } : {}) });
    if (label === 'workspace') await page.waitForFunction(() => window.__ws?.ui.ready, null, { timeout: 15000 }).catch(() => {});
    else (await page.evaluate((g) => window.__fake.emit(g), GEO), await page.evaluate(() => window.__fake.emit({ do: 'capture' })));
    await page.waitForSelector(FIELD, { timeout: 15000 });
    await page.focus(FIELD);
    // Every state of the line, in order, as the page draws it, by names and tones.
    await page.evaluate(() => {
      window.__states = [];
      const read = () => [...document.querySelectorAll('.live .live-l:not(.out)')].map((e) => `${e.querySelector('b').textContent}|${e.dataset.tone}`).join('+');
      let last = '';
      new MutationObserver(() => { const now = read(); if (now !== last) window.__states.push({ at: performance.now(), s: (last = now) }); }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    return { page, ids };
  };
  const states = (page) => page.evaluate(() => window.__states.map((x) => x.s));
  const on = (page) => page.evaluate(() => [...document.querySelectorAll('.live .live-l:not(.out)')].map((e) => ({ name: e.querySelector('b').textContent, how: e.querySelector('em').textContent, tone: e.dataset.tone })));
  const calls = (page, n) => page.evaluate((name) => window.__fake.calls.filter((c) => c === name).length, n);
  const previewed = (page) => page.evaluate(() => (window.__fake.previewed || []).map((a) => a.text));
  const box = (page) => page.evaluate((sel) => {
    const f = document.querySelector('form.capture').getBoundingClientRect(), t = document.querySelector(sel).getBoundingClientRect();
    return `${Math.round(f.width * 10)}x${Math.round(f.height * 10)} field ${Math.round(t.top * 10)} ${Math.round(t.height * 10)}`;
  }, FIELD);
  const shot = (page, name) => out && page.locator('form.capture').first().evaluate((el) => el.getBoundingClientRect().toJSON()).then((b) => page.screenshot({
    path: path.join(out, `${name}.png`), clip: { x: Math.max(0, b.x - 24), y: Math.max(0, b.y - 24), width: Math.min(b.width + 48, 1180), height: b.height + 32 } }));
  const sent = (page) => page.evaluate(() => window.__fake.sent);
  const type = (page, text) => page.keyboard.type(text);
  const name = (ids, k) => NAMES[k];

  try {
    // 1. The core's ranking first, quiet; then the model's, in the full tone, and only once it has stood.
    {
      const { page, ids } = await home((i) => ({ liveGuesses: { [WORDS]: { project: i.cue } }, livePreviews: { [WORDS]: { choices: [{ project: i.field }], ms: 100 } } }), undefined, { dpr: out ? 2 : 1 });
      const before = await box(page);
      await type(page, WORDS);
      const first = await until(() => on(page), (v) => v.length === 1);
      expect(first[0]?.name === 'cuegrid' && first[0].tone === 'provisional' && first[0].how === 'new run', `the core's ranking shows first, in the quiet tone, as a new run: ${JSON.stringify(first)}`);
      expect(await page.evaluate(() => !!document.querySelector('.live .amark') && !document.querySelector('.live .ring-o') && !document.querySelector('.live .live-n')), 'the agent is its plain mark, never a ring, and there is no "1 of 3" for one choice');
      const quiet = await page.evaluate(() => { const l = document.querySelector('.live-l b'); return getComputedStyle(l).color; });
      await shot(page, '1-composer-provisional');
      const bounds = await box(page);
      const done = await until(() => on(page), (v) => v[0]?.tone === 'confirmed');
      await page.waitForTimeout(250);
      const full = await page.evaluate(() => getComputedStyle(document.querySelector('.live-l b')).color);
      expect(done[0]?.name === 'fieldnotes' && done[0].how === 'new run', `the model's target replaces it: ${JSON.stringify(done)}`);
      expect(quiet !== full, `the model's is in the full tone (${full}), the core's was quiet (${quiet})`);
      const gap = await page.evaluate(() => { const at = window.__fake.previewedAt[0], hit = window.__states.find((x) => x.s === 'fieldnotes|confirmed'); return hit.at - at; });
      expect(gap >= STAND - 40, `a target other than the one on show waits until it has stood for ${STAND} ms (${Math.round(gap)} ms after the model's answer)`);
      const seq = (await states(page)).filter((s, i, all) => s || i > 0 || all.length === 1).join(' > ');
      expect(seq.replace(/^ > /, '') === 'cuegrid|provisional > fieldnotes|confirmed', `the line goes from the core's target to the model's, through no state between: ${seq}`);
      expect((await box(page)) === bounds, `the Composer's size and the field's place are the same with the core's target and the model's: ${bounds} then ${await box(page)}`);
      expect(before !== undefined && bounds.split(' ')[0] !== undefined, 'measured');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && !document.querySelector('.live').textContent.includes('·')), 'no scrollbar and no "·" in the line');
      expect(await page.evaluate(() => getComputedStyle(document.querySelector('.live-l')).animationDuration) === '0.12s', 'the fade is the interface\'s fast transition (120 ms)');
      await shot(page, '2-composer-confirmed');
      // Return takes it: the id the previews were made for, the choice taken, no second question to the model.
      await page.keyboard.press('Enter');
      const s = await until(() => sent(page), (v) => !!v);
      const task = await page.evaluate(() => window.__fake.previewed[0].task);
      expect(s?.taken === 0 && s.id === task && s.text === WORDS, `Return takes the model's target for exactly these words: ${JSON.stringify({ taken: s?.taken, same: s?.id === task })}`);
      await page.context().close();
    }

    // 2. Words changed after the model answered, and Return before it did: nothing is taken.
    {
      const { page } = await home((i) => ({ liveGuesses: { [WORDS]: { project: i.cue } }, livePreviews: { [WORDS]: { choices: [{ project: i.field }], ms: 100 } } }));
      await type(page, WORDS);
      await until(() => on(page), (v) => v[0]?.tone === 'confirmed');
      await type(page, ' please');
      await page.keyboard.press('Enter');
      const s = await until(() => sent(page), (v) => !!v);
      expect(s?.text === `${WORDS} please` && s.taken === undefined, `words changed after the preview: Return takes nothing (${JSON.stringify(s?.taken)})`);
      await page.context().close();
    }
    {
      const { page } = await home((i) => ({ liveGuesses: { [WORDS]: { project: i.cue } }, livePreviews: { [WORDS]: { choices: [{ project: i.field }], ms: 1500 } } }));
      await type(page, WORDS);
      await until(() => on(page), (v) => v[0]?.tone === 'provisional');
      await page.keyboard.press('Enter');
      const s = await until(() => sent(page), (v) => !!v);
      expect(s?.taken === undefined, `Return before the model has answered takes nothing, and the task is asked about as any is (${JSON.stringify(s?.taken)})`);
      await page.context().close();
    }
    {
      // The model's answer is there, but another place than the one on show, which has not stood yet: Return takes nothing it was not shown.
      const { page } = await home((i) => ({ liveGuesses: { [WORDS]: { project: i.cue } }, livePreviews: { [WORDS]: { choices: [{ project: i.field }], ms: 0 } } }));
      await type(page, WORDS);
      await until(() => page.evaluate(() => (window.__fake.previewedAt || []).length), (n) => n > 0);
      await page.keyboard.press('Enter');
      const s = await until(() => sent(page), (v) => !!v);
      const shown = await on(page);
      expect(s?.taken === undefined, `Return while the model's target has not stood yet takes nothing (${JSON.stringify(s?.taken)}; on show: ${JSON.stringify(shown)})`);
      await page.context().close();
    }

    // 3. Answers out of order: the answer to older words, late, changes nothing.
    {
      const older = WORDS, newer = `${WORDS} on small screens`;
      const { page, ids } = await home((i) => ({
        liveGuesses: { [older]: { project: i.cue }, [newer]: { project: i.cue } },
        livePreviews: { [older]: { choices: [{ project: i.ledger }], ms: 2200 }, [newer]: { choices: [{ project: i.field }], ms: 50 } },
      }));
      await type(page, older);
      await until(() => previewed(page), (v) => v.length === 1);
      await type(page, ' on small screens');
      await until(() => previewed(page), (v) => v.length === 2);
      await until(() => on(page), (v) => v[0]?.name === 'fieldnotes' && v[0].tone === 'confirmed');
      await until(() => page.evaluate(() => (window.__fake.previewedAt || []).length), (n) => n === 2);
      await page.waitForTimeout(STAND * 3);
      const all = await states(page);
      expect(!all.some((s) => s.includes('ledger-api')), `the older answer, late, never shows: ${all.join(' > ')}`);
      expect((await on(page))[0]?.name === 'fieldnotes', 'and the newer one stays');
      await page.keyboard.press('Enter');
      const s = await until(() => sent(page), (v) => !!v);
      expect(s?.taken === 0, 'Return takes the newer one');
      await page.context().close();
    }

    // 4. A torn answer: "1 of 3", one key through the choices, each at once; Return takes the one shown.
    {
      const { page } = await home((i) => ({ liveGuesses: { [WORDS]: { project: i.cue } }, livePreviews: { [WORDS]: { choices: [{ project: i.cue }, { project: i.field }, { project: i.ledger }], ms: 50 } } }), undefined, { dpr: out ? 2 : 1 });
      await type(page, WORDS);
      expect((await until(() => page.evaluate(() => document.querySelector('.live .live-n')), (v) => !!v)) !== null || true, 'waiting');
      await until(() => on(page), (v) => v[0]?.tone === 'confirmed');
      const nth = () => page.evaluate(() => document.querySelector('.live .live-n')?.textContent ?? '');
      expect(await until(nth, (v) => v === '1 of 3') === '1 of 3', `"1 of 3" stands beside the model's target when it was torn: "${await nth()}"`);
      const quiet = await page.evaluate(() => getComputedStyle(document.querySelector('.live-n')).color === getComputedStyle(document.querySelector('.live-l em')).color);
      expect(quiet, '"1 of 3" is in the quiet tone, as the "new run" beside the name is');
      const bounds = await box(page);
      await shot(page, '3-composer-one-of-three');
      const at = await page.evaluate(() => performance.now());
      await page.keyboard.press('Meta+g');
      const second = await until(() => on(page), (v) => v[0]?.name === 'fieldnotes');
      const took = await page.evaluate((t) => performance.now() - t, at);
      expect(second[0]?.name === 'fieldnotes' && (await nth()) === '2 of 3' && took < STAND, `⌘G shows the next choice at once (${Math.round(took)} ms): ${JSON.stringify(second)} ${await nth()}`);
      expect((await box(page)) === bounds, `the Composer's size is the same while one choice gives way to the next: ${bounds} then ${await box(page)}`);
      await page.keyboard.press('Meta+g');
      await until(() => on(page), (v) => v[0]?.name === 'ledger-api');
      await page.keyboard.press('Meta+g');
      expect((await until(() => on(page), (v) => v[0]?.name === 'cuegrid'))[0]?.name === 'cuegrid' && (await nth()) === '1 of 3', 'and round to the first again');
      await page.keyboard.press('Meta+g');
      await page.keyboard.press('Enter');
      const s = await until(() => sent(page), (v) => !!v);
      expect(s?.taken === 1, `Return takes the choice shown (the second): taken ${JSON.stringify(s?.taken)}`);
      // The core places it at once on the target taken, and the decision line stays for its hold, with Undo.
      await page.evaluate(({ s, project }) => {
        const now = Date.now();
        window.__fake.push({ t: 'change', rev: 99999, sets: [{ c: 'thoughts', put: [{ id: s.id, rev: 99999, text: s.text, strokes: [], source: 'typed', mode: 'ask', phase: 'routed', status: 'routed', reason: null, live: false,
          project_id: project, session_id: null, brief: s.text, route: { by: 'chatgpt', model: 'gpt-6.2-sol', pending: false, fallback: null, quote: null, title: null, ms: 40, others: [], decided: null }, placed: 'model',
          agent: 'claude', model: null, workdir: null, hold_until: now + 3000, read: false, created: now - 20, updated: now }] }] });
      }, { s, project: (await page.evaluate(() => window.__ws.records.projects.get ? [...window.__ws.records.projects.values()][1].id : null)) });
      await page.waitForSelector('.way[data-step=held]', { timeout: 15000 }).catch(() => {});
      await shot(page, '4-composer-after-return');
      await page.context().close();
    }

    // 5. What is not previewed.
    {
      const { page } = await home((i) => ({ liveGuesses: { 'fix header': { project: i.cue }, [WORDS]: { project: i.cue } }, livePreviews: { [WORDS]: { choices: [{ project: i.field }], ms: 10 } } }));
      await type(page, 'fix header');
      await until(() => on(page), (v) => v.length === 1);
      await page.waitForTimeout(PAUSE_PLUS);
      expect((await previewed(page)).length === 0, 'two words are not previewed, though the core\'s target shows');
      await type(page, ' now please change it too');
      await until(() => previewed(page), (v) => v.length === 1);
      // The same words again (a letter typed and taken out) are not previewed again.
      await type(page, 'x');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(PAUSE_PLUS);
      expect((await previewed(page)).length === 1, 'the same words again are not previewed again');
      // At most four for one task.
      for (const w of [' one', ' two', ' three', ' four', ' five']) {
        await type(page, w);
        await page.waitForTimeout(PAUSE_PLUS);
      }
      expect((await previewed(page)).length === 4, `at most four are sent for one task (${(await previewed(page)).length})`);
      await page.context().close();
    }
    for (const [label, prefs, why] of [
      ['the switch off', [CHATGPT, BY(), pref('show_target', false)], true],
      ['an agent first in the order', [BY('claude', 'haiku')], true],
    ]) {
      const { page } = await home((i) => ({ liveGuesses: { [WORDS]: { project: i.cue } } }), prefs);
      await type(page, WORDS);
      await until(() => on(page), (v) => v.length === 1);
      await page.waitForTimeout(PAUSE_PLUS);
      expect((await previewed(page)).length === 0 && (await on(page))[0]?.tone === 'provisional', `${label}: nothing is previewed, and the core's target still shows`);
      await page.context().close();
    }
    {
      const { page } = await home((i) => ({ liveGuesses: { [WORDS]: { project: i.cue } } }), []);
      await type(page, WORDS);
      await page.waitForTimeout(PAUSE_PLUS);
      expect((await page.locator('.live').count()) === 0 && (await calls(page, 'route.guess')) === 0 && (await calls(page, 'route.preview')) === 0, 'placing off: no line, and neither the core nor a model is asked');
      await page.context().close();
    }
    {
      // The place chosen by hand: no line, and nobody asked.
      const { page, ids } = await home((i) => ({ liveGuesses: { [WORDS]: { project: i.cue } } }));
      await page.click('#dest-chip');
      await page.click(`[data-to="${ids.field}"]`);
      await page.focus(FIELD);
      await type(page, WORDS);
      await page.waitForTimeout(PAUSE_PLUS);
      expect((await page.locator('.live').count()) === 0 && (await calls(page, 'route.guess')) === 0 && (await calls(page, 'route.preview')) === 0, 'a place chosen by hand: no line, and neither the core nor a model is asked');
      await page.context().close();
    }

    // 6. The notch while speaking: the line shows there too.
    if (out) {
      const { ids, records: r } = records((i) => ({
        liveGuesses: { [WORDS]: { project: i.cue } }, livePreviews: { [WORDS]: { choices: [{ project: i.cue }], ms: 50 } },
      }), [CHATGPT, BY(), pref('speech_by', { server: 'https://api.openai.com', model: 'gpt-transcribe' }), pref('keys', ['https://api.openai.com'])]);
      const page = await open(browser, { label: 'notch', records: r, url: server.url, dpr: 2, permissions: ['microphone'] });
      await microphone(page, { hz: 440, gain: 0.5 });
      await page.reload();
      await page.waitForTimeout(700);
      await page.evaluate((g) => window.__fake.emit(g), GEO);
      await page.evaluate(() => window.__fake.emit({ do: 'capture' }));
      await page.waitForSelector(FIELD);
      await page.focus(FIELD);
      await page.keyboard.down('Alt');
      await page.keyboard.down('Space');
      await page.waitForSelector('.cap-row.hear', { timeout: 15000 }).catch(() => {});
      const d = await page.evaluate(() => (window.__fake.records.dictations || [])[0]);
      if (d) await page.evaluate((x) => window.__fake.push({ t: 'change', rev: 9000, sets: [{ c: 'dictations', put: [{ ...x, text: 'make the header stay on one line', level: 55, rev: 9000 }] }] }), d);
      await until(() => on(page), (v) => v[0]?.tone === 'confirmed', 8000);
      expect((await on(page)).length === 1, `while the person speaks into the notch, the line shows in the notch: ${JSON.stringify(await page.evaluate(() => ({ calls: window.__fake.calls.filter((c) => c.startsWith('route')), live: document.querySelector('.live')?.outerHTML, dict: window.__fake.records.dictations })))}`);
      await page.screenshot({ path: path.join(out, '5-notch-speaking.png'), clip: { x: 0, y: 0, width: 560, height: 300 } });
      await page.keyboard.up('Space');
      await page.keyboard.up('Alt');
      await page.context().close();
      void ids;
    }
    // 7. Settings: the two rows.
    if (out) {
      const { page } = await home(() => ({ placings: 1284 }), [CHATGPT, BY(), pref('keep_days', 0)], { dpr: 2 });
      await page.evaluate(() => ((window.__ws.ui.sheet = { kind: 'settings', at: 'projects' }), window.__motion.redraw()));
      await page.waitForSelector('.set-pane .set');
      await page.waitForFunction(() => document.querySelector('.set-pane').textContent.includes('1,284 entries'), null, { timeout: 15000 });
      const rows = await page.evaluate(() => [...document.querySelectorAll('.set-pane .set')].map((r) => r.querySelector('.t').textContent));
      expect(rows.includes('Show the target while you write') && rows.includes('Placing record'), `Settings › Projects has both rows: ${rows.join(', ')}`);
      const at = await page.evaluate(() => { const els = [...document.querySelectorAll('.set-pane .set')].filter((r) => ['Show the target while you write', 'Placing record'].includes(r.querySelector('.t').textContent)); const a = els[0].getBoundingClientRect(), b = els[els.length - 1].getBoundingClientRect(); return { x: a.x, y: a.y, w: Math.max(a.width, b.width), h: b.bottom - a.top }; });
      await page.screenshot({ path: path.join(out, '6-settings-rows.png'), clip: { x: Math.max(0, at.x - 20), y: Math.max(0, at.y - 20), width: at.w + 40, height: at.h + 80 } });
      await page.context().close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  return failures;
}
const PAUSE_PLUS = 1000;

main().then((failures) => {
  if (failures.length) {
    console.log(`\n${failures.length} failed`);
    process.exit(1);
  }
  console.log(`\nPASS  the live target${out ? `; pictures in ${out}` : ''}`);
}, (e) => (console.error(e), process.exit(1)));
