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

/** Where a backdrop sits, how finely it is drawn, and how bright its metal is with Lumen on and off. Its box is in
 *  motion.css. With Lumen off every placement shows the form alone, drawn brighter; idle holds it still. */
type Place = { name: string; scale: number; form: [on: number, off: number] };
export const PLACES = {
  notch: {
    glass: { name: 'Dark glass: the form large and soft behind the whole sheet, mostly its light', scale: 0.25, form: [0.35, 0.55] },
    rise: { name: 'Rising band: from the bottom edge, fading out below the content', scale: 0.5, form: [0.8, 1] },
    crown: { name: 'Crown: from behind the camera along the top edge, fading out above the content', scale: 0.5, form: [0.55, 0.8] },
  },
  home: {
    header: { name: 'Header light: across the top, where 1.2 played its artwork', scale: 0.5, form: [0.75, 1] },
    low: { name: 'Low form: large and low in the view, behind the lists', scale: 0.5, form: [0.7, 0.9] },
    wash: { name: 'Wash: the whole view, mostly its light', scale: 0.25, form: [0.3, 0.5] },
  },
} satisfies Record<string, Record<string, Place>>;
export type Surface = keyof typeof PLACES;
/** The placement each surface uses. The debug channel may change it to compare them: `eval notch __motion.place.notch='glass'`. */
export const place: { notch: keyof typeof PLACES.notch; home: keyof typeof PLACES.home } = { notch: 'rise', home: 'header' };
/** For the debug channel's measurements: a state every backdrop shows instead of the product's (`__motion.debug.state='working'`). */
export const debug = { state: null as MotionState | null };

/** The motion behind a surface's content, keeping clear the words `clear` names. A miniature (the appearance
 *  panel's preview) is a copy, drawn finely, with no words to keep clear. */
export function Backdrop({ surface, at, look, state, active, clear, mini }: {
  surface: Surface; at?: string; look: Look; state: MotionState; active?: boolean; clear?: string; mini?: boolean;
}) {
  const id = (at ?? place[surface]) as keyof (typeof PLACES)[Surface];
  const P: Place = (PLACES[surface] as Record<string, Place>)[id] ?? Object.values(PLACES[surface])[0]!;
  return (
    <span class={`backdrop-box ${surface}-backdrop`} data-place={id} aria-hidden="true">
      <Motion class="backdrop" look={look} state={debug.state ?? state} active={active} primary={!mini} clear={mini ? undefined : clear}
        scale={mini ? 1 : P.scale} form={P.form[look.lumen ? 0 : 1]} pad={3} feather={12} />
    </span>
  );
}
