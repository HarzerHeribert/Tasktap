// Loaded before app.js. Browser previews and the isolated native fixture keep their sample store.
const live=!!window.webkit?.messageHandlers?.workspace && !window.fixtureMode;
const emptyState=()=>({projects:[],sessions:[],captures:[],notes:[],decisions:[],speak:false});
const postLive=(type,data={})=>window.webkit.messageHandlers.workspace.postMessage({type,...data});
let recording=null;
function projectsDiscovered(rows){
  firstRun.projectsReady=true;
  for(const row of rows){
    let p=state.projects.find(p=>p.folder===row.folder);
    if(!p){p={id:row.folder,color:'#a8c3ae'};state.projects.push(p)}
    Object.assign(p,row,{available:true,aliases:[row.name.replace(/[-_]+/g,' ')]});
  }
  for(const p of state.projects){if(!rows.some(r=>r.folder===p.folder))p.available=false}
  persist();render();
}
function externalSessions(rows){
  firstRun.liveSessions=new Set(rows.filter(r=>r.owned==='yes'?r.available==='yes':r.source==='desktop' || r.surface).map(r=>r.id));
  const seen=new Set();
  const pendingTurns=new Set(state.captures.filter(c=>['Queued','Opening','Running'].includes(c.receipt)).map(c=>c.session));
  const managed=new Set(state.sessions.filter(s=>s.managed).map(s=>s.id));
  // The CLI can register a thread one scan before we identify the owning terminal.
  const adopted=new Set(rows.filter(r=>r.owned==='yes' && r.conversation).map(r=>r.conversation));
  const history=new Set([...state.captures,...state.decisions].map(record=>record.session));
  state.sessions=state.sessions.filter(s=>!s.external || !adopted.has(s.id) || history.has(s.id));
  for(const row of rows){
    if(row.owned==='yes'){
      let s=sess(row.id);
      if(!s){s={id:row.id,log:[],managed:true};state.sessions.unshift(s)}
      Object.assign(s,{interactive:true,host:row.host,agent:row.agent,task:row.task,project:row.folder,available:row.available==='yes',inbox:row.inbox,conversation:row.conversation,waitingFor:row.waitingFor||''});
      s.resumable=row.resumable==='yes';
      if(row.updatedAt)s.updatedAt=Number(row.updatedAt);
      if(row.agent==='claude')s.startup=s.result?'confirmed':row.startup || 'pending';
      if(row.scratch==='yes')s.project='@scratch';
      const handoffPending=row.state==='Connected' && pendingTurns.has(s.id) && ['Queued','Opening','Running'].includes(s.state);
      const failedLaunch=row.state==='Closed' && state.captures.some(c=>c.session===s.id && c.kind==='Agent question' && c.receipt==='Failed');
      if(state.decisions.some(q=>q.session===s.id))s.state='Needs input';
      else if(failedLaunch)s.state='Failed';
      else if(!handoffPending)s.state=row.state;
      seen.add(s.id);continue;
    }
    if(managed.has(row.conversation) || managed.has(row.id) || adopted.has(row.id))continue;
    const project=state.projects.find(p=>p.folder===row.folder);
    if(!project)continue;
    let s=sess(row.id);
    if(!s){s={id:row.id,external:true,log:[]};state.sessions.push(s)}
    Object.assign(s,{agent:row.agent,task:row.task,project:project.id,available:true,source:row.source||'cmux',
      inbox:row.source==='desktop'?'codex':row.surface?'cmux':'',conversation:row.conversation,waitingFor:row.waitingFor||''});
    if(state.decisions.some(q=>q.session===s.id))s.state='Needs input';
    else if(row.state==='Needs input' || !pendingTurns.has(s.id))s.state=row.state||'Connected';
    seen.add(s.id);
  }
  for(const s of state.sessions){
    if(!s.external || seen.has(s.id))continue;
    s.available=false;s.waitingFor='';
    if(!pendingTurns.has(s.id))s.state='Unavailable';
  }
  persist();render();
  const active=sess(openedSession);
  if(active && $('#modal[open] #dialog-heading')?.textContent===active.task)showSession(active.id);
}
const canNudge=s=>s && (s.interactive && s.available!==false && (s.agent!=='claude' || s.startup==='confirmed') && !['Closed','Failed','Opening','Queued'].includes(s.state) || s.external && s.available && ['cmux','desktop'].includes(s.source));
function sessionHost(d){
  if(d.mode==='nudge'){const s=sess(d.session);return s?.host || (s?.source==='desktop'?'desktop':'cmux')}
  if(terminalHosts.valid(d.host))return d.host;
  return terminalHosts.valid(state.sessionHost)?state.sessionHost:'terminal';
}
function sessionHostLabel(d){return terminalHosts.label(sessionHost(d))}
function failedStart(s){
  if(!live || !s?.managed || !s.interactive || s.external || s.result || s.available===true || !['Failed','Closed'].includes(s.state))return;
  if(s.agent==='codex' && s.conversation || s.agent==='claude' && s.startup==='confirmed')return;
  const turns=state.captures.filter(c=>c.session===s.id);
  const entry=turns[0];
  if(turns.length===1 && entry.kind==='Agent question' && entry.receipt==='Failed' && !sess(entry.id))return entry;
}
function reviewFailedHandoff(job){
  const s=sess(job.session), c=failedStart(s);
  if(!c || c.id!==job.capture)return;
  captureDraft('',s.project,job.transcript ?? c.text);
  // Older jobs saved the reference as a suffix in their brief.
  const reference=job.reference?.value?job.reference:null;
  const suffix=reference?captureContext.brief({brief:'',reference}):'';
  const brief=job.brief ?? c.brief;
  Object.assign(draft,{retryOf:s.id,retryCapture:c.id,agent:job.agent,host:job.host,agentChoice:'manual',
    modelOverride:{agent:job.agent,value:job.model||'',reviewed:true},brief:suffix && brief.endsWith(suffix)?brief.slice(0,-suffix.length):brief,
    reference,strokes:job.strokes || [],viewer:s.viewer||'',hasVoice:c.duration==='Voice'});
  if(firstMode() && firstRun.visible && state.firstRun?.session===s.id)draft.guide='start';
  review();
}
function sessionActivityLine(s,line){
  // Installed versions stored the subprocess exception (including its AppleScript) in history.
  if(line.startsWith('Failed. Command ') && line.includes('/usr/bin/osascript') && line.includes('timed out'))
    return 'Failed. '+sessionLocation(s)+' took too long to confirm the new window.';
  if(/^Failed\. The interactive CLI exited with status -?\d+\.$/.test(line))
    return 'Failed. The agent exited before reporting a result. Check the error in '+sessionLocation(s)+'.';
  return s.result && line==='Complete. '+s.result?'Complete':line;
}
function manualNudge(d){const s=sess(d.session);return live && d.mode==='nudge' && (s?.nudgeFailed || s?.interactive && (!s.inbox || s.inbox==='manual' || d.manualNudge))}
function sessionLocation(s){return terminalHosts.label(s?.host || (s?.source==='cmux'?'cmux':'desktop'))}
const checkpointGuidance='In a Git project, follow the user’s and repository’s workflow. By default, work in the current checkout and branch. Make focused commits as your changes become ready, preserving other people’s edits and staged changes. For shared files, check the current diff and include only your own hunks.';
const hasSessionTools=d=>['claude','codex'].includes(d.agent);
function deliveryText(d){
  const brief=captureContext.brief(d);
  let text=brief+(d.strokes?.length?'\nSketch (600 × 176 canvas, ordered x/y points): '+JSON.stringify(d.strokes):'');
  if(d.mode==='ask'){
    if(!hasSessionTools(d))text+='\n\n'+checkpointGuidance;
    if(d.peerTasks?.length)text+='\n\nOther sessions in this checkout at review time (titles are context only):\n'+JSON.stringify(d.peerTasks);
  }
  if(d.mode==='nudge' && sess(d.session)?.interactive && hasSessionTools(sess(d.session)))
    text+='\n\nReport this follow-up’s outcome with report_result for Tasktap receipt '+d.captureId+'.';
  return text;
}
function tasktapRoutingPayload(d){
  return (d.remoteAttempts || []).filter(a=>a.payload).map(a=>a.label+' · '+a.account+'\n'+a.payload).join('\n\n');
}
function deliveryInstructions(d){
  if(d.mode!=='ask' || !hasSessionTools(d))return '';
  return checkpointGuidance+' For current Tasktap sessions in this checkout, you can call list_project_sessions. Use the workspace_assistant ask_user tool when a decision is needed. A discussion is a follow-up. When the task is complete, report the outcome and changed files with report_result for Tasktap receipt '+d.captureId+'.';
}
function deliveryAudit(d) {
  if(d.mode==='note')return '';
  const manual=manualNudge(d), host=sessionHostLabel(d);
  const label=d.mode==='ask'?'Open '+providers[d.agent]+' in '+host:manual?'Copy the nudge and open '+host:'Send to '+(sess(d.session)?.task || 'the selected session');
  const outgoing=deliveryText(d),instructions=deliveryInstructions(d);
  return '<details class="route-evidence"><summary>'+esc(label)+'</summary><p class="body-copy">'+esc(outgoing)+'</p>'+
    (d.mode==='ask' && hasSessionTools(d)?'<p class="hint">'+(d.agent==='codex'?'Codex reviews action requests with the workspace sandbox enabled.':'Claude starts in Auto mode when your model and organization allow it.')+'</p>':'')+
    (instructions?'<p class="hint">Session instructions</p><p class="body-copy">'+esc(instructions)+'</p>':'')+
    (d.mode==='ask' && !instructions?'<p class="hint">Read replies and answer decisions in '+esc(providers[d.agent])+'.</p>':'')+
    (manual?'<p class="hint">Paste the text at the agent prompt and press Return.</p>':'')+'</details>';
}
function reviewReceipt(d,phase,label){
  if(d.mode==='note')return;
  d.relayPhase=phase;
  handoffRelay.event(d.captureId,phase);
  const rail=$('#modal .review-rail tasktap-relay');
  if(rail && rail.dataset.capture===d.captureId){
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
  d.captureId??=uid();d.runId??=d.mode==='nudge' && prior?prior.id:d.mode==='ask' && d.retryOf?d.retryCapture:uid();
  d.accountReceipt=aiConnections.record(d);
  const job={delivery:'interactive',host:sessionHost(d),manual:!!manualNudge(d),outgoing:deliveryText(d),instructions:deliveryInstructions(d),
    routingEvidence:routingEvidence(d).join('\n'),routingPayload:tasktapRoutingPayload(d),transcript:d.text,accounts:d.accountReceipt,session:d.runId,capture:d.captureId,task:(d.mode==='nudge' && prior?.task)||d.brief.slice(0,78)||'Review sketch',agent:(d.mode==='nudge' && prior?.agent)||d.agent,folder,
    external:d.mode==='nudge' && !!prior?.external,brief:captureContext.brief(d),reference:d.reference,strokes:d.strokes,note:d.mode==='note'?captureContext.brief(d):d.note||d.brief,mode:d.mode,keep:d.keep,create};
  if(d.mode==='ask')job.model=modelPlanFor(d).model;
  const trust=$('#modal[open] #folder-trust:checked');
  if(d.mode==='ask' && d.agent==='codex' && trust)job.reviewedFolder=trust.dataset.folder;
  if(d.mode==='ask' && d.retryOf)job.retryOf=d.retryOf;
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
  const jobHost=sessionHost(d);
  const receiptState=existing?.receipt || (d.mode==='note'?'Saved':'Queued');
  if(d.mode!=='note')handoffRelay.event(d.captureId,receiptState.toLowerCase());
  let p=state.projects.find(p=>p.folder===data.folder);
  if(!p && d.project!=='@scratch'){p={id:data.folder,name:data.name,folder:data.folder,aliases:[],color:'#a8c3ae'};state.projects.push(p)}
  const c={id:d.captureId,routingEvidence:routingEvidence(d).join('\n'),routingPayload:tasktapRoutingPayload(d),outgoing:deliveryText(d),instructions:deliveryInstructions(d),accounts:d.accountReceipt || aiConnections.record(d),time:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),text:d.text,brief:captureContext.brief(d),reference:d.reference,strokes:d.strokes,project:d.project==='@scratch'?'@scratch':p?.id||'',duration:d.hasVoice?'Voice':'Text',
    quiet:!!d.guide && !d.hasVoice,receipt:receiptState,kind:{ask:'Agent question',nudge:'Session nudge',note:'Note'}[d.mode]};
  if(d.mode==='nudge' && sess(d.runId)?.external)c.external=true;
  if(d.mode!=='note'){
    c.session=d.runId;
    let s=sess(d.runId);
    if(!s){s={id:d.runId,interactive:true,host:jobHost,managed:true,model:modelPlanFor(d).model,task:data.task,project:c.project,agent:d.agent,viewer:d.viewer,capture:c.id,log:[],producerKey:JSON.stringify([d.agent,data.folder,d.runId])};state.sessions.unshift(s)}
    if(!existing){s.state='Queued';s.log.push('Queued. '+d.brief)}
  }
  if(d.mode==='note'||d.keep){const text=d.mode==='note'?captureContext.brief(d):d.note||d.brief;state.notes.unshift({id:uid(),project:c.project==='@scratch'?'':c.project,text,title:text.slice(0,64)||'Sketch',capture:c.id})}
  if(existing)Object.assign(existing,c);else state.captures.unshift(c);
  const reviewWasOpen=!!$('#modal[open] [data-action="commit-review"]');
  firstRun.accepted(d,c);
  draft=null;persist();dismissCard();render();
  if(reviewWasOpen && c.session && firstMode() && !pending())peekHandoff(c.id);
  else toast(c.receipt+'. '+data.name);
}
function agentReceipt(e){
  let c=byId(state.captures,e.capture),s=sess(e.session);
  if(!s && e.folder){
    const p=e.scratch==='true'?scratchProject:state.projects.find(p=>p.folder===e.folder)||{id:e.folder,folder:e.folder,name:e.folder.split('/').pop(),aliases:[]};
    if(!proj(p.id))state.projects.push(p);
    s={id:e.session,host:e.host,interactive:e.delivery==='interactive' && e.external!=='true',planAccount:e.planAccount,managed:e.external!=='true',model:e.model||'',external:e.external==='true',project:p.id,agent:e.agent,task:e.task,log:[],producerKey:JSON.stringify([e.agent,e.folder,e.session])};state.sessions.unshift(s);
  }
  if(!c && s){c={id:e.capture,accounts:e.accounts,session:s.id,project:s.project,brief:e.brief,text:e.transcript || e.brief,routingEvidence:e.routingEvidence,routingPayload:e.routingPayload,outgoing:e.outgoing,instructions:e.instructions,receipt:'Queued',kind:e.mode==='nudge'?'Session nudge':'Agent question',time:'',strokes:[]};state.captures.unshift(c)}
  if(s && e.delivery==='interactive' && e.external!=='true'){s.interactive=true;s.host=e.host}
  if(s && e.planAccount)s.planAccount=e.planAccount;
  if(c && e.external==='true')c.external=true;
  if(s && e.model)s.model=e.model;
  if(!c||!s||c.receipt===e.state)return;
  handoffRelay.event(e.capture,e.state.toLowerCase(),{restored:!!e.recovered});
  c.receipt=e.state;s.log.push(e.state+(e.message?'. '+e.message:''));
  if(e.state==='Complete'){c.result=e.message;s.result=e.message;if(s.interactive && s.agent==='claude')s.startup='confirmed'}
  if(e.state==='Opened' && !e.recovered){s.available=true;s.inbox??='manual';if(s.agent==='claude')s.startup??='pending';firstRun.liveSessions.add(s.id)}
  if(e.state==='Closed'){s.available=false;firstRun.liveSessions.delete(s.id)}
  if(e.state==='Failed' && e.mode==='nudge' && (s.interactive || s.external)){s.inbox='manual';s.nudgeFailed=true}
  const outstanding=state.captures.filter(c=>c.session===s.id && ['Queued','Opening','Running'].includes(c.receipt));
  const activeState=['Running','Opening','Queued'].find(status=>outstanding.some(c=>c.receipt===status));
  s.state=state.decisions.some(q=>q.session===s.id)?'Needs input':activeState || (s.interactive && e.mode==='nudge' && ['Failed','Copied','Delivered'].includes(e.state)?(s.available===false?'Closed':'Connected'):e.state);
  if(s.state==='Opened' && s.agent==='claude' && s.startup!=='confirmed')s.state='Awaiting agent';
  if(e.state==='Complete' && state.speak && !c.quiet && !e.recovered)readAloud(e.message);
  persist();render();
  if($('#modal').open && $('#receipt')?.dataset.capture===e.capture)detailCapture(e.capture);
  else if($('#modal').open && openedSession===s.id && $('#dialog-heading')?.textContent===s.task)showSession(s.id);
}
function prepareHandoff(){
  const d=draft;
  cancelRouting();
  const provider=aiConnections.choice();
  if(provider==='claude-session'){
    if(d.text.trim() && d.mode==='ask' && !d.session)claudeBrief.show(d);
    else routingPrompt();
    return;
  }
  const estimate=d.mode==='ask' && sessionModelPolicy().adaptive;
  const preserve=!!(d.sessionProject || (d.project && /^(ask |tell |remember |note )/i.test(d.text.trim())));
  if(!d.text.trim() || d.session || d.mode==='nudge' || d.candidates?.length || (preserve && !estimate)){routingPrompt();return}
  const id=uid();
  // The Apple model only sees the capture. An external preparation request
  // includes the matching names displayed in its consent sheet.
  const relevantProjects=provider==='local'?[]:matchProjects(d.text).slice(0,8);
  const relevantSessions=provider==='local'?[]:matchSessions(d.text).filter(canNudge).slice(0,8);
  const input={capture:d.text,estimateDifficulty:estimate,projects:relevantProjects.map((p,i)=>[i,p.name]),sessions:relevantSessions.map((s,i)=>[i,s.task,proj(s.project)?.name,s.agent])};
  const reviewedServer=provider==='server'?aiConnections.serverTarget():undefined;
  const connectionLabel=aiConnections.label(provider), billingLabel=aiConnections.payer(provider);
  function send() {
    if (draft!==d) return;
    d.routing={id,projects:relevantProjects,sessions:relevantSessions,preserve,provider};
    if (provider!=='local') (d.remoteAttempts??=[]).push({label:connectionLabel,account:billingLabel,payload:[aiConnections.routingInstructions(),JSON.stringify(input,null,2)].filter(Boolean).join('\n\n')});
    routingActivityCard(d);
    const request={id,input,provider,confirmed:provider!=='local'};
    if (reviewedServer) request.server=reviewedServer;
    postLive('route',request);
  }
  if (provider==='local') {send();return}
  dialog('Prepare with '+aiConnections.label(provider)+'?','Capture',
    (reviewedServer?'<div class="server-target"><div><strong>'+esc(reviewedServer.model)+'</strong><code>'+esc(reviewedServer.url)+'</code></div></div>':'')+
    '<p>'+esc(aiConnections.sendDescription(provider))+'</p>'+
    '<details class="route-evidence"><summary>What will be sent</summary><p class="body-copy">'+esc(input.capture)+'</p><p class="hint">Matching projects and sessions · '+
    esc([...input.projects.map(p=>p[1]),...input.sessions.map(s=>s.slice(1).join(' · '))].join(', ')||'None')+'</p>'+
    (aiConnections.routingInstructions()?'<details><summary>Tasktap’s routing instructions</summary><p class="body-copy">'+esc(aiConnections.routingInstructions())+'</p></details>':'')+'</details>'+
    '<div class="form-actions">'+button('Prepare on this Mac','local-review')+button('Send to '+aiConnections.label(provider),'send-capture','','primary')+'</div>');
  $('#modal [data-action="local-review"]').onclick=()=>{d.routingSource='local';routingPrompt()};
  $('#modal [data-action="send-capture"]').onclick=send;
}

function finishRouting(id,r){
  const pending=draft?.routing;
  if(!pending || id!==pending.id || !$('#modal').open)return;
  delete draft.routing;
  const d=draft;
  d.routingSource=r.source || 'fallback';
  if (r.source==='error') {
    dialog('Couldn’t prepare this capture',aiConnections.label(pending.provider),
      '<p>'+esc(r.message || 'The provider did not finish.')+'</p><p class="hint">'+(pending.provider==='server'?'The server may already have received the capture.':'The request may count toward this account.')+' No worker has started.</p><div class="form-actions">'+
      button('Edit capture','edit')+button('Continue on this Mac','recover-local','','primary')+'</div>');
    $('#modal [data-action="recover-local"]').onclick=()=>{d.routingSource='local';routingPrompt()};
    return;
  }
  if(pending.provider==='local'){
    if(r.source==='apple' && typeof r.brief==='string' && r.brief.trim()!==d.brief)d.suggestedBrief=r.brief.trim();
  } else if(!pending.preserve && ['ask','note','nudge'].includes(r.mode) && typeof r.brief==='string' && r.brief.trim()){
    if(!d.explicitMode)d.mode=r.mode;
    if(r.brief.trim()!==d.brief)d.suggestedBrief=r.brief.trim();
    // Only an explicit project, a user choice, or an evidenced session can set the destination.
    if(d.mode==='nudge' && Number.isInteger(r.session)){
      const s=pending.sessions[r.session];
      if(s && matchSessions(d.text).includes(s) && (!d.project || d.project===s.project)){d.session=s.id;d.project=s.project}
    }
  }
  if(pending.preserve && d.routingSource==='apple')d.routingSource='estimate';
  if(d.mode==='ask' && (r.source==='apple' || r.source===pending.provider && r.source!=='local') && Number.isInteger(r.difficulty) && r.difficulty>=1 && r.difficulty<=10 && typeof r.scopeEvidence==='string' && r.scopeEvidence.trim() && d.text.toLowerCase().includes(r.scopeEvidence.trim().toLowerCase())){
    d.modelEstimate={origin:pending.provider==='local'?'':aiConnections.label(pending.provider),score:r.difficulty,evidence:r.scopeEvidence,brief:d.brief};
  }
  updateSignal();
  routingPrompt();
}
function startDictation(target,owner,id=uid()){
  if(recording)return;
  const input=$(target);
  if(!input)return;
  const container=input.closest('dialog,#guide-compose');
  if(!container)return;
  const observer=new MutationObserver(()=>{
    if(recording?.id===id && (!input.isConnected || (container.tagName==='DIALOG' && !container.open) || input.closest('[hidden]')))stopDictation();
  });
  observer.observe(container.closest('#notch-home') || container,{childList:true,subtree:true,attributes:true,attributeFilter:['open','hidden']});
  const control=document.querySelector('[data-action="dictate"][data-id="'+target+'"]');
  // A real keyboard edit takes ownership of the field, including its current hypothesis.
  const editing=()=>{if(recording?.id===id && !recording.writing)stopDictation()};
  input.addEventListener('beforeinput',editing);
  input.addEventListener('input',editing);
  const start=input.selectionStart ?? input.value.length, end=input.selectionEnd ?? start;
  recording={id,owner,target,input,control,idleMarkup:control?.innerHTML,observer,phase:'starting',editing,
    before:input.value.slice(0,start),after:input.value.slice(end),writing:false};
  const feedback=$('#capture-feedback');
  if(feedback)feedback.textContent='';
  if(control)control.textContent='Starting microphone…';
  postLive('dictation-start',{id,shortcut:owner==='shortcut'});
}
function finishDictation(owner,id){
  if(!recording || recording.owner!==owner || (id && recording.id!==id))return;
  if(['finishing','processing'].includes(recording.phase))return;
  recording.phase='finishing';
  postLive('dictation-finish',{id:recording.id});
}
function releaseRecording(){
  if(!recording)return;
  voiceWave.detach();
  recording.observer.disconnect();
  recording.input.removeEventListener('input',recording.editing);
  recording.input.removeEventListener('beforeinput',recording.editing);
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
  if(phase==='preparing'){
    if(control)control.textContent=text;
    recording.phase='preparing';return;
  }
  if(phase==='recording'){
    if(!['starting','preparing'].includes(recording.phase))return;
    voiceWave.attach(id,input);
    if(control)control.textContent='Listening…';
  }
  if(phase==='processing'){
    voiceWave.detach();
    if(control)control.textContent='Finishing…';
  }
  if(phase==='partial'||phase==='text'){
    if(phase==='partial' && !['recording','finishing','processing'].includes(recording.phase))return;
    const {before,after}=recording;
    const lead=before && text && !/\s$/.test(before) && !/^[\s.,!?;:]/.test(text)?' ':'';
    const tail=after && text && !/^[\s.,!?;:]/.test(after)?' ':'';
    const words=before+lead+text;
    recording.writing=true;
    input.value=words+tail+after;
    input.setSelectionRange(words.length,words.length);
    input.dispatchEvent(new Event('input',{bubbles:true}));
    recording.writing=false;
    if(target==='#transcript' && draft && text)draft.hasVoice=true;
    if(target==='#guide-input' && text)firstRun.hasVoice=true;
    if(phase==='partial')return;
  }
  recording.phase=phase;
  const reviewAfter=recording.reviewAfter;
  if(phase==='error'){
    const status=$('#capture-feedback');
    if(status)status.textContent=text;else toast(text);
  }
  if(['text','error','stopped'].includes(phase))releaseRecording();
  updateSignal();
  if(['text','stopped'].includes(phase) && reviewAfter && input.value.trim()){
    if(target==='#transcript')reviewDraft();
    if(target==='#guide-input')firstRun.capture();
  }

}

// Pointer capture keeps release attached to the original control when the
// pointer drifts outside it. Key release uses the same ownership check.
const holdButton=event=>event.target.closest?.('button[data-action="dictate"]');
document.addEventListener('pointerdown',event=>{
  const button=holdButton(event);
  if(!live || !button || !event.isPrimary || event.button!==0 || recording)return;
  button.setPointerCapture(event.pointerId);
  startDictation(button.dataset.id,'pointer-'+event.pointerId);
});
for(const type of ['pointerup','pointercancel','lostpointercapture']){
  document.addEventListener(type,event=>finishDictation('pointer-'+event.pointerId),true);
}
document.addEventListener('keydown',event=>{
  const button=holdButton(event);
  if(!live || !button || !['Space','Enter'].includes(event.code) || event.ctrlKey || event.metaKey || event.altKey)return;
  event.preventDefault();
  if(!event.repeat)startDictation(button.dataset.id,'key-'+event.code);
});
document.addEventListener('keyup',event=>finishDictation('key-'+event.code),true);
window.addEventListener('blur',()=>{
  if(recording && recording.owner!=='shortcut')finishDictation(recording.owner);
});
