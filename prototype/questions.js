// The producer supplies its own identifiers so retries and replies stay with one session.
function receiveAgentQuestion(event){
  const {requestId,sessionId,agent,workspace,question,detail='',choices,task}=event;
  const incoming=[requestId,sessionId,workspace,question];
  if(!Object.hasOwn(providers,agent)||incoming.some(s=>typeof s!=='string'||!s.trim())||
    typeof detail!=='string'||(choices && (!Array.isArray(choices)||choices.length<2||choices.length>12||choices.some(c=>typeof c!=='string'||!c.trim())||new Set(choices).size!==choices.length)))throw Error('Invalid question');
  const sessionKey=JSON.stringify([agent,workspace,sessionId]);
  const key=JSON.stringify([sessionKey,requestId]);
  let session=state.sessions.find(s=>s.producerKey===sessionKey);
  const answered=session?.answeredDecisions?.find(a=>a.producerKey===key);
  const pending=state.decisions.find(q=>q.producerKey===key);
  if(answered||pending){
    const r=answered||pending;
    if((r.question||r.q)!==question || JSON.stringify(r.choices)!==JSON.stringify(choices||['No','Yes']) || r.detail!==detail)throw Error('Request ID already used with different content');
    return {id:r.id,status:answered?'answered':'pending',...(answered?{answer:answered.answer}:{}),discussion:r.discussion||[]};
  }
  let project=state.projects.find(p=>p.folder===workspace);
  if(!project){
    project={id:uid(),name:workspace.split('/').filter(Boolean).at(-1)||workspace,folder:workspace,aliases:[],color:'#a8c3ae'};
    state.projects.push(project);
  }
  if(!session){
    session={id:uid(),producerKey:sessionKey,agent,project:project.id,task:task||sessionId,state:'Running',log:[]};
    state.sessions.push(session);
  }
  const q={id:uid(),producerKey:key,session:session.id,kind:choices?'choice':'binary',q:question,detail,choices:choices||['No','Yes']};
  session.state='Needs input';session.log.push('Asked: '+question);
  state.decisions.push(q);persist();render();
  return {id:q.id,status:'pending',discussion:[]};
}
