// The motion as the pages use it: the look the person chose (the core's `prefs`, with the protocol's defaults), an
// element the engine draws into, and the backdrop: the motion behind a surface's content, placed one of a few ways.
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { PREF_DEFAULTS, type Pref } from '../../../core/proto/protocol.ts';
import { type Look, type Options, View } from './engine.ts';
import type { MotionState } from './state.ts';

export type { Look } from './engine.ts';
export type { MotionState } from './state.ts';

export function lookOf(prefs: Map<string, Pref>): Look {
  const v = <K extends keyof typeof PREF_DEFAULTS>(k: K) => (prefs.get(k)?.value ?? PREF_DEFAULTS[k]) as (typeof PREF_DEFAULTS)[K];
  return { style: v('motion_style'), palette: v('motion_palette'), hue: v('motion_hue'), lumen: v('motion_lumen') };
}

export function Motion({ class: cls, children, ...o }: Options & { class?: string; children?: ComponentChildren }) {
  const el = useRef<HTMLSpanElement>(null);
  const view = useRef<View | null>(null);
  useLayoutEffect(() => {
    const v = (view.current = new View(el.current!));
    return () => v.dispose();
  }, []);
  useLayoutEffect(() => view.current!.set(o));
  return <span ref={el} class={`motion ${cls ?? ''}`} data-style={o.look.style} data-state={o.state} aria-hidden="true">{children}</span>;
}

/** Where the motion sits on Home. `object`: the form as a thing of its own in the free space at the foot of the view,
 *  at full resolution and full brightness, moving only when something happens. `wash`: a moving backdrop behind the
 *  whole view, kept for comparison. Their boxes are in motion.css. */
type Place = { name: string; pace: 'live' | 'calm' };
export const PLACES = {
  object: { name: 'Object: in the free space at the foot of Home, moving only when something happens', pace: 'calm' },
  wash: { name: 'Wash: behind the whole view, always moving', pace: 'live' },
} satisfies Record<string, Place>;
/** The placement Home uses; the debug channel may change it to compare: `eval workspace __motion.place.home='wash'`. */
export const place: { home: keyof typeof PLACES } = { home: 'object' };
/** For the debug channel: a state shown instead of the product's, and a pace instead of the placement's
 *  (`__motion.debug.state='working'`, `__motion.debug.pace='breathe'`). */
export const debug = { state: null as MotionState | null, pace: null as Options['pace'] | null };

/** The motion on Home, keeping clear the words `clear` names. */
export function Backdrop({ look, state, clear }: { look: Look; state: MotionState; clear?: string }) {
  const P: Place = PLACES[place.home] ?? PLACES.object;
  return (
    <span class="backdrop-box home-backdrop" data-place={place.home} aria-hidden="true">
      <Motion class="backdrop" look={look} state={debug.state ?? state} primary clear={clear} pace={debug.pace ?? P.pace} pad={3} feather={12} />
    </span>
  );
}
