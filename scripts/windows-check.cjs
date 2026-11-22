// A workspace in a window of its own (docs/rebuild-plan.md, windows). Headless, from ui/dist on fixture records, with
// real pointer and key events, against a stand-in host that keeps what the page asks of its window. It fails when
// - a workspace's row in the sidebar has no icon that opens it in a new window ("Open in new window"), or shows it at
//   rest, or not under the pointer or with keyboard focus on the row, or its target is smaller than 20 px, or a click
//   on it does not ask the host to take that workspace out (`host.window pop`, with the project and a size);
// - ⇧⌘N (Ctrl+Shift+N on Windows) does not ask for the same, for the workspace in view;
// - a workspace the host says is out keeps its streams open in this page, or stays in view here, or shows no mark on
//   its row, or the mark is not the same icon, or a click on its row does anything but bring its window forward
//   (`host.window front`), or it still offers to open it;
// - a workspace the host says came back is not in view, or keeps its mark;
// - the page of a workspace's own window (`?project=`) has a sidebar, Home, a way to a sidebar, or any view but its
//   workspace; shows no terminal at once; does not name its window for its workspace; does not place a task begun
//   in it into its workspace; does not leave Home, Settings and opening a folder to the main window; stays when its
//   workspace is closed; or counts as in use while another window has the keyboard.
// With --pictures DIR it also writes a workspace's window, the main window with one workspace out, and the row's icon
// under the pointer, at 2x.
// usage: node scripts/windows-check.cjs [--dist folder] [--pictures folder]   (ui/dist must be built)
const path = require('node:path');
const fs = require('node:fs');
const { serve, open } = require('./motion-pages.cjs');
const { scene } = require('./instrument-fixtures.cjs');
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const dist = path.resolve(arg('--dist') || path.join(__dirname, '../ui/dist'));
const pictures = arg('--pictures') && path.resolve(arg('--pictures'));

async function main() {
  const { chromium } = require('playwright');
  const server = await serve(dist);
  const browser = await chromium.launch({ headless: true });
  const failures = [];
  const check = (ok, what) => (console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`), ok || failures.push(what));
  if (pictures) fs.mkdirSync(pictures, { recursive: true });
  const r = scene('busy');
  const cuegrid = r.ids.projects.cuegrid;
  const row = (id) => `section.ws[data-workspace="${id}"] .row.w`;
  const asked = (page) => page.evaluate(() => window.__fake.windows ?? []);
  const shell = async (query = '') => {
    const page = await open(browser, { label: 'workspace', records: structuredClone(r), url: server.url, dpr: 2, query });
    return page;
  };
  const ctrl = (page) => page.evaluate(() => navigator.platform).then((p) => (/Mac/.test(p) ? 'Meta' : 'Control'));

  // The main window: the icon on the row.
  let page = await shell();
  await page.locator(row(cuegrid) + ' .name').click();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(150);
  const icon = page.locator(row(cuegrid) + ' .pop');
  check((await icon.getAttribute('aria-label')) === 'Open in new window', 'the row has an icon named "Open in new window"');
  check(+(await icon.evaluate((e) => getComputedStyle(e).opacity)) === 0, 'the icon is not shown at rest');
  await page.locator(row(cuegrid)).hover();
  await page.waitForTimeout(200);
  check(+(await icon.evaluate((e) => getComputedStyle(e).opacity)) > 0.5, 'the icon shows under the pointer');
  check(await icon.evaluate((e) => { const b = e.getBoundingClientRect(), top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return e.contains(top) && getComputedStyle(e).backgroundColor === 'rgba(0, 0, 0, 0)'; }), 'under the pointer the icon is what is met, and has no ground of its own');
  const box = await icon.boundingBox();
  check(box.width >= 20 && box.height >= 20, `the icon's target is at least 20 px (${box.width}×${box.height})`);
  if (pictures) await page.screenshot({ path: path.join(pictures, 'row-icon-pointer.png'), clip: { x: 0, y: 30, width: 300, height: 240 } });
  await page.mouse.move(2, 2);
  await page.locator(row(cuegrid) + ' .name').focus();
  await page.waitForTimeout(200);
  check(+(await icon.evaluate((e) => getComputedStyle(e).opacity)) > 0.5, 'the icon shows with keyboard focus on the row');
  await icon.click();
  let calls = await asked(page);
  const pop = calls.find((c) => c.do === 'pop');
  check(pop && pop.project === cuegrid && pop.w > 400 && pop.h > 300, `a click on the icon asks for the workspace out, with a size (${JSON.stringify(pop)})`);
  await page.evaluate(() => (window.__fake.windows = []));
  await page.locator(row(cuegrid) + ' .name').click();
  await page.keyboard.press(`${await ctrl(page)}+Shift+KeyN`);
  await page.waitForTimeout(100);
  calls = await asked(page);
  check(calls.some((c) => c.do === 'pop' && c.project === cuegrid), '⇧⌘N asks for the workspace in view out');

  // It goes out: its streams close here, another view is shown, its row has the mark.
  const terminal = await page.evaluate((p) => window.__ws.L.tabs(window.__ws.layout(p))[0], cuegrid);
  check(await page.evaluate((t) => !!window.__ws.engines.get(t)?.attached, terminal), 'in view, its terminal is attached');
  await page.evaluate((p) => window.__fake.emit({ do: 'windows', out: [p], back: null }), cuegrid);
  await page.waitForTimeout(300);
  check(await page.evaluate(([t, p]) => window.__ws.engines.get(t)?.attached === false && window.__ws.ui.view !== p, [terminal, cuegrid]), 'out, its terminal has let go of its stream and the workspace is not in view here');
  check((await page.locator(row(cuegrid) + ' .mark .i').count()) === 1 && (await page.locator(row(cuegrid) + ' .pop').count()) === 0, 'out, its row shows the mark and no longer offers to open it');
  const same = await page.evaluate((p) => {
    const a = document.querySelector(`section.ws[data-workspace="${p}"] .row.w .mark svg`)?.innerHTML;
    return !!a && a === document.querySelector('section.ws .row.w .pop svg')?.innerHTML;
  }, cuegrid);
  check(same, 'the mark is the icon that opens the window');
  if (pictures) await page.screenshot({ path: path.join(pictures, 'main-one-out.png') });
  await page.evaluate(() => (window.__fake.windows = []));
  await page.locator(row(cuegrid) + ' .name').click();
  await page.waitForTimeout(100);
  calls = await asked(page);
  check(calls.length === 1 && calls[0].do === 'front' && calls[0].project === cuegrid && (await page.evaluate((p) => window.__ws.ui.view !== p, cuegrid)),
    `a click on its row brings its window forward and shows nothing here (${JSON.stringify(calls)})`);

  // It comes back.
  await page.evaluate((p) => window.__fake.emit({ do: 'windows', out: [], back: p }), cuegrid);
  await page.waitForTimeout(300);
  check(await page.evaluate((p) => window.__ws.ui.view === p, cuegrid), 'back, the workspace is in view');
  check((await page.locator(row(cuegrid) + ' .mark').count()) === 0, 'back, its row has no mark');
  check(!page.errors.length, `the main window said nothing wrong (${page.errors.join('; ')})`);
  await page.context().close();

  // The page of a workspace's own window.
  page = await shell(`?project=${cuegrid}`);
  check((await page.locator('.side').count()) === 0, 'its window has no sidebar');
  check(await page.evaluate((p) => window.__ws.ui.view === p, cuegrid), 'it shows its workspace');
  check((await page.locator('.bar .crumb b').first().textContent()) === 'cuegrid', 'it names its workspace in its top row');
  check((await page.locator('.bar [aria-label="Show sidebar"]').count()) === 0, 'it has no way to a sidebar');
  check((await page.locator('.xterm').count()) > 0 && (await page.evaluate(() => [...window.__ws.engines.values()].some((e) => e.attached))), 'its terminal is attached');
  calls = await asked(page);
  check(calls.some((c) => c.do === 'title' && c.text === 'cuegrid') && calls.some((c) => c.do === 'out') === false, `it names its window for its workspace (${JSON.stringify(calls)})`);
  check(await page.evaluate(() => (window.__ws.show('home'), window.__ws.ui.view !== 'home')), 'it does not go to Home');
  await page.evaluate(() => window.__ws.command('sidebar'));
  await page.waitForTimeout(100);
  check((await page.locator('.side').count()) === 0, 'the sidebar command brings no sidebar');
  await page.evaluate(() => (window.__fake.windows = []));
  await page.evaluate(() => window.__ws.command('settings'));
  await page.evaluate(() => window.__ws.command('open-workspace'));
  calls = await asked(page);
  check(calls.filter((c) => c.do === 'menu').map((c) => c.id).join() === 'settings,open-workspace' && !(await page.evaluate(() => !!window.__ws.ui.sheet)), 'Settings and opening a folder are left to the main window');
  await page.evaluate(() => window.__ws.command('new-task'));
  await page.waitForTimeout(100);
  check(await page.evaluate((p) => window.__ws.ui.sheet?.kind === 'capture' && window.__speech.cap.usual === p, cuegrid), 'a task begun in it is placed in its workspace');
  await page.evaluate(() => window.__ws.dismiss());
  if (pictures) await page.screenshot({ path: path.join(pictures, 'workspace-window.png') });
  await page.evaluate((p) => window.__fake.emit({ do: 'where', front: true, window: `ws-${p}`, full: false, notch: false, place: null, question: null }), cuegrid);
  await page.waitForTimeout(100);
  check(await page.evaluate(() => window.__ws.ui.active), 'it is in use while it has the keyboard');
  await page.evaluate(() => window.__fake.emit({ do: 'where', front: true, window: 'workspace', full: false, notch: false, place: null, question: null }));
  await page.waitForTimeout(100);
  check(await page.evaluate(() => !window.__ws.ui.active), 'it is not in use while the main window has the keyboard');
  await page.evaluate((p) => window.__fake.push({ t: 'change', rev: 900, sets: [{ c: 'projects', put: [{ ...window.__fake.records.projects.find((x) => x.id === p), open: false, rev: 900 }] }] }), cuegrid);
  await page.waitForTimeout(200);
  calls = await asked(page);
  check(calls.some((c) => c.do === 'close'), 'it closes when its workspace is closed');
  check(!page.errors.length, `its page said nothing wrong (${page.errors.join('; ')})`);
  await page.context().close();

  await browser.close();
  server.close();
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => (console.error(e), process.exit(1)));
