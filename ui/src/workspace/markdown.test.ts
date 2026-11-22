import assert from 'node:assert/strict';
import test from 'node:test';
import { type Block, type Inline, firstLine, inline, lines, parse, plain } from './markdown.ts';

/** A line's parts back as one string, with what each is: `b(…)`, `i(…)`, `code(…)`, `a(text→target)`. */
const flat = (s: Inline[]): string => s.map((x) => (typeof x === 'string' ? x : x.t === 'code' ? `code(${x.s})` : x.t === 'a' ? `a(${flat(x.s)}→${x.to})` : `${x.t}(${flat(x.s)})`)).join('');
const kinds = (b: Block[]) => b.map((x) => x.t).join(' ');

test('a line: code, strong, emphasis, links, pictures and bare addresses', () => {
  assert.equal(flat(inline('Run `npm test` and **all of it**, *now*.')), 'Run code(npm test) and b(all of it), i(now).');
  assert.equal(flat(inline('See [the report](out/report.html) and ![a chart](chart.png "Chart").')), 'See a(the report→out/report.html) and a(a chart→chart.png).');
  assert.equal(flat(inline('Open http://localhost:5173/, then <https://example.com/a?b=1>.')), 'Open a(http://localhost:5173/→http://localhost:5173/), then a(https://example.com/a?b=1→https://example.com/a?b=1).');
  assert.equal(flat(inline('a_b_c and snake_case_name stay, _this_ does not')), 'a_b_c and snake_case_name stay, i(this) does not');
  assert.equal(flat(inline('2 * 3 * 4 and \\*not this\\*')), '2 * 3 * 4 and *not this*');
  assert.equal(flat(inline('``a ` b`` and **bold `code`**')), 'code(a ` b) and b(bold code(code))');
});

test('raw HTML is text, and nothing else', () => {
  const html = '<script>alert(1)</script> <img src=x onerror=alert(1)> <a href="javascript:alert(1)">x</a>';
  assert.deepEqual(inline(html), [html]);
  assert.deepEqual(parse(`<div onclick="x()">\n${html}\n</div>`), [{ t: 'p', s: [`<div onclick="x()"> ${html} </div>`] }]);
  // A link keeps whatever it names: what may be opened is the rule's to say, never the text's.
  assert.equal(flat(inline('[x](javascript:alert(1))')), 'a(x→javascript:alert(1))');
});

test('blocks: headings, paragraphs, code, rules, quotes', () => {
  const b = parse('# Title\n\nFirst line\nsecond line.\n\n```ts\nconst a = 1;\n\n<b>x</b>\n```\n\n---\n\n> Quoted\n> **twice**\n\n    indented\n\n## Next ##');
  assert.equal(kinds(b), 'h p code hr quote code h');
  assert.deepEqual(b[0], { t: 'h', n: 1, s: ['Title'] });
  assert.deepEqual(b[1], { t: 'p', s: ['First line second line.'] });
  assert.deepEqual(b[2], { t: 'code', s: 'const a = 1;\n\n<b>x</b>' });
  assert.deepEqual(b[4], { t: 'quote', blocks: [{ t: 'p', s: ['Quoted ', { t: 'b', s: ['twice'] }] }] });
  assert.deepEqual(b[5], { t: 'code', s: 'indented' });
  assert.deepEqual(b[6], { t: 'h', n: 2, s: ['Next'] });
  // A fence that never closes holds the rest, and nothing is lost.
  assert.deepEqual(parse('```\nopen\n# not a heading'), [{ t: 'code', s: 'open\n# not a heading' }]);
});

test('lists: plain, numbered, nested, with boxes; and what follows them', () => {
  const [ul, ol, p] = parse('- one\n- two\n  - under two\n  continued\n- [x] done\n- [ ] to do\n\n3. three\n4) four\n\nAfter.');
  assert.deepEqual(ul, { t: 'ul', from: 1, items: [
    { s: ['one'], depth: 0 }, { s: ['two'], depth: 0 }, { s: ['under two', ' continued'], depth: 1 }, { s: ['done'], depth: 0, done: true }, { s: ['to do'], depth: 0, done: false },
  ] });
  assert.deepEqual(ol, { t: 'ol', from: 3, items: [{ s: ['three'], depth: 0 }, { s: ['four'], depth: 0 }] });
  assert.deepEqual(p, { t: 'p', s: ['After.'] });
  assert.equal(kinds(parse('Words\n- item\n\n# Head')), 'p ul h');
});

test('tables, with a bar inside a cell', () => {
  const [t, p] = parse('| File | Lines |\n| --- | ---: |\n| `a.ts` | 12 |\n| b \\| c | **3** |\nNot a row');
  if (t?.t !== 'table') throw new Error('the bars were not read as a table');
  assert.deepEqual(t.head.map(flat), ['File', 'Lines']);
  assert.deepEqual(t.rows.map((r) => r.map(flat)), [['code(a.ts)', '12'], ['b | c', 'b(3)']]);
  assert.deepEqual(p, { t: 'p', s: ['Not a row'] });
  // Bars with no line of dashes under them are words.
  assert.equal(kinds(parse('| a | b |\n| c | d |')), 'p');
});

test('a large file is read in a time that does not grow with its square', () => {
  const big = '- item with **strong** `code` and [a link](x.md) and _more_\n'.repeat(20000) + '*'.repeat(5000) + '['.repeat(5000);
  const began = performance.now();
  const blocks = parse(big);
  assert.ok(blocks.length >= 1 && performance.now() - began < 2000, `${Math.round(performance.now() - began)} ms`);
});

test('the first line of an answer as plain words', () => {
  assert.equal(firstLine('**Test Witness** passed, see `npm test`.\nMore.'), 'Test Witness passed, see npm test.');
  assert.equal(firstLine('\n## Done: [the report](out/report.html)'), 'Done: the report');
  assert.equal(firstLine('- *two* files changed'), 'two files changed');
  assert.equal(firstLine(''), '');
});

test('a whole answer as plain words in one run', () => {
  assert.equal(plain('**Test Witness** passes.\n\nFiles changed: `4`.'), 'Test Witness passes. Files changed: 4.');
});

test('an answer as the words of its lines, each with how it is set', () => {
  const l = lines('**Test** passes, run `npm test`.\n\n- one\n- *two* files\n1. first');
  assert.deepEqual(l[0]!.map((w) => `${w.s}|${w.k ?? ''}|${w.sp ? 1 : 0}`), ['Test|b|0', 'passes,||1', 'run||1', 'npm|code|1', 'test|code|1', '.||0']);
  assert.deepEqual(l.slice(1).map((r) => r.map((w) => w.s).join(' ')), ['• one', '• two files', '1. first']);
  assert.deepEqual(lines('a  b\n\nc', false).map((r) => r.map((w) => w.s)), [['a', 'b'], ['c']]);
  assert.ok(lines('word '.repeat(500)).flat().length <= 161);
});
