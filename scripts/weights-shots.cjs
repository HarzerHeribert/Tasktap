// The weights (docs: a ladder of Light, Standard and Heavy for each agent), as pictures and as checks, from ui/dist in
// headless Chromium on the fixture records the other picture scripts use, dark, at 2x, no host: Settings › Agents with an
// opened row, its ladder empty and filled; the Composer without the weight control (an empty ladder) and with it, in the
// agent control's form and size, and with its list open; the session's sheet with its "Model" line. And what holds:
// - an agent Tasktap knows no way to give a model has no ladder in its row; the ladder's lines are Light, Standard and
//   Heavy, each a Model and an Effort field (Effort only where Tasktap can pass one), every empty field's placeholder the agent's own, and
//   Claude Code's three aliases offered as suggestions (a datalist), no other agent's any name; the foot says the line's sentence while a field has the keyboard, and
//   says the person's own start command wins where that names a model; a field typed in and left is `put prefs
//   agent_weights`, an empty line gone;
// - the Composer has the control only while the chosen agent has a line filled, never in the notch; it is the agent
//   control's height, takes no room from the field and cuts nothing of the chip; ⌘L opens its list; a weight chosen goes
//   with that task alone (`thought.capture {weight}`) and the control says Standard again once it is sent;
// - the session's sheet has the line "Model" only where a model or an effort was set, and no "·" anywhere in it.
// usage: node scripts/weights-shots.cjs <outdir>   (ui/dist must be built; exit status 1 on a failure)
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { serve, open } = require('./motion-pages.cjs');
const { scene } = require('./instrument-fixtures.cjs');

const out = path.resolve(process.argv[2] || 'weights');
fs.mkdirSync(out, { recursive: true });
const failures = [];
const expect = (ok, what) => (console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`), ok || failures.push(what));

const LADDER = [
  { agent: 'claude', weight: 'light', model: 'haiku', effort: 'low' },
  { agent: 'claude', weight: 'heavy', model: 'opus', effort: 'high' },
];
const pref = (id, value) => ({ id, rev: 9, value });

/** The scene with Claude Code and Codex that give a model and an effort, and OpenCode that Tasktap knows no way to give one. */
function records(prefs = []) {
  const r = scene('busy');
  const base = r.agents[0];
  r.agents = [
    { ...base, passes: { effort: true, model_named: false, effort_named: false } },
    { ...base, id: 'codex', name: 'Codex', program: 'codex', version: '0.9.2', identity: null, rev: 6 },
    { ...base, id: 'opencode', name: 'OpenCode', program: 'opencode', version: '1.4.0', identity: null, passes: null, rev: 6 },
  ];
  r.prefs = [...(r.prefs || []).filter((p) => !prefs.some((q) => q.id === p.id)), pref('route_by', null), ...prefs];
  return r;
}

async function ready(page) {
  await page.waitForFunction(() => window.__ws?.ui.ready, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
}
async function settings(page) {
  await ready(page);
  await page.evaluate(() => ((window.__ws.ui.sheet = { kind: 'settings', at: 'agents' }), window.__motion.redraw()));
  await page.waitForSelector('.set-pane .line.ag');
  await page.waitForTimeout(400);
}
const sheet = (page, name) => page.locator('.sheet').screenshot({ path: path.join(out, `${name}.png`) });
const near = (page, sel, name, pad = 20) => page.locator(sel).first().boundingBox().then((b) => page.screenshot({
  path: path.join(out, `${name}.png`), clip: { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + 2 * pad, height: b.height + 2 * pad } }));
const prefOf = (page, id) => page.evaluate((i) => JSON.stringify((window.__fake.records.prefs || []).find((p) => p.id === i)?.value ?? null), id);
const ladderRows = (page, agent) => page.locator(`.set-pane .line.ag[data-agent=${agent}] + .ag-d .set:has(> .t:text-is("Light")), .set-pane .line.ag[data-agent=${agent}] + .ag-d .set:has(> .t:text-is("Standard")), .set-pane .line.ag[data-agent=${agent}] + .ag-d .set:has(> .t:text-is("Heavy"))`);
/** What a person reads, and what a screen reader is told, in the parts matching `sel`: no "·", no ring. */
const plain = (page, sel) => page.evaluate((s) => {
  const roots = [...document.querySelectorAll(s)];
  const said = roots.flatMap((r) => [r, ...r.querySelectorAll('[aria-label], [title], [placeholder]')]).map((e) => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('placeholder')].join(' '));
  return { dots: `${roots.map((r) => r.innerText).join(' ')} ${said.join(' ')}`.includes('·'), rings: roots.reduce((n, r) => n + r.querySelectorAll('.ring-o').length, 0) };
}, sel);
const hint = (page) => page.locator('.sh-hint').textContent();

async function agentsPane(browser, url) {
  let page = await open(browser, { label: 'workspace', records: records(), url, dpr: 2 });
  await settings(page);
  await page.locator('.line.ag[data-agent=claude] .chev').click();
  await page.locator('.line.ag[data-agent=opencode] .chev').click();
  await page.waitForTimeout(200);
  expect(await ladderRows(page, 'claude').count() === 3, 'Claude Code: its opened row has the three lines of its ladder');
  const names = await ladderRows(page, 'claude').locator('> .t').allTextContents();
  expect(names.join() === 'Light,Standard,Heavy', `the lines are Light, Standard, Heavy (${names})`);
  const fields = await ladderRows(page, 'claude').first().locator('.fld').evaluateAll((els) => els.map((e) => [e.querySelector('span').textContent, e.querySelector('input').placeholder]));
  expect(JSON.stringify(fields) === JSON.stringify([['Model', "Claude Code's own"], ['Effort', "Claude Code's own"]]), `Light has a Model and an Effort field, both saying Claude Code's own (${JSON.stringify(fields)})`);
  const alias = await page.evaluate(() => [...document.querySelectorAll('.ag-d datalist')].map((d) => [d.id, [...d.options].map((o) => o.value).join()]));
  expect(JSON.stringify(alias) === JSON.stringify([['claude-models', 'haiku,sonnet,opus']]), `Claude Code's three aliases are suggestions of its Model fields, no other agent has any (${JSON.stringify(alias)})`);
  expect(await ladderRows(page, 'claude').locator('.fld input[list=claude-models]').count() === 3, 'each of its Model fields offers them');
  expect(await ladderRows(page, 'opencode').count() === 0, 'OpenCode, which Tasktap knows no way to give a model, has no ladder');
  const at = await plain(page, '.set-pane');
  expect(!at.dots && at.rings === 0, `no "·", no ring in the opened rows (${JSON.stringify(at)})`);
  expect(await hint(page) === '', 'the foot is empty at rest');
  await sheet(page, 'agent-row-ladder-empty');
  await ladderRows(page, 'claude').first().locator('input').first().focus();
  await page.waitForTimeout(150);
  expect(await hint(page) === 'The model and the effort Claude Code starts a light task with; leave a field empty for Claude Code\'s own.', `the foot says what a line is while its field has the keyboard ("${await hint(page)}")`);
  // Typed and left: kept; emptied: gone.
  const field = (w, n) => ladderRows(page, 'claude').nth(w).locator('input').nth(n);
  for (const [w, n, text] of [[0, 0, 'haiku'], [0, 1, 'low'], [2, 0, 'opus'], [2, 1, 'high']]) {
    await field(w, n).fill(text);
    await page.keyboard.press('Tab');
  }
  const kept = JSON.parse(await prefOf(page, 'agent_weights'));
  expect(JSON.stringify(kept.map((l) => [l.agent, l.weight, l.model, l.effort])) === JSON.stringify([['claude', 'light', 'haiku', 'low'], ['claude', 'heavy', 'opus', 'high']]), `the ladder is kept as typed (${JSON.stringify(kept)})`);
  await page.mouse.move(2, 2);
  await page.locator('.sheet').click({ position: { x: 4, y: 4 } });
  await page.waitForTimeout(200);
  await sheet(page, 'agent-row-ladder-filled');
  await field(2, 0).fill('');
  await field(2, 1).fill('');
  await page.keyboard.press('Tab');
  expect((JSON.parse(await prefOf(page, 'agent_weights')) || []).length === 1, 'a line with both fields empty is gone');
  await page.context().close();
  // The person's own start command names a model: the foot says it wins.
  const r = records([pref('agent_commands', [{ agent: 'claude', command: 'claude --model opus' }])]);
  r.agents[0].passes.model_named = true;
  page = await open(browser, { label: 'workspace', records: r, url, dpr: 2 });
  await settings(page);
  await page.locator('.line.ag[data-agent=claude] .chev').click();
  await ladderRows(page, 'claude').nth(1).locator('input').first().focus();
  await page.waitForTimeout(150);
  expect(await hint(page) === 'The command that starts Claude Code names a model, so Claude Code runs on that at every weight.', `the foot says the command's model wins ("${await hint(page)}")`);
  await page.context().close();
}

async function composer(browser, url) {
  const widths = [];
  for (const [name, prefs] of [['without', []], ['with', [pref('agent_weights', LADDER)]]]) {
    const page = await open(browser, { label: 'workspace', records: records(prefs), url, dpr: 2, viewport: { width: 1180, height: 760 } });
    await ready(page);
    await page.focus('#capture-input');
    await page.keyboard.type('tidy the export menu');
    await page.waitForTimeout(300);
    const has = await page.locator('.home .cap-weight').count();
    expect(has === (name === 'with' ? 1 : 0), `the Composer ${name} a line of the ladder ${name === 'with' ? 'has' : 'has no'} weight control`);
    const m = await page.evaluate(() => {
      const box = (s) => document.querySelector(s)?.getBoundingClientRect();
      const row = document.querySelector('.home .cap-row'), agent = box('.home .cap-agent:not(.cap-weight)'), weight = box('.home .cap-weight'), chip = document.querySelector('.home #dest-chip b');
      return { field: box('.home #capture-input').width, over: row.scrollWidth > row.clientWidth + 0.5, chipCut: chip.scrollWidth > chip.clientWidth + 0.5, agentH: agent.height, weightH: weight?.height, text: document.querySelector('.home .cap-weight .nm')?.textContent };
    });
    widths.push(m);
    if (name === 'with') {
      expect(m.weightH === m.agentH, `the weight control is the agent control's height (${m.weightH} against ${m.agentH})`);
      expect(m.text === 'Standard', `it says Standard until one is chosen ("${m.text}")`);
    }
    expect(!m.over && !m.chipCut, `${name}: the foot does not overflow and the chip is whole`);
    await near(page, '.home .capture', `composer-${name}`);
    if (name === 'with') {
      // Its key, and its list.
      await page.keyboard.press('Meta+l');
      await page.waitForSelector('.weight-list');
      await page.waitForTimeout(250);
      const rows = await page.locator('.weight-list button').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
      expect(JSON.stringify(rows) === JSON.stringify(['Light haiku, low effort', 'Standard Claude Code\'s own', 'Heavy opus, high effort']), `the list offers Light, Standard, Heavy with what the ladder gives each (${JSON.stringify(rows)})`);
      expect(await page.locator('.weight-list [aria-selected=true]').textContent().then((t) => t.startsWith('Standard')), 'Standard is the one selected');
      expect(await page.evaluate(() => document.activeElement?.closest('.weight-list') != null), 'the list has the keyboard');
      const plainList = await plain(page, '.weight-list, .cap-weight');
      expect(!plainList.dots && plainList.rings === 0, 'no "·" and no ring in the control or its list');
      await near(page, '.home .capture', 'composer-list');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(250);
      expect(await page.locator('.home .cap-weight .nm').textContent() === 'Heavy' && await page.evaluate(() => document.activeElement?.id) === 'capture-input', 'Heavy chosen by the keyboard: the control says Heavy and the field has the keyboard back');
      await near(page, '.home .capture', 'composer-heavy');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__fake.sent?.text === 'tidy the export menu');
      expect(await page.evaluate(() => window.__fake.sent.weight) === 'heavy', 'the task is captured with weight heavy');
      await page.waitForTimeout(300);
      expect(await page.locator('.home .cap-weight .nm').textContent() === 'Standard', 'after the task is sent the control says Standard again');
      await page.keyboard.type('and the file menu');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__fake.sent?.text === 'and the file menu');
      expect(await page.evaluate(() => window.__fake.sent.weight) === undefined, 'the next task is captured with no weight');
      // Narrow: the names give way, the control stays, the chip is whole.
      for (const w of [720, 560]) {
        await page.setViewportSize({ width: w, height: 600 });
        await page.waitForTimeout(300);
        const n = await page.evaluate(() => {
          const row = document.querySelector('.home .cap-row'), chip = document.querySelector('.home #dest-chip b');
          return { over: row.scrollWidth > row.clientWidth + 0.5, chipCut: chip.scrollWidth > chip.clientWidth + 0.5, control: !!document.querySelector('.home .cap-weight') };
        });
        expect(n.control && !n.over && !n.chipCut, `at ${w} px the control stays, the foot does not overflow, the chip is whole (${JSON.stringify(n)})`);
      }
    }
    await page.context().close();
  }
  expect(Math.abs(widths[0].field - widths[1].field) < 0.5, `the control takes nothing from the field (${widths[0].field} and ${widths[1].field})`);
  // A line of another agent's ladder says nothing for this one; a follow-up has none; the notch has none.
  let page = await open(browser, { label: 'workspace', records: records([pref('agent_weights', [{ agent: 'codex', weight: 'heavy', model: 'x', effort: '' }])]), url, dpr: 2 });
  await ready(page);
  expect(await page.locator('.home .cap-weight').count() === 0, 'a ladder for Codex gives Claude Code\'s Composer no control');
  await page.context().close();
  page = await open(browser, { label: 'notch', records: records([pref('agent_weights', LADDER)]), url, dpr: 2 });
  await page.evaluate(() => window.__fake.emit({ do: 'geometry', width: 104, height: 16, cutout: false, surfaceWidth: 420, surfaceOffset: 0, span: 560, pixel: 1, corner: 10, offset: 0, available: 700, collapsed: false }));
  await page.evaluate(() => window.__fake.emit({ do: 'capture' }));
  await page.waitForSelector('#capture-input');
  await page.waitForTimeout(400);
  expect(await page.locator('.cap-agent').count() === 1 && await page.locator('.cap-weight').count() === 0, 'the notch\'s capture has the agent control and no weight control');
  await page.context().close();
}

async function session(browser, url) {
  const r = records();
  const s = r.sessions[0];
  Object.assign(s, { model: 'haiku', effort: 'low', weight: 'light' });
  const plainOne = r.sessions[1];
  let page = await open(browser, { label: 'workspace', records: r, url, dpr: 2 });
  await ready(page);
  await page.evaluate((id) => ((window.__ws.ui.sheet = { kind: 'session', id }), window.__motion.redraw()), s.id);
  await page.waitForSelector('.sx .line');
  await page.waitForTimeout(400);
  const lines = await page.locator('.sx .list .line').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  expect(lines.some((l) => l === 'Model Light, haiku, low effort'), `the session's sheet has the line "Model" with the weight, the model and the effort (${JSON.stringify(lines)})`);
  expect(!(await page.locator('.sheet').innerText()).includes('·'), 'no "·" in the session\'s sheet');
  await sheet(page, 'session-model');
  await page.context().close();
  page = await open(browser, { label: 'workspace', records: r, url, dpr: 2 });
  await ready(page);
  await page.evaluate((id) => ((window.__ws.ui.sheet = { kind: 'session', id }), window.__motion.redraw()), plainOne.id);
  await page.waitForSelector('.sx .line');
  expect(await page.locator('.sx .list .line:has(.t:text-is("Model"))').count() === 0, 'a session started with no model or effort has no "Model" line');
  await page.context().close();
}

async function main() {
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true });
  try {
    await agentsPane(browser, server.url);
    await composer(browser, server.url);
    await session(browser, server.url);
  } finally {
    await browser.close();
    await server.close();
  }
  if (failures.length) (console.log(`\n${failures.length} FAILED`), process.exit(1));
  console.log('\nall ok');
}
main().catch((e) => (console.error(e), process.exit(1)));
