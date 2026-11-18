// What the effects cost, in the built app: processor use and idle wakeups of the app's own processes (the host, its
// core, its web views), with the window compositor beside them, and the app's memory at each level of the effects.
// At rest it must cost nothing, in front or behind; while agents work it is a loop, measured over a minute on Home
// and beside a terminal (where only the sidebar's glyphs move). Passive, on a temporary data folder, in four short
// launches (one a level for memory, since a level's memory is what the app takes when it starts at it).
// usage: node scripts/cost-check.cjs [--exe file] [--display hz] [--json file] [--shots folder] [--brief]
//   --brief: rest and one working measure only. --shots: a picture of Home at each level, taken by the app itself.
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
  const measure = async (name, seconds) => {
    await sleep(4000);
    for (let tries = 0; tries < 3; tries++) {
      try {
        app.seen();
        const frames = await ws('__motion.stats.frames'), c = await app.cost(seconds), drawn = Math.round(((await ws('__motion.stats.frames')) - frames) / seconds);
        app.seen();
        out.cost.push({ name, seconds, ...c, drawn });
        return console.log(`  ${name}: ${c.cpu} % of a core, ${c.wakeups} wakeups a second`);
      } catch (e) {
        if (!/covered|not on screen/.test(e.message)) throw e;
        await sleep(6000);
      }
    }
    out.skipped.push(name);
    console.log(`  ${name}: not measured, the window was covered`);
  };
  try {
    await sleep(8000);
    out.display = app.seen();
    console.log(out.display.said + ' The built app, passive, on a temporary data folder.');
    await measure('at rest behind other windows: Home, nothing running', 20);
    await set(null, true);
    await measure('at rest in front: Home, nothing running', 20);
    await set('working', true);
    await measure('agents working, in front, on Home: the loop', has('--brief') ? 20 : 60);
    if (!has('--brief')) {
      await set('needs', true);
      await measure('a question waiting, in front, on Home', 30);
      await set('working', false);
      await measure('agents working, the window behind others', 15);
      await level('still'), await set('working', true);
      await measure('agents working, in front, effects Still', 15);
      await level('off');
      await measure('agents working, in front, effects Off', 15);
      await level('breathing');
      await ws(`(__ws.command('open-workspace'), 1)`);
      await sleep(500);
      app.send('click workspace .sheet .act.primary');
      await sleep(3000);
      await measure("agents working, in front, beside a terminal: the sidebar's glyphs", 60);
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
  console.log('\n' + table(['', 'seconds', '% of a core', 'wakeups/s', 'band drawn/s', 'WindowServer %'], out.cost.map((c) => [c.name, c.seconds, c.cpu.toFixed(1), c.wakeups, c.drawn, c.compositor.toFixed(1)])));
  if (out.memory.length) console.log('\n' + table(['effects', 'memory, MB', 'WebGL contexts', 'canvases'], out.memory.map((m) => [m.level, m.mb.toFixed(1), m.contexts, m.canvases])));
  const failures = out.cost.filter((c) => /^at rest/.test(c.name) && c.cpu >= 0.3).map((c) => `${c.name}: ${c.cpu} % of a core`);
  const off = out.memory.find((m) => m.level === 'Off');
  for (const s of out.skipped) console.log(`not measured (the window was covered): ${s}`);
  if (off && (off.contexts || off.canvases)) failures.push(`with the effects off the page made ${off.contexts} WebGL contexts and ${off.canvases} canvases`);
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? 'FAIL  the effects cost something at rest' : 'PASS  at rest the app costs nothing, in front or behind' + (off ? ', and with the effects off no canvas and no WebGL context is made' : ''));
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
