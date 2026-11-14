// Reflections from studio softboxes against a charcoal cyclorama. The phase sheet and
// machined parts share the same environment, so highlights track their surface normals.
precision highp float;
varying vec3 position;
varying vec3 normal;
varying vec3 alloy;
uniform float time;
float panel(vec3 ray, vec3 aim, float roll, vec2 halfSize, float feather) {
    vec3 n = normalize(aim);
    vec3 east = normalize(cross(vec3(0.,1.,0.),n));
    vec3 north = cross(n,east);
    float facing = dot(ray,n);
    vec2 local = vec2(dot(ray,east),dot(ray,north))/max(.02,facing);
    local = mat2(cos(roll),-sin(roll),sin(roll),cos(roll))*local;
    vec2 border = abs(local)-halfSize;
    return (1.-smoothstep(-feather,feather,max(border.x,border.y)))*step(.02,facing);
}
void main() {
    vec3 view = normalize(vec3(-position.xy,6.8-position.z));
    vec3 n = normalize(gl_FrontFacing?normal:-normal);
    vec3 r = reflect(-view,n);
    // A slow, limited dolly of one overhead strip gives almost-flat faces a legible roll.
    float dolly=.07*sin(time);
    vec3 c = mix(vec3(.075,.085,.095),vec3(.25,.27,.28),smoothstep(-.65,.8,r.y));
    c += vec3(.15,.14,.11)*smoothstep(.24,.98,-r.y);
    c *= 1.-.75*panel(r,vec3(.12,-.08,.98),-.15,vec2(1.8,.20),.047);
    c += vec3(.74,.75,.73)*panel(r,vec3(-.53,.77,.50),.37,vec2(1.50,.30),.072);
    c += vec3(.41,.48,.54)*panel(r,vec3(.71,.28,.60),-.37,vec2(.32,1.20),.095);
    c += vec3(.54,.57,.55)*panel(r,vec3(.37,.28+dolly,1.),.19,vec2(1.28,.14),.032);
    c += vec3(.82,.82,.75)*panel(r,vec3(-.50,.07+dolly,.80),.20,vec2(.94,.043),.014);
    c += vec3(.56,.33,.16)*panel(r,vec3(-.85,-.24,.19),-.70,vec2(.43,.25),.073);
    c += vec3(.19,.33,.42)*panel(r,vec3(.78,-.55,-.16),-.20,vec2(.58,.27),.063);
    c += vec3(.63,.66,.61)*panel(r,vec3(-.40,.12,-.94),.24,vec2(1.90,.27),.062);
    c += vec3(.10,.12,.13)*pow(1.-max(0.,dot(view,n)),3.);
    gl_FragColor=vec4(min(c*alloy,vec3(.99)),1.);
}
