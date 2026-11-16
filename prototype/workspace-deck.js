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
  saved.terminalFontSizes??={};
  saved.background??={};saved.closedWorkspaces??={};
  const closingWorkspaces=new Set(),intentionalStops=new Set(),closingSessions=new Map(),openingWorkspaces=new Map();
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
  let screenReaderEnabled=window.tasktapScreenReaderEnabled===true,fitTimer=0;
  const pendingFits=new Set();
  function accessibilityChanged(enabled){
    screenReaderEnabled=enabled===true;
    for(const en of engines.values())en.term.options.screenReaderMode=screenReaderEnabled;
  }
  function queueFit(en){
    if(!en)return;
    pendingFits.add(en);clearTimeout(fitTimer);
    // Reflow the scrollback once the pointer pauses, rather than repainting every
    // terminal and sending SIGWINCH to each CLI on every frame of a drag.
    fitTimer=setTimeout(flushFits,100);
  }
  function flushFits(){
    clearTimeout(fitTimer);fitTimer=0;
    const plans=[...pendingFits].filter(en=>engines.get(en.id)===en&&en.element.getClientRects().length).map(en=>[en,en.fit.proposeDimensions()]);
    pendingFits.clear();
    // Measure all panes before changing any terminal's DOM.
    for(const [en,size] of plans)fit(en,size);
  }
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
  const fontSize=(id,a=appearance())=>saved.terminalFontSizes[id]||saved.preferences.font||a.fontSize;
  function textSizeShortcut(e){
    if(!e.metaKey||e.ctrlKey||e.altKey||e.isComposing)return null;
    return e.key==='+'||e.key==='='?1:e.key==='-'?-1:e.key==='0'&&!e.shiftKey?0:null;
  }
  function resizeText(id,change){
    const en=engines.get(id);if(!en)return;
    if(change===0)delete saved.terminalFontSizes[id];
    else saved.terminalFontSizes[id]=Math.max(8,Math.min(40,fontSize(id)+change));
    en.term.options.fontSize=fontSize(id);fit(en);persist();
    if(activeProject)update(proj(activeProject),projects.get(activeProject));
  }
  function clipboardCommand(action,focusedOnly=false,id=null){
    if(!['copy','paste'].includes(action)||!activeProject||document.querySelector('dialog[open]'))return false;
    if(focusedOnly&&!document.activeElement?.closest('.deck-terminal,.deck-tab,.deck-pane-tools'))return false;
    const l=layout(activeProject);id??=termID(l.groups[l.selected]?.active);
    const en=engines.get(id);if(!en||en.element.hidden||!en.element.getClientRects().length)return false;
    const text=action==='copy'?en.term.getSelection():null;
    if(action==='copy'&&!text){toast('Select terminal text to copy.');return true}
    if(action==='paste'&&(!connected||terminals.get(id)?.running===false)){toast('This terminal is unavailable. Reconnect before pasting.');return true}
    const bridge=window.webkit?.messageHandlers?.terminalClipboard;
    (async()=>{
      if(action==='copy'){
        if(bridge)await bridge.postMessage({op:'copy',text});else await navigator.clipboard.writeText(text);
        toast('Copied terminal selection.');
      }else{
        const value=bridge?await bridge.postMessage({op:'paste'}):await navigator.clipboard.readText();
        // Capture the destination before the asynchronous clipboard read. A closed
        // or replaced terminal must never receive a late paste.
        if(engines.get(id)!==en||!connected||terminals.get(id)?.running===false)return;
        if(typeof value!=='string'||!value){toast('The clipboard has no text to paste.');return}
        if(new TextEncoder().encode(value).length>64000){toast('This clipboard text is too large. Paste a smaller section.');return}
        en.term.paste(value);
      }
      if(activeProject){const current=layout(activeProject);if(termID(current.groups[current.selected]?.active)===id)en.term.focus()}
    })().catch(()=>toast('Clipboard access failed. Try Copy or Paste from the Edit menu.'));
    return true;
  }
  function applyAppearance(){
    const a=appearance(),style=document.documentElement.style;
    style.setProperty('--deck-bg',a.theme.background);style.setProperty('--deck-fg',a.theme.foreground);
    style.setProperty('--deck-padding',a.padding.map(n=>n+'px').join(' '));
    const font=a.fontFamilies.map(f=>JSON.stringify(f)).join(',')+', monospace';
    for(const en of engines.values()) {en.term.options.theme={...a.theme,background:a.theme.background+'00'};en.term.options.fontFamily=font;en.term.options.fontSize=fontSize(en.id,a);en.term.options.cursorStyle=a.cursorStyle;en.term.options.cursorBlink=a.cursorBlink;fit(en)}
    if(live)postLive('workspace-chrome',{background:a.theme.background,followSystem:typeof appAppearance!=='undefined'&&appAppearance.current().id==='system',opacity:saved.preferences.translucent===false?1:inherited.opacity??neutral.opacity,blur:saved.preferences.blur!==false});
  }
  function appearanceLoaded(value){inherited=value;saved.appearance=value;persist();if(typeof appAppearance!=='undefined')appAppearance.receiveGhostty(value);applyAppearance();const note=$('#deck-appearance-source');if(note)note.textContent=appearanceDescription()}
  function appearanceDescription(){const a=appearance();return a.source==='Ghostty'?'Ghostty typography / '+a.fontFamilies[0]+' / '+a.fontSize+' pt':a.note||'Using the default terminal font and cursor.'}
  document.addEventListener('appearance-changed',applyAppearance);
  function report(id){const capture=byId(state.captures,id),event=saved.activity.find(a=>a.capture===id||!a.capture&&a.id===id),session=sess(capture?.session||event?.id||id);return {capture,event,session,text:capture?.result||event?.body||session?.result||'No outcome has been reported yet.'}}
  function label(key){const id=termID(key);if(id)return sess(id)?sessionDisplayName(sess(id)):terminals.get(id)?.title||'Terminal';if(mediaID(key))return saved.media[mediaID(key)]?.title||'File';return report(key?.slice(7)).session?.task||'Result'}
  function surfaceIcon(key){return termID(key)?'sessions':mediaID(key)?saved.media[mediaID(key)]?.kind==='web'?'out':'note':'checks'}
  function status(id){const t=terminals.get(id),s=sess(id);return pendingStarts.has(id)?'Opening terminal':t?.running===false?(t.exit===0?'Exited':t.restored?'Not running':'Stopped'):s?.state||'Shell running'}
  function sessionCue(id){
    const t=terminals.get(id),s=sess(id),events=saved.activity.filter(a=>a.id===id&&!a.read);
    if(state.decisions.some(q=>q.session===id))return {kind:'input',label:'Needs input',symbol:'?'};
    const observation=sessionObservation.cue(id);if(observation)return observation;
    if(events.some(a=>a.kind==='failure'))return {kind:'failure',label:'Failed',symbol:'!'};
    if(events.some(a=>a.kind==='complete'))return {kind:'complete',label:'Answer ready',symbol:'✓'};
    if(pendingStarts.has(id))return {kind:'working',label:'Opening',symbol:'◌'};
    if(t?.running===false)return {kind:'ended',label:t.restored?'Not running':t.stopped?'Stopped':t.exit===0?'Exited':'Failed',symbol:'○'};
    if(s?.state==='Complete'||s?.state==='Ready')return {kind:'ready',label:'Ready',symbol:'○'};
    if(t?.kind==='shell')return {kind:'connected',label:'Terminal',symbol:'○'};
    if(t?.kind==='agent'&&!['Running','Needs input'].includes(s?.state))return {kind:'connected',label:'Connected',symbol:'○',activity:'Live lifecycle monitoring unavailable'};
    return {kind:'working',label:t?.kind==='agent'||s?'Working':'Running',symbol:'◌'};
  }
  function notify(kind,id,title,body,token,capture){
    if(saved.seen[token])return;
    saved.seen[token]=Date.now();
    saved.activity.unshift({kind,id,capture,title,body,project:sess(id)?.project,agent:sess(id)?.agent,time:Date.now(),read:false});saved.activity=saved.activity.slice(0,60);
    const keys=Object.keys(saved.seen);if(keys.length>500)keys.slice(0,keys.length-500).forEach(k=>delete saved.seen[k]);
    persist();refreshActivity();
    // An event remains in Activity even with OS alerts disabled. Never notify for
    // terminal text, title escape sequences, or restored historical state.
    if(state.alerts && live && (sess(id)?.host==='tasktap'||!sess(id)) && (!document.hasFocus()||saved.background[id]||kind==='answer'&&focusedTerminal()!==id)){
      const turn=sessionObservation.get(id)?.answers?.at(-1)?.turn;
      postLive('notify',{kind:kind==='answer'?'answer':kind==='failure'?'failure':'complete',id:kind==='answer'?id+':'+turn:kind==='complete'&&capture?capture:id,title,body});
    }
  }
  function schedule(){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{persist();render()},70)}
  function adoptObservation(row,restored=false){
    if(!row.observation)return;
    if(!sess(row.id)){const p=ensureProject(row);state.sessions.unshift({id:row.id,project:p.id,host:'tasktap',task:row.title,
      agent:row.observation.agent||row.agent||'unknown',interactive:true,managed:true,available:row.running,log:[]})}
    sessionObservation.receive(row.id,row.observation,{restored});
    sessionObservation.apply(sess(row.id));
  }
  function focusedTerminal(){
    if(stage.hidden||document.hidden||!document.hasFocus()||document.querySelector('#modal[open]'))return null;
    const pane=document.activeElement?.closest('.deck-group');
    return pane?.dataset.ackSession||pane?.dataset.sessionId||null;
  }
  function acknowledgeFocused(){
    const id=focusedTerminal();if(!id)return;
    for(const event of saved.activity)if(event.id===id&&['complete','failure'].includes(event.kind))event.read=true;
    sessionObservation.acknowledge(id);
  }
  document.addEventListener('session-observation',event=>{
    const {id,observation:o,previous,restored}=event.detail,s=sess(id),last=(o.answers||[]).at(-1);
    if(!s){schedule();return}
    const token=last?sessionObservation.answerKey(id,last.turn):null;
    if(last&&token&&!saved.seen[token]){
      if(restored){saved.seen[token]=Date.now();saved.activity.unshift({kind:'answer',id,turn:last.turn,title:sessionDisplayName(s),project:s?.project,agent:s?.agent,time:last.time*1000,read:!sessionObservation.unread(id)});saved.activity=saved.activity.slice(0,60)}
      else notify('answer',id,'Answer ready · '+sessionDisplayName(s),'A new answer is ready in its terminal.',token);
      const item=saved.activity.find(a=>a.id===id&&a.kind==='answer'&&a.time>=last.time*1000-1000);if(item)item.turn=last.turn;
    }
    if(o.state==='failed'&&!restored&&previous?.state!=='failed'&&!intentionalStops.has(id))notify('failure',id,sessionDisplayName(s),o.error||'The agent turn failed.','observer-failure:'+id+':'+o.launchId+':'+o.turn);
    const waiting=['needsInput','needsPermission'];
    if(waiting.includes(o.state)&&previous?.state!==o.state&&!restored&&state.alerts&&live&&focusedTerminal()!==id)
      postLive('notify',{kind:'attention',id,title:(o.state==='needsPermission'?'Needs permission':'Needs input')+' · '+sessionDisplayName(s),body:o.question||'Open the terminal to respond.'});
    if(waiting.includes(previous?.state)&&!waiting.includes(o.state)&&live)postLive('clear',{kind:'attention',id});
    schedule();
    // Let an answer's one-shot sweep finish before acknowledging an already
    // focused terminal. A background pane never inherits another pane's focus.
    if(o.event==='turn_finished')setTimeout(()=>{if(focusedTerminal()===id)acknowledgeFocused()},1250);
  });
  document.addEventListener('session-acknowledged',schedule);
  stage.addEventListener('focusin',()=>{acknowledgeFocused();if(activeProject)update(proj(activeProject),projects.get(activeProject))});
  window.addEventListener('focus',()=>{acknowledgeFocused();schedule()});
  document.addEventListener('visibilitychange',()=>{document.body.classList.toggle('observer-page-hidden',document.hidden);if(!document.hidden)acknowledgeFocused()});
  function ensureProject(row){let p=projectFor(row.cwd);if(!p){p={id:row.cwd,folder:row.cwd,name:row.cwd.split('/').pop(),available:true,aliases:[]};state.projects.push(p)}return p}
  function finishCloseSession(id){const project=closingSessions.get(id);if(!project)return;closingSessions.delete(id);delete saved.background[id];close('terminal:'+id,project)}
  async function receive(events){
    const writes=[];
    for(const e of events){
      if(e.event==='sessions'){
        connected=true;for(const row of e.sessions||[]){
          terminals.set(row.id,row);const p=ensureProject(row);adoptObservation(row,true);completeLaunch(row);if(!row.running)finishCloseSession(row.id);
          if(row.running&&saved.closedWorkspaces[p.id])send('stop',{id:row.id});
          // Adopt detached sessions from earlier versions without starting work.
          if(row.running&&saved.openProjects?.includes(p.id)&&!saved.closedWorkspaces[p.id]&&!Object.values(saved.layouts).some(l=>l.groups.some(g=>g.tabs.includes('terminal:'+row.id)))&&!pendingStarts.has(row.id))saved.background[row.id]=p.id;
        }
        for(const engine of engines.values()){engine.attached=false;send('attach',{id:engine.id})}
        schedule();
      }else if(e.event==='session' && e.session){
        const row=e.session,old=terminals.get(row.id);terminals.set(row.id,row);const p=ensureProject(row);
        adoptObservation(row,!!row.restored);
        if(row.running&&!old?.running&&!closingSessions.has(row.id)&&!closingWorkspaces.has(p.id)&&!saved.closedWorkspaces[p.id])intentionalStops.delete(row.id);
        if(old&&!old.running&&row.running&&engines.has(row.id)){engines.get(row.id).attached=false;send('attach',{id:row.id})}
        if(old?.running&&!row.running){const s=sess(row.id);if(s){s.available=false;if(!s.result)s.state=row.exit===0||row.stopped?'Closed':'Failed'}
          if(row.kind==='shell'&&row.exit!==0&&!row.stopped)notify('failure',row.id,label('terminal:'+row.id),'The process ended. Open its terminal to see what happened.','exit:'+row.id+':'+row.created);
        }
        if(saved.closedWorkspaces[p.id]||closingWorkspaces.has(p.id)){if(row.running)send('stop',{id:row.id});completeLaunch(row)}
        else if(!completeLaunch(row)&&!old&&row.running&&!saved.background[row.id])open('terminal:'+row.id,p.id,false);
        if(!row.running)finishCloseSession(row.id);
        schedule();
      }else if(e.event==='observation'){
        const t=terminals.get(e.id);if(t){t.observation=e.observation;adoptObservation(t,false)}else sessionObservation.receive(e.id,e.observation);
      }else if(e.event==='session-cancelled'){
        pendingStarts.delete(e.id);finishCloseSession(e.id);schedule();
      }else if(e.event==='workspace-opened'){
        const pending=openingWorkspaces.get(e.cwd);if(pending){clearTimeout(pending.timer);openingWorkspaces.delete(e.cwd);delete saved.closedWorkspaces[pending.project];rememberWorkspace(pending.project);pending.resolve();schedule()}
      }else if(e.event==='workspace-closed'){
        const p=projectFor(e.cwd);if(p&&closingWorkspaces.has(p.id)){closingWorkspaces.delete(p.id);finishCloseWorkspace(p.id)}
      }else if(e.event==='replay'){
        const engine=engines.get(e.id);if(!engine)continue;
        engine.attached=true;engine.replaying=true;engine.seq=e.seq;engine.cwd=null;engine.term.reset();engine.term.resize(e.cols,e.rows);engine.sentSize=e.cols+'x'+e.rows;
        if(e.truncated)engine.term.write('\r\n[Earlier scrollback is no longer available.]\r\n');
        writes.push(new Promise(done=>engine.term.write(bytes(e.data),()=>{fit(engine);if(engines.get(e.id)===engine){engine.replaying=false;for(const data of engine.pendingInput)send('input',{id:engine.id,data});engine.pendingInput=[];engine.pendingBytes=0}done()})));
      }else if(e.event==='output'){
        const engine=engines.get(e.id);if(!engine||!engine.attached||e.seq<=engine.seq)continue;
        engine.seq=e.seq;writes.push(new Promise(done=>engine.term.write(bytes(e.data),done)));
      }else if(e.event==='focus'){
        const p=projectFor(terminals.get(e.id)?.cwd);if(p&&!saved.background[e.id]&&!saved.closedWorkspaces[p.id]&&!closingWorkspaces.has(p.id))open('terminal:'+e.id,p.id,true);
      }else if(e.event==='disconnected'){
        connected=false;for(const en of engines.values()){en.attached=false;en.pendingInput=[];en.pendingBytes=0;}
        toast(e.error);schedule();
      }else if(e.event==='error'){for(const [cwd,pending] of openingWorkspaces)if(cwd===e.cwd||!e.id&&!e.cwd){clearTimeout(pending.timer);openingWorkspaces.delete(cwd);pending.reject(new Error(e.error||'Could not reopen workspace.'))}if(closingSessions.has(e.id)){closingSessions.delete(e.id);intentionalStops.delete(e.id);const pending=pendingStarts.get(e.id);if(pending)pending.closed=false;toast(e.error||'Could not stop the session.');schedule();continue}const closing=projectFor(e.cwd);if(closing){closingWorkspaces.delete(closing.id);for(const id of workspaceSessions(closing.id))intentionalStops.delete(id)}else if(!e.id)closingWorkspaces.clear();const pending=pendingStarts.get(e.id);pendingStarts.delete(e.id);if(pending&&!pending.closed)close('terminal:'+e.id,pending.project);const en=engines.get(e.id);if(en){en.pendingInput=[];en.pendingBytes=0}toast(e.error||'The terminal operation could not be completed.');schedule()}
    }
    await Promise.all(writes);
  }
  function fit(en,size){
    if(!en?.element.isConnected||!en.element.getClientRects().length)return;
    try{
      const dims=size||en.fit.proposeDimensions();if(!dims)return;
      if(en.term.cols!==dims.cols||en.term.rows!==dims.rows)en.term.resize(dims.cols,dims.rows);
      const key=en.term.cols+'x'+en.term.rows;
      if(en.attached&&key!==en.sentSize){send('resize',{id:en.id,cols:en.term.cols,rows:en.term.rows});en.sentSize=key}
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
    const term=new Terminal({fontFamily:a.fontFamilies.map(f=>JSON.stringify(f)).join(',')+', monospace',fontSize:fontSize(id,a),scrollback:10000,convertEol:false,allowTransparency:true,allowProposedApi:false,screenReaderMode:screenReaderEnabled,cursorStyle:a.cursorStyle,cursorBlink:a.cursorBlink,theme:{...a.theme,background:a.theme.background+'00'}});
    const fitAddon=new FitAddon.FitAddon(),search=new SearchAddon.SearchAddon();term.loadAddon(fitAddon);term.loadAddon(search);
    const en={id,element,viewport,term,fit:fitAddon,search,seq:0,attached:false,pendingInput:[],pendingBytes:0};engines.set(id,en);
    stash.append(element);term.open(viewport);
    en.inputGuard=terminalInput.install(term,viewport,()=>toast('Text correction skipped in terminal input. Use Compose text… in Tab actions to review prose.'));
    workspaceLinks.terminal(term,()=>({project:projectFor(terminals.get(id)?.cwd)?.id||sess(id)?.project,cwd:en.cwd||terminals.get(id)?.cwd||proj(sess(id)?.project)?.folder}));
    // Shell integration can report directory changes using OSC 7. Only local
    // file URLs are accepted; this updates link resolution, never runs input.
    term.parser.registerOscHandler(7,value=>{try{const url=new URL(value);if(url.protocol==='file:'&&(!url.host||['localhost',location.hostname].includes(url.host)))en.cwd=decodeURIComponent(url.pathname)}catch{}return true});
    term.onData(data=>input(en,encoded(data)));
    term.onBinary(data=>input(en,btoa(data)));
    term.onScroll(()=>{element.classList.add('is-scrolling');clearTimeout(en.scrollTimer);en.scrollTimer=setTimeout(()=>element.classList.remove('is-scrolling'),900)});
    term.attachCustomKeyEventHandler(e=>{
      if(textSizeShortcut(e)!==null)return false;
      if(e.metaKey&&['w','k','f','d'].includes(e.key.toLowerCase()))return false;
      if(e.metaKey&&!e.ctrlKey&&!e.altKey&&['c','v'].includes(e.key.toLowerCase()))return false;
      return true;
    });
    const resize=new ResizeObserver(()=>queueFit(en));resize.observe(viewport);en.resize=resize;
    if(live)send('attach',{id});else term.write('Tasktap terminal\r\n\r\nRun the Mac app to open a real shell or coding agent.\r\nThis browser preview does not execute commands.\r\n');
    return en;
  }
  function preview(key){
    if(previews.has(key)){const cached=previews.get(key);if(key.startsWith('result:')){const text=cached.querySelector('.deck-document');if(text&&text.dataset.report!==report(key.slice(7)).text){const value=report(key.slice(7)).text;resultPresentation.render(text,value,report(key.slice(7)).session?.project);text.dataset.report=value}}return cached;}
    const root=document.createElement('div');root.className='deck-preview';
    const file=saved.media[mediaID(key)];
    if(key.startsWith('result:')){
      const result=report(key.slice(7));root.classList.add('deck-report');const title=document.createElement('h2');title.textContent=result.session?sessionDisplayName(result.session):'Agent report';
      const text=document.createElement('div');text.className='deck-document';resultPresentation.render(text,result.text,result.session?.project);text.dataset.report=result.text;
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
        frame.setAttribute('sandbox','allow-scripts allow-forms'+(file.path?'':' allow-popups'));frame.referrerPolicy='no-referrer';frame.src=source;root.append(frame);
        if(!file.path){const external=document.createElement('button');external.className='btn';external.textContent='Open in default browser';external.title='Use your browser if this site does not allow embedded previews';external.addEventListener('click',()=>{if(live)postLive('workspace-open-url',{url:file.url})});root.append(external)}
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
    if(!saved.openProjects.includes(project)){delete saved.closedWorkspaces[project];saved.openProjects.push(project);send('open-workspace',{cwd:proj(project).folder});persist()}
  }
  function openWorkspace(project,createTerminal=false){
    const p=proj(project);if(!p)return;
    if(closingWorkspaces.has(project)){toast('This workspace is stopping. Wait for it to close.');return}
    rememberWorkspace(project);
    if(typeof showWorkspace==='function')showWorkspace();go(project);
    const l=layout(project);
    if(createTerminal&&!l.groups.some(g=>g.tabs.length)&&![...pendingStarts.values()].some(v=>v.project===project&&!v.closed))startTerminal(project);
    else focusSurface(project,l.groups[l.selected]?.active);
    persist();
  }
  function prepareLaunch(project){
    if(closingWorkspaces.has(project))throw new Error('This workspace is still stopping. Reopen it after it closes.');
    if(!saved.closedWorkspaces[project])return null;
    const cwd=proj(project)?.folder;if(!cwd)throw new Error('Choose an available workspace.');
    if(openingWorkspaces.has(cwd))throw new Error('This workspace is reopening. Try again shortly.');
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{openingWorkspaces.delete(cwd);reject(new Error('Could not reconnect to the terminal service. Try again.'))},10000);openingWorkspaces.set(cwd,{project,resolve,reject,timer});send('open-workspace',{cwd})});
  }
  function workspaceSessions(project){const p=proj(project);return [...new Set([...terminals.values()].filter(t=>t.cwd===p?.folder&&t.running).map(t=>t.id).concat([...pendingStarts].filter(([,v])=>v.project===project).map(([id])=>id),state.sessions.filter(s=>s.host==='tasktap'&&(s.project===project||s.project===p?.folder)&&['Queued','Opening','Running','Connected','Needs input'].includes(s.state)&&s.available!==false).map(s=>s.id)))];}
  function closeWorkspace(project){
    if(closingWorkspaces.has(project))return;
    const count=workspaceSessions(project).length;
    if(count){dialog('Close workspace and stop '+count+' session'+(count===1?'':'s')+'?',proj(project)?.name,'<p>Running tasks and terminals will end, including background sessions. Your files, history, and saved layout remain.</p><div class="form-actions">'+button('Cancel','close')+button('Stop sessions and close','deck-workspace-stop',project,'primary','stop')+'</div>');return}
    stopWorkspace(project);
  }
  function stopWorkspace(project){
    if(closingWorkspaces.has(project))return;
    closingWorkspaces.add(project);for(const id of workspaceSessions(project))intentionalStops.add(id);
    for(const pending of pendingStarts.values())if(pending.project===project)pending.closed=true;
    if(live){send('stop-workspace',{cwd:proj(project).folder,ids:workspaceSessions(project)});toast('Stopping workspace sessions…')}
    else{for(const id of workspaceSessions(project)){const t=terminals.get(id);if(t)Object.assign(t,{running:false,stopped:true})}closingWorkspaces.delete(project);finishCloseWorkspace(project)}
  }
  function finishCloseWorkspace(project){
    saved.closedWorkspaces[project]=true;
    for(const [id,p] of Object.entries(saved.background))if(p===project)delete saved.background[id];
    if(tabDrag?.project===project)finishTabDrag();
    const index=saved.openProjects?.indexOf(project)??-1;
    saved.openProjects=(saved.openProjects||[]).filter(id=>id!==project);
    for(const pending of pendingStarts.values())if(pending.project===project)pending.closed=true;
    for(const g of saved.layouts[project]?.groups||[])g.tabs.forEach(disposeView);
    const node=projects.get(project);node?.layoutObserver?.disconnect();node?.remove();projects.delete(project);
    if(view===project)go(saved.openProjects[Math.min(Math.max(0,index),saved.openProjects.length-1)]||'overview');else renderNav(listedProjects(activeSessions()));
    persist();toast('Workspace closed. Its sessions have been stopped.');
  }
  function open(key,project,activate=true,groupID=null){if(window.tasktapSurface==='notch'){postLive('workspace-open',{key,project,activate});return}
    const id=termID(key);if(id)delete saved.background[id];
    const l=layout(project);let group=l.groups.find(g=>g.tabs.includes(key));
    if(!group){group=groupID?l.groups.find(g=>g.id===groupID):selectedGroup(l);if(!group)return;group.tabs.push(key)}group.active=key;l.selected=l.groups.indexOf(group);
    if(activate){if(typeof showWorkspace==='function')showWorkspace();go(project);requestAnimationFrame(()=>{const en=engines.get(termID(key));if(en)en.term.focus();else projects.get(project)?.querySelector('.deck-tab[aria-selected="true"][data-id="'+CSS.escape(key)+'"]')?.focus()})}else if(view===project)renderProject(proj(project));persist();
  }
  function leave(){finishTabDrag();activeProject=null;stage.hidden=true;$('#main').hidden=false;document.body.classList.remove('workspace-active','deck-focus');if(typeof workspaceNavigation!=='undefined')workspaceNavigation.sync()}
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
    const p=proj(project);if(!p||closingWorkspaces.has(project))return;const l=layout(project),g=groupID?l.groups.find(g=>g.id===groupID):selectedGroup(l);if(!g)return;
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
  // Moving a view changes ownership only; its engine or floating preview stays alive.
  function moveTab(project,key,groupID,{before=null,edge=null}={}){
    const l=layout(project),from=l.groups.find(g=>g.tabs.includes(key));
    let to=l.groups.find(g=>g.id===groupID);
    if(!from||!to||edge&&from===to&&from.tabs.length===1)return false;
    if(edge){
      to=workspaceLayout.split(l,to.id,['left','right'].includes(edge)?'x':'y',uid(),['left','top'].includes(edge)?'before':'after');
      l.focus=false;
    }
    const index=from.tabs.indexOf(key);
    if(from===to&&before===key)return false;
    from.tabs.splice(index,1);
    if(from.active===key)from.active=from.tabs[Math.min(index,from.tabs.length-1)]??null;
    const insertion=before?to.tabs.indexOf(before):-1;
    to.tabs.splice(insertion<0?to.tabs.length:insertion,0,key);to.active=key;
    l.selected=l.groups.indexOf(to);
    const pending=pendingStarts.get(termID(key));if(pending)pending.group=to.id;
    if(!from.tabs.length)workspaceLayout.remove(l,from.id);
    renderProject(proj(project));focusSurface(project,key);persist();return true;
  }
  let tabDrag=null,suppressTabClick=false;
  function finishTabDrag(){
    if(!tabDrag)return;
    const drag=tabDrag;tabDrag=null;
    drag.overlay?.remove();drag.marker?.remove();drag.ghost?.remove();
    document.body.classList.remove('deck-dragging','deck-tab-held');
    if(stage.hasPointerCapture(drag.pointer))stage.releasePointerCapture(drag.pointer);
    if(drag.tab.hasPointerCapture(drag.pointer))drag.tab.releasePointerCapture(drag.pointer);
    if(drag.started)suppressTabClick=true;
  }
  function tabDropTarget(drag,x,y){
    const root=projects.get(drag.project),l=layout(drag.project);
    for(const pane of root.querySelectorAll('.deck-group')){
      if(!pane.getClientRects().length)continue;
      const rect=pane.getBoundingClientRect();
      if(x<rect.left||x>rect.right||y<rect.top||y>rect.bottom)continue;
      const groupID=pane.dataset.groupId,bar=pane.querySelector('.deck-pane-bar').getBoundingClientRect();
      if(y<=bar.bottom){
        const tabs=pane.querySelector('.deck-tabs'),bounds=tabs.getBoundingClientRect();
        // Keep overflowing tabs reachable while hovering either end of the strip.
        if(x<bounds.left+24)tabs.scrollLeft-=12;else if(x>bounds.right-24)tabs.scrollLeft+=12;
        const wraps=[...tabs.querySelectorAll('.deck-tab-wrap')];
        const next=wraps.find(tab=>{const r=tab.getBoundingClientRect();return x<r.left+r.width/2});
        const end=wraps.at(-1)?.getBoundingClientRect().right??bounds.left;
        const left=Math.max(bounds.left,Math.min(bounds.right,next?.getBoundingClientRect().left??end));
        return {groupID,before:next?.querySelector('.deck-tab').dataset.id,box:{left:left-1,top:bar.top,width:3,height:bar.height}};
      }
      const content={left:rect.left,top:bar.bottom,width:rect.width,height:rect.bottom-bar.bottom};
      const distances=[['left',(x-rect.left)/Math.min(72,rect.width*.23)],['right',(rect.right-x)/Math.min(72,rect.width*.23)],['top',(y-bar.bottom)/Math.min(72,content.height*.23)],['bottom',(rect.bottom-y)/Math.min(72,content.height*.23)]];
      const nearest=distances.sort((a,b)=>a[1]-b[1])[0],edge=nearest[1]<1?nearest[0]:null;
      if(edge&&l.groups.find(g=>g.id===groupID)?.tabs.length===1&&groupID===drag.group)return null;
      const box={...content};
      if(edge==='left'||edge==='right'){box.width/=2;if(edge==='right')box.left+=box.width}
      if(edge==='top'||edge==='bottom'){box.height/=2;if(edge==='bottom')box.top+=box.height}
      return {groupID,edge,box};
    }
    return null;
  }
  stage.addEventListener('pointerdown',e=>{
    const tab=e.target.closest('.deck-tab');
    if(!tab||e.button!==0||!e.isPrimary)return;
    finishTabDrag();
    tabDrag={project:activeProject,key:tab.dataset.id,group:tab.closest('.deck-group').dataset.groupId,tab,pointer:e.pointerId,x:e.clientX,y:e.clientY};
    e.preventDefault();tab.focus({preventScroll:true});
    tab.setPointerCapture(e.pointerId);
    tabDrag.overlay=document.createElement('div');tabDrag.overlay.className='deck-drag-overlay';document.body.append(tabDrag.overlay);
    document.body.classList.add('deck-tab-held');tabDrag.overlay.getBoundingClientRect();
  });
  // Pointer capture plus an overlay keeps dragging continuous across sandboxed frames.
  window.addEventListener('pointermove',e=>{
    const drag=tabDrag;if(!drag||e.pointerId!==drag.pointer)return;
    if(drag.project!==activeProject){finishTabDrag();return}
    if(!drag.started){
      if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<6)return;
      drag.started=true;stage.setPointerCapture(e.pointerId);
      for(const menu of stage.querySelectorAll('.deck-menu[open]'))menu.open=false;
      drag.ghost=document.createElement('div');drag.ghost.className='deck-drag-ghost';drag.ghost.textContent=label(drag.key);
      drag.marker=document.createElement('div');drag.marker.className='deck-drop-marker';
      document.body.append(drag.marker,drag.ghost);document.body.classList.add('deck-dragging');
    }
    e.preventDefault();
    Object.assign(drag.ghost.style,{left:Math.min(innerWidth-drag.ghost.offsetWidth-8,e.clientX+14)+'px',top:Math.min(innerHeight-drag.ghost.offsetHeight-8,e.clientY+14)+'px'});
    drag.target=tabDropTarget(drag,e.clientX,e.clientY);drag.marker.hidden=!drag.target;
    if(drag.target){for(const [key,value] of Object.entries(drag.target.box))drag.marker.style[key]=value+'px';drag.marker.classList.toggle('tab-insertion',drag.target.box.width===3)}
  },{capture:true,passive:false});
  window.addEventListener('pointerup',e=>{
    const drag=tabDrag;if(!drag||e.pointerId!==drag.pointer)return;
    const target=drag.started?tabDropTarget(drag,e.clientX,e.clientY):null;
    finishTabDrag();
    if(target)moveTab(drag.project,drag.key,target.groupID,target);
  },true);
  window.addEventListener('pointercancel',finishTabDrag);
  stage.addEventListener('lostpointercapture',e=>{if(e.target===stage&&tabDrag?.started)finishTabDrag()});
  window.addEventListener('blur',finishTabDrag);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)finishTabDrag()});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&tabDrag?.started){e.preventDefault();e.stopPropagation();finishTabDrag()}},true);
  stage.addEventListener('dragstart',e=>{if(e.target.closest('.deck-tab'))e.preventDefault()});
  document.addEventListener('pointerdown',()=>{suppressTabClick=false},true);
  stage.addEventListener('click',e=>{if(suppressTabClick&&e.detail){suppressTabClick=false;e.preventDefault();e.stopImmediatePropagation()}},true);
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
        const balance=(value,save=true)=>{const current=branch(l.tree,divider.dataset.branch);if(!current)return;const ratio=Math.round(Math.max(10,Math.min(90,value)));if(current.ratio===ratio)return;current.ratio=ratio;arrange(root,l);if(save)persist();else divider.resizeDirty=true};
        const drag=e=>{if(!divider.hasPointerCapture(e.pointerId))return;const r=area.getBoundingClientRect(),b=divider.splitBounds;balance(((b.axis==='x'?e.clientX-r.left-b.x:e.clientY-r.top-b.y)-b.gap/2)/Math.max(1,b.available)*100,false)};
        divider.onpointerdown=e=>{e.preventDefault();divider.focus();divider.setPointerCapture(e.pointerId);drag(e)};divider.onpointermove=drag;
        divider.onpointerup=e=>{if(divider.hasPointerCapture(e.pointerId))divider.releasePointerCapture(e.pointerId)};
        divider.onlostpointercapture=()=>{if(divider.resizeDirty){divider.resizeDirty=false;persist()}flushFits()};
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
    if(tabDrag&&tabDrag.project!==p.id)finishTabDrag();
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
          pane.innerHTML='<div class="deck-pane-bar"><div class="deck-tabs" role="tablist"></div><div class="deck-pane-tools"></div></div><button type="button" class="deck-session-status" data-action="deck-details" hidden><span class="deck-state-dot" aria-hidden="true"></span><span class="deck-state-symbol" aria-hidden="true"></span><span class="deck-state-label" aria-live="polite"></span><span class="deck-state-activity"></span></button><div class="deck-surface"></div><div class="deck-question"></div><svg class="deck-session-ring" aria-hidden="true"><rect pathLength="100"/></svg>';
          const select=()=>{const selected=Number(pane.dataset.group);if(l.selected!==selected){l.selected=selected;root.querySelectorAll('.deck-group').forEach(n=>n.classList.toggle('selected',Number(n.dataset.group)===selected));update(p,root);persist()}};
          pane.addEventListener('pointerdown',select,{capture:true});pane.addEventListener('focusin',select);
          groups.append(pane);
        }
        pane.tabIndex=-1;pane.dataset.group=index;pane.id='deck-pane-'+g.id;pane.setAttribute('aria-label','Surface '+(index+1));pane.classList.toggle('selected',l.selected===index);
        const tabs=$('.deck-tabs',pane);tabs.setAttribute('aria-label','Surface '+(index+1));tabs.innerHTML=g.tabs.map(key=>'<div class="deck-tab-wrap '+(g.active===key?'active':'')+'"><button role="tab" aria-description="Drag to reorder or move between surfaces. Right-click or press Shift+F10 for tab actions" tabindex="'+(g.active===key?'0':'-1')+'" id="deck-tab-'+g.id+'-'+key.replace(/[^a-zA-Z0-9-]/g,'')+'" aria-controls="deck-surface-'+g.id+'" aria-selected="'+(g.active===key)+'" class="deck-tab" data-action="deck-tab" data-id="'+attr(key)+'" data-group="'+index+'">'+icon(surfaceIcon(key))+'<span>'+esc(label(key))+'</span></button><button class="deck-tab-close" aria-label="Close '+attr(label(key))+' view" data-action="deck-close" data-id="'+attr(key)+'">'+icon('x')+'</button></div>').join('');
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
    const l=layout(p.id);$('.deck-reconnect',root).hidden=!live||connected;root.querySelectorAll('.deck-tab').forEach(tab=>{const span=tab.querySelector('span');if(span)span.textContent=label(tab.dataset.id);const id=termID(tab.dataset.id);if(id){const cue=sessionCue(id);tab.dataset.status=cue.kind;tab.title=label(tab.dataset.id)+' / '+cue.label;let mark=tab.querySelector('.deck-tab-status');if(!mark){mark=document.createElement('small');mark.className='deck-tab-status';tab.append(mark)}mark.textContent=cue.symbol;mark.setAttribute('aria-label',cue.label);mark.title=cue.label}});
    l.groups.forEach((g,index)=>{
      const pane=root.querySelector('[data-group="'+index+'"].deck-group');if(!pane)return;pane.classList.toggle('selected',l.selected===index);
      const id=termID(g.active),s=sess(id),file=saved.media[mediaID(g.active)];
      pane.dataset.sessionId=id||'';
      pane.dataset.ackSession=id||(g.active?.startsWith('result:')?report(g.active.slice(7)).session?.id:'')||'';
      const cue=id?sessionCue(id):null,kind=cue?.kind||'none';
      pane.dataset.sessionState=kind;
      const statusBar=pane.querySelector('.deck-session-status');statusBar.hidden=!id||!(s||terminals.get(id)?.kind==='agent');
      statusBar.dataset.id=id||'';
      if(cue){statusBar.title=[cue.label,cue.activity].filter(Boolean).join(' · ');statusBar.setAttribute('aria-label',cue.label+'. Session details');
        const symbol=statusBar.querySelector('.deck-state-symbol');if(cue.kind==='permission')symbol.innerHTML=icon('shield');else symbol.textContent=cue.symbol;
        const label=statusBar.querySelector('.deck-state-label');if(label.textContent!==cue.label)label.textContent=cue.label;
        statusBar.querySelector('.deck-state-activity').textContent=cue.activity||''}
      const controls=$('.deck-pane-tools',pane),controlKey=JSON.stringify([g.active,!!s,l.groups.map(g=>g.id),!!file?.sourceView]);
      if(controls.dataset.signature!==controlKey){
        controls.dataset.signature=controlKey;
        const documentMode=file&&(workspaceDocuments.kind(file)==='markdown'||file.kind==='web'&&file.path);
        const actions=(documentMode?button(file.sourceView?'Preview':'Source','deck-source',file.id,'deck-menu-item'):'')+(s?button('Follow up','follow',id,'deck-menu-item'):file?button('Ask agent','deck-ask',file.id,'deck-menu-item'):'')+(id?button('Compose text…','deck-compose',id,'deck-menu-item','pen')+button('Find in terminal','deck-find',id,'deck-menu-item')+button('Increase text size / ⌘+','deck-text-increase',id,'deck-menu-item')+button('Decrease text size / ⌘−','deck-text-decrease',id,'deck-menu-item')+button('Reset text size / ⌘0','deck-text-reset',id,'deck-menu-item')+button('Session details','deck-details',id,'deck-menu-item'):file?.path?button('Show in Finder','deck-reveal',file.id,'deck-menu-item'):file?.url?button('Open in browser','deck-browser',file.id,'deck-menu-item'):'')+(file?button('Refresh preview','deck-refresh',g.active,'deck-menu-item'):'')+(file?.kind==='image'?button('Zoom image','deck-zoom',g.active,'deck-menu-item'):'')+(g.active&&l.groups.length>1?button('Move tab to…','deck-move',g.active,'deck-menu-item'):'');
        const paneActions=(id?button('Copy selection / ⌘C','deck-tool-copy',id,'deck-menu-item','copy')+button('Paste / ⌘V','deck-tool-paste',id,'deck-menu-item','paste'):'')+button('New terminal','deck-tool-terminal',p.id,'deck-menu-item','terminal')+button('New browser','deck-tool-url',p.id,'deck-menu-item','globe')+button('Split right / ⌘D','deck-tool-split-right',p.id,'deck-menu-item','splitRight')+button('Split down / ⇧⌘D','deck-tool-split-down',p.id,'deck-menu-item','splitDown');
        controls.innerHTML=(id?smallButton('Copy selection / ⌘C','deck-copy',id,'copy')+smallButton('Paste / ⌘V','deck-paste',id,'paste')+smallButton('Decrease text size / ⌘−','deck-text-decrease',id,'textSmaller')+smallButton('Increase text size / ⌘+','deck-text-increase',id,'textLarger'):'')+smallButton('New terminal','deck-terminal',p.id,'terminal')+smallButton('New browser','deck-url',p.id,'globe')+smallButton('Split right / ⌘D','deck-split-right',p.id,'splitRight')+smallButton('Split down / ⇧⌘D','deck-split-down',p.id,'splitDown')+menu('Tab actions','<div class="deck-menu-heading"></div>'+actions+paneActions);
        controls.querySelector('.deck-menu').classList.add('deck-tab-menu');
      }
      const heading=$('.deck-menu-heading',controls);if(heading)heading.textContent=id?[providers[s?.agent]||'Shell',status(id),fontSize(id)+' pt'].join(' / '):file?.path||file?.url||(g.active?'Reported outcome':'Surface '+(index+1));
      const tab=pane.querySelector('.deck-tab[aria-selected="true"]');if(tab&&!id)tab.title=label(g.active);
      const q=state.decisions.find(q=>q.session===id);
      const attention=cue&&['input','permission'].includes(cue.kind);
      $('.deck-question',pane).innerHTML=q?'<div><strong>'+esc(q.q)+'</strong><span class="hint">'+esc(providers[s?.agent]||'Agent')+' needs your decision</span></div>'+button('Review decision','notch',q.id,'primary'):attention?'<div><strong>'+esc(cue.activity||cue.label)+'</strong><span class="hint">Respond in this terminal.</span></div>'+button('Focus terminal','deck-open',id,'btn','terminal'):'';
      $('.deck-question',pane).hidden=!q&&!attention;
    });
    arrange(root,l);renderNav(listedProjects(activeSessions()));
  }
  function disposeView(key){
    const id=termID(key);if(id){const en=engines.get(id);if(en){pendingFits.delete(en);cancelAnimationFrame(en.fitFrame);clearTimeout(en.scrollTimer);en.resize.disconnect();en.inputGuard.dispose();en.term.dispose();en.element.remove();engines.delete(id);send('detach',{id})}}
    else{previews.get(key)?.remove();previews.delete(key)}
  }
  function requestClose(key,project=activeProject){
    const id=termID(key);
    if(closingSessions.has(id)){toast('This session is stopping.');return}
    if(!id||terminals.get(id)?.running===false){close(key,project);return}
    dialog('Close this session?',label(key),'<p>Keep it running under its workspace in the sidebar, or end the process.</p><div class="stack">'+button('Keep running in background','deck-background',id,'btn','sessions')+button('Stop session','deck-close-stop',id,'btn','stop')+button('Cancel','close',null,'text-btn')+'</div>');
  }
  function background(id){
    const project=pendingStarts.get(id)?.project||projectFor(terminals.get(id)?.cwd)?.id||sess(id)?.project||activeProject;
    if(!project)return;
    saved.background[id]=project;saved.navigationExpanded??={};saved.navigationExpanded[project]=true;
    close('terminal:'+id,project);renderNav(listedProjects(activeSessions()));
    toast('Session running in background. Find it under '+proj(project).name+'.');
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
  function addFiles(project,files){const p=projectFor(project)||proj(project);if(!p)return;if(document.querySelector('#modal[open]'))dismissCard();showWorkspace();for(const file of files){
    const existing=Object.values(saved.media).find(f=>f.project===p.id&&(file.path?f.path===file.path:f.url===file.url));
    if(existing){if(file.sourceLine){existing.sourceLine=file.sourceLine;existing.sourceColumn=file.sourceColumn;existing.sourceView=true;const node=previews.get('media:'+existing.id);if(node)paintDocument(node,existing)}open('media:'+existing.id,p.id,true);continue}
    file.project=p.id;if(file.sourceLine)file.sourceView=true;saved.media[file.id]=file;open('media:'+file.id,p.id,true)
  }go(p.id);persist()}
  function openWeb(project,url){addFiles(project,[{id:uid(),kind:'web',title:new URL(url).host,url}])}
  function activityTime(time){
    const date=new Date(time);
    if(!Number.isFinite(date.getTime()) || !(time>0))return '';
    const today=date.toDateString()===new Date().toDateString();
    const short=today?date.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):date.toLocaleDateString(undefined,{month:'short',day:'numeric'});
    return '<time datetime="'+date.toISOString()+'" title="'+attr(date.toLocaleString())+'">'+esc(short)+'</time>';
  }
  function activityTitle(session,fallback){
    const title=String((session?sessionDisplayName(session):fallback)||'Agent report');
    if(session?.sessionName)return {title,headline:title};
    const sentence=title.match(/^(.{16,160}?[.!?])\s+(?=[A-Z“"\d])/);
    return {title,headline:sentence&&!/\b(?:e\.g|i\.e|Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc)\.$/i.test(sentence[1])?sentence[1]:title};
  }
  function activityRow({session,event,question,status,kind='report',count=0}){
    const capture=event?.capture&&byId(state.captures,event.capture),project=proj(session?.project||capture?.project||event?.project),title=activityTitle(session,event?.title),agent=providers[session?.agent||event?.agent]||'Agent';
    const report=!!event,answer=event?.kind==='answer',action=question?'notch':answer?'observer-answer':report?'deck-result':'deck-open',id=question?.id|| (answer?event.id+':'+event.turn:report?event.capture||event.id:session?.id||event?.id);
    const metadata=[project?.name||'Scratch',agent,event?status:''].filter(Boolean).join(' · ');
    const label=(question?'Answer question':answer?'Read answer':report?'View report':'Open session')+': '+title.title+' / '+[metadata,event?'':status].filter(Boolean).join(' / ');
    return '<button type="button" class="activity-row" data-activity-kind="'+kind+'" data-action="'+action+'" data-id="'+attr(id)+'" aria-label="'+attr(label)+'"><span class="activity-symbol" aria-hidden="true">'+icon(question?'attention':kind==='failure'?'attention':report?'note':session?.agent||'sessions')+'</span><span class="activity-task"><strong title="'+attr(title.title)+'">'+esc(title.headline)+'</strong><span class="activity-meta" title="'+attr(metadata)+'">'+esc(metadata)+'</span>'+(question?'<span class="activity-question">'+esc(question.q)+'</span>':'')+'</span><span class="activity-end">'+(count>1?'<span class="activity-report-count" title="'+count+' reports">'+count+'</span>':'')+ (event?activityTime(event.time):'<span class="activity-state" data-state="'+attr(kind)+'">'+esc(status)+'</span>')+icon('right')+'</span></button>';
  }
  function activityContent(){
    const groups=new Map();
    // Keep every receipt, but show each conversation once in the default history.
    for(const event of [...saved.activity].sort((a,b)=>(b.time||0)-(a.time||0))){
      if(!groups.has(event.id))groups.set(event.id,[]);
      groups.get(event.id).push(event);
    }
    const attention=[],working=[],handoffs=[],active=new Set(),workingIDs=typeof workspaceNavigation!=='undefined'&&workspaceNavigation.workingSessions?new Set(workspaceNavigation.workingSessions().map(s=>s.id)):null;
    for(const session of state.sessions){
      const questions=state.decisions.filter(q=>q.session===session.id);
      if(questions.length){attention.push(...questions.map(question=>activityRow({session,question,status:'Needs input',kind:'input'})));active.add(session.id);continue}
      if(session.state==='Failed' && groups.get(session.id)?.[0].kind==='failure')continue;
      if(['Needs input','Awaiting agent','Ready to send','Failed','Interrupted'].includes(session.state)){
        attention.push(activityRow({session,status:session.state,kind:session.state==='Failed'?'failure':'input'}));active.add(session.id);
      }else{
        const capture=state.captures.find(c=>c.session===session.id),sending=capture?.kind==='Session nudge'&&['Queued','Running'].includes(capture.receipt);
        const externalSend=session.state==='Running'&&sending&&(capture.external||session.external);
        if(['Queued','Opening'].includes(session.state)||externalSend){
          handoffs.push(activityRow({session,status:externalSend?'Sending follow-up':session.state,kind:'handoff'}));active.add(session.id);
        }else if(session.available!==false&&session.state==='Running'&&(!workingIDs||workingIDs.has(session.id))){
          working.push(activityRow({session,status:'Working',kind:'working'}));active.add(session.id);
        }
      }
    }
    const reports=[];
    for(const [id,events] of groups){
      const latest=events[0],session=sess(id),failure=latest.kind==='failure';
      const row=activityRow({session,event:latest,status:failure?'Handoff failed':latest.kind==='answer'?'Answer ready':'Report received',kind:failure?'failure':'report',count:events.length});
      const previous=events.slice(1).map(event=>activityRow({session,event,status:event.kind==='failure'?'Handoff failed':event.kind==='answer'?'Answer ready':'Report received',kind:event.kind==='failure'?'failure':'report'})).join('');
      const history=previous?'<details class="activity-history" data-activity-history="'+attr(id)+'"><summary>'+events.length+(events.some(e=>e.kind==='answer')?' updates':' reports')+icon('down')+'</summary><div>'+previous+'</div></details>':'';
      const item='<article class="activity-conversation" data-activity-session="'+attr(id)+'">'+row+history+'</article>';
      if(failure&&!active.has(id))attention.push(item);else reports.push(item);
    }
    const section=(name,rows,kind)=>rows.length?'<section class="activity-section" data-activity-section="'+kind+'"><div class="activity-section-heading"><h3>'+name+'</h3><span>'+rows.length+'</span></div><div class="activity-rows">'+rows.join('')+'</div></section>':'';
    const summary=[working.length?working.length+' working':'',handoffs.length?handoffs.length+' handoff'+(handoffs.length===1?'':'s'):'',attention.length?attention.length+' need'+(attention.length===1?'s':'')+' attention':''].filter(Boolean).join(' · ');
    return (summary?'<p class="activity-summary" role="status">'+esc(summary)+'</p>':'')+section('Needs your attention',attention,'attention')+section('Working now',working,'working')+section('Handoffs',handoffs,'handoffs')+section(saved.activity.some(a=>a.kind==='answer')?'Answers and reports':'Reports',reports,'reports')||'<div class="activity-empty">'+icon('check')+'<strong>You’re all caught up</strong><p>Active tasks, questions and reports appear here.</p></div>';
  }
  function refreshActivity(){
    const root=$('#activity-feed');if(!root)return;
    const content=activityContent();if(root.activityContent===content)return;
    const opened=[...root.querySelectorAll('[data-activity-history][open]')].map(el=>el.dataset.activityHistory),focus=root.contains(document.activeElement)?document.activeElement:null;
    const target=focus?.closest('[data-action]'),history=focus?.closest('[data-activity-history]'),scroll=$('#modal').scrollTop;
    root.innerHTML=content;root.activityContent=content;
    for(const id of opened)root.querySelector('[data-activity-history="'+CSS.escape(id)+'"]')?.setAttribute('open','');
    if(target)[...root.querySelectorAll('[data-action]')].find(el=>el.dataset.action===target.dataset.action&&el.dataset.id===target.dataset.id)?.focus({preventScroll:true});
    else if(history)root.querySelector('[data-activity-history="'+CSS.escape(history.dataset.activityHistory)+'"] summary')?.focus({preventScroll:true});
    $('#modal').scrollTop=scroll;
  }
  function activity(){
    saved.activity.forEach(a=>{if(a.kind!=='answer')a.read=true});persist();
    dialog('Activity','Across your projects','<div id="activity-feed"></div>');refreshActivity();
    renderNav(listedProjects(activeSessions()));
  }
  function details(id){const t=terminals.get(id),s=sess(id);if(!t&&!s)return;dialog(s?sessionDisplayName(s):t.title,'Session details','<p class="hint">'+esc(t?.cwd||proj(s?.project)?.folder||'')+'</p>'+sessionObservation.details(id)+'<div class="inline">'+(s?button('Conversation details','deck-conversation',id,'btn'): '')+(t?.running?button('Stop session…','deck-stop',id,'btn','stop'):'')+'</div>')}
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
    const b=e.target.closest('[data-action]');if(!b?.dataset.action.startsWith('deck-'))return;const a=b.dataset.action.replace(/^deck-tool-/,'deck-'),id=b.dataset.id;
    if(a==='deck-reload'){if(live)postLive('workspace-appearance');else toast('Ghostty settings are read by the Mac app.')}
    else if(a==='deck-open'){dismissCard();const t=terminals.get(id),s=sess(id);if(t)open('terminal:'+id,ensureProject(t).id);else if(s?.host==='tasktap')open('terminal:'+id,s.project);else showSession(id)}
    else if(a==='deck-terminal')startTerminal(id,b.closest('.deck-group')?.dataset.groupId);
    else if(a==='deck-compose'){const en=engines.get(id);if(en)terminalInput.compose(en.term,label('terminal:'+id),()=>engines.get(id)===en&&terminals.get(id)?.running!==false&&(!live||connected&&en.attached&&!en.replaying))}
    else if(a==='deck-tab'){const l=layout(activeProject);l.selected=Number(b.dataset.group);l.groups[l.selected].active=id;renderProject(proj(activeProject));persist();const en=engines.get(termID(id));en?.term.focus()}
    else if(a==='deck-close')requestClose(id);
    else if(a==='deck-background'){dismissCard();background(id)}
    else if(a==='deck-close-stop'){
      dismissCard();const pending=pendingStarts.get(id),project=pending?.project||projectFor(terminals.get(id)?.cwd)?.id||activeProject;
      closingSessions.set(id,project);intentionalStops.add(id);if(pending)pending.closed=true;
      if(live){send('stop',{id});toast('Stopping session…')}else{const t=terminals.get(id);if(t)Object.assign(t,{running:false,stopped:true});finishCloseSession(id)}
    }
    else if(a==='deck-workspace-stop'){dismissCard();stopWorkspace(id)}
    else if(a==='deck-split-right'||a==='deck-split-down')split(id,a==='deck-split-right'?'x':'y',b.closest('.deck-group')?.dataset.groupId);
    else if(a==='deck-close-workspace')closeWorkspace(id);
    else if(a==='deck-move'){
      const l=layout(activeProject),from=l.groups.find(g=>g.tabs.includes(id));
      dialog('Move tab','Choose a surface','<div class="stack">'+l.groups.map((g,i)=>g===from?'':button('Surface '+(i+1)+' / '+(g.active?label(g.active):'Empty surface'),'deck-move-to',g.id,'note','side')).join('')+'</div>');
      $('#modal').dataset.moveSurface=id;
    }
    else if(a==='deck-move-to'){
      const key=$('#modal').dataset.moveSurface,l=layout(activeProject),from=l.groups.find(g=>g.tabs.includes(key)),to=l.groups.find(g=>g.id===id);
      if(from&&to&&from!==to){dismissCard();moveTab(activeProject,key,to.id)}
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
    else if(a==='deck-copy'||a==='deck-paste')clipboardCommand(a==='deck-copy'?'copy':'paste',false,id);
    else if(a==='deck-text-increase'||a==='deck-text-decrease'||a==='deck-text-reset'){resizeText(id,a==='deck-text-increase'?1:a==='deck-text-decrease'?-1:0);engines.get(id)?.term.focus()}
    else if(a==='deck-result')openResult(id);
    else if(a==='deck-conversation')showSession(id);
    else if(a==='deck-stop')dialog('Stop this session?','Terminal process','<p>This ends the process. Its captured output remains available until the terminal service exits.</p><div class="form-actions">'+button('Keep running','close')+button('Stop session','deck-stop-confirm',id,'primary','stop')+'</div>');
    else if(a==='deck-stop-confirm'){intentionalStops.add(id);send('stop',{id});dismissCard()}
    else if(a==='deck-find'){dialog('Find in terminal',label('terminal:'+id),'<form id="deck-find-form" class="stack"><label class="field">Search<input id="deck-find-text" type="search"></label><button class="primary" type="submit">Find next</button><p id="deck-find-state" role="status"></p></form>');$('#deck-find-form').onsubmit=e=>{e.preventDefault();$('#deck-find-state').textContent=engines.get(id)?.search.findNext($('#deck-find-text').value)?'Match highlighted in the terminal.':'No match in the available scrollback.'}}
    else if(a==='deck-preferences')preferences();
    else if(a==='deck-reconnect')send('reconnect');
    else if(a==='deck-notes')dialog('Project notes',proj(id)?.name,noteList(state.notes.filter(n=>n.project===id)));
    else if(a==='deck-history')dialog('Project history',proj(id)?.name,sessionList(state.sessions.filter(s=>s.project===id)));
    else if(a==='deck-activity')activity();
  });
  window.addEventListener('blur',()=>requestAnimationFrame(()=>{const frame=document.activeElement,preview=frame?.tagName==='IFRAME'?frame.closest('.deck-floating'):null,pane=preview?projects.get(activeProject)?.querySelector('.deck-group[data-group-id="'+CSS.escape(preview.dataset.groupId)+'"]'):null;if(pane&&activeProject){const l=layout(activeProject);l.selected=Number(pane.dataset.group);const root=projects.get(activeProject);root.querySelectorAll('.deck-group').forEach(n=>n.classList.toggle('selected',n===pane));update(proj(activeProject),root);persist()}}));
  document.addEventListener('keydown',e=>{const tab=e.target.closest('.deck-tab');if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const tabs=[...tab.closest('.deck-tabs').querySelectorAll('.deck-tab')],index=tabs.indexOf(tab),next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length;const key=tabs[next].dataset.id;tabs[next].click();const selected=projects.get(activeProject)?.querySelector('.deck-tab[aria-selected="true"][data-id="'+CSS.escape(key)+'"]');selected?.focus()});
  // Capture before xterm or the web view can interpret these as input or page zoom.
  document.addEventListener('keydown',e=>{
    if(e.metaKey&&!e.ctrlKey&&!e.altKey&&!e.shiftKey&&!e.isComposing&&['c','v'].includes(e.key.toLowerCase())&&clipboardCommand(e.key.toLowerCase()==='c'?'copy':'paste',true)){
      e.preventDefault();e.stopPropagation();return;
    }
    const change=textSizeShortcut(e);if(change===null||!activeProject||document.querySelector('dialog[open]'))return;
    if(e.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')&&!e.target.closest('.deck-terminal'))return;
    const l=layout(activeProject),id=termID(l.groups[l.selected]?.active);
    if(!id||!engines.has(id))return;
    e.preventDefault();e.stopPropagation();resizeText(id,change);
  },true);
  document.addEventListener('keydown',e=>{if(!activeProject||document.querySelector('dialog[open]'))return;const key=layout(activeProject).groups[layout(activeProject).selected]?.active;if(e.metaKey&&e.key.toLowerCase()==='d'&&!e.altKey){e.preventDefault();split(activeProject,e.shiftKey?'y':'x');return}if(e.metaKey&&e.key.toLowerCase()==='w'&&key){e.preventDefault();requestClose(key)}if(e.metaKey&&e.key.toLowerCase()==='f'&&termID(key)){e.preventDefault();projects.get(activeProject)?.querySelector('[data-action="deck-find"][data-id="'+termID(key)+'"]')?.click()}if(e.metaKey&&e.key.toLowerCase()==='k'){e.preventDefault();go('sessions');$('#session-filter')?.focus()}});
  function outcome(e){if(e.recovered)return;const s=sess(e.session);if(!s)return;if(e.state==='Failed'&&(terminals.get(s.id)?.stopped||intentionalStops.has(s.id)||saved.closedWorkspaces[s.project]||closingWorkspaces.has(s.project)))return;if(e.state==='Complete')notify('complete',s.id,sessionDisplayName(s),e.message||'The agent reported a result.','result:'+e.capture,e.capture);else if(e.state==='Failed')notify('failure',s.id,sessionDisplayName(s),e.message||'The task could not be completed.','failed:'+e.capture)}
  function closeFront(){if(!activeProject)return false;const l=layout(activeProject),key=l.groups[l.selected]?.active;if(!key)return false;requestClose(key);return true}
  function openTerminal(id){if(window.tasktapSurface==='notch'){postLive('workspace-open-terminal',{id});return}const t=terminals.get(id);if(t)open('terminal:'+id,ensureProject(t).id);else if(saved.background[id])open('terminal:'+id,saved.background[id])}
  function terminalText(id){const term=engines.get(id)?.term;if(!term)return '';const buffer=term.buffer.active;return Array.from({length:buffer.length},(_,i)=>buffer.getLine(i)?.translateToString(true)||'').join('\n')}
  function terminalMetrics(id){
    const en=engines.get(id),screen=en?.element.querySelector('.xterm-screen');if(!screen)return null;
    const outer=en.element.getBoundingClientRect(),style=getComputedStyle(en.element),rect=screen.getBoundingClientRect(),pane=en.element.closest('.deck-surface')?.getBoundingClientRect();
    const top=outer.top+parseFloat(style.paddingTop),left=outer.left+parseFloat(style.paddingLeft),bottom=outer.bottom-parseFloat(style.paddingBottom),right=outer.right-parseFloat(style.paddingRight);
    const buffer=en.term.buffer.active;
    return {screenReaderMode:en.term.options.screenReaderMode,fontSize:en.term.options.fontSize,rows:en.term.rows,cols:en.term.cols,viewport:{width:innerWidth,height:innerHeight},pane:pane?{top:pane.top,left:pane.left,bottom:pane.bottom,right:pane.right}:null,content:{top,left,bottom,right},screen:{top:rect.top,left:rect.left,bottom:rect.bottom,right:rect.right},firstLine:buffer.getLine(buffer.viewportY)?.translateToString(true)||'',lastLine:buffer.getLine(buffer.viewportY+en.term.rows-1)?.translateToString(true)||''};
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
      if(file.sourceLine&&node.previewText!==undefined){const lines=node.previewText.split('\n'),index=Math.max(0,Math.min(lines.length-1,Number(file.sourceLine)-1)),mark=document.createElement('mark');mark.textContent=lines[index]||' ';source.replaceChildren(document.createTextNode(lines.slice(0,index).join('\n')+(index?'\n':'')),mark,document.createTextNode(index+1<lines.length?'\n'+lines.slice(index+1).join('\n'):''));requestAnimationFrame(()=>mark.scrollIntoView({block:'center'}))}
    }
  }
  function textLoaded(id,text){const node=previews.get('media:'+id),file=saved.media[id];if(node&&file){node.previewText=text;paintDocument(node,file)}}
  function shellHistory(filter=''){const rows=[...terminals.values()].filter(t=>t.kind==='shell'&&[t.title,t.cwd].join(' ').toLowerCase().includes(filter.toLowerCase()));return rows.length?'<section class="block"><h2>Terminals</h2>'+rows.map(t=>button(t.title+' / '+(t.running?'Running':t.restored?'Not running':t.stopped?'Stopped':'Exited')+' / '+t.cwd,'deck-open',t.id,'note','sessions')).join('')+'</section>':''}
  function openResult(id){if(window.tasktapSurface==='notch'){postLive('workspace-open-result',{id});return}const result=report(id);for(const item of saved.activity)if(item.capture===id||!item.capture&&item.id===id)item.read=true;if(result.session){dismissCard();open('result:'+id,result.session.project)}else if(result.event){dialog('Agent report',proj(result.event.project)?.name||'Tasktap','<article class="result-reader"><p class="result-task">'+esc(result.event.title||'Agent report')+'</p><div class="result-prose"></div></article>');workspaceDocuments.render($('#modal .result-prose'),result.text,{project:result.event.project,cwd:proj(result.event.project)?.folder});persist()}}
  // Restore an explicit layout without automatically starting any process.
  function sidebarData(){return {layouts:saved.layouts,terminals:[...terminals.values()],background:saved.background,cue:sessionCue,label,icon:surfaceIcon}}
  if(typeof appAppearance!=='undefined')appAppearance.receiveGhostty(inherited);
  applyAppearance();
  return {openWorkspace,closeWorkspace,prepareLaunch,sidebarData,accessibilityChanged,appearanceLoaded,pdfLoaded,openTerminal,terminalText,terminalMetrics,shellHistory,textLoaded,receive,renderProject,leave,addFiles,openWeb,open,openResult,outcome,closeFront,preferences,activity,refreshActivity,clipboardCommand};
})();

if(location.hash!=='#geometry')render();
