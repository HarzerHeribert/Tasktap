// Usage: node scripts/render-motion.cjs [--posters-only] [glyph|phase|relay|orbit]
// Pass --app-icon to render the matching macOS icon and its full ICNS size set.
// Pass --public-icons to render the public wave mark and its seamless WebP loop.
// Pass --glyph-sprite to regenerate only the transparent live meter sprite.
// Pass --home for only the 1200×240, 60fps, 16-second Home compositions.
// This covers Glyph, Phase, Relay and Orbit. The separately authored Blender
// Resonator keeps its original native-frame-rate clip; no frame interpolation.
// Authoring tools: Playwright with Chromium, ffmpeg and (optional) BROWSER_EXECUTABLE.
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');

const base = path.resolve(__dirname,'..');
const art = path.join(__dirname,'artwork');
const postersOnly = process.argv.includes('--posters-only');
const home = process.argv.includes('--home');
const studies = ['glyph','phase','relay','orbit'].filter(id=>
  !process.argv.slice(2).some(a=>!a.startsWith('--')) || process.argv.includes(id)
);
(async () => {
  const browser = await chromium.launch({
    headless:true, executablePath:process.env.BROWSER_EXECUTABLE,
    args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']
  });
  try {
    const page = await browser.newPage();
    await page.evaluate(source=>{window.phaseShaderSource=source},await fs.readFile(path.join(art,'phase.frag'),'utf8'));
    await page.addScriptTag({path:path.join(base,'prototype/relay-path.js')});
    await page.addScriptTag({path:path.join(art,'motion-studies.js')});
    if(process.argv.includes('--app-icon')) {
      const dest=path.join(base,'prototype/assets/resonator');
      const temp=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'tasktap-icon-'));
      const run=(command,args)=>{
        const result=spawnSync(command,args);
        if(result.status!==0)throw Error(result.stderr.toString());
      };
      try {
        const master=path.join(dest,'Tasktap.png'), iconset=path.join(temp,'Tasktap.iconset');
        await fs.mkdir(iconset);
        // Render directly into the square icon: full-face wave on a near-black background.
        await fs.writeFile(master,Buffer.from(await page.evaluate(()=>window.appIconFrame()),'base64'));
        for(const points of [16,32,128,256,512])for(const scale of [1,2]) {
          run('magick',[master,'-resize',`${points*scale}x${points*scale}`,'-strip',
            path.join(iconset,`icon_${points}x${points}${scale===2?'@2x':''}.png`)]);
        }
        run('iconutil',['-c','icns','-o',path.join(dest,'Tasktap.icns'),iconset]);
        console.log('Rendered macOS icon master and Tasktap.icns');
      } finally { await fs.rm(temp,{recursive:true,force:true}); }
      return;
    }
    if(process.argv.includes('--public-icons')) {
      const dest=path.join(base,'site/assets');
      const frame=async t=>Buffer.from(await page.evaluate(t=>window.brandFrame(t),t),'base64');
      const still=await frame(0);
      await fs.writeFile(path.join(dest,'tasktap-icon.png'),still);
      for(const [size,name] of [[180,'apple-touch-icon.png'],[32,'favicon.png']]) {
        const result=spawnSync('magick',['png:-','-resize',`${size}x${size}`,'-background','none','-gravity','center','-extent',`${size}x${size}`,path.join(dest,name)],{input:still});
        if(result.status!==0)throw Error(result.stderr.toString());
      }
      const frames=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'tasktap-brand-'));
      try {
        const names=[];
        for(let n=0;n<96;n++) {
          const name=path.join(frames,`${String(n).padStart(3,'0')}.png`);
          await fs.writeFile(name,n?await frame(n/96):still);names.push(name);
        }
        const result=spawnSync('magick',['-delay','1x24',...names,'-loop','0','-quality','82',path.join(dest,'tasktap-icon.webp')]);
        if(result.status!==0)throw Error(result.stderr.toString());
      } finally { await fs.rm(frames,{recursive:true,force:true}); }
      await fs.writeFile(path.join(dest,'mark.svg'),'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect x="3" y="3" width="34" height="34" rx="7.5" fill="#050607"/><path d="M8 19v3m4-8v13m4-15v15m4-12v14m4-11v12m4-13v12m4-9v5" fill="none" stroke="#dce4e8" stroke-width="2" stroke-linecap="round"/><path d="M16 12v15" stroke="#dfbf94" stroke-width="2" stroke-linecap="round"/></svg>\n');
      console.log('Rendered public wave mark, favicon and four-second motion loop');
      return;
    }
    if (!home && (process.argv.includes('--glyph-sprite') || studies.includes('glyph'))) {
      const dir=path.join(base,'prototype/assets/motion/glyph');
      await fs.mkdir(dir,{recursive:true});
      const sprite=await page.evaluate(()=>window.glyphSprite());
      await fs.writeFile(path.join(dir,'type.png'),Buffer.from(sprite,'base64'));
      if(process.argv.includes('--glyph-sprite'))return;
    }
    const fps=home?60:48, total=fps*(home?16:4);
    for(const id of studies) {
      const dest=path.join(base,'prototype/assets/motion',id);
      await fs.mkdir(dest,{recursive:true});
      for(const size of home?['home']:['stage','miniature']) {
        const make = async (n,scene=id) => Buffer.from(await page.evaluate(
          ([id,size,t])=>size==='home'?window.motionHomeFrame(id,t):window.motionFrame(id,size==='miniature',t),[scene,size,n/total]
        ),'base64');
        const frame = await make(0);
        const poster=(name,input)=>{
          const jpg=spawnSync('ffmpeg',['-y','-loglevel','error','-f','image2pipe','-i','pipe:0','-frames:v','1','-q:v','2',path.join(dest,name+'.jpg')],{input});
          if(jpg.status!==0)throw Error(jpg.stderr.toString());
        };
        poster(size,frame);
        if(id==='relay' && size==='stage')poster('bed',await make(0,'relay-bed'));
        if(postersOnly)continue;
        const started=Date.now();
        const unique=new Set(),output=path.join(dest,size+'.mp4'),temporary=home?path.join(dest,'.home-'+process.pid+'.mp4'):output;
        const enc=spawn('ffmpeg',['-y','-loglevel','error','-f','image2pipe','-framerate',String(fps),'-i','pipe:0','-an','-vcodec','libx264','-profile:v','main','-level',home?'3.2':'3.1','-pix_fmt','yuv420p','-preset','slow','-crf',size==='miniature'?'19':'18','-movflags','+faststart',temporary],{stdio:['pipe','inherit','inherit']});
        const done=once(enc,'close');
        for(let n=0;n<total;n++) {
          const sample=n?await make(n):frame;
          if(home)unique.add(createHash('sha256').update(sample).digest('hex'));
          if(!enc.stdin.write(sample))await once(enc.stdin,'drain');
          if(home&&(n+1)%120===0)console.log(`${id}: ${n+1}/${total} unique source frames (${((Date.now()-started)/1000).toFixed(1)}s)`);
        }
        enc.stdin.end();
        if((await done)[0]!==0)throw Error('ffmpeg failed to encode '+id);
        if(home){
          if(unique.size!==total){await fs.rm(temporary,{force:true});throw Error(`${id}: expected ${total} unique source frames, got ${unique.size}`)}
          await fs.rename(temporary,output);
          console.log(`${id}: verified ${unique.size} unique source samples; ${fps}fps / 16s at 1× playback`);
        }
      }
      console.log('Rendered '+id);
    }
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
