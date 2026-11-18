// The motion's listening state, driven by the level of the dictation that records (the core's `dictations` row, ten
// times a second) instead of by a microphone of its own. It gives the engine the numbers a Voice gives it
// (motion/voice.ts), made from that one level: loudness followed quickly and slowly, a step up as an onset, and the
// two rows of texels the shaders read. There is no spectrum in a level, so the second row is one soft hump as loud as
// the voice. Paced by the time the engine passes in, never by frames. It is a `VoiceSource` (motion/engine.ts), as
// the microphone's Voice is.
const HIST = 128, RATE = 60;
const follow = (cur: number, to: number, dt: number, up: number, down: number) => cur + (to - cur) * (1 - Math.exp(-dt / (to > cur ? up : down)));

export class LevelVoice {
  level = 0; fast = 0; slow = 0; onset = 0; onsets = 0; bright = 0.45; vowel = 0; sib = 0; pitch = 0.4; activity = 0; quiet = 9; hoff = 0;
  data = new Float32Array(HIST * 2 * 4);
  open = true;
  private readonly read: () => number;
  private was = 0;
  private acc = 0;
  private kick = 0;

  /** `read`: the level now, 0 to 1. */
  constructor(read: () => number) {
    this.read = read;
  }

  update(dt: number, calm = false) {
    const lv = this.read();
    this.fast = follow(this.fast, lv, dt, 0.03, 0.12);
    this.level = follow(this.level, lv, dt, 0.06, 0.28);
    this.slow = follow(this.slow, lv, dt, 0.5, 0.9);
    this.vowel = follow(this.vowel, lv * 0.8, dt, 0.06, 0.16);
    this.activity = follow(this.activity, Math.min(1, this.level * 2.4), dt, 0.14, 0.6);
    this.quiet = lv > 0.04 ? 0 : this.quiet + dt;
    // A step up in the level is a new syllable.
    if (!calm && lv - this.was > 0.12) (this.onset = 1), this.onsets++;
    else this.onset *= Math.exp(-dt / 0.11);
    this.was = lv;
    const d = this.data;
    if (calm) {
      for (let i = 0; i < HIST; i++) d.set([this.slow, this.bright, 0, this.slow], i * 4);
      this.hoff = this.acc = 0;
    } else {
      this.acc += dt;
      while (this.acc >= 1 / RATE) {
        d.copyWithin(4, 0, (HIST - 1) * 4);
        this.kick = follow(this.kick, this.onset, 1 / RATE, 0.03, 0.12);
        d.set([this.level, this.bright, this.kick, this.vowel]);
        this.acc -= 1 / RATE;
      }
      this.hoff = this.acc * RATE;
    }
    for (let i = 0; i < HIST; i++) d[(HIST + i) * 4] = this.level * Math.exp(-(((i / (HIST - 1) - 0.3) / 0.22) ** 2)) * (calm ? 0.4 : 1);
  }
}
