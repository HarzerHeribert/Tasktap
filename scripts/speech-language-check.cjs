// The language of speech on this Mac (host/speech/engine.cpp; design §8, "On this device"), held with the real helper
// and the real model: whatever the order of the person's languages, German is written in German and English in
// English, neither translated; a German sentence that begins with an English word stays German, and the English
// sentence after it stays English; a thought that goes from one language to the other is written as it was said on
// both sides of the change; and a few words at the end stay in the language of what came before them. What is "said"
// is the Mac's own voices, said into files (trials/speech/recordings.py): never a microphone, nothing aloud.
//
//   node scripts/speech-language-check.cjs <ggml-large-v3-turbo-q5_0.bin>
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..'), model = process.argv[2];
const helper = fs.readdirSync(path.join(root, 'host/binaries')).filter((n) => n.startsWith('tasktap-speech-')).map((n) => path.join(root, 'host/binaries', n))[0];
if (!model || !fs.existsSync(model) || !helper) {
  console.log('FAIL  the language of speech on this Mac: it needs the model\'s file as its argument and the helper built (host/scripts/build-speech.sh)');
  process.exit(1);
}
const plain = (text) => text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

/** What the helper writes for a recording, with the person's languages in this order. */
const heard = (pcm, languages) => new Promise((ok, no) => {
  const engine = spawn(helper, [model, ...languages], { stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  engine.stdout.on('data', (d) => (out += d));
  engine.on('close', () => {
    const last = out.trim().split('\n').map((l) => JSON.parse(l)).pop() ?? {};
    last.final === undefined ? no(new Error(`the helper said ${JSON.stringify(last)}`)) : ok(last.final);
  });
  engine.stdin.end(pcm);
});

(async () => {
  const rec = fs.mkdtempSync(path.join(os.tmpdir(), 'tasktap-speech-lang-'));
  const failures = [];
  try {
    execFileSync('python3', [path.join(root, 'trials/speech/recordings.py'), rec, 'de-3', 'de-4', 'de-5', 'en-3', 'en-4', 'en-5', 'mixs-4', 'mixs-7'], { stdio: 'ignore' });
    const clip = (name) => fs.readFileSync(path.join(rec, name + '.wav')).subarray(44);
    const pause = Buffer.alloc(2 * 6400), then = (...clips) => Buffer.concat(clips.flatMap((c, i) => (i ? [pause, c] : [c])));
    const german = 'das mikrofon darf nur laufen solange ich die taste gedrückt halte', english = 'refactor the recorder so the microphone stops the moment i let go of the key';
    const cases = [
      ['a German sentence', clip('de-5.anna'), [german]],
      ['an English sentence', clip('en-5.daniel'), [english]],
      ['a German sentence that begins with an English word, and the English sentence after it', clip('mixs-7.anna'), ['das ganze erst wenn der reviewer sein', 'do not skip the code review']],
      ['a German sentence with an English word second', clip('mixs-4.anna'), ['von gestern hat den recorder kaputt gemacht bitte mach einen revert']],
      ['German, then English', then(clip('de-5.anna'), clip('en-5.daniel')), [german, english]],
      ['English, then German', then(clip('en-5.daniel'), clip('de-5.anna')), [english, german]],
      ['two German sentences, then two English', then(clip('de-3.anna'), clip('de-4.anna'), clip('en-3.daniel'), clip('en-4.daniel')), ['wir brauchen eine übersicht aller offenen fragen', 'auf 14 punkt', 'to the download and verify the checksum afterwards', 'after the window closes']],
      ['two English sentences, then two German', then(clip('en-3.daniel'), clip('en-4.daniel'), clip('de-3.anna'), clip('de-4.anna')), ['to the download and verify the checksum afterwards', 'after the window closes', 'wir brauchen eine übersicht aller offenen fragen', 'auf 14 punkt']],
    ];
    for (const [name, pcm, want] of cases) {
      for (const languages of [['de', 'en'], ['en', 'de']]) {
        const text = await heard(pcm, languages), missing = want.filter((w) => !plain(text).includes(w));
        if (missing.length) failures.push(name), console.log(`FAIL  ${name}, with ${languages.join(' before ')}: ${JSON.stringify(text)} lacks ${JSON.stringify(missing)}`);
      }
    }
    console.log(failures.length ? `FAIL  the language of speech on this Mac: ${failures.length} wrong`
      : `PASS  with German before English and English before German alike, the real helper writes ${cases.length} recordings as they were said, none translated: a German and an English sentence, a German sentence that begins with an English word and the English one after it, and thoughts that go from German to English and back`);
  } finally {
    fs.rmSync(rec, { recursive: true, force: true });
  }
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
