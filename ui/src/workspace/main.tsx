// The workspace window: the sidebar, the title bar, Home or Earlier or a workspace's panes, the rail at its foot, and
// the sheet that hangs from the title bar. Instrument (design/ui-directions/NOTES.md §6).
import '../tokens.css';
import '../parts.css';
import '@xterm/xterm/css/xterm.css';
import '../motion/motion.css';
import './fonts.css';
import './window.css';
import '../way.css';
import './consent.css';
import '../scroll.ts';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { render } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { cap, followSpeech } from '../capture.tsx';
import { uuid7 } from '../client.ts';
import { LevelVoice } from '../speech/level.ts';
import { live, loudness, recording, talk } from '../speech/record.ts';
import { I, Mark, Wave, plural } from '../ui.tsx';
import { apply, fontsReady, look } from './appearance.ts';
import { Deck, startAgent } from './deck.tsx';
import { Earlier, Home, homeCounts } from './home.tsx';
import { wakeLook } from './light.tsx';
import { setVoice, stats } from '../motion/engine.ts';
import type { Voice } from '../motion/voice.ts';
import { debug } from '../motion/motion.tsx';
import * as L from './layout.ts';
import { burst, echo } from './measure.ts';
import { choose, shown as menu } from './menu.ts';
import {
  LOOSE, call, client, closeTab, copy, current, dismiss, fail, focusSession, layout, loadTerms, newTerminal, onRedraw, open, page, paste,
  pref, records, redraw, reconcile, sessionOf, setLayout, settleFocus, show, textSize, textSizeBy, ui,
} from './model.ts';
import { Sheets } from './sheets.tsx';
import { Sidebar } from './sidebar.tsx';
import { engines, flushFits, setLook } from './terminal.ts';
import { wake } from './wake.ts';

/** Below this width the sidebar hides, and its toggle and the window's buttons move into the title bar. */
const NARROW = 800;

/** The menu's and the keyboard's commands, by the ids the host's menu sends. */
export function command(id: string) {
  const c = current();
  const pane = c?.pane;
  switch (id) {
    case 'new-task':
      // A thought begun in a workspace goes to its folder unless the person, its words or a model say otherwise.
      cap.usual = c && c.project !== LOOSE ? c.project : cap.usual;
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

/** The sidebar slides in and out, and what is beside it moves with its edge the whole way, on one curve: it is the
 *  window's own column that narrows or widens (window.css side-in, side-out), so nothing is left to jump at the end,
 *  and the title makes room for the window's buttons as it goes. A terminal keeps its size while it slides and is
 *  fitted once when the slide is over (terminal.ts queueFit). Its edge sheds a wake behind it as it goes (wake.ts). */
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
function toggleSidebar() {
  if (ui.narrow) return void ((ui.peek = !ui.peek), redraw());
  if (ui.slide) return;
  if (reduced.matches || document.hidden) return void ((ui.sidebar = !ui.sidebar), redraw());
  ui.slide = ui.sidebar ? 'out' : 'in';
  ui.sidebar = true;
  redraw();
}
function slid() {
  ui.sidebar = ui.slide === 'in';
  ui.slide = '';
  redraw();
  setTimeout(flushFits);
}

/** A region answers when it takes focus: the sidebar's glyphs step forward; on Home the light lifts and its chrome
 *  stirs; among terminals a glint runs along the focused tab's lit edge (window.css data-greet; light.tsx). Once per
 *  entry, by the pointer or the keyboard, and once for the region that has focus when the window comes back into
 *  use: never for typing, scrolling or a click inside the region it is in, never restarted while it runs, at most
 *  once a second for a region, and not at all under Reduce Motion or with the ambient light Still or Off. */
type Region = 'side' | 'main';
const greeted: Record<Region, number> = { side: 0, main: 0 };
let region: Region | '' = '';
function greet(r: Region) {
  const now = performance.now();
  if (ui.greet || now - greeted[r] < 1200 || reduced.matches || pref('motion_ambient') !== 'breathing') return;
  greeted[r] = now;
  ui.greet = r;
  redraw();
  setTimeout(() => ((ui.greet = ''), redraw()), 1100);
}
function enter(e: Event) {
  const at = e.target instanceof Element ? e.target : null;
  const r: Region | '' = at?.closest('.side') ? 'side' : at?.closest('.main') ? 'main' : '';
  if (r && region && r !== region) greet(r);
  region = r || region;
}
document.addEventListener('pointerdown', enter, true);
document.addEventListener('focusin', enter, true);

/** ⌘ shortcuts, handled before xterm.js or the web view can treat them as input or zoom. The application menu shows
 *  the same; a key the page handles never reaches it twice. While a sheet is open, the sheet has the keys. */
const keys: Record<string, string> = { n: 'new-task', t: 'new-terminal', o: 'open-workspace', w: 'close-tab', f: 'find', d: 'split-right',
  '=': 'bigger', '+': 'bigger', '-': 'smaller', '0': 'reset', ',': 'settings', '[': 'back' };
document.addEventListener('keydown', (e) => {
  if (!e.metaKey || e.ctrlKey || e.altKey || e.isComposing || ui.sheet) return;
  const k = e.key.toLowerCase();
  const inTerminal = !!(e.target as HTMLElement).closest?.('.xterm');
  // ⌘↓ returns a terminal scrolled back to its end.
  if (k === 'arrowdown' && inTerminal) return (e.preventDefault(), void engines.get(current()?.id ?? '')?.term.scrollToBottom());
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

/** The terminals take the look the core's preferences describe. */
function loadLook() {
  const l = look();
  apply(l);
  setLook(l, textSize);
}

/** The title bar says where you are only where nothing beside it does: a workspace's name with its folder, Earlier
 *  with the way back, and "Home" while the sidebar, whose selected row says it, is away. With the sidebar open on
 *  Home it carries nothing. */
function Bar({ project }: { project: string | null }) {
  const p = project ? records.projects.get(project) : undefined;
  const side = ui.sidebar && !ui.narrow && !ui.slide;
  return (
    <header class="bar" data-tauri-drag-region>
      {/* Room for the window's buttons, and the way back to the sidebar: there while it is away, and on its way. */}
      {!side && <span class="lead"><button type="button" class="ib" title="Show sidebar  ⌃⌘S" aria-label="Show sidebar" onClick={() => command('sidebar')}><I n="sidebar" /></button></span>}
      {project ? (
        <span class="crumb" data-tauri-drag-region>
          <b>{p?.name ?? 'Sign-in terminals'}</b>{p && <span class="path">{p.folder.replace(/^\/Users\/[^/]+/, '~')}</span>}
        </span>
      ) : ui.view === 'earlier' ? (
        <span class="crumb">
          <button type="button" class="back" title="Back to Home  ⌘[" onClick={() => show('home')}><I n="chev" /><span>Home</span></button>
          <b class="sub">Earlier</b>
        </span>
      ) : <span class="crumb" data-tauri-drag-region>{!side && <b>Home</b>}</span>}
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

/** The rail: the glance in words, at the left; Agents and Settings, at the right. */
function Rail() {
  const c = homeCounts();
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
        <button type="button" onClick={() => open({ kind: 'agents' })}>Agents</button>
        <button type="button" title="Settings  ⌘," onClick={() => open({ kind: 'settings' })}>Settings</button>
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
  // The terminals follow their preferences at once and as they change, from this window or another.
  useLayoutEffect(loadLook, [pref('terminal_font'), pref('terminal_size'), pref('terminal_line_height')]);
  // As it slides the sidebar's edge sheds its wake along its foot, where no row is.
  useLayoutEffect(() => {
    const side = document.querySelector<HTMLElement>('.side'), foot = side?.querySelector('.spark')?.getBoundingClientRect();
    if (ui.slide && side && foot) wake(side, 'x', wakeLook(), [foot.top + 28, foot.bottom]);
  }, [ui.slide]);
  const side = ui.sidebar && !ui.narrow;
  return (
    <div class={`win${side ? '' : ' solo'}${ui.sheet ? ' dimmed' : ''}${ui.narrow && ui.peek ? ' peek' : ''}`} data-slide={ui.slide || undefined} data-greet={ui.greet || undefined}
      onAnimationEnd={(e) => e.target === e.currentTarget && ui.slide && slid()}>
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

/** While a dictation records, whichever page records it, the motion listens: its form answers the level the core
 *  reports for the recording (speech/level.ts), which stands in for a voice of the motion's own. */
const heard = new LevelVoice(loudness);
let hears = false;
function listenToSpeech() {
  if (recording() === hears) return;
  hears = ui.voice = !hears;
  setVoice(hears ? (heard as unknown as Voice) : null);
}
records.onchange = () => {
  followSpeech();
  listenToSpeech();
  reconcile();
  redraw();
};
/** Where the host, or the notch through it, sends the window: a session's terminal, or a part of Settings. */
function arrive(at: string) {
  if (at === 'settings:speech' || at === 'settings:thoughts') open({ kind: 'settings', at: at === 'settings:speech' ? 'speech' : 'thoughts' });
  else focusSession(at);
}
void listen<{ do: string; at?: string; id?: string }>('ui', ({ payload }) => {
  if (payload.do === 'focus' && payload.at) arrive(payload.at);
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
void win.onFocusChanged(({ payload }) => {
  ui.active = payload;
  document.documentElement.classList.toggle('inactive', !payload);
  redraw();
  // Back in use: the region that has the focus answers, as a greeting.
  if (payload) greet(region || 'main');
});
// The window shows once the page has laid out its first frame (a hidden window draws nothing).
setTimeout(() => void call('host.ready', {}).catch(() => {}));
void client
  .sub(['thoughts', 'projects', 'sessions', 'terminals', 'questions', 'results', 'layouts', 'prefs', 'agents', 'dictations'], records)
  .then(() => {
    ui.ready = true;
    reconcile();
    const at = new URLSearchParams(location.search).get('focus');
    if (at) arrive(at);
    else show(ui.view);
    void loadTerms();
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
/** Slides the sidebar and says, frame by frame, where the content's left edge and the title stood, and where they
 *  rest two frames after it ended: a slide with no jump ends where it rests. */
const slide = () => new Promise((done) => {
  const at = () => ['.main', '.crumb'].map((s) => Math.round(document.querySelector(s)!.getBoundingClientRect().left * 10) / 10);
  const frames: number[][] = [];
  command('sidebar');
  const tick = () => {
    frames.push(at());
    if (ui.slide || frames.length < 2) requestAnimationFrame(tick);
    else requestAnimationFrame(() => requestAnimationFrame(() => done({ frames, rest: at(), cols: [...engines.values()].map((e) => e.term.cols) })));
  };
  requestAnimationFrame(tick);
});
/** Types a line into the terminal shown, as the keyboard would. */
const type = (line: string) => (engines.get(current()?.id ?? '')?.term.input(line + '\r', true), !!current()?.id);
Object.assign(window, {
  __ws: { uuid7, ui, records, layout, command, greet, slide, engines, focusSession, show, newTerminal, startAgent, call, echo, burst, text, type, current, dismiss, menu, choose, LOOSE, L },
  __motion: { debug, stats, redraw },
  __speech: { talk, live, cap },
});
