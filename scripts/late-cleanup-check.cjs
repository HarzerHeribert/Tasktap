// What a part of a page undoes when it goes is done the moment it goes. Preact runs the end of an effect after the
// next frame (or a fallback timer, where no frame is drawn: a window behind others, a locked screen, a busy page), so a
// part that ended a thing of the whole page there could end it after a newer part had begun it (the hold-to-talk
// recorder of 2026-11-20: Thoughts' recorders, gone, ended the listening of Voice's, pressed in the meantime). Here,
// two things done in one go, before the page has any frame, each as a person can do them one after the other, and
// what has to hold after them (Chromium on a Mac and on Windows, WebKit on a Mac, on fixture records):
//   - Settings put away (⌘W) and ⌘3 pressed: Settings stays away (its section keys went with it).
//   - Settings put away while the microphone trial in Appearance listens: the microphone is off that moment.
//   - Home left for a workspace and shown again while a question waits at its Composer: the question waits in Needs
//     you and the field has the keyboard, as when the two are a while apart.
//   - A letter typed while the empty field's line rolls to the next (lines.ts): nothing of the roll is left, not its
//     copies, not the field's hidden line, not its timer; and the same with a real key pressed during a roll. The same
//     with the New Task sheet put away mid-roll and the notch folded mid-roll; a composition begun in the sheet's field
//     goes with that field (Home's field rolls again); and a page that is not shown has no timer.
// usage: node scripts/late-cleanup-check.cjs [--dist folder]   (ui/dist must be built)
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

async function typedMidRoll(browser, url, system) {
  const at = `${system}, a letter typed in one go with the empty field's line rolling`;
  const page = await open(browser, { label: 'workspace', records: scene('normal'), url, dpr: 1, system });
  await page.evaluate(() => window.__fake.emit({ do: 'where', front: true, notch: false }));
  await page.focus('#capture-input');
  await settled(page, 150);
  const left = () => [document.querySelectorAll('.cap-lines').length, document.querySelectorAll('[data-rolling]').length, window.__lines.rolling].join(' ');
  const now = await page.evaluate(new Function(`return (async () => {
    const f = document.activeElement;
    window.__lines.next(true);
    const rolled = !!document.querySelector('.cap-lines');
    f.value = 'a';
    f.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'a' }));
    ${RENDERED}
    return [rolled, (${left})()];
  })()`));
  expect(now[0] && now[1] === '0 0 false', `${at}: the roll was ${now[0] ? 'under way' : 'not under way'}, and after the letter copies, hidden lines and the timer are ${now[1]}, not 0 0 false`);
  await settled(page);
  expect((await page.evaluate(left)) === '0 0 false' && (await page.inputValue('#capture-input')) === 'a', `${at}: a moment later something of the roll is back, or the letter is lost`);
  // A real key, pressed while a roll moves.
  await page.keyboard.press('Backspace');
  await settled(page, 150);
  await page.evaluate(() => window.__lines.next(true));
  await page.keyboard.press('KeyB');
  const real = await page.evaluate(left);
  expect(real === '0 0 false' && (await page.inputValue('#capture-input')) === 'b', `${at}, with a real key: what is left of the roll is ${real}, the field "${await page.inputValue('#capture-input')}"`);
  await done(page, at);
}

async function goneMidRoll(browser, url, system) {
  const left = () => [document.querySelectorAll('.cap-lines').length, document.querySelectorAll('[data-rolling]').length, window.__lines.rolling, document.getAnimations().filter((a) => !a.effect?.target?.isConnected).length].join(' ');
  // The New Task sheet put away while its line rolls, in one go.
  let at = `${system}, the New Task sheet put away in one go while its line rolls`;
  let page = await open(browser, { label: 'workspace', records: scene('normal'), url, dpr: 1, system });
  await page.evaluate(() => window.__fake.emit({ do: 'where', front: true, notch: false }));
  await page.evaluate(() => ((window.__ws.ui.sheet = { kind: 'capture' }), window.__motion.redraw()));
  await page.waitForSelector('.sheet #capture-input');
  await page.focus('.sheet #capture-input');
  await settled(page, 150);
  const sheet = await page.evaluate(new Function(`return (async () => {
    window.__lines.next(true);
    const rolled = !!document.querySelector('.cap-lines');
    window.__ws.dismiss();
    ${RENDERED}
    return [rolled, (${left})()];
  })()`));
  expect(sheet[0] && sheet[1] === '0 0 false 0', `${at}: the roll was ${sheet[0] ? 'under way' : 'not under way'}; after, copies, hidden lines, the timer and animations left: ${sheet[1]}`);
  // A composition begun in the sheet's field goes with it: Home's field rolls again.
  at = `${system}, the New Task sheet put away during a composition`;
  await page.evaluate(() => ((window.__ws.ui.sheet = { kind: 'capture' }), window.__motion.redraw()));
  await page.waitForSelector('.sheet #capture-input');
  await page.focus('.sheet #capture-input');
  await page.evaluate(() => document.activeElement.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await page.evaluate(() => (window.__ws.dismiss(), window.__motion.redraw()));
  await settled(page, 300);
  await page.focus('.home #capture-input');
  await settled(page, 150);
  expect(await page.evaluate(() => window.__lines.rolling), `${at}: Home's field does not roll, as if the composition went on`);
  await done(page, at);
  // A page that is not shown (a display asleep): no timer; shown again, the line rolls again.
  at = `${system}, the page not shown`;
  page = await open(browser, { label: 'workspace', records: scene('normal'), url, dpr: 1, system });
  await page.evaluate(() => window.__fake.emit({ do: 'where', front: true, notch: false }));
  await page.focus('#capture-input');
  await settled(page, 150);
  await page.evaluate(() => (Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }), document.dispatchEvent(new Event('visibilitychange'))));
  const hidden = await page.evaluate(() => window.__lines.rolling);
  await page.evaluate(() => (Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }), document.dispatchEvent(new Event('visibilitychange'))));
  expect(!hidden && (await page.evaluate(() => window.__lines.rolling)), `${at}: the timer ${hidden ? 'ran' : 'did not run'} while hidden, and ${(await page.evaluate(() => window.__lines.rolling)) ? 'runs' : 'does not run'} once shown`);
  await done(page, at);
  // The notch folded while its line rolls, in one go.
  at = `${system}, the notch folded in one go while its line rolls`;
  page = await open(browser, { label: 'notch', records: scene('normal'), url, dpr: 1, system });
  await page.evaluate(() => window.__fake.emit({ do: 'geometry', width: 104, height: 16, cutout: false, surfaceWidth: 420, surfaceOffset: 0, span: 560, pixel: 1, corner: 10, offset: 0, available: 700, collapsed: false }));
  await page.evaluate(() => window.__fake.emit({ do: 'capture' }));
  await page.waitForSelector('#capture-input');
  await page.focus('#capture-input');
  await settled(page, 300);
  const notch = await page.evaluate(new Function(`return (async () => {
    window.__lines.next(true);
    const rolled = !!document.querySelector('.cap-lines');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    ${RENDERED}
    return [rolled, (${left})()];
  })()`));
  expect(notch[0] && notch[1] === '0 0 false 0', `${at}: the roll was ${notch[0] ? 'under way' : 'not under way'}; after, copies, hidden lines, the timer and animations left: ${notch[1]}`);
  await done(page, at);
}

async function main() {
  const dist = process.argv.includes('--dist') ? process.argv[process.argv.indexOf('--dist') + 1] : path.join(__dirname, '../ui/dist');
  const server = await serve(path.resolve(dist));
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
          await trial(browser, server.url, system);
          await leftWhileAsking(browser, server.url, system);
          await typedMidRoll(browser, server.url, system);
          await goneMidRoll(browser, server.url, system);
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.close();
  }
  console.log(failures.length ? `FAIL  ${failures.length} of the checks of what goes with a part of a page` : `PASS  what a part of a page undoes is undone the moment it goes, so nothing begun in the same moment is undone with it: Settings' section keys, the microphone trial and a Composer left while it asks, in Chromium on a Mac and on Windows${tried.includes('webkit') ? ' and in WebKit on a Mac' : ' (not in WebKit, which is not installed here)'}`);
  process.exitCode = failures.length ? 1 : 0;
}
main();
