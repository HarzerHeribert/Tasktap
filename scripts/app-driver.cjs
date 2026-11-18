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

/** Whether the main display is awake: a sleeping display draws no frames, so nothing measured on it means anything. */
function awake() {
  try {
    return /asleep false/.test(execFileSync('swift', ['-e', 'import CoreGraphics; print("asleep", CGDisplayIsAsleep(CGMainDisplayID()) != 0)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return false;
  }
}

async function launch({ exe = RELEASE, fixture = false, env = {} } = {}) {
  if (!fs.existsSync(exe)) throw new Error(`Build the app first (host/scripts/build.sh): ${exe}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasktap-measure-'));
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project);
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
  try {
    const shown = await event((x) => x.event === 'window');
    await event((x) => x.event === 'ready');
    return { tmp, project, pid: child.pid, window: shown.ms, send, ask, until, snapshot, quit, events };
  } catch (e) {
    await quit();
    throw e;
  }
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** Rows as a table of aligned columns. */
function table(head, rows) {
  const all = [head, ...rows].map((r) => r.map(String)), w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  return all.map((r) => r.map((c, i) => (i ? c.padStart(w[i]) : c.padEnd(w[i]))).join('  ')).join('\n');
}

module.exports = { launch, awake, sleep, table, RELEASE, DEBUG, root };
