// The open notch: one capture line with its destination, the receipt with Undo, and the
// thoughts that are working, waiting or finished.
import type { Thought } from '../../../core/proto/protocol.ts';
import { useEffect } from 'preact/hooks';
import poster from '../../../prototype/assets/motion/glyph/miniature.jpg';
import film from '../../../prototype/assets/motion/glyph/miniature.mp4';
import { Capture, cap } from '../capture.tsx';
import { Icon } from '../icons.tsx';
import { agentName, call, fail, openQuestions, page, projectName, records, redraw, resultOf, ui, why } from './model.ts';
import { fold, peek, reveal } from './panel.ts';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const secondsLeft = (t: Thought | undefined) => (t?.hold_until ? Math.max(0, Math.ceil((t.hold_until - Date.now()) / 1000)) : 0);

/** The notch's hooks into the shared capture line, here and under a question. */
export const hooks = {
  // After the folder panel the notch takes the keyboard back.
  picked: () => void call('host.notch', { open: true, key: true }),
  // Started: the notch has done its job unless the person is doing something else in it.
  started: () => ui.mode === 'pinned' && !ui.inside && !openQuestions().length && fold(),
};

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
    needs_you: ['attention', question?.prompt ?? where],
    done: ['check', result?.summary || 'Done'],
    failed: ['x', `${why(t)}${result?.kind === 'failure' && result.summary ? ': ' + result.summary : session?.error ? ': ' + session.error : ''}`],
  } satisfies Record<Thought['status'], [string, string]>)[t.status];
  // The state is a label of its own, so the line keeps all of what it says.
  const state = t.status === 'needs_you' ? (terminal ? 'Waiting in its terminal' : 'Needs you') : '';
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
      <span><strong>{t.text.trim().split('\n')[0]}</strong>{state && <em class="row-state">{state}</em>}<small>{detail}</small></span>
      {question && !terminal ? <span class="row-open">Answer</span> : t.session_id && <span class="row-open">Open</span>}
    </button>
  );
}

export function Home() {
  const questions = openQuestions();
  const thoughts = [...records.thoughts.values()].filter((t) => t.mode !== 'note' && t.id !== cap.undone?.id);
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
  // An open question is never announced here: the notch shows the question itself (answer.tsx).
  const heading = working.length ? 'Working now' : finished.length ? 'Done' : 'Ready to capture';
  return (
    <>
      <header class="home-heading">
        <div><h1>{heading}</h1></div>
        <button type="button" class="surface-button collapse-button" aria-label="Collapse notch" onClick={fold}><Icon name="down" /></button>
      </header>
      <Capture {...hooks} />
      {working.length + finished.length > 0 && (
        <section class="notch-work" aria-label="Thoughts">
          {[...working, ...finished].map((t) => <Row key={t.id} t={t} />)}
        </section>
      )}
      {page.error && <p class="notch-error" role="alert">{page.error}</p>}
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
