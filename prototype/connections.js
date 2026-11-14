// Capture preparation and worker execution are billed independently.
const aiConnections = (() => {
  const routes = {
    local: ['On this Mac', 'Apple’s on-device model or local matching. No cloud usage.'],
    server: ['Model server', 'Connect Ollama, vLLM, LiteLLM or another compatible server.'],
    chatgpt: ['ChatGPT plan', 'Eligible plan allowance, with your consent through OpenAI.'],
    codex: ['Installed Codex', 'Uses the standard login of your local Codex CLI.'],
    openai: ['OpenAI API key', 'Usage is billed to the OpenAI project that owns the key.'],
    anthropic: ['Anthropic API key', 'Usage is billed to the Anthropic Console account that owns the key.'],
    cloud: ['Claude Code with cloud billing', 'Uses Claude Code with your configured Bedrock, Google Cloud or Foundry account.']
  };
  let config = {choice:'local', workers:{}, models:{}, keys:{}, accounts:[], account:'', cloud:''};
  let busy = false, editing = '', notice = '', refreshTimer;
  const serverTarget = () => ({kind:config.serverKind || 'ollama',...config.serverProfiles?.[config.serverKind]});
  const label = route => route==='server'?serverSetup.name(serverTarget().kind):routes[route]?.[0] || 'On this Mac';
  const sendDescription = route => route==='server'?serverSetup.description(serverTarget().kind,serverTarget().url || '',serverTarget().model):
    payer(route)+' may be used before the handoff review.';
  const account = () => config.accounts.find(a=>a.id===config.account);
  const payer = route => ({
    server:[serverTarget().url,serverTarget().model].filter(Boolean).join(' · '),
    chatgpt:account()?.label || 'ChatGPT plan', openai:'OpenAI project · saved API key',
    anthropic:'Anthropic Console · saved API key', cloud:config.cloud || 'Configured cloud account',
    codex:config.workers.codex || 'Codex CLI · billing source unverified', local:'No cloud usage'
  })[route];
  function worker(agent, external=false) {
    if (external) return 'Existing session · account managed in its original client';
    return (live ? config.workers[agent] || 'Billing source unverified' : 'Demo · no usage');
  }
  function receive(value,note='',finished=false,success=true) {
    config = value;
    if (finished) { busy=false;notice=note }
    if ($('#ai-settings')) {
      if (finished && !success && editing==='server' && $('#server-setup')) {
        for (const el of $('#ai-settings').elements) el.disabled=false;
        $('#ai-notice').textContent=note;
      } else if (finished) show(editing);
      else updateWorkers();
    }
    if ($('#preferences [data-ai-choice]')) $('#preferences [data-ai-choice]').textContent=label(config.choice);
    if ($('#handoff-accounts') && draft) $('#handoff-accounts').outerHTML=receipt(draft);
  }
  function jump() {
    return '<button type="button" class="settings-jump" data-action="ai-connections"><span class="jump-mark">'+icon('wifi')+'</span><span><strong>AI connections</strong><small data-ai-choice>'+esc(label(config.choice))+'</small></span>'+icon('right')+'</button>';
  }
  function updateWorkers() {
    for (const el of document.querySelectorAll('[data-worker-billing]')) el.textContent=worker(el.dataset.workerBilling);
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
      fields.push('<div class="inline">'+button('Continue with ChatGPT','ai-login',config.account)+
        (selectedAccount?button('Add account','ai-login','')+button('Manage usage','ai-usage')+
          (selectedAccount.status!=='signedOut'?button('Sign out','ai-disconnect'):''):'')+'</div><p class="hint">'+
        esc(selectedAccount?({enabled:'Plan usage enabled.',off:'Signed in. Plan usage needs consent.',signedOut:'Signed out on this Mac.'}[selectedAccount.status] || 'Check plan access.'):'Sign in with an eligible plan and allow Tasktap to use it.')+'</p>');
    }
    if (isKey) {
      fields.push(settingsField('ai-key',config.keys[chosen]?'Replace saved API key':'API key','<input id="ai-key" type="password" autocomplete="off" spellcheck="false" placeholder="'+(config.keys[chosen]?'Saved in Mac Keychain':'Stored in Mac Keychain')+'">'));
      if (config.keys[chosen]) fields.push(button('Remove saved key','ai-remove',chosen,'text-btn'));
    }
    if (chosen!=='local' && chosen!=='server') {
      fields.push(settingsField('ai-model',isKey?'Routing model ID':'Routing model ID (optional)','<input id="ai-model" autocomplete="off" spellcheck="false" value="'+attr(config.models[chosen] || ({openai:'gpt-5.4-mini',anthropic:'claude-haiku-5-5'}[chosen] ?? ''))+'" '+(isKey?'required placeholder="Model available to your account"':'placeholder="Provider default"')+'>'));
      if (chosen==='codex') fields.push('<p class="hint">Run <code>codex login</code> to choose your ChatGPT plan or API account. '+esc(payer(chosen))+'. Custom CLI provider profiles apply to workers.</p>');
      if (chosen==='cloud') fields.push('<p class="hint">'+esc(config.cloud?'Configured provider · '+config.cloud:'Configure one Claude Code cloud provider in the app environment first.')+'</p>');
    }
    const setup={claude:'claude auth login',codex:'codex login',agy:'agy'};
    const options=Object.keys(routes).map(k=>'<option value="'+attr(k)+'" data-detail="'+attr(routes[k][1])+'" '+(k===chosen?'selected':'')+'>'+esc(routes[k][0])+'</option>').join('');
    dialog('AI connections','Preferences','<form id="ai-settings" class="settings-form"><section class="settings-section">'+
      settingsField('ai-route','Prepare captures with','<select id="ai-route">'+options+'</select>')+
      (chosen==='server'?'':'<p class="hint">'+esc(routes[chosen][1])+'</p>')+fields.join('')+'</section>'+
      '<details class="route-evidence"><summary>Accounts used by workers</summary><p class="hint">Tasks open in your interactive agent. Its own sign-in and settings apply.</p><dl class="account-list">'+
      Object.entries(providers).map(([id,name])=>'<div><dt>'+esc(name)+'</dt><dd data-worker-billing="'+id+'">'+esc(worker(id))+'</dd><dd><code>'+setup[id]+'</code></dd></div>').join('')+'</dl>'+
      button('Refresh CLI status','ai-refresh','','text-btn')+'</details><p id="ai-notice" class="hint" role="status">'+esc(live?notice:'Preview only. Connect accounts in the Mac app.')+'</p>'+
      '<div class="form-actions">'+button('Back','prefs')+'<button class="primary" type="submit">Use this route</button></div></form>');
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
      if (a==='ai-refresh') {
        postLive(a);b.disabled=true;clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{b.disabled=false},1200);return;
      }
      request(a,{route:chosen,account:b.dataset.id||''});
    });
    if (!live || busy) for (const el of form.elements) {
      if (!live && !busy && el.closest('#server-setup') && !['server-discover','server-key'].includes(el.id)) continue;
      if (el.id!=='ai-route' && el.dataset.action!=='prefs') el.disabled=true;
    }
    settingsPickers.mount(form);
  }
  function accountSummary(d) {
    const agent=d.mode==='nudge'?sess(d.session)?.agent:d.agent;
    const sources=(d.remoteAttempts||[]).map(a=>a.label+' · '+a.account);
    const prep=sources.length?('Requested '+sources.join(' / ')+(['local','skipped'].includes(d.routingSource)?' · finished on this Mac':'')):'On this Mac · no cloud usage';
    const next=d.mode==='note'?'Local note · no worker':(providers[agent]||'Worker')+' · '+sessionHostLabel(d)+' · '+worker(agent,d.mode==='nudge');
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
  return {show,jump,receive,receipt,record,routingInstructions:()=>config.routingInstructions || '',serverTarget,sendDescription,label,payer,worker,choice:()=>config.choice};
})();
