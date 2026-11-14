// The resident panel, status menu, and Micro mapping share the existing session store.
const host = window.webkit?.messageHandlers?.workspace;
const postHost = (type, extra = {}) => host?.postMessage({type, ...extra});
const chords = {
  capture: ['Space','⌃⌥Space'], requests: ['KeyJ','⌃⌥J'], previous: ['KeyK','⌃⌥K'],
  next: ['KeyL','⌃⌥L'], confirm: ['Enter','⌃⌥Return'], back: ['Escape','⌃⌥Esc'],
  yes:['KeyY','⌃⌥Y'], no:['KeyN','⌃⌥N'], discuss:['KeyT','⌃⌥T']
};
const surfaceButton = (text, action, glyph='', cls='surface-button', id='') =>
  '<button class="'+cls+'" data-surface="'+action+'" data-target="'+attr(id)+'">'+(glyph?icon(glyph):'')+esc(text)+'</button>';
const firstMode = () => document.body.classList.contains('notch-first');
// A pointer peek never takes focus. An explicit open stays until dismissed.
let homeMode = 'closed';
let hoverTimer = 0;
let homeContent = '';
let choice = null;
let hardwareNavigation=false;
let lastBinary=null;
let microStatus='Off';
let boundsFrame = 0;
const pending = () => state.decisions[0];
function closePanels(){
  while($('#notch').open || $('#modal').open) close();
  $('#status-menu').hidden=true;
  $('#status-button').setAttribute('aria-expanded','false');
}
function showWorkspace(){
  clearTimeout(hoverTimer);
  homeMode='closed';
  closePanels();
  document.body.classList.remove('notch-first');
  $('#notification-preview').hidden=true;
  $('#notch-home').hidden=true;
  go(view);
  updateBounds();
}
function showHome(open=true){
  clearTimeout(hoverTimer);
  closePanels();
  document.body.classList.add('notch-first');
  homeMode=open?'pinned':'closed';
  drawHome();
  $('#islandToggle').focus({preventScroll:true});
  updateBounds();
}
function hoverNotch(inside){
  clearTimeout(hoverTimer);
  if(!firstMode() || document.querySelector('dialog[open]') || homeMode==='pinned')return;
  if(inside && homeMode==='retracting'){
    homeMode='peek';
    drawHome();
    return;
  }
  hoverTimer=setTimeout(()=>{
    if(!firstMode() || document.querySelector('dialog[open]') || homeMode==='pinned')return;
    if(!inside && $('#notch-home').contains(document.activeElement))return;
    if(inside)homeMode='peek';
    else if(homeMode==='peek' && !matchMedia('(prefers-reduced-motion: reduce)').matches)homeMode='retracting';
    else homeMode='closed';
    drawHome();updateBounds();
  },inside?170:320);
}
$('#notch-home').addEventListener('transitionend',event=>{
  if(event.target===$('#notch-home') && event.propertyName==='clip-path' && homeMode==='retracting'){
    homeMode='closed';
    drawHome();updateBounds();
  }
});
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>{
  if(homeMode==='retracting'){homeMode='closed';drawHome();updateBounds()}
});
function updateSignal(){
  const running=state.sessions.filter(session=>session.state==='Running').length;
  let mode='idle', label='Idle';
  if(simVoice!==null){mode='listening';label='Listening to sample'}
  else if(spoken){mode='speaking';label='Reading aloud'}
  else if(state.captures.some(c=>c.receipt==='Queued')){mode='sending';label='Sending nudge'}
  else if(running){mode='working';label=running+' '+(running===1?'session':'sessions')+' working'}
  document.body.dataset.signal=mode;
  const text=$('.signal-caption');
  if(text)text.textContent=label;
}
function drawHome(){
  const root=$('#notch-home'),q=pending(),s=q?sess(q.session):null;
  root.hidden=!firstMode()||homeMode==='closed';
  root.classList.toggle('retracting',homeMode==='retracting');
  $('#islandToggle').setAttribute('aria-expanded',String(!root.hidden || $('#notch').open));
  document.body.classList.toggle('notch-spread',!root.hidden);
  const latest=live && state.captures.find(c=>c.session && ['Complete','Failed','Running','Queued','Delivered'].includes(c.receipt));
  const recent=latest && sess(latest.session);
  const paneTitle=q?'Decision ready':recent?({Complete:'Result ready',Failed:'Session stopped',Running:'Agent working',Queued:'Handoff queued',Delivered:'Nudge delivered'}[latest.receipt]):'Ready to capture';
  const preview=q?'<button class="request-preview" data-surface="requests" data-target="'+attr(q.id)+'"><span class="preview-icon">'+icon('sessions')+'</span><span><small>'+esc(proj(s.project).name)+' / '+esc(providers[s.agent])+'</small><strong>'+esc(q.q)+'</strong></span>'+icon('right')+'</button>':recent?'<button class="request-preview" data-action="session" data-id="'+attr(recent.id)+'"><span class="preview-icon">'+icon('sessions')+'</span><span><small>'+esc(proj(recent.project)?.name||'Scratch')+' / '+esc(providers[recent.agent])+'</small><strong>'+esc(recent.task)+'</strong></span>'+icon('right')+'</button>':'<p class="home-idle">Capture an idea, ask about a project, or follow up with a session.</p>';
  const content='<header class="home-meta"><span class="icon-label">Tasktap</span>'+surfaceButton('','collapse','down','collapse-button')+'</header><div class="home-heading"><div><h1>'+paneTitle+'</h1><small class="signal-caption"></small></div><span class="signal-light" aria-hidden="true"><i></i></span></div>'+preview+'<footer class="home-actions">'+surfaceButton('Capture','capture','mic','voice-trigger')+'<kbd>'+chords.capture[1]+'</kbd>'+surfaceButton('Workspace','workspace','out','workspace-link')+'</footer>';
  // A session progress event must preserve focused controls and their tab order.
  if(homeContent!==content){root.innerHTML=content;homeContent=content}
  root.querySelector('.collapse-button').setAttribute('aria-label','Collapse notch');
  updateSignal();
}
function openRequest(id){
  if(id&&!byId(state.decisions,id)){toast('This request has already closed.');return}
  if($('#notch').open&&$('#notch [data-action="choose-target"]'))return;

  $('#status-menu').hidden=true;
  decisionVoice=false;
  // Explicitly opening the queue establishes a new selection context.
  choice=null;showNotch(id||pending()?.id);markChoices();updateBounds();
}
function menu(){
  const m=$('#status-menu');m.hidden=!m.hidden;
  $('#status-button').setAttribute('aria-expanded',String(!m.hidden));
  m.innerHTML='<strong>Tasktap</strong>'+[
    ['New capture','capture','mic'],['Review decisions','requests','checks'],
    ['Open workspace','workspace','out'],['Codex Micro controls','controller','settings'],
    ['Notification settings','notifications','bell']
  ].map(([label,act,sym])=>surfaceButton(label,act,sym)).join('');
  if(!m.hidden)m.querySelector('button')?.focus();
}
function notifications(){
  dialog('Notifications','Menu bar','<p>Receive a system notification for decisions and completed sessions.</p><div class="inline">'+surfaceButton(host?'Enable notifications':'Enable preview','notify-enable','bell')+surfaceButton(host?'Turn off alerts':'Turn off preview','notify-off')+'</div><p class="hint">'+(host?'macOS controls delivery, previews, and Focus.':'Browser preview of Notification Center. The native app uses macOS notifications.')+'</p>'+(!host?surfaceButton('Show sample notification','notify-preview'):''));
}
function previewNotice(id,kind){
  const q=byId(state.decisions,id),s=kind==='complete'?sess(id):q&&sess(q.session);
  if(!s)return;
  const n=$('#notification-preview');n.hidden=false;
  n.innerHTML='<div class="notice-head">'+icon('bell')+'<span>Tasktap</span>'+surfaceButton('Dismiss','dismiss-notice')+'</div><strong>'+esc(s.task)+'</strong><p>'+esc(q?q.q:s.result)+'</p>'+surfaceButton(q?'Review decision':'View result',q?'notice-request':'notice-result','arrow','surface-button',id);
}
function emitNotice(id,kind){
  if(!state.alerts)return;
  const q=byId(state.decisions,id),s=kind==='complete'?sess(id):q&&sess(q.session);
  if(!s)return;
  if(host)postHost('notify',{id,kind,title:s.task,body:q?q.q:s.result});
  else previewNotice(id,kind);
}
let knownDecisions=new Set(state.decisions.map(q=>q.id));
let knownComplete=new Set(state.sessions.filter(s=>s.state==='Complete').map(s=>s.id));
function syncSurfaces(){
  drawHome();
  document.body.classList.toggle('needs-decision',state.decisions.length>0);
  const requests=new Set(state.decisions.map(q=>q.id)),done=new Set(state.sessions.filter(s=>s.state==='Complete').map(s=>s.id));
  requests.forEach(id=>{if(!knownDecisions.has(id))emitNotice(id,'request')});
  done.forEach(id=>{if(!knownComplete.has(id))emitNotice(id,'complete')});
  knownDecisions.forEach(id=>{if(!requests.has(id)){postHost('clear',{id,kind:'request'});if($('#notification-preview [data-target="'+CSS.escape(id)+'"]'))$('#notification-preview').hidden=true}});
  knownDecisions=requests;knownComplete=done;
  postHost('status',{count:requests.size});updateBounds();
}
const optionsForDecision=()=>[...$('#notch').querySelectorAll('[data-action="decide"],[data-action="choose-target"],[data-action="discuss"]')];
function visibleBinary(){
  const d=$('#notch');
  if(!d.open || !d.querySelector('.binary-choices'))return null;
  return byId(state.decisions,d.dataset.request) || null;
}
function syncDecisionKeys(){
  const request=visibleBinary()?.id||'';
  if(request!==lastBinary){lastBinary=request;postHost('binary',{id:request})}
}
function markChoices(){
  const d=$('#notch'),items=optionsForDecision();
  syncDecisionKeys();
  if(!d.open||!items.length){choice=null;hardwareNavigation=false;return}
  if(!choice||choice.request!==d.dataset.request)choice={request:d.dataset.request,index:0};
  items.forEach((b,i)=>{
    b.classList.toggle('hardware-selected',hardwareNavigation && i===choice.index);
    if(hardwareNavigation && i===choice.index)b.setAttribute('aria-current','true');else b.removeAttribute('aria-current');
  });
  if(hardwareNavigation && !d.querySelector('.hardware-hint')){
    const hint=document.createElement('div');hint.className='hardware-hint';hint.innerHTML=icon('settings')+'<span>Micro · Previous / Next to select · Confirm to send</span>';
    d.firstElementChild.append(hint);
  }
}
function hardware(action,requestId){
  if(['yes','no','discuss'].includes(action)){
    const q=visibleBinary();
    if(!q || (requestId!==undefined && q.id!==requestId))return;
    if(action==='discuss')showNotch(q.id,true);
    else decide(q.id,q.choices.indexOf(action==='yes'?'Yes':'No'));
    return;
  }
  if($('#discussion') && action==='back'){showNotch($('#notch').dataset.request);return}
  if($('#discussion') && action==='confirm'){$('#discussion').requestSubmit();return}
  if(action==='capture'){
    if(live && $('#transcript')){dictate('#transcript');return}
    if($('#modal').open||$('#notch').open)return;
    if(live)postLive('refresh');newDraft('');
    if(live)dictate('#transcript');return;
  }
  if(action==='requests'){
    if($('#notch').open)return;
    hardwareNavigation=true;
    openRequest();return;
  }
  if(action==='back'){
    const pendingId=$('#notch').open?$('#notch').dataset.request:null;
    const deferred=byId(state.decisions,pendingId);
    if(deferred && state.decisions.length>1){
      state.decisions=state.decisions.filter(q=>q.id!==pendingId).concat(deferred);persist();render();
    }
    if($('#notch').open||$('#modal').open)close();else showHome(false);
    choice=null;return;
  }
  const d=$('#notch'),items=optionsForDecision();
  if(!d.open||!items.length)return;
  hardwareNavigation=true;
  const request=d.dataset.request;
  if(choice?.request!==request){markChoices();if(action==='confirm')return}
  if(action==='confirm'){
    const target=items[choice.index];
    if(!target)return;
    choice=null;target.click();return;
  }
  if(action!=='previous'&&action!=='next')return;
  choice.index=(choice.index+(action==='next'?1:-1)+items.length)%items.length;
  markChoices();items[choice.index].focus({preventScroll:true});items[choice.index].scrollIntoView({block:'nearest'});
}
function controller(){
  const labels={capture:'Start capture',requests:'Open pending decision',previous:'Previous choice',next:'Next choice',confirm:'Confirm / send follow-up',back:'Defer / back',yes:'Agent Key 1 · Yes',no:'Agent Key 2 · No',discuss:'Agent Key 3 · Talk it through'};
  const lighting=host?'<label class="check-line"><input type="checkbox" id="micro-lights" '+(state.microLights?'checked':'')+'> Use Micro decision keys and lights</label><p class="hint" id="micro-status">'+esc(microStatus)+'</p><p class="hint">On a yes/no card, press the green key for Yes, red for No, or the third Agent Key to discuss.</p>':'<p class="hint">The Mac app controls the Micro directly. You can answer every question here with a click or keyboard.</p>';
  dialog('Codex Micro','Optional controller','<div class="mapping-list">'+Object.entries(chords).map(([action,[,keys]])=>'<div><span>'+labels[action]+'</span><kbd>'+keys+'</kbd></div>').join('')+'</div>'+lighting+surfaceButton('Try decision controls','try-controller','checks'));
  if(host)$('#micro-lights').onchange=e=>{state.microLights=e.target.checked;persist();postHost('lightingPreference',{enabled:state.microLights})};
}
function controllerPreview(){
  if(host)return;
  const d=$('#notch');if(!d.open||!optionsForDecision().length)return;
  const box=document.createElement('div');box.className='micro-preview';box.setAttribute('aria-label','Codex Micro simulator');box.innerHTML='<span class="eyebrow">Controller simulation</span><div class="inline">'+['previous','next','confirm','back'].map((a,i)=>surfaceButton(['Previous','Next','Confirm','Defer'][i],'hw-'+a)).join('')+'</div>';d.firstElementChild.append(box);
}
function updateBounds(){
  if(!host||boundsFrame)return;
  boundsFrame=requestAnimationFrame(()=>{
    boundsFrame=0;
    const panel=$('#notch').open?$('#notch'):$('#modal').open?$('#modal'):!$('#notch-home').hidden?$('#notch-home'):$('#island');
    postHost('layout',{workspace:!firstMode(),height:Math.ceil(panel.getBoundingClientRect().height+(panel.id==='island'?0:$('#island').getBoundingClientRect().height)),collapsed:firstMode()&&panel.id==='island'});
  });
}
function command(action,id=''){
  const m=$('#status-menu');m.hidden=true;$('#status-button').setAttribute('aria-expanded','false');
  switch(action){
    case 'home':showHome();break;
    case 'collapse':showHome(false);break;
    case 'workspace':showWorkspace();break;
    case 'capture':hardware('capture');break;
    case 'requests':openRequest(id);break;
    case 'controller':controller();break;
    case 'try-controller':close();hardwareNavigation=true;openRequest();controllerPreview();break;
    case 'notifications':notifications();break;
    case 'notify-enable':state.alerts=true;persist();close();if(host)postHost('authorize');else if(pending())previewNotice(pending().id,'request');break;
    case 'notify-off':state.alerts=false;persist();close();$('#notification-preview').hidden=true;postHost('disableNotifications');break;
    case 'notify-preview':close();if(pending())previewNotice(pending().id,'request');else{const s=state.sessions.find(s=>s.state==='Complete');if(s)previewNotice(s.id,'complete')}break;
    case 'dismiss-notice':$('#notification-preview').hidden=true;break;
    case 'notice-request':$('#notification-preview').hidden=true;openRequest(id);break;
    case 'notice-result':$('#notification-preview').hidden=true;if(sess(id)){closePanels();showSession(id)}break;
    default:if(action.startsWith('hw-'))hardware(action.slice(3));
  }
}
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-surface]');
  if(b)command(b.dataset.surface,b.dataset.target);
  else if(!e.target.closest('#status-menu,#status-button')){$('#status-menu').hidden=true;$('#status-button').setAttribute('aria-expanded','false')}
});
$('#status-button').onclick=menu;
$('#islandToggle').onclick=()=>firstMode()?showHome(homeMode!=='pinned'):openRequest();
if(!host){
  for(const el of [$('#island'),$('#notch-home')]){
    el.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse' && e.buttons===0)hoverNotch(true)});
    el.addEventListener('pointerleave',e=>{if(e.pointerType==='mouse')hoverNotch(false)});
    el.addEventListener('pointerdown',()=>clearTimeout(hoverTimer));
  }
}
$('#notch-home').addEventListener('focusin',()=>{
  if(homeMode==='peek'||homeMode==='retracting'){clearTimeout(hoverTimer);homeMode='pinned';drawHome()}
});
document.addEventListener('voice-activity',updateSignal);
document.addEventListener('keydown',e=>{
  if(e.ctrlKey&&e.altKey&&!e.shiftKey&&!e.metaKey){
    const match=Object.entries(chords).find(([,v])=>v[0]===e.code);
    if(match && ['yes','no','discuss'].includes(match[0]) && !visibleBinary())return;
    if(match){e.preventDefault();e.stopImmediatePropagation();if(!host&&!e.repeat)hardware(match[0]);return}
  }
  if(e.key==='Escape'&&!$('#notch').open&&!$('#modal').open&&(!$('#status-menu').hidden||firstMode())){
    e.preventDefault();if(!$('#status-menu').hidden){menu();$('#status-button').focus()}else showHome(false);
  }
},true);
document.addEventListener('workspace-changed',syncSurfaces);
for(const selector of ['#notch','#modal']){
  const d=$(selector);
  new MutationObserver(()=>{
    if(d.open && (homeMode==='peek'||homeMode==='retracting')){clearTimeout(hoverTimer);homeMode='closed';drawHome()}
    if(selector==='#notch')markChoices();
    updateBounds()
  }).observe(d,{childList:true,attributes:true,attributeFilter:['open']});
  new ResizeObserver(updateBounds).observe(d);
}
if(host)new ResizeObserver(updateBounds).observe($('#notch-home'));
window.workspaceCommand=(action,id='')=>{
  if(action==='live-error'){toast(id);return}
  if(action==='micro-status'){microStatus=id;const status=$('#micro-status');if(status)status.textContent=id;return}
  if(action==='narration-status'){
    spoken=id==='speaking'||id==='preparing';document.body.classList.toggle('is-playing',spoken);
    document.dispatchEvent(new Event('voice-activity'));if(!spoken&&id!=='idle')toast(id);return
  }
  if(['hw-yes','hw-no','hw-discuss'].includes(action)){hardware(action.slice(3),id);return}
  if(action==='hover-enter'||action==='hover-exit'){hoverNotch(action==='hover-enter');return}
  if(action==='notice-request' && !byId(state.decisions,id)){toast('This request has already closed.');return}
  if(action==='notification-denied'){state.alerts=false;persist();toast('Notifications are off. Enable them in System Settings.');return}
  if(action==='notification-granted'){if(pending())emitNotice(pending().id,'request');toast('System notifications enabled.');return}
  if(action==='hotkey-conflict'){toast('Shortcut unavailable: '+id+'. Use the menu bar or change the conflicting shortcut.');return}
  if(action==='hw-back'&&!$('#notch').open&&!$('#modal').open){showHome(false);return}
  command(action,id);
};
document.body.classList.toggle('native-host',!!host);
if(live){const label=$('.local');if(label)label.innerHTML='<i></i>On this Mac'}
if(['#workspace','#geometry'].includes(location.hash)){document.body.classList.remove('notch-first');$('#notch-home').hidden=true}
syncSurfaces();postHost('lightingPreference',{enabled:!!state.microLights});postHost('ready');
