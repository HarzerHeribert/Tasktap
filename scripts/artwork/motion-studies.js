// Studio masters are rendered offline into silent loops. All coordinates are in the 736 × 352 master frame.
(() => {
  const W = 736, H = 352, TAU = Math.PI * 2;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const clamp = (x,a=0,b=1) => Math.min(b,Math.max(a,x));
  const mix = (a,b,f) => a+(b-a)*f;
  const tone = (r,g,b,a=1) => 'rgba('+[r,g,b].map(v=>Math.round(clamp(v,0,255))).join(',')+','+clamp(a)+')';
  const blend = (a,b,t) => a.map((v,i)=>mix(v,b[i],clamp(t)));
  const gauss = (x,s) => Math.exp(-x*x/(s*s));
  function halo(x,y,rx,ry,color,opacity) {
    ctx.save();
    ctx.translate(x,y);ctx.scale(rx,ry);
    const g = ctx.createRadialGradient(0,0,0,0,0,1);
    g.addColorStop(0,tone(...color,opacity));g.addColorStop(1,tone(...color,0));
    ctx.fillStyle=g;ctx.fillRect(-1,-1,2,2);ctx.restore();
  }
  function line(pts,ink,width) {
    ctx.beginPath();
    pts.forEach(([x,y],i)=>i ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
    ctx.strokeStyle=ink;ctx.lineWidth=width;ctx.stroke();
  }
  function glyph(t,small) {
    // A speech spectrogram built from individually shaded type, rising above a fixed time/frequency grid.
    const cols=small?47:83, rows=small?16:32;
    const size=small?12:8.5;
    const chars='·:+=x*%@';
    const mist=[126,203,171], light=[255,210,140], t0=t*TAU;
    halo(359,205,318,120,[36,83,66],.36);
    ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.font='600 '+size+'px Menlo,monospace';
    for (let j=0;j<rows;j++) {
      const z=j/(rows-1)*2-1;
      for (let i=0;i<cols;i++) {
        const x=i/(cols-1)*2-1;
        const phase=.13*Math.sin(t0);
        const voice=.95*gauss(x+.28+phase*.35,.28)+.68*gauss(x-.38+phase*.17,.25);
        const ridge=(.46+.54*Math.pow(Math.cos(6.3*x-2.8*z+phase),2));
        const height=(190*voice*ridge+13*gauss(x+.72,.15))*gauss(z,.7);
        const xx=369+278*x+46*z;
        const yy=225+51*z-13*x-height;
        const f=clamp(height/132), front=(z+1)/2;
        const glint=.5+.5*Math.cos(7*x-2*z-t0);
        const active=clamp(.20+f*.74+front*.15+.17*glint*voice);
        const color=blend(mist,light,clamp((height-34)/98+glint*.12));
        ctx.fillStyle=tone(...color,clamp((active*.83+.08)*(1-.5*Math.pow(Math.abs(x),5))));
        ctx.fillText(chars[Math.min(chars.length-1,Math.floor(active*(chars.length-1)+.2))],xx,yy);
      }
    }
    // Sparse major/minor ticks provide a steady reference beside the moving sample.
    for(let i=0;i<38;i++) {
      const u=i/37;
      const x=132+u*563, y=286-u*26;
      line([[x,y],[x+(i%5?2:4),y+(i%5?2:5)]],tone(135,176,155,i%5?.29:.62),small?1.5:1);
    }
  }

  function relay(t,small) {
    // Thin conductive ribbons share a bus, turn through three gates, and carry isolated packets.
    const groups=[
      {out:-73, color:[248,161,102], edge:[255,225,174]},
      {out:4, color:[100,183,159], edge:[187,231,189]},
      {out:84, color:[101,152,188], edge:[185,211,222]}
    ];
    const lines=small?7:12, t0=t*TAU;
    halo(380,183,322,138,[32,63,56],.36);
    function track(group,n,u) {
      const r=n/(lines-1), a=u*2-1;
      const taper=Math.sin(Math.PI*clamp(u));
      const ingress=(group-1)*15+(r-.5)*22;
      const width=(r-.5)*32;
      const startX=174+(group-1)*34+r*24, endX=316+group*62+r*10;
      const x=62+u*613;
      const s=clamp((x-startX)/(endX-startX));
      const bend=s*s*(3-2*s);
      const y=174 + 19*a + mix(ingress,groups[group].out+width,bend)
        -taper*(4*Math.sin(t0+group*.75)+12*Math.sin(u*Math.PI*2+group*.34))
        + 6*Math.sin(r*1.3+a)*taper;
      return [x,y];
    }
    ctx.lineCap='round';
    for(let g=2;g>=0;g--) {
      const {color,edge}=groups[g];
      for(let n=0;n<lines;n++) {
        const pts=Array.from({length:90},(_,i)=>track(g,n,i/89));
        const shade=.65+.30*Math.cos(n*.47+g);
        const gradient=ctx.createLinearGradient(58,0,677,0);
        gradient.addColorStop(0,tone(...color,.08));
        gradient.addColorStop(.15,tone(...color,.72*shade));
        gradient.addColorStop(.4,tone(...edge,shade));
        gradient.addColorStop(.59,tone(...color,.53*shade));
        gradient.addColorStop(.82,tone(...edge,.72*shade));
        gradient.addColorStop(1,tone(...color,.23*shade));
        line(pts,tone(0,4,5,.88),small?5:3.5);
        line(pts,gradient,small?3.6:2.0);
        // Packets travel independently. Fade at the terminations so the loop closes.
        if(n%3===g%3) {
          const u=(t+g*.26+n*.065)%1, amount=Math.sin(Math.PI*u)**1.8;
          const points=Array.from({length:7},(_,i)=>track(g,n,clamp(u-(6-i)*.0025)));
          line(points,tone(...edge,amount*.23),small?6:5);
          line(points,tone(...edge,amount),small?3:2);
        }
      }
      const end=track(g,(lines-1)/2,1);
      const x=end[0]+8,y=end[1];
      line([[x+4,y-19],[x,y-19],[x,y+19],[x+4,y+19]],tone(...color,.43),1);
    }
  }

  function orb(t,small) {
    const cx=374,cy=175,r=small?125:127, tt=t*TAU;
    const turn=.40+.16*Math.sin(tt), tilt=-.27, lean=-.20;
    function project(lon,lat,radius=r) {
      const x=Math.cos(lat)*Math.sin(lon+turn), y=Math.sin(lat), z=Math.cos(lat)*Math.cos(lon+turn);
      const yp=y*Math.cos(tilt)-z*Math.sin(tilt), zp=y*Math.sin(tilt)+z*Math.cos(tilt);
      return [cx+radius*(x*Math.cos(lean)-yp*Math.sin(lean)),cy-radius*(yp*Math.cos(lean)+x*Math.sin(lean)),zp];
    }
    halo(cx,cy,188,159,[34,104,114],.29);
    const globe=ctx.createRadialGradient(cx-65,cy-58,6,cx+15,cy+8,r*1.3);
    [[0,'#36575a'],[.38,'#173f45'],[.72,'#102b37'],[.90,'#416468'],[1,'#142c30']].forEach(([p,col])=>globe.addColorStop(p,col));
    ctx.beginPath();ctx.arc(cx,cy,r,0,TAU);ctx.fillStyle=globe;ctx.fill();
    // Visible surface samples form continuous geodesic bands on an obliquely mounted globe.
    const parallels=small?35:60;
    for(let j=1;j<parallels;j++) {
      const lat=(j/parallels-.5)*Math.PI, count=Math.max(8,Math.floor((small?118:218)*Math.cos(lat)));
      for(let k=0;k<count;k++) {
        const lon=k/count*TAU, [x,y,z]=project(lon,lat);
        if(z<0)continue;
        const band=Math.sin(4*lon-5*lat+1.75*Math.sin(2.1*lat+lon))+ .65*Math.cos(7*lat+2.94*lon);
        const shell=(.5+.5*Math.sin(2*lon+3*lat))*(.4+.6*(1-z));
        const brilliance=clamp(.13+shell*.48+.68*gauss(band-.31,.26));
        const a=tone(139+60*brilliance,187+43*brilliance,181+50*brilliance,brilliance);
        const s=(small?1.45:.86)+brilliance*.64;
        ctx.fillStyle=a;ctx.fillRect(x-s/2,y-s/2,s,s);
      }
    }
    ctx.beginPath();ctx.arc(cx,cy,r+.1,0,TAU);ctx.strokeStyle='rgba(171,224,216,.74)';ctx.lineWidth=1;ctx.stroke();
    // Thin survey meridians intersect the point cloud at a handful of fixed engineering fiducials.
    for(const lon of [-1.05,-.20,.79]) {
      const arch=[];
      for(let i=0;i<=92;i++){
        const pos=project(lon,-1.39+i/92*2.78,r+.4);
        if(pos[2]>0)arch.push(pos);
      }
      line(arch,tone(154,226,217,.38),.7);
      for(const lat of [-.70,.08,.80]){
        const [x,y,z]=project(lon,lat,r+.6);
        if(z<.08)continue;
        ctx.strokeStyle=tone(170,224,206,.76);ctx.lineWidth=.7;
        ctx.strokeRect(x-2,y-2,4,4);
      }
    }
    // A warm scanning meridian sweeps a short arc through the cyan point cloud.
    const scan=.28+.56*Math.sin(tt+.4);
    const path=[];
    for(let i=0;i<=125;i++) {
      const lat=mix(-1.48,1.48,i/125), point=project(scan,lat,r+.5);
      if(point[2]>=0)path.push(point);
    }
    line(path,tone(245,173,91,.24),5);line(path,tone(255,206,132,.93),1.35);
    const marker=project(scan,.24+.58*Math.sin(tt-.4),r+1);
    halo(marker[0],marker[1],11,11,[255,193,112],.54);
    ctx.fillStyle='#ffdfaa';ctx.fillRect(marker[0]-2,marker[1]-2,4,4);
    // Short arcs and engraved ticks sit outside the surface as a stable instrument edge.
    for(let i=0;i<112;i++) {
      if(i%28>17)continue;
      const a=i/112*TAU-.20, short=i%4?2:5;
      const rad=r+11;
      line([[cx+rad*Math.cos(a),cy+rad*Math.sin(a)],[cx+(rad+short)*Math.cos(a),cy+(rad+short)*Math.sin(a)]],tone(133,187,183,i%4?.28:.65),1);
    }
    for(const side of [-1,1]) {
      const x=cx+side*(r+34);
      line([[x,cy],[x+side*34,cy]],tone(115,174,165,.48),1);
      line([[x+side*17,cy-3],[x+side*17,cy+3]],tone(176,212,197,.66),1);
    }
  }

  let renderPhase;
  async function prepareShader() {
    if(renderPhase)return;
    const target=document.createElement('canvas');
    const gl=target.getContext('webgl',{alpha:false,antialias:false,preserveDrawingBuffer:true});
    if(!gl)throw Error('WebGL is required to render the Phase field master.');
    const compile=(type,source)=>{
      const shader=gl.createShader(type);
      gl.shaderSource(shader,source);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const program=gl.createProgram();
    gl.attachShader(program,compile(gl.VERTEX_SHADER,'attribute vec2 position;void main(){gl_Position=vec4(position,0.,1.);}'));
    gl.attachShader(program,compile(gl.FRAGMENT_SHADER,window.phaseShaderSource));
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const quad=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,quad);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
    const pos=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(pos);gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);
    const time=gl.getUniformLocation(program,'time'), size=gl.getUniformLocation(program,'resolution'), mini=gl.getUniformLocation(program,'miniature');
    renderPhase=(t,small,width,height)=>{
      if(target.width!==width ||target.height!==height){target.width=width;target.height=height;}
      gl.viewport(0,0,width,height);
      gl.uniform2f(size,width,height);gl.uniform1f(time,t*TAU);gl.uniform1f(mini,small?1:0);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
      ctx.drawImage(target,0,0,W,H);
    };
  }
  window.motionFrame = async (id,small,t) => {
    canvas.width=small?260:W;canvas.height=small?156:H;
    ctx.setTransform(canvas.width/W,0,0,canvas.height/H,0,0);
    ctx.fillStyle='#030706';ctx.fillRect(0,0,W,H);
    if(id==='phase'){await prepareShader();renderPhase(t,small,canvas.width,canvas.height);}
    else {
      // The miniature keeps its circular instruments round, with fewer glyphs and heavier traces.
      if(small){
        const scale=id==='orbit'?.50:.39;
        ctx.setTransform(scale,0,0,scale,(canvas.width-W*scale)/2,(canvas.height-H*scale)/2);
      }
      ({glyph,relay,orbit:orb})[id](t,small);
    }
    return canvas.toDataURL('image/png').split(',')[1];
  };
})();
