// The look, before and after a change that must not change it (the graphics processor's cost, 2026-11-19): the same
// pictures and the same frames from two builds of the pages (ui/dist), compared pixel by pixel. Headless Chromium on
// fixture records. Everything that could differ from one run to the next is held: the date, Math.random (the light's
// grain is random), and the page's own clock (performance.now, frames, timers), which this script moves by hand, so
// that the motion settles through the same frames in both builds; endless CSS animations stand at their start.
//   stills  Home in every form, palette and effects level; every state of the motion at each level; each text size;
//           Lumen; the busy, quiet and first Homes, a workspace and the sidebar away; at one and two pixels to a
//           point; and the notch and its tab (folded, working, glowing for a question, open on it, capture, a result)
//           with a camera cutout and without
//   motion  Home's band in its loops at Full, on a display of --hz (240): every frame either build draws
//           (engine.ts stats.seen), compared at the moments both draw
//   slide   the sidebar sliding, at each effects level: how often each build drew the band and gave its canvas a new
//           size in a slide each way (frames given at 60 a second), eight moments of the slide (its animation held at
//           each) as a film strip, and the band at rest after it
//   glow    the notch's glow for a question at fixed moments of its animations
// Writes <out>/<before|after>/..., <out>/diff/... and <out>/report.json; says what differs. Exit status 1 when a
// still or a motion frame differs that --expect does not name.
// usage: node scripts/same-look.cjs <out> --before <dist> --after <dist> [--only stills,motion,slide,glow]
//        [--quick] [--jobs 4] [--gpu] [--hz 240] [--expect name,name-prefix*] [--reuse]
//   --reuse: the before build's pictures already in <out> are taken as they are.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { serve, open, GPU, scene } = require('./motion-pages.cjs');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const arg = (n, or) => (has(n) ? argv[argv.indexOf(n) + 1] : or);
const OUT = path.resolve(argv[0] || '');
const BUILDS = { before: arg('--before'), after: arg('--after') };
const ONLY = (arg('--only', 'stills,motion,slide,glow')).split(',');
const QUICK = has('--quick'), JOBS = Number(arg('--jobs', 4)), HZ = Number(arg('--hz', 240));
const EXPECT = (arg('--expect', '')).split(',').filter(Boolean);
if (require.main === module && (!argv[0] || !BUILDS.before || !BUILDS.after)) {
  console.error('usage: node scripts/same-look.cjs <out> --before <dist> --after <dist> [--only stills,motion,slide,glow] [--quick] [--jobs 4] [--gpu] [--hz 240] [--expect a,b*]');
  process.exit(2);
}
const expected = (name) => EXPECT.some((e) => (e.endsWith('*') ? name.startsWith(e.slice(0, -1)) : name === e));

/** The date every page reads. */
const FIXED = new Date('2026-11-19T15:00:00Z');
/** In the page, before its own scripts: Math.random from one seed, and the page's clock (performance.now, frames,
 *  timers) held until `__clock.run` moves it: through `ms`, giving frames on a grid of `hz` while any is asked for
 *  and going straight to the next timer when none is; `live` does the same at the pace of real time. `debug`: the
 *  motion's debug settings (motion.tsx), in force from the first picture: the workspace page sets `__motion` once it
 *  has rendered, and is drawn again at once with them. */
const INIT = (debug, clock) => {
  let s = 1234567;
  Math.random = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  if (!clock) return;
  const real = { st: setTimeout.bind(window) };
  const q = { T: 1000, raf: [], timers: [], id: 0, frames: 0 };
  performance.now = () => q.T;
  window.requestAnimationFrame = (f) => (q.raf.push({ id: ++q.id, f }), q.id);
  window.cancelAnimationFrame = (id) => void (q.raf = q.raf.filter((r) => r.id !== id));
  const later = (f, ms, a, id = ++q.id) => (q.timers.push({ id, at: q.T + Math.max(0, Number(ms) || 0), f: typeof f === 'function' ? () => f(...a) : () => {} }), id);
  window.setTimeout = (f, ms, ...a) => later(f, ms, a);
  window.setInterval = (f, ms, ...a) => {
    const id = ++q.id, every = Math.max(1, Number(ms) || 0);
    const again = () => (later(tick, every, [], id));
    const tick = () => (f(...a), again());
    return again();
  };
  window.clearTimeout = window.clearInterval = (id) => void (q.timers = q.timers.filter((t) => t.id !== id));
  const settle = async (n) => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };
  const run = async (ms, hz, live) => {
    const end = q.T + ms, step = 1000 / hz;
    let n = 0;
    // What the caller just did (a redraw is a microtask away) asks for its frames first.
    await settle(8);
    for (;;) {
      const t = q.timers.reduce((a, b) => (!a || b.at < a.at ? b : a), null);
      const frame = q.raf.length ? Math.floor(q.T / step + 1e-9 + 1) * step : Infinity, at = Math.min(t ? t.at : Infinity, frame);
      if (at > end) break;
      if (live && at > q.T) await new Promise((ok) => real.st(ok, at - q.T));
      q.T = Math.max(q.T, at);
      if (t && t.at <= frame) {
        q.timers = q.timers.filter((x) => x !== t);
        t.f();
      } else {
        const due = q.raf;
        q.raf = [];
        q.frames++;
        for (const r of due) r.f(q.T);
      }
      await settle(4);
      // Now and then a real task too: what the page waits for outside its clock (its layout's observers).
      if (++n % 8 === 0) await new Promise((ok) => real.st(ok, 0));
    }
    if (live && end > q.T) await new Promise((ok) => real.st(ok, end - q.T));
    q.T = end;
    await new Promise((ok) => real.st(ok, 0));
    return q.frames;
  };
  window.__clock = { q, run: (ms, hz = 60) => run(ms, hz, false), live: (ms, hz = 60) => run(ms, hz, true), task: (ms = 0) => new Promise((ok) => real.st(ok, ms)),
    quiet: () => !q.raf.length && !q.timers.some((t) => t.at - q.T < 300) };
  if (!debug) return;
  let m;
  Object.defineProperty(window, '__motion', {
    configurable: true,
    get: () => m,
    set: (v) => {
      m = v;
      Object.assign(v.debug, debug);
      v.redraw();
    },
  });
};
const init = (debug, clock = true) => `(${INIT})(${JSON.stringify(debug ?? null)}, ${clock});`;
const prefs = (o) => Object.entries(o).filter(([, v]) => v !== undefined).map(([id, value]) => ({ id, value, rev: 1 }));
const LEVELS = ['breathing', 'still', 'off'];
const FORMS = ['slats', 'glyphs', 'resonator'];
const PALETTES = ['chromatic', 'chrome', 'warm', 'cool', 'custom'];
const STATES = ['idle', 'listening', 'thinking', 'working', 'needs', 'done', 'failed'];
const LASTING = new Set(['listening', 'thinking', 'working', 'needs']);
const level = (l) => (l === 'breathing' ? 'full' : l);
/** Seconds of the page's clock a picture is given to come to rest in: a result's moment is 6.4 s, its light 2.5 s. */
const REST = 9000;

// ——— The pictures ———
function stills() {
  const all = [];
  const dprs = QUICK ? [2] : [1, 2];
  const ws = (name, o) => dprs.forEach((dpr) => all.push({ page: 'workspace', name: `${name}@${dpr}x`, dpr, ...o }));
  for (const l of LEVELS)
    for (const style of QUICK ? ['slats'] : FORMS)
      for (const palette of QUICK ? ['chromatic', 'warm'] : PALETTES)
        ws(`home-${level(l)}-${style}-${palette}`, { prefs: { motion_ambient: l, motion_style: style, motion_palette: palette, motion_hue: palette === 'custom' ? 160 : undefined } });
  // At Full a lasting state is a picture only in the window not in use (light.tsx: it rests there).
  for (const l of LEVELS)
    for (const state of STATES) ws(`state-${level(l)}-${state}`, { prefs: { motion_ambient: l }, state, active: !(l === 'breathing' && LASTING.has(state)) });
  for (const l of LEVELS)
    for (const text of ['small', 'large']) ws(`text-${level(l)}-${text}`, { prefs: { motion_ambient: l, text_size: text } });
  for (const l of LEVELS)
    for (const state of ['idle', 'needs']) ws(`lumen-${level(l)}-${state}`, { prefs: { motion_ambient: l, motion_lumen: true }, state, active: !(l === 'breathing' && state === 'needs') });
  for (const l of LEVELS) {
    for (const s of ['busy', 'quiet', 'first']) ws(`scene-${level(l)}-${s}`, { prefs: { motion_ambient: l }, scene: s });
    ws(`workspace-${level(l)}`, { prefs: { motion_ambient: l }, scene: 'workspace', act: (p, r) => p.evaluate((id) => window.__ws.show(id), r.ids.projects.cuegrid) });
    ws(`solo-${level(l)}`, { prefs: { motion_ambient: l }, act: (p) => p.evaluate(() => ((window.__ws.ui.sidebar = false), window.__motion.redraw())) });
  }
  const notch = [
    ['idle', 'quiet', []], ['working', 'normal', []], ['tab-question', 'busy', [], true], ['question', 'busy', [{ do: 'answer' }]],
    ['capture', 'normal', [{ do: 'capture' }]], ['result', 'normal', [{ do: 'hover-enter' }], false, true],
  ];
  for (const l of LEVELS)
    for (const cut of QUICK ? [false] : [true, false])
      for (const [n, sc, act, fold, changes] of notch)
        for (const dpr of dprs) all.push({ page: 'notch', name: `notch-${level(l)}-${cut ? 'cut' : 'plain'}-${n}@${dpr}x`, dpr, cut, act, fold, scene: sc, changes, prefs: { motion_ambient: l } });
  return all;
}

const geometry = (cutout) => ({ do: 'geometry', width: cutout ? 185 : 120, height: cutout ? 32 : 20, cutout, compact: false, surfaceWidth: 420, surfaceOffset: 0, span: 560,
  pixel: 2, corner: 10, offset: 0, available: 700, collapsed: false });

/** Gives the page's clock real time until it asks for no frame and no timer is near: what the web view does aside
 *  (building a style's program, which the motion waits for frame by frame) has come in. */
async function quiet(page) {
  for (let i = 0; i < 80 && !(await page.evaluate(() => window.__clock.quiet())); i++) await page.evaluate(() => window.__clock.live(250));
}
/** Waits until nothing the compositor runs changes any more (transitions and finite animations, on real time) and the
 *  fonts are in; the page's own clock does not move meanwhile. */
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  for (let i = 0; i < 60; i++) {
    const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime)).length);
    if (!running) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(300);
}
/** Every endless animation stands at `at` ms. */
async function freeze(page, at = 0) {
  await page.evaluate((at) => {
    for (const a of document.getAnimations()) {
      if (Number.isFinite(a.effect?.getComputedTiming().endTime)) continue;
      a.pause();
      a.currentTime = at;
    }
  }, at);
  await page.waitForTimeout(200);
}

async function picture(browser, url, s, file) {
  const records = scene(s.scene || 'normal', { now: FIXED.getTime(), changes: !!s.changes });
  records.prefs = prefs(s.prefs || {});
  let page;
  if (s.page === 'notch') {
    page = await open(browser, { label: 'notch', records, url, dpr: s.dpr, viewport: { width: 560, height: 420 }, fixed: FIXED, init: init() });
    await page.evaluate(() => (document.documentElement.style.background = 'radial-gradient(110% 85% at 12% 0%,#41607c 0%,transparent 58%),radial-gradient(80% 80% at 92% 12%,#7b5c72 0%,transparent 52%),#172433'));
    await page.evaluate((g) => window.__fake.emit(g), geometry(s.cut));
    await page.evaluate(() => window.__clock.run(500));
    for (const a of s.act) await page.evaluate((x) => window.__fake.emit(x), a);
    await page.evaluate(() => window.__clock.run(500));
    if (s.fold) await page.evaluate(() => (document.querySelector('#tab').click(), 1));
    await page.evaluate(() => window.__clock.run(1500));
    await quiet(page);
    await settle(page);
    await freeze(page, 1000);
  } else {
    // The window not in use until the records are in: before them the page has the default effects (Full), and in a
    // window in use a lasting state would move the light for as long as that takes.
    page = await open(browser, { label: 'workspace', records, url, dpr: s.dpr, fixed: FIXED, init: init({ state: s.state ?? 'idle', active: false }) });
    await quiet(page);
    await page.evaluate((active) => (Object.assign(window.__motion.debug, { active }), window.__motion.redraw()), s.active ?? true);
    // What changes the layout is taken in (its observers, on the real clock) before the page's own clock moves on.
    if (s.act) await s.act(page, records);
    await page.waitForTimeout(200);
    await page.evaluate((ms) => window.__clock.run(ms, 30), REST);
    await quiet(page);
    await settle(page);
    await freeze(page);
  }
  try {
    await page.screenshot({ path: file, timeout: 90000 });
    return page.errors;
  } finally {
    await page.context().close();
  }
}

/** Pixels that differ between two pictures, and by how much at most (8-bit levels); a picture of where. */
function compare(a, b, diff) {
  const ae = spawnSync('magick', ['compare', '-metric', 'AE', a, b, diff], { encoding: 'utf8' });
  const n = parseFloat(ae.stderr);
  if (!Number.isFinite(n)) return { error: ae.stderr.trim() };
  if (n === 0) {
    fs.rmSync(diff, { force: true });
    return { pixels: 0, peak: 0 };
  }
  const pae = spawnSync('magick', ['compare', '-metric', 'PAE', a, b, 'null:'], { encoding: 'utf8' });
  const box = spawnSync('magick', [a, b, '-compose', 'difference', '-composite', '-threshold', '0', '-format', '%@', 'info:'], { encoding: 'utf8' }).stdout.trim();
  return { pixels: Math.round(n), peak: Math.round(parseFloat(/\(([\d.e-]+)\)/.exec(pae.stderr)?.[1] ?? 'NaN') * 255), box };
}

async function pool(items, jobs, f) {
  let i = 0;
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (i < items.length) await f(items[i++]);
  }));
}

async function runStills(browser, report) {
  const list = stills();
  const out = { total: list.length, same: 0, differ: [], errors: [] };
  for (const [tag, dist] of Object.entries(BUILDS)) {
    const server = await serve(path.resolve(dist));
    fs.mkdirSync(path.join(OUT, tag, 'stills'), { recursive: true });
    let done = 0;
    await pool(list, JOBS, async (s) => {
      const file = path.join(OUT, tag, 'stills', `${s.name}.png`);
      if (has('--reuse') && tag === 'before' && fs.existsSync(file)) return;
      // Once more where it failed (a page held up under load); the second failure is the run's.
      const errs = await picture(browser, server.url, s, file).catch((e) => (console.error(`${tag} ${s.name}: again after ${String(e).split('\n')[0]}`), picture(browser, server.url, s, file)));
      for (const e of errs) out.errors.push(`${tag} ${s.name}: ${e}`);
      if (++done % 50 === 0) console.log(`  ${tag}: ${done} of ${list.length}`);
    });
    await server.close();
  }
  fs.mkdirSync(path.join(OUT, 'diff', 'stills'), { recursive: true });
  for (const s of list) {
    const r = compare(path.join(OUT, 'before', 'stills', `${s.name}.png`), path.join(OUT, 'after', 'stills', `${s.name}.png`), path.join(OUT, 'diff', 'stills', `${s.name}.png`));
    if (r.pixels === 0) out.same++;
    else out.differ.push({ name: s.name, ...r, expected: expected(s.name) });
  }
  report.stills = out;
  console.log(`stills: ${out.same} of ${out.total} identical${out.differ.length ? `; differ: ${out.differ.map((d) => `${d.name} (${d.pixels} px, at most ${d.peak}${d.expected ? ', expected' : ''})`).join(', ')}` : ''}`);
}

// ——— The band's frames ———
/** In the page: a display of `hz` given frames for `seconds` while `script` ([seconds, state]) plays; every frame the
 *  band is drawn in, hashed, and the ones at `keep` moments kept as pictures. */
const DRIVE = async ({ hz, seconds, script, keep }) => {
  const m = window.__motion, q = window.__clock.q, T0 = q.T;
  const pic = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const frames = [];
  m.stats.seen = (view, cv) => {
    if (!view.o.primary) return;
    pic.canvas.width = cv.width;
    pic.canvas.height = cv.height;
    pic.globalCompositeOperation = 'copy';
    pic.drawImage(cv, 0, 0);
    const d = pic.getImageData(0, 0, cv.width, cv.height).data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619);
    const t = Math.round((q.T - T0) * 1000) / 1000;
    frames.push([t, h >>> 0, keep.some((k) => Math.abs(k - t) < 0.01) ? pic.canvas.toDataURL() : null]);
  };
  for (let s = 0; s < script.length; s++) {
    m.debug.state = script[s][1];
    m.redraw();
    await window.__clock.run(((script[s + 1]?.[0] ?? seconds) - script[s][0]) * 1000, hz);
  }
  m.stats.seen = null;
  return { frames };
};

async function runMotion(browser, report) {
  const runs = [];
  for (const style of QUICK ? ['slats'] : FORMS) {
    runs.push({ name: `${style}-working`, prefs: { motion_style: style }, script: [[0, 'working']] });
    runs.push({ name: `${style}-needs`, prefs: { motion_style: style }, script: [[0, 'needs']] });
  }
  if (!QUICK) {
    runs.push({ name: 'slats-thinking', prefs: {}, script: [[0, 'thinking']] });
    runs.push({ name: 'slats-working-to-done', prefs: {}, script: [[0, 'working'], [2, 'done']] });
    runs.push({ name: 'slats-lumen-working', prefs: { motion_lumen: true }, script: [[0, 'working']] });
  }
  const seconds = QUICK ? 2 : 4, keep = [500, 1000, 1500, 2000, 2500, 3000, 3500].filter((k) => k < seconds * 1000);
  const res = {};
  for (const [tag, dist] of Object.entries(BUILDS)) {
    const server = await serve(path.resolve(dist));
    fs.mkdirSync(path.join(OUT, tag, 'motion'), { recursive: true });
    for (const r of runs) {
      const records = scene('quiet', { now: FIXED.getTime() });
      records.prefs = prefs({ motion_ambient: 'breathing', ...r.prefs });
      const page = await open(browser, { label: 'workspace', records, url: server.url, dpr: 1, fixed: FIXED, init: init({ active: false, state: 'idle' }) });
      await quiet(page);
      await page.evaluate(() => (Object.assign(window.__motion.debug, { active: true }), window.__motion.redraw()));
      await page.evaluate((ms) => window.__clock.run(ms, 30), REST);
      await quiet(page);
      await settle(page);
      const got = await page.evaluate(DRIVE, { hz: HZ, seconds, script: r.script, keep });
      for (const [t, , url] of got.frames) if (url) fs.writeFileSync(path.join(OUT, tag, 'motion', `${r.name}-${String(Math.round(t)).padStart(5, '0')}ms.png`), Buffer.from(url.split(',')[1], 'base64'));
      (res[r.name] ??= {})[tag] = got.frames.map(([t, h]) => [t, h]);
      for (const e of page.errors) console.error(`${tag} ${r.name}: ${e}`);
      await page.context().close();
    }
    await server.close();
  }
  const out = {};
  for (const [name, { before, after }] of Object.entries(res)) {
    const a = new Map(before), b = new Map(after);
    const both = [...a.keys()].filter((t) => b.has(t));
    const differ = both.filter((t) => a.get(t) !== b.get(t));
    out[name] = { seconds, hz: HZ, drawn: { before: before.length / seconds, after: after.length / seconds }, compared: both.length, differ: differ.length, first: differ.slice(0, 5) };
    console.log(`motion ${name}: at ${HZ} Hz before drew ${out[name].drawn.before.toFixed(1)} and after ${out[name].drawn.after.toFixed(1)} frames a second; ${both.length} moments both drew, ${differ.length} differ`);
  }
  fs.mkdirSync(path.join(OUT, 'diff', 'motion'), { recursive: true });
  for (const f of fs.readdirSync(path.join(OUT, 'after', 'motion'))) {
    const b = path.join(OUT, 'before', 'motion', f);
    if (fs.existsSync(b)) out[`picture ${f}`] = compare(b, path.join(OUT, 'after', 'motion', f), path.join(OUT, 'diff', 'motion', f));
  }
  report.motion = out;
}

// ——— The sidebar's slide ———
/** In the page, on its own clock (real time): one slide, and half a second after it: how many frames the motion drew,
 *  and how often the band's canvas took a new size, looked at in every frame the page was given. */
const SLIDE = () => new Promise((done) => {
  const m = window.__motion, f0 = m.stats.frames, t0 = performance.now();
  let last = '', resized = 0, given = 0;
  const look = () => {
    const c = document.querySelector('.band canvas'), s = c ? `${c.width}x${c.height}` : '';
    if (s !== last) (resized += last ? 1 : 0), (last = s);
  };
  look();
  window.__ws.command('sidebar');
  const tick = () => {
    given++;
    look();
    if (window.__ws.ui.slide || performance.now() - t0 < 900) requestAnimationFrame(tick);
    else done({ drawn: m.stats.frames - f0, resized, given });
  };
  requestAnimationFrame(tick);
});
/** In the page: the slide closing the sidebar held at `share` of its time, and the page given a few frames there. */
const HOLD = async (share) => {
  if (!window.__ws.ui.slide) {
    window.__ws.command('sidebar');
    await window.__clock.run(1);
  }
  // The slide's own animations, and what started with it (its wake's glyphs), all at the same moment of it.
  const slide = document.querySelector('.win').getAnimations().find((a) => /^side-/.test(a.animationName ?? ''));
  const at = share * Number(slide?.effect.getComputedTiming().duration ?? 0);
  const all = document.getAnimations().filter((a) => a === slide || /^(lead-in)/.test(a.animationName ?? '') || (!(a instanceof CSSAnimation) && !(a instanceof CSSTransition)));
  for (const a of all) {
    a.pause();
    a.currentTime = at;
  }
  // The layout at that moment reaches the motion through its observers, on the real clock; then it is given frames.
  for (let i = 0; i < 2; i++) {
    await window.__clock.task(150);
    await window.__clock.run(50);
  }
  return all.length;
};
const END = async () => {
  await window.__clock.run(1);
  for (const a of document.getAnimations()) if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.finish();
  for (let i = 0; i < 20 && window.__ws.ui.slide; i++) await window.__clock.run(50);
  await window.__clock.run(1000);
};

async function runSlide(browser, report) {
  const out = {};
  const MOMENTS = 8;
  for (const [tag, dist] of Object.entries(BUILDS)) {
    const server = await serve(path.resolve(dist));
    const dir = path.join(OUT, tag, 'slide');
    fs.mkdirSync(dir, { recursive: true });
    for (const l of LEVELS) {
      // Home with nothing at work (no mark of work moves in it): first how often a real slide each way draws the band,
      // in real time; then, on the page's own clock held, the band at rest, after two slides, and the film strip.
      const records = () => Object.assign(scene('quiet', { now: FIXED.getTime() }), { prefs: prefs({ motion_ambient: l }) });
      const live = await open(browser, { label: 'workspace', records: records(), url: server.url, dpr: 2, fixed: FIXED, init: init({ active: true, state: 'idle' }, false) });
      await live.waitForTimeout(2500);
      const away = await live.evaluate(SLIDE), back = await live.evaluate(SLIDE);
      await live.context().close();
      const page = await open(browser, { label: 'workspace', records: records(), url: server.url, dpr: 2, fixed: FIXED, init: init({ active: false, state: 'idle' }) });
      await quiet(page);
      await page.evaluate(() => (Object.assign(window.__motion.debug, { active: true }), window.__motion.redraw()));
      await page.evaluate((ms) => window.__clock.run(ms, 30), REST);
      await quiet(page);
      await settle(page);
      await page.screenshot({ path: path.join(dir, `${level(l)}-rest.png`) });
      for (let i = 0; i < 2; i++) {
        await page.evaluate(() => window.__ws.command('sidebar'));
        await page.evaluate(END);
      }
      await quiet(page);
      await settle(page);
      await page.screenshot({ path: path.join(dir, `${level(l)}-again.png`) });
      // The film strip, closing the sidebar: eight moments of its curve.
      for (let i = 0; i < MOMENTS; i++) {
        await page.evaluate(HOLD, i / (MOMENTS - 1));
        await page.screenshot({ path: path.join(dir, `${level(l)}-${i}.png`) });
      }
      await page.evaluate(END);
      await quiet(page);
      await settle(page);
      await page.screenshot({ path: path.join(dir, `${level(l)}-closed.png`) });
      (out[level(l)] ??= {})[tag] = { away, back };
      for (const e of page.errors) console.error(`${tag} slide ${l}: ${e}`);
      await page.context().close();
    }
    await server.close();
  }
  fs.mkdirSync(path.join(OUT, 'diff', 'slide'), { recursive: true });
  for (const l of LEVELS.map(level)) {
    const pair = (n) => compare(path.join(OUT, 'before', 'slide', `${l}-${n}.png`), path.join(OUT, 'after', 'slide', `${l}-${n}.png`), path.join(OUT, 'diff', 'slide', `${l}-${n}.png`));
    const o = out[l];
    o.rest = pair('rest');
    o.again = pair('again');
    o.closed = pair('closed');
    o.moments = Array.from({ length: MOMENTS }, (_, i) => pair(i));
    // The strip: Home's lower half, before above after, the eight moments side by side.
    const strip = (tag) => ['(', ...Array.from({ length: MOMENTS }, (_, i) => path.join(OUT, tag, 'slide', `${l}-${i}.png`)), '-crop', '2360x860+0+660', '+repage', '-resize', '25%', '+append', ')'];
    spawnSync('magick', [...strip('before'), ...strip('after'), '-append', path.join(OUT, `strip-${l}.png`)]);
    const said = (r) => (r.pixels === 0 ? 'identical' : `${r.pixels} px differ`);
    console.log(`slide ${l}: band drawn before ${o.before.away.drawn}+${o.before.back.drawn}, after ${o.after.away.drawn}+${o.after.back.drawn}; canvas resized before ${o.before.away.resized}+${o.before.back.resized}, after ${o.after.away.resized}+${o.after.back.resized}; at rest ${said(o.rest)}, after two slides ${said(o.again)}, closed ${said(o.closed)}; moments ${o.moments.map(said).join(', ')}`);
  }
  report.slide = out;
}

// ——— The notch's glow ———
async function runGlow(browser, report) {
  const out = {};
  const times = [0, 400, 1100, 1700, 2600, 3400, 9000, 18000];
  for (const [tag, dist] of Object.entries(BUILDS)) {
    const server = await serve(path.resolve(dist));
    const dir = path.join(OUT, tag, 'glow');
    fs.mkdirSync(dir, { recursive: true });
    for (const l of LEVELS) {
      const records = scene('busy', { now: FIXED.getTime() });
      records.prefs = prefs({ motion_ambient: l });
      const page = await open(browser, { label: 'notch', records, url: server.url, dpr: 2, viewport: { width: 560, height: 420 }, fixed: FIXED, init: init() });
      await page.evaluate(() => (document.documentElement.style.background = '#172433'));
      await page.evaluate((g) => window.__fake.emit(g), geometry(false));
      await page.evaluate(() => window.__clock.run(500));
      await page.evaluate(() => (document.querySelector('#tab').click(), 1));
      await page.evaluate(() => window.__clock.run(1500));
      await quiet(page);
      await settle(page);
      for (const t of times) {
        await page.evaluate((t) => { for (const a of document.getAnimations()) (a.pause(), (a.currentTime = t)); }, t);
        await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(dir, `${level(l)}-${t}.png`), clip: { x: 160, y: 0, width: 240, height: 60 } });
      }
      await page.context().close();
    }
    await server.close();
  }
  fs.mkdirSync(path.join(OUT, 'diff', 'glow'), { recursive: true });
  for (const l of LEVELS.map(level))
    out[l] = times.map((t) => ({ t, ...compare(path.join(OUT, 'before', 'glow', `${l}-${t}.png`), path.join(OUT, 'after', 'glow', `${l}-${t}.png`), path.join(OUT, 'diff', 'glow', `${l}-${t}.png`)) }));
  for (const [l, r] of Object.entries(out)) console.log(`glow ${l}: ${r.filter((x) => x.pixels === 0).length} of ${r.length} moments identical`);
  report.glow = out;
}

module.exports = { init, picture, quiet, settle, freeze, scene, prefs, FIXED };
if (require.main === module) (async () => {
  const { chromium } = require('playwright');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(has('--gpu') ? { args: GPU } : {}) });
  const report = { builds: BUILDS, hz: HZ, quick: QUICK };
  try {
    if (ONLY.includes('stills')) await runStills(browser, report);
    if (ONLY.includes('motion')) await runMotion(browser, report);
    if (ONLY.includes('slide')) await runSlide(browser, report);
    if (ONLY.includes('glow')) await runGlow(browser, report);
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  const bad = [...(report.stills?.differ ?? []).filter((d) => !d.expected).map((d) => d.name),
    ...Object.entries(report.motion ?? {}).filter(([n, r]) => !n.startsWith('picture') && r.differ && !expected(`motion-${n}`)).map(([n]) => `motion ${n}`)];
  if (report.stills?.errors.length) console.error(report.stills.errors.join('\n'));
  if (bad.length) (console.error(`differ: ${bad.join(', ')}`), (process.exitCode = 1));
  console.log(`report: ${path.join(OUT, 'report.json')}`);
})().catch((e) => (console.error(e), process.exit(1)));
