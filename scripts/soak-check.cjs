// A soak of the ambient layer: Home, shown in the window in use, with nothing running, so the light breathes, the band
// swells and the sidebar's glyphs sway, left alone for a while. It must cost at the end what it cost at the start:
// nothing it makes may pile up. Renders the workspace page from ui/dist on fixture records, counts what the page owns
// (elements, canvases, running animations, timers and frame callbacks it has pending, WebGL objects made and not
// deleted, the heap) and times its frames, early and at the end, and fails if any of them grew.
// usage: node scripts/soak-check.cjs [seconds, 150 by default]   (exit status 1 on a failure; ui/dist must be built)
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
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
/** What the page holds now, and how its frames came over two seconds. */
const SAMPLE = () => new Promise((done) => {
  const c = window.__soak, at = [], from = performance.now(), drawn = window.__motion.stats.frames;
  const tick = (t) => {
    at.push(t);
    if (performance.now() - from < 2000) return c.raf(tick);
    const gaps = at.slice(1).map((x, i) => x - at[i]).sort((a, b) => a - b);
    done({
      elements: document.querySelectorAll('*').length, canvases: document.querySelectorAll('canvas').length, animations: document.getAnimations().length,
      timers: c.timers.size, callbacks: c.frames.size, webgl: Object.values(c.gl).reduce((a, b) => a + b, 0), heap: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e5) / 10,
      frame: Math.round((gaps[gaps.length >> 1] ?? 0) * 10) / 10, worst: Math.round((gaps[gaps.length - 1] ?? 0) * 10) / 10, drawn: (window.__motion.stats.frames - drawn) / 2,
    });
  };
  c.raf(tick);
});
module.exports = { COUNT, SAMPLE };

async function main(seconds) {
  const { chromium } = require('playwright');
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true });
  const failures = [];
  try {
    const page = await open(browser, { label: 'workspace', records: scene('quiet'), url: server.url, dpr: 1 });
    await page.evaluate(COUNT);
    // A region taking focus and the sidebar sliding are part of a day: each once, early, so what they leave is counted.
    await page.evaluate(() => (window.__ws.greet('main'), window.__ws.command('sidebar')));
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__ws.command('sidebar'));
    await page.waitForTimeout(13500);
    const first = await page.evaluate(SAMPLE);
    console.log(`after 15 s    ${JSON.stringify(first)}`);
    let last = first;
    for (let t = 15; t < seconds; t += 45) {
      await page.waitForTimeout(Math.min(45, seconds - t) * 1000 - 2000);
      last = await page.evaluate(SAMPLE);
      console.log(`after ${String(Math.min(seconds, t + 45)).padEnd(4)} s  ${JSON.stringify(last)}`);
    }
    const frames = await page.evaluate(() => window.__motion.stats.frames);
    if (!first.animations || frames < seconds / 4) failures.push(`the ambient layer was not moving (${first.animations} animations, ${frames} frames of the band), so nothing was soaked`);
    for (const [k, room] of [['elements', 2], ['canvases', 1], ['animations', 4], ['timers', 2], ['callbacks', 2], ['webgl', 0]])
      if (last[k] > first[k] + room) failures.push(`${k} grew from ${first[k]} to ${last[k]}`);
    if (last.frame > first.frame * 1.25 + 2) failures.push(`a frame takes ${last.frame} ms where it took ${first.frame} ms`);
    for (const e of page.errors) failures.push(e);
    await page.context().close();
  } finally {
    await browser.close();
    await server.close();
  }
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? 'FAIL  the ambient layer does not hold steady' : `PASS  after ${seconds} s moving, the ambient layer holds what it held at the start: elements, canvases, animations, timers, WebGL objects and the time a frame takes`);
  process.exitCode = failures.length ? 1 : 0;
}
if (require.main === module) main(Number(process.argv[2]) || 150).catch((e) => (console.error(e), process.exit(1)));
