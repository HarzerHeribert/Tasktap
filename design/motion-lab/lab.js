// The lab: one voice, one state, one palette, and up to two concepts drawn at four sizes each.
import { Voice } from './voice.js';
import { HEAD, CONCEPTS } from './shaders.js';

const $ = (s, r = document) => r.querySelector(s);
const el = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

const STATES = [['idle', 'Idle', 'I'], ['listening', 'Listening', 'L'], ['thinking', 'Thinking', 'T'], ['working', 'Working', 'W'],
  ['needs', 'Needs you', 'N'], ['done', 'Done', 'D'], ['failed', 'Failed', 'F']];
const SIGNAL = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [2, 1.05, .22], [.45, 1.2, .75], [1.25, .1, .07]];   // amber, pale green, dull red
const DIM = [.8, 1, .95, .92, .85, 1.05, .42];        // how bright the studio is
const RATE = [20, 60, 60, 30, 30, 60, 60];            // draws per second a state asks for
const PALETTES = [
  { id: 'neutral', name: 'Chrome', a: [.86, .93, 1], b: [1, .8, .58], irid: 0 },
  { id: 'irid', name: 'Iridescent', a: [.8, .9, 1], b: [1, .82, .7], irid: 1 },
  { id: 'warm', name: 'Warm', a: [1, .72, .44], b: [1, .4, .22], irid: 0 },
  { id: 'cool', name: 'Cool', a: [.4, .72, 1], b: [.62, .48, 1], irid: 0 },
  { id: 'hue', name: 'Hue', a: [1, 1, 1], b: [1, 1, 1], irid: 0 }
];
const SIZES = [['icon', 112, 112], ['box', 76, 28], ['strip', 200, 32]];
const VERT = '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}';
const UNI = { res: 2, org: 2, n: 1, irid: 1, dim: 1, light: 1, hoff: 1, aux: 1, ph: '4fv', v: '4fv', w: '4fv', p: '1fv', st: '1fv', sig: '3fv', ta: '3fv', tb: '3fv', bg: '3fv' };
const hsl = (h, s, l) => [0, 8, 4].map(n => { const k = (n + h / 30) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); });
const css = (c, a = 1) => `rgba(${c.map(x => Math.round(255 * Math.min(1, x))).join(',')},${a})`;

// ---- drawing: one WebGL 2 context, one program per concept, a full-screen triangle into any rectangle ----
class Gfx {
  constructor(canvas) {
    const gl = this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('WebGL 2 is not available');
    this.canvas = canvas; this.progs = new Map(); this.gpu = 0; this.query = null; this.tick = 0;
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 128, 2, 0, gl.RGBA, gl.FLOAT, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.bindVertexArray(gl.createVertexArray());
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    this.renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)).replace(/^ANGLE \((.*)\)$/, '$1').replace(/, Unspecified Version$/, '');
  }
  program(c) {
    let p = this.progs.get(c.id);
    if (p) return p;
    const gl = this.gl, prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, HEAD + c.frag]]) {
      const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(c.name + ': ' + gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(c.name + ': ' + gl.getProgramInfoLog(prog));
    p = { prog, loc: {} };
    for (const k in UNI) p.loc[k] = gl.getUniformLocation(prog, 'u_' + k);
    this.progs.set(c.id, p);
    return p;
  }
  upload(data) { this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, 128, 2, this.gl.RGBA, this.gl.FLOAT, data); }
  draw(c, x, y, w, h, U) {
    const gl = this.gl, p = this.program(c);
    gl.viewport(x, y, w, h); gl.useProgram(p.prog);
    U.res = [w, h]; U.org = [x, y];
    for (const k in UNI) {
      const l = p.loc[k], v = U[k], t = UNI[k];
      if (!l) continue;
      if (t === 1) gl.uniform1f(l, v); else if (t === 2) gl.uniform2f(l, v[0], v[1]); else gl['uniform' + t](l, v);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  // Time on the GPU, where the browser allows it to be asked (Chrome does, Safari does not).
  timed(fn) {
    const gl = this.gl, e = this.ext;
    if (this.query) {
      if (gl.getQueryParameter(this.query, gl.QUERY_RESULT_AVAILABLE)) {
        if (!gl.getParameter(e.GPU_DISJOINT_EXT)) this.gpu = gl.getQueryParameter(this.query, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(this.query); this.query = null;
      }
      return fn();
    }
    if (!e || ++this.tick % 3) return fn();
    this.query = gl.createQuery(); gl.beginQuery(e.TIME_ELAPSED_EXT, this.query); fn(); gl.endQuery(e.TIME_ELAPSED_EXT);
  }
  finish() { this.gl.finish(); this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, new Uint8Array(4)); }
}

// ---- state of the lab ----
const voice = new Voice();
const stW = new Float32Array(7); stW[1] = 1;
const S = { concept: 0, pin: -1, state: 1, palette: 0, hue: 265, light: false, reduce: matchMedia('(prefers-reduced-motion: reduce)').matches };
let stT = 9, dirty = true, lastDraw = 0, last = 0, lastSlow = 0, drawsPerSec = 0, mini = null, failure = '';
const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
const perf = { work: [], add(ms) { this.work.push(ms); if (this.work.length > 120) this.work.shift(); } };
const measured = {};

// ---- a column: one concept at every size ----
class Col {
  constructor(index) {
    this.c = CONCEPTS[index]; this.ph = [0, 0, 0, 9]; this.aux = 0; this.onz = voice.onsets; this.p = new Float32Array(8);
    this.root = el(`<section class="col">
      <figure class="hero"><canvas></canvas><figcaption><b>${this.c.name}</b><span>${this.c.line}</span></figcaption></figure>
      <div class="sizes">
        <figure><div class="appicon"><canvas data-k="icon"></canvas></div><figcaption>App icon <span>112</span></figcaption></figure>
        <figure><div class="sheet"><i></i><i></i><i></i><canvas data-k="box"></canvas></div><figcaption>Notch sheet corner <span>76 × 28</span></figcaption></figure>
        <figure><div class="screen"><canvas class="glow" width="210" height="80"></canvas><div class="menubar"><i></i><i></i><i></i><i></i><i></i></div><div class="notch"><canvas data-k="strip"></canvas></div></div><figcaption>Collapsed notch, with a glow from behind <span>200 × 32</span></figcaption></figure>
      </div></section>`);
    this.heroCanvas = $('.hero canvas', this.root);
    this.hero = new Gfx(this.heroCanvas);
    this.minis = SIZES.map(([k, w, h]) => {
      const cv = $(`canvas[data-k=${k}]`, this.root);
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
      return { k, w, h, cv, ctx: cv.getContext('2d') };
    });
    this.glow = $('.glow', this.root).getContext('2d');
    new ResizeObserver(() => { dirty = true; }).observe(this.heroCanvas);
  }
  dispose() { this.hero.gl.getExtension('WEBGL_lose_context')?.loseContext(); this.root.remove(); }
}
let cols = [];

function layout() {
  const want = S.pin >= 0 && S.pin !== S.concept ? [S.pin, S.concept] : [S.concept];
  if (cols.length !== want.length || cols.some((c, i) => c.c !== CONCEPTS[want[i]])) {
    const keep = new Map(cols.map(c => [c.c, c])); cols = [];
    const stage = $('#stage');
    for (const i of want) { const c = keep.get(CONCEPTS[i]) || new Col(i); keep.delete(CONCEPTS[i]); cols.push(c); stage.append(c.root); }
    for (const c of keep.values()) c.dispose();
    stage.classList.toggle('pair', cols.length > 1);
  }
  dirty = true;
}

// ---- one frame ----
function palette() {
  const P = PALETTES[S.palette];
  if (P.id === 'hue') { P.a = hsl(S.hue, 1, .64); P.b = hsl((S.hue + 42) % 360, 1, .6); }
  return P;
}
function uniforms(col, adv) {
  const C = col.c, P = palette(), p = col.p, r = S.reduce;
  for (let k = 0; k < 8; k++) { let v = 0; for (let i = 0; i < 7; i++) v += stW[i] * C.p[i][k]; p[k] = v; }
  if (!r) {
    col.ph[0] += adv * p[1]; col.ph[1] += adv * voice.level * p[0]; col.aux += adv * p[7];
    col.onz += (voice.onsets - col.onz) * (1 - Math.exp(-adv / .09)); col.ph[2] = col.onz; col.ph[3] = stT;
  } else col.ph[3] = 9.9;
  const sig = [0, 0, 0]; let dim = 0;
  for (let i = 0; i < 7; i++) {
    const k = stW[i] * (i === 5 ? .35 + .65 * Math.exp(-stT / 1.5) : 1) * (i === 4 && !r ? .55 + .45 * beat() : 1);
    for (let j = 0; j < 3; j++) sig[j] += k * SIGNAL[i][j];
    dim += stW[i] * DIM[i];
  }
  const L = r ? voice.slow : voice.level;
  return {
    n: 1, irid: P.irid, dim, light: +S.light, hoff: voice.hoff, aux: col.aux, ph: col.ph, p, st: stW, sig, ta: P.a, tb: P.b,
    v: [L, r ? voice.slow : voice.fast, r ? 0 : voice.onset, voice.bright], w: [r ? voice.slow : voice.vowel, r ? 0 : voice.sib, voice.pitch, r ? voice.slow : voice.activity],
    bg: S.light ? [.915, .922, .933] : [.031, .035, .039]
  };
}
const beat = () => { const t = (stT / 2.4) % 1, b = (x, w) => Math.exp(-((x / w) ** 2)); return b(t - .1, .06) + .7 * b(t - .31, .07); };

function draw(adv) {
  const t0 = performance.now(), d = dpr();
  try {
    for (const col of cols) {
      const U = uniforms(col, adv), hc = col.heroCanvas;
      const w = Math.max(2, Math.round(hc.clientWidth * d)), h = Math.max(2, Math.round(hc.clientHeight * d));
      if (hc.width !== w || hc.height !== h) { hc.width = w; hc.height = h; }
      U.n = col.c.n.hero;
      col.hero.upload(voice.data);
      col.hero.timed(() => col.hero.draw(col.c, 0, 0, w, h, U));
      // the small sizes are drawn in one shared context and copied out; they always sit on black
      U.bg = [0, 0, 0]; U.light = 0;
      mini.upload(voice.data);
      mini.timed(() => {
        for (const m of col.minis) {
          const mw = Math.round(m.w * d), mh = Math.round(m.h * d);
          if (m.cv.width !== mw || m.cv.height !== mh) { m.cv.width = mw; m.cv.height = mh; }
          U.n = col.c.n[m.k];
          mini.draw(col.c, 0, 0, mw, mh, U);
          m.ctx.drawImage(mini.canvas, 0, mini.canvas.height - mh, mw, mh, 0, 0, mw, mh);
        }
      });
      glow(col);
    }
    failure = '';
  } catch (e) { failure = String(e.message || e); console.error(e); }
  $('#error').textContent = failure; $('#error').hidden = !failure;
  perf.add(performance.now() - t0);
}

// Light from behind the collapsed notch: the strip's own pixels pushed past the edge, plus the palette along the lower edge.
function glow(col) {
  const g = col.glow, P = palette(), strip = col.minis[2].cv, r = S.reduce, t = performance.now() / 1000;
  const nx = 55, ny = 4, nw = 100, nh = 16;                       // the notch inside this half-size canvas
  g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, 210, 80); g.globalCompositeOperation = 'lighter';
  const lv = stW[1] * (r ? voice.slow : voice.fast) + stW[0] * .05 + stW[2] * .3 + stW[3] * .22 + stW[4] * (.25 + .6 * (r ? .5 : beat())) + stW[5] * (.2 + .6 * Math.exp(-stT / 1.2)) + stW[6] * .2;
  g.globalAlpha = Math.min(1, .25 + lv); g.drawImage(strip, nx - 7, ny, nw + 14, nh + 8); g.globalAlpha = 1;
  const sm = Math.max(...SIGNAL[S.state]), blob = (x, rad, c, a) => {
    const gr = g.createRadialGradient(x, ny + nh, 0, x, ny + nh, rad);
    gr.addColorStop(0, css(c, a)); gr.addColorStop(1, css(c, 0)); g.fillStyle = gr; g.fillRect(x - rad, ny + nh - rad, rad * 2, rad * 2);
  };
  for (let k = 0; k < 8; k++) {                                   // voice: low bands in the middle, high at the ends
    const e = stW[1] * (r ? voice.slow * .7 : voice.spec[2 + k * 3] * .8 + voice.fast * .3);
    for (const s of [-1, 1]) {
      const x = nx + nw / 2 + s * (k + .5) / 8 * nw / 2, f = k / 7;
      const c = P.irid ? hsl((250 + s * f * 75 + 25 * Math.sin(t * .7)) % 360, .9, .68) : P.a.map((a, i) => a * (1 - f) + P.b[i] * f);
      if (e > .01) blob(x, 8 + 26 * e, c, .5 * e);
    }
  }
  const own = stW[2] * .5 + stW[3] * .35, px = stW[2] > .5 ? Math.sin(t * 2.6) : ((t * .28) % 1) * 2.6 - 1.3;
  if (own > .01) blob(nx + nw / 2 + (r ? 0 : px) * nw / 2, 30, P.irid ? hsl((250 + 60 * Math.sin(t * .9)) % 360, .9, .68) : P.a, own);
  if (sm > 0) { const c = SIGNAL[S.state].map(x => x / sm); blob(nx + nw / 2, 58, c, Math.min(1, lv * 1.2)); blob(nx + nw / 2, 26, c, Math.min(1, lv)); }
}

function frame(now) {
  if (document.hidden) { last = 0; return; }
  requestAnimationFrame(frame);
  const dt = Math.min(.05, last ? (now - last) / 1000 : .016); last = now;
  voice.update(dt, S.reduce);
  let moving = false;
  for (let i = 0; i < 7; i++) { const d = (i === S.state) - stW[i]; if (Math.abs(d) > .004) moving = true; stW[i] += d * (1 - Math.exp(-dt / .3)); }
  stT += dt;
  // How often to draw. A state that has come to rest, or Reduce Motion with a level that is not changing, draws nothing.
  let rate = RATE[S.state];
  if (S.reduce) { rate = moving || Math.abs(voice.slow - lastSlow) > .004 && S.state === 1 ? 20 : 0; }
  else if (S.state === 1 && voice.quiet > 1.5) rate = 20;
  else if (S.state >= 5 && stT > 3 && !moving) rate = 0;
  if (moving && !S.reduce) rate = 60;
  if (dirty || (rate && now - lastDraw >= 1000 / rate - 4)) {
    draw(S.reduce ? 0 : Math.min(.1, lastDraw ? (now - lastDraw) / 1000 : .016));
    lastDraw = now; dirty = false; lastSlow = voice.slow; drawn++;
  }
  drawsPerSec = rate;
  meter(); if (now - readAt > 400) { readAt = now; readout(); }
}
let drawn = 0, readAt = 0;
document.addEventListener('visibilitychange', () => { if (!document.hidden) { last = 0; dirty = true; requestAnimationFrame(frame); } });

// ---- the page around the stage ----
function meter() {
  const cv = $('#meter'), g = cv.getContext('2d'), w = cv.width, h = cv.height;
  g.clearRect(0, 0, w, h);
  for (let b = 0; b < 16; b++) {
    const v = Math.max(.06, (voice.spec[b * 2] + voice.spec[b * 2 + 1]) / 2), bh = v * h;
    g.fillStyle = `rgba(230,232,236,${.35 + .65 * v})`; g.fillRect(b * 6, (h - bh) / 2, 3, bh);
  }
}
function readout() {
  const w = perf.work, avg = w.reduce((a, b) => a + b, 0) / Math.max(1, w.length), worst = Math.max(0, ...w);
  $('#r-frame').textContent = `${avg.toFixed(2)} ms average, ${worst.toFixed(1)} worst`;
  const gp = mini?.ext ? `hero ${cols.map(c => c.hero.gpu.toFixed(2)).join(' + ')} ms, small sizes ${mini.gpu.toFixed(2)} ms` : 'not offered by this browser';
  $('#r-gpu').textContent = gp;
  $('#r-rate').textContent = drawsPerSec ? `${drawsPerSec} frames a second` : 'stopped: nothing is changing';
  $('#r-gfx').textContent = mini ? mini.renderer : '';
}
// A direct measurement: each size drawn forty times, waiting for the GPU after every one. The wait itself costs a
// little, so these are upper bounds; they are the numbers to trust when the GPU timer is not offered.
function measure() {
  const d = dpr(), out = {};
  for (const col of cols) {
    const U = uniforms(col, 0), res = {}, N = 40;
    const run = (gfx, n, w, h) => { U.n = n; gfx.draw(col.c, 0, 0, w, h, U); gfx.finish(); const t = performance.now(); for (let i = 0; i < N; i++) { U.ph = [col.ph[0] + i * .01, col.ph[1], col.ph[2], col.ph[3]]; gfx.draw(col.c, 0, 0, w, h, U); gfx.finish(); } return (performance.now() - t) / N; };
    res.hero = run(col.hero, col.c.n.hero, col.heroCanvas.width, col.heroCanvas.height);
    res.heroPx = col.heroCanvas.width + ' × ' + col.heroCanvas.height;
    for (const [k, w, h] of SIZES) res[k] = run(mini, col.c.n[k], Math.round(w * d), Math.round(h * d));
    measured[col.c.id] = out[col.c.id] = res;
  }
  note(); dirty = true;
  return out;
}

function note() {
  const c = CONCEPTS[S.concept], m = measured[c.id];
  $('#note').innerHTML = `<p>${c.voice}</p><dl><dt>Strong</dt><dd>${c.strong}</dd><dt>Weak</dt><dd>${c.weak}</dd><dt>Cost</dt><dd>${c.cost}${m ? ` Measured here: hero ${m.hero.toFixed(2)} ms (${m.heroPx}), icon ${m.icon.toFixed(2)}, notch corner ${m.box.toFixed(2)}, collapsed notch ${m.strip.toFixed(2)} ms a frame.` : ''}</dd></dl>`;
}
function sync() {
  document.querySelectorAll('#concepts button').forEach((b, i) => { b.setAttribute('aria-pressed', i === S.concept); b.classList.toggle('pinned', i === S.pin); });
  document.querySelectorAll('#states button').forEach((b, i) => b.setAttribute('aria-pressed', i === S.state));
  document.querySelectorAll('#palettes button').forEach((b, i) => b.setAttribute('aria-pressed', i === S.palette));
  $('#palette-name').textContent = PALETTES[S.palette].name;
  $('#hue-row').hidden = PALETTES[S.palette].id !== 'hue';
  $('#hue').value = S.hue; $('#hue-row').style.setProperty('--h', S.hue);
  $('#reduce').setAttribute('aria-pressed', S.reduce); $('#light').setAttribute('aria-pressed', S.light);
  $('#pin').setAttribute('aria-pressed', S.pin >= 0);
  $('#pin b').textContent = S.pin >= 0 ? `Unpin ${CONCEPTS[S.pin].name}` : `Pin ${CONCEPTS[S.concept].name}`;
  document.body.classList.toggle('light', S.light);
  note(); layout();
  history.replaceState(null, '', '#' + new URLSearchParams({ c: CONCEPTS[S.concept].id, s: STATES[S.state][0], p: PALETTES[S.palette].id, ...(S.pin >= 0 ? { pin: CONCEPTS[S.pin].id } : {}), ...(S.light ? { bg: 'light' } : {}), ...(S.reduce ? { calm: 1 } : {}), ...(PALETTES[S.palette].id === 'hue' ? { hue: S.hue } : {}) }));
}
function set(patch) {
  if ('state' in patch && patch.state !== S.state) stT = 0;
  Object.assign(S, patch); sync();
}
async function toggleMic() {
  const b = $('#mic');
  try {
    if (voice.mic) voice.stopMic(); else await voice.useMic();
    $('#source').textContent = voice.mic ? 'Microphone' : 'Simulated voice';
    b.firstChild.textContent = voice.mic ? 'Use simulated voice ' : 'Use microphone ';
    b.setAttribute('aria-pressed', !!voice.mic); $('#mic-error').hidden = true;
    if (voice.mic && S.state !== 1) set({ state: 1 });
  } catch (e) {
    $('#mic-error').hidden = false;
    $('#mic-error').textContent = e.name === 'NotAllowedError' ? 'The microphone was not allowed. The simulated voice keeps playing.' : (e.message || 'The microphone could not be opened.');
  }
}

function build() {
  $('#concepts').prepend(...CONCEPTS.map((c, i) => { const b = el(`<button><kbd>${i + 1}</kbd><b>${c.name}</b><span>${c.line}</span></button>`); b.onclick = () => set({ concept: i }); return b; }));
  $('#states').append(...STATES.map(([, name, key], i) => { const b = el(`<button>${name}<kbd>${key}</kbd></button>`); b.onclick = () => set({ state: i }); return b; }));
  $('#palettes').prepend(...PALETTES.map((p, i) => { const b = el(`<button class="sw sw-${p.id}" title="${p.name}" aria-label="${p.name}"></button>`); b.onclick = () => set({ palette: i }); return b; }));
  $('#hue').oninput = e => set({ hue: +e.target.value });
  $('#sens').oninput = e => { voice.sens = Math.pow(4, +e.target.value); };
  $('#reduce').onclick = () => set({ reduce: !S.reduce });
  $('#light').onclick = () => set({ light: !S.light });
  $('#pin').onclick = () => set({ pin: S.pin >= 0 ? -1 : S.concept });
  $('#mic').onclick = toggleMic;
  $('#measure').onclick = () => { measure(); };
  addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target?.matches?.('input')) return;
    const k = e.key.toLowerCase(), si = STATES.findIndex(s => s[2].toLowerCase() === k), n = CONCEPTS.length;
    if (k >= '1' && k <= String(n)) set({ concept: +k - 1 });
    else if (si >= 0) set({ state: si });
    else if (k === 'arrowright' || k === 'arrowleft') set({ concept: (S.concept + (k === 'arrowright' ? 1 : n - 1)) % n });
    else if (k === 'arrowdown' || k === 'arrowup') set({ state: (S.state + (k === 'arrowdown' ? 1 : 6)) % 7 });
    else if (k === ']' || k === '[') set({ palette: (S.palette + (k === ']' ? 1 : PALETTES.length - 1)) % PALETTES.length });
    else if (k === 'p') $('#pin').click(); else if (k === 'm') toggleMic(); else if (k === 'r') $('#reduce').click(); else if (k === 'b') $('#light').click();
    else return;
    e.preventDefault();
  });
  const h = new URLSearchParams(location.hash.slice(1)), find = (list, id, key) => list.findIndex(x => (key ? x[key] : x[0]) === id);
  const init = {};
  if (find(CONCEPTS, h.get('c'), 'id') >= 0) init.concept = find(CONCEPTS, h.get('c'), 'id');
  if (find(STATES, h.get('s')) >= 0) init.state = find(STATES, h.get('s'));
  if (find(PALETTES, h.get('p'), 'id') >= 0) init.palette = find(PALETTES, h.get('p'), 'id');
  if (find(CONCEPTS, h.get('pin'), 'id') >= 0) init.pin = find(CONCEPTS, h.get('pin'), 'id');
  if (h.get('bg') === 'light') init.light = true;
  if (h.get('calm')) init.reduce = true;
  if (h.get('hue')) init.hue = +h.get('hue');
  Object.assign(S, init); stW.fill(0); stW[S.state] = 1;
}

try {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  mini = new Gfx(c);
  build(); sync();
  requestAnimationFrame(frame);
} catch (e) {
  document.body.classList.add('no-gl');
  $('#stage').innerHTML = `<p class="nogl">This lab draws with WebGL 2, which this browser or its settings do not offer here.<br>Current Safari and Chrome on macOS both do. (${e.message})</p>`;
}
window.lab = { set, measure, voice, perf, S, CONCEPTS, STATES, PALETTES, get cols() { return cols; }, get failure() { return failure; } };
