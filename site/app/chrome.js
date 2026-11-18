const e=[[0,.3,1,0,0,0,0,.2],[1,.5,1,0,0,0,0,.28],[0,2,1,0,0,0,0,.22],[0,1,1,0,0,0,0,.28],[0,.5,1,0,0,0,0,.22],[0,0,1,0,0,0,0,.85],[0,0,1,0,0,0,0,.1]],t={chrome:{a:[.86,.93,1],b:[1,.8,.58],irid:0},chromatic:{a:[.8,.9,1],b:[1,.82,.7],irid:1},warm:{a:[1,.72,.44],b:[1,.4,.22],irid:0},cool:{a:[.4,.72,1],b:[.62,.48,1],irid:0}},n=(e,t,n)=>[0,8,4].map(r=>{let i=(r+e/30)%12;return n-t*Math.min(n,1-n)*Math.max(-1,Math.min(i-3,9-i,1))});function r(e,r){if(e!==`custom`)return t[e]??t.chromatic;let i=(r%360+360)%360;return{a:n(i,1,.64),b:n((i+42)%360,1,.6),irid:0}}const i=[`idle`,`listening`,`thinking`,`working`,`needs`,`done`,`failed`],a=`
float glyph(vec2 p, float k){
  vec2 a=abs(p);
  if(k<1.) return min(max(a.x-.66,a.y-.24),max(a.x-.24,a.y-.66));                    // +
  if(k<2.) return max(a.x-.66,abs(a.y-.34)-.19);                                   // =
  if(k<3.){ vec2 s=abs(rot(.5)*p); return max(s.x-.22,s.y-.78); }                  // /
  return max(a.x-.25,abs(a.y-.4)-.25);                                            // :
}`,o={slats:{id:`slats`,n:{hero:21,icon:21,box:13,strip:27},p:[[0,.15,.62,0,0,0,0,0],[1,.5,.22,0,0,0,0,.1],[0,2.2,.3,1,0,0,0,.5],[0,1.2,.8,0,0,0,0,.2],[0,.4,.5,0,1,0,0,0],[0,0,.6,0,0,1,0,0],[0,0,.4,0,0,0,1,0]],frag:`
void main(){ VIEW
  vec3 n; vec4 m; float a=slat(q,asp,px,u_ph.x,u_p[0],n,m), xn=m.x, r=m.y;
  // each slat stands a little turned and twisted along its length; consonants send a turn outward from the centre
  float turn=(r-.5)+xn*.3+.3*sin(u_ph.x*.8+r*40.)+(.3+u_p[7])*.5*sin(m.z*2.4+r*9.+u_ph.x*.6)
    +u_p[0]*.9*hist(abs(xn)*.42).z*(r>.5?1.:-1.)+2.6*sweep(xn)+u_p[6]*(r-.5)*2.
    +u_pose.x*.25*cos(PI*xn)+.3*pulse(abs(xn))*(r>.5?1.:-1.);   // Home's band: the faces turn with the S they stand in, and a little as its pulse passes, so they flick
  turn=1.05*tanh(turn/1.05);                 // never so far round that the face shows only the wall behind
  n.xz=rot(turn)*n.xz; n.z=max(n.z,.05);
  vec3 glow=lumen(q,span(asp)); beam(xn);
  put(chrome(n,metal(r),m.w)*(.84+.16*smoothstep(-.5,.5,m.z))+sheen(n,glow),a,glow);
}`},glyphs:{id:`glyphs`,n:{hero:15,icon:7,box:5,strip:11},p:[[0,.15,.62,0,0,0,0,0],[1,.5,.22,0,0,0,0,0],[0,1.6,.5,.45,0,0,0,1.3],[0,1.2,.8,0,0,0,0,.12],[0,.4,.5,0,1,0,0,0],[0,0,.6,0,0,1,0,0],[0,0,.4,0,0,0,1,0]],frag:a+`
void main(){ VIEW
  float X=min(asp*.84,max(1.75,asp*.66)), sc=min(1.,asp/1.3), pitch=2.*X/u_n, i=floor((q.x+X)/pitch), g=u_p[0];
  vec3 col=vec3(0), glow=lumen(q,span(asp)); float a=0.;
  if(i>=0.&&i<u_n){
    float xc=-X+(i+.5)*pitch, xn=xc/X, r=hash(i+1.);
    vec2 w=wave(xn,r,u_ph.x,g)*sc*1.3;
    float j=floor((q.y-w.x)/pitch+.5), rc=hash(i*7.31+j*3.17+11.);
    float grow=clamp((w.y-abs(j)*pitch)/pitch+.8,0.,1.);              // a glyph grows as the wave reaches its row
    if(grow>0.){
      vec4 H=hist(abs(xn)*.42);
      // its own clock: when it runs (thinking), the glyph turns edge-on, changes character, and turns back
      float tau=rc*9.+u_aux*(.6+rc), u=fract(tau), k=floor(4.*hash(rc*91.+floor(tau+.25)));
      float ya=PI*smoothstep(.5,1.,u)-(u>.75?PI:0.);
      // done: every glyph turns over into an equals sign; failed: into a fallen slash
      float pd=clamp(u_st[5]*1.7-rc*.7,0.,1.), pf=clamp(u_st[6]*1.7-rc*.7,0.,1.);
      if(pd>.5) k=1.; if(pf>.5) k=2.;
      ya+=PI*(pd+pf)-(pd>.5?PI:0.)-(pf>.5?PI:0.);
      ya+=g*H.z*1.3*(rc-.5)*2.+.25*sin(u_ph.x*.9+rc*30.)+2.*sweep(xn);
      float tz=(hash(rc*17.)-.5)*.5+g*(H.x-hist(abs(xn)*.42+.06).x)*2.5+pf*(rc-.5)*2.;
      vec2 tl=vec2(sin(ya)+(hash(rc*13.)-.5)*.5,(hash(rc*29.)-.5)*.5+.12);     // which way the face looks
      float sx=max(abs(cos(ya)),.1), gs=.88*grow, du=gs*sx*pitch*.5;
      vec2 p=(q-vec2(xc,w.x+j*pitch))/(pitch*.5);
      mat2 R=rot(tz);
      vec2 pg=R*p, pb=R*(p+tl*.3*gs); pg.x/=sx; pb.x/=sx; pg/=gs; pb/=gs;     // the face, and the back of the extrusion
      float d=glyph(pg,k), af=clamp(.5-d*du/px,0.,1.), ab=clamp(.5-glyph(pb,k)*du/px,0.,1.);
      a=max(af,ab);
      if(a>0.){
        // The face's slope over this pixel, not at a point: across a crease one facet becomes the other within the
        // pixel, and where the slope turns under it (a crease, the chamfer's own bend) it reflects as much more softly.
        vec2 hp=max(.5*px/du,.01)*vec2(1.,sx);
        vec2 gr=vec2(glyph(pg+vec2(hp.x,0),k)-glyph(pg-vec2(hp.x,0),k),glyph(pg+vec2(0,hp.y),k)-glyph(pg-vec2(0,hp.y),k))/(2.*hp);
        float bev=smoothstep(.15,0.,-d);                                        // a chamfer round the face
        float turn=abs(smoothstep(.15,0.,-d-hp.x)-smoothstep(.15,0.,-d+hp.x))+2.*bev*sqrt(max(1.-dot(gr,gr),0.));
        vec3 nf=vec3(tl+(gr*R)*bev*.9,1.); beam(xn);
        vec3 cs=chrome(vec3(-tl*3.,.5),metal(rc),.25)*.7;                      // the side wall
        fine=smoothstep(.45,.9,max(bev*15.*px/du,2.25*turn));
        vec3 cf=chrome(nf,metal(rc),clamp(max(bev*15.*px/du,1.1*turn),.04,.45))+sheen(nf,glow);
        col=mix(cs,cf,af);
      }
    }
  }
  put(col,a,glow);
}`},resonator:{id:`resonator`,n:{hero:21,icon:15,box:11,strip:21},p:[[0,.15,.62,0,0,0,0,.5],[1,.5,.22,0,0,0,0,.62],[0,2.2,.3,1,0,0,0,.75],[0,1.2,.8,0,0,0,0,.6],[0,.4,.5,0,1,0,0,.8],[0,0,.6,0,0,1,0,.55],[0,0,.4,0,0,0,1,.38]],frag:`
void main(){ VIEW
  float f=u_ph.x, g=u_p[0], yaw=u_p[7]+.08*sin(f*.5)+g*.1*u_w.w;
  // the axis of the stack, and the two directions that span each ring
  vec3 A=vec3(cos(yaw),0.,sin(yaw)), Wd=vec3(-sin(yaw),0.,cos(yaw)), U=vec3(0,1,0);
  mat2 pit=rot(-.2); A.yz=pit*A.yz; Wd.yz=pit*Wd.yz; U.yz=pit*U.yz;
  float Lx=min(asp*.9,max(1.55,asp*.6)), sc=min(1.,asp/1.3), tr=2.*Lx/u_n*.4, soft=clamp(3.*px/tr,.03,.45);
  vec3 col=vec3(0), glow=lumen(q,span(asp)); float a=0.;
  for(float k=0.;k<u_n&&a<.995;k++){            // nearest ring first: parallel planes never swap order along a ray
    float i=u_n-1.-k, xn=(i+.5)/u_n*2.-1., s=xn*Lx;
    if(abs(q.x-s*A.x)>sc*1.3*1.42*abs(Wd.x)+tr*2.) continue;
    float r=hash(i+1.);
    vec2 w=wave(xn,r,f,g);
    float R=sc*(.17+.62*w.y);
    float roll=.35*sin(xn*2.2-f*.7)+u_p[3]*1.1*sin(xn*3.-f*3.)+g*.8*hist(abs(xn)*.42).z*sin(xn*2.6+1.)+u_p[6]*(r-.5)*2.5+1.5*sweep(xn);
    vec3 Ur=cos(roll)*U+sin(roll)*Wd, Wr=cos(roll)*Wd-sin(roll)*U, C=s*A+w.x*sc*U;
    vec2 dC=q-C.xy;
    vec3 Q=vec3(dC,-(dC.x*A.x+dC.y*A.y)/A.z);    // where this pixel's ray pierces the ring's plane
    vec2 p2=vec2(dot(Q,Wr),dot(Q,Ur));
    // Distance to the rounded-square outline, and its direction: square to a side beside it, turning round a corner,
    // and inside the corner turning back the same way, so it changes at no line (a line there cuts a small ring's
    // tube), and within a few pixels of where the turns meet no faster than a pixel shows.
    float cr=R*.45; vec2 b=abs(p2)-(R-cr), u=max(b,0.)+max(-b.yx,0.); float l=length(u), d2=(b.x>0.&&b.y>0.?l:max(b.x,b.y))-cr;
    vec2 g2=normalize(u+px*smoothstep(6.*px,0.,l))*sign(p2);
    vec3 G=g2.x*Wr+g2.y*Ur, T=cross(A,G);
    vec2 s2=vec2(T.y,-T.x); float sl=length(s2); if(sl<1e-3) continue; s2/=sl;
    float e=d2*dot(G.xy,s2), cov=clamp(.5+(tr-abs(e))/px,0.,1.);   // the tube around the outline, seen from the eye
    if(cov<=0.) continue;
    vec3 S3=vec3(s2,0.), M=normalize(cross(S3,T)); if(M.z<0.) M=-M;
    float en=clamp(e/tr,-1.,1.);
    float shade=.5+.5*smoothstep(-R,R,dot(Q,Wd));                   // the far side of each ring sits in the stack's shade
    vec3 N=en*S3+sqrt(1.-en*en)*M; beam(xn);
    col+=(1.-a)*cov*(chrome(N,metal(r),soft)*shade+sheen(N,glow)); a+=(1.-a)*cov;
  }
  put(col/max(a,1e-3),a,glow);
}`},glyph:{id:`glyph`,n:{hero:1,icon:1,box:1,strip:1},p:Array.from({length:7},()=>[0,0,0,0,0,0,0,0]),frag:a+`
void main(){ VIEW
  q/=1.12;                                                                  // the glyph fills its picture
  vec2 tl=vec2(.5*sin(u_ph.x),.14+.1*cos(u_ph.x*.7)), pb=q+tl*.3;        // which way the face looks; the back of the extrusion
  float d=glyph(q,u_aux), s=1.12/px, af=clamp(.5-d*s,0.,1.), a=max(af,clamp(.5-glyph(pb,u_aux)*s,0.,1.));
  vec3 col=vec3(0);
  if(a>0.){
    vec2 gr=vec2(glyph(q+vec2(.02,0),u_aux)-d,glyph(q+vec2(0,.02),u_aux)-d)/.02;
    float bev=smoothstep(.15,0.,-d);                                        // a chamfer round the face
    vec3 nf=vec3(tl+gr*bev*.9+q*.3,1.);                                     // the face a little domed, so the room slides across it
    vec3 cs=chrome(vec3(-tl*3.,.5),SILVER,.25);                             // the side wall: darker, and nearly without colour
    col=mix(mix(vec3(dot(cs,vec3(.3,.5,.2))),cs,.15)*.5,chrome(nf,SILVER,clamp(bev*15./s,.04,.45)),af);
  }
  o=vec4(tone(col)*a,a);
}`}},s=[[0,0,0],[0,0,0],[0,0,0],[0,0,0],[2,1.05,.22],[.45,1.2,.75],[1.25,.1,.07]],c=[.8,1,.95,.92,.85,1.05,.42],l=[0,1/0,1/0,1/0,1/0,6.4,2],u=.8,d={res:2,org:2,n:1,irid:1,dim:1,light:1,hoff:1,aux:1,ph:`4fv`,v:`4fv`,w:`4fv`,p:`1fv`,st:`1fv`,sig:`3fv`,ta:`3fv`,tb:`3fv`,bg:`3fv`,lm:`4fv`,holes:`4fv`,gone:`4fv`,hole:`4fv`,pose:`3fv`,was:2},f=3.6,p=[1/30,1/4],m=e=>(e=Math.min(1,Math.max(0,e)),e*e*(3-2*e)),h=e=>(t=>m(e/.5)*(t<.12?1-t*t/.12:(1-t)*(1-t)/.88))(Math.min(1,Math.max(0,(e-.5)/2.2))),g=e=>((e,t)=>t(e-.1,.06)+.7*t(e-.31,.07))(e/2.4%1,(e,t)=>Math.exp(-((e/t)**2))),_=(e,t)=>Math.abs(e(t+.01)-e(t-.01))/.02,v=[400,200],y={level:0,fast:0,slow:0,onset:0,onsets:0,bright:.4,vowel:0,sib:0,pitch:.4,activity:0,quiet:9,hoff:0},b=matchMedia(`(prefers-reduced-motion: reduce)`),x=/* @__PURE__ */ new Set,S={frames:0,keys:0,late:0,contexts:0,ms:0,rate:60,carry:!1,step:.4,seen:null},C=[];let w=!1,T=!0;function E(){let e=document.createElement(`canvas`);e.className=`motion-canvas`;let t=e.getContext(`webgl2`,{alpha:!0,premultipliedAlpha:!0,antialias:!1,depth:!1,stencil:!1});if(!t)return null;let n={canvas:e,gl:t,parallel:t.getExtension(`KHR_parallel_shader_compile`),progs:/* @__PURE__ */ new Map};return e.addEventListener(`webglcontextlost`,e=>(e.preventDefault(),n.progs.clear())),e.addEventListener(`webglcontextrestored`,()=>(O(n),x.forEach(e=>e.dirty=!0),H())),S.contexts++,O(n),n}function D(){return!C[0]&&!w&&(w=!(C[0]=E())),C[0]??null}function O({gl:e}){e.bindTexture(e.TEXTURE_2D,e.createTexture()),e.texImage2D(e.TEXTURE_2D,0,e.RGBA16F,128,2,0,e.RGBA,e.FLOAT,null);for(let[t,n]of[[e.TEXTURE_MIN_FILTER,e.LINEAR],[e.TEXTURE_MAG_FILTER,e.LINEAR],[e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE],[e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE]])e.texParameteri(e.TEXTURE_2D,t,n);e.bindVertexArray(e.createVertexArray()),T=!0}function k(e,t,n=!1){let r=e.gl,i=e.progs.get(t);if(!i){let n=r.createProgram();for(let[e,i]of[[r.VERTEX_SHADER,`#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}`],[r.FRAGMENT_SHADER,`#version 300 es
precision highp float;
uniform vec2 u_res, u_org;          // this view's size and corner, device pixels
uniform float u_n;                  // how many elements this view asks for (slats, rings, columns)
uniform float u_irid, u_dim, u_light, u_hoff, u_aux;
uniform vec4 u_ph;                  // phases: own motion, voice-driven, onset count (eased), seconds in state
uniform vec4 u_v;                   // level, fast level, onset, brightness
uniform vec4 u_w;                   // vowel, sibilance, pitch, activity
uniform float u_p[8], u_st[7];      // concept parameters; state weights
uniform vec3 u_sig, u_ta, u_tb, u_bg;   // signal light of the state; the palette's two lights; backdrop
uniform sampler2D u_data;           // row 0: two seconds of (level, bright, onset, vowel); row 1: spectrum
// The app's own, neither of which changes a lab concept at its defaults (u_lm.x 0, no holes):
uniform vec4 u_lm;                  // Lumen laid over the form: how much of it, its own phase, the room's level under it
uniform vec4 u_holes[24], u_gone[24];   // text the motion keeps clear, in this view's pixels: centre and half size; and what it kept clear before
uniform vec4 u_hole;                // how many, and how far the light takes to come back around each; how many before, and how far the change from those to these has come
uniform vec3 u_pose;                // Home's band alone: how far it stands in the icon's S, its pulse's clock, its pulse's strength
uniform vec2 u_was;                 // and the pulse before it, which may still be settling: its clock and its strength
// (A slat stays upright in that S: its column leaves it under two degrees of lean, which at the band's size only
// breaks its edges into steps. Its face turns instead, in slats.ts.)
out vec4 o;
#define PI 3.14159265

float hash(float n){ return fract(sin(n*127.1+3.7)*43758.5453); }
mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,s,-s,c); }
vec3 hue(float t){ return .55+.45*cos(6.2832*(t+vec3(0.,.33,.67))); }
float bump(float x, float w){ x/=w; return exp(-x*x); }
vec4 hist(float age){ return texture(u_data, vec2((max(age,0.)*60.-u_hoff+.5)/128., .25)); }
vec4 hist3(float age){ return .25*hist(age-.025)+.5*hist(age)+.25*hist(age+.025); }   // the same, rounded off
float spec(float f){ return texture(u_data, vec2((clamp(f,0.,1.)*127.+.5)/128., .75)).r; }
// needs you: two soft beats, then a rest
float beat(){ float t=fract(u_ph.w/2.4); return bump(t-.10,.06)+.7*bump(t-.31,.07); }
// done: light passes once, left to right; in Home's band an accent, turning a face about as far as a pulse does
float sweep(float xn){ return (1.-.88*u_pose.x)*u_st[5]*bump(xn+1.7-3.4*smoothstep(0.,1.3,u_ph.w),.3)*(1.-smoothstep(1.15,1.5,u_ph.w)); }

// ---- the studio: a dark room, a wide key overhead, a tall cool strip left, a warm strip right ----
vec3 xl=vec3(0,0,1), xlc=vec3(0);   // one more light that a concept may steer: direction and colour
float amb=1.;                       // and the room's own level
float fine=0.;                      // 1 where the metal turns further under one pixel than its softest reflection (.45) shows
float card(vec3 d, vec3 n, vec2 hs, float s){
  float c=dot(d,n); if(c<.05) return 0.;
  vec3 r=normalize(cross(vec3(0,1,0),n)), u=cross(n,r), p=d/c;
  vec2 uv=vec2(dot(p,r),dot(p,u)), a=abs(uv)-hs; uv/=hs; vec2 on=clamp(uv,-1.,1.);
  // A softbox is hottest at its centre. Out in a soft reflection's skirt that falloff runs below zero, which the
  // tone curve shows as light again, with a black hairline where it crosses zero: it is taken as the light it shows
  // as, and where the metal turns too far under one pixel for that fringe to be drawn (fine), it stops at the edge.
  return smoothstep(s,-s,a.x)*smoothstep(s,-s,a.y)*mix(abs(1.-.18*dot(uv,uv)),1.-.18*dot(on,on),fine);
}
vec3 env(vec3 d, float s){
  float t=u_ph.x*.03+d.x*.28, az=atan(d.x,d.z);                   // az: 0 is behind the camera, +-PI behind the metal
  vec3 A=mix(u_ta,hue(t+d.y*.3),u_irid), B=mix(u_tb,hue(t-d.y*.25+.5),u_irid);
  vec3 c=vec3(.03+.1*smoothstep(-.4,.9,d.y)+.08*(.5+.5*cos(az*2.+.7)))*(.35+.65*smoothstep(-.8,.1,d.y));   // the room itself, never quite even
  c+=(.2*smoothstep(.15,-.75,d.z)+1.5*smoothstep(-.62,-.96,d.z))*mix(vec3(1),A,.5)*(.6+.4*d.y);   // a lit wall behind, brightest straight behind: it draws the rims
  c+=2.8*card(d,normalize(vec3(.12,1.,.5)),vec2(1.5,.4),s)*mix(vec3(1),A,.22);    // key, overhead
  c+=3.6*card(d,normalize(vec3(-1.,.1,.5)),vec2(.15,1.3),s)*A;                    // tall cool strip, left
  c+=2.6*card(d,normalize(vec3(1.,.02,.28)),vec2(.22,1.1),s)*B;                   // warm strip, right
  c+=2.2*card(d,normalize(vec3(-.8,.1,-.6)),vec2(.12,1.2),s)*A;                   // two kickers behind, for the shoulders
  c+=1.8*card(d,normalize(vec3(.85,0.,-.5)),vec2(.1,1.1),s)*mix(vec3(1),B,.6);
  c+=1.7*card(d,normalize(vec3(-.42,.05,1.)),vec2(.045,1.2),s);                   // two hairlines near the camera
  c+=1.2*card(d,normalize(vec3(.6,0.,1.)),vec2(.03,1.2),s);
  c+=.4*card(d,normalize(vec3(.2,-1.,.6)),vec2(1.2,.5),s+.2)*B;                   // warm bounce off the floor
  c+=1.5*card(d,normalize(vec3(-.1,1.,-.5)),vec2(1.3,.34),s)*mix(vec3(1),A,.3);   // a second overhead and a second bounce, behind the metal
  c+=.3*card(d,normalize(vec3(.1,-1.,-.55)),vec2(1.2,.4),s+.2)*B;
  c+=card(d,normalize(vec3(0.,-.8,.6)),vec2(1.5,.32),s+.12)*u_sig;                // the state's signal light, low in front
  c=c*u_dim*amb+card(d,xl,vec2(.2,1.5),s+.04)*xlc;
  // on a light backdrop the room is bright and the lights become dark flags: chrome on white is silver cut by dark reflections
  float L=dot(c,vec3(.3,.5,.2));
  return mix(c,vec3(.8,.82,.85)*(1.-.9*smoothstep(.12,1.5,L))*(.78+.22*d.y)+(c-L)*.25,u_light);
}
// ---- chrome: a mirror with Fresnel, the three colours reflected a little apart, a film at grazing angles ----
// s is how far the reflection moves across one pixel; the studio's edges are softened by it so nothing sparkles.
vec3 chrome(vec3 n, vec3 tint, float s){
  n=normalize(n);
  vec3 r=reflect(vec3(0,0,-1),n);
  float fr=pow(1.-clamp(n.z,0.,1.),4.), k=(.03+.14*u_irid)*(.4+fr);
  vec3 c=vec3(env(normalize(vec3(r.xy*(1.+k),r.z)),s).r, env(r,s).g, env(normalize(vec3(r.xy*(1.-k),r.z)),s).b);
  c*=mix(tint,vec3(1),fr);
  return c*mix(vec3(1),hue(fr*1.3+n.x*.35+.58)*1.25,.4*u_irid);
}
const vec3 SILVER=vec3(.82,.84,.88);
vec3 metal(float r){ return r>.86?mix(SILVER,u_tb,.7):r<.12?mix(SILVER,u_ta,.55):SILVER; }   // a few pieces are bronze or blued, as in the icon
vec3 tone(vec3 c){ c=c*(2.51*c+.03)/(c*(2.43*c+.59)+.14); return pow(clamp(c,0.,1.),vec3(.4545)); }
// metal c with coverage a, over light g that hangs in the air behind it
void put(vec3 c, float a, vec3 g){
  g=1.-exp(-g);
  float ga=max(g.r,max(g.g,g.b));
  vec3 b=mix(u_bg+g,u_bg*(1.-ga)+g*.92,u_light);
  vec3 m=tone(c);
  float z=(fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))))-.5)/255.;
  o=vec4(mix(b,m,a)+z,1.);
  // In the app a view is light over the page: black is clear. Where words sit above it there is none at all, so they keep
  // the contrast they have; the light comes back within the feather, the metal only further out, so it never shows cut.
  // Words that have just come are not cleared in one frame: the clearing before them gives way to theirs evenly.
  if(u_hole.x>0.||u_hole.w<1.){
    float d=1e9, e=1e9, f=max(u_hole.y,1.);
    for(int i=0;i<24;i++){
      if(float(i)<u_hole.x) d=min(d,length(max(abs(gl_FragCoord.xy-u_holes[i].xy)-u_holes[i].zw,0.)));
      if(u_hole.w<1.&&float(i)<u_hole.z) e=min(e,length(max(abs(gl_FragCoord.xy-u_gone[i].xy)-u_gone[i].zw,0.)));
    }
    o.rgb=max(mix(b*smoothstep(0.,f,d),m*smoothstep(f*.5,f*3.,d),a)+z,0.)*step(1e-3,d);
    if(u_hole.w<1.) o.rgb=mix(max(mix(b*smoothstep(0.,f,e),m*smoothstep(f*.5,f*3.,e),a)+z,0.)*step(1e-3,e),o.rgb,u_hole.w);
  }
  o.a=max(o.r,max(o.g,o.b));
}

// Home's band: the pulse passing through it at ax from the centre: it leaves the centre, reaches the ends, and settles,
// as loudness does in this wave; a beat's rise and a long fall. The fall gathers way from the top and then loses it
// evenly, so it comes to rest at a moment (2.7 units in) and not along a tail that never ends; one pulse joins the
// last where they meet.
float swell(float t){ float x=clamp((t-.5)/2.2,0.,1.); return smoothstep(0.,.5,t)*(x<.12?1.-x*x/.12:(1.-x)*(1.-x)/.88); }
float pulse(float ax){ return u_pose.z*swell(u_pose.y-ax*.9)+u_was.y*swell(u_was.x-ax*.9); }
// ---- the icon's wave: centre and half-height at xn in -1..1 (rnd: the element's own random; f: phase; g: voice) ----
vec2 wave(float xn, float rnd, float f, float g){
  float ax=abs(xn);
  float h=u_p[2]*.5*(.6+.4*bump(xn-.45*sin(f*.6),.6));              // a hump that wanders, as in the animated logo
  float c=-u_p[2]*.17*sin(PI*xn+.5*sin(f*.6+1.2));                   // and the S of its centre line
  vec4 H=hist(ax*.42);                                               // the voice leaves the centre and travels outward
  h+=g*(.6*H.x*(.6+.4*cos(ax*2.))+.2*spec(.08+ax*.85)+.08*u_w.x);
  c+=g*H.x*(-.2*sin(PI*xn)+.08*sin(xn*4.-u_ph.y*4.));                 // loudness also draws the icon's S
  h=mix(h,.13+.42*bump(xn-.82*sin(f*1.25),.2),u_p[3]);        c*=1.-u_p[3];
  h=mix(h,(.1+.62*bump(xn,.34))*(1.+.2*beat()),u_p[4]);       c*=1.-u_p[4];
  h=mix(h,.46*sqrt(max(1.-xn*xn*.8,0.)),u_p[5]);              c*=1.-u_p[5];
  h=mix(h,.07+.16*rnd*rnd,u_p[6]);                            c=mix(c,-.42+.1*rnd,u_p[6]);
  // Home's band: it stands in the icon's S in every state, never on a ruler, and stays there; what moves is its
  // heights, swelling as a pulse passes outward from the centre.
  c-=u_pose.x*.1*sin(PI*xn)*(1.-u_p[6]);
  h+=.06*pulse(ax)*(.55+.45*cos(ax*2.))*(1.-u_p[6]);
  return vec2(c,h*smoothstep(1.,.72,ax));
}
float span(float asp){ return min(asp*.8,max(1.35,asp*.62)); }
// One slat of that wave. Returns coverage; n: its normal before it is turned; m: (xn, random, height along it, softness)
float slat(vec2 q, float asp, float px, float f, float g, out vec3 n, out vec4 m){
  float X=span(asp), sc=min(1.,X/1.2)*.95, pitch=2.*X/u_n, i=floor((q.x+X)/pitch);
  n=vec3(0,0,1); m=vec4(0,.5,0,.03);
  if(i<0.||i>=u_n) return 0.;
  float xc=-X+(i+.5)*pitch, xn=xc/X, r=hash(i+1.), bw=pitch*.37, cr=bw*.36;
  vec2 w=wave(xn,r,f,g)*sc;
  float hh=max(w.y,bw);
  vec2 p=vec2(q.x-xc,q.y-w.x), b=(abs(p)-vec2(bw,hh))/cr+1., e=sign(p)*max(b,0.);
  float rr=length(e), ang=asin(min(rr,1.))*.96, h=.5*px/cr;        // a flat face with rolled shoulders
  n=vec3(e/max(rr,1e-4)*sin(ang),cos(ang)); n.x+=p.x/bw*.16;
  // The face reflects sharply and the shoulder softly, by how far it turns under one pixel (S, and more towards its
  // rim); one becomes the other by the share of the pixel that lies on the shoulder (t), not at a line, which would
  // stand on whole pixels and jump from one to the next as the slat moves.
  float S=max(2.5*px/cr,.03), t=min(length(max(b+h,0.))/(2.*h),1.), k=sqrt(1.-min(rr*rr,.9));
  m=vec4(xn,r,p.y/sc,.03*pow(min(S,.45)/.03,t)/k); fine=smoothstep(.45,.9,S/k)*min(4.*t,1.);
  return clamp(.5+(1.-rr)*cr/px,0.,1.);
}
#define VIEW float asp=u_res.x/u_res.y, px=2./u_res.y; vec2 q=(gl_FragCoord.xy-u_org-.5*u_res)*px;

// ---- Lumen, the lab's sixth concept, laid over any form: coloured light in the air behind the metal and a beam across it ----
// Its code as the lab's Lumen has it. The light is centred on the icon's S at rest, where that concept held its slats.
vec3 lc=vec3(0); float la=0.;            // the light's colour and level here, for what the metal catches of it
vec3 lumen(vec2 q, float X){
  amb=mix(1.,u_lm.z,u_lm.x);
  if(u_lm.x<=0.) return vec3(0);
  float xg=q.x/X, ax=abs(xg), f=u_lm.y, g=u_p[0];
  vec4 H=hist(ax*.42);
  float amp=g*(H.x*(.7+.3*cos(xg*2.))+.15*spec(.08+ax*.85))+u_st[0]*.07*(1.+.5*sin(f+xg*2.))
    +u_st[2]*.55*bump(xg-.85*sin(f*1.25),.28)+u_st[3]*.4*bump(xg-(fract(f*.11)*3.2-1.6),.5)
    +u_st[4]*bump(xg,.45)*(.25+.75*beat())+u_st[5]*.3*(1.+2.*sweep(xg))+u_st[6]*.25*bump(q.y+.8,.3);
  float sm=max(u_sig.r,max(u_sig.g,u_sig.b));
  vec3 gc=mix(mix(u_ta,u_tb,.5+.5*sin(xg*2.4+f*.35)),hue(xg*.3+f*.04+.1),u_irid);
  gc=mix(gc,u_sig/max(sm,1e-3),min(sm,1.));
  float c0=-.17*sin(PI*xg+.5*sin(1.2))*min(1.,X/1.2)*.95;     // Lumen's wave(xg,.5,0.,0.).x
  amp*=u_lm.x; lc=gc; la=amp;
  return gc*amp*1.5*bump(q.y-c0,(.26+.3*amp)*min(1.,X/1.2))*smoothstep(1.3,.75,ax);
}
// The beam, aimed at the element at xn: where it stands along the wave, and how hard it shines.
void beam(float xn){
  if(u_lm.x<=0.) return;
  float f=u_lm.y;
  float pos=u_st[0]*.6*sin(f*.5)+u_st[1]*.9*sin(u_ph.y*3.+u_ph.z*.7)+u_st[2]*.85*sin(f*1.25)+u_st[3]*(fract(f*.11)*3.2-1.6)
    +u_st[5]*(-1.7+3.4*smoothstep(0.,1.3,u_ph.w));
  float I=u_st[0]*.5+u_st[1]*(.5+3.*u_v.y)+u_st[2]*2.2+u_st[3]*1.4+u_st[4]*(.5+1.5*beat())+u_st[5]*2.5*(1.-.88*u_pose.x)*(1.-smoothstep(1.1,1.6,u_ph.w));
  float az=clamp((pos-xn)*1.4,-1.45,1.45);
  xl=normalize(vec3(sin(az),.12,cos(az))); xlc=u_lm.x*I*mix(vec3(1),lc,.5);
}
// What the metal's shoulders catch of the light behind it.
vec3 sheen(vec3 n, vec3 glow){ float z=min(normalize(n).z,1.); return glow*pow(1.-z,1.5)*3.+lc*la*.5*pow(1.-z,2.); }
`+o[t].frag]]){let t=r.createShader(e);r.shaderSource(t,i),r.compileShader(t),r.attachShader(n,t)}r.linkProgram(n),e.progs.set(t,i={prog:n,loc:null})}if(!i.loc){if(!n&&e.parallel&&!r.getProgramParameter(i.prog,e.parallel.COMPLETION_STATUS_KHR))return null;if(!r.getProgramParameter(i.prog,r.LINK_STATUS))throw Error(`${t}: ${r.getProgramInfoLog(i.prog)} ${(r.getAttachedShaders(i.prog)??[]).map(e=>r.getShaderInfoLog(e)).join(` `)}`);i.loc=Object.fromEntries(Object.keys(d).map(e=>[e,r.getUniformLocation(i.prog,`u_`+e)]))}return i}function A(e,t,n,r,i,a=!1){let o=e.gl,s=k(e,t,a);if(!s)return!1;o.viewport(0,0,n,r),o.useProgram(s.prog),i.res=[n,r];for(let e of Object.keys(d)){let t=s.loc[e],n=i[e],r=d[e];if(!t)continue;let a=n;r===1?o.uniform1f(t,n):r===2?o.uniform2f(t,a[0],a[1]):r===`1fv`?o.uniform1fv(t,a):r===`3fv`?o.uniform3fv(t,a):o.uniform4fv(t,a)}return o.drawArrays(o.TRIANGLES,0,3),!0}function j(e,t,n,a,o,l){let u=D(),d=u?.gl;if(!u||!d||d.isContextLost())return null;let f=d.createFramebuffer(),p=d.createRenderbuffer();try{d.bindFramebuffer(d.FRAMEBUFFER,f),d.bindRenderbuffer(d.RENDERBUFFER,p),d.renderbufferStorage(d.RENDERBUFFER,d.RGBA8,a,a),d.framebufferRenderbuffer(d.FRAMEBUFFER,d.COLOR_ATTACHMENT0,d.RENDERBUFFER,p);let m=i.indexOf(n),h=r(t.palette,t.hue),g=/* @__PURE__ */ new Float32Array(7);g[m]=1,A(u,e,a,a,{res:[0,0],org:[0,0],n:1,irid:h.irid*.5,dim:c[m],light:0,hoff:0,aux:o,ph:[l,0,0,9],p:/* @__PURE__ */ new Float32Array(8),st:g,sig:s[m],ta:h.a,tb:h.b,v:[0,0,0,.4],w:[0,0,.4,0],bg:[0,0,0],lm:[0,0,1,0],holes:/* @__PURE__ */ new Float32Array(96),gone:/* @__PURE__ */ new Float32Array(96),hole:[0,0,0,1],pose:[0,0,0],was:[9,0]},!0);let _=new Uint8Array(a*a*4);d.readPixels(0,0,a,a,d.RGBA,d.UNSIGNED_BYTE,_);let v=new ImageData(a,a);for(let e=0;e<a;e++)for(let t=0;t<a;t++){let n=((a-1-e)*a+t)*4,r=(e*a+t)*4,i=_[n+3];for(let e=0;e<3;e++)v.data[r+e]=i?Math.min(255,_[n+e]*255/i):0;v.data[r+3]=i}let y=document.createElement(`canvas`);return y.width=y.height=a,y.getContext(`2d`).putImageData(v,0,0),y}catch(e){return console.error(e),null}finally{d.bindFramebuffer(d.FRAMEBUFFER,null),d.deleteFramebuffer(f),d.deleteRenderbuffer(p)}}const M=e=>!(e instanceof Element?e:e instanceof Node?e.parentElement:null)?.closest(`[aria-hidden=true]`);var N=class{el;o={look:{style:`slats`,palette:`chromatic`,hue:265,lumen:!1},state:`idle`};dirty=!0;drawn=0;clock=0;seen=!1;css=[0,0];cv=null;holes=/* @__PURE__ */ new Float32Array(96);gone=/* @__PURE__ */ new Float32Array(96);hole=[0,0,0,1];lines=``;stale=!0;snap=!0;stW=/* @__PURE__ */ new Float32Array(7);stV=/* @__PURE__ */ new Float32Array(7);go=0;stT=9;ph=[0,0,0,9];aux=0;onz=0;lm=0;lph=0;pulse={began:-1e9,strength:0,was:-1e9,weak:0,due:0,n:0,kick:0,on:!1};p=/* @__PURE__ */ new Float32Array(8);moving=!1;slow=0;adv=0;plan=null;timer=0;wraps=[];fades=[[],[],[]];left=0;observers;words;watching=!1;fresh=!0;moved=e=>this.o.clear&&M(e)&&(this.stale=!0,H());event=e=>this.moved(e.target)&&(this.snap=!0);constructor(e){this.el=e;let t=new ResizeObserver(([t])=>{let n=t.contentRect;this.css=[n.width,n.height];let[r,i]=this.o.min??v;e.toggleAttribute(`data-small`,n.width<r||n.height<i),this.dirty=this.stale=this.snap=!0,this.watch(),H()}),n=new IntersectionObserver(([e])=>{this.seen=e.isIntersecting,this.dirty=this.stale=this.snap=!0,this.watch(),H()});this.words=new MutationObserver(e=>e.some(e=>this.moved(e.target))),t.observe(e),n.observe(e),this.observers=[t,n],x.add(this)}set(e){let t=this.o,n=JSON.stringify(e)!==JSON.stringify(t);n&&this.plan&&this.leave(performance.now()),this.o=e,this.fresh?(this.fresh=!1,this.settle(),e.seed&&(this.aux=e.seed*7.3,this.ph[0]=e.seed*11.1)):e.state!==t.state&&(this.stT=0),e.pace===`still`&&this.settle(),n&&(this.dirty=this.stale=!0,this.watch(),H())}watch(){let e=!!this.o.clear&&this.shown();if(e===this.watching)return;this.watching=e;let t=[`scroll`,`transitionend`,`animationend`];if(e){this.words.observe(document.body,{subtree:!0,childList:!0,characterData:!0,attributes:!0,attributeFilter:[`class`,`hidden`,`open`]});for(let e of t)document.addEventListener(e,this.event,!0)}else{this.words.disconnect();for(let e of t)document.removeEventListener(e,this.event,!0)}}settle(){this.stW.fill(0),this.stV.fill(0),this.stW[i.indexOf(this.o.state)]=this.stV[i.indexOf(this.o.state)]=1,this.lm=+!!this.o.look.lumen,this.stT=9}dispose(){this.observers.forEach(e=>e.disconnect()),this.o={...this.o,clear:void 0},this.watch(),x.delete(this),clearTimeout(this.timer),this.plan=null,this.still(),this.wraps.forEach(e=>e.remove())}shown(){let[e,t]=this.o.min??v;return this.seen&&this.o.active!==!1&&this.css[0]>=e&&this.css[1]>=t&&!document.hidden}size(){let e=this.o.soft?1:Math.min(window.devicePixelRatio||1,2);return[Math.max(2,Math.round(this.css[0]*e)),Math.max(2,Math.round(this.css[1]*e))]}tick(e){let t=i.indexOf(this.o.state),n=1-Math.exp(-e/(this.o.pace===`calm`&&(t===5||this.stV[5]>.002)?.88:.22));this.moving=!1;for(let e=0;e<7;e++)this.stV[e]+=(+(e===t)-this.stV[e])*n,this.stW[e]+=(this.stV[e]-this.stW[e])*n,Math.abs(+(e===t)-this.stW[e])>.002&&(this.moving=!0);let r=this.o.pace===`calm`?+(this.stT<l[t]&&!(this.o.rest&&t<5)&&!b.matches):1;this.go+=Math.max(-e/u,Math.min(e/u,r-this.go));let a=+this.o.look.lumen-this.lm;Math.abs(a)>.004&&(this.moving=!0),this.lm+=a*(1-Math.exp(-e/.3)),this.hole[3]<1&&(this.hole[3]=Math.min(1,this.hole[3]+e/.2),this.moving=!0),this.stT+=e}moves(){let e=i.indexOf(this.o.state),t=y,n=this.beat(this.clock)<f;return this.o.pace===`still`?!1:this.moving?!0:b.matches?e===1&&Math.abs(t.slow-this.slow)>.004:n||e===1&&!this.o.rest?!0:this.o.pace===`calm`?this.go>0:!(e===0||e>=5&&this.stT>3)}beat(e){let t=this.pulse,n=this.o.every??0,r=(this.o.kick??0)!==t.kick||!!n&&!t.on;if(t.kick=this.o.kick??0,t.on=!!n,this.o.pulse&&!b.matches&&(r||n&&e>=t.due)&&(e-t.was)/1e3/2>=f){let i=e=>Math.abs(Math.sin((++t.n+e)*12.9898)*43758.5453)%1,a=r?e:Math.max(t.due,e-50);Object.assign(t,{was:t.began,weak:t.strength,began:a,strength:this.o.pulse*(r?.8:.6+.4*i(.3)),due:a+n*1e3*(.72+.56*i(.7))})}return(e-t.began)/1e3/2}rest(){return!this.plan&&this.o.pulse&&this.o.every&&!b.matches?Math.max(0,this.pulse.due-this.clock):1/0}uniforms(t,n){let a=this.clock;t*=(this.o.tempo??1)*this.go;let l=o[this.o.look.style],u=r(this.o.look.palette,this.o.look.hue),d=this.p,f=this.stW,p=b.matches,m=y,h=0,g=0;for(let e=0;e<8;e++){let t=0;for(let n=0;n<7;n++)t+=f[n]*l.p[n][e];d[e]=t}for(let t=0;t<7;t++)h+=f[t]*e[t][1],g+=f[t]*e[t][7];if(p)this.ph[3]=9.9;else{this.ph[0]+=t*d[1],this.ph[1]+=t*m.level*d[0],this.aux+=t*d[7],this.lph+=t*h,this.onz+=(m.onsets-this.onz)*(1-Math.exp(-t/.09)),this.ph[2]=this.onz;let e=i.indexOf(this.o.state);this.ph[3]=this.stT*(this.o.pace===`calm`?e===4?this.o.tempo??1:e===5?.25:1:1)}let _=[0,0,0],v=(()=>{let e=this.ph[3]/2.4%1,t=(e,t)=>Math.exp(-((e/t)**2));return t(e-.1,.06)+.7*t(e-.31,.07)})(),x=0;for(let e=0;e<7;e++){let t=f[e]*(e===5?.35+.65*Math.exp(-this.stT/1.5):1)*(e===4&&!p?.55+.45*v:1);for(let n=0;n<3;n++)_[n]+=t*s[e][n];x+=f[e]*c[e]}return this.slow=m.slow,{res:[0,0],org:[0,0],n,irid:u.irid,dim:x,light:0,hoff:m.hoff,aux:this.aux,ph:this.ph,p:d,st:f,sig:_,ta:u.a,tb:u.b,v:[p?m.slow:m.level,p?m.slow:m.fast,p?0:m.onset,m.bright],w:[p?m.slow:m.vowel,p?0:m.sib,m.pitch,p?m.slow:m.activity],bg:[0,0,0],lm:[this.lm,this.lph,g,0],holes:this.holes,gone:this.gone,hole:this.hole,pose:[this.o.pose??0,(a-this.pulse.began)/1e3/2,this.pulse.strength],was:[(a-this.pulse.was)/1e3/2,this.pulse.weak]}}count(){if(this.o.count)return this.o.count;let[e,t]=this.css,n=t<48?e/t>4?`strip`:`box`:e<200?`icon`:`hero`;return o[this.o.look.style].n[n]}clear(){if(this.hole[3]<1)return 0;this.stale=!1;let e=/* @__PURE__ */ new Float32Array(96),t=``,n=0,r=0;if(this.o.clear){let i=this.el.getBoundingClientRect(),a=this.size()[0]/Math.max(1,i.width),o=Math.max(this.o.pad??3,1/a+1),s=L(this.o.clear,o).filter(e=>e.r>i.left&&e.l<i.right&&e.b>i.top&&e.t<i.bottom);s.forEach((t,n)=>e.set([((t.l+t.r)/2-i.left)*a,(i.bottom-(t.t+t.b)/2)*a,(t.r-t.l)/2*a,(t.b-t.t)/2*a],n*4)),t=s.map(e=>`${Math.round(e.t)}:${Math.round(e.b)}`).sort().join(),n=s.length,r=(this.o.feather??16)*a}if(n===this.hole[0]&&r===this.hole[1]&&e.every((e,t)=>e===this.holes[t]))return 0;let i=t!==this.lines&&!this.snap&&this.o.pace===`calm`&&!b.matches;return i&&this.gone.set(this.holes),this.holes.set(e),this.hole=[n,r,i?this.hole[0]:0,+!i],this.lines=t,this.snap=!1,i?2:1}pass(e,t,n){return this.left&&(t=Math.min(50,Math.max(0,e-this.left)),n=this.left=0),this.clock+=t+n,this.adv=b.matches?0:t/1e3,this.stale&&this.clear()&&(this.dirty=!0),this.tick(t/1e3),this.moves()}draw(e,t,n){let[r,i]=this.size(),a=C[0],o=e?1:Math.min(1,t/r,n/i),s=Math.floor(r*o),c=Math.floor(i*o);if(!A(a,this.o.look.style,s,c,this.uniforms(this.adv,this.count())))return!1;if(!this.drawn++&&this.o.soft&&this.o.pace!==`still`&&!b.matches&&this.el.animate({opacity:[0,1]},240),this.dirty=!1,this.adv=0,e)return this.cv?.remove(),this.cv=null,this.still(),a.canvas.parentElement!==this.layer(0)&&this.layer(0).append(a.canvas),S.seen?.(this,a.canvas,this.clock),!0;this.cv||(this.cv=document.createElement(`canvas`),this.cv.className=`motion-canvas`,this.el.append(this.cv)),(this.cv.width!==r||this.cv.height!==i)&&([this.cv.width,this.cv.height]=[r,i]);let l=this.cv.getContext(`2d`);return l.clearRect(0,0,r,i),l.drawImage(a.canvas,0,n-c,s,c,0,0,r,i),S.seen?.(this,this.cv,this.clock),!0}held(){let e=i.indexOf(this.o.state);return S.carry&&this.o.pace===`calm`&&(e===3||e===4)&&!this.o.rest&&!b.matches}carried(e,t){let n=this.plan;if(!n)return!1;let r=this.stale&&this.clear()===2,i=e>=n[n.length-1].at;return i&&S.late++,!r&&!this.dirty&&t&&this.held()&&!i?!0:(this.leave(e),!1)}carry(e){if(this.plan)return!0;if(!this.held())return!1;let t=this.o.look.style;for(let e of[1,2])if(!(C[e]??=E())||!k(C[e],t))return!1;return this.moving||this.dirty||this.go!==1||this.stale?!1:(this.plan=[{at:e,layer:0,sim:this.save()}],this.ahead(),!0)}ahead=()=>{let e=this.plan;if(!e)return;let t=performance.now();if(e.length>1&&t>=e[e.length-1].at||!this.shown()||!this.held())return H();for(let n=0;e.length<2||e[e.length-2].at<=t;n++){if(this.stale&&this.clear()===2)return void(this.dirty=!0,H());if(n===3)return void(this.timer=window.setTimeout(this.ahead,0));this.key()}this.timer=window.setTimeout(this.ahead,e[e.length-2].at-t)};speed(e){let t=i.indexOf(this.o.state),n=o[this.o.look.style].p[t],r=this.o.tempo??1,a=this.pulse,s=t=>(this.clock-t)/1e3/2+e/2,c=0;for(let e of[0,.45,.9])c=Math.max(c,a.strength*_(h,s(a.began)-e)+a.weak*_(h,s(a.was)-e));let l=t===4?.144*r*_(g,(this.stT+e)*r):0;return(.13*n[2]*n[1]*r+.06*c/2+l)*this.size()[1]*.475}key(){let e=this.plan,t=e[e.length-1],n=(t.layer+1)%3,r=C[n],[i,a]=this.size(),o=Math.min(p[1],Math.max(p[0],S.step/Math.max(this.speed(0),this.speed(p[1]/2),this.speed(p[1])))),s=(this.pulse.due-this.clock)/1e3;this.o.every&&s>0&&s<o&&(o=Math.max(p[0],s)),this.clock+=o*1e3,this.tick(o),this.moves();for(let e of this.fades[n].splice(0))e.cancel();r.canvas.style.opacity=`0`,r.canvas.parentElement!==this.layer(n)&&this.layer(n).append(r.canvas),(r.canvas.width!==i||r.canvas.height!==a)&&([r.canvas.width,r.canvas.height]=[i,a]),A(r,this.o.look.style,i,a,this.uniforms(o,this.count()),!0);let c={duration:o*1e3,fill:`forwards`},l=r.canvas.animate({opacity:[0,1]},c),u=this.layer(t.layer).animate({opacity:[1,0]},c);l.startTime=u.startTime=t.at,this.fades[n].push(l),this.fades[t.layer].push(u),e.push({at:t.at+o*1e3,layer:n,sim:this.save()}),e.length>4&&e.shift(),this.drawn++,S.keys++,S.seen?.(this,r.canvas,this.clock)}leave(e){let t=this.plan;this.plan=null,clearTimeout(this.timer);let n=t.length-1;for(;n>0&&t[n].at>e;)n--;let r=Math.min(n===t.length-1?.05:1/0,Math.max(0,e-t[n].at)/1e3);this.load(t[n].sim),this.clock+=r*1e3,this.tick(r),this.moves(),this.uniforms(r,this.count());for(let e of this.fades.flat())e.pause();this.left=e,this.dirty=!0,H()}still(){if(this.fades.some(e=>e.length)){for(let e of this.fades.flat())e.cancel();this.fades=[[],[],[]],C.forEach((e,t)=>e&&(e.canvas.style.opacity=t?`0`:``))}}layer(e){return this.wraps[e]??=this.el.appendChild(Object.assign(document.createElement(`i`),{className:`motion-layer`}))}save(){return{clock:this.clock,stW:this.stW.slice(),stV:this.stV.slice(),go:this.go,stT:this.stT,ph:this.ph.slice(),aux:this.aux,onz:this.onz,lm:this.lm,lph:this.lph,pulse:{...this.pulse}}}load(e){this.stW.set(e.stW),this.stV.set(e.stV),Object.assign(this,{clock:e.clock,go:e.go,stT:e.stT,ph:e.ph.slice(),aux:e.aux,onz:e.onz,lm:e.lm,lph:e.lph,pulse:{...e.pulse}})}showing(e){let t=(e,t=0)=>[(e.clock+t-e.pulse.began)/1e3/2,e.ph[0],e.stT+t/1e3,this.holes.reduce((e,t)=>e+t,0)],n=this.plan;if(!n)return{of:[[this.cv??C[0]?.canvas,1]],clocks:t(this.save())};let r=n.length-1;for(;r>0&&n[r].at>e;)r--;let i=n[r],a=n[r+1],o=a?Math.min(1,Math.max(0,(e-i.at)/(a.at-i.at))):0,s=t(i.sim,a?o*(a.at-i.at):0);return a&&(s[1]=i.sim.ph[0]+o*(a.sim.ph[0]-i.sim.ph[0])),{of:[[C[i.layer].canvas,1-o],...a?[[C[a.layer].canvas,o]]:[]],clocks:s}}};const P=e=>(e.r-e.l)*(e.b-e.t),F=(e,t)=>({l:Math.min(e.l,t.l),t:Math.min(e.t,t.t),r:Math.max(e.r,t.r),b:Math.max(e.b,t.b)}),I=(e,t)=>e.l<=t.r&&t.l<=e.r&&e.t<=t.b&&t.t<=e.b;function L(e,t){let n=[],r=document.createRange(),i=e=>e.width>0&&e.height>0&&n.push({l:e.left-t,t:e.top-t,r:e.right+t,b:e.bottom+t});for(let t of document.querySelectorAll(e)){let e=document.createTreeWalker(t,NodeFilter.SHOW_TEXT);for(let t=e.nextNode();t;t=e.nextNode())if(t.textContent?.trim()){r.selectNodeContents(t);for(let e of r.getClientRects())i(e)}for(let e of t.querySelectorAll(`input, textarea, button`))i(e.getBoundingClientRect())}let a=[];for(let e of n){for(let t=a.length-1;t>=0;t--)I(a[t],e)&&(e=F(a[t],e),a.splice(t,1));a.push(e)}for(;a.length>24;){let e=[0,1],t=1/0;for(let n=0;n<a.length;n++)for(let r=n+1;r<a.length;r++){let i=P(F(a[n],a[r]))-P(a[n])-P(a[r]);i<t&&([t,e]=[i,[n,r]])}let[n,r]=e;a[n]=F(a[n],a[r]),a.splice(r,1)}return a}let R=0,z=0,B=0,V=0;function H(){clearTimeout(z),z=0,!R&&!document.hidden&&(R=requestAnimationFrame(U))}function U(e){if(R=0,B&&e-B<600/S.rate)return void(R=requestAnimationFrame(U));let t=[...x].filter(e=>e.shown());if(!t.length||!D())return void(B=0);let n=performance.now(),r=B?Math.min(50,e-B):1e3/60,i=V?Math.max(0,e-V):0,a=C[0];B=e,V=0;let o=a.gl;T||=(o.texSubImage2D(o.TEXTURE_2D,0,0,0,128,2,o.RGBA,o.FLOAT,/* @__PURE__ */ new Float32Array(1024)),!0);let s=!1,c=[];for(let n of t){if(n.carried(e,t.length===1))continue;let a=n.pass(e,r,i);s||=a,(a||n.dirty)&&c.push(n)}let l=t.filter(e=>e.o.primary).sort((e,t)=>t.size()[0]*t.size()[1]-e.size()[0]*e.size()[1])[0],u=t.map(e=>e.size()),[d,f]=l?l.size():[Math.max(...u.map(e=>e[0])),Math.max(...u.map(e=>e[1]))];try{if(c.length){(a.canvas.width!==d||a.canvas.height!==f)&&([a.canvas.width,a.canvas.height]=[d,f]),!l&&a.canvas.parentElement&&a.canvas.remove();let e=!0;for(let t of c)t!==l&&(e=t.draw(!1,d,f)&&e);l&&(e=l.draw(!0,d,f)&&e),S.frames++,s||=!e}l&&t.length===1&&l.carry(e)&&(s=!1)}catch(e){console.error(e),w=!0,B=0;return}if(S.ms+=performance.now()-n,s)return void(R=requestAnimationFrame(U));B=0,V=e;let p=Math.min(...t.map(e=>e.rest()));p!==1/0&&(z=window.setTimeout(()=>{z=0,R=requestAnimationFrame(U)},p))}document.addEventListener(`visibilitychange`,()=>{document.hidden?(cancelAnimationFrame(R),clearTimeout(z),R=z=B=V=0):(x.forEach(e=>e.dirty=!0),H())}),document.addEventListener(`visibilitychange`,()=>x.forEach(e=>e.watch())),b.addEventListener(`change`,H);export{N as View,S as stats,j as still};