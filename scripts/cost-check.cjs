// What the effects cost, in the built app: processor use and idle wakeups of the app's own processes (the host, its
// core, its web views), with the window compositor beside them, and the app's memory at each level of the effects.
// At rest it must cost nothing, in front or behind; while agents work it is a loop, measured over a minute on Home
// and beside a terminal (where only the sidebar's glyphs move). Passive, on a temporary data folder, in four short
// launches (one a level for memory, since a level's memory is what the app takes when it starts at it).
// usage: node scripts/cost-check.cjs [--exe file] [--display hz] [--json file] [--shots folder] [--brief] [--minutes n] [--steps 0.8,1.2]
//   --brief: rest and one working measure only. --shots: a picture of Home at each level, taken by the app itself.
//   --minutes: how long each loop is measured (1; with 5, each half minute is also said, which shows a cost that
//   grows). --steps: agents working again with keyframes that many pixels apart (engine.ts STEP), a minute each.
//   Each loop is measured as shipped (the compositor carries it) and with the page drawing every frame, as before.
//   Per process, from the system's own counts (usage.swift): processor time, the share of it on the fast cores,
//   instructions (the work itself), wakeups and power.
//   It fails when the app at rest uses 0.3 % of a core or more.
const fs = require('node:fs');
const { launch, sleep, table } = require('./app-driver.cjs');
const has = (name) => process.argv.includes(name);
const arg = (name, or) => (has(name) ? process.argv[process.argv.indexOf(name) + 1] : or);

async function main() {
  const exe = arg('--exe', '') ? { exe: arg('--exe') } : {}, display = Number(arg('--display', 0)), out = { cost: [], memory: [], skipped: [] };
  const app = await launch({ ...exe, display });
  const ws = (e) => app.ask('workspace', e);
  // The light as it is in a window in use, or not, whatever this passive window is; and the state it shows.
  const set = (state, active) => ws(`(Object.assign(__motion.debug, { state: ${state ? `'${state}'` : null}, active: ${active} }), __motion.redraw(), 1)`);
  const level = async (to) => (app.send(`call put {"c":"prefs","id":"motion_ambient","patch":"${to}"}`), sleep(800));
  // A measure taken while the window was covered (the person working over it) says nothing: it is taken again, up
  // to three times, and otherwise left out and said so.
  const measure = async (name, seconds, every = 0) => {
    await sleep(4000);
    for (let tries = 0; tries < 3; tries++) {
      try {
        app.seen();
        const drew = async () => ws('[__motion.stats.frames, __motion.stats.keys ?? 0, __motion.stats.late ?? 0]');
        const before = await drew(), c = await app.cost(seconds, every), after = await drew();
        app.seen();
        out.cost.push({ name, seconds, ...c, drawn: Math.round((after[0] - before[0]) / seconds), keys: Math.round(((after[1] - before[1]) / seconds) * 10) / 10, late: after[2] - before[2] });
        return console.log(`  ${name}: ${c.cpu} % of a core, ${c.wakeups} wakeups a second${every ? `; every ${every} s: ${c.series.join(', ')}` : ''}`);
      } catch (e) {
        if (!/covered|not on screen/.test(e.message)) throw e;
        await sleep(6000);
      }
    }
    out.skipped.push(name);
    console.log(`  ${name}: not measured, the window was covered`);
  };
  // How the loops are shown: carried by the compositor (as shipped; `step`: with keyframes that far apart), or drawn by
  // the page in every frame, as they were before (an earlier build takes no notice, and draws every frame anyway).
  const how = (carry, step) => ws(`(Object.assign(__motion.stats, { carry: ${carry}${step ? `, step: ${step}` : ''} }), 1)`);
  const long = Number(arg('--minutes', 1)) * 60, every = long > 90 ? 30 : 0, steps = arg('--steps', '').split(',').filter(Boolean).map(Number);
  try {
    await sleep(8000);
    out.display = app.seen();
    console.log(out.display.said + ' The built app, passive, on a temporary data folder.');
    await measure('at rest behind other windows: Home, nothing running', 20);
    await set(null, true);
    await measure('at rest in front: Home, nothing running', 20);
    await set('working', true);
    await measure('agents working, in front, on Home', has('--brief') ? 20 : long, every);
    if (!has('--brief')) {
      await set('needs', true);
      await measure('a question waiting, in front, on Home', long, every);
      // The same two with the page drawing every frame itself, as before; and with keyframes further apart.
      await how(false), await set('working', true);
      await measure('agents working, drawn by the page in every frame', long, every);
      await set('needs', true);
      await measure('a question waiting, drawn by the page in every frame', long, every);
      for (const step of steps) {
        await how(true, step), await set('working', true);
        await measure(`agents working, keyframes ${step} px apart`, 60);
      }
      await how(true, 0.4);
      await set('working', false);
      await measure('agents working, the window behind others', 15);
      await level('still'), await set('working', true);
      await measure('agents working, in front, effects Still', 15);
      await level('off');
      await measure('agents working, in front, effects Off', 15);
      await level('breathing');
      await ws(`(__ws.command('open-workspace'), 1)`);
      await sleep(500);
      app.send('click workspace .sheet .sh-f .key');
      await sleep(3000);
      await measure("agents working, in front, beside a terminal: the sidebar's glyphs", long, every);
    }
  } finally {
    await app.quit();
  }
  if (!has('--brief'))
    for (const [name, value] of [['Full', 'breathing'], ['Still', 'still'], ['Off', 'off']]) {
      const a = await launch({ ...exe, display, prefs: { motion_ambient: value } });
      try {
        await sleep(6000);
        const page = await a.ask('workspace', "({ contexts: __motion.stats.contexts, canvases: document.querySelectorAll('canvas').length, light: !!document.querySelector('.light') })");
        out.memory.push({ level: name, mb: a.memory(), ...page });
        if (has('--shots')) (fs.mkdirSync(arg('--shots'), { recursive: true }), await a.snapshot('workspace', `${arg('--shots')}/effects-${name.toLowerCase()}.png`));
      } finally {
        await a.quit();
      }
    }
  if (has('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(out));
  const part = (c, ...names) => names.reduce((a, n) => a + (c.by[n]?.cpu ?? 0), 0).toFixed(1);
  console.log('\n' + table(['', 'seconds', '% of a core', 'host', 'pages', 'graphics', 'core, network', 'on fast cores', 'M instructions/s', 'wakeups/s', 'mW', 'frames/s', 'keyframes/s', 'keyframes late', 'WindowServer %'],
    out.cost.map((c) => [c.name, c.seconds, c.cpu.toFixed(1), part(c, 'host'), part(c, 'WebContent'), part(c, 'GPU'), part(c, 'core', 'Networking'), `${c.fast} %`, c.instructions, c.wakeups, c.mw, c.drawn, c.keys, c.late, c.compositor.toFixed(1)])));
  for (const c of out.cost.filter((c) => c.series.length > 1)) console.log(`${c.name}, every 30 s: ${c.series.join(', ')} % of a core`);
  if (out.memory.length) console.log('\n' + table(['effects', 'memory, MB', 'WebGL contexts', 'canvases'], out.memory.map((m) => [m.level, m.mb.toFixed(1), m.contexts, m.canvases])));
  const failures = out.cost.filter((c) => /^at rest/.test(c.name) && c.cpu >= 0.3).map((c) => `${c.name}: ${c.cpu} % of a core`);
  const off = out.memory.find((m) => m.level === 'Off');
  for (const s of out.skipped) console.log(`not measured (the window was covered): ${s}`);
  if (off && (off.contexts || off.canvases)) failures.push(`with the effects off the page made ${off.contexts} WebGL contexts and ${off.canvases} canvases`);
  // A keyframe that comes too late leaves the band standing until the page takes it back: a stall on screen.
  for (const c of out.cost) if (c.late > c.seconds / 30) failures.push(`${c.name}: ${c.late} keyframes came too late to be faded into (the page's timers are held up): the band stood each time`);
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? 'FAIL  the effects cost something at rest, or the carried loop stalls' : 'PASS  at rest the app costs nothing, in front or behind' + (off ? ', and with the effects off no canvas and no WebGL context is made' : ''));
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
