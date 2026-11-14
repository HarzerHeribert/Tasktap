// The chooser uses the actual application icons installed on this Mac.
const terminalHosts=(()=>{
  const catalog={
    terminal:{name:'Terminal',detail:'Included with macOS'},
    cmux:{name:'cmux',detail:'Named workspace; requires cmux socket access for Tasktap'},
    ghostty:{name:'Ghostty',detail:'Interactive terminal window'},
    iterm2:{name:'iTerm2',detail:'Addressable terminal session'},
    warp:{name:'Warp',detail:'Reattach to the same agent in a new tab'},
    wezterm:{name:'WezTerm',detail:'Addressable terminal pane'},
    kitty:{name:'kitty',detail:'Dedicated terminal window'}
  };
  let icons=null;
  const label=host=>host==='desktop'?'ChatGPT':catalog[host]?.name || 'Terminal';
  function options(selected){
    return Object.entries(catalog).map(([id,item])=>{
      const present=icons===null || Object.hasOwn(icons,id);
      return '<option value="'+id+'" '+(id===selected?'selected ':'')+(!present?'disabled ':'')+
        'data-detail="'+attr(present?item.detail:'Not installed on this Mac')+'">'+esc(item.name)+'</option>';
    }).join('');
  }
  function receive(found){
    const same=icons && Object.keys(found).length===Object.keys(icons).length && Object.keys(found).every(key=>found[key]===icons[key]);
    if (same)return;
    icons=found;
    const input=$('#session-host,#handoff-host,#setup-host');
    if (!input) return;
    const saved=input.value;
    if(input.getAttribute('aria-expanded')==='true')settingsPickers.close();
    input.innerHTML=options(saved);
    settingsPickers.sync(input);
  }
  function mark(host){
    const iconURL=icons?.[host];
    return iconURL?.startsWith('data:image/png;base64,')?'<img class="terminal-app-icon" alt="" src="'+attr(iconURL)+'">':'<span aria-hidden="true" class="terminal-app-icon terminal-placeholder">'+icon('sessions')+'</span>';
  }
  return {label,mark,receive,options,valid:host=>Object.hasOwn(catalog,host)};
})();
