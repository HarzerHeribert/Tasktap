// Progressive enhancement: every chapter and the installer work without JS.
(() => {
  const motion=matchMedia('(prefers-reduced-motion: reduce)'),narrow=matchMedia('(max-width: 680px)');
  const film=document.querySelector('.wave-field video'),toggle=document.querySelector('.wave-toggle');
  const stage=document.querySelector('.story-stage');
  let visible=false,paused=!!navigator.connection?.saveData;
  function syncFilm(){
    toggle.hidden=motion.matches;
    toggle.setAttribute('aria-label',paused?'Play artwork':'Pause artwork');
    toggle.classList.toggle('is-paused',paused);
    if(motion.matches||!visible||document.hidden||paused){
      film.pause();
      if(motion.matches&&film.hasAttribute('src')){film.removeAttribute('src');film.load()}
      return;
    }
    const source=narrow.matches?film.dataset.source.replace('.mp4','-mobile.mp4'):film.dataset.source;
    if(film.getAttribute('src')!==source)film.src=source;
    film.playbackRate=1;film.play().catch(()=>{});
  }
  toggle.addEventListener('click',()=>{paused=!paused;syncFilm()});
  new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;syncFilm()}).observe(film);
  narrow.addEventListener('change',syncFilm);

  const panels=[...document.querySelectorAll('.story-panel')],tabs=[...document.querySelectorAll('[data-step]')],count=panels.length,last=count-1;
  const play=document.querySelector('#story-play'),next=document.querySelector('#story-next'),position=document.querySelector('#story-position');
  let current=0,playing=false,timer,finishMorph=()=>{};
  function stop(){clearTimeout(timer);playing=false;play.textContent=current===last?'Replay walkthrough ↻':'Play walkthrough ▷';play.setAttribute('aria-label',current===last?'Replay the walkthrough':'Play the walkthrough')}
  // Capture coordinates come from the same DOM that produced the Retina images.
  // Pair semantic regions (request, reference, actions) across layouts. The shell
  // and each region move independently; no unrelated artwork covers the change.
  function snapshot(panel){
    const frame=panel.querySelector('.notch-frame,.workspace-image,.preparation-map'),img=frame.querySelector('img');
    const box=frame.getBoundingClientRect(),imageBox=img?img.getBoundingClientRect():box,stageBox=stage.getBoundingClientRect();
    const name=img?.currentSrc.split('/').pop()?.replace('.png','');
    let regions=window.tasktapCaptureRegions?.[name];const nodes={};
    // The preparation explanation stays live HTML for sharp, accessible text.
    // Measure its real layout just like the captured interface regions.
    if(!img){
      regions={parts:{}};
      frame.querySelectorAll('[data-morph-part]').forEach(node=>{
        const r=node.getBoundingClientRect(),key=node.dataset.morphPart;
        regions.parts[key]={x:(r.left-box.left)/box.width,y:(r.top-box.top)/box.height,w:r.width/box.width,h:r.height/box.height};nodes[key]=node;
      });
    }
    return {frame,img,src:img?.currentSrc,regions,nodes,box:{left:box.left-stageBox.left,top:box.top-stageBox.top,width:box.width,height:box.height},image:{left:imageBox.left-box.left,top:imageBox.top-box.top,width:imageBox.width,height:imageBox.height},radius:getComputedStyle(frame).borderRadius};
  }
  function morph(from,to,panel,direction,oldHeight){
    if(!from.regions||!to.regions||(from.img&&!from.img.complete)||(to.img&&!to.img.complete))return;
    const shell=document.createElement('div');shell.className='morph-shell';shell.setAttribute('aria-hidden','true');
    stage.append(shell);stage.classList.add('is-transitioning');
    const animations=[],duration=820,easing='cubic-bezier(.22,.72,.18,1)';
    const animate=(node,frames,options={})=>{const a=node.animate(frames,{duration,easing,fill:'both',...options});animations.push(a);return a};
    const px=box=>Object.fromEntries(Object.entries(box).map(([key,value])=>[key,value+'px']));
    Object.assign(shell.style,px(to.box),{borderRadius:to.radius});
    const shellMotion=animate(shell,[{...px(from.box),borderRadius:from.radius},{...px(to.box),borderRadius:to.radius}]);
    animate(stage,[{height:oldHeight+'px'},{height:stage.getBoundingClientRect().height+'px'}]);
    const base=(snapshot,incoming)=>{
      const clone=snapshot.frame.cloneNode(true);clone.classList.add('morph-base');clone.removeAttribute('href');clone.removeAttribute('aria-label');
      clone.querySelectorAll('[id]').forEach(el=>el.removeAttribute('id'));shell.append(clone);
      animate(clone,incoming?[{opacity:0,offset:0},{opacity:0,offset:.9},{opacity:1,offset:1}]:[{opacity:1,offset:0},{opacity:0,offset:.12},{opacity:0,offset:1}],{easing:'linear'});
    };
    base(from,false);base(to,true);
    const local=(snapshot,region)=>({left:snapshot.image.left+region.x*snapshot.image.width,top:snapshot.image.top+region.y*snapshot.image.height,width:region.w*snapshot.image.width,height:region.h*snapshot.image.height});
    const keys=new Set([...Object.keys(from.regions.parts),...Object.keys(to.regions.parts)]);
    let order=0;
    for(const key of keys){
      const before=from.regions.parts[key],after=to.regions.parts[key];
      const old=local(from,before||from.regions.parts.request),end=after?local(to,after):{...old,left:old.left+direction*40};
      const piece=document.createElement('div');piece.className='morph-piece';piece.dataset.part=key;shell.append(piece);
      Object.assign(piece.style,px(end));
      // A small horizontal lead makes the change read left-to-right while
      // the request and controls move into their next positions.
      const middle=Object.fromEntries(Object.keys(old).map(k=>[k,(old[k]+end[k])/2]));middle.left+=direction*18;
      animate(piece,[{...px(old),opacity:before?1:0},{...px(middle),opacity:1,offset:.48},{...px(end),opacity:after?1:0}],{delay:order++*14,duration:duration-90});
      const ink=(snapshot,region,incoming)=>{
        if(!region)return;
        const image=document.createElement('div');image.className='morph-ink';
        Object.assign(image.style,{width:region.w*snapshot.image.width+'px',height:region.h*snapshot.image.height+'px'});
        if(snapshot.img)Object.assign(image.style,{backgroundImage:'url("'+snapshot.src+'")',backgroundSize:snapshot.image.width+'px '+snapshot.image.height+'px',backgroundPosition:(-region.x*snapshot.image.width)+'px '+(-region.y*snapshot.image.height)+'px'});
        else{image.classList.add('preparation-map','morph-dom');image.append(snapshot.nodes[key].cloneNode(true))}
        piece.append(image);
        animate(image,incoming?[{opacity:0,offset:0},{opacity:0,offset:.42},{opacity:1,offset:.56},{opacity:1,offset:.9},{opacity:0,offset:1}]:[{opacity:1,offset:0},{opacity:1,offset:after ? .34 : .12},{opacity:0,offset:after ? .46 : .28},{opacity:0,offset:1}],{easing:'linear'});
      };
      ink(from,before,false);ink(to,after,true);
    }
    const figure=panel.querySelector('.scene-figure');figure.style.visibility='hidden';
    animate(panel.querySelector('.scene-copy'),[{opacity:0,transform:'translateX('+(-24*direction)+'px)'},{opacity:1,transform:'translateX(0)'}],{duration:560,delay:100});
    let done=false;
    const cleanup=()=>{if(done)return;done=true;animations.forEach(a=>a.cancel());shell.remove();figure.style.visibility='';stage.classList.remove('is-transitioning');finishMorph=()=>{}};
    finishMorph=cleanup;shellMotion.finished.then(cleanup,()=>{});
  }
  function show(index,{animate=true,hash=false}={}){
    finishMorph();
    const previous=current,changed=previous!==index;
    const from=changed?snapshot(panels[previous]):null,oldHeight=stage.getBoundingClientRect().height;
    current=index;
    panels.forEach((panel,i)=>{panel.hidden=i!==index;tabs[i].setAttribute('aria-selected',String(i===index));tabs[i].tabIndex=i===index?0:-1});
    stage.dataset.scene=String(index);
    if(animate&&changed&&!motion.matches&&!document.hidden)morph(from,snapshot(panels[index]),panels[index],index>previous?1:-1,oldHeight);
    position.textContent=String(index+1).padStart(2,'0')+' / '+String(count).padStart(2,'0');
    next.innerHTML=index===last?'Start again <span aria-hidden="true">↻</span>':'Next <span aria-hidden="true">→</span>';
    next.setAttribute('aria-label',index===last?'Return to first step':'Next step');
    if(!playing)stop();
    if(hash)history.replaceState(null,'','#'+panels[index].id);
  }
  document.querySelector('.workflow').classList.add('has-story');
  document.querySelector('.story-nav').setAttribute('role','tablist');
  panels.forEach((panel,i)=>{
    panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tabs[i].id);panel.tabIndex=0;
    tabs[i].setAttribute('role','tab');tabs[i].setAttribute('aria-controls',panel.id);
    panel.querySelectorAll('img').forEach(img=>{img.loading='eager'});
  });
  function fromHash(){const index=panels.findIndex(p=>'#'+p.id===location.hash);if(index>=0){stop();show(index,{animate:false})}}
  tabs.forEach((tab,i)=>{
    tab.addEventListener('click',event=>{event.preventDefault();stop();show(i,{hash:true})});
    tab.addEventListener('keydown',event=>{
      let index;if(event.key==='ArrowRight')index=(i+1)%count;else if(event.key==='ArrowLeft')index=(i+last)%count;else if(event.key==='Home')index=0;else if(event.key==='End')index=last;else return;
      event.preventDefault();stop();show(index,{hash:true});tabs[index].focus();
    });
  });
  next.addEventListener('click',()=>{stop();show((current+1)%count,{hash:true})});
  function schedule(){timer=setTimeout(()=>{if(!playing)return;if(current===last){stop();return}show(current+1);schedule()},6500)}
  play.addEventListener('click',()=>{
    if(playing){stop();return}if(motion.matches)return;if(current===last)show(0);
    playing=true;play.textContent='Pause walkthrough Ⅱ';play.setAttribute('aria-label','Pause the walkthrough');schedule();
  });
  document.querySelector('.story-controls').hidden=false;
  stage.addEventListener('focusin',stop);
  new IntersectionObserver(([entry])=>{if(!entry.isIntersecting){stop();finishMorph()}}).observe(stage);
  window.addEventListener('hashchange',fromHash);window.addEventListener('resize',()=>finishMorph());
  show(0,{animate:false});fromHash();
  function syncMotion(){syncFilm();play.hidden=motion.matches;if(motion.matches){stop();finishMorph()}}
  motion.addEventListener('change',syncMotion);syncMotion();
  document.addEventListener('visibilitychange',()=>{syncFilm();if(document.hidden){stop();finishMorph()}});

  const copy=document.querySelector('#copy-install'),status=document.querySelector('#install-status');copy.hidden=false;
  copy.addEventListener('click',async()=>{
    const command=document.querySelector('#install-command');
    try{await navigator.clipboard.writeText(command.textContent);copy.textContent='Copied';status.textContent='Command copied. Paste it into Terminal and press Return.'}
    catch{const selection=getSelection(),range=document.createRange();range.selectNodeContents(command);selection.removeAllRanges();selection.addRange(range);status.textContent='Command selected. Press Command-C to copy it, then paste it into Terminal.'}
  });
})();
