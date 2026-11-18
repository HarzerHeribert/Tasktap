// What the motion's checks run inside a page, in headless Chromium or in the real app through its debug channel
// (`eval`): each is a function of the page's own, with no comments in it, since the channel takes one line.
// CADENCE: every display frame of Home's band for a while: whether the band was drawn again in it, the time since it
// last was, and how far its picture changed (the mean difference of its canvas, read back, in 8-bit levels), with
// the first and last frames of each movement kept as pictures.
// FLOW: every display frame and every key typed into the Composer while the page's state changes: frame intervals,
// the delay from a key to the frame that shows it, and what the page's own script took in each frame.

/** `seconds` of the band. A frame: [when, the interval since the last frame, whether the band was drawn in it, the
 *  wait since it was last drawn, how far its picture changed from the last drawing (mean, in 8-bit levels), the
 *  largest change of one pixel, the light's state, and, where the engine says them (stats.seen), the band's own
 *  clocks at that drawing: its pulse's, its form's own phase, the seconds in its state, and a sum of the places
 *  it keeps clear of words (when that changes, light comes or goes under words at once, which is no movement)].
 *  `keep`: how many display frames to keep as pictures from the start and from the end of each movement (a movement:
 *  drawings with no rest of half a second between them); `crop`: the part kept, as shares of the canvas [x, y, w, h]. */
const CADENCE = ({ seconds, keep = 0, crop = [0, 0, 1, 1] }) => new Promise((done) => {
  const band = document.querySelector('.band .motion'), S = window.__motion.stats, told = 'seen' in S;
  if (!band) return done({ error: 'no band' });
  const round = (x, k = 10) => Math.round(x * k) / k, port = new MessageChannel();
  const frames = [], moves = [];
  let read = null, pic = null, cut = null, prev = null, drawn = S.frames, lastDraw = -1e9, lastFrame = 0, move = null, from = 0, at = 0, fresh = null, canvas = null;
  const look = (cv) => {
    if (!read || canvas !== cv) {
      canvas = cv;
      const W = Math.min(cv.width, 400), H = Math.max(1, Math.round((cv.height * W) / cv.width));
      read = Object.assign(document.createElement('canvas'), { width: W, height: H }).getContext('2d', { willReadFrequently: true });
      cut = [Math.round(crop[0] * cv.width), Math.round(crop[1] * cv.height), Math.round(crop[2] * cv.width), Math.round(crop[3] * cv.height)];
      pic = Object.assign(document.createElement('canvas'), { width: cut[2], height: cut[3] }).getContext('2d');
      prev = null;
    }
    const W = read.canvas.width, H = read.canvas.height;
    read.clearRect(0, 0, W, H);
    read.drawImage(cv, 0, 0, W, H);
    const d = read.getImageData(0, 0, W, H).data, lum = new Float32Array(W * H);
    let change = 0, most = 0;
    for (let i = 0, j = 0; j < lum.length; i += 4, j++) lum[j] = ((d[i] + d[i + 1] + d[i + 2]) * d[i + 3]) / 765;
    if (prev) {
      for (let j = 0; j < lum.length; j++) { const x = Math.abs(lum[j] - prev[j]); change += x; if (x > most) most = x; }
      change /= lum.length;
    }
    prev = lum;
    let picture = null;
    if (keep) (pic.fillStyle = '#000', pic.fillRect(0, 0, cut[2], cut[3]), pic.drawImage(cv, cut[0], cut[1], cut[2], cut[3], 0, 0, cut[2], cut[3]), (picture = pic.canvas.toDataURL('image/png')));
    return { change, most, picture };
  };
  if (told) S.seen = (view, cv, now) => {
    if (view.el !== band) return;
    fresh = { ...look(cv), clocks: [round((now - view.pulse.began) / 2000, 10000), round(view.ph[0], 10000), round(view.stT, 1000), Math.round(view.holes.reduce((a, b) => a + b, 0))] };
  };
  const sample = () => {
    if (!told) {
      const cv = band.querySelector('canvas'), now = S.frames;
      if (cv && (now !== drawn || !prev)) fresh = look(cv);
      if (now === drawn && frames.length) fresh = null;
      drawn = now;
    }
    const d = fresh;
    fresh = null;
    if (d) {
      if (!move || at - lastDraw > 500) (move = { from: at, to: at, first: [], last: [] }), moves.push(move);
      move.to = at;
    }
    frames.push([round(at - from), round(at - lastFrame), d ? 1 : 0, d && lastDraw > -1e8 ? round(at - lastDraw) : 0, d ? round(d.change, 10000) : 0, d ? round(d.most) : 0, document.querySelector('.light')?.dataset.state ?? '', ...(d?.clocks ?? [])]);
    if (d) lastDraw = at;
    lastFrame = at;
    if (keep && move && at - move.to < 500) {
      if (move.first.length < keep) move.first.push(d?.picture ?? move.first[move.first.length - 1]);
      move.last.push(d?.picture ?? move.last[move.last.length - 1]);
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
      if (told) S.seen = null;
      for (const m of moves) (m.from -= from), (m.to -= from);
      const box = band.getBoundingClientRect();
      done({ size: canvas ? [canvas.width, canvas.height] : [0, 0], shown: [box.width, box.height], dpr: devicePixelRatio, hidden: document.hidden, frames, moves });
    }, 50);
  };
  requestAnimationFrame(tick);
});

/** `seconds` of Home: every display frame, and, with `every`, a key typed into the Composer about that many
 *  milliseconds apart, at an uneven pace, as a person's keys fall anywhere in a frame. With `send`, that text is
 *  typed first and sent with Return, and the typing goes on into the next thought.
 *  A frame: [when, the interval since the last, what the page's own work for it took after its callbacks began (style,
 *  layout, paint), what handling the core's changes took since the last frame (with the render that follows), frames
 *  the motion drew, changes handled]. A key: [when, the delay to the end of the frame that shows it, the wait for
 *  that frame to begin]. A mark: [when, what Home showed from then on: the light's state, the receipt, its rows]. */
const FLOW = ({ seconds, every = 0, send = '' }) => new Promise((done) => {
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
    if (send && n === send.length) {
      n++;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return void setTimeout(type, every);
    }
    const ch = n < send.length ? send[n++] : text[(n++ - send.length) % text.length], before = el.value;
    if (expect !== null && before !== expect && before !== '') lost++;
    if (!document.execCommand('insertText', false, ch) || el.value === before) refused++;
    else { typed++; if (el.selectionStart !== el.value.length) caret++; }
    expect = el.value;
    setTimeout(type, every * (0.6 + 0.8 * Math.random()));
  };
  requestAnimationFrame(tick);
  if (every) setTimeout(type, every);
});

/** The band on another stream of frames: the page's frames are handed out here, on a clock of its own, `gaps`
 *  milliseconds apart (one of them at a time, by a fixed sequence of chances; `late`: one frame in 25 comes that many
 *  ms late), for `seconds`, and what the band did with them is said: how many frames it was given and how many it
 *  drew in, a second; the longest wait between two drawings; how fast its form's own phase went; and the furthest
 *  that phase was, at any drawing, from where the time passed would have it (in ms of its motion). */
const STREAM = async ({ gaps, late = 0, seconds }) => {
  const S = window.__motion.stats, band = document.querySelector('.band .motion'), real = [window.requestAnimationFrame, window.cancelAnimationFrame];
  let queue = [], seed = 7, t = (window.__stream ?? performance.now()) + 1000, drawn = [], hit = false;
  const chance = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  window.requestAnimationFrame = (f) => queue.push(f);
  window.cancelAnimationFrame = () => {};
  S.seen = (view) => { if (view.el === band) hit = true; };
  await new Promise((ok) => real[0].call(window, () => real[0].call(window, ok)));
  const from = t;
  let frames = 0, own = null;
  S.seen = (v) => { if (v.el === band) (hit = true), (own = v.ph[0]); };
  while (t - from < seconds * 1000) {
    const run = queue;
    queue = [];
    hit = false;
    for (const f of run) f(t);
    frames++;
    if (hit) drawn.push([t - from, own]);
    t += chance() < 0.04 && late ? late : gaps[Math.floor(chance() * gaps.length)];
  }
  S.seen = null;
  [window.requestAnimationFrame, window.cancelAnimationFrame] = real;
  for (const f of queue) window.requestAnimationFrame(f);
  window.__stream = t;
  const first = drawn[0], last = drawn[drawn.length - 1], rate = (last[1] - first[1]) / (last[0] - first[0]);
  return {
    given: frames / seconds, drawn: drawn.length / seconds, longest: Math.max(...drawn.slice(1).map((d, i) => d[0] - drawn[i][0])), rate: rate * 1000,
    off: Math.max(...drawn.map((d) => Math.abs((d[1] - first[1]) / rate - (d[0] - first[0])))),
  };
};

module.exports = { CADENCE, FLOW, STREAM };
