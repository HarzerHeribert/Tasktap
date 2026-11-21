// The Placing sheet and its group in Settings (ui/src/workspace/consent.tsx, docs/core-design.md §8), from ui/dist in
// headless Chromium on fixture records, by the keyboard alone: Tasktap's order with why each stands where it does, the
// person's own order by ⌥↓ and ⌥↑, a switch by Space, nothing stored until Return allows it, which writes the agreement
// in that order; agreed, a change is written at once, and Tasktap's order comes back; an agent at its usage limit says
// until when; a row dragged by the pointer; an agreement to the terms before is asked again; the same group in
// Settings, moved by the keyboard there. The sheet fits with no scrollbar, its rows cut nothing, it has one metal key.
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
const rows = (page, where = '.sheet') => page.evaluate((w) => [...document.querySelectorAll(`${w} .rank:not(.sign)`)].map((r) =>
  `${r.querySelector('.n').textContent}${r.querySelector('.t').textContent}${r.querySelector('.switch').getAttribute('aria-checked') === 'true' ? '' : ' off'}`).join(', '), where);
const stored = (page) => page.evaluate(() => JSON.stringify((window.__fake.records.prefs || []).find((p) => p.id === 'route_by')?.value ?? null));
const focused = (page) => page.evaluate(() => document.activeElement?.querySelector?.('.t')?.textContent ?? document.activeElement?.className);
const press = async (page, key) => (await page.keyboard.press(key), await page.waitForTimeout(120));
const shoot = (page, out, name) => page.locator('.sheet').screenshot({ path: path.join(out, `${name}.png`) });

/** The sheet fits its window with no scrollbar, no row cuts its words, and Return gives the one metal key. */
async function fits(page, what) {
  const m = await page.evaluate(() => {
    const body = document.querySelector('.sheet .sh-b'), cut = [...document.querySelectorAll('.sheet .rank .x')].filter((x) => x.scrollWidth > x.clientWidth + 1);
    return { scroll: body.scrollHeight - body.clientHeight, cut: cut.map((x) => x.textContent), keys: document.querySelectorAll('.sheet .sh-f .key').length };
  });
  expect(m.scroll <= 0, `${what}: no scrollbar (${m.scroll} px over)`);
  expect(!m.cut.length, `${what}: no row cuts its words ${JSON.stringify(m.cut)}`);
  expect(m.keys <= 1, `${what}: at most one metal key (${m.keys})`);
}

async function main(out, dist) {
  fs.mkdirSync(out, { recursive: true });
  const server = await serve(dist);
  const browser = await chromium.launch();
  try {
    // Nothing agreed yet: the sheet proposes Tasktap's order, each on, and says why.
    let page = await open(browser, { label: 'workspace', records: records(), url: server.url, dpr: 2 });
    await page.evaluate(() => window.__ws.open({ kind: 'placing' }));
    await page.waitForTimeout(500);
    expect(await rows(page) === '1Claude Code, 2Codex, 3Antigravity', `Tasktap's order, each on: ${await rows(page)}`);
    const why = await page.evaluate(() => [...document.querySelectorAll('.sheet .rank:not(.sign) .x')].map((x) => x.textContent));
    expect(why[0] === 'haiku · included in your subscription · about 4 s', `why the first stands first: "${why[0]}"`);
    expect(why[2] === 'gemini-3.8-flash-low · included in your subscription · about 6 s', `and the last: "${why[2]}"`);
    const said = await page.evaluate(() => document.querySelector('.sheet .terms').textContent);
    expect(said.includes('goes to the first agent below that answers, one at a time') && said.includes('those this Mac ranks likeliest'), 'the sentence says who is asked and what is sent');
    expect(said.includes('Antigravity keeps each task it is asked about as a conversation in its history'), 'and that Antigravity keeps each');
    // ChatGPT, not signed in, is the first row, a button; above it, after what is sent, what signing in does.
    const sign = await page.evaluate(() => {
      const row = document.querySelector('.sheet .ranks > .rank'), kids = [...document.querySelectorAll('.sheet .terms > *')];
      const offer = kids.findIndex((k) => k.textContent.startsWith('Sign in with ChatGPT and '));
      return { first: row?.classList.contains('sign') && row.querySelector('.t').textContent, button: row?.querySelector('.btn')?.textContent,
        order: [kids.findIndex((k) => k.matches('ul.sends')), offer, kids.findIndex((k) => k.matches('.ranks'))], offer: kids[offer]?.textContent };
    });
    expect(sign.first === 'ChatGPT' && sign.button === 'Sign in with ChatGPT', `ChatGPT's row comes first, with its button: ${JSON.stringify(sign)}`);
    expect(sign.offer === 'Sign in with ChatGPT and a task that names no project goes to OpenAI, where gpt-6.2-sol finds the project in one direct call on your ChatGPT plan. No agent is started for the placing, and each placing counts against your plan like any other use of ChatGPT.', `what signing in does: "${sign.offer}"`);
    expect(sign.order[0] >= 0 && sign.order[0] < sign.order[1] && sign.order[1] < sign.order[2], `what is sent, then that, then the button: ${sign.order}`);
    expect((await page.evaluate(() => document.querySelector('.sheet .sh-f .key')?.textContent)) === 'Allow', 'Return allows');
    await fits(page, 'the sheet');
    await shoot(page, out, 'placing-proposed');
    // By the keyboard: past ChatGPT's button into the first row, Claude Code down one, to Antigravity, it up one, back
    // to Codex, off.
    await press(page, 'Tab');
    expect(await page.evaluate(() => document.activeElement?.textContent) === 'Sign in with ChatGPT', 'Tab reaches ChatGPT\'s button first');
    await press(page, 'Tab');
    expect(await focused(page) === 'Claude Code', `Tab reaches the first row (${await focused(page)})`);
    await press(page, 'Alt+ArrowDown');
    expect(await rows(page) === '1Codex, 2Claude Code, 3Antigravity', `⌥↓ moves it down one: ${await rows(page)}`);
    expect(await focused(page) === 'Claude Code', 'the moved row keeps the keyboard');
    await press(page, 'ArrowDown');
    await press(page, 'Alt+ArrowUp');
    expect(await rows(page) === '1Codex, 2Antigravity, 3Claude Code', `⌥↑ moves it up one: ${await rows(page)}`);
    await press(page, 'Alt+ArrowUp');
    await press(page, 'Alt+ArrowUp');
    expect(await rows(page) === '1Antigravity, 2Codex, 3Claude Code', `at the top it stays: ${await rows(page)}`);
    await press(page, 'ArrowDown');
    await press(page, 'Space');
    expect(await rows(page) === '1Antigravity, Codex off, 2Claude Code', `Space switches it off, and the places follow: ${await rows(page)}`);
    expect(await stored(page) === 'null', 'nothing is stored before the person allows it');
    await shoot(page, out, 'placing-own-order');
    await press(page, 'Enter');
    await page.waitForTimeout(300);
    const agreed = '{"agents":[{"agent":"agy","model":"gemini-3.8-flash-low","on":true},{"agent":"codex","model":"gpt-6-luna","on":false},{"agent":"claude","model":"haiku","on":true}],"terms":3}';
    expect(await stored(page) === agreed, `Return writes the agreement in that order: ${await stored(page)}`);
    expect(await page.evaluate(() => !document.querySelector('.sheet')), 'and the sheet goes');

    // Agreed: each change is written at once, Tasktap's order comes back, and it turns off.
    await page.evaluate(() => window.__ws.open({ kind: 'placing' }));
    await page.waitForTimeout(400);
    expect(await rows(page) === '1Antigravity, Codex off, 2Claude Code', `agreed, the sheet shows the person's order: ${await rows(page)}`);
    expect((await page.evaluate(() => document.querySelector('.sheet .sh-f').textContent)).includes('Turn off'), 'agreed, the sheet turns it off');
    await press(page, 'Tab');
    await press(page, 'Tab');
    await press(page, 'ArrowDown');
    await press(page, 'Space');
    expect((await stored(page)).includes('{"agent":"codex","model":"gpt-6-luna","on":true}'), 'a switch is written at once');
    await page.evaluate(() => [...document.querySelectorAll('.sheet .btn')].find((b) => b.textContent === 'Tasktap’s order').click());
    await page.waitForTimeout(200);
    expect(await rows(page) === '1Claude Code, 2Codex, 3Antigravity', `Tasktap's order again: ${await rows(page)}`);
    expect(JSON.parse(await stored(page)).agents.map((a) => a.agent).join(' ') === 'claude codex agy', 'and it is written');
    // An agent at its usage limit says until when.
    await page.evaluate(() => {
      const f = window.__fake, claude = f.records.agents.find((a) => a.id === 'claude');
      f.push({ t: 'change', rev: 400, sets: [{ c: 'agents', put: [{ ...claude, rev: 400, limited: new Date(2099, 0, 1, 16).getTime() }] }] });
    });
    await page.waitForTimeout(300);
    const limited = await page.evaluate(() => document.querySelector('.sheet .rank:not(.sign) .x'));
    const words = await page.evaluate(() => document.querySelector('.sheet .rank:not(.sign) .x').textContent);
    // On the person's clock, as their system writes a time (here en-US: 4:00 PM; in Germany 16:00).
    expect(/^haiku · out of quota until (16[.:]00|4:00\s?PM)$/.test(words) && limited !== null, `one at its limit says until when: "${words}"`);
    await fits(page, 'the agreed sheet');
    await shoot(page, out, 'placing-agreed-limited');
    // Dragged by the pointer: Antigravity to the top.
    const box = async (i) => page.locator('.sheet .rank:not(.sign)').nth(i).boundingBox();
    const from = await box(2), to = await box(0);
    await page.mouse.move(from.x + 60, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await rows(page) === '1Antigravity, 2Claude Code, 3Codex', `a row dragged to the top: ${await rows(page)}`);
    expect(JSON.parse(await stored(page)).agents.map((a) => a.agent).join(' ') === 'agy claude codex', 'and it is written');
    // Settings has the same group, and the keyboard moves it there too.
    await page.evaluate(() => window.__ws.open({ kind: 'settings', at: 'projects' }));
    await page.waitForTimeout(500);
    expect(await rows(page, '.settings') === '1Antigravity, 2Claude Code, 3Codex', `Settings shows the same group: ${await rows(page, '.settings')}`);
    await page.focus('.settings .rank:not(.sign)');
    await press(page, 'Alt+ArrowDown');
    expect(await rows(page, '.settings') === '1Claude Code, 2Antigravity, 3Codex', `moved in Settings: ${await rows(page, '.settings')}`);
    expect(JSON.parse(await stored(page)).agents.map((a) => a.agent).join(' ') === 'claude agy codex', 'and written at once');
    expect(await page.evaluate(() => window.__ws.ui.sheet?.kind) === 'settings', 'the keys stay in the group: Settings stays where it is');
    await page.locator('.sheet').screenshot({ path: path.join(out, 'settings-placing.png') });
    for (const e of page.errors) failures.push(`page: ${e}`);
    await page.context().close();

    // Agreed to one agent under the terms before: asked again, with Tasktap's order proposed.
    const before = { id: 'route_by', value: { agents: [{ agent: 'claude', model: 'haiku', on: true }], terms: 2 }, rev: 2 };
    page = await open(browser, { label: 'workspace', records: records([before]), url: server.url, dpr: 2 });
    await page.evaluate(() => window.__ws.open({ kind: 'placing' }));
    await page.waitForTimeout(500);
    const again = await page.evaluate(() => document.querySelector('.sheet .terms > p.warn')?.textContent ?? '');
    expect(again.startsWith('You agreed before to Claude Code alone.'), `an agreement to the terms before is asked again: "${again}"`);
    expect((await page.evaluate(() => document.querySelector('.sheet .sh-f .key')?.textContent)) === 'Agree again', 'Return agrees again');
    expect(await rows(page) === '1Claude Code, 2Codex, 3Antigravity', `with Tasktap's order proposed: ${await rows(page)}`);
    await fits(page, 'the sheet asked again');
    await shoot(page, out, 'placing-again');
    await press(page, 'Enter');
    await page.waitForTimeout(300);
    expect(JSON.parse(await stored(page)).terms === 3, 'agreed again, to these terms');
    for (const e of page.errors) failures.push(`page: ${e}`);
    await page.context().close();

    // Signing in with ChatGPT from the sheet, never agreed before; how the browser came back is pushed as the core would.
    page = await open(browser, { label: 'workspace', records: records(), url: server.url, dpr: 2 });
    await page.evaluate(() => window.__ws.open({ kind: 'placing' }));
    await page.waitForTimeout(500);
    const click = (label, where = '.sheet') => page.evaluate(([l, w]) => {
      const b = [...document.querySelectorAll(`${w} .btn`)].find((x) => x.textContent === l);
      return b ? (b.click(), true) : false;
    }, [label, where]);
    // Pressed twice before the core has answered: one sign-in, and nothing said of the second press.
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.sheet .btn')].find((x) => x.textContent === 'Sign in with ChatGPT');
      b.click();
      b.click();
    });
    await page.waitForTimeout(300);
    const once = await page.evaluate(() => ({ calls: window.__fake.calls.filter((c) => c === 'chatgpt.sign_in').length, error: document.querySelector('.err')?.textContent ?? '' }));
    expect(once.calls === 1 && !once.error, `pressed twice, one sign-in and no error: ${JSON.stringify(once)}`);
    const waiting = await page.evaluate(() => ({ opened: window.__fake.opened.map((o) => o.target), said: document.querySelector('.sheet .terms > p[role=status]')?.textContent,
      button: document.querySelector('.sheet .rank.sign .btn')?.textContent }));
    expect(waiting.opened.join() === 'https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&state=fake', `OpenAI's page opens in the browser: ${waiting.opened}`);
    expect(waiting.said === 'Waiting for the sign-in in your browser…' && waiting.button === 'Cancel', `it waits for the browser, with Cancel: ${JSON.stringify(waiting)}`);
    expect(await stored(page) === 'null', 'nothing is agreed while it waits');
    await fits(page, 'the sheet waiting for the browser');
    await shoot(page, out, 'placing-chatgpt-waiting');
    const prefs = (rev, values) => page.evaluate(([r, v]) => window.__fake.push({ t: 'change', rev: r, sets: [{ c: 'prefs', put: Object.entries(v).map(([id, value]) => ({ id, value, rev: r })) }] }), [rev, values]);
    // Signed in: the core agreed to ChatGPT's row alone and put it first.
    await prefs(500, { chatgpt: { state: 'signed_in', model: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', error: null }, route_by: { agents: [{ agent: 'chatgpt', model: 'gpt-6.2-sol', on: true }], terms: 3 } });
    await page.waitForTimeout(300);
    expect(await rows(page) === '1ChatGPT, Claude Code off, Codex off, Antigravity off', `signed in, ChatGPT alone places: ${await rows(page)}`);
    const signed = await page.evaluate(() => ({ x: document.querySelector('.sheet .rank .x')?.textContent, sign: !!document.querySelector('.sheet .rank.sign'),
      foot: document.querySelector('.sheet .rank-f')?.textContent, offer: document.querySelector('.sheet .terms').textContent.includes('Sign in with ChatGPT and') }));
    expect(signed.x === 'GPT-6.2 Sol · included in your subscription · about 4 s' && !signed.sign && !signed.offer, `a row like the others, by its model's name: ${JSON.stringify(signed)}`);
    expect(signed.foot.includes('Sign out'), `signing out is at the foot of the rows: "${signed.foot}"`);
    expect((await page.evaluate(() => document.querySelector('.sheet .sh-f').textContent)).includes('Turn off'), 'placing is on: the sheet turns it off');
    await fits(page, 'the sheet signed in with ChatGPT');
    await shoot(page, out, 'placing-chatgpt-signed-in');
    // Signed out: its row is the button again, and as no agreement was there before the sign-in, none is: the agents
    // are proposed again, each on, and nothing is stored until the person allows it.
    await click('Sign out');
    await page.waitForTimeout(300);
    expect(await rows(page) === '1Claude Code, 2Codex, 3Antigravity', `signed out, placing as it was before: ${await rows(page)}`);
    expect(await stored(page) === 'null' && (await page.evaluate(() => document.querySelector('.sheet .sh-f').textContent)).includes('Allow'), 'no agreement is left, and Allow asks for one');
    expect(await page.evaluate(() => document.querySelector('.sheet .rank.sign .btn')?.textContent) === 'Sign in with ChatGPT', 'and ChatGPT\'s button is back');
    // Why a sign-in did not finish, or ended, is said above the button, in the words given.
    const ends = [
      [{ state: 'failed', model: null, name: null, error: 'access_denied' }, 'The sign-in with ChatGPT did not finish: access_denied.'],
      [{ state: 'no_plan', model: null, name: null, error: null }, 'ChatGPT signed you in, but did not allow Tasktap to use your plan. Sign in again and allow the use of your plan.'],
      [{ state: 'no_model', model: null, name: null, error: null }, 'Your ChatGPT account does not offer GPT-6.2-Sol, the model Tasktap uses to find the project for a task.'],
      // OpenAI signed Tasktap out: the core keeps ChatGPT's row for the next sign-in.
      [{ state: 'signed_out', model: null, name: null, error: null }, 'ChatGPT signed Tasktap out. Sign in with ChatGPT again to keep ChatGPT placing your tasks.',
        { route_by: { agents: [{ agent: 'chatgpt', model: 'gpt-6.2-sol', on: true }], terms: 3 } }],
    ];
    for (const [i, [value, said, more]] of ends.entries()) {
      await prefs(600 + i, { chatgpt: value, ...more });
      await page.waitForTimeout(200);
      const shown = await page.evaluate(() => ({ warn: document.querySelector('.sheet .terms > p[role=alert]')?.textContent, button: document.querySelector('.sheet .rank.sign .btn')?.textContent }));
      expect(shown.warn === said && shown.button === 'Sign in with ChatGPT', `${value.state}: "${shown.warn}", and the button again`);
    }
    await fits(page, 'the sheet after OpenAI signed Tasktap out');
    await shoot(page, out, 'placing-chatgpt-signed-out');
    // In Settings the same row says why in itself, and its button opens the sheet, which says first what is sent.
    await page.evaluate(() => window.__ws.open({ kind: 'settings', at: 'projects' }));
    await page.waitForTimeout(500);
    const there = await page.evaluate(() => document.querySelector('.settings .rank.sign .x')?.textContent);
    expect(there === ends[ends.length - 1][1], `Settings' row says why: "${there}"`);
    await click('Sign in with ChatGPT', '.settings');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__ws.ui.sheet?.kind) === 'placing', 'its button opens the placing sheet');
    // Signed in, Settings' group signs out where its other actions are.
    await prefs(700, { chatgpt: { state: 'signed_in', model: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', error: null }, route_by: { agents: [{ agent: 'chatgpt', model: 'gpt-6.2-sol', on: true }], terms: 3 } });
    await page.evaluate(() => window.__ws.open({ kind: 'settings', at: 'projects' }));
    await page.waitForTimeout(400);
    expect(await rows(page, '.settings') === '1ChatGPT, Claude Code off, Codex off, Antigravity off', `Settings shows ChatGPT first: ${await rows(page, '.settings')}`);
    expect(await click('Sign out', '.settings'), 'and signs out beside Tasktap’s order');
    for (const e of page.errors) failures.push(`page: ${e}`);
    await page.context().close();

    // Nobody signed in who could place: the sheet still offers ChatGPT, says what is sent, and only closes.
    const nobody = records();
    nobody.agents = nobody.agents.map((a) => ({ ...a, signed_in: false }));
    page = await open(browser, { label: 'workspace', records: nobody, url: server.url, dpr: 2 });
    await page.waitForTimeout(500);
    // Setup's step is there all the same: it says how to sign someone in, and opens the sheet.
    const step = await page.evaluate(() => {
      const s = document.querySelector('.home .setup');
      if (s && !s.classList.contains('open')) s.querySelector('.fold-h')?.click();
      return document.querySelector('.home .setup [data-step=placing]')?.textContent ?? '';
    });
    expect(step.includes('Sign in with ChatGPT, or sign an agent in under Settings › Agents'), `Setup's placing step, with nobody signed in: "${step}"`);
    await page.evaluate(() => document.querySelector('.home .setup [data-step=placing] .act').click());
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__ws.ui.sheet?.kind) === 'placing', 'and its action opens the placing sheet');
    const alone = await page.evaluate(() => ({ rows: document.querySelectorAll('.sheet .rank').length, sign: document.querySelector('.sheet .rank.sign .btn')?.textContent,
      sends: document.querySelectorAll('.sheet ul.sends li').length, foot: !!document.querySelector('.sheet .rank-f'), acts: document.querySelector('.sheet .sh-f').textContent }));
    expect(alone.rows === 1 && alone.sign === 'Sign in with ChatGPT' && alone.sends === 4 && !alone.foot && !alone.acts.includes('Allow'), `ChatGPT alone, with what is sent: ${JSON.stringify(alone)}`);
    await fits(page, 'the sheet with nobody signed in');
    await shoot(page, out, 'placing-chatgpt-alone');
    // Settings › Projects leads there too.
    await page.evaluate(() => window.__ws.open({ kind: 'settings', at: 'projects' }));
    await page.waitForTimeout(400);
    const way = await page.evaluate(() => [...document.querySelectorAll('.settings .btn')].map((b) => b.textContent));
    expect(way.includes('Sign in with ChatGPT…'), `Settings, with nobody signed in, offers ChatGPT: ${way.filter((w) => /ChatGPT|agents/.test(w))}`);
    for (const e of page.errors) failures.push(`page: ${e}`);
    await page.context().close();

    // A task ChatGPT placed says so on its line under the Composer.
    const held = flow(scene('normal'), 'held'), t = held.thoughts[held.thoughts.length - 1];
    t.route = { ...t.route, by: 'chatgpt', model: 'gpt-6.2-sol' };
    page = await open(browser, { label: 'workspace', records: held, url: server.url, dpr: 2 });
    await page.waitForTimeout(500);
    const by = await page.evaluate(() => document.querySelector('.way .way-by')?.textContent);
    expect(by === 'placed by ChatGPT', `its line says who placed it: "${by}"`);
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
