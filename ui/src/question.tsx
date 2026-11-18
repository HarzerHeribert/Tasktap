// A question, the same wherever it is shown (Home, a pane's strip, the notch, a sheet): stated once and in full, its
// answers as key caps on 1 to 9, a reply in the person's own words on T. One only its terminal can answer offers the
// way there instead. The keys act only while the question's own element has the keyboard, never the terminal's.
import type { AnswerQuestion, Question } from '../../core/proto/protocol.ts';
import { keyName, talkKey } from './keys.ts';
import { agentName, call, fail, focus, openQuestions, pref, projectName, records, sessionName } from './page.ts';
import { control, mine, talk } from './speech/record.ts';
import { Answer, I, Key, Level, Mark } from './ui.tsx';
import { briefOf } from './way.ts';

type Response = AnswerQuestion extends infer A ? (A extends { id: string } ? Omit<A, 'id'> : never) : never;

export const reply = (q: Question, r: Response) => call('question.answer', { id: q.id, ...r } as AnswerQuestion).catch(fail);

/** The answers a question offers, by their keys. */
export function answers(q: Question): string[] {
  if (q.reply_via === 'terminal') return [];
  return q.kind === 'choice' ? q.choices : q.kind === 'confirm' ? ['Yes', 'No'] : [];
}
const choose = (q: Question, k: number) =>
  q.kind === 'confirm' ? reply(q, { kind: k === 0 ? 'affirm' : 'deny' }) : reply(q, { kind: 'choice', choice: k });

/** The keys of a question with the keyboard: 1 to 9, Y and N for a yes or no, T to reply, Return for its terminal. */
export function keys(q: Question, e: KeyboardEvent, terminal?: () => void): boolean {
  const target = e.target as HTMLElement;
  if (target.matches('input, textarea') || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return false;
  const k = e.key.toLowerCase(), all = answers(q), n = Number(k);
  if (q.reply_via === 'terminal') {
    if (k !== 'enter' || !terminal || target.closest('button')) return false;
    terminal();
  } else if (n >= 1 && n <= Math.min(9, all.length)) void choose(q, n - 1);
  else if (q.source === 'router' && k === 'l') void reply(q, { kind: 'deny' });
  else if (q.kind === 'confirm' && (k === 'y' || k === 'n')) void choose(q, k === 'y' ? 0 : 1);
  else if (k === 't') focus((e.currentTarget as HTMLElement).querySelector<HTMLElement>('.reply input'));
  else return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}

/** The answers and the reply field. `cls` is the answer's look: key cap and label, or a ruled row in the notch. */
export function Answers({ q, terminal, who }: { q: Question; terminal?: () => void; who?: string }) {
  if (q.reply_via === 'terminal')
    return (
      <div class="qa">
        {terminal && <Answer k="↩" label="Answer in its terminal" primary onClick={terminal} />}
        {!terminal && <span class="q-detail">{who ?? 'The agent'} takes the answer in its terminal.</span>}
      </div>
    );
  // Where a thought should go: the folders and sessions it could mean, each on its key, and the way to keep it for
  // later. No reply in words: a place is one of these. What each choice is, the question says itself (`places`): a
  // folder by its name; a session by its state, its name, and its agent and folder. A choice it says nothing of is
  // shown in the core's words, with no mark.
  if (q.source === 'router') {
    const place = (label: string, i: number) => {
      const p = q.places?.[i], s = p && 'session' in p ? records.sessions.get(p.session) : undefined;
      if (s) {
        const asks = openQuestions().some((x) => x.session_id === s.id), idle = s.state === 'idle';
        const mark = <Mark s={asks ? 'asks' : idle || s.state === 'ended' ? 'ended' : 'working'} label={idle && !asks ? 'Waiting for a prompt' : undefined} />;
        return { label: sessionName(s.id), lead: mark, more: `${agentName(s.agent)} · ${projectName(s.project_id)}` };
      }
      if (!p) return { label };
      return { label: ('project' in p && records.projects.get(p.project)?.name) || label, lead: <I n={'project' in p ? 'folder' : 'term'} /> };
    };
    return (
      <div class="qa">
        {answers(q).map((label, i) => (i < 9 ? <Answer k={String(i + 1)} {...place(label, i)} onClick={() => void choose(q, i)} /> : null))}
        <Answer k="L" label="Keep for later" lead={<I n="later" />} onClick={() => void reply(q, { kind: 'deny' })} />
      </div>
    );
  }
  // Speech into the reply: its words arrive in the field, and nothing is sent before Return.
  const d = talk.field?.closest<HTMLElement>('[data-question]')?.dataset.question === q.id ? mine() : undefined;
  const hears = d?.phase === 'recording' || d?.phase === 'transcribing';
  const field = (e: Event) => (e.currentTarget as HTMLElement).closest('.reply')!.querySelector('input');
  return (
    <div class="qa">
      {answers(q).map((label, i) => (i < 9 ? <Answer k={String(i + 1)} label={label} onClick={() => void choose(q, i)} /> : null))}
      <label class="reply" data-hears={hears || undefined}>
        {d?.phase === 'recording' ? <Level l={d.level / 100} /> : <Key k="T" cap />}
        <input aria-label="Reply" placeholder={d?.phase === 'recording' ? 'Listening' : hears ? 'Writing it down…' : q.kind === 'text' ? 'Your answer' : 'Reply in your own words'} autocomplete="off" spellcheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.isComposing) {
              const text = e.currentTarget.value.trim();
              if (text) void reply(q, { kind: 'text', text });
              e.preventDefault();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              focus(e.currentTarget.closest<HTMLElement>('[data-question]'));
            }
          }} />
        <button type="button" class="mic" data-off={!pref('speech_by') || undefined} aria-label="Talk" title={`Hold to talk, or hold ${keyName(talkKey())} in the field`}
          onPointerDown={(e) => control.down(e, field(e))} onClick={(e) => control.key(e, field(e))}>
          <I n="mic" />
        </button>
      </label>
    </div>
  );
}

/** The question in full and its answers, inside an element that takes the keyboard for them. */
export function Ask({ q, size, terminal, who, class: cls = '' }: { q: Question; size: 'home' | 'notch' | 'pane'; terminal?: () => void; who?: string; class?: string }) {
  // The router's question is about a thought that has no place yet: the thought in full, and its brief so far.
  const said = q.source === 'router' && q.thought_id ? records.thoughts.get(q.thought_id) : undefined;
  return (
    <div class={`ask-${size} ${cls}`} data-question={q.id} tabIndex={-1} onKeyDown={(e) => keys(q, e, terminal)}>
      <p class="qp">{q.prompt}</p>
      {said && <p class="way-w"><span>You said</span>{said.text}</p>}
      {said && briefOf(said) && <p class="way-b"><span>Brief so far</span>{briefOf(said)}</p>}
      {q.detail && <p class="q-detail">{q.detail}</p>}
      <Answers q={q} terminal={terminal} who={who} />
    </div>
  );
}
