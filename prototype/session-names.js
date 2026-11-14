// Names describe current work; the original request remains available in session details.
const sessionDisplayName=s=>s.sessionName || s.task;
const sessionNameSearch=s=>[sessionDisplayName(s),s.task,...(s.nameHistory||[]).map(item=>item.name)].join(' ');
function sessionNameHistory(s){
  const names=s.nameHistory||[];
  if(!names.length)return '';
  return '<details class="route-evidence" data-name-history><summary>Past names · '+names.length+'</summary><ul>'+names.slice().reverse().map(item=>'<li><span>'+esc(item.name)+'</span>'+(item.at?'<small class="hint"> · '+esc(new Date(item.at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}))+'</small>':'')+'</li>').join('')+'</ul></details>';
}
function sessionNameChanged(id,name,fingerprint){
  const s=sess(id);if(!s || typeof name!=='string' || name.length<8 || name.length>140)return;
  const normalized=name.trim();
  if(sessionDisplayName(s).toLocaleLowerCase()===normalized.toLocaleLowerCase())return;
  s.nameHistory??=[];
  s.nameHistory.push({name:sessionDisplayName(s),at:s.namedAt||0});
  s.sessionName=normalized;s.namedAt=Date.now();s.nameFingerprint=fingerprint;
  persist();render();
  if(openedSession===id && $('#modal[open] .session-detail')){
    $('#dialog-heading').textContent=sessionDisplayName(s);
    const previous=$('#modal [data-name-history]');
    const open=previous?.open;
    if(previous)previous.outerHTML=sessionNameHistory(s);
    else $('#modal .session-detail').insertAdjacentHTML('beforeend',sessionNameHistory(s));
    if(open)$('#modal [data-name-history]').open=true;
  }
}
function inheritSessionNames(session,row,previous){
  if(session.sessionName || !row.conversation)return;
  const prior=previous.filter(s=>s.agent===row.agent && (s.conversation===row.conversation || s.id===row.conversation)).sort((a,b)=>(b.namedAt||0)-(a.namedAt||0))[0];
  if(!prior)return;
  session.sessionName=prior.sessionName;session.namedAt=prior.namedAt;
  session.nameFingerprint=prior.nameFingerprint;
  session.nameHistory=(prior.nameHistory||[]).map(item=>({...item}));
}
