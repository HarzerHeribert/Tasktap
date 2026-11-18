// Voice, recorded by the page so it is the same on every system (design §8, "What the recorder does"). The person holds
// ⌥Space in the Composer or a reply field, or presses and holds the microphone control; a short click on the control
// keeps it on until the next click or Return. The microphone is asked for then and never before, heard through an
// audio worklet, turned into 16 kHz mono 16-bit samples (pcm.ts) and sent on the stream `dictation.start` opens, within
// its credit. It is stopped at once on release, when the stream is closed by the core, on any error and when the page
// loses the window. The page keeps no audio: what the worklet hands over is converted, sent and forgotten.
//
// A dictation is one of two things (the core's targets): a new thought, captured as typing and Return would have, or
// words for a field, which arrive in the dictation's row and are put at the field's caret for the person to send.
import type { DictationTarget } from '../../../core/proto/protocol.ts';
import { type Stream, uuid7 } from '../client.ts';
import { call, client, focus, pref, records, redraw } from '../page.ts';
import { into } from '../way.ts';
import { BYTES, Pcm } from './pcm.ts';

export type Field = HTMLTextAreaElement | HTMLInputElement;
const FIELDS = '#capture-input, .reply input';
/** A key held shorter than this starts nothing, as in 1.2. */
const HOLD = 150;
/** A press of the control shorter than this is a click: it stays on. */
const CLICK = 350;

export const talk = {
  /** The dictation this page recorded, while its row is there: recording, being written down, heard or failed. */
  id: '',
  kind: '' as '' | DictationTarget['kind'],
  /** The field its words are for. */
  field: null as Field | null,
  /** The microphone is being opened: the first time the system asks the person. */
  asking: false,
  /** Kept on by a click, until the next click or Return; else it ends with the hold. */
  latched: false,
  /** Why voice could not start: `service` for no speech service chosen, else the words to show. */
  said: '',
  /** The checks' switch: a tone made in the page takes the microphone's place, so no microphone is opened. */
  source: 'microphone' as 'microphone' | 'tone',
};

type Ear = { node: AudioWorkletNode; rate: number; deaf(): void; close(): void };
let ear: Ear | null = null;
/** The attempt under way; one that was given up meanwhile sees another number. */
let attempt = 0;
let ending = 0;

/** Whether this page hears anything now: the checks hold it to false after every dictation. */
export const live = () => !!ear;
/** This page's dictation, as the core has it. */
export const mine = () => (talk.id ? records.dictations.get(talk.id) : undefined);
/** The loudest recording under way, 0 to 1, whichever page records it: what the motion listens to. */
export const loudness = () => Math.max(0, ...[...records.dictations.values()].filter((d) => d.phase === 'recording').map((d) => d.level)) / 100;
export const recording = () => [...records.dictations.values()].some((d) => d.phase === 'recording');

async function open(): Promise<Ear> {
  const ctx = new AudioContext();
  let deaf = () => {};
  try {
    let heard: AudioNode;
    if (talk.source === 'tone') {
      // A voice-like tone: 220 Hz that swells three times a second.
      const tone = ctx.createOscillator(), level = ctx.createGain(), swell = ctx.createOscillator(), depth = ctx.createGain();
      tone.frequency.value = 220;
      level.gain.value = 0.25;
      swell.frequency.value = 3;
      depth.gain.value = 0.2;
      swell.connect(depth).connect(level.gain);
      tone.connect(level);
      tone.start();
      swell.start();
      heard = level;
      deaf = () => (tone.stop(), swell.stop());
    } else {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This window offers no microphone.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      deaf = () => stream.getTracks().forEach((t) => t.stop());
      // Unplugged, or its permission taken back: the recording ends with what it has.
      for (const t of stream.getTracks()) t.onended = () => end();
      heard = ctx.createMediaStreamSource(stream);
    }
    await ctx.audioWorklet.addModule(new URL('pcm-worklet.js', document.baseURI).href);
    const node = new AudioWorkletNode(ctx, 'pcm');
    // Through a closed gain, so it is heard by the worklet and never played.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    heard.connect(node).connect(mute).connect(ctx.destination);
    void ctx.resume();
    return { node, rate: ctx.sampleRate, deaf, close: () => (deaf(), (node.port.onmessage = null), void ctx.close()) };
  } catch (e) {
    deaf();
    void ctx.close();
    throw e;
  }
}

function shut() {
  ear?.close();
  ear = null;
  clearTimeout(ending);
  ending = 0;
}
function reset() {
  Object.assign(talk, { id: '', kind: '', field: null, asking: false, latched: false });
}

/** Starts a dictation for `target`, its words for `field`. False when it could not start; `talk.said` says why. */
export async function begin(target: DictationTarget, field: Field | null): Promise<boolean> {
  if (talk.id || talk.asking) return false;
  if (!pref('speech_by')) {
    talk.said = 'service';
    redraw();
    return false;
  }
  const mine = ++attempt, id = uuid7();
  Object.assign(talk, { asking: true, said: '', kind: target.kind, field });
  redraw();
  let mic: Ear | null = null;
  try {
    mic = await open();
    if (mine !== attempt) throw null;
    // What is heard before the stream is open waits for it, so the first word is not lost.
    const pcm = new Pcm(mic.rate), early: Uint8Array[] = [];
    let stream: Stream | null = null, room = 0;
    const send = (bytes: Uint8Array) => {
      if (!stream) return void early.push(bytes);
      const part = bytes.subarray(0, Math.max(0, room));
      if (part.length) stream.write(part);
      room -= part.length;
      // The longest a recording lasts: it ends by itself, as letting go would end it.
      if (room <= 0) end();
    };
    mic.node.port.onmessage = ({ data }: MessageEvent<Float32Array | null>) => (data ? send(pcm.push(data)) : finish());
    const heard = await client.dictate({ id, target, local: false }, { onclose: shut });
    if (mine !== attempt || !heard.stream) {
      void call('dictation.cancel', { id }).catch(() => {});
      throw mine === attempt ? new Error('No speech service is set up') : null;
    }
    ear = mic;
    Object.assign(talk, { id, asking: false });
    room = Math.min(heard.seconds * BYTES, heard.stream.credit);
    stream = heard.stream;
    early.splice(0).forEach(send);
    redraw();
    return true;
  } catch (e) {
    mic?.close();
    if (mine === attempt) {
      reset();
      talk.said = e instanceof DOMException && e.name === 'NotAllowedError'
        ? 'The microphone was not allowed. Tasktap can be allowed in System Settings, Privacy & Security, Microphone.'
        : e instanceof Error ? e.message : String(e);
    }
    redraw();
    return false;
  }
}

/** The core is told once the last samples are on their way. */
function finish() {
  if (!ear) return;
  shut();
  const id = talk.id;
  void call('dictation.finish', { id }).catch((e) => {
    if (talk.id !== id) return;
    reset();
    talk.said = e instanceof Error ? e.message : String(e);
    redraw();
  });
  redraw();
}

/** Letting go: the microphone stops now, what the worklet still holds is handed over, and the core takes it from there. */
export function end() {
  if (talk.asking) return cancel();
  if (!ear || ending) return;
  ear.deaf();
  ear.node.port.postMessage(0);
  ending = window.setTimeout(finish, 200);
}

/** Escape, at any point: nothing is captured and nothing kept. Also dismisses a dictation that failed or was heard. */
export function cancel() {
  attempt++;
  shut();
  const id = talk.id;
  reset();
  talk.said = '';
  if (id) void call('dictation.cancel', { id }).catch(() => {});
  redraw();
}

/** Puts words into the field they were spoken for (else the Composer's) at its caret; nothing is sent. */
export function place(words: string) {
  const el = talk.field?.isConnected ? talk.field : document.querySelector<Field>('#capture-input');
  if (!el || !words.trim()) return;
  const { text, caret } = into(el.value, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, words);
  el.value = text;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  focus(el);
}

/** After every change of the records: words that were heard go into their field and their row is dismissed; a
 *  dictation that is gone (it became its thought, or was cancelled elsewhere) or failed leaves no microphone on. */
export function follow() {
  if (!talk.id) return;
  const row = mine();
  if (!row) return (shut(), reset());
  if (row.phase === 'failed') shut();
  if (row.phase !== 'heard') return;
  place(row.text);
  cancel();
}

// ——— The gestures ———

let aim: (field: Field | null) => DictationTarget = () => ({ kind: 'text' });
/** The Composer says what a dictation into `field` is for. */
export const setAim = (f: typeof aim) => (aim = f);
const speak = (field: Field | null) => void begin(aim(field), field);

/** The field speech goes to: the one with the keyboard, else the Composer's; none inside a terminal. */
function fieldNow(): Field | null {
  const at = document.activeElement;
  if (at instanceof Element && at.closest('.xterm')) return null;
  return at instanceof Element && at.matches(FIELDS) ? (at as Field) : document.querySelector<Field>('#capture-input');
}

let wait = 0, held = false, pressed = 0;
document.addEventListener('keydown', (e) => {
  const busy = talk.asking || !!talk.id;
  // Escape cancels at any point; Return ends a recording that a click keeps on.
  if (e.key === 'Escape' && (busy || talk.said)) cancel();
  else if (e.key === 'Enter' && ear && talk.latched) end();
  else if (e.code === 'Space' && e.altKey && !e.metaKey && !e.ctrlKey && fieldNow()) {
    if (!e.repeat && !wait && !held && !busy) {
      const field = fieldNow();
      wait = window.setTimeout(() => {
        wait = 0;
        held = true;
        talk.latched = false;
        speak(field);
      }, HOLD);
    }
  } else return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);
document.addEventListener('keyup', (e) => {
  if (e.code !== 'Space' && e.key !== 'Alt') return;
  clearTimeout(wait);
  wait = 0;
  if (held) (held = false), end();
}, true);

/** The microphone control: held, it records until let go; clicked, until the next click. */
export const control = {
  down(e: PointerEvent, field: Field | null) {
    if (e.button !== 0) return;
    e.preventDefault();
    if (talk.asking || talk.id) return void (ear && end());
    pressed = performance.now();
    talk.latched = false;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    speak(field);
  },
  up() {
    if (!pressed) return;
    const click = performance.now() - pressed < CLICK;
    pressed = 0;
    if (click && pref('speech_by')) talk.latched = true;
    else end();
    redraw();
  },
  /** Pressed with the keyboard: on, then off. */
  key(e: MouseEvent, field: Field | null) {
    if (e.detail !== 0) return;
    if (ear) return end();
    talk.latched = true;
    speak(field);
  },
};

// The page loses the window: the microphone stops, and the recording ends with what it has, as letting go ends it.
const lost = () => (ear || talk.asking) && end();
addEventListener('blur', lost);
addEventListener('pagehide', lost);
document.addEventListener('visibilitychange', () => document.hidden && lost());
