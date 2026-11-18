// Links in terminals, with a real pointer and real keys, in headless Chromium on the built pages and fixture records
// (the stand-in host answers `host.open` from the scene's `files`, and keeps what it was asked to open). It fails when:
// - a path that exists, a web address or a program's own hyperlink is underlined under the pointer without ⌘, or is
//   not underlined with it;
// - a plain click on one opens anything, a ⌘-click does not, or ⇧⌘-click does not ask for Finder;
// - a path that does not exist is a link;
// - the real target is not said at the terminal's foot where the text does not say it, or is said where it does.
// usage: node scripts/links-check.cjs [outdir]   (ui/dist must be built; with outdir, pictures of each link are kept)
const fs = require('node:fs');
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
const { scene } = require('./instrument-fixtures.cjs');

// Where `needle` is on a terminal's screen, and what stands at the terminal's foot.
const where = ([id, needle]) => {
  const e = window.__ws.engines.get(id), b = e.term.buffer.active;
  for (let y = 0; y < b.length; y++) {
    const x = (b.getLine(y)?.translateToString(true) ?? '').indexOf(needle);
    if (x < 0) continue;
    const r = e.element.querySelector('.xterm-rows').getBoundingClientRect();
    return { x: r.left + ((x + 2.5) * r.width) / e.term.cols, y: r.top + ((y - b.viewportY + 0.5) * r.height) / e.term.rows };
  }
  return null;
};
const state = ([id, needle]) => {
  const e = window.__ws.engines.get(id), tip = e.element.querySelector('.term-link');
  return {
    // The line a link has under the pointer is a whole one; a program's own hyperlink has a dashed one at rest.
    underlined: [...e.element.querySelectorAll('.xterm-rows span')].filter((s) => getComputedStyle(s).textDecorationLine.includes('underline') && getComputedStyle(s).textDecorationStyle === 'solid')
      .map((s) => s.textContent.replace(/\u00a0/g, ' ')).join(''),
    hand: getComputedStyle(e.element.querySelector('.xterm-screen')).cursor === 'pointer',
    tip: tip && getComputedStyle(tip).display !== 'none' ? tip.textContent : '',
    opened: window.__fake.opened.map((o) => `${o.reveal ? 'show ' : ''}${o.real}`),
    previews: [...window.__ws.records.previews.values()].map((p) => p.target),
    needle,
  };
};

async function main(out) {
  const { chromium } = require('playwright');
  if (out) fs.mkdirSync(out, { recursive: true });
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true });
  const failures = [];
  const expect = (ok, what) => ok || failures.push(what);
  try {
    const records = scene('workspace');
    const page = await open(browser, { label: 'workspace', records, url: server.url, viewport: { width: 1180, height: 820 } });
    await page.evaluate((p) => window.__ws.show(p), records.ids.projects.cuegrid);
    await page.locator(`.tab[data-id="${records.ids.devsrv.terminal}"]`).click();
    await page.waitForTimeout(900);
    const real = (p) => `/Users/example/projects/cuegrid/${p}`;
    // name, terminal, the text pointed at, what the host is asked to open, what the foot says (nothing: the text says it).
    const links = [
      ['path', records.ids.timer.terminal, 'src/rehearsal/Timer.tsx', real('src/rehearsal/Timer.tsx'), '~/projects/cuegrid/src/rehearsal/Timer.tsx'],
      ['address', records.ids.devsrv.terminal, 'http://localhost:5173/', 'http://localhost:5173/', '', true],
      ['hyperlink', records.ids.devsrv.terminal, 'the shared preview', 'https://preview.cuegrid.example/rehearsal-05', 'https://preview.cuegrid.example/rehearsal-05'],
    ];
    for (const [name, id, needle, target, says, shown] of links) {
      const at = await page.evaluate(where, [id, needle]);
      if (!at) { failures.push(`${name}: ${needle} is not on the screen`); continue; }
      const before = (await page.evaluate(state, [id, needle])).opened.length;
      await page.mouse.move(at.x, at.y - 40);
      await page.mouse.move(at.x, at.y, { steps: 3 });
      await page.waitForTimeout(250);
      let s = await page.evaluate(state, [id, needle]);
      expect(!s.underlined && !s.hand && !s.tip, `${name}: without ⌘ it shows as a link (${JSON.stringify(s)})`);
      await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(150);
      expect((await page.evaluate(state, [id, needle])).opened.length === before, `${name}: a plain click opened it`);
      await page.mouse.move(at.x, at.y - 40);
      await page.keyboard.down('Meta');
      await page.mouse.move(at.x, at.y, { steps: 3 });
      await page.waitForTimeout(250);
      s = await page.evaluate(state, [id, needle]);
      expect(s.underlined.includes(needle) && s.hand, `${name}: with ⌘ it is not underlined under the pointer (${JSON.stringify(s)})`);
      expect(says ? s.tip.startsWith(says) : !s.tip, `${name}: the foot says ${JSON.stringify(s.tip)}, not ${JSON.stringify(says)}`);
      if (out) await page.screenshot({ path: path.join(out, `link-${name}.png`) });
      await page.mouse.click(at.x, at.y);
      await page.keyboard.down('Shift');
      await page.mouse.click(at.x, at.y);
      await page.keyboard.up('Shift');
      await page.keyboard.up('Meta');
      await page.waitForTimeout(200);
      s = await page.evaluate(state, [id, needle]);
      // What can be shown beside the terminal (an address of this machine) is, by ⌘-click; the host is asked for the rest.
      if (shown) expect(s.previews.includes(target) && s.opened.length === before + 1 && s.opened.at(-1) === `show ${target}`, `${name}: ⌘-click did not show it beside the terminal (${JSON.stringify(s.previews)}), or ⇧⌘-click asked the host for ${JSON.stringify(s.opened.slice(before))}`);
      else expect(s.opened.at(-2) === target && s.opened.at(-1) === `show ${target}` && !s.previews.includes(target), `${name}: ⌘-click and ⇧⌘-click asked the host for ${JSON.stringify(s.opened.slice(before))}`);
      // ⌥ does the other of the two: what is previewed goes to the host, what is not is shown beside the terminal.
      await page.keyboard.down('Meta');
      await page.keyboard.down('Alt');
      await page.mouse.click(at.x, at.y);
      await page.keyboard.up('Alt');
      await page.keyboard.up('Meta');
      await page.waitForTimeout(250);
      s = await page.evaluate(state, [id, needle]);
      if (name !== 'hyperlink') expect(shown ? s.opened.at(-1) === target : s.previews.includes(target), `${name}: ⌥⌘-click did not do the other of the two (${JSON.stringify([s.previews, s.opened.slice(before)])})`);
      expect(!s.underlined && !s.tip, `${name}: it still shows as a link once ⌘ is let go`);
    }
    // A path nothing is at is no link, even with ⌘.
    const none = await page.evaluate(where, [records.ids.devsrv.terminal, '/src/rehearsal/timer.css']);
    await page.keyboard.down('Meta');
    await page.mouse.move(none.x, none.y - 30);
    await page.mouse.move(none.x, none.y, { steps: 3 });
    await page.waitForTimeout(250);
    const s = await page.evaluate(state, [records.ids.devsrv.terminal, '']);
    await page.keyboard.up('Meta');
    expect(!s.underlined && !s.hand, `a path that does not exist shows as a link (${JSON.stringify(s)})`);
    for (const e of page.errors) failures.push(`the page said ${e}`);
  } finally {
    await browser.close();
    await server.close();
  }
  for (const f of failures) console.log(`FAIL  ${f}`);
  console.log(failures.length ? `FAIL  links in terminals: ${failures.length} things wrong`
    : 'PASS  in a terminal a path that exists, a web address and a program\'s own hyperlink are links only while ⌘ is held: underlined under the pointer, shown beside the terminal by ⌘-click where it can be (a web address of this machine) and opened through the host otherwise, the other of the two by ⌥⌘-click, shown in Finder by ⇧⌘-click, their real target said where the text does not say it; a plain click opens nothing, and a path nothing is at is no link');
  if (failures.length) process.exitCode = 1;
}
main(process.argv[2] && path.resolve(process.argv[2])).catch((e) => (console.error(e), process.exit(1)));
