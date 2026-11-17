'use strict';
/* Tasktap UI directions: one page of mock-ups. No build step, no dependencies.
   State lives in the URL hash so any view can be linked or captured. */
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];

const DIRS = [
  { n: 'Current', idea: 'The app as built today, from its own captures.' },
  { n: 'Native', idea: 'Let macOS and the person’s terminal theme do the talking. Tasktap adds only state.' },
  { n: 'Instrument', idea: 'The notch, grown to window size: black glass and polished metal, ruled like an instrument. State is the wave.' },
  { n: 'Ledger', idea: 'Your words are the interface: thoughts set like sentences in a notebook, the machine’s work beside them, almost no icons.' },
];
const SCREENS = ['workspace', 'home', 'notch', 'specimen'];
const TERMS = { tokyo: 'Tokyo Night', gruvbox: 'Gruvbox Dark', solarized: 'Solarized Light' };
const DEFAULTS = { dir: 2, screen: 'workspace', term: 'tokyo', mode: 'dark', compare: 0, dialog: 0, size: 'full', notch: 0, cap: 0, tab: '', hl: 'folds', hs: 'busy', h2: '', bd: 1, nc: 0 };
const st = {};
function readHash() { Object.assign(st, DEFAULTS); for (const [k, v] of new URLSearchParams(location.hash.slice(1))) st[k] = /^\d+$/.test(v) ? +v : v; }
readHash();

/* ---------- icons: one owned set, 16 px grid, drawn as strokes; each direction sets weight and caps ---------- */
const P = {
  sidebar: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25"/><path d="M5.75 2.75v10.5"/>',
  splitr: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25"/><path d="M8 2.75v10.5"/>',
  splitd: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25"/><path d="M1.75 8h12.5"/>',
  plus: '<path d="M8 3.25v9.5M3.25 8h9.5"/>',
  x: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  chev: '<path d="M6 3.75L10.25 8 6 12.25"/>',
  home: '<path d="M2.5 7.25L8 2.75l5.5 4.5M3.75 6.5v6.75h8.5V6.5"/>',
  more: '<g fill="currentColor" stroke="none"><circle cx="3.5" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.5" cy="8" r="1.1"/></g>',
  mic: '<rect x="5.75" y="1.75" width="4.5" height="7.5" rx="2.25"/><path d="M3.25 7.5a4.75 4.75 0 009.5 0M8 12.25v2"/>',
  check: '<path d="M3.25 8.5l3 3 6.5-7.25"/>',
  open: '<path d="M6.25 3.75h6v6M12.25 3.75L4 12"/>',
  ret: '<path d="M12.5 3.75v4a1.5 1.5 0 01-1.5 1.5H3.75M6.5 6.5L3.75 9.25 6.5 12"/>',
  term: '<path d="M3 4.75L6.25 8 3 11.25M8.25 11.5h4.75"/>',
  bg: '<rect x="5.75" y="2.25" width="8" height="8" rx="1.75" opacity=".45"/><rect x="2.25" y="5.75" width="8" height="8" rx="1.75"/>',
  arrow: '<path d="M2.75 8h10M9 4l4 4-4 4"/>',
  undo: '<path d="M4 6.25h5.75a3.25 3.25 0 010 6.5H6.5M6.5 3.75L4 6.25l2.5 2.5"/>',
  stop: '<rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.5"/>',
  search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25l3 3"/>',
};
const I = n => `<svg class="i" viewBox="0 0 16 16" aria-hidden="true">${P[n]}</svg>`;

/* ---------- state marks and the wave ---------- */
const WORD = { working: 'working', asks: 'asks you', ready: 'ready', failed: 'failed', ended: 'ended', idle: '' };
const TITLE = { working: 'Working', asks: 'Needs your answer', ready: 'Result ready', failed: 'Failed', ended: 'Ended', idle: 'Shell' };
const S = (s, bg) => s === 'idle' ? `<i class="st sh" data-s="idle" title="Shell">${I('term')}</i>`
  : `<i class="st${bg ? ' bgd' : ''}" data-s="${s}" data-word="${bg ? 'in background' : WORD[s]}" title="${TITLE[s]}${bg ? ', in background' : ''}"><b></b><b></b><b></b><b></b><b></b></i>`;
function wave(n = 19, cls = '') {
  let h = '';
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1), env = Math.pow(Math.sin(Math.PI * x), .55);
    const small = /xs|sm/.test(cls), ht = small ? 34 + 66 * Math.sin(Math.PI * x) : 18 + 78 * env, off = small ? 0 : -16 * Math.sin(2 * Math.PI * x) * env;
    const tint = [3, 4, 11].includes(i % 14) ? 'cu' : [7, 12].includes(i % 14) ? 'gr' : 'ag';
    h += `<b class="${tint}" style="--h:${ht.toFixed(0)}%;--o:${off.toFixed(0)}%;--d:${(i * 70) % 900}ms"></b>`;
  }
  return `<span class="wave ${cls}" aria-hidden="true">${h}</span>`;
}

/* ---------- terminal text. ⟦classes|text⟧ marks a run; classes are single letters ---------- */
function term(src) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const run = s => esc(s).replace(/⟦([A-Za-z]+)\|([^⟧]*)⟧/g, (m, c, t) => `<span class="${c.split('').join(' ')}">${t}</span>`).replace(/▯/g, '<span class="cur"> </span>');
  return '<pre class="term">' + src.replace(/^\n/, '').split('\n').map(l => {
    if (l === '⟦hr⟧') return '<div class="l hr"></div>';
    const m = l.match(/^⟦([+\-=])⟧(.*)$/);
    return m ? `<div class="l ${{ '+': 'add', '-': 'del', '=': 'ctx' }[m[1]]}">${run(m[2])}</div>` : `<div class="l">${run(l) || ' '}</div>`;
  }).join('') + '</pre>';
}
const PROMPT = '⟦b|cuegrid⟧ ⟦m|main⟧ ⟦y|⇡1⟧ ⟦g|❯⟧';
const TERM = {
  timer: `
⟦o|✻⟧ ⟦B|Claude Code⟧ ⟦d|v2.1.326 · Sonnet 5.5 · ~/projects/cuegrid⟧

⟦d|❯⟧ ⟦B|Make the rehearsal timer readable on mobile.⟧
  ⟦B|Keep the keyboard shortcuts.⟧

⟦f|⏺⟧ I’ll check how the digits are sized, then adjust them
  for narrow screens.

⟦g|⏺⟧ ⟦B|Read⟧(src/rehearsal/Timer.tsx)
  ⟦d|⎿  Read 142 lines⟧

⟦g|⏺⟧ ⟦B|Update⟧(src/rehearsal/timer.css)
  ⟦d|⎿  Updated with 3 additions and 2 removals⟧
⟦=⟧     ⟦d|41⟧    .timer__digits {
⟦-⟧     ⟦d|42⟧ -    font-size: 96px;
⟦-⟧     ⟦d|43⟧ -    letter-spacing: -2px;
⟦+⟧     ⟦d|42⟧ +    font-size: clamp(56px, 22vw, 128px);
⟦+⟧     ⟦d|43⟧ +    font-variant-numeric: tabular-nums;
⟦+⟧     ⟦d|44⟧ +    letter-spacing: -0.03em;
⟦=⟧     ⟦d|45⟧    }

⟦g|⏺⟧ ⟦B|Bash⟧(npm test -- rehearsal)
  ⟦d|⎿⟧  ⟦g|✓⟧ Timer.test.tsx ⟦d|(7 tests) 412ms⟧
     ⟦g|✓⟧ keys.test.ts ⟦d|(4 tests) 38ms⟧
     ⟦d|Tests⟧  ⟦Bg|11 passed⟧ ⟦d|(11)⟧

⟦o|✽ Checking the layout at 390 px…⟧ ⟦d|(1m 42s · ↓ 3.1k tokens)⟧

⟦hr⟧
⟦d|❯⟧ ▯
⟦hr⟧
  ⟦y|⏵⏵ auto mode on⟧ ⟦d|· esc to interrupt⟧`,
  pdf: `
⟦g|⏺⟧ ⟦B|Bash⟧(npm test -- export)
  ⟦d|⎿⟧  ⟦g|✓⟧ export.pdf.test.ts ⟦d|(9 tests) 1.2s⟧

⟦f|⏺⟧ Done. The cue sheet exports as PDF from the File menu
  and with ⌘E.

  • Cues paginate by scene, 28 to a page
  • The header carries the show name and rehearsal number
  • Long cue notes wrap instead of truncating

  ⟦d|4 files changed, 186 insertions(+), 12 deletions(-)⟧

⟦d|✻ Worked for 7m 12s⟧

⟦hr⟧
⟦d|❯⟧ ▯
⟦hr⟧
  ⟦y|⏵⏵ auto mode on⟧`,
  git: `
${PROMPT} git log --oneline --graph -7
* ⟦y|4f2a91c⟧ ⟦c|(⟧⟦Bc|HEAD -> ⟧⟦Bg|main⟧⟦c|)⟧ Clamp timer digits on narrow
* ⟦y|b81d0e7⟧ Space pauses, R resets
*   ⟦y|9c3e5a2⟧ Merge branch 'export-pdf'
⟦r||⟧⟦g|\\⟧
⟦r||⟧ * ⟦y|1d7f6b0⟧ Export the cue sheet as PDF
⟦r||⟧ * ⟦y|e02c4d8⟧ Paginate cues by scene
⟦r||⟧⟦g|/⟧
* ⟦y|77aa3f1⟧ Fix drift when the tab sleeps
* ⟦y|3b9c210⟧ ⟦c|(⟧⟦Br|origin/main⟧⟦c|)⟧ Rehearsal 04: opening notes
${PROMPT} git status -sb
⟦g|## main⟧...⟦r|origin/main⟧ [ahead ⟦g|1⟧]
 ⟦r|M⟧ src/rehearsal/timer.css
⟦r|??⟧ notes/rehearsal-05.md
${PROMPT} ▯`,
  dev: `
${PROMPT} npm run dev

> cuegrid@0.4.0 dev
> vite --host 127.0.0.1

  ⟦Bg|VITE⟧ ⟦g|v6.3.2⟧  ⟦d|ready in⟧ ⟦B|318 ms⟧

  ⟦g|➜⟧  ⟦B|Local:⟧   ⟦c|http://127.0.0.1:5173/⟧
  ⟦d|➜  press h + enter to show help⟧

⟦d|15:36:02⟧ ⟦Bc|[vite]⟧ ⟦g|hmr update⟧ ⟦d|/src/rehearsal/timer.css⟧
⟦d|15:36:41⟧ ⟦Bc|[vite]⟧ ⟦g|hmr update⟧ ⟦d|/src/rehearsal/timer.css⟧
▯`,
  export: `
⟦B|codex⟧ ⟦d|0.169.0 · gpt-5.4 · ~/projects/cuegrid⟧

⟦d|›⟧ ⟦B|Fix the flaky export test⟧

⟦d|•⟧ Ran ⟦c|npm test -- export⟧ 20 times: ⟦r|3 failed⟧
  ⟦d|└⟧ ⟦r|✗⟧ names the file by date
      ⟦d|expected⟧ ⟦g|"cues-2026-11-17.pdf"⟧
      ⟦d|received⟧ ⟦r|"cues-2026-11-18.pdf"⟧

⟦d|•⟧ The fixture reads the real clock, so runs that
  cross midnight UTC fail.

⟦y|?⟧ Waiting for your answer`,
};

/* ---------- a developer's day ---------- */
const Q = { text: 'The export test reads the real clock. Freeze time in the fixture, or retry the assertion?', a: ['Freeze the clock', 'Retry up to 3 times'] };
const WS = [
  { name: 'cuegrid', path: '~/projects/cuegrid', sessions: [
    { id: 'timer', title: 'Make the rehearsal timer readable on mobile', agent: 'Claude Code', s: 'working', t: '6m' },
    { id: 'export', title: 'Fix the flaky export test', agent: 'Codex', s: 'asks', t: '2m' },
    { id: 'pdf', title: 'Export the cue sheet as PDF', agent: 'Claude Code', s: 'ready', t: '15:21' },
    { id: 'git', title: 'zsh', s: 'idle', t: '' },
    { id: 'dev', title: 'dev server', s: 'idle', t: '' },
  ] },
  { name: 'fieldnotes', path: '~/projects/fieldnotes', sessions: [
    { id: 'vite', title: 'Upgrade to Vite 7', agent: 'Codex', s: 'failed', t: '13:20' },
    { id: 'sync', title: 'Add offline sync for drafts', agent: 'Claude Code', s: 'ended', t: '14:02' },
  ] },
  { name: 'ledger-api', path: '~/work/ledger-api', sessions: [
    { id: 'backup', title: 'Check that last night’s backup restores', agent: 'Claude Code', s: 'working', bg: 1, t: '21m' },
    { id: 'rate', title: 'Rate-limit the import endpoint', agent: 'Codex', s: 'ended', t: 'Mon' },
  ] },
];
const SES = Object.fromEntries(WS.flatMap(w => w.sessions.map(s => [s.id, { ...s, ws: w.name }])));
const PANES = [['timer', 'pdf'], ['git', 'dev'], ['export']];
const HOME = {
  needs: [
    { s: 'asks', w: 'cuegrid', ag: 'Codex', t: 'Fix the flaky export test', x: Q.text, tm: '2m', a: Q.a, go: 'export' },
    { s: 'failed', w: 'fieldnotes', ag: 'Codex', t: 'Upgrade to Vite 7', x: 'Stopped. vite-plugin-pwa 0.21 does not accept Vite 7 as a peer.', tm: '13:20', btn: ['Open terminal', 'Try again'] },
  ],
  working: [
    { s: 'working', w: 'cuegrid', ag: 'Claude Code', t: 'Make the rehearsal timer readable on mobile', x: 'Checking the layout at 390 px', tm: '6m', go: 'timer' },
    { s: 'working', bg: 1, w: 'ledger-api', ag: 'Claude Code', t: 'Check that last night’s backup restores', x: 'Restoring into a scratch database', tm: '21m' },
  ],
  results: [
    { s: 'ready', w: 'cuegrid', ag: 'Claude Code', t: 'Export the cue sheet as PDF', x: 'Exports from the File menu and with ⌘E. Cues paginate by scene.', d: ['4 files', '+186', '−12'], tm: '15:21', btn: ['Keep', 'Discard', 'Review'], go: 'pdf' },
    { s: 'ended', w: 'fieldnotes', ag: 'Claude Code', t: 'Add offline sync for drafts', x: 'Drafts save locally and sync on reconnect. Tests pass.', d: ['6 files', '+214', '−37'], tm: '14:02' },
    { s: 'ended', w: 'ledger-api', ag: 'Codex', t: 'Rate-limit the import endpoint', x: '60 requests a minute per key; 429 with Retry-After.', d: ['3 files', '+58', '−4'], tm: 'Mon' },
  ],
};

/* ---------- pieces ---------- */
const kbd = k => `<kbd>${k}</kbd>`;
const ans = (k, label, cls = '') => `<button class="ans ${cls}">${kbd(k)}<span>${label}</span></button>`;
const reply = () => `<label class="reply field">${kbd('T')}<input placeholder="Reply in your own words" aria-label="Reply"><span class="talk">${I('mic')}</span></label>`;

function ask(id) {
  if (id === 'export') return `<div class="ask attn" data-kind="question"><div class="ask-in">
    <div class="ask-meta"><b>Codex asks</b><span>2 min ago</span></div>
    <p class="ask-q">${Q.text}</p>
    <div class="ask-acts">${ans(1, Q.a[0])}${ans(2, Q.a[1])}${reply()}</div></div></div>`;
  if (id === 'pdf') return `<div class="ask" data-kind="result"><div class="ask-in">
    <div class="ask-meta"><b>Result</b><span>15:21</span><span class="diff">4 files <i class="p">+186</i> <i class="m">−12</i></span></div>
    <p class="ask-q">The cue sheet exports as PDF from the File menu and with ⌘E.</p>
    <div class="ask-acts">${ans('↩', 'Keep', 'primary')}${ans('D', 'Discard')}${ans('R', 'Review changes')}</div></div></div>`;
  return '';
}
function pane(ids, i) {
  const on = ids.includes(st.tab) ? st.tab : ids[0];
  return `<section class="pane${i === 0 ? ' focus' : ''}" data-pane="${i}">
    <div class="tabs" role="tablist">${ids.map(id => { const s = SES[id]; return `<button class="tab${id === on ? ' on' : ''}${s.agent ? ' th' : ' shl'}" role="tab" data-tab="${id}" data-s="${s.s}" title="${s.title}">${S(s.s)}<span class="lbl">${s.title}</span><span class="x" data-close="${id}" title="Close tab">${I('x')}</span></button>`; }).join('')}<button class="tab-add ib" title="New tab">${I('plus')}</button></div>
    <div class="bodies">${ids.map(id => `<div class="body${id === on ? ' on' : ''}" data-body="${id}">${term(TERM[id])}${ask(id)}</div>`).join('')}</div>
  </section>`;
}
const deck = () => `<div class="deck">${pane(PANES[0], 0)}<div class="div v"></div><div class="col">${pane(PANES[1], 1)}<div class="div h"></div>${pane(PANES[2], 2)}</div></div>`;

function sidebar(d, view) {
  const hx = d === 2 && view === 'home', need = hx ? SCN[st.hs].needs.length : d === 2 ? 1 : 2;
  const rows = (hx ? scnWS(st.hs) : WS).map((w, wi) => `<div class="ws"><button class="row r-ws" aria-expanded="true">${I('chev')}<span class="lbl">${w.name}</span><span class="cnt">${w.sessions.length}</span></button>${w.sessions.map(s =>
    `<button class="row r-s${view !== 'home' && s.id === (PANES.flat().includes(st.tab) ? st.tab : 'timer') ? ' sel' : ''}${s.bg ? ' bg' : ''}${s.agent ? ' th' : ' shl'}" data-s="${s.s}" ${TERM[s.id] ? `data-go="${s.id}"` : ''} title="${s.title}">${S(s.s, s.bg)}<span class="lbl">${s.title}</span>${s.bg ? `<span class="bgi" title="Running in background">${I('bg')}</span>` : ''}<span class="meta">${s.t}</span></button>`).join('')}</div>`).join('');
  return `<aside class="side">
    <div class="side-top"><span class="lights"><i></i><i></i><i></i></span><button class="ib" title="Hide sidebar">${I('sidebar')}</button></div>
    ${d === 3 ? `<label class="cap-side"><input placeholder="Put a thought in" aria-label="New task"><span class="dest">${I('arrow')}cuegrid</span></label>` : ''}
    <nav class="tree"><button class="row r-home${view === 'home' ? ' sel' : ''}" data-go="home">${I('home')}<span class="lbl">Home</span>${need ? `<span class="cnt" title="${need === 1 ? '1 needs you' : need + ' need you'}">${need}</span>` : ''}</button>
    <div class="sec${rows ? '' : ' empty'}"><span>Workspaces</span><button class="ib" title="Open a folder">${I('plus')}</button></div>${rows}</nav></aside>`;
}

function capture(big) {
  return `<label class="cap${big ? ' big' : ''}">${wave(9, 'sm')}<input placeholder="Put a thought in" aria-label="New task">
    <button class="chip" title="Predicted destination. Click to change">${I('arrow')}<span>cuegrid</span></button><span class="cap-agent">Claude Code</span><span class="cap-hint">hold ${kbd('⌥Space')} to talk</span></label>`;
}
function item(o) {
  return `<article class="it k-${o.s}${o.a ? ' q' : ''}${o.btn ? ' hasb' : ''}" ${o.go ? `data-go="${o.go}"` : ''} tabindex="0">${S(o.s, o.bg)}
    <span class="it-w"><b>${o.w}</b><span>${o.ag}</span></span><span class="it-t">${o.t}</span><span class="it-x">${o.x}</span>
    ${o.d ? `<span class="it-d">${o.d[0]} <i class="p">${o.d[1]}</i> <i class="m">${o.d[2]}</i></span>` : ''}<time class="it-tm">${o.tm}</time>
    ${o.a ? `<div class="it-a">${o.a.map((a, i) => ans(i + 1, a)).join('')}${reply()}</div>` : ''}
    ${o.btn ? `<div class="it-a">${o.btn.map((b, i) => `<button class="btn${i === 0 && o.s === 'ready' ? ' primary' : ''}">${b}</button>`).join('')}</div>` : ''}</article>`;
}
function home() {
  const sec = (k, title) => `<section class="hs hs-${k}"><h3><span>${title}</span><i>${HOME[k].length}</i></h3><div class="its">${HOME[k].map(item).join('')}</div></section>`;
  return `<div class="home"><div class="home-in">${capture(1)}
    ${sec('needs', 'Needs you')}${sec('working', 'In progress')}${sec('results', 'Recent results')}
    <section class="hs agents"><h3><span>Agents</span></h3><div class="its">
      <div class="ag-row"><span class="ag-n">Claude Code</span><span class="ag-v">2.1.326</span><span class="ag-s">Signed in</span></div>
      <div class="ag-row"><span class="ag-n">Codex</span><span class="ag-v">0.169.0</span><span class="ag-s">Signed in</span></div></div>
      <p class="ag-line">Claude Code 2.1.326 and Codex 0.169.0 are installed and signed in.</p></section>
  </div></div>`;
}
function sheet(d) {
  return `<div class="scrim" data-act="dialog"><div class="sheet" role="alertdialog" aria-labelledby="sh-t">
    <img class="sheet-icon" src="current/icon.png" alt="">
    <h2 id="sh-t">${d === 3 ? 'Keep “Fix the flaky export test” running?' : 'Close “Fix the flaky export test”?'}</h2>
    <p>Codex is waiting for your answer in this tab. It can keep running under cuegrid in the sidebar, or stop now. Its history stays either way.</p>
    <div class="sheet-acts"><button class="btn primary" data-act="dialog">${kbd('↩')}<span>Keep running in background</span></button><button class="btn danger" data-act="dialog">${kbd('⌘⌫')}<span>Stop session</span></button><button class="btn cancel" data-act="dialog">${kbd('esc')}<span>Cancel</span></button></div>
  </div></div>`;
}
function win(d, view, solo) {
  const lights = '<span class="lights"><i></i><i></i><i></i></span>';
  return `<div class="win${st.size === 'narrow' && !solo ? ' narrow' : ''}${solo ? ' solo' : ''}${st.dialog && !solo ? ' dlg' : ''}${st.cap && !solo ? ' capping' : ''}" data-view="${view}">
    ${sidebar(d, view)}
    <div class="main">
      <header class="bar"><div class="bar-l">${lights}<button class="ib side-toggle" title="Show sidebar">${I('sidebar')}</button><span class="crumb"><b class="c-deck">cuegrid</b>${d === 2 ? crumbX() : '<b class="c-home">Home</b>'}<span class="path">~/projects/cuegrid</span></span></div>
        <div class="bar-c">${d === 1 ? capture(0) : ''}</div>
        <div class="bar-r"><span class="grp"><button class="ib" title="Split right  ⌘D">${I('splitr')}</button><button class="ib" title="Split down  ⇧⌘D">${I('splitd')}</button></span><button class="newt" data-act="cap" title="New task  ⌘N">${wave(5, 'xs')}<span>New task</span>${kbd('⌘N')}</button>${d === 2 && view === 'home' ? idxX() : ''}</div></header>
      ${deck()}${d === 2 ? homeX() : home()}
    </div>
    ${d === 2 ? `${railX(view)}<div class="capsheet"><div class="cs-in">${notchBody('capture')}</div></div>${view === 'home' && !solo ? hsheet() : ''}` : ''}
    ${sheet(d)}
  </div>`;
}

/* ---------- the notch ---------- */
function notchBody(state, plain) {
  const peek = `<span class="n-peek"><b>Codex asks</b> ${Q.text}</span>`;
  const wings = `<span class="n-wing">${S('working')}<b>2</b></span>`, wingr = `<span class="n-wing r">${S('asks')}<b>1</b></span>`;
  if (state === 'idle') return plain ? `<div class="n-row idle">${wave(7, 'xs rest')}</div>` : '<div class="n-row idle"></div>';
  if (state === 'busy') return plain ? `<div class="n-row">${wings}${peek}${wingr}</div>` : `<div class="n-row">${wings}<span class="n-gap"></span>${wingr}</div><div class="n-row two">${peek}</div>`;
  const head = (l, r) => `<div class="n-head"><span class="n-meta">${l}</span><span class="n-of">${r}</span></div>`;
  if (state === 'question') return `${head('<b>cuegrid</b> Codex', '1 of 2')}<div class="n-pad">
    <p class="n-ctx">Fix the flaky export test</p><p class="n-q">${Q.text}</p>
    <div class="n-ans">${ans(1, Q.a[0])}${ans(2, Q.a[1])}</div>
    <div class="n-reply">${kbd('T')}<span>Reply in your own words</span><span class="n-hint">or hold ⌥Space to talk</span></div></div>`;
  if (state === 'capture') return `${head('New task', '')}<div class="n-pad">
    <div class="n-cap">${wave(13, 'md live')}<span class="n-input">Add a dark theme to the PDF export<i class="caret"></i></span></div>
    <div class="n-dest"><span class="chip">${I('arrow')}<span>cuegrid</span></span><span class="n-agent">Claude Code</span><span class="n-hint">${kbd('↩')} start <i>·</i> hold ⌥Space to talk</span></div></div>`;
  return `${head('<b>cuegrid</b> Claude Code', '15:21')}<div class="n-pad">
    <p class="n-ctx">Result</p><p class="n-q">Export the cue sheet as PDF</p>
    <p class="n-sum">Exports from the File menu and with ⌘E. Cues paginate by scene, 28 to a page.</p>
    <p class="n-diff">4 files <i class="p">+186</i> <i class="m">−12</i></p>
    <div class="n-ans inl">${ans('↩', 'Keep', 'primary')}${ans('D', 'Discard')}${ans('O', 'Open')}</div></div>`;
}
const notch = (state, display) => `<div class="notch ${display} s-${state}${state === 'busy' || state === 'question' ? ' attn' : ''}${['idle', 'busy'].includes(state) ? '' : ' open'}" data-state="${state}">
  <div class="n-glow"><i></i></div><div class="n-shape"><i></i></div><div class="n-body">${notchBody(state, display === 'plain')}</div></div>`;
function shapeNotches(root = document) {
  for (const el of $$('.notch', root)) {
    const body = $('.n-body', el), w = body.offsetWidth, h = body.offsetHeight, plain = el.classList.contains('plain'), P = 8;
    const r = Math.min(parseFloat(getComputedStyle(el).getPropertyValue('--n-r')) || 12, h / 2 - 1);
    let d;
    if (plain && (el.classList.contains('open') || el.dataset.lean === '0')) { // open: a plain rectangle hanging from the edge
      d = `M${P} 0 L${P} ${h - r} Q${P} ${h} ${P + r} ${h} L${P + w - r} ${h} Q${P + w} ${h} ${P + w} ${h - r} L${P + w} 0 Z`;
    } else if (plain) { // the tab: sloped sides, no concave corners
      const lean = el.dataset.lean ? +el.dataset.lean : 9, len = Math.hypot(lean, h), ux = lean / len * r, uy = h / len * r;
      d = `M${P} 0 L${P + lean - ux} ${h - uy} Q${P + lean} ${h} ${P + lean + r} ${h} L${P + w - lean - r} ${h} Q${P + w - lean} ${h} ${P + w - lean + ux} ${h - uy} L${P + w} 0 Z`;
    } else { // hugs the camera housing: small concave shoulders, as the hardware has
      const s = 6;
      d = `M${P - s} 0 Q${P} 0 ${P} ${s} L${P} ${h - r} Q${P} ${h} ${P + r} ${h} L${P + w - r} ${h} Q${P + w} ${h} ${P + w} ${h - r} L${P + w} ${s} Q${P + w} 0 ${P + w + s} 0 Z`;
    }
    for (const i of $$('.n-shape>i,.n-glow>i', el)) i.style.clipPath = `path('${d}')`;
  }
}
const display = (state, kind, h) => `<figure class="disp ${kind}" style="--h:${h}px"><div class="mb"><span><b>Tasktap</b>File<i>Edit</i><i>View</i></span><span>Tue 17 Nov&ensp;15:42</span></div>${kind === 'cut' ? '<div class="hw"></div>' : ''}${notch(state, kind)}</figure>`;
function board() {
  const rows = [['idle', 'Collapsed, nothing running', 84], ['busy', 'Collapsed: two working, one needs you. The line under it says what', 104], ['question', 'Open on a question', 332], ['capture', 'Open on capture', 196], ['result', 'Open on a result', 300]];
  return `<div class="board"><div class="board-h"><h4>Display with a camera cutout</h4><h4>Display without one</h4></div>${rows.map(([s, cap, h]) => `<div class="board-r"><p>${cap}</p>${display(s, 'cut', h)}${display(s, 'plain', h)}</div>`).join('')}${opening()}</div>`;
}

function opening() { // without a cutout: the slope straightens first, then the sheet drops; content fades in last
  const mb = '<div class="mb"><span><b>Tasktap</b>File</span><span>15:42</span></div>';
  const f = (cap, inner, cls = '', lean = '') => `<figure class="disp plain step"><figcaption>${cap}</figcaption>${mb}<div class="notch plain attn ${cls}" ${lean !== '' ? `data-lean="${lean}"` : ''}><div class="n-glow"><i></i></div><div class="n-shape"><i></i></div><div class="n-body"${typeof inner === 'object' ? ` style="width:${inner[0]}px;height:${inner[1]}px"` : ''}>${typeof inner === 'object' ? '' : inner}</div></div></figure>`;
  return `<div class="board-r open-steps"><p>Opening on a display without a cutout, at 0, 60, 140, 260 and 420 ms: the tab keeps its slope, the sides stand up first, then a plain rectangle drops. Shown at 60 %</p>
    ${f('0 ms · the tab', notchBody('busy', 1), 's-busy')}${f('60 ms · sides stand up', [404, 34], '', 4)}${f('140 ms · straight', [412, 92], '', 0)}${f('260 ms · dropping', [418, 188], '', 0)}${f('420 ms · the sheet', notchBody('question', 1), 'open s-question')}</div>`;
}

/* ---------- specimen ---------- */
const SPEC = {
  1: { space: [4, 6, 8, 12, 16, 24], note: 'A 4 px base with a 6 px half-step for capsule padding. Rows 28, tabs 24 in a 34 bar, toolbar 44.' },
  2: { space: [4, 8, 12, 16, 24, 32], note: 'A strict 4 px grid. Rows 28, tabs 30, title bar 38, rail 26. Text columns in Home share one set of tracks.' },
  3: { space: [4, 8, 12, 16, 24, 36], note: 'An 8 px rhythm with a 148 px margin column in Home. Rows 28, tabs 32, title bar 40.' },
};
const TYPE = [['--f-display', 'Display', 'Put a thought in'], ['--f-lead', 'Lead', Q.text], ['--f-title', 'Title', 'Close “Fix the flaky export test”?'], ['--f-strong', 'Strong', 'Keep running in background'],
  ['--f-body', 'Body', 'Make the rehearsal timer readable on mobile'], ['--f-small', 'Small', 'cuegrid · Claude Code · Checking the layout at 390 px'], ['--f-cap', 'Caption', 'Workspaces · hold ⌥Space to talk'], ['--f-num', 'Numerals', '15:21  +186 −12  2.1.326'], ['--f-term', 'Terminal', 'git log --oneline --graph -7']];
const COLORS = [['--bg', 'Window'], ['--side', 'Sidebar'], ['--raised', 'Sheets and menus'], ['--sel', 'Selected row'], ['--line', 'Hairline'], ['--fg', 'Text', 1], ['--fg2', 'Secondary text', 1], ['--fg3', 'Tertiary: times, disabled', 1], ['--accent', 'Keyboard focus, default action', 1], ['--asks', 'Needs you', 1], ['--fail', 'Failed', 1]];
function specimen(d) {
  const five = (h, wrap = x => x) => ['Rest', 'Hover', 'Pressed', 'Keyboard focus', 'Disabled'].map((n, i) => `<div class="sp-state"><div class="sp-demo">${wrap(h(['', 'is-hover', 'is-active', 'is-focus', 'is-disabled'][i]))}</div><span>${n}</span></div>`).join('');
  return `<div class="spec"><header class="sp-h"><h1>${d} · ${DIRS[d].n}</h1><p>${DIRS[d].idea}</p></header>
  <section><h2>Type</h2><div class="sp-type">${TYPE.map(([v, r, s]) => `<div class="sp-t" data-var="${v}"><span class="sp-role">${r}</span><span class="sp-meta"></span><span class="sp-sample" style="font:var(${v})">${s}</span></div>`).join('')}</div></section>
  <section><h2>Colour</h2><div class="sp-colors">${COLORS.map(([v, r, t]) => `<div class="sp-c" data-var="${v}" data-text="${t || ''}"><i style="background:var(${v})"></i><b>${r}</b><code>${v}</code><span class="sp-hex"></span><span class="sp-cr"></span></div>`).join('')}</div>
    <div class="sp-chrome"><div><i class="sw-metal"></i><b>Chrome</b><span>The mark, key caps, the capture wave. Never text, never a border around content.</span></div><div><i class="sw-bloom"></i><b>Bloom</b><span>Light from behind the notch or an asking pane while something needs you. Slow, and still when Reduce Motion is on.</span></div><div>${wave(19, 'md live')}<b>Wave</b><span>The place for the voice-reactive motion from <code>design/motion-lab</code>.</span></div></div></section>
  <section class="sp-two"><div><h2>Space</h2><div class="sp-space">${SPEC[d].space.map(n => `<div><i style="width:${n}px"></i><span>${n}</span></div>`).join('')}</div><p class="sp-note">${SPEC[d].note}</p></div>
    <div><h2>Radius</h2><div class="sp-radii">${[['--r1', 'Control'], ['--r2', 'Panel'], ['--r3', 'Sheet'], ['--n-r', 'Notch']].map(([v, n]) => `<div data-var="${v}"><i style="border-radius:var(${v})"></i><span>${n}</span></div>`).join('')}</div></div></section>
  <section><h2>Icons</h2><div class="sp-icons">${Object.keys(P).map(k => `<span title="${k}">${I(k)}</span>`).join('')}<span class="sep"></span>${['working', 'asks', 'ready', 'failed', 'ended'].map(s => `<span class="sp-st">${S(s)}<em>${s}</em></span>`).join('')}<span class="sp-st">${S('working', 1)}<em>background</em></span></div></section>
  <section><h2>States</h2><div class="sp-states">
    <h3>Default action</h3><div class="sp-row">${five(c => `<button class="btn primary ${c}" ${c === 'is-disabled' ? 'disabled' : ''}>Keep running</button>`)}</div>
    <h3>Button</h3><div class="sp-row">${five(c => `<button class="btn ${c}" ${c === 'is-disabled' ? 'disabled' : ''}>Review</button>`)}</div>
    <h3>Answer</h3><div class="sp-row">${five(c => `<button class="ans ${c}" ${c === 'is-disabled' ? 'disabled' : ''}>${kbd(1)}<span>Freeze the clock</span></button>`)}</div>
    <h3>Field</h3><div class="sp-row">${five(c => `<label class="reply field ${c}">${kbd('T')}<input placeholder="Reply in your own words" ${c === 'is-disabled' ? 'disabled' : ''} tabindex="-1"></label>`)}</div>
    <h3>Tab</h3><div class="sp-row">${five(c => `<button class="tab th ${c}" data-s="working">${S('working')}<span class="lbl">Rehearsal timer</span><span class="x">${I('x')}</span></button>`, x => `<div class="main"><div class="pane focus"><div class="tabs">${x}</div></div></div>`)}</div>
    <h3>Tab, selected</h3><div class="sp-row">${five(c => `<button class="tab th on ${c}" data-s="asks">${S('asks')}<span class="lbl">Flaky export test</span><span class="x">${I('x')}</span></button>`, x => `<div class="main"><div class="pane focus"><div class="tabs">${x}</div></div></div>`)}</div>
    <h3>Sidebar row</h3><div class="sp-row">${five(c => `<button class="row r-s th ${c}" data-s="ready">${S('ready')}<span class="lbl">Export the cue sheet as PDF</span><span class="meta">15:21</span></button>`, x => `<div class="side"><div class="ws">${x}</div></div>`)}</div>
    <h3>Sidebar row, selected</h3><div class="sp-row">${five(c => `<button class="row r-s th sel ${c}" data-s="working">${S('working')}<span class="lbl">Rehearsal timer</span><span class="meta">6m</span></button>`, x => `<div class="side"><div class="ws">${x}</div></div>`)}</div>
${d === 2 ? `<h3>Home row</h3><div class="sp-row">${five(c => `<div class="hr run ${c}" tabindex="-1">${S('working')}<span class="hr-w">cuegrid</span><span class="hr-t">Rehearsal timer</span><time>6m</time></div>`, x => `<div class="hx">${x}</div>`)}</div><h3>Fold</h3><div class="sp-row">${five(c => `<div class="fold"><button class="fold-h ${c}">${I('chev')}<b>Results</b><span class="fold-c"><i class="n">1 new</i></span><time>15:21</time></button></div>`, x => `<div class="hx">${x}</div>`)}</div>` : `<h3>Menu</h3><div class="sp-row"><div class="menu" role="menu"><button role="menuitem"><span>New tab</span><kbd>⌘T</kbd></button><button role="menuitem" class="is-hover"><span>Split right</span><kbd>⌘D</kbd></button><button role="menuitem"><span>Split down</span><kbd>⇧⌘D</kbd></button><hr><button role="menuitem"><span>Keep running in background</span></button><button role="menuitem" class="danger"><span>Stop session</span><kbd>⌘⌫</kbd></button></div></div>`}
  </div></section></div>`;
}
function fillSpecimen(root) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
  const dirEl = root.closest('.dir') || root, probe = document.createElement('i'); dirEl.append(probe);
  const rgb = (v, over) => { probe.style.color = `var(${v})`; cx.clearRect(0, 0, 1, 1); if (over) { cx.fillStyle = over; cx.fillRect(0, 0, 1, 1); } cx.fillStyle = getComputedStyle(probe).color; cx.fillRect(0, 0, 1, 1); return [...cx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
  const hex = c => '#' + c.map(n => n.toString(16).padStart(2, '0')).join('');
  const lum = c => { const [r, g, b] = c.map(n => { n /= 255; return n <= .03928 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
  const bg = rgb('--bg', '#000'), bgHex = hex(bg);
  for (const el of $$('.sp-c', root)) {
    const c = rgb(el.dataset.var, bgHex); $('.sp-hex', el).textContent = hex(c);
    if (el.dataset.text) { const a = lum(c), b = lum(bg), cr = (Math.max(a, b) + .05) / (Math.min(a, b) + .05); $('.sp-cr', el).textContent = cr.toFixed(1) + ' : 1 on window'; }
  }
  for (const el of $$('.sp-t', root)) {
    const cs = getComputedStyle($('.sp-sample', el)), f = cs.fontFamily, fam = /ui-serif|NY/.test(f.split(',')[0] + f.split(',')[1]) ? 'New York' : /mono/i.test(f.split(',')[0]) ? 'SF Mono' : 'SF Pro' + (parseFloat(cs.fontStretch) > 100 ? ' Expanded' : '');
    $('.sp-meta', el).textContent = `${fam} · ${parseFloat(cs.fontSize)}/${parseFloat(cs.lineHeight)} · ${cs.fontWeight}${cs.fontStyle === 'italic' ? ' italic' : ''}`;
  }
  for (const el of $$('.sp-radii [data-var]', root)) { probe.style.width = `var(${el.dataset.var})`; $('span', el).textContent += ' ' + (parseFloat(getComputedStyle(probe).width) > 100 ? 'capsule' : parseFloat(getComputedStyle(probe).width)); }
  probe.remove();
}

/* ---------- "Current": the captures and the diagnosis ---------- */
const CUR = {
  workspace: [['pane-question', 'A question in its pane'], ['splits', 'Three panes'], ['pane-result', 'A result'], ['background', 'A session sent to the background'], ['live-trust-workspace', 'Claude Code, live'], ['live-result-workspace', 'Claude Code, done']],
  home: [['live-result-home', 'Home with one result'], ['home', 'Home, empty']],
  notch: [['notch-collapsed-idle', 'Collapsed, idle'], ['notch-collapsed-working', 'Collapsed, one working'], ['notch-collapsed-done', 'Collapsed, one done'], ['notch-answer', 'Question'], ['notch-live-trust', 'Question, live Claude Code'], ['notch-trust', 'Answer in its terminal'], ['notch-capture-receipt', 'Capture, just sent'], ['notch-result', 'Result'], ['notch-live-result', 'Result, live']],
};
const DIAG = [
  ['home', [225, 84, 930, 138], 'A title card that says where you already are', 'Home opens on a rounded, bordered box containing the word “Home” at 44 px and the date in tracked monospace capitals. The view is named three times (sidebar, toolbar, card). The chrome glyphs float in the box as decoration; they say nothing about state.'],
  ['splits', [196, 32, 984, 36], 'Fourteen identical icons before any content', 'Every pane repeats copy, paste, A−, A+, terminal, split right, split down. Three panes make 21 controls, all the same weight as the tab titles. The tab glyph is the same on every tab and the state is a hollow ring beside the close cross: two marks, no meaning at a glance.'],
  ['pane-question', [196, 32, 620, 64], 'The question is stated three times, each time smaller than the chrome around it', 'A “?” in the tab, a “Needs input · Deploy to staging?” strip, an amber one-pixel box drawn around the whole terminal, and a bottom bar that repeats the question with “Fixture agent needs your decision” under it.'],
  ['pane-question', [660, 700, 520, 60], 'Three button styles in one row, and the blue', 'Yes is a saturated cornflower pill with a check, No is a bordered box with a cross, Reply is grey text. The blue is the web’s default accent; nothing in the chrome identity is blue. It is also the “New task” button and every link in the notch.'],
  ['home', [0, 0, 196, 160], 'Uniform grey, one size, labels on things that need none', '“Tasktap” is written against the window buttons. “WORKSPACES” is a tracked capital kicker. “No open workspaces” and “No active sessions.” explain an empty list. Sidebar, toolbar and metadata all sit in the same mid grey at 12 to 14 px, so nothing leads.'],
  ['live-result-home', [233, 340, 910, 160], 'Lists made of tiles and repeated labels', 'Each agent is a tinted rounded tile with a border, then “Version” spelled out on every row and “● Signed in” on every row. Section titles start 12 px to the right of the card above them: two left edges.'],
  ['background', [396, 560, 500, 190], 'Web furniture: a toast over the terminal, a floating round button', 'The background notice is a grey pill laid over two terminals. A round button floats on the sidebar edge at a different height in every capture. The dialog style is a centred web modal: 16 px radius, one-pixel border, dimmed backdrop.'],
  ['notch-live-trust', null, 'The notch says something needs you, and truncates what', 'The headline is “A question needs you”; the question itself is cut to “Waiting in its terminal: Claude Code is asking …”. Six bordered key caps, a bordered field and a bordered dropdown surround one line of content. Amber strokes show at the top corners.'],
  ['notch-answer', null, 'Three annotations per answer', 'Each answer carries an icon, a boxed number and a boxed global shortcut, between full-width rules. The card is a web card hung from the top edge; nothing in it could only be Tasktap.'],
];
function current(screen) {
  if (screen === 'specimen') return `<div class="diag"><header class="sp-h"><h1>Why the current interface reads as generated</h1><p>Each point names the element and the capture it is cut from. The cuts are at capture size.</p></header>${DIAG.map(([f, c, t, x], i) => `<article><div class="dg-n">${i + 1}</div><div class="dg-t"><h3>${t}</h3><p>${x}</p><code>current/${f}.png</code></div>${c ? `<div class="dg-crop" style="width:${Math.min(c[2], 980)}px;height:${c[3]}px;background:url(current/${f}.png) -${c[0]}px -${c[1]}px no-repeat"></div>` : `<img class="dg-crop" src="current/${f}.png" alt="">`}</article>`).join('')}</div>`;
  if (screen === 'notch') return `<div class="cur-notch">${CUR.notch.map(([f, c]) => `<figure><img src="current/${f}.png" alt="${c}"><figcaption>${c}</figcaption></figure>`).join('')}</div>`;
  const list = CUR[screen], pick = list.find(l => l[0] === st.cur) || list[0];
  return `<div class="cur-win"><img class="cur-img" src="current/${pick[0]}.png" width="1180" height="760" alt="${pick[1]}"><div class="cur-pick">${list.map(([f, c]) => `<button data-cur="${f}" class="${f === pick[0] ? 'on' : ''}">${c}</button>`).join('')}</div></div>`;
}

/* ---------- stage ---------- */
function view(d, screen) {
  const cls = `dir d${d} ${d === 2 ? 'dark' : st.mode}`;
  if (d === 0) return `<div class="dir d0 dark scr-${screen}">${screen === 'workspace' || screen === 'home' ? `<div class="desk"><div class="mb"><span><b>Tasktap</b>File<i>Edit</i><i>View</i><i>Session</i><i>Window</i><i>Help</i></span><span>Tue 17 Nov&ensp;15:42</span></div><div class="hw"></div>${current(screen)}</div>` : current(screen)}</div>`;
  if (screen === 'notch') return `<div class="${cls} scr-notch" data-term="${st.term}">${board()}</div>`;
  if (screen === 'homes') return `<div class="dir d2 dark scr-homes" data-term="${st.term}">${homeGrid()}</div>`;
  if (screen === 'specimen') return `<div class="${cls} scr-specimen" data-term="${st.term}">${specimen(d)}</div>`;
  return `<div class="${cls} scr-win" data-term="${st.term}"><div class="desk"><div class="mb"><span><b>Tasktap</b>File<i>Edit</i><i>View</i><i>Session</i><i>Window</i><i>Help</i></span><span>Tue 17 Nov&ensp;15:42</span></div><div class="hw"></div>${notch(st.notch ? 'question' : 'busy', 'cut')}<div class="fit">${win(d, screen === 'home' ? 'home' : 'deck')}</div></div></div>`;
}
function render() {
  const d = +st.dir, stage = $('#stage');
  document.documentElement.dataset.mode = d === 2 || d === 0 ? 'dark' : st.mode;
  stage.className = st.compare && d ? 'cmp' : '';
  stage.innerHTML = st.compare && d ? `<div class="cmp-col"><span class="cmp-l">Current</span>${view(0, st.screen)}</div><div class="cmp-col"><span class="cmp-l">${d} · ${DIRS[d].n}</span>${view(d, st.screen)}</div>` : view(d, st.screen);
  $$('#bar [data-dir]').forEach(b => b.classList.toggle('on', +b.dataset.dir === d));
  $$('#bar [data-screen]').forEach(b => { b.classList.toggle('on', b.dataset.screen === st.screen); if (b.dataset.screen === 'specimen') b.firstChild.textContent = d ? 'Specimen' : 'Diagnosis'; });
  $('#b-term b').textContent = TERMS[st.term]; $('#b-mode b').textContent = d === 2 ? 'Dark only' : st.mode === 'dark' ? 'Dark' : 'Light';
  $('#b-size b').textContent = st.size === 'narrow' ? '720 × 540' : '1180 × 760';
  $('#b-cmp').classList.toggle('on', !!st.compare); $('#b-dlg').classList.toggle('on', !!st.dialog);
  const hx = d === 2 && (st.screen === 'home' || st.screen === 'homes');
  $('#bar').classList.toggle('nc', !!st.nc || d === 1 || d === 3); $('#bar').classList.toggle('hx', hx);
  $('#b-hl b').textContent = HL[st.hl]; $('#b-hs b').textContent = HS[st.hs]; $('#b-h2').classList.toggle('on', !!st.h2 && st.h2 !== 'shut'); $('#b-bd').classList.toggle('on', !!st.bd);
  $('#idea').textContent = hx ? `${HL[st.hl]}. ${HL_NOTE[st.hl]}` : DIRS[d].idea;
  fit(); shapeNotches(); $$('.spec').forEach(fillSpecimen);
  const h = new URLSearchParams(Object.entries(st).filter(([k, v]) => v !== DEFAULTS[k])).toString();
  history.replaceState(null, '', '#' + h);
}
function fit() {
  for (const f of $$('.fitg')) f.style.zoom = f.parentElement.clientWidth / 956;
  for (const f of $$('.cmp .fit, .cmp .cur-win')) { const col = f.closest('.cmp-col'); f.style.zoom = Math.min(1, (col.clientWidth - 40) / (st.size === 'narrow' && !f.classList.contains('cur-win') ? 720 : 1180)); }
}
const set = (k, v) => { st[k] = v; render(); };
const cycle = (k, list) => set(k, list[(list.indexOf(st[k]) + 1) % list.length]);

document.addEventListener('click', e => {
  const t = e.target.closest('[data-dir],[data-screen],[data-act],[data-tab],[data-go],[data-cur],[data-close],[data-h2],[data-hl],.hq,.notch');
  if (!t) return;
  const bar = t.closest('#bar');
  if (t.dataset.close) { e.stopPropagation(); return set('dialog', 1); }
  if (bar && t.dataset.dir) return set('dir', +t.dataset.dir);
  if (bar && t.dataset.screen) return set('screen', t.dataset.screen);
  if (t.dataset.cur) return set('cur', t.dataset.cur);
  if (t.dataset.act) return act(t.dataset.act, e, t);
  if (t.dataset.hl) { Object.assign(st, { hl: t.dataset.hl, hs: t.dataset.hs, screen: 'home', h2: '' }); return render(); }
  if (t.dataset.h2 !== undefined) return set('h2', st.h2 === t.dataset.h2 ? '' : t.dataset.h2);
  if (t.classList.contains('hq')) { if (e.target.closest('button,input,label')) return; return $$('.hq', t.parentElement).forEach(q => q.classList.toggle('open', q === t)); }
  if (t.dataset.tab) { // tabs switch inside their pane without re-rendering, so focus and hover survive
    const p = t.closest('.pane'); $$('.tab', p).forEach(x => x.classList.toggle('on', x === t)); $$('.body', p).forEach(b => b.classList.toggle('on', b.dataset.body === t.dataset.tab));
    $$('.pane', p.closest('.deck')).forEach(x => x.classList.toggle('focus', x === p)); st.tab = t.dataset.tab; return;
  }
  if (t.dataset.go) {
    if (e.target.closest('.it-a,.hr-a')) return;
    if (t.dataset.go === 'home') Object.assign(st, { screen: 'home', h2: '' }); else Object.assign(st, { screen: 'workspace', tab: t.dataset.go });
    return render();
  }
  if (t.classList.contains('notch') && t.closest('.desk')) set('notch', st.notch ? 0 : 1);
});
function act(a, e, t) {
  if (a === 'dialog') { if (t.classList.contains('scrim') && e.target !== t) return; return set('dialog', st.dialog ? 0 : 1); }
  if (a === 'cap') { if (+st.dir === 2) return set('cap', st.cap ? 0 : 1); const f = $('.win[data-view=deck] .bar .cap input, .cap-side input, .home .cap input'); if (f) f.focus(); return; }
  if (a === 'term') return cycle('term', Object.keys(TERMS));
  if (a === 'mode') return cycle('mode', ['dark', 'light']);
  if (a === 'size') return cycle('size', ['full', 'narrow']);
  if (a === 'compare') return set('compare', st.compare ? 0 : 1);
  if (a === 'nc') return set('nc', st.nc ? 0 : 1);
  if (a === 'hl') { st.h2 = ''; return cycle('hl', Object.keys(HL)); }
  if (a === 'hs') { st.h2 = ''; return cycle('hs', Object.keys(HS)); }
  if (a === 'h2') return set('h2', st.h2 && st.h2 !== 'shut' ? '' : st.hl === 'pages' ? 'all' : 'results');
  if (a === 'bd') return set('bd', st.bd ? 0 : 1);
}
document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.matches('input')) { if (e.key === 'Escape') e.target.blur(); return; }
  const k = e.key.toLowerCase();
  if (k === 'escape') { st.dialog = st.cap = st.notch = 0; st.h2 = ''; return render(); }
  if ('0123'.includes(k) && k) return set('dir', +k);
  const order = st.nc || +st.dir === 1 || +st.dir === 3 ? [0, 2, 1, 3] : [0, 2];
  if (k === 'arrowright' || k === 'arrowleft') return set('dir', order[(Math.max(0, order.indexOf(+st.dir)) + (k === 'arrowright' ? 1 : order.length - 1)) % order.length]);
  const m = { w: ['screen', 'workspace'], h: ['screen', 'home'], n: ['screen', 'notch'], s: ['screen', 'specimen'], g: ['screen', 'homes'] }[k];
  if (m) return set(...m);
  const a = { t: 'term', l: 'mode', m: 'size', c: 'compare', d: 'dialog', k: 'cap', x: 'hl', z: 'hs', e: 'h2', b: 'bd' }[k];
  if (a) return act(a, e, document.body);
  if (k === 'o') return set('notch', st.notch ? 0 : 1);
});
addEventListener('resize', fit);
addEventListener('hashchange', () => { readHash(); render(); });
/* Chromium has no ui-serif or ui-monospace, so a page opened from disk loads the system faces by file. Served over
   http that is not allowed and the stacks fall back (Menlo for figures); in the app's web view the generic names resolve. */
if (location.protocol === 'file:') document.head.insertAdjacentHTML('beforeend', `<style>
@font-face{font-family:"NY";src:url("file:///System/Library/Fonts/NewYork.ttf");font-weight:100 900}
@font-face{font-family:"NY";font-style:italic;src:url("file:///System/Library/Fonts/NewYorkItalic.ttf");font-weight:100 900}
@font-face{font-family:"SFM";src:url("file:///System/Library/Fonts/SFNSMono.ttf");font-weight:100 900}</style>`);
document.fonts.ready.then(render); render();
/* Text fields always match :focus-visible, so the ring around a field is tied to the last input
   device instead: Tab sets the flag, a pointer press clears it. */
addEventListener('keydown', e => { if (e.key === 'Tab') document.documentElement.dataset.kb = 1; }, true);
addEventListener('mousedown', () => { delete document.documentElement.dataset.kb; }, true);
