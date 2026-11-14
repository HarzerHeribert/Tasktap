// Each study ships with a loop and a finished first frame in two compositions.
const TasktapArt = (() => {
  const definitions = [
    ['glyph','Glyph wave','ASCII'],
    ['phase','Phase field','Shader'],
    ['relay','Relay','Abstract'],
    ['orbit','Signal globe','Technical orb'],
    ['resonator','Resonator','Blender']
  ];
  const key = 'tasktap-art';
  const root = id => id === 'resonator' ? 'assets/resonator' : 'assets/motion/'+id;
  const catalog = Object.freeze(definitions.map(([id,name,medium]) =>
    Object.freeze({id,name,medium,poster:root(id)+'/stage.jpg'})
  ));
  const known = id => catalog.some(study => study.id === id);
  let selected = catalog[0].id;
  try {
    const stored = localStorage.getItem(key);
    if (known(stored)) selected = stored;
  } catch {}

  function file(id,size,ext) {
    return root(known(id) ? id : selected)+'/'+(size === 'miniature' ? size : 'stage')+'.'+ext;
  }
  function markup(size='stage',id) {
    size = size === 'miniature' ? size : 'stage';
    const fixed = known(id);
    const art = fixed ? id : selected;
    return '<span class="resonator-film" aria-hidden="true"><video muted playsinline loop preload="none" tabindex="-1" disablepictureinpicture data-film="'+size+'" data-study="'+art+'"'+(fixed?' data-fixed-study':'')+' poster="'+file(art,size,'jpg')+'"></video></span>';
  }
  function brand() {
    const image = document.querySelector('.brand-mark img');
    if (image) image.src = file(selected,'miniature','jpg');
  }
  function select(id) {
    if (!known(id)) return false;
    if (selected !== id) {
      selected = id;
      try { localStorage.setItem(key,id); } catch {}
      for (const film of document.querySelectorAll('video[data-film]:not([data-fixed-study])')) {
        film.pause();
        film.removeAttribute('src');
        film.dataset.study = selected;
        film.poster = file(selected,film.dataset.film,'jpg');
        film.load();
      }
      brand();
      document.dispatchEvent(new CustomEvent('tasktap-art-change',{detail:{id}}));
    }
    return true;
  }
  brand();
  return Object.freeze({catalog, current:()=>selected, select, markup,
    poster:(id,size='stage')=>file(id,size,'jpg'), movie:(id,size)=>file(id,size,'mp4')});
})();

function resonatorMarkup(size) { return TasktapArt.markup(size); }
function motionOverview(heading) {
  return '<div class="resonator-stage">'+heading+TasktapArt.markup('stage')+'</div>';
}
(() => {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const visible = new Set();
  const tracked = new Set();
  let observer;
  const resize = new ResizeObserver(synchronize);
  function synchronize() {
    const dialogs = [...document.querySelectorAll('dialog[open]')];
    const topDialog = dialogs.at(-1);
    for (const film of tracked) {
      const notchMiniature = !!film.closest('#notch-home');
      const signal = document.body.dataset.signal;
      const statusArt = notchMiniature || !!film.closest('.resonator-stage');
      const hasActivity = !statusArt || (!!signal && signal !== 'idle');
      const uncovered = !topDialog || topDialog.contains(film);
      const requested = visible.has(film) && hasActivity && uncovered && !document.hidden && !reduceMotion.matches;
      if (!requested) {
        if (!film.paused) film.pause();
        if (reduceMotion.matches && film.hasAttribute('src')) {
          film.removeAttribute('src');
          film.load();
        }
        continue;
      }
      if (!film.hasAttribute('src')) {
        film.preload = 'auto';
        film.src = TasktapArt.movie(film.dataset.study,film.dataset.film);
      }
      const rate = artworkPlaybackRate(film.getBoundingClientRect().width);
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
        resize.unobserve(film);
        visible.delete(film);
        tracked.delete(film);
      }
    }
    for (const film of document.querySelectorAll('video[data-film]')) {
      if (tracked.has(film)) continue;
      film.addEventListener('canplay', synchronize);
      observer.observe(film);
      resize.observe(film);
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
  document.addEventListener('tasktap-art-change', synchronize);
  reduceMotion.addEventListener('change', synchronize);
  watch();
})();
