// The live target (target.ts): provisional then confirmed, calm, in order, and what Return takes.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Place } from '../../core/proto/protocol.ts';
import { PREVIEWS } from '../../core/proto/protocol.ts';
import { SHOWN_FOR, STAND, Target, due, taskOf, wordCount } from './target.ts';

const to = (project: string): Place => ({ project });
const name = (p?: Place) => (p && 'project' in p ? p.project : '');
const W1 = 'make the header stay', W2 = 'make the header stay on one line';

test('a first provisional target shows at once, a different one only after it has stood, the same place never moves', () => {
  const t = new Target();
  t.set(W1, 0);
  t.guess(W1, to('a'), 10);
  assert.deepEqual(t.shown, { place: to('a'), tone: 'provisional', at: 1, of: 1 });
  // Another place for the same words: not shown until it has stood for STAND ms, however often it is said again.
  assert.equal(t.guess(W1, to('b'), 100), STAND);
  assert.equal(t.guess(W1, to('b'), 200), STAND - 100);
  assert.equal(name(t.shown?.place), 'a');
  assert.equal(t.guess(W1, to('b'), 100 + STAND), null);
  assert.equal(name(t.shown?.place), 'b');
  // Said once more, the same: nothing changes.
  const was = t.shown;
  t.guess(W1, to('b'), 900);
  assert.equal(t.shown, was);
});

test('a target that comes back before it stood leaves nothing to wait for', () => {
  const t = new Target();
  t.set(W1, 0);
  t.guess(W1, to('a'), 0);
  t.guess(W1, to('b'), 100);
  t.guess(W1, to('a'), 200);
  assert.equal(t.guess(W1, to('a'), 100 + STAND + 10), null);
  assert.equal(name(t.shown?.place), 'a');
});

test('the model confirms the place on show at once, and a provisional one never replaces a confirmed one for the same words', () => {
  const t = new Target();
  t.set(W2, 0);
  t.guess(W2, to('a'), 0);
  const n = t.ask(W2);
  t.preview(n, W2, [to('a')], 50);
  assert.deepEqual(t.shown, { place: to('a'), tone: 'confirmed', at: 1, of: 1 });
  // The ranking says another place for the same words: the confirmed one stays.
  t.guess(W2, to('b'), 100);
  t.guess(W2, to('b'), 100 + 3 * STAND);
  assert.equal(name(t.shown?.place), 'a');
  assert.equal(t.shown?.tone, 'confirmed');
});

test('a confirmed target that is another place than the one on show waits as any other does', () => {
  const t = new Target();
  t.set(W2, 0);
  t.guess(W2, to('a'), 0);
  t.preview(t.ask(W2), W2, [to('b')], 100);
  assert.equal(name(t.shown?.place), 'a');
  assert.equal(t.shown?.tone, 'provisional');
  // Return takes nothing it was not shown.
  assert.equal(t.take(W2, 100 + SHOWN_FOR), null);
  t.set(W2, 100 + STAND);
  assert.equal(name(t.shown?.place), 'b');
  assert.equal(t.take(W2, 100 + STAND + SHOWN_FOR), 0);
});

test('Return takes a target only after it has been on show for half a second, and only while the way it goes is whole', () => {
  const t = new Target();
  t.set(W2, 0);
  t.guess(W2, to('a'), 0);
  t.preview(t.ask(W2), W2, [to('a')], 1000);
  // Shown, and Return a moment later: the person has barely seen it.
  assert.equal(t.take(W2, 1000), null);
  assert.equal(t.take(W2, 1000 + SHOWN_FOR - 1), null);
  assert.equal(t.take(W2, 1000 + SHOWN_FOR), 0);
  // Cut so that "new run" or the start of the title is not whole: none either.
  assert.equal(t.take(W2, 1000 + SHOWN_FOR, false), null);
});

test('an answer to an older question is dropped, so nothing flickers when answers come out of order', () => {
  const t = new Target();
  t.set(W1, 0);
  t.guess(W1, to('a'), 0);
  const first = t.ask(W1);
  t.set(W2, 800);
  const second = t.ask(W2);
  t.guess(W2, to('a'), 900);
  // The newer answer first; then the older one, late: ignored.
  t.preview(second, W2, [to('a')], 1000);
  const was = t.shown;
  t.preview(first, W1, [to('c')], 1100);
  t.set(W2, 1100 + 2 * STAND);
  assert.equal(t.shown, was);
  assert.equal(t.take(W2, 2000), 0);
});

test('a confirmed target for older words stays until the new words have another that stood; Return takes it only for the words it is of', () => {
  const t = new Target();
  t.set(W1, 0);
  t.guess(W1, to('a'), 0);
  t.preview(t.ask(W1), W1, [to('a')], 10);
  assert.equal(t.take(W1, 10 + SHOWN_FOR), 0);
  // Words typed that the state has not been told of yet are not the words it holds an answer for.
  assert.equal(t.take(W2, 10 + SHOWN_FOR), null);
  t.set(W2, 700);
  assert.equal(t.take(W2, 700 + SHOWN_FOR), null);
  assert.equal(t.shown?.tone, 'confirmed');
  // The ranking agrees: the same place, so nothing moves and the tone is kept.
  t.guess(W2, to('a'), 750);
  assert.equal(t.shown?.tone, 'confirmed');
  // It does not: the new place replaces it once it has stood.
  t.guess(W2, to('b'), 800);
  t.guess(W2, to('b'), 800 + STAND);
  assert.equal(name(t.shown?.place), 'b');
  assert.equal(t.shown?.tone, 'provisional');
});

test('a torn answer is stepped through on one key, shown at once, as "1 of 3", and Return takes the one shown after half a second', () => {
  const t = new Target();
  t.set(W2, 0);
  t.guess(W2, to('a'), 0);
  assert.equal(t.next(0), false);
  t.preview(t.ask(W2), W2, [to('a'), to('b'), to('c')], 10);
  assert.deepEqual(t.shown, { place: to('a'), tone: 'confirmed', at: 1, of: 3 });
  assert.equal(t.next(1000), true);
  assert.deepEqual(t.shown, { place: to('b'), tone: 'confirmed', at: 2, of: 3 });
  // The choice just stepped to has been on show for no time at all.
  assert.equal(t.take(W2, 1000 + 100), null);
  assert.equal(t.take(W2, 1000 + SHOWN_FOR), 1);
  t.next(2000);
  t.next(2000);
  assert.equal(t.shown?.at, 1);
  assert.equal(t.take(W2, 2000 + SHOWN_FOR), 0);
  // Words changed: the step starts over, and nothing is taken.
  t.next(3000);
  t.set(`${W2} please`, 3100);
  assert.equal(t.take(`${W2} please`, 4000), null);
  assert.equal(t.next(4000), false);
});

test('emptying the field takes what is shown away and gives the task no more previews; only a sent task starts the count again', () => {
  const t = new Target();
  t.set(W2, 0);
  t.guess(W2, to('a'), 0);
  t.preview(t.ask(W2), W2, [to('a')], 10);
  assert.equal(t.sent, 1);
  t.set('   ', 20);
  assert.deepEqual([t.shown, t.sent, t.asked, t.take(W2, 2000)], [null, 1, W2, null]);
  // The same words typed again are not asked about again.
  t.set(W2, 30);
  assert.equal(due({ words: W2, asked: t.asked, sent: t.sent }), false);
  t.done();
  assert.deepEqual([t.sent, t.asked], [0, null]);
});

test('the model is asked after three words, for words it was not asked about, at most the cap of times', () => {
  assert.equal(wordCount('  make the\nheader '), 3);
  assert.equal(due({ words: 'make the', asked: null, sent: 0 }), false);
  assert.equal(due({ words: W1, asked: null, sent: 0 }), true);
  assert.equal(due({ words: W1, asked: W1, sent: 1 }), false);
  assert.equal(due({ words: W2, asked: W1, sent: PREVIEWS - 1 }), true);
  assert.equal(due({ words: W2, asked: W1, sent: PREVIEWS }), false);
});

test('typed words are never previewed under the id of a spoken thought that is still pending', () => {
  const mint = () => 'typed-task';
  assert.equal(taskOf(true, 'spoken-thought', mint), 'spoken-thought');
  assert.equal(taskOf(false, 'spoken-thought', mint), 'typed-task');
  assert.equal(taskOf(false, '', mint), 'typed-task');
});
