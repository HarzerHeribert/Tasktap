// A result the person has not opened is a card; a row has a peek; no task row has a tooltip (the owner, 2026-11-22: "what
// about making this part look way better?"). From ui/dist in headless Chromium on the fixture records the other picture
// scripts use, dark, at 2x, no host, with made-up names: Results with one new card (a long task, a long project name),
// with three cards and rows, a failed card, a card at rest and under the pointer, the peek on a row in Results, the peek
// in "Find a task", the session's sheet with "Placed by". And what holds: no task row (Home's sections, Find a task, the
// sidebar's rows) carries a `title`; the newest three new results are cards and the rest, and every opened one, rows; a
// card says its task in at most 3 lines and its answer in at most 5, cut at a whole word with an ellipsis; no "·"; the
// card is one target (its rim lights at the pointer and with the keyboard, a click anywhere but on a button opens it, its
// first action is filled); a card that is opened becomes a row without a jump; the project column is as wide as the
// longest name shown, a name over 24 characters cut in the middle, the card's foot has it whole; the peek shows with the
// keyboard on a row and after the pointer rests 350 ms, covers no part of its row, shifts nothing, takes no focus and
// goes with the pointer and with the focus.
// usage: node scripts/results-card-shots.cjs <outdir>   (ui/dist must be built; exit status 1 on a failure)
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { serve, open } = require('./motion-pages.cjs');
const { scene } = require('./instrument-fixtures.cjs');

const out = path.resolve(process.argv[2] || 'results-card');
fs.mkdirSync(out, { recursive: true });
const failures = [];
const expect = (ok, what) => (console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`), ok || failures.push(what));
const VIEW = { width: 1180, height: 900 };
const LONG_PROJECT = 'fieldnotes-offline-sync-backend-service';
const LONG_TASK = 'Add offline sync for drafts so that a note written on the train is saved on the phone, kept in order and sent to the server as soon as the connection is back, without ever writing a draft twice, and make the sync loop say in the status line how many drafts are still waiting, and which of them the server refused, so that the person can tell whether leaving the train was safe';
const ANSWER = [
  '**Test Witness** passes: drafts now save locally and sync when the connection returns, in the order they were written.',
  '',
  'What changed:',
  '- a `DraftStore` keeps every unsent draft on the device',
  '- the sync loop sends *one draft at a time* and stops at the first refusal',
  '- `npm test -- sync` runs the 41 new tests',
  '',
  'Not done yet: conflicts between two phones that edited the same draft while both were offline, which need a decision about whose words win.',
].join('\n');

/** The records of a picture: which of the finished results are new, and how the first is worded. */
function records({ fresh = ['sync'], long = true } = {}) {
  const r = scene('busy');
  const by = (text) => r.thoughts.find((t) => t.text === text);
  const names = { sync: 'Add offline sync for drafts', rate: 'Rate-limit the import endpoint', beat: 'Rename Cue to Beat in the API', fonts: 'Subset the fonts for the print view', vite: 'Upgrade to Vite 7' };
  for (const k of Object.keys(names)) by(names[k]).read = !fresh.includes(k);
  const sync = by(names.sync);
  if (long) {
    sync.text = sync.brief = LONG_TASK;
    r.results.find((x) => x.thought_id === sync.id).summary = ANSWER;
    r.projects.find((p) => p.name === 'fieldnotes').name = LONG_PROJECT;
  }
  const vite = by(names.vite);
  vite.reason = 'exited';
  r.results.push({ id: vite.id.replace(/^.{8}/, '01a30000'), rev: 12, thought_id: vite.id, session_id: vite.session_id, turn: 1, kind: 'failure', summary: 'The build stopped at plugin "vite-tsconfig-paths", which does not support Vite 7 yet.' });
  // The three older results are the ones with a change count, to show the foot's changes.
  const rate = by(names.rate);
  rate.workdir = { path: '/Users/example/w', branch: 'tasktap/rate', destination: 'main', base: 'a', left_out: false, changes: 'kept', files: 3, insertions: 62, deletions: 9 };
  return { r, ids: { sync: sync.id, rate: rate.id, vite: vite.id } };
}

async function ready(page) {
  await page.waitForFunction(() => window.__ws?.ui.ready, null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => ((window.__ws.ui.fold = 'results'), window.__motion.redraw()));
  await page.waitForTimeout(500);
}
const shot = (page, name, sel) => (sel ? page.locator(sel).first() : page.locator('.hx').first()).screenshot({ path: path.join(out, `${name}.png`) });
const results = (page) => page.locator('.fold-b').first();
const titled = (page) => page.evaluate(() => [...document.querySelectorAll('.hr, .srow .row')].flatMap((row) => [row, ...row.querySelectorAll('[title]:not(.st):not(.bgi)')]).filter((e) => e.hasAttribute('title')).map((e) => `${e.className}=${e.title}`));
const rects = (page) => page.evaluate(() => [...document.querySelectorAll('.hr')].map((e) => { const b = e.getBoundingClientRect(); return [e.dataset.thought, Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)].join(':'); }).join('|') + `|${document.querySelector('.home').scrollHeight}`);
const peekOf = (page) => page.evaluate(() => {
  const p = document.querySelector('.cd-peek');
  if (!p) return null;
  const b = p.getBoundingClientRect();
  return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, text: p.innerText, events: getComputedStyle(p).pointerEvents };
});
const rowRect = (page, sel) => page.locator(sel).first().evaluate((e) => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
const apart = (a, b) => a.bottom <= b.top + 0.5 || a.top >= b.bottom - 0.5 || a.right <= b.left + 0.5 || a.left >= b.right - 0.5;

async function main() {
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true });
  const go = (recs) => open(browser, { label: 'workspace', records: recs, url: server.url, dpr: 2, viewport: VIEW });
  try {
    // ——— One new card ———
    let { r, ids } = records();
    let page = await go(r);
    await ready(page);
    await page.mouse.move(2, 2);
    const cards = await page.locator('.fold-b .hr.card').count();
    const rowsHere = await page.locator('.fold-b .hr.task:not(.card)').count();
    expect(cards === 1 && rowsHere >= 3, `one new result is one card, the opened ones rows (${cards} card, ${rowsHere} rows)`);
    expect(!(await titled(page)).length, 'no task row on Home has a title');
    await shot(page, 'results-one-card', '.folds');
    const card = await page.locator('.hr.card').first().evaluate((c) => {
      const lh = parseFloat(getComputedStyle(c.querySelector('.cd-a')).lineHeight);
      const sel = (s) => c.querySelector(s);
      return {
        task: sel('.cd-t').innerText, taskH: sel('.cd-t .cl').getBoundingClientRect().height, answer: sel('.cd-a').innerText, answerH: sel('.cd-a .cl').getBoundingClientRect().height, lh,
        foot: sel('.cd-f').innerText, glyphs: c.querySelectorAll('.cd-f .amark').length, rings: c.querySelectorAll('.ring-o').length, text: c.innerText,
        buttons: [...c.querySelectorAll('.hr-a .btn')].map((b) => b.textContent), prim: getComputedStyle(sel('.btn.pri')).backgroundColor, quiet: getComputedStyle(c.querySelectorAll('.hr-a .btn')[1]).backgroundColor,
        bold: c.querySelectorAll('.cd-a .w.b').length, code: c.querySelectorAll('.cd-a .w.code').length, items: c.querySelectorAll('.cd-a .cl-l.li').length,
        titles: c.querySelectorAll('[title]').length, rest: getComputedStyle(c, '::after').opacity,
      };
    });
    expect(card.taskH <= 3 * card.lh + 1 && card.task.endsWith('…'), `the task is cut to 3 lines with an ellipsis: "${card.task.slice(-30)}"`);
    const whole = (cut, full) => { const head = cut.replace(/…$/, '').trim(); return full.startsWith(head) && /\s/.test(full[head.length] ?? ' '); };
    expect(card.task.endsWith('…') && whole(card.task, LONG_TASK), 'the task is cut at a whole word');
    expect(card.answerH <= 5 * card.lh + 1 && card.answer.trim().endsWith('…'), `the answer is cut to 5 lines with an ellipsis (${card.answerH}px of ${card.lh}px lines)`);
    expect(card.bold >= 1 && card.code >= 1 && card.items >= 1 && !card.answer.includes('**') && !card.answer.includes('`'), `the answer shows its Markdown: ${card.bold} strong, ${card.code} code, ${card.items} list items`);
    expect(card.foot.includes(LONG_PROJECT) && card.glyphs === 1 && card.rings === 0, `the foot has the agent's plain mark and the project whole: "${card.foot.replace(/\n/g, ' ')}"`);
    expect(!card.text.includes('·') && card.titles === 0, 'no "·" and no title in the card');
    expect(card.buttons.join() === 'Open,Follow up' && card.prim !== card.quiet, `the actions are ${card.buttons.join(', ')}, the first filled (${card.prim} against ${card.quiet})`);
    expect(!/Placed by|Brief by/.test(card.text), 'the card does not say who placed the task');
    const cardEl = page.locator('.hr.card').first();
    await cardEl.hover({ position: { x: 60, y: 40 } });
    await page.waitForTimeout(450);
    const lit = await cardEl.evaluate((c) => getComputedStyle(c, '::after').opacity);
    expect(Number(card.rest) < 0.5 && Number(lit) > 0.8, `the card's rim is faint at rest (${card.rest}) and lit under the pointer (${lit})`);
    expect(await cardEl.evaluate((c) => getComputedStyle(c).cursor) === 'pointer', 'the pointer over a card is the hand');
    await shot(page, 'card-under-pointer', '.hr.card');
    await page.mouse.move(2, 2);
    await page.waitForTimeout(450);
    await shot(page, 'card-at-rest', '.hr.card');
    // A click anywhere on the card that is not a button opens the result; Return on the selected card does.
    const emptyOf = await cardEl.evaluate((c) => { const a = c.querySelector('.hr-a').getBoundingClientRect(), b = c.getBoundingClientRect(); return { x: a.right - 30, y: a.top + a.height / 2, left: b.left }; });
    await page.mouse.click(emptyOf.x, emptyOf.y);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__ws.ui.view) !== 'home', 'a click on the empty part of the card opens the result');
    await page.evaluate(() => window.__ws.show('home'));
    await ready(page);
    await page.evaluate(() => document.querySelector('.hr.card').focus({ focusVisible: true }));
    await page.waitForTimeout(450);
    expect(Number(await cardEl.evaluate((c) => getComputedStyle(c, '::after').opacity)) > 0.8, "the card's rim is lit with the keyboard on it");
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__ws.ui.view) !== 'home', 'Return on the selected card opens the result');
    // ——— The column of projects ———
    await page.evaluate(() => window.__ws.show('home'));
    await ready(page);
    const col = await page.evaluate(() => [...document.querySelectorAll('.hr.task:not(.card) .hr-p')].map((p) => ({ text: p.textContent, left: Math.round(p.getBoundingClientRect().left), w: p.getBoundingClientRect().width, cut: p.scrollWidth > p.clientWidth + 1 })));
    const longest = col.find((c) => c.text.includes('…'));
    expect(new Set(col.map((c) => c.left)).size === 1 && col.every((c) => [...c.text].length <= 24), `the project column is one column of at most 24 characters (${col.map((c) => c.text).join(', ')})`);
    expect(!longest || (longest.text.startsWith(LONG_PROJECT.slice(0, 5)) && longest.text.endsWith(LONG_PROJECT.slice(-5))), `a long name is cut in the middle: "${longest?.text}"`);
    expect(col.every((c) => !c.cut), 'no project name is cut by the column');
    // ——— A card opened becomes a row without a jump ———
    await page.mouse.move(2, 2);
    const before = await page.locator('.hr.card').first().evaluate((c) => c.getBoundingClientRect().height);
    const steps = await page.evaluate(() => new Promise((done) => {
      const row = document.querySelector('.hr.card'), heights = [row.getBoundingClientRect().height];
      window.__ws.records.thoughts.get(row.dataset.thought).read = true;
      window.__motion.redraw();
      const t0 = performance.now();
      const look = () => {
        heights.push(document.querySelector(`[data-thought="${row.dataset.thought}"]`).getBoundingClientRect().height);
        performance.now() - t0 < 500 ? requestAnimationFrame(look) : done(heights);
      };
      requestAnimationFrame(look);
    }));
    const total = Math.abs(before - steps.at(-1)), worst = Math.max(...steps.slice(1).map((h, i) => Math.abs(h - steps[i])));
    expect(!(await page.locator('.hr.card').count()) && steps.at(-1) < before && worst < total * 0.6, `an opened result is a row, and its height eased from ${Math.round(before)} to ${Math.round(steps.at(-1))} px (largest step ${Math.round(worst)}: ${steps.slice(0, 12).map(Math.round)})`);
    await page.context().close();

    // ——— Three cards and rows ———
    ({ r } = records({ fresh: ['sync', 'rate', 'beat', 'fonts'] }));
    page = await go(r);
    await ready(page);
    await page.mouse.move(2, 2);
    const three = await page.evaluate(() => ({ cards: document.querySelectorAll('.fold-b .hr.card').length, rows: document.querySelectorAll('.fold-b .hr.task:not(.card)').length, text: [...document.querySelectorAll('.fold-b .hr.card .cd-t')].map((e) => e.textContent) }));
    expect(three.cards === 3 && three.rows >= 1, `with four new results the newest three are cards and the rest rows (${three.cards} cards, ${three.rows} rows)`);
    expect(!(await titled(page)).length, 'no row carries a title with cards and rows together');
    await page.evaluate(() => document.querySelector('.fold-b').scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    await shot(page, 'results-three-cards', '.fold-b');
    await page.context().close();

    // ——— A failed card ———
    ({ r } = records({ fresh: ['vite'] }));
    page = await go(r);
    await ready(page);
    await page.mouse.move(2, 2);
    const failed = await page.locator('.hr.card').first().evaluate((c) => ({ a: c.querySelector('.cd-a').innerText, fail: c.querySelector('.cd-a').classList.contains('fail'), color: getComputedStyle(c.querySelector('.cd-a')).color, quiet: getComputedStyle(c.querySelector('.cd-f')).color, buttons: [...c.querySelectorAll('.hr-a .btn')].map((b) => b.textContent) }));
    expect(failed.fail && failed.a.startsWith('The agent exited before it finished') && failed.color !== failed.quiet, `a failed card says the failure in the warning tone: "${failed.a}"`);
    expect(failed.buttons.join() === 'Open,Try again,Follow up', `a failed card offers ${failed.buttons.join(', ')}`);
    await shot(page, 'results-failed-card', '.fold-b');
    await page.context().close();

    // ——— The peek ———
    ({ r, ids } = records({ fresh: [] }));
    page = await go(r);
    await ready(page);
    await page.mouse.move(2, 2);
    const sel = `.fold-b .hr.task[data-thought="${ids.rate}"]`;
    await page.locator(sel).scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const still = await rects(page);
    expect(await page.locator('.cd-peek').count() === 0, 'no peek at rest');
    const at = await rowRect(page, sel);
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(200);
    expect(await page.locator('.cd-peek').count() === 0, 'no peek before the pointer has rested 350 ms');
    await page.waitForTimeout(400);
    let p = await peekOf(page);
    expect(!!p && p.text.includes('Rate-limit the import endpoint') && p.text.includes('60 requests a minute') && p.text.includes('ledger-api') && p.text.includes('3 files'), `the peek shows after the pointer rests: "${(p?.text ?? '').replace(/\n/g, ' ')}"`);
    expect(!!p && apart(p, await rowRect(page, sel)), 'the peek covers no part of its row');
    expect(await rects(page) === still, 'the peek shifts nothing in the page');
    expect(p?.events === 'none' && await page.evaluate(() => !document.querySelector('.cd-peek').contains(document.activeElement) && document.activeElement?.closest('.cd-peek') === null), 'the peek takes no pointer and no keyboard focus');
    expect(!(p?.text ?? '').includes('·') && !/Placed by|Brief by/.test(p?.text ?? ''), 'no "·" in the peek, and no word of who placed the task');
    await shot(page, 'peek-in-results', '.room');
    await page.mouse.move(2, 2);
    await page.waitForTimeout(100);
    expect(await page.locator('.cd-peek').count() === 0, 'the peek goes when the pointer leaves');
    await page.evaluate((s) => document.querySelector(s).focus({ focusVisible: true }), sel);
    await page.waitForTimeout(100);
    p = await peekOf(page);
    expect(!!p && p.text.includes('Rate-limit'), 'the peek shows at once with the keyboard on the row');
    expect(await rects(page) === still, 'and shifts nothing');
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForTimeout(100);
    expect(await page.locator('.cd-peek').count() === 0, 'the peek goes when the focus leaves');
    // A row under the pointer says that a click opens it.
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(150);
    const hov = await page.locator(sel).evaluate((e) => ({ cursor: getComputedStyle(e).cursor, bg: getComputedStyle(e).backgroundColor, title: getComputedStyle(e.querySelector('.hr-t')).color }));
    expect(hov.cursor === 'pointer' && hov.bg !== 'rgba(0, 0, 0, 0)', `a row under the pointer has the hand and a lit ground (${hov.cursor}, ${hov.bg})`);
    await page.mouse.move(2, 2);
    // Find a task.
    await page.evaluate(() => window.__ws.show('earlier'));
    await page.waitForTimeout(400);
    await page.locator('#find-thought').fill('the');
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('#find-thought').blur());
    const first = '.hr.task:not(.card)';
    expect(!(await titled(page)).length, 'no row in Find a task has a title');
    const stillFind = await rects(page);
    await page.locator(first).first().scrollIntoViewIfNeeded();
    const f = await rowRect(page, first);
    await page.mouse.move(f.x, f.y);
    await page.waitForTimeout(700);
    p = await peekOf(page);
    expect(!!p && apart(p, await rowRect(page, first)) && await rects(page) === stillFind, 'the peek shows in Find a task, on no part of its row, and shifts nothing');
    await shot(page, 'peek-in-find-a-task', '.room');
    await page.context().close();

    // ——— The session's sheet: Placed by ———
    ({ r, ids } = records({ fresh: [] }));
    const t = r.thoughts.find((x) => x.id === ids.rate);
    Object.assign(t, { placed: 'picked', route: { by: 'chatgpt', model: 'gpt-6.2-sol', pending: false, fallback: null, quote: null, title: null, lead: null, ms: 900, others: [], decided: null } });
    page = await go(r);
    await ready(page);
    await page.evaluate((id) => window.__ws.open({ kind: 'session', id: window.__ws.records.thoughts.get(id).session_id }), ids.rate);
    await page.waitForTimeout(500);
    const sheet = await page.locator('.sheet .sx').innerText();
    expect(/Placed by\s*\n?\s*ChatGPT, gpt-6\.2-sol/.test(sheet) && !sheet.includes('·'), 'the session sheet has the line "Placed by" with the placer, and no "·"');
    await page.locator('.sheet').screenshot({ path: path.join(out, 'session-placed-by.png') });
    await page.context().close();
  } finally {
    await browser.close();
    await server.close();
  }
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? `FAIL  ${failures.length} checks of the result card` : `PASS  the result card, the peek and the rows as decided; pictures in ${out}`);
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
