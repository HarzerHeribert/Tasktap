// Slats, from the lab: The icon, alive: polished slats that rise with the voice and turn to catch the light.
// Loudness leaves the centre and travels outward as height. Vowels swell the whole wave. Each consonant sends a turn through the slats, so the reflections flick.
import type { Style } from './styles.ts';

export const slats: Style = {
  id: 'slats',
  n: {hero: 21, icon: 21, box: 13, strip: 27},
  // idle, listening, thinking, working, needs you, done, failed
  p: [
    [0, 0.15, 0.62, 0, 0, 0, 0, 0],
    [1, 0.5, 0.22, 0, 0, 0, 0, 0.1],
    [0, 2.2, 0.3, 1, 0, 0, 0, 0.5],
    [0, 1.2, 0.8, 0, 0, 0, 0, 0.2],
    [0, 0.4, 0.5, 0, 1, 0, 0, 0],
    [0, 0, 0.6, 0, 0, 1, 0, 0],
    [0, 0, 0.4, 0, 0, 0, 1, 0],
  ],
  frag: `
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
}`,
};
