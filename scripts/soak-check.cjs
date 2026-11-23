// A soak of the ambient layer: Home, shown in the window in use, with agents working, so the light breathes, the band
// drifts and swells and the sidebar's glyphs sway, left alone for a while. It must cost at the end what it cost at the start:
// nothing it makes may pile up. Renders the workspace page from ui/dist on fixture records, counts what the page owns
// (elements, canvases, running animations, timers and frame callbacks it has pending, WebGL objects made and not
// deleted, the heap) and times its frames, early and at the end, and fails if any of them grew.
// usage: node scripts/soak-check.cjs [seconds, 150 by default]   (exit status 1 on a failure; ui/dist must be built)
const path = require('node:path');
const { serve, open, GPU } = require('./motion-pages.cjs');
const { scene } = require('./instrument-fixtures.cjs');

/** Counts what the page asks for from here on: timers and frame callbacks pending, WebGL objects alive. */
const COUNT = () => {
  const c = (window.__soak = { timers: new Set(), frames: new Set(), gl: {}, raf: window.requestAnimationFrame.bind(window) });
  const { setTimeout: st, clearTimeout: ct, setInterval: si, clearInterval: ci, requestAnimationFrame: raf, cancelAnimationFrame: caf } = window;
  window.setTimeout = (f, ms, ...a) => { const id = st(() => { c.timers.delete(id); f(...a); }, ms); c.timers.add(id); return id; };
  window.clearTimeout = (id) => { c.timers.delete(id); ct(id); };
  window.setInterval = (f, ms, ...a) => { const id = si(f, ms, ...a); c.timers.add(`i${id}`); return id; };
  window.clearInterval = (id) => { c.timers.delete(`i${id}`); ci(id); };
  window.requestAnimationFrame = (f) => { const id = raf((t) => { c.frames.delete(id); f(t); }); c.frames.add(id); return id; };
  window.cancelAnimationFrame = (id) => { c.frames.delete(id); caf(id); };
  for (const k of ['Texture', 'Framebuffer', 'Renderbuffer', 'Program', 'Shader', 'Buffer', 'VertexArray']) {
    const P = WebGL2RenderingContext.prototype, make = P[`create${k}`], drop = P[`delete${k}`];
    c.gl[k] = 0;
    P[`create${k}`] = function (...a) { c.gl[k]++; return make.apply(this, a); };
    P[`delete${k}`] = function (...a) { if (a[0]) c.gl[k]--; return drop.apply(this, a); };
  }
};
/** Where a glyph's sway has it now, in px (its `translate`), or none where the glyph is not there or has no sway yet. */
const SWAY = () => {
  const g = document.querySelector('.spark .glyph.in .turn'), t = g ? parseFloat(getComputedStyle(g).translate) : NaN;
  return Number.isFinite(t) ? t : null;
};
/** Whether a glyph is swaying: it is there and its place changes within a second and a half. */
const SWAYS = () => new Promise((done) => {
  const from = performance.now(), first = window.__sway();
  const look = () => {
    const now = window.__sway();
    if (first !== null && now !== null && now !== first) return done(true);
    if (performance.now() - from > 1500) return done(false);
    setTimeout(look, 50);
  };
  look();
});
/** What the page holds now, and how its frames came over two seconds; and how evenly a glyph moved from frame to frame:
 *  on how many frames it had a sway at all, on how many of them it had moved since the one before, and the largest step it
 *  took in the steps it usually takes, of those that moved (a motion that stops and starts takes a jump after a stall).
 *  A step of nothing is no step: a glyph's sway is carried at its own pace, which a machine's frames may outnumber. */
const SAMPLE = () => new Promise((done) => {
  const c = window.__soak, at = [], from = performance.now(), drawn = window.__motion.stats.frames + window.__motion.stats.keys, where = [];
  const tick = (t) => {
    at.push(t);
    where.push(window.__sway());
    if (performance.now() - from < 2000) return c.raf(tick);
    const gaps = at.slice(1).map((x, i) => x - at[i]).sort((a, b) => a - b);
    const have = where.filter((w) => w !== null), moved = have.slice(1).map((x, i) => Math.abs(x - have[i])).filter((x) => x > 0);
    const usual = [...moved].sort((a, b) => a - b)[moved.length >> 1] ?? 0;
    done({
      elements: document.querySelectorAll('*').length, canvases: document.querySelectorAll('canvas').length, animations: document.getAnimations().length,
      timers: c.timers.size, callbacks: c.frames.size, webgl: Object.values(c.gl).reduce((a, b) => a + b, 0), heap: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e5) / 10,
      frame: Math.round((gaps[gaps.length >> 1] ?? 0) * 10) / 10, worst: Math.round((gaps[gaps.length - 1] ?? 0) * 10) / 10, drawn: (window.__motion.stats.frames + window.__motion.stats.keys - drawn) / 2,
      swaying: have.length, frames: where.length, moves: moved.length, jump: usual ? Math.round((Math.max(...moved) / usual) * 10) / 10 : 0,
    });
  };
  c.raf(tick);
});
module.exports = { COUNT, SAMPLE };

async function main(seconds) {
  const { chromium } = require('playwright');
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true, args: GPU });
  const failures = [];
  try {
    const page = await open(browser, { label: 'workspace', records: scene('quiet'), url: server.url, dpr: 1 });
    await page.evaluate(COUNT);
    await page.evaluate(`window.__sway = ${String(SWAY)}`);
    // The layer rests unless something goes on in the window in use: agents are working, and this window is that one.
    await page.evaluate(() => (Object.assign(window.__motion.debug, { state: 'working', active: true }), window.__motion.redraw()));
    // A region taking focus and the sidebar sliding are part of a day: each once, early, so what they leave is counted.
    await page.evaluate(() => (window.__ws.greet('main'), window.__ws.command('sidebar')));
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__ws.command('sidebar'));
    await page.waitForTimeout(13500);
    // The glyphs come with the layer and sway once they are in: sampled once one does, not at a time of the clock's.
    let swaying = false;
    for (let waited = 0; !swaying && waited < 30000; waited += 1500) swaying = await page.evaluate(SWAYS);
    if (!swaying) failures.push('no glyph of the sidebar swayed in 45 s of the layer moving, so nothing was measured of its steps');
    const first = await page.evaluate(SAMPLE);
    console.log(`after 15 s    ${JSON.stringify(first)}`);
    let last = first;
    for (let t = 15; t < seconds; t += 45) {
      await page.waitForTimeout(Math.min(45, seconds - t) * 1000 - 2000);
      last = await page.evaluate(SAMPLE);
      console.log(`after ${String(Math.min(seconds, t + 45)).padEnd(4)} s  ${JSON.stringify(last)}`);
    }
    const frames = await page.evaluate(() => window.__motion.stats.frames + window.__motion.stats.keys);
    if (!first.animations || frames < seconds / 4) failures.push(`the ambient layer was not moving (${first.animations} animations, ${frames} frames and keyframes of the band), so nothing was soaked`);
    for (const [k, room] of [['elements', 2], ['canvases', 1], ['animations', 4], ['timers', 2], ['callbacks', 2], ['webgl', 0]])
      if (last[k] > first[k] + room) failures.push(`${k} grew from ${first[k]} to ${last[k]}`);
    if (last.frame > first.frame * 1.25 + 2) failures.push(`a frame takes ${last.frame} ms where it took ${first.frame} ms`);
    for (const [at, v] of [['first', first], ['last', last]])
      if (v.moves < 5) failures.push(`a glyph did not sway in the ${at} sample: it had a sway on ${v.swaying} of ${v.frames} frames and moved on ${v.moves}`);
    if (Math.max(first.jump, last.jump) > 5) failures.push(`a glyph does not move evenly: its largest step is ${Math.max(first.jump, last.jump)} of its usual ones (first ${first.jump}, last ${last.jump}; it moved on ${first.moves} and ${last.moves} of ${first.frames} and ${last.frames} frames)`);
    for (const e of page.errors) failures.push(e);
    await page.context().close();
  } finally {
    await browser.close();
    await server.close();
  }
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? 'FAIL  the ambient layer does not hold steady' : `PASS  after ${seconds} s moving, the ambient layer holds what it held at the start: elements, canvases, animations, timers, WebGL objects and the time a frame takes, and its glyphs move evenly from frame to frame`);
  process.exitCode = failures.length ? 1 : 0;
}
if (require.main === module) main(Number(process.argv[2]) || 150).catch((e) => (console.error(e), process.exit(1)));
