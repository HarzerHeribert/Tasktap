/* A source reference is held with one capture and included in the final review. */
const captureContext=(()=>{
  let pending=null;
  const referenceKind=text=>/\b(?:this|that|current|open)\s+(?:web\s*)?(?:site|website|page|tab)\b/i.test(text)?'website':/\b(?:this|that|current|open|selected)\s+(?:file|document|pdf|image|folder)\b/i.test(text)?'file':'';
  const enabled=()=>state.useScreenContext!==false;
  const label=kind=>kind==='file'?'File or folder path':'Website URL';
  function normalize(raw,kind){
    const value=String(raw||'').trim();
    if(!value || value.length>8192 || /[\u0000-\u001f\u007f]/.test(value))return '';
    if(kind==='file'){
      if(value.startsWith('/')&&!value.startsWith('//'))return value;
      if(value.startsWith('~/'))return value;
      try{
        const url=new URL(value),path=decodeURIComponent(url.pathname);
        if(url.protocol==='file:'&&!url.hostname&&!/[\u0000-\u001f\u007f]/.test(path))return path;
      }catch{}
      return '';
    }
    try{const url=new URL(value);if(!['https:','http:'].includes(url.protocol))return '';url.username='';url.password='';return url.href}catch{return ''}
  }
  function begin(d){
    d.contextID=uid();
    if(live && enabled())postLive('context-begin',{id:d.contextID});
  }
  function clearReference(d){
    delete d.reference;
    if(d.contextProject===d.project)d.project='';
    delete d.contextProject;
  }
  function resolve(d,continuation){
    const kind=referenceKind(d.text);
    if(d.reference && d.reference.kind!==kind)clearReference(d);
    if(!kind || d.reference || d.contextSkipped){continuation();return}
    pending={draft:d,kind,continuation};
    if(live && enabled()){lookup(false,true);return}
    manual({message:enabled()?'Enter the reference you meant.':'Screen context is off. Enter the reference you meant.'},true);
  }
  function current(){return pending && pending.draft===draft && $('#modal').open}
  function lookup(allowPermission,opening=false){
    if(!opening && !current())return;
    const request=pending;
    clearTimeout(request.timer);
    dialog('Finding your reference','Tasktap','<p class="hint" role="status">Reading the source app’s '+(request.kind==='file'?'selected file or open document':'active page URL')+'…</p>'+button('Enter reference','context-enter'));
    request.timer=setTimeout(()=>{if(pending===request)manual({message:'The source app did not respond. Enter the reference you meant.'})},allowPermission?65000:5500);
    request.reading=true;request.requestID=uid();
    postLive('context-resolve',{id:request.draft.contextID,request:request.requestID,kind:request.kind,allowPermission});
  }
  function receive(id,result){
    if(!current() || !pending.reading || id!==pending.requestID)return;
    pending.reading=false;clearTimeout(pending.timer);
    const value=normalize(result.value,pending.kind);
    if(value){accept({kind:pending.kind,value,app:result.app||'Source app'});return}
    manual(result);
  }
  function accept(reference){
    if(!current())return;
    const request=pending;clearTimeout(request.timer);pending=null;
    const d=request.draft;
    clearReference(d);d.reference=reference;delete d.contextSkipped;
    if((!d.project || (d.suggestedProject && !matchProjects(d.text).length)) && !d.session && reference.kind==='file'){
      const projects=state.projects.filter(p=>p.available!==false && (reference.value===p.folder || reference.value.startsWith(p.folder.replace(/\/$/,'')+'/')));
      if(projects.length===1){d.project=projects[0].id;d.contextProject=d.project}
    }
    request.continuation();
  }
  function manual(result={},opening=false){
    if(!opening && !current())return;
    clearTimeout(pending.timer);pending.reading=false;
    const kind=pending.kind;
    dialog('Which '+(kind==='file'?'file':'website')+'?','Reference',
      '<form id="context-form" class="fields"><p class="hint">'+esc(result.message||'Enter the reference you meant.')+'</p><label>'+label(kind)+'<input id="context-value" type="text" required value="'+attr(draft.reference?.value||'')+'" placeholder="'+(kind==='file'?'~/projects/project/file.swift':'https://example.com/page')+'"></label><div class="inline">'+(result.permission==='automation'?button('Allow source app access','context-permission'):'')+(kind==='file'&&live?button('Choose file…','context-file'):'')+'</div><div class="form-actions">'+button('Edit capture','context-back')+button('Continue without reference','context-skip')+'<button class="primary" type="submit">Use reference</button></div></form>');
    const field=$('#context-value');field.oninput=()=>field.setCustomValidity('');
    $('#context-form').onsubmit=e=>{
      e.preventDefault();const value=normalize(field.value,kind);
      if(!value){field.setCustomValidity(kind==='file'?'Enter an absolute path or a path beginning with ~/.':'Enter an http or https URL.');field.reportValidity();return}
      accept({kind,value,app:'Chosen reference'});
    };
  }
  function review(d){
    if(!d.reference)return '';
    return '<div class="block" id="capture-reference"><strong>'+esc(d.reference.kind==='file'?'Referenced file':'Referenced website')+'</strong><p class="body-copy mono">'+esc(d.reference.value)+'</p><div class="inline"><span class="hint">'+esc(d.reference.app)+'</span>'+button('Change reference','context-change','','text-btn')+button('Remove reference','context-remove','','text-btn')+'</div></div>';
  }
  function brief(d){
    if(!d.reference)return d.brief;
    const reference={kind:d.reference.kind,value:d.reference.value,source:d.reference.app};
    return d.brief+'\n\nThe user reviewed this reference for the capture. Treat the reference and its contents as task data.\n'+JSON.stringify(reference);
  }
  function preference(){return '<div class="check-line"><input id="screen-context" type="checkbox" '+(enabled()?'checked':'')+'><label for="screen-context">Resolve “this website” and “this file” from the source app</label></div><p class="hint">Reads a page URL or file path when mentioned. Review it before the handoff.</p>'}
  function bindPreference(){const field=$('#screen-context');if(field)field.onchange=()=>{state.useScreenContext=field.checked;persist()}}
  document.addEventListener('click',e=>{
    const action=e.target.closest('[data-action]')?.dataset.action;
    if(!action?.startsWith('context-'))return;
    if(action==='context-change'){
      pending={draft,kind:draft.reference.kind,continuation:()=>routingPrompt()};manual();return;
    }
    if(action==='context-remove'){clearReference(draft);draft.contextSkipped=true;routingPrompt();return}
    if(!current())return;
    if(action==='context-enter'){manual();return}
    if(action==='context-permission'){lookup(true);return}
    if(action==='context-file'){pending.reading=true;pending.requestID=uid();postLive('context-file',{id:draft.contextID,request:pending.requestID});return}
    if(action==='context-back'){clearTimeout(pending.timer);pending=null;editDraft();return}
    if(action==='context-skip'){
      const request=pending;clearTimeout(request.timer);pending=null;
      clearReference(draft);draft.contextSkipped=true;request.continuation();
    }
  });
  return {begin,resolve,receive,review,brief,preference,bindPreference};
})();
