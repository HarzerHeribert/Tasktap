// A page in a preview's frame (preview.tsx, host/src/frames.rs), in headless Chromium on the built page and fixture
// records, with a web server of the check's own on this machine as the local address shown. It fails when:
// - the pane shows anything but the window's dark ground while a page loads: the frame was white before the page had
//   drawn anything of its own, a flash on the dark ground each time one was opened or reloaded;
// - a page longer and wider than its frame shows a scrollbar, with the host's start-up script for frames (frames.rs
//   `BARS`) given to every frame as the host gives it. The browser here is let draw bars (Playwright hides them by
//   default), and a page that draws its own is shown keeping it: the app does not speak for a page's own styles;
// - the frame is not shown once the page is there.
// The host gives the same script on a Mac, where host/scripts/smoke.sh reads in the app what WebKit makes of it.
// usage: node scripts/frame-check.cjs [outdir]   (exit status 1 on a failure; ui/dist must be built; with outdir, a
// picture while the page loads and one once it is there)
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const { serve, open } = require('./motion-pages.cjs');
const { scene, flow } = require('./instrument-fixtures.cjs');

/** The host's start-up script for frames, as frames.rs has it; none in a host that gives none. */
const BARS = /pub const BARS: &str = r#"([\s\S]*?)"#;/.exec(fs.readFileSync(path.join(__dirname, '../host/src/frames.rs'), 'utf8'))?.[1] ?? '';
const LONG = '<p>' + 'A line of what the agent served, long enough to need scrolling down and across. '.repeat(40) + '</p>';
const PAGES = {
  // White and plain, as most pages are, sent after a pause so that the moment before it draws can be seen.
  '/slow.html': { wait: 1500, body: `<!doctype html><title>Slow</title><body style="margin:24px;font:16px system-ui;background:#fff"><div style="width:2400px">${LONG.repeat(30)}</div>` },
  // A page that draws its own scrollbar.
  '/own.html': { wait: 0, body: `<!doctype html><title>Own</title><style>html{scrollbar-width:auto;scrollbar-color:#c03 #fff}</style><body style="margin:24px;font:16px system-ui"><div style="width:2400px">${LONG.repeat(30)}</div>` },
};

/** One pixel of the page, from a screenshot of it alone: [r, g, b]. With one pixel, every filter of a PNG row is
 *  the bytes themselves. */
async function pixel(page, x, y) {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  let at = 8, idat = [], channels = 4;
  while (at < png.length) {
    const len = png.readUInt32BE(at), type = png.toString('ascii', at + 4, at + 8), data = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') channels = { 2: 3, 6: 4 }[data[9]] ?? 4;
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3], channels];
}
const light = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

async function main(out) {
  const { chromium } = require('playwright');
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const pages = http.createServer((req, res) => {
    const p = PAGES[req.url.split('?')[0]];
    if (!p) return void (res.writeHead(404), res.end());
    setTimeout(() => (res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }), res.end(p.body)), p.wait);
  });
  await new Promise((ok) => pages.listen(0, '127.0.0.1', ok));
  const at = `http://127.0.0.1:${pages.address().port}`;
  // Bars drawn as a browser draws them where nothing hides them.
  const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const failures = [], seen = [];
  const shown = async (target) => {
    const records = flow(scene('workspace'), 'preview-web');
    Object.assign(records.previews[0], { target, title: target.replace(/^https?:\/\/|\/.*$/g, '') });
    records.listens = true;
    const page = await open(browser, { label: 'workspace', records, url: server.url, dpr: 1, viewport: { width: 1180, height: 760 } });
    if (BARS) await page.context().addInitScript(BARS);
    await page.evaluate(() => (window.__ws.show(window.__fake.records.ids.projects.cuegrid), window.__motion.redraw()));
    return page;
  };
  /** The frame of `url` once its page is there, waiting for that up to a limit. */
  const frameOf = async (page, url) => {
    for (let i = 0; i < 100; i++) {
      const f = page.frames().find((x) => x.url().startsWith(url));
      if (f) return f.waitForLoadState('load').then(() => f, () => f);
      await page.waitForTimeout(100);
    }
    return null;
  };
  // In the frame: its scrollers, the page's own and one made to scroll, as this browser draws them. Bars here may be
  // the kind that take no room, which only show while a page scrolls, so what the frame's styles say is read too.
  const scrollers = () => {
    const t = Object.assign(document.createElement('div'), { style: 'overflow:scroll;width:60px;height:60px' });
    document.body.append(t);
    const r = { root: getComputedStyle(document.documentElement).scrollbarWidth, made: getComputedStyle(t).scrollbarWidth, side: innerWidth - document.documentElement.clientWidth, inner: t.offsetWidth - t.clientWidth, scrolls: document.documentElement.scrollHeight > innerHeight };
    t.remove();
    return r;
  };
  try {
    // While the page loads: the dark ground. Once it is there: the page.
    const page = await shown(`${at}/slow.html`);
    await page.waitForSelector('.pv iframe', { timeout: 5000 });
    await page.waitForTimeout(500);
    // A point in the page's margin, where it is its own ground and no word.
    const box = await page.evaluate(() => { const r = document.querySelector('.pv iframe').getBoundingClientRect(); return { x: Math.round(r.x + 10), y: Math.round(r.y + 10) }; });
    const before = await pixel(page, box.x, box.y);
    if (out) await page.screenshot({ path: path.join(out, 'frame-loading.png') });
    seen.push(`while it loads ${before.slice(0, 3).join(',')}`);
    if (light(before) > 0.1) failures.push(`while a page loads its pane is light (${before.slice(0, 3).join(', ')}), not the dark ground: a flash before the page has drawn`);
    const slow = await frameOf(page, `${at}/slow.html`);
    await page.waitForTimeout(400);
    const after = await pixel(page, box.x, box.y);
    if (out) await page.screenshot({ path: path.join(out, 'frame-drawn.png') });
    seen.push(`drawn ${after.slice(0, 3).join(',')}`);
    if (light(after) < 0.9) failures.push(`once the page is there its pane is not the page's white (${after.slice(0, 3).join(', ')}): the frame is not shown`);
    // No bars: the frame's scrollers take no room, and its styles say none is drawn.
    const bars = slow ? await slow.evaluate(scrollers) : null;
    seen.push(`the page's scrollers ${JSON.stringify(bars)}`);
    if (!bars) failures.push('the page in the frame could not be read');
    else if (!bars.scrolls) failures.push('the page does not scroll in its frame, so its bars cannot be judged');
    else if (bars.side || bars.inner || bars.root !== 'none' || bars.made !== 'none')
      failures.push(`a page in a frame shows scrollbars: its own takes ${bars.side} px and one inside it ${bars.inner} px, and their styles say ${bars.root} and ${bars.made}, not none`);
    await page.context().close();
    // A page that sets its own bar keeps it: its own styles are its own.
    const own = await shown(`${at}/own.html`);
    const frame = await frameOf(own, `${at}/own.html`);
    const mine = frame ? await frame.evaluate(scrollers) : null;
    seen.push(`a page's own bar ${JSON.stringify(mine)}`);
    if (mine?.root !== 'auto') failures.push(`a page that sets its own scrollbar has it overruled (${mine?.root}): the app does not speak for a page's own styles`);
    await own.context().close();
  } finally {
    await browser.close();
    await server.close();
    pages.close();
  }
  console.log(`measured: ${seen.join('; ')}; the host's script for frames: ${BARS ? 'given' : 'none'}`);
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? `FAIL  frames: ${failures.length} things wrong` : 'PASS  a page in a preview\'s frame waits on the dark ground until it is there, then shows; its scrollers show no bar, and a page that draws its own keeps it');
  process.exitCode = failures.length ? 1 : 0;
}
main(process.argv[2] && path.resolve(process.argv[2])).catch((e) => (console.error(e), process.exit(1)));
