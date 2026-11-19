// A question, the same wherever it is shown (Home, a pane's strip, the notch, a sheet): stated once and in full, its
// answers as key caps on 1 to 9, a reply in the person's own words on T. One only its terminal can answer offers the
// way there instead. The keys act only while the question's own element has the keyboard, never the terminal's.
import type { AnswerQuestion, Found, Question } from '../../core/proto/protocol.ts';
import { useEffect, useState } from 'preact/hooks';
import { keyName } from './keys.ts';
import { talkKey } from './page.ts';
import { agentName, call, fail, focus, openQuestions, placeArgs, pref, projectName, records, redraw, sessionName } from './page.ts';
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
  else if (q.source === 'router' && k === 'o' && q.thought_id) (other.thought = q.thought_id), redraw();
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
      // Why it is a choice ("named in it", "invoices, export"), and that a project not open yet opens with it.
      const note = q.notes?.[i] ?? '';
      if (s) {
        const asks = openQuestions().some((x) => x.session_id === s.id), idle = s.state === 'idle';
        const mark = <Mark s={asks ? 'asks' : idle || s.state === 'ended' ? 'ended' : 'working'} label={idle && !asks ? 'Waiting for a prompt' : undefined} />;
        return { label: sessionName(s.id), lead: mark, more: `${agentName(s.agent)} · ${projectName(s.project_id)}` };
      }
      if (!p) return { label };
      const card = 'card' in p ? records.cards.get(p.card) : undefined;
      const more = [note, card && !records.projects.get(card.project_id ?? '')?.open ? 'not open yet' : ''].filter(Boolean).join(' · ');
      const name = 'project' in p ? records.projects.get(p.project)?.name : card?.name;
      return { label: name || label, lead: <I n={'session' in p ? 'term' : 'folder'} />, ...(more ? { more } : {}) };
    };
    const elsewhere = q.thought_id ? () => ((other.thought = q.thought_id!), redraw()) : undefined;
    // "Another project…" turns the choices into a field that finds any project, which sends the thought there.
    if (q.thought_id && other.thought === q.thought_id) return <Elsewhere q={q} thought={q.thought_id} />;
    return (
      <div class="qa">
        {answers(q).map((label, i) => (i < 9 ? <Answer k={String(i + 1)} {...place(label, i)} onClick={() => void choose(q, i)} /> : null))}
        {elsewhere && <Answer k="O" label="Another project…" lead={<I n="search" />} onClick={elsewhere} />}
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

/** "Another project…" of a router question: the thought it asks about, sent where a field finds (projects.find: by
 *  its names as typed; with nothing typed, the places the thought's own words name or describe), which moots the
 *  question. Escape goes back to the choices. */
function Elsewhere({ q, thought }: { q: Question; thought: string }) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<Found[]>([]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      // What is typed finds by name; with nothing typed, the places the thought's own words name or describe.
      const typed = text.trim(), asked = typed || records.thoughts.get(thought)?.text || '';
      if (!asked) return setFound([]);
      void call('projects.find', { text: asked, limit: 5, thought: !typed }).then((r) => setFound(r.found.filter((f) => !('session' in f.to))), () => {});
    }, text ? 120 : 0);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => void focus(`[data-question="${q.id}"] .elsewhere input`), []);
  const send = (f: Found) => {
    const to = 'project' in f.to ? f.to.project : 'card' in f.to ? f.to.card : '';
    other.thought = '';
    void call('thought.update', { id: thought, ...placeArgs(to) }).catch(fail);
  };
  const back = () => ((other.thought = ''), redraw(), focus(`[data-question="${q.id}"]`));
  return (
    <div class="qa elsewhere" onKeyDown={(e) => {
      if (e.key === 'Escape') return (e.preventDefault(), e.stopPropagation(), back());
      if (e.key === 'Enter' && !e.isComposing && found[0] && (e.target as HTMLElement).matches('input')) return (e.preventDefault(), send(found[0]));
      const n = Number(e.key);
      if (n >= 1 && n <= found.length && !(e.target as HTMLElement).matches('input')) return (e.preventDefault(), send(found[n - 1]!));
    }}>
      <label class="reply">
        <I n="search" />
        <input aria-label="Find a project" placeholder="Find a project" autocomplete="off" spellcheck={false} value={text} onInput={(e) => setText(e.currentTarget.value)} />
        <Key k="esc" cap />
      </label>
      {found.map((f, i) => (
        <Answer k={String(i + 1)} label={f.name} lead={<I n="folder" />} more={[f.why, 'card' in f.to ? 'not open yet' : f.folder].filter(Boolean).join(' · ')} onClick={() => send(f)} />
      ))}
      {!found.length && text.trim() && <span class="q-detail">No project by that name.</span>}
    </div>
  );
}

/** The thought whose router question shows "Another project…" as a field, while it does. */
const other = { thought: '' };

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
