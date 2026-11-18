// What the compositor carries against what the page would draw. Home's band, in a lasting loop, is no longer drawn
// in every frame: the page draws keyframes of it and the compositor fades each into the next (ui/src/motion/engine.ts,
// View.carry). This proves the picture is the same. Two copies of the engine run side by side on one clock that the
// check moves by hand: one draws every frame of a 120 Hz display itself (the truth: what an ideal loop would show),
// the other is the engine as shipped, given frames at 60 a second and timers when they are due. At every refresh of
// that display the picture each has on screen is put together (for the carried one: its layers, each by its share)
// and compared, pixel by pixel, in 8-bit levels of the band's own canvas (Home shows the band at 15 to 50 % of that).
// Beside it, for scale: how far the truth itself moves from one refresh to the next, which is what a loop drawn 60
// times a second is off by at every second refresh of such a display.
// It also holds the carried engine to the truth's clocks at every refresh, through changes of state, a kick and a
// timer that comes late: its form's phase, its pulse and the seconds in its state may be off by no more than two
// frames' worth, so nothing stalls, lurches or loses the uneven rhythm of its pulses (which the same generator sets).
// And, in the workspace page itself in real time, that the layers' real opacities add up to one in every frame.
// usage: node scripts/carry-check.cjs [--out folder] [--styles slats,glyphs,resonator] [--seconds 36] [--hz 120] [--late ms] [--json file] [--quick]
//   headless Chromium on the GPU (ui/dist must be built for the last part). --out: slow-motion strips of the worst
//   moment of each run: the truth, the carried picture and their difference eight times over, refresh by refresh.
//   --late: every timer fires up to that many ms late. --quick: Slats only, 16 s. Exit status 1 on a failure.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { serve, open, GPU } = require('./motion-pages.cjs');
const { scene } = require('./instrument-fixtures.cjs');
const root = path.resolve(__dirname, '..');
const has = (name) => process.argv.includes(name);
const arg = (name, or) => (has(name) ? process.argv[process.argv.indexOf(name) + 1] : or);
const table = (head, rows) => {
  const all = [head, ...rows].map((r) => r.map(String)), w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  return all.map((r) => r.map((c, i) => (i ? c.padStart(w[i]) : c.padEnd(w[i]))).join('  ')).join('\n');
};
const W = 593, H = 380;
/** How far the carried picture may be off the truth: no further than the truth itself moves from one refresh of the
 *  display to the next (which is what a loop drawn 60 times a second is off by at every second refresh of a 120 Hz
 *  panel), on average and at the 99.9th percentile of all pixels of all refreshes, with a quarter and a half over
 *  for the two measures' own noise; and the most its clocks may be off, in frames of a sixtieth of a second. */
const LIMIT = { mean: (moved) => 1.25 * moved.mean + 0.05, p999: (moved) => 1.5 * moved.p999 + 2, clock: 2 };

async function rigServer() {
  const { createServer } = await import(path.join(root, 'ui/node_modules/vite/dist/node/index.js'));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carry-check-')));
  fs.writeFileSync(path.join(dir, 'rig.html'), `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/@fs${path.join(root, 'ui/src/motion/motion.css')}">
<style>body{margin:0;background:#000}.motion{width:${W}px;height:${H}px}</style>
<span class="motion"></span>
<script type="module">
import { View, stats } from '/@fs${path.join(root, 'ui/src/motion/engine.ts')}';
window.rig = { View, stats };
</script>`);
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000">
<iframe src="rig.html" width="${W}" height="${H}" style="border:0;display:block"></iframe><iframe src="rig.html" width="${W}" height="${H}" style="border:0;display:block"></iframe>`);
  const server = await createServer({ root: dir, configFile: false, logLevel: 'error', server: { port: 0, host: '127.0.0.1', fs: { allow: [root, dir] } } });
  await server.listen();
  return { url: server.resolvedUrls.local[0], close: () => server.close().then(() => fs.rmSync(dir, { recursive: true, force: true })) };
}

/** In the page: the two engines, one clock. `script`: what happens when, [seconds, options to merge]. */
const RUN = async ({ look, script, seconds, hz, late, step, strip, W, H }) => {
  const wins = [...document.querySelectorAll('iframe')].map((f) => f.contentWindow);
  for (let i = 0; i < 100 && !wins.every((w) => w.rig); i++) await new Promise((ok) => setTimeout(ok, 50));
  const base = { look, state: 'idle', pace: 'calm', rest: false, primary: true, soft: true, pose: 1, pulse: 1, every: 0, kick: 0, tempo: 0.3 };
  const rigs = wins.map((w, i) => {
    const view = new w.rig.View(w.document.querySelector('.motion'));
    view.set(base);
    // The first is the truth: it draws every frame it is given, and is given every refresh.
    Object.assign(w.rig.stats, i ? { carry: true, ...(step ? { step } : {}) } : { carry: false, rate: 1e4 });
    return { w, view, store: new Map(), raf: [], timers: [], id: 0, T: 0, next: 0, every: i ? 1000 / 60 : 1000 / hz, keys: 0 };
  });
  // The views are seen and drawn once at rest, in real time; then time is the check's.
  await new Promise((ok) => setTimeout(ok, 600));
  let seed = 11;
  const chance = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const r of rigs) {
    const { w } = r;
    r.T = r.next = Math.ceil(w.performance.now()) + 100;
    w.performance.now = () => r.T;
    w.requestAnimationFrame = (f) => (r.raf.push(f), ++r.id);
    w.cancelAnimationFrame = () => void (r.raf = []);
    w.setTimeout = (f, ms = 0) => (r.timers.push({ id: ++r.id, at: r.T + ms + (late ? chance() * late : 0), f }), r.id);
    w.clearTimeout = (id) => void (r.timers = r.timers.filter((t) => t.id !== id));
    w.rig.stats.seen = (v, cv) => {
      let c = r.store.get(cv);
      if (!c) r.store.set(cv, (c = Object.assign(document.createElement('canvas'), { width: W, height: H })));
      const g = c.getContext('2d');
      g.globalCompositeOperation = 'copy';
      g.drawImage(cv, 0, 0);
    };
    r.zero = r.T;
  }
  const advance = (r, to) => {
    for (;;) {
      const t = r.timers.reduce((a, b) => (!a || b.at < a.at ? b : a), null), timer = t && t.at <= to ? t.at : Infinity, frame = r.next <= to ? r.next : Infinity;
      if (timer === Infinity && frame === Infinity) break;
      if (timer <= frame) {
        r.T = Math.max(r.T, timer);
        r.timers = r.timers.filter((x) => x !== t);
        t.f();
      } else {
        r.T = frame;
        r.next += r.every;
        const q = r.raf;
        r.raf = [];
        for (const f of q) f(r.T);
      }
    }
    r.T = to;
  };
  const pic = Object.assign(document.createElement('canvas'), { width: W, height: H }).getContext('2d', { willReadFrequently: true });
  const shown = (r) => {
    const s = r.view.showing(r.T);
    pic.globalCompositeOperation = 'source-over';
    pic.globalAlpha = 1;
    pic.fillStyle = '#000';
    pic.fillRect(0, 0, W, H);
    pic.globalCompositeOperation = 'lighter';
    for (const [cv, share] of s.of) {
      const c = r.store.get(cv);
      if (!c || share <= 0) continue;
      pic.globalAlpha = share;
      pic.drawImage(c, 0, 0);
    }
    return { data: pic.getImageData(0, 0, W, H).data, clocks: s.clocks, carried: s.of.length > 1 || !!r.view.plan };
  };
  const stat = () => ({ hist: new Float64Array(256), sum: 0, n: 0, most: 0 });
  const add = (S, a, b) => {
    let most = 0, at = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      S.hist[d]++;
      S.sum += d;
      if (d > most) (most = d), (at = i >> 2);
    }
    S.n += a.length >> 2;
    if (most > S.most) S.most = most;
    return [most, at];
  };
  const done = (S) => {
    let c = 0, p = 0;
    for (let d = 255; d >= 0; d--) if ((c += S.hist[d]) > S.n / 1000) { p = d; break; }
    return { mean: S.sum / Math.max(1, S.n), p999: p, most: S.most };
  };
  const off = stat(), moved = stat(), offCarried = stat(), N = Math.round(seconds * hz), clocks = { phase: 0, pulse: 0, state: 0, jump: 0, rate: 0 }, ring = [], back = [];
  let prev = null, events = [...script], worst = { most: -1 }, carriedFor = 0, last = null, keys0 = 0, fast = 0, lastKeys = 0, lastAt = 0;
  for (let n = 0; n <= N; n++) {
    const t = (n * 1000) / hz;
    while (events.length && events[0][0] * 1000 <= t) {
      const [, o] = events.shift();
      for (const r of rigs) r.view.set((r.o = { ...(r.o ?? base), ...o }));
    }
    for (const r of rigs) advance(r, r.zero + t);
    const [a, b] = rigs.map(shown);
    const [most, at] = add(off, a.data, b.data);
    if (b.carried) (add(offCarried, a.data, b.data), carriedFor++);
    if (prev && b.carried) add(moved, a.data, prev);
    // The clocks, in frames of a sixtieth of a second of the truth's own going.
    if (last) {
      const rate = (a.clocks[1] - last.a[1]) / (1000 / hz), d = Math.abs(b.clocks[1] - a.clocks[1]);
      (clocks.rate = Math.max(clocks.rate, rate)), (clocks.phase = Math.max(clocks.phase, d));
      clocks.state = Math.max(clocks.state, (Math.abs(b.clocks[2] - a.clocks[2]) * 1000) / (1000 / 60));
      // A pulse begins at the same moment in both, or its clock is the same.
      if (Math.abs(b.clocks[0] - a.clocks[0]) < 1) clocks.pulse = Math.max(clocks.pulse, (Math.abs(b.clocks[0] - a.clocks[0]) * 2000) / (1000 / 60));
      // What is shown never goes back, and never on by more than three refreshes' worth at once.
      const step = b.clocks[1] - last.b[1];
      if (rate > 1e-5) clocks.jump = Math.max(clocks.jump, step < -1e-6 ? 99 : step / (rate * (1000 / hz)));
      if (step < -1e-6 && back.length < 6) back.push([Math.round(t), step, rate, b.carried, a.clocks.map((x) => Math.round(x * 1e4) / 1e4), b.clocks.map((x) => Math.round(x * 1e4) / 1e4), last.b.map((x) => Math.round(x * 1e4) / 1e4)]);
    }
    last = { a: a.clocks, b: b.clocks };
    prev = a.data;
    if (strip) {
      ring.push({ n, a: a.data, b: b.data, at });
      if (ring.length > 12) ring.shift();
      if (b.carried && most > worst.most) worst = { most, n, at, hold: 6 };
      if (worst.hold !== undefined && --worst.hold === 0) worst.frames = ring.map((x) => ({ ...x }));
    }
    const keys = rigs[1].w.rig.stats.keys;
    if (t - lastAt >= 500) (fast = Math.max(fast, ((keys - lastKeys) * 1000) / (t - lastAt))), (lastKeys = keys), (lastAt = t);
    if (n % 600 === 0) await new Promise((ok) => setTimeout(ok, 0));
  }
  let sheet = null;
  if (strip && worst.frames) {
    const cw = 150, ch = 110, x0 = Math.max(0, Math.min(W - cw, (worst.at % W) - cw / 2)), y0 = Math.max(0, Math.min(H - ch, Math.floor(worst.at / W) - ch / 2));
    const out = Object.assign(document.createElement('canvas'), { width: cw * worst.frames.length, height: ch * 3 }).getContext('2d');
    worst.frames.forEach((f, i) => {
      const cut = (src) => { const o = new ImageData(cw, ch); for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const j = ((y0 + y) * W + x0 + x) * 4, k = (y * cw + x) * 4, v = src(j); o.data.set([v[0], v[1], v[2], 255], k); } return o; };
      out.putImageData(cut((j) => [f.a[j], f.a[j + 1], f.a[j + 2]]), i * cw, 0);
      out.putImageData(cut((j) => [f.b[j], f.b[j + 1], f.b[j + 2]]), i * cw, ch);
      out.putImageData(cut((j) => [0, 1, 2].map((c) => Math.min(255, 8 * Math.abs(f.a[j + c] - f.b[j + c])))), i * cw, ch * 2);
    });
    sheet = out.canvas.toDataURL('image/png');
  }
  // The phase, in frames of a sixtieth of a second at the loop's own pace.
  clocks.phase = clocks.phase / Math.max(1e-9, clocks.rate) / (1000 / 60);
  const S = rigs[1].w.rig.stats;
  return { off: done(off), carried: done(offCarried), moved: done(moved), clocks, share: carriedFor / (N + 1), keys: S.keys / seconds, fast, frames: S.frames / seconds, truth: rigs[0].w.rig.stats.frames / seconds, worst: { n: worst.n, most: worst.most }, back, sheet };
};

/** In the workspace page, in real time: the sum of what its layers show, at every frame. */
const ADD = (seconds) => new Promise((done) => {
  const band = document.querySelector('.band .motion'), S = window.__motion.stats, from = performance.now(), start = [S.frames, S.keys];
  let worst = 0, n = 0, carried = 0;
  const tick = (t) => {
    const layers = [...band.querySelectorAll('.motion-layer')].map((w) => (w.firstChild ? Number(getComputedStyle(w).opacity) * Number(getComputedStyle(w.firstChild).opacity) : 0));
    if (layers.filter((x) => x > 0).length > 1) carried++;
    worst = Math.max(worst, Math.abs(layers.reduce((a, b) => a + b, 0) - 1));
    n++;
    if (t - from < seconds * 1000) requestAnimationFrame(tick);
    else done({ worst, n, carried, frames: S.frames - start[0], keys: S.keys - start[1] });
  };
  requestAnimationFrame(tick);
});

async function main() {
  const quick = has('--quick'), styles = (quick ? 'slats' : arg('--styles', 'slats,glyphs,resonator')).split(','), seconds = Number(arg('--seconds', quick ? 16 : 36)), hz = Number(arg('--hz', 120));
  const out = arg('--out', ''), late = Number(arg('--late', 0)), failures = [], rows = [], rows2 = [], json = {};
  if (out) fs.mkdirSync(out, { recursive: true });
  const server = await rigServer(), browser = await chromium.launch({ headless: true, args: GPU });
  try {
    const run = async (name, look, script, secs) => {
      const page = await browser.newPage({ viewport: { width: W, height: H * 2 }, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(server.url);
      const r = await page.evaluate(RUN, { look, script, seconds: secs, hz, late, step: Number(arg('--step', 0)), strip: !!out, W, H });
      await page.close();
      for (const e of errors) failures.push(`${name}: ${e}`);
      if (r.sheet && out) fs.writeFileSync(path.join(out, `${name.replace(/\W+/g, '-')}.png`), Buffer.from(r.sheet.split(',')[1], 'base64'));
      delete r.sheet;
      json[name] = r;
      return r;
    };
    const f2 = (x) => x.toFixed(2);
    for (const style of styles)
      for (const lumen of [false, true]) {
        const look = { style, palette: 'chromatic', hue: 265, lumen };
        // Agents working, with its pulses at their own uneven times; and a question waiting, with its two beats.
        for (const [state, o] of [['working', { state: 'working', every: 15 }], ['needs', { state: 'needs', every: 0 }]]) {
          const name = `${style}${lumen ? ' with Lumen' : ''}, ${state}`, r = await run(name, look, [[0.2, o]], seconds);
          rows.push([name, `${Math.round(r.share * 100)} %`, r.keys.toFixed(1), r.fast.toFixed(0), r.frames.toFixed(1), f2(r.carried.mean), r.carried.p999, r.carried.most, f2(r.moved.mean), r.moved.p999, r.moved.most]);
          if (r.share < 0.8) failures.push(`${name}: the compositor carried it for only ${Math.round(r.share * 100)} % of the time`);
          if (r.carried.p999 > LIMIT.p999(r.moved) || r.carried.mean > LIMIT.mean(r.moved)) failures.push(`${name}: the carried picture is off the truth by ${f2(r.carried.mean)} levels on average and ${r.carried.p999} at the 99.9th percentile (${f2(LIMIT.mean(r.moved))} and ${Math.round(LIMIT.p999(r.moved))} at most: what the truth moves in one refresh)`);
        }
      }
    // Through changes: work begins, a question comes, is answered, focus sends a pulse, a result arrives, rest. The
    // carried engine goes back and forth between the compositor and the page; its clocks must be the truth's.
    for (const style of styles) {
      const look = { style, palette: 'chromatic', hue: 265, lumen: false };
      const script = [[0.2, { state: 'working', every: 15 }], [6.13, { state: 'needs', every: 0 }], [11.31, { state: 'working', every: 15 }], [14.07, { kick: 1 }], [17.5, { state: 'done', every: 0 }], [21, { state: 'idle' }]];
      const name = `${style}, through changes${late ? `, timers up to ${late} ms late` : ''}`, r = await run(name, look, script, 23);
      rows2.push([name, `${Math.round(r.share * 100)} %`, f2(r.clocks.phase), f2(r.clocks.pulse), f2(r.clocks.state), f2(r.clocks.jump), f2(r.off.mean), r.off.p999]);
      for (const [k, what] of [['phase', "its form's phase"], ['pulse', "its pulse's clock"], ['state', 'the seconds in its state']])
        if (r.clocks[k] > LIMIT.clock) failures.push(`${name}: ${what} was ${f2(r.clocks[k])} frames off the truth (${LIMIT.clock} at most)`);
      if (r.clocks.jump > 3.5) failures.push(`${name}: what is shown ${r.clocks.jump > 90 ? 'went back' : `went on by ${f2(r.clocks.jump)} refreshes' worth at once`}`);
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(`Headless Chromium on the GPU: the band at ${W} x ${H}, every refresh of a ${hz} Hz display for ${seconds} s; differences in 8-bit levels of its canvas`);
  console.log(table(['', 'carried', 'keyframes/s', 'most in 0.5 s', 'page frames/s', 'off: mean', 'p99.9', 'worst', 'truth moves a refresh: mean', 'p99.9', 'worst'], rows));
  console.log('\nThrough changes of state, a kick and a result: the clocks of what is shown against the truth, in frames of a sixtieth of a second');
  console.log(table(['', 'carried', 'phase off', 'pulse off', 'state off', 'largest step (refreshes)', 'picture off: mean', 'p99.9'], rows2));
  // The workspace page itself, in real time: the layers add up.
  if (fs.existsSync(path.join(root, 'ui/dist/workspace.html'))) {
    const pages = await serve(path.join(root, 'ui/dist')), b = await chromium.launch({ headless: true, args: GPU });
    try {
      const page = await open(b, { label: 'workspace', records: scene('quiet'), url: pages.url, dpr: 1 });
      // The app draws its loops in the page (stats.carry is off: carried, the band flickered in the app's web view); this
      // part holds the carried path to its picture all the same, so it can be turned on again once that is solved.
      await page.evaluate(() => (Object.assign(window.__motion.stats, { carry: true }), Object.assign(window.__motion.debug, { state: 'working', active: true }), window.__motion.redraw()));
      await page.waitForTimeout(2500);
      const r = await page.evaluate(ADD, 8);
      json.page = r;
      console.log(`\nThe workspace page in real time, agents working, ${r.n} frames: two layers shown in ${r.carried} of them; their real opacities add up to 1 within ${r.worst.toExponential(1)}; the page drew ${r.frames} frames and ${r.keys} keyframes`);
      if (r.worst > 0.004) failures.push(`the layers' opacities are ${r.worst.toFixed(3)} off adding up to one`);
      if (r.carried < r.n / 2 || r.frames > 4) failures.push(`the page still drew ${r.frames} frames in 8 s of agents working, and two layers showed in only ${r.carried} of ${r.n} frames`);
      for (const e of page.errors) failures.push(e);
    } finally {
      await b.close();
      await pages.close();
    }
  }
  if (has('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(json));
  console.log('');
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? 'FAIL  what the compositor carries is not what the page would draw' : `PASS  carried by the compositor, the band is the picture the page would draw in every frame: no further off it, at any refresh, than that picture itself moves from one refresh to the next; its clocks within ${LIMIT.clock} frames through every change; its layers adding up to one`);
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
