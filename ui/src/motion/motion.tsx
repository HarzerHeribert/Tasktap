// The motion as the pages use it: the look the person chose (the core's `prefs`, with the protocol's defaults), and an
// element the engine draws into.
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

/** For the debug channel: a state shown instead of the product's (`__motion.debug.state='working'`), and the light
 *  breathing, or not, whatever the window and the state (measure.sh). */
export const debug = {
  state: null as MotionState | null,
  breathe: null as boolean | null,
};
