// What in a terminal's text can be opened (links.ts): addresses, paths with a line and a column, what must not be
// taken for either, a program's own hyperlinks, and where a find is on a screen whose lines wrap.
import assert from 'node:assert/strict';
import test from 'node:test';
import { find, lineAt, pointsAt, range } from './links.ts';

const found = (text: string) => find(text).map((f) => [f.kind, text.slice(f.start, f.end), f.target, f.line, f.col].filter((x) => x !== undefined));
const targets = (text: string) => find(text).map((f) => f.target);

test('web addresses are found whole, without the punctuation of the sentence around them', () => {
  assert.deepEqual(found('see https://example.com/docs/a?b=1&c=2#top for more'), [['web', 'https://example.com/docs/a?b=1&c=2#top', 'https://example.com/docs/a?b=1&c=2#top']]);
  assert.deepEqual(targets('Local: http://localhost:5173/, press h'), ['http://localhost:5173/']);
  assert.deepEqual(targets('It is at https://example.com/a.'), ['https://example.com/a']);
  assert.deepEqual(targets('(https://example.com/a), "https://example.com/b"; <https://example.com/c>'), ['https://example.com/a', 'https://example.com/b', 'https://example.com/c']);
  assert.deepEqual(targets('https://en.wikipedia.org/wiki/Cue_(theatre) and https://example.com/x_(y))'), ['https://en.wikipedia.org/wiki/Cue_(theatre)', 'https://example.com/x_(y)']);
  assert.deepEqual(targets('HTTPS://EXAMPLE.COM/A https://example.com/ü/é'), ['HTTPS://EXAMPLE.COM/A', 'https://example.com/ü/é']);
  // An address is one link: nothing in it is taken for a path.
  assert.deepEqual(targets('https://example.com/src/timer.css:42'), ['https://example.com/src/timer.css:42']);
  assert.deepEqual(targets('https:// and http://. are no addresses'), []);
});

test('paths are found alone and with a line and a column, as compilers and agents print them', () => {
  assert.deepEqual(found('error at src/rehearsal/Timer.tsx:142:7: unexpected token'), [['path', 'src/rehearsal/Timer.tsx:142:7', 'src/rehearsal/Timer.tsx', 142, 7]]);
  assert.deepEqual(found('  --> core/src/route.rs:518'), [['path', 'core/src/route.rs:518', 'core/src/route.rs', 518]]);
  assert.deepEqual(found('● Update(src/rehearsal/timer.css)'), [['path', 'src/rehearsal/timer.css', 'src/rehearsal/timer.css']]);
  assert.deepEqual(targets('modified:   README.md and Cargo.toml, .gitignore too'), ['README.md', 'Cargo.toml', '.gitignore']);
  assert.deepEqual(targets('/Users/example/projects/cuegrid/package.json ~/notes/todo.md ./run.sh ../shared/lib'), ['/Users/example/projects/cuegrid/package.json', '~/notes/todo.md', './run.sh', '../shared/lib']);
  assert.deepEqual(targets('node_modules/@xterm/xterm/lib/xterm.js'), ['node_modules/@xterm/xterm/lib/xterm.js']);
  assert.deepEqual(found('src/a.ts:12:3:'), [['path', 'src/a.ts:12:3', 'src/a.ts', 12, 3]]);
  // The stop that ends a sentence is not the file's, and then no line follows it.
  assert.deepEqual(found('I changed src/a.ts. Then tests.'), [['path', 'src/a.ts', 'src/a.ts']]);
  assert.deepEqual(found('grep: src/a.ts:12:const x = 1'), [['path', 'src/a.ts:12', 'src/a.ts', 12]]);
  assert.deepEqual(found('`src/a.ts` "src/b.ts" [src/c.ts]').map((f) => f[2]), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.deepEqual(targets('Bühne/Größe.txt'), ['Bühne/Größe.txt']);
});

test('what is no path is not taken for one', () => {
  for (const text of [
    'Ran 58 tests in 12.4s', 'v2.1.326 and 0.169.0', 'at 12:30:45 on 2026/11/18 or 18.11.2026', 'foo::bar::baz()', 'error: expected one of 3', 'a 1/2 or 3/4 share',
    '--flag=value -x', 'person@example.com', 'e.g. this, i.e. that', 'Done.', 'ftp://example.com/file', 'x-apple.systempreferences://general', '+14 −3', '100%',
  ]) assert.deepEqual(targets(text), [], text);
});

test('a hyperlink a program printed points at a web address or a file, and at nothing else', () => {
  assert.deepEqual(pointsAt('https://example.com/a?b'), { kind: 'web', target: 'https://example.com/a?b' });
  assert.deepEqual(pointsAt('file://host.local/Users/example/My%20Notes/a.md'), { kind: 'path', target: '/Users/example/My Notes/a.md' });
  assert.deepEqual(pointsAt('file:///Users/example/a.md'), { kind: 'path', target: '/Users/example/a.md' });
  for (const uri of ['javascript:alert(1)', 'x-apple.systempreferences://general', 'vscode://file/etc/passwd', 'mailto:person@example.com', 'file:///', 'not an address', ''])
    assert.equal(pointsAt(uri), null, uri);
});

test('a find is placed on the screen across wrapped rows and wide characters', () => {
  const cell = (c: string, w = 1) => ({ getChars: () => c, getWidth: () => w });
  const row = (s: string, wrapped = false) => ({ isWrapped: wrapped, getCell: (x: number) => [...s].flatMap((c) => (c === '表' ? [cell(c, 2), cell('', 0)] : [cell(c)]))[x] });
  const rows = [row('ok'), row('see src/reh'), row('earsal/a.ts', true), row(':12 now', true), row('表 src/b.ts')];
  const buffer = { getLine: (y: number) => rows[y] };
  // Asked for any of its three rows, a wrapped line is the same line.
  for (const y of [1, 2, 3]) assert.equal(lineAt(buffer, y, 11).text, 'see src/rehearsal/a.ts:12 now');
  const { text, cells } = lineAt(buffer, 2, 11), f = find(text)[0]!;
  assert.deepEqual([f.target, f.line], ['src/rehearsal/a.ts', 12]);
  assert.deepEqual(range(cells, f.start, f.end), { start: { x: 5, y: 2 }, end: { x: 3, y: 4 } });
  // A wide character takes two cells: what follows it is two columns on.
  const wide = lineAt(buffer, 4, 11), g = find(wide.text)[0]!;
  assert.deepEqual(range(wide.cells, g.start, g.end), { start: { x: 4, y: 5 }, end: { x: 11, y: 5 } });
  assert.equal(lineAt(buffer, 0, 11).text, 'ok');
});
