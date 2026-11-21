// The shared client against recorded frames, with a bridge that keeps what the page sends.
// Run by `npm run check` with Node's own test runner.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Control } from '../../core/proto/protocol.ts';
import { type Bridge, Client, Records } from './client.ts';

const T1 = '019a8b6c-7d10-7000-8000-000000000001';
const T2 = '019a8b6c-7d10-7000-8000-000000000002';
const Q1 = '019a8b6c-7d10-7000-8000-0000000000a1';
const thought = (id: string, rev: number, status: 'working' | 'done' = 'working') => ({
  id, rev, text: 'Fix the build', strokes: [], source: 'typed', mode: 'ask', phase: status, status, reason: null, live: true,
  project_id: null, session_id: null, brief: null, agent: 'claude', model: null, workdir: null, hold_until: null, read: false,
  created: 1, updated: 1,
});
const glance = { rev: 4, working: 1, needs_you: 0, done: 0, failed: 0, question: null, retiring: false };

const welcome: Control = { t: 'welcome', v: 1, core: '019a8b6c-0000-7000-8000-000000000000', build: 'test', as: 'device', calls: ['sub'] };

/** A bridge whose core is the test: `push` delivers frames as the host would. The core has answered unless
 *  `welcomed` is false. */
function fake(welcomed = true) {
  const sent: (string | Uint8Array)[] = [];
  const host: string[] = [];
  const bridge: Bridge = { send: (f) => sent.push(f), host: (f) => host.push(f), onframe: () => {} };
  const push = (...frames: (Control | Uint8Array)[]) =>
    frames.forEach((f) => bridge.onframe(f instanceof Uint8Array ? f : JSON.stringify(f)));
  const client = new Client(bridge);
  if (welcomed) push(welcome);
  return { client, sent, host, push };
}
const settle = () => new Promise((ok) => setTimeout(ok, 0));
const data = (s: number, ...bytes: number[]) => new Uint8Array([s, 0, 0, 0, ...bytes]);
const lastCall = (sent: (string | Uint8Array)[]) => JSON.parse(sent.at(-1) as string) as { id: number; name: string; args: unknown };

test('a snapshot arrives before the reply to sub, and every change after it in order', async () => {
  const { client, sent, push } = fake();
  const records = new Records();
  let applied = 0;
  records.onchange = () => applied++;
  const rev = client.sub(['thoughts', 'glance'], records);
  await settle();
  const call = lastCall(sent);
  assert.deepEqual([call.name, call.args], ['sub', { collections: ['thoughts', 'glance'] }]);
  // The snapshot in two chunks: nothing is shown until its last one.
  push({ t: 'change', rev: 4, snap: true, more: true, sets: [{ c: 'thoughts', put: [thought(T1, 2) as never] }] });
  assert.equal(applied, 0);
  push({ t: 'change', rev: 4, snap: true, sets: [{ c: 'glance', put: [glance] }] });
  push({ t: 'reply', id: call.id, ok: { rev: 4 } });
  assert.equal(await rev, 4);
  assert.equal(applied, 1);
  assert.equal(records.thoughts.get(T1)?.status, 'working');
  assert.equal(records.glance?.working, 1);
  push({ t: 'change', rev: 5, sets: [{ c: 'thoughts', put: [thought(T1, 5, 'done') as never] }, { c: 'glance', put: [{ ...glance, rev: 5, working: 0, done: 1 }] }] });
  push({ t: 'change', rev: 6, sets: [{ c: 'thoughts', del: [T1] }] });
  assert.equal(applied, 3);
  assert.equal(records.thoughts.size, 0);
  assert.deepEqual([records.glance?.working, records.glance?.done, records.rev], [0, 1, 6]);
});

test('a transaction cut into frames marked more is applied whole with its last frame', async () => {
  const { client, push } = fake();
  const records = new Records();
  let seen: string[] = [];
  records.onchange = () => (seen = [...records.thoughts.keys(), ...records.questions.keys()]);
  void client.sub(['thoughts', 'questions'], records);
  await settle();
  push({ t: 'change', rev: 1, snap: true, sets: [{ c: 'thoughts', put: [thought(T2, 1) as never] }] });
  push({ t: 'change', rev: 9, more: true, sets: [{ c: 'thoughts', put: [thought(T1, 9) as never] }] });
  assert.deepEqual(seen, [T2], 'half a transaction is never shown');
  const question = { id: Q1, rev: 9, thought_id: T1, session_id: null, turn: null, source: 'agent', prompt: 'Deploy?', detail: null,
    reply_via: 'core', state: 'open', answer: null, kind: 'confirm' };
  push({ t: 'change', rev: 9, sets: [{ c: 'thoughts', del: [T2] }, { c: 'questions', put: [question as never] }] });
  assert.deepEqual(seen, [T1, Q1]);
});

test('a stream keeps within the credit each side grants and gives credit back as bytes are used', async () => {
  const { client, sent, push } = fake();
  const got: number[] = [];
  const marks: unknown[] = [];
  let closed: string | null = null;
  const opening = client.open('terminal.open', { id: T1, cols: 80, rows: 24, credit: 8 }, {
    ondata: (bytes) => got.push(...bytes),
    onmark: (m) => marks.push(m.size),
    onclose: (why) => (closed = why),
  });
  await settle();
  const call = lastCall(sent);
  assert.equal(call.name, 'terminal.open');
  // The reply and the first bytes arrive together: none are lost.
  push({ t: 'reply', id: call.id, ok: { s: 3, credit: 5, from: 0 } }, { t: 'mark', s: 3, at: 0, size: [80, 24] }, data(3, 104, 105));
  const stream = await opening;
  assert.deepEqual([got, marks], [[104, 105], [[80, 24]]]);
  // Input: five bytes may go now, the rest once the core grants more.
  stream.write(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  const frame = sent.at(-1) as Uint8Array;
  assert.deepEqual([...frame], [3, 0, 0, 0, 1, 2, 3, 4, 5]);
  push({ t: 'credit', s: 3, n: 10 });
  assert.deepEqual([...(sent.at(-1) as Uint8Array)], [3, 0, 0, 0, 6, 7, 8]);
  assert.equal(stream.credit, 7);
  // Output: credit goes back in batches of half the window.
  stream.consumed(2);
  assert.ok(sent.at(-1) instanceof Uint8Array, 'two bytes of eight owe no credit yet');
  stream.consumed(2);
  assert.deepEqual(JSON.parse(sent.at(-1) as string), { t: 'credit', s: 3, n: 4 });
  push({ t: 'close', s: 3, why: 'done' });
  assert.equal(closed, 'done');
});

test('host calls go to the host, and a failed call rejects with its code', async () => {
  const { client, sent, host, push } = fake();
  const notch = client.call('host.notch', { open: true });
  await settle();
  const call = JSON.parse(host[0]!) as { id: number; name: string };
  assert.equal(call.name, 'host.notch');
  push({ t: 'reply', id: call.id, ok: null });
  assert.equal(await notch, null);
  const stop = client.call('thought.stop', { id: T1 });
  await settle();
  push({ t: 'reply', id: lastCall(sent).id, err: { code: 'gone', message: 'no such thought' } });
  await assert.rejects(stop, { code: 'gone' });
});

test('before the core answers, what shows the window and its buttons goes to the host at once; every other call waits', async () => {
  const { client, sent, host, push } = fake(false);
  const names = (frames: string[]) => frames.map((f) => (JSON.parse(f) as { name: string }).name);
  const shown = client.call('host.ready', {});
  const minimised = client.call('host.window', { do: 'minimize' });
  const power = client.call('host.power', {});
  const stop = client.call('thought.stop', { id: T1 });
  await settle();
  assert.deepEqual(names(host), ['host.ready', 'host.window']);
  assert.equal(sent.length, 0);
  for (const f of host) push({ t: 'reply', id: (JSON.parse(f) as { id: number }).id, ok: null });
  assert.deepEqual(await Promise.all([shown, minimised]), [null, null]);
  push(welcome);
  await settle();
  assert.deepEqual(names(host), ['host.ready', 'host.window', 'host.power']);
  assert.equal(lastCall(sent).name, 'thought.stop');
  push({ t: 'reply', id: JSON.parse(host[2]!).id, ok: false }, { t: 'reply', id: lastCall(sent).id, ok: null });
  assert.deepEqual(await Promise.all([power, stop]), [false, null]);
});

test('the agents collection is held like any other, in the order the core lists it, and a new snapshot replaces it', async () => {
  const { client, push } = fake();
  const records = new Records();
  void client.sub(['agents'], records);
  await settle();
  const agent = (id: string, rev: number, signed_in: boolean | null) => ({ id, name: id, supported: true, stale: false, rev, checked: 1, installed: true, version: '1', signed_in,
    identity: null, events: true, resume: true, permissions: 'core', questions: 'terminal' }) as never;
  push({ t: 'change', rev: 2, snap: true, sets: [{ c: 'agents', put: [agent('claude', 2, null), agent('codex', 2, true)] }] });
  push({ t: 'change', rev: 3, sets: [{ c: 'agents', put: [agent('claude', 3, true)] }] });
  assert.deepEqual([...records.agents.keys()], ['claude', 'codex']);
  assert.equal(records.agents.get('claude')?.signed_in, true);
  push({ t: 'change', rev: 4, snap: true, sets: [{ c: 'agents', put: [agent('codex', 4, false)] }] });
  assert.deepEqual([...records.agents.keys()], ['codex']);
});
