const film = document.querySelector('video[data-source]');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
let visible = false;
function syncFilm() {
  if (motion.matches || document.hidden || !visible) {
    film.pause();
    if (motion.matches && film.hasAttribute('src')) { film.removeAttribute('src'); film.load(); }
    return;
  }
  if (!film.hasAttribute('src')) film.src = film.dataset.source;
  film.playbackRate = artworkPlaybackRate(film.getBoundingClientRect().width);
  film.play().catch(() => {});
}
new IntersectionObserver(entries => { visible = entries.at(-1).isIntersecting; syncFilm(); }).observe(film);
new ResizeObserver(syncFilm).observe(film);
motion.addEventListener('change', syncFilm);
document.addEventListener('visibilitychange', syncFilm);
