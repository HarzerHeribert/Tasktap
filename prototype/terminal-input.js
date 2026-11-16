/* A terminal is a stream, not an editable document. Keep native text
 * replacements in the composer, where the user can review them before paste.
 * In xterm 6.0, keyCode 229 outside composition diffs the textarea using
 * String.replace, which can re-emit its entire accessibility mirror (#6078).
 * Intercept just that fallback using public DOM/input APIs; normal IME
 * composition and the screen-reader mirror remain owned by xterm.
 */
const terminalInput=(()=>{
  const drafts=new WeakMap();
  function difference(before,after){
    const a=Array.from(before),b=Array.from(after);let start=0,end=0;
    while(start<a.length&&start<b.length&&a[start]===b[start])start++;
    while(end<a.length-start&&end<b.length-start&&a[a.length-1-end]===b[b.length-1-end])end++;
    return {start:a.slice(0,start).join('').length,removed:a.slice(start,a.length-end).join(''),added:b.slice(start,b.length-end).join('')};
  }
  function install(term,parent,blocked){
    const area=term.textarea,listeners=[];
    let composing=false,generation=0,pending=null,timer=0,disposed=false;
    const snapshot=()=>({value:area.value,start:area.selectionStart,end:area.selectionEnd});
    function cancel(){clearTimeout(timer);timer=0;pending=null}
    function finish(){
      if(!pending||disposed)return;
      const before=pending;cancel();
      const change=difference(before.value,area.value);
      if(change.removed||(change.added&&(change.start!==before.start||before.start!==before.end))){
        // Previously delivered input cannot safely be rewritten: this could be
        // a shell command, a password, a TUI, or a cursor in the middle of text.
        area.value=before.value;area.setSelectionRange(before.start,before.end);
        blocked();
      }else if(change.added)term.input(change.added,true);
    }
    function listen(type,handler,capture=true){parent.addEventListener(type,handler,capture);listeners.push(()=>parent.removeEventListener(type,handler,capture))}
    const owns=event=>event.target===area;
    listen('compositionstart',event=>{if(owns(event)){generation++;composing=true;cancel()}});
    // Bubble after xterm has scheduled its composition commit. Do not intercept
    // the commit's settle tick, including a rapid following keydown.
    listen('compositionend',event=>{if(owns(event)){const token=generation;setTimeout(()=>{if(token===generation)composing=false},0)}},false);
    listen('keydown',event=>{
      // WebKit can flag a replacement key as composing without ever sending
      // compositionstart. Only a real composition session belongs to xterm;
      // an orphan is the same fallback path as an ordinary 229 key.
      if(!owns(event)||composing||event.keyCode!==229)return;
      finish();pending=snapshot();
      event.stopImmediatePropagation();
      timer=setTimeout(finish,0);
    });
    listen('beforeinput',event=>{
      if(!owns(event)||composing||event.inputType!=='insertReplacementText')return;
      if(event.cancelable){event.preventDefault();event.stopImmediatePropagation();cancel();blocked()}
      else{pending??=snapshot();clearTimeout(timer);timer=setTimeout(finish,0)}
    });
    listen('input',event=>{
      if(!owns(event)||composing||!pending)return;
      event.stopImmediatePropagation();finish();
    });
    listen('blur',event=>{if(owns(event)){generation++;composing=false;cancel()}});
    return {dispose(){disposed=true;generation++;cancel();listeners.forEach(remove=>remove())}};
  }
  function compose(term,title,available=()=>true){
    dialog('Compose text','Insert into '+title,
      '<form id="terminal-compose-form" class="stack"><label class="field">Text<textarea id="terminal-compose-text" rows="7" spellcheck="true" autocorrect="on" autocapitalize="sentences" placeholder="Write and review your prompt…"></textarea></label>'+
      '<p class="hint">Autocorrection is on. Review the text, then insert it at the terminal cursor. Enter is not sent.</p>'+
      '<div class="inline"><span id="terminal-compose-change" class="hint" role="status" aria-live="polite"></span><button type="button" id="terminal-compose-undo" class="text-btn" hidden>Undo correction</button></div>'+
      '<p id="terminal-compose-error" class="hint" role="status"></p><div class="form-actions"><button type="button" id="terminal-compose-cancel" class="btn">Cancel</button><button type="submit" class="primary">Insert text</button></div></form>');
    const form=$('#terminal-compose-form'),area=$('#terminal-compose-text'),undo=$('#terminal-compose-undo'),notice=$('#terminal-compose-change'),error=$('#terminal-compose-error');
    area.value=drafts.get(term)||'';
    let before=null,correction=null;
    area.addEventListener('beforeinput',event=>{before={value:area.value,start:area.selectionStart,end:area.selectionEnd,type:event.inputType,composing:event.isComposing}});
    area.addEventListener('input',()=>{
      drafts.set(term,area.value);error.textContent='';
      if(before&&!before.composing&&!before.type.startsWith('delete')){
        const change=difference(before.value,area.value);
        if(before.value!==area.value&&(before.type==='insertReplacementText'||change.removed&&change.added||change.added&&change.start!==before.start)){
          correction={...before,after:area.value};
          const excerpt=text=>Array.from(text).slice(0,60).join('');
          let left=change.start,oldEnd=change.start+change.removed.length,newEnd=change.start+change.added.length;
          while(left>0&&!/\s/.test(before.value[left-1]))left--;
          while(oldEnd<before.value.length&&!/\s/.test(before.value[oldEnd]))oldEnd++;
          while(newEnd<area.value.length&&!/\s/.test(area.value[newEnd]))newEnd++;
          notice.textContent='Replaced “'+excerpt(before.value.slice(left,oldEnd))+'” with “'+excerpt(area.value.slice(left,newEnd))+'”.';
        }
      }
      before=null;undo.hidden=!correction||correction.after!==area.value;
    });
    undo.onclick=()=>{
      if(!correction||area.value!==correction.after)return;
      area.value=correction.value;area.setSelectionRange(correction.start,correction.end);drafts.set(term,area.value);
      correction=null;undo.hidden=true;notice.textContent='Correction undone.';area.focus();
    };
    $('#terminal-compose-cancel').onclick=()=>dismissCard();
    form.onsubmit=event=>{
      event.preventDefault();const text=area.value;
      if(!text.trim()){error.textContent='Write some text first.';return}
      if(new TextEncoder().encode(text).length>64000){error.textContent='This draft is too large to insert at once. Split it into smaller parts.';return}
      if(!available()){error.textContent='This terminal is unavailable. Your draft is kept; reconnect and try again.';return}
      if(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)){error.textContent='Remove terminal control characters before inserting.';return}
      if(/[\n\t]/.test(text)&&!term.modes.bracketedPasteMode){error.textContent='This CLI does not support protected multiline paste. Use one line to avoid executing input.';return}
      term.paste(text);drafts.delete(term);dismissCard();term.focus();
    };
    area.focus();area.setSelectionRange(area.value.length,area.value.length);
  }
  return {install,compose};
})();
