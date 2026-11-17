// The motion: the lab's styles drawn live into the views of a page, with one WebGL 2 context for all of them. A view
// is an element the engine fills with a canvas, told what to show: a look (style, palette, Lumen), a state, how many
// pixels to draw per device pixel, how bright the metal is, and where the words are that it must keep clear. States
// blend as the lab blends them (0.3 s), and so does Lumen when it is switched. A frame is drawn only while something
// moves: a settled idle, done or failed, Reduce Motion with nothing changing, a view out of sight, an inactive view
// and a hidden page draw nothing at all, and with no view ever shown no context is made.
// The largest primary view draws into the context's own canvas; any other view is a copy (a 2D canvas) of a frame
// drawn there just before it, as the lab draws its small sizes.
import { HEAD } from './head.ts';
import { LUMEN } from './lumen.ts';
import { lights, type PaletteId } from './palette.ts';
import { STATES, type MotionState } from './state.ts';
import { STYLES, type Size, type StyleId } from './styles.ts';
import type { Voice } from './voice.ts';

export type Look = { style: Exclude<StyleId, 'glyph'>; palette: PaletteId; hue: number; lumen: boolean };
export type Options = {
  look: Look;
  state: MotionState;
  /** Selector of the elements whose words this view keeps clear: each line is cut out of the light, `pad` CSS pixels
   *  round it, and the light comes back over `feather` more. */
  clear?: string;
  pad?: number;
  feather?: number;
  /** Draws only while true (the notch while it is open). */
  active?: boolean;
  /** May draw into the context's own canvas rather than be a copy. */
  primary?: boolean;
  /** How it moves. `live`, as the lab: the state's own motion keeps running. `calm`: it moves only when something
   *  happens: a change of state plays its blend and the state's moment (MOMENT), then holds a still frame; the voice
   *  drives it live. `breathe`: calm, but while thinking or working it drifts at a fifth of its pace, 10 frames a
   *  second. */
  pace?: 'live' | 'calm' | 'breathe';
  /** The smallest size, in CSS pixels, at which this view draws, where it asks for fewer elements than its size would
   *  (`count`), so each is still large enough for the metal to read. Otherwise MIN. */
  min?: [number, number];
  /** How many elements it draws, instead of what its kind of size asks for. */
  count?: number;
  /** Light behind the page rather than an object: a copied frame is softened by this many CSS pixels of blur, once, as
   *  it is copied, so the compositor never blurs it again. */
  soften?: number;
  /** The view's own motion at this share of the lab's pace (the ambient light's one tempo); 1 by default. */
  tempo?: number;
  /** Where its own clock starts, so views of one style side by side are not in step. */
  seed?: number;
  /** At most this many frames a second, once its blend is over (ambient views, whose motion is slow). */
  fps?: number;
};

// The lab's: the signal light of each state (amber, pale green, dull red), the studio's level, draws a second.
const SIGNAL = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [2, 1.05, 0.22], [0.45, 1.2, 0.75], [1.25, 0.1, 0.07]];
const DIM = [0.8, 1, 0.95, 0.92, 0.85, 1.05, 0.42];
const RATE = [20, 60, 60, 30, 30, 60, 60];
/** Seconds a calm view plays a state for after it begins: the packet's shuttle, the hump's wander, two beats of needs
 *  you, done's pass of light, failed's slump. */
const MOMENT = [0, 0, 2.5, 2, 4.8, 3, 2];
const VERT = '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}';
const UNI = { res: 2, org: 2, n: 1, irid: 1, dim: 1, light: 1, hoff: 1, aux: 1, ph: '4fv', v: '4fv', w: '4fv', p: '1fv', st: '1fv',
  sig: '3fv', ta: '3fv', tb: '3fv', bg: '3fv', lm: '4fv', holes: '4fv', hole: 2 } as const;
type Uniforms = { -readonly [K in keyof typeof UNI]: number | ArrayLike<number> };
const HOLES = 24;
/** The smallest view, in CSS pixels, that draws (View.shown). */
const MIN: [number, number] = [400, 200];
/** No voice: silence, as the shaders read it. */
const SILENT = { level: 0, fast: 0, slow: 0, onset: 0, onsets: 0, bright: 0.4, vowel: 0, sib: 0, pitch: 0.4, activity: 0, quiet: 9, hoff: 0 };

const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const views = new Set<View>();
/** What the debug channel's checks read: frames drawn on this page, and by each style. */
export const stats = { frames: 0, contexts: 0 };
let voice: Voice | null = null;

/** The page's voice source, or none: while one is open, every view's listening state hears it. */
export function setVoice(v: Voice | null) {
  voice = v;
  wake();
}

// ---- the one context ----
let gl: WebGL2RenderingContext | null = null;
let canvas: HTMLCanvasElement | null = null;
let broken = false;
let zeroed = true;
const progs = new Map<StyleId, { prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> }>();

function context() {
  if (gl || broken) return gl;
  canvas = document.createElement('canvas');
  canvas.className = 'motion-canvas';
  canvas.addEventListener('webglcontextlost', (e) => (e.preventDefault(), progs.clear()));
  canvas.addEventListener('webglcontextrestored', () => (setup(), views.forEach((v) => (v.dirty = true)), wake()));
  gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
  if (!gl) return void (broken = true), null;
  stats.contexts++;
  setup();
  return gl;
}

function setup() {
  const g = gl!;
  g.bindTexture(g.TEXTURE_2D, g.createTexture());
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA16F, 128, 2, 0, g.RGBA, g.FLOAT, null);
  for (const [k, v] of [[g.TEXTURE_MIN_FILTER, g.LINEAR], [g.TEXTURE_MAG_FILTER, g.LINEAR], [g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE], [g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE]])
    g.texParameteri(g.TEXTURE_2D, k!, v!);
  g.bindVertexArray(g.createVertexArray());
  zeroed = true;
}

function program(id: StyleId) {
  let p = progs.get(id);
  if (p) return p;
  const g = gl!, prog = g.createProgram();
  for (const [type, src] of [[g.VERTEX_SHADER, VERT], [g.FRAGMENT_SHADER, HEAD + STYLES[id].frag]] as const) {
    const sh = g.createShader(type)!;
    g.shaderSource(sh, src);
    g.compileShader(sh);
    if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) throw new Error(`${id}: ${g.getShaderInfoLog(sh)}`);
    g.attachShader(prog, sh);
  }
  g.linkProgram(prog);
  if (!g.getProgramParameter(prog, g.LINK_STATUS)) throw new Error(`${id}: ${g.getProgramInfoLog(prog)}`);
  p = { prog, loc: Object.fromEntries(Object.keys(UNI).map((k) => [k, g.getUniformLocation(prog, 'u_' + k)])) };
  progs.set(id, p);
  return p;
}

function render(id: StyleId, w: number, h: number, U: Uniforms) {
  const g = gl!, p = program(id);
  g.viewport(0, 0, w, h);
  g.useProgram(p.prog);
  U.res = [w, h];
  for (const k of Object.keys(UNI) as (keyof typeof UNI)[]) {
    const l = p.loc[k], v = U[k], t = UNI[k];
    if (!l) continue;
    const a = v as Float32List;
    if (t === 1) g.uniform1f(l, v as number);
    else if (t === 2) g.uniform2f(l, a[0]!, a[1]!);
    else if (t === '1fv') g.uniform1fv(l, a);
    else if (t === '3fv') g.uniform3fv(l, a);
    else g.uniform4fv(l, a);
  }
  g.drawArrays(g.TRIANGLES, 0, 3);
}

/** One frame of a style as a picture of its own, `size` device pixels square, drawn once and outside any view: what
 *  the glyphs at the sidebar's foot and in the wiper's wake are made of. Null where the page cannot draw. */
export function still(style: StyleId, look: Look, state: MotionState, size: number, aux: number, phase: number): HTMLCanvasElement | null {
  const g = context();
  if (!g || g.isContextLost()) return null;
  const fb = g.createFramebuffer(), rb = g.createRenderbuffer();
  try {
    g.bindFramebuffer(g.FRAMEBUFFER, fb);
    g.bindRenderbuffer(g.RENDERBUFFER, rb);
    g.renderbufferStorage(g.RENDERBUFFER, g.RGBA8, size, size);
    g.framebufferRenderbuffer(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.RENDERBUFFER, rb);
    const s = STATES.indexOf(state), P = lights(look.palette, look.hue), st = new Float32Array(7);
    st[s] = 1;
    // Half the palette's iridescence: an object this small in full colour reads as coloured, not as metal.
    render(style, size, size, {
      res: [0, 0], org: [0, 0], n: 1, irid: P.irid * 0.5, dim: DIM[s]!, light: 0, hoff: 0, aux, ph: [phase, 0, 0, 9], p: new Float32Array(8), st, sig: SIGNAL[s]!,
      ta: P.a, tb: P.b, v: [0, 0, 0, 0.4], w: [0, 0, 0.4, 0], bg: [0, 0, 0], lm: [0, 0, 1, 0], holes: new Float32Array(HOLES * 4), hole: [0, 0],
    });
    const px = new Uint8Array(size * size * 4);
    g.readPixels(0, 0, size, size, g.RGBA, g.UNSIGNED_BYTE, px);
    // The frame is bottom-up and its colour is multiplied by its coverage; a picture is neither.
    const out = new ImageData(size, size);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = ((size - 1 - y) * size + x) * 4, j = (y * size + x) * 4, a = px[i + 3]!;
        for (let c = 0; c < 3; c++) out.data[j + c] = a ? Math.min(255, (px[i + c]! * 255) / a) : 0;
        out.data[j + 3] = a;
      }
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    cv.getContext('2d')!.putImageData(out, 0, 0);
    return cv;
  } catch (e) {
    console.error(e);
    return null;
  } finally {
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.deleteFramebuffer(fb);
    g.deleteRenderbuffer(rb);
  }
}

// ---- views ----
export class View {
  readonly el: HTMLElement;
  o: Options = { look: { style: 'slats', palette: 'chromatic', hue: 265, lumen: false }, state: 'idle' };
  dirty = true;
  /** Frames this view has drawn. */
  drawn = 0;
  private seen = false;
  private css = [0, 0];
  private cv: HTMLCanvasElement | null = null;
  private holes = new Float32Array(HOLES * 4);
  private hole = [0, 0];
  private stale = true;
  // The lab's per-column animation: state weights, seconds in the state, phases, and Lumen's own.
  private stW = new Float32Array(7);
  private stT = 9;
  private ph = [0, 0, 0, 9];
  private aux = 0;
  private onz = 0;
  private lm = 0;
  private lph = 0;
  private p = new Float32Array(8);
  private moving = false;
  private slow = 0;
  private observers: (ResizeObserver | IntersectionObserver)[];
  private words: MutationObserver;
  private watching = false;
  private fresh = true;
  private moved = () => this.o.clear && ((this.stale = this.dirty = true), wake());

  constructor(el: HTMLElement) {
    this.el = el;
    const resize = new ResizeObserver(([e]) => {
      const b = e!.contentRect;
      this.css = [b.width, b.height];
      const [mw, mh] = this.o.min ?? MIN;
      el.toggleAttribute('data-small', b.width < mw || b.height < mh);
      this.dirty = this.stale = true;
      this.watch();
      wake();
    });
    const seen = new IntersectionObserver(([e]) => {
      this.seen = e!.isIntersecting;
      this.dirty = this.stale = true;
      this.watch();
      wake();
    });
    // While it is shown, the words it keeps clear are followed as the page changes or scrolls.
    this.words = new MutationObserver(this.moved);
    resize.observe(el);
    seen.observe(el);
    this.observers = [resize, seen];
    views.add(this);
  }

  set(o: Options) {
    const was = this.o;
    this.o = o;
    if (this.fresh) {
      this.fresh = false;
      this.settle();
      if (o.seed) (this.aux = o.seed * 7.3), (this.ph[0] = o.seed * 11.1);
    }
    else if (o.state !== was.state) this.stT = 0;
    if (JSON.stringify(o) !== JSON.stringify(was)) {
      this.dirty = this.stale = true;
      this.watch();
      wake();
    }
  }

  watch() {
    const on = !!this.o.clear && this.shown();
    if (on === this.watching) return;
    this.watching = on;
    // Words move without the page changing too: as it scrolls, and as content slides into place when a sheet opens.
    const events = ['scroll', 'transitionend', 'animationend'];
    if (on) {
      this.words.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'open'] });
      for (const e of events) document.addEventListener(e, this.moved, true);
    } else {
      this.words.disconnect();
      for (const e of events) document.removeEventListener(e, this.moved, true);
    }
  }

  /** Starts in its state, with no blend: a view that appears shows what is, not how it came to be. */
  settle() {
    this.stW.fill(0);
    this.stW[STATES.indexOf(this.o.state)] = 1;
    this.lm = this.o.look.lumen ? 1 : 0;
    this.stT = 9;
  }

  dispose() {
    this.observers.forEach((o) => o.disconnect());
    this.o = { ...this.o, clear: undefined };
    this.watch();
    views.delete(this);
    if (canvas?.parentElement === this.el) canvas.remove();
  }

  /** Below about 400 by 200 CSS pixels an element of the form is narrower than 8 device pixels on a 1x display, where
   *  the full shader stops reading as metal; such a view draws nothing at all. */
  shown() {
    const [mw, mh] = this.o.min ?? MIN;
    return this.seen && this.o.active !== false && this.css[0]! >= mw && this.css[1]! >= mh && !document.hidden;
  }

  /** Its size in drawn pixels. */
  size() {
    // Every device pixel: the metal's edges and reflections are the point. Softened into light, one per CSS pixel.
    const k = this.o.soften ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    return [Math.max(2, Math.round(this.css[0]! * k)), Math.max(2, Math.round(this.css[1]! * k))];
  }

  tick(dt: number) {
    const s = STATES.indexOf(this.o.state);
    this.moving = false;
    for (let i = 0; i < 7; i++) {
      const d = +(i === s) - this.stW[i]!;
      if (Math.abs(d) > 0.004) this.moving = true;
      this.stW[i]! += d * (1 - Math.exp(-dt / 0.3));
    }
    const d = +this.o.look.lumen - this.lm;
    if (Math.abs(d) > 0.004) this.moving = true;
    this.lm += d * (1 - Math.exp(-dt / 0.3));
    this.stT += dt;
  }

  /** Draws a second it asks for now. The lab's policy, except that idle holds a still frame here; a calm view holds
   *  one once its state's moment is over, or drifts at 10 a second while it breathes. */
  rate() {
    const s = STATES.indexOf(this.o.state), v = voice ?? SILENT, pace = this.o.pace ?? 'live';
    if (reduced.matches) return this.moving || (s === 1 && Math.abs(v.slow - this.slow) > 0.004) ? 20 : 0;
    if (this.moving) return 60;
    if (s === 0 || (s >= 5 && this.stT > 3)) return 0;
    if (s === 1) return v.quiet > 1.5 ? 20 : 60;
    if (pace !== 'live' && this.stT >= MOMENT[s]!) return this.breathing() ? Math.min(10, this.o.fps ?? 10) : 0;
    return Math.min(RATE[s]!, this.o.fps ?? RATE[s]!);
  }

  /** A breathing view after its moment, thinking or working: its own motion runs at a fifth of its pace. */
  private breathing() {
    const s = STATES.indexOf(this.o.state);
    return this.o.pace === 'breathe' && (s === 2 || s === 3) && this.stT >= MOMENT[s]!;
  }

  /** The lab's uniforms for this view, its phases moved on by `adv` seconds. */
  uniforms(adv: number, n: number): Uniforms {
    adv *= this.o.tempo ?? 1;
    const C = STYLES[this.o.look.style], P = lights(this.o.look.palette, this.o.look.hue), p = this.p, w = this.stW, r = reduced.matches;
    const V = voice ?? SILENT;
    let lp = 0, amb = 0;
    for (let k = 0; k < 8; k++) {
      let x = 0;
      for (let i = 0; i < 7; i++) x += w[i]! * C.p[i]![k]!;
      p[k] = x;
    }
    for (let i = 0; i < 7; i++) (lp += w[i]! * LUMEN[i]![1]!), (amb += w[i]! * LUMEN[i]![7]!);
    if (this.breathing()) adv *= 0.2;
    if (!r) {
      this.ph[0]! += adv * p[1]!;
      this.ph[1]! += adv * V.level * p[0]!;
      this.aux += adv * p[7]!;
      this.lph += adv * lp;
      this.onz += (V.onsets - this.onz) * (1 - Math.exp(-adv / 0.09));
      this.ph[2] = this.onz;
      this.ph[3] = this.stT;
    } else this.ph[3] = 9.9;
    const sig = [0, 0, 0], beat = (() => {
      const t = (this.stT / 2.4) % 1, b = (x: number, k: number) => Math.exp(-((x / k) ** 2));
      return b(t - 0.1, 0.06) + 0.7 * b(t - 0.31, 0.07);
    })();
    let dim = 0;
    for (let i = 0; i < 7; i++) {
      const k = w[i]! * (i === 5 ? 0.35 + 0.65 * Math.exp(-this.stT / 1.5) : 1) * (i === 4 && !r ? 0.55 + 0.45 * beat : 1);
      for (let j = 0; j < 3; j++) sig[j]! += k * SIGNAL[i]![j]!;
      dim += w[i]! * DIM[i]!;
    }
    this.slow = V.slow;
    return {
      res: [0, 0], org: [0, 0], n, irid: P.irid, dim, light: 0, hoff: V.hoff, aux: this.aux, ph: this.ph, p, st: w, sig, ta: P.a, tb: P.b,
      v: [r ? V.slow : V.level, r ? V.slow : V.fast, r ? 0 : V.onset, V.bright],
      w: [r ? V.slow : V.vowel, r ? 0 : V.sib, V.pitch, r ? V.slow : V.activity],
      bg: [0, 0, 0], lm: [this.lm, this.lph, amb, 0], holes: this.holes, hole: this.hole,
    };
  }

  /** How many elements its style draws at its size, by the lab's kinds of size. */
  count() {
    if (this.o.count) return this.o.count;
    const [w, h] = this.css as [number, number], kind: Size = h < 48 ? (w / h > 4 ? 'strip' : 'box') : w < 200 ? 'icon' : 'hero';
    return STYLES[this.o.look.style].n[kind];
  }

  /** Where its words are, in its drawn pixels, from the bottom left. */
  clear(bw: number) {
    if (!this.stale) return;
    this.stale = false;
    this.hole = [0, 0];
    if (!this.o.clear) return;
    // A box at least a drawn pixel wider than its words: the canvas is scaled up smoothly, which reaches that far.
    const E = this.el.getBoundingClientRect(), k = bw / Math.max(1, E.width), pad = Math.max(this.o.pad ?? 3, 1 / k + 1);
    const boxes = words(this.o.clear, pad).filter((b) => b.r > E.left && b.l < E.right && b.b > E.top && b.t < E.bottom);
    boxes.forEach((b, i) => this.holes.set([((b.l + b.r) / 2 - E.left) * k, (E.bottom - (b.t + b.b) / 2) * k, ((b.r - b.l) / 2) * k, ((b.b - b.t) / 2) * k], i * 4));
    this.hole = [boxes.length, (this.o.feather ?? 16) * k];
  }

  /** Draws into the context's canvas, at most `W` by `H`, and copies the frame out unless it is the canvas's own. */
  draw(adv: number, host: boolean, W: number, H: number) {
    const [bw, bh] = this.size() as [number, number];
    const s = host ? 1 : Math.min(1, W / bw, H / bh), rw = Math.floor(bw * s), rh = Math.floor(bh * s);
    this.clear(rw);
    render(this.o.look.style, rw, rh, this.uniforms(adv, this.count()));
    this.drawn++;
    this.dirty = false;
    if (host) {
      this.cv?.remove();
      this.cv = null;
      if (canvas!.parentElement !== this.el) this.el.append(canvas!);
      return;
    }
    if (!this.cv) {
      this.cv = document.createElement('canvas');
      this.cv.className = 'motion-canvas';
      this.el.append(this.cv);
    }
    if (this.cv.width !== bw || this.cv.height !== bh) [this.cv.width, this.cv.height] = [bw, bh];
    const g = this.cv.getContext('2d')!;
    g.clearRect(0, 0, bw, bh);
    g.filter = this.o.soften ? `blur(${(this.o.soften * bw) / Math.max(1, this.css[0]!)}px)` : 'none';
    g.drawImage(canvas!, 0, H - rh, rw, rh, 0, 0, bw, bh);
  }
}

type Box = { l: number; t: number; r: number; b: number };
const area = (b: Box) => (b.r - b.l) * (b.b - b.t);
const union = (a: Box, b: Box): Box => ({ l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) });
const meets = (a: Box, b: Box) => a.l <= b.r && b.l <= a.r && a.t <= b.b && b.t <= a.b;

/** The lines of text, and the fields, under the elements `selector` names, each grown by `pad`; touching boxes are
 *  joined, and the closest are joined until there are no more than the shader takes. */
function words(selector: string, pad: number): Box[] {
  const found: Box[] = [];
  const range = document.createRange();
  const add = (r: DOMRect) => r.width > 0 && r.height > 0 && found.push({ l: r.left - pad, t: r.top - pad, r: r.right + pad, b: r.bottom + pad });
  for (const root of document.querySelectorAll(selector)) {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent?.trim()) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) add(r);
    }
    for (const f of root.querySelectorAll('input, textarea, button')) add(f.getBoundingClientRect());
  }
  const out: Box[] = [];
  for (let b of found) {
    for (let i = out.length - 1; i >= 0; i--) if (meets(out[i]!, b)) (b = union(out[i]!, b)), out.splice(i, 1);
    out.push(b);
  }
  while (out.length > HOLES) {
    let best = [0, 1], cost = Infinity;
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const c = area(union(out[i]!, out[j]!)) - area(out[i]!) - area(out[j]!);
        if (c < cost) [cost, best] = [c, [i, j]];
      }
    const [i, j] = best as [number, number];
    out[i] = union(out[i]!, out[j]!);
    out.splice(j, 1);
  }
  return out;
}

// ---- the frame loop: running only while a view needs a frame ----
let raf = 0;
let timer = 0;
let last = 0;

function wake() {
  if (!raf && !timer && !document.hidden) raf = requestAnimationFrame(frame);
}

function frame(now: number) {
  raf = 0;
  const shown = [...views].filter((v) => v.shown());
  if (!shown.length || !context()) return void (last = 0);
  const step = last ? (now - last) / 1000 : 0.016, dt = Math.min(0.05, step), adv = reduced.matches ? 0 : Math.min(0.1, step);
  last = now;
  voice?.update(dt, reduced.matches);
  const g = gl!;
  if (voice?.open) {
    g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, 128, 2, g.RGBA, g.FLOAT, voice.data);
    zeroed = false;
  } else if (!zeroed) {
    g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, 128, 2, g.RGBA, g.FLOAT, new Float32Array(128 * 2 * 4));
    zeroed = true;
  }
  let rate = 0;
  const due: View[] = [];
  for (const v of shown) {
    v.tick(dt);
    const r = v.rate();
    rate = Math.max(rate, r);
    // A view still and unchanged keeps the frame it has: the sidebar's glyphs turning do not redraw Home's chrome.
    if (r || v.dirty) due.push(v);
  }
  // The largest primary view is the canvas's own; the others are copies of frames drawn before it.
  const host = shown.filter((v) => v.o.primary).sort((a, b) => b.size()[0]! * b.size()[1]! - a.size()[0]! * a.size()[1]!)[0];
  const sizes = shown.map((v) => v.size());
  const [W, H] = host ? host.size() : [Math.max(...sizes.map((s) => s[0]!)), Math.max(...sizes.map((s) => s[1]!))];
  if (canvas!.width !== W || canvas!.height !== H) [canvas!.width, canvas!.height] = [W!, H!];
  if (!host && canvas!.parentElement) canvas!.remove();
  try {
    for (const v of due) if (v !== host) v.draw(adv, false, W!, H!);
    // The canvas is the host's own picture: drawn again whenever another view used it.
    if (host && due.length) host.draw(adv, true, W!, H!);
    if (due.length) stats.frames++;
  } catch (e) {
    console.error(e);
    broken = true;
    return void (last = 0);
  }
  if (!rate) return void (last = 0);
  if (rate >= 60) raf = requestAnimationFrame(frame);
  else
    timer = window.setTimeout(() => {
      timer = 0;
      raf = requestAnimationFrame(frame);
    }, 1000 / rate - 8);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    raf = timer = last = 0;
  } else {
    views.forEach((v) => (v.dirty = true));
    wake();
  }
});
// A page coming back into view has views to draw again; one going away stops following its words.
document.addEventListener('visibilitychange', () => views.forEach((v) => v.watch()));
reduced.addEventListener('change', wake);
