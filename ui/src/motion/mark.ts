// The mark: Tasktap's own piece of the chrome set, alone. A slab, a slash cut level at its ends as a type's slash is,
// and stouter than the set's own slash (glyphs.ts), so that it still reads as itself at 16 pixels: the glyph's metal,
// its chamfer, its extrusion and its studio, unchanged. It is never drawn live: scripts/mark-pictures.cjs draws it once
// (engine.ts `still`) into the pictures the pages, the site and the notification area show. `u_ph.x` says how its face
// leans, which says where the light lies on it; `u_light` the backdrop it is drawn for.
import type { Style } from './styles.ts';

export const mark: Style = {
  id: 'mark',
  n: { hero: 1, icon: 1, box: 1, strip: 1 },
  p: Array.from({ length: 7 }, () => [0, 0, 0, 0, 0, 0, 0, 0]),
  frag: `
float rbox(vec2 p, vec2 b, float r){ vec2 d=abs(p)-b+r; return length(max(d,0.))+min(max(d.x,d.y),0.)-r; }
float slab(vec2 p){ float t=.44; return rbox(vec2(p.x-p.y*t,p.y),vec2(.27,.84),.07)*.92; }
void main(){ VIEW
  q/=.98;                                                                   // the slab fills its picture
  vec2 tl=vec2(.5*sin(u_ph.x),.14+.1*cos(u_ph.x*.7)), pb=q+tl*.14;         // which way the face looks; the back of the extrusion, shallow
  float d=slab(q), s=.98/px, af=clamp(.5-d*s,0.,1.), a=max(af,clamp(.5-slab(pb)*s,0.,1.));
  vec3 col=vec3(0);
  if(a>0.){
    float e=max(.5/s,.004);
    vec2 gr=vec2(slab(q+vec2(e,0))-slab(q-vec2(e,0)),slab(q+vec2(0,e))-slab(q-vec2(0,e)))/(2.*e);
    float bev=smoothstep(.13,0.,-d);                                        // a chamfer round the face
    vec3 nf=vec3(tl+gr*bev*.9+q*.3,1.);                                     // the face a little domed, so the room slides across it
    vec3 cs=chrome(vec3(-tl*3.,.5),SILVER,.25);                             // the side wall: darker, and nearly without colour
    col=mix(mix(vec3(dot(cs,vec3(.3,.5,.2))),cs,.15)*.5,chrome(nf,SILVER,clamp(bev*15./s,.04,.45)),af);
  }
  o=vec4(tone(col)*a,a);
}`,
};
