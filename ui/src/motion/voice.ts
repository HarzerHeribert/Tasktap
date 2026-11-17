// A voice, reduced to a few numbers per frame: the lab's voice.js without its simulated speaker. Its one source is
// the microphone, opened only when the person asks (`Voice.microphone()`), and closed with `close()`. Nothing is
// recorded and nothing leaves the page: the analyser is read and forgotten.
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
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, x: number) => {
  x = clamp((x - a) / (b - a));
  return x * x * (3 - 2 * x);
};

type Mic = { stream: MediaStream; ctx: AudioContext; an: AnalyserNode; edges: number[]; td: Float32Array<ArrayBuffer>; fd: Float32Array<ArrayBuffer>; rate: number };

export class Voice {
  level = 0; fast = 0; slow = 0; onset = 0; onsets = 0; bright = 0.4; vowel = 0; sib = 0; pitch = 0.4; activity = 0; quiet = 9;
  spec = new Float32Array(BINS);
  data = new Float32Array(HIST * 2 * 4);
  hoff = 0;
  sens = 1;
  /** Called once if the microphone goes away by itself (unplugged, or its permission taken back). */
  onend = () => {};
  private raw = new Float32Array(BINS);
  private prev = new Float32Array(BINS);
  private floor = new Float32Array(BINS);
  private acc = 0; private fluxAvg = 0; private since = 1; private lvFloor = 0; private kick = 0;
  private mic: Mic | null;

  private constructor(mic: Mic) {
    this.mic = mic;
    for (const t of mic.stream.getTracks()) t.onended = () => this.mic && (this.close(), this.onend());
  }

  /** Asks for the microphone. Call it from the click that asks for it: the audio context is made inside it, before
   *  the permission prompt, so WebKit lets it run. */
  static async microphone(): Promise<Voice> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This window offers no microphone.');
    const ctx = new AudioContext();
    void ctx.resume();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) {
      void ctx.close();
      throw e;
    }
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.35;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    // Through a closed gain: it is analysed, never heard.
    ctx.createMediaStreamSource(stream).connect(an);
    an.connect(mute);
    mute.connect(ctx.destination);
    const hz = ctx.sampleRate / an.fftSize, edges: number[] = [];
    for (let b = 0; b <= BINS; b++) edges.push(Math.max(1, Math.round((90 * Math.pow(8000 / 90, b / BINS)) / hz)));
    return new Voice({ stream, ctx, an, edges, td: new Float32Array(an.fftSize), fd: new Float32Array(an.frequencyBinCount), rate: ctx.sampleRate });
  }

  get open() {
    return !!this.mic;
  }

  close() {
    if (!this.mic) return;
    this.mic.stream.getTracks().forEach((t) => t.stop());
    void this.mic.ctx.close();
    this.mic = null;
  }

  // Raw measurements for this instant: fills this.raw (spectrum) and returns loudness, voicedness and pitch.
  private measure(mic: Mic, dt: number) {
    const { an, td, fd, edges, rate } = mic, gain = this.sens;
    an.getFloatTimeDomainData(td);
    an.getFloatFrequencyData(fd);
    let s = 0;
    for (let i = 0; i < td.length; i++) s += td[i]! * td[i]!;
    let lv = clamp((20 * Math.log10(Math.sqrt(s / td.length) * gain + 1e-7) + 60) / 50); // -60 dB is silence, -10 dB is full
    // The room's own noise is learned as a floor that drops at once and creeps up slowly.
    this.lvFloor += (lv < this.lvFloor ? 10 : 0.06) * dt * (lv - this.lvFloor);
    lv = clamp((lv - this.lvFloor - 0.05) / (0.95 - this.lvFloor));
    const g = 20 * Math.log10(gain);
    for (let b = 0; b < BINS; b++) {
      let m = 0;
      const a = edges[b]!, z = Math.max(a + 1, edges[b + 1]!);
      for (let i = a; i < z; i++) m += fd[i]!;
      const v = clamp((m / (z - a) + g + 96) / 62);
      this.floor[b]! += (v < this.floor[b]! ? 10 : 0.06) * dt * (v - this.floor[b]!);
      this.raw[b] = clamp((v - this.floor[b]! - 0.05) * 1.9) * smooth(0, 0.08, lv);
    }
    // Pitch by autocorrelation on a quarter of the samples, 75 to 350 Hz.
    let voiced = 0, pitch = this.pitch;
    if (lv > 0.06) {
      const step = 4, n = (td.length / step) | 0, sr = rate / step, lo = (sr / 350) | 0, hi = Math.min(n >> 1, (sr / 75) | 0);
      let e = 1e-9, best = 0, lag = 0;
      for (let i = 0; i < n - hi; i++) e += td[i * step]! * td[i * step]!;
      for (let l = lo; l < hi; l++) {
        let c = 0;
        for (let i = 0; i < n - hi; i++) c += td[i * step]! * td[(i + l) * step]!;
        if (c > best) [best, lag] = [c, l];
      }
      voiced = clamp(best / e);
      if (lag && voiced > 0.45) pitch = clamp(Math.log2(sr / lag / 75) / Math.log2(350 / 75));
    }
    return { lv, voiced, pitch };
  }

  // calm: Reduce Motion. The history is held level so nothing travels, and onsets are dropped.
  update(dt: number, calm = false) {
    if (!this.mic) return;
    const { lv, voiced, pitch } = this.measure(this.mic, dt);
    const follow = (cur: number, to: number, up: number, down: number) => cur + (to - cur) * (1 - Math.exp(-dt / (to > cur ? up : down)));
    this.fast = follow(this.fast, lv, 0.012, 0.09);
    this.level = follow(this.level, lv, 0.04, 0.28);
    this.slow = follow(this.slow, lv, 0.5, 0.9);
    this.activity = follow(this.activity, clamp(this.level * 2.4), 0.14, 0.6);
    this.quiet = lv > 0.04 ? 0 : this.quiet + dt;

    let flux = 0, sum = 0, cen = 0, hi = 0, mid = 0;
    for (let b = 0; b < BINS; b++) {
      const v = this.raw[b]!;
      flux += Math.max(0, v - this.prev[b]!) * (0.5 + b / BINS);
      this.prev[b] = v;
      this.spec[b] = follow(this.spec[b]!, v, 0.02, 0.12);
      sum += v;
      cen += v * b;
      if (b >= 23) hi += v;
      else if (b >= 3 && b < 16) mid += v;
    }
    flux /= BINS;
    this.since += dt;
    if (!calm && flux > this.fluxAvg * 1.8 + 0.03 && this.since > 0.075 && lv > 0.05) {
      this.onset = 1;
      this.onsets++;
      this.since = 0;
    } else this.onset *= Math.exp(-dt / 0.11);
    this.fluxAvg += (flux - this.fluxAvg) * (1 - Math.exp(-dt / 0.35));
    if (sum > 0.4) this.bright = follow(this.bright, cen / sum / (BINS - 1), 0.05, 0.05);
    this.sib = follow(this.sib, clamp((hi / 9) * 2.2 - (mid / 13) * 0.6), 0.015, 0.07);
    this.vowel = follow(this.vowel, voiced * lv, 0.05, 0.14);
    if (voiced > 0.45) this.pitch = follow(this.pitch, pitch, 0.06, 0.06);

    const d = this.data;
    if (calm) {
      for (let i = 0; i < HIST; i++) [d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]] = [this.slow, this.bright, 0, this.slow];
      this.hoff = 0;
      this.acc = 0;
    } else {
      this.acc += dt;
      while (this.acc >= 1 / RATE) {
        d.copyWithin(4, 0, (HIST - 1) * 4);
        this.kick = follow(this.kick, this.onset, 0.03, 0.12); // a consonant, softened so its travel has no hard edge
        [d[0], d[1], d[2], d[3]] = [this.level, this.bright, this.kick, this.vowel];
        this.acc -= 1 / RATE;
      }
      this.hoff = this.acc * RATE;
    }
    for (let i = 0; i < HIST; i++) {
      const f = (i / (HIST - 1)) * (BINS - 1), b = Math.min(BINS - 2, f | 0), k = f - b;
      d[(HIST + i) * 4] = (this.spec[b]! * (1 - k) + this.spec[b + 1]! * k) * (calm ? 0.4 : 1);
    }
  }
}
