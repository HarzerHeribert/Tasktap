// What the notch holds only while it runs; its connection and records are the page's (page.ts).
export * from '../page.ts';

export type View = 'home' | 'answer';

export const ui = {
  /** closed; opened by the pointer (folds when it leaves); or pinned until dismissed. */
  mode: 'closed' as 'closed' | 'hover' | 'pinned',
  /** The fold animation is running; the content stays until it ends. */
  retracting: false,
  view: 'home' as View,
  inside: false,
  timer: 0,
  height: 260,
  wing: 0,
  /** The line under a collapsed notch with a cutout, while something asks. */
  line: 0,
  /** Opened by a question rather than by the person. */
  auto: false,
  /** Clicked or typed in since it opened: a notch a question opened then no longer folds by itself. */
  touched: false,
  question: null as string | null,
  seen: new Set<string>(),
  /** The capture line is open under the question card. */
  capturing: false,
  geometry: null as Record<string, number | boolean> | null,
};
