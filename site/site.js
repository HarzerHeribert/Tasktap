// The page's own part. It adds nothing the page needs in order to be read: without it every chapter's words and its
// two still pictures stand as they are. With it: Copy for the install lines and the keys as the visitor's system has
// them; the stills fetched only as they come near; and where the window is large enough and motion is not reduced,
// the story: the visitor's window is the screen, the app's own notch page (app/notch.html, the app's code) hangs
// from its top edge at its true size, and under it the app's chrome (app/chrome.js, the app's shader) becomes each
// chapter's form as the page is scrolled, forwards and back. Where the browser cannot draw the chrome (no graphics
// card to draw it with), each chapter's still of it stands in its place.
// The rule on movement is the app's: still at rest. The page never takes the wheel: one passive scroll listener asks
// for one frame, which reads how far the story is scrolled, draws the chrome for that place and tells the notch only
// when its state changes. Nothing runs while the page is not scrolled, except the light on a ring whose agent is
// working, as in the app; out of sight or with the tab hidden that stops too.
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const root = document.documentElement;
  const onWin = root.classList.contains('win');

  // On Windows its way to get the app comes first, for the eye and for a screen reader alike, and the keys are
  // Windows' own (the app's table, ui/src/keys.ts `answerUsual` and `keyName`).
  const win = $('.win #install .for-win');
  if (win) win.parentElement.prepend(win);
  // And the words beside a key: Windows has no notch, so nothing there speaks of one.
  if (onWin) for (const k of document.querySelectorAll('kbd[data-win], span[data-win]')) k.textContent = k.dataset.win;

  // A line to paste: Copy puts it on the clipboard and says so, on the key and to a screen reader; where it cannot,
  // the line is selected and the key says which keys copy it. The line is the one shown in Copy's box: at the top,
  // the visitor's system's.
  const said = $('#said');
  for (const button of document.querySelectorAll('.copy')) {
    const line = () => [...button.closest('.copies').querySelectorAll('pre')].find((pre) => pre.getClientRects().length);
    if (onWin && button.dataset.win) button.setAttribute('aria-label', button.dataset.win);
    let back = 0;
    const say = (words) => {
      button.textContent = words;
      if (said) said.textContent = words === 'Copied' ? `Copied the ${/Windows/.test(button.getAttribute('aria-label')) ? 'Windows' : 'Mac'} install line` : words;
      clearTimeout(back);
      back = setTimeout(() => ((button.textContent = 'Copy'), said && (said.textContent = '')), 2400);
    };
    const select = () => (getSelection().selectAllChildren(line()), say(`Selected: press ${onWin || !/Mac/.test(navigator.platform) ? 'Ctrl+C' : '⌘C'}`));
    button.addEventListener('click', () => {
      if (!navigator.clipboard) return select();
      navigator.clipboard.writeText(line().textContent).then(() => say('Copied'), select);
    });
  }

  // A chapter's stills, and the picture of Tasktap's window, are in the page as they are without scripts (noscript);
  // with scripts each is put in only as it comes near being seen, in the place already kept for it. Where the stage is
  // held the chapters' stills are not shown, and never fetched.
  const near = new IntersectionObserver((seen) => {
    for (const e of seen) {
      if (!e.isIntersecting) continue;
      near.unobserve(e.target);
      const hold = e.target.querySelector('noscript');
      if (hold) e.target.insertAdjacentHTML('beforeend', hold.textContent);
    }
  }, { rootMargin: '0px 0px 12% 0px' });
  for (const slot of document.querySelectorAll('.slot')) near.observe(slot);
  /** The mark's still on the first screen: where nothing is held at once; where the stage is held, only if the chrome
   *  cannot be drawn there, since the chrome draws the mark itself. */
  const marked = () => { const hold = $('.mark-big noscript'); if (hold) hold.parentElement.innerHTML = hold.textContent; };
  if (!root.classList.contains('held')) marked();

  const stage = $('#stage'), story = $('#story'), slot = $('.notch'), canvas = $('#chrome');
  if (!stage || !slot) return;
  const chapters = [...document.querySelectorAll('.chapter')], texts = chapters.map((ch) => $('.ch-text', ch));
  const seats = [...document.querySelectorAll('.seat')];
  const top = $('#top'), topText = $('.top-text'), markBig = $('.mark-big');
  const blocks = [top, ...chapters, $('#terminals'), $('#facts'), $('#install')].filter(Boolean);
  const links = new Map([...document.querySelectorAll('.chapters-nav a[data-step]')].map((a) => [a.dataset.step, a]));
  const still = $('.notch-still img'), stillFrom = $('.notch-still source');
  let form = null;
  // From here on this script keeps the stage (the page's own inline script did until now). What the checks read of
  // it: how many frames of the chrome were drawn.
  window.__story = { get frames() { return chrome ? chrome.frames : 0; } };
  // The page's head says when the stage is held and has set the class already, so the first paint is laid out as it
  // stays.
  const held = matchMedia(root.dataset.held);
  const STEPS = ['rest', 'say', 'place', 'work', 'ask', 'result'];
  /** How far the story goes, in chapters: its last one rests a little before the stage is let go. */
  const END = 5.35;
  /** The notch at its tallest (the result, with the light under it), which the chrome stays clear of. */
  const NOTCH = 441;
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const ss = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const jump = (y) => scrollTo({ top: y, behavior: 'instant' });
  let frame = null, live = false, ready = false, told = '', on = '', queued = false, seen = false, resting = null;
  let chrome = null, mod = null, flat = false, G = null, P = null, beat = 1, at = -1, here = -1, turning = 0;
  let spot = null, wide = innerWidth, tall = innerHeight;

  const post = (m) => frame && frame.contentWindow && frame.contentWindow.postMessage({ tasktap: 'page', ...m }, location.origin);
  const isHeld = () => held.matches;

  /** What the notch shows at `b` chapters into the story: the chapter, and how far its own changes have come. Each
   *  change is where the chrome makes the same one: the words as the slats hear them, the project as the bead lands,
   *  each agent as its ring opens, one result as its ring comes to rest. */
  function scene(b) {
    if (b < 0.5) return { step: 'rest', p: 0 };
    if (b < 1.5) return { step: 'say', p: 0.04 + 0.36 * clamp((b - 0.52) / 0.44) };
    if (b < 2.5) return { step: 'place', p: b < 1.88 ? 0 : 1 };
    if (b < 3.5) return { step: 'work', p: b < 2.6 ? 0 : b < 2.78 ? 0.2 : 1 };
    if (b < 4.5) return { step: 'ask', p: 1 };
    return { step: 'result', p: b < 4.7 ? 0 : 1 };
  }

  /** For a reader's ears, where the stage is held and no still is shown: under each chapter's words what its two
   *  pictures show, in the words the stills carry, and on the first screen the mark. Every chapter's words are there
   *  for a reader at all times, in their order; none of this is seen. */
  function describe(now) {
    for (const el of document.querySelectorAll('.told')) el.remove();
    if (!now) return;
    const said = (within) => [...within.querySelectorAll('noscript')].flatMap((n) => {
      const t = document.createElement('template');
      t.innerHTML = n.textContent;
      return [...t.content.querySelectorAll('img')].map((i) => i.alt);
    }).filter(Boolean).join(' ');
    for (const [el, from] of [[topText, markBig], ...chapters.map((ch, i) => [texts[i], ch])]) {
      const words = said(from) || (from === markBig && $('img', markBig)?.alt) || '';
      if (words) el.appendChild(Object.assign(document.createElement('p'), { className: 'sr told', textContent: words }));
    }
    markTold();
  }
  /** The mark's still, where it is shown in the held layout, is told once: by the words under the headline, which
   *  stay for a reader when the first screen is scrolled away, not by the picture too. */
  function markTold() {
    const img = $('.mark-big img');
    if (!img) return;
    if ($('.top-text .told')) img.setAttribute('aria-hidden', 'true');
    else img.removeAttribute('aria-hidden');
  }
  // The first screen's controls stay the keyboard's however far the story is scrolled: when one of them takes the
  // keyboard the page goes to the first screen, as a page goes to whatever takes the keyboard.
  top.addEventListener('focusin', () => root.classList.contains('held') && here > 0.05 && jump(0));

  /** The stage's measures: its size; where the mark stands on the first screen (on its still, which the chrome takes
   *  the place of); and where the story's forms stand. In a window tall enough they stand under the notch, clear of it
   *  at its tallest, with the words left of them; in a short, wide one they stand right of the notch, the words left
   *  of it. The forms are as large as that room allows, their seats' words under them; where the chrome's stills stand
   *  for the chrome, never larger than the stills were drawn (120 px a unit, at two device pixels to one). */
  function measure() {
    const W = stage.clientWidth, H = stage.clientHeight, s = stage.getBoundingClientRect(), m = markBig.getBoundingClientRect();
    const left = topText.getBoundingClientRect().left - s.left, under = H >= 700, most = flat ? 240 / Math.max(1, devicePixelRatio) : 260;
    root.classList.toggle('side', !under);
    let unit, x, y, words;
    if (under) {
      const full = Math.min(W * 0.17, 260, (H - NOTCH - 78) / 0.94);
      unit = Math.min(full, most);
      x = Math.min(W * 0.69, W - 24 - 1.74 * full);
      y = Math.max(H * 0.62, NOTCH + 0.5 * full);
      words = x - 1.66 * full - 32 - left;
    } else {
      const edge = W / 2 + 210 + 32, full = Math.min(150, (W - 24 - edge) / 3.4);
      unit = Math.min(full, most);
      x = edge + 1.66 * full;
      y = H * 0.56;
      words = W / 2 - 210 - 32 - left;
    }
    G = { W, H, unit, mark: { x: m.left - s.left + m.width / 2, y: m.top - s.top + m.height / 2, h: m.height * 0.86 }, mid: { x: Math.round(x), y: Math.round(y) } };
    beat = chapters[0].offsetHeight || 1;
    for (const [k, v] of [['band', G.mid.y], ['mx', G.mid.x], ['unit', unit], ['words', Math.round(words)]]) root.style.setProperty(`--${k}`, `${v}px`);
    if (chrome) chrome.size(W, H, devicePixelRatio);
    if (flat) seated(on || 'rest');
  }

  /** One frame of the story at `b`: the chrome and its seats, the first screen's words leaving, the chapter's words.
   *  Opacity and transform only: nothing is laid out again, and nothing is taken from a reader or the keyboard. */
  function paint(b, past) {
    if (mod && chrome) {
      P = mod.pose(b, G);
      chrome.draw(P, performance.now() / 1000);
      if (!stage.classList.contains('drawn')) stage.classList.add('drawn');
      mod.lay(seats, P);
      loop();
    }
    const gone = b > 0.36;
    topText.style.opacity = (1 - ss(0.06, 0.34, b)).toFixed(3);
    topText.style.transform = `translateY(${(-b * 110).toFixed(1)}px)`;
    if (stage.classList.contains('gone') !== gone) stage.classList.toggle('gone', gone);
    for (const [i, el] of texts.entries()) {
      const k = i + 1, come = ss(k - 0.42, k - 0.14, b), go = k === 5 ? 0 : ss(k + 0.3, k + 0.52, b);
      el.style.opacity = (come * (1 - go)).toFixed(3);
      el.style.transform = `translateY(${((1 - come) * 30 - go * 30 - past).toFixed(1)}px)`;
    }
  }
  /** While a ring's agent works, its light runs round it: a frame of the chrome as the display gives frames, at most
   *  60 a second as in the app (ui/src/motion/paced.ts), and none once no ring works, the stage is out of sight or the
   *  tab is hidden. */
  let lit = 0;
  function loop() {
    if (turning || !P || !P.turning || !seen || document.hidden) return;
    turning = requestAnimationFrame((now) => {
      turning = 0;
      if (!P || !chrome || !P.turning || !seen || document.hidden || !isHeld()) return;
      if (now - lit > 15) ((lit = now), chrome.draw(P, now / 1000));
      loop();
    });
  }

  function update() {
    queued = false;
    if (!root.classList.contains('held')) return void (spot = place());
    // The stage is driven only while it is in sight: a jump past the story asks the notch for nothing.
    const r = story.getBoundingClientRect(), inSight = r.bottom > 0 && r.top < innerHeight;
    if (inSight !== seen) ((seen = inSight), rest());
    // The bar is the screen's menu bar for as long as the stage fills the window.
    root.classList.toggle('in-story', r.bottom > innerHeight * 0.5);
    if (!seen) return void (spot = place());
    begin();
    const b = clamp(-r.top / beat, 0, END), past = Math.max(0, -r.top - END * beat);
    const s = scene(b);
    here = b;
    spot = { b };
    if (s.step !== on) {
      for (const [step, a] of links) step === s.step ? a.setAttribute('aria-current', 'step') : a.removeAttribute('aria-current');
      for (const ch of chapters) ch.classList.toggle('on', ch.dataset.step === s.step);
      on = s.step;
      // Until the live notch stands in this chapter's state, the stage shows the chapter's still.
      if (!live) picture(s.step);
      if (flat) formed(s.step);
    }
    if (b !== at || past) ((at = b), paint(b, past));
    // The notch is told only when what it should show changes.
    const key = `${s.step}:${Math.round(s.p * 40)}`;
    if (ready && key !== told) {
      told = key;
      post({ do: 'scene', step: s.step, p: s.p });
    }
  }
  /** The stage's still: the chapter's state, as the app draws it. Its place does not change, only its picture. */
  function picture(step) {
    const name = `app/shots/story-${step === 'rest' ? 'open' : step}`, set = `${name}.webp 1x, ${name}@2x.webp 2x`;
    if (stillFrom.getAttribute('srcset') === set) return;
    // A picture on its way is not shown: no chapter under another chapter's still. Only its own picture shows it
    // again: one that was still on its way when this one was asked for does not.
    still.parentElement.classList.add('loading');
    still.onload = still.onerror = () => still.currentSrc.includes(name) && still.parentElement.classList.remove('loading');
    stillFrom.srcset = set;
  }
  /** Where the chrome cannot be drawn: the chapter's still of it in the chrome's place, never larger than it was
   *  drawn, with the seats' words over it as over the live chrome; on the first screen the mark's still. */
  function formed(step) {
    stage.classList.add('flat');
    marked();
    markTold();
    if (!form) {
      form = Object.assign(new Image(560, 380), { className: 'form-still', alt: '' });
      canvas.after(form);
    }
    stage.classList.toggle('formed', step !== 'rest');
    seated(step);
    if (step === 'rest') return;
    const name = `app/shots/chrome-${step}@2x.webp`;
    if (form.getAttribute('src') === name) return;
    form.classList.add('loading');
    form.onload = form.onerror = () => form.currentSrc.includes(name) && form.classList.remove('loading');
    form.src = name;
  }
  /** The seats as they stand at a chapter's rest, where the chapter's still shows its rings. */
  const seated = (step) => mod && G && mod.lay(seats, mod.pose(STEPS.indexOf(step), G));
  const soon = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };
  addEventListener('scroll', soon, { passive: true });

  /** Out of sight or with the tab hidden, the notch's loops stand still, and so does a ring's light. */
  function rest() {
    const hold = !seen || document.hidden;
    if (hold !== resting) (resting = hold), post({ do: 'hold', held: hold });
    if (!hold) loop();
  }
  document.addEventListener('visibilitychange', rest);

  addEventListener('message', (e) => {
    const m = e.data;
    if (e.origin !== location.origin || !frame || e.source !== frame.contentWindow || !m || m.tasktap !== 'stage') return;
    if (m.ready) {
      ready = true;
      told = '';
      resting = null;
      rest();
      return update();
    }
    // The live notch takes the still's place once it stands in the state of the chapter in view: the same picture.
    if (m.step && m.step === on && !live) (live = true), stage.classList.add('live');
  });

  /** The reader's place where no stage is in sight: the part of the page at the reading line, and how far through it. */
  function place() {
    if (scrollY < 2) return { el: top, f: 0, start: true };
    const line = innerHeight / 2;
    for (const el of blocks) {
      const r = el.getBoundingClientRect();
      if (r.top <= line && r.bottom > line) return { el, f: (line - r.top) / r.height };
    }
    return null;
  }
  /** Back to a place noted before the page was laid out anew: the chapter the held story was at, or the part of the
   *  page that was at the reading line. */
  function back(was) {
    const now = root.classList.contains('held'), chapter = was.b === undefined ? chapters.indexOf(was.el) : was.b < 0.5 ? -1 : Math.min(4, Math.round(was.b) - 1);
    if (was.start || (was.b !== undefined && chapter < 0)) return jump(0);
    if (was.b !== undefined && now) return jump(scrollY + story.getBoundingClientRect().top + was.b * beat);
    if (chapter >= 0 && (now || was.b !== undefined)) return chapters[chapter].scrollIntoView({ block: 'start', behavior: 'instant' });
    const r = was.el.getBoundingClientRect();
    scrollBy({ top: r.top + was.f * r.height - innerHeight / 2, behavior: 'instant' });
  }
  /** The window or the motion setting changed. Held or not, as they now say: held, the chrome and the live notch come
   *  once the stage is in sight; not held, the stills stand. And the reader's place is kept on every change of the
   *  window's width (a phone turned on its side), of the held stage's height, and of the layout: the chapter that was
   *  in view is in view again, and any other part of the page is where it was at the reading line. */
  function settle() {
    // Where the story was held, its place is read from the page's scroll as it is now (the last frame's note may be
    // a scroll behind); anywhere else it is the place noted at the last scroll.
    const within = root.classList.contains('held') && scrollY < story.offsetTop + END * beat + 1;
    const was = within ? { b: clamp((scrollY - story.offsetTop) / beat, 0, END) } : spot, now = isHeld(), changed = root.classList.contains('held') !== now;
    if (changed) {
      root.classList.toggle('held', now);
      for (const ch of chapters) ch.classList.remove('on');
      for (const el of [topText, ...texts, ...seats, ...seats.flatMap((seat) => [...seat.children])]) el.removeAttribute('style');
      stage.classList.remove('gone');
      if (!now) marked();
      describe(now);
      markTold();
      if (!now && ready) (post({ do: 'scene', step: 'rest', p: 0 }), (told = ''));
      on = '';
      here = -1;
    }
    if (now) measure();
    if (was && (changed || innerWidth !== wide || (now && innerHeight !== tall))) back(was);
    wide = innerWidth;
    tall = innerHeight;
    at = -1;
    soon();
  }
  held.addEventListener('change', settle);
  addEventListener('resize', settle, { passive: true });

  /** The chrome and the live notch, once the stage is first in sight: the chrome at once, the notch after the first
   *  paint, and no notch at all where data is saved (its stills stand). */
  let begun = false;
  function begin() {
    if (begun) return;
    begun = true;
    // A browser that cannot draw the chrome, or loses the means to: the chapters' stills of it, from then on.
    const stills = () => ((flat = true), (chrome = P = null), stage.classList.remove('drawn'), measure(), formed(on || 'rest'));
    import('./app/chrome.js').then((m) => {
      mod = m;
      chrome = m.mount(canvas, stills);
      if (!chrome) return stills();
      measure();
      at = -1;
      update();
    }, stills);
    if (navigator.connection && navigator.connection.saveData) return;
    const go = () => {
      frame = document.createElement('iframe');
      frame.src = 'app/notch.html';
      frame.tabIndex = -1;
      frame.title = 'Tasktap’s notch';
      frame.setAttribute('aria-hidden', 'true');
      slot.append(frame);
    };
    if (document.readyState === 'complete') setTimeout(go, 0);
    else addEventListener('load', () => setTimeout(go, 0), { once: true });
  }
  if (isHeld()) (measure(), describe(true));
  soon();
})();
