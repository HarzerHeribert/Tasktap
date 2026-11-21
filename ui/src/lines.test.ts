// The Composer's lines in the empty field and the one timer that rolls them (lines.ts).
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { EVERY, type Field, LINES, type Now, Roll, WHILE_RUNNING, rolls, text } from './lines.ts';

const all: Now = { key: '⌥Space', running: true };
/** The lines a whole round shows, in order. */
const shown = (now = all) => LINES.flatMap((l) => ((l.includes('{key}') && !now.key) || (WHILE_RUNNING.includes(l) && !now.running) ? [] : [l.replace('{key}', now.key ?? '')]));
const roll = (now = all) => {
  const seen: [string, boolean][] = [];
  const r = new Roll(() => now, (line, rolled) => seen.push([line, rolled]));
  return { r, seen };
};

test('a fresh start shows "What\'s next?", then every line in the list\'s order, and after the last the first again', () => {
  const { r, seen } = roll();
  assert.equal(r.line, "What's next?");
  for (let k = 0; k < 2 * LINES.length; k++) r.next(false);
  const lines = shown();
  assert.deepEqual(seen.map(([l]) => l), [...lines.slice(1), ...lines, lines[0]]);
});

test('the line with the key held to talk says the key as it is set, and is left out without one', () => {
  const at = LINES.findIndex((l) => l.includes('{key}'));
  assert.ok(at > 0, 'the list has a line with the key held to talk');
  assert.equal(text(at, { key: '⌃Space', running: false }), LINES[at]!.replace('{key}', '⌃Space'));
  assert.equal(text(at, { key: 'Ctrl+Alt+T', running: false }), LINES[at]!.replace('{key}', 'Ctrl+Alt+T'));
  // Without a key, the line after it is shown in its place, and a whole round never shows it.
  assert.equal(text(at, { key: null, running: false }), text(at + 1, { key: null, running: false }));
  const { r, seen } = roll({ key: null, running: true });
  for (let k = 0; k < LINES.length; k++) r.next(false);
  assert.ok(seen.every(([l]) => !/\{key\}|Hold .* and talk/.test(l)), 'no line about a key to hold where there is none');
  assert.equal(seen.length, LINES.length);
});

test('a line for while a task runs is shown only while one runs', () => {
  for (const line of WHILE_RUNNING) {
    const i = LINES.indexOf(line);
    assert.ok(i >= 0);
    assert.equal(text(i, { key: '⌥Space', running: true }), line);
    assert.ok(text(i, { key: '⌥Space', running: false }) !== line);
  }
});

const field: Field = { empty: true, held: true, front: true, dictating: false, composing: false, effects: 'full' };
test('the field rolls only while it is empty, has the keyboard, Tasktap is in front, nothing is dictated or composed, and the effects are Full', () => {
  assert.equal(rolls(field), true);
  for (const still of [{ empty: false }, { held: false }, { front: false }, { dictating: true }, { composing: true }, { effects: 'still' as const }, { effects: 'off' as const }])
    assert.equal(rolls({ ...field, ...still }), false, JSON.stringify(still));
});

test('one timer, every five seconds, only while the field rolls: each way out stops it, and it starts again when the field may roll again', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { r, seen } = roll();
    const box = {};
    r.run(rolls(field), box);
    assert.ok(r.rolling);
    mock.timers.tick(EVERY - 1);
    assert.equal(seen.length, 0);
    mock.timers.tick(1);
    assert.deepEqual(seen, [[shown()[1], true]]);
    mock.timers.tick(EVERY);
    assert.equal(seen.length, 2);
    // Every condition that holds the line still: the timer goes at once, nothing rolls however long it waits, and once
    // the field may roll again the next line comes five seconds later.
    for (const still of [{ empty: false }, { held: false }, { front: false }, { dictating: true }, { composing: true }, { effects: 'still' as const }, { effects: 'off' as const }]) {
      const before = seen.length;
      r.run(rolls({ ...field, ...still }), box);
      assert.equal(r.rolling, false, `${JSON.stringify(still)} leaves the timer running`);
      mock.timers.tick(10 * EVERY);
      assert.equal(seen.length, before, `${JSON.stringify(still)} rolled the line`);
      r.run(rolls(field), box);
      assert.ok(r.rolling);
      mock.timers.tick(EVERY);
      assert.equal(seen.length, before + 1, `after ${JSON.stringify(still)} the line does not roll again`);
      assert.equal(seen.at(-1)![1], true);
    }
    // The field gone: its roll goes; another field's word about itself does not stop the roll of the one with the keyboard.
    r.run(false, {});
    assert.ok(r.rolling);
    r.stop(box);
    assert.equal(r.rolling, false);
  } finally {
    mock.timers.reset();
  }
});

test('a line still rolling is put in its place the moment the roll stops', () => {
  let ended = 0;
  const r = new Roll(() => all, () => {}, () => ended++);
  r.run(true, 'field');
  r.run(false, 'field');
  assert.equal(ended, 1);
});
