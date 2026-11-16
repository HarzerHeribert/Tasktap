/* Shared capture and decision UI for the Mac app and standalone browser demo. */
const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const uid = () => crypto.randomUUID?.() || String(Date.now() + Math.random());
const paths = {
  terminal:'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M6 8l3 3-3 3 M12 14h5',globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M5 6h14 M5 18h14 M12 3c-5 4-5 14 0 18 M12 3c5 4 5 14 0 18',attention:'M12 5v9 M12 18v1',
  copy:'M8 8h12v13H8z M16 8V3H3v13h5',up:'m6 15 6-6 6 6',check:'m4 12 5 5L20 6',
  side:'M3 5h18v14H3z M9 5v14',splitRight:'M3 5h18v14H3z M12 5v14',splitDown:'M3 5h18v14H3z M3 12h18', grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  sessions:'M3 5h15v11H3z M8 20h13V9 M6 9l2 2-2 2 M10 13h4', note:'M5 3h14v18H5z M9 3v18 M12 8h4 M12 12h4',
  settings:'M4 7h7 M15 7h5 M4 17h3 M11 17h9 M11 4v6 M7 14v6', plus:'M12 5v14 M5 12h14',
  wifi:'M2 8q10-9 20 0 M6 12q6-6 12 0 M10 16q2-2 4 0 M12 19v.2',battery:'M2 7h17v10H2z M22 10v4 M5 10h10v4H5z',
  back:'M20 12H4m6-6-6 6 6 6',down:'m6 9 6 6 6-6',right:'m9 5 7 7-7 7',arrow:'M4 12h15 m-6-6 6 6-6 6',out:'M6 18 18 6 M7 6h11v11',
  mic:'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M5 11v1a7 7 0 0 0 14 0v-1 M12 19v3 M8 22h8',
  folder:'M3 6h7l2 3h9v11H3z',play:'m7 4 12 8-12 8z',pause:'M8 5v14 M16 5v14',stop:'M6 6h12v12H6z',x:'m6 6 12 12 M18 6 6 18',
  'cursor-agent':'m4 5 15 7-7 2-3 7z',pi:'M3 7h18 M8 7v13 M16 7v10q0 3 4 3',
  claude:'M12 2v20 M2 12h20 M5 5l14 14 M5 19 19 5 M8 3l8 18 M3 16l18-8 M3 8l18 8 M8 21l8-18',
  codex:'m8 7-5 5 5 5 M16 7l5 5-5 5 M14 4l-4 16',agy:'m3 17 8-12h2l8 12 M8 14q4-3 8 0',
  checks:'m3 12 4 4 9-10 M12 15l2 2 8-9',bell:'M5 16h14l-2-3V9a5 5 0 0 0-10 0v4z M10 20h4',
  pen:'m4 16 12-12 4 4L8 20l-5 1z M14 6l4 4',sound:'M3 9h4l5-4v14l-5-4H3z M16 8q5 4 0 8 M19 5q8 7 0 14'
};
const icon = (name) => '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="'+(paths[name]||paths.note)+'"/></svg>';
document.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon));
const providers = {claude:'Claude Code',codex:'Codex',agy:'Antigravity','cursor-agent':'Cursor CLI',pi:'Pi'};
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
let state;
try{state=JSON.parse(localStorage.getItem(storageKey))}catch{}
const returningInstall=!!state;
state ||= live?emptyState():structuredClone(seed);
let view='overview',draft=null,openedSession=null,spoken=false,simVoice=null,returnFocus=null;
const persist=()=>{try{localStorage.setItem(storageKey,JSON.stringify(state))}catch{toast('Storage unavailable. Changes will last for this visit.')}};
const scratchProject={id:'@scratch',name:'Scratch',folder:'Scratch',aliases:[]};
const proj=id=>id==='@scratch'?scratchProject:state.projects.find(p=>p.id===id);
const sess=id=>state.sessions.find(s=>s.id===id);
const byId=(items,id)=>items.find(i=>i.id===id);
const attr=(s)=>esc(s);
const button=(label,action,id='',style='btn',sym='')=>'<button type="button" class="'+style+'" data-action="'+action+'" data-id="'+attr(id)+'">'+(sym?icon(sym):'')+esc(label)+'</button>';
const option=(value,text,selected='')=>'<option value="'+attr(value)+'" '+(value===selected?'selected':'')+'>'+esc(text)+'</option>';
const heading=(over,title,sub='')=>'<div class="page-heading"><div class="eyebrow">'+esc(over)+'</div><h1>'+esc(title)+'</h1>'+(sub?'<p class="subtitle">'+esc(sub)+'</p>':'')+'</div>';
const statusClass=s=>['Needs input','Awaiting agent','Ready to send'].includes(s)?'waiting':s==='Complete'?'complete':['Running','Queued'].includes(s)?'running':'offline';
const navLink=(id,label,sym,end='')=>'<button class="nav-link '+(view===id?'active':'')+'" '+(view===id?'aria-current="page"':'')+' data-action="view" data-id="'+attr(id)+'">'+sym+'<span class="label">'+esc(label)+'</span>'+end+'</button>';
const count=n=>'<span class="nav-count">'+n+'</span>';
const activeSessionStates=new Set(['Running','Needs input','Queued','Opening','Awaiting agent','Ready to send','Connected']);
function activeSessions(){
  const pending=new Set(state.decisions.map(q=>q.session));
  return state.sessions.filter(s=>pending.has(s.id)||activeSessionStates.has(s.state));
}
function projectPeers(project,ownId){
  const checkout=id=>{const p=proj(id);return p?.checkout || p?.folder};
  const folder=checkout(project);
  if(!folder || project==='@scratch')return [];
  // A connected transport alone is not evidence that an agent is doing overlapping work.
  return state.sessions.filter(s=>s.id!==ownId && s.available!==false && s.state!=='Connected' && activeSessionStates.has(s.state) && checkout(s.project)===folder);
}
function peerDisclosure(peers,project,links=false){
  if(!peers.length)return '';
  const rows=peers.map(s=>{
    const label=[s.task,providers[s.agent],s.state].filter(Boolean).join(' / ');
    return '<li>'+(links?'<button class="peer-session" data-action="session" data-id="'+attr(s.id)+'"><span class="agent-mark '+attr(s.agent)+'">'+icon(s.agent)+'</span><span><span class="row-title">'+esc(s.task)+'</span><span class="row-sub">'+esc([providers[s.agent],sessionLocation(s),s.state].filter(Boolean).join(' / '))+'</span></span>'+icon('right')+'</button>':esc(label))+'</li>';
  });
  return '<details class="route-evidence" data-project-peers><summary>'+peers.length+' other session'+(peers.length===1?'':'s')+' in '+esc(proj(project).name)+'</summary><ul>'+rows.join('')+'</ul></details>';
}
function listedProjects(active){
  const ids=new Set(active.map(s=>s.project));
  return state.projects.filter(p=>p.available!==false && (state.showIdleProjects || ids.has(p.id)));
}
function renderNav(projects){
  const scroll=$('#nav').scrollTop;
  $('#nav').innerHTML='<div class="nav-group"><span class="nav-kicker">Workspace</span>'+navLink('overview','Overview',icon('grid'))+navLink('sessions','Sessions',icon('sessions'),count(state.sessions.length))+navLink('notes','Notebook',icon('note'),count(state.notes.length))+navLink('projects','Projects',icon('folder'),count(projects.length))+'</div>';
  if(typeof workspaceNavigation!=='undefined'){$('#nav').innerHTML=workspaceNavigation.navigation();workspaceNavigation.sync()}
  $('#nav').scrollTop=scroll;
  $('#islandLabel').textContent=state.decisions.length?state.decisions.length+' decision'+(state.decisions.length>1?'s':''):'All clear';
}
function sessionUpdated(s){
  const date=new Date(Number(s.updatedAt));
  if(!s.updatedAt || !Number.isFinite(date.getTime()))return '<span class="row-updated" aria-label="Update time unavailable">—</span>';
  const today=new Date().toDateString()===date.toDateString();
  const short=date.toLocaleString(undefined,today?{hour:'numeric',minute:'2-digit'}:{month:'short',day:'numeric'});
  return '<time class="row-updated" datetime="'+date.toISOString()+'" title="'+attr(date.toLocaleString())+'">'+esc(short)+'</time>';
}
function sessionColumns(){return '<div class="list-columns" aria-hidden="true"><span>Session</span><span class="row-project">Project</span><span class="row-agent">Agent / host</span><span>Status</span><span class="row-updated">Updated</span><span></span></div>'}
function historySessionRow(s,{question,fixture=false,title=question?.q || sessionDisplayName(s),status=question?'Needs input':s.state}={}){
  const project=proj(s.project)?.name||'Scratch',agent=providers[s.agent]||'Agent',host=sessionLocation(s);
  const context=question?'<span class="row-sub row-context">'+esc(sessionDisplayName(s))+'</span>':'';
  return '<button class="session-row work-row" data-action="'+(question?'notch':'session')+'" data-id="'+attr(question?.id || s.id)+'">'+
    '<span class="session-cell"><span class="agent-mark '+attr(s.agent||'')+'" aria-hidden="true">'+icon(s.agent||'sessions')+'</span><span class="session-copy"><span class="row-title" title="'+attr(title)+'">'+esc(title)+'</span>'+context+'<span class="row-compact"><span class="row-compact-project">'+esc(project)+'</span><span class="row-compact-agent">'+esc([agent,host].filter(Boolean).join(' / '))+'</span></span></span></span>'+
    '<span class="row-project" title="'+attr(project)+'">'+esc(project)+'</span><span class="row-agent"><span>'+esc(agent)+'</span><span class="row-sub">'+esc(host||'—')+'</span></span><span class="row-state '+statusClass(question?'Needs input':s.state)+'"><i class="state-dot" aria-hidden="true"></i>'+esc(status)+'</span>'+sessionUpdated(s)+icon('right')+'</button>';
}
function sessionRow(s,{question,fixture=false,title=question?.q || sessionDisplayName(s),status=question?'Needs input':s.state,home='',resultTime=0}={}){
  const agent=[providers[s.agent]||'Agent',sessionLocation(s)].filter(Boolean).join(' / '),p=proj(s.project);
  if(home){
    const result=home==='result',host=sessionLocation(s),project=p?.name||'Scratch';
    const sentence=!s.sessionName&&typeof title==='string'&&title===s.task&&home!=='attention'?title.match(/^(.{16,160}?[.!?])\s+(?=[A-Z“"\d])/):null;
    const headline=sentence&&!/\b(?:e\.g|i\.e|Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc)\.$/i.test(sentence[1])?sentence[1]:title;
    const metadata='<span class="home-row-project" title="'+attr(p?.folder||project)+'">'+esc(project)+'</span><span class="home-row-agent">'+esc(providers[s.agent]||'Agent')+'</span>'+(host?'<span class="home-row-host">'+esc(host)+'</span>':'');
    let time='',timeLabel='';
    if(result&&Number.isFinite(resultTime)&&resultTime>0){
      const date=new Date(resultTime),today=new Date(),sameDay=date.toDateString()===today.toDateString();
      const short=sameDay?date.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):date.toLocaleDateString(undefined,{month:'short',day:'numeric',...(date.getFullYear()!==today.getFullYear()?{year:'numeric'}:{})});
      const full='Result received '+date.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
      timeLabel=full;
      time='<time class="home-result-time" datetime="'+date.toISOString()+'" title="'+attr(full)+'" aria-label="'+attr(full)+'">'+esc(short)+'</time>';
    }
    const end=result?time:'<span class="row-state '+statusClass(question?'Needs input':s.state)+'"><i class="state-dot" aria-hidden="true"></i>'+esc(status)+'</span>';
    return '<button type="button" class="session-row home-session-row'+(home==='attention'?' is-question':'')+(result?' home-result-row':'')+'" data-action="'+(question?'notch':result&&s.host==='tasktap'?'deck-result':'session')+'" data-id="'+attr(question?.id||s.id)+'" aria-label="'+attr([title,project,agent,result?timeLabel:status].filter(Boolean).join(' / '))+'"><span class="agent-mark '+attr(s.agent||'')+'">'+icon(s.agent||'sessions')+'</span><span class="home-row-body"><span class="row-title" title="'+attr(title)+'">'+esc(headline)+'</span><span class="row-sub home-row-meta"'+(question?' title="'+attr(sessionDisplayName(s))+'"':'')+'>'+metadata+'</span></span><span class="home-row-end">'+end+icon('right')+'</span></button>';
  }
  if(!fixture)return historySessionRow(s,{question,title,status});
  const lastRun=view==='sessions' && s.updatedAt?new Date(s.updatedAt).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'';
  const subtitle=[question?sessionDisplayName(s):'',agent,lastRun].filter(Boolean).join(' / ');
  return '<button class="session-row" data-action="'+(question?'notch':'session')+'" data-id="'+attr(question?.id || s.id)+'">'+(s.agent?'<span class="agent-mark '+attr(s.agent)+'">'+icon(s.agent)+'</span>':'<span aria-hidden="true"></span>')+'<span><span class="row-title" title="'+attr(title)+'">'+esc(title)+'</span><span class="row-sub">'+(view==='sessions'?'<span class="history-project">'+esc(p?.name||'Scratch')+'</span>':'')+esc(subtitle)+'</span></span><span class="row-project">'+esc(p?.name||'Project')+'</span>'+(fixture?'<span class="fixture-amount">'+esc(s.amount)+'</span>':'<span class="row-state '+statusClass(question?'Needs input':s.state)+'"><i class="state-dot"></i>'+esc(status)+'</span>')+icon('right')+'</button>';
}
function workOverview(active){
  const questions=new Map();
  for(const q of state.decisions){
    if(!questions.has(q.session))questions.set(q.session,[]);
    questions.get(q.session).push(q);
  }
  const attention=[],progress=[];
  for(const session of active){
    const pending=questions.get(session.id);
    if(pending)attention.push(...pending.map(question=>sessionRow(session,{question,home:'attention'})));
    else if(session.state==='Needs input')attention.push(sessionRow(session,{title:session.waitingFor || session.task,home:'attention'}));
    else{
      const turn=state.captures.find(c=>c.session===session.id);
      const sending=turn?.kind==='Session nudge' && ['Queued','Running'].includes(turn.receipt) && ['Queued','Running'].includes(session.state);
      progress.push(sending?sessionRow(session,{title:turn.brief || session.task,status:turn.receipt==='Queued'?'Follow-up queued':'Sending follow-up',home:'progress'}):sessionRow(session,{home:'progress'}));
    }
  }
  const section=(title,rows,kind)=>rows.length?'<section class="block home-session-section" data-home-section="'+kind+'"><div class="home-section-heading"><h2>'+title+'<span class="home-section-count">'+rows.length+'</span></h2>'+(kind==='results'?button('History','view','sessions','text-btn','arrow'):'')+'</div><div class="session-list home-session-list">'+rows.join('')+'</div></section>':'';
  // A capture's clock label is request time, and a discovered session's updatedAt
  // can reflect any edit. Only an observed completion receipt dates a result.
  const results=state.sessions.filter(s=>s.result).map(s=>({session:s,time:Math.max(0,...(state.workspaceDeck?.activity||[]).filter(a=>a.kind==='complete'&&a.id===s.id&&a.body===s.result&&Number.isFinite(a.time)&&a.time>0&&a.time<=8.64e15).map(a=>a.time))})).sort((a,b)=>b.time-a.time).slice(0,3).map(({session,time})=>sessionRow(session,{home:'result',resultTime:time}));
  return section('Needs your attention',attention,'attention')+section('In progress',progress,'progress')+section('Recent results',results,'results') || '<p class="empty">No active sessions.</p>';
}
function sessionList(rows){return rows.length?'<div class="session-list work-list">'+sessionColumns()+rows.map(s=>sessionRow(s)).join('')+'</div>':'<p class="empty">No sessions here yet.</p>'}
function noteList(notes){return notes.length?notes.map(n=>'<button class="note" data-action="note" data-id="'+attr(n.id)+'" aria-label="'+attr((proj(n.project)?.name||'Scratch')+' / '+n.title)+'"><span class="eyebrow">'+esc(proj(n.project)?.name||'Scratch')+'</span><strong>'+esc(n.title)+'</strong><span class="hint">'+esc(n.text)+'</span></button>').join(''):'<p class="empty">No notes here yet.</p>'}
let projectFilter='';
let sessionFilter='';
function renderSessionHistory(){
  const words=sessionFilter.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const history=new Map();
  if(words.length){
    for(const c of state.captures){
      const entries=history.get(c.session) || [];
      entries.push(c.brief,c.text,c.result);history.set(c.session,entries);
    }
  }
  const rows=state.sessions.filter(s=>{
    const text=[sessionNameSearch(s),proj(s.project)?.name,providers[s.agent],s.result,...(history.get(s.id)||[])].join(' ').toLocaleLowerCase();
    return words.every(word=>text.includes(word));
  }).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  $('#session-history').innerHTML=(rows.length || !words.length?sessionList(rows):'<p class="empty">No matching sessions.</p>')+(typeof workspaceDeck!=='undefined'?workspaceDeck.shellHistory(sessionFilter):'');
}
function renderProjectList(projects){
  const rows=projects.filter(p=>p.name.toLowerCase().includes(projectFilter.trim().toLowerCase()));
  $('#project-list').innerHTML=rows.length?'<div class="project-table"><div class="project-columns" aria-hidden="true"><span>Project / folder</span><span>Active</span><span>Sessions</span><span></span></div>'+rows.map(p=>{
    const sessions=state.sessions.filter(s=>s.project===p.id),active=sessions.filter(s=>activeSessionStates.has(s.state)).length;
    return '<button class="project-row" data-action="view" data-id="'+attr(p.id)+'"><span class="session-cell"><span class="project-folder" aria-hidden="true">'+icon('folder')+'</span><span class="session-copy"><span class="row-title">'+esc(p.name)+'</span><span class="row-sub project-path" title="'+attr(p.folder||'')+'">'+esc(p.folder||'Folder unavailable')+'</span></span></span><span class="project-active '+(active?'has-active':'')+'" aria-label="'+active+' active sessions">'+active+'</span><span class="project-total" aria-label="'+sessions.length+' sessions">'+sessions.length+'</span>'+icon('right')+'</button>';
  }).join('')+'</div>':'<p class="empty">'+(projectFilter.trim()?'No matching projects.':state.showIdleProjects?'No project folders found.':'No projects have active sessions.')+'</p>';
}
function render(){
  const active=activeSessions(),projects=listedProjects(active);
  renderNav(projects);document.dispatchEvent(new Event('workspace-changed'));
  const p=proj(view),name=({overview:'Home',sessions:'Session history',notes:'Notebook',projects:'All projects'})[view]||p?.name||'Workspace';$('#crumb').textContent=name;
  if(typeof workspaceDeck!=='undefined'){if(p){workspaceDeck.renderProject(p);return}else workspaceDeck.leave()}
  const intro=heading(live?new Date().toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'}):'Saturday, 14 November',name,p?p.folder:'');
  let body='';
  if(view==='overview')body=workOverview(active);
  else if(view==='projects')body='<section class="block"><label class="field">Find a project<input id="project-filter" type="search" placeholder="Folder name" value="'+attr(projectFilter)+'"></label><label class="check-line"><input type="checkbox" id="include-idle" '+(state.showIdleProjects?'checked':'')+'>Show idle projects</label><div id="project-list"></div></section>';
  else if(view==='sessions')body='<section class="block"><label class="field">Find a session<input id="session-filter" type="search" placeholder="Current or past name, project, agent or result" value="'+attr(sessionFilter)+'"></label><div id="session-history"></div></section>';
  else if(view==='notes')body='<section class="block">'+noteList(state.notes)+'</section>';
  else if(p)body='<section class="block"><div class="group-head"><h2>Sessions</h2>'+(p.available!==false?button('Start session','start-session',p.id,'primary','plus'):'')+'</div>'+sessionList(state.sessions.filter(s=>s.project===p.id))+'</section><section class="block"><h2>Project notes</h2>'+noteList(state.notes.filter(n=>n.project===p.id))+'</section>';
  const activeFilter=['project-filter','session-filter'].includes(document.activeElement?.id)?document.activeElement.id:'';
  const caret=activeFilter?document.activeElement.selectionStart:0;
  const main=$('#main');
  if(view==='overview'){
    const content=main.querySelector('.overview-content');
    if(content){
      // Session receipts refresh the rows while the visible artwork keeps playing.
      main.querySelector('.page-heading').outerHTML=intro;
      content.innerHTML=body;
    }else{
      main.innerHTML=motionOverview(intro)+'<div class="overview-content">'+body+'</div>';
    }
  }else main.innerHTML=intro+body;
  if(view==='projects'){
    const input=$('#project-filter');
    input.oninput=()=>{projectFilter=input.value;renderProjectList(projects)};
    $('#include-idle').onchange=e=>{
      state.showIdleProjects=e.target.checked;persist();
      render();
      $('#include-idle').focus({preventScroll:true});
    };
    renderProjectList(projects);
  }
  if(view==='sessions'){
    const input=$('#session-filter');
    input.oninput=()=>{sessionFilter=input.value;renderSessionHistory()};
    renderSessionHistory();
  }
  if(activeFilter){
    const input=document.getElementById(activeFilter);
    if(input){input.focus({preventScroll:true});input.setSelectionRange(caret,caret)}
  }
}
function toast(message){$('#toast').textContent=message;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').textContent='',3000)}
function go(id){clearTimeout(toast.timer);$('#toast').textContent='';view=id;document.body.classList.remove('nav-open');render();if(document.body.classList.contains('notch-first'))$('#islandToggle').focus();else $('#main').focus()}
function frame(title,over,body,backLabel='',lead=''){
  const nav=backLabel?'<button class="icon-btn" data-action="close" aria-label="'+attr(backLabel)+'">'+icon('back')+'</button>':'<button class="icon-btn" data-action="close" aria-label="Close dialog">'+icon('x')+'</button>';
  if(lead)return '<div class="dialog-body notch-review"><h2 id="dialog-heading" class="sr-only">'+esc(title)+'</h2>'+
    '<div class="dialog-title">'+lead+nav+'</div><p class="eyebrow notch-destination">'+esc(over)+'</p>'+body+'</div>';
  return '<div class="dialog-body"><div class="dialog-title"><div>'+(over?'<span class="eyebrow">'+esc(over)+'</span>':'')+'<h2 id="dialog-heading">'+esc(title)+'</h2></div>'+nav+'</div>'+body+'</div>'}
function dialog(title,over,body,backLabel='',lead=''){settingsPickers.close();if(draft?.routing && title!=='Preparing handoff')cancelRouting();clearTimeout(toast.timer);$('#toast').textContent='';const d=$('#modal');if(!d.open)returnFocus=document.activeElement;d.innerHTML=frame(title,over,body,backLabel,lead);d.setAttribute('aria-labelledby','dialog-heading');if(!d.open)d.showModal();else $('button',d)?.focus()}
function dismissCard(){if(draft?.claudeBrief && $('#modal[open] #claude-brief') && !$('#notch').open)delete draft.claudeBrief;if(!$('#notch').open && setupWizard.showing()){setupWizard.cancel();return}cancelRouting();stopRoutingSpeech();if(live)stopDictation();clearTimeout(simVoice);simVoice=null;document.dispatchEvent(new Event('voice-activity'));if($('#notch').open){$('#notch').close();$('#islandToggle').setAttribute('aria-expanded','false');if($('#modal').open)$('#modal button')?.focus();else $('#islandToggle').focus();return}if($('#modal').open)$('#modal').close();if(returnFocus?.isConnected)returnFocus.focus();else if(document.body.classList.contains('notch-first'))$('#islandToggle').focus();else $('#main').focus()}
let siriVoices=[];
let kokoro={status:'checking',detail:'Checking local voice…'};
function updateKokoro(status,detail){
  kokoro={status,detail};
  document.dispatchEvent(new Event('local-voices-changed'));
  if(!$('#voice-engine'))return;
  voiceOptions();
  const hint=$('#voice-status');if(hint)hint.textContent=detail;
  const setup=$('[data-action="setup-voice"]');
  if(setup)setup.hidden=status!=='missing';
}

function configureVoices(voices){
  siriVoices=voices;
  document.dispatchEvent(new Event('local-voices-changed'));
  if($('#voice-engine'))voiceOptions();
}
function voiceOptions(){
  const choices=[...siriVoices];
  if(window.webkit?.messageHandlers?.workspace)choices.push({id:'kokoro',name:'Local Kokoro / Heart'+(kokoro.status==='missing'?' (setup required)':' (English)')});
  const selected=state.voiceEngine ?? siriVoices[0]?.id ?? '';
  $('#voice-engine').innerHTML=option('','Off',selected)+choices.map(v=>option(v.id,v.name,selected)).join('');
  const local=$('#voice-engine option[value="kokoro"]');if(local)local.disabled=kokoro.status!=='ready';
  settingsPickers.sync($('#voice-engine'));
}
function speak(text){
  const native=window.webkit?.messageHandlers?.workspace;
  if(spoken){if(native)native.postMessage({type:'stopSpeech'});else window.speechSynthesis?.cancel();finishSpeech();return}
  readAloud(text);
}
function readAloud(text){
  const native=window.webkit?.messageHandlers?.workspace;
  const voice=state.voiceEngine ?? siriVoices[0]?.id;
  if(!voice){toast('Choose an available narration voice in Preferences.');return}
  if(native){native.postMessage({type:'speak',voice,text});return}
  const selected=window.speechSynthesis?.getVoices().find(v=>v.localService && v.voiceURI===voice && /siri/i.test(v.voiceURI+' '+v.name));
  if(!selected){toast('This browser has no local Siri voice available.');return}
  window.speechSynthesis.cancel();
  const u=new SpeechSynthesisUtterance(text);u.voice=selected;u.onend=finishSpeech;u.onerror=finishSpeech;
  spoken=true;document.dispatchEvent(new Event('voice-activity'));window.speechSynthesis.speak(u);
}
function finishSpeech(){spoken=false;document.body.classList.remove('is-playing');document.dispatchEvent(new Event('voice-activity'))}
if(!window.webkit?.messageHandlers?.workspace && window.speechSynthesis){
  const refresh=()=>configureVoices(speechSynthesis.getVoices().filter(v=>v.localService && /siri/i.test(v.voiceURI+' '+v.name)).map(v=>({id:v.voiceURI,name:v.name})));
  refresh();speechSynthesis.addEventListener('voiceschanged',refresh);
}
function showSession(id){
  const s=sess(id);if(!s)return;
  const peersWereOpen=openedSession===id && !!$('#modal[open] [data-project-peers][open]');
  const peerFocus=peersWereOpen?document.activeElement.closest('[data-project-peers]'):null;
  const focusedPeer=peerFocus?document.activeElement.dataset.id:null;
  openedSession=id;
  const q=state.decisions.find(q=>q.session===id);
  const actions=[];
  if(live && s.host==='claude-desktop' && s.available)actions.push(button('Open brief in Claude Desktop','focus-session',id,'primary','out'));
  if(live && (s.interactive && s.available===true && !['Closed','Queued','Opening'].includes(s.state) || s.source==='cmux' && s.available)){
    actions.push(button(s.host==='warp'?'Reattach in Warp':'Open in '+sessionLocation(s),'focus-session',id,'primary','out'));
  }
  if(live && s.resumable && !s.available)actions.push(button('Resume in '+sessionLocation(s),'reopen-session',id,'primary','out'));
  if(!live || canNudge(s))actions.push(button('Follow up','follow',id,actions.length?'btn':'primary','mic'));
  const latest=state.captures.find(c=>c.session===id);
  const retry=failedStart(s);
  if(retry)actions.push(button('Review & retry','review-retry',id,'primary'));
  if(latest)actions.push(button('View handoff','detailcapture',latest.id));
  if(live && s.source==='desktop')actions.push(button('Open in ChatGPT','openchat',id,'primary'));
  if(live && s.managed && !s.interactive && !s.planAccount && ['claude','codex'].includes(s.agent) && ['Failed','Complete'].includes(s.state))actions.push(button('Resume in Terminal','terminal',id),button('Copy resume command','copyresume',id));
  if(q)actions.push(button('Review decision','notch',q.id));
  if(!live && s.state==='Running' && !s.producerKey)actions.push(button('Simulate completion','complete',id));
  const turns=state.captures.filter(c=>c.session===id);
  const history=turns.length>1?'<details class="route-evidence"><summary>Handoff history / '+turns.length+'</summary><ul>'+turns.map(c=>'<li>'+button(c.kind+' / '+(c.brief||c.text||'Sketch').slice(0,70),'detailcapture',c.id,'text-btn')+'</li>').join('')+'</ul></details>':'';
  const location=s.interactive && !retry && !s.resumable?'<p class="hint">'+esc(s.state==='Closed' || s.state==='Complete' && !s.available?'The terminal session has closed.':s.state==='Failed'?'Check the terminal for the launch error.':s.available===false?'Waiting for the terminal session.':s.state==='Awaiting agent'?'Open '+sessionLocation(s)+' to check for a sign-in or folder trust prompt.':'You can type, interrupt, and answer approvals in '+sessionLocation(s)+'.')+'</p>':'';
  const desktopHint=s.host==='claude-desktop'?'<p class="hint">Confirm the project folder and send the prepared brief in Claude Desktop. Activity and replies stay in Claude.</p>':'';
  const waiting=s.waitingFor?'<p class="hint">'+esc('Waiting in the original session / '+s.waitingFor)+'</p>':'';
  const turn=state.captures.find(c=>c.session===s.id);
  const relay=live && (!s.result || turn?.receipt!=='Complete')?handoffRelay.forCapture(turn):'';
  const status='<section class="session-summary"><div class="session-summary-line"><span class="row-state '+statusClass(s.state)+'"><i class="state-dot" aria-hidden="true"></i>'+esc(s.state)+'</span><span class="row-sub">'+esc(sessionLocation(s))+'</span></div><span class="session-folder">'+icon('folder')+esc(proj(s.project)?.folder)+'</span></section>';
  const activity=s.log.length?'<details class="session-activity"><summary>Activity / '+s.log.length+'</summary><ul class="time-line">'+s.log.map(e=>'<li><i class="state-dot"></i>'+esc(sessionActivityLine(s,e))+'</li>').join('')+'</ul></details>':'';
  dialog(sessionDisplayName(s),[providers[s.agent],s.model].filter(Boolean).join(' / '),'<div class="session-detail">'+status+(s.result?resultPresentation.markup(s.result,id):'')+(actions.length?'<div class="session-actions inline">'+actions.join('')+'</div>':'')+location+desktopHint+waiting+(relay?'<div class="session-receipt">'+relay+'</div>':'')+peerDisclosure(projectPeers(s.project,id),s.project,true)+activity+history+sessionNameHistory(s)+'</div>');
  resultPresentation.paint($('#modal'));
  const disclosure=$('#modal [data-project-peers]');
  if(peersWereOpen && disclosure){
    disclosure.open=true;
    if(peerFocus)(Array.from(disclosure.querySelectorAll('button')).find(b=>b.dataset.id===focusedPeer) || disclosure.querySelector('summary')).focus({preventScroll:true});
  }
}
function routeDecision(candidates,suggested=true){
  const d=$('#notch');d.dataset.request=uid();
  const choices=candidates.map((s,i)=>'<button class="decision-btn" data-action="choose-target" data-id="'+attr(s.id)+'"><span class="agent-mark '+attr(s.agent)+'">'+icon(s.agent)+'</span><span><strong>'+esc(s.task)+'</strong><br><span class="hint">'+esc(proj(s.project).name)+' / '+esc(providers[s.agent])+'</span></span></button>').join('');
  d.innerHTML='<div class="dialog-body notch-content"><div class="dialog-title"><div><span class="eyebrow">Route follow-up</span><h2>Which session?</h2></div><button aria-label="Close decision" class="icon-btn" data-action="close">'+icon('x')+'</button></div>'+ (suggested?'<p>These sessions match your capture.</p>':'')+'<div class="block">'+choices+'</div><form id="route-voice" class="field"><label for="route-answer">' +(live?'Reply':'Voice reply simulation')+'</label><input id="route-answer" placeholder="Project, session name, or choice number" required>'+(live?button('Hold to talk','dictate','#route-answer','text-btn','mic'):'')+'<button class="btn">Use reply</button></form></div>';
  d.showModal();$('#islandToggle').setAttribute('aria-expanded','true');
  if(draft)narrateRoute(draft,'session','Choose the conversation you mean.');
  $('#route-voice').onsubmit=e=>{e.preventDefault();const input=$('#route-answer'),v=input.value.trim().toLowerCase();const found=candidates.filter((s,i)=>[s.task,proj(s.project).name,String(i+1)].some(x=>x.toLowerCase()===v));if(found.length===1){chooseTarget(found[0].id);return}input.setCustomValidity('Enter one project name, task name, or choice number.');input.reportValidity();input.oninput=()=>input.setCustomValidity('')};
}
function chooseTarget(id){
  const s=sess(id);
  if(!draft || !s)return;
  if(live && !canNudge(s)){dismissCard();draft.candidates=[];draft.mode='nudge';routingPrompt();return}
  draft.session=id;draft.project=s.project;draft.mode='nudge';delete draft.runId;dismissCard();review();
}
function binaryControls(q){
  const buttons=q.choices.map((c,i)=>button(c,'decide',q.id+'|'+i,'decision-btn '+(c==='Yes'?'answer-yes':'answer-no'),c==='Yes'?'check':'x'));
  return '<div class="binary-choices">'+buttons.join('')+'</div>';
}
function discussionPanel(q){
  return '<form class="stack" id="discussion"><label class="field" for="comment">Reply<textarea id="comment" rows="3" required placeholder="Answer, ask a question, or add a detail…">'+esc(q.discussionDraft||'')+'</textarea></label>'+
    '<p class="reply-help">Your words go back to '+esc(providers[sess(q.session)?.agent]||'the agent')+' in this session.</p>'+
    '<div class="reply-actions">'+(live?button('Hold to talk','dictate','#comment','text-btn','mic'):'')+'<button class="btn primary">Send reply'+icon('arrow')+'</button>'+button('Back to question','notch',q.id,'text-btn')+'</div></form>';
}
function bindDiscussion(q){
  const form=$('#discussion'),input=$('#comment');
  input.focus();
  input.oninput=()=>{q.discussionDraft=input.value;input.setCustomValidity('');persist()};
  form.onsubmit=e=>{
    e.preventDefault();
    if(byId(state.decisions,q.id)!==q)return;
    const message=input.value.trim();
    if(!message){input.setCustomValidity('Enter a reply.');input.reportValidity();return}
    sendDecisionReply(q.id,message,'freeform');
  };
}
function showNotch(id,discuss=false){
  const d=$('#notch'),q=id?byId(state.decisions,id):state.decisions[0],s=q?sess(q.session):null;
  if(id&&!q){toast('This request has already closed.');return}
  let controls='';
  if(q && discuss)controls=discussionPanel(q);
  else if(q){
    controls=(q.kind==='binary'?binaryControls(q):'<div class="decision-choices">'+q.choices.map((c,i)=>button(c,'decide',q.id+'|'+i,'decision-btn')).join('')+'</div>')+
      '<div class="decision-reply">'+button('Reply','discuss',q.id,'text-btn discussion-link','mic')+'<span>Type or speak in your own words</span></div>';
  }
  const next=q && !discuss && state.decisions.length>1?button('Next request','notch',state.decisions[(state.decisions.indexOf(q)+1)%state.decisions.length].id,'text-btn','arrow'):'';
  d.innerHTML='<div class="dialog-body notch-content decision-sheet"><div class="dialog-title"><div><div class="decision-context">'+(q?'<span>'+icon('folder')+'<span>'+esc(proj(s.project)?.name)+'</span></span><span>'+icon(s.agent)+'<span>'+esc(providers[s.agent])+'</span></span>':'Workspace')+'</div><h2>'+(q?esc(s.task):'All clear')+'</h2></div><button data-action="close" class="icon-btn" aria-label="Close decision">'+icon('x')+'</button></div>'+
    (q?'<div class="stack decision-body">'+(state.decisions.length>1?'<p class="decision-count">Question '+(state.decisions.indexOf(q)+1)+' of '+state.decisions.length+'</p>':'')+'<h3>'+esc(q.q)+'</h3>'+(q.detail?'<p class="hint">'+esc(q.detail)+'</p>':'')+controls+next+'</div>':'<p>No sessions are waiting for a decision.</p>')+'</div>';
  d.dataset.request=q?.id||'';if(!d.open)d.showModal();$('#islandToggle').setAttribute('aria-expanded','true');
  if(discuss && q)bindDiscussion(q);
}
function decide(id,i){
  const q=byId(state.decisions,id);
  if(!q||!q.choices[i])return;
  sendDecisionReply(id,q.choices[i],'choice');
}
function sendDecisionReply(id,answer,answerKind){
  const q=byId(state.decisions,id);
  if(!q || typeof answer!=='string' || !answer.trim())return;
  const s=sess(q.session);
  (s.answeredDecisions??=[]).push({id:q.id,question:q.q,detail:q.detail,choices:q.choices,producerKey:q.producerKey,answer,answerKind,discussion:q.discussion||[]});
  s.log.push(answerKind==='choice'?'Decision received. '+answer+'.':'Reply sent. '+answer);
  state.decisions=state.decisions.filter(x=>x.id!==id);
  s.state=state.decisions.some(other=>other.session===s.id)?'Needs input':'Running';
  persist();dismissCard();render();
  if($('#modal').open&&openedSession===s.id&&$('#modal .session-detail'))showSession(s.id);
  if(q.producerKey)window.webkit?.messageHandlers?.workspace.postMessage({type:'questionUpdated'});
  toast('Reply sent to '+s.task+'.');
}
function captureDraft(target,sessionProject='',text=''){
  const s=sess(target);
  draft={sessionProject,text,brief:'',note:'',mode:s?'nudge':'ask',project:sessionProject||s?.project||(proj(view)?view:''),session:s?.id||'',agent:s?.agent||sessionModelPolicy().defaultAgent,viewer:'',strokes:[],newName:'',keep:false,hasVoice:false,sketch:false};
  captureContext.begin(draft);
}
function newDraft(target,sessionProject=''){
  if(live)postLive('refresh');
  captureDraft(target,sessionProject);
  editDraft();
}
function sketchMarkup(strokes){
  return '<svg class="sketch-view" viewBox="0 0 600 176" role="img" aria-label="Captured sketch">'+strokes.map(line=>'<polyline fill="none" stroke="#2b5147" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="'+line.map(p=>p.map(Number).join(',')).join(' ')+'"/>').join('')+'</svg>';
}
function growTranscript(input){
  input.style.height='auto';
  input.style.height=Math.min(input.scrollHeight,Math.max(160,window.innerHeight*.45))+'px';
}
function editDraft(){
  cancelRouting();stopRoutingSpeech();
  if(draft.quick){
    dialog('New capture','','<div class="quick-editor"><textarea id="transcript" aria-label="Your request" rows="3" placeholder="Speak or type a request…">'+esc(draft.text)+'</textarea><p id="capture-feedback" role="status"></p></div><div class="quick-actions">'+
      (live?button('Hold to talk','dictate','#transcript','btn','mic'):button('Use voice sample','sample','','btn','mic'))+button('Review','review','','primary','arrow')+'</div>');
    const field=$('#transcript'), review=$('#modal [data-action="review"]');
    const changed=()=>{draft.text=field.value;growTranscript(field);review.disabled=!draft.text.trim() && !draft.strokes.length};
    changed();field.oninput=changed;
    field.onkeydown=e=>{if(e.metaKey && e.key==='Enter' && !e.isComposing){e.preventDefault();if(!review.disabled)reviewDraft()}};
    field.focus({preventScroll:true});
    field.setSelectionRange(field.value.length,field.value.length);
    return;
  }
  const startingSession=draft.sessionProject && !draft.guide;
  dialog(startingSession?'New session':'New capture',draft.sessionProject?proj(draft.sessionProject).name:'Capture', '<div class="fields">'+captureContext.editor(draft)+'<label>'+(startingSession?'What should the agent do?':draft.guide==='start'?'Your request':'Transcript')+'<textarea id="transcript" placeholder="Talk through an idea or type a follow-up…">'+esc(draft.text)+'</textarea></label><div class="inline">'+(live?button('Hold to talk','dictate','#transcript','btn','mic'):button('Use voice sample','sample','','btn','mic'))+button(draft.sketch?'Hide sketch pad':'Add sketch','sketch','','btn','pen')+'</div>'+(draft.sketch?'<div class="field"><span>Sketch</span><canvas id="pad" width="600" height="176" class="drawpad" aria-label="Sketch pad. Use pointer to draw, or add the keyboard sample below."></canvas><div class="inline">'+button('Add sample curve','curve')+button('Clear sketch','clearink')+'</div></div>':'')+'</div><div class="form-actions">'+button('Cancel','discard')+button(startingSession?'Review session':'Review capture','review','','primary','arrow')+'</div>');
  $('#transcript').oninput=e=>{draft.text=e.target.value;growTranscript(e.target)};
  growTranscript($('#transcript'));
  if(draft.sketch)setupPad();
}
function setupPad(){
  const c=$('#pad'),g=c.getContext('2d');
  const draw=()=>{g.clearRect(0,0,c.width,c.height);g.lineWidth=3;g.strokeStyle='#2b5147';g.lineJoin='round';g.lineCap='round';for(const line of draft.strokes){g.beginPath();line.forEach(([x,y],i)=>i?g.lineTo(x,y):g.moveTo(x,y));g.stroke()}};
  const point=e=>{const r=c.getBoundingClientRect();return [(e.clientX-r.left)*c.width/r.width,(e.clientY-r.top)*c.height/r.height]};
  let pointer=null;c.onpointerdown=e=>{pointer=e.pointerId;c.setPointerCapture(pointer);const start=point(e);draft.strokes.push([start,[start[0]+.1,start[1]+.1]]);draw()};c.onpointermove=e=>{if(e.pointerId===pointer){draft.strokes.at(-1).push(point(e));draw()}};c.onpointerup=c.onpointercancel=()=>{pointer=null};draw();
}
function matchProjects(t){
  const normalized=value=>value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const words=' '+normalized(t)+' ';
  return state.projects.filter(p=>p.available!==false && [p.name,...(p.aliases||[])].some(a=>a && words.includes(' '+normalized(a)+' ')));
}
function matchSessions(t){
  const words=t.toLowerCase().match(/[a-z]+/g)||[];
  const stop=new Set(['the','for','and','with','session','working','make','that','this','tell','please','ask','check','sure','agent','about','build','implement','finish','continue','update','also','should','would','could','from','what','file','project','there','then','them']);
  return state.sessions.filter(s=>[...(s.task.toLowerCase().match(/[a-z]+/g)||[]),...(s.topics||[])].some(w=>w.length>2&&!stop.has(w)&&words.includes(w))&&(!live?s.state!=='Complete':canNudge(s)));
}
function interpret(){
  const d=draft,t=d.text.trim(),ps=matchProjects(t),ss=matchSessions(t);
  d.brief=t;d.note='';d.keep=false;d.candidates=[];delete d.suggestedBrief;
  const shorthand=/^(?:(?:yes|ok(?:ay)?|please|now)[\s,.!]+)*(?:(?:build|implement|fix|do|ship|finish|try|change|apply) (?:it|this|that|the plan)|(?:go ahead|continue|carry on))\s*(?:please)?[.!?]*$/i.test(t) || /\b(?:where (?:we|you) left off|(?:continue|pick up|resume) (?:from )?(?:our|the|your) (?:previous|last|earlier) (?:session|conversation|work|plan))\b/i.test(t);
  const filing=/(?:^|[.!?,]\s*|\b(?:please|can you|could you)\s+)(?:remember\b|jot\b.{0,20}\bdown\b|(?:save|keep|write|add|make)\s+(?:(?:this|that|a|the|an)\s+)?(?:as\s+a\s+)?(?:note|sketch|idea)\b|note\s+(?:that|for)\b|idea\s+for\b)/i.test(t);
  const instruction=/\b(?:ask (?:claude(?: code)?|codex|antigravity|agy|cursor(?: cli| agent)?|pi(?:code| coding agent)?)|tell (?:[^.!?]*?\b)?(?:session|agent)|nudge|follow up)\b/i.exec(t);
  if(!d.session && (!d.sessionProject || d.guide==='start'))d.mode=instruction?(/^(tell|nudge|follow)/i.test(instruction[0])?'nudge':'ask'):filing||!t?'note':'ask';
  if(!d.session && shorthand && !d.strokes.length)d.mode='nudge';
  d.explicitMode=!!(instruction || filing || shorthand || d.sessionProject);
  if(instruction){
    const before=t.slice(0,instruction.index).trim(), work=t.slice(instruction.index);
    if(/\b(remember|note|save|idea)\b/i.test(before)){
      d.note=before;d.keep=true;
    }
    // Preserve constraints after the instruction. Keep preceding context in the handoff
    // unless it was captured separately as a note or solely names the workspace.
    if(d.mode==='ask' && (d.keep || !before || /^for [^,.]+[,.:]?$/i.test(before))){
      d.brief=work.replace(/^ask (?:claude(?: code)?|codex|antigravity|agy|cursor(?: cli| agent)?|pi(?:code| coding agent)?)\s+(?:to\s+)?/i,'').trim();
      if(/^(where|how|whether|why)\b/i.test(d.brief))d.brief='Find '+d.brief;
      d.brief=d.brief.charAt(0).toUpperCase()+d.brief.slice(1);
    }
  }
  if(!d.session && (!d.project || d.suggestedProject) && ps.length===1)d.project=ps[0].id;
  if(d.suggestedProject && ps.length>1)d.project='';
  if(!d.session && /\bask (claude|codex|antigravity|agy|cursor|pi|picode)\b/i.test(t))d.mode='ask';
  if(d.mode==='nudge'&&!d.session){
    // A suggested first-run folder is not evidence about an existing conversation.
    if(d.suggestedProject && !ps.length)d.project='';
    const choices=d.project?ss.filter(s=>s.project===d.project):ss;
    if(!shorthand && choices.length===1){d.session=choices[0].id;d.project=choices[0].project}
    else if(choices.length && !shorthand)d.candidates=choices.map(s=>s.id);
  }
  const worker=/\b(?:ask|use|using|with|via|send to|hand (?:it |this )?to|run (?:it |this )?in)\s+(claude(?: code)?|codex|antigravity|agy|cursor(?: cli| agent)?|pi(?:code| coding agent)?)\b/i.exec(t) || /^\s*(claude(?: code)?|codex|antigravity|agy|cursor(?: cli| agent)?|pi(?:code| coding agent)?)\s*[:,]/i.exec(t);
  if(d.agentChoice!=='manual'){
    const id=worker && worker[1].toLowerCase();
    d.agentChoice=id?'named':'';
    d.agent=id?.startsWith('cursor')?'cursor-agent':id?.startsWith('pi')?'pi':id?.startsWith('claude')?'claude':id==='codex'?'codex':id?'agy':sessionModelPolicy().defaultAgent;
  }
  const viewer=/\b(?:in|with|using|via|to)\s+(?:apple |the )?(xcode|preview|finder)\b/i.exec(t);if(viewer)d.viewer=['Xcode','Preview','Finder'].find(app=>app.toLowerCase()===viewer[1].toLowerCase());
}
function routingPrompt(){
  const d=draft;
  if(d.mode==='note'&&!d.project)d.project='@scratch';
  if(d.mode==='nudge'&&!d.session && d.candidates?.length){
    routeDecision(d.candidates.map(sess));return;
  }
  if(d.mode==='nudge'&&!d.session){
    const available=state.sessions.filter(s=>(live?canNudge(s):s.state!=='Complete') && (!d.project||d.project===s.project));
    if(available.length){routeDecision(available,false);return}
    dialog('What should the agent work on?','Follow-up','<p>No available session matches this follow-up. Describe the task to start a new session.</p><div class="form-actions">'+button('Dismiss','discard')+button('Edit request','edit','','primary','pen')+'</div>');
    return;
  }
  if(!d.project){
    const projects=state.projects.filter(p=>p.available!==false);
    dialog('Which workspace?', 'Tasktap','<label class="field">Find a project<input id="route-filter" type="search" placeholder="Folder name"></label><div class="route-list" id="route-list"></div><div class="inline">'+button('Keep in scratch','route-project','@scratch')+button('New workspace…','route-project','@new')+'</div>'+continueSessionButton(d));
    const field=$('#route-filter');
    const filter=()=>{$('#route-list').innerHTML=projects.filter(p=>p.name.toLowerCase().includes(field.value.toLowerCase())).map(p=>button(p.name,'route-project',p.id)).join('')||'<p class="empty">No matching projects.</p>'};
    field.oninput=filter;filter();
    narrateRoute(d,'destination','Choose a workspace for this task.');
    return;
  }
  review();
}
function continuations(d){
  return state.sessions.filter(s=>(!d.project || s.project===d.project) && (live?canNudge(s):s.state!=='Complete'));
}
function continueSessionButton(d){
  return d.mode==='ask' && continuations(d).length?button('Continue an existing session','continue-session','','text-btn'):'';
}
function review(){
  const d=draft;if(!d)return;
  const peers=d.mode==='note'?[]:projectPeers(d.project,d.mode==='nudge'?d.session:d.runId);
  d.peerTasks=peers.slice(0,8).map(p=>({agent:providers[p.agent],task:(p.task||'').slice(0,112),state:p.state}));
  if(d.mode==='ask')workerRouting.prepare(d);else{d.noPick=false;d.usingRank=false}
  if(d.mode!=='note')d.captureId??=uid();
  handoffReview.show(d,peers);
  reviewActivity(d);
}
function adjustReview(){handoffReview.destination()}
function reviewDraft(){
  if(recording && draft.quick && recording.target==='#transcript'){
    if(['recording','finishing','processing'].includes(recording.phase)){
      recording.reviewAfter=true;
      finishDictation(recording.owner);
      return;
    }
    stopDictation();
  }
  if(recording){toast('Finish dictation before reviewing.');return}
  if(!draft.text.trim()&&!draft.strokes.length){toast('Add text or a sketch to continue.');$('#transcript').focus();return}
  if(!draft.session && !draft.strokes.length && /^(?:(?:well|um+|uh+|oh|okay|ok|h[ei]y|hi|hello|hallo|hey there|testing|test|mic check|thank you|thanks|good (?:morning|evening))[\s,.!?]*)+$/i.test(draft.text.trim())){dialog('What would you like to do?','Capture',button(draft.hasVoice?'Edit request':'Keep typing','continue-capture','','primary',draft.hasVoice?'mic':'pen')+button('Dismiss','discard'));return}
  interpret();
  captureContext.resolve(draft,()=>{if(live)prepareHandoff();else routingPrompt()});
}
function commitCapture(){
  const d=draft;if(!d)return;
  if(live){submitLive(d);return}
  if(d.project==='@new'){
    const name=d.newName.trim();if(!name||name==='.'||name==='..'){toast('Choose a project name.');return}
    const existing=state.projects.find(p=>p.name.toLowerCase()===name.toLowerCase());
    if(existing){d.project=existing.id}else{const p={id:uid(),name,folder:workspaceSettings.newFolder(name),color:'#a8c3ae',aliases:[]};state.projects.push(p);d.project=p.id}
  }
  const cid=d.captureId||uid(),time=new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}),c={id:cid,time,text:d.text,brief:captureContext.brief(d),reference:d.reference,project:d.project==='@scratch'?'':d.project,strokes:d.strokes,duration:d.hasVoice?'Sample':'Text',receipt:'Saved',kind:'Note'};
  let s;
  if(d.mode==='ask'){s={id:uid(),project:d.project,agent:d.agent,task:d.brief.trim().slice(0,78)||'Review sketch',state:'Running',model:modelPlanFor(d).model,log:['Session started. '+d.brief],viewer:d.viewer,capture:cid};state.sessions.unshift(s);c.kind='Agent question';c.receipt='Started';c.session=s.id}
  if(d.mode==='nudge'){s=sess(d.session);if(!s){toast('Choose an available session.');return}c.project=s.project;c.kind='Session nudge';c.receipt='Queued';c.session=s.id;s.log.push('Nudge queued. '+d.brief)}
  if(d.mode==='note'||d.keep){const text=d.mode==='note'?captureContext.brief(d):d.note;state.notes.unshift({id:uid(),project:c.project,text,title:text.trim().slice(0,64)||'Sketch',capture:cid})}
  state.captures.unshift(c);draft=null;persist();dismissCard();render();
  if(s && firstMode() && !pending()){
    peekHandoff(cid);
    if(d.mode==='nudge')setTimeout(()=>deliver(cid),1400);
    return;
  }
  if(d.mode==='nudge'){toast('Nudge queued for '+s.task+'.');setTimeout(()=>deliver(cid),1400)}
  else if(d.mode==='ask'){showSession(s.id)}else{if(!document.body.classList.contains('notch-first'))go('notes');toast('Note saved.')}
}
function deliver(id){
  const c=byId(state.captures,id),s=c&&sess(c.session);if(!s||c.receipt!=='Queued')return;
  c.receipt='Delivered';s.log.push('Nudge delivered. '+c.brief);if(s.state==='Complete'){s.state='Running';delete s.result}
  persist();render();if($('#modal').open&&openedSession===s.id&&$('#modal .session-detail'))showSession(s.id);
  if($('#modal').open&&$('#receipt')?.dataset.capture===id)detailCapture(id);
  toast('Nudge delivered to '+s.task+'.');
}
function detailCapture(id){
  const c=byId(state.captures,id);if(!c)return;
  if(firstMode())showWorkspace();
  const session=sess(c.session), request=c.brief || c.text || 'Sketch', project=proj(c.project)?.name || 'Scratch';
  const latest=state.captures.find(turn=>turn.session===c.session && turn.receipt==='Complete');
  const result=c.result || (session && c.receipt==='Complete' && latest?.id===id?session.result:'');
  const original=c.text?.trim() && c.text.trim()!==request.trim()?'<details class="route-evidence"><summary>Original wording</summary><p class="body-copy">'+esc(c.text)+'</p></details>':'';
  const title=c.kind==='Note'?'Saved note':c.kind==='Session nudge'?'Follow-up':'Request';
  dialog(title,[project,providers[session?.agent]].filter(Boolean).join(' / '),
    '<div class="detail-line"><span id="receipt" data-capture="'+attr(id)+'" class="badge">'+esc(c.receipt)+'</span></div><p class="body-copy review-brief">'+esc(request)+'</p>'+
    (c.strokes?.length?sketchMarkup(c.strokes):'')+(result?resultPresentation.markup(result,c.result?c.id:session.id):'')+
    original+(session?button('Open session','session',c.session,'primary','out'):''));
  resultPresentation.paint($('#modal'));
}
function showNote(id){
  const n=byId(state.notes,id),c=n.capture&&byId(state.captures,n.capture);
  dialog(n.title,proj(n.project)?.name||'Scratch','<article class="note-reader"><p class="body-copy">'+esc(n.text)+'</p></article>'+(c?.strokes?.length?sketchMarkup(c.strokes):'')+(c?button('View original capture','detailcapture',c.id):'')+(!n.project?'<form id="assign" class="fields"><label>Assign to project<select id="assign-project" required>'+option('','Choose project')+state.projects.map(p=>option(p.id,p.name)).join('')+'</select></label><button class="primary">Move note</button></form>':''));
  const f=$('#assign');if(f)f.onsubmit=e=>{e.preventDefault();const project=$('#assign-project').value;if(live){postLive('assign-note',{id,capture:n.capture,folder:proj(project).folder});return}noteAssigned(id,project)};
}
function noteAssigned(id,project){const n=byId(state.notes,id);if(!n)return;n.project=project;persist();render();showNote(id);toast('Note assigned to '+proj(project).name+'.')}
const preferenceGroups={agents:'Agents',workspaces:'Workspaces',capture:'Capture',voice:'Voice & alerts',appearance:'Appearance'};
function prefs(group='agents'){
  if(!Object.hasOwn(preferenceGroups,group))group='agents';
  const nav='<nav class="preference-groups" aria-label="Preferences categories">'+Object.entries(preferenceGroups).map(([id,label])=>
    '<button type="button" data-action="prefs-group" data-id="'+id+'" aria-pressed="'+(group===id)+'">'+esc(label)+'</button>').join('')+'</nav>';
  let body;
  if(group==='agents'){
    const policy=sessionModelPolicy(),profile=policy.agents[policy.defaultAgent];
    const summary=[providers[policy.defaultAgent],policy.adaptive?'Difficulty curve':profile.fixed,terminalHosts.label(state.sessionHost)].filter(Boolean).join(' / ');
    body='<h3>Tasktap</h3>'+aiConnections.jump()+'<h3>Project work</h3>'+(live?'<button id="agent-setup-link" type="button" class="settings-jump" data-action="agent-setup"><span class="jump-mark">'+icon('settings')+'</span><span><strong>Agent setup</strong><small hidden></small></span>'+icon('right')+'</button>':'')+
      '<button class="settings-jump" type="button" data-action="session-models" aria-label="Session models"><span class="jump-mark">'+icon('sessions')+'</span><span><strong>Session models</strong><small>'+esc(summary)+'</small></span>'+icon('right')+'</button>'+(live?workerRouting.jump():'');
  }else if(group==='workspaces'){
    body=workspaceSettings.markup();
  }else if(group==='capture'){
    body=captureContext.preference()+
      (live?surfaceButton('Reopen guided capture','guide-replay','pen','btn'):button('Reset sample data','reset','','text-btn'));
  }else if(group==='appearance'){
    const themes=TasktapArt.catalog.map(theme=>'<option value="'+attr(theme.id)+'" data-art="'+attr(theme.id)+'" data-detail="'+attr(theme.medium)+'" '+(TasktapArt.current()===theme.id?'selected':'')+'>'+esc(theme.name)+'</option>').join('');
    body=appAppearance.markup()+settingsField('visual-theme','Artwork','<select id="visual-theme">'+themes+'</select>');
  }else{
    body=settingsField('voice-engine','Narration voice','<select id="voice-engine"></select>')+
      (live?'<div class="voice-tools"><p id="voice-status" class="hint" role="status">'+esc(kokoro.detail)+'</p><div class="inline">'+button('Set up Kokoro','setup-voice')+button('Preview voice','preview-voice')+'</div></div>':'')+
      '<div class="check-line"><input id="narration" type="checkbox" '+(state.speak?'checked':'')+'><label for="narration">Read completion summaries aloud</label></div>'+
      surfaceButton('Notification settings','notifications','bell','btn');
  }
  dialog('Preferences','Tasktap','<div id="preferences" class="settings-form">'+nav+'<section aria-label="'+preferenceGroups[group]+'" class="settings-section">'+body+'</section>'+appUpdates.preferences()+'<div class="preference-links">'+button('Run setup…','run-setup','','text-btn','settings')+(live?button('Check for Updates…','check-updates','','text-btn'):'')+button('Documentation','open-docs',group,'text-btn','out')+'</div></div>');
  settingsHeader();
  const categories=$('#preferences .preference-groups'),activeCategory=categories.querySelector('[aria-pressed=true]');
  categories.scrollLeft=Math.max(0,activeCategory.offsetLeft+(activeCategory.offsetWidth-categories.clientWidth)/2);
  if(group==='agents' && live)aiConnections.refresh();
  if(group==='capture')captureContext.bindPreference();
  if(group==='workspaces')workspaceSettings.bind();
  if(group==='appearance'){appAppearance.bind();$('#visual-theme').onchange=e=>TasktapArt.select(e.target.value)}
  if(group==='voice'){
    voiceOptions();routingVoicePreference();
    if(live){updateKokoro(kokoro.status,kokoro.detail);postLive('check-kokoro')}
    $('#voice-engine').onchange=e=>{state.voiceEngine=e.target.value;persist()};
    $('#narration').onchange=e=>{state.speak=e.target.checked;persist()};
  }
  settingsPickers.mount($('#preferences'));
}
function complete(id){const s=sess(id);if(s.state!=='Running')return;s.state='Complete';s.result='Demo result: the agent finished the requested review in '+proj(s.project).name+'. Open the conversation to inspect its work.';s.log.push('Simulated completion received.');persist();render();showSession(id);if(state.speak)speak(s.result)}
function startSample(){
  const b=$('[data-action="sample"]');b.textContent='Listening to sample…';b.disabled=true;clearTimeout(simVoice);
  simVoice=setTimeout(()=>{simVoice=null;document.dispatchEvent(new Event('voice-activity'));if(!draft||!$('#transcript'))return;draft.text=(draft.text.trim()?draft.text+' ':'')+mixed;draft.hasVoice=true;editDraft();$('#transcript').focus();toast('Sample transcript ready.')},650);document.dispatchEvent(new Event('voice-activity'));
}
document.addEventListener('click',e=>{
  const el=e.target.closest('[data-action]');if(!el)return;const a=el.dataset.action,id=el.dataset.id;
  switch(a){
    case 'view':go(id);break;case 'capture':newDraft('');break;case 'menu':if(typeof workspaceNavigation!=='undefined')workspaceNavigation.toggle();else document.body.classList.toggle('nav-open');break;
    case 'run-setup':setupWizard.open('preferences');break;
    case 'prefs-group':prefs(id);$('#preferences [aria-pressed=true]').focus({preventScroll:true});break;
    case 'start-session':newDraft('',id);break;case 'follow':newDraft(id);break;case 'session':if(sess(id)?.host==='tasktap' && typeof workspaceDeck!=='undefined')workspaceDeck.open('terminal:'+id,sess(id).project);else showSession(id);break;case 'close':dismissCard();break;case 'prefs':prefs();break;case 'session-models':sessionModelSettings();break;case 'ai-connections':aiConnections.show();break;
    case 'speakresult':speak(sess(id).result);break;
    case 'openchat':postLive('open-desktop-chat',{id:sess(id).conversation});break;
    case 'setup-voice':postLive('install-kokoro');break;
    case 'worker-routing':workerRouting.settings();break;
    case 'agent-setup':if(live)aiConnections.setup();break;
    case 'worker-install':case 'worker-login':if(live && Object.hasOwn(providers,id))postLive(a,{agent:id});break;
    case 'preview-voice':speak('Tasktap is ready. What would you like to work on?');break;
    case 'terminal':postLive('resume-terminal',{id});break;
    case 'check-updates':if(live)postLive('check-updates');break;
    case 'open-docs':{const section=({agents:'agents',capture:'capture',voice:'voice',appearance:'appearance',workspaces:'workspaces'})[id]||'install';if(live)postLive('open-docs',{section});else window.open('https://harzerheribert.github.io/Tasktap/docs/#'+section,'_blank','noopener');break}
    case 'focus-session':if(sess(id)?.host==='tasktap')workspaceDeck.open('terminal:'+id,sess(id).project);else postLive('focus-session',{id});break;
    case 'reopen-session':postLive('reopen-session',{id});break;
    case 'review-retry':{const c=failedStart(sess(id));if(c)postLive('review-failed-handoff',{session:id,capture:c.id});break}
    case 'copyresume':postLive('copy-resume',{id});break;
    case 'openresult':if(sess(id)?.host==='tasktap'){workspaceDeck.openResult(id);dismissCard();break}if(live){const s=sess(id);postLive('open-result',{id,viewer:s.viewer||'Finder',text:s.result||''});break}dialog('Result preview',sess(id).viewer||'Editor','<p>'+esc(sess(id).result)+'</p><p class="hint">Opening an external app is simulated here.</p>'+button('Back to session','session',id));break;
    case 'detailcapture':detailCapture(id);break;case 'note':showNote(id);break;case 'sample':startSample();break;
    case 'sketch':draft.sketch=!draft.sketch;editDraft();break;
    case 'curve':draft.strokes.push(Array.from({length:70},(_,i)=>[38+i*7.2,30+Math.pow(i/69,2)*112]));setupPad();break;
    case 'clearink':draft.strokes=[];setupPad();break;case 'discard':draft=null;dismissCard();break;
    case 'review':reviewDraft();break;
    case 'skip-routing':cancelRouting();stopRoutingSpeech();routingPrompt();break;case 'adjust':adjustReview();break;
    case 'route-project':draft.project=id;delete draft.contextProject;if(id==='@new'){
      dialog('Name the workspace','Tasktap','<form id="workspace-name" class="field"><label>Workspace name<input id="newName" required></label><button class="primary">Review</button></form>');
      $('#workspace-name').onsubmit=e=>{e.preventDefault();const name=$('#newName').value.trim();if(!name||name.includes('/')||name==='.'||name==='..'){toast('Choose a folder name.');return}draft.newName=name;review()};
    }else review();break;
    case 'commit-review':if(draft?.mode==='ask' && live && !workerRouting.canStart(draft))break;commitCapture();break;
    case 'apply-suggested-brief':if(draft?.suggestedBrief){draft.brief=draft.suggestedBrief;delete draft.suggestedBrief;review()}break;
    case 'continue-capture':draft.text='';editDraft();$('#transcript').focus();break;
    case 'edit':editDraft();break;case 'notch':showNotch(id);break;
    case 'continue-session':{const choices=continuations(draft);if(choices.length)routeDecision(choices,false);else toast('No available session in this workspace.');break}
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
$('#islandToggle').onclick=()=>showNotch();
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
  ].map(s=>sessionRow(s,{fixture:true})).join('')+'</div>';
}

function prepareForAppUpdate(){
  if(typeof recording!=='undefined' && recording || draft?.routing || draft?.submitting || setupWizard.showing() || document.querySelector('#guide-input')?.value?.trim())return false;
  if(document.querySelector('#review-task-form,#route-form,#review-context-form'))return false;
  try{if(draft)localStorage.setItem('tasktap-update-draft',JSON.stringify({text:draft.brief||draft.text||'',project:draft.project||'',strokes:draft.strokes||[]}));persist();return true}catch{return false}
}
const recoveredUpdateDraft=localStorage.getItem('tasktap-update-draft');
if(recoveredUpdateDraft){
  try{const saved=JSON.parse(recoveredUpdateDraft);if(saved.text || saved.strokes?.length){setTimeout(()=>{captureDraft('',proj(saved.project)?saved.project:'',saved.text);draft.strokes=saved.strokes||[];draft.sketch=!!draft.strokes.length;editDraft();localStorage.removeItem('tasktap-update-draft')},1200)}}catch{}
}
