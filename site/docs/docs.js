const contents = document.querySelector('.contents');
if (matchMedia('(max-width:850px)').matches) contents.open = false;
const links = [...document.querySelectorAll('.contents a')];
function markCurrent(id) {
  for (const link of links) {
    if (link.hash === '#' + id) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
const sections = [...document.querySelectorAll('.guide-section')];
let scheduled = false;
function update() {
  scheduled = false;
  const current = sections.filter(section => section.getBoundingClientRect().top <= 150).at(-1);
  markCurrent(current?.id || '');
}
addEventListener('scroll', () => {
  if (!scheduled) { scheduled = true; requestAnimationFrame(update); }
}, {passive:true});
update();
