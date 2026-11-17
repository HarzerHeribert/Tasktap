// Resonator, from the lab: The 1.2 resonator in real time: a stack of chrome rings whose sizes are the wave.
// Each ring takes its size from the loudness passing it and from its own band of the spectrum. Consonants roll the rings about the axis, so a twist runs down the stack.
import type { Style } from './styles.ts';

export const resonator: Style = {
  id: 'resonator',
  n: {hero: 21, icon: 15, box: 11, strip: 21},
  // idle, listening, thinking, working, needs you, done, failed
  p: [
    [0, 0.15, 0.62, 0, 0, 0, 0, 0.5],
    [1, 0.5, 0.22, 0, 0, 0, 0, 0.62],
    [0, 2.2, 0.3, 1, 0, 0, 0, 0.75],
    [0, 1.2, 0.8, 0, 0, 0, 0, 0.6],
    [0, 0.4, 0.5, 0, 1, 0, 0, 0.8],
    [0, 0, 0.6, 0, 0, 1, 0, 0.55],
    [0, 0, 0.4, 0, 0, 0, 1, 0.38],
  ],
  frag: `
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
    vec3 N=en*S3+sqrt(1.-en*en)*M; beam(xn);
    col+=(1.-a)*cov*(chrome(N,metal(r),soft)*shade+sheen(N,glow)); a+=(1.-a)*cov;
  }
  put(col/max(a,1e-3),a,glow);
}`,
};
