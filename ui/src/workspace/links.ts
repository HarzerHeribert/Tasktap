// What in a terminal's text can be opened, as plain functions (links.test.ts): web addresses, and what may be a file's
// path, alone or with a line and a column as compilers and agents print them (`src/a.ts:12:3`). Whether a path exists,
// and whether it may be opened at all, is the host's to say (`host.open`); here it is only found. Also the whole line a
// row of the screen is part of, across its wraps, with the cell of every character, and what a hyperlink a program
// printed itself (OSC 8) points at.

export type Found = { start: number; end: number; kind: 'web' | 'path'; target: string; line?: number; col?: number };

const WEB = /https?:\/\/[^\s<>"'`\\^{}|]+/gi;
const TOKEN = /[\p{L}\p{N}_@%+=~./-]+/gu;
const AT = /:(\d+)(?::(\d+))?/y;
const count = (s: string, c: string) => s.split(c).length - 1;

/** An address without what only ends the sentence it stands in: a stop, a comma, a quote, and a closing bracket whose
 *  opening one is not part of it. */
function address(url: string) {
  for (;;) {
    const last = url.at(-1)!, opens = '([{<'[')]}>'.indexOf(last)];
    if ('.,;:!?\'"*'.includes(last) || (opens && count(url, opens) < count(url, last))) url = url.slice(0, -1);
    else return url;
  }
}

/** Whether words between spaces read as a path: something with a letter in it that has a folder in it, or is a file's
 *  name with an extension. Not a number, a version, a time, a date, an option, or an address of mail. */
function pathLike(t: string) {
  if (!/\p{L}/u.test(t) || t.includes('//') || /^[-+=%]/.test(t)) return false;
  if (t.includes('/')) return !/^[\d/.-]+$/.test(t);
  if (t.includes('@') || /^\p{L}\.\p{L}$/u.test(t)) return false;
  return /^\.?[\p{L}\p{N}_+-][\p{L}\p{N}_.+-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/u.test(t) || /^\.[\p{L}][\p{L}\p{N}_-]+$/u.test(t);
}

/** The addresses and the candidates for paths in a line of text, in their order. */
export function find(text: string): Found[] {
  const found: Found[] = [];
  let rest = text;
  for (const m of text.matchAll(WEB)) {
    const url = address(m[0]);
    if (url.length <= m[0].indexOf('://') + 3) continue;
    found.push({ start: m.index, end: m.index + url.length, kind: 'web', target: url });
    // An address is not looked through for paths.
    rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length);
  }
  for (const m of rest.matchAll(TOKEN)) {
    const path = m[0].replace(/[.]+$/, '');
    if (!pathLike(path)) continue;
    let end = m.index + path.length, line: number | undefined, col: number | undefined;
    AT.lastIndex = end;
    const at = path.length === m[0].length ? AT.exec(rest) : null;
    if (at) (end += at[0].length), (line = Number(at[1])), (col = at[2] ? Number(at[2]) : undefined);
    found.push({ start: m.index, end, kind: 'path', target: path, ...(line !== undefined && { line }), ...(col !== undefined && { col }) });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** What a hyperlink a program printed points at: a web address, or the file of a `file:` address. Anything else is
 *  nothing Tasktap opens. */
export function pointsAt(uri: string): Pick<Found, 'kind' | 'target'> | null {
  try {
    const u = new URL(uri);
    if (u.protocol === 'http:' || u.protocol === 'https:') return { kind: 'web', target: uri };
    if (u.protocol === 'file:' && u.pathname.length > 1) return { kind: 'path', target: decodeURIComponent(u.pathname) };
  } catch {
    // Not an address at all.
  }
  return null;
}

type Cell = { getChars(): string; getWidth(): number };
type Line = { isWrapped: boolean; getCell(x: number): Cell | undefined };
type Buffer = { getLine(y: number): Line | undefined };
/** Where one UTF-16 unit of a line's text is on the screen: its column and row from 0, and how many cells wide. */
export type At = [x: number, y: number, w: number];

/** The whole line that row `y` (from 0) is part of, across its wraps, without the room after its last word; and for
 *  each unit of that text its cell. */
export function lineAt(buffer: Buffer, y: number, cols: number): { text: string; cells: At[] } {
  let first = y;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let text = '';
  const cells: At[] = [];
  for (let row = first, line = buffer.getLine(row); line && (row === first || line.isWrapped); line = buffer.getLine(++row)) {
    for (let x = 0; x < cols; x++) {
      const cell = line.getCell(x), w = cell?.getWidth() ?? 1;
      if (!w) continue;
      const chars = cell?.getChars() || ' ';
      text += chars;
      for (let i = 0; i < chars.length; i++) cells.push([x, row, w]);
    }
  }
  const end = text.trimEnd().length;
  return { text: text.slice(0, end), cells: cells.slice(0, end) };
}

/** The cells from unit `start` to before unit `end`, as xterm.js counts a range: columns and rows from 1, the end included. */
export function range(cells: At[], start: number, end: number) {
  const a = cells[start]!, b = cells[end - 1]!;
  return { start: { x: a[0] + 1, y: a[1] + 1 }, end: { x: b[0] + b[2], y: b[1] + 1 } };
}
