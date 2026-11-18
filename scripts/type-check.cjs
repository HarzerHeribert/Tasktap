// One type system: every piece of text in both pages is set in one of the roles of ui/src/tokens.css, at the normal
// width of its face. This renders the pages from ui/dist on fixture records, in every state the fixtures have (the four
// days of Home, Earlier, a workspace, every sheet, the flows of a thought on its way and of voice, the notch collapsed
// and open), reads the computed family, width, size, weight and letter spacing of every element that shows text of
// its own, and fails on any that is not a role's, or whose width is not normal. It prints the roles and where each is
// used. A terminal's own text is left out: its font is the person's.
// usage: node scripts/type-check.cjs   (exit status 1 on a failure; ui/dist must be built)
const fs = require('node:fs');
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
const { scene, flow } = require('./instrument-fixtures.cjs');

/** The roles, from the token file: name, face, size, weight and the letter spacing its role has, in pixels. */
function roles() {
  const css = fs.readFileSync(path.resolve(__dirname, '../ui/src/tokens.css'), 'utf8');
  const spacing = Object.fromEntries([...css.matchAll(/--ls-([a-z]+):(-?[\d.]+)em/g)].map((m) => [m[1], Number(m[2])]));
  return [...css.matchAll(/--f-([a-z]+):(\d+) ([\d.]+)px\/[\d.]+px var\(--(ui|mono)\);\s*\/\* ([^*]+)\*\//g)]
    .map(([, name, weight, size, face, what]) => ({ name, face, size: Number(size), weight, spacing: Math.round((spacing[name] ?? 0) * Number(size) * 1000) / 1000, what: what.trim() }));
}

// In the page: every element that shows text of its own, by what its font computes to.
function fonts() {
  const found = {};
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.xterm') || (el.closest('svg') && !el.closest('.ring-o'))) continue;
    const field = el.matches('input, textarea');
    if (!field && ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (!el.getClientRects().length) continue;
    const s = getComputedStyle(el), first = s.fontFamily.split(',')[0].trim().replace(/"/g, '');
    const face = first === 'ui-monospace' ? 'mono' : first === 'system-ui' ? 'ui' : first;
    const spacing = s.letterSpacing === 'normal' ? 0 : Math.round(parseFloat(s.letterSpacing) * 1000) / 1000;
    const key = `${face} ${parseFloat(s.fontSize)} ${s.fontWeight} ${spacing} ${s.fontStretch}`;
    const cls = (x) => (x ? String(x.className?.baseVal ?? x.className ?? '').split(' ')[0] : '');
    const where = `${cls(el.parentElement) ? `.${cls(el.parentElement)} ` : ''}${el.tagName.toLowerCase()}${cls(el) ? `.${cls(el)}` : ''}`;
    (found[key] ??= []).includes(where) || found[key].push(where);
  }
  return found;
}

const GEO = { do: 'geometry', width: 104, height: 16, cutout: false, surfaceWidth: 420, surfaceOffset: 0, span: 560, pixel: 1, corner: 10, offset: 0, available: 700, collapsed: false };
const sheet = (s) => `(w) => (w.__ws.ui.sheet = ${JSON.stringify(s)})`;
const mine = `(w) => Object.assign(w.__speech.talk, { id: w.__fake.records.dictations[0].id, kind: 'thought', latched: true })`;
const VIEWS = [
  ['busy'], ['normal'], ['quiet'], ['first'], ['busy', `(w) => (w.__ws.ui.fold = 'results')`], ['busy', `(w) => (w.__ws.ui.fold = 'later')`], ['busy', `(w) => w.__ws.show('earlier')`],
  ['workspace', `(w) => w.__ws.show(Object.values(w.__fake.records.ids.projects)[0])`], ['busy', `(w) => w.__ws.show(Object.values(w.__fake.records.ids.projects)[2])`], ['busy', `(w) => w.__ws.command('sidebar')`],
  ['busy', sheet({ kind: 'agents' })], ['busy', sheet({ kind: 'settings' })], ['busy', sheet({ kind: 'close-tab', project: '', id: '' })], ['busy', sheet({ kind: 'capture' })], ['busy', sheet({ kind: 'open-workspace' })],
  ['workspace', `(w) => (w.__ws.ui.sheet = { kind: 'review', thought: [...w.__ws.records.thoughts.values()].find((t) => t.workdir?.changes === 'pending').id })`],
  ['busy', `(w) => (w.__ws.ui.sheet = { kind: 'send', thought: [...w.__ws.records.thoughts.values()].find((t) => t.mode === 'note').id })`], ['busy', `(w) => w.document.querySelector('#dest-chip').click()`],
  ['normal', '', 'held'], ['normal', '', 'two'], ['normal', '', 'placing'], ['normal', '', 'gone'], ['busy', '', 'asked'], ['normal', `(w) => (w.__ws.ui.fold = 'later')`, 'later-gone'],
  ['normal', mine, 'recording'], ['normal', mine, 'writing'], ['normal', mine, 'failed-heard'], ['normal', `(w) => (w.__speech.talk.said = 'service')`, 'no-service', { voice: false }],
  ['busy', `(w) => (w.__ws.ui.sheet = { kind: 'session', id: [...w.__ws.records.sessions.values()].find((s) => s.turn > 1).id })`, 'session'],
  ['normal', sheet({ kind: 'placing' }), 'off'], ['normal', sheet({ kind: 'speech' }), 'no-service', { voice: false }], ['first-folder', '', 'off'],
];
const NOTCH = [
  ['collapsed', 'first'], ['collapsed', 'normal'], ['collapsed', 'busy'], ['answer', 'busy'], ['capture', 'normal'], ['capture', 'busy'], ['hover-enter', 'normal'], ['hover-enter', 'quiet'],
  ['capture', 'normal', 'held'], ['answer', 'normal', 'asked'], ['capture', 'normal', 'recording', mine], ['capture', 'normal', 'failed-heard', mine],
];

async function main() {
  const { chromium } = require('playwright');
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true });
  const all = roles(), used = Object.fromEntries(all.map((r) => [r.name, new Set()])), failures = new Set();
  const role = (key) => { const [face, size, weight, spacing] = key.split(' '); return all.find((r) => r.name !== 'term' && r.face === face && r.size === Number(size) && r.weight === weight && Math.abs(r.spacing - Number(spacing)) < 0.01); };
  const take = (found, at) => {
    for (const [key, where] of Object.entries(found)) {
      const r = role(key), width = key.split(' ')[4];
      if (width !== '100%') failures.add(`${at}: text at width ${width}, not normal (${where.slice(0, 3).join(', ')})`);
      else if (!r) failures.add(`${at}: "${key.split(' ').slice(0, 4).join(' ')}" is no role's face, size, weight and spacing (${where.slice(0, 3).join(', ')})`);
      else where.forEach((w) => used[r.name].add(w));
    }
  };
  try {
    for (const [state, act, kind, opts] of VIEWS)
      for (const width of [1180, 720]) {
        const base = scene(state === 'first-folder' ? 'normal' : state);
        if (state === 'first-folder') Object.assign(base, { thoughts: [], sessions: [], terminals: [], questions: [], results: [], layouts: [] });
        const page = await open(browser, { label: 'workspace', records: kind ? flow(base, kind, opts) : base, url: server.url, dpr: 1, viewport: { width, height: 900 } });
        if (act) await page.evaluate(`(${act})(window); window.__motion.redraw()`);
        await page.waitForTimeout(500);
        take(await page.evaluate(fonts), `workspace ${state}${kind ? ` (${kind})` : ''}${act ? ', acted on' : ''}`);
        await page.context().close();
      }
    for (const [how, state, kind, then] of NOTCH) {
      const page = await open(browser, { label: 'notch', records: kind ? flow(scene(state), kind) : scene(state), url: server.url, dpr: 1 });
      await page.evaluate((g) => window.__fake.emit(g), GEO);
      await page.evaluate((x) => window.__fake.emit({ do: x === 'collapsed' ? 'answer' : x }), how);
      await page.waitForTimeout(500);
      if (how === 'collapsed') await page.keyboard.press('Escape');
      if (then) await page.evaluate(`(${then})(window); window.__look({})`);
      await page.waitForTimeout(700);
      take(await page.evaluate(fonts), `notch ${how} ${state}${kind ? ` (${kind})` : ''}`);
      await page.context().close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log('role      face  size  weight  spacing  for, and where it is used');
  for (const r of all) {
    console.log(`${r.name.padEnd(9)} ${r.face.padEnd(5)} ${String(r.size).padEnd(5)} ${r.weight.padEnd(7)} ${String(r.spacing ? `${r.spacing}px` : '0').padEnd(8)} ${r.what}`);
    if (r.name !== 'term') console.log(`${' '.repeat(38)}${[...used[r.name]].slice(0, 14).join('  ') || '(nowhere)'}${used[r.name].size > 14 ? `  and ${used[r.name].size - 14} more` : ''}`);
  }
  const unused = all.filter((r) => r.name !== 'term' && !used[r.name].size).map((r) => r.name);
  if (unused.length) failures.add(`roles nothing is set in: ${unused.join(', ')}`);
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.size ? `FAIL  type: ${failures.size} things outside the scale` : `PASS  every text in both pages is one of ${all.length - 1} roles, in one family at its normal width, the monospace face for figures, keys and code only`);
  process.exitCode = failures.size ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
