// The Composer, the same in the notch, the capture sheet and on Home: the thought on lines of its own; under it, inside
// the field, where it will go (the person's pick, else where the router says, else the default), the agents as rings
// (the lit one runs it), and the key that says what Return does. The receipt offers Undo while the thought waits to
// start. A thought with no folder to go to is saved for later: it waits on Home until it is sent to one.
import type { Route, Thought } from '../../core/proto/protocol.ts';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { uuid7 } from './client.ts';
import { I, Mark, Ring, type RingState, Wave } from './ui.tsx';
import { agent, agentName, call, fail, focus, openQuestions, page, projectName, projects, records, redraw, title, why } from './page.ts';

/** What was just sent, for the receipt and Undo. */
export type Sent = { id: string; text: string; to: string | 'later' };

export const cap = {
  draft: '',
  /** The person's own pick of destination: a project id or 'later'. */
  dest: undefined as string | undefined,
  /** Where the router would send the text typed now (route.hint), for the chip. */
  hint: null as { text: string; route: Route } | null,
  /** The session the person is in, which the router may send a follow-up to. */
  current: null as string | null,
  choosing: false,
  /** The thought is on its way to the core: the field waits. */
  sending: false,
  sent: null as Sent | null,
  undone: null as Sent | null,
};

const secondsLeft = (t: Thought | undefined) => (t?.hold_until ? Math.max(0, Math.ceil((t.hold_until - Date.now()) / 1000)) : 0);
const folder = (dest: string | undefined) => (dest && dest !== 'later' ? dest : undefined);
/** Where the router would send it, when that is one project. */
const routedProject = (r: Route | undefined) => (r?.confidence === 'clear' && 'project' in r.to ? r.to.project : undefined);

/** The person's pick, while it can still be used. */
export const picked = () => (cap.dest === 'later' || (cap.dest && records.projects.get(cap.dest)?.open) ? cap.dest : undefined);

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
export const routing = () => !!cap.sent && cap.sent.to !== 'later' && !records.thoughts.has(cap.sent.id);
export const holding = () => {
  const t = cap.sent && records.thoughts.get(cap.sent.id);
  return !!cap.sent && cap.sent.to !== 'later' && (!t || t.phase === 'routed');
};

type Hooks = {
  /** After the folder panel: the notch takes the keyboard back. */
  picked?: () => void;
  /** The sent thought started; the page may put the capture away. */
  started?: () => void;
  /** An agent that cannot run was chosen: the page shows where it is signed in. */
  agents?: () => void;
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
  if (!text || cap.sending) return;
  cap.sending = true;
  redraw();
  const route = hinted();
  const to = route ? routedProject(route) : (destination() ?? 'later');
  try {
    let id = uuid7();
    const undone = cap.undone;
    if (undone && to && to !== 'later') {
      // The thought Undo returned to the person goes out again, with what they changed, rather
      // than a copy of it that would stay behind.
      id = undone.id;
      if (undone.text !== text) await call('put', { c: 'thoughts', id, patch: { text } });
      await call('thought.update', { id, project_id: to });
    } else {
      if (undone) await call('delete', { c: 'thoughts', id: undone.id });
      if (to === 'later') await call('thought.capture', { id, text, strokes: [], source: 'typed', mode: 'note' });
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
  cap.sending = false;
  redraw();
}

export async function undo() {
  const sent = cap.sent;
  if (!sent) return;
  try {
    if (sent.to === 'later') await call('delete', { c: 'thoughts', id: sent.id });
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
  // The destination chosen now, else the first.
  page.focus = open ? '.cap-list [aria-selected=true], .cap-list:not(:has([aria-selected=true])) button' : '#capture-input';
  redraw();
}

function pick(dest: string) {
  Object.assign(cap, { dest, choosing: false });
  page.focus = '#capture-input';
  redraw();
}

/** The arrows move through the destinations; the browser's Enter and Space press one; Escape leaves them as they were. */
function arrows(e: KeyboardEvent) {
  if (e.key === 'Escape') return (e.preventDefault(), e.stopPropagation(), choose(false));
  const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  e.stopPropagation();
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
  if (sent.to === 'later') return line(projects().some((p) => p.kind === 'folder') ? 'Saved for later' : 'Saved for later, until a folder is open', true);
  if (waiting) return line(<>Sent to <b>{projectName(t?.project_id ?? sent.to)}</b>{t ? `, starts in ${secondsLeft(t)} s` : ''}</>, true);
  if (t?.status === 'needs_you' && !t.project_id) return line('Where should it go? Its question is open.');
  if (t?.phase === 'captured' && t.mode === 'note') return line('No folder matched; saved for later');
  if (t?.status === 'failed') return line(`${why(t)} in ${projectName(t.project_id)}.`);
  return line(<>Started in <b>{projectName(t?.project_id ?? sent.to)}</b></>);
}

/** The agents this Mac has, each its mark in a ring. The lit one runs the next thought, and a click on another picks
 *  it; one that is not signed in is an open ring that says so and leads to where it is signed in. A ring turns while
 *  its agent's sessions work, beside their count, and takes the attention colour when one of them asks. */
function Rings({ hooks }: { hooks: Hooks }) {
  const all = [...records.agents.values()].filter((a) => a.installed);
  const chosen = agent()?.id;
  const live = [...records.thoughts.values()].filter((t) => t.mode !== 'note' && (t.status === 'working' || t.status === 'needs_you'));
  const asking = new Set(openQuestions().map((q) => records.sessions.get(q.session_id ?? '')?.agent ?? records.thoughts.get(q.thought_id ?? '')?.agent));
  if (!all.length) return null;
  return (
    <span class="rings" role="radiogroup" aria-label="Agent">
      {all.map((a) => {
        const off = a.signed_in === false, on = a.id === chosen, n = live.filter((t) => t.agent === a.id).length;
        const s: RingState = off ? 'off' : asking.has(a.id) ? 'asks' : n ? 'working' : '';
        const words = [
          `${agentName(a.id)}${a.version ? ` ${a.version}` : ''}`, off ? 'not signed in' : on ? 'runs the next thought' : 'click to use it',
          n > 0 && `${n} working`, s === 'asks' && 'one needs you',
        ].filter(Boolean).join(', ');
        return (
          <button type="button" class="ring" role="radio" aria-checked={on} data-s={s || undefined} data-agent={a.id} title={words} aria-label={words}
            onClick={() => (off ? hooks.agents?.() : !on && void call('put', { c: 'prefs', id: 'agent', patch: a.id }).catch(fail))}>
            {off && <span class="fix">Sign in</span>}
            <Ring agent={a.id} s={s} />
            {n > 0 && <b>{n}</b>}
          </button>
        );
      })}
    </span>
  );
}

/** The Composer. `raised` is Home's: a surface of its own, the thought at 20 px, up to six lines; elsewhere it sits on
 *  its sheet with the wave beside the thought, up to three lines. */
export function Capture({ raised = false, ...hooks }: Hooks & { raised?: boolean }) {
  const route = hinted();
  const to = route ? undefined : destination();
  const folders = projects().filter((p) => p.kind === 'folder');
  const later = !route && (!folders.length || to === 'later' || !to);
  const session = route?.confidence === 'clear' && 'session' in route.to;
  const does = later ? 'Save for later' : session ? 'Send' : 'Start';
  const area = useRef<HTMLTextAreaElement>(null);
  // The field grows with the thought, a line at a time.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = '0';
    el.style.height = `${el.scrollHeight}px`;
  });
  const option = (id: string, on: boolean, mark: ComponentChildren, name: string) => (
    <button type="button" role="option" aria-selected={on} onClick={() => pick(id)}>{mark}<span>{name}</span></button>
  );
  return (
    <form class={`capture${raised ? ' raised' : ''}${cap.draft ? ' has' : ''}`} aria-busy={cap.sending} onSubmit={(e) => send(e, hooks)}>
      <div class="cap" onPointerDown={(e) => e.target === e.currentTarget && (e.preventDefault(), focus('#capture-input'))}>
        {!raised && <Wave n={13} live={!!cap.draft} />}
        <textarea id="capture-input" ref={area} rows={1} autocomplete="off" spellcheck={false} aria-label="New task" placeholder="Put a thought in"
          value={cap.draft} readOnly={cap.sending}
          onInput={(e) => {
            cap.draft = e.currentTarget.value;
            if (cap.undone && !cap.draft.trim()) drop();
            askRoute();
          }}
          onKeyDown={(e) => {
            // Return sends; Shift-Return starts a new line.
            if (e.key === 'Enter' && !e.isComposing && !e.shiftKey) void send(e, hooks);
            else if (e.key === 'z' && e.metaKey && !cap.draft && cap.sent) {
              e.preventDefault();
              void undo();
            }
          }} />
        {cap.choosing ? (
          // The choice has the field's row to itself, so it covers nothing the person is reading: the folders, a new
          // one, and for later. Return then picks, so the key that sends is away until one is picked.
          <div class="cap-row cap-list" role="listbox" aria-label="Where it goes" onKeyDown={arrows}
            onFocusOut={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && cap.choosing && ((cap.choosing = false), redraw())}>
            {folders.map((p) => option(p.id, p.id === (to ?? routedProject(route)), <I n="folder" />, p.name))}
            <button type="button" onClick={() => void addProject(hooks)}><I n="plus" /><span>Open a folder…</span></button>
            {option('later', later, <Mark s="later" label="" />, 'For later')}
          </div>
        ) : (
          <div class="cap-row">
            <button type="button" class="cap-to" id="dest-chip" aria-haspopup="listbox" aria-expanded={false}
              title={!folders.length ? 'No folder is open yet: a thought is saved for later until one is. Click to open one' : later ? 'Saved for later: nothing starts. Click to change' : 'Where it goes. Click to change'}
              onClick={() => choose(true)}
              onKeyDown={(e) => (e.key === 'ArrowDown' || e.key === 'ArrowUp') && (e.preventDefault(), e.stopPropagation(), choose(true))}>
              {!later ? <I n={session ? 'term' : 'arrow'} /> : folders.length ? <Mark s="later" label="" /> : <I n="folder" />}
              <b>{route ? routeLabel(route) : !later ? projectName(folder(to)) : folders.length ? 'For later' : 'No folder yet'}</b>
              {route?.confidence === 'ambiguous' && <span>you will be asked which</span>}
              <I n="chev" />
            </button>
            <Rings hooks={hooks} />
            <button type="submit" class={`key${raised ? ' lg' : ''}`} disabled={!cap.draft.trim()} aria-busy={cap.sending || undefined}>
              {cap.sending ? <Mark s="working" label="" /> : <I n="ret" />}<span>{does}</span>
            </button>
          </div>
        )}
      </div>
      <Receipt hooks={hooks} />
    </form>
  );
}
