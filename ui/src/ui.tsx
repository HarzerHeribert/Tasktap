// The small parts both pages draw (parts.css): the icon set, the state mark with its words, the wave, key caps, an
// answer, a diffstat, and the words for times.
import type { Workdir } from '../../core/proto/protocol.ts';

/** One owned set of icons on a 16 px grid, drawn as strokes. */
const icons = {
  sidebar: () => <><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25" /><path d="M5.75 2.75v10.5" /></>,
  splitr: () => <><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25" /><path d="M8 2.75v10.5" /></>,
  splitd: () => <><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25" /><path d="M1.75 8h12.5" /></>,
  plus: () => <path d="M8 3.25v9.5M3.25 8h9.5" />,
  x: () => <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  chev: () => <path d="M6 3.75L10.25 8 6 12.25" />,
  home: () => <path d="M2.5 7.25L8 2.75l5.5 4.5M3.75 6.5v6.75h8.5V6.5" />,
  arrow: () => <path d="M2.75 8h10M9 4l4 4-4 4" />,
  term: () => <path d="M3 4.75L6.25 8 3 11.25M8.25 11.5h4.75" />,
  bg: () => <><rect x="5.75" y="2.25" width="8" height="8" rx="1.75" opacity=".45" /><rect x="2.25" y="5.75" width="8" height="8" rx="1.75" /></>,
  search: () => <><circle cx="7" cy="7" r="4.25" /><path d="M10.25 10.25l3 3" /></>,
  folder: () => <path d="M2.25 4.25h4l1.5 1.75h6v6.75H2.25z" />,
} as const;
export type IconName = keyof typeof icons;

export function I({ n }: { n: IconName }) {
  return <svg class="i" viewBox="0 0 16 16" aria-hidden="true">{icons[n]()}</svg>;
}

/** What a mark can say: a thought's or a terminal's state. */
export type State = 'working' | 'asks' | 'ready' | 'failed' | 'ended' | 'shell' | 'idea' | 'dot' | 'off';
const WORDS: Record<State, string> = {
  working: 'Working', asks: 'Needs your answer', ready: 'Result ready', failed: 'Failed', ended: 'Ended', shell: 'Shell',
  idea: 'Idea, not sent anywhere', dot: '', off: '',
};
export const said = (s: State, bg = false) => `${WORDS[s]}${bg ? ', in background' : ''}`;

/** The state mark: five bars of the wave; its tooltip and accessible name say the state in words. */
export function Mark({ s, bg = false, label }: { s: State; bg?: boolean; label?: string }) {
  const words = label ?? said(s, bg);
  const named = words ? { role: 'img' as const, 'aria-label': words, title: words } : { 'aria-hidden': true };
  if (s === 'shell') return <i class="st" data-s="shell" {...named}><I n="term" /></i>;
  if (s === 'idea' || s === 'dot' || s === 'off') return <i class="st" data-s={s} {...named} />;
  return <i class={`st${bg ? ' bgd' : ''}`} data-s={s} {...named}><b /><b /><b /><b /><b /></i>;
}

/** The brand's wave: chrome bars, a few copper and graphite among the silver, as the icon has them. */
export function Wave({ n = 9, live = false, rest = false, style }: { n?: number; live?: boolean; rest?: boolean; style?: Record<string, string> }) {
  const bars = Array.from({ length: n }, (_, i) => {
    const x = n > 1 ? i / (n - 1) : 0.5;
    const tint = [3, 4, 11].includes(i % 14) ? 'cu' : [7, 12].includes(i % 14) ? 'gr' : '';
    return <b class={tint} style={{ '--h': `${Math.round(34 + 66 * Math.sin(Math.PI * x))}%`, '--d': `${(i * 70) % 900}ms` }} />;
  });
  return <span class={`wave${live ? ' live' : ''}${rest ? ' rest' : ''}`} style={style} aria-hidden="true">{bars}</span>;
}

/** An answer: its key cap and its label. */
export function Answer({ k, label, primary = false, danger = false, onClick, cls = 'ans' }: {
  k: string; label: string; primary?: boolean; danger?: boolean; onClick: () => void; cls?: string;
}) {
  return (
    <button type="button" class={`${cls}${primary ? ' primary' : ''}${danger ? ' danger' : ''}`} onClick={onClick}>
      <kbd>{k}</kbd><span>{label}</span>
    </button>
  );
}

/** "3 files +14 −3". */
export function Diffstat({ w }: { w: Pick<Workdir, 'files' | 'insertions' | 'deletions'> }) {
  return (
    <span class="diff" title={`${w.files} ${w.files === 1 ? 'file' : 'files'} changed, ${w.insertions} lines added, ${w.deletions} removed`}>
      {w.files} {w.files === 1 ? 'file' : 'files'} <i class="p">+{w.insertions}</i> <i class="m">−{w.deletions}</i>
    </span>
  );
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
/** A time as a row shows it: 15:21 today, Mon this week, 3 Nov before. */
export function when(ms: number, now = Date.now()) {
  const d = new Date(ms), today = new Date(now);
  if (sameDay(d, today)) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (now - ms < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
/** How long something has run: 40s, 6m, 2h. */
export function elapsed(since: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - since) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** When a record with a UUID v7 id was made: its first 48 bits are milliseconds. */
export const madeAt = (id: string) => Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16) || Date.now();
/** How long ago: just now, 2 min ago, 3 h ago, then the time. */
export function ago(ms: number, now = Date.now()) {
  const m = Math.round((now - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 360 ? `${Math.round(m / 60)} h ago` : when(ms, now);
}
