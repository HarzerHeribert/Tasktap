// While the core has not answered (a first start held up, a slow machine), the window may be up already: the page must
// not look ready. Headless, from ui/dist on fixture records, with the stand-in core's welcome held back until the check
// lets it go (motion-pages.cjs `holdWelcome`), in Chromium and, where Playwright's WebKit is installed, WebKit. It
// fails when
// - Home's status line does not say "Starting…" in place of the counts while the core has not answered, or still says
//   it once the core has;
// - anything on the page claims what the page does not know yet: the chip's words ("No projects yet", "saved for
//   later"), the key saying "Save for later", Setup and its count, "Nothing running"; in the New Task sheet and in the
//   notch's Composer as on Home; or once the core has answered they are not as before; or the Composer is not where it
//   was (a first start, whose Home is as empty after as before);
// - a task started while the core has not answered is lost, shows an error, is not shown as being placed meanwhile, goes
//   out before the core is there or more than once, or is kept for later rather than placed (on Home, in the New Task
//   sheet and in the notch);
// - with the core answering as it does (at once, or within the page's own 1.5 s), the window is shown saying
//   "Starting…"; or a core slower than that does not have the window shown saying it.
// usage: node scripts/starting-check.cjs [--dist folder]   (ui/dist must be built)
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
const { scene } = require('./instrument-fixtures.cjs');
const { projects } = require('./projects-fixtures.cjs');

const GEO = { do: 'geometry', width: 104, height: 16, cutout: false, surfaceWidth: 420, surfaceOffset: 0, span: 560, pixel: 1, corner: 10, offset: 0, available: 700, collapsed: false };
const CLAIMS = /No projects yet|saved for later|Save for later|\d of \d done|Nothing running/i;
const failures = [];
let ENGINE = 'chromium';
const expect = (ok, what) => ok || failures.push(`[${ENGINE}] ${what}`);
const until = async (read, ok, ms = 10000) => {
  const end = Date.now() + ms;
  let v = await read();
  while (!ok(v) && Date.now() < end) (await new Promise((r) => setTimeout(r, 50)), (v = await read()));
  return v;
};
const rail = (p) => p.evaluate(() => document.querySelector('.rail-l')?.textContent ?? null);
const claims = (p) => p.evaluate((re) => (document.body.innerText.match(new RegExp(re, 'i')) ?? [''])[0], CLAIMS.source);
const chipHidden = (p, at = '') => p.evaluate((s) => { const c = document.querySelector(`${s}#dest-chip`); return !c || getComputedStyle(c).visibility === 'hidden'; }, at);
const captures = (p) => p.evaluate(() => window.__fake.calls.filter((c) => c === 'thought.capture').length);
const welcome = (p) => p.evaluate(() => window.__fake.welcome());

async function home(browser, url) {
  // 1 and 2: the status line, and nothing claimed, on a first start (whose Home stays empty): the Composer stays put.
  let page = await open(browser, { label: 'workspace', records: { ...projects('first-agents'), holdWelcome: true }, url, dpr: 1 });
  await page.waitForSelector('#capture-input');
  expect((await rail(page)) === 'Starting…', `Home while the core has not answered: the status line says "${await rail(page)}", not "Starting…"`);
  const said = await claims(page);
  expect(!said, `Home while the core has not answered says "${said}", which it does not know yet`);
  expect(await chipHidden(page), 'Home while the core has not answered: the chip shows');
  expect(!(await page.evaluate(() => !!document.querySelector('.home .setup'))), 'Home while the core has not answered: Setup is there, with its count');
  const before = await page.evaluate(() => document.querySelector('.home #capture-input').getBoundingClientRect().toJSON());
  await welcome(page);
  const after = await until(() => rail(page), (v) => v !== 'Starting…');
  expect(after && after !== 'Starting…', `Home once the core has answered: the status line says "${after}"`);
  expect(await until(() => page.evaluate(() => !!document.querySelector('.home .setup')), (v) => v), 'Home once the core has answered: no Setup');
  expect(!(await chipHidden(page)), 'Home once the core has answered: the chip is not shown');
  const moved = await page.evaluate((b) => { const r = document.querySelector('.home #capture-input').getBoundingClientRect(); return Math.max(Math.abs(r.x - b.x), Math.abs(r.y - b.y), Math.abs(r.width - b.width)); }, before);
  expect(moved < 0.5, `Home, a first start: the Composer moved ${moved} px when the core answered`);
  for (const e of page.errors) failures.push(`[${ENGINE}] Home, a first start: page: ${e}`);
  await page.context().close();

  // 4: a task started while the core has not answered, on Home: shown as being placed, then sent once, and placed.
  page = await open(browser, { label: 'workspace', records: { ...scene('normal'), holdWelcome: true }, url, dpr: 1 });
  await page.focus('#capture-input');
  await page.keyboard.type('fix the export in ledger-api');
  await page.keyboard.press('Enter');
  const meanwhile = await page.evaluate(() => [document.querySelector('#capture-input').value, document.querySelector('.home form.capture').getAttribute('aria-busy')].join(' | '));
  expect(meanwhile === ' | true', `Home, Start while the core has not answered: the field and the Composer say "${meanwhile}", not empty and being placed`);
  await page.waitForTimeout(600);
  expect((await captures(page)) === 0 && !(await claims(page)), `Home, Start while the core has not answered: ${await captures(page)} captures went out, or the page says "${await claims(page)}"`);
  await welcome(page);
  const sent = await until(() => captures(page), (n) => n > 0);
  await page.waitForTimeout(800);
  const capture = await page.evaluate(() => window.__fake.sent);
  expect(sent === 1 && (await captures(page)) === 1 && capture?.text === 'fix the export in ledger-api' && capture?.mode !== 'note',
    `Home, Start while the core has not answered: once it has, ${await captures(page)} captures went out (${JSON.stringify(capture && { text: capture.text, mode: capture.mode })}), not one, placed`);
  expect(!(await page.evaluate(() => document.querySelector('.rail-l .err')?.textContent ?? '')), 'Home, Start while the core has not answered: an error is shown');
  for (const e of page.errors) failures.push(`[${ENGINE}] Home, Start during the wait: page: ${e}`);
  await page.context().close();

  // The New Task sheet, open while the core has not answered: nothing claimed, and Start waits for it.
  page = await open(browser, { label: 'workspace', records: { ...scene('normal'), holdWelcome: true }, url, dpr: 1 });
  await page.evaluate(() => ((window.__ws.ui.sheet = { kind: 'capture' }), window.__motion.redraw()));
  await page.waitForSelector('.sheet #capture-input');
  expect(await chipHidden(page, '.sheet '), 'the New Task sheet while the core has not answered: its chip shows');
  const sheetSaid = await page.evaluate((re) => (document.querySelector('.sheet').innerText.match(new RegExp(re, 'i')) ?? [''])[0], CLAIMS.source);
  expect(!sheetSaid, `the New Task sheet while the core has not answered says "${sheetSaid}"`);
  await page.focus('.sheet #capture-input');
  await page.keyboard.type('add offline sync');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  expect((await captures(page)) === 0, 'the New Task sheet: a capture went out before the core had answered');
  await welcome(page);
  await until(() => captures(page), (n) => n > 0);
  await page.waitForTimeout(800);
  expect((await captures(page)) === 1 && (await page.evaluate(() => window.__fake.sent?.mode)) !== 'note', `the New Task sheet, Start while the core has not answered: ${await captures(page)} captures, mode ${await page.evaluate(() => window.__fake.sent?.mode)}`);
  for (const e of page.errors) failures.push(`[${ENGINE}] the New Task sheet during the wait: page: ${e}`);
  await page.context().close();

  // The notch's Composer, opened by the capture key while the core has not answered: the same.
  page = await open(browser, { label: 'notch', records: { ...scene('normal'), holdWelcome: true }, url, dpr: 1 });
  await page.evaluate((g) => window.__fake.emit(g), GEO);
  await page.evaluate(() => window.__fake.emit({ do: 'capture' }));
  await page.waitForSelector('#capture-input');
  await page.waitForTimeout(400);
  expect(await chipHidden(page), 'the notch while the core has not answered: its chip shows');
  const notchSaid = await claims(page);
  expect(!notchSaid, `the notch while the core has not answered says "${notchSaid}"`);
  await page.focus('#capture-input');
  await page.keyboard.type('rename the cue columns');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  expect((await captures(page)) === 0, 'the notch: a capture went out before the core had answered');
  await welcome(page);
  await until(() => captures(page), (n) => n > 0);
  await page.waitForTimeout(800);
  expect((await captures(page)) === 1 && (await page.evaluate(() => window.__fake.sent?.mode)) !== 'note', `the notch, Start while the core has not answered: ${await captures(page)} captures, mode ${await page.evaluate(() => window.__fake.sent?.mode)}`);
  for (const e of page.errors) failures.push(`[${ENGINE}] the notch during the wait: page: ${e}`);
  await page.context().close();

  // 5: the window is shown (host.ready) with the counts when the core answers at once or within the page's 1.5 s,
  // and saying "Starting…" when it is slower.
  for (const [how, extra, starting] of [['at once', {}, false], ['in 1 s', { welcomeMs: 1000 }, false], ['not yet', { holdWelcome: true }, true]]) {
    page = await open(browser, { label: 'workspace', records: { ...scene('normal'), ...extra }, url, dpr: 1 });
    const shown = await until(() => page.evaluate(() => window.__fake.ready ?? null), (v) => !!v, 5000);
    expect(!!shown && (shown.rail === 'Starting…') === starting, `the core answering ${how}: the window was shown ${shown ? `after ${Math.round(shown.at)} ms saying "${shown.rail}"` : 'never'}${starting ? ', not "Starting…"' : ''}`);
    await page.context().close();
  }
}

async function main() {
  const dist = process.argv.includes('--dist') ? process.argv[process.argv.indexOf('--dist') + 1] : path.join(__dirname, '../ui/dist');
  const server = await serve(path.resolve(dist));
  const pw = require('playwright');
  try {
    for (const name of ['chromium', 'webkit']) {
      ENGINE = name;
      const browser = await pw[name].launch({ headless: true }).catch((e) => {
        if (name !== 'webkit') throw e;
        if (process.env.CI) failures.push('WebKit is not installed for Playwright, so these were not tried in the Mac\'s engine');
        else console.log('NOTE  WebKit is not installed for Playwright: tried in Chromium only');
        return null;
      });
      if (!browser) continue;
      try {
        await home(browser, server.url);
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.close();
  }
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? `FAIL  while the core starts: ${failures.length} things wrong` : 'PASS  while the core starts the page says "Starting…" and claims nothing it does not know, keeps what is started and sends it once the core is there, and a core that answers in time is never seen starting');
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
