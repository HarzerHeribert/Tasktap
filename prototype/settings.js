// Settings uses the selected artwork as a quiet header study. The field labels and
// menus stay stationary; compact and Reduce Motion layouts keep the same still composition.
function settingsHeader() {
  const header = $('#modal .dialog-title');
  header.classList.add('settings-header');
  const art = document.createElement('div');
  art.className = 'settings-header-art';
  art.setAttribute('aria-hidden','true');
  art.innerHTML = TasktapArt.markup('stage');
  header.prepend(art);
}
function settingsField(id,label,control) {
  return '<div class="field setting-field"><label for="'+id+'">'+esc(label)+'</label>'+control+'</div>';
}
function providerMark(id, illustrated) {
  if (!illustrated) return '<span aria-hidden="true" class="picker-mark agent-mark '+attr(id)+'">'+icon(id)+'</span>';
  const artwork={claude:'phase',codex:'glyph',agy:'orbit'}[id];
  return '<span aria-hidden="true" class="provider-study '+attr(id)+'">'+artThumb(artwork)+icon(id)+'</span>';
}
function artThumb(id) {
  return '<img class="picker-thumbnail" alt="" src="'+attr(TasktapArt.poster(id))+'">';
}

// Keep the real select or text input as the form control. Large catalogs use the platform picker.
const settingsPickers = (() => {
  let active = null;
  let number = 0;
  const idFor = input => 'choices-'+input.id+'-'+(++number);
  function choices(input) {
    if (input.tagName==='SELECT') {
      return Array.from(input.options, option=>({
        value:option.value, text:option.text, disabled:option.disabled,
        detail:option.dataset.detail || '', art:option.dataset.art || ''
      }));
    }
    const list=document.getElementById(input.dataset.suggestionList);
    return [{value:'',text:'Agent default'},...Array.from(list?.options || [],option=>({value:option.value,text:option.label}))];
  }
  function leading(input, item, illustrated=false) {
    if (input.id==='ai-route') return '';
    if (input.id==='session-host' || input.id==='handoff-host')return terminalHosts.mark(item.value);
    if (item.art) return artThumb(item.art);
    if (Object.hasOwn(providers,item.value)) return providerMark(item.value, illustrated);
    if (input.id==='voice-engine') return '<span class="picker-symbol">'+icon('sound')+'</span>';
    return '';
  }
  function close() {
    if (!active) return false;
    const {input,popup,wrapper,toggle}=active;
    active=null;
    input.setAttribute('aria-expanded','false');
    input.removeAttribute('aria-activedescendant');
    input.removeAttribute('aria-controls');
    toggle?.setAttribute('aria-expanded','false');
    toggle?.removeAttribute('aria-controls');
    wrapper.classList.remove('picker-open');
    popup.remove();
    return true;
  }
  function sync(input) {
    if (input?.tagName!=='SELECT' || !input.closest('.setting-picker')) return;
    const wrapper=input.parentElement;
    const selected=choices(input).find(option=>option.value===input.value);
    const mark=selected && leading(input,selected);
    wrapper.classList.toggle('with-mark',Boolean(mark));
    wrapper.querySelector('.picker-leading').innerHTML=mark || '';
    if (active?.input===input) paint();
  }
  function highlight(index, scroll=true) {
    if (!active || index<0 || index>=active.items.length) return;
    active.index=index;
    const rows=active.popup.querySelectorAll('[role=option]');
    for (let i=0;i<rows.length;i++) rows[i].classList.toggle('is-highlighted',i===index);
    active.input.setAttribute('aria-activedescendant',rows[index].id);
    if (scroll) rows[index].scrollIntoView({block:'nearest'});
  }
  function position() {
    if (!active) return;
    const {wrapper,popup}=active;
    if (!wrapper.isConnected || !wrapper.closest('dialog[open]')) { close(); return; }
    const rect=wrapper.getBoundingClientRect();
    const scale=rect.width / (wrapper.offsetWidth || rect.width) || 1;
    const gutter=6*scale;
    const edgeTop=document.body.classList.contains('notch-first')?Math.max(gutter,wrapper.closest('dialog').getBoundingClientRect().top):gutter;
    const above=rect.top-edgeTop-gutter, below=innerHeight-rect.bottom-gutter*2;
    const width=Math.min(rect.width,innerWidth-gutter*2);
    popup.style.width=width/scale+'px';
    const desired=Math.min(320*scale,popup.scrollHeight*scale+2*scale);
    const down=below>=desired || below>=above;
    popup.style.maxHeight=Math.max(32, (down?below:above)/scale)+'px';
    const height=popup.getBoundingClientRect().height;
    popup.style.top=(down?rect.bottom+gutter:Math.max(edgeTop,rect.top-height-gutter))/scale+'px';
    popup.style.left=Math.max(gutter,Math.min(rect.left,innerWidth-width-gutter))/scale+'px';
  }
  function paint() {
    if (!active) return;
    const {input,popup}=active;
    const query=active.filter?input.value.toLowerCase().trim():'';
    const items=choices(input).filter(item=>!query || item.text.toLowerCase().includes(query));
    if (!items.length) { close(); return; } // Freeform model IDs can be submitted directly.
    active.items=items;
    const selected=items.findIndex(item=>item.value===input.value && !item.disabled);
    popup.innerHTML=items.map((item,i)=>{
      const mark=leading(input,item,true);
      return '<div id="'+popup.id+'-'+i+'" class="picker-option" role="option" data-index="'+i+'" aria-selected="'+(item.value===input.value)+'"'+(item.disabled?' aria-disabled="true"':'')+'>'+
        (mark?'<span class="option-art">'+mark+'</span>':'')+
        '<span class="option-text"><strong>'+esc(item.text)+'</strong>'+(item.detail?'<small>'+esc(item.detail)+'</small>':'')+'</span>'+
        '<span class="option-check">'+(item.value===input.value?icon('check'):'')+'</span></div>';
    }).join('');
    active.index=-1;
    position();
    if (active && (!active.filter || selected!==-1)) highlight(selected!==-1?selected:items.findIndex(item=>!item.disabled));
  }
  function choose(index) {
    if (!active) return;
    const {input,items}=active, item=items[index];
    if (!item || item.disabled) return;
    close();
    input.focus({preventScroll:true});
    const changed=input.value!==item.value;
    input.value=item.value;
    if (changed) {
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
    }
    sync(input);
  }
  function open(input, filter=false) {
    if (input.disabled || !input.isConnected) return;
    if (active?.input===input) { active.filter=filter;paint();return; }
    close();
    const wrapper=input.parentElement, popup=document.createElement('div');
    popup.id=idFor(input);popup.className='setting-options';popup.setAttribute('role','listbox');
    popup.setAttribute('aria-label', input.labels?.[0]?.textContent.trim() || 'Options');
    popup.setAttribute('popover','manual');
    input.closest('dialog').append(popup);popup.showPopover();
    const toggle=wrapper.querySelector('button');
    active={input,popup,wrapper,toggle,filter,items:[],index:-1,typeahead:'',typedAt:0};
    input.setAttribute('aria-expanded','true');input.setAttribute('aria-controls',popup.id);
    toggle?.setAttribute('aria-expanded','true');toggle?.setAttribute('aria-controls',popup.id);
    wrapper.classList.add('picker-open');
    popup.addEventListener('pointerdown',event=>event.preventDefault());
    popup.addEventListener('click',event=>{
      const row=event.target.closest('[role=option]');
      if (row) choose(Number(row.dataset.index));
    });
    popup.addEventListener('pointermove',event=>{
      const row=event.target.closest('[role=option]');
      if (row && !row.hasAttribute('aria-disabled')) highlight(Number(row.dataset.index),false);
    });
    paint();
  }
  function keydown(event,input) {
    if (event.isComposing || event.ctrlKey || event.metaKey) return;
    const editable=input.tagName==='INPUT', key=event.key;
    const up=active?.input===input;
    if (up && key==='Tab') { close();return; }
    if (up && key==='Escape') { close();event.preventDefault();event.stopPropagation();return; }
    if (key==='ArrowDown' || key==='ArrowUp') {
      event.preventDefault();
      if (!up) { open(input);return; }
      const step=key==='ArrowDown'?1:-1;
      let index=active.index;
      for (let n=0;n<active.items.length;n++) {
        index=(index+step+active.items.length)%active.items.length;
        if (!active.items[index].disabled) { highlight(index);break; }
      }
    } else if (key==='Enter' || (key===' ' && !editable)) {
      if (!up && editable) return;
      event.preventDefault();
      if (!up) open(input);
      else if (active.index!==-1) choose(active.index);
      else close();
    } else if (up && !editable && (key==='Home' || key==='End')) {
      event.preventDefault();
      const index=key==='Home'?active.items.findIndex(item=>!item.disabled):active.items.findLastIndex(item=>!item.disabled);
      highlight(index);
    } else if (up && !editable && key.length===1 && !event.altKey) {
      event.preventDefault();
      const now=Date.now();
      active.typeahead=(now-active.typedAt<650?active.typeahead:'')+key.toLowerCase();active.typedAt=now;
      const index=active.items.findIndex(item=>!item.disabled && item.text.toLowerCase().startsWith(active.typeahead));
      highlight(index);
    }
  }
  function mount(container) {
    for (const input of container.querySelectorAll('select,input[list]')) {
      if (input.closest('.setting-picker') || input.multiple || input.options?.length>30 || !HTMLElement.prototype.showPopover) continue;
      const editable=input.tagName==='INPUT', wrapper=document.createElement('span');
      wrapper.className='setting-picker';
      input.before(wrapper);wrapper.append(input);
      input.setAttribute('aria-haspopup','listbox');input.setAttribute('aria-expanded','false');
      if (editable) {
        input.dataset.suggestionList=input.getAttribute('list');input.removeAttribute('list');
        input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.autocomplete='off';
        const toggle=document.createElement('button');toggle.type='button';toggle.className='picker-toggle';
        toggle.setAttribute('aria-label','Show model suggestions');toggle.setAttribute('aria-haspopup','listbox');toggle.setAttribute('aria-expanded','false');
        toggle.tabIndex=-1;toggle.innerHTML=icon('down');
        wrapper.append(toggle);
        toggle.onclick=()=>{input.focus({preventScroll:true});if(active?.input===input)close();else open(input)};
        input.addEventListener('input',event=>{if(event.isTrusted)open(input,true)});
      } else {
        wrapper.insertAdjacentHTML('beforeend','<span class="picker-leading" aria-hidden="true"></span><span class="picker-chevron" aria-hidden="true">'+icon('down')+'</span>');
        input.addEventListener('mousedown',event=>event.preventDefault());
        input.addEventListener('pointerdown',event=>{
          if (event.button!==0) return;
          event.preventDefault();input.focus({preventScroll:true});
          if (active?.input===input) close();else open(input);
        });
        input.addEventListener('click',event=>{event.preventDefault();if(event.detail===0 && !active)open(input)});
        input.addEventListener('change',()=>sync(input));
        sync(input);
      }
      input.addEventListener('keydown',event=>keydown(event,input));
    }
  }
  document.addEventListener('pointerdown',event=>{
    if (active && !active.wrapper.contains(event.target) && !active.popup.contains(event.target)) close();
  },true);
  document.addEventListener('focusin',event=>{
    if (active && !active.wrapper.contains(event.target) && !active.popup.contains(event.target)) close();
  });
  document.addEventListener('scroll',event=>{if (active && event.target!==active.popup) position()},true);
  window.addEventListener('resize',position);
  document.addEventListener('close',()=>{if(active && !active.input.closest('dialog[open]'))close()},true);
  return {mount,close,sync};
})();
