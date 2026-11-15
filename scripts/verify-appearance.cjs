// Real rendered colors, native-window settings, and persistence across a reload.
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
  try{
    const page=await browser.newPage({viewport:{width:1100,height:860},reducedMotion:'reduce',colorScheme:'dark'}),errors=[];
    page.setDefaultTimeout(6000);
    page.on('pageerror',error=>errors.push(String(error)));
    await page.addInitScript(()=>{window.sent=[];window.webkit={messageHandlers:{workspace:{postMessage:m=>sent.push(m)}}}});
    await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href);
    assert.equal(await page.evaluate(()=>appAppearance.current().id),'ghostty','Ghostty remains the default');
    await page.evaluate(()=>{state.firstRun={done:true};showWorkspace();go('overview');prefs('agents')});
    const readability=async selector=>page.locator(selector).evaluateAll(elements=>{
      const context=document.createElement('canvas').getContext('2d');
      function rgb(value){context.clearRect(0,0,1,1);context.fillStyle=value;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data].map((v,i)=>i===3?v/255:v)}
      const blend=(top,bottom)=>top.slice(0,3).map((v,i)=>v*top[3]+bottom[i]*(1-top[3])).concat(1);
      const lum=color=>color.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      return elements.map(el=>{
        let bg=[9,10,11,1];const chain=[];for(let node=el;node;node=node.parentElement)chain.unshift(node);
        for(const node of chain)bg=blend(rgb(getComputedStyle(node).backgroundColor),bg);
        const fg=blend(rgb(getComputedStyle(el).color),bg),a=lum(fg),b=lum(bg);
        return {text:el.textContent.trim().slice(0,60),ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
      });
    });
    const verify=async(selector)=>{for(const item of await readability(selector))assert.ok(item.ratio>=4.5,`${item.text}: ${item.ratio.toFixed(2)}:1 contrast`)};
    const shots=process.env.TASKTAP_SCREENSHOTS;
    const shot=async name=>{if(shots){require('node:fs').mkdirSync(shots,{recursive:true});await page.locator('#modal').screenshot({path:path.join(shots,'appearance-'+name+'.png')})}};
    await page.evaluate(()=>{
      const OriginalTerminal=window.Terminal;window.appearanceTerminals=[];
      window.Terminal=class extends OriginalTerminal {constructor(options){super(options);appearanceTerminals.push(this)}};
      document.body.classList.add('workspace-snapshot');state.workspaceDeck.sidebarHidden=false;
      state.projects=[{id:'theme-project',folder:'/tmp/theme-project',name:'Theme verification',aliases:[]}];
      state.sessions=[{id:'theme-terminal',project:'theme-project',agent:'codex',host:'tasktap',interactive:true,available:true,state:'Connected',task:'Preview changes',log:[]}];
      go('theme-project');workspaceDeck.open('terminal:theme-terminal','theme-project');
    });
    const colored=['ocean','dusk','ember','rose'];
    const paletteKeys=['foreground','cursor','selectionBackground','selectionForeground','black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'];
    const backgrounds=new Set();
    for(const theme of ['dark','light','ghostty',...colored]){
      await page.evaluate(theme=>{appAppearance.setTheme(theme);prefs('agents')},theme);
      await verify('.settings-jump strong,.settings-jump small:not([hidden]),.preference-groups button');
      await verify('#sidebar .nav-link,#sidebar .nav-kicker,.nav-pane-label,.deck-tab,.deck-project-name');
      const actual=await page.evaluate(()=>({current:appAppearance.current(),terminal:appearanceTerminals[0].options.theme,engines:appearanceTerminals.length,
        canvas:getComputedStyle(document.querySelector('.shell')).backgroundColor,app:getComputedStyle(document.documentElement).getPropertyValue('--app-bg').trim(),
        native:sent.filter(m=>m.type==='workspace-chrome').at(-1).background}));
      for(const key of paletteKeys)assert.equal(actual.terminal[key],actual.current.terminalTheme[key],theme+' terminal '+key);
      assert.equal(actual.terminal.background,actual.current.background+'00',theme+' terminal retains native translucency');
      assert.equal(actual.app,actual.current.background);assert.equal(actual.native,actual.current.background);
      assert.equal(actual.canvas,'rgb('+[1,3,5].map(i=>parseInt(actual.current.background.slice(i,i+2),16)).join(', ')+')');
      assert.equal(actual.engines,1,'theme switching preserves the terminal session');
      if(colored.includes(theme)){backgrounds.add(actual.current.background);assert.equal(actual.current.dark,theme!=='rose')}
      await shot(theme+'-preferences');
      await page.evaluate(()=>{
        state.decisions=[{id:'theme-question',session:'theme-terminal',q:'Apply the preview?',choices:['Apply changes','Keep the current version']}];
        showNotch('theme-question');
      });
      assert.ok(await page.locator('#notch').evaluate(el=>{
        const probe=document.createElement('div');probe.style.background='var(--app-overlay)';el.append(probe);
        const matches=getComputedStyle(el).backgroundColor===getComputedStyle(probe).backgroundColor;probe.remove();return matches;
      }),theme+' workspace decision dialog uses application palette');
      await verify('#notch h2,#notch h3,#notch .decision-btn,#notch .text-btn');
      if(shots)await page.locator('#notch').screenshot({path:path.join(shots,'appearance-'+theme+'-question.png')});
      await page.evaluate(()=>{state.decisions[0].kind='binary';showNotch('theme-question')});
      await verify('#notch .decision-btn,#notch .text-btn');
      await page.evaluate(()=>document.querySelector('#notch').close());
    }
    assert.equal(backgrounds.size,4,'color themes have distinct canvases, not only different accents');
    await page.evaluate(()=>{appAppearance.setTheme('ghostty');appAppearance.receiveGhostty({source:'Ghostty',theme:{background:'#0d1117',foreground:'#cdd6f4',blue:'#89b4fa',green:'#a6e3a1',red:'#f38ba8',yellow:'#f9e2af',cursorAccent:'#112233',extendedAnsi:Array(240).fill('#123456')}});prefs('appearance')});
    assert.equal(await page.evaluate(()=>appAppearance.current().background),'#0d1117');
    assert.equal(await page.evaluate(()=>appAppearance.current().terminalTheme.cursorAccent),'#112233');
    assert.deepEqual(await page.evaluate(()=>appAppearance.current().terminalTheme.extendedAnsi),Array(240).fill('#123456'),'extended Ghostty palette is preserved');
    assert.equal(await page.locator('.shell').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(13, 17, 23)');
    await verify('.appearance-choice strong,.appearance-choice small,#appearance-description,.setting-field>label');
    await shot('chooser');
    await page.locator('input[name=app-theme][value=light]').check();
    assert.equal(await page.evaluate(()=>appAppearance.current().id),'light');
    await page.getByLabel('Translucent window',{exact:true}).uncheck();
    assert.ok(await page.getByLabel('Blur the background',{exact:true}).isDisabled());
    assert.equal(await page.evaluate(()=>state.workspaceDeck.preferences.translucent),false);
    assert.equal(await page.evaluate(()=>sent.filter(m=>m.type==='workspace-chrome').at(-1).opacity),1,'opaque preference reaches native window');
    await page.reload();
    assert.equal(await page.evaluate(()=>appAppearance.current().id),'light','theme persists');
    assert.equal(await page.evaluate(()=>state.workspaceDeck.preferences.translucent),false,'window preference persists');
    for(const theme of colored){
      await page.evaluate(()=>{showWorkspace();prefs('appearance')});
      await page.locator('input[name=app-theme][value='+theme+']').check();
      await verify('.appearance-choice strong,.appearance-choice small,#appearance-description');
      await page.reload();
      assert.equal(await page.evaluate(()=>appAppearance.current().id),theme,theme+' persists after reload');
      assert.equal(await page.evaluate(()=>state.workspaceDeck.preferences.translucent),false,'theme selection preserves window settings');
    }
    await page.evaluate(()=>{showWorkspace();prefs('appearance')});await shot('rose-chooser');
    await page.evaluate(()=>{appAppearance.setTheme('system');showWorkspace();prefs('agents')});
    assert.equal(await page.evaluate(()=>appAppearance.current().dark),true);
    assert.equal(await page.evaluate(()=>sent.filter(m=>m.type==='workspace-chrome').at(-1).followSystem),true,'System releases native window appearance override');
    await page.emulateMedia({colorScheme:'light'});
    await page.waitForFunction(()=>appAppearance.current().dark===false);
    await verify('.settings-jump strong,.settings-jump small:not([hidden]),.preference-groups button');
    // The black physical notch uses a dark companion palette, including popovers.
    await page.evaluate(()=>{document.body.classList.add('notch-first','notch-open');prefs('agents')});
    await verify('.settings-jump strong,.settings-jump small:not([hidden]),.preference-groups button');
    assert.equal(await page.locator('.notch-surface').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(9, 10, 11)');
    await shot('notch-preferences');
    for(const theme of colored){
      await page.evaluate(theme=>{appAppearance.setTheme(theme);prefs('agents')},theme);
      await verify('.settings-jump strong,.settings-jump small:not([hidden]),.preference-groups button');
    }
    await page.evaluate(()=>prefs('appearance'));
    await page.setViewportSize({width:360,height:780});
    assert.ok(await page.locator('#preferences').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'narrow preferences fit');
    await verify('.appearance-choice strong,.appearance-choice small,#appearance-description');
    assert.equal(await page.locator('input[name=app-theme]').count(),8);
    await page.locator('input[name=app-theme][value=ocean]').check();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(()=>appAppearance.current().id),'dusk','native radio keyboard navigation selects the next theme');
    await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(()=>appAppearance.current().id),'rose');
    assert.ok(await page.locator('input[name=app-theme][value=rose]').evaluate(el=>el===document.activeElement),'theme change preserves keyboard focus');
    await shot('narrow-chooser');
    assert.deepEqual(errors,[]);
    console.log('PASS: eight app-wide themes, real terminal palette consistency without restarting sessions, readable Preferences/sidebar/workspace decisions/notch, Ghostty import, colored-theme persistence, System updates, native backdrop controls, and narrow keyboard navigation.');
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
