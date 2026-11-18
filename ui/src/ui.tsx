// The small parts both pages draw (parts.css): the icon set, the state mark with its words, the wave, key caps, an
// answer, a diffstat, and the words for times.
import type { Workdir } from '../../core/proto/protocol.ts';
import type { ComponentChildren } from 'preact';

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
  ret: () => <path d="M12.75 3.5v4.75H3.5M6.75 5L3.5 8.25l3.25 3.25" />,
  down: () => <path d="M8 2.75v10M4 9l4 4 4-4" />,
  later: () => <circle cx="8" cy="8" r="2.75" />,
  mic: () => <><rect x="6" y="2.25" width="4" height="7.5" rx="2" /><path d="M3.75 7.75a4.25 4.25 0 0 0 8.5 0M8 12v1.75" /></>,
} as const;
export type IconName = keyof typeof icons;

export function I({ n }: { n: IconName }) {
  return <svg class="i" viewBox="0 0 16 16" aria-hidden="true">{icons[n]()}</svg>;
}

/** What a mark can say: a thought's or a terminal's state. */
export type State = 'working' | 'asks' | 'ready' | 'failed' | 'ended' | 'shell' | 'later';
const WORDS: Record<State, string> = {
  working: 'Working', asks: 'Needs your answer', ready: 'Result ready', failed: 'Failed', ended: 'Ended', shell: 'Shell',
  later: 'Saved for later, not sent anywhere',
};
export const said = (s: State, bg = false) => `${WORDS[s]}${bg ? ', in background' : ''}`;

/** The state mark: five bars of the wave; its tooltip and accessible name say the state in words. */
export function Mark({ s, bg = false, label }: { s: State; bg?: boolean; label?: string }) {
  const words = label ?? said(s, bg);
  const named = words ? { role: 'img' as const, 'aria-label': words, title: words } : { 'aria-hidden': true };
  if (s === 'shell') return <i class="st" data-s="shell" {...named}><I n="term" /></i>;
  if (s === 'later') return <i class="st" data-s={s} {...named} />;
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

/** The wave as loud as a voice: its bars' heights follow `l`, 0 to 1, the level of the dictation that records. Five
 *  bars, or as many as the wave it stands in for. */
export function Level({ l, n = 5 }: { l: number; n?: number }) {
  const bars = Array.from({ length: n }, (_, i) => {
    const tint = [3, 4, 11].includes(i % 14) ? 'cu' : [7, 12].includes(i % 14) ? 'gr' : '';
    return <b class={n === 5 ? (i === 1 ? 'cu' : i === 3 ? 'gr' : '') : tint} style={{ '--h': `${Math.round(34 + 66 * Math.sin((Math.PI * (i + 0.5)) / n))}%` }} />;
  });
  return <span class="wave lvl" style={{ '--l': String(Math.max(0, Math.min(1, l))) }} aria-hidden="true">{bars}</span>;
}

/** What a key cap shows: Return as the icon set draws it, so it is as large as the letters beside it. */
export const glyph = (k: string) => (k === '↩' ? <I n="ret" /> : k);

/** An agent's own mark, on a 24 px grid; one the app has no mark for shows two letters, so that agents whose names
 *  begin alike are told apart: the initials of its first two words, or the first two letters of its one. */
export const letters = (id: string) => {
  const w = id.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return w.length > 1 ? (w[0]![0]! + w[1]![0]!).toUpperCase() : (w[0] ?? '?').slice(0, 2).replace(/^./, (c) => c.toUpperCase());
};
const MARKS: Record<string, string> = {
  claude: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z',
  codex: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
};
/** What a ring says about its agent: nothing (it can run), it is not signed in, its sessions work, one of them asks. */
export type RingState = '' | 'off' | 'working' | 'asks';
/** An agent's ring: its mark in a fine circle on a 24 px grid. The circle is whole when the agent can run and open
 *  when it is not signed in; a second arc turns on it while its sessions work. The circle is `--arc` of a turn, so it
 *  can show a share of something later. */
export function Ring({ agent, s, turns = s === 'working' }: { agent: string; s: RingState; turns?: boolean }) {
  return (
    <svg class="ring-o" viewBox="0 0 24 24" aria-hidden="true">
      <linearGradient id="ring-lit" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" stop-color="#b98a5e" /><stop offset=".3" stop-color="#edcda6" /><stop offset=".5" stop-color="#f7f8fa" /><stop offset=".72" stop-color="#a9c0df" /><stop offset="1" stop-color="#7b92c4" />
      </linearGradient>
      <circle cx="12" cy="12" r="11" pathLength="100" />
      {turns && <circle class="turn" cx="12" cy="12" r="11" pathLength="100" />}
      {MARKS[agent] ? <path d={MARKS[agent]} transform="translate(5.5 5.5) scale(.542)" /> : <text x="12" y="15.6" text-anchor="middle">{letters(agent)}</text>}
    </svg>
  );
}

/** An answer: its key cap and its label; `lead` is the mark of what it is, `more` a few quiet words about it. */
export function Answer({ k, label, primary = false, danger = false, onClick, cls = 'ans', lead, more }: {
  k: string; label: string; primary?: boolean; danger?: boolean; onClick: () => void; cls?: string; lead?: ComponentChildren; more?: string;
}) {
  return (
    <button type="button" class={`${cls}${primary ? ' primary' : ''}${danger ? ' danger' : ''}`} onClick={onClick}>
      <kbd>{glyph(k)}</kbd>{lead}<span>{label}</span>{more && <i>{more}</i>}
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
