// From the records to what is shown of a thought on its way and of speech, as plain functions (way.test.ts): the step
// a thought is at between capture and start, its brief when that says the words differently, how much of its hold is
// left, how it came by its place and why it waits in For later (the core's own word for each, `placed`), whether placing
// by a model is on, what a ring says of its agent,
// the time a recording shows, where heard words go in a field, and what a field holds while its thought is sent. The
// pages draw these and decide nothing themselves.
import type { RouteBy, Thought } from '../../core/proto/protocol.ts';

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

/** How a thought came by its place, in a few words, from the core's word for it. "Placed by" only where the match on
 *  names or a model placed it. Where the person decided (a pick, a follow-up to the session they were in, an answer to
 *  where it should go) `route` only says who wrote the brief. Why a model was not used is the core's sentence, as it is;
 *  with no word (the asking was cut short) that sentence is all there is to say. */
export function placed(t: Pick<Thought, 'placed' | 'route'>, agent: (id: string) => string): string | null {
  const r = t.route, who = r && r.by !== 'local' ? `${agent(r.by)}${r.model ? ` · ${r.model}` : ''}` : '';
  switch (t.placed) {
    case 'name':
      return `Placed by name${r?.fallback ? `. ${r.fallback}` : ''}`;
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

/** Placing by a model: off, on, or agreed to once for something this Tasktap no longer asks (`again`). */
export function placing(by: RouteBy | null | undefined, tools: RouteBy[]): 'off' | 'on' | 'again' {
  if (!by) return 'off';
  return tools.some((t) => t.agent === by.agent && t.model === by.model) ? 'on' : 'again';
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

/** The agents the Composer offers for a thought, and which of them have a ring. Offered are those that can run one
 *  now: installed, on this system, and not known to be signed out (one never asked counts: the core asks it the
 *  first time it is picked or runs); and the usual one even when it is signed out, since it runs the next thought
 *  and its ring says what is wrong. At most `cap` have a ring: the usual one, the one picked for this thought,
 *  those that work or ask, then the others in the core's order. The rest are behind "+n", from where each can be
 *  picked, which gives it a ring. Rings stand in the core's order, so none moves when another is picked. */
export function offered<A extends { id: string; installed: boolean; supported: boolean; signed_in: boolean | null }>(
  agents: A[], usual: string | undefined, chosen: string | undefined, busy: (id: string) => boolean, cap: number,
): { rings: A[]; more: A[] } {
  const all = agents.filter((a) => a.installed && a.supported && (a.signed_in !== false || a.id === usual));
  const rank = (a: A) => (a.id === usual ? 0 : a.id === chosen ? 1 : busy(a.id) ? 2 : 3);
  const first = new Set(all.map((a, i) => [rank(a), i, a] as const).sort((x, y) => x[0] - y[0] || x[1] - y[1]).slice(0, cap).map((x) => x[2]));
  return { rings: all.filter((a) => first.has(a)), more: all.filter((a) => !first.has(a)) };
}

/** The command line of an agent the person adds, checked as the core checks it, so the form can say what is missing
 *  before it is sent: the core's own sentence, or nothing. */
export function ownAgentLacks(name: string, command: string): string {
  const n = name.trim();
  if (!n || [...n].length > 40) return 'Give the agent a name of up to 40 characters';
  const words = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  if (!words.length) return `${n} needs a command`;
  if (words[0]!.includes('{prompt}')) return `The command of ${n} needs a program before {prompt}`;
  if (!words.slice(1).some((w) => w.includes('{prompt}'))) return `The command of ${n} needs {prompt} where the thought goes`;
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
