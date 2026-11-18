// Every measure of the motion that needs the real app, in one run, for when a display is free: on each display the
// Mac has (by refresh rate), the band's cadence and the capture flow; then, on the main display, what the effects
// cost and each level's memory and picture, and the sub-pixel check inside the app's own web view. Each part is a
// script of its own (cadence-check, flow-check, cost-check, subpixel-check) run with --app; its output is shown and
// kept, with its recording, in the folder given. A part that finds its window covered says so and the run goes on.
// usage: node scripts/measure-all.cjs <folder> [--front] [--exe file] [--only cadence,flow,cost,subpixel] [--minutes 5]
//   --front: each part puts the app's window in front of the other apps' for as long as it runs (nothing is typed,
//   clicked or moved, and the keyboard stays where it is); without it the window opens behind the app in use, and a
//   part whose window is covered measures nothing.
//   --exe: another build of the app (one kept from before a change, to compare).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { screens } = require('./app-driver.cjs');
const out = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) (console.error('usage: node scripts/measure-all.cjs <folder> [--exe file] [--only cadence,flow,cost,subpixel]'), process.exit(2));
const arg = (name, or) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : or);
const exe = [...(arg('--exe', '') ? ['--exe', arg('--exe')] : []), ...(process.argv.includes('--front') ? ['--front'] : [])], only = arg('--only', 'cadence,flow,cost,subpixel').split(',');
fs.mkdirSync(out, { recursive: true });
const s = screens();
if (s.asleep || s.locked) (console.error('The display is asleep or the screen is locked: nothing drawn on it can be measured.'), process.exit(1));
const rates = [...new Set(s.displays.map((d) => Math.round(d.hz)))];
console.log(`The display is awake and unlocked. Displays: ${s.displays.map((d) => `${d.width} x ${d.height} at ${d.scale}x, ${Math.round(d.hz)} Hz${d.main ? ' (main)' : ''}`).join('; ')}.`);
let failed = 0;
const run = (name, script, args) => {
  console.log(`\n######## ${name}`);
  const r = spawnSync('node', [path.join(__dirname, script), ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  process.stdout.write(r.stdout + r.stderr);
  fs.writeFileSync(path.join(out, `${name.replace(/\W+/g, '-')}.txt`), r.stdout + r.stderr);
  failed += r.status ? 1 : 0;
};
for (const hz of rates) {
  if (only.includes('cadence')) run(`cadence ${hz} Hz`, 'cadence-check.cjs', ['--app', ...exe, '--display', hz, '--keep', 36, '--json', path.join(out, `cadence-${hz}.json`)]);
  if (only.includes('flow')) run(`flow ${hz} Hz`, 'flow-check.cjs', ['--app', ...exe, '--display', hz, '--json', path.join(out, `flow-${hz}.json`)]);
}
// Each loop for five minutes, as the compositor carries it and as the page would draw it, and with keyframes further apart.
if (only.includes('cost')) run('cost', 'cost-check.cjs', [...exe, '--minutes', arg('--minutes', '5'), '--steps', '0.8,1.2', '--json', path.join(out, 'cost.json'), '--shots', out]);
if (only.includes('subpixel')) run('subpixel', 'subpixel-check.cjs', ['--app', ...exe, '--json', path.join(out, 'subpixel.json')]);
console.log(`\n${failed ? `${failed} parts failed or could not be measured` : 'Every part passed'}; what each said, and its recording, is in ${out}`);
process.exit(failed ? 1 : 0);
