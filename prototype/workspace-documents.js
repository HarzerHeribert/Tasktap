/* Bundled Marked parses Markdown; DOMPurify is the final HTML boundary. */
const workspaceDocuments=(()=>{
  let sequence=0;
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const parser=new marked.Marked({gfm:true,breaks:false,renderer:{
    // Raw HTML is source content, never app UI. In particular, it cannot
    // introduce data-action handlers, styles, frames, or network requests.
    html({text}){return escape(text)},
    link({href,title,tokens}){return '<a data-doc-href="'+escape(href)+'"'+(title?' title="'+escape(title)+'"':'')+'>'+this.parser.parseInline(tokens)+'</a>'},
    image({href,title,text}){return '<img data-doc-src="'+escape(href)+'" alt="'+escape(text)+'"'+(title?' title="'+escape(title)+'"':'')+'>'}
  }});
  function kind(file){return /\.(md|markdown)$/i.test(file?.path||file?.title||'')?'markdown':file?.kind}
  function linkTarget(value,file){
    const href=String(value||'').trim();
    if(!href||/[\u0000-\u001f\u007f\\]/.test(href))return null;
    if(href.startsWith('#')){try{return {kind:'anchor',value:decodeURIComponent(href.slice(1))}}catch{return null}}
    if(/^https?:\/\//i.test(href)){
      try{const url=new URL(href);return url.hostname&&!url.username&&!url.password?{kind:'external',value:url.href}:null}catch{return null}
    }
    if(typeof workspaceLinks!=='undefined'){
      const target=workspaceLinks.target(href);
      if(target&&(target.kind==='app'||target.kind==='file'&&(file?.cwd||/^(?:file:|\/|~\/)/i.test(href)))){
        try{return {kind:'workspace',value:target.kind==='file'&&!/^file:/i.test(href)?decodeURIComponent(href):href}}catch{return null}
      }
    }
    // The URL authority is a capability issued for the explicitly chosen
    // document. A link cannot replace it or walk above its containing folder.
    if(/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(href))return null;
    try{
      const path=decodeURIComponent(href.split(/[?#]/)[0]);
      if(path.startsWith('/')||path.includes('\\')||/[\u0000-\u001f\u007f]/.test(path))return null;
      let depth=0;for(const part of path.split('/')){if(part==='..'){if(--depth<0)return null}else if(part&&part!=='.')depth++}
      const base=new URL(file.url),url=new URL(href,base);
      if(base.protocol!=='tasktap-preview:'||url.protocol!==base.protocol||url.host!==base.host)return null;
      return {kind:'local',value:url.href,href};
    }catch{return null}
  }
  function render(element,text,file){
    const fragment=DOMPurify.sanitize(parser.parse(String(text??'')),{
      RETURN_DOM_FRAGMENT:true,ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false,
      ALLOWED_TAGS:['h1','h2','h3','h4','h5','h6','p','br','hr','strong','em','del','blockquote','ul','ol','li','pre','code','a','img','table','thead','tbody','tr','th','td','input'],
      ALLOWED_ATTR:['title','alt','class','start','type','checked','disabled','align','data-doc-href','data-doc-src']
    });
    const scope='document-'+(++sequence)+'-',headings=new Map(),counts=new Map();
    fragment.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(heading=>{
      const base=heading.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu,'').replace(/\s+/g,'-')||'section';
      const n=counts.get(base)||0;counts.set(base,n+1);const slug=base+(n?'-'+n:'');
      heading.id=scope+slug;heading.tabIndex=-1;headings.set(slug,heading);
    });
    fragment.querySelectorAll('input').forEach(input=>{input.type='checkbox';input.disabled=true;input.setAttribute('aria-label',input.checked?'Completed task':'Incomplete task');input.closest('li')?.classList.add('document-task')});
    fragment.querySelectorAll('a').forEach(link=>{
      const target=linkTarget(link.getAttribute('data-doc-href'),file);link.removeAttribute('data-doc-href');
      if(!target){link.className='document-link-disabled';link.title='This link cannot be opened from the preview.';return}
      link.href=target.kind==='anchor'?'#'+scope+target.value:target.value;
      if(target.kind==='external'){link.className='document-external';link.setAttribute('aria-label',link.textContent+(typeof workspaceLinks==='undefined'?' (opens in browser)':' (opens in workspace)'))}
      link.title=link.title||'Click to open / Option-click for default app';
      link.addEventListener('click',event=>{
        event.preventDefault();event.stopPropagation();
        if(target.kind==='anchor'){const heading=headings.get(target.value);heading?.scrollIntoView({block:'start'});heading?.focus({preventScroll:true});return}
        // Only an actual user activation may invoke a native action.
        if(!event.isTrusted)return;
        if(typeof workspaceLinks!=='undefined'&&['workspace','external'].includes(target.kind)){workspaceLinks.open(target.value,file,event);return}
        if(typeof postLive==='function'){
          if(target.kind==='external')postLive('workspace-open-url',{url:target.value});
          else postLive('workspace-open-relative',{id:file.id,href:target.href,project:file.project});
        }
      });
      link.addEventListener('auxclick',event=>event.preventDefault());
    });
    fragment.querySelectorAll('img').forEach(img=>{
      const raw=img.getAttribute('data-doc-src'),target=linkTarget(raw,file);img.removeAttribute('data-doc-src');
      if(target?.kind==='local'){
        img.src=target.value;img.loading='lazy';img.decoding='async';img.referrerPolicy='no-referrer';
        img.addEventListener('error',()=>imagePlaceholder(img,'Image unavailable'));
      }else imagePlaceholder(img,target?.kind==='external'?'Remote image / '+(img.alt||'Not loaded'):'Image unavailable',target);
    });
    // Tables scroll within the prose column instead of widening a split pane.
    fragment.querySelectorAll('table').forEach(table=>{const wrap=document.createElement('div');wrap.className='document-table';wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label','Table');table.replaceWith(wrap);wrap.append(table)});
    element.classList.add('workspace-document');element.replaceChildren(fragment);
  }
  function imagePlaceholder(img,label,target){
    const placeholder=document.createElement('span');placeholder.className='document-image-placeholder';placeholder.textContent=label+(img.alt&&!label.includes(img.alt)?' / '+img.alt:'');
    if(target?.kind==='external'){
      const link=document.createElement('a');link.href=target.value;link.className='document-external';link.textContent='Open image in browser';
      link.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(!event.isTrusted)return;if(typeof workspaceLinks!=='undefined')workspaceLinks.open(target.value,{},event);else if(typeof postLive==='function')postLive('workspace-open-url',{url:target.value})});
      link.addEventListener('auxclick',event=>event.preventDefault());placeholder.append(document.createTextNode(' / '),link);
    }
    img.replaceWith(placeholder);
  }
  return {kind,render,linkTarget};
})();
