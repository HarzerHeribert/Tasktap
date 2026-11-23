// Settings › Placing (ui/src/workspace/consent.tsx, docs/core-design.md §8), from ui/dist in headless Chromium on
// fixture records, by the keyboard and the pointer: the section stands after Agents, on its key; its switch is the
// agreement, written in Tasktap's order, and turns placing off again; the placers are rows under it, always, with
// "Sign in with ChatGPT" and the own model in view where nothing is opened; a row moved by ⌥↓ and ⌥↑, switched by Space
// and dragged is written at once; an agent at its usage limit says until when; an agreement to the terms before is asked
// again; signing in with ChatGPT, signing out and why a sign-in did not finish; "What is sent" and the instructions open
// in place; the own model, set up, changed and removed. Its rows cut nothing and it has one metal key.
// Pictures of each into <outdir>. Invented records only; no host, no core, no agent.
// usage: node scripts/placing-check.cjs <outdir> [--dist <folder>]
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { serve, open } = require('./motion-pages.cjs');
const { flow, scene } = require('./instrument-fixtures.cjs');

const failures = [];
const expect = (ok, what) => (console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`), ok || failures.push(what));

/** The normal scene with Antigravity signed in too, and these preferences. */
function records(prefs = []) {
  const r = scene('normal');
  r.agents.push({ ...r.agents[0], id: 'agy', name: 'Antigravity', version: '1.5.11', identity: null });
  r.prefs = [...(r.prefs || []), ...prefs];
  return r;
}

/** The rows as they read: each one's place among those on, its name, and "off" where it is switched off. ChatGPT's row
 *  while it is not signed in (`.sign`) is none of them. */
const rows = (page, where = '.settings') => page.evaluate((w) => [...document.querySelectorAll(`${w} .rank:not(.sign)`)].map((r) =>
  `${r.querySelector('.n').textContent}${r.querySelector('.t').textContent}${r.querySelector('.switch').getAttribute('aria-checked') === 'true' ? '' : ' off'}`).join(', '), where);
const stored = (page) => page.evaluate(() => JSON.stringify((window.__fake.records.prefs || []).find((p) => p.id === 'route_by')?.value ?? null));
const focused = (page) => page.evaluate(() => document.activeElement?.querySelector?.('.t')?.textContent ?? document.activeElement?.className);
const press = async (page, key) => (await page.keyboard.press(key), await page.waitForTimeout(120));
const shoot = (page, out, name) => page.locator('.sheet').screenshot({ path: path.join(out, `${name}.png`) });

/** No row of the section cuts its words, and Return gives at most one metal key. */
async function fits(page, what) {
  const m = await page.evaluate(() => {
    const cut = [...document.querySelectorAll('.settings .rank .x')].filter((x) => x.scrollWidth > x.clientWidth + 1);
    return { cut: cut.map((x) => x.textContent), keys: document.querySelectorAll('.sheet .sh-f .key').length };
  });
  expect(!m.cut.length, `${what}: no row cuts its words ${JSON.stringify(m.cut)}`);
  expect(m.keys <= 1, `${what}: at most one metal key (${m.keys})`);
}
/** Settings, at Placing. */
const placingAt = async (page) => (await page.evaluate(() => window.__ws.open({ kind: 'settings', at: 'placing' })), page.waitForTimeout(500));
/** The switch that is the agreement: whether it is on. */
const master = (page) => page.evaluate(() => document.querySelector('.settings [role=switch][aria-label="Find the project for each task"]')?.getAttribute('aria-checked'));
const visible = (page, sel) => page.evaluate((q) => { const e = document.querySelector(q); return !!e && e.getBoundingClientRect().height > 0; }, sel);

async function main(out, dist) {
  fs.mkdirSync(out, { recursive: true });
  const server = await serve(dist);
  const browser = await chromium.launch();
  try {
    // The section stands after Agents, on the key after Agents'.
    let page = await open(browser, { label: 'workspace', records: records(), url: server.url, dpr: 2 });
    await placingAt(page);
    const tabs = await page.evaluate(() => [...document.querySelectorAll('.set-nav [role=tab]')].map((t) => `${t.querySelector('span').textContent} ${t.lastElementChild.textContent}`));
    expect(tabs.slice(0, 4).join() === 'Tasks ⌘1,Agents ⌘2,Placing ⌘3,Projects ⌘4' && tabs.length === 8, `the section stands after Agents, on ⌘3: ${tabs}`);
    expect(await page.evaluate(() => document.querySelector('#set-tab-placing')?.getAttribute('aria-selected')) === 'true', 'and is the one shown');
    // Nothing agreed: the switch is off, and every placer is a row, in view, none on.
    expect(await master(page) === 'false' && await rows(page) === 'Claude Code off, Codex off, Antigravity off', `nothing agreed: the switch is off, and every row with it: ${await rows(page)}`);
    expect(await visible(page, '.settings .rank.sign:not(.mine) .btn') && await visible(page, '.settings .rank.mine .btn'), 'with "Sign in with ChatGPT" and the own model in view, nothing opened');
    const why = await page.evaluate(() => [...document.querySelectorAll('.settings .rank:not(.sign)')].map((r) => `${r.querySelector('.x.m').textContent}, ${r.querySelector('.x:not(.m)').textContent}`));
    expect(why[0] === 'haiku, about 4 s', `the model and the time of the first, each in a place of its own: "${why[0]}"`);
    expect(why[2] === 'gemini-3.8-flash-low, about 6 s', `and of the last: "${why[2]}"`);
    // On the surface: the rows and two quiet lines, no sentence of what is sent.
    const surface = await page.evaluate(() => ({ text: document.querySelector('.settings').textContent, lines: [...document.querySelectorAll('.settings .disc')].map((d) => d.textContent), sent: !!document.querySelector('.settings .terms.sent'), instr: !!document.querySelector('.settings .instr') }));
    expect(surface.lines.join() === 'What is sent,The instructions they follow' && !surface.sent && !surface.instr && !surface.text.includes('likely projects'), `two quiet lines, closed: ${surface.lines}`);
    await fits(page, 'Placing, off');
    await shoot(page, out, 'placing-off');
    // "What is sent" opens in place: who is asked, what is sent, what signing in does; Antigravity keeps each task only while it is on.
    await page.getByRole('button', { name: 'What is sent' }).click();
    await page.waitForTimeout(200);
    const said = await page.evaluate(() => document.querySelector('.settings .terms.sent').textContent);
    expect(said.includes('goes to the first agent below that answers, one task at a time') && said.includes('up to 8 likely projects'), 'the sentence says who is asked and what is sent');
    expect(!said.includes('Antigravity keeps'), 'and nothing of Antigravity while it is off');
    const sign = await page.evaluate(() => {
      const kids = [...document.querySelectorAll('.settings .terms.sent > *')], offer = kids.findIndex((k) => k.textContent.startsWith('Sign in with ChatGPT and '));
      return { order: [kids.findIndex((k) => k.matches('ul.sends')), offer], offer: kids[offer]?.textContent };
    });
    expect(sign.offer === 'Sign in with ChatGPT and every task you do not place yourself goes to OpenAI, where gpt-6.2-sol finds the project in one direct call on your ChatGPT plan. No agent is started for the placing, and each placing counts against your plan like any other use of ChatGPT.', `what signing in does: "${sign.offer}"`);
    expect(sign.order[0] >= 0 && sign.order[0] < sign.order[1], `what is sent, then what signing in does: ${sign.order}`);
    await shoot(page, out, 'placing-what-is-sent');
    await page.getByRole('button', { name: 'What is sent' }).click();
    // The instructions open in place too.
    await page.getByRole('button', { name: 'The instructions they follow' }).click();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (document.querySelector('.settings pre.instr')?.textContent ?? '').length) > 50, 'the instructions open in place, in full');
    await page.getByRole('button', { name: 'The instructions they follow' }).click();
    // The switch is the agreement: Tasktap's order, each on, written with the terms of now; the places follow.
    expect(await stored(page) === 'null', 'nothing is stored before the switch is turned on');
    await page.locator('.settings [role=switch][aria-label="Find the project for each task"]').click();
    await page.waitForTimeout(300);
    const agreed = '{"agents":[{"agent":"claude","model":"haiku","on":true},{"agent":"codex","model":"gpt-6-luna","on":true},{"agent":"agy","model":"gemini-3.8-flash-low","on":true}],"terms":5}';
    expect(await stored(page) === agreed, `the switch writes the agreement, in Tasktap's order: ${await stored(page)}`);
    expect(await master(page) === 'true' && await rows(page) === '1Claude Code, 2Codex, 3Antigravity', `on, with the places: ${await rows(page)}`);
    expect(await page.evaluate(() => window.__ws.ui.sheet?.kind) === 'settings', 'and Settings stays where it is');
    await fits(page, 'Placing, on with agents');
    await shoot(page, out, 'placing-on-agents');
    // By the keyboard: past ChatGPT's button and the own model's into the first row, Claude Code down one, to Antigravity, it up one.
    await page.focus('.settings .rank:not(.sign)');
    expect(await focused(page) === 'Claude Code', `the first row takes the keyboard (${await focused(page)})`);
    await press(page, 'Alt+ArrowDown');
    expect(await rows(page) === '1Codex, 2Claude Code, 3Antigravity', `⌥↓ moves it down one: ${await rows(page)}`);
    expect(await focused(page) === 'Claude Code', 'the moved row keeps the keyboard');
    expect(JSON.parse(await stored(page)).agents.map((a) => a.agent).join(' ') === 'codex claude agy', 'and it is written at once');
    await press(page, 'ArrowDown');
    await press(page, 'Alt+ArrowUp');
    expect(await rows(page) === '1Codex, 2Antigravity, 3Claude Code', `⌥↑ moves it up one: ${await rows(page)}`);
    await press(page, 'Alt+ArrowUp');
    await press(page, 'Alt+ArrowUp');
    expect(await rows(page) === '1Antigravity, 2Codex, 3Claude Code', `at the top it stays: ${await rows(page)}`);
    await press(page, 'ArrowDown');
    await press(page, 'Space');
    expect(await rows(page) === '1Antigravity, Codex off, 2Claude Code', `Space switches it off, and the places follow: ${await rows(page)}`);
    expect((await stored(page)).includes('{"agent":"codex","model":"gpt-6-luna","on":false}'), 'and the switch is written at once');
    await press(page, 'Space');
    expect(await rows(page) === '1Antigravity, 2Codex, 3Claude Code', `Space again: ${await rows(page)}`);
    // An agent at its usage limit says until when.
    await page.evaluate(() => {
      const f = window.__fake, claude = f.records.agents.find((a) => a.id === 'claude');
      f.push({ t: 'change', rev: 400, sets: [{ c: 'agents', put: [{ ...claude, rev: 400, limited: new Date(2099, 0, 1, 16).getTime() }] }] });
    });
    await page.waitForTimeout(300);
    const words = await page.evaluate(() => { const r = [...document.querySelectorAll('.settings .rank:not(.sign)')].find((x) => x.querySelector('.t').textContent === 'Claude Code'); return `${r.querySelector('.x.m').textContent} ${r.querySelector('.x:not(.m)').textContent}`; });
    // On the person's clock, as their system writes a time (here en-US: 4:00 PM; in Germany 16:00).
    expect(/^haiku out of quota until (16[.:]00|4:00\s?PM)$/.test(words), `one at its limit says until when: "${words}"`);
    await fits(page, 'Placing, an agent at its limit');
    await shoot(page, out, 'placing-limited');
    // Dragged by the pointer: Claude Code to the top.
    const box = async (i) => page.locator('.settings .rank:not(.sign)').nth(i).boundingBox();
    const from = await box(2), to = await box(0);
    await page.mouse.move(from.x + 60, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await rows(page) === '1Claude Code, 2Antigravity, 3Codex', `a row dragged to the top: ${await rows(page)}`);
    expect(JSON.parse(await stored(page)).agents.map((a) => a.agent).join(' ') === 'claude agy codex', 'and it is written');
    // Turned off again: the answer is kept as No, and every row is off.
    await page.locator('.settings [role=switch][aria-label="Find the project for each task"]').click();
    await page.waitForTimeout(300);
    expect(await stored(page) === 'null' && await master(page) === 'false' && await rows(page) === 'Claude Code off, Codex off, Antigravity off', `off again: stored ${await stored(page)}, ${await rows(page)}`);
    // A switch turned on with the agreement off is the agreement for that row alone.
    await page.focus('.settings .rank:not(.sign)');
    await press(page, 'ArrowDown');
    await press(page, 'Space');
    expect(JSON.parse(await stored(page)).agents.filter((a) => a.on).map((a) => a.agent).join() === 'codex' && await master(page) === 'true', `a row's switch is the agreement for that row: ${await stored(page)}`);
    for (const e of page.errors) failures.push(`page: ${e}`);
    await page.context().close();

    // With placing on through agents, ChatGPT's button and the own model are in view with nothing opened.
    const through = { id: 'route_by', value: { agents: [{ agent: 'claude', model: 'haiku', on: true }, { agent: 'codex', model: 'gpt-6-luna', on: true }, { agent: 'agy', model: 'gemini-3.8-flash-low', on: false }], terms: 5 }, rev: 3 };
    page = await open(browser, { label: 'workspace', records: records([through]), url: server.url, dpr: 2 });
    await placingAt(page);
    expect(await master(page) === 'true', 'placing on through agents: the switch is on');
    expect(await visible(page, '.settings .rank.sign:not(.mine) .btn') && await page.evaluate(() => document.querySelector('.settings .rank.sign:not(.mine) .btn').textContent) === 'Sign in with ChatGPT', '"Sign in with ChatGPT" is in view');
    expect(await visible(page, '.settings .rank.mine .btn') && await page.evaluate(() => document.querySelector('.settings .rank.mine .t').textContent) === 'Your own model', 'and so is the own model\'s row');
    expect(await page.evaluate(() => !document.querySelector('.settings .own, .settings .terms.sent, .settings .instr')) && await page.evaluate(() => window.__ws.ui.sheet?.kind) === 'settings', 'with nothing opened');
    expect(await rows(page) === '1Claude Code, 2Codex, Antigravity off', `the agents, in the order they are asked: ${await rows(page)}`);
    await page.getByRole('button', { name: 'What is sent' }).click();
    await page.waitForTimeout(200);
    expect(!(await page.evaluate(() => document.querySelector('.settings .terms.sent').textContent)).includes('Antigravity keeps'), 'Antigravity, off, keeps nothing');
    await page.getByRole('button', { name: 'What is sent' }).click();
    await shoot(page, out, 'placing-agents-and-others');
    for (const e of page.errors) failures.push(`page: ${e}`);
    await page.context().close();

    // Agreed to one agent under the terms before: asked again, every row off, the switch off.
    const before = { id: 'route_by', value: { agents: [{ agent: 'claude', model: 'haiku', on: true }], terms: 2 }, rev: 2 };
    page = await open(browser, { label: 'workspace', records: records([before]), url: server.url, dpr: 2 });
    await placingAt(page);
    const again = await page.evaluate(() => document.querySelector('.settings .v.warn')?.textContent ?? '');
    expect(again === 'Placing now sends more. Agree again to keep placing on.' && await master(page) === 'false', `an agreement to the terms before is asked again: "${again}"`);
    expect(await rows(page) === 'Claude Code off, Codex off, Antigravity off', `with every row off: ${await rows(page)}`);
    await fits(page, 'Placing, asked again');
    await shoot(page, out, 'placing-again');
    await page.locator('.settings [role=switch][aria-label="Find the project for each task"]').click();
    await page.waitForTimeout(300);
    expect(JSON.parse(await stored(page)).terms === 5 && await master(page) === 'true', 'agreed again, to these terms');
    for (const e of page.errors) failures.push(`page: ${e}`);
    await page.context().close();

    // Signing in with ChatGPT, never agreed before; how the browser came back is pushed as the core would.
    page = await open(browser, { label: 'workspace', records: records(), url: server.url, dpr: 2 });
    await placingAt(page);
    const click = (label, where = '.settings') => page.evaluate(([l, w]) => {
      const b = [...document.querySelectorAll(`${w} .btn`)].find((x) => x.textContent === l);
      return b ? (b.click(), true) : false;
    }, [label, where]);
    // Pressed twice before the core has answered: one sign-in, and nothing said of the second press.
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.settings .btn')].find((x) => x.textContent === 'Sign in with ChatGPT');
      b.click();
      b.click();
    });
    await page.waitForTimeout(300);
    const once = await page.evaluate(() => ({ calls: window.__fake.calls.filter((c) => c === 'chatgpt.sign_in').length, error: document.querySelector('.err')?.textContent ?? '' }));
    expect(once.calls === 1 && !once.error, `pressed twice, one sign-in and no error: ${JSON.stringify(once)}`);
    const waiting = await page.evaluate(() => ({ opened: window.__fake.opened.map((o) => o.target), said: document.querySelector('.settings .rank.sign:not(.mine) .x')?.textContent,
      button: document.querySelector('.settings .rank.sign:not(.mine) .btn')?.textContent }));
    expect(waiting.opened.join() === 'https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&state=fake', `OpenAI's page opens in the browser: ${waiting.opened}`);
    expect(waiting.said === 'Waiting for the sign-in in your browser…' && waiting.button === 'Cancel', `it waits for the browser, with Cancel: ${JSON.stringify(waiting)}`);
    expect(await stored(page) === 'null', 'nothing is agreed while it waits');
    await fits(page, 'Placing waiting for the browser');
    await shoot(page, out, 'placing-chatgpt-waiting');
    const prefs = (rev, values) => page.evaluate(([r, v]) => window.__fake.push({ t: 'change', rev: r, sets: [{ c: 'prefs', put: Object.entries(v).map(([id, value]) => ({ id, value, rev: r })) }] }), [rev, values]);
    // Signed in: the core agreed to ChatGPT's row alone and put it first.
    await prefs(500, { chatgpt: { state: 'signed_in', model: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', error: null }, route_by: { agents: [{ agent: 'chatgpt', model: 'gpt-6.2-sol', on: true }], terms: 5 } });
    await page.waitForTimeout(300);
    expect(await rows(page) === '1ChatGPT, Claude Code off, Codex off, Antigravity off' && await master(page) === 'true', `signed in, ChatGPT alone places: ${await rows(page)}`);
    const signed = await page.evaluate(() => ({ x: `${document.querySelector('.settings .rank .x.m')?.textContent}`, button: document.querySelector('.settings .rank:not(.sign) .btn')?.textContent, sign: !!document.querySelector('.settings .rank.sign:not(.mine)'),
      mark: !!document.querySelector('.settings .rank:not(.sign) svg') }));
    expect(signed.x === 'GPT-6.2 Sol' && signed.button === 'Sign out' && !signed.sign && signed.mark, `a row like the others, by its model's name, with its mark and "Sign out": ${JSON.stringify(signed)}`);
    await fits(page, 'Placing signed in with ChatGPT');
    await shoot(page, out, 'placing-chatgpt-signed-in');
    // Signed out: its row is the button again, and as no agreement was there before the sign-in, none is.
    await click('Sign out');
    await page.waitForTimeout(300);
    expect(await rows(page) === 'Claude Code off, Codex off, Antigravity off' && await master(page) === 'false', `signed out, placing as it was before: ${await rows(page)}`);
    expect(await stored(page) === 'null', 'no agreement is left');
    expect(await page.evaluate(() => document.querySelector('.settings .rank.sign:not(.mine) .btn')?.textContent) === 'Sign in with ChatGPT', 'and ChatGPT\'s button is back');
    // Why a sign-in did not finish, or ended, is said in ChatGPT's row, in the words given.
    const ends = [
      [{ state: 'failed', model: null, name: null, error: 'access_denied' }, 'The sign-in with ChatGPT did not finish: access_denied.'],
      [{ state: 'no_plan', model: null, name: null, error: null }, 'ChatGPT signed you in, but did not allow Tasktap to use your plan. Sign in again and allow the use of your plan.'],
      [{ state: 'no_model', model: null, name: null, error: null }, 'Your ChatGPT account does not offer GPT-6.2-Sol, the model Tasktap uses to find the project for a task.'],
      // OpenAI signed Tasktap out: the core keeps ChatGPT's row for the next sign-in.
      [{ state: 'signed_out', model: null, name: null, error: null }, 'ChatGPT signed Tasktap out. Sign in with ChatGPT again to keep ChatGPT placing your tasks.',
        { route_by: { agents: [{ agent: 'chatgpt', model: 'gpt-6.2-sol', on: true }], terms: 5 } }],
    ];
    for (const [i, [value, said, more]] of ends.entries()) {
      await prefs(600 + i, { chatgpt: value, ...more });
      await page.waitForTimeout(200);
      const shown = await page.evaluate(() => ({ warn: document.querySelector('.settings .rank.sign:not(.mine) .x.warn')?.textContent, button: document.querySelector('.settings .rank.sign:not(.mine) .btn')?.textContent }));
      expect(shown.warn === said && shown.button === 'Sign in with ChatGPT', `${value.state}: "${shown.warn}", and the button again`);
    }
    await fits(page, 'Placing after OpenAI signed Tasktap out');
    await shoot(page, out, 'placing-chatgpt-signed-out');
    for (const e of page.errors) failures.push(`page: ${e}`);
    await page.context().close();

    // Nobody signed in who could place: ChatGPT and the own model are what there is, and the switch has nothing to turn on.
    const nobody = records();
    nobody.agents = nobody.agents.map((a) => ({ ...a, signed_in: false }));
    page = await open(browser, { label: 'workspace', records: nobody, url: server.url, dpr: 2 });
    await placingAt(page);
    const alone = await page.evaluate(() => ({ rows: document.querySelectorAll('.settings .rank:not(.sign)').length, sign: document.querySelector('.settings .rank.sign:not(.mine) .btn')?.textContent, own: document.querySelector('.settings .rank.mine .btn')?.textContent }));
    expect(alone.rows === 0 && alone.sign === 'Sign in with ChatGPT' && alone.own === 'Set up…' && await master(page) === 'false', `ChatGPT and the own model alone: ${JSON.stringify(alone)}`);
    await page.locator('.settings [role=switch][aria-label="Find the project for each task"]').click();
    await page.waitForTimeout(200);
    expect(await stored(page) === 'null' && await master(page) === 'false', 'the switch writes no agreement where nothing can place');
    await fits(page, 'Placing with nobody signed in');
    await shoot(page, out, 'placing-chatgpt-alone');
    for (const e of page.errors) failures.push(`page: ${e}`);
    await page.context().close();

    // A task ChatGPT placed: its line under the Composer says the decision, behind its disclosure who placed it.
    const held = flow(scene('normal'), 'held'), t = held.thoughts[held.thoughts.length - 1];
    t.route = { ...t.route, by: 'chatgpt', model: 'gpt-6.2-sol' };
    page = await open(browser, { label: 'workspace', records: held, url: server.url, dpr: 2 });
    await page.waitForTimeout(500);
    const decisionSaid = await page.evaluate(() => document.querySelector('.way .way-to')?.textContent);
    expect(decisionSaid === 'cuegrid new run', `its line says the decision: "${decisionSaid}"`);
    await page.evaluate(() => document.querySelector('.way .way-more')?.click());
    await page.waitForTimeout(150);
    const by = await page.evaluate(() => document.querySelector('.way .way-n')?.textContent ?? '');
    expect(by.startsWith('Placed by ChatGPT'), `behind its disclosure, who placed it: "${by}"`);
    for (const e of page.errors) failures.push(`page: ${e}`);
    await page.context().close();

    // Smart placing (design §8, "The decision"), in the notch: the line under its Composer for a follow-up, for a new
    // run and for a model torn between places. The line names the project and how the task goes there, with no dot;
    // the other places stand on keys from 2, which place it anew; the hold runs where the decision is sure, and stands
    // still where it waits for a key. Then a new project a model proposed, leading its question, made by its one key.
    const GEO = { do: 'geometry', width: 185, height: 32, cutout: true, compact: false, surfaceWidth: 420, surfaceOffset: 0, span: 560, pixel: 2, corner: 10, offset: 0, available: 700, collapsed: false };
    const decision = (kind, edit) => {
      const r = flow(scene('normal'), kind);
      edit(r.thoughts[r.thoughts.length - 1], r.ids, r);
      return r;
    };
    const cases = [
      ['decision-continue', decision('followup-model', (t, ids) => (t.route = { ...t.route, others: [{ project: ids.projects.cuegrid }] })),
        /^cuegrid continuing\b.*\b2\b/, true, (ids) => ({ project_id: ids.projects.cuegrid }), '2', 'Make the rehearsal timer readable on mobile'],
      // A long project's name and a long session's task: the decision stays whole, the others give way.
      ['decision-long', decision('followup-model', (t, ids, r) => {
        t.route = { ...t.route, others: [{ project: ids.projects.cuegrid }] };
        r.projects.find((p) => p.id === ids.projects.cuegrid).name = 'customer-portal-frontend';
        r.sessions.find((x) => x.id === ids.timer.session).name = 'Make the rehearsal timer readable on mobile, also in landscape on small phones where the digits wrap today';
      }), /^customer-portal-frontend continuing\b.*\b2\b/, true, (ids) => ({ project_id: ids.projects.cuegrid }), '2', 'Make the rehearsal timer readable on mobile, also in landscape on small phones where the digits wrap today'],
      ['decision-new-run', decision('held', (t, ids) => (t.route = { ...t.route, others: [{ session: ids.timer.session }] })),
        /^cuegrid new run\b.*\b2\b/, true, (ids) => ({ session_id: ids.timer.session })],
      ['decision-torn', decision('held', (t, ids) => ((t.hold_until = null), (t.route = { ...t.route, others: [{ project: ids.projects.fieldnotes }, { session: ids.timer.session }] }))),
        /^cuegrid new run\b/, false, (ids) => ({ session_id: ids.timer.session }), '3'],
    ];
    // What the line shows: its words, each word beside the decision that went (`bare`, in the order they may go: the
    // disclosure's, Undo's, the other place's), and every word on it cut, by an ellipsis or by its box; the session's
    // task alone may end in one, after its second line.
    const look = () => page.evaluate(() => {
      const w = document.querySelector('.way'), h = w?.querySelector('.way-h');
      const said = (el) => el.innerText.replace(/\s+/g, ' ').trim();
      const order = [h?.querySelector(':scope > .way-more'), h?.querySelector(':scope > .act[data-undo]'), h?.querySelector(':scope > .act[data-offer]')].filter(Boolean);
      const words = [...(w?.querySelectorAll('.way-h > .way-to, .way-h > em, .way-h > * > span, .qa.rows > .ans > span, .qa.rows > .ans > i') ?? [])];
      const cut = words.filter((x) => getComputedStyle(x).display !== 'none' && (x.scrollWidth > x.clientWidth + 0.5 || /…/.test(x.textContent))).map(said);
      const bare = order.map((x) => x.hasAttribute('data-bare'));
      const handles = order.filter((x) => x.hasAttribute('data-bare')).map((x) => ({ word: x.querySelector(':scope > span').textContent, name: x.getAttribute('aria-label'), tip: x.title,
        seen: [...x.querySelectorAll(':scope > .i, :scope > kbd.keycap')].some((k) => k.getBoundingClientRect().width > 0) }));
      const s = w?.querySelector('.way-s');
      return { line: h ? said(h) : '', still: w?.querySelector('.way-hold')?.hasAttribute('data-open') ?? null, ret: !!h?.querySelector(':scope > kbd'),
        over: h ? h.scrollWidth - h.clientWidth : -1, rows: [...(w?.querySelectorAll('.qa.rows > .ans') ?? [])].map(said), cut, bare, handles,
        // In the order they go: none gone before the one ahead of it.
        ordered: bare.every((b, i) => !b || bare.slice(0, i).every(Boolean)), wraps: !!h?.hasAttribute('data-wrap'),
        // The session's task stands under the decision, never over its words.
        clear: !s || !h || ((a, b) => b.top >= a.bottom - 1)(...[h.querySelector(':scope > .way-to'), s].map((x) => { const g = document.createRange(); g.selectNodeContents(x); return g.getBoundingClientRect(); })),
        task: s?.textContent ?? '', lines: s ? Math.round(s.getBoundingClientRect().height / parseFloat(getComputedStyle(s).lineHeight)) : 0 };
    });
    const whole = (where, seen) => {
      expect(!seen.cut.length && seen.over <= 0, `${where}: no word on the line is cut, it fits (${seen.over} px over) ${JSON.stringify(seen.cut)}`);
      expect(seen.ordered, `${where}: the words go in their order, the disclosure's, Undo's, the other place's ${JSON.stringify(seen.bare)}`);
      expect(seen.clear, `${where}: the session's task stands clear under the decision`);
      expect(seen.handles.every((x) => x.seen && x.name === x.word && x.tip.startsWith(x.word)), `${where}: each word gone leaves its chevron or key, the word its name and tooltip ${JSON.stringify(seen.handles)}`);
    };
    for (const [name, r, said, runs, wants, key = '2', task = ''] of cases) {
      page = await open(browser, { label: 'notch', records: r, url: server.url, dpr: 2, viewport: { width: 560, height: 420 } });
      await page.evaluate(() => (document.documentElement.style.background = 'radial-gradient(110% 85% at 12% 0%,#41607c 0%,transparent 58%),#172433'));
      await page.evaluate((g) => window.__fake.emit(g), GEO);
      await page.evaluate(() => window.__fake.emit({ do: 'capture' }));
      await page.waitForTimeout(800);
      await page.focus('#capture-input');
      await page.waitForTimeout(150);
      await page.evaluate(() => document.fonts.ready);
      const seen = await look();
      expect(said.test(seen.line) && !seen.line.includes('·'), `${name}: the decision line says "${seen.line}"`);
      expect(seen.still === !runs && seen.ret === !runs, `${name}: its hold ${runs ? 'runs' : 'stands still, Return\'s key first'} (still ${seen.still}, Return's key ${seen.ret})`);
      whole(name, seen);
      expect(seen.task === task && seen.lines <= 2, `${name}: the session it continues on a line of its own, ${seen.lines} lines: "${seen.task}"`);
      const rowsWanted = name === 'decision-torn' ? ['2 fieldnotes new run', '3 cuegrid continuing Make the rehearsal timer readable on mobile'] : [];
      expect(JSON.stringify(seen.rows) === JSON.stringify(rowsWanted), `${name}: the other places as rows ${JSON.stringify(seen.rows)}`);
      await page.locator('.capture').screenshot({ path: path.join(out, `${name}.png`) });
      // Words in the field: the keys' caps go, and no word is cut either.
      await page.keyboard.type('x');
      await page.waitForTimeout(150);
      whole(`${name}, words in the field`, await look());
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(700);
      await page.keyboard.press(key);
      await page.waitForTimeout(200);
      const moved = await page.evaluate(() => window.__fake.updated ?? null), want = wants(r.ids);
      expect(!!moved && Object.entries(want).every(([k, v]) => moved[k] === v), `${name}: ${key} places it anew there: ${JSON.stringify(moved)}`);
      for (const e of page.errors) failures.push(`page: ${e}`);
      await page.context().close();
    }
    // At Home's width, under Home's Composer: the same line, more of its words in their room.
    for (const [name, r, said] of cases.filter(([n]) => n !== 'decision-long')) {
      page = await open(browser, { label: 'workspace', records: structuredClone(r), url: server.url, dpr: 2, viewport: { width: 1180, height: 800 } });
      await page.waitForSelector('.home .way');
      await page.focus('#capture-input');
      await page.waitForTimeout(300);
      await page.evaluate(() => document.fonts.ready);
      const seen = await look();
      expect(said.test(seen.line), `${name}, at Home: the decision line says "${seen.line}"`);
      whole(`${name}, at Home`, seen);
      const c = await page.locator('.home .capture').boundingBox(), w = await page.locator('.home .way').boundingBox();
      await page.screenshot({ path: path.join(out, `${name}-home.png`), clip: { x: c.x - 8, y: c.y - 8, width: c.width + 16, height: w.y + w.height - c.y + 16 } });
      for (const e of page.errors) failures.push(`page: ${e}`);
      await page.context().close();
    }
    // Narrower than any notch: every word beside the decision goes, and the decision takes a second line, uncut.
    {
      const [, r] = cases[1];
      page = await open(browser, { label: 'notch', records: r, url: server.url, dpr: 2, viewport: { width: 560, height: 420 } });
      await page.evaluate((g) => window.__fake.emit(g), { ...GEO, surfaceWidth: 300 });
      await page.evaluate(() => window.__fake.emit({ do: 'capture' }));
      await page.waitForTimeout(800);
      await page.focus('#capture-input');
      await page.waitForTimeout(150);
      await page.evaluate(() => document.fonts.ready);
      const seen = await look();
      whole('a line narrower than the notch', seen);
      expect(seen.bare.every(Boolean) && seen.wraps, `a line narrower than the notch: every word beside the decision went, and the decision took a second line ${JSON.stringify(seen.bare)} ${seen.wraps}`);
      await page.locator('.capture').screenshot({ path: path.join(out, 'decision-narrow.png') });
      for (const e of page.errors) failures.push(`page: ${e}`);
      await page.context().close();
    }
    // Behind a sheet Home's key caps go (parts.css `.win.dimmed`), the Composer keeping the keyboard: a word that went
    // for its cap comes back, so no control on the line is left with neither its word nor its key.
    {
      const r = structuredClone(cases[1][1]);
      r.projects.find((p) => p.id === r.ids.projects.cuegrid).name = 'customer-portal-frontend-legacy-migration';
      page = await open(browser, { label: 'workspace', records: r, url: server.url, dpr: 1, viewport: { width: 560, height: 800 } });
      await page.waitForSelector('.home .way');
      await page.focus('#capture-input');
      await page.waitForTimeout(300);
      await page.evaluate(() => document.fonts.ready);
      const before = await look();
      // The window dims alone, the keyboard staying in Home's Composer, as for a sheet that came by itself.
      await page.evaluate(() => document.querySelector('.win').classList.add('dimmed'));
      await page.waitForTimeout(300);
      const behind = await page.evaluate(() => {
        const seen = (x) => !!x && x.getBoundingClientRect().width > 0 && getComputedStyle(x).visibility !== 'hidden' && getComputedStyle(x).display !== 'none';
        const controls = [...document.querySelectorAll('.home .way-h > .way-more, .home .way-h > .act')];
        return { dimmed: !!document.querySelector('.win.dimmed'), caps: controls.some((b) => seen(b.querySelector(':scope > kbd.keycap'))),
          blind: controls.filter((b) => !seen(b.querySelector(':scope > span')) && !seen(b.querySelector(':scope > kbd.keycap, :scope > .i'))).map((b) => b.getAttribute('aria-label')) };
      });
      expect(before.bare.every(Boolean), `at 560 px, the words on Home's line went for their chevron and caps ${JSON.stringify(before.bare)}`);
      expect(behind.dimmed && !behind.caps && !behind.blind.length, `behind a sheet, Home's caps gone, every control on the line keeps its word or its key ${JSON.stringify(behind)}`);
      whole('behind a sheet', await look());
      for (const e of page.errors) failures.push(`page: ${e}`);
      await page.context().close();
    }

    // The decision's keys count 600 ms after it came and after the last key before it, as the question's: a new thought
    // begun with "2" just as the decision comes is the field's.
    {
      const r = decision('held', (t, ids) => (t.route = { ...t.route, others: [{ session: ids.timer.session }] })), t = r.thoughts.pop();
      page = await open(browser, { label: 'notch', records: r, url: server.url, dpr: 1, viewport: { width: 560, height: 420 } });
      await page.evaluate((g) => window.__fake.emit(g), GEO);
      await page.evaluate(() => window.__fake.emit({ do: 'capture' }));
      await page.waitForTimeout(800);
      await page.focus('#capture-input');
      await page.evaluate((x) => window.__fake.push({ t: 'change', rev: 9000, sets: [{ c: 'thoughts', put: [{ ...x, rev: 9000 }] }] }), t);
      await page.waitForTimeout(30);
      await page.keyboard.press('2');
      await page.waitForTimeout(100);
      const early = await page.evaluate(() => ({ field: document.querySelector('#capture-input').value, updated: window.__fake.updated ?? null, line: !!document.querySelector('.way [data-offer]') }));
      expect(early.line && early.field === '2' && !early.updated, `a "2" typed as the decision comes is the field's: ${JSON.stringify(early)}`);
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(700);
      await page.keyboard.press('2');
      await page.waitForTimeout(150);
      const later = await page.evaluate(() => window.__fake.updated ?? null);
      expect(!!later?.session_id, `600 ms on, 2 places it anew: ${JSON.stringify(later)}`);
      for (const e of page.errors) failures.push(`page: ${e}`);
      await page.context().close();
    }

    // A task a model was torn about calls the person as a question does: the notch, closed, opens by itself on its
    // capture line, where the decision takes Return and the keys; its row on the notch's Home says it waits.
    {
      const r = decision('held', (t, ids) => ((t.hold_until = null), (t.route = { ...t.route, others: [{ project: ids.projects.fieldnotes }] }))), t = r.thoughts.pop();
      page = await open(browser, { label: 'notch', records: r, url: server.url, dpr: 1, viewport: { width: 560, height: 420 } });
      await page.evaluate((g) => window.__fake.emit(g), GEO);
      await page.waitForTimeout(600);
      const before = await page.evaluate(() => !!document.querySelector('#sheet .capture'));
      await page.evaluate((x) => window.__fake.push({ t: 'change', rev: 9000, sets: [{ c: 'thoughts', put: [{ ...x, rev: 9000 }] }] }), t);
      await page.waitForTimeout(500);
      const called = await page.evaluate(() => ({ opened: !!document.querySelector('#sheet .capture'), field: document.activeElement?.id ?? '',
        line: document.querySelector('.way .way-to')?.textContent ?? '' }));
      expect(!before && called.opened && called.field === 'capture-input' && called.line === 'cuegrid new run', `a torn task opens the notch on its decision: ${JSON.stringify({ before, ...called })}`);
      for (const e of page.errors) failures.push(`page: ${e}`);
      await page.context().close();
    }

    // A model unsure of one place only: that place alone, on Return's key, with no key of another place beside it; no
    // hold runs, as with two.
    {
      const r = decision('held', (t) => ((t.hold_until = null), (t.route = { ...t.route, others: [] })));
      page = await open(browser, { label: 'notch', records: r, url: server.url, dpr: 2, viewport: { width: 560, height: 420 } });
      await page.evaluate((g) => window.__fake.emit(g), GEO);
      await page.evaluate(() => window.__fake.emit({ do: 'capture' }));
      await page.waitForTimeout(800);
      await page.focus('#capture-input');
      await page.waitForTimeout(150);
      await page.evaluate(() => document.fonts.ready);
      const seen = await look(), keys = await page.evaluate(() => document.querySelectorAll('.way [data-offer]').length);
      expect(/^cuegrid new run\b/.test(seen.line) && !seen.line.includes('·'), `decision-torn-one: the decision line says "${seen.line}"`);
      expect(seen.still === true && seen.ret === true, `decision-torn-one: its hold stands still, Return's key first (still ${seen.still}, Return's key ${seen.ret})`);
      expect(keys === 0 && !seen.rows.length, `decision-torn-one: no other place on a key, ${keys} keys and ${seen.rows.length} rows`);
      whole('decision-torn-one', seen);
      await page.locator('.capture').screenshot({ path: path.join(out, 'decision-torn-one.png') });
      for (const e of page.errors) failures.push(`page: ${e}`);
      await page.context().close();
    }

    // A notch a question opened by itself folds half a second after its answer. A task a model was torn about that comes
    // in that half second keeps it open on its line, as a question that comes then does (on a fast machine the smoke's
    // task came 0.3 s after the answer of the one before, and the notch was folded away under it).
    {
      const r = flow(scene('normal'), 'asked'), q = r.questions.pop(), at = r.thoughts.find((t) => t.id === q.thought_id), held = flow(scene('normal'), 'held').thoughts.pop();
      Object.assign(at, { status: 'captured' });
      page = await open(browser, { label: 'notch', records: r, url: server.url, dpr: 1, viewport: { width: 560, height: 420 } });
      await page.evaluate((g) => window.__fake.emit(g), GEO);
      await page.waitForTimeout(500);
      const push = (rev, sets) => page.evaluate(([rv, ss]) => window.__fake.push({ t: 'change', rev: rv, sets: ss }), [rev, sets]);
      await push(9000, [{ c: 'questions', put: [{ ...q, rev: 9000 }] }]);
      await page.waitForTimeout(500);
      const asked = await page.evaluate(() => !document.querySelector('#sheet').inert && /Which project/.test(document.querySelector('#sheet').innerText));
      await push(9001, [{ c: 'questions', put: [{ ...q, state: 'answered', answer: 'cuegrid', rev: 9001 }] }, { c: 'thoughts', put: [{ ...at, status: 'routed', rev: 9001 }] }]);
      await page.waitForTimeout(150);
      const torn = { ...held, id: at.id, text: at.text, session_id: null, project_id: r.ids.projects.cuegrid, hold_until: null, rev: 9002,
        route: { ...held.route, others: [{ project: r.ids.projects.fieldnotes }] } };
      await push(9002, [{ c: 'thoughts', put: [torn] }]);
      await page.waitForTimeout(1500);
      const called = await page.evaluate(() => ({ open: !document.querySelector('#sheet').inert, field: !!document.querySelector('#capture-input'), line: document.querySelector('.way .way-to')?.textContent ?? '' }));
      expect(asked && called.open && called.field && called.line === 'cuegrid new run', `a torn task that comes as the notch folds after an answer keeps it open on its line: ${JSON.stringify({ asked, ...called })}`);
      for (const e of page.errors) failures.push(`page: ${e}`);
      await page.context().close();
    }

    // The new project a model proposed leads the question, with its place; its key makes the folder and sends the task.
    const asked = flow(scene('normal'), 'asked'), q = asked.questions[0];
    Object.assign(q, { choices: [], places: [], notes: [], prompt: 'Which project is this task for?', create: { name: 'tide-notes', place: '~/projects', folder: '/Users/example/projects/tide-notes', exists: false } });
    Object.assign(asked.thoughts.find((t) => t.id === q.thought_id), { text: 'start a little app for the tide tables at the harbour, just a page with today and tomorrow', brief: 'Start a small app that shows the tide tables at the harbour for today and tomorrow.' });
    page = await open(browser, { label: 'workspace', records: asked, url: server.url, dpr: 2, viewport: { width: 1180, height: 900 } });
    await page.waitForSelector('.hq.open [data-question]');
    await page.waitForTimeout(500);
    await page.mouse.move(2, 2);
    const rowsSaid = await page.evaluate(() => [...document.querySelectorAll('.hq.open [data-question] .ans')].map((a) => a.innerText.replace(/\s+/g, ' ').trim()));
    expect(/^1 ?New project tide-notes in ~\/projects$/.test(rowsSaid[0] ?? '') && /Open or create a folder/.test(rowsSaid[1] ?? ''), `the new project leads the question: ${JSON.stringify(rowsSaid)}`);
    await page.evaluate(() => document.fonts.ready);
    const b = await page.locator('.hq.open').boundingBox();
    await page.screenshot({ path: path.join(out, 'new-project-card.png'), clip: { x: b.x - 16, y: b.y - 8, width: b.width + 32, height: b.height + 8 } });
    await page.evaluate(() => document.querySelector('.hq.open [data-question] .ans')?.click());
    await page.waitForTimeout(400);
    const made = await page.evaluate(() => ({ calls: window.__fake.calls.filter((c) => c === 'project.add' || c === 'thought.update'), updated: window.__fake.updated ?? null,
      project: (window.__fake.records.projects || []).find((p) => p.folder === '/Users/example/projects/tide-notes')?.id ?? null }));
    expect(made.calls.join() === 'project.add,thought.update' && !!made.updated?.project_id, `its key makes the folder and sends the task there: ${JSON.stringify(made)}`);
    for (const e of page.errors) failures.push(`page: ${e}`);
    await page.context().close();

    // ——— The own model: the model at an address the person names, under ChatGPT's row ———
    const OLLAMA = 'http://127.0.0.1:11434/v1';
    const here = (r) => ({ ...r, servers: { [OLLAMA]: ['llama3.1:8b', 'qwen2.5-coder:7b', 'gemma3:4b'] } });
    const own = (pg) => pg.evaluate(() => {
      const r = document.querySelector('.sheet .rank.mine');
      return r && { name: r.querySelector('.t').textContent, button: r.querySelector('.btn')?.textContent, quiet: r.classList.contains('off') };
    });
    const fields = (pg) => pg.evaluate(() => {
      const f = document.querySelector('.sheet .own');
      return f && { labels: [...f.querySelectorAll('label')].map((l) => l.textContent), model: f.querySelector('#own-model')?.tagName, key: f.querySelector('#own-key')?.type,
        options: [...f.querySelectorAll('#own-model option')].map((o) => o.textContent), address: f.querySelector('#own-address')?.value, chosen: f.querySelector('#own-model')?.value, buttons: [...f.querySelectorAll('.btn')].map((b) => b.textContent) };
    });
    const sheetPrefs = (pg, id) => pg.evaluate((i) => (window.__fake.records.prefs || []).find((x) => x.id === i)?.value ?? null, id);
    // Not set up, no server on this machine: one row, under ChatGPT's.
    page = await open(browser, { label: 'workspace', records: records(), url: server.url, dpr: 2 });
    await placingAt(page);
    let m = await own(page);
    const order = await page.evaluate(() => [...document.querySelectorAll('.sheet .ranks > .rank.sign')].map((r) => r.querySelector('.t').textContent));
    expect(m?.name === 'Your own model' && m.button === 'Set up…' && order.join() === 'ChatGPT,Your own model', `not set up: one row under ChatGPT's, "Set up…": ${JSON.stringify([m, order])}`);
    expect(!(await page.evaluate(() => !!document.querySelector('.sheet .own'))), 'and no field is open before the button is pressed');
    await fits(page, 'Placing with the own model not set up');
    await shoot(page, out, '1-row-not-set-up');
    // "Set up…" opens three fields in place; the model is typed while the address does not answer.
    await page.locator('.sheet .rank.mine .btn').click();
    await page.waitForTimeout(300);
    let f = await fields(page);
    expect(f?.labels.join() === 'Address,Model,Key' && f.model === 'INPUT' && f.key === 'password' && f.buttons.join() === 'Use,Cancel', `Set up… opens Address, Model, Key in place, the key as dots, the model typed: ${JSON.stringify(f)}`);
    // An address that answers fills the model's chooser with what the server lists, the first chosen.
    await page.locator('#own-address').fill(OLLAMA);
    await page.waitForTimeout(900);
    f = await fields(page);
    expect(f?.model === 'INPUT', `an address that does not answer leaves the model typed: ${f?.model}`);
    await page.context().close();

    page = await open(browser, { label: 'workspace', records: here(records()), url: server.url, dpr: 2 });
    await placingAt(page);
    await page.waitForTimeout(200);
    // A server answers on this machine and nothing is set up: the row says so and offers it, address filled.
    m = await own(page);
    expect(/^Ollama on this (Mac|PC)$/.test(m?.name ?? '') && m.button === 'Use…', `a server found on this machine: "${m?.name}", "${m?.button}"`);
    await fits(page, 'Placing with a server found');
    await page.mouse.move(2, 2);
    await page.waitForTimeout(300);
    const rim = () => page.evaluate(() => { const r = document.querySelector('.sheet .rank.mine'); return [getComputedStyle(r, '::after').opacity, getComputedStyle(r).cursor, !!r.querySelector('svg.amark path')]; });
    const at = await rim();
    await shoot(page, out, '4-server-found');
    await page.locator('.sheet .rank.mine .t').hover();
    await page.waitForTimeout(500);
    const over = await rim();
    expect(at[0] === '0' && over[0] !== '0' && over[1] === 'pointer' && at[2], `the row is one target: its rim lights under the pointer (${at[0]} to ${over[0]}), the pointer says so, and it has Ollama's mark`);
    await shoot(page, out, '4-server-found-pointer');
    // A click anywhere on the row takes its action: here on its words.
    await page.locator('.sheet .rank.mine .t').click();
    await page.waitForTimeout(500);
    f = await fields(page);
    expect(f?.address === OLLAMA && f.model === 'SELECT' && f.options.join() === 'llama3.1:8b,qwen2.5-coder:7b,gemma3:4b' && f.chosen === 'llama3.1:8b', `Use… opens the fields with the address filled and the models listed: ${JSON.stringify(f)}`);
    await page.locator('#own-key').fill('a-key-of-no-service');
    await page.waitForTimeout(700);
    const listed = await page.evaluate(() => window.__fake.listed);
    expect(listed.length > 0 && listed.every((a) => Object.keys(a).join() === 'address'), `the look at the models sends the address and no key, the key typed or not: ${JSON.stringify(listed)}`);
    await fits(page, 'Placing with the three fields open');
    await shoot(page, out, '2-fields-open');
    await page.locator('#own-model').selectOption('qwen2.5-coder:7b');
    await page.locator('.sheet .own .btn', { hasText: 'Use' }).first().click();
    await page.waitForTimeout(500);
    const kept = { own: await sheetPrefs(page, 'own_model'), keys: await sheetPrefs(page, 'keys'), by: await sheetPrefs(page, 'route_by') };
    expect(kept.own?.address === OLLAMA && kept.own.model === 'qwen2.5-coder:7b' && kept.keys.includes(OLLAMA) && kept.by.agents[0].agent === 'own', `Use sets it up, with its key, and its row is first in the agreement: ${JSON.stringify(kept)}`);
    expect(!(await page.evaluate(() => !!document.querySelector('.sheet .own'))) && await own(page) === null, 'the fields close, and the row is not the button any more');
    expect(await rows(page) === '1Your own model, Claude Code off, Codex off, Antigravity off', `set up: a row like the others: ${await rows(page)}`);
    const row = await page.evaluate(() => { const r = document.querySelector('.sheet .rank:not(.sign)'); return { model: r.querySelector('.x.m').textContent, on: r.querySelector('.switch').getAttribute('aria-checked'), button: r.querySelector('.btn')?.textContent, mark: !!r.querySelector('svg') }; });
    expect(row.model === 'qwen2.5-coder:7b' && row.on === 'true' && row.button === 'Change' && row.mark, `with the model's name as data, its switch and "Change": ${JSON.stringify(row)}`);
    await fits(page, 'Placing with the own model set up');
    await shoot(page, out, '3-row-set-up');
    // "What is sent" names the address, and that on this machine the task does not leave it.
    await page.getByRole('button', { name: 'What is sent' }).click();
    await page.waitForTimeout(200);
    const sent = await page.evaluate(() => [...document.querySelectorAll('.sheet .terms.sent > p')].map((q) => q.textContent));
    expect(sent.some((q) => /^Your own model gets each task at http:\/\/127\.0\.0\.1:11434\/v1, which is on this (Mac|PC): the task does not leave this (Mac|PC)\.$/.test(q)), `"What is sent" says where the task goes and that it stays on this machine: ${JSON.stringify(sent.filter((q) => q.startsWith('Your own')))}`);
    await page.getByRole('button', { name: 'What is sent' }).click();
    // "Change" opens the fields again with what was set; the key is dots; Cancel closes them and changes nothing.
    await page.locator('.sheet .rank .btn', { hasText: 'Change' }).click();
    await page.waitForTimeout(500);
    f = await fields(page);
    expect(f?.address === OLLAMA && f.chosen === 'qwen2.5-coder:7b' && f.buttons.join() === 'Use,Cancel,Remove', `Change opens them with what was set: ${JSON.stringify(f)}`);
    await page.locator('.sheet .own .btn', { hasText: 'Cancel' }).click();
    expect(!(await page.evaluate(() => !!document.querySelector('.sheet .own'))) && (await sheetPrefs(page, 'own_model'))?.model === 'qwen2.5-coder:7b', 'Cancel closes the fields and changes nothing');
    // Remove takes the model and its row away.
    await page.locator('.sheet .rank .btn', { hasText: 'Change' }).click();
    await page.locator('.sheet .own .btn', { hasText: 'Remove' }).click();
    await page.waitForTimeout(400);
    expect(await sheetPrefs(page, 'own_model') === null && (await own(page))?.button === 'Use…', 'Remove: the preference goes and the row is the button again');
    const dots = await page.evaluate(() => document.querySelector('.sheet').innerText.includes('·'));
    expect(!dots, 'no "·" in Settings');
    for (const e of page.errors) failures.push(`page: ${e}`);
    await page.context().close();
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

if (!process.argv[2]) {
  console.error('usage: node scripts/placing-check.cjs <outdir> [--dist <folder>]');
  process.exit(2);
}
const at = process.argv.indexOf('--dist');
main(path.resolve(process.argv[2]), path.resolve(at > 0 ? process.argv[at + 1] : path.join(__dirname, '../ui/dist'))).catch((e) => (console.error(e), process.exit(1)));
