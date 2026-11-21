// The Composer's empty field invites a task in a few words that take turns (the owner's, 2026-11-21): Home's, the
// notch's and the New Task sheet's alike. While the field is empty, has the keyboard, Tasktap is in front, nothing is
// dictated or composed and the effects are Full, the line rolls to the next every five seconds: the one going slides up
// and fades as the next comes from below (`--t-sheet`, `--ease`). In every other case no timer runs and nothing moves.
// At rest the field's own placeholder is the line, so the Composer is drawn as it always was; only while a line rolls do
// two copies of it, hidden from screen readers, move over the field (`rollIn`). The field's accessible name stays
// "New task" throughout.

/** The lines, in order: edit, add or strike any. `{key}` is the key held to talk, as the Composer draws it; such a line
 *  is left out where there is no key to talk with. A line in `WHILE_RUNNING` is shown only while a task runs. */
export const LINES = [
  "What's next?",
  'Hand off a task',
  'Think out loud',
  'Describe a task',
  'No need to pick a project',
  'Hold {key} and talk',
  'Half an idea is fine',
  'Say or type a task',
  'Fix a bug, build a feature, or just ask',
  'Go on, ramble',
  'Start a second task while the first runs',
  'What needs doing?',
];
export const WHILE_RUNNING = ['Start a second task while the first runs'];
/** How long a line stays while the field rolls. */
export const EVERY = 5000;

/** What the lines depend on now: the key held to talk as drawn (none where talking is not set up), whether a task runs. */
export type Now = { key: string | null; running: boolean };
const shows = (i: number, now: Now) => {
  const line = LINES[i] ?? '';
  return (!line.includes('{key}') || !!now.key) && (!WHILE_RUNNING.includes(line) || now.running);
};
/** The line at `i`, or the first after it that shows now (round to the start). */
export function at(i: number, now: Now): number {
  for (let k = 0; k < LINES.length; k++) {
    const j = (((i + k) % LINES.length) + LINES.length) % LINES.length;
    if (shows(j, now)) return j;
  }
  return 0;
}
export const text = (i: number, now: Now) => (LINES[at(i, now)] ?? '').replace('{key}', now.key ?? '');

/** When the field rolls: every one of these holds. */
export type Field = { empty: boolean; held: boolean; front: boolean; dictating: boolean; composing: boolean; effects: 'off' | 'still' | 'full' };
export const rolls = (f: Field) => f.empty && f.held && f.front && !f.dictating && !f.composing && f.effects === 'full';

/** The one owner of the roll's timer, for every Composer of a page: the field it rolls for (`who`), and the timer, which
 *  runs only while `run` is told it may, and goes the moment it is told otherwise, by that field, or the field goes
 *  (`stop`). `show` draws a line, rolled in or at once; `end` ends a roll still moving, at once. */
export class Roll {
  /** The line shown: the first at a fresh start. */
  i = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private who: unknown;
  private now: () => Now;
  private show: (line: string, roll: boolean) => void;
  private end: () => void;
  constructor(now: () => Now, show: (line: string, roll: boolean) => void, end: () => void = () => {}) {
    this.now = now;
    this.show = show;
    this.end = end;
  }
  /** The words the field shows now. */
  get line() {
    return text(this.i, this.now());
  }
  get rolling() {
    return this.timer !== undefined;
  }
  /** `on`: whether field `who` rolls now. Told so, the timer runs (one, whichever field asks); told otherwise by the field
   *  it runs for, it goes at once, and a line still moving is put in its place. */
  run(on: boolean, who: unknown) {
    if (on) {
      if (this.who !== undefined && this.who !== who) this.stop();
      this.who = who;
      this.timer ??= setTimeout(this.tick, EVERY);
    } else if (this.who === who) this.stop();
  }
  /** Nothing rolls: the timer goes, and any line on its way is in its place. `who`: only if it rolls for that field. */
  stop(who?: unknown) {
    if (who !== undefined && who !== this.who) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.who = undefined;
    this.end();
  }
  private tick = () => {
    this.timer = setTimeout(this.tick, EVERY);
    this.next(true);
  };
  /** The next line: rolled in (`roll`, the effects at Full with the field rolling) or simply shown. The timer, where it
   *  runs, counts its five seconds again from here. */
  next(roll: boolean) {
    const now = this.now();
    this.i = at(at(this.i, now) + 1, now);
    if (this.timer !== undefined) (clearTimeout(this.timer), (this.timer = setTimeout(this.tick, EVERY)));
    this.show(text(this.i, now), roll);
  }
}

/** The roll itself, over field `field`: two copies of the field, each showing a line as its own placeholder (so drawn
 *  exactly as the field draws it), the one going and the one coming, moved by the compositor (transform and opacity
 *  only); the field's own placeholder, already the new line, is hidden meanwhile. `stopRoll` ends a roll at once. */
let moving: { over: HTMLElement; field: HTMLTextAreaElement; anims: Animation[] } | null = null;
export function stopRoll() {
  if (!moving) return;
  const m = moving;
  moving = null;
  for (const a of m.anims) a.cancel();
  m.over.remove();
  m.field.removeAttribute('data-rolling');
}
/** A time token as milliseconds, however the stylesheet came to write it (the build writes 220ms as .22s). */
const ms = (t: string) => (/ms\s*$/.test(t) ? parseFloat(t) : /s\s*$/.test(t) ? parseFloat(t) * 1000 : NaN) || 220;
export function rollIn(field: HTMLTextAreaElement, from: string, to: string) {
  stopRoll();
  field.placeholder = to;
  const box = field.offsetParent as HTMLElement | null;
  if (!box || !from || typeof field.animate !== 'function') return;
  const root = getComputedStyle(document.documentElement), cs = getComputedStyle(field), at = field.getBoundingClientRect(), of = box.getBoundingClientRect();
  // The field's text box, where its placeholder is drawn (its box less its border and padding); nothing of the roll is
  // drawn outside it. Each copy is the whole field, placed so that its text box lies on this one.
  const edge = (side: 'Left' | 'Top' | 'Right' | 'Bottom') => parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`)) + parseFloat(cs.getPropertyValue(`padding-${side.toLowerCase()}`));
  const left = edge('Left'), top = edge('Top');
  const over = document.createElement('div');
  over.className = 'cap-lines';
  over.setAttribute('aria-hidden', 'true');
  over.inert = true;
  Object.assign(over.style, {
    left: `${at.left - of.left - box.clientLeft + left}px`, top: `${at.top - of.top - box.clientTop + top}px`,
    width: `${at.width - left - edge('Right')}px`, height: `${at.height - top - edge('Bottom')}px`,
  });
  const copy = (words: string) => {
    const t = document.createElement('textarea');
    t.rows = 1;
    t.tabIndex = -1;
    t.placeholder = words;
    Object.assign(t.style, { left: `${-left}px`, top: `${-top}px`, width: `${at.width}px`, height: `${at.height}px` });
    return over.appendChild(t);
  };
  const out = copy(from), inn = copy(to);
  box.appendChild(over);
  field.setAttribute('data-rolling', '');
  const timing: KeyframeAnimationOptions = { duration: ms(root.getPropertyValue('--t-sheet')), easing: root.getPropertyValue('--ease').trim() || 'ease', fill: 'both' };
  const anims = [
    out.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(-50%)', opacity: 0 }], timing),
    inn.animate([{ transform: 'translateY(50%)', opacity: 0 }, { transform: 'none', opacity: 1 }], timing),
  ];
  moving = { over, field, anims };
  const mine = moving;
  void anims[1]!.finished.then(() => moving === mine && stopRoll(), () => {});
}
