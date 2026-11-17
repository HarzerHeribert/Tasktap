// Home, a dashboard in layers ("Folds", design/ui-directions/NOTES.md §2). The first layer is what the person needs to
// see or act on when the window opens: the capture line, what needs them (the first question open, the rest one line
// each), changes waiting to be kept, what is running. Results and Ideas are one line each that opens in place; "All
// results" leads to Earlier. It is never bare (with nothing asking or running, the last two results show) and never a
// flood (four running rows, then a line that opens the rest).
import type { Question, Thought } from '../../../core/proto/protocol.ts';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { Capture } from '../capture.tsx';
import { pending, running, settle, Status } from '../changes.tsx';
import { Ask } from '../question.tsx';
import { Answer, I, Mark, type State, elapsed, plural, when } from '../ui.tsx';
import { Light } from './light.tsx';
import { Agents } from './sheets.tsx';
import {
  agentName, call, fail, focus, focusSession, layout, open, openQuestions, page, projectName, projects, records, redraw, resultOf, show,
  title, ui, why, workspaces,
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
  const runningRows = thoughts.filter((t) => t.status === 'routed' || t.status === 'working')
    .sort((a, b) => Number(inBackground(a)) - Number(inBackground(b)) || b.created - a.created);
  const waiting = thoughts.filter((t) => pending(t)).sort((a, b) => b.updated - a.updated);
  const results = thoughts.filter((t) => (t.status === 'done' || t.status === 'failed') && !pending(t)).sort((a, b) => b.updated - a.updated);
  const ideas = all.filter((t) => t.mode === 'note' && t.phase === 'captured').sort((a, b) => b.created - a.created);
  return { questions, running: runningRows, waiting, results, ideas, inBackground };
}

const stateOf = (t: Thought): State => (t.status === 'failed' ? 'failed' : !t.read ? 'ready' : 'ended');

/** A question: open, in full with its answers; or one line that opens it. */
function QuestionRow({ q, open: isOpen, choose }: { q: Question; open: boolean; choose: () => void }) {
  const t = q.thought_id ? records.thoughts.get(q.thought_id) : undefined;
  const s = q.session_id ? records.sessions.get(q.session_id) : undefined;
  const who = q.source === 'router' ? 'Where should it go?' : agentName(s?.agent ?? t?.agent);
  const meta = (
    <span class="hq-m">
      <b>{projectName(t?.project_id ?? s?.project_id)}</b><span>{who}</span>{t && <span class="hq-t">{title(t)}</span>}
    </span>
  );
  const time = <time>{elapsed(t?.updated ?? Date.now())}</time>;
  if (!isOpen)
    return (
      <button type="button" class="hq" data-nav onClick={choose} title={q.prompt}>
        <Mark s="asks" />{meta}<span class="hq-q">{q.prompt}</span>{time}
      </button>
    );
  return (
    <article class="hq open">
      <span />{meta}{time}
      <Ask q={q} size="home" who={who} class="hq-a" terminal={q.reply_via === 'terminal' && s ? () => focusSession(s.id) : undefined} />
    </article>
  );
}

/** One thought: its mark, folder, words, the one fact, and the time; the row opens its terminal. */
function Row({ t, kind, bg }: { t: Thought; kind: 'run' | 'res'; bg?: boolean }) {
  const s = t.session_id ? records.sessions.get(t.session_id) : undefined;
  const r = resultOf(t);
  const fact = kind === 'run' ? (t.status === 'routed' ? 'Starting soon' : s?.activity.at(-1) ?? 'Starting') : t.status === 'failed' ? `${why(t)}${r?.summary ? `: ${r.summary}` : ''}` : r?.summary;
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
  return (
    <div class={`hr ${kind}${bg ? ' bgd' : ''}${kind === 'res' && t.read && !changes ? ' seen' : ''}`} data-nav tabIndex={0} data-thought={t.id}
      title={[t.text, fact].filter(Boolean).join('\n')}
      onClick={(e) => !(e.target as HTMLElement).closest('.hr-a') && go()}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement) !== e.currentTarget || e.metaKey || e.ctrlKey) return;
        const key = e.key.toLowerCase();
        if (key === 'enter') go();
        else if (changes && key === 'k') keep(changes);
        else if (changes && key === 'd') open({ kind: 'settle', thought: t.id, keep: false });
        else if (changes && key === 'r') open({ kind: 'review', thought: t.id });
        else return;
        e.preventDefault();
      }}>
      <Mark s={k} bg={bg} />
      <span class="hr-w">{projectName(t.project_id)}</span>
      <span class="hr-t">{title(t)}</span>
      <span class="hr-x">{fact}</span>
      {kind === 'res' && <span class="hr-d">{changes ? <Status t={changes} /> : null}</span>}
      <time>{kind === 'run' ? elapsed(t.created) : when(t.updated)}</time>
      {acts}
    </div>
  );
}

const keep = (t: Thought & { workdir: NonNullable<Thought['workdir']> }) =>
  running(t) ? open({ kind: 'settle', thought: t.id, keep: true }) : void settle(t, true);

/** Keep, Discard and Review changes, for a result whose changes wait. */
export function ChangeActs({ t }: { t: Thought & { workdir: NonNullable<Thought['workdir']> } }) {
  return (
    <>
      <button type="button" class="btn primary" onClick={() => keep(t)}>Keep</button>
      <button type="button" class="btn" onClick={() => open({ kind: 'settle', thought: t.id, keep: false })}>Discard</button>
      <button type="button" class="btn" onClick={() => open({ kind: 'review', thought: t.id })}>Review changes</button>
    </>
  );
}

function IdeaRow({ t }: { t: Thought }) {
  const folders = projects().some((p) => p.kind === 'folder');
  const send = () => open({ kind: 'send', thought: t.id });
  return (
    <div class="hr idea" data-nav tabIndex={0} title={t.text} onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && (e.preventDefault(), send())}>
      <Mark s="idea" />
      <span class="hr-t">{title(t)}</span>
      <span class="hr-x">{folders ? 'No folder matched' : 'Kept until a folder is open'}</span>
      <div class="hr-a">
        <button type="button" class="btn" onClick={send}>Send to a folder…</button>
        <button type="button" class="btn" onClick={() => void call('delete', { c: 'thoughts', id: t.id }).catch(fail)}>Drop</button>
      </div>
      <time>{when(t.created)}</time>
    </div>
  );
}

/** "1 new 1 failed", or how many there are. */
function Counts({ rows }: { rows: Thought[] }) {
  const fresh = rows.filter((t) => !t.read);
  const failed = fresh.filter((t) => t.status === 'failed').length;
  const news = fresh.length - failed;
  return (
    <span class="fold-c">
      {news > 0 && <i class="n">{news} new</i>}
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
        <I n="chev" /><b>{name}</b>{name === 'Ideas' ? <span class="fold-c"><i>{rows.length}</i></span> : <Counts rows={rows} />}
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
  const items = [...document.querySelectorAll<HTMLElement>('.hx #capture-input, .hx [data-question], .hx [data-nav]')];
  const at = items.findIndex((x) => x === document.activeElement || x.contains(document.activeElement));
  const next = items[Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
  if (next) (e.preventDefault(), next.focus({ focusVisible: true }));
}

export function Home() {
  const h = home();
  const [openQ, setOpenQ] = useState('');
  const folders = projects().some((p) => p.kind === 'folder');
  const first = !folders;
  const asks = h.questions.length > 0;
  const idle = !asks && !h.running.length;
  const shownQ = h.questions.find((q) => q.id === openQ) ?? h.questions[0];
  const fold = ui.fold;
  useMinutes(h.running.length > 0);
  // Quiet: Results opens itself to its last two, so the proof of work and the way to the rest are one object.
  const resultsOpen = fold === 'results' || (idle && fold === '');
  const results = h.results.slice(0, fold === 'results' ? 5 : 2);
  const toggle = (name: 'results' | 'ideas') => () => {
    ui.fold = name === 'results' ? (resultsOpen ? 'shut' : 'results') : fold === 'ideas' ? '' : 'ideas';
    redraw();
  };
  const more = h.running.length > 4 && !ui.more;
  return (
    <div class="room">
    <Light load={asks ? 'asks' : h.running.length ? 'busy' : 'quiet'} />
    <div class={`home${asks ? ' asks' : h.running.length ? ' busy' : ' quiet'}`} id="main" tabIndex={-1}>
      <div class="hx" onKeyDown={nav}>
        <Capture invite={!asks} hint={!asks && <>or <kbd>⌃⌥Space</kbd> from any app</>} />
        {asks && (
          <section class="hsec needs">
            <h3><Mark s="asks" label="" /><span>Needs you</span><i>{h.questions.length}</i></h3>
            {h.questions.map((q) => <QuestionRow key={q.id} q={q} open={q === shownQ} choose={() => (setOpenQ(q.id), (page.focus = `[data-question="${q.id}"]`))} />)}
          </section>
        )}
        {h.waiting.length > 0 && (
          <section class="hsec waiting">
            <h3><span>Changes waiting</span><i>{h.waiting.length}</i></h3>
            {h.waiting.map((t) => <Row key={t.id} t={t} kind="res" />)}
          </section>
        )}
        {h.running.length > 0 && (
          <section class="hsec run">
            <h3><span>Running</span><i>{h.running.length}</i></h3>
            {(more ? h.running.slice(0, 4) : h.running).map((t) => <Row key={t.id} t={t} kind="run" bg={h.inBackground(t)} />)}
            {more && <button type="button" class="more" data-nav onClick={() => ((ui.more = true), redraw())}>{h.running.length - 4} more running<I n="chev" /></button>}
          </section>
        )}
        {first && (
          <section class="hsec first">
            <h3><span>To start</span></h3>
            <div class="step">
              <Answer k="⌘O" label="Open a folder" primary onClick={() => open({ kind: 'open-workspace' })} />
              <span class="hr-x">It becomes a workspace. A thought goes to the folder it belongs to.</span>
            </div>
            <Agents />
          </section>
        )}
        {(h.results.length > 0 || h.ideas.length > 0) && !first && (
          <section class="folds">
            {h.results.length > 0 && (
              <Fold name="Results" open={resultsOpen} rows={h.results} toggle={toggle('results')}>
                {results.map((t) => <Row key={t.id} t={t} kind="res" />)}
                <button type="button" class="more" data-nav onClick={() => show('earlier')}>All results<I n="chev" /></button>
              </Fold>
            )}
            {h.ideas.length > 0 && (
              <Fold name="Ideas" open={fold === 'ideas'} rows={h.ideas} toggle={toggle('ideas')}>
                {h.ideas.slice(0, 5).map((t) => <IdeaRow key={t.id} t={t} />)}
              </Fold>
            )}
          </section>
        )}
        {first && h.ideas.length > 0 && (
          <section class="hsec">
            <h3><span>Ideas</span><i>{h.ideas.length}</i></h3>
            {h.ideas.map((t) => <IdeaRow key={t.id} t={t} />)}
          </section>
        )}
      </div>
    </div>
    </div>
  );
}

// ——— Earlier: every result by day, with ideas and a find field ———

const earlier = { pages: [] as Thought[], more: true, loading: false, query: '' };
async function older() {
  if (earlier.loading || !earlier.more) return;
  earlier.loading = true;
  redraw();
  try {
    const live = home().results;
    const before = [...live, ...earlier.pages].sort((a, b) => (a.id < b.id ? -1 : 1))[0]?.id ?? null;
    const p = await call('history', { before, limit: 100 });
    earlier.pages.push(...p.thoughts.filter((t) => t.mode !== 'note'));
    for (const r of p.results) records.results.set(r.id, r);
    earlier.more = p.thoughts.length > 0;
  } catch (e) {
    fail(e);
  } finally {
    earlier.loading = false;
    redraw();
  }
}

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
  const rows = [...h.waiting, ...h.results, ...earlier.pages].filter((t) => !seen.has(t.id) && (seen.add(t.id), true) && match(t)).sort((a, b) => b.updated - a.updated);
  const ideas = h.ideas.filter(match);
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
        {ideas.length > 0 && (
          <section class="hsec">
            <h3><span>Ideas</span><i>{ideas.length}</i></h3>
            {ideas.map((t) => <IdeaRow key={t.id} t={t} />)}
          </section>
        )}
        {[...groups].map(([name, ts]) => (
          <section class="hsec">
            <h3><span>{name}</span><i>{ts.length}</i></h3>
            {ts.map((t) => <Row key={t.id} t={t} kind="res" />)}
          </section>
        ))}
        {!rows.length && !ideas.length && words.length > 0 && <p class="none">Nothing matches “{earlier.query.trim()}”.</p>}
        {earlier.more && h.results.length + earlier.pages.length >= 200 && (
          <button type="button" class="more" data-nav onClick={() => void older()}>{earlier.loading ? 'Reading…' : 'Earlier results'}<I n="chev" /></button>
        )}
      </div>
    </div>
    </div>
  );
}

export const homeCounts = () => {
  const h = home();
  return { needs: h.questions.length, working: h.running.length, fresh: h.results.filter((t) => !t.read).length + h.waiting.length, waiting: h.waiting.length };
};
export { plural };
