// The capture flow, timed: a person types into Home's Composer at a steady pace while the app's state changes
// under them: a thought is sent, placed and held, its session starts, an agent at work prints into its terminal,
// and a result arrives. For every display frame: the interval since the last and what the page did in it; for
// every key: the delay from the key to the end of the frame that shows it, and whether any was lost or moved the
// caret. First the same typing with nothing changing, for comparison; and each at every level of the effects
// (the core's `motion_ambient`: full, still, off), so the light's part in a hitch can be told from the page's.
// It fails when, during the flow, the 95th percentile of the frame intervals is over 20 ms or one is over 50 ms,
// when the 95th percentile of the key delays is over 30 ms or one is over 100 ms, or when a key is lost.
// usage: node scripts/flow-check.cjs [--app [--debug]] [--levels full,still,off] [--short] [--trace] [--json file]
//   headless by default: ui/dist on fixture records, the core's changes pushed by a stand-in; --trace adds where the
//   main thread's time went (script, style, layout, paint) and its long tasks, from Chromium's own timeline.
//   --app: the built app against its real core with the fixture agent (FIXTURES=1 host/scripts/build-core.sh),
//   passive, on a temporary data folder, in one short launch; --debug takes the debug build smoke.sh makes.
//   --short: one level (full) and a shorter quiet part, for smoke.sh.
const fs = require('node:fs');
const path = require('node:path');
const { launch, awake, sleep, table, root, DEBUG, RELEASE } = require('./app-driver.cjs');
const { FLOW } = require('./motion-probe.cjs');
const has = (name) => process.argv.includes(name);
const arg = (name, or) => (has(name) ? process.argv[process.argv.indexOf(name) + 1] : or);
const LEVELS = { full: 'breathing', still: 'still', off: 'off' };
const KEY = 90, QUIET = has('--short') ? 3 : 5, RUN = 11;
/** When, in the flow's seconds, each thing happens. */
const AT = { send: 1, print: 5, result: 6.5 };

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
const r1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
function stats(rec) {
  const gaps = rec.frames.slice(1).map((f) => f[1]), keys = rec.keys.map((k) => k[1]);
  return {
    frames: gaps.length, median: pct(gaps, 0.5), p95: pct(gaps, 0.95), worst: Math.max(0, ...gaps), over20: gaps.filter((g) => g > 20).length, over33: gaps.filter((g) => g > 33).length,
    keys: keys.length, kmedian: pct(keys, 0.5), kp95: pct(keys, 0.95), kworst: Math.max(0, ...keys), refused: rec.refused, lost: rec.lost, caret: rec.caret,
  };
}
const row = (name, s) => [name, s.frames, r1(s.median), r1(s.p95), r1(s.worst), s.over20, s.over33, s.keys, r1(s.kmedian), r1(s.kp95), r1(s.kworst), s.refused, s.lost + s.caret];
const HEAD = ['', 'frames', 'median', 'p95', 'worst', '>20 ms', '>33 ms', 'keys', 'key median', 'key p95', 'key worst', 'refused', 'lost'];

/** The frames within a second and a half of each change of what Home shows, and the frames that took long. */
function detail(rec) {
  const out = [];
  for (const [at, what] of rec.marks.slice(1)) {
    const near = rec.frames.filter((f) => Math.abs(f[0] - at) <= 1500), gaps = near.map((f) => f[1]);
    out.push([`${(at / 1000).toFixed(2)} s`, what, near.length, r1(pct(gaps, 0.5)), r1(pct(gaps, 0.95)), r1(Math.max(0, ...gaps)), gaps.filter((g) => g > 20).length, gaps.filter((g) => g > 33).length]);
  }
  const long = rec.frames.slice(1).filter((f) => f[1] > 20).map((f) => [`${(f[0] / 1000).toFixed(2)} s`, r1(f[1]), r1(f[2]), r1(f[3]), f[5], f[4] ? 'yes' : '', (rec.marks.filter((m) => m[0] <= f[0] + 20).pop() ?? [0, ''])[1]]);
  return { marks: out, long };
}

function print(name, level, quiet, flow) {
  console.log(`\n== ${name}, effects ${level}`);
  console.log(table(HEAD, [row('typing, nothing changing', stats(quiet)), row('typing through the flow', stats(flow))]));
  const d = detail(flow);
  if (d.marks.length) console.log('\nwithin 1.5 s of each change of what Home shows:\n' + table(['at', 'light | receipt | rows', 'frames', 'median', 'p95', 'worst', '>20 ms', '>33 ms'], d.marks));
  if (d.long.length) console.log('\nframes over 20 ms:\n' + table(['at', 'interval', 'frame work', 'core changes', 'changes', 'band drawn', 'Home then shows'], d.long.slice(0, 40)));
}

function judge(level, flow, failures) {
  const s = stats(flow);
  if (flow.hidden) failures.push(`${level}: the window was covered, so nothing was measured`);
  if (s.keys < 40) failures.push(`${level}: only ${s.keys} keys reached the Composer`);
  if (s.p95 > 20) failures.push(`${level}: the 95th percentile of the frame intervals during the flow is ${r1(s.p95)} ms (20 ms at most)`);
  if (s.worst > 50) failures.push(`${level}: a frame took ${r1(s.worst)} ms during the flow (50 ms at most)`);
  if (s.kp95 > 30) failures.push(`${level}: the 95th percentile of the delay from a key to its frame is ${r1(s.kp95)} ms (30 ms at most)`);
  if (s.kworst > 100) failures.push(`${level}: a key took ${r1(s.kworst)} ms to show (100 ms at most)`);
  if (s.lost + s.caret) failures.push(`${level}: ${s.lost} keys were lost and ${s.caret} moved the caret from the end`);
}

// ---- the real app, its real core, the fixture agent ----
async function app(levels) {
  if (!awake()) throw new Error('The display is asleep: nothing drawn on it can be measured.');
  console.log('The display is awake. The built app, passive, on a temporary data folder, with the fixture agent.');
  const a = await launch({ exe: has('--debug') ? DEBUG : RELEASE, fixture: true });
  const ws = (e, x) => a.ask('workspace', e, x), out = {};
  const thought = (text) => `[...__ws.records.thoughts.values()].find(t => t.text.startsWith(${JSON.stringify(text)}))`;
  /** The agent of the thought that begins with `text`: its terminal is opened once, so it can be told what to do,
   *  it is made ready and at work on its turn, and Home is shown again. */
  const agent = async (text) => {
    if (!(await a.until('workspace', `${thought(text)}?.phase`, 'working', 15))) throw new Error('the thought did not start');
    await ws(`(__ws.focusSession(${thought(text)}.session_id), 1)`);
    if (!(await a.until('workspace', '__ws.text()', 'fixture-agent', 15))) throw new Error("the agent's terminal did not open");
    const id = await ws('__ws.current().id');
    for (const line of ['event:ready', 'event:turn_started']) (await ws(`__ws.type(${JSON.stringify(line)})`), await sleep(300));
    await ws(`(__ws.show('home'), 1)`);
    return id;
  };
  try {
    a.send('call put {"c":"prefs","id":"agent","patch":"fixture"}'), a.send('call put {"c":"prefs","id":"hold","patch":2}'), a.send('call agents.detect {}');
    await sleep(1200);
    if (await ws('document.hidden')) throw new Error('The window is covered: nothing can be measured.');
    await ws(`(__ws.command('open-workspace'), 1)`);
    await sleep(500);
    a.send('click workspace .sheet .act.primary');
    if (!(await a.until('workspace', `String([...__ws.records.projects.values()].some(p => p.kind === 'folder') && __ws.records.agents.has('fixture'))`, 'true', 10))) throw new Error('the folder did not open');
    await ws(`(__ws.show('home'), 1)`);
    await ws(`(document.querySelector('.home #capture-input').focus(), document.execCommand('insertText', false, 'first'), 1)`);
    a.send('key workspace Enter');
    let term = await agent('first');
    for (const level of levels) {
      a.send(`call put {"c":"prefs","id":"motion_ambient","patch":"${LEVELS[level]}"}`);
      // The light as it is in a window in use (a passive window never is): `breathe` held it so before the rule changed.
      await ws(`(__motion.debug.active = true, __motion.debug.breathe = ${level === 'full' ? 'true' : 'null'}, __motion.redraw(), 1)`);
      await sleep(1500);
      const quiet = await ws(FLOW, { seconds: QUIET, every: KEY });
      const running = ws(FLOW, { seconds: RUN, every: KEY });
      await sleep(AT.send * 1000);
      a.send('key workspace Enter');
      await sleep((AT.print - AT.send) * 1000);
      await ws(`(__ws.engines.get(${JSON.stringify(term)}).term.input(${JSON.stringify(Array.from({ length: 24 }, (_, i) => `print:line ${i} of the agent's output, long enough to fill most of a row of its terminal`).join('\r') + '\r')}, true), 1)`);
      await sleep((AT.result - AT.print) * 1000);
      await ws(`(__ws.engines.get(${JSON.stringify(term)}).term.input('event:turn_finished:All green.\\r', true), 1)`);
      const flow = await running;
      out[level] = { quiet, flow };
      print('The app', level, quiet, flow);
      // What was typed after the send is the next thought's text: it is cleared, and the thought just sent becomes
      // the agent at work in the next round.
      await ws(`(document.querySelector('.home #capture-input').focus(), document.execCommand('selectAll'), document.execCommand('delete'), 1)`);
      if (level !== levels[levels.length - 1]) term = await agent('the quick');
    }
  } finally {
    await a.quit();
  }
  return out;
}

// ---- headless: the pages from ui/dist, the core's changes pushed by a stand-in ----
async function headless(levels) {
  const { chromium } = require('playwright');
  const { serve, open } = require('./motion-pages.cjs');
  const { scene } = require('./instrument-fixtures.cjs');
  const server = await serve(path.resolve(arg('--dist', path.join(root, 'ui/dist')))), browser = await chromium.launch({ headless: true });
  const out = {};
  try {
    for (const level of levels) {
      const records = scene('normal');
      records.prefs = [{ id: 'motion_ambient', value: LEVELS[level], rev: 1 }];
      const page = await open(browser, { label: 'workspace', records, url: server.url, dpr: 1 });
      await page.evaluate((full) => (Object.assign(window.__motion.debug, { active: true, breathe: full ? true : null }), window.__motion.redraw()), level === 'full');
      await page.waitForTimeout(1500);
      const quiet = await page.evaluate(FLOW, { seconds: QUIET, every: KEY });
      const tracing = has('--trace') && level === levels[0];
      if (tracing) await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'blink.user_timing', 'toplevel'] });
      const running = page.evaluate(FLOW, { seconds: RUN, every: KEY });
      const working = records.thoughts.find((t) => t.status === 'working'), session = records.sessions.find((s) => s.id === working.session_id);
      const push = (sets) => page.evaluate((s) => window.__fake.push({ t: 'change', rev: Date.now() % 1e9, sets: s }), sets);
      await page.waitForTimeout(AT.send * 1000);
      await page.evaluate(() => document.querySelector('.home #capture-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
      await page.waitForTimeout(150);
      // The thought as the core shows it back: routed and held, then at work with its session starting, then working.
      const bid = '01a1f000-0000-7000-8000-0000000000b1', sid = '01a1f000-0000-7000-8000-0000000000b2';
      const b = { ...working, id: bid, rev: 900, text: 'the quick brown', brief: 'the quick brown', phase: 'routed', status: 'routed', live: false, session_id: null, hold_until: Date.now() + 2000, created: Date.now(), updated: Date.now() };
      await push([{ c: 'thoughts', put: [b] }]);
      await page.waitForTimeout(2000);
      await push([{ c: 'thoughts', put: [{ ...b, phase: 'working', status: 'working', live: true, session_id: sid, hold_until: null }] }, { c: 'sessions', put: [{ ...session, id: sid, thought_id: bid, terminal_id: null, state: 'starting', activity: [] }] }]);
      await page.waitForTimeout(600);
      await push([{ c: 'sessions', put: [{ ...session, id: sid, thought_id: bid, terminal_id: null, state: 'working', activity: ['Starting'] }] }]);
      await page.waitForTimeout((AT.print - AT.send) * 1000 - 2750);
      for (let i = 0; i < 24; i++) (await push([{ c: 'sessions', put: [{ ...session, rev: 1000 + i, activity: [`Read src/file${i}.ts`, `Edit src/file${i}.ts`] }] }]), await page.waitForTimeout(40));
      await page.waitForTimeout(Math.max(0, (AT.result - AT.print) * 1000 - 24 * 55));
      await push([{ c: 'thoughts', put: [{ ...working, rev: 2000, phase: 'done', status: 'done', live: false, updated: Date.now() }] }, { c: 'sessions', put: [{ ...session, rev: 2000, state: 'idle' }] },
        { c: 'results', put: [{ ...records.results[0], id: '01a1f000-0000-7000-8000-0000000000b3', rev: 2000, thought_id: working.id, session_id: session.id, kind: 'answer', summary: 'All green.' }] }]);
      const flow = await running;
      if (tracing) out.trace = attribute(JSON.parse(String(await browser.stopTracing())));
      out[level] = { quiet, flow };
      print('Headless', level, quiet, flow);
      for (const e of page.errors) console.log('page error: ' + e);
      await page.context().close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  return out;
}

/** Where the page's main thread spent its time, from a Chromium trace: each event's own time (its duration less its
 *  children's) by kind, and the tasks over 50 ms with what they were made of. */
function attribute(trace) {
  const events = trace.traceEvents ?? trace;
  const main = events.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
  const kind = (n) => (/^(Layout|UpdateLayoutTree|RecalculateStyles|InvalidateLayout|ScheduleStyleRecalculation)$/.test(n) ? (n === 'Layout' ? 'layout' : 'style')
    : /^(Paint|PrePaint|Layerize|Commit|UpdateLayer|UpdateLayerTree|CompositeLayers|PaintImage|Decode|RasterTask|IntersectionObserverController::computeIntersections)/.test(n) ? 'paint'
    : /GC|V8\.GC/.test(n) ? 'gc'
    : /^(FunctionCall|EvaluateScript|EventDispatch|TimerFire|FireAnimationFrame|RunMicrotasks|v8\.|V8\.|XHR|FireIdleCallback)/.test(n) ? 'script' : 'other');
  const xs = events.filter((e) => e.ph === 'X' && e.pid === main?.pid && e.tid === main?.tid && e.dur >= 0).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const total = { script: 0, style: 0, layout: 0, paint: 0, gc: 0, other: 0 }, stack = [], tasks = [];
  for (const e of xs) {
    while (stack.length && stack[stack.length - 1].end <= e.ts) stack.pop();
    const k = kind(e.name), own = { e, end: e.ts + e.dur, k };
    if (stack.length) total[stack[stack.length - 1].k] -= e.dur / 1000, stack[0].parts[stack[stack.length - 1].k] -= e.dur / 1000;
    else if (e.dur > 50000) tasks.push((own.task = { at: e.ts, ms: e.dur / 1000, parts: {}, names: new Set() }));
    own.parts = stack.length ? stack[0].parts : (own.task?.parts ?? {});
    own.names = stack.length ? stack[0].names : own.task?.names;
    total[k] += e.dur / 1000;
    own.parts[k] = (own.parts[k] ?? 0) + e.dur / 1000;
    if (e.name === 'FunctionCall' && e.args?.data?.functionName) own.names?.add(e.args.data.functionName);
    stack.push(own);
  }
  return { total: Object.fromEntries(Object.entries(total).map(([k, v]) => [k, Math.round(v)])), long: tasks.map((t) => ({ ms: Math.round(t.ms), parts: Object.fromEntries(Object.entries(t.parts).map(([k, v]) => [k, Math.round(v)])), names: [...t.names].slice(0, 6) })) };
}

async function main() {
  const levels = (has('--short') ? 'full' : arg('--levels', 'full,still,off')).split(',');
  const out = has('--app') ? await app(levels) : await headless(levels);
  if (has('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(out));
  if (out.trace) {
    console.log(`\n== Where the main thread's time went through the flow (headless, effects ${levels[0]}), in ms`);
    console.log(table(Object.keys(out.trace.total), [Object.values(out.trace.total)]));
    console.log(out.trace.long.length ? 'tasks over 50 ms:\n' + out.trace.long.map((t) => `  ${t.ms} ms  ${JSON.stringify(t.parts)}  ${t.names.join(', ')}`).join('\n') : 'no task over 50 ms');
  }
  const failures = [];
  for (const level of levels) judge(level, out[level].flow, failures);
  console.log('');
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? 'FAIL  the capture flow hitches' : 'PASS  typing through a capture, its placing, a session starting, an agent\'s output and a result: frames keep their pace (95th percentile at most 20 ms, none over 50 ms), keys show within a frame or two (95th percentile at most 30 ms, none over 100 ms), and none is lost');
  process.exitCode = failures.length ? 1 : 0;
}
if (require.main === module) main().catch((e) => (console.error(e), process.exit(1)));
