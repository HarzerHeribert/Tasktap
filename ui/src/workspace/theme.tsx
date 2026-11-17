// The appearance panel, the seed of Tasktap's theme settings. Every choice is a preference in the core (`prefs`),
// written at once, so the notch and the workspace both follow it. For now: the motion's style, its colour, Lumen,
// and a trial of the motion with the microphone. A later choice joins as one more <Choice>.
import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import type { MotionPalette, MotionStyle, PrefPatch } from '../../../core/proto/protocol.ts';
import { routing } from '../capture.tsx';
import { setVoice } from '../motion/engine.ts';
import { Backdrop, Motion, lookOf } from '../motion/motion.tsx';
import { stops } from '../motion/palette.ts';
import { motionState } from '../motion/state.ts';
import { Voice } from '../motion/voice.ts';
import { call, fail, openQuestions, records, redraw, ui } from './model.ts';

const styles: [MotionStyle, string][] = [['slats', 'Slats'], ['glyphs', 'Glyphs'], ['resonator', 'Resonator']];
const palettes: [MotionPalette, string][] = [['chrome', 'Chrome'], ['chromatic', 'Chromatic'], ['warm', 'Warm'], ['cool', 'Cool'], ['custom', 'Custom']];

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

// The microphone, only between the person's two clicks and only while the panel is open. Nothing is recorded.
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
    if (ui.dialog?.kind !== 'appearance') v.close();
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

function Choice({ name, hint, children }: { name: string; hint?: string; children: ComponentChildren }) {
  return (
    <section class="theme-choice">
      <h3>{name}</h3>
      <div class="theme-control">{children}</div>
      {hint && <p class="hint">{hint}</p>}
    </section>
  );
}

export function Theme() {
  const look = lookOf(records.prefs);
  const state = motionState({
    thoughts: records.thoughts.values(), sessions: records.sessions.values(), questions: openQuestions().length, routing: routing(), voice: ui.voice,
  });
  // Closing the panel ends the trial.
  useEffect(() => () => void (trial && stopTrial()), []);
  return (
    <div class="theme">
      <div class="theme-previews" aria-hidden="true">
        <figure>
          <div class="mini mini-notch"><Backdrop surface="notch" look={look} state={state} mini /><i /><i /><i /><i /></div>
          <figcaption>Notch</figcaption>
        </figure>
        <figure>
          <div class="mini mini-home"><Backdrop surface="home" look={look} state={state} mini /><b /><i /><i /><i /></div>
          <figcaption>Home</figcaption>
        </figure>
      </div>
      <Choice name="Motion">
        <div class="theme-styles" role="radiogroup" aria-label="Motion">
          {styles.map(([id, name]) => (
            <button type="button" role="radio" aria-checked={look.style === id} key={id} onClick={() => setPref({ id: 'motion_style', patch: id })}>
              <Motion class="theme-thumb" look={{ ...look, style: id }} state={state} />
              <span>{name}</span>
            </button>
          ))}
        </div>
      </Choice>
      <Choice name="Colour">
        <div class="theme-palettes" role="radiogroup" aria-label="Colour">
          {palettes.map(([id, name]) => (
            <button type="button" role="radio" aria-checked={look.palette === id} key={id} title={name}
              onClick={() => setPref({ id: 'motion_palette', patch: id })}>
              <i style={{ background: `linear-gradient(90deg,${stops(id, look.hue)})` }} /><span>{name}</span>
            </button>
          ))}
        </div>
        {look.palette === 'custom' && (
          <label class="theme-hue">
            <span>Hue</span>
            <input type="range" min={0} max={359} defaultValue={String(look.hue)} style={{ '--hue': look.hue }}
              onInput={(e) => setPref({ id: 'motion_hue', patch: Number(e.currentTarget.value) })} />
          </label>
        )}
      </Choice>
      <Choice name="Lumen" hint="Coloured light behind the form and a beam across it. The light behind the notch takes the same colours.">
        <button type="button" role="switch" class="theme-switch" aria-checked={look.lumen} aria-label="Lumen"
          onClick={() => setPref({ id: 'motion_lumen', patch: !look.lumen })}><span /></button>
      </Choice>
      <Choice name="Microphone" hint="The motion listens while this is on and this panel is open. Nothing is recorded or sent anywhere.">
        <button type="button" class="btn" aria-pressed={!!trial} disabled={asking} onClick={() => void toggleTrial()}>
          <span>{trial ? 'Stop listening' : asking ? 'Asking…' : 'Try with microphone'}</span>
        </button>
        {said && <p class="hint" role="status">{said}</p>}
      </Choice>
    </div>
  );
}
