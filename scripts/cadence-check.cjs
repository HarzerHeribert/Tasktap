// The band's cadence. Home in the window in use, twice: with agents working, over a few of the band's pulses; and at
// rest when a thought is typed and sent, through its placing, its work and its result. For every display frame:
// whether the band was drawn again, the wait since it last was, how far its picture changed, and the band's own
// clocks at that drawing. While something moves the band must be drawn at one cadence from the first frame of a
// movement to its last (in every frame the page is given, up to about 60 a second, whatever the display's rate and
// however it varies), no two drawings in a row may be the same picture, no drawing may change the picture three
// times as fast as the ones before it, and no clock may jump: a slow movement is a small, even change in every frame,
// never one frame, a pause, and a lurch.
// usage: node scripts/cadence-check.cjs [--app [--exe file] [--display hz]] [--seconds 30] [--keep 36] [--json file]
//   headless by default (ui/dist on fixture records, the states set by hand); --app measures the built app, passive,
//   in one short launch, the capture run by its real core with the fixture agent. Exit status 1 on a failure.
const fs = require('node:fs');
const path = require('node:path');
const { launch, sleep, table, root, THOUGHT, AIM } = require('./app-driver.cjs');
const { CADENCE, FLOW, STREAM } = require('./motion-probe.cjs');
const has = (name) => process.argv.includes(name);
const arg = (name, or) => (has(name) ? process.argv[process.argv.indexOf(name) + 1] : or);
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;
const pct = (xs, p) => [...xs].filter((x) => x > 0).sort((a, b) => a - b)[Math.floor(xs.filter((x) => x > 0).length * p)] ?? 0;

/** What a recording says of each movement, in quarter seconds of its progress. */
function report(rec) {
  const frame = median(rec.frames.map((f) => f[1]).filter((x) => x > 0)), out = [];
  for (const m of rec.moves) {
    const all = rec.frames.filter((f) => f[0] >= m.from - 0.05 && f[0] <= m.to + 0.05), t0 = all[0]?.[0] ?? 0;
    // A drawing in which the places kept clear of words changed is the page's change, not a step of the motion.
    const every = all.filter((f) => f[2]), drawn = every.slice(1).filter((f, i) => f.length < 11 || f[10] === every[i][10]), usual = median(drawn.filter((f) => f[4] > 0).map((f) => f[4]));
    // What the compositor fades on moves at the display's own rate between the page's frames, however far apart
    // those come: its wait is what is over the page's own interval, and its clocks may move by all the time passed.
    every.forEach((f, i) => {
      if (f[11]) f[3] = Math.max(Math.min(f[3], frame), f[3] - f[1] + frame);
      if (f[11] || every[i - 1]?.[11]) (f.passed = Math.max(50, f[1] + 2)), (f.over = f[1]);
    });
    const rows = [];
    for (let s = 0; s * 250 <= (all[all.length - 1]?.[0] ?? 0) - t0; s++) {
      const part = all.filter((f) => f[0] - t0 >= s * 250 && f[0] - t0 < (s + 1) * 250), d = part.filter((f) => f[2] && f !== all[0]);
      if (!part.length) continue;
      rows.push([`${(s * 0.25).toFixed(2)} s`, [...new Set(part.map((f) => f[6]))].join(' > '), part.length, part.filter((f) => f[2]).length, Math.round(Math.max(0, ...d.map((f) => f[3]))),
        median(d.map((f) => f[4])).toFixed(4), Math.max(0, ...d.map((f) => f[4])).toFixed(4), d.filter((f) => f[4] === 0).length,
        ...(drawn[0]?.length > 7 ? [Math.max(0, ...d.map((f) => f.pulse ?? 0)).toFixed(4), Math.max(0, ...d.map((f) => f.own ?? 0)).toFixed(4)] : [])]);
    }
    // How far each of its clocks moved from one drawing to the next: the pulse's, in its units, while one passes; the form's own phase.
    drawn.forEach((f, i) => {
      const was = i ? drawn[i - 1] : all.find((x) => x[2]);
      if (f.length > 7 && was.length > 7) (f.pulse = ((f[7] < 3.6 && f[7] > was[7] ? f[7] - was[7] : 0) * 50) / (f.passed ?? 50)), (f.own = (Math.abs(f[8] - was[8]) * 50) / (f.passed ?? 50));
    });
    out.push({
      seconds: (m.to - m.from) / 1000, frames: all.length, drawn: drawn.length + 1, gap: Math.max(0, ...drawn.map((f) => f[3])), same: drawn.filter((f) => f[4] === 0).length,
      // How fast each drawing changed the picture (a level a millisecond), against the fastest of the three before it.
      usual, jump: Math.max(0, ...drawn.map((f, i) => (i > 2 && f[4] > 0.3 ? f[4] / Math.max(f.over ?? f[3], 1) / Math.max(0.01, ...drawn.slice(i - 3, i).map((p) => p[4] / Math.max(p.over ?? p[3], 1))) : 0))), pulse: Math.max(0, ...drawn.map((f) => f.pulse ?? 0)), own: Math.max(0, ...drawn.map((f) => f.own ?? 0)), clocks: drawn[0]?.length > 7, rows,
    });
    // The rows were made before the clocks' steps were known.
    for (const r of rows) if (r.length > 8) {
      const s = parseFloat(r[0]) * 1000, d = drawn.filter((f) => f[0] - t0 >= s && f[0] - t0 < s + 250);
      (r[8] = Math.max(0, ...d.map((f) => f.pulse ?? 0)).toFixed(4)), (r[9] = Math.max(0, ...d.map((f) => f.own ?? 0)).toFixed(4));
    }
  }
  // The band's own cadence: the usual time from one drawing to the next while it moves.
  return { frame, due: median(rec.frames.filter((f) => f[2] && f[3] > 0 && f[3] < 400).map((f) => f[3])) || frame, moves: out };
}

function print(rec) {
  const r = report(rec);
  console.log(`band canvas ${rec.size.join(' x ')} px shown at ${rec.shown.map(Math.round).join(' x ')}; the page is given a frame every ${r.frame.toFixed(1)} ms (${Math.round(1000 / r.frame)} a second; the 5th to the 95th percentile of its intervals ${pct(rec.frames.map((f) => f[1]), 0.05).toFixed(1)} to ${pct(rec.frames.map((f) => f[1]), 0.95).toFixed(1)} ms), the band is drawn every ${r.due.toFixed(1)} ms while it moves; ${r.moves.length} movements`);
  r.moves.forEach((m, i) => {
    console.log(`\nmovement ${i + 1}: ${m.seconds.toFixed(1)} s, ${m.frames} display frames, drawn in ${m.drawn}; longest wait between two drawings ${Math.round(m.gap)} ms; ${m.same} drawings the same as the one before; the fastest a drawing changed the picture, against the three before it: ${m.jump.toFixed(1)} times${m.clocks ? `; largest step of the pulse's clock ${m.pulse.toFixed(4)} units, of the form's own phase ${m.own.toFixed(4)}` : ''}`);
    console.log(table(['progress', 'light', 'frames', 'drawn', 'longest wait ms', 'usual change', 'largest change', 'unchanged', ...(m.clocks ? ['pulse step', 'phase step'] : [])], m.rows));
  });
  return r;
}

function judge(name, r, failures, slack = 2.2) {
  const due = r.due;
  r.moves.forEach((m, i) => {
    if (m.drawn < 4) return;
    if (m.gap > due * slack) failures.push(`${name}, movement ${i + 1}: the band waited ${Math.round(m.gap)} ms between two drawings while it moved (its cadence is one every ${due.toFixed(1)} ms)`);
    if (m.same > Math.max(2, m.drawn * 0.02)) failures.push(`${name}, movement ${i + 1}: ${m.same} drawings were the same picture as the one before`);
    if (m.jump > 3) failures.push(`${name}, movement ${i + 1}: one drawing changed the picture ${m.jump.toFixed(1)} times as fast as the three before it: a lurch`);
    // A pulse's unit is two seconds and the form's own phase moves at most 0.66 a second.
    // (The clock itself never takes more than 50 ms at once, whatever the wait.)
    if (m.pulse > 0.0255) failures.push(`${name}, movement ${i + 1}: the pulse's clock jumped ${m.pulse.toFixed(4)} units between two drawings (0.025, which is 50 ms, at most)`);
    if (m.own > 0.0335) failures.push(`${name}, movement ${i + 1}: the form's own phase jumped ${m.own.toFixed(4)} between two drawings (0.033, which is 50 ms of it, at most)`);
  });
  if (!r.moves.some((m) => m.drawn >= 4)) failures.push(`${name}: the band did not move`);
}

async function main() {
  const seconds = Number(arg('--seconds', 30)), keep = Number(arg('--keep', 0)), out = {};
  const pulses = { seconds, keep, crop: [0.3, 0.3, 0.4, 0.4] }, capture = { seconds: 11, keep, crop: [0.3, 0.3, 0.4, 0.4] };
  // The light as it is in a window in use, which a passive or headless window never is (`breathe` held it so before
  // the rule that it rests while nothing happens).
  const use = (state) => `(Object.assign(__motion.debug, { state: ${state}, active: true, breathe: true }), __motion.redraw(), 1)`;
  if (has('--app')) {
    const app = await launch({ ...(arg('--exe', '') ? { exe: arg('--exe') } : {}), display: Number(arg('--display', 0)), fixture: true });
    const ws = (e, a) => app.ask('workspace', e, a);
    try {
      await app.prepare();
      out.display = app.seen();
      console.log(out.display.said + ' The built app, passive, on a temporary data folder, with the fixture agent.');
      await ws(use(null));
      await sleep(2500);
      await ws(AIM);
      const flow = ws(FLOW, { seconds: 10.5, every: 90, send: THOUGHT });
      out.capture = await ws(CADENCE, capture);
      out.flow = await flow;
      await app.rest();
      await ws(use("'working'"));
      await sleep(3000);
      out.pulses = await ws(CADENCE, pulses);
      app.seen();
    } finally {
      await app.quit();
    }
  } else {
    const { chromium } = require('playwright');
    const { serve, open, GPU } = require('./motion-pages.cjs');
    const { scene } = require('./instrument-fixtures.cjs');
    const server = await serve(path.resolve(arg('--dist', path.join(root, 'ui/dist')))), browser = await chromium.launch({ headless: true, args: GPU });
    try {
      const page = await open(browser, { label: 'workspace', records: scene('quiet'), url: server.url, dpr: 1 });
      await page.evaluate(use(null));
      await sleep(2500);
      const rec = page.evaluate(CADENCE, capture);
      for (const [ms, state] of [[1600, "'thinking'"], [2100, "'working'"], [3000, "'done'"]]) (await sleep(ms), await page.evaluate(use(state)));
      out.capture = await rec;
      await page.evaluate(use("'working'"));
      await sleep(3000);
      out.pulses = await page.evaluate(CADENCE, pulses);
      // The same loop on other streams of frames: even ones of several rates, and one that varies from frame to
      // frame as a variable-rate display's does, with a frame now and then twice as late.
      out.streams = [];
      for (const [name, gaps, late] of [['60 a second', [1000 / 60]], ['120', [1000 / 120]], ['144', [1000 / 144]], ['240', [1000 / 240]], ['varying: 4, 7, 8.3 and 16.7 ms, some 33', [4, 7, 8.33, 16.7], 33]])
        out.streams.push({ name, ...(await page.evaluate(STREAM, { gaps, late: late ?? 0, seconds: 12 })) });
    } finally {
      await browser.close();
      await server.close();
    }
  }
  if (has('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(out));
  const failures = [];
  console.log('\n== At rest, then a thought typed and sent: placed, at work, and its result');
  // Headless the picture is drawn by software, which holds a frame up now and then: a wait counts from four intervals.
  const slack = has('--app') ? 2.2 : 4;
  judge('a thought sent', print(out.capture), failures, slack);
  console.log("\n== Agents working: the band's pulses");
  judge('working', print(out.pulses), failures, slack);
  if (out.streams) {
    console.log('\n== Agents working, on other streams of frames (handed to the page on a clock of the check\'s own)');
    console.log(table(['frames', 'given a second', 'drawn a second', 'longest wait, ms', "form's phase a second", 'furthest from the time passed, ms'],
      out.streams.map((r) => [r.name, r.given.toFixed(0), r.drawn.toFixed(1), r.longest.toFixed(1), r.rate.toFixed(4), r.off.toFixed(2)])));
    const base = out.streams[0];
    for (const r of out.streams) {
      if (r.drawn > 90 || r.drawn < 40) failures.push(`on frames ${r.name} the band is drawn ${r.drawn.toFixed(1)} times a second (its cost must follow its own rate, 60 to 80, not the stream's)`);
      if (Math.abs(r.rate - base.rate) > Math.abs(base.rate) * 0.02 || r.off > 3) failures.push(`on frames ${r.name} the band does not move by the time passed: its phase goes ${r.rate.toFixed(4)} a second against ${base.rate.toFixed(4)}, and is up to ${r.off.toFixed(1)} ms of motion from where time would have it`);
    }
  }
  console.log('');
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? 'FAIL  the band is not drawn evenly while it moves' : 'PASS  while it moves the band is drawn at one even cadence, each drawing differs from the last, none changes the picture three times as fast as those before it, and none of its clocks jumps');
  process.exitCode = failures.length ? 1 : 0;
}
if (require.main === module) main().catch((e) => (console.error(e), process.exit(1)));
module.exports = { report, print, judge };
