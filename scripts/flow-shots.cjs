// Pictures of the routing and speech flows, from the built pages on fixture records (instrument-fixtures.cjs `flow`):
// the terms sheets, a thought being placed, held with its brief, asked about and saved for later, a recording, its
// words being written down, a failure, and the two parts of Settings; on Home, in the capture sheet and in the notch,
// in English and German, with a long thought and brief, at two pixels to a point and at one.
// usage: node scripts/flow-shots.cjs <outdir> [name-prefix]   (ui/dist must be built)
const fs = require('node:fs');
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
const { scene, flow } = require('./instrument-fixtures.cjs');

const GEO = { do: 'geometry', width: 104, height: 16, cutout: false, surfaceWidth: 420, surfaceOffset: 0, span: 560, pixel: 1, corner: 10, offset: 0, available: 700, collapsed: false };
// This page's dictation is the fixture's: the row the Composer or a reply shows.
const mine = (kind = 'thought', latched = false, field = '') => `(() => { const t = __speech.talk, d = __fake.records.dictations[0];
  Object.assign(t, { id: d.id, kind: '${kind}', latched: ${latched}, field: ${field ? `document.querySelector('${field}')` : 'null'} }); })()`;
const sheet = (s) => `(__ws.ui.sheet = ${JSON.stringify(s)})`;
const type = (text) => `(() => { const a = document.querySelector('#capture-input'); a.focus(); document.execCommand('insertText', false, ${JSON.stringify(text)}); })()`;

// name, page, scene, flow kind, its options, what to run in the page, what to cut out (a selector's box, padded).
const SHOTS = [
  ['terms-placing', 'workspace', 'normal', 'off', {}, sheet({ kind: 'placing' }), '.sheet'],
  ['terms-placing-read', 'workspace', 'normal', 'off', {}, `${sheet({ kind: 'placing' })}; __motion.redraw(); setTimeout(() => document.querySelector('.disc').click(), 300)`, '.sheet'],
  ['terms-placing-on', 'workspace', 'normal', 'plain', {}, sheet({ kind: 'placing', back: true }), '.sheet'],
  ['offer-first', 'workspace', 'first-folder', 'off', {}, '', '.capture'],
  ['settings-off', 'workspace', 'normal', 'no-service', { voice: false }, `(__fake.records.prefs.length = 0, ${sheet({ kind: 'settings' })})`, '.sheet'],
  ['settings-on', 'workspace', 'normal', 'plain', {}, sheet({ kind: 'settings' }), '.sheet'],
  ['terms-speech', 'workspace', 'normal', 'no-service', { voice: false }, sheet({ kind: 'speech' }), '.sheet'],
  ['terms-speech-other', 'workspace', 'normal', 'no-service', { voice: false }, `${sheet({ kind: 'speech' })}; __motion.redraw(); setTimeout(() => { document.querySelectorAll('.terms .seg button')[2].click(); setTimeout(() => { const a = document.querySelector('.terms input'); a.focus(); document.execCommand('insertText', false, 'http://speech.example.lan:8080'); }, 100); }, 300)`, '.sheet'],
  ['terms-speech-on', 'workspace', 'normal', 'plain', {}, sheet({ kind: 'speech' }), '.sheet'],
  ['home-placing', 'workspace', 'normal', 'placing', {}, '', '.capture'],
  ['home-placing-de', 'workspace', 'normal', 'placing', { lang: 'de' }, '', '.capture'],
  ['home-held', 'workspace', 'normal', 'held', {}, '', '.capture'],
  ['home-held-de', 'workspace', 'normal', 'held', { lang: 'de' }, '', '.capture'],
  ['home-held-long', 'workspace', 'normal', 'held', { long: true }, '', '.capture'],
  ['home-held-long-de', 'workspace', 'normal', 'held', { lang: 'de', long: true }, '', '.capture'],
  ['home-held-typing', 'workspace', 'normal', 'held', {}, type('And the next thought, typed while that one waits'), '.capture'],
  ['home-plain', 'workspace', 'normal', 'plain', {}, '', '.capture'],
  ['home-briefing', 'workspace', 'normal', 'briefing', { voice: false }, '', '.capture'],
  ['home-picked', 'workspace', 'normal', 'picked', {}, '', '.capture'],
  ['home-followup', 'workspace', 'normal', 'followup', {}, '', '.capture'],
  ['home-followup-model', 'workspace', 'normal', 'followup-model', {}, '', '.capture'],
  ['home-fallback', 'workspace', 'normal', 'fallback', {}, '', '.capture'],
  ['home-gone', 'workspace', 'normal', 'gone', {}, '', '.capture'],
  ['home-asked', 'workspace', 'normal', 'asked', {}, '', '.hx'],
  ['home-asked-de', 'workspace', 'normal', 'asked', { lang: 'de', long: true }, '', '.hx'],
  ['home-later', 'workspace', 'normal', 'later', {}, `(__ws.ui.fold = 'later')`, '.hx'],
  ['home-later-model', 'workspace', 'normal', 'later-model', {}, `(__ws.ui.fold = 'later')`, '.hx'],
  ['home-later-answer', 'workspace', 'normal', 'later-answer', {}, `(__ws.ui.fold = 'later')`, '.hx'],
  ['home-later-gone', 'workspace', 'normal', 'later-gone', {}, `(__ws.ui.fold = 'later')`, '.hx'],
  ['home-recording', 'workspace', 'normal', 'recording', {}, mine(), '.capture'],
  ['home-recording-latched', 'workspace', 'normal', 'recording', {}, mine('thought', true), '.capture'],
  ['home-recording-limit', 'workspace', 'normal', 'recording-long', {}, mine('thought', true), '.capture'],
  ['home-recording-text', 'workspace', 'normal', 'recording', {}, `${type('Fix the export test, and')}; ${mine('text', false, '#capture-input')}`, '.capture'],
  ['home-writing', 'workspace', 'normal', 'writing', {}, mine(), '.capture'],
  ['home-failed', 'workspace', 'normal', 'failed', {}, mine(), '.capture'],
  ['home-failed-heard', 'workspace', 'normal', 'failed-heard', { lang: 'de' }, mine(), '.capture'],
  ['home-no-service', 'workspace', 'normal', 'no-service', { voice: false }, `(__speech.talk.said = 'service')`, '.capture'],
  ['home-rings', 'workspace', 'busy', 'plain', {}, '', '.capture'],
  ['home-reply-recording', 'workspace', 'busy', 'recording', {}, mine('text', false, '.hq.open .reply input'), '.hsec.needs'],
  ['sheet-held', 'workspace', 'workspace', 'held', {}, `(__ws.show(Object.values(__fake.records.ids.projects)[0]), ${sheet({ kind: 'capture' })})`, '.sheet'],
  ['notch-placing', 'notch', 'normal', 'placing', {}, 'capture', '#sheet'],
  ['notch-held', 'notch', 'normal', 'held', {}, 'capture', '#sheet'],
  ['notch-held-de', 'notch', 'normal', 'held', { lang: 'de' }, 'capture', '#sheet'],
  ['notch-held-long-de', 'notch', 'normal', 'held', { lang: 'de', long: true }, 'capture', '#sheet'],
  ['notch-plain', 'notch', 'normal', 'plain', {}, 'capture', '#sheet'],
  ['notch-asked', 'notch', 'normal', 'asked', {}, 'answer', '#sheet'],
  ['notch-asked-de', 'notch', 'normal', 'asked', { lang: 'de' }, 'answer', '#sheet'],
  ['notch-recording', 'notch', 'normal', 'recording', {}, ['capture', mine()], '#sheet'],
  ['notch-recording-latched', 'notch', 'normal', 'recording', {}, ['capture', mine('thought', true)], '#sheet'],
  ['notch-writing', 'notch', 'normal', 'writing', {}, ['capture', mine()], '#sheet'],
  ['notch-failed', 'notch', 'normal', 'failed-heard', {}, ['capture', mine()], '#sheet'],
  ['notch-no-service', 'notch', 'normal', 'no-service', { voice: false }, ['capture', `(__speech.talk.said = 'service')`], '#sheet'],
  ['notch-reply-recording', 'notch', 'busy', 'recording', {}, ['answer', mine('text', false, '#sheet .reply input')], '#sheet'],
  ['notch-collapsed-asked', 'notch', 'normal', 'asked', {}, 'fold', '#tab'],
];

async function main(out, only = '') {
  const { chromium } = require('playwright');
  fs.mkdirSync(out, { recursive: true });
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true });
  let errors = 0;
  try {
    for (const [name, label, sc, kind, opts, act, cut] of SHOTS.filter((s) => s[0].startsWith(only)))
      for (const dpr of name.startsWith('home-held') || name === 'notch-held' ? [2, 1] : [2]) {
        const base = scene(sc === 'first-folder' ? 'normal' : sc);
        // A folder is open, an agent signed in, and nothing was ever captured: the moment placing is offered unasked.
        if (sc === 'first-folder') Object.assign(base, { thoughts: [], sessions: [], terminals: [], questions: [], results: [], layouts: [] });
        const records = flow(base, kind, opts);
        const page = await open(browser, { label, records, url: server.url, dpr, viewport: label === 'notch' ? { width: 560, height: 760 } : { width: 1180, height: 820 } });
        if (label === 'notch') {
          await page.evaluate((g) => window.__fake.emit(g), GEO);
          const [how, then] = Array.isArray(act) ? act : [act, ''];
          await page.evaluate((a) => window.__fake.emit({ do: a === 'fold' ? 'answer' : a }), how);
          await page.waitForTimeout(700);
          if (how === 'fold') await page.keyboard.press('Escape');
          if (then) await page.evaluate(`${then}; window.__look({})`);
        } else if (act) await page.evaluate(`${act}; window.__motion.redraw()`);
        await page.waitForTimeout(900);
        const box = await page.locator(cut).first().boundingBox();
        const pad = 14, clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: Math.min(box.height + 2 * pad, 820 - Math.max(0, box.y - pad)) };
        if (label === 'notch') Object.assign(clip, { y: 0, height: box.y + box.height + pad });
        const file = path.join(out, `${name}${dpr === 1 ? '@1x' : ''}.png`);
        await page.screenshot({ path: file, clip });
        for (const e of page.errors) (errors++, console.error(`${name}: ${e}`));
        await page.context().close();
        console.log(file);
      }
  } finally {
    await browser.close();
    await server.close();
  }
  if (errors) process.exitCode = 1;
}
if (!process.argv[2]) (console.error('usage: node scripts/flow-shots.cjs <outdir> [name-prefix]'), process.exit(2));
main(path.resolve(process.argv[2]), process.argv[3]).catch((e) => (console.error(e), process.exit(1)));
