/* Workspace surfaces are views; the private PTY service owns running processes.
 * Untrusted documents only enter sandboxed frames or textContent, never app HTML.
 */
const workspaceDeck=(()=>{
  state.workspaceDeck??={layouts:{},media:{},preferences:{shell:'default'},activity:[],seen:{}};
  const saved=state.workspaceDeck;
  for(const l of Object.values(saved.layouts)){workspaceLayout.ensure(l);const selected=l.groups[l.selected];l.groups=l.groups.filter(g=>g.tabs.length);l.selected=Math.max(0,l.groups.indexOf(selected));workspaceLayout.ensure(l)}
  saved.activity??=[];saved.seen??={};saved.preferences??={shell:'default'};
  if(!saved.preferences.appearanceVersion){delete saved.preferences.font;saved.preferences.appearanceVersion=1}
  saved.sidebarHidden??=false;
  const neutral={source:'Tasktap',fontFamilies:['Menlo','Monaco'],fontSize:14,padding:[8,8,8,8],cursorStyle:'block',cursorBlink:false,opacity:.93,theme:{background:'#0d1117',foreground:'#d8dee9',cursor:'#d8dee9',selectionBackground:'#364253',black:'#21252b',red:'#e06c75',green:'#98c379',yellow:'#e5c07b',blue:'#61afef',magenta:'#c678dd',cyan:'#56b6c2',white:'#abb2bf',brightBlack:'#5c6370',brightRed:'#e06c75',brightGreen:'#98c379',brightYellow:'#e5c07b',brightBlue:'#61afef',brightMagenta:'#c678dd',brightCyan:'#56b6c2',brightWhite:'#ffffff'}};
  let inherited=saved.appearance||neutral;
  const appearance=()=>{
    const base=saved.preferences.followGhostty===false?neutral:{...neutral,...inherited};
    const colors=typeof appAppearance!=='undefined'?appAppearance.current().terminalTheme:inherited.theme;
    return {...base,theme:{...neutral.theme,...colors}};
  };
  const smallButton=(label,action,id,sym)=>'<button type="button" class="deck-icon" data-action="'+action+'" data-id="'+attr(id||'')+'" title="'+attr(label)+'" aria-label="'+attr(label)+'">'+icon(sym)+'</button>';
  const menu=(label,contents,sym='more')=>'<details class="deck-menu"><summary title="'+attr(label)+'" aria-label="'+attr(label)+'">'+(sym==='more'?'<span aria-hidden="true">⋯</span>':icon(sym))+'</summary><div class="deck-menu-list">'+contents+'</div></details>';
  const terminals=new Map(), engines=new Map(), projects=new Map(), previews=new Map(), pendingStarts=new Map();
  let connected=false, activeProject=null, refreshTimer=null;
  const stage=document.createElement('section');stage.id='workspace-stage';stage.hidden=true;stage.setAttribute('aria-label','Project workspace');$('.work').append(stage);
  const stash=document.createElement('div');stash.hidden=true;stage.append(stash);
  const send=(op,values={})=>{if(live)postLive('workspace-terminal',{op,...values})};
  const bytes=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
  const encoded=text=>{const data=new TextEncoder().encode(text);let value='';for(const b of data)value+=String.fromCharCode(b);return btoa(value)};
  const layout=id=>workspaceLayout.ensure(saved.layouts[id]??={groups:[],selected:0});
  function selectedGroup(l){if(!l.groups.length){l.groups.push({id:uid(),tabs:[],active:null});workspaceLayout.ensure(l)}return l.groups[l.selected]}
  const termID=key=>key?.startsWith('terminal:')?key.slice(9):null;
  const mediaID=key=>key?.startsWith('media:')?key.slice(6):null;
  const projectFor=folder=>state.projects.find(p=>p.folder===folder || p.id===folder);
  function applyAppearance(){
    const a=appearance(),style=document.documentElement.style;
    style.setProperty('--deck-bg',a.theme.background);style.setProperty('--deck-fg',a.theme.foreground);
    style.setProperty('--deck-padding',a.padding.map(n=>n+'px').join(' '));
    const font=a.fontFamilies.map(f=>JSON.stringify(f)).join(',')+', monospace';
    for(const en of engines.values()) {en.term.options.theme={...a.theme,background:a.theme.background+'00'};en.term.options.fontFamily=font;en.term.options.fontSize=saved.preferences.font||a.fontSize;en.term.options.cursorStyle=a.cursorStyle;en.term.options.cursorBlink=a.cursorBlink;fit(en)}
    if(live)postLive('workspace-chrome',{background:a.theme.background,followSystem:typeof appAppearance!=='undefined'&&appAppearance.current().id==='system',opacity:saved.preferences.translucent===false?1:inherited.opacity??neutral.opacity,blur:saved.preferences.blur!==false});
  }
  function appearanceLoaded(value){inherited=value;saved.appearance=value;persist();if(typeof appAppearance!=='undefined')appAppearance.receiveGhostty(value);applyAppearance();const note=$('#deck-appearance-source');if(note)note.textContent=appearanceDescription()}
  function appearanceDescription(){const a=appearance();return a.source==='Ghostty'?'Ghostty typography / '+a.fontFamilies[0]+' / '+a.fontSize+' pt':a.note||'Using the default terminal font and cursor.'}
  document.addEventListener('appearance-changed',applyAppearance);
  function report(id){const capture=byId(state.captures,id),session=sess(capture?.session||id);return {capture,session,text:capture?.result||session?.result||'No outcome has been reported yet.'}}
  function label(key){const id=termID(key);if(id)return sess(id)?sessionDisplayName(sess(id)):terminals.get(id)?.title||'Terminal';if(mediaID(key))return saved.media[mediaID(key)]?.title||'File';return report(key?.slice(7)).session?.task||'Result'}
  function surfaceIcon(key){return termID(key)?'sessions':mediaID(key)?saved.media[mediaID(key)]?.kind==='web'?'out':'note':'checks'}
  function status(id){const t=terminals.get(id),s=sess(id);return pendingStarts.has(id)?'Opening terminal':t?.running===false?(t.exit===0?'Exited':t.restored?'Not running':'Stopped'):s?.state||'Shell running'}
  function notify(kind,id,title,body,token,capture){
    if(saved.seen[token])return;
    saved.seen[token]=Date.now();
    saved.activity.unshift({kind,id,capture,title,body,time:Date.now(),read:false});saved.activity=saved.activity.slice(0,60);
    const keys=Object.keys(saved.seen);if(keys.length>500)keys.slice(0,keys.length-500).forEach(k=>delete saved.seen[k]);
    persist();
    // An event remains in Activity even with OS alerts disabled. Never notify for
    // terminal text, title escape sequences, or restored historical state.
    if(state.alerts && live && (sess(id)?.host==='tasktap'||!sess(id)) && !document.hasFocus())postLive('notify',{kind:kind==='failure'?'failure':'complete',id:kind==='complete'&&capture?capture:id,title,body});
  }
  function schedule(){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{persist();render()},70)}
  function ensureProject(row){let p=projectFor(row.cwd);if(!p){p={id:row.cwd,folder:row.cwd,name:row.cwd.split('/').pop(),available:true,aliases:[]};state.projects.push(p)}return p}
  async function receive(events){
    const writes=[];
    for(const e of events){
      if(e.event==='sessions'){
        connected=true;for(const row of e.sessions||[]){terminals.set(row.id,row);ensureProject(row);completeLaunch(row)}
        for(const engine of engines.values()){engine.attached=false;send('attach',{id:engine.id})}
        schedule();
      }else if(e.event==='session' && e.session){
        const row=e.session,old=terminals.get(row.id);terminals.set(row.id,row);const p=ensureProject(row);
        if(old&&!old.running&&row.running&&engines.has(row.id)){engines.get(row.id).attached=false;send('attach',{id:row.id})}
        if(old?.running&&!row.running){const s=sess(row.id);if(s){s.available=false;if(!s.result)s.state=row.exit===0||row.stopped?'Closed':'Failed'}
          if(row.kind==='shell'&&row.exit!==0&&!row.stopped)notify('failure',row.id,label('terminal:'+row.id),'The process ended. Open its terminal to see what happened.','exit:'+row.id+':'+row.created);
        }
        if(!completeLaunch(row) && !old && row.running){open('terminal:'+row.id,p.id,false);}
        schedule();
      }else if(e.event==='replay'){
        const engine=engines.get(e.id);if(!engine)continue;
        engine.attached=true;engine.replaying=true;engine.seq=e.seq;engine.term.reset();engine.term.resize(e.cols,e.rows);engine.sentSize=e.cols+'x'+e.rows;
        if(e.truncated)engine.term.write('\r\n[Earlier scrollback is no longer available.]\r\n');
        writes.push(new Promise(done=>engine.term.write(bytes(e.data),()=>{fit(engine);if(engines.get(e.id)===engine){engine.replaying=false;for(const data of engine.pendingInput)send('input',{id:engine.id,data});engine.pendingInput=[];engine.pendingBytes=0}done()})));
      }else if(e.event==='output'){
        const engine=engines.get(e.id);if(!engine||!engine.attached||e.seq<=engine.seq)continue;
        engine.seq=e.seq;writes.push(new Promise(done=>engine.term.write(bytes(e.data),done)));
      }else if(e.event==='focus'){
        const p=projectFor(terminals.get(e.id)?.cwd);if(p)open('terminal:'+e.id,p.id,true);
      }else if(e.event==='disconnected'){
        connected=false;for(const en of engines.values()){en.attached=false;en.pendingInput=[];en.pendingBytes=0;}
        toast(e.error);schedule();
      }else if(e.event==='error'){const pending=pendingStarts.get(e.id);pendingStarts.delete(e.id);if(pending&&!pending.closed)close('terminal:'+e.id,pending.project);const en=engines.get(e.id);if(en){en.pendingInput=[];en.pendingBytes=0}toast(e.error||'The terminal operation could not be completed.');schedule()}
    }
    await Promise.all(writes);
  }
  function fit(en){
    if(!en?.element.isConnected||!en.element.getClientRects().length)return;
    try{
      en.fit.fit();const size=en.term.cols+'x'+en.term.rows;
      if(en.attached&&size!==en.sentSize){send('resize',{id:en.id,cols:en.term.cols,rows:en.term.rows});en.sentSize=size}
    }catch{}
  }
  function input(en,data){
    if(!live)return;
    if(!connected){toast('Terminal connection lost. Reconnect before typing.');return}
    if(data.length>87000||en.pendingBytes+data.length>87000){toast('This input is too large. Paste a smaller section.');return}
    if(en.attached&&!en.replaying)send('input',{id:en.id,data});else{en.pendingInput.push(data);en.pendingBytes+=data.length}
  }
  function engine(id){
    if(engines.has(id))return engines.get(id);
    const element=document.createElement('div');element.className='deck-terminal';element.setAttribute('aria-label',label('terminal:'+id)+' terminal');
    // FitAddon measures its immediate parent's CSS size. Give it the actual
    // content box; the outer border-box includes inherited Ghostty padding.
    const viewport=document.createElement('div');viewport.className='deck-terminal-viewport';element.append(viewport);
    const a=appearance();
    const term=new Terminal({fontFamily:a.fontFamilies.map(f=>JSON.stringify(f)).join(',')+', monospace',fontSize:saved.preferences.font||a.fontSize,scrollback:10000,convertEol:false,allowTransparency:true,allowProposedApi:false,screenReaderMode:true,cursorStyle:a.cursorStyle,cursorBlink:a.cursorBlink,theme:{...a.theme,background:a.theme.background+'00'}});
    const fitAddon=new FitAddon.FitAddon(),search=new SearchAddon.SearchAddon();term.loadAddon(fitAddon);term.loadAddon(search);
    const en={id,element,viewport,term,fit:fitAddon,search,seq:0,attached:false,pendingInput:[],pendingBytes:0};engines.set(id,en);
    stash.append(element);term.open(viewport);
    term.onData(data=>input(en,encoded(data)));
    term.onBinary(data=>input(en,btoa(data)));
    term.attachCustomKeyEventHandler(e=>{
      if(e.metaKey&&['w','k','f','d'].includes(e.key.toLowerCase()))return false;
      if(e.metaKey&&e.key.toLowerCase()==='c'&&term.hasSelection()){navigator.clipboard?.writeText(term.getSelection());return false}
      return true;
    });
    const resize=new ResizeObserver(()=>{cancelAnimationFrame(en.fitFrame);en.fitFrame=requestAnimationFrame(()=>fit(en))});resize.observe(viewport);en.resize=resize;
    if(live)send('attach',{id});else term.write('Tasktap terminal\r\n\r\nRun the Mac app to open a real shell or coding agent.\r\nThis browser preview does not execute commands.\r\n');
    return en;
  }
  function preview(key){
    if(previews.has(key)){const cached=previews.get(key);if(key.startsWith('result:')){const text=cached.querySelector('.deck-document');if(text&&text.dataset.report!==report(key.slice(7)).text){const value=report(key.slice(7)).text;resultPresentation.render(text,value);text.dataset.report=value}}return cached;}
    const root=document.createElement('div');root.className='deck-preview';
    const file=saved.media[mediaID(key)];
    if(key.startsWith('result:')){
      const result=report(key.slice(7));root.classList.add('deck-report');const title=document.createElement('h2');title.textContent=result.session?sessionDisplayName(result.session):'Agent report';
      const text=document.createElement('div');text.className='deck-document';resultPresentation.render(text,result.text);text.dataset.report=result.text;
      root.append(title,text);
    }else if(file){
      const source=file.url;
      if(['image','video','audio'].includes(file.kind)){
        const media=document.createElement(file.kind==='image'?'img':file.kind);media.src=source;
        if(file.kind==='image')media.alt=file.title;else{media.controls=true;media.preload='metadata'}
        media.addEventListener('error',()=>{root.replaceChildren(message('This file is unavailable or its format is not supported. Find the original in Finder.'))});root.append(media);
      }else if(file.kind==='pdf'){
        const controls=document.createElement('div');controls.className='deck-pdf-controls';controls.innerHTML=button('Previous','deck-pdf-prev',file.id,'btn')+'<span class="deck-pdf-label">Loading PDF…</span>'+button('Next','deck-pdf-next',file.id,'btn');root.append(controls);root.dataset.page='0';if(live)postLive('workspace-pdf-page',{id:file.id,page:0});else root.append(message('PDF previews are available in the Mac app.'));
      }else if(file.kind==='web'){
        const frame=document.createElement('iframe');frame.title=file.title;
        frame.setAttribute('sandbox','allow-scripts allow-forms');frame.referrerPolicy='no-referrer';frame.src=source;root.append(frame);
      }else{
        const text=document.createElement('pre');text.className='deck-document';text.textContent='Loading…';root.append(text);
        if(live)postLive('workspace-read-text',{id:file.id});else text.textContent='Open this file in the Mac app to preview its contents.';
      }
    }else root.append(message('This preview is no longer available.'));
    previews.set(key,root);if(file?.sourceView&&file.kind==='web'&&file.path){paintDocument(root,file);if(live)postLive('workspace-read-text',{id:file.id})}return root;
  }
  function message(text){const p=document.createElement('p');p.className='empty';p.textContent=text;return p}
  function rememberWorkspace(project){
    saved.openProjects??=Object.entries(saved.layouts).filter(([,l])=>l.groups?.some(g=>g.tabs?.length)).map(([id])=>id);
    if(!saved.openProjects.includes(project)){saved.openProjects.push(project);persist()}
  }
  function openWorkspace(project,createTerminal=false){
    const p=proj(project);if(!p)return;
    rememberWorkspace(project);
    for(const item of saved.activity)if(sess(item.id)?.project===project||terminals.get(item.id)?.cwd===p.folder)item.read=true;
    if(typeof showWorkspace==='function')showWorkspace();go(project);
    const l=layout(project);
    if(createTerminal&&!l.groups.some(g=>g.tabs.length)&&![...pendingStarts.values()].some(v=>v.project===project&&!v.closed))startTerminal(project);
    else focusSurface(project,l.groups[l.selected]?.active);
    persist();
  }
  function closeWorkspace(project){
    const index=saved.openProjects?.indexOf(project)??-1;
    saved.openProjects=(saved.openProjects||[]).filter(id=>id!==project);
    for(const pending of pendingStarts.values())if(pending.project===project)pending.closed=true;
    for(const g of saved.layouts[project]?.groups||[])g.tabs.forEach(disposeView);
    const node=projects.get(project);node?.layoutObserver?.disconnect();node?.remove();projects.delete(project);
    if(view===project)go(saved.openProjects[Math.min(Math.max(0,index),saved.openProjects.length-1)]||'overview');else renderNav(listedProjects(activeSessions()));
    persist();toast('Workspace closed. Its layout is saved; terminal sessions keep running.');
  }
  function open(key,project,activate=true,groupID=null){if(window.tasktapSurface==='notch'){postLive('workspace-open',{key,project,activate});return}
    const l=layout(project);let group=l.groups.find(g=>g.tabs.includes(key));
    if(!group){group=groupID?l.groups.find(g=>g.id===groupID):selectedGroup(l);if(!group)return;group.tabs.push(key)}group.active=key;l.selected=l.groups.indexOf(group);
    if(activate){if(typeof showWorkspace==='function')showWorkspace();go(project);requestAnimationFrame(()=>{const en=engines.get(termID(key));if(en)en.term.focus();else projects.get(project)?.querySelector('.deck-tab[aria-selected="true"][data-id="'+CSS.escape(key)+'"]')?.focus()})}else if(view===project)renderProject(proj(project));persist();
  }
  function leave(){activeProject=null;stage.hidden=true;$('#main').hidden=false;document.body.classList.remove('workspace-active','deck-focus');if(typeof workspaceNavigation!=='undefined')workspaceNavigation.sync()}
  // Panes remain flat, stable DOM siblings. A split tree supplies their bounds;
  // changing a split never reparents an iframe or recreates a terminal engine.
  function treeShape(node){return node?(node.group||[node.id,node.axis,treeShape(node.first),treeShape(node.second)]):null}
  function branch(node,id){if(node.group)return null;return node.id===id?node:branch(node.first,id)||branch(node.second,id)}
  function focusSurface(project,key){
    requestAnimationFrame(()=>{if(view!==project)return;const en=engines.get(termID(key));if(en&&en.element.getClientRects().length)en.term.focus();else projects.get(project)?.querySelector('.deck-tab[aria-selected="true"][data-id="'+CSS.escape(key||'')+'"]')?.focus()});
  }
  function completeLaunch(row){
    const pending=pendingStarts.get(row.id);if(!pending)return false;
    pendingStarts.delete(row.id);
    const l=layout(pending.project),g=l.groups.find(g=>g.id===pending.group);
    if(g&&!pending.closed){const key='terminal:'+row.id;if(!g.tabs.includes(key)){g.tabs.push(key);g.active=key}
      if(view===pending.project){renderProject(proj(pending.project));if(l.groups[l.selected]===g&&g.active===key)focusSurface(pending.project,key)}
    }
    return true;
  }
  function startTerminal(project,groupID){
    const p=proj(project);if(!p)return;const l=layout(project),g=groupID?l.groups.find(g=>g.id===groupID):selectedGroup(l);if(!g)return;
    const id=uid();pendingStarts.set(id,{project,group:g.id});
    g.tabs.push('terminal:'+id);g.active='terminal:'+id;l.selected=l.groups.indexOf(g);
    if(live)send('start',{id,cwd:p.folder,shell:saved.preferences.shell});
    else{const row={id,cwd:p.folder,title:'Terminal preview',running:true,kind:'shell'};terminals.set(id,row);completeLaunch(row)}
    if(view===project)renderProject(p);persist();
  }
  function split(project,axis,groupID){
    const l=layout(project);if(!l.groups.length)return;
    const g=workspaceLayout.split(l,groupID||l.groups[l.selected].id,axis,uid());
    if(!g)return;l.focus=false;renderProject(proj(project));projects.get(project)?.querySelector('.deck-group[data-group-id="'+CSS.escape(g.id)+'"]')?.focus({preventScroll:true});startTerminal(project,g.id);
  }
  function arrange(root,l){
    const area=$('.deck-groups',root),width=area.clientWidth,height=area.clientHeight;
    const panes=new Map([...area.querySelectorAll('.deck-group')].map(p=>[p.dataset.groupId,p]));
    const dividers=new Map([...area.querySelectorAll('.deck-divider')].map(d=>[d.dataset.branch,d]));
    const used=new Set(),selected=l.groups[l.selected]?.id;
    const place=(node,x,y,w,h)=>{Object.assign(node.style,{left:x+'px',top:y+'px',width:Math.max(0,w)+'px',height:Math.max(0,h)+'px'})};
    for(const [id,pane] of panes){pane.hidden=!!l.focus&&id!==selected;if(l.focus&&id===selected){place(pane,0,0,width,height);pane.classList.toggle('is-narrow',width<260)}}
    function walk(node,x,y,w,h){
      if(node.group){const pane=panes.get(node.group);if(pane){place(pane,x,y,w,h);pane.classList.toggle('is-narrow',w<260)}return}
      const horizontal=node.axis==='x',extent=horizontal?w:h,gap=Math.min(6,extent),available=Math.max(0,extent-gap),first=available*node.ratio/100;
      let divider=dividers.get(node.id);used.add(node.id);
      if(!divider){
        divider=document.createElement('div');divider.className='deck-divider';divider.dataset.branch=node.id;divider.tabIndex=0;divider.setAttribute('role','separator');
        divider.setAttribute('aria-valuemin','10');divider.setAttribute('aria-valuemax','90');
        const balance=value=>{const current=branch(l.tree,divider.dataset.branch);if(!current)return;current.ratio=Math.round(Math.max(10,Math.min(90,value)));arrange(root,l);persist()};
        const drag=e=>{if(!divider.hasPointerCapture(e.pointerId))return;const r=area.getBoundingClientRect(),b=divider.splitBounds;balance(((b.axis==='x'?e.clientX-r.left-b.x:e.clientY-r.top-b.y)-b.gap/2)/Math.max(1,b.available)*100)};
        divider.onpointerdown=e=>{e.preventDefault();divider.focus();divider.setPointerCapture(e.pointerId);drag(e)};divider.onpointermove=drag;
        divider.onpointerup=e=>{if(divider.hasPointerCapture(e.pointerId))divider.releasePointerCapture(e.pointerId)};
        divider.ondblclick=()=>balance(50);
        divider.onkeydown=e=>{const axis=divider.splitBounds.axis,back=axis==='x'?'ArrowLeft':'ArrowUp',forward=axis==='x'?'ArrowRight':'ArrowDown';if(![back,forward,'Home','End'].includes(e.key))return;e.preventDefault();const current=branch(l.tree,divider.dataset.branch);balance(e.key==='Home'?10:e.key==='End'?90:current.ratio+(e.key===back?-2:2))};
        area.append(divider);
      }
      divider.hidden=false;divider.dataset.axis=node.axis;divider.splitBounds={axis:node.axis,x,y,gap,available};
      divider.setAttribute('aria-orientation',horizontal?'vertical':'horizontal');divider.setAttribute('aria-label',horizontal?'Pane width balance':'Pane height balance');divider.setAttribute('aria-valuenow',node.ratio);
      if(horizontal){place(divider,x+first,y,gap,h);walk(node.first,x,y,first,h);walk(node.second,x+first+gap,y,available-first,h)}
      else{place(divider,x,y+first,w,gap);walk(node.first,x,y,w,first);walk(node.second,x,y+first+gap,w,available-first)}
    }
    if(!l.focus&&l.tree)walk(l.tree,0,0,width,height);
    for(const [id,divider] of dividers){if(l.focus)divider.hidden=true;else if(!used.has(id))divider.remove()}
    const visible=new Set(l.groups.filter(g=>!l.focus||g.id===selected).map(g=>previews.get(g.active)).filter(Boolean));
    for(const node of area.querySelectorAll('.deck-floating'))node.hidden=!visible.has(node);
    const origin=area.getBoundingClientRect();
    for(const g of l.groups){if(termID(g.active)||!g.active||l.focus&&g.id!==selected)continue;
      const node=previews.get(g.active),pane=panes.get(g.id);if(!node||!pane)continue;
      const rect=pane.querySelector('.deck-surface').getBoundingClientRect();
      place(node,rect.left-origin.left,rect.top-origin.top,rect.width,rect.height);node.hidden=false;node.dataset.groupId=g.id;
    }
  }
  function renderProject(p){
    rememberWorkspace(p.id);activeProject=p.id;stage.hidden=false;$('#main').hidden=true;document.body.classList.add('workspace-active');document.body.classList.toggle('deck-sidebar-hidden',!!saved.sidebarHidden);const l=layout(p.id);
    for(const [id,node] of projects)node.hidden=id!==p.id;
    let root=projects.get(p.id);if(!root){root=document.createElement('div');root.className='deck-project';stage.append(root);projects.set(p.id,root)}root.hidden=false;
    document.body.classList.toggle('deck-focus',!!l.focus);
    const signature=JSON.stringify([l.groups,treeShape(l.tree),l.focus,l.focus?l.selected:null,[...pendingStarts].filter(([,v])=>v.project===p.id)]);
    if(root.dataset.signature!==signature){
      const focused=document.activeElement?.closest('.deck-terminal'),focusID=focused?[...engines].find(([,en])=>en.element===focused)?.[0]:null;
      root.dataset.signature=signature;
      if(!root.querySelector('.deck-tools')){
        root.innerHTML='<header class="deck-tools"><div class="deck-project-name">'+smallButton('Toggle sidebar','deck-sidebar','','side')+icon('folder')+'<strong title="'+attr(p.folder)+'">'+esc(p.name)+'</strong></div><div class="deck-tools-actions">'+button('New task','start-session',p.id,'deck-new')+menu('Open a view',button('Open file…','deck-file',p.id,'deck-menu-item','note')+button('Project files','deck-files',p.id,'deck-menu-item','folder'),'plus')+smallButton('Focus surface','deck-focus',p.id,'grid')+menu('Workspace actions',button('Project notes','deck-notes',p.id,'deck-menu-item','note')+button('Session history','deck-history',p.id,'deck-menu-item','sessions')+button('Terminal preferences','deck-preferences','','deck-menu-item','settings')+button('Close workspace','deck-close-workspace',p.id,'deck-menu-item','x'))+'</div></header><div class="deck-reconnect" hidden>Terminal connection lost. Your processes may still be running. '+button('Reconnect','deck-reconnect')+'</div><div class="deck-groups"></div>';
        const resize=new ResizeObserver(()=>arrange(root,layout(p.id)));resize.observe($('.deck-groups',root));root.layoutObserver=resize;
      }
      const groups=$('.deck-groups',root);
      let emptyWorkspace=groups.querySelector('.deck-workspace-empty');
      if(!emptyWorkspace){emptyWorkspace=document.createElement('div');emptyWorkspace.className='deck-empty deck-workspace-empty';groups.append(emptyWorkspace)}
      emptyWorkspace.hidden=!!l.groups.length;
      if(!l.groups.length)emptyWorkspace.innerHTML='<h2>No open panes</h2><div class="inline">'+button('New terminal','deck-terminal',p.id,'btn','terminal')+button('Open file','deck-file',p.id,'btn','note')+button('New browser','deck-url',p.id,'btn','globe')+'</div>';

      const focus=root.querySelector('[data-action="deck-focus"]');focus.title=l.focus?'Exit focus':'Focus surface';focus.disabled=!l.groups.length;focus.setAttribute('aria-label',focus.title);focus.setAttribute('aria-pressed',String(!!l.focus));
      for(const old of groups.querySelectorAll('.deck-group'))if(!l.groups.some(g=>g.id===old.dataset.groupId)){
        for(const child of old.querySelector('.deck-surface').children)stash.append(child);old.remove();
      }
      l.groups.forEach((g,index)=>{
        let pane=Array.from(groups.querySelectorAll('.deck-group')).find(n=>n.dataset.groupId===g.id);
        if(!pane){
          pane=document.createElement('section');pane.className='deck-group';pane.dataset.groupId=g.id;
          pane.innerHTML='<div class="deck-pane-bar"><div class="deck-tabs" role="tablist"></div><div class="deck-pane-tools"></div></div><div class="deck-surface"></div><div class="deck-question"></div>';
          const select=()=>{const selected=Number(pane.dataset.group);if(l.selected!==selected){l.selected=selected;root.querySelectorAll('.deck-group').forEach(n=>n.classList.toggle('selected',Number(n.dataset.group)===selected));update(p,root);persist()}};
          pane.addEventListener('pointerdown',select,{capture:true});pane.addEventListener('focusin',select);
          groups.append(pane);
        }
        pane.tabIndex=-1;pane.dataset.group=index;pane.id='deck-pane-'+g.id;pane.setAttribute('aria-label','Surface '+(index+1));pane.classList.toggle('selected',l.selected===index);
        const tabs=$('.deck-tabs',pane);tabs.setAttribute('aria-label','Surface '+(index+1));tabs.innerHTML=g.tabs.map(key=>'<div class="deck-tab-wrap '+(g.active===key?'active':'')+'"><button role="tab" aria-description="Right-click or press Shift+F10 for tab actions" tabindex="'+(g.active===key?'0':'-1')+'" id="deck-tab-'+g.id+'-'+key.replace(/[^a-zA-Z0-9-]/g,'')+'" aria-controls="deck-surface-'+g.id+'" aria-selected="'+(g.active===key)+'" class="deck-tab" data-action="deck-tab" data-id="'+attr(key)+'" data-group="'+index+'">'+icon(surfaceIcon(key))+'<span>'+esc(label(key))+'</span></button><button class="deck-tab-close" aria-label="Close '+attr(label(key))+' view" data-action="deck-close" data-id="'+attr(key)+'">'+icon('x')+'</button></div>').join('');
        const surface=$('.deck-surface',pane);surface.id='deck-surface-'+g.id;surface.setAttribute('role','tabpanel');if(g.active){surface.removeAttribute('aria-label');surface.setAttribute('aria-labelledby','deck-tab-'+g.id+'-'+g.active.replace(/[^a-zA-Z0-9-]/g,''))}else{surface.removeAttribute('aria-labelledby');surface.setAttribute('aria-label','Empty pane')}
        for(const child of surface.children){child.hidden=true;child.querySelectorAll('audio,video').forEach(media=>media.pause())}
        if(g.active&&!pendingStarts.has(termID(g.active))){
          const id=termID(g.active),node=id?engine(id).element:preview(g.active);
          if(id){if(node.parentElement!==surface)surface.append(node);node.hidden=false;requestAnimationFrame(()=>fit(engines.get(id)))}
          else{
            if(node.parentElement!==groups){node.classList.add('deck-floating');groups.append(node);
              const select=()=>{const group=layout(p.id).groups.findIndex(g=>g.id===node.dataset.groupId);if(group>=0&&l.selected!==group){l.selected=group;renderProject(p);persist()}};
              node.addEventListener('pointerdown',select,{capture:true});node.addEventListener('focusin',select);
            }
            node.dataset.groupId=g.id;
          }
        }
        else{let empty=surface.querySelector('.deck-empty');if(!empty){empty=document.createElement('div');empty.className='deck-empty';surface.append(empty)}
          const pending=[...pendingStarts.values()].some(v=>v.project===p.id&&v.group===g.id&&!v.closed);
          empty.innerHTML=pending?'<p role="status">Opening terminal…</p>':icon('sessions')+'<h2>Ready when you are.</h2><p>Open a terminal or bring a file into this surface.</p><div class="inline">'+button('New terminal','deck-terminal',p.id,'btn','terminal')+button('Open file','deck-file',p.id,'btn','note')+'</div>';empty.hidden=false;
        }
      });
      if(focusID&&engines.has(focusID)&&l.groups[l.selected]?.active==='terminal:'+focusID)focusSurface(p.id,'terminal:'+focusID);
    }
    update(p,root);
  }
  function update(p,root){
    const l=layout(p.id);$('.deck-reconnect',root).hidden=!live||connected;root.querySelectorAll('.deck-tab').forEach(tab=>{const span=tab.querySelector('span');if(span)span.textContent=label(tab.dataset.id)});
    l.groups.forEach((g,index)=>{
      const pane=root.querySelector('[data-group="'+index+'"].deck-group');if(!pane)return;pane.classList.toggle('selected',l.selected===index);
      const id=termID(g.active),s=sess(id),file=saved.media[mediaID(g.active)];
      const controls=$('.deck-pane-tools',pane),controlKey=JSON.stringify([g.active,!!s,l.groups.map(g=>g.id),!!file?.sourceView]);
      if(controls.dataset.signature!==controlKey){
        controls.dataset.signature=controlKey;
        const documentMode=file&&(workspaceDocuments.kind(file)==='markdown'||file.kind==='web'&&file.path);
        const actions=(documentMode?button(file.sourceView?'Preview':'Source','deck-source',file.id,'deck-menu-item'):'')+(s?button('Follow up','follow',id,'deck-menu-item'):file?button('Ask agent','deck-ask',file.id,'deck-menu-item'):'')+(id?button('Find in terminal','deck-find',id,'deck-menu-item')+button('Session details','deck-details',id,'deck-menu-item'):file?.path?button('Show in Finder','deck-reveal',file.id,'deck-menu-item'):file?.url?button('Open in browser','deck-browser',file.id,'deck-menu-item'):'')+(file?button('Refresh preview','deck-refresh',g.active,'deck-menu-item'):'')+(file?.kind==='image'?button('Zoom image','deck-zoom',g.active,'deck-menu-item'):'')+(g.active&&l.groups.length>1?button('Move tab to…','deck-move',g.active,'deck-menu-item'):'');
        controls.innerHTML=smallButton('New terminal','deck-terminal',p.id,'terminal')+smallButton('New browser','deck-url',p.id,'globe')+smallButton('Split right / ⌘D','deck-split-right',p.id,'splitRight')+smallButton('Split down / ⇧⌘D','deck-split-down',p.id,'splitDown')+menu('Tab actions','<div class="deck-menu-heading"></div>'+actions);
        controls.querySelector('.deck-menu').classList.add('deck-tab-menu');
      }
      const heading=$('.deck-menu-heading',controls);if(heading)heading.textContent=id?[providers[s?.agent]||'Shell',status(id)].join(' / '):file?.path||file?.url||(g.active?'Reported outcome':'Surface '+(index+1));
      const tab=pane.querySelector('.deck-tab[aria-selected="true"]');if(tab)tab.title=label(g.active)+(id?' / '+status(id):'');
      const q=state.decisions.find(q=>q.session===id);
      $('.deck-question',pane).innerHTML=q?'<div><strong>'+esc(q.q)+'</strong><span class="hint">'+esc(providers[s?.agent]||'Agent')+' needs your decision</span></div>'+button('Review decision','notch',q.id,'primary'):'';
      $('.deck-question',pane).hidden=!q;
    });
    arrange(root,l);renderNav(listedProjects(activeSessions()));
  }
  function disposeView(key){
    const id=termID(key);if(id){const en=engines.get(id);if(en){cancelAnimationFrame(en.fitFrame);en.resize.disconnect();en.term.dispose();en.element.remove();engines.delete(id);send('detach',{id})}}
    else{previews.get(key)?.remove();previews.delete(key)}
  }
  function close(key,project=activeProject){
    const l=layout(project),wasActive=l.groups[l.selected]?.active===key;
    const pending=pendingStarts.get(termID(key));if(pending)pending.closed=true;
    for(const g of [...l.groups]){
      if(!g.tabs.includes(key))continue;
      const index=g.tabs.indexOf(key);g.tabs.splice(index,1);
      if(g.active===key)g.active=g.tabs[Math.min(index,g.tabs.length-1)]||null;
      if(!g.tabs.length)workspaceLayout.remove(l,g.id);
    }
    disposeView(key);
    if(view===project){renderProject(proj(project));if(wasActive){if(l.groups.length)focusSurface(project,l.groups[l.selected]?.active);else projects.get(project)?.querySelector('.deck-workspace-empty button')?.focus()}}
    persist();
  }
  function addFiles(project,files){const p=projectFor(project)||proj(project);if(!p)return;for(const file of files){file.project=p.id;saved.media[file.id]=file;open('media:'+file.id,p.id,false)}go(p.id);persist()}
  function activity(){saved.activity.forEach(a=>a.read=true);persist();dialog('Activity','Across your projects',saved.activity.length?'<div class="deck-activity-list">'+saved.activity.map(a=>'<section class="notice"><span class="eyebrow">'+esc(a.kind==='failure'?'Needs attention':'Result ready')+' / '+esc(new Date(a.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))+'</span><strong>'+esc(a.title)+'</strong><p>'+esc(resultPresentation.excerpt(a.body,48).text)+'</p>'+(a.kind==='failure'?button('Open session','deck-open',a.id,'text-btn','arrow'):button('View result','deck-result',a.capture||a.id,'text-btn','arrow'))+'</section>').join('')+'</div>':'<p class="empty">You’re all caught up. Decisions appear in Home; results and failures collect here.</p>');renderNav(listedProjects(activeSessions()))}
  function details(id){const t=terminals.get(id),s=sess(id);if(!t){showSession(id);return}dialog(s?sessionDisplayName(s):t.title,'Session details','<p class="hint">'+esc(t.cwd)+'</p><p>'+esc(status(id))+'</p><div class="inline">'+(s?button('Conversation details','deck-conversation',id,'btn'): '')+(t.running?button('Stop session…','deck-stop',id,'btn','stop'):'')+'</div><p class="hint">Close a view to make room. Stop a session only when you want its process to end.</p>')}
  function preferences(){
    dialog('Terminal preferences','Workspace','<form id="deck-preferences" class="stack"><label class="check-line"><input type="checkbox" id="deck-follow" '+(saved.preferences.followGhostty!==false?'checked':'')+'>Use Ghostty font and cursor</label><p class="hint" id="deck-appearance-source">'+esc(appearanceDescription())+'</p>'+button('Reload Ghostty settings','deck-reload','','text-btn')+'<label class="field">Shell<select id="deck-shell">'+[['default','Login shell'],['zsh','zsh'],['bash','bash'],['fish','fish']].map(([id,name])=>option(id,name,saved.preferences.shell)).join('')+'</select></label><label class="field">Text size<select id="deck-font">'+option('auto','From appearance',saved.preferences.font?String(saved.preferences.font):'auto')+[12,13,14,16,18,20].map(n=>option(String(n),String(n)+' pt',String(saved.preferences.font))).join('')+'</select></label><p class="hint">Colors, translucency, and blur follow the app Appearance preferences. Your shell loads its usual prompt and plugins. Ghostty can supply installed fonts, cursor, and padding; its keybindings and shaders are not imported.</p><button class="primary" type="submit">Save preferences</button></form>');
    $('#deck-preferences').onsubmit=e=>{e.preventDefault();saved.preferences.shell=$('#deck-shell').value;const size=$('#deck-font').value;if(size==='auto')delete saved.preferences.font;else saved.preferences.font=Number(size);saved.preferences.followGhostty=$('#deck-follow').checked;applyAppearance();persist();dismissCard()};
  }
  document.addEventListener('click',e=>{for(const entry of stage.querySelectorAll('.deck-menu[open]'))if(!entry.contains(e.target)||e.target.closest('button'))entry.open=false});
  function tabMenu(event,tab){
    if(!tab)return;event.preventDefault();
    const groupID=tab.closest('.deck-group').dataset.groupId,key=tab.dataset.id,l=layout(activeProject),g=l.groups.find(g=>g.id===groupID);
    l.selected=l.groups.indexOf(g);g.active=key;renderProject(proj(activeProject));persist();
    const pane=projects.get(activeProject).querySelector('.deck-group[data-group-id="'+CSS.escape(groupID)+'"]'),entry=pane.querySelector('.deck-tab-menu'),anchor=pane.querySelector('.deck-tab[aria-selected="true"]');
    const rect=anchor.getBoundingClientRect();
    entry.contextAnchor=event.type==='contextmenu'&&event.button===2?{right:event.clientX,bottom:event.clientY}:rect;
    entry.returnFocus=anchor;entry.open=true;entry.querySelector('button')?.focus({preventScroll:true});
  }
  stage.addEventListener('contextmenu',e=>tabMenu(e,e.target.closest('.deck-tab')));
  stage.addEventListener('keydown',e=>{if(e.key==='ContextMenu'||e.shiftKey&&e.key==='F10')tabMenu(e,e.target.closest('.deck-tab'))});
  // Anchor menus to the viewport so the lower panes can open them upward.
  stage.addEventListener('toggle',e=>{
    const entry=e.target;if(!entry.matches('.deck-menu[open]'))return;
    for(const other of stage.querySelectorAll('.deck-menu[open]'))if(other!==entry)other.open=false;
    const list=entry.querySelector('.deck-menu-list'),anchor=entry.contextAnchor||entry.querySelector('summary').getBoundingClientRect();
    list.style.setProperty('--menu-height',Math.max(90,innerHeight-16)+'px');
    const width=list.getBoundingClientRect().width,height=Math.min(list.scrollHeight,innerHeight-16);
    list.style.setProperty('--menu-left',Math.max(8,Math.min(anchor.right-width,innerWidth-width-8))+'px');
    list.style.setProperty('--menu-top',Math.max(8,Math.min(anchor.bottom+4,innerHeight-height-8))+'px');
  },true);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){const opened=stage.querySelector('.deck-menu[open]');if(opened){e.preventDefault();opened.open=false;(opened.returnFocus||opened.querySelector('summary')).focus()}}});
  document.addEventListener('click',e=>{
    const b=e.target.closest('[data-action]');if(!b?.dataset.action.startsWith('deck-'))return;const a=b.dataset.action,id=b.dataset.id;
    if(a==='deck-reload'){if(live)postLive('workspace-appearance');else toast('Ghostty settings are read by the Mac app.')}
    else if(a==='deck-open'){dismissCard();const t=terminals.get(id),s=sess(id);if(t)open('terminal:'+id,ensureProject(t).id);else if(s?.host==='tasktap')open('terminal:'+id,s.project);else showSession(id)}
    else if(a==='deck-terminal')startTerminal(id,b.closest('.deck-group')?.dataset.groupId);
    else if(a==='deck-tab'){const l=layout(activeProject);l.selected=Number(b.dataset.group);l.groups[l.selected].active=id;renderProject(proj(activeProject));persist();const en=engines.get(termID(id));en?.term.focus()}
    else if(a==='deck-close')close(id);
    else if(a==='deck-split-right'||a==='deck-split-down')split(id,a==='deck-split-right'?'x':'y',b.closest('.deck-group')?.dataset.groupId);
    else if(a==='deck-close-workspace')closeWorkspace(id);
    else if(a==='deck-move'){
      const l=layout(activeProject),from=l.groups.find(g=>g.tabs.includes(id));
      dialog('Move tab','Choose a surface','<div class="stack">'+l.groups.map((g,i)=>g===from?'':button('Surface '+(i+1)+' / '+(g.active?label(g.active):'Empty surface'),'deck-move-to',g.id,'note','side')).join('')+'</div>');
      $('#modal').dataset.moveSurface=id;
    }
    else if(a==='deck-move-to'){
      const key=$('#modal').dataset.moveSurface,l=layout(activeProject),from=l.groups.find(g=>g.tabs.includes(key)),to=l.groups.find(g=>g.id===id);
      if(from&&to&&from!==to){from.tabs=from.tabs.filter(k=>k!==key);from.active=from.tabs.at(-1)||null;to.tabs.push(key);to.active=key;l.selected=l.groups.indexOf(to);if(!from.tabs.length)workspaceLayout.remove(l,from.id);dismissCard();renderProject(proj(activeProject));focusSurface(activeProject,key);persist()}
    }
    else if(a==='deck-sidebar'){if(typeof workspaceNavigation!=='undefined')workspaceNavigation.toggle()}
    else if(a==='deck-focus'){const l=layout(id);l.focus=!l.focus;renderProject(proj(id));persist()}
    else if(a==='deck-file'){if(live)postLive('workspace-file',{project:proj(id)?.folder});else toast('Open files from the installed Mac app.')}
    else if(a==='deck-url'){const groupID=b.closest('.deck-group')?.dataset.groupId;dialog('Open a web preview',proj(id)?.name,'<form id="deck-url-form" class="stack"><label class="field">Address<input id="deck-url-input" type="url" required placeholder="http://localhost:3000" value="http://localhost:3000"></label><p class="hint">Open your development server or a website beside the work. Some sites require your regular browser.</p><button class="primary" type="submit">Open preview</button></form>');$('#deck-url-form').onsubmit=e=>{e.preventDefault();try{const url=new URL($('#deck-url-input').value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error();const key=uid();saved.media[key]={id:key,project:id,kind:'web',title:url.host,url:url.href};dismissCard();open('media:'+key,id,true,groupID)}catch{toast('Enter an http or https address without credentials.')}}}
    else if(a==='deck-ask'){const file=saved.media[id];if(file){captureDraft('',file.project);captureContext.attach(draft,{kind:file.path?'file':'website',value:file.path||file.url,app:'Tasktap workspace'});editDraft();$('#transcript')?.focus()}}
    else if(a==='deck-files'){const files=Object.values(saved.media).filter(f=>f.project===id);dialog('Project files',proj(id)?.name,files.length?'<div class="stack">'+files.map(f=>button(f.title,'deck-file-open',f.id,'note',f.kind==='web'?'out':'note')).join('')+'</div>':'<p class="empty">Open a file or web preview to keep it with this project.</p>')}
    else if(a==='deck-file-open'){const f=saved.media[id];dismissCard();if(f)open('media:'+id,f.project)}
    else if(a==='deck-refresh'){const file=saved.media[mediaID(id)],node=previews.get(id);if(file?.kind==='pdf'){if(live)postLive('workspace-pdf-page',{id:file.id,page:Number(node?.dataset.page||0)})}else if(file?.kind==='text'||workspaceDocuments.kind(file)==='markdown'){if(live)postLive('workspace-read-text',{id:file.id})}else{const el=node?.querySelector('iframe,img,video,audio');if(el){if(el.tagName==='IFRAME'){el.src=file.url;if(file.sourceView&&live)postLive('workspace-read-text',{id:file.id})}else{el.src=file.url+(file.url.includes('?')?'&':'?')+'refresh='+Date.now();el.load?.()}}}}
    else if(a==='deck-pdf-prev'||a==='deck-pdf-next'){const root=previews.get('media:'+id);const page=Math.max(0,Math.min(Number(root?.dataset.pages||1)-1,Number(root?.dataset.page||0)+(a==='deck-pdf-next'?1:-1)));if(live)postLive('workspace-pdf-page',{id,page})}
    else if(a==='deck-source'){const file=saved.media[id],node=previews.get('media:'+id);if(file&&node){file.sourceView=!file.sourceView;paintDocument(node,file);if(node.previewText===undefined&&live)postLive('workspace-read-text',{id});update(proj(activeProject),projects.get(activeProject));persist()}}
    else if(a==='deck-zoom'){previews.get(id)?.classList.toggle('zoomed')}
    else if(a==='deck-reveal'){if(live)postLive('workspace-reveal',{id})}
    else if(a==='deck-browser'){if(live)postLive('workspace-open-url',{url:saved.media[id]?.url})}
    else if(a==='deck-details')details(id);
    else if(a==='deck-result')openResult(id);
    else if(a==='deck-conversation')showSession(id);
    else if(a==='deck-stop')dialog('Stop this session?','Terminal process','<p>This ends the process. Its captured output remains available until the terminal service exits.</p><div class="form-actions">'+button('Keep running','close')+button('Stop session','deck-stop-confirm',id,'primary','stop')+'</div>');
    else if(a==='deck-stop-confirm'){send('stop',{id});dismissCard()}
    else if(a==='deck-find'){dialog('Find in terminal',label('terminal:'+id),'<form id="deck-find-form" class="stack"><label class="field">Search<input id="deck-find-text" type="search"></label><button class="primary" type="submit">Find next</button><p id="deck-find-state" role="status"></p></form>');$('#deck-find-form').onsubmit=e=>{e.preventDefault();$('#deck-find-state').textContent=engines.get(id)?.search.findNext($('#deck-find-text').value)?'Match highlighted in the terminal.':'No match in the available scrollback.'}}
    else if(a==='deck-preferences')preferences();
    else if(a==='deck-reconnect')send('reconnect');
    else if(a==='deck-notes')dialog('Project notes',proj(id)?.name,noteList(state.notes.filter(n=>n.project===id)));
    else if(a==='deck-history')dialog('Project history',proj(id)?.name,sessionList(state.sessions.filter(s=>s.project===id)));
    else if(a==='deck-activity')activity();
  });
  window.addEventListener('blur',()=>requestAnimationFrame(()=>{const frame=document.activeElement,preview=frame?.tagName==='IFRAME'?frame.closest('.deck-floating'):null,pane=preview?projects.get(activeProject)?.querySelector('.deck-group[data-group-id="'+CSS.escape(preview.dataset.groupId)+'"]'):null;if(pane&&activeProject){const l=layout(activeProject);l.selected=Number(pane.dataset.group);const root=projects.get(activeProject);root.querySelectorAll('.deck-group').forEach(n=>n.classList.toggle('selected',n===pane));update(proj(activeProject),root);persist()}}));
  document.addEventListener('keydown',e=>{const tab=e.target.closest('.deck-tab');if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const tabs=[...tab.closest('.deck-tabs').querySelectorAll('.deck-tab')],index=tabs.indexOf(tab),next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length;const key=tabs[next].dataset.id;tabs[next].click();const selected=projects.get(activeProject)?.querySelector('.deck-tab[aria-selected="true"][data-id="'+CSS.escape(key)+'"]');selected?.focus()});
  document.addEventListener('keydown',e=>{if(!activeProject||document.querySelector('dialog[open]'))return;const key=layout(activeProject).groups[layout(activeProject).selected]?.active;if(e.metaKey&&e.key.toLowerCase()==='d'&&!e.altKey){e.preventDefault();split(activeProject,e.shiftKey?'y':'x');return}if(e.metaKey&&e.key.toLowerCase()==='w'&&key){e.preventDefault();close(key)}if(e.metaKey&&e.key.toLowerCase()==='f'&&termID(key)){e.preventDefault();projects.get(activeProject)?.querySelector('[data-action="deck-find"][data-id="'+termID(key)+'"]')?.click()}if(e.metaKey&&e.key.toLowerCase()==='k'){e.preventDefault();go('sessions');$('#session-filter')?.focus()}});
  function outcome(e){if(e.recovered)return;const s=sess(e.session);if(!s)return;if(e.state==='Failed'&&terminals.get(s.id)?.stopped)return;if(e.state==='Complete')notify('complete',s.id,sessionDisplayName(s),e.message||'The agent reported a result.','result:'+e.capture,e.capture);else if(e.state==='Failed')notify('failure',s.id,sessionDisplayName(s),e.message||'The task could not be completed.','failed:'+e.capture)}
  function closeFront(){if(!activeProject)return false;const l=layout(activeProject),key=l.groups[l.selected]?.active;if(!key)return false;close(key);return true}
  function openTerminal(id){if(window.tasktapSurface==='notch'){postLive('workspace-open-terminal',{id});return}const t=terminals.get(id);if(t)open('terminal:'+id,ensureProject(t).id)}
  function terminalText(id){const term=engines.get(id)?.term;if(!term)return '';const buffer=term.buffer.active;return Array.from({length:buffer.length},(_,i)=>buffer.getLine(i)?.translateToString(true)||'').join('\n')}
  function terminalMetrics(id){
    const en=engines.get(id),screen=en?.element.querySelector('.xterm-screen');if(!screen)return null;
    const outer=en.element.getBoundingClientRect(),style=getComputedStyle(en.element),rect=screen.getBoundingClientRect(),pane=en.element.closest('.deck-surface')?.getBoundingClientRect();
    const top=outer.top+parseFloat(style.paddingTop),left=outer.left+parseFloat(style.paddingLeft),bottom=outer.bottom-parseFloat(style.paddingBottom),right=outer.right-parseFloat(style.paddingRight);
    const buffer=en.term.buffer.active;
    return {rows:en.term.rows,cols:en.term.cols,viewport:{width:innerWidth,height:innerHeight},pane:pane?{top:pane.top,left:pane.left,bottom:pane.bottom,right:pane.right}:null,content:{top,left,bottom,right},screen:{top:rect.top,left:rect.left,bottom:rect.bottom,right:rect.right},firstLine:buffer.getLine(buffer.viewportY)?.translateToString(true)||'',lastLine:buffer.getLine(buffer.viewportY+en.term.rows-1)?.translateToString(true)||''};
  }
  function pdfLoaded(id,result){const root=previews.get('media:'+id);if(!root)return;if(result.error){root.replaceChildren(message(result.error));return}root.dataset.page=result.page;root.dataset.pages=result.pages;root.querySelector('.deck-pdf-label').textContent='Page '+(result.page+1)+' of '+result.pages;root.querySelector('[data-action="deck-pdf-prev"]').disabled=result.page===0;root.querySelector('[data-action="deck-pdf-next"]').disabled=result.page+1===result.pages;let img=root.querySelector('img');if(!img){img=document.createElement('img');img.className='deck-pdf-page';root.append(img)}img.src=result.image;img.alt=result.text||'PDF page '+(result.page+1)}
  function paintDocument(node,file){
    if(file.kind==='web'){
      let source=node.querySelector('.deck-document');if(!source){source=document.createElement('pre');source.className='deck-document';node.append(source)}
      source.textContent=node.previewText??'Loading…';source.hidden=!file.sourceView;const frame=node.querySelector('iframe');if(frame)frame.hidden=!!file.sourceView;
    }else if(workspaceDocuments.kind(file)==='markdown'&&!file.sourceView){
      let article=node.querySelector('.workspace-document');if(!article){article=document.createElement('article');node.replaceChildren(article)}
      workspaceDocuments.render(article,node.previewText??'Loading…',file);
    }else{
      let source=node.querySelector('.deck-document');if(!source){source=document.createElement('pre');source.className='deck-document';node.replaceChildren(source)}source.textContent=node.previewText??'Loading…';
    }
  }
  function textLoaded(id,text){const node=previews.get('media:'+id),file=saved.media[id];if(node&&file){node.previewText=text;paintDocument(node,file)}}
  function shellHistory(filter=''){const rows=[...terminals.values()].filter(t=>t.kind==='shell'&&[t.title,t.cwd].join(' ').toLowerCase().includes(filter.toLowerCase()));return rows.length?'<section class="block"><h2>Terminals</h2>'+rows.map(t=>button(t.title+' / '+(t.running?'Running':t.restored?'Not running':t.stopped?'Stopped':'Exited')+' / '+t.cwd,'deck-open',t.id,'note','sessions')).join('')+'</section>':''}
  function openResult(id){if(window.tasktapSurface==='notch'){postLive('workspace-open-result',{id});return}const result=report(id);if(result.session){for(const item of saved.activity)if(item.capture===id||!item.capture&&item.id===id)item.read=true;dismissCard();open('result:'+id,result.session.project)}}
  // Restore an explicit layout without automatically starting any process.
  function sidebarData(){return {layouts:saved.layouts,terminals:[...terminals.values()],label,icon:surfaceIcon}}
  if(typeof appAppearance!=='undefined')appAppearance.receiveGhostty(inherited);
  applyAppearance();
  return {openWorkspace,closeWorkspace,sidebarData,appearanceLoaded,pdfLoaded,openTerminal,terminalText,terminalMetrics,shellHistory,textLoaded,receive,renderProject,leave,addFiles,open,openResult,outcome,closeFront,preferences,activity};
})();

if(location.hash!=='#geometry')render();
