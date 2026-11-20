// The settings a person looked for and did not find (docs/trial-checklist.md, P2 to P5), each row of Settings driven as
// a person drives it, by real pointer and key events in headless Chromium, on fixture records with the host's calls
// stood in for (motion-pages.cjs), on a Mac and on Windows:
//   P2  Thoughts, Open Tasktap when the computer starts, right under the capture key: off as the system says, on by
//       the pointer and off again by Space, each `host.login {on}` with the state read back from the host; on a Mac,
//       macOS waiting for the person to allow it, with Open Login Items; a copy that cannot (no signed app, not
//       installed, Tasktap Review) says so and has no switch.
//   P3  a project's details, Where its agent works: the three choices by the pointer and by the keyboard, each a
//       `put cards {isolate}`, the call the core keeps it by, with the sentence for each; a project with no workspace
//       yet chooses too; a folder that is no Git repository says it works in itself and offers no choice.
//   P4  Thoughts, the three keys that answer a waiting question from any app, after the capture key: each system's own
//       to begin with (Control-Option on a Mac, Alt-Shift on Windows); a key recorded by the pointer and real key
//       presses, stored through `host.answer_key`; the refusals by the keyboard (no modifier, taken by another app, the
//       capture key, another answer key) with the key before kept; Escape changes nothing; Use the default; and the
//       title bar's line to a waiting question naming the key recorded. Each refusal names the key that has the
//       combination already, the key held to talk among them, and the other way round in Voice; there a key another
//       app holds is refused too. A copy that takes no keys from other apps (a review build) has no recorder in the
//       four rows and says why, and its title-bar line names no key.
//   P5  About, Check for new versions: on by default, About shown asks the host to look; the switch by the pointer
//       writes `update_checks` false, after which About asks nothing, Anything else says Nothing, and Check now (by
//       the keyboard) asks once, as the person's word (`now`); on again asks at once. A build made here says so and
//       has no switch.
// Pictures of each row into <outdir>, named by system and text size.
// usage: node scripts/settings-rows-check.cjs <outdir>   (TEXT=small or large for that text size; ui/dist must be built)
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { serve, open, TEXT } = require('./motion-pages.cjs');
const { projects } = require('./projects-fixtures.cjs');
const { scene } = require('./instrument-fixtures.cjs');

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

// ——— P2: open Tasktap when the computer starts ———
async function login(browser, url, system) {
  const at = `${system}, Open Tasktap when the computer starts`;
  const mac = system === 'mac';
  const NAME = 'Open Tasktap when the computer starts';
  const start = async (records) => {
    const page = await open(browser, { label: 'workspace', records: { ...scene('busy'), ...records }, url, dpr: 2, system });
    await section(page, 'thoughts');
    return page;
  };
  const page = await start({ login: { state: 'off' } });
  const labels = await page.evaluate(() => [...document.querySelectorAll('.set-pane .set > .t')].map((t) => t.textContent));
  expect(labels[0] === 'Key to put a thought in, from any app' && labels[1] === NAME, `${at}: right under the capture key (${labels.slice(0, 3).join(' | ')})`);
  const row = page.locator(`.set-pane .set:has(> .t:text-is("${NAME}"))`);
  const toggle = row.locator('[role=switch]');
  const asked = () => page.evaluate(() => JSON.stringify(window.__fake.logins.splice(0)));
  expect(await toggle.getAttribute('aria-checked') === 'false' && await asked() === '[{}]', `${at}: off, as the host read it from the system when Thoughts was shown`);
  const hint = await row.locator('.hint').textContent();
  expect(mac ? /^When you log in, Tasktap opens without a window, only the notch, .*System Settings lists it under Login Items\.$/.test(hint)
    : /^When you sign in, Tasktap opens without a window, only its tab and icon, .*Windows lists it under Startup apps\.$/.test(hint), `${at}: it says what changes: "${hint}"`);
  await click(page, toggle);
  expect(await asked() === JSON.stringify([{ on: true }]) && await toggle.getAttribute('aria-checked') === 'true', `${at}: the pointer turns it on through host.login {on: true}, shown as the system then says`);
  await picture(page, 'thoughts-login-on', system);
  await toggle.focus();
  await key(page, 'Space');
  expect(await asked() === JSON.stringify([{ on: false }]) && await toggle.getAttribute('aria-checked') === 'false', `${at}: Space turns it off again through host.login {on: false}`);
  for (const e of page.errors) failures.push(`${at}: page: ${e}`);
  await page.context().close();

  // On a Mac, macOS may ask the person first: the row says so and opens Login Items.
  if (mac) {
    const waits = await start({ login: { state: 'off' }, approve: true });
    const r = waits.locator(`.set-pane .set:has(> .t:text-is("${NAME}"))`);
    await click(waits, r.locator('[role=switch]'));
    expect(await r.locator('.v').textContent() === 'Waiting for you to allow it', `${at}: macOS waiting for the person to allow it is said`);
    await waits.evaluate(() => window.__fake.logins.splice(0));
    await click(waits, r.locator('button.btn'));
    expect(await waits.evaluate(() => JSON.stringify(window.__fake.logins)) === JSON.stringify([{ open: true }]), `${at}: Open Login Items asks the host to show them`);
    await picture(waits, 'thoughts-login-approve', system);
    await waits.context().close();
  }
  // A copy that cannot: no switch, and why.
  for (const why of mac ? ['unsigned', 'review'] : ['uninstalled', 'review']) {
    const not = await start({ login: { state: 'unavailable', why } });
    const r = not.locator(`.set-pane .set:has(> .t:text-is("${NAME}"))`);
    expect(await r.locator('[role=switch]').count() === 0 && await r.locator('.v').textContent() === 'Not for this copy', `${at}: a copy that cannot (${why}) has no switch and says so: "${await r.locator('.hint').textContent()}"`);
    if (why !== 'review') await picture(not, 'thoughts-login-not-here', system);
    await not.context().close();
  }
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

// ——— P4: the keys that answer a question from any app ———
async function answerKeys(browser, url, system) {
  const at = `${system}, the answer keys`;
  const mac = system === 'mac';
  const records = { ...scene('busy'), taken: ['KeyT'] };
  const page = await open(browser, { label: 'workspace', records, url, dpr: 2, system });
  await section(page, 'thoughts');
  const LABELS = ['Key to put a thought in, from any app', 'Key to go to an agent’s question, from any app', 'Key to answer Yes, from any app', 'Key to answer No, from any app'];
  const labels = await page.evaluate(() => [...document.querySelectorAll('.set-pane .set > .t')].map((t) => t.textContent));
  expect(JSON.stringify(labels.slice(0, 4)) === JSON.stringify(LABELS), `${at}: the three rows follow the capture key (${labels.slice(0, 4).join(' | ')})`);
  const row = (n) => page.locator(`.set-pane .set:has(> .t:text-is("${LABELS[n]}"))`);
  const rec = (n) => row(n).locator('.rec');
  const shown = async (n) => /: (.*)\. Press/.exec(await rec(n).getAttribute('aria-label'))?.[1];
  const said = (n) => row(n).locator('.hint.err').textContent().catch(() => '');
  const stored = (id) => page.evaluate((i) => JSON.stringify((window.__fake.records.prefs || []).find((p) => p.id === i)?.value ?? null), id);
  const own = mac ? ['⌃⌥J', '⌃⌥Y', '⌃⌥N'] : ['Alt+Shift+J', 'Alt+Shift+Y', 'Alt+Shift+N'];
  expect(JSON.stringify([await shown(1), await shown(2), await shown(3)]) === JSON.stringify(own), `${at}: each system's own to begin with: ${own.join(', ')}`);
  await picture(page, 'thoughts', system);

  // Yes, recorded by the pointer and the keys pressed.
  await click(page, rec(2));
  expect(await rec(2).getAttribute('aria-pressed') === 'true', `${at}: a click on the Yes key listens`);
  await key(page, 'Control+Alt+KeyK');
  const mine = { control: true, alt: true, shift: false, meta: false, code: 'KeyK' };
  expect(await stored('yes_key') === JSON.stringify(mine) && await shown(2) === (mac ? '⌃⌥K' : 'Ctrl+Alt+K'), `${at}: Control-Alt-K pressed is the Yes key, stored and shown`);
  const back = row(2).locator('button.btn');
  expect(await back.textContent() === `Use ${own[1]}`, `${at}: a key of the person's own offers the default back, by its key`);
  await picture(page, 'thoughts-recorded', system);

  // No, by the keyboard: Return listens, and each refusal says why, the key before kept.
  const tries = async (keys, why, what) => {
    await rec(3).focus();
    await key(page, 'Enter');
    await key(page, keys);
    expect(await said(3) === why && await shown(3) === own[2] && await stored('no_key') === 'null', `${at}: ${what} is refused: "${await said(3)}"`);
  };
  await tries('KeyN', 'A shortcut needs Control, Option (Alt) or Command (the Windows key) held with its key.', 'a key with no modifier');
  await tries('Control+Alt+KeyT', 'That key is taken by the system or another app.', 'a key another app holds');
  await tries(mac ? 'Control+Alt+Space' : 'Alt+Shift+Space', 'Tasktap already uses that combination to put a thought in.', 'the capture key');
  await tries('Control+Alt+KeyK', 'Tasktap already uses that combination to answer Yes.', 'the Yes key');
  await tries(mac ? 'Alt+Space' : 'Control+Space', 'Tasktap already uses that combination as the key to hold while you talk.', 'the key held to talk');
  await tries(mac ? 'Meta+KeyJ' : 'Control+Shift+KeyJ', 'Tasktap uses that combination where you write a thought.', `${mac ? '⌘J' : 'Ctrl+Shift+J'}, the field's list of agents`);
  await rec(3).focus();
  await key(page, 'Enter');
  await key(page, 'Escape');
  expect(await rec(3).getAttribute('aria-pressed') === 'false' && await shown(3) === own[2], `${at}: Escape stops listening and changes nothing`);

  // The default again, by the pointer.
  await click(page, back);
  expect(await stored('yes_key') === 'null' && await shown(2) === own[1], `${at}: Use ${own[1]} deletes the preference and shows the default`);

  // The key to the question, recorded, names itself in the title bar's line to a waiting question.
  await click(page, rec(1));
  await key(page, 'Control+Shift+KeyQ');
  const q = await page.evaluate(() => [...window.__ws.records.questions.values()].find((x) => x.state === 'open')?.id);
  await page.evaluate((id) => window.__fake.emit({ do: 'where', place: 'line', question: id, front: true }), q);
  await page.waitForTimeout(300);
  const line = await page.evaluate(() => document.querySelector('.asks-line [data-keys] kbd')?.textContent ?? '');
  expect(line === (mac ? '⌃⇧Q' : 'Ctrl+Shift+Q'), `${at}: the title bar's line to a waiting question names the key recorded: "${line}"`);

  // The other way round: the key held to talk may be none of Tasktap's other keys either, and one another app holds
  // is refused too (it would never reach Tasktap); each refusal leaves the key before.
  await section(page, 'voice');
  const talk = page.locator('.set-pane .set:has(> .t:text-is("Key to hold while you talk"))');
  const talkTries = async (keys, why, what) => {
    await talk.locator('.rec').focus();
    await key(page, 'Enter');
    await key(page, keys);
    const err = await talk.locator('.hint.err').textContent().catch(() => '');
    expect(err === why && await stored('talk_key') === 'null', `${at}: as the key held to talk, ${what} is refused: "${err}"`);
  };
  await talkTries(mac ? 'Control+Alt+KeyN' : 'Alt+Shift+KeyN', 'Tasktap already uses that combination to answer No.', 'the No key');
  await talkTries('Control+Shift+KeyQ', 'Tasktap already uses that combination to go to an agent’s question.', 'the key recorded to go to the question');
  await talkTries(mac ? 'Control+Alt+Space' : 'Alt+Shift+Space', 'Tasktap already uses that combination to put a thought in.', 'the capture key');
  await talkTries('Control+Shift+KeyT', 'That key is taken by the system or another app.', 'a key another app holds');
  await talk.locator('.rec').focus();
  await key(page, 'Enter');
  await key(page, 'Control+Shift+KeyM');
  expect(await stored('talk_key') === JSON.stringify({ control: true, alt: false, shift: true, meta: false, code: 'KeyM' }), `${at}: a free key held to talk is stored through the host`);
  for (const e of page.errors) failures.push(`${at}: page: ${e}`);
  await page.context().close();
}

// ——— A copy that takes no keys from other apps (a review build) names none ———
async function noKeys(browser, url, system) {
  const at = `${system}, a copy that takes no keys from other apps`;
  const page = await open(browser, { label: 'workspace', records: { ...scene('busy'), takes: false }, url, dpr: 2, system });
  await section(page, 'thoughts');
  const NO = 'This copy is Tasktap Review, which takes no keys from other apps, so they stay your own Tasktap’s.';
  for (const name of ['Key to put a thought in, from any app', 'Key to go to an agent’s question, from any app', 'Key to answer Yes, from any app', 'Key to answer No, from any app']) {
    const row = page.locator(`.set-pane .set:has(> .t:text-is("${name}"))`);
    const v = await row.locator('.v').textContent().catch(() => ''), hint = await row.locator('.hint').textContent().catch(() => '');
    expect(await row.locator('.rec').count() === 0 && v === 'None for this copy' && hint === NO, `${at}: "${name}" has no recorder and says so: "${v}" / "${hint}"`);
  }
  await picture(page, 'thoughts-no-keys', system);
  await page.evaluate(() => ((window.__ws.ui.sheet = null), window.__motion.redraw()));
  const q = await page.evaluate(() => [...window.__ws.records.questions.values()].find((x) => x.state === 'open')?.id);
  await page.evaluate((id) => window.__fake.emit({ do: 'where', place: 'line', question: id, front: true }), q);
  await page.waitForTimeout(300);
  const line = await page.evaluate(() => (b => b && [b.querySelectorAll('kbd').length, b.title].join(' | '))(document.querySelector('.asks-line')));
  expect(/^0 \| Show the question/.test(line ?? '') && !/[⌃⌥]|Alt\+|Ctrl\+/.test(line ?? ''), `${at}: the title bar's line to a waiting question names no key: "${line}"`);
  for (const e of page.errors) failures.push(`${at}: page: ${e}`);
  await page.context().close();
}

// ——— P5: look for new versions ———
async function versions(browser, url, system) {
  const at = `${system}, Check for new versions`;
  const records = { ...scene('busy'), update: { state: 'current', version: '1.3.0' }, checked: { state: 'current', version: '1.3.1' } };
  const page = await open(browser, { label: 'workspace', records, url, dpr: 2, system });
  // (The window asks where things stand as it starts, for the rail's line.)
  await page.evaluate(() => window.__fake.updates.splice(0));
  await section(page, 'about');
  const row = page.locator('.set-pane .set:has(> .t:text-is("Check for new versions"))');
  const toggle = row.locator('[role=switch]');
  const asked = () => page.evaluate(() => JSON.stringify(window.__fake.updates.splice(0)));
  const value = (name) => page.locator(`.set-pane .set:has(> .t:text-is("${name}")) .v`).first().textContent();
  const pref = () => page.evaluate(() => JSON.stringify(window.__fake.puts.filter((p) => p.c === 'prefs' && p.id === 'update_checks').map((p) => p.patch)));

  expect(await toggle.getAttribute('aria-checked') === 'true', `${at}: on by default`);
  expect(await asked() === JSON.stringify([{ look: true }]), `${at}: About shown asks the host to look`);
  expect(await value('Check for new versions') === 'Up to date' && await row.locator('button.btn').count() === 0, `${at}: on, it says Up to date and offers no Check now`);
  expect(await value('Anything else') === 'A check for new versions', `${at}: on, Anything else names the check`);
  await picture(page, 'about', system);

  await click(page, toggle);
  expect(await pref() === '[false]' && await toggle.getAttribute('aria-checked') === 'false', `${at}: the pointer on the switch writes update_checks false`);
  expect(await value('Anything else') === 'Nothing', `${at}: off, Anything else says Nothing`);
  expect(/only when you check now\.$/.test(await row.locator('.hint').textContent()), `${at}: off, the sentence says it asks only at Check now`);
  await section(page, 'thoughts');
  await section(page, 'about');
  expect(await asked() === JSON.stringify([{}]), `${at}: off, About shown again asks the host nothing`);
  await picture(page, 'about-off', system);

  // Check now by the keyboard: the switch has the keyboard after its click; Tab goes to Check now, Return presses it.
  await toggle.focus();
  await key(page, 'Tab');
  expect(await focused(page) === 'Check now', `${at}: Tab from the switch reaches Check now`);
  await key(page, 'Enter');
  expect(await asked() === JSON.stringify([{ look: true, now: true }]), `${at}: Return on Check now asks the host once, as the person's word`);
  expect(/^Version 1\.3\.1 is the newest/.test(await row.locator('.hint').textContent()), `${at}: what the check found is shown`);

  // On again by the keyboard: Space on the switch, which asks at once.
  await toggle.focus();
  await key(page, 'Space');
  expect(await pref() === '[false,true]' && await asked() === JSON.stringify([{ look: true, now: true }]), `${at}: Space turns it on again and asks at once`);
  for (const e of page.errors) failures.push(`${at}: page: ${e}`);
  await page.context().close();

  // A build made on this computer: no switch, and why.
  const here = await open(browser, { label: 'workspace', records: { ...scene('busy'), update: { state: 'off' } }, url, dpr: 2, system });
  await section(here, 'about');
  const mine = here.locator('.set-pane .set:has(> .t:text-is("Check for new versions"))');
  expect(await mine.locator('[role=switch]').count() === 0 && await mine.locator('.v').textContent() === 'Not for this copy', `${at}: a build made here has no switch and says so`);
  expect(await mine.locator('button').count() === 0 && /built on this computer, so it never checks for new versions\.$/.test(await mine.locator('.hint').textContent()), `${at}: nor a Check now, as the host never asks GitHub in such a build (update.rs \`asks\`)`);
  await here.context().close();
}

async function main() {
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const system of ['mac', 'windows']) {
      await login(browser, server.url, system);
      await where(browser, server.url, system);
      await answerKeys(browser, server.url, system);
      await noKeys(browser, server.url, system);
      await versions(browser, server.url, system);
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(failures.length ? `FAIL  ${failures.length} of the rows' checks` : `PASS  every row driven by the pointer and the keyboard, on a Mac and on Windows, at text size ${TEXT}; pictures in ${out}`);
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
