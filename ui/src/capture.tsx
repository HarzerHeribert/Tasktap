// The capture line both the notch and the workspace show: one line, Enter sends; beside it the destination (the
// person's pick, else where the router says, else the default) and the agent; the receipt offers Undo while the
// thought waits to start. With no folder open yet, a thought is kept as an idea.
import type { Route, Thought } from '../../core/proto/protocol.ts';
import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { uuid7 } from './client.ts';
import { I, Wave } from './ui.tsx';
import { agent, agentName, call, fail, page, projectName, projects, records, redraw, title, why } from './page.ts';

/** What was just sent, for the receipt and Undo. */
export type Sent = { id: string; text: string; to: string | 'idea' };

export const cap = {
  draft: '',
  /** The person's own pick of destination: a project id or 'idea'. */
  dest: undefined as string | undefined,
  /** Where the router would send the text typed now (route.hint), for the chip. */
  hint: null as { text: string; route: Route } | null,
  /** The session the person is in, which the router may send a follow-up to. */
  current: null as string | null,
  choosing: false,
  sent: null as Sent | null,
  undone: null as Sent | null,
};

const secondsLeft = (t: Thought | undefined) => (t?.hold_until ? Math.max(0, Math.ceil((t.hold_until - Date.now()) / 1000)) : 0);
const folder = (dest: string | undefined) => (dest && dest !== 'idea' ? dest : undefined);
/** Where the router would send it, when that is one project. */
const routedProject = (r: Route | undefined) => (r?.confidence === 'clear' && 'project' in r.to ? r.to.project : undefined);

/** The person's pick, while it can still be used. */
export const picked = () => (cap.dest === 'idea' || (cap.dest && records.projects.get(cap.dest)?.open) ? cap.dest : undefined);

/** Where the router would send the text typed now, when it knows (route.hint): then Enter
 *  leaves the routing to it rather than picking for the person. */
export function hinted(): Route | undefined {
  const r = cap.hint?.text === cap.draft.trim() ? cap.hint.route : undefined;
  return !picked() && r && r.confidence !== 'unknown' ? r : undefined;
}

/** Where the next capture goes when neither the person nor the router says: the project of the
 *  newest thought, else their first project. None until they have one: the chip offers to add it. */
export function destination(): string | undefined {
  const pick = picked();
  if (pick) return pick;
  const newest = [...records.thoughts.values()]
    .filter((t) => t.project_id && records.projects.get(t.project_id)?.open)
    .sort((a, b) => b.created - a.created)[0];
  return newest?.project_id ?? projects().find((p) => p.kind === 'folder')?.id;
}

/** Whether the receipt still offers Undo: the thought waits for its hold to end. */
/** A capture sent from this page that the core has not shown back yet: it is on its way to be routed. */
export const routing = () => !!cap.sent && cap.sent.to !== 'idea' && !records.thoughts.has(cap.sent.id);
export const holding = () => {
  const t = cap.sent && records.thoughts.get(cap.sent.id);
  return !!cap.sent && cap.sent.to !== 'idea' && (!t || t.phase === 'routed');
};

type Hooks = {
  /** After the folder panel: the notch takes the keyboard back. */
  picked?: () => void;
  /** The sent thought started; the page may put the capture away. */
  started?: () => void;
};

async function addProject(hooks: Hooks): Promise<string | undefined> {
  cap.choosing = false;
  try {
    const chosen = await call('host.pick', { folder: true });
    if (chosen) cap.dest = await call('project.add', { id: uuid7(), folder: chosen });
  } catch (e) {
    fail(e);
  }
  page.focus = '#capture-input';
  hooks.picked?.();
  redraw();
  return folder(cap.dest);
}

async function send(e: Event, hooks: Hooks) {
  e.preventDefault();
  const text = cap.draft.trim();
  if (!text) return;
  const route = hinted();
  const to = route ? routedProject(route) : (destination() ?? 'idea');
  try {
    let id = uuid7();
    const undone = cap.undone;
    if (undone && to && to !== 'idea') {
      // The thought Undo returned to the person goes out again, with what they changed, rather
      // than a copy of it that would stay behind.
      id = undone.id;
      if (undone.text !== text) await call('put', { c: 'thoughts', id, patch: { text } });
      await call('thought.update', { id, project_id: to });
    } else {
      if (undone) await call('delete', { c: 'thoughts', id: undone.id });
      if (to === 'idea') await call('thought.capture', { id, text, strokes: [], source: 'typed', mode: 'note' });
      else
        await call('thought.capture', {
          id, text, strokes: [], source: 'typed', ...(route ? { current: cap.current } : { project_id: to }),
        });
    }
    Object.assign(cap, { sent: { id, text, to: to ?? '' }, undone: null, draft: '', hint: null });
    page.error = '';
  } catch (err) {
    fail(err);
  }
  redraw();
}

export async function undo() {
  const sent = cap.sent;
  if (!sent) return;
  try {
    if (sent.to === 'idea') await call('delete', { c: 'thoughts', id: sent.id });
    else {
      await call('thought.stop', { id: sent.id });
      cap.undone = sent;
    }
    Object.assign(cap, { sent: null, draft: sent.text, dest: sent.to || cap.dest });
    page.focus = '#capture-input';
  } catch (e) {
    fail(e);
  }
  redraw();
}

/** An undone thought whose text the person cleared is gone: nothing stale stays behind. */
function drop() {
  const undone = cap.undone;
  cap.undone = null;
  if (undone) void call('delete', { c: 'thoughts', id: undone.id }).catch(fail);
}

let hintTimer = 0;
/** Asks the core where the text typed so far would go, a moment after typing stops. */
function askRoute() {
  clearTimeout(hintTimer);
  const text = cap.draft.trim();
  if (!text) {
    cap.hint = null;
    return redraw();
  }
  hintTimer = window.setTimeout(() => {
    void call('route.hint', { text, current: cap.current }).then((route) => {
      cap.hint = { text, route };
      redraw();
    }, () => {});
  }, 150);
}

function routeLabel(r: Route) {
  if (r.confidence === 'ambiguous') return r.candidates.map((c) => c.label).join(' or ');
  if (r.confidence !== 'clear') return '';
  if ('project' in r.to) return projectName(r.to.project);
  const s = records.sessions.get(r.to.session);
  return `Follow-up: ${s?.name || title(records.thoughts.get(s?.thought_id ?? '')) || 'its session'}`;
}

export function choose(open: boolean) {
  cap.choosing = open;
  page.focus = open ? '.cap-list [aria-selected=true], .cap-list button' : '#capture-input';
  redraw();
}

function pick(dest: string) {
  Object.assign(cap, { dest, choosing: false });
  page.focus = '#capture-input';
  redraw();
}

/** Up and down move through a list of buttons; the browser's Enter and Space press them. */
export function arrows(e: KeyboardEvent) {
  const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  items[(at + step + items.length) % items.length]?.focus({ focusVisible: true });
}

function Receipt({ hooks }: { hooks: Hooks }) {
  const sent = cap.sent;
  const t = sent && records.thoughts.get(sent.id);
  const waiting = holding();
  useEffect(() => {
    if (waiting) {
      const timer = setInterval(redraw, 500);
      return () => clearInterval(timer);
    }
    if (t?.phase === 'working' && !cap.draft && hooks.started) {
      const timer = setTimeout(hooks.started, 1600);
      return () => clearTimeout(timer);
    }
    return undefined;
  });
  if (!sent) return null;
  const undoButton = <button type="button" class="act" onClick={undo}><kbd>⌘Z</kbd><span>Undo</span></button>;
  const line = (words: ComponentChildren, undoable = false) => <p class="cap-said" role="status"><span>{words}</span>{undoable && undoButton}</p>;
  if (sent.to === 'idea') return line(projects().some((p) => p.kind === 'folder') ? 'Kept as an idea' : 'Kept as an idea until a folder is open', true);
  if (waiting) return line(<>Sent to <b>{projectName(t?.project_id ?? sent.to)}</b>{t ? `, starts in ${secondsLeft(t)} s` : ''}</>, true);
  if (t?.status === 'needs_you' && !t.project_id) return line('Where should it go? Its question is open.');
  if (t?.phase === 'captured' && t.mode === 'note') return line('No folder matched; kept as an idea');
  if (t?.status === 'failed') return line(`${why(t)} in ${projectName(t.project_id)}.`);
  return line(<>Started in <b>{projectName(t?.project_id ?? sent.to)}</b></>);
}

/** The capture line. `stack` puts the destination under the field (the notch); `line` keeps it all on one row. */
export function Capture({ stack = false, invite = false, hint, ...hooks }: Hooks & { stack?: boolean; invite?: boolean; hint?: ComponentChildren }) {
  const route = hinted();
  const to = route ? undefined : destination();
  const a = agent();
  const folders = projects().some((p) => p.kind === 'folder');
  const state = !a ? '' : !a.installed ? `${agentName(a.id)} is not installed` : a.signed_in === false ? `${agentName(a.id)} is not signed in` : agentName(a.id);
  const session = route?.confidence === 'clear' && 'session' in route.to;
  const where = !folders && !route ? null : (
    <button type="button" class="cap-to" id="dest-chip" title="Where it goes. Click to change" aria-haspopup="listbox" aria-expanded={cap.choosing}
      onClick={() => choose(!cap.choosing)}
      onKeyDown={(e) => (e.key === 'ArrowDown' || e.key === 'ArrowUp') && (e.preventDefault(), choose(true))}>
      <I n={session ? 'term' : 'arrow'} />
      <span>{route ? routeLabel(route) : to === 'idea' || !to ? 'Idea' : projectName(folder(to))}</span>
    </button>
  );
  const agentLine = !folders && !route ? <span class="cap-agent">Kept as an idea until a folder is open</span>
    : to === 'idea' ? <span class="cap-agent">Kept as an idea; nothing starts</span>
    : route?.confidence === 'ambiguous' ? <span class="cap-agent">You will be asked which</span>
    : state && <span class={`cap-agent${a && a.signed_in !== false && a.installed ? '' : ' off'}`}>{state}</span>;
  const field = (
    <input id="capture-input" autocomplete="off" spellcheck={false} aria-label="New task" placeholder="Put a thought in"
      value={cap.draft} onInput={(e) => {
        cap.draft = e.currentTarget.value;
        if (cap.undone && !cap.draft.trim()) drop();
        askRoute();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.isComposing) void send(e, hooks);
        else if (e.key === 'z' && e.metaKey && !cap.draft && cap.sent) {
          e.preventDefault();
          void undo();
        }
      }} />
  );
  const list = cap.choosing && (
    <div class="cap-list" role="listbox" aria-label="Destination" onKeyDown={arrows}>
      {projects().filter((p) => p.kind === 'folder').map((p) => (
        <button type="button" role="option" aria-selected={p.id === (to ?? routedProject(route))} onClick={() => pick(p.id)}>
          <I n="folder" /><span>{p.name}</span>
        </button>
      ))}
      <button type="button" role="option" aria-selected={to === 'idea'} onClick={() => pick('idea')}><i class="st" data-s="idea" aria-hidden="true" /><span>Idea</span></button>
      <button type="button" onClick={() => void addProject(hooks)}><I n="plus" /><span>Open a folder…</span></button>
    </div>
  );
  return (
    <form class={`capture${stack ? ' stack' : ''}${invite ? ' invite' : ''}`} onSubmit={(e) => send(e, hooks)}>
      {stack ? (
        <>
          <div class="cap">
            <Wave n={13} live={!!cap.draft} />{field}
          </div>
          <div class="cap-dest">{where}{agentLine}{hint && <span class="cap-hint">{hint}</span>}</div>
        </>
      ) : (
        <div class="cap">
          <Wave n={9} />{field}{where}{agentLine}{hint && <span class="cap-hint">{hint}</span>}
        </div>
      )}
      {list}
      <Receipt hooks={hooks} />
    </form>
  );
}
