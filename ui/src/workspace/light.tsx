// The window's light: on Home, a few large, soft pools of the person's colour in the window's black, strongest by the
// capture field and around one low band of chrome, as if a large chrome form were just out of focus behind the page;
// at the sidebar's foot, the same light with a few large chrome glyphs. The pools are plain gradients the system
// composites, dithered against banding; the chrome is the motion engine's; each glyph is a picture drawn once.
// The rule (docs/rebuild-plan.md, design decision 9): at rest the ambient layer is still, and costs nothing. While
// something goes on (agents thinking or working, a question waiting, the voice) it is a loop that runs for as long as
// that lasts: the pools breathe and the glyphs sway by opacity and transform, which the compositor carries, and the
// chrome moves in its shader, all at one tempo (tokens.css --t-ambient). A change of state blends one loop into the
// next from where it is; a result, a failure and a region taking focus are moments laid over it. It rests while
// nothing goes on, while the window is not the one in use or is out of sight, and below Full on the effects control
// (the core's `motion_ambient`; Reduce Motion and Low Power Mode hold Full at Still); Off draws none of it. The same
// state function as the motion and the notch's glow (motion/state.ts).
import { type RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { routing } from '../capture.tsx';
import { built, still } from '../motion/engine.ts';
import { Motion, debug, lookOf } from '../motion/motion.tsx';
import { wake as stir } from '../motion/paced.ts';
import { type RGB, lights } from '../motion/palette.ts';
import { type MotionState, motionState } from '../motion/state.ts';
import { openQuestions, pref, records, redraw, ui } from './model.ts';

/** The light's colours: deep and low in saturation at rest, so the black stays black. */
const COPPER: RGB = [0.77, 0.44, 0.24], STEEL: RGB = [0.37, 0.5, 0.75], ASKS: RGB = [0.92, 0.71, 0.46], FAIL: RGB = [0.94, 0.44, 0.43];
const mix = (a: RGB, b: RGB, t: number) => a.map((v, i) => v + (b[i]! - v) * t) as RGB;
const rgb = (c: RGB) => `rgb(${c.map((v) => Math.round(255 * Math.min(1, v))).join(' ')})`;
/** The Composer's lit rim in a palette's two lights, laid out as the token --lit is: the second light at its ends, the
 *  first through its middle, brightest a little before the centre. */
const rim = (a: RGB, b: RGB) =>
  `linear-gradient(90deg,${rgb(b)},${rgb(mix(b, a, 0.5))} 18%,${rgb(mix(a, [1, 1, 1], 0.75))} 40%,${rgb(a)} 62%,${rgb(mix(a, b, 0.5))} 82%,${rgb(b)})`;
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

/** States that last: something goes on for as long as one does, the layer moves for as long, and the glyphs stand at
 *  full strength. */
const ONGOING = new Set<MotionState>(['listening', 'thinking', 'working', 'needs']);
/** The ambient light's one tempo: the seconds a breath takes (tokens.css --t-ambient). The glyphs sway and the chrome
 *  drifts in the same time: a glance of two or three seconds shows it is alive, and it is too slow to pull the eye
 *  from a row being read. */
let tokens: { tempo: number; amount: number } | null = null;
/** Read once: asking for a computed style in the middle of a render makes the page work its styles out there and then. */
const token = () => (tokens ??= ((s) => ({ tempo: parseFloat(s.getPropertyValue('--t-ambient')) || 12, amount: parseFloat(s.getPropertyValue('--ambient')) || 1 }))(getComputedStyle(document.documentElement)));
const tempo = () => token().tempo;
/** The share of the lab's pace the chrome moves at, at that tempo. */
const pace = () => 3.6 / tempo();
/** How far everything ambient travels (tokens.css --ambient): 1 is the owner's "calmer". */
const amount = () => token().amount;

/** The glyphs' reflections. A glyph sways by the compositor alone (window.css sway, tilt, rock), so it never stops and
 *  starts; what the page does is draw its picture again, every eight seconds, as it then faces, and bring that in
 *  evenly over the whole of those eight seconds, so its reflections change all the time and never in a step. Each
 *  drawing reads a picture back from the graphics card, which is all the glyphs cost, so it is no more often. */
const moving = new Set<HTMLElement>();
let clock = 0, beat = 0;
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
/** How a glyph's picture is drawn again, its face leaning by `lean` more, and laid over the one it has, coming in
 *  over `seconds`. */
const drawers = new WeakMap<HTMLElement, (lean: number, seconds: number) => void>();
/** How far a glyph is turned about its upright axis now, of the furthest it turns: -1 to 1. */
const turned = (el: HTMLElement) => Math.max(-1, Math.min(1, -new DOMMatrix(getComputedStyle(el).transform).m13 / Math.sin(0.28)));
function step() {
  beat++;
  for (const root of moving)
    root.querySelectorAll<HTMLElement>('.turn').forEach((el, i) => (beat + i * 3) % 8 === 0 && drawers.get(el)?.(0.3 * turned(el), 8));
}
function useSway(ref: RefObject<HTMLElement | null>, on: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    if (!moving.size) clock = window.setInterval(step, 1000);
    moving.add(el);
    return () => {
      moving.delete(el);
      if (!moving.size) clearInterval(clock);
    };
  }, [on, ref.current]);
}

/** How many times focus entering the panel has been answered, and whether it is being answered now. */
let greets = 0, greeted = false;
let last: { state: MotionState; at: number } = { state: 'idle', at: 0 };
let settle = 0;
// Out of sight it is still, and moves again when it is seen.
document.addEventListener('visibilitychange', redraw);

/** The level of the effects: the person's choice (the core's `motion_ambient`: off, still, breathing), with Full
 *  held at Still while the system asks for less: Reduce Motion, or Low Power Mode (which the host tells, main.tsx). */
export type Effects = 'off' | 'still' | 'full';
export const power = { low: false };
export function effects(): Effects {
  const chosen = pref('motion_ambient');
  return chosen === 'off' ? 'off' : chosen === 'still' || reduce.matches || (debug.saving ?? power.low) ? 'still' : 'full';
}
reduce.addEventListener('change', redraw);

/** The look the wake's glyphs take, or none below Full. */
export const wakeLook = () => (effects() === 'full' ? lookOf(records.prefs) : null);

/** What the light shows now: its state, the person's look, the level of the effects, its colours, and whether it
 *  moves: at Full, in the window in use, while something goes on. */
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
  const fx = effects();
  const asks = state === 'needs';
  const c1 = asks ? mix(a, ASKS, 0.6) : a, c2 = asks ? mix(b, ASKS, 0.35) : b, c3 = state === 'failed' ? FAIL : mix(a, b, 0.5);
  const level = asks ? 1.2 : state === 'idle' ? 0.85 : 1;
  // The Composer stands in this light and takes its colour from it, never from a fill of its own: the light gathered
  // behind it is the palette's first light, and its lit rim the palette's two. The default palette is every colour,
  // so it has none there: its two lights together, which is no colour, behind the field, and the token's rim.
  const behind = L.irid ? mix(L.a, L.b, 0.5) : a;
  const active = (debug.active ?? ui.active) && !document.hidden;
  return {
    // Behind an open sheet it is a still picture: the sheet is what is read.
    state, look, level: fx, active, moves: fx === 'full' && active && !ui.sheet && ONGOING.has(state), lift: fx === 'full' && state === 'done' && now - last.at < 2500,
    vars: fx === 'off' ? {} : {
      // The pool at the lower right lies under the most rows' times, the dimmest words: it stays at its default.
      '--c1': deep(c1, 0.0068 * level), '--glow': deep(asks ? mix(behind, ASKS, 0.6) : behind, 0.02 * level), ...(L.irid ? {} : { '--edge': rim(a, b) }), '--c2': deep(c2, 0.0056 * Math.min(level, 1.05), 0.7), '--c3': deep(c3, (state === 'failed' ? 0.008 : 0.005) * level),
      '--spark': String(ONGOING.has(state) ? 1 : 0.8),
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
  // Its pools breathe while it moves: the page moves them, at the motion's pace (paced.ts).
  useLayoutEffect(() => stir(), [l.moves]);
  if (l.level === 'off') return null;
  // Its chrome stands in the icon's S, never on a level row (engine.ts pose), and stays there. While agents think or
  // work its form drifts in its own slow way and, every breath or so, a pulse swells its heights from the centre
  // outward and settles, its faces turning a little as it passes (engine.ts pulse); a question waiting is its two
  // slow beats, and no pulse. Focus entering the panel, and a result arriving, lift the light; focus sends a pulse
  // at once. Below Full it is a fixed picture.
  if (ui.greet === 'main' && !greeted) greets++;
  greeted = ui.greet === 'main';
  const full = l.level === 'full';
  return (
    <div class="light" data-state={l.state} data-moves={String(l.moves)} data-stir={ui.greet === 'main' || l.lift || undefined} data-load={load} style={l.vars} aria-hidden="true">
      <i class="pool a" /><i class="pool b" /><i class="pool c" />
      <span class="band">
        <Motion look={l.look} state={l.state} pace={full ? 'calm' : 'still'} rest={!l.active} primary soft pose={1} pulse={full ? amount() : 0}
          every={l.moves && (l.state === 'thinking' || l.state === 'working') ? 1.25 * tempo() : 0} kick={greets} tempo={pace()} clear=".hx" pad={10} feather={30} />
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
    // One glyph a moment, in the order they arrive: three pictures read back in one frame would hold that frame up.
    // And none before the glyph's program is built, which the web view does aside: nothing waits for it.
    let first = window.setTimeout(function go() {
      if (built('glyph')) draw(0.3 * turned(el), 1.2);
      else first = window.setTimeout(go, 50);
    }, el.children.length ? i * 140 : 0);
    return () => clearTimeout(first);
  }, [here, JSON.stringify(look), state]);
  return (
    <span class={`glyph${here ? ' in' : ''}`} style={{ width: `${g.size}px`, height: `${g.size}px`, left: `calc(${g.x * 100}% - ${g.size / 2}px)`, bottom: `${g.y}px`, '--i': String(i) }}>
      <i class="turn" ref={turn} />
    </span>
  );
}

/** The sidebar's foot: the same light rising from the bottom, and the glyphs, there only where the rows leave them
 *  room; rows always win. They sway while the light moves, hold their pose when it rests, step back while the
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
  useSway(ref, l.moves);
  useLayoutEffect(() => stir(), [l.moves]);
  return (
    <div class="spark" ref={ref} data-state={l.state} data-moves={String(l.moves)} data-away={l.active ? undefined : ''} style={l.vars} aria-hidden="true">
      {l.level !== 'off' && <i class="pool s" />}
      {l.level !== 'off' && GLYPHS.map((g, i) => <Glyph key={i} i={i} here={room >= g.y + g.size + 12} look={l.look} state={l.state} />)}
    </div>
  );
}
