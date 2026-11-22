// The Composer, the same in the notch, the capture sheet and on Home: the thought on lines of its own; under it, inside
// the field, where it will go and why (`where`), who runs it (rings.tsx: the usual agent, or another picked for this
// thought alone), the microphone, and the key that says what Return does. The question about the thought it sent last
// is asked under it (`atComposer`).
// A thought no name places is asked about (question.tsx): where it goes, also when no project is known at all; it is
// saved for later only when the person says so.
//
// Under the row is what is on its way, by one mechanism for typing and for voice (way.ts): speech being heard and
// written down, then the thought being placed, then where it goes with its brief, readable for the length of its hold,
// with Undo. Every Composer shows every thought on its way, whoever captured it. Return on an empty field starts the
// newest of them now, and the Composer's key says so: it is the one key that says Start.
import type { Capture as CaptureArgs, Card, Dictation, DictationTarget, Found, Question, Route, Thought } from '../../core/proto/protocol.ts';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { uuid7 } from './client.ts';
import { hit, keyName, spell } from './keys.ts';
import { type Icon, rows, says, type Why } from './place.ts';
import { inFront, talkKey } from './page.ts';
import { Roll, rollIn, rolls, stopRoll } from './lines.ts';
import { effectsOf } from './motion/motion.tsx';
import { Ask, routerRows } from './question.tsx';
import { AGENT_KEY, AgentControl, AgentList, chosen, open as openAgents } from './rings.tsx';
import { cancel, control, end, follow, mine, needs, place, setAim, talk, voiced } from './speech/record.ts';
import { Brand, I, Key, Level, Mark, madeAt } from './ui.tsx';
import { QUIET, agent, agentName, byPerson, call, core, coreIn, fail, focus, keyTimes, loadTerms, openQuestions, page, placeArgs, placers, pref, projectName, projects, records, redraw, sentence, sessionName, why } from './page.ts';
import { back, briefOf, clock, decided, first, hold, laterWhy, leave, type Names, offers, onWay, placed, placeOf, placing, step, waits, wholeHold } from './way.ts';

/** The line in the empty field (lines.ts), one for every Composer of the page, and the one owner of its timer: the
 *  line with the key held to talk where talking is set up, the line about a second task while one runs. A line rolls in
 *  over the field with the keyboard; any other field showing the line simply has the new words. */
export const invite = new Roll(
  () => ({ key: voiced() ? keyName(talkKey()) : null, running: [...records.thoughts.values()].some((t) => t.status === 'working') }),
  (line, roll) => {
    stopRoll();
    for (const f of document.querySelectorAll<HTMLTextAreaElement>('textarea[data-lines]')) roll && f === document.activeElement ? rollIn(f, f.placeholder, line) : (f.placeholder = line);
  },
  stopRoll,
);
/** An input method's composition is under way in the field: its first letters are not the field's value yet. */
let composing = false;
void coreIn.then(() => askRoute(), () => {});
const dictating = () => talk.asking || [...records.dictations.values()].some((x) => x.phase === 'recording' || x.phase === 'transcribing');
/** Whether the line rolls in field `el` (the one with the keyboard, by default) now: never before the core has
 *  answered (the person's effects are not known yet), nor while the page is not shown (a display asleep). */
export const rollsHere = (el = document.activeElement) =>
  core.in && el instanceof HTMLTextAreaElement && el.id === 'capture-input'
  && rolls({ empty: !cap.draft, held: document.activeElement === el, front: inFront(), shown: document.visibilityState === 'visible', dictating: dictating(), composing, effects: effectsOf(pref('motion_ambient')) });

/** What was just sent, for what is said of it once it is no longer on its way. `pick`: the place the person chose for
 *  it, which Undo gives back with its words. How it came by its place is the thought's own to say (`placed`). */
export type Sent = { id: string; text: string; to: string | 'later'; pick?: string; agent?: string };

export const cap = {
  draft: '',
  /** The person's own pick of destination for the thought in the field: a project id, 'later', or '' for Auto. It
   *  goes with that thought, so one saved for later, or sent to a folder by hand, does not decide where the
   *  next goes. */
  dest: undefined as string | undefined,
  /** The agent the person picked for the thought in the field, by its ring. It goes with that thought and no further:
   *  the next is the usual agent's again (the `agent` preference, which only the Agents sheet changes). */
  agent: undefined as string | undefined,
  /** The folder of the workspace the capture sheet was opened in, for that opening only: the sheet clears it when it is
   *  put away, and Home's and the notch's Composers never have it. Not a pick, and never the Scratchpad. */
  usual: undefined as string | undefined,
  /** The place chosen for the thought this Composer sent last: the chip says it is back from it, until a place is
   *  chosen again or the Composer is opened anew. */
  back: undefined as string | undefined,
  /** Where the router would send the text typed now (route.hint), for the chip. */
  hint: null as { text: string; route: Route } | null,
  /** The session the person is in, which the router may send a follow-up to. */
  current: null as string | null,
  choosing: false,
  /** The list of who runs the thought is open in the foot (rings.tsx), and what is typed in its field. */
  agents: false,
  findAgent: '',
  /** A thought kept for later that the list, while open, sends to a folder, rather than choosing where the next goes. */
  moving: null as string | null,
  /** What is typed in the list's field to find a project, and what the core found for a text (projects.find). */
  find: '',
  found: null as { text: string; thought: boolean; list: Found[] } | null,
  /** How many thoughts are on their way to the core, their call not back yet. The field is free for the next. */
  sending: 0,
  sent: null as Sent | null,
  undone: null as Sent | null,
  /** Why the core did not take the last thought, in its words, until the field changes. */
  refused: '',
  /** The thought a dictation is to become, until it has. */
  spoken: '',
  /** No longer offered under the Composer (NOTES §13: offers are Setup's); kept for the placing sheet, which clears it. */
  offer: false,
};

const folder = (dest: string | undefined) => (dest && dest !== 'later' ? dest : undefined);
/** Where the router would send it, when that is one project: a workspace, or a project Tasktap knows that is not open. */
const routedProject = (r: Route | undefined) => (r?.confidence === 'clear' ? ('project' in r.to ? r.to.project : 'card' in r.to ? r.to.card : undefined) : undefined);
/** A project Tasktap knows that a thought may go to: not a copy of another, not inside one, not hidden, and there. */
const offered = (c: Card | undefined) => !!c && !c.copy_of && !c.inside && !c.hidden && c.available;
/** Whether a destination is a project Tasktap knows and has not opened: a thought started there opens it. */
export const unopened = (id: string | undefined) => !!id && !records.projects.get(id)?.open && offered(records.cards.get(id));
/** The projects a thought can go to without opening a folder: the open folders, and the known projects not open. */
const known = () => {
  const folders = projects().filter((p) => p.kind === 'folder');
  const cards = [...records.cards.values()].filter((c) => offered(c) && !folders.some((p) => p.id === c.project_id || p.folder === c.folder));
  return [...folders.map((p) => p.id), ...cards.map((c) => c.id)];
};
/** Placing by a model is agreed to, for what this core would send now. */
const modelPlaces = () => placing(pref('route_by'), placers()) === 'on';

/** The person's pick, while it can still be used. */
export const picked = () => (cap.dest === '' || cap.dest === 'later' || (cap.dest && (records.projects.get(cap.dest)?.open || scratchpad(cap.dest) || unopened(cap.dest))) ? cap.dest : undefined);
/** The Scratchpad, which a thought may go to also when it was put away: it opens again as the thought starts there. */
const scratchpad = (id: string) => records.projects.get(id)?.kind === 'scratch';

/** Where the router would send the text typed now, when it knows (route.hint): then Enter
 *  leaves the routing to it rather than picking for the person. */
export function hinted(): Route | undefined {
  const r = cap.hint?.text === cap.draft.trim() ? cap.hint.route : undefined;
  return !picked() && r && r.confidence !== 'unknown' ? r : undefined;
}

/** Where the thought in the field goes, who places it (`to` '' is the router's to say), and why
 *  (docs/projects-design.md, "The chip", and the owner's decisions of 2026-11-19). The person's choice, for this
 *  thought alone; else a follow-up to the session its words name or the person is in; else the project its words
 *  name, as written or with its parts said apart, open or only known (it opens when the thought starts there), or a
 *  question when they name several or only sound like one; else the folder of the workspace this Composer was opened
 *  in; else Auto, by a model, where placing by one is agreed to; else the one folder the person opened, when it is the
 *  only place there is; else Auto by its words, which asks where a thought goes that names none, also with no project
 *  known ("Where should the agent work?"). In Tasktap's window that is the chip as released before a model decided
 *  every task: the core's hint names the session or the project only where the names are sure. Auto chosen there lets
 *  the model decide, also over the session or the workspace in view, which it is told (the coordinator's round 3).
 *  The Scratchpad is never a default: a thought goes there only when the person chooses it or says it (the core's
 *  route). What the chip says of it is place.ts's. */
export function where(pick = picked(), route = hinted(), usualId = cap.usual): { to: string; by: 'router' | 'pick' | 'later'; why: Why } {
  // The core has not answered yet: nothing is known, and nothing is said; a task started now is placed once it has.
  if (!core.in) return { to: '', by: 'router', why: 'starting' };
  const all = known();
  const usual = pick === undefined && usualId ? records.projects.get(usualId) : undefined;
  if (pick === 'later') return { to: pick, by: 'later', why: 'chosen' };
  if (pick) return { to: pick, by: 'pick', why: 'chosen' };
  // Auto chosen: a model decides, also where the names or the session in view would say the place.
  if (pick === '' && all.length && modelPlaces()) return { to: '', by: 'router', why: 'model' };
  if (route?.confidence === 'clear' && 'session' in route.to) return { to: '', by: 'router', why: 'follows' };
  if (route?.confidence === 'clear') return { to: routedProject(route) ?? '', by: 'router', why: route.said ? 'said' : 'named' };
  if (route) return { to: '', by: 'router', why: 'asked' };
  if (usual?.open && usual.kind === 'folder') return { to: usual.id, by: 'pick', why: 'in' };
  if (all.length && modelPlaces()) return { to: '', by: 'router', why: 'model' };
  // The one place there is, when it is a folder the person opened: a project Tasktap only knows of is never a default.
  if (pick === undefined && all.length === 1 && records.projects.get(all[0]!)?.kind === 'folder') return { to: all[0]!, by: 'pick', why: 'only' };
  return { to: '', by: 'router', why: cap.draft.trim() ? 'ask' : 'words' };
}
/** What the chip says of where the thought goes (place.ts), from the records. `back`: the thought before had a place
 *  of its own, and this one goes where nobody chose. */
function chipSays(w: ReturnType<typeof where>, route: Route | undefined, back: boolean) {
  const session = route?.confidence === 'clear' && 'session' in route.to ? route.to.session : undefined;
  return says(w.why, {
    place: session ? sessionName(session) : projectName(folder(w.to)),
    is: session ? 'session' : w.by === 'later' ? 'later' : records.projects.get(w.to)?.kind === 'scratch' ? 'scratch' : 'folder',
    fresh: unopened(w.to), agent: modelPlaces() ? agentName(first(pref('route_by'), placers())) : undefined, back, key: spell('⌘K'),
  });
}
/** What a capture says of its place: the session and the workspace in view for the router (none in the notch, which
 *  sets neither), and whether the chip says Auto there, so a model decides and is told them; a pick's place; or a
 *  note. */
const named = (w: ReturnType<typeof where>, current = cap.current, view = cap.usual): Partial<CaptureArgs> =>
  w.by === 'router' ? { current, ...(view ? { view } : {}), ...(w.why === 'model' && (current || view) ? { auto: true } : {}) }
    : w.by === 'pick' ? placeArgs(w.to) : { mode: 'note' };

/** The thoughts on their way, newest first: being placed, or placed and held. Undo still takes each back. */
export const going = () => [...records.thoughts.values()].filter((t) => onWay(t)).sort((a, b) => b.created - a.created);
/** Something is being placed, or a capture of this page has not come back yet: the motion thinks. */
export const routing = () => (!!cap.sent && cap.sent.to !== 'later' && !records.thoughts.has(cap.sent.id) && !cap.spoken) || going().some((t) => t.route?.pending);
/** What this page sent can still be undone. */
export const holding = () => {
  const t = cap.sent && records.thoughts.get(cap.sent.id);
  return !!cap.sent && cap.sent.to !== 'later' && (!t || onWay(t));
};

type Hooks = {
  /** After the folder panel: the notch takes the keyboard back. */
  picked?: () => void;
  /** The sent thought started; the page may put the capture away. */
  started?: () => void;
  /** An agent that cannot run was chosen: the page shows where it is signed in. */
  agents?: () => void;
  /** Voice is not set up yet: the page leads to where it is (Setup's step in the window, Settings from the notch). */
  speech?: () => void;
};

async function addProject(hooks: Hooks): Promise<string | undefined> {
  const moving = cap.moving;
  Object.assign(cap, { choosing: false, moving: null });
  try {
    const chosen = await call('host.pick', { folder: true });
    const added = chosen ? await call('project.add', { id: uuid7(), folder: chosen }) : undefined;
    if (added && moving) await call('thought.update', { id: moving, project_id: added });
    else if (added) cap.dest = added;
  } catch (e) {
    fail(e);
  }
  page.focus = '#capture-input';
  hooks.picked?.();
  redraw();
  return folder(cap.dest);
}

const start = (t: Thought) => void call('thought.start', { id: t.id, attempt: uuid7() }).catch(fail);
/** The thought Return on an empty field starts now: the newest on its way, once it has its place. None while one is
 *  still on its way to the core, so a second Return after the one that sent it starts nothing by surprise. */
const waiting = () => {
  const t = going()[0];
  return !cap.sending && t && step(t) !== 'placing' ? t : undefined;
};
/** The sends whose calls are not back yet, for Undo, which takes back what they bring. */
let flights: Promise<unknown> = Promise.resolve();

/** Return. The thought leaves the field at once (way.ts leave), and with it the place picked for it and the thought it
 *  was before Undo gave it back, so the next can be typed while it is on its way to the core. One the core refuses is
 *  back in the field with both. */
async function send(e: Event, hooks: Hooks) {
  e.preventDefault();
  if (!cap.draft.trim()) {
    const t = waiting();
    return void (t && start(t));
  }
  // Before the core has answered, where the task goes is worked out the moment it and its records are there, from
  // what the person had chosen when they started it (nothing can be chosen before); the task goes then, once.
  const pick = picked(), { dest, undone, agent: by, usual, current } = cap;
  let w = where();
  const waited = !core.in;
  const gone = leave(cap, async (text) => {
    if (waited) (await coreIn, (w = where(pick, undefined, usual)));
    let id = uuid7();
    // (An agent is a capture's to name: a thought that goes out again to another agent is captured anew.)
    if (undone && w.to && w.to !== 'later' && by === undone.agent) {
      // The thought Undo returned to the person goes out again, with what they changed, rather
      // than a copy of it that would stay behind.
      id = undone.id;
      if (undone.text !== text) await call('put', { c: 'thoughts', id, patch: { text } });
      await call('thought.update', { id, ...placeArgs(w.to) });
    } else {
      if (undone) await call('delete', { c: 'thoughts', id: undone.id });
      await call('thought.capture', { id, text, strokes: [], source: 'typed', ...named(w, current, usual), ...(by ? { agent: by } : {}) });
    }
    Object.assign(cap, { sent: { id, text, to: w.to, pick, agent: by } });
    page.error = '';
  });
  Object.assign(cap, { hint: null, dest: undefined, agent: undefined, agents: false, undone: null, refused: '', back: pick });
  // The field is empty again: the next line, rolled in where it rolls, else simply there (Still, Off, Reduce Motion).
  invite.next(rollsHere());
  flights = Promise.allSettled([flights, gone]);
  redraw();
  // Refused: the words are back with their place and their agent, and the core's sentence is under them.
  await gone.catch((err) => {
    Object.assign(cap, { dest: cap.dest ?? dest, agent: cap.agent ?? by, undone: cap.undone ?? undone, refused: sentence(err instanceof Error ? err.message : String(err)) });
    askRoute();
  });
  redraw();
}

/** Takes a thought back before it starts: the core stops asking about it and holding it, and its words return to the
 *  field, before what was typed since, with the place the person had picked, if they had, still picked. `later`: the
 *  one just saved for later is removed instead. With none named it is the newest, once what is on its way to the
 *  core has arrived there. */
export async function undo(t?: Thought | 'later') {
  if (!t) {
    await flights;
    t = going()[0] ?? (kept() ? 'later' : undefined);
  }
  const sent = cap.sent;
  try {
    if (t === 'later' && sent) {
      const text = records.thoughts.get(sent.id)?.text ?? sent.text;
      await call('delete', { c: 'thoughts', id: sent.id });
      Object.assign(cap, { sent: null, draft: back(text, cap.draft), dest: sent.pick, agent: sent.agent });
    } else if (t && t !== 'later') {
      await call('thought.stop', { id: t.id });
      // The agent picked for it alone comes back with it, as the thought itself says.
      const by = t.agent && t.agent !== agent()?.id ? t.agent : undefined;
      Object.assign(cap, {
        undone: { id: t.id, text: t.text, to: t.project_id ?? t.card_id ?? '', agent: by }, sent: sent?.id === t.id ? null : sent, dest: sent?.id === t.id ? sent.pick : cap.dest,
        agent: by, draft: back(t.text, cap.draft),
      });
      // Where it goes is asked again for the words that are back, as it was while they were typed.
      askRoute();
    } else return;
    page.focus = '#capture-input';
  } catch (e) {
    fail(e);
  }
  redraw();
}

/** What this page sent last waits in For later: saved there by choice, or kept there because its words named no
 *  folder. Undo takes it back. */
const kept = () => {
  const t = cap.sent && records.thoughts.get(cap.sent.id);
  return cap.sent?.to === 'later' || (!!t && step(t) === 'later');
};

/** An undone thought whose text the person cleared is gone: nothing stale stays behind. */
function drop() {
  const undone = cap.undone;
  cap.undone = null;
  if (undone) void call('delete', { c: 'thoughts', id: undone.id }).catch(fail);
}

let hintTimer = 0;
/** Asks the core where the text typed so far would go, a moment after typing stops. */
function askRoute() {
  clearTimeout(hintTimer);
  // Before the core has answered nothing is asked (the questions would all go at once when it comes); then once.
  if (!core.in) return;
  const text = cap.draft.trim();
  if (!text) {
    cap.hint = null;
    return redraw();
  }
  hintTimer = window.setTimeout(() => {
    void call('route.hint', { text, current: cap.current, ...(cap.usual ? { view: cap.usual } : {}) }).then((route) => {
      cap.hint = { text, route };
      redraw();
    }, () => {});
  }, 150);
}

export function choose(open: boolean) {
  cap.choosing = open;
  if (open) cap.agents = false;
  cap.find = '';
  if (!open) cap.moving = null;
  // The field to find a project has the keyboard; the arrows reach the rows under it.
  page.focus = open ? '#cap-find' : '#capture-input';
  if (open) ask(cap.moving ? '' : cap.draft.trim(), 3, true);
  redraw();
}

/** What the list found (projects.find), asked a moment after typing stops and kept for that text only: for what is
 *  typed in its field, the projects whose names it matches; for the thought already written (`thought`), the places
 *  its own words name or describe. Either may be none: then the list is what is in use. */
let finding = 0;
function ask(text: string, limit: number, thought: boolean) {
  clearTimeout(finding);
  if (!text) return void (cap.found = null);
  finding = window.setTimeout(() => {
    void call('projects.find', { text, limit, thought }).then((r) => {
      cap.found = { text, thought, list: r.found };
      redraw();
    }, () => {});
  }, cap.found ? 120 : 0);
}

function pick(dest: string) {
  const moving = cap.moving;
  // The list was opened from a kept thought's line: it starts there, as from Home's For later.
  if (moving) void call('thought.update', { id: moving, ...placeArgs(dest) }).catch(fail);
  else Object.assign(cap, { dest, back: undefined });
  Object.assign(cap, { choosing: false, moving: null });
  page.focus = '#capture-input';
  redraw();
}

/** Opens the list to send a thought kept for later to a folder. */
const sendOn = (id: string) => ((cap.moving = id), choose(true));

/** The arrows move from the field through the destinations under it and back; Return in the field takes the first,
 *  the browser's Enter and Space press a row; Escape leaves everything as it was. Left and Right stay the field's. */
function arrows(e: KeyboardEvent) {
  if (e.key === 'Escape') return (e.preventDefault(), e.stopPropagation(), choose(false));
  const list = e.currentTarget as HTMLElement, field = list.querySelector<HTMLInputElement>('#cap-find');
  const items = [...list.querySelectorAll<HTMLElement>('button')];
  if (e.target === field && e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    e.stopPropagation();
    return items[0]?.click();
  }
  const sideways = e.key === 'ArrowRight' || e.key === 'ArrowLeft';
  const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
  if (!step || (sideways && e.target === field)) return;
  e.preventDefault();
  e.stopPropagation();
  const all = field ? [field, ...items] : items;
  const at = all.indexOf(document.activeElement as HTMLElement);
  all[(at + step + all.length) % all.length]?.focus({ focusVisible: true });
}

/** The open folders, the one a thought last went to first, and the Scratchpad. */
function recent() {
  const last = new Map<string, number>();
  for (const t of records.thoughts.values()) if (t.project_id) last.set(t.project_id, Math.max(last.get(t.project_id) ?? 0, t.updated));
  // The Scratchpad last: a thought goes there only when the person chooses it, so it is there to choose.
  return projects().sort((a, b) => Number(a.kind === 'scratch') - Number(b.kind === 'scratch') || (last.get(b.id) ?? 0) - (last.get(a.id) ?? 0) || a.name.localeCompare(b.name));
}

/** The list the chip opens, in the Composer's row (docs/projects-design.md, the owner's decisions of 2026-11-19 and
 *  2026-11-21): only what is in use, Auto, the open folders, the Scratchpad and For later (place.ts `rows`), under a
 *  field that finds any project Tasktap knows, by its names or the line about it. A project not open appears only as
 *  an answer: to what is typed in the field or, with a thought already written, as the places (three at most) its words
 *  name or describe, first; none when they point at none, and never one only because it was worked on lately. Never a
 *  row of every folder, and nothing "more" to page through: the field reaches the rest. In the notch it is three rows of
 *  each. */
function Places({ w, later, raised, hooks }: { w: ReturnType<typeof where>; later: boolean; raised: boolean; hooks: Hooks }) {
  const typed = cap.find.trim(), asked = typed || (cap.moving ? '' : cap.draft.trim());
  const answers = asked && cap.found?.text === asked && cap.found.thought === !typed ? cap.found.list : [];
  const most = raised ? 6 : 3;
  const id = (f: Found) => ('project' in f.to ? f.to.project : 'card' in f.to ? f.to.card : '');
  const shown = answers.filter((f) => id(f)).slice(0, typed ? most : 3);
  // The Scratchpad is there to choose also when it was put away (closed): choosing it opens it.
  const put = [...records.projects.values()].filter((p) => p.kind === 'scratch' && !p.open);
  const list = rows({ found: shown.map((f) => ({ id: id(f), name: f.name, why: f.why, fresh: 'card' in f.to })), open: [...recent(), ...put].filter((p) => !shown.some((f) => id(f) === p.id)),
    typed: !!typed, moving: !!cap.moving, most });
  const on = (to: string) => !cap.moving && (to === 'later' ? later : to ? to === w.to : w.by === 'router' && !w.to);
  return (
    <div key="list" class="cap-row cap-list" role="listbox" aria-label={cap.moving ? 'Send the task to' : 'Where the task goes'} data-keys onKeyDown={arrows}
      // A row pressed keeps the keyboard in the field. A button takes none in WebKit (the Mac's web view): the field lost
      // it, the list closed under the pointer, and the click on "Open another folder…" or a project never landed.
      onMouseDown={(e) => !(e.target as HTMLElement).closest('input') && e.preventDefault()}
      onFocusOut={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && cap.choosing && ((cap.choosing = false), (cap.moving = null), redraw())}>
      <label class="cap-find">
        <I n="search" />
        <input id="cap-find" autocomplete="off" spellcheck={false} aria-label="Find a project" placeholder="Find a project" value={cap.find}
          onInput={(e) => {
            cap.find = e.currentTarget.value;
            const find = cap.find.trim();
            ask(find || (cap.moving ? '' : cap.draft.trim()), find ? most : 3, !find);
            redraw();
          }} />
        <Key k="esc" cap />
      </label>
      {/* Nothing found for what is typed: then the list is only Open another folder…, under this line. */}
      {typed && !shown.length && <p class="cap-none">{cap.found?.text === typed && !cap.found.thought ? 'No project by that name.' : 'Looking…'}</p>}
      {list.map((r) => (r.to === 'add'
        ? <button type="button" onClick={() => void addProject(hooks)}>{icon(r.mark)}<span>{r.name}</span></button>
        : <button type="button" role="option" aria-selected={on(r.to)} data-to={r.to} onClick={() => pick(r.to)}>{icon(r.mark)}<span>{r.name}</span>{r.dim.map((d) => <em>{d}</em>)}</button>))}
    </div>
  );
}
/** A row's or the chip's icon (place.ts), For later's being its mark. */
const icon = (m: Icon) => (m === 'later' ? <Mark s="later" label="" /> : <I n={m} />);

// ——— Voice ———

// A new thought when it is spoken into an empty Composer: captured as typing and Return would have, so it names its
// place the same way. Anything else is words for the field: one that holds text, a reply, a thought taken back.
setAim((field): DictationTarget => {
  if (field?.id !== 'capture-input' || field.value.trim() || cap.undone) return { kind: 'text' };
  const w = where(), id = uuid7();
  const by = cap.agent;
  Object.assign(cap, { sent: { id, text: '', to: w.to, pick: picked(), agent: by }, spoken: id, dest: undefined, agent: undefined, refused: '', back: picked() });
  return { kind: 'thought', id, text: '', strokes: [], source: 'voice', ...named(w), ...(by ? { agent: by } : {}) };
});

/** After every change of the records (each page calls it): heard words go to their field, and a spoken thought that
 *  never came to be (cancelled, failed, or ended as words to edit first) leaves nothing said of it: the place and the
 *  agent picked for it are the field's again. */
export function followSpeech() {
  follow();
  lostModel();
  if (!cap.spoken) return;
  if (records.thoughts.has(cap.spoken)) cap.spoken = '';
  else if (!talk.id && !talk.asking) {
    const was = cap.sent?.id === cap.spoken ? cap.sent : null;
    Object.assign(cap, { spoken: '', ...(was && { sent: null, dest: cap.dest ?? was.pick, agent: cap.agent ?? was.agent }) });
  }
}

/** A thought the core placed by name because its placing tool no longer offers its model (core route.rs `gone`): that
 *  tool is no placing model any more, and the core's terms no longer list it, so the chip says what is true; asked
 *  again once per such thought. */
const lostSeen = new Set<string>();
function lostModel() {
  const lost = [...records.thoughts.values()].find((t) => !lostSeen.has(t.id) && t.route?.fallback?.includes('no longer offers the model Tasktap asks for placing'));
  if (!lost) return;
  lostSeen.add(lost.id);
  void loadTerms();
}

/** Whether this page's dictation is for the Composer's field rather than a reply's. */
const here = () => !talk.field || talk.field.id === 'capture-input';

/** What a dictation is doing, in a word. */
const hears = (d: Dictation | undefined) => (d?.phase === 'transcribing' ? 'Writing it down…' : d ? 'Listening' : 'Opening the microphone…');

/** The row while the person speaks and while their words are written down: the mark as loud as the voice, how long it
 *  has run once that matters, what letting go does, the key that ends a new thought as words to edit first (E), the
 *  way out, and the key that ends a recording a click keeps on. */
function Hearing({ d, raised, said }: { d: Dictation | undefined; raised: boolean; said: boolean }) {
  const writing = d?.phase === 'transcribing';
  useEffect(() => {
    if (writing) return undefined;
    const timer = setInterval(redraw, 1000);
    return () => clearInterval(timer);
  }, [writing]);
  const time = d && !writing ? clock((Date.now() - madeAt(d.id)) / 1000, 300) : '';
  return (
    <div class="cap-row hear" role="status" data-phase={d?.phase ?? 'opening'}>
      {writing ? <Mark s="working" label="" /> : raised && <Level l={(d?.level ?? 0) / 100} />}
      {!said && <b>{hears(d)}</b>}
      {time && <time>{time}</time>}
      {/* What is written down while the person speaks on (speech on this Mac): the last of it. */}
      {!writing && d?.text && <span class="hear-t">{d.text.slice(-90)}</span>}
      <span class="hear-x">{!writing && !talk.latched && d && (talk.kind === 'thought' ? 'Let go to send' : 'Let go to add it')}</span>
      {!writing && d && talk.kind === 'thought' && <button type="button" class="act" onClick={() => end(true)}><Key k="E" cap /><span>Edit first</span></button>}
      <button type="button" class="act" onClick={cancel}><Key k="esc" cap /><span>Cancel</span></button>
      {!writing && talk.latched && <button type="button" class={`key${raised ? ' lg' : ''}`} onClick={() => end()}><I n="ret" /><span>Done</span></button>}
    </div>
  );
}

// ——— On its way ———

/** The hold as a line that runs out: as long as what is left, from the share that is left, by the clock and not by
 *  frames. It starts again when the core moves the hold's end, and stands whole while that end is still open. */
function Hold({ t }: { t: Thought }) {
  const h = useMemo(() => hold(t, Date.now(), wholeHold(t, pref('hold'))), [t.hold_until, t.route?.pending]);
  return <i class="way-hold" key={t.hold_until ?? 0} data-open={!h || undefined} style={h ? { '--from': String(h.share), '--ms': `${Math.round(h.ms)}ms` } : undefined} />;
}

/** The thoughts whose line under the Composer was opened to show the rest (`More`): its brief, the person's words and
 *  how it was placed. Closed by default. */
const unfolded = new Set<string>();
/** The rest of a thought's line, behind one quiet disclosure on it: the brief, the person's own words, how it was
 *  placed in full. */
function More({ t }: { t: Thought }) {
  const brief = briefOf(t), note = placed(t, agentName);
  if (!brief && t.source !== 'voice' && !note) return null;
  const on = unfolded.has(t.id);
  const word = brief ? 'Brief' : 'Details';
  return <button type="button" class="way-more" aria-expanded={on} title={word} aria-label={word} onClick={() => (on ? unfolded.delete(t.id) : unfolded.add(t.id), redraw())}><I n="chev" /><span>{word}</span></button>;
}
function Told({ t }: { t: Thought }) {
  const brief = briefOf(t), note = placed(t, agentName);
  if (!unfolded.has(t.id)) return null;
  return (
    <div class="way-told">
      {brief && <p class="way-b"><span>Brief{t.route?.title && <b>{t.route.title}</b>}</span>{brief}</p>}
      {(brief || t.source === 'voice') && <p class="way-w"><span>You said</span>{t.text}</p>}
      {note && <p class="way-n">{note}</p>}
    </div>
  );
}

/** What the decision line knows of the places it names. */
const names: Names = { project: projectName, session: sessionName, of: (id) => records.sessions.get(id)?.project_id };
/** The decision's other places (way.ts `offers`): the newest thought on its way, its keys 2 and 3 while the field is
 *  empty, as the question at the Composer has its digits. */
const offersNow = () => {
  const t = waiting();
  return t && step(t) === 'held' ? offers(t, names) : [];
};
const placeAnew = (t: Thought, to: Parameters<typeof placeOf>[0]) => void call('thought.update', { id: t.id, ...placeOf(to) }).catch(fail);
/** When a decision's keys count from, by its thought and its place: as the question at the Composer's, 600 ms after it
 *  came and after the last key pressed before it came (`QUIET`), so a new thought begun with "2" or "3" is the field's.
 *  A key the person pressed on the decision places it anew at once; the next decision counts again. */
const decidedAt = new Map<string, number>();
const readyAt = (t: Thought) => {
  const id = `${t.id} ${t.session_id ?? t.project_id ?? t.card_id}`;
  let at = decidedAt.get(id);
  if (at === undefined) decidedAt.set(id, (at = Math.max(performance.now(), keyTimes.last) + QUIET));
  return at;
};
function offerKey(e: KeyboardEvent): boolean {
  const t = waiting(), o = offersNow().find((x) => x.key === e.key);
  if (!t || !o || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || performance.now() < readyAt(t)) return false;
  e.preventDefault();
  decidedAt.set(`${t.id} ${placeOf(o.to).project_id ?? placeOf(o.to).session_id ?? placeOf(o.to).card_id}`, 0);
  placeAnew(t, o.to);
  return true;
}

/** The words beside a decision that give way where its line is short of room, in their order (the coordinator's
 *  round 3): the disclosure's, Undo's, the other place's. */
const GIVES = [':scope > .way-more', ':scope > .act[data-undo]', ':scope > .act[data-offer]'];
/** Fits a decision line to its room with no word cut: each word that gives way goes whole, leaving its chevron or its
 *  key cap, its word the tooltip and the name (`data-bare`, way.css). A button whose cap is not shown now (the field
 *  holds words, or has not the keyboard) keeps its word: it would have nothing left. A decision still longer than its
 *  room then takes a second line (`data-wrap`), never an ellipsis. */
function give(h: HTMLElement) {
  const parts = GIVES.flatMap((s) => [...h.querySelectorAll<HTMLElement>(s)]), to = h.querySelector<HTMLElement>(':scope > .way-to');
  for (const p of parts) p.removeAttribute('data-bare');
  h.removeAttribute('data-wrap');
  const short = () => h.scrollWidth > h.clientWidth + 0.5 || (!!to && to.scrollWidth > to.clientWidth + 0.5);
  for (const p of parts) {
    if (!short()) return;
    const handle = p.querySelector<HTMLElement>(':scope > .i, :scope > kbd.keycap');
    if (handle && handle.getBoundingClientRect().width > 0) p.setAttribute('data-bare', '');
  }
  if (short()) h.setAttribute('data-wrap', '');
}

/** A thought on its way, with the way to take it back. The newest is `open`: one line (NOTES §13, the review's R12),
 *  its decision (design §8): the project's name and, in the muted tone, how the task goes there ("continuing" or "new
 *  run"), never cut; the other places on their keys (the other way of going, or the places a model was torn between);
 *  the rest behind one quiet disclosure; and Undo. Where the line is short the words beside the decision go whole
 *  (`give`). The session a follow-up continues has a line of its own under it, two lines at most. One that waits for a
 *  key (`waits`: no time runs) says Return's key first. Any other is its first line. */
function Going({ t, open }: { t: Thought; open: boolean }) {
  const at = step(t), d = decided(t, names), keys = open && at === 'held' ? offers(t, names) : [], rows = keys.length > 1;
  if (keys.length) readyAt(t);
  // Fitted when what the line says changes, as its width does, as its keys' caps come and go (the field gains or
  // loses the keyboard, or words), and once the fonts are in; on no other render.
  const line = useRef<HTMLParagraphElement>(null);
  const says = [at, open, d.name, d.how, waits(t), t.card_id, briefOf(t) ? 1 : 0, !cap.draft, ...keys.map((o) => o.label)].join('\n');
  useLayoutEffect(() => {
    const h = line.current;
    if (!h) return undefined;
    const room = () => give(h);
    room();
    const sized = new ResizeObserver(room), held = new MutationObserver(room);
    sized.observe(h);
    const keyed = h.closest('[data-keys]');
    if (keyed) held.observe(keyed, { attributes: true, attributeFilter: ['data-held'] });
    void document.fonts?.ready.then(room);
    return () => (sized.disconnect(), held.disconnect());
  }, [says]);
  return (
    <section class="way" data-step={at} data-thought={t.id} aria-label="On its way">
      <Hold t={t} />
      <p class="way-h" ref={line}>
        {at === 'placing' ? <><Mark s="working" label="" /><b>Placing…</b></> : (
          <>{open && waits(t) ? <Key k="↩" cap /> : <I n={t.session_id ? 'term' : 'arrow'} />}
            <span class="way-to"><b>{d.name}</b> <em>{d.how}</em></span>
            {t.card_id && <em class="way-new">new here</em>}</>
        )}
        {at === 'briefing' && <em>Writing the brief…</em>}
        {open && at !== 'placing' && <More t={t} />}
        {!rows && keys.map((o) => <button type="button" class="act" key={o.key} data-offer={o.key} title={o.title} aria-label={o.label} onClick={() => placeAnew(t, o.to)}>{!cap.draft && <Key k={o.key} cap />}<span>{o.label}</span></button>)}
        {/* ⌘Z is the field's own undo while it holds words: then the cap is not shown. */}
        <button type="button" class="act" data-undo title="Undo" aria-label="Undo" onClick={() => void undo(t)}>{!cap.draft && <Key k="⌘Z" cap />}<span>Undo</span></button>
      </p>
      {at !== 'placing' && d.session && <p class="way-s" data-waits={(open && waits(t)) || undefined}>{d.session}</p>}
      {/* Two other places: as the question's rows, each on its key, in the decision's words. */}
      {rows && (
        <div class="qa rows">
          {keys.map((o) => <button type="button" class="ans" key={o.key} data-offer={o.key} title={o.title} onClick={() => placeAnew(t, o.to)}>{!cap.draft && <Key k={o.key} cap />}<span>{o.words.name}</span><i>{o.words.how}</i></button>)}
        </div>
      )}
      {open && <Told t={t} />}
    </section>
  );
}

/** A dictation that failed: the core's sentence as it is, what was heard so it can be used, and the way out. */
function Failed({ d }: { d: Dictation }) {
  const dismiss = () => (d.id === talk.id ? cancel() : void call('dictation.cancel', { id: d.id }).catch(fail));
  return (
    <section class="way failed" role="alert" data-dictation={d.id}>
      <p class="way-h"><Mark s="failed" label="" /><b>{d.error ?? 'It could not be written down'}</b>
        {d.text && <button type="button" class="btn" onClick={() => (place(d.text), dismiss())}>Use these words</button>}
        <button type="button" class="act" onClick={dismiss}><Key k="esc" cap /><span>Dismiss</span></button>
      </p>
      {d.text && <p class="way-w"><span>Heard</span>{d.text}</p>}
    </section>
  );
}

/** How long the Composer says where a thought started, and which thought it last said it of. */
const SAID_FOR = 6000;
let told = { id: '', at: 0 };
function Way({ hooks, raised }: { hooks: Hooks; raised: boolean }) {
  const sent = cap.sent?.id === cap.spoken ? null : cap.sent;
  // Voice that is not set up yet: the microphone leads to where it is set up (Setup's step on Home), rather than a
  // sentence under the Composer, which is the thought's alone.
  useEffect(() => {
    if (talk.said !== 'service' || !hooks.speech) return;
    talk.said = '';
    hooks.speech();
  });
  const t = sent ? records.thoughts.get(sent.id) : undefined;
  const all = going();
  const failed = [...records.dictations.values()].filter((d) => d.phase === 'failed');
  // Cleared the moment this Composer's sheet goes (a layout effect's end), never after the next frame: a sheet put
  // away and another opened in the same frame as it is due would be closed by the timer of the one before.
  useLayoutEffect(() => {
    if (t?.phase !== 'working' || cap.draft || !hooks.started) return undefined;
    const timer = setTimeout(hooks.started, 1600);
    return () => clearTimeout(timer);
  });
  const line = (words: ComponentChildren, more?: ComponentChildren) => <p class="cap-said" role="status"><span>{words}</span>{more}</p>;
  const at = step(t);
  // Where a thought started is said once, for a few seconds: after that its row says it, and nothing stands under the
  // Composer. (What still needs the person stays: a question, a failure, why it waits, and Undo while it can be undone.)
  const began = at === 'started' && sent ? (told.id === sent.id ? told : (told = { id: sent.id, at: Date.now() })).at : 0;
  const fresh = began > 0 && Date.now() - began < SAID_FOR;
  useEffect(() => {
    if (!fresh) return undefined;
    const timer = setTimeout(redraw, began + SAID_FOR - Date.now() + 20);
    return () => clearTimeout(timer);
  }, [fresh, began]);
  // Why it waits for later; where the person did not put it there themselves, that it does.
  const later = t ? `${laterWhy(t, agentName)}${t.placed === 'kept' || t.placed === 'kept_answer' ? '' : '; saved for later'}` : '';
  return (
    <div class={`ways${raised ? ' under' : ''}`}>
      {failed.map((d) => <Failed key={d.id} d={d} />)}
      {cap.refused && <section class="way failed" role="alert"><p class="way-h"><Mark s="failed" label="" /><b>{cap.refused}</b></p></section>}
      {talk.said === 'service' && !hooks.speech && line(needs())}
      {talk.said && talk.said !== 'service' && line(talk.said)}
      {all.map((x, i) => <Going key={x.id} t={x} open={i === 0} />)}
      {sent?.to === 'later' && t && line(raised || projects().some((p) => p.kind === 'folder') ? 'Saved for later' : 'Saved for later, until a folder is open',
        <button type="button" class="act" onClick={() => void undo('later')}>{!cap.draft && <Key k="⌘Z" cap />}<span>Undo</span></button>)}
      {/* Its question, where one is asked, stands at the Composer itself (Asked) or waits in Needs you: nothing here. */}
      {sent && sent.to !== 'later' && t && !onWay(t) && (
        at === 'asked' ? null
          : at === 'later' ? line(later, <>
            <button type="button" class="btn" onClick={() => sendOn(t.id)}>Send to a folder…</button>
            <button type="button" class="act" onClick={() => void undo('later')}>{!cap.draft && <Key k="⌘Z" cap />}<span>Undo</span></button>
          </>)
            : at === 'failed' ? line(`${why(t)} in ${projectName(t.project_id)}.`)
              : fresh ? <>{line(<>Started in <b>{projectName(t.project_id)}</b></>, <More t={t} />)}<Told t={t} /></> : null
      )}
    </div>
  );
}

/** The router's question about the thought this page's Composer sent last (NOTES §13), the one rule for every
 *  Composer (Home's, the New Task sheet's, the notch's capture row): it is asked at the Composer the thought was sent
 *  from, under its field, and nowhere else (Home's Needs you leaves it out), or it waits in Needs you with the rest.
 *  Decided when it is first seen: at the Composer while the field is empty, in Needs you when the next thought was
 *  already begun. It leaves the Composer for Needs you for good as soon as a key types into the field, when the field
 *  is given back (Escape, Tab), and when the Composer it is asked at goes (Home left for a workspace, the sheet put
 *  away). While it is at the Composer and the field is empty, the field's keys answer it: a row's number, the arrows
 *  and Return, which takes the row the arrows are on (the first). Return counts from 600 ms after the question came
 *  and after the last key pressed before it came (`ready`), so a Return pressed twice to send never answers it; a key
 *  pressed on the question itself (an arrow, a digit) is meant, and Return right after it answers (the review's N2).
 *  Every other key is the field's. */
const asked = new Map<string, { at: 'here' | 'away'; since: number; on: number; ready: number; what?: string }>();
/** Whether Return answers the question at the Composer now (and so whether its key is metal, and a click on it acts). */
const answers = (q: Question) => performance.now() >= (asked.get(q.id)?.ready ?? Infinity);
/** The row Return takes, as drawn: when it changes by itself (the core's question changed), Return counts again 600 ms
 *  from then, as from when the question came; the person's own arrow or digit changes it at once (NOTES §13). */
function settle(q: Question, row: ReturnType<typeof chosenRow>) {
  const a = asked.get(q.id), what = `${row.does} ${row.label}`;
  if (!a || a.what === what) return;
  if (a.what !== undefined && !byPerson()) a.ready = Math.max(a.ready, performance.now() + QUIET);
  a.what = what;
}
/** The question asked at a Composer of this page now, if one is. `left`: a Composer went while it asked. */
let shown = '', left = false;
export function atComposer(): Question | undefined {
  const sent = cap.sent;
  const q = sent && openQuestions().find((x) => x.source === 'router' && x.thought_id === sent.id);
  // Answered or gone with the keyboard on it (a row clicked): the keyboard is the field's again, for the next thought.
  const now = document.activeElement;
  if (shown && shown !== q?.id && (!now || now === document.body || now.closest(`[data-question="${shown}"]`))) page.focus = '#capture-input';
  let a = q && asked.get(q.id);
  if (q && !a) {
    const came = performance.now();
    asked.set(q.id, (a = { at: cap.draft.trim() ? 'away' : 'here', since: came, on: 0, ready: Math.max(came, keyTimes.last) + QUIET }));
    // Where nothing has the keyboard, the field takes it, and with it the question's keys.
    if (a.at === 'here' && (!now || now === document.body)) page.focus = '#capture-input';
  }
  shown = q && a?.at === 'here' ? q.id : '';
  return shown && q ? q : undefined;
}
/** Whether a question that just came will be asked at the Composer, before it is drawn (the notch keeps its capture
 *  line for it, rather than opening the question's own view). */
export const toAsk = (q: Question) => q.source === 'router' && !!cap.sent && q.thought_id === cap.sent.id && (asked.get(q.id)?.at ?? (cap.draft.trim() ? 'away' : 'here')) === 'here';
/** The question about the thought just sent while the next one is being typed: it has left the Composer, and the
 *  notch shows it in its own list only once the field is empty again (sent, or its words taken out), so nothing the
 *  person types moves the keyboard (the review's N1). */
export const typedPast = (q: Question) => q.source === 'router' && !!cap.sent && q.thought_id === cap.sent.id && !!cap.draft;
/** A place's name as the key says it: cut after 16 characters (one more where the cut would end on a separator, never
 *  for one character), so "customer-portal-frontend" is "customer-portal-f…" (the review's N5). */
export const keyName16 = (s: string) => (s.length <= 17 ? s : `${s.slice(0, /[-_. ]/.test(s[15]!) ? 17 : 16)}…`);
/** The question leaves the Composer and waits in Needs you; the field keeps the keyboard. */
function away(q: Question | string | undefined) {
  const a = q && asked.get(typeof q === 'string' ? q : q.id);
  if (a) a.at = 'away';
}
/** The row the arrows are on, which Return takes, with the question at the Composer. */
const rowOn = (q: Question) => Math.min(asked.get(q.id)?.on ?? 0, routerRows(q).length - 1);
const chosenRow = (q: Question) => routerRows(q)[rowOn(q)]!;
/** The field's keys while a question is asked at its Composer and it is empty. True: the key was the question's. */
function answerKey(q: Question, e: KeyboardEvent): boolean {
  const a = asked.get(q.id)!, rows = routerRows(q), n = Number(e.key);
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key.length === 1 && n >= 1 && n <= rows.length) rows[n - 1]!.act();
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') a.on = Math.max(0, Math.min(rows.length - 1, a.on + (e.key === 'ArrowDown' ? 1 : -1)));
  else if (e.key === 'Escape' || e.key === 'Tab') away(q);
  else return false;
  e.preventDefault();
  e.stopPropagation();
  redraw();
  return true;
}

/** The Composer. `raised` is Home's: a surface of its own, the thought at 20 px, up to six lines; elsewhere it sits on
 *  its sheet with Tasktap's mark beside the thought, up to three lines. `asks`: the router's question about the thought
 *  just sent is asked here, under the field and on the same surface (Home's or the capture sheet's, never both). */
export function Capture({ raised = false, asks = false, ...hooks }: Hooks & { raised?: boolean; asks?: boolean }) {
  const route = hinted(), w = where();
  const later = w.by === 'later';
  const session = route?.confidence === 'clear' && 'session' in route.to ? route.to.session : undefined;
  // After a thought with a place of its own is sent, the next goes where nobody chose, and the chip says it is back.
  const back = cap.back !== undefined && !!cap.sent && cap.back !== w.to && (w.why === 'model' || w.why === 'in' || w.why === 'only' || w.why === 'words' || w.why === 'ask');
  const chip = chipSays(w, route, back);
  // What Return does, which the key says: with a thought in the field it sends that; with none it starts the one that
  // waits, if one does; and while the last is still on its way to the core and nothing new is typed, it shows that it works.
  const has = !!cap.draft.trim(), now = !has && !!waiting(), busy = !has && cap.sending > 0;
  const d = mine(), service = voiced();
  const hearing = here() && (talk.asking || d?.phase === 'recording' || d?.phase === 'transcribing');
  // In the notch and the sheet the row is narrow, and a spoken new thought's own line is empty: that line says what
  // the dictation is doing, beside the mark that follows the voice, and the row keeps the time, the keys and the way out.
  const said = hearing && !raised && talk.kind === 'thought' && !cap.draft;
  const q = asks ? atComposer() : undefined;
  // With the question at the Composer the key does what Return does, and says so: the row the arrows are on.
  const row = q && !cap.draft ? chosenRow(q) : undefined;
  if (q && row) settle(q, row);
  // A place (a project, the Scratchpad) starts the task there; a session is sent the task.
  const into = row?.does === 'place' || row?.does === 'scratch';
  const does = row ? (into ? `Start in ${row.label}` : row.does === 'session' ? `Send to ${row.label}` : row.label)
    : now ? 'Start' : later ? 'Save for later' : session ? 'Send' : 'Start';
  // On the key the place is cut short, and where the foot has no room for it the key says only what it does (`.k-in`
  // goes, parts.css); the row the arrows are on says where. Quiet until Return answers, metal from then on.
  const verb = row && (into || row.does === 'session') ? (into ? 'Start' : 'Send') : '';
  const waits = !!q && !!row && !answers(q);
  const ready = q ? (asked.get(q.id)?.ready ?? 0) : 0;
  useEffect(() => {
    if (!waits) return undefined;
    // Drawn metal the moment Return acts (a timer may fire a little early by the page's clock: then once more).
    let t = 0;
    const lit = () => (performance.now() >= ready ? redraw() : (t = window.setTimeout(lit, ready - performance.now() + 1)));
    t = window.setTimeout(lit, Math.max(0, ready - performance.now()) + 1);
    return () => clearTimeout(t);
  }, [waits, ready]);
  // A Composer that goes while it asks (Home left, the sheet put away) leaves its question in Needs you; back on Home,
  // the field has the keyboard (the review's R5), not the question that waits there.
  const asking = useRef('');
  asking.current = q?.id ?? '';
  useLayoutEffect(() => () => void (asking.current && (away(asking.current), (left = true))), []);
  useLayoutEffect(() => void (raised && left && ((left = false), (page.focus = '#capture-input'))), []);
  // The field is as high as its words, a line at a time. It is measured when they change, typed or put there, or its
  // width or the text size does (set on the page's root once the core has said it, or the person changed it), and on
  // no other render: a measure makes the page lay itself out there and then.
  const area = useRef<HTMLTextAreaElement>(null), fitted = useRef({ text: '', width: -1, size: '' });
  const fit = (width = fitted.current.width) => {
    const el = area.current!, size = document.documentElement.dataset.text ?? '';
    if (el.value === fitted.current.text && width === fitted.current.width && size === fitted.current.size) return;
    fitted.current = { text: el.value, width, size };
    el.style.height = '0';
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(() => fit());
  // The foot where it is short of room, in this order (NOTES §13): the chip's "Auto" after a place gives way first, by
  // itself (parts.css); then the microphone's key hint is dropped, once that word is gone and only where that gives the
  // names room; then the names are cut short, the place's and the agent's. Nothing wraps; the key never moves.
  // Measured when the foot's width or what the chip, the agent and the key say change, and on no other render.
  const foot = useRef<HTMLDivElement>(null), runs = chosen(session).a?.id;
  useLayoutEffect(() => {
    const row = foot.current;
    if (!row) return undefined;
    const room = () => {
      const place = row.querySelector<HTMLElement>('#dest-chip b'), reason = row.querySelector<HTMLElement>('#dest-chip span'), who = row.querySelector<HTMLElement>('.cap-agent .nm');
      if (!place) return;
      const cut = (el: HTMLElement | null) => !!el && el.scrollWidth > el.clientWidth + 0.5;
      const over = () => row.scrollWidth > row.clientWidth + 0.5;
      row.removeAttribute('data-short');
      row.removeAttribute('data-bare');
      row.removeAttribute('data-tight');
      // The word is whole or not there: one that would be cut ("Au…") goes, whole (the review's R8).
      if (!cut(reason) && !cut(place) && !over()) return;
      row.setAttribute('data-bare', '');
      // Then the key hints, the microphone's and the agent control's, where a name is still cut without them.
      if (cut(place) || cut(who) || over()) row.setAttribute('data-short', '');
      // Then the place on the key (the review's N5): the key says only what Return does, and the chip has the room.
      if (row.querySelector('.key .k-in') && (cut(place) || over())) row.setAttribute('data-tight', '');
    };
    room();
    const watch = new ResizeObserver(room);
    watch.observe(row);
    return () => watch.disconnect();
  }, [chip.name, chip.auto, does, busy, hearing, cap.choosing, cap.agents, runs, waits]);
  // The line rolls while this field may (lines.ts `rolls`): told on every render, as the field gains or loses the
  // keyboard, as the window does, and as Reduce Motion changes; the field gone, its roll goes with it.
  const sync = () => invite.run(rollsHere(area.current), area.current);
  useLayoutEffect(sync);
  useLayoutEffect(() => {
    const motion = matchMedia('(prefers-reduced-motion: reduce)'), field = area.current;
    addEventListener('focus', sync);
    addEventListener('blur', sync);
    document.addEventListener('visibilitychange', sync);
    motion.addEventListener('change', sync);
    return () => {
      removeEventListener('focus', sync);
      removeEventListener('blur', sync);
      document.removeEventListener('visibilitychange', sync);
      motion.removeEventListener('change', sync);
      composing = false;
      invite.stop(field);
    };
  }, []);
  useLayoutEffect(() => {
    const watch = new ResizeObserver(([e]) => fit(e!.contentRect.width));
    watch.observe(area.current!);
    const sized = new MutationObserver(() => fit());
    sized.observe(document.documentElement, { attributes: true, attributeFilter: ['data-text'] });
    return () => (watch.disconnect(), sized.disconnect());
  }, []);
  return (
    <form class={`capture${raised ? ' raised' : ''}${cap.draft ? ' has' : ''}${q ? ' asks' : ''}`} aria-busy={cap.sending > 0} data-keys
      onSubmit={(e) => (row && q ? (e.preventDefault(), answers(q) && row.act()) : void send(e, hooks))}
      onKeyDown={(e) => {
        // ⌘Z takes back what this Composer sent, wherever the keyboard is in it, unless a field with words has it:
        // then it is that field's own undo (and Undo shows no cap).
        const target = e.target as HTMLElement;
        if (hit('⌘Z', e) && !cap.draft && (!target.matches('input, textarea') || target.id === 'capture-input') && (cap.sending || going().length || kept())) {
          e.preventDefault();
          void undo();
        } else if (hit(AGENT_KEY, e) && !chosen(session).fixed && !hearing) {
          // Who runs it, from anywhere in the Composer (the agent control's key).
          e.preventDefault();
          openAgents(!cap.agents);
        }
      }}>
      <div class="cap" onPointerDown={(e) => e.target === e.currentTarget && (e.preventDefault(), focus('#capture-input'))}>
        {!raised && (hearing && d?.phase === 'recording' ? <Level size={28} l={d.level / 100} /> : <Brand size={28} live={cap.sending > 0} />)}
        <textarea id="capture-input" ref={area} rows={1} autocomplete="off" spellcheck={false} aria-label="New task" placeholder={said ? hears(d) : invite.line} data-lines={said ? undefined : ''}
          value={cap.draft}
          onFocus={sync} onBlur={sync}
          onCompositionStart={() => ((composing = true), sync())} onCompositionEnd={() => ((composing = false), sync())}
          onInput={(e) => {
            const first = !cap.draft.trim();
            cap.draft = e.currentTarget.value;
            // The first letter: the line is gone at once, never left half rolled.
            if (cap.draft) invite.run(false, e.currentTarget);
            if (!cap.draft.trim()) cap.refused = '';
            fit();
            if (cap.undone && !cap.draft.trim()) drop();
            askRoute();
            // A key that types leaves the question to Needs you, at once: what it typed is the next thought's.
            if (q && cap.draft) return (away(q), redraw());
            // The first of a thought: the key says at once what Return now does.
            if (first) redraw();
          }}
          onKeyDown={(e) => {
            // Return sends, once however long it is held, and Shift-Return starts a new line; or, as the person set it
            // (`return_sends`), Return starts a new line and Command-Return sends (Control-Return off the Mac).
            const sends = e.key === 'Enter' && !e.isComposing && (pref('return_sends') ? !e.shiftKey : e.metaKey || e.ctrlKey);
            if (q && !cap.draft) {
              if (sends) return (e.preventDefault(), !e.repeat && answers(q) && chosenRow(q).act());
              if (answerKey(q, e)) return;
            }
            // The decision's other places, on their keys while the field is empty.
            if (!q && !cap.draft && offerKey(e)) return;
            if (sends) e.repeat ? e.preventDefault() : void send(e, hooks);
            else if (hit('⌘K', e)) {
              // The list, from the field: where it goes, chosen without the pointer.
              e.preventDefault();
              choose(true);
            }
          }} />
        {cap.choosing ? (
          // The choice has the field's row to itself, so it covers nothing the person is reading. Return then picks, so
          // the key that sends is away until one is picked. An element of its own (`key`), never the chip's: the chip
          // had the keyboard, and losing it as the list took the chip's place would close the list again where the
          // engine says so (Chromium, so Windows). The list takes the keyboard; Escape and a choice give it back to the
          // field. Opened from a kept thought's line, it sends that one.
          <Places w={w} later={later} raised={raised} hooks={hooks} />
        ) : cap.agents ? <AgentList signIn={hooks.agents} /> : hearing ? <Hearing d={d} raised={raised} said={said} /> : (
          // The foot: where it goes, who runs it, the microphone, and the key that says what Return does, in that order.
          <div key="foot" class="cap-row" ref={foot}>
            <button type="button" class="cap-to" id="dest-chip" aria-haspopup="listbox" aria-expanded={false} data-starting={w.why === 'starting' || undefined}
              title={chip.title} onClick={() => choose(true)}
              onKeyDown={(e) => (e.key === 'ArrowDown' || e.key === 'ArrowUp') && (e.preventDefault(), e.stopPropagation(), choose(true))}>
              {/* One name; after a place Auto found, the word Auto, dim. The space between is no gap on the screen (a flex
                  row draws no blank between its items) and the chip's name for VoiceOver ("cuegrid Auto"). */}
              {icon(chip.mark)}
              <b>{chip.name}</b>{chip.auto && ' '}{chip.auto && <span>Auto</span>}
              <I n="chev" />
            </button>
            <AgentControl session={session} />
            <button type="button" class="mic" data-off={(core.in && !service) || undefined} aria-label="Talk"
              title={!core.in ? undefined : service ? `Hold to talk, or hold ${keyName(talkKey())}. A click keeps it on until the next` : 'Voice needs setting up first'}
              onPointerDown={(e) => control.down(e, area.current)} onClick={(e) => control.key(e, area.current)}>
              <span><I n="mic" /></span><Key k={keyName(talkKey())} />
            </button>
            {/* The metal key always, also with nothing to do (NOTES §13): Home's one key, and the Composer's in the notch
                and the capture sheet. Its arrow is in the key's own ink (its class was `sends` once, which the placing
                sheet's list of what it sends also is, and took that list's pale colour). */}
            <button type="submit" class={`key${raised ? ' lg' : ''}`} disabled={!has && !now && !busy && !row} aria-busy={busy || undefined} data-waits={waits || undefined} title={row ? `The answer Return gives: ${row.label}` : now ? 'Start it now' : undefined}>
              {busy ? <Mark s="working" label="" /> : <i class="key-ret">{!pref('return_sends') && spell('⌘↩').replace('↩', '')}<I n="ret" /></i>}
              <span>{verb ? <>{verb}<span class="k-in">{` ${verb === 'Start' ? 'in' : 'to'} ${keyName16(row!.label)}`}</span></> : does}</span>
            </button>
          </div>
        )}
        {q && <Ask q={q} size="cap" class="cap-ask" on={row ? rowOn(q) : undefined} />}
      </div>
      <Way hooks={hooks} raised={raised} />
    </form>
  );
}
