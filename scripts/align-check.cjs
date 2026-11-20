// The rule for every list in both pages: within a list, every row uses the same columns. Leading marks share one
// column and are centred in it; labels share one left edge; secondary text shares one left edge; a mark and its label
// sit on one centred line. This renders the pages from ui/dist on fixture records (instrument-fixtures.cjs), in each
// state and with every list open, measures the parts of sibling rows, and fails on any difference over half a pixel.
// It also holds the page to what else is promised of its composition: the Composer centred over the lists under it
// (and, before a folder is open, a little above the middle with its one action on its own edges), a key's label at
// 7 : 1 or better on its face (its label and its arrow), the agent control in each of its states, no scroller showing a
// bar, a key cap only where its key does something now (inside the element that has the keyboard and answers it, or the
// window's own), on Home one metal key and that the Composer's, in every state, and a wake that
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
// It measures the page at rest, the same however loaded the machine is: every animation is first held at a defined
// point (one that ends at its end, one that runs on where it begins), and what moves (a wake, a sheet while the sidebar
// slides) is watched until it has ended, up to a limit, never for a fixed moment.
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
  { list: '.cap-list', row: ':scope > button', parts: { mark: '.i, .st, .ring-o', label: 'span' } },
  { list: '.setup-b', row: ':scope > .line', parts: { mark: ':scope > .i, :scope > .todo', label: '.t', fact: '.x' } },
  { list: '.rows', row: ':scope > .row', parts: { mark: '.st', label: '.t', fact: '.x', time: 'time' } },
  { list: '.ask-notch .qa', row: ':scope > .ans', parts: { key: 'kbd', label: 'span' } },
  { list: '.ask-home .qa', row: ':scope > .ans', parts: { key: 'kbd' } },
  { list: '.ways', row: ':scope > .way', parts: { mark: '.way-h > .i, .way-h > .st', label: '.way-h > b' } },
];

function audit([LISTS, KEY]) {
  const bad = [], seen = new Set();
  const box = (el) => el.getBoundingClientRect();
  // Shown: laid out (an SVG element, a ring or an icon, has no offsetParent of its own to say so).
  const on = (el) => !!el && (el instanceof SVGElement ? el.getClientRects().length > 0 && !!el.closest('svg')?.parentElement?.offsetParent : !!el.offsetParent);
  for (const L of LISTS)
    for (const list of document.querySelectorAll(L.list)) {
      const rows = [...list.querySelectorAll(L.row)].filter((r) => r.offsetParent);
      if (rows.length < 2) continue;
      seen.add(`${L.row.replace(/:scope > /g, '')} ×${rows.length}`);
      for (const [name, sel] of Object.entries(L.parts)) {
        const edges = rows.map((r) => {
          const p = r.querySelector(sel);
          if (!on(p)) return null;
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
        if (!on(m) || !on(t)) continue;
        const [a, b] = [box(m), box(t)];
        const d = Math.abs(a.top + a.height / 2 - (b.top + b.height / 2));
        if (d > 1.5) bad.push(`${L.row.replace(':scope > ', '')}: mark and label ${d.toFixed(1)} px off one line ("${t.textContent.trim().slice(0, 30)}")`);
      }
    }
  // An icon and its label, a key cap and its word, a wave and what it says: each pair on one centred line.
  // (A sheet's foot may wrap where it has no room for one line: its answer then stands a whole line under the rest.)
  for (const [within, a, b, wraps] of [
    ['.mic', '.i', 'kbd'], ['.cap-agent', '.ring-o', '.nm'], ['.cap-ask', '.qp > .st', '.qp'], ['.way-h', ':scope > .i, :scope > .st', ':scope > b'], ['.way-h', '.act kbd', '.act span'],
    ['.way-h', ':scope > b', ':scope > .btn span'], ['.cap-row.hear', '.lvl, .st', 'b'], ['.cap-row.hear', 'b', '.act span'], ['.ans', '.i', 'span'], ['.disc', '.i', 'span'],
    ['.cap-said', ':scope > span', '.btn'], ['.reply', '.lvl', 'input'], ['.line.rank', '.ring-o', '.t'], ['.line.rank', '.n', '.t'], ['.line.rank', '.t', '.switch'],
    ['.sh-f .act', 'kbd', 'span'], ['.sh-f .key', '.i', 'span'], ['.sh-f', '.act span', '.key span', true], ['.newt', 'span', 'kbd'], ['.set', 'kbd.keycap', '.t'],
  ])
    for (const el of document.querySelectorAll(within)) {
      const [m, t] = [el.querySelector(a), el.querySelector(b)];
      if (!on(m) || !on(t) || box(t).height > 30) continue;
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
  // The line over a preview is one line, as the tabs over it are, however narrow its pane: nothing in it wraps.
  for (const h of document.querySelectorAll('.pv-h')) {
    if (!h.offsetParent) continue;
    seen.add('the line over a preview');
    const b = box(h), off = [...h.querySelectorAll(':scope > *, .pv-do > *')].filter((c) => c.offsetParent && (box(c).top < b.top - 0.5 || box(c).bottom > b.bottom + 0.5 || box(c).height > 24.5));
    if (b.height > 31 || off.length) bad.push(`the line over a preview is ${Math.round(b.height)} px tall and not one line (${off.map((c) => c.className || c.textContent.trim()).join(', ') || 'itself'})`);
  }
  // In the Composer and what is under it, one key at most is metal, and one thing at most says Start.
  for (const c of document.querySelectorAll('.capture')) {
    const keys = [...c.querySelectorAll('.key')].filter((k) => k.offsetParent);
    if (keys.length > 1) bad.push(`${keys.length} metal keys in the Composer: ${keys.map((k) => k.textContent.trim()).join(', ')}`);
    const starts = [...c.querySelectorAll('button')].filter((b) => b.offsetParent && b.textContent.trim() === 'Start');
    if (starts.length > 1) bad.push(`Start is said ${starts.length} times in the Composer`);
  }
  // On Home the Composer's key is the metal key, in every state, also with nothing to do (NOTES §13); every other
  // action on Home is quiet. (A sheet has its own, and Home is behind it.)
  const metal = (k) => /linear-gradient/.test(getComputedStyle(k).backgroundImage) && getComputedStyle(k).color === 'rgb(13, 13, 14)';
  const own = document.querySelector('.home .capture .cap-row:not(.hear) > .key'), sheetUp = document.querySelector('.sheet[role=dialog]');
  if (document.querySelector('.home .capture .cap-row:not(.hear,.cap-list)')) {
    seen.add(sheetUp ? 'Home\'s Composer key quiet behind a sheet' : 'the Composer\'s key metal on Home');
    // (A question just come: the key says what Return will do, quiet until Return does it, metal from then on.)
    if (own?.hasAttribute('data-waits') && metal(own)) bad.push(`Home's Composer key is metal while Return does nothing yet ("${own.textContent.trim()}")`);
    if (!sheetUp && (!own || (!metal(own) && !own.hasAttribute('data-waits')))) bad.push(`Home's Composer key is not the metal key${own ? ` ("${own.textContent.trim()}", ${getComputedStyle(own).backgroundImage.slice(0, 30)})` : ''}`);
    // Behind a sheet Home's key is quiet: the sheet's is the one in use (the review's R9).
    if (sheetUp && own && metal(own)) bad.push(`Home's Composer key is metal behind the sheet "${sheetUp.querySelector('#sheet-title')?.textContent ?? ''}"`);
  }
  for (const k of document.querySelectorAll('.home .key')) if (k.offsetParent && !k.closest('.capture') && metal(k)) bad.push(`a second metal key on Home: "${k.textContent.trim()}"`);
  // One metal key in view at most, the window and a sheet over it counted together.
  const lit = [...document.querySelectorAll('.key')].filter((k) => k.offsetParent && metal(k));
  if (lit.length > 1) bad.push(`${lit.length} metal keys in view: ${lit.map((k) => `"${k.textContent.trim()}"${k.closest('.sheet[role=dialog]') ? ' (in the sheet)' : ''}`).join(', ')}`);
  else if (sheetUp) seen.add('one metal key in view, window and sheet together');
  // A key cap shows only where pressing its key does something now: inside the element whose keys act while it has the
  // keyboard (\`data-keys\`), while it has it; or the window's own (\`data-keys="window"\`). Nothing else answers a key.
  const at = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  for (const k of document.querySelectorAll('kbd.keycap')) {
    if (!k.offsetParent) continue;
    seen.add('key caps only where their keys work');
    const scope = k.closest('[data-keys]');
    if (!scope) bad.push(`the cap ${k.textContent.trim()} has nothing that answers its key (in .${(k.parentElement?.className || '').split(' ')[0]})`);
    // (`field`: a question asked at the Composer, whose keys are its field's while that has the keyboard. `composer`:
    // a sheet that came by itself, whose keys act from Home's Composer, which keeps the keyboard under it.)
    else if (scope.dataset.keys !== 'window' && !(at && (scope.contains(at) || (scope.dataset.keys === 'field' && at.id === 'capture-input' && scope.closest('form')?.contains(at))
      || (scope.dataset.keys === 'composer' && at.id === 'capture-input' && !!at.closest('.home'))))) bad.push(`the cap ${k.textContent.trim()} shows where its key does nothing now: the keyboard is not in .${String(scope.className).split(' ')[0] || scope.tagName}`);
  }
  // The composition. The Composer is centred on the lists under it, in one column or two.
  const mid = (el) => box(el).left + box(el).width / 2, cap = document.querySelector('.home .capture.raised .cap'), cols = document.querySelector('.hx .cols');
  if (cap && cols && Math.abs(mid(cap) - mid(cols)) > 0.5) bad.push(`the Composer is ${(mid(cap) - mid(cols)).toFixed(1)} px off the centre of the lists under it`);
  // Before a folder is open: a little above the middle of the content, its one action and what was saved on its edges.
  const first = document.querySelector('.hx.first'), home = document.querySelector('.home');
  if (first && cap) {
    const c = box(cap), h = box(home), at = (c.top + c.height / 2 - h.top) / h.height;
    if (h.height >= 500 && (at < 0.3 || at > 0.5)) bad.push(`first run: the Composer's middle is at ${at.toFixed(2)} of the content's height`);
    // Under it, Setup, on the Composer's own edges; nothing else stands loose under the Composer.
    const setup = first.querySelector('.setup');
    if (setup && (Math.abs(box(setup).left - c.left) > 0.5 || Math.abs(box(setup).right - c.right) > 0.5)) bad.push('first run: Setup is not on the Composer\'s edges');
    for (const row of first.querySelectorAll('.hsec')) if (Math.abs(box(row).left - c.left) > 0.5 || Math.abs(box(row).right - c.right) > 0.5) bad.push('first run: For later is not on the Composer\'s edges');
  }
  // A key's label on its face: 7 : 1 or better against every stop of the face.
  const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  for (const k of document.querySelectorAll('.key, kbd.keycap')) {
    if (!k.offsetParent || !/linear-gradient/.test(getComputedStyle(k).backgroundImage)) continue;
    const s = getComputedStyle(k), face = s.backgroundImage.slice(s.backgroundImage.lastIndexOf('linear-gradient')).match(/rgba?\([^)]+\)/g) ?? [];
    const least = (c) => { const ink = lum(c); return Math.min(...face.map((f) => { const l = lum(f); return (Math.max(l, ink) + 0.05) / (Math.min(l, ink) + 0.05); })); };
    if (!(least(s.color) >= 7)) bad.push(`a key's label is at ${least(s.color).toFixed(1)} : 1 on its face ("${k.textContent.trim().slice(0, 20)}")`);
    // Its arrow too, in the key's own ink (the owner, 2026-11-19: "The return key is white on white background").
    for (const g of k.querySelectorAll(':scope > svg.i, :scope > .key-ret > svg.i, :scope > kbd > svg.i, :scope > svg.i'))
      if (!g.closest('kbd:not(.keycap)') && !(least(getComputedStyle(g).stroke) >= 7)) bad.push(`a key's arrow is at ${least(getComputedStyle(g).stroke).toFixed(1)} : 1 on its face ("${k.textContent.trim().slice(0, 20)}")`);
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
  let worst = 0, slides = 0, back = 0;
  const began = performance.now();
  window.__ws.command('sidebar');
  // Both slides watched to their end, the second begun once the first has ended; up to a limit.
  const tick = () => {
    worst = Math.max(worst, Math.abs(off()));
    const t = performance.now() - began;
    if (!window.__ws.ui.slide && slides < 1 && t > 450) (slides++, (back = t), window.__ws.command('sidebar'));
    if (t < 8000 && (slides < 1 || window.__ws.ui.slide || t - back < 450)) return void requestAnimationFrame(tick);
    if (t >= 8000) bad.push('the sidebar had not slid away and back within 8 s');
    done(worst > 0.5 ? [...bad, `it moves ${worst.toFixed(1)} px off the window's centre while the sidebar slides`] : bad);
  };
  requestAnimationFrame(tick);
});

/** What stands in a row: one weight, one centre line, one baseline, figures on one edge (the rule at the head of this
 *  file). Every ring is held to the weight too, wherever it stands and at whatever size; the ring chosen in the
 *  Composer is the one heavier circle, 1.4 of the weight, so that the choice is seen. */
function weights() {
  const bad = [], seen = new Set(), box = (el) => el.getBoundingClientRect();
  const ts = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ts')) || 1, rule = 1.2 * ts;
  const shown = (el) => el && el.getClientRects().length > 0 && box(el).width > 0 && getComputedStyle(el).visibility !== 'hidden';
  const name = (el) => { const r = el.closest('.hr, .hq, .row, .tab, .fold-h, .cap-to, .mic, .key, .more, .ib, .btn, kbd, h3, .rail-l, [class]'); return `.${(r?.className?.baseVal ?? r?.className ?? '').split(' ').filter(Boolean).slice(0, 2).join('.')}`; };
  // One weight.
  for (const svg of document.querySelectorAll('svg.i, .ring-o')) {
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
  // Tasktap's mark is not a line icon: it is a picture of the chrome (ui.tsx Brand, Level), drawn once from the motion
  // engine, with no stroke to hold to the weight and nothing inside it that is drawn as a line. It is held instead to
  // the size it was drawn for: its pictures are drawn at twice the size they are shown at, so the page never scales one
  // except by the display's own density.
  for (const mark of document.querySelectorAll('.brand-m')) {
    if (!shown(mark)) continue;
    seen.add('the mark a picture at its own size');
    if (mark.querySelector('svg, [style*=stroke]')) bad.push(`the mark in ${name(mark)} holds a drawing of lines, where it is a picture`);
    for (const img of mark.querySelectorAll(':scope > img')) {
      const w = box(img).width;
      if (!img.complete || !img.naturalWidth) bad.push(`the mark in ${name(mark)} has no picture`);
      else if (Math.abs(img.naturalWidth - 2 * w) > 0.5 || img.naturalWidth !== img.naturalHeight) bad.push(`the mark in ${name(mark)} is shown ${w.toFixed(1)} px wide, its picture drawn for ${img.naturalWidth / 2}`);
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
    ['.row.w', '.fold .i', '.lbl'], ['.tab', '.st', '.lbl'], ['.cap-to', '.i', 'b'], ['.mic', '.i', 'kbd'], ['.rail-l', '.st', 'b, span'], ['.rows .row', '.st', '.t'], ['.newt', '.brand-m', ':scope > span'], ['.line', ':scope > .ring-o, :scope > .i', '.t'],
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

/** The collapsed notch's tab, from the tight boxes of what it draws (marks, figures, the words of who asks), never from
 *  a box with room in it. `own` is the tab's width before its wings. */
function glance(own) {
  const bad = [], box = (el) => el.getBoundingClientRect(), tab = box(document.querySelector('#tab'));
  const drawn = (root) => [...root.querySelectorAll('.st .ring-o, .brand-m > img.p0, .wing > b, .wing .n > b, .peek')].map(box).filter((b) => b.width > 0 && b.height > 0);
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

/** The agent control in a scene: the agent that runs the next thought, its state, whether its ring turns, and the
 *  agents its list offers with theirs. In the first-run scene Codex is signed out, and listed as such. */
const rings = () => {
  const a = document.querySelector('.home .cap-agent');
  return a ? `${a.dataset.agent}:${a.dataset.s ?? 'ready'}${a.querySelector('.turn') ? ':turns' : ''}` : '';
};
const RINGS = { busy: 'claude:asks:turns', quiet: 'claude:ready', first: 'claude:ready' };

/** Every animation and transition in the page held at a defined point before anything is measured: one that ends (a
 *  ring taking its seat, a sheet coming down, a row arriving) at its end, and one that runs on (a ring turning, the
 *  light breathing) where it begins. What is measured is then the page at rest, however few frames a loaded machine
 *  has drawn of it by then; nothing that stays on screen is left out, since an animation that ends is finished, not
 *  skipped. */
const settle = () => {
  for (const a of document.getAnimations()) {
    const end = a.effect?.getComputedTiming().endTime;
    if (typeof end === 'number' && Number.isFinite(end)) a.finish();
    else (a.pause(), (a.currentTime = 0));
  }
};

/** Starts a motion and watches it to its end: every glyph of the wake must lie behind the moving edge of `sel` (its
 *  right edge across the window, or its lower edge down it), on the side the edge goes from (`way`: +1 rightward or
 *  downward, -1 leftward). The motion keeps a clock of its own: every animation in the page (the slide, each glyph's
 *  drift and fade) is held and moved on by a sixtieth of a second at each frame the page draws, so the edge and the
 *  wake keep the pace and the order they have at sixty frames a second, however few frames a loaded machine draws;
 *  what is watched is the product at its own pace, not the machine's. A glyph is counted as it is shed, and each that
 *  shows is held to the edge frame by frame. It ends once the edge has been still for five frames, at least a slide's
 *  length after it began, and the wake it shed has gone; or after `limit` ms of the machine's time, which it says. */
const trail = ([start, sel, axis, way, limit]) => new Promise((done) => {
  document.querySelectorAll('.wake').forEach((w) => w.remove());
  const out = { glyphs: 0, ahead: 0, frames: 0, late: false }, began = performance.now();
  const clock = new Map();
  let at = 0;
  const step = () => {
    for (const a of document.getAnimations()) {
      if (!clock.has(a)) clock.set(a, [at, Number(a.currentTime) || 0]);
      const [from, was] = clock.get(a);
      a.pause();
      a.currentTime = was + (at - from);
    }
    at += 1000 / 60;
  };
  const edgeOf = () => document.querySelector(sel)?.getBoundingClientRect()[axis === 'x' ? 'right' : 'bottom'];
  const ahead = (g, edge) => {
    const b = g.getBoundingClientRect();
    return (axis === 'x' ? (way > 0 ? b.right - edge : edge - b.left) : way > 0 ? b.bottom - edge : edge - b.top) > 0.5;
  };
  const shed = new MutationObserver((changes) => {
    for (const c of changes)
      for (const n of c.addedNodes) {
        const glyphs = n instanceof Element ? [...(n.matches('.wake canvas') ? [n] : []), ...n.querySelectorAll('.wake canvas')] : [];
        for (const g of glyphs) (out.glyphs++, edgeOf() !== undefined && ahead(g, edgeOf()) && out.ahead++);
      }
  });
  shed.observe(document.body, { childList: true, subtree: true });
  let last = null, still = 0;
  const end = () => (shed.disconnect(), done(out));
  new Function(start)();
  const tick = () => {
    step();
    const edge = edgeOf();
    if (edge === undefined) return end();
    still = edge === last ? still + 1 : 0;
    last = edge;
    for (const g of document.querySelectorAll('.wake canvas'))
      if (Number(getComputedStyle(g).opacity) >= 0.05 && ahead(g, edge)) out.ahead++;
    out.frames++;
    if (performance.now() - began > limit) return ((out.late = true), end());
    if (still >= 5 && at > 450 && !document.querySelector('.wake')) return end();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

async function main() {
  const { chromium } = require('playwright');
  const server = await serve(path.resolve(process.argv.includes('--dist') ? process.argv[process.argv.indexOf('--dist') + 1] : path.join(__dirname, '../ui/dist')));
  const browser = await chromium.launch({ headless: true });
  const failures = [], measured = new Set(), TWO = { two: true };
  /** Measures in the page with its animations settled first (settle). */
  const measure = (page, fn, arg) => page.evaluate(`(${settle})(), (${fn})(${arg === undefined ? '' : JSON.stringify(arg)})`);
  const views = [
    ['busy', null], ['busy', (w) => (w.__ws.ui.fold = 'results')], ['busy', (w) => (w.__ws.ui.fold = 'later')], ['normal', null], ['quiet', null], ['first', null],
    ['busy', (w) => w.__ws.show('earlier')], ['busy', (w) => (w.__ws.ui.sheet = { kind: 'close-tab', project: '', id: '', runs: { state: 'running', what: ['npm run dev'], session: null } })], ['busy', (w) => w.document.querySelector('#dest-chip').click()],
    // Who runs the thought, its list open; Setup's sheets; a question asked at the Composer, with the keyboard and
    // given back to the field (NOTES §13).
    ['busy', (w) => w.document.querySelector('.cap-agent').click()], ['first', (w) => w.document.querySelector('.cap-agent').click()],
    ['first', (w) => (w.__ws.ui.sheet = { kind: 'setup', step: 'projects' })], ['normal', (w) => (w.__ws.ui.sheet = { kind: 'setup', step: 'speech' })],
    ['normal', (w) => (w.__speech.cap.sent = { id: [...w.__ws.records.questions.values()].find((q) => q.source === 'router').thought_id, text: '', to: '' }), 'asked'],
    ['normal', (w) => (w.__speech.cap.sent = { id: [...w.__ws.records.questions.values()].find((q) => q.source === 'router').thought_id, text: '', to: '' }, w.document.querySelector('#capture-input').focus(), w.document.execCommand('insertText', false, 'the next one')), 'asked'],
    // Settings, section by section, and the sheets that are a list of answers, a field, or the Composer.
    // (At the usual width and the narrowest: `TWO`.)
    ...['thoughts', 'agents', 'projects', 'voice', 'appearance', 'terminal', 'about'].map((at) => ['busy', `(w) => (w.__ws.ui.sheet = { kind: 'settings', at: '${at}' })`, '', TWO]), ['first', (w) => (w.__ws.ui.sheet = { kind: 'settings', at: 'agents' }), '', TWO],
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
  // The key role, from the token file: no key is set smaller or lighter. It has a floor no text size goes under.
  const [, weight, floor, size] = /--f-key:(\d+) (?:max\(([\d.]+)px,)?round\(([\d.]+)px/.exec(require('node:fs').readFileSync(path.resolve(__dirname, '../ui/src/tokens.css'), 'utf8'));
  const KEY = { size: Math.max(Number(floor ?? 0), scaled(Number(size))), weight: Number(weight) };
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
        const r = await measure(page, audit, [LISTS, KEY]);
        if (kind) measured.add(`flow: ${kind}`);
        if (!act && !kind && RINGS[state] && width !== 720) {
          const got = await measure(page, rings);
          measured.add('rings');
          if (got !== RINGS[state]) failures.push(`workspace ${state}: the agents' rings are "${got}", not "${RINGS[state]}"`);
        }
        const parts = await measure(page, weights);
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
      const parts = await measure(page, weights);
      parts.seen.forEach((x) => measured.add(`${x} at 2x`));
      for (const b of parts.bad) failures.push(`workspace ${state} at 2x: ${b}`);
      await page.context().close();
    }
    // The wake: right of the sidebar's edge as it closes, left of it as it opens. No sheet sheds one. A wake is made of
    // the glyphs the sidebar's foot shows, so it is watched once those are drawn (the web view builds their program
    // aside), waiting for that up to a limit rather than for a fixed moment.
    const moving = await open(browser, { label: 'workspace', records: scene('normal'), url: server.url, dpr: 1 });
    const drawn = await moving.waitForFunction(() => document.querySelector('.spark .glyph canvas'), null, { timeout: 15000 }).then(() => true, () => false);
    if (!drawn) failures.push('the sidebar\'s foot never drew its glyphs, of which a wake is made');
    for (const [name, start, sel, axis, way, none] of [
      ['the sidebar closing', "__ws.command('sidebar')", '.side', 'x', -1], ['the sidebar opening', "__ws.command('sidebar')", '.side', 'x', 1],
      ['a decision coming down', "__ws.ui.sheet = { kind: 'close-tab', project: '', id: '', runs: { state: 'running', what: ['npm run dev'], session: null } }; __motion.redraw()", '.sheet', 'y', 1, true],
      ['Settings coming down', "__ws.dismiss(); __ws.command('settings')", '.sheet', 'y', 1, true],
    ]) {
      if (!drawn) break;
      const r = await moving.evaluate(trail, [start, sel, axis, way, 30000]);
      measured.add(none ? 'no wake from a sheet' : 'wake');
      if (r.late) failures.push(`${name}: it had not come to rest, its wake gone, within 30 s`);
      if (none ? r.glyphs : !r.glyphs || r.ahead) failures.push(`${name}: ${none ? 'it shed a wake' : r.glyphs ? `${r.ahead} sightings of a wake glyph ahead of the edge` : 'no wake was shed'}`);
    }
    await moving.context().close();
    // Every size of sheet, at four widths of window, with the sidebar open, closed and sliding: on the window's centre,
    // under the title bar's edge. And behind one the ambient layer rests, though agents work in the window in use.
    const P = '__fake.records.ids.projects.cuegrid';
    for (const [name, sc, kind, sheet] of [
      ['a decision', 'workspace', 'off', `(__ws.show(${P}), __ws.ui.sheet = { kind: 'close-tab', project: ${P}, id: __fake.records.ids.export.terminal, runs: { state: 'running', what: ['Claude Code'], session: __fake.records.ids.export.session } })`],
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
        for (const b of await measure(page, hung)) failures.push(`${name}, ${width}px: ${b}`);
        measured.add('sheets on the window\'s centre');
        // Settings keeps one box whichever section it shows: its edges do not move as the person goes through them,
        // and what does not fit scrolls inside. Every section in its list, by a click, as a person goes.
        if (name === 'Settings') {
          const boxes = [];
          for (let i = 0; i < (await page.evaluate(`document.querySelectorAll('.set-nav button').length`)); i++) {
            await page.evaluate(`document.querySelectorAll('.set-nav button')[${i}].click()`);
            await page.waitForTimeout(150);
            boxes.push(await page.evaluate(`(() => { const r = document.querySelector('.sheet').getBoundingClientRect(); return [document.querySelector('.set-nav [aria-selected=true] span')?.textContent, Math.round(r.top), Math.round(r.bottom), Math.round(r.left), Math.round(r.right)]; })()`));
          }
          const moved = boxes.filter((b) => b.slice(1).join() !== boxes[0].slice(1).join());
          if (boxes.length < 2) failures.push(`Settings, ${width}px: no sections to go through`);
          for (const b of moved) failures.push(`Settings, ${width}x${height}: in ${b[0]} its box is ${b.slice(1).join(', ')} (top, bottom, left, right), in ${boxes[0][0]} ${boxes[0].slice(1).join(', ')}`);
          measured.add('Settings keeps one box in every section');
        }
        await page.context().close();
      }
    // Home's column is the window's (checklist item 36). Whether it has one column or two, and how wide, is the window's
    // width alone: the sidebar's toggle reflows nothing on Home at any width. Where it stands is the owner's choice,
    // the hybrid: the reading column is centred on the window and stands still as the sidebar opens and closes, also on
    // every frame of the slide, wherever the window is wide enough (from about 1400 px); narrower, it moves right only
    // as far as the sidebar needs, and never under it.
    // No row is longer than the column, the Composer's 720 px: about 100 characters of its first line (107 at the small
    // text size, where the column keeps the Composer's width), so its time stays near its words.
    const ROOM = process.env.TEXT === 'small' ? 108 : 101;
    const layout = () => {
      const r = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent).map((e) => { const b = e.getBoundingClientRect(); return `${b.left.toFixed(1)}+${b.width.toFixed(1)}`; });
      const cap = document.querySelector('.home .capture.raised .cap')?.getBoundingClientRect();
      const ctx = document.createElement('canvas').getContext('2d'), sample = 'Make the rehearsal timer readable on mobile, and check the export menu at 390 px';
      const rows = [...document.querySelectorAll('.hr-t')].filter((e) => e.offsetParent).map((t) => {
        ctx.font = getComputedStyle(t).font;
        const per = ctx.measureText(sample).width / sample.length;
        return { chars: t.getBoundingClientRect().width / per, text: t.textContent.trim().slice(0, 30) };
      });
      // Every row's time, by the column it stands in (its left edge): one right edge in each.
      const times = {};
      for (const t of document.querySelectorAll('.hx .hr time')) if (t.offsetParent) (times[Math.round(t.closest('.hr').getBoundingClientRect().left)] ??= new Set()).add(Math.round(t.getBoundingClientRect().right));
      return { parts: { column: r('.hx'), composer: r('.home .capture.raised .cap'), headings: r('.hsec > h3'), rows: r('.hrs > .hr'), folds: r('.fold-h'), setup: r('.home .setup') },
        mid: cap ? cap.left + cap.width / 2 : null, capW: cap?.width ?? null, left: document.querySelector('.hx').getBoundingClientRect().left, two: !!document.querySelector('.hx.two'), rows,
        times: Object.values(times).map((e) => [...e].sort((a, b) => a - b)) };
    };
    for (const width of [1180, 1512, 1728, 2560, 3440])
        for (const sc of ['busy', 'normal']) {
          const page = await open(browser, { label: 'workspace', records: scene(sc), url: server.url, dpr: 1, viewport: { width, height: 900 } });
          const at = `Home (${sc}) at ${width} px`;
          const side = async (on) => (await page.evaluate((on) => ((window.__ws.ui.sidebar = on), window.__motion.redraw()), on), await page.waitForTimeout(250), measure(page, layout));
          const open_ = await side(true), shut = await side(false);
          measured.add('Home\'s column the window\'s');
          if (open_.two !== shut.two) failures.push(`${at}: the sidebar's toggle turns ${shut.two ? 'one column into two' : 'two columns into one'}`);
          for (const [name, list] of Object.entries(open_.parts)) {
            const was = shut.parts[name], widths = (l) => l.map((x) => x.split('+')[1]).join();
            if (widths(list) !== widths(was)) failures.push(`${at}: the sidebar's toggle reflows the ${name} (${widths(list).slice(0, 60)} wide with it open, ${widths(was).slice(0, 60)} closed)`);
            else if (width >= 1400 && list.join() !== was.join()) failures.push(`${at}: the sidebar's toggle moves the ${name} (${list.join(' ').slice(0, 60)} open, ${was.join(' ').slice(0, 60)} closed)`);
          }
          for (const [state, m] of [['open', open_], ['closed', shut]]) {
            const want = width >= 1400 || state === 'closed' ? width / 2 : null;
            if (want !== null && m.mid !== null && Math.abs(m.mid - want) > 0.5) failures.push(`${at}, the sidebar ${state}: the Composer's centre is at ${m.mid.toFixed(1)}, not ${want.toFixed(1)}`);
            if (state === 'open' && m.left < 224 + 36 - 0.5) failures.push(`${at}, the sidebar open: the column starts at ${m.left.toFixed(1)}, under the sidebar or against it`);
            for (const row of m.rows) if (row.chars > ROOM) failures.push(`${at}, the sidebar ${state}: a row's first line has room for ${Math.round(row.chars)} characters ("${row.text}"), more than about ${ROOM}`);
            // The Composer keeps the width the owner approved, 720 px (tokens.css --cap-w), whatever the column does.
            if (m.capW !== null && Math.abs(m.capW - 720) > 0.5) failures.push(`${at}, the sidebar ${state}: the Composer is ${m.capW.toFixed(1)} px wide, not its 720`);
            for (const edges of m.times) if (edges.length > 1) failures.push(`${at}, the sidebar ${state}: the rows of one column end their times at ${edges.join(', ')} px, not on one edge`);
            measured.add('every row\'s time on its column\'s edge');
          }
          // On every frame of the slide the column stands where it is, where it is centred on the window.
          if (width >= 1400) {
            await page.evaluate(() => ((window.__ws.ui.sidebar = true), window.__motion.redraw()));
            await page.waitForTimeout(250);
            const frames = await page.evaluate(() => new Promise((done) => {
              const at = () => document.querySelector('.home .capture.raised .cap')?.getBoundingClientRect().left ?? -1;
              const seen = [at()];
              window.__ws.command('sidebar');
              const tick = () => (seen.push(at()), window.__ws.ui.slide || seen.length < 3 ? requestAnimationFrame(tick) : done(seen));
              requestAnimationFrame(tick);
              setTimeout(() => done(seen), 3000);
            }));
            measured.add('Home still while the sidebar slides');
            if (Math.max(...frames) - Math.min(...frames) > 0.5) failures.push(`${at}: the Composer moves while the sidebar slides (${Math.min(...frames).toFixed(1)} to ${Math.max(...frames).toFixed(1)} over ${frames.length} frames)`);
          }
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
      const r = await measure(page, audit, [LISTS, KEY]);
      r.seen.forEach((x) => measured.add(x.replace(/ ×\d+/, '')));
      for (const b of [...r.bad, ...(await measure(page, weights)).bad, ...(await measure(page, band)).map((x) => `the head row: ${x}`)]) failures.push(`notch ${a} ${sc}: ${b}`);
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
        const bad = geo.cutout && state === 'idle' ? [] : await measure(page, glance, geo.width);
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
