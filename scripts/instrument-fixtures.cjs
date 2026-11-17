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
    `  ${dim('➜  Network: use --host to expose')}`,
    `  ${dim('➜  press h + enter to show help')}`,
    '',
    `${dim('15:40:12')} ${cyan('[vite]')} ${green('hmr update')} ${dim('/src/rehearsal/timer.css')}`,
    `${dim('15:41:03')} ${cyan('[vite]')} ${green('hmr update')} ${dim('/src/rehearsal/Timer.tsx')}`,
  ].join('\n'),
  export: [
    `${bold('codex')} ${dim('0.169.0 · ~/projects/cuegrid')}`,
    '',
    `${dim('›')} ${bold('Fix the flaky export test')}`,
    '',
    `${dim('•')} Ran ${cyan('npm test -- export')} 20 times: ${red('3 failed')}`,
    `  ${dim('└')} ${red('×')} names the file by date`,
    `      expected ${green('"cues-2026-11-17.pdf"')}`,
    `      received ${red('"cues-2026-11-18.pdf"')}`,
    '',
    `${dim('•')} The test builds its expected name from ${cyan('new Date()')} while the`,
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
    { id: P.scratch, rev: 1, name: 'Scratch', folder: '/Users/example/Scratch', kind: 'scratch', color: '#9aa5b1', aliases: [], git: false, isolate: 'never', open: false, available: true },
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
      brief: o.text, agent: o.agent ?? 'claude', model: null, workdir: o.workdir ?? null, hold_until: null, read: o.read ?? false, created, updated,
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
    reason: null, live: false, project_id: null, session_id: null, brief: null, agent: 'claude', model: null, workdir: null, hold_until: null, read: false, created: now - age * MIN, updated: now - age * MIN });
  const workdir = (files, insertions, deletions) => ({ path: '/Users/example/Library/Application Support/Tasktap Next/worktrees/cuegrid-export-pdf', branch: 'tasktap/cuegrid-export-pdf',
    destination: 'main', base: '4f2a91c', left_out: false, changes: 'pending', files, insertions, deletions });

  const busy = name === 'busy' || name === 'workspace', normal = name === 'normal', quiet = name === 'quiet';
  const longPrompt = 'The export test reads the real clock, so a run that crosses midnight in UTC names the file for the next day. Should I freeze time in the test fixture, retry the assertion up to three times, or pass the date into the exporter so the test can choose it?';
  if (busy) {
    run('export', { p: 'cuegrid', agent: 'codex', text: 'Fix the flaky export test', age: 9, screen: 'export', activity: ['Ran npm test -- export 20 times'],
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

  const agent = (id, version, signed) => ({ id, rev: 5, checked: now, installed: true, version, signed_in: signed, identity: signed ? 'person@example.com' : null, events: true, resume: true, permissions: 'core', questions: 'core' });
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
    screens: scr, diffs: T.pdf ? { [T.pdf.t.id]: diff } : {}, ids: { projects: P, ...Object.fromEntries(Object.entries(T).map(([k, v]) => [k, { thought: v.t?.id, session: v.sid, terminal: v.tid }])) },
  };
}

module.exports = { scene, screens };
