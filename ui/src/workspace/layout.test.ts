// The layout model: split, move, close, resize, balance, repair and placement, and where panes
// and dividers go. Run by `npm run check` with Node's own test runner.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type Layout, background, close, empty, geometry, move, normalize, open, paneOf, panes, ratioAt, reconcile, resize, select,
  split, tabs, textSize, toggleFocus,
} from './layout.ts';

/** Ids in order, so a test can name the panes and splits it makes. */
const ids = () => {
  let n = 0;
  return () => `n${++n}`;
};
const shape = (l: Layout): unknown => {
  const walk = (n: Layout['tree']): unknown => (!n ? null : 'tabs' in n ? n.tabs.join(',') : [n.axis, n.ratio, walk(n.first), walk(n.second)]);
  return walk(l.tree);
};

test('opening tabs fills one pane; splits nest in both directions and select the new pane', () => {
  const id = ids();
  let l = open(empty(), 'a', undefined, id);
  l = open(l, 'b', undefined, id);
  assert.deepEqual(shape(l), 'a,b');
  assert.equal(paneOf(l, 'b')?.active, 'b');
  l = split(l, l.selected!, 'x', 'c', false, id);
  assert.deepEqual(shape(l), ['x', 50, 'a,b', 'c']);
  assert.equal(l.selected, paneOf(l, 'c')!.id);
  l = split(l, l.selected!, 'y', 'd', false, id);
  assert.deepEqual(shape(l), ['x', 50, 'a,b', ['y', 50, 'c', 'd']]);
  assert.deepEqual(panes(l).map((p) => p.tabs[0]), ['a', 'c', 'd']);
  // Opening a tab that is already shown selects it where it is.
  l = open(l, 'a', undefined, id);
  assert.equal(l.selected, paneOf(l, 'a')!.id);
  assert.deepEqual(tabs(l), ['a', 'b', 'c', 'd']);
});

test('closing the last tab of a pane collapses its split; the neighbour is selected', () => {
  const id = ids();
  let l = open(empty(), 'a', undefined, id);
  l = split(l, l.selected!, 'x', 'b', false, id);
  l = split(l, l.selected!, 'y', 'c', false, id);
  const before = structuredClone(l);
  const after = close(l, 'c');
  assert.deepEqual(l, before, 'the argument is left as it was');
  assert.deepEqual(shape(after), ['x', 50, 'a', 'b']);
  assert.equal(after.selected, paneOf(after, 'b')!.id);
  // Closing the active tab of a pane with several shows the next one.
  let m = open(open(open(empty(), 'x', undefined, id), 'y', undefined, id), 'z', undefined, id);
  m = select(m, m.selected!, 'y');
  m = close(m, 'y');
  assert.equal(panes(m)[0]!.active, 'z');
  assert.equal(close(close(close(m, 'x'), 'z'), 'nothing').tree, null);
});

test('moving a tab: between panes, before another tab, to an edge, and out of its last pane', () => {
  const id = ids();
  let l = open(open(empty(), 'a', undefined, id), 'b', undefined, id);
  l = split(l, l.selected!, 'x', 'c', false, id);
  const left = paneOf(l, 'a')!.id;
  const right = paneOf(l, 'c')!.id;
  let m = move(l, 'b', right, { before: 'c' }, id);
  assert.deepEqual(shape(m), ['x', 50, 'a', 'b,c']);
  assert.equal(m.selected, right);
  // The last tab of a pane moving away removes the pane.
  m = move(m, 'a', right, {}, id);
  assert.deepEqual(shape(m), 'b,c,a');
  // To an edge: a new pane on that side of the target.
  m = move(l, 'b', right, { edge: 'bottom' }, id);
  assert.deepEqual(shape(m), ['x', 50, 'a', ['y', 50, 'c', 'b']]);
  m = move(l, 'c', left, { edge: 'left' }, id);
  assert.deepEqual(shape(m), ['x', 50, 'c', 'a,b']);
  // A pane's only tab cannot move to its own edge.
  assert.equal(move(m, 'c', paneOf(m, 'c')!.id, { edge: 'right' }, id), m);
});

test('a divider resizes within 10 to 90 percent and balances at 50', () => {
  const id = ids();
  let l = split(open(empty(), 'a', undefined, id), 'n1', 'x', 'b', false, id);
  const branch = (l.tree as { id: string }).id;
  assert.equal((resize(l, branch, 3).tree as { ratio: number }).ratio, 10);
  assert.equal((resize(l, branch, 97.4).tree as { ratio: number }).ratio, 90);
  l = resize(l, branch, 70);
  assert.equal((resize(l, branch, 50).tree as { ratio: number }).ratio, 50);
});

test('geometry places panes with a 6 px gap and divider targets over it; focus shows one pane', () => {
  const id = ids();
  let l = split(open(empty(), 'a', undefined, id), 'n1', 'x', 'b', false, id);
  l = split(l, l.selected!, 'y', 'c', false, id);
  const g = geometry(l, 806, 406);
  assert.deepEqual(g.panes.get(paneOf(l, 'a')!.id), { x: 0, y: 0, w: 400, h: 406 });
  assert.deepEqual(g.panes.get(paneOf(l, 'b')!.id), { x: 406, y: 0, w: 400, h: 200 });
  assert.deepEqual(g.panes.get(paneOf(l, 'c')!.id), { x: 406, y: 206, w: 400, h: 200 });
  assert.deepEqual(g.dividers.map((d) => [d.axis, d.rect]), [
    ['x', { x: 396, y: 0, w: 14, h: 406 }],
    ['y', { x: 406, y: 196, w: 400, h: 14 }],
  ]);
  // Dragging the first divider to x = 203 gives the left part a quarter.
  assert.equal(Math.round(ratioAt(g.dividers[0]!, { x: 203, y: 10 })), 25);
  const focused = geometry(toggleFocus(l), 806, 406);
  assert.deepEqual([...focused.panes.keys()], [l.selected]);
  assert.equal(focused.dividers.length, 0);
});

test('a stored tree is repaired: unknown shapes, repeated tabs, empty panes and wild ratios', () => {
  assert.deepEqual(normalize(null), empty());
  assert.deepEqual(normalize('junk'), empty());
  const l = normalize({
    tree: {
      id: 's', axis: 'q', ratio: 400,
      first: { id: 'p', tabs: ['a', 'a', 7, 'b'], active: 'zz' },
      second: { id: 's2', axis: 'y', first: { id: 'p', tabs: ['a'] }, second: { id: 'r', tabs: ['c'], active: 'c' } },
    },
    selected: 'missing', focus: 'yes', background: ['a', 'd', 'd', 3], sizes: { a: 15, b: 200, c: 'big' },
  });
  // The repeated tab a goes from the second pane, which is then empty and collapses its split.
  assert.deepEqual(shape(l), ['x', 90, 'a,b', 'c']);
  assert.equal(panes(l)[0]!.active, 'a');
  assert.equal(new Set(panes(l).map((p) => p.id)).size, 2);
  assert.equal(l.selected, panes(l)[0]!.id);
  assert.equal(l.focus, false);
  assert.deepEqual(l.background, ['d']);
  assert.deepEqual(l.sizes, { a: 15 });
  // A layout survives its own round trip through JSON unchanged.
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(l))), l);
});

test('reconcile places running terminals no tab mentions and forgets ones the core no longer has', () => {
  const id = ids();
  let l = open(empty(), 'a', undefined, id);
  l = background(open(l, 'b', undefined, id), 'b');
  l = textSize(l, 'gone', 12);
  l = open(l, 'gone', undefined, id);
  const known = new Set(['a', 'b', 'c', 'old']);
  const r = reconcile(l, ['a', 'b', 'c'], known, id);
  assert.deepEqual(tabs(r), ['a', 'c'], 'c gets a place; b stays in the background; gone leaves');
  assert.deepEqual(r.background, ['b']);
  assert.deepEqual(r.sizes, {});
  assert.equal(reconcile(r, ['a', 'b', 'c'], known, id), r, 'nothing to do changes nothing');
});

test('backgrounding a tab lists it; opening it again restores it to a pane', () => {
  const id = ids();
  let l = open(open(empty(), 'a', undefined, id), 'b', undefined, id);
  l = background(l, 'b');
  assert.deepEqual([tabs(l), l.background], [['a'], ['b']]);
  l = open(l, 'b', undefined, id);
  assert.deepEqual([tabs(l), l.background], [['a', 'b'], []]);
  assert.deepEqual(textSize(textSize(l, 'a', 99), 'b', 12).sizes, { a: 40, b: 12 });
  assert.deepEqual(textSize(textSize(l, 'a', 13), 'a', null).sizes, {});
});
