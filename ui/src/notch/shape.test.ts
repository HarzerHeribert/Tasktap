// The notch's outline stays one closed, simple shape across its parameters and at every step of
// an opening. Run by `npm run check` with Node's own test runner.
import assert from 'node:assert/strict';
import test from 'node:test';
import { type Display, SHEET_CORNER, mix, outline, path, polygon, type Shape, shapeFor, temperaments, type Temperament } from './shape.ts';

type P = [number, number];
const cross = (o: P, a: P, b: P) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
/** Whether two segments cross or touch (collinear overlaps included). */
function meet(a: P, b: P, c: P, d: P) {
  const [d1, d2, d3, d4] = [cross(c, d, a), cross(c, d, b), cross(a, b, c), cross(a, b, d)];
  const e = 1e-9;
  if (((d1 > e && d2 < -e) || (d1 < -e && d2 > e)) && ((d3 > e && d4 < -e) || (d3 < -e && d4 > e))) return true;
  const on = (p: P, q: P, r: P) =>
    Math.abs(cross(p, q, r)) <= e && Math.min(p[0], q[0]) - e <= r[0] && r[0] <= Math.max(p[0], q[0]) + e &&
    Math.min(p[1], q[1]) - e <= r[1] && r[1] <= Math.max(p[1], q[1]) + e;
  return on(c, d, a) || on(c, d, b) || on(a, b, c) || on(a, b, d);
}

/** A closed polygon that never crosses or touches itself, wound one way, with no point above `top`. */
function simple(s: Shape, lift: number, label: string) {
  const pts = polygon(outline(s, lift), 8).filter((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1]![0], p[1] - all[i - 1]![1]) > 1e-7);
  for (const p of pts) assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]), `${label}: finite`);
  assert.ok(pts.every((p) => p[1] >= -lift - 1e-9 && p[1] <= Math.max(1, s.depth) + 1e-9), `${label}: within the top edge and the depth`);
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // the closing edge meets the first one at the start
      assert.ok(!meet(pts[i]!, pts[(i + 1) % n]!, pts[j]!, pts[(j + 1) % n]!), `${label}: edges ${i} and ${j} meet`);
    }
  }
  // Clockwise on screen, which with y down is a negative shoelace area.
  const area = pts.reduce((a, p, i) => a + p[0] * pts[(i + 1) % n]![1] - pts[(i + 1) % n]![0] * p[1], 0) / 2;
  assert.ok(area < 0, `${label}: wound one way, with area`);
  const d = path(outline(s, lift));
  assert.ok(/^M[^MZ]+Z$/.test(d), `${label}: one closed subpath`);
}

test('the outline is closed and simple across its parameters', () => {
  for (const half of [1, 6, 30, 52, 110, 216])
    for (const depth of [1, 6, 16, 38, 320])
      for (const run of [0, 2, 9, 18, 60])
        for (const [shoulder, drop] of [[0, 0], [3, 3], [11, 18], [40, 6], [6, 200]])
          for (const tension of [0, 0.4, 0.55, 1])
            for (const corner of [0, 4, 18, 80])
              for (const lift of [0, 4]) {
                const s = { x: 7, half, depth, run, shoulder: shoulder!, drop: drop!, tension, corner };
                simple(s, lift, JSON.stringify({ ...s, lift }));
              }
});

test('every step between collapsed and open is closed and simple, on both kinds of display', () => {
  const displays: Display[] = [
    { cutout: false, width: 104, height: 16, corner: 4, sheetWidth: 400, sheetOffset: 0 },
    { cutout: false, width: 120, height: 20, corner: 5, sheetWidth: 432, sheetOffset: 0 },
    { cutout: false, width: 104 + 2 * 60, height: 16, corner: 4, sheetWidth: 400, sheetOffset: -30 },
    { cutout: true, width: 220, height: 38, corner: 9.5, sheetWidth: 432, sheetOffset: 0 },
    { cutout: true, width: 220 + 2 * 40, height: 32, corner: 8, sheetWidth: 432, sheetOffset: 12 },
  ];
  for (const d of displays)
    for (const t of Object.keys(temperaments) as Temperament[])
      for (const bottom of [d.height, 120, 640]) {
        const [a, b] = [shapeFor(d, t, false, 0), shapeFor(d, t, true, bottom)];
        for (let i = 0; i <= 40; i++) {
          // Overshoot both ways too: a spring or a reversed fold may pass either end.
          const k = -0.1 + (1.2 * i) / 40;
          simple(mix(a, b, Math.max(0, k)), 0, `${t} ${JSON.stringify(d)} ${bottom} at ${k}`);
          simple(mix(a, b, Math.max(0, k)), 30, `${t} lifted at ${k}`);
        }
      }
});

test('the collapsed tab keeps its width where the counts sit and the cutout its own shape', () => {
  const plain = shapeFor({ cutout: false, width: 104, height: 16, corner: 4, sheetWidth: 400, sheetOffset: 0 }, 'medium', false, 0);
  assert.equal(plain.half * 2 + plain.run, 104);
  const cutout = shapeFor({ cutout: true, width: 220, height: 38, corner: 9.5, sheetWidth: 432, sheetOffset: 0 }, 'medium', false, 0);
  assert.deepEqual([cutout.half, cutout.depth, cutout.run, cutout.corner], [110, 38, 0, 9.5]);
  // The housing's sides are upright from the top edge to its corners: the outline passes through
  // both ends of its bottom edge's straight part.
  const pts = polygon(outline(cutout), 8);
  assert.ok(pts.some(([x, y]) => Math.abs(x + 110) < 1e-9 && Math.abs(y - (38 - 9.5)) < 1e-9));
  assert.ok(pts.some(([x, y]) => Math.abs(x - (110 - 9.5)) < 1e-9 && Math.abs(y - 38) < 1e-9));
});

test('open on a display without a cutout, the sheet is a plain rectangle hanging from the top edge', () => {
  const d: Display = { cutout: false, width: 120, height: 20, corner: 5, sheetWidth: 432, sheetOffset: -12 };
  for (const t of Object.keys(temperaments) as Temperament[]) {
    const open = shapeFor(d, t, true, 300);
    assert.deepEqual([open.run, open.shoulder, open.drop], [0, 0, 0], t);
    // Every point above the bottom corners lies on one of the two upright sides, from the top edge down.
    const pts = polygon(outline(open), 8);
    const sides = pts.filter(([, y]) => y <= 300 - SHEET_CORNER + 1e-9);
    assert.ok(sides.length >= 4 && sides.every(([x]) => Math.abs(Math.abs(x + 12) - 216) < 1e-9), t);
    assert.ok(sides.some(([, y]) => y === 0) && sides.some(([, y]) => Math.abs(y - (300 - SHEET_CORNER)) < 1e-9), t);
    // Its lean goes down as it opens, never back up.
    const tab = shapeFor(d, t, false, 0);
    let last = Infinity;
    for (let i = 0; i <= 20; i++) {
      const s = mix(tab, open, i / 20);
      const lean = s.run + s.shoulder + s.drop;
      assert.ok(lean <= last + 1e-9, `${t} at ${i}`);
      last = lean;
    }
  }
});
