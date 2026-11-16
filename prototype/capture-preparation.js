// Preparation sees bounded Tasktap context, never terminal contents or arbitrary files.
const capturePreparation=(()=>{
  const clip=(value,max)=>String(value||'').slice(0,max);
  const eligible=s=>s && proj(s.project) && !['Closed','Failed','Unavailable','Interrupted','notLoaded','Opening','Queued','Awaiting agent'].includes(s.state) && (live?canNudge(s):s.state!=='Complete') && proj(s.project).available!==false;
  function context(d){
    const named=matchProjects(d.text);
    const lockedProject=d.projectChoice || d.contextProject || (!d.suggestedProject && (d.sessionProject || d.captureProject)) || (named.length===1?named[0].id:'');
    const project=lockedProject;
    const available=state.sessions.filter(s=>eligible(s) && (!project || s.project===project));
    const recent=state.captures.filter(c=>available.some(s=>s.id===c.session)).slice(0,3);
    const matches=matchSessions(d.text);
    const sessions=[...available].sort((a,b)=>{
      const score=s=>(s.id===d.session?100:0)+(matches.includes(s)?20:0)+(recent.some(c=>c.session===s.id)?10:0);
      return score(b)-score(a) || (b.updatedAt||b.namedAt||0)-(a.updatedAt||a.namedAt||0);
    }).slice(0,8);
    const projects=[...state.projects.filter(p=>p.available!==false && (!project || p.id===project))].sort((a,b)=>{
      const score=p=>(p.id===project?100:0)+(named.includes(p)?20:0)+(p.id===d.visibleProject?15:0)+(sessions.some(s=>s.project===p.id)?10:0);
      return score(b)-score(a);
    }).slice(0,8);
    const input={capture:d.text,estimateDifficulty:d.mode==='ask' && sessionModelPolicy().adaptive,currentWorkspace:projects.findIndex(p=>p.id===d.visibleProject),
      projects:projects.map((p,i)=>({index:i,name:clip(p.name,100),aliases:(p.aliases||[]).slice(0,3).map(a=>clip(a,60))})),
      sessions:sessions.map((s,i)=>({index:i,name:clip(sessionDisplayName(s),140),originalTask:clip(s.task,180),
        project:projects.findIndex(p=>p.id===s.project),agent:s.agent,state:s.state,delivery:manualNudge({...d,mode:'nudge',session:s.id})?'manual':'automatic'})),
      recentCaptures:recent.filter(c=>sessions.some(s=>s.id===c.session)).map(c=>({session:sessions.findIndex(s=>s.id===c.session),
        request:clip(c.brief||c.text,320),state:c.receipt,result:clip(c.result,160)})),
      selection:{project:projects.findIndex(p=>p.id===lockedProject),session:sessions.findIndex(s=>s.id===d.sessionChoice),
        mode:d.sessionChoice?'nudge':d.explicitMode && !(d.guide==='start' && d.suggestedProject)?d.mode:''}};
    return {input,projects:projects.map(p=>({...p})),sessions:sessions.map(s=>({...s})),lockedProject};
  }
  function apply(d,pending,result){
    d.routeFallback=!!result.routeFallback;
    if(d.routeFallback && !d.sessionChoice && d.mode==='nudge'){d.session='';d.candidates=[]}
    if(typeof result.brief==='string' && result.brief.trim() && result.brief.length<=16000 && !d.taskEdited){
      // Models sometimes echo candidate indexes. Resolve only references absent from the capture.
      d.preparedBrief=result.brief.trim().replace(/\b(session|project)\s+(\d+)\b/gi,(match,kind,index)=>{
        if(d.text.toLocaleLowerCase().includes(match.toLocaleLowerCase()))return match;
        const row=(kind.toLowerCase()==='session'?pending.sessions:pending.projects)[Number(index)];
        return row?(kind.toLowerCase()==='session'?sessionDisplayName(row):row.name):match;
      });
      const normalize=text=>text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
      const constraints=Array.isArray(result.constraints)?result.constraints:[];
      const retained=[];
      for(const value of constraints.slice(0,12)){
        if(typeof value!=='string')continue;
        const quote=value.trim();
        if(quote.length<3 || quote.length>1000 || !d.text.includes(quote))continue;
        if(!normalize(d.preparedBrief+' '+retained.join(' ')).includes(normalize(quote)))retained.push(quote);
      }
      if(retained.length)d.preparedBrief+='\n\n'+retained.map(quote=>'• '+quote).join('\n');
      d.brief=d.preparedBrief;
    }
    // Older providers can still improve wording, but cannot silently select a destination.
    if(!['ask','note','nudge'].includes(result.mode) || !['clear','ambiguous','unknown'].includes(result.routeConfidence))return;
    const {projects,sessions,lockedProject,input}=pending;
    const currentProject=p=>p && proj(p.id)?.available!==false && proj(p.id)?.folder===p.folder;
    const sessionAt=i=>Number.isInteger(i) && sessions[i] && eligible(sess(sessions[i].id)) && sess(sessions[i].id).project===sessions[i].project?sess(sessions[i].id):null;
    const projectAt=i=>Number.isInteger(i) && currentProject(projects[i])?projects[i]:null;
    const selected=d.sessionChoice?sess(d.sessionChoice):null;
    if(selected){d.mode='nudge';d.session=selected.id;d.project=selected.project;return}
    const mode=input.selection.mode || result.mode;
    const validSession=s=>s && (!lockedProject || s.project===lockedProject);
    const quote=typeof result.routeQuote==='string'?result.routeQuote.trim():'';
    const evidence=typeof result.routeEvidence==='string'?result.routeEvidence.trim():'';
    const s=sessionAt(result.session), p=projectAt(result.project);
    const related=input.recentCaptures.filter(c=>c.session===result.session).map(c=>c.request);
    const sources=[input.capture,...related,...(s?[sessionDisplayName(s),s.task]:[]),...(p?[p.name]:[])];
    const evidenced=result.routeConfidence==='clear' && !String(result.question||'').trim() && quote.length>=3 && evidence && sources.some(text=>text.toLocaleLowerCase().includes(quote.toLocaleLowerCase()));
    d.mode=mode;d.session='';d.candidates=[];delete d.routeMatch;delete d.routeQuestion;delete d.projectCandidates;
    // A tentative lexical match must not survive a model's ambiguity or correction.
    if(!lockedProject)d.project='';
    if(evidenced && mode==='nudge' && validSession(s) && (!p || p.id===s.project) && [sessionDisplayName(s),s.task,...related].some(name=>name && evidence.includes(name))){
      d.session=s.id;d.project=s.project;
      d.routeMatch={reason:clip(evidence,400),quote:clip(quote,200),session:s.id,project:s.project};
    }else if(evidenced && mode!=='nudge' && p && (!lockedProject || lockedProject===p.id) && evidence.includes(p.name)){
      d.project=p.id;d.routeMatch={reason:clip(evidence,400),quote:clip(quote,200),project:p.id};
    }
    if(mode==='nudge' && !d.session){
      const candidates=result.routeConfidence==='ambiguous' && Array.isArray(result.sessionCandidates)?result.sessionCandidates:[];
      d.candidates=[...new Set(candidates.map(sessionAt).filter(validSession).map(s=>s.id))];
      if(result.routeConfidence==='ambiguous' && d.candidates.length>1)d.routeQuestion=d.candidates.length===2?'Send this to '+sessionDisplayName(sess(d.candidates[0]))+' or '+sessionDisplayName(sess(d.candidates[1]))+'?':'Which conversation should receive this follow-up?';
    }else if(!d.project){
      const candidates=result.routeConfidence==='ambiguous' && Array.isArray(result.projectCandidates)?result.projectCandidates:[];
      d.projectCandidates=[...new Set(candidates.map(projectAt).filter(Boolean).map(p=>p.id))];
      if(result.routeConfidence==='ambiguous' && d.projectCandidates.length>1)d.routeQuestion='Which workspace is this task for?';
    }
  }
  return {context,apply};
})();
