// Speech on this machine, as the host offers it (host/src/speech.rs): where its model stands, and the helper that
// writes one recording down. The page records as it does for a speech service and hands the samples over; the helper
// lives for that one dictation. Nothing here runs or is asked for before the person uses voice, but for one question
// at the page's start, which the host answers by looking at a file: is the model there.
import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { redraw } from '../page.ts';

/** `supported`: this system has the helper. `model`: not here, being fetched, here and checked, or the fetch failed
 *  (`error` says why, in words to show). `have` of `of` bytes are on disk. */
export type Local = { supported: boolean; model: 'none' | 'fetching' | 'ready' | 'failed'; have: number; of: number; error: string | null };
/** A line from the helper: it has loaded its model, the transcript so far, the whole transcript, or why it ended. */
export type Heard = { ready?: true; partial?: string; final?: string; error?: string };

export const local = { now: null as Local | null };
/** Whether a dictation can be written down on this machine now. */
export const ready = () => !!local.now?.supported && local.now.model === 'ready';

const watchers: ((now: Local, was: Local | null) => void)[] = [];
/** Called with every change of where the model stands. */
export const watch = (f: (typeof watchers)[number]) => void watchers.push(f);
function took(now: Local | null) {
  if (!now || typeof now.model !== 'string') return;
  const was = local.now;
  local.now = now;
  for (const f of watchers) f(now, was);
  redraw();
}

/** Asks the host where the model stands, or to fetch it, stop fetching it, or remove it. */
export const model = (act?: 'install' | 'stop' | 'remove') => invoke<Local>('speech_model', { act }).then((now) => (took(now), now));
// A host without these calls has no speech of its own: said as not available, never left asking.
void model().catch(() => took({ supported: false, model: 'none', have: 0, of: 0, error: null }));
// While the model is fetched the host says how far it is.
void listen<Local>('speech', (e) => took(e.payload)).catch(() => {});

// One call after the other, so the samples arrive in order and the end after the last of them.
let last: Promise<unknown> = Promise.resolve();
const next = <T>(f: () => Promise<T>) => {
  const p = last.then(f);
  last = p.catch(() => {});
  return p;
};

/** Starts the helper for the dictation `id`. Rejects with `model` or `engine` when it cannot start. */
export function hear(id: string, languages: string[], on: (h: Heard) => void): Promise<void> {
  const heard = new Channel<Heard>();
  heard.onmessage = on;
  return next(() => invoke<void>('speech_listen', { id, languages, heard }));
}
/** Samples for it: 16 kHz, one channel, signed 16-bit little-endian. */
export const feed = (pcm: Uint8Array) => void next(() => invoke('speech_audio', pcm)).catch(() => {});
/** The recording is over; with `cancel`, the dictation is. */
export const stop = (id: string, cancel: boolean) => void next(() => invoke('speech_end', { id, cancel })).catch(() => {});
