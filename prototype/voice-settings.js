// Native configuration is authoritative. No speech keys or model readiness are
// persisted in web storage; browser previews never download or upload audio.
const voiceSettings=(()=>{
  const fallback={mode:'local',localEngine:'recommended',provider:'openai',language:'auto',models:{}};
  let snapshot={configuration:fallback,recommendedEngine:'apple-dictation',engineNames:{'apple-dictation':'Apple dictation','apple-speech':'Apple SpeechTranscriber','whisper-turbo':'Whisper large-v3 Turbo'},recommendedModels:{openai:'gpt-transcribe',deepgram:'nova-3',elevenlabs:'scribe_v3'},models:{openai:['gpt-transcribe','gpt-4o-transcribe','gpt-4o-mini-transcribe'],deepgram:['nova-3'],elevenlabs:['scribe_v3','scribe_v2']},supported:true,ready:false,microphone:'unknown',phase:'idle',detail:'',progress:null,appleLanguage:'Mac language'};
  let checked=!live,pending=false,tab='dictation',optionsOpen=false;
  const config=()=>snapshot.configuration;
  const resolved=()=>config().localEngine==='recommended'?snapshot.recommendedEngine:config().localEngine;
  const name=()=>({openai:'OpenAI',deepgram:'Deepgram',elevenlabs:'ElevenLabs'})[config().provider]||'Speech provider';
  const busy=()=>!checked||snapshot.phase==='downloading'||pending;
  const action=(label,id,primary=false,symbol='')=>button(label,'voice-'+id,'',primary?'primary':'btn',symbol);
  const locked=markup=>busy()?markup.replace('<button ','<button disabled '):markup;
  function receive(value){
    if(!value?.configuration)return;
    snapshot={...snapshot,...value};checked=true;pending=false;
    if($('#voice-settings'))paint();
  }
  function refresh(){if(live)postLive('speech-status')}
  function save(patch){
    if(busy())return;
    const updated={...config(),...patch};
    if(live){pending=true;postLive('speech-save',{configuration:updated});paint()}
    else {snapshot={...snapshot,configuration:updated,ready:false,phase:'idle',detail:''};paint();toast('Browser preview. Voice setup runs in the Mac app.')}
  }
  function setupMarkup(){
    const local=config().mode==='local',engine=resolved(),ready=snapshot.ready&&snapshot.microphone==='allowed';
    let title='Speak instead of typing',detail='Set up speech assets once, then dictate privately on this Mac.',status='One-time setup',control=action('Download & set up','install',true,'down'),extra='';
    if(!checked){title='Checking voice setup…';detail='Reading your speech preferences.';control='';status='Please wait'}
    else if(busy()){
      title=pending?'Saving your choice…':'Getting dictation ready';detail=pending?'Your current recording keeps its original engine.':'You can keep typing while speech assets download.';status='Setup in progress';
      control=pending?'':action('Cancel download','cancel-install');
      const progress=snapshot.progress;
      extra=pending?'':'<div class="voice-download" '+(Number.isFinite(progress)?'role="progressbar" aria-label="Voice model download" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+Math.round(progress*100)+'"':'role="status"')+'><div><span style="width:'+(Number.isFinite(progress)?Math.max(0,Math.min(100,progress*100)):0)+'%"></span></div><p class="hint">'+esc(snapshot.detail||'Downloading speech assets…')+(Number.isFinite(progress)?' '+Math.round(progress*100)+'%':'')+'</p></div>';
    }else if(!snapshot.supported){title='Choose another speech engine';detail='This engine or language is unavailable on this Mac. Your saved choice has been kept.';control=action('More options','options',true);status='Setup unavailable'}
    else if(!local&&!snapshot.ready){
      title='Use your speech provider';detail='Connect your own speech API account.';status='Cloud setup';control=action('Save API key','connect',true);
      extra='<div class="profile-fields">'+settingsField('speech-provider','Provider','<select id="speech-provider">'+Object.entries({openai:'OpenAI',deepgram:'Deepgram',elevenlabs:'ElevenLabs'}).map(([id,label])=>option(id,label,config().provider)).join('')+'</select>')+settingsField('speech-key','API key','<input id="speech-key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Your speech API key">')+'</div><p class="hint">Audio is sent to '+esc(name())+' after you release the shortcut. Your provider’s API charges apply. Keys are stored in macOS Keychain.</p>';
    }else if(snapshot.ready&&snapshot.microphone!=='allowed'){
      title=snapshot.microphone==='denied'?'Microphone access is off':'Allow your microphone';detail='Let Tasktap hear you while you hold the dictation shortcut.';status='Almost ready';control=action(snapshot.microphone==='denied'?'Open microphone settings':'Allow microphone',snapshot.microphone==='denied'?'microphone-settings':'microphone',true,'mic');
    }else if(ready){title='You’re ready to dictate';detail='Hold the shortcut, speak, then release. Review before sending.';status=local?'On this Mac · Offline':'Using '+name();control=action('Try dictation','try',false,'mic');extra='<div class="voice-shortcut"><kbd aria-label="Control Option Space">⌃ ⌥ Space</kbd><span class="hint">Hold to speak · release to finish</span></div>'}
    const error=snapshot.phase==='error'?'<p class="voice-error" role="alert">'+esc(snapshot.detail)+'</p>':'';
    return '<div class="voice-setup-status '+(ready?'is-ready':'')+'">'+icon(ready?'check':local?'mic':'globe')+'<span>'+esc(status)+'</span>'+(local&&config().localEngine==='recommended'?'<span class="badge">Recommended</span>':'')+'</div><div class="voice-setup-intro"><span class="voice-setup-symbol">'+icon(ready?'check':'mic')+'</span><div><h3>'+esc(title)+'</h3><p class="hint">'+esc(detail)+'</p></div></div>'+extra+error+'<div class="voice-setup-actions">'+control+(local&&!ready?'<p class="hint">Your recordings stay on this Mac.</p>':'')+'</div>';
  }
  function advanced(){
    const c=config(),local=c.mode==='local';
    const engines=[['recommended','Recommended · '+(snapshot.engineNames[snapshot.recommendedEngine]||snapshot.recommendedEngine)],...Object.entries(snapshot.engineNames)];
    if(!engines.some(([id])=>id===c.localEngine))engines.push([c.localEngine,c.localEngine+' (unavailable)']);
    const model=c.models[c.provider]||'recommended',models=[['recommended','Recommended · '+snapshot.recommendedModels[c.provider]],...(snapshot.models[c.provider]||[]).map(id=>[id,id])];
    if(!models.some(([id])=>id===model))models.push([model,model+' (unavailable)']);
    const languages=[['auto',local&&resolved()!=='whisper-turbo'?'Use Mac language':'Detect automatically'],['de','German'],['en','English'],['fr','French'],['es','Spanish'],['it','Italian'],['ja','Japanese']];
    if(!languages.some(([id])=>id===c.language))languages.push([c.language,c.language]);
    return '<details class="voice-more" '+(optionsOpen?'open':'')+'><summary>More options</summary><div class="voice-options-body">'+
      (local?settingsField('speech-local-engine','Speech engine','<select id="speech-local-engine" '+(busy()?'disabled':'')+'>'+engines.map(([id,label])=>option(id,label,c.localEngine)).join('')+'</select>'):
        settingsField('speech-model','Speech model','<select id="speech-model" '+(busy()?'disabled':'')+'>'+models.map(([id,label])=>option(id,label,model)).join('')+'</select>')+'<div class="inline">'+action('Change provider','provider')+(snapshot.ready?action('Remove API key','disconnect'):'')+'</div>')+
      '<p class="hint">Recommended follows Tasktap’s release defaults. Choosing a specific engine or model keeps your choice across updates.</p>'+
      settingsField('speech-language','Spoken language','<select id="speech-language" '+(busy()?'disabled':'')+'>'+languages.map(([id,label])=>option(id,label,c.language)).join('')+'</select>')+
      (local&&resolved()==='whisper-turbo'&&snapshot.ready?action('Remove downloaded model…','remove-model'):'')+'</div></details>';
  }
  function dictation(){
    const local=config().mode==='local';
    return '<div class="voice-setup" id="voice-setup" aria-live="polite">'+setupMarkup()+'</div>'+
      '<div class="voice-alternative"><span class="hint">'+(local?'Already have a speech API account?':'Prefer to keep audio on your Mac?')+'</span>'+locked(action(local?'Use a cloud provider instead':'Use on-device dictation',local?'cloud':'local'))+'</div>'+
      '<div class="voice-defaults"><div>'+icon('globe')+'<p><strong>Speak naturally</strong><span class="hint">'+(local&&resolved()!=='whisper-turbo'?'Apple uses '+esc(snapshot.appleLanguage)+'. You can change the language in More options.':'Your spoken language is detected automatically unless you select a language.')+'</span></p></div><div>'+icon('codex')+'<p><strong>Your words stay yours</strong><span class="hint">Requests keep their original language. '+(state.agentReplyLanguage==='english'?'Replies are set to English.':'Replies follow your request.')+'</span></p></div></div>'+advanced()+
      (!live?'<p class="hint voice-preview-note">Browser preview. Downloads, API connections and microphone setup run in the Mac app.</p>':'');
  }
  function narration(){
    return '<label class="policy-switch" for="narration"><span>Read completion summaries aloud</span><input id="narration" type="checkbox" '+(state.speak?'checked':'')+'></label><p class="hint">Optional. Hear a short result when an agent finishes.</p>'+
      (state.speak?settingsField('voice-engine','Narration voice','<select id="voice-engine"></select>')+'<div class="voice-tools"><p id="voice-status" class="hint" role="status">'+esc(kokoro.detail)+'</p><div class="inline">'+(live?action('Set up Kokoro','kokoro'):'')+button('Preview voice','preview-voice')+'</div></div>':'');
  }
  function markup(){return '<div id="voice-settings"><div class="voice-tabs" role="tablist" aria-label="Voice settings">'+[['dictation','Dictation'],['narration','Read aloud']].map(([id,label])=>'<button type="button" role="tab" id="voice-tab-'+id+'" aria-controls="voice-panel" aria-selected="'+(tab===id)+'" tabindex="'+(tab===id?0:-1)+'" data-voice-tab="'+id+'">'+label+'</button>').join('')+'</div><section id="voice-panel" role="tabpanel" aria-labelledby="voice-tab-'+tab+'">'+(tab==='dictation'?dictation():narration())+'</section></div>'}
  function bind(){
    if(!$('#voice-settings'))return;
    if($('#voice-engine')){voiceOptions();$('#voice-engine').onchange=e=>{state.voiceEngine=e.target.value;persist()}}
    if($('#narration')){
      $('#narration').onchange=e=>{state.speak=e.target.checked;persist();paint();$('#narration').focus({preventScroll:true})};
      routingVoicePreference();
    }
    settingsPickers.mount($('#voice-settings'));
  }
  function paint(){
    const target=$('#voice-settings');if(!target)return;
    const current=target.querySelector('.voice-more');if(current)optionsOpen=current.open;
    // Updating native download progress must not discard a key being entered.
    const key=$('#speech-key')?.value||'',focus=document.activeElement?.id;
    const activeAction=document.activeElement?.closest('[data-action]')?.dataset.action;
    settingsPickers.close();target.outerHTML=markup();bind();
    if($('#speech-key'))$('#speech-key').value=key;
    if(focus)document.getElementById(focus)?.focus({preventScroll:true});
    else if(activeAction)$('#voice-settings [data-action="'+CSS.escape(activeAction)+'"]')?.focus({preventScroll:true});
  }
  function open(){tab='dictation';prefs('voice')}
  document.addEventListener('change',e=>{
    if(e.target.id==='speech-local-engine')save({localEngine:e.target.value});
    if(e.target.id==='speech-provider')save({provider:e.target.value});
    if(e.target.id==='speech-model')save({models:{...config().models,[config().provider]:e.target.value}});
    if(e.target.id==='speech-language')save({language:e.target.value});
  });
  document.addEventListener('click',e=>{
    const tabButton=e.target.closest('[data-voice-tab]');
    if(tabButton){tab=tabButton.dataset.voiceTab;paint();$('#voice-tab-'+tab).focus({preventScroll:true});if(tab==='narration'&&live)postLive('check-kokoro');return}
    const id=e.target.closest('[data-action]')?.dataset.action;
    if(!id?.startsWith('voice-'))return;
    const command=id.slice(6);
    if(command==='options'){const details=$('.voice-more');details.open=true;optionsOpen=true;details.querySelector('select')?.focus();return}
    if(command==='cloud'){save({mode:'cloud'});return}
    if(command==='local'){save({mode:'local'});return}
    if(command==='provider'){const select=$('#speech-provider');if(select){select.focus();return}snapshot={...snapshot,ready:false};paint();return}
    if(!live){toast('Voice setup is available in the Mac app.');return}
    if(command==='connect'){
      const field=$('#speech-key'),key=field?.value.trim();if(!key){field?.focus();toast('Enter your speech API key.');return}
      // Clear before crossing the bridge. Neither state nor an event log receives it.
      field.value='';postLive('speech-connect',{provider:config().provider,key});return;
    }
    if(command==='disconnect'){postLive('speech-disconnect',{provider:config().provider});return}
    if(command==='try'){tryDictation();return}
    if(command==='kokoro'){postLive('install-kokoro');return}
    if(command==='remove-model'){
      dialog('Remove voice model?','Voice','<p>Whisper dictation will need another download. You can keep typing or choose another engine.</p><div class="form-actions">'+button('Keep model','prefs','voice')+action('Remove model','confirm-remove')+'</div>');return;
    }
    if(command==='confirm-remove'){postLive('speech-remove-model');prefs('voice');return}
    const commands={install:'speech-install','cancel-install':'speech-cancel-install',microphone:'speech-microphone','microphone-settings':'speech-microphone-settings'};
    if(commands[command])postLive(commands[command]);
  });
  function tryDictation(){
    dialog('Try dictation','Voice','<p class="hint">Hold the microphone button, speak, then release. This test stays here; it is never sent to a coding agent.</p><textarea id="voice-test-text" rows="4" aria-label="Test transcript" placeholder="Your words appear here…"></textarea><div id="capture-feedback" class="hint" role="status"></div><div class="form-actions"><button type="button" class="voice" data-action="dictate" data-id="#voice-test-text">'+icon('mic')+'<span>Hold to dictate</span></button>'+button('Done','prefs','voice')+'</div>');
  }
  document.addEventListener('keydown',e=>{
    if(!e.target.matches('[data-voice-tab]')||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
    e.preventDefault();tab=e.key==='Home'?'dictation':e.key==='End'?'narration':tab==='dictation'?'narration':'dictation';paint();$('#voice-tab-'+tab).focus();
  });
  return {receive,refresh,markup,bind,open,config};
})();
