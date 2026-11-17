// One fragment shader per concept. They share a head: the uniforms for voice, state, palette and time,
// the studio that the metal reflects, the chrome itself, and the icon's wave as a function.

// States, in order: idle, listening, thinking, working, needs you, done, failed.
// Each concept gives eight parameters per state; the lab blends them while a state changes.
//   p0 how much the voice moves it      p4 gather to the centre and beat (needs you)
//   p1 how fast its own motion runs     p5 resolve to an even, quiet form (done)
//   p2 size of the resting wave         p6 slump (failed)
//   p3 a packet shuttling (thinking)    p7 the concept's own extra

export const HEAD = `#version 300 es
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
// done: light passes once, left to right
float sweep(float xn){ return u_st[5]*bump(xn+1.7-3.4*smoothstep(0.,1.3,u_ph.w),.3)*(1.-smoothstep(1.15,1.5,u_ph.w)); }

// ---- the studio: a dark room, a wide key overhead, a tall cool strip left, a warm strip right ----
vec3 xl=vec3(0,0,1), xlc=vec3(0);   // one more light that a concept may steer: direction and colour
float amb=1.;                       // and the room's own level
float card(vec3 d, vec3 n, vec2 hs, float s){
  float c=dot(d,n); if(c<.05) return 0.;
  vec3 r=normalize(cross(vec3(0,1,0),n)), u=cross(n,r), p=d/c;
  vec2 uv=vec2(dot(p,r),dot(p,u)), a=abs(uv)-hs; uv/=hs;
  return smoothstep(s,-s,a.x)*smoothstep(s,-s,a.y)*(1.-.18*dot(uv,uv));          // a softbox is hottest at its centre
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
  o=vec4(mix(b,tone(c),a)+(fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))))-.5)/255.,1.);
}

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
  vec2 p=vec2(q.x-xc,q.y-w.x), e=sign(p)*max(abs(p)-vec2(bw,hh)+cr,0.)/cr;
  float rr=length(e), ang=asin(min(rr,1.))*.96;                    // a flat face with rolled shoulders
  n=vec3(e/max(rr,1e-4)*sin(ang),cos(ang)); n.x+=p.x/bw*.16;
  m=vec4(xn,r,p.y/sc,clamp(2.5*px/cr*step(.02,rr),.03,.45));
  return clamp(.5+(1.-rr)*cr/px,0.,1.);
}
#define VIEW float asp=u_res.x/u_res.y, px=2./u_res.y; vec2 q=(gl_FragCoord.xy-u_org-.5*u_res)*px;
`;

const S = (idle, listening, thinking, working, needs, done, failed) => [idle, listening, thinking, working, needs, done, failed];

export const CONCEPTS = [
  {
    id: 'slats', name: 'Slats',
    line: 'The icon, alive: polished slats that rise with the voice and turn to catch the light.',
    voice: 'Loudness leaves the centre and travels outward as height. Vowels swell the whole wave. Each consonant sends a turn through the slats, so the reflections flick.',
    strong: 'Unmistakably the app icon at every size. Reads at 28 px.',
    weak: 'The closest to a classic level meter; the turning light is what keeps it from being one.',
    cost: 'Very light. One slat per pixel, no loops.',
    n: { hero: 21, icon: 21, box: 13, strip: 27 },
    p: S([0, .15, .62, 0, 0, 0, 0, 0], [1, .5, .22, 0, 0, 0, 0, .1], [0, 2.2, .3, 1, 0, 0, 0, .5], [0, 1.2, .8, 0, 0, 0, 0, .2],
      [0, .4, .5, 0, 1, 0, 0, 0], [0, 0, .6, 0, 0, 1, 0, 0], [0, 0, .4, 0, 0, 0, 1, 0]),
    frag: `
void main(){ VIEW
  vec3 n; vec4 m; float a=slat(q,asp,px,u_ph.x,u_p[0],n,m), xn=m.x, r=m.y;
  // each slat stands a little turned and twisted along its length; consonants send a turn outward from the centre
  float turn=(r-.5)+xn*.3+.3*sin(u_ph.x*.8+r*40.)+(.3+u_p[7])*.5*sin(m.z*2.4+r*9.+u_ph.x*.6)
    +u_p[0]*.9*hist(abs(xn)*.42).z*(r>.5?1.:-1.)+2.6*sweep(xn)+u_p[6]*(r-.5)*2.;
  turn=1.05*tanh(turn/1.05);                 // never so far round that the face shows only the wall behind
  n.xz=rot(turn)*n.xz; n.z=max(n.z,.05);
  put(chrome(n,metal(r),m.w)*(.84+.16*smoothstep(-.5,.5,m.z)),a,vec3(0));
}`
  },
  {
    id: 'resonator', name: 'Resonator',
    line: 'The 1.2 resonator in real time: a stack of chrome rings whose sizes are the wave.',
    voice: 'Each ring takes its size from the loudness passing it and from its own band of the spectrum. Consonants roll the rings about the axis, so a twist runs down the stack.',
    strong: 'The richest metal: real depth, rings seen through rings. It is the icon turned in space.',
    weak: 'Needs room. At 28 px the rings merge into a ribbed tube and the wave is hard to read.',
    cost: 'The heaviest: up to a third of the rings are tested per pixel. Still small at notch sizes.',
    n: { hero: 21, icon: 15, box: 11, strip: 21 },
    p: S([0, .15, .62, 0, 0, 0, 0, .5], [1, .5, .22, 0, 0, 0, 0, .62], [0, 2.2, .3, 1, 0, 0, 0, .75], [0, 1.2, .8, 0, 0, 0, 0, .6],
      [0, .4, .5, 0, 1, 0, 0, .8], [0, 0, .6, 0, 0, 1, 0, .55], [0, 0, .4, 0, 0, 0, 1, .38]),
    frag: `
void main(){ VIEW
  float f=u_ph.x, g=u_p[0], yaw=u_p[7]+.08*sin(f*.5)+g*.1*u_w.w;
  // the axis of the stack, and the two directions that span each ring
  vec3 A=vec3(cos(yaw),0.,sin(yaw)), Wd=vec3(-sin(yaw),0.,cos(yaw)), U=vec3(0,1,0);
  mat2 pit=rot(-.2); A.yz=pit*A.yz; Wd.yz=pit*Wd.yz; U.yz=pit*U.yz;
  float Lx=min(asp*.9,max(1.55,asp*.6)), sc=min(1.,asp/1.3), tr=2.*Lx/u_n*.4, soft=clamp(3.*px/tr,.03,.45);
  vec3 col=vec3(0); float a=0.;
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
    float cr=R*.45, d2; vec2 b=abs(p2)-(R-cr), g2;  // distance to the rounded-square outline, and its direction
    if(b.x>0.&&b.y>0.){ float l=length(b); g2=b/l*sign(p2); d2=l-cr; }
    else if(b.x>b.y){ g2=vec2(sign(p2.x),0.); d2=b.x-cr; } else { g2=vec2(0.,sign(p2.y)); d2=b.y-cr; }
    vec3 G=g2.x*Wr+g2.y*Ur, T=cross(A,G);
    vec2 s2=vec2(T.y,-T.x); float sl=length(s2); if(sl<1e-3) continue; s2/=sl;
    float e=d2*dot(G.xy,s2), cov=clamp(.5+(tr-abs(e))/px,0.,1.);   // the tube around the outline, seen from the eye
    if(cov<=0.) continue;
    vec3 S3=vec3(s2,0.), M=normalize(cross(S3,T)); if(M.z<0.) M=-M;
    float en=clamp(e/tr,-1.,1.);
    float shade=.5+.5*smoothstep(-R,R,dot(Q,Wd));                   // the far side of each ring sits in the stack's shade
    col+=(1.-a)*cov*chrome(en*S3+sqrt(1.-en*en)*M,metal(r),soft)*shade; a+=(1.-a)*cov;
  }
  put(col/max(a,1e-3),a,vec3(0));
}`
  },
  {
    id: 'glyphs', name: 'Glyphs',
    line: 'Chrome type on the waveform: plus, equals, slash and colon stack up where the voice is.',
    voice: 'Columns of type grow with the loudness travelling outward, as the 1.2 dictation strip did. Rising speech leans the glyphs, and a consonant spins them on their axis so the faces flash.',
    strong: 'The most characterful, and the only one that says "this becomes text". Thinking, where the type reshuffles, is the best thinking of the lot.',
    weak: 'Busy at hero size, and at 28 px it is three rows of small marks: texture more than wave.',
    cost: 'Light. One glyph per pixel, six distance evaluations.',
    n: { hero: 15, icon: 7, box: 5, strip: 11 },
    p: S([0, .15, .62, 0, 0, 0, 0, 0], [1, .5, .22, 0, 0, 0, 0, 0], [0, 1.6, .5, .45, 0, 0, 0, 1.3], [0, 1.2, .8, 0, 0, 0, 0, .12],
      [0, .4, .5, 0, 1, 0, 0, 0], [0, 0, .6, 0, 0, 1, 0, 0], [0, 0, .4, 0, 0, 0, 1, 0]),
    frag: `
float glyph(vec2 p, float k){
  vec2 a=abs(p);
  if(k<1.) return min(max(a.x-.66,a.y-.24),max(a.x-.24,a.y-.66));                    // +
  if(k<2.) return max(a.x-.66,abs(a.y-.34)-.19);                                   // =
  if(k<3.){ vec2 s=abs(rot(.5)*p); return max(s.x-.22,s.y-.78); }                  // /
  return max(a.x-.25,abs(a.y-.4)-.25);                                            // :
}
void main(){ VIEW
  float X=min(asp*.84,max(1.75,asp*.66)), sc=min(1.,asp/1.3), pitch=2.*X/u_n, i=floor((q.x+X)/pitch), g=u_p[0];
  vec3 col=vec3(0); float a=0.;
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
        vec2 gr=vec2(glyph(pg+vec2(.02,0),k)-d,glyph(pg+vec2(0,.02),k)-d)/.02;
        float bev=smoothstep(.15,0.,-d);                                        // a chamfer round the face
        vec3 cf=chrome(vec3(tl+(gr*R)*bev*.9,1.),metal(rc),clamp(bev*15.*px/du,.04,.45));
        vec3 cs=chrome(vec3(-tl*3.,.5),metal(rc),.25)*.7;                      // the side wall
        col=mix(cs,cf,af);
      }
    }
  }
  put(col,a,vec3(0));
}`
  },
  {
    id: 'lumen', name: 'Lumen',
    line: 'The icon never moves. The voice is light: a glow behind the slats and a beam across them.',
    voice: 'Loudness becomes coloured light in the air behind the metal, leaving the centre as you speak; the slats catch it on their shoulders. A beam of light walks across them while you talk and jumps on each consonant.',
    strong: 'Takes colour best, because the colour is light and the metal stays metal. It is the glow-behind-the-notch idea made whole, and the stillest when idle.',
    weak: 'In silence it is nearly dark, so at hero size it relies on the room being dim. The form itself says nothing about the words.',
    cost: 'Very light, and the geometry never changes, so in the app it could be a cached image lit per frame.',
    n: { hero: 21, icon: 21, box: 13, strip: 27 },
    p: S([0, .3, 1, 0, 0, 0, 0, .2], [1, .5, 1, 0, 0, 0, 0, .28], [0, 2, 1, 0, 0, 0, 0, .22], [0, 1, 1, 0, 0, 0, 0, .28],
      [0, .5, 1, 0, 0, 0, 0, .22], [0, 0, 1, 0, 0, 0, 0, .85], [0, 0, 1, 0, 0, 0, 0, .1]),
    frag: `
void main(){ VIEW
  vec3 n; vec4 m; float a=slat(q,asp,px,0.,0.,n,m), xn=m.x, r=m.y;
  float X=span(asp), xg=q.x/X, ax=abs(xg), f=u_ph.x, g=u_p[0];
  vec4 H=hist(ax*.42);
  // light in the air behind the metal. Spoken; a shuttle while thinking; a slow pass while working; two beats; an even wash; embers.
  float amp=g*(H.x*(.7+.3*cos(xg*2.))+.15*spec(.08+ax*.85))+u_st[0]*.07*(1.+.5*sin(f+xg*2.))
    +u_st[2]*.55*bump(xg-.85*sin(f*1.25),.28)+u_st[3]*.4*bump(xg-(fract(f*.11)*3.2-1.6),.5)
    +u_st[4]*bump(xg,.45)*(.25+.75*beat())+u_st[5]*.3*(1.+2.*sweep(xg))+u_st[6]*.25*bump(q.y+.8,.3);
  float sm=max(u_sig.r,max(u_sig.g,u_sig.b));
  vec3 gc=mix(mix(u_ta,u_tb,.5+.5*sin(xg*2.4+f*.35)),hue(xg*.3+f*.04+.1),u_irid);
  gc=mix(gc,u_sig/max(sm,1e-3),min(sm,1.));
  float c0=wave(xg,.5,0.,0.).x*min(1.,X/1.2)*.95;
  vec3 glow=gc*amp*1.5*bump(q.y-c0,(.26+.3*amp)*min(1.,X/1.2))*smoothstep(1.3,.75,ax);
  // the beam: where it stands along the wave, and how hard it shines
  float pos=u_st[0]*.6*sin(f*.5)+u_st[1]*.9*sin(u_ph.y*3.+u_ph.z*.7)+u_st[2]*.85*sin(f*1.25)+u_st[3]*(fract(f*.11)*3.2-1.6)
    +u_st[5]*(-1.7+3.4*smoothstep(0.,1.3,u_ph.w));
  float I=u_st[0]*.5+u_st[1]*(.5+3.*u_v.y)+u_st[2]*2.2+u_st[3]*1.4+u_st[4]*(.5+1.5*beat())+u_st[5]*2.5*(1.-smoothstep(1.1,1.6,u_ph.w));
  float az=clamp((pos-xn)*1.4,-1.45,1.45);
  xl=normalize(vec3(sin(az),.12,cos(az))); xlc=I*mix(vec3(1),gc,.5); amb=u_p[7];
  n.xz=rot((r-.5)*.9+xn*.3)*n.xz; n.z=max(n.z,.05);
  vec3 col=chrome(n,metal(r),m.w)+glow*pow(1.-normalize(n).z,1.5)*3.+gc*amp*.5*pow(1.-normalize(n).z,2.);
  put(col,a,glow);
}`
  }
];
