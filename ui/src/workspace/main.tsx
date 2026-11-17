// The workspace window: the sidebar, the title bar, Home or Earlier or a workspace's panes, the rail at its foot, and
// the sheet that hangs from the title bar. Instrument (design/ui-directions/NOTES.md §6).
import '../tokens.css';
import '../parts.css';
import '@xterm/xterm/css/xterm.css';
import '../motion/motion.css';
import './fonts.css';
import './window.css';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { render } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { cap } from '../capture.tsx';
import { trail } from '../trail.ts';
import { ambient } from './ambient.ts';
import { I, Mark, Wave, plural } from '../ui.tsx';
import { apply, fontsReady, look } from './appearance.ts';
import { Deck, startAgent } from './deck.tsx';
import { Earlier, Header, Home, homeCounts } from './home.tsx';
import { stats } from '../motion/engine.ts';
import { debug } from '../motion/motion.tsx';
import * as L from './layout.ts';
import { burst, echo } from './measure.ts';
import { choose, shown as menu } from './menu.ts';
import {
  LOOSE, agentName, call, client, closeTab, copy, current, dismiss, fail, focusSession, layout, newTerminal, onRedraw, open, page, paste,
  records, redraw, reconcile, sessionOf, setLayout, settleFocus, show, textSize, textSizeBy, ui,
} from './model.ts';
import { Sheets } from './sheets.tsx';
import { Sidebar } from './sidebar.tsx';
import { engines, setLook } from './terminal.ts';

/** Below this width the sidebar hides, and its toggle and the window's buttons move into the title bar. */
const NARROW = 800;

/** The menu's and the keyboard's commands, by the ids the host's menu sends. */
export function command(id: string) {
  const c = current();
  const pane = c?.pane;
  switch (id) {
    case 'new-task':
      cap.dest = c && c.project !== LOOSE ? c.project : cap.dest;
      cap.current = c?.id ? (sessionOf(c.id)?.id ?? null) : null;
      page.focus = '#capture-input';
      return open({ kind: 'capture' });
    case 'new-terminal':
      return c ? void newTerminal(c.project, { into: pane }) : open({ kind: 'open-workspace' });
    case 'open-workspace':
      return open({ kind: 'open-workspace' });
    case 'appearance':
    case 'settings':
      return open({ kind: 'settings' });
    case 'close-tab':
      return c?.id && closeTab(c.project, c.id);
    case 'find':
      if (ui.view === 'earlier' || ui.view === 'home') return show('earlier');
      return c?.id && open({ kind: 'find', id: c.id });
    case 'copy':
      return c?.id && void copy(c.id);
    case 'paste':
      return c?.id && void paste(c.id);
    case 'split-right':
    case 'split-down':
      return c && void newTerminal(c.project, { into: pane, axis: id === 'split-right' ? 'x' : 'y' });
    case 'bigger':
    case 'smaller':
    case 'reset':
      return c?.id && textSizeBy(c.id, id === 'bigger' ? 1 : id === 'smaller' ? -1 : 0);
    case 'sidebar':
      return toggleSidebar();
    case 'focus':
      return c && setLayout(c.project, L.toggleFocus(layout(c.project)));
    case 'back':
      return ui.view === 'earlier' && show('home');
  }
}

/** The sidebar slides in and out; its edge leaves a short trail of glyphs on the window it passes (trail.ts). */
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let sliding = false;
function toggleSidebar() {
  if (ui.narrow) return void ((ui.peek = !ui.peek), redraw());
  const side = document.querySelector<HTMLElement>('.side');
  const box = side?.getBoundingClientRect();
  const glyphs = ambient() !== 'off';
  if (ui.sidebar && side && box && !reduced.matches) {
    if (sliding) return;
    sliding = true;
    trail({ box, axis: 'x', back: true, ms: 200 }, glyphs);
    side.animate([{ transform: 'none' }, { transform: 'translateX(-100%)' }], { duration: 200, easing: 'cubic-bezier(.45,0,.5,1)' })
      .finished.then(() => ((sliding = false), (ui.sidebar = false), redraw()), () => (sliding = false));
    return;
  }
  ui.sidebar = !ui.sidebar;
  redraw();
  if (!ui.sidebar || reduced.matches) return;
  requestAnimationFrame(() => {
    const s = document.querySelector<HTMLElement>('.side');
    if (!s) return;
    s.classList.add('opening');
    trail({ box: s.getBoundingClientRect(), axis: 'x', ms: 240 }, glyphs);
    s.animate([{ transform: 'translateX(-100%)' }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.19,.76,.19,1)' })
      .finished.then(() => s.classList.remove('opening'), () => {});
  });
}

/** ⌘ shortcuts, handled before xterm.js or the web view can treat them as input or zoom. The application menu shows
 *  the same; a key the page handles never reaches it twice. While a sheet is open, the sheet has the keys. */
const keys: Record<string, string> = { n: 'new-task', t: 'new-terminal', o: 'open-workspace', w: 'close-tab', f: 'find', d: 'split-right',
  '=': 'bigger', '+': 'bigger', '-': 'smaller', '0': 'reset', ',': 'settings', '[': 'back' };
document.addEventListener('keydown', (e) => {
  if (!e.metaKey || e.ctrlKey || e.altKey || e.isComposing || ui.sheet) return;
  const k = e.key.toLowerCase();
  const inTerminal = !!(e.target as HTMLElement).closest?.('.xterm');
  // ⌘C copies a terminal's selection; elsewhere the Edit menu copies as usual.
  if (k === 'c' && inTerminal && !e.shiftKey) {
    const id = current()?.id;
    if (!id || !engines.get(id)?.term.hasSelection()) return;
    e.preventDefault();
    return void copy(id);
  }
  const name = k === 'd' && e.shiftKey ? 'split-down' : e.shiftKey && k !== '+' ? undefined : keys[k];
  if (!name) return;
  // In a text field, only the commands that are not editing keys.
  if ((e.target as HTMLElement).closest?.('input, textarea:not(.xterm-helper-textarea)') && ['-', '=', '+', '0', '['].includes(k)) return;
  e.preventDefault();
  e.stopPropagation();
  command(name);
}, true);

/** The terminals take the person's look at once, and again whenever they change it (Settings). */
export function loadLook() {
  const l = look();
  apply(l);
  setLook(l, textSize);
  redraw();
}

/** The title bar: the workspace's name and folder, and Split right, Split down and New task; on Home, "Home". */
function Bar({ project }: { project: string | null }) {
  const p = project ? records.projects.get(project) : undefined;
  const side = ui.sidebar && !ui.narrow;
  return (
    <header class="bar" data-tauri-drag-region>
      {!side && <span class="lights" />}
      {!side && <button type="button" class="ib" title="Show sidebar  ⌃⌘S" aria-label="Show sidebar" onClick={() => command('sidebar')}><I n="sidebar" /></button>}
      {project ? (
        <span class="crumb" data-tauri-drag-region>
          <b>{p?.name ?? 'Sign-in terminals'}</b>{p && <span class="path">{p.folder.replace(/^\/Users\/[^/]+/, '~')}</span>}
        </span>
      ) : ui.view === 'earlier' ? (
        <span class="crumb">
          <button type="button" class="back" title="Back to Home  ⌘[" onClick={() => show('home')}><I n="chev" /><span>Home</span></button>
          <b class="sub">Earlier</b>
        </span>
      ) : ui.head === 'bar' ? <Header invite={false} bar /> : null}
      {project && (
        <span class="bar-r">
          <button type="button" class="ib" title="Split right  ⌘D" aria-label="Split right" onClick={() => command('split-right')}><I n="splitr" /></button>
          <button type="button" class="ib" title="Split down  ⇧⌘D" aria-label="Split down" onClick={() => command('split-down')}><I n="splitd" /></button>
          <button type="button" class="newt" title="New task  ⌘N" onClick={() => command('new-task')}><Wave n={5} /><span>New task</span><kbd>⌘N</kbd></button>
        </span>
      )}
    </header>
  );
}

/** The rail: the glance in words, at the left; the installed agents and Settings, at the right. */
function Rail() {
  const c = homeCounts();
  const agents = [...records.agents.values()].filter((a) => a.installed);
  const words = [
    c.needs > 0 && <b>{plural(c.needs, 'needs you', 'need you')}</b>,
    c.working > 0 && <span>{c.working} working</span>,
    c.waiting > 0 && <span>{c.waiting} to keep</span>,
    c.fresh - c.waiting > 0 && <span>{plural(c.fresh - c.waiting, 'new result', 'new results')}</span>,
  ].filter(Boolean);
  const mark = c.needs ? 'asks' : c.working ? 'working' : c.fresh ? 'ready' : 'ended';
  return (
    <footer class="rail">
      <span class="rail-l" role="status">
        {page.error ? <span class="err">{page.error}</span> : <><Mark s={mark} label="" />{words.length ? words : <span>Nothing running</span>}</>}
      </span>
      <span class="rail-r">
        {agents.map((a) => (
          <button type="button" class={a.signed_in === false ? 'off' : ''} title={`${agentName(a.id)}${a.version ? ` ${a.version}` : ''}, ${a.signed_in === false ? 'not signed in' : 'signed in'}`}
            onClick={() => open({ kind: 'agents' })}>{agentName(a.id)}</button>
        ))}
        <button type="button" class="plain" title="Settings  ⌘," onClick={() => open({ kind: 'settings' })}>Settings</button>
      </span>
    </footer>
  );
}

function App() {
  const [, tick] = useState(0);
  onRedraw(() => tick((n) => n + 1));
  const project = ui.view === LOOSE || records.projects.get(ui.view)?.open ? ui.view : null;
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('narrow', ui.narrow);
    settleFocus();
  });
  const side = ui.sidebar && !ui.narrow;
  return (
    <div class={`win${side ? '' : ' solo'}${ui.sheet ? ' dimmed' : ''}${ui.narrow && ui.peek ? ' peek' : ''}`}>
      {(side || (ui.narrow && ui.peek)) && <Sidebar />}
      <main class="main">
        <Bar project={project} />
        {project ? <Deck key={project} project={project} /> : ui.view === 'earlier' ? <Earlier /> : <Home />}
      </main>
      <Rail />
      <Sheets />
    </div>
  );
}

records.onchange = () => {
  reconcile();
  redraw();
};
void listen<{ do: string; at?: string; id?: string }>('ui', ({ payload }) => {
  if (payload.do === 'focus' && payload.at) focusSession(payload.at);
  else if (payload.do === 'menu' && payload.id) command(payload.id);
});
const narrow = () => {
  const n = innerWidth < NARROW;
  if (n !== ui.narrow) (ui.narrow = n), redraw();
};
addEventListener('resize', narrow);
narrow();
// The terminal's faces are loaded before the first terminal measures its cells.
await fontsReady();
render(<App />, document.body);
// Whether the window is the one in use, from the host's own account of it.
const win = getCurrentWindow();
void win.isFocused().then((f) => ((ui.active = f), redraw()), () => {});
void win.onFocusChanged(({ payload }) => ((ui.active = payload), document.documentElement.classList.toggle('inactive', !payload), redraw()));
// The window shows once the page has laid out its first frame (a hidden window draws nothing).
loadLook();
setTimeout(() => void call('host.ready', {}).catch(() => {}));
void client
  .sub(['thoughts', 'projects', 'sessions', 'terminals', 'questions', 'results', 'layouts', 'prefs', 'agents'], records)
  .then(() => {
    ui.ready = true;
    reconcile();
    const at = new URLSearchParams(location.search).get('focus');
    if (at) focusSession(at);
    else show(ui.view);
  })
  .catch(fail);

// For the debug channel's checks and measurements (host/scripts/smoke.sh, measure.sh).
/** A terminal's screen as text (the WebGL renderer has no text in the page to read). */
const text = (id = current()?.id) => {
  const term = id ? engines.get(id)?.term : undefined;
  if (!term) return null;
  const b = term.buffer.active;
  return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? '').join('\n').trimEnd();
};
/** Types a line into the terminal shown, as the keyboard would. */
const type = (line: string) => (engines.get(current()?.id ?? '')?.term.input(line + '\r', true), !!current()?.id);
Object.assign(window, {
  __ws: { ui, records, layout, command, engines, focusSession, show, newTerminal, startAgent, call, echo, burst, text, type, current, dismiss, menu, choose, LOOSE, L },
  __motion: { debug, stats, redraw },
});
