/* The sidebar indexes workspaces. Conversation discovery belongs in history and
 * Other apps; it must never manufacture a Tasktap terminal or resume a process. */
const workspaceNavigation=(()=>{
  const saved=state.workspaceDeck;
  // Migrate once from actual saved views. Discovered processes never decide
  // which workspaces the user has open after this point.
  if(!Array.isArray(saved.openProjects)){
    saved.openProjects=Object.entries(saved.layouts||{}).filter(([,l])=>l.groups?.some(g=>g.tabs?.length)).map(([id])=>id);
    if(proj(view)&&!saved.openProjects.includes(view))saved.openProjects.push(view);
    persist();
  }
  const narrow=()=>matchMedia('(max-width:740px)').matches;
  const discoveryEnabled=()=>typeof workspaceSettings!=='undefined'&&workspaceSettings.current().externalDiscovery===true;
  const externalSessions=()=>state.sessions.filter(s=>s.host!=='tasktap' && (s.external || s.host || s.source));
  const hostName=s=>sessionLocation(s)||'Original app';
  const folderKey=value=>String(value||'').replace(/\/+/g,'/').replace(/\/(?:\.\/)+/g,'/').replace(/\/$/,'');
  function projectForSession(s){
    return state.projects.find(p=>p.id===s.project || folderKey(p.folder) && folderKey(p.folder)===folderKey(s.project));
  }
  function workingSessions(){
    const data=workspaceDeck.sidebarData(),terminals=new Map(data.terminals.map(t=>[t.id,t]));
    return state.sessions.filter(s=>{
      if(s.state!=='Running' || s.available===false || s.host==='claude-desktop' || s.external && !discoveryEnabled())return false;
      const p=projectForSession(s);
      if(!p || p.available===false || saved.closedWorkspaces?.[p.id] || terminals.get(s.id)?.running===false)return false;
      // An external follow-up can be in transit while its original worker is idle.
      const turn=state.captures.find(c=>c.session===s.id);
      return !(turn?.external && ['Queued','Running'].includes(turn.receipt));
    });
  }
  function openAction(s){
    if(!live)return null;
    if(s.source==='desktop' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(s.conversation||''))return {label:'Open in ChatGPT',type:'open-desktop-chat',id:s.conversation};
    // Warp's existing focus adapter creates a new tab and reattaches. Leave that
    // explicit operation in session details, rather than calling it "Open" here.
    if(s.host==='warp' || s.available!==true || ['Closed','Queued','Opening','Unavailable'].includes(s.state))return null;
    if(s.host==='claude-desktop')return {label:'Open brief in Claude Desktop',type:'focus-session',id:s.id};
    if(s.interactive && terminalHosts.valid(s.host) || s.source==='cmux' && s.inbox==='cmux')return {label:'Open in '+hostName(s),type:'focus-session',id:s.id};
    return null;
  }
  const projects=()=>[...new Set(saved.openProjects)].map(id=>proj(id)).filter(Boolean);
  function attention(p,data){
    const belongs=id=>state.sessions.some(s=>s.id===id&&s.project===p.id&&s.host==='tasktap')||data.layouts[p.id]?.groups.some(g=>g.tabs.includes('terminal:'+id))||data.terminals.some(t=>t.id===id&&t.cwd===p.folder);
    if(state.decisions.some(q=>belongs(q.session)))return {kind:'input',label:'Needs your input',symbol:'attention'};
    const unread=saved.activity.filter(a=>!a.read&&belongs(a.id));
    if(unread.some(a=>a.kind==='failure'))return {kind:'failure',label:'Needs attention',symbol:'attention'};
    if(unread.some(a=>a.kind==='complete'))return {kind:'complete',label:'Result ready',symbol:'check'};
    const working=workingSessions().filter(s=>projectForSession(s)?.id===p.id);
    if(working.length)return {kind:'working',label:'Working: '+working.map(sessionDisplayName).join(' · '),symbol:'sessions'};
    return null;
  }
  function backgroundRows(p,data){
    const rows=Object.entries(data.background).filter(([,project])=>project===p.id);
    if(!rows.length)return '';
    const expanded=saved.navigationExpanded?.[p.id]!==false;
    return '<div class="nav-background" id="background-'+attr(p.id)+'"'+(!expanded?' hidden':'')+'>'+rows.map(([id])=>{
      const cue=data.cue(id),title=data.label('terminal:'+id);
      return '<div class="nav-background-row"><button type="button" class="nav-background-session" data-status="'+cue.kind+'" data-action="workspace-background" data-id="'+attr(id)+'" title="'+attr(title+' / '+cue.label)+'"><span class="nav-background-symbol" aria-hidden="true">'+cue.symbol+'</span><span class="nav-background-copy"><strong>'+esc(title)+'</strong><small>'+esc(cue.label)+'</small></span></button><button type="button" class="nav-background-stop" data-action="deck-stop" data-id="'+attr(id)+'" aria-label="'+attr('Stop '+title)+'" title="Stop session">'+icon('stop')+'</button></div>';
    }).join('')+'</div>';
  }
  function project(p,data){
    const children=backgroundRows(p,data),expanded=saved.navigationExpanded?.[p.id]!==false;
    const working=workingSessions().filter(s=>projectForSession(s)?.id===p.id),status=attention(p,data);
    const detail=[status?.label,status?.kind!=='working' && working.length?'Working: '+working.map(sessionDisplayName).join(' · '):''].filter(Boolean).join(' / ');
    const description=[p.folder,detail].filter(Boolean).join(' / ');
    return '<section class="nav-workspace'+(view===p.id?' is-current':'')+'" data-workspace="'+attr(p.id)+'" data-working="'+!!working.length+'"'+(status?' data-status="'+status.kind+'"':'')+'><div class="nav-workspace-heading">'+(children?'<button type="button" class="nav-workspace-disclosure" data-action="workspace-background-toggle" data-id="'+attr(p.id)+'" aria-label="'+attr((expanded?'Collapse':'Expand')+' background sessions for '+p.name)+'" aria-expanded="'+expanded+'" aria-controls="background-'+attr(p.id)+'">'+icon('right')+'</button>':'')+'<button type="button" class="nav-workspace-name" data-action="workspace-project" data-id="'+attr(p.id)+'" title="'+attr(description)+'" aria-label="'+attr([p.name,detail].filter(Boolean).join(', '))+'"'+(view===p.id?' aria-current="page"':'')+'>'+icon('folder')+'<span>'+esc(p.name)+'</span></button>'+(status?'<span class="nav-workspace-status" role="img" aria-label="'+attr(status.label)+'" title="'+attr(status.label)+'">'+icon(status.symbol)+'</span>':'')+'<button type="button" class="nav-workspace-close" data-action="workspace-close" data-id="'+attr(p.id)+'" aria-label="'+attr('Close '+p.name+' workspace')+'" title="Close workspace and stop its sessions.">'+icon('x')+'</button></div>'+children+'</section>';
  }
  function navigation(){
    const data=workspaceDeck.sidebarData(),unread=saved.activity.filter(a=>!a.read).length;
    const external=discoveryEnabled()?externalSessions().filter(s=>s.available===true).length:0;
    const open=projects();
    return '<div class="nav-group nav-primary">'+navLink('overview','Home',icon('grid'))+navLink('notes','Notebook',icon('note'))+navLink('sessions','Session history',icon('sessions'))+'<button type="button" class="nav-link" data-action="deck-activity">'+icon('bell')+'<span class="label">Activity</span>'+(unread?'<span class="nav-count">'+unread+'</span>':'')+'</button></div><div class="nav-group nav-workspaces"><div class="nav-workspaces-heading"><span class="nav-kicker">Workspaces</span><button type="button" class="nav-workspace-add" data-action="workspace-chooser" title="Open workspace" aria-label="Open workspace">'+icon('plus')+'</button></div>'+open.map(p=>project(p,data)).join('')+(!open.length?'<span class="nav-workspace-empty">No open workspaces</span>':'')+navLink('projects','All projects…',icon('folder'))+'</div><div class="nav-group"><button type="button" class="nav-link" data-action="workspace-other-apps">'+icon('out')+'<span class="label">Other apps</span>'+(external?'<span class="nav-count">'+external+'</span>':'')+'</button></div>';
  }
  function sync(){
    document.body.classList.add('workspace-navigation');
    document.body.classList.toggle('deck-sidebar-hidden',!!saved.sidebarHidden);
    const visible=narrow()?document.body.classList.contains('nav-open'):!saved.sidebarHidden&&!document.body.classList.contains('deck-focus');
    for(const el of document.querySelectorAll('[data-action="menu"],[data-action="deck-sidebar"]')){
      el.setAttribute('aria-label','Toggle sidebar');el.title='Toggle sidebar';el.setAttribute('aria-controls','sidebar');el.setAttribute('aria-expanded',String(visible));
    }
  }
  function toggle(){
    const l=saved.layouts[view];
    if(l?.focus){
      l.focus=false;saved.sidebarHidden=false;document.body.classList.toggle('nav-open',narrow());persist();render();
    }else if(narrow())document.body.classList.toggle('nav-open');
    else{
      saved.sidebarHidden=!saved.sidebarHidden;persist();render();
    }
    sync();
  }
  function refresh(){const nav=$('#nav'),scroll=nav.scrollTop;nav.innerHTML=navigation();nav.scrollTop=scroll;sync()}
  function workspaceChoices(query=''){
    const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),open=new Set(saved.openProjects);
    const known=[...new Set([...state.projects.map(p=>p.id),...Object.keys(saved.layouts)])].map(id=>proj(id)).filter(Boolean);
    const candidates=known.filter(p=>!open.has(p.id)&&words.every(word=>[p.name,p.folder].join(' ').toLocaleLowerCase().includes(word)));
    const closed=candidates.filter(p=>Object.hasOwn(saved.layouts,p.id)),other=candidates.filter(p=>!Object.hasOwn(saved.layouts,p.id));
    const section=(title,rows)=>rows.length?'<section class="workspace-picker-section"><h3>'+esc(title)+'</h3>'+rows.map(p=>'<button type="button" class="workspace-picker-row" data-action="workspace-open-existing" data-id="'+attr(p.id)+'" title="'+attr(p.folder)+'">'+icon('folder')+'<span><strong>'+esc(p.name)+'</strong><small>'+(p.available===false?'Folder unavailable / ':'')+esc(p.folder)+'</small></span>'+icon('right')+'</button>').join('')+'</section>':'';
    $('#workspace-picker-results').innerHTML=section('Closed workspaces',closed)+section('Project folders',other)||'<p class="nav-external-empty">'+(query?'No workspaces match your search.':'Choose an existing folder or create a new one to get started.')+'</p>';
  }
  function openChooser(){
    dialog('Open workspace','Workspaces','<section class="workspace-picker"><div class="workspace-picker-actions">'+button('Open folder…','workspace-open-folder','','btn','folder')+button('New workspace…','workspace-new-folder','','btn','plus')+'</div><label class="sr-only" for="workspace-picker-search">Find a workspace or folder</label><input type="search" id="workspace-picker-search" placeholder="Find a workspace or folder…" autocomplete="off"><div id="workspace-picker-results"></div><p class="hint">Closing a workspace stops its sessions. Reopening restores its saved layout and history without restarting processes.</p></section>');
    workspaceChoices();$('#workspace-picker-search').focus();
  }
  function pickerRows(query=''){
    const words=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const sessions=externalSessions().filter(s=>words.every(word=>[sessionDisplayName(s),hostName(s),proj(s.project)?.name,s.state].join(' ').toLocaleLowerCase().includes(word))).sort((a,b)=>Number(b.available===true)-Number(a.available===true));
    const results=$('#workspace-external-results');if(!results)return;
    results.innerHTML=sessions.length?sessions.map(s=>{
      const action=openAction(s),label=sessionDisplayName(s),details=[hostName(s),proj(s.project)?.name,!discoveryEnabled()?'Saved session':s.available===true?'':s.state||'Unavailable'].filter(Boolean).join(' / ');
      return '<article class="nav-external-row"><span class="nav-external-icon">'+icon(s.agent||'sessions')+'</span><div class="nav-external-copy"><strong title="'+attr(label)+'">'+esc(label)+'</strong><span>'+esc(details)+'</span></div><div class="nav-external-actions">'+(action?button(action.label,'workspace-external-open',s.id,'btn','out'):'')+button('Details','workspace-external-details',s.id,'text-btn')+'</div></article>';
    }).join(''):'<p class="nav-external-empty">'+(query?'No sessions match your search.':discoveryEnabled()?'No sessions have been found in other apps. They appear here when Tasktap discovers them.':'No saved sessions. Turn on discovery to find sessions in other apps.')+'</p>';
    $('#workspace-external-count').textContent=sessions.length+' session'+(sessions.length===1?'':'s');
  }
  function discoveryStatus(){
    const target=$('#workspace-external-status');if(!target)return;
    target.innerHTML=discoveryEnabled()?'<p class="hint">Discovery is on. Open a session in the app where it is running.</p>':'<div class="nav-external-optin"><p class="hint">Discovery is off. You can still open saved sessions below.</p>'+button('Find sessions in other apps','workspace-enable-discovery','','btn','out')+'</div>';
  }
  function otherApps(){
    dialog('Other apps','Sessions','<section class="nav-external-picker"><div id="workspace-external-status"></div><label class="sr-only" for="workspace-external-search">Search sessions or apps</label><input type="search" id="workspace-external-search" placeholder="Search sessions or apps…" autocomplete="off"><span id="workspace-external-count" class="hint" role="status"></span><div id="workspace-external-results"></div></section>');
    discoveryStatus();pickerRows();$('#workspace-external-search').focus();
  }
  document.addEventListener('pointerdown',event=>{
    if(event.button!==0 || !document.body.classList.contains('native-host') || document.body.classList.contains('notch-first'))return;
    if(!event.target.closest('.deck-tools,.toolbar,#sidebar>.brand') || event.target.closest('button,a,input,summary,[role="button"]'))return;
    event.preventDefault();postHost('workspace-drag');
  });
  document.addEventListener('click',event=>{
    const el=event.target.closest('[data-action]');if(!el)return;
    const id=el.dataset.id;
    switch(el.dataset.action){
      case 'workspace-background-toggle':saved.navigationExpanded??={};saved.navigationExpanded[id]=saved.navigationExpanded[id]===false;persist();refresh();break;
      case 'workspace-background':workspaceDeck.openTerminal(id);break;
      case 'workspace-project':workspaceDeck.openWorkspace(id,false);break;
      case 'workspace-close':workspaceDeck.closeWorkspace(id);break;
      case 'workspace-chooser':openChooser();break;
      case 'workspace-open-existing':{const fresh=!Object.hasOwn(saved.layouts,id)&&proj(id)?.available!==false;dismissCard();workspaceDeck.openWorkspace(id,fresh);break;}
      case 'workspace-open-folder':if(live){dismissCard();postLive('workspace-open-folder')}else toast('Choose folders in the installed Mac app.');break;
      case 'workspace-new-folder':workspaceSettings.create();break;
      case 'workspace-other-apps':otherApps();break;
      case 'workspace-enable-discovery':workspaceSettings.setDiscovery(true);break;
      case 'workspace-external-details':showSession(id);break;
      case 'workspace-external-open':{const s=sess(id),action=s&&openAction(s);if(action)postLive(action.type,{id:action.id});else pickerRows($('#workspace-external-search')?.value);break;}
    }
  });
  document.addEventListener('input',event=>{if(event.target.id==='workspace-external-search')pickerRows(event.target.value);else if(event.target.id==='workspace-picker-search')workspaceChoices(event.target.value)});
  document.addEventListener('workspace-changed',()=>requestAnimationFrame(()=>{sync();const search=$('#workspace-external-search');if(search)pickerRows(search.value)}));
  document.addEventListener('workspace-settings-changed',()=>{refresh();discoveryStatus();if($('#workspace-external-search'))pickerRows($('#workspace-external-search').value)});
  window.addEventListener('resize',sync);
  return {navigation,sync,toggle,openChooser,workingSessions,projectForSession};
})();
if(location.hash!=='#geometry')render();
