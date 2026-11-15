/* Serializable pane geometry, independent of rendering and terminal ownership.
   groups is authoritative: repairing a tree must never discard a group's tabs. */
const workspaceLayout=(()=>{
  const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
  const identifier=value=>typeof value==='string' && value.trim().length>0;
  const ratio=value=>typeof value==='number' && Number.isFinite(value)?Math.min(99,Math.max(1,value)):50;
  let sequence=0;
  function fresh(used){
    let id;
    do{id=globalThis.crypto?.randomUUID?.() || 'pane-'+Date.now().toString(36)+'-'+(++sequence).toString(36)}while(used.has(id));
    used.add(id);return id;
  }
  function leaves(tree){
    const result=[],pending=[tree];
    while(pending.length){const node=pending.pop();if(node.group)result.push(node.group);else pending.push(node.second,node.first)}
    return result;
  }
  function branch(used,first,second,axis='x',splitRatio=50){return {id:fresh(used),axis,ratio:ratio(splitRatio),first,second}}
  function ensure(layout){
    if(!object(layout))throw new TypeError('A workspace layout must be an object.');
    if(!Array.isArray(layout.groups))layout.groups=[];
    if(!layout.groups.length)layout.groups.push({tabs:[],active:null});
    const selectedIndex=Number.isInteger(layout.selected)?Math.max(0,Math.min(layout.selected,layout.groups.length-1)):0;
    const ids=new Set(),groupObjects=new WeakSet();
    layout.groups=layout.groups.map(value=>{
      const group=object(value)?groupObjects.has(value)?{...value,tabs:Array.isArray(value.tabs)?[...value.tabs]:value.tabs}:value:{tabs:[],active:null};
      groupObjects.add(group);
      if(!identifier(group.id) || ids.has(group.id))group.id=fresh(ids);else ids.add(group.id);
      if(!Array.isArray(group.tabs))group.tabs=group.tabs==null?[]:[group.tabs];
      if(!group.tabs.includes(group.active))group.active=group.tabs[0]??null;
      return group;
    });
    const selected=layout.groups[selectedIndex];
    const groups=new Map(layout.groups.map(group=>[group.id,group])),used=new Set(ids),seen=new WeakSet(),placed=new Set();
    // Postorder repair also handles cyclic in-memory edits without recursion or
    // a pane-count limit. Missing groups are reattached below, never dropped.
    let tree=null;
    const pending=[{node:layout.tree,assign:value=>tree=value}];
    while(pending.length){
      const task=pending.pop(),node=task.node;
      if(task.finish){
        const {first,second}=task.children;
        if(!first || !second){task.assign(first || second || null);continue}
        if(!identifier(node.id) || used.has(node.id))node.id=fresh(used);else used.add(node.id);
        delete node.group;node.axis=node.axis==='y'?'y':'x';node.ratio=ratio(node.ratio);node.first=first;node.second=second;
        task.assign(node);continue;
      }
      if(!object(node) || seen.has(node)){task.assign(null);continue}
      seen.add(node);
      if(groups.has(node.group) && !placed.has(node.group)){
        placed.add(node.group);task.assign({group:node.group});continue;
      }
      const children={first:null,second:null};
      pending.push({...task,finish:true,children});
      pending.push({node:node.second,assign:value=>children.second=value});
      pending.push({node:node.first,assign:value=>children.first=value});
    }
    for(const group of layout.groups){
      if(placed.has(group.id))continue;
      const leaf={group:group.id};
      tree=tree?branch(used,tree,leaf,'x',placed.size===1?layout.ratio:50):leaf;
      placed.add(group.id);
    }
    layout.tree=tree;
    layout.groups=leaves(tree).map(id=>groups.get(id));
    layout.selected=Math.max(0,layout.groups.indexOf(selected));
    layout.focus=layout.focus===true;
    return layout;
  }
  function locate(layout,groupId){
    const pending=[{node:layout.tree,parent:null,side:null}];
    while(pending.length){
      const found=pending.pop(),node=found.node;
      if(node.group===groupId)return found;
      if(!node.group)pending.push({node:node.second,parent:node,side:'second'},{node:node.first,parent:node,side:'first'});
    }
    return null;
  }
  function identifiers(layout){
    const used=new Set(layout.groups.map(group=>group.id)),pending=[layout.tree];
    while(pending.length){const node=pending.pop();if(!node.group){used.add(node.id);pending.push(node.first,node.second)}}
    return used;
  }
  function split(layout,groupId,axis,newId){
    ensure(layout);
    const target=locate(layout,groupId);
    if(!target || !['x','y'].includes(axis))return null;
    const used=identifiers(layout);
    if(newId!==undefined && (!identifier(newId) || used.has(newId)))return null;
    const id=newId??fresh(used);used.add(id);
    const group={id,tabs:[],active:null},replacement=branch(used,target.node,{group:id},axis);
    if(target.parent)target.parent[target.side]=replacement;else layout.tree=replacement;
    layout.groups.push(group);layout.selected=layout.groups.length-1;
    ensure(layout);
    return group;
  }
  function remove(layout,groupId){
    ensure(layout);
    const target=locate(layout,groupId);
    if(!target?.parent)return null;
    const removed=layout.groups.find(group=>group.id===groupId),selected=layout.groups[layout.selected];
    const sibling=target.parent[target.side==='first'?'second':'first'],nearby=leaves(sibling);
    const next=selected===removed?nearby[target.side==='first'?0:nearby.length-1]:selected.id;
    // Replace the parent, collapsing exactly the divider that owned this leaf.
    if(layout.tree===target.parent)layout.tree=sibling;
    else{
      const pending=[layout.tree];
      while(pending.length){
        const node=pending.pop();if(node.group)continue;
        if(node.first===target.parent){node.first=sibling;break}
        if(node.second===target.parent){node.second=sibling;break}
        pending.push(node.first,node.second);
      }
    }
    layout.groups=layout.groups.filter(group=>group!==removed);
    layout.selected=layout.groups.findIndex(group=>group.id===next);
    ensure(layout);
    return removed;
  }
  return {ensure,split,remove};
})();
if(typeof module!=='undefined' && module.exports)module.exports=workspaceLayout;
