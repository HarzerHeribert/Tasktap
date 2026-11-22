// A session's details, to read: what it is at a glance (its agent and state, the folder or the copy it runs in, with
// what became of the copy's changes), what can be done with it, and its history, newest turn first. A turn is the
// thought that began it, in the person's words, with the brief if one was written and how it came by its place; then,
// in their order, what was asked and how that was answered, and what came back. All of it is from records the page
// holds; turns that left the live set are read from the core's history (past.ts), as many pages as it takes to find them.
import type { Question, Session, Thought, TurnResult } from '../../../core/proto/protocol.ts';
import { useEffect, useRef } from 'preact/hooks';
import { cap } from '../capture.tsx';
import { pending, Status, Told } from '../changes.tsx';
import { plain as unmarked } from './markdown.ts';
import { Glyph, I, Mark, madeAt, plural, when } from '../ui.tsx';
import { plain, shownPath } from '../system.ts';
import { briefOf, placed } from '../way.ts';
import { agentName, cue, dismiss, focusSession, label, open, page, projectOf, records, why } from './model.ts';
import { older, past } from './past.ts';
import { type Act, Frame } from './sheets.tsx';

/** The time of day of something in a turn; the turn's own first line says the day. */
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** How a question was answered, in words. */
function answered(q: Question): string {
  const a = q.answer;
  if (!a) return q.state === 'open' ? 'Waiting for your answer' : 'Withdrawn before it was answered';
  if (a.kind === 'choice') return (q.kind === 'choice' && q.choices[a.choice]) || `Choice ${a.choice + 1}`;
  if (a.kind === 'text') return a.text;
  if (a.kind === 'terminal') return 'Answered in its terminal';
  return q.source === 'router' ? 'Kept for later' : a.kind === 'affirm' ? 'Yes' : 'No';
}

/** One turn: the thought, then what was asked and what came back, in their order. One set of columns for every line:
 *  the time, the mark, the words. */
function Turn({ t, s, questions, results }: { t: Thought; s: Session; questions: Question[]; results: TurnResult[] }) {
  const brief = briefOf(t), how = placed(t, agentName);
  const events = [...questions.map((q) => ({ at: madeAt(q.id), q })), ...results.map((r) => ({ at: madeAt(r.id), r }))].sort((a, b) => a.at - b.at);
  const runs = s.thought_id === t.id && t.status === 'working';
  return (
    <section class="tn" data-thought={t.id}>
      <time>{when(t.created)}</time>{t.source === 'voice' ? <I n="mic" /> : <span />}
      <p class="tn-t">{t.text}</p>
      {brief && <p class="way-b"><span>Brief{t.route?.title && <b>{t.route.title}</b>}</span>{brief}</p>}
      {how && <p class="way-n">{how}</p>}
      {events.map((e) => 'q' in e ? (
        <>
          <time>{clock(e.at)}</time><Mark s="asks" label="" />
          <p class="tn-q">{e.q.prompt}</p>
          <p class="way-w">{e.q.answer && <span>Answered {clock(e.q.answer.created)}</span>}{answered(e.q)}</p>
        </>
      ) : (
        <>
          <time>{clock(e.at)}</time><Mark s={e.r.kind === 'failure' ? 'failed' : 'ready'} label="" />
          <p class="tn-r">{e.r.kind === 'failure' ? `${why(t)}${e.r.summary ? `: ${unmarked(e.r.summary)}` : ''}` : unmarked(e.r.summary)}</p>
        </>
      ))}
      {runs && <><time /><Mark s="working" label="" /><p class="tn-r">{s.activity.at(-1) ?? 'Working'}</p></>}
      {!runs && t.status === 'failed' && !results.some((r) => r.kind === 'failure') && <><time>{clock(t.updated)}</time><Mark s="failed" label="" /><p class="tn-r">{why(t)}</p></>}
    </section>
  );
}

export function SessionSheet({ id }: { id: string }) {
  const s = records.sessions.get(id);
  const seen = new Set<string>();
  const turns = [...records.thoughts.values(), ...past.thoughts]
    .filter((t) => t.session_id === id && !seen.has(t.id) && (seen.add(t.id), true)).sort((a, b) => b.created - a.created);
  // Turns the page does not hold are further back in the core's history: read on until they are found or it ends.
  const pages = useRef(0);
  const missing = !!s && turns.length < s.turn && past.more;
  useEffect(() => {
    if (missing && !past.loading && pages.current < 12) (pages.current++, void older());
  });
  if (!s) return <Frame title="This session is gone" acts={[{ k: 'esc', label: 'Close', do: dismiss }]} />;
  const term = s.terminal_id ?? '', c = cue(term), project = records.projects.get(s.project_id);
  const home = (path: string) => shownPath(path);
  // The copy it works in is its thoughts': the newest that has one says what became of the changes.
  const copy = turns.find((t) => t.workdir), w = copy?.workdir;
  const changes = turns.find((t) => pending(t));
  const live = records.terminals.get(term)?.state === 'running';
  const all = (t: Thought) => [...records.questions.values(), ...past.questions.values()].filter((q, i, a) => q.thought_id === t.id && a.findIndex((x) => x.id === q.id) === i);
  const acts: Act[] = [
    ...(term ? [{ k: '↩', label: 'Open its terminal', kind: 'primary' as const, do: () => (dismiss(), void focusSession(id)) }] : []),
    { k: 'F', label: 'Follow up', do: () => {
      dismiss();
      // A thought begun here is this session's follow-up unless its words say otherwise.
      Object.assign(cap, { usual: s.project_id, current: id });
      page.focus = '#capture-input';
      open({ kind: 'capture' });
    } },
    ...(changes ? [{ k: 'R', label: 'Review changes', do: () => open({ kind: 'review', thought: changes.id }) }] : []),
    ...(live ? [{ k: '⌘⌫', label: 'Stop…', kind: 'danger' as const, do: () => open({ kind: 'stop', project: projectOf(term), id: term }) }] : []),
  ];
  return (
    <Frame size="md" title={term ? label(term) : s.name || agentName(s.agent)} acts={acts}>
      <div class="sx">
        <div class="list">
        <div class="line">
          <Glyph agent={s.agent} />
          <span class="t">{agentName(s.agent)}</span>
          <span class="x"><span class="sx-s"><Mark s={c.s} label="" />{c.words}</span>{c.activity && c.s === 'working' ? ` · ${c.activity}` : ''}</span>
          <span class="x">{plural(s.turn, 'turn', 'turns')}{s.model ? ` · ${s.model}` : ''}</span>
        </div>
        <div class="line">
          <I n={w ? 'bg' : 'folder'} />
          <span class="t">{w ? `A copy of ${project?.name ?? 'its folder'}` : (project?.name ?? 'Its folder')}</span>
          <span class="x mono" title={plain(w ? w.path : project?.folder ?? '')}>{w ? `${w.branch}${w.destination ? ` → ${w.destination}` : ''}` : home(s.cwd || project?.folder || '')}</span>
          <span class="x sx-d">{copy && w && <Status t={{ ...copy, workdir: w }} />}</span>
        </div>
        </div>
        {changes && <Told t={changes} />}
        {turns.map((t) => <Turn key={t.id} t={t} s={s} questions={all(t)} results={[...records.results.values()].filter((r) => r.thought_id === t.id)} />)}
        {!turns.length && !missing && <p class="sx-n">Nothing was asked of it through Tasktap yet.</p>}
        {missing && (past.loading || pages.current < 12 ? <p class="sx-n" role="status">Reading its earlier turns…</p>
          : <button type="button" class="more" onClick={() => ((pages.current = 0), void older())}>Read further back<I n="chev" /></button>)}
      </div>
    </Frame>
  );
}
