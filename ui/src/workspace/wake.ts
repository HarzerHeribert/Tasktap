// The wake: a moving edge sheds a few of the product's glyphs, the same chrome ones that stand at the sidebar's foot,
// one after another as it passes their places. A wake is what an edge leaves behind it, so it lies where the edge has
// just been: left of the sidebar's edge as it opens and right of it as it closes, above a sheet's edge as it drops.
// Each glyph is large enough to read as its character, has a place to itself, trails the edge a little way, turns
// slightly and is gone, the oldest first: a short wake, not a scatter. All of it is opacity and transform on pictures
// drawn once. Nothing remains at rest; none under Reduce Motion or with the ambient light off.
import { type Look, still } from '../motion/engine.ts';

/** The glyphs in the order they are shed: their sizes in CSS pixels, and which character each is (plus, slash,
 *  colon, equals): the colon, the slightest of them, is the largest. */
const SIZES = [36, 30, 40, 32, 28, 38], KINDS = [0, 2, 3, 1, 0, 2];
const LIFE = 520, EASE = 'cubic-bezier(.19,.76,.19,1)';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

/** The four characters in chrome, drawn once for a look. */
let pictures: { look: string; of: (HTMLCanvasElement | null)[] } | null = null;
function picture(k: number, look: Look) {
  const key = JSON.stringify(look);
  if (pictures?.look !== key) pictures = { look: key, of: [0, 1, 2, 3].map((c) => still('glyph', look, 'idle', 192, c, 0.6)) };
  return pictures.of[k];
}

/** `el`'s edge has begun to move: its right edge across the window (`x`, the sidebar) or its lower edge along it
 *  (`y`, a sheet), by `el`'s own size. Glyphs are shed behind that edge, whichever way it travels, as it passes each
 *  of their places, until it rests. `span`: the part of the edge that sheds, in window pixels (the sidebar's foot,
 *  where no row is, so a glyph crosses none of its words); all of it otherwise. `look`: null for none. */
export function wake(el: HTMLElement, axis: 'x' | 'y', look: Look | null, span?: [number, number]) {
  if (!look || reduced.matches) return;
  const x = axis === 'x', box = () => el.getBoundingClientRect(), edge = () => box()[x ? 'right' : 'bottom'];
  const first = box(), along = x ? first.width : first.height;
  const [from, to] = span ?? (x ? [first.top, first.bottom] : [first.left, first.right]);
  if (to - from < 84) return;
  const n = Math.min(SIZES.length, Math.max(to - from < 300 ? 2 : 3, Math.round((to - from) / 160)));
  const layer = document.createElement('div');
  layer.className = 'wake';
  layer.setAttribute('aria-hidden', 'true');
  // A sheet comes from behind the title bar: so does its wake.
  const top = x ? 0 : first.bottom - first.height;
  layer.style.top = `${top}px`;
  document.body.append(layer);
  const start = edge(), ratio = devicePixelRatio || 1;
  let shed = 0, last = start, rested = 0, frames = 0;
  const frame = () => {
    const at = el.isConnected ? edge() : last, went = Math.abs(at - start);
    // The way the edge travels says which side is behind it.
    const way = Math.sign(at - start) || 1;
    rested = at === last ? rested + 1 : 0;
    last = at;
    // The first is shed once the edge has gone far enough for a whole glyph to lie behind it; the rest through its way.
    for (; shed < n && went >= (0.28 + (0.62 * shed) / n) * along; shed++) {
      const size = SIZES[shed]!, src = picture(KINDS[shed]!, look);
      if (!src) continue;
      const g = document.createElement('canvas');
      g.width = g.height = Math.round(size * ratio);
      const c = g.getContext('2d')!;
      c.imageSmoothingQuality = 'high';
      c.drawImage(src, 0, 0, g.width, g.height);
      // Its place along the edge: the even bands first, then the odd, so neighbours in time are never neighbours in place.
      const band = shed * 2 < n ? shed * 2 : (shed - Math.ceil(n / 2)) * 2 + 1;
      const off = from + size / 2 + ((band + 0.5 + 0.3 * Math.sin(band * 2.4 + 1)) / n) * (to - from - size);
      // Behind the edge by its own size, and trailing it: it follows a little way, slower than the edge, and never
      // reaches it. A sheet's stay wholly on the sheet.
      const drift = way * (14 + 3 * (shed % 3));
      const behind = x ? at - way * size : Math.max(top + size / 2 + 4 + 0.4 * drift, Math.min(first.bottom - size / 2 - 4 - drift, at - way * size));
      Object.assign(g.style, { width: `${size}px`, height: `${size}px`, left: `${(x ? behind : off) - size / 2}px`, top: `${(x ? off : behind) - size / 2 - top}px` });
      layer.append(g);
      const turn = (shed % 2 ? -1 : 1) * way, move = (d: number, r: number, s: number) => `translate${x ? 'X' : 'Y'}(${d}px) rotate(${r}deg) scale(${s})`;
      g.animate({ transform: [move(-drift * 0.4, -10 * turn, 0.86), move(drift, 12 * turn, 1)] }, { duration: LIFE, easing: EASE, fill: 'both' });
      // In quickly, held, then out quickly: a glyph is never left half there over what the person reads.
      g.animate([{ opacity: 0, easing: 'ease-out' }, { opacity: 0.95, offset: 0.18 }, { opacity: 0.9, offset: 0.55, easing: 'ease-in' }, { opacity: 0 }], { duration: LIFE, fill: 'both' });
    }
    if (shed < n && el.isConnected && (rested < 4 || !went) && ++frames < 120) requestAnimationFrame(frame);
    else setTimeout(() => layer.remove(), LIFE + 50);
  };
  requestAnimationFrame(frame);
}
