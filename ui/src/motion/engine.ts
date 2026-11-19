// The motion: the lab's styles drawn live into the views of a page, with one WebGL 2 context for all of them. A view
// is an element the engine fills with a canvas, told what to show: a look (style, palette, Lumen), a state, how many
// pixels to draw per device pixel, how bright the metal is, and where the words are that it must keep clear. States
// blend as the lab blends them (0.3 s), and so does Lumen when it is switched. A frame is drawn only while something
// moves: a settled idle, done or failed, Reduce Motion with nothing changing, a view out of sight, an inactive view
// and a hidden page draw nothing at all, and with no view ever shown no context is made. All of its timing is time
// passed, never a count of frames, so it runs alike on every display, whatever its rate and however that varies.
// What moves is shown in one of two ways. A change (states blending, a result's moment, the voice, a clearing coming
// in) is drawn by the page in every frame it is given, up to about 60 a second (the loop at the foot). A calm view's
// lasting loop (agents working, a question waiting) is carried by the compositor: the page draws only keyframes of
// it, a few a second, each a whole interval before it is due, and the compositor fades each into the next at the
// display's own rate (View.carry), so the page is given no frames while the loop lasts.
// The largest primary view draws into the context's own canvas; any other view is a copy (a 2D canvas) of a frame
// drawn there just before it, as the lab draws its small sizes.
import { HEAD } from './head.ts';
import { LUMEN } from './lumen.ts';
import { lights, type PaletteId } from './palette.ts';
import { STATES, type MotionState } from './state.ts';
import { STYLES, type Size, type StyleId } from './styles.ts';

export type Look = { style: Exclude<StyleId, 'glyph' | 'mark'>; palette: PaletteId; hue: number; lumen: boolean };
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
const MOMENT = [0, Infinity, Infinity, Infinity, Infinity, 6.4, 2];
/** Seconds a state takes to come in, twice over: its weight follows a value that itself follows the state, so a
 *  change begins from the pose and the pace on screen, small, and grows; a second change on its way bends it. */
const BLEND = 0.22;
/** The same for a result in a calm view (Home's band): its even form comes in, and goes again, at the pace of the
 *  band's own pulse rather than at once. */
const RESULT = 0.88;
/** Seconds a calm view's own motion takes to reach its pace, or to come to rest from it. */
const WAY = 0.8;
const VERT = '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}';
const UNI = { res: 2, org: 2, n: 1, irid: 1, dim: 1, light: 1, hoff: 1, aux: 1, ph: '4fv', v: '4fv', w: '4fv', p: '1fv', st: '1fv',
  sig: '3fv', ta: '3fv', tb: '3fv', bg: '3fv', lm: '4fv', holes: '4fv', gone: '4fv', hole: '4fv', pose: '3fv', was: 2 } as const;
/** A pulse (head.ts pulse): the seconds one unit of its clock takes, and the units it lasts until the form's ends
 *  have settled too: it rises in half a unit, falls to nothing in 2.2 more, and reaches the ends 0.9 later. */
const BEAT = 2, PULSE = 3.6;
type Uniforms = { -readonly [K in keyof typeof UNI]: number | ArrayLike<number> };
const HOLES = 24;
/** Seconds the clearing under words that have just come takes to come in (window.css: a row arrives in as long). */
const CLEAR = 0.2;
/** A carried view (View.carry): the furthest any edge of its form may go between two keyframes, in drawn pixels, and
 *  the shortest and longest time from one keyframe to the next, in seconds. Fading between two pictures an edge has
 *  moved this little in is that edge at every place between; further apart they would show as two. */
const STEP = 0.4, SPAN = [1 / 30, 1 / 4] as const;
/** A pulse's swell and a waiting question's two beats, as head.ts has them: how fast they go says when the next
 *  keyframe is due. */
const ease = (x: number) => ((x = Math.min(1, Math.max(0, x))), x * x * (3 - 2 * x));
const swell = (t: number) => ((x) => ease(t / 0.5) * (x < 0.12 ? 1 - (x * x) / 0.12 : ((1 - x) * (1 - x)) / 0.88))(Math.min(1, Math.max(0, (t - 0.5) / 2.2)));
const beats = (w: number) => ((t, b) => b(t - 0.1, 0.06) + 0.7 * b(t - 0.31, 0.07))((w / 2.4) % 1, (x: number, k: number) => Math.exp(-((x / k) ** 2)));
/** How fast a function of time goes at `t`. */
const pace = (f: (t: number) => number, t: number) => Math.abs(f(t + 0.01) - f(t - 0.01)) / 0.02;
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
/** What the debug channel's checks read: frames the page drew, keyframes it drew for the compositor to carry, how
 *  often a keyframe came too late to be faded into (its timer was held up for a whole interval, and the band stood), WebGL
 *  contexts made, the milliseconds its frames have taken the page, and the most frames a second it draws (the loop at
 *  the foot). `seen`, when a check sets it, is called with each view just drawn, the canvas that holds its picture
 *  and the view's clock. `carry`: a check may hold every view to the page's own frames; `step`: or set how far
 *  an edge may go between two keyframes. */
export const stats = { frames: 0, keys: 0, late: 0, contexts: 0, ms: 0, rate: 60, carry: false, step: STEP, seen: null as ((view: View, picture: HTMLCanvasElement, now: number) => void) | null };
let voice: VoiceSource | null = null;

/** The page's voice source, or none: while one is open, every view's listening state hears it. */
export function setVoice(v: VoiceSource | null) {
  voice = v;
  wake();
}

// ---- the contexts ----
/** A canvas the shaders draw into, with a WebGL 2 context of its own. The first is every view's. A carried view has
 *  two more, so that three pictures of it can lie over each other: the two the compositor fades between and the one
 *  being drawn for later. (A style's program costs the web view a quarter of a second to build once, and a few
 *  milliseconds in each further context.) */
type Surface = { canvas: HTMLCanvasElement; gl: WebGL2RenderingContext; parallel: { COMPLETION_STATUS_KHR: number } | null; progs: Map<StyleId, { prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> | null }> };
const surfaces: (Surface | null)[] = [];
let broken = false;
let zeroed = true;

function surface(): Surface | null {
  const canvas = document.createElement('canvas');
  canvas.className = 'motion-canvas';
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
  if (!gl) return null;
  const s: Surface = { canvas, gl, parallel: gl.getExtension('KHR_parallel_shader_compile'), progs: new Map() };
  canvas.addEventListener('webglcontextlost', (e) => (e.preventDefault(), s.progs.clear()));
  canvas.addEventListener('webglcontextrestored', () => (setup(s), views.forEach((v) => (v.dirty = true)), wake()));
  stats.contexts++;
  setup(s);
  return s;
}

function context() {
  if (!surfaces[0] && !broken) broken = !(surfaces[0] = surface());
  return surfaces[0] ?? null;
}

function setup({ gl: g }: Surface) {
  g.bindTexture(g.TEXTURE_2D, g.createTexture());
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA16F, 128, 2, 0, g.RGBA, g.FLOAT, null);
  for (const [k, v] of [[g.TEXTURE_MIN_FILTER, g.LINEAR], [g.TEXTURE_MAG_FILTER, g.LINEAR], [g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE], [g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE]])
    g.texParameteri(g.TEXTURE_2D, k!, v!);
  g.bindVertexArray(g.createVertexArray());
  zeroed = true;
}

/** A style's program in a context, or null while it is still being built: the web view builds it off the page's
 *  thread where it can, so nothing waits for it, least of all the first picture. `wait`: it is needed now. */
function program(s: Surface, id: StyleId, wait = false) {
  const g = s.gl;
  let p = s.progs.get(id);
  if (!p) {
    const prog = g.createProgram();
    for (const [type, src] of [[g.VERTEX_SHADER, VERT], [g.FRAGMENT_SHADER, HEAD + STYLES[id].frag]] as const) {
      const sh = g.createShader(type)!;
      g.shaderSource(sh, src);
      g.compileShader(sh);
      g.attachShader(prog, sh);
    }
    g.linkProgram(prog);
    s.progs.set(id, (p = { prog, loc: null }));
  }
  if (!p.loc) {
    if (!wait && s.parallel && !g.getProgramParameter(p.prog, s.parallel.COMPLETION_STATUS_KHR)) return null;
    if (!g.getProgramParameter(p.prog, g.LINK_STATUS)) throw new Error(`${id}: ${g.getProgramInfoLog(p.prog)} ${(g.getAttachedShaders(p.prog) ?? []).map((sh) => g.getShaderInfoLog(sh)).join(' ')}`);
    p.loc = Object.fromEntries(Object.keys(UNI).map((k) => [k, g.getUniformLocation(p!.prog, 'u_' + k)]));
  }
  return p as { prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> };
}

/** Whether a style can be drawn now without waiting; asking begins its building. */
export const built = (id: StyleId) => !!context() && !!program(surfaces[0]!, id);

/** Draws a style into a context; false while its program is still being built. */
function render(s: Surface, id: StyleId, w: number, h: number, U: Uniforms, wait = false) {
  const g = s.gl, p = program(s, id, wait);
  if (!p) return false;
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
  return true;
}

/** One frame of a style as a picture of its own, `size` device pixels square, drawn once and outside any view: what
 *  the glyphs at the sidebar's foot and in the wiper's wake are made of, and the mark. Null where the page cannot
 *  draw. It waits for the style's program if that is not built yet (`built` says). `light`: the studio as it is over
 *  a light backdrop, where chrome is silver cut by dark reflections. */
export function still(style: StyleId, look: Look, state: MotionState, size: number, aux: number, phase: number, light = 0): HTMLCanvasElement | null {
  const S = context(), g = S?.gl;
  if (!S || !g || g.isContextLost()) return null;
  const fb = g.createFramebuffer(), rb = g.createRenderbuffer();
  try {
    g.bindFramebuffer(g.FRAMEBUFFER, fb);
    g.bindRenderbuffer(g.RENDERBUFFER, rb);
    g.renderbufferStorage(g.RENDERBUFFER, g.RGBA8, size, size);
    g.framebufferRenderbuffer(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.RENDERBUFFER, rb);
    const s = STATES.indexOf(state), P = lights(look.palette, look.hue), st = new Float32Array(7);
    st[s] = 1;
    // Half the palette's iridescence: an object this small in full colour reads as coloured, not as metal.
    render(S, style, size, size, {
      res: [0, 0], org: [0, 0], n: 1, irid: P.irid * 0.5, dim: DIM[s]!, light, hoff: 0, aux, ph: [phase, 0, 0, 9], p: new Float32Array(8), st, sig: SIGNAL[s]!,
      ta: P.a, tb: P.b, v: [0, 0, 0, 0.4], w: [0, 0, 0.4, 0], bg: [0, 0, 0], lm: [0, 0, 1, 0], holes: new Float32Array(HOLES * 4), gone: new Float32Array(HOLES * 4), hole: [0, 0, 0, 1], pose: [0, 0, 0], was: [9, 0],
    }, true);
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

/** A keyframe of a carried view: when it is whole on screen (the page's clock, ms), the layer it is drawn in, and the
 *  view's clocks then. */
type Key = { at: number; layer: number; sim: ReturnType<View['save']> };

export class View {
  readonly el: HTMLElement;
  o: Options = { look: { style: 'slats', palette: 'chromatic', hue: 265, lumen: false }, state: 'idle' };
  dirty = true;
  /** Pictures of this view the page has drawn: frames and keyframes. */
  drawn = 0;
  /** Its clock, in ms: it moves on by the time that passed between one drawing and the next, and never by more than
   *  three frames' worth at once, so after a stall everything goes on from where it was and nothing lurches; through
   *  a rest, when nothing is in motion, it moves on by all of the rest. */
  clock = 0;
  private seen = false;
  private css = [0, 0];
  private cv: HTMLCanvasElement | null = null;
  /** Where its words are (clear): the places kept clear now, the ones before them while the change comes in, and
   *  how many there are of each, the feather, and how far that change has come. */
  private holes = new Float32Array(HOLES * 4);
  private gone = new Float32Array(HOLES * 4);
  private hole = [0, 0, 0, 1];
  private lines = '';
  private stale = true;
  /** The next change of its words is taken at once, with no fade: they moved, or the view did. */
  private snap = true;
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
   *  (the view's clock, ms) and its strength; when the next is due; how many there have been; the kick last answered. */
  private pulse = { began: -1e9, strength: 0, was: -1e9, weak: 0, due: 0, n: 0, kick: 0, on: false };
  private p = new Float32Array(8);
  private moving = false;
  private slow = 0;
  /** Seconds its phases move on by in the frame being drawn. */
  private adv = 0;
  /** While the compositor carries it: its keyframes, the last four; the timer that draws the next; the element of
   *  each layer and the fades that run on it. `left`: when the page took it back, until its next frame is drawn. */
  private plan: Key[] | null = null;
  private timer = 0;
  private wraps: HTMLElement[] = [];
  private fades: Animation[][] = [[], [], []];
  private left = 0;
  private observers: (ResizeObserver | IntersectionObserver)[];
  private words: MutationObserver;
  private watching = false;
  private fresh = true;
  /** Something changed where words can be: they are found again. The light's own elements hold none. */
  private moved = (at: EventTarget | null) => this.o.clear && worded(at) && ((this.stale = true), wake());
  /** Words that slid or scrolled take their clearing with them at once. */
  private event = (e: Event) => this.moved(e.target) && (this.snap = true);

  constructor(el: HTMLElement) {
    this.el = el;
    const resize = new ResizeObserver(([e]) => {
      const b = e!.contentRect;
      this.css = [b.width, b.height];
      const [mw, mh] = this.o.min ?? MIN;
      el.toggleAttribute('data-small', b.width < mw || b.height < mh);
      this.dirty = this.stale = this.snap = true;
      this.watch();
      wake();
    });
    const seen = new IntersectionObserver(([e]) => {
      this.seen = e!.isIntersecting;
      this.dirty = this.stale = this.snap = true;
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
    const was = this.o, changed = JSON.stringify(o) !== JSON.stringify(was);
    // What changes, changes what is on screen now: a carried view comes back to the page first.
    if (changed && this.plan) this.leave(performance.now());
    this.o = o;
    if (this.fresh) {
      this.fresh = false;
      this.settle();
      if (o.seed) (this.aux = o.seed * 7.3), (this.ph[0] = o.seed * 11.1);
    }
    else if (o.state !== was.state) this.stT = 0;
    if (o.pace === 'still') this.settle();
    if (changed) {
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
    clearTimeout(this.timer);
    this.plan = null;
    this.still();
    this.wraps.forEach((w) => w.remove());
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
    // A calm view takes a result's form, and gives it up again, four times as slowly: an accent, not a flash.
    const s = STATES.indexOf(this.o.state), k = 1 - Math.exp(-dt / (this.o.pace === 'calm' && (s === 5 || this.stV[5]! > 0.002) ? RESULT : BLEND));
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
    // A clearing that has just come in under new words comes in evenly.
    if (this.hole[3]! < 1) (this.hole[3] = Math.min(1, this.hole[3]! + dt / CLEAR)), (this.moving = true);
    this.stT += dt;
  }

  /** Whether it moves now, and so is drawn in this frame: while its states blend, while a pulse passes, while it
   *  listens, and while its own motion has any of its pace; idle, and a result or a failure once its moment is
   *  over, hold a still frame. */
  moves() {
    const s = STATES.indexOf(this.o.state), v = voice ?? SILENT;
    // Before anything else: this is where its next pulse begins.
    const pulse = this.beat(this.clock) < PULSE;
    if (this.o.pace === 'still') return false;
    if (this.moving) return true;
    if (reduced.matches) return s === 1 && Math.abs(v.slow - this.slow) > 0.004;
    // Listening is a loop like the other states that last: it rests with them in a window not in use.
    if (pulse || (s === 1 && !this.o.rest)) return true;
    return this.o.pace === 'calm' ? this.go > 0 : !(s === 0 || (s >= 5 && this.stT > 3));
  }

  /** The clock of the view's pulse, in its units; the next begins when its time has come, or at a kick. One that
   *  begins while the last still settles joins it, the two drawn together, so nothing starts again from nothing;
   *  none begins while two are passing. With none, past it. A pulse that was due begins when it was due, not at
   *  the drawing that finds it so: its rhythm is the generator's, whoever draws it and however often. */
  private beat(now: number) {
    const P = this.pulse, every = this.o.every ?? 0, kicked = (this.o.kick ?? 0) !== P.kick || (!!every && !P.on);
    P.kick = this.o.kick ?? 0;
    P.on = !!every;
    if (this.o.pulse && !reduced.matches && (kicked || (every && now >= P.due)) && (now - P.was) / 1000 / BEAT >= PULSE) {
      const r = (k: number) => Math.abs(Math.sin((++P.n + k) * 12.9898) * 43758.5453) % 1, began = kicked ? now : Math.max(P.due, now - 50);
      Object.assign(P, { was: P.began, weak: P.strength, began, strength: this.o.pulse * (kicked ? 0.8 : 0.6 + 0.4 * r(0.3)), due: began + every * 1000 * (0.72 + 0.56 * r(0.7)) });
    }
    return (now - P.began) / 1000 / BEAT;
  }
  /** When a view at rest is next due a frame, in ms from now: when its next pulse begins. Never, with none, and
   *  never while the compositor carries it. */
  rest() {
    return !this.plan && this.o.pulse && this.o.every && !reduced.matches ? Math.max(0, this.pulse.due - this.clock) : Infinity;
  }

  /** The lab's uniforms for this view at its clock, its phases moved on by `adv` seconds. */
  uniforms(adv: number, n: number): Uniforms {
    const now = this.clock;
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
      // and a result's pass of light takes four times as long.
      const s = STATES.indexOf(this.o.state);
      this.ph[3] = this.stT * (this.o.pace !== 'calm' ? 1 : s === 4 ? (this.o.tempo ?? 1) : s === 5 ? 0.25 : 1);
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
      bg: [0, 0, 0], lm: [this.lm, this.lph, amb, 0], holes: this.holes, gone: this.gone, hole: this.hole,
      pose: [this.o.pose ?? 0, (now - this.pulse.began) / 1000 / BEAT, this.pulse.strength], was: [(now - this.pulse.was) / 1000 / BEAT, this.pulse.weak],
    };
  }

  /** How many elements its style draws at its size, by the lab's kinds of size. */
  count() {
    if (this.o.count) return this.o.count;
    const [w, h] = this.css as [number, number], kind: Size = h < 48 ? (w / h > 4 ? 'strip' : 'box') : w < 200 ? 'icon' : 'hero';
    return STYLES[this.o.look.style].n[kind];
  }

  /** Finds where its words are, in its drawn pixels, from the bottom left, and says what changed: nothing (0), how
   *  wide they are (1), or which lines there are (2): words came or went. Then the clearing comes in under the new
   *  ones, and leaves where the old ones were, over CLEAR seconds, as the words themselves do: never in one frame.
   *  One change at a time: while one comes in, the next waits. Words that only moved take their clearing with them. */
  private clear(): 0 | 1 | 2 {
    if (this.hole[3]! < 1) return 0;
    this.stale = false;
    const next = new Float32Array(HOLES * 4);
    let lines = '', n = 0, feather = 0;
    if (this.o.clear) {
      // A box at least a drawn pixel wider than its words: the canvas is scaled up smoothly, which reaches that far.
      const E = this.el.getBoundingClientRect(), k = this.size()[0]! / Math.max(1, E.width), pad = Math.max(this.o.pad ?? 3, 1 / k + 1);
      const boxes = words(this.o.clear, pad).filter((b) => b.r > E.left && b.l < E.right && b.b > E.top && b.t < E.bottom);
      boxes.forEach((b, i) => next.set([((b.l + b.r) / 2 - E.left) * k, (E.bottom - (b.t + b.b) / 2) * k, ((b.r - b.l) / 2) * k, ((b.b - b.t) / 2) * k], i * 4));
      lines = boxes.map((b) => `${Math.round(b.t)}:${Math.round(b.b)}`).sort().join();
      (n = boxes.length), (feather = (this.o.feather ?? 16) * k);
    }
    if (n === this.hole[0] && feather === this.hole[1] && next.every((x, i) => x === this.holes[i])) return 0;
    const came = lines !== this.lines && !this.snap && this.o.pace === 'calm' && !reduced.matches;
    if (came) this.gone.set(this.holes);
    this.holes.set(next);
    this.hole = [n, feather, came ? this.hole[0]! : 0, came ? 0 : 1];
    this.lines = lines;
    this.snap = false;
    return came ? 2 : 1;
  }

  /** A frame of the page's has come: its clock moves on by the time that passed, and it says whether it moves. */
  pass(at: number, ms: number, gap: number) {
    // Just back from the compositor: the time since then is all that passed.
    if (this.left) (ms = Math.min(50, Math.max(0, at - this.left))), (gap = this.left = 0);
    this.clock += ms + gap;
    this.adv = reduced.matches ? 0 : ms / 1000;
    if (this.stale && this.clear()) this.dirty = true;
    this.tick(ms / 1000);
    return this.moves();
  }

  /** Draws into the first context's canvas, at most `W` by `H`, and copies the frame out unless it is the canvas's
   *  own. False while its style's program is still being built. */
  draw(host: boolean, W: number, H: number) {
    const [bw, bh] = this.size() as [number, number], main = surfaces[0]!;
    const s = host ? 1 : Math.min(1, W / bw, H / bh), rw = Math.floor(bw * s), rh = Math.floor(bh * s);
    if (!render(main, this.o.look.style, rw, rh, this.uniforms(this.adv, this.count()))) return false;
    // The light arrives; it does not appear (its program takes the web view a moment to build).
    if (!this.drawn++ && this.o.soft && this.o.pace !== 'still' && !reduced.matches) this.el.animate({ opacity: [0, 1] }, 240);
    this.dirty = false;
    this.adv = 0;
    if (host) {
      this.cv?.remove();
      this.cv = null;
      this.still();
      if (main.canvas.parentElement !== this.layer(0)) this.layer(0).append(main.canvas);
      stats.seen?.(this, main.canvas, this.clock);
      return true;
    }
    if (!this.cv) {
      this.cv = document.createElement('canvas');
      this.cv.className = 'motion-canvas';
      this.el.append(this.cv);
    }
    if (this.cv.width !== bw || this.cv.height !== bh) [this.cv.width, this.cv.height] = [bw, bh];
    const g = this.cv.getContext('2d')!;
    g.clearRect(0, 0, bw, bh);
    g.drawImage(main.canvas, 0, H - rh, rw, rh, 0, 0, bw, bh);
    stats.seen?.(this, this.cv, this.clock);
    return true;
  }

  // ---- carried by the compositor ----
  // A lasting loop of a calm view moves slowly, and the page being given frames at all is most of what such a loop
  // costs in a web view. So the page draws keyframes of it only: the form as it will be a little later, each in one of
  // three layers, and the compositor fades the layer on screen out and the next in over exactly the time between
  // them, adding the two (motion.css), which for an edge that moved less than half a pixel between them is that edge
  // at every place between. Each keyframe is drawn a whole interval before its fade begins, so a late timer shows
  // nowhere, and is due sooner the faster the form moves (a pulse rising, a question's beat) and when the next pulse
  // begins. The view's clocks run ahead of the screen by what is drawn; whatever changes it (its state, its words, its
  // size, the window) brings it back to the page at the clocks of that moment (leave), and the page draws it in
  // every frame until it is steady again.

  /** Whether the compositor may carry it at all: a calm view's loop of agents at work or of a question waiting.
   *  (Thinking shuttles a packet through the form many times faster than fading can follow, and is short; the voice
   *  is drawn as it is heard.) */
  private held() {
    const s = STATES.indexOf(this.o.state);
    return stats.carry && this.o.pace === 'calm' && (s === 3 || s === 4) && !this.o.rest && !reduced.matches;
  }

  /** In a frame of the page's: whether the compositor has it. If it has and something changed it, the page takes it back. */
  carried(at: number, alone: boolean) {
    const P = this.plan;
    if (!P) return false;
    const came = this.stale && this.clear() === 2, out = at >= P[P.length - 1]!.at;
    if (out) stats.late++;
    if (!came && !this.dirty && alone && this.held() && !out) return true;
    this.leave(at);
    return false;
  }

  /** After a frame of the page's, whole at `at`: the compositor takes it from here, if it is steady in its loop and
   *  its three layers can be drawn. */
  carry(at: number) {
    if (this.plan) return true;
    if (!this.held()) return false;
    const style = this.o.look.style;
    for (const i of [1, 2]) if (!(surfaces[i] ??= surface()) || !program(surfaces[i]!, style)) return false;
    if (this.moving || this.dirty || this.go !== 1 || this.stale) return false;
    this.plan = [{ at, layer: 0, sim: this.save() }];
    this.ahead();
    return true;
  }

  /** Draws the keyframes that are due: the one after the one coming in, as soon as that one's fade has begun. */
  private ahead = () => {
    const P = this.plan;
    if (!P) return;
    const now = performance.now();
    // The plan ran out (the page was held up for a whole interval), or it may be carried no longer: the page takes
    // it back from where it stands.
    if ((P.length > 1 && now >= P[P.length - 1]!.at) || !this.shown() || !this.held()) return wake();
    for (let n = 0; P.length < 2 || P[P.length - 2]!.at <= now; n++) {
      // Words came or went: the page draws their clearing in.
      if (this.stale && this.clear() === 2) return void ((this.dirty = true), wake());
      // Far behind: a few at a time, so that catching up holds nothing else up.
      if (n === 3) return void (this.timer = window.setTimeout(this.ahead, 0));
      this.key();
    }
    this.timer = window.setTimeout(this.ahead, P[P.length - 2]!.at - now);
  };

  /** How fast the form's edges go, in drawn pixels a second, `ahead` seconds from its clock: its own drift, its
   *  pulses as they pass each place, and a question's beats (head.ts wave, pulse, beat). */
  private speed(ahead: number) {
    const s = STATES.indexOf(this.o.state), p = STYLES[this.o.look.style].p[s]!, tempo = this.o.tempo ?? 1, P = this.pulse;
    const t = (began: number) => (this.clock - began) / 1000 / BEAT + ahead / BEAT;
    let pulse = 0;
    for (const ax of [0, 0.45, 0.9]) pulse = Math.max(pulse, P.strength * pace(swell, t(P.began) - ax) + P.weak * pace(swell, t(P.was) - ax));
    const beat = s === 4 ? 0.144 * tempo * pace(beats, (this.stT + ahead) * tempo) : 0;
    return (0.13 * p[2]! * p[1]! * tempo + (0.06 * pulse) / BEAT + beat) * this.size()[1]! * 0.475;
  }

  /** Draws the next keyframe into the layer that is clear, and has the compositor fade the last into it from the
   *  moment the last is whole. */
  private key() {
    const P = this.plan!, last = P[P.length - 1]!, layer = (last.layer + 1) % 3, S = surfaces[layer]!, [w, h] = this.size() as [number, number];
    let dt = Math.min(SPAN[1], Math.max(SPAN[0], stats.step / Math.max(this.speed(0), this.speed(SPAN[1] / 2), this.speed(SPAN[1]))));
    const due = (this.pulse.due - this.clock) / 1000;
    if (this.o.every && due > 0 && due < dt) dt = Math.max(SPAN[0], due);
    this.clock += dt * 1000;
    this.tick(dt);
    this.moves();
    for (const a of this.fades[layer]!.splice(0)) a.cancel();
    S.canvas.style.opacity = '0';
    if (S.canvas.parentElement !== this.layer(layer)) this.layer(layer).append(S.canvas);
    if (S.canvas.width !== w || S.canvas.height !== h) [S.canvas.width, S.canvas.height] = [w, h];
    render(S, this.o.look.style, w, h, this.uniforms(dt, this.count()), true);
    const o = { duration: dt * 1000, fill: 'forwards' as const }, a = S.canvas.animate({ opacity: [0, 1] }, o), b = this.layer(last.layer).animate({ opacity: [1, 0] }, o);
    a.startTime = b.startTime = last.at;
    this.fades[layer]!.push(a);
    this.fades[last.layer]!.push(b);
    P.push({ at: last.at + dt * 1000, layer, sim: this.save() });
    if (P.length > 4) P.shift();
    this.drawn++;
    stats.keys++;
    stats.seen?.(this, S.canvas, this.clock);
  }

  /** The page takes it back as it is on screen at `now`: its clocks are those of that moment, and its layers hold
   *  what they show until the page's next frame is drawn. */
  private leave(now: number) {
    const P = this.plan!;
    this.plan = null;
    clearTimeout(this.timer);
    let j = P.length - 1;
    while (j > 0 && P[j]!.at > now) j--;
    // Past its last keyframe it stood still: it goes on from there, by no more than a frame or three.
    const dt = Math.min(j === P.length - 1 ? 0.05 : Infinity, Math.max(0, now - P[j]!.at) / 1000);
    this.load(P[j]!.sim);
    this.clock += dt * 1000;
    this.tick(dt);
    this.moves();
    this.uniforms(dt, this.count());
    for (const a of this.fades.flat()) a.pause();
    this.left = now;
    this.dirty = true;
    wake();
  }

  /** No layer fades: the first context's canvas is all there is to see. */
  private still() {
    if (!this.fades.some((f) => f.length)) return;
    for (const a of this.fades.flat()) a.cancel();
    this.fades = [[], [], []];
    surfaces.forEach((s, i) => s && (s.canvas.style.opacity = i ? '0' : ''));
  }

  /** The element of a layer: it holds the layer's canvas, and is what fades it out. */
  private layer(i: number) {
    return (this.wraps[i] ??= this.el.appendChild(Object.assign(document.createElement('i'), { className: 'motion-layer' })));
  }

  private save() {
    return { clock: this.clock, stW: this.stW.slice(), stV: this.stV.slice(), go: this.go, stT: this.stT, ph: this.ph.slice(), aux: this.aux, onz: this.onz, lm: this.lm, lph: this.lph, pulse: { ...this.pulse } };
  }
  private load(s: Key['sim']) {
    this.stW.set(s.stW);
    this.stV.set(s.stV);
    Object.assign(this, { clock: s.clock, go: s.go, stT: s.stT, ph: s.ph.slice(), aux: s.aux, onz: s.onz, lm: s.lm, lph: s.lph, pulse: { ...s.pulse } });
  }

  /** For the checks: what is on screen at `now`: each picture with its share, and the view's clocks at that moment
   *  (its pulse's, its form's own phase, the seconds in its state, a sum of the places it keeps clear). */
  showing(now: number) {
    const clocks = (s: Key['sim'], more = 0) => [(s.clock + more - s.pulse.began) / 1000 / BEAT, s.ph[0]!, s.stT + more / 1000, this.holes.reduce((a, b) => a + b, 0)];
    const P = this.plan;
    if (!P) return { of: [[this.cv ?? surfaces[0]?.canvas, 1]] as [HTMLCanvasElement | undefined, number][], clocks: clocks(this.save()) };
    let j = P.length - 1;
    while (j > 0 && P[j]!.at > now) j--;
    const a = P[j]!, b = P[j + 1], f = b ? Math.min(1, Math.max(0, (now - a.at) / (b.at - a.at))) : 0, c = clocks(a.sim, b ? f * (b.at - a.at) : 0);
    if (b) c[1] = a.sim.ph[0]! + f * (b.sim.ph[0]! - a.sim.ph[0]!);
    return { of: [[surfaces[a.layer]!.canvas, 1 - f], ...(b ? [[surfaces[b.layer]!.canvas, f]] : [])] as [HTMLCanvasElement | undefined, number][], clocks: c };
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

// ---- the frame loop: running only while a view needs a frame of the page's ----
let raf = 0;
let timer = 0;
/** When a frame of the motion was last drawn, by the time its frame was given; 0 while the loop sleeps. */
let drew = 0;
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
 *  run. A timer only ends a rest, and draws a carried view's keyframes, each a whole interval early. */
function frame(at: number) {
  raf = 0;
  if (drew && at - drew < 600 / stats.rate) return void (raf = requestAnimationFrame(frame));
  const shown = [...views].filter((v) => v.shown());
  if (!shown.length || !context()) return void (drew = 0);
  const began = performance.now(), ms = drew ? Math.min(50, at - drew) : 1000 / 60, gap = slept ? Math.max(0, at - slept) : 0, main = surfaces[0]!;
  drew = at;
  slept = 0;
  voice?.update(ms / 1000, reduced.matches);
  const g = main.gl;
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
    // What the compositor carries needs no frame of the page's.
    if (v.carried(at, shown.length === 1)) continue;
    const m = v.pass(at, ms, gap);
    moving ||= m;
    // A view still and unchanged keeps the frame it has: the sidebar's glyphs turning do not redraw Home's chrome.
    if (m || v.dirty) due.push(v);
  }
  // The largest primary view is the canvas's own; the others are copies of frames drawn before it.
  const host = shown.filter((v) => v.o.primary).sort((a, b) => b.size()[0]! * b.size()[1]! - a.size()[0]! * a.size()[1]!)[0];
  const sizes = shown.map((v) => v.size());
  const [W, H] = host ? host.size() : [Math.max(...sizes.map((s) => s[0]!)), Math.max(...sizes.map((s) => s[1]!))];
  try {
    if (due.length) {
      if (main.canvas.width !== W || main.canvas.height !== H) [main.canvas.width, main.canvas.height] = [W!, H!];
      if (!host && main.canvas.parentElement) main.canvas.remove();
      let all = true;
      for (const v of due) if (v !== host) all = v.draw(false, W!, H!) && all;
      // The canvas is the host's own picture: drawn again whenever another view used it.
      if (host) all = host.draw(true, W!, H!) && all;
      stats.frames++;
      // A style still being built is drawn in the first frame after it is.
      moving ||= !all;
    }
    // A loop that has come to its pace is the compositor's from here.
    if (host && shown.length === 1 && host.carry(at)) moving = false;
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
  const rest = Math.min(...shown.map((v) => v.rest()));
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
