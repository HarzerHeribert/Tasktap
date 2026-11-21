// Fixture records for rendering the Instrument pages without the host (motion-pages.cjs serves them): the four
// states of Home (busy, normal, quiet, first run), and a workspace with two splits, several tabs, real-looking terminal
// text, a long question with three choices, a question only its terminal can answer, and a result with changes
// waiting. Invented projects and people only. `scene(name, {now, changes})` returns the records for one page.
const MIN = 60000;
let serial = 0;
/** A UUID v7 made `ago` milliseconds before `now`. */
const uid = (now, ago = 0) => {
  const ms = Math.round(now - ago).toString(16).padStart(12, '0');
  const tail = (++serial).toString(16).padStart(12, '0');
  return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7000-8000-${tail}`;
};
const E = (codes, text) => `\x1b[${codes}m${text}\x1b[0m`;
const dim = (t) => E('2', t), bold = (t) => E('1', t), green = (t) => E('32', t), red = (t) => E('31', t), yellow = (t) => E('33', t),
  blue = (t) => E('34', t), magenta = (t) => E('35', t), cyan = (t) => E('36', t), orange = (t) => E('38;5;209', t);

const screens = {
  timer: [
    `${orange('✻')} ${bold('Claude Code')} ${dim('v2.1.326 · ~/projects/cuegrid')}`,
    '',
    `${dim('>')} ${bold('Make the rehearsal timer readable on mobile.')}`,
    `  ${bold('Keep the keyboard shortcuts.')}`,
    '',
    `${'●'} I'll check how the digits are sized, then adjust them`,
    '  for narrower screens.',
    '',
    `${green('●')} ${bold('Read')}(src/rehearsal/Timer.tsx)`,
    `  ${dim('⎿  Read 142 lines')}`,
    '',
    `${green('●')} ${bold('Update')}(src/rehearsal/timer.css)`,
    `  ${dim('⎿  Updated with 3 additions and 2 removals')}`,
    `     ${dim('41')}   .timer__digits {`,
    `     ${E('48;5;52', '42 -   font-size: 96px;                       ')}`,
    `     ${E('48;5;52', '43 -   letter-spacing: -2px;                  ')}`,
    `     ${E('48;5;22', '42 +   font-size: clamp(56px, 22vw, 128px);   ')}`,
    `     ${E('48;5;22', '43 +   font-variant-numeric: tabular-nums;    ')}`,
    `     ${E('48;5;22', '44 +   letter-spacing: -0.03em;               ')}`,
    `     ${dim('45')}   }`,
    '',
    `${green('●')} ${bold('Bash')}(npm test -- rehearsal)`,
    `  ${dim('⎿')}  ${green('✓')} Timer.test.tsx ${dim('(7 tests) 412ms')}`,
    `     ${green('✓')} keys.test.ts ${dim('(4 tests) 38ms')}`,
    `     Tests  ${E('1;32', '11 passed')} ${dim('(11)')}`,
    '',
    `${orange('✻ Checking the layout at 390 px…')} ${dim('(1m 42s · ↓ 3.1k tokens)')}`,
  ].join('\n'),
  git: [
    `${blue('cuegrid')} ${magenta('main')} ${yellow('⇡1')} ${green('❯')} git log --oneline --graph -7`,
    `* ${yellow('4f2a91c')} ${yellow('(')}${E('1;36', 'HEAD -> ')}${E('1;32', 'main')}${yellow(')')} Clamp timer digits on narrow screens`,
    `* ${yellow('b81d0e7')} Space pauses, R resets`,
    `*   ${yellow('9c3e5a2')} Merge branch 'export-pdf'`,
    `${red('|')}${green('\\')}`,
    `${red('|')} * ${yellow('1d7f6b0')} Export the cue sheet as PDF`,
    `${red('|')} * ${yellow('e02c4d8')} Paginate cues by scene`,
    `${red('|')}${green('/')}`,
    `* ${yellow('77aa3f1')} Fix drift when the tab sleeps`,
    `* ${yellow('3b9c210')} ${yellow('(')}${E('1;31', 'origin/main')}${yellow(')')} Rehearsal 04: opening notes`,
    `${blue('cuegrid')} ${magenta('main')} ${yellow('⇡1')} ${green('❯')} git status -sb`,
    `${green('## main')}...${red('origin/main')} [ahead 1]`,
    ` ${red('M')} src/rehearsal/timer.css`,
    `${red('??')} notes/rehearsal-05.md`,
    `${blue('cuegrid')} ${magenta('main')} ${yellow('⇡1')} ${green('❯')} `,
  ].join('\n'),
  dev: [
    `${blue('cuegrid')} ${magenta('main')} ${green('❯')} npm run dev`,
    '',
    `  ${E('1;32', 'VITE')} ${green('v7.0.4')}  ready in ${bold('412')} ms`,
    '',
    `  ${green('➜')}  ${bold('Local')}:   ${cyan('http://localhost:5173/')}`,
    // A hyperlink the program prints itself (OSC 8): its words are not its address.
    `  ${green('➜')}  ${bold('Preview')}: \x1b]8;;https://preview.cuegrid.example/rehearsal-05\x07the shared preview\x1b]8;;\x07`,
    `  ${dim('➜  Network: use --host to expose')}`,
    `  ${dim('➜  press h + enter to show help')}`,
    '',
    `${dim('15:40:12')} ${cyan('[vite]')} ${green('hmr update')} ${dim('/src/rehearsal/timer.css')}`,
    `${dim('15:41:03')} ${cyan('[vite]')} ${green('hmr update')} ${dim('/src/rehearsal/Timer.tsx')}`,
  ].join('\n'),
  export: [
    `${orange('✻')} ${bold('Claude Code')} ${dim('v2.1.326 · ~/projects/cuegrid')}`,
    '',
    `${dim('>')} ${bold('Fix the flaky export test')}`,
    '',
    `${green('●')} ${bold('Bash')}(npm test -- export, 20 times)`,
    `  ${dim('⎿')}  ${red('3 failed')}: names the file by date`,
    `      expected ${green('"cues-2026-11-17.pdf"')}`,
    `      received ${red('"cues-2026-11-18.pdf"')}`,
    '',
    `${'●'} The test builds its expected name from ${cyan('new Date()')} while the`,
    '  exporter reads the clock a moment later, so a run that crosses',
    '  midnight in UTC fails.',
  ].join('\n'),
  pdf: [
    `${orange('✻')} ${bold('Claude Code')} ${dim('v2.1.326 · ~/projects/cuegrid')}`,
    '',
    `${dim('>')} ${bold('Export the cue sheet as PDF')}`,
    '',
    `${green('●')} ${bold('Write')}(src/export/pdf.ts)`,
    `  ${dim('⎿  Wrote 118 lines')}`,
    `${green('●')} ${bold('Update')}(src/menu.ts)`,
    `  ${dim('⎿  Updated with 9 additions')}`,
    `${green('●')} ${bold('Bash')}(npm test)`,
    `  ${dim('⎿')}  Tests  ${E('1;32', '64 passed')} ${dim('(64)')}`,
    '',
    `${'●'} The cue sheet exports as PDF from the File menu and with ⌘E.`,
    '  Cues paginate by scene, 28 to a page.',
    '',
    `${dim('>')} `,
  ].join('\n'),
  trust: [
    `${orange('✻')} ${bold('Claude Code')} ${dim('v2.1.326')}`,
    '',
    ` ${bold('Do you trust the files in this folder?')}`,
    '',
    ` ${dim('~/work/ledger-api')}`,
    '',
    ' Claude Code may read files in this folder. Reading untrusted files',
    ' may lead Claude Code to behave in unexpected ways.',
    '',
    ` ${cyan('❯ 1. Yes, proceed')}`,
    '   2. No, exit',
  ].join('\n'),
};

const diff = {
  files: [
    { path: 'src/export/pdf.ts', change: 'added', insertions: 118, deletions: null === 1 ? 0 : 0 },
    { path: 'src/menu.ts', change: 'modified', insertions: 9, deletions: 1 },
    { path: 'src/export/pdf.test.ts', change: 'added', insertions: 52, deletions: 0 },
    { path: 'package.json', change: 'modified', insertions: 1, deletions: 0 },
  ],
  text: [
    'diff --git a/src/menu.ts b/src/menu.ts',
    'index 3b1f2c4..9a0e771 100644',
    '--- a/src/menu.ts',
    '+++ b/src/menu.ts',
    '@@ -12,9 +12,17 @@ export function fileMenu(app: App): MenuItem[] {',
    '   return [',
    "     { id: 'open', label: 'Open…', key: 'CmdOrCtrl+O', run: () => app.open() },",
    "     { id: 'save', label: 'Save', key: 'CmdOrCtrl+S', run: () => app.save() },",
    "-    { id: 'print', label: 'Print…', key: 'CmdOrCtrl+P', run: () => app.print() },",
    "+    { id: 'print', label: 'Print…', key: 'CmdOrCtrl+P', run: () => app.print() },",
    "+    {",
    "+      id: 'export-pdf',",
    "+      label: 'Export as PDF…',",
    "+      key: 'CmdOrCtrl+E',",
    "+      run: () => exportPdf(app.sheet(), { perPage: 28, byScene: true }),",
    '+    },',
    '   ];',
    ' }',
    'diff --git a/package.json b/package.json',
    'index 77c0e12..a91b3f0 100644',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -18,6 +18,7 @@',
    '   "dependencies": {',
    '     "preact": "^11.2.0",',
    '+    "pdf-lib": "^1.17.1",',
    '     "zod": "^3.25.0"',
    '   }',
  ].join('\n'),
};

function scene(name, { now = Date.now(), changes = false } = {}) {
  serial = 0;
  const P = { cuegrid: uid(now, 90 * 864e5), fieldnotes: uid(now, 80 * 864e5), ledger: uid(now, 70 * 864e5), scratch: uid(now, 99 * 864e5) };
  const first = name === 'first';
  const project = (key, n, folder) => ({ id: P[key], rev: 1, name: n, folder, kind: 'folder', color: '#7aa2f7', aliases: [], git: true, isolate: 'busy', open: !first, available: true });
  const projects = [
    project('cuegrid', 'cuegrid', '/Users/example/projects/cuegrid'),
    project('fieldnotes', 'fieldnotes', '/Users/example/projects/fieldnotes'),
    project('ledger', 'ledger-api', '/Users/example/work/ledger-api'),
    { id: P.scratch, rev: 1, name: 'Scratchpad', folder: '/Users/example/Scratch', kind: 'scratch', color: '#9aa5b1', aliases: [], git: false, isolate: 'never', open: false, available: true },
  ];
  const thoughts = [], sessions = [], terminals = [], questions = [], results = [], scr = {};
  const T = {};
  /** A thought with its session and terminal. */
  const run = (key, o) => {
    const created = now - (o.age ?? 5) * MIN, updated = now - (o.done ?? o.age ?? 5) * MIN + 30000;
    const id = uid(created), sid = uid(created + 1000), tid = uid(created + 2000);
    const status = o.status ?? (o.ask ? 'needs_you' : 'working');
    const t = {
      id, rev: 10, text: o.text, strokes: [], source: 'typed', mode: 'ask', phase: status === 'needs_you' ? 'working' : status, status,
      reason: status === 'failed' ? 'turn_failed' : null, live: status === 'working' || status === 'needs_you', project_id: P[o.p], session_id: sid,
      brief: o.text, route: null, placed: 'picked', agent: o.agent ?? 'claude', model: null, workdir: o.workdir ?? null, hold_until: null, read: o.read ?? false, created, updated,
    };
    const ended = o.ended ?? (status === 'done' || status === 'failed');
    sessions.push({
      id: sid, rev: 10, project_id: P[o.p], agent: t.agent, terminal_id: tid, adopted: false, state: ended ? 'ended' : status === 'done' ? 'idle' : o.idle ? 'idle' : 'working',
      thought_id: id, turn: 1, resume: null, name: null, named_at: null, model: null, cwd: '', exit: ended ? 0 : null, error: null, activity: o.activity ?? [],
    });
    terminals.push({ id: tid, rev: 10, project_id: P[o.p], kind: 'agent', title: o.text, cwd: '', argv: [t.agent], cols: 100, rows: 30, state: ended ? 'exited' : 'running', exit: ended ? 0 : null });
    if (o.screen) scr[tid] = screens[o.screen];
    if (o.summary) results.push({ id: uid(updated), rev: 11, thought_id: id, session_id: sid, turn: 1, kind: status === 'failed' ? 'failure' : o.workdir ? 'changes' : 'answer', summary: o.summary });
    if (o.ask) questions.push({ id: uid(now - (o.askAge ?? 2) * MIN), rev: 12, thought_id: id, session_id: sid, turn: 1, source: o.ask.source ?? 'agent', prompt: o.ask.prompt, detail: null,
      reply_via: o.ask.via ?? 'core', state: 'open', answer: null, ...(o.ask.choices ? { kind: 'choice', choices: o.ask.choices } : { kind: o.ask.kind ?? 'confirm' }) });
    thoughts.push(t);
    T[key] = { t, sid, tid };
    return T[key];
  };
  const shell = (key, p, title, screen) => {
    const tid = uid(now - 200 * MIN + terminals.length * 1000);
    terminals.push({ id: tid, rev: 3, project_id: P[p], kind: 'shell', title, cwd: '', argv: [], cols: 100, rows: 30, state: 'running', exit: null });
    if (screen) scr[tid] = screens[screen];
    T[key] = { tid };
    return tid;
  };
  const idea = (text, age) => thoughts.push({ id: uid(now - age * MIN), rev: 4, text, strokes: [], source: 'typed', mode: 'note', phase: 'captured', status: 'captured',
    reason: null, live: false, project_id: null, session_id: null, brief: null, route: null, placed: 'kept', agent: 'claude', model: null, workdir: null, hold_until: null, read: false, created: now - age * MIN, updated: now - age * MIN });
  const workdir = (files, insertions, deletions) => ({ path: '/Users/example/Library/Application Support/Tasktap/worktrees/cuegrid-export-pdf', branch: 'tasktap/cuegrid-export-pdf',
    destination: 'main', base: '4f2a91c', left_out: false, changes: 'pending', files, insertions, deletions });

  const busy = name === 'busy' || name === 'workspace', normal = name === 'normal', quiet = name === 'quiet';
  const longPrompt = 'The export test reads the real clock, so a run that crosses midnight in UTC names the file for the next day. Should I freeze time in the test fixture, retry the assertion up to three times, or pass the date into the exporter so the test can choose it?';
  if (busy) {
    // A question with answers on keys is Claude Code's here: Codex's own questions are answered in its terminal
    // (core/src/agents/codex.rs), and only its requests to run or change something in the app.
    run('export', { p: 'cuegrid', text: 'Fix the flaky export test', age: 9, screen: 'export', activity: ['Ran npm test -- export 20 times'],
      ask: { prompt: longPrompt, choices: ['Freeze the clock in the fixture', 'Retry the assertion up to 3 times', 'Pass the date into the exporter'] }, askAge: 2 });
    run('v1', { p: 'ledger', text: 'Retire the v1 import route', age: 12, ask: { prompt: 'Two clients still call v1. Remove it now, or keep it behind a flag for one release?', kind: 'confirm' }, askAge: 9 });
  }
  if (busy || normal) run('timer', { p: 'cuegrid', text: 'Make the rehearsal timer readable on mobile', age: 6, screen: 'timer', activity: ['Read src/rehearsal/Timer.tsx', 'Checking the layout at 390 px'] });
  if (busy) {
    run('search', { p: 'fieldnotes', agent: 'codex', text: 'Add search to the notes list', age: 3, activity: ['Writing the index query'] });
    run('csv', { p: 'ledger', text: 'Accept CSV as well as JSON on import', age: 11, activity: ['Running the importer tests, 41 of 58'] });
    run('backup', { p: 'ledger', text: 'Check that last night’s backup restores', age: 21, activity: ['Restoring into a scratch database'] });
    run('trust', { p: 'ledger', text: 'Bump the logging library', age: 1, screen: 'trust', ask: { prompt: 'Do you trust the files in this folder?', via: 'terminal', kind: 'text' }, askAge: 1 });
  }
  if (busy || normal || quiet) {
    run('pdf', { p: 'cuegrid', text: 'Export the cue sheet as PDF', status: 'done', age: 50, done: busy ? 20 : 40, read: quiet, screen: 'pdf', ended: false, idle: true,
      summary: 'Exports from the File menu and with ⌘E. Cues paginate by scene, 28 to a page.', workdir: busy || changes ? workdir(4, 180, 1) : null });
    if (busy) run('vite', { p: 'fieldnotes', agent: 'codex', text: 'Upgrade to Vite 7', status: 'failed', age: 150, done: 140, summary: 'vite-plugin-pwa 0.21 does not accept Vite 7 as a peer.' });
    run('sync', { p: 'fieldnotes', text: 'Add offline sync for drafts', status: 'done', age: 200, done: 180, read: true, summary: 'Drafts save locally and sync on reconnect. Tests pass.' });
    run('rate', { p: 'ledger', agent: 'codex', text: 'Rate-limit the import endpoint', status: 'done', age: 2 * 1440, done: 2 * 1440 - 20, read: true, summary: '60 requests a minute per key; 429 with Retry-After.' });
    run('beat', { p: 'cuegrid', text: 'Rename Cue to Beat in the API', status: 'done', age: 2 * 1440 + 60, done: 2 * 1440 + 30, read: true, summary: 'Renamed in 23 files. The old names still parse.' });
    run('fonts', { p: 'cuegrid', text: 'Subset the fonts for the print view', status: 'done', age: 3 * 1440, done: 3 * 1440 - 30, read: true, summary: 'Two fonts subset to Latin; the print bundle is 410 KB smaller.' });
  }
  if (busy) idea('Find out why CI is slow on Mondays', 3 * 1440);
  if (busy || normal || quiet || first) idea('Try a warmer amber for the stage-light preview', first ? 2 : 55);
  if (!first) {
    shell('zsh', 'cuegrid', 'zsh', 'git');
    shell('devsrv', 'cuegrid', 'dev server', 'dev');
  }

  const agent = (id, version, signed) => ({ id, name: { claude: 'Claude Code', codex: 'Codex' }[id] ?? id, program: id, supported: true, own: false, note: null, checks: true, options: [], stale: false, rev: 5, checked: now, installed: true, version, signed_in: signed, identity: signed ? 'person@example.com' : null, events: true, resume: true, permissions: 'core', questions: 'core' });
  const agents = [agent('claude', '2.1.326', true), agent('codex', '0.169.0', !first)];
  // The arrangement: the timer and the result left; the shell and the dev server right; the export below them.
  const layouts = [];
  if (!first) {
    const pane = (id, tabs, active) => ({ id, tabs: tabs.filter(Boolean), active: active ?? tabs.filter(Boolean)[0] });
    const tree = busy || normal ? {
      id: 's1', axis: 'x', ratio: 55,
      first: pane('pa', [T.timer?.tid, T.pdf?.tid], T.timer?.tid),
      second: { id: 's2', axis: 'y', ratio: 52, first: pane('pb', [T.zsh.tid, T.devsrv.tid]), second: pane('pc', [T.export?.tid ?? T.pdf.tid]) },
    } : pane('pa', [T.pdf.tid, T.zsh.tid]);
    const background = busy ? [T.backup.tid] : [];
    layouts.push({ id: P.cuegrid, rev: 6, tree: { tree, selected: 'pa', focus: false, background, sizes: {} } });
    if (busy) {
      layouts.push({ id: P.ledger, rev: 6, tree: { tree: pane('pl', [T.csv.tid, T.trust.tid, T.v1.tid], T.trust.tid), selected: 'pl', focus: false, background: [T.backup.tid], sizes: {} } });
      layouts.push({ id: P.fieldnotes, rev: 6, tree: { tree: pane('pf', [T.search.tid, T.vite.tid, T.sync.tid]), selected: 'pf', focus: false, background: [], sizes: {} } });
      layouts[0].tree.background = [];
    } else if (normal || quiet) {
      layouts.push({ id: P.fieldnotes, rev: 6, tree: { tree: pane('pf', [T.sync.tid]), selected: 'pf', focus: false, background: [], sizes: {} } });
      layouts.push({ id: P.ledger, rev: 6, tree: { tree: pane('pl', [T.rate.tid]), selected: 'pl', focus: false, background: [], sizes: {} } });
    }
  }
  const needs = questions.length, working = thoughts.filter((t) => t.status === 'working').length;
  return {
    thoughts, projects, sessions, terminals, questions, results, layouts, prefs: [], devices: [], agents,
    glance: { rev: 44, working, needs_you: needs, done: thoughts.filter((t) => t.status === 'done' && !t.read).length, failed: thoughts.filter((t) => t.status === 'failed' && !t.read).length, question: questions[0]?.id ?? null, retiring: false },
    // The paths its terminals print that exist, as the host would say: what each really is.
    files: Object.fromEntries(['src/rehearsal/Timer.tsx', 'src/rehearsal/timer.css', 'notes/rehearsal-05.md', 'src/export/pdf.ts', 'src/menu.ts'].map((p) => [p, `/Users/example/projects/cuegrid/${p}`])),
    screens: scr, diffs: T.pdf ? { [T.pdf.t.id]: diff } : {}, ids: { projects: P, ...Object.fromEntries(Object.entries(T).map(([k, v]) => [k, { thought: v.t?.id, session: v.sid, terminal: v.tid }])) },
  };
}

// ——— A thought on its way, and voice (the routing and speech flows) ———

const SAID = {
  en: 'okay so the, um, the rehearsal timer, on my phone the digits get cut off, no wait, not cut off, they wrap onto two lines, so make them fit on one line, and keep the keyboard shortcuts working, and don\'t touch the desktop layout',
  de: 'Äh, also, der Probentimer, auf dem Handy, da brechen die Ziffern um, also nicht abgeschnitten, die rutschen in die zweite Zeile, das soll einzeilig bleiben, und, ach ja, die Tastenkürzel müssen weiter funktionieren, Leertaste für Pause und R für Reset, und am Desktop bitte nichts anfassen, das Layout dort passt so',
};
const BRIEF = {
  en: 'Make the rehearsal timer\'s digits fit on one line on phones; they currently wrap onto two. Keep the keyboard shortcuts working. Do not change the desktop layout.',
  de: 'Die Ziffern des Probentimers sollen auf dem Handy einzeilig bleiben; sie brechen dort in eine zweite Zeile um. Die Tastenkürzel müssen weiter funktionieren (Leertaste für Pause, R für Reset). Am Desktop-Layout nichts ändern.',
};
const TITLE = { en: 'Timer digits on one line', de: 'Probentimer einzeilig auf dem Handy' };
const MORE = {
  en: ' and while you are in there, the colon between minutes and seconds blinks, which nobody asked for, I think that came in with the last change, so stop it blinking, unless that is the thing that tells you it is running, hm, no, it is the play button that tells you, so yes, stop the blinking, and then there was the thing with the font, the digits jump sideways when a one comes up, that is the tabular figures thing, turn those on',
  de: ' und wenn du schon dabei bist, der Doppelpunkt zwischen Minuten und Sekunden blinkt, das hat niemand bestellt, ich glaube das kam mit der letzten Änderung rein, also das Blinken abstellen, außer das ist das, woran man sieht, dass er läuft, hm, nein, das sieht man am Play-Knopf, also ja, Blinken weg, und dann war da noch die Sache mit der Schrift, die Ziffern springen seitlich, wenn eine Eins kommt, das ist das mit den Tabellenziffern, die bitte einschalten',
};
const BRIEF_MORE = {
  en: ' Stop the colon between minutes and seconds from blinking; the play button already shows that the timer runs. Turn on tabular figures so the digits do not shift sideways when a 1 appears.',
  de: ' Das Blinken des Doppelpunkts zwischen Minuten und Sekunden abstellen; dass der Timer läuft, zeigt schon der Play-Knopf. Tabellenziffern einschalten, damit die Ziffern nicht seitlich springen, wenn eine 1 erscheint.',
};

/** Adds one state of the flows to a scene's records and returns them: a thought being placed, held with its brief,
 *  briefed after a pick, sent on as a follow-up, placed by name after a model failed, asked about, or saved for later,
 *  each with the core's word for how it came by its place (`placed`), and the question with what its choices are;
 *  or a dictation that records, is written down, or failed. `lang` en or de, `long` for a long thought and brief,
 *  `voice` for a spoken thought. */
function flow(records, kind, { lang = 'en', long = false, voice = true, now = Date.now() } = {}) {
  const P = records.ids.projects, text = SAID[lang] + (long ? MORE[lang] : ''), brief = BRIEF[lang] + (long ? BRIEF_MORE[lang] : '');
  const pref = (id, value) => (records.prefs = records.prefs.filter((p) => p.id !== id).concat({ id, value, rev: 50 }));
  const by = { agents: [{ agent: 'claude', model: 'haiku', on: true }, { agent: 'codex', model: 'gpt-6-luna', on: true }], terms: 3 }, model = { by: 'claude', model: 'haiku', pending: false, fallback: null, quote: null, title: TITLE[lang], ms: 2300 };
  const local = { by: 'local', model: null, pending: false, fallback: null, quote: null, title: null, ms: 1 };
  const speech = () => (pref('speech_by', { server: 'https://api.openai.com', model: 'gpt-transcribe' }), pref('keys', ['https://api.openai.com']), pref('speech_languages', ['de', 'en']));
  const id = uid(now, 1600);
  const thought = (o) => records.thoughts.push({ id, rev: 60, text, strokes: [], source: voice ? 'voice' : 'typed', mode: 'ask', phase: 'captured', status: 'captured', reason: null, live: false, project_id: null,
    session_id: null, brief: null, route: null, placed: null, agent: 'claude', model: null, workdir: null, hold_until: null, read: false, created: now - 1600, updated: now, ...o });
  const routed = (o) => thought({ phase: 'routed', status: 'routed', project_id: P.cuegrid, brief, hold_until: now + 3400, placed: 'model', ...o });
  const GONE = 'Codex no longer offers the model Tasktap asks for placing; placing by name until Tasktap is updated';
  const dictation = (o) => (speech(), (records.dictations = [{ id: uid(now, o.ago ?? 0), rev: 61, phase: 'recording', text: '', level: 0, target: { kind: 'thought' }, error: null, ...o }]));
  if (kind !== 'off') pref('route_by', by);
  if (voice) speech();
  const kinds = {
    off: () => {},
    placing: () => thought({ route: { ...model, pending: true, title: null, ms: null } }),
    held: () => routed({ route: model }),
    // Two on their way at once: the newest in full, the one before it as its first line.
    two: () => {
      records.thoughts.push({ id: uid(now, 4000), rev: 59, text: 'Fix the flaky export test in cuegrid', strokes: [], source: 'typed', mode: 'ask', phase: 'routed', status: 'routed', reason: null, live: false,
        project_id: P.cuegrid, session_id: null, brief: 'Fix the flaky export test in cuegrid', route: local, placed: 'name', agent: 'claude', model: null, workdir: null, hold_until: now + 1000, read: false, created: now - 4000, updated: now });
      routed({ project_id: P.fieldnotes, route: model });
    },
    plain: () => thought({ phase: 'routed', status: 'routed', project_id: P.cuegrid, text: 'Fix the flaky export test in cuegrid', brief: 'Fix the flaky export test in cuegrid', source: 'typed', hold_until: now + 3400, route: local, placed: 'name' }),
    briefing: () => routed({ brief: text, hold_until: now + 400, placed: 'picked', route: { ...model, pending: true, title: null, ms: null } }),
    // A pick the model wrote the brief for; a follow-up to the session the person was in; one a model sent to another session.
    picked: () => routed({ placed: 'picked', route: model }),
    followup: () => routed({ session_id: records.ids.timer.session, placed: 'follow_up', route: { ...model, title: null } }),
    'followup-model': () => routed({ session_id: records.ids.timer.session, route: { ...model, title: null, quote: lang === 'de' ? 'der Probentimer' : 'the rehearsal timer' } }),
    fallback: () => routed({ brief: text, placed: 'name', route: { ...local, fallback: 'claude: it did not answer within 12 s' } }),
    gone: () => routed({ brief: text, placed: 'name', route: { ...local, fallback: GONE } }),
    asked: () => {
      thought({ status: 'needs_you', brief, route: model });
      records.questions.unshift({ id: uid(now, 900), rev: 62, thought_id: id, session_id: null, turn: null, source: 'router', prompt: 'Which project is this task for?', detail: null, reply_via: 'core', state: 'open', answer: null,
        kind: 'choice', choices: ['cuegrid', 'fieldnotes', 'The codex session in fieldnotes'],
        places: [{ project: P.cuegrid }, { project: P.fieldnotes }, { session: records.ids.search?.session ?? records.ids.sync.session }] });
      records.glance = { ...records.glance, needs_you: records.glance.needs_you + 1, question: records.questions[0].id };
    },
    later: () => thought({ mode: 'note', text: lang === 'de' ? 'Mal schauen, ob der Export auch als CSV geht' : 'See whether the export could also do CSV', route: local, placed: 'kept_name' }),
    'later-model': () => thought({ mode: 'note', route: model, placed: 'kept_model' }),
    'later-answer': () => thought({ mode: 'note', route: model, placed: 'kept_answer' }),
    'later-gone': () => thought({ mode: 'note', placed: 'kept_name', route: { ...local, fallback: GONE } }),
    recording: () => dictation({ level: 64, ago: 7000 }),
    'recording-long': () => dictation({ level: 38, ago: 283000 }),
    writing: () => dictation({ phase: 'transcribing', ago: 9000 }),
    failed: () => dictation({ phase: 'failed', ago: 9000, error: 'The speech service did not answer within 90 s', text: '' }),
    'failed-heard': () => dictation({ phase: 'failed', ago: 9000, error: 'This project is closed', text }),
    'no-service': () => (records.prefs = records.prefs.filter((p) => !p.id.startsWith('speech') && p.id !== 'keys')),
    // A session with a history: three turns in the session of the PDF export. The first has left the live set and is
    // read from `history`: spoken, briefed and placed by a model. The second followed it up and was asked a question.
    // The third is the scene's own, with changes waiting in its copy.
    session: () => {
      const { thought: last, session } = records.ids.pdf, s = records.sessions.find((x) => x.id === session), newest = records.thoughts.find((t) => t.id === last);
      const HOUR = 3600000, turn = (ago, o) => ({ ...newest, id: uid(now, ago), rev: 30, workdir: null, read: true, status: 'done', phase: 'done', created: now - ago, updated: now - ago + 9 * 60000, ...o });
      const first = turn(26 * HOUR, { source: 'voice', placed: 'model', route: { ...model, title: 'Export the cue sheet as PDF' },
        text: 'so the stage manager wants the cue sheet on paper, um, as a PDF, from the File menu I guess, and a shortcut would be good, and it should not cut a cue in half at the bottom of a page',
        brief: 'Export the cue sheet as a PDF from the File menu, with a keyboard shortcut. Never split a cue across two pages.' });
      const second = turn(3 * HOUR, { text: 'Paginate the cues by scene instead of a fixed count, and keep the scene title with its first cue', brief: null, placed: 'follow_up', route: null });
      Object.assign(newest, { text: 'Add the show name and the date to the footer of every page', brief: 'Add the show name and the date to the footer of every page', placed: 'picked' });
      Object.assign(s, { turn: 3, name: 'Export the cue sheet as PDF', model: 'sonnet', cwd: newest.workdir ? newest.workdir.path : '/Users/example/projects/cuegrid' });
      records.thoughts.push(second);
      const q = { id: uid(now, 3 * HOUR - 4 * 60000), rev: 31, thought_id: second.id, session_id: session, turn: 2, source: 'agent', prompt: 'A scene with more than 28 cues does not fit one page. Split it across pages with the title repeated, or shrink the type for that scene?',
        detail: null, places: null, reply_via: 'core', state: 'answered', kind: 'choice', choices: ['Split it and repeat the title', 'Shrink the type for that scene'],
        answer: { device_id: null, created: now - 3 * HOUR + 6 * 60000, kind: 'choice', choice: 0, delivered: now - 3 * HOUR + 6 * 60000 } };
      records.questions.push(q);
      records.results.push({ id: uid(now, 3 * HOUR - 9 * 60000), rev: 32, thought_id: second.id, session_id: session, turn: 2, kind: 'answer', summary: 'Cues now paginate by scene. A long scene splits across pages and repeats its title with “continued”.' });
      const result = records.results.find((r) => r.thought_id === last);
      if (result) Object.assign(result, { summary: 'The footer of every page has the show name at the left and the date at the right. 4 files changed; the tests pass.' });
      records.history = { thoughts: [first], questions: [], results: [{ id: uid(now, 26 * HOUR - 9 * 60000), rev: 29, thought_id: first.id, session_id: session, turn: 1, kind: 'answer', summary: 'Exports from the File menu and with ⌘E, 28 cues to a page.' }] };
    },
  };
  // Previews beside the rehearsal timer's terminal (design §9): what the person opened and what the agent did, by
  // kind; `reads` is what the stand-in core's `file.read` says of each file.
  const T = records.ids.timer?.terminal, at = '/Users/example/projects/cuegrid/';
  const shown = (n, target, o = {}) => ({ id: uid(now, 100 - n), rev: 70 + n, terminal_id: T, kind: /^http/.test(target) ? 'web' : 'file', target: /^http/.test(target) ? target : at + target,
    title: /^http/.test(target) ? target.replace(/^https?:\/\/|\/.*$/g, '') : target.split('/').pop(), by: 'person', ...o });
  const beside = (previews, reads = {}) => Object.assign(records, { previews, reads: Object.fromEntries(Object.entries(reads).map(([file, said]) => [at + file, said])) });
  Object.assign(kinds, {
    previews: () => beside([shown(1, 'notes/rehearsal-05.md'), shown(2, 'out/timer-390.svg', { by: 'agent' })], { 'notes/rehearsal-05.md': { kind: 'markdown', text: NOTES }, 'out/timer-390.svg': { kind: 'svg', text: CHART } }),
    'preview-notes': () => beside([shown(1, 'notes/rehearsal-05.md')], { 'notes/rehearsal-05.md': { kind: 'markdown', text: NOTES } }),
    'preview-text': () => beside([shown(1, 'out/build.log')], { 'out/build.log': { kind: 'text', cut: true, size: 9437184,
      text: Array.from({ length: 400 }, (_, i) => `[${String(i).padStart(4, '0')}] vite v7.0.4 building for production: transformed ${i * 3} modules`).join('\n') } }),
    'preview-gone': () => beside([shown(1, 'out/old-report.md', { by: 'agent' })], { 'out/old-report.md': { err: { code: 'gone', message: `${at}out/old-report.md does not exist` } } }),
    'preview-other': () => beside([shown(1, 'out/cue-sheet.zip')], { 'out/cue-sheet.zip': { kind: 'other', size: 48211 } }),
    'preview-web': () => Object.assign(beside([shown(1, 'http://localhost:5173/rehearsal')]), { listens: false }),
  });
  kinds[kind]();
  return records;
}

/** What an agent writes about its work, with everything the preview draws and something it must not run. */
const NOTES = `# Rehearsal 05: what changed

The timer now stays on **one line** on a phone, and the cue list scrolls under it. Run \`npm test timer\` to see the three new cases.

## What I did

- Moved the digits into a grid of their own (\`src/rehearsal/Timer.tsx\`)
- Dropped the fixed width in [timer.css](src/rehearsal/timer.css)
- [x] Checked at 390 px and 320 px
- [ ] The landscape layout is still open

## Numbers

| Width | Before | After |
| --- | --- | --- |
| 390 px | 2 lines | 1 line |
| 320 px | 3 lines | 1 line |

> The dev server is at http://localhost:5173/rehearsal, and the design note is at https://example.com/notes/timer.

<script>alert('raw HTML is shown as the text it is')</script>

\`\`\`ts
const digits = format(remaining); // 12:04
\`\`\`
`;
/** A drawing: the timer at 390 px, as a picture an agent might save. */
const CHART = `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="260" viewBox="0 0 390 260"><rect width="390" height="260" fill="#16161a"/><rect width="390" height="44" fill="#232329"/>
<text x="16" y="28" font="600 15px system-ui" font-family="system-ui" font-size="15" font-weight="600" fill="#f2f2f3">cuegrid · rehearsal</text>
<text x="195" y="150" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="72" font-weight="600" fill="#f2f2f3">12:04</text>
<text x="195" y="196" text-anchor="middle" font-family="system-ui" font-size="15" fill="#a3a4aa">Next cue: lights down, stage left</text>
<rect x="16" y="222" width="358" height="4" rx="2" fill="#33343a"/><rect x="16" y="222" width="212" height="4" rx="2" fill="#eab676"/></svg>`;

module.exports = { scene, screens, flow, SAID, BRIEF };
