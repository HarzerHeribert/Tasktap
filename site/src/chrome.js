// The page's chrome: one body of the app's metal that the story turns, as the page is scrolled, into the things
// Tasktap does. The mark (one slab) parts into the slats of a voice; the slats fall to beads and gather where the task
// belongs; the bead opens into an agent's ring, and two more rings join it; the ring that asks comes forward in the
// attention colour with the notch's own bloom round it; answered, it closes whole and a light passes over it once.
// The metal, the studio it reflects and the tone curve are the app's, unchanged: scripts/render-site.cjs pastes the
// head every style of the app's motion shares (ui/src/motion/head.ts) in below, and what is written here is only the
// form, as slats.ts, resonator.ts and mark.ts are the forms of the app. Nothing here runs by a clock of its own
// except a working ring's light: every other value is the place in the story, so scrolling back plays it backwards,
// and a page at rest draws nothing.
const HEAD = /*HEAD*/'';

const VERT = '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}';

const FRAG = `
uniform vec4 u_view;    // the form's centre from the canvas's, in device pixels (y up); device pixels per unit; how the mark's face leans
uniform float u_k[8];   // 0 the slab parted into slats; 1 slats fallen to beads; 2 beads gathered; 3 whether there are slices at all;
                        // 4 the slab's half height; 5 the bead's radius once gathered; 6 where the passing light is; 7 how bright
uniform vec4 u_ra[3];   // a ring: its centre, its radius, its tube's radius (0: no ring)
uniform vec4 u_rb[3];   // its turning light's angle and level; how far it asks; how bright it is
uniform vec3 u_rc[3];   // how far it is done: a result not yet seen
const float N=21., X=1.3;
const vec3 BLOOM[7]=vec3[7](vec3(.769,.435,.235),vec3(.863,.604,.322),vec3(.875,.894,.925),vec3(.561,.698,.847),vec3(.373,.498,.753),vec3(.655,.471,.604),vec3(.769,.435,.235));
vec3 bloom(float t){ t=fract(t)*6.; int i=int(t); return mix(BLOOM[i],BLOOM[i+1],fract(t)); }   // tokens.css --bloom, round a ring

struct Hit{ float cov, af, soft, fin, r, sh; vec3 n; };
vec3 lit(Hit h, vec3 glow, vec3 side){
  fine=h.fin;
  vec3 c=chrome(h.n,mix(SILVER,metal(h.r),u_k[0]),h.soft)*h.sh+sheen(h.n,glow)*u_k[0];
  return mix(side,c,h.af/max(h.cov,1e-4));
}
// A slab: an upright box that leans by sk, its shoulders rolled cr wide. Its distance; b: where the point is in it.
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
    glow=lumen(q,X);                                               // while the task is said: the voice as light in the air behind the slats (head.ts)
    vec2 tl=vec2(.5*sin(u_view.w),.14+.1*cos(u_view.w*.7));        // which way the mark's face looks (mark.ts)
    // The slab's side wall (mark.ts), which draws in as the slab begins to part.
    float ext=.14*ms*(1.-smoothstep(0.,.18,fan)); vec2 bb;
    float wall=ext>0.?clamp(.5-slabd(q+tl*ext,vec2(Wm,Hm),.07*ms,.44,bb)*.92/px,0.,1.):0.;
    Hit h1, h2; h1.cov=0.; h2.cov=0.;
    for(float k=0.;k<N;k++){
      // The middle one first, then outward by turns: it lies over the others where they meet again as beads.
      float hk=floor((k+1.)*.5), i=10.+(mod(k,2.)<.5?hk:-hk), xn=(i+.5)/N*2.-1., ax=abs(xn), r=hash(i+1.);
      // The slab is twenty-one slices side by side. The outer ones leave first; each stands up, widens into a slat
      // and takes its height in the wave as it goes.
      float sp=clamp(fan*1.45-.45*(1.-ax),0.,1.); sp=sp*sp*(3.-2.*sp);
      float ga=clamp(gat*1.7-ax*.7,0.,1.); ga=ga*ga*(3.-2.*ga);     // the inner beads arrive first
      float dx=xn*(X-Wm)*sp, cx=(xn*Wm+dx)*(1.-ga), sk=.44*(1.-smoothstep(0.,.7,sp));
      float bwm=mix(Wm/N+.6*px,bw0,sp), lx=q.x-cx-q.y*sk;
      if(abs(lx)>max(bwm,u_k[5])+2.*px) continue;
      vec2 w=wave(xn,r,f,g)*.95;
      float up=smoothstep(.1,1.,sp), br=mix(bw0,u_k[5],ga);
      float hh=mix(mix(Hm,max(w.y,bw0),up),br,beads), bw=mix(bwm,br,beads), cr=mix(mix(bwm*.5,bw0*.36,sp),br,beads), cy=w.x*up*(1.-beads);
      // While it is still a slice of the slab it has the slab's outline, carried along: the mark's round corners
      // and its level ends, which the slice's own ends stand clear of.
      float mk=1.-smoothstep(0.,.5,sp), dm=0.; vec2 bm=vec2(0);
      hh+=.3*ms*mk*(1.-up);
      vec2 ps=vec2(lx,q.y-cy);
      if(abs(ps.y)>hh+2.*px) continue;
      vec2 b=(abs(ps)-vec2(bw,hh))/cr+1.;
      float d=(length(max(b,0.))+min(max(b.x,b.y),0.)-1.)*cr, af=clamp(.5-d/px,0.,1.);
      if(mk>0.){ dm=slabd(q-vec2(dx,0.),vec2(Wm,Hm),.07*ms,.44,bm); af*=mix(1.,clamp(.5-dm*.92/px,0.,1.),mk); }
      if(af<=0.||(h1.cov>0.&&af<=h2.cov)) continue;
      Hit h; h.cov=af; h.af=af; h.r=r;
      // the slat's face: flat, its shoulders rolled, and turned to catch the light (slats.ts)
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
        // the mark's face: flat with a chamfer round it and a little domed, leaning as the mark leans (mark.ts)
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
    // The ring that asks: the notch's bloom round it, the light behind the shape.
    if(B.z>0.) glow+=bloom(an/6.2832+.62)*B.z*(.5*exp(-abs(e)/(tr*2.2))+.22*exp(-abs(e)/(tr*9.)))*smoothstep(tr*26.,tr*10.,abs(e));
    float cov=clamp(.5+(tr-abs(e))/px,0.,1.);
    if(cov<=0.) continue;
    float en=clamp(e/tr,-1.,1.);
    vec3 n=vec3(p/max(l,1e-4)*en,sqrt(1.-en*en));
    // A done ring: light passes over it once, left to right (head.ts beam, as a result's moment has it).
    xlc=vec3(0);
    if(k==0&&u_k[7]>0.){ float az=clamp((u_k[6]-p.x/max(A.z,.01))*1.4,-1.45,1.45); xl=normalize(vec3(sin(az),.12,cos(az))); xlc=vec3(u_k[7]); }
    fine=smoothstep(.45,.9,3.*px/tr);
    vec3 c=chrome(n,mix(SILVER,vec3(1.,.7,.4),B.z*.85),clamp(3.*px/tr,.03,.45))*B.w;
    // A result not yet seen: the lit edge's colours across the ring (tokens.css --lit), bronze to white to blue.
    float lx=clamp(p.x/max(A.z,.01)*.5+.5,0.,1.);
    c*=mix(vec3(1),mix(mix(vec3(.9,.62,.38),vec3(1.06),smoothstep(0.,.45,lx)),vec3(.52,.64,.98),smoothstep(.5,1.,lx))*1.12,u_rc[k].x);
    // A working ring: its arc is a light that runs round the tube, a bright head and what trails it.
    if(B.y>0.){ float dA=mod(an-B.x,6.2832); c+=B.y*(exp(-dA*1.5)*smoothstep(0.,.3,dA)+smoothstep(5.9,6.2832,dA)*(1.-smoothstep(0.,.3,dA)))*(1.5*n.z*n.z*n.z+.2); }
    col=mix(col,c,cov); a=max(a,cov);
  }
  put(col,a,glow);
}`;

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const mixes = (a, b, t) => a.map((v, i) => mix(v, b[i], t));

// ---- the voice: the task as the story says it, as the numbers the app's forms read of a voice (ui/src/motion/voice.ts)
// "Make the rehearsal timer's digits fit on one line on phones": each syllable when it begins, how loud, how long, and
// how much of it is hiss.
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

// The app's own tables (ui/src/motion/engine.ts SIGNAL and DIM, slats.ts): the light each state signals with, the
// studio's level in it, and the slats' eight parameters, for idle, listening, thinking, working, needs you, done.
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
  // The states' weights, as the app blends its seven: idle, listening, thinking, working, needs you, done.
  const st = [1 - ss(0.5, 0.8, b), ss(0.5, 0.8, b) * (1 - ss(1.5, 1.8, b)), ss(1.5, 1.8, b) * (1 - ss(2.4, 2.8, b)), ss(2.4, 2.8, b) * (1 - ss(3.4, 3.8, b)), ss(3.4, 3.8, b) * (1 - ss(4.4, 4.8, b)), ss(4.4, 4.8, b)];
  const sig = [0, 1, 2].map((c) => st.reduce((s, w, i) => s + w * SIGNAL[i][c], 0));
  const dim = st.reduce((s, w, i) => s + w * DIM[i], 0);
  const listen = ss(0.55, 0.95, b);
  const p = mixes(SLATS[0], SLATS[1], listen);
  // The rings: the task's in the middle, the two that join it beside it.
  const BEAD = 0.08, RW = 0.4, TW = 0.04;
  const open = ss(2.28, 2.8, b), asks = ss(3.4, 3.85, b) * (1 - ss(4.38, 4.72, b)), done = ss(4.45, 4.85, b), away = ss(3.4, 3.85, b) * (1 - ss(4.38, 4.8, b));
  const r0 = { x: 0, y: 0, R: mix(RW * open, 0.48, asks), tube: pieces ? 0 : mix(mix(BEAD, TW, open), 0.04, asks), turn: ss(2.7, 2.9, b) * (1 - ss(3.32, 3.5, b)), asks, level: 1, done, full: mix(RW, 0.48, asks) + mix(TW, 0.04, asks) };
  const side = (at, from, sign, until) => {
    const grow = ss(from, from + 0.34, b);
    return { x: sign * mix(at, at + 0.22, away), y: 0, R: RW * grow * mix(1, 0.72, away), tube: TW * Math.min(1, grow * 3) * mix(1, 0.8, away), turn: ss(from + 0.2, from + 0.4, b) * (1 - ss(until, until + 0.3, b)), asks: 0, level: mix(1, 0.6, away), full: (RW + TW) * mix(1, 0.72, away) };
  };
  const rings = [r0, side(1.2, 2.52, -1, 4.55), side(1.2, 2.66, 1, 9)];
  const turning = !pieces && rings.some((r) => r.tube > 0 && r.turn > 0.01);
  // The box it is all in, in units from the form's centre: the slab, the slats, the rings and the light round them.
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
  // What never changes: the chromatic palette's two lights and its iridescence (palette.ts), a dark backdrop, no
  // words to keep clear, no pulse.
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
  let dpr = 1, lost = false, said = NaN;
  canvas.addEventListener('webglcontextlost', () => ((lost = true), lostNow()));
  const api = {
    get lost() { return lost; },
    frames: 0,
    /** What draws it, as the browser names it (for the checks' reports). */
    renderer: String((info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || 'unnamed'),
    /** The canvas as large as its place, at up to two device pixels a CSS pixel. */
    size(w, h, ratio) {
      dpr = Math.min(2, ratio || 1);
      const W = Math.round(w * dpr), H = Math.round(h * dpr);
      if (canvas.width !== W || canvas.height !== H) (canvas.width = W), (canvas.height = H);
    },
    /** One frame of a pose, `at` seconds on a working ring's clock. The whole canvas is cleared, whatever a browser
     *  left in it from the frames before (some hand back an older frame's buffer), and only the box the forms are in
     *  is drawn. */
    draw(P, at = 0) {
      if (lost) return;
      const W = canvas.width, H = canvas.height;
      const x0 = Math.max(0, Math.floor(P.box.x0 * dpr) - 2), x1 = Math.min(W, Math.ceil(P.box.x1 * dpr) + 2), y0 = Math.max(0, Math.floor(P.box.y0 * dpr) - 2), y1 = Math.min(H, Math.ceil(P.box.y1 * dpr) + 2);
      gl.viewport(0, 0, W, H);
      gl.scissor(0, 0, W, H);
      gl.clear(gl.COLOR_BUFFER_BIT);
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
      // Clockwise on the screen, as the app's arc turns, each a little apart from the next.
      gl.uniform4fv(U.u_rb, P.rings.flatMap((r, i) => [-(at / TURN + i * 0.37) * 2 * Math.PI, r.turn, r.asks, r.level]));
      gl.uniform3fv(U.u_rc, P.rings.flatMap((r) => [r.done || 0, 0, 0]));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      api.frames++;
    },
  };
  return api;
}
