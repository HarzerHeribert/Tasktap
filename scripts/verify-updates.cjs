const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('prototype/app.js','utf8').split('function prepareForAppUpdate(){')[1].split('const recoveredUpdateDraft=')[0];
let saved;
const context={setupWizard:{showing:()=>false},document:{querySelector:()=>null},recording:null,draft:{text:'Keep this request',project:'p',strokes:[[1,2]]},localStorage:{setItem:(k,v)=>saved=JSON.parse(v)},persist:()=>{}};
vm.createContext(context);vm.runInContext('function prepareForAppUpdate(){'+source,context);
assert.equal(context.prepareForAppUpdate(),true);assert.equal(saved.text,'Keep this request');assert.equal(saved.strokes.length,1);
for(const field of ['routing','submitting']){context.draft[field]=true;assert.equal(context.prepareForAppUpdate(),false);context.draft[field]=false}
context.recording={};assert.equal(context.prepareForAppUpdate(),false);
context.recording=null;context.localStorage.setItem=()=>{throw Error('Storage full')};assert.equal(context.prepareForAppUpdate(),false);
console.log('Update restart guards and draft persistence passed.');

context.recording=null;context.draft={text:'hello'};context.setupWizard.showing=()=>true;
assert.equal(context.prepareForAppUpdate(),false);
context.setupWizard.showing=()=>false;context.document.querySelector=()=>({value:'unfinished voice capture'});
assert.equal(context.prepareForAppUpdate(),false);
let recovered,removed=false;
const restore={localStorage:{getItem:()=>JSON.stringify({text:'recover me',project:'p',strokes:[[1,2]]}),removeItem:()=>removed=true},setTimeout:f=>f(),proj:()=>true,captureDraft:(a,p,t)=>{restore.draft={text:t,project:p}},editDraft:()=>{recovered=restore.draft},draft:null};
vm.createContext(restore);vm.runInContext('const recoveredUpdateDraft='+fs.readFileSync('prototype/app.js','utf8').split('const recoveredUpdateDraft=')[1],restore);
assert.equal(recovered.text,'recover me');assert.equal(recovered.sketch,true);assert.equal(removed,true);
console.log('Setup guard and draft recovery passed.');
