const signature = document.querySelector('.signature');
const film = signature.querySelector('video');
const waveToggle = document.querySelector('.wave-toggle');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
let visible = false;
let paused = false;
let scrollFrame = 0;

function positionWave() {
  scrollFrame = 0;
  const progress = Math.min(1, Math.max(0, window.scrollY / signature.closest('.hero').offsetHeight));
  signature.style.setProperty('--wave-shift', (progress * 22).toFixed(2) + 'px');
}

function onScroll() {
  if (visible && !motion.matches && !paused && !scrollFrame) scrollFrame = requestAnimationFrame(positionWave);
}

function syncFilm() {
  waveToggle.hidden = motion.matches;
  if (motion.matches) {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    signature.style.removeProperty('--wave-shift');
  }
  if (motion.matches || !visible || document.hidden || paused) {
    film.pause();
    if (motion.matches && film.hasAttribute('src')) {
      film.removeAttribute('src');
      film.load();
    }
    return;
  }
  onScroll();
  if (!film.hasAttribute('src')) film.src = film.dataset.source;
  film.playbackRate = artworkPlaybackRate(film.getBoundingClientRect().width);
  if (film.paused) film.play().catch(() => {});
}

waveToggle.addEventListener('click', () => {
  paused = !paused;
  waveToggle.setAttribute('aria-label', paused ? 'Play wave' : 'Pause wave');
  waveToggle.classList.toggle('is-paused', paused);
  syncFilm();
});
new IntersectionObserver(([entry]) => {
  visible = entry.isIntersecting;
  syncFilm();
}).observe(film);
new ResizeObserver(syncFilm).observe(film);
window.addEventListener('scroll', onScroll, {passive: true});
motion.addEventListener('change', syncFilm);
document.addEventListener('visibilitychange', syncFilm);

const notch = document.querySelector('.notch');
const notchDetails = document.querySelector('#notch-details');
const notchToggle = document.querySelector('.notch-toggle');
const review = document.querySelector('#example-content');
const receipt = document.querySelector('#example-receipt');
const action = document.querySelector('.example-action');
const announcement = document.querySelector('#example-announcement');

function setNotchOpen(open) {
  notch.dataset.open = String(open);
  notchDetails.inert = !open;
  notchToggle.setAttribute('aria-expanded', String(open));
  notchToggle.firstElementChild.textContent = open ? 'Close notch' : 'Open notch';
}

// Leave the complete example visible with JavaScript off or reduced motion on.
setNotchOpen(motion.matches);
notchToggle.hidden = false;
action.hidden = false;
const entrance = new IntersectionObserver(([entry]) => {
  if (entry.isIntersecting) {
    setNotchOpen(true);
    entrance.disconnect();
  }
}, {threshold: .55});
entrance.observe(notch);
notchToggle.addEventListener('click', () => {
  entrance.disconnect();
  setNotchOpen(notchDetails.inert);
});
notch.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    notchToggle.focus({preventScroll: true});
    setNotchOpen(false);
  }
});

action.addEventListener('click', () => {
  const showReceipt = receipt.inert;
  review.inert = showReceipt;
  receipt.inert = !showReceipt;
  action.firstElementChild.textContent = showReceipt ? 'Replay example' : 'Start example session';
  announcement.textContent = showReceipt ? 'Example session started in Cuegrid with Claude Code.' : 'Example handoff ready to review.';
});

const installToggle = document.querySelector('.terminal-toggle');
const installPanel = document.querySelector('#terminal-install');
const copyInstall = document.querySelector('#copy-install');
if (installToggle && installPanel && copyInstall) {
  document.querySelector('.terminal-fallback').hidden = true;
  installToggle.hidden = false;
  installToggle.addEventListener('click', () => {
    installPanel.hidden = !installPanel.hidden;
    installToggle.setAttribute('aria-expanded', String(!installPanel.hidden));
  });
  copyInstall.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(document.querySelector('#install-command').textContent);
      document.querySelector('#install-status').textContent = 'Command copied. Paste it into Terminal to install Tasktap.';
      copyInstall.textContent = 'Copied';
    } catch {
      document.querySelector('#install-status').textContent = 'Select and copy the command above.';
    }
  });
}
