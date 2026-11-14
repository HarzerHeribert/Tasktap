const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(pathToFileURL(path.resolve('prototype/index.html')).href+'#workspace');
  const id=await page.evaluate(()=>{const s=state.sessions[0];s.task='Original amber request';s.nameHistory=[];delete s.sessionName;go('sessions');return s.id});
  await page.evaluate(id=>sessionNameChanged(id,'Testing signed downloads and relaunch','first'),id);
  await page.evaluate(id=>sessionNameChanged(id,'Publishing the community release','second'),id);
  await page.evaluate(id=>sessionNameChanged(id,'Publishing the community release','same'),id);
  assert.equal(await page.evaluate(id=>sess(id).nameHistory.length,id),2);
  await page.locator('#session-filter').fill('signed downloads');
  const row=page.locator('.session-row').filter({hasText:'Publishing the community release'});
  assert.equal(await row.count(),1);
  assert.ok(!(await row.innerText()).includes('Original amber request'));
  await row.click();
  await page.getByText('Past names · 2',{exact:true}).click();
  assert.match(await page.locator('[data-name-history]').innerText(),/Original amber request/);
  assert.match(await page.locator('[data-name-history]').innerText(),/Testing signed downloads/);
  await page.reload();await page.evaluate(()=>go('sessions'));
  await page.locator('#session-filter').fill('Original amber');
  assert.equal(await page.locator('.session-row').filter({hasText:'Publishing the community release'}).count(),1);
  assert.equal(await page.evaluate(id=>{
    const old=sess(id);old.agent='codex';old.conversation='same-conversation';
    const replacement={};inheritSessionNames(replacement,{agent:'codex',conversation:'same-conversation'},[old]);
    return replacement.sessionName===old.sessionName && replacement.nameHistory.length===2 && replacement.nameHistory!==old.nameHistory;
  },id),true);
  assert.deepEqual(errors,[]);
  console.log('Current names, dropdown history, duplicate suppression, historical search and persistence passed.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
