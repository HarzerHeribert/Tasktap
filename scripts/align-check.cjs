// The rule for every list in both pages: within a list, every row uses the same columns. Leading marks share one
// column and are centred in it; labels share one left edge; secondary text shares one left edge; a mark and its label
// sit on one centred line. This renders the pages from ui/dist on fixture records (instrument-fixtures.cjs), in each
// state and with every list open, measures the parts of sibling rows, and fails on any difference over half a pixel.
// It also holds the page to what else is promised of its composition: the Composer centred over the lists under it
// (and, before a folder is open, a little above the middle with its one action on its own edges), a key's label at
// 7 : 1 or better on its face, the agents' rings in each of their states, no scroller showing a bar, and a wake that
// lies behind the edge that sheds it.
// usage: node scripts/align-check.cjs   (exit status 1 on a failure; ui/dist must be built)
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
const { scene } = require('./instrument-fixtures.cjs');

// Lists: the rows that are siblings, and the parts of a row whose edges must agree.
const LISTS = [
  { list: '.hsec, .fold-b, .hx .col', row: ':scope > .hr.run', parts: { mark: '.st', folder: '.hr-w', label: '.hr-t', fact: '.hr-x', time: 'time' } },
  { list: '.hsec, .fold-b', row: ':scope > .hr.res', parts: { mark: '.st', folder: '.hr-w', label: '.hr-t', fact: '.hr-x', time: 'time' } },
  { list: '.hsec, .fold-b', row: ':scope > .hr.later', parts: { mark: '.st', label: '.hr-t', time: 'time' } },
  { list: '.hsec.needs', row: ':scope > button.hq', parts: { mark: '.st', label: '.hq-m', question: '.hq-q', time: 'time' } },
  { list: '.folds', row: ':scope > .fold > .fold-h', parts: { mark: '.i', name: 'b', count: '.fold-c', time: 'time' } },
  { list: '.list', row: ':scope > .line', parts: { mark: '.ring-o', label: '.t', fact: '.x' } },
  { list: '.ws', row: ':scope > .row.s', parts: { mark: '.st', label: '.lbl' } },
  { list: '.tree', row: ':scope > .row.home, :scope > .ws > .row.w', parts: { label: '.lbl' } },
  { list: '.acts', row: ':scope > .act', parts: { key: 'kbd', label: 'span' } },
  { list: '.settings', row: ':scope > .set', parts: { label: '.t', fact: '.c' } },
  { list: '.files', row: ':scope > .file', parts: { mark: '.ch', label: '.path' } },
  { list: '.cap-list', row: ':scope > button', parts: { mark: '.i, .st', label: 'span' } },
  { list: '.rows', row: ':scope > .row', parts: { mark: '.st', label: '.t', fact: '.x', time: 'time' } },
  { list: '.ask-notch .qa', row: ':scope > .ans', parts: { key: 'kbd', label: 'span' } },
];

function audit(LISTS) {
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
  for (const k of document.querySelectorAll('.key:not(:disabled), .ans > kbd')) {
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
    if (el.scrollHeight > el.clientHeight + 1 && el.matches('.home, .tree, .sheet, .review') && !/up|down/.test(el.dataset.more ?? '')) bad.push(`.${el.className} scrolls and does not say which way there is more`);
    if (el.scrollHeight > el.clientHeight + 1) seen.add('scrollers');
  }
  return { bad, seen: [...seen] };
}

/** The agents' rings in a scene: each agent's state, and whether it is the one that runs the next thought. */
const rings = () => [...document.querySelectorAll('.home .ring')].map((r) => `${r.dataset.agent}:${r.dataset.s ?? 'ready'}${r.getAttribute('aria-checked') === 'true' ? ':runs' : ''}${r.querySelector('.turn') ? ':turns' : ''}${r.querySelector('b')?.textContent ?? ''}${r.querySelector('.fix') ? ':fix' : ''}`).join(' ');
const RINGS = { busy: 'claude:asks:runs:turns5 codex:asks:turns2', quiet: 'claude:ready:runs codex:ready', first: 'claude:ready:runs codex:off:fix' };

/** Starts a motion and watches it frame by frame: every glyph of the wake that shows must lie behind the moving edge
 *  of `sel` (its right edge across the window, or its lower edge down it), on the side the edge has come from. */
const trail = ([start, sel, axis]) => new Promise((done) => {
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
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true });
  const failures = [], measured = new Set();
  const views = [
    ['busy', null], ['busy', (w) => (w.__ws.ui.fold = 'results')], ['busy', (w) => (w.__ws.ui.fold = 'later')], ['normal', null], ['quiet', null], ['first', null],
    ['busy', (w) => w.__ws.show('earlier')], ['busy', (w) => (w.__ws.ui.sheet = { kind: 'agents' })], ['busy', (w) => (w.__ws.ui.sheet = { kind: 'close-tab', project: '', id: '' })],
    ['busy', (w) => (w.__ws.ui.sheet = { kind: 'settings' })], ['busy', (w) => w.document.querySelector('#dest-chip').click()],
    ['workspace', (w) => (w.__ws.ui.sheet = { kind: 'review', thought: [...w.__ws.records.thoughts.values()].find((t) => t.workdir?.changes === 'pending').id })],
  ];
  try {
    for (const [state, act] of views)
      // The widths the composition is promised at, and a short window, where Home, the sidebar and a sheet all scroll.
      for (const [width, height] of [[1180, 900], [1800, 900], [1480, 900], [720, 900], [1180, 420]]) {
        const page = await open(browser, { label: 'workspace', records: scene(state), url: server.url, dpr: 1, viewport: { width, height } });
        if (act) await page.evaluate(`(${act})(window); window.__motion.redraw()`);
        await page.waitForTimeout(500);
        const r = await page.evaluate(audit, LISTS);
        if (!act && RINGS[state] && width !== 720) {
          const got = await page.evaluate(rings);
          measured.add('rings');
          if (got !== RINGS[state]) failures.push(`workspace ${state}: the agents' rings are "${got}", not "${RINGS[state]}"`);
        }
        r.seen.forEach((x) => measured.add(x.replace(/ ×\d+/, '')));
        for (const b of r.bad) failures.push(`workspace ${state} ${width}px: ${b}`);
        await page.context().close();
      }
    // The wake: right of the sidebar's edge as it closes, left of it as it opens, above a sheet's edge as it drops.
    const moving = await open(browser, { label: 'workspace', records: scene('normal'), url: server.url, dpr: 1 });
    await moving.waitForTimeout(1500);
    for (const [name, ...motion] of [
      ['the sidebar closing', "__ws.command('sidebar')", '.side', 'x'], ['the sidebar opening', "__ws.command('sidebar')", '.side', 'x'],
      ['a sheet dropping', "__ws.ui.sheet = { kind: 'agents' }; __motion.redraw()", '.sheet', 'y'],
    ]) {
      const r = await moving.evaluate(trail, motion);
      await moving.waitForTimeout(700);
      measured.add('wake');
      if (!r.glyphs || r.ahead) failures.push(`${name}: ${r.glyphs ? `${r.ahead} sightings of a wake glyph ahead of the edge` : 'no wake was shed'}`);
    }
    await moving.context().close();
    for (const [a, sc] of [['answer', 'busy'], ['capture', 'normal'], ['capture', 'busy'], ['hover-enter', 'normal']]) {
      const page = await open(browser, { label: 'notch', records: scene(sc), url: server.url, dpr: 1 });
      await page.evaluate(() => window.__fake.emit({ do: 'geometry', width: 185, height: 32, cutout: true, surfaceWidth: 420, surfaceOffset: 0, span: 560, pixel: 2, corner: 10, offset: 0, available: 700, collapsed: false }));
      await page.evaluate((x) => window.__fake.emit({ do: x }), a);
      await page.waitForTimeout(900);
      const r = await page.evaluate(audit, LISTS);
      r.seen.forEach((x) => measured.add(x.replace(/ ×\d+/, '')));
      for (const b of r.bad) failures.push(`notch ${a} ${sc}: ${b}`);
      await page.context().close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(`measured: ${[...measured].join('; ')}`);
  for (const f of [...new Set(failures)]) console.log('FAIL  ' + f);
  console.log(failures.length ? `FAIL  alignment: ${new Set(failures).size} things out of line` : 'PASS  every list keeps its columns, marks centred, labels and secondary text on shared edges; the Composer is centred on what is under it; keys read at 7 : 1; the rings show each state; no scroller shows a bar; a wake lies behind its edge');
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
