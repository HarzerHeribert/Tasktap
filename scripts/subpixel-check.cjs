// Whether the motion's forms move in fractions of a pixel: each style's own shader (ui/src/motion), drawn at the size
// of Home's band, is moved a hundredth of a pixel a step, 200 steps: swelled by the band's pulse (a slat's height, a
// glyph's growth, a ring's size), and shifted across and down. With edges that cover a pixel by the share of it they
// reach, and reflections no finer than a pixel, every step changes the picture a little; with an edge that snaps to
// whole pixels (a hard step, a floor, a rounded height), or a line finer than a pixel (a crease, a reflection the
// metal does not soften as far as it turns under one pixel), a pixel jumps in one step. For Slats it follows the rows
// one slat's top edge crosses as it rises and the columns its side crosses as it shifts, which must fill evenly. For
// every form it says the largest change of any one pixel in a step, and where. It fails when a form is not drawn,
// when a step changes nothing, when a pixel at the slat's edge changes by more than 12 levels in a step, or when any
// pixel of a form changes by more than its bound (WORST) in a step.
// usage: node scripts/subpixel-check.cjs [--software] [--app] [--json file] [--snap] [--src folder]
//   headless Chromium on the GPU by default, where every form must draw; --software: on its software renderer, which
//   is said, the rings at half the size, and passed over if it gives up on them. --app runs the same in the built
//   app's web view (it needs no window on screen), where every form must draw.
//   --snap breaks the slat's edge on purpose (whole pixels), to show that the check sees it.
//   --src: the shaders of another folder than ui/src/motion (an earlier state of them, to compare).
const fs = require('node:fs');
const path = require('node:path');
const { launch, table, root } = require('./app-driver.cjs');
const has = (name) => process.argv.includes(name);
const arg = (name, or) => (has(name) ? process.argv[process.argv.indexOf(name) + 1] : or);
const W = 593, H = 380, STEPS = 200, PER = 0.01;
/** The most one pixel of each form may change in a step: half as much again as its shader's worst (slats 16, glyphs
 *  20, rings 18), and well under what each did while lines finer than a pixel stood in it (112, 249, 157). */
const WORST = { slats: 30, glyphs: 30, resonator: 30 };

/** In the page: draws `frag` after `head` at W by H for each of `runs` (uniform sets a step apart), and says how far
 *  each picture is from the one before: the mean difference of its light (8-bit levels) and the largest difference of
 *  any one pixel, and where the largest of all was. With `track` (a place [x, y] outside the form and a direction
 *  [dx, dy] towards it), also the light of the four pixels from the form's edge outward, as found in the first
 *  picture (rows run from the bottom). No comment inside it: the app's debug channel takes it as one line. */
const SWEEP = ({ head, frag, W, H, n, p, state, runs, track }) => {
  if (window.__sweep && (window.__sweep.cv.width !== W || window.__sweep.g?.isContextLost())) window.__sweep = null;
  const made = (window.__sweep ??= (() => {
    const cv = Object.assign(document.createElement('canvas'), { width: W, height: H });
    return { cv, g: cv.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true }) };
  })());
  const g = made.g;
  if (!g) return { error: 'no WebGL 2' };
  const prog = g.createProgram();
  for (const [type, text] of [[g.VERTEX_SHADER, '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}'], [g.FRAGMENT_SHADER, head + frag]]) {
    const s = g.createShader(type);
    g.shaderSource(s, text);
    g.compileShader(s);
    if (!g.getShaderParameter(s, g.COMPILE_STATUS)) return { error: g.getShaderInfoLog(s) };
    g.attachShader(prog, s);
  }
  g.linkProgram(prog);
  g.useProgram(prog);
  if (!made.ready) {
    g.bindVertexArray(g.createVertexArray());
    g.bindTexture(g.TEXTURE_2D, g.createTexture());
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA16F, 128, 2, 0, g.RGBA, g.FLOAT, new Float32Array(128 * 2 * 4));
    for (const k of [g.TEXTURE_MIN_FILTER, g.TEXTURE_MAG_FILTER]) g.texParameteri(g.TEXTURE_2D, k, g.LINEAR);
    made.ready = true;
  }
  const u = (name) => g.getUniformLocation(prog, 'u_' + name), st = new Float32Array(7), info = g.getExtension('WEBGL_debug_renderer_info');
  st[state] = 1;
  g.viewport(0, 0, W, H);
  g.uniform2f(u('res'), W, H), g.uniform1f(u('n'), n), g.uniform1f(u('irid'), 1), g.uniform1f(u('dim'), 0.92), g.uniform1f(u('light'), 0), g.uniform1f(u('hoff'), 0), g.uniform1f(u('aux'), 0.3);
  g.uniform4f(u('ph'), 2.1, 0, 0, 9), g.uniform4f(u('v'), 0, 0, 0, 0.4), g.uniform4f(u('w'), 0, 0, 0.4, 0), g.uniform1fv(u('st'), st);
  g.uniform3f(u('sig'), 0, 0, 0), g.uniform3f(u('ta'), 0.8, 0.9, 1), g.uniform3f(u('tb'), 1, 0.82, 0.7), g.uniform3f(u('bg'), 0, 0, 0), g.uniform4f(u('lm'), 0, 0, 1, 0);
  g.uniform4fv(u('holes'), new Float32Array(96)), g.uniform4f(u('hole'), 0, 0, 0, 1), g.uniform3f(u('pose'), 1, 9, 0), g.uniform2f(u('was'), 9, 0);
  const px = new Uint8Array(W * H * 4), out = { renderer: String(g.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : g.RENDERER)), change: [], most: [], ramp: [], where: null };
  let top = 0, prev = null, edge = -1;
  for (const r of runs) {
    g.uniform2f(u('org'), r.org[0], r.org[1]);
    g.uniform1fv(u('p'), new Float32Array(p.map((v, i) => (i === 2 ? v + r.size : v))));
    g.drawArrays(g.TRIANGLES, 0, 3);
    g.readPixels(0, 0, W, H, g.RGBA, g.UNSIGNED_BYTE, px);
    const lum = new Float32Array(W * H);
    for (let i = 0, j = 0; j < lum.length; i += 4, j++) lum[j] = (px[i] + px[i + 1] + px[i + 2]) / 3;
    if (prev) {
      let d = 0, most = 0;
      for (let j = 0; j < lum.length; j++) {
        const x = Math.abs(lum[j] - prev[j]);
        d += x;
        if (x > most) most = x;
        if (x > top) (top = x), (out.where = { step: out.change.length, x: j % W, y: Math.floor(j / W), from: Math.round(prev[j]), to: Math.round(lum[j]) });
      }
      out.change.push(d / lum.length), out.most.push(most);
    }
    if (track) {
      const at = (k) => lum[(track[1] + k * track[3]) * W + track[0] + k * track[2]] ?? 0;
      if (edge < 0) for (edge = 0; edge < W && at(edge) < 12; edge++);
      out.ramp.push([0, 1, 2, 3].map((k) => Math.round(at(edge - k))));
    }
    prev = lum;
  }
  g.deleteProgram(prog);
  return out;
};

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;

async function main() {
  const src = path.resolve(arg('--src', path.join(root, 'ui/src/motion')));
  const { HEAD } = await import(path.join(src, 'head.ts'));
  const { STYLES } = await import(path.join(src, 'styles.ts'));
  let evaluate, close;
  if (has('--app')) {
    const app = await launch(arg('--exe', '') ? { exe: arg('--exe') } : {});
    evaluate = (a) => app.ask('workspace', SWEEP, a);
    close = () => app.quit();
  } else {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true, args: has('--software') ? [] : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] }), page = await browser.newPage();
    evaluate = (a) => page.evaluate(SWEEP, a);
    close = () => browser.close();
  }
  const failures = [], rows = [], out = {};
  let renderer = '';
  try {
    // The band as Home draws it, agents working. `p[2]` is the size of the form's wave: this much of it raises the
    // middle slat's half-height by one pixel (head.ts wave and slat, at the phase the sweep holds). Half a slat's
    // pitch, in pixels, is how far the gap beside the middle slat is from its centre.
    const asp = W / H, X = Math.min(asp * 0.8, Math.max(1.35, asp * 0.62)), sc = Math.min(1, X / 1.2) * 0.95, perPixel = 1 / (0.42 * sc * (H / 2)), gap = Math.round((X / STYLES.slats.n.hero) * (H / 2));
    for (const id of ['slats', 'glyphs', 'resonator']) {
      const S = STYLES[id], head = has('--snap') ? HEAD.replace('return clamp(.5+(1.-rr)*cr/px,0.,1.);', 'return step(rr,1.);') : HEAD;
      // The rings are many times the work of the others a pixel: a software renderer is given them at half the size.
      const k = id === 'resonator' && has('--software') ? 2 : 1, mid = [Math.floor(W / 2), Math.floor(H / 2)];
      const base = { head, frag: S.frag, W: Math.round(W / k), H: Math.round(H / k), n: S.n.hero, p: S.p[3], state: 3 };
      const run = (f) => Array.from({ length: STEPS + 1 }, (_, k) => ({ org: [0, 0], size: 0, ...f(k * PER) }));
      const sweeps = {
        // The middle slat: its top is found from the top of the picture down, its side from the gap beside it inward.
        'swelled': await evaluate({ ...base, track: id === 'slats' ? [mid[0], H - 1, 0, -1] : null, runs: run((d) => ({ size: d * perPixel * k })) }),
        'shifted across': await evaluate({ ...base, track: id === 'slats' ? [mid[0] + gap, mid[1], -1, 0] : null, runs: run((d) => ({ org: [d, 0] })) }),
        'shifted down': await evaluate({ ...base, runs: run((d) => ({ org: [0, d] })) }),
      };
      out[id] = sweeps;
      for (const [name, s] of Object.entries(sweeps)) {
        renderer ||= s.renderer ?? '';
        // A software renderer gives up on the rings (the context is lost, or the picture stays empty): with
        // --software that is said and passed over; on the GPU and in the app's own web view every form must draw.
        if (!s.change || s.change.every((c) => c === 0)) {
          if (has('--software') && !has('--app')) rows.push([id, name, 'not drawn by this renderer', '', '', '', '', '']);
          else failures.push(`${id}, ${name}: ${s.error || 'nothing was drawn'}`);
          continue;
        }
        const usual = median(s.change), most = Math.max(...s.most), none = s.change.filter((c) => c === 0).length, at = s.where;
        // The pixels a slat's edge crosses fill as the edge passes through them: the most any of them changed in a step.
        const edge = s.ramp.length ? Math.max(...s.ramp.slice(1).map((r, k) => Math.max(...r.map((v, i) => Math.abs(v - s.ramp[k][i]))))) : null;
        rows.push([id, name, usual.toFixed(5), none, edge === null ? '' : edge.toFixed(0), median(s.most).toFixed(1), most.toFixed(1), `${at.x}, ${at.y} at step ${at.step}: ${at.from} to ${at.to}`]);
        if (none) failures.push(`${id}, ${name}: ${none} of ${STEPS} steps of a hundredth of a pixel changed nothing`);
        if (edge > 12) failures.push(`${id}, ${name}: a pixel at the slat's edge changed by ${edge.toFixed(0)} levels in a step of a hundredth of a pixel (12 at most): the edge snaps`);
        if (most > WORST[id]) failures.push(`${id}, ${name}: the pixel at ${at.x}, ${at.y} changed by ${most.toFixed(0)} levels in a step of a hundredth of a pixel (${WORST[id]} at most): a line there stands on whole pixels`);
      }
    }
  } finally {
    await close();
  }
  if (has('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(out));
  console.log(`${has('--app') ? "The built app's web view" : 'Headless Chromium'} (${renderer || 'no renderer'}): each form at ${W} x ${H}, moved ${PER} px a step, ${STEPS} steps`);
  console.log(table(['form', 'moved', 'usual change a step', 'steps unchanged', "edge pixel's largest step", 'usual worst pixel', 'worst pixel', 'where (x, y from the bottom left)'], rows));
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? 'FAIL  a form moves in whole steps' : `PASS  every hundredth of a pixel changes each form's picture, a slat's top and side fill their pixels evenly as they pass, and no pixel of any form jumps in a step${rows.some((r) => r[2].startsWith('not drawn')) ? ' (of the forms this software renderer drew: the rest are not judged here)' : ''}`);
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
