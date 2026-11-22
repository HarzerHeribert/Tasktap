// A question, the same wherever it is shown (Home, a pane's strip, the notch, a sheet): stated once and in full, its
// answers as key caps on 1 to 9, a reply in the person's own words on T. One only its terminal can answer offers the
// way there instead. The keys act only while the question's own element has the keyboard, never the terminal's.
// Tasktap's own question, where a task goes, leads with the person's words (the owner, 2026-11-21).
import type { AnswerQuestion, Found, Question } from '../../core/proto/protocol.ts';
import { useEffect, useState } from 'preact/hooks';
import { uuid7 } from './client.ts';
import { keyName } from './keys.ts';
import { type Asked, asked, short } from './place.ts';
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

/** The rows of the router's question, in their order, each on its number from 1 (place.ts `asked`): the places its
 *  words name or clearly describe, then "Another project…", which turns them into a field that finds any project, the
 *  Scratchpad and "Keep for later"; with none, "Open or create a folder…" first. No letter keys: every row has a number
 *  (NOTES §13). */
export function routerRows(q: Question): (Asked & { label: string; act: () => void })[] {
  const places = answers(q).map((label, i) => {
    const p = q.places?.[i], card = p && 'card' in p ? records.cards.get(p.card) : undefined;
    const name = !p ? label : 'session' in p ? sessionName(p.session) : ('project' in p ? records.projects.get(p.project)?.name : card?.name) || label;
    return { name, why: q.notes?.[i] ?? '', fresh: !!card && !records.projects.get(card.project_id ?? '')?.open, session: !!p && 'session' in p };
  });
  const thought = q.thought_id ?? '';
  const send = (project: string | undefined) => void (project && call('thought.update', { id: thought, project_id: project }).catch(fail));
  // A follow-up whose session's agent asks first: its own question, while it still asks, answered in the task's words
  // on this key alone (core state.rs `reply_with`).
  const asking = q.answers ? records.questions.get(q.answers) : undefined;
  const by = asking?.state === 'open' && asking.session_id ? records.sessions.get(asking.session_id)?.agent : undefined;
  const act = (r: Asked) =>
    r.does === 'reply' ? () => void reply(q, { kind: 'affirm' })
      : r.does === 'place' || r.does === 'session' ? () => void choose(q, r.at!)
      : r.does === 'other' ? () => ((other.thought = thought), redraw())
        : r.does === 'scratch' ? () => send([...records.projects.values()].find((p) => p.kind === 'scratch')?.id)
          : r.does === 'folder' ? () => void openFolder(thought)
            : r.does === 'create' ? () => void create(q)
              : () => void reply(q, { kind: 'deny' });
  return asked({ places, known: knowsAny(), create: q.create, reply: by ? agentName(by) : null }).map((r) => ({ ...r, label: r.name, act: act(r) }));
}

/** Tasktap knows a project a task could go to: a folder open, or one it found and has not opened. */
const knowsAny = () => [...records.projects.values()].some((p) => p.open && p.kind === 'folder')
  || [...records.cards.values()].some((c) => !c.copy_of && !c.inside && !c.hidden && c.available);
/** The folder that holds most of the projects Tasktap knows, two at least: where the folder panel opens. */
function usual(): string | undefined {
  const held = new Map<string, number>();
  for (const c of records.cards.values()) {
    const up = c.folder.replace(/[\\/]+[^\\/]+[\\/]*$/, '');
    if (!c.copy_of && !c.inside && !c.hidden && up) held.set(up, (held.get(up) ?? 0) + 1);
  }
  const [most] = [...held].sort((a, b) => b[1] - a[1]);
  return most && most[1] >= 2 ? most[0] : undefined;
}
/** "Open or create a folder…": the system's folder panel, where the person keeps their projects; the folder chosen
 *  opens as a workspace, and the task goes there. Closed without a choice, the question stays. Once at a time: a
 *  second press while the panel is open does nothing. */
let picking = false;
async function openFolder(thought: string) {
  if (picking) return;
  picking = true;
  try {
    const at = usual();
    const chosen = await call('host.pick', { folder: true, ...(at ? { at } : {}) });
    const added = chosen ? await call('project.add', { id: uuid7(), folder: chosen }) : undefined;
    if (added) await call('thought.update', { id: thought, project_id: added });
  } catch (e) {
    fail(e);
  } finally {
    picking = false;
  }
}

/** A new project a model proposed, its row's one key: the folder is made (or, there already, taken as it is), opens
 *  as a workspace as "Open or create a folder…" opens one, and the task goes there. Once at a time, as that row. */
async function create(q: Question) {
  if (picking || !q.create || !q.thought_id) return;
  picking = true;
  try {
    const added = await call('project.add', { id: uuid7(), folder: q.create.folder, ...(q.create.exists ? {} : { create: true }) });
    await call('thought.update', { id: q.thought_id, project_id: added });
  } catch (e) {
    fail(e);
  } finally {
    picking = false;
  }
}

/** The keys of a question with the keyboard: 1 to 9, Y and N for a yes or no, T to reply, Return for its terminal;
 *  the arrows from one answer to the next (past the first or the last they are the page's again), and Return on one
 *  answers with it. */
export function keys(q: Question, e: KeyboardEvent, terminal?: () => void): boolean {
  const target = e.target as HTMLElement;
  if (target.matches('input, textarea') || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return false;
  const k = e.key.toLowerCase(), all = answers(q), n = Number(k);
  if (k === 'arrowdown' || k === 'arrowup') {
    const rows = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.qa > .ans')];
    const at = rows.indexOf(document.activeElement as HTMLElement), to = k === 'arrowdown' ? (at < 0 ? 0 : at + 1) : at - 1;
    if (to < 0 || to >= rows.length) return false;
    rows[to]!.focus({ focusVisible: true });
  } else if (q.reply_via === 'terminal') {
    if (k !== 'enter' || !terminal || target.closest('button')) return false;
    terminal();
  } else if (q.source === 'router' && k.length === 1 && n >= 1 && n <= routerRows(q).length) routerRows(q)[n - 1]!.act();
  else if (q.source !== 'router' && k.length === 1 && n >= 1 && n <= Math.min(9, all.length)) void choose(q, n - 1);
  else if (q.kind === 'confirm' && (k === 'y' || k === 'n')) void choose(q, k === 'y' ? 0 : 1);
  else if (k === 't') focus((e.currentTarget as HTMLElement).querySelector<HTMLElement>('.reply input'));
  else return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}

/** The answers and the reply field. `cls` is the answer's look: key cap and label, or a ruled row in the notch. */
export function Answers({ q, terminal, who, on }: { q: Question; terminal?: () => void; who?: string; on?: number }) {
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
    // A session it may continue says its state, and whose it is and where; a project, why it is offered ("matches
    // “invoice”, “export”"), or nothing where the task names it. Each after a gap, in the dim tone.
    const session = (r: Asked) => {
      const p = q.places?.[r.at!], s = p && 'session' in p ? records.sessions.get(p.session) : undefined;
      if (!s) return {};
      const asks = openQuestions().some((x) => x.session_id === s.id), idle = s.state === 'idle';
      const mark = <Mark s={asks ? 'asks' : idle || s.state === 'ended' ? 'ended' : 'working'} label={idle && !asks ? 'Waiting for a prompt' : undefined} />;
      return { lead: mark, more: `${agentName(s.agent)} in ${projectName(s.project_id)}` };
    };
    // "Another project…" turns the choices into a field that finds any project, which sends the thought there.
    if (q.thought_id && other.thought === q.thought_id) return <Elsewhere q={q} thought={q.thought_id} />;
    // One under another, each whole: a row of places wrapped and cut at the window's edge (the owner, 2026-11-19).
    // `on`: the row Return takes at the Composer, which the arrows move there.
    return (
      <div class="qa rows">
        {routerRows(q).map((r, i) => (
          <Answer k={String(i + 1)} cls={on === i ? 'ans on' : 'ans'} label={r.label} lead={<I n={r.mark} />} more={r.dim || undefined} title={r.title}
            {...(r.does === 'session' ? session(r) : {})} onClick={r.act} />
        ))}
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
        {d?.phase === 'recording' ? <Level size={14} l={d.level / 100} /> : <Key k="T" cap />}
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
  // Back to the choices, and the keyboard to where it was: the Composer's field, for a question asked at it.
  const back = () => {
    other.thought = '';
    redraw();
    const at = document.querySelector<HTMLElement>(`[data-question="${q.id}"]`);
    focus(at?.dataset.keys === 'field' ? at.closest('form')?.querySelector<HTMLElement>('#capture-input') : at);
  };
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

/** The question in full and its answers, inside an element that takes the keyboard for them; their key caps show
 *  while it has it (page.ts markHeld). `cap`: asked at the Composer about the thought just sent (capture.tsx), in the
 *  colour of what needs the person, the thought quoted in one line. Its keys are the Composer's field's while that is
 *  empty (capture.tsx `atComposer`), so its caps show while the field has the keyboard; `on` is the row Return takes. */
export function Ask({ q, size, terminal, who, class: cls = '', on }: { q: Question; size: 'home' | 'notch' | 'pane' | 'cap'; terminal?: () => void; who?: string; class?: string; on?: number }) {
  // The router's question is about a thought that has no place yet: the person's words lead, in the card's largest
  // type (three lines at most, all of them in its tooltip); under them, quietly, the question; then the brief so far,
  // and the answers. One order on Home, at the Composer and in the notch. Its name for VoiceOver: the question, then
  // the words.
  const said = q.source === 'router' && q.thought_id ? records.thoughts.get(q.thought_id) : undefined;
  const line = said?.text.trim().split('\n')[0] ?? '';
  if (q.source === 'router') {
    const text = said?.text.trim() ?? '';
    return (
      <div class={`ask-${size} ask-place ${cls}`} data-question={q.id} role="group" aria-label={`${q.prompt} ${short(text)}`.trim()}
        {...(size === 'cap' ? { 'data-keys': 'field' } : { 'data-keys': true, tabIndex: -1, onKeyDown: (e: KeyboardEvent) => keys(q, e, terminal) })}>
        {text && <p class="q-words" dir="auto" title={short(text)}>{text}</p>}
        <p class="q-asks">{size === 'cap' && <Mark s="asks" label="" />}{q.prompt}</p>
        {said && briefOf(said) && <p class="way-b"><span>Brief so far</span>{briefOf(said)}</p>}
        <Answers q={q} on={on} terminal={terminal} who={who} />
      </div>
    );
  }
  return size === 'cap' ? (
    <div class={`ask-cap ${cls}`} data-question={q.id} data-keys="field">
      <p class="qp"><Mark s="asks" label="" />{q.prompt}</p>
      {said && <p class="q-quote" title={said.text}>“{line}”</p>}
      {q.detail && <p class="q-detail">{q.detail}</p>}
      <Answers q={q} on={on} />
    </div>
  ) : (
    <div class={`ask-${size} ${cls}`} data-question={q.id} data-keys tabIndex={-1} onKeyDown={(e) => keys(q, e, terminal)}>
      <p class="qp">{q.prompt}</p>
      {said && <p class="way-w"><span>You said</span>{said.text}</p>}
      {said && briefOf(said) && <p class="way-b"><span>Brief so far</span>{briefOf(said)}</p>}
      {q.detail && <p class="q-detail">{q.detail}</p>}
      <Answers q={q} terminal={terminal} who={who} />
    </div>
  );
}
