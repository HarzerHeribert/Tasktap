// The pace of everything in a page that moves by itself: the motion's frames (engine.ts) and the CSS loops the page
// moves itself (paced.ts). The frames a page is given come at whatever pace the display and the web view choose, and
// not evenly: 60, 120, 144 or 240 a second, or a pace that varies from one frame to the next (the Mac's built-in panel
// hands a web view frames 13 to 19 ms apart). A loop is drawn in at most `rate` of them a second (60), and on a
// display that gives about that many, in every one: no faster cadence is seen, and each frame costs the graphics
// processor (a 240 Hz display drew the band 80 times a second before, every third frame).
//   - A frame is never drawn within three fifths of an interval (10 ms) of the last: an uneven stream of about 60 a
//     second loses none, and a stream of 120 is drawn in every second frame.
//   - Where the display gives more than about 66 a second (its frames, on average, closer than nine tenths of an
//     interval), a frame is drawn only with an interval in hand: time given adds to it, up to 1.4 intervals, and each
//     frame drawn spends one, so over any stretch no more than `rate` a second are drawn (every fourth at 240, two of
//     every five at 144 and 165, four of five at 75).
//   - A display of about 60 is drawn in every frame it gives, at its own rate: one that runs a little fast (60.05) is
//     never made to drop a frame to keep an exact 60.
// The first frame after a rest (none given for 50 ms) is drawn at once. One pace serves every loop of a page, so that
// they draw in the same frames: two loops in alternate frames would cost twice the frames.
export class Pace {
  /** Frames a second, at most. */
  rate = 60;
  private given = -1e9;
  private drew = -1e9;
  private hand = 0;
  /** The display's interval, as the frames given show it: a running mean. Taken as short until they show it is not,
   *  so that a fast display is never drawn faster than `rate` while it is learnt. */
  private display = 0;
  private at = NaN;
  private ok = false;

  /** Whether the frame given at `at` (ms, the frame's own time) is drawn. Asked again for the same frame, the same. */
  take(at: number): boolean {
    if (at === this.at) return this.ok;
    const I = 1000 / this.rate, gap = at - this.given, rested = gap > 50 || gap < 0;
    if (rested) this.hand = 1.4 * I;
    else {
      this.display += (gap - this.display) * 0.2;
      this.hand = Math.min(1.4 * I, this.hand + gap);
    }
    this.given = this.at = at;
    const fast = this.display < 0.9 * I;
    this.ok = rested || !(at - this.drew < 0.6 * I || (fast && this.hand < 0.6 * I));
    if (this.ok) {
      this.drew = at;
      this.hand = fast ? this.hand - I : 1.4 * I;
    }
    return this.ok;
  }
}

/** The page's one pace. */
export const pace = new Pace();
