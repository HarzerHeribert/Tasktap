// One type system: every piece of text in both pages is set in one of the roles of ui/src/tokens.css, at the normal
// width of its face. This renders the pages from ui/dist on fixture records, in every state the fixtures have (the four
// days of Home, Earlier, a workspace, every sheet, the flows of a thought on its way and of voice, the notch collapsed
// and open), reads the computed family, width, size, weight and letter spacing of every element that shows text of
// its own, and fails on any that is not a role's, or whose width is not normal. It prints the roles and where each is
// used. A terminal's own text is left out: its font is the person's. And every key shown, on a cap or as a hint, in
// every one of those states, at all three text sizes: none under the key role's floor (12 px on 18), which no text
// size shrinks; a key a row has no room for is dropped (align-check.cjs holds what is left whole).
// usage: node scripts/type-check.cjs   (exit status 1 on a failure; ui/dist must be built)
const fs = require('node:fs');
const path = require('node:path');
const { serve, open, TEXT, scaled } = require('./motion-pages.cjs');
const { scene, flow } = require('./instrument-fixtures.cjs');

/** The roles, from the token file: name, face, size, weight and the letter spacing its role has, in pixels, at the
 *  text size the check is run at (TEXT=small or large; WIDTH=one window width instead of 1180 and 720). */
function roles() {
  const css = fs.readFileSync(path.resolve(__dirname, '../ui/src/tokens.css'), 'utf8');
  const spacing = Object.fromEntries([...css.matchAll(/--ls-([a-z]+):(-?[\d.]+)em/g)].map((m) => [m[1], Number(m[2])]));
  return [...css.matchAll(/--f-([a-z]+):(\d+) (?:max\(([\d.]+)px,)?(round\()?([\d.]+)px[^/]*\/\S+ var\(--(ui|mono)\);\s*\/\* ([^*]+)\*\//g)]
    .map(([, name, weight, floor, scales, px, face, what]) => {
      // A role with a floor (the key's: max(12px, …)) is never set smaller than it, at any text size.
      const size = Math.max(Number(floor ?? 0), scales ? scaled(Number(px)) : Number(px));
      return { name, face, size, weight, spacing: Math.round((spacing[name] ?? 0) * size * 1000) / 1000, what: what.trim() };
    });
}

/** The key role's floor, from the token file: the size and line no key is shown smaller than, at any text size. The
 *  role says "never smaller", and a key that has no room is dropped, never shrunk (design notes §11). */
function keyFloor() {
  const css = fs.readFileSync(path.resolve(__dirname, '../ui/src/tokens.css'), 'utf8');
  const [, weight, size, line] = /--f-key:(\d+) (?:max\()?(?:round\()?([\d.]+)px[^/]*\/(?:max\()?(?:round\()?([\d.]+)px/.exec(css);
  return { size: Number(size), line: Number(line), weight };
}

// In the page: every key shown, on a cap or as a hint, with its size, line and weight as they compute.
function keys() {
  return [...document.querySelectorAll('kbd')].filter((k) => k.getClientRects().length && getComputedStyle(k).visibility !== 'hidden').map((k) => {
    const s = getComputedStyle(k), cls = (x) => String(x?.className?.baseVal ?? x?.className ?? '').split(' ')[0];
    return { size: parseFloat(s.fontSize), line: parseFloat(s.lineHeight) || 0, weight: s.fontWeight, cap: k.classList.contains('keycap'),
      text: k.textContent.trim() || k.getAttribute('aria-label') || 'an icon', where: `${cls(k.parentElement) ? `.${cls(k.parentElement)} ` : ''}kbd` };
  });
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
  ...['thoughts', 'voice', 'agents', 'appearance', 'terminal', 'about'].map((at) => ['busy', sheet({ kind: 'settings', at })]), ['normal', sheet({ kind: 'settings', at: 'about' }), 'plain'], ['busy', sheet({ kind: 'close-tab', project: '', id: '' })], ['busy', sheet({ kind: 'capture' })], ['busy', sheet({ kind: 'open-workspace' })],
  ['workspace', `(w) => (w.__ws.ui.sheet = { kind: 'review', thought: [...w.__ws.records.thoughts.values()].find((t) => t.workdir?.changes === 'pending').id })`],
  ['busy', `(w) => (w.__ws.ui.sheet = { kind: 'send', thought: [...w.__ws.records.thoughts.values()].find((t) => t.mode === 'note').id })`], ['busy', `(w) => w.document.querySelector('#dest-chip').click()`],
  ['normal', '', 'held'], ['normal', '', 'two'], ['normal', '', 'placing'], ['normal', '', 'gone'], ['busy', '', 'asked'], ['normal', `(w) => (w.__ws.ui.fold = 'later')`, 'later-gone'],
  ['normal', mine, 'recording'], ['normal', mine, 'writing'], ['normal', mine, 'failed-heard'], ['normal', `(w) => (w.__speech.talk.said = 'service')`, 'no-service', { voice: false }],
  ['busy', `(w) => (w.__ws.ui.sheet = { kind: 'session', id: [...w.__ws.records.sessions.values()].find((s) => s.turn > 1).id })`, 'session'],
  ...['previews', 'preview-notes', 'preview-text', 'preview-gone', 'preview-other', 'preview-web'].map((kind) => ['workspace', `(w) => w.__ws.show(w.__fake.records.ids.projects.cuegrid)`, kind]),
  ['workspace', `(w) => (w.__ws.show(w.__fake.records.ids.projects.cuegrid), w.__ws.follow(w.__fake.records.ids.timer.terminal, { kind: 'path', target: 'notes/missing.md' }, '/Users/example/projects/cuegrid', {}))`, 'preview-notes'],
  ['busy', `(w) => (w.__ws.ui.sheet = { kind: 'settings', at: 'thoughts' }, w.__motion.redraw(), w.setTimeout(() => w.document.querySelector('.rec').click(), 100))`],
  ['normal', sheet({ kind: 'placing' }), 'off'], ['normal', sheet({ kind: 'speech' }), 'no-service', { voice: false }], ['first-folder', '', 'off'],
];
/** The text sizes every key is measured at: all three in a plain run (as host/scripts/smoke.sh runs it); with TEXT
 *  set (scripts/text-sizes.sh runs one per size), that one, since the runs at the other two measure theirs. */
const SIZES = process.env.TEXT ? [process.env.TEXT] : ['small', 'default', 'large'];
const NOTCH = [
  ['collapsed', 'first'], ['collapsed', 'normal'], ['collapsed', 'busy'], ['answer', 'busy'], ['capture', 'normal'], ['capture', 'busy'], ['hover-enter', 'normal'], ['hover-enter', 'quiet'],
  ['capture', 'normal', 'held'], ['answer', 'normal', 'asked'], ['capture', 'normal', 'recording', mine], ['capture', 'normal', 'failed-heard', mine],
];

async function main() {
  const { chromium } = require('playwright');
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true });
  const all = roles(), used = Object.fromEntries(all.map((r) => [r.name, new Set()])), failures = new Set();
  // The role a font is, for a key or for anything else: at the small text size a label (13 px times .92) comes to the
  // key's 12 px and weight, so where two roles compute alike a key is taken as the key's and the rest as the other's.
  const role = (key, isKey) => {
    const [face, size, weight, spacing] = key.split(' ');
    const alike = all.filter((r) => r.name !== 'term' && r.face === face && r.size === Number(size) && r.weight === weight && Math.abs(r.spacing - Number(spacing)) < 0.01);
    return alike.find((r) => (r.name === 'key') === isKey) ?? alike[0];
  };
  const take = (found, at) => {
    for (const [key, where] of Object.entries(found)) {
      const width = key.split(' ')[4];
      if (width !== '100%') failures.add(`${at}: text at width ${width}, not normal (${where.slice(0, 3).join(', ')})`);
      for (const w of where) {
        const isKey = /\bkbd\b/.test(w), r = role(key, isKey);
        if (width !== '100%') continue;
        if (!r) failures.add(`${at}: "${key.split(' ').slice(0, 4).join(' ')}" is no role's face, size, weight and spacing (${w})`);
        else used[r.name].add(w);
        // A key is in the key role and nothing else is, but the letters that stand for an agent with no mark.
        if (r && isKey !== (r.name === 'key') && !/ring-o text/.test(w)) failures.add(`${at}: ${isKey ? `a key is set in the ${r.name} role` : 'something that is no key is set in the key role'} (${w})`);
      }
    }
  };
  // Every key shown, on a cap or as a hint, at each text size: never under the key role's floor, which no text size
  // shrinks. A key a row has no room for at that size is dropped (align-check.cjs holds the rest of it whole).
  const floor = keyFloor(), keysAt = Object.fromEntries(SIZES.map((s) => [s, 0]));
  const measureKeys = (found, at, size) => {
    keysAt[size] += found.length;
    for (const k of found)
      if (k.size < floor.size || k.line < floor.line)
        failures.add(`${at}, ${size} text: the key "${k.text}" ${k.cap ? 'on a cap' : 'as a hint'} is ${k.size} px on a ${k.line} px line, under the key role's ${floor.size} px on ${floor.line} (${k.where})`);
  };
  // The text size a page is opened at: the run's own (TEXT) unless another is asked for.
  const sized = (records, size) => (size === (process.env.TEXT || 'default') ? records : { ...records, prefs: [...(records.prefs || []).filter((p) => p.id !== 'text_size'), { id: 'text_size', value: size, rev: 1 }] });
  /** Both pages in every state at one text size: the fonts too at the run's own size, the keys alone at the others. */
  const visit = async (size, widths, all) => {
    const said = all ? '' : `, ${size} text`;
    for (const [state, act, kind, opts] of VIEWS)
      for (const width of widths) {
        const base = scene(state === 'first-folder' ? 'normal' : state);
        if (state === 'first-folder') Object.assign(base, { thoughts: [], sessions: [], terminals: [], questions: [], results: [], layouts: [] });
        const page = await open(browser, { label: 'workspace', records: sized(kind ? flow(base, kind, opts) : base, size), url: server.url, dpr: 1, viewport: { width, height: 900 } });
        if (act) await page.evaluate(`(${act})(window); window.__motion.redraw()`);
        await page.waitForTimeout(500);
        const at = `workspace ${state}${kind ? ` (${kind})` : ''}${act ? ', acted on' : ''}${said}`;
        if (all) take(await page.evaluate(fonts), at);
        measureKeys(await page.evaluate(keys), `${at}, ${width} px`, size);
        await page.context().close();
      }
    for (const [how, state, kind, then] of NOTCH) {
      const page = await open(browser, { label: 'notch', records: sized(kind ? flow(scene(state), kind) : scene(state), size), url: server.url, dpr: 1 });
      await page.evaluate((g) => window.__fake.emit(g), GEO);
      await page.evaluate((x) => window.__fake.emit({ do: x === 'collapsed' ? 'answer' : x }), how);
      await page.waitForTimeout(500);
      if (how === 'collapsed') await page.keyboard.press('Escape');
      if (then) await page.evaluate(`(${then})(window); window.__look({})`);
      await page.waitForTimeout(700);
      const at = `notch ${how} ${state}${kind ? ` (${kind})` : ''}${said}`;
      if (all) take(await page.evaluate(fonts), at);
      measureKeys(await page.evaluate(keys), at, size);
      await page.context().close();
    }
  };
  try {
    const own = process.env.TEXT || 'default';
    await visit(own, process.env.WIDTH ? [Number(process.env.WIDTH)] : [1180, 720], true);
    for (const size of SIZES.filter((s) => s !== own)) await visit(size, [Number(process.env.WIDTH) || 720], false);
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
  for (const [size, n] of Object.entries(keysAt)) if (!n) failures.add(`no key was found to measure at the ${size} text size`);
  console.log(`keys measured: ${Object.entries(keysAt).map(([s, n]) => `${n} at ${s} text`).join(', ')}; none may be under ${floor.size} px on ${floor.line}`);
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.size ? `FAIL  type: ${failures.size} things outside the scale` : `PASS  every text in both pages is one of ${all.length - 1} roles, in one family at its normal width, the monospace face for figures, counts and code only, and every key in the key role, at ${floor.size} px or more at ${SIZES.join(', ')} text`);
  process.exitCode = failures.size ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
