// The open notch: one capture line with its destination, the receipt with Undo, and the
// thoughts that are working, waiting or finished.
import type { Route, Thought } from '../../../core/proto/protocol.ts';
import { useEffect } from 'preact/hooks';
import poster from '../../../prototype/assets/motion/glyph/miniature.jpg';
import film from '../../../prototype/assets/motion/glyph/miniature.mp4';
import { uuid7 } from '../client.ts';
import { Icon } from '../icons.tsx';
import {
  agent, agentName, call, destination, fail, hinted, openQuestions, projectName, projects, records, redraw, resultOf, title, ui, why,
} from './model.ts';
import { fold, peek, reveal } from './panel.ts';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const secondsLeft = (t: Thought | undefined) => (t?.hold_until ? Math.max(0, Math.ceil((t.hold_until - Date.now()) / 1000)) : 0);

async function addProject(): Promise<string | undefined> {
  ui.choosing = false;
  try {
    const folder = await call('host.pick', { folder: true });
    if (folder) ui.dest = await call('project.add', { id: uuid7(), folder });
  } catch (e) {
    fail(e);
  }
  ui.focus = '#guide-input';
  void call('host.notch', { open: true, key: true });
  redraw();
  return folder(ui.dest);
}
const folder = (dest: string | undefined) => (dest && dest !== 'idea' ? dest : undefined);

/** Where the router would send it, when that is one project. */
const routedProject = (r: Route | undefined) => (r?.confidence === 'clear' && 'project' in r.to ? r.to.project : undefined);

async function send(e: Event) {
  e.preventDefault();
  const text = ui.draft.trim();
  if (!text) return;
  // The person's pick, else where the router says (it routes the capture itself), else the default.
  const route = hinted();
  const to = route ? routedProject(route) : (destination() ?? (await addProject()));
  if (!route && !to) return;
  try {
    let id = uuid7();
    const undone = ui.undone;
    if (undone && to && to !== 'idea') {
      // The thought Undo returned to the person goes out again, with what they changed, rather
      // than a copy of it that would stay behind.
      id = undone.id;
      if (undone.text !== text) await call('put', { c: 'thoughts', id, patch: { text } });
      await call('thought.update', { id, project_id: to });
    } else {
      if (undone) await call('delete', { c: 'thoughts', id: undone.id });
      if (to === 'idea') await call('thought.capture', { id, text, strokes: [], source: 'typed', mode: 'note' });
      else await call('thought.capture', { id, text, strokes: [], source: 'typed', ...(route ? {} : { project_id: to }) });
    }
    Object.assign(ui, { sent: { id, text, to: to ?? '' }, undone: null, draft: '', error: '', hint: null });
  } catch (err) {
    fail(err);
  }
  redraw();
}

/** An undone thought whose text the person cleared is gone: nothing stale stays behind. */
function drop() {
  const undone = ui.undone;
  ui.undone = null;
  if (undone) void call('delete', { c: 'thoughts', id: undone.id }).catch(fail);
}

let hintTimer = 0;
/** Asks the core where the text typed so far would go, a moment after typing stops. */
function hint() {
  clearTimeout(hintTimer);
  const text = ui.draft.trim();
  if (!text) {
    ui.hint = null;
    return redraw();
  }
  hintTimer = window.setTimeout(() => {
    void call('route.hint', { text }).then((route) => {
      ui.hint = { text, route };
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

async function undo() {
  const sent = ui.sent;
  if (!sent) return;
  try {
    if (sent.to === 'idea') await call('delete', { c: 'thoughts', id: sent.id });
    else {
      await call('thought.stop', { id: sent.id });
      ui.undone = sent;
    }
    Object.assign(ui, { sent: null, draft: sent.text, dest: sent.to || ui.dest, focus: '#guide-input' });
  } catch (e) {
    fail(e);
  }
  redraw();
}

function choose(open: boolean) {
  ui.choosing = open;
  ui.focus = open ? '.dest-list [aria-selected=true], .dest-list button' : '#guide-input';
  redraw();
}

function pick(dest: string) {
  Object.assign(ui, { dest, choosing: false, focus: '#guide-input' });
  redraw();
}

/** Up and down move through a list of buttons; the browser's Enter and Space press them. */
function arrows(e: KeyboardEvent) {
  const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  items[(at + step + items.length) % items.length]?.focus({ focusVisible: true });
}

function Receipt() {
  const sent = ui.sent;
  const t = sent && records.thoughts.get(sent.id);
  const holding = !!sent && sent.to !== 'idea' && (!t || t.phase === 'routed');
  useEffect(() => {
    if (holding) {
      const timer = setInterval(redraw, 500);
      return () => clearInterval(timer);
    }
    // Started: the notch has done its job unless the person is doing something else in it.
    if (t?.phase === 'working' && ui.mode === 'pinned' && !ui.draft && !ui.inside && !openQuestions().length) {
      const timer = setTimeout(fold, 1600);
      return () => clearTimeout(timer);
    }
    return undefined;
  });
  if (!sent) return null;
  const undoButton = (
    <button type="button" class="text-btn" onClick={undo}>Undo <kbd>⌘Z</kbd></button>
  );
  if (sent.to === 'idea') return <p class="notch-destination" role="status">Saved as an idea. {undoButton}</p>;
  if (holding)
    return (
      <p class="notch-destination" role="status">
        Sent to <span>{projectName(t?.project_id ?? sent.to)}</span>{t ? ` · starts in ${secondsLeft(t)} s ` : ' '}{undoButton}
      </p>
    );
  if (t?.status === 'needs_you' && !t.project_id) return <p class="notch-destination" role="status">Where should it go? Answer above.</p>;
  if (t?.status === 'failed') return <p class="notch-destination" role="status">{why(t)} in {projectName(t.project_id)}.</p>;
  return <p class="notch-destination" role="status">Started in <span>{projectName(t?.project_id ?? sent.to)}</span></p>;
}

function Capture() {
  const route = hinted();
  const to = route ? undefined : destination();
  const a = agent();
  const ready = !a ? '' : !a.installed ? `${agentName(a.id)} is not installed` : a.signed_in === false ? `${agentName(a.id)} is not signed in` : agentName(a.id);
  const session = route?.confidence === 'clear' && 'session' in route.to;
  return (
    <form id="guide-compose" onSubmit={send}>
      <div class="guide-editor">
        <input id="guide-input" autocomplete="off" spellcheck={false} aria-label="Thought" placeholder="Put a thought in"
          value={ui.draft} onInput={(e) => {
            ui.draft = e.currentTarget.value;
            if (ui.undone && !ui.draft.trim()) drop();
            hint();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.isComposing) void send(e);
            else if (e.key === 'z' && e.metaKey && !ui.draft && ui.sent) {
              e.preventDefault();
              void undo();
            }
          }} />
      </div>
      <div class="guide-project-row">
        <button type="button" class="guide-project-button" id="dest-chip" aria-haspopup="listbox" aria-expanded={ui.choosing}
          onClick={() => choose(!ui.choosing)}
          onKeyDown={(e) => (e.key === 'ArrowDown' || e.key === 'ArrowUp') && (e.preventDefault(), choose(true))}>
          <Icon name={session ? 'terminal' : to === 'idea' ? 'note' : to || route ? 'folder' : 'plus'} />
          <span>{route ? routeLabel(route) : to ? projectName(folder(to)) : 'Add a project'}</span>
          <Icon name="down" />
        </button>
        <small class="guide-session">
          {to === 'idea' ? 'Kept as an idea; nothing starts' : route?.confidence === 'ambiguous' ? 'You will be asked which' : ready}
        </small>
      </div>
      {ui.choosing && (
        <div class="dest-list" role="listbox" aria-label="Destination" onKeyDown={arrows}>
          {projects().map((p) => (
            <button type="button" role="option" aria-selected={p.id === (to ?? routedProject(route))} class="surface-button" onClick={() => pick(p.id)}>
              <Icon name="folder" />{p.name}
            </button>
          ))}
          <button type="button" role="option" aria-selected={to === 'idea'} class="surface-button" onClick={() => pick('idea')}>
            <Icon name="note" />Idea
          </button>
          <button type="button" class="surface-button" onClick={() => void addProject()}><Icon name="plus" />Add project…</button>
        </div>
      )}
      <Receipt />
    </form>
  );
}

function Row({ t }: { t: Thought }) {
  const session = t.session_id ? records.sessions.get(t.session_id) : undefined;
  const result = resultOf(t);
  const where = [projectName(t.project_id), agentName(t.agent)].join(' / ');
  const question = openQuestions().find((q) => q.thought_id === t.id);
  // A question only its terminal can answer, such as a folder-trust prompt before the agent starts.
  const terminal = question?.reply_via === 'terminal';
  const [mark, detail] = ({
    captured: ['note', where],
    routed: ['arrow', `${projectName(t.project_id)} · starts in ${secondsLeft(t)} s`],
    working: [t.agent ?? 'terminal', session?.activity.at(-1) ?? where],
    needs_you: ['attention', terminal ? `Waiting in its terminal: ${question.prompt}` : `Needs you · ${where}`],
    done: ['check', result?.summary || 'Done'],
    failed: ['x', `${why(t)}${result?.kind === 'failure' && result.summary ? ': ' + result.summary : session?.error ? ': ' + session.error : ''}`],
  } satisfies Record<Thought['status'], [string, string]>)[t.status];
  const open = () => {
    if (terminal && t.session_id) peek(t.session_id);
    else if (question) {
      ui.question = question.id;
      reveal('pinned', 'answer', '#notch .decision-btn, #notch #comment');
    } else if (t.session_id) peek(t.session_id);
  };
  return (
    <button type="button" class="notch-work-row" data-status={t.status} title={`${t.text}\n${detail}`} onClick={open}
      disabled={!question && !t.session_id}>
      <span class="notch-work-mark" aria-hidden="true"><Icon name={mark} /></span>
      <span><strong>{title(t)}</strong><small>{detail}</small></span>
      {question && !terminal ? <span class="row-open">Answer</span> : t.session_id && <span class="row-open">Open</span>}
    </button>
  );
}

export function Home() {
  const questions = openQuestions();
  const thoughts = [...records.thoughts.values()].filter((t) => t.mode !== 'note' && t.id !== ui.undone?.id);
  const working = thoughts.filter((t) => ['routed', 'working', 'needs_you'].includes(t.status)).sort((a, b) => b.created - a.created);
  const finished = thoughts
    .filter((t) => (t.status === 'done' || t.status === 'failed') && (!t.read || ui.seen.has(t.id)))
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 4);
  // Seen once the notch has shown it for a moment: the glance stops counting it, the row stays until the fold.
  useEffect(() => {
    const unread = finished.filter((t) => !t.read && !ui.seen.has(t.id));
    if (!unread.length || ui.mode === 'closed') return undefined;
    const timer = setTimeout(() => {
      for (const t of unread) {
        ui.seen.add(t.id);
        void call('thought.read', { id: t.id }).catch(fail);
      }
    }, 1200);
    return () => clearTimeout(timer);
  });
  const n = questions.length;
  const heading = n ? `${n === 1 ? 'A question needs' : `${n} questions need`} you` : working.length ? 'Working now' : finished.length ? 'Done' : 'Ready to capture';
  return (
    <>
      <header class="home-heading">
        <div><h1>{heading}</h1></div>
        <button type="button" class="surface-button collapse-button" aria-label="Collapse notch" onClick={fold}><Icon name="down" /></button>
      </header>
      <Capture />
      {n > 0 && (
        <button type="button" class="notch-action" onClick={() => reveal('pinned', 'answer', '#notch .decision-btn, #notch #comment')}>
          Answer {n === 1 ? 'it' : `${n} questions`} <kbd>⌃⌥J</kbd><Icon name="arrow" />
        </button>
      )}
      {working.length + finished.length > 0 && (
        <section class="notch-work" aria-label="Thoughts">
          {[...working, ...finished].map((t) => <Row key={t.id} t={t} />)}
        </section>
      )}
      {ui.error && <p class="notch-error" role="alert">{ui.error}</p>}
      <footer class="home-actions">
        <small class="notch-keys"><kbd>⌃⌥Space</kbd> capture · <kbd>Esc</kbd> close</small>
        {!working.length && (
          <span class="home-art" aria-hidden="true">
            <span class="resonator-film">
              <video muted playsInline loop autoplay={!reduceMotion.matches} poster={poster} src={film} tabIndex={-1} disablePictureInPicture />
            </span>
          </span>
        )}
      </footer>
    </>
  );
}
