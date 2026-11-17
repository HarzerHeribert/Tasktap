// The workspace page: what it holds while it runs, and what the person does in it. Every record
// is the core's. Each workspace's arrangement is its project's `layouts` record: kept here as a
// copy that changes at once and is written back a moment later, never as the page's own data.
import type { Session, StartTerminal, Thought } from '../../../core/proto/protocol.ts';
import { uuid7 } from '../client.ts';
import { agentName, call, fail, focus, openQuestions, page, records, redraw, title, why } from '../page.ts';
import * as L from './layout.ts';
import { currentLook, engine, engines } from './terminal.ts';

export * from '../page.ts';

/** The workspace of terminals that belong to no project (agent sign-in). Never stored. */
export const LOOSE = 'loose';

export type Dialog =
  | { kind: 'close-tab'; project: string; id: string }
  | { kind: 'stop'; project: string; id: string }
  | { kind: 'close-workspace'; project: string; count: number }
  | { kind: 'open-workspace' }
  | { kind: 'find'; id: string }
  | { kind: 'move'; project: string; id: string }
  | { kind: 'capture' }
  | { kind: 'reply'; question: string };

export const ui = {
  /** 'home', a project id, or LOOSE. */
  view: 'home',
  sidebar: true,
  dialog: null as Dialog | null,
  toast: '',
  /** Terminals this page asked the core to start, until their stream opens. */
  starting: new Map<string, StartTerminal>(),
  /** What to type into a new shell once it is live: the agent the person chose. */
  typing: new Map<string, string>(),
  /** Terminals being stopped, which must not get a tab back while they end. */
  stopping: new Set<string>(),
  /** Workspaces whose background sessions are folded away in the sidebar. */
  folded: new Set<string>(),
  /** The question whose reply is being typed in its pane. */
  replying: '',
  /** The first snapshot arrived: until then nothing is reconciled. */
  ready: false,
};

let toastTimer = 0;
export function toast(text: string) {
  ui.toast = text;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ((ui.toast = ''), redraw()), 3000);
  redraw();
}
export const open = (d: Dialog) => ((ui.dialog = d), redraw());
export const dismiss = () => ((ui.dialog = null), redraw());

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
  }
}

// ——— What a terminal is doing ———

export type Cue = { kind: string; label: string; symbol: string; activity?: string };

/** The session in a terminal: its newest. */
export function sessionOf(terminal: string): Session | undefined {
  let found: Session | undefined;
  for (const s of records.sessions.values()) if (s.terminal_id === terminal && (!found || s.id > found.id)) found = s;
  return found;
}
export const thoughtOf = (s: Session | undefined): Thought | undefined => (s?.thought_id ? records.thoughts.get(s.thought_id) : undefined);
export const questionOf = (s: Session | undefined) => (s ? openQuestions().find((q) => q.session_id === s.id) : undefined);

/** The state a tab, a pane and a background row show, as 1.2's sessionCue named them. */
export function cue(id: string): Cue {
  const t = records.terminals.get(id);
  const s = sessionOf(id);
  const q = questionOf(s);
  if (q) return q.source === 'permission'
    ? { kind: 'permission', label: 'Needs permission', symbol: '?', activity: q.prompt }
    : { kind: 'input', label: 'Needs input', symbol: '?', activity: q.prompt };
  const th = thoughtOf(s);
  if (th && !th.read && th.status === 'failed') return { kind: 'failure', label: 'Failed', symbol: '!', activity: why(th) };
  if (th && !th.read && th.status === 'done') return { kind: 'complete', label: 'Answer ready', symbol: '✓' };
  if (ui.starting.has(id) || (!t && !ui.stopping.has(id))) return { kind: 'working', label: 'Opening', symbol: '◌' };
  if (!t || t.state !== 'running') {
    const label = t?.state === 'lost' ? 'Not running' : ui.stopping.has(id) || t?.exit === null ? 'Stopped' : t?.exit === 0 ? 'Exited' : `Exited (${t?.exit})`;
    return { kind: 'ended', label, symbol: '○' };
  }
  if (ui.stopping.has(id)) return { kind: 'ended', label: 'Stopping', symbol: '○' };
  const activity = s?.activity.at(-1);
  if (s?.state === 'working') return { kind: 'working', label: 'Working', symbol: '◌', activity };
  if (s?.state === 'starting') return { kind: 'working', label: 'Starting', symbol: '◌', activity };
  if (s?.state === 'idle') return { kind: 'ready', label: 'Ready', symbol: '○', activity };
  if (t.kind === 'shell') return { kind: 'connected', label: 'Terminal', symbol: '○' };
  return { kind: 'working', label: 'Running', symbol: '◌' };
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
  if (project === 'home') return undefined;
  const pane = L.selectedPane(layout(project));
  return { project, pane: pane?.id, id: pane?.active ?? undefined };
}

export function show(view: string) {
  ui.view = view;
  if (view !== 'home') {
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
/** Opens a tab's stream: a terminal this page starts is started by the same call. */
export async function attach(id: string) {
  const e = engine(id);
  if (e.attached || attaching.has(id)) return;
  attaching.add(id);
  const start = ui.starting.get(id);
  try {
    await e.attach(start);
    ui.starting.delete(id);
    const typed = ui.typing.get(id);
    if (typed) {
      ui.typing.delete(id);
      e.type(typed + '\r');
    }
  } catch (err) {
    if (!start) return;
    ui.starting.delete(id);
    setLayout(projectOf(id), L.close(layout(projectOf(id)), id));
    toast(err instanceof Error ? err.message : String(err));
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
  toast(`Session running in background. Find it under ${project === LOOSE ? 'Sign-in terminals' : records.projects.get(project)?.name}.`);
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
  toast(stopAll ? 'Workspace closed. Its sessions have been stopped.' : 'Workspace closed.');
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
  setLayout(project, L.textSize(l, id, change === 0 ? null : textSize(id) + change));
  engines.get(id)?.setLook(currentLook(), textSize(id));
}

export async function copy(id: string) {
  const text = engines.get(id)?.term.getSelection();
  if (!text) return toast('Select terminal text to copy.');
  await call('host.clipboard', { text }).catch(fail);
  toast('Copied terminal selection.');
}

export async function paste(id: string) {
  const text = await call('host.clipboard', {}).catch(fail);
  if (!text) return toast('The clipboard has no text to paste.');
  engines.get(id)?.paste(text);
  focusTerminal(id);
}

export function readSoon(t: Thought | undefined) {
  if (t && !t.read && (t.status === 'done' || t.status === 'failed') && document.hasFocus())
    window.setTimeout(() => records.thoughts.get(t.id)?.read === false && void call('thought.read', { id: t.id }).catch(() => {}), 1200);
}

export { page };
