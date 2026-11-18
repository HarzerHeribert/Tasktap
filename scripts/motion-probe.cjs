// What the motion's checks run inside a page, in headless Chromium or in the real app through its debug channel
// (`eval`): each is a function of the page's own, with no comments in it, since the channel takes one line.
// CADENCE: every display frame of Home's band for a while: whether the band was drawn again in it, the time since it
// last was, and how far its picture changed (the mean difference of its canvas, read back, in 8-bit levels), with
// the first and last frames of each movement kept as pictures.
// FLOW: every display frame and every key typed into the Composer while the page's state changes: frame intervals,
// the delay from a key to the frame that shows it, and what the page's own script took in each frame.

/** `seconds` of the band. `keep`: how many display frames to keep as pictures from the start and from the end of
 *  each movement (a movement: redraws with no rest of half a second between them); `crop`: the part kept, as shares
 *  of the canvas [x, y, w, h]. */
const CADENCE = ({ seconds, keep = 0, crop = [0, 0, 1, 1] }) => new Promise((done) => {
  const cv = document.querySelector('.band .motion canvas');
  if (!cv) return done({ error: 'no band' });
  const W = Math.min(cv.width, 400), H = Math.max(1, Math.round((cv.height * W) / cv.width));
  const read = Object.assign(document.createElement('canvas'), { width: W, height: H }).getContext('2d', { willReadFrequently: true });
  const cut = [Math.round(crop[0] * cv.width), Math.round(crop[1] * cv.height), Math.round(crop[2] * cv.width), Math.round(crop[3] * cv.height)];
  const pic = Object.assign(document.createElement('canvas'), { width: cut[2], height: cut[3] }).getContext('2d');
  const picture = () => (pic.fillStyle = '#000', pic.fillRect(0, 0, cut[2], cut[3]), pic.drawImage(cv, cut[0], cut[1], cut[2], cut[3], 0, 0, cut[2], cut[3]), pic.canvas.toDataURL('image/png'));
  const frames = [], moves = [], port = new MessageChannel();
  let prev = null, drawn = window.__motion.stats.frames, lastDraw = -1e9, lastFrame = 0, move = null, from = 0, at = 0;
  const sample = () => {
    const now = window.__motion.stats.frames, redrawn = now !== drawn;
    drawn = now;
    let change = 0, most = 0, read_ms = 0;
    if (redrawn || !prev) {
      const t = performance.now();
      read.clearRect(0, 0, W, H);
      read.drawImage(cv, 0, 0, W, H);
      const d = read.getImageData(0, 0, W, H).data, lum = new Float32Array(W * H);
      for (let i = 0, j = 0; j < lum.length; i += 4, j++) lum[j] = ((d[i] + d[i + 1] + d[i + 2]) * d[i + 3]) / 765;
      if (prev) {
        for (let j = 0; j < lum.length; j++) { const x = Math.abs(lum[j] - prev[j]); change += x; if (x > most) most = x; }
        change /= lum.length;
      }
      prev = lum;
      read_ms = performance.now() - t;
    }
    const gap = redrawn ? at - lastDraw : 0;
    if (redrawn) {
      if (!move || at - lastDraw > 500) (move = { from: at, first: [], last: [] }), moves.push(move);
      lastDraw = at;
      move.to = at;
    }
    frames.push([Math.round((at - from) * 10) / 10, Math.round((at - lastFrame) * 10) / 10, redrawn ? 1 : 0, Math.round(gap * 10) / 10, Math.round(change * 10000) / 10000, Math.round(most * 10) / 10, move ? Math.round(at - move.from) : -1, Math.round(read_ms * 10) / 10]);
    lastFrame = at;
    if (keep && move && at - move.to < 500) {
      if (move.first.length < keep) move.first.push(picture());
      move.last.push([at, redrawn ? picture() : null]);
      if (move.last.length > keep) move.last.shift();
    }
  };
  port.port1.onmessage = sample;
  const tick = (t) => {
    if (!from) from = lastFrame = t;
    at = t;
    port.port2.postMessage(0);
    if (t - from < seconds * 1000) requestAnimationFrame(tick);
    else setTimeout(() => {
      for (const m of moves) { let held = m.first[0]; m.last = m.last.map(([, p]) => (held = p ?? held)); m.from -= from; m.to -= from; }
      done({ size: [cv.width, cv.height], shown: [cv.getBoundingClientRect().width, cv.getBoundingClientRect().height], dpr: devicePixelRatio, hidden: document.hidden, frames, moves });
    }, 50);
  };
  requestAnimationFrame(tick);
});

/** `seconds` of Home: every display frame, and, with `every`, a key typed into the Composer about that many
 *  milliseconds apart, at an uneven pace, as a person's keys fall anywhere in a frame.
 *  A frame: [when, the interval since the last, what the page's own work for it took after its callbacks began (style,
 *  layout, paint), what handling the core's changes took since the last frame (with the render that follows), frames
 *  the motion drew, changes handled]. A key: [when, the delay to the end of the frame that shows it, the wait for
 *  that frame to begin]. A mark: [when, what Home showed from then on: the light's state, the receipt, its rows]. */
const FLOW = ({ seconds, every = 0 }) => new Promise((done) => {
  const field = () => document.querySelector('.home #capture-input');
  const round = (x) => Math.round(x * 10) / 10, text = 'the quick brown fox jumps over the lazy dog ';
  const frames = [], keys = [], marks = [], port = new MessageChannel(), R = window.__ws.records, change = R.onchange;
  let waiting = [], from = 0, zero = 0, last = 0, began = 0, work = 0, calls = 0, drawn = window.__motion.stats.frames, said = '', n = 0, typed = 0, refused = 0, lost = 0, caret = 0, expect = null, over = false;
  R.onchange = () => { const t = performance.now(); change(); queueMicrotask(() => { work += performance.now() - t; calls++; }); };
  const see = () => [document.querySelector('.light')?.dataset.state ?? '-', (document.querySelector('.home .cap-said')?.textContent ?? '').slice(0, 28), document.querySelectorAll('.home .hr').length + ' rows'].join(' | ');
  const input = (e) => { if (e.target.id === 'capture-input') waiting.push({ at: performance.now(), frame: 0 }); };
  document.addEventListener('input', input, true);
  port.port1.onmessage = () => {
    const now = performance.now(), f = frames[frames.length - 1], s = see();
    f[2] = round(now - began);
    for (const k of waiting) if (k.frame) keys.push([round(k.at - zero), round(now - k.at), round(k.frame - k.at)]);
    waiting = waiting.filter((k) => !k.frame);
    if (s !== said) marks.push([f[0], (said = s)]);
    if (over) {
      R.onchange = change;
      document.removeEventListener('input', input, true);
      done({ frames, keys, marks, typed, refused, lost, caret, hidden: document.hidden, dpr: devicePixelRatio, level: document.querySelector('.light') ? document.querySelector('.light').dataset.breathe : 'off', contexts: window.__motion.stats.contexts });
    }
  };
  const tick = (t) => {
    began = performance.now();
    if (!from) (from = last = t), (zero = began);
    for (const k of waiting) k.frame = began;
    const d = window.__motion.stats.frames;
    frames.push([round(t - from), round(t - last), 0, round(work), d - drawn, calls]);
    (last = t), (work = 0), (calls = 0), (drawn = d);
    over = t - from >= seconds * 1000;
    port.port2.postMessage(0);
    if (!over) requestAnimationFrame(tick);
  };
  const type = () => {
    const el = field();
    if (over || !el) return;
    if (document.activeElement !== el) el.focus();
    const ch = text[n++ % text.length], before = el.value;
    if (expect !== null && before !== expect && before !== '') lost++;
    if (!document.execCommand('insertText', false, ch) || el.value === before) refused++;
    else { typed++; if (el.selectionStart !== el.value.length) caret++; }
    expect = el.value;
    setTimeout(type, every * (0.6 + 0.8 * Math.random()));
  };
  requestAnimationFrame(tick);
  if (every) setTimeout(type, every);
});

module.exports = { CADENCE, FLOW };
