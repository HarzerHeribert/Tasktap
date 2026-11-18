// The size a terminal is told, in headless Chromium on the built pages and fixture records (the stand-in core keeps
// every size a terminal is opened at or asked to take). A pane that cannot be measured (one not laid out yet, one
// squeezed to nothing) is no size: xterm.js's fit answers 2 columns by 1 row for it, and a shell started or told that
// draws its prompt two characters to a line (seen on Windows, where the console keeps what it drew). It fails when:
// - any terminal is opened at, or asked to take, fewer columns or rows than the floor (terminal.ts FLOOR);
// - the terminal in front is not opened at the size its pane has room for, at once and with no size before it;
// - a sheet opening over a terminal, or its pane going away and coming back, asks it for another size;
// - a window that grew does not ask the terminal in front for the larger size.
// usage: node scripts/terminal-size-check.cjs   (ui/dist must be built)
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
const { scene } = require('./instrument-fixtures.cjs');

const FLOOR = { cols: 20, rows: 4 };
const said = (s) => `${s.call.replace('terminal.', '')} ${s.cols}x${s.rows}`;

async function main() {
  const { chromium } = require('playwright');
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true });
  const failures = [];
  const expect = (ok, what) => ok || failures.push(what);
  try {
    const records = scene('workspace');
    const page = await open(browser, { label: 'workspace', records, url: server.url, viewport: { width: 1180, height: 760 } });
    const sizes = () => page.evaluate(() => window.__fake.sizes.slice());
    // What the pane of the terminal in front has room for, as xterm.js's fit measures it once the page is at rest.
    const room = () => page.evaluate(() => {
      const e = window.__ws.engines.get(window.__ws.current().id), d = e.fit.proposeDimensions();
      return { id: e.id, cols: d.cols, rows: d.rows };
    });
    const small = (all) => all.filter((s) => s.cols < FLOOR.cols || s.rows < FLOOR.rows);
    await page.evaluate((p) => window.__ws.show(p), records.ids.projects.cuegrid);
    await page.waitForTimeout(600);
    let all = await sizes(), front = await room();
    expect(all.length > 0, 'no terminal was opened when a workspace was shown');
    expect(!small(all).length, `a workspace shown: terminals were told ${small(all).map(said).join(', ')}, below the floor of ${FLOOR.cols}x${FLOOR.rows}`);
    let own = all.filter((s) => s.id === front.id);
    expect(own.length === 1 && own[0].cols === front.cols && own[0].rows === front.rows,
      `a workspace shown: the terminal in front was told ${own.map(said).join(', then ')}; its pane has room for ${front.cols}x${front.rows}, and that is the one size it is opened at`);

    // A sheet over the terminal, as a person meets it: New Task, then Settings. The pane keeps its size and so does the terminal.
    let before = all.length;
    for (const sheet of ['new-task', 'settings']) {
      await page.evaluate((s) => window.__ws.command(s), sheet);
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => !!window.__ws.ui.sheet), `${sheet} opened no sheet`);
      all = await sizes();
      expect(all.length === before, `with the ${sheet} sheet over it a terminal was told ${all.slice(before).map(said).join(', ')}`);
      await page.evaluate(() => window.__ws.dismiss());
      await page.waitForTimeout(300);
    }
    all = await sizes();
    expect(all.length === before, `a sheet closing told a terminal ${all.slice(before).map(said).join(', ')}`);

    // The pane squeezed to nothing and let go again, as a layout on its way does: no size is a measurement of that.
    for (const [what, css] of [['squeezed to nothing', 'width:0;height:0;overflow:hidden'], ['squeezed to a sliver', 'width:30px;height:20px;overflow:hidden'], ['taken out of the page', 'display:none']]) {
      await page.evaluate((style) => document.querySelector('.deck').setAttribute('style', style), css);
      await page.waitForTimeout(400);
      all = await sizes();
      expect(all.length === before, `its pane ${what}, a terminal was told ${all.slice(before).map(said).join(', ')}`);
      await page.evaluate(() => document.querySelector('.deck').removeAttribute('style'));
      await page.waitForTimeout(400);
      all = await sizes();
      expect(all.length === before, `its pane ${what} and back, a terminal was told ${all.slice(before).map(said).join(', ')}`);
      before = all.length;
    }

    // The window grown: the terminal in front is asked for the larger size, once.
    const was = await room();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(600);
    all = await sizes(), front = await room();
    own = all.slice(before).filter((s) => s.id === front.id);
    expect(front.cols > was.cols && front.rows > was.rows, `the window grew and the pane has room for ${front.cols}x${front.rows}, not more than ${was.cols}x${was.rows}`);
    expect(own.length === 1 && own[0].cols === front.cols && own[0].rows === front.rows, `the window grew: the terminal in front was told ${own.map(said).join(', then ') || 'nothing'}, its pane has room for ${front.cols}x${front.rows}`);
    expect(!small(all).length, `terminals were told ${small(all).map(said).join(', ')}, below the floor`);
    // A new terminal starts at the size of its pane: its shell draws its first prompt at that size.
    before = all.length;
    await page.evaluate(() => window.__ws.command('new-terminal'));
    await page.waitForTimeout(600);
    all = await sizes(), front = await room();
    own = all.slice(before).filter((s) => s.id === front.id);
    expect(own.length === 1 && own[0].call === 'terminal.open' && own[0].cols === front.cols && own[0].rows === front.rows,
      `a new terminal was told ${own.map(said).join(', then ') || 'nothing'}; its pane has room for ${front.cols}x${front.rows}, and that is the one size it starts at`);

    for (const e of page.errors) failures.push(`the page said ${e}`);
  } finally {
    await browser.close();
    await server.close();
  }
  for (const f of failures) console.log(`FAIL  ${f}`);
  console.log(failures.length ? `FAIL  the size a terminal is told: ${failures.length} things wrong`
    : `PASS  a terminal is opened at the size its pane has room for and at no other before it, never below ${FLOOR.cols}x${FLOOR.rows}; a sheet over it, and its pane squeezed to nothing and back, ask it for no size; a window that grew asks it for the larger one, once`);
  if (failures.length) process.exitCode = 1;
}
main().catch((e) => (console.error(e), process.exit(1)));
