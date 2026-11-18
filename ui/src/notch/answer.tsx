// The notch open on a question: the band beside the camera says where it comes from and how many wait; under it the
// thought it is about, the question in full and its answers, the same component a pane and Home show. Whenever a
// question is open it is what the open notch shows; the capture line is one key (C) under it.
import type { Question } from '../../../core/proto/protocol.ts';
import { useEffect } from 'preact/hooks';
import { Capture } from '../capture.tsx';
import { Ask } from '../question.tsx';
import { when } from '../ui.tsx';
import { hooks } from './home.tsx';
import { agentName, call, fail, page, projectName, records, redraw, ui } from './model.ts';
import { peek } from './panel.ts';

export const FIRST = '#sheet [data-question] .ans, #sheet [data-question] .reply input';

export function Answer({ questions }: { questions: Question[] }) {
  const n = questions.length;
  const i = Math.max(0, questions.findIndex((q) => q.id === (ui.question ?? records.glance?.question)));
  const q = questions[i]!;
  const t = q.thought_id ? records.thoughts.get(q.thought_id) : undefined;
  const s = q.session_id ? records.sessions.get(q.session_id) : undefined;
  // Affirm and deny, from any app, act on the question shown here.
  useEffect(() => {
    if (records.glance?.question !== q.id) void call('question.focus', { id: q.id }).catch(fail);
  }, [q.id]);
  const go = (step: number) => {
    ui.question = questions[(i + step + n) % n]!.id;
    page.focus = FIRST;
    redraw();
  };
  const capture = () => {
    ui.capturing = true;
    page.focus = '#capture-input';
    redraw();
  };
  // Where a thought should go is asked by Tasktap, about a thought the card shows in full.
  const router = q.source === 'router';
  const about = router ? '' : t?.text.trim().split('\n')[0] || s?.name || '';
  const who = agentName(s?.agent ?? t?.agent);
  const keys = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).matches('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'c') capture();
    else if ((k === 'arrowright' || k === 'arrowleft') && n > 1) go(k === 'arrowright' ? 1 : -1);
    else if (k === 'arrowdown' || k === 'arrowup') {
      const items = [...document.querySelectorAll<HTMLElement>(FIRST)];
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[(at + (k === 'arrowdown' ? 1 : -1) + items.length) % items.length]?.focus({ focusVisible: true });
    } else return;
    e.preventDefault();
  };
  return (
    <div class="view" onKeyDown={keys}>
      <header class="band">
        <span>{router ? <b>A thought with no place yet</b> : <><b>{projectName(t?.project_id ?? s?.project_id)}</b>{who}</>}</span>
        {n > 1 ? <button type="button" class="of" title="The next question  →" onClick={() => go(1)}>{i + 1} of {n}</button> : <time>{when(t?.updated ?? Date.now())}</time>}
      </header>
      <div class="pad">
        {about && <p class="ctx">{q.source === 'permission' ? `${who} asks permission · ${about}` : about}</p>}
        <Ask q={q} size="notch" who={who} terminal={q.reply_via === 'terminal' && s ? () => peek(s.id) : undefined} />
        {ui.capturing ? <div class="under"><Capture {...hooks} /></div> : (
          <button type="button" class="act quiet" onClick={capture}><kbd>C</kbd><span>Put a thought in</span></button>
        )}
      </div>
    </div>
  );
}
