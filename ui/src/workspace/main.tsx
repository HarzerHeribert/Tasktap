// The workspace window: the sidebar, Home or a workspace's surfaces, and one dialog. 1.2's
// stylesheets are linked in 1.2's order so its class names keep their look.
import './styles.css';
import { listen } from '@tauri-apps/api/event';
import { render } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { cap } from '../capture.tsx';
import { Icon } from '../icons.tsx';
import { type Look, apply, ghostty, neutral } from './appearance.ts';
import { Deck } from './deck.tsx';
import { Dialogs } from './dialogs.tsx';
import { Home } from './home.tsx';
import * as L from './layout.ts';
import { burst, echo } from './measure.ts';
import {
  LOOSE, call, client, closeTab, copy, current, fail, focusSession, layout, newTerminal, onRedraw, open, page, records, redraw,
  reconcile, sessionOf, setLayout, settleFocus, show, textSize, textSizeBy, ui,
} from './model.ts';
import { Sidebar } from './sidebar.tsx';
import { engines, setLook } from './terminal.ts';

/** The menu's and the keyboard's commands, by the ids the host's menu sends. */
export function command(id: string) {
  const c = current();
  const pane = c?.pane;
  switch (id) {
    case 'new-task':
      cap.dest = c && c.project !== LOOSE ? c.project : cap.dest;
      cap.current = c?.id ? (sessionOf(c.id)?.id ?? null) : null;
      page.focus = '#guide-input';
      return open({ kind: 'capture' });
    case 'new-terminal':
      return c ? void newTerminal(c.project, { into: pane }) : open({ kind: 'open-workspace' });
    case 'open-workspace':
      return open({ kind: 'open-workspace' });
    case 'close-tab':
      return c?.id && closeTab(c.project, c.id);
    case 'find':
      return c?.id && open({ kind: 'find', id: c.id });
    case 'split-right':
    case 'split-down':
      return c && void newTerminal(c.project, { into: pane, axis: id === 'split-right' ? 'x' : 'y' });
    case 'bigger':
    case 'smaller':
    case 'reset':
      return c?.id && textSizeBy(c.id, id === 'bigger' ? 1 : id === 'smaller' ? -1 : 0);
    case 'sidebar':
      ui.sidebar = !ui.sidebar;
      return redraw();
    case 'focus':
      return c && setLayout(c.project, L.toggleFocus(layout(c.project)));
  }
}

/** ⌘ shortcuts, handled before xterm.js or the web view can treat them as input or zoom. The
 *  application menu shows the same; a key the page handles never reaches it twice. */
const keys: Record<string, string> = { n: 'new-task', t: 'new-terminal', o: 'open-workspace', w: 'close-tab', f: 'find', d: 'split-right',
  '=': 'bigger', '+': 'bigger', '-': 'smaller', '0': 'reset' };
document.addEventListener('keydown', (e) => {
  if (!e.metaKey || e.ctrlKey || e.altKey || e.isComposing || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  const inTerminal = !!(e.target as HTMLElement).closest?.('.deck-terminal');
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
  if ((e.target as HTMLElement).closest?.('input, textarea:not(.xterm-helper-textarea)') && ['-', '=', '+', '0'].includes(k)) return;
  e.preventDefault();
  e.stopPropagation();
  command(name);
}, true);

let look: Look = neutral();
async function loadLook() {
  const a = await call('host.appearance', {}).catch(() => null);
  look = a?.ghostty && a.config ? ghostty(a.config) : neutral();
  apply(look);
  setLook(look, textSize);
  redraw();
}

function App() {
  const [, tick] = useState(0);
  onRedraw(() => tick((n) => n + 1));
  const project = ui.view === LOOSE || records.projects.get(ui.view)?.open ? ui.view : null;
  useLayoutEffect(() => {
    const body = document.body.classList;
    body.toggle('workspace-active', !!project);
    body.toggle('deck-focus', !!project && layout(project).focus);
    body.toggle('deck-sidebar-hidden', !ui.sidebar);
    settleFocus();
  });
  return (
    <>
      <div class="shell">
        <Sidebar />
        <div class="work">
          {!project && (
            <header class="toolbar" data-tauri-drag-region>
              <div class="crumb">
                <button type="button" class="icon-btn menu-toggle" aria-label="Toggle sidebar" onClick={() => command('sidebar')}><Icon name="side" /></button>
                <strong id="crumb">Home</strong>
              </div>
              <div class="toolbar-actions">
                <button type="button" class="primary" onClick={() => command('new-task')}><Icon name="plus" /><span>New task</span><kbd>⌘N</kbd></button>
              </div>
            </header>
          )}
          {project ? (
            <section id="workspace-stage" aria-label="Project workspace"><Deck key={project} project={project} /></section>
          ) : (
            <Home />
          )}
        </div>
      </div>
      <Dialogs />
      <div class="toast" id="toast" role="status">{ui.toast || page.error}</div>
    </>
  );
}

records.onchange = () => {
  reconcile();
  redraw();
};
void listen<{ do: string; at?: string; id?: string }>('ui', ({ payload }) => {
  if (payload.do === 'focus' && payload.at) focusSession(payload.at);
  else if (payload.do === 'menu' && payload.id) command(payload.id);
  else if (payload.do === 'appearance') void loadLook();
});
render(<App />, document.body);
// The window shows once the page has laid out its first frame (a hidden window draws nothing).
void loadLook().then(() => setTimeout(() => void call('host.ready', {}).catch(() => {})));
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
  __ws: { ui, records, layout, command, engines, focusSession, show, newTerminal, call, echo, burst, text, type, current, LOOSE, L },
});
