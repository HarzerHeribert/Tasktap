// Trial notch page. The host calls trial.*; the page calls the host through Tauri's invoke.
const {invoke}=window.__TAURI__.core;
const $=s=>document.querySelector(s), body=document.body, sheet=$('#notch');
let geometry={};
window.trial={
  // Same CSS variables as prototype/surfaces.js updateNotchGeometry().
  geometry(m){
    geometry=m;
    body.classList.toggle('notch-compact',m.compact===1);
    for(const [k,v] of Object.entries({'--native-tab-width':m.width,'--camera-height':m.height,'--camera-offset':m.offset,
      '--native-surface-width':m.surfaceWidth,'--surface-offset':m.surfaceOffset,'--notch-shoulder':m.shoulder,'--notch-pixel':m.pixel,
      '--cutout-corner':m.corner,'--rim-outset':m.rimOffset,'--available-panel-height':m.available}))
      if(Number.isFinite(v))document.documentElement.style.setProperty(k,v+'px');
    if(m.collapsed)drawRim(m);
  },
  hover(open){open?show():hide()},
  capture(){show();$('#field').focus({preventScroll:true})},
  rim(on){body.classList.remove('trial-rim');if(on){void body.offsetWidth;body.classList.add('trial-rim')}},
  glow(on){body.classList.toggle('needs-decision',on)},
};
// The rim path of WorkspaceDecisionRim.update(screen:visible:), flipped to CSS coordinates.
function drawRim(m){
  const svg=$('#rim'), x0=m.tabLeft, x1=m.tabLeft+m.width, b=m.height, c=m.corner;
  svg.setAttribute('width',m.frameWidth);svg.setAttribute('height',m.frameHeight);
  $('#metal').setAttribute('x2',m.frameWidth);
  const d=`M${x0} 0L${x0} ${b-c}A${c} ${c} 0 0 0 ${x0+c} ${b}L${x1-c} ${b}A${c} ${c} 0 0 0 ${x1} ${b-c}L${x1} 0`;
  for(const p of svg.querySelectorAll('path'))p.setAttribute('d',d);
}
function show(){
  if(!sheet.open)sheet.showModal(); // as prototype/app.js opens #notch
  requestAnimationFrame(()=>{
    const bottom=Math.ceil(sheet.getBoundingClientRect().bottom), f=$('#field').getBoundingClientRect();
    $('#notch-shell').style.setProperty('--sheet-bottom',bottom+'px');
    body.classList.add('notch-open');
    invoke('bounds',{height:bottom});
    invoke('report',{kind:'open',data:{bottom,field:[f.x,f.y,f.width,f.height]}});
  });
}
function hide(){
  body.classList.remove('notch-open');
  setTimeout(()=>{if(!body.classList.contains('notch-open'))sheet.close()},320);
}
$('#capture').addEventListener('submit',e=>{e.preventDefault();invoke('typed',{text:$('#field').value});$('#field').value=''});
invoke('ready');
