// The window's light: on Home, a few large, soft pools of the person's colour in the window's black, strongest by the
// capture field and around one low band of chrome, as if a large chrome form were just out of focus behind the page;
// at the sidebar's foot, the same light with a few large chrome glyphs. The pools are plain gradients the system
// composites, dithered against banding; the chrome is the motion engine's; each glyph is a picture drawn once.
// The rule (docs/rebuild-plan.md, design decision 9): the ambient layer moves while its surface is shown in the window
// in use, whether or not agents work: the pools breathe, the chrome floats, the glyphs sway, by opacity and transform
// only, which the compositor carries, at one tempo (tokens.css --t-ambient). It is a still frame that costs nothing
// while the window is not the one in use or is out of sight, under Reduce Motion, and with the core's
// `motion_ambient` at Still; Off removes it. The same state function as the motion and the notch's glow
// (motion/state.ts); a change of state still plays its moment.
import { type RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { routing } from '../capture.tsx';
import { still } from '../motion/engine.ts';
import { Motion, debug, lookOf } from '../motion/motion.tsx';
import { type RGB, lights } from '../motion/palette.ts';
import { type MotionState, motionState } from '../motion/state.ts';
import { openQuestions, pref, records, redraw, ui } from './model.ts';

/** The light's colours: deep and low in saturation at rest, so the black stays black. */
const COPPER: RGB = [0.77, 0.44, 0.24], STEEL: RGB = [0.37, 0.5, 0.75], ASKS: RGB = [0.92, 0.71, 0.46], FAIL: RGB = [0.94, 0.44, 0.43];
const mix = (a: RGB, b: RGB, t: number) => a.map((v, i) => v + (b[i]! - v) * t) as RGB;
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const srgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
/** A colour of the palette's hue, its saturation `sat` of the palette's, at the relative luminance `Y`: deep enough that
 *  the dimmest text over it keeps its contrast (tokens.css: --fg3 at 4.5 : 1 needs the ground at or below 0.0064). */
function deep(c: RGB, Y: number, sat = 0.8) {
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const g = c.map((v) => lin(Math.max(0, l + (v - l) * sat)));
  const y = 0.2126 * g[0]! + 0.7152 * g[1]! + 0.0722 * g[2]!;
  return `rgb(${g.map((v) => Math.round(255 * srgb(Math.min(1, (v * Y) / Math.max(1e-6, y))))).join(' ')})`;
}

/** States in which something happens: the glyphs stand at full strength. */
const LIVE = new Set<MotionState>(['listening', 'thinking', 'working', 'needs']);
/** The ambient light's one tempo: the seconds a breath takes (tokens.css --t-ambient). The glyphs sway and the chrome
 *  drifts in the same time: a glance of two or three seconds shows it is alive, and it is too slow to pull the eye
 *  from a row being read. */
const tempo = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--t-ambient')) || 12;
/** The share of the lab's pace the chrome moves at in a state's moment, at that tempo. */
const pace = () => 3.6 / tempo();

/** The glyphs' clock. The pools breathe and the chrome floats by the compositor alone (window.css); a glyph needs its
 *  pose named, since its picture is drawn again as it turns: once a second the clock gives each its next pose and the
 *  compositor carries it there, so a glyph moves at the display's rate and costs the page one change a second. The
 *  clock counts only while it runs, so a glyph goes on from where it stopped. */
const moving = new Set<HTMLElement>();
let clock = 0, beat = 0, stepped = 0;
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
/** Where glyph `i` stands in its sway at `beat` seconds: a drift of a few pixels, a tilt, and a rock about its upright
 *  axis that never brings it near edge-on. */
const rock = (i: number, at = beat) => Math.sin(((2 * Math.PI * at) / tempo()) * 1.23 + (1 + i * 2.1) * 1.3);
function pose(el: HTMLElement, i: number) {
  const w = (2 * Math.PI * beat) / tempo(), f = 1 + i * 2.1;
  const x = 6 * Math.sin(w + f), y = 7 * Math.sin(w * 0.81 + f * 1.7), tilt = 8 * Math.sin(w * 0.62 + f * 0.9);
  el.style.transform = `translate(${x.toFixed(2)}px,${y.toFixed(2)}px) perspective(480px) rotateY(${(24 * rock(i)).toFixed(2)}deg) rotate(${tilt.toFixed(2)}deg)`;
}
/** How a glyph's picture is drawn again, its face leaning by `lean` more, and laid over the one it has, coming in
 *  over `seconds`. */
const drawers = new WeakMap<HTMLElement, (lean: number, seconds: number) => void>();
/** The reflection follows the rock, slowly: three times a breath the glyph is drawn again as it will then face, and
 *  comes in over a moment, as a glint. */
function reflect(el: HTMLElement, i: number) {
  const span = tempo() / 3, k = String(Math.floor(beat / span + i / 3));
  if (el.dataset.k !== k) (el.dataset.k = k), drawers.get(el)?.(0.3 * rock(i, beat + span / 2), 1.5);
}
function step() {
  const now = performance.now();
  beat += Math.min(1, (now - stepped) / 1000);
  stepped = now;
  for (const root of moving) root.querySelectorAll<HTMLElement>('.turn').forEach((el, i) => (pose(el, i), reflect(el, i)));
}
function useSway(ref: RefObject<HTMLElement | null>, on: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !on || reduce.matches) return;
    if (!moving.size) (stepped = performance.now()), (clock = window.setInterval(step, 1000));
    moving.add(el);
    return () => {
      moving.delete(el);
      if (!moving.size) clearInterval(clock);
    };
  }, [on, ref.current]);
}

let last: { state: MotionState; at: number } = { state: 'idle', at: 0 };
let settle = 0;
// Out of sight it is still, and moves again when it is seen.
document.addEventListener('visibilitychange', redraw);

/** The look the wake's glyphs take, or none while the ambient light is off. */
export const wakeLook = () => (pref('motion_ambient') === 'off' ? null : lookOf(records.prefs));

/** What the light shows now: its state, the person's look, its colours, whether it breathes. */
export function useLight() {
  const state = debug.state ?? motionState({
    thoughts: records.thoughts.values(), sessions: records.sessions.values(), questions: openQuestions().length, routing: routing(), voice: ui.voice,
  });
  const now = Date.now();
  if (state !== last.state) {
    last = { state, at: now };
    clearTimeout(settle);
    settle = window.setTimeout(redraw, 2550);
  }
  const look = lookOf(records.prefs);
  const L = lights(look.palette, look.hue);
  // Chromatic is the 1.2 metal's copper and steel; the others their palette's two lights.
  const [a, b] = L.irid ? [STEEL, COPPER] : [L.a, L.b];
  const mode = pref('motion_ambient');
  const asks = state === 'needs';
  const c1 = asks ? mix(a, ASKS, 0.6) : a, c2 = asks ? mix(b, ASKS, 0.35) : b, c3 = state === 'failed' ? FAIL : mix(a, b, 0.5);
  const level = asks ? 1.2 : state === 'idle' ? 0.85 : 1;
  const breathe = debug.breathe ?? (mode === 'breathing' && ui.active && !document.hidden);
  return {
    state, look, mode, breathe, lift: state === 'done' && now - last.at < 2500,
    vars: {
      // The pool at the lower right lies under the most rows' times, the dimmest words: it stays at its default.
      '--c1': deep(c1, 0.0068 * level), '--glow': deep(c1, 0.02 * level), '--c2': deep(c2, 0.0056 * Math.min(level, 1.05), 0.7), '--c3': deep(c3, (state === 'failed' ? 0.008 : 0.005) * level),
      '--spark': String(LIVE.has(state) ? 1 : 0.8),
    },
  };
}

/** A tile of fine noise laid over the light, made once: on near-black a gradient bands, and the noise dithers it. */
let grain = '';
function noise() {
  if (grain) return grain;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 96;
    const g = c.getContext('2d')!;
    const img = g.createImageData(96, 96);
    for (let i = 0; i < 96 * 96; i++) {
      const v = Math.random() * 64;
      img.data.set([v, v, v, 22], i * 4);
    }
    g.putImageData(img, 0, 0);
    grain = `url(${c.toDataURL()})`;
  } catch {
    grain = 'none';
  }
  return grain;
}

/** Home's light: three pools and the chrome band, behind the column. `load` dims the chrome as the page fills. */
export function Light({ load }: { load: 'quiet' | 'busy' | 'asks' | 'paged' }) {
  const l = useLight();
  useEffect(() => void document.documentElement.style.setProperty('--noise', noise()), []);
  if (l.mode === 'off') return null;
  // Its chrome is drawn on a change of state and then held as a picture; while the light breathes the compositor floats
  // that picture a few pixels each way (window.css), inside the room its words are given. Focus entering the panel
  // lifts the light and stirs the chrome, for a second (data-stir).
  return (
    <div class="light" data-state={l.state} data-breathe={String(l.breathe)} data-lift={l.lift || undefined} data-stir={ui.greet === 'main' || undefined} data-load={load} style={l.vars} aria-hidden="true">
      <i class="pool a" /><i class="pool b" /><i class="pool c" />
      <span class="band">
        <Motion look={l.look} state={l.state} pace="calm" tempo={pace()} fps={12} clear=".hx" pad={10} feather={30} soften={7} />
      </span>
    </div>
  );
}

/** The glyphs at the sidebar's foot, the largest first: which character (plus, slash, equals), its size, where its
 *  centre stands across the sidebar, how far its box stands off the foot, and how its face leans. Few, large, and none
 *  small: below about 50 px a glyph stops reading as its character in metal on a 1x display. */
const GLYPHS = [
  { k: 0, size: 100, x: 0.36, y: 26, lean: -0.75 },
  { k: 2, size: 64, x: 0.78, y: 22, lean: -0.45 },
  { k: 1, size: 76, x: 0.69, y: 104, lean: -1 },
] as const;

/** One glyph: a picture of it in chrome, drawn once for the look and the state and laid over the last one, which it
 *  replaces by fading in; the clock sways the picture, and the glyph itself arrives and leaves by its own transition. */
function Glyph({ i, here, look, state }: { i: number; here: boolean; look: ReturnType<typeof lookOf>; state: MotionState }) {
  const g = GLYPHS[i]!;
  const turn = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = turn.current;
    if (!el || !here) return;
    const draw = (lean: number, seconds: number) => {
      const cv = still('glyph', look, state, Math.round(g.size * Math.max(2, devicePixelRatio || 1)), g.k, g.lean + lean);
      if (!cv) return;
      cv.style.transitionDuration = `${seconds}s`;
      // The picture before stays under the new one while it comes in.
      while (el.children.length > 1) el.firstElementChild!.remove();
      el.append(cv);
    };
    drawers.set(el, draw);
    draw(0.3 * rock(i), 1.2);
    pose(el, i);
  }, [here, JSON.stringify(look), state]);
  return (
    <span class={`glyph${here ? ' in' : ''}`} style={{ width: `${g.size}px`, height: `${g.size}px`, left: `calc(${g.x * 100}% - ${g.size / 2}px)`, bottom: `${g.y}px`, '--i': String(i) }}>
      <i class="turn" ref={turn} />
    </span>
  );
}

/** The sidebar's foot: the same light rising from the bottom, and the glyphs, there only where the rows leave them
 *  room; rows always win. They sway while the light breathes, hold their pose when it is still, step back while the
 *  window is not the one in use, and step forward again when focus enters the sidebar (window.css greet). */
export function Spark() {
  const l = useLight();
  const ref = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const watch = new ResizeObserver(([e]) => setRoom(e?.contentRect.height ?? 0));
    watch.observe(ref.current!);
    return () => watch.disconnect();
  }, []);
  useSway(ref, l.breathe);
  return (
    <div class="spark" ref={ref} data-state={l.state} data-breathe={String(l.breathe)} data-away={!ui.active && !debug.breathe ? '' : undefined} style={l.vars} aria-hidden="true">
      {l.mode !== 'off' && <i class="pool s" />}
      {l.mode !== 'off' && GLYPHS.map((g, i) => <Glyph key={i} i={i} here={room >= g.y + g.size + 12} look={l.look} state={l.state} />)}
    </div>
  );
}
