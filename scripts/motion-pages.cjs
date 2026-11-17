// Runs the notch and workspace pages from ui/dist in headless Chromium without the Tauri host:
// a fake Tauri runtime and a fake core answer the pages, so their real DOM can be screenshotted.
// Library: serve, open, fixtures. CLI: node scripts/motion-pages.cjs <outdir> (ui/dist must be built).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { VERSION } = (() => {
  const m = /export const VERSION = (\d+)/.exec(fs.readFileSync(path.join(root, 'core/proto/protocol.ts'), 'utf8'));
  return { VERSION: Number(m[1]) };
})();
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };

function serve(distDir) {
  const server = http.createServer((req, res) => {
    const file = path.join(distDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(fs.readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () =>
    ok({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((d) => server.close(d)) })));
}

// Runs in the page before its scripts: the Tauri runtime and the core, both fake.
function fakeRuntime({ label, records: records0, welcome }) {
  const callbacks = new Map();
  let nextCb = 1;
  const listeners = new Map(); // event -> [{handler, id}]
  let channel = 0, index = 0, rev = 100, nextEvent = 1;
  const records = records0;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const toCore = (obj) => {
    const p = enc.encode(JSON.stringify(obj)), out = new Uint8Array(5 + p.length);
    new DataView(out.buffer).setUint32(0, p.length + 1, true);
    out.set(p, 5);
    callbacks.get(channel)({ index: index++, message: out.buffer });
  };
  const push = (change) => {
    for (const set of change.sets || []) {
      if (set.c === 'glance') { records.glance = set.put[set.put.length - 1]; continue; }
      let rows = (records[set.c] || []).filter((r) => !(set.del || []).includes(r.id));
      for (const row of set.put || []) rows = rows.filter((r) => r.id !== row.id).concat(row);
      records[set.c] = rows;
    }
    toCore(change);
  };
  const reply = (id, ok) => toCore({ t: 'reply', id, ok: ok === undefined ? null : ok });
  // A stream's bytes: kind 1, the stream id, the data.
  let nextStream = 1;
  const toStream = (s, text) => {
    const p = enc.encode(text), out = new Uint8Array(9 + p.length);
    new DataView(out.buffer).setUint32(0, p.length + 5, true);
    out[4] = 1;
    new DataView(out.buffer).setUint32(5, s, true);
    out.set(p, 9);
    callbacks.get(channel)({ index: index++, message: out.buffer });
  };
  const answer = (call) => {
    const { id, name, args } = call;
    // A terminal's screen from `screens`, a diff from `diffs`; the page's own history call gets an empty page.
    if (name === 'terminal.open') {
      const s = nextStream++;
      reply(id, { s, credit: 1 << 20, from: 0 });
      const text = (records.screens || {})[args.id];
      if (text) setTimeout(() => toStream(s, text.replace(/\n/g, '\r\n')), 0);
      return;
    }
    if (name === 'thought.changes') {
      const s = nextStream++, d = (records.diffs || {})[args.id] || { files: [], text: '' };
      reply(id, { stream: { s, credit: 0 }, files: d.files, more: 0, size: d.text.length, cut: false });
      setTimeout(() => (toStream(s, d.text), toCore({ t: 'close', s, why: 'done' })), 0);
      return;
    }
    if (name === 'history') return reply(id, { thoughts: [], questions: [], results: [] });
    // `hold`: a capture is never answered, so the field stays as it is while a thought is on its way.
    if (name === 'thought.capture' && records.hold) return;
    // A thought saved for later is kept as the core keeps it, so the page can show where it landed.
    if (name === 'thought.capture' && args.mode === 'note') {
      rev++;
      push({ t: 'change', rev, sets: [{ c: 'thoughts', put: [{ id: args.id, rev, text: args.text, strokes: [], source: 'typed', mode: 'note', phase: 'captured', status: 'captured',
        reason: null, live: false, project_id: null, session_id: null, brief: args.text, agent: null, model: null, workdir: null, hold_until: null, read: false, created: Date.now(), updated: Date.now() }] }] });
      return reply(id, null);
    }
    // Keep or Discard: what `settles` holds for the thought is the core's refusal in its own words; else it settles,
    // as `kept` where `settles` says a discard found everything already in its branch.
    if (name === 'thought.settle') {
      const said = (records.settles || {})[args.id], t = (records.thoughts || []).find((x) => x.id === args.id);
      if (said && said !== 'kept') return toCore({ t: 'reply', id, err: { code: 'failed', message: said } });
      if (t) push({ t: 'change', rev: ++rev, sets: [{ c: 'thoughts', put: [{ ...t, rev, workdir: { ...t.workdir, changes: args.keep || said ? 'kept' : 'discarded' } }] }] });
      return reply(id, null);
    }
    if (name === 'put' && args.c !== 'prefs') return reply(id, { rev: ++rev });
    if (name === 'sub') {
      const sets = (args.collections || []).map((c) => c === 'glance' ? { c, put: records.glance ? [records.glance] : [] } : { c, put: records[c] || [] });
      push({ t: 'change', rev, snap: true, sets });
      return reply(id, { rev });
    }
    if (name === 'put' && args.c === 'prefs') {
      rev++;
      const row = { id: args.id, value: args.patch, rev };
      records.prefs = (records.prefs || []).filter((p) => p.id !== row.id).concat(row);
      push({ t: 'change', rev, sets: [{ c: 'prefs', put: [row] }] });
      return reply(id, { rev });
    }
    reply(id, null);
  };
  const frames = (bytes) => {
    for (let at = 0; at + 5 <= bytes.length;) {
      const len = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);
      if (bytes[at + 4] === 0) {
        const f = JSON.parse(dec.decode(bytes.subarray(at + 5, at + 4 + len)));
        if (f.t === 'call') answer(f);
      }
      at += 4 + len;
    }
  };
  const hostValue = () => null;
  // The host's part of the notch: the geometry it last described, widened by the wings the page asks for.
  let geo = null, tab = 0;
  const emit = (payload, event = 'ui') => {
    if (payload.do === 'geometry') (geo = { ...payload }), (tab = payload.width);
    for (const l of listeners.get(event) || []) callbacks.get(l.handler)?.({ event, id: l.id, payload });
  };
  window.__fake = { emit, push, records };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label } },
    transformCallback(cb) { const id = nextCb++; callbacks.set(id, cb); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      if (cmd === 'bridge_open') {
        channel = args.frames.id;
        setTimeout(() => toCore({ t: 'welcome', v: welcome.v, core: 'fake-core', build: 'harness', as: 'device', calls: welcome.calls }), 0);
        return null;
      }
      if (cmd === 'bridge_send') { frames(args instanceof Uint8Array ? args : new Uint8Array(args)); return null; }
      if (cmd === 'bridge_host') {
        const { id, name, args: a } = JSON.parse(args.frame);
        if (name === 'host.notch' && geo && typeof a.wing === 'number' && geo.width !== tab + 2 * a.wing)
          setTimeout(() => emit({ ...geo, width: tab + 2 * a.wing }) || (tab = geo.width - 2 * a.wing), 0);
        return JSON.stringify({ t: 'reply', id, ok: hostValue(name) });
      }
      if (cmd === 'plugin:event|listen') {
        const id = nextEvent++;
        if (!listeners.has(args.event)) listeners.set(args.event, []);
        listeners.get(args.event).push({ handler: args.handler, id });
        return id;
      }
      if (cmd === 'plugin:event|unlisten') {
        const l = listeners.get(args.event);
        if (l) listeners.set(args.event, l.filter((x) => x.id !== args.eventId));
        return null;
      }
      if (cmd === 'plugin:window|is_focused') return true;
      return null;
    },
  };
}

const CALLS = ['sub', 'put', 'capture', 'thought.stop', 'question.answer', 'terminal.open', 'thought.changes', 'thought.settle', 'history'];

// A page with the fake runtime, loaded, with `sub` answered from `records`.
// `video`: Playwright's recordVideo for the context; `clock`: the page's clock held until the caller runs it.
async function open(browser, { label, records = {}, viewport, dpr = 2, url, video, clock }) {
  const size = viewport || (label === 'notch' ? { width: 560, height: 520 } : { width: 1180, height: 760 });
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: dpr, ...(video ? { recordVideo: video } : {}) });
  const page = await context.newPage();
  if (clock) await page.clock.install();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.addInitScript(fakeRuntime, { label, records, welcome: { v: VERSION, calls: CALLS } });
  await page.goto(`${url}/${label}.html`);
  if (label === 'notch') await page.evaluate(() => { document.documentElement.style.background = '#3a4048'; });
  await page.waitForTimeout(400); // welcome, sub and first paint
  return page;
}

const NOW = 1790000000;
const P1 = 'p-tasktap', P2 = 'p-scratch';
const id = (n) => `019a8b6c-7d10-7000-8000-${String(n).padStart(12, '0')}`;
const THOUGHT = (n, status, text, o = {}) => ({
  id: id(n), rev: n, text, strokes: [], source: 'typed', mode: 'ask', phase: status === 'needs_you' ? 'working' : status, status,
  reason: null, live: status === 'working' || status === 'needs_you', project_id: P1, session_id: id(200 + n), brief: text,
  agent: 'claude', model: null, workdir: null, hold_until: null, read: false, created: NOW - 3600 + n * 60, updated: NOW - 600 + n * 30, ...o,
});
const SESSION = (n, state, activity, o = {}) => ({
  id: id(200 + n), rev: n, project_id: P1, agent: 'claude', terminal_id: null, adopted: false, state, thought_id: id(n), turn: 1,
  resume: null, name: null, named_at: null, model: null, cwd: '/Users/example/projects/tasktap', exit: null, error: null, activity, ...o,
});

// Realistic records, keyed by collection. `question: false` leaves the open question out.
function fixtures({ question = true } = {}) {
  const prompt = 'The migration drops the legacy sessions column, which the importer still reads. Should I keep the column for now or remove it and update the importer in the same change?';
  const thoughts = [
    THOUGHT(1, 'working', 'Make the sync retry back off instead of hammering the server'),
    THOUGHT(2, 'working', 'Add a dark variant of the settings panel'),
    THOUGHT(3, 'working', 'Rename the export command and update the docs', { agent: 'codex' }),
    THOUGHT(4, question ? 'needs_you' : 'working', 'Drop the legacy sessions column from the schema'),
    THOUGHT(5, 'done', 'Fix the flaky terminal resize test', { phase: 'done', live: false }),
    THOUGHT(6, 'done', 'Explain why startup takes two seconds', { phase: 'done', live: false, agent: 'codex' }),
    THOUGHT(7, 'failed', 'Upgrade the bundler to the next major', { phase: 'failed', live: false, reason: 'turn_failed' }),
  ];
  const sessions = [
    SESSION(1, 'working', ['Read src/sync/retry.rs', 'Edit src/sync/retry.rs', 'Running cargo test sync::retry']),
    SESSION(2, 'working', ['Read ui/src/settings/panel.css', 'Edit ui/src/settings/panel.css']),
    SESSION(3, 'working', ['Searching for "export" in docs/', 'Edit docs/cli.md'], { agent: 'codex' }),
    SESSION(4, 'working', ['Read core/src/store/schema.rs', question ? 'Waiting for an answer' : 'Edit core/src/store/schema.rs']),
    SESSION(5, 'idle', ['Edit tests/terminal.rs', 'Ran cargo test terminal (ok)']),
    SESSION(6, 'idle', ['Ran time tasktap --version'], { agent: 'codex' }),
    SESSION(7, 'ended', ['Ran npm install', 'npm error ERESOLVE could not resolve'], { error: 'turn failed' }),
  ];
  const questions = question ? [{
    id: id(300), rev: 40, thought_id: id(4), session_id: id(204), turn: 1, source: 'agent', prompt, detail: null, reply_via: 'core',
    state: 'open', answer: null, kind: 'choice', choices: ['Keep the column for now', 'Remove it and update the importer', 'Ask me again after the importer change'],
  }] : [];
  const results = [
    { id: id(400), rev: 41, thought_id: id(5), session_id: id(205), turn: 1, kind: 'changes', summary: 'The resize test waited on a timer; it now waits for the terminal to report its size. Ten runs in a row pass.' },
    { id: id(401), rev: 42, thought_id: id(6), session_id: id(206), turn: 1, kind: 'answer', summary: 'Startup spends most of its two seconds reading the store; the first window can draw before it finishes.' },
    { id: id(402), rev: 43, thought_id: id(7), session_id: id(207), turn: 1, kind: 'failure', summary: 'The upgrade stopped: two plugins still require the old major and no compatible release exists.' },
  ];
  const agent = (n, version) => ({
    id: n, rev: 5, checked: NOW, installed: true, version, signed_in: true, identity: 'person@example.com', events: true, resume: true,
    permissions: 'core', questions: 'core',
  });
  return {
    thoughts, sessions, questions, results,
    projects: [
      { id: P1, rev: 1, name: 'tasktap', folder: '/Users/example/projects/tasktap', kind: 'folder', color: '#7aa2f7', aliases: [], git: true, isolate: 'busy', open: true, available: true },
      { id: P2, rev: 1, name: 'Scratch', folder: '/Users/example/Scratch', kind: 'scratch', color: '#9aa5b1', aliases: [], git: false, isolate: 'never', open: false, available: true },
    ],
    terminals: [], layouts: [], prefs: [], devices: [],
    agents: [agent('claude', '2.1.0'), agent('codex', '0.80.0')],
    glance: { rev: 44, working: question ? 3 : 4, needs_you: question ? 1 : 0, done: 2, failed: 1, question: question ? id(300) : null, retiring: false },
  };
}

async function main(out) {
  const { chromium } = require('playwright');
  fs.mkdirSync(out, { recursive: true });
  const dist = path.join(root, 'ui/dist');
  const server = await serve(dist);
  const browser = await chromium.launch({ headless: true });
  const geometry = { do: 'geometry', width: 185, height: 32, cutout: true, compact: false, surfaceWidth: 432, surfaceOffset: 0, span: 560, pixel: 2, corner: 10, offset: 0, available: 700, collapsed: false };
  let errors = 0;
  const shot = async (page, name) => {
    await page.waitForTimeout(800);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(out, name) });
    for (const e of page.errors) { errors++; console.error(`${name}: ${e}`); }
    await page.context().close();
    console.log(path.join(out, name));
  };
  try {
    for (const [name, withQuestion, action] of [['notch-capture.png', false, 'capture'], ['notch-question.png', true, 'answer']]) {
      const page = await open(browser, { label: 'notch', records: fixtures({ question: withQuestion }), url: server.url });
      await page.evaluate((g) => window.__fake.emit(g), geometry);
      await page.evaluate((a) => window.__fake.emit({ do: a }), action);
      await shot(page, name);
    }
    const page = await open(browser, { label: 'workspace', records: fixtures(), url: server.url });
    await shot(page, 'workspace-home.png');
  } finally {
    await browser.close();
    await server.close();
  }
  if (errors) process.exitCode = 1;
}

module.exports = { serve, open, fixtures, scene: (...a) => require('./instrument-fixtures.cjs').scene(...a) };
if (require.main === module) {
  if (!process.argv[2]) { console.error('usage: node scripts/motion-pages.cjs <outdir>'); process.exit(2); }
  main(path.resolve(process.argv[2])).catch((e) => { console.error(e); process.exit(1); });
}
