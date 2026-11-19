// The rule for every list in both pages: within a list, every row uses the same columns. Leading marks share one
// column and are centred in it; labels share one left edge; secondary text shares one left edge; a mark and its label
// sit on one centred line. This renders the pages from ui/dist on fixture records (instrument-fixtures.cjs), in each
// state and with every list open, measures the parts of sibling rows, and fails on any difference over half a pixel.
// It also holds the page to what else is promised of its composition: the Composer centred over the lists under it
// (and, before a folder is open, a little above the middle with its one action on its own edges), a key's label at
// 7 : 1 or better on its face, the agents' rings in each of their states, no scroller showing a bar, and a wake that
// lies behind the edge that sheds it. Every key shown, on a cap or as a hint, in every state of both pages: at the
// key role's size or larger, at 4.5 : 1 or better on what is behind it, its modifiers in a Mac's order, and whole
// (a hint a row has no room for is gone, never cut). Every sheet: centred on the window and hung from the title bar's
// lower edge, with the sidebar open, closed and on its way, at four widths of window; it sheds no wake, and the
// ambient layer rests behind it. And the collapsed notch: on a display without a camera cutout whatever its tab
// draws is centred on the tab's own centre line and height, in every state; with a cutout its two halves keep the same
// distance from the tab's outer edges and stay clear of the camera, and the line under it is centred. The open notch's
// head row keeps equal insets and one centre line.
// And the rule for what stands in a row, measured in every state of the window at 1x and 2x (and, through
// scripts/text-sizes.sh, at the three text sizes): one weight (every stroke of an icon and of a session's seat is as wide
// on the screen as the token --i-w says at that text size, whatever size its box is shown at); one centre line (what
// leads a row is centred on the capital letters of the words it leads, within a pixel); one baseline (words of
// different sizes on one line of a row stand on it); and figures in the monospace face or tabular, their right edges
// on one line down a list.
// usage: node scripts/align-check.cjs [--dist folder]   (exit status 1 on a failure; ui/dist must be built)
const path = require('node:path');
const { serve, open, scaled } = require('./motion-pages.cjs');
const { scene, flow } = require('./instrument-fixtures.cjs');

// Lists: the rows that are siblings, and the parts of a row whose edges must agree.
const LISTS = [
  { list: '.hrs', row: ':scope > .hr.run', parts: { mark: '.st', label: '.hr-t', fact: '.hr-m', time: 'time' } },
  { list: '.hrs', row: ':scope > .hr.res', parts: { mark: '.st', label: '.hr-t', fact: '.hr-m', time: 'time' } },
  { list: '.hrs', row: ':scope > .hr.later', parts: { mark: '.st', label: '.hr-t', fact: '.hr-m', time: 'time' } },
  { list: '.hrs', row: ':scope > .hr.ask', parts: { mark: '.st', label: '.hr-t', fact: '.hr-m', time: 'time' } },
  { list: '.folds', row: ':scope > .fold > .fold-h', parts: { mark: '.i', name: 'b', count: '.fold-c', time: 'time' } },
  { list: '.list', row: ':scope > .line', parts: { mark: '.ring-o, :scope > .i', label: '.t', fact: '.x' } },
  { list: '.sx', row: ':scope > .tn', parts: { time: 'time', label: '.tn-t' } },
  { list: '.ws', row: ':scope > .row.s', parts: { mark: '.st', label: '.lbl' } },
  { list: '.tree', row: ':scope > .row.home, :scope > .ws > .row.w', parts: { label: '.lbl' } },
  { list: '.choices', row: ':scope > .act', parts: { key: 'kbd', label: 'span' } },
  { list: '.set-pane, .terms', row: ':scope > .set', parts: { label: '.t', fact: '.c' } },
  { list: '.set-nav', row: ':scope > button', parts: { label: 'span', fact: 'kbd' } },
  { list: '.files', row: ':scope > .file', parts: { mark: '.ch', label: '.path' } },
  { list: '.cap-list', row: ':scope > button', parts: { mark: '.i, .st', label: 'span' } },
  { list: '.rows', row: ':scope > .row', parts: { mark: '.st', label: '.t', fact: '.x', time: 'time' } },
  { list: '.ask-notch .qa', row: ':scope > .ans', parts: { key: 'kbd', label: 'span' } },
  { list: '.ask-home .qa', row: ':scope > .ans', parts: { key: 'kbd' } },
  { list: '.ways', row: ':scope > .way', parts: { mark: '.way-h > .i, .way-h > .st', label: '.way-h > b' } },
];

function audit([LISTS, KEY]) {
  const bad = [], seen = new Set();
  const box = (el) => el.getBoundingClientRect();
  for (const L of LISTS)
    for (const list of document.querySelectorAll(L.list)) {
      const rows = [...list.querySelectorAll(L.row)].filter((r) => r.offsetParent);
      if (rows.length < 2) continue;
      seen.add(`${L.row.replace(/:scope > /g, '')} ×${rows.length}`);
      for (const [name, sel] of Object.entries(L.parts)) {
        const edges = rows.map((r) => {
          const p = r.querySelector(sel);
          if (!p || !p.offsetParent) return null;
          const b = box(p), rb = box(r);
          // A mark or a key cap is placed by its centre; anything else by its left edge. Both against the row.
          return name === 'mark' || name === 'key' ? Math.round((b.left + b.width / 2 - rb.left) * 2) / 2 : Math.round((b.left - rb.left) * 2) / 2;
        });
        const at = edges.filter((e) => e !== null);
        if (at.length > 1 && Math.max(...at) - Math.min(...at) > 0.5)
          bad.push(`${L.row.replace(':scope > ', '')} in ${list.className.split(' ')[0] || list.tagName}: ${name} at ${[...new Set(at)].join(', ')}`);
      }
      // A mark and its label sit on one centred line.
      for (const r of rows) {
        const m = r.querySelector(L.parts.mark ?? L.parts.key ?? ':not(*)'), t = r.querySelector(L.parts.label ?? ':not(*)');
        if (!m || !t || !m.offsetParent || !t.offsetParent) continue;
        const [a, b] = [box(m), box(t)];
        const d = Math.abs(a.top + a.height / 2 - (b.top + b.height / 2));
        if (d > 1.5) bad.push(`${L.row.replace(':scope > ', '')}: mark and label ${d.toFixed(1)} px off one line ("${t.textContent.trim().slice(0, 30)}")`);
      }
    }
  // An icon and its label, a key cap and its word, a wave and what it says: each pair on one centred line.
  // (A sheet's foot may wrap where it has no room for one line: its answer then stands a whole line under the rest.)
  for (const [within, a, b, wraps] of [
    ['.mic', '.i', 'kbd'], ['.ring[aria-checked=true]', '.ring-o', '.nm'], ['.way-h', ':scope > .i, :scope > .st', ':scope > b'], ['.way-h', '.act kbd', '.act span'],
    ['.way-h', ':scope > b', ':scope > .btn span'], ['.cap-row.hear', '.lvl, .st', 'b'], ['.cap-row.hear', 'b', '.act span'], ['.ans', '.i', 'span'], ['.disc', '.i', 'span'],
    ['.cap-said', ':scope > span', '.btn'], ['.reply', '.lvl', 'input'], ['.line.tool', '.ring-o', '.t'],
    ['.sh-f .act', 'kbd', 'span'], ['.sh-f .key', '.i', 'span'], ['.sh-f', '.act span', '.key span', true], ['.newt', 'span', 'kbd'], ['.attach .lg', 'span', 'kbd'], ['.set', 'kbd.keycap', '.t'],
  ])
    for (const el of document.querySelectorAll(within)) {
      const [m, t] = [el.querySelector(a), el.querySelector(b)];
      if (!m || !t || !m.offsetParent || !t.offsetParent || box(t).height > 30) continue;
      seen.add(`${within} pairs`);
      const d = Math.abs(box(m).top + box(m).height / 2 - (box(t).top + box(t).height / 2));
      if (d > 1.5 && !(wraps && box(t).top >= box(m).bottom)) bad.push(`${within}: ${a} and ${b} are ${d.toFixed(1)} px off one line`);
    }
  // What the person reads before a thought starts, and what a failure says, is whole: nothing in it is cut short.
  for (const el of document.querySelectorAll('.way-b, .way-w, .way-n, .way-h > b, .q-detail, .terms li, .terms p, .cap-said > span, #dest-chip b')) {
    if (!el.offsetParent) continue;
    seen.add('whole text');
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) bad.push(`"${el.textContent.trim().slice(0, 40)}" is cut short (${el.className || el.tagName})`);
  }
  // In the Composer and what is under it, one key at most is metal, and one thing at most says Start.
  for (const c of document.querySelectorAll('.capture')) {
    const keys = [...c.querySelectorAll('.key:not(:disabled)')].filter((k) => k.offsetParent);
    if (keys.length > 1) bad.push(`${keys.length} metal keys in the Composer: ${keys.map((k) => k.textContent.trim()).join(', ')}`);
    const starts = [...c.querySelectorAll('button')].filter((b) => b.offsetParent && b.textContent.trim() === 'Start');
    if (starts.length > 1) bad.push(`Start is said ${starts.length} times in the Composer`);
  }
  // The composition. The Composer is centred on the lists under it, in one column or two.
  const mid = (el) => box(el).left + box(el).width / 2, cap = document.querySelector('.home .capture.raised .cap'), cols = document.querySelector('.hx .cols');
  if (cap && cols && Math.abs(mid(cap) - mid(cols)) > 0.5) bad.push(`the Composer is ${(mid(cap) - mid(cols)).toFixed(1)} px off the centre of the lists under it`);
  // Before a folder is open: a little above the middle of the content, its one action and what was saved on its edges.
  const first = document.querySelector('.hx.first'), home = document.querySelector('.home');
  if (first && cap) {
    const c = box(cap), h = box(home), at = (c.top + c.height / 2 - h.top) / h.height;
    if (h.height >= 500 && (at < 0.3 || at > 0.5)) bad.push(`first run: the Composer's middle is at ${at.toFixed(2)} of the content's height`);
    const key = first.querySelector('.attach .lg'), go = cap.querySelector('.cap-row .key'), words = first.querySelector('.attach span');
    if (!key || Math.abs(box(key).right - box(go).right) > 0.5) bad.push('first run: Open a folder is not on the edge of the Composer\'s key');
    if (words?.offsetParent && Math.abs(box(words).left - box(cap.querySelector('textarea')).left - 10) > 0.5) bad.push('first run: the line under the Composer is not on its text\'s edge');
    for (const row of first.querySelectorAll('.hsec')) if (Math.abs(box(row).left - c.left) > 0.5 || Math.abs(box(row).right - c.right) > 0.5) bad.push('first run: For later is not on the Composer\'s edges');
  }
  // A key's label on its face: 7 : 1 or better against every stop of the face.
  const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  for (const k of document.querySelectorAll('.key:not(:disabled), kbd.keycap')) {
    if (!k.offsetParent) continue;
    const s = getComputedStyle(k), face = s.backgroundImage.slice(s.backgroundImage.lastIndexOf('linear-gradient')).match(/rgba?\([^)]+\)/g) ?? [], ink = lum(s.color);
    const least = Math.min(...face.map((c) => { const l = lum(c); return (Math.max(l, ink) + 0.05) / (Math.min(l, ink) + 0.05); }));
    if (!(least >= 7)) bad.push(`a key's label is at ${least.toFixed(1)} : 1 on its face ("${k.textContent.trim().slice(0, 20)}")`);
    seen.add('keys');
  }
  // No scroller shows a bar; each that has more beyond an edge says which.
  for (const el of document.querySelectorAll('*')) {
    const s = getComputedStyle(el);
    if (!/auto|scroll/.test(s.overflowY + s.overflowX)) continue;
    const bar = el.offsetWidth - el.clientWidth - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth), barH = el.offsetHeight - el.clientHeight - parseFloat(s.borderTopWidth) - parseFloat(s.borderBottomWidth);
    if (bar > 0.5 || barH > 0.5) bad.push(`a scrollbar shows on .${el.className || el.tagName}`);
    if (el.scrollHeight > el.clientHeight + 1 && el.matches('.home, .tree, .sh-b, .set-pane') && !/up|down/.test(el.dataset.more ?? '')) bad.push(`.${el.className} scrolls and does not say which way there is more`);
    if (el.scrollHeight > el.clientHeight + 1) seen.add('scrollers');
  }
  // Every key shown, on a cap or as a hint: no smaller than the key role, readable on what is behind it, its modifiers
  // in a Mac's order, and whole. What is behind it: every colour and gradient stop under it, down to the first that
  // is opaque, each laid over the ones below; the least contrast counts.
  const rgba = (c) => { const [r, g, b, a = 1] = c.match(/[\d.]+/g).map(Number); return [r, g, b, a]; };
  const over = ([r, g, b, a], [R, G, B]) => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
  const behind = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      // Of its pictures, those that cover it: an edge a pixel or two wide is beside the key, not behind it.
      const s = getComputedStyle(e), c = rgba(s.backgroundColor), sizes = s.backgroundSize.split(', ');
      const pictures = [];
      for (let i = 0, depth = 0, from = 0; i <= s.backgroundImage.length; i++) {
        const ch = s.backgroundImage[i];
        depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
        if (i === s.backgroundImage.length || (ch === ',' && !depth)) (pictures.push(s.backgroundImage.slice(from, i).trim()), (from = i + 1));
      }
      const faces = pictures.filter((g, i) => g.includes('gradient') && (sizes[i] ?? sizes[0]) === 'auto').map((g) => g.match(/rgba?\([^)]+\)/g).map(rgba));
      layers.push(...faces);
      if (c[3] > 0) layers.push([c]);
      if (c[3] === 1 || faces.some((g) => g.every((x) => x[3] === 1))) break;
    }
    return layers.reverse().reduce((under, layer) => under.flatMap((u) => layer.map((x) => over(x, u))), [[10, 10, 11, 1]]);
  };
  for (const k of document.querySelectorAll('kbd')) {
    const b = box(k);
    if (!b.width || !k.offsetParent) continue;
    // A hint its button has no room for has wrapped out of it: wholly gone, which is the rule. Cut in part is a fault.
    const within = k.closest('button'), clips = within && getComputedStyle(within).overflow !== 'visible' ? [box(within)] : [];
    if (clips.some((c) => b.top >= c.bottom - 0.5 || b.left >= c.right - 0.5)) continue;
    const name = `the key "${k.textContent.trim() || '↩'}"${k.closest('[class]:not(kbd)') ? ` in .${k.closest('[class]:not(kbd)').className.split(' ')[0]}` : ''}`;
    seen.add('key hints');
    if (clips.some((c) => b.left < c.left - 0.5 || b.right > c.right + 0.5 || b.top < c.top - 0.5 || b.bottom > c.bottom + 0.5) || k.scrollWidth > k.clientWidth + 1) bad.push(`${name} is cut`);
    const s = getComputedStyle(k);
    if (parseFloat(s.fontSize) < KEY.size || Number(s.fontWeight) < KEY.weight || !s.fontFamily.startsWith('system-ui')) bad.push(`${name} is set in ${s.fontWeight} ${s.fontSize} ${s.fontFamily.split(',')[0]}, under the key role (${KEY.weight} ${KEY.size}px)`);
    if (!/^⌃?⌥?⇧?⌘?[^⌃⌥⇧⌘]*$/.test(k.textContent)) bad.push(`${name} does not put its modifiers in the order ⌃⌥⇧⌘`);
    const ink = rgba(s.color), least = Math.min(...behind(k).map((u) => { const [a, c] = [lum(`rgb(${over(ink, u).slice(0, 3).join(',')})`), lum(`rgb(${u.slice(0, 3).join(',')})`)]; return (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05); }));
    if (!(least >= 4.5)) bad.push(`${name} is at ${least.toFixed(1)} : 1 on what is behind it`);
  }
  return { bad, seen: [...seen] };
}

/** Every sheet is the window's: centred on it, hung from the title bar's lower edge, inside it with room at its sides;
 *  and it stays where it is while the sidebar goes and comes. Measured over the frames of both slides. */
const hung = () => new Promise((done) => {
  const bad = [], sheet = () => document.querySelector('.sheet').getBoundingClientRect();
  const off = () => (sheet().left + sheet().right) / 2 - innerWidth / 2;
  const s = sheet(), bar = document.querySelector('.bar').getBoundingClientRect();
  if (Math.abs(off()) > 0.5) bad.push(`it is ${off().toFixed(1)} px off the window's centre`);
  if (Math.abs(s.top - bar.bottom) > 0.5) bad.push(`its top is ${(s.top - bar.bottom).toFixed(1)} px from the title bar's lower edge`);
  if (s.left < 15.5 || s.right > innerWidth - 15.5 || s.bottom > innerHeight - 15.5) bad.push('it does not keep 16 px to the window\'s edges');
  let worst = 0, slides = 0;
  const began = performance.now();
  window.__ws.command('sidebar');
  const tick = () => {
    worst = Math.max(worst, Math.abs(off()));
    if (!window.__ws.ui.slide && slides < 1 && performance.now() - began > 450) (slides++, window.__ws.command('sidebar'));
    if (performance.now() - began < 1100) requestAnimationFrame(tick);
    else done(worst > 0.5 ? [...bad, `it moves ${worst.toFixed(1)} px off the window's centre while the sidebar slides`] : bad);
  };
  requestAnimationFrame(tick);
});

/** What stands in a row: one weight, one centre line, one baseline, figures on one edge (the rule at the head of this
 *  file). The Composer's and Settings' rings are left out of the weight: they are the agents' own component, drawn at
 *  1.25 px of their 24 px grid whatever the text size. */
function weights() {
  const bad = [], seen = new Set(), box = (el) => el.getBoundingClientRect();
  const ts = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ts')) || 1, rule = 1.2 * ts;
  const shown = (el) => el && el.getClientRects().length > 0 && box(el).width > 0 && getComputedStyle(el).visibility !== 'hidden';
  const name = (el) => { const r = el.closest('.hr, .hq, .row, .tab, .fold-h, .cap-to, .mic, .key, .more, .ib, .btn, kbd, h3, .rail-l, [class]'); return `.${(r?.className?.baseVal ?? r?.className ?? '').split(' ').filter(Boolean).slice(0, 2).join('.')}`; };
  // One weight.
  for (const svg of document.querySelectorAll('svg.i, .st .ring-o')) {
    if (!shown(svg) || !svg.viewBox.baseVal.width) continue;
    const k = box(svg).width / svg.viewBox.baseVal.width;
    for (const shape of svg.querySelectorAll('path, rect, circle, line')) {
      const s = getComputedStyle(shape);
      if (s.stroke === 'none' || !(parseFloat(s.strokeWidth) > 0)) continue;
      const w = parseFloat(s.strokeWidth) * (s.vectorEffect === 'non-scaling-stroke' ? 1 : k);
      seen.add('strokes at one weight');
      // Return's arrow on the metal key stands beside a word in 600 and is the one heavier stroke (--i-w-key).
      if (Math.abs(w - (svg.closest('.key') ? 1.35 * ts : rule)) > 0.06) bad.push(`a stroke ${w.toFixed(2)} px wide where every stroke is ${rule.toFixed(2)}: ${svg.classList.contains('i') ? 'an icon' : 'a seat'} ${Math.round(box(svg).width)} px wide in ${name(svg)}`);
    }
  }
  // Where an element's first words stand: their baseline (their box's top and the face's ascent, in whole pixels as the
  // page lays text out), the middle of their capital letters, and their right edge.
  const pen = document.createElement('canvas').getContext('2d');
  const words = (el) => {
    if (!shown(el)) return null;
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n = walk.nextNode();
    while (n && (!n.textContent.trim() || !shown(n.parentElement))) n = walk.nextNode();
    if (!n) return null;
    const s = getComputedStyle(n.parentElement), range = document.createRange();
    pen.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    range.selectNodeContents(n);
    const first = range.getClientRects()[0], m = pen.measureText('H');
    if (!first) return null;
    const base = first.top + Math.round(m.fontBoundingBoxAscent);
    return { base, mid: base - m.actualBoundingBoxAscent / 2, right: range.getBoundingClientRect().right, size: parseFloat(s.fontSize), mono: /mono|Menlo|Consolas/i.test(s.fontFamily) || /tabular/.test(s.fontVariantNumeric) };
  };
  // One centre line: what leads a row, on the capital letters of the words it leads.
  for (const [row, lead, label] of [
    ['.hr', ':scope > .st', ':scope > .hr-t'], ['.hq.open', ':scope > .st', '.hq-m > b'], ['.hsec h3', '.st', 'span'], ['.fold-h', '.i', 'b'], ['.row.s', '.st', '.lbl'], ['.row.home', '.i', '.lbl'],
    ['.row.w', '.fold .i', '.lbl'], ['.tab', '.st', '.lbl'], ['.cap-to', '.i', 'b'], ['.mic', '.i', 'kbd'], ['.rail-l', '.st', 'b, span'], ['.rows .row', '.st', '.t'], ['.line', ':scope > .ring-o, :scope > .i', '.t'],
  ])
    for (const r of document.querySelectorAll(row)) {
      const m = r.querySelector(lead), w = words(r.querySelector(label));
      if (!shown(m) || !w) continue;
      seen.add('leads on the capitals\' centre');
      const d = box(m).top + box(m).height / 2 - w.mid;
      if (Math.abs(d) > 1) bad.push(`${row}: what leads it is ${d.toFixed(1)} px off the middle of its words' capitals ("${r.querySelector(label).textContent.trim().slice(0, 24)}")`);
    }
  // One baseline: words of different sizes on one line of a row.
  for (const [row, parts] of [
    ['.hr', [':scope > .hr-t', ':scope > time']], ['.hr', [':scope > .hr-m > :last-child', ':scope > .hr-d']], ['.hr', [':scope > .hr-w', ':scope > .hr-t', ':scope > .hr-x', ':scope > time']],
    ['.hq.open', ['.hq-m > b', ':scope > time']], ['button.hq', ['.hr-w', '.hq-w', '.hq-q', 'time']], ['.hsec h3', ['span', 'i']], ['.fold-h', ['b', '.fold-c i', '.fold-p', 'time']], ['.row.s', ['.lbl', '.meta']],
    ['.row.home', ['.lbl', '.cnt']], ['.row.w', ['.lbl', '.cnt']], ['.rail-l', ['b', 'span']], ['.rows .row', ['.t', '.x', 'time']],
  ])
    for (const r of document.querySelectorAll(row)) {
      const at = parts.map((sel) => words(r.querySelector(sel))).filter(Boolean);
      if (at.length < 2 || new Set(at.map((w) => w.size)).size < 2) continue;
      seen.add('one baseline');
      const off = Math.max(...at.map((w) => w.base)) - Math.min(...at.map((w) => w.base));
      if (off > 0.5) bad.push(`${row}: its words stand on baselines ${off.toFixed(2)} px apart ("${r.textContent.trim().slice(0, 24)}")`);
    }
  // Figures: monospace or tabular, and their right edges on one line down a list (a list may stand in columns).
  for (const [list, cell] of [['.hrs', ':scope > .hr > time'], ['.hsec, .fold-b, .hx .col', ':scope > .hr > time'], ['.ws', ':scope > .row.s > .meta'], ['.folds', ':scope > .fold > .fold-h > time'], ['.rows', ':scope > .row > time']])
    for (const l of document.querySelectorAll(list)) {
      const columns = new Map();
      for (const c of l.querySelectorAll(cell)) {
        const w = words(c);
        if (!w) continue;
        if (!w.mono) bad.push(`${list}: a figure is neither in the monospace face nor tabular ("${c.textContent}")`);
        const key = Math.round(box(c.parentElement).left);
        columns.set(key, [...(columns.get(key) ?? []), w.right - box(c.parentElement).right]);
      }
      for (const edges of columns.values()) {
        if (edges.length < 2) continue;
        seen.add('figures on one edge');
        if (Math.max(...edges) - Math.min(...edges) > 0.5) bad.push(`${list}: its figures end ${(Math.max(...edges) - Math.min(...edges)).toFixed(1)} px apart`);
      }
    }
  return { bad, seen: [...seen] };
}

/** The collapsed notch's tab, from the tight boxes of what it draws (bars, figures, the words of who asks), never from
 *  a box with room in it. `own` is the tab's width before its wings. */
function glance(own) {
  const bad = [], box = (el) => el.getBoundingClientRect(), tab = box(document.querySelector('#tab'));
  const drawn = (root) => [...root.querySelectorAll('.st b, .wave b, .wing > b, .wing .n > b, .peek')].map(box).filter((b) => b.width > 0 && b.height > 0);
  const around = (bs) => ({ left: Math.min(...bs.map((b) => b.left)), right: Math.max(...bs.map((b) => b.right)), top: Math.min(...bs.map((b) => b.top)), bottom: Math.max(...bs.map((b) => b.bottom)) });
  const off = (n) => `${n > 0 ? '+' : ''}${n.toFixed(2)} px`;
  if (!document.body.classList.contains('cutout')) {
    const all = drawn(document.querySelector('#tab'));
    if (!all.length) return ['the tab draws nothing'];
    const c = around(all), dx = (c.left + c.right) / 2 - (tab.left + tab.width / 2), dy = (c.top + c.bottom) / 2 - (tab.top + tab.height / 2);
    if (Math.abs(dx) > 0.5) bad.push(`its content is ${off(dx)} off the tab's centre line`);
    if (Math.abs(dy) > 0.5) bad.push(`its content is ${off(dy)} off the middle of the tab's height`);
    if (c.left < tab.left + 13.5 || c.right > tab.right - 13.5) bad.push('its content reaches the tab\'s sloped sides');
    return bad;
  }
  const wing = (tab.width - own) / 2, depth = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tab-h'));
  const [l, r] = ['.wing.l', '.wing.r'].map((s) => drawn(document.querySelector(`#tab ${s}`) ?? document.createElement('i')));
  const [L, Rr] = [l.length ? around(l) : null, r.length ? around(r) : null];
  for (const [name, c, inset, reach] of [['left', L, L && L.left - tab.left, L && L.right - (tab.left + wing)], ['right', Rr, Rr && tab.right - Rr.right, Rr && tab.right - wing - Rr.left]]) {
    if (!c) continue;
    if (Math.abs(inset - 14) > 0.5) bad.push(`the ${name} wing's content is ${inset.toFixed(2)} px from the tab's outer edge, not 14`);
    if (reach > 0.5) bad.push(`the ${name} wing's content reaches ${reach.toFixed(2)} px under the camera`);
    const dy = (c.top + c.bottom) / 2 - (tab.top + depth / 2);
    if (Math.abs(dy) > 0.5) bad.push(`the ${name} wing's content is ${off(dy)} off the middle of the camera's height`);
  }
  const line = document.querySelector('#tab .line .peek');
  if (line) {
    const dx = box(line).left + box(line).width / 2 - (tab.left + tab.width / 2);
    if (Math.abs(dx) > 0.5) bad.push(`the line under the camera is ${off(dx)} off the tab's centre line`);
  }
  return bad;
}

/** The open notch's head row: its two ends keep the same distance from the sheet's sides and sit on one centre line. */
function band() {
  const row = document.querySelector('#sheet .band');
  if (!row) return ['the open notch has no head row'];
  const box = (el) => el.getBoundingClientRect(), b = box(row), ends = [...row.children].filter((x) => box(x).width > 0), bad = [];
  if (ends.length < 2) return bad;
  const [first, last] = [box(ends[0]), box(ends.at(-1))];
  if (Math.abs(first.left - b.left - (b.right - last.right)) > 0.5) bad.push(`its ends are ${(first.left - b.left).toFixed(1)} and ${(b.right - last.right).toFixed(1)} px from the sheet's sides`);
  if (Math.abs(first.top + first.height / 2 - (last.top + last.height / 2)) > 0.5) bad.push('its two ends are not on one centre line');
  return bad;
}

/** The agents' rings in a scene: each agent's state, and whether it is the one that runs the next thought. */
const rings = () => [...document.querySelectorAll('.home .ring')].map((r) => `${r.dataset.agent}:${r.dataset.s ?? 'ready'}${r.getAttribute('aria-checked') === 'true' ? ':runs' : ''}${r.querySelector('.turn') ? ':turns' : ''}${r.querySelector('b')?.textContent ?? ''}${r.querySelector('.fix') ? ':fix' : ''}`).join(' ');
const RINGS = { busy: 'claude:asks:runs:turns3 codex:asks:turns1', quiet: 'claude:ready:runs codex:ready', first: 'claude:ready:runs codex:off:fix' };

/** Starts a motion and watches it frame by frame: every glyph of the wake that shows must lie behind the moving edge
 *  of `sel` (its right edge across the window, or its lower edge down it), on the side the edge has come from. */
const trail = ([start, sel, axis]) => new Promise((done) => {
  document.querySelectorAll('.wake').forEach((w) => w.remove());
  const out = { glyphs: 0, ahead: 0, frames: 0 }, began = performance.now();
  let from = null, way = 0;
  new Function(start)();
  const tick = () => {
    const el = document.querySelector(sel);
    if (!el) return done(out);
    const edge = el.getBoundingClientRect()[axis === 'x' ? 'right' : 'bottom'];
    from ??= edge;
    way = Math.sign(edge - from) || way;
    for (const g of document.querySelectorAll('.wake canvas')) {
      const b = g.getBoundingClientRect();
      if (Number(getComputedStyle(g).opacity) < 0.05) continue;
      out.glyphs++;
      if ((axis === 'x' ? (way > 0 ? b.right - edge : edge - b.left) : way > 0 ? b.bottom - edge : edge - b.top) > 0.5) out.ahead++;
    }
    out.frames++;
    if (performance.now() - began < 900) requestAnimationFrame(tick);
    else done(out);
  };
  requestAnimationFrame(tick);
});

async function main() {
  const { chromium } = require('playwright');
  const server = await serve(path.resolve(process.argv.includes('--dist') ? process.argv[process.argv.indexOf('--dist') + 1] : path.join(__dirname, '../ui/dist')));
  const browser = await chromium.launch({ headless: true });
  const failures = [], measured = new Set(), TWO = { two: true };
  const views = [
    ['busy', null], ['busy', (w) => (w.__ws.ui.fold = 'results')], ['busy', (w) => (w.__ws.ui.fold = 'later')], ['normal', null], ['quiet', null], ['first', null],
    ['busy', (w) => w.__ws.show('earlier')], ['busy', (w) => (w.__ws.ui.sheet = { kind: 'close-tab', project: '', id: '' })], ['busy', (w) => w.document.querySelector('#dest-chip').click()],
    // Settings, section by section, and the sheets that are a list of answers, a field, or the Composer.
    // (At the usual width and the narrowest: `TWO`.)
    ...['thoughts', 'voice', 'agents', 'appearance', 'terminal', 'about'].map((at) => ['busy', `(w) => (w.__ws.ui.sheet = { kind: 'settings', at: '${at}' })`, '', TWO]), ['first', (w) => (w.__ws.ui.sheet = { kind: 'settings', at: 'agents' }), '', TWO],
    ['busy', (w) => (w.__ws.ui.sheet = { kind: 'send', thought: [...w.__ws.records.thoughts.values()].find((t) => t.mode === 'note').id }), '', TWO], ['busy', (w) => (w.__ws.ui.sheet = { kind: 'open-workspace' }), '', TWO],
    ['busy', (w) => (w.__ws.ui.sheet = { kind: 'reply', question: [...w.__ws.records.questions.values()].find((q) => q.state === 'open' && q.kind === 'choice').id }), '', TWO], ['busy', (w) => (w.__ws.ui.sheet = { kind: 'capture' }), '', TWO],
    ['workspace', (w) => (w.__ws.show(w.__fake.records.ids.projects.cuegrid), (w.__ws.ui.sheet = { kind: 'find', id: w.__fake.records.ids.export.terminal })), '', TWO],
    ['workspace', (w) => (w.__ws.show(w.__fake.records.ids.projects.cuegrid), (w.__ws.ui.sheet = { kind: 'settle', thought: [...w.__ws.records.thoughts.values()].find((t) => t.workdir?.changes === 'pending').id, keep: false })), '', TWO],
    ['workspace', (w) => (w.__ws.ui.sheet = { kind: 'review', thought: [...w.__ws.records.thoughts.values()].find((t) => t.workdir?.changes === 'pending').id })],
    // A session's details: its two lines of facts and its turns, one of them read from the core's history.
    ['busy', (w) => (w.__ws.ui.sheet = { kind: 'session', id: [...w.__ws.records.sessions.values()].find((s) => s.turn > 1).id }), 'session'],
    // The routing and speech flows: a thought on its way (also two, a long German one, one typed under while it waits),
    // asked about, saved for later with the core's reason, a recording, its failure, the two sheets and Settings.
    ['normal', null, 'held'], ['normal', null, 'two'], ['normal', null, 'held', { lang: 'de', long: true }], ['normal', (w) => typeIn(w, 'The next thought, typed while that one waits'), 'held'],
    ['normal', null, 'placing'], ['normal', null, 'gone'], ['busy', null, 'asked', { lang: 'de' }], ['normal', (w) => (w.__ws.ui.fold = 'later'), 'later-gone'],
    ['normal', (w) => mine(w, 'thought', true), 'recording'], ['normal', (w) => mine(w), 'writing'], ['normal', (w) => mine(w), 'failed-heard'], ['busy', (w) => mine(w, 'text', false, '.hq.open .reply input'), 'recording'],
    ['normal', (w) => (w.__speech.talk.said = 'service'), 'no-service', { voice: false }],
    ['normal', (w) => (w.__ws.ui.sheet = { kind: 'placing' }), 'off'], ['normal', (w) => (w.__ws.ui.sheet = { kind: 'speech' }), 'no-service', { voice: false }],
    ['normal', (w) => (w.__ws.ui.sheet = { kind: 'settings', at: 'thoughts' }), 'plain'], ['normal', (w) => (w.__ws.ui.sheet = { kind: 'settings', at: 'voice' }), 'plain'],
    ['normal', (w) => (w.__ws.ui.sheet = { kind: 'settings', at: 'terminal' }), 'plain'],
    // Previews beside a terminal: what the person opened and what the agent did, text that is cut, a file that is gone.
    ...['previews', 'preview-text', 'preview-gone', 'preview-web'].map((kind) => ['workspace', (w) => w.__ws.show(w.__fake.records.ids.projects.cuegrid), kind]),
  ];
  // The key role, from the token file: no key is set smaller or lighter.
  const [, weight, size] = /--f-key:(\d+) round\(([\d.]+)px/.exec(require('node:fs').readFileSync(path.resolve(__dirname, '../ui/src/tokens.css'), 'utf8'));
  const KEY = { size: scaled(Number(size)), weight: Number(weight) };
  // In the page: this page's dictation is the fixture's; and a thought typed into the Composer.
  const helpers = `const mine = (w, kind = 'thought', latched = false, field = '') => Object.assign(w.__speech.talk, { id: w.__fake.records.dictations[0].id, kind, latched, field: field ? w.document.querySelector(field) : null });
    const typeIn = (w, text) => (w.document.querySelector('#capture-input').focus(), w.document.execCommand('insertText', false, text));`;
  try {
    for (const [state, act, kind, opts] of views)
      // The widths the composition is promised at, and a short window, where Home, the sidebar and a sheet all scroll.
      // The flows are measured at the usual width, the widest and the narrowest.
      for (const [width, height] of [[1180, 900], [1800, 900], [1480, 900], [720, 900], [1180, 420]].filter(([w, h]) => (!kind || (w !== 1480 && h !== 420)) && (opts !== TWO || (h === 900 && (w === 1180 || w === 720))))) {
        const page = await open(browser, { label: 'workspace', records: kind ? flow(scene(state), kind, opts) : scene(state), url: server.url, dpr: 1, viewport: { width, height } });
        if (act) await page.evaluate(`${helpers}; (${act})(window); window.__motion.redraw()`);
        await page.waitForTimeout(500);
        const r = await page.evaluate(audit, [LISTS, KEY]);
        if (kind) measured.add(`flow: ${kind}`);
        if (!act && !kind && RINGS[state] && width !== 720) {
          const got = await page.evaluate(rings);
          measured.add('rings');
          if (got !== RINGS[state]) failures.push(`workspace ${state}: the agents' rings are "${got}", not "${RINGS[state]}"`);
        }
        const parts = await page.evaluate(weights);
        r.seen.push(...parts.seen);
        r.bad.push(...parts.bad);
        r.seen.forEach((x) => measured.add(x.replace(/ ×\d+/, '')));
        for (const b of r.bad) failures.push(`workspace ${state}${kind ? ` (${kind})` : ''} ${width}px: ${b}`);
        for (const e of page.errors) failures.push(`workspace ${state}${kind ? ` (${kind})` : ''}: the page said ${e}`);
        await page.context().close();
      }
    // What stands in a row, again at 2x: Home in each state, Earlier, and a workspace with its sidebar and tabs.
    for (const [state, act] of [['busy', null], ['busy', (w) => (w.__ws.ui.fold = 'results')], ['normal', null], ['quiet', null], ['busy', (w) => w.__ws.show('earlier')], ['workspace', (w) => w.__ws.show(w.__fake.records.ids.projects.cuegrid)]]) {
      const page = await open(browser, { label: 'workspace', records: scene(state), url: server.url, dpr: 2, viewport: { width: 1180, height: 900 } });
      if (act) await page.evaluate(`(${act})(window); window.__motion.redraw()`);
      await page.waitForTimeout(500);
      const parts = await page.evaluate(weights);
      parts.seen.forEach((x) => measured.add(`${x} at 2x`));
      for (const b of parts.bad) failures.push(`workspace ${state} at 2x: ${b}`);
      await page.context().close();
    }
    // The wake: right of the sidebar's edge as it closes, left of it as it opens. No sheet sheds one.
    const moving = await open(browser, { label: 'workspace', records: scene('normal'), url: server.url, dpr: 1 });
    await moving.waitForTimeout(1500);
    for (const [name, ...motion] of [
      ['the sidebar closing', "__ws.command('sidebar')", '.side', 'x'], ['the sidebar opening', "__ws.command('sidebar')", '.side', 'x'],
      ['a decision coming down', "__ws.ui.sheet = { kind: 'close-tab', project: '', id: '' }; __motion.redraw()", '.sheet', 'y', true],
      ['Settings coming down', "__ws.dismiss(); __ws.command('settings')", '.sheet', 'y', true],
    ]) {
      const [, , , none] = motion, r = await moving.evaluate(trail, motion);
      await moving.waitForTimeout(700);
      measured.add(none ? 'no wake from a sheet' : 'wake');
      if (none ? r.glyphs : !r.glyphs || r.ahead) failures.push(`${name}: ${none ? 'it shed a wake' : r.glyphs ? `${r.ahead} sightings of a wake glyph ahead of the edge` : 'no wake was shed'}`);
    }
    await moving.context().close();
    // Every size of sheet, at four widths of window, with the sidebar open, closed and sliding: on the window's centre,
    // under the title bar's edge. And behind one the ambient layer rests, though agents work in the window in use.
    const P = '__fake.records.ids.projects.cuegrid';
    for (const [name, sc, kind, sheet] of [
      ['a decision', 'workspace', 'off', `(__ws.show(${P}), __ws.ui.sheet = { kind: 'close-tab', project: ${P}, id: __fake.records.ids.export.terminal })`],
      ['the Composer', 'busy', 'off', `(__ws.ui.sheet = { kind: 'capture' })`], ['a form', 'normal', 'off', `(__ws.ui.sheet = { kind: 'placing' })`],
      ['a session', 'busy', 'session', `(__ws.ui.sheet = { kind: 'session', id: [...__ws.records.sessions.values()].find((s) => s.turn > 1).id })`],
      ['a review', 'workspace', 'off', `(__ws.show(${P}), __ws.ui.sheet = { kind: 'review', thought: [...__ws.records.thoughts.values()].find((t) => t.workdir?.changes === 'pending').id })`],
      ['Settings', 'busy', 'plain', `(__ws.ui.sheet = { kind: 'settings', at: 'appearance' })`],
    ])
      for (const [width, height] of [[720, 540], [1180, 760], [1480, 900], [1800, 1100]]) {
        const page = await open(browser, { label: 'workspace', records: flow(scene(sc), kind, { voice: false }), url: server.url, dpr: 1, viewport: { width, height } });
        await page.evaluate(`__motion.debug.active = true; __motion.redraw()`);
        await page.waitForTimeout(300);
        const before = await page.evaluate(`document.querySelector('.light, .spark')?.dataset.moves`);
        await page.evaluate(`${sheet}; __motion.redraw()`);
        await page.waitForTimeout(400);
        const after = await page.evaluate(`[...document.querySelectorAll('.light, .spark')].map((e) => e.dataset.moves).join()`);
        if (before === 'true') measured.add('the ambient layer rests behind a sheet');
        if (after.includes('true')) failures.push(`${name}, ${width}px: the ambient layer moves behind the sheet`);
        for (const b of await page.evaluate(hung)) failures.push(`${name}, ${width}px: ${b}`);
        measured.add('sheets on the window\'s centre');
        await page.context().close();
      }
    for (const [a, sc, kind, opts, then] of [
      ['answer', 'busy'], ['capture', 'normal'], ['capture', 'busy'], ['hover-enter', 'normal'],
      ['capture', 'normal', 'held', { lang: 'de', long: true }], ['capture', 'normal', 'two'], ['answer', 'normal', 'asked'], ['capture', 'normal', 'recording', {}, (w) => mine(w, 'thought', true)], ['capture', 'normal', 'failed-heard', {}, (w) => mine(w)],
    ]) {
      const page = await open(browser, { label: 'notch', records: kind ? flow(scene(sc), kind, opts) : scene(sc), url: server.url, dpr: 1 });
      await page.evaluate(() => window.__fake.emit({ do: 'geometry', width: 185, height: 32, cutout: true, surfaceWidth: 420, surfaceOffset: 0, span: 560, pixel: 2, corner: 10, offset: 0, available: 700, collapsed: false }));
      await page.evaluate((x) => window.__fake.emit({ do: x }), a);
      if (then) await page.evaluate(`${helpers}; (${then})(window); window.__look({})`);
      await page.waitForTimeout(900);
      const r = await page.evaluate(audit, [LISTS, KEY]);
      r.seen.forEach((x) => measured.add(x.replace(/ ×\d+/, '')));
      for (const b of [...r.bad, ...(await page.evaluate(weights)).bad, ...(await page.evaluate(band)).map((x) => `the head row: ${x}`)]) failures.push(`notch ${a} ${sc}: ${b}`);
      measured.add('the open notch\'s head row');
      await page.context().close();
    }
    // The collapsed tab, on both kinds of display (the two sizes of tab a display without a cutout gets, at one pixel
    // to a point, where half a pixel shows), in each state.
    const states = {
      idle: (g) => ({ ...g, working: 0, needs_you: 0, done: 0, failed: 0, question: null }), working: (g) => ({ ...g, done: 0, failed: 0 }),
      asks: (g) => ({ ...g, working: 0, done: 0, failed: 0 }), 'asks, working and results': (g) => g,
    };
    for (const [display, geo] of [['no cutout', { width: 120, height: 20, cutout: false }], ['no cutout, large', { width: 104, height: 16, cutout: false }], ['cutout', { width: 185, height: 32, cutout: true }]])
      for (const [state, counts] of Object.entries(states)) {
        const records = scene(state === 'idle' ? 'first' : state === 'working' ? 'normal' : 'busy');
        if (state === 'idle') records.questions = [];
        records.glance = counts(records.glance);
        const page = await open(browser, { label: 'notch', records, url: server.url, dpr: 1, viewport: { width: 701, height: 120 } });
        await page.evaluate((g) => window.__fake.emit({ do: 'geometry', surfaceWidth: 420, surfaceOffset: 0, span: 560, pixel: 1, corner: 10, offset: 0, available: 700, collapsed: true, ...g }), geo);
        // A question opens the notch by itself; folded again, its tab says who asks.
        await page.waitForTimeout(400);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(900);
        const bad = geo.cutout && state === 'idle' ? [] : await page.evaluate(glance, geo.width);
        measured.add('the collapsed notch');
        for (const b of bad) failures.push(`collapsed notch, ${display}, ${state}: ${b}`);
        await page.context().close();
      }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(`measured: ${[...measured].join('; ')}`);
  for (const f of [...new Set(failures)]) console.log('FAIL  ' + f);
  console.log(failures.length ? `FAIL  alignment: ${new Set(failures).size} things out of line` : 'PASS  every list keeps its columns, marks centred, labels and secondary text on shared edges; the Composer is centred on what is under it and says Start once; keys read at 7 : 1; every key shown is at the key role\'s size, at 4.5 : 1 or better, in a Mac\'s order and whole; the rings show each state; no scroller shows a bar; the sidebar\'s wake lies behind its edge and no sheet sheds one; every sheet is on the window\'s centre under the title bar, with the sidebar open, closed and sliding, and the ambient layer rests behind it; the collapsed notch is centred in every state on both kinds of display');
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
