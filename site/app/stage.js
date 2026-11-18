// The live notch on the site. The page beside this file is the app's own notch page (ui/dist), unchanged. This script
// stands in for what it talks to (the host and the core: scripts/motion-pages.cjs `fakeRuntime`, pasted in below by
// scripts/render-site.cjs) and walks it through one thought's life on invented records: said, placed with its brief,
// working, a question, a result with Keep. No microphone, no network, nothing stored. The page around it (site.js)
// says when to play and is told which step is on.
(() => {
  'use strict';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  // The keyboard stays with the page the visitor reads: nothing in here takes focus or scrolls to itself.
  HTMLElement.prototype.focus = function () {};

  const t0 = Date.now();
  let serial = 0;
  /** A UUID v7 of this moment: the app orders questions by id. */
  const uid = () => {
    const ms = Date.now().toString(16).padStart(12, '0');
    return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7000-8000-${(++serial).toString(16).padStart(12, '0')}`;
  };
  const P = { cuegrid: uid(), fieldnotes: uid(), ledger: uid(), scratch: uid() };
  const project = (id, name, folder) => ({ id, rev: 1, name, folder, kind: 'folder', color: '#7aa2f7', aliases: [], git: true, isolate: 'always', open: true, available: true });
  const agent = (id, version) => ({ id, rev: 5, checked: t0, installed: true, version, signed_in: true, identity: 'person@example.com', events: true, resume: true, permissions: 'core', questions: 'core' });
  const GLANCE = { rev: 1, working: 0, needs_you: 0, done: 0, failed: 0, question: null, retiring: false };
  const records = {
    thoughts: [], sessions: [], terminals: [], questions: [], results: [], layouts: [], devices: [], dictations: [],
    projects: [
      project(P.cuegrid, 'cuegrid', '/Users/example/projects/cuegrid'),
      project(P.fieldnotes, 'fieldnotes', '/Users/example/projects/fieldnotes'),
      project(P.ledger, 'ledger-api', '/Users/example/work/ledger-api'),
      { ...project(P.scratch, 'Scratch', '/Users/example/Scratch'), kind: 'scratch', git: false, isolate: 'never', open: false },
    ],
    agents: [agent('claude', '2.1.326'), agent('codex', '0.169.0')],
    prefs: [
      { id: 'route_by', value: { agent: 'claude', model: 'haiku' }, rev: 2 },
      { id: 'speech_by', value: { server: 'https://api.openai.com', model: 'gpt-transcribe' }, rev: 2 },
      { id: 'keys', value: ['https://api.openai.com'], rev: 2 },
      { id: 'speech_languages', value: ['en'], rev: 2 },
    ],
    glance: { ...GLANCE },
  };

  (function fakeRuntime({ label, records: records0, welcome, terms }) {
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
  const heard = {};
  const toStream = (s, text) => {
    const p = enc.encode(text), out = new Uint8Array(9 + p.length);
    new DataView(out.buffer).setUint32(0, p.length + 5, true);
    out[4] = 1;
    new DataView(out.buffer).setUint32(5, s, true);
    out.set(p, 9);
    callbacks.get(channel)({ index: index++, message: out.buffer });
  };
  const calls = [];
  const answer = (call) => {
    const { id, name, args } = call;
    calls.push(name);
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
    // The history the scene has (`history`), as one page; then, or with none, the empty page that is its end.
    if (name === 'history') return reply(id, (!args.before && records.history) || { thoughts: [], questions: [], results: [] });
    // What a model that places thoughts and a speech service are sent, as the core says it.
    if (name === 'route.terms') return reply(id, { ...terms.route, tools: records.tools || terms.route.tools });
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
    if (name === 'dictation.start') {
      const s = nextStream++;
      heard[s] = { id: args.id, bytes: [], peak: 0, since: 0 };
      row({ id: args.id, phase: 'recording', text: '', level: 0, target: args.target, error: null });
      return reply(id, { stream: { s, credit: 9600000 }, seconds: 300 });
    }
    if (name === 'dictation.finish') {
      const d = dictation(args.id), said = records.hears || { text: 'Make the header stay on one line' };
      row({ ...d, phase: 'transcribing', level: 0 });
      setTimeout(() => {
        if (!dictation(args.id)) return;
        if (said.error) return row({ ...d, phase: 'failed', level: 0, text: said.text || '', error: said.error });
        if (d.target.kind === 'text') return row({ ...d, phase: 'heard', level: 0, text: said.text });
        row(d, true);
        const now = Date.now();
        push({ t: 'change', rev: ++rev, sets: [{ c: 'thoughts', put: [{ id: d.target.id, rev, text: said.text, strokes: [], source: 'voice', mode: 'ask', phase: 'routed', status: 'routed', reason: null, live: false,
          project_id: d.target.project_id || ((records.projects || [])[0] || {}).id || null, session_id: null, brief: said.brief || said.text, route: said.route || null, placed: said.placed || (d.target.project_id ? 'picked' : 'name'), agent: d.target.agent || 'claude', model: null, workdir: null,
          hold_until: now + 5000, read: false, created: now, updated: now }] }] });
      }, said.ms || 600);
      return reply(id, null);
    }
    if (name === 'dictation.cancel') return dictation(args.id) && row(dictation(args.id), true), reply(id, null);
    // `hold`: a capture is never answered, so the field stays as it is while a thought is on its way.
    if (name === 'thought.capture') window.__fake.sent = args;
    if (name === 'thought.capture' && records.hold) return;
    // `slow`: a capture is answered that many milliseconds later, as a core that is far away or busy answers;
    // `refuse`: with that refusal.
    if (name === 'thought.capture' && (records.slow || records.refuse)) return void setTimeout(() => (records.refuse ? toCore({ t: 'reply', id, err: { code: 'failed', message: records.refuse } }) : reply(id, null)), records.slow || 0);
    // A thought saved for later is kept as the core keeps it, so the page can show where it landed.
    if (name === 'thought.capture' && args.mode === 'note') {
      rev++;
      push({ t: 'change', rev, sets: [{ c: 'thoughts', put: [{ id: args.id, rev, text: args.text, strokes: [], source: 'typed', mode: 'note', phase: 'captured', status: 'captured',
        reason: null, live: false, project_id: null, session_id: null, brief: args.text, route: null, placed: 'kept', agent: null, model: null, workdir: null, hold_until: null, read: false, created: Date.now(), updated: Date.now() }] }] });
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
  const hostValue = (name, a) => {
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
  window.__fake = { emit, push, records, heard, calls, close, opened };
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
        if (name === 'host.notch' && typeof a.wing === 'number' && a.wing !== wing) {
          wing = a.wing;
          if (geo) setTimeout(() => emit({ ...geo, width: tab }), 0);
        }
        return JSON.stringify({ t: 'reply', id, ok: hostValue(name, a) });
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
})({ label: 'notch', records, welcome: { v: 1, calls: ['sub', 'put', 'capture', 'thought.stop', 'question.answer', 'terminal.open', 'thought.changes', 'thought.settle', 'history'] }, terms: { route: { instructions: '', sends: [], tools: [{ agent: 'claude', model: 'haiku' }] }, speech: { sent: [], path: '/v1/audio/transcriptions', seconds: 300 } } });

  const fake = window.__fake;
  const TEXT = 'Make the rehearsal timer\'s digits fit on one line on phones';
  const ASK = 'The digits fit on one line if the lap list moves below them on phones. Move the list, or shrink the digits further?';
  const CHOICES = ['Move the list below', 'Shrink the digits further'];
  const SUMMARY = 'The digits scale with the screen and stay on one line down to 320 px. The lap list sits below them on phones. The desktop layout is unchanged.';
  const ROUTE = { by: 'claude', model: 'haiku', pending: false, fallback: null, quote: null, title: null, ms: 1900 };

  let rev = 1000;
  const change = (...sets) => fake.push({ t: 'change', rev: ++rev, sets: sets.filter(Boolean) });
  const put = (c, ...rows) => ({ c, put: rows.map((r) => ({ ...r, rev })) });
  const del = (c, ...ids) => ({ c, del: ids });
  const glance = (o) => ({ c: 'glance', put: [(records.glance = { ...GLANCE, ...o, rev })] });

  // One thought, as the core would keep it at each step. Typed in the page, its id is the page's own.
  let ids = null;
  const fresh = (id) => (ids = { thought: id || uid(), session: uid(), terminal: uid(), question: null, result: uid(), at: Date.now() });
  const thought = (o) => ({
    id: ids.thought, text: TEXT, strokes: [], source: 'typed', mode: 'ask', phase: 'captured', status: 'captured', reason: null, live: false, project_id: null, session_id: null,
    brief: null, route: null, agent: 'claude', model: null, workdir: null, hold_until: null, read: false, created: ids.at, updated: Date.now(), ...o,
  });
  const session = (state, activity) => ({
    id: ids.session, project_id: P.cuegrid, agent: 'claude', terminal_id: ids.terminal, adopted: false, state, thought_id: ids.thought, turn: 1, resume: null, name: null, named_at: null,
    model: null, cwd: '', exit: null, error: null, activity,
  });
  const held = (ms) => thought({ phase: 'routed', status: 'routed', project_id: P.cuegrid, brief: TEXT, route: ROUTE, hold_until: Date.now() + ms });
  const running = (o) => thought({ phase: 'working', status: 'working', live: true, project_id: P.cuegrid, session_id: ids.session, brief: TEXT, route: ROUTE, ...o });
  const workdir = (changes) => ({ path: '/Users/example/Library/Application Support/Tasktap/worktrees/cuegrid-timer-digits', branch: 'tasktap/cuegrid-timer-digits', destination: 'main', base: '4f2a91c',
    left_out: false, changes, files: 3, insertions: 21, deletions: 6 });
  const finished = (o) => thought({ phase: 'done', status: 'done', project_id: P.cuegrid, session_id: ids.session, brief: TEXT, route: ROUTE, workdir: workdir('pending'), ...o });
  const question = () => ({ id: ids.question, thought_id: ids.thought, session_id: ids.session, turn: 1, source: 'agent', prompt: ASK, detail: null, reply_via: 'core', state: 'open', answer: null, kind: 'choice', choices: CHOICES });
  const result = () => ({ id: ids.result, thought_id: ids.thought, session_id: ids.session, turn: 1, kind: 'changes', summary: SUMMARY });

  // ---- the clock: it runs only while the page says play, and a new start ends what was running ----
  const STOP = Symbol('stop');
  let run = 0, playing = false, waiting = [];
  async function wait(ms, g) {
    let left = ms;
    while (left > 0) {
      if (g !== run) throw STOP;
      if (!playing) { await new Promise((ok) => waiting.push(ok)); continue; }
      const at = performance.now();
      await new Promise((ok) => setTimeout(ok, Math.min(left, 80)));
      left -= performance.now() - at;
    }
    if (g !== run) throw STOP;
  }
  const play = (on) => {
    playing = on;
    document.documentElement.toggleAttribute('data-held', !on);
    if (on) waiting.splice(0).forEach((ok) => ok());
  };

  const tell = (step, motion) => parent !== window && parent.postMessage({ tasktap: 'stage', step, motion }, location.origin);
  const tab = () => document.getElementById('tab');
  const isOpen = () => tab()?.getAttribute('aria-expanded') === 'true';
  const key = (target, k) => target?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  /** A key cap going down, as it does under a finger (parts.css, the pressed state). */
  const press = async (cap, g) => {
    if (!cap) return;
    cap.style.cssText = 'transform:translateY(1px);box-shadow:var(--key-down);filter:brightness(.93)';
    await wait(reduce.matches ? 0 : 170, g);
    cap.style.cssText = '';
  };

  /** Back to nothing running, folded. */
  async function clear(g) {
    if (isOpen()) tab().click();
    fake.emit({ do: 'hover-exit' });
    const gone = [];
    if (ids) {
      gone.push(del('thoughts', ids.thought), del('sessions', ids.session), del('results', ids.result));
      if (ids.question) gone.push(del('questions', ids.question));
    }
    change(...gone, glance({}));
    ids = null;
    typed(0);
    tell('rest', 'idle');
    await wait(reduce.matches ? 0 : 420, g);
  }

  /** The thought typed into the capture line, a key at a time, as far as `n` letters. */
  const typed = (n) => {
    const area = document.getElementById('capture-input');
    if (!area) return;
    area.value = TEXT.slice(0, n);
    area.dispatchEvent(new InputEvent('input', { bubbles: true }));
  };
  /** Return in the capture line: the page sends the thought to the core, under an id of its own. */
  async function sendIt(g) {
    fake.sent = null;
    key(document.getElementById('capture-input'), 'Enter');
    for (let i = 0; i < 40 && !fake.sent; i++) await wait(25, g);
    fresh(fake.sent?.id);
  }

  const steps = {
    // Put in: the shortcut opens the notch on the capture line; the thought is typed, and Return sends it.
    async say(g) {
      fake.emit({ do: 'capture' });
      tell('say', 'idle');
      await wait(800, g);
      for (let n = 1; n <= TEXT.length; n++) {
        typed(n);
        await wait(TEXT[n - 1] === ' ' ? 95 : 38 + ((n * 37) % 29), g);
      }
      await wait(650, g);
      await press(document.querySelector('#sheet .cap-row .key'), g);
      await sendIt(g);
      tell('say', 'thinking');
      change(put('thoughts', thought({ route: { ...ROUTE, pending: true, ms: null } })));
      await wait(1300, g);
    },
    // Placed: it shows where it goes and waits a few seconds, the lit line running out, Undo beside it.
    async place(g, from) {
      if (from) {
        fake.emit({ do: 'capture' });
        await wait(620, g);
        typed(TEXT.length);
        await wait(120, g);
        await sendIt(g);
      }
      const hold = 5200;
      change(put('thoughts', held(hold)));
      tell('place', 'thinking');
      await wait(hold, g);
    },
    // Started: the person's own agent works on it; the notch folds and says so in a count.
    async work(g, from) {
      if (from) fresh();
      change(put('thoughts', running({})), put('sessions', session('working', ['Read src/rehearsal/Timer.tsx'])), glance({ working: 1 }));
      tell('work', 'working');
      await wait(from ? 300 : 1100, g);
      if (isOpen()) tab().click();
      await wait(1600, g);
      change(put('sessions', session('working', ['Read src/rehearsal/Timer.tsx', 'Checking the layout at 390 px'])));
      await wait(1700, g);
    },
    // It needs an answer: the notch opens by itself with the question in full.
    async ask(g, from) {
      if (from) {
        fresh();
        change(put('thoughts', running({})), put('sessions', session('working', ['Checking the layout at 390 px'])), glance({ working: 1 }));
        await wait(900, g);
      }
      ids.question = uid();
      change(put('questions', question()), put('thoughts', running({ status: 'needs_you' })), glance({ needs_you: 1, question: ids.question }));
      tell('ask', 'needs');
      await wait(5600, g);
      await press(document.querySelector('#sheet [data-question] .ans kbd'), g);
      key(document.querySelector('#sheet [data-question]'), '1');
      answered();
      await wait(3000, g);
    },
    // A result: its changes come back to keep or discard.
    async result(g, from) {
      if (from) {
        fresh();
        change(put('thoughts', running({})), put('sessions', session('working', ['Running the tests'])), glance({ working: 1 }));
        await wait(1100, g);
      }
      change(put('thoughts', finished({})), put('sessions', session('idle', ['Ran npm test -- rehearsal'])), put('results', result()), glance({ done: 1 }));
      tell('result', 'done');
      await wait(1500, g);
      fake.emit({ do: 'hover-enter' });
      await wait(5600, g);
      await press(document.querySelector('#sheet .result .act kbd'), g);
      key(document.querySelector('#sheet .result'), 'Enter');
      await wait(2400, g);
      change(put('thoughts', finished({ read: true, workdir: workdir('kept') })), glance({}));
      fake.emit({ do: 'hover-exit' });
      tell('rest', 'idle');
      await wait(3400, g);
    },
  };
  const ORDER = ['say', 'place', 'work', 'ask', 'result'];

  /** An answer was given, by the walk-through's key or the visitor's: the question is closed and the work goes on. */
  function answered() {
    if (!ids?.question) return;
    change(del('questions', ids.question), put('thoughts', running({})), put('sessions', session('working', ['Edit src/rehearsal/timer.css'])), glance({ working: 1 }));
    ids.question = null;
    tell('work', 'working');
  }

  /** Plays from a step, on and round. */
  async function from(step) {
    const g = ++run;
    try {
      await clear(g);
      await wait(step === 'say' ? 900 : 200, g);
      for (let i = ORDER.indexOf(step), first = true; ; i = (i + 1) % ORDER.length, first = false) {
        if (i === 0 && !first) {
          await clear(g);
          await wait(1200, g);
        }
        await steps[ORDER[i]](g, first && i > 0);
      }
    } catch (e) {
      if (e !== STOP) throw e;
    }
  }
  /** A step as a fixed picture, for Reduce Motion: nothing plays by itself. */
  async function show(step) {
    const g = ++run;
    playing = true;
    try {
      await clear(g);
      fresh();
      if (step === 'say') {
        fake.emit({ do: 'capture' });
        await wait(60, g);
        typed(TEXT.length);
      } else if (step === 'place') {
        fake.emit({ do: 'capture' });
        change(put('thoughts', held(36e5)));
      } else if (step === 'work') change(put('thoughts', running({})), put('sessions', session('working', ['Checking the layout at 390 px'])), glance({ working: 1 }));
      else if (step === 'ask') {
        ids.question = uid();
        change(put('questions', question()), put('thoughts', running({ status: 'needs_you' })), put('sessions', session('working', ['Checking the layout at 390 px'])), glance({ needs_you: 1, question: ids.question }));
      } else if (step === 'result') {
        change(put('thoughts', finished({})), put('sessions', session('idle', ['Ran npm test -- rehearsal'])), put('results', result()), glance({ done: 1 }));
        fake.emit({ do: 'hover-enter' });
      }
      tell(step, { say: 'idle', place: 'thinking', work: 'working', ask: 'needs', result: 'done', rest: 'idle' }[step]);
    } catch (e) {
      if (e !== STOP) throw e;
    }
  }

  // ---- the host's part: where the notch is and how wide its sheet may be ----
  const geometry = () => fake.emit({ do: 'geometry', width: 120, height: 20, cutout: false, compact: false, surfaceWidth: Math.min(420, innerWidth - 8), surfaceOffset: 0, span: innerWidth,
    pixel: devicePixelRatio || 1, corner: 10, offset: 0, available: innerHeight - 20, collapsed: false });
  addEventListener('resize', geometry);

  addEventListener('message', (e) => {
    const m = e.data;
    if (e.origin !== location.origin || !m || m.tasktap !== 'page') return;
    if (m.do === 'play') (play(true), run === 0 && void from('say'));
    else if (m.do === 'hold') play(false);
    else if (m.do === 'from') (play(true), void (reduce.matches ? show(m.step) : from(m.step)));
    else if (m.do === 'show') void show(m.step);
  });

  // The app's page is up once its tab is: say so, and wait to be told to play.
  const up = setInterval(() => {
    if (!tab()) return;
    clearInterval(up);
    geometry();
    // Open or folded, said to the page as it changes: the chrome behind an open sheet steps back.
    new MutationObserver(() => parent !== window && parent.postMessage({ tasktap: 'stage', open: isOpen() }, location.origin)).observe(tab(), { attributes: true, attributeFilter: ['aria-expanded'] });
    document.documentElement.style.background = 'transparent';
    setTimeout(() => parent !== window && parent.postMessage({ tasktap: 'stage', ready: true }, location.origin), 60);
    const q = new URLSearchParams(location.search);
    if (q.has('show')) void show(q.get('show'));
    else if (q.has('play')) (play(true), void from(q.get('play') || 'say'));
  }, 30);
})();
