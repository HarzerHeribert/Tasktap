// The app's motion against the lab it came from (design/motion-lab), in headless Chromium on the GPU:
// 1. The same uniforms through the lab's shaders and the app's (ui/src/motion) must give the same pixels, for every
//    style, state and size, with Lumen off; the largest difference per channel is reported.
// 2. Side by side, the lab page and the app's engine draw each style in each state at the app's two sizes, and the
//    pairs are saved for the eye.
// node scripts/motion-fidelity.cjs <outdir>
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { serve } = require('./motion-pages.cjs');
const root = path.resolve(__dirname, '..');
const { chromium } = require('playwright');

const STYLES = ['slats', 'glyphs', 'resonator'];
const STATES = ['idle', 'listening', 'thinking', 'working', 'needs', 'done', 'failed'];
/** The app's two sizes, in device pixels as drawn: the notch sheet and Home's header band. */
const SIZES = [['notch', 432, 300], ['home', 640, 124]];
const GPU = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];

// A page that loads the app's motion modules and the lab's shaders through Vite, which serves TypeScript as it is.
async function appServer() {
  const { createServer } = await import(path.join(root, 'ui/node_modules/vite/dist/node/index.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-fidelity-'));
  const at = (p) => '/@fs' + path.join(root, p);
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><meta charset="utf-8">
<style>body{margin:0;background:#000}.motion{display:block;position:relative}.motion-canvas{position:absolute;inset:0;width:100%;height:100%}</style>
<script type="module">
import { View, setVoice } from '${at('ui/src/motion/engine.ts')}';
import { Voice } from '${at('ui/src/motion/voice.ts')}';
import { HEAD } from '${at('ui/src/motion/head.ts')}';
import { STYLES } from '${at('ui/src/motion/styles.ts')}';
import * as LAB from '${at('design/motion-lab/shaders.js')}';
window.app = { View, setVoice, Voice, HEAD, STYLES, LAB };
</script>`);
  const server = await createServer({ root: dir, configFile: false, logLevel: 'error', server: { port: 0, host: '127.0.0.1', fs: { allow: [root, dir] } } });
  await server.listen();
  return { url: server.resolvedUrls.local[0], close: () => server.close() };
}

// In the page: both programs, the same uniforms, every pixel compared.
function equivalence({ styles, states, sizes }) {
  const { HEAD, STYLES, LAB } = window.app;
  const VERT = '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}';
  const SIGNAL = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [2, 1.05, .22], [.45, 1.2, .75], [1.25, .1, .07]];
  const DIM = [.8, 1, .95, .92, .85, 1.05, .42];
  const make = (w, h) => {
    const c = document.createElement('canvas');
    [c.width, c.height] = [w, h];
    const gl = c.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    // Some voice history, so the shaders' reads of it are compared too.
    const data = new Float32Array(128 * 2 * 4).map((_, i) => .5 + .5 * Math.sin(i * .37));
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 128, 2, 0, gl.RGBA, gl.FLOAT, data);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.bindVertexArray(gl.createVertexArray());
    return gl;
  };
  const program = (gl, frag) => {
    const p = gl.createProgram();
    for (const [t, s] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, frag]]) {
      const sh = gl.createShader(t);
      gl.shaderSource(sh, s);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      gl.attachShader(p, sh);
    }
    gl.linkProgram(p);
    return p;
  };
  const draw = (gl, prog, U) => {
    gl.useProgram(prog);
    for (const [k, v] of Object.entries(U)) {
      const l = gl.getUniformLocation(prog, 'u_' + k);
      if (!l) continue;
      if (typeof v === 'number') gl.uniform1f(l, v);
      else if (k === 'hole') gl.uniform4f(l, v[0], v[1], 0, 1);
      else if (k === 'res' || k === 'org') gl.uniform2f(l, v[0], v[1]);
      else if (k === 'p' || k === 'st') gl.uniform1fv(l, v);
      else if (v.length === 3) gl.uniform3fv(l, v);
      else gl.uniform4fv(l, v);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const out = [];
  for (const [name, w, h] of sizes) {
    const [ga, gb] = [make(w, h), make(w, h)];
    gb.viewport(0, 0, w, h);
    ga.viewport(0, 0, w, h);
    for (const id of styles) {
      const lab = LAB.CONCEPTS.find((c) => c.id === id), app = STYLES[id];
      const [pa, pb] = [program(ga, LAB.HEAD + lab.frag), program(gb, HEAD + app.frag)];
      for (const [s, state] of states.entries()) {
        const st = new Float32Array(7);
        st[s] = 1;
        const p = new Float32Array(app.p[s]);
        const sig = SIGNAL[s].map((x) => x * (s === 5 ? .6 : s === 4 ? .8 : 1));
        const U = {
          res: [w, h], org: [0, 0], n: app.n.hero, irid: 1, dim: DIM[s], light: 0, hoff: .4, aux: 1.3, ph: [3.1, 1.7, 2.2, .8],
          v: [.6, .5, .3, .45], w: [.4, .2, .5, .7], p, st, sig, ta: [.8, .9, 1], tb: [1, .82, .7], bg: [0, 0, 0],
        };
        const a = draw(ga, pa, U), b = draw(gb, pb, { ...U, lm: [0, 0, 0, 0], form: 1, hole: [0, 0] });
        let max = 0, lit = 0, off = 0;
        for (let i = 0; i < a.length; i += 4) {
          let d = 0;
          for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a[i + c] - b[i + c]));
          [max, off] = [Math.max(max, d), off + (d > 0)];
          if (a[i] + a[i + 1] + a[i + 2] > 30) lit++;
        }
        // lit: the share of the view the form covers; off: the share of pixels that differ at all.
        out.push({ size: name, style: id, state, max, off: +(off / (w * h)).toFixed(5), lit: +(lit / (w * h)).toFixed(3) });
      }
    }
  }
  return out;
}

// In the page: what one frame costs the GPU at each placement's drawn size, waiting for it to finish after every frame
// (so each figure carries that wait), in the working state with Lumen on and a dozen lines of words kept clear.
function timing({ styles, sizes }) {
  const { HEAD, STYLES } = window.app;
  const VERT = '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}';
  const c = document.createElement('canvas');
  [c.width, c.height] = [Math.max(...sizes.map((s) => s[1])), Math.max(...sizes.map((s) => s[2]))];
  const gl = c.getContext('webgl2', { antialias: false });
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 128, 2, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.bindVertexArray(gl.createVertexArray());
  const finish = () => (gl.finish(), gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)));
  const out = [];
  for (const id of styles) {
    const p = gl.createProgram();
    for (const [t, s] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, HEAD + STYLES[id].frag]]) {
      const sh = gl.createShader(t);
      gl.shaderSource(sh, s);
      gl.compileShader(sh);
      gl.attachShader(p, sh);
    }
    gl.linkProgram(p);
    gl.useProgram(p);
    const set = (k, f, ...v) => { const l = gl.getUniformLocation(p, 'u_' + k); if (l) gl['uniform' + f](l, ...v); };
    const st = [0, 0, 0, 1, 0, 0, 0];
    set('n', '1f', STYLES[id].n.hero); set('irid', '1f', 1); set('dim', '1f', .92); set('p', '1fv', STYLES[id].p[3]); set('st', '1fv', st);
    set('ta', '3fv', [.8, .9, 1]); set('tb', '3fv', [1, .82, .7]); set('lm', '4fv', [1, 2, .28, 0]); set('form', '1f', .8);
    set('holes', '4fv', new Float32Array(96).map((_, i) => (i % 4 === 0 ? 40 + 30 * (i >> 2) : i % 4 === 1 ? 60 : i % 4 === 2 ? 80 : 8)));
    set('hole', '4f', 12, 24, 0, 1);
    for (const [name, w, h] of sizes) {
      gl.viewport(0, 0, w, h);
      set('res', '2f', w, h);
      for (let i = 0; i < 5; i++) gl.drawArrays(gl.TRIANGLES, 0, 3);
      finish();
      const t = performance.now();
      for (let i = 0; i < 40; i++) {
        set('ph', '4fv', [i * .03, 0, 0, i * .03]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        finish();
      }
      out.push({ style: id, place: name, px: `${w} × ${h}`, ms: +((performance.now() - t) / 40).toFixed(3) });
    }
  }
  return out;
}

async function main(out) {
  fs.mkdirSync(out, { recursive: true });
  const app = await appServer();
  const lab = await serve(path.join(root, 'design/motion-lab'));
  const browser = await chromium.launch({ headless: true, args: GPU });
  const report = {};
  try {
    const page = await browser.newPage({ viewport: { width: 700, height: 400 } });
    await page.goto(app.url);
    await page.waitForFunction(() => window.app);
    report.renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      return gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
    });
    report.equivalence = await page.evaluate(equivalence, { styles: STYLES, states: STATES, sizes: SIZES });
    const worst = Math.max(...report.equivalence.map((r) => r.max));
    console.log(`same uniforms, lab and app shaders: largest difference ${worst} of 255 over ${report.equivalence.length} renders`);

    // Each placement's drawn size at 2x: the box in CSS pixels, times 2, times the placement's scale.
    const placed = [['Home object, 1x', 760, 340], ['Home object, 2x', 1520, 680], ['Home wash, 1x', 968, 708], ['Home wash, 2x', 1936, 1416]];
    report.cost = await page.evaluate(timing, { styles: STYLES, sizes: placed });
    for (const c of report.cost) console.log(`${c.style.padEnd(10)} ${c.place.padEnd(30)} ${c.px.padEnd(12)} ${c.ms} ms`);

    // Resolution: Home's header band drawn at full, half and a quarter of the device's pixels, side by side for the eye.
    const rp = await browser.newPage({ viewport: { width: 600, height: 3 * 124 }, deviceScaleFactor: 2 });
    await rp.goto(app.url);
    await rp.waitForFunction(() => window.app);
    await rp.evaluate(() => {
      for (const scale of [1, .5, .25]) {
        const el = document.createElement('span');
        el.className = 'motion';
        el.style.cssText = 'width:600px;height:124px';
        document.body.append(el);
        new window.app.View(el).set({ look: { style: 'slats', palette: 'chromatic', hue: 265, lumen: true }, state: 'working', primary: scale === 1, scale });
      }
    });
    await rp.waitForTimeout(1500);
    for (const [i, scale] of [1, .5, .25].entries()) await rp.locator('.motion').nth(i).screenshot({ path: path.join(out, `resolution-${scale}.png`) });
    await rp.close();

    // The voice: what reading the microphone costs a frame, with Chromium's fake device playing speech from say(1).
    const wav = path.join(out, 'speech.wav');
    execFileSync('say', ['-o', path.join(out, 'speech.aiff'), 'Move the sync retry to an exponential back off, and tell me when the tests pass on the first try.']);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(out, 'speech.aiff'), '-ar', '48000', '-ac', '1', wav]);
    const mic = await chromium.launch({ headless: true, args: [...GPU, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] });
    const vp = await mic.newPage();
    await vp.goto(app.url);
    await vp.waitForFunction(() => window.app);
    report.voice = await vp.evaluate(async () => {
      const v = await window.app.Voice.microphone();
      await new Promise((ok) => setTimeout(ok, 1500));
      let peak = 0, spent = 0;
      for (let i = 0; i < 240; i++) {
        const t = performance.now();
        v.update(1 / 60);
        spent += performance.now() - t;
        peak = Math.max(peak, v.level);
        await new Promise((ok) => setTimeout(ok, 16));
      }
      v.close();
      return { msPerFrame: +(spent / 240).toFixed(3), peakLevel: +peak.toFixed(2), onsets: v.onsets };
    });
    console.log('voice', JSON.stringify(report.voice));
    await mic.close();

    // Side by side: the lab page at the app's size, and the app's engine, each after 1.6 s in the state.
    const pairs = [];
    for (const [size, w, h] of process.env.PAIRS === "0" ? [] : SIZES)
      for (const style of STYLES)
        for (const state of STATES) {
          const lp = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
          await lp.goto(`${lab.url}/index.html#c=${style}&s=${state}&p=irid`);
          await lp.addStyleTag({ content: `.hero canvas{width:${w}px!important;height:${h}px!important;display:block}` });
          const ap = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
          await ap.goto(app.url);
          await ap.waitForFunction(() => window.app);
          await ap.evaluate(({ style, state, w, h }) => {
            const el = document.createElement('span');
            el.className = 'motion';
            el.style.cssText = `width:${w}px;height:${h}px`;
            document.body.append(el);
            new window.app.View(el).set({ look: { style, palette: 'chromatic', hue: 265, lumen: false }, state, primary: true });
          }, { style, state, w, h });
          await Promise.all([lp.waitForTimeout(1600), ap.waitForTimeout(1600)]);
          const name = `${size}-${style}-${state}`;
          await lp.locator('.hero canvas').first().screenshot({ path: path.join(out, `lab-${name}.png`) });
          await ap.screenshot({ path: path.join(out, `app-${name}.png`) });
          pairs.push({ size, style, state, lab: `lab-${name}.png`, app: `app-${name}.png` });
          await lp.close();
          await ap.close();
        }
    report.pairs = pairs;
    fs.writeFileSync(path.join(out, 'fidelity.json'), JSON.stringify(report, null, 1));
    console.log(`${pairs.length} pairs in ${out}`);
  } finally {
    await browser.close();
    await lab.close();
    await app.close();
  }
}

if (require.main === module) {
  if (!process.argv[2]) { console.error('usage: node scripts/motion-fidelity.cjs <outdir>'); process.exit(2); }
  main(path.resolve(process.argv[2])).catch((e) => { console.error(e); process.exit(1); });
}
