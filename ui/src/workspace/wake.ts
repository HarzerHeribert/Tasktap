// The wake: when an edge sweeps across the window (the sidebar opening or closing, a sheet dropping), it sheds a few
// of the product's glyphs, the same chrome ones that stand at the sidebar's foot, one after another as it passes. Each
// is left just behind where the edge was at that moment, drifts a little the way the edge went, turns slightly, slows
// and is gone, the oldest first, before the words of what was revealed have come in: a short wake, not a scatter. Every glyph is large enough to read as its character, each
// has a band of the edge to itself so none overlap, and all of it is opacity and transform on pictures drawn once.
// Nothing remains at rest; none under Reduce Motion or with the ambient light off.
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

/** `el` has begun to slide by its own size (`x`: its right edge moves across; `y`: its bottom edge moves down). Glyphs
 *  are shed behind that edge as it passes each of their places, until it rests. `look`: null for none. */
export function wake(el: HTMLElement, axis: 'x' | 'y', look: Look | null) {
  if (!look || reduced.matches) return;
  const x = axis === 'x', edge = () => el.getBoundingClientRect()[x ? 'right' : 'bottom'];
  const rest = el.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };
  const along = x ? el.offsetWidth : el.offsetHeight, across = x ? el.offsetHeight : el.offsetWidth;
  const from = edge(), n = Math.max(3, Math.min(SIZES.length, Math.round(across / 160)));
  const layer = document.createElement('div');
  layer.className = 'wake';
  layer.setAttribute('aria-hidden', 'true');
  // A sheet comes from behind the title bar: so does its wake.
  if (!x) layer.style.top = `${rest.top + el.offsetTop}px`;
  document.body.append(layer);
  const top = layer.getBoundingClientRect().top, ratio = devicePixelRatio || 1;
  let shed = 0;
  const frame = () => {
    const at = el.isConnected ? edge() : from, went = Math.abs(at - from), way = Math.sign(at - from) || 1;
    for (; shed < n && went >= ((shed + 0.5) / n) * along; shed++) {
      // Its place along the edge: the even bands first, then the odd, so neighbours in time are never neighbours in place.
      const band = shed * 2 < n ? shed * 2 : (shed - Math.ceil(n / 2)) * 2 + 1, size = SIZES[shed]!;
      const src = picture(KINDS[shed]!, look);
      if (!src) continue;
      const g = document.createElement('canvas');
      g.width = g.height = Math.round(size * ratio);
      const c = g.getContext('2d')!;
      c.imageSmoothingQuality = 'high';
      c.drawImage(src, 0, 0, g.width, g.height);
      const off = ((band + 0.5 + 0.3 * Math.sin(band * 2.4 + 1)) / n) * across + (x ? el.offsetTop + rest.top : el.offsetLeft - el.offsetWidth / 2 + rest.left);
      const behind = at - way * size * 0.9;
      Object.assign(g.style, { width: `${size}px`, height: `${size}px`, left: `${(x ? behind : off) - size / 2}px`, top: `${(x ? off : behind) - size / 2 - top}px` });
      layer.append(g);
      const drift = way * (20 + 4 * (shed % 3)), turn = (shed % 2 ? -1 : 1) * way, move = (d: number, r: number, s: number) =>
        `translate${x ? 'X' : 'Y'}(${d}px) rotate(${r}deg) scale(${s})`;
      g.animate({ transform: [move(-drift * 0.4, -10 * turn, 0.86), move(drift, 12 * turn, 1)] }, { duration: LIFE, easing: EASE, fill: 'both' });
      // In quickly, held, then out quickly: a glyph is never left half there over what the person reads.
      g.animate([{ opacity: 0, easing: 'ease-out' }, { opacity: 0.95, offset: 0.18 }, { opacity: 0.9, offset: 0.55, easing: 'ease-in' }, { opacity: 0 }], { duration: LIFE, fill: 'both' });
    }
    if (shed < n && el.isConnected && el.getAnimations().length) requestAnimationFrame(frame);
    else setTimeout(() => layer.remove(), LIFE + 50);
  };
  requestAnimationFrame(frame);
}
