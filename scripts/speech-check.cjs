// Speech on this Mac, as the page has it, checked in headless Chromium with a microphone made in the page (a 440 Hz
// tone, page-microphone.cjs: Chromium is never asked for a microphone, and nothing is played), the fake core of
// motion-pages.cjs and a host whose helper the check plays itself: it decides what the helper "says" and keeps what it
// was fed. It holds the page to what is promised of it:
// - Settings › Speech says what "On this Mac" needs, how far the download is, that it is ready and how large, why it
//   failed, and that it is not available; each with its one action; and once the model is here the speech service
//   that was in use is let go.
// - With no speech service chosen a dictation goes to the helper: the same samples the stream would have carried
//   (16 kHz mono 16-bit with the tone in it), the level and the words so far reported while it records, the whole
//   transcript after letting go; and it ends as a thought, or as words in the field it was spoken into.
// - The microphone's track has ended the moment the person lets go, cancels or the helper fails, and every failure is
//   said in words with what to do: nothing set up, the model missing or damaged, the helper failing, nothing heard.
// usage: node scripts/speech-check.cjs [shots folder]   (exit status 1 on a failure; ui/dist must be built)
const fs = require('node:fs');
const path = require('node:path');
const { serve, open } = require('./motion-pages.cjs');
const { microphone, askedForVoice } = require('./page-microphone.cjs');
const { scene, flow } = require('./instrument-fixtures.cjs');

const HZ = 440, OF = 574041195;
/** The row of Settings that says where speech is turned into text. */
const ROW = '.settings .set:has(.seg[aria-label="Where your speech becomes text"])';
/** What the helper was fed: its length, loudest sample and the pitch of its zero crossings, from the first to the last
 *  (the microphone made in the page is silent for its first moment; a gap after that still lowers the pitch). */
const fed = () => {
  const bytes = Uint8Array.from(window.__fake.speech.fed), view = new DataView(bytes.buffer), s = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) s.push(view.getInt16(i, true));
  let crossings = 0, first = 0, last = 0;
  for (let i = 1; i < s.length; i++) if (s[i - 1] < 0 !== s[i] < 0) (crossings++ || (first = i), (last = i));
  return { odd: bytes.length % 2, seconds: s.length / 16000, hz: crossings > 1 ? (crossings - 1) / 2 / ((last - first) / 16000) : 0, peak: s.reduce((m, v) => Math.max(m, Math.abs(v)), 0) };
};

async function main() {
  const { chromium } = require('playwright');
  const shots = process.argv[2];
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--disable-audio-output'] });
  const failures = [];
  const hold = async (ok, said) => { if (!(await ok)) failures.push(said); };
  const centre = async (page, sel) => { const b = await page.locator(sel).first().boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  const start = async (speech, kind = 'no-service', sceneName = 'normal') => {
    const records = Object.assign(flow(scene(sceneName), kind, { voice: kind !== 'no-service' }), { speech });
    if (kind === 'no-service') records.prefs.push({ id: 'speech_languages', value: ['de', 'en'], rev: 50 });
    const page = await open(browser, { label: 'workspace', records, url: server.url, dpr: 2, permissions: ['microphone'] });
    await microphone(page, { hz: HZ, gain: 0.5 });
    await page.reload();
    await page.waitForTimeout(700);
    return page;
  };
  const state = (page) => page.evaluate(() => ({ hears: window.__hears(), live: window.__speech.live(), rows: window.__fake.records.dictations?.length ?? 0, asked: window.__mics.length,
    said: window.__speech.talk.said, ended: window.__fake.speech.ended, calls: window.__fake.calls.filter((c) => c.startsWith('dictation.')) }));
  // A picture of one part of the page, with whatever scrolls around it at its start, so no bar lies over it.
  const shot = async (page, name, sel) => {
    if (!shots) return;
    await page.evaluate((q) => { for (let e = document.querySelector(q); e; e = e.parentElement) e.scrollTop = 0; }, sel);
    await page.locator(sel).first().screenshot({ path: path.join(shots, `${name}.png`) });
  };
  try {
    // ——— Settings › Speech, state by state ———
    let page = await start({ supported: true, model: 'none', have: 0, of: OF, error: null }, 'off');
    const settings = () => page.evaluate(() => { window.__ws.ui.sheet = { kind: 'settings', at: 'voice' }; window.__motion.redraw(); });
    const row = () => page.evaluate(() => [...document.querySelectorAll('.settings .set')].find((r) => r.querySelector('.t')?.textContent === 'Where your speech becomes text')?.innerText.replace(/\s+/g, ' ') ?? '');
    const press = (label) => page.evaluate((l) => [...document.querySelectorAll('.settings .set button')].find((b) => b.textContent === l)?.click(), label);
    const tell = (status) => page.evaluate((s) => (Object.assign(window.__fake.records.speech, s), window.__fake.emit({ ...window.__fake.records.speech }, 'speech')), status);
    await settings();
    await page.waitForTimeout(300);
    // A service is in use: its row shows; this Mac is one click away and says what it needs, with nothing fetched.
    await hold(row().then((t) => /By OpenAI · gpt-transcribe/.test(t)), `with a service chosen the row does not name it: ${await row()}`);
    await shot(page, 'settings-service', ROW);
    await press('On this Mac');
    await page.waitForTimeout(150);
    await hold(row().then((t) => /Needs a model first: Whisper large-v3 turbo, 574 MB/.test(t) && /Download/.test(t) && /huggingface\.co/.test(t) && /until it is here, OpenAI goes on turning your speech into text/.test(t)), `not set up, the row does not say what it needs: ${await row()}`);
    await hold(page.evaluate(() => !window.__fake.speech.acts.includes('install') && window.__fake.records.prefs.some((p) => p.id === 'speech_by')), 'something was fetched, or the service let go, before the person asked');
    await shot(page, 'settings-needs', ROW);
    await press('Download');
    await tell({ model: 'fetching', have: Math.round(OF * 0.41) });
    await page.waitForTimeout(150);
    await hold(row().then((t) => /Downloading · 41 % of 574 MB/.test(t) && /Stop/.test(t)), `while it downloads the row does not say how far: ${await row()}`);
    await hold(page.evaluate(() => { const p = document.querySelector('.settings progress.got'); return !!p && Math.abs(p.value / p.max - 0.41) < 0.01 && window.__fake.speech.acts.includes('install'); }), 'the download shows no progress, or was not asked for');
    await shot(page, 'settings-downloading', ROW);
    await tell({ model: 'failed', error: 'No network: the model could not be fetched. What arrived is kept; try again when you are online.' });
    await page.waitForTimeout(150);
    await hold(row().then((t) => /No network: the model could not be fetched/.test(t) && /Try again/.test(t) && /Remove/.test(t)), `a failed download is not said with its way on: ${await row()}`);
    await shot(page, 'settings-failed', ROW);
    await press('Try again');
    await tell({ model: 'fetching', have: Math.round(OF * 0.9) });
    await tell({ model: 'ready', have: OF });
    await page.waitForTimeout(300);
    await hold(row().then((t) => /Ready · Whisper large-v3 turbo · 574 MB on this Mac/.test(t) && /Remove/.test(t) && /sent nowhere/.test(t)), `ready, the row does not say so: ${await row()}`);
    await hold(page.evaluate(() => !window.__fake.records.prefs.some((p) => p.id === 'speech_by') && window.__fake.records.prefs.some((p) => p.id === 'keys')), 'once the model is here the service is still in use (or its key was touched)');
    await shot(page, 'settings-ready', ROW);
    await press('Remove');
    await page.waitForTimeout(150);
    await hold(row().then((t) => /Needs a model first/.test(t)).then(async (ok) => ok && (await page.evaluate(() => window.__fake.speech.acts.includes('remove')))), `Remove does not remove the model: ${await row()}`);
    await tell({ model: 'none', have: Math.round(OF * 0.25) });
    await page.waitForTimeout(150);
    await hold(row().then((t) => /Stopped at 25 % of 574 MB/.test(t) && /Continue/.test(t)), `a stopped download does not offer to continue: ${await row()}`);
    await tell({ supported: false, model: 'none', have: 0 });
    await page.waitForTimeout(150);
    await hold(row().then((t) => /Not available on this system/.test(t) && !/Download/.test(t)), `a system without the helper is offered a download: ${await row()}`);
    for (const e of page.errors) failures.push(`the page said: ${e}`);
    await page.context().close();

    // ——— Nothing set up: the microphone brings down Setup's speech step, which says what voice needs and offers the
    // download on Return (design/ui-directions/NOTES.md §13: nothing of it under the Composer); no microphone is asked for ———
    page = await start({ supported: true, model: 'none', have: 0, of: OF, error: null });
    await page.mouse.click(...(await centre(page, '.home .mic')));
    await page.waitForTimeout(400);
    await hold(page.evaluate(() => window.__ws.ui.sheet?.kind === 'setup' && window.__ws.ui.sheet.step === 'speech' && /downloaded once/.test(document.querySelector('.sheet')?.textContent ?? '')
      && /Download/.test(document.querySelector('.sheet .sh-f .key')?.textContent ?? '') && !/Voice needs/.test(document.querySelector('.home .ways')?.textContent ?? '')), 'with nothing set up the microphone does not bring down Setup\'s speech step with its download');
    await hold(state(page).then((s) => s.asked === 0 && s.rows === 0), 'the microphone was asked for with nothing to write it down');
    await shot(page, 'voice-needs', '.sheet');
    await page.context().close();

    // ——— A thought spoken, written down on this Mac ———
    page = await start({ supported: true, model: 'ready', have: OF, of: OF, error: null });
    await hold(state(page).then((s) => s.asked === 0 && !s.hears), 'the microphone is asked for before voice is used');
    await page.mouse.move(...(await centre(page, '.home .mic')));
    await page.mouse.down();
    // Held from when the microphone hears, which on a busy machine is a moment after the press. One that never hears
    // ends the check, said as what it is: nothing after it could be checked.
    if (!(await page.waitForFunction(() => window.__hears(), null, { timeout: 5000 }).then(() => true, () => false))) {
      const s = await state(page);
      throw new Error(`the microphone has not started 5 s after the press (${s.asked ? 'its track is not live' : 'no microphone was given to the page'}: ${JSON.stringify(s)})`);
    }
    const pressed = Date.now();
    await page.waitForTimeout(2200);
    await hold(state(page).then((s) => s.asked === 1 && s.hears && s.live && s.rows === 1 && s.calls.includes('dictation.start')), 'holding the microphone control does not record');
    await hold(page.evaluate(() => window.__asked).then(askedForVoice), `the microphone was not asked for once, for its sound alone in one channel with no voice processing: ${JSON.stringify(await page.evaluate(() => window.__asked))}`);
    await hold(page.evaluate(() => { const sp = window.__fake.speech, d = window.__fake.records.dictations[0]; return sp.id === d.id && sp.languages.join() === 'de,en' && d.level > 50 && window.__fake.calls.includes('dictation.report'); }),
      'the helper was not started for this dictation with the languages, or the level is not reported');
    await hold(page.evaluate(() => Number(document.querySelector('.home .hear .lvl')?.style.getPropertyValue('--l')) > 0.3), 'the row does not show the level');
    await page.evaluate(() => window.__fake.speech.said({ ready: true }));
    await page.evaluate(() => window.__fake.speech.said({ partial: 'Make the header stay' }));
    await page.waitForTimeout(200);
    await hold(page.evaluate(() => window.__fake.records.dictations[0].text === 'Make the header stay' && /Make the header stay/.test(document.querySelector('.home .hear .hear-t')?.textContent ?? '')), 'the words so far are not shown while the person speaks');
    await shot(page, 'voice-listening', '.capture');
    await page.mouse.up();
    const held = (Date.now() - pressed) / 1000;
    await hold(state(page).then((s) => !s.hears), 'the microphone still hears after letting go');
    await page.waitForTimeout(600);
    const h = await page.evaluate(fed);
    if (h.odd || Math.abs(h.seconds - held) > 0.6 || Math.abs(h.hz - HZ) > 6 || Math.abs(h.peak - 16383) > 1200) failures.push(`what the helper was fed is not 16 kHz mono 16-bit with the tone in it: ${JSON.stringify(h)}`);
    await hold(state(page).then((s) => s.ended.length === 1 && !s.ended[0].cancel && s.ended[0].bytes === window_bytes(h) && s.calls.includes('dictation.finish') && s.rows === 1), 'letting go does not end the helper\'s input after the last samples and tell the core');
    await hold(page.evaluate(() => /Writing it down/.test(document.querySelector('.home .hear')?.textContent ?? '')), 'the row does not say the words are being written down');
    await shot(page, 'voice-writing', '.capture');
    // A late line of the words so far is not taken for the transcript.
    await page.evaluate(() => window.__fake.speech.said({ partial: 'Make the header stay on' }));
    await page.waitForTimeout(150);
    await hold(state(page).then((s) => s.rows === 1), 'words so far that arrive after letting go were taken for the whole transcript');
    await page.evaluate(() => window.__fake.speech.said({ final: 'Make the header stay on one line' }));
    await page.waitForTimeout(400);
    await hold(page.evaluate(() => window.__fake.records.thoughts.some((t) => t.source === 'voice' && t.text === 'Make the header stay on one line') && !!document.querySelector('.home .way')), 'the transcript does not become a thought on its way');
    await hold(state(page).then((s) => !s.hears && !s.live && s.rows === 0), 'a microphone or a row is left after a spoken thought');
    await shot(page, 'voice-thought', '.capture');
    console.log(`fed to the helper: ${h.seconds.toFixed(2)} s of ${held.toFixed(2)} s held, ${Math.round(h.hz)} Hz, peak ${h.peak}`);

    // ——— Escape, and the helper failing, while it records ———
    const again = async () => {
      await page.evaluate(() => { const f = window.__fake; f.records.thoughts = f.records.thoughts.filter((t) => t.source !== 'voice'); f.speech.ended.length = 0; window.__speech.cap.sent = null; window.__motion.redraw(); });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      await page.mouse.click(...(await centre(page, '.home .mic')));
      await page.waitForTimeout(900);
      await hold(state(page).then((s) => s.hears && s.live), 'a click on the microphone control does not keep it on');
    };
    await again();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await hold(state(page).then((s) => !s.hears && !s.live && s.rows === 0 && s.ended.some((e) => e.cancel)), 'Escape leaves the microphone, the row or the helper');
    await again();
    await page.evaluate(() => window.__fake.speech.said({ error: 'engine' }));
    await page.waitForTimeout(200);
    await hold(state(page).then((s) => !s.hears && !s.live && s.rows === 0 && /Speech on this Mac could not start\. Try again/.test(s.said)), `a helper that fails is not said, or leaves the microphone on: ${JSON.stringify(await state(page))}`);
    await shot(page, 'voice-failed', '.capture');
    // The model gone or unreadable: said with where to get it again; the microphone is closed again at once.
    await page.evaluate(() => (window.__fake.records.speech.refuses = 'model'));
    await page.keyboard.press('Escape');
    await page.mouse.click(...(await centre(page, '.home .mic')));
    await page.waitForTimeout(900);
    await hold(state(page).then((s) => !s.hears && !s.live && s.rows === 0 && /missing or damaged\. Download it again in Settings › Voice/.test(s.said)), `a missing model is not said: ${JSON.stringify(await state(page))}`);
    await page.evaluate(() => delete window.__fake.records.speech.refuses);
    await page.keyboard.press('Escape');

    // ——— The listening row with everything in it: the time, the words so far, E Edit first, Cancel and Done ———
    await again();
    await page.evaluate(() => window.__fake.speech.said({ partial: 'Make the header stay on one line in the settings sheet, keep its close key at the right and do not let the title wrap' }));
    await page.waitForTimeout(250);
    // Each part that shows is inside the row and beside its neighbours, never over them; the words so far take what
    // is left and are the part that yields.
    const laid = () => page.evaluate(() => {
      const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width }; };
      const hear = document.querySelector('.home .hear'), all = [...hear.children].filter((e) => e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== 'none');
      const parts = all.map((e) => ({ what: e.className || e.tagName, ...box(e) })).sort((x, y) => x.l - y.l), edge = box(hear);
      return { inside: parts.every((x) => x.l >= edge.l - 1 && x.r <= edge.r + 1), apart: parts.every((x, i) => !i || parts[i - 1].r <= x.l + 1),
        has: (q) => !!hear.querySelector(q), words: hear.querySelector('.hear-t')?.getBoundingClientRect().width ?? 0, keys: [...hear.querySelectorAll('.act, .key')].map((e) => e.textContent), parts };
    });
    let r = await laid();
    if (!(r.inside && r.apart && r.words > 200 && r.keys.join('|') === 'EEdit first|escCancel|Done')) failures.push(`the listening row does not hold its words so far, E Edit first, Cancel and Done side by side: ${JSON.stringify(r)}`);
    await shot(page, 'voice-listening-full', '.capture');
    await page.setViewportSize({ width: 640, height: 760 });
    await page.waitForTimeout(250);
    r = await laid();
    if (!(r.inside && r.apart && r.keys.join('|') === 'EEdit first|escCancel|Done')) failures.push(`in a narrow window the listening row's keys are not all legible: ${JSON.stringify(r)}`);
    await shot(page, 'voice-listening-narrow', '.capture');
    await page.setViewportSize({ width: 1180, height: 760 });
    // E while it records: the spoken thought ends as its words in the field, to be edited, and nothing is sent.
    await page.keyboard.press('e');
    await page.waitForTimeout(500);
    await hold(state(page).then((s) => !s.hears && !s.live && s.ended.some((e) => !e.cancel) && s.calls.includes('dictation.finish')), 'E does not end the recording');
    await page.evaluate(() => window.__fake.speech.said({ final: 'Make the header stay on one line' }));
    await page.waitForTimeout(400);
    await hold(page.evaluate(() => document.querySelector('.home #capture-input').value === 'Make the header stay on one line' && !window.__fake.records.thoughts.some((t) => t.source === 'voice') && !window.__fake.calls.includes('thought.capture')),
      'a thought spoken on this Mac and ended with E does not arrive in the field as words, or something was sent');
    await hold(state(page).then((s) => !s.hears && !s.live && s.rows === 0), 'a microphone or a row is left after E');
    await page.evaluate(() => { const f = document.querySelector('.home #capture-input'); f.focus(); document.execCommand('selectAll'); document.execCommand('delete'); });

    // ——— Nothing said: whatever the model makes of silence, the core is told nothing was heard ———
    await page.evaluate(() => { const t = window.__speech.talk; t.source = 'clip'; t.clip = btoa(String.fromCharCode(...new Uint8Array(32000))); });
    await page.mouse.click(...(await centre(page, '.home .mic')));
    await page.waitForTimeout(1900);
    await hold(state(page).then((s) => !s.live && s.calls.includes('dictation.finish')), 'a recording that is over does not end by itself');
    await page.evaluate(() => window.__fake.speech.said({ final: 'Untertitel der Amara.org-Community' }));
    await page.waitForTimeout(300);
    await hold(page.evaluate(() => /Nothing was heard/.test(document.querySelector('.home .way.failed')?.textContent ?? '') && !window.__fake.records.thoughts.some((t) => /Untertitel/.test(t.text))), 'silence became words');
    await shot(page, 'voice-nothing', '.capture');
    for (const e of page.errors) failures.push(`the page said: ${e}`);
    await page.context().close();

    // ——— Words spoken into a question's reply: they go into the field, and nothing is sent ———
    page = await start({ supported: true, model: 'ready', have: OF, of: OF, error: null }, 'no-service', 'busy');
    await page.locator('.hq.open .reply input').focus();
    await page.keyboard.type('Yes, but');
    await page.keyboard.down('Alt');
    await page.keyboard.down('Space');
    await page.waitForTimeout(1500);
    await hold(page.evaluate(() => window.__hears() && !!document.querySelector('.hq.open .reply .lvl')), 'holding ⌥Space in a reply field does not record for it');
    await page.keyboard.up('Space');
    await page.keyboard.up('Alt');
    await hold(state(page).then((s) => !s.hears), 'the microphone still hears after the key is let go');
    await page.waitForTimeout(500);
    await page.evaluate(() => window.__fake.speech.said({ final: 'retry it three times' }));
    await page.waitForTimeout(400);
    await hold(page.evaluate(() => document.querySelector('.hq.open .reply input').value === 'Yes, but retry it three times' && !window.__fake.calls.includes('question.answer') && !window.__fake.calls.includes('thought.capture')),
      'words spoken into a reply do not arrive in its field, or something was sent');
    await hold(state(page).then((s) => !s.hears && !s.live && s.rows === 0), 'a microphone or a row is left after words for a field');
    for (const e of page.errors) failures.push(`the page said: ${e}`);
    await page.context().close();
  } finally {
    await browser.close();
    await server.close();
  }
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? `FAIL  speech on this Mac: ${failures.length} things wrong`
    : 'PASS  Settings says what speech on this Mac needs, how far its download is, that it is ready, why it failed and where it is not available, and lets the service go once the model is here; with no service a dictation is fed to the helper as 16 kHz mono 16-bit with the tone in it, its level and words so far show while it records, and its transcript becomes a thought, words in a field, or with E the words of the thought to edit; the listening row keeps its keys legible beside the words so far, also in a narrow window; the microphone has ended the moment the person lets go, cancels or the helper fails; nothing set up, a missing model, a failing helper and silence are each said in words');
  process.exitCode = failures.length ? 1 : 0;
}
/** The bytes of what was fed, from its seconds. */
const window_bytes = (h) => Math.round(h.seconds * 32000);
main().catch((e) => { console.error(e); process.exit(1); });
