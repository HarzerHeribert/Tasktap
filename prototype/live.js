// Loaded before app.js. Browser previews and the isolated native fixture keep their sample store.
const live=!!window.webkit?.messageHandlers?.workspace && !window.fixtureMode;
const emptyState=()=>({projects:[],sessions:[],captures:[],notes:[],decisions:[],speak:false});
const postLive=(type,data={})=>window.webkit.messageHandlers.workspace.postMessage({type,...data});
let recording=null;
function projectsDiscovered(rows){
  for(const row of rows){
    let p=state.projects.find(p=>p.folder===row.folder);
    if(!p){p={id:row.folder,color:'#a8c3ae'};state.projects.push(p)}
    Object.assign(p,row,{available:true,aliases:[row.name.replace(/[-_]+/g,' ')]});
  }
  for(const p of state.projects){if(!rows.some(r=>r.folder===p.folder))p.available=false}
  persist();render();
}
function externalSessions(rows){
  for(const s of state.sessions.filter(s=>s.external))s.available=rows.some(r=>r.id===s.id);
  for(const row of rows){
    const project=state.projects.find(p=>p.folder===row.folder);
    if(!project)continue;
    let s=sess(row.id);
    if(!s){s={id:row.id,external:true,log:[],state:'Connected'};state.sessions.push(s)}
    Object.assign(s,{agent:row.agent,task:row.task,project:project.id,available:true});
  }
  for(const s of state.sessions.filter(s=>s.external && !['Queued','Running'].includes(s.state)))s.state=s.available?'Connected':'Unavailable';
  persist();render();
}
const canNudge=s=>s && (s.managed || (s.external && s.available));
function submitLive(d){
  if(d.submitting)return;
  const prior=sess(d.session);
  const p=proj(d.project);
  if(d.mode==='nudge'&&!canNudge(prior)){toast('Select an available session to send a follow-up.');return}
  const create=d.project==='@new';
  const folder=create?'~/projects/'+d.newName:d.project==='@scratch'?'@scratch':p?.folder;
  if(!folder){toast('Choose a workspace first.');return}
  d.captureId??=uid();d.runId??=d.mode==='nudge' && prior?prior.id:uid();
  const job={session:d.runId,capture:d.captureId,task:(d.mode==='nudge' && prior?.task)||d.brief.slice(0,78)||'Review sketch',agent:(d.mode==='nudge' && prior?.agent)||d.agent,folder,
    external:d.mode==='nudge' && !!prior?.external,brief:d.brief,strokes:d.strokes,note:d.mode==='note'?d.brief:d.note||d.brief,mode:d.mode,keep:d.keep,create};
  d.submitting=true;postLive('enqueue',{job});
}
function acceptLive(data){
  const d=draft;
  if(!d||d.captureId!==data.capture)return;
  d.submitting=false;
  if(data.error){toast(data.error);return}
  let p=state.projects.find(p=>p.folder===data.folder);
  if(!p && d.project!=='@scratch'){p={id:data.folder,name:data.name,folder:data.folder,aliases:[],color:'#a8c3ae'};state.projects.push(p)}
  const c={id:d.captureId,time:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),text:d.text,brief:d.brief,strokes:d.strokes,project:d.project==='@scratch'?'@scratch':p?.id||'',duration:d.hasVoice?'Voice':'Text',
    receipt:d.mode==='note'?'Saved':'Queued',kind:{ask:'Agent question',nudge:'Session nudge',note:'Note'}[d.mode]};
  if(d.mode!=='note'){
    c.session=d.runId;
    let s=sess(d.runId);
    if(!s){s={id:d.runId,managed:true,task:data.task,project:c.project,agent:d.agent,viewer:d.viewer,capture:c.id,log:[],producerKey:JSON.stringify([d.agent,data.folder,d.runId])};state.sessions.unshift(s)}
    s.state='Queued';s.log.push('Queued. '+d.brief);
  }
  if(d.mode==='note'||d.keep){const text=d.mode==='note'?d.brief:d.note||d.brief;state.notes.unshift({id:uid(),project:c.project==='@scratch'?'':c.project,text,title:text.slice(0,64)||'Sketch',capture:c.id})}
  state.captures.unshift(c);draft=null;persist();close();render();toast(c.receipt+'. '+data.name);
}
function agentReceipt(e){
  let c=byId(state.captures,e.capture),s=sess(e.session);
  if(!s && e.folder){
    const p=e.scratch==='true'?scratchProject:state.projects.find(p=>p.folder===e.folder)||{id:e.folder,folder:e.folder,name:e.folder.split('/').pop(),aliases:[]};
    if(!proj(p.id))state.projects.push(p);
    s={id:e.session,managed:e.external!=='true',external:e.external==='true',project:p.id,agent:e.agent,task:e.task,log:[],producerKey:JSON.stringify([e.agent,e.folder,e.session])};state.sessions.unshift(s);
  }
  if(!c && s){c={id:e.capture,session:s.id,project:s.project,brief:e.brief,text:e.brief,receipt:'Queued',kind:e.mode==='nudge'?'Session nudge':'Agent question',time:'',strokes:[]};state.captures.unshift(c)}
  if(!c||!s||c.receipt===e.state)return;
  c.receipt=e.state;s.log.push(e.state+(e.message?'. '+e.message:''));
  if(e.state==='Complete')s.result=e.message;
  const outstanding=state.captures.filter(c=>c.session===s.id && ['Queued','Running'].includes(c.receipt));
  s.state=state.decisions.some(q=>q.session===s.id)?'Needs input':outstanding.length?'Running':e.state;
  if(e.state==='Complete' && state.speak && !e.recovered)speak(e.message);
  persist();render();
  if($('#modal').open && $('#dialog-heading')?.textContent===s.task)showSession(s.id);
}
function prepareHandoff(){
  const d=draft;
  if(!d.text.trim() || d.session || d.candidates?.length || (d.project && /^(ask |tell |remember |note )/i.test(d.text.trim()))){routingPrompt();return}
  const projects=state.projects.filter(p=>p.available!==false).slice(0,80);
  const sessions=state.sessions.filter(canNudge).slice(0,45);
  const id=uid();
  d.routing={id,projects,sessions};
  dialog('Preparing handoff','Tasktap','<p class="hint">Finding the workspace and preparing your brief…</p>'+button('Review now','skip-routing'));
  postLive('route',{id,input:{capture:d.text.slice(0,9000),projects:projects.map((p,i)=>[i,p.name]),sessions:sessions.map((s,i)=>[i,s.task,proj(s.project)?.name,s.agent])}});
}
function finishRouting(id,r){
  const pending=draft?.routing;
  if(!pending || id!==pending.id || !$('#modal').open)return;
  delete draft.routing;
  const d=draft;
  if(['ask','note','nudge'].includes(r.mode) && typeof r.brief==='string' && r.brief.trim()){
    d.mode=r.mode;d.brief=r.brief.trim();
    if(!d.project && Number.isInteger(r.project))d.project=pending.projects[r.project]?.id||'';
    if(d.mode==='nudge' && Number.isInteger(r.session)){
      const s=pending.sessions[r.session];
      if(s && (!d.project || d.project===s.project)){d.session=s.id;d.project=s.project}
    }
    if(['claude','codex','agy'].includes(r.agent))d.agent=r.agent;
    const projectName=proj(d.project)?.name;
    if(projectName && d.text.toLowerCase().includes(projectName.toLowerCase()) && !d.brief.toLowerCase().includes(projectName.toLowerCase()))d.brief=d.text.trim();
    if(d.mode!=='note' && typeof r.note==='string' && r.note.trim()){d.keep=true;d.note=r.note.trim()}
  }
  routingPrompt();
}
function dictate(target){
  if(recording){
    if(recording.phase==='recording' && recording.target===target)postLive('dictation-finish',{id:recording.id});
    return;
  }
  const input=$(target);
  if(!input)return;
  recording={id:uid(),target,input,phase:'starting'};
  postLive('dictation-start',{id:recording.id});
}
function stopDictation(){
  if(recording){postLive('dictation-cancel');recording=null}
}
function dictationEvent(id,phase,text){
  if(recording?.id!==id)return;
  const {target,input}=recording;
  if(!input.isConnected){stopDictation();return}
  recording.phase=phase;
  const control=document.querySelector('[data-action="dictate"][data-id="'+target+'"]');
  if(control)control.textContent=phase==='recording'?'Finish dictation':phase==='processing'?'Transcribing…':'Dictate';
  if(phase==='text'){input.value=[input.value.trim(),text].filter(Boolean).join(' ');input.dispatchEvent(new Event('input'));if(target==='#transcript'&&draft)draft.hasVoice=true}
  if(phase==='error')toast(text);
  if(phase==='text'||phase==='error')recording=null;
}
