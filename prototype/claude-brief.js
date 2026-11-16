// The user submits the capture inside their installed Claude Code. Importing a
// finished reply is an explicit review action tied to that one conversation.
const claudeBrief=(()=>{
  function prompt(text){
    return 'Prepare a faithful work package for a separate project agent, in my language. Resolve repetition, filler and self-corrections; later corrections win. State the desired outcome, concrete changes, constraints and verification when warranted. Keep simple requests short. Do not invent requirements or resolve uncertain references without evidence. Return just the brief; leave the work for the project agent.\n\n'+text;
  }
  function show(d){
    const p=d.claudeBrief??={id:uid(),opened:false,busy:false,text:'',error:''};
    const paste=p.opened;
    dialog(paste?'Review Claude’s brief':'Draft with Claude Code','Tasktap',
      '<div id="claude-brief" class="fields"><p class="hint">'+(paste?
        'After Claude replies, bring the brief back here. You can edit it before choosing the project agent.':
        'Open Claude Code in Terminal, then paste and send your request. Press ⌃ ⌥ Space to bring the reply back.')+'</p>'+
      (paste?'<label class="field" for="claude-brief-text">Project brief<textarea id="claude-brief-text" maxlength="16000" placeholder="Paste a brief or get Claude’s reply"></textarea></label>'+
        '<button type="button" class="text-btn" id="brief-import">Get Claude’s reply</button>':
        '<p class="prep-account">'+esc(aiConnections.payer('claude-session'))+'</p><details class="route-evidence"><summary>Request to copy</summary><p class="body-copy">'+esc(prompt(d.text))+'</p></details>')+
      '<p id="brief-status" class="hint" role="status"></p><div class="form-actions"><button type="button" class="btn" id="brief-original">Use original request</button>'+
      '<button type="button" class="primary" id="brief-next">'+(paste?'Review handoff':'Copy & open Claude Code')+'</button></div></div>');
    const next=$('#brief-next'),input=$('#claude-brief-text'),get=$('#brief-import'),status=$('#brief-status');
    function controls(){
      next.disabled=p.busy || (paste && !p.text.trim());
      if(get)get.disabled=p.busy;
      status.textContent=p.busy?(paste?'Reading this conversation…':'Opening Terminal…'):p.error;
    }
    if(input){
      input.value=p.text;
      input.oninput=()=>{p.text=input.value;p.error='';controls()};
      get.onclick=()=>{p.busy=true;p.requestedText=p.text;controls();postLive('prepare-reply',{id:p.id})};
    }
    $('#brief-original').onclick=()=>{delete d.claudeBrief;d.routingSource='local';routingPrompt()};
    next.onclick=()=>{
      if(paste){
        d.brief=p.text.trim();d.preparedBrief=d.brief;delete d.suggestedBrief;d.routingSource='claude-session';
        delete d.claudeBrief;routingPrompt();
      }else{
        p.busy=true;p.error='';controls();postLive('prepare-open',{id:p.id,prompt:prompt(d.text)});
      }
    };
    controls();
  }
  function receive(id,opening,result){
    const p=draft?.claudeBrief;
    if(!p || p.id!==id)return;
    p.busy=false;p.error=result.error || '';
    if(opening && !p.error){
      p.opened=true;
      draft.directPreparation={account:aiConnections.payer('claude-session')};
      // Keep Terminal unobstructed. The capture shortcut returns to this brief.
      if($('#modal[open] #claude-brief') && firstMode()){
        $('#modal').close();showHome(false);return;
      }
    }else if(!opening && result.brief && p.requestedText===p.text){
      p.text=result.brief;
    }
    if($('#modal[open] #claude-brief'))show(draft);
  }
  function resume(notch=false){
    if(!draft?.claudeBrief?.opened)return false;
    if(notch){
      document.body.classList.add('notch-first');homeMode='closed';drawHome();
    }
    show(draft);updateBounds(true);postHost('focus-capture');
    $('#claude-brief-text')?.focus({preventScroll:true});
    return true;
  }
  return {show,receive,resume};
})();
