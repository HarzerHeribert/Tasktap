// The Composer's field belongs to the person at every moment (ui/src/capture.tsx, way.ts `leave`). Headless, from
// ui/dist on fixture records, with real keys, against a stand-in core that answers a capture late or refuses it. It
// fails when
// - a key typed while a capture is on its way to the core is refused, lost or out of order, or what was typed then is
//   not the beginning of the next thought once the capture has arrived;
// - Return pressed twice sends the thought twice, or starts another thought that waits;
// - ⌘Z pressed while a capture is on its way does not bring its words back once it has arrived;
// - the words of a capture the core refuses are not back in the field, before what was typed since;
// - on Home, in the capture sheet or in the notch, a render that changed neither the field's words nor its width
//   measures the field (which makes the page lay itself out there and then), or the field does not grow and shrink a
//   line at a time up to its most lines, or does not follow its width.
// usage: node scripts/composer-check.cjs [--dist folder]   (ui/dist must be built)
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
const { scene, flow } = require('./instrument-fixtures.cjs');
const dist = path.resolve(process.argv.includes('--dist') ? process.argv[process.argv.indexOf('--dist') + 1] : path.join(__dirname, '../ui/dist'));
const GEO = { do: 'geometry', width: 104, height: 16, cutout: false, surfaceWidth: 420, surfaceOffset: 0, span: 560, pixel: 1, corner: 10, offset: 0, available: 700, collapsed: false };
const FIELD = '#capture-input';

async function main() {
  const { chromium } = require('playwright');
  const server = await serve(dist), browser = await chromium.launch({ headless: true }), failures = [];
  const expect = (ok, what) => ok || failures.push(what);
  // Home, with a thought that waits (held) and a core that answers as `core` says.
  const home = async (core) => {
    const page = await open(browser, { label: 'workspace', records: { ...flow(scene('normal'), 'held'), ...core }, url: server.url, dpr: 1 });
    await page.focus(FIELD);
    return page;
  };
  const value = (page) => page.inputValue(FIELD);
  const calls = (page, name) => page.evaluate((n) => window.__fake.calls.filter((c) => c === n).length, name);
  try {
    // Typing through a capture, and Return twice.
    let page = await home({ slow: 500 });
    await page.keyboard.type('first thought');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('and the next');
    expect((await value(page)) === 'and the next', `typed while a capture was on its way: the field holds "${await value(page)}", not "and the next"`);
    await page.waitForTimeout(800);
    expect((await value(page)) === 'and the next', `after the capture arrived the field holds "${await value(page)}", not what was typed meanwhile`);
    expect((await calls(page, 'thought.capture')) === 1 && (await page.evaluate(() => window.__fake.sent.text)) === 'first thought', 'Return twice: the thought was not captured once, as it was typed');
    expect((await calls(page, 'thought.start')) === 0, 'Return twice: the second started the thought that waited');
    await page.context().close();

    // ⌘Z while the capture is on its way: its record arrives before its answer, as the core sends them.
    page = await home({ slow: 500 });
    await page.keyboard.type('take this back');
    await page.keyboard.press('Enter');
    await page.evaluate(() => {
      const like = window.__fake.records.thoughts.find((t) => t.phase === 'routed'), sent = window.__fake.sent;
      window.__fake.push({ t: 'change', rev: 9000, sets: [{ c: 'thoughts', put: [{ ...like, id: sent.id, text: sent.text, brief: sent.text, rev: 9000, created: Date.now(), hold_until: Date.now() + 5000 }] }] });
    });
    await page.keyboard.press('Meta+z');
    expect((await value(page)) === '', `⌘Z while a capture was on its way changed the field to "${await value(page)}" before it had arrived`);
    await page.waitForTimeout(800);
    expect((await value(page)) === 'take this back' && (await calls(page, 'thought.stop')) === 1, `⌘Z while a capture was on its way: the field holds "${await value(page)}", not the thought taken back`);
    await page.context().close();

    // A capture the core refuses.
    page = await home({ slow: 300, refuse: 'The core could not take it' });
    await page.keyboard.type('keep these words');
    await page.keyboard.press('Enter');
    await page.keyboard.type('and these');
    await page.waitForTimeout(600);
    expect((await value(page)) === 'keep these words\nand these', `a refused capture: the field holds ${JSON.stringify(await value(page))}`);
    expect((await page.locator('.capture .way.failed').textContent().catch(() => '')).includes('could not take it'), 'a refused capture: the core\'s sentence is not shown under the field');
    await page.context().close();

    // The field's height: measured when its words or its width change, and at no other time.
    for (const where of ['Home', 'the capture sheet', 'the notch']) {
      const notch = where === 'the notch', field = where === 'the capture sheet' ? `.sheet ${FIELD}` : FIELD, most = where === 'Home' ? 6 : 3;
      page = await open(browser, { label: notch ? 'notch' : 'workspace', records: scene('normal'), url: server.url, dpr: 1 });
      if (notch) (await page.evaluate((g) => window.__fake.emit(g), GEO), await page.evaluate(() => window.__fake.emit({ do: 'capture' })));
      else if (field !== FIELD) await page.evaluate(() => (window.__ws.ui.sheet = { kind: 'capture' }, window.__motion.redraw()));
      await page.waitForTimeout(800);
      await page.focus(field);
      const height = () => page.evaluate((f) => document.querySelector(f).getBoundingClientRect().height, field);
      const up = [await height()];
      for (let line = 1; line <= most + 2; line++) {
        if (line > 1) await page.keyboard.press('Shift+Enter');
        await page.keyboard.type('line');
        up.push(await height());
      }
      const down = [];
      for (let line = most + 2; line > 1; line--) {
        for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
        down.push(await height());
      }
      const step = up[2] - up[1], grows = up.every((h, i) => (i < 2 ? h === up[0] : i <= most ? h - up[i - 1] === step : h === up[most]));
      expect(step > 10 && grows, `${where}: the field does not grow a line at a time up to ${most} lines and no further (its height by lines, from none: ${up.join(' ')})`);
      expect(down.reverse().every((h, i) => h === up[i + 1]), `${where}: the field does not shrink as it grew (${up.join(' ')} up, ${down.join(' ')} by lines after)`);
      // Renders that change nothing: the measure writes the field's height, so none is to be written.
      const measured = await page.evaluate(async ([f, redraw]) => {
        let n = 0;
        const watch = new MutationObserver((ms) => (n += ms.length));
        watch.observe(document.querySelector(f), { attributes: true, attributeFilter: ['style'] });
        for (let i = 0; i < 20; i++) (redraw ? window.__look({}) : window.__motion.redraw(), await new Promise((ok) => requestAnimationFrame(ok)));
        n += watch.takeRecords().length;
        return n;
      }, [field, notch]);
      expect(measured === 0, `${where}: 20 renders that changed nothing measured the field ${measured / 2} times`);
      if (!notch) {
        await page.keyboard.type(' and words enough to wrap onto a second line here, and then onto a third');
        const wide = await height();
        await page.setViewportSize({ width: 400, height: 760 });
        await page.waitForTimeout(300);
        expect((await height()) > wide, `${where}: the field did not follow its width (${wide} px high, then ${await height()} in a narrower window)`);
      }
      for (const e of page.errors) failures.push(`${where}: ${e}`);
      await page.context().close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? `FAIL  the Composer's field: ${failures.length} things wrong` : 'PASS  the Composer\'s field takes every key while a capture is on its way, keeps what was typed for the next thought, sends a thought once, takes one back with ⌘Z, gets a refused one\'s words back, and is measured only when its words or its width change, growing and shrinking a line at a time');
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
