const HEAD = "#version 300 es\nprecision highp float;\nuniform vec2 u_res, u_org;\nuniform float u_n;\nuniform float u_irid, u_dim, u_light, u_hoff, u_aux;\nuniform vec4 u_ph;\nuniform vec4 u_v;\nuniform vec4 u_w;\nuniform float u_p[8], u_st[7];\nuniform vec3 u_sig, u_ta, u_tb, u_bg;\nuniform sampler2D u_data;\nuniform vec4 u_lm;\nuniform vec4 u_holes[24], u_gone[24];\nuniform vec4 u_hole;\nuniform vec3 u_pose;\nuniform vec2 u_was;\nout vec4 o;\n#define PI 3.14159265\nfloat hash(float n){ return fract(sin(n*127.1+3.7)*43758.5453); }\nmat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,s,-s,c); }\nvec3 hue(float t){ return .55+.45*cos(6.2832*(t+vec3(0.,.33,.67))); }\nfloat bump(float x, float w){ x/=w; return exp(-x*x); }\nvec4 hist(float age){ return texture(u_data, vec2((max(age,0.)*60.-u_hoff+.5)/128., .25)); }\nvec4 hist3(float age){ return .25*hist(age-.025)+.5*hist(age)+.25*hist(age+.025); }\nfloat spec(float f){ return texture(u_data, vec2((clamp(f,0.,1.)*127.+.5)/128., .75)).r; }\nfloat beat(){ float t=fract(u_ph.w/2.4); return bump(t-.10,.06)+.7*bump(t-.31,.07); }\nfloat sweep(float xn){ return (1.-.88*u_pose.x)*u_st[5]*bump(xn+1.7-3.4*smoothstep(0.,1.3,u_ph.w),.3)*(1.-smoothstep(1.15,1.5,u_ph.w)); }\nvec3 xl=vec3(0,0,1), xlc=vec3(0);\nfloat amb=1.;\nfloat fine=0.;\nfloat card(vec3 d, vec3 n, vec2 hs, float s){\nfloat c=dot(d,n); if(c<.05) return 0.;\nvec3 r=normalize(cross(vec3(0,1,0),n)), u=cross(n,r), p=d/c;\nvec2 uv=vec2(dot(p,r),dot(p,u)), a=abs(uv)-hs; uv/=hs; vec2 on=clamp(uv,-1.,1.);\nreturn smoothstep(s,-s,a.x)*smoothstep(s,-s,a.y)*mix(abs(1.-.18*dot(uv,uv)),1.-.18*dot(on,on),fine);\n}\nvec3 env(vec3 d, float s){\nfloat t=u_ph.x*.03+d.x*.28, az=atan(d.x,d.z);\nvec3 A=mix(u_ta,hue(t+d.y*.3),u_irid), B=mix(u_tb,hue(t-d.y*.25+.5),u_irid);\nvec3 c=vec3(.03+.1*smoothstep(-.4,.9,d.y)+.08*(.5+.5*cos(az*2.+.7)))*(.35+.65*smoothstep(-.8,.1,d.y));\nc+=(.2*smoothstep(.15,-.75,d.z)+1.5*smoothstep(-.62,-.96,d.z))*mix(vec3(1),A,.5)*(.6+.4*d.y);\nc+=2.8*card(d,normalize(vec3(.12,1.,.5)),vec2(1.5,.4),s)*mix(vec3(1),A,.22);\nc+=3.6*card(d,normalize(vec3(-1.,.1,.5)),vec2(.15,1.3),s)*A;\nc+=2.6*card(d,normalize(vec3(1.,.02,.28)),vec2(.22,1.1),s)*B;\nc+=2.2*card(d,normalize(vec3(-.8,.1,-.6)),vec2(.12,1.2),s)*A;\nc+=1.8*card(d,normalize(vec3(.85,0.,-.5)),vec2(.1,1.1),s)*mix(vec3(1),B,.6);\nc+=1.7*card(d,normalize(vec3(-.42,.05,1.)),vec2(.045,1.2),s);\nc+=1.2*card(d,normalize(vec3(.6,0.,1.)),vec2(.03,1.2),s);\nc+=.4*card(d,normalize(vec3(.2,-1.,.6)),vec2(1.2,.5),s+.2)*B;\nc+=1.5*card(d,normalize(vec3(-.1,1.,-.5)),vec2(1.3,.34),s)*mix(vec3(1),A,.3);\nc+=.3*card(d,normalize(vec3(.1,-1.,-.55)),vec2(1.2,.4),s+.2)*B;\nc+=card(d,normalize(vec3(0.,-.8,.6)),vec2(1.5,.32),s+.12)*u_sig;\nc=c*u_dim*amb+card(d,xl,vec2(.2,1.5),s+.04)*xlc;\nfloat L=dot(c,vec3(.3,.5,.2));\nreturn mix(c,vec3(.8,.82,.85)*(1.-.9*smoothstep(.12,1.5,L))*(.78+.22*d.y)+(c-L)*.25,u_light);\n}\nvec3 chrome(vec3 n, vec3 tint, float s){\nn=normalize(n);\nvec3 r=reflect(vec3(0,0,-1),n);\nfloat fr=pow(1.-clamp(n.z,0.,1.),4.), k=(.03+.14*u_irid)*(.4+fr);\nvec3 c=vec3(env(normalize(vec3(r.xy*(1.+k),r.z)),s).r, env(r,s).g, env(normalize(vec3(r.xy*(1.-k),r.z)),s).b);\nc*=mix(tint,vec3(1),fr);\nreturn c*mix(vec3(1),hue(fr*1.3+n.x*.35+.58)*1.25,.4*u_irid);\n}\nconst vec3 SILVER=vec3(.82,.84,.88);\nvec3 metal(float r){ return r>.86?mix(SILVER,u_tb,.7):r<.12?mix(SILVER,u_ta,.55):SILVER; }\nvec3 tone(vec3 c){ c=c*(2.51*c+.03)/(c*(2.43*c+.59)+.14); return pow(clamp(c,0.,1.),vec3(.4545)); }\nvoid put(vec3 c, float a, vec3 g){\ng=1.-exp(-g);\nfloat ga=max(g.r,max(g.g,g.b));\nvec3 b=mix(u_bg+g,u_bg*(1.-ga)+g*.92,u_light);\nvec3 m=tone(c);\nfloat z=(fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))))-.5)/255.;\no=vec4(mix(b,m,a)+z,1.);\nif(u_hole.x>0.||u_hole.w<1.){\nfloat d=1e9, e=1e9, f=max(u_hole.y,1.);\nfor(int i=0;i<24;i++){\nif(float(i)<u_hole.x) d=min(d,length(max(abs(gl_FragCoord.xy-u_holes[i].xy)-u_holes[i].zw,0.)));\nif(u_hole.w<1.&&float(i)<u_hole.z) e=min(e,length(max(abs(gl_FragCoord.xy-u_gone[i].xy)-u_gone[i].zw,0.)));\n}\no.rgb=max(mix(b*smoothstep(0.,f,d),m*smoothstep(f*.5,f*3.,d),a)+z,0.)*step(1e-3,d);\nif(u_hole.w<1.) o.rgb=mix(max(mix(b*smoothstep(0.,f,e),m*smoothstep(f*.5,f*3.,e),a)+z,0.)*step(1e-3,e),o.rgb,u_hole.w);\n}\no.a=max(o.r,max(o.g,o.b));\n}\nfloat swell(float t){ float x=clamp((t-.5)/2.2,0.,1.); return smoothstep(0.,.5,t)*(x<.12?1.-x*x/.12:(1.-x)*(1.-x)/.88); }\nfloat pulse(float ax){ return u_pose.z*swell(u_pose.y-ax*.9)+u_was.y*swell(u_was.x-ax*.9); }\nvec2 wave(float xn, float rnd, float f, float g){\nfloat ax=abs(xn);\nfloat h=u_p[2]*.5*(.6+.4*bump(xn-.45*sin(f*.6),.6));\nfloat c=-u_p[2]*.17*sin(PI*xn+.5*sin(f*.6+1.2));\nvec4 H=hist(ax*.42);\nh+=g*(.6*H.x*(.6+.4*cos(ax*2.))+.2*spec(.08+ax*.85)+.08*u_w.x);\nc+=g*H.x*(-.2*sin(PI*xn)+.08*sin(xn*4.-u_ph.y*4.));\nh=mix(h,.13+.42*bump(xn-.82*sin(f*1.25),.2),u_p[3]);        c*=1.-u_p[3];\nh=mix(h,(.1+.62*bump(xn,.34))*(1.+.2*beat()),u_p[4]);       c*=1.-u_p[4];\nh=mix(h,.46*sqrt(max(1.-xn*xn*.8,0.)),u_p[5]);              c*=1.-u_p[5];\nh=mix(h,.07+.16*rnd*rnd,u_p[6]);                            c=mix(c,-.42+.1*rnd,u_p[6]);\nc-=u_pose.x*.1*sin(PI*xn)*(1.-u_p[6]);\nh+=.06*pulse(ax)*(.55+.45*cos(ax*2.))*(1.-u_p[6]);\nreturn vec2(c,h*smoothstep(1.,.72,ax));\n}\nfloat span(float asp){ return min(asp*.8,max(1.35,asp*.62)); }\nfloat slat(vec2 q, float asp, float px, float f, float g, out vec3 n, out vec4 m){\nfloat X=span(asp), sc=min(1.,X/1.2)*.95, pitch=2.*X/u_n, i=floor((q.x+X)/pitch);\nn=vec3(0,0,1); m=vec4(0,.5,0,.03);\nif(i<0.||i>=u_n) return 0.;\nfloat xc=-X+(i+.5)*pitch, xn=xc/X, r=hash(i+1.), bw=pitch*.37, cr=bw*.36;\nvec2 w=wave(xn,r,f,g)*sc;\nfloat hh=max(w.y,bw);\nvec2 p=vec2(q.x-xc,q.y-w.x), b=(abs(p)-vec2(bw,hh))/cr+1., e=sign(p)*max(b,0.);\nfloat rr=length(e), ang=asin(min(rr,1.))*.96, h=.5*px/cr;\nn=vec3(e/max(rr,1e-4)*sin(ang),cos(ang)); n.x+=p.x/bw*.16;\nfloat S=max(2.5*px/cr,.03), t=min(length(max(b+h,0.))/(2.*h),1.), k=sqrt(1.-min(rr*rr,.9));\nm=vec4(xn,r,p.y/sc,.03*pow(min(S,.45)/.03,t)/k); fine=smoothstep(.45,.9,S/k)*min(4.*t,1.);\nreturn clamp(.5+(1.-rr)*cr/px,0.,1.);\n}\n#define VIEW float asp=u_res.x/u_res.y, px=2./u_res.y; vec2 q=(gl_FragCoord.xy-u_org-.5*u_res)*px;\nvec3 lc=vec3(0); float la=0.;\nvec3 lumen(vec2 q, float X){\namb=mix(1.,u_lm.z,u_lm.x);\nif(u_lm.x<=0.) return vec3(0);\nfloat xg=q.x/X, ax=abs(xg), f=u_lm.y, g=u_p[0];\nvec4 H=hist(ax*.42);\nfloat amp=g*(H.x*(.7+.3*cos(xg*2.))+.15*spec(.08+ax*.85))+u_st[0]*.07*(1.+.5*sin(f+xg*2.))\n+u_st[2]*.55*bump(xg-.85*sin(f*1.25),.28)+u_st[3]*.4*bump(xg-(fract(f*.11)*3.2-1.6),.5)\n+u_st[4]*bump(xg,.45)*(.25+.75*beat())+u_st[5]*.3*(1.+2.*sweep(xg))+u_st[6]*.25*bump(q.y+.8,.3);\nfloat sm=max(u_sig.r,max(u_sig.g,u_sig.b));\nvec3 gc=mix(mix(u_ta,u_tb,.5+.5*sin(xg*2.4+f*.35)),hue(xg*.3+f*.04+.1),u_irid);\ngc=mix(gc,u_sig/max(sm,1e-3),min(sm,1.));\nfloat c0=-.17*sin(PI*xg+.5*sin(1.2))*min(1.,X/1.2)*.95;\namp*=u_lm.x; lc=gc; la=amp;\nreturn gc*amp*1.5*bump(q.y-c0,(.26+.3*amp)*min(1.,X/1.2))*smoothstep(1.3,.75,ax);\n}\nvoid beam(float xn){\nif(u_lm.x<=0.) return;\nfloat f=u_lm.y;\nfloat pos=u_st[0]*.6*sin(f*.5)+u_st[1]*.9*sin(u_ph.y*3.+u_ph.z*.7)+u_st[2]*.85*sin(f*1.25)+u_st[3]*(fract(f*.11)*3.2-1.6)\n+u_st[5]*(-1.7+3.4*smoothstep(0.,1.3,u_ph.w));\nfloat I=u_st[0]*.5+u_st[1]*(.5+3.*u_v.y)+u_st[2]*2.2+u_st[3]*1.4+u_st[4]*(.5+1.5*beat())+u_st[5]*2.5*(1.-.88*u_pose.x)*(1.-smoothstep(1.1,1.6,u_ph.w));\nfloat az=clamp((pos-xn)*1.4,-1.45,1.45);\nxl=normalize(vec3(sin(az),.12,cos(az))); xlc=u_lm.x*I*mix(vec3(1),lc,.5);\n}\nvec3 sheen(vec3 n, vec3 glow){ float z=min(normalize(n).z,1.); return glow*pow(1.-z,1.5)*3.+lc*la*.5*pow(1.-z,2.); }";

const VERT = '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}';

const FRAG = `
uniform vec4 u_view;
uniform float u_k[8];
uniform vec4 u_ra[3];
uniform vec4 u_rb[3];
uniform vec3 u_rc[3];
const float N=21., X=1.3;
const vec3 BLOOM[7]=vec3[7](vec3(.769,.435,.235),vec3(.863,.604,.322),vec3(.875,.894,.925),vec3(.561,.698,.847),vec3(.373,.498,.753),vec3(.655,.471,.604),vec3(.769,.435,.235));
vec3 bloom(float t){ t=fract(t)*6.; int i=int(t); return mix(BLOOM[i],BLOOM[i+1],fract(t)); }
struct Hit{ float cov, af, soft, fin, r, sh; vec3 n; };
vec3 lit(Hit h, vec3 glow, vec3 side){
fine=h.fin;
vec3 c=chrome(h.n,mix(SILVER,metal(h.r),u_k[0]),h.soft)*h.sh+sheen(h.n,glow)*u_k[0];
return mix(side,c,h.af/max(h.cov,1e-4));
}
float slabd(vec2 p, vec2 hb, float cr, float sk, out vec2 b){
p.x-=p.y*sk; b=(abs(p)-hb)/cr+1.;
return (length(max(b,0.))+min(max(b.x,b.y),0.)-1.)*cr;
}
void main(){
vec2 fc=gl_FragCoord.xy-u_org-.5*u_res;
float px=1./u_view.z;
vec2 q=(fc-u_view.xy)*px;
float fan=u_k[0], beads=u_k[1], gat=u_k[2], f=u_ph.x, g=u_p[0];
float pitch=2.*X/N, bw0=pitch*.37, Hm=u_k[4], ms=Hm/.84, Wm=.27*ms;
vec3 col=vec3(0), glow=vec3(0); float a=0.;
if(u_k[3]>0.){
glow=lumen(q,X);
vec2 tl=vec2(.5*sin(u_view.w),.14+.1*cos(u_view.w*.7));
float ext=.14*ms*(1.-smoothstep(0.,.18,fan)); vec2 bb;
float wall=ext>0.?clamp(.5-slabd(q+tl*ext,vec2(Wm,Hm),.07*ms,.44,bb)*.92/px,0.,1.):0.;
Hit h1, h2; h1.cov=0.; h2.cov=0.;
for(float k=0.;k<N;k++){
float hk=floor((k+1.)*.5), i=10.+(mod(k,2.)<.5?hk:-hk), xn=(i+.5)/N*2.-1., ax=abs(xn), r=hash(i+1.);
float sp=clamp(fan*1.45-.45*(1.-ax),0.,1.); sp=sp*sp*(3.-2.*sp);
float ga=clamp(gat*1.7-ax*.7,0.,1.); ga=ga*ga*(3.-2.*ga);
float dx=xn*(X-Wm)*sp, cx=(xn*Wm+dx)*(1.-ga), sk=.44*(1.-smoothstep(0.,.7,sp));
float bwm=mix(Wm/N+.6*px,bw0,sp), lx=q.x-cx-q.y*sk;
if(abs(lx)>max(bwm,u_k[5])+2.*px) continue;
vec2 w=wave(xn,r,f,g)*.95;
float up=smoothstep(.1,1.,sp), br=mix(bw0,u_k[5],ga);
float hh=mix(mix(Hm,max(w.y,bw0),up),br,beads), bw=mix(bwm,br,beads), cr=mix(mix(bwm*.5,bw0*.36,sp),br,beads), cy=w.x*up*(1.-beads);
float mk=1.-smoothstep(0.,.5,sp), dm=0.; vec2 bm=vec2(0);
hh+=.3*ms*mk*(1.-up);
vec2 ps=vec2(lx,q.y-cy);
if(abs(ps.y)>hh+2.*px) continue;
vec2 b=(abs(ps)-vec2(bw,hh))/cr+1.;
float d=(length(max(b,0.))+min(max(b.x,b.y),0.)-1.)*cr, af=clamp(.5-d/px,0.,1.);
if(mk>0.){ dm=slabd(q-vec2(dx,0.),vec2(Wm,Hm),.07*ms,.44,bm); af*=mix(1.,clamp(.5-dm*.92/px,0.,1.),mk); }
if(af<=0.||(h1.cov>0.&&af<=h2.cov)) continue;
Hit h; h.cov=af; h.af=af; h.r=r;
vec2 e=sign(ps)*max(b,0.);
float rr=length(e), ang=asin(min(rr,1.))*.96, hp=.5*px/cr;
vec3 ns=vec3(e/max(rr,1e-4)*sin(ang),cos(ang)); ns.y-=sk*ns.x; ns.x+=ps.x/bw*.16*(1.-beads);
float turn=(r-.5)+xn*.3+.3*sin(f*.8+r*40.)+(.3+u_p[7])*.5*sin(ps.y*2.4+r*9.+f*.6)+g*.9*hist(ax*.42).z*(r>.5?1.:-1.);
turn=1.05*tanh(turn/1.05)*(1.-beads*.75)*smoothstep(0.,.8,sp);
ns.xz=rot(turn)*ns.xz; ns.z=max(ns.z,.05);
float S=max(2.5*px/cr,.03), t=min(length(max(b+hp,0.))/(2.*hp),1.), kk=sqrt(1.-min(rr*rr,.9));
h.soft=.03*pow(min(S,.45)/.03,t)/kk; h.fin=smoothstep(.45,.9,S/kk)*min(4.*t,1.); h.n=ns;
h.sh=.84+.16*smoothstep(-.5,.5,ps.y);
if(mk>0.){
vec2 pm=vec2(q.x-dx-q.y*.44,q.y), em=sign(pm)*max(bm,0.); float rm=length(em);
vec2 gm=rm>0.?em/rm:(bm.x>bm.y?vec2(sign(pm.x),0.):vec2(0.,sign(pm.y))); gm.y-=.44*gm.x;
float bev=smoothstep(.13*ms,0.,-dm);
h.n=normalize(mix(ns,normalize(vec3(tl+gm*bev*.9+(q-vec2(dx,0.))/ms*.3,1.)),mk));
h.soft=mix(h.soft,clamp(bev*15.*px/ms,.04,.45),mk); h.fin*=1.-mk; h.sh=mix(h.sh,1.,mk);
}
if(h1.cov<=0.){ h1=h; if(af>=.999) break; } else h2=h;
}
vec3 side=vec3(0);
if(wall>0.){ vec3 cs=chrome(vec3(-tl*3.,.5),SILVER,.25); side=mix(vec3(dot(cs,vec3(.3,.5,.2))),cs,.15)*.5; col=side; a=wall; }
if(h1.cov>0.){
vec3 c=lit(h1,glow,side); float ca=h1.cov;
if(h2.cov>0.&&h1.cov<.999){ c=mix(lit(h2,glow,side),c,h1.cov); ca=max(ca,h2.cov); }
col=mix(col,c,ca); a=max(a,ca);
}
}
for(int k=0;k<3;k++){
vec4 A=u_ra[k], B=u_rb[k];
if(A.w<=0.) continue;
vec2 p=q-A.xy; float l=length(p), e=l-A.z, tr=A.w, an=atan(p.y,p.x);
if(B.z>0.) glow+=bloom(an/6.2832+.62)*B.z*(.5*exp(-abs(e)/(tr*2.2))+.22*exp(-abs(e)/(tr*9.)))*smoothstep(tr*26.,tr*10.,abs(e));
float cov=clamp(.5+(tr-abs(e))/px,0.,1.);
if(cov<=0.) continue;
float en=clamp(e/tr,-1.,1.);
vec3 n=vec3(p/max(l,1e-4)*en,sqrt(1.-en*en));
xlc=vec3(0);
if(k==0&&u_k[7]>0.){ float az=clamp((u_k[6]-p.x/max(A.z,.01))*1.4,-1.45,1.45); xl=normalize(vec3(sin(az),.12,cos(az))); xlc=vec3(u_k[7]); }
fine=smoothstep(.45,.9,3.*px/tr);
vec3 c=chrome(n,mix(SILVER,vec3(1.,.7,.4),B.z*.85),clamp(3.*px/tr,.03,.45))*B.w;
float lx=clamp(p.x/max(A.z,.01)*.5+.5,0.,1.);
c*=mix(vec3(1),mix(mix(vec3(.9,.62,.38),vec3(1.06),smoothstep(0.,.45,lx)),vec3(.52,.64,.98),smoothstep(.5,1.,lx))*1.12,u_rc[k].x);
if(B.y>0.){ float dA=mod(an-B.x,6.2832); c+=B.y*(exp(-dA*1.5)*smoothstep(0.,.3,dA)+smoothstep(5.9,6.2832,dA)*(1.-smoothstep(0.,.3,dA)))*(1.5*n.z*n.z*n.z+.2); }
col=mix(col,c,cov); a=max(a,cov);
}
put(col,a,glow);
}`;

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const mixes = (a, b, t) => a.map((v, i) => mix(v, b[i], t));

const SAID = [[0.1, 0.9, 0.2, 0.2], [0.36, 0.4, 0.12, 0.1], [0.52, 0.55, 0.14, 0.1], [0.72, 1, 0.24, 0.1], [1.0, 0.6, 0.2, 0.7], [1.36, 0.95, 0.2, 0.5], [1.6, 0.6, 0.2, 0.6], [1.94, 0.85, 0.16, 0.2],
  [2.14, 0.55, 0.18, 0.8], [2.46, 0.8, 0.16, 0.7], [2.7, 0.45, 0.12, 0], [2.88, 0.8, 0.2, 0], [3.14, 0.9, 0.24, 0.1], [3.46, 0.4, 0.12, 0], [3.64, 1, 0.34, 0.6]];
function heard(t) {
  let level = 0, onset = 0, sib = 0;
  for (const [t0, amp, dur, s] of SAID) {
    const x = (t - t0) / dur;
    if (x <= 0) continue;
    const env = amp * Math.min(1, x / 0.22) * Math.exp(-Math.max(0, x - 0.22) * 1.5);
    level += env;
    sib += env * s;
    onset += (0.5 + 0.5 * s) * Math.exp(-(t - t0) / 0.1);
  }
  level = Math.min(1, level * 0.8);
  return [level, 0.3 + 0.5 * Math.min(1, sib), Math.min(1, onset), level * 0.85];
}
const DATA = new Float32Array(128 * 2 * 4);
/** The two rows the forms read, as they stand `t` seconds into the saying: the last two seconds, newest first, and the spectrum. */
function voice(t) {
  for (let j = 0; j < 128; j++) DATA.set(heard(t - j / 60), j * 4);
  const now = heard(t);
  for (let j = 0; j < 128; j++) {
    const fq = j / 127;
    DATA[512 + j * 4] = now[0] * (Math.exp(-(((fq - 0.2) / 0.18) ** 2)) + now[1] * 0.6 * Math.exp(-(((fq - 0.55) / 0.22) ** 2)));
  }
  return now;
}

const SIGNAL = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [2, 1.05, 0.22], [0.45, 1.2, 0.75]];
const DIM = [0.8, 1, 0.95, 0.92, 0.85, 1.05];
const SLATS = [[0, 0.15, 0.62, 0, 0, 0, 0, 0], [1, 0.5, 0.22, 0, 0, 0, 0, 0.1]];
/** The seconds a working ring's light takes round its ring (parts.css ring-turn). */
const TURN = 1.8;

/**
 * Where everything is at `b` in the story (0 the first screen, then 1 say, 2 place, 3 work, 4 answer, 5 keep), in a
 * stage of `G`: its width and height, where the mark stands on the first screen and how tall (`mark`), where the
 * story's forms are centred (`mid`), and how many CSS pixels one unit of the form is (`unit`). What the shader is
 * told, and what the page lays its few words by: the rings, and the box all of it is drawn in.
 */
export function pose(b, G) {
  const S = G.unit, Hm = G.mark.h / 2 / S;
  const fan = ss(0.1, 0.78, b), move = ss(0.04, 0.72, b), beads = ss(1.42, 1.7, b), gat = ss(1.58, 1.96, b);
  const cx = mix(G.mark.x, G.mid.x, move), cy = mix(G.mark.y, G.mid.y, move);
  const tau = mix(-0.2, 4.2, clamp((b - 0.5) / 0.55));
  const pieces = b < 1.98;
  const st = [1 - ss(0.5, 0.8, b), ss(0.5, 0.8, b) * (1 - ss(1.5, 1.8, b)), ss(1.5, 1.8, b) * (1 - ss(2.4, 2.8, b)), ss(2.4, 2.8, b) * (1 - ss(3.4, 3.8, b)), ss(3.4, 3.8, b) * (1 - ss(4.4, 4.8, b)), ss(4.4, 4.8, b)];
  const sig = [0, 1, 2].map((c) => st.reduce((s, w, i) => s + w * SIGNAL[i][c], 0));
  const dim = st.reduce((s, w, i) => s + w * DIM[i], 0);
  const listen = ss(0.55, 0.95, b);
  const p = mixes(SLATS[0], SLATS[1], listen);
  const BEAD = 0.08, RW = 0.4, TW = 0.04;
  const open = ss(2.28, 2.8, b), asks = ss(3.4, 3.85, b) * (1 - ss(4.38, 4.72, b)), done = ss(4.45, 4.85, b), away = ss(3.4, 3.85, b) * (1 - ss(4.38, 4.8, b));
  const r0 = { x: 0, y: 0, R: mix(RW * open, 0.48, asks), tube: pieces ? 0 : mix(mix(BEAD, TW, open), 0.04, asks), turn: ss(2.7, 2.9, b) * (1 - ss(3.32, 3.5, b)), asks, level: 1, done, full: mix(RW, 0.48, asks) + mix(TW, 0.04, asks) };
  const side = (at, from, sign, until) => {
    const grow = ss(from, from + 0.34, b);
    return { x: sign * mix(at, at + 0.22, away), y: 0, R: RW * grow * mix(1, 0.72, away), tube: TW * Math.min(1, grow * 3) * mix(1, 0.8, away), turn: ss(from + 0.2, from + 0.4, b) * (1 - ss(until, until + 0.3, b)), asks: 0, level: mix(1, 0.6, away), full: (RW + TW) * mix(1, 0.72, away) };
  };
  const rings = [r0, side(1.2, 2.52, -1, 4.55), side(1.2, 2.66, 1, 9)];
  const turning = !pieces && rings.some((r) => r.tube > 0 && r.turn > 0.01);
  const Wm = (0.27 * Hm) / 0.84;
  const lumen = 0.8 * ss(0.5, 0.75, b) * (1 - ss(1.2, 1.5, b));
  let box = pieces ? [Math.max(fan < 1 ? Wm + 0.44 * Hm + 0.2 : 0, 1.36 * Math.min(1, fan * 1.45) + 0.1, lumen > 0 ? 1.72 : 0), Math.max(fan < 1 ? Hm + 0.06 : 0, lumen > 0 ? 1.25 : 0.9)] : [0, 0];
  for (const r of rings) if (r.tube > 0) box = [Math.max(box[0], Math.abs(r.x) + r.R + r.tube * (1 + 27 * r.asks) + 0.02), Math.max(box[1], r.R + r.tube * (1 + 27 * r.asks) + 0.02)];
  return {
    b, S, cx, cy, tau, turning, st, p, sig, dim, irid: 0.3, lumen,
    k: [fan, beads, gat, pieces ? 1 : 0, Hm, BEAD, mix(-1.7, 1.7, clamp((b - 4.42) / 0.5)), 2.5 * ss(4.42, 4.5, b) * (1 - ss(4.84, 4.94, b))],
    lean: 0.55 + 1.1 * b,
    rings,
    /** The rings where the page can lay words by them: centre and outer radius, in CSS pixels of the stage. */
    seats: rings.map((r) => ({ x: cx + r.x * S, y: cy + r.y * S, r: r.full * S, on: r.tube > 0 ? Math.min(1, r.R / (RW * 0.6)) : 0 })),
    box: { x0: cx - box[0] * S, x1: cx + box[0] * S, y0: cy - box[1] * S, y1: cy + box[1] * S },
  };
}

/** The seats laid where a pose has its rings: each a fine circle as large as its ring will be, with the project's name
 *  under it; the agent's name once its ring has opened, and under the task's ring what changed once it is done. The
 *  seats come as the beads gather, and the task's project is named as its bead lands. Everything is moved and sized
 *  by transform and shown by opacity, so the page is never laid out again for it. */
export function lay(seats, P) {
  seats.forEach((seat, i) => {
    const s = P.seats[i], at = (el, dy) => el && (el.style.transform = `translate(-50%,${(s.r + dy).toFixed(1)}px)`);
    seat.style.transform = `translate(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px)`;
    seat.style.opacity = ss(1.5, 1.85, P.b).toFixed(3);
    seat.firstElementChild.style.transform = `scale(${(s.r / 100).toFixed(4)})`;
    const [name, who, what] = ['b', 'em', 'u'].map((t) => seat.querySelector(t));
    at(name, 14);
    at(who, 34);
    at(what, 56);
    who.style.opacity = s.on.toFixed(3);
    if (what) what.style.opacity = ss(4.6, 4.85, P.b).toFixed(3);
    if (!i) seat.classList.toggle('here', P.b > 1.88);
  });
}

const UNIFORMS = ['u_res', 'u_org', 'u_n', 'u_irid', 'u_dim', 'u_light', 'u_hoff', 'u_aux', 'u_ph', 'u_v', 'u_w', 'u_p', 'u_st', 'u_sig', 'u_ta', 'u_tb', 'u_bg', 'u_data', 'u_lm', 'u_hole', 'u_pose', 'u_was',
  'u_view', 'u_k', 'u_ra', 'u_rb', 'u_rc'];

/** The chrome in a canvas that fills the stage. Null where the page cannot draw it well: no WebGL 2, or one that a
 *  processor would have to draw (a browser without its graphics card takes over a minute to build this shader). The
 *  page then keeps its stills. `lost`, when the browser takes the context away later. */
export function mount(canvas, lostNow = () => {}) {
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, failIfMajorPerformanceCaveat: true });
  if (!gl) return null;
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  if (info && /swiftshader|llvmpipe|softpipe|software|basic render/i.test(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))) return null;
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, HEAD + FRAG]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(prog), ...gl.getAttachedShaders(prog).map((s) => gl.getShaderInfoLog(s)));
    return null;
  }
  gl.useProgram(prog);
  const U = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)]));
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 128, 2, 0, gl.RGBA, gl.FLOAT, null);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  gl.uniform1i(U.u_data, 0);
  gl.uniform1f(U.u_n, 21);
  gl.uniform1f(U.u_light, 0);
  gl.uniform1f(U.u_hoff, 0);
  gl.uniform1f(U.u_aux, 0);
  gl.uniform3f(U.u_ta, 0.8, 0.9, 1);
  gl.uniform3f(U.u_tb, 1, 0.82, 0.7);
  gl.uniform3f(U.u_bg, 0, 0, 0);
  gl.uniform4f(U.u_hole, 0, 0, 0, 1);
  gl.uniform3f(U.u_pose, 0, 0, 0);
  gl.uniform2f(U.u_was, 9, 0);
  gl.uniform2f(U.u_org, 0, 0);
  gl.enable(gl.SCISSOR_TEST);
  gl.clearColor(0, 0, 0, 0);
  let dpr = 1, drawn = null, lost = false, said = NaN;
  canvas.addEventListener('webglcontextlost', () => ((lost = true), lostNow()));
  const api = {
    get lost() { return lost; },
    frames: 0,
    /** The canvas as large as its place, at up to two device pixels a CSS pixel. */
    size(w, h, ratio) {
      dpr = Math.min(2, ratio || 1);
      const W = Math.round(w * dpr), H = Math.round(h * dpr);
      if (canvas.width !== W || canvas.height !== H) (canvas.width = W), (canvas.height = H), (drawn = null);
    },
    /** One frame of a pose, `at` seconds on a working ring's clock: only the box the forms are in is drawn. */
    draw(P, at = 0) {
      if (lost) return;
      const W = canvas.width, H = canvas.height;
      const x0 = Math.max(0, Math.floor(P.box.x0 * dpr) - 2), x1 = Math.min(W, Math.ceil(P.box.x1 * dpr) + 2), y0 = Math.max(0, Math.floor(P.box.y0 * dpr) - 2), y1 = Math.min(H, Math.ceil(P.box.y1 * dpr) + 2);
      gl.viewport(0, 0, W, H);
      if (drawn) (gl.scissor(drawn[0], H - drawn[3], drawn[2] - drawn[0], drawn[3] - drawn[1]), gl.clear(gl.COLOR_BUFFER_BIT));
      else (gl.scissor(0, 0, W, H), gl.clear(gl.COLOR_BUFFER_BIT));
      drawn = [x0, y0, x1, y1];
      if (x1 <= x0 || y1 <= y0) return;
      gl.scissor(x0, H - y1, x1 - x0, y1 - y0);
      if (P.tau !== said) {
        said = P.tau;
        const now = voice(P.tau);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 2, gl.RGBA, gl.FLOAT, DATA);
        gl.uniform4f(U.u_v, now[0], now[0], now[2], now[1]);
        gl.uniform4f(U.u_w, now[3], Math.max(0, now[1] - 0.3) * 2, 0.4, Math.min(1, now[0] * 2));
      }
      gl.uniform2f(U.u_res, W, H);
      gl.uniform1f(U.u_dim, P.dim);
      gl.uniform1f(U.u_irid, P.irid);
      gl.uniform4f(U.u_lm, P.lumen, P.b * 2.4, 0.5, 0);
      gl.uniform4f(U.u_ph, P.b * 2.4, P.tau, 0, 9);
      gl.uniform1fv(U.u_p, P.p);
      gl.uniform1fv(U.u_st, [...P.st, 0]);
      gl.uniform3fv(U.u_sig, P.sig);
      gl.uniform4f(U.u_view, (P.cx * dpr) - W / 2, H / 2 - (P.cy * dpr), P.S * dpr, P.lean);
      gl.uniform1fv(U.u_k, P.k);
      gl.uniform4fv(U.u_ra, P.rings.flatMap((r) => [r.x, r.y, r.R, r.tube]));
      gl.uniform4fv(U.u_rb, P.rings.flatMap((r, i) => [-(at / TURN + i * 0.37) * 2 * Math.PI, r.turn, r.asks, r.level]));
      gl.uniform3fv(U.u_rc, P.rings.flatMap((r) => [r.done || 0, 0, 0]));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      api.frames++;
    },
  };
  return api;
}
