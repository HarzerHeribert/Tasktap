// The notch's black shape and the light behind it, both cut from one outline (shape.ts) and moved
// together on every frame of an opening, a fold or a change of wings. The light is a blurred,
// coloured copy of the outline under the black, so only what leaks past the edge is seen; while
// it breathes only its layers' opacity and a gradient's position change, on the compositor.
import { call, fail, ui } from './model.ts';
import { cubicBezier, type Display, mix, outline, path, polygon, type Shape, shapeFor, type Temperament } from './shape.ts';

/** The shape's temperament on a display without a cutout, and the light's treatment. The debug
 *  channel may change both to compare them: `eval notch __look({shape:'steep',glow:'warm'})`. */
export const look = { shape: 'medium' as Temperament, glow: 'chromatic' as 'chromatic' | 'warm' | 'cool' };

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
/** --t-notch-open and --t-notch-fold in tokens.css. */
const unfold = { ms: 510, ease: cubicBezier(0.19, 0.76, 0.19, 1) };
const refold = { ms: 320, ease: cubicBezier(0.45, 0, 0.5, 1) };
/** How far the light's source reaches above the top edge, so the light beside the shape is as
 *  strong along the screen's edge as below it. */
const LIFT = 10;

let now: Shape | null = null;
let tween: { from: Shape; to: Shape; start: number; ms: number; ease: (x: number) => number } | null = null;
let frame = 0;
let hit = '';

const same = (a: Shape, b: Shape) => (Object.keys(a) as (keyof Shape)[]).every((k) => Math.abs(a[k] - b[k]) < 0.01);

/** The shape for the notch as the page shows it now: collapsed on the tab (`line` deeper while it says who asks), or
 *  open to `bottom`. */
export function place(open: boolean, bottom: number, line = 0) {
  const m = ui.geometry;
  if (!m || typeof m.width !== 'number') return;
  const d: Display = {
    cutout: m.cutout === true, width: m.width, height: (m.height as number) + (open ? 0 : line), corner: m.corner as number,
    sheetWidth: m.surfaceWidth as number, sheetOffset: m.surfaceOffset as number,
  };
  const next = shapeFor(d, look.shape, open, bottom);
  // The host tests the pointer against the shape the notch is heading for.
  const points = polygon(outline(next, 4), 4).flat().map((v) => Math.round(v * 2) / 2);
  if (points.join() !== hit) {
    hit = points.join();
    void call('host.notch', { hit: points }).catch(fail);
  }
  const to = tween?.to ?? now;
  if (to && same(to, next)) return draw();
  if (!now || reduceMotion.matches) {
    now = next;
    tween = null;
    return draw();
  }
  // A shape that grows (opening, wings arriving) decelerates as the sheet does; one that shrinks folds.
  const motion = next.depth + next.half > now.depth + now.half ? unfold : refold;
  tween = { from: now, to: next, start: performance.now(), ms: motion.ms, ease: motion.ease };
  if (!frame) frame = requestAnimationFrame(step);
}

function step(t: number) {
  if (!tween) return void (frame = 0);
  const p = Math.min(1, Math.max(0, (t - tween.start) / tween.ms));
  now = mix(tween.from, tween.to, tween.ease(p));
  draw();
  if (p < 1) frame = requestAnimationFrame(step);
  else [frame, tween] = [0, null];
}

/** Cuts the black shape and the light's source from the shape as it is now. Both elements sit
 *  on the tab's centre line, `--art-half` to each side, so a window that grows or shrinks around
 *  the tab never moves them. */
function draw() {
  const art = document.getElementById('notch-art');
  const m = ui.geometry;
  if (!art || !now || !m) return;
  const half = Math.ceil((m.span as number) / 2 + Math.abs(m.surfaceOffset as number));
  // The light grows with the shape: a tab's is close and bright, an open sheet's wider and softer.
  const size = Math.min(1, Math.max(0, (now.depth - (m.height as number)) / 240));
  const vars = { '--art-half': half, '--lift': LIFT, '--far': 9 + 3 * size, '--near': 4 + 2 * size };
  for (const [k, v] of Object.entries(vars)) art.style.setProperty(k, v.toFixed(2) + 'px');
  art.style.setProperty('--near-level', (0.55 - 0.25 * size).toFixed(3));
  const fill = `path('${path(outline(now), half, 0)}')`;
  const light = `path('${path(outline(now, LIFT), half, LIFT)}')`;
  for (const el of art.querySelectorAll<HTMLElement>('.notch-fill')) el.style.clipPath = fill;
  for (const el of art.querySelectorAll<HTMLElement>('.glow i')) el.style.clipPath = light;
}

/** The black shape, and while something needs the person the light behind it: a wide halo and
 *  a close core, each a blurred copy of the outline filled with a slowly drifting gradient. With
 *  Lumen on, the gradient is the motion's palette (`tint`), so the notch's light and Home's agree. */
export function Art({ glowing, tint }: { glowing: boolean; tint?: string }) {
  return (
    <div id="notch-art" aria-hidden="true" data-glow={tint ? 'motion' : look.glow} style={tint ? { '--colors': tint } : undefined}>
      {glowing && (
        <div class="glow-set">
          <div class="glow glow-halo"><i /></div>
          <div class="glow glow-core"><i /></div>
        </div>
      )}
      <div class="notch-fill" />
    </div>
  );
}
