'use strict';
/* Instrument's Home: a dashboard in layers. Three layerings of the same first layer, each in four
   states. Loaded before app.js and uses its helpers (I, S, ans, reply, kbd, wave, st) at call time. */
const HL = { folds: 'Folds', sheets: 'Sheets', pages: 'Pages' };
const HS = { busy: 'Busy day', normal: 'Normal', quiet: 'Quiet', first: 'First run' };
const HL_NOTE = {
  folds: 'Finished and unplaced thoughts are two single lines under what is happening now. A line opens in place.',
  sheets: 'Home shows only now. Results and Ideas sit in the title bar and drop a sheet from it, as capture and dialogs do.',
  pages: 'Home shows only now, and one line leads to a second page, Earlier, with a way back.',
};

/* thoughts for the four states */
const T2 = {
  timer: { w: 'cuegrid', ag: 'Claude Code', t: 'Make the rehearsal timer readable on mobile', x: 'Checking the layout at 390 px', tm: '6m', go: 'timer' },
  search: { w: 'fieldnotes', ag: 'Codex', t: 'Add search to the notes list', x: 'Writing the index query', tm: '3m' },
  csv: { w: 'ledger-api', ag: 'Claude Code', t: 'Accept CSV as well as JSON on import', x: 'Running the importer tests, 41 of 58', tm: '11m' },
  backup: { w: 'ledger-api', ag: 'Claude Code', t: 'Check that last night’s backup restores', x: 'Restoring into a scratch database', tm: '21m', bg: 1 },
  export: { w: 'cuegrid', ag: 'Codex', t: 'Fix the flaky export test', q: 'The export test reads the real clock. Freeze time in the fixture, or retry the assertion?', a: ['Freeze the clock', 'Retry up to 3 times'], tm: '2m', go: 'export' },
  v1: { w: 'ledger-api', ag: 'Claude Code', t: 'Retire the v1 import route', q: 'Two clients still call v1. Remove it now, or keep it behind a flag for one release?', a: ['Remove it now', 'Keep it behind a flag'], tm: '9m' },
  pdf: { w: 'cuegrid', ag: 'Claude Code', t: 'Export the cue sheet as PDF', x: 'Exports from the File menu and with ⌘E. Cues paginate by scene.', d: ['4 files', '+186', '−12'], tm: '15:21', go: 'pdf' },
  vite: { w: 'fieldnotes', ag: 'Codex', t: 'Upgrade to Vite 7', x: 'Stopped: vite-plugin-pwa 0.21 does not accept Vite 7 as a peer.', tm: '13:20', failed: 1 },
  sync: { w: 'fieldnotes', ag: 'Claude Code', t: 'Add offline sync for drafts', x: 'Drafts save locally and sync on reconnect. Tests pass.', d: ['6 files', '+214', '−37'], tm: '14:02' },
  rate: { w: 'ledger-api', ag: 'Codex', t: 'Rate-limit the import endpoint', x: '60 requests a minute per key; 429 with Retry-After.', d: ['3 files', '+58', '−4'], tm: 'Mon' },
  beat: { w: 'cuegrid', ag: 'Claude Code', t: 'Rename Cue to Beat in the API', x: 'Renamed in 23 files. The old names still parse.', d: ['23 files', '+140', '−140'], tm: 'Mon' },
};
const SCN = {
  busy: { needs: ['export', 'v1'], run: ['timer', 'search', 'csv', 'backup'], res: ['pdf', 'vite', 'sync', 'rate', 'beat'], fresh: ['pdf', 'vite'], ideas: 2 },
  normal: { needs: [], run: ['timer'], res: ['pdf', 'sync', 'rate', 'beat'], fresh: ['pdf'], ideas: 1 },
  quiet: { needs: [], run: [], res: ['pdf', 'sync', 'rate', 'beat'], fresh: [], ideas: 1 },
  first: { needs: [], run: [], res: [], fresh: [], ideas: 0, first: 1 },
};
const IDEAS = [{ t: 'Try a warmer amber for the stage-light preview', tm: '11:05' }, { t: 'Find out why CI is slow on Mondays', tm: 'Fri' }];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* the sidebar and the rail follow the state, so the window tells one story */
function scnWS(k) {
  const s = SCN[k];
  const state = id => s.needs.includes(id) ? 'asks' : s.run.includes(id) ? 'working' : T2[id].failed ? 'failed' : s.fresh.includes(id) ? 'ready' : 'ended';
  return ['cuegrid', 'fieldnotes', 'ledger-api'].map(w => ({ name: w, sessions: [...s.needs, ...s.run, ...s.res].filter(id => T2[id].w === w)
    .map(id => ({ id, title: T2[id].t, agent: T2[id].ag, s: state(id), t: T2[id].tm, bg: T2[id].bg })).concat(w === 'cuegrid' ? [{ id: 'git', title: 'zsh', s: 'idle', t: '' }] : []) })).filter(w => w.sessions.length && !s.first);
}
function railX(view) {
  const s = view === 'home' ? SCN[st.hs] : { needs: ['export'], run: ['timer', 'backup'], fresh: ['pdf'] };
  const n = s.needs.length, r = s.run.length, f = s.fresh.length;
  const left = n || r || f ? `${n ? `${S('asks')}<b>${plural(n, 'needs you', 'need you')}</b>` : S(r ? 'working' : 'ready')}${r ? `<span>${r} working</span>` : ''}${f ? `<span>${plural(f, 'new result', 'new results')}</span>` : ''}` : `${S('ended')}<span>Nothing running</span>`;
  const off = view === 'home' && s.first;
  return `<footer class="rail"><span class="rail-l">${left}</span><span class="rail-r"><button data-h2="agents" title="Agents">Claude Code</button><button data-h2="agents" class="${off ? 'off' : ''}" title="Agents">Codex</button><button data-h2="settings" class="plain" title="Settings  ⌘,">Settings</button></span></footer>`;
}

/* rows */
const qRow = (id, open) => { const o = T2[id]; return `<article class="hq${open ? ' open' : ''}" tabindex="0">${S('asks')}<span class="hq-m"><b>${o.w}</b><span>${o.ag}</span><span class="hq-t">${o.t}</span></span><time>${o.tm}</time><p class="hq-q">${o.q}</p><div class="hq-a">${o.a.map((a, j) => ans(j + 1, a)).join('')}${reply()}</div></article>`; };
const runRow = id => { const o = T2[id]; return `<div class="hr run${o.bg ? ' bgd' : ''}" tabindex="0" ${o.go ? `data-go="${o.go}"` : ''}>${S('working', o.bg)}<span class="hr-w">${o.w}</span><span class="hr-t">${o.t}</span><span class="hr-x">${o.x}</span><time>${o.tm}</time></div>`; };
function resRow(id, s) {
  const o = T2[id], isNew = s.fresh.includes(id), state = o.failed ? 'failed' : isNew ? 'ready' : 'ended';
  const acts = !isNew ? '' : o.failed ? '<div class="hr-a"><button class="btn">Open terminal</button><button class="btn">Try again</button></div>' : '<div class="hr-a"><button class="btn primary">Keep</button><button class="btn">Discard</button><button class="btn">Review</button></div>';
  return `<div class="hr res k-${state}" tabindex="0" ${o.go ? `data-go="${o.go}"` : ''}>${S(state)}<span class="hr-w">${o.w}</span><span class="hr-t">${o.t}</span><span class="hr-x">${o.x}</span><span class="hr-d">${o.d ? `${o.d[0]} <i class="p">${o.d[1]}</i> <i class="m">${o.d[2]}</i>` : ''}</span><time>${o.tm}</time>${acts}</div>`;
}
const ideaRow = o => `<div class="hr idea" tabindex="0"><i class="st idea-m" title="Idea, not sent anywhere"></i><span class="hr-t">${o.t}</span><span class="hr-x">No folder matched</span><div class="hr-a"><button class="btn">Send to a folder…</button><button class="btn">Drop</button></div><time>${o.tm}</time></div>`;
const agentRows = first => `<div class="hr ag"><i class="st ok"></i><span class="hr-t">Claude Code</span><span class="hr-x">2.1.326 · signed in</span></div>
  <div class="hr ag${first ? ' off' : ''}"><i class="st ok"></i><span class="hr-t">Codex</span><span class="hr-x">0.169.0 · ${first ? 'not signed in' : 'signed in'}</span>${first ? '<div class="hr-a"><button class="btn">Sign in</button></div>' : ''}</div>`;
const resList = (s, n) => s.res.slice(0, n).map(id => resRow(id, s)).join('');
const ideaList = s => IDEAS.slice(0, s.ideas).map(ideaRow).join('');
function resCount(s) {
  const failed = s.fresh.filter(id => T2[id].failed).length, news = s.fresh.length - failed;
  return [news ? `<i class="n">${news} new</i>` : '', failed ? `<i class="f">${failed} failed</i>` : '', !s.fresh.length ? `<i>${s.res.length}</i>` : ''].join('');
}

function homeX() {
  const k = st.hs, s = SCN[k], L = st.hl, o2 = st.h2, idle = !s.needs.length && !s.run.length && !s.first;
  const cap = `<label class="cap big">${wave(9, 'sm')}<input placeholder="Put a thought in" aria-label="New task">${s.first ? '<span class="cap-agent">Kept as an idea until a folder is open</span>' : `<button class="chip" title="Predicted destination. Click to change">${I('arrow')}<span>cuegrid</span></button><span class="cap-agent">Claude Code</span>`}<span class="cap-hint">hold ${kbd('⌥Space')} to talk</span></label>`;
  const bd = st.bd ? `<div class="bd" aria-hidden="true">${wave(46, 'bdw live')}</div>` : '';
  if (o2 === 'all') { // the second page: everything that has ended, and ideas without a place
    const today = s.res.filter(id => T2[id].tm.includes(':')), before = s.res.filter(id => !T2[id].tm.includes(':'));
    const grp = (t, n, rows) => rows ? `<section class="hx-sec"><h3><span>${t}</span><i>${n}</i></h3>${rows}</section>` : '';
    return `<div class="home hx S-${k} L-${L} paged">${bd}<div class="hx-in"><label class="find field">${I('search')}<input placeholder="Find a thought" aria-label="Find a thought"></label>
      ${grp('Ideas', s.ideas, ideaList(s))}${grp('Today', today.length, today.map(id => resRow(id, s)).join(''))}${grp('Monday', before.length, before.map(id => resRow(id, s)).join(''))}</div></div>`;
  }
  const now = [
    s.needs.length ? `<section class="hx-sec needs"><h3>${S('asks')}<span>Needs you</span><i>${s.needs.length}</i></h3>${s.needs.map((id, i) => qRow(id, i === 0)).join('')}</section>` : '',
    s.run.length ? `<section class="hx-sec run"><h3><span>Running</span><i>${s.run.length}</i></h3>${s.run.map(runRow).join('')}</section>` : '',
    s.first ? `<section class="hx-sec first"><h3><span>To start</span></h3><div class="hr step"><button class="ans primary">${kbd('⌘O')}<span>Open a folder</span></button><span class="hr-x">It becomes a workspace. A thought goes to the folder it belongs to.</span></div>${agentRows(1)}</section>` : '',
    idle && L !== 'folds' ? `<section class="hx-sec last"><h3><span>Last finished</span></h3>${resList(s, 2)}</section>` : '',
  ].join('');
  const peek = s.res.length ? T2[s.res[0]] : null;
  const fold = (key, name, count, pk, tm, body, open) => `<div class="fold${open ? ' open' : ''}"><button class="fold-h" data-h2="${key}" aria-expanded="${!!open}">${I('chev')}<b>${name}</b><span class="fold-c">${count}</span><span class="fold-p">${pk}</span><time>${tm}</time></button><div class="fold-b">${body}</div></div>`;
  let more = '';
  if (L === 'folds' && !s.first) {
    const ro = o2 === 'results' || (idle && o2 !== 'ideas' && o2 !== 'shut'); // nothing else to show: Results opens itself to its last two
    more = `<section class="folds">${fold(ro ? (idle ? 'shut' : '') : 'results', 'Results', resCount(s), peek.t, peek.tm, resList(s, o2 === 'results' ? 5 : 2) + `<button class="more" data-h2="all">All results${I('chev')}</button>`, ro)}
      ${s.ideas ? fold('ideas', 'Ideas', `<i>${s.ideas}</i>`, IDEAS[0].t, IDEAS[0].tm, ideaList(s), o2 === 'ideas') : ''}</section>`;
  }
  if (L === 'pages' && !s.first) more = `<section class="folds"><div class="fold"><button class="fold-h earlier" data-h2="all">${I('chev')}<b>Earlier</b><span class="fold-c">${resCount(s)}${s.ideas ? `<i>${plural(s.ideas, 'idea', 'ideas')}</i>` : ''}</span><span class="fold-p">${peek.t}</span><time>${peek.tm}</time></button></div></section>`;
  return `<div class="home hx S-${k} L-${L}">${bd}<div class="hx-in">${cap}${now}${more}</div></div>`;
}

/* what the title bar carries on Home */
function crumbX() {
  return st.h2 === 'all' ? `<button class="back c-home" data-h2="" title="Back to Home  ⌘[">${I('chev')}<span>Home</span></button><b class="c-home sub">Earlier</b>` : '<b class="c-home">Home</b>';
}
function idxX() {
  const s = SCN[st.hs];
  if (st.hl !== 'sheets' || s.first) return '';
  return `<span class="hx-idx"><button data-h2="results" class="${st.h2 === 'results' ? 'on' : ''}"><span>Results</span>${resCount(s)}</button>${s.ideas ? `<button data-h2="ideas" class="${st.h2 === 'ideas' ? 'on' : ''}"><span>Ideas</span><i>${s.ideas}</i></button>` : ''}</span>`;
}
/* sheets hang from the title bar: agents and settings in every layering; results and ideas in Sheets */
function hsheet() {
  const s = SCN[st.hs], o2 = st.h2; let title, body;
  if (o2 === 'agents') { title = 'Agents'; body = agentRows(s.first) + '<button class="more">Add an agent…</button>'; }
  else if (o2 === 'settings') { title = 'Settings'; body = [['Terminal theme', 'From Ghostty: Tokyo Night'], ['Text size', '13'], ['Capture shortcut', '⌃⌥Space'], ['Start without review', 'On'], ['Notch on this display', 'On']].map(([a, b]) => `<div class="hr set"><i class="st"></i><span class="hr-t">${a}</span><span class="hr-x">${b}</span></div>`).join(''); }
  else if (st.hl === 'sheets' && o2 === 'results') { title = `Results ${resCount(s)}`; body = resList(s, 5) + `<button class="more" data-h2="all">All results${I('chev')}</button>`; }
  else if (st.hl === 'sheets' && o2 === 'ideas') { title = `Ideas <i>${s.ideas}</i>`; body = ideaList(s); }
  else return '';
  return `<div class="hscrim" data-h2=""></div><div class="hsheet" role="dialog" aria-label="${title.replace(/<[^>]+>/g, '')}"><header><b>${title}</b>${kbd('esc')}</header>${body}</div>`;
}

/* all twelve at once */
function homeGrid() {
  const keep = { hl: st.hl, hs: st.hs }; let h = '<div class="hgrid"><span></span>' + Object.values(HS).map(n => `<h4>${n}</h4>`).join('');
  for (const l of Object.keys(HL)) {
    h += `<h4 class="hg-l">${HL[l]}<small>${HL_NOTE[l]}</small></h4>`;
    for (const k of Object.keys(HS)) { st.hl = l; st.hs = k; h += `<div class="hg-cell" role="button" tabindex="0" data-hl="${l}" data-hs="${k}" title="${HL[l]}, ${HS[k]}"><div class="fitg">${win(2, 'home', 1)}</div></div>`; }
  }
  Object.assign(st, keep);
  return h + '</div>';
}
