// Offline 2× supersampled chrome artwork, 1920×900, 60 fps, 16-second loops.
// Uses the original Glyph / Phase studio rig; only the website geometry is thicker.
// BROWSER_EXECUTABLE=/path/to/chrome node scripts/render-site-motion.cjs [--posters-only]
const {chromium}=require('playwright');
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {once}=require('node:events');
const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 try{
  const page=await browser.newPage();
  await page.evaluate(source=>{window.phaseShaderSource=source},await fs.readFile(path.join(__dirname,'artwork/phase.frag'),'utf8'));
  await page.addScriptTag({path:path.join(__dirname,'artwork/motion-studies.js')});
  const dest=path.join(root,'site/assets/motion');await fs.mkdir(dest,{recursive:true});
  for(const id of ['glyph','phase']){
   const make=async n=>Buffer.from(await page.evaluate(([id,n])=>motionSiteFrame(id,n/960),[id,n]),'base64');
   const first=await make(0);
   const poster=spawnSync('ffmpeg',['-y','-loglevel','error','-f','image2pipe','-i','pipe:0','-frames:v','1','-q:v','2',path.join(dest,id+'.jpg')],{input:first});
   if(poster.status!==0)throw Error(poster.stderr.toString());
   if(process.argv.includes('--posters-only'))continue;
   const output=path.join(dest,id+'.mp4'),temp=path.join(dest,id+'.rendering.mp4');
   const enc=spawn('ffmpeg',['-y','-loglevel','error','-f','image2pipe','-framerate','60','-i','pipe:0','-an','-c:v','libx264','-pix_fmt','yuv420p','-preset','medium','-crf','18','-movflags','+faststart',temp],{stdio:['pipe','inherit','inherit']});
   const done=once(enc,'close'),unique=new Set();
   for(let n=0;n<960;n++){
    const frame=n?await make(n):first;unique.add(createHash('sha256').update(frame).digest('hex'));
    if(!enc.stdin.write(frame))await once(enc.stdin,'drain');
    if((n+1)%120===0)console.log(id+': '+(n+1)+'/960 frames');
   }
   enc.stdin.end();if((await done)[0]!==0)throw Error('Encode failed: '+id);
   if(unique.size!==960)throw Error('Repeated frames in '+id);
   await fs.rename(temp,output);
   const mobile=spawnSync('ffmpeg',['-y','-loglevel','error','-i',output,'-vf','scale=960:450','-an','-c:v','libx264','-pix_fmt','yuv420p','-preset','medium','-crf','18','-movflags','+faststart',path.join(dest,id+'-mobile.mp4')]);
   if(mobile.status!==0)throw Error(mobile.stderr.toString());
   console.log(id+': 960 unique frames, 1920×900 + 960×450, 60 fps');
  }
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
