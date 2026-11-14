/* Shared capture and decision UI for the Mac app and standalone browser demo. */
const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const uid = () => crypto.randomUUID?.() || String(Date.now() + Math.random());
const paths = {
  check:'m4 12 5 5L20 6',
  side:'M3 5h18v14H3z M9 5v14', grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  sessions:'M3 5h15v11H3z M8 20h13V9 M6 9l2 2-2 2 M10 13h4', note:'M5 3h14v18H5z M9 3v18 M12 8h4 M12 12h4',
  settings:'M4 7h7 M15 7h5 M4 17h3 M11 17h9 M11 4v6 M7 14v6', plus:'M12 5v14 M5 12h14',
  wifi:'M2 8q10-9 20 0 M6 12q6-6 12 0 M10 16q2-2 4 0 M12 19v.2',battery:'M2 7h17v10H2z M22 10v4 M5 10h10v4H5z',
  down:'m6 9 6 6 6-6',right:'m9 5 7 7-7 7',arrow:'M4 12h15 m-6-6 6 6-6 6',out:'M6 18 18 6 M7 6h11v11',
  mic:'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M5 11v1a7 7 0 0 0 14 0v-1 M12 19v3 M8 22h8',
  folder:'M3 6h7l2 3h9v11H3z',play:'m7 4 12 8-12 8z',stop:'M6 6h12v12H6z',x:'m6 6 12 12 M18 6 6 18',
  claude:'M12 2v20 M2 12h20 M5 5l14 14 M5 19 19 5 M8 3l8 18 M3 16l18-8 M3 8l18 8 M8 21l8-18',
  codex:'m8 7-5 5 5 5 M16 7l5 5-5 5 M14 4l-4 16',agy:'m3 17 8-12h2l8 12 M8 14q4-3 8 0',
  checks:'m3 12 4 4 9-10 M12 15l2 2 8-9',bell:'M5 16h14l-2-3V9a5 5 0 0 0-10 0v4z M10 20h4',
  pen:'m4 16 12-12 4 4L8 20l-5 1z M14 6l4 4',sound:'M3 9h4l5-4v14l-5-4H3z M16 8q5 4 0 8 M19 5q8 7 0 14'
};
const icon = (name) => '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="'+(paths[name]||paths.note)+'"/></svg>';
document.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon));
const providers = {claude:'Claude Code',codex:'Codex',agy:'Antigravity'};
const demoQuote = 'Tell the session working on lighting to make sure the reflections follow the new light direction.';
const mixed = 'For Reactive Wallpapers, remember this curve. Maybe animate it later. Ask Claude where the falloff is defined. Don’t change the shader.';
const seed = {
  projects:[{id:'wall',name:'Reactive Wallpapers',folder:'~/projects/reactive-wallpapers',color:'#b2c4ae',aliases:['wallpaper','wallpapers','shader']},{id:'glass',name:'Glasshouse',folder:'~/projects/glasshouse',color:'#cfb58d',aliases:['glasshouse','greenhouse']},{id:'folio',name:'Folio',folder:'~/projects/folio',color:'#aab6d2',aliases:['folio','document']}],
  sessions:[
    {id:'s1',project:'wall',agent:'claude',task:'Lighting pass',state:'Running',log:['Session started in the wallpaper workspace.','Nudge delivered. Check reflections against the new light direction.']},
    {id:'s2',project:'glass',agent:'codex',task:'Material study',topics:['lighting','glass','material'],state:'Needs input',log:['Compared the existing glass and brushed metal materials.']},
    {id:'s3',project:'folio',agent:'agy',task:'Document indexing',state:'Running',log:['Indexing the sample document library.']},
    {id:'s4',project:'glass',agent:'claude',task:'Lighting balance',state:'Complete',log:['Compared the warm and cool reference renders.'],result:'The warm reference preserves the glass edge. The cool version loses detail near the rim.',viewer:'Preview'}
  ],
  captures:[{id:'c1',text:demoQuote,brief:demoQuote,kind:'Session nudge',project:'wall',session:'s1',time:'09:38',duration:'0:12',receipt:'Delivered'}],
  notes:[{id:'n1',title:'Glass edge reference',text:'Keep the silhouette legible against a dark background.',project:'glass'}],
  decisions:[{id:'q1',session:'s2',q:'Which material should I use for the frame?',detail:'The selected finish will be used in the next preview render.',choices:['Brushed metal','Clear glass']}],
  speak:false
};
const storageKey=live?'tasktap-live-v1':'workspace-assistant-demo-v1';
let state;try{state=JSON.parse(localStorage.getItem(storageKey))||(live?emptyState():structuredClone(seed))}catch{state=live?emptyState():structuredClone(seed)}
let view='overview',draft=null,openedSession=null,decisionVoice=false,spoken=false,simVoice=null,returnFocus=null;
const persist=()=>{try{localStorage.setItem(storageKey,JSON.stringify(state))}catch{toast('Storage unavailable. Changes will last for this visit.')}};
const scratchProject={id:'@scratch',name:'Scratch',folder:'Scratch',aliases:[]};
const proj=id=>id==='@scratch'?scratchProject:state.projects.find(p=>p.id===id);
const sess=id=>state.sessions.find(s=>s.id===id);
const byId=(items,id)=>items.find(i=>i.id===id);
const attr=(s)=>esc(s);
const button=(label,action,id='',style='btn',sym='')=>'<button type="button" class="'+style+'" data-action="'+action+'" data-id="'+attr(id)+'">'+(sym?icon(sym):'')+esc(label)+'</button>';
const option=(value,text,selected='')=>'<option value="'+attr(value)+'" '+(value===selected?'selected':'')+'>'+esc(text)+'</option>';
const heading=(over,title,sub='')=>'<div class="page-heading"><div class="eyebrow">'+esc(over)+'</div><h1>'+esc(title)+'</h1>'+(sub?'<p class="subtitle">'+esc(sub)+'</p>':'')+'</div>';
const statusClass=s=>s==='Needs input'?'waiting':s==='Complete'?'complete':['Unavailable','Failed'].includes(s)?'offline':'running';
const navLink=(id,label,sym,end='')=>'<button class="nav-link '+(view===id?'active':'')+'" '+(view===id?'aria-current="page"':'')+' data-action="view" data-id="'+attr(id)+'">'+sym+'<span class="label">'+esc(label)+'</span>'+end+'</button>';
const count=n=>'<span class="nav-count">'+n+'</span>';
function renderNav(){
  $('#nav').innerHTML='<div class="nav-group"><span class="nav-kicker">Workspace</span>'+navLink('overview','Overview',icon('grid'))+navLink('sessions','Sessions',icon('sessions'),count(state.sessions.length))+navLink('notes','Notebook',icon('note'),count(state.notes.length))+navLink('projects','Projects',icon('folder'),count(state.projects.filter(p=>p.available!==false).length))+'</div>';
  $('#islandLabel').textContent=state.decisions.length?state.decisions.length+' decision'+(state.decisions.length>1?'s':''):'All clear';
}
function wave(){
  const bars=Array.from({length:162},(_,i)=>{const env=Math.pow(Math.abs(Math.sin(i*.068)*Math.cos(i*.032)),.75);const height=3+37*env*(.24+.76*Math.abs(Math.sin(i*7.09+.9)));return '<rect x="'+(i*4.5)+'" y="'+((44-height)/2).toFixed(1)+'" width="2.25" height="'+height.toFixed(1)+'" rx="1.1" fill="'+(i<106?'#e7b77e':'#71817f')+'"/>';}).join('');
  return '<svg class="wave" viewBox="0 0 730 44" preserveAspectRatio="none" aria-hidden="true">'+bars+'</svg>';
}
function captureCard(c){
  const session=sess(c.session),p=proj(c.project);
  return '<article class="capture-card"><div class="cap-meta"><span class="icon-label">'+icon('mic')+'Latest capture</span><span>'+esc(c.time)+'</span></div><blockquote>“'+esc(c.text||'Attached sketch')+'”</blockquote><div class="signal"><button class="play-btn" data-action="readcapture" aria-label="Read latest capture aloud">'+icon('play')+'</button>'+wave()+'<span>'+esc(c.duration||'Text')+'</span></div><div class="capture-foot"><span class="icon-label">'+icon(p?'folder':'note')+esc(p?.name||'Scratch')+(session?' / '+esc(session.task):'')+'</span>'+button('View capture','detailcapture',c.id,'text-btn','out')+'</div></article>';
}
function sessionRow(s,fixture=false){
  const agent=s.source==='desktop'?'Codex · ChatGPT desktop':providers[s.agent]||'Agent',p=proj(s.project);
  return '<button class="session-row" data-action="session" data-id="'+attr(s.id)+'">'+(s.agent?'<span class="agent-mark '+attr(s.agent)+'">'+icon(s.agent)+'</span>':'<span aria-hidden="true"></span>')+'<span><span class="row-title">'+esc(s.task)+'</span><span class="row-sub">'+esc(agent)+'</span></span><span class="row-project">'+esc(p?.name||'Project')+'</span>'+(fixture?'<span class="fixture-amount">'+esc(s.amount)+'</span>':'<span class="row-state '+statusClass(s.state)+'"><i class="state-dot"></i>'+esc(s.state)+'</span>')+icon('right')+'</button>';
}
function sessionList(rows){return rows.length?'<div class="session-list">'+rows.map(s=>sessionRow(s)).join('')+'</div>':'<p class="empty">No sessions here yet.</p>'}
function noteList(notes){return notes.length?notes.map(n=>'<button class="note" data-action="note" data-id="'+attr(n.id)+'"><span class="eyebrow">'+esc(proj(n.project)?.name||'Scratch')+'</span><strong>'+esc(n.title)+'</strong><span class="hint">'+esc(n.text)+'</span></button>').join(''):'<p class="empty">No notes here yet.</p>'}
let projectFilter='';
function renderProjectList(){
  const rows=state.projects.filter(p=>p.available!==false && p.name.toLowerCase().includes(projectFilter.toLowerCase()));
  $('#project-list').innerHTML=rows.map(p=>button(p.name,'view',p.id,'note','folder')).join('')||'<p class="empty">No matching projects.</p>';
}
function render(){
  renderNav();document.dispatchEvent(new Event('workspace-changed'));
  const p=proj(view),name=({overview:'Overview',sessions:'Sessions',notes:'Notebook',projects:'Projects'})[view]||p?.name||'Workspace';$('#crumb').textContent=name;
  const active=state.sessions.filter(s=>['Running','Needs input','Queued'].includes(s.state));
  const intro=heading(live?new Date().toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'}):'Saturday, 14 November',name,view==='overview'?active.length+' active sessions across '+new Set(active.map(s=>s.project)).size+' projects.':p?p.folder:'');
  let body='';
  if(view==='overview')body=(state.captures[0]?captureCard(state.captures[0]):'')+'<section class="block"><div class="group-head"><h2>Active sessions</h2>'+button('All sessions','view','sessions','text-btn','arrow')+'</div>'+sessionList(active)+'</section>';
  else if(view==='projects')body='<section class="block"><label class="field">Find a project<input id="project-filter" type="search" placeholder="Folder name" value="'+attr(projectFilter)+'"></label><div id="project-list"></div></section>';
  else if(view==='sessions')body=sessionList(state.sessions);
  else if(view==='notes')body='<section class="block">'+noteList(state.notes)+'</section>';
  else if(p)body='<section class="block"><h2>Sessions</h2>'+sessionList(state.sessions.filter(s=>s.project===p.id))+'</section><section class="block"><h2>Project notes</h2>'+noteList(state.notes.filter(n=>n.project===p.id))+'</section>';
  const activeFilter=document.activeElement?.id==='project-filter';
  const caret=activeFilter?document.activeElement.selectionStart:0;
  $('#main').innerHTML=intro+body;
  if(view==='projects'){
    const input=$('#project-filter');
    input.oninput=()=>{projectFilter=input.value;renderProjectList()};
    renderProjectList();
    if(activeFilter){input.focus({preventScroll:true});input.setSelectionRange(caret,caret)}
  }
}
function toast(message){$('#toast').textContent=message;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').textContent='',3000)}
function go(id){clearTimeout(toast.timer);$('#toast').textContent='';view=id;document.body.classList.remove('nav-open');render();if(document.body.classList.contains('notch-first'))$('#islandToggle').focus();else $('#main').focus()}
function frame(title,over,body){return '<div class="dialog-body"><div class="dialog-title"><div><span class="eyebrow">'+esc(over)+'</span><h2 id="dialog-heading">'+esc(title)+'</h2></div><button class="icon-btn" data-action="close" aria-label="Close dialog">'+icon('x')+'</button></div>'+body+'</div>'}
function dialog(title,over,body){clearTimeout(toast.timer);$('#toast').textContent='';const d=$('#modal');if(!d.open)returnFocus=document.activeElement;d.innerHTML=frame(title,over,body);d.setAttribute('aria-labelledby','dialog-heading');if(!d.open)d.showModal();else $('button',d)?.focus()}
function dismissCard(){if(live)stopDictation();clearTimeout(simVoice);simVoice=null;document.dispatchEvent(new Event('voice-activity'));if($('#notch').open){$('#notch').close();$('#islandToggle').setAttribute('aria-expanded','false');if($('#modal').open)$('#modal button')?.focus();else $('#islandToggle').focus();return}if($('#modal').open)$('#modal').close();if(returnFocus?.isConnected)returnFocus.focus();else if(document.body.classList.contains('notch-first'))$('#islandToggle').focus();else $('#main').focus()}
let siriVoices=[];
let kokoro={status:'checking',detail:'Checking local voice…'};
function updateKokoro(status,detail){
  kokoro={status,detail};
  if(!$('#voice-engine'))return;
  voiceOptions();
  const hint=$('#voice-status');if(hint)hint.textContent=detail;
  const setup=$('[data-action="setup-voice"]');
  if(setup)setup.hidden=status!=='missing';
}

function configureVoices(voices){
  siriVoices=voices;
  if($('#voice-engine'))voiceOptions();
}
function voiceOptions(){
  const choices=[...siriVoices];
  if(window.webkit?.messageHandlers?.workspace)choices.push({id:'kokoro',name:'Local Kokoro · Heart'+(kokoro.status==='missing'?' (setup required)':' (English)')});
  const selected=state.voiceEngine ?? siriVoices[0]?.id ?? '';
  $('#voice-engine').innerHTML=option('','Off',selected)+choices.map(v=>option(v.id,v.name,selected)).join('');
  const local=$('#voice-engine option[value="kokoro"]');if(local)local.disabled=kokoro.status!=='ready';
}
function speak(text){
  const native=window.webkit?.messageHandlers?.workspace;
  if(spoken){if(native)native.postMessage({type:'stopSpeech'});else window.speechSynthesis?.cancel();finishSpeech();return}
  const voice=state.voiceEngine ?? siriVoices[0]?.id;
  if(!voice){toast('Choose an available narration voice in Preferences.');return}
  if(native){native.postMessage({type:'speak',voice,text});return}
  const selected=window.speechSynthesis?.getVoices().find(v=>v.localService && v.voiceURI===voice && /siri/i.test(v.voiceURI+' '+v.name));
  if(!selected){toast('This browser has no local Siri voice available.');return}
  const u=new SpeechSynthesisUtterance(text);u.voice=selected;u.onend=finishSpeech;u.onerror=finishSpeech;
  spoken=true;document.dispatchEvent(new Event('voice-activity'));window.speechSynthesis.speak(u);
}
function finishSpeech(){spoken=false;document.body.classList.remove('is-playing');document.dispatchEvent(new Event('voice-activity'))}
if(!window.webkit?.messageHandlers?.workspace && window.speechSynthesis){
  const refresh=()=>configureVoices(speechSynthesis.getVoices().filter(v=>v.localService && /siri/i.test(v.voiceURI+' '+v.name)).map(v=>({id:v.voiceURI,name:v.name})));
  refresh();speechSynthesis.addEventListener('voiceschanged',refresh);
}
function showSession(id){
  const s=sess(id);if(!s)return;openedSession=id;
  const q=state.decisions.find(q=>q.session===id);
  const actions=live&&!canNudge(s)?[]:[button('Follow up','follow',id,'primary','mic')];
  if(live && s.source==='desktop')actions.push(button('Open in ChatGPT','openchat',id,'primary'));
  if(live && s.managed && ['claude','codex'].includes(s.agent) && ['Failed','Complete'].includes(s.state))actions.push(button('Resume in Terminal','terminal',id),button('Copy resume command','copyresume',id));
  if(q)actions.push(button('Review decision','notch',q.id));
  if(!live && s.state==='Running' && !s.producerKey)actions.push(button('Simulate completion','complete',id));
  if(s.result)actions.push(button('Read aloud','speakresult',id,'btn','sound'),button('Open in '+(s.viewer||(live?'Finder':'editor')),'openresult',id));
  dialog(s.task,providers[s.agent]+' · '+s.state,'<div class="detail-line">'+icon('folder')+'<span class="mono">'+esc(proj(s.project)?.folder)+'</span></div><section class="block"><h3>Activity</h3><ul class="time-line">'+s.log.map(e=>'<li><i class="state-dot"></i>'+esc(s.result && e==='Complete. '+s.result?'Complete':e)+'</li>').join('')+'</ul></section>'+(s.result?'<section class="notice"><strong>Agent summary</strong><p>'+esc(s.result)+'</p></section>':'')+'<div class="inline">'+actions.join('')+'</div>');
}
function routeDecision(candidates){
  const d=$('#notch');d.dataset.request=uid();
  const choices=candidates.map((s,i)=>'<button class="decision-btn" data-action="choose-target" data-id="'+attr(s.id)+'"><span class="agent-mark '+attr(s.agent)+'">'+icon(s.agent)+'</span><span><strong>'+esc(s.task)+'</strong><br><span class="hint">'+esc(proj(s.project).name)+' · '+esc(providers[s.agent])+'</span></span></button>').join('');
  d.innerHTML='<div class="dialog-body notch-content"><div class="dialog-title"><div><span class="eyebrow">Route follow-up</span><h2>Which session?</h2></div><button aria-label="Close decision" class="icon-btn" data-action="close">'+icon('x')+'</button></div><p>These sessions match your capture. Choose where the nudge belongs.</p><div class="block">'+choices+'</div><form id="route-voice" class="field"><label for="route-answer">' +(live?'Reply':'Voice reply simulation')+'</label><input id="route-answer" placeholder="Project, session name, or choice number" required>'+(live?button('Dictate','dictate','#route-answer','text-btn','mic'):'')+'<button class="btn">Use reply</button></form></div>';
  d.showModal();$('#islandToggle').setAttribute('aria-expanded','true');
  $('#route-voice').onsubmit=e=>{e.preventDefault();const input=$('#route-answer'),v=input.value.trim().toLowerCase();const found=candidates.filter((s,i)=>[s.task,proj(s.project).name,String(i+1)].some(x=>x.toLowerCase()===v));if(found.length===1){chooseTarget(found[0].id);return}input.setCustomValidity('Enter one project name, task name, or choice number.');input.reportValidity();input.oninput=()=>input.setCustomValidity('')};
}
function chooseTarget(id){if(!draft||!sess(id))return;draft.session=id;draft.project=sess(id).project;dismissCard();review()}
function binaryControls(q){
  const buttons=q.choices.map((c,i)=>button(c,'decide',q.id+'|'+i,'decision-btn '+(c==='Yes'?'answer-yes':'answer-no'),c==='Yes'?'check':'x'));
  return '<div class="binary-choices">'+buttons.join('')+'</div>'+button('Talk it through','discuss',q.id,'text-btn discussion-link','mic');
}
function discussionPanel(q){
  const entries=(q.discussion||[]).map(text=>'<li>'+esc(text)+'</li>').join('');
  return '<form class="stack" id="discussion"><label class="field" for="comment">Talk it through<textarea id="comment" rows="2" required placeholder="Ask a question or suggest a change…">'+esc(q.discussionDraft||'')+'</textarea></label>'+
    '<p class="hint">Type or use system dictation. Your message stays with this decision.</p>'+
    '<div class="inline">'+(live?button('Dictate','dictate','#comment','text-btn','mic'):'')+'<button class="btn">Send follow-up</button>'+button('Back to decision','notch',q.id,'text-btn')+'</div></form>'+
    (entries?'<section class="discussion-log"><h4>Follow-ups for '+esc(sess(q.session).task)+'</h4><ul>'+entries+'</ul><small class="hint">Follow-up recorded · decision pending</small></section>':'');
}
function bindDiscussion(q){
  const form=$('#discussion'),input=$('#comment');
  input.focus();
  input.oninput=()=>{q.discussionDraft=input.value;input.setCustomValidity('');persist()};
  form.onsubmit=e=>{
    e.preventDefault();
    if(byId(state.decisions,q.id)!==q)return;
    const message=input.value.trim();
    if(!message){input.setCustomValidity('Enter a follow-up.');input.reportValidity();return}
    (q.discussion??=[]).push(message);delete q.discussionDraft;
    sess(q.session).log.push('Follow-up on “'+q.q+'” — '+message);
    persist();render();if(q.producerKey)window.webkit?.messageHandlers?.workspace.postMessage({type:'questionUpdated'});showNotch(q.id,true);
  };
}
function showNotch(id,discuss=false){
  const d=$('#notch'),q=id?byId(state.decisions,id):state.decisions[0],s=q?sess(q.session):null;
  if(id&&!q){toast('This request has already closed.');return}
  let controls='';
  if(q && discuss)controls=discussionPanel(q);
  else if(q?.kind==='binary' && !decisionVoice)controls=binaryControls(q)+(live?button('Answer by voice','voicechoice',q.id,'text-btn voice','mic'):'');
  else if(q){
    controls='<div class="block">'+q.choices.map((c,i)=>button(c,'decide',q.id+'|'+i,'decision-btn')).join('')+'</div>'+
      (decisionVoice?'<form id="voice-choice" class="field"><label for="answer">Voice reply simulation · type a choice or its number</label><input id="answer" autocomplete="off" required><button class="btn">Submit reply</button></form>':button('Answer by voice','voicechoice',q.id,'text-btn voice','mic'))+button('Talk it through','discuss',q.id,'text-btn discussion-link','mic');
  }
  const next=q && !discuss && state.decisions.length>1?button('Next request','notch',state.decisions[(state.decisions.indexOf(q)+1)%state.decisions.length].id,'text-btn','arrow'):'';
  d.innerHTML='<div class="dialog-body notch-content"><div class="dialog-title"><div><span class="eyebrow">'+(q?esc(proj(s.project)?.name)+' · '+esc(providers[s.agent]):'Workspace')+'</span><h2>'+(q?esc(s.task):'All clear')+'</h2></div><button data-action="close" class="icon-btn" aria-label="Close decision">'+icon('x')+'</button></div>'+
    (q?'<div class="stack"><p class="flag" style="color:inherit">Pending request '+(state.decisions.indexOf(q)+1)+' of '+state.decisions.length+'</p><h3>'+esc(q.q)+'</h3>'+(q.detail?'<p class="hint">'+esc(q.detail)+'</p>':'')+controls+next+'</div>':'<p>No sessions are waiting for a decision.</p>')+'</div>';
  d.dataset.request=q?.id||'';if(!d.open)d.showModal();$('#islandToggle').setAttribute('aria-expanded','true');
  if(decisionVoice)$('#answer',d)?.focus();
  if(discuss && q)bindDiscussion(q);
  if(live && decisionVoice && $('#answer',d)){
    const label=$('label[for="answer"]',d);label.textContent='Say or type a choice';
    label.insertAdjacentHTML('afterend',button('Dictate','dictate','#answer','text-btn','mic'));
  }
  const form=$('#voice-choice',d);if(form)form.onsubmit=e=>{e.preventDefault();const val=$('#answer',d).value.trim().toLowerCase().replace(/[.!?]+$/,'');const i=q.choices.findIndex((c,i)=>val===c.toLowerCase()||val===String(i+1));if(i<0){$('#answer',d).setCustomValidity('Enter one of the displayed choices or its number.');$('#answer',d).reportValidity();$('#answer',d).oninput=()=>$('#answer',d).setCustomValidity('');return}decide(q.id,i)};
}
function decide(id,i){
  const q=byId(state.decisions,id);
  if(!q||!q.choices[i])return;
  const s=sess(q.session),answer=q.choices[i];
  (s.answeredDecisions??=[]).push({id:q.id,question:q.q,detail:q.detail,choices:q.choices,producerKey:q.producerKey,answer,discussion:q.discussion||[]});
  s.log.push('Decision received. '+answer+'.');
  state.decisions=state.decisions.filter(x=>x.id!==id);
  s.state=state.decisions.some(other=>other.session===s.id)?'Needs input':'Running';
  decisionVoice=false;persist();dismissCard();render();
  if($('#modal').open&&$('#dialog-heading')?.textContent===s.task)showSession(s.id);
  if(q.producerKey)window.webkit?.messageHandlers?.workspace.postMessage({type:'questionUpdated'});
  toast('Decision sent to '+s.task+'.');
}
function newDraft(target){
  const s=sess(target);
  draft={text:'',brief:'',note:'',mode:s?'nudge':'ask',project:s?.project||(proj(view)?view:''),session:s?.id||'',agent:s?.agent||'claude',viewer:'',strokes:[],newName:'',keep:false,hasVoice:false,sketch:false};
  editDraft();
}
function sketchMarkup(strokes){
  return '<svg class="sketch-view" viewBox="0 0 600 176" role="img" aria-label="Captured sketch">'+strokes.map(line=>'<polyline fill="none" stroke="#2b5147" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="'+line.map(p=>p.map(Number).join(',')).join(' ')+'"/>').join('')+'</svg>';
}
function editDraft(){
  dialog('New capture','Capture', '<div class="fields"><label>Transcript<textarea id="transcript" placeholder="Talk through an idea or type a follow-up…">'+esc(draft.text)+'</textarea></label><div class="inline">'+(live?button('Dictate','dictate','#transcript','btn','mic'):button('Use voice sample','sample','','btn','mic'))+button(draft.sketch?'Hide sketch pad':'Add sketch','sketch','','btn','pen')+'</div>'+(draft.sketch?'<div class="field"><span>Sketch</span><canvas id="pad" width="600" height="176" class="drawpad" aria-label="Sketch pad. Use pointer to draw, or add the keyboard sample below."></canvas><div class="inline">'+button('Add sample curve','curve')+button('Clear sketch','clearink')+'</div></div>':'')+'</div><div class="form-actions">'+button('Cancel','discard')+button('Review capture','review','','primary','arrow')+'</div>');
  $('#transcript').oninput=e=>draft.text=e.target.value;
  if(draft.sketch)setupPad();
}
function setupPad(){
  const c=$('#pad'),g=c.getContext('2d');
  const draw=()=>{g.clearRect(0,0,c.width,c.height);g.lineWidth=3;g.strokeStyle='#2b5147';g.lineJoin='round';g.lineCap='round';for(const line of draft.strokes){g.beginPath();line.forEach(([x,y],i)=>i?g.lineTo(x,y):g.moveTo(x,y));g.stroke()}};
  const point=e=>{const r=c.getBoundingClientRect();return [(e.clientX-r.left)*c.width/r.width,(e.clientY-r.top)*c.height/r.height]};
  let pointer=null;c.onpointerdown=e=>{pointer=e.pointerId;c.setPointerCapture(pointer);const start=point(e);draft.strokes.push([start,[start[0]+.1,start[1]+.1]]);draw()};c.onpointermove=e=>{if(e.pointerId===pointer){draft.strokes.at(-1).push(point(e));draw()}};c.onpointerup=c.onpointercancel=()=>{pointer=null};draw();
}
function matchProjects(t){
  const words=' '+t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()+' ';
  return state.projects.filter(p=>p.available!==false && [p.name,...p.aliases].some(a=>words.includes(' '+a.toLowerCase().replace(/[-_]+/g,' ')+' ')));
}
function matchSessions(t){
  const words=t.toLowerCase().match(/[a-z]+/g)||[];
  const stop=new Set(['the','for','and','with','session','working','make','that','this','tell','please','ask','check','sure','agent','about']);
  return state.sessions.filter(s=>[...(s.task.toLowerCase().match(/[a-z]+/g)||[]),...(s.topics||[])].some(w=>w.length>2&&!stop.has(w)&&words.includes(w))&&(!live?s.state!=='Complete':canNudge(s)));
}
function interpret(){
  const d=draft,t=d.text.trim(),lower=t.toLowerCase(),ps=matchProjects(t),ss=matchSessions(t);
  d.brief=t;d.note='';d.keep=false;d.candidates=[];
  const instruction=/\b(?:ask (?:claude(?: code)?|codex|antigravity|agy)|tell (?:[^.!?]*?\b)?(?:session|agent)|nudge|follow up)\b/i.exec(t);
  if(!d.session)d.mode=instruction?(/^(tell|nudge|follow)/i.test(instruction[0])?'nudge':'ask'):
    /\b(remember|note|save|idea)\b/.test(lower)||!t?'note':'ask';
  if(instruction){
    const before=t.slice(0,instruction.index).trim(), work=t.slice(instruction.index);
    if(/\b(remember|note|save|idea)\b/i.test(before)){
      d.note=before;d.keep=true;
    }
    // Preserve constraints after the instruction. Keep preceding context in the handoff
    // unless it was captured separately as a note or solely names the workspace.
    if(d.mode==='ask' && (d.keep || !before || /^for [^,.]+[,.:]?$/i.test(before))){
      d.brief=work.replace(/^ask (?:claude(?: code)?|codex|antigravity|agy)\s+(?:to\s+)?/i,'').trim();
      if(/^(where|how|whether|why)\b/i.test(d.brief))d.brief='Find '+d.brief;
      d.brief=d.brief.charAt(0).toUpperCase()+d.brief.slice(1);
    }
  }
  if(!d.project&&ps.length===1)d.project=ps[0].id;
  if(!d.session && /\bask (claude|codex|antigravity|agy)\b/i.test(t))d.mode='ask';
  if(d.mode==='nudge'&&!d.session){const choices=ps.length===1?ss.filter(s=>s.project===ps[0].id):ss;if(choices.length===1){d.session=choices[0].id;d.project=choices[0].project}else if(choices.length>1){d.candidates=choices.map(s=>s.id)}}
  if(/codex/i.test(t))d.agent='codex';if(/antigravity|\bagy\b/i.test(t))d.agent='agy';const viewer=/\b(?:in|with|using|via|to)\s+(?:apple |the )?(xcode|preview|finder)\b/i.exec(t);if(viewer)d.viewer=['Xcode','Preview','Finder'].find(app=>app.toLowerCase()===viewer[1].toLowerCase());
}
function routingPrompt(){
  const d=draft;
  if(d.mode==='note'&&!d.project)d.project='@scratch';
  if(d.mode==='nudge'&&!d.session && d.candidates?.length){
    routeDecision(d.candidates.map(sess));return;
  }
  if(d.mode==='nudge'&&!d.session){
    const available=state.sessions.filter(s=>(live?canNudge(s):s.state!=='Complete') && (!d.project||d.project===s.project));
    if(available.length){routeDecision(available);return}
    d.mode='ask';
  }
  if(!d.project){
    const projects=state.projects.filter(p=>p.available!==false);
    dialog('Which workspace?', 'Tasktap','<label class="field">Find a project<input id="route-filter" type="search" placeholder="Folder name"></label><div class="route-list" id="route-list"></div><div class="inline">'+button('Keep in scratch','route-project','@scratch')+button('New workspace…','route-project','@new')+'</div>');
    const field=$('#route-filter');
    const filter=()=>{$('#route-list').innerHTML=projects.filter(p=>p.name.toLowerCase().includes(field.value.toLowerCase())).map(p=>button(p.name,'route-project',p.id)).join('')||'<p class="empty">No matching projects.</p>'};
    field.oninput=filter;filter();
    return;
  }
  review();
}
function review(){
  const d=draft,s=sess(d.session);
  const destination=d.mode==='nudge'?s?.task:d.project==='@scratch'?'Scratch':d.project==='@new'?d.newName:proj(d.project)?.name;
  const action=d.mode==='note'?'Save note':d.mode==='nudge'?'Send nudge':'Start session';
  const where=[d.mode==='nudge'?proj(s?.project)?.name:null,destination,d.mode==='note'?null:providers[d.mode==='nudge'?s?.agent:d.agent],d.viewer].filter(Boolean).join(' · ');
  const note=d.keep && d.mode!=='note'?'<p class="hint">Also save a note: '+esc(d.note||d.brief)+'</p>':'';
  dialog('Review capture',where,'<p class="review-brief" id="review-brief">'+esc(d.brief||'Attached sketch')+'</p>'+(d.strokes.length?sketchMarkup(d.strokes):'')+note+
    '<div class="form-actions">'+button('Adjust','adjust')+button(action,'commit-review','','primary')+'</div>');
}
function adjustReview(){
  const d=draft;
  const routes=[['note','Save a note'],['ask','Ask an agent'],['nudge','Nudge a session']];
  const ps=state.projects.map(p=>option(p.id,p.name,d.project)).join('');
  const matches=matchSessions(d.text);
  const sessionChoices=[...matches,...state.sessions.filter(s=>!matches.includes(s))];
  const field=(label,html)=>'<label>'+label+html+'</label>';
  const projectField=field('Workspace','<select id="project" required>'+option('','Choose a workspace',d.project)+ps+option('@new','Create project folder…',d.project)+option('@scratch','Keep in scratch',d.project)+'</select>');
  const sessionField=field('Existing session','<select id="session" required>'+option('','Choose the matching session',d.session)+sessionChoices.map(s=>option(s.id,s.task+' · '+proj(s.project)?.name+' · '+providers[s.agent],d.session)).join('')+'</select>');
  const newField=d.project==='@new'?field('New project name','<input id="newName" value="'+attr(d.newName)+'" placeholder="Name under ~/projects" required pattern="[^/]+">'):'';
  const providerFields=d.mode==='ask'?field('Agent','<select id="agent">'+Object.entries(providers).map(([k,v])=>option(k,v,d.agent)).join('')+'</select>')+field('Open result in','<select id="viewer">'+['','Xcode','Preview','Finder'].map(v=>option(v,v||'Choose later',d.viewer)).join('')+'</select>'):'';
  dialog('Adjust handoff','Routing','<form id="route-form" class="fields"><details><summary>Original capture'+(d.strokes.length?' · sketch attached':'')+'</summary><p class="body-copy">'+esc(d.text||'Sketch only')+'</p>'+(d.strokes.length?sketchMarkup(d.strokes):'')+'</details>'+field('Action','<select id="mode">'+routes.map(([k,v])=>option(k,v,d.mode)).join('')+'</select>')+field(d.mode==='note'?'Note':'Agent handoff','<textarea id="brief" '+(d.strokes.length?'':'required')+'>'+esc(d.brief)+'</textarea>')+(d.mode==='nudge'?sessionField:projectField+newField)+providerFields+(d.mode!=='note'?'<div class="check-line"><input id="keep" type="checkbox" '+(d.keep?'checked':'')+'><label for="keep">Save a separate project note</label></div>'+(d.keep?field('Project note','<textarea id="sideNote" required>'+esc(d.note)+'</textarea>'):''):'')+'<div class="form-actions">'+button('Edit capture','edit')+'<button class="primary" type="submit">Review changes</button></div></form>');
  const f=$('#route-form');
  f.querySelectorAll('button[data-action]').forEach(b=>b.type='button');
  const bind=(id,key)=>{const el=$('#'+id,f);if(el)el.oninput=()=>d[key]=el.value};
  [['brief','brief'],['sideNote','note'],['newName','newName'],['agent','agent'],['viewer','viewer']].forEach(([id,key])=>bind(id,key));
  $('#mode',f).onchange=e=>{d.mode=e.target.value;adjustReview()};
  if($('#project',f))$('#project',f).onchange=e=>{d.project=e.target.value;adjustReview()};
  if($('#session',f))$('#session',f).onchange=e=>{d.session=e.target.value;d.project=sess(d.session)?.project||''};
  if($('#keep',f))$('#keep',f).onchange=e=>{d.keep=e.target.checked;adjustReview()};
  f.onsubmit=e=>{e.preventDefault();routingPrompt()};
}
function commitCapture(){
  const d=draft;if(!d)return;
  if(live){submitLive(d);return}
  if(d.project==='@new'){
    const name=d.newName.trim();if(!name||name==='.'||name==='..'){toast('Choose a project name.');return}
    const existing=state.projects.find(p=>p.name.toLowerCase()===name.toLowerCase());
    if(existing){d.project=existing.id}else{const p={id:uid(),name,folder:'~/projects/'+name,color:'#a8c3ae',aliases:[]};state.projects.push(p);d.project=p.id}
  }
  const cid=uid(),time=new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}),c={id:cid,time,text:d.text,brief:d.brief,project:d.project==='@scratch'?'':d.project,strokes:d.strokes,duration:d.hasVoice?'Sample':'Text',receipt:'Saved',kind:'Note'};
  let s;
  if(d.mode==='ask'){s={id:uid(),project:d.project,agent:d.agent,task:d.brief.trim().slice(0,78)||'Review sketch',state:'Running',log:['Session started. '+d.brief],viewer:d.viewer,capture:cid};state.sessions.unshift(s);c.kind='Agent question';c.receipt='Started';c.session=s.id}
  if(d.mode==='nudge'){s=sess(d.session);if(!s){toast('Choose an available session.');return}c.project=s.project;c.kind='Session nudge';c.receipt='Queued';c.session=s.id;s.log.push('Nudge queued. '+d.brief)}
  if(d.mode==='note'||d.keep){const text=d.mode==='note'?d.brief:d.note;state.notes.unshift({id:uid(),project:c.project,text,title:text.trim().slice(0,64)||'Sketch',capture:cid})}
  state.captures.unshift(c);draft=null;persist();dismissCard();render();
  if(d.mode==='nudge'){toast('Nudge queued for '+s.task+'.');setTimeout(()=>deliver(cid),1400)}
  else if(d.mode==='ask'){showSession(s.id)}else{if(!document.body.classList.contains('notch-first'))go('notes');toast('Note saved.')}
}
function deliver(id){
  const c=byId(state.captures,id),s=c&&sess(c.session);if(!s||c.receipt!=='Queued')return;
  c.receipt='Delivered';s.log.push('Nudge delivered. '+c.brief);if(s.state==='Complete'){s.state='Running';delete s.result}
  persist();render();if($('#modal').open&&openedSession===s.id&&$('#dialog-heading')?.textContent===s.task)showSession(s.id);
  if($('#modal').open&&$('#dialog-heading')?.textContent==='Capture detail'&&$('#receipt')?.dataset.capture===id)detailCapture(id);
  toast('Nudge delivered to '+s.task+'.');
}
function detailCapture(id){const c=byId(state.captures,id);if(!c)return;dialog('Capture detail',c.kind,'<div class="detail-line">'+icon('folder')+esc(proj(c.project)?.name||'Scratch')+'<span id="receipt" data-capture="'+attr(id)+'" class="badge">'+esc(c.receipt)+'</span></div><div class="block"><h3>Original capture</h3><p class="body-copy">'+esc(c.text||'Sketch only')+'</p>'+(c.strokes?.length?sketchMarkup(c.strokes):'')+'</div><div class="block"><h3>Reviewed brief</h3><p class="body-copy">'+esc(c.brief)+'</p></div>'+(c.session?button('Open session','session',c.session):''))}
function showNote(id){
  const n=byId(state.notes,id),c=n.capture&&byId(state.captures,n.capture);
  dialog(n.title,proj(n.project)?.name||'Scratch','<p class="body-copy">'+esc(n.text)+'</p>'+(c?.strokes?.length?sketchMarkup(c.strokes):'')+(c?button('View original capture','detailcapture',c.id):'')+(!n.project?'<form id="assign" class="fields"><label>Assign to project<select id="assign-project" required>'+option('','Choose project')+state.projects.map(p=>option(p.id,p.name)).join('')+'</select></label><button class="primary">Move note</button></form>':''));
  const f=$('#assign');if(f)f.onsubmit=e=>{e.preventDefault();const project=$('#assign-project').value;if(live){postLive('assign-note',{id,capture:n.capture,folder:proj(project).folder});return}noteAssigned(id,project)};
}
function noteAssigned(id,project){const n=byId(state.notes,id);if(!n)return;n.project=project;persist();render();showNote(id);toast('Note assigned to '+proj(project).name+'.')}
function prefs(){dialog('Preferences','Tasktap','<div class="fields"><div class="field">Workspace root <span class="mono">~/projects</span></div><label class="field">Narration voice<select id="voice-engine"></select></label>'+(live?'<p id="voice-status" class="hint" role="status">'+esc(kokoro.detail)+'</p><div class="inline">'+button('Set up Kokoro','setup-voice')+button('Preview voice','preview-voice')+'</div>':'')+'<div class="check-line"><input id="narration" type="checkbox" '+(state.speak?'checked':'')+'><label for="narration">Read completion summaries aloud</label></div>'+(live?'':button('Reset sample data','reset'))+'</div>');voiceOptions();if(live){updateKokoro(kokoro.status,kokoro.detail);postLive('check-kokoro')}$('#voice-engine').onchange=e=>{state.voiceEngine=e.target.value;persist()};$('#narration').onchange=e=>{state.speak=e.target.checked;persist()}}
function complete(id){const s=sess(id);if(s.state!=='Running')return;s.state='Complete';s.result='Demo result: the agent finished the requested review in '+proj(s.project).name+'. Open the conversation to inspect its work.';s.log.push('Simulated completion received.');persist();render();showSession(id);if(state.speak)speak(s.result)}
function startSample(){
  const b=$('[data-action="sample"]');b.textContent='Listening to sample…';b.disabled=true;clearTimeout(simVoice);
  simVoice=setTimeout(()=>{simVoice=null;document.dispatchEvent(new Event('voice-activity'));if(!draft||!$('#transcript'))return;draft.text=(draft.text.trim()?draft.text+' ':'')+mixed;draft.hasVoice=true;editDraft();$('#transcript').focus();toast('Sample transcript ready.')},650);document.dispatchEvent(new Event('voice-activity'));
}
document.addEventListener('click',e=>{
  const el=e.target.closest('[data-action]');if(!el)return;const a=el.dataset.action,id=el.dataset.id;
  switch(a){
    case 'view':go(id);break;case 'capture':newDraft('');break;case 'menu':document.body.classList.toggle('nav-open');break;
    case 'follow':newDraft(id);break;case 'session':showSession(id);break;case 'close':dismissCard();break;case 'prefs':prefs();break;
    case 'readcapture':speak(state.captures[0].text||'Attached sketch');break;case 'speakresult':speak(sess(id).result);break;
    case 'openchat':postLive('open-desktop-chat',{id:sess(id).conversation});break;
    case 'setup-voice':postLive('install-kokoro');break;
    case 'preview-voice':speak('Tasktap is ready. What would you like to work on?');break;
    case 'terminal':postLive('resume-terminal',{id});break;
    case 'copyresume':postLive('copy-resume',{id});break;
    case 'openresult':if(live){const s=sess(id);postLive('open-result',{id,viewer:s.viewer||'Finder',text:s.result||''});break}dialog('Result preview',sess(id).viewer||'Editor','<p>'+esc(sess(id).result)+'</p><p class="hint">Opening an external app is simulated here.</p>'+button('Back to session','session',id));break;
    case 'detailcapture':detailCapture(id);break;case 'note':showNote(id);break;case 'sample':startSample();break;case 'dictate':dictate(id);break;
    case 'sketch':draft.sketch=!draft.sketch;editDraft();break;
    case 'curve':draft.strokes.push(Array.from({length:70},(_,i)=>[38+i*7.2,30+Math.pow(i/69,2)*112]));setupPad();break;
    case 'clearink':draft.strokes=[];setupPad();break;case 'discard':draft=null;dismissCard();break;
    case 'review':if(recording){toast('Finish dictation before reviewing.');return}if(!draft.text.trim()&&!draft.strokes.length){toast('Add text or a sketch to continue.');$('#transcript').focus();return}if(!draft.session && !draft.strokes.length && /^(?:(?:well|um+|uh+|oh|okay|ok|h[ei]y|hi|hello|hallo|hey there|testing|test|mic check|thank you|thanks|good (?:morning|evening))[\s,.!?]*)+$/i.test(draft.text.trim())){dialog('What would you like to do?','Capture',button('Keep talking','continue-capture','','primary','mic')+button('Dismiss','discard'));break}interpret();if(live)prepareHandoff();else routingPrompt();break;
    case 'skip-routing':delete draft.routing;routingPrompt();break;case 'adjust':adjustReview();break;
    case 'route-project':draft.project=id;if(id==='@new'){
      dialog('Name the workspace','Tasktap','<form id="workspace-name" class="field"><label>Folder under ~/projects<input id="newName" required></label><button class="primary">Review</button></form>');
      $('#workspace-name').onsubmit=e=>{e.preventDefault();const name=$('#newName').value.trim();if(!name||name.includes('/')||name==='.'||name==='..'){toast('Choose a folder name.');return}draft.newName=name;review()};
    }else review();break;
    case 'commit-review':commitCapture();break;
    case 'continue-capture':draft.text='';editDraft();if(live)dictate('#transcript');else $('#transcript').focus();break;
    case 'edit':editDraft();break;case 'notch':decisionVoice=false;showNotch(id);break;case 'voicechoice':decisionVoice=true;showNotch(id);if(live)dictate('#answer');break;
    case 'choose-target':chooseTarget(id);break;case 'decide':{const [q,i]=id.split('|');decide(q,Number(i));break}
    case 'discuss':showNotch(id,true);break;
    case 'complete':complete(id);break;
    case 'reset':dialog('Reset sample data?','Preferences','<p>Your prototype notes, decisions, and sessions will return to the original sample set.</p><div class="form-actions">'+button('Keep my changes','prefs')+button('Reset prototype','confirmreset','','primary')+'</div>');break;
    case 'confirmreset':{
      const live=state.sessions.filter(s=>s.producerKey),pending=state.decisions.filter(q=>q.producerKey);
      const projects=state.projects.filter(p=>live.some(s=>s.project===p.id)&&!byId(seed.projects,p.id));
      const {voiceEngine,microLights,alerts,speak}=state;
      state={...structuredClone(seed),voiceEngine,microLights,alerts,speak};
      state.sessions.push(...live);state.decisions.push(...pending);state.projects.push(...projects);
      draft=null;persist();dismissCard();go('overview');toast('Sample data reset.');break;
    }
  }
});
$('#islandToggle').onclick=()=>{decisionVoice=false;showNotch()};
document.addEventListener('keydown',e=>{
  if(e.defaultPrevented)return;
  if(e.key==='Escape'){if($('#notch').open||$('#modal').open){e.preventDefault();dismissCard()}else document.body.classList.remove('nav-open');return}
  if(e.key.toLowerCase()==='n'&&!e.shiftKey&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!$('#modal').open&&!$('#notch').open&&!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)){e.preventDefault();newDraft('')}
});
render();
if(!live)state.captures.filter(c=>c.receipt==='Queued').forEach(c=>setTimeout(()=>deliver(c.id),1400));
if(location.hash==='#geometry'){
  $('#main').innerHTML=heading('Design verification','Session geometry')+'<div class="session-list fixture">'+[
    {...seed.sessions[0],task:'Label',amount:'Count'},
    {...seed.sessions[1],task:'Arbeitsbereich für Beleuchtungseinstellungen und Reflexionsberechnungen',amount:'1,234,567'},
    {...seed.sessions[2],agent:'',task:'Missing icon',amount:'8'}
  ].map(s=>sessionRow(s,true)).join('')+'</div>';
}
