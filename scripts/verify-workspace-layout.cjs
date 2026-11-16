const assert=require('node:assert/strict');
const {ensure,split,remove}=require('../prototype/workspace-layout.js');
const group=(id,...tabs)=>({id,tabs,active:tabs[0]??null});
const order=layout=>layout.groups.map(group=>group.id);
function inspect(layout){
  const groups=[],branches=[],pending=[layout.tree];
  while(pending.length){
    const node=pending.pop();
    if(node.group)groups.push(node.group);
    else{assert.ok(['x','y'].includes(node.axis));assert.ok(node.ratio>0 && node.ratio<100);branches.push(node.id);pending.push(node.second,node.first)}
  }
  assert.deepEqual(groups,order(layout));assert.equal(new Set(groups).size,groups.length);
  assert.equal(new Set(branches).size,branches.length);
  assert.equal(branches.length,groups.length-1);
  assert.ok(layout.selected>=0 && layout.selected<groups.length);
  return {groups,branches};
}

// Legacy geometry and selected pane survive migration without touching tabs.
const legacy={groups:[group('a','terminal:a','media:notes'),group('b','terminal:b')],selected:1,ratio:37,focus:true};
const firstTabs=legacy.groups[0].tabs;
assert.equal(ensure(legacy),legacy);
assert.equal(legacy.tree.axis,'x');assert.equal(legacy.tree.ratio,37);
assert.deepEqual(legacy.tree.first,{group:'a'});assert.deepEqual(legacy.tree.second,{group:'b'});
assert.equal(legacy.groups[0].tabs,firstTabs);assert.equal(legacy.selected,1);assert.equal(legacy.focus,true);
const migrated=JSON.stringify(legacy);ensure(legacy);assert.equal(JSON.stringify(legacy),migrated,'normalization is idempotent');
inspect(legacy);

// Arbitrarily nested horizontal and vertical splits insert immediately after
// the target in DFS order. Creating geometry never duplicates a terminal tab.
const layout={groups:[group('a','terminal:a')],selected:0};ensure(layout);
const b=split(layout,'a','x','b');assert.deepEqual(b,{id:'b',tabs:[],active:null});
assert.deepEqual(order(layout),['a','b']);assert.equal(layout.groups[layout.selected],b);
const outer=layout.tree.id;
split(layout,'a','y','c');split(layout,'b','y','d');split(layout,'c','x','e');
assert.deepEqual(order(layout),['a','c','e','b','d']);assert.equal(layout.tree.id,outer);
assert.equal(layout.tree.first.axis,'y');assert.equal(layout.tree.first.second.axis,'x');assert.equal(layout.tree.second.axis,'y');
assert.deepEqual(layout.groups.flatMap(group=>group.tabs),['terminal:a']);
inspect(layout);
// Edge drops can insert a new leaf before a target, preserving existing branches.
const edges={groups:[group('target','terminal:t')],selected:0};ensure(edges);
split(edges,'target','x','left','before');
assert.deepEqual(order(edges),['left','target']);assert.equal(edges.tree.first.group,'left');
const edgeRoot=edges.tree.id;edges.tree.ratio=35;
split(edges,'target','y','top','before');
assert.deepEqual(order(edges),['left','top','target']);assert.equal(edges.tree.second.first.group,'top');
assert.equal(edges.tree.id,edgeRoot);assert.equal(edges.tree.ratio,35);inspect(edges);
remove(edges,'left');assert.equal(edges.tree.axis,'y');inspect(edges);
for(let i=0;i<20;i++)split(layout,'d',i%2?'x':'y','extra-'+i);
assert.equal(layout.groups.length,25,'layout has no hardcoded pane count');inspect(layout);
assert.equal(split(layout,'unknown','x','unused'),null);
assert.equal(split(layout,'a','z','unused'),null);
assert.equal(split(layout,'a','x','b'),null,'duplicate IDs are rejected');
assert.equal(split(layout,'a','x',layout.tree.id),null,'pane and divider IDs cannot collide');

// Stored roundtrips retain stable branch IDs, geometry and selected group.
const persisted=JSON.stringify(layout),restored=JSON.parse(persisted);
ensure(restored);assert.equal(JSON.stringify(restored),persisted);inspect(restored);

// Collapsing one split leaves its sibling intact and selects its nearest leaf.
const collapse={groups:[group('one','terminal:one')],selected:0};ensure(collapse);
split(collapse,'one','x','two');split(collapse,'two','y','three');
collapse.groups[1].tabs.push('media:two');ensure(collapse);
const survivor=collapse.tree.first;
assert.equal(remove(collapse,'two').id,'two');assert.deepEqual(order(collapse),['one','three']);
assert.equal(collapse.groups[collapse.selected].id,'three','removing another pane preserves selection');
assert.equal(collapse.tree.first.group,survivor.group);
assert.equal(remove(collapse,'three').id,'three');assert.deepEqual(collapse.tree,{group:'one'});
assert.equal(collapse.selected,0);assert.equal(remove(collapse,'one').id,'one','closing the last surface empties the workspace');assert.deepEqual(collapse.groups,[]);assert.equal(collapse.tree,null);collapse.groups.push(group('one','terminal:one'));ensure(collapse);
split(collapse,'one','x','two');split(collapse,'two','y','three');collapse.selected=0;
remove(collapse,'one');assert.deepEqual(order(collapse),['two','three']);assert.equal(collapse.groups[collapse.selected].id,'two');
assert.equal(collapse.tree.axis,'y');inspect(collapse);

// groups is authoritative when native code or a fixture edits it directly.
const direct={groups:[group('a','terminal:a')],selected:0};ensure(direct);
direct.groups.push(group('b','media:b'));direct.selected=1;ensure(direct);
assert.deepEqual(order(direct),['a','b']);assert.equal(direct.groups[direct.selected].id,'b');
direct.groups=[direct.groups[1]];ensure(direct);assert.deepEqual(direct.tree,{group:'b'});
direct.groups.unshift(group('c','result:c'));direct.selected=0;ensure(direct);
assert.equal(direct.groups[direct.selected].id,'c');assert.deepEqual(direct.groups.flatMap(group=>group.tabs).sort(),['media:b','result:c']);

// Broken trees and duplicate/missing IDs are repaired without losing a tab.
const malformed={groups:[group('duplicate','t:1'),group('duplicate','t:2'),{tabs:['t:3','t:4'],active:'missing'},group('last','t:5')],selected:1,focus:'false',tree:{id:'duplicate',axis:'diagonal',ratio:Infinity,first:{group:'duplicate'},second:{id:'same',axis:'y',ratio:-10,first:{group:'duplicate'},second:{group:'unknown'}}}};
ensure(malformed);inspect(malformed);
assert.deepEqual(malformed.groups.flatMap(group=>group.tabs).sort(),['t:1','t:2','t:3','t:4','t:5']);
assert.equal(malformed.groups[malformed.selected].tabs[0],'t:2');assert.equal(malformed.focus,false);
assert.equal(malformed.groups.find(group=>group.tabs.includes('t:3')).active,'t:3');
const cycle={id:'cycle',axis:'y',ratio:66,first:{group:'a'}};cycle.second=cycle;
const cyclic={groups:[group('a','terminal:a'),group('b','terminal:b')],selected:0,tree:cycle};
ensure(cyclic);inspect(cyclic);assert.deepEqual(cyclic.groups.flatMap(group=>group.tabs),['terminal:a','terminal:b']);
assert.doesNotThrow(()=>JSON.stringify(cyclic),'cyclic input is repaired to serializable geometry');
const reordered={groups:[group('c'),group('b'),group('a')],selected:0,tree:{id:'root',axis:'x',ratio:62,first:{group:'a'},second:{id:'child',axis:'y',ratio:42,first:{group:'b'},second:{group:'c'}}}};
ensure(reordered);assert.deepEqual(order(reordered),['a','b','c']);assert.equal(reordered.selected,2);assert.equal(reordered.tree.ratio,62);inspect(reordered);
const empty={};ensure(empty);assert.equal(empty.groups.length,0);assert.equal(empty.tree,null);assert.equal(empty.selected,0);assert.equal(remove(empty,'missing'),null);
const shared=group('shared','terminal:shared'),aliased={groups:[shared,shared],selected:0};
ensure(aliased);inspect(aliased);assert.equal(aliased.groups.length,2);assert.deepEqual(aliased.groups.flatMap(group=>group.tabs),['terminal:shared','terminal:shared']);
console.log('PASS: legacy migration, 25 nested panes, both axes, stable IDs, empty splits, collapse and focus, persistence, direct group edits, and malformed-tree repair without lost tabs.');
