// What the Composer's place chooser says (place.ts, drawn by capture.tsx): the chip's one name and its tooltip in each
// state, the list's rows in their order, and the built-in project's name by its kind.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project } from '../../core/proto/protocol.ts';
import { Records } from './client.ts';
import { rows, says, type Why } from './place.ts';

const K = { key: '⌘K' };
const AUTO = 'Auto: Tasktap sends the task to the project the task names, and asks you when the task names none. Click (or ⌘K) to choose the place yourself.';

test('Auto with nothing known yet is one word under the arrow, and its tooltip says how the place is found', () => {
  for (const why of ['words', 'ask', 'asked', 'model', 'starting'] satisfies Why[]) {
    const c = says(why, { place: '', is: 'folder', ...K });
    assert.deepEqual([c.mark, c.name, c.auto], ['arrow', 'Auto', false], why);
  }
  assert.equal(says('words', { place: '', is: 'folder', ...K }).title, AUTO);
  // An agent may choose: the tooltip names the agent that reads the task.
  assert.equal(says('model', { place: '', is: 'folder', agent: 'Claude Code', ...K }).title,
    'Auto: Tasktap sends the task to the project the task names. When the task names none, Claude Code reads the task and chooses the project. Click (or ⌘K) to choose the place yourself.');
  // Off the Mac the key is spelled as that system's keyboard has it.
  assert.ok(says('ask', { place: '', is: 'folder', key: 'Ctrl+K' }).title.includes('Click (or Ctrl+K) to choose'));
});

test('Auto that found the place shows the place by its icon and name, then Auto, and its tooltip says what the task names', () => {
  const named = says('named', { place: 'ledger-api', is: 'folder', ...K });
  assert.deepEqual(named, { mark: 'folder', name: 'ledger-api', auto: true, title: 'Auto: the task names ledger-api. Click (or ⌘K) to choose another place.' });
  // A name said otherwise than written reads the same; a project not open yet says sending the task opens it.
  assert.deepEqual(says('said', { place: 'harbormaster', is: 'folder', fresh: true, ...K }), {
    mark: 'folder', name: 'harbormaster', auto: true,
    title: 'Auto: the task names harbormaster. Sending the task opens harbormaster. Click (or ⌘K) to choose another place.',
  });
  assert.deepEqual(says('follows', { place: 'timer fix', is: 'session', ...K }), {
    mark: 'term', name: 'Follow-up: timer fix', auto: true, title: 'Auto: the task continues timer fix. Click (or ⌘K) to choose another place.',
  });
  assert.deepEqual([says('named', { place: 'Scratchpad', is: 'scratch', ...K }).mark, says('named', { place: 'Scratchpad', is: 'scratch', ...K }).name], ['pad', 'Scratchpad']);
});

test('a folder the person chose, is in, or has alone shows its name and nothing after it', () => {
  for (const why of ['chosen', 'in'] satisfies Why[]) {
    assert.deepEqual(says(why, { place: 'fieldnotes', is: 'folder', ...K }), {
      mark: 'folder', name: 'fieldnotes', auto: false, title: 'The task goes to fieldnotes. Click (or ⌘K) to change the place.',
    }, why);
  }
  assert.equal(says('chosen', { place: 'harbormaster', is: 'folder', fresh: true, ...K }).title,
    'The task goes to harbormaster. Sending the task opens harbormaster. Click (or ⌘K) to change the place.');
  assert.deepEqual(says('only', { place: 'cuegrid', is: 'folder', ...K }), {
    mark: 'folder', name: 'cuegrid', auto: false,
    title: 'cuegrid is the only folder open, so a task that names no other project goes to cuegrid. Click (or ⌘K) to change the place.',
  });
});

test('the Scratchpad, For later and no project yet are one name each', () => {
  assert.deepEqual(says('chosen', { place: 'Scratchpad', is: 'scratch', ...K }), {
    mark: 'pad', name: 'Scratchpad', auto: false,
    title: 'Scratchpad: the agent works in Tasktap’s own empty folder, for a task that belongs to no project. Click (or ⌘K) to change the place.',
  });
  assert.deepEqual(says('chosen', { place: 'For later', is: 'later', ...K }), {
    mark: 'later', name: 'For later', auto: false, title: 'For later: the task waits on Home, and nothing starts. Click (or ⌘K) to change the place.',
  });
  assert.deepEqual(says('none', { place: 'For later', is: 'later', ...K }), {
    mark: 'folder', name: 'No project yet', auto: false, title: 'No project is open yet, so the task is saved for later. Click (or ⌘K) to open a folder.',
  });
});

test('after a task with a place of its own, the chip says it is back, and its tooltip why', () => {
  const c = says('words', { place: '', is: 'folder', back: true, ...K });
  assert.deepEqual([c.name, c.title], ['Back to Auto', `Your choice was for the task before. ${AUTO}`]);
  assert.equal(says('only', { place: 'cuegrid', is: 'folder', back: true, ...K }).name, 'Back to cuegrid');
});

test('nothing the chip says is joined by a dot', () => {
  const all: Why[] = ['chosen', 'follows', 'named', 'said', 'asked', 'in', 'model', 'only', 'words', 'ask', 'none', 'starting'];
  for (const why of all) for (const is of ['folder', 'scratch', 'session', 'later'] as const) {
    const c = says(why, { place: 'cuegrid', is, fresh: true, agent: 'Codex', ...K });
    assert.ok(!`${c.name} ${c.title}`.includes('·'), `${why} ${is}: ${c.name} / ${c.title}`);
  }
});

const folder = (id: string, name: string) => ({ id, name, kind: 'folder' as const });
const scratch = { id: 's', name: 'Scratch', kind: 'scratch' as const };
const list = (o: Partial<Parameters<typeof rows>[0]> = {}) =>
  rows({ found: [], open: [folder('c', 'cuegrid'), folder('f', 'fieldnotes'), scratch], typed: false, moving: false, auto: true, most: 3, ...o });
const names = (r: ReturnType<typeof rows>) => r.map((x) => [x.name, ...x.dim].join(' / '));

test('the list offers Auto, the open folders, the Scratchpad, another folder and For later, in that order', () => {
  assert.deepEqual(names(list()), ['Auto / finds the project', 'cuegrid', 'fieldnotes', 'Scratchpad / no project needed', 'Open another folder…', 'For later']);
  assert.deepEqual(list().map((r) => [r.to, r.mark]), [['', 'arrow'], ['c', 'folder'], ['f', 'folder'], ['s', 'pad'], ['add', 'plus'], ['later', 'later']]);
  // What the field or the task's words found comes first, its reason then "not open yet", each a phrase of its own.
  const found = [{ id: 'k', name: 'kiln', why: 'static site', fresh: true }];
  assert.deepEqual(names(list({ found })).slice(0, 2), ['kiln / static site / not open yet', 'Auto / finds the project']);
  // While something is typed in the field: only what it found, and another folder.
  assert.deepEqual(names(list({ found, typed: true })), ['kiln / static site / not open yet', 'Open another folder…']);
  // Sending a task kept for later: a place, never Auto or For later again.
  assert.deepEqual(names(list({ moving: true })), ['cuegrid', 'fieldnotes', 'Scratchpad / no project needed', 'Open another folder…']);
  // No project known: no Auto, which would have nothing to find.
  assert.deepEqual(names(list({ auto: false, open: [scratch] })), ['Scratchpad / no project needed', 'Open another folder…', 'For later']);
  // In the notch three folders at most; the Scratchpad stays.
  const many = ['a', 'b', 'c', 'd', 'e'].map((n) => folder(n, n));
  assert.deepEqual(names(list({ open: [...many, scratch] })).slice(1, 5), ['a', 'b', 'c', 'Scratchpad / no project needed']);
  for (const r of list({ found })) assert.ok(![r.name, ...r.dim].some((x) => x.includes('·')), r.name);
});

test('the built-in project reads Scratchpad by its kind, whatever name is stored', () => {
  const records = new Records();
  const p = (id: string, name: string, kind: Project['kind']) => ({ id, rev: 1, name, folder: `/x/${id}`, kind, color: '', aliases: [], git: false, isolate: 'never', open: true, available: true }) as Project;
  records.apply({ rev: 1, snap: true } as never, [{ c: 'projects', put: [p('s', 'Scratch', 'scratch'), p('f', 'Scratch', 'folder')] } as never]);
  assert.equal(records.projects.get('s')?.name, 'Scratchpad');
  // A folder the person named so keeps the name.
  assert.equal(records.projects.get('f')?.name, 'Scratch');
});
