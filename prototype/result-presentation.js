/* Reports remain the agent's words. A short preview never replaces the original. */
const resultPresentation=(()=>{
  function excerpt(text,limit=80){
    const original=String(text||'').trim(),words=[...original.matchAll(/\S+/gu)];
    if(words.length<=limit)return {text:original,shortened:false};
    const prefix=original.slice(0,words[limit].index).trim(),boundary=prefix.lastIndexOf('\n\n');
    // Prefer a complete paragraph to cutting a list or sentence in half.
    const paragraph=boundary>0?prefix.slice(0,boundary).trim():'';
    return {text:paragraph.split(/\s+/).length>=15?paragraph:prefix+'…',shortened:true};
  }
  function markup(text,id,action='read-report'){
    const preview=excerpt(text);
    return '<section class="result-summary"><div class="result-summary-heading"><h3>Agent summary</h3>'+(preview.shortened?'<span class="hint">Excerpt</span>':'')+'</div><div class="result-excerpt" data-report-preview="'+attr(preview.text)+'"></div>'+button('Read full report',action,id,'text-btn','right')+'</section>';
  }
  function render(element,text){workspaceDocuments.render(element,text,{})}
  function paint(root){root.querySelectorAll('[data-report-preview]').forEach(element=>{render(element,element.dataset.reportPreview);delete element.dataset.reportPreview})}
  function show(id){
    const capture=byId(state.captures,id),session=sess(capture?.session||id);
    const text=capture?capture.result:session?.result;if(!text)return;
    const title=session?sessionDisplayName(session):'Agent report';
    dialog('Agent report',proj(capture?.project||session?.project)?.name||'Tasktap','<article class="result-reader"><p class="result-task">'+esc(title)+'</p><div class="result-prose"></div><div class="result-reader-actions">'+button('Copy report','copy-report',id,'btn','copy')+(session?button('Read aloud','speak-report',id,'btn','sound')+button('Export summary','export-report',id):'')+'</div></article>');
    render($('#modal .result-prose'),text);
  }
  document.addEventListener('click',async event=>{
    const control=event.target.closest('[data-action]'),action=control?.dataset.action,id=control?.dataset.id;
    if(action==='read-report')show(id);
    if(action==='export-report'){
      const capture=byId(state.captures,id),session=sess(capture?.session||id),text=capture?capture.result:session?.result;
      if(text&&session){if(live)postLive('open-result',{id:session.id,viewer:session.viewer||'Finder',text});else toast('Summary export is available in the Mac app.')}
    }
    if(action==='speak-report'){
      const capture=byId(state.captures,id),text=capture?capture.result:sess(id)?.result;if(text)speak(text);
    }
    if(action==='copy-report'){
      const capture=byId(state.captures,id),text=capture?capture.result:sess(id)?.result;
      if(!text)return;
      if(live){postLive('copy-report',{text});return}
      try{await navigator.clipboard.writeText(text);toast('Report copied.')}catch{toast('Could not copy. Select the report text to copy it.')}
    }
  });
  return {excerpt,markup,render,paint,show};
})();
