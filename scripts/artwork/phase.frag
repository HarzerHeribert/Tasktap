// An oscilloscope's phase portrait stretched into a luminous, folded film.
// Analytic curves trace a moving pair of frequencies across the depth of the ribbon.
precision highp float;
uniform vec2 resolution;
uniform float time;
uniform float miniature;
float bell(float x, float w) { return exp(-x*x/(w*w)); }
vec2 profile(float x,float depth) {
    float envelope = max(0.,1.-pow(abs(x/1.035),2.8));
    float phase = 4.55*x + 2.78*depth + .18*sin(time);
    float h = (.29*sin(phase)+.085*cos(8.2*x-2.55*depth-.25*cos(time)))*envelope;
    h += (.36*depth-.18)*envelope-.10*x;
    return vec2(h, phase);
}
void main() {
    vec2 p=(gl_FragCoord.xy/resolution-.5)*vec2(2.22,1.12);
    float x=p.x, y=p.y;
    vec3 color=vec3(.009,.014,.023)+vec3(.018,.023,.046)*bell(x,.76)*bell(y,.38);
    vec3 violet=vec3(.54,.43,.97), aqua=vec3(.29,.85,.81), peach=vec3(.99,.70,.40);
    float edge = (1.-smoothstep(.88,1.05,abs(x)));
    float pixel = 1.12/resolution.y;
    float prev=profile(x,0.).x;
    for(int i=1;i<=61;i++) {
        float d=float(i)/61.;
        vec2 curve=profile(x,d);
        float level=curve.x;
        float slope=profile(x+.002,d).x-level;
        float signedDist=(y-level)/sqrt(1.+pow(slope/.002,2.));
        float spec=pow(.5+.5*cos(5.7*x+5.35*d+cos(time)*.29),9.);
        float rim=pow(abs(2.*d-1.),7.);
        vec3 coating=mix(violet,aqua,.5+.49*sin(2.5*x+3.5*d-.9));
        coating=mix(coating,peach,.72*bell(x+.28+.5*d,.21));
        coating=mix(coating,vec3(.97,.95,.93),spec*.67+rim*.10);
        float folded=1.-smoothstep(.0001,.013,abs(level-prev));
        float interior = 1.-smoothstep(-pixel,pixel,(y-min(level,prev)) * (y-max(level,prev)) / max(.008,abs(level-prev)));
        color=mix(color,coating*(.25+.31*spec+.16*folded),interior*edge*.82);
        float line=bell(signedDist,pixel*(.59+.31*rim+.21*miniature));
        color=mix(color,coating*(.42+.51*spec+.30*rim+.20*folded),line*edge);
        color+=coating * .022 * bell(signedDist,pixel*3.) *edge*(spec+rim);
        prev=level;
    }
    gl_FragColor=vec4(clamp(color,0.,1.),1.);
}
