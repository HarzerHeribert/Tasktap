// The small parts both pages draw (parts.css): the icon set, the state mark with its words, Tasktap's mark, key caps,
// an answer, a diffstat, and the words for times.
import type { Workdir } from '../../core/proto/protocol.ts';
import type { ComponentChildren } from 'preact';
import { MARKS } from './marks.ts';
import { spell } from './keys.ts';
import { ownName, records } from './page.ts';
import { letters, lettersOf } from './way.ts';

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
  /** The Scratchpad: a pad of paper with its two rings. */
  pad: () => <><rect x="3.25" y="3" width="9.5" height="10.5" rx="1.75" /><path d="M6 1.75v2.5M10 1.75v2.5M5.75 7.25h4.5M5.75 10h3" /></>,
  ret: () => <path d="M12.75 3.5v4.75H3.5M6.75 5L3.5 8.25l3.25 3.25" />,
  down: () => <path d="M8 2.75v10M4 9l4 4 4-4" />,
  later: () => <circle cx="8" cy="8" r="2.75" />,
  check: () => <path d="M3.25 8.25l3 3 6.5-6.5" />,
  view: () => <><path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z" /><circle cx="8" cy="8" r="1.75" /></>,
  menu: () => <path d="M2.75 4.75h10.5M2.75 8h10.5M2.75 11.25h10.5" />,
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

/** The state mark. While something works it is Tasktap's mark with its light passing (Brand `live`); otherwise a
 *  seat with no agent in it (Seat), its ring in the same colours holding a pip of the state's colour. Its tooltip and
 *  accessible name say the state in words. */
const TONES: Partial<Record<State, RingTone>> = { asks: 'asks', ready: 'lit', failed: 'fail' };
export function Mark({ s, bg = false, label }: { s: State; bg?: boolean; label?: string }) {
  const words = label ?? said(s, bg);
  const named = words ? { role: 'img' as const, 'aria-label': words, title: words } : { 'aria-hidden': true };
  if (s === 'shell') return <i class="st" data-s="shell" {...named}><I n="term" /></i>;
  if (s === 'later') return <i class="st" data-s={s} {...named} />;
  if (s === 'working') return <i class={`st${bg ? ' bgd' : ''}`} data-s={s} {...named}><Brand live /></i>;
  return (
    <i class={`st${bg ? ' bgd' : ''}`} data-s={s} {...named}>
      <svg class="ring-o" viewBox="0 0 24 24" aria-hidden="true" data-tone={TONES[s]}>
        {s === 'ready' && lit()}
        <circle cx="12" cy="12" r="11" pathLength="100" />
        <circle class="pip" cx="12" cy="12" r="4" />
      </svg>
    </i>
  );
}

/** A session's seat: its agent's plain mark carrying the state it is in, wherever a session is shown (a row on Home, in
 *  the sidebar, a tab), so that a session looks like itself everywhere. The mark moves gently while it works, is the
 *  attention colour while it asks, white while its result is new, the failure colour when it failed, and quiet once seen
 *  (parts.css .st.of). A terminal with no agent, and a thought no agent has run, keep the mark. */
export function Seat({ agent, s, bg = false, label, size = 16 }: { agent?: string | null; s: State; bg?: boolean; label?: string; size?: number }) {
  if (!agent || s === 'shell' || s === 'later') return <Mark s={s} bg={bg} label={label} />;
  const words = label ?? said(s, bg);
  const named = words ? { role: 'img' as const, 'aria-label': words, title: words } : { 'aria-hidden': true };
  return <i class={`st of${bg ? ' bgd' : ''}`} data-s={s} style={{ '--seat': size }} {...named}><Glyph agent={agent} size={size} working={s === 'working'} /></i>;
}

/** Tasktap's mark: a slab of the chrome set (motion/mark.ts) in the app's own metal and light, as pictures drawn once
 *  from the motion engine (scripts/mark-pictures.cjs) at each size it is shown at, so that nothing draws it here: at
 *  rest, and with the light three steps further down its face. At rest it is still. `live` while something works:
 *  the light passes slowly down the face and back, each step fading into the next, which the compositor carries
 *  (parts.css). */
export type MarkSize = 14 | 24 | 28;
const files = import.meta.glob<string>('./mark/mark-*.png', { eager: true, import: 'default' });
const Steps = ({ size }: { size: MarkSize }) => <>{[0, 1, 2, 3].map((k) => <img class={`p${k}`} src={files[`./mark/mark-${size}-${k}.png`]} alt="" />)}</>;
export function Brand({ size = 14, live = false }: { size?: MarkSize; live?: boolean }) {
  return <span class={`brand-m${live ? ' live' : ''}`} style={{ '--m': `${size}px` }} aria-hidden="true"><Steps size={size} /></span>;
}

/** The mark as loud as a voice: `l`, 0 to 1, the level of the dictation that records. The louder, the further down
 *  its face the light stands, and the light behind the slab swells and brightens with it; eased between the core's
 *  ten reports a second (way.css). */
export function Level({ l, size = 24 }: { l: number; size?: MarkSize }) {
  return (
    <span class="brand-m lvl" style={{ '--m': `${size}px`, '--l': String(Math.max(0, Math.min(1, l))) }} aria-hidden="true">
      <i class="halo" /><Steps size={size} />
    </span>
  );
}

/** A key, wherever one is shown: on a metal cap (`cap`: the key that answers) or as a hint after a label, written as
 *  the Mac has it and shown as this system writes its own key for it (keys.ts `spell`). One role for both
 *  (tokens.css --f-key), so none is smaller than another; Return is the icon set's own arrow, as large as the
 *  letters beside it. */
export function Key({ k, cap = false }: { k: string; cap?: boolean }) {
  const s = spell(k), at = s.indexOf('↩');
  return <kbd class={cap ? 'keycap' : undefined}>{at < 0 ? s : <>{s.slice(0, at)}<I n="ret" />{s.slice(at + 1)}</>}</kbd>;
}

/** An agent's own mark, on a 24 px grid; one the app has no mark for shows two letters (way.ts: `letters`, and
 *  `lettersOf`, which keeps them apart where two agents would show the same). */
export { letters };
/** What a ring says about its agent: nothing (it can run), it is not signed in, its sessions work, one of them asks. */
export type RingState = '' | 'off' | 'working' | 'asks';
/** An agent's ring: its mark in a fine circle on a 24 px grid. The circle is whole when the agent can run and open
 *  when it is not signed in; a second arc turns on it while its sessions work. The circle is `--arc` of a turn, so it
 *  can show a share of something later.
 *  What stands around a ring gives it these and reaches for nothing inside it: `size`, its width in px (22 where none
 *  is given; a place may also set `--ring-px`), at which its circle is drawn at the icons' weight; `tone`, what its
 *  circle says of a session (it asks, its result is new, it failed); and whether its mark is `one` letter, which a
 *  ring under 20 px shows, since two are cramped there. */
export type RingTone = 'asks' | 'lit' | 'fail';
/** The lit ring's colours, as the metal's light has them. */
const lit = () => (
  <linearGradient id="ring-lit" x1="0" y1="1" x2="1" y2="0">
    <stop offset="0" stop-color="#b98a5e" /><stop offset=".3" stop-color="#edcda6" /><stop offset=".5" stop-color="#f7f8fa" /><stop offset=".72" stop-color="#a9c0df" /><stop offset="1" stop-color="#7b92c4" />
  </linearGradient>
);
/** An agent's mark as the ring and the plain mark both draw it: its glyph, or the two letters its name gives (one in a
 *  box too small for two), in the colour of whatever it stands in. One the person added is lettered by the name they
 *  gave it: its id is Tasktap's and says nothing. */
function glyph(agent: string, one: boolean) {
  const word = (id: string) => ownName(id) ?? id;
  const lettered = [...records.agents.keys()].filter((id) => !MARKS[id]).map(word);
  return MARKS[agent] ? <path d={MARKS[agent]} transform="translate(5.5 5.5) scale(.542)" /> : <text class={one ? 'one' : undefined} x="12" y={one ? 17 : 15.6} text-anchor="middle">{lettersOf(lettered, one).get(word(agent)) ?? letters(word(agent)).slice(0, one ? 1 : 2)}</text>;
}
export function Ring({ agent, s, turns = s === 'working', size, tone, one = (size ?? 22) < 20 }: {
  agent: string; s: RingState; turns?: boolean; size?: number; tone?: RingTone; one?: boolean;
}) {
  return (
    <svg class="ring-o" viewBox="0 0 24 24" aria-hidden="true" data-tone={tone} style={size ? { '--ring-px': size } : undefined}>
      {lit()}
      <circle cx="12" cy="12" r="11" pathLength="100" />
      {turns && <circle class="turn" cx="12" cy="12" r="11" pathLength="100" />}
      {glyph(agent, one)}
    </svg>
  );
}
/** What the plain mark says of its agent, in tone: it failed or was stopped (`fail`), it asks (`asks`), it is signed out
 *  or not here (`quiet`); `working` moves it gently (parts.css). */
export type GlyphTone = 'asks' | 'fail' | 'quiet';
/** An agent's plain mark: its glyph with no circle, `size` px wide. The ring (Ring) is for where its arc shows the
 *  agent's remaining usage; everywhere else an agent is this. */
export function Glyph({ agent, size = 18, tone, working = false }: { agent: string; size?: number; tone?: GlyphTone; working?: boolean }) {
  return <svg class="amark" viewBox="4 4 16 16" aria-hidden="true" data-tone={tone} data-working={working || undefined} style={{ '--g': size }}>{glyph(agent, size < 16)}</svg>;
}

/** An answer: its key cap and its label; `lead` is the mark of what it is, `more` a few quiet words about it. */
export function Answer({ k, label, primary = false, danger = false, onClick, cls = 'ans', lead, more, title }: {
  k: string; label: string; primary?: boolean; danger?: boolean; onClick: () => void; cls?: string; lead?: ComponentChildren; more?: string; title?: string;
}) {
  return (
    <button type="button" class={`${cls}${primary ? ' primary' : ''}${danger ? ' danger' : ''}`} title={title} onClick={onClick}>
      <Key k={k} cap />{lead}<span>{label}</span>{more && <i>{more}</i>}
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