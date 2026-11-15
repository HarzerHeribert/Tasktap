// Home has a wide, slow-authored loop; other surfaces keep their own framing.
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
  let homePaused = false;
  try {
    const stored = localStorage.getItem(key);
    if (known(stored)) selected = stored;
    homePaused = localStorage.getItem('tasktap-home-motion') === 'paused';
  } catch {}
  function pauseHome(paused) {
    homePaused = !!paused;
    try { localStorage.setItem('tasktap-home-motion',homePaused?'paused':'playing'); } catch {}
    document.dispatchEvent(new Event('tasktap-home-motion'));
  }

  function file(id,size,ext) {
    const art=known(id)?id:selected;
    const composition=size==='home'&&art==='resonator'?'stage':['home','miniature'].includes(size)?size:'stage';
    return root(art)+'/'+composition+'.'+ext;
  }
  function markup(size='stage',id) {
    size = ['home','miniature'].includes(size) ? size : 'stage';
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
  return Object.freeze({catalog, current:()=>selected, select, markup, homePaused:()=>homePaused, pauseHome,
    poster:(id,size='stage')=>file(id,size,'jpg'), movie:(id,size)=>file(id,size,'mp4')});
})();

function resonatorMarkup(size) { return TasktapArt.markup(size); }
function motionOverview(heading) {
  const paused=TasktapArt.homePaused(),label=paused?'Play artwork':'Pause artwork';
  return '<div class="resonator-stage">'+heading+TasktapArt.markup('home')+'<button type="button" class="home-art-toggle" data-paused="'+paused+'" aria-label="'+label+'" title="'+label+'"><span class="art-pause">'+icon('pause')+'</span><span class="art-play">'+icon('play')+'</span></button></div>';
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
    for(const toggle of document.querySelectorAll('.home-art-toggle')) {
      const paused=TasktapArt.homePaused(),label=paused?'Play artwork':'Pause artwork';
      toggle.dataset.paused=String(paused);toggle.setAttribute('aria-label',label);toggle.title=label;
      if(toggle.hidden!==reduceMotion.matches)toggle.hidden=reduceMotion.matches;
    }
    for (const film of tracked) {
      const notchMiniature = !!film.closest('#notch-home');
      const homeArtwork = !!film.closest('.resonator-stage');
      const signal = document.body.dataset.signal;
      const hasActivity = !notchMiniature || (!!signal && signal !== 'idle');
      const uncovered = !topDialog || topDialog.contains(film);
      const requested = visible.has(film) && hasActivity && !(homeArtwork&&TasktapArt.homePaused()) && uncovered && !document.hidden && !reduceMotion.matches;
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
      // Slow movement is authored into Home's frames, preserving smooth playback.
      const rate = homeArtwork ? 1 : artworkPlaybackRate(film.getBoundingClientRect().width);
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
  document.addEventListener('tasktap-home-motion', synchronize);
  document.addEventListener('click',event=>{if(event.target.closest('.home-art-toggle'))TasktapArt.pauseHome(!TasktapArt.homePaused())});
  reduceMotion.addEventListener('change', synchronize);
  watch();
})();
