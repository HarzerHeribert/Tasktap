// What the pages show of a thought on its way and of speech, from the core's records (way.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Routing, Thought } from '../../core/proto/protocol.ts';
import { agentState, back, briefOf, clock, hold, into, laterWhy, leave, letters, lettersOf, offered, onWay, ownAgentLacks, placed, placing, ring, step } from './way.ts';

test('an agent\'s row says what its own commands said, and when, and never more', () => {
  const row = (o: object = {}) => ({ supported: true, installed: true, checks: true, signed_in: null as boolean | null, stale: false, checked: 0, ...o });
  const says = (o: object, looking = false) => agentState(row(o), looking, '2 h ago');
  assert.equal(says({ supported: false, installed: false }), 'does not run on this system yet');
  assert.equal(says({ installed: false, signed_in: true }), 'not installed');
  // Nothing of it runs as the app starts: until it is asked, nothing is known, and the row says so.
  assert.equal(says({}), 'not checked yet');
  assert.equal(says({}, true), 'checking…');
  assert.equal(says({ signed_in: true, checked: 9 }), 'signed in');
  assert.equal(says({ signed_in: false, checked: 9 }), 'not signed in');
  // What a core before this one kept, or what stands because it could not say this time, has its age.
  assert.equal(says({ signed_in: true, checked: 9, stale: true }), 'signed in when last checked, 2 h ago');
  assert.equal(says({ signed_in: false, checked: 9, stale: true }, true), 'not signed in when last checked, 2 h ago');
  assert.equal(says({ checked: 9 }), 'sign-in could not be checked');
  // One with no command that says whether it has a key is never asked, and never shown as signed in or out.
  assert.equal(says({ checks: false, checked: 9 }, true), 'sign-in not checked');
});

test('the Composer offers the agents that can run a thought, a ring for as many as its row has and the rest behind it', () => {
  const a = (id: string, o: object = {}) => ({ id, installed: true, supported: true, signed_in: true as boolean | null, ...o });
  const ids = (x: { rings: { id: string }[]; more: { id: string }[] }) => [x.rings.map((r) => r.id).join(' '), x.more.map((r) => r.id).join(' ')];
  const idle = () => false;
  const ten = ['claude', 'codex', 'agy', 'pi', 'opencode', 'aider', 'qwen', 'goose', 'crush', 'own-1'].map((id) => a(id));
  // The first four in the core's order, the usual one among them.
  assert.deepEqual(ids(offered(ten, 'claude', undefined, idle, 4)), ['claude codex agy pi', 'opencode aider qwen goose crush own-1']);
  // The usual one has a ring wherever it stands, and so has the one picked for this thought: none of the others moves.
  assert.deepEqual(ids(offered(ten, 'goose', undefined, idle, 4)), ['claude codex agy goose', 'pi opencode aider qwen crush own-1']);
  assert.deepEqual(ids(offered(ten, 'claude', 'crush', idle, 4)), ['claude codex agy crush', 'pi opencode aider qwen goose own-1']);
  // One that works or asks is seen before one that does nothing.
  assert.deepEqual(ids(offered(ten, 'claude', 'crush', (id) => id === 'qwen', 4)), ['claude codex qwen crush', 'agy pi opencode aider goose own-1']);
  // Not offered: one that is not here, one this system cannot run, one known to be signed out. One never asked is.
  const some = [a('claude'), a('codex', { signed_in: false }), a('agy', { installed: false }), a('pi', { supported: false }), a('aider', { signed_in: null })];
  assert.deepEqual(ids(offered(some, 'claude', undefined, idle, 4)), ['claude aider', '']);
  // The usual one signed out keeps its ring, which says so: it is the one that runs the next thought.
  assert.deepEqual(ids(offered(some, 'codex', undefined, idle, 4)), ['claude codex aider', '']);
  assert.deepEqual(ids(offered([], undefined, undefined, idle, 4)), ['', '']);
});

test('the form for an agent of the person\'s own says what its command lacks, in the core\'s words', () => {
  assert.equal(ownAgentLacks('Goose', 'goose run -t {prompt}'), '');
  assert.equal(ownAgentLacks('Goose', '"/Applications/My Tool/run" \'do: {prompt}\''), '');
  assert.equal(ownAgentLacks(' ', 'goose {prompt}'), 'Give the agent a name of up to 40 characters');
  assert.equal(ownAgentLacks('x'.repeat(41), 'goose {prompt}'), 'Give the agent a name of up to 40 characters');
  assert.equal(ownAgentLacks('Goose', '  '), 'Goose needs a command');
  assert.equal(ownAgentLacks('Goose', '{prompt}'), 'The command of Goose needs a program before {prompt}');
  assert.equal(ownAgentLacks('Goose', 'goose run'), 'The command of Goose needs {prompt} where the thought goes');
});

test('the two letters of a ring are no two agents alike', () => {
  assert.deepEqual(['agy', 'pi', 'opencode', 'cursor-agent', 'x'].map(letters), ['Ag', 'Pi', 'Op', 'CA', 'X']);
  // Alone, each shows its own.
  assert.deepEqual([...lettersOf(['agy', 'pi', 'opencode']).values()], ['Ag', 'Pi', 'Op']);
  // Where a later one's are taken, it keeps its first letter and takes its next letter that is free.
  assert.deepEqual([...lettersOf(['copilot', 'codex', 'cody', 'co']).entries()], [['copilot', 'Co'], ['codex', 'Cd'], ['cody', 'Cy'], ['co', 'Co']]);
  assert.deepEqual([...lettersOf(['crush', 'cline', 'crow']).values()], ['Cr', 'Cl', 'Co']);
  // A ring too small for two letters shows one, and still no two agents the same.
  assert.deepEqual([...lettersOf(['agy', 'pi', 'opencode'], true).values()], ['A', 'P', 'O']);
  assert.deepEqual([...lettersOf(['agy', 'aider', 'amp'], true).values()], ['A', 'I', 'M']);
});

const route = (o: Partial<Routing> = {}): Routing => ({ by: 'claude', model: 'haiku', pending: false, fallback: null, quote: null, title: null, ms: 2100, ...o });
const thought = (o: Partial<Thought> = {}) => ({
  phase: 'captured', status: 'captured', mode: 'ask', route: null, placed: null, project_id: null, text: 'make the header stay on one line', brief: null, hold_until: null, created: 1000, ...o,
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

test('how it came by its place is told from the core\'s word for it, never from who is named in its route', () => {
  const local = route({ by: 'local', model: null }), slow = 'claude: it did not answer within 12 s';
  const gone = 'Codex no longer offers the model Tasktap asks for placing; placing by name until Tasktap is updated';
  const says = (placed_: Thought['placed'], r: Routing | null) => placed(thought({ placed: placed_, route: r }), name);
  // "Placed by" only where the match on names or a model placed it.
  assert.equal(says('name', local), 'Placed by name');
  assert.equal(says('name', route({ ...local, fallback: slow })), `Placed by name. ${slow}`);
  assert.equal(says('name', route({ ...local, fallback: gone })), `Placed by name. ${gone}`);
  assert.equal(says('model', route()), 'Placed by Claude Code · haiku');
  assert.equal(says('model', route({ quote: 'the header again' })), 'Placed by Claude Code · haiku, because you said “the header again”');
  // The person decided: a pick, a follow-up to the session they were in, an answer to where it should go. A model
  // wrote the brief at most, and the same route never reads as "Placed by".
  for (const p of ['picked', 'follow_up', 'answer'] as const) {
    assert.equal(says(p, null), null);
    assert.equal(says(p, local), null);
    assert.equal(says(p, route({ quote: 'the header again' })), 'Brief by Claude Code · haiku');
    assert.equal(says(p, route({ fallback: slow })), `Sent in your words. ${slow}`);
  }
  // No word yet, or the asking was cut short: nothing, or the core's sentence alone.
  assert.equal(says(null, null), null);
  assert.equal(says(null, route({ pending: true })), null);
  assert.equal(says(null, route({ ...local, fallback: 'Tasktap stopped while it was being placed' })), 'Tasktap stopped while it was being placed');
  // Every word the core has is told from: a new one fails here before it reads as nothing.
  const words: Record<NonNullable<Thought['placed']>, true> = { picked: true, name: true, model: true, follow_up: true, answer: true, kept: true, kept_answer: true, kept_name: true, kept_model: true };
  assert.equal(Object.keys(words).length, 9);
});

test('why a thought waits in For later: the four reasons, whatever its route says', () => {
  const why = (placed_: Thought['placed'], r: Routing | null = null) => laterWhy(thought({ mode: 'note', placed: placed_, route: r }), name);
  assert.equal(why('kept'), 'You saved it for later');
  assert.equal(why('kept_answer', route()), 'You kept it for later');
  assert.equal(why('kept_name', route({ by: 'local', model: null })), 'It named no folder');
  assert.equal(why('kept_name', route({ by: 'local', model: null, fallback: 'the folder or session it found is gone' })), 'It named no folder');
  assert.equal(why('kept_model', route()), 'Claude Code found no folder for it');
  assert.equal(why('kept_model', route({ by: 'codex', model: 'gpt-6-luna' })), 'Codex found no folder for it');
  assert.equal(why(null, route()), 'Saved for later');
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