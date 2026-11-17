// The rule for every list in both pages: within a list, every row uses the same columns. Leading marks share one
// column and are centred in it; labels share one left edge; secondary text shares one left edge; a mark and its label
// sit on one centred line. This renders the pages from ui/dist on fixture records (instrument-fixtures.cjs), in each
// state and with every list open, measures the parts of sibling rows, and fails on any difference over half a pixel.
// usage: node scripts/align-check.cjs   (exit status 1 on a failure; ui/dist must be built)
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
const { scene } = require('./instrument-fixtures.cjs');

// Lists: the rows that are siblings, and the parts of a row whose edges must agree.
const LISTS = [
  { list: '.hsec, .fold-b, .hx .col', row: ':scope > .hr.run', parts: { mark: '.st', folder: '.hr-w', label: '.hr-t', fact: '.hr-x', time: 'time' } },
  { list: '.hsec, .fold-b', row: ':scope > .hr.res', parts: { mark: '.st', folder: '.hr-w', label: '.hr-t', fact: '.hr-x', time: 'time' } },
  { list: '.hsec, .fold-b', row: ':scope > .hr.idea', parts: { mark: '.st', label: '.hr-t', fact: '.hr-x', time: 'time' } },
  { list: '.hsec.needs', row: ':scope > button.hq', parts: { mark: '.st', label: '.hq-m', question: '.hq-q', time: 'time' } },
  { list: '.folds', row: ':scope > .fold > .fold-h', parts: { mark: '.i', name: 'b', count: '.fold-c', time: 'time' } },
  { list: '.list', row: ':scope > .line', parts: { mark: '.st', label: '.t', fact: '.x' } },
  { list: '.ws', row: ':scope > .row.s', parts: { mark: '.st', label: '.lbl' } },
  { list: '.tree', row: ':scope > .row.home, :scope > .ws > .row.w', parts: { label: '.lbl' } },
  { list: '.acts', row: ':scope > .act', parts: { key: 'kbd', label: 'span' } },
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
  return { bad, seen: [...seen] };
}

async function main() {
  const { chromium } = require('playwright');
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true });
  const failures = [], measured = new Set();
  const views = [
    ['busy', null], ['busy', (w) => (w.__ws.ui.fold = 'results')], ['busy', (w) => (w.__ws.ui.fold = 'ideas')], ['normal', null], ['quiet', null], ['first', null],
    ['busy', (w) => w.__ws.show('earlier')], ['busy', (w) => (w.__ws.ui.sheet = { kind: 'agents' })], ['busy', (w) => (w.__ws.ui.sheet = { kind: 'close-tab', project: '', id: '' })],
  ];
  try {
    for (const [state, act] of views)
      for (const width of [1180, 1800, 720]) {
        const page = await open(browser, { label: 'workspace', records: scene(state), url: server.url, dpr: 1, viewport: { width, height: 900 } });
        if (act) await page.evaluate(`(${act})(window); window.__motion.redraw()`);
        await page.waitForTimeout(500);
        const r = await page.evaluate(audit, LISTS);
        r.seen.forEach((x) => measured.add(x.replace(/ ×\d+/, '')));
        for (const b of r.bad) failures.push(`workspace ${state} ${width}px: ${b}`);
        await page.context().close();
      }
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
  console.log(failures.length ? `FAIL  alignment: ${new Set(failures).size} lists out of line` : 'PASS  every list keeps its columns, marks centred, labels and secondary text on shared edges');
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
