// The page remains complete without JavaScript. Only artwork and copy are enhanced.
(() => {
  const film=document.querySelector('.wave-field video');
  const toggle=document.querySelector('.wave-toggle');
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  let visible=false,paused=false;
  function syncFilm(){
    toggle.hidden=motion.matches;
    if(motion.matches||!visible||document.hidden||paused){
      film.pause();
      if(motion.matches&&film.hasAttribute('src')){film.removeAttribute('src');film.load()}
      return;
    }
    if(!film.hasAttribute('src'))film.src=film.dataset.source;
    film.playbackRate=artworkPlaybackRate(film.getBoundingClientRect().width);
    if(film.paused)film.play().catch(()=>{});
  }
  toggle.addEventListener('click',()=>{
    paused=!paused;toggle.setAttribute('aria-label',paused?'Play artwork':'Pause artwork');
    toggle.classList.toggle('is-paused',paused);syncFilm();
  });
  new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;syncFilm()}).observe(film);
  new ResizeObserver(syncFilm).observe(film);
  motion.addEventListener('change',syncFilm);document.addEventListener('visibilitychange',syncFilm);
  const copy=document.querySelector('#copy-install'),status=document.querySelector('#install-status');
  copy.hidden=false;
  copy.addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText(document.querySelector('#install-command').textContent);copy.textContent='Copied';status.textContent='Command copied. Paste it into Terminal to install Tasktap.'}
    catch{status.textContent='Select and copy the command above.'}
  });
})();
