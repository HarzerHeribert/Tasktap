// Capture preparation and worker execution are billed independently.
const aiConnections = (() => {
  const routes = {
    local: ['On this Mac', 'Prepares your request privately on this Mac.'],
    'claude-session': ['Claude Code', 'Draft your brief in Terminal using Claude Code’s own sign-in.'],
    server: ['Model server', 'Connect Ollama, vLLM, LiteLLM or another compatible server.'],
    chatgpt: ['ChatGPT plan', 'Eligible plan allowance, with your consent through OpenAI.'],
    codex: ['Installed Codex', 'Uses the account you signed in to Codex with.'],
    openai: ['OpenAI API key', 'Usage is billed to the OpenAI project that owns the key.'],
    anthropic: ['Anthropic API key', 'Usage is billed to the Anthropic Console account that owns the key.'],
    cloud: ['Claude Code with cloud billing', 'Uses Claude Code with your configured Bedrock, Google Cloud or Foundry account.']
  };
  let config = {choice:'local', workers:{}, models:{}, keys:{}, accounts:[], account:'', cloud:''};
  let loaded = false, busy = false, checking = false, editing = '', notice = '';
  const routeAgent=route=>({codex:'codex',cloud:'claude','claude-session':'claude'})[route];
  const health=id=>config.workerHealth?.[id] || 'checking';
  const needsSetup=id=>['missing','signedOut'].includes(health(id));
  const issue=id=>health(id)==='missing'?providers[id]+' wasn’t found on this Mac.':'Sign in to '+providers[id]+'.';
  const statusLabel=id=>({signedIn:'Signed in',configured:'Configured',installed:'Installed',missing:'Not found on this Mac',signedOut:'Sign-in needed',unknown:'Sign-in couldn’t be checked',checking:'Checking…'})[health(id)];
  function repair(id) {
    if(!needsSetup(id))return '';
    const missing=health(id)==='missing';
    const label=missing?'Installation guide':'Sign in';
    const accessible=missing?'Installation guide for '+providers[id]:'Sign in to '+providers[id];
    return '<button type="button" class="btn" data-action="'+(missing?'worker-install':'worker-login')+'" data-id="'+attr(id)+'" aria-label="'+attr(accessible)+'">'+icon('out')+label+'</button>';
  }
  function updateSetup(){
    const overview=$('#agent-setup-link');
    if(overview){
      const ids=[...new Set([sessionModelPolicy().defaultAgent,routeAgent(config.choice)])].filter(id=>id && needsSetup(id));
      const detail=overview.querySelector('small');
      detail.textContent=ids.map(issue).join(' ');
      detail.hidden=!ids.length;
      if(overview.classList.contains('needs-setup')!==!!ids.length){
        overview.classList.toggle('needs-setup',!!ids.length);
        overview.querySelector('.jump-mark').innerHTML=icon(ids.length?'bell':'settings');
      }
    }
    for(const field of document.querySelectorAll('[data-agent-health]')){
      const id=field.dataset.agentHealth;
      if(!id || field.dataset.health===health(id))continue;
      field.dataset.health=health(id);
      const actionFocused=field.contains(document.activeElement);
      if(field.classList.contains('agent-row')){
        field.querySelector('small').textContent=statusLabel(id);
        field.querySelector('.agent-action').innerHTML=repair(id);
      }else{
        field.hidden=!needsSetup(id);
        field.innerHTML=field.hidden?'':'<span>'+esc(issue(id))+'</span>'+repair(id);
      }
      if(actionFocused)(field.querySelector('button') || $('#check-agents') || $('#ai-route') || $('#default-agent'))?.focus({preventScroll:true});
    }
    const check=$('#check-agents');
    if(check){check.textContent=checking?'Checking…':'Check again';check.disabled=checking}
  }
  function refresh(){
    updateSetup();
    if(!live || checking)return;
    checking=true;updateSetup();postLive('ai-refresh');
  }
  function checked(){checking=false;updateSetup()}
  function setupField(id){
    return '<div class="agent-issue" data-agent-health="'+attr(id||'')+'" hidden></div>';
  }
  function setup(){
    const rows=Object.entries(providers).map(([id,name])=>'<li class="agent-row" data-agent-health="'+id+'">'+providerMark(id,false)+
      '<span class="agent-name"><strong>'+esc(name)+'</strong><small></small></span><span class="agent-action"></span></li>').join('');
    dialog('Agent setup','Preferences','<div class="settings-form"><ul class="agent-list">'+rows+'</ul>'+
      '<div class="form-actions">'+button('Back','prefs')+'<button type="button" id="check-agents" class="btn">Check again</button></div></div>');
    settingsHeader();
    $('#check-agents').onclick=refresh;
    refresh();
  }
  window.addEventListener('focus',()=>{
    if($('#agent-setup-link,#check-agents,#default-agent,#setup-agent') || $('#setup-prep-route') || routeAgent($('#ai-route')?.value))refresh();
  });
  const serverTarget = () => ({kind:config.serverKind || 'ollama',...config.serverProfiles?.[config.serverKind]});
  const label = route => route==='server'?serverSetup.name(serverTarget().kind):routes[route]?.[0] || 'On this Mac';
  const sendDescription = route => route==='server'?serverSetup.description(serverTarget().kind,serverTarget().url || '',serverTarget().model):
    payer(route)+' may be used before the handoff review.';
  const account = () => config.accounts.find(a=>a.id===config.account);
  const payer = route => ({
    server:[serverTarget().url,serverTarget().model].filter(Boolean).join(' · '),
    'claude-session':config.workers.claude || 'Check the account in Claude Code',
    chatgpt:account()?.label || 'ChatGPT plan', openai:'OpenAI project · saved API key',
    anthropic:'Anthropic Console · saved API key', cloud:config.cloud || 'Configured cloud account',
    codex:config.workers.codex || 'Codex CLI · billing source unverified', local:'No cloud usage'
  })[route];
  function worker(agent, external=false) {
    if (external) return 'Existing session · account managed in its original client';
    return (live ? config.workers[agent] || 'Billing source unverified' : 'Demo · no usage');
  }
  function receive(value,note='',finished=false,success=true,request='',account='') {
    config = value;loaded=true;
    document.dispatchEvent(new CustomEvent('connection-state',{detail:{finished,success,note,request,account}}));
    if (finished && !request) { busy=false;notice=note }
    if (!request && $('#ai-settings')) {
      if (finished && !success && editing==='server' && $('#server-setup')) {
        for (const el of $('#ai-settings').elements) el.disabled=false;
        $('#ai-notice').textContent=note;
      } else if (finished) show(editing);
    }
    if ($('#preferences [data-ai-choice]')) $('#preferences [data-ai-choice]').textContent=label(config.choice);
    updateSetup();
    if($('#rank-rows'))workerRouting.updateAmounts();
    if($('#worker-choice') && draft?.mode==='ask')workerRouting.updateReviewAmounts(draft);
    if ($('#handoff-accounts') && draft) $('#handoff-accounts').outerHTML=receipt(draft);
  }
  function jump() {
    return '<button type="button" class="settings-jump" data-action="ai-connections"><span class="jump-mark">'+icon('wifi')+'</span><span><strong>Request preparation</strong><small data-ai-choice>'+esc(label(config.choice))+'</small></span>'+icon('right')+'</button>';
  }
  function request(type,data) {
    if (busy) return;
    busy=true;
    for (const el of $('#ai-settings').elements) el.disabled=true;
    $('#ai-notice').textContent=type==='ai-login'?'Finish sign-in in your browser…':'Updating connection…';
    postLive(type,data);
  }
  function show(route=config.choice) {
    editing=Object.hasOwn(routes,route)?route:'local';
    const chosen=editing, isKey=['openai','anthropic'].includes(chosen), selectedAccount=account();
    const fields=[];
    if (chosen==='server') fields.push(serverSetup.markup(config));
    if (chosen==='chatgpt') {
      if (config.accounts.length) fields.push(settingsField('ai-account','ChatGPT account','<select id="ai-account">'+config.accounts.map(a=>option(a.id,a.label,config.account)).join('')+'</select>'));
      fields.push('<div class="inline">'+(selectedAccount?.status==='enabled'?'':button('Continue with ChatGPT','ai-login',config.account))+
        (selectedAccount?button('Add account','ai-login','')+button('Manage usage','ai-usage')+
          (selectedAccount.status!=='signedOut'?button('Sign out','ai-disconnect'):''):'')+'</div><p class="hint">'+
        esc(selectedAccount?({enabled:'Captures use this account’s plan allowance.',off:'Allow Tasktap to use this account’s plan.',signedOut:'Sign in to use this account again.'}[selectedAccount.status] || 'Check plan access.'):'Sign in with an eligible plan and allow Tasktap to use it.')+'</p>');
    }
    if (isKey) {
      fields.push(settingsField('ai-key',config.keys[chosen]?'Replace saved API key':'API key','<input id="ai-key" type="password" autocomplete="off" spellcheck="false" placeholder="'+(config.keys[chosen]?'Saved in Mac Keychain':'Stored in Mac Keychain')+'">'));
      if (config.keys[chosen]) fields.push(button('Remove saved key','ai-remove',chosen,'text-btn'));
    }
    if (chosen==='claude-session') fields.push(setupField('claude'),'<p class="prep-account">'+esc(payer(chosen))+'</p>');
    if (!['local','server','claude-session'].includes(chosen)) {
      const model=settingsField('ai-model','Preparation model','<input id="ai-model" autocomplete="off" spellcheck="false" value="'+attr(config.models[chosen] || ({openai:'gpt-5.4-mini',anthropic:'claude-haiku-5-5'}[chosen] ?? ''))+'" '+(isKey?'required placeholder="Model available to your account"':'placeholder="Provider default"')+'>');
      fields.push(isKey?model:'<details class="route-evidence"><summary>Model override</summary>'+model+'</details>');
      if (routeAgent(chosen)) fields.unshift(setupField(routeAgent(chosen)));
      if (chosen==='cloud') fields.push('<p class="hint">'+esc(config.cloud?'Configured provider · '+config.cloud:'Configure one Claude Code cloud provider in the app environment first.')+'</p>');
    }
    const options=Object.keys(routes).map(k=>'<option value="'+attr(k)+'" data-detail="'+attr(routes[k][1])+'" '+(k===chosen?'selected':'')+'>'+esc(routes[k][0])+'</option>').join('');
    dialog('Request preparation','Tasktap','<form id="ai-settings" class="settings-form"><section class="settings-section">'+
      settingsField('ai-route','Prepare requests with','<select id="ai-route">'+options+'</select>')+
      (chosen==='server'?'':'<p class="hint">'+esc(routes[chosen][1])+'</p>')+fields.join('')+'</section>'+
      '<p id="ai-notice" class="hint" role="status">'+esc(live?notice:'Preview only. Connect accounts in the Mac app.')+'</p>'+
      '<div class="form-actions">'+button('Back','prefs')+(chosen==='local' && config.choice==='local'?'':'<button class="primary" type="submit">Save connection</button>')+'</div></form>');
    settingsHeader();
    const form=$('#ai-settings');
    const server=chosen==='server'?serverSetup.mount(config):null;
    $('#ai-route').onchange=e=>{notice='';show(e.target.value)};
    if ($('#ai-account')) $('#ai-account').onchange=e=>request('ai-account',{account:e.target.value});
    form.onsubmit=e=>{
      e.preventDefault();
      if (!live) return;
      // Secrets are passed once to the native Keychain writer and never enter app state.
      if(server && $('#server-setup').dataset.phase!=='model') return;
      const key=server?server.key():$('#ai-key')?.value.trim() || '';
      if ($('#ai-key')) $('#ai-key').value='';
      request('ai-save',{route:chosen,key,...(server?{server:server.options()}:{}),model:$('#ai-model')?.value.trim() || ''});
    };
    form.addEventListener('click',e=>{
      const b=e.target.closest('[data-action^="ai-"]');
      if (!b || !live) return;
      const a=b.dataset.action;
      if (a==='ai-usage') {postLive(a);return}
      request(a,{route:chosen,account:b.dataset.id||''});
    });
    if (!live || busy) for (const el of form.elements) {
      if (!live && !busy && el.closest('#server-setup') && !['server-discover','server-key'].includes(el.id)) continue;
      if (el.id!=='ai-route' && el.dataset.action!=='prefs') el.disabled=true;
    }
    settingsPickers.mount(form);
    if(routeAgent(chosen))refresh();
  }
  function accountSummary(d) {
    const agent=d.mode==='nudge'?sess(d.session)?.agent:d.agent;
    const sources=(d.remoteAttempts||[]).map(a=>a.label+' · '+a.account);
    const prep=d.directPreparation?('Claude Code · '+d.directPreparation.account+(d.routingSource==='claude-session'?' · reviewed brief':' · original wording used')):sources.length?('Requested '+sources.join(' / ')+(['local','skipped'].includes(d.routingSource)?' · finished on this Mac':'')):'On this Mac · no cloud usage';
    const next=d.mode==='ask' && d.noPick?'Choose an agent':d.mode==='note'?'Local note · no worker':(providers[agent]||'Worker')+' · '+sessionHostLabel(d)+' · '+worker(agent,d.mode==='nudge');
    return {prep,next};
  }
  function receipt(d) {
    const {prep,next}=accountSummary(d);
    return '<div id="handoff-accounts" class="handoff-accounts"><span><b>Preparation</b> '+esc(prep)+'</span><span><b>On confirm</b> '+esc(next)+'</span></div>';
  }
  function record(d) {
    const {prep,next}=accountSummary(d);
    return 'Preparation · '+prep+'\nHandoff · '+next;
  }
  return {snapshot:()=>config,loaded:()=>loaded,routes,health,show,jump,setup,setupField,refresh,checked,updateSetup,receive,receipt,record,routingInstructions:()=>config.routingInstructions || '',serverTarget,sendDescription,label,payer,worker,choice:()=>config.choice};
})();
