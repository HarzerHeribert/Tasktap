// The parts of a form, wherever one is: Settings, and the sheets that ask before something leaves this Mac. One row
// for every setting: its question at the left, the answer at the right (a value to read, a control to change it), and
// under the answer, only where it matters, what the choice means: what is sent, what is stored, what costs power.
// Every row shares the two columns (window.css .set), so labels stand on one edge and answers on another.
import type { ComponentChildren } from 'preact';
import type { PrefPatch } from '../../../core/proto/protocol.ts';
import { call, fail } from './model.ts';

export function Row({ name, hint, children }: { name: string; hint?: ComponentChildren; children: ComponentChildren }) {
  return (
    <div class="set">
      <span class="t">{name}</span>
      <div class="c">{children}{hint && <p class="hint">{hint}</p>}</div>
    </div>
  );
}
/** One of a few: the choices side by side, the chosen one marked. */
export function Choice<T extends string | number>({ name, value, all, set }: { name: string; value: T; all: [T, ComponentChildren][]; set: (v: T) => void }) {
  return (
    <div class="seg" role="radiogroup" aria-label={name}>
      {all.map(([id, label]) => <button type="button" role="radio" aria-checked={value === id} onClick={() => set(id)}>{label}</button>)}
    </div>
  );
}
export const Switch = ({ on, name, set }: { on: boolean; name: string; set: (on: boolean) => void }) => (
  <button type="button" role="switch" class="switch" aria-checked={on} aria-label={name} onClick={() => set(!on)}><span /></button>
);

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
