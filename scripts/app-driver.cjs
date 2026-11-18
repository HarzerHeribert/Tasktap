// Drives the built app for a measurement, as host/scripts/smoke.sh does from the shell: on a temporary data folder,
// passive (no window ever takes the keyboard, nothing is sent to the system), through its debug channel (one command
// a line on its standard input, one JSON event a line on its output), and quit at the end with its core.
// `fixture`: the core built with the fixture agent (host/binaries/fixtures), and a project that is a git repository.
// Library: launch, awake, table.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const host = path.join(root, 'host');
const RELEASE = path.join(host, 'target/release/bundle/macos/Tasktap Next.app/Contents/MacOS/tasktap-next');
const DEBUG = path.join(host, 'target/debug/tasktap-next');

/** The displays (displays.swift): whether the main one is asleep, whether the screen is locked, and each one's frame
 *  in the desktop, scale and refresh rate. */
function screens(pid) {
  try {
    return JSON.parse(execFileSync('swift', [path.join(__dirname, 'displays.swift'), ...(pid ? [String(pid)] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return { asleep: true, locked: true, displays: [] };
  }
}
/** Whether a window can be seen: the display awake and the screen unlocked. A sleeping or locked screen draws no
 *  frames of it, so nothing measured there means anything. */
const awake = () => (({ asleep, locked }) => !asleep && !locked)(screens());

/** `front` (or --front on the command line): the app's window is put in front of the other apps' (the debug
 *  channel's `front`; the keyboard stays where it is), since a passive window opens behind the app in use and a
 *  covered window draws nothing; it is over the person's work until the run quits.
 *  `display`: the refresh rate of the display the window opens on, the main one otherwise. The window is put where
 *  the fewest other windows are, since it opens behind those of the app in use and a covered window draws nothing
 *  (the app's remembered frame, written into its temporary data folder: nothing of the person's is moved). */
async function launch({ exe = RELEASE, fixture = false, env = {}, display = 0, prefs = {}, front = process.argv.includes('--front') } = {}) {
  if (!fs.existsSync(exe)) throw new Error(`Build the app first (host/scripts/build.sh): ${exe}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasktap-measure-'));
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project);
  const webkit = () => { try { return execFileSync('pgrep', ['-f', 'com.apple.WebKit'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; } };
  const before = webkit();
  const all = screens(), on = all.displays.find((d) => (display ? Math.round(d.hz) === Number(display) : d.main));
  if (display && !on) throw new Error(`No display refreshes at ${display} Hz`);
  if (on) {
    fs.mkdirSync(path.join(tmp, 'data'));
    const w = Math.min(1180, on.width - 40), h = Math.min(760, on.height - 80), under = (x, y) => {
      let n = 0;
      for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
        const px = x + ((i + 0.5) * w) / 12, py = y + ((j + 0.5) * h) / 12;
        if (all.others.some((o) => px >= o.x && px < o.x + o.width && py >= o.y && py < o.y + o.height)) n++;
      }
      return n;
    };
    // The middle of the display where it is free; else the place with the least over it.
    let best = [on.x + Math.round((on.width - w) / 2), on.y + Math.round((on.height - h) / 2)], least = under(...best);
    for (let y = on.y + 30; least && y + h <= on.y + on.height; y += 40) for (let x = on.x; x + w <= on.x + on.width; x += 40) if (under(x, y) < least) (least = under(x, y)), (best = [x, y]);
    fs.writeFileSync(path.join(tmp, 'data', 'host.json'), JSON.stringify({ frame: [...best, w, h] }));
  }
  const vars = { ...process.env, TASKTAP_DEBUG: '1', TASKTAP_PASSIVE: '1', TASKTAP_DATA: path.join(tmp, 'data'), TASKTAP_PICK: project, ...env };
  if (fixture) {
    const core = path.join(host, 'binaries/fixtures/tasktap');
    if (!fs.existsSync(core)) throw new Error('Build the fixture core first: FIXTURES=1 host/scripts/build-core.sh');
    fs.mkdirSync(path.join(tmp, 'agents'));
    for (const name of ['fixture-agent', 'fixture']) fs.linkSync(core, path.join(tmp, 'agents', name));
    fs.writeFileSync(path.join(tmp, 'gitconfig'), '[user]\n\tname = Measure\n\temail = measure@example.com\n[init]\n\tdefaultBranch = main\n');
    Object.assign(vars, { PATH: `${path.join(tmp, 'agents')}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
      TASKTAP_CORE_EXE: core, TASKTAP_CORE_BUILD: fs.readFileSync(path.join(host, 'binaries/fixtures/build.txt'), 'utf8') });
    fs.writeFileSync(path.join(project, 'README'), 'measure\n');
    const git = (...a) => execFileSync('git', ['-C', project, ...a], { env: vars, stdio: 'ignore' });
    git('init', '-q'), git('add', 'README'), git('commit', '-qm', 'Start');
  }
  // Preferences the app is to start with: a first launch with no window writes them into the core's data, and quits.
  if (Object.keys(prefs).length) {
    const first = spawn(exe, [], { env: vars, stdio: ['pipe', 'pipe', 'ignore'] });
    await new Promise((ok) => first.stdout.on('data', (d) => /"event":"ready"/.test(d) && ok()));
    for (const [id, value] of Object.entries(prefs)) first.stdin.write(`call put ${JSON.stringify({ c: 'prefs', id, patch: value })}\n`);
    await sleep(600);
    first.stdin.write('quit\n');
    await sleep(800);
    first.kill();
    try { execFileSync('pkill', ['-f', `${tmp}/`]); } catch {}
    await sleep(500);
  }
  const child = spawn(exe, [], { env: vars, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [], waiting = [];
  let buffer = '';
  child.stdout.on('data', (d) => {
    buffer += d;
    for (let i; (i = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(i + 1)) {
      let e;
      try { e = JSON.parse(buffer.slice(0, i)); } catch { continue; }
      events.push(e);
      for (const w of [...waiting]) if (w.match(e)) (waiting.splice(waiting.indexOf(w), 1), w.ok(e));
    }
  });
  child.stderr.on('data', () => {});
  const event = (match, ms = 15000) => new Promise((ok, no) => {
    const had = events.find(match);
    if (had) return ok(had);
    const w = { match, ok: (e) => (clearTimeout(timer), ok(e)) };
    const timer = setTimeout(() => (waiting.splice(waiting.indexOf(w), 1), no(new Error('the app did not answer'))), ms);
    waiting.push(w);
  });
  const send = (line) => child.stdin.write(line + '\n');
  let n = 0;
  /** The value of a page expression, awaited; or of a function of the page's, called with `arg`. Several may wait at once. */
  const ask = async (label, expr, arg, ms = 120000) => {
    const id = ++n, src = typeof expr === 'function' ? `(${String(expr)})(${JSON.stringify(arg ?? null)})` : expr;
    send(`eval ${label} (async()=>{try{return{__n:${id},v:await (${src.replace(/\s*\n\s*/g, ' ')})}}catch(e){return{__n:${id},err:String(e)}}})()`);
    const e = await event((x) => x.event === 'report' && x.label === label && x.data?.__n === id, ms);
    if (e.data.err) throw new Error(e.data.err);
    return e.data.v;
  };
  const until = async (label, expr, want, seconds = 10) => {
    for (const end = Date.now() + seconds * 1000; Date.now() < end; await sleep(200)) if (String(await ask(label, expr)).includes(want)) return true;
    return false;
  };
  const snapshot = async (label, file) => {
    send(`snapshot ${label} ${file}`);
    await event((x) => x.event === 'snapshot' && x.file === file, 10000);
  };
  const quit = async () => {
    send('quit');
    await sleep(800);
    child.kill();
    try { execFileSync('pkill', ['-f', `${tmp}/`]); } catch {}
    await sleep(300);
    try { execFileSync('pkill', ['-9', '-f', `${tmp}/`]); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  /** Where the workspace window is and whether it can be seen: the display it is on, its refresh rate, and the share
   *  of the window that lies under other windows. Throws when the screen sleeps or is locked, or the window is all but
   *  covered (a web view draws while any of its window shows, and stops when none does). */
  const seen = () => {
    const s = screens(child.pid), w = (s.windows ?? []).sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (s.asleep || s.locked) throw new Error('The display is asleep or the screen is locked: nothing drawn on it can be measured.');
    if (!w) throw new Error("The app's window is not on screen: nothing can be measured.");
    const on = s.displays.find((d) => w.x + w.width / 2 >= d.x && w.x + w.width / 2 < d.x + d.width && w.y + w.height / 2 >= d.y && w.y + w.height / 2 < d.y + d.height) ?? {};
    if (w.covered > 0.9) throw new Error(`The app's window is ${Math.round(w.covered * 100)} % covered by other windows: nothing can be measured.`);
    return { hz: Math.round(on.hz ?? 0), scale: on.scale, display: `${on.width} x ${on.height} at ${on.scale}x, ${Math.round(on.hz ?? 0)} Hz`, covered: w.covered,
      said: `The display is awake and unlocked; the window (${Math.round(w.width)} x ${Math.round(w.height)}) is on the ${Math.round(on.hz ?? 0)} Hz display (${on.width} x ${on.height} at ${on.scale}x), ${Math.round(w.covered * 100)} % of it under other windows.` };
  };
  /** The app's own processes: the host, its core and its web views' (the WebKit processes that began with it). */
  const pids = () => {
    let core = [];
    try { core = execFileSync('pgrep', ['-f', `${tmp}/data/bin/`], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch {}
    return [String(child.pid), ...core.slice(0, 1), ...webkit().filter((p) => !before.includes(p))];
  };
  /** What each of the app's processes is: the host, its core, and its web views' processes by WebKit's names (the
   *  pages are WebContent; GPU; Networking). */
  const named = () => {
    const out = {}, [hostPid, ...rest] = pids();
    out[hostPid] = 'host';
    for (const p of rest) {
      let name = '';
      try { name = execFileSync('ps', ['-o', 'comm=', '-p', p], { encoding: 'utf8' }).trim().split('/').pop().replace('com.apple.WebKit.', ''); } catch {}
      out[p] = /tasktap$/.test(name) ? 'core' : name || 'gone';
    }
    return out;
  };
  /** What processes have used so far, as the system counts it (usage.swift). */
  const used = (ids) => {
    try { return JSON.parse(execFileSync('swift', [path.join(__dirname, 'usage.swift'), ...ids], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return {}; }
  };
  /** What the app's processes cost over `seconds`, together and each: processor time (percent of one core), the
   *  share of it on the performance cores, instructions (millions a second: the work done, whichever cores did it
   *  and however fast they ran), wakeups from idle a second, and power in mW; with `every`, the processor time of each
   *  such stretch in turn, which shows a cost that grows; and the window compositor's processor time beside them (it
   *  draws the rest of the screen too). The counts are the system's own for each process, read at both ends. */
  const cost = async (seconds, every = 0) => {
    const names = named(), own = Object.keys(names), read = () => ({ at: process.hrtime.bigint(), of: used(own) });
    let server = '';
    try { server = execFileSync('pgrep', ['-x', 'WindowServer'], { encoding: 'utf8' }).split('\n')[0]; } catch {}
    const beside = new Promise((ok) => {
      if (!server) return ok(0);
      let text = '';
      const top = spawn('top', ['-c', 'd', '-l', '2', '-s', String(seconds), '-stats', 'pid,cpu', '-pid', server]);
      top.stdout.on('data', (d) => (text += d));
      top.on('close', () => ok(parseFloat((text.split('\n').filter((l) => /^\d+\s/.test(l)).pop() ?? '').trim().split(/\s+/)[1]) || 0));
    });
    const samples = [read()];
    for (let left = seconds; left > 0; left -= every || seconds) (await sleep(Math.min(every || seconds, left) * 1000), samples.push(read()));
    const r1 = (x) => Math.round(x * 10) / 10;
    const between = (a, b, ids) => {
      const s = Number(b.at - a.at) / 1e9, d = (k) => ids.reduce((sum, p) => sum + Math.max(0, (b.of[p]?.[k] ?? 0) - (a.of[p]?.[k] ?? 0)), 0);
      return { cpu: r1(d('cpu') / 1e7 / s), fast: Math.round((100 * d('fast')) / Math.max(1, d('cpu'))), instructions: Math.round(d('instructions') / 1e6 / s), wakeups: Math.round(d('wakeups') / s), mw: Math.round(d('energy') / 1e6 / s) };
    };
    const first = samples[0], last = samples[samples.length - 1], by = {};
    for (const name of new Set(Object.values(names))) by[name] = between(first, last, own.filter((p) => names[p] === name));
    return { ...between(first, last, own), by, series: samples.slice(1).map((x, i) => between(samples[i], x, own).cpu), compositor: r1(await beside) };
  };
  /** The app's memory: the physical footprint of its processes together, in MB. */
  const memory = () => Math.round(pids().reduce((a, p) => {
    try {
      const m = /phys_footprint: ([0-9.]+) (KB|MB|GB)/.exec(execFileSync('footprint', [p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
      return a + (m ? Number(m[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[m[2]] : 0);
    } catch { return a; }
  }, 0) * 10) / 10;
  /** With the fixture agent: it is the agent thoughts run with, after a hold of two seconds; the project's folder is
   *  open as a workspace and holds the steps the thought THOUGHT runs; Home is shown. */
  const prepare = async () => {
    fs.writeFileSync(path.join(project, 'flow.steps'), STEPS.join('\n') + '\n');
    send('call put {"c":"prefs","id":"agent","patch":"fixture"}'), send('call put {"c":"prefs","id":"hold","patch":2}'), send('call agents.detect {}');
    await sleep(1200);
    await ask('workspace', `(__ws.command('open-workspace'), 1)`);
    await sleep(500);
    send('click workspace .sheet .act.primary');
    if (!(await until('workspace', `String([...__ws.records.projects.values()].some(p => p.kind === 'folder') && __ws.records.agents.has('fixture'))`, 'true', 10))) throw new Error('the folder did not open');
    await ask('workspace', `(__ws.show('home'), 1)`);
  };
  /** Home at rest again: the Composer empty and every result read. */
  const rest = async () => {
    await ask('workspace', `(document.querySelector('.home #capture-input').focus(), document.execCommand('selectAll'), document.execCommand('delete'), Promise.all([...__ws.records.thoughts.values()].filter(t => !t.read).map(t => __ws.call('thought.read', { id: t.id }))).then(() => 1))`);
    await until('workspace', "document.querySelector('.light')?.dataset.state ?? 'idle'", 'idle', 8);
  };
  try {
    const shown = await event((x) => x.event === 'window');
    await event((x) => x.event === 'ready');
    if (front) (send('front'), await sleep(300));
    return { tmp, project, pid: child.pid, window: shown.ms, send, ask, until, snapshot, quit, seen, prepare, rest, cost, memory, events };
  } catch (e) {
    await quit();
    throw e;
  }
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** The thought a measured flow sends: for the fixture agent, the name of a file of steps in its folder
 *  (core/src/roles/fixture.rs): it starts, works a second and a half, prints 24 lines, works on, and finishes with a
 *  result. */
const THOUGHT = 'script:flow.steps';
const STEPS = ['event:ready', 'event:turn_started', 'sleep:1500', ...Array.from({ length: 24 }, (_, i) => `print:line ${i} of the agent's output, long enough to fill most of a row of its terminal`), 'sleep:1500', 'event:turn_finished:All green.'];
/** Rows as a table of aligned columns. */
function table(head, rows) {
  const all = [head, ...rows].map((r) => r.map(String)), w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  return all.map((r) => r.map((c, i) => (i ? c.padStart(w[i]) : c.padEnd(w[i]))).join('  ')).join('\n');
}

module.exports = { launch, awake, screens, sleep, table, THOUGHT, RELEASE, DEBUG, root };
