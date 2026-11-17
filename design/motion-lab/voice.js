// Voice: turns a microphone, or a built-in simulated speaker, into a few numbers per frame.
// Nothing is recorded and nothing leaves the page: the analyser is read and forgotten.
//
//   level     smoothed loudness, 0..1 (quick to rise, slow to fall)
//   fast      the same with almost no smoothing, for flicks
//   onset     1 at a consonant or a new syllable, decaying in about a tenth of a second
//   onsets    how many onsets so far (lets a visual step forward once per onset)
//   bright    where the energy sits in the spectrum, 0 dark .. 1 bright
//   vowel     loudness that is voiced (pitched), which is what should swell a form
//   sib       hiss: s, sh, f, t
//   pitch     rough pitch of the voice, 0 low .. 1 high
//   activity  a slow follower: "someone is speaking"
//   data      128 x 2 texels for the shaders: row 0 the last two seconds of
//             (level, bright, onset, vowel), newest first; row 1 the spectrum

const BINS = 32, HIST = 128, RATE = 60;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { x = clamp((x - a) / (b - a)); return x * x * (3 - 2 * x); };
const bump = (x, w) => Math.exp(-(x / w) * (x / w));
const noise = n => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };

// A speech-like script: phrases of stressed and unstressed syllables with pauses between them.
function script() {
  let seed = 20241117;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const syl = []; let t = .35;
  for (const n of [5, 3, 7, 2, 6, 4]) {
    const base = .32 + rnd() * .3;
    for (let k = 0; k < n; k++) {
      const dur = .11 + rnd() * .17, stress = k === 1 || rnd() > .72;
      syl.push({
        t, dur, amp: (stress ? .95 : .52 + rnd() * .25) * (1 - .3 * k / n),
        cons: rnd() < .3 ? 2 : rnd() < .62 ? 1 : 0,          // 2: s/sh, 1: p/t/k, 0: none
        f1: 6 + rnd() * 7, f2: 14 + rnd() * 8, pitch: base * (1 - .3 * k / n) + (stress ? .12 : 0)
      });
      t += dur + .035 + (rnd() < .18 ? .14 : 0);
    }
    t += .5 + rnd() * .8;
  }
  return { syl, len: t };
}

export class Voice {
  constructor() {
    Object.assign(this, { level: 0, fast: 0, slow: 0, onset: 0, onsets: 0, bright: .4, vowel: 0, sib: 0, pitch: .4, activity: 0, quiet: 9 });
    this.spec = new Float32Array(BINS); this.raw = new Float32Array(BINS); this.prev = new Float32Array(BINS); this.floor = new Float32Array(BINS);
    this.data = new Float32Array(HIST * 2 * 4); this.hoff = 0; this.acc = 0;
    this.sens = 1; this.mic = null; this.fluxAvg = 0; this.since = 1; this.lvFloor = 0; this.t = 0; this.script = script();
  }

  async useMic() {
    if (this.mic) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser offers no microphone here. Open the page from http://localhost.');
    // The audio context is made inside the click, before the permission prompt, so Safari lets it run.
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
    catch (e) { ctx.close(); throw e; }
    const an = ctx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = .35;
    const mute = ctx.createGain(); mute.gain.value = 0;
    ctx.createMediaStreamSource(stream).connect(an); an.connect(mute); mute.connect(ctx.destination);   // through a closed gain: it is analysed, never heard
    const hz = ctx.sampleRate / an.fftSize, edges = [];
    for (let b = 0; b <= BINS; b++) edges.push(Math.max(1, Math.round(90 * Math.pow(8000 / 90, b / BINS) / hz)));
    this.mic = { stream, ctx, an, edges, td: new Float32Array(an.fftSize), fd: new Float32Array(an.frequencyBinCount), rate: ctx.sampleRate };
    this.lvFloor = 0; this.floor.fill(0);
  }
  stopMic() {
    if (!this.mic) return;
    this.mic.stream.getTracks().forEach(t => t.stop()); this.mic.ctx.close(); this.mic = null;
  }

  // Raw measurements for this instant: fills this.raw (spectrum) and returns loudness, voicedness and pitch.
  measureMic(dt) {
    const { an, td, fd, edges, rate } = this.mic, gain = this.sens;
    an.getFloatTimeDomainData(td); an.getFloatFrequencyData(fd);
    let s = 0; for (let i = 0; i < td.length; i++) s += td[i] * td[i];
    let lv = clamp((20 * Math.log10(Math.sqrt(s / td.length) * gain + 1e-7) + 60) / 50);      // -60 dB is silence, -10 dB is full
    // The room's own noise is learned as a floor that drops at once and creeps up slowly.
    this.lvFloor += (lv < this.lvFloor ? 10 : .06) * dt * (lv - this.lvFloor);
    lv = clamp((lv - this.lvFloor - .05) / (.95 - this.lvFloor));
    const g = 20 * Math.log10(gain);
    for (let b = 0; b < BINS; b++) {
      let m = 0, a = edges[b], z = Math.max(a + 1, edges[b + 1]);
      for (let i = a; i < z; i++) m += fd[i];
      const v = clamp((m / (z - a) + g + 96) / 62);
      this.floor[b] += (v < this.floor[b] ? 10 : .06) * dt * (v - this.floor[b]);
      this.raw[b] = clamp((v - this.floor[b] - .05) * 1.9) * smooth(0, .08, lv);
    }
    // Pitch by autocorrelation on a quarter of the samples, 75 to 350 Hz.
    let voiced = 0, pitch = this.pitch;
    if (lv > .06) {
      const step = 4, n = (td.length / step) | 0, sr = rate / step, lo = (sr / 350) | 0, hi = Math.min(n >> 1, (sr / 75) | 0);
      let e = 1e-9, best = 0, lag = 0;
      for (let i = 0; i < n - hi; i++) e += td[i * step] * td[i * step];
      for (let l = lo; l < hi; l++) {
        let c = 0; for (let i = 0; i < n - hi; i++) c += td[i * step] * td[(i + l) * step];
        if (c > best) { best = c; lag = l; }
      }
      voiced = clamp(best / e);
      if (lag && voiced > .45) pitch = clamp(Math.log2(sr / lag / 75) / Math.log2(350 / 75));
    }
    return { lv, voiced, pitch };
  }
  measureSim() {
    const { syl, len } = this.script, tau = this.t % len, raw = this.raw;
    raw.fill(0);
    let lv = 0, voiced = 0, pitch = this.pitch;
    for (const s of syl) {
      const x = tau - s.t;
      if (x < -.09 || x > s.dur + .1) continue;
      const e = smooth(0, .04, x) * (1 - smooth(s.dur - .06, s.dur + .05, x)) * s.amp * (.9 + .1 * Math.sin(x * 41));
      if (e > 0) {
        lv = Math.max(lv, e); voiced = 1; pitch = s.pitch + .05 * Math.sin(x * 9);
        for (let b = 0; b < BINS; b++)
          raw[b] = Math.max(raw[b], e * (.5 * bump(b - 2 - pitch * 4, 1.6) + .95 * bump(b - s.f1, 2.6) + .7 * bump(b - s.f2, 2.3) + .3 * bump(b - 25, 2)));
      }
      const c = s.cons === 2 ? bump(x + .04, .034) : s.cons === 1 ? bump(x + .012, .013) : 0;
      if (c > .02) {
        lv = Math.max(lv, c * (s.cons === 2 ? .45 : .6));
        for (let b = s.cons === 2 ? 21 : 6; b < BINS; b++) raw[b] = Math.max(raw[b], c * (.45 + .5 * noise(b + this.t * 97)));
      }
    }
    return { lv: clamp(lv * Math.pow(this.sens, .8)), voiced, pitch };
  }

  // calm: Reduce Motion. The history is held level so nothing travels, and onsets are dropped.
  update(dt, calm = false) {
    this.t += dt;
    const { lv, voiced, pitch } = this.mic ? this.measureMic(dt) : this.measureSim();
    const follow = (cur, to, up, down) => cur + (to - cur) * (1 - Math.exp(-dt / (to > cur ? up : down)));
    this.fast = follow(this.fast, lv, .012, .09);
    this.level = follow(this.level, lv, .04, .28);
    this.slow = follow(this.slow, lv, .5, .9);
    this.activity = follow(this.activity, clamp(this.level * 2.4), .14, .6);
    this.quiet = lv > .04 ? 0 : this.quiet + dt;

    let flux = 0, sum = 0, cen = 0, hi = 0, mid = 0;
    for (let b = 0; b < BINS; b++) {
      const v = this.raw[b];
      flux += Math.max(0, v - this.prev[b]) * (.5 + b / BINS); this.prev[b] = v;
      this.spec[b] = follow(this.spec[b], v, .02, .12);
      sum += v; cen += v * b; if (b >= 23) hi += v; else if (b >= 3 && b < 16) mid += v;
    }
    flux /= BINS; this.since += dt;
    if (!calm && flux > this.fluxAvg * 1.8 + .03 && this.since > .075 && lv > .05) { this.onset = 1; this.onsets++; this.since = 0; }
    else this.onset *= Math.exp(-dt / .11);
    this.fluxAvg += (flux - this.fluxAvg) * (1 - Math.exp(-dt / .35));
    if (sum > .4) this.bright = follow(this.bright, cen / sum / (BINS - 1), .05, .05);
    this.sib = follow(this.sib, clamp(hi / 9 * 2.2 - mid / 13 * .6), .015, .07);
    this.vowel = follow(this.vowel, voiced * lv, .05, .14);
    if (voiced > .45) this.pitch = follow(this.pitch, pitch, .06, .06);

    const d = this.data;
    if (calm) {
      for (let i = 0; i < HIST; i++) { d[i * 4] = this.slow; d[i * 4 + 1] = this.bright; d[i * 4 + 2] = 0; d[i * 4 + 3] = this.slow; }
      this.hoff = 0; this.acc = 0;
    } else {
      this.acc += dt;
      while (this.acc >= 1 / RATE) {
        d.copyWithin(4, 0, (HIST - 1) * 4);
        this.kick = follow(this.kick || 0, this.onset, .03, .12);          // a consonant, softened so its travel has no hard edge
        d[0] = this.level; d[1] = this.bright; d[2] = this.kick; d[3] = this.vowel;
        this.acc -= 1 / RATE;
      }
      this.hoff = this.acc * RATE;
    }
    for (let i = 0; i < HIST; i++) {
      const f = i / (HIST - 1) * (BINS - 1), b = Math.min(BINS - 2, f | 0), k = f - b;
      d[(HIST + i) * 4] = (this.spec[b] * (1 - k) + this.spec[b + 1] * k) * (calm ? .4 : 1);
    }
  }
}
