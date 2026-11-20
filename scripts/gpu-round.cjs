#!/usr/bin/env node
// What Tasktap costs the graphics processor on this Mac (host/README.md, "What the graphics processor costs"), as
// scripts/winvm/gpu.ps1 measures it on Windows: the built app run as a person runs it (not passive: a passive app's
// light rests whatever it shows), on a temporary data folder with the core that has the fixture agent, its window in
// front and uncovered, a minute in each state, everything read each second; a floor first (a minute with no app) and
// again at the end. Started by host/scripts/gpu.sh, which says how; the states are `catalogue` below.
//
// What it reads, each second, without a password (scripts/gpu-sample.swift): the graphics processor's utilisation from
// its own statistics, the graphics and processor time of each of the app's processes, WindowServer's and the busiest
// other process's graphics time, the frames the page's light drew (`__motion.stats.frames`), the display's refresh
// rate, and whether the window and the notch are on screen and uncovered. With the owner's help (`--print-powermetrics`
// prints the command he starts in a second window, with his password), also the graphics processor's power and each
// process's graphics time as powermetrics reports them, read from its log by time stamp at the end.
//
// It never sends a key or a click to the system or another app and never moves the pointer: everything is a line on
// the app's debug channel, read by the app itself. The microphone is taken from both pages before anything else, and
// the round stops when that cannot be confirmed. Nothing of the person's is read or written: the app's data, home,
// agents' histories and git configuration are folders of the round's own, removed at the end.
// GPU_ROUND_PASSIVE=1 is for working on the round itself: the app passive and behind the person's windows, told it is
// in front; it checks the round's steps and measures nothing that means anything.
'use strict';
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const host = path.join(root, 'host');
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const PASSIVE = !!process.env.GPU_ROUND_PASSIVE;

// At rest with the caret in Home's field the app may redraw the caret as it blinks, and nothing else: two redraws a
// second of a rectangle a few points across, each tens of microseconds of the graphics processor's time. A light that
// draws, even a small one, draws 120 times a second at well over that. 0.5 ms a second lies an order of magnitude
// from both.
const CARET_MS = 0.5;
// A floor the round refuses (`--force` overrides). The 1-minute load average counts the threads ready to run: a quiet
// Mac sits under 2 once the indexing after a restart has settled; above 4 several programs are computing, and the
// processor's and the graphics processor's power move under the round. Another process's graphics time over 5 ms a
// second (half a per cent of the graphics processor's time), the graphics processor more than 5 % busy, or
// WindowServer drawing more than 20 ms a second with no app (something on the screen moves) would each be of the size
// of what the round measures in the app's quieter states.
const LIMITS = { load: 4, other: 5, device: 5, server: 20 };

const usage = `usage: host/scripts/gpu.sh [--seconds 60] [--effects full,still,off] [--size window|full] [--states rest,...]
                          [--rest] [--app PATH] [--core PATH] [--out DIR] [--force]
                          [--rehearse | --dry-run | --print-powermetrics | --self-test]`;
const fail = (why) => { console.error(why); process.exit(2); };

// ——— The states, in the round's order. `window`: the app's window in front and seen (else it is closed and the notch
// is what shows); `settle`: seconds before the measure (focus entering the window sends a pulse of 7.2 s); `rule`:
// item 35's verdict for it; `enter`, `tick` (each second, measured or not), `leave`; `read`: a number read at both
// ends of the measure, said a second.
const catalogue = {
  rest: { what: "at rest on Home, nothing running, the caret in Home's field", window: true, settle: 10, rule: 'caret',
    enter: async () => { await up(); await view('home'); await js("(document.querySelector('.home #capture-input')?.focus(), 1)"); } },
  'rest-unfocused': { what: 'at rest on Home, nothing running, the caret taken out of its field', window: true, settle: 10, rule: 'zero',
    enter: async () => { await up(); await view('home'); await js('(document.activeElement?.blur(), 1)'); } },
  'notch-rest': { what: 'the notch at rest, the window closed', settle: 6, rule: 'zero', enter: async () => down() },
  'notch-open': { what: 'the notch open with the caret in its field, as the capture key opens it, the window closed', settle: 3,
    enter: async () => { await down(); send('capture'); await sleep(1000); if (!(await notchOpen())) noted.push('the notch DID NOT OPEN'); },
    leave: async () => { send('key notch Escape'); await sleep(800); } },
  sidebar: { what: 'Home, the sidebar opening and closing: one slide a second', window: true, settle: 3,
    enter: async () => { await up(); await view('home'); slides = 0; },
    tick: () => { send("eval workspace (__ws.command('sidebar'), 1)"); slides++; },
    leave: async () => { if (slides % 2) { await sleep(400); await js("(__ws.command('sidebar'), 1)"); } } },
  terminal: { what: 'a terminal printing fast: zsh counting lines as fast as it can', window: true, settle: 3,
    enter: async () => { await up(); await printing(); },
    read: async () => Number(await js("Math.max(0, ...(__ws.text().match(/^\\d+(?= a line)/gm) ?? ['0']).map(Number))", 3000)) || null,
    leave: async () => {
      await js(`(__ws.engines.get('${shell}')?.term.input('\\x03', true), 1)`);
      await sleep(1000);
      await js(`(__ws.call('terminal.stop', { id: '${shell}' }), 1)`);
      await view('home');
    } },
  listening: { what: "listening on Home, to the level the checks' tone makes (no microphone)", window: true, settle: 4,
    enter: async () => { await up(); await view('home'); await tone(true); }, leave: async () => tone(false) },
  thinking: { what: 'a thought on its way: placed and held before it starts', window: true, settle: 4,
    enter: async () => { await up(); await held(); await view('home'); } },
  working: { what: 'agents working: the fixture agent in its turn', window: true, settle: 4,
    enter: async () => { await up(); await working(); await view('home'); } },
  question: { what: 'a question waiting, on Home', window: true, settle: 4,
    enter: async () => { await up(); await asking(); await view('home'); } },
  'notch-question': { what: 'the notch glowing for a question, folded, the window closed', settle: 4,
    enter: async () => { await asking(); await down(); await folded(); } },
};

// ——— Options and the plan.
function options(argv) {
  const o = { seconds: 60, effects: ['full'], size: 'window', states: null, app: path.join(host, 'target/release/bundle/macos/Tasktap.app'),
    core: '', out: path.join(os.homedir(), 'Library/Logs/tasktap-gpu-rounds'), force: false, mode: 'round' };
  for (let i = 0; i < argv.length; i++) {
    const next = () => (i + 1 < argv.length ? argv[++i] : fail(usage));
    switch (argv[i]) {
      case '--seconds': o.seconds = Number(next()); if (!(o.seconds >= 1)) fail(usage); break;
      case '--effects': o.effects = next().split(','); if (!o.effects.every((e) => ['full', 'still', 'off'].includes(e))) fail(usage); break;
      case '--size': o.size = next(); if (!['window', 'full'].includes(o.size)) fail(usage); break;
      case '--states': o.states = next().split(','); break;
      case '--rest': o.states = ['rest', 'rest-unfocused', 'notch-rest']; break;
      case '--app': o.app = path.resolve(next()); break;
      case '--core': o.core = path.resolve(next()); break;
      case '--out': o.out = path.resolve(next()); break;
      case '--force': o.force = true; break;
      case '--rehearse': o.mode = 'rehearse'; break;
      case '--dry-run': o.mode = 'dry-run'; break;
      case '--print-powermetrics': o.mode = 'print'; break;
      case '--self-test': o.mode = 'self-test'; break;
      default: fail(usage);
    }
  }
  const unknown = (o.states ?? []).filter((s) => !catalogue[s]);
  if (unknown.length) fail(`No such state: ${unknown.join(', ')}. The states: ${Object.keys(catalogue).join(', ')}`);
  o.rehearse = o.mode === 'rehearse';
  if (o.rehearse) o.seconds = 5;
  o.floor = o.rehearse ? 5 : 60;
  o.after = o.rehearse ? 3 : 30;
  return o;
}
function makePlan(o) {
  const plan = [], skipped = [];
  for (const state of Object.keys(catalogue)) {
    if (o.states && !o.states.includes(state)) continue;
    if (o.size === 'full' && !catalogue[state].window) { skipped.push(state); continue; }
    for (const effects of o.effects) {
      const again = plan.length && plan[plan.length - 1].state === state;
      plan.push({ state, effects, settle: o.rehearse ? 1 : again ? Math.min(3, catalogue[state].settle) : catalogue[state].settle });
    }
  }
  return { plan, skipped };
}
// As the round goes: the floor, the app's start, each state's settling, measure and entering, the floor again.
const estimate = (o, plan) => o.floor + 25 + plan.reduce((s, p) => s + p.settle + o.seconds + 1, 0) + 4 * new Set(plan.map((p) => p.state)).size + o.after + 5;

// ——— The powermetrics log: the owner's command, and its text read back by time stamp.
const quote = (s) => (/^[\w./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
function powermetricsCommand(o, seconds, log) {
  return `sudo powermetrics --samplers gpu_power,tasks --show-process-gpu -i 1000 -b 1 -n ${Math.ceil(seconds)} -o ${quote(log)}`;
}
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
/** powermetrics' text: each sample's end (s since 1970, from its header's date, to the second), its length, the
 *  graphics processor's power (mW), active residency (%) and frequency (MHz), and each task's graphics time (ms/s) by
 *  process id. The header is `*** Sampled system activity (<date>) (<n>ms elapsed) ***`; in the tasks' table the name
 *  is padded to 32 columns and may hold spaces and numbers, so a row is read from its right: as many numbers as the
 *  ALL_TASKS row has, before them the process id, before that the name; the graphics time is the last column when the
 *  header ends in `GPU ms/s`. */
function parsePowermetrics(text) {
  const samples = [];
  let s = null, inTasks = false, columns = 0, gpuLast = false, rows = [];
  const finish = () => {
    if (!s) return;
    if (!columns) rows = [];
    for (const tokens of rows) {
      if (tokens.length < columns + 2) continue;
      const pid = Number(tokens[tokens.length - columns - 1]);
      const name = tokens.slice(0, tokens.length - columns - 1).join(' ');
      if (!Number.isInteger(pid)) continue;
      const gpu = gpuLast ? parseFloat(tokens[tokens.length - 1].replace(/[[\]]/g, '')) : NaN;
      s.tasks.push({ pid, name, gpu });
    }
    samples.push(s);
  };
  for (const line of text.split('\n')) {
    const head = /^\*\*\* \w+ system activity \((.+?)\) \(([\d.]+)ms elapsed\) \*\*\*/.exec(line);
    if (head) {
      finish();
      const d = /^\w{3} (\w{3})\s+(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2}) (\d{4})(?: ([+-])(\d{2})(\d{2}))?/.exec(head[1]);
      let end = NaN;
      if (d && d[1] in MONTHS) {
        const utc = Date.UTC(+d[6], MONTHS[d[1]], +d[2], +d[3], +d[4], +d[5]) / 1000;
        end = d[7] ? utc - (d[7] === '-' ? -1 : 1) * (+d[8] * 3600 + +d[9] * 60) : new Date(+d[6], MONTHS[d[1]], +d[2], +d[3], +d[4], +d[5]).getTime() / 1000;
      }
      s = { end, elapsed: Number(head[2]) / 1000, power: NaN, active: NaN, mhz: NaN, tasks: [] };
      inTasks = false; rows = []; columns = 0; gpuLast = false;
      continue;
    }
    if (!s) continue;
    if (/^\*\*\* Running tasks \*\*\*/.test(line)) { inTasks = true; continue; }
    if (inTasks) {
      if (/^Name\s+ID\s/.test(line)) { gpuLast = /GPU ms\/s\s*$/.test(line); continue; }
      if (!line.trim()) { if (rows.length) inTasks = false; continue; }
      const tokens = line.trim().split(/\s+/);
      if (tokens[0] === 'ALL_TASKS') columns = tokens.length - 2;
      rows.push(tokens);
      continue;
    }
    let m;
    if ((m = /^GPU Power:\s*([\d.]+)\s*mW/.exec(line))) s.power = Number(m[1]);
    else if ((m = /^GPU HW active residency:\s*([\d.]+)%/.exec(line))) s.active = Number(m[1]);
    else if ((m = /^GPU HW active frequency:\s*([\d.]+)\s*MHz/.exec(line))) s.mhz = Number(m[1]);
  }
  finish();
  return samples;
}
/** Each row's seconds in powermetrics' samples: those whose middle lies within the row's measure, half a second in
 *  from either end (the header's time is given to the second); there the graphics power and the graphics time of the
 *  row's processes (by process id) and of WindowServer. Returns the samples with a time. */
function joinPowermetrics(rows, samples) {
  const usable = samples.filter((x) => Number.isFinite(x.end));
  for (const row of rows) {
    if (!row.t0) continue;
    const inside = usable.filter((x) => x.end - x.elapsed / 2 >= row.t0 + 0.5 && x.end - x.elapsed / 2 <= row.t1 - 0.5);
    row.pmN = inside.length;
    if (!inside.length) continue;
    row.power = mean(inside.map((x) => x.power));
    row.powerSd = sd(inside.map((x) => x.power));
    row.pmActive = mean(inside.map((x) => x.active));
    const appEach = inside.map((x) => x.tasks.filter((t) => row.pids.has(t.pid)).reduce((s, t) => s + (Number.isFinite(t.gpu) ? t.gpu : 0), 0));
    row.pmApp = mean(appEach); row.pmAppMax = max(appEach); row.pmAppNonzero = appEach.filter((x) => x > 0).length;
    row.pmWs = mean(inside.map((x) => x.tasks.filter((t) => t.name === 'WindowServer').reduce((s, t) => s + (t.gpu || 0), 0)));
  }
  return usable;
}
function selfTest() {
  const file = path.join(host, 'scripts/powermetrics-fixture.txt');
  const got = parsePowermetrics(fs.readFileSync(file, 'utf8'));
  const checks = [
    ['three samples', got.length === 3],
    ["the first sample's end, from its date and zone", got[0]?.end === Date.UTC(2026, 10, 19, 22, 40, 1) / 1000],
    ['its length', Math.abs(got[0]?.elapsed - 1.00352) < 1e-9],
    ['the graphics power', got[0]?.power === 14 && got[1]?.power === 31 && got[2]?.power === 0],
    ['the active residency and frequency', got[0]?.active === 1.53 && got[0]?.mhz === 338 && got[1]?.active === 2.1],
    ['a task by process id', got[0]?.tasks.find((t) => t.pid === 4242)?.gpu === 2.4 && got[0].tasks.find((t) => t.pid === 4242).name === 'com.apple.WebKit.GPU'],
    ['a name with spaces and brackets', got[0]?.tasks.find((t) => t.pid === 5120)?.name === 'Code Helper (GPU)' && got[0].tasks.find((t) => t.pid === 5120).gpu === 0.75],
    ['a name that ends in a number', got[0]?.tasks.find((t) => t.pid === 5300)?.name === 'node 18'],
    ['WindowServer', got[1]?.tasks.find((t) => t.name === 'WindowServer')?.gpu === 7.3],
    ['ALL_TASKS and DEAD_TASKS', got[0]?.tasks.find((t) => t.pid === -2)?.gpu === 9.25 && got[0].tasks.find((t) => t.pid === -1)?.gpu === 0],
    ['a date with a one-digit day and a zone west of Greenwich', got[2]?.end === Date.UTC(2026, 10, 5, 17, 3, 4) / 1000],
  ];
  // A state measured from 23:39:59.5 to 23:40:03 there (+0100), its processes the app, its GPU and its page's; another
  // from 23:40:00.8 on, the app alone.
  const row = { t0: Date.UTC(2026, 10, 19, 22, 39, 59, 500) / 1000, t1: Date.UTC(2026, 10, 19, 22, 40, 3) / 1000, pids: new Set([4200, 4242, 4243]) };
  const later = { t0: Date.UTC(2026, 10, 19, 22, 40, 0, 800) / 1000, t1: Date.UTC(2026, 10, 19, 22, 40, 9) / 1000, pids: new Set([4200]) };
  joinPowermetrics([row, later], got);
  checks.push(["a state's seconds by time stamp", row.pmN === 2 && later.pmN === 1],
    ['its graphics power', row.power === 22.5 && later.power === 31],
    ["its processes' graphics time, by process id", Math.abs(row.pmApp - 3.1) < 1e-9 && Math.abs(row.pmAppMax - 3.8) < 1e-9 && row.pmAppNonzero === 2 && Math.abs(later.pmApp - 0.2) < 1e-9],
    ["WindowServer's", Math.abs(row.pmWs - 6.7) < 1e-9]);
  for (const [what, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  powermetrics' text: ${what}`);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

// ——— The sampler (scripts/gpu-sample.swift), compiled once into the round's folder.
class Sampler {
  constructor(bin) {
    this.child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.waiting = [];
    this.queue = [];
    this.head = null;
    let buffer = '';
    this.child.stdout.on('data', (d) => {
      buffer += d;
      for (let i; (i = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(i + 1)) {
        let line;
        try { line = JSON.parse(buffer.slice(0, i)); } catch { continue; }
        if (!this.head) { this.head = line; continue; }
        const w = this.waiting.shift();
        if (w) w(line); else this.queue.push(line);
      }
    });
    this.child.on('exit', () => { for (const w of this.waiting.splice(0)) w(null); });
  }
  /** The next second: the oldest one not taken yet, or the one to come. */
  next(ms = 4000) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((ok) => {
      const timer = setTimeout(() => { this.waiting.splice(this.waiting.indexOf(done), 1); ok(null); }, ms);
      const done = (line) => { clearTimeout(timer); ok(line); };
      this.waiting.push(done);
    });
  }
  /** The seconds that went by while the round was doing something else. */
  drain() { return this.queue.splice(0); }
  watch(pid, folder) { try { this.child.stdin.write(`app ${pid} ${folder}\n`); } catch {} }
  stop() { try { this.child.stdin.end('quit\n'); } catch {} setTimeout(() => this.child.kill(), 500).unref(); }
}
function samplerBinary(o) {
  const src = path.join(__dirname, 'gpu-sample.swift');
  const hash = crypto.createHash('sha1').update(fs.readFileSync(src)).digest('hex').slice(0, 12);
  const bin = path.join(o.out, '.sampler', `gpu-sample-${hash}`);
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    console.log('Compiling the sampler (scripts/gpu-sample.swift), once…');
    execFileSync('swiftc', ['-O', src, '-o', `${bin}.tmp`], { stdio: ['ignore', 'ignore', 'inherit'] });
    fs.renameSync(`${bin}.tmp`, bin);
  }
  return bin;
}

// ——— The app and its debug channel.
let child = null, events = [], waiting = [], appLog = [], n = 0, windowOpen = false;
const send = (line) => { if (child && child.exitCode === null) try { child.stdin.write(line + '\n'); } catch {} };
const event = (match, ms = 10000) => new Promise((ok) => {
  const had = events.find(match);
  if (had) return ok(had);
  const w = { match, ok: (e) => { clearTimeout(timer); ok(e); } };
  const timer = setTimeout(() => { waiting.splice(waiting.indexOf(w), 1); ok(null); }, ms);
  waiting.push(w);
});
/** The value of a page expression, awaited; undefined when the page does not answer in time. */
async function ask(label, expr, ms = 5000) {
  const id = ++n;
  send(`eval ${label} (async()=>{try{return{__n:${id},v:await (${expr.replace(/\s*\n\s*/g, ' ')})}}catch(e){return{__n:${id},err:String(e)}}})()`);
  const e = await event((x) => x.event === 'report' && x.label === label && x.data?.__n === id, ms);
  if (!e) return undefined;
  if (e.data.err) throw new Error(`${label}: ${e.data.err}`);
  return e.data.v;
}
const js = (expr, ms) => ask('workspace', expr, ms);
async function has(expr, want, seconds = 10, label = 'workspace') {
  for (const end = Date.now() + seconds * 1000; Date.now() < end; await sleep(300)) {
    last = String(await ask(label, expr, 2000).catch((e) => e.message));
    if (last.includes(want)) return true;
  }
  return false;
}
async function call(name, args) {
  const before = events.length;
  send(`call ${name} ${JSON.stringify(args)}`);
  return event((x, i) => x.event === 'reply' && x.name === name && events.indexOf(x) >= before, 8000);
}
async function hostState() {
  const before = events.length;
  send('state');
  return event((x) => x.event === 'state' && events.indexOf(x) >= before, 4000);
}
const view = (v) => js(`(__ws.show('${v}'), 1)`);
const line = async (l) => { await js(`(__ws.type('${l}'), 1)`); await sleep(400); };

// No microphone, whatever happens: in both pages asking for one fails before the system is asked, and the recorder's
// source is the checks' tone. Nothing in the round asks; this makes sure nothing can.
const DEAF = "(Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: () => Promise.reject(new DOMException('The graphics round never opens the microphone.', 'NotAllowedError')) }), typeof __speech === 'object' && (__speech.talk.source = 'tone'), String(navigator.mediaDevices.getUserMedia).includes('graphics round'))";
async function deafen(label) {
  if (String(await ask(label, DEAF, 4000).catch((e) => e.message)) !== 'true') throw new Error(`the microphone could not be taken away from the ${label} page: nothing is measured`);
}
/** The workspace's page running (again: closing the window ends it), its microphone taken away, Setup put away. */
async function workspaceRuns() {
  if (!(await has('typeof __ws', 'object', 30))) throw new Error("the workspace's page does not run");
  await deafen('workspace');
  windowOpen = true;
  if (String(await js("__ws.ui.sheet?.kind ?? ''")) === 'setup') {
    await js("([...document.querySelectorAll('.sheet .sh-f .act')].find(b => b.textContent.includes('Not now'))?.click(), 1)");
    await sleep(500);
  }
}

// The window in front, as a person brings it there (Tasktap's own `show`, which makes it the active app's key
// window), and seen; closed, as a person closes it, so that the notch is what shows.
let upNote = '';
async function up() {
  send('where system');
  const was = windowOpen;
  send('show');
  if (!was) await workspaceRuns();
  if (PASSIVE) { send('where front'); return; }
  let front = false;
  for (let i = 0; i < 16 && !front; i++) { await sleep(250); front = (await hostState())?.where?.front === true; }
  upNote = '';
  if (!front) {
    // macOS may refuse an app the activation it asks for; the window is then put in front by the debug channel's
    // `front` and the host told so: what the page draws is the same, but no caret blinks in a window that is not key.
    send('front');
    send('where front');
    upNote = 'the window was put in front with the debug channel, not made key: macOS did not make the app active';
  }
  await sleep(300);
}
async function down() {
  send('where system');
  if (windowOpen) {
    send('close workspace');
    windowOpen = false;
    await sleep(1000);
  }
  if (PASSIVE) send('where behind');
}
async function notchOpen() { const s = await hostState(); return !!s && s.notch && s.notch.collapsed === false; }
async function folded() {
  if (await notchOpen()) {
    send('key notch Escape');
    await sleep(1000);
    noted.push(`the notch had opened on the question by itself and was folded${(await notchOpen()) ? ', and it STAYED OPEN' : ''}`);
  }
}
// The level the checks' tone gives a recording (a 220 Hz tone swelling three times a second), reported ten times a
// second where the core's report of a recording's level goes (the page's records): the page draws listening as it does
// while a person speaks; no microphone is opened and nothing is played.
async function tone(on) {
  if (on) {
    const said = await js("(() => { const r = __ws.records, id = 'gpu-round-tone', t0 = performance.now(); clearInterval(window.__tone); r.dictations.set(id, { id, rev: 0, phase: 'recording', text: '', level: 0, target: { kind: 'text' }, error: null }); window.__tone = setInterval(() => { r.dictations.get(id).level = Math.round(45 + 35 * Math.sin(2 * Math.PI * 3 * (performance.now() - t0) / 1000)); r.onchange(); }, 100); r.onchange(); return String(__ws.ui.voice); })()");
    if (String(said) !== 'true') throw new Error(`the page does not listen to the tone's level (it said: ${said})`);
  } else await js("(clearInterval(window.__tone), __ws.records.dictations.delete('gpu-round-tone'), __ws.records.onchange(), 1)");
}
// The fixture agent's thought: held on its way (the hold set long), started, in its turn, asking.
let agent = 'none', thought = '', agentSession = '', project = '', shell = '', slides = 0, last = '', noted = [];
const phase = () => `String([...__ws.records.thoughts.values()].find(t => t.id === '${thought}')?.phase)`;
async function held() {
  if (agent !== 'none') return;
  await call('put', { c: 'prefs', id: 'hold', patch: 900 });
  thought = await js('__ws.uuid7()');
  await js(`(__ws.call('thought.capture', { id: '${thought}', text: 'Measure what the light costs', strokes: [], source: 'typed', project_id: '${project}' }), 1)`);
  if (!(await has(phase(), 'routed', 15))) throw new Error(`the thought is not held on its way (its phase: ${last})`);
  agent = 'held';
}
async function working() {
  if (agent === 'none') await held();
  if (agent !== 'held') return;
  await js(`(__ws.call('thought.start', { id: '${thought}', attempt: __ws.uuid7() }), 1)`);
  if (!(await has(phase(), 'working', 20))) throw new Error(`the thought does not start (its phase: ${last})`);
  agentSession = await js(`[...__ws.records.thoughts.values()].find(t => t.id === '${thought}')?.session_id ?? ''`);
  await has(`String(__ws.focusSession('${agentSession}'))`, 'true', 10);
  if (!(await has('__ws.text()', 'fixture-agent', 10))) throw new Error("the fixture agent's terminal does not show it");
  await line('event:ready');
  await line('event:turn_started');
  agent = 'working';
}
async function asking() {
  if (agent === 'asking') return;
  await working();
  await has(`String(__ws.focusSession('${agentSession}'))`, 'true', 10);
  await line('ask:Deploy to staging?');
  await view('home');
  if (!(await has("(document.querySelector('.needs')?.innerText ?? '')", 'Deploy to staging?', 10))) throw new Error('the question does not show on Home');
  agent = 'asking';
}
// A shell in the project, counting as fast as zsh prints: a build's log, without end until Control-C.
async function printing() {
  await view(project);
  shell = await js(`__ws.newTerminal('${project}')`);
  if (!(await has(`__ws.records.terminals.get('${shell}')?.state + ' ' + __ws.engines.get('${shell}')?.attached`, 'running true', 10))) throw new Error(`the terminal does not start (${last})`);
  await sleep(1000);
  await line('i=0; while true; do i=$((i+1)); echo "$i a line of a build that prints as fast as it can, as a compiler or a test run does"; done');
}

// ——— The round.
const F = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? '-' : Number(x).toFixed(d));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return a.length ? Math.sqrt(mean(a.map((x) => (x - m) ** 2))) : NaN; };
const max = (a) => (a.length ? Math.max(...a) : NaN);
let out = '', said = [];
function say(verdict, what, evidence = '') {
  const text = `${verdict.padEnd(7)}${what}${evidence ? `: ${evidence}` : ''}`;
  console.log(text);
  said.push(text);
  if (out) fs.appendFileSync(path.join(out, 'results.txt'), text + '\n');
}

async function main() {
  const o = options(process.argv.slice(2));
  if (o.mode === 'self-test') return selfTest();
  fs.mkdirSync(o.out, { recursive: true });
  const pmLog = path.join(o.out, 'powermetrics.txt');
  const { plan, skipped } = makePlan(o);
  const seconds = estimate(o, plan);
  const minutes = Math.ceil(seconds / 60);
  if (o.mode === 'print') {
    console.log(`In a second Terminal window, before the round, start this and type your password there (it reads the graphics\nprocessor's power and each process's graphics time each second, for about ${Math.ceil((seconds + 600) / 60)} minutes, and then ends by itself;\nControl-C ends it sooner):\n\n  ${powermetricsCommand(o, seconds + 600, pmLog)}\n\nThen start the round in the first window. It finds the log there and reads it at the end.`);
    return;
  }
  if (!plan.length) fail('Nothing to measure.');
  const exe = o.app.endsWith('.app') ? path.join(o.app, 'Contents/MacOS', execFileSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', path.join(o.app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()) : o.app;
  let core = o.core;
  for (let d = path.dirname(exe); !core && d !== path.dirname(d); d = path.dirname(d)) if (fs.existsSync(path.join(d, 'binaries/fixtures/tasktap'))) core = path.join(d, 'binaries/fixtures/tasktap');
  if (!fs.existsSync(exe)) fail(`No app at ${o.app}: build it first (host/scripts/build.sh and FIXTURES=1 host/scripts/build-core.sh), or name one with --app.`);
  if (!core || !fs.existsSync(core) || !fs.existsSync(path.join(path.dirname(core), 'build.txt'))) fail(`No core with the fixture agent beside ${o.app} (FIXTURES=1 host/scripts/build-core.sh), or name one with --core.`);

  const sampler = new Sampler(samplerBinary(o));
  let first = await sampler.next(6000);
  if (!first || !sampler.head) fail('The sampler does not answer.');
  const head = sampler.head;
  const builtin = head.displays.find((d) => d.builtin) ?? head.displays.find((d) => d.main) ?? head.displays[0];
  const [vx, vy, vw, vh] = builtin.visible;
  const frame = o.size === 'full' ? [vx, vy, vw, vh] : [Math.round(vx + (vw - 1180) / 2), Math.round(vy + (vh - 760) / 2), 1180, 760];
  const label = o.rehearse ? 'A REHEARSAL: five seconds a state, on a Mac in use: no figure means anything' : `about ${minutes} minutes`;

  // What stops a round before it starts. The screen: what is not drawn cannot be measured, whatever --force says.
  const hard = [], soft = [];
  if (first.display.asleep || first.locked || !first.console) hard.push('the display is asleep or the screen is locked: nothing drawn can be measured. Wake and unlock the Mac first');
  if (!first.ac) hard.push('the Mac is on battery: its graphics processor and its power are managed otherwise there. Plug it in');
  if (first.lowPower) hard.push("the Mac is in Low Power Mode: Tasktap's effects rest there. Turn it off (System Settings › Battery)");
  if (first.thermal >= 2) hard.push(`the Mac is hot (thermal state ${first.thermal}): it slows itself. Let it cool`);
  let others = '';
  try { others = execFileSync('pgrep', ['-fl', '/Tasktap( Next| Review)?\\.app/Contents/MacOS/'], { encoding: 'utf8' }).trim(); } catch {}
  if (others) hard.push(`another Tasktap is running (${others.split('\n').map((l) => l.split(' ').slice(1).join(' ').replace(/.*\/([^/]+\.app)\/.*/, '$1')).join(', ')}): its notch would lie over this one's. Quit it first`);
  const [px, py] = first.pointer;
  const inside = (x, y, [fx, fy, fw, fh]) => x >= fx && x < fx + fw && y >= fy && y < fy + fh;
  if (inside(px, py, frame) || inside(px, py, [builtin.x + builtin.width / 2 - 250, builtin.y, 500, 80])) soft.push("the pointer is where the app's window or the notch will be: move it to a corner of the screen");
  if (head.accelerator === '' || !head.responsible) hard.push(`this Mac does not answer what the round reads (accelerator '${head.accelerator}', responsible processes ${head.responsible})`);

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  if (o.mode !== 'dry-run') {
    out = path.join(o.out, `${stamp}${o.rehearse ? '-rehearsal' : ''}`);
    fs.mkdirSync(out, { recursive: true });
  }
  const pm = () => { try { const s = fs.statSync(pmLog); return Date.now() - s.mtimeMs < 5000 ? s.size : 0; } catch { return 0; } };
  console.log('');
  say('INFO', `The graphics round on ${head.model} (${head.cores} graphics cores, ${head.accelerator}), ${label}`);
  if (!o.rehearse && o.mode !== 'dry-run') say('INFO', "Please don't touch the Mac until the round says it is done. It brings Tasktap's window in front and keeps it there; a key pressed or the pointer moved spoils that second's figures (the round notes it). It never presses a key or clicks in another app, never moves the pointer and never uses the microphone.");
  say('INFO', `the display: ${builtin.width} x ${builtin.height} at ${builtin.scale}x, ${builtin.hz} Hz (at most ${builtin.maxfps} frames a second); the window: ${frame[2]} x ${frame[3]} at ${frame[0]},${frame[1]} (${o.size === 'full' ? 'the display less its menu bar and Dock' : "the app's default size, in the middle"})`);
  say('INFO', pm() ? `powermetrics' log is being written (${pmLog}): the graphics power and each process's graphics time are read from it at the end` : `no powermetrics log is being written at ${pmLog}: only the figures read without a password. For the graphics power, start host/scripts/gpu.sh --print-powermetrics's command in a second window first`);
  for (const s of skipped) say('SKIP', `${s} at full size: the window is closed for it, so its size changes nothing`);
  for (const why of hard) say(o.rehearse ? 'NOTE' : 'REFUSE', o.rehearse ? `a real round would refuse: ${why}` : why);
  for (const why of soft) say(o.rehearse || o.force ? 'NOTE' : 'REFUSE', o.rehearse ? `a real round would refuse: ${why}` : why);
  const screenOff = first.display.asleep || first.locked || !first.console;
  if (o.mode !== 'dry-run' && ((hard.length && !o.rehearse) || (screenOff && !PASSIVE) || (soft.length && !o.rehearse && !o.force))) { sampler.stop(); process.exitCode = 1; return; }

  // The floor: the Mac with no app, and whether another program uses the graphics processor already.
  const samples = [];
  const record = (s, state, effects) => { samples.push({ s, state, effects }); return s; };
  const floorRow = async (name, length) => {
    for (const s of sampler.drain()) record(s, 'between', '');
    const got = [];
    for (let i = 0; i < length; i++) { const s = await sampler.next(); if (s) got.push(record(s, name, '')); }
    return got;
  };
  if (o.mode === 'dry-run') {
    const got = await floorRow('floor', 5);
    sampler.stop();
    const f = summary(got);
    say('INFO', `now, over 5 s with no app: the graphics processor ${F(f.device)} % busy, all processes ${F(f.all, 2)} ms/s of graphics time, WindowServer ${F(f.ws, 2)} ms/s, the busiest other ${f.otherName || 'none'} ${F(f.other, 2)} ms/s; load ${F(f.load, 2)}`);
    for (const why of floorRefusals(f)) say('NOTE', `the floor would be refused: ${why}`);
    say('INFO', `the round: the floor (${o.floor} s), then ${plan.length} states of ${o.seconds} s at the window's size '${o.size}', effects ${o.effects.join(', ')}, then the floor again (${o.after} s): about ${minutes} minutes`);
    for (const p of plan) console.log(`  ${p.state}, effects ${p.effects}: ${catalogue[p.state].what}`);
    console.log(`the app: ${exe}\nits core with the fixture agent: ${core}`);
    process.exitCode = hard.length || soft.length ? 1 : 0;
    return;
  }

  const rows = [];
  let tmp = '', stopped = '', quitting = false;
  const cleanup = async () => {
    if (quitting) return;
    quitting = true;
    if (child && child.exitCode === null) {
      send('call core.retire {"when":"now"}');
      await sleep(600);
      send('quit');
      for (let i = 0; i < 30 && child.exitCode === null; i++) await sleep(100);
      if (child.exitCode === null) child.kill();
    }
    if (tmp) {
      try { execFileSync('pkill', ['-f', `${tmp}/`]); } catch {}
      await sleep(500);
      try { execFileSync('pkill', ['-9', '-f', `${tmp}/`]); } catch {}
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, async () => {
    say('STOP', `the round was stopped (${signal}): the app quits and nothing more is measured`);
    await cleanup();
    sampler.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(130);
  });

  let floor;
  try {
    say('INFO', `the floor: ${o.floor} s with no app`);
    floor = summary(await floorRow('floor', o.floor));
    floor.state = 'floor'; floor.effects = '';
    rows.push(floor);
    say('INFO', `the floor, with no app: the graphics processor ${F(floor.device)} ± ${F(floor.deviceSd)} % busy, all processes ${F(floor.all, 2)} ms/s of graphics time (most ${F(floor.allMax, 2)}), WindowServer ${F(floor.ws, 2)} ms/s, the busiest other process ${floor.otherName || 'none'} ${F(floor.other, 2)} ms/s on average; load ${F(floor.load, 2)}${floor.used ? `; the Mac was used in ${floor.used} of its seconds` : ''}`);
    const refused = floorRefusals(floor);
    for (const why of refused) say(o.rehearse || o.force ? 'NOTE' : 'REFUSE', o.rehearse ? `a real round would refuse: ${why}` : `${why}${o.force ? ' (measured anyway: --force)' : ' (--force measures anyway)'}`);
    if (refused.length && !o.rehearse && !o.force) { process.exitCode = 1; return; }

    // The app as a person runs it, on folders of the round's own (`tmp`), with the core that has the fixture agent.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasktap-gpu-'));
    for (const d of ['data', 'project', 'home', 'agents', 'no-history/claude', 'no-history/codex']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'home/.zshrc'), '');
    fs.writeFileSync(path.join(tmp, 'data/host.json'), JSON.stringify({ frame }));
    fs.writeFileSync(path.join(tmp, 'gitconfig'), '[user]\n\tname = Round\n\temail = round@example.com\n');
    fs.writeFileSync(path.join(tmp, 'opener'), `#!/bin/sh\necho "$@" >> '${tmp}/opened'\n`, { mode: 0o755 });
    for (const name of ['fixture-agent', 'fixture']) { try { fs.linkSync(core, path.join(tmp, 'agents', name)); } catch { fs.copyFileSync(core, path.join(tmp, 'agents', name)); fs.chmodSync(path.join(tmp, 'agents', name), 0o755); } }
    const env = { ...process.env, HOME: path.join(tmp, 'home'), PATH: `${path.join(tmp, 'agents')}:${process.env.PATH}`,
      TASKTAP_DEBUG: '1', TASKTAP_DATA: path.join(tmp, 'data'), TASKTAP_PICK: path.join(tmp, 'project'), TASKTAP_OPEN: path.join(tmp, 'opener'),
      CLAUDE_CONFIG_DIR: path.join(tmp, 'no-history/claude'), CODEX_HOME: path.join(tmp, 'no-history/codex'),
      GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
      TASKTAP_CORE_EXE: core, TASKTAP_CORE_BUILD: fs.readFileSync(path.join(path.dirname(core), 'build.txt'), 'utf8').trim() };
    delete env.TASKTAP_PASSIVE;
    if (PASSIVE) env.TASKTAP_PASSIVE = '1';
    child = spawn(exe, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    sampler.watch(child.pid, tmp);
    let buffer = '';
    child.stdout.on('data', (d) => {
      buffer += d;
      for (let i; (i = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(i + 1)) {
        const text = buffer.slice(0, i);
        let e;
        try { e = JSON.parse(text); } catch { appLog.push(text); continue; }
        if (e.event !== 'report') appLog.push(text);
        events.push(e);
        for (const w of [...waiting]) if (w.match(e)) { waiting.splice(waiting.indexOf(w), 1); w.ok(e); }
      }
    });
    child.stderr.on('data', (d) => appLog.push(String(d).trimEnd()));
    if (!(await event((x) => x.event === 'ready', 45000))) throw new Error('the app did not start');
    if (!(await has('typeof __records', 'object', 20, 'notch'))) throw new Error("the notch's page does not run");
    await deafen('notch');
    await workspaceRuns();
    say('INFO', "the microphone is taken away from both of the app's pages: asking for it fails there before the system is asked");
    await call('put', { c: 'prefs', id: 'agent', patch: 'fixture' });
    await call('agents.detect', {});
    await js(`(__ws.call('project.add', { id: __ws.uuid7(), folder: ${JSON.stringify(path.join(tmp, 'project'))} }), 1)`);
    for (let i = 0; i < 20 && !project; i++) { project = String((await js("[...__ws.records.projects.values()].find(p => p.kind === 'folder')?.id ?? ''")) ?? ''); if (!project) await sleep(300); }
    if (!project) throw new Error("the round's folder does not become a workspace");
    await up();
    const s = await sampler.next();
    say('INFO', `the app's window: ${s?.win ? `${s.win.width} x ${s.win.height} at ${s.win.x},${s.win.y}, ${Math.round(s.win.covered * 100)} % covered` : 'NOT ON SCREEN'}; its page: ${await js('JSON.stringify({ dpr: devicePixelRatio, inner: [innerWidth, innerHeight] })')}; ${s?.app.procs.length ?? 0} processes (${(s?.app.procs ?? []).map((p) => path.basename(p.path || p.name).replace('com.apple.WebKit.', 'WebKit ')).join(', ')})${upNote ? `; ${upNote}` : ''}`);

    // Each state: entered once, then at each level of the effects settled and measured.
    let was = null;
    for (const p of plan) {
      if (p.state !== was) {
        if (was && catalogue[was].leave) await catalogue[was].leave();
        await catalogue[p.state].enter();
        was = p.state;
      }
      await call('put', { c: 'prefs', id: 'motion_ambient', patch: { full: 'breathing', still: 'still', off: 'off' }[p.effects] });
      const spec = catalogue[p.state];
      for (const s of sampler.drain()) record(s, `enter ${p.state}`, p.effects);
      for (let i = 0; i < p.settle; i++) { const s = await sampler.next(); if (s) record(s, `settle ${p.state}`, p.effects); if (spec.tick) spec.tick(); }
      const before = spec.window ? await pageNow() : null, count = spec.read ? await spec.read() : null;
      for (const s of sampler.drain()) record(s, `settle ${p.state}`, p.effects);
      const got = [], frames = [];
      let prev = before ? before[0] : null;
      for (let i = 0; i < o.seconds; i++) {
        const s = await sampler.next();
        if (!s) throw new Error('the sampler stopped');
        const screen = s.locked ? 'the screen locked' : s.display.asleep ? 'the display slept' : !s.console ? 'another user came to the screen' : '';
        if (screen && !PASSIVE) { stopped = screen; break; }
        if (!s.ac) { stopped = 'the Mac went on battery'; break; }
        if (child.exitCode !== null) { stopped = 'the app quit'; break; }
        got.push(record(s, p.state, p.effects));
        if (spec.window && windowOpen) {
          const f = Number(await js('__motion.stats.frames', 800).catch(() => NaN));
          // A page that began again counts from nothing.
          s.frames = Number.isFinite(f) && prev !== null ? (f >= prev ? f - prev : f) : null;
          if (Number.isFinite(f)) prev = f;
          frames.push(s.frames);
        }
        if (spec.tick) spec.tick();
      }
      const after = spec.window ? await pageNow() : null, counted = spec.read ? await spec.read() : null;
      const row = { ...summary(got, spec), state: p.state, effects: p.effects, rule: spec.rule };
      const notes = [];
      if (after) notes.push(`light ${after[1]}, band canvas ${after[2]}, focus ${after[4]}`);
      if (count !== null && counted !== null) notes.push(`${F((counted - count) / Math.max(1, row.n), 0)} lines/s`);
      if (p.state === 'sidebar') notes.push(`${slides} slides`);
      if (spec.window && upNote) notes.push(upNote);
      notes.push(...noted.splice(0));
      if (spec.window && row.unseen) notes.push(`NOT SEEN in ${row.unseen} of its seconds (the window not on screen, covered or behind another)`);
      if (!spec.window && row.noNotch) notes.push(`the notch NOT ON SCREEN in ${row.noNotch} of its seconds`);
      if (row.used) notes.push(`the Mac was used in ${row.used} of its seconds`);
      if (row.otherMax > LIMITS.other) notes.push(`another program up to ${F(row.otherMax, 1)} ms/s (${row.otherName})`);
      row.notes = notes.join('; ');
      rows.push(row);
      say('ROW', `${p.state} ${p.effects}`, `the graphics processor ${F(row.device)} % busy (floor ${F(floor.device)}); the app's graphics time ${F(row.app, 3)} ms/s (most ${F(row.appMax, 3)}), WindowServer's ${F(row.ws, 2)} ms/s; page ${F(row.frames)} frames/s; processor ${F(row.cpu, 2)} % of a core; ${row.notes}`);
      if (stopped) break;
    }
    if (!stopped && was && catalogue[was].leave) await catalogue[was].leave();
  } catch (e) {
    stopped = stopped || e.message;
    say('FAIL', 'the round stopped on an error', e.message);
  }

  // The floor once more, the app gone: the graphics processor's floor is not one figure.
  await cleanup();
  sampler.watch(0, '');
  if (floor && !process.exitCode) {
    const again = summary(await floorRow('floor after', o.after));
    again.state = 'floor'; again.effects = 'after';
    rows.push(again);
    say('INFO', `the floor again, the app gone: the graphics processor ${F(again.device)} % busy, WindowServer ${F(again.ws, 2)} ms/s, against ${F(floor.device)} % and ${F(floor.ws, 2)} ms/s before`);
  }
  sampler.stop();

  // powermetrics' log, read by time stamp: each state's seconds, and the app's processes among each second's tasks.
  let pmSamples = [];
  try { if (fs.statSync(pmLog).mtimeMs > Date.now() - 3600e3) pmSamples = parsePowermetrics(fs.readFileSync(pmLog, 'utf8')); } catch {}
  const usable = joinPowermetrics(rows, pmSamples);
  const pmFloor = rows[0]?.pmN ? rows[0] : null;
  if (pmSamples.length) say('INFO', `powermetrics' log: ${pmSamples.length} samples, ${usable.length} with a time stamp read; the floor's ${pmFloor ? `${pmFloor.pmN} at ${F(pmFloor.power, 0)} ± ${F(pmFloor.powerSd, 0)} mW` : 'none'}`);
  else say('INFO', `no powermetrics log for this round (${pmLog}): the graphics power and powermetrics' graphics time per process are not reported`);

  // Item 35: at rest the app's figure is zero (with the caret in Home's field, at most its blink).
  for (const row of rows.filter((r) => r.rule)) {
    const bound = row.rule === 'caret' ? CARET_MS : 0;
    const what = `${catalogue[row.state].what}, effects ${row.effects}`;
    const frames = row.framesSeconds;
    const reasons = [];
    if (row.unseen || row.noNotch) reasons.push('it was not seen in every second, so its figures mean nothing');
    if (frames) reasons.push(`the page drew frames in ${frames} of its seconds`);
    if (row.appMax > bound) reasons.push(`the app's processes used the graphics processor ${row.rule === 'caret' ? `over ${bound} ms` : ''} in ${row.appSeconds.filter((x) => x > bound).length} of its seconds (most ${F(row.appMax, 3)} ms/s)`);
    if (row.pmN && row.pmAppMax > bound) reasons.push(`powermetrics gives the app's processes graphics time ${row.rule === 'caret' ? `over ${bound} ms/s ` : ''}in ${row.pmAppNonzero} of its ${row.pmN} seconds (most ${F(row.pmAppMax, 2)} ms/s)`);
    if (row.n < 1) reasons.push('no second was measured');
    const evidence = `in ${row.n} one-second samples the app's processes used ${row.appMax ? `the graphics processor in ${row.appSeconds.filter((x) => x > 0).length} (at most ${F(row.appMax, 3)} ms/s)` : 'no graphics time at all: 0 ns each second'}${row.pmN ? `; powermetrics: ${row.pmAppNonzero ? `${row.pmAppNonzero} of ${row.pmN} seconds over 0.00 ms/s, at most ${F(row.pmAppMax, 2)}` : `0.00 ms/s in all ${row.pmN}`}` : '; without powermetrics\' log'}; the page drew ${frames ?? '-'} frames; the measure's own floor: a process that gives the graphics processor no work reads 0 ns in the driver's count, WindowServer ${F(floor.ws, 2)} ms/s and the graphics processor ${F(floor.device)} % with no app`;
    if (o.rehearse) say('NOTE', `(a rehearsal: no verdict) at rest the app ${row.rule === 'caret' ? 'draws at most the caret' : 'uses no graphics processor'}: ${what}`, evidence);
    else say(reasons.length ? 'FAIL' : 'PASS', `at rest the app ${row.rule === 'caret' ? `uses the graphics processor at most for the caret's blink (${bound} ms a second)` : 'uses no graphics processor'}: ${what}`, reasons.length ? `${reasons.join('; ')}. ${evidence}` : evidence);
  }

  // The table, samples.csv and what the app said.
  const pmOn = rows.some((r) => r.pmN);
  const head2 = ['state', 'effects', 's', 'busy % (+fl)', ...(pmOn ? ['GPU mW (+fl)', 'app pm ms/s'] : []), 'app ms/s', 'app max', 'WS ms/s', 'page f/s', 'Hz', 'CPU %', 'notes'];
  const width = [15, 7, 4, 13, ...(pmOn ? [14, 11] : []), 9, 8, 8, 8, 4, 7, 0];
  const cells = rows.map((r) => {
    const fl = r.state === 'floor';
    const busy = fl ? `${F(r.device)}±${F(r.deviceSd)}` : `${F(r.device)} (${F(r.device - floor.device)})`;
    const watt = !r.pmN ? '-' : fl ? `${F(r.power, 0)}±${F(r.powerSd, 0)}` : `${F(r.power, 0)} (${pmFloor ? F(r.power - pmFloor.power, 0) : '-'})`;
    return [r.state, r.effects, String(r.n), busy, ...(pmOn ? [watt, fl ? '-' : F(r.pmApp, 2)] : []), fl ? '-' : F(r.app, 3), fl ? '-' : F(r.appMax, 3), F(r.ws, 2), fl ? '-' : F(r.frames), F(r.hz, 0), fl ? '-' : F(r.cpu, 2), r.notes ?? ''];
  });
  const fmt = (c) => c.map((x, i) => (width[i] ? String(x).padEnd(width[i]) : x)).join(' ');
  const table = [fmt(head2), '-'.repeat(fmt(head2).length), ...cells.map(fmt), '',
    "busy %: the graphics processor's own utilisation (its statistics' \"Device Utilization %\"), with (+fl) above the floor; " +
    (pmOn ? "GPU mW: its power as powermetrics gives it, with (+fl) over the floor; app pm ms/s: the app's processes' graphics time as powermetrics gives it; " : 'GPU mW: not read (no powermetrics log); ') +
    "app ms/s and app max: the app's processes' graphics time (the app, its WebKit processes, its core and what they start), as the driver counts it for each of its clients, mean and busiest second; WS ms/s: WindowServer's, which draws every window on the screen; page f/s: frames the page's light drew; Hz: the display's refresh rate (a ProMotion display may refresh less often when nothing moves); CPU %: the app's processes, of one core.",
    `The measure's own floor: a process that gives the graphics processor no work reads 0 ns in the driver's count; with no app the graphics processor read ${F(floor.device)} ± ${F(floor.deviceSd)} % and WindowServer ${F(floor.ws, 2)} ms/s.`];
  if (stopped) table.push(`The round was stopped: ${stopped}`);
  fs.writeFileSync(path.join(out, 'table.txt'), table.join('\n') + '\n');
  const pmAt = new Map(usable.map((x) => [Math.round(x.end), x]));
  const csv = ['epoch,time,state,effects,busy %,renderer %,tiler %,all ms/s,WindowServer ms/s,busiest other,other ms/s,app ms/s,app CPU ms/s,app processes,page frames,display Hz,window covered,notch on screen,screen,idle s,load,pm GPU mW,pm app ms/s,pm WindowServer ms/s'];
  for (const { s, state, effects } of samples) {
    const x = pmAt.get(Math.round(s.t)) ?? pmAt.get(Math.round(s.t) + 1);
    const ids = new Set(s.app.procs.map((p) => p.pid));
    csv.push([s.t, new Date(s.t * 1000).toTimeString().slice(0, 8), state, effects, s.gpu.device, s.gpu.renderer, s.gpu.tiler, F(s.all / 1e6 / s.dt, 3), F(s.ws / 1e6 / s.dt, 3),
      JSON.stringify(s.other.name ?? ''), F(s.other.gpu / 1e6 / s.dt, 3), F(s.app.gpu / 1e6 / s.dt, 4), F(s.app.cpu / 1e6 / s.dt, 2), s.app.procs.length, s.frames ?? '', s.display.hz,
      s.win ? F(s.win.covered, 2) : '', s.notch ? 1 : 0, s.locked ? 'locked' : s.display.asleep ? 'asleep' : s.console ? 'on' : 'other user', s.idle, s.load,
      x ? x.power : '', x ? F(x.tasks.filter((t) => ids.has(t.pid)).reduce((a, t) => a + (t.gpu || 0), 0), 2) : '', x ? F(x.tasks.filter((t) => t.name === 'WindowServer').reduce((a, t) => a + (t.gpu || 0), 0), 2) : ''].join(','));
  }
  fs.writeFileSync(path.join(out, 'samples.csv'), csv.join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'app.txt'), appLog.join('\n') + '\n');
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  console.log('');
  console.log(table.join('\n'));
  console.log('');
  const passed = said.filter((l) => l.startsWith('PASS')).length, failed = said.filter((l) => /^(FAIL|STOP)/.test(l)).length;
  console.log(`${o.rehearse ? 'The rehearsal is done' : 'The round is done'}: you can use the Mac again. ${passed} passed, ${failed} failed${stopped ? `, stopped: ${stopped}` : ''}; all of it is in ${out}`);
  if (failed) process.exitCode = 1;
}

/** One state's seconds, summed up. */
function summary(got, spec = {}) {
  const per = (k) => got.map((s) => k(s) / 1e6 / s.dt);
  const app = per((s) => s.app.gpu), others = got.map((s) => s.other.gpu / 1e6 / s.dt);
  const busiest = got.reduce((b, s) => (s.other.gpu > (b?.other.gpu ?? -1) ? s : b), null);
  const frames = got.map((s) => s.frames).filter((x) => x !== null && x !== undefined);
  const device = got.map((s) => s.gpu.device).filter((x) => x >= 0);
  const pids = new Set(got.flatMap((s) => s.app.procs.map((p) => p.pid)));
  const hz = got.map((s) => s.display.hz);
  return {
    n: got.length, t0: got.length ? got[0].t - got[0].dt : 0, t1: got.length ? got[got.length - 1].t : 0, pids,
    device: mean(device), deviceSd: sd(device), all: mean(per((s) => s.all)), allMax: max(per((s) => s.all)), ws: mean(per((s) => s.ws)),
    other: mean(others), otherMax: max(others), otherName: busiest?.other.name ?? '',
    app: mean(app), appMax: max(app), appSeconds: app, cpu: mean(per((s) => s.app.cpu)) / 10,
    frames: frames.length ? mean(frames) : NaN, framesSeconds: frames.length ? frames.filter((x) => x > 0).length : null,
    hz: hz.length ? hz.sort((a, b) => a - b)[Math.floor(hz.length / 2)] : NaN, load: max(got.map((s) => s.load)),
    used: got.filter((s) => s.idle < 1).length,
    unseen: spec.window ? got.filter((s) => !s.win || s.win.covered > 0.01 || s.win.over > 0).length : 0,
    noNotch: spec.window === undefined && spec.what ? got.filter((s) => !s.notch).length : 0,
  };
}
function floorRefusals(f) {
  const no = [];
  if (f.load > LIMITS.load) no.push(`the load is high: ${F(f.load, 2)} (over ${LIMITS.load}): other programs are computing`);
  if (f.other > LIMITS.other) no.push(`another program uses the graphics processor: ${f.otherName} ${F(f.other, 2)} ms a second on average (over ${LIMITS.other})`);
  if (f.device > LIMITS.device) no.push(`the graphics processor is ${F(f.device)} % busy with no app (over ${LIMITS.device} %)`);
  if (f.ws > LIMITS.server) no.push(`WindowServer draws ${F(f.ws, 1)} ms a second with no app (over ${LIMITS.server}): something on the screen moves`);
  return no;
}
async function pageNow() {
  try { return await js("[__motion.stats.frames, document.querySelector('.light')?.dataset.state ?? 'none', (c => c ? c.width + 'x' + c.height : 'none')(document.querySelector('.band canvas')), document.querySelectorAll('canvas').length, document.activeElement?.id || document.activeElement?.tagName || 'none']", 3000); } catch { return null; }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { parsePowermetrics };
