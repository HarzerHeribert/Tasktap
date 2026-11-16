// The wizard owns its unsaved form. The native bridge owns accounts, keys and the active route.
const setupPreparation=(()=>{
  const servers=['ollama','vllm','litellm','custom'];
  const routes={local:'On this Mac','claude-session':'Claude Code',codex:'My Codex login',ollama:'Ollama',vllm:'vLLM',litellm:'LiteLLM',custom:'Other model server',
    chatgpt:'ChatGPT plan',openai:'OpenAI API key',anthropic:'Anthropic API key',cloud:'Claude Code with cloud billing'};
  const config=aiConnections.snapshot;
  const current=()=>config().choice==='server'?(config().serverKind||'ollama'):config().choice;
  const nativeRoute=id=>servers.includes(id)?'server':id;
  const common=['local','claude-session','codex','ollama'];
  function routeOptions(p){
    const ids=p.more || !common.includes(p.id)?Object.keys(routes):common;
    const descriptions={local:'Private request matching and short briefs on this Mac.',ollama:'Run downloaded models locally; cloud models send requests upstream.', 'claude-session':'Draft together in Claude Code using its signed-in account.',codex:'Use your Codex account to prepare a brief.',chatgpt:'Use a connected ChatGPT plan.',openai:'Paid OpenAI API usage.',anthropic:'Paid Anthropic API usage.',cloud:'Claude Code through a cloud provider.',vllm:'Connect to a model server you manage.',litellm:'Connect to a gateway that may forward to cloud providers.',custom:'Connect to another compatible model server.'};
    return [['Local on this Mac',['local']],['Cloud accounts',['claude-session','codex','chatgpt','openai','anthropic','cloud']],['Local or remote servers',servers]].map(([label,group])=>'<optgroup label="'+label+'">'+group.filter(id=>ids.includes(id)).map(id=>option(id,routes[id],p.id).replace('<option ','<option data-detail="'+attr(descriptions[id])+'" ')).join('')+'</optgroup>').join('')+(ids===common?option('more','More connections…',p.id):'');
  }
  const create=()=>({id:null,form:null,server:null,touched:false,account:'',identityId:'',email:'',login:''});
  const active=()=>setupWizard.preparation();
  const known=()=>!live || aiConnections.loaded();
  const selected=(p)=>p.id || current();
  const isKey=id=>id==='openai' || id==='anthropic';
  const account=p=>config().accounts.find(a=>a.id===p.account);
  function notice(p,message,validation=false){
    const el=p.form?.querySelector('.prep-notice');
    if(el){el.textContent=message;el.dataset.validation=String(validation)}
  }
  function identity(id,label){
    const p=active();
    if(!p || !id || p.identityId!==id)return;
    p.email=typeof label==='string'?label:'';
    refresh(p);
  }
  function identify(p){
    if(aiConnections.health('codex')!=='signedIn' || config().workers.codex!=='ChatGPT login'){p.identityId='';p.email='';return}
    if(!live || !known() || p.identityId)return;
    p.identityId=uid();postLive('ai-codex-identity',{id:p.identityId});
  }
  function codexAccount(p){
    const status=aiConnections.health('codex'), source=config().workers.codex;
    if(status==='signedOut')return 'No Codex account is signed in.';
    if(status==='missing')return 'Install Codex to use its login.';
    if(status==='checking')return 'Checking the account in Codex…';
    if(source==='ChatGPT login')return (p.email?p.email+' / ':'')+'ChatGPT plan in Codex';
    if(source==='API key login')return 'The OpenAI project billed by the API key in Codex.';
    return 'Codex hasn’t identified its billing account.';
  }
  function billing(p,id){
    if(id==='local')return 'No account or cloud usage. When Apple’s on-device model is available, it can suggest short briefs; otherwise Tasktap uses local matching. This prepares requests, not project code. Review names, intent and destination before starting an agent.';
    if(id==='claude-session')return aiConnections.payer(id)==='Claude plan login'?'Draft in Terminal using your Claude subscription.':'Draft in Terminal using the account in Claude Code. '+aiConnections.payer(id)+'.';
    if(id==='codex')return codexAccount(p);
    if(id==='chatgpt')return account(p)?account(p).label+' / ChatGPT plan':'Choose a ChatGPT account with plan access.';
    if(id==='openai')return 'The OpenAI project that owns this key pays for preparation.';
    if(id==='anthropic')return 'The Anthropic Console account that owns this key pays for preparation.';
    if(id==='cloud')return config().cloud || 'Configure a cloud provider for Claude Code first.';
    const url=p.form?.querySelector('#server-url')?.value || config().serverProfiles?.[id]?.url || '';
    const model=p.form?.querySelector('#ai-model')?.value||'';
    if(id==='ollama' && serverSetup.locationOf(url)?.loop){
      return model.toLowerCase().includes('cloud')?'This model sends requests through the Ollama server’s cloud account.':
        'Downloaded models use no cloud account. Cloud models use the Ollama server’s account.';
    }
    return serverSetup.description(id,url,model);
  }
  function mount(p,parent){
    parent.replaceChildren();
    if(!p.form && !known()){
      parent.innerHTML='<p class="hint" role="status">Reading your saved connections…</p>';
      postLive('ai-settings');return;
    }
    if(p.form && !p.touched && p.id!==current()){p.form=null;p.server=null}
    if(!p.form){
      p.id=current();p.account=config().account;
      p.form=document.createElement('form');p.form.id='setup-preparation';
      p.form.innerHTML='<p class="hint">Tasktap finds the project or session and helps turn your words into a brief.</p>'+settingsField('setup-prep-route','Prepare my requests with','<select id="setup-prep-route">'+
        routeOptions(p)+'</select>')+
        '<p id="setup-billing" class="prep-account"></p><div id="setup-prep-fields"></div><p class="prep-notice hint" role="status"></p>'+
        '<p id="setup-consent-hint" class="hint">Before sending a request, Tasktap lets you review what it will share.</p>';
      p.form.onsubmit=e=>{e.preventDefault();$('#setup-next')?.click()};
      p.form.oninput=e=>{if(e.target.id==='setup-prep-route')return;p.touched=true;notice(p,'');refresh(p)};
      p.form.onchange=()=>{p.touched=true;refresh(p)};
      parent.append(p.form);
      $('#setup-prep-route').onchange=e=>{
        if(e.target.value==='more'){
          p.more=true;e.target.innerHTML=routeOptions(p);settingsPickers.sync(e.target);
          e.stopPropagation();e.target.focus();e.target.click();return;
        }
        settingsPickers.close();p.id=e.target.value;p.touched=true;notice(p,'');fields(p)
      };
      fields(p);
    }else{
      parent.append(p.form);refresh(p);
    }
    settingsPickers.mount(p.form);
  }
  function fields(p){
    const id=p.id,c=config(),inner=$('#setup-prep-fields');p.server=null;
    if(servers.includes(id)){
      const profile={...c,serverKind:id};inner.innerHTML=serverSetup.markup(profile,id);
      p.server=serverSetup.mount(profile);
    }else if(id==='codex' || id==='cloud' || id==='claude-session'){
      inner.innerHTML=aiConnections.setupField(id==='codex'?'codex':'claude')+'<button type="button" class="text-btn" id="setup-recheck">Check again</button>';
      $('#setup-recheck').onclick=()=>{p.identityId='';p.email='';aiConnections.refresh()};
      if(live)aiConnections.refresh();
    }else if(id==='chatgpt'){
      inner.innerHTML='<div id="setup-plan"></div>';
      plan(p);
    }else if(isKey(id)){
      inner.innerHTML=settingsField('setup-key',c.keys[id]?'Replace saved key (optional)':'API key','<input id="setup-key" type="password" autocomplete="off" '+(c.keys[id]?'placeholder="Saved in Mac Keychain"':'required')+'>')+
        settingsField('setup-prep-model','Preparation model','<input id="setup-prep-model" required value="'+attr(c.models[id] || (id==='openai'?'gpt-5.4-mini':'claude-haiku-5-5'))+'">');
    }else inner.replaceChildren();
    refresh(p);settingsPickers.mount(inner);
  }
  function plan(p){
    const area=p.form?.querySelector('#setup-plan');if(!area)return;
    const list=config().accounts;
    if(!p.account && list.length)p.account=config().account || list[0].id;
    const stamp=JSON.stringify([list,p.account,!!p.login]);
    if(area.dataset.state===stamp)return;
    area.dataset.state=stamp;
    area.innerHTML=(list.length?settingsField('setup-plan-account','Preparation account','<select id="setup-plan-account">'+
      list.map(a=>option(a.id,a.label,p.account)).join('')+'</select>'):'')+
      '<button type="button" class="btn" id="setup-plan-login" '+(p.login?'disabled':'')+'>'+
      (p.login?'Waiting for sign-in…':account(p)?.status==='enabled'?'Add another account':'Connect ChatGPT plan')+'</button>';
    const select=area.querySelector('select');
    if(select)select.onchange=()=>{p.account=select.value;p.touched=true;plan(p);refresh(p)};
    area.querySelector('button').onclick=()=>{
      if(!live || p.login)return;
      p.login=uid();const prior=account(p)?.status==='enabled'?'':p.account;
      postLive('ai-login',{account:prior,request:p.login});plan(p);
    };
    if(area.isConnected)settingsPickers.mount(area);
  }
  function refresh(p){
    if(p.id==='codex' || $('#setup-agent')?.value==='codex')identify(p);
    if(p.form){
      p.form.querySelector('#setup-billing').textContent=billing(p,p.id);
      p.form.querySelector('#setup-consent-hint').hidden=['local','claude-session'].includes(p.id);
      if(p.id==='chatgpt')plan(p);
      const check=p.form.querySelector('#setup-recheck');
      if(check)check.hidden=!['checking','unknown','missing','signedOut'].includes(aiConnections.health(p.id==='codex'?'codex':'claude'));
      if(p.form.querySelector('.prep-notice').dataset.validation==='true' && !blocking(p))notice(p,'');
    }
    const worker=$('#setup-worker-account'),agent=$('#setup-agent')?.value;
    if(worker && agent){
      const label=agent==='codex'?codexAccount(p):aiConnections.worker(agent);
      worker.textContent=aiConnections.health(agent)==='missing' || aiConnections.health(agent)==='signedOut'?'':'Account for project work / '+label;
    }
    if($('#setup-route-summary')){
      const id=selected(p),model=p.form?.querySelector('#ai-model')?.value;
      $('#setup-route-summary').textContent=[routes[id],servers.includes(id)?[p.form?.querySelector('#server-url')?.value,model].filter(Boolean).join(' / '):id==='local'?'No account':billing(p,id)].filter(Boolean).join(' / ');
    }
  }
  function blocking(p){
    const id=p.id;
    let msg='';
    if(id==='codex' && ['signedOut','missing','checking'].includes(aiConnections.health('codex')))msg=codexAccount(p);
    if(id==='claude-session' && aiConnections.health('claude')==='missing')msg='Install Claude Code or choose another option.';
    if(id==='cloud' && (!config().cloud || aiConnections.health('claude')==='missing'))msg='Set up Claude Code with a cloud provider, or choose another option.';
    if(id==='chatgpt' && (p.login || account(p)?.status!=='enabled'))msg='Connect an account and allow plan usage, or choose another option.';
    if(servers.includes(id) && p.form.querySelector('#server-setup').dataset.phase!=='model')msg='Find models or enter the model ID to continue.';
    if(!live && id!=='local')msg='Connect this preparation route in the Mac app.';
    return msg;
  }
  function validate(p){
    if(!known() || !p.form)return false;
    const msg=blocking(p);notice(p,msg,true);
    return !msg && (p.form.isConnected?p.form.reportValidity():p.form.checkValidity());
  }
  function payload(p){
    if(!p.touched)return null;
    const route=nativeRoute(p.id);
    const data={route,model:config().models[route]||'',key:''};
    if(p.id==='chatgpt')data.account=p.account;
    if(isKey(p.id)){data.key=p.form.querySelector('#setup-key').value.trim();data.model=p.form.querySelector('#setup-prep-model').value.trim()}
    if(p.server){
      data.server=p.server.options();data.key=p.server.key();data.model=p.form.querySelector('#ai-model').value.trim();
    }
    return data;
  }
  document.addEventListener('connection-state',({detail})=>{
    const p=active();if(!p)return;
    if(detail.finished && detail.request && detail.request===p.login){
      p.login='';
      if(detail.success && detail.account){p.account=detail.account;p.touched=true}
      notice(p,detail.success?'':detail.note);
    }
    if($('#setup-page')?.dataset.step==='1' && known() && (!p.form || (!p.touched && p.id!==current())))mount(p,$('#setup-page'));
    refresh(p);
  });
  function dispose(p){
    if(!p.form)return;
    for(const field of p.form.querySelectorAll('input[type=password]'))field.value='';
    p.form.remove();p.form=null;p.server=null;p.identityId='';p.email='';
  }
  return {create,mount,refresh,validate,payload,identity,dispose};
})();
