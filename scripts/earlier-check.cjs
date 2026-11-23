// A page of this build connected to a core of 2.0.0, as an update leaves it running while its terminals run on (host
// core.rs): from ui/dist in headless Chromium, the fake core answering as 2.0.0 does (motion-pages.cjs `earlier`: the
// calls it does not know refused as unknown, the preferences it does not know as invalid, its records without the
// newer fields). What 2.0.0 cannot do is not offered, nothing is asked of it, and no error is shown: no ChatGPT or own
// model in Placing, no live target and no preview while a task is written, no placing record, no start command for an
// agent, and the welcome's placing step led by the person's agents. The same page on a core of this build offers each.
// Invented records only; no host, no core, no agent.
// usage: node scripts/earlier-check.cjs [--dist <folder>]
const path = require('node:path');
const { chromium } = require('playwright');
const { serve, open, scene } = require('./motion-pages.cjs');

const failures = [];
const expect = (ok, what) => (console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`), ok || failures.push(what));
const NEWER = ['route.guess', 'route.preview', 'placings.count', 'placings.clear', 'chatgpt.sign_in', 'chatgpt.sign_out', 'own_model.set', 'own_model.remove', 'own_model.list'];

/** Opens the workspace on the normal scene, on a core of 2.0.0 (`earlier`) or of this build. */
async function at(browser, url, earlier) {
  const page = await open(browser, { label: 'workspace', records: scene('normal'), url, dpr: 1, earlier });
  await page.waitForFunction(() => window.__ws?.ui.ready, null, { timeout: 15000 });
  return page;
}
const asked = (page) => page.evaluate((newer) => window.__fake.calls.filter((c) => newer.includes(c)), NEWER);
const said = (page) => page.evaluate(() => [...document.querySelectorAll('.err, .error, [role=alert]')].map((e) => e.textContent.trim()).filter(Boolean));
const settings = (page, at) => page.evaluate((s) => ((window.__ws.ui.sheet = { kind: 'settings', at: s }), window.__motion.redraw()), at).then(() => page.waitForTimeout(400));
const text = (page) => page.evaluate(() => document.querySelector('.settings')?.textContent ?? '');

async function run(browser, url, earlier) {
  const of = earlier ? '2.0.0' : 'this build';
  const page = await at(browser, url, earlier);
  // Placing agreed to the agents the core lists, so that a model places what is written.
  const terms = await page.evaluate(() => window.__ws.call('route.terms', {}));
  await page.evaluate((t) => window.__ws.call('put', { c: 'prefs', id: 'route_by', patch: { agents: t.tools.map((x) => ({ agent: x.agent, model: x.model, on: true })), terms: t.terms } }), terms);
  await page.waitForTimeout(200);
  // A task written in the Composer: the target is asked only of a core that finds it.
  await page.focus('#capture-input');
  await page.keyboard.type('fix the flaky export in harbormaster', { delay: 15 });
  await page.waitForTimeout(2500);
  const composing = await asked(page);
  expect(earlier ? !composing.length : composing.includes('route.guess'), `${of}: writing a task asks ${composing.join(', ') || 'nothing'} of the core`);
  // Settings › Placing: ChatGPT, the own model, the target while writing and the placing record.
  await settings(page, 'placing');
  const placing = await page.evaluate(() => ({ sign: !!document.querySelector('.settings .rank.sign:not(.mine)'), own: !!document.querySelector('.settings .rank.mine'), text: document.querySelector('.settings')?.textContent ?? '' }));
  const offered = [placing.sign && 'ChatGPT', placing.own && 'own model', placing.text.includes('Show the target while you write') && 'target', placing.text.includes('Placing record') && 'record'].filter(Boolean);
  expect(earlier ? !offered.length : offered.length === 4, `${of}: Placing offers ${offered.join(', ') || 'none of ChatGPT, own model, target, record'}`);
  await page.getByRole('button', { name: 'The instructions they follow' }).click();
  await page.waitForTimeout(150);
  const hints = await page.evaluate(() => [...document.querySelectorAll('.settings .hint')].filter((h) => !h.textContent.trim()).length);
  expect(hints === 0, `${of}: the instructions open with no empty line where the core says nothing of what is cut`);
  // Settings › Agents: Claude Code's details, its start command only where the core names its program.
  await settings(page, 'agents');
  await page.click('.line.ag[data-agent="claude"] .chev');
  await page.waitForTimeout(200);
  const start = (await text(page)).includes('Start command');
  expect(earlier ? !start : start, `${of}: Claude Code's details ${start ? 'have' : 'have no'} start command`);
  // The welcome's placing step, from Settings › About: led by ChatGPT, or by the person's own agents.
  await settings(page, 'about');
  await page.getByRole('button', { name: 'Show again' }).click();
  await page.waitForTimeout(300);
  for (let i = 0; i < 2; i++) (await page.click('.wc-skip'), await page.waitForTimeout(250));
  const step = await page.evaluate(() => ({ title: document.querySelector('.wc h1')?.textContent ?? '', cards: [...document.querySelectorAll('.wc-o .wc-card .wc-t')].map((c) => c.textContent), lead: document.querySelector('#wc-go .wc-t')?.textContent ?? '' }));
  expect(step.title.includes('find the project') && (earlier ? step.lead === 'Your agents' && !step.cards.includes('ChatGPT') : step.lead === 'ChatGPT'),
    `${of}: the placing step is led by ${step.lead || 'nothing'} (${step.cards.join(', ')})`);
  const all = await asked(page), shown = await said(page);
  if (earlier) expect(!all.length, `2.0.0: nothing it does not answer was asked of it (${all.join(', ') || 'none'})`);
  expect(!shown.length, `${of}: no error shown (${shown.join(' | ') || 'none'})`);
  expect(!page.errors.length, `${of}: no page error (${page.errors.join(' | ') || 'none'})`);
  await page.context().close();
}

async function main(dist) {
  const server = await serve(dist);
  const browser = await chromium.launch();
  try {
    await run(browser, server.url, true);
    await run(browser, server.url, false);
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

const flag = process.argv.indexOf('--dist');
main(path.resolve(flag > 0 ? process.argv[flag + 1] : path.join(__dirname, '../ui/dist'))).catch((e) => (console.error(e), process.exit(1)));
