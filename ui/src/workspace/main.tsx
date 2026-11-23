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
import { render } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { cap, followSpeech, invite } from '../capture.tsx';
import { AGENT_KEY, open as openAgents } from '../rings.tsx';
import { WEIGHT_KEY, open as openWeights } from '../weights.tsx';
import { type HostUpdate, uuid7 } from '../client.ts';
import { LevelVoice } from '../speech/level.ts';
import { audio, live, loudness, recording, talk } from '../speech/record.ts';
import { Brand, I, Key, Mark, plural } from '../ui.tsx';
import { COMMANDS, commands, hit, keyName, recorder, tip, watchLayout } from '../keys.ts';
import { mac, shownPath, titled } from '../system.ts';
import { Caps, MenuButton, heard as captionSaid, openMenu } from './chrome.tsx';
import { apply, fontsReady, look } from './appearance.ts';
import { Deck, startAgent } from './deck.tsx';
import { follow, refresh, reload, stop, swap } from './preview.tsx';
import { Earlier, Home, homeCounts } from './home.tsx';
import { Welcome, firstStart, welcome } from './welcome.tsx';
import { effects, power, wakeLook } from './light.tsx';
import { setVoice, stats } from '../motion/engine.ts';
import { debug } from '../motion/motion.tsx';
import * as L from './layout.ts';
import { burst, echo } from './measure.ts';
import { choose, shown as menu } from './menu.ts';
import {
  LOOSE, agentName, answerKey, applyOut, askGlobalKeys, call, client, closeTab, copy, core, current, details, dismiss, fail, focus, focusSession, heardWhere, layout, loadTerms, newTerminal, onRedraw,
  open, openQuestions, page, paste, popOut, pref, windowLabel, records, recordsFailed, recordsIn, redraw, reconcile, sessionOf, setLayout, settleFocus, show, watchHeld, textSize, textSizeBy, title, ui, where,
} from './model.ts';
import type { Where } from '../client.ts';
import { SECTIONS, shown } from './settings.tsx';
import { askUpdate, heard as updateSaid, waiting } from './update.tsx';
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
  // Home and Settings, and opening a folder, are the main window's: a workspace's own window asks for them there.
  if (ui.only && (id === 'open-workspace' || id === 'settings')) return void call('host.window', { do: 'menu', id }).catch(fail);
  switch (id) {
    case 'new-task':
      // A thought begun in a workspace goes to its folder unless the person, a session it follows or a model say
      // otherwise: in this sheet, until it is put away.
      Object.assign(cap, { usual: c && c.project !== LOOSE ? c.project : undefined, back: undefined });
      cap.current = c?.id ? (sessionOf(c.id)?.id ?? null) : null;
      page.focus = '#capture-input';
      return open({ kind: 'capture' });
    case 'new-terminal':
      return c ? void newTerminal(c.project, { into: pane }) : open({ kind: 'open-workspace' });
    case 'open-workspace':
      return open({ kind: 'open-workspace' });
    case 'pop-out':
      return c && popOut(c.project);
    // Settings opens where it was last, and stays as it is when it is open already.
    case 'appearance':
    case 'settings':
      return (id === 'appearance' || ui.sheet?.kind !== 'settings') && open({ kind: 'settings', at: id === 'appearance' ? id : shown.at });
    // ⌘W closes what is in front: a sheet, when one is.
    case 'close-tab':
      return ui.sheet ? dismiss() : c && (c.preview ?? c.id) && closeTab(c.project, (c.preview ?? c.id)!);
    // A preview: read anew; and the keyboard between a terminal and the preview beside it.
    case 'reload-preview':
      return reload();
    case 'preview':
      return swap();
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
      return !ui.only && toggleSidebar();
    case 'focus':
      return c && setLayout(c.project, L.toggleFocus(layout(c.project)));
    case 'back':
      return ui.view === 'earlier' && show('home');
    case 'session':
      return void details(c?.id);
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
 *  once a second for a region, and not at all below Full on the effects control. */
type Region = 'side' | 'main';
const greeted: Record<Region, number> = { side: 0, main: 0 };
let region: Region | '' = '';
function greet(r: Region) {
  const now = performance.now();
  if (ui.greet || now - greeted[r] < 1200 || effects() !== 'full') return;
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

/** The commands' keys are written as the Mac has them, and each system has its own key for each (keys.ts). They are
 *  handled here, before xterm.js or the web view can treat them as input or zoom. On the Mac the application menu shows the
 *  same, and a key the page handles never reaches it twice; on Windows the window's menu button shows them. While a
 *  sheet is open, the sheet has the keys. */
const KEYS = COMMANDS;
document.addEventListener('keydown', (e) => {
  if (e.isComposing || ui.sheet) return;
  // The Mac's menu has the keys held with Control (⌃⌘S).
  if (mac && e.ctrlKey) return;
  // ⌘J on Home, wherever its keyboard is: who runs the thought, the list open in the Composer (the review's N4). In
  // the Composer its form takes it (and closes the list with it).
  if (ui.view === 'home' && hit(AGENT_KEY, e) && !(e.target as HTMLElement).closest?.('.home form.capture') && document.querySelector('.home .cap-agent:not([aria-disabled])')) return (e.preventDefault(), openAgents(true));
  // ⌘L the same for how heavy it is, where the Composer has the control.
  if (ui.view === 'home' && hit(WEIGHT_KEY, e) && !(e.target as HTMLElement).closest?.('.home form.capture') && document.querySelector('.home .cap-weight')) return (e.preventDefault(), openWeights(true));
  const inTerminal = !!(e.target as HTMLElement).closest?.('.xterm');
  const id = current()?.id, term = inTerminal && id ? engines.get(id)?.term : undefined;
  // ⌘↓ returns a terminal scrolled back to its end.
  if (term && hit('⌘↓', e)) return (e.preventDefault(), void term.scrollToBottom());
  // ⌘C copies a terminal's selection; elsewhere the Edit menu copies as usual. On Windows Control-C copies it too
  // while there is one, and is the program's otherwise; and paste, which the Mac's Edit menu does, is done here.
  if (term && (hit('⌘C', e) || (!mac && hit('⌃C', e)))) {
    if (!term.hasSelection()) return void (!mac && e.shiftKey && e.preventDefault());
    e.preventDefault();
    if (!mac) e.stopPropagation();
    return void copy(id!).then(() => mac || term.clearSelection());
  }
  if (term && !mac && (hit('⌘V', e) || hit('⌃V', e))) return (e.preventDefault(), e.stopPropagation(), void paste(id!));
  // The key that types + is Shift with = on some keyboards and a key of its own on others.
  const name = Object.keys(KEYS).find((n) => hit(KEYS[n]!, e)) ?? (commands(e) && e.key === '+' ? 'bigger' : undefined);
  if (!name) return;
  // In a text field, only the commands that are not editing keys.
  if ((e.target as HTMLElement).closest?.('input, textarea:not(.xterm-helper-textarea)') && ['bigger', 'smaller', 'reset', 'back'].includes(name)) return;
  e.preventDefault();
  e.stopPropagation();
  command(name);
}, true);

// Windows: Alt pressed and let go alone, or F10, opens the menu, as a menu bar's keys do. Alt held with any other key
// is that key's.
if (!mac) {
  let alone = false;
  document.addEventListener('keydown', (e) => {
    alone = e.key === 'Alt' && !e.repeat && !e.ctrlKey && !e.shiftKey && !e.metaKey;
    if (e.key === 'F10' && !e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && !recorder.on) (e.preventDefault(), e.stopPropagation(), openMenu(command));
  }, true);
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Alt' && alone && !recorder.on) (e.preventDefault(), openMenu(command));
    alone = false;
  }, true);
  addEventListener('blur', () => (alone = false));
  document.addEventListener('pointerdown', () => (alone = false), true);
}
document.documentElement.classList.toggle('windows', !mac);
document.documentElement.classList.toggle('titled', titled);

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
    <header class={`bar${project || ui.view === 'earlier' ? '' : ' bare'}`} data-tauri-drag-region>
      {/* Room for the window's buttons, and the way back to the sidebar: there while it is away, and on its way. */}
      {!side && <span class="lead">{!mac && <MenuButton run={command} />}{!ui.only && <button type="button" class="ib" title={tip('Show sidebar', '⌃⌘S')} aria-label="Show sidebar" onClick={() => command('sidebar')}><I n="sidebar" /></button>}</span>}
      {project ? (
        <span class="crumb" data-tauri-drag-region>
          <b>{p?.name ?? 'Sign-in terminals'}</b>{p && <span class="path">{shownPath(p.folder)}</span>}
        </span>
      ) : ui.view === 'earlier' ? (
        <span class="crumb">
          <button type="button" class="back" title={tip('Back to Home', '⌘[')} onClick={() => show('home')}><I n="chev" /><span>Home</span></button>
          <b class="sub">Earlier</b>
        </span>
      ) : <span class="crumb" data-tauri-drag-region>{!side && <b>Home</b>}</span>}
      {where.place === 'line' && ui.active && <AsksLine />}
      {project && (
        <span class="bar-r">
          <button type="button" class="ib" title={tip('Split right', '⌘D')} aria-label="Split right" onClick={() => command('split-right')}><I n="splitr" /></button>
          <button type="button" class="ib" title={tip('Split down', '⇧⌘D')} aria-label="Split down" onClick={() => command('split-down')}><I n="splitd" /></button>
          <button type="button" class="newt" title={tip('New task', '⌘N')} onClick={() => command('new-task')}><span><Brand />New task</span><Key k="⌘N" /></button>
        </span>
      )}
      {titled && <Caps />}
    </header>
  );
}

/** A question waits and the window shows neither Home nor the terminal it is asked in: one quiet line in the title
 *  bar leads to it (docs/rebuild-plan.md, "Where Tasktap shows itself", rule 1). Who asks and what, cut to fit, how
 *  many more wait, and the key that goes there from anywhere. It is no key of metal: what the view is for keeps that. */
function AsksLine() {
  const q = where.question ? records.questions.get(where.question) : undefined;
  if (!q || q.state !== 'open') return null;
  const s = q.session_id ? records.sessions.get(q.session_id) : undefined;
  const t = q.thought_id ? records.thoughts.get(q.thought_id) : undefined;
  const router = q.source === 'router';
  const who = router ? q.prompt : `${agentName(s?.agent ?? t?.agent)} asks`;
  const more = openQuestions().length - 1;
  // The key the person recorded for it, named as their keyboard prints it; none where this copy takes no keys from
  // other apps (a review build), where it would do nothing.
  const answer = answerKey('question'), key = answer && keyName(answer);
  const does = router ? 'Show the question on Home' : 'Show the question under its terminal';
  return (
    <button type="button" class="asks-line" title={key ? tip(does, key) : does} onClick={() => toQuestion(q.id)}>
      <Mark s="asks" label="" />
      <b>{who}</b>
      <span class="what">{router ? title(t) : q.prompt}</span>
      {more > 0 && <span class="more">{plural(more, 'more waits', 'more wait')}</span>}
      {key && <span data-keys="window"><Key k={key} cap /></span>}
    </button>
  );
}

/** The rail: the glance in words, at the left; Agents and Settings, at the right. */
function Rail() {
  const c = homeCounts();
  const words = [
    c.needs > 0 && <b>{plural(c.needs, 'needs you', 'need you')}</b>,
    c.working > 0 && <span>{c.working} working</span>,
    c.waiting > 0 && <span>{c.waiting} to keep</span>,
    c.fresh - c.waiting - c.ended > 0 && <span>{plural(c.fresh - c.waiting - c.ended, 'new result', 'new results')}</span>,
    c.ended > 0 && <span>{c.ended} ended</span>,
  ].filter(Boolean);
  const mark = c.needs ? 'asks' : c.working ? 'working' : c.fresh ? 'ready' : 'ended';
  // A new version waiting for the person's word (update.tsx): one quiet line, which leads to About.
  const newer = waiting();
  return (
    <footer class="rail">
      <span class="rail-l" role="status">
        {page.error ? <span class="err">{page.error}</span> : !core.in ? <span>Starting…</span> : <><Mark s={mark} label="" />{words.length ? words : <span>Nothing running</span>}</>}
      </span>
      <span class="rail-r">
        {newer && <button type="button" class="newer" onClick={() => arrive('settings:about')}>Version {newer} is ready</button>}
        <button type="button" title={tip('Settings', '⌘,')} onClick={() => command('settings')}>Settings</button>
      </span>
    </footer>
  );
}

let leaving = false;
function App() {
  const [, tick] = useState(0);
  onRedraw(() => tick((n) => n + 1));
  const project = ui.view === LOOSE || records.projects.get(ui.view)?.open ? ui.view : null;
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('narrow', ui.narrow);
    document.documentElement.dataset.effects = effects();
    document.documentElement.dataset.text = pref('text_size');
    settleFocus();
    tellShows(project);
  });
  // A workspace's own window is named for its workspace, and goes when the workspace is closed.
  const name = ui.only ? records.projects.get(ui.only)?.name : undefined;
  useLayoutEffect(() => void (name && call('host.window', { do: 'title', text: name }).catch(() => {})), [name]);
  useLayoutEffect(() => void (ui.only && ui.ready && !project && !leaving && ((leaving = true), call('host.window', { do: 'close' }).catch(() => {}))));
  // The terminals follow their preferences at once and as they change, from this window or another.
  useLayoutEffect(loadLook, [pref('terminal_font'), pref('terminal_size'), pref('terminal_line_height'), pref('terminal_bold_bright'), pref('terminal_contrast')]);
  // As it slides the sidebar's edge sheds its wake along its foot, where no row is. Opening, the wake lies on the
  // sidebar's own foot; closing, it lies where the sidebar was, which is the main panel's by then: behind Home's
  // rows, in its light, and not at all over a terminal, which is text from edge to edge.
  useLayoutEffect(() => {
    const side = document.querySelector<HTMLElement>('.side'), foot = side?.querySelector('.spark')?.getBoundingClientRect();
    const room = ui.slide === 'out' ? document.querySelector('.room') : null;
    if (ui.slide && side && foot && (ui.slide === 'in' || room)) wake(side, wakeLook(), [foot.top + 28, foot.bottom], room ?? undefined);
  }, [ui.slide]);
  const side = ui.sidebar && !ui.narrow;
  return (
    <div class={`win${side ? '' : ' solo'}${ui.sheet ? ' dimmed' : ''}${ui.narrow && ui.peek ? ' peek' : ''}`} data-slide={ui.slide || undefined} data-greet={ui.greet || undefined}
      onAnimationEnd={(e) => e.target === e.currentTarget && ui.slide && slid()}>
      {(side || (ui.narrow && ui.peek)) && <Sidebar />}
      <main class="main">
        <Bar project={project} />
        {project ? <Deck key={project} project={project} /> : ui.view === 'earlier' ? <Earlier /> : welcome.on ? <Welcome /> : <Home />}
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
  setVoice(hears ? heard : null);
}
records.onchange = () => {
  followSpeech();
  listenToSpeech();
  reconcile();
  redraw();
};
/** The capture key while this window is in front, or brought there for it (docs/rebuild-plan.md, "Where Tasktap
 *  shows itself", rule 1). Home has a field for a thought already, and so has New Task while it is open: the caret
 *  goes there. Anywhere else New Task opens over what the window shows: also over the first start's welcome, which
 *  stands in Home's place and has no field. The host chose the same by the same rule from
 *  what this page told it the window shows (`tellShows`); what the page shows now decides a race between the two. */
function captureKey() {
  if (ui.sheet?.kind === 'capture' || (ui.view === 'home' && !ui.sheet && !welcome.on)) {
    page.focus = '#capture-input';
    return redraw();
  }
  command('new-task');
}
/** The window at a waiting question: ⌃⌥J with the window in front, J, Y or N on a question only its terminal
 *  answers, a click on its notification or on the line that leads to it. Under its terminal where it has one, with
 *  the keyboard in the terminal when only the terminal answers it and on its answers otherwise; on Home, in Needs
 *  you, for the router's question or one whose terminal is gone. */
function toQuestion(id: string) {
  const q = records.questions.get(id);
  if (ui.sheet) dismiss();
  if (q?.session_id && focusSession(q.session_id)) {
    if (q.reply_via !== 'terminal') {
      const answers = `[data-question="${id}"]`;
      page.focus = answers;
      // The terminal takes the keyboard at its next frame (focusTerminal); the question's answers take it after that.
      requestAnimationFrame(() => focus(answers));
    }
    return redraw();
  }
  show('home');
  if (q) page.focus = `[data-question="${id}"]`;
  redraw();
}
/** Where the host, or the notch through it, sends the window: a session's terminal, a part of Settings, a waiting
 *  question, or the capture key's field for a window made for it. */
function arrive(at: string) {
  const section = SECTIONS.find(([id]) => at === `settings:${id}`)?.[0];
  if (section) open({ kind: 'settings', at: section });
  else if (at.startsWith('question:')) toQuestion(at.slice('question:'.length));
  // A task a model was torn about waits on Home's decision line: its keys are the empty field's.
  else if (at.startsWith('thought:')) (ui.sheet && dismiss(), show('home'), (page.focus = '#capture-input'), redraw());
  else if (at.startsWith('capture:')) captureKey();
  else focusSession(at);
}
/** What the window shows, for the host's rule of where Tasktap shows itself: Home with no sheet over it, the New Task
 *  sheet, a workspace's terminals (by the sessions shown in its panes, each with its strip), or anything else. Said
 *  to the host when it changes; the reply is where Tasktap is. */
let told = '';
function tellShows(project: string | null) {
  const shows = ui.sheet ? (ui.sheet.kind === 'capture' ? 'new-task' : 'elsewhere') : ui.view === 'home' && !welcome.on ? 'home' : project ? 'terminals' : 'elsewhere';
  const terminals = shows === 'terminals' && project
    ? L.panes(layout(project)).flatMap((p) => (p.active ? [sessionOf(p.active)?.id ?? p.active] : []))
    : [];
  const said = [shows, ...terminals].join(' ');
  if (said === told) return;
  told = said;
  void call('host.where', { shows, terminals }).then(followWhere, () => {});
}
/** The host said where Tasktap is. The window is the one in use only while it is in front, as the host defines it for
 *  both pages; back in use, the region that has the focus answers, as a greeting, and a preview asks whether its file
 *  changed. */
function followWhere(w: Partial<Where>) {
  const was = ui.active;
  if (!heardWhere(w)) return;
  // In use only where it is the window that has the keyboard, or had it last: another of Tasktap's windows is not.
  const here = where.front && (!where.window || where.window === windowLabel);
  ui.active = here;
  document.documentElement.classList.toggle('inactive', !here);
  redraw();
  if (here && !was) (greet(region || 'main'), refresh());
}
void listen<{ do: string; at?: string; id?: string; low?: boolean; url?: string; over?: string; down?: string; max?: boolean; out?: string[]; back?: string | null }>('ui', ({ payload }) => {
  if (payload.do === 'focus' && payload.at) arrive(payload.at);
  // What the pointer does on the caption buttons, and whether the window is maximised (Windows).
  else if (payload.do === 'caption') captionSaid(payload);
  // A preview's frame tried to leave this machine: the host stopped it, and the person is offered the address.
  else if (payload.do === 'stopped' && payload.url) stop(payload.url);
  else if (payload.do === 'menu' && payload.id) command(payload.id);
  // The capture key, with this window in front or brought there: the caret goes where a thought is typed. (Its own
  // word: every page hears what the host says to any page, and `capture` is the notch's.)
  else if (payload.do === 'capture-key') captureKey();
  // Where Tasktap shows itself changed: the window came in front or went behind, or the question moved.
  else if (payload.do === 'where') followWhere(payload as unknown as Partial<Where>);
  // Low Power Mode began or ended: the effects follow it (light.tsx effects).
  else if (payload.do === 'power') (power.low = !!payload.low), redraw();
  // The workspaces that are out in windows of their own, and the one that came back (main window).
  else if (payload.do === 'windows') applyOut(payload.out ?? [], payload.back);
  // What the host knows of new versions (update.tsx).
  else if (payload.do === 'update') updateSaid(payload as unknown as HostUpdate);
});
void askUpdate();
askGlobalKeys(redraw);
// Keys bound by their place are named as the person's keyboard prints them (keys.ts).
watchLayout(() => call('host.layout', {}), redraw);
void call('host.power', {}).then((low) => ((power.low = !!low), redraw()), () => {});
const narrow = () => {
  const n = innerWidth < NARROW;
  if (n !== ui.narrow) (ui.narrow = n), redraw();
};
addEventListener('resize', narrow);
narrow();
// The terminal's faces are loaded before the first terminal measures its cells.
await fontsReady();
// A key cap shows only where its keys act now (page.ts markHeld).
watchHeld();
render(<App />, document.body);
// Whether the window is the one in use: in front, as the host says it to both pages (followWhere).
void call('host.where', {}).then(followWhere, () => {});
// The window shows once the page has laid out its first frame with the records in it (a hidden window draws nothing),
// so its first picture is Home as it is, with the welcome where it is a first start (welcome.tsx firstStart). A
// core that is slow to answer does not keep the window away for longer than a moment.
let visible = false;
const ready = () => void (visible || ((visible = true), call('host.ready', {}).catch(() => {})));
setTimeout(ready, 1500);
// A workspace's own window appears with its terminal's screen in it, as the main window does with Home.
const settled = async () => {
  const id = ui.only ? current()?.id : undefined;
  for (let waited = 0; id && !engines.get(id)?.attached && waited < 1000; waited += 25) await new Promise((done) => setTimeout(done, 25));
};
// Which workspaces are out, for the marks on their rows (the main window) and for a workspace to be let go of.
if (!ui.only) void call('host.window', { do: 'out' }).then((out) => applyOut(out ?? []), () => {});
void client
  .sub(['thoughts', 'projects', 'cards', 'looks', 'sessions', 'terminals', 'questions', 'results', 'layouts', 'prefs', 'agents', 'dictations', 'previews'], records)
  .then(() => {
    ui.ready = true;
    recordsIn();
    reconcile();
    const at = new URLSearchParams(location.search).get('focus');
    if (at) arrive(at);
    else show(ui.view);
    firstStart();
    redraw();
    // Once that render is laid out (a timer, not a frame: a hidden window draws none).
    setTimeout(() => void settled().then(ready));
    void loadTerms();
  })
  .catch((e) => (recordsFailed(e), fail(e), ready()));

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
  __ws: { uuid7, ui, records, layout, command, greet, slide, engines, focusSession, show, newTerminal, startAgent, call, echo, burst, text, type, current, dismiss, open, menu, choose, LOOSE, L, follow, refresh },
  __motion: { debug, stats, redraw },
  __speech: { talk, live, cap, audio },
  // The Composer's line and its one timer (lines.ts).
  __lines: invite,
  __where: where,
});
