// The four server presets carry existing studio stills. Only the connection lamp moves
// during discovery; narrow layouts wrap the controls and reduced motion keeps the lamp still.
const serverSetup = (() => {
  const presets = {
    ollama: {name:'Ollama',port:11434,art:'glyph',key:'Direct local Ollama accepts requests without a key.'},
    vllm: {name:'vLLM',port:8000,art:'phase',key:'Enter a key if your vLLM server was started with API authentication.'},
    litellm: {name:'LiteLLM',port:4000,art:'relay',key:'A protected proxy needs its virtual key. Your proxy decides where the request runs and what it costs.'},
    custom: {name:'Other',port:null,art:'orbit',key:'Use the bearer key required by your server, or leave it empty.'}
  };
  let pending=null;
  function name(kind) {return presets[kind]?.name==='Other'?'Model server':presets[kind]?.name || 'Model server'}
  function base(kind) {return presets[kind]?.port?'http://localhost:'+presets[kind].port+'/v1':''}
  function locationOf(raw) {
    try {
      const explicit=raw.includes('://');
      const u=new URL(explicit?raw:'http://'+raw);
      if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) return null;
      const loop=/^(localhost|127(?:\.\d+){3}|\[::1\])$/i.test(u.hostname);
      const local=loop || u.hostname.endsWith('.local') || !u.hostname.includes('.') || /^(10\.|192\.168\.)/.test(u.hostname);
      if (!explicit && !local) u.protocol='https:';
      return {loop,host:u.host,label:loop?'Server on this Mac':'Network server',http:u.protocol==='http:'};
    } catch {return null}
  }
  function description(kind,address,model='') {
    const target=locationOf(address);
    if (!target) return 'Enter the base URL of your server.';
    if (kind==='litellm') return 'LiteLLM can forward captures to a paid upstream provider, including from localhost.';
    if (kind==='ollama' && (model.includes('cloud') || target.loop)) return 'A downloaded Ollama model runs on its host. Cloud models send the capture upstream.';
    if (kind==='custom') return 'The server controls processing and billing. It can forward captures to another provider.';
    return target.loop?'Requests go to the server listening on this Mac.':'Requests go to the named server. Its operator controls processing and billing.';
  }
  function markup(config,fixedKind='') {
    const kind=Object.hasOwn(presets,config.serverKind)?config.serverKind:'ollama';
    const tiles=Object.entries(presets).map(([id,p])=>'<label class="server-tile"><input type="radio" name="server-kind" value="'+id+'" '+(id===kind?'checked':'')+'><span><img src="'+attr(TasktapArt.poster(p.art,'miniature'))+'" alt=""><b>'+esc(p.name)+'</b></span></label>').join('');
    return '<div id="server-setup" class="server-setup" data-phase="address"><fieldset id="server-endpoint"><legend'+(fixedKind?' hidden':'')+'>Server software</legend><div class="server-tiles"'+(fixedKind?' hidden':'')+'>'+tiles+'</div>'+
      settingsField('server-url','Base URL','<input id="server-url" type="text" inputmode="url" autocapitalize="none" spellcheck="false" placeholder="https://models.example.com/v1">')+
      '<p id="server-place" class="server-place"></p>'+
      '<details id="server-auth"><summary>API key <span>Optional</span></summary><p id="server-key-help" class="hint"></p>'+
      settingsField('server-key','Server key','<input id="server-key" type="password" autocomplete="off" placeholder="Bearer key">')+
      '<label id="server-stored" class="check-line" hidden><input id="server-use-saved" type="checkbox"> Use the key saved for this address</label></details>'+
      '<div class="server-actions"><button class="primary" id="server-discover" type="button">Find models</button><button type="button" id="server-manual" class="text-btn">Enter model ID</button></div></fieldset>'+
      '<section id="server-models" hidden><div class="server-target"><div><strong id="server-target-name"></strong><code id="server-target-url"></code></div><button type="button" class="text-btn" id="server-change">Edit connection</button></div>'+
      '<div id="server-model-field"></div><p id="server-scope" class="hint"'+(fixedKind?' hidden':'')+'></p></section>'+
      '<p id="server-status" role="status" class="server-status"></p></div>';
  }
  function mount(config) {
    const root=$('#server-setup');
    const form=root.closest('form'), url=$('#server-url'), key=$('#server-key'), saved=$('#server-use-saved');
    const modelArea=$('#server-model-field'), status=$('#server-status');
    let kind, profile={}, pendingId='';
    const submit=form.querySelector('[type=submit]');
    const isSame=()=>url.value.trim().replace(/\/+$/,'')===(profile.url||'').replace(/\/+$/,'');
    function target() {
      const place=locationOf(url.value.trim());
      $('#server-place').textContent=place?place.label+(place.http&&!place.loop?' / Unencrypted HTTP':''):'';
      $('#server-stored').hidden=profile.hasKey!=='yes' || !isSame();
      key.placeholder=!$('#server-stored').hidden && saved.checked?'Saved in Mac Keychain':'Leave blank for no authentication';
    }
    function endpoint() {
      pendingId='';pending=null;
      root.dataset.phase='address';$('#server-endpoint').hidden=false;$('#server-models').hidden=true;
      $('#server-discover').disabled=!live;$('#server-manual').disabled=false;
      if(submit)submit.hidden=true;status.textContent='';root.removeAttribute('aria-busy');
    }
    function choose(id) {
      kind=id;profile=config.serverProfiles?.[id] || {};url.value=profile.url || base(id);key.value='';
      saved.checked=profile.hasKey==='yes';$('#server-auth').open=false;
      $('#server-key-help').textContent=presets[id].key;endpoint();target();
    }
    function selectModel(list,value='',typed=false) {
      const manual=typed || !list.length;
      root.dataset.phase='model';$('#server-endpoint').hidden=true;$('#server-models').hidden=false;if(submit)submit.hidden=false;
      $('#server-target-name').textContent=name(kind)+' / '+(locationOf(url.value)?.label || 'Network server');
      $('#server-target-url').textContent=url.value.trim();
      const known=list.includes(value)?value:list[0];
      if (manual) modelArea.innerHTML=settingsField('ai-model','Chat model ID','<input id="ai-model" required autocomplete="off" spellcheck="false" placeholder="Exact model name or proxy alias" value="'+attr(value)+'">');
      else modelArea.innerHTML=settingsField('ai-model','Chat model','<select id="ai-model">'+list.map(id=>option(id,id,known)).join('')+'</select>')+'<button type="button" id="server-type" class="text-btn">Enter a different model ID</button>';
      const input=$('#ai-model');
      const scope=()=>$('#server-scope').textContent=description(kind,url.value,input.value);
      input.oninput=scope;scope();
      if (!manual) $('#server-type').onclick=()=>{selectModel([],input.value,true);$('#ai-model').focus()};
      settingsPickers.mount(modelArea);
    }
    function options() {return {kind,url:url.value.trim(),useSaved:saved.checked && isSame()}}
    function validURL() {
      if (!locationOf(url.value.trim())) {url.setCustomValidity('Enter an HTTP or HTTPS server address. Put any key in the API key field.');url.reportValidity();return false}
      return true;
    }
    function changed() {url.setCustomValidity('');pendingId='';pending=null;$('#server-discover').disabled=!live;root.removeAttribute('aria-busy');status.textContent='';target()}
    url.oninput=()=>{key.value='';saved.checked=isSame()&&profile.hasKey==='yes';changed()};
    key.oninput=()=>{saved.checked=false;changed()};
    saved.onchange=()=>{key.value='';changed()};
    for (const radio of root.querySelectorAll('[name=server-kind]')) radio.onchange=()=>choose(radio.value);
    $('#server-manual').onclick=()=>{if(validURL()){changed();selectModel([],isSame()?profile.model:'',true);$('#ai-model').focus()}};
    $('#server-change').onclick=()=>{endpoint();url.focus()};
    $('#server-discover').onclick=()=>{
      if (!live || !validURL()) return;
      const id=uid();pendingId=id;
      $('#server-discover').disabled=true;root.setAttribute('aria-busy','true');
      status.textContent='Looking up available models…';
      pending=(replyId,result)=>{
        if (id!==replyId || id!==pendingId || !root.isConnected || !form.closest('dialog[open]')) return;
        pending=null;pendingId='';root.removeAttribute('aria-busy');$('#server-discover').disabled=false;
        if (result.error) {status.textContent=result.error;return}
        const models=result.models || [];
        if (!models.length) {status.textContent='No models listed. Load a chat model on the server or enter its ID.';return}
        status.textContent=models.length+' model'+(models.length===1?'':'s')+' available';
        selectModel(models,isSame()?profile.model:'');$('#ai-model').focus();
      };
      postLive('ai-model-list',{id,...options(),key:key.value.trim()});
    };
    choose(root.querySelector(':checked').value);
    if (profile.model && profile.url) selectModel([],profile.model,true);
    return {options,key:()=>key.value.trim()};
  }
  return {markup,mount,name,description,locationOf,receive:(id,result)=>pending?.(id,result)};
})();
