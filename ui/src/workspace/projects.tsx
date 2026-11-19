// What Tasktap knows of the person's projects (docs/projects-design.md, and the owner's decisions of 2026-11-19 at its
// end), in the two places a person sees it. At the first run, under the Composer: where it may learn of them, asked
// once in one honest sentence, the folders its agents worked in first; then, once, what it found, as the sign that
// looking worked. In Settings › Projects: where it learns of them, every project it knows, and what it knows of each,
// to see and to correct. The app does the housekeeping; neither place is a list the person has to keep.
//
// Everything shown is the core's: where it looks (`records.looks`), what it knows of each folder (`records.cards`), and
// what could be looked at, found by `stat` alone with nothing inside read (`projects.offer`). The page keeps only what
// the person did here a moment ago.
import type { AddLook, Card, Look, Offer } from '../../../core/proto/protocol.ts';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { cap } from '../capture.tsx';
import { uuid7 } from '../client.ts';
import { HERE, shownPath } from '../system.ts';
import { I, Key, Mark, Ring, ago, plural } from '../ui.tsx';
import { Switch } from './form.tsx';
import { agentName, call, fail, open, records, redraw } from './model.ts';

// ——— Words ———

/** "Claude Code", "Claude Code and Codex", "Claude Code, Codex and Cursor". */
const and = (names: string[]) => (names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** When work happened, as a person says it: today, yesterday, 3 days ago, 2 weeks ago, in March. */
export function since(ms: number, now = Date.now()) {
  const day = (t: number) => new Date(new Date(t).toDateString()).getTime();
  const days = Math.round((day(now) - day(ms)) / 864e5);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  const d = new Date(ms);
  return `in ${d.toLocaleDateString('en', { month: 'long', ...(d.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }) })}`;
}

/** Which agents worked in a folder, and when: "Claude Code worked here 2 days ago". */
const worked = (c: Card, where = 'here') => `${and(c.agents.map((a) => agentName(a)))} worked ${where}${c.used ? ` ${since(c.used)}` : ''}`;
/** The file a line is from, as a person names it: README, package.json. */
const file = (name: string | null) => (name ?? '').replace(/\.(md|markdown|rst|txt)$/i, '');

/** Why Tasktap takes a folder for a project, strongest first, in plain words. */
function reasons(c: Card): string[] {
  return c.why.map((e) => ({
    agent: c.agents.length ? worked(c) : 'An agent worked here', opened: 'Opened in Tasktap', git: 'The top of a Git repository',
    package: /package|cargo|pyproject|go\.mod|gemfile|pom|gradle|composer|pubspec|deno|mix/i.test(c.about_from ?? '') ? `Its ${c.about_from}` : 'A package file',
    signs: 'Notes for agents in it',
  })[e]);
}
/** The one reason a row on Home gives: an agent's work, else what it says it is, else the strongest sign. */
const reason = (c: Card) => (c.why.includes('agent') && c.agents.length ? worked(c) : c.about ? `${file(c.about_from) || 'It says'}: ${c.about}` : (reasons(c)[0] ?? ''));

/** What Tasktap reads, said before it reads it: of an agent's history, and of a folder. */
const READS_AGENTS = (names: string[]) =>
  `Tasktap reads which folders ${and(names) || 'your agents'} ${names.length === 1 ? 'was' : 'were'} started in, and when; never what was said there. It keeps that on ${HERE} and sends none of it anywhere.`;
const READS_FOLDERS = `Tasktap reads the names of the folders in there and, of each project, its name, the first lines of its README and of its package file, and when it last changed. It keeps that on ${HERE} and sends none of it anywhere. It opens nothing until a thought goes there.`;

// ——— What Tasktap knows ———

/** The projects: a card that is no copy of another, no folder inside one and not set aside by the person. The most
 *  recently worked on first. */
export function known(): Card[] {
  return [...records.cards.values()].filter((c) => !c.copy_of && !c.inside && !c.hidden).sort(recent);
}
const recent = (a: Card, b: Card) => (b.used ?? 0) - (a.used ?? 0) || a.name.localeCompare(b.name);
const looks = () => [...records.looks.values()];
/** An agent's history or a folder, being read now. */
const reading = (l: Look) => l.on && l.state === 'new';

/** What can be looked at, as the core found it by `stat`: asked when a part that offers it is drawn, and again whenever
 *  a look has read, since what is worth offering follows what was found. Undefined until the first answer. */
const offered = { now: undefined as Offer | undefined, at: '', for: '', failed: false };
/** The looks as they stand: when one has read, what is worth offering may have changed. */
const stand = () => looks().map((l) => `${l.id}:${l.on}:${l.state}:${l.found}`).join();
function useOffer(): Offer | undefined {
  const now = stand();
  useEffect(() => {
    if (offered.at === now && offered.now) return;
    offered.at = now;
    // A core that cannot say leaves the first run as it was before: nothing is asked.
    const said = (o: Offer, failed = false) => ((offered.now = o), (offered.for = now), (offered.failed = failed), redraw());
    void call('projects.offer', {}).then((o) => said(o), () => said({ agents: [], places: [] }, true));
  }, [now]);
  return offered.now;
}
/** Something is still to come: a look is asked for or reads, or what is offered after it is not answered yet. */
const settling = () => begun.asking > 0 || looks().some(reading) || offered.for !== stand();
/** The agents whose history is offered and was never asked about: no look names them, on or off. */
const unasked = (o: Offer) => o.agents.filter((a) => !looks().some((l) => l.kind === 'agent' && l.agent === a.agent));
/** A folder that holds several projects Tasktap found and was not looked in: a place the person keeps them. */
const derived = (o: Offer | undefined) => o?.places.find((p) => p.projects >= 2);

/** Adds looks; until the core has them, the first run counts them as reading. */
const add = (asked: AddLook[]) => {
  begun.asking += asked.length;
  return Promise.all(asked.map((l) => call('look.add', l).finally(() => (begun.asking--, redraw())))).catch(fail);
};
const lookAgents = (agents: string[], on: boolean) => add(agents.map((agent) => ({ id: uuid7(), agent, on })));
const lookIn = (folders: string[], on = true) => add(folders.map((folder) => ({ id: uuid7(), folder, on })));

// ——— The first run ———

/** What the person did at the first run, in this page's life: looked from here (what was found shows until they close
 *  it or send a thought), or closed it; the folders ticked and added. Not kept: the list answers that moment, and what
 *  they said to Tasktap is in the looks. */
const begun = { looked: false, closed: false, asking: 0, ticked: null as Set<string> | null, added: [] as string[], enter: null as (() => void) | null };

type Step = 'wait' | 'agents' | 'folders' | 'found' | null;
/** Which part of the first run is due. The question about the agents' history first, asked once; for a person with
 *  none, where their projects are; after either, what was found, once. Nothing once a thought was sent. */
function step(o: Offer | undefined): Step {
  if (records.thoughts.size || begun.closed || offered.failed) return null;
  if (begun.looked) return 'found';
  if (!o) return 'wait';
  if (unasked(o).length) return 'agents';
  if (!o.agents.length && !looks().length) return 'folders';
  return null;
}

/** Return in the empty Composer, while the first run asks something: its answer. A thought in the field is sent instead. */
export function beginKey(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false;
  if ((e.target as HTMLElement).id !== 'capture-input' || cap.draft.trim() || !begun.enter) return false;
  e.preventDefault();
  begun.enter();
  return true;
}

/** How many rows of what was found fit under the Composer without Home scrolling, measured as it stands: at most
 *  eight, at least three; the rest are in Settings. While more may come in under the rows (the line to the rest, the
 *  folder most are in), its room is kept, so no row goes again once it is shown. */
function useRoom(coming: boolean) {
  const [room, setRoom] = useState(8);
  useLayoutEffect(() => {
    const home = document.querySelector<HTMLElement>('.room > .home'), el = home?.querySelector<HTMLElement>('.found');
    if (!home || !el) return;
    const rows = el.querySelectorAll('.fr'), row = rows[0]?.getBoundingClientRect().height || 29;
    const foot = parseFloat(getComputedStyle(el.parentElement ?? el).paddingBottom) || 0;
    const top = el.getBoundingClientRect().top - home.getBoundingClientRect().top + home.scrollTop;
    const rest = el.getBoundingClientRect().height - rows.length * row + (coming && !el.querySelector('.more') ? 32 : 0) + (coming && !el.querySelector('.found-s') ? 44 : 0);
    const fits = Math.max(3, Math.min(8, Math.floor((home.clientHeight - foot - top - rest) / row)));
    if (fits !== room) setRoom(fits);
  });
  return room;
}

/** The first run, under the Composer and on its edges. `quiet`: the Composer holds a thought, so its key is the one
 *  that is metal and Return sends that. `children`: what Home says there otherwise. */
export function Begin({ quiet, children }: { quiet: boolean; children?: ComponentChildren }) {
  const o = useOffer();
  const at = step(o);
  // A short window shows fewer rows; the count follows it.
  useEffect(() => {
    addEventListener('resize', redraw);
    return () => removeEventListener('resize', redraw);
  }, []);
  begun.enter = null;
  if (at === 'wait') return null;
  if (!at || !o) return <>{children}</>;
  const other = <button type="button" class="btn lg" onClick={() => open({ kind: 'open-workspace' })}><span>Open another folder…</span><Key k="⌘O" /></button>;
  const answer = (label: string, act: () => void, can = true) => {
    if (!quiet && can) begun.enter = act;
    return quiet ? <button type="button" class="btn lg" disabled={!can} onClick={act}>{label}</button>
      : <button type="button" class="key lg" disabled={!can} onClick={act}><I n="ret" /><span>{label}</span></button>;
  };
  if (at === 'agents') {
    const asks = unasked(o);
    const allow = () => ((begun.looked = true), void lookAgents(asks.map((a) => a.agent), true), redraw());
    const later = () => void lookAgents(asks.map((a) => a.agent), false);
    return (
      <section class="begin" aria-labelledby="begin-h">
        <h3 id="begin-h">Where your agents have worked</h3>
        <p>{READS_AGENTS(asks.map((a) => a.name))}</p>
        <div class="begin-f">{other}<button type="button" class="btn lg" onClick={later}>Not now</button>{answer('Allow', allow)}</div>
      </section>
    );
  }
  if (at === 'folders') {
    const places = [...o.places.map((p) => p.folder), ...begun.added];
    const ticked = (begun.ticked ??= new Set(o.places.map((p) => p.folder)));
    const tick = (f: string) => (ticked.has(f) ? ticked.delete(f) : ticked.add(f), redraw());
    const another = async () => {
      const f = await call('host.pick', { folder: true }).catch(fail);
      if (f && !places.includes(f)) begun.added.push(f);
      if (f) ticked.add(f);
      redraw();
    };
    const chosen = places.filter((f) => ticked.has(f));
    const look = () => ((begun.looked = true), void lookIn(chosen), redraw());
    // Not now is an answer: each folder offered is kept as one not looked in, so it is not offered here again.
    const later = () => ((begun.closed = true), void lookIn(o.places.map((p) => p.folder), false), redraw());
    return (
      <section class="begin" aria-labelledby="begin-h">
        <h3 id="begin-h">Where are your projects?</h3>
        <div class="ticks" role="group" aria-labelledby="begin-h">
          {places.map((f) => <button type="button" class="tick" role="checkbox" aria-checked={ticked.has(f)} onClick={() => tick(f)}><i /><span>{shownPath(f)}</span></button>)}
          <button type="button" class="tick add" onClick={() => void another()}><I n="plus" /><span>Another folder…</span></button>
        </div>
        <p>{READS_FOLDERS}</p>
        <div class="begin-f">{other}<button type="button" class="btn lg" onClick={later}>Not now</button>{answer('Look there', look, chosen.length > 0)}</div>
      </section>
    );
  }
  return <Found o={o} other={other} />;
}

/** What was found, filling in as the looks read: the most recently worked on first, each with its folder and why;
 *  the rest in Settings. Under it, where most of them are, if Tasktap has not looked there. */
function Found({ o, other }: { o: Offer; other: ComponentChildren }) {
  const all = known(), coming = settling(), busy = begun.asking > 0 || looks().some(reading);
  const place = derived(o), most = place && place.projects * 2 >= all.length;
  const shown = all.slice(0, useRoom(coming));
  const close = () => ((begun.closed = true), (begun.looked = false), redraw());
  return (
    <section class="hsec found" aria-labelledby="begin-h" aria-busy={busy}>
      <h3 id="begin-h">{busy && <Mark s="working" label="Looking" />}<span>{busy && !all.length ? 'Looking…' : all.length ? `Found ${plural(all.length, 'project', 'projects')}` : 'Found no projects'}</span></h3>
      {shown.length > 0 && (
        <div class="fr-s">
          {shown.map((c) => (
            <div class="fr" key={c.id} title={[c.name, shownPath(c.folder), c.about].filter(Boolean).join('\n')}>
              <I n="folder" /><span class="fr-n">{c.name}</span><span class="fr-f">{shownPath(c.folder)}</span><span class="fr-w">{reason(c)}</span>
            </div>
          ))}
        </div>
      )}
      {all.length > shown.length && (
        <button type="button" class="more" onClick={() => open({ kind: 'settings', at: 'projects' })}>and {all.length - shown.length} more, in Settings › Projects<I n="chev" /></button>
      )}
      {!busy && !all.length && <p class="found-n">A folder counts when an agent worked there, or when it has Git or a package file in it.</p>}
      {place && !coming && (
        <p class="found-s">
          <span>{most ? 'Most are' : `${place.projects} are`} in <b>{shownPath(place.folder)}</b>. Look there for the others too?</span>
          <button type="button" class="btn" onClick={() => void lookIn([place.folder])}>Look there</button>
        </p>
      )}
      <div class="begin-f">
        {all.length > 0 && <span class="found-o">None is open yet. A thought that names one opens it.</span>}
        {other}<button type="button" class="btn lg" onClick={close}>Close</button>
      </div>
    </section>
  );
}

// ——— Settings › Projects ———

/** Where Tasktap learns of projects, then every project it knows, then what the person said is none. */
export function ProjectsPane() {
  const o = useOffer();
  const [query, setQuery] = useState('');
  const [shown, show] = useState<string | null>(null);
  const [aside, setAside] = useState(false);
  const [again, setAgain] = useState<'' | 'looking' | string>('');
  const all = looks(), cards = [...records.cards.values()];
  // Every agent whose history is here, and any Tasktap was told about before.
  const agentIds = [...new Set([...(o?.agents.map((a) => a.agent) ?? []), ...all.filter((l) => l.kind === 'agent' && l.agent).map((l) => l.agent!)])];
  const nameOf = (id: string) => o?.agents.find((a) => a.agent === id)?.name ?? agentName(id);
  const folders = all.filter((l) => l.kind === 'folder' && l.on);
  // Suggested: where several projects are and Tasktap does not look, the usual folders that are there, and those the
  // person said Not now to.
  const suggested = [...(o?.places ?? []).map((p) => ({ folder: p.folder, projects: p.projects, look: undefined as Look | undefined })),
    ...all.filter((l) => l.kind === 'folder' && !l.on && l.folder).map((l) => ({ folder: l.folder!, projects: 0, look: l as Look | undefined }))];
  const projects = known();
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const match = (c: Card) => words.every((w) => [c.name, ...c.names, c.folder.split(/[\\/]/).pop() ?? ''].some((n) => n.toLocaleLowerCase().includes(w)));
  const found = projects.filter(match), list = found.slice(0, words.length ? 50 : 100);
  const hidden = cards.filter((c) => c.hidden).sort(recent);
  const lookAgain = () => {
    setAgain('looking');
    call('projects.look', {}).then((r) => setAgain(`Tasktap knows ${plural(r.projects, 'project', 'projects')} now. Looking took ${r.ms < 1000 ? `${Math.max(1, Math.round(r.ms))} ms` : `${(r.ms / 1000).toFixed(1)} s`}.`),
      (e: unknown) => (setAgain(''), fail(e)));
  };
  const lastLooked = Math.max(0, ...all.filter((l) => l.on).map((l) => l.looked ?? 0));
  const addFolder = async () => {
    const f = await call('host.pick', { folder: true }).catch(fail);
    if (f) await lookIn([f]);
  };
  return (
    <>
      <h3>Where your agents have worked</h3>
      <div class="list">
        {agentIds.map((id) => <AgentLook key={id} agent={id} name={nameOf(id)} look={all.find((l) => l.kind === 'agent' && l.agent === id)} />)}
        {!agentIds.length && <p class="line-n solo">No agent's history is on {HERE}.</p>}
      </div>
      {agentIds.length > 0 && <p class="note">{READS_AGENTS(agentIds.map(nameOf))}</p>}
      <h3>Folders Tasktap looks in</h3>
      <div class="list lk">
        {folders.map((l) => <FolderLook key={l.id} look={l} cards={cards} />)}
        {suggested.map((s) => (
          <div class="line pl sug" key={s.folder}>
            <I n="folder" />
            <span class="t path">{shownPath(s.folder)}</span>
            <span class="x">{s.projects >= 2 ? `${s.projects} of your projects are in it` : 'Not looked in'}</span>
            <span class="acts"><button type="button" class="btn" onClick={() => void (s.look ? call('put', { c: 'looks', id: s.look.id, patch: { on: true } }).catch(fail) : lookIn([s.folder]))}>Look there</button></span>
          </div>
        ))}
        <button type="button" class="line fold-l" onClick={() => void addFolder()}><I n="plus" /><span class="t">Add a folder…</span><span class="x">Where you keep projects</span></button>
      </div>
      <p class="note">{READS_FOLDERS}</p>
      <div class="list">
        <div class="line pl">
          <span />
          <span class="t">Looked</span>
          <span class="x">{lastLooked ? ago(lastLooked) : 'Not yet'}</span>
          <span class="acts"><button type="button" class="btn" disabled={again === 'looking' || !all.some((l) => l.on)} onClick={lookAgain}>{again === 'looking' ? 'Looking…' : 'Look again'}</button></span>
        </div>
        {again && again !== 'looking' && <p class="line-n" role="status">{again}</p>}
      </div>
      <h3>{projects.length ? plural(projects.length, 'project', 'projects') : 'Projects'}</h3>
      {projects.length > 0 && (
        <label class="field"><I n="search" />
          <input type="search" placeholder="Find a project" aria-label="Find a project" autocomplete="off" spellcheck={false} value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
        </label>
      )}
      <div class="list pjs">
        {list.map((c) => <ProjectRow key={c.id} c={c} open={shown === c.id} toggle={() => show(shown === c.id ? null : c.id)} cards={cards} />)}
      </div>
      {!projects.length && <p class="note">None yet. Tasktap learns of them where your agents have worked and in the folders it looks in.</p>}
      {projects.length > 0 && !found.length && <p class="note">No project is called “{query.trim()}”.</p>}
      {found.length > list.length && <p class="note">And {found.length - list.length} more. Type to find one.</p>}
      {hidden.length > 0 && (
        <div class="list">
          <button type="button" class="line fold-l" aria-expanded={aside} onClick={() => setAside(!aside)}>
            <I n="chev" /><span class="t">Not projects ({hidden.length})</span><span class="x">You said these are none</span>
          </button>
          {aside && hidden.map((c) => (
            <div class="line pl" key={c.id} data-s="none">
              <I n="folder" /><span class="t">{c.name}</span><span class="x mono">{shownPath(c.folder)}</span>
              <span class="acts"><button type="button" class="btn" onClick={() => void call('put', { c: 'cards', id: c.id, patch: { hidden: false } }).catch(fail)}>It is a project</button></span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** An agent's history: whether Tasktap reads it, and what it found. Switched on, it is read at once. */
function AgentLook({ agent, name, look }: { agent: string; name: string; look: Look | undefined }) {
  const on = !!look?.on;
  const set = (to: boolean) => void (look ? call('put', { c: 'looks', id: look.id, patch: { on: to } }) : call('look.add', { id: uuid7(), agent, on: to })).catch(fail);
  const says = !look || !on ? 'Off' : reading(look) ? 'Looking…' : look.state === 'gone' ? `Not on ${HERE} now`
    : look.state === 'failed' ? (look.note ?? 'Could not be read') : `${plural(look.found, 'project', 'projects')}${look.looked ? ` · looked ${ago(look.looked)}` : ''}`;
  return (
    <div class="line pl" data-s={on ? undefined : 'none'} data-agent={agent}>
      <Ring agent={agent} s="" />
      <span class="t">{name}</span>
      <span class="x" title={says}>{says}</span>
      <span class="acts"><Switch on={on} name={`Where ${name} has worked`} set={set} /></span>
    </div>
  );
}

/** A folder Tasktap looks in: what it found and when, or why it found nothing; and the way to stop looking there,
 *  which says first what goes with it. */
function FolderLook({ look, cards }: { look: Look; cards: Card[] }) {
  const [asks, ask] = useState(false);
  const kept = cards.filter((c) => c.looks.includes(look.id));
  // What goes with it: what only this folder found, unless it is open or the person chose it.
  const goes = kept.filter((c) => c.looks.length === 1 && !c.project_id && !c.main && !c.hidden).length;
  const state = reading(look) ? 'Looking…' : look.state === 'gone' ? 'Not there now' : look.state === 'many' ? 'Too many folders in it'
    : look.state === 'failed' ? 'Could not be read' : look.found ? `${plural(look.found, 'project', 'projects')}${look.looked ? ` · looked ${ago(look.looked)}` : ''}` : 'No project in it';
  // The row says what happened in a few words; the line under it says the rest.
  const note = look.state === 'gone' ? `${kept.length ? `Its ${plural(kept.length, 'project is', 'projects are')}` : 'What it held is'} kept for when it is back.`
    : look.state === 'many' ? 'More than 2,000 folders in it: too many to be a folder of projects. Name the folder inside it that holds them.'
      : look.state === 'failed' ? (look.note ?? 'Tasktap could not read it.')
        : look.state === 'ready' && !look.found ? 'A folder counts when it has Git or a package file in it.' : '';
  return (
    <>
      <div class="line pl" data-s={look.state === 'gone' || look.state === 'many' || look.state === 'failed' ? 'off' : undefined}>
        <I n="folder" />
        <span class="t path">{shownPath(look.folder ?? '')}</span>
        <span class="x" title={state}>{state}</span>
        <span class="acts">{!asks && <button type="button" class="btn" onClick={() => ask(true)}>Remove</button>}</span>
      </div>
      {note && !asks && <p class="line-n">{note}</p>}
      {asks && (
        <div class="line-n ask">
          <span>{goes ? `Tasktap stops looking there and forgets the ${plural(goes, 'project', 'projects')} only this folder showed it. Open ones stay.` : 'Tasktap stops looking there. Every project it showed there is known otherwise, and stays.'}</span>
          <button type="button" class="btn" onClick={() => ask(false)}>Cancel</button>
          <button type="button" class="btn warn" onClick={() => void call('delete', { c: 'looks', id: look.id }).catch(fail)}>Remove</button>
        </div>
      )}
    </>
  );
}

/** One project: its name, folder and when it was last worked on; opened, everything Tasktap knows of it, and the two
 *  corrections a person makes: it is no project, or forget it. */
function ProjectRow({ c, open: isOpen, toggle, cards }: { c: Card; open: boolean; toggle: () => void; cards: Card[] }) {
  const copies = cards.filter((x) => x.copy_of === c.id), inside = cards.filter((x) => x.inside === c.id);
  const ws = c.project_id ? records.projects.get(c.project_id) : undefined;
  return (
    <>
      <button type="button" class="line pj" aria-expanded={isOpen} data-s={c.available ? undefined : 'none'} onClick={toggle}>
        <I n="chev" />
        <span class="t">{c.name}</span>
        <span class="x mono" title={shownPath(c.folder)}>{shownPath(c.folder)}</span>
        <time>{c.used ? since(c.used) : ''}</time>
      </button>
      {isOpen && (
        <div class="pj-c">
          <Fact k="Folder"><span class="mono">{shownPath(c.folder)}</span>{!c.available && <span class="dim">Not there now</span>}</Fact>
          <Fact k="Called"><Names c={c} /></Fact>
          <Fact k="About">{c.about ? <><span>{c.about}</span>{c.about_from && <span class="dim">{c.about_from}</span>}</> : <span class="dim">Its README and package file say nothing about it.</span>}</Fact>
          <Fact k="Why Tasktap thinks so"><span>{reasons(c).join(' · ') || 'You opened it'}</span></Fact>
          <Fact k="Last worked on"><span>{c.used ? `${since(c.used)[0]!.toUpperCase()}${since(c.used).slice(1)}, ${new Date(c.used).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}` : 'Not known'}</span></Fact>
          {copies.length > 0 && (
            <Fact k={copies.length === 1 ? 'Another copy' : 'Other copies'}>
              {copies.map((x) => (
                <span class="pj-l" key={x.id}><span class="mono">{shownPath(x.folder)}</span>{x.used && <span class="dim">{since(x.used)}</span>}
                  <button type="button" class="btn" onClick={() => void call('put', { c: 'cards', id: x.id, patch: { main: true } }).catch(fail)}>Use this copy</button></span>
              ))}
            </Fact>
          )}
          {inside.length > 0 && (
            <Fact k="Inside">
              {inside.map((x) => <span class="pj-l" key={x.id}><span class="mono">{shownPath(x.folder)}</span>{x.agents.length > 0 && <span class="dim">{worked(x, 'there')}</span>}</span>)}
            </Fact>
          )}
          <Fact k="Workspace"><span>{ws?.open ? 'Open, in the sidebar' : ws ? 'Closed. A thought that goes there opens it again.' : 'Not open. A thought that goes there opens it.'}</span></Fact>
          <div class="pj-a">
            <button type="button" class="btn" onClick={() => void call('put', { c: 'cards', id: c.id, patch: { hidden: true } }).catch(fail)}>Not a project</button>
            <button type="button" class="btn" onClick={() => void call('delete', { c: 'cards', id: c.id }).catch(fail)}>Forget</button>
            <span class="dim">Forgotten, it comes back if Tasktap finds it again.</span>
          </div>
        </div>
      )}
    </>
  );
}

const Fact = ({ k, children }: { k: string; children: ComponentChildren }) => <div class="pj-k"><span class="k">{k}</span><span class="v">{children}</span></div>;

/** What a project is called: its folder's name, the names it goes by, and a name the person adds, for how they say
 *  it ("queue grid"). A name of theirs goes again with its cross. */
function Names({ c }: { c: Card }) {
  const [adding, setAdding] = useState(false);
  const [said, say] = useState('');
  const put = (names: string[]) => call('put', { c: 'cards', id: c.id, patch: { names } }).then(() => say(''), (e: unknown) => say(e instanceof Error ? e.message : String(e)));
  const add = (name: string) => {
    const n = name.trim().replace(/\s+/g, ' ');
    setAdding(false);
    if (n && n !== c.name && !c.names.includes(n)) void put([...c.names, n]);
  };
  return (
    <>
      <span class="pj-n">{c.name}</span>
      {c.names.map((n) => (
        <span class="pj-n" key={n}>{n}<button type="button" aria-label={`Remove the name ${n}`} title="Remove this name" onClick={() => void put(c.names.filter((x) => x !== n))}><I n="x" /></button></span>
      ))}
      {adding ? (
        <input class="text" autoFocus placeholder="A name, as you say it" aria-label={`Another name for ${c.name}`} maxLength={60} spellcheck={false}
          onKeyDown={(e) => (e.key === 'Enter' ? add(e.currentTarget.value) : e.key === 'Escape' ? (e.stopPropagation(), setAdding(false)) : undefined)}
          onBlur={(e) => add(e.currentTarget.value)} />
      ) : c.names.length < 8 && <button type="button" class="btn" onClick={() => setAdding(true)}>Add a name for it…</button>}
      {said && <span class="hint err" role="alert">{said}</span>}
    </>
  );
}
