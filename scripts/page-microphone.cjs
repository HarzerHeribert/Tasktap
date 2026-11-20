// A microphone made inside the page, for the checks that record in headless Chromium (speech-check, voice-check and
// the voice part of motion-fidelity): getUserMedia answers with a stream the page plays itself, a tone or samples the
// check hands over, on a loop. Chromium is never asked for a capture device, so it never opens this Mac's own
// microphone nor asks macOS for it. (With its fake device it still read the real input's format first, and macOS
// holds that while the screen is locked.)
// In the page: `__asked`, the constraints of every request in order; `__mics`, every stream given; `__hears()`,
// whether any of them still has a live track. A request without audio, or with video, is refused, as a machine with
// a microphone and no camera refuses it.
const fs = require('node:fs');

/** In the page, before its own scripts. `hz` and `gain` (of full scale) for a tone, or `pcm`, base64 of 16-bit
 *  little-endian mono samples at `rate`. Each request gets a stream of its own, of one channel, whose sound is let go
 *  once all its tracks have ended. */
function standIn({ hz, gain, pcm, rate }) {
  window.__asked = [];
  window.__mics = [];
  window.__hears = () => window.__mics.some((s) => s.getTracks().some((t) => t.readyState === 'live'));
  const samples = pcm ? Uint8Array.from(atob(pcm), (c) => c.charCodeAt(0)) : null;
  async function getUserMedia(constraints) {
    window.__asked.push(constraints === undefined ? undefined : JSON.parse(JSON.stringify(constraints)));
    if (!constraints?.audio || constraints.video) throw new DOMException('The stand-in microphone gives sound alone.', 'NotFoundError');
    const ctx = new AudioContext(), out = ctx.createMediaStreamDestination();
    out.channelCount = 1;
    out.channelCountMode = 'explicit';
    let source;
    if (samples) {
      const n = samples.length >> 1, view = new DataView(samples.buffer), clip = ctx.createBuffer(1, Math.max(1, n), rate), ch = clip.getChannelData(0);
      for (let i = 0; i < n; i++) ch[i] = view.getInt16(2 * i, true) / 32768;
      source = ctx.createBufferSource();
      source.buffer = clip;
      source.loop = true;
      source.connect(out);
    } else {
      source = ctx.createOscillator();
      source.frequency.value = hz;
      const level = ctx.createGain();
      level.gain.value = gain;
      source.connect(level).connect(out);
    }
    source.start();
    // Sounding before it is handed over, as a microphone is (a context that is not let run is not waited for long).
    await Promise.race([ctx.resume(), new Promise((ok) => setTimeout(ok, 500))]);
    const stream = out.stream;
    let gone = false;
    for (const t of stream.getTracks()) {
      const stop = t.stop.bind(t);
      t.stop = () => {
        stop();
        if (!gone && stream.getTracks().every((x) => x.readyState === 'ended')) (gone = true), ctx.close().catch(() => {});
      };
    }
    window.__mics.push(stream);
    return stream;
  }
  Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { value: getUserMedia, configurable: true, writable: true });
}

/** The samples of a 16-bit mono WAV file, as `microphone` takes them. */
function wavSamples(file) {
  const b = fs.readFileSync(file);
  let fmt = null;
  for (let at = 12; at + 8 <= b.length; at += 8 + b.readUInt32LE(at + 4) + (b.readUInt32LE(at + 4) & 1)) {
    const id = b.toString('latin1', at, at + 4), size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(at + 8), channels: b.readUInt16LE(at + 10), rate: b.readUInt32LE(at + 12), bits: b.readUInt16LE(at + 22) };
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16) throw new Error(`${file} is not 16-bit mono PCM: ${JSON.stringify(fmt)}`);
      return { pcm: b.subarray(at + 8, at + 8 + size).toString('base64'), rate: fmt.rate };
    }
  }
  throw new Error(`${file} has no samples`);
}

/** Whether `asked` (the page's `__asked`) is the one request the page's recorder makes (ui/src/speech/record.ts):
 *  sound alone, one channel, none of the browser's voice processing, which would change what is heard. */
const askedForVoice = (asked) => asked.length === 1 && !asked[0]?.video && asked[0]?.audio?.channelCount === 1
  && ['echoCancellation', 'noiseSuppression', 'autoGainControl'].every((k) => asked[0].audio[k] === false);

/** Gives the page (or every page of a browser context) the stand-in from its next load on: `{ hz, gain }` for a tone,
 *  or what `wavSamples` read. */
const microphone = (target, sound) => target.addInitScript(standIn, sound);

module.exports = { microphone, wavSamples, askedForVoice };
