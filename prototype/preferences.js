// The expanded Preferences window reuses the existing, real settings controls.
// Secondary editors retain their own save/cancel flows.
const preferencesPanel=(()=>{
  const groups={general:'General',agents:'Agents & connections',workspaces:'Workspaces',capture:'Capture',voice:'Voice',notifications:'Notifications',appearance:'Appearance'};
  const descriptions={general:'Make Tasktap fit your day.',agents:'Choose who prepares your requests and who does the work.',workspaces:'Keep your projects and working context together.',capture:'A shortcut from a passing thought to a reviewed request.',voice:'Speak in your own language. Tasktap takes care of the rest.',notifications:'Stay in the loop without breaking your concentration.',appearance:'One palette for your workspace, terminals, and preferences.'};
  const symbols={general:'settings',agents:'codex',workspaces:'folder',capture:'pen',voice:'mic',notifications:'bell',appearance:'grid'};
  let applicationSettings=null;
  function receiveApplicationSettings(value){
    applicationSettings=value;
    const input=$('#preferences #launch-at-login');if(input){input.checked=value.launchAtLogin===true;input.disabled=false}
    const detail=$('#login-status');if(detail)detail.textContent=value.requiresApproval?'Approve Tasktap in System Settings → Login Items.':'Keep capture a shortcut away when your Mac starts.';
  }
  function section(title,body){return '<section class="preferences-section"><h3>'+title+'</h3><div class="preferences-section-body">'+body+'</div></section>'}
  function markup(group){
    if(group==='general')return section('Startup',live?'<label class="policy-switch" for="launch-at-login"><span>Launch Tasktap at login</span><input type="checkbox" id="launch-at-login" '+(applicationSettings?.launchAtLogin?'checked':'')+' '+(!applicationSettings?'disabled':'')+'></label><p class="hint" id="login-status">Keep capture a shortcut away when your Mac starts.</p>':'<p class="hint">Launch at Login is available in the Mac app.</p>')+section('Getting started',
      jump('Voice setup','Download a local speech model or connect a cloud provider.','voice-open','mic')+
      jump('Guided setup','Revisit capture, request preparation, and project work.','run-setup','settings'))+
      section('Updates',appUpdates.preferences()+'<div class="inline">'+(live?button('Check for Updates…','check-updates'):'<p class="hint">Update checks are available in the Mac app.</p>')+'</div>');
    if(group==='agents'){
      const policy=sessionModelPolicy(),profile=policy.agents[policy.defaultAgent];
      return section('Request preparation',aiConnections.jump())+
        section('Project work',(live?jump('Agent setup','Manage installed coding agents and their own sign-ins.','agent-setup','settings'):'')+
          jump('Session models',[providers[policy.defaultAgent],policy.adaptive?'Difficulty curve':profile.fixed].filter(Boolean).join(' / '),'session-models','sessions')+
          (live?workerRouting.jump():''))+
        section('Language',settingsField('agent-reply-language','Reply language','<select id="agent-reply-language">'+option('request','Follow my request',state.agentReplyLanguage||'request')+option('english','English',state.agentReplyLanguage||'request')+'</select>')+
          '<p class="hint">Code, comments, and documentation follow the project’s conventions. Final replies follow your request, unless you choose English. Your original request is preserved.</p>');
    }
    if(group==='workspaces')return section('Projects',workspaceSettings.markup())+section('Terminal',jump('Terminal preferences','Shell, font, cursor, and default text size.','deck-preferences','terminal'));
    if(group==='capture')return section('Global shortcut','<div class="preferences-shortcut"><kbd aria-label="Control Option Space">⌃ ⌥ Space</kbd><p class="hint">Tap to type. Hold to speak, then release.</p></div>')+
      section('Reference',captureContext.preference())+section('Try capture',surfaceButton('Reopen guided capture','guide-replay','pen','btn')+jump('Voice setup','Choose local or cloud dictation.','voice-open','mic')+(!live?button('Reset sample data','reset','','text-btn'):''));
    if(group==='voice')return voiceSettings.markup();
    if(group==='notifications')return section('Tasktap alerts','<div id="notification-preferences"><p class="hint">Receive alerts for decisions, results, and failures. Results always stay in Activity.</p><div id="notification-status" role="status" aria-live="polite"></div><div id="notification-controls" class="inline"></div><p class="hint">macOS and Focus control whether an allowed alert appears.</p><div id="notification-error"></div></div>')+
      section('Audio',jump('Read completion summaries aloud','Choose a local narration voice in Voice.','voice-narration','sound'));
    const themes=TasktapArt.catalog.map(theme=>'<option value="'+attr(theme.id)+'" data-art="'+attr(theme.id)+'" data-detail="'+attr(theme.medium)+'" '+(TasktapArt.current()===theme.id?'selected':'')+'>'+esc(theme.name)+'</option>').join('');
    return section('App appearance',appAppearance.markup())+section('Artwork',settingsField('visual-theme','Artwork','<select id="visual-theme">'+themes+'</select>'));
  }
  function jump(title,description,action,symbol){
    return '<button type="button" class="settings-jump" aria-label="'+attr(title)+'" '+(action==='agent-setup'?'id="agent-setup-link" ':'')+'data-action="'+action+'"><span class="jump-mark">'+icon(symbol)+'</span><span><strong>'+esc(title)+'</strong><small '+(action==='agent-setup'?'hidden':'')+'>'+esc(description)+'</small></span>'+icon('right')+'</button>';
  }
  function open(group){
    group=Object.hasOwn(groups,group)?group:Object.hasOwn(groups,state.preferencesCategory)?state.preferencesCategory:'general';
    if(live&&window.tasktapSurface==='notch'){postLive('preferences-open',{group});return}
    state.preferencesCategory=group;persist();
    const nav='<nav class="preferences-nav" aria-label="Preferences categories">'+Object.entries(groups).map(([id,label])=>'<button type="button" data-action="prefs-group" data-id="'+id+'" aria-pressed="'+(id===group)+'" '+(id===group?'aria-current="page"':'')+'>'+icon(symbols[id])+'<span>'+esc(label)+'</span></button>').join('')+'</nav>';
    dialog('Preferences','Tasktap','<div id="preferences" class="preferences-shell settings-form"><aside class="preferences-sidebar"><div class="preferences-brand"><span class="jump-mark">'+icon('mic')+'</span><div><strong>Tasktap</strong><span>Preferences</span></div></div>'+nav+'<div class="preferences-sidebar-foot">'+button('Documentation','open-docs',group,'text-btn','out')+'</div></aside><div class="preferences-main"><header class="preferences-heading"><span class="eyebrow">Preferences</span><h2>'+groups[group]+'</h2><p class="hint">'+descriptions[group]+'</p></header><div class="preferences-content" aria-label="'+groups[group]+'">'+markup(group)+'</div></div></div>');
    $('#modal').classList.add('preferences-dialog');
    $('.preferences-sidebar-foot').insertAdjacentHTML('afterbegin',button('Run setup…','run-setup','','text-btn','settings'));
    const close=$('#modal .dialog-title .icon-btn');close.classList.add('preferences-close');
    $('#preferences').append(close);
    $('#modal .dialog-title').hidden=true;
    if(group==='general'&&live){postLive('application-settings');$('#launch-at-login').onchange=e=>{const enabled=e.target.checked;e.target.disabled=true;postLive('launch-at-login',{enabled})}}
    if(group==='capture')captureContext.bindPreference();
    if(group==='agents'){
      if(live)aiConnections.refresh();
      $('#agent-reply-language').onchange=e=>{state.agentReplyLanguage=e.target.value;persist()};
    }
    if(group==='appearance'){appAppearance.bind();$('#visual-theme').onchange=e=>TasktapArt.select(e.target.value)}
    if(group==='voice'){voiceSettings.bind();voiceSettings.refresh()}
    if(group==='notifications'){paintNotificationSettings();if(live)postLive('notification-status')}
    settingsPickers.mount($('#preferences'));
    const selected=$('.preferences-nav [aria-current=page]');
    if(innerWidth<=540)selected?.scrollIntoView({block:'nearest',inline:'center'});
  }
  document.addEventListener('click',e=>{
    const action=e.target.closest('[data-action]')?.dataset.action;
    if(action==='voice-open')voiceSettings.open();
    if(action==='voice-narration'){voiceSettings.open();$('#voice-tab-narration')?.click()}
  });
  return {open,receiveApplicationSettings};
})();
