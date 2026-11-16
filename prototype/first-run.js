// The notch keeps the project and shortcut still while the existing microphone wave and
// handoff rail reflect real events. Compact layouts wrap the actions and Reduce Motion uses the stills.
const firstRun = {
  projectsReady:false,
  visible:false,
  selected:'',
  text:'',
  hasVoice:false,
  liveSessions:new Set(),

  project() {
    if (!this.projectsReady) return null;
    const folders=state.projects.filter(p=>p.available===true);
    return folders.find(p=>p.id===this.selected)
      || folders.find(p=>['tasktap','tapped'].includes(p.name.toLowerCase()))
      || folders.find(p=>p.id===state.captures[0]?.project) || folders[0];
  },
  open(replay=false) {
    if (!replay && (document.querySelector('dialog[open]') || !firstMode())) return;
    if (replay) {delete state.firstRun;this.text='';this.hasVoice=false;persist()}
    if (state.firstRun?.done) {showWorkspace();return}
    const guide=state.firstRun, last=byId(state.captures,guide?.nudge || guide?.capture);
    if(guide?.session && (last?.receipt==='Complete' || ['Complete','Closed','Unavailable'].includes(sess(guide.session)?.state))){
      state.firstRun={done:true};this.visible=false;persist();showWorkspace();return;
    }
    this.visible=live;
    showHome();
  },
  finish() {
    this.visible=false;
    this.text='';this.hasVoice=false;
    state.firstRun={done:true};
    persist();showHome(false);
  },
  choosing() {
    homeMode='pinned';
    const folders=state.projects.filter(p=>p.available===true);
    dialog('Choose a project','','<label class="field">Find a project<input type="search" id="guide-filter"></label><div class="route-list" id="guide-projects"></div>','Back to capture');
    const input=$('#guide-filter');
    const list=()=>{$('#guide-projects').innerHTML=folders.filter(p=>p.name.toLowerCase().includes(input.value.toLowerCase()))
      .map(p=>surfaceButton(p.name,'guide-project','folder','surface-button',p.id)).join('') || '<p class="hint">No matching folders.</p>'};
    input.oninput=list;list();input.focus();
  },
  capture() {
    const id=state.firstRun?.session;
    if (id) {
      if (!this.liveSessions.has(id) || !canNudge(sess(id))) {toast('Waiting for the original session.');return}
      captureDraft(id);
    } else {
      const project=this.project();
      if (!project) {workspaceNavigation.openChooser();return}
      captureDraft('',project.id,this.text);
      draft.hasVoice=this.hasVoice;
      draft.suggestedProject=this.selected!==project.id;
    }
    draft.guide=id?'nudge':'start';
    if (!id) {
      if (this.text.trim()) reviewDraft();
      return;
    }
    editDraft();
    const field=$('#transcript');
    field.placeholder='Write a follow-up…';
    field.focus({preventScroll:true});
  },
  accepted(d,c) {
    if (d.guide==='start') {
      this.text='';this.hasVoice=false;
      if(d.mode==='note'){bindGuideComposer();return false}
      state.firstRun=d.mode==='nudge'?{session:c.session,nudge:c.id}:{session:c.session,capture:c.id};
    }
    else if (d.guide==='nudge' && d.mode==='nudge' && c.session===state.firstRun?.session) state.firstRun.nudge=c.id;
    else return false;
    this.visible=true;
    return true;
  },
  content() {
    if (!this.visible || !firstMode() || homeMode==='closed' || (pending() && homeMode!=='pinned')) return '';
    const guide=state.firstRun, project=this.project();
    const question=pending()?surfaceButton('Review decision','requests','checks','workspace-link',pending().id):'';
    if (!guide?.session) {
      const collapse=surfaceButton('','collapse','down','collapse-button');
      if (!project) return '<header class="home-meta"><h1 class="guide-title">'+(this.projectsReady?'Add a project':'Finding your projects…')+'</h1>'+collapse+'</header>'+
        (this.projectsReady?'<p class="home-idle">Open a folder to start your first workspace.</p>'+button('Open workspace…','workspace-chooser','','voice-trigger','folder'):'')+question;
      const examples=['Explain this project.','Find the entry point.','List the next steps.'];
      return '<div class="guide-project-row"><button class="guide-project-button" data-surface="guide-choose" title="Choose a project">'+icon('folder')+'<span>'+esc(project.name)+'</span>'+icon('down')+'</button><span class="guide-study" aria-hidden="true">'+TasktapArt.markup('miniature','glyph')+'</span>'+collapse+'</div>'+
        '<form id="guide-compose"><div class="guide-editor"><textarea id="guide-input" aria-label="Your request" placeholder="'+attr(examples[0])+'" rows="2" required></textarea>'+
        '<div class="example-slot" aria-hidden="true">'+examples.map(line=>'<span>'+esc(line)+'</span>').join('')+'</div></div>'+
        '<div class="guide-actions"><button type="button" class="guide-dictate" data-action="dictate" data-id="#guide-input" title="Hold this button or Control + Option + Space to dictate">'+icon('mic')+'Hold to talk <kbd>⌃⌥Space</kbd></button>'+
        '<button type="submit" class="voice-trigger" title="Review request (⌘ Return)">Review '+icon('arrow')+'</button></div></form>'+question;
    }
    const s=sess(guide.session), initial=byId(state.captures,guide.capture), nudge=byId(state.captures,guide.nudge);
    const available=this.liveSessions.has(guide.session) && s?.available===true;
    const receipt=nudge || initial;
    const failed=receipt?.receipt==='Failed', closed=['Closed','Unavailable'].includes(s?.state);
    const hasResult=!!s?.result, complete=receipt?.receipt==='Complete' || (closed && hasResult);
    if(complete || closed){
      this.visible=false;this.text='';this.hasVoice=false;state.firstRun={done:true};persist();
      return '';
    }
    const copied=nudge?.receipt==='Copied', delivered=nudge?.receipt==='Delivered';
    const agent=providers[s?.agent] || 'Agent', terminal=s && sessionLocation(s);
    let title='Opening '+(terminal || 'your session'), hint='';
    if (failed) {
      title=nudge?'Follow-up failed':'Session failed to start';
    } else if (s?.host==='claude-desktop' && receipt?.receipt==='Prepared') {
      title='Brief ready in Claude Desktop';hint='Confirm the project folder and send in Claude. Activity and replies stay there.';
    } else if (copied) {
      title='Nudge copied';hint='Paste at the agent prompt and press Return.';
    } else if (delivered) {
      title='Nudge delivered';hint='Your follow-up reached the same conversation.';
    } else if (nudge) {
      title='Sending your nudge';hint='Waiting for a delivery receipt.';
    } else if (available && s.state==='Needs input') {
      title=agent+' needs input';
      hint=s.waitingFor || (question?'':'Check the prompt in '+terminal+'.');
    } else if (available && s.agent==='claude' && !canNudge(s)) {
      title='Opening Claude Code';
      hint='If Claude asks whether you trust this folder, answer in '+terminal+'.';
    } else if (available) {
      title=s.state==='Running'?agent+' is working':s.startup==='confirmed'?agent+' connected':'Session open in '+terminal;
    }
    let actions='';
    if (available) {
      const label=s.source==='desktop'?'Open in ChatGPT':s.host==='warp'?'Reattach in Warp':'Open in '+terminal;
      actions+=button(label,s.source==='desktop'?'openchat':'focus-session',s.id,'voice-trigger','out');
      if ((!nudge || failed) && canNudge(s)) actions+=surfaceButton('Nudge session','guide-type','pen','surface-button');
    }
    if (!nudge && failedStart(s)) actions+=button('Review & retry','review-retry',s.id,'voice-trigger');
    if (failed && s) actions+=button('Session details','session',s.id,'surface-button');
    return '<header class="home-meta"><h1 class="guide-title">'+esc(title)+'</h1>'+surfaceButton('Done','guide-finish','','workspace-link')+'</header><p class="guide-session">'+esc([proj(s?.project)?.name,providers[s?.agent],terminal].filter(Boolean).join(' / '))+'</p>'+
      (hint?'<p class="home-idle">'+esc(hint)+'</p>':'')+(actions || question?'<div class="guide-actions">'+actions+question+'</div>':'');
  }
};

// Reattach only when the home card is replaced. Background updates with identical
// markup leave the live editor, selection and input method composition alone.
function bindGuideComposer(){
  const form=$('#guide-compose');
  if(!form)return;
  const input=$('#guide-input',form), review=form.querySelector('[type=submit]');
  input.value=firstRun.text;
  const changed=()=>{firstRun.text=input.value;review.disabled=!input.value.trim();if(review.disabled)firstRun.hasVoice=false};
  changed();
  input.oninput=changed;
  form.onsubmit=e=>{
    e.preventDefault();
    if(review.disabled)return;
    if(recording?.target==='#guide-input'){
      recording.reviewAfter=true;
      finishDictation(recording.owner);
    }else firstRun.capture();
  };
  input.onkeydown=e=>{
    if(e.key==='Enter' && e.metaKey && !e.isComposing){e.preventDefault();if(!review.disabled)form.requestSubmit()}
  };
}
