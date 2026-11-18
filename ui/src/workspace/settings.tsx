// The Settings sheet: the terminal's colours, how long a sent thought waits, the capture shortcut, and the
// appearance: the motion's form and colour, Lumen, the ambient light, and a trial of the motion with the microphone.
// Every choice the core keeps is a preference (`prefs`), written at once, so the notch and the workspace both follow.
import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import type { MotionAmbient, MotionPalette, MotionStyle, PrefPatch } from '../../../core/proto/protocol.ts';
import { routing } from '../capture.tsx';
import { setVoice } from '../motion/engine.ts';
import { Motion, lookOf } from '../motion/motion.tsx';
import { stops } from '../motion/palette.ts';
import { motionState } from '../motion/state.ts';
import { Voice } from '../motion/voice.ts';
import { Speech, Thoughts } from './consent.tsx';
import { call, fail, loadTerms, openQuestions, pref, records, redraw, ui } from './model.ts';

const styles: [MotionStyle, string][] = [['slats', 'Slats'], ['glyphs', 'Glyphs'], ['resonator', 'Resonator']];
const palettes: [MotionPalette, string][] = [['chrome', 'Chrome'], ['chromatic', 'Chromatic'], ['warm', 'Warm'], ['cool', 'Cool'], ['custom', 'Custom']];
const effects: [MotionAmbient, string][] = [['off', 'Off'], ['still', 'Still'], ['breathing', 'Full']];
const holds: [number, string][] = [[0, 'At once'], [3, '3 s'], [5, '5 s'], [10, '10 s']];
// Sizes whose cells differ by a whole pixel in the Default face.
const sizes: [number, string][] = [12, 14, 15, 16, 18].map((n) => [n, String(n)]);
const heights: [number, string][] = [[100, '1.0'], [110, '1.1'], [120, '1.2'], [130, '1.3']];
const FONTS = ['Hack Nerd Font Mono', 'JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo'];

// One write in flight per preference; the latest value waits for it (a hue slider moves faster than the core needs).
const pending = new Map<string, PrefPatch | null>();
function setPref(p: PrefPatch) {
  if (pending.has(p.id)) return void pending.set(p.id, p);
  pending.set(p.id, null);
  void call('put', { c: 'prefs', ...p }).catch(fail).finally(() => {
    const next = pending.get(p.id);
    pending.delete(p.id);
    if (next) setPref(next);
  });
}

// The microphone, only between the person's two clicks and only while the sheet is open. Nothing is recorded.
let trial: Voice | null = null;
let asking = false;
let said = '';
function stopTrial() {
  trial?.close();
  trial = null;
  setVoice(null);
  ui.voice = false;
  redraw();
}
async function toggleTrial() {
  if (trial) return stopTrial();
  if (asking) return;
  asking = true;
  said = '';
  redraw();
  try {
    const v = await Voice.microphone();
    if (ui.sheet?.kind !== 'settings') v.close();
    else {
      trial = v;
      v.onend = stopTrial;
      setVoice(v);
      ui.voice = true;
    }
  } catch (e) {
    said = e instanceof DOMException && e.name === 'NotAllowedError'
      ? 'The microphone was not allowed. Tasktap Next can be allowed in System Settings, Privacy & Security, Microphone.'
      : e instanceof Error ? e.message : String(e);
  }
  asking = false;
  redraw();
}

function Row({ name, hint, children }: { name: string; hint?: string; children: ComponentChildren }) {
  return (
    <div class="set">
      <span class="t">{name}</span>
      <div class="c">{children}{hint && <p class="hint">{hint}</p>}</div>
    </div>
  );
}
function Choice<T extends string | number>({ name, value, all, set }: { name: string; value: T; all: [T, string][]; set: (v: T) => void }) {
  return (
    <div class="seg" role="radiogroup" aria-label={name}>
      {all.map(([id, label]) => <button type="button" role="radio" aria-checked={value === id} onClick={() => set(id)}>{label}</button>)}
    </div>
  );
}
const Switch = ({ on, name, set }: { on: boolean; name: string; set: (on: boolean) => void }) => (
  <button type="button" role="switch" class="switch" aria-checked={on} aria-label={name} onClick={() => set(!on)}><span /></button>
);

export function Settings() {
  const look = lookOf(records.prefs);
  const hold = records.prefs.get('hold');
  const state = motionState({
    thoughts: records.thoughts.values(), sessions: records.sessions.values(), questions: openQuestions().length, routing: routing(), voice: ui.voice,
  });
  // Closing the sheet ends the trial.
  useEffect(() => () => void (trial && stopTrial()), []);
  useEffect(() => void loadTerms(), []);
  return (
    <div class="settings">
      <h3 id="set-thoughts">Thoughts</h3>
      <Row name="A sent thought starts" hint="Undo stays possible until then.">
        <Choice name="A sent thought starts" value={hold?.id === 'hold' ? hold.value : 5} all={holds} set={(v) => setPref({ id: 'hold', patch: v })} />
      </Row>
      <Row name="Capture shortcut"><span class="v mono">⌃⌥Space</span></Row>
      <Thoughts />
      <h3 id="set-speech">Speech</h3>
      <Speech />
      <h3>Terminal</h3>
      <Row name="Font" hint="Any installed monospace family. Prompt symbols come from the Nerd Fonts symbols either way.">
        <input class="text" list="fonts" placeholder="Default (Hack)" aria-label="Font" spellcheck={false} maxLength={100} defaultValue={pref('terminal_font')}
          onChange={(e) => setPref({ id: 'terminal_font', patch: e.currentTarget.value.trim() })} />
        <datalist id="fonts">{FONTS.map((f) => <option value={f} />)}</datalist>
      </Row>
      <Row name="Size"><Choice name="Size" value={pref('terminal_size')} all={sizes} set={(v) => setPref({ id: 'terminal_size', patch: v })} /></Row>
      <Row name="Line height"><Choice name="Line height" value={pref('terminal_line_height')} all={heights} set={(v) => setPref({ id: 'terminal_line_height', patch: v })} /></Row>
      <h3>Appearance</h3>
      {/* As Home shows it: drawn at full size, never as a small thumbnail, where the metal stops reading as metal. */}
      <Motion class="preview" look={look} state={state} pace="calm" />
      <Row name="Form"><Choice name="Form" value={look.style} all={styles} set={(v) => setPref({ id: 'motion_style', patch: v })} /></Row>
      <Row name="Colour">
        <div class="seg" role="radiogroup" aria-label="Colour">
          {palettes.map(([id, name]) => (
            <button type="button" role="radio" aria-checked={look.palette === id} onClick={() => setPref({ id: 'motion_palette', patch: id })}>
              <i class="sw" style={{ background: `linear-gradient(90deg,${stops(id, look.hue)})` }} />{name}
            </button>
          ))}
        </div>
        {look.palette === 'custom' && (
          <input class="hue" type="range" min={0} max={359} aria-label="Hue" defaultValue={String(look.hue)} style={{ '--hue': look.hue }}
            onInput={(e) => setPref({ id: 'motion_hue', patch: Number(e.currentTarget.value) })} />
        )}
      </Row>
      <Row name="Lumen" hint="Coloured light behind the form and a beam across it. The light behind the notch takes the same colours.">
        <Switch on={look.lumen} name="Lumen" set={(on) => setPref({ id: 'motion_lumen', patch: on })} />
      </Row>
      <Row name="Effects" hint="The light, the chrome and everything that moves by itself. Still keeps the picture and stops the motion; Off draws none of it, which takes the least power and memory. While Reduce Motion or Low Power Mode is on in System Settings, Full behaves as Still.">
        <Choice name="Effects" value={pref('motion_ambient')} all={effects} set={(v) => setPref({ id: 'motion_ambient', patch: v })} />
      </Row>
      <Row name="Microphone" hint="The form listens while this is on and this sheet is open. Nothing is recorded or sent anywhere.">
        <button type="button" class="btn" aria-pressed={!!trial} disabled={asking} onClick={() => void toggleTrial()}>
          {trial ? 'Stop listening' : asking ? 'Asking…' : 'Try with the microphone'}
        </button>
        {said && <p class="hint" role="status">{said}</p>}
      </Row>
    </div>
  );
}
