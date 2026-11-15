/* Native folder selection is the authority; preferences never grant arbitrary
   paths through an editable web field. Browser fixtures use the same UI. */
const workspaceSettings=(()=>{
  let creationPending=false;
  const current=()=>({root:'~/projects',externalDiscovery:false,...state.workspaceConfiguration});
  const root=()=>current().root.replace(/\/$/,'');
  const newFolder=name=>root()+'/'+String(name||'').trim();
  function receive(config){
    state.workspaceConfiguration={...current(),...config};persist();
    const path=$('#workspace-root-path');if(path)path.textContent=current().root;
    const createRoot=$('#workspace-create-root');if(createRoot)createRoot.textContent=current().root;
    const unavailable=$('#workspace-root-unavailable');if(unavailable)unavailable.hidden=current().rootAvailable!==false;
    const submit=$('#workspace-create-form button[type="submit"]');if(submit)submit.disabled=creationPending||current().rootAvailable===false;
    if($('#workspace-create-form')&&!creationPending)$('#workspace-create-error').textContent=current().rootAvailable===false?'Choose an existing folder before creating a workspace.':'';
    const checkbox=$('#workspace-external-discovery');if(checkbox){checkbox.checked=!!current().externalDiscovery;checkbox.disabled=false}
    document.dispatchEvent(new Event('workspace-settings-changed'));
  }
  function setDiscovery(enabled){
    if(live)postLive('workspace-discovery',{enabled:!!enabled});else receive({...current(),externalDiscovery:!!enabled});
  }
  function markup(){
    return '<div class="workspace-location"><div><strong>Default workspace folder</strong><p class="hint">New workspaces are created here. You can open existing folders from anywhere.</p></div><div class="workspace-location-path"><code id="workspace-root-path">'+esc(current().root)+'</code>'+button('Choose…','workspace-root','','btn','folder')+'</div><p id="workspace-root-unavailable" class="hint" '+(current().rootAvailable!==false?'hidden':'')+'>This folder is unavailable. Choose a location for new workspaces.</p></div>'+
      '<div class="workspace-location"><label class="policy-switch" for="workspace-external-discovery"><span>Find sessions in other apps</span><input type="checkbox" id="workspace-external-discovery" '+(current().externalDiscovery?'checked':'')+'></label><p class="hint">Reads local session metadata from supported coding apps. macOS may ask for access. Tasktap terminals work with this turned off.</p></div>'+
      '<p class="hint">Use + in the sidebar to open a workspace. Closing a workspace saves its layout and leaves its terminal sessions running.</p>';
  }
  function bind(){const checkbox=$('#workspace-external-discovery');if(checkbox)checkbox.onchange=()=>{const enabled=checkbox.checked;if(live)checkbox.disabled=true;setDiscovery(enabled)}}
  function create(){
    creationPending=false;
    dialog('New workspace','Workspace','<form id="workspace-create-form" class="stack"><label class="field">Name<input id="workspace-create-name" required autocomplete="off" placeholder="My project"></label><div><p class="hint">Create a folder in</p><div class="workspace-location-path"><code id="workspace-create-root">'+esc(current().root)+'</code>'+button('Choose…','workspace-root','','btn','folder')+'</div></div><p class="hint" id="workspace-create-error" role="status">'+(current().rootAvailable===false?'Choose an existing folder before creating a workspace.':'')+'</p><div class="form-actions">'+button('Cancel','close')+'<button type="submit" class="primary" '+(current().rootAvailable===false?'disabled':'')+'>Create workspace</button></div></form>');
    $('#workspace-create-name').focus();
    $('#workspace-create-form').onsubmit=event=>{
      event.preventDefault();const name=$('#workspace-create-name').value.trim();
      if(creationPending||current().rootAvailable===false)return;
      if(!name||name==='.'||name==='..'||/[\/\\\u0000-\u001f]/.test(name)){$('#workspace-create-error').textContent='Use a folder name without slashes.';return}
      if(live){creationPending=true;$('#workspace-create-form button[type="submit"]').disabled=true;postLive('workspace-create-folder',{name})}
      else opened({name,folder:newFolder(name),available:'true'});
    };
  }
  function opened(row){
    creationPending=false;
    let project=state.projects.find(p=>p.folder===row.folder);
    if(!project){project={id:row.folder,aliases:[]};state.projects.push(project)}
    Object.assign(project,row,{available:row.available!==false&&row.available!=='false'});
    dismissCard();persist();workspaceDeck.openWorkspace(project.id,true);
  }
  function failed(message){
    creationPending=false;
    const error=$('#workspace-create-error');if(error){error.textContent=message;$('#workspace-create-form button[type="submit"]').disabled=current().rootAvailable===false}else toast(message);
  }
  document.addEventListener('click',event=>{
    const action=event.target.closest('[data-action]')?.dataset.action;
    if(action==='workspace-root'){if(live)postLive('workspace-choose-root');else toast('Choose a workspace folder in the Mac app.')}
  });
  return {current,root,newFolder,receive,setDiscovery,markup,bind,create,opened,failed};
})();
