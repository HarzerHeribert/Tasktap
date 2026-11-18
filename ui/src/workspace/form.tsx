// The parts of a form, wherever one is: Settings, and the sheets that ask before something leaves this Mac. One row
// for every setting: its question at the left, the answer at the right (a value to read, a control to change it), and
// under the answer, only where it matters, what the choice means: what is sent, what is stored, what costs power.
// Every row shares the two columns (window.css .set), so labels stand on one edge and answers on another.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { PrefPatch, Shortcut } from '../../../core/proto/protocol.ts';
import { heldNow, isModifier, keyName, pressed, recorder } from '../keys.ts';
import { Key } from '../ui.tsx';
import { call, fail, sentence } from './model.ts';

export function Row({ name, hint, children }: { name: string; hint?: ComponentChildren; children: ComponentChildren }) {
  return (
    <div class="set">
      <span class="t">{name}</span>
      <div class="c">{children}{hint && <p class="hint">{hint}</p>}</div>
    </div>
  );
}
/** One of a few: the choices side by side, the chosen one marked. */
export function Choice<T extends string | number | boolean>({ name, value, all, set }: { name: string; value: T; all: [T, ComponentChildren][]; set: (v: T) => void }) {
  return (
    <div class="seg" role="radiogroup" aria-label={name}>
      {all.map(([id, label]) => <button type="button" role="radio" aria-checked={value === id} onClick={() => set(id)}>{label}</button>)}
    </div>
  );
}
export const Switch = ({ on, name, set }: { on: boolean; name: string; set: (on: boolean) => void }) => (
  <button type="button" role="switch" class="switch" aria-checked={on} aria-label={name} onClick={() => set(!on)}><span /></button>
);

/** A key combination, recorded: the one in use is shown as a key; a click (or Return, or Space) listens, and the next
 *  combination pressed is tried with `set`. Whoever keeps the key decides whether it may be one: a refusal is shown
 *  under the key in their own words, and the key that was in use stays. Escape stops listening and changes nothing;
 *  so does leaving the control. `own`: the person chose this key, so there is a way back to the default.
 *  `value` null: no key is in use. */
export function Recorder({ name, value, own, set }: { name: string; value: Shortcut | null; own: boolean; set: (key: Shortcut | null) => Promise<unknown> }) {
  const [held, hold] = useState<string | null>(null);
  const [said, say] = useState('');
  const listens = held !== null;
  const listen = (on: boolean) => (hold(on ? '' : null), (recorder.on = on));
  useEffect(() => () => void (recorder.on = false), []);
  const tries = (key: Shortcut | null) => {
    listen(false);
    say('');
    set(key).catch((e: unknown) => say(sentence(e instanceof Error ? e.message : String(e))));
  };
  const keys = (e: KeyboardEvent) => {
    // (The flag as well as the state: a key let go in the moment after one was tried belongs to nobody.)
    if (!listens || !recorder.on) return;
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
        onClick={() => listen(!listens)} onKeyDown={keys} onKeyUp={keys} onBlur={() => listens && listen(false)}>
        {listens ? <>{held && <Key k={held} cap />}<span>{held ? 'and a key' : 'Press the keys'}</span><Key k="esc" /></>
          : value ? <><Key k={keyName(value)} cap /><span>Change</span></> : <span>Record a key</span>}
      </button>
      {own && !listens && <button type="button" class="btn" onClick={() => tries(null)}>Use the default</button>}
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
