// Renders where a thought goes, from ui/dist in headless Chromium on fixture records (instrument-fixtures.cjs), no host
// (docs/projects-design.md, the owner's decisions of 2026-11-19): the chip naming a project as speech writes it and one
// not open yet; the chip's list with nothing asked, with a thought already written (its three likeliest places first)
// and with its field finding a project; the question "Where should this go?" with three choices, Another project… and
// Keep for later, on Home and in the notch, and its field once Another project… is pressed; a thought on its way to a
// project not open yet. Invented projects only. usage: node scripts/placing-shots.cjs <outdir> [dpr...] [--only a,b]
const fs = require('node:fs');
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
const { scene } = require('./instrument-fixtures.cjs');

const DAY = 86400000;
/** Projects Tasktap knows and has not opened, from the world of core/scripts/place-eval.json. */
function known(r, now) {
  const card = (n, name, about, more = {}) => ({ id: `019a8b6c-7d10-7000-8000-0000000c00${String(n).padStart(2, '0')}`, rev: 1, folder: `/Users/someone/projects/${name}`, name, names: [], about,
    about_from: 'README.md', why: ['agent', 'git'], agents: ['claude'], repo: null, copy_of: null, inside: null, project_id: null, used: now - n * DAY, looks: [], hidden: false, main: false, available: true, ...more });
  const cards = {
    pyrite: card(1, 'pyrite', 'Property-based testing helpers for Python'),
    kiln: card(2, 'kiln', 'A static site generator with incremental builds'),
    harbormaster: card(3, 'harbormaster', 'Deploys containers to a small fleet over SSH'),
    quaycast: card(4, 'quaycast', 'Podcast hosting: feeds, episode uploads and download statistics'),
  };
  r.cards = Object.values(cards);
  return cards;
}

function records(name, now = Date.now()) {
  const r = scene('normal', { now }), P = r.ids.projects, c = known(r, now);
  const to = (x) => (x.folder ? { card: x.id } : { project: x });
  r.hints = {
    'write a shrinker for date ranges in pie right': { confidence: 'clear', to: { card: c.pyrite.id }, brief: 'write a shrinker for date ranges in pie right', said: 'pie right' },
    'in queue grid make the rehearsal timer readable on mobile': { confidence: 'clear', to: { project: P.cuegrid }, brief: 'in queue grid make the rehearsal timer readable on mobile', said: 'queue grid' },
  };
  r.finds = {
    'the static site rebuilds every page when one changed': [
      { to: to(c.kiln), name: 'kiln', folder: '~/projects/kiln', why: 'static, site' },
      { to: { project: P.cuegrid }, name: 'cuegrid', folder: '~/projects/cuegrid', why: 'pages' },
      { to: to(c.harbormaster), name: 'harbormaster', folder: '~/projects/harbormaster', why: 'worked on last' },
    ],
  };
  if (name.startsWith('question')) {
    const id = '019a8b6c-7d10-7000-8000-0000000ff001';
    r.thoughts.push({ id, rev: 60, text: 'the static site rebuilds every page when one changed', strokes: [], source: 'voice', mode: 'ask', phase: 'captured', status: 'needs_you', reason: null, live: true,
      project_id: null, card_id: null, session_id: null, brief: null, route: { by: 'local', model: null, pending: false, fallback: null, quote: null, title: null, ms: null }, placed: null,
      agent: 'claude', model: null, workdir: null, hold_until: null, read: false, created: now - 3000, updated: now - 3000 });
    r.questions.unshift({ id: '019a8b6c-7d10-7000-8000-0000000ff002', rev: 61, thought_id: id, session_id: null, turn: null, source: 'router', prompt: 'Where should this go?', detail: null,
      reply_via: 'core', state: 'open', answer: null, kind: 'choice', choices: ['kiln', 'cuegrid', 'harbormaster'],
      places: [{ card: c.kiln.id }, { project: P.cuegrid }, { card: c.harbormaster.id }], notes: ['static, site', 'pages', 'worked on last'] });
    r.glance = { ...r.glance, needs_you: r.glance.needs_you + 1, question: r.questions[0].id };
  }
  if (name === 'way-new') {
    r.thoughts.push({ id: '019a8b6c-7d10-7000-8000-0000000ff003', rev: 62, text: 'write a shrinker for date ranges in pie right', strokes: [], source: 'voice', mode: 'ask', phase: 'routed', status: 'routed',
      reason: null, live: true, project_id: null, card_id: c.pyrite.id, session_id: null, brief: 'write a shrinker for date ranges in pie right',
      route: { by: 'local', model: null, pending: false, fallback: null, quote: 'pie right', title: null, ms: null }, placed: 'name', agent: 'claude', model: null, workdir: null,
      hold_until: now + 4000, read: false, created: now - 1000, updated: now - 1000 });
  }
  return r;
}

const type = (text) => async (page) => (await page.focus('#capture-input'), await page.keyboard.type(text), await page.waitForTimeout(500));
const list = async (page) => (await page.click('#dest-chip'), await page.waitForTimeout(400));
const shots = {
  'chip-said': { act: [type('in queue grid make the rehearsal timer readable on mobile')] },
  'chip-not-open': { act: [type('write a shrinker for date ranges in pie right')] },
  'list': { act: [list] },
  'list-guesses': { act: [type('the static site rebuilds every page when one changed'), list] },
  'list-find': { act: [list, async (p) => (await p.keyboard.type('harb'), await p.waitForTimeout(500))] },
  'question': { act: [] },
  'question-another': { act: [async (p) => (await p.focus('[data-question]'), await p.keyboard.press('o'), await p.waitForTimeout(500))] },
  'way-new': { act: [] },
};
const notch = {
  'notch-question': [{ do: 'answer' }],
  'notch-list': [{ do: 'capture' }],
};
const geometry = { do: 'geometry', width: 185, height: 32, cutout: true, compact: false, surfaceWidth: 420, surfaceOffset: 0, span: 560, pixel: 2, corner: 10, offset: 0, available: 700, collapsed: false };

async function main(out, dprs, only) {
  const { chromium } = require('playwright');
  fs.mkdirSync(out, { recursive: true });
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true });
  let errors = 0;
  const sizes = ['default', 'small', 'large'];
  try {
    for (const dpr of dprs) {
      for (const text of sizes) {
        for (const [name, s] of Object.entries(shots)) {
          if (only && !only.includes(name)) continue;
          for (const width of text === 'default' ? [1180, 720] : [1180]) {
            const r = records(name);
            r.prefs = [...(r.prefs || []).filter((p) => p.id !== 'text_size'), { id: 'text_size', value: text, rev: 3 }];
            const page = await open(browser, { label: 'workspace', records: r, url: server.url, dpr, viewport: { width, height: 760 } });
            await page.waitForTimeout(400);
            for (const a of s.act) await a(page);
            await page.waitForTimeout(400);
            await page.evaluate(() => document.fonts.ready);
            await page.screenshot({ path: path.join(out, `placing-${name}-${text}-${width}@${dpr}x.png`) });
            for (const e of page.errors) (errors++, console.error(`${name}: ${e}`));
            await page.context().close();
          }
        }
        for (const [name, act] of Object.entries(notch)) {
          if (only && !only.includes(name)) continue;
          const r = records(name === 'notch-question' ? 'question' : name);
          r.prefs = [...(r.prefs || []).filter((p) => p.id !== 'text_size'), { id: 'text_size', value: text, rev: 3 }];
          const page = await open(browser, { label: 'notch', records: r, url: server.url, dpr, viewport: { width: 560, height: 460 } });
          await page.evaluate(() => (document.documentElement.style.background = 'radial-gradient(110% 85% at 12% 0%,#41607c 0%,transparent 58%),#172433'));
          await page.evaluate((g) => window.__fake.emit(g), geometry);
          for (const a of act) await page.evaluate((x) => window.__fake.emit(x), a);
          await page.waitForTimeout(800);
          if (name === 'notch-list') (await page.click('#dest-chip'), await page.waitForTimeout(400));
          await page.screenshot({ path: path.join(out, `placing-${name}-${text}@${dpr}x.png`) });
          for (const e of page.errors) (errors++, console.error(`${name}: ${e}`));
          await page.context().close();
        }
      }
      console.log('dpr', dpr, 'done');
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
  if (!out) (console.error('usage: node scripts/placing-shots.cjs <outdir> [dpr...] [--only a,b]'), process.exit(2));
  main(path.resolve(out), d.length ? d.map(Number) : [1, 2], only).catch((e) => (console.error(e), process.exit(1)));
}
module.exports = { records };
