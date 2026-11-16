// Two native renderers share durable records; the workspace owns disk and PTY layout.
const sharedState = (() => {
  const role=window.tasktapSurface;
  const enabled=role==='workspace'||role==='notch';
  const collections=new Set(['projects','sessions','captures','notes','decisions']);
  let baseline=JSON.parse(JSON.stringify(state)),applying=false;
  const copy=value=>JSON.parse(JSON.stringify(value));
  function publish(){
    if(!enabled||applying)return;
    const patch={};
    for(const key of new Set([...Object.keys(baseline),...Object.keys(state)])){
      if(key==='workspaceDeck'&&role==='notch'){
        const current=state.workspaceDeck?.preferences;
        if(current&&JSON.stringify(current)!==JSON.stringify(baseline.workspaceDeck?.preferences))patch.workspacePreferences={value:copy(current)};
        continue;
      }
      if(JSON.stringify(state[key])===JSON.stringify(baseline[key]))continue;
      if(collections.has(key)&&Array.isArray(state[key])){
        const before=new Map((baseline[key]||[]).map(row=>[row.id,JSON.stringify(row)]));
        const ids=new Set(state[key].map(row=>row.id));
        patch[key]={upsert:state[key].filter(row=>before.get(row.id)!==JSON.stringify(row)),remove:[...before.keys()].filter(id=>!ids.has(id))};
      }else patch[key]=Object.hasOwn(state,key)?{value:copy(state[key])}:{remove:true};
    }
    baseline=copy(state);
    if(Object.keys(patch).length)window.webkit?.messageHandlers?.workspace?.postMessage({type:'shared-state',patch});
  }
  function apply(patch){
    if(!enabled||!patch||typeof patch!=='object')return;
    applying=true;
    try{
      for(const [key,change] of Object.entries(patch)){
        if(['__proto__','constructor','prototype'].includes(key)||!change||typeof change!=='object')continue;
        if(key==='workspacePreferences'){
          if(state.workspaceDeck)Object.assign(state.workspaceDeck.preferences??={},copy(change.value));
        }else if(collections.has(key)&&Array.isArray(change.upsert)&&Array.isArray(change.remove)){
          const replacements=new Map(change.upsert.map(row=>[row.id,copy(row)]));
          const removed=new Set(change.remove),existing=new Set((state[key]||[]).map(row=>row.id));
          state[key]=[...change.upsert.filter(row=>!existing.has(row.id)&&!removed.has(row.id)).map(copy),...(state[key]||[]).filter(row=>!removed.has(row.id)).map(row=>replacements.get(row.id)||row)];
        }else if(change.remove)delete state[key];
        else if(Object.hasOwn(change,'value')){
          if(key==='workspaceDeck'&&state.workspaceDeck)Object.assign(state.workspaceDeck,copy(change.value));
          else state[key]=copy(change.value);
        }
      }
      baseline=copy(state);
      if(role==='workspace')localStorage.setItem(storageKey,JSON.stringify(state));
      if(typeof appAppearance!=='undefined')appAppearance.setTheme(state.appearanceTheme);
      if(typeof render==='function')render();
    }finally{applying=false;baseline=copy(state)}
  }
  function snapshot(value){
    const patch={};for(const [key,item] of Object.entries(value||{}))patch[key]={value:item};
    // A bootstrap replaces collection contents; ordinary traffic uses entity deltas.
    for(const key of collections)if(Array.isArray(value?.[key]))patch[key]={upsert:value[key],remove:(state[key]||[]).filter(row=>!value[key].some(v=>v.id===row.id)).map(row=>row.id)};
    apply(patch);
  }
  return {publish,apply,snapshot};
})();
