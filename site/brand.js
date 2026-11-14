// Load the offline loop only while visible. The still is also the no-JS default.
(() => {
  const mark = document.querySelector('[data-brand-motion]');
  const toggle = document.querySelector('.brand-motion-toggle');
  if (!mark || !toggle) return;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const still = mark.getAttribute('src');
  let visible = false, paused = false;
  function sync() {
    const animate = visible && !document.hidden && !motion.matches && !paused;
    const source = animate ? mark.dataset.brandMotion : still;
    if (mark.getAttribute('src') !== source) mark.src = source;
    toggle.hidden = motion.matches;
    toggle.setAttribute('aria-label', paused ? 'Play logo animation' : 'Pause logo animation');
    toggle.textContent = paused ? '▶' : 'Ⅱ';
  }
  toggle.addEventListener('click', () => { paused = !paused; sync(); });
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }).observe(mark);
  motion.addEventListener('change', sync);
  document.addEventListener('visibilitychange', sync);
})();
