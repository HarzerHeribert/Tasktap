// The sidebar: Home, then each open workspace with its sessions under it, most urgent first. A row shows what runs;
// it never starts or resumes anything. Its menus are the system's.
import { startAgent } from './deck.tsx';
import * as L from './layout.ts';
import { Spark } from './light.tsx';
import { command } from './main.tsx';
import { type Item, popup } from './menu.ts';
import {
  LOOSE, agentName, closeTab, closeWorkspace, cue, details, focusSession, keepInBackground, label, layout, newTerminal, open, openQuestions, questionOf,
  records, redraw, runs, sessionOf, show, thoughtOf, ui, workspaces,
} from './model.ts';
import { I, Seat, elapsed, madeAt, when } from '../ui.tsx';
import { tip } from '../keys.ts';
import { mac } from '../system.ts';
import { MenuButton } from './chrome.tsx';

const ORDER = { asks: 0, working: 1, ready: 2, failed: 3, ended: 4, shell: 5 } as Record<string, number>;

function Session({ project, id, bg }: { project: string; id: string; bg: boolean }) {
  const c = cue(id);
  const s = sessionOf(id);
  const t = thoughtOf(s);
  const term = records.terminals.get(id);
  const shell = c.s === 'shell';
  const name = label(id);
  const selected = ui.view === project && L.selectedPane(layout(project))?.active === id;
  const q = questionOf(s);
  const time = shell ? '' : q ? elapsed(madeAt(q.id)) : c.s === 'working' ? elapsed(t?.created ?? Date.now()) : when(t?.updated ?? Date.now());
  // ⌘W closes the terminal in front, which is this row's when it is selected.
  const shut = selected ? tip('Close', '⌘W') : 'Close';
  const menu: Item[] = [
    { text: 'Show', do: () => focusSession(id) },
    ...(s ? [{ text: 'Session Details…', do: () => void details(id) }] : []),
    ...(term?.state === 'running' && !bg ? [{ text: 'Keep Running in Background', do: () => keepInBackground(project, id) }] : []),
    ...(term?.state === 'running' ? [{ text: 'Stop Session…', do: () => open({ kind: 'stop', project, id }) }] : []),
    '-' as const, { text: bg ? 'Close' : 'Close Tab', ...(selected ? { key: '⌘W' } : {}), do: () => closeTab(project, id) },
  ];
  // The cross stands in the row's trailing place, over its time, on hover and focus: a sibling of the row's button,
  // so neither holds the other, and the row's words and mark stay where they are.
  return (
    <div class="srow" data-id={id}>
      <button type="button" class={`row s${selected ? ' sel' : ''}${bg ? ' bg' : ''}${shell ? ' shl' : ''}`} data-s={c.s} data-id={id}
        title={`${name}\n${c.words}${bg ? ', in background' : ''}${c.activity ? `\n${c.activity}` : ''}`} onClick={() => focusSession(id)}
        onContextMenu={(e) => popup(e, menu)} onKeyDown={(e) => e.key.toLowerCase() === 'i' && !e.metaKey && !e.ctrlKey && details(id) && e.preventDefault()}>
        <Seat agent={s?.agent} s={c.s} bg={bg} label={`${c.words}${bg ? ', in background' : ''}`} />
        <span class="lbl">{name}</span>
        {bg && <span class="bgi" title="Running in background"><I n="bg" /></span>}
        {time && <span class="meta">{time}</span>}
      </button>
      <button type="button" class="x" title={shut} aria-label={`Close ${name}`} onClick={() => closeTab(project, id)}><I n="x" /></button>
    </div>
  );
}

function Workspace({ id, name, folder }: { id: string; name: string; folder?: string }) {
  const l = layout(id);
  const folded = ui.folded.has(id);
  const rows = [...L.tabs(l).filter((t) => !records.previews.has(t)).map((t) => ({ t, bg: false })), ...l.background.map((t) => ({ t, bg: true }))]
    .sort((a, b) => (ORDER[cue(a.t).s] ?? 9) - (ORDER[cue(b.t).s] ?? 9) || Number(a.bg) - Number(b.bg));
  const agents = [...records.agents.values()].filter(runs);
  const menu: Item[] = [
    { text: 'New Terminal', do: () => newTerminal(id) },
    ...(id === LOOSE ? [] : agents.map((a) => ({ text: `New ${agentName(a.id)} Session`, do: () => void startAgent(id, a.id) }))),
    ...(id === LOOSE ? [] : ['-' as const, { text: 'Close Workspace…', do: () => closeWorkspace(id) }]),
  ];
  return (
    <section class="ws" data-workspace={id}>
      <div class={`row w${ui.view === id ? ' on' : ''}`} onContextMenu={(e) => popup(e, menu)}>
        <button type="button" class="fold" aria-expanded={!folded} aria-label={`${folded ? 'Show' : 'Hide'} the sessions of ${name}`}
          onClick={() => (folded ? ui.folded.delete(id) : ui.folded.add(id), redraw())}>
          <I n="chev" />
        </button>
        <button type="button" class="name" title={folder} aria-current={ui.view === id ? 'page' : undefined} onClick={() => show(id)}>
          <span class="lbl">{name}</span><span class="cnt">{rows.length || ''}</span>
        </button>
      </div>
      {!folded && rows.map(({ t, bg }) => <Session key={t} project={id} id={t} bg={bg} />)}
    </section>
  );
}

export function Sidebar() {
  const open_ = workspaces().filter((p) => p.kind === 'folder' || L.tabs(layout(p.id)).length + layout(p.id).background.length > 0);
  const loose = L.tabs(layout(LOOSE)).length + layout(LOOSE).background.length > 0;
  const need = openQuestions().length;
  const first = !open_.length && !loose;
  return (
    <aside class="side" id="sidebar" aria-label="Sidebar">
      <div class="side-top" data-tauri-drag-region>
        {!mac && <MenuButton run={command} />}
        <button type="button" class="ib" title={tip('Hide sidebar', '⌃⌘S')} aria-label="Hide sidebar" onClick={() => command('sidebar')}><I n="sidebar" /></button>
      </div>
      <nav class="tree" aria-label="Home and workspaces">
        <button type="button" class={`row home${ui.view === 'home' || ui.view === 'earlier' ? ' sel' : ''}`} aria-current={ui.view === 'home' ? 'page' : undefined}
          onClick={() => show('home')}>
          <I n="home" /><span class="lbl">Home</span>
          {need > 0 && <span class="cnt" title={need === 1 ? '1 needs you' : `${need} need you`}>{need}</span>}
        </button>
        <div class={`sec${first ? ' first' : ''}`}>
          <span>Workspaces</span>
          <button type="button" class="ib" title={tip('Open a folder', '⌘O')} aria-label="Open a folder" onClick={() => open({ kind: 'open-workspace' })}><I n="plus" /></button>
        </div>
        {open_.map((p) => <Workspace key={p.id} id={p.id} name={p.name} folder={p.folder} />)}
        {loose && <Workspace id={LOOSE} name="Sign-in terminals" />}
      </nav>
      <Spark />
    </aside>
  );
}