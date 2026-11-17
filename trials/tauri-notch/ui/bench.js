// Pass-through measurements, shared by the Tauri trial and the Swift (1.2-style) host.
const tauri=!!window.__TAURI__, MB=1024*1024;
const post=m=>webkit.messageHandlers.bench.postMessage(m);
const status=t=>document.getElementById('status').textContent=t;
const decode64=s=>{if(Uint8Array.fromBase64)return Uint8Array.fromBase64(s);const b=atob(s),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u};
let sink=()=>{}, echoed=()=>{};
// 1.2's terminal path: Swift awaits callAsyncJavaScript("return await receive(events)") per batch.
window.receive=async events=>{for(const e of events)sink(decode64(e.data).length);return true};
window.echo=k=>echoed(k);

async function push(name,size,frames,start){
  const total=size*frames;let got=0;
  const done=new Promise((resolve,reject)=>{sink=n=>{got+=n;if(got>=total)resolve()};setTimeout(()=>reject(new Error('timeout')),90000)});
  status(name+' '+size);
  const t0=performance.now();
  try{await start();await done}catch(e){return {name,size,frames,error:String(e),got}}
  const s=(performance.now()-t0)/1000;
  return {name,size,frames,mb:+(total/MB).toFixed(2),ms:+(s*1000).toFixed(1),mbps:+(total/MB/s).toFixed(1),framesPerSec:Math.round(frames/s)};
}
// A key event in the page, through the host and back. WKWebView clamps performance.now() to 1 ms,
// so each sample times 10 sequential round trips; timing starts inside the keydown handler.
const keyOnce=once=>new Promise(resolve=>{
  const handler=async()=>{document.removeEventListener('keydown',handler);await once('a');resolve()};
  document.addEventListener('keydown',handler);
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'a'}));
});
async function keys(name,once,samples=100,batch=10,warm=5){
  const per=[];
  for(let s=0;s<samples+warm;s++){
    const t=performance.now();
    for(let i=0;i<batch;i++)await keyOnce(once);
    if(s>=warm)per.push((performance.now()-t)/batch);
  }
  per.sort((a,b)=>a-b);
  const at=q=>+per[Math.min(per.length-1,Math.floor(q*per.length))].toFixed(3);
  return {name,trips:samples*batch,meanMs:+(per.reduce((a,b)=>a+b,0)/per.length).toFixed(3),medianMs:at(.5),p95Ms:at(.95)};
}
const viaEcho=send=>k=>new Promise(r=>{echoed=r;send(k)});
const sizes=[[512,20000],[65536,2048]];

async function runTauri(){
  const {invoke,Channel}=window.__TAURI__.core, {listen}=window.__TAURI__.event;
  const out=[];
  for(const [size,frames] of sizes){
    out.push(await push('tauri-channel-raw',size,frames,async()=>{const ch=new Channel();ch.onmessage=m=>sink(m.byteLength??m.length);await invoke('push_channel',{frames,size,sink:ch})}));
    let un=await listen('frame',e=>sink(e.payload.length));
    out.push(await push('tauri-event-json-array',size,Math.min(frames,size>4096?64:frames),()=>invoke('push_event',{frames:Math.min(frames,size>4096?64:frames),size,encoding:'json'})));un();
    un=await listen('frame',e=>sink(decode64(e.payload).length));
    out.push(await push('tauri-event-base64',size,frames,()=>invoke('push_event',{frames,size,encoding:'base64'})));un();
    out.push(await push('tauri-protocol-fetch-per-frame',size,frames,async()=>{for(let i=0;i<frames;i++)sink((await (await fetch('trial://localhost/bytes?n='+size)).arrayBuffer()).byteLength)}));
  }
  out.push(await push('tauri-protocol-one-streamed-response',65536,2048,async()=>{const r=(await fetch('trial://localhost/bytes?n='+65536*2048)).body.getReader();for(;;){const {done,value}=await r.read();if(done)break;sink(value.length)}}));
  const un=await listen('echo',e=>echoed(e.payload));
  const k=[await keys('tauri-invoke-return',k=>invoke('key',{k})),await keys('tauri-invoke-then-event',viaEcho(k=>invoke('key_event',{k})))];un();
  return {host:'tauri',push:out,keys:k};
}
async function runSwift(){
  const out=[];
  for(const [size,frames] of sizes){
    out.push(await push('swift-callAsyncJavaScript-awaited (1.2)',size,frames,()=>post({type:'push',size,frames,awaited:true})));
    out.push(await push('swift-callAsyncJavaScript-unawaited',size,frames,()=>post({type:'push',size,frames,awaited:false})));
  }
  const k=[await keys('swift-postMessage-then-callAsyncJavaScript (1.2)',viaEcho(k=>post({type:'key',k}))),
    await keys('swift-postMessage-with-reply',k=>webkit.messageHandlers.benchReply.postMessage({k}))];
  return {host:'swift',push:out,keys:k};
}
addEventListener('load',async()=>{
  const data=await (tauri?runTauri():runSwift());
  data.userAgent=navigator.userAgent;data.hidden=document.hidden;data.visibility=document.visibilityState;
  data.reducedTransparencyQuery=matchMedia('(prefers-reduced-transparency: reduce)').media!=='not all';
  status('done');
  tauri?window.__TAURI__.core.invoke('report',{kind:'bench',data}):post({type:'report',data});
});
