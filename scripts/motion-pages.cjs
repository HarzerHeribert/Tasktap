// Runs the notch and workspace pages from ui/dist in headless Chromium without the Tauri host:
// a fake Tauri runtime and a fake core answer the pages, so their real DOM can be screenshotted.
// Library: serve, open, fixtures. CLI: node scripts/motion-pages.cjs <outdir> (ui/dist must be built).
// A slow machine, on request: SLOW_CORE=<ms> (the core's every word that much later, or `lateMs` in the records) and
// CPU_THROTTLE=<n> (the page n times slower, Chromium only).
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
function fakeRuntime({ label, records: records0, welcome, terms, keys: ownKeys }) {
  const callbacks = new Map();
  let nextCb = 1;
  const listeners = new Map(); // event -> [{handler, id}]
  let channel = 0, index = 0, rev = 100, nextEvent = 1;
  const records = records0;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const deliver = (obj) => {
    const p = enc.encode(JSON.stringify(obj)), out = new Uint8Array(5 + p.length);
    new DataView(out.buffer).setUint32(0, p.length + 1, true);
    out.set(p, 5);
    callbacks.get(channel)({ index: index++, message: out.buffer });
  };
  // `lateMs` (or SLOW_CORE in the environment): everything the core says comes that much later, in its order, as a
  // core that is far away or busy says it.
  const toCore = (obj) => (records.lateMs ? setTimeout(() => deliver(obj), records.lateMs) : deliver(obj));
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
  const heard = {};
  const toStream = (s, text) => {
    const p = typeof text === 'string' ? enc.encode(text) : text, out = new Uint8Array(9 + p.length);
    new DataView(out.buffer).setUint32(0, p.length + 5, true);
    out[4] = 1;
    new DataView(out.buffer).setUint32(5, s, true);
    out.set(p, 9);
    callbacks.get(channel)({ index: index++, message: out.buffer });
  };
  const calls = [];
  // What every `put` asked for, in order (settings-rows-check.cjs).
  const puts = [];
  // The sizes terminals were opened at and asked to take, in order (terminal-size-check.cjs).
  const sizes = [];
  // The rule of a shortcut (core/proto Shortcut::refused), in small: what a scene needs of it.
  const refused = (k) => (!/^(Key[A-Z]|Digit\d|F\d+|Space|Enter|Tab|Escape|Backspace|Delete|Arrow\w+|Minus|Equal|Comma|Period|Slash)$/.test(k.code) ? 'That is not a key a shortcut can end in'
    : !(k.control || k.alt || k.meta) ? 'A shortcut needs Control, Option (Alt) or Command (the Windows key) held with its key'
      : k.meta && !k.control && !k.alt && ['Space', 'Tab', 'KeyQ', 'KeyW', 'KeyL'].includes(k.code) ? 'The system keeps that combination for itself' : null);
  // What a dictation was heard as: it failed, its words are for a field, or it is its thought.
  const heardAs = (d, said) => {
    const row = (x, del) => push({ t: 'change', rev: ++rev, sets: [{ c: 'dictations', ...(del ? { del: [x.id] } : { put: [{ ...x, rev }] }) }] });
    if (said.error) return row({ ...d, phase: 'failed', level: 0, text: said.text || '', error: said.error });
    if (d.target.kind === 'text') return row({ ...d, phase: 'heard', level: 0, text: said.text });
    row(d, true);
    const now = Date.now();
    push({ t: 'change', rev: ++rev, sets: [{ c: 'thoughts', put: [{ id: d.target.id, rev, text: said.text, strokes: [], source: 'voice', mode: 'ask', phase: 'routed', status: 'routed', reason: null, live: false,
      project_id: d.target.project_id || ((records.projects || [])[0] || {}).id || null, session_id: null, brief: said.brief || said.text, route: said.route || null, placed: said.placed || (d.target.project_id ? 'picked' : 'name'), agent: d.target.agent || 'claude', model: null, workdir: null,
      hold_until: now + 5000, read: false, created: now, updated: now }] }] });
  };
  const answer = (call) => {
    const { id, name, args } = call;
    calls.push(name);
    if (name === 'put') puts.push(args);
    if (name === 'terminal.open' || name === 'terminal.resize') sizes.push({ call: name, id: args.id, cols: args.cols, rows: args.rows });
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
    // Previews (design §9): `preview.open` under the rule in small (a web address of this machine; a path `files` says
    // exists; eight beside a terminal), and `file.read` from `reads`, by the file's whole path: what it is (`kind`),
    // its `text` or its bytes in base64 (`b64`), whether it is `cut`, its `stamp`, or the refusal (`err`).
    const refuse = (code, message) => toCore({ t: 'reply', id, err: { code, message } });
    if (name === 'preview.open') {
      const web = /^https?:\/\//i.test(args.target), local = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?([/?#]|$)/i.test(args.target);
      if (web && !local) return refuse('invalid', 'A preview shows web addresses of this machine only: this one opens in the browser');
      const real = web ? args.target : (records.files || {})[args.target];
      if (!real) return refuse('gone', `${args.target} does not exist`);
      const of = (records.previews || []).filter((p) => p.terminal_id === args.terminal), had = of.find((p) => p.target === real);
      if (!had && of.length >= 8) return refuse('conflict', 'This terminal has 8 previews open already: close one first');
      const row = had || { id: `019a8b6c-7d10-7000-9000-${String(++rev).padStart(12, '0')}`, rev, terminal_id: args.terminal, kind: web ? 'web' : 'file', target: real,
        title: web ? new URL(real).host : real.split('/').pop(), by: 'person' };
      if (!had) push({ t: 'change', rev, sets: [{ c: 'previews', put: [row] }] });
      return reply(id, row.id);
    }
    if (name === 'delete' && args.c === 'previews') return push({ t: 'change', rev: ++rev, sets: [{ c: 'previews', del: [args.id] }] }), reply(id, null);
    if (name === 'file.read') {
      const f = (records.reads || {})[args.path];
      if (!f) return refuse('gone', `${args.path} does not exist`);
      if (f.err) return refuse(f.err.code, f.err.message);
      const bytes = f.b64 ? Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)) : enc.encode(f.text || ''), stamp = f.stamp || '1-' + bytes.length;
      const said = { size: f.size || bytes.length, kind: f.kind, encoding: f.b64 ? null : 'utf-8', cut: !!f.cut, stamp };
      if (args.unless === stamp || f.kind === 'other') return reply(id, { ...said, stream: null });
      const s = nextStream++;
      reply(id, { ...said, stream: { s, credit: 0 } });
      return void setTimeout(() => (toStream(s, bytes), toCore({ t: 'close', s, why: 'done' })), f.ms || 0);
    }
    // The history the scene has (`history`), as one page; then, or with none, the empty page that is its end.
    if (name === 'history') return reply(id, (!args.before && records.history) || { thoughts: [], questions: [], results: [] });
    // What a model that places thoughts and a speech service are sent, as the core says it.
    if (name === 'route.terms') return reply(id, { ...terms.route, tools: records.tools || terms.route.tools });
    // The sign-in with ChatGPT (core chatgpt.rs): the address of OpenAI's page, and the wait for the browser, one at a
    // time; the check pushes how it ends. Signing out takes the record and ChatGPT's row of the agreement away, and an
    // agreement left with no row goes with it.
    if (name === 'chatgpt.sign_in' || name === 'chatgpt.sign_out') {
      const set = (key, value) => {
        rev++;
        records.prefs = (records.prefs || []).filter((p) => p.id !== key).concat(value === undefined ? [] : [{ id: key, value, rev }]);
        push({ t: 'change', rev, sets: [{ c: 'prefs', ...(value === undefined ? { del: [key] } : { put: [{ id: key, value, rev }] }) }] });
      };
      const now = (key) => (records.prefs || []).find((p) => p.id === key)?.value;
      if (name === 'chatgpt.sign_out') {
        const by = now('route_by'), left = by?.agents.filter((a) => a.agent !== 'chatgpt');
        if (by) set('route_by', left.length ? { ...by, agents: left } : undefined);
        set('chatgpt', null);
        return reply(id, null);
      }
      if (now('chatgpt')?.state === 'waiting') return toCore({ t: 'reply', id, err: { code: 'conflict', message: 'a sign-in with ChatGPT is waiting for the browser already' } });
      set('chatgpt', { state: 'waiting', model: null, name: null, error: null });
      return reply(id, 'https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&state=fake');
    }
    if (name === 'speech.terms') return reply(id, terms.speech);
    const pref = (key, value) => {
      rev++;
      records.prefs = (records.prefs || []).filter((p) => p.id !== key);
      if (value !== undefined) records.prefs.push({ id: key, value, rev });
      push({ t: 'change', rev, sets: [{ c: 'prefs', ...(value === undefined ? { del: [key] } : { put: [{ id: key, value, rev }] }) }] });
    };
    const keys = () => ((records.prefs || []).find((p) => p.id === 'keys') || { value: [] }).value;
    if (name === 'delete' && args.c === 'prefs') return pref(args.id), reply(id, null);
    if (name === 'key.set') return pref('keys', [...keys().filter((s) => s !== args.server), args.server]), reply(id, null);
    if (name === 'key.remove') return pref('keys', keys().filter((s) => s !== args.server)), reply(id, null);
    // A dictation: its row, a stream for the recording whose bytes are kept for the checks and whose loudest
    // sample is the row's level, as the core's is; then what `hears` says it was heard as.
    const row = (d, del) => push({ t: 'change', rev: ++rev, sets: [{ c: 'dictations', ...(del ? { del: [d.id] } : { put: [{ ...d, rev }] }) }] });
    const dictation = (i) => (records.dictations || []).find((d) => d.id === i);
    // With no speech service chosen the recorder writes it down itself (`local`): no stream, and its reports are
    // the row's level and words while it records, and the transcript once it has finished.
    if (name === 'dictation.start' && args.local && !(records.prefs || []).some((p) => p.id === 'speech_by' && p.value)) {
      row({ id: args.id, phase: 'recording', text: '', level: 0, target: args.target, error: null });
      return reply(id, { stream: null, seconds: 300 });
    }
    if (name === 'dictation.report') {
      const d = dictation(args.id);
      if (d && d.phase === 'recording') row({ ...d, ...(args.text === undefined ? {} : { text: args.text }), ...(args.level === undefined ? {} : { level: args.level }) });
      else if (d && d.phase === 'transcribing' && d.local && args.text !== undefined) heardAs(d, args.text ? { text: args.text } : { error: 'Nothing was heard' });
      return reply(id, null);
    }
    if (name === 'dictation.start') {
      const s = nextStream++;
      heard[s] = { id: args.id, bytes: [], peak: 0, since: 0 };
      row({ id: args.id, phase: 'recording', text: '', level: 0, target: args.target, error: null });
      return reply(id, { stream: { s, credit: 9600000 }, seconds: 300 });
    }
    if (name === 'dictation.finish') {
      const was = dictation(args.id), said = records.hears || { text: 'Make the header stay on one line' };
      // `as: "text"`: what was started for a thought is only heard.
      const d = args.as === 'text' ? { ...was, target: { kind: 'text' } } : was;
      const local = !Object.values(heard).some((h) => h.id === args.id);
      row({ ...d, phase: 'transcribing', level: 0, local });
      // The recorder's own transcript is waited for; a service's comes by itself.
      if (!local) setTimeout(() => dictation(args.id) && heardAs(d, said), said.ms || 600);
      return reply(id, null);
    }
    if (name === 'dictation.cancel') return dictation(args.id) && row(dictation(args.id), true), reply(id, null);
    // `hints`: where the router would send a text typed, by the text; else nothing is said.
    if (name === 'route.hint') return reply(id, (records.hints || {})[args.text] ?? null);
    // `hold`: a capture is never answered, so the field stays as it is while a thought is on its way.
    if (name === 'thought.capture') window.__fake.sent = args;
    if (name === 'thought.capture' && records.hold) return;
    // `slow`: a capture is answered that many milliseconds later, as a core that is far away or busy answers;
    // `refuse`: with that refusal.
    if (name === 'thought.capture' && (records.slow || records.refuse)) return void setTimeout(() => (records.refuse ? toCore({ t: 'reply', id, err: { code: 'failed', message: records.refuse } }) : reply(id, null)), records.slow || 0);
    // A thought saved for later is kept as the core keeps it, so the page can show where it landed; and with `keep`,
    // one left to the router that names no place, as the match on names keeps it.
    if (name === 'thought.update') window.__fake.updated = args;
    // A folder the person chose in the panel becomes a workspace, as the core makes one: open, named by its folder.
    if (name === 'project.add' && !(records.projects || []).some((p) => p.folder === args.folder)) {
      push({ t: 'change', rev: ++rev, sets: [{ c: 'projects', put: [{ id: args.id, rev, name: args.folder.split('/').pop(), folder: args.folder, kind: 'folder', color: '#7aa2f7', aliases: [], git: true, isolate: 'busy', open: true, available: true }] }] });
      return reply(id, args.id);
    }
    if (name === 'thought.capture' && (args.mode === 'note' || (records.keep && !args.project_id))) {
      rev++;
      push({ t: 'change', rev, sets: [{ c: 'thoughts', put: [{ id: args.id, rev, text: args.text, strokes: [], source: 'typed', mode: 'note', phase: 'captured', status: 'captured',
        reason: null, live: false, project_id: null, session_id: null, brief: args.text, route: null, placed: args.mode === 'note' ? 'kept' : 'kept_name', agent: null, model: null, workdir: null, hold_until: null, read: false, created: Date.now(), updated: Date.now() }] }] });
      return reply(id, null);
    }
    // `asks`: a thought left to the router is asked about, as the match on names asks when it is unsure: the thought,
    // then (`asks.ms` later, 300 by default) "Which project is this task for?" with the folders `asks.choices` names
    // ("Where should the agent work?" with none, where no project is known). Answered by a choice it starts there; by
    // Keep for later it is kept.
    if (name === 'thought.capture' && records.asks && !args.project_id && !args.card_id && args.mode !== 'note') {
      const now = Date.now(), thought = { id: args.id, rev: ++rev, text: args.text, strokes: [], source: args.source || 'typed', mode: 'ask', phase: 'captured', status: 'needs_you',
        reason: null, live: false, project_id: null, session_id: null, brief: args.text, route: { by: 'local', model: null, pending: false, fallback: null, quote: null, title: null, ms: 1 },
        placed: null, agent: args.agent || 'claude', model: null, workdir: null, hold_until: null, read: false, created: now, updated: now };
      push({ t: 'change', rev, sets: [{ c: 'thoughts', put: [thought] }] });
      reply(id, null);
      const projects = (records.projects || []).filter((p) => p.open && p.kind === 'folder');
      const choices = (records.asks.choices || projects.slice(0, 3).map((p) => p.name)).slice(0, 3);
      const known = projects.length || (records.cards || []).length;
      const q = { id: `019a8b6c-7d10-7000-a000-${String(++rev).padStart(12, '0')}`, rev, thought_id: args.id, session_id: null, turn: null, source: 'router',
        prompt: known ? 'Which project is this task for?' : 'Where should the agent work?', detail: null,
        reply_via: 'core', state: 'open', answer: null, kind: 'choice', choices, places: choices.map((n) => ({ project: (projects.find((p) => p.name === n) || {}).id })), notes: records.asks.notes || choices.map(() => '') };
      setTimeout(() => push({ t: 'change', rev: ++rev, sets: [{ c: 'questions', put: [{ ...q, rev }] }] }), records.asks.ms ?? 300);
      window.__fake.asked = q;
      return;
    }
    if (name === 'question.answer' && window.__fake.asked && args.id === window.__fake.asked.id) {
      const q = window.__fake.asked, t = (records.thoughts || []).find((x) => x.id === q.thought_id), now = Date.now();
      window.__fake.answered = args;
      const to = args.kind === 'choice' ? q.places[args.choice] : null;
      push({ t: 'change', rev: ++rev, sets: [{ c: 'questions', put: [{ ...q, rev, state: 'answered' }] },
        { c: 'thoughts', put: [{ ...t, rev, ...(to ? { phase: 'routed', status: 'routed', project_id: to.project, placed: 'answer', hold_until: now + 3000 } : { mode: 'note', status: 'captured', placed: 'kept_answer' }) }] }] });
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
    // What Tasktap knows of the person's projects (docs/projects-design.md): `offer` is what `projects.offer` finds;
    // a look added or switched on puts its row and then, one by one as a look fills in, the cards of `found`;
    // `projects.find` is the core's own answer (`FIND` below), or `finds` by its text where a picture wants one.
    // `offerHeld`: the answer waits until the check calls window.__fake.offer() (the first start, at a moment it chooses).
    if (name === 'projects.offer' && records.offerHeld) return void (window.__fake.offer = () => reply(id, records.offer || { agents: [], places: [] }));
    if (name === 'projects.offer') return void setTimeout(() => reply(id, records.offer || { agents: [], places: [] }), records.offerMs || 0);
    if (name === 'projects.look') return reply(id, { projects: (records.cards || []).filter((c) => !c.copy_of && !c.inside && !c.hidden).length, ms: 40 });
    const look = (row) => {
      // `lookLateMs`: the look's record comes this long after the core's answer to `look.add` (the core answers first).
      const late = records.lookLateMs || 0;
      setTimeout(() => push({ t: 'change', rev: ++rev, sets: [{ c: 'looks', put: [{ ...row, rev }] }] }), late);
      if (!row.on) return;
      const found = (records.found || []).filter((c) => !(records.cards || []).some((x) => x.id === c.id));
      found.forEach((c, i) => setTimeout(() => push({ t: 'change', rev: ++rev, sets: [{ c: 'cards', put: [{ ...c, rev, looks: [row.id] }] }] }), late + 90 * (i + 1)));
      // `lookEnds`: how a search in a folder ends instead (its `state` and `note`, as the core records them).
      const end = row.kind === 'folder' ? records.lookEnds : undefined;
      setTimeout(() => push({ t: 'change', rev: ++rev, sets: [{ c: 'looks', put: [{ ...row, rev, state: 'ready', found: found.length, looked: Date.now(), ...end }] }] }), late + 90 * (found.length + 1));
    };
    if (name === 'look.add') {
      const had = (records.looks || []).find((l) => (args.agent && l.agent === args.agent) || (args.folder && l.folder === args.folder));
      look({ ...(had || { id: args.id, kind: args.agent ? 'agent' : 'folder', agent: args.agent || null, folder: args.folder || null, state: 'new', found: 0, looked: null, note: null }), on: args.on ?? true });
      return reply(id, (had || args).id);
    }
    if (name === 'projects.find') {
      if ((records.finds || {})[args.text]) return reply(id, { found: records.finds[args.text].slice(0, args.limit || 3) });
      // Asked of the core's own code (core/examples/find.rs), with the projects a request gives it: the open folders
      // with their cards' names and lines, then the projects known and not open. Nothing without it.
      if (!window.__coreFind) return reply(id, { found: [] });
      const cards = records.cards || [], short = (f) => f.replace(/^\/Users\/[^/]+/, '~');
      const open = (records.projects || []).filter((p) => p.open && p.kind === 'folder' && p.available !== false).map((p) => {
        const c = cards.find((x) => x.project_id === p.id || x.folder === p.folder);
        return { to: { project: p.id }, name: p.name, aliases: [...(p.aliases || []), ...((c && c.names) || []).filter((n) => n !== p.name)], about: (c && c.about) || '', folder: short(p.folder), used: (c && c.used) || null };
      });
      const known = cards.filter((c) => !c.copy_of && !c.inside && !c.hidden && c.available !== false && !open.some((o) => o.to.project === c.project_id || o.folder === short(c.folder)))
        .map((c) => ({ to: { card: c.id }, name: c.name, aliases: c.names || [], about: c.about || '', folder: short(c.folder), used: c.used || null }));
      return void window.__coreFind(JSON.stringify({ text: args.text, limit: args.limit, thought: !!args.thought, projects: [...open, ...known] }))
        .then((answer) => reply(id, JSON.parse(answer)));
    }
    if (name === 'put' && (args.c === 'cards' || args.c === 'looks')) {
      const row = (records[args.c] || []).find((r) => r.id === args.id);
      if (!row) return toCore({ t: 'reply', id, err: { code: 'gone', message: `no row "${args.id}"` } });
      const next = { ...row, ...Object.fromEntries(Object.entries(args.patch).filter(([, v]) => v !== null && v !== undefined)), rev: ++rev };
      push({ t: 'change', rev, sets: [{ c: args.c, put: [next] }] });
      if (args.c === 'looks' && next.on && !row.on) look(next);
      // Where its agent works: the card's workspace follows, as in the core (records.rs `PutTarget::Cards`).
      const ws = args.c === 'cards' && args.patch.isolate && (records.projects || []).find((p) => p.id === row.project_id || p.folder === row.folder);
      if (ws) push({ t: 'change', rev: ++rev, sets: [{ c: 'projects', put: [{ ...ws, rev, isolate: args.patch.isolate }] }] });
      return reply(id, { rev });
    }
    if (name === 'delete' && (args.c === 'cards' || args.c === 'looks')) return push({ t: 'change', rev: ++rev, sets: [{ c: args.c, del: [args.id] }] }), reply(id, { rev });
    if (name === 'put' && args.c !== 'prefs') return reply(id, { rev: ++rev });
    if (name === 'sub') {
      const sets = (args.collections || []).map((c) => c === 'glance' ? { c, put: records.glance ? [records.glance] : [] } : { c, put: records[c] || [] });
      // `subMs`: the records come this long after the page asked (a core slow to answer at the first start).
      // `subRefuse`: the core will not give them (the page's records never come).
      const answer = () => (records.subRefuse ? refuse('failed', records.subRefuse) : (push({ t: 'change', rev, snap: true, sets }), reply(id, { rev })));
      return void (records.subMs ? setTimeout(answer, records.subMs) : answer());
    }
    // What runs in a terminal, as the core says when it is closed (`terminal.runs`): what `runs` holds for it, else
    // the rule in small: an agent's live session runs, a shell with none is idle, one not running has ended.
    // `terminal.stop` ends it a moment later; `project.close` closes the folder, its terminals stopped with `stop`.
    if (name === 'terminal.runs') {
      const t = (records.terminals || []).find((x) => x.id === args.id);
      if (!t) return refuse('gone', `no terminal ${args.id}`);
      if ((records.runs || {})[args.id]) return reply(id, records.runs[args.id]);
      const s = (records.sessions || []).filter((x) => x.terminal_id === t.id && x.state !== 'ended').at(-1);
      const names = { claude: 'Claude Code', codex: 'Codex' };
      if (t.state !== 'running') return reply(id, { state: 'ended', what: [], session: null });
      if (s) return reply(id, { state: 'running', what: [names[s.agent] || s.agent], session: s.id });
      return reply(id, t.kind === 'shell' ? { state: 'idle', what: [], session: null } : { state: 'running', what: [t.title], session: null });
    }
    const end = (t) => setTimeout(() => push({ t: 'change', rev: ++rev, sets: [{ c: 'terminals', put: [{ ...t, rev, state: 'exited', exit: null }] }] }), 50);
    if (name === 'terminal.stop') {
      const t = (records.terminals || []).find((x) => x.id === args.id);
      if (t && t.state === 'running') end(t);
      return reply(id, null);
    }
    if (name === 'project.close') {
      window.__fake.closed = [...(window.__fake.closed || []), args];
      const p = (records.projects || []).find((x) => x.id === args.id);
      if (p) push({ t: 'change', rev: ++rev, sets: [{ c: 'projects', put: [{ ...p, rev, open: false }] }] });
      if (args.stop) (records.terminals || []).filter((t) => t.project_id === args.id && t.state === 'running').forEach(end);
      return reply(id, null);
    }
    // A command of an agent that holds what Tasktap sets for its runs is refused in the core's sentence, and nothing is
    // stored.
    if (name === 'put' && args.c === 'prefs' && args.id === 'agent_commands' && startRefused(args.patch)) return toCore({ t: 'reply', id, err: { code: 'invalid', message: startRefused(args.patch) } });
    // A key the rule of a shortcut refuses is refused in the core's sentence, and nothing is stored.
    if (name === 'put' && args.c === 'prefs' && args.id === 'talk_key' && args.patch && refused(args.patch)) return toCore({ t: 'reply', id, err: { code: 'invalid', message: refused(args.patch) } });
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
      } else {
        // A stream's bytes from the page: a recording. Its level follows every tenth of a second of samples.
        const h = heard[new DataView(bytes.buffer, bytes.byteOffset + at + 5, 4).getUint32(0, true)], data = bytes.slice(at + 9, at + 4 + len);
        if (h) {
          h.bytes.push(...data);
          const view = new DataView(data.buffer);
          for (let i = 0; i + 1 < data.length; i += 2) h.peak = Math.max(h.peak, Math.abs(view.getInt16(i, true)));
          if ((h.since += data.length) >= 3200) {
            const db = 20 * Math.log10(Math.max(1, h.peak) / 32768), d = (records.dictations || []).find((x) => x.id === h.id);
            if (d && d.phase === 'recording') push({ t: 'change', rev: ++rev, sets: [{ c: 'dictations', put: [{ ...d, rev, level: Math.round(Math.max(0, Math.min(100, ((db + 55) / 49) * 100))) }] }] });
            h.since = h.peak = 0;
          }
        }
      }
      at += 4 + len;
    }
  };
  // The host's rule for `host.open`, in small: a web address, or a path `files` says exists; what was opened is kept.
  const opened = [];
  // The keys a person records, as the host keeps them (host/src/keys.rs): each the scene's preference or this
  // system's own. A call changes one unless the rule refuses it, the scene says another app holds it (`taken`, by its
  // code), or another of Tasktap's keys has it already, in the core's sentence that names which. The capture key is
  // the one registered (`capture`: the system's own unless the scene says another, or none). A scene with
  // `takes: false` is a copy that takes no global key (a review build): it names none and refuses every one.
  const win = /Windows/.test(navigator.userAgent), takes = records.takes !== false;
  const usual = win ? { control: false, alt: true, shift: true, meta: false, code: 'Space' } : { control: true, alt: true, shift: false, meta: false, code: 'Space' };
  let capture = !takes ? null : records.capture === undefined ? ((records.prefs || []).find((p) => p.id === 'capture_key') || { value: usual }).value : records.capture;
  const OWN_KEYS = {
    question: { control: !win, alt: true, shift: win, meta: false, code: 'KeyJ' }, yes: { control: !win, alt: true, shift: win, meta: false, code: 'KeyY' },
    no: { control: !win, alt: true, shift: win, meta: false, code: 'KeyN' }, talk: { control: win, alt: !win, shift: false, meta: false, code: 'Space' },
  };
  const PREF = { capture: 'capture_key', question: 'question_key', yes: 'yes_key', no: 'no_key', talk: 'talk_key' };
  const DOES = { capture: 'to start a task', question: 'to go to an agent’s question', yes: 'to answer Yes', no: 'to answer No', talk: 'as the key to hold while you talk' };
  const stored = (w) => ((records.prefs || []).find((p) => p.id === PREF[w]) || {}).value;
  const keyOf = (w) => (w === 'capture' ? capture : w === 'talk' ? stored(w) || OWN_KEYS.talk : takes ? stored(w) || OWN_KEYS[w] : null);
  const same = (x, y) => !!x && !!y && ['control', 'alt', 'shift', 'meta', 'code'].every((k) => x[k] === y[k]);
  const answers = () => ({ question: keyOf('question'), yes: keyOf('yes'), no: keyOf('no'), takes });
  /** Why the commands that start Claude Code and Codex cannot be, as the core's `agents::judge` says it, in small: an
   *  argument after the last word that is the agent's program that Tasktap sets itself, alone or with its value. */
  const startRefused = (all) => {
    const sets = { claude: ['Claude Code', ['-p', '--print', '-c', '--continue', '-r', '--resume', '--session-id', '--settings', '--model', '--']], codex: ['Codex', ['-C', '--cd', 'e', 'exec', 'review', 'resume', '-m', '--model', '--']] };
    for (const { agent, command } of all) {
      const [name, flags] = sets[agent] ?? [agent, []], words = command.split(/\s+/), at = words.lastIndexOf(agent);
      const flag = at < 0 ? null : flags.find((f) => words.slice(at + 1).some((w) => w === f || (f.length > 2 && f.startsWith('--') && w.startsWith(`${f}=`))));
      if (flag) return `Tasktap sets ${flag} itself for ${name}: take ${flag} out of the command`;
    }
    return null;
  };
  /** Why `key` cannot be the key `which` beside Tasktap's own window, as the core's `own_key` says it. */
  const sys = win ? 'windows' : 'mac';
  const own = (which, key) => {
    const c = ownKeys.app.find((x) => same(x[sys], key));
    if (c) return `Tasktap uses ${c.says[sys]} for ${c.name}`;
    if (which === 'talk') {
      const f = ownKeys.field.find((x) => same(x[sys], key));
      return f && `A text field uses ${f.says[sys]} for ${f.name}`;
    }
    return null;
  };
  /** A key taken from other apps may not be the system's command modifier alone with one key (`every_app`). */
  const everyApp = (which, key) => {
    const alone = ['control', 'alt', 'shift', 'meta'].filter((m) => key[m]).length === 1;
    if (which !== 'talk' && alone && (win ? key.control : key.meta)) return win ? 'Other apps use Ctrl with a single key: hold Alt or Shift as well' : 'Other apps use ⌘ with a single key: hold Control or Option as well';
    return null;
  };
  /** Tries `key` as the key `which`, and stores it: the reply's sentence when refused. */
  const record = (which, given) => {
    if (which !== 'talk' && !takes) throw 'Tasktap Review takes no keys from other apps';
    const key = given || (which === 'capture' ? usual : OWN_KEYS[which]);
    const other = Object.keys(PREF).find((w) => w !== which && same(keyOf(w), key));
    const why = refused(key) || (given && own(which, key)) || (other && `Tasktap already uses that combination ${DOES[other]}`) || (given && everyApp(which, key))
      || ((records.taken || []).includes(key.code) && 'That key is taken by the system or another app');
    if (why) throw why;
    if (which === 'capture') capture = key;
    const id = PREF[which];
    rev++;
    records.prefs = (records.prefs || []).filter((p) => p.id !== id).concat(given ? [{ id, value: key, rev }] : []);
    push({ t: 'change', rev, sets: [{ c: 'prefs', ...(given ? { put: [{ id, value: key, rev }] } : { del: [id] }) }] });
    return key;
  };
  const hostValue = (name, a) => {
    // The page's word that it has drawn, which shows the window: when, and what its status line said then.
    if (name === 'host.ready') return ((window.__fake.ready ??= { at: performance.now(), rail: document.querySelector('.rail-l')?.textContent ?? null }), null);
    if (name === 'host.capture_key') return a.key === undefined ? { key: capture, takes } : { key: record('capture', a.key), takes };
    if (name === 'host.talk_key') return { key: a.key === undefined ? keyOf('talk') : record('talk', a.key) };
    if (name === 'host.answer_key') return (a.which && record(a.which, a.key), answers());
    // Opening at login, as the scene says the system has it (`login`; none: a host without the call). Every call is kept
    // (`logins`); a change is the system's at once, or, with `approve`, waits for the person to allow it.
    if (name === 'host.login') {
      window.__fake.logins.push(a);
      if (records.login && a.on !== undefined) {
        if (records.login.state === 'unavailable') throw 'macOS can open only a signed Tasktap app when you log in';
        records.login = { state: a.on ? (records.approve ? 'approve' : 'on') : 'off' };
      }
      return records.login ?? null;
    }
    // A preview's frame: where it loads a file from (`frames`, a server of the check's own), whether a local address
    // is answered (`listens`), or the host's refusal (`noframes`).
    if (name === 'host.frame') {
      if (records.noframes) throw records.noframes;
      return { base: records.frames || 'http://127.0.0.1:9/none', ...(a.listens ? { listens: records.listens !== false } : {}) };
    }
    // The system's folder panel: what was asked, in order, and the folder `pick` names (none: the person cancelled).
    if (name === 'host.pick') return (window.__fake.picked.push(a), records.pick ?? null);
    // Windows' tab and the updater, as a scene says them (none: a host without the call).
    if (name === 'host.tab') return records.tab ?? null;
    // What the page asked of the updater is kept (`updates`); the person's own check (`now`) finds what `checked` says.
    if (name === 'host.update') {
      window.__fake.updates.push(a);
      if (a.look && a.now && records.checked) records.update = records.checked;
      return records.update ?? null;
    }
    if (name !== 'host.open') return null;
    const real = /^https?:\/\/[^/\s]/i.test(a.target) ? a.target : (records.files || {})[a.target] || null;
    if (real && !a.probe) opened.push({ ...a, real });
    return real;
  };
  // The host's part of the notch: the geometry it last described, widened by the wings the page asks for.
  let geo = null, tab = 0, wing = 0;
  const emit = (payload, event = 'ui') => {
    if (payload.do === 'geometry') (tab = payload.width), (geo = payload = { ...payload, width: tab + 2 * wing });
    for (const l of listeners.get(event) || []) callbacks.get(l.handler)?.({ event, id: l.id, payload });
  };
  // `close`: the core closes the stream of the dictation that records, as it does when another device cancels it.
  const close = () => {
    const s = Object.keys(heard).pop(), d = (records.dictations || [])[0];
    if (d) push({ t: 'change', rev: ++rev, sets: [{ c: 'dictations', del: [d.id] }] });
    toCore({ t: 'close', s: Number(s), why: 'gone' });
  };
  window.__fake = { emit, push, records, heard, calls, puts, sizes, close, opened, picked: [], updates: [], logins: [] };
  // The keyboard's layout, as the web view says it (keys.ts watchLayout): the records' (`layout`, what each key
  // prints by its place), else a US keyboard's, so that a picture is the same on every machine the checks run on.
  const US = Object.fromEntries([...'abcdefghijklmnopqrstuvwxyz'].map((c) => [`Key${c.toUpperCase()}`, c]).concat([...'0123456789'].map((d) => [`Digit${d}`, d]),
    [['Minus', '-'], ['Equal', '='], ['BracketLeft', '['], ['BracketRight', ']'], ['Backslash', '\\'], ['Semicolon', ';'], ['Quote', "'"], ['Backquote', '`'], ['Comma', ','], ['Period', '.'], ['Slash', '/']]));
  if (top === window) Object.defineProperty(navigator, 'keyboard', { configurable: true, value: { getLayoutMap: async () => new Map(Object.entries(records.layout || US)) } });
  window.__fake.speech = { acts: [], ended: [], fed: [], said(line) { callbacks.get(this.channel)?.({ index: this.n++, message: line }); } };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label } },
    transformCallback(cb) { const id = nextCb++; callbacks.set(id, cb); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      if (cmd === 'bridge_open') {
        channel = args.frames.id;
        // `holdWelcome`: the core has not answered yet (a first start held up, a slow machine) until the check calls
        // window.__fake.welcome(); `welcomeMs`: it answers that many milliseconds after the page connected.
        const hello = () => toCore({ t: 'welcome', v: welcome.v, core: 'fake-core', build: 'harness', as: 'device', calls: welcome.calls });
        if (records.holdWelcome) window.__fake.welcome = hello;
        else setTimeout(hello, records.welcomeMs || 0);
        return null;
      }
      if (cmd === 'bridge_send') { frames(args instanceof Uint8Array ? args : new Uint8Array(args)); return null; }
      if (cmd === 'bridge_host') {
        const { id, name, args: a } = JSON.parse(args.frame);
        if (name === 'host.notch' && typeof a.wing === 'number' && a.wing !== wing) {
          wing = a.wing;
          if (geo) setTimeout(() => emit({ ...geo, width: tab }), 0);
        }
        try {
          return JSON.stringify({ t: 'reply', id, ok: hostValue(name, a) });
        } catch (message) {
          return JSON.stringify({ t: 'reply', id, err: { code: 'unknown', message } });
        }
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
      if (cmd === 'plugin:app|version') return '0.1.0';
      // The host's speech on this machine, when the check has one (`records.speech`, its status): `said` is the
      // helper's line for the dictation it listens to, `fed` the samples it was given, `ended` how each ended.
      if (cmd.startsWith('speech_') && records.speech) {
        const sp = window.__fake.speech;
        if (cmd === 'speech_model') {
          if (args.act === 'install') Object.assign(records.speech, { model: 'fetching', error: null });
          if (args.act === 'stop') records.speech.model = 'none';
          if (args.act === 'remove') Object.assign(records.speech, { model: 'none', have: 0, error: null });
          sp.acts.push(args.act || 'status');
          return { ...records.speech };
        }
        if (cmd === 'speech_listen') {
          if (records.speech.refuses) throw records.speech.refuses;
          Object.assign(sp, { id: args.id, languages: args.languages, channel: args.heard.id, n: 0, fed: [] });
          return null;
        }
        if (cmd === 'speech_audio') { sp.fed.push(...(args instanceof Uint8Array ? args : new Uint8Array(args))); return null; }
        if (cmd === 'speech_end') { sp.ended.push({ id: args.id, cancel: args.cancel, bytes: sp.fed.length }); return null; }
      }
      return null;
    },
  };
}

const CALLS = ['sub', 'put', 'capture', 'thought.stop', 'question.answer', 'terminal.open', 'thought.changes', 'thought.settle', 'history'];
// What the core's `route.terms` and `speech.terms` answer: the instructions are the core's own file.
/** Tasktap's own window's keys and a text field's, as the core has them (core/proto/src/keys.rs, generated into
 *  protocol.ts): the fake host refuses them as the core does (`own_key`). */
const OWN_KEYS = (() => {
  const ts = fs.readFileSync(path.join(root, 'core/proto/protocol.ts'), 'utf8');
  const table = (name) => JSON.parse(new RegExp(`export const ${name}: [^=]+= (\\[.*\\]);`).exec(ts)[1]);
  return { app: table('APP_KEYS'), field: table('FIELD_KEYS') };
})();
const TERMS = {
  route: {
    instructions: fs.readFileSync(path.join(root, 'core/src/route/instructions.md'), 'utf8'),
    // As core/src/route.rs says them (`SENDS`, `TERMS`).
    sends: [
      "the task in your words, and the project or session open in Tasktap's window",
      "up to 8 likely projects, each with its names, one line about the project, 5 earlier tasks and the folder names at the project's top",
      "the sessions in those projects, each with its name, first and last request, its agent, the agent's state, how long ago it last ran and the start of the agent's last answer",
      'your 3 most recent tasks in those sessions and how each ended',
      'a text that looks like a key, a token or a password is left out, also from the task',
    ],
    cuts: "How much of each text is sent at most: a name 100 characters, a line about a project 160, an earlier task 80, a request 180, an agent's last answer 160, a recent task 320 and how it ended 160.",
    // In Tasktap's order, as core/src/route.rs proposes it (`COSTS`): ChatGPT first, listed whether or not it is signed in.
    terms: 4,
    tools: [
      { agent: 'chatgpt', model: 'gpt-6.2-sol', pays: 'plan', ms: 4000 },
      { agent: 'claude', model: 'haiku', pays: 'plan', ms: 3700 }, { agent: 'codex', model: 'gpt-6-luna', pays: 'plan', ms: 4700 },
      { agent: 'agy', model: 'gemini-3.8-flash-low', pays: 'plan', ms: 5600 },
    ],
  },
  speech: {
    sent: [
      'The recording: what the microphone heard from the start of a dictation to its end, at most 5 minutes, as 16 kHz mono audio',
      'The name of the model', 'The languages you set as a hint, when you set any', 'Your key for that server, when one is stored',
    ],
    path: '/v1/audio/transcriptions', seconds: 300,
  },
};

/** The text size a check is run at (TEXT=small or large; the core's `text_size`), its scale from the token file, and
 *  a role's size or line height at it, in whole pixels as the page rounds them. */
const TEXT = process.env.TEXT || 'default';
const SCALE = Number((new RegExp(`data-text=${TEXT}\\]\\{--ts:([\\d.]+)`).exec(fs.readFileSync(path.join(root, 'ui/src/tokens.css'), 'utf8')) || [0, 1])[1]);
const scaled = (px) => Math.round(px * SCALE);

// A page with the fake runtime, loaded, with `sub` answered from `records`.
// `video`: Playwright's recordVideo for the context; `clock`: the page's clock held until the caller runs it; `fixed`:
// the date held while the page's timers run on; `init`: a function (or its text) run in the page before its own.
// TEXT gives every page that text size unless its records choose one; WIDTH, a workspace window that wide where the
// caller names no size. `system: 'windows'`: the page is told it runs on Windows (ui/src/system.ts reads the browser's
// own account of itself), so its keys and paths are Windows'.
/** The core's own `projects.find` (core/examples/find.rs), which the pages' fake core asks. */
const FIND = path.join(root, 'core/target/debug/examples/find');
/** Builds it, for a check that asks the list's field to find a project: what the check sees found is the core's. */
function findCore() {
  require('node:child_process').execFileSync('cargo', ['build', '-q', '--example', 'find'], { cwd: path.join(root, 'core'), stdio: 'inherit' });
  return FIND;
}
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0';
async function open(browser, { label, records = {}, viewport, dpr = 2, url, video, clock, permissions, system, fixed, init }) {
  const size = viewport || (label === 'notch' ? { width: 560, height: 520 } : { width: Number(process.env.WIDTH) || 1180, height: 760 });
  if (TEXT !== 'default' && !(records.prefs || []).some((p) => p.id === 'text_size')) records = { ...records, prefs: [...(records.prefs || []), { id: 'text_size', value: TEXT, rev: 1 }] };
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: dpr, ...(video ? { recordVideo: video } : {}), ...(permissions ? { permissions } : {}), ...(system === 'windows' ? { userAgent: WINDOWS } : {}) });
  const page = await context.newPage();
  // CPU_THROTTLE: the page runs that many times slower, through Chromium's own protocol (a slow machine).
  if (Number(process.env.CPU_THROTTLE) > 1 && browser.browserType().name() === 'chromium')
    await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.CPU_THROTTLE) });
  if (Number(process.env.SLOW_CORE) > 0 && records.lateMs === undefined) records = { ...records, lateMs: Number(process.env.SLOW_CORE) };
  if (clock) await page.clock.install();
  // `fixed`: the date the page reads, held (its timers run on); `init`: a script run before the page's own (a
  // function, or its text).
  if (fixed) await page.clock.setFixedTime(fixed);
  if (init) await page.addInitScript(typeof init === 'string' ? { content: init } : init);
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  // `projects.find`, answered by the core's own code when it is built (`findCore`).
  if (fs.existsSync(FIND)) await page.exposeFunction('__coreFind', (asked) => require('node:child_process').execFileSync(FIND, { input: `${asked}\n` }).toString());
  await page.addInitScript(fakeRuntime, { label, records, welcome: { v: VERSION, calls: CALLS }, terms: TERMS, keys: OWN_KEYS });
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
  reason: null, live: status === 'working' || status === 'needs_you', project_id: P1, session_id: id(200 + n), brief: text, route: null, placed: 'picked',
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
    id: n, name: { claude: 'Claude Code', codex: 'Codex' }[n] ?? n, program: n, supported: true, own: false, note: null, checks: true, options: [], stale: false, rev: 5, checked: NOW, installed: true, version, signed_in: true, identity: 'person@example.com', events: true, resume: true,
    permissions: 'core', questions: 'core', passes: { effort: true, model_named: false, effort_named: false },
  });
  return {
    thoughts, sessions, questions, results,
    projects: [
      { id: P1, rev: 1, name: 'tasktap', folder: '/Users/example/projects/tasktap', kind: 'folder', color: '#7aa2f7', aliases: [], git: true, isolate: 'busy', open: true, available: true },
      { id: P2, rev: 1, name: 'Scratchpad', folder: '/Users/example/Scratch', kind: 'scratch', color: '#9aa5b1', aliases: [], git: false, isolate: 'never', open: false, available: true },
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

/** Headless Chromium on the graphics card: the motion's checks time what the page does, and a software renderer's
 *  own time (a quarter of a second to build a program, milliseconds a frame) would be measured with it. */
const GPU = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
module.exports = { serve, open, findCore, fixtures, GPU, TEXT, scaled, scene: (...a) => require('./instrument-fixtures.cjs').scene(...a) };
if (require.main === module) {
  if (!process.argv[2]) { console.error('usage: node scripts/motion-pages.cjs <outdir>'); process.exit(2); }
  main(path.resolve(process.argv[2])).catch((e) => { console.error(e); process.exit(1); });
}
