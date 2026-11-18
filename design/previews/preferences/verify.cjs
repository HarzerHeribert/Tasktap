// Checks the minimal voice setup inside the isolated Preferences mockup.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:950},reducedMotion:'reduce'});
    const errors=[],network=[];
    page.on('pageerror',error=>errors.push(String(error)));
    page.on('request',request=>{if(/^https?:/.test(request.url()))network.push(request.url())});
    await page.goto(pathToFileURL(path.join(__dirname,'index.html')).href);
    const screenshot = async name => {await page.locator('#toast').evaluate(e=>{e.hidden=true});await page.screenshot({path:path.join(__dirname,name+'.png'),fullPage:true})};
    const nav = name => page.getByRole('navigation',{name:'Preferences'}).getByRole('button',{name,exact:true});
    async function fits(label) {
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,label+': no document overflow');
      assert.deepEqual(await page.locator('.settings-group,.voice-setup,.voice-defaults,.page-header,.themes').evaluateAll(elements=>elements.filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className)),[],label+': content fits');
      const clipped=await page.locator('main button,main select,main input').evaluateAll(elements=>elements.filter(e=>e.getClientRects().length).filter(e=>{const r=e.getBoundingClientRect();return r.left<0||r.right>innerWidth+1}).map(e=>e.textContent||e.id));
      assert.deepEqual(clipped,[],label+': controls fit');
    }
    async function fixtureAction(action) {
      await page.evaluate(action=>{const b=document.createElement('button');b.dataset.action=action;document.body.append(b);b.click();b.remove()},action);
    }
    await fits('initial desktop');
    assert.equal(await page.locator('.voice-options').getAttribute('open'),null,'advanced settings start collapsed');
    assert.equal(await page.locator('main .button.primary:visible').count(),1,'one primary setup action');
    assert.equal(await page.getByLabel('Request language',{exact:true}).count(),0,'no request translation control');
    await screenshot('voice-local');
    await page.getByRole('button',{name:'Download & set up',exact:true}).click();
    assert.equal(await page.getByRole('dialog').count(),0,'no extra confirmation step');
    await page.waitForFunction(()=>Number(document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow'))>0);
    await screenshot('voice-download');
    await page.getByRole('button',{name:'Cancel download',exact:true}).click();
    assert.match(await page.locator('#voice-setup').innerText(),/Download paused/);
    await page.getByRole('button',{name:'Resume download',exact:true}).click();
    await fixtureAction('fail-download');
    assert.match(await page.locator('#voice-setup').innerText(),/Download interrupted/);
    await page.getByRole('button',{name:'Retry download',exact:true}).click();
    await page.getByRole('button',{name:'Allow microphone',exact:true}).waitFor();
    await screenshot('voice-permission');
    await page.getByRole('button',{name:'Allow microphone',exact:true}).click();
    assert.match(await page.locator('#voice-setup').innerText(),/You’re ready to dictate/);
    await page.getByRole('button',{name:'Try dictation',exact:true}).click();
    await page.getByRole('button',{name:'Try again',exact:true}).waitFor();
    assert.match(await page.locator('.sample-transcript').innerText(),/Mach den Button größer, but keep the shortcut/);
    await screenshot('voice-ready');
    await page.getByText('More options',{exact:true}).click();
    await page.getByLabel('Spoken language',{exact:true}).selectOption('de');
    assert.equal(await page.locator('.voice-options').evaluate(e=>e.open),true,'settings remain open after a change');
    await page.getByLabel('Spoken language',{exact:true}).selectOption('auto');
    await page.getByRole('button',{name:'Remove model…',exact:true}).click();
    await page.getByRole('button',{name:'Remove example model',exact:true}).click();
    await page.getByLabel('Speech model',{exact:true}).selectOption('apple');
    assert.match(await page.locator('#voice-setup').innerText(),/You’re ready to dictate/,'Apple alternative uses existing permission');
    await page.getByRole('tab',{name:'Read aloud',exact:true}).click();
    assert.equal(await page.getByLabel('Narration voice',{exact:true}).count(),0,'voice choices hidden when narration is off');
    await page.getByRole('switch',{name:'Read completion summaries aloud',exact:true}).check();
    await page.getByLabel('Narration voice',{exact:true}).selectOption('kokoro');
    assert.equal(await page.getByRole('button',{name:'Set up Kokoro…',exact:true}).isVisible(),true);
    await page.getByRole('tab',{name:'Read aloud',exact:true}).press('ArrowLeft');
    assert.equal(await page.getByRole('tab',{name:'Dictation',exact:true}).getAttribute('aria-selected'),'true');
    await page.reload();
    await page.getByRole('button',{name:/Use a cloud provider instead/}).click();
    await page.getByLabel('Provider',{exact:true}).selectOption('deepgram');
    assert.equal(await page.getByLabel('API key',{exact:true}).isDisabled(),true,'preview never accepts real credentials');
    await fits('cloud setup');await screenshot('voice-cloud');
    await page.getByRole('button',{name:'Connect provider',exact:true}).click();
    await page.getByRole('button',{name:'Allow microphone',exact:true}).click();
    assert.match(await page.locator('#voice-setup').innerText(),/Using Deepgram/);
    await nav('Agents & connections').click();
    assert.equal(await page.getByLabel('Reply language',{exact:true}).inputValue(),'request');
    await page.getByLabel('Reply language',{exact:true}).selectOption('english');
    await screenshot('agents');
    await nav('Voice').click();assert.match(await page.locator('.voice-defaults').innerText(),/Replies are set to English/);
    await page.getByRole('button',{name:/Use on-device dictation/}).click();
    await nav('General').click();await page.getByRole('button',{name:'Set up voice…',exact:true}).click();
    assert.equal(await page.getByRole('heading',{name:'Voice',exact:true}).isVisible(),true,'first-run entry goes straight to the same setup');
    await nav('Notifications').click();
    await page.getByRole('switch',{name:'Allow Tasktap notifications',exact:true}).uncheck();
    assert.equal(await page.getByRole('switch',{name:'A result is ready',exact:true}).isDisabled(),true);
    await nav('Appearance').click();await screenshot('appearance');
    await page.getByRole('button',{name:'Daylight',exact:true}).click();
    await page.getByRole('switch',{name:'Native translucency',exact:true}).uncheck();
    assert.equal(await page.getByRole('switch',{name:'Blur the background',exact:true}).isDisabled(),true);
    await nav('Voice').click();await fits('light desktop');await screenshot('voice-light');
    for(const width of [1440,1000,760,720,540,375,320]) {
      await page.setViewportSize({width,height:900});
      for(const title of ['General','Agents & connections','Workspaces','Capture','Voice','Notifications','Appearance']) {
        await nav(title).click();await fits(`${title} at ${width}px`);
      }
      await nav('Voice').click();await page.getByRole('button',{name:/Use a cloud provider instead/}).click();
      await fits(`cloud at ${width}px`);
      await page.getByRole('button',{name:/Use on-device dictation/}).click();
      await page.getByText('More options',{exact:true}).click();await fits(`more options at ${width}px`);
      await page.getByText('More options',{exact:true}).click();
    }
    await page.setViewportSize({width:375,height:900});
    await page.getByRole('button',{name:'Switch to dark appearance',exact:true}).click();
    await screenshot('voice-narrow');
    await page.getByRole('button',{name:/Use a cloud provider instead/}).click();
    await page.getByText('More options',{exact:true}).click();
    await page.getByRole('button',{name:'Manage…',exact:true}).click();
    const dialog=await page.getByRole('dialog').boundingBox();assert.ok(dialog.x>=0&&dialog.x+dialog.width<=375,'connection dialog fits narrow window');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors,[],'no runtime errors');assert.deepEqual(network,[],'no external connections');
    console.log('PASS: minimal download → microphone → ready flow, optional sample, cancel/retry, cloud branch, progressive options, independent reply language, read-aloud opt-in, all seven categories at seven widths, light/dark, no runtime errors or external requests.');
  } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
