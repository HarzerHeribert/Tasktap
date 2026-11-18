// What the core derives from a recording it is sent, derived here for one the page has transcribed on this machine
// (design §8, "The level" and "Nothing was said"), by the same rules and the same numbers: the level is the peak of
// each tenth of a second, 0 at −55 dBFS and 100 at −6 dBFS; and nothing was said when the recording is under a tenth
// of a second, when none of it is above −55 dBFS, or when it is as even as an empty room: at least half a second
// long, with no tenth twice as strong as its weakest and none at −30 dBFS or above. No timer: the audio is the clock.
import { BYTES } from './pcm.ts';

const WINDOW = BYTES / 10, TELLING = 5, FLOOR = -55, SPAN = 49;
/** The sum of the squares of a window's samples at −30 dBFS. */
const STRONG = 1_717_986_918;

export const level = (peak: number) => (peak ? Math.round(Math.max(0, Math.min(1, (20 * Math.log10(peak / 32768) - FLOOR) / SPAN)) * 100) : 0);

export class Loud {
  /** The level of the last whole tenth of a second, 0 to 100. */
  level = 0;
  private bytes = 0;
  private heard = 0;
  private window = 0;
  private peak = 0;
  private energy = 0;
  private strongest = 0;
  private weakest = 0;
  private windows = 0;
  private odd = -1;

  /** Takes samples (16-bit little-endian, cut anywhere) and says whether the level changed. */
  push(pcm: Uint8Array): boolean {
    const before = this.level;
    for (const byte of pcm) {
      this.bytes++;
      if (this.odd < 0) {
        this.odd = byte;
        continue;
      }
      const sample = this.odd | (byte << 8), loud = Math.abs(sample >= 32768 ? sample - 65536 : sample);
      this.odd = -1;
      this.window = Math.max(this.window, loud);
      this.energy += loud * loud;
      if ((this.heard += 2) < WINDOW) continue;
      this.level = level(this.window);
      this.peak = Math.max(this.peak, this.window);
      this.strongest = Math.max(this.strongest, this.energy);
      this.weakest = this.windows ? Math.min(this.weakest, this.energy) : this.energy;
      this.windows++;
      this.window = this.heard = this.energy = 0;
    }
    return this.level !== before;
  }

  /** Whether there is anything to write down. */
  said(): boolean {
    if (this.bytes < WINDOW || level(Math.max(this.peak, this.window)) === 0) return false;
    return this.windows < TELLING || this.strongest >= 2 * this.weakest || this.strongest >= STRONG;
  }
}
