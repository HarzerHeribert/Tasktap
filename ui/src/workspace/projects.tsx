// What Tasktap knows of the person's projects (docs/projects-design.md, and the owner's decisions of 2026-11-19 at its
// end), in the two places a person sees it. At the first run, as Setup's first step (setup.tsx): a sheet that asks
// where it may learn of them, in three short facts with the full sentence of what is read behind one line, the
// folders its agents worked in first; then, in the same sheet, what it found, as the sign that looking worked. In Settings › Projects: where it learns of them, every project it knows, and what it knows of each,
// to see and to correct. The app does the housekeeping; neither place is a list the person has to keep.
//
// Everything shown is the core's: where it looks (`records.looks`), what it knows of each folder (`records.cards`), and
// what could be looked at, found by `stat` alone with nothing inside read (`projects.offer`). The page keeps only what
// the person did here a moment ago.
import type { AddLook, Card, Isolate, Look, Offer, Project } from '../../../core/proto/protocol.ts';
import { Component, type ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { uuid7 } from '../client.ts';
import { HERE, shownPath } from '../system.ts';
import { I, Key, Mark, Ring, ago, plural } from '../ui.tsx';
import { Choice, Switch } from './form.tsx';
import { agentName, call, dismiss, fail, focus, open, records, redraw } from './model.ts';
import { type Act, Frame } from './sheets.tsx';

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

/** What Tasktap reads, said before it reads it: of an agent's history, and of a folder; and what of it goes anywhere. */
// As the core says what it sends (core/src/route.rs, `SENDS`): of up to 8 projects, the name, the other names and one line.
const MODEL = 'Only if you let a model place your thoughts does that model get, of up to 8 likely projects, the name, the other names it goes by and one line about each.';
const READS_AGENTS = (names: string[]) =>
  `Tasktap reads which folders ${and(names) || 'your agents'} ${names.length === 1 ? 'was' : 'were'} started in, and when; never what was said there. Of each folder that is a project it reads the first lines of its README and its package file and its Git remote, and asks Git for its first commit. It keeps all of that on ${HERE}. ${MODEL}`;
/** The same, in one sentence each, for Settings › Projects, with the full sentences behind one quiet line. */
const SAYS_AGENTS = (names: string[]) => `Tasktap reads which folders ${and(names) || 'your agents'} worked in and when, never what was said there, and keeps what it learns on ${HERE}.`;
const SAYS_FOLDERS = `Tasktap reads the names of the folders inside and each project’s README, package file and Git details, and keeps them on ${HERE}.`;
const READS_FOLDERS = `Tasktap reads the names of the folders in there and, of each project, the first lines of its README and its package file and its Git remote, and asks Git for its first commit. It keeps all of that on ${HERE}. ${MODEL} It opens nothing until a thought goes there.`;

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

// ——— The first run: Setup's first step, as a sheet ———

/** What the person did here, in this page's life: looked from the sheet (what was found shows in it), and the folders
 *  ticked and added. Not kept: what they said to Tasktap is in the looks. */
const begun = { looked: false, asking: 0, ticked: null as Set<string> | null, added: [] as string[] };

type Step = 'wait' | 'agents' | 'folders' | 'found';
/** What the projects step shows: the question about the agents' history first, asked once; for a person with none,
 *  where their projects are; after either, what was found. */
function step(o: Offer | undefined): Step {
  if (begun.looked) return 'found';
  if (!o) return 'wait';
  if (unasked(o).length) return 'agents';
  if (!o.agents.length && !looks().length) return 'folders';
  return 'found';
}

/** The projects step for Setup (setup.tsx): whether it was ever answered (a look exists, on or off: then it never opens
 *  by itself again), whether it is done (Tasktap looks somewhere), and what its row says. */
export function projectsStep() {
  const o = useOffer(), all = looks(), n = known().length;
  // Answered: a look was kept (on, or off for Not now), or Not now was said where there was nothing to keep (Setup's
  // preference is then stored, as shown).
  const asked = seen() || offered.failed, done = all.some((l) => l.on);
  const says = done ? (n ? `Found ${plural(n, 'project', 'projects')}` : 'Found none yet') : asked ? 'Skipped' : o?.agents.length ? `Where ${and(o.agents.map((a) => a.name))} worked` : 'Choose where your projects are';
  return { asked, done, says, ready: !!o };
}
/** What is stored says the first step was seen: a look was kept, Setup's preference was stored, or a thought was put in
 *  (then Tasktap is in use). Read from the records alone, so it is known before Home's first picture (setup.tsx). */
export const seen = () => records.looks.size > 0 || records.prefs.has('setup_hidden') || records.thoughts.size > 0;

/** "What exactly is read": the full sentence, behind one quiet line (Setup's sheets). */
export function Details({ text, label = 'What exactly is read' }: { text: string; label?: string }) {
  const [shown, show] = useState(false);
  return (
    <>
      <button type="button" class="more-l" aria-expanded={shown} onClick={() => show(!shown)}><I n="chev" /><span>{label}</span></button>
      {shown && <p class="facts-all">{text}</p>}
    </>
  );
}

/** Setup's first step (NOTES §13), a sheet from the sheet family: a headline, three facts a person takes in at a
 *  glance, the full sentence of what is read behind "What exactly is read", and the keys. Allowed, the same sheet
 *  shows what was found, filling in as the looks read, every project in a list that scrolls inside it; never on Home.
 *  `auto`: it is up by itself at the first start, part of Home's first picture, its facts filling in as the core says
 *  what there is; it takes a key only after 600 ms without one (Frame `guard`), and a key it does not take puts it away
 *  and types into the Composer. Put away in any way (Escape, a click beside it, Open a folder…), it was answered Not
 *  now, and it does not come by itself again. */
export function ProjectsSheet({ auto }: { auto?: boolean }) {
  const o = useOffer();
  const at = step(o);
  const other: Act = { k: '⌘O', label: 'Open a folder…', do: () => open({ kind: 'open-workspace' }) };
  // Not now, as the step stands when the sheet goes, whichever way it goes, the moment it goes (after the next frame it
  // could come after an answer given in a sheet opened again); nothing once it was answered here.
  const notNow = useRef<() => void>(() => {});
  useLayoutEffect(() => () => notNow.current(), []);
  const once = (f: () => void) => () => ((notNow.current = () => {}), f());
  // A key the sheet does not take is the Composer's: the sheet goes as Not now, and the field has the keyboard before
  // the key types, so what it types is there.
  const typed = auto ? () => (focus(document.querySelector<HTMLElement>('.home #capture-input')), dismiss()) : undefined;
  if (at === 'wait') {
    notNow.current = answered;
    return (
      <Frame size="md" title="Find your projects" guard={auto} typed={typed} acts={[{ k: 'esc', label: 'Not now', do: dismiss }]}>
        <p class="facts-n" role="status">Searching {HERE} for your agents’ history…</p>
      </Frame>
    );
  }
  if (at === 'agents' && o) {
    const asks = unasked(o), names = asks.map((a) => a.name);
    const later = () => (void lookAgents(asks.map((a) => a.agent), false), answered());
    notNow.current = later;
    const allow = once(() => ((begun.looked = true), void lookAgents(asks.map((a) => a.agent), true), redraw()));
    return (
      <Frame size="md" title="Find your projects" guard={auto} typed={typed}
        acts={[other, { k: 'esc', label: 'Not now', do: once(() => (later(), dismiss())) }, { k: '↩', label: 'Allow', kind: 'primary', do: allow }]}>
        <ul class="facts">
          <li>Tasktap reads which folders {and(names)} worked in, and when.</li>
          <li>It never reads what was said.</li>
          <li>And the first lines of each project's README.</li>
        </ul>
        <Details text={READS_AGENTS(names)} />
      </Frame>
    );
  }
  if (at === 'folders' && o) {
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
    // Not now is an answer: each folder offered is kept as one not looked in, so it is not offered here again.
    const later = () => (void lookIn(o.places.map((p) => p.folder), false), answered());
    notNow.current = later;
    const look = () => (chosen.length ? ((notNow.current = () => {}), (begun.looked = true), void lookIn(chosen), redraw()) : undefined);
    return (
      <Frame size="md" title="Choose where your projects are" guard={auto} typed={typed}
        acts={[other, { k: 'esc', label: 'Not now', do: once(() => (later(), dismiss())) }, { k: '↩', label: 'Search there', kind: 'primary', do: look }]}>
        <div class="ticks" role="group" aria-label="Folders to look in">
          {places.map((f) => <button type="button" class="tick" role="checkbox" aria-checked={ticked.has(f)} onClick={() => tick(f)}><i /><span>{shownPath(f)}</span></button>)}
          <button type="button" class="tick add" onClick={() => void another()}><I n="plus" /><span>Another folder…</span></button>
        </div>
        <ul class="facts">
          <li>Tasktap reads the names of the folders in them.</li>
          <li>And the first lines of each project's README.</li>
          <li>All of it stays on {HERE}.</li>
        </ul>
        <Details text={READS_FOLDERS} />
      </Frame>
    );
  }
  notNow.current = () => {};
  // Called, not mounted: the same Frame stays, and with it the keyboard, as the step turns into what was found.
  return Found({ o, other });
}
/** Not now is an answer, also where nothing was offered to keep as one: the first step does not come down by itself
 *  again (Setup's preference, stored as it stands, says it was seen). */
const answered = () => void (records.prefs.has('setup_hidden') || call('put', { c: 'prefs', id: 'setup_hidden', patch: false }).catch(fail));

/** What was found, filling in as the looks read: every project, the most recently worked on first, each with its
 *  folder and why, in a list that scrolls in the sheet. Under it, where most of them are, if Tasktap has not looked
 *  there. */
function Found({ o, other }: { o: Offer | undefined; other: Act }) {
  const all = known(), coming = settling(), busy = begun.asking > 0 || looks().some(reading);
  const place = derived(o), most = place && place.projects * 2 >= all.length;
  const title = busy && !all.length ? 'Searching…' : all.length ? `Found ${plural(all.length, 'project', 'projects')}` : 'Found no projects';
  return (
    // It only reports (what it found stays in Setup and Settings): text typed in the Composer under it puts it away.
    <Frame size="md" title={<>{busy && <Mark s="working" label="Searching" />}{title}</>} typed={dismiss} acts={[other, { k: 'esc', label: 'Close', do: dismiss }, { k: '↩', label: 'Done', kind: 'primary', do: dismiss }]}>
      <section class="found" aria-busy={busy}>
        {all.length > 0 && <p class="found-o">None is open yet. A thought that names one opens it.</p>}
        {all.length > 0 && (
          <div class="fr-s">
            {all.map((c) => (
              <div class="fr" key={c.id} title={[c.name, shownPath(c.folder), c.about].filter(Boolean).join('\n')}>
                <I n="folder" /><span class="fr-n">{c.name}</span><span class="fr-f">{shownPath(c.folder)}</span><span class="fr-w">{reason(c)}</span>
              </div>
            ))}
          </div>
        )}
        {!busy && !all.length && <p class="found-n">A folder counts when an agent worked there, or when it has Git or a package file in it.</p>}
        {place && !coming && (
          <p class="found-s">
            <span>{most ? 'Most are' : `${place.projects} are`} in <b>{shownPath(place.folder)}</b>. Search there for the others too?</span>
            <button type="button" class="btn" onClick={() => void lookIn([place.folder])}>Search there</button>
          </p>
        )}
      </section>
    </Frame>
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
  const addFolder = async () => {
    const f = await call('host.pick', { folder: true }).catch(fail);
    if (f) await lookIn([f]);
  };
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
        <button type="button" class="line fold-l" onClick={() => void addFolder()}><I n="plus" /><span class="t">Add a folder…</span><span class="x">Tasktap finds the projects inside it</span></button>
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
    : look.state === 'failed' ? (look.note ?? 'Could not be read') : `${plural(look.found, 'project', 'projects')}${look.looked ? ` · read ${ago(look.looked)}` : ''}`;
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
  const state = reading(look) ? 'Reading…' : look.state === 'gone' ? 'Not there now' : look.state === 'many' ? 'Too many folders in it'
    : look.state === 'failed' ? 'Could not be read' : look.found ? `${plural(look.found, 'project', 'projects')}${look.looked ? ` · read ${ago(look.looked)}` : ''}` : 'No projects in it';
  // The row says what happened in a few words; the line under it says the rest.
  const note = look.state === 'gone' ? `${kept.length ? `Its ${plural(kept.length, 'project is', 'projects are')}` : 'What it held is'} kept for when it is back.`
    : look.state === 'many' ? 'Over 2,000 folders: too many. Add the folder inside it that holds your projects.'
      : look.state === 'failed' ? (look.note ?? 'Tasktap could not read it.')
        : look.state === 'ready' && !look.found ? 'A folder counts as a project when it has Git or a package file in it.' : '';
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
          <Fact k="Why Tasktap thinks so"><span>{reasons(c).join(' · ') || 'You opened it'}</span></Fact>
          <Fact k="Last worked on"><span>{c.used ? `${since(c.used)[0]!.toUpperCase()}${since(c.used).slice(1)}, ${new Date(c.used).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}` : 'Not known'}</span></Fact>
          {copies.length > 0 && (
            <Fact k={copies.length === 1 ? 'Another copy' : 'Other copies'}>
              {copies.map((x) => (
                <span class="pj-l" key={x.id}><span class="mono">{shownPath(x.folder)}</span>{x.used && <span class="dim">{since(x.used)}</span>}
                  <button type="button" class="btn" onClick={() => void call('put', { c: 'cards', id: x.id, patch: { main: true } }).catch(fail)}>Send thoughts to this copy</button></span>
              ))}
            </Fact>
          )}
          {inside.length > 0 && (
            <Fact k="Inside">
              {inside.map((x) => <span class="pj-l" key={x.id}><span class="mono">{shownPath(x.folder)}</span>{x.agents.length > 0 && <span class="dim">{worked(x, 'there')}</span>}</span>)}
            </Fact>
          )}
          <Where c={c} ws={ws} />
          <Fact k="In the sidebar"><span>{ws?.open ? 'Yes, open' : ws ? 'Closed. Name it in a thought to open it again.' : 'Not yet. Name it in a thought to open it.'}</span></Fact>
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
