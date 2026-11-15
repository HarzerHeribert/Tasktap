// Choose a worker only for a new session. The worker's subscription is independent of capture preparation.
const workerRouting = (() => {
  let snapshot = {}, pending = false, receivedAt = 0, timeout;
  const supported = id => Object.hasOwn(providers,id);
  const healthy = id => ['signedIn','configured','installed'].includes(aiConnections.health(id));
  const unavailable = id => ['missing','signedOut'].includes(aiConnections.health(id));
  function policy(){
    const saved=state.workerRouting || {}, defaultAgent=sessionModelPolicy().defaultAgent;
    const ranked=Array.isArray(saved.ranked)?saved.ranked:[defaultAgent,...['claude','codex']];
    const reserve=Number.isInteger(saved.reserve)?Math.max(0,Math.min(100,saved.reserve)):10;
    return {automatic:saved.automatic===true, ranked:[...new Set(ranked.filter(supported))],reserve};
  }
  function limiting(id, now=Date.now()/1000){
    if(!Number.isFinite(snapshot.checkedAt) || now-snapshot.checkedAt>300 || snapshot.checkedAt>now+5)return null;
    const windows=(snapshot.agents?.[id] || []).filter(w=>Number.isInteger(w.remaining) && w.remaining>=0 && w.remaining<=100 && w.resetsAt>now);
    return windows.reduce((min,w)=>!min || w.remaining<min.remaining?w:min,null);
  }
  function allowance(id){
    const w=limiting(id);
    if(!w)return 'Quota unavailable';
    const period=w.minutes===10080?'weekly':w.minutes===300?'5-hour':w.minutes>0?w.minutes+'-minute':'plan';
    return w.remaining+'% left · '+period+' limit';
  }
  function recommend(p){
    const active=p.ranked.filter(healthy);
    const first=active.find(id=>{const w=limiting(id);return w && w.remaining>0 && w.remaining>=p.reserve});
    if(first){
      const skipped=active.slice(0,active.indexOf(first)).find(id=>limiting(id));
      const reason=skipped?providers[skipped]+' has '+limiting(skipped).remaining+'% left. Using '+providers[first]+' to keep your '+p.reserve+'% reserve.':'First in your order that meets the reserve.';
      return {id:first,reason};
    }
    const unknown=active.find(id=>!limiting(id));
    if(unknown)return {id:unknown,reason:'First available in your order with unreported quota.'};
    return {id:'',reason:active.length?'Your ranked agents are below reserve. Choose one to use for this task.':'Choose an available agent for this task.'};
  }
  function prepare(d){
    if(!live || d.mode!=='ask')return;
    const p=policy();
    d.usingRank=p.automatic && !d.agentChoice && !d.modelOverride?.value;
    request();
    if(d.usingRank){
      const pick=recommend({...p,reserve:d.reserve ?? p.reserve});
      d.noPick=pending || !pick.id;
      d.workerReason=pending?'Checking remaining usage…':pick.reason;
      if(!d.noPick)d.agent=pick.id;
    }else{
      d.noPick=false;
      d.workerReason=d.agentChoice==='manual'?'Chosen for this handoff.':d.agentChoice==='named'?'Named in your request.':'';
    }
  }
  function request(){
    if(!live || pending || Date.now()-receivedAt<120000)return;
    pending=true;
    postLive('worker-usage');
    timeout=setTimeout(()=>receive({}),15000);
  }
  function receive(data){
    clearTimeout(timeout);pending=false;receivedAt=Date.now();snapshot=data||{};
    if($('#rank-rows'))updateAmounts();
    if(!$('#worker-choice,#worker-summary')?.closest('dialog[open]') || !draft || draft.submitting)return;
    if(draft.usingRank && draft.noPick){
      const expanded=draft.reviewScreen==='destination', control=document.activeElement?.id;
      const reserve=expanded?$('#review-reserve')?.value:null;
      if(draft.reviewScreen==='destination')handoffReview.destination();else review();
      if(expanded){
        if(reserve!=null && $('#review-reserve'))$('#review-reserve').value=reserve;
        if(control)document.getElementById(control)?.focus({preventScroll:true});
      }
      return;
    }
    updateReviewAmounts(draft);
  }
  function canStart(d){
    if(d.noPick || unavailable(d.agent))return false;
    if(d.usingRank && Date.now()-receivedAt>=120000){
      review();
      return false;
    }
    return true;
  }
  const jump=()=>'<button type="button" class="settings-jump" data-action="worker-routing"><span class="jump-mark">'+icon('checks')+'</span><span><strong>Agent routing</strong><small>'+esc(policy().automatic?'Ranked by preference and quota':'Use my default agent')+'</small></span>'+icon('right')+'</button>';
  function updateAmounts(){
    for(const el of document.querySelectorAll('[data-worker-amount]')){
      const id=el.dataset.workerAmount;
      el.textContent=unavailable(id)?(aiConnections.health(id)==='missing'?'Not installed':'Sign-in needed'):pending?'Checking…':allowance(id);
    }
  }
  function reserveField(id,value){
    return settingsField(id,'Keep in reserve (%)','<input id="'+id+'" type="number" inputmode="numeric" min="0" max="100" step="1" required value="'+value+'">');
  }
  function settings(){
    const p=policy();
    dialog('Agent routing','Preferences','<form id="worker-settings" class="settings-form"><section class="settings-section">'+
      '<label class="policy-switch" for="rank-enabled"><span>Choose by remaining usage</span><input id="rank-enabled" type="checkbox" '+(p.automatic?'checked':'')+'></label>'+
      '<div id="rank-options" class="settings-section">'+reserveField('rank-reserve',p.reserve)+'<fieldset class="rank-list"><legend>Agent order</legend><p class="hint">Tasktap tries checked agents from the top. An agent with unknown quota is a fallback.</p><div id="rank-rows"></div></fieldset></div>'+
      '</section><div class="form-actions">'+button('Cancel','prefs')+'<button class="primary">Save routing</button></div></form>');
    settingsHeader();
    const order=[...p.ranked,...Object.keys(providers).filter(id=>!p.ranked.includes(id))];
    const enabled=new Set(p.ranked), form=$('#worker-settings');
    const renderRows=()=>{
      $('#rank-rows').innerHTML=order.map((id,i)=>{
        const arrow=(direction,label,disabled)=>'<button type="button" class="rank-arrow" data-move="'+direction+'" aria-label="Move '+esc(providers[id])+' '+label+'" '+(disabled?'disabled':'')+'>'+icon(direction===-1?'up':'down')+'</button>';
        return '<div class="rank-row" data-id="'+id+'"><label><input type="checkbox" '+(enabled.has(id)?'checked':'')+'><span>'+esc(providers[id])+'<small data-worker-amount="'+id+'"></small></span></label>'+arrow(-1,'up',i===0)+arrow(1,'down',i===order.length-1)+'</div>';
      }).join('');updateAmounts();
    };
    function toggle(){
      $('#rank-options').hidden=!$('#rank-enabled').checked;
      $('#rank-reserve').disabled=$('#rank-options').hidden;
      if(!$('#rank-options').hidden){aiConnections.refresh();request();renderRows()}
    }
    $('#rank-enabled').onchange=toggle;
    $('#rank-rows').onchange=e=>{
      const id=e.target.closest('.rank-row').dataset.id;
      if(e.target.checked)enabled.add(id);else enabled.delete(id);
    };
    $('#rank-rows').onclick=e=>{
      const b=e.target.closest('button[data-move]');if(!b)return;
      const id=b.closest('.rank-row').dataset.id,i=order.indexOf(id),next=i+Number(b.dataset.move);
      if(next<0 || next>=order.length)return;
      [order[i],order[next]]=[order[next],order[i]];renderRows();
      const row=$('.rank-row[data-id="'+id+'"]');
      (row.querySelector('[data-move="'+b.dataset.move+'"]:enabled') || row.querySelector('input')).focus();
    };
    form.onsubmit=e=>{
      e.preventDefault();
      if($('#rank-enabled').checked && !enabled.size){toast('Choose at least one agent.');return}
      state.workerRouting={automatic:$('#rank-enabled').checked,reserve:Number($('#rank-reserve').value),ranked:order.filter(id=>enabled.has(id))};
      persist();prefs();toast('Agent routing saved.');
    };
    toggle();
  }
  function reviewMarkup(d){
    const p=policy();
    const choices=Object.entries(providers).map(([id,name])=>'<option value="'+attr(id)+'" '+(!d.noPick && id===d.agent?'selected':'')+'>'+esc(name)+'</option>').join('');
    return '<div class="worker-review"><p class="hint" id="worker-pick" role="status"></p><div id="worker-choice" class="settings-section"><div class="settings-section">'+
      settingsField('review-worker','Agent','<select id="review-worker">'+(d.noPick?option('','Choose an agent',''):'')+choices+'</select>')+
      '<p class="hint" id="worker-quota"></p>'+settingsField('model-review-override','Model for this session',modelInput(d.agent,'review-override',d.modelOverride?.agent===d.agent?d.modelOverride.value:'',modelPlanFor({...d,modelOverride:null}).label))+modelSuggestions(d.agent)+
      (p.automatic?reserveField('review-reserve',d.reserve ?? p.reserve)+button('Apply ranking','apply-ranking','','btn'):'')+'</div></div></div>';
  }
  function updateReviewAmounts(d){
    for(const opt of $('#review-worker')?.options||[]){
      if(!opt.value)continue;
      opt.dataset.detail=unavailable(opt.value)?(aiConnections.health(opt.value)==='missing'?'Not installed':'Sign-in needed'):pending?'Checking…':allowance(opt.value);
    }
    const blocked=unavailable(d.agent);
    const evidence=limiting(d.agent)?allowance(d.agent):'';
    const line=$('#worker-pick');
    if(!line)return;
    line.textContent=d.noPick?d.workerReason:blocked?(providers[d.agent]+(aiConnections.health(d.agent)==='missing'?' isn’t installed.':' needs sign-in.')):[d.workerReason,evidence].filter(Boolean).join(' ');
    line.hidden=!line.textContent || line.dataset.summary==='true'&&!d.noPick&&!blocked&&!(d.usingRank&&(d.agent!==sessionModelPolicy().defaultAgent||/Using /.test(d.workerReason)))&&!(limiting(d.agent)?.remaining<(d.reserve??policy().reserve));
    const window=limiting(d.agent);
    const reset=window?' · resets '+new Date(window.resetsAt*1000).toLocaleString(undefined,{weekday:'short',hour:'numeric',minute:'2-digit'}):'';
    if($('#worker-quota'))$('#worker-quota').textContent=d.noPick?'Select an agent to see its quota.':blocked?line.textContent:pending?'Checking remaining usage…':allowance(d.agent)+reset;
    const start=$('#modal [data-action="commit-review"]');if(start)start.disabled=!!d.noPick || blocked;
  }
  function bindReview(d){
    const details=$('#worker-choice');
    $('#model-review-override').disabled=!!d.noPick;
    aiConnections.refresh();request();
    const redraw=id=>{
      if(draft.reviewScreen==='destination')handoffReview.destination();else review();document.getElementById(id)?.focus({preventScroll:true});
    };
    $('#review-worker').onchange=e=>{
      if(!e.target.value)return;
      d.agent=e.target.value;d.agentChoice='manual';delete d.modelOverride;redraw('review-worker');
    };
    $('#model-review-override').oninput=e=>{
      d.modelOverride={agent:d.agent,value:e.target.value.trim()};d.agentChoice='manual';
      d.usingRank=false;d.workerReason='Chosen for this handoff.';
      const current=$('#review-model');if(current)current.outerHTML=modelReviewMarkup(d);updateReviewAmounts(d);
    };
    const apply=$('[data-action="apply-ranking"]',details);
    if(apply)apply.onclick=()=>{
      const reserve=$('#review-reserve');if(!reserve.reportValidity())return;
      d.reserve=Number(reserve.value);delete d.agentChoice;delete d.modelOverride;redraw('review-worker');
    };
    updateReviewAmounts(d);
    settingsPickers.mount(details);
  }
  const summaryMarkup=()=>'<div id="worker-summary"><p class="hint" id="worker-pick" data-summary="true" role="status"></p></div>';
  return {jump,settings,prepare,reviewMarkup,summaryMarkup,bindReview,canStart,receive,updateAmounts,updateReviewAmounts};
})();
