// The notch's silhouette. One outline makes the black shape, the glow's mask behind it and the
// host's hit region, collapsed, open and at every step between. Units are CSS pixels (AppKit
// points): x from the tab's centre line, y down from the screen's top edge.

/** A strip of the top edge pressed down: each side leaves the top edge with an easing, runs
 *  straight down and in, and turns into the bottom edge with a rounded corner. */
export type Shape = {
  /** The centre, from the tab's centre line. */
  x: number;
  /** Half the bottom edge, to where a side would meet it without its corner. */
  half: number;
  depth: number;
  /** How far each side leans out between the bottom edge and the top edge; 0 is upright. */
  run: number;
  /** The easing where a side leaves the top edge: how far out along the edge it starts, how far
   *  down the side it ends, and its handles' share of those lengths (about 0.55 is a circular
   *  arc; less keeps the middle straighter, like a short slope with soft ends). */
  shoulder: number;
  drop: number;
  tension: number;
  /** The radius of the two bottom corners. */
  corner: number;
};

/** A straight step `[x, y]` or a cubic one `[x1, y1, x2, y2, x, y]`. */
type Step = number[];
export type Outline = { start: [number, number]; steps: Step[] };

/**
 * The closed outline, clockwise on screen from the top edge left of the shape. `lift` carries
 * both ends straight up past the top edge, for a glow source that does not stop at the screen's
 * edge, and for a hit region that holds the top row of pixels.
 */
export function outline(s: Shape, lift = 0): Outline {
  const half = Math.max(1, s.half);
  const depth = Math.max(1, s.depth);
  const run = Math.max(0, s.run);
  const side = Math.hypot(run, depth);
  const [ux, uy] = [run / side, depth / side];
  // Each side turns by the same angle where it leaves the top edge and where it meets the bottom.
  const turn = Math.atan2(depth, run);
  const tan = Math.tan(turn / 2);
  // Tangent lengths: a corner keeps to its half of the bottom edge, and the shoulder and the
  // corner share a side too short for both, so no easing can fold the outline over itself.
  let corner = Math.min(Math.max(0, s.corner) * tan, half);
  let drop = Math.max(0, s.drop);
  if (corner + drop > side) [corner, drop] = [(corner * side) / (corner + drop), (drop * side) / (corner + drop)];
  // A shoulder that cannot leave the top edge would lie along it.
  const shoulder = drop > 0 ? Math.max(0, s.shoulder) : 0;
  const e = Math.min(1, Math.max(0, s.tension));
  const k = arc(turn);
  const [lt, lb] = [s.x - half - run, s.x - half];
  const [rt, rb] = [s.x + half + run, s.x + half];
  const steps: Step[] = [];
  if (lift > 0) steps.push([lt - shoulder, 0]);
  steps.push(
    [lt - shoulder * (1 - e), 0, lt + drop * ux * (1 - e), drop * uy * (1 - e), lt + drop * ux, drop * uy],
    [lb - corner * ux, depth - corner * uy],
    [lb - corner * ux * (1 - k), depth - corner * uy * (1 - k), lb + corner * (1 - k), depth, lb + corner, depth],
    [rb - corner, depth],
    [rb - corner * (1 - k), depth, rb + corner * ux * (1 - k), depth - corner * uy * (1 - k), rb + corner * ux, depth - corner * uy],
    [rt - drop * ux, drop * uy],
    [rt - drop * ux * (1 - e), drop * uy * (1 - e), rt + shoulder * (1 - e), 0, rt + shoulder, 0],
  );
  if (lift > 0) steps.push([rt + shoulder, -lift]);
  return { start: [lt - shoulder, -lift], steps };
}

/** A circular arc's handle as a share of its tangent length, for an arc turning by `turn`. */
const arc = (turn: number) => ((4 / 3) * Math.tan(turn / 4)) / Math.tan(turn / 2);

const n = (v: number) => String(Math.round(v * 100) / 100);

/** The outline as an SVG or CSS `path()` string, moved by `dx`, `dy`. */
export function path(o: Outline, dx = 0, dy = 0) {
  const p = (x: number | undefined, y: number | undefined) => `${n((x ?? 0) + dx)} ${n((y ?? 0) + dy)}`;
  let d = 'M' + p(...o.start);
  for (const s of o.steps) d += s.length === 2 ? 'L' + p(s[0], s[1]) : 'C' + p(s[0], s[1]) + ' ' + p(s[2], s[3]) + ' ' + p(s[4], s[5]);
  return d + 'Z';
}

/** The outline as a polygon, each curve in `segments` straight pieces. */
export function polygon(o: Outline, segments = 6): [number, number][] {
  const out: [number, number][] = [o.start];
  for (const s of o.steps) {
    if (s.length === 2) {
      out.push([s[0]!, s[1]!]);
      continue;
    }
    const [x0, y0] = out[out.length - 1]!;
    const [x1, y1, x2, y2, x3, y3] = s as [number, number, number, number, number, number];
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const [a, b, c, d] = [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
      out.push([a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3]);
    }
  }
  return out;
}

export const mix = (a: Shape, b: Shape, t: number): Shape => ({
  x: a.x + (b.x - a.x) * t,
  half: a.half + (b.half - a.half) * t,
  depth: a.depth + (b.depth - a.depth) * t,
  run: a.run + (b.run - a.run) * t,
  shoulder: a.shoulder + (b.shoulder - a.shoulder) * t,
  drop: a.drop + (b.drop - a.drop) * t,
  tension: a.tension + (b.tension - a.tension) * t,
  corner: a.corner + (b.corner - a.corner) * t,
});

/** CSS's cubic-bezier() timing function, so a tween in script moves as the page's transitions do. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x: number) => {
    let [lo, hi, t] = [0, 1, x];
    for (let i = 0; i < 24; i++) {
      t = (lo + hi) / 2;
      if (at(x1, x2, t) < x) lo = t;
      else hi = t;
    }
    return at(y1, y2, t);
  };
}

/**
 * The tab on a display without a camera cutout, in three temperaments: how far the sides lean
 * (run, as a share of the depth), the radius of the easing where they leave the top edge, and
 * the bottom corners'. Open, it is a plain rectangle hanging from the top edge: its lean and its
 * easing go to nothing as it opens, so the sides stand upright all the way up.
 */
export const temperaments = {
  shallow: { run: 1.15, ease: 7, corner: 6 },
  medium: { run: 0.72, ease: 5, corner: 4.5 },
  steep: { run: 0.4, ease: 3, corner: 3 },
};
export type Temperament = keyof typeof temperaments;

/** The easing where the camera housing's upright sides leave the top edge: out along the edge,
 *  down the side, and nearly straight between, like the sloped tab's. */
export const HOUSING = { shoulder: 6, drop: 11, tension: 0.42 };
/** The open sheet's bottom corners: --r3. */
export const SHEET_CORNER = 10;

/** What the host says about the display: the tab (the cutout, or the tab on a display without
 *  one), widened by the glance's wings, and where the open sheet sits. */
export type Display = { cutout: boolean; width: number; height: number; corner: number; sheetWidth: number; sheetOffset: number };

/** The shape the notch takes: collapsed on its tab, or open down to `bottom`. On a display with
 *  a cutout the tab is the housing, so it keeps the hardware's own upright sides and corners. */
export function shapeFor(d: Display, temperament: Temperament, open: boolean, bottom: number): Shape {
  const t = temperaments[temperament];
  const sheet = { x: d.sheetOffset, half: d.sheetWidth / 2, depth: bottom, run: 0, corner: SHEET_CORNER };
  if (d.cutout) {
    if (open) return { ...sheet, ...HOUSING };
    return { x: 0, half: d.width / 2, depth: d.height, run: 0, corner: d.corner, ...HOUSING };
  }
  // The tab's width is kept at half its depth, where the wings' counts sit.
  const run = t.run * d.height;
  const turn = Math.atan2(d.height, run);
  const ease = t.ease * Math.tan(turn / 2);
  // Open, no lean and no easing at all; the tab's handles stay, so every step between eases alike.
  if (open) return { ...sheet, shoulder: 0, drop: 0, tension: arc(turn) };
  return { x: 0, half: d.width / 2 - run / 2, depth: d.height, run, shoulder: ease, drop: ease, tension: arc(turn), corner: t.corner };
}
