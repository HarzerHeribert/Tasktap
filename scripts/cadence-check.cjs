// The band's cadence: Home with agents working, in the window in use, over a few of the band's pulses and a change
// of state: for every display frame, whether the band was drawn again, the time since it last was, and how far its
// picture changed. While something moves the band must be drawn in every display frame from the first of a movement
// to its last, no two drawings in a row may be the same picture, and no step may be many times the usual one: a slow
// movement is a small even change in every frame, never one frame, a pause, and one frame.
// usage: node scripts/cadence-check.cjs [--app] [--seconds 40] [--json file] [--keep 30]
//   headless by default (ui/dist on fixture records); --app measures the built app, passive, in a short launch.
//   Exit status 1 on a failure.
const fs = require('node:fs');
const path = require('node:path');
const { launch, awake, sleep, table, root } = require('./app-driver.cjs');
const { CADENCE } = require('./motion-probe.cjs');
const arg = (name, or) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : or);
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;

/** What a recording says of each movement, in quarter seconds of its progress. */
function report(rec) {
  const frame = median(rec.frames.map((f) => f[1]).filter((x) => x > 0)), out = [];
  for (const m of rec.moves) {
    const all = rec.frames.filter((f) => f[0] >= m.from - 0.05 && f[0] <= m.to + 0.05);
    const t0 = all[0]?.[0] ?? 0, usual = median(all.filter((f) => f[2] && f[4] > 0).map((f) => f[4]));
    const rows = [];
    for (let s = 0; s * 250 <= (all[all.length - 1]?.[0] ?? 0) - t0; s++) {
      const part = all.filter((f) => f[0] - t0 >= s * 250 && f[0] - t0 < (s + 1) * 250), drawn = part.filter((f) => f[2]);
      if (!part.length) continue;
      rows.push([`${(s * 0.25).toFixed(2)} s`, part.length, drawn.length, Math.round(Math.max(0, ...drawn.map((f) => f[3]))), median(drawn.map((f) => f[4])).toFixed(4), Math.max(0, ...drawn.map((f) => f[4])).toFixed(4),
        drawn.filter((f, i) => f[4] === 0 && (s || i)).length]);
    }
    const drawn = all.filter((f) => f[2]).slice(1), gaps = drawn.map((f) => f[3]);
    out.push({
      seconds: (m.to - m.from) / 1000, frames: all.length, drawn: drawn.length + 1, held: all.length - drawn.length - 1, gap: Math.max(0, ...gaps), same: drawn.filter((f) => f[4] === 0).length,
      usual, jump: usual ? Math.max(...drawn.map((f) => f[4])) / usual : 0, rows,
    });
  }
  return { frame, moves: out };
}

function print(rec) {
  const r = report(rec);
  console.log(`band canvas ${rec.size.join(' x ')} px shown at ${rec.shown.map(Math.round).join(' x ')}, display frame ${r.frame.toFixed(1)} ms, ${r.moves.length} movements`);
  r.moves.forEach((m, i) => {
    console.log(`\nmovement ${i + 1}: ${m.seconds.toFixed(1)} s, ${m.frames} display frames, drawn in ${m.drawn}, held in ${m.held}; longest wait between two drawings ${Math.round(m.gap)} ms; ${m.same} drawings the same as the one before; largest step ${m.jump.toFixed(1)} times the usual`);
    console.log(table(['progress', 'frames', 'drawn', 'longest wait ms', 'usual change', 'largest change', 'unchanged'], m.rows));
  });
  return r;
}

/** Agents working in the window in use; then, after `seconds`, a thought captured and routed (thinking, then working). */
async function record(ask, seconds, keep) {
  await ask(`(__motion.debug.state='working', __motion.debug.breathe=true, __motion.redraw(), 1)`);
  await sleep(4000);
  const steady = ask(CADENCE, { seconds, keep, crop: [0.3, 0.3, 0.4, 0.4] });
  const rec = await steady;
  const change = ask(CADENCE, { seconds: 9, keep: 0 });
  await sleep(1000);
  await ask(`(__motion.debug.state='thinking', __motion.redraw(), 1)`);
  await sleep(3000);
  await ask(`(__motion.debug.state='working', __motion.redraw(), 1)`);
  return { steady: rec, change: await change };
}

async function main() {
  const seconds = Number(arg('--seconds', 40)), keep = Number(arg('--keep', 0)), file = arg('--json', '');
  let rec;
  if (process.argv.includes('--app')) {
    if (!awake()) throw new Error('The display is asleep: nothing drawn on it can be measured.');
    console.log('The display is awake. Measuring the built app, passive, on a temporary data folder.');
    const app = await launch();
    try {
      await sleep(1500);
      if (await app.ask('workspace', 'document.hidden')) throw new Error('The window is covered: nothing can be measured.');
      rec = await record((e, a) => app.ask('workspace', e, a), seconds, keep);
    } finally {
      await app.quit();
    }
  } else {
    const { chromium } = require('playwright');
    const { serve, open } = require('./motion-pages.cjs');
    const { scene } = require('./instrument-fixtures.cjs');
    const server = await serve(path.join(root, 'ui/dist')), browser = await chromium.launch({ headless: true });
    try {
      const page = await open(browser, { label: 'workspace', records: scene('quiet'), url: server.url, dpr: 1 });
      rec = await record((e, a) => (typeof e === 'function' ? page.evaluate(e, a) : page.evaluate(e)), seconds, keep);
    } finally {
      await browser.close();
      await server.close();
    }
  }
  if (file) fs.writeFileSync(file, JSON.stringify(rec));
  console.log('== Agents working: the band\'s pulses');
  const steady = print(rec.steady);
  console.log('\n== A thought captured and routed: thinking, then working');
  const change = print(rec.change);
  const failures = [];
  for (const [name, r] of [['working', steady], ['a change of state', change]])
    r.moves.forEach((m, i) => {
      if (m.gap > r.frame * 2.5) failures.push(`${name}, movement ${i + 1}: the band waited ${Math.round(m.gap)} ms between two drawings while it moved (a display frame is ${r.frame.toFixed(1)} ms)`);
      if (m.same > 2) failures.push(`${name}, movement ${i + 1}: ${m.same} drawings were the same picture as the one before`);
      if (m.jump > 8) failures.push(`${name}, movement ${i + 1}: its largest step is ${m.jump.toFixed(1)} times its usual one`);
    });
  if (!steady.moves.length) failures.push('the band did not move');
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? 'FAIL  the band is not drawn evenly while it moves' : 'PASS  while it moves the band is drawn in every display frame, each drawing differs from the last, and no step is many times the usual one');
  process.exitCode = failures.length ? 1 : 0;
}
if (require.main === module) main().catch((e) => (console.error(e), process.exit(1)));
module.exports = { report };
