// The recording's format, proven on known signals: what goes in as floats at the microphone's rate comes out as
// 16 kHz mono 16-bit little-endian, byte for byte.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BYTES, Pcm, RATE } from './pcm.ts';

const sine = (rate: number, hz: number, seconds: number, amp: number) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));
const samples = (bytes: Uint8Array) => Array.from({ length: bytes.length / 2 }, (_, i) => new DataView(bytes.buffer, bytes.byteOffset).getInt16(2 * i, true));
const crossings = (s: number[]) => s.filter((v, i) => i > 0 && s[i - 1]! < 0 !== v < 0).length;

test('a level signal becomes the same 16-bit sample, low byte first', () => {
  const bytes = new Pcm(48000).push(new Float32Array(48).fill(0.25));
  assert.equal(bytes.length, 32);
  // 0.25 of 32767 is 8192: 0x2000, so the bytes are 00 20.
  assert.deepEqual([...bytes.subarray(0, 4)], [0x00, 0x20, 0x00, 0x20]);
  assert.deepEqual([...new Pcm(16000).push(Float32Array.of(-0.5))], [0x00, 0xc0]);
});

test('samples beyond full scale are held at the ends, never wrapped', () => {
  assert.deepEqual([...new Pcm(16000).push(Float32Array.of(2, -2, 1, -1))], [0xff, 0x7f, 0x00, 0x80, 0xff, 0x7f, 0x00, 0x80]);
});

test('a second of a 440 Hz tone at 48 kHz is 32 000 bytes of the same tone', () => {
  const bytes = new Pcm(48000).push(sine(48000, 440, 1, 0.5));
  assert.equal(bytes.length, BYTES);
  const s = samples(bytes);
  assert.ok(Math.abs(crossings(s) - 880) <= 2, `${crossings(s)} crossings`);
  // The mean of three inputs takes a hair off the peak: half of full scale within one percent.
  const peak = Math.max(...s.map(Math.abs));
  assert.ok(Math.abs(peak - 16383) < 164, `peak ${peak}`);
  // Each output sample is the mean of the three inputs it spans.
  const input = sine(48000, 440, 1, 0.5);
  for (const k of [0, 1, 7, 4000, 15999]) assert.equal(s[k], Math.round(((input[3 * k]! + input[3 * k + 1]! + input[3 * k + 2]!) / 3) * (s[k]! < 0 ? 32768 : 32767)) + 0);
});

test('a rate that does not divide, 44.1 kHz, keeps the length and the pitch', () => {
  const s = samples(new Pcm(44100).push(sine(44100, 300, 2, 0.8)));
  assert.ok(Math.abs(s.length - 2 * RATE) <= 1, `${s.length} samples`);
  assert.ok(Math.abs(crossings(s) - 1200) <= 2, `${crossings(s)} crossings`);
  assert.ok(Math.abs(Math.max(...s.map(Math.abs)) - 0.8 * 32767) < 330);
});

test('the bytes are the same however the input is cut', () => {
  const input = sine(44100, 523, 0.5, 0.6), whole = new Pcm(44100).push(input);
  const cut = new Pcm(44100), parts: number[] = [];
  for (let at = 0; at < input.length; at += 128) parts.push(...cut.push(input.subarray(at, at + 128)));
  assert.deepEqual(parts, [...whole]);
});

test('silence is zeros, and nothing comes out before a whole sample is in', () => {
  const p = new Pcm(48000);
  assert.equal(p.push(new Float32Array(2)).length, 0);
  assert.deepEqual([...p.push(new Float32Array(4))], [0, 0, 0, 0]);
});
