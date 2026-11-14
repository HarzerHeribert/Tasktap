// Offline studio rig. Each study is a solid with surface normals, rendered at 2× and
// downsampled once. Miniatures use fewer pieces and their own framing.
(() => {
  const tau=2*Math.PI;
  const clamp=(x,lo=0,hi=1)=>Math.min(hi,Math.max(lo,x));
  const lerp=(a,b,t)=>a+(b-a)*t;
  const add=(a,b)=>a.map((x,i)=>x+b[i]);
  const sub=(a,b)=>a.map((x,i)=>x-b[i]);
  const mul=(a,k)=>a.map(x=>x*k);
  const dot=(a,b)=>a.reduce((sum,x,i)=>sum+x*b[i],0);
  const unit=a=>mul(a,1/(Math.hypot(...a)||1));
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const nickel=[.99,1.0,.98], steel=[.76,.86,.93], brass=[1.0,.83,.65], gunmetal=[.30,.38,.41];
  const state={vertices:[],time:0,mini:false};
  function rotate([x,y,z],[rx,ry,rz]) {
    let a=y*Math.cos(rx)-z*Math.sin(rx), b=y*Math.sin(rx)+z*Math.cos(rx);
    let c=x*Math.cos(ry)+b*Math.sin(ry), d=-x*Math.sin(ry)+b*Math.cos(ry);
    return [c*Math.cos(rz)-a*Math.sin(rz),c*Math.sin(rz)+a*Math.cos(rz),d];
  }
  function mesh(rows,cols,point) {
    const grid=Array.from({length:rows+1},(_,i)=>Array.from({length:cols+1},(_,j)=>point(i/rows,j/cols)));
    for(let i=0;i<rows;i++)for(let j=0;j<cols;j++){
      const a=grid[i][j],b=grid[i+1][j],c=grid[i+1][j+1],d=grid[i][j+1];
      state.vertices.push(...a,...b,...c,...a,...c,...d);
    }
  }
  const vertex=(p,n,color)=>[...p,...n,...color];
  function install(transparent=false,brand=false,brandWidth=384) {
    const canvas=document.createElement('canvas');
    const gl=canvas.getContext('webgl',{alpha:transparent,antialias:true,preserveDrawingBuffer:true});
    const out=document.createElement('canvas'), ctx=out.getContext('2d',{alpha:transparent||brand});
    if(!gl)throw Error('WebGL is required by the offline motion renderer.');
    const compile=(type,source)=>{
      const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));
      return s;
    };
    const program=gl.createProgram();
    gl.attachShader(program,compile(gl.VERTEX_SHADER,`
      attribute vec3 pos, norm, metal;
      varying vec3 position, normal, alloy;
      uniform float aspect, zoom;
      void main(){
        position=pos;normal=norm;alloy=metal;
        float w=1.-pos.z/6.8;
        gl_Position=vec4(zoom*pos.x/aspect,zoom*pos.y,-.18*pos.z,w);
      }`));
    gl.attachShader(program,compile(gl.FRAGMENT_SHADER,window.phaseShaderSource));
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    for(const [name,offset] of [['pos',0],['norm',3],['metal',6]]){
      const loc=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc,3,gl.FLOAT,false,36,offset*4);
    }
    const u=name=>gl.getUniformLocation(program,name);
    gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.clearColor(...(transparent?[0,0,0,0]:brand?[.018,.022,.027,1]:[.007,.012,.014,1]));
    return (id,mini,t,symbol)=>{
      const width=brand?brandWidth:transparent?96:mini?260:736,height=brand?brandWidth:transparent?96:mini?156:352, samples=transparent?4:mini?3:2;
      if(canvas.width!==width*samples||canvas.height!==height*samples){canvas.width=width*samples;canvas.height=height*samples;}
      gl.viewport(0,0,canvas.width,canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      state.time=t*tau;state.mini=mini;state.vertices.length=0;
      if(brand) voiceMark();
      else if(transparent) glyphMark(symbol,[0,0,0],1.23,[-.24,.19,-.045],nickel);
      else if(id==='relay-bed')relay(false);
      else ({glyph,phase,relay,orbit})[id]();
      gl.uniform1f(u('time'),state.time);gl.uniform1f(u('aspect'),width/height);
      gl.uniform1f(u('zoom'),mini && id!=='orbit'?.82:1.0);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(state.vertices),gl.STREAM_DRAW);
      gl.drawArrays(gl.TRIANGLES,0,state.vertices.length/9);
      out.width=width;out.height=height;
      if(brand){
        // A shared full-face square silhouette for the app and animated web mark.
        const unit=width/1024;
        ctx.beginPath();ctx.roundRect(80*unit,80*unit,864*unit,864*unit,190*unit);ctx.clip();
      }
      ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
      ctx.drawImage(canvas,0,0,width,height);
      return out.toDataURL('image/png').split(',')[1];
    };
  }

  // Round rectangular bar with a chamfer roll around its front. The center is slightly
  // crowned to carry the softbox reflection continuously across the face.
  function bar(center,length,width,depth,rot,color) {
    const r=Math.min(width*.25,depth*.48);
    function ring(a,inset){
      const cx=length/2-r,cy=width/2-r, quadrant=Math.floor(a*4)%4;
      const angle=quadrant*Math.PI/2+(a*4-Math.floor(a*4))*Math.PI/2;
      const sx=quadrant===0||quadrant===3?1:-1,sy=quadrant<2?1:-1;
      return [sx*cx+Math.cos(angle)*(r-inset),sy*cy+Math.sin(angle)*(r-inset),Math.cos(angle),Math.sin(angle)];
    }
    // Each corner includes its final tangent; the gap between corners makes a flat side.
    function outline(inset){
      const result=[];
      for(let q=0;q<4;q++)for(let k=0;k<=4;k++){
        const a=(q+k/4)/4;
        if(k<4)result.push(ring(a,inset));
        else {
          const sx=q===0||q===3?1:-1,sy=q<2?1:-1,angle=(q+1)*Math.PI/2;
          result.push([sx*(length/2-r)+Math.cos(angle)*(r-inset),sy*(width/2-r)+Math.sin(angle)*(r-inset),Math.cos(angle),Math.sin(angle)]);
        }
      }
      return result;
    }
    const placed=(pos,n)=>vertex(add(center,rotate(pos,rot)),rotate(unit(n),rot),color);
    const bevel=Math.min(r*.80,depth*.31);
    const crossSection=[[-depth*.5,0,0], [depth*.5-bevel,0,0]];
    for(let i=1;i<=4;i++){
      const a=i*Math.PI/8;
      crossSection.push([depth*.5-bevel+bevel*Math.sin(a),bevel*(1-Math.cos(a)),a]);
    }
    const layers=crossSection.map(([z,inset,a])=>outline(inset).map(([x,y,nx,ny])=>
      placed([x,y,z],[nx*Math.cos(a)+.09*x/length,ny*Math.cos(a)+.15*y/width,Math.sin(a)])));
    const count=layers[0].length;
    for(let i=0;i<layers.length-1;i++)for(let j=0;j<count;j++){
      const next=(j+1)%count,a=layers[i][j],b=layers[i][next],c=layers[i+1][next],d=layers[i+1][j];
      state.vertices.push(...a,...b,...c,...a,...c,...d);
    }
    const top=layers.at(-1),mid=placed([0,0,depth*.5+.002],[0,0,1]);
    for(let i=0;i<count;i++)state.vertices.push(...mid,...top[i],...top[(i+1)%count]);
  }
  function glyphMark(symbol,center,r,rot,color) {
    function stroke(dx,dy,length,width,angle){
      const c=add(center,rotate([dx*r,dy*r,0],rot));
      bar(c,r*length,r*width,r*.42,[...rot.slice(0,2),rot[2]+angle],color);
    }
    switch(symbol){
      case '/':stroke(0,0,1.22,.38,1.07);break;
      case '=':stroke(0,-.23,1.13,.27,0);stroke(0,.23,1.13,.27,0);break;
      case ':':stroke(0,-.29,.41,.37,0);stroke(0,.29,.41,.37,0);break;
      case '+':stroke(0,0,1.12,.35,0);stroke(0,0,1.1,.35,Math.PI/2);break;
    }
  }
  function voiceMark() {
    // The same milled bars, studio shader and traveling crests as the in-app studies.
    for(let i=0;i<19;i++){
      const u=i/18, beat=tau*u-state.time;
      const envelope=Math.pow(Math.sin(Math.PI*u),.8);
      const height=.14+envelope*(.42+.65*Math.pow(.5+.5*Math.cos(beat),2));
      const y=-.03+.10*Math.sin(beat)*envelope;
      bar([(u-.5)*1.42,y,.04*Math.cos(beat)],height,.045,.085,
          [.12*Math.sin(beat),.20*Math.cos(beat),Math.PI/2],i===6?brass:i>13?steel:nickel);
    }
  }

  function glyph() {
    const count=state.mini?7:15;
    const symbols='/=:+';
    const radius=state.mini?.28:.163;
    const pairs=state.mini?1:2;
    for(let i=0;i<count;i++){
      const u=i/(count-1);
      const beat=tau*(u-.32)-state.time;
      // A broad crest and its smaller echo pass each column once per loop. Marks
      // unfold from the middle of each stack, then tuck away on the trailing edge.
      const crest=Math.pow(.5+.5*Math.cos(beat),state.mini?4:7);
      const echo=.74*Math.pow(.5+.5*Math.cos(beat-2.66),state.mini?5:9);
      const envelope=crest+echo;
      const x=(u-.5)*3.33+.038*Math.sin(beat);
      const spine=.16*Math.sin(beat+.32)+.038*Math.sin(2*beat);
      const color=i===Math.floor(count*.36)?brass:i>count*.70?steel:nickel;
      for(let row=-pairs;row<=pairs;row++){
        const level=Math.abs(row);
        const open=level===0?1:clamp((envelope*pairs-level+1)*1.35);
        const weight=open*open*(3-2*open);
        if(weight<.005)continue;
        const y=spine+row*radius*(1.20+.42*envelope);
        const rot=[-.24+.32*Math.sin(beat+.28*row),.10+.38*Math.cos(beat-.22*row),-.045+.12*Math.sin(beat)];
        const center=[x+row*.023*Math.sin(beat),lerp(spine,y,weight),.13*Math.cos(beat)+.035*row];
        glyphMark(symbols[(i+row+pairs)%symbols.length],center,radius*weight,rot,color);
      }
    }
  }

  // A closed swept oval section makes a substantial twisted phase ribbon. Derivatives
  // produce continuous normals across the entire face and both rolled edges.
  function phase() {
    const t=state.time;
    function p(u,v) {
      const x=(u-.5)*3.48, a=v*tau;
      const env=.66+.34*Math.sin(u*Math.PI);
      // The mounts hold their pose while a torsional wave rolls along the span.
      // At the loop seam both the surface and its velocity meet continuously.
      const travel=.92*Math.sin(Math.PI*u);
      const roll=1.46*tau*u-.77, bend=tau*1.22*u-.57;
      const twist=.43+1.57*lerp(Math.sin(roll),Math.sin(roll-t),travel);
      const spine=.29*lerp(Math.sin(bend),Math.sin(bend-t),travel);
      const radial=.42*env*Math.cos(a), depth=.091*Math.sin(a);
      return [x+.027*Math.sin(a),spine+
        radial*Math.cos(twist)-depth*Math.sin(twist),radial*Math.sin(twist)+depth*Math.cos(twist)+.11*Math.cos(tau*u+.32)];
    }
    mesh(112,44,(u,v)=>{
      const u0=clamp(u-.001),u1=clamp(u+.001);
      const n=unit(cross(sub(p(u1,v),p(u0,v)),sub(p(u,v+.001),p(u,v-.001))));
      const tint=.5+.5*Math.sin(u*tau-1.3);
      return vertex(p(u,v),n,[lerp(.83,1.,tint),lerp(.93,.97,tint),lerp(1.,.85,tint)]);
    });
  }

  function tube(path,radius,color,steps=76,sides=22) {
    mesh(steps,sides,(u,v)=>{
      const center=path(u);
      const tangent=unit(sub(path(clamp(u+.001)),path(clamp(u-.001))));
      const normal=unit(cross([0,0,1],tangent));
      const binormal=unit(cross(tangent,normal));
      const n=add(mul(normal,Math.cos(v*tau)),mul(binormal,Math.sin(v*tau)));
      return vertex(add(center,mul(n,radius)),n,color);
    });
  }
  function ellipsoid(center,radii,rot,color,rows=20,cols=46,latBounds=[-Math.PI/2,Math.PI/2],lonBounds=[0,tau]){
    mesh(rows,cols,(u,v)=>{
      const lat=lerp(...latBounds,u),lon=lerp(...lonBounds,v);
      const direction=[Math.cos(lat)*Math.sin(lon),Math.sin(lat),Math.cos(lat)*Math.cos(lon)];
      const n=unit(direction.map((c,i)=>c/radii[i]));
      return vertex(add(center,rotate(direction.map((c,i)=>c*radii[i]),rot)),rotate(n,rot),color);
    });
  }
  // Each sleeve follows the tangent of its guide, including through the bend.
  function sleeve(route,u,offset,length,radius,color){
    const center=route(u);
    const axis=unit(sub(route(clamp(u+.002)),route(clamp(u-.002))));
    const right=unit(cross([0,0,1],axis)), up=cross(axis,right);
    const profile=[[-.5,.52],[-.5,.86],[-.39,1],[.39,1],[.5,.86],[.5,.52]];
    for(let k=1;k<profile.length;k++){
      const [a,r0]=profile[k-1], [b,r1]=profile[k];
      mesh(1,20,(s,v)=>{
        const radial=add(mul(right,Math.cos(v*tau)),mul(up,Math.sin(v*tau)));
        const normal=unit(add(mul(radial,(b-a)*length),mul(axis,-(r1-r0)*radius)));
        const p=add(center,add(mul(axis,offset+lerp(a,b,s)*length),mul(radial,radius*lerp(r0,r1,s))));
        return vertex(p,normal,color);
      });
    }
  }
  function relay(moving=true) {
    const t=state.time;
    const colors=[brass,nickel,steel];
    // Cross-braces connect the three guide bushings behind the rails.
    for(const u of [.25,.84]){
      const a=relayPoint(u,0,t), b=relayPoint(u,2,t);
      bar([a[0],(a[1]+b[1])/2,-.13],b[1]-a[1]+.24,.080,.085,[0,.08,Math.PI/2],gunmetal);
    }
    for(let i=0;i<3;i++){
      const route=u=>relayPoint(u,i,t);
      const r=state.mini?.052:.042;
      tube(route,r,colors[i]);
      for(const u of [.25,.84]){
        sleeve(route,u,0,.072,r*1.68,gunmetal);
        sleeve(route,u,-.025,.022,r*1.75,nickel);
      }
      for(const u of [.012,.977]){
        sleeve(route,u,0,.11,r*1.64,steel);
        sleeve(route,u,.041,.029,r*1.80,colors[i]);
      }
      if(!moving)continue;
      const u=.50-.42*Math.cos(t-i*1.47);
      sleeve(route,u,0,.25,r*2.12,colors[i]);
      for(const side of [-1,1]){
        sleeve(route,u,side*.082,.031,r*2.24,gunmetal);
        sleeve(route,u,side*.123,.045,r*2.36,nickel);
      }
    }
  }
  function orbit() {
    const t=state.time;
    const rot=[.34+.16*Math.sin(t),.34+t,-.46];
    const center=[0,0,-.05],r=.64;
    // Removable shell panels expose a separate rotor at the equator.
    ellipsoid(center,[r*.87,r*.87,r*.87],rot,gunmetal,32,64);
    for(let j=0;j<4;j++){
      const sector=[j*tau/4+.045,(j+1)*tau/4-.045];
      ellipsoid(center,[r,r,r],rot,nickel,24,24,[-Math.PI/2,-.14],sector);
      ellipsoid(center,[r,r,r],rot,steel,24,24,[.14,Math.PI/2],sector);
    }
    function ring(radius,width,angles,color,from=0,to=tau) {
      mesh(Math.max(8,Math.ceil(104*(to-from)/tau)),16,(u,v)=>{
        const a=lerp(from,to,u),b=v*tau,normal=[Math.cos(a)*Math.cos(b),Math.sin(a)*Math.cos(b),Math.sin(b)];
        const local=[radius*Math.cos(a)+width*normal[0],radius*Math.sin(a)+width*normal[1],width*normal[2]];
        return vertex(add(center,rotate(local,angles)),rotate(normal,angles),color);
      });
    }
    const equator=[rot[0]-Math.PI/2,rot[1],rot[2]];
    for(let j=0;j<8;j++){
      const start=j*tau/8-t;
      ring(.602,.024,equator,j%2?brass:nickel,start,start+tau/8-.13);
    }
    const inner=[1.14+.29*Math.sin(t),.31*Math.cos(t),-.66+.18*Math.sin(t)];
    ring(.715,.027,inner,brass);
    // A separate scan head rides above the shell on an inclined carrier. Its
    // nickel collar and blue lens read as one assembly at notch size.
    const carrier=[1.03,-.36,-.16], angle=t+.42, radius=.84;
    ring(radius,.012,carrier,steel);
    const head=add(center,rotate([radius*Math.cos(angle),radius*Math.sin(angle),0],carrier));
    ellipsoid(head,[.111,.111,.111],[0,0,0],gunmetal,12,28);
    const lens=add(head,[0,0,.081]);
    ellipsoid(lens,[.092,.092,.036],[0,0,0],nickel,10,28);
    ellipsoid(add(lens,[0,0,.026]),[.067,.067,.026],[0,0,0],[.42,.76,.86],10,24);
    const outer=[.43+.30*Math.sin(t),.80+.36*Math.cos(t),.24];
    for(let sector=0;sector<3;sector++){
      const start=sector*tau/3+t+.1;
      const end=start+tau/3-.32;
      ring(.836,.024,outer,nickel,start,end);
      const pin=add(center,rotate([.836*Math.cos(end),.836*Math.sin(end),0],outer));
      ellipsoid(pin,[.046,.046,.046],outer,brass,10,20);
    }
  }
  // Render each cell around the optical axis to preserve the metal's reflection angles.
  window.glyphSprite = async () => {
    const paint=install(true), atlas=document.createElement('canvas');
    atlas.width=384; atlas.height=96;
    const ctx=atlas.getContext('2d');
    for (const [index,symbol] of [...'/=:+'].entries()) {
      const image=new Image();
      image.src='data:image/png;base64,'+paint('glyph',false,0,symbol);
      await image.decode();
      ctx.drawImage(image,index*96,0);
    }
    return atlas.toDataURL('image/png').split(',')[1];
  };
  let appRender;
  window.appIconFrame = () => {appRender ||= install(false,true,1024);return appRender("brand",false,0);};
  let brandRender;
  window.brandFrame = t => {brandRender ||= install(false,true);return brandRender("brand",false,t);};
  let render;
  window.motionFrame = (id,mini,t) => {render ||= install();return render(id,mini,t);};
})();
