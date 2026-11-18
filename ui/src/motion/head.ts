// The head every style shares, as the lab has it (design/motion-lab/shaders.js): the uniforms, the studio the metal
// reflects, the chrome, and the icon's wave.
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
// The app's own, neither of which changes a lab concept at its defaults (u_lm.x 0, no holes):
uniform vec4 u_lm;                  // Lumen laid over the form: how much of it, its own phase, the room's level under it
uniform vec4 u_holes[24];           // text the motion keeps clear, in this view's pixels: centre and half size
uniform vec2 u_hole;                // how many, and how far the light takes to come back around each
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
  if(u_hole.x>0.){
    float d=1e9;
    for(int i=0;i<24;i++){
      if(float(i)>=u_hole.x) break;
      d=min(d,length(max(abs(gl_FragCoord.xy-u_holes[i].xy)-u_holes[i].zw,0.)));
    }
    float f=max(u_hole.y,1.);
    o.rgb=max(mix(b*smoothstep(0.,f,d),m*smoothstep(f*.5,f*3.,d),a)+z,0.)*step(1e-3,d);
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
`;
