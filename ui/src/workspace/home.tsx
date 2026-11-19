// Home, a dashboard in layers ("Folds", design/ui-directions/NOTES.md §2). The first layer is what the person needs to
// see or act on when the window opens: the capture line, what needs them (the first question open, the rest one line
// each), changes waiting to be kept, what is running. Results and For later are one line each that opens in place; "All
// results" leads to Earlier. Before any folder is open it is one composition: the Composer a little above the middle
// and, on its edges, the one thing to do first. It is never bare (with nothing asking or running, the last two results show) and never a
// flood (four running rows, then a line that opens the rest).
import type { Question, Thought } from '../../../core/proto/protocol.ts';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { Capture, cap, offerable, where } from '../capture.tsx';
import { next, pending, running, settle, Status, Told } from '../changes.tsx';
import { Ask } from '../question.tsx';
import { Answer, I, Key, Mark, Seat, type State, elapsed, plural, said, when } from '../ui.tsx';
import { laterWhy, placed } from '../way.ts';
import { Light, useLight } from './light.tsx';
import { popup } from './menu.ts';
import { older, past } from './past.ts';
import {
  agentName, call, details, endedSays, fail, focus, focusSession, layout, open, openQuestions, page, projectName, projects, records, redraw, resultOf, show,
  title, ui, unheard, why, workspaces,
} from './model.ts';

/** The rows Home draws, from the records: one pass. */
export function home() {
  const all = [...records.thoughts.values()];
  const thoughts = all.filter((t) => t.mode !== 'note');
  const questions = openQuestions();
  const bg = new Set(workspaces().flatMap((p) => layout(p.id).background));
  const inBackground = (t: Thought) => {
    const s = t.session_id ? records.sessions.get(t.session_id) : undefined;
    return !!s?.terminal_id && bg.has(s.terminal_id);
  };
  // A thought that is placed and held is not running yet: it is on its way, under the Composer, with its Undo.
  const runningRows = thoughts.filter((t) => t.status === 'working')
    .sort((a, b) => Number(inBackground(a)) - Number(inBackground(b)) || b.created - a.created);
  const waiting = thoughts.filter((t) => pending(t)).sort((a, b) => b.updated - a.updated);
  const results = thoughts.filter((t) => (t.status === 'done' || t.status === 'failed') && !pending(t)).sort((a, b) => b.updated - a.updated);
  const later = all.filter((t) => t.mode === 'note' && t.phase === 'captured').sort((a, b) => b.created - a.created);
  return { questions, running: runningRows, waiting, results, later, inBackground };
}

// What an agent of the plain tier ran has ended, whatever came of it: never a result that is ready (page.ts unheard).
const stateOf = (t: Thought): State => (t.status === 'failed' ? 'failed' : !t.read && !unheard(t) ? 'ready' : 'ended');

/** What a row says under its title, quietly: where, who, and the one fact, in that order, so that what gives way where
 *  there is no room is the end of the fact, never where it is or who works on it. */
function Meta({ where, who, fact }: { where?: string; who?: string; fact?: ComponentChildren }) {
  return <span class="hr-m">{where && <span class="hr-w">{where}</span>}{who && <span class="hr-by">{who}</span>}{fact && <span class="hr-x">{fact}</span>}</span>;
}

/** A question: open, in full with its answers; or a row that opens it, the question where a thought's row has its
 *  title. Its seat is the agent that asks, in the attention colour. */
function QuestionRow({ q, open: isOpen, choose }: { q: Question; open: boolean; choose: () => void }) {
  const t = q.thought_id ? records.thoughts.get(q.thought_id) : undefined;
  const s = q.session_id ? records.sessions.get(q.session_id) : undefined;
  // Where a thought should go is Tasktap's own question, about a thought that has no folder yet.
  const router = q.source === 'router';
  const agent = router ? null : (s?.agent ?? t?.agent);
  const who = router ? 'A thought with no place yet' : agentName(agent ?? undefined);
  const where = router ? 'No place yet' : projectName(t?.project_id ?? s?.project_id);
  const seat = <Seat agent={agent} s="asks" size={20} label={router ? 'Needs your answer' : `${who} asks`} />;
  const time = <time>{elapsed(t?.updated ?? Date.now())}</time>;
  if (!isOpen)
    return (
      <button type="button" class="hr ask" data-nav onClick={choose} title={q.prompt}>
        {seat}<span class="hr-t">{q.prompt}</span>{time}
        <Meta where={where} who={router ? undefined : who} fact={t ? title(t) : undefined} />
      </button>
    );
  return (
    <article class="hq open">
      {seat}
      <span class="hq-m">
        {router ? <b>{who}</b> : <><b>{where}</b><span>{who}</span>{t && <span class="hq-t">{title(t)}</span>}</>}
      </span>
      {time}
      <Ask q={q} size="home" who={who} class="hq-a" terminal={q.reply_via === 'terminal' && s ? () => focusSession(s.id) : undefined} />
    </article>
  );
}

/** One thought, as an object that keeps its shape at every width: its agent's seat in the state it is in, the thought
 *  in the person's words, and the time; under that where it is, who works on it and the one fact. The row opens its
 *  terminal. */
function Row({ t, kind, bg }: { t: Thought; kind: 'run' | 'res'; bg?: boolean }) {
  const s = t.session_id ? records.sessions.get(t.session_id) : undefined;
  const r = resultOf(t);
  const fact = kind === 'run' ? (s?.activity.at(-1) ?? 'Starting') : t.status === 'failed' ? `${why(t)}${r?.summary ? `: ${r.summary}` : ''}` : unheard(t) ? endedSays(t) : r?.summary;
  const changes = pending(t) ? t : null;
  const go = () => {
    if (t.session_id && focusSession(t.session_id) && (t.status === 'done' || t.status === 'failed') && !t.read)
      void call('thought.read', { id: t.id }).catch(fail);
  };
  const acts = changes ? (
    <div class="hr-a">
      <ChangeActs t={changes} />
    </div>
  ) : kind === 'res' && t.status === 'failed' && !t.read ? (
    <div class="hr-a">
      {t.session_id && <button type="button" class="btn" onClick={go}>Open terminal</button>}
      <button type="button" class="btn" onClick={() => void call('thought.retry', { id: t.id }).catch(fail)}>Try again</button>
    </div>
  ) : null;
  const k = kind === 'run' ? 'working' : stateOf(t);
  const agent = s?.agent ?? t.agent, who = agentName(agent ?? undefined);
  return (
    <div class={`hr ${kind}${bg ? ' bgd' : ''}${kind === 'res' && t.read && !changes ? ' seen' : ''}`} data-nav tabIndex={0} data-thought={t.id}
      title={[t.text, fact, placed(t, agentName)].filter(Boolean).join('\n')}
      onClick={(e) => !(e.target as HTMLElement).closest('.hr-a') && go()}
      onContextMenu={(e) => t.session_id && popup(e, [{ text: 'Open Terminal', do: go }, { text: 'Session Details…', do: () => void details(t.session_id ?? undefined) }])}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement) !== e.currentTarget || e.metaKey || e.ctrlKey) return;
        const key = e.key.toLowerCase();
        if (key === 'enter') go();
        else if (key === 'i') details(t.session_id ?? undefined);
        else if (changes && key === 'k') main(changes);
        else if (changes && key === 'd') open({ kind: 'settle', thought: t.id, keep: false });
        else if (changes && key === 'r') open({ kind: 'review', thought: t.id });
        else return;
        e.preventDefault();
      }}>
      <Seat agent={agent} s={k} bg={bg} size={20} label={`${who}: ${said(k, bg)}`} />
      <span class="hr-t">{title(t)}</span>
      <time>{kind === 'run' ? elapsed(t.created) : when(t.updated)}</time>
      <Meta where={projectName(t.project_id)} who={who} fact={fact} />
      {kind === 'res' && t.workdir && <span class="hr-d"><Status t={{ ...t, workdir: t.workdir }} /></span>}
      {changes && <Told t={changes} />}
      {t.route?.fallback && <p class="hr-n">{placed(t, agentName)}</p>}
      {acts}
    </div>
  );
}

type Changed = Thought & { workdir: NonNullable<Thought['workdir']> };
/** The main action on changes that wait (changes.tsx `next`): a session still running is asked about first, and so is any discard. */
const main = (t: Changed) => (next(t).keep && !running(t) ? void settle(t, true) : open({ kind: 'settle', thought: t.id, keep: next(t).keep }));

/** Keep, Discard and Review changes, for a result whose changes wait. */
export function ChangeActs({ t }: { t: Changed }) {
  return (
    <>
      <button type="button" class="key" onClick={() => main(t)}>{next(t).label}</button>
      {next(t).keep && <button type="button" class="btn" onClick={() => open({ kind: 'settle', thought: t.id, keep: false })}>Discard</button>}
      {next(t).keep && <button type="button" class="btn" onClick={() => open({ kind: 'review', thought: t.id })}>Review changes</button>}
    </>
  );
}

/** A thought saved for later: why it waits, and the way on. The one just saved shows its actions without being asked. */
function LaterRow({ t }: { t: Thought }) {
  const send = () => open({ kind: 'send', thought: t.id });
  return (
    <div class={`hr later${t.id === cap.sent?.id ? ' new' : ''}`} data-nav tabIndex={0} title={[t.text, t.route?.fallback].filter(Boolean).join('\n')} onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && (e.preventDefault(), send())}>
      <Mark s="later" />
      <span class="hr-t">{title(t)}</span>
      <time>{when(t.created)}</time>
      <Meta fact={laterWhy(t, agentName)} />
      <div class="hr-a">
        <button type="button" class="btn" onClick={send}>Send to a folder…</button>
        <button type="button" class="btn" onClick={() => void call('delete', { c: 'thoughts', id: t.id }).catch(fail)}>Drop</button>
      </div>
      {t.route?.fallback && <p class="hr-n">{t.route.fallback}</p>}
    </div>
  );
}

/** "1 new 1 failed", or how many there are. */
function Counts({ rows }: { rows: Thought[] }) {
  const fresh = rows.filter((t) => !t.read);
  const failed = fresh.filter((t) => t.status === 'failed').length;
  // What an agent of the plain tier ran has ended and is no result: counted apart, in that word.
  const ended = fresh.filter(unheard).length;
  const news = fresh.length - failed - ended;
  return (
    <span class="fold-c">
      {news > 0 && <i class="n">{news} new</i>}
      {ended > 0 && <i class="n">{ended} ended</i>}
      {failed > 0 && <i class="f">{failed} failed</i>}
      {!fresh.length && <i>{rows.length}</i>}
    </span>
  );
}

function Fold({ name, open: isOpen, rows, toggle, children }: { name: string; open: boolean; rows: Thought[]; toggle: () => void; children: ComponentChildren }) {
  const top = rows[0];
  return (
    <div class={`fold${isOpen ? ' open' : ''}`}>
      <button type="button" class="fold-h" data-nav aria-expanded={isOpen} onClick={toggle}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowRight' && !isOpen) || (e.key === 'ArrowLeft' && isOpen)) (e.preventDefault(), toggle());
        }}>
        <I n="chev" /><b>{name}</b>{name === 'Results' ? <Counts rows={rows} /> : <span class="fold-c"><i>{rows.length}</i></span>}
        <span class="fold-p">{top ? title(top) : ''}</span><time>{top ? when(top.updated) : ''}</time>
      </button>
      {isOpen && <div class="fold-b">{children}</div>}
    </div>
  );
}

/** Keeps the minutes of what runs current, once a minute, while something runs and the window is seen. */
function useMinutes(on: boolean) {
  useEffect(() => {
    if (!on) return undefined;
    const timer = setInterval(() => !document.hidden && redraw(), 30000);
    return () => clearInterval(timer);
  }, [on]);
}

/** ↓ and ↑ move through the capture line, the questions, the rows and the fold lines; Escape steps out one level. */
function nav(e: KeyboardEvent) {
  const typing = (e.target as HTMLElement).matches('input, textarea');
  if (e.key === 'Escape') {
    if (ui.fold) (ui.fold = ''), redraw();
    page.focus = '#capture-input';
    redraw();
    return e.preventDefault();
  }
  if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.metaKey || (typing && (e.target as HTMLElement).id !== 'capture-input')) return;
  // A thought of several lines keeps ↑ and ↓ for its own lines until the caret is at its start or end.
  const field = e.target as HTMLTextAreaElement;
  if (field.id === 'capture-input' && field.clientHeight > 44 && field.selectionStart !== (e.key === 'ArrowDown' ? field.value.length : 0)) return;
  const items = [...document.querySelectorAll<HTMLElement>('.hx #capture-input, .hx [data-question], .hx [data-nav]')];
  const at = items.findIndex((x) => x === document.activeElement || x.contains(document.activeElement));
  const next = items[Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
  if (next) (e.preventDefault(), next.focus({ focusVisible: true }));
}

export function Home() {
  const h = home();
  const [openQ, setOpenQ] = useState('');
  const folders = projects().some((p) => p.kind === 'folder');
  // The first-run composition is for a Home with nothing on it yet: no folder open, and nothing asked, running or done.
  const first = !folders && !h.questions.length && !h.waiting.length && !h.running.length && !h.results.length;
  // The line under the Composer speaks only while it is true: no folder is open and the next thought has nowhere to
  // start. A thought that runs in Scratch has a place, and so has the next one.
  const nowhere = !folders && where().by === 'later';
  const asks = h.questions.length > 0;
  const idle = !asks && !h.running.length;
  const shownQ = h.questions.find((q) => q.id === openQ) ?? h.questions[0];
  const fold = ui.fold;
  const wide = useWide();
  useMinutes(h.running.length > 0);
  // Two columns where the window is wide and both have something: what is now at the left, Results and Ideas at the
  // right, open, since there is room. Otherwise one column, Results and Ideas as lines under what is now.
  const now = asks || h.waiting.length > 0 || h.running.length > 0 || first;
  const more_ = (h.results.length > 0 || h.later.length > 0) && !first;
  const two = wide && now && more_;
  // Quiet: Results opens itself to its last two, so the proof of work and the way to the rest are one object.
  const resultsOpen = fold === 'results' || ((idle || two) && fold !== 'shut' && fold !== 'later') || (two && fold === 'later');
  // A thought just saved for later opens the line it landed in.
  const laterOpen = fold === 'later' || (two && fold !== 'shut-later') || (fold === '' && h.later.some((t) => t.id === cap.sent?.id));
  const results = h.results.slice(0, fold === 'results' || two ? 5 : 2);
  const toggle = (name: 'results' | 'later') => () => {
    ui.fold = name === 'results' ? (resultsOpen ? 'shut' : 'results') : laterOpen ? (two ? 'shut-later' : 'shut') : 'later';
    redraw();
  };
  const more = h.running.length > 4 && !ui.more;
  const light = useLight();
  return (
    <div class="room" style={light.vars}>
    <Light load={asks ? 'asks' : h.running.length ? 'busy' : 'quiet'} />
    <div class={`home${asks ? ' asks' : h.running.length ? ' busy' : ' quiet'}`} id="main" tabIndex={-1}>
      <div class={`hx${two ? ' two' : ''}${first ? ' first' : ''}`} onKeyDown={nav}>
        <Capture raised agents={() => open({ kind: 'settings', at: 'agents' })} speech={() => open({ kind: 'settings', at: 'voice' })} terms={() => open({ kind: 'placing' })}
          // Once a folder is open and an agent signed in, before the first thought: the one moment placing is offered unasked.
          offer={folders && !records.thoughts.size && offerable()} />
        {nowhere && (
          <p class="attach">
            <span>A thought starts in a folder. Until one is open, it is saved for later.</span>
            <button type="button" class={`${cap.draft.trim() ? 'btn' : 'key'} lg`} onClick={() => open({ kind: 'open-workspace' })}><span>Open a folder…</span><Key k="⌘O" /></button>
          </p>
        )}
        <div class="cols">
        <div class="col">
        {asks && (
          <section class="hsec needs">
            <h3><Mark s="asks" label="" /><span>Needs you</span><i>{h.questions.length}</i></h3>
            {shownQ && <QuestionRow key={shownQ.id} q={shownQ} open choose={() => undefined} />}
            <div class="hrs">{h.questions.filter((q) => q !== shownQ).map((q) => <QuestionRow key={q.id} q={q} open={false} choose={() => (setOpenQ(q.id), (page.focus = `[data-question="${q.id}"]`))} />)}</div>
          </section>
        )}
        {h.waiting.length > 0 && (
          <section class="hsec waiting">
            <h3><span>Changes waiting</span><i>{h.waiting.length}</i></h3>
            <div class="hrs">{h.waiting.map((t) => <Row key={t.id} t={t} kind="res" />)}</div>
          </section>
        )}
        {h.running.length > 0 && (
          <section class="hsec run">
            <h3><span>Running</span><i>{h.running.length}</i></h3>
            <div class="hrs">{(more ? h.running.slice(0, 4) : h.running).map((t) => <Row key={t.id} t={t} kind="run" bg={h.inBackground(t)} />)}</div>
            {more && <button type="button" class="more" data-nav onClick={() => ((ui.more = true), redraw())}>{h.running.length - 4} more running<I n="chev" /></button>}
          </section>
        )}
        </div>
        <div class="col">
        {more_ && (
          <section class="folds">
            {h.results.length > 0 && (
              <Fold name="Results" open={resultsOpen} rows={h.results} toggle={toggle('results')}>
                <div class="hrs">{results.map((t) => <Row key={t.id} t={t} kind="res" />)}</div>
                <button type="button" class="more" data-nav onClick={() => show('earlier')}>All results<I n="chev" /></button>
              </Fold>
            )}
            {h.later.length > 0 && (
              <Fold name="For later" open={laterOpen} rows={h.later} toggle={toggle('later')}>
                <div class="hrs">{h.later.slice(0, 5).map((t) => <LaterRow key={t.id} t={t} />)}</div>
              </Fold>
            )}
          </section>
        )}
        {first && h.later.length > 0 && (
          <section class="hsec">
            <h3><span>For later</span><i>{h.later.length}</i></h3>
            <div class="hrs">{h.later.map((t) => <LaterRow key={t.id} t={t} />)}</div>
          </section>
        )}
        </div>
        </div>
      </div>
    </div>
    </div>
  );
}

/** Whether Home is wide enough for two columns of rows that keep all their parts. While the sidebar slides it is the
 *  width Home will have when the slide is over that counts (the window's, less the sidebar where it stays), from
 *  the slide's first frame: the columns change before anything moves, and nothing reflows on the way. */
const WIDE = 1480;
function useWide() {
  const [wide, setWide] = useState(false);
  const side = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--side-w')) || 0;
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>('.room');
    if (!el) return undefined;
    const watch = new ResizeObserver(([e]) => setWide((e?.contentRect.width ?? 0) >= WIDE));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return ui.slide ? innerWidth - (ui.slide === 'in' ? side() : 0) >= WIDE : wide;
}

// ——— Earlier: every result by day, with ideas and a find field ———

// What left the live set is read from the core's history a page at a time (past.ts).
const earlier = { query: '' };

function day(ms: number) {
  const d = new Date(ms), now = new Date();
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 864e5);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? d.toLocaleDateString([], { weekday: 'long' }) : d.toLocaleDateString([], { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function Earlier() {
  const h = home();
  const words = earlier.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const match = (t: Thought) => words.every((w) => `${t.text} ${projectName(t.project_id)} ${resultOf(t)?.summary ?? ''}`.toLocaleLowerCase().includes(w));
  const seen = new Set<string>();
  const pages = past.thoughts.filter((t) => t.mode !== 'note');
  const rows = [...h.waiting, ...h.results, ...pages].filter((t) => !seen.has(t.id) && (seen.add(t.id), true) && match(t)).sort((a, b) => b.updated - a.updated);
  const later = h.later.filter(match);
  const groups = new Map<string, Thought[]>();
  for (const t of rows) {
    const k = day(t.updated);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  useLayoutEffect(() => void (page.focus = '#find-thought'), []);
  return (
    <div class="room">
    <Light load="paged" />
    <div class="home paged" id="main" tabIndex={-1}>
      <div class="hx" onKeyDown={(e) => {
        if (e.key === 'Escape') (e.preventDefault(), show('home'));
        else nav(e);
      }}>
        <label class="find"><I n="search" />
          <input id="find-thought" type="search" placeholder="Find a thought" aria-label="Find a thought" autocomplete="off" spellcheck={false}
            value={earlier.query} onInput={(e) => ((earlier.query = e.currentTarget.value), redraw())} />
        </label>
        {later.length > 0 && (
          <section class="hsec">
            <h3><span>For later</span><i>{later.length}</i></h3>
            <div class="hrs">{later.map((t) => <LaterRow key={t.id} t={t} />)}</div>
          </section>
        )}
        {[...groups].map(([name, ts]) => (
          <section class="hsec">
            <h3><span>{name}</span><i>{ts.length}</i></h3>
            <div class="hrs">{ts.map((t) => <Row key={t.id} t={t} kind="res" />)}</div>
          </section>
        ))}
        {!rows.length && !later.length && words.length > 0 && <p class="none">Nothing matches “{earlier.query.trim()}”.</p>}
        {past.more && h.results.length + pages.length >= 200 && (
          <button type="button" class="more" data-nav onClick={() => void older()}>{past.loading ? 'Reading…' : 'Earlier results'}<I n="chev" /></button>
        )}
      </div>
    </div>
    </div>
  );
}

export const homeCounts = () => {
  const h = home();
  const fresh = h.results.filter((t) => !t.read);
  return { needs: h.questions.length, working: h.running.length, fresh: fresh.length + h.waiting.length, waiting: h.waiting.length, ended: fresh.filter(unheard).length };
};