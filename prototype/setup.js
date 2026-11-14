// In a fixed header a chrome signal travels from capture to handoff to the chosen notch study;
// the controls stay still, narrow windows keep the right-hand crop, and Reduce Motion shows the finished frame.
const setupWizard = (() => {
  const steps=['Capture','Sessions','Feedback'];
  let draft=null;
  const showing=()=>!!draft && !!$('#modal[open] #setup-wizard');
  function offer(){
    if(!live || returningInstall || state.setupSeen || state.firstRun || !firstMode() || document.querySelector('dialog[open]'))return false;
    state.setupSeen=true;persist();
    open('welcome');
    return true;
  }
  function open(origin){
    if(showing())return;
    const from=$('#modal[open] #preferences [aria-pressed=true]')?.dataset.id;
    if(document.querySelector('dialog[open]') && !from){toast('Finish or close the open panel to run setup.');return}
    showWorkspace();
    draft={origin,from,step:0,context:state.useScreenContext!==false,agent:sessionModelPolicy().defaultAgent,
      host:terminalHosts.valid(state.sessionHost)?state.sessionHost:'terminal',art:TasktapArt.current(),summaryVoice:null};
    dialog('Set up Tasktap','','<div id="setup-wizard" class="settings-form"><section id="setup-page" class="settings-section"></section>'+
      '<footer class="setup-actions"><button type="button" id="setup-back" class="btn"></button>'+
      '<button type="button" id="setup-next" class="primary"></button></footer></div>');
    const header=$('#modal .dialog-title');
    header.classList.add('setup-header');
    header.querySelector('h2').insertAdjacentHTML('beforebegin','<span class="eyebrow">Tasktap setup</span>');
    header.querySelector('.icon-btn').setAttribute('aria-label','Close setup without saving');
    header.insertAdjacentHTML('afterbegin','<div class="setup-stage" aria-hidden="true"></div>');
    header.insertAdjacentHTML('beforeend','<ol class="setup-progress" aria-label="Setup progress">'+steps.map(s=>'<li>'+s+'</li>').join('')+'</ol>');
    $('#setup-back').onclick=()=>draft.step?move(-1):cancel();
    $('#setup-next').onclick=()=>draft.step===steps.length-1?save():move(1);
    paint(0);
  }
  function stage(id,direction){
    const frame=$('.setup-stage');
    const previous=frame.lastElementChild;
    if(previous?.querySelector('video')?.dataset.study===id)return;
    frame.querySelectorAll('.leaving').forEach(el=>el.remove());
    frame.insertAdjacentHTML('beforeend',TasktapArt.markup('stage',id));
    const layer=frame.lastElementChild;
    if(!previous || matchMedia('(prefers-reduced-motion: reduce)').matches){previous?.remove();return}
    previous.classList.add('leaving');
    const duration=Math.round(250/artworkPlaybackRate(frame.clientWidth));
    const timing={duration,easing:'cubic-bezier(.2,.65,.28,1)'};
    const offset=(direction<0?-1:1)*Math.min(26,frame.clientWidth*.08);
    previous.animate([{opacity:1},{opacity:0,transform:'translateX('+(-offset)+'px)'}],timing).finished.then(()=>previous.remove(),()=>previous.remove());
    layer.animate([{opacity:0,transform:'translateX('+offset+'px)'},{opacity:1,transform:'none'}],timing);
  }
  // Narration is shared with manual playback: turning summaries off must keep that voice.
  function voices(){
    const field=$('#setup-voice');
    if(!showing() || !field)return;
    const available=[...siriVoices];
    if(kokoro.status==='ready')available.push({id:'kokoro',name:'Kokoro · Heart'});
    const selected=draft.summaryVoice ?? (state.speak?(state.voiceEngine ?? siriVoices[0]?.id ?? ''):'');
    const focused=document.activeElement===field;
    if(field.getAttribute('aria-expanded')==='true')settingsPickers.close();
    field.innerHTML=option('','Off',selected)+available.map(v=>option(v.id,v.name,selected)).join('');
    if(selected && !available.some(v=>v.id===selected)){
      const missing=new Option('Current voice (unavailable)',selected,true,true);missing.disabled=true;field.add(missing);
    }
    field.disabled=!selected && available.length===0;
    $('#setup-voice-help').hidden=!field.disabled;
    settingsPickers.sync(field);
    if(focused && !field.disabled)field.focus({preventScroll:true});
  }
  function move(delta){settingsPickers.close();draft.step+=delta;paint(delta)}
  function paint(direction){
    const {step,context,agent,host,art}=draft, page=$('#setup-page');
    const title=['Capture a request','Hand off to an agent','See and hear updates'][step];
    const heading=$('#dialog-heading');heading.textContent=title;heading.tabIndex=-1;
    heading.setAttribute('aria-label',title+', step '+(step+1)+' of '+steps.length);
    $('.setup-progress').querySelectorAll('li').forEach((item,i)=>{
      if(i===step)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current');
    });
    stage(['glyph','relay',art][step],direction);
    if(step===0){
      page.innerHTML='<div class="setup-shortcut"><kbd aria-label="Control Option Space" title="Control + Option + Space">⌃ ⌥ Space</kbd><p>Tap to type. Hold to speak, then release.</p></div>'+
        '<label class="policy-switch" for="setup-context"><span>Find the website or file I mention</span><input type="checkbox" id="setup-context" '+(context?'checked':'')+'></label>'+
        '<p class="hint">Say “this website” or “this file” to include it. You can check the reference before sending.</p>';
      $('#setup-context').onchange=e=>{draft.context=e.target.checked};
    }else if(step===1){
      const agents=Object.entries(providers).map(([id,label])=>option(id,label,agent)).join('');
      page.innerHTML=settingsField('setup-agent','Default coding agent','<select id="setup-agent">'+agents+'</select>')+
        (live?'<div id="setup-health">'+aiConnections.setupField(agent)+'</div>':'')+
        settingsField('setup-host','Open sessions in','<select id="setup-host">'+terminalHosts.options(host)+'</select>')+
        '<p class="hint">'+(state.workerRouting?.automatic?'Your agent ranking takes priority for new sessions. ':'')+'Review the agent and terminal before starting. Follow-ups stay in their original session.</p>';
      $('#setup-agent').onchange=e=>{
        draft.agent=e.target.value;
        if(live){$('#setup-health').innerHTML=aiConnections.setupField(draft.agent);aiConnections.updateSetup()}
      };
      $('#setup-host').onchange=e=>{draft.host=e.target.value};
      if(live){aiConnections.refresh();postLive('terminal-catalog')}
    }else{
      page.innerHTML='<fieldset class="setup-art"><legend>Notch artwork</legend><div class="setup-studies">'+TasktapArt.catalog.map(s=>
        '<label><input type="radio" name="setup-art" value="'+s.id+'" '+(s.id===art?'checked':'')+'><img src="'+attr(s.poster)+'" alt=""><span>'+esc(s.name)+'</span></label>').join('')+'</div></fieldset>'+
        settingsField('setup-voice','Read finished tasks aloud','<select id="setup-voice"></select>')+
        '<p id="setup-voice-help" class="hint" hidden>For spoken results, set up a local voice in Preferences → Voice &amp; alerts.</p>';
      $('.setup-studies').onchange=e=>{draft.art=e.target.value;stage(draft.art,1)};
      $('#setup-voice').onchange=e=>{draft.summaryVoice=e.target.value};
      voices();
      if(live)postLive('check-kokoro');
    }
    settingsPickers.mount(page);
    $('#setup-back').textContent=step?'Back':(draft.origin==='welcome'?'Set up later':'Cancel');
    $('#setup-next').textContent=step===2?(draft.origin==='welcome'?'Save & try capture':'Save settings'):'Continue';
    heading.focus({preventScroll:true});
  }
  function leave(saved){
    const {origin,from}=draft;
    draft=null;
    dismissCard();
    if(origin==='preferences'){
      prefs(from);
      $('#preferences [data-action="run-setup"]').focus({preventScroll:true});
    }else if(origin==='welcome'){
      firstRun.open(true);
    }
    if(saved && origin!=='welcome')toast('Setup saved.');
  }
  function cancel(){if(showing())leave(false)}
  function save(){
    if(!showing() || draft.step!==steps.length-1)return;
    state.useScreenContext=draft.context;
    state.sessionModels={...state.sessionModels,defaultAgent:draft.agent};
    state.sessionHost=draft.host;
    if(draft.summaryVoice!==null){
      state.speak=!!draft.summaryVoice;
      if(state.speak)state.voiceEngine=draft.summaryVoice;
    }
    TasktapArt.select(draft.art);
    state.setupSeen=true;persist();
    leave(true);
  }
  document.addEventListener('local-voices-changed',voices);
  return {offer,open,showing,cancel};
})();
