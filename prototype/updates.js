/* Native Sparkle owns discovery, installation and its confirmation dialogs. */
const appUpdates=(()=>{
  let state={available:false,version:'',automatic:true,readyToRestart:false};
  function receive(snapshot){
    state={available:snapshot.available===true,version:String(snapshot.version||''),automatic:snapshot.automatic===true,readyToRestart:snapshot.readyToRestart===true};
    const badge=document.getElementById('app-update-badge');
    if(badge){
      badge.hidden=!live||!state.available;
      badge.title=state.readyToRestart?'Install Tasktap '+state.version+' and restart':'Review Tasktap '+state.version+' update';
      badge.setAttribute('aria-label',state.readyToRestart?'Update ready to restart, version '+state.version:'Update available, version '+state.version);
      badge.querySelector('.label').textContent=state.readyToRestart?'Restart to update':'Update available';
    }
    const setting=document.getElementById('automatic-updates');
    if(setting)setting.checked=state.automatic;
  }
  function preferences(){
    return live?'<label class="check-line update-preference"><input type="checkbox" id="automatic-updates" '+(state.automatic?'checked':'')+'>Automatically check for updates</label><p class="hint update-help">An update badge appears when a new version is ready. Installation and restart need your confirmation.</p>':'';
  }
  document.addEventListener('change',event=>{
    if(event.target.id==='automatic-updates'&&live)postLive('automatic-updates',{enabled:event.target.checked});
  });
  return {receive,preferences};
})();
