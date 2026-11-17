// Readable evidence accompanies the handoff. The changing text is the model's draft brief.
function workspaceEvidence(d) {
  if(d.routeMatch && d.routeMatch.project===d.project && (!d.routeMatch.session || d.routeMatch.session===d.session))return 'Matched from context / '+d.routeMatch.reason;
  if (d.session) return 'Existing conversation / '+(sess(d.session)?.task || 'Selected session');
  if (d.sessionProject && d.project===d.sessionProject) return 'Chosen workspace / '+proj(d.project).name;
  const name=proj(d.project)?.name;
  if (name && matchProjects(d.text).some(p=>p.id===d.project)) return 'Named in capture / '+name;
  if (name || d.project==='@new') return 'Destination / '+(name || d.newName);
  return 'Workspace still needs a match.';
}

function activityBand(titleMarkup, caption, active, receiptArt) {
  const art=receiptArt || (active ? TasktapArt.markup('miniature') : '<img src="'+attr(TasktapArt.poster(TasktapArt.current(),'miniature'))+'" alt="">');
  return '<div class="activity-band"><div class="activity-copy">'+titleMarkup+'<span class="activity-caption">'+esc(caption)+'</span></div><div class="activity-art" aria-hidden="true">'+art+'</div></div>';
}

function routingActivityCard(d) {
  const checking=d.routing?.provider && d.routing.provider!=='local'?'Waiting for '+aiConnections.label(d.routing.provider)+'…':'Checking the on-device model…';
  dialog('Preparing handoff','Tasktap',
    '<section id="route-activity" aria-label="Routing activity">'+activityBand('<strong id="route-phase" role="status">'+esc(checking)+'</strong>',workspaceEvidence(d),true)+
    '<p class="activity-brief" id="partial-brief" hidden></p></section>'+
    '<div class="form-actions">'+button('Review now','skip-routing')+'</div>');
  updateSignal();
}

function routingProgress(id,event) {
  if (draft?.routing?.id!==id || !$('#route-activity')) return;
  const phase=$('#route-phase');
  if (event.phase==='generating') {
    phase.textContent='On-device model is preparing the brief';
    narrateRoute(draft,'preparing','I’m preparing the handoff on this Mac.');
  }
  if (event.phase==='brief' && typeof event.brief==='string') {
    phase.textContent='Draft from the on-device model';
    const preview=$('#partial-brief');
    preview.textContent=event.brief;
    preview.hidden=false;
  }
  if(event.phase==='matching')phase.textContent='Matching the project and conversation';
}

function cancelRouting() {
  if (!draft?.routing) return;
  if (live) postLive('cancel-route',{id:draft.routing.id});
  delete draft.routing;
  draft.routingSource='skipped';
  updateSignal();
}

function routingEvidence(d) {
  const source={
    'local-match':'Tasktap matched the explicit destination correction on this Mac. The original request is preserved.',
    apple:d.routeFallback?'Apple’s on-device model prepared the task. Destination preparation did not finish; choose the conversation.':'Apple’s on-device model prepared the task and checked the supplied destination context on this Mac.',
    estimate:'Apple’s on-device model estimated the scope of your selected task.',
    unavailable:'Apple’s on-device model is unavailable. Tasktap used local matching.',
    fallback:'The model couldn’t finish this handoff. Tasktap used local matching.',
    skipped:d.remoteAttempts?.length?'You stopped waiting for the remote request. Tasktap used local matching.':'You skipped the model call. Tasktap used local matching.'
  }[d.routingSource] || (d.remoteAttempts?.length && !['local','skipped','error'].includes(d.routingSource)?aiConnections.label(d.routingSource)+' prepared the handoff.':'Tasktap used local matching.');
  const evidence=[source,workspaceEvidence(d)];
  if (d.reference?.value) evidence.push('Reference / '+d.reference.app+' / '+d.reference.value);
  if(d.mode==='ask' && d.workerReason)evidence.push(d.workerReason);
  const plan=d.noPick?null:modelPlanFor(d);
  if (plan) evidence.push(plan.reason);
  return evidence;
}
function reviewActivity(d) {
  const plan=d.noPick?null:modelPlanFor(d);
  const name=d.mode==='nudge'?sess(d.session)?.task:d.project==='@new'?d.newName:proj(d.project)?.name;
  const action={ask:'Start a new session',nudge:'Send a follow-up',note:'Save a note'}[d.mode];
  const sentence=[action+(name?' in '+name:'')+'.',plan?.mode==='curve'?modelTiers[plan.tier]+' task. '+plan.label+'. '+plan.reason:'',d.brief].filter(Boolean).join(' ');
  if(!d.noPick)narrateRoute(d,'review',[d.usingRank?d.workerReason:'',sentence].filter(Boolean).join(' '));
}

let routingSpeaker=null;
function narrateRoute(d,phase,sentence) {
  if ((d.guide && !d.hasVoice) || !state.speakRouting || !(state.voiceEngine ?? siriVoices[0]?.id) || recording) return;
  const key=phase+' '+sentence;
  if (d.lastNarration===key) return;
  d.lastNarration=key;
  routingSpeaker=d;
  readAloud(sentence.slice(0,700));
}
function stopRoutingSpeech() {
  if (!routingSpeaker) return;
  routingSpeaker=null;
  if (live) postLive('stopSpeech');
  else window.speechSynthesis?.cancel();
}
function routingVoicePreference() {
  const line=document.createElement('label');
  line.className='check-line';
  line.innerHTML='<input id="routing-narration" type="checkbox"> Read routing updates and the final handoff aloud';
  const completion=$('#narration').parentNode;
  completion.after(line);
  line.firstChild.checked=!!state.speakRouting;
  line.firstChild.onchange=e=>{state.speakRouting=e.target.checked;persist();if (!state.speakRouting) stopRoutingSpeech()};
}
