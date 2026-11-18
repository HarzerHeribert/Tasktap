// What a recording is on its way to the core (design §8): 16 kHz, one channel, signed 16-bit little-endian. The
// microphone gives floats at its own rate; each output sample is the mean of the input it spans, which is exact where
// the rates divide (48 kHz is three to one) and close where they do not (44.1 kHz). It keeps what a chunk leaves
// over, so the bytes are the same however the input is cut.
export const RATE = 16000;
/** Bytes a second of recording is. */
export const BYTES = RATE * 2;

export class Pcm {
  /** Input samples to one output sample. */
  private readonly step: number;
  private sum = 0;
  private had = 0;

  constructor(rate: number) {
    this.step = rate / RATE;
  }

  /** The bytes of the output samples `input` completes; samples outside -1 to 1 are held at the ends. */
  push(input: Float32Array): Uint8Array {
    const out = new DataView(new ArrayBuffer(2 * (Math.ceil((input.length + this.had) / this.step) + 1)));
    let n = 0;
    for (let i = 0; i < input.length; i++) {
      const x = input[i]!;
      let left = 1;
      while (this.had + left >= this.step) {
        const take = this.step - this.had;
        const v = Math.max(-1, Math.min(1, (this.sum + x * take) / this.step));
        out.setInt16(n, Math.round(v < 0 ? v * 32768 : v * 32767), true);
        n += 2;
        left -= take;
        this.sum = this.had = 0;
      }
      this.sum += x * left;
      this.had += left;
    }
    return new Uint8Array(out.buffer, 0, n);
  }
}
