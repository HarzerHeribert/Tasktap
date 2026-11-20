// Voice, recorded by the page, checked in headless Chromium with a microphone that is a file: a 440 Hz tone the
// browser plays into getUserMedia (no real microphone is opened, and nothing is played). The page's real recorder
// runs: the worklet, the conversion and the stream, against the fake core of motion-pages.cjs, which keeps the bytes.
// It holds the page to what is promised of it: the microphone is asked for only when voice is first used; what
// arrives on the stream is 16 kHz mono 16-bit with the tone in it, as long as it was held; the microphone's track has
// ended the moment the person lets go, cancels, the page loses the window, or the core closes the stream; a thought
// spoken into the empty Composer is captured, and words spoken into a reply go into its field with nothing sent.
// usage: node scripts/voice-check.cjs   (exit status 1 on a failure; ui/dist must be built)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
const { scene, flow } = require('./instrument-fixtures.cjs');

const HZ = 440;
/** Three seconds of the tone as a WAV file at 48 kHz, which is what a microphone gives. */
function tone(file) {
  const rate = 48000, n = rate * 3, wav = Buffer.alloc(44 + 2 * n);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + 2 * n, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(2 * rate, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2 * n, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * HZ * i) / rate)), 44 + 2 * i);
  fs.writeFileSync(file, wav);
}

// In the page: every microphone it was given, and whether any of them still hears.
const watch = () => {
  window.__mics = [];
  const ask = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await ask(c);
    window.__mics.push(s);
    return s;
  };
  window.__hears = () => window.__mics.some((s) => s.getTracks().some((t) => t.readyState === 'live'));
};
/** What the fake core got on the dictation's stream: its length, loudest sample and the pitch of its zero crossings. */
const heard = () => {
  const all = Object.values(window.__fake.heard), h = all[all.length - 1];
  if (!h) return null;
  const bytes = Uint8Array.from(h.bytes), view = new DataView(bytes.buffer), s = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) s.push(view.getInt16(i, true));
  const seconds = s.length / 16000, crossings = s.filter((v, i) => i > 0 && s[i - 1] < 0 !== v < 0).length;
  return { odd: bytes.length % 2, seconds, peak: Math.max(0, ...s.map(Math.abs)), hz: crossings / 2 / Math.max(seconds, 0.001) };
};

async function main() {
  const { chromium } = require('playwright');
  const wav = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tasktap-voice-')), 'tone.wav');
  tone(wav);
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] });
  const failures = [];
  const hold = async (page, ok, said) => { if (!(await ok)) failures.push(said); };
  const state = (page) => page.evaluate(() => ({ hears: window.__hears(), live: window.__speech.live(), rows: window.__fake.records.dictations?.length ?? 0, asked: window.__mics.length }));
  const centre = async (page, sel) => { const b = await page.locator(sel).first().boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  try {
    // A thought spoken into the empty Composer, the microphone control held with the pointer.
    let page = await open(browser, { label: 'workspace', records: flow(scene('normal'), 'off'), url: server.url, dpr: 1, permissions: ['microphone'] });
    await page.addInitScript(watch);
    await page.reload();
    await page.waitForTimeout(700);
    await hold(page, state(page).then((s) => s.asked === 0 && !s.hears), 'the microphone is asked for before voice is used');
    await page.mouse.move(...(await centre(page, '.home .mic')));
    await page.mouse.down();
    // Held 2.2 s from when the microphone hears, which on a busy machine is a moment after the press.
    await page.waitForFunction(() => window.__hears(), null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2200);
    await hold(page, state(page).then((s) => s.asked === 1 && s.hears && s.live && s.rows === 1), 'holding the microphone control does not record');
    await hold(page, page.evaluate(() => /Listening/.test(document.querySelector('.home .hear')?.textContent ?? '') && Number(document.querySelector('.home .hear .lvl')?.style.getPropertyValue('--l')) > 0.3), 'the row does not show the level while recording');
    await page.mouse.up();
    // Let go: the track has ended by the next turn of the page, before the core has said anything.
    await hold(page, state(page).then((s) => !s.hears), 'the microphone still hears after letting go');
    await page.waitForTimeout(1500);
    const h = await page.evaluate(heard);
    if (!h || h.odd || Math.abs(h.seconds - 2.2) > 0.6 || Math.abs(h.hz - HZ) > 6 || Math.abs(h.peak - 16383) > 1200) failures.push(`the recording on the stream is not 16 kHz mono 16-bit with the tone in it: ${JSON.stringify(h)}`);
    await hold(page, page.evaluate(() => window.__fake.records.thoughts.some((t) => t.source === 'voice') && !!document.querySelector('.home .way')), 'a spoken thought is not captured and shown on its way');
    await hold(page, state(page).then((s) => !s.hears && !s.live && s.rows === 0), 'a microphone or a row is left after a spoken thought');
    console.log(`recorded: ${h ? `${h.seconds.toFixed(2)} s, ${Math.round(h.hz)} Hz, peak ${h.peak}` : 'nothing'}`);
    // Escape while recording; then a recording a click keeps on, ended by the page losing the window, and by the core.
    await page.evaluate(() => { window.__fake.records.thoughts = window.__fake.records.thoughts.filter((t) => t.source !== 'voice'); window.__speech.cap.sent = null; window.__motion.redraw(); });
    await page.waitForTimeout(200);
    for (const [how, end] of [
      ['Escape', () => page.keyboard.press('Escape')], ['the page losing the window', () => page.evaluate(() => window.dispatchEvent(new Event('blur')))],
      ['the core closing the stream', () => page.evaluate(() => window.__fake.close())],
    ]) {
      await page.mouse.click(...(await centre(page, '.home .mic')));
      await page.waitForTimeout(900);
      await hold(page, state(page).then((s) => s.hears && s.live), `a click on the microphone control does not keep it on (before ${how})`);
      await end();
      await page.waitForTimeout(150);
      await hold(page, state(page).then((s) => !s.hears && !s.live), `the microphone still hears after ${how}`);
      await page.waitForTimeout(1200);
      await page.evaluate(() => { const f = window.__fake; f.records.thoughts = f.records.thoughts.filter((t) => t.source !== 'voice'); window.__speech.cap.sent = null; window.__motion.redraw(); });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }
    await page.context().close();
    // Words spoken into a question's reply, ⌥Space held on the keyboard: they go into the field, and nothing is sent.
    page = await open(browser, { label: 'workspace', records: Object.assign(flow(scene('busy'), 'off'), { hears: { text: 'retry it three times' } }), url: server.url, dpr: 1, permissions: ['microphone'] });
    await page.addInitScript(watch);
    await page.reload();
    await page.waitForTimeout(700);
    await page.locator('.hq.open .reply input').focus();
    await page.keyboard.type('Yes, but');
    await page.keyboard.down('Alt');
    await page.keyboard.down('Space');
    await page.waitForTimeout(1500);
    await hold(page, page.evaluate(() => window.__hears() && !!document.querySelector('.hq.open .reply .lvl')), 'holding ⌥Space in a reply field does not record for it');
    await page.keyboard.up('Space');
    await page.keyboard.up('Alt');
    await hold(page, state(page).then((s) => !s.hears), 'the microphone still hears after the key is let go');
    await page.waitForTimeout(1500);
    await hold(page, page.evaluate(() => document.querySelector('.hq.open .reply input').value === 'Yes, but retry it three times' && !window.__fake.calls.includes('question.answer') && !window.__fake.calls.includes('thought.capture')),
      'words spoken into a reply do not arrive in its field, or something was sent');
    await hold(page, state(page).then((s) => !s.hears && !s.live && s.rows === 0), 'a microphone or a row is left after words for a field');
    for (const e of page.errors) failures.push(`the page said: ${e}`);
    await page.context().close();
  } finally {
    await browser.close();
    await server.close();
    fs.rmSync(path.dirname(wav), { recursive: true, force: true });
  }
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? `FAIL  voice: ${failures.length} things wrong` : 'PASS  the page asks for the microphone only when voice is used; the recording on the stream is 16 kHz mono 16-bit with the tone in it; the microphone has ended the moment the person lets go, cancels, leaves the window or the core closes the stream; a spoken thought is captured, and words for a reply go into its field with nothing sent');
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
