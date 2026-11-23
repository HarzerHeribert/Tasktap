// The live target, as plain functions and one small state (target.test.ts): where the task being written or spoken
// would go, shown on the decision line before it is sent. Two answers feed it. The core's ranking (`route.guess`) is
// the provisional target, in the quiet tone; the model's preview (`route.preview`) is the confirmed one, in the full
// tone, and the only one Return may take. The state keeps the line calm: a target on show is replaced by another only
// after the other has stood for `STAND` ms, a provisional target never replaces a confirmed one for the same words, an
// answer to an older question is dropped, and nothing moves at rest. The page draws it and decides nothing itself.
import { PREVIEWS, type Place } from '../../core/proto/protocol.ts';

/** How long the words stand still before the core's ranking is asked, and before the model is (a pause in typing, or
 *  a spoken phrase that ended). */
export const QUIET_WORDS = 120;
export const PAUSE = 600;
/** How long a different target must stand before it replaces the one on show. */
export const STAND = 250;
/** The fewest words a preview is made of. */
export const MIN_WORDS = 3;

export const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** A place as one key, to tell whether two targets are the same. */
export const keyOf = (p: Place) => ('project' in p ? `p:${p.project}` : 'session' in p ? `s:${p.session}` : `c:${p.card}`);

export type Tone = 'provisional' | 'confirmed';
/** The target on show: `at` of `of` choices (1 of 1 for one that is not torn). */
export type Shown = { place: Place; tone: Tone; at: number; of: number };

/** Whether the model is asked about the words now: enough words, not those it was asked about last, the cap of
 *  previews for the task not reached. */
export const due = (o: { words: string; asked: string | null; sent: number }) =>
  wordCount(o.words) >= MIN_WORDS && o.words !== o.asked && o.sent < PREVIEWS;

export class Target {
  shown: Shown | null = null;
  /** What the core's ranking said of `of`, and what the model's preview said, the choices in its order. */
  private provisional: { of: string; place: Place | null } | null = null;
  private confirmed: { of: string; choices: Place[] } | null = null;
  private words = '';
  /** The choice on show of a torn answer, from 0, which the person steps. */
  private step = 0;
  /** A different target and since when it has stood. */
  private wait: { key: string; since: number } | null = null;
  /** The number of the latest question to the model, the words it asked about, and how many were sent for the task. */
  private seq = 0;
  asked: string | null = null;
  sent = 0;

  /** The task is sent, or its words are gone: nothing is kept of it. */
  reset() {
    this.shown = this.provisional = this.confirmed = this.wait = this.asked = null;
    this.words = '';
    // The count of questions goes on: an answer to a task before this one is never taken for this one's.
    this.step = this.sent = 0;
  }

  /** The words are these now; returns when the line may change by itself next, in ms, if it may. */
  set(words: string, now: number): number | null {
    if (!words.trim()) return (this.reset(), null);
    if (words !== this.words) this.step = 0;
    this.words = words;
    return this.settle(now);
  }

  /** The core's ranking for `of`. */
  guess(of: string, place: Place | null, now: number): number | null {
    this.provisional = { of, place };
    return this.settle(now);
  }

  /** The model is asked about `of`: the number its answer must come back with. */
  ask(of: string): number {
    this.asked = of;
    this.sent++;
    return ++this.seq;
  }

  /** The model's answer to question `n`, for the words `of` it asked about; an older question's is dropped. */
  preview(n: number, of: string, choices: Place[], now: number): number | null {
    if (n !== this.seq || !choices.length) return null;
    this.confirmed = { of, choices };
    this.step = 0;
    return this.settle(now);
  }

  /** What the line would show for the words now. */
  private want(): Shown | null {
    const c = this.confirmed, p = this.provisional;
    if (c && c.of === this.words) return { place: c.choices[this.step % c.choices.length]!, tone: 'confirmed', at: (this.step % c.choices.length) + 1, of: c.choices.length };
    if (p && p.of === this.words && p.place) return { place: p.place, tone: 'provisional', at: 1, of: 1 };
    return null;
  }

  private settle(now: number): number | null {
    const want = this.want(), shown = this.shown;
    if (!want) return null;
    if (!shown) return ((this.shown = want), null);
    if (keyOf(want.place) === keyOf(shown.place)) {
      // The same place: the model's word on it is the one change that is made at once; a provisional one never takes it back.
      this.wait = null;
      if (want.tone === 'confirmed' && (shown.tone !== 'confirmed' || shown.at !== want.at || shown.of !== want.of)) this.shown = want;
      return null;
    }
    const key = keyOf(want.place);
    if (this.wait?.key !== key) this.wait = { key, since: now };
    if (now - this.wait.since >= STAND) return ((this.shown = want), (this.wait = null), null);
    return STAND - (now - this.wait.since);
  }

  /** The person steps to the model's next choice, which shows at once. */
  next(): boolean {
    const c = this.confirmed;
    if (!c || c.of !== this.words || c.choices.length < 2) return false;
    this.step = (this.step + 1) % c.choices.length;
    this.shown = this.want();
    this.wait = null;
    return true;
  }

  /** What Return takes: the choice on show, when it is the model's for exactly these words and the person has it before
   *  them; else none, and the task is asked about as any task is. */
  take(words = this.words): number | null {
    const c = this.confirmed, s = this.shown;
    if (!c || c.of !== words || words !== this.words || s?.tone !== 'confirmed') return null;
    const at = this.step % c.choices.length;
    return keyOf(c.choices[at]!) === keyOf(s.place) ? at : null;
  }
}
