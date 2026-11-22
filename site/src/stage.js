// The live notch on the site. The page beside this file is the app's own notch page (ui/dist), unchanged. This script
// stands in for what it talks to (the host and the core: scripts/motion-pages.cjs `fakeRuntime`, pasted in below by
// scripts/render-site.cjs) and holds it in one state of one task's story, on invented records, as the page around it
// (site.js) says: the first screen, a task being said with its first words heard; the task said, its words written
// down as they are heard; placed in its project; worked on, with two more agents joining; a question; the result. No
// microphone, no network, nothing stored, and nothing done by a clock of its own: the notch changes when it is told a
// new place in the story, and moves only as the app moves.
(() => {
  'use strict';
  // The keyboard stays with the page the visitor reads: nothing in here takes focus or scrolls to itself.
  HTMLElement.prototype.focus = function () {};
  // While a task is being said the app redraws its listening row every second, for the clock it shows once five
  // seconds have passed. Here the words stand for the first seconds of speaking, so that clock never shows: the redraw
  // would change nothing, and is skipped, so a page at rest does no work at all.
  let quiet = false;
  const every = window.setInterval.bind(window);
  window.setInterval = (fn, ms, ...args) => every(() => quiet || (typeof fn === 'function' ? fn(...args) : 0), ms);

  const t0 = Date.now();
  let serial = 0;
  /** A UUID v7 of a moment (by default this one): the app orders questions by id, and reads a dictation's age from it. */
  const uid = (at = Date.now()) => {
    const ms = at.toString(16).padStart(12, '0');
    return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7000-8000-${(++serial).toString(16).padStart(12, '0')}`;
  };
  const P = { cuegrid: uid(), fieldnotes: uid(), ledger: uid(), scratch: uid() };
  const project = (id, name, folder) => ({ id, rev: 1, name, folder, kind: 'folder', color: '#7aa2f7', aliases: [], git: true, isolate: 'always', open: true, available: true });
  const NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
  const agent = (id, version) => ({ id, name: NAMES[id], supported: true, own: false, note: null, checks: true, options: [], stale: false, rev: 5, checked: t0, installed: true, version, signed_in: true, identity: 'person@example.com', events: true, resume: true, permissions: 'core', questions: 'core' });
  const GLANCE = { rev: 1, working: 0, needs_you: 0, done: 0, failed: 0, question: null, retiring: false };
  const records = {
    thoughts: [], sessions: [], terminals: [], questions: [], results: [], layouts: [], devices: [], dictations: [],
    projects: [
      project(P.cuegrid, 'cuegrid', '/Users/example/projects/cuegrid'),
      project(P.fieldnotes, 'fieldnotes', '/Users/example/projects/fieldnotes'),
      project(P.ledger, 'ledger-api', '/Users/example/work/ledger-api'),
      { ...project(P.scratch, 'Scratchpad', '/Users/example/Scratch'), kind: 'scratch', git: false, isolate: 'never', open: false },
    ],
    agents: [agent('claude', '2.1.326'), agent('codex', '0.169.0'), agent('opencode', '1.4.2')],
    prefs: [
      { id: 'route_by', value: { agents: [{ agent: 'claude', model: 'haiku', on: true }], terms: 3 }, rev: 2 },
      { id: 'speech_by', value: { server: 'https://api.openai.com', model: 'gpt-transcribe' }, rev: 2 },
      { id: 'keys', value: ['https://api.openai.com'], rev: 2 },
      { id: 'speech_languages', value: ['en'], rev: 2 },
    ],
    glance: { ...GLANCE },
  };

  /*FAKE_RUNTIME*/

  const fake = window.__fake;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const TEXT = 'Make the rehearsal timer\'s digits fit on one line on phones';
  const WORDS = TEXT.split(' ');
  /** Heard on the first screen, before the story is scrolled: the first words. */
  const FIRST = 3;
  const ASK = 'The digits fit on one line if the lap list moves below them on phones. Move the list, or shrink the digits further?';
  const CHOICES = ['Move the list below', 'Shrink the digits further'];
  const SUMMARY = 'The digits scale with the screen and stay on one line down to 320 px. The lap list sits below them on phones. The desktop layout is unchanged.';
  const ROUTE = { by: 'claude', model: 'haiku', pending: false, fallback: null, quote: null, title: null, ms: 1900 };

  // ---- the story's records: one task said and followed, and two that join it, by fixed ids ----
  const T = {
    main: { thought: uid(t0 - 40e3), session: uid(), terminal: uid(), question: uid(), result: uid(), at: t0 - 40e3 },
    notes: { thought: uid(t0 - 190e3), session: uid(), terminal: uid(), result: uid(), at: t0 - 190e3 },
    ledger: { thought: uid(t0 - 420e3), session: uid(), terminal: uid(), at: t0 - 420e3 },
  };
  const OTHERS = {
    notes: { text: 'Export the field notes as Markdown, one file per day', project: P.fieldnotes, agent: 'codex', doing: 'Writing tests for the Markdown export', did: 'Ran npm test -- export',
      summary: 'Each day’s notes export to one Markdown file, with photos linked beside them.' },
    ledger: { text: 'Round invoice totals half to even, as the tax office does', project: P.ledger, agent: 'opencode', doing: 'Running cargo test' },
  };
  const thought = (k, o) => ({
    id: T[k].thought, text: k === 'main' ? TEXT : OTHERS[k].text, strokes: [], source: 'voice', mode: 'ask', phase: 'captured', status: 'captured', reason: null, live: false,
    project_id: null, session_id: null, brief: null, route: null, agent: k === 'main' ? 'claude' : OTHERS[k].agent, model: null, workdir: null, hold_until: null, read: false,
    created: T[k].at, updated: T[k].at + 20e3, ...o,
  });
  const where = (k) => (k === 'main' ? P.cuegrid : OTHERS[k].project);
  const session = (k, state, activity) => ({
    id: T[k].session, project_id: where(k), agent: k === 'main' ? 'claude' : OTHERS[k].agent, terminal_id: T[k].terminal, adopted: false, state, thought_id: T[k].thought, turn: 1,
    resume: null, name: null, named_at: null, model: null, cwd: '', exit: null, error: null, activity,
  });
  const brief = (k) => thought(k, {}).text;
  const workdir = (k, changes) => ({ path: `/Users/example/Library/Application Support/Tasktap/worktrees/${k === 'main' ? 'cuegrid-timer-digits' : 'fieldnotes-markdown-export'}`,
    branch: k === 'main' ? 'tasktap/cuegrid-timer-digits' : 'tasktap/fieldnotes-markdown-export', destination: 'main', base: '4f2a91c', left_out: false, changes,
    ...(k === 'main' ? { files: 3, insertions: 21, deletions: 6 } : { files: 4, insertions: 88, deletions: 3 }) });
  const running = (k, o) => thought(k, { phase: 'working', status: 'working', live: true, project_id: where(k), session_id: T[k].session, brief: brief(k), route: ROUTE, placed: 'model', ...o });
  const finished = (k) => thought(k, { phase: 'done', status: 'done', project_id: where(k), session_id: T[k].session, brief: brief(k), route: ROUTE, placed: 'model', workdir: workdir(k, 'pending'), updated: t0 - 5e3 });

  /** What the core holds at a place in the story (`p`, 0 to 1, how far into its chapter), and how the notch is open:
   *  folded; opened by the shortcut on the capture line; opened by the pointer resting on it; or by a question. */
  function scene(step, p) {
    const s = { thoughts: [], sessions: [], questions: [], results: [], dictations: [], glance: {}, open: 'closed', heard: 0 };
    const others = (n, state) => {
      for (const k of ['notes', 'ledger'].slice(0, n)) {
        s.thoughts.push(state === 'done' && k === 'notes' ? finished(k) : running(k));
        s.sessions.push(session(k, state === 'done' && k === 'notes' ? 'idle' : 'working', [state === 'done' && k === 'notes' ? OTHERS[k].did : OTHERS[k].doing]));
        if (state === 'done' && k === 'notes') s.results.push({ id: T.notes.result, thought_id: T.notes.thought, session_id: T.notes.session, turn: 1, kind: 'changes', summary: OTHERS.notes.summary });
      }
    };
    if (step === 'rest' || step === 'say') {
      // The words come as they are heard: the first ones on the first screen, all of them by the chapter's middle.
      s.open = 'capture';
      s.heard = step === 'rest' ? FIRST : Math.max(FIRST, Math.min(WORDS.length, FIRST + Math.round(((p - 0.04) / 0.36) * (WORDS.length - FIRST))));
      s.dictations.push({ id: dictation(), rev: 0, phase: 'recording', text: WORDS.slice(0, s.heard).join(' '), level: s.heard ? 38 : 12, target: { kind: 'thought' }, error: null });
    } else if (step === 'place') {
      // Sent: placed by a small model while the place reads Auto, then where it goes by name, with Undo.
      s.open = 'capture';
      s.thoughts.push(p < 0.2
        ? thought('main', { route: { ...ROUTE, pending: true, ms: null } })
        : thought('main', { phase: 'routed', status: 'routed', project_id: P.cuegrid, brief: TEXT, route: ROUTE, placed: 'model' }));
    } else if (step === 'work') {
      // The agent works on it; a second and a third task join, each its agent's ring.
      s.open = 'hover';
      const n = p < 0.16 ? 0 : p < 0.34 ? 1 : 2;
      s.thoughts.push(running('main'));
      s.sessions.push(session('main', 'working', ['Read src/rehearsal/Timer.tsx', ...(n ? ['Checking the layout at 390 px'] : [])]));
      others(n, 'working');
      s.glance = { working: 1 + n };
    } else if (step === 'ask') {
      // The agent asks: the question opens the notch by itself, in full, its answers on the keys 1 and 2.
      s.open = 'ask';
      s.thoughts.push(running('main', { status: 'needs_you' }));
      s.sessions.push(session('main', 'working', ['Checking the layout at 390 px']));
      s.questions.push({ id: T.main.question, thought_id: T.main.thought, session_id: T.main.session, turn: 1, source: 'agent', prompt: ASK, detail: null, reply_via: 'core', state: 'open', answer: null, kind: 'choice', choices: CHOICES });
      others(2, 'working');
      s.glance = { working: 2, needs_you: 1, question: T.main.question };
    } else if (step === 'result') {
      // Answered and done: the result with what changed, to keep or discard; then a second task settles too.
      s.open = 'hover';
      s.thoughts.push(finished('main'));
      s.sessions.push(session('main', 'idle', ['Ran npm test -- rehearsal']));
      s.results.push({ id: T.main.result, thought_id: T.main.thought, session_id: T.main.session, turn: 1, kind: 'changes', summary: SUMMARY });
      others(2, p < 0.36 ? 'working' : 'done');
      s.glance = p < 0.36 ? { working: 2, done: 1 } : { working: 1, done: 2 };
    }
    return s;
  }
  /** The dictation's id. The notch reads from it how long the person has spoken and shows that after five seconds;
   *  the scene stands for the first seconds, so the id is dated a day ahead and the clock never shows. */
  let spoken = '';
  const dictation = () => (spoken ||= uid(Date.now() + 864e5));

  // ---- bringing the notch to a scene: the records changed in one go, the notch opened the way the scene says ----
  let rev = 1000;
  const held = new Map(); // what the notch was last given, by collection and id
  function give(s) {
    const sets = [];
    for (const c of ['thoughts', 'sessions', 'questions', 'results', 'dictations']) {
      const want = new Map(s[c].map((r) => [r.id, r]));
      const del = [...held.keys()].filter((key) => key.startsWith(c + ':') && !want.has(key.slice(c.length + 1))).map((key) => key.slice(c.length + 1));
      const put = [];
      for (const [id, r] of want) {
        const text = JSON.stringify(r);
        if (held.get(`${c}:${id}`) !== text) (held.set(`${c}:${id}`, text), put.push(r));
      }
      for (const id of del) held.delete(`${c}:${id}`);
      // A question goes before what it was about changes, so the notch never shows a question about nothing.
      if (del.length) sets.push({ c, del });
      if (put.length) sets.push({ c, put });
    }
    const g = JSON.stringify(s.glance);
    if (held.get('glance') !== g) (held.set('glance', g), sets.push({ c: 'glance', put: [(records.glance = { ...GLANCE, ...s.glance })] }));
    if (!sets.length) return;
    rev++;
    for (const set of sets) if (set.put) set.put = set.put.map((r) => ({ ...r, rev }));
    fake.push({ t: 'change', rev, sets });
  }

  const tab = () => document.getElementById('tab');
  const isOpen = () => tab()?.getAttribute('aria-expanded') === 'true';
  const talk = () => window.__speech?.talk;
  /** The page's own state of speaking: a spoken new thought into the notch's capture line, whose words the core
   *  reports as they are heard (as speech on the Mac itself does). No microphone: the words are the scene's. */
  function speaking(on) {
    const t = talk();
    if (!t) return;
    if (on) Object.assign(t, { id: dictation(), kind: 'thought', field: null, local: true });
    else if (t.id) Object.assign(t, { id: '', kind: '', field: null });
    if (!on) spoken = '';
  }

  // One state is wanted: the one the page last asked for. The notch is brought to it a scene at a time, each scene
  // played to its end with the app's own motion (its sheet opening and folding takes this long); when a scene ends
  // and the page wants another by then, that one follows. Nothing is skipped because of what was asked before: what
  // counts is the state the notch stands in and the one wanted.
  let mode = 'closed', wanted = { step: 'rest', p: 0 }, busy = false, shown = '';
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const until = async (test) => {
    for (let i = 0; i < 40 && !test(); i++) await wait(25);
  };
  async function fold() {
    if (isOpen()) tab().click();
    fake.emit({ do: 'hover-exit' });
    mode = 'closed';
    await wait(reduce.matches ? 30 : 320);
  }
  const keyOf = (s) => JSON.stringify([s.open, s.heard, s.thoughts.length, s.questions.length, s.results.length, s.thoughts.map((t) => t.status + t.phase)]);
  function want(step, p) {
    wanted = { step, p };
    if (!busy) void drive();
  }
  async function drive() {
    busy = true;
    try {
      for (;;) {
        const w = wanted, s = scene(w.step, w.p), key = keyOf(s);
        // Standing where it is wanted already: said again, for the page counts the notch at rest by its word.
        if (key === shown) {
          tell(w.step);
          break;
        }
        // On its way: the notch stands in no told state until the scene has ended.
        shown = '';
        await play(s);
        shown = key;
        tell(w.step);
      }
    } finally {
      busy = false;
    }
  }
  /** One scene: the records changed in one go, the notch opened the way the scene says. */
  async function play(s) {
    quiet = !!s.dictations.length;
    if (s.open !== 'capture' || !s.dictations.length) speaking(false);
    if (s.open === 'closed') {
      if (mode !== 'closed') await fold();
      give(s);
    } else if (s.open === 'capture') {
      if (mode !== 'capture' && mode !== 'closed') await fold();
      if (s.dictations.length) speaking(true);
      give(s);
      if (mode !== 'capture') {
        fake.emit({ do: 'capture' });
        mode = 'capture';
        // Told once the notch has opened (tokens.css --t-notch-open), so the page shows it only as it then stands.
        await wait(reduce.matches ? 60 : 620);
      }
    } else if (s.open === 'hover') {
      // The work goes on in the notch that is open; a question or a result needs the notch opened by the pointer.
      const result = s.results.some((r) => r.thought_id === T.main.thought);
      if (mode === 'ask' || (mode === 'capture' && result)) await fold();
      give(s);
      if (mode === 'closed') {
        await wait(40);
        fake.emit({ do: 'hover-enter' });
        mode = 'hover';
        await wait(reduce.matches ? 60 : 620);
      }
    } else if (s.open === 'ask') {
      // Folded first, so the question opens the notch by itself, as it does. The pointer rests on the notch, as a
      // reader's would: the notch does not fold a question by itself while it is under the pointer.
      if (mode !== 'ask' && mode !== 'closed') await fold();
      fake.emit({ do: 'hover-enter' });
      give(s);
      mode = 'ask';
      // As it is once ⌃⌥J has gone to it: the keyboard in the question, its answers' keys shown (page.ts markHeld).
      await until(() => document.querySelector('#sheet [data-question]'));
      for (const el of document.querySelectorAll('#sheet [data-keys]')) el.setAttribute('data-held', '');
    }
  }
  /** The page is told each state the notch has come to stand in, by its chapter. */
  const tell = (step) => parent !== window && parent.postMessage({ tasktap: 'stage', step, open: isOpen() }, location.origin);

  // ---- the host's part: where the notch is and how wide its sheet may be ----
  const geometry = () => fake.emit({ do: 'geometry', width: 120, height: 20, cutout: false, compact: false, surfaceWidth: Math.min(420, innerWidth - 8), surfaceOffset: 0, span: innerWidth,
    pixel: devicePixelRatio || 1, corner: 10, offset: 0, available: innerHeight - 20, collapsed: false });
  addEventListener('resize', geometry);

  addEventListener('message', (e) => {
    const m = e.data;
    if (e.origin !== location.origin || !m || m.tasktap !== 'page') return;
    if (m.do === 'scene') want(m.step, m.p ?? 1);
    // Out of sight or the tab hidden, what loops in here (a working ring) stands still too.
    else if (m.do === 'hold') document.documentElement.toggleAttribute('data-held', !!m.held);
  });

  // The app's page is up once its tab is, and has its records once the core's first answer is in: say so, and wait to
  // be told where in the story to stand. `?show=step` stands there at once, for the pictures (render-site.cjs).
  const up = setInterval(() => {
    if (!tab() || !talk()) return;
    clearInterval(up);
    geometry();
    document.documentElement.style.background = 'transparent';
    const q = new URLSearchParams(location.search);
    setTimeout(() => {
      if (q.has('show')) want(q.get('show'), 1);
      if (parent !== window) parent.postMessage({ tasktap: 'stage', ready: true }, location.origin);
    }, 60);
  }, 30);
})();
