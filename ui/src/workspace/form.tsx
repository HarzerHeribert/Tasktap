// The parts of a form, wherever one is: Settings, and the sheets that ask before something leaves this Mac. One row
// for every setting: its question at the left, the answer at the right (a value to read, a control to change it). What
// the choice means (what is sent, what is stored, what costs power) is its hint, which Settings says in the foot of its
// window while the row has the pointer or the keyboard, and the sheets that ask before something leaves this Mac under
// the answer.
// Every row shares the two columns (window.css .set), so labels stand on one edge and answers on another.
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { PrefPatch, Shortcut } from '../../../core/proto/protocol.ts';
import { heldNow, isModifier, keyName, pressed, recorder } from '../keys.ts';
import { Key } from '../ui.tsx';
import './form.css';
import { call, fail, redraw, sentence, ui } from './model.ts';

/** What the foot of the Settings window says: the hint of the row the pointer is on, else of the row that has the
 *  keyboard, else nothing (`footing`; Frame `hint`). Nothing else says what a row's choice means. Each is kept with the
 *  row it is of, so that a hint that changes with the row's state (a sentence) is said as it changes. */
type Said = { by: object; hint: ComponentChildren } | null;
export const foot: { focus: Said; point: Said } = { focus: null, point: null };
const wordsOf = (h: ComponentChildren): string => (h == null || typeof h === 'boolean' ? '' : Array.isArray(h) ? h.map(wordsOf).join('') : typeof h === 'object' ? wordsOf((h as { props?: { children?: ComponentChildren } }).props?.children) : String(h));
export const footing = () => (foot.point ?? foot.focus)?.hint ?? null;
export const unfoot = () => ((foot.focus = foot.point = null), undefined);
/** In Settings a row's hint is not drawn in the row: the foot says it while the row has the pointer or the keyboard.
 *  Elsewhere (the sheets that ask before something leaves this Mac) it stands under the answer. */
export function Row({ name, hint, children }: { name: string; hint?: ComponentChildren; children: ComponentChildren }) {
  const settings = ui.sheet?.kind === 'settings', me = useRef({}).current;
  const say = (at: 'focus' | 'point') => hint && foot[at]?.by !== me && ((foot[at] = { by: me, hint }), redraw());
  const lose = (at: 'focus' | 'point') => foot[at]?.by === me && ((foot[at] = null), redraw());
  // A hint that changes with its row (a sentence or a few words of markup) is said as it changes, the pointer or the
  // keyboard being on the row all the while; compared by its words, since markup is new at every draw.
  useLayoutEffect(() => {
    let changed = false;
    for (const at of ['focus', 'point'] as const) {
      const now = foot[at];
      if (now?.by === me && wordsOf(now.hint) !== wordsOf(hint)) (foot[at] = hint ? { by: me, hint } : null, (changed = true));
    }
    if (changed) redraw();
  });
  return (
    <div class="set" onFocusIn={settings ? () => say('focus') : undefined} onFocusOut={settings ? (e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && lose('focus') : undefined}
      onPointerEnter={settings ? () => say('point') : undefined} onPointerLeave={settings ? () => lose('point') : undefined}>
      <span class="t">{name}</span>
      <div class="c">{children}{hint && !settings && <p class="hint">{hint}</p>}</div>
    </div>
  );
}
/** A press of a control takes the keyboard to it, as Chromium does by itself and WebKit, the Mac's engine, does not: so
 *  that the keys after a click (Tab to the next choice, Space again) start where the person pressed. */
export const taking = (e: MouseEvent) => (e.currentTarget as HTMLElement).focus();
/** One of a few: the choices side by side, the chosen one marked. */
export function Choice<T extends string | number | boolean>({ name, value, all, set }: { name: string; value: T; all: [T, ComponentChildren][]; set: (v: T) => void }) {
  return (
    <div class="seg" role="radiogroup" aria-label={name}>
      {all.map(([id, label]) => <button type="button" role="radio" aria-checked={value === id} onClick={(e) => (taking(e), set(id))}>{label}</button>)}
    </div>
  );
}
export const Switch = ({ on, name, set }: { on: boolean; name: string; set: (on: boolean) => void }) => (
  <button type="button" role="switch" class="switch" aria-checked={on} aria-label={name} onClick={(e) => (taking(e), set(!on))}><span /></button>
);

/** A key combination, recorded: the one in use is shown as a key; a click (or Return, or Space) listens, and the next
 *  combination pressed is tried with `set`. Starting to listen takes the keyboard to the recorder itself: WebKit, the
 *  Mac's engine, gives none to a button it clicked, and the keys would go past it to the sheet (Escape would close it).
 *  Whoever keeps the key decides whether it may be one: a refusal is shown under the key in their own words, and the
 *  key that was in use stays. Escape stops listening and changes nothing, and goes no further; so does leaving the
 *  control, or the sheet closing. `own`: the person chose this key, so there is a way back to the default, named by its
 *  key (`usual`). `value` null: no key is in use. */
export function Recorder({ name, value, own, usual, set }: { name: string; value: Shortcut | null; own: boolean; usual?: Shortcut; set: (key: Shortcut | null) => Promise<unknown> }) {
  const [held, hold] = useState<string | null>(null);
  const [said, say] = useState('');
  const listens = held !== null;
  // Which recorder listens is kept by the recorder itself: another one going (the section it was in left) leaves it
  // listening, and its own going ends it there and then. (Preact runs an effect's end after the next frame, and a
  // window not drawn has none: a recorder of the section left ended the listening of one pressed in the meantime.)
  const [me] = useState(() => ({}));
  const listen = (on: boolean) => {
    hold(on ? '' : null);
    if (on) recorder.by = me;
    else if (recorder.by === me) recorder.by = null;
  };
  useLayoutEffect(() => () => void (recorder.by === me && (recorder.by = null)), []);
  const tries = (key: Shortcut | null) => {
    listen(false);
    say('');
    set(key).catch((e: unknown) => say(sentence(e instanceof Error ? e.message : String(e))));
  };
  const keys = (e: KeyboardEvent) => {
    // (Its own as well as the state: a key let go in the moment after one was tried belongs to nobody.)
    if (!listens || recorder.by !== me) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'keyup' || isModifier(e)) return hold(heldNow(e));
    if (e.repeat) return;
    if (e.key === 'Escape' && !heldNow(e)) return listen(false);
    tries(pressed(e));
  };
  return (
    <>
      <button type="button" class="rec" aria-pressed={listens} aria-label={`${name}: ${value ? keyName(value) : 'no key'}. ${listens ? 'Press the keys, or Escape to leave it' : 'Press to change it'}`}
        onClick={(e) => (listens ? listen(false) : (taking(e), listen(true)))} onKeyDown={keys} onKeyUp={keys} onBlur={() => listens && listen(false)}>
        {listens ? <>{held && <Key k={held} cap />}<span>{held ? 'and a key' : 'Press the keys'}</span><Key k="esc" /></>
          : value ? <><Key k={keyName(value)} cap /><span>Change</span></> : <span>Record a key</span>}
      </button>
      {own && !listens && <button type="button" class="btn" onClick={() => tries(null)}>{usual ? `Use ${keyName(usual)}` : 'Use the default'}</button>}
      {said && <p class="hint err" role="alert">{said}</p>}
    </>
  );
}

// Every choice the core keeps is a preference, written at once, so every window follows. One write in flight per
// preference; the latest value waits for it (a hue slider moves faster than the core needs).
const pending = new Map<string, PrefPatch | null>();
export function setPref(p: PrefPatch) {
  if (pending.has(p.id)) return void pending.set(p.id, p);
  pending.set(p.id, null);
  void call('put', { c: 'prefs', ...p }).catch(fail).finally(() => {
    const next = pending.get(p.id);
    pending.delete(p.id);
    if (next) setPref(next);
  });
}
