// The settings a person looked for and did not find (docs/trial-checklist.md, P2 to P5), each row of Settings driven as
// a person drives it, by real pointer and key events in headless Chromium, on fixture records with the host's calls
// stood in for (motion-pages.cjs), on a Mac and on Windows:
//   P3  a project's details, Where its agent works: the three choices by the pointer and by the keyboard, each a
//       `put cards {isolate}`, the call the core keeps it by, with the sentence for each; a project with no workspace
//       yet chooses too; a folder that is no Git repository says it works in itself and offers no choice.
// Pictures of each row into <outdir>, named by system and text size.
// usage: node scripts/settings-rows-check.cjs <outdir>   (TEXT=small or large for that text size; ui/dist must be built)
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { serve, open, TEXT } = require('./motion-pages.cjs');
const { projects } = require('./projects-fixtures.cjs');

const failures = [];
const expect = (ok, what) => (console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`), ok || failures.push(what));
const out = path.resolve(process.argv[2] || 'settings-rows');

/** A press of the pointer as a person makes it: moved to the middle of the element and pressed there. */
async function click(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(200);
}
async function key(page, k) {
  await page.keyboard.press(k);
  await page.waitForTimeout(200);
}
const section = async (page, at) => {
  await page.evaluate((a) => ((window.__ws.ui.sheet = { kind: 'settings', at: a }), window.__motion.redraw()), at);
  await page.waitForTimeout(450);
};
const lastPut = (page) => page.evaluate(() => JSON.stringify(window.__fake.puts.at(-1) ?? null));
const focused = (page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
async function picture(page, name, system) {
  fs.mkdirSync(out, { recursive: true });
  await page.locator('.sheet').screenshot({ path: path.join(out, `${name}-${system}-${TEXT}.png`) });
}

// ——— P3: where a project's agent works ———
async function where(browser, url, system) {
  const records = projects('settings');
  const page = await open(browser, { label: 'workspace', records, url, dpr: 2, system });
  await section(page, 'projects');
  const row = (name) => page.locator(`.set-pane .line.pj:has(> .t:text-is("${name}"))`).first();
  const fact = page.locator('.pj-c .pj-k:has(> .k:text-is("Where its agent works"))');
  const radios = fact.locator('[role=radio]');
  const checked = () => fact.locator('[role=radio][aria-checked=true]').textContent().catch(() => '');
  const says = () => fact.locator('.says').textContent();
  const cuegrid = records.cards.find((c) => c.name === 'cuegrid' && !c.copy_of);
  const at = `${system}, Where its agent works`;

  await click(page, row('cuegrid'));
  expect(await radios.count() === 3, `${at}: a Git project with a workspace offers three choices`);
  expect(await checked() === 'On its own copy when another agent is working there', `${at}: the default is a copy while another agent works there`);
  expect(/copy of its own, whose changes come back with Keep or go with Discard\.$/.test(await says()), `${at}: the default says what a copy is: "${await says()}"`);
  await fact.scrollIntoViewIfNeeded();
  await picture(page, 'project-details', system);

  await click(page, radios.filter({ hasText: 'Always on its own copy' }));
  expect(await lastPut(page) === JSON.stringify({ c: 'cards', id: cuegrid.id, patch: { isolate: 'always' } }), `${at}: the pointer on Always sends put cards {isolate: always}`);
  expect(await checked() === 'Always on its own copy', `${at}: Always is shown chosen, from the workspace's record`);
  expect(/^Every agent gets a copy of its own/.test(await says()), `${at}: Always says every agent gets a copy`);

  // The keyboard: the next choice by Tab, taken by Space; back two by Shift-Tab, taken by Return.
  await key(page, 'Tab');
  expect(await focused(page) === 'In the project itself', `${at}: Tab reaches In the project itself`);
  await key(page, 'Space');
  expect(await lastPut(page) === JSON.stringify({ c: 'cards', id: cuegrid.id, patch: { isolate: 'never' } }), `${at}: Space on it sends put cards {isolate: never}`);
  expect(/two working here at once can overwrite each other’s changes\.$/.test(await says()), `${at}: In the project itself says two agents can overwrite each other: "${await says()}"`);
  await key(page, 'Shift+Tab');
  await key(page, 'Shift+Tab');
  await key(page, 'Enter');
  expect(await lastPut(page) === JSON.stringify({ c: 'cards', id: cuegrid.id, patch: { isolate: 'busy' } }), `${at}: Return on the first choice sends put cards {isolate: busy}`);

  // A project with no workspace yet: the card keeps the choice until a thought opens it.
  const pyrite = records.cards.find((c) => c.name === 'pyrite');
  await click(page, row('pyrite'));
  await click(page, radios.filter({ hasText: 'In the project itself' }));
  expect(await lastPut(page) === JSON.stringify({ c: 'cards', id: pyrite.id, patch: { isolate: 'never' } }) && await checked() === 'In the project itself',
    `${at}: a project with no workspace yet chooses too, kept by its card`);

  // No Git: nothing to choose, and why.
  await click(page, row('dotfiles'));
  await fact.scrollIntoViewIfNeeded();
  expect(await radios.count() === 0, `${at}: a folder that is no Git repository offers no choice`);
  expect(/^In the project itself It is not a Git repository/.test((await fact.locator('.v').textContent()).replace(/\s+/g, ' ').replace('itselfIt', 'itself It')), `${at}: it says it works in the project itself, as it is no Git repository`);
  await picture(page, 'project-details-no-git', system);
  for (const e of page.errors) failures.push(`${at}: page: ${e}`);
  await page.context().close();
}

async function main() {
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const system of ['mac', 'windows']) {
      await where(browser, server.url, system);
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(failures.length ? `FAIL  ${failures.length} of the rows' checks` : `PASS  every row driven by the pointer and the keyboard, on a Mac and on Windows, at text size ${TEXT}; pictures in ${out}`);
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
