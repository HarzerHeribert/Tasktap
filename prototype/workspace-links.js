/* One explicit-click route for terminal output, reports, and documents. */
const workspaceLinks=(()=>{
  const appSchemes=new Set(['mailto:','tel:','sms:','vscode:','vscode-insiders:','cursor:','zed:','xcode:','obsidian:','slack:']);
  function target(value){
    const href=String(value||'').trim();
    if(!href||/[\u0000-\u001f\u007f\\]/.test(href))return null;
    if(/^https?:\/\//i.test(href)){
      try{const url=new URL(href);return url.hostname&&!url.username&&!url.password?{kind:'web',value:url.href}:null}catch{return null}
    }
    if(/^file:/i.test(href)){
      try{const url=new URL(href);return (!url.host||url.host==='localhost')&&!url.username&&!url.password?{kind:'file',value:href}:null}catch{return null}
    }
    const scheme=href.match(/^([a-z][a-z0-9+.-]*:)/i)?.[1].toLowerCase();
    // A filename followed by :line[:column] is a path, not a URL scheme.
    if(scheme&&!/^[^/]+\.[^/:]+:\d+(?::\d+)?$/.test(href))return appSchemes.has(scheme)?{kind:'app',value:href}:null;
    if(href.startsWith('//'))return null;
    return {kind:'file',value:href};
  }
  function open(value,context={},event){
    event?.preventDefault();event?.stopPropagation();
    if(event&&!event.isTrusted)return;
    const link=target(value);if(!link)return;
    // Option-click uses the system browser/editor. Plain and Cmd-click work
    // in the workspace, including OSC 8 links emitted by command-line tools.
    if(typeof live!=='undefined'&&!live){toast('Open links in the Mac app.');return}
    postLive('workspace-open-link',{href:link.value,project:context.project||'',cwd:context.cwd||'',external:!!event?.altKey});
  }
  function terminal(term,context){
    const activate=(event,text)=>open(text,context(),event);
    term.options.linkHandler={activate,allowNonHttpProtocols:true,hover:(_,text)=>{if(term.element)term.element.title=text+' · Click to open / Option-click for default app'},leave:()=>{if(term.element)term.element.removeAttribute('title')}};
    return term.registerLinkProvider({provideLinks(y,callback){
      const buffer=term.buffer.active;let start=y-1,end=start;
      while(start>0&&buffer.getLine(start)?.isWrapped&&y-start<100)start--;
      while(end+1<buffer.length&&buffer.getLine(end+1)?.isWrapped&&end-start<100)end++;
      let text='';const positions=[];
      for(let row=start;row<=end;row++){
        const line=buffer.getLine(row);if(!line)continue;
        for(let col=0;col<line.length;col++){
          const cell=line.getCell(col);if(!cell||cell.getWidth()===0)continue;
          const chars=cell.getChars()||' ';
          for(let i=0;i<chars.length;i++)positions.push({x:col+1,y:row+1,end:col+Math.max(1,cell.getWidth())});
          text+=chars;
        }
      }
      // Quotes preserve spaces in filenames. Soft-wrapped lines are joined
      // above, using buffer cells so wide characters keep the hit range right.
      const pattern=/(?:https?:\/\/|file:\/\/|mailto:|tel:|sms:|vscode:\/\/|vscode-insiders:\/\/|cursor:\/\/|zed:\/\/|xcode:\/\/|obsidian:\/\/|slack:\/\/)[^\s<>"'`]+|"[^"\r\n]+"|'[^'\r\n]+'|(?:\/?(?:[\p{L}\p{N}_@.+~-]+\/)+[\p{L}\p{N}_@.+~-]*|[\p{L}\p{N}_@-]+\.[\p{L}][\p{L}\p{N}_-]*)(?::\d+(?::\d+)?)?(?:#L\d+(?:C\d+)?)?/gu;
      const links=[];
      for(const match of text.matchAll(pattern)){
        let value=match[0],offset=match.index;
        if(/^['"]/.test(value)){value=value.slice(1,-1);offset++;if(!/[/.]/.test(value))continue}
        else{
          value=value.replace(/[.,;:!?]+$/,'');
          for(const [left,right] of [['(',')'],['[',']'],['{','}']])while(value.endsWith(right)&&value.split(right).length>value.split(left).length)value=value.slice(0,-1);
        }
        if(!target(value))continue;
        const first=positions[offset],last=positions[offset+value.length-1];
        if(!first||!last||y<first.y||y>last.y)continue;
        links.push({text:value,range:{start:{x:first.x,y:first.y},end:{x:last.end,y:last.y}},activate,hover:()=>{if(term.element)term.element.title=value+' · Click to open / Option-click for default app'},leave:()=>{if(term.element)term.element.removeAttribute('title')}});
      }
      callback(links);
    }});
  }
  return {target,open,terminal};
})();
