// What the pages show of a thought on its way and of speech, from the core's records (way.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatGpt, Routing, Thought } from '../../core/proto/protocol.ts';
import {
  agentState, agreement, back, briefOf, chatgptOffer, chatgptRow, clock, decided, first, hold, into, laterWhy, leave, letters, lettersOf, listed, moved, onWay, ownAgentLacks, fallback, placeWhy,
  offers, placed, placeOf, places, placing, placingSays, proposed, ranked, ring, step, waits,
} from './way.ts';

test('ChatGPT\'s row of placing is a button until it is signed in, waits for the browser, and then is a row like the others', () => {
  const seen = (o: Partial<ChatGpt>): ChatGpt => ({ state: 'signed_in', model: null, name: null, error: null, ...o });
  // Never signed in, or signed out by the person: the button, and nothing to say.
  assert.deepEqual(chatgptRow(null), { state: 'out', name: null, says: null });
  // Waiting for the browser: Cancel, and what it waits for.
  assert.deepEqual(chatgptRow(seen({ state: 'waiting' })), { state: 'waiting', name: null, says: 'Waiting for the sign-in in your browser…' });
  // Signed in: by the model's name, or its slug where the list gave none.
  assert.deepEqual(chatgptRow(seen({ model: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' })), { state: 'in', name: 'GPT-6.2 Sol', says: null });
  assert.equal(chatgptRow(seen({ model: 'gpt-6.2-sol' })).name, 'gpt-6.2-sol');
  // Not signed in after a sign-in that did not finish, or ended: the button again, and why, in the given words.
  const out = (o: Partial<ChatGpt>) => { const r = chatgptRow(seen(o)); assert.equal(r.state, 'out'); return r.says; };
  assert.equal(out({ state: 'failed', error: 'access_denied' }), 'The sign-in with ChatGPT did not finish: access_denied.');
  assert.equal(out({ state: 'failed', error: 'no answer came from the browser within 5 minutes.' }), 'The sign-in with ChatGPT did not finish: no answer came from the browser within 5 minutes.');
  assert.equal(out({ state: 'no_plan' }), 'ChatGPT signed you in, but did not allow Tasktap to use your plan. Sign in again and allow the use of your plan.');
  assert.equal(out({ state: 'signed_out' }), 'ChatGPT signed Tasktap out. Sign in with ChatGPT again to keep ChatGPT placing your tasks.');
  assert.equal(out({ state: 'no_model' }), 'Your ChatGPT account does not offer GPT-6.2-Sol, the model Tasktap uses to find the project for a task.');
  // What the sheet says above the button: where the task goes, and the model that finds its project.
  assert.equal(chatgptOffer('gpt-6.2-sol'), 'Sign in with ChatGPT and every task you do not place yourself goes to OpenAI, where gpt-6.2-sol finds the project in one direct call on your ChatGPT plan. No agent is started for the placing, and each placing counts against your plan like any other use of ChatGPT.');
});

test('Setup\'s placing step is always there, and with nobody signed in it says how to sign someone in', () => {
  assert.equal(placingSays('off', null, 0, false, false), 'Sign in with ChatGPT, or sign an agent in under Settings › Agents');
  assert.equal(placingSays('off', null, 0, true, false), 'Sign in with ChatGPT, or sign an agent in under Settings › Agents');
  assert.equal(placingSays('off', null, 0, false, true), 'For tasks you do not place');
  assert.equal(placingSays('off', null, 0, true, true), 'Skipped');
  assert.equal(placingSays('on', 'ChatGPT', 0, true, true), 'By ChatGPT');
  assert.equal(placingSays('on', 'ChatGPT', 2, true, true), 'By ChatGPT, then 2 more');
  assert.equal(placingSays('again', null, 0, true, true), 'Placing now sends more. Agree again to keep it on.');
});

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

test('the Composer\'s list offers every agent that is here and runs on this system, in the core\'s order, and narrows by what is typed', () => {
  const a = (id: string, name: string, o: object = {}) => ({ id, name, installed: true, supported: true, signed_in: true as boolean | null, ...o });
  const ids = (x: { id: string }[]) => x.map((r) => r.id).join(' ');
  const all = [a('claude', 'Claude Code'), a('codex', 'Codex', { signed_in: false }), a('agy', 'Antigravity', { installed: false }), a('pi', 'Pi', { supported: false }), a('aider', 'Aider', { signed_in: null }),
    a('opencode', 'OpenCode'), a('qwen', 'Qwen Code'), a('gemini', 'Gemini CLI')];
  // Signed out is listed (its row leads to where it is signed in); not here, or not for this system, is not.
  assert.equal(ids(listed(all, (x) => x.name)), 'claude codex aider opencode qwen gemini');
  // Typing narrows by name or id, whatever the case: a name that begins with it first, then one with a word that does,
  // then the rest that hold it (the review: "co" chose Claude Code over Codex).
  assert.equal(ids(listed(all, (x) => x.name, 'CODE')), 'codex claude qwen opencode');
  assert.equal(ids(listed(all, (x) => x.name, 'co')), 'codex claude qwen opencode');
  assert.equal(ids(listed(all, (x) => x.name, 'gem')), 'gemini');
  assert.equal(ids(listed(all, (x) => x.name, 'nothing')), '');
  assert.equal(ids(listed([], (x: { id: string; name: string; installed: boolean; supported: boolean }) => x.name)), '');
});

test('the form for an agent of the person\'s own says what its command lacks, in the core\'s words', () => {
  assert.equal(ownAgentLacks('Goose', 'goose run -t {prompt}'), '');
  assert.equal(ownAgentLacks('Goose', '"/Applications/My Tool/run" \'do: {prompt}\''), '');
  assert.equal(ownAgentLacks(' ', 'goose {prompt}'), 'Give the agent a name of up to 40 characters');
  assert.equal(ownAgentLacks('x'.repeat(41), 'goose {prompt}'), 'Give the agent a name of up to 40 characters');
  assert.equal(ownAgentLacks('Goose', '  '), 'Goose needs a command');
  assert.equal(ownAgentLacks('Goose', '{prompt}'), 'The command of Goose needs a program before {prompt}');
  assert.equal(ownAgentLacks('Goose', 'goose run'), 'The command of Goose needs {prompt} where the task goes');
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

const route = (o: Partial<Routing> = {}): Routing => ({ by: 'claude', model: 'haiku', pending: false, fallback: null, quote: null, title: null, lead: null, ms: 2100, others: [], ...o });
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

test('the hold is a share of its whole length from the decision, and follows the record when it moves', () => {
  const t = thought({ phase: 'routed', status: 'routed', created: 1000, hold_until: 6000, route: route() });
  assert.deepEqual(hold(t, 3500, 5000), { share: 0.5, ms: 2500 });
  assert.deepEqual(hold(t, 9000, 5000), { share: 0, ms: 0 });
  // A model answered after 3 s: the whole hold of 5 s counts from its answer, and runs from the start.
  assert.deepEqual(hold({ ...t, hold_until: 9000 }, 4000, 5000), { share: 1, ms: 5000 });
  // A brief arrived late: the core moved the end to 2 s from then, of the 5 s hold.
  assert.deepEqual(hold({ ...t, hold_until: 8000 }, 6000, 5000), { share: 2000 / 5000, ms: 2000 });
  // While the brief is still written the end is open; nothing depletes.
  assert.equal(hold({ ...t, route: route({ pending: true }) }, 3500, 5000), null);
  assert.equal(hold(thought(), 3500, 5000), null);
});

test('the decision line names the project and how the task goes there, and offers the other places on 2 and 3', () => {
  const names = { project: (id: string) => ({ p1: 'cuegrid', p2: 'folio' })[id] ?? '?', session: (id: string) => ({ s1: 'Fix the flaky export test', s2: 'Login' })[id] ?? '?', of: (id: string) => ({ s1: 'p1', s2: 'p2' })[id], cut: (s: string) => (s.length > 17 ? `${s.slice(0, 16)}…` : s) };
  const held = (o: Partial<Thought>) => ({ ...thought({ phase: 'routed', status: 'routed', hold_until: 6000, ...o }), session_id: null, card_id: null, ...o }) as Thought;
  const follow = held({ project_id: 'p1', session_id: 's1', route: route({ others: [{ project: 'p1' }] }) });
  assert.deepEqual(decided(follow, names), { name: 'cuegrid', how: 'continuing Fix the flaky export test' });
  // The other way of going, in the same project, says only the way; and back.
  assert.deepEqual(offers(follow, names), [{ key: '2', to: { project: 'p1' }, label: 'New run', title: 'A new run in cuegrid', words: { name: 'cuegrid', how: 'new run' } }]);
  const run = held({ project_id: 'p1', route: route({ others: [{ session: 's1' }] }) });
  assert.deepEqual(decided(run, names), { name: 'cuegrid', how: 'new run' });
  assert.deepEqual(offers(run, names).map((o) => [o.label, o.title]), [['Continue', 'Continue Fix the flaky export test']]);
  // Torn: no time runs, it waits for a key; the places elsewhere say their names, two at most.
  const torn = held({ project_id: 'p1', hold_until: null, route: route({ others: [{ project: 'p2' }, { session: 's2' }, { project: 'p3' }] }) });
  assert.equal(waits(torn), true);
  assert.equal(waits(run), false);
  assert.deepEqual(offers(torn, names).map((o) => [o.key, o.label, `${o.words.name}, ${o.words.how}`]), [['2', 'folio', 'folio, new run'], ['3', 'Login', 'folio, continuing Login']]);
  assert.deepEqual([placeOf({ project: 'p2' }), placeOf({ session: 's2' }), placeOf({ card: 'c1' })], [{ project_id: 'p2' }, { session_id: 's2' }, { card_id: 'c1' }]);
});

test('how it came by its place is told from the core\'s word for it, never from who is named in its route', () => {
  const local = route({ by: 'local', model: null }), slow = 'claude: it did not answer within 12 s';
  const gone = 'Codex no longer offers the model Tasktap asks for placing; placing by name until Tasktap is updated';
  const says = (placed_: Thought['placed'], r: Routing | null) => placed(thought({ placed: placed_, route: r }), name);
  // "Placed by" only where the match on names or a model placed it.
  assert.equal(says('name', local), 'Placed by name');
  assert.equal(says('name', route({ ...local, fallback: slow })), `Placed by name. ${slow}`);
  assert.equal(says('name', route({ ...local, fallback: gone })), `Placed by name. ${gone}`);
  // No name was said for certain and one project clearly led: the line says what only it has.
  assert.equal(says('name', route({ ...local, lead: 'its name and “widgetpack”' })), 'its name and “widgetpack”');
  assert.equal(says('name', route({ ...local, lead: 'its name and “widgetpack”', fallback: slow })), `its name and “widgetpack”. ${slow}`);
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

const tool = (agent: string, model: string, pays: 'plan' | 'billed', ms: number | null) => ({ agent, model, pays, ms, terms: 3 });
/** As `route.terms` proposes them: what costs nothing more first, the fastest first among those. */
const TOOLS = [tool('claude', 'haiku', 'plan', 3700), tool('codex', 'gpt-6-luna', 'plan', 4700), tool('agy', 'gemini-3.8-flash-low', 'plan', 5600)];
const by = (terms: number, ...agents: [string, string, boolean][]) => ({ terms, agents: agents.map(([agent, model, on]) => ({ agent, model, on })) });

test('placing by the person\'s agents is on only for what this Tasktap would ask', () => {
  assert.equal(placing(null, TOOLS), 'off');
  assert.equal(placing(undefined, TOOLS), 'off');
  assert.equal(placing(by(3, ['codex', 'gpt-6-luna', true], ['claude', 'haiku', false]), TOOLS), 'on');
  assert.equal(first(by(3, ['codex', 'gpt-6-luna', true], ['claude', 'haiku', true]), TOOLS), 'codex');
  // A consent to one agent that a core before this one kept reads as a list of it alone, to the terms then: asked again.
  assert.equal(placing(by(2, ['claude', 'haiku', true]), TOOLS), 'again');
  assert.equal(first(by(2, ['claude', 'haiku', true]), TOOLS), undefined);
  // A model Tasktap asks no more is asked again; every one switched off, or none that can place now, is off.
  assert.equal(placing(by(3, ['codex', 'gpt-5-mini', true]), TOOLS), 'again');
  assert.equal(placing(by(3, ['claude', 'haiku', false]), TOOLS), 'off');
  assert.equal(placing(by(3, ['codex', 'gpt-6-luna', true]), [TOOLS[0]!]), 'off');
});

test('the placing group lists the agreement in its order, then the others in Tasktap\'s, and moves by one', () => {
  const rows = (b: Parameters<typeof ranked>[0], tools = TOOLS) => ranked(b, tools).map((r) => `${r.agent}${r.on ? '' : ' off'}`).join(', ');
  // Nothing agreed yet: Tasktap's order, every one on.
  assert.equal(rows(null), 'claude, codex, agy');
  // The person's order; one not agreed to yet is off at the end; one that cannot place now is not shown.
  assert.equal(rows(by(3, ['agy', 'gemini-3.8-flash-low', true], ['claude', 'haiku', false])), 'agy, claude off, codex off');
  assert.equal(rows(by(3, ['codex', 'gpt-6-luna', true]), [TOOLS[0]!]), 'claude off');
  // Each row's place among those on; one switched off has none.
  assert.deepEqual(places(ranked(by(3, ['agy', 'x', true], ['claude', 'x', false], ['codex', 'x', true]), TOOLS)), [1, null, 2]);
  const r = ranked(null, TOOLS);
  assert.deepEqual(moved(r, 2, 0).map((x) => x.agent), ['agy', 'claude', 'codex']);
  assert.deepEqual(moved(r, 0, 1).map((x) => x.agent), ['codex', 'claude', 'agy']);
  // At either end it stays.
  assert.deepEqual(moved(r, 0, -1).map((x) => x.agent), ['claude', 'codex', 'agy']);
  assert.deepEqual(moved(r, 2, 3).map((x) => x.agent), ['claude', 'codex', 'agy']);
  // Tasktap's order again, each as it was switched.
  const mine = moved([...r.slice(0, 2), { ...r[2]!, on: false }], 2, 0);
  assert.deepEqual(proposed(mine, TOOLS).map((x) => `${x.agent}${x.on ? '' : ' off'}`), ['claude', 'codex', 'agy off']);
  // What is written: the rows, then what was agreed of one not shown now, with the model asked now; one Tasktap no
  // longer asks at all is let go.
  const kept = by(2, ['codex', 'gpt-5-mini', false], ['claude', 'haiku', true], ['gone', 'm', true]);
  assert.deepEqual(agreement(ranked(kept, [TOOLS[0]!]), kept, TOOLS, 3), by(3, ['claude', 'haiku', true], ['codex', 'gpt-6-luna', false]));
});

test('each agent says why it stands where it does, or until when it is passed over', () => {
  const at = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  assert.equal(placeWhy(TOOLS[0]!, null, 0, at), 'included in your subscription · about 4 s');
  assert.equal(placeWhy(tool('codex', 'gpt-6-luna', 'billed', 4700), null, 0, at), 'billed by your provider · about 5 s');
  assert.equal(placeWhy(tool('own', 'm', 'billed', null), null, 0, at), 'billed by your provider');
  const four = Date.UTC(2026, 10, 19, 16);
  assert.equal(placeWhy(TOOLS[0]!, four, four - 60_000, at), 'out of quota until 16:00');
  // Once the time has come it stands as before.
  assert.equal(placeWhy(TOOLS[0]!, four, four, at), 'included in your subscription · about 4 s');
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
test('an agreement to older terms is said once, in Setup, and on no thought; any other reason a model was not asked is', () => {
  const route = (fallback: string | null) => ({ route: { by: 'local', model: null, pending: false, fallback, quote: null, title: null, ms: 1 } }) as Pick<Thought, 'route'>;
  const again = 'the agreement was to what was sent before: placing now asks your agents one after another, and asks you again';
  assert.equal(fallback(route(again)), null);
  assert.equal(fallback(route('the agreement is for Codex with o4, and Tasktap now asks gpt-6-luna')), null);
  assert.equal(fallback(route('claude: it did not answer within 12 s')), 'claude: it did not answer within 12 s');
  assert.equal(fallback(route(null)), null);
  assert.equal(placed({ placed: 'name', ...route(again) }, (id) => id), 'Placed by name');
  assert.equal(placed({ placed: 'name', ...route('claude: it did not answer within 12 s') }, (id) => id), 'Placed by name. claude: it did not answer within 12 s');
});
