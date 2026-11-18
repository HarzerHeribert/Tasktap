// The motion: the lab's styles drawn live into the views of a page, with one WebGL 2 context for all of them. A view
// is an element the engine fills with a canvas, told what to show: a look (style, palette, Lumen), a state, how many
// pixels to draw per device pixel, how bright the metal is, and where the words are that it must keep clear. States
// blend as the lab blends them (0.3 s), and so does Lumen when it is switched. A frame is drawn only while something
// moves: a settled idle, done or failed, Reduce Motion with nothing changing, a view out of sight, an inactive view
// and a hidden page draw nothing at all, and with no view ever shown no context is made. While something does move
// it is drawn at one cadence from its first frame to its last, however slowly it moves: in every frame the page is
// given, up to about 60 a second (the loop at the foot). All of its timing is time passed, never a count of frames,
// so it runs alike on every display, whatever its rate and however that varies.
// The largest primary view draws into the context's own canvas; any other view is a copy (a 2D canvas) of a frame
// drawn there just before it, as the lab draws its small sizes.
import { HEAD } from './head.ts';
import { LUMEN } from './lumen.ts';
import { lights, type PaletteId } from './palette.ts';
import { STATES, type MotionState } from './state.ts';
import { STYLES, type Size, type StyleId } from './styles.ts';

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
  /** How it moves. `live`, as the lab: the state's own motion keeps running. `calm`: it moves while something goes
   *  on and rests otherwise: thinking, working, a question waiting and listening are loops that run for as long as
   *  they last; a result or a failure is a moment (MOMENT) laid over whatever came before, after which it comes to
   *  rest; idle is a still frame. Its own motion gathers way and loses it over most of a second, never at once.
   *  `still`: a fixed picture of its state, drawn once when something changes it and never moved. */
  pace?: 'live' | 'calm' | 'still';
  /** A calm view's lasting states hold still where they are (the window not in use). */
  rest?: boolean;
  /** The smallest size, in CSS pixels, at which this view draws, where it asks for fewer elements than its size would
   *  (`count`), so each is still large enough for the metal to read. Otherwise MIN. */
  min?: [number, number];
  /** How many elements it draws, instead of what its kind of size asks for. */
  count?: number;
  /** Light behind the page rather than an object: drawn at one pixel to a CSS pixel however dense the display, and
   *  scaled by the page. */
  soft?: boolean;
  /** The view's own motion at this share of the lab's pace (the ambient light's one tempo); 1 by default. */
  tempo?: number;
  /** Where its own clock starts, so views of one style side by side are not in step. */
  seed?: number;
  /** Home's band: how far it stands in the icon's S, its elements leaning with it (head.ts u_pose). 0 everywhere
   *  else, which is the form as the lab draws it. */
  pose?: number;
  /** Home's band: the strength of a pulse that passes through it, swelling its heights from the centre outward and
   *  settling. It is drawn while a pulse passes and is a still frame otherwise. */
  pulse?: number;
  /** Pulses pass by themselves about this many seconds apart, give or take a third, each of its own strength, the
   *  first at once; none with 0. */
  every?: number;
  /** A pulse starts at once each time this changes (focus entering the panel). */
  kick?: number;
};

// The lab's: the signal light of each state (amber, pale green, dull red), the studio's level, draws a second.
const SIGNAL = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [2, 1.05, 0.22], [0.45, 1.2, 0.75], [1.25, 0.1, 0.07]];
const DIM = [0.8, 1, 0.95, 0.92, 0.85, 1.05, 0.42];
/** Seconds a calm view plays a state that does not last for, after it begins: done's pass of light, failed's slump.
 *  The states that last (listening, thinking, working, needs you) run on. */
const MOMENT = [0, Infinity, Infinity, Infinity, Infinity, 3.2, 2];
/** Seconds a state takes to come in, twice over: its weight follows a value that itself follows the state, so a
 *  change begins from the pose and the pace on screen, small, and grows; a second change on its way bends it. */
const BLEND = 0.22;
/** Seconds a calm view's own motion takes to reach its pace, or to come to rest from it. */
const WAY = 0.8;
const VERT = '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}';
const UNI = { res: 2, org: 2, n: 1, irid: 1, dim: 1, light: 1, hoff: 1, aux: 1, ph: '4fv', v: '4fv', w: '4fv', p: '1fv', st: '1fv',
  sig: '3fv', ta: '3fv', tb: '3fv', bg: '3fv', lm: '4fv', holes: '4fv', hole: 2, pose: '3fv', was: 2 } as const;
/** A pulse (head.ts pulse): the seconds one unit of its clock takes, and the units it lasts until the form's ends
 *  have settled too: it rises in half a unit, falls to nothing in 2.2 more, and reaches the ends 0.9 later. */
const BEAT = 2, PULSE = 3.6;
type Uniforms = { -readonly [K in keyof typeof UNI]: number | ArrayLike<number> };
const HOLES = 24;
/** The smallest view, in CSS pixels, that draws (View.shown). */
const MIN: [number, number] = [400, 200];
/** No voice: silence, as the shaders read it. */
const SILENT = { level: 0, fast: 0, slow: 0, onset: 0, onsets: 0, bright: 0.4, vowel: 0, sib: 0, pitch: 0.4, activity: 0, quiet: 9, hoff: 0 };
/** What the motion hears: a voice's measures, the two rows of texels its shaders read, and how it is moved on by
 *  the time that passed. The microphone's (voice.ts) is one, and so is the level of a dictation that records
 *  (speech/level.ts). */
export type VoiceSource = typeof SILENT & { readonly open: boolean; readonly data: Float32Array; update(dt: number, calm?: boolean): void };

const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const views = new Set<View>();
/** What the debug channel's checks read: frames drawn on this page, WebGL contexts made, the milliseconds its frames
 *  have taken the page, and the most frames a second it draws (the loop at the foot). `seen`, when a check sets
 *  it, is called with each view just drawn, the canvas that holds its picture and the motion's clock. */
export const stats = { frames: 0, contexts: 0, ms: 0, rate: 60, seen: null as ((view: View, picture: HTMLCanvasElement, now: number) => void) | null };
let voice: VoiceSource | null = null;

/** The page's voice source, or none: while one is open, every view's listening state hears it. */
export function setVoice(v: VoiceSource | null) {
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
      ta: P.a, tb: P.b, v: [0, 0, 0, 0.4], w: [0, 0, 0.4, 0], bg: [0, 0, 0], lm: [0, 0, 1, 0], holes: new Float32Array(HOLES * 4), hole: [0, 0], pose: [0, 0, 0], was: [9, 0],
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
/** Whether a node is where words can be: nothing kept from assistive technology (the light, its glyphs) holds any. */
const worded = (at: EventTarget | null) => !(at instanceof Element ? at : at instanceof Node ? at.parentElement : null)?.closest('[aria-hidden=true]');

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
  // The lab's per-column animation: state weights (and what each follows), seconds in the state, phases, and Lumen's own.
  private stW = new Float32Array(7);
  private stV = new Float32Array(7);
  /** How much of its pace a calm view's own motion has: 0 at rest. */
  private go = 0;
  private stT = 9;
  private ph = [0, 0, 0, 9];
  private aux = 0;
  private onz = 0;
  private lm = 0;
  private lph = 0;
  /** The pulse passing through a posed view, and the one before it, which may still be settling: when each began
   *  (the motion's clock, ms) and its strength; when the next is due; how many there have been; the kick last answered. */
  private pulse = { began: -1e9, strength: 0, was: -1e9, weak: 0, due: 0, n: 0, kick: 0, on: false };
  private p = new Float32Array(8);
  private moving = false;
  private slow = 0;
  private observers: (ResizeObserver | IntersectionObserver)[];
  private words: MutationObserver;
  private watching = false;
  private fresh = true;
  /** Something changed where words can be: they are found again. The light's own elements hold none. */
  private moved = (at: EventTarget | null) => this.o.clear && worded(at) && ((this.stale = this.dirty = true), wake());
  private event = (e: Event) => this.moved(e.target);

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
    this.words = new MutationObserver((all) => all.some((r) => this.moved(r.target)));
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
    if (o.pace === 'still') this.settle();
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
      for (const e of events) document.addEventListener(e, this.event, true);
    } else {
      this.words.disconnect();
      for (const e of events) document.removeEventListener(e, this.event, true);
    }
  }

  /** Starts in its state, with no blend: a view that appears shows what is, not how it came to be. */
  settle() {
    this.stW.fill(0);
    this.stV.fill(0);
    this.stW[STATES.indexOf(this.o.state)] = this.stV[STATES.indexOf(this.o.state)] = 1;
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
    // Every device pixel: the metal's edges and reflections are the point. As light, one per CSS pixel.
    const k = this.o.soft ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    return [Math.max(2, Math.round(this.css[0]! * k)), Math.max(2, Math.round(this.css[1]! * k))];
  }

  tick(dt: number) {
    const s = STATES.indexOf(this.o.state), k = 1 - Math.exp(-dt / BLEND);
    this.moving = false;
    for (let i = 0; i < 7; i++) {
      this.stV[i]! += (+(i === s) - this.stV[i]!) * k;
      this.stW[i]! += (this.stV[i]! - this.stW[i]!) * k;
      if (Math.abs(+(i === s) - this.stW[i]!) > 0.002) this.moving = true;
    }
    // A calm view's own motion runs while its state lasts, or for its moment: it gathers way and loses it evenly.
    const to = this.o.pace !== 'calm' ? 1 : +(this.stT < MOMENT[s]! && !(this.o.rest && s < 5) && !reduced.matches);
    this.go += Math.max(-dt / WAY, Math.min(dt / WAY, to - this.go));
    const d = +this.o.look.lumen - this.lm;
    if (Math.abs(d) > 0.004) this.moving = true;
    this.lm += d * (1 - Math.exp(-dt / 0.3));
    this.stT += dt;
  }

  /** Whether it moves now, and so is drawn in this frame: while its states blend, while a pulse passes, while it
   *  listens, and while its own motion has any of its pace; idle, and a result or a failure once its moment is
   *  over, hold a still frame. */
  moves(now: number) {
    const s = STATES.indexOf(this.o.state), v = voice ?? SILENT;
    // Before anything else: this is where its next pulse begins.
    const pulse = this.beat(now) < PULSE;
    if (this.o.pace === 'still') return false;
    if (this.moving) return true;
    if (reduced.matches) return s === 1 && Math.abs(v.slow - this.slow) > 0.004;
    // Listening is a loop like the other states that last: it rests with them in a window not in use.
    if (pulse || (s === 1 && !this.o.rest)) return true;
    return this.o.pace === 'calm' ? this.go > 0 : !(s === 0 || (s >= 5 && this.stT > 3));
  }

  /** The clock of the view's pulse, in its units; the next begins when its time has come, or at a kick. One that
   *  begins while the last still settles joins it, the two drawn together, so nothing starts again from nothing;
   *  none begins while two are passing. With none, past it. */
  private beat(now: number) {
    const P = this.pulse, every = this.o.every ?? 0, kicked = (this.o.kick ?? 0) !== P.kick || (!!every && !P.on);
    P.kick = this.o.kick ?? 0;
    P.on = !!every;
    if (this.o.pulse && !reduced.matches && (kicked || (every && now >= P.due)) && (now - P.was) / 1000 / BEAT >= PULSE) {
      const r = (k: number) => Math.abs(Math.sin((++P.n + k) * 12.9898) * 43758.5453) % 1;
      Object.assign(P, { was: P.began, weak: P.strength, began: now, strength: this.o.pulse * (kicked ? 0.8 : 0.6 + 0.4 * r(0.3)), due: now + every * 1000 * (0.72 + 0.56 * r(0.7)) });
    }
    return (now - P.began) / 1000 / BEAT;
  }
  /** When a view at rest is next due a frame, in ms from now: when its next pulse begins. Never, with none. */
  rest(now: number) {
    return this.o.pulse && this.o.every && !reduced.matches ? Math.max(0, this.pulse.due - now) : Infinity;
  }

  /** The lab's uniforms for this view at the frame's time, its phases moved on by `adv` seconds. */
  uniforms(adv: number, n: number, now: number): Uniforms {
    adv *= (this.o.tempo ?? 1) * this.go;
    const C = STYLES[this.o.look.style], P = lights(this.o.look.palette, this.o.look.hue), p = this.p, w = this.stW, r = reduced.matches;
    const V = voice ?? SILENT;
    let lp = 0, amb = 0;
    for (let k = 0; k < 8; k++) {
      let x = 0;
      for (let i = 0; i < 7; i++) x += w[i]! * C.p[i]![k]!;
      p[k] = x;
    }
    for (let i = 0; i < 7; i++) (lp += w[i]! * LUMEN[i]![1]!), (amb += w[i]! * LUMEN[i]![7]!);
    if (!r) {
      this.ph[0]! += adv * p[1]!;
      this.ph[1]! += adv * V.level * p[0]!;
      this.aux += adv * p[7]!;
      this.lph += adv * lp;
      this.onz += (V.onsets - this.onz) * (1 - Math.exp(-adv / 0.09));
      this.ph[2] = this.onz;
      // In a calm view a question waiting is its two beats at the view's tempo, a slower and gentler insistence,
      // and a result's pass of light takes twice as long.
      const s = STATES.indexOf(this.o.state);
      this.ph[3] = this.stT * (this.o.pace !== 'calm' ? 1 : s === 4 ? (this.o.tempo ?? 1) : s === 5 ? 0.5 : 1);
    } else this.ph[3] = 9.9;
    const sig = [0, 0, 0], beat = (() => {
      const t = (this.ph[3]! / 2.4) % 1, b = (x: number, k: number) => Math.exp(-((x / k) ** 2));
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
      pose: [this.o.pose ?? 0, (now - this.pulse.began) / 1000 / BEAT, this.pulse.strength], was: [(now - this.pulse.was) / 1000 / BEAT, this.pulse.weak],
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
  draw(adv: number, host: boolean, W: number, H: number, now: number) {
    const [bw, bh] = this.size() as [number, number];
    const s = host ? 1 : Math.min(1, W / bw, H / bh), rw = Math.floor(bw * s), rh = Math.floor(bh * s);
    this.clear(rw);
    render(this.o.look.style, rw, rh, this.uniforms(adv, this.count(), now));
    this.drawn++;
    this.dirty = false;
    if (host) {
      this.cv?.remove();
      this.cv = null;
      if (canvas!.parentElement !== this.el) this.el.append(canvas!);
      return void stats.seen?.(this, canvas!, now);
    }
    if (!this.cv) {
      this.cv = document.createElement('canvas');
      this.cv.className = 'motion-canvas';
      this.el.append(this.cv);
    }
    if (this.cv.width !== bw || this.cv.height !== bh) [this.cv.width, this.cv.height] = [bw, bh];
    const g = this.cv.getContext('2d')!;
    g.clearRect(0, 0, bw, bh);
    g.drawImage(canvas!, 0, H - rh, rw, rh, 0, 0, bw, bh);
    stats.seen?.(this, this.cv, now);
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
/** When a frame of the motion was last drawn, by the time its frame was given; 0 while the loop sleeps. */
let drew = 0;
/** The motion's clock, in ms: it moves on by the time that passed between one drawing and the next, and never by
 *  more than three frames' worth at once, so after a stall everything goes on from where it was and nothing lurches;
 *  through a rest, when nothing is in motion, it moves on by all of the rest. */
let clock = 0;
let slept = 0;

function wake() {
  clearTimeout(timer);
  timer = 0;
  if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
}

/** The frames a page is given come at whatever pace the display and the web view choose, and not evenly: 60, 120,
 *  144 or 240 a second, or a pace that varies from one frame to the next (the built-in panel hands this web view
 *  frames 13 to 19 ms apart). Nothing here asks what that pace is. A frame of the motion is drawn in every frame
 *  given, except one that comes within three fifths of a sixtieth of a second (10 ms) of the last drawn: so about
 *  `stats.rate` a second on a stream of that pace however uneven, every second frame of 120 or 144 a second,
 *  every third of 240; no faster cadence can be seen, and each costs. Everything moves by the time that passed,
 *  never by a count of frames. Never paced by a timer: a web view slows chains of timers down the longer they
 *  run. A timer only ends a rest. */
function frame(at: number) {
  raf = 0;
  if (drew && at - drew < 600 / stats.rate) return void (raf = requestAnimationFrame(frame));
  const shown = [...views].filter((v) => v.shown());
  if (!shown.length || !context()) return void (drew = 0);
  const began = performance.now(), ms = drew ? Math.min(50, at - drew) : 1000 / 60, step = ms / 1000, dt = step, adv = reduced.matches ? 0 : step;
  clock += ms + (slept ? Math.max(0, at - slept) : 0);
  drew = at;
  slept = 0;
  const now = clock;
  voice?.update(dt, reduced.matches);
  const g = gl!;
  if (voice?.open) {
    g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, 128, 2, g.RGBA, g.FLOAT, voice.data);
    zeroed = false;
  } else if (!zeroed) {
    g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, 128, 2, g.RGBA, g.FLOAT, new Float32Array(128 * 2 * 4));
    zeroed = true;
  }
  let moving = false;
  const due: View[] = [];
  for (const v of shown) {
    v.tick(dt);
    const m = v.moves(now);
    moving ||= m;
    // A view still and unchanged keeps the frame it has: the sidebar's glyphs turning do not redraw Home's chrome.
    if (m || v.dirty) due.push(v);
  }
  // The largest primary view is the canvas's own; the others are copies of frames drawn before it.
  const host = shown.filter((v) => v.o.primary).sort((a, b) => b.size()[0]! * b.size()[1]! - a.size()[0]! * a.size()[1]!)[0];
  const sizes = shown.map((v) => v.size());
  const [W, H] = host ? host.size() : [Math.max(...sizes.map((s) => s[0]!)), Math.max(...sizes.map((s) => s[1]!))];
  if (canvas!.width !== W || canvas!.height !== H) [canvas!.width, canvas!.height] = [W!, H!];
  if (!host && canvas!.parentElement) canvas!.remove();
  try {
    for (const v of due) if (v !== host) v.draw(adv, false, W!, H!, now);
    // The canvas is the host's own picture: drawn again whenever another view used it.
    if (host && due.length) host.draw(adv, true, W!, H!, now);
    if (due.length) stats.frames++;
  } catch (e) {
    console.error(e);
    broken = true;
    return void (drew = 0);
  }
  stats.ms += performance.now() - began;
  if (moving) return void (raf = requestAnimationFrame(frame));
  // Nothing moves: the loop sleeps, until the next pulse of a view that has them is due.
  drew = 0;
  slept = at;
  const rest = Math.min(...shown.map((v) => v.rest(now)));
  if (rest !== Infinity)
    timer = window.setTimeout(() => {
      timer = 0;
      raf = requestAnimationFrame(frame);
    }, rest);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    raf = timer = drew = slept = 0;
  } else {
    views.forEach((v) => (v.dirty = true));
    wake();
  }
});
// A page coming back into view has views to draw again; one going away stops following its words.
document.addEventListener('visibilitychange', () => views.forEach((v) => v.watch()));
reduced.addEventListener('change', wake);
