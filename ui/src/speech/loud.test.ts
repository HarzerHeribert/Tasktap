// The level and "nothing was said", held to the core's own numbers (core/src/speech.rs), on signals made here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Loud, level } from './loud.ts';

const pcm = (seconds: number, at: (i: number) => number) => {
  const out = new DataView(new ArrayBuffer(2 * Math.round(16000 * seconds)));
  for (let i = 0; i < out.byteLength / 2; i++) out.setInt16(2 * i, Math.round(at(i)), true);
  return new Uint8Array(out.buffer);
};
const db = (d: number) => 32768 * 10 ** (d / 20);
// Noise that is the same every run.
const noise = (amp: number) => {
  let x = 1;
  return () => ((x = (x * 1103515245 + 12345) % 2147483648), (x / 1073741824 - 1) * amp);
};
const heard = (bytes: Uint8Array, cut = 3200) => {
  const l = new Loud();
  for (let at = 0; at < bytes.length; at += cut) l.push(bytes.subarray(at, at + cut));
  return l;
};

test('the level is 0 at −55 dBFS and 100 at −6 dBFS, as the core has it', () => {
  assert.deepEqual([0, 1, 58, 32767].map(level), [0, 0, 0, 100]);
  assert.equal(level(Math.round(db(-6))), 100);
  assert.equal(level(Math.round(db(-30.5))), 50);
  const tone = heard(pcm(1, (i) => db(-18) * Math.sin((2 * Math.PI * 440 * i) / 16000)));
  assert.equal(tone.level, 76);
});

test('the level changes with each tenth of a second, however the samples are cut', () => {
  const quietThenLoud = pcm(0.4, (i) => (i < 3200 ? 100 : 8000) * (i % 2 ? 1 : -1));
  for (const cut of [1, 7, 3200, 6401]) {
    const l = new Loud(), levels: number[] = [];
    for (let at = 0; at < quietThenLoud.length; at += cut) if (l.push(quietThenLoud.subarray(at, at + cut))) levels.push(l.level);
    assert.deepEqual(levels, [level(100), level(8000)], `cut every ${cut} bytes`);
  }
});

test('nothing was said: a tap, a muted microphone, an even room', () => {
  assert.equal(heard(pcm(0.05, () => 9000)).said(), false, 'under a tenth of a second');
  assert.equal(heard(pcm(3, () => 0)).said(), false, 'zeros');
  assert.equal(heard(pcm(3, () => 40)).said(), false, 'nothing above −55 dBFS');
  const room = noise(db(-40));
  assert.equal(heard(pcm(3, room)).said(), false, 'an even room at −40 dBFS');
});

test('something was said: a word in the room, a short word, any loud place', () => {
  const room = noise(db(-45));
  const word = pcm(2, (i) => room() + (i > 12000 && i < 18000 ? db(-38) * Math.sin(i / 6) : 0));
  assert.equal(heard(word).said(), true, 'a word barely above the room');
  assert.equal(heard(pcm(0.3, noise(db(-45)))).said(), true, 'too short to tell is sent');
  assert.equal(heard(pcm(2, noise(db(-20)))).said(), true, 'even, and loud');
});
