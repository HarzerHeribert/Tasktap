// What the pages show of a thought on its way and of speech, from the core's records (way.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Routing, Thought } from '../../core/proto/protocol.ts';
import { back, briefOf, clock, hold, into, laterWhy, leave, onWay, placed, placing, ring, step } from './way.ts';

const route = (o: Partial<Routing> = {}): Routing => ({ by: 'claude', model: 'haiku', pending: false, fallback: null, quote: null, title: null, ms: 2100, ...o });
const thought = (o: Partial<Thought> = {}) => ({
  phase: 'captured', status: 'captured', mode: 'ask', route: null, project_id: null, text: 'make the header stay on one line', brief: null, hold_until: null, created: 1000, ...o,
}) as Thought;
const name = (id: string) => ({ claude: 'Claude Code', codex: 'Codex' })[id] ?? id;

test('a thought goes from placing to held to started, and each step is told from its record', () => {
  assert.equal(step(undefined), null);
  assert.equal(step(thought({ route: route({ pending: true }) })), 'placing');
  assert.equal(step(thought({ phase: 'routed', status: 'routed', project_id: 'p', route: route({ pending: true }) })), 'briefing');
  assert.equal(step(thought({ phase: 'routed', status: 'routed', project_id: 'p', route: route() })), 'held');
  assert.equal(step(thought({ phase: 'routed', status: 'routed', project_id: 'p' })), 'held');
  assert.equal(step(thought({ status: 'needs_you', route: route() })), 'asked');
  assert.equal(step(thought({ mode: 'note', route: route({ by: 'local', model: null }) })), 'later');
  assert.equal(step(thought({ phase: 'working', status: 'working' })), 'started');
  assert.equal(step(thought({ phase: 'working', status: 'needs_you' })), 'started');
  assert.equal(step(thought({ phase: 'failed', status: 'failed' })), 'failed');
  // One undone is the person's again: not on its way.
  assert.equal(step(thought()), null);
  assert.deepEqual([thought({ route: route({ pending: true }) }), thought({ phase: 'routed' }), thought({ phase: 'working' }), thought({ mode: 'note' })].map(onWay), [true, true, false, false]);
});

test('the brief shows only when it says the words differently', () => {
  assert.equal(briefOf({ text: 'Fix the header.', brief: 'fix the header' }), null);
  assert.equal(briefOf({ text: 'Fix the header', brief: null }), null);
  assert.equal(briefOf({ text: 'äh, also der Header, der soll, nee, der muss einzeilig bleiben', brief: 'Der Header muss einzeilig bleiben.' }), 'Der Header muss einzeilig bleiben.');
});

test('the hold is a share of its whole length from the capture, and follows the record when it moves', () => {
  const t = thought({ phase: 'routed', status: 'routed', created: 1000, hold_until: 6000, route: route() });
  assert.deepEqual(hold(t, 3500), { share: 0.5, ms: 2500 });
  assert.deepEqual(hold(t, 9000), { share: 0, ms: 0 });
  // A brief arrived late: the core moved the end, and the share is of the new whole.
  assert.deepEqual(hold({ ...t, hold_until: 8000 }, 6000), { share: 2000 / 7000, ms: 2000 });
  // While the brief is still written the end is open; nothing depletes.
  assert.equal(hold({ ...t, route: route({ pending: true }) }, 3500), null);
  assert.equal(hold(thought(), 3500), null);
});

test('how it was placed: by whose model, with the words quoted, or by name with the reason as the core gave it', () => {
  assert.equal(placed(thought(), name), null);
  assert.equal(placed(thought({ route: route() }), name), 'Placed by Claude Code · haiku');
  assert.equal(placed(thought({ route: route({ quote: 'the header again' }) }), name), 'Placed by Claude Code · haiku, because you said “the header again”');
  assert.equal(placed(thought({ route: route({ by: 'local', model: null }) }), name), 'Placed by name');
  assert.equal(placed(thought({ route: route({ by: 'local', model: null, fallback: 'claude: it did not answer within 12 s' }) }), name), 'Placed by name. claude: it did not answer within 12 s');
  const gone = 'Codex no longer offers the model Tasktap asks for routing; routing by name until Tasktap is updated';
  assert.equal(placed(thought({ route: route({ by: 'local', model: null, fallback: gone }) }), name), `Placed by name. ${gone}`);
  // The person picked the place: a model wrote the brief at most.
  assert.equal(placed(thought({ route: route() }), name, true), 'Brief by Claude Code · haiku');
  assert.equal(placed(thought({ route: route({ fallback: 'claude: it did not answer within 12 s' }) }), name, true), 'Sent in your words. claude: it did not answer within 12 s');
});

test('why a thought waits in For later', () => {
  assert.equal(laterWhy(thought({ mode: 'note' }), name), 'You saved it for later');
  assert.equal(laterWhy(thought({ mode: 'note', route: route({ by: 'local', model: null }) }), name), 'It named no folder');
  assert.equal(laterWhy(thought({ mode: 'note', route: route() }), name), 'Claude Code found no folder for it');
  assert.equal(laterWhy(thought({ mode: 'note', route: route({ fallback: 'the destination it found is gone' }) }), name), 'It named no folder');
  assert.equal(laterWhy(thought({ mode: 'note', route: route() }), name, true), 'You kept it for later');
});

test('placing by a model is on only for what this Tasktap would ask', () => {
  const tools = [{ agent: 'claude', model: 'haiku' }, { agent: 'codex', model: 'gpt-6-luna' }];
  assert.equal(placing(null, tools), 'off');
  assert.equal(placing(undefined, tools), 'off');
  assert.equal(placing({ agent: 'claude', model: 'haiku' }, tools), 'on');
  assert.equal(placing({ agent: 'codex', model: 'gpt-5-mini' }, tools), 'again');
  assert.equal(placing({ agent: 'codex', model: 'gpt-6-luna' }, [tools[0]!]), 'again');
});

test('a ring counts what its agent works on, and asking is its state, not part of the count', () => {
  const ts = [
    { agent: 'claude', status: 'working', mode: 'ask' }, { agent: 'claude', status: 'working', mode: 'ask' }, { agent: 'claude', status: 'needs_you', mode: 'ask' },
    { agent: 'codex', status: 'needs_you', mode: 'ask' }, { agent: 'codex', status: 'done', mode: 'ask' }, { agent: 'claude', status: 'captured', mode: 'note' },
  ] as Thought[];
  const asking = (a: string) => a === 'claude' || a === 'codex';
  assert.deepEqual(ring({ id: 'claude', signed_in: true }, ts, asking), { n: 2, s: 'asks' });
  assert.deepEqual(ring({ id: 'codex', signed_in: true }, ts, asking), { n: 0, s: 'asks' });
  assert.deepEqual(ring({ id: 'claude', signed_in: true }, ts, () => false), { n: 2, s: 'working' });
  assert.deepEqual(ring({ id: 'codex', signed_in: true }, ts, () => false), { n: 0, s: '' });
  assert.deepEqual(ring({ id: 'codex', signed_in: false }, ts, asking), { n: 0, s: 'off' });
});

test('a recording shows its time after a few seconds and its limit as it nears', () => {
  assert.deepEqual([0, 4.9, 5, 67, 269, 270, 299, 304].map((s) => clock(s, 300)), ['', '', '0:05', '1:07', '4:29', '4:30 of 5:00', '4:59 of 5:00', '5:00 of 5:00']);
});

test('heard words go in at the caret, set off from what is beside them', () => {
  assert.deepEqual(into('', 0, 0, 'Der Header bleibt einzeilig'), { text: 'Der Header bleibt einzeilig', caret: 27 });
  assert.deepEqual(into('Fix the header', 14, 14, 'and keep the logo'), { text: 'Fix the header and keep the logo', caret: 32 });
  assert.deepEqual(into('Fix  now.', 4, 4, ' the header '), { text: 'Fix the header now.', caret: 14 });
  assert.deepEqual(into('Fix it, please', 4, 6, 'the header'), { text: 'Fix the header, please', caret: 14 });
});

/** A field as the Composer keeps it, and a core that answers each thought when the test says, with yes or no. */
function flight() {
  const field = { draft: '', sending: 0 }, sent: string[] = [], land: (() => void)[] = [], refuse: ((e: Error) => void)[] = [];
  const go = (text: string) => new Promise<void>((ok, no) => (sent.push(text), land.push(ok), refuse.push(no)));
  const type = (keys: string) => void (field.draft += keys);
  return { field, sent, go, type, land, refuse };
}

test('what is typed while a thought is on its way to the core stays, in order, as the beginning of the next', async () => {
  const f = flight();
  f.type('fix the header ');
  const gone = leave(f.field, f.go);
  // Its words are out of the field at once, trimmed, and the field takes the next thought from the first key.
  assert.deepEqual([f.sent, f.field], [['fix the header'], { draft: '', sending: 1 }]);
  f.type('and then ');
  f.land[0]!();
  await gone;
  f.type('the footer');
  // Every key since is there, in the order typed, and nothing went twice.
  assert.deepEqual([f.sent, f.field], [['fix the header'], { draft: 'and then the footer', sending: 0 }]);
});

test('a second thought sent before the first has arrived goes after it, and neither goes twice', async () => {
  const f = flight();
  f.type('one');
  const first = leave(f.field, f.go);
  f.type('two');
  const second = leave(f.field, f.go);
  assert.deepEqual([f.sent, f.field], [['one', 'two'], { draft: '', sending: 2 }]);
  f.land[0]!();
  await first;
  assert.equal(f.field.sending, 1);
  f.land[1]!();
  await second;
  assert.deepEqual([f.sent, f.field], [['one', 'two'], { draft: '', sending: 0 }]);
});

test('a thought the core refuses is back in the field, before what was typed since', async () => {
  const f = flight();
  f.type('fix the header');
  const gone = leave(f.field, f.go);
  f.type('and the footer');
  f.refuse[0]!(new Error('no'));
  await assert.rejects(gone, /no/);
  assert.deepEqual(f.field, { draft: 'fix the header\nand the footer', sending: 0 });
  // With nothing typed since, it is back as it was; so is a thought Undo takes back.
  assert.equal(back('fix the header', ' \n'), 'fix the header');
  assert.equal(back('fix the header', 'next'), 'fix the header\nnext');
});
