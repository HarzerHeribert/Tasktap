// The window's light: on Home, a few large, soft pools of the person's colour in the window's black, strongest by the
// capture line and around one low band of chrome, as if a large chrome form were just out of focus behind the page;
// at the sidebar's foot, a small zone of the same light with a few chrome glyphs that turn while agents work. The
// pools are plain gradients the system composites, dithered against banding, and they breathe only by opacity, set four
// times a second, so a breath costs the page and the window server next to nothing. The chrome is the motion engine's,
// drawn on a change of state and
// then held, softened once as it is copied, and kept out from under every word. One setting, Ambient light: Off,
// Still or Breathing. The same state function as the motion and the notch's glow (motion/state.ts).
import { type RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { routing } from '../capture.tsx';
import { Motion, debug, lookOf } from '../motion/motion.tsx';
import { type RGB, lights } from '../motion/palette.ts';
import { type MotionState, motionState } from '../motion/state.ts';
import { ambient } from './ambient.ts';
import { openQuestions, records, redraw, ui } from './model.ts';

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

/** States in which something happens: the light breathes. */
const LIVE = new Set<MotionState>(['listening', 'thinking', 'working', 'needs']);
/** How long the light keeps breathing after a change of state, as a moment of its own. */
const AFTER = 6000;
const STRENGTH = { faint: 0.6, default: 1, strong: 1.6 };
/** The ambient light's one tempo, for the chrome, the glyphs and the breathing alike: the share of the lab's pace its
 *  forms move at, and the seconds a breath takes. At a glance it is still; only a longer look shows it moving. */
export const TEMPO = { slow: { pace: 0.3, breath: 14 }, slower: { pace: 0.15, breath: 24 }, slowest: { pace: 0.07, breath: 38 } };
export const tempo = () => TEMPO[debug.tempo ?? 'slower'];

/** Breathing: one timer sets the pools' opacity four times a second, so the window is composited that often and not at
 *  the display's rate. A step is under one percent of a pool's opacity, below what the eye can tell at this tempo. */
const breathing = new Set<HTMLElement>();
let breathTimer = 0;
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const OFFSET = [0, 0.4, 0.7], LENGTH = [1, 1.23, 1.47];
function breath() {
  const t = performance.now() / 1000, T = 2 * tempo().breath;
  for (const root of breathing)
    root.querySelectorAll<HTMLElement>(':scope > .pool').forEach((p, i) => {
      const x = 0.5 - 0.5 * Math.cos(2 * Math.PI * (t / (T * (LENGTH[i] ?? 1)) + (OFFSET[i] ?? 0)));
      p.style.opacity = (0.66 + 0.34 * x).toFixed(3);
    });
}
function useBreath(ref: RefObject<HTMLElement | null>, on: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !on || reduce.matches) return;
    breathing.add(el);
    breathTimer ||= window.setInterval(breath, 250);
    breath();
    return () => {
      breathing.delete(el);
      el.querySelectorAll<HTMLElement>(':scope > .pool').forEach((p) => (p.style.opacity = ''));
      if (!breathing.size) (clearInterval(breathTimer), (breathTimer = 0));
    };
  }, [on, ref.current]);
}

let last: { state: MotionState; at: number } = { state: 'idle', at: 0 };
let settle = 0;

/** What the light shows now: its state, the person's look, its colours, whether it breathes. */
export function useLight() {
  const state = debug.state ?? motionState({
    thoughts: records.thoughts.values(), sessions: records.sessions.values(), questions: openQuestions().length, routing: routing(), voice: ui.voice,
  });
  const now = Date.now();
  if (state !== last.state) {
    last = { state, at: now };
    clearTimeout(settle);
    settle = window.setTimeout(redraw, AFTER + 50);
  }
  const look = lookOf(records.prefs);
  const L = lights(look.palette, look.hue);
  // Chromatic is the 1.2 metal's copper and steel; the others their palette's two lights.
  const [a, b] = L.irid ? [STEEL, COPPER] : [L.a, L.b];
  const mode = ambient();
  const k = STRENGTH[debug.strength ?? 'default'];
  const asks = state === 'needs';
  const c1 = asks ? mix(a, ASKS, 0.6) : a, c2 = asks ? mix(b, ASKS, 0.35) : b, c3 = state === 'failed' ? FAIL : mix(a, b, 0.5);
  const level = (asks ? 1.2 : state === 'idle' ? 0.85 : 1) * k;
  const breathe = debug.breathe ?? (mode === 'breathing' && ui.active && (LIVE.has(state) || now - last.at < AFTER));
  return {
    state, look, mode, breathe, lift: state === 'done' && now - last.at < 2500,
    vars: {
      // The pool at the lower right lies under the most rows' times, the dimmest words: it stays at its default.
      '--c1': deep(c1, 0.0068 * level), '--glow': deep(c1, 0.02 * level), '--c2': deep(c2, 0.0056 * Math.min(level, 1.05), 0.7), '--c3': deep(c3, (state === 'failed' ? 0.008 : 0.005) * level),
      '--chrome': String(Math.min(1, 0.5 * k)), '--spark': String(LIVE.has(state) ? 1 : 0.6),
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
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => void document.documentElement.style.setProperty('--noise', noise()), []);
  useBreath(ref, l.breathe && l.mode === 'breathing');
  if (l.mode === 'off') return null;
  return (
    <div class="light" ref={ref} data-state={l.state} data-breathe={String(l.breathe)} data-lift={l.lift || undefined} data-load={load} style={l.vars} aria-hidden="true">
      <i class="pool a" /><i class="pool b" /><i class="pool c" />
      <span class="band">
        <Motion look={l.look} state={l.state} pace="calm" tempo={tempo().pace} fps={12} clear=".hx" pad={10} feather={30} soften={7} />
      </span>
    </div>
  );
}

/** The glyphs at the sidebar's foot: one each, a size two thirds of the one before, the smaller dimmer and further
 *  back, placed as a group. A glyph smaller than the last of these does not read as metal at 1x and is not drawn. */
const GLYPHS = [
  { size: 88, x: 0.6, y: 14, seed: 1 },
  { size: 60, x: 0.27, y: 66, seed: 2 },
  { size: 42, x: 0.82, y: 104, seed: 3 },
] as const;

/** The sidebar's foot: the same light rising from the bottom, and a few chrome glyphs that turn while agents work.
 *  It takes only the room the rows leave; rows always win. */
export function Spark() {
  const l = useLight();
  const ref = useRef<HTMLDivElement>(null);
  useBreath(ref, l.breathe && l.mode === 'breathing');
  if (l.mode === 'off') return <div class="spark" />;
  const pace = debug.pace ?? (l.mode === 'breathing' && (ui.active || debug.breathe) ? 'breathe' : 'calm');
  return (
    <div class="spark" ref={ref} data-state={l.state} data-breathe={String(l.breathe)} style={l.vars} aria-hidden="true">
      <i class="pool s" />
      {GLYPHS.map((g, i) => (
        <span class="glyph" style={{ width: `${g.size}px`, height: `${g.size}px`, left: `calc(${g.x * 100}% - ${g.size / 2}px)`, bottom: `${g.y}px`, '--depth': String(1 - i * 0.28) }}>
          <Motion look={{ ...l.look, style: 'glyphs' }} state={l.state} pace={pace} tempo={tempo().pace} fps={4} min={[24, 24]} count={1} seed={g.seed} />
        </span>
      ))}
    </div>
  );
}
