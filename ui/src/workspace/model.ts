// The workspace page: what it holds while it runs, and what the person does in it. Every record
// is the core's. Each workspace's arrangement is its project's `layouts` record: kept here as a
// copy that changes at once and is written back a moment later, never as the page's own data.
import type { Session, StartTerminal, Thought } from '../../../core/proto/protocol.ts';
import { cap } from '../capture.tsx';
import { CallError, uuid7 } from '../client.ts';
import { agentName, call, fail, focus, openQuestions, page, records, redraw, sentence, title, why } from '../page.ts';
import type { State } from '../ui.tsx';
import { snap } from './appearance.ts';
import * as L from './layout.ts';
import { currentLook, engine, engines } from './terminal.ts';

export * from '../page.ts';

/** The workspace of terminals that belong to no project (agent sign-in). Never stored. */
export const LOOSE = 'loose';

export type Sheet =
  | { kind: 'close-tab'; project: string; id: string }
  | { kind: 'stop'; project: string; id: string }
  | { kind: 'close-workspace'; project: string; count: number }
  | { kind: 'open-workspace' }
  | { kind: 'find'; id: string }
  | { kind: 'move'; project: string; id: string }
  | { kind: 'capture' }
  | { kind: 'reply'; question: string }
  | { kind: 'settings'; at?: 'thoughts' | 'speech' }
  | { kind: 'placing'; back?: boolean }
  | { kind: 'speech' }
  | { kind: 'agents' }
  | { kind: 'review'; thought: string }
  | { kind: 'settle'; thought: string; keep: boolean }
  | { kind: 'send'; thought: string }
  | { kind: 'session'; id: string };

export const ui = {
  /** 'home', 'earlier', a project id, or LOOSE. */
  view: 'home',
  sidebar: true,
  /** The sidebar is sliding in or out: it is shown until it has. */
  slide: '' as '' | 'in' | 'out',
  /** The region that answers focus entering it, for the second it does (main.tsx greet). */
  greet: '' as '' | 'side' | 'main',
  sheet: null as Sheet | null,
  /** Terminals this page asked the core to start, until their stream opens. */
  starting: new Map<string, StartTerminal>(),
  /** What to type into a new shell once it is live: the agent the person chose. */
  typing: new Map<string, string>(),
  /** Terminals being stopped, which must not get a tab back while they end. */
  stopping: new Set<string>(),
  /** Terminals the core would not show here, each with its reason: one is open in as many places as it allows. */
  full: new Map<string, string>(),
  /** Workspaces whose sessions are folded away in the sidebar. */
  folded: new Set<string>(),
  /** The first snapshot arrived: until then nothing is reconciled. */
  ready: false,
  /** The window is the key window: only then does what a pane shows count as seen. */
  active: false,
  /** The appearance part of Settings has its microphone trial on: the motion listens. */
  voice: false,
  /** Home's open fold, and how far Running is opened. */
  fold: '' as '' | 'results' | 'later' | 'shut' | 'shut-later',
  more: false,
  /** The window is narrower than the sidebar and a workspace need; the sidebar then comes over the content (`peek`). */
  narrow: false,
  peek: false,
};

export const open = (d: Sheet) => ((ui.sheet = d), redraw());
/** Puts the sheet away. A thought begun in a session's pane was a follow-up to that session only while its sheet was up. */
export const dismiss = () => ((ui.sheet = null), (cap.current = null), redraw());

// ——— Layouts, written through to the core ———

const layouts = new Map<string, L.Layout>();
const seen = new Map<string, number>();
/** Writes waiting for their moment, writes the core has not answered, and the revision of this
 *  page's last write: a record at or below it, or one that arrives while this page writes, is
 *  this page's own echo, never a reason to go back to an older arrangement. */
const writes = new Map<string, number>();
const inflight = new Map<string, number>();
const ours = new Map<string, number>();

export function layout(project: string): L.Layout {
  let l = layouts.get(project);
  if (!l) layouts.set(project, (l = L.normalize(records.layouts.get(project)?.tree)));
  return l;
}

export function setLayout(project: string, l: L.Layout, store = true) {
  if (l === layouts.get(project)) return;
  layouts.set(project, l);
  redraw();
  if (!store || project === LOOSE) return;
  clearTimeout(writes.get(project));
  writes.set(project, window.setTimeout(() => {
    writes.delete(project);
    inflight.set(project, (inflight.get(project) ?? 0) + 1);
    void call('put', { c: 'layouts', id: project, patch: { tree: layouts.get(project) } })
      .then((r) => ours.set(project, Math.max(ours.get(project) ?? 0, r.rev)), fail)
      .finally(() => inflight.set(project, (inflight.get(project) ?? 1) - 1));
  }, 250));
}
/** Writes what a drag left once it ends. */
export const store = (project: string) => setLayout(project, { ...layout(project) });

/** The project a terminal belongs to, LOOSE for none. */
export function projectOf(id: string): string {
  const t = records.terminals.get(id);
  if (t) return t.project_id ?? LOOSE;
  const start = ui.starting.get(id);
  if (start) return start.project ?? LOOSE;
  for (const [p, l] of layouts) if (L.tabs(l).includes(id) || l.background.includes(id)) return p;
  return LOOSE;
}

/** The open workspaces, by name; Scratch only while something runs in it. */
export function workspaces() {
  return [...records.projects.values()]
    .filter((p) => p.open && (p.kind === 'folder' || [...records.terminals.values()].some((t) => t.project_id === p.id && t.state === 'running')))
    .sort((a, b) => Number(a.kind === 'scratch') - Number(b.kind === 'scratch') || a.name.localeCompare(b.name));
}

const running = (project: string) =>
  [...records.terminals.values()].filter((t) => (t.project_id ?? LOOSE) === project && t.state === 'running' && !ui.stopping.has(t.id));

/** Brings every open workspace's layout in step with the core's terminals (layout.reconcile),
 *  and follows a layout another device wrote. */
export function reconcile() {
  if (!ui.ready) return;
  for (const [id, row] of records.layouts) {
    if (seen.get(id) === row.rev) continue;
    seen.set(id, row.rev);
    if (writes.has(id) || inflight.get(id) || row.rev <= (ours.get(id) ?? 0)) continue;
    layouts.set(id, L.normalize(row.tree));
  }
  for (const project of [...workspaces().map((p) => p.id), LOOSE]) {
    const known = new Set([...records.terminals.values()].filter((t) => (t.project_id ?? LOOSE) === project).map((t) => t.id));
    for (const id of ui.starting.keys()) known.add(id);
    const l = layout(project);
    const next = L.reconcile(l, running(project).map((t) => t.id), known);
    if (next !== l) setLayout(project, next);
  }
  for (const [id, e] of engines) {
    if (records.terminals.has(id) || ui.starting.has(id)) continue;
    e.dispose();
    engines.delete(id);
    ui.full.delete(id);
  }
}

// ——— What a terminal is doing ———

/** What a terminal's mark says: its session's state, in the mark's terms and in words. */
export type Cue = { s: State; words: string; activity?: string };

/** The session in a terminal: its newest. */
export function sessionOf(terminal: string): Session | undefined {
  let found: Session | undefined;
  for (const s of records.sessions.values()) if (s.terminal_id === terminal && (!found || s.id > found.id)) found = s;
  return found;
}
export const thoughtOf = (s: Session | undefined): Thought | undefined => (s?.thought_id ? records.thoughts.get(s.thought_id) : undefined);
export const questionOf = (s: Session | undefined) => (s ? openQuestions().find((q) => q.session_id === s.id) : undefined);

/** The state a tab, a sidebar row and the rail show for a terminal. */
export function cue(id: string): Cue {
  const t = records.terminals.get(id);
  const s = sessionOf(id);
  const q = questionOf(s);
  if (q) return { s: 'asks', words: q.reply_via === 'terminal' ? 'Asks in its terminal' : q.source === 'permission' ? 'Asks permission' : 'Needs your answer', activity: q.prompt };
  const th = thoughtOf(s);
  if (th && !th.read && th.status === 'failed') return { s: 'failed', words: 'Failed', activity: why(th) };
  if (th && th.status === 'done' && (!th.read || th.workdir?.changes === 'pending')) return { s: 'ready', words: th.workdir?.changes === 'pending' ? 'Result ready, changes to keep' : 'Result ready' };
  if (ui.starting.has(id) || (!t && !ui.stopping.has(id))) return { s: 'working', words: 'Opening' };
  if (!t || t.state !== 'running' || ui.stopping.has(id)) {
    const words = ui.stopping.has(id) ? 'Stopping' : t?.state === 'lost' ? 'Not running' : t?.exit === null ? 'Stopped' : t?.exit === 0 ? 'Exited' : `Exited (${t?.exit})`;
    return { s: 'ended', words };
  }
  const activity = s?.activity.at(-1);
  if (s?.state === 'working' || s?.state === 'starting') return { s: 'working', words: s.state === 'starting' ? 'Starting' : 'Working', activity };
  if (s?.state === 'idle') return { s: 'ended', words: 'Waiting for a prompt' };
  if (t.kind === 'shell' && !s) return { s: 'shell', words: 'Shell' };
  return { s: 'working', words: 'Running', activity };
}

/** A tab's name: its session's thought or name, else the terminal's title. */
export function label(id: string): string {
  const s = sessionOf(id);
  const name = s && (s.name || title(thoughtOf(s)) || agentName(s.agent));
  return name || records.terminals.get(id)?.title || ui.starting.get(id)?.title || 'Terminal';
}

export const textSize = (id: string) => layout(projectOf(id)).sizes[id] ?? currentLook().fontSize;

// ——— What the person does ———

/** The pane the toolbar and the keyboard act on in the workspace shown, and its terminal. */
export function current() {
  const project = ui.view;
  if (project === 'home' || project === 'earlier') return undefined;
  const pane = L.selectedPane(layout(project));
  return { project, pane: pane?.id, id: pane?.active ?? undefined };
}

export function show(view: string) {
  ui.peek = false;
  // Arriving on Home: the open question has the keyboard if something asks, else the capture line.
  if (view === 'home') page.focus = openQuestions().length ? '.hx .hq.open [data-question]' : '#capture-input';
  ui.view = view;
  if (view !== 'home' && view !== 'earlier') {
    const pane = L.selectedPane(layout(view));
    if (pane?.active) focusTerminal(pane.active);
  }
  redraw();
}

/** Keyboard to a terminal once it is on screen. */
export function focusTerminal(id: string) {
  requestAnimationFrame(() => {
    const e = engines.get(id);
    if (e?.element.isConnected) focus(e.term.textarea);
  });
}

/** A new terminal in a workspace: a login shell, or `argv`; in pane `into`, or in a new pane
 *  beside it along `axis`. With `type`, that command is typed into the shell once it is live, so
 *  an agent started this way runs under the shell's observer like one the person typed. */
export function newTerminal(project: string, opts: { into?: string; axis?: 'x' | 'y'; argv?: string[]; title?: string; type?: string } = {}) {
  const id = uuid7();
  ui.starting.set(id, { project: project === LOOSE ? null : project, argv: opts.argv ?? [], ...(opts.title ? { title: opts.title } : {}) });
  if (opts.type) ui.typing.set(id, opts.type);
  const l = layout(project);
  const into = opts.into ?? L.selectedPane(l)?.id;
  setLayout(project, opts.axis && into ? L.split(l, into, opts.axis, id) : L.open(l, id, into));
  ui.view = project;
  focusTerminal(id);
  redraw();
  return id;
}

const attaching = new Set<string>();
/** Opens a tab's stream: a terminal this page starts is started by the same call. One the core will not show in one
 *  more place (`conflict`) says so in its pane, in the core's words, and is not asked for again until the person does. */
export async function attach(id: string, again = false) {
  const e = engine(id);
  if (e.attached || attaching.has(id) || (ui.full.has(id) && !again)) return;
  attaching.add(id);
  const start = ui.starting.get(id);
  try {
    await e.attach(start);
    ui.full.delete(id);
    ui.starting.delete(id);
    const typed = ui.typing.get(id);
    if (typed) {
      ui.typing.delete(id);
      e.type(typed + '\r');
    }
  } catch (err) {
    if (!start && err instanceof CallError && err.code === 'conflict') (ui.full.set(id, sentence(err.message)), redraw());
    if (!start) return;
    ui.starting.delete(id);
    setLayout(projectOf(id), L.close(layout(projectOf(id)), id));
    fail(err);
  } finally {
    attaching.delete(id);
  }
  redraw();
}

/** Closing a tab: a live terminal asks first (README, Arrange your workspace); an ended one closes. */
export function closeTab(project: string, id: string) {
  if (records.terminals.get(id)?.state === 'running' && !ui.stopping.has(id)) return open({ kind: 'close-tab', project, id });
  setLayout(project, L.close(layout(project), id));
  engines.get(id)?.dispose();
  engines.delete(id);
  const next = L.selectedPane(layout(project))?.active;
  if (next) focusTerminal(next);
}

export function keepInBackground(project: string, id: string) {
  setLayout(project, L.background(layout(project), id));
  engines.get(id)?.detach();
  dismiss();
}

/** Ends a terminal's process; its record and history stay. A run's own stop names its thought. */
export function stop(project: string, id: string) {
  ui.stopping.add(id);
  setLayout(project, L.close(layout(project), id));
  engines.get(id)?.dispose();
  engines.delete(id);
  dismiss();
  const s = sessionOf(id);
  const th = thoughtOf(s);
  const done = () => {
    ui.stopping.delete(id);
    redraw();
  };
  const ended = th && (s?.state === 'working' || s?.state === 'starting') && !s.adopted
    ? call('thought.stop', { id: th.id })
    : call('terminal.stop', { id });
  void ended.then(() => setTimeout(done, 3000), (e) => (done(), fail(e)));
}

/** A background session back in a tab, with its history; nothing is started. */
export function restore(project: string, id: string) {
  setLayout(project, L.open(layout(project), id));
  show(project);
  focusTerminal(id);
}

/** Shows a session's terminal (the notch's Open, a Home row): its tab is selected or opened. */
export function focusSession(at: string) {
  const s = records.sessions.get(at);
  const id = s?.terminal_id ?? at;
  if (!records.terminals.has(id)) return false;
  const project = projectOf(id);
  setLayout(project, L.open(layout(project), id));
  show(project);
  focusTerminal(id);
  return true;
}

/** A session's details, from the session or its terminal. A terminal with no session, a plain shell, has none. */
export function details(at: string | undefined) {
  const s = records.sessions.get(at ?? '') ?? sessionOf(at ?? '');
  if (s) open({ kind: 'session', id: s.id });
  return !!s;
}

export function closeWorkspace(project: string) {
  const count = running(project).length;
  if (count) return open({ kind: 'close-workspace', project, count });
  void finishClose(project, false);
}

export async function finishClose(project: string, stopAll: boolean) {
  dismiss();
  try {
    await call('project.close', { id: project, stop: stopAll });
  } catch (e) {
    return fail(e);
  }
  for (const id of [...L.tabs(layout(project)), ...layout(project).background]) {
    engines.get(id)?.dispose();
    engines.delete(id);
  }
  if (ui.view === project) show(workspaces().find((p) => p.id !== project)?.id ?? 'home');
}

/** Opens a folder as a workspace, or a closed one again with its layout; a workspace with no
 *  tabs gets its first terminal. Nothing that ran before is started again. */
export async function openWorkspace(folder: string) {
  dismiss();
  try {
    const id = await call('project.add', { id: uuid7(), folder });
    ui.view = id;
    await new Promise((ok) => setTimeout(ok, 0));
    if (!layout(id).tree) newTerminal(id);
    else show(id);
  } catch (e) {
    fail(e);
  }
}

export async function pickFolder() {
  dismiss();
  const folder = await call('host.pick', { folder: true }).catch(fail);
  if (folder) await openWorkspace(folder);
}

export function textSizeBy(id: string, change: 1 | -1 | 0) {
  const project = projectOf(id);
  const l = layout(project);
  // A step is to the next size whose cells differ: sizes between whole pixels of cell width look the same.
  const family = currentLook().fontFamily, at = textSize(id);
  let next = at + change;
  while (change && snap(family, next) === snap(family, at) && next > 6 && next < 40) next += change;
  setLayout(project, L.textSize(l, id, change === 0 ? null : next));
  engines.get(id)?.setLook(currentLook(), textSize(id));
}

export async function copy(id: string) {
  const text = engines.get(id)?.term.getSelection();
  if (text) await call('host.clipboard', { text }).catch(fail);
}

export async function paste(id: string) {
  const text = await call('host.clipboard', {}).catch(fail);
  if (!text) return;
  engines.get(id)?.paste(text);
  focusTerminal(id);
}

export function readSoon(t: Thought | undefined) {
  if (t && !t.read && (t.status === 'done' || t.status === 'failed') && ui.active)
    window.setTimeout(() => records.thoughts.get(t.id)?.read === false && void call('thought.read', { id: t.id }).catch(() => {}), 1200);
}

