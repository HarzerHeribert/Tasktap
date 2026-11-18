// The rule for every list in both pages: within a list, every row uses the same columns. Leading marks share one
// column and are centred in it; labels share one left edge; secondary text shares one left edge; a mark and its label
// sit on one centred line. This renders the pages from ui/dist on fixture records (instrument-fixtures.cjs), in each
// state and with every list open, measures the parts of sibling rows, and fails on any difference over half a pixel.
// It also holds the page to what else is promised of its composition: the Composer centred over the lists under it
// (and, before a folder is open, a little above the middle with its one action on its own edges), a key's label at
// 7 : 1 or better on its face, the agents' rings in each of their states, no scroller showing a bar, and a wake that
// lies behind the edge that sheds it. And the collapsed notch: on a display without a camera cutout whatever its tab
// draws is centred on the tab's own centre line and height, in every state; with a cutout its two halves keep the same
// distance from the tab's outer edges and stay clear of the camera, and the line under it is centred. The open notch's
// head row keeps equal insets and one centre line.
// usage: node scripts/align-check.cjs   (exit status 1 on a failure; ui/dist must be built)
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
const { scene, flow } = require('./instrument-fixtures.cjs');

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
  { list: '.settings, .terms', row: ':scope > .set', parts: { label: '.t', fact: '.c' } },  { list: '.files', row: ':scope > .file', parts: { mark: '.ch', label: '.path' } },
  { list: '.cap-list', row: ':scope > button', parts: { mark: '.i, .st', label: 'span' } },
  { list: '.rows', row: ':scope > .row', parts: { mark: '.st', label: '.t', fact: '.x', time: 'time' } },
  { list: '.ask-notch .qa', row: ':scope > .ans', parts: { key: 'kbd', label: 'span' } },
  { list: '.ask-home .qa', row: ':scope > .ans', parts: { key: 'kbd' } },
  { list: '.ways', row: ':scope > .way', parts: { mark: '.way-h > .i, .way-h > .st', label: '.way-h > b' } },
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
  // An icon and its label, a key cap and its word, a wave and what it says: each pair on one centred line.
  for (const [within, a, b] of [
    ['.mic', '.i', 'kbd'], ['.ring[aria-checked=true]', '.ring-o', '.nm'], ['.way-h', ':scope > .i, :scope > .st', ':scope > b'], ['.way-h', '.act kbd', '.act span'],
    ['.way-h', ':scope > b', ':scope > .btn span'], ['.cap-row.hear', '.lvl, .st', 'b'], ['.cap-row.hear', 'b', '.act span'], ['.ans', '.i', 'span'], ['.disc', '.i', 'span'],
    ['.cap-said', ':scope > span', '.btn'], ['.reply', '.lvl', 'input'], ['.line.tool', '.ring-o', '.t'],
  ])
    for (const el of document.querySelectorAll(within)) {
      const [m, t] = [el.querySelector(a), el.querySelector(b)];
      if (!m || !t || !m.offsetParent || !t.offsetParent || box(t).height > 30) continue;
      seen.add(`${within} pairs`);
      const d = Math.abs(box(m).top + box(m).height / 2 - (box(t).top + box(t).height / 2));
      if (d > 1.5) bad.push(`${within}: ${a} and ${b} are ${d.toFixed(1)} px off one line`);
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
    // The routing and speech flows: a thought on its way (also two, a long German one, one typed under while it waits),
    // asked about, saved for later with the core's reason, a recording, its failure, the two sheets and Settings.
    ['normal', null, 'held'], ['normal', null, 'two'], ['normal', null, 'held', { lang: 'de', long: true }], ['normal', (w) => typeIn(w, 'The next thought, typed while that one waits'), 'held'],
    ['normal', null, 'placing'], ['normal', null, 'gone'], ['busy', null, 'asked', { lang: 'de' }], ['normal', (w) => (w.__ws.ui.fold = 'later'), 'later-gone'],
    ['normal', (w) => mine(w, 'thought', true), 'recording'], ['normal', (w) => mine(w), 'writing'], ['normal', (w) => mine(w), 'failed-heard'], ['busy', (w) => mine(w, 'text', false, '.hq.open .reply input'), 'recording'],
    ['normal', (w) => (w.__speech.talk.said = 'service'), 'no-service', { voice: false }],
    ['normal', (w) => (w.__ws.ui.sheet = { kind: 'placing' }), 'off'], ['normal', (w) => (w.__ws.ui.sheet = { kind: 'speech' }), 'no-service', { voice: false }], ['normal', (w) => (w.__ws.ui.sheet = { kind: 'settings' }), 'plain'],
  ];
  // In the page: this page's dictation is the fixture's; and a thought typed into the Composer.
  const helpers = `const mine = (w, kind = 'thought', latched = false, field = '') => Object.assign(w.__speech.talk, { id: w.__fake.records.dictations[0].id, kind, latched, field: field ? w.document.querySelector(field) : null });
    const typeIn = (w, text) => (w.document.querySelector('#capture-input').focus(), w.document.execCommand('insertText', false, text));`;
  try {
    for (const [state, act, kind, opts] of views)
      // The widths the composition is promised at, and a short window, where Home, the sidebar and a sheet all scroll.
      // The flows are measured at the usual width, the widest and the narrowest.
      for (const [width, height] of [[1180, 900], [1800, 900], [1480, 900], [720, 900], [1180, 420]].filter(([w, h]) => !kind || (w !== 1480 && h !== 420))) {
        const page = await open(browser, { label: 'workspace', records: kind ? flow(scene(state), kind, opts) : scene(state), url: server.url, dpr: 1, viewport: { width, height } });
        if (act) await page.evaluate(`${helpers}; (${act})(window); window.__motion.redraw()`);
        await page.waitForTimeout(500);
        const r = await page.evaluate(audit, LISTS);
        if (kind) measured.add(`flow: ${kind}`);
        if (!act && !kind && RINGS[state] && width !== 720) {
          const got = await page.evaluate(rings);
          measured.add('rings');
          if (got !== RINGS[state]) failures.push(`workspace ${state}: the agents' rings are "${got}", not "${RINGS[state]}"`);
        }
        r.seen.forEach((x) => measured.add(x.replace(/ ×\d+/, '')));
        for (const b of r.bad) failures.push(`workspace ${state}${kind ? ` (${kind})` : ''} ${width}px: ${b}`);
        for (const e of page.errors) failures.push(`workspace ${state}${kind ? ` (${kind})` : ''}: the page said ${e}`);
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
    for (const [a, sc, kind, opts, then] of [
      ['answer', 'busy'], ['capture', 'normal'], ['capture', 'busy'], ['hover-enter', 'normal'],
      ['capture', 'normal', 'held', { lang: 'de', long: true }], ['capture', 'normal', 'two'], ['answer', 'normal', 'asked'], ['capture', 'normal', 'recording', {}, (w) => mine(w, 'thought', true)], ['capture', 'normal', 'failed-heard', {}, (w) => mine(w)],
    ]) {
      const page = await open(browser, { label: 'notch', records: kind ? flow(scene(sc), kind, opts) : scene(sc), url: server.url, dpr: 1 });
      await page.evaluate(() => window.__fake.emit({ do: 'geometry', width: 185, height: 32, cutout: true, surfaceWidth: 420, surfaceOffset: 0, span: 560, pixel: 2, corner: 10, offset: 0, available: 700, collapsed: false }));
      await page.evaluate((x) => window.__fake.emit({ do: x }), a);
      if (then) await page.evaluate(`${helpers}; (${then})(window); window.__look({})`);
      await page.waitForTimeout(900);
      const r = await page.evaluate(audit, LISTS);
      r.seen.forEach((x) => measured.add(x.replace(/ ×\d+/, '')));
      for (const b of [...r.bad, ...(await page.evaluate(band)).map((x) => `the head row: ${x}`)]) failures.push(`notch ${a} ${sc}: ${b}`);
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
  console.log(failures.length ? `FAIL  alignment: ${new Set(failures).size} things out of line` : 'PASS  every list keeps its columns, marks centred, labels and secondary text on shared edges; the Composer is centred on what is under it and says Start once; keys read at 7 : 1; the rings show each state; no scroller shows a bar; a wake lies behind its edge; the collapsed notch is centred in every state on both kinds of display');
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
