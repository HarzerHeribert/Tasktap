// The three surfaces the owner judged "structureless" (2026-11-22), as pictures and as checks, from ui/dist in headless
// Chromium on the fixture records the other picture scripts use, dark, at 2x, no host: Settings › Agents at rest, with
// rows opened, and with the start command's field focused (its hint in the foot); the placing row; every other section of
// Settings; the Results list with one failed, one stopped and one answered task; "Find a task"; the session's head.
// And what holds on them: on the task rows and in Settings no ring (`.ring-o`), no "·" in what a person reads or what a
// screen reader is told; a task row is its title, its project and its time on one line, the project names in one
// column, and a second line only for a failure (in the warning colour) or the first line of an answer, its Markdown
// marks gone; the agent's name stays in the row's accessible name.
// usage: node scripts/calm-rows-shots.cjs <outdir>   (ui/dist must be built; exit status 1 on a failure)
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { serve, open } = require('./motion-pages.cjs');
const { scene } = require('./instrument-fixtures.cjs');
const { projects } = require('./projects-fixtures.cjs');

const out = path.resolve(process.argv[2] || 'calm-rows');
fs.mkdirSync(out, { recursive: true });
const failures = [];
const expect = (ok, what) => (console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`), ok || failures.push(what));

/** The core's first records in, then the section's rows quiet for 300 ms (settings-rows-check.cjs `section`). */
async function section(page, at) {
  await page.waitForFunction(() => window.__ws?.ui.ready, null, { timeout: 15000 }).catch(() => {});
  await page.evaluate((a) => ((window.__ws.ui.sheet = { kind: 'settings', at: a }), window.__motion.redraw()), at);
  await page.evaluate(() => new Promise((done) => {
    const end = performance.now() + 15000;
    let was = null, since = performance.now();
    const look = () => {
      const now = [...document.querySelectorAll('.set-pane .set, .set-pane .line')].map((r) => r.textContent).join('|');
      if (now !== was) (was = now, (since = performance.now()));
      return (now && performance.now() - since >= 300) || performance.now() > end ? done() : setTimeout(look, 20);
    };
    look();
  }));
}
const sheet = (page, name) => page.locator('.sheet').screenshot({ path: path.join(out, `${name}.png`) });
const window_ = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? '', sel);
/** What a person reads, and what a screen reader is told, in the parts matching `sel`: no "·", no ring. */
const plain = (page, sel) => page.evaluate((s) => {
  const roots = [...document.querySelectorAll(s)];
  const said = roots.flatMap((r) => [r, ...r.querySelectorAll('[aria-label], [title], [placeholder]')]).map((e) => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('placeholder')].join(' '));
  return { dots: `${roots.map((r) => r.innerText).join(' ')} ${said.join(' ')}`.includes('·'), rings: roots.reduce((n, r) => n + r.querySelectorAll('.ring-o').length, 0) };
}, sel);

/** The records with the three results of the picture: one failed, one stopped, one answered in Markdown. */
function results() {
  const r = scene('busy');
  const named = (key) => r.thoughts.find((t) => t.text === key);
  const vite = named('Upgrade to Vite 7');
  vite.reason = 'exited';
  const stopped = r.thoughts.find((t) => t.status === 'done' && t.read && t.text !== 'Add offline sync for drafts');
  Object.assign(stopped, { status: 'failed', phase: 'failed', reason: 'stopped', read: false });
  r.results = r.results.filter((x) => x.thought_id !== stopped.id);
  const answered = named('Add offline sync for drafts');
  r.results.find((x) => x.thought_id === answered.id).summary = '**Test Witness** passes: drafts save locally and sync on reconnect.\nFiles changed: 4.';
  return { records: r, vite, stopped, answered };
}

async function main() {
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true });
  try {
    // ——— Settings › Agents ———
    const agents = scene('busy');
    const base = agents.agents[0];
    agents.agents.push(
      { ...base, id: 'codex', name: 'Codex', program: 'codex', version: '0.9.2', identity: null, rev: 6 },
      { ...base, id: 'opencode', name: 'OpenCode', program: 'opencode', version: '1.4.0', identity: null, signed_in: false, rev: 6 },
      { ...base, id: 'goose', name: 'Goose', program: 'goose', installed: false, signed_in: null, version: null, identity: null, rev: 6 },
    );
    agents.agents = [...new Map(agents.agents.map((a) => [a.id, a])).values()];
    agents.prefs = [...(agents.prefs || []), { id: 'agent_commands', rev: 9, value: [{ agent: 'codex', command: 'caffeinate -i codex' }] }];
    let page = await open(browser, { label: 'workspace', records: agents, url: server.url, dpr: 2 });
    await section(page, 'agents');
    await sheet(page, 'agents-rest');
    const at = await plain(page, '.set-pane');
    expect(!at.dots && at.rings === 0, `Agents at rest: no "·", no ring (${JSON.stringify(at)})`);
    const first = await page.locator('.set-pane > .set > .t').first().textContent();
    expect(first === 'New tasks start with', `Agents: the first row is "${first}"`);
    expect(await page.locator('.sh-hint').textContent() === '', 'the foot is empty at rest');
    await page.locator('.line.ag[data-agent=claude] .chev').click();
    await page.locator('.line.ag[data-agent=opencode] .chev').click();
    await page.waitForTimeout(200);
    await sheet(page, 'agents-open');
    const start = page.locator('.line.ag[data-agent=claude] + .ag-d input');
    await start.focus();
    await page.waitForTimeout(200);
    const hint = await page.locator('.sh-hint').textContent();
    expect(/^Write how you start Claude Code/.test(hint), `the start command's field has the keyboard: the foot says "${hint}"`);
    await sheet(page, 'agents-start-command');
    await page.context().close();

    // ——— The placing row, and every other section ———
    for (const [name, at_, records] of [['placing-row', 'projects', scene('busy')], ['thoughts', 'thoughts', scene('busy')], ['voice', 'voice', scene('busy')], ['appearance', 'appearance', scene('busy')], ['terminal', 'terminal', scene('busy')], ['about', 'about', scene('busy')]]) {
      page = await open(browser, { label: 'workspace', records, url: server.url, dpr: 2 });
      await section(page, at_);
      if (name === 'placing-row') await page.locator('.set-pane .set:has(> .t:text-is("Finding the project for a task")) .btn').first().hover();
      await page.waitForTimeout(150);
      const r = await plain(page, '.set-pane');
      expect(!r.dots && r.rings === 0, `Settings › ${at_}: no "·", no ring`);
      if (name === 'placing-row') expect(await page.locator('.set-pane .set:has(> .t:text-is("Finding the project for a task")) .btn').first().textContent() === 'Sign in with ChatGPT…', 'the placing row offers "Sign in with ChatGPT…" while agents are signed in');
      await sheet(page, name);
      await page.context().close();
    }
    page = await open(browser, { label: 'workspace', records: projects('settings'), url: server.url, dpr: 2 });
    await section(page, 'projects');
    await sheet(page, 'projects-rows');
    await page.context().close();

    // ——— The Results list and Find a task ———
    const r = results();
    page = await open(browser, { label: 'workspace', records: r.records, url: server.url, dpr: 2 });
    await page.waitForFunction(() => window.__ws?.ui.ready, null, { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => ((window.__ws.ui.fold = 'results'), window.__motion.redraw()));
    await page.evaluate(() => document.querySelector('.hr.task.res')?.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(500);
    await window_(page, 'results');
    const rows = (p) => p.evaluate(() => [...document.querySelectorAll('.hr.task')].map((row) => {
      const b = (s) => row.querySelector(s)?.getBoundingClientRect();
      const rule = (s) => { const e = row.querySelector(s); return e && { text: e.textContent, color: getComputedStyle(e).color }; };
      return { id: row.dataset.thought, title: row.querySelector('.hr-t')?.textContent, project: rule('.hr-p'), time: row.querySelector('time')?.textContent, x: rule('.hr-x'),
        px: b('.hr-p')?.left, tt: b('.hr-t')?.bottom, tp: b('.hr-p')?.bottom, tm: b('time')?.bottom, label: row.querySelector('.st')?.getAttribute('aria-label'), name: row.getAttribute('title'), text: row.innerText, rings: row.querySelectorAll('.ring-o').length };
    }));
    const list = await rows(page);
    const by = (id) => list.find((x) => x.id === id);
    const failed = by(r.vite.id), stopped = by(r.stopped.id), answered = by(r.answered.id);
    expect(!!failed && !!stopped && !!answered, `the Results list has the failed, the stopped and the answered task (${list.length} rows)`);
    expect(failed?.x?.text.startsWith('The agent exited before it finished') && stopped?.x?.text === 'It was stopped', `a failure says why on a second line: "${failed?.x?.text}", "${stopped?.x?.text}"`);
    expect(answered?.x?.text === 'Test Witness passes: drafts save locally and sync on reconnect.', `an answer shows its first line with no Markdown marks: "${answered?.x?.text}"`);
    expect(failed?.x?.color !== answered?.x?.color, 'a failure has the warning colour, an answer the quiet one');
    expect(list.every((x) => x.rings === 0) && !(await plain(page, '.hrs')).dots, 'no ring and no "·" in any task row');
    expect(list.every((x) => Math.abs(x.tt - x.tp) <= 3 && Math.abs(x.tt - x.tm) <= 3) && new Set(list.map((x) => x.px)).size === 1, 'the title, the project and the time stand on one line, the projects in one column');
    expect(!list.some((x) => /\bClaude Code\b|\bCodex\b/.test(x.text)) && /Claude Code|Codex/.test(failed?.label ?? ''), `the agent's name is not written in a row, and stays in its accessible name ("${failed?.label}")`);
    await page.evaluate(() => window.__ws.show('earlier'));
    await page.waitForTimeout(400);
    await page.locator('#find-thought').fill('the');
    await page.waitForTimeout(400);
    await window_(page, 'find-a-task');
    const found = await rows(page);
    expect(found.length > 0 && found.every((x) => x.rings === 0) && !(await plain(page, '.hx')).dots, `Find a task: ${found.length} rows, no ring, no "·"`);
    await page.evaluate(() => window.__ws.show('home'));
    await page.evaluate((id) => window.__ws.open({ kind: 'session', id: window.__ws.records.thoughts.get(id).session_id }), r.answered.id);
    await page.waitForTimeout(400);
    await sheet(page, 'session-head');
    expect(await page.locator('.sheet .sx .line .amark').count() === 1 && await page.locator('.sheet .sx .line:first-child > .ring-o').count() === 0, "the session's head has the agent's plain mark, no ring");
    await page.context().close();
  } finally {
    await browser.close();
    await server.close();
  }
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? `FAIL  ${failures.length} checks of the calm rows` : `PASS  the three surfaces: no ring, no "·", the rows as decided; pictures in ${out}`);
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
