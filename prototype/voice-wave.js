// A fixed strip beneath the dictation field plots recent microphone levels as chrome
// type. Narrow screens retain the full history; Reduce Motion holds the centerline.
const voiceWave=(()=>{
  let active=null;
  const reduce=matchMedia('(prefers-reduced-motion: reduce)');
  const samples=new Float32Array(64);
  let atlas=null;
  const marks=['/','=',':','+'];
  function loadAtlas(){
    if (atlas) return;
    atlas=new Image();
    atlas.onload=schedule;
    atlas.src='assets/motion/glyph/type.png';
  }
  function mark(g,index,x,y,size){
    if (atlas?.complete && atlas.naturalWidth===384 && atlas.naturalHeight===96) {
      g.drawImage(atlas,index*96,0,96,96,x-size/2,y-size/2,size,size);
      return;
    }
    // Preserve the measured envelope while the local image loads or if it is unavailable.
    g.font='bold '+Math.round(size*.76)+'px Menlo, monospace';
    g.textAlign='center';g.textBaseline='middle';
    g.fillStyle='#546470';g.fillText(marks[index],x+1.2,y+1.5);
    g.fillStyle='#dce1dc';g.fillText(marks[index],x,y);
  }
  function draw() {
    if (!active || document.hidden || !active.visible) return;
    const {canvas}=active, bounds=canvas.getBoundingClientRect();
    if (bounds.width<1 || bounds.height<1) return;
    const width=bounds.width, height=bounds.height, scale=Math.min(devicePixelRatio || 1,2);
    const realWidth=Math.round(width*scale), realHeight=Math.round(height*scale);
    if (canvas.width!==realWidth || canvas.height!==realHeight) {
      canvas.width=realWidth;canvas.height=realHeight;
    }
    const g=canvas.getContext('2d');
    if (!g) return;
    g.setTransform(scale,0,0,scale,0,0);
    g.clearRect(0,0,width,height);
    const pad=12, center=height*.50, span=width-pad*2;
    const cols=Math.max(4,Math.min(30,Math.floor(span/23)));
    const step=span/cols, size=Math.min(step*1.2,height*.39);
    for (let column=0;column<cols;column++) {
      const x=pad+(column+.5)*step;
      g.fillStyle='#394447';g.fillRect(x-1,center,2,1);
      if (reduce.matches) continue;
      const from=Math.floor(column*samples.length/cols);
      const to=Math.floor((column+1)*samples.length/cols);
      let peak=0;
      for(let i=from;i<to;i++)peak=Math.max(peak,samples[i]);
      if (peak<=0) continue;
      const heightAtPeak=peak*(height-size)/2;
      const index=column%marks.length;
      mark(g,index,x,center-heightAtPeak,size);
      // Two opposing silhouettes trace amplitude. Behind them the centered third glyph
      // fills only the louder columns, like the three-deep peaks in the motion study.
      if (heightAtPeak>size*.22) {
        mark(g,(index+2)%marks.length,x-peak*1.5,center+heightAtPeak,size*.88);
      }
      if (heightAtPeak>size*.75) mark(g,(index+1)%marks.length,x+.9,center,size*.81);
    }
  }
  function schedule() {
    if (!active || active.frame || document.hidden || !active.visible) return;
    active.frame=requestAnimationFrame(()=>{
      if (!active) return;
      active.frame=0;draw();
    });
  }
  function detach() {
    if (!active) return;
    cancelAnimationFrame(active.frame);
    active.resize.disconnect();active.intersection.disconnect();
    active.canvas.remove();active=null;samples.fill(0);
    reduce.removeEventListener('change',reset);
    document.removeEventListener('visibilitychange',reset);
  }
  function reset(){samples.fill(0);schedule()}
  function attach(id,input) {
    detach();
    const canvas=document.createElement('canvas');
    canvas.className='voice-wave';canvas.setAttribute('aria-hidden','true');
    input.after(canvas);
    loadAtlas();
    const resize=new ResizeObserver(schedule);
    const intersection=new IntersectionObserver(entries=>{
      if (active?.id!==id) return;
      active.visible=entries.at(-1).isIntersecting;
      if (!active.visible) samples.fill(0);
      schedule();
    });
    active={id,canvas,resize,intersection,visible:true,frame:0};
    resize.observe(canvas);intersection.observe(canvas);
    reduce.addEventListener('change',reset);
    document.addEventListener('visibilitychange',reset);
    schedule();
  }
  function sample(id,level) {
    if (active?.id!==id || document.hidden || !active.visible || reduce.matches) return;
    samples.copyWithin(0,1);samples[samples.length-1]=level;
    schedule();
  }
  return {attach,detach,sample};
})();
