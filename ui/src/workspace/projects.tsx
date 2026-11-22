// What Tasktap knows of the person's projects (docs/projects-design.md, and the owner's decisions of 2026-11-19 at its
// end), in the two places a person sees it. At the first run, as the welcome's first step (welcome.tsx), whose search is
// `useFirstSearch`: what the core offers first, then the home folder, and what was found filling in. In Settings ›
// Projects: where it learns of them, every project it knows, and what it knows of each, to see and to correct. The app
// does the housekeeping; neither place is a list the person has to keep.
//
// Everything shown is the core's: where it looks (`records.looks`), what it knows of each folder (`records.cards`), and
// what could be looked at, found by `stat` alone with nothing inside read (`projects.offer`). The page keeps only what
// the person did here a moment ago.
import type { AddLook, Card, Isolate, Look, Offer, Project } from '../../../core/proto/protocol.ts';
import { Component, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { uuid7 } from '../client.ts';
import { HERE, mac, plain, shownPath } from '../system.ts';
import { Glyph, I, ago, plural } from '../ui.tsx';
import { Choice, Switch } from './form.tsx';
import { agentName, call, fail, records, redraw } from './model.ts';

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

/** What Tasktap reads, said before it reads it: of an agent's history, and of a folder; and what of it goes anywhere. */
// As the core says what it sends (core/src/route.rs, `SENDS`): of up to 8 projects, the name, the other names and one line.
const MODEL = 'Only if you let a model place your tasks does that model get, of up to 8 likely projects, the name, the other names it goes by and one line about each.';
const READS_AGENTS = (names: string[]) =>
  `Tasktap reads which folders ${and(names) || 'your agents'} ${names.length === 1 ? 'was' : 'were'} started in, and when; never what was said there. Of each folder that is a project it reads the first lines of its README and its package file and its Git remote, and asks Git for its first commit. It keeps all of that on ${HERE}. ${MODEL}`;
/** The same, in one sentence each, for Settings › Projects, with the full sentences behind one quiet line. */
const SAYS_AGENTS = (names: string[]) => `Tasktap reads which folders ${and(names) || 'your agents'} worked in and when, never what was said there, and keeps what it learns on ${HERE}.`;
const SAYS_FOLDERS = `Tasktap reads the names of the folders inside and each project’s README, package file and Git details, and keeps them on ${HERE}.`;
/** As many folders as one search in a folder goes through (core/src/map.rs, `ENTRIES`). */
const BUDGET = 5000;
/** The home folder as either system writes it: /Users/name, /home/name, C:\Users\name. */
const HOME_FOLDER = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)[\\/]?$/;
/** A folder as a person names it: the last part of its path, and the home folder as what it is. */
const folderName = (folder: string) => (HOME_FOLDER.test(plain(folder)) ? 'your home folder' : (shownPath(folder).split(/[\\/]/).filter(Boolean).pop() ?? folder));
/** A search in a folder that found no project, or could not search it: why, in a title and a line, as the core recorded
 *  it. The first run's sheet, Setup's line and Settings › Projects say the same. */
function nothing(l: Look): { title: string; line: string } | undefined {
  const path = shownPath(l.folder ?? ''), name = folderName(l.folder ?? '');
  const said = (l.note ?? `${name} could not be read`).trim();
  switch (l.state) {
    case 'denied': return { title: `Tasktap may not read ${name}`, line: mac
      ? `macOS keeps Tasktap out of ${path}. Allow Tasktap under System Settings › Privacy & Security › Files and Folders, then search ${name} again.`
      : `Windows keeps Tasktap out of ${path}. Search ${name} again once your account may read it.` };
    case 'failed': return { title: `${name} could not be read`, line: `${path}: ${said}${/[.!?]$/.test(said) ? '' : '.'}` };
    case 'many': return { title: `Too many folders in ${name}`, line: `Over ${BUDGET.toLocaleString('en')} folders in ${path}. Choose the folder inside ${name} that holds your projects.` };
    case 'gone': return { title: `${name} is not there now`, line: `Nothing is at ${path} now. Tasktap searches ${name} again when ${name} is back.` };
    case 'ready': return l.found ? undefined : { title: `No projects found in ${name}`, line: '' };
    default: return undefined;
  }
}
/** The first folder Tasktap could not search through: not there, too full, or not to be read. */
const stuck = () => looks().find((l) => l.kind === 'folder' && l.on && ['denied', 'failed', 'many', 'gone'].includes(l.state));
/** What a search that found no project says, in the first run's sheet and Setup's line alike: of the folder the person
 *  searched last in this page's life, else of the first that could not be searched through, else of every folder
 *  searched. None when no folder was searched. */
function nothingFound(): { title: string; line: string } | undefined {
  const folders = looks().filter((l) => l.kind === 'folder' && l.on), last = folders.find((l) => l.id === begun.last), trouble = stuck();
  return (last && nothing(last)) || (trouble && nothing(trouble))
    || (folders.length ? { title: `No projects found in ${and(folders.map((l) => folderName(l.folder ?? '')))}`, line: '' } : undefined);
}
/** A look is asked for, or the core has named it and its record has not come yet, or it reads. */
const searching = () => begun.asking > 0 || [...named].some((id) => !records.looks.has(id)) || looks().some(reading);
/** The looks the core named in its answer to `look.add`. */
const named = new Set<string>();
const READS_FOLDERS = `Tasktap reads the names of the folders in there and, of each project, the first lines of its README and its package file and its Git remote, and asks Git for its first commit. It keeps all of that on ${HERE}. ${MODEL} Tasktap opens no project until a task goes there.`;

// ——— What Tasktap knows ———

/** The projects: a card that is no copy of another, no folder inside one and not set aside by the person. The most
 *  recently worked on first. */
export function known(): Card[] {
  return [...records.cards.values()].filter((c) => !c.copy_of && !c.inside && !c.hidden).sort(recent);
}
/** What a search found, for the first run's sheet: the projects, also those the person switched off there. */
const found = () => [...records.cards.values()].filter((c) => !c.copy_of && !c.inside).sort(recent);
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
/** The agents whose history is offered and was never asked about: no look names them, on or off. */
const unasked = (o: Offer) => o.agents.filter((a) => !looks().some((l) => l.kind === 'agent' && l.agent === a.agent));

/** Adds looks; until the core has them, the first run counts them as reading. */
const add = (asked: AddLook[]) => {
  begun.asking += asked.length;
  return Promise.all(asked.map((l) => call('look.add', l).then((id) => (named.add(id), id)).finally(() => (begun.asking--, redraw())))).catch(fail);
};
const lookAgents = (agents: string[], on: boolean) => add(agents.map((agent) => ({ id: uuid7(), agent, on })));
/** Folders to search: the last of them is what the first run's sheet then speaks of. */
const lookIn = (folders: string[], on = true) =>
  add(folders.map((folder) => ({ id: uuid7(), folder, on }))).then((ids) => void (on && ids?.length && ((begun.last = ids.at(-1)!), redraw())));
/** A folder chosen in the system's folder panel, searched at once; what it holds is then what the first run's sheet shows. */
export const searchInFolder = async () => {
  const f = await call('host.pick', { folder: true }).catch(fail);
  if (f) ((begun.looked = true), await lookIn([f]));
};
/** The home folder, searched at once (the core names it `~`). */
export const searchHome = () => ((begun.looked = true), lookIn(['~']));

// ——— The first search: the welcome's first step ———

/** What the person did in this page's life: searched from the welcome (what was found shows there), the folders asked
 *  for, and the last of them, which a search that found nothing speaks of. Not kept: what they said to Tasktap is in the
 *  looks. `home`: the home folder was searched, after the folders the core offers found nothing. */
const begun = { looked: false, asking: 0, last: null as string | null, home: false };

/** What is stored says the first step was seen: a look was kept, Setup's preference was stored, or a thought was put in
 *  (then Tasktap is in use). Read from the records alone, so it is known before Home's first picture (setup.tsx). */
export const seen = () => records.looks.size > 0 || records.prefs.has('setup_hidden') || records.thoughts.size > 0;

/** The welcome's first step (welcome.tsx): the search starts by itself as the step appears, first with what the core
 *  offers (the folders the agents worked in, and the places it offers), and when that finds nothing, the home folder.
 *  It says what stands of it: every project found (also one the person switched off there), whether a look is still to
 *  come (until the record of each has arrived), and, once everything searched found nothing, why. */
export function useFirstSearch() {
  const o = useOffer(), all = found(), busy = searching();
  useEffect(() => {
    if (!o || begun.looked || looks().length) return;
    begun.looked = true;
    const agents = unasked(o).map((a) => a.agent), places = o.places.map((p) => p.folder);
    if (!agents.length && !places.length) begun.home = true, void searchHome();
    else void Promise.all([agents.length && lookAgents(agents, true), places.length && lookIn(places)]);
  }, [!!o]);
  // What the core offers found nothing: the home folder, by itself, once.
  useEffect(() => {
    if (begun.looked && !begun.home && !busy && !all.length && o && !begun.asking) (begun.home = true, void searchHome());
  }, [busy, all.length, !!o]);
  const none = begun.home && !busy && !all.length;
  return { all, busy, none, why: none ? nothingFound() : undefined };
}

// ——— Settings › Projects ———

/** Where Tasktap learns of projects, then every project it knows, then what the person said is none. */
export function ProjectsPane() {
  const o = useOffer();
  const [query, setQuery] = useState('');
  const [shown, show] = useState<string | null>(null);
  const [aside, setAside] = useState(false);
  const [again, setAgain] = useState<'' | 'looking' | string>('');
  const [reads, setReads] = useState(false);
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
  const found = projects.filter(match);
  const hidden = cards.filter((c) => c.hidden).sort(recent);
  const lookAgain = () => {
    setAgain('looking');
    call('projects.look', {}).then((r) => setAgain(`Tasktap knows ${plural(r.projects, 'project', 'projects')} now; the search took ${r.ms < 1000 ? `${Math.max(1, Math.round(r.ms))} ms` : `${(r.ms / 1000).toFixed(1)} s`}.`),
      (e: unknown) => (setAgain(''), fail(e)));
  };
  const lastLooked = Math.max(0, ...all.filter((l) => l.on).map((l) => l.looked ?? 0));
  return (
    <>
      <h3>Find projects in your agents’ history</h3>
      <div class="list">
        {agentIds.map((id) => <AgentLook key={id} agent={id} name={nameOf(id)} look={all.find((l) => l.kind === 'agent' && l.agent === id)} />)}
        {!agentIds.length && <p class="line-n solo">No agent's history is on {HERE}.</p>}
      </div>
      {agentIds.length > 0 && <p class="note">{SAYS_AGENTS(agentIds.map(nameOf))}</p>}
      <h3>Folders to search for projects</h3>
      <div class="list lk">
        {folders.map((l) => <FolderLook key={l.id} look={l} cards={cards} />)}
        {suggested.map((s) => (
          <div class="line pl sug" key={s.folder}>
            <I n="folder" />
            <span class="t path">{shownPath(s.folder)}</span>
            <span class="x">{s.projects >= 2 ? `${s.projects} of your projects are in it` : 'Not searched yet'}</span>
            <span class="acts"><button type="button" class="btn" onClick={() => void (s.look ? call('put', { c: 'looks', id: s.look.id, patch: { on: true } }).catch(fail) : lookIn([s.folder]))}>Search it</button></span>
          </div>
        ))}
        <button type="button" class="line fold-l" onClick={() => void searchInFolder()}><I n="plus" /><span class="t">Add a folder…</span><span class="x">Tasktap finds the projects inside it</span></button>
      </div>
      <p class="note">{SAYS_FOLDERS}</p>
      <button type="button" class="more-l" aria-expanded={reads} onClick={() => setReads(!reads)}><I n="chev" /><span>What exactly is read</span></button>
      {reads && <p class="note">{agentIds.length > 0 && `${READS_AGENTS(agentIds.map(nameOf))} `}{READS_FOLDERS}</p>}
      <div class="list">
        <div class="line pl">
          <span />
          <span class="t">Last search for projects</span>
          <span class="x">{lastLooked ? ago(lastLooked) : 'Not yet'}</span>
          <span class="acts"><button type="button" class="btn" disabled={again === 'looking' || !all.some((l) => l.on)} onClick={lookAgain}>{again === 'looking' ? 'Searching…' : 'Search again'}</button></span>
        </div>
        {again && again !== 'looking' && <p class="line-n" role="status">{again}</p>}
      </div>
      <h3>{projects.length ? `Your projects (${projects.length})` : 'Your projects'}</h3>
      {projects.length > 0 && (
        <label class="field"><I n="search" />
          <input type="search" placeholder="Find a project" aria-label="Find a project" autocomplete="off" spellcheck={false} value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
        </label>
      )}
      <div class="list pjs">
        {found.map((c) => <Row key={c.id} c={c} open={shown === c.id} show={show} cards={shown === c.id ? cards : NONE} />)}
      </div>
      {!projects.length && <p class="note">No projects yet: turn on an agent’s history or add a folder above.</p>}
      {projects.length > 0 && !found.length && <p class="note">No project’s name contains “{query.trim()}”.</p>}
      {hidden.length > 0 && (
        <div class="list">
          <button type="button" class="line fold-l" aria-expanded={aside} onClick={() => setAside(!aside)}>
            <I n="chev" /><span class="t">Not projects ({hidden.length})</span><span class="x">You said these are not projects, so Tasktap never suggests them</span>
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
  const says = !look || !on ? 'Off' : reading(look) ? 'Reading…' : look.state === 'gone' ? `Not on ${HERE} now`
    : look.state === 'failed' ? (look.note ?? 'Could not be read') : `${plural(look.found, 'project', 'projects')}${look.looked ? `, read ${ago(look.looked)}` : ''}`;
  return (
    <div class="line pl" data-s={on ? undefined : 'none'} data-agent={agent}>
      <Glyph agent={agent} tone={on ? undefined : 'quiet'} />
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
  // The row says what happened in a few words, as the first run's sheet does; the line under it says the rest.
  const why = reading(look) ? undefined : nothing(look);
  const state = reading(look) ? 'Reading…' : look.state === 'gone' ? 'Not there now' : why ? why.title
    : `${plural(look.found, 'project', 'projects')}${look.looked ? `, read ${ago(look.looked)}` : ''}`;
  const note = look.state === 'gone' ? `${kept.length ? `Its ${plural(kept.length, 'project is', 'projects are')}` : 'What it held is'} kept for when it is back.`
    : (why?.line ?? (look.state === 'ready' ? (look.note ?? '') : ''));
  return (
    <>
      <div class="line pl" data-s={look.state === 'gone' || look.state === 'many' || look.state === 'failed' || look.state === 'denied' ? 'off' : undefined}>
        <I n="folder" />
        <span class="t path">{shownPath(look.folder ?? '')}</span>
        <span class="x" title={state}>{state}</span>
        <span class="acts">{!asks && <button type="button" class="btn" onClick={() => ask(true)}>Remove</button>}</span>
      </div>
      {note && !asks && <p class="line-n">{note}</p>}
      {asks && (
        <div class="line-n ask">
          <span>{goes ? `Tasktap stops searching there and forgets the ${plural(goes, 'project', 'projects')} only this folder found; open ones stay.` : 'Tasktap stops searching there. Its projects stay: they are found elsewhere too.'}</span>
          <button type="button" class="btn" onClick={() => ask(false)}>Cancel</button>
          <button type="button" class="btn warn" onClick={() => void call('delete', { c: 'looks', id: look.id }).catch(fail)}>Remove</button>
        </div>
      )}
    </>
  );
}

type RowProps = { c: Card; open: boolean; show: (id: string | null) => void; cards: Card[] };
const NONE: Card[] = [];
/** A project's row is drawn again only when its card changes or it opens or closes: there may be thousands of them,
 *  and the page is drawn again often. Only the open one is given every card, to find its copies and what is inside it. */
class Row extends Component<RowProps> {
  override shouldComponentUpdate(n: RowProps) {
    return n.c !== this.props.c || n.open !== this.props.open || n.cards !== this.props.cards;
  }
  override render() {
    return <ProjectRow {...this.props} />;
  }
}

/** One project: its name, folder and when it was last worked on; opened, everything Tasktap knows of it, and the two
 *  corrections a person makes: it is no project, or forget it. */
function ProjectRow({ c, open: isOpen, show, cards }: RowProps) {
  const copies = cards.filter((x) => x.copy_of === c.id), inside = cards.filter((x) => x.inside === c.id);
  const ws = c.project_id ? records.projects.get(c.project_id) : undefined;
  // Opened below what the pane shows, the details come into view by the pane's own scrolling: down just as far as
  // their end, and never so far that the project's own row goes out at the top.
  const head = useRef<HTMLButtonElement>(null), details = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pane = head.current?.closest('.set-pane'), end = details.current;
    if (!isOpen || !pane || !end || !head.current) return;
    const view = pane.getBoundingClientRect(), top = head.current.getBoundingClientRect().top, bottom = end.getBoundingClientRect().bottom;
    if (bottom > view.bottom) pane.scrollTop += Math.min(bottom - view.bottom, top - view.top);
  }, [isOpen]);
  return (
    <>
      <button ref={head} type="button" class="line pj" aria-expanded={isOpen} data-s={c.available ? undefined : 'none'} onClick={() => show(isOpen ? null : c.id)}>
        <I n="chev" />
        <span class="t">{c.name}</span>
        <span class="x mono" title={shownPath(c.folder)}>{shownPath(c.folder)}</span>
        <time>{c.used ? since(c.used) : ''}</time>
      </button>
      {isOpen && (
        <div ref={details} class="pj-c">
          <Fact k="Folder"><span class="mono">{shownPath(c.folder)}</span>{!c.available && <span class="dim">Not there now</span>}</Fact>
          <Fact k="Called"><Names c={c} /></Fact>
          <Fact k="About">{c.about ? <><span>{c.about}</span>{c.about_from && <span class="dim">{c.about_from}</span>}</> : <span class="dim">Its README and package file say nothing about it.</span>}</Fact>
          <Fact k="Why Tasktap thinks so"><span>{reasons(c).join(', ') || 'You opened it'}</span></Fact>
          <Fact k="Last worked on"><span>{c.used ? `${since(c.used)[0]!.toUpperCase()}${since(c.used).slice(1)}, ${new Date(c.used).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}` : 'Not known'}</span></Fact>
          {copies.length > 0 && (
            <Fact k={copies.length === 1 ? 'Another copy' : 'Other copies'}>
              {copies.map((x) => (
                <span class="pj-l" key={x.id}><span class="mono">{shownPath(x.folder)}</span>{x.used && <span class="dim">{since(x.used)}</span>}
                  <button type="button" class="btn" onClick={() => void call('put', { c: 'cards', id: x.id, patch: { main: true } }).catch(fail)}>Send tasks to this copy</button></span>
              ))}
            </Fact>
          )}
          {inside.length > 0 && (
            <Fact k="Inside">
              {inside.map((x) => <span class="pj-l" key={x.id}><span class="mono">{shownPath(x.folder)}</span>{x.agents.length > 0 && <span class="dim">{worked(x, 'there')}</span>}</span>)}
            </Fact>
          )}
          <Where c={c} ws={ws} />
          <Fact k="In the sidebar"><span>{ws?.open ? 'Yes, open' : ws ? 'Closed. A task that names this project opens it again.' : 'Not yet. A task that names this project opens it.'}</span></Fact>
          <div class="pj-a">
            <button type="button" class="btn" onClick={() => void call('put', { c: 'cards', id: c.id, patch: { hidden: true } }).catch(fail)}>Not a project</button>
            <button type="button" class="btn" onClick={() => void call('delete', { c: 'cards', id: c.id }).catch(fail)}>Forget</button>
            <span class="dim">Not a project keeps it out for good; Forget removes it until Tasktap finds it again.</span>
          </div>
        </div>
      )}
    </>
  );
}

const Fact = ({ k, children }: { k: string; children: ComponentChildren }) => <div class="pj-k"><span class="k">{k}</span><span class="v">{children}</span></div>;

/** Where a project's agent works (core: `isolate`, docs/core-design.md §7): on a copy of the project of its own, whose
 *  changes come back with Keep or go with Discard, or in the project itself. The card keeps the choice, and the
 *  workspace made from it follows (`put cards`); only a Git repository has copies, so any other folder has no choice. */
const WHERE = 'Where its agent works';
const places: [Isolate, string][] = [['busy', 'On its own copy when another agent is working there'], ['always', 'Always on its own copy'], ['never', 'In the project itself']];
const placed: Record<Isolate, string> = {
  busy: 'While another agent works here, the next one works on a copy; when it finishes you choose Keep to bring its changes in, or Discard.',
  always: 'Every agent works on a copy of the project; when it finishes you choose Keep to bring its changes in, or Discard.',
  never: 'Every agent works in your files directly, so two working here at once can overwrite each other’s changes.',
};
function Where({ c, ws }: { c: Card; ws: Project | undefined }) {
  const [said, say] = useState('');
  const git = ws ? ws.git && ws.kind === 'folder' : c.why.includes('git');
  const now = ws?.isolate ?? c.isolate ?? 'busy';
  const set = (to: Isolate) => void call('put', { c: 'cards', id: c.id, patch: { isolate: to } }).then(() => say(''), (e: unknown) => say(e instanceof Error ? e.message : String(e)));
  if (!git) return <Fact k={WHERE}><span>In the project itself</span><span class="dim says">It is not a Git repository, so there is no copy to give an agent: it works in the folder itself.</span></Fact>;
  return (
    <Fact k={WHERE}>
      <Choice name={WHERE} value={now} all={places} set={set} />
      <span class="dim says">{placed[now]}</span>
      {said && <span class="hint err" role="alert">{said}</span>}
    </Fact>
  );
}

/** What a project is called: its folder's name, the names it goes by, and a name the person adds, for how they say
 *  it ("queue grid"). A name of theirs goes again with its cross. */
function Names({ c }: { c: Card }) {
  const [adding, setAdding] = useState(false);
  // The field takes the keyboard as it opens, by a click or a key: the button that had it is gone.
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => void (adding && field.current?.focus()), [adding]);
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
        <input ref={field} class="text" placeholder="A name, as you say it" aria-label={`Another name for ${c.name}`} maxLength={60} spellcheck={false}
          onKeyDown={(e) => (e.key === 'Enter' ? add(e.currentTarget.value) : e.key === 'Escape' ? (e.stopPropagation(), setAdding(false)) : undefined)}
          onBlur={(e) => add(e.currentTarget.value)} />
      ) : c.names.length < 8 && <button type="button" class="btn" onClick={() => setAdding(true)}>Add a name for it…</button>}
      {said && <span class="hint err" role="alert">{said}</span>}
    </>
  );
}
