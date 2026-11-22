// A result as a card (design: the owner's "make this part look way better", 2026-11-22), and the same content as a peek
// at a row. The card is what a result the person has not opened yet is on Home; the peek is what a row shows, in a
// popover beside it, while the keyboard is on the row or the pointer has rested on it. Both say the task in the
// person's words, what the agent answered (or how it failed, or what it does now) in a few lines cut at a word, and
// under that, quietly, the agent's mark, the project, the time and the changes. Who placed the task is not here: it is
// data of the session's sheet.
import type { Thought } from '../../../core/proto/protocol.ts';
import type { RefObject } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Diffstat, Glyph, elapsed, when } from '../ui.tsx';
import { agentName, endedSays, projectName, records, redraw, resultOf, unheard, why } from './model.ts';
import { lines, plain } from './markdown.ts';

/** Some words in at most `n` lines: all of them where they fit, else as many whole words as do, then an ellipsis. The
 *  cut is found where the words are laid out: the words beyond the lines are measured, then dropped, one word at a time
 *  while the ellipsis would stand on a line too many. */
function Clamp({ text, md = false, n }: { text: string; md?: boolean; n: number }) {
  const box = useRef<HTMLDivElement>(null), width = useRef(0);
  const [cut, setCut] = useState(-1);
  const rows = lines(text, md);
  useLayoutEffect(() => {
    const b = box.current;
    if (!b || b.scrollHeight <= b.clientHeight + 1) return;
    const spans = [...b.querySelectorAll<HTMLElement>('.w')];
    const over = spans.findIndex((s) => s.offsetTop + s.offsetHeight > b.clientHeight + 1);
    if (cut < 0) over > 0 && setCut(over);
    else if (cut > 1) setCut(cut - 1);
  });
  useLayoutEffect(() => {
    const b = box.current;
    if (!b) return undefined;
    const watch = new ResizeObserver(() => b.clientWidth !== width.current && ((width.current = b.clientWidth), setCut(-1)));
    watch.observe(b);
    return () => watch.disconnect();
  }, []);
  let left = cut < 0 ? Infinity : cut;
  return (
    <div class="cl" ref={box} style={{ '--n': n }}>
      {rows.map((row) => {
        if (left <= 0) return null;
        const part = row.slice(0, left);
        left -= part.length;
        return (
          <div class={`cl-l${part[0]?.k === 'm' ? ' li' : ''}`}>
            {part.map((w) => <span class={w.k ? `w ${w.k}` : 'w'}>{w.sp ? ' ' : ''}{w.s}</span>)}
            {left <= 0 && cut >= 0 && '…'}
          </div>
        );
      })}
    </div>
  );
}

/** What stands where the answer does: the answer in Markdown; how it failed; what the agent does now; what an ended
 *  terminal means. */
function says(t: Thought, kind: 'run' | 'res') {
  const r = resultOf(t);
  if (kind === 'run') return { text: records.sessions.get(t.session_id ?? '')?.activity.at(-1) ?? 'Starting', md: false, fail: false };
  if (t.status === 'failed') return { text: `${why(t)}${r?.summary ? `: ${plain(r.summary)}` : ''}`, md: false, fail: true };
  return unheard(t) ? { text: endedSays(t), md: false, fail: false } : { text: r?.summary ?? '', md: true, fail: false };
}

/** The content of a card and of a peek. */
export function Body({ t, kind }: { t: Thought; kind: 'run' | 'res' }) {
  const s = records.sessions.get(t.session_id ?? ''), agent = s?.agent ?? t.agent;
  const a = says(t, kind), w = t.workdir;
  return (
    <div class="cd">
      <p class="cd-t"><Clamp key={t.text} text={t.text.trim()} n={3} /></p>
      {a.text && <div class={`cd-a${a.fail ? ' fail' : ''}`}><Clamp key={a.text} text={a.text} md={a.md} n={5} /></div>}
      <p class="cd-f">
        {agent && <span class="cd-g" role="img" aria-label={agentName(agent)}><Glyph agent={agent} size={14} /></span>}
        <span class="cd-p">{projectName(t.project_id)}</span>
        <time>{kind === 'run' ? elapsed(t.created) : when(t.updated)}</time>
        {w && w.files + w.insertions + w.deletions > 0 && <Diffstat w={w} />}
      </p>
    </div>
  );
}

// ——— The peek ———

/** The row being peeked at, where it stands in the window's body (`.room`), and the room's height. */
const peek = { t: null as Thought | null, kind: 'res' as 'run' | 'res', left: 0, top: 0, bottom: 0, width: 0, room: 0, timer: 0 };
/** How long the pointer rests on a row before its peek shows. */
const REST = 350;
const hide = () => {
  clearTimeout(peek.timer);
  if (peek.t) ((peek.t = null), redraw());
};
const show = (row: HTMLElement, t: Thought, kind: 'run' | 'res') => {
  const room = row.closest('.room')?.getBoundingClientRect(), at = row.getBoundingClientRect();
  if (!room) return;
  Object.assign(peek, { t, kind, left: at.left - room.left, top: at.top - room.top, bottom: at.bottom - room.top, width: at.width, room: room.height });
  redraw();
};
/** The handlers that give a row its peek: shown at once where the keyboard is on the row, and where the pointer has
 *  rested on it; gone when either leaves. */
export const glance = (t: Thought, kind: 'run' | 'res') => ({
  onPointerEnter: (e: PointerEvent) => {
    clearTimeout(peek.timer);
    const row = e.currentTarget as HTMLElement;
    if (e.pointerType === 'mouse') peek.timer = window.setTimeout(() => show(row, t, kind), REST);
  },
  onPointerLeave: hide,
  onFocus: (e: FocusEvent) => e.target === e.currentTarget && (e.currentTarget as HTMLElement).matches(':focus-visible') && show(e.currentTarget as HTMLElement, t, kind),
  onBlur: (e: FocusEvent) => e.target === e.currentTarget && hide(),
});
export { hide as unpeek };

/** The popover: under the row, or over it where there is not room under, and never on it. It takes no pointer and no
 *  keyboard, so it is gone with whatever made it. */
export function Peek() {
  const { t, left, top, bottom, width, room, kind } = peek;
  const now = t && (records.thoughts.get(t.id) ?? t);
  if (!now) return null;
  const lead = 32, w = Math.min(width - lead, 560), under = room - bottom >= Math.min(260, top);
  return (
    <div class="cd-peek" role="tooltip" style={{ left: `${left + lead}px`, width: `${w}px`, ...(under ? { top: `${bottom + 6}px` } : { bottom: `${room - top + 6}px` }) }}>
      <Body t={now} kind={kind} />
    </div>
  );
}

const seconds = (t: string) => (t.trim().endsWith('ms') ? parseFloat(t) / 1000 : parseFloat(t));

/** A card that becomes a row, and a row that becomes a card, changes its height over the time of a sheet, so that what
 *  is under it does not jump. Nothing moves where there is no change, or where the person asks for no motion. */
export function useSettle(ref: RefObject<HTMLElement | null>, card: boolean) {
  const was = useRef<{ card: boolean; h: number; m: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight, m = parseFloat(getComputedStyle(el).marginTop), before = was.current;
    was.current = { card, h, m };
    if (!before || before.card === card || before.h === h || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const style = getComputedStyle(document.documentElement);
    el.style.overflow = 'hidden';
    el.animate([{ height: `${before.h}px`, marginBlock: `${before.m}px`, opacity: 0.5 }, { height: `${h}px`, marginBlock: `${m}px`, opacity: 1 }],
      { duration: seconds(style.getPropertyValue('--t-sheet')) * 1000 || 220, easing: style.getPropertyValue('--ease').trim() || 'ease' })
      .finished.then(() => (el.style.overflow = ''), () => (el.style.overflow = ''));
  });
}
