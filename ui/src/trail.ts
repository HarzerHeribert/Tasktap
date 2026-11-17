// The wiper's trail: when an edge sweeps across the window (the sidebar opening or closing, a sheet dropping), it
// leaves a short trail of tiny glyphs on the surface it passes, which fade within a moment, like the residue behind a
// wiper blade. The glyphs are the product's own characters, drawn as text with a metal gradient so they are crisp at
// any size; each is an element made for the sweep and removed after it, moved only by opacity and transform. Nothing
// remains at rest; none under Reduce Motion or with the ambient light off.
const GLYPHS = '+=/:';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

export type Sweep = {
  /** The surface the edge crosses, in the window's coordinates. */
  box: { left: number; top: number; width: number; height: number };
  /** Which way the edge moves: across (`x`, left to right or back) or down (`y`). */
  axis: 'x' | 'y';
  /** The edge travels from the box's start to its end, or back. */
  back?: boolean;
  /** Milliseconds the edge takes. */
  ms: number;
  /** How many glyphs at most. */
  count?: number;
};

export function trail(s: Sweep, on = true) {
  if (!on || reduced.matches) return;
  const layer = document.createElement('div');
  layer.className = 'trail';
  layer.setAttribute('aria-hidden', 'true');
  Object.assign(layer.style, { left: s.box.left + 'px', top: s.box.top + 'px', width: s.box.width + 'px', height: s.box.height + 'px' });
  const n = s.count ?? 28;
  const along = s.axis === 'x' ? s.box.width : s.box.height, across = s.axis === 'x' ? s.box.height : s.box.width;
  let last = 0;
  for (let i = 0; i < n; i++) {
    // Where the edge was when this glyph was left: denser near where the edge ends, thinning behind it.
    const t = Math.pow(Math.random(), 0.6), at = (s.back ? 1 - t : t) * along;
    const off = Math.random() * across;
    const g = document.createElement('i');
    g.textContent = GLYPHS[Math.floor(Math.random() * GLYPHS.length)]!;
    const size = 7 + Math.round(Math.random() * 4);
    Object.assign(g.style, {
      left: (s.axis === 'x' ? at : off) + 'px', top: (s.axis === 'x' ? off : at) + 'px', fontSize: size + 'px',
    });
    layer.append(g);
    const delay = t * s.ms, life = 260 + Math.random() * 200, turn = (Math.random() < 0.5 ? -1 : 1) * 90;
    last = Math.max(last, delay + life);
    g.animate(
      [
        { opacity: 0, transform: 'rotate(0deg) scale(.6)' },
        { opacity: 0.9, transform: `rotate(${turn * 0.3}deg) scale(1)`, offset: 0.2 },
        { opacity: 0, transform: `rotate(${turn}deg) scale(.8)` },
      ],
      { duration: life, delay, easing: 'cubic-bezier(.19,.76,.19,1)', fill: 'both' },
    );
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), last + 50);
}
