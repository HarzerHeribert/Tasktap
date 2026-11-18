// From the records to what is shown of a thought on its way and of speech, as plain functions (way.test.ts): the step
// a thought is at between capture and start, its brief when that says the words differently, how much of its hold is
// left, how it was placed, why it waits in For later, whether placing by a model is on, what a ring says of its agent,
// the time a recording shows, where heard words go in a field, and what a field holds while its thought is sent. The
// pages draw these and decide nothing themselves.
import type { RouteBy, Thought } from '../../core/proto/protocol.ts';

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

/** How a thought found its place, in a few words; the reason a model was not used is the core's sentence, as it is.
 *  `picked`: the person chose the place themselves, so a model can only have written the brief. */
export function placed(t: Pick<Thought, 'route'>, agent: (id: string) => string, picked = false): string | null {
  const r = t.route;
  if (!r) return null;
  if (r.fallback) return `${picked ? 'Sent in your words' : 'Placed by name'}. ${r.fallback}`;
  if (r.by === 'local') return 'Placed by name';
  const who = `${agent(r.by)}${r.model ? ` · ${r.model}` : ''}`;
  return picked ? `Brief by ${who}` : r.quote ? `Placed by ${who}, because you said “${r.quote}”` : `Placed by ${who}`;
}

/** Why a thought waits in For later. `kept`: the person answered its question with Keep for later. */
export function laterWhy(t: Pick<Thought, 'route'>, agent: (id: string) => string, kept = false): string {
  const r = t.route;
  if (kept) return 'You kept it for later';
  if (!r) return 'You saved it for later';
  return r.by === 'local' || r.fallback ? 'It named no folder' : `${agent(r.by)} found no folder for it`;
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
