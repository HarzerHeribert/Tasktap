// From the records to what is shown of a thought on its way and of speech, as plain functions (way.test.ts): the step
// a thought is at between capture and start, its brief when that says the words differently, how much of its hold is
// left, how it came by its place and why it waits in For later (the core's own word for each, `placed`), whether placing
// by a model is on, what a ring says of its agent,
// the time a recording shows, where heard words go in a field, and what a field holds while its thought is sent. The
// pages draw these and decide nothing themselves.
import type { ChatGpt, PlaceTool, RouteBy, Thought } from '../../core/proto/protocol.ts';

/** The two letters of an agent the app has no mark for, from its id, which is what a person types to start it: the
 *  initials of its first two words, or the first two letters of its one. */
export const letters = (id: string) => {
  const w = id.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return w.length > 1 ? (w[0]![0]! + w[1]![0]!).toUpperCase() : (w[0] ?? '?').slice(0, 2).replace(/^./, (c) => c.toUpperCase());
};
/** The letters of each of `ids`, no two alike: two, or the `one` a ring too small for two shows. They are taken in
 *  the order given, the core's: where an agent's own are taken by one before it, it keeps its first letter and takes
 *  the next letter of its id that makes a pair still free (as one letter: its next letter that is free); with none
 *  free it shows its own, twice seen. */
export function lettersOf(ids: string[], one = false) {
  const taken = new Set<string>(), all = new Map<string, string>();
  for (const id of ids) {
    const two = letters(id), own = one ? two[0]! : two, rest = [...id.replace(/[^\p{L}\p{N}]/gu, '')].slice(1);
    const free = taken.has(own) ? rest.map((c) => (one ? c.toUpperCase() : own[0] + c.toLowerCase())).find((mark) => !taken.has(mark)) : own;
    all.set(id, free ?? own);
    taken.add(free ?? own);
  }
  return all;
}

type T = Pick<Thought, 'phase' | 'status' | 'mode' | 'route' | 'project_id' | 'text' | 'brief' | 'hold_until' | 'created'>;

/** The steps between a capture and its start; null for a thought that is not, or no longer, on its way. */
export type Step = 'placing' | 'briefing' | 'held' | 'asked' | 'later' | 'started' | 'failed';

export function step(t: T | undefined): Step | null {
  if (!t) return null;
  if (t.phase === 'captured') return t.status === 'needs_you' ? 'asked' : t.route?.pending ? 'placing' : t.mode === 'note' ? 'later' : null;
  if (t.phase === 'routed') return t.route?.pending ? 'briefing' : 'held';
  return t.phase === 'failed' ? 'failed' : 'started';
}
/** Placing, briefing or held: Undo still takes it back, and nothing has started. */
export const onWay = (t: T | undefined) => ['placing', 'briefing', 'held'].includes(step(t) ?? '');

const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** The brief, when it says the person's words differently (case, punctuation and spacing aside, as the core compares
 *  them): then both are shown, since both are sent. */
export const briefOf = (t: Pick<Thought, 'text' | 'brief'>) => (t.brief && plain(t.brief) !== plain(t.text) ? t.brief : null);

/** How much of the hold is left at `now`, as a share of all of it (it counts from the capture), and in milliseconds;
 *  null where nothing is held or the end is still open because a brief is being written. */
export function hold(t: T, now: number): { share: number; ms: number } | null {
  if (step(t) !== 'held' || !t.hold_until) return null;
  const ms = Math.max(0, t.hold_until - now), all = Math.max(1, t.hold_until - t.created);
  return { share: Math.min(1, ms / all), ms };
}

/** Why a model was not asked about a thought, as the core said it; none where that was an agreement to older terms
 *  (core route.rs `valid`): that is said once, in Setup's placing step ("Agree again"), not on every thought. */
export const fallback = (t: Pick<Thought, 'route'>) => {
  const f = t.route?.fallback ?? null;
  return f && /^the agreement /.test(f) ? null : f;
};

/** How a thought came by its place, in a few words, from the core's word for it. "Placed by" only where the match on
 *  names or a model placed it. Where the person decided (a pick, a follow-up to the session they were in, an answer to
 *  where it should go) `route` only says who wrote the brief. Why a model was not used is the core's sentence, as it is;
 *  with no word (the asking was cut short) that sentence is all there is to say. */
export function placed(t: Pick<Thought, 'placed' | 'route'>, agent: (id: string) => string): string | null {
  const r = t.route && { ...t.route, fallback: fallback(t) }, who = r && r.by !== 'local' ? `${agent(r.by)}${r.model ? ` · ${r.model}` : ''}` : '';
  switch (t.placed) {
    case 'name':
      // No name was said for certain and one project clearly led: what only it has ("its name and “widgetpack”").
      if (r?.lead) return `${r.lead}${r.fallback ? `. ${r.fallback}` : ''}`;
      return `Placed by name${r?.quote ? `: you said “${r.quote}”` : ''}${r?.fallback ? `. ${r.fallback}` : ''}`;
    case 'model':
      return `Placed by ${who || 'a model'}${r?.quote ? `, because you said “${r.quote}”` : ''}`;
    case 'picked':
    case 'follow_up':
    case 'answer':
      return r?.fallback ? `Sent in your words. ${r.fallback}` : who ? `Brief by ${who}` : null;
    default:
      return r?.fallback ?? null;
  }
}

/** Who placed a thought, in the few words of its one line under the Composer ("Starting in cuegrid · placed by Claude
 *  Code · Undo", NOTES §13); the whole of it (`placed`) is behind that line's disclosure. */
export function placedBy(t: Pick<Thought, 'placed' | 'route'>, agent: (id: string) => string): string {
  switch (t.placed) {
    case 'model':
      return `placed by ${t.route && t.route.by !== 'local' ? agent(t.route.by) : 'a model'}`;
    case 'name':
      return 'named in it';
    case 'picked':
      return 'your choice';
    case 'answer':
      return 'you chose it';
    default:
      return '';
  }
}

/** Why a thought waits in For later: the core's four reasons, in plain words. */
export function laterWhy(t: Pick<Thought, 'placed' | 'route'>, agent: (id: string) => string): string {
  switch (t.placed) {
    case 'kept':
      return 'You saved it for later';
    case 'kept_answer':
      return 'You kept it for later';
    case 'kept_name':
      return 'It named no folder';
    case 'kept_model':
      return `${agent(t.route?.by ?? '')} found no folder for it`;
    default:
      return 'Saved for later';
  }
}

/** An agent that can place thoughts, with the version of the terms it would be asked under (page.ts `placers`). */
type Tool = PlaceTool & { terms: number };

/** Placing by the person's agents: off (none agreed to, or every one switched off), on (one at least that can place
 *  now is switched on), or agreed to once for something this Tasktap no longer asks (`again`): other terms, or only
 *  models it asks no more. */
export function placing(by: RouteBy | null | undefined, tools: Tool[]): 'off' | 'on' | 'again' {
  if (!by) return 'off';
  // An agreement to what was sent before (`terms`, the version of what is sent and to whom) is asked for again.
  if (tools.length && tools.some((t) => t.terms !== by.terms)) return 'again';
  const on = by.agents.filter((p) => p.on);
  if (!on.length) return 'off';
  if (on.some((p) => tools.some((t) => t.agent === p.agent && t.model === p.model))) return 'on';
  return on.some((p) => tools.some((t) => t.agent === p.agent)) ? 'again' : 'off';
}

/** The first agent the person lets place thoughts that can now: the one that is asked first. */
export const first = (by: RouteBy | null | undefined, tools: Tool[]) =>
  by?.agents.find((p) => p.on && tools.some((t) => t.agent === p.agent && t.model === p.model && t.terms === by.terms))?.agent;

/** One row of the placing group: an agent that can place, and whether the person lets it. */
export type Rank = { agent: string; model: string; on: boolean };

/** The rows of the placing group: the agents of the agreement that can place now, in its order, each as it is
 *  switched; then the others that can, in Tasktap's order, off where there is an agreement (it was not given for
 *  them) and on where there is none yet (all of them are what is proposed). Each with the model Tasktap asks now. */
export function ranked(by: RouteBy | null | undefined, tools: PlaceTool[]): Rank[] {
  const tool = (agent: string) => tools.find((t) => t.agent === agent);
  const listed = (by?.agents ?? []).filter((p) => tool(p.agent)).map((p) => ({ agent: p.agent, model: tool(p.agent)!.model, on: p.on }));
  const rest = tools.filter((t) => !listed.some((p) => p.agent === t.agent)).map((t) => ({ agent: t.agent, model: t.model, on: !by }));
  return [...listed, ...rest];
}

/** Tasktap's order for the rows: the order `route.terms` proposes, each kept as it is switched. */
export const proposed = (rows: Rank[], tools: PlaceTool[]) =>
  [...rows].sort((a, b) => tools.findIndex((t) => t.agent === a.agent) - tools.findIndex((t) => t.agent === b.agent));

/** The rows with the one at `from` moved to `to`. */
export function moved(rows: Rank[], from: number, to: number): Rank[] {
  const next = [...rows], at = Math.max(0, Math.min(rows.length - 1, to));
  const [row] = next.splice(from, 1);
  if (row) next.splice(at, 0, row);
  return next;
}

/** Each row's place among those switched on, from 1; none for one switched off. */
export const places = (rows: Rank[]) => {
  let n = 0;
  return rows.map((r) => (r.on ? ++n : null));
};

/** The agreement the rows make, to `terms`: the rows in their order, then what was agreed of agents not shown now
 *  (signed out, say) that Tasktap still asks, as it was, with the model it asks now. */
export function agreement(rows: Rank[], by: RouteBy | null | undefined, all: PlaceTool[], terms: number): RouteBy {
  const kept = (by?.agents ?? []).filter((p) => !rows.some((r) => r.agent === p.agent)).flatMap((p) => {
    const t = all.find((x) => x.agent === p.agent);
    return t ? [{ agent: p.agent, model: t.model, on: p.on }] : [];
  });
  return { agents: [...rows, ...kept], terms };
}

/** ChatGPT's row of the placing group, from the core's `chatgpt` preference (core chatgpt.rs): not signed in (`out`:
 *  the button "Sign in with ChatGPT", and why the last sign-in did not finish or ended, where it did), waiting for the
 *  browser (`Cancel`), or signed in (`in`: a row like the others, by the name of the model it asks). */
export function chatgptRow(c: ChatGpt | null | undefined): { state: 'out' | 'waiting' | 'in'; name: string | null; says: string | null } {
  const out = (says: string | null) => ({ state: 'out' as const, name: null, says });
  switch (c?.state) {
    case 'waiting':
      return { state: 'waiting', name: null, says: 'Waiting for the sign-in in your browser…' };
    case 'signed_in':
      return { state: 'in', name: c.name ?? c.model, says: null };
    case 'failed':
      return out(`The sign-in with ChatGPT did not finish: ${(c.error ?? 'no reason was given').replace(/\.+$/, '')}.`);
    case 'no_plan':
      return out('ChatGPT signed you in, but did not allow Tasktap to use your plan. Sign in again and allow the use of your plan.');
    case 'signed_out':
      return out('ChatGPT signed Tasktap out. Sign in with ChatGPT again to keep ChatGPT placing your tasks.');
    default:
      return out(null);
  }
}

/** What the placing sheet says above the button that signs in with ChatGPT, by the model it would ask. */
export const chatgptOffer = (model: string) =>
  `Sign in with ChatGPT and ${model} finds the project for a task in one direct call on your ChatGPT plan. No agent is started for the placing, and each placing counts against your plan like any other use of ChatGPT.`;

/** What Setup's placing step says: by whom tasks are placed (`asks`, then `more`), that the terms changed, that nobody
 *  who could place is signed in (`anyone`: ChatGPT or an agent), that the person skipped it, or what it is for. */
export function placingSays(state: 'off' | 'on' | 'again', asks: string | null, more: number, answered: boolean, anyone: boolean): string {
  if (state === 'on' && asks) return `By ${asks}${more > 0 ? `, then ${more} more` : ''}`;
  if (state === 'again') return 'The terms changed. Agree again to keep it on.';
  if (!anyone) return 'Sign in with ChatGPT, or sign an agent in under Settings › Agents';
  return answered ? 'Skipped' : 'For tasks that name no project';
}

/** Why an agent stands where it does in Tasktap's order, or why it is passed over now: its plan at its usage limit
 *  until a time (`limited`, as the core keeps it; `at` gives the time as the person's clock shows it). */
export function placeWhy(t: PlaceTool, limited: number | null | undefined, now: number, at: (ms: number) => string): string {
  if (limited && limited > now) return `out of quota until ${at(limited)}`;
  const pays = t.pays === 'plan' ? 'included in your subscription' : 'billed by your provider';
  return t.ms ? `${pays} · about ${Math.max(1, Math.round(t.ms / 1000))} s` : pays;
}

/** What an agent's ring says: how many of its thoughts are being worked on, and its state: not signed in, one of
 *  its sessions asks, working, or nothing. A thought that waits for an answer is not counted as working. */
export function ring(
  a: { id: string; signed_in: boolean | null }, thoughts: Iterable<Pick<Thought, 'agent' | 'status' | 'mode'>>, asking: (agent: string) => boolean,
): { n: number; s: '' | 'off' | 'working' | 'asks' } {
  const n = [...thoughts].filter((t) => t.agent === a.id && t.mode !== 'note' && t.status === 'working').length;
  return { n, s: a.signed_in === false ? 'off' : asking(a.id) ? 'asks' : n ? 'working' : '' };
}

/** What an agent's row in Settings says of it: whether it is here and signed in, in the words of what its own
 *  commands said and when (`ago`, how long ago that was). Nothing is shown as known now that was not said now: an
 *  answer a core before this one kept, or one that stands because the agent could not say this time, has its age.
 *  `looking`: the core is asking it right now. An agent whose commands cannot say is never asked. */
export function agentState(
  a: { supported: boolean; installed: boolean; checks: boolean; signed_in: boolean | null; stale: boolean; checked: number }, looking: boolean, ago: string,
): string {
  if (!a.supported) return 'does not run on this system yet';
  if (!a.installed) return 'not installed';
  if (!a.checks) return 'sign-in not checked';
  if (a.signed_in === null) return looking ? 'checking…' : a.checked ? 'sign-in could not be checked' : 'not checked yet';
  return `${a.signed_in ? 'signed in' : 'not signed in'}${a.stale ? ` when last checked, ${ago}` : ''}`;
}

/** The agents the Composer's list offers for a thought (rings.tsx), in the core's order: every one installed and on
 *  this system, also one signed out (its row says so and leads to where it is signed in); with `find`, those whose
 *  name or id has what is typed in it. No row of rings and no "+n": every agent is a row of one list. */
export function listed<A extends { id: string; installed: boolean; supported: boolean }>(agents: A[], name: (a: A) => string, find = ''): A[] {
  const words = find.trim().toLocaleLowerCase();
  const here = agents.filter((a) => a.installed && a.supported);
  if (!words) return here;
  // What is typed is the start of a name first ("co": Codex), then of a word in it (Claude Code), then anywhere in it
  // or in its id; in the core's order within each.
  const rank = (a: A) => {
    const n = name(a).toLocaleLowerCase();
    return n.startsWith(words) ? 0 : n.split(/[\s\-_.]+/).some((w) => w.startsWith(words)) ? 1 : n.includes(words) || a.id.includes(words) ? 2 : 3;
  };
  return here.map((a, i) => ({ a, i, r: rank(a) })).filter((x) => x.r < 3).sort((x, y) => x.r - y.r || x.i - y.i).map((x) => x.a);
}

/** The command line of an agent the person adds, checked as the core checks it, so the form can say what is missing
 *  before it is sent: the core's own sentence, or nothing. */
export function ownAgentLacks(name: string, command: string): string {
  const n = name.trim();
  if (!n || [...n].length > 40) return 'Give the agent a name of up to 40 characters';
  const words = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  if (!words.length) return `${n} needs a command`;
  if (words[0]!.includes('{prompt}')) return `The command of ${n} needs a program before {prompt}`;
  if (!words.slice(1).some((w) => w.includes('{prompt}'))) return `The command of ${n} needs {prompt} where the task goes`;
  return '';
}

/** Words given back to a field, a thought taken back or one the core refused, go before what was typed since. */
export const back = (words: string, field: string) => (field.trim() ? `${words}\n${field}` : words);

/** A thought leaves its field for the core: its words are out of the field at once, so the next thought can be typed
 *  while `go` takes this one there, and what is typed meanwhile is the next one's beginning. If `go` fails the words
 *  are back in the field, before it. `sending` counts the thoughts whose `go` is not over. */
export async function leave(f: { draft: string; sending: number }, go: (text: string) => Promise<void>): Promise<void> {
  const text = f.draft.trim();
  f.draft = '';
  f.sending++;
  try {
    await go(text);
  } catch (e) {
    f.draft = back(text, f.draft);
    throw e;
  } finally {
    f.sending--;
  }
}

const mss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
/** The time a recording shows: nothing for the first seconds, then how long it has run, and the limit once it is
 *  half a minute away. */
export function clock(seconds: number, limit: number): string {
  if (seconds < 5) return '';
  return seconds >= limit - 30 ? `${mss(Math.min(seconds, limit))} of ${mss(limit)}` : mss(seconds);
}

/** Heard words placed at the caret of a field, set off by a space from what is beside them. */
export function into(value: string, start: number, end: number, words: string): { text: string; caret: number } {
  const before = value.slice(0, start), after = value.slice(end);
  const head = before + (before && !/\s$/.test(before) ? ' ' : '') + words.trim();
  return { text: head + (after && !/^[\s.,;:!?)]/.test(after) ? ' ' : '') + after, caret: head.length };
}
