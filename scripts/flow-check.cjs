// The capture flow, timed: a person types into Home's Composer at a steady pace while the app's state changes
// under them: a thought is sent, placed and held, its session starts, an agent at work prints into its terminal,
// and a result arrives. For every display frame: the interval since the last and what the page did in it; for
// every key: the delay from the key to the end of the frame that shows it, and whether any was lost or moved the
// caret. First the same typing with nothing changing, for comparison; and each at every level of the effects
// (the core's `motion_ambient`: full, still, off), so the light's part in a hitch can be told from the page's.
// It fails when, during the flow, the 95th percentile of the frame intervals is over 1.2 of the frames the page is
// given (20 ms where it is given 60 a second, less where it is given more) or one is over 50 ms, when the 95th
// percentile of the key delays is over 1.8 frames (30 ms) or one is over 100 ms, or when a key is lost. In
// the app at Full it also watches the band through the flow, as cadence-check.cjs does: it fails when the band
// waits more than two of its intervals between drawings while it moves, or one of its clocks jumps.
// In the app the worst frame may take 33 ms and the worst key 67, so that no frame is missed outright. A frame that
// came late while the page's own thread was free is the machine's (another program had the processor): it is counted
// and said, and not held against the page. Headless it runs on the graphics card.
// usage: node scripts/flow-check.cjs [--app [--debug]] [--levels full,still,off] [--short] [--trace] [--json file]
//   headless by default: ui/dist on fixture records, the core's changes pushed by a stand-in; --trace adds where the
//   main thread's time went (script, style, layout, paint) and its long tasks, from Chromium's own timeline.
//   --app: the built app against its real core with the fixture agent (FIXTURES=1 host/scripts/build-core.sh),
//   passive, on a temporary data folder, in one short launch; --debug takes the debug build smoke.sh makes.
//   --short: one level (full) and a shorter quiet part, for smoke.sh.
const fs = require('node:fs');
const path = require('node:path');
const { launch, sleep, table, root, THOUGHT, DEBUG, RELEASE } = require('./app-driver.cjs');
const { FLOW, CADENCE } = require('./motion-probe.cjs');
const cadence = require('./cadence-check.cjs');
const has = (name) => process.argv.includes(name);
const arg = (name, or) => (has(name) ? process.argv[process.argv.indexOf(name) + 1] : or);
const LEVELS = { full: 'breathing', still: 'still', off: 'off' };
const KEY = 90, QUIET = has('--short') ? 3 : 5, RUN = 11;

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
const r1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
/** Whether a frame or a key that took `ms` was held up by the page: its own thread was busy for half of that or
 *  more (`held`: motion-probe.cjs). Otherwise the machine was: another program had the processor, and the page, free
 *  all the while, was given its frame late. Those are counted apart, and not held against the page. */
const own = (ms, held) => held === undefined || held >= ms / 2;
function stats(rec) {
  const all = rec.frames.slice(1), gaps = all.map((f) => f[1]), keys = rec.keys.map((k) => k[1]), frame = pct(gaps, 0.5);
  return {
    frames: gaps.length, median: frame, p95: pct(gaps, 0.95), worst: Math.max(0, ...all.filter((f) => own(f[1], f[6])).map((f) => f[1])), late: gaps.filter((g) => g > frame * 1.2).length, missed: gaps.filter((g) => g > frame * 2).length,
    keys: keys.length, kmedian: pct(keys, 0.5), kp95: pct(keys, 0.95), kworst: Math.max(0, ...rec.keys.filter((k) => own(k[1], k[3])).map((k) => k[1])), refused: rec.refused, lost: rec.lost + rec.caret,
    away: all.filter((f) => f[1] > Math.max(frame, 1000 / 60) * 2 && !own(f[1], f[6])).map((f) => f[1]),
  };
}
const row = (name, s) => [name, s.frames, r1(s.median), r1(s.p95), r1(s.worst), s.late, s.missed, s.keys, r1(s.kmedian), r1(s.kp95), r1(s.kworst), s.refused, s.lost];
const HEAD = ['', 'frames', 'median', 'p95', 'worst', 'late', 'missed', 'keys', 'key median', 'key p95', 'key worst', 'refused', 'lost'];

/** The frames within a second and a half of each change of what Home shows, and the frames that came late. */
function detail(rec) {
  const frame = pct(rec.frames.slice(1).map((f) => f[1]), 0.5), out = [];
  for (const [at, what] of rec.marks.slice(1)) {
    const near = rec.frames.filter((f) => Math.abs(f[0] - at) <= 1500), gaps = near.map((f) => f[1]);
    out.push([`${(at / 1000).toFixed(2)} s`, what, near.length, r1(pct(gaps, 0.5)), r1(pct(gaps, 0.95)), r1(Math.max(0, ...gaps)), gaps.filter((g) => g > frame * 1.2).length, gaps.filter((g) => g > frame * 2).length]);
  }
  const long = rec.frames.slice(1).filter((f) => f[1] > frame * 1.2).map((f) => [`${(f[0] / 1000).toFixed(2)} s`, r1(f[1]), r1(f[2]), r1(f[3]), f[5], f[4] ? 'yes' : '', (rec.marks.filter((m) => m[0] <= f[0] + 20).pop() ?? [0, ''])[1]]);
  return { marks: out, long };
}

function print(name, level, quiet, flow) {
  const page = pct(quiet.frames.slice(1).map((f) => f[1]), 0.5);
  console.log(`\n== ${name}, effects ${level}: the page is given a frame every ${r1(page)} ms (${Math.round(1000 / page)} a second); times in ms; late: over 1.2 frames; missed: over 2`);
  console.log(table(HEAD, [row('typing, nothing changing', stats(quiet)), row('typing through the flow', stats(flow))]));
  const away = [...stats(quiet).away, ...stats(flow).away];
  if (away.length) console.log(`(not the page's: ${away.length} frames came late while its thread was free, the longest after ${r1(Math.max(...away))} ms: the machine was busy)`);
  const d = detail(flow);
  if (d.marks.length) console.log('\nwithin 1.5 s of each change of what Home shows:\n' + table(['at', 'light | receipt | rows', 'frames', 'median', 'p95', 'worst', 'late', 'missed'], d.marks));
  if (d.long.length) console.log('\nlate frames:\n' + table(['at', 'interval', 'frame work', 'core changes', 'changes', 'band drawn', 'Home then shows'], d.long.slice(0, 40)));
}

/** The limits follow the rate the page is given frames at: at 60 a second they are 20 and 50 ms for a frame, 30 and
 *  100 ms for a key. */
function judge(level, quiet, flow, failures) {
  // The worst frame and the worst key are held to what a person would see as a hitch, however fast the frames come.
  // In the app no frame may be missed outright (two frames, 33 ms); headless three, as before.
  const s = stats(flow), frame = stats(quiet).median, hitch = Math.max(frame, 1000 / 60), most = has('--app') ? 2 : 3, key = has('--app') ? 4 : 6;
  if (flow.hidden) failures.push(`${level}: the window was covered, so nothing was measured`);
  if (s.keys < 40) failures.push(`${level}: only ${s.keys} keys reached the Composer`);
  if (!flow.marks.some((m) => /working|done|Started in/.test(m[1]))) failures.push(`${level}: the thought never came to work, so the flow was not measured`);
  if (s.p95 > frame * 1.2) failures.push(`${level}: the 95th percentile of the frame intervals during the flow is ${r1(s.p95)} ms (${r1(frame * 1.2)} at most, at a frame of ${r1(frame)} ms)`);
  if (s.worst > hitch * most) failures.push(`${level}: a frame took ${r1(s.worst)} ms during the flow (${r1(hitch * most)} at most)`);
  if (s.kp95 > frame * 1.8) failures.push(`${level}: the 95th percentile of the delay from a key to its frame is ${r1(s.kp95)} ms (${r1(frame * 1.8)} at most)`);
  if (s.kworst > hitch * key) failures.push(`${level}: a key took ${r1(s.kworst)} ms to show (${r1(hitch * key)} at most)`);
  if (s.lost) failures.push(`${level}: ${flow.lost} keys were lost and ${flow.caret} moved the caret from the end`);
}

// ---- the real app, its real core, the fixture agent ----
async function app(levels) {
  const a = await launch({ exe: arg('--exe', has('--debug') ? DEBUG : RELEASE), fixture: true, display: Number(arg('--display', 0)) });
  const ws = (e, x) => a.ask('workspace', e, x), out = {};
  try {
    await a.prepare();
    out.display = a.seen();
    console.log(out.display.said + ' The built app, passive, on a temporary data folder, with the fixture agent.');
    for (const level of levels) {
      a.send(`call put {"c":"prefs","id":"motion_ambient","patch":"${LEVELS[level]}"}`);
      // The light as it is in a window in use, which a passive window never is (`breathe` held it so before the
      // rule that it rests while nothing happens).
      await ws(`(__motion.debug.active = true, __motion.redraw(), 1)`);
      await sleep(1500);
      const quiet = await ws(FLOW, { seconds: QUIET, every: KEY });
      await ws(`(document.querySelector('.home #capture-input').focus(), document.execCommand('selectAll'), document.execCommand('delete'), 1)`);
      // At Full the band is watched through the flow as well: its cadence, its steps and its clocks.
      const band = level === 'full' ? ws(CADENCE, { seconds: RUN + 0.5 }) : null;
      const flow = await ws(FLOW, { seconds: RUN, every: KEY, send: THOUGHT });
      a.seen();
      out[level] = { quiet, flow, band: await band };
      print(`The app on the ${out.display.hz} Hz display`, level, quiet, flow);
      // The next round begins at rest.
      await a.rest();
    }
  } finally {
    await a.quit();
  }
  return out;
}

// ---- headless: the pages from ui/dist, the core's changes pushed by a stand-in ----
async function headless(levels) {
  const { chromium } = require('playwright');
  const { serve, open, GPU } = require('./motion-pages.cjs');
  const { scene } = require('./instrument-fixtures.cjs');
  const server = await serve(path.resolve(arg('--dist', path.join(root, 'ui/dist')))), browser = await chromium.launch({ headless: true, args: GPU });
  const out = {};
  try {
    for (const level of levels) {
      const records = scene('quiet');
      records.prefs = [{ id: 'motion_ambient', value: LEVELS[level], rev: 1 }];
      const page = await open(browser, { label: 'workspace', records, url: server.url, dpr: 1 });
      await page.evaluate(() => (Object.assign(window.__motion.debug, { active: true }), window.__motion.redraw()));
      await page.waitForTimeout(1500);
      const quiet = await page.evaluate(FLOW, { seconds: QUIET, every: KEY });
      await page.evaluate(() => (document.querySelector('.home #capture-input').focus(), document.execCommand('selectAll'), document.execCommand('delete')));
      const tracing = has('--trace') && level === levels[0];
      if (tracing) await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'toplevel'] });
      const running = page.evaluate(FLOW, { seconds: RUN, every: KEY, send: THOUGHT });
      // The thought as the core shows it back: routed and held; at work with its session starting; working; its
      // agent's activity, line after line; its result.
      const sent = await page.waitForFunction(() => window.__fake.sent, null, { timeout: 5000 }).then((h) => h.jsonValue());
      const like = records.thoughts.find((t) => t.status === 'done'), project = records.projects[0].id, sid = '01a1f000-0000-7000-8000-0000000000b2';
      const push = (sets) => page.evaluate((s) => window.__fake.push({ t: 'change', rev: Math.round(performance.now()) + 5000, sets: s }), sets);
      const t = { ...like, id: sent.id, text: sent.text, brief: sent.text, phase: 'routed', status: 'routed', live: false, project_id: project, session_id: null, read: false, hold_until: Date.now() + 2000, created: Date.now(), updated: Date.now() };
      const s = { id: sid, rev: 1, project_id: project, agent: 'claude', terminal_id: null, adopted: false, state: 'starting', thought_id: sent.id, turn: 1, resume: null, name: null, named_at: null, model: null, cwd: '', exit: null, error: null, activity: [] };
      await page.waitForTimeout(30);
      await push([{ c: 'thoughts', put: [t] }]);
      await page.waitForTimeout(2000);
      await push([{ c: 'thoughts', put: [{ ...t, phase: 'working', status: 'working', live: true, session_id: sid, hold_until: null }] }, { c: 'sessions', put: [s] }]);
      await page.waitForTimeout(300);
      await push([{ c: 'sessions', put: [{ ...s, state: 'working', activity: ['Starting'] }] }]);
      await page.waitForTimeout(1500);
      for (let i = 0; i < 24; i++) (await push([{ c: 'sessions', put: [{ ...s, state: 'working', activity: [`Read src/file${i}.ts`, `Edit src/file${i}.ts`] }] }]), await page.waitForTimeout(20));
      await page.waitForTimeout(1500);
      await push([{ c: 'thoughts', put: [{ ...t, phase: 'done', status: 'done', live: false, session_id: sid, hold_until: null, updated: Date.now() }] }, { c: 'sessions', put: [{ ...s, state: 'idle' }] },
        { c: 'results', put: [{ id: '01a1f000-0000-7000-8000-0000000000b3', rev: 1, thought_id: sent.id, session_id: sid, turn: 1, kind: 'answer', summary: 'All green.' }] }]);
      // Then a dictation records in another window for two seconds, its level told ten times a second: the form
      // listens, and whatever shows a recording moves.
      await page.waitForTimeout(700);
      const heard = { id: '01a1f000-0000-7000-8000-0000000000b4', phase: 'recording', text: '', target: { kind: 'text' }, error: null };
      for (let i = 0; i < 20; i++) (await push([{ c: 'dictations', put: [{ ...heard, rev: 1, level: Math.round(35 + 30 * Math.sin(i * 0.9) + 20 * Math.sin(i * 2.3)) }] }]), await page.waitForTimeout(100));
      await push([{ c: 'dictations', del: [heard.id] }]);
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
  for (const level of levels) judge(level, out[level].quiet, out[level].flow, failures);
  if (out.full?.band) {
    console.log('\n== The band through the flow, effects full');
    cadence.judge('the band through the flow', cadence.print(out.full.band), failures);
  }
  console.log('');
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? 'FAIL  the capture flow hitches' : 'PASS  typing through a capture, its placing, a session starting, an agent\'s output and a result: frames keep their pace (95th percentile within 1.2 of the frames given, 20 ms at 60 a second, none over 50 ms), keys show within a frame or two (95th percentile within 1.8 frames, 30 ms, none over 100 ms), and none is lost');
  process.exitCode = failures.length ? 1 : 0;
}
if (require.main === module) main().catch((e) => (console.error(e), process.exit(1)));
