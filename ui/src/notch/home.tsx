// The open notch: one capture line with its destination, the receipt with Undo, and the
// thoughts that are working, waiting or finished.
import type { Thought } from '../../../core/proto/protocol.ts';
import { useEffect } from 'preact/hooks';
import poster from '../../../prototype/assets/motion/glyph/miniature.jpg';
import film from '../../../prototype/assets/motion/glyph/miniature.mp4';
import { uuid7 } from '../client.ts';
import { Icon } from '../icons.tsx';
import {
  agent, agentName, call, destination, fail, openQuestions, projectName, projects, records, redraw, resultOf, title, ui, why,
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

async function send(e: Event) {
  e.preventDefault();
  const text = ui.draft.trim();
  if (!text) return;
  const to = destination() ?? (await addProject());
  if (!to) return;
  try {
    let id = uuid7();
    if (to === 'idea') await call('thought.capture', { id, text, strokes: [], source: 'typed', mode: 'note' });
    else if (ui.undone?.text === text) {
      // The thought Undo returned to the person goes out again rather than a copy of it.
      id = ui.undone.id;
      await call('thought.update', { id, project_id: to });
    } else await call('thought.capture', { id, text, strokes: [], source: 'typed', project_id: to });
    Object.assign(ui, { sent: { id, text, to }, undone: null, draft: '', error: '' });
  } catch (err) {
    fail(err);
  }
  redraw();
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
    Object.assign(ui, { sent: null, draft: sent.text, dest: sent.to, focus: '#guide-input' });
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
        Sent to <span>{projectName(sent.to)}</span>{t ? ` · starts in ${secondsLeft(t)} s ` : ' '}{undoButton}
      </p>
    );
  if (t?.status === 'failed') return <p class="notch-destination" role="status">{why(t)} in {projectName(sent.to)}.</p>;
  return <p class="notch-destination" role="status">Started in <span>{projectName(sent.to)}</span></p>;
}

function Capture() {
  const to = destination();
  const a = agent();
  const ready = !a ? '' : !a.installed ? `${agentName(a.id)} is not installed` : a.signed_in === false ? `${agentName(a.id)} is not signed in` : agentName(a.id);
  return (
    <form id="guide-compose" onSubmit={send}>
      <div class="guide-editor">
        <input id="guide-input" autocomplete="off" spellcheck={false} aria-label="Thought" placeholder="Put a thought in"
          value={ui.draft} onInput={(e) => (ui.draft = e.currentTarget.value)}
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
          <Icon name={to === 'idea' ? 'note' : to ? 'folder' : 'plus'} />
          <span>{to ? projectName(folder(to)) : 'Add a project'}</span>
          <Icon name="down" />
        </button>
        <small class="guide-session">{to === 'idea' ? 'Kept as an idea; nothing starts' : ready}</small>
      </div>
      {ui.choosing && (
        <div class="dest-list" role="listbox" aria-label="Destination" onKeyDown={arrows}>
          {projects().map((p) => (
            <button type="button" role="option" aria-selected={p.id === to} class="surface-button" onClick={() => pick(p.id)}>
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
  const [mark, detail] = ({
    captured: ['note', where],
    routed: ['arrow', `${projectName(t.project_id)} · starts in ${secondsLeft(t)} s`],
    working: [t.agent ?? 'terminal', stuck(t) ? 'Waiting in its terminal: open it to see' : (session?.activity.at(-1) ?? where)],
    needs_you: ['attention', `Needs you · ${where}`],
    done: ['check', result?.summary || 'Done'],
    failed: ['x', `${why(t)}${result?.kind === 'failure' && result.summary ? ': ' + result.summary : session?.error ? ': ' + session.error : ''}`],
  } satisfies Record<Thought['status'], [string, string]>)[t.status];
  const question = openQuestions().find((q) => q.thought_id === t.id);
  const open = () => {
    if (question) {
      ui.question = question.id;
      reveal('pinned', 'answer', '#notch .decision-btn, #notch #comment');
    } else if (t.session_id) peek(t.session_id);
  };
  return (
    <button type="button" class="notch-work-row" data-status={t.status} title={`${t.text}\n${detail}`} onClick={open}
      disabled={!question && !t.session_id}>
      <span class="notch-work-mark" aria-hidden="true"><Icon name={mark} /></span>
      <span><strong>{title(t)}</strong><small>{detail}</small></span>
      {question ? <span class="row-open">Answer</span> : t.session_id && <span class="row-open">Open</span>}
    </button>
  );
}

/** A run whose agent has not reported for a while after it started is most likely asking
 *  something in its terminal before its hooks run (a folder it has not trusted yet). */
const stuck = (t: Thought) =>
  t.status === 'working' && records.sessions.get(t.session_id ?? '')?.state === 'starting' && Date.now() - t.updated > 8000;

export function Home() {
  const questions = openQuestions();
  const thoughts = [...records.thoughts.values()].filter((t) => t.mode !== 'note' && t.id !== ui.undone?.id);
  const working = thoughts.filter((t) => ['routed', 'working', 'needs_you'].includes(t.status)).sort((a, b) => b.created - a.created);
  const finished = thoughts
    .filter((t) => (t.status === 'done' || t.status === 'failed') && (!t.read || ui.seen.has(t.id)))
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 4);
  // A starting run is looked at again until its agent reports.
  useEffect(() => {
    if (!working.some((t) => t.status === 'working' && records.sessions.get(t.session_id ?? '')?.state === 'starting')) return undefined;
    const timer = setInterval(redraw, 2000);
    return () => clearInterval(timer);
  });
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
