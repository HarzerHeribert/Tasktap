/* One palette owns the application chrome and terminal colors. Shell startup and
   terminal typography remain independent of the chosen application theme. */
const appAppearance = (() => {
  const choices=[
    {id:'ghostty',name:'Follow Ghostty',detail:'Your terminal colors'},
    {id:'dark',name:'Midnight',detail:'Quiet, neutral dark'},
    {id:'light',name:'Daylight',detail:'Soft, clear light'},
    {id:'system',name:'System',detail:'Follow this Mac'},
    {id:'ocean',name:'Ocean',detail:'Deep blue'},
    {id:'dusk',name:'Dusk',detail:'Soft violet'},
    {id:'ember',name:'Ember',detail:'Warm charcoal'},
    {id:'rose',name:'Rose',detail:'Soft rose light'}
  ];
  const darkTheme={background:'#111318',foreground:'#e4e6ed',cursor:'#e4e6ed',selectionBackground:'#38455d',selectionForeground:'#ffffff',black:'#23262e',red:'#f18b93',green:'#9bcba7',yellow:'#e9c387',blue:'#a4bbef',magenta:'#c8a8e9',cyan:'#8dcbd1',white:'#d9dce5',brightBlack:'#727989',brightRed:'#ffabb1',brightGreen:'#b3e0bc',brightYellow:'#f4d6a7',brightBlue:'#bdcefa',brightMagenta:'#dcc2f4',brightCyan:'#ace0e4',brightWhite:'#ffffff'};
  const lightTheme={background:'#f5f6f8',foreground:'#252933',cursor:'#252933',selectionBackground:'#cddcf3',selectionForeground:'#1a2940',black:'#353a44',red:'#a53645',green:'#356d49',yellow:'#876018',blue:'#315fa5',magenta:'#79509d',cyan:'#26737a',white:'#d9dce2',brightBlack:'#68707e',brightRed:'#b53b4c',brightGreen:'#397952',brightYellow:'#906b23',brightBlue:'#3c6daf',brightMagenta:'#875ca9',brightCyan:'#287f88',brightWhite:'#ffffff'};
  // Each colorway has its own canvas, selection and complete ANSI palette. UI
  // accents are separate so a warm theme still renders terminal blue as blue.
  const colorThemes={
    ocean:{accent:'#8ab9f1',terminal:{
      background:'#0e1928',foreground:'#dce8f6',cursor:'#acd3ff',selectionBackground:'#294664',selectionForeground:'#f3f8ff',
      black:'#1c2b40',red:'#f199a3',green:'#a1cdb4',yellow:'#e2c393',blue:'#8ab9f1',magenta:'#bea6e7',cyan:'#84cdd5',white:'#cbd9e9',
      brightBlack:'#74889f',brightRed:'#ffb3bb',brightGreen:'#bbdfc7',brightYellow:'#f2d8ad',brightBlue:'#b0d1ff',brightMagenta:'#d7bff4',brightCyan:'#a8e1e6',brightWhite:'#f4f8ff'
    }},
    dusk:{accent:'#c4a6ef',terminal:{
      background:'#20192d',foreground:'#eee5f7',cursor:'#d5b4f5',selectionBackground:'#4b365e',selectionForeground:'#faf4ff',
      black:'#30253f',red:'#ee9cb1',green:'#a8c9ad',yellow:'#e5c399',blue:'#a9b5ed',magenta:'#d5a9e8',cyan:'#9acbd5',white:'#dcd1e8',
      brightBlack:'#92809f',brightRed:'#ffb6c7',brightGreen:'#c2ddc0',brightYellow:'#f3d9b5',brightBlue:'#c4cdf7',brightMagenta:'#e9c5f7',brightCyan:'#b8e1e6',brightWhite:'#fcf5ff'
    }},
    ember:{accent:'#e8aa86',terminal:{
      background:'#241b19',foreground:'#f3e6db',cursor:'#f1b791',selectionBackground:'#574038',selectionForeground:'#fff5eb',
      black:'#372b29',red:'#f39d8f',green:'#b8c59b',yellow:'#e6c38e',blue:'#a5b9d7',magenta:'#d5adca',cyan:'#9fc8c5',white:'#dfd3cb',
      brightBlack:'#a28a80',brightRed:'#ffb5a5',brightGreen:'#cbd9b0',brightYellow:'#f5d7a5',brightBlue:'#bed0e8',brightMagenta:'#e7c4dc',brightCyan:'#b5ded7',brightWhite:'#fff5eb'
    }},
    rose:{accent:'#9c4868',terminal:{
      background:'#fbf2f3',foreground:'#4a3038',cursor:'#8b3f5b',selectionBackground:'#e4cbd6',selectionForeground:'#4a3038',
      black:'#4b3740',red:'#a53851',green:'#42715e',yellow:'#87622e',blue:'#4b64a0',magenta:'#94528a',cyan:'#36757f',white:'#d8c9cf',
      brightBlack:'#846b76',brightRed:'#b83c59',brightGreen:'#3c7960',brightYellow:'#906526',brightBlue:'#526eaf',brightMagenta:'#a25096',brightCyan:'#307f87',brightWhite:'#ffffff'
    }}
  };
  const media=matchMedia('(prefers-color-scheme: dark)');
  const validColor=value=>typeof value==='string' && /^#[\da-f]{6}$/i.test(value);
  const color=(value,fallback)=>validColor(value)?value.toLowerCase():fallback;
  const channels=value=>[1,3,5].map(i=>parseInt(value.slice(i,i+2),16));
  const mix=(a,b,ratio)=>'#'+channels(a).map((v,i)=>Math.round(v+(channels(b)[i]-v)*ratio).toString(16).padStart(2,'0')).join('');
  const luminance=value=>channels(value).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
  function legible(value,background,ratio=4.5){
    const target=luminance(background)<.25?'#ffffff':'#111318';
    for(let i=0;i<=20;i++){const candidate=mix(value,target,i/20);if(contrast(candidate,background)>=ratio)return candidate}
    return target;
  }
  let ghostty=state.workspaceDeck?.appearance || null;
  let effective;
  if(!choices.some(item=>item.id===state.appearanceTheme))state.appearanceTheme='ghostty';
  function terminalTheme(id=state.appearanceTheme){
    if(colorThemes[id])return {...colorThemes[id].terminal};
    const base=id==='light' || id==='system' && !media.matches?lightTheme:darkTheme;
    if(id!=='ghostty')return {...base};
    const result={...darkTheme};
    if(ghostty?.source!=='Ghostty')return result;
    for(const key of Object.keys(result))result[key]=color(ghostty.theme?.[key],result[key]);
    if(validColor(ghostty.theme?.cursorAccent))result.cursorAccent=ghostty.theme.cursorAccent.toLowerCase();
    const extended=ghostty.theme?.extendedAnsi;
    if(Array.isArray(extended)&&extended.length===240&&extended.every(validColor))result.extendedAnsi=extended.map(value=>value.toLowerCase());
    return result;
  }
  function palette(theme,id=state.appearanceTheme){
    const bg=theme.background,fg=legible(theme.foreground,bg,7),dark=luminance(bg)<.25;
    const edge=mix(bg,fg,dark?.15:.17),raised=mix(bg,fg,dark?.055:.025);
    const accent=legible(colorThemes[id]?.accent||theme.blue,bg),accentInk=contrast(accent,'#111318')>contrast(accent,'#ffffff')?'#111318':'#ffffff';
    return {
      bg,fg,surface:mix(bg,fg,.025),raised,sidebar:mix(bg,fg,dark?.035:.025),overlay:mix(bg,fg,dark?.065:.018),input:dark?mix(bg,fg,.035):'#ffffff',
      muted:legible(mix(bg,fg,.67),mix(bg,fg,.12)),subtle:legible(mix(bg,fg,.52),mix(bg,fg,.12)),edge,'edge-strong':mix(bg,fg,.3),hover:mix(bg,fg,.07),selected:mix(bg,fg,.105),
      accent,'accent-ink':accentInk,'accent-soft':mix(bg,accent,.13),positive:legible(theme.green,bg),warning:legible(theme.yellow,bg),negative:legible(theme.red,bg),
      shadow:dark?'#00000066':'#17203424'
    };
  }
  function apply(){
    const theme=terminalTheme(),dark=luminance(theme.background)<.25;
    effective={id:state.appearanceTheme,dark,background:theme.background,foreground:theme.foreground,terminalTheme:theme};
    const root=document.documentElement;
    root.dataset.appearance=effective.id;root.dataset.appearanceMode=dark?'dark':'light';
    root.style.colorScheme=dark?'dark':'light';
    const main=palette(theme),notch=palette({...theme,background:'#090a0b',foreground:dark?theme.foreground:'#e4e6ed'});
    for(const [key,value] of Object.entries(main))root.style.setProperty('--app-'+key,value);
    for(const [key,value] of Object.entries(notch))root.style.setProperty('--app-notch-'+key,value);
    document.querySelector('meta[name=color-scheme]')?.setAttribute('content',dark?'dark':'light');
    syncPreferences();
    document.dispatchEvent(new CustomEvent('appearance-changed',{detail:current()}));
  }
  function current(){return {...effective,terminalTheme:{...effective.terminalTheme}}}
  function setTheme(id){
    if(!choices.some(item=>item.id===id))return;
    state.appearanceTheme=id;persist();apply();
  }
  function receiveGhostty(profile){
    if(!profile || typeof profile!=='object')return;
    ghostty=profile;
    if(state.appearanceTheme==='ghostty')apply();else syncPreferences();
  }
  function description(){
    if(state.appearanceTheme==='ghostty')return ghostty?.source==='Ghostty'?'Ghostty’s colors, throughout Tasktap.':'Uses Ghostty’s colors when available. Midnight is the fallback.';
    if(state.appearanceTheme==='system')return 'Follows your Mac’s '+(media.matches?'dark':'light')+' appearance.';
    return 'One palette for your workspace, terminals, and preferences.';
  }
  function markup(){
    const prefs=state.workspaceDeck?.preferences || {};
    return '<fieldset class="appearance-choices"><legend>Application theme</legend><div class="appearance-grid">'+choices.map(item=>{
      const theme=terminalTheme(item.id),p=palette(theme,item.id);
      return '<label class="appearance-choice"><input type="radio" name="app-theme" value="'+item.id+'" '+(item.id===state.appearanceTheme?'checked':'')+'><span class="appearance-preview" aria-hidden="true" style="--sample-bg:'+p.bg+';--sample-fg:'+p.fg+';--sample-sidebar:'+p.sidebar+';--sample-edge:'+p.edge+';--sample-accent:'+p.accent+'"><i></i><span><b></b><b></b><b></b></span><em>✓</em></span><strong>'+item.name+'</strong><small>'+item.detail+'</small></label>';
    }).join('')+'</div><p class="hint" id="appearance-description" role="status">'+description()+'</p></fieldset>'+
      '<div class="appearance-window"><label class="policy-switch" for="appearance-translucent"><span>Translucent window</span><input id="appearance-translucent" type="checkbox" '+(prefs.translucent!==false?'checked':'')+'></label>'+
      '<label class="policy-switch" for="appearance-blur"><span>Blur the background</span><input id="appearance-blur" type="checkbox" '+(prefs.blur!==false?'checked':'')+' '+(prefs.translucent===false?'disabled':'')+'></label><p class="hint">A subtle macOS backdrop. Respects Reduce Transparency.</p></div>';
  }
  function syncPreferences(){
    document.querySelectorAll('input[name=app-theme]').forEach(input=>input.checked=input.value===state.appearanceTheme);
    const status=document.getElementById('appearance-description');if(status)status.textContent=description();
    const blur=document.getElementById('appearance-blur');if(blur)blur.disabled=state.workspaceDeck?.preferences?.translucent===false;
    document.querySelectorAll('.appearance-choice').forEach(choice=>{
      const input=choice.querySelector('input'),preview=choice.querySelector('.appearance-preview'),p=palette(terminalTheme(input.value),input.value);
      for(const key of ['bg','fg','sidebar','edge','accent'])preview.style.setProperty('--sample-'+key,p[key]);
    });
  }
  function bind(){
    document.querySelectorAll('input[name=app-theme]').forEach(input=>input.onchange=()=>{if(input.checked)setTheme(input.value)});
    for(const key of ['translucent','blur']){
      const input=document.getElementById('appearance-'+key);
      if(input)input.onchange=()=>{
        state.workspaceDeck??={layouts:{},media:{},preferences:{},activity:[],seen:{}};
        state.workspaceDeck.preferences??={};state.workspaceDeck.preferences[key]=input.checked;
        persist();apply();
      };
    }
  }
  media.addEventListener('change',()=>{if(state.appearanceTheme==='system')apply();else syncPreferences()});
  apply();
  return {current,receiveGhostty,setTheme,markup,bind};
})();
