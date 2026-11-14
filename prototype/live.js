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
  const seen=new Set();
  const pendingTurns=new Set(state.captures.filter(c=>['Queued','Running'].includes(c.receipt)).map(c=>c.session));
  const managed=new Set(state.sessions.filter(s=>s.managed).map(s=>s.id));
  for(const row of rows){
    if(managed.has(row.conversation) || managed.has(row.id))continue;
    const project=state.projects.find(p=>p.folder===row.folder);
    if(!project)continue;
    let s=sess(row.id);
    if(!s){s={id:row.id,external:true,log:[]};state.sessions.push(s)}
    Object.assign(s,{agent:row.agent,task:row.task,project:project.id,available:true,source:row.source||'cmux',
      conversation:row.conversation,waitingFor:row.waitingFor||''});
    if(!pendingTurns.has(s.id))s.state=row.state||'Connected';
    seen.add(s.id);
  }
  for(const s of state.sessions){
    if(!s.external || seen.has(s.id))continue;
    s.available=false;s.waitingFor='';
    if(!pendingTurns.has(s.id))s.state='Unavailable';
  }
  persist();render();
}
const canNudge=s=>s && (s.managed || (s.external && s.available && s.source==='cmux'));
function reviewReceipt(d,phase,label){
  if(d.mode==='note')return;
  d.relayPhase=phase;
  handoffRelay.event(d.captureId,phase);
  const rail=$('#modal .review-rail tasktap-relay');
  if(rail?.dataset.capture===d.captureId){
    rail.dataset.phase=phase;
    $('#modal [data-relay-label]').textContent=label;
  }
}
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
    external:d.mode==='nudge' && !!prior?.external,brief:captureContext.brief(d),reference:d.reference,strokes:d.strokes,note:d.mode==='note'?captureContext.brief(d):d.note||d.brief,mode:d.mode,keep:d.keep,create};
  if(d.mode==='ask')job.model=modelPlanFor(d).model;
  d.submitting=true;
  reviewReceipt(d,'submitting','Submitting handoff');
  postLive('enqueue',{job});
}
function acceptLive(data){
  const d=draft;
  if(!d||d.captureId!==data.capture)return;
  d.submitting=false;
  if(data.error){reviewReceipt(d,'failed','Handoff failed');toast(data.error);return}
  const existing=byId(state.captures,d.captureId);
  const receiptState=existing?.receipt || (d.mode==='note'?'Saved':'Queued');
  if(d.mode!=='note')handoffRelay.event(d.captureId,receiptState.toLowerCase());
  let p=state.projects.find(p=>p.folder===data.folder);
  if(!p && d.project!=='@scratch'){p={id:data.folder,name:data.name,folder:data.folder,aliases:[],color:'#a8c3ae'};state.projects.push(p)}
  const c={id:d.captureId,time:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),text:d.text,brief:captureContext.brief(d),reference:d.reference,strokes:d.strokes,project:d.project==='@scratch'?'@scratch':p?.id||'',duration:d.hasVoice?'Voice':'Text',
    receipt:receiptState,kind:{ask:'Agent question',nudge:'Session nudge',note:'Note'}[d.mode]};
  if(d.mode==='nudge' && sess(d.runId)?.external)c.external=true;
  if(d.mode!=='note'){
    c.session=d.runId;
    let s=sess(d.runId);
    if(!s){s={id:d.runId,managed:true,model:modelPlanFor(d).model,task:data.task,project:c.project,agent:d.agent,viewer:d.viewer,capture:c.id,log:[],producerKey:JSON.stringify([d.agent,data.folder,d.runId])};state.sessions.unshift(s)}
    if(!existing){s.state='Queued';s.log.push('Queued. '+d.brief)}
  }
  if(d.mode==='note'||d.keep){const text=d.mode==='note'?captureContext.brief(d):d.note||d.brief;state.notes.unshift({id:uid(),project:c.project==='@scratch'?'':c.project,text,title:text.slice(0,64)||'Sketch',capture:c.id})}
  if(existing)Object.assign(existing,c);else state.captures.unshift(c);
  const reviewWasOpen=!!$('#modal[open] [data-action="commit-review"]');
  draft=null;persist();dismissCard();render();
  if(reviewWasOpen && c.session && firstMode() && !pending())peekHandoff();
  else toast(c.receipt+'. '+data.name);
}
function agentReceipt(e){
  let c=byId(state.captures,e.capture),s=sess(e.session);
  if(!s && e.folder){
    const p=e.scratch==='true'?scratchProject:state.projects.find(p=>p.folder===e.folder)||{id:e.folder,folder:e.folder,name:e.folder.split('/').pop(),aliases:[]};
    if(!proj(p.id))state.projects.push(p);
    s={id:e.session,managed:e.external!=='true',model:e.model||'',external:e.external==='true',project:p.id,agent:e.agent,task:e.task,log:[],producerKey:JSON.stringify([e.agent,e.folder,e.session])};state.sessions.unshift(s);
  }
  if(!c && s){c={id:e.capture,session:s.id,project:s.project,brief:e.brief,text:e.brief,receipt:'Queued',kind:e.mode==='nudge'?'Session nudge':'Agent question',time:'',strokes:[]};state.captures.unshift(c)}
  if(c && e.external==='true')c.external=true;
  if(s && e.model)s.model=e.model;
  if(!c||!s||c.receipt===e.state)return;
  handoffRelay.event(e.capture,e.state.toLowerCase(),{restored:!!e.recovered});
  c.receipt=e.state;s.log.push(e.state+(e.message?'. '+e.message:''));
  if(e.state==='Complete')s.result=e.message;
  const outstanding=state.captures.filter(c=>c.session===s.id && ['Queued','Running'].includes(c.receipt));
  s.state=state.decisions.some(q=>q.session===s.id)?'Needs input':outstanding.length?'Running':e.state;
  if(e.state==='Complete' && state.speak && !e.recovered)readAloud(e.message);
  persist();render();
  if($('#modal').open && $('#receipt')?.dataset.capture===e.capture)detailCapture(e.capture);
  else if($('#modal').open && openedSession===s.id && $('#dialog-heading')?.textContent===s.task)showSession(s.id);
}
function prepareHandoff(){
  const d=draft;
  cancelRouting();
  const estimate=d.mode==='ask' && sessionModelPolicy().adaptive;
  const preserve=!!(d.sessionProject || (d.project && /^(ask |tell |remember |note )/i.test(d.text.trim())));
  if(!d.text.trim() || d.session || d.candidates?.length || (preserve && !estimate)){routingPrompt();return}
  const projects=state.projects.filter(p=>p.available!==false).slice(0,80);
  const sessions=state.sessions.filter(canNudge).slice(0,45);
  const id=uid();
  d.routing={id,projects,sessions,preserve};
  routingActivityCard(d);
  postLive('route',{id,input:{capture:d.text.slice(0,9000),estimateDifficulty:estimate,projects:projects.map((p,i)=>[i,p.name]),sessions:sessions.map((s,i)=>[i,s.task,proj(s.project)?.name,s.agent])}});
}
function finishRouting(id,r){
  const pending=draft?.routing;
  if(!pending || id!==pending.id || !$('#modal').open)return;
  delete draft.routing;
  const d=draft;
  d.routingSource=r.source || 'fallback';
  if(!pending.preserve && ['ask','note','nudge'].includes(r.mode) && typeof r.brief==='string' && r.brief.trim()){
    d.mode=r.mode;d.brief=r.brief.trim();
    // Only an explicit project, a user choice, or an evidenced session can set the destination.
    if(d.mode==='nudge' && Number.isInteger(r.session)){
      const s=pending.sessions[r.session];
      if(s && matchSessions(d.text).includes(s) && (!d.project || d.project===s.project)){d.session=s.id;d.project=s.project}
    }
    if(['claude','codex','agy'].includes(r.agent))d.agent=r.agent;
    const projectName=proj(d.project)?.name;
    if(projectName && d.text.toLowerCase().includes(projectName.toLowerCase()) && !d.brief.toLowerCase().includes(projectName.toLowerCase()))d.brief=d.text.trim();
    if(d.mode!=='note' && typeof r.note==='string' && r.note.trim()){d.keep=true;d.note=r.note.trim()}
  }
  if(pending.preserve && d.routingSource==='apple')d.routingSource='estimate';
  if(d.mode==='ask' && r.source==='apple' && Number.isInteger(r.difficulty) && r.difficulty>=1 && r.difficulty<=10){
    d.modelEstimate={score:r.difficulty,evidence:r.scopeEvidence,brief:d.brief};
  }
  updateSignal();
  routingPrompt();
}
function dictate(target){
  if(recording && recording.target===target && recording.input===$(target)){
    if(recording.phase==='recording')postLive('dictation-finish',{id:recording.id});
    return;
  }
  const input=$(target);
  if(!input)return;
  if(recording)stopDictation();
  const id=uid();
  const observer=new MutationObserver(()=>{
    if(recording?.id===id && (!input.isConnected || !input.closest('dialog[open]')))stopDictation();
  });
  observer.observe(input.closest('dialog')||document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open']});
  const control=document.querySelector('[data-action="dictate"][data-id="'+target+'"]');
  recording={id,target,input,control,idleMarkup:control?.innerHTML,observer,phase:'starting'};
  postLive('dictation-start',{id});
}
function releaseRecording(){
  if(!recording)return;
  voiceWave.detach();
  recording.observer.disconnect();
  if(recording.control?.isConnected)recording.control.innerHTML=recording.idleMarkup;
  recording=null;
}
function stopDictation(){
  if(recording){postLive('dictation-cancel',{id:recording.id});releaseRecording()}
  updateSignal();
}
function dictationLevel(id,level){
  if(recording?.id!==id || recording.phase!=='recording' || !Number.isFinite(level))return;
  if(!recording.input.isConnected){stopDictation();return}
  level=Math.min(1,Math.max(0,level));
  voiceWave.sample(id,level);
}
function dictationEvent(id,phase,text){
  if(recording?.id!==id)return;
  const {target,input,control}=recording;
  if(!input.isConnected){stopDictation();return}
  if(phase==='recording'){
    if(recording.phase!=='starting')return;
    voiceWave.attach(id,input);
    if(control)control.textContent='Finish dictation';
  }
  if(phase==='processing'){
    voiceWave.detach();
    if(control)control.textContent='Transcribing…';
  }
  recording.phase=phase;
  if(phase==='text'){input.value=[input.value.trim(),text].filter(Boolean).join(' ');input.dispatchEvent(new Event('input'));if(target==='#transcript'&&draft)draft.hasVoice=true}
  if(phase==='error')toast(text);
  if(phase==='text'||phase==='error')releaseRecording();
  updateSignal();
}
