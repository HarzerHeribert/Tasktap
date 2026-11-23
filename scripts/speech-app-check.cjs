// Speech on this Mac in the app itself: the debug build on a temporary data folder, passive, driven through its debug
// channel alone (app-driver.cjs). No microphone is opened, nothing is played aloud, and no key or click is sent to the
// system: what is "said" is a tone made in the page or a recording the check hands the page, which plays it into the
// same worklet a microphone feeds.
//
// What a covered window does to it (WebKit calls its page hidden; found when a run failed here while the person
// worked in another app): a page is asked for the microphone only while it is seen, the question of a hidden one
// being held until it shows, so the step that asks "got no answer"; and a recording under way ends the moment its
// window is covered, as letting go ends it (record.ts). A recording begun and ended behind another window is whole.
// So the window comes forward for the one question (`front`, the keyboard stays where it is) and goes back after
// it; behind a locked screen the question is not put, and that is said; and a part during which the window was
// covered, or lost the keyboard to another window, while it recorded is done once more: either ends a recording as
// letting go does (record.ts `lost`), which on GitHub's Mac runner cut one at 0.64 s.
//
//   node scripts/speech-app-check.cjs                      # the helper is the checks' own (speech-engine-fixture.py)
//   node scripts/speech-app-check.cjs --model <ggml file>  # then also the real helper with the real model
//
// First with the fixture helper and a small file standing in for the model: Settings says what is needed, Download
// fetches it (from a file:// address, by the same curl, checked by the same checksum), it is ready, a thought spoken
// goes through the page, the host and the helper and becomes a thought, words spoken into a field that holds text go
// into it, what the helper was fed is 16 kHz mono 16-bit with the tone in it, and no helper is left; Remove removes it.
//
// With --model (Whisper large-v3 turbo q5_0 in whisper.cpp's format, fetched once into a folder of your own: see
// host/src/speech.rs for its address and checksum) the app downloads that file the same way and writes down a German,
// an English and a mixed sentence, said by the Mac's voices into files (trials/speech/recordings.py): each ends as a
// thought with the right words, one as words in a field, and after each the page hears nothing and the helper's
// process is gone. It prints how long each took from the end of the recording, and the helper's memory.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, DEBUG, sleep, root } = require('./app-driver.cjs');

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const NAME = 'ggml-large-v3-turbo-q5_0.bin', SHA = '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2';
const failures = [], lines = [];
const pass = (said) => lines.push('PASS  ' + said);
const note = (said) => lines.push('NOTE  ' + said);
const fail = (said, more = '') => (failures.push(said), lines.push(`FAIL  ${said}${more ? ': ' + more : ''}`));
const check = (ok, said, more) => (ok ? pass(said) : fail(said, more));
const running = (what) => { try { return execFileSync('pgrep', ['-f', what], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; } };
const plain = (text) => text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

/** The page's part, the same for both helpers. */
function page(app) {
  const ask = (expr, a) => app.ask('workspace', expr, a);
  const row = () => ask(`[...document.querySelectorAll('.settings .set')].find((r) => r.querySelector('.t')?.textContent === 'Where your speech becomes text')?.innerText.replace(/\\s+/g, ' ') ?? ''`);
  const press = (label) => ask(`([...document.querySelectorAll('.settings .set button')].find((b) => b.textContent === ${JSON.stringify(label)})?.click(), 1)`);
  const settings = async () => (await ask(`(__ws.ui.sheet = { kind: 'settings', at: 'voice' }, __motion.redraw(), 1)`), sleep(400));
  const home = async () => (await ask(`(__ws.dismiss(), document.querySelector('.welcome .wc')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })), __ws.show('home'), 1)`), sleep(300));
  // Never the real microphone: a press is refused unless a tone or a recording stands in for it.
  // While the check holds the control (`__holding`), the page losing the window counts (`watch`), whatever the
  // recorder has made of it by then.
  const down = () => ask(`(__speech.talk.source === 'microphone' ? Promise.reject('the check would have opened the microphone') : (window.__holding = true, document.querySelector('.home .mic').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 })), 1))`);
  const up = () => ask(`(window.__holding = false, document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })), 1)`);
  const type = (text) => ask(`(document.querySelector('.home #capture-input').focus(), document.execCommand('selectAll'), document.execCommand('delete'), ${text ? `document.execCommand('insertText', false, ${JSON.stringify(text)}), ` : ''}1)`);
  const field = () => ask(`document.querySelector('.home #capture-input').value`);
  const spoken = () => ask(`[...__ws.records.thoughts.values()].filter((t) => t.source === 'voice').map((t) => t.text)`);
  const quiet = () => app.until('workspace', `String(__speech.live()) + ' ' + __ws.records.dictations.size + ' ' + __speech.talk.id`, 'false 0 ', 8);
  /** Takes the thought that was just spoken back, so the Composer is free for the next. */
  const undo = async () => {
    const had = (await spoken()).length;
    app.send('click workspace .home .way .act:not([data-offer])');
    for (const end = Date.now() + 4000; Date.now() < end && (await spoken()).length >= had; await sleep(100));
    await type('');
    await sleep(300);
  };
  /** Counts how often the page loses the window while it records, from now on: covered, or another window given the
   *  keyboard, each of which ends a recording (record.ts `lost`). */
  const watch = () => ask(`(window.__covered = 0, ((lost) => (document.addEventListener('visibilitychange', () => document.hidden && lost()), addEventListener('blur', lost), addEventListener('pagehide', lost)))(() => (window.__holding || __speech.live() || __speech.talk.asking) && __covered++), 1)`);
  const covered = () => ask(`window.__covered`);
  /** From now on, what the page sees, with its time since: the keyboard and the window coming and going, the
   *  pointer let go or cancelled, and each change of the recording (live or not) and of its row (its phase and the
   *  core's error), polled every 20 ms for 15 s; with each, whether the page still had the keyboard. */
  const trace = () => ask(`(window.__trace = [], window.__t0 = performance.now(), ((note) => {
    for (const e of ['blur', 'focus', 'pagehide']) addEventListener(e, () => note(e));
    document.addEventListener('visibilitychange', () => note(document.hidden ? 'hidden' : 'shown'));
    for (const e of ['pointerup', 'pointercancel']) document.addEventListener(e, (ev) => note(e + (ev.isTrusted ? ' (the system)' : ' (the check)')), true);
    let live = null, row = null, n = 0;
    const poll = () => {
      const l = __speech.live(), d = [...__ws.records.dictations.values()].pop(), r = d ? d.phase + (d.error ? ' ' + d.error : '') : 'none';
      if (l !== live) note('live ' + l);
      if (r !== row) note('row ' + r);
      const a = ++n % 25 === 0 && __speech.audio?.();
      if (a) note('audio ' + a.state + ' at ' + a.time.toFixed(2) + ' s, ' + a.frames + ' samples at ' + a.rate + ' Hz');
      (live = l), (row = r);
      if (performance.now() - __t0 < 15000) setTimeout(poll, 20);
    };
    poll();
  })((what) => __trace.push(Math.round(performance.now() - __t0) + ' ms ' + what + (document.hasFocus() ? '' : ' (no keyboard)'))), 1)`.replace(/\n\s*/g, ' '));
  /** What `trace` saw, and what the page last said. */
  const traced = () => ask(`(window.__trace ?? []).join(', ') + '; said: ' + (__speech.talk.said || 'nothing')`);
  /** Whether the page is seen; a covered window comes forward first, until `back`. False behind a locked screen. */
  let forward = false;
  const seen = async () => !(await ask(`document.hidden`)) || (app.send('front'), (forward = true), app.until('workspace', `String(document.hidden)`, 'false', 3));
  const back = () => forward && (app.send('back'), (forward = false));
  return { ask, row, press, settings, home, down, up, type, field, spoken, quiet, undo, watch, covered, seen, back, trace, traced };
}

async function withFixture(shots) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasktap-speech-app-'));
  const model = path.join(tmp, 'model.bin'), says = path.join(tmp, 'says'), log = path.join(tmp, 'log');
  fs.writeFileSync(model, crypto.randomBytes(300000));
  fs.writeFileSync(says, 'Make the header stay on one line');
  fs.writeFileSync(log, '');
  const sum = crypto.createHash('sha256').update(fs.readFileSync(model)).digest('hex');
  const helper = path.join(root, 'host/scripts/speech-engine-fixture.py');
  const app = await launch({ exe: DEBUG, fixture: true, env: { TASKTAP_SPEECH_EXE: helper, TASKTAP_SPEECH_SOURCE: `file://${model} ${sum} 300000`, SPEECH_FIXTURE_SAYS: says, SPEECH_FIXTURE_LOG: log } });
  try {
    await app.prepare();
    const p = page(app), file = path.join(app.tmp, 'data/models', NAME);
    await p.watch();
    await p.ask(`(__speech.talk.source = 'tone')`);
    app.send('call put {"c":"prefs","id":"hold","patch":10}');
    app.send('call put {"c":"prefs","id":"speech_languages","patch":["de","en"]}');
    await sleep(400);
    // Nothing is set up: the microphone brings the welcome's speech step, and nothing was started for it.
    await p.down(), await p.up();
    check(await app.until('workspace', `document.querySelector('.welcome .wc')?.innerText ?? ''`, 'Talk instead of typing', 3) && !fs.existsSync(file),
      'with nothing set up the microphone brings the welcome\'s speech step, and nothing was fetched');
    await p.settings();
    check(/Needs a model first: Whisper large-v3 turbo/.test(await p.row()), 'Settings › Voice says what On this Mac needs', await p.row());
    if (shots) await app.snapshot('workspace', path.join(shots, 'app-settings-needs.png'));
    await p.press('Download');
    check(await app.until('workspace', `[...document.querySelectorAll('.settings .set .v')].map((v) => v.textContent).join('|')`, 'Ready, Whisper large-v3 turbo', 10) && fs.existsSync(file) && fs.readFileSync(file).equals(fs.readFileSync(model))
      && fs.readdirSync(path.dirname(file)).length === 1, 'Download fetches the model into the data folder, checked, and Settings says it is ready', await p.row());
    if (shots) await app.snapshot('workspace', path.join(shots, 'app-settings-ready.png'));
    await p.home();
    // A passive run is never given the microphone. This asks for it and records nothing: a refusal is the pass. Were
    // it ever granted, the track is stopped in the same breath, whenever the answer comes, and the check ends here,
    // loudly. The page must be seen to be asked at all (above).
    if (await p.seen()) {
      const asked = await p.ask(`Promise.race([navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => (s.getTracks().forEach((t) => t.stop()), 'GRANTED'), (e) => 'refused: ' + e.name),
        new Promise((r) => setTimeout(() => r('no answer in 10 s, the page ' + (document.hidden ? 'hidden' : 'seen')), 10000))])`);
      if (asked !== 'refused: NotAllowedError') {
        fail('A PASSIVE RUN WAS GIVEN THE MICROPHONE (or refused it in another way); its track was stopped at once and the check ends here', String(asked));
        return;
      }
      // And the recorder, with no stand-in named, says the refusal in words and hears nothing.
      await p.ask(`(__speech.talk.source = 'microphone')`);
      await p.type('');
      await p.ask(`(document.querySelector('.home .mic').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 })), document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })), 1)`);
      const refused = await app.until('workspace', `document.querySelector('.home .ways')?.innerText ?? ''`, 'The microphone was not allowed. Tasktap can be allowed in System Settings, Privacy & Security, Microphone.', 5);
      check(refused && (await p.quiet()) && running(helper).length === 0, 'a passive run is refused the microphone: asking for it fails in the page, the recorder says so in words, and nothing listens');
    } else note('the screen is locked or asleep, so the page was not asked for the microphone: a page that is not seen is not asked, and is given nothing; the host\'s rule is held by its own test (cargo test, granted)');
    p.back();
    // A stand-in that is named and not there is an error, never the microphone.
    await p.ask(`(__speech.talk.source = 'clip', __speech.talk.clip = '', 1)`);
    await p.down(), await p.up();
    const missing = await app.until('workspace', `__speech.talk.said`, 'The recording that stands in for the microphone is missing.', 5);
    await p.ask(`(__speech.talk.source = 'recording', 1)`);
    await p.ask(`(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })), 1)`);
    await p.down(), await p.up();
    const unknown = await app.until('workspace', `__speech.talk.said`, 'No stand-in for the microphone is called recording.', 5);
    check(missing && unknown && (await p.quiet()), 'a stand-in for the microphone that is missing or unknown is an error in words, never the microphone');
    await p.ask(`(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })), __speech.talk.source = 'tone')`);
    // A thought spoken (a tone made in the page): through the page, the host and the helper, and it is a thought.
    await p.type('');
    // What the page and the app saw meanwhile is said with a failure: what ended a recording that ended early.
    const since = app.events.length;
    await p.trace();
    await p.down();
    const listening = await app.until('workspace', `document.querySelector('.home .hear')?.innerText ?? ''`, 'Listening', 5);
    // This part stands on audio that runs in real time: the recording's own clock and the samples handed over, against
    // a second of the wall's. A Mac with no sound device (GitHub's virtual ones) runs it far slower: there 5 s held
    // gave the helper 0.96 s. Where it does not, what needs real time (the words so far, the length fed) is not held,
    // and that is said; at a desk it is.
    const sound = async () => [Date.now(), await p.ask(`__speech.audio?.() ?? null`)];
    const [w0, a0] = await sound();
    await sleep(1000);
    const [w1, a1] = await sound();
    const span = (w1 - w0) / 1000, pace = a0 && a1 ? (a1.time - a0.time) / span : NaN, fill = a0 && a1 ? (a1.frames - a0.frames) / a1.rate / span : NaN;
    const realtime = !(pace < 0.8 || fill < 0.8);
    if (!realtime)
      note(`this Mac's audio does not run in real time (in ${span.toFixed(2)} s its clock went ${(pace * span).toFixed(2)} s and ${(fill * span).toFixed(2)} s of samples came, ${a1?.state}): a spoken thought's words so far and the length it is fed are not held here`);
    const level = await app.until('workspace', `String([...__ws.records.dictations.values()][0]?.level > 20 && __speech.live())`, 'true', 5);
    const words = realtime ? await app.until('workspace', `document.querySelector('.home .hear .hear-t')?.textContent ?? ''`, 'Make the header', 5) : 'not held';
    const saw = async () => `the page saw: ${await p.traced()}; the app said: ${app.events.slice(since).filter((e) => e.event !== 'report').map((e) => JSON.stringify(e).slice(0, 160)).join(' ') || 'nothing'}`;
    check(listening && level && words, 'while the tone sounds the row says Listening, the level the page reports moves the wave, and the helper\'s words so far show',
      listening && level && words ? '' : `Listening: ${!!listening}, the level: ${!!level}, the words: ${!!words}; the audio's pace ${pace.toFixed(2)}, its samples' ${fill.toFixed(2)}; ${await saw()}`);
    check(running(helper).length === 1, 'one helper runs while it records', String(running(helper).length));
    if (shots) await app.snapshot('workspace', path.join(shots, 'app-listening.png'));
    await p.up();
    const thought = await app.until('workspace', `[...__ws.records.thoughts.values()].find((t) => t.source === 'voice')?.text ?? ''`, 'Make the header stay on one line', 10);
    check(thought && (await p.quiet()), 'letting go ends the recording; the helper\'s transcript becomes a thought, and no microphone or row is left');
    await sleep(300);
    check(running(helper).length === 0, 'the helper is gone once it has answered', running(helper).join(' '));
    const [languages, seconds, peak, hz] = fs.readFileSync(log, 'utf8').trim().split('\n').pop().split(' ');
    const fed = languages === 'de,en' && (seconds > 1 || !realtime) && seconds < 8 && peak > 3000 && hz > 200 && hz < 240;
    check(fed, `the helper was fed what the page recorded: 16 kHz, one channel, 16 bits, with the tone in it, and the languages (${languages}, ${seconds} s, peak ${peak}, ${hz} Hz)`, fed ? '' : await saw());
    if (shots) await app.snapshot('workspace', path.join(shots, 'app-thought.png'));
    await p.undo();
    // Into a field that holds text: the words go to its caret, and nothing is sent.
    const before = (await p.ask(`__ws.records.thoughts.size`));
    fs.writeFileSync(says, 'the header on one line');
    await p.type('First this, then');
    await p.down();
    await app.until('workspace', `document.querySelector('.home .hear')?.innerText ?? ''`, 'Let go to add it', 5);
    await sleep(1200);
    await p.up();
    check(await app.until('workspace', `document.querySelector('.home #capture-input').value + ' ' + __ws.records.thoughts.size`, `First this, then the header on one line ${before}`, 10) && (await p.quiet()),
      'spoken into a field that holds text, the words go to its caret and nothing is sent', await p.field());
    await p.type('');
    // Removed: the file is gone and Settings offers it again.
    await p.settings();
    await p.press('Remove');
    check(await app.until('workspace', `[...document.querySelectorAll('.settings .set .v')].map((v) => v.textContent).join('|')`, 'Needs a model first', 5) && !fs.existsSync(file), 'Remove removes the model', await p.row());
    // A model that is there and cannot be read: said where the person is, and Settings offers the download again.
    fs.writeFileSync(file, Buffer.concat([Buffer.from('damaged'), Buffer.alloc(300000 - 7)]));
    await p.home();
    await p.settings();
    await p.home();
    await p.type('');
    await p.down(), await p.up();
    const told = await app.until('workspace', `__speech.talk.said`, 'The speech model on this Mac is missing or damaged. Download it again in Settings › Voice.', 6);
    await p.settings();
    check(told && (await p.quiet()) && !fs.existsSync(file) && /Needs a model first/.test(await p.row()),
      'a model the helper cannot read is said in words, with what to do; it is removed, Settings offers it again and nothing is left listening', await p.ask(`__speech.talk.said`));
    if (shots) await app.snapshot('workspace', path.join(shots, 'app-damaged.png'));
    return await p.covered();
  } finally {
    await app.quit();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function withModel(model, shots) {
  const bytes = fs.statSync(model).size;
  const rec = fs.mkdtempSync(path.join(os.tmpdir(), 'tasktap-speech-rec-'));
  // Sentences the trial found each engine could be held to; `say` writes them to files, nothing is played.
  execFileSync('python3', [path.join(root, 'trials/speech/recordings.py'), rec, 'de-5', 'en-5', 'mixs-1', 'de-8'], { stdio: 'ignore' });
  const clip = (name) => fs.readFileSync(path.join(rec, name + '.wav')).subarray(44);
  const app = await launch({ exe: DEBUG, fixture: true, env: { TASKTAP_SPEECH_SOURCE: `file://${model} ${SHA} ${bytes}` } });
  const helper = path.join(app.tmp, 'data/models', NAME);
  try {
    await app.prepare();
    const p = page(app);
    await p.watch();
    await p.ask(`(__speech.talk.source = 'tone')`);
    app.send('call put {"c":"prefs","id":"hold","patch":10}');
    app.send('call put {"c":"prefs","id":"speech_languages","patch":["de","en"]}');
    await p.settings();
    await p.press('Download');
    const seen = await app.until('workspace', `[...document.querySelectorAll('.settings .set .v')].map((v) => v.textContent).join('|')`, 'Downloading ', 5);
    if (shots) await app.snapshot('workspace', path.join(shots, 'app-downloading.png'));
    const t0 = Date.now();
    const ready = await app.until('workspace', `[...document.querySelectorAll('.settings .set .v')].map((v) => v.textContent).join('|')`, 'Ready, Whisper large-v3 turbo, 574 MB on this Mac', 120);
    check(seen && ready && fs.statSync(helper).size === bytes, `the real model (${Math.round(bytes / 1e6)} MB) is fetched with its progress shown, checked against its SHA-256 and ready (${((Date.now() - t0) / 1000).toFixed(1)} s from a file on this machine)`, await p.row());
    await p.home();
    const said = async (name, want, into) => {
      await p.type(into ?? '');
      const samples = clip(name), seconds = samples.length / 32000;
      const set = await p.ask((b64) => { const t = window.__speech.talk; t.source = 'clip'; t.clip = b64; return t.source + ' ' + t.clip.length; }, samples.toString('base64'));
      if (set !== `clip ${samples.toString('base64').length}`) throw new Error('the recording did not reach the page');
      const before = (await p.spoken()).length;
      // A click keeps it on; the recording ends by itself when the clip does, as letting go ends it.
      await p.down(), await p.up();
      await app.until('workspace', `String(__speech.live())`, 'true', 5);
      await sleep(Math.min(2500, seconds * 500));
      const pids = running(helper), mb = pids.length ? Number(/phys_footprint: ([0-9.]+) MB/.exec(execFileSync('footprint', ['-p', pids[0]], { encoding: 'utf8' }))?.[1] ?? 0) : 0;
      for (const end = Date.now() + 20000; Date.now() < end && (await p.ask(`__speech.live()`)); await sleep(40));
      const let_go = Date.now();
      let heard = '';
      for (const end = Date.now() + 20000; Date.now() < end && !heard; await sleep(40)) heard = into === undefined ? ((await p.spoken())[before] ?? '') : ((await p.field()) !== into ? await p.field() : '');
      const after = Date.now() - let_go;
      const ok = plain(heard) === plain((into ? into + ' ' : '') + want);
      const quiet = await p.quiet();
      await sleep(300);
      const gone = running(helper).length === 0;
      check(ok && quiet && gone && pids.length === 1, `${name} (${seconds.toFixed(1)} s): ${into === undefined ? 'a thought' : 'words in the field'} with the right words ${after} ms after the recording ended; the page hears nothing and the helper is gone (it held ${Math.round(mb)} MB while it listened)`,
        `${JSON.stringify(heard)} quiet ${quiet} gone ${gone} helpers ${pids.length}`);
      if (into === undefined) await p.undo();
      else await p.type('');
      return after;
    };
    await said('de-5.anna', 'Das Mikrofon darf nur laufen, solange ich die Taste gedrückt halte.');
    if (shots) await app.snapshot('workspace', path.join(shots, 'app-real-thought.png'));
    await said('en-5.daniel', 'Refactor the recorder so the microphone stops the moment I let go of the key.');
    await said('mixs-1.anna', 'Mach bitte einen Rebase auf Main und erstelle danach einen Pull Request.');
    await said('de-8.anna', 'Lösch den alten Ordner erst, wenn die Sicherung vollständig ist.', 'Und dann:');
    // E while it records: the thought ends as its words in the field, to be edited, and nothing is sent.
    {
      await p.type('');
      const samples = clip('de-5.anna'), before = (await p.spoken()).length;
      await p.ask((b64) => { const t = window.__speech.talk; t.source = 'clip'; t.clip = b64; return 1; }, samples.toString('base64'));
      await p.down(), await p.up();
      await app.until('workspace', `String(__speech.live())`, 'true', 5);
      await sleep(3600);
      await p.ask(`(document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', bubbles: true, cancelable: true })), 1)`);
      const words = await app.until('workspace', `document.querySelector('.home #capture-input').value`, 'Das Mikrofon darf nur laufen', 15);
      check(words && (await p.quiet()) && (await p.spoken()).length === before && running(helper).length === 0, 'a thought spoken on this Mac and ended with E arrives in the field as its words, nothing is sent, and the helper is gone', await p.field());
      await p.type('');
    }
    await p.settings();
    await p.press('Remove');
    check(await app.until('workspace', `[...document.querySelectorAll('.settings .set .v')].map((v) => v.textContent).join('|')`, 'Needs a model first', 5) && !fs.existsSync(helper), 'Remove removes the real model');
    return await p.covered();
  } finally {
    await app.quit();
    fs.rmSync(rec, { recursive: true, force: true });
  }
}

(async () => {
  const shots = arg('--shots');
  if (shots) fs.mkdirSync(shots, { recursive: true });
  // A part in which something went wrong while the window was covered as it recorded is done once more: the
  // recording ended there as the recorder is built to end it, and the part says nothing about the app.
  const part = async (run) => {
    for (let again = 0, had = failures.length; ; again++) {
      const covered = await run();
      if (failures.length === had || !covered || again) return console.log(lines.splice(0).join('\n'));
      (failures.length = had), (lines.length = 0);
      console.log('NOTE  the check\'s window was covered or lost the keyboard while it recorded, which ends a recording as letting go does: this part is done once more');
    }
  };
  await part(() => withFixture(shots));
  const model = arg('--model');
  if (model) await part(() => withModel(model, shots));
  else console.log('NOTE  the real helper was not run: no --model was given');
  console.log(failures.length ? `FAIL  speech on this Mac in the app: ${failures.length} things wrong` : `PASS  speech on this Mac works in the app${model ? ', with the real helper and model too' : ' with the checks\' helper'}`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
