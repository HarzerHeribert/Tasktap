/* Keep long guides navigable without hiding content when JavaScript is absent. */
const contents=document.querySelector('.contents');
if(contents && matchMedia('(max-width:850px)').matches)contents.open=false;
const links=[...document.querySelectorAll('.contents a')],sections=[...document.querySelectorAll('.guide-section')];
let scheduled=false;
function updateContents(){
 scheduled=false;
 const current=sections.filter(section=>section.getBoundingClientRect().top<=150).at(-1);
 for(const link of links){if(link.hash==='#'+current?.id)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current')}
}
addEventListener('scroll',()=>{if(!scheduled){scheduled=true;requestAnimationFrame(updateContents)}},{passive:true});
addEventListener('resize',updateContents);updateContents();
