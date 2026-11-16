/* Historical VT queries may repaint, but must never answer a live shell. */
const terminalProtocol=(()=>{
  const releaseSequence='\x1b[?9;1000;1002;1003;1004;1005;1006;1015;1016;2004;2026l\x1b[?1l\x1b>\x1b[<u\x1b[=0u\x1b[>4;0m\x1b[?47l\x1b[0m\x1b[?25h';
  function install(term,replaying){
    let reply=false,disposed=false;
    const hooks=[];
    // xterm 6's built-in responders run synchronously after these public parser
    // hooks. Guard their parser turn, preserving setters and user input verbatim.
    // In particular, an OSC palette batch can mix color setters and queries.
    function query(){
      reply=!!replaying();if(reply)queueMicrotask(()=>{reply=false});
      return false; // Delegate rendering/state to xterm's own handler.
    }
    for(const id of [{final:'n'},{prefix:'?',final:'n'},{final:'c'},{prefix:'>',final:'c'},
      {intermediates:'$',final:'p'},{prefix:'?',intermediates:'$',final:'p'},{final:'t'}])
      hooks.push(term.parser.registerCsiHandler(id,query));
    hooks.push(term.parser.registerCsiHandler({prefix:'?',final:'h'},params=>params.includes(1004)?query():false));
    hooks.push(term.parser.registerDcsHandler({intermediates:'$',final:'q'},query));
    for(const id of [4,10,11,12])hooks.push(term.parser.registerOscHandler(id,data=>data.split(';').includes('?')?query():false));
    return {isReplayReply:()=>!disposed&&reply,dispose(){disposed=true;hooks.forEach(h=>h.dispose())}};
  }
  function release(term){term.write(releaseSequence,()=>term.focus())}
  return {install,release,releaseSequence};
})();
