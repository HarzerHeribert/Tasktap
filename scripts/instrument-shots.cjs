// Renders the Instrument pages from ui/dist in headless Chromium on fixture records (instrument-fixtures.cjs), no host:
// the four states of Home and its layers, the workspace with splits, its sheets, the narrow window, light and dark
// terminal themes, and the notch. usage: node scripts/instrument-shots.cjs <outdir> [dpr...] [--only name,name]
const fs = require('node:fs');
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
const { scene } = require('./instrument-fixtures.cjs');

const WS = { label: 'workspace' };
const ws = (records, act) => ({ ...WS, records, act });
const show = (key) => async (page, r) => page.evaluate((id) => window.__ws.show(id), r.ids.projects[key]);
const sheet = (s) => async (page, r) => page.evaluate((x) => (window.__ws.ui.sheet = x, window.__motion.redraw()), typeof s === 'function' ? s(r) : s);
const both = (...fs) => async (page, r) => { for (const f of fs) await f(page, r); };

function shots() {
  const S = (n, o) => scene(n, o);
  return {
    'home-busy': ws(S('busy')),
    'home-normal': ws(S('normal')),
    'home-quiet': ws(S('quiet')),
    'home-first': ws(S('first')),
    'home-busy-results': ws(S('busy'), (p) => p.evaluate(() => (window.__ws.ui.fold = 'results', window.__motion.redraw()))),
    'home-busy-ideas': ws(S('busy'), (p) => p.evaluate(() => (window.__ws.ui.fold = 'ideas', window.__motion.redraw()))),
    'home-busy-earlier': ws(S('busy'), (p) => p.evaluate(() => window.__ws.show('earlier'))),
    'home-agents': ws(S('busy'), sheet({ kind: 'agents' })),
    'home-settings': ws(S('busy'), sheet({ kind: 'settings' })),
    'home-capture': ws(S('normal'), sheet({ kind: 'capture' })),
    'home-busy-narrow': { ...ws(S('busy')), viewport: { width: 720, height: 540 } },
    'home-quiet-narrow': { ...ws(S('quiet')), viewport: { width: 720, height: 540 } },
    'ws': ws(S('workspace'), show('cuegrid')),
    'ws-solarized': ws(S('workspace', { theme: 'solarized' }), show('cuegrid')),
    'ws-midnight': ws(S('workspace', { theme: 'midnight' }), show('cuegrid')),
    'ws-dialog': ws(S('workspace'), both(show('cuegrid'), sheet((r) => ({ kind: 'close-tab', project: r.ids.projects.cuegrid, id: r.ids.export.terminal })))),
    'ws-capture': ws(S('workspace'), both(show('cuegrid'), sheet({ kind: 'capture' }))),
    'ws-review': ws(S('workspace'), both(show('cuegrid'), sheet((r) => ({ kind: 'review', thought: r.ids.pdf.thought })))),
    'ws-discard': ws(S('workspace'), both(show('cuegrid'), sheet((r) => ({ kind: 'settle', thought: r.ids.pdf.thought, keep: false })))),
    'ws-keep-running': ws(S('workspace'), both(show('cuegrid'), sheet((r) => ({ kind: 'settle', thought: r.ids.pdf.thought, keep: true })))),
    'ws-result': ws(S('workspace'), both(show('cuegrid'), (p, r) => p.evaluate((id) => {
      const l = window.__ws.layout(id.p); const pa = window.__ws.L.panes(l)[0]; pa.active = id.t; window.__motion.redraw();
    }, { p: r.ids.projects.cuegrid, t: r.ids.pdf.terminal }))),
    'ws-ledger': ws(S('workspace'), show('ledger')),
    'ws-narrow': { ...ws(S('workspace'), show('cuegrid')), viewport: { width: 720, height: 540 } },
  };
}

const geometry = (cutout) => ({ do: 'geometry', width: cutout ? 185 : 120, height: cutout ? 32 : 20, cutout, compact: false, surfaceWidth: 420, surfaceOffset: 0, span: 560,
  pixel: 2, corner: 10, offset: 0, available: 700, collapsed: false });
function notchShots() {
  const out = {};
  for (const cut of [true, false]) {
    const k = cut ? 'cut' : 'plain';
    out[`notch-${k}-idle`] = { records: scene('quiet'), act: [] , idle: true };
    out[`notch-${k}-busy`] = { records: scene('busy'), act: [], fold: true };
    out[`notch-${k}-question`] = { records: scene('busy'), act: [{ do: 'answer' }] };
    out[`notch-${k}-capture`] = { records: scene('normal'), act: [{ do: 'capture' }] };
    out[`notch-${k}-result`] = { records: scene('normal', { changes: true }), act: [{ do: 'hover-enter' }] };
    for (const v of Object.values(out)) v.cut ??= cut;
  }
  return out;
}

async function main(out, dprs, only) {
  const { chromium } = require('playwright');
  fs.mkdirSync(out, { recursive: true });
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true });
  let errors = 0;
  try {
    for (const dpr of dprs) {
      for (const [name, s] of Object.entries(shots())) {
        if (only && !only.includes(name)) continue;
        const page = await open(browser, { label: 'workspace', records: s.records, url: server.url, dpr, viewport: s.viewport });
        // The window's own buttons are the system's; drawn here so a capture reads as the window.
        await page.addStyleTag({ content: 'body::after{content:"";position:fixed;z-index:99;left:14px;top:13px;width:12px;height:12px;border-radius:50%;background:#ff5f57;box-shadow:20px 0 #febc2e,40px 0 #28c840;pointer-events:none}' });
        if (s.act) await s.act(page, s.records);
        await page.waitForTimeout(700);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: path.join(out, `app-${name}@${dpr}x.png`) });
        for (const e of page.errors) (errors++, console.error(`${name}: ${e}`));
        await page.context().close();
        console.log(name, dpr);
      }
      for (const [name, s] of Object.entries(notchShots())) {
        if (only && !only.includes(name)) continue;
        const page = await open(browser, { label: 'notch', records: s.records, url: server.url, dpr, viewport: { width: 560, height: 420 } });
        await page.evaluate(() => (document.documentElement.style.background = 'radial-gradient(110% 85% at 12% 0%,#41607c 0%,transparent 58%),radial-gradient(80% 80% at 92% 12%,#7b5c72 0%,transparent 52%),#172433'));
        await page.evaluate((g) => window.__fake.emit(g), geometry(s.cut));
        for (const a of s.act) await page.evaluate((x) => window.__fake.emit(x), a);
        // A question opens the notch by itself; folded, the collapsed glance shows who asks.
        if (s.fold) await page.evaluate(() => (document.querySelector('#tab').click(), 1));
        await page.waitForTimeout(900);
        await page.screenshot({ path: path.join(out, `app-${name}@${dpr}x.png`) });
        for (const e of page.errors) (errors++, console.error(`${name}: ${e}`));
        await page.context().close();
        console.log(name, dpr);
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  if (errors) process.exitCode = 1;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--only');
  const only = at >= 0 ? args.splice(at, 2)[1].split(',') : null;
  const [out, ...d] = args;
  if (!out) (console.error('usage: node scripts/instrument-shots.cjs <outdir> [dpr...] [--only a,b]'), process.exit(2));
  main(path.resolve(out), d.length ? d.map(Number) : [1, 2], only).catch((e) => (console.error(e), process.exit(1)));
}
module.exports = { shots, notchShots };
