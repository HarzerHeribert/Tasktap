// Closing a terminal (README, Arrange your workspace; docs/trial-checklist.md 26 to 29). Headless, from ui/dist on
// fixture records, with real pointer and key events, against a stand-in core that says what runs in each terminal
// as the core's `terminal.runs` does. It fails when
// - ⌘W on a shell with nothing running in it asks anything, or leaves its tab, or does not stop it;
// - ⌘W on a shell where a program runs does not ask, or the question does not name the program; on an agent's live
//   session it does not ask as before (keep running in the background, stop, cancel);
// - a session or terminal row of the sidebar has no cross, or shows it at rest, or not under the pointer or with
//   keyboard focus on the row; showing it moves the row's words or its mark; its target is smaller than 20 px, or
//   less than 8 px from where the row's words end; it does not close as ⌘W does (at once when nothing runs, asked
//   when something does, by name, and for a row in the background with Stop);
// - closing a workspace asks more than once, or does not name what runs where, or asks at all when only shells with
//   nothing running in them are left, which then close with it.
// With --pictures DIR it also writes the rows at rest, under the pointer and with focus, and both questions, at 1x
// and 2x.
// usage: node scripts/closing-check.cjs [--dist folder] [--pictures folder]   (ui/dist must be built)
const path = require('node:path');
const fs = require('node:fs');
const { serve, open } = require('./motion-pages.cjs');
const { scene } = require('./instrument-fixtures.cjs');
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const dist = path.resolve(arg('--dist') || path.join(__dirname, '../ui/dist'));
const pictures = arg('--pictures') && path.resolve(arg('--pictures'));

/** The busy scene, with a program running in its dev server's shell, an idle shell in the background of its first
 *  workspace, and a fourth workspace that holds two idle shells only. */
function records() {
  const r = scene('busy');
  const cuegrid = r.ids.projects.cuegrid;
  const term = (title, project) => ({ id: `0199a000-0000-7000-8000-${String(r.terminals.length).padStart(12, '0')}`, rev: 3, project_id: project, kind: 'shell', title, cwd: '', argv: [], cols: 100, rows: 30, state: 'running', exit: null });
  const dev = r.terminals.find((t) => t.title === 'dev server');
  const zsh = r.terminals.find((t) => t.title === 'zsh');
  const spare = term('zsh', cuegrid);
  r.terminals.push(spare);
  r.layouts.find((l) => l.id === cuegrid).tree.background = [spare.id];
  const quiet = { ...r.projects.find((p) => p.id === cuegrid), id: '0199a000-0000-7000-8000-00000000aaaa', name: 'notes', folder: '/Users/example/notes', rev: 4 };
  r.projects.push(quiet);
  const a = term('zsh', quiet.id);
  r.terminals.push(a);
  const b = term('bash', quiet.id);
  r.terminals.push(b);
  r.layouts.push({ id: quiet.id, rev: 6, tree: { tree: { id: 'pq', tabs: [a.id, b.id], active: a.id }, selected: 'pq', focus: false, background: [], sizes: {} } });
  r.runs = { [dev.id]: { state: 'running', what: ['npm run dev'], session: null } };
  return { r, ids: { cuegrid, quiet: quiet.id, dev: dev.id, zsh: zsh.id, spare: spare.id } };
}

async function main() {
  const { chromium } = require('playwright');
  const server = await serve(dist), browser = await chromium.launch({ headless: true }), failures = [], measured = {};
  const expect = (ok, what) => ok || (failures.push(what), console.error(`FAIL ${what}`));
  if (pictures) fs.mkdirSync(pictures, { recursive: true });

  for (const dpr of [1, 2]) {
    const { r, ids } = records();
    const page = await open(browser, { label: 'workspace', records: r, url: server.url, dpr });
    const at = `${dpr}x`;
    const sheet = () => page.evaluate(() => {
      const s = document.querySelector('.sheet');
      return s && { title: s.querySelector('#sheet-title')?.textContent ?? '', text: s.textContent ?? '' };
    });
    const calls = (name) => page.evaluate((n) => window.__fake.calls.filter((c) => c === n).length, name);
    const tab = (id) => page.locator(`.tab[data-id="${id}"]`);
    const row = (id) => page.locator(`.srow[data-id="${id}"]`);
    const settle = () => page.waitForTimeout(250);
    // The first workspace, by a click on its name in the sidebar.
    await page.locator(`section.ws[data-workspace="${ids.cuegrid}"] .row.w .name`).click();
    await settle();

    // Every session and terminal row has its cross, hidden at rest.
    const rows = await page.evaluate(() => [...document.querySelectorAll('.side .row.s')].map((b) => ({
      id: b.dataset.id, cross: !!b.parentElement?.matches('.srow') && !!b.parentElement.querySelector(':scope > .x'),
      shown: b.parentElement?.querySelector(':scope > .x') ? getComputedStyle(b.parentElement.querySelector(':scope > .x')).opacity : 'none',
    })));
    expect(rows.length >= 8, `${at}: the sidebar shows ${rows.length} session rows`);
    for (const x of rows) expect(x.cross && x.shown === '0', `${at}: row ${x.id} has no cross, or shows it at rest (${x.shown})`);
    if (pictures) await page.locator('aside.side').screenshot({ path: path.join(pictures, `sidebar-rest-${at}.png`) });

    // Under the pointer: shown, and nothing of the row moves.
    const place = (id) => page.evaluate((i) => {
      const s = document.querySelector(`.srow[data-id="${i}"]`), r = (e) => e && e.getBoundingClientRect();
      const box = (e) => e && { l: r(e).left, t: r(e).top, w: r(e).width, h: r(e).height };
      return { mark: box(s.querySelector('.st')), words: box(s.querySelector('.lbl')), row: box(s.querySelector('.row')), x: box(s.querySelector(':scope > .x')),
        opacity: getComputedStyle(s.querySelector(':scope > .x')).opacity, ends: r(s.querySelector('.lbl')).right };
    }, id);
    for (const id of [ids.dev, ids.zsh, ids.spare]) {
      const before = await place(id);
      const b = before.row;
      await page.mouse.move(b.l + b.w / 3, b.t + b.h / 2);
      await page.waitForTimeout(120);
      const after = await place(id);
      expect(after.opacity === '0.75', `${at}: the cross of ${id} is not shown under the pointer (${after.opacity})`);
      expect(JSON.stringify(after.mark) === JSON.stringify(before.mark), `${at}: the mark of ${id} moved: ${JSON.stringify(before.mark)} to ${JSON.stringify(after.mark)}`);
      expect(after.words.l === before.words.l && after.words.t === before.words.t, `${at}: the words of ${id} moved`);
      expect(after.x.w >= 20 && after.x.h >= 20, `${at}: the cross is ${after.x.w} × ${after.x.h}`);
      expect(after.x.l - after.ends >= 8, `${at}: the row's words end ${after.x.l - after.ends} px from the cross`);
      measured[`${at} ${id === ids.dev ? 'dev server' : id === ids.zsh ? 'zsh' : 'zsh (background)'}`] = { row: `${b.w} × ${b.h}`, cross: `${after.x.w} × ${after.x.h}`, rowTargetLeftOfCross: `${after.x.l - b.l} px`, wordsToCross: `${after.x.l - after.ends} px` };
      if (pictures && id === ids.dev) await page.locator('aside.side').screenshot({ path: path.join(pictures, `sidebar-hover-${at}.png`) });
    }
    await page.mouse.move(700, 700);

    // With keyboard focus: Tab from Home to the first session row shows its cross, and its cross is the next stop.
    await page.locator('.side .row.home').focus();
    let focused = '';
    for (let i = 0; i < 40 && !focused; i++) {
      await page.keyboard.press('Tab');
      focused = await page.evaluate(() => document.activeElement?.matches('.srow > .row') ? document.activeElement.dataset.id : '');
    }
    expect(!!focused, `${at}: Tab never reached a session row`);
    if (focused) {
      const p = await place(focused);
      expect(p.opacity === '0.75', `${at}: the cross is not shown with keyboard focus on its row (${p.opacity})`);
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.matches('.srow > .x')), `${at}: the cross is not the next stop after its row`);
      if (pictures) await page.locator('aside.side').screenshot({ path: path.join(pictures, `sidebar-focus-${at}.png`) });
    }

    // ⌘W on the shell with nothing running: closed at once, stopped, no question.
    await tab(ids.zsh).click();
    await settle();
    const stops = await calls('terminal.stop');
    await page.keyboard.press('Meta+w');
    await settle();
    expect(!(await sheet()), `${at}: ⌘W on an idle shell asked: ${JSON.stringify(await sheet())}`);
    expect(!(await tab(ids.zsh).count()), `${at}: ⌘W left the idle shell's tab`);
    expect((await calls('terminal.stop')) === stops + 1, `${at}: ⌘W did not stop the idle shell`);

    // ⌘W where a program runs: asked, by its name; Esc keeps it.
    await tab(ids.dev).click();
    await settle();
    await page.keyboard.press('Meta+w');
    await settle();
    const asked = await sheet();
    expect(asked && asked.title === 'Close “dev server”?' && asked.text.includes('npm run dev is running in it.') && asked.text.includes('Keep running in background'),
      `${at}: ⌘W on a running program asked ${JSON.stringify(asked)}`);
    if (pictures) await page.locator('.sheet').screenshot({ path: path.join(pictures, `sheet-close-program-${at}.png`) });
    await page.keyboard.press('Escape');
    await settle();
    expect(!(await sheet()) && (await tab(ids.dev).count()) === 1, `${at}: Esc did not keep the running program: ${JSON.stringify(await sheet())}, ${await tab(ids.dev).count()} tabs, focus on ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))}`);

    // An agent's live session asks as before.
    const timer = r.thoughts.find((t) => t.text.startsWith('Make the rehearsal timer'));
    const agentTerm = r.sessions.find((s) => s.id === timer.session_id).terminal_id;
    await tab(agentTerm).click();
    await settle();
    await page.keyboard.press('Meta+w');
    await settle();
    const agent = await sheet();
    expect(agent && agent.text.includes('Claude Code is running in it.') && agent.text.includes('Its history stays either way.') && agent.text.includes('Stop session'),
      `${at}: ⌘W on an agent's live session asked ${JSON.stringify(agent)}`);
    await page.keyboard.press('Escape');
    await settle();
    expect(!(await sheet()), `${at}: Esc did not put away the question about the agent's session: ${JSON.stringify(await sheet())}`);

    // The sidebar's cross: the idle shell in the background closes at once; the running program is asked about.
    const cross = async (id) => {
      const b = (await place(id)).row;
      await page.mouse.move(b.l + b.w / 2, b.t + b.h / 2);
      await page.waitForTimeout(100);
      await row(id).locator(':scope > .x').click();
      await settle();
    };
    await cross(ids.spare);
    expect(!(await sheet()) && !(await row(ids.spare).count()), `${at}: the cross of an idle shell in the background did not close it at once`);
    await cross(ids.dev);
    const fromRow = await sheet();
    expect(fromRow && fromRow.text.includes('npm run dev is running in it.'), `${at}: the cross of a running program asked ${JSON.stringify(fromRow)}`);
    await page.keyboard.press('Escape');
    await settle();

    // Closing a workspace: asked once, naming what runs where.
    await page.evaluate(() => { window.__ws.menu.dry = true; });
    const runsBefore = await calls('terminal.runs');
    await page.locator(`section.ws[data-workspace="${ids.cuegrid}"] .row.w`).click({ button: 'right' });
    await page.evaluate(() => window.__ws.choose('Close Workspace…'));
    await page.waitForTimeout(400);
    const sheets = await page.evaluate(() => document.querySelectorAll('.sheet').length);
    const ws = await sheet();
    expect(sheets === 1 && ws && ws.title === 'Close cuegrid?' && ws.text.includes('Still running: ') && ws.text.includes('npm run dev in “dev server”') && ws.text.includes('Claude Code in “Make the rehearsal timer'),
      `${at}: closing a workspace asked ${sheets} times: ${JSON.stringify(ws)}`);
    expect((await calls('terminal.runs')) > runsBefore, `${at}: closing a workspace asked the core nothing`);
    if (pictures) await page.locator('.sheet').screenshot({ path: path.join(pictures, `sheet-close-workspace-${at}.png`) });
    await page.keyboard.press('Escape');
    await settle();
    // One with only idle shells closes with no question, its shells stopped with it.
    await page.locator(`section.ws[data-workspace="${ids.quiet}"] .row.w`).click({ button: 'right' });
    await page.evaluate(() => window.__ws.choose('Close Workspace…'));
    await page.waitForTimeout(400);
    const closed = await page.evaluate(() => window.__fake.closed || []);
    expect(!(await sheet()) && closed.some((c) => c.id === ids.quiet && c.stop === true), `${at}: a workspace of idle shells asked, or was not closed with them: ${JSON.stringify(closed)}`);

    expect(!page.errors.length, `${at}: the page said ${page.errors.join('; ')}`);
    await page.context().close();
  }
  await browser.close();
  server.close();
  console.log(JSON.stringify(measured, null, 1));
  if (failures.length) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log('closing-check: ok');
}

main().catch((e) => { console.error(String(e).split('\n')[0]); process.exit(1); });
