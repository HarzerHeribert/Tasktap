// What a part of a page undoes when it goes is done the moment it goes. Preact runs the end of an effect after the
// next frame (or a fallback timer, where no frame is drawn: a window behind others, a locked screen, a busy page), so a
// part that ended a thing of the whole page there could end it after a newer part had begun it (the hold-to-talk
// recorder of 2026-11-20: Thoughts' recorders, gone, ended the listening of Voice's, pressed in the meantime). Here,
// two things done in one go, before the page has any frame, each as a person can do them one after the other, and
// what has to hold after them (Chromium on a Mac and on Windows, WebKit on a Mac, on fixture records):
//   - Settings put away (⌘W) and ⌘3 pressed: Settings stays away (its section keys went with it).
//   - Setup's sheet that came by itself replaced by Settings, and Shift-Tab on Settings' first control: the keyboard
//     stays in Settings, at its last control (the sheet before kept it no longer).
//   - Settings put away while the microphone trial in Appearance listens: the microphone is off that moment.
//   - The projects sheet put away by a click beside it (which answers Not now) and opened again, Search there pressed
//     if it is offered again: no Not now lands after an answer given since; the sheet opened again shows the Not now,
//     as it does when it is opened again a while later.
//   - Home left for a workspace and shown again while a question waits at its Composer: the question waits in Needs
//     you and the field has the keyboard, as when the two are a while apart.
// usage: node scripts/late-cleanup-check.cjs   (ui/dist must be built)
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const { serve, open } = require('./motion-pages.cjs');
const { scene } = require('./instrument-fixtures.cjs');

const failures = [];
let ENGINE = 'chromium';
const expect = (ok, what) => (console.log(`${ok ? 'ok  ' : 'FAIL'} [${ENGINE}] ${what}`), ok || failures.push(`[${ENGINE}] ${what}`));
/** Lets the render the last thing asked for happen (Preact renders in a microtask), still in the same go. */
const RENDERED = 'await new Promise((done) => queueMicrotask(done));';
const settled = (page, ms = 450) => page.waitForTimeout(ms);
const done = async (page, at) => {
  for (const e of page.errors) failures.push(`[${ENGINE}] ${at}: page: ${e}`);
  await page.context().close();
};

async function sectionKeys(browser, url, system) {
  const at = `${system}, Settings put away and ${system === 'mac' ? '⌘3' : 'Ctrl+3'} pressed in one go`;
  const page = await open(browser, { label: 'workspace', records: scene('busy'), url, dpr: 1, system });
  await page.evaluate(() => (window.__ws.open({ kind: 'settings', at: 'thoughts' }), window.__motion.redraw()));
  await settled(page);
  const sheet = await page.evaluate(new Function(`return (async () => {
    window.__ws.command('close-tab');
    ${RENDERED}
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '3', code: 'Digit3', metaKey: ${system === 'mac'}, ctrlKey: ${system !== 'mac'}, bubbles: true, cancelable: true }));
    ${RENDERED}
    return JSON.stringify(window.__ws.ui.sheet);
  })()`));
  await settled(page);
  const after = await page.evaluate(() => JSON.stringify(window.__ws.ui.sheet));
  expect(sheet === 'null' && after === 'null', `${at}: Settings stays away (${sheet}, then ${after})`);
  await done(page, at);
}

async function trap(browser, url, system) {
  const at = `${system}, the sheet that came by itself replaced by Settings and Shift-Tab pressed in one go`;
  const page = await open(browser, { label: 'workspace', records: scene('first'), url, dpr: 1, system });
  await page.evaluate(() => ((window.__ws.ui.sheet = { kind: 'setup', step: 'projects', auto: true }), window.__motion.redraw()));
  await settled(page);
  const where = await page.evaluate(new Function(`return (async () => {
    window.__ws.open({ kind: 'settings', at: 'thoughts' });
    ${RENDERED}
    const sheet = document.querySelector('.sheet');
    const all = [...sheet.querySelectorAll('button, input, [tabindex="0"]')].filter((x) => !x.hidden && x.tabIndex >= 0);
    all[0].focus();
    all[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    const a = document.activeElement;
    return a === all[all.length - 1] ? 'last' : a?.closest('.sheet') ? 'in the sheet' : a?.id || a?.tagName;
  })()`));
  expect(where === 'last', `${at}: the keyboard goes round to Settings' last control, not out of it (${where})`);
  await done(page, at);
}

/** A microphone that is a tone, made in the page: nothing is asked of the system. */
const MIC = () => {
  const mic = async () => {
    const ctx = new AudioContext(), tone = ctx.createOscillator(), out = ctx.createMediaStreamDestination();
    tone.connect(out);
    tone.start();
    return (window.__mic = out.stream);
  };
  if (typeof MediaDevices === 'function') Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { value: mic, configurable: true });
  if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: mic }, configurable: true });
};
async function trial(browser, url, system) {
  const at = `${system}, Settings put away while the microphone trial listens`;
  const page = await open(browser, { label: 'workspace', records: scene('busy'), url, dpr: 1, system, init: MIC });
  await page.evaluate(() => (window.__ws.open({ kind: 'settings', at: 'appearance' }), window.__motion.redraw()));
  await settled(page);
  await page.evaluate(() => [...document.querySelectorAll('.set-pane .btn')].find((b) => b.textContent === 'Try with the microphone').click());
  const on = await page.waitForFunction(() => window.__ws.ui.voice === true && window.__mic, null, { timeout: 5000 }).then(() => true, () => false);
  expect(on, `${at}: the trial listens`);
  const off = await page.evaluate(new Function(`return (async () => {
    window.__ws.dismiss();
    ${RENDERED}
    return [window.__ws.ui.voice, ...window.__mic.getTracks().map((t) => t.readyState)].join(' ');
  })()`));
  expect(off === 'false ended', `${at}: the microphone is off the moment the sheet goes (listening, track: ${off})`);
  await done(page, at);
}

async function notNow(browser, url, system) {
  const at = `${system}, the projects sheet put away and opened again in one go`;
  const FOLDER = '/Users/example/code';
  const records = { ...scene('first'), offer: { agents: [], places: [{ folder: FOLDER, projects: 3 }] }, looks: [] };
  const page = await open(browser, { label: 'workspace', records, url, dpr: 1, system });
  await page.evaluate(() => (window.__ws.open({ kind: 'setup', step: 'projects' }), window.__motion.redraw()));
  await settled(page);
  const title = await page.evaluate(() => document.querySelector('.sheet #sheet-title')?.textContent);
  expect(title === 'Choose where your projects are', `${at}: the sheet asks where the projects are ("${title}")`);
  // Each word on the folder as the page takes it from the core, in order (the fake's look reads ready later, on again).
  await page.evaluate((f) => {
    const looks = window.__ws.records.looks, set = looks.set.bind(looks);
    window.__said = [];
    looks.set = (k, v) => (v.folder === f && window.__said.push(v.on ? 'on' : 'off'), set(k, v));
  }, FOLDER);
  const offered = await page.evaluate(new Function(`return (async () => {
    document.querySelector('.scrim').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    ${RENDERED}
    window.__ws.open({ kind: 'setup', step: 'projects' });
    ${RENDERED}
    const search = [...document.querySelectorAll('.sheet button')].find((b) => b.textContent.includes('Search there'));
    search?.click();
    return !!search;
  })()`));
  await settled(page, 800);
  const said = await page.evaluate(() => window.__said.join(' '));
  expect(!!said && !/on.* off/.test(said), `${at}: no Not now lands after an answer given since (the folder, in order: ${said || 'nothing'}; Search there ${offered ? 'offered again and pressed' : 'not offered again'})`);
  expect(!offered, `${at}: the sheet opened again shows the Not now just given, as later, and offers no Search there for it`);
  await done(page, at);
}

async function leftWhileAsking(browser, url, system) {
  const at = `${system}, Home left for a workspace and shown again in one go while a question waits at its Composer`;
  const page = await open(browser, { label: 'workspace', records: { ...scene('normal'), asks: { ms: 100 } }, url, dpr: 1, system });
  await page.focus('#capture-input');
  await page.keyboard.type('make the export faster');
  await page.keyboard.press('Enter');
  const asked = await page.waitForFunction(() => document.querySelector('.home .capture .cap-ask'), null, { timeout: 10000 }).then(() => true, () => false);
  expect(asked, `${at}: the question is asked at the Composer`);
  await settled(page);
  await page.evaluate(new Function(`return (async () => {
    window.__ws.show([...window.__ws.records.projects.values()].find((x) => x.open && x.kind === 'folder').id);
    ${RENDERED}
    window.__ws.show('home');
    ${RENDERED}
  })()`));
  await settled(page, 600);
  const now = await page.evaluate(() => [
    [...document.querySelectorAll('[data-question]')].filter((q) => q.offsetParent).map((q) => (q.closest('.capture') ? 'composer' : 'needs')).join(','),
    document.activeElement?.id || document.activeElement?.tagName,
  ].join(' | '));
  expect(now === 'needs | capture-input', `${at}: the question waits in Needs you and the field has the keyboard (${now})`);
  await done(page, at);
}

async function main() {
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const engines = [['chromium', chromium, ['mac', 'windows']], ['webkit', webkit, ['mac']]], tried = [];
  try {
    for (const [name, launcher, systems] of engines) {
      ENGINE = name;
      const browser = await launcher.launch({ headless: true }).catch((e) => {
        if (name !== 'webkit') throw e;
        if (process.env.CI) expect(false, 'WebKit is not installed for Playwright, so these were not tried in the Mac\'s engine');
        else console.log('NOTE  WebKit is not installed for Playwright: tried in Chromium only');
        return null;
      });
      if (!browser) continue;
      tried.push(name);
      try {
        for (const system of systems) {
          await sectionKeys(browser, server.url, system);
          await trap(browser, server.url, system);
          await trial(browser, server.url, system);
          await notNow(browser, server.url, system);
          await leftWhileAsking(browser, server.url, system);
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.close();
  }
  console.log(failures.length ? `FAIL  ${failures.length} of the checks of what goes with a part of a page` : `PASS  what a part of a page undoes is undone the moment it goes, so nothing begun in the same moment is undone with it: Settings' section keys, a sheet's Tab, the microphone trial, the projects sheet's Not now and a Composer left while it asks, in Chromium on a Mac and on Windows${tried.includes('webkit') ? ' and in WebKit on a Mac' : ' (not in WebKit, which is not installed here)'}`);
  process.exitCode = failures.length ? 1 : 0;
}
main();
