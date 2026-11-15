/* A review is a decision about a task. Wire payloads belong in Diagnostics. */
const handoffReview=(()=>{
  const footer=(label,action)=>'<div class="form-actions review-editor-footer">'+button('Back to review','review-return')+'<button class="primary" type="submit"'+(action?' data-action="'+action+'"':'')+'>'+esc(label)+'</button></div>';
  const field=(label,html)=>'<div class="field"><label for="'+attr(/id="([^"]+)"/.exec(html)?.[1]||'')+'">'+label+'</label>'+html+'</div>';
  const group=(name,action,label,body)=>'<section class="review-group" aria-label="'+name+'"><div class="review-group-heading"><h3>'+name+'</h3>'+button(label,action,'','text-btn')+'</div>'+body+'</section>';
  function show(d,peers=[]){
    d.reviewScreen='summary';
    const session=sess(d.session),agent=d.mode==='nudge'?session?.agent:d.agent,p=proj(d.project),compact=firstMode();
    const project=d.project==='@new'?d.newName:d.project==='@scratch'?'Scratch':p?.name||'Choose a workspace';
    const conversation=d.mode==='note'?'Project note':d.mode==='nudge'?'Existing conversation':'New conversation';
    const plan=d.noPick?null:modelPlanFor(d),host=d.mode==='note'?'':sessionHostLabel(d);
    const destination='<strong class="review-destination-name">'+esc(project)+'</strong><p class="review-conversation">'+esc(conversation)+'</p>'+(d.mode==='nudge'?'<p class="review-session-name">'+esc(sessionDisplayName(session||{}))+'</p>':'')+(d.mode==='note'?'':'<div class="review-config"><span>'+esc(d.noPick?'Agent needed':providers[agent]||'Choose an agent')+'</span><span>'+esc(host)+'</span>'+(plan?'<span id="review-model">'+esc(plan.label)+'</span>':'')+'</div>')+(live&&d.mode==='ask'?workerRouting.summaryMarkup():'')+(d.noPick?button('Choose an agent','review-destination','','btn'):'');
    const task='<p class="review-brief" id="review-brief">'+esc(d.brief||'Attached sketch')+'</p>'+(d.suggestedBrief&&d.suggestedBrief!==d.brief?button('Review suggested wording','review-task','','text-btn'):'')+(d.keep&&d.mode!=='note'?'<div class="review-side-note"><strong>Also save a note</strong><p>'+esc(d.note||d.brief)+'</p></div>':'');
    const context=(d.reference?captureContext.review(d):'<p class="hint">No file or page attached.</p>')+(d.strokes?.length?'<div class="review-sketch"><span class="hint">Attached sketch</span>'+sketchMarkup(d.strokes)+'</div>':'');
    const notices=[];
    if(p?.available===false)notices.push('<div class="review-notice"><p>This workspace folder is unavailable. Choose an available destination before sending.</p>'+button('Change destination','review-destination','','text-btn')+'</div>');
    if(peers.length)notices.push('<div class="review-notice"><p>'+peers.length+' other session'+(peers.length===1?' is':'s are')+' active in this workspace. Check for overlapping work before starting.</p>'+button('View active work','review-peers','','text-btn')+'</div>');
    if(d.remoteAttempts?.length){const last=d.remoteAttempts.at(-1);notices.push('<div class="review-notice"><p>Preparation was requested from '+esc(last.label||'your configured service')+'.</p>'+button('View processing details','review-diagnostics','','text-btn')+'</div>')}
    const trustPath=live&&!d.noPick&&d.mode==='ask'&&agent==='codex'?(d.project==='@scratch'?'@scratch':d.project==='@new'?workspaceSettings.newFolder(d.newName):p?.checkout||p?.folder):'';
    if(trustPath)notices.push('<div class="folder-trust review-trust"><label class="check-line"><input type="checkbox" id="folder-trust" data-folder="'+attr(trustPath)+'" aria-describedby="folder-trust-detail" '+(d.deferTrust===trustPath?'':'checked')+'>Trust this folder for this Codex session</label><p class="hint" id="folder-trust-detail">'+esc(trustPath==='@scratch'?'Tasktap’s Scratch folder':trustPath)+' · Project settings can run code.</p></div>');
    const manual=d.mode==='nudge'&&manualNudge(d),action=d.mode==='note'?'Save note':d.mode==='nudge'?(manual?'Copy nudge & open session':'Send nudge'):'Start session';
    const relay=d.mode==='note'||d.noPick?'':'<div class="review-rail">'+handoffRelay.markup(d.captureId,agent,d.relayPhase||'review')+'<span data-relay-label>'+esc(d.relayPhase==='failed'?'Handoff failed':'Ready for '+providers[agent])+'</span></div>';
    dialog(d.mode==='note'?'Review note':d.mode==='nudge'?'Review follow-up':'Review task','Tasktap','<div id="handoff-review" class="review-sheet'+(compact?' is-compact':'')+'"><div class="review-layout">'+group('Task','review-task','Edit task',task)+'<div class="review-sidebar">'+group('Destination','review-destination','Change',destination)+group('Context','review-context',d.reference?'Edit context':'Add reference',context)+'</div></div>'+(notices.length?'<section class="review-decisions" aria-label="Before you send">'+notices.join('')+'</section>':'')+'<div class="form-actions review-footer">'+(d.handoffError?'<p id="handoff-error" role="alert">'+esc(d.handoffError)+' Your request is preserved. Change destination to adjust where it goes, or try again.</p>':'')+(manual?'<p class="review-manual" role="note">You’ll need to paste this follow-up into '+esc(host)+' and press Return. Tasktap will copy it and open the session.</p>':'')+'<div class="review-footer-info">'+relay+button('Diagnostics','review-diagnostics','','text-btn')+'</div>'+button(action,'commit-review','','primary','arrow')+'</div></div>');
    if(trustPath)$('#folder-trust').onchange=e=>{d.deferTrust=e.target.checked?'':trustPath};
    if(live&&d.mode==='ask')workerRouting.updateReviewAmounts(d);
    if(p?.available===false)$('#modal [data-action="commit-review"]').disabled=true;
    $('#handoff-review [data-action="review-destination"]').setAttribute('aria-label','Change destination');
    pending(d);
  }
  function pending(d){
    for(const el of document.querySelectorAll('#handoff-review button,#handoff-review input')){
      if(el.dataset.action==='review-diagnostics')continue;
      if(d.submitting){if(el.dataset.handoffDisabled==null)el.dataset.handoffDisabled=String(el.disabled);el.disabled=true}
      else if(el.dataset.handoffDisabled!=null){el.disabled=el.dataset.handoffDisabled==='true';delete el.dataset.handoffDisabled}
    }
  }
  function task(){
    const d=draft;if(!d)return;d.reviewScreen='task';
    dialog('Edit task','Review','<form id="review-task-form" class="review-editor">'+field('Task','<textarea id="review-task-text" rows="7" '+(d.strokes?.length?'':'required')+'>'+esc(d.brief)+'</textarea>')+(d.suggestedBrief&&d.suggestedBrief!==d.brief?'<section class="review-suggestion"><h3>Suggested wording</h3><p>'+esc(d.suggestedBrief)+'</p>'+button('Use this wording','review-use-wording','','btn')+'</section>':'')+(d.mode!=='note'?'<label class="check-line"><input type="checkbox" id="review-keep-note" '+(d.keep?'checked':'')+'>Save a separate project note</label><label class="field" id="review-note-field" '+(!d.keep?'hidden':'')+'>Project note<textarea id="review-note-text">'+esc(d.note)+'</textarea></label>':'')+footer('Save task')+'</form>');
    $('#review-keep-note')?.addEventListener('change',e=>{$('#review-note-field').hidden=!e.target.checked});
    $('#review-task-form').onsubmit=e=>{e.preventDefault();d.brief=$('#review-task-text').value;if($('#review-keep-note')){d.keep=$('#review-keep-note').checked;d.note=$('#review-note-text').value}review()};
    $('#review-task-text').focus();
  }
  function destination(){
    const d=draft;if(!d)return;d.reviewScreen='destination';if(d.mode==='ask')workerRouting.prepare(d);
    const routes=[['note','Save a note'],['ask','Start a new conversation'],['nudge','Continue a conversation']];
    const sessions=state.sessions.filter(s=>s.id===d.session||(!live? s.state!=='Complete':canNudge(s)));
    const project=field('Workspace','<select id="project" required>'+option('','Choose a workspace',d.project)+state.projects.filter(p=>p.available!==false).map(p=>option(p.id,p.name,d.project)).join('')+option('@new','Create project folder…',d.project)+option('@scratch','Keep in scratch',d.project)+'</select>')+(d.project==='@new'?field('New project name','<input id="newName" required value="'+attr(d.newName)+'" pattern="[^/]+">'):'');
    const existing=field('Existing session','<select id="session" required>'+option('','Choose a session',d.session)+sessions.map(s=>option(s.id,sessionDisplayName(s)+' · '+(proj(s.project)?.name||'Scratch')+' · '+providers[s.agent],d.session)).join('')+'</select>');
    const config=d.mode==='ask'?workerRouting.reviewMarkup(d)+(live?settingsField('handoff-host','Open this session in','<select id="handoff-host">'+terminalHosts.options(sessionHost(d),d.agent)+'</select>'):'')+field('Export summary with','<select id="viewer">'+['','Xcode','Preview','Finder'].map(v=>option(v,v||'Choose later',d.viewer)).join('')+'</select>'):'';
    dialog('Change destination','Review','<form id="route-form" class="review-editor">'+field('Action','<select id="mode">'+routes.map(([id,title])=>option(id,title,d.mode)).join('')+'</select>')+(d.mode==='nudge'?existing:project)+config+footer('Review changes')+'</form>');
    const f=$('#route-form');
    for(const [id,key] of [['newName','newName'],['handoff-host','host'],['viewer','viewer']]){const input=$('#'+id,f);if(input)input.oninput=()=>{d[key]=input.value}}
    $('#mode').onchange=e=>{d.mode=e.target.value;delete d.runId;delete d.relayPhase;delete d.handoffError;delete d.retryOf;delete d.retryCapture;if(d.mode!=='nudge')d.session='';destination()};
    if($('#project'))$('#project').onchange=e=>{d.project=e.target.value;d.suggestedProject=false;delete d.contextProject;destination()};
    if($('#session'))$('#session').onchange=e=>{d.session=e.target.value;delete d.runId;delete d.handoffError;d.project=sess(d.session)?.project||''};
    f.onsubmit=e=>{e.preventDefault();const name=$('#newName',f);if(name){const value=name.value.trim();if(!value||value==='.'||value==='..'||value.includes('/')){name.setCustomValidity('Choose a folder name without slashes.');name.reportValidity();return}d.newName=value}routingPrompt()};
    $('#newName',f)?.addEventListener('input',e=>e.target.setCustomValidity(''));
    if(d.mode==='ask')workerRouting.bindReview(d);
    if($('#handoff-host'))postLive('terminal-catalog');
    settingsPickers.mount(f);
  }
  function context(){
    const d=draft;if(!d)return;d.reviewScreen='context';
    dialog('Edit context','Review','<form id="review-context-form" class="review-editor">'+field('Reference type','<select id="review-reference-kind">'+option('website','Website',d.reference?.kind||'website')+option('file','File or folder',d.reference?.kind||'website')+'</select>')+field('URL or file path','<input id="review-reference" value="'+attr(d.reference?.value||'')+'" placeholder="https://example.com or /path/to/file">')+'<p class="hint">Only this reference is attached to the task. The destination stays the same.</p>'+(d.strokes?.length?'<label class="check-line"><input type="checkbox" id="review-keep-sketch" checked>Include the captured sketch</label>':'')+footer('Save context')+'</form>');
    const value=$('#review-reference');value.oninput=()=>value.setCustomValidity('');
    $('#review-context-form').onsubmit=e=>{e.preventDefault();const project=d.project;
      if(value.value.trim()){if(!captureContext.attach(d,{kind:$('#review-reference-kind').value,value:value.value,app:'Chosen reference'})){value.setCustomValidity('Enter an http or https URL, or an absolute file path.');value.reportValidity();return}}
      else{delete d.reference;delete d.contextProject;d.contextSkipped=true}
      d.project=project;if($('#review-keep-sketch')&&!$('#review-keep-sketch').checked)d.strokes=[];review();
    };value.focus();
  }
  function redact(value,key=''){
    if(/(?:api.?key|access.?token|refresh.?token|password|secret|authorization|cookie|credential)/i.test(key))return '[redacted]';
    if(Array.isArray(value))return value.map(v=>redact(v));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redact(v,k)]));
    if(typeof value!=='string')return value;
    return value.replace(/^(\s*(?:Cookie|Set-Cookie)\s*:)\s*.*$/gim,'$1 [redacted]')
      .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}/g,'[redacted]')
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[redacted private key]')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.~-]+/gi,'$1 [redacted]')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}/g,'[redacted]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[redacted]@')
      .replace(/([\w-]*(?:api[_-]?key|token|password|secret|authorization|cookie)[\w-]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,'$1"[redacted]"');
  }
  function diagnosticText(d){
    const session=sess(d.session),receipts=state.captures.filter(c=>c.session===(d.session||d.runId)).map(c=>({id:c.id,state:c.receipt,result:c.result}));
    return JSON.stringify(redact({task:d.brief,originalCapture:d.text,destination:{project:d.project,folder:proj(d.project)?.folder,session:d.session||d.runId,agent:d.mode==='nudge'?session?.agent:d.agent,model:modelPlanFor(d)},capture:d.captureId,lastFailure:d.handoffError,delivery:deliveryAudit(d),accounts:aiConnections.record(d),routing:{evidence:routingEvidence(d),preparationRequests:tasktapRoutingPayload(d)},reference:d.reference,peers:d.peerTasks,receipts}),null,2);
  }
  function diagnostics(){const d=draft;if(!d)return;d.reviewScreen='diagnostics';dialog('Diagnostics','Handoff','<section class="review-diagnostics"><p class="hint">Effective instructions, payloads, routing and receipt IDs. Recognizable credentials are redacted; connection secrets are never included.</p><pre id="review-diagnostics" tabindex="0"></pre><div class="form-actions">'+button('Back to review','review-return')+button('Copy diagnostics','review-copy','','btn')+button('Export diagnostics','review-export','','primary')+'</div></section>');$('#review-diagnostics').textContent=diagnosticText(d)}
  function peers(){const d=draft;d.reviewScreen='peers';const rows=projectPeers(d.project,d.mode==='nudge'?d.session:d.runId);dialog('Active work',proj(d.project)?.name||'Workspace','<ul class="review-peers">'+rows.map(s=>'<li><strong>'+esc(sessionDisplayName(s))+'</strong><span class="hint">'+esc([providers[s.agent],s.state].filter(Boolean).join(' · '))+'</span></li>').join('')+'</ul>'+button('Back to review','review-return','','primary'))}
  document.addEventListener('click',async event=>{
    const action=event.target.closest('[data-action]')?.dataset.action;if(!action?.startsWith('review-')||!draft)return;
    if(draft.submitting&&!['review-diagnostics','review-copy','review-export','review-return'].includes(action)){toast('Wait for this handoff to finish before editing.');return}
    if(action==='review-return')review();
    if(action==='review-task')task();
    if(action==='review-destination')destination();
    if(action==='review-context')context();
    if(action==='review-peers')peers();
    if(action==='review-diagnostics')diagnostics();
    if(action==='review-use-wording'&&draft.suggestedBrief)$('#review-task-text').value=draft.suggestedBrief;
    if(action==='review-copy'||action==='review-export'){
      const text=diagnosticText(draft);
      if(live){postLive(action==='review-copy'?'copy-diagnostics':'export-diagnostics',{text});return}
      if(action==='review-copy'){try{await navigator.clipboard.writeText(text);toast('Diagnostics copied.')}catch{toast('Select the diagnostics text to copy it.')}}
      else{const url=URL.createObjectURL(new Blob([text],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='tasktap-diagnostics.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
    }
  });
  return {show,task,destination,context,diagnostics,diagnosticText,pending};
})();
