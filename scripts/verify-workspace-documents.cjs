const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 try{
  const page=await browser.newPage({viewport:{width:560,height:720}}),requests=[];
  page.setDefaultTimeout(5000);
  page.on('request',request=>{if(/^https?:/.test(request.url()))requests.push(request.url())});
  await page.setContent('<style>body{margin:24px;--app-fg:#d8dee9;--app-bg:#111318;--app-edge:#30333b;--app-accent:#9ab9f5;--app-input:#191c21;background:var(--app-bg)}</style><article id="preview"></article>');
  for(const script of ['vendor/marked.js','vendor/purify.js','workspace-documents.js'])await page.addScriptTag({path:path.resolve('prototype',script)});
  await page.addStyleTag({path:path.resolve('prototype/workspace-documents.css')});
  await page.evaluate(()=>{window.messages=[];window.postLive=(type,data)=>messages.push({type,...data});window.file={id:'document',project:'p',kind:'text',title:'Readme.MD',url:'tasktap-preview://document/Readme.MD'};window.preview=document.querySelector('#preview')});
  const markdown=`# Project **notes**

[Jump to details](#details) / [Reference](https://example.com/docs) / [Next document](Next.md)

## Details

- [x] Completed task
- [ ] Open task
- Parent
  1. Nested item

> A useful quotation.

| Item | State |
| :--- | ---: |
| Preview | **Ready** |

`+'```javascript\nconst message = "<script>never runs</script>";\n```\n'+`
![Local diagram](assets/diagram.svg)
![Private tracker](https://example.com/tracker.png)

<img src="https://example.com/raw-tracker" onerror="window.compromised=true">
<button data-action="delete-all">Delete</button>
<script>window.compromised=true</script>

[Danger](javascript:alert(1))
[Escape](../private.md)
[Encoded escape](%2e%2e/private.md)
[Protocol escape](//example.com)
`;
  const rendered=await page.evaluate(text=>{workspaceDocuments.render(preview,text,file);return {images:[...preview.querySelectorAll('img')].map(image=>image.getAttribute('src'))}},markdown);
  assert.equal(await page.evaluate(()=>workspaceDocuments.kind(file)),'markdown','legacy text records detect Markdown');
  assert.equal(await page.locator('h1 strong').innerText(),'notes');
  assert.equal(await page.locator('.document-task').count(),2);
  assert.equal(await page.locator('input[type=checkbox]:disabled').count(),2);
  assert.equal(await page.locator('input:checked').count(),1);
  assert.equal(await page.locator('li ol li').innerText(),'Nested item');
  assert.equal(await page.locator('th').count(),2);
  assert.match(await page.locator('pre code').textContent(),/<script>never runs/);
  assert.deepEqual(rendered.images,['tasktap-preview://document/assets/diagram.svg'],'only approved local images are inserted; the private scheme itself is checked in native WebKit');
  assert.equal(await page.locator('[data-action]').count(),0,'Markdown cannot invoke app handlers');
  assert.equal(await page.locator('#preview script').count(),0,'raw HTML never becomes executable content');
  assert.equal(await page.evaluate(()=>window.compromised),undefined);
  assert.deepEqual(requests,[],'neither remote Markdown images nor raw HTML load external resources');
  assert.equal(await page.getByText('Danger',{exact:true}).getAttribute('href'),null);
  assert.equal(await page.getByText('Escape',{exact:true}).getAttribute('href'),null);
  assert.equal(await page.getByText('Encoded escape',{exact:true}).getAttribute('href'),null);
  assert.equal(await page.getByText('Protocol escape',{exact:true}).getAttribute('href'),null);
  await page.getByRole('link',{name:'Jump to details'}).click();
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Details','headings focus within their own document');
  await page.getByRole('link',{name:'Reference (opens in browser)'}).click();
  assert.deepEqual(await page.evaluate(()=>messages.pop()),{type:'workspace-open-url',url:'https://example.com/docs'});
  await page.getByRole('link',{name:'Next document'}).click();
  assert.deepEqual(await page.evaluate(()=>messages.pop()),{type:'workspace-open-relative',id:'document',href:'Next.md',project:'p'});
  await page.evaluate(()=>preview.querySelector('.document-external').click());
  assert.deepEqual(await page.evaluate(()=>messages),[],'synthetic document clicks cannot invoke native actions');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'prose stays within narrow panes');
  const unsafe=['file:///etc/passwd','data:text/html,evil','tasktap-preview://other/private.md','/absolute.md','..%2fprivate.md','folder/../../private.md','https://user:password@example.com'];
  assert.deepEqual(await page.evaluate(values=>values.map(value=>workspaceDocuments.linkTarget(value,file)),unsafe),unsafe.map(()=>null));
  await page.evaluate(()=>{workspaceDocuments.render(preview,'# Repeated\n\n# Repeated\n\n![Missing](missing.png)',file)});
  assert.equal(await page.locator('h1').evaluateAll(nodes=>new Set(nodes.map(node=>node.id)).size),2,'duplicate headings have distinct anchors');
  console.log('Workspace documents passed: rendered Markdown structure, legacy types, scoped navigation, explicit native links, local images, no remote auto-loads or app handlers, narrow-pane layout.');
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
