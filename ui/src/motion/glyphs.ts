// Glyphs, from the lab: Chrome type on the waveform: plus, equals, slash and colon stack up where the voice is.
// Columns of type grow with the loudness travelling outward, as the 1.2 dictation strip did. Rising speech leans the glyphs, and a consonant spins them on their axis so the faces flash.
import type { Style } from './styles.ts';

/** The four characters, as distances: plus, equals, slash, colon. */
const SHAPES = `
float glyph(vec2 p, float k){
  vec2 a=abs(p);
  if(k<1.) return min(max(a.x-.66,a.y-.24),max(a.x-.24,a.y-.66));                    // +
  if(k<2.) return max(a.x-.66,abs(a.y-.34)-.19);                                   // =
  if(k<3.){ vec2 s=abs(rot(.5)*p); return max(s.x-.22,s.y-.78); }                  // /
  return max(a.x-.25,abs(a.y-.4)-.25);                                            // :
}`;

export const glyphs: Style = {
  id: 'glyphs',
  n: {hero: 15, icon: 7, box: 5, strip: 11},
  // idle, listening, thinking, working, needs you, done, failed
  p: [
    [0, 0.15, 0.62, 0, 0, 0, 0, 0],
    [1, 0.5, 0.22, 0, 0, 0, 0, 0],
    [0, 1.6, 0.5, 0.45, 0, 0, 0, 1.3],
    [0, 1.2, 0.8, 0, 0, 0, 0, 0.12],
    [0, 0.4, 0.5, 0, 1, 0, 0, 0],
    [0, 0, 0.6, 0, 0, 1, 0, 0],
    [0, 0, 0.4, 0, 0, 0, 1, 0],
  ],
  frag: SHAPES + `
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
}`,
};

/** One of those glyphs alone, filling its picture, as an object in the same studio: \`u_aux\` says which character,
 *  \`u_ph.x\` how its face leans, never far enough to lose its shape. Solid where the metal is, clear around it: a
 *  picture drawn once (engine.ts \`still\`) that the page then moves as it likes. */
export const glyph: Style = {
  id: 'glyph',
  n: {hero: 1, icon: 1, box: 1, strip: 1},
  p: Array.from({length: 7}, () => [0, 0, 0, 0, 0, 0, 0, 0]),
  frag: SHAPES + `
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
}`,
};
