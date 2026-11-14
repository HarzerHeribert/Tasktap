// The same optical assembly appears as a large overview study and a notch miniature.
// Its poster always works, including in WebKit hosts that decline inline media playback.
function resonatorMarkup(size) {
  return '<span class="resonator-film" aria-hidden="true"><video muted playsinline loop preload="none" tabindex="-1" disablepictureinpicture poster="assets/resonator/'+size+'.jpg" data-film="'+size+'"></video></span>';
}
function motionOverview(heading) {
  return '<div class="resonator-stage">'+heading+resonatorMarkup('stage')+'</div>';
}

(() => {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const visible = new Set();
  const tracked = new Set();
  let observer;
  function synchronize() {
    const obscured = document.querySelector('dialog[open]');
    for (const film of tracked) {
      const miniature = film.dataset.film === 'miniature';
      const signal = document.body.dataset.signal;
      const hasActivity = !miniature || signal !== 'idle' || document.body.classList.contains('needs-decision');
      const requested = visible.has(film) && hasActivity && !document.hidden && !reduceMotion.matches && !obscured;
      if (!requested) {
        if (!film.paused) film.pause();
        if (reduceMotion.matches && film.hasAttribute('src')) {
          film.removeAttribute('src');
          film.load();
        }
        continue;
      }
      if (!film.hasAttribute('src')) {
        // Load only visible art. Readiness can retry playback after a native view transfer.
        film.preload = 'auto';
        film.src = 'assets/resonator/'+film.dataset.film+'.mp4';
      }
      const rate = miniature && !['listening','sending'].includes(signal) ? 0.75 : 1;
      if (film.playbackRate !== rate) film.playbackRate = rate;
      film.muted = true;
      if (film.paused) film.play().catch(() => {});
    }
  }
  function watch() {
    for (const film of tracked) {
      if (!film.isConnected) {
        film.pause();
        film.removeEventListener('canplay', synchronize);
        observer.unobserve(film);
        visible.delete(film);
        tracked.delete(film);
      }
    }
    for (const film of document.querySelectorAll('video[data-film]')) {
      if (tracked.has(film)) continue;
      film.addEventListener('canplay', synchronize);
      observer.observe(film);
      tracked.add(film);
    }
    synchronize();
  }
  observer = new IntersectionObserver(entries => {
    for (const {target, isIntersecting} of entries) {
      if (isIntersecting && tracked.has(target)) visible.add(target);
      else visible.delete(target);
    }
    synchronize();
  });
  new MutationObserver(watch).observe(document.body,{
    childList:true, subtree:true, attributes:true, attributeFilter:['open','hidden']
  });
  new MutationObserver(synchronize).observe(document.body,{attributes:true,attributeFilter:['data-signal','class']});
  document.addEventListener('visibilitychange', synchronize);
  reduceMotion.addEventListener('change', synchronize);
  watch();
})();
