// Usage: node scripts/render-motion.cjs [--posters-only] [glyph|phase|relay|orbit]
// Authoring tools: Playwright with Chromium, ffmpeg and (optional) BROWSER_EXECUTABLE.
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const base = path.resolve(__dirname,'..');
const art = path.join(__dirname,'artwork');
const postersOnly = process.argv.includes('--posters-only');
const studies = ['glyph','phase','relay','orbit'].filter(id=>
  !process.argv.slice(2).some(a=>!a.startsWith('--')) || process.argv.includes(id)
);
const fps = 24, total = 96;
(async () => {
  const browser = await chromium.launch({
    headless:true, executablePath:process.env.BROWSER_EXECUTABLE,
    args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']
  });
  try {
    const page = await browser.newPage();
    await page.evaluate(source=>{window.phaseShaderSource=source},await fs.readFile(path.join(art,'phase.frag'),'utf8'));
    await page.addScriptTag({path:path.join(art,'motion-studies.js')});
    for(const id of studies) {
      const dest=path.join(base,'prototype/assets/motion',id);
      await fs.mkdir(dest,{recursive:true});
      for(const size of ['stage','miniature']) {
        const make = async n => Buffer.from(await page.evaluate(
          ([id,small,t])=>window.motionFrame(id,small,t),[id,size==='miniature',n/total]
        ),'base64');
        const frame = await make(0);
        const jpg=spawnSync('ffmpeg',['-y','-loglevel','error','-f','image2pipe','-i','pipe:0','-frames:v','1','-q:v','2',path.join(dest,size+'.jpg')],{input:frame});
        if(jpg.status!==0)throw Error(jpg.stderr.toString());
        if(postersOnly)continue;
        const enc=spawn('ffmpeg',['-y','-loglevel','error','-f','image2pipe','-framerate',String(fps),'-i','pipe:0','-an','-vcodec','libx264','-profile:v','main','-level','3.1','-pix_fmt','yuv420p','-preset','slow','-crf',size==='miniature'?'19':'18','-movflags','+faststart',path.join(dest,size+'.mp4')],{stdio:['pipe','inherit','inherit']});
        const done=once(enc,'close');
        for(let n=0;n<total;n++) {
          if(!enc.stdin.write(n?await make(n):frame))await once(enc.stdin,'drain');
        }
        enc.stdin.end();
        if((await done)[0]!==0)throw Error('ffmpeg failed to encode '+id);
      }
      console.log('Rendered '+id);
    }
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
