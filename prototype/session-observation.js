/* Provider lifecycle facts, shared by panes, navigation, Activity and the notch.
 * A finished turn is an answer, never a claim that the task succeeded.
 */
const sessionObservation=(()=>{
  const pending=new Map(),liveSeen=new Set(),navPulses=new Set();
  const labels={starting:'Starting',working:'Working',needsInput:'Needs input',needsPermission:'Needs permission',
    ready:'Ready',interrupted:'Interrupted',failed:'Failed',ended:'Ended'};
  const legacy={starting:'Awaiting agent',working:'Running',needsInput:'Needs input',needsPermission:'Needs input',
    ready:'Ready',interrupted:'Interrupted',failed:'Failed',ended:'Closed'};
  const supported=new Set(['claude','codex','pi','opencode']);
  function uses(d){return d?.mode==='nudge'?!!sess(d.session)?.monitoring:
    d?.mode==='ask'&&sessionHost(d)==='tasktap'&&supported.has(d.agent)}
  function get(id){
    const cached=pending.get(id),shared=sess(id)?.observation;
    if(!cached)return shared;if(!shared)return cached;
    return cached.launchId===shared.launchId
      ?(shared.sequence>cached.sequence?shared:cached)
      :(shared.updatedAt>cached.updatedAt?shared:cached);
  }
  function apply(s){const o=get(s?.id);if(o){s.observation=o;s.state=legacy[o.state];s.monitoring=true;if(s.agent==='claude'&&o.turn>0)s.startup='confirmed'}}
  const answerKey=(id,turn)=>'observer-answer:'+id+':'+turn;
  const unread=id=>{const o=get(id),reads=state.workspaceDeck?.observerReads||{};return (o?.answers||[]).some(a=>!reads[answerKey(id,a.turn)])};
  function cue(id){
    const o=get(id);if(!o)return null;
    let kind=o.state;
    if(['ready','ended'].includes(kind)&&unread(id))kind='complete';
    const kinds={needsInput:'input',needsPermission:'permission',failed:'failure',starting:'starting'};
    return {kind:kinds[kind]||kind,label:kind==='complete'?'Answer ready':labels[kind]||'Connected',
      symbol:({starting:'○',working:'◌',needsInput:'?',needsPermission:'◇',complete:'✓',ready:'○',interrupted:'Ⅱ',failed:'!',ended:'○'})[kind]||'○',
      activity:o.question||o.error||o.activity||'',token:o.launchId+':'+o.turn+':'+kind};
  }
  function receive(id,value,{restored=false}={}){
    let o;try{o=typeof value==='string'?JSON.parse(value):value}catch{return}
    if(!o||!Object.hasOwn(labels,o.state)||!Number.isFinite(o.sequence)||!o.launchId)return;
    const old=get(id);
    if(old?.launchId===o.launchId&&old.sequence>=o.sequence)return;
    if(old&&old.launchId!==o.launchId&&old.updatedAt>o.updatedAt)return;
    pending.set(id,o);
    const s=sess(id);if(s){
      s.monitoring=true;s.observation=o;s.state=legacy[o.state];
      if(o.providerSession)s.conversation=o.providerSession;
      if(s.agent==='claude'&&o.turn>0)s.startup='confirmed';
      s.observedAnswers??=[];
      if(typeof o.finalAnswer==='string'){
        s.observedAnswers=s.observedAnswers.filter(a=>a.turn!==o.turn).concat({turn:o.turn,text:o.finalAnswer,time:o.updatedAt}).slice(-20);
      }
    }
    const first=!(old||liveSeen.has(id));liveSeen.add(id);
    if(!restored&&['needsInput','needsPermission'].includes(o.state)&&old?.state!==o.state)navPulses.add(id);
    document.dispatchEvent(new CustomEvent('session-observation',{detail:{id,observation:o,previous:old,restored:restored||first&&o.event!=='turn_finished'}}));
  }
  function acknowledge(id){
    if(!id||!document.hasFocus()||document.hidden||document.querySelector('#modal[open]'))return false;
    const o=get(id);if(!o)return false;
    const saved=state.workspaceDeck; saved.observerReads??={};let changed=false;
    for(const a of o.answers||[]){const key=answerKey(id,a.turn);if(!saved.observerReads[key]){saved.observerReads[key]=Date.now();changed=true}}
    for(const event of saved.activity)if(event.id===id&&event.kind==='answer')event.read=true;
    if(changed){persist();document.dispatchEvent(new CustomEvent('session-acknowledged',{detail:{id}}))}
    return changed;
  }
  const attention=()=>state.sessions.filter(s=>['input','permission','failure','complete','interrupted'].includes(cue(s.id)?.kind));
  function animateNavigation(nav){
    for(const id of navPulses){
      navPulses.delete(id);
      if(document.hidden||matchMedia('(prefers-reduced-motion:reduce)').matches)continue;
      const s=sess(id),p=state.projects.find(p=>p.id===s?.project||p.folder===s?.project);
      const targets=[nav.querySelector('.nav-background-session[data-id="'+CSS.escape(id)+'"] .nav-background-symbol'),
        p&&nav.querySelector('[data-workspace="'+CSS.escape(p.id)+'"] .nav-workspace-status')].filter(Boolean);
      for(const node of targets)node.animate([{opacity:1},{opacity:.35},{opacity:1}],{duration:600,iterations:2,easing:'ease-in-out'});
    }
  }
  function details(id){
    const o=get(id),s=sess(id);if(!o)return '<p class="hint">'+esc(s?.monitoringCapability||'Live lifecycle monitoring is unavailable for this CLI. Process status remains available.')+'</p>';
    const c=cue(id),answers=(o.answers||[]).slice().reverse();
    const history=(o.history||[]).slice().reverse();
    const names={launch_started:'Starting CLI',session_started:'Session connected',turn_started:'Turn started',activity:'Tool started',continued:'Agent continued',assistant_text:'Assistant update',permission_requested:'Permission requested',input_requested:'Input requested',turn_finished:'Answer ready',turn_failed:'Turn failed',turn_interrupted:'Turn interrupted',process_exited:'Session ended'};
    return '<section class="observer-details" data-observer-details="'+attr(id)+'"><p class="observer-detail-state" data-state="'+c.kind+'">'+esc(c.symbol+' '+c.label)+'</p>'+
      (c.activity?'<p class="observer-detail-activity">'+esc(c.activity)+'</p>':'')+
      '<p class="hint">Answers are copied from the conversation. A finished turn does not establish task success. Questions and permissions shown by the CLI are answered in its terminal.</p>'+
      '<h3>Answers</h3>'+(answers.length?'<div class="observer-answer-list">'+answers.map(a=>button('Turn '+a.turn+' · '+new Date(a.time*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),'observer-answer',id+':'+a.turn,'btn','note')).join('')+'</div>':'<p class="hint">No finished answer yet.</p>')+
      '<h3>Session events</h3><ol class="observer-history">'+history.map(e=>'<li><time>'+esc(new Date(e.at*1000).toLocaleTimeString())+'</time><span>'+esc(names[e.kind]||e.kind)+(e.kind==='activity'&&e.activity?' · '+esc(e.activity):'')+'</span></li>').join('')+'</ol></section>';
  }
  function showAnswer(id,turn,text){
    const s=sess(id);if(typeof text!=='string')return;
    dialog('Answer · turn '+turn,s?sessionDisplayName(s):'Agent session','<p class="hint">Copied from the conversation; task success is not independently verified.</p><article class="observer-answer-body"></article>');
    workspaceDocuments.render($('.observer-answer-body'),text,{});
    state.workspaceDeck.observerReads??={};state.workspaceDeck.observerReads[answerKey(id,turn)]=Date.now();
    for(const item of state.workspaceDeck.activity)if(item.id===id&&item.turn===turn&&item.kind==='answer')item.read=true;
    persist();document.dispatchEvent(new CustomEvent('session-acknowledged',{detail:{id}}));
  }
  function openAnswer(id,turn){const cached=sess(id)?.observedAnswers?.find(a=>a.turn===turn);if(cached)showAnswer(id,turn,cached.text);else if(live)postLive('observer-answer',{id,turn})}
  document.addEventListener('click',e=>{
    const b=e.target.closest('[data-action="observer-answer"]');if(!b)return;
    const at=b.dataset.id.lastIndexOf(':'),id=b.dataset.id.slice(0,at),turn=Number(b.dataset.id.slice(at+1));
    openAnswer(id,turn);
  });
  return {uses,get,apply,receive,cue,unread,acknowledge,attention,animateNavigation,details,openAnswer,showAnswer,answerKey,labels};
})();
