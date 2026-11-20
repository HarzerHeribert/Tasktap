// The pace of the page's loops (pace.ts) on the displays people have: how many frames a second it draws, and that a
// display of about 60 loses none. Run by `npm run check` with Node's own test runner.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Pace } from './pace.ts';

/** A display's frames for `seconds`: on a grid, or wandering about it (a callback's time, up to `jitter` ms off), or
 *  each gap its own (`walk`: the gaps of the Mac's panel, 13 to 19 ms at 60). */
function frames(hz: number, { seconds = 60, jitter = 0, walk = 0 } = {}) {
  let seed = 7, t = 0;
  const r = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648, T = 1000 / hz, out: number[] = [];
  for (let i = 0; t < seconds * 1000; i++) {
    out.push(walk ? t : i * T + (r() - 0.5) * 2 * jitter);
    t = walk ? t + T - walk + r() * 2 * walk : (i + 1) * T;
  }
  return out.sort((a, b) => a - b);
}
function drawn(stream: number[], seconds = 60) {
  const p = new Pace(), at: number[] = [];
  for (const t of stream) if (p.take(t)) at.push(t);
  // After its first tenth of a second, which may spend the interval and a half the loop has in hand when it starts.
  const gaps = at.slice(1).map((t, i) => t - at[i]!).filter((_, i) => at[i]! - at[0]! > 100);
  return { rate: at.length / seconds, longest: Math.max(...gaps), shortest: Math.min(...gaps) };
}

test('no display is drawn more than 60 times a second', () => {
  for (const hz of [70, 75, 90, 100, 120, 144, 165, 240, 360]) {
    const d = drawn(frames(hz));
    assert.ok(d.rate <= 60.05, `${hz} Hz: ${d.rate} a second`);
    assert.ok(d.rate >= 59.9, `${hz} Hz: ${d.rate} a second, fewer than the display allows`);
  }
  for (const [hz, jitter] of [[120, 3], [240, 3], [144, 2]] as const) {
    const d = drawn(frames(hz, { jitter }));
    assert.ok(d.rate <= 60.05 && d.rate >= 59.9, `${hz} Hz off by ${jitter} ms: ${d.rate} a second`);
  }
});

test('a display of 120 or 240 is drawn in every second or every fourth frame, evenly, once under way', () => {
  for (const hz of [120, 240]) {
    const d = drawn(frames(hz));
    assert.ok(Math.abs(d.longest - 1000 / 60) < 0.01 && Math.abs(d.shortest - 1000 / 60) < 0.01, `${hz} Hz: ${d.shortest} to ${d.longest} ms apart`);
  }
});

test('a display of about 60 is drawn in every frame it gives, however uneven', () => {
  for (const s of [frames(60), frames(59.94), frames(60.05), frames(60.2), frames(60, { jitter: 3 }), frames(60, { walk: 3 })]) {
    const p = new Pace();
    s.forEach((t, i) => assert.ok(p.take(t), `frame ${i} of ${s.length} at ${t.toFixed(2)} ms not drawn`));
  }
});

test('the first frame after a rest is drawn at once, and the same frame asked twice gets the same answer', () => {
  const p = new Pace();
  assert.ok(p.take(1000));
  assert.ok(!p.take(1004.2));
  assert.ok(!p.take(1004.2));
  assert.ok(p.take(1200));
  assert.ok(p.take(1200));
});
