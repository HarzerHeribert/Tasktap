// The notch open with nothing asking: the newest result the person has not seen, with Keep and Discard when it ran in
// its own copy of the project; what runs and what else finished, one line each; and the capture line, first when the
// capture shortcut opened it.
import type { Thought } from '../../../core/proto/protocol.ts';
import { useEffect, useState } from 'preact/hooks';
import { Capture, cap } from '../capture.tsx';
import { lost, pending, running, settle, settling, Status } from '../changes.tsx';
import { Answer as Act, Mark, type State, elapsed, plural, when } from '../ui.tsx';
import { agentName, call, fail, openQuestions, projectName, records, redraw, resultOf, title, ui, why } from './model.ts';
import { fold, peek } from './panel.ts';

/** The notch's hooks into the shared capture line, here and under a question. */
export const hooks = {
  // After the folder panel the notch takes the keyboard back.
  picked: () => void call('host.notch', { open: true, key: true }),
  // Started: the notch has done its job unless the person is doing something else in it.
  started: () => ui.mode === 'pinned' && !ui.inside && !openQuestions().length && fold(),
};

const stateOf = (t: Thought): State =>
  t.status === 'working' || t.status === 'routed' ? 'working' : t.status === 'failed' ? 'failed' : t.status === 'done' ? (t.read ? 'ended' : 'ready') : 'ended';

function Row({ t }: { t: Thought }) {
  const s = t.session_id ? records.sessions.get(t.session_id) : undefined;
  const live = t.status === 'working' || t.status === 'routed';
  const fact = t.status === 'routed' ? 'Starting soon' : live ? s?.activity.at(-1) : t.status === 'failed' ? why(t) : resultOf(t)?.summary;
  return (
    <button type="button" class="row" data-status={t.status} title={[t.text, fact].filter(Boolean).join('\n')} disabled={!t.session_id}
      onClick={() => t.session_id && peek(t.session_id)}>
      <Mark s={stateOf(t)} />
      <span class="t">{title(t)}</span>
      <span class="x">{fact}</span>
      <time>{live ? elapsed(t.created) : when(t.updated)}</time>
    </button>
  );
}

/** A result: the thought, its summary, its changes, and what can be done with it. */
function Result({ t }: { t: Thought }) {
  const [asking, ask] = useState<'' | 'keep' | 'discard'>('');
  const r = resultOf(t);
  const changes = pending(t) ? t : null;
  const s = settling.get(t.id);
  const busy = s?.step === 'stopping' || s?.step === 'settling';
  const open = () => t.session_id && peek(t.session_id);
  const keep = () => (changes && running(changes) ? ask('keep') : changes && void settle(changes, true));
  const discard = () => ask('discard');
  const confirm = () => {
    if (!changes) return;
    void settle(changes, asking === 'keep');
    ask('');
  };
  const keys = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).matches('input') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (asking && k === 'enter') confirm();
    else if (asking && k === 'escape') ask('');
    else if (!asking && changes && !busy && k === 'enter' && !(e.target as HTMLElement).closest('button')) keep();
    else if (!asking && changes && !busy && k === 'd') discard();
    else if (!asking && k === 'o') open();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <section class="result" tabIndex={-1} data-result={t.id} onKeyDown={keys}>
      <p class="ctx">{t.status === 'failed' ? 'Failed' : 'Result'}</p>
      <p class="qp">{title(t)}</p>
      {(t.status === 'failed' || r?.summary) && <p class="sum">{t.status === 'failed' ? `${why(t)}${r?.summary ? `: ${r.summary}` : ''}` : r!.summary}</p>}
      {changes && <p class="status"><Status t={changes} /></p>}
      {asking ? (
        <div class="confirm">
          <p>{asking === 'keep' ? 'The session is still running. Stop it and keep its changes?' : `${running(changes!) ? 'Stop the session and discard? ' : 'Discard? '}${lost(changes!)}`}</p>
          <div class="qa">
            <Act k="↩" label={asking === 'keep' ? 'Stop and keep' : 'Discard'} primary={asking === 'keep'} danger={asking === 'discard'} onClick={confirm} />
            <Act k="esc" label="Cancel" onClick={() => ask('')} />
          </div>
        </div>
      ) : (
        <div class="qa">
          {changes && !busy && <Act k="↩" label="Keep" primary onClick={keep} />}
          {changes && !busy && <Act k="D" label="Discard" onClick={discard} />}
          {t.session_id && <Act k="O" label="Open" onClick={open} />}
        </div>
      )}
    </section>
  );
}

export function Home() {
  const thoughts = [...records.thoughts.values()].filter((t) => t.mode !== 'note' && t.id !== cap.undone?.id);
  const working = thoughts.filter((t) => t.status === 'routed' || t.status === 'working').sort((a, b) => b.created - a.created);
  const finished = thoughts
    .filter((t) => (t.status === 'done' || t.status === 'failed') && (!t.read || ui.seen.has(t.id) || pending(t)))
    .sort((a, b) => Number(pending(b)) - Number(pending(a)) || b.updated - a.updated);
  const [top, ...rest] = finished;
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
  const first = ui.capturing || !top;
  const rows = [...working, ...(first ? finished : rest)].slice(0, 4);
  const capture = <div class="capture-block"><Capture stack {...hooks} hint={<><kbd>↩</kbd> start</>} /></div>;
  const words = [working.length && `${working.length} working`, finished.filter((t) => !t.read).length && plural(finished.filter((t) => !t.read).length, 'new result', 'new results')]
    .filter(Boolean).join(' · ');
  return (
    <div class="view">
      <header class="band">
        {first ? <span>New task</span> : <span><b>{projectName(top!.project_id)}</b>{agentName(top!.agent)}</span>}
        <time>{first ? words : when(top!.updated)}</time>
      </header>
      <div class="pad">
        {first ? capture : <Result t={top!} />}
        {rows.length > 0 && <div class="rows">{rows.map((t) => <Row key={t.id} t={t} />)}</div>}
        {!first && capture}
      </div>
    </div>
  );
}

