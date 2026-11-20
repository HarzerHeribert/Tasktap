// The page's own part. It adds nothing the page needs in order to be read: without it the words and the pictures
// stand as they are. With it, after the first paint: the app's notch page plays one thought from start to result at
// the top (app/notch.html, the app's own code), the chrome is drawn live by the app's motion engine (app/chrome.js)
// and follows what the notch shows, and a picture wider than the screen says which way it goes on.
// The rule on movement is the app's: still at rest; a loop only while something is shown working; nothing while the
// top is out of sight or the tab is hidden; and under Reduce Motion nothing moves by itself.
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');

  // A picture wider than its place is panned; it dissolves at the edge beyond which there is more, and only there.
  for (const el of document.querySelectorAll('.pan')) {
    const mark = () => {
      const more = [el.scrollLeft > 1 && 'left', el.scrollLeft + el.clientWidth < el.scrollWidth - 1 && 'right'].filter(Boolean);
      more.length ? (el.dataset.more = more.join(' ')) : delete el.dataset.more;
      if (el.tagName !== 'PRE') el.tabIndex = el.scrollWidth > el.clientWidth + 1 ? 0 : -1;
    };
    el.addEventListener('scroll', mark, { passive: true });
    new ResizeObserver(mark).observe(el);
  }

  // A line to paste: Copy puts it on the clipboard and says so for a moment; where it cannot, the line is selected.
  for (const button of document.querySelectorAll('.copy')) {
    const line = button.previousElementSibling;
    button.addEventListener('click', () => navigator.clipboard.writeText(line.textContent).then(() => {
      button.textContent = 'Copied';
      setTimeout(() => (button.textContent = 'Copy'), 2000);
    }, () => getSelection().selectAllChildren(line)));
  }

  const top = $('.top'), stage = $('#stage');
  if (!top || !stage) return;
  const light = $('.light'), steps = $('.steps'), hold = $('.hold'), mark = $('.brand .mark'), bandEl = $('#band'), slot = $('.notch');
  const ONGOING = ['thinking', 'working', 'needs'];
  let frame = null, ready = false, wanted = true, seen = true, shown = false, motion = 'idle', band = null;

  const post = (m) => frame && frame.contentWindow && frame.contentWindow.postMessage({ tasktap: 'page', ...m }, location.origin);
  /** What the chrome is told: the app's default look, the state the notch shows, calm, and at rest while unseen. */
  const chrome = (on) => ({
    look: { style: 'slats', palette: 'chromatic', hue: 265, lumen: false }, state: motion, pace: reduce.matches ? 'still' : 'calm', rest: !on, primary: true, pose: 1,
    pulse: reduce.matches ? 0 : 1, every: on && (motion === 'thinking' || motion === 'working') ? 15 : 0, tempo: 0.3, min: [320, 160],
  });
  function sync() {
    const on = seen && !document.hidden && wanted;
    if (ready && reduce.matches) {
      // Nothing plays by itself: one telling picture, and the steps to choose another.
      if (!shown) post({ do: 'show', step: 'ask' });
      shown = true;
    } else if (ready) post({ do: on ? 'play' : 'hold' });
    const moves = on && !reduce.matches && ONGOING.includes(motion);
    light.dataset.state = motion;
    light.dataset.moves = String(moves);
    mark.classList.toggle('live', moves && motion !== 'needs');
    hold.hidden = reduce.matches;
    if (band) band.set(chrome(on));
  }

  addEventListener('message', (e) => {
    const m = e.data;
    if (e.origin !== location.origin || !frame || e.source !== frame.contentWindow || !m || m.tasktap !== 'stage') return;
    if (m.ready) {
      ready = true;
      stage.classList.add('live');
      steps.hidden = false;
    } else {
      if ('open' in m) return void (stage.dataset.open = String(m.open));
      motion = m.motion || 'idle';
      for (const b of steps.querySelectorAll('[data-step]')) b.dataset.step === m.step ? b.setAttribute('aria-current', 'step') : b.removeAttribute('aria-current');
    }
    sync();
  });
  steps.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b === hold) wanted = !wanted;
    else (wanted = true), post({ do: 'from', step: b.dataset.step });
    hold.setAttribute('aria-pressed', String(!wanted));
    hold.setAttribute('aria-label', wanted ? 'Pause' : 'Play');
    sync();
  });
  new IntersectionObserver(([e]) => ((seen = e.isIntersecting), sync()), { threshold: 0.15 }).observe(top);
  document.addEventListener('visibilitychange', sync);
  reduce.addEventListener('change', () => ((shown = false), sync()));

  /** After the first paint, and not at all where data is being saved: the live notch, then the live chrome. */
  function begin() {
    const saving = !!(navigator.connection && navigator.connection.saveData);
    if (saving) return;
    frame = document.createElement('iframe');
    frame.src = 'app/notch.html';
    frame.tabIndex = -1;
    frame.title = 'Tasktap’s notch, playing';
    frame.setAttribute('aria-hidden', 'true');
    slot.append(frame);
    // A tile of fine noise over the light, made once, as the app makes it: on near-black a gradient bands.
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 96;
      const g = c.getContext('2d'), img = g.createImageData(96, 96);
      for (let i = 0; i < 96 * 96; i++) {
        const v = Math.random() * 64;
        img.data.set([v, v, v, 22], i * 4);
      }
      g.putImageData(img, 0, 0);
      document.documentElement.style.setProperty('--noise', `url(${c.toDataURL()})`);
    } catch {}
    // The chrome only where it runs well; elsewhere its picture stays.
    if (!window.WebGL2RenderingContext || navigator.deviceMemory < 4 || navigator.hardwareConcurrency < 4) return;
    import('./app/chrome.js').then(({ View }) => {
      // Its picture gives way once the engine has put its own canvas there and drawn into it.
      new MutationObserver((_, o) => {
        if (!$('canvas', bandEl)) return;
        o.disconnect();
        requestAnimationFrame(() => requestAnimationFrame(() => bandEl.classList.add('drawn')));
      }).observe(bandEl, { childList: true, subtree: true });
      band = new View(bandEl);
      sync();
    }, () => {});
  }
  if (document.readyState === 'complete') setTimeout(begin, 0);
  else addEventListener('load', () => setTimeout(begin, 0), { once: true });
})();
