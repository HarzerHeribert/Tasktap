// Fresh-session preferences live in Tasktap's existing local workspace store.
const modelPresets = {
  claude: { quick: 'haiku', standard: 'sonnet', complex: 'opus' },
  codex: { quick: 'gpt-6-luna', standard: 'gpt-6.1-sol', complex: 'gpt-6-astra' },
  agy: { quick: 'gemini-3.8-flash', standard: 'gemini-4-hydrogen', complex: 'gemini-4-carbon' }
};
const modelTiers = { quick: 'Quick', standard: 'Standard', complex: 'Complex' };

function sessionModelPolicy() {
  const saved = state.sessionModels || {};
  const policy = {
    adaptive: saved.adaptive === true,
    defaultAgent: Object.hasOwn(modelPresets, saved.defaultAgent) ? saved.defaultAgent : 'claude',
    standardAt: Number.isInteger(saved.standardAt) ? Math.max(2, Math.min(9, saved.standardAt)) : 4,
    agents: {}
  };
  policy.complexAt = Number.isInteger(saved.complexAt) ? Math.min(10, Math.max(policy.standardAt + 1, saved.complexAt)) : Math.max(8, policy.standardAt + 1);
  for (const [agent, presets] of Object.entries(modelPresets)) {
    const profile = { fixed: '', ...presets };
    for (const key of Object.keys(profile)) {
      const savedModel = saved.agents?.[agent]?.[key];
      if (typeof savedModel === 'string') profile[key] = savedModel;
    }
    policy.agents[agent] = profile;
  }
  return policy;
}

function taskDifficulty(d) {
  const brief = (d.brief || d.text || '').trim();
  const estimate = d.modelEstimate;
  if (estimate?.brief === brief && Number.isInteger(estimate.score) && estimate.score >= 1 && estimate.score <= 10) {
    const quote = typeof estimate.evidence === 'string' ? estimate.evidence.trim().slice(0, 160) : '';
    if (estimate.origin) return {score:estimate.score,reason:'Scope estimated by '+estimate.origin+'.'};
    return {score: estimate.score, reason: quote && (brief+' '+d.text).toLowerCase().includes(quote.toLowerCase()) ? 'On-device estimate from “'+quote+'”.' : 'Estimated by the on-device handoff model.'};
  }
  // An explicit, bounded editorial change stays small even if its subject sounds complex.
  if (/\b(typos?|spelling|misspell\w*|rechtschreib\w*|tippfehler)\b/i.test(brief) && !/\b(across|throughout|all files|also|außerdem)\b/i.test(brief)) {
    return { score: 1, reason: 'The brief asks for a spelling correction.' };
  }
  const signals = [
    [8, /\b(migrat\w*|migration\w*|architect\w*|architektur\w*|distributed|race condition|deadlock|concurren\w*|rollback|backwards? compatib\w*|zero.downtime|nebenläufig\w*)\b/i],
    [7, /\b(refactor\w*|profil\w+|integrat\w*|across|system.wide|end.to.end|intermittent|root cause|reproduc\w*|untersuche\w*|ursache)\b/i],
    [5, /\b(implement\w*|build|create|debug\w*|diagnos\w*|test suite|add a feature|entwick\w*|erstell\w*|baue)\b/i],
    [2, /\b(rename|format|locate|summari[sz]e|explain|translate|list|find|umbenenn\w*|übersetz\w*|erklär\w*)\b/i]
  ];
  for (const [base, pattern] of signals) {
    const match = brief.match(pattern);
    if (match) {
      const extra = /\b(and then|as well as|followed by|anschließend|außerdem)\b/i.test(brief) ? 1 : 0;
      return { score: Math.min(10, base + extra), reason: 'Local scope cue: “'+match[0]+'”.' };
    }
  }
  return { score: 4, reason: 'Local estimate for an unspecified scope.' };
}

function modelPlanFor(d) {
  if (!d || d.mode === 'note') return null;
  if (d.mode === 'nudge') return { mode: 'existing', model: '', label: 'Current session model', reason: 'The existing conversation keeps its model.' };
  const policy = sessionModelPolicy();
  const profile = policy.agents[d.agent] || policy.agents[policy.defaultAgent];
  if (d.modelOverride?.agent === d.agent && d.modelOverride.value) {
    return { mode: 'override', model: d.modelOverride.value, label: d.modelOverride.value, reason: 'Selected for this session.' };
  }
  if (!policy.adaptive) return { mode: 'fixed', model: profile.fixed, label: profile.fixed || 'Agent default', reason: profile.fixed ? 'Your fixed model for new sessions.' : 'The agent chooses its configured default.' };
  const estimate = taskDifficulty(d);
  const tier = estimate.score >= policy.complexAt ? 'complex' : estimate.score >= policy.standardAt ? 'standard' : 'quick';
  return { ...estimate, mode: 'curve', tier, model: profile[tier], label: profile[tier] || 'Agent default' };
}

function modelInput(agent, key, value, hint='Agent default') {
  return '<input id="model-'+key+'" type="text" maxlength="250" list="model-choices-'+agent+'" autocapitalize="off" spellcheck="false" value="'+attr(value)+'" placeholder="'+attr(hint)+'">';
}
function modelSuggestions(agent) {
  return '<datalist id="model-choices-'+agent+'">'+Object.values(modelPresets[agent]).map(v=>option(v,v)).join('')+'</datalist>';
}
function modelReviewMarkup(d) {
  const plan = modelPlanFor(d);
  if (!plan) return '';
  const tier = plan.mode === 'curve' ? modelTiers[plan.tier]+' · '+plan.score+'/10 · ' : '';
  return '<p class="hint" id="review-model">'+esc(tier+plan.label)+'</p>';
}

function sessionModelSettings() {
  const policy = sessionModelPolicy();
  let agent = policy.defaultAgent;
  const agents = selected=>Object.entries(providers).map(([id,label])=>'<option value="'+attr(id)+'" data-detail="'+attr(id)+'" '+(id===selected?'selected':'')+'>'+esc(label)+'</option>').join('');
  const defaults=settingsField('default-agent','Default agent','<select id="default-agent">'+agents(policy.defaultAgent)+'</select>');
  const profiles=settingsField('model-agent','Configure models for','<select id="model-agent">'+agents(agent)+'</select>');
  dialog('Session models','Preferences','<form id="session-models" class="settings-form">'+
    '<section class="settings-section">'+defaults+
    settingsField('session-host','Open new sessions in','<select id="session-host">'+terminalHosts.options(state.sessionHost||'terminal')+'</select>')+
    '<label class="policy-switch" for="difficulty-curve"><span>Choose models by task difficulty</span><input id="difficulty-curve" type="checkbox" '+(policy.adaptive?'checked':'')+'></label>'+
    '<div class="curve-controls" id="curve-controls"></div></section>'+
    '<section class="settings-section"><div class="profile-fields">'+profiles+'<div id="model-fields"></div></div>'+
    '<p class="hint">Leave a model field empty to use the agent default. Nudges keep the current session’s model.</p></section>'+
    '<div class="form-actions">'+button('Cancel','prefs')+'<button class="primary" type="submit">Save models</button></div></form>');
  settingsHeader();
  const form = $('#session-models');
  if(live)postLive('terminal-catalog');
  function models() {
    const keys = policy.adaptive ? Object.keys(modelTiers) : ['fixed'];
    const ranges = {quick:'1–'+(policy.standardAt-1),standard:policy.standardAt+'–'+(policy.complexAt-1),complex:policy.complexAt+'–10'};
    form.classList.toggle('is-adaptive',policy.adaptive);
    $('#model-fields',form).innerHTML = keys.map(key=>settingsField('model-'+key,key==='fixed'?'Fixed model':modelTiers[key]+' · '+ranges[key],modelInput(agent,key,policy.agents[agent][key]))).join('')+modelSuggestions(agent);
    settingsPickers.mount($('#model-fields',form));
    for (const key of keys) $('#model-'+key,form).oninput=e=>{policy.agents[agent][key]=e.target.value.trim()};
  }
  function limits() {
    const container = $('#curve-controls',form);
    container.hidden = !policy.adaptive;
    if (!policy.adaptive) { container.innerHTML=''; return; }
    const range = (key,label,low,high)=>'<div class="field"><label for="'+key+'">'+label+'</label><select id="'+key+'">'+Array.from({length:high-low+1},(_,i)=>option(String(i+low),String(i+low),String(policy[key]))).join('')+'</select></div>';
    const segment=score=>score>=policy.complexAt?'complex':score>=policy.standardAt?'standard':'quick';
    container.innerHTML = '<div class="curve-scale" aria-hidden="true">'+Array.from({length:10},(_,i)=>'<span class="tier-'+segment(i+1)+'">'+(i+1)+'</span>').join('')+'</div>'+
      '<div class="threshold-fields">'+range('standardAt','Standard starts at',2,9)+range('complexAt','Complex starts at',policy.standardAt+1,10)+'</div>';
    settingsPickers.mount(container);
    $('#standardAt',form).onchange=e=>{policy.standardAt=Number(e.target.value);policy.complexAt=Math.max(policy.complexAt,policy.standardAt+1);limits();models();$('#standardAt',form).focus()};
    $('#complexAt',form).onchange=e=>{policy.complexAt=Number(e.target.value);limits();models();$('#complexAt',form).focus()};
  }
  $('#default-agent',form).onchange=e=>{policy.defaultAgent=e.target.value;agent=policy.defaultAgent;$('#model-agent',form).value=agent;settingsPickers.sync($('#model-agent',form));models()};
  $('#model-agent',form).onchange=e=>{agent=e.target.value;models()};
  $('#difficulty-curve',form).onchange=e=>{policy.adaptive=e.target.checked;limits();models()};
  form.onsubmit=e=>{e.preventDefault();state.sessionHost=$('#session-host').value;state.sessionModels=policy;persist();prefs();toast('Session models saved.')};
  limits();models();settingsPickers.mount(form);
}
