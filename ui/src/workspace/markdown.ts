// Markdown as an agent writes it, read into plain data (markdown.test.ts) that the preview draws in the type roles
// (preview.tsx). Small on purpose: headings, paragraphs, lists (also numbered, nested and with boxes to tick), quotes,
// fenced and indented code, rules, tables; and in a line: code, strong and emphasised words, links and pictures (as
// links to them), and bare web addresses. Nothing here makes markup: what is not one of these, raw HTML first of all,
// stays the text it is, and the preview shows it as text.

export type Inline = string | { t: 'code'; s: string } | { t: 'b' | 'i'; s: Inline[] } | { t: 'a'; to: string; s: Inline[] };
export type Item = { s: Inline[]; depth: number; done?: boolean };
export type Block =
  | { t: 'h'; n: number; s: Inline[] }
  | { t: 'p'; s: Inline[] }
  | { t: 'code'; s: string }
  | { t: 'ul' | 'ol'; items: Item[]; from: number }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'hr' }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] };

// In a line, first match wins at each place: an escape, code, a picture or a link, an address in angle brackets, a
// bare address, then strong and emphasised words.
const INLINE = /\\([\\`*_{}[\]()#+\-.!|<>~])|(`+)(.+?)\2(?!`)|!?\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<(https?:\/\/[^\s<>]+)>|(https?:\/\/[^\s<>"'`]+)|(\*\*|__)(?=\S)(.+?)(?<=\S)\8|(?<![\p{L}\p{N}])([*_])(?=\S)(.+?)(?<=\S)\10(?![\p{L}\p{N}])/gu;

/** The parts of a line. */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  const say = (s: string) => (typeof out.at(-1) === 'string' ? (out[out.length - 1] += s) : s && out.push(s));
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    say(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] !== undefined) say(m[1]);
    else if (m[2]) out.push({ t: 'code', s: m[3]!.trim() || m[3]! });
    else if (m[5]) out.push({ t: 'a', to: m[5], s: inline(m[4] || m[5]) });
    else if (m[6]) out.push({ t: 'a', to: m[6], s: [m[6]] });
    else if (m[7]) {
      // An address without what only ends its sentence.
      const url = m[7].replace(/[.,;:!?)\]]+$/, '');
      out.push({ t: 'a', to: url, s: [url] });
      at -= m[7].length - url.length;
    } else if (m[8]) out.push({ t: 'b', s: inline(m[9]!) });
    else out.push({ t: 'i', s: inline(m[11]!) });
  }
  say(text.slice(at));
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/, RULE = /^ {0,3}([-*_])( *\1){2,} *$/, HEAD = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/, QUOTE = /^ {0,3}> ?/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/, ROW = /^\s*\|.*\|\s*$/, DIVIDES = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, '|')));

/** The blocks of a text. */
export function parse(text: string, depth = 0): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n'), out: Block[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!, fence = FENCE.exec(line), head = HEAD.exec(line), item = LIST.exec(line);
    if (!line.trim()) i++;
    else if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !(lines[i]!.trim().startsWith(fence[1]!) && /^[`~\s]*$/.test(lines[i]!)); i++) body.push(lines[i]!);
      i++;
      out.push({ t: 'code', s: body.join('\n') });
    } else if (/^( {4}|\t)/.test(line) && out.at(-1)?.t !== 'p') {
      const body: string[] = [];
      for (; i < lines.length && (/^( {4}|\t)/.test(lines[i]!) || !lines[i]!.trim()); i++) body.push(lines[i]!.replace(/^( {4}|\t)/, ''));
      out.push({ t: 'code', s: body.join('\n').trimEnd() });
    } else if (RULE.test(line)) (out.push({ t: 'hr' }), i++);
    else if (head) (out.push({ t: 'h', n: head[1]!.length, s: inline(head[2]!) }), i++);
    else if (QUOTE.test(line) && depth < 8) {
      const body: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]!); i++) body.push(lines[i]!.replace(QUOTE, ''));
      out.push({ t: 'quote', blocks: parse(body.join('\n'), depth + 1) });
    } else if (ROW.test(line) && DIVIDES.test(lines[i + 1] ?? '')) {
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && ROW.test(lines[i]!); i++) rows.push(cells(lines[i]!));
      out.push({ t: 'table', head: cells(line), rows });
    } else if (item) {
      // A list runs while its lines are items, or belong to the item before them: indented, or with no line between.
      const kind = /\d/.test(item[2]!) ? 'ol' : 'ul', items: Item[] = [], first = item[1]!.length;
      for (; i < lines.length; i++) {
        const m = LIST.exec(lines[i]!), last = items.at(-1);
        if (m && /\d/.test(m[2]!) !== (kind === 'ol') && m[1]!.length <= first) break;
        if (m) {
          const box = /^\[([ xX])\]\s+(.*)$/.exec(m[3]!);
          items.push({ s: inline(box ? box[2]! : m[3]!), depth: Math.min(6, Math.max(0, Math.floor((m[1]!.length - first) / 2))), ...(box && { done: box[1] !== ' ' }) });
        } else if (last && lines[i]!.trim() && !FENCE.test(lines[i]!) && !HEAD.test(lines[i]!) && (/^\s/.test(lines[i]!) || lines[i - 1]!.trim())) last.s.push(...inline(' ' + lines[i]!.trim()));
        else if (!lines[i]!.trim() && LIST.test(lines[i + 1] ?? '')) continue;
        else break;
      }
      out.push({ t: kind, items, from: kind === 'ol' ? Number.parseInt(item[2]!, 10) : 1 });
    } else {
      const body: string[] = [];
      for (; i < lines.length && lines[i]!.trim() && !FENCE.test(lines[i]!) && !HEAD.test(lines[i]!) && !RULE.test(lines[i]!) && !QUOTE.test(lines[i]!) && !(body.length && LIST.test(lines[i]!)); i++)
        body.push(lines[i]!.trim());
      out.push({ t: 'p', s: inline(body.join(' ')) });
    }
  }
  return out;
}

const words = (a: Inline[]): string => a.map((x) => (typeof x === 'string' ? x : x.t === 'code' ? x.s : words(x.s))).join('');
/** The first line of a Markdown text as plain words: its list or heading mark gone, and the marks of emphasis, code and
 *  links reduced to what they hold. */
export const firstLine = (text: string) => words(inline((text.split('\n').find((l) => l.trim()) ?? '').trim().replace(/^(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, '')));
