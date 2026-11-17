// The capture line both the notch and the workspace show: one line, Enter sends; the chip under
// it is the destination (the person's pick, else where the router says, else the default); the
// receipt offers Undo while the thought waits to start.
import type { Route, Thought } from '../../core/proto/protocol.ts';
import { useEffect } from 'preact/hooks';
import { uuid7 } from './client.ts';
import { Icon } from './icons.tsx';
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
  page.focus = '#guide-input';
  hooks.picked?.();
  redraw();
  return folder(cap.dest);
}

async function send(e: Event, hooks: Hooks) {
  e.preventDefault();
  const text = cap.draft.trim();
  if (!text) return;
  const route = hinted();
  const to = route ? routedProject(route) : (destination() ?? (await addProject(hooks)));
  if (!route && !to) return;
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
    page.focus = '#guide-input';
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
function hint() {
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
  page.focus = open ? '.dest-list [aria-selected=true], .dest-list button' : '#guide-input';
  redraw();
}

function pick(dest: string) {
  Object.assign(cap, { dest, choosing: false });
  page.focus = '#guide-input';
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
  const undoButton = (
    <button type="button" class="text-btn" onClick={undo}>Undo <kbd>⌘Z</kbd></button>
  );
  if (sent.to === 'idea') return <p class="notch-destination" role="status">Saved as an idea. {undoButton}</p>;
  if (waiting)
    return (
      <p class="notch-destination" role="status">
        Sent to <span>{projectName(t?.project_id ?? sent.to)}</span>{t ? ` · starts in ${secondsLeft(t)} s ` : ' '}{undoButton}
      </p>
    );
  if (t?.status === 'needs_you' && !t.project_id) return <p class="notch-destination" role="status">Where should it go? Answer its question.</p>;
  if (t?.status === 'failed') return <p class="notch-destination" role="status">{why(t)} in {projectName(t.project_id)}.</p>;
  return <p class="notch-destination" role="status">Started in <span>{projectName(t?.project_id ?? sent.to)}</span></p>;
}

export function Capture(hooks: Hooks) {
  const route = hinted();
  const to = route ? undefined : destination();
  const a = agent();
  const ready = !a ? '' : !a.installed ? `${agentName(a.id)} is not installed` : a.signed_in === false ? `${agentName(a.id)} is not signed in` : agentName(a.id);
  const session = route?.confidence === 'clear' && 'session' in route.to;
  return (
    <form id="guide-compose" onSubmit={(e) => send(e, hooks)}>
      <div class="guide-editor">
        <input id="guide-input" autocomplete="off" spellcheck={false} aria-label="Thought" placeholder="Put a thought in"
          value={cap.draft} onInput={(e) => {
            cap.draft = e.currentTarget.value;
            if (cap.undone && !cap.draft.trim()) drop();
            hint();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.isComposing) void send(e, hooks);
            else if (e.key === 'z' && e.metaKey && !cap.draft && cap.sent) {
              e.preventDefault();
              void undo();
            }
          }} />
      </div>
      <div class="guide-project-row">
        <button type="button" class="guide-project-button" id="dest-chip" aria-haspopup="listbox" aria-expanded={cap.choosing}
          onClick={() => choose(!cap.choosing)}
          onKeyDown={(e) => (e.key === 'ArrowDown' || e.key === 'ArrowUp') && (e.preventDefault(), choose(true))}>
          <Icon name={session ? 'terminal' : to === 'idea' ? 'note' : to || route ? 'folder' : 'plus'} />
          <span>{route ? routeLabel(route) : to ? projectName(folder(to)) : 'Add a project'}</span>
          <Icon name="down" />
        </button>
        <small class="guide-session">
          {to === 'idea' ? 'Kept as an idea; nothing starts' : route?.confidence === 'ambiguous' ? 'You will be asked which' : ready}
        </small>
      </div>
      {cap.choosing && (
        <div class="dest-list" role="listbox" aria-label="Destination" onKeyDown={arrows}>
          {projects().map((p) => (
            <button type="button" role="option" aria-selected={p.id === (to ?? routedProject(route))} class="surface-button" onClick={() => pick(p.id)}>
              <Icon name="folder" /><span>{p.name}</span>
            </button>
          ))}
          <button type="button" role="option" aria-selected={to === 'idea'} class="surface-button" onClick={() => pick('idea')}>
            <Icon name="note" /><span>Idea</span>
          </button>
          <button type="button" class="surface-button" onClick={() => void addProject(hooks)}><Icon name="plus" /><span>Add project…</span></button>
        </div>
      )}
      <Receipt hooks={hooks} />
    </form>
  );
}
