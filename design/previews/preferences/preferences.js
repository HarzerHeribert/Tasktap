// Isolated design prototype. No native bridge, credentials, storage, or API calls.
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const icons = {
    general:'<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M4 9h16M9 9v11"/>',
    agents:'<path d="m8 8-4 4 4 4m8-8 4 4-4 4m-3-11-2 14"/>',
    workspaces:'<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>',
    capture:'<path d="M8 4H5a1 1 0 0 0-1 1v3m12-4h3a1 1 0 0 1 1 1v3M4 16v3a1 1 0 0 0 1 1h3m12-4v3a1 1 0 0 1-1 1h-3"/><path d="m9 15 1-4 6-6 3 3-6 6Z"/>',
    voice:'<path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4"/>',
    mic:'<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8"/>',
    notifications:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    appearance:'<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M12 3a9 9 0 0 1 0 18" fill="currentColor" stroke="none"/>',
    local:'<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
    cloud:'<path d="M6 18a4 4 0 0 1-.5-8A6.5 6.5 0 0 1 18 8a5 5 0 0 1 0 10Z"/>',
    lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
    arrow:'<path d="M4 12h15m-5-5 5 5-5 5"/>',
    download:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    moon:'<path d="M20 14A8.5 8.5 0 0 1 10 4a8.5 8.5 0 1 0 10 10Z"/>',
    x:'<path d="m6 6 12 12M6 18 18 6"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.01"/>',
    play:'<path d="m9 5 11 7-11 7Z"/>',
    key:'<circle cx="8" cy="9" r="5"/><path d="m12 13 8 8m-3-3 3-3m-6 0 3-3"/>',
    globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
    folder:'<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.general}</svg>`;
  const pages = {
    general:{name:'General',description:'A few small things that make Tasktap feel like home.'},
    agents:{name:'Agents & connections',description:'Choose who prepares your requests and who does the work.'},
    workspaces:{name:'Workspaces',description:'Keep your projects, terminals, and working context together.'},
    capture:{name:'Capture',description:'A shortcut from a passing thought to a reviewed request.'},
    voice:{name:'Voice',description:'Speak in your own language. Tasktap takes care of the rest.'},
    notifications:{name:'Notifications',description:'Stay in the loop without breaking your concentration.'},
    appearance:{name:'Appearance',description:'One palette for your workspace, terminals, and preferences.'},
  };
  const state = {
    page:Object.hasOwn(pages,location.hash.slice(1)) ? location.hash.slice(1) : 'voice',
    tab:'dictation',provider:'local',localEngine:'whisper',cloudProvider:'openai',
    inputLanguage:'auto',replyLanguage:'request',model:'missing',progress:0,microphone:false,sample:'idle',voiceOptionsOpen:false,
    connected:{openai:false,deepgram:false,elevenlabs:false},theme:'dark',
    values:{'start-login':false,'keep-notch':true,'auto-update':true,'adaptive-models':true,'external-discovery':false,'capture-context':true,'completion-narration':false,'notifications-enabled':true,'decision-alerts':true,'result-alerts':true,'failure-alerts':true,'app-translucency':true,'app-blur':true,'reduce-motion':false,'local-fallback':false},
    selected:{'default-agent':'codex','preparation':'local','session-host':'tasktap','narration-voice':'siri','artwork':'resonator','terminal-font':'ghostty','terminal-size':'14'},
  };
  let downloadTimer = null, toastTimer = null, sampleTimer = null;
  const providerName = () => ({openai:'OpenAI',deepgram:'Deepgram',elevenlabs:'ElevenLabs'})[state.cloudProvider];
  const options = (items,value) => items.map(([id,label]) => `<option value="${id}"${id === value ? ' selected' : ''}>${label}</option>`).join('');
  const select = (id,items,value) => `<select id="${id}">${options(items,value)}</select>`;
  const button = (label,action,primary=false,iconName='') => `<button type="button" class="button${primary?' primary':''}" data-action="${action}">${iconName?icon(iconName):''}${label}</button>`;
  const row = (label,description,control,id='') => `<div class="setting-row"><div class="setting-copy">${id?`<label for="${id}">${label}</label>`:`<strong>${label}</strong>`}${description?`<p>${description}</p>`:''}</div><div class="control-group">${control}</div></div>`;
  const toggleRow = (id,label,description) => row(label,description,`<input class="toggle" type="checkbox" role="switch" id="${id}"${state.values[id]?' checked':''}>`,id);
  const section = (title,content,extra='') => `<section class="section"><div class="section-heading"><h2>${title}</h2>${extra}</div>${content}</section>`;
  const group = content => `<div class="settings-group">${content}</div>`;
  const note = (text,iconName='info') => `<p class="under-note">${icon(iconName)}<span>${text}</span></p>`;

  function showToast(message) {
    clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').hidden=false;
    toastTimer=setTimeout(()=>{$('#toast').hidden=true},4000);
  }
  function markChanged() {$('#save-status').textContent='Preview updated. Your app settings are unchanged.'}
  function paintTheme(theme) {
    state.theme=theme;
    const effective=theme==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):theme;
    document.documentElement.dataset.theme=effective;
    $('#theme-toggle').innerHTML=icon(effective==='dark'?'sun':'moon');
    $('#theme-toggle').setAttribute('aria-label',`Switch to ${effective==='dark'?'light':'dark'} appearance`);
  }

  function setupMarkup() {
    const local=state.provider==='local';
    const available=local ? state.localEngine==='apple'||state.model==='ready' : state.connected[state.cloudProvider];
    const ready=available&&state.microphone;
    let title='Speak instead of typing', description='Download once, then dictate privately on this Mac.', action=button('Download & set up','download-model',true,'download');
    let status='One-time setup', extra='';
    if(!local&&!available){
      title='Use your speech provider';description='Connect your own account for cloud dictation.';status='Cloud setup';action=button('Connect provider','connect-inline',true);
      extra=`<div class="cloud-fields"><div class="dialog-field"><label for="cloud-provider">Provider</label>${select('cloud-provider',[['openai','OpenAI'],['deepgram','Deepgram'],['elevenlabs','ElevenLabs']],state.cloudProvider)}</div><label class="dialog-field" for="cloud-key">API key<input id="cloud-key" type="password" value="preview-example-key" disabled></label></div><p class="setup-note">${icon('cloud')}<span>Audio goes to ${providerName()}. Your provider’s API charges apply.</span></p><p class="preview-caption">Example key for this preview. Nothing is sent or stored.</p>`;
    } else if(available&&!state.microphone){
      title='Allow your microphone';description='Let Tasktap hear you when you hold the dictation shortcut.';status='Almost ready';action=button('Allow microphone','allow-microphone',true,'mic');
      extra=note('macOS will ask for microphone access. You can change this in System Settings.','lock');
    } else if(ready){
      title='You’re ready to dictate';description='Hold the shortcut, speak, then release. Review before sending.';status=local?'On this Mac · Offline':'Using '+providerName();
      action=button(state.sample==='listening'?'Listening…':state.sample==='done'?'Try again':'Try dictation','try-dictation',false,'mic');
      extra=`<div class="setup-shortcut"><div class="key-caps" aria-label="Control Option Space"><kbd>⌃</kbd><kbd>⌥</kbd><kbd>Space</kbd></div><span>Hold to speak · release to finish</span></div>${state.sample==='idle'?'':`<div class="sample-transcript" role="status"><span class="example-label">${state.sample==='listening'?'Example dictation':'Example transcript'}</span><p>${state.sample==='listening'?'Listening to the sample…':'Mach den Button größer, but keep the shortcut.'}</p></div>`}`;
    } else if(local&&state.model!=='missing'){
      const active=state.model==='downloading';
      title=active?'Getting dictation ready':state.model==='paused'?'Download paused':'Download interrupted';
      description=active?'You can keep typing while the voice model downloads.':state.model==='paused'?'Pick up where you left off whenever you’re ready.':'Check your connection and try again. Your draft is safe.';
      status=active?'Downloading model':'Setup unfinished';
      action=active?button('Cancel download','pause-download'):button(state.model==='paused'?'Resume download':'Retry download','download-model',true,'download');
      extra=`<div class="download-progress" role="progressbar" aria-label="Voice model download" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${state.progress}"><span style="width:${state.progress}%"></span></div><div class="download-meta"><span><span id="download-percent">${state.progress}%</span> complete</span><span>Whisper large-v3 Turbo</span></div>`;
    }
    return `<div class="setup-status${ready?' positive':''}">${icon(ready?'check':local?'lock':'cloud')}<span>${status}</span>${local&&state.model==='missing'?'<span class="setup-recommended">Recommended</span>':''}</div><div class="setup-overview"><span class="setup-symbol">${icon(ready?'check':'mic')}</span><div><h2 id="voice-setup-title">${title}</h2><p>${description}</p></div></div>${extra}<div class="setup-actions">${action}${ready?'':`<span class="setup-reassurance">${local?icon('lock')+'Your recordings stay on this Mac.':'Uses your speech API account.'}</span>`}</div>`;
  }
  function paintModel() {
    const target=$('#voice-setup');if(!target)return;
    const focused=target.contains(document.activeElement);
    target.innerHTML=setupMarkup();
    if(focused)target.querySelector('button')?.focus({preventScroll:true});
  }
  function startDownload() {
    state.model='downloading';paintModel();
    clearInterval(downloadTimer);
    downloadTimer=setInterval(()=>{
      state.progress=Math.min(100,state.progress+5);
      const progress=$('[role=progressbar]');
      if(progress){progress.setAttribute('aria-valuenow',String(state.progress));progress.querySelector('span').style.width=`${state.progress}%`;$('#download-percent').textContent=`${state.progress}%`}
      if(state.progress===100){clearInterval(downloadTimer);downloadTimer=null;state.model='ready';paintModel();}
    },350);
  }
  function dictation() {
    const local=state.provider==='local';
    return `<section class="voice-intro" aria-labelledby="voice-setup-title"><div class="voice-setup" id="voice-setup" aria-live="polite">${setupMarkup()}</div><div class="setup-alternative"><span>${local?'Already have a speech API account?':'Prefer to keep audio on your Mac?'}</span><button type="button" class="text-button" data-action="${local?'use-cloud':'use-local'}">${local?'Use a cloud provider instead':'Use on-device dictation'} ${icon('arrow')}</button></div></section>
      <div class="voice-defaults"><div>${icon('globe')}<p><strong>Speak naturally</strong><span>${state.inputLanguage==='auto'?'Your spoken language is detected automatically.':'A specific spoken language is selected in More options.'}</span></p></div><div>${icon('agents')}<p><strong>Your words stay yours</strong><span>Your request keeps its original language. ${state.replyLanguage==='english'?'Replies are set to English.':'Replies follow your request.'}</span></p></div></div>
      <details class="voice-options"><summary>More options</summary><div class="settings-group">${local?row('Speech model','Tasktap selects the recommended model during setup.',select('local-engine',[['whisper','Whisper large-v3 Turbo'],['apple','Apple dictation']],state.localEngine),'local-engine'):row('Speech connection',providerName(),button('Manage…','connect-cloud'))}${row('Spoken language','Override automatic detection if you need to.',select('input-language',[['auto','Detect automatically'],['de','German'],['en','English'],['fr','French'],['es','Spanish'],['ja','Japanese']],state.inputLanguage),'input-language')}${local&&state.model==='ready'?row('Downloaded model','Remove the model files to free space.',button('Remove model…','reset-model')):''}</div><p class="under-note">Reply language can be changed in <button class="text-button" data-action="go-agents">Agents & connections</button>.</p></details>`;
  }
  function readAloud() {
    return section('Completion narration',group(toggleRow('completion-narration','Read completion summaries aloud','Hear a short result when an agent finishes.')+
      (state.values['completion-narration']?row('Narration voice','Your Mac’s system voice is ready to use.',select('narration-voice',[['siri','Siri · System voice'],['kokoro','Kokoro · Heart (English)']],state.selected['narration-voice']),'narration-voice'):''))+
      (state.selected['narration-voice']==='kokoro'?`<div class="notice">${icon('download')}<div><strong>Download the narration model once.</strong><br>Kokoro runs locally after setup. Its voice model is separate from the dictation model.<div style="margin-top:10px">${button('Set up Kokoro…','kokoro-setup')}</div></div></div>`:''))+
      (state.values['completion-narration']?section('Try your voice',`<div class="preview-box"><span class="example-label">Example completion</span><p>Your task is ready. Open the session to review the changes.</p><div class="voice-lines" aria-hidden="true">${[7,12,18,10,23,16,8,14,21,12,6,13,19,10,16,7,12,20,9,14,6,11].map(h=>`<i style="height:${h}px"></i>`).join('')}</div>${button('Preview voice','preview-voice',false,'play')}</div>`):note('Optional. Turn this on to choose a voice and hear a preview.'));
  }
  function voice() {
    return `<div class="tabs" role="tablist" aria-label="Voice settings"><button id="tab-dictation" role="tab" aria-selected="${state.tab==='dictation'}" aria-controls="voice-panel" tabindex="${state.tab==='dictation'?0:-1}" data-tab="dictation">Dictation</button><button id="tab-narration" role="tab" aria-selected="${state.tab==='narration'}" aria-controls="voice-panel" tabindex="${state.tab==='narration'?0:-1}" data-tab="narration">Read aloud</button></div><div id="voice-panel" role="tabpanel" aria-labelledby="tab-${state.tab}">${state.tab==='dictation'?dictation():readAloud()}</div>`;
  }
  function general() {
    return section('Startup',group(toggleRow('start-login','Launch Tasktap at login','Keep capture a shortcut away when your Mac starts.')+toggleRow('keep-notch','Keep the notch available','Closing the workspace window keeps Tasktap within reach.')))+
      section('Updates',group(toggleRow('auto-update','Automatically check for updates','Get an update badge when a new version is available.')+row('Tasktap 1.1.0','Installation and restart always need your confirmation.',button('Check for updates','check-updates'))))+
      section('Getting started',group(row('Voice setup','Download a speech model once, or connect a cloud provider.',button('Set up voice…','voice-first-setup'))+row('Guided setup','Revisit the basics of capture, preparation, and project work.',button('Open setup…','open-setup'))+row('Documentation','Short guides for working with Tasktap.',button('Browse guides','open-docs'))));
  }
  function agents() {
    return section('Request preparation',group(row('Prepare requests with','Turn a captured thought into clearer wording for review.',select('preparation',[['local','On this Mac'],['codex','Codex connection'],['claude','Claude Code'],['compatible','Compatible model server']],state.selected.preparation),'preparation'))+note('Request preparation and the agent doing project work are separate choices.'))+
      section('Project work',group(row('Default coding agent','Used for new sessions. Existing conversations keep their agent.',select('default-agent',[['codex','Codex'],['claude','Claude Code'],['agy','Antigravity'],['cursor','Cursor CLI'],['pi','Pi']],state.selected['default-agent']),'default-agent')+
      row('Open sessions in','Work alongside your agents in an embedded terminal.',select('session-host',[['tasktap','Tasktap'],['ghostty','Ghostty'],['terminal','Terminal'],['cmux','cmux'],['iterm','iTerm2']],state.selected['session-host']),'session-host')+
      toggleRow('adaptive-models','Choose models by task difficulty','Let simple requests use a lighter model.')+
      row('Session models','Configure model choices for each coding agent.',button('Configure…','model-settings'))+
      row('Reply language','Code follows the project’s conventions. Replies follow your request.',select('reply-language',[['request','Follow my request'],['english','English']],state.replyLanguage),'reply-language')))+
      section('Agent connections',group(['Codex','Claude Code'].map((name,i)=>`<div class="setting-row"><div class="connection-copy"><span class="agent-mark">${i?'✳':'⌘'}</span><div class="setting-copy"><strong>${name}</strong><p>Uses the installed CLI and its own sign-in.</p></div></div><div class="connection-action"><span class="badge">Example account</span>${button('Manage…','agent-connection')}</div></div>`).join(''))+note('Speech API connections live in Voice.'));
  }
  function workspaces() {
    return section('Project location',group(row('Default workspace folder','New projects are created here. Open existing projects from anywhere.',`<span class="path">~/projects</span>${button('Choose…','choose-folder',false,'folder')}`)))+
      section('Session discovery',group(toggleRow('external-discovery','Find sessions in other apps','Read local session metadata from supported coding apps.'))+note('Discovery adds available sessions to the picker. You choose what to open in Tasktap.'))+
      section('Terminal defaults',group(row('Font and cursor','Use your terminal’s familiar typography.',select('terminal-font',[['ghostty','Follow Ghostty'],['system','System monospace']],state.selected['terminal-font']),'terminal-font')+row('Default text size','Each terminal can also have its own size.',select('terminal-size',[['12','12 pt'],['13','13 pt'],['14','14 pt'],['16','16 pt'],['18','18 pt']],state.selected['terminal-size']),'terminal-size')))+
      `<div class="notice">${icon('info')}<div><strong>Your workspace stays yours.</strong><br>Changing the default folder leaves existing projects in place. Saved layouts and background sessions remain available.</div></div>`;
  }
  function capture() {
    return section('Global shortcut',group(row('Capture a thought','Tap to type. Hold to dictate. Release to finish.',`<div class="key-caps" aria-label="Control Option Space"><kbd>⌃</kbd><kbd>⌥</kbd><kbd>Space</kbd></div>`)+row('Review a request','Check the wording, destination, and reference before sending.',`<div class="key-caps" aria-label="Command Return"><kbd>⌘</kbd><kbd>Return</kbd></div>`)))+
      section('Capture context',group(toggleRow('capture-context','Include a reference from the active app','Attach the current page or file when Tasktap can identify it.'))+note('The reference is captured when you begin. You can change or remove it during review.'))+
      section('Voice capture',group(row('Speak in your preferred language','Set up offline dictation or connect a cloud transcription provider.',button('Voice settings','go-voice'))))+
      section('Guided capture',group(row('Try the capture flow','Practice turning a thought into a reviewed task.',button('Try it…','guided-capture'))));
  }
  function notifications() {
    return section('Tasktap alerts',group(toggleRow('notifications-enabled','Allow Tasktap notifications','Get updates when you’re working in another app.')))+
      section('Notify me about',group(toggleRow('decision-alerts','An agent needs an answer','A decision or question is waiting for you.')+toggleRow('result-alerts','A result is ready','A completed task is available to review.')+toggleRow('failure-alerts','Something needs attention','A session has failed or needs help.')))+
      section('macOS notification settings',group(row('System permission','Example status. Banners and Focus are controlled by macOS.',button('Open System Settings…','system-notifications')))+note('Results always stay in Activity, even when notifications are turned off.'))+
      section('Audio',group(row('Read completion summaries aloud','Choose a local narration voice in Voice.',button('Read aloud settings','go-narration'))));
  }
  function appearance() {
    return section('Color theme',`<div class="themes" role="group" aria-label="Color theme">${[['dark','Midnight'],['light','Daylight'],['system','System']].map(([id,name])=>`<button type="button" class="theme-card" data-theme-choice="${id}" aria-pressed="${state.theme===id}"><div class="theme-scene" aria-hidden="true"><i></i><div><b></b><b></b><b></b></div></div><span>${name}${state.theme===id?icon('check'):''}</span></button>`).join('')}</div>`+note('Changes here also let you inspect this preview in light and dark.'))+
      section('Window',group(toggleRow('app-translucency','Native translucency','Let a little of your desktop show through the workspace.')+toggleRow('app-blur','Blur the background','Keep text legible over a translucent window.')))+
      section('Artwork & motion',group(row('Artwork','The visual study used on Tasktap’s capture surfaces.',select('artwork',[['resonator','Resonator'],['phase','Phase'],['glyph','Glyph'],['orbit','Orbit']],state.selected.artwork),'artwork')+toggleRow('reduce-motion','Reduce motion','Use still compositions in place of animated artwork.')))+
      section('Terminal appearance',group(row('Font, cursor, and text size','Configure terminal defaults alongside your workspace settings.',button('Terminal defaults','go-workspaces'))));
  }
  const views={general,agents,workspaces,capture,voice,notifications,appearance};
  $('#navigation').innerHTML=Object.entries(pages).map(([id,page],i)=>(i===6?'<div class="nav-separator"></div>':'')+`<button type="button" data-page="${id}">${icon(id)}<span>${page.name}</span></button>`).join('');
  function render(resetScroll=false) {
    const page=pages[state.page];
    const previousOptions=$('.voice-options');if(previousOptions)state.voiceOptionsOpen=previousOptions.open;
    $('#page-title').textContent=page.name;$('#page-description').textContent=page.description;
    $('#page-content').innerHTML=views[state.page]();
    const voiceOptions=$('.voice-options');if(voiceOptions)voiceOptions.open=state.voiceOptionsOpen;
    document.querySelectorAll('[data-page]').forEach(button=>{if(button.dataset.page===state.page)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current')});
    document.title=`Tasktap · ${page.name} preview`;
    if(resetScroll){$('#main').scrollTop=0;window.scrollTo(0,0)}
    const blur=$('#app-blur');if(blur)blur.disabled=!state.values['app-translucency'];
    const tryButton=$('[data-action="try-dictation"]');if(tryButton)tryButton.disabled=state.sample==='listening';
    for(const id of ['decision-alerts','result-alerts','failure-alerts']){const input=$('#'+id);if(input)input.disabled=!state.values['notifications-enabled']}
  }
  function navigate(page) {state.page=page;history.replaceState(null,'','#'+page);render(true)}

  function openDialog(title,body,actions='') {
    const dialog=$('#connection-dialog');
    dialog.innerHTML=`<div class="dialog-heading"><h2 id="connection-title">${title}</h2><button type="button" class="icon-button" aria-label="Close dialog" data-action="close-dialog">${icon('x')}</button></div>${body}${actions?`<div class="dialog-actions">${actions}</div>`:''}`;
    dialog.showModal();
  }
  function connectionDialog() {
    const name=providerName(),connected=state.connected[state.cloudProvider];
    openDialog(`${connected?'Manage':'Connect'} ${name}`,
      `<p class="dialog-description">${connected?'This is an example connection for exploring the design.':'Use your own speech API account. In the app, its key will be stored in macOS Keychain.'}</p>
      <label class="dialog-field">API key<input type="password" value="preview-key-placeholder" disabled aria-label="Example API key"></label>
      <p class="dialog-note">Design preview. No real API key is needed or stored.</p>
      <div class="notice">${icon('cloud')}<div>When selected, ${name} receives your audio for transcription. Usage is billed by the provider.</div></div>`,
      (connected?button('Disconnect','disconnect-cloud')+button('Test connection','test-connection',true):button('Cancel','close-dialog')+button('Simulate connection','simulate-connect',true)));
  }
  function infoDialog(title,description) {
    openDialog(title,`<p class="dialog-description">${description}</p><div class="dialog-detail">This is an interactive layout preview. Native actions and external connections will be wired up after the design is settled.</div>`,button('Done','close-dialog',true));
  }

  document.addEventListener('click',event=>{
    const page=event.target.closest('[data-page]');if(page){navigate(page.dataset.page);return}
    const tab=event.target.closest('[data-tab]');if(tab){state.tab=tab.dataset.tab;render();$(`[data-tab="${state.tab}"]`).focus({preventScroll:true});return}
    const theme=event.target.closest('[data-theme-choice]');if(theme){paintTheme(theme.dataset.themeChoice);render();$(`[data-theme-choice="${state.theme}"]`).focus({preventScroll:true});markChanged();return}
    if(event.target.closest('#theme-toggle')){paintTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');if(state.page==='appearance')render();return}
    const action=event.target.closest('[data-action]')?.dataset.action;
    if(!action)return;
    switch(action) {
      case 'close-dialog':$('#connection-dialog').close();break;
      case 'download-model':
        startDownload();markChanged();break;
      case 'pause-download':clearInterval(downloadTimer);downloadTimer=null;state.model='paused';paintModel();break;
      case 'fail-download':clearInterval(downloadTimer);downloadTimer=null;state.model='failed';paintModel();showToast('Preview: connection interrupted. Your draft would stay available.');break;
      case 'reset-model':openDialog('Remove voice model?',`<p class="dialog-description">Offline dictation with Whisper will need another download. You can still type or choose another transcription provider.</p><p class="dialog-note">Preview only. No files will be removed.</p>`,button('Keep model','close-dialog')+button('Remove example model','confirm-reset'));break;
      case 'confirm-reset':$('#connection-dialog').close();state.model='missing';state.progress=0;state.values['local-fallback']=false;paintModel();break;
      case 'use-cloud':state.provider='cloud';state.sample='idle';render();$('[data-action="connect-inline"], [data-action="allow-microphone"], [data-action="try-dictation"]')?.focus({preventScroll:true});break;
      case 'use-local':state.provider='local';state.sample='idle';render();$('#voice-setup button')?.focus({preventScroll:true});break;
      case 'connect-inline':state.connected[state.cloudProvider]=true;paintModel();markChanged();break;
      case 'allow-microphone':state.microphone=true;paintModel();markChanged();break;
      case 'try-dictation':
        if(state.sample==='listening')break;
        state.sample='listening';paintModel();$('[data-action="try-dictation"]').disabled=true;
        clearTimeout(sampleTimer);sampleTimer=setTimeout(()=>{state.sample='done';paintModel()},1200);break;
      case 'connect-cloud':connectionDialog();break;
      case 'simulate-connect':state.connected[state.cloudProvider]=true;$('#connection-dialog').close();render();markChanged();showToast(`${providerName()} example connected. No API call was made.`);break;
      case 'disconnect-cloud':state.connected[state.cloudProvider]=false;$('#connection-dialog').close();render();markChanged();break;
      case 'test-connection':$('#connection-dialog').close();showToast('Preview: connection test succeeded. No request was sent.');break;
      case 'voice-first-setup':state.tab='dictation';navigate('voice');$('#voice-setup button')?.focus({preventScroll:true});break;
      case 'go-voice':state.tab='dictation';navigate('voice');break;
      case 'go-narration':state.tab='narration';navigate('voice');break;
      case 'go-workspaces':navigate('workspaces');break;
      case 'go-agents':navigate('agents');$('#reply-language')?.focus({preventScroll:true});break;
      case 'preview-voice':showToast('Preview only. Voice playback will use the selected local voice.');break;
      case 'kokoro-setup':infoDialog('Set up local narration','The app will download the Kokoro model and voice files once, then run narration offline. This is separate from your dictation setup.');break;
      case 'choose-folder':infoDialog('Choose workspace folder','The Mac app will open the native folder picker. Existing workspaces stay in place.');break;
      case 'check-updates':infoDialog('Check for updates','Tasktap will use its native update flow. An available update can be reviewed before installation.');break;
      case 'system-notifications':infoDialog('macOS notifications','The Mac app will open its notification settings in System Settings. Tasktap enablement, system authorization, and Focus are separate states.');break;
      case 'agent-connection':infoDialog('Agent connection','The app will show the installed CLI, its sign-in status, and available setup actions. Coding-agent access is separate from speech API billing.');break;
      case 'model-settings':infoDialog('Session models','Choose fixed or adaptive models for each agent. Adaptive routing can use a lighter model for simple tasks and a stronger one for complex work.');break;
      case 'guided-capture':infoDialog('Guided capture','The app will reopen the capture walkthrough, with a shortcut to type or dictate and a review before sending.');break;
      case 'open-setup':infoDialog('Guided setup','The setup flow will include optional voice model download, microphone permissions, and an offline dictation check. Typing remains available while the model downloads.');break;
      case 'open-docs':infoDialog('Tasktap guides','The app will open the guide for capture, project work, terminal sessions, and voice setup.');break;
    }
  });
  document.addEventListener('change',event=>{
    const input=event.target,id=input.id;
    if(input.matches('.toggle')){state.values[id]=input.checked;markChanged();if(['app-translucency','notifications-enabled','completion-narration'].includes(id)){render();$('#'+id)?.focus({preventScroll:true})}return}
    if(input.tagName!=='SELECT')return;
    if(id==='local-engine'){state.localEngine=input.value;render()}
    else if(id==='cloud-provider'){state.cloudProvider=input.value;render()}
    else if(id==='input-language'){state.inputLanguage=input.value;render()}
    else if(id==='reply-language'){state.replyLanguage=input.value}
    else{state.selected[id]=input.value;if(id==='narration-voice')render()}
    $('#'+id)?.focus({preventScroll:true});markChanged();
  });
  document.addEventListener('keydown',event=>{
    const target=event.target;
    if(target.matches('[role=tab]')&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
      event.preventDefault();state.tab=event.key==='Home'?'dictation':event.key==='End'?'narration':state.tab==='dictation'?'narration':'dictation';render();$(`[data-tab="${state.tab}"]`).focus();
    }
  });
  window.addEventListener('hashchange',()=>{const page=location.hash.slice(1);if(Object.hasOwn(pages,page)){state.page=page;render(true)}});
  paintTheme(state.theme);render();
})();
