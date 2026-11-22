// The settings a person looked for and did not find (docs/trial-checklist.md, P2 to P5), each row of Settings driven as
// a person drives it, by real pointer and key events, on fixture records with the host's calls stood in for
// (motion-pages.cjs): in Chromium on a Mac and on Windows (WebView2 is Chromium), and in WebKit, the Mac's own engine,
// which gives no keyboard to a button it clicked:
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
//       four rows and says why, and its title-bar line names no key. A recorder pressed the moment its section is
//       shown, before the page's next frame (Voice from Thoughts, whose four recorders go meanwhile), takes the keys
//       pressed next.
//   P5  About, Check for new versions: on by default, About shown asks the host to look; the switch by the pointer
//       writes `update_checks` false, after which About asks nothing, Anything else says Nothing, and Check now (by
//       the keyboard) asks once, as the person's word (`now`); on again asks at once. A build made here says so and
//       has no switch.
//   P6  Agents, the command that starts each agent Tasktap brings: a row under each, empty, the agent's program in its
//       field, one sentence with an example of a start of the person's own (caffeinate on a Mac; on Windows an
//       argument of Claude Code's, none for Codex); a command typed and Tab keep it as
//       `agent_commands`; one that holds what Tasktap sets for a run, then Return, is refused in the core's sentence
//       under the field and the one before stays, and the sentence goes with the section, which shows the one kept
//       again; emptied, the command goes. One whose command does not start it stays in sight, not folded away, and
//       says why in the core's words; signing in to one that is signed out, and a terminal of it, type the agent's
//       program as before, its command set or not: what is typed in a shell is the shell's.
//   And a sweep in WebKit by the pointer alone of every control in Settings that acts on a click and then takes keys:
//   each recorder, the project's choice, Add your own agent, a project's other name, the font field, the field that
//   finds a project, a section's tab with the arrows, a switch with Space, and Check now.
// Pictures of each row into <outdir>, named by system (and -webkit) and text size.
// usage: node scripts/settings-rows-check.cjs <outdir>   (TEXT=small or large for that text size; ui/dist must be built)
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const { serve, open, TEXT } = require('./motion-pages.cjs');
const { projects } = require('./projects-fixtures.cjs');
const { scene } = require('./instrument-fixtures.cjs');

const failures = [];
/** The engine the rows run in now. */
let ENGINE = 'chromium';
const expect = (ok, what) => (console.log(`${ok ? 'ok  ' : 'FAIL'} [${ENGINE}] ${what}`), ok || failures.push(`[${ENGINE}] ${what}`));
const out = path.resolve(process.argv[2] || 'settings-rows');

/** A press of the pointer as a person makes it: moved to the middle of the element and pressed there. */
async function click(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(200);
}
/** What the foot of the window says of a row: the row's hint, which it says while the pointer is on the row. */
async function hintOf(page, row) {
  await row.scrollIntoViewIfNeeded();
  const b = await row.boundingBox();
  await page.mouse.move(b.x + 6, b.y + b.height / 2);
  await page.waitForTimeout(150);
  return ((await page.locator('.sheet .sh-hint').textContent()) ?? '').trim();
}
async function key(page, k) {
  await page.keyboard.press(k);
  await page.waitForTimeout(200);
}
/** A section of Settings as it is once what it asks has come: every call but a few waits for the core's welcome, and
 *  rows such as the keys that answer a question from any app are drawn only once the host has answered. So: the core's
 *  first records in, then the section's rows the same for 300 ms by the page's clock (at most 15 s), never a fixed
 *  wait, which a slow machine (the workflow's Mac, in WebKit) outran. */
const section = async (page, at) => {
  await page.waitForFunction(() => window.__ws?.ui.ready, null, { timeout: 15000 }).catch(() => {});
  await page.evaluate((a) => ((window.__ws.ui.sheet = { kind: 'settings', at: a }), window.__motion.redraw()), at);
  await page.evaluate(() => new Promise((done) => {
    const end = performance.now() + 15000;
    let was = null, since = performance.now();
    const look = () => {
      const now = [...document.querySelectorAll('.set-pane .set')].map((r) => r.textContent).join('|');
      if (now !== was) (was = now, (since = performance.now()));
      return (now && performance.now() - since >= 300) || performance.now() > end ? done() : setTimeout(look, 20);
    };
    look();
  }));
};
const lastPut = (page) => page.evaluate(() => JSON.stringify(window.__fake.puts.at(-1) ?? null));
const focused = (page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
/** Tab, to a button: Playwright's WebKit moves it only between fields, as Safari does unless told otherwise (the app's
 *  own web view lets it reach every button, host/src/native.rs); there the check takes the keyboard to the control
 *  Tab would reach, and holds the rest of the way by the keys. */
async function tab(page, to, back = false) {
  if (ENGINE === 'webkit') return to.focus();
  await key(page, back ? 'Shift+Tab' : 'Tab');
}
async function picture(page, name, system) {
  fs.mkdirSync(out, { recursive: true });
  await page.locator('.sheet').screenshot({ path: path.join(out, `${name}-${system}${ENGINE === 'webkit' ? '-webkit' : ''}-${TEXT}.png`) });
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
  expect(labels[0] === 'Key to start a task, from any app' && labels[1] === NAME, `${at}: right under the capture key (${labels.slice(0, 3).join(' | ')})`);
  const row = page.locator(`.set-pane .set:has(> .t:text-is("${NAME}"))`);
  const toggle = row.locator('[role=switch]');
  const asked = () => page.evaluate(() => JSON.stringify(window.__fake.logins.splice(0)));
  expect(await toggle.getAttribute('aria-checked') === 'false' && await asked() === '[{}]', `${at}: off, as the host read it from the system when Thoughts was shown`);
  const hint = await hintOf(page, row);
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
    expect(await r.locator('[role=switch]').count() === 0 && await r.locator('.v').textContent() === 'Not for this copy', `${at}: a copy that cannot (${why}) has no switch and says so: "${await hintOf(not, r)}}"`);
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

  // Opened below what the pane shows, its details come into view by the pane's own scrolling, its row still in view.
  await page.evaluate(() => (document.querySelector('.set-pane').scrollTop = 0));
  await click(page, row('cuegrid'));
  await page.waitForTimeout(400);
  const seen = await page.evaluate(() => {
    const pane = document.querySelector('.set-pane').getBoundingClientRect(), open = document.querySelector('.pj-c').getBoundingClientRect();
    const head = document.querySelector('.line.pj[aria-expanded=true]').getBoundingClientRect();
    return open.bottom <= pane.bottom + 1 && head.top >= pane.top - 1;
  });
  expect(seen, `${at}: a project's details opened below the pane's view are scrolled into it, with its row`);
  expect(await radios.count() === 3, `${at}: a Git project with a workspace offers three choices`);
  expect(await checked() === 'On its own copy when another agent is working there', `${at}: the default is a copy while another agent works there`);
  expect(await says() === 'While another agent works here, the next one works on a copy; when it finishes you choose Keep to bring its changes in, or Discard.', `${at}: the default says what a copy is: "${await says()}"`);
  await fact.scrollIntoViewIfNeeded();
  await picture(page, 'project-details', system);

  await click(page, radios.filter({ hasText: 'Always on its own copy' }));
  expect(await lastPut(page) === JSON.stringify({ c: 'cards', id: cuegrid.id, patch: { isolate: 'always' } }), `${at}: the pointer on Always sends put cards {isolate: always}`);
  expect(await checked() === 'Always on its own copy', `${at}: Always is shown chosen, from the workspace's record`);
  expect(await says() === 'Every agent works on a copy of the project; when it finishes you choose Keep to bring its changes in, or Discard.', `${at}: Always says every agent works on a copy: "${await says()}"`);

  // The click gave the choice the keyboard. Then the next choice by Tab, taken by Space; back two by Shift-Tab, taken by
  // Return.
  expect(await focused(page) === 'Always on its own copy', `${at}: a click on a choice gives it the keyboard`);
  await tab(page, radios.filter({ hasText: 'In the project itself' }));
  expect(await focused(page) === 'In the project itself', `${at}: Tab reaches In the project itself`);
  await key(page, 'Space');
  expect(await lastPut(page) === JSON.stringify({ c: 'cards', id: cuegrid.id, patch: { isolate: 'never' } }), `${at}: Space on it sends put cards {isolate: never}`);
  expect(/two working here at once can overwrite each other’s changes\.$/.test(await says()), `${at}: In the project itself says two agents can overwrite each other: "${await says()}"`);
  if (ENGINE === 'webkit') await radios.first().focus();
  else await key(page, 'Shift+Tab'), await key(page, 'Shift+Tab');
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
  const records = { ...scene('busy'), taken: ['KeyT', 'KeyG'] };
  const page = await open(browser, { label: 'workspace', records, url, dpr: 2, system });
  await section(page, 'thoughts');
  const LABELS = ['Key to start a task, from any app', 'Key to go to an agent’s question, from any app', 'Key to answer Yes, from any app', 'Key to answer No, from any app'];
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
  await tries(mac ? 'Control+Alt+Space' : 'Alt+Shift+Space', 'Tasktap already uses that combination to start a task.', 'the capture key');
  await tries('Control+Alt+KeyK', 'Tasktap already uses that combination to answer Yes.', 'the Yes key');
  await tries(mac ? 'Alt+Space' : 'Control+Space', 'Tasktap already uses that combination as the key to hold while you talk.', 'the key held to talk');
  // Tasktap's own window's keys, named; and the system's command modifier alone, which every app has.
  await tries(mac ? 'Meta+KeyJ' : 'Control+Shift+KeyJ', `Tasktap uses ${mac ? '⌘J' : 'Ctrl+Shift+J'} for the list of agents.`, `${mac ? '⌘J' : 'Ctrl+Shift+J'}`);
  await tries(mac ? 'Meta+KeyN' : 'Control+Shift+KeyN', `Tasktap uses ${mac ? '⌘N' : 'Ctrl+Shift+N'} for New task.`, `${mac ? '⌘N' : 'Ctrl+Shift+N'}`);
  await tries(mac ? 'Meta+Comma' : 'Control+Comma', `Tasktap uses ${mac ? '⌘,' : 'Ctrl+,'} for Settings.`, `${mac ? '⌘,' : 'Ctrl+,'}`);
  await tries(mac ? 'Meta+Digit3' : 'Control+Digit3', `Tasktap uses ${mac ? '⌘3' : 'Ctrl+3'} for Projects in Settings.`, `${mac ? '⌘3' : 'Ctrl+3'}`);
  await tries(mac ? 'Meta+KeyB' : 'Control+KeyB', mac ? 'Other apps use ⌘ with a single key: hold Control or Option as well.' : 'Other apps use Ctrl with a single key: hold Alt or Shift as well.', `${mac ? '⌘B' : 'Ctrl+B'}, which every app has`);
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
  await talkTries(mac ? 'Control+Alt+Space' : 'Alt+Shift+Space', 'Tasktap already uses that combination to start a task.', 'the capture key');
  await talkTries('Control+Shift+KeyG', 'That key is taken by the system or another app.', 'a key another app holds');
  await talkTries(mac ? 'Meta+KeyT' : 'Control+Shift+KeyT', `Tasktap uses ${mac ? '⌘T' : 'Ctrl+Shift+T'} for New terminal.`, `${mac ? '⌘T' : 'Ctrl+Shift+T'}`);
  await talkTries(mac ? 'Meta+KeyA' : 'Control+KeyA', `A text field uses ${mac ? '⌘A' : 'Ctrl+A'} for Select all.`, `${mac ? '⌘A' : 'Ctrl+A'}, a text field's own`);
  await talk.locator('.rec').focus();
  await key(page, 'Enter');
  await key(page, 'Control+Shift+KeyM');
  expect(await stored('talk_key') === JSON.stringify({ control: true, alt: false, shift: true, meta: false, code: 'KeyM' }), `${at}: a free key held to talk is stored through the host`);
  for (const e of page.errors) failures.push(`${at}: page: ${e}`);
  await page.context().close();
}

// ——— A recorder pressed the moment its section is shown ———
// Another section's recorders go when it is left, and the page lets their last work wait for the next frame: on a
// busy page or in a window not drawn a click on Change can come first. The key pressed after it is still the key.
async function atOnce(browser, url, system) {
  const at = `${system}, a recorder pressed the moment its section is shown`;
  const page = await open(browser, { label: 'workspace', records: scene('busy'), url, dpr: 2, system });
  await section(page, 'thoughts');
  const talk = page.locator('.set-pane .set:has(> .t:text-is("Key to hold while you talk")) .rec');
  // Thoughts' recorders settled first (a page that is not in front may not have had the frame their start waits for:
  // drawn again, they have), then Voice chosen in the list and Change pressed in one go, before the page's next frame.
  await page.evaluate(async () => {
    window.__motion.redraw();
    await new Promise((done) => queueMicrotask(done));
    document.querySelector('#set-tab-voice').click();
    await new Promise((done) => queueMicrotask(done));
    [...document.querySelectorAll('.set-pane .set')].find((r) => r.querySelector('.t').textContent === 'Key to hold while you talk').querySelector('.rec').click();
  });
  await page.waitForTimeout(400);
  expect(await talk.getAttribute('aria-pressed') === 'true', `${at}: Change listens`);
  await key(page, 'Control+Shift+KeyY');
  const stored = await page.evaluate(() => JSON.stringify((window.__fake.records.prefs || []).find((p) => p.id === 'talk_key')?.value ?? null));
  expect(stored === JSON.stringify({ control: true, alt: false, shift: true, meta: false, code: 'KeyY' }) && await talk.getAttribute('aria-pressed') === 'false',
    `${at}: the keys pressed next are the key held to talk, though Thoughts' four recorders went in the meantime (${stored}, listening: ${await talk.getAttribute('aria-pressed')})`);
  for (const e of page.errors) failures.push(`${at}: page: ${e}`);
  await page.context().close();
}

// ——— A copy that takes no keys from other apps (a review build) names none ———
async function noKeys(browser, url, system) {
  const at = `${system}, a copy that takes no keys from other apps`;
  const page = await open(browser, { label: 'workspace', records: { ...scene('busy'), takes: false }, url, dpr: 2, system });
  await section(page, 'thoughts');
  const NO = 'This copy is Tasktap Review, which takes no keys from other apps, so they stay your own Tasktap’s.';
  for (const name of ['Key to start a task, from any app', 'Key to go to an agent’s question, from any app', 'Key to answer Yes, from any app', 'Key to answer No, from any app']) {
    const row = page.locator(`.set-pane .set:has(> .t:text-is("${name}"))`);
    const v = await row.locator('.v').textContent().catch(() => ''), hint = await hintOf(page, row).catch(() => '');
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
  expect(/only when you check now\.$/.test(await hintOf(page, row)), `${at}: off, the sentence says it asks only at Check now`);
  await section(page, 'thoughts');
  await section(page, 'about');
  expect(await asked() === JSON.stringify([{}]), `${at}: off, About shown again asks the host nothing`);
  await picture(page, 'about-off', system);

  // Check now by the keyboard: the switch has the keyboard after its click; Tab goes to Check now, Return presses it.
  await toggle.focus();
  await tab(page, row.locator('button.btn'));
  expect(await focused(page) === 'Check now', `${at}: Tab from the switch reaches Check now`);
  await key(page, 'Enter');
  expect(await asked() === JSON.stringify([{ look: true, now: true }]), `${at}: Return on Check now asks the host once, as the person's word`);
  expect(/^Version 1\.3\.1 is the newest/.test(await hintOf(page, row)), `${at}: what the check found is shown`);

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
  expect(await mine.locator('button').count() === 0 && /built on this computer, so it never checks for new versions\.$/.test(await hintOf(here, mine)), `${at}: nor a Check now, as the host never asks GitHub in such a build (update.rs \`asks\`)`);
  await here.context().close();
}

// ——— P6: the command that starts an agent ———
async function starts(browser, url, system) {
  const at = `${system}, the command that starts an agent`;
  const page = await open(browser, { label: 'workspace', records: scene('busy'), url, dpr: 2, system });
  await section(page, 'agents');
  const IDS = { 'Claude Code': 'claude', Codex: 'codex' };
  // A row of Agents is opened by its chevron (closed to begin with, not remembered): the command that starts the agent is in it.
  const opened = async () => { for (const id of Object.values(IDS)) await click(page, page.locator(`.set-pane .line.ag[data-agent=${id}] .chev`)); };
  await opened();
  const row = (name) => page.locator(`.set-pane .line.ag[data-agent=${IDS[name]}] + .ag-d .set:has(> .t:text-is("Start command"))`);
  const stored = () => page.evaluate(() => JSON.stringify((window.__fake.records.prefs || []).find((p) => p.id === 'agent_commands')?.value ?? null));
  for (const [name, program, example] of [['Claude Code', 'claude', system === 'mac' ? 'caffeinate -i claude' : 'claude --verbose'], ['Codex', 'codex', system === 'mac' ? 'caffeinate -i codex' : '']]) {
    const field = row(name).locator('input');
    expect(await row(name).count() === 1 && await field.inputValue() === '' && await field.getAttribute('placeholder') === program, `${at}: ${name} has its row, empty, with ${program} in its field`);
    const hint = await hintOf(page, row(name));
    const says = `Write how you start ${name}${example ? `, such as ${example}` : ''}, without shell aliases; leave the field empty for Tasktap's own start.`;
    expect(hint === says, `${at}: ${name}'s row says in one sentence how to write a start${example ? `, with ${example} for an example` : ', with no example'}: "${hint}"`);
  }
  await picture(page, 'agents', system);
  // The first row chooses who starts new tasks, among the agents that can run now: Codex by the pointer is `put prefs agent`.
  const chooser = page.getByRole('radiogroup', { name: 'New tasks start with' });
  const names = await chooser.getByRole('radio').allTextContents();
  expect(await page.locator('.set-pane > .set > .t').first().textContent() === 'New tasks start with' && names.includes('Claude Code') && names.includes('Codex'), `${at}: the first row of Agents chooses who starts new tasks (${names.join(', ')})`);
  expect(await chooser.getByRole('radio', { name: 'Claude Code' }).getAttribute('aria-checked') === 'true', `${at}: the agent that starts them now is chosen`);
  await click(page, chooser.getByRole('radio', { name: 'Codex' }));
  const put = JSON.parse(await lastPut(page));
  expect(put?.id === 'agent' && put?.patch === 'codex' && await chooser.getByRole('radio', { name: 'Codex' }).getAttribute('aria-checked') === 'true', `${at}: Codex by the pointer sets the agent for new tasks, \`put prefs agent\` (${JSON.stringify(put)})`);
  const shown = await page.locator('.set-pane').innerText();
  expect(!/Use for new tasks|Runs new tasks|·/.test(shown) && await page.locator('.set-pane .ring-o').count() === 0, `${at}: no button on any row for it, no "·", no ring`);
  // A click in the field, the command, Tab: kept.
  const field = row('Claude Code').locator('input');
  await click(page, field);
  await page.keyboard.type('caffeinate -i claude --verbose');
  await key(page, 'Tab');
  const kept = JSON.stringify([{ agent: 'claude', command: 'caffeinate -i claude --verbose' }]);
  expect(await stored() === kept, `${at}: a click in Claude Code's field, a command and Tab keep it (${await stored()})`);
  // One that holds what Tasktap sets for a run, then Return: refused in the core's sentence, and the one before stays.
  await field.selectText();
  await page.keyboard.type('claude --resume abc');
  await key(page, 'Enter');
  const err = row('Claude Code').locator('.hint.err');
  const why = (await err.count()) ? await err.textContent() : '';
  expect(why === 'Tasktap sets --resume itself for Claude Code: take --resume out of the command.' && await stored() === kept, `${at}: a command with --resume, then Return, is refused under the field and the one before stays: "${why}"`);
  await picture(page, 'agents-refused', system);
  // The pointer rests on the field's row: the hint (markup) there gave way to the refusal, and the foot says nothing now.
  expect(((await page.locator('.sheet .sh-hint').textContent()) ?? '').trim() === '', `${at}: the refusal replaces the row's hint in the foot, the pointer resting on the row`);
  // The refusal belongs to what the field holds: the section left and shown again, the field holds the one kept.
  await section(page, 'thoughts');
  await section(page, 'agents');
  await opened();
  const again = await row('Claude Code').locator('input').inputValue();
  expect(again === 'caffeinate -i claude --verbose' && await row('Claude Code').locator('.hint.err').count() === 0, `${at}: Agents shown again, the field holds the command kept and no refusal: "${again}"`);
  // Emptied, the command goes, and with it the refusal.
  await field.selectText();
  await key(page, 'Backspace');
  await key(page, 'Tab');
  expect(await stored() === '[]' && await err.count() === 0, `${at}: emptied, the command goes and so does the refusal (${await stored()})`);
  for (const e of page.errors) failures.push(`${at}: page: ${e}`);
  await page.context().close();

  // A first word Tasktap does not find: the agent stays in sight and says which word.
  const records = scene('busy');
  const fails = 'Tasktap finds no program named op for the command of Codex';
  records.agents = records.agents.map((a) => (a.id === 'codex' ? { ...a, installed: false, version: null, signed_in: null, identity: null, command_fails: fails } : a));
  records.prefs = [...(records.prefs || []), { id: 'agent_commands', rev: 9, value: [{ agent: 'codex', command: 'op run -- codex' }] }];
  const lost = await open(browser, { label: 'workspace', records, url, dpr: 2, system });
  await section(lost, 'agents');
  const line = lost.locator('.set-pane .line.ag[data-agent=codex]');
  const said = (await line.count()) ? await line.locator('.acts .x.warn').first().textContent() : '';
  expect(await line.isVisible() && said.startsWith('Tasktap finds no program named op for the command of Codex.'), `${at}: Codex, whose command starts with op, which is not found, stays in sight and says so: "${said}"`);
  expect(await line.locator('.x.mono').textContent() === 'op run -- codex', `${at}: its closed row shows its command in place of its version`);
  await click(lost, line.locator('.chev'));
  expect(await lost.locator('.set-pane .line.ag[data-agent=codex] + .ag-d .set:has(> .t:text-is("Start command")) input').inputValue() === 'op run -- codex', `${at}: its field holds its command`);
  await picture(lost, 'agents-lost', system);
  for (const e of lost.errors) failures.push(`${at}: page: ${e}`);
  await lost.context().close();

  // Signed out, signing in types the agent's program as before, though the person has a command for it: what is typed
  // in a shell is the shell's, where the person's own alias applies.
  const out = scene('busy');
  out.agents = out.agents.map((a) => (a.id === 'codex' ? { ...a, signed_in: false, identity: null } : a));
  out.prefs = [...(out.prefs || []), { id: 'agent_commands', rev: 9, value: [{ agent: 'codex', command: 'op run -- codex' }] }];
  const signs = await open(browser, { label: 'workspace', records: out, url, dpr: 2, system });
  await section(signs, 'agents');
  await signs.evaluate(() => {
    const typing = window.__ws.ui.typing, set = typing.set.bind(typing);
    window.__typed = [];
    typing.set = (id, text) => (window.__typed.push(text), set(id, text));
  });
  await click(signs, signs.locator('.set-pane .line.ag[data-agent=codex] button:has-text("Sign in")'));
  // And so does a terminal of the agent opened by hand (a workspace's New Codex Session).
  await signs.evaluate(() => window.__ws.startAgent(window.__ws.LOOSE, 'codex'));
  const typed = await signs.evaluate(() => JSON.stringify(window.__typed));
  expect(typed === JSON.stringify(['codex login', 'codex']), `${at}: Sign in to Codex, and a terminal of it, type the program, not its command: ${typed}`);
  for (const e of signs.errors) failures.push(`${at}: page: ${e}`);
  await signs.context().close();
}

// ——— WebKit, by the pointer alone: every control that acts on a click and then takes keys ———
async function sweep(browser, url) {
  const at = 'mac, the pointer and then keys';
  const page = await open(browser, { label: 'workspace', records: { ...projects('settings'), login: { state: 'off' }, update: { state: 'current', version: '1.3.0' }, prefs: [{ id: 'update_checks', value: false, rev: 1 }] }, url, dpr: 2, system: 'mac' });
  const stored = (id) => page.evaluate((i) => JSON.stringify((window.__fake.records.prefs || []).find((p) => p.id === i)?.value ?? null), id);
  const row = (name) => page.locator(`.set-pane .set:has(> .t:text-is("${name}"))`);
  // Each recorder: a click, then the keys pressed, are the key.
  await section(page, 'thoughts');
  for (const [name, id, combo, code] of [['Key to start a task, from any app', 'capture_key', 'Control+Alt+KeyU', 'KeyU'], ['Key to go to an agent’s question, from any app', 'question_key', 'Control+Alt+KeyI', 'KeyI'],
    ['Key to answer Yes, from any app', 'yes_key', 'Control+Alt+KeyO', 'KeyO'], ['Key to answer No, from any app', 'no_key', 'Control+Alt+KeyP', 'KeyP']]) {
    await click(page, row(name).locator('.rec'));
    await key(page, combo);
    expect(JSON.parse(await stored(id))?.code === code, `${at}: "${name}": a click on Change, then ${combo}, is the key`);
  }
  // Escape after a click ends only the listening: the sheet stays open.
  await click(page, row('Key to answer No, from any app').locator('.rec'));
  await key(page, 'Escape');
  expect(await page.evaluate(() => window.__ws.ui.sheet?.kind) === 'settings' && await row('Key to answer No, from any app').locator('.rec').getAttribute('aria-pressed') === 'false', `${at}: Escape after a click on Change ends the listening and leaves Settings open`);
  // A switch, then Space: the switch again.
  const opens = row('Open Tasktap when the computer starts').locator('[role=switch]');
  await click(page, opens);
  await key(page, 'Space');
  expect(await opens.getAttribute('aria-checked') === 'false', `${at}: a click on the switch to open at login, then Space, turns it back off`);
  // A section's tab, then the arrows.
  await click(page, page.locator('#set-tab-voice'));
  await key(page, 'ArrowDown');
  expect(await page.evaluate(() => window.__ws.ui.sheet?.at) === 'appearance', `${at}: a click on Voice in the list, then the down arrow, shows Appearance`);
  await section(page, 'voice');
  await click(page, row('Key to hold while you talk').locator('.rec'));
  await key(page, 'Control+Shift+KeyY');
  expect(JSON.parse(await stored('talk_key'))?.code === 'KeyY', `${at}: the key held to talk: a click on Change, then the keys, is the key`);
  // The terminals' font: a click in the field, words, Tab.
  await section(page, 'terminal');
  await click(page, row('Font in terminals').locator('input'));
  await page.keyboard.type('Menlo');
  await key(page, 'Tab');
  expect(JSON.parse(await stored('terminal_font')) === 'Menlo', `${at}: a click in the font field, a name and Tab set the terminals' font`);
  // Add your own agent: a click, then its name, Tab, its command and Return.
  await section(page, 'agents');
  await click(page, page.locator('.set-pane button.fold-l:has-text("Add your own agent")'));
  await page.keyboard.type('My tool');
  await key(page, 'Tab');
  await page.keyboard.type('mytool {prompt}');
  await key(page, 'Enter');
  const added = JSON.parse(await stored('own_agents')) ?? [];
  expect(added.some((a) => a.name === 'My tool' && a.command === 'mytool {prompt}'), `${at}: a click on Add your own agent, then its name, Tab, its command and Return add it (${JSON.stringify(added)})`);
  // Settings › Projects: find by typing after a click, a project's other name, and its choice then Tab.
  await section(page, 'projects');
  await click(page, page.locator('.set-pane .field input'));
  const all = await page.locator('.set-pane .line.pj').count();
  await page.keyboard.type('cuegr');
  await page.waitForTimeout(300);
  const found = await page.locator('.set-pane .line.pj > .t').allTextContents();
  expect(found.includes('cuegrid') && found.length < all, `${at}: a click in Find a project, then words, finds it (${found.join(', ')} of ${all})`);
  await click(page, page.locator('.set-pane .line.pj').first());
  await click(page, page.locator('.pj-c button.btn:has-text("Add a name for it")'));
  await page.keyboard.type('stage cues');
  await key(page, 'Enter');
  const named = await page.evaluate(() => JSON.stringify(window.__fake.puts.filter((p) => p.c === 'cards' && p.patch.names).at(-1)?.patch.names ?? null));
  expect(/stage cues/.test(named), `${at}: a click on Add a name for it, then the name and Return, add it (${named})`);
  const choice = page.locator('.pj-c [role=radio]');
  await click(page, choice.filter({ hasText: 'Always on its own copy' }));
  expect(await focused(page) === 'Always on its own copy', `${at}: a click on a choice of where its agent works gives it the keyboard, for Tab to go on from`);
  await key(page, 'Space');
  expect(await page.evaluate(() => JSON.stringify(window.__fake.puts.at(-1)?.patch ?? null)) === JSON.stringify({ isolate: 'always' }), `${at}: and Space on it chooses it again`);
  // Check now: a click asks once.
  await section(page, 'about');
  await page.evaluate(() => window.__fake.updates.splice(0));
  await click(page, row('Check for new versions').locator('button.btn:has-text("Check now")'));
  expect(await page.evaluate(() => JSON.stringify(window.__fake.updates)) === JSON.stringify([{ look: true, now: true }]), `${at}: a click on Check now asks once`);
  for (const e of page.errors) failures.push(`${at}: page: ${e}`);
  await page.context().close();
}

async function main() {
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  // Chromium on both systems; WebKit, the Mac's engine, on the Mac.
  const engines = [['chromium', chromium, ['mac', 'windows']], ['webkit', webkit, ['mac']]], tried = [];
  try {
    for (const [name, launcher, systems] of engines) {
      ENGINE = name;
      // WebKit not installed for Playwright: a NOTE at a desk, a failure where CI is set, which must try the Mac's engine.
      const browser = await launcher.launch({ headless: true }).catch((e) => {
        if (name !== 'webkit') throw e;
        if (process.env.CI) expect(false, 'WebKit is not installed for Playwright, so the rows were not tried in the Mac\'s engine');
        else console.log('NOTE  WebKit is not installed for Playwright: the rows are tried in Chromium only');
        return null;
      });
      if (!browser) continue;
      tried.push(name);
      try {
        for (const system of systems) {
          await login(browser, server.url, system);
          await where(browser, server.url, system);
          await answerKeys(browser, server.url, system);
          await atOnce(browser, server.url, system);
          await noKeys(browser, server.url, system);
          await versions(browser, server.url, system);
          await starts(browser, server.url, system);
        }
        if (name === 'webkit') await sweep(browser, server.url);
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.close();
  }
  console.log(failures.length ? `FAIL  ${failures.length} of the rows' checks` : `PASS  every row driven by the pointer and the keyboard, in Chromium on a Mac and on Windows${tried.includes('webkit') ? ' and in WebKit on a Mac, with WebKit\'s sweep of the controls a click hands keys to' : ' (not in WebKit, which is not installed here)'}, at text size ${TEXT}; pictures in ${out}`);
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
