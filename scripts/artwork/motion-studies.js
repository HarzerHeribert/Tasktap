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
  function install(transparent=false) {
    const canvas=document.createElement('canvas');
    const gl=canvas.getContext('webgl',{alpha:transparent,antialias:true,preserveDrawingBuffer:true});
    const out=document.createElement('canvas'), ctx=out.getContext('2d',{alpha:transparent});
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
    gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.clearColor(...(transparent?[0,0,0,0]:[.007,.012,.014,1]));
    return (id,mini,t,symbol)=>{
      const width=transparent?96:mini?260:736,height=transparent?96:mini?156:352, samples=transparent?4:mini?3:2;
      if(canvas.width!==width*samples||canvas.height!==height*samples){canvas.width=width*samples;canvas.height=height*samples;}
      gl.viewport(0,0,canvas.width,canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      state.time=t*tau;state.mini=mini;state.vertices.length=0;
      if(transparent) glyphMark(symbol,[0,0,0],1.23,[-.24,.19,-.045],nickel);
      else ({glyph,phase,relay,orbit})[id]();
      gl.uniform1f(u('time'),state.time);gl.uniform1f(u('aspect'),width/height);
      gl.uniform1f(u('zoom'),mini && id!=='orbit'?.82:1.0);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(state.vertices),gl.STREAM_DRAW);
      gl.drawArrays(gl.TRIANGLES,0,state.vertices.length/9);
      out.width=width;out.height=height;ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
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
  function glyph() {
    const count=state.mini?7:15;
    const stacks=state.mini?[1,2,3,2,1,2,1]:[1,1,2,3,4,5,3,2,1,2,3,4,3,2,1];
    const symbols='/=:+';
    for(let i=0;i<count;i++){
      const u=i/(count-1),x=(u-.5)*3.33, rows=stacks[i];
      const r=state.mini?.28:.163, wave=.95+.10*Math.sin(state.time+u*5);
      for(let j=0;j<rows;j++){
        const y=(j-(rows-1)/2)*r*1.62*wave+.10*Math.sin(u*5.5)+.015*Math.sin(state.time+u*tau);
        const rot=[-.24+.13*Math.sin(u*5+state.time),.24*Math.sin(5*u+state.time)+.08,-.045];
        const center=[x,y,.04*Math.sin(6*u+j*.4)];
        const color=i===Math.floor(count*.36)?brass:i>count*.70?steel:nickel;
        glyphMark(symbols[(i+j)%symbols.length],center,r,rot,color);
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
      const twist=.43+1.57*Math.sin(1.46*tau*u-.77+.13*Math.sin(t));
      const radial=.42*env*Math.cos(a), depth=.091*Math.sin(a);
      return [x+.027*Math.sin(a),.29*Math.sin(u*tau*1.22-.57+.12*Math.sin(t))+
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
  function ellipsoid(center,radii,rot,color,rows=20,cols=46,latBounds=[-Math.PI/2,Math.PI/2]){
    mesh(rows,cols,(u,v)=>{
      const lat=lerp(...latBounds,u),lon=v*tau;
      const direction=[Math.cos(lat)*Math.sin(lon),Math.sin(lat),Math.cos(lat)*Math.cos(lon)];
      const n=unit(direction.map((c,i)=>c/radii[i]));
      return vertex(add(center,rotate(direction.map((c,i)=>c*radii[i]),rot)),rotate(n,rot),color);
    });
  }
  function relay() {
    const t=state.time;
    const colors=[brass,nickel,steel];
    for(let i=0;i<3;i++){
      const route=u=>relayPoint(u,i,t);
      const r=state.mini?.067:.06;
      tube(route,r,colors[i]);
      // Rounded terminations and nickel collars give each runner a real destination socket.
      for(const u of [0,1]){
        const c=route(u);
        ellipsoid(c,[r,r,r],[0,0,0],colors[i],8,22);
      }
      const c=route(.965);
      ellipsoid(c,[.075,.10,.10],[0,0,0],gunmetal,12,32);
      const collar=route(.984);
      ellipsoid(collar,[.042,.101,.101],[0,0,0],colors[i],12,36);
    }
  }
  function orbit() {
    const t=state.time;
    const rot=[.34+.08*Math.sin(t),.34+.17*Math.cos(t),-.46];
    const center=[0,0,-.05],r=.64;
    // Two machined shell halves float above a recessed ceramic core at the equatorial seam.
    ellipsoid(center,[r*.94,r*.94,r*.94],rot,gunmetal,40,84);
    ellipsoid(center,[r,r,r],rot,nickel,30,88,[-Math.PI/2,-.098]);
    ellipsoid(center,[r,r,r],rot,steel,30,88,[.098,Math.PI/2]);
    function ring(radius,width,angles,color,from=0,to=tau) {
      mesh(116,16,(u,v)=>{
        const a=lerp(from,to,u),b=v*tau,normal=[Math.cos(a)*Math.cos(b),Math.sin(a)*Math.cos(b),Math.sin(b)];
        const local=[radius*Math.cos(a)+width*normal[0],radius*Math.sin(a)+width*normal[1],width*normal[2]];
        return vertex(add(center,rotate(local,angles)),rotate(normal,angles),color);
      });
    }
    ring(.715,.027,[1.14+.08*Math.sin(t),.18,-.66],brass);
    const outer=[.43,.80+.13*Math.sin(t),.24];
    ring(.805,.018,outer,nickel,.13,tau-.16);
    for(const a of [.13,tau-.16]){
      const c=add(center,rotate([.805*Math.cos(a),.805*Math.sin(a),0],outer));
      ellipsoid(c,[.032,.032,.032],[0,0,0],brass,8,20);
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
  let render;
  window.motionFrame = (id,mini,t) => {render ||= install();return render(id,mini,t);};
})();
