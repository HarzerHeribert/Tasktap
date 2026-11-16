/* Native menus reuse the selected workspace's existing controls. */
window.applicationMenu=(()=>{
  function command(action){
    if(action==='menu-home'){showWorkspace();go('overview');return}
    if(action==='menu-notebook'){showWorkspace();go('notes');return}
    if(action==='menu-history'){showWorkspace();go('sessions');return}
    if(action==='menu-activity'){showWorkspace();workspaceDeck.activity();return}
    if(action==='menu-open-workspace'){showWorkspace();workspaceNavigation.openChooser();return}
    if(action==='menu-sidebar'){workspaceNavigation.toggle();return}
    if(!action.startsWith('menu-pane-')||document.querySelector('dialog[open]'))return;
    const project=document.querySelector('.deck-project:not([hidden])');
    if(!project||!document.body.classList.contains('workspace-active'))return;
    const layout=state.workspaceDeck.layouts[view],group=layout?.groups[layout.selected];
    const pane=group?project.querySelector('.deck-group[data-group-id="'+CSS.escape(group.id)+'"]'):project;
    const control={
      'menu-pane-terminal':'deck-terminal','menu-pane-browser':'deck-url',
      'menu-pane-compose':'deck-compose',
      'menu-pane-text-increase':'deck-text-increase','menu-pane-text-decrease':'deck-text-decrease','menu-pane-text-reset':'deck-text-reset',
      'menu-pane-split-right':'deck-split-right','menu-pane-split-down':'deck-split-down'
    }[action];
    if(control)pane?.querySelector('[data-action="'+control+'"]')?.click();
  }
  let previous='';
  function publish(){
    if(window.tasktapSurface==='notch')return;
    const available=document.body.classList.contains('workspace-active')&&!document.querySelector('dialog[open]');
    const value=String(available);
    if(value!==previous){previous=value;postHost('application-menu-state',{workspace:available})}
  }
  new MutationObserver(publish).observe(document.body,{attributes:true,attributeFilter:['class']});
  for(const dialog of document.querySelectorAll('dialog'))new MutationObserver(publish).observe(dialog,{attributes:true,attributeFilter:['open']});
  publish();
  return {command};
})();
