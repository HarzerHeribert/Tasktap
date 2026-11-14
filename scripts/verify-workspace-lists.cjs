const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(pathToFileURL(path.resolve(__dirname,'../prototype/index.html')).href+'#workspace');
  await page.evaluate(()=>{
   document.body.classList.remove('notch-first');document.body.classList.add('native-host');
   state.projects=[{id:'list-project',name:'An unusually long project name',folder:'/example/projects/a-long-folder-name'}];
   state.sessions=['A short session name','A longer session name that explains the work and wraps onto a second line without moving adjacent columns'].map((task,i)=>({id:'list-'+i,task,project:'list-project',agent:i?'claude':'codex',host:i?'ghostty':'cmux',state:i?'Ready to send':'Running',updatedAt:Date.now(),log:[]}));
   state.captures=[];state.decisions=[];go('sessions');
  });
  for(const width of [320,390,820,1100,1440]){
   await page.setViewportSize({width,height:900});
   await page.evaluate(()=>go('sessions'));
   const geometry=await page.locator('.work-list').evaluate(list=>{
    const rows=[...list.querySelectorAll('.work-row')];const header=list.querySelector('.list-columns');
    const rect=e=>e.getBoundingClientRect();
    return {overflow:document.documentElement.scrollWidth>innerWidth, widths:rows.map(r=>rect(r).width),expected:list.clientWidth,columns:[...header.children].flatMap((cell,i)=>cell.textContent.trim() && getComputedStyle(header).display!=='none' && getComputedStyle(cell).display!=='none'?[rows.map(row=>Math.abs(rect(row.children[i]).x-rect(cell).x))]:[])};
   });
   assert.equal(geometry.overflow,false,`overflow at ${width}`);
   assert.ok(geometry.widths.every(w=>Math.abs(w-geometry.expected)<=2),`row width at ${width}`);
   assert.ok(geometry.columns.flat().every(delta=>delta<=1.1),`column alignment at ${width}`);
   await page.locator('.work-row').first().focus();await page.keyboard.press('Enter');
   assert.equal(await page.locator('#dialog-heading').innerText(),'A short session name');
   await page.keyboard.press('Escape');
   await page.evaluate(()=>{state.showIdleProjects=true;go('projects')});
   assert.equal(await page.locator('.project-active').innerText(),'2');
   assert.equal(await page.locator('.project-total').innerText(),'2');
   assert.ok(await page.locator('.project-table').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
   await page.locator('.project-row').click();
   assert.equal(await page.locator('.work-row').count(),2);
  }
  assert.deepEqual(errors,[]);
  console.log('Workspace row widths, shared column alignment, project counts and keyboard navigation passed at 320–1440px.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
