// The page's CSS loops, moved by the page at the motion's pace instead of by the compositor at the display's: the
// light's pools breathing and its glyphs swaying (window.css), the mark at work and an agent's ring turning
// (parts.css), the notch's glow (notch.css). The compositor moves an animation in every frame of the display, 240 a
// second on a fast one, and every such frame costs the graphics processor whatever moved in it: the tab's blurred glow
// cost 4 to 5 % of the tower's card that way. Here each loop is held, and in each frame the
// motion's pace allows (pace.ts: at most 60 a second, in the frames the motion draws in) it is set to exactly where it
// would be at that moment: the frames that are drawn are the ones the compositor would have drawn then. A loop that
// CSS holds (the light's, while it rests) stays where it is, and goes on from there when CSS lets it run again.
// Each is taken the moment it starts (`animationstart`, which comes before the frame it would first be drawn in), or
// when the page says one may have begun to run (`wake`: the light's own `data-moves`).
import { pace } from './pace.ts';

/** The loops, by their keyframes' names. */
const LOOPS = new Set(['breath', 'sway', 'tilt', 'rock', 'pass-1', 'pass-2', 'pass-3', 'ring-turn', 'glow-in', 'glow-drift', 'glow-breathe']);

type Held = { el: Element; pseudo: string | null; name: string; time: number };
const held = new Map<CSSAnimation, Held>();
let raf = 0, last = 0;

/** Takes the loops the compositor would run. */
function take() {
  for (const a of document.getAnimations()) {
    if (!(a instanceof CSSAnimation) || held.has(a) || !LOOPS.has(a.animationName)) continue;
    const effect = a.effect as KeyframeEffect | null, el = effect?.target;
    if (!effect || !el) continue;
    const time = Number(a.currentTime ?? 0);
    a.pause();
    a.currentTime = time;
    held.set(a, { el, pseudo: effect.pseudoElement, name: a.animationName, time });
  }
}

/** Whether CSS has it running (window.css holds the light's loops while it rests). */
function runs(h: Held) {
  const s = getComputedStyle(h.el, h.pseudo), names = s.animationName.split(', '), states = s.animationPlayState.split(', ');
  return (states[Math.max(0, names.indexOf(h.name)) % states.length] ?? 'running') === 'running';
}

function frame(at: number) {
  raf = 0;
  if (!pace.take(at)) return void (raf = requestAnimationFrame(frame));
  const dt = last ? at - last : 0;
  last = at;
  // Every loop's state is read before any is moved: the page's styles worked out once, not once for each.
  const live = [...held].filter(([a, h]) => {
    const gone = a.playState === 'idle' || !h.el.isConnected;
    if (gone) held.delete(a);
    return !gone && runs(h);
  });
  for (const [a, h] of live) {
    // Its own clock, moved on by the time that passed, as the compositor's would be.
    const end = Number(a.effect?.getComputedTiming().endTime);
    a.currentTime = h.time = Math.min(end, h.time + dt);
    if (h.time >= end) held.delete(a);
  }
  if (live.length) raf = requestAnimationFrame(frame);
  else last = 0;
}

/** A loop may have begun, or begun to run again: it is taken, and moved from the next frame the pace allows. */
export function wake() {
  take();
  if (!raf && held.size) raf = requestAnimationFrame(frame);
}

// Taken before the frame it would first be drawn in: the compositor never runs it.
document.addEventListener('animationstart', (e) => LOOPS.has(e.animationName) && wake(), true);
