/* render.js — WebGL2 renderer. No libraries.
 *
 * Draw order, back to front, with depth testing off throughout:
 *   1. sky      full-screen: atmosphere, twilight, Milky Way, light pollution
 *   2. stars    GL_POINTS in J2000, rotated into view by one mat3
 *   3. lines    constellation figures, grids, the core's track
 *   4. bodies   sun, moon (with real phase), planets
 *   5. terrain  the polar mesh, drawn far ring to near ring
 *
 * The terrain mesh is a height field sampled radially from the eye, so drawing
 * it outward-in is exactly correct without a depth buffer. That sidesteps the
 * depth precision problem you would otherwise have with a 2 m near plane and a
 * 160 km far plane.
 */

const V_SKY = `#version 300 es
in vec2 aPos;
out vec2 vNdc;
void main(){ vNdc = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const F_SKY = `#version 300 es
precision highp float;
in vec2 vNdc;
out vec4 fragColor;

uniform vec3 uRight, uUp, uFwd;
uniform vec2 uTan;              // tan(hfov/2), tan(vfov/2)
uniform mat3 uGal;              // render space -> galactic cartesian
uniform vec3 uSunDir, uMoonDir; // render space, unit
uniform float uSunAlt, uMoonAlt, uMoonIllum;
uniform float uMwGain, uLightPol, uExposure;
uniform vec3 uLpColor;

float hash(vec3 p){ p = fract(p*0.3183099+vec3(0.1,0.2,0.3)); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float noise(vec3 x){
  vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),
                 mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
                 mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float fbm(vec3 p){ float a=0.5,s=0.0; for(int i=0;i<5;i++){ s+=a*noise(p); p*=2.03; a*=0.5;} return s; }

// Procedural Milky Way. Positionally exact (driven by galactic coordinates);
// the brightness profile is a model of the real isophotes: a Sagittarius bulge,
// a disk that thins toward the anticentre, the Great Rift, and the Cygnus and
// Scutum star clouds.
float milkyway(vec3 d){
  vec3 g = normalize(uGal * d);
  float b = degrees(asin(clamp(g.z,-1.0,1.0)));
  float l = degrees(atan(g.y, g.x));            // -180..180
  float al = abs(l);
  float bulge = exp(-0.5*(pow(l/15.0,2.0) + pow(b/10.5,2.0)));
  float w = mix(3.4, 7.0, smoothstep(0.0, 180.0, al));
  float disk = exp(-0.5*pow(b/w,2.0)) * (0.30 + 0.70*exp(-al/62.0));
  float cyg  = 0.60*exp(-0.5*(pow((l-80.0)/13.0,2.0)+pow((b-0.5)/4.5,2.0)));
  float sct  = 0.45*exp(-0.5*(pow((l-27.0)/9.0,2.0)+pow((b-0.5)/3.6,2.0)));
  float car  = 0.40*exp(-0.5*(pow((l+72.0)/14.0,2.0)+pow(b/4.0,2.0)));
  float base = 1.25*bulge + disk + cyg + sct + car;
  // Great Rift: dust from Cygnus down through Aquila to Sagittarius
  float rift = 0.66*exp(-0.5*pow((b-1.1)/2.7,2.0))
             * smoothstep(-18.0,6.0,l) * (1.0-smoothstep(40.0,86.0,l));
  // Coalsack / Ophiuchus dark clouds
  float dark = 0.35*exp(-0.5*(pow((l+57.0)/7.0,2.0)+pow((b+1.0)/3.0,2.0)))
             + 0.30*exp(-0.5*(pow((l-1.0)/7.0,2.0)+pow((b-11.0)/5.0,2.0)));
  float mott = 0.62 + 0.75*fbm(g*22.0) - 0.25*fbm(g*7.0);
  return max(0.0, base*(1.0-rift)*(1.0-dark)*mott);
}

vec3 skyColor(vec3 d, float alt){
  float sunAngle = degrees(acos(clamp(dot(d,uSunDir),-1.0,1.0)));
  float h = clamp(alt/90.0, -1.0, 1.0);
  // day / twilight / night blend driven by the true solar altitude
  float day   = smoothstep(-6.0, 4.0, uSunAlt);
  float civil = smoothstep(-13.0, -1.0, uSunAlt);
  float astro = smoothstep(-19.0, -8.0, uSunAlt);

  vec3 night  = mix(vec3(0.016,0.024,0.045), vec3(0.007,0.010,0.022), h);
  vec3 deep   = mix(vec3(0.06,0.11,0.22), vec3(0.015,0.035,0.09), h);
  vec3 blue   = mix(vec3(0.30,0.46,0.72), vec3(0.10,0.24,0.62), h);
  vec3 dayc   = mix(vec3(0.62,0.74,0.92), vec3(0.24,0.44,0.86), h);
  vec3 c = mix(night, deep, astro);
  c = mix(c, blue, civil);
  c = mix(c, dayc, day);

  // warm glow toward the sun while it is near the horizon
  float glow = exp(-sunAngle/26.0) * smoothstep(-14.0, 2.0, uSunAlt) * (1.0 - 0.55*day);
  c += vec3(0.85,0.42,0.14) * glow * 1.25;
  float belt = exp(-pow((alt-3.0)/10.0,2.0)) * exp(-sunAngle/70.0)
             * smoothstep(-10.0,0.0,uSunAlt)*(1.0-day);
  c += vec3(0.35,0.13,0.16)*belt;

  // light pollution: a dome that hugs the horizon
  float lp = uLightPol * exp(-max(alt,0.0)/18.0) * (1.0-day);
  c += uLpColor * lp;
  // airglow
  c += vec3(0.010,0.020,0.014) * exp(-max(alt,0.0)/22.0) * (1.0-civil);

  // moonlight wash
  float moonAngle = degrees(acos(clamp(dot(d,uMoonDir),-1.0,1.0)));
  float moonUp = smoothstep(-4.0, 8.0, uMoonAlt);
  float ml = uMoonIllum * moonUp * (1.0-day);
  c += vec3(0.16,0.19,0.28) * ml * (0.22 + 1.5*exp(-moonAngle/24.0)) * (0.35+0.65*exp(-max(alt,0.0)/40.0));

  // Milky Way, suppressed as the sky brightens
  float mwVis = (1.0-civil) * (1.0 - 0.85*clamp(ml*1.6,0.0,1.0)) * (1.0 - 0.6*clamp(lp*3.0,0.0,1.0));
  float mw = milkyway(d) * uMwGain * mwVis;
  c += vec3(0.62,0.63,0.72) * mw * 0.055 + vec3(0.30,0.26,0.22) * mw*mw * 0.012;

  // extinction toward the horizon
  c *= mix(1.0, 0.72, smoothstep(12.0, -2.0, alt));
  return c;
}

void main(){
  vec3 d = normalize(uFwd + uRight*vNdc.x*uTan.x + uUp*vNdc.y*uTan.y);
  float alt = degrees(asin(clamp(d.y,-1.0,1.0)));
  vec3 c = skyColor(d, alt);
  // below the horizon, fade to a neutral ground tone (terrain draws over it)
  c = mix(c, c*0.25 + vec3(0.02,0.02,0.025), smoothstep(0.0,-6.0,alt));
  c *= uExposure;
  fragColor = vec4(pow(max(c,0.0), vec3(1.0/2.2)), 1.0);
}`;

const V_STAR = `#version 300 es
in vec3 aDir;        // J2000 unit vector
in vec2 aMagBV;      // magnitude, B-V
in vec3 aColor;
out vec3 vColor;
out float vAlpha;
uniform mat3 uSky;   // J2000 -> render
uniform vec3 uRight, uUp, uFwd;
uniform vec2 uTan;
uniform float uPixScale, uSkyBright, uStarGain, uMagLimit;
void main(){
  vec3 d = uSky * aDir;
  float x = dot(d, uRight), y = dot(d, uUp), z = dot(d, uFwd);
  if (z <= 0.02) { gl_Position = vec4(2.0,2.0,2.0,1.0); gl_PointSize = 0.0; vAlpha = 0.0; return; }
  gl_Position = vec4(x/(z*uTan.x), y/(z*uTan.y), 0.0, 1.0);
  float mag = aMagBV.x;
  float alt = degrees(asin(clamp(d.y,-1.0,1.0)));
  // atmospheric extinction: about 0.25 mag at the zenith, rising near the horizon
  float airmass = 1.0/max(0.09, sin(radians(max(alt, 1.5))));
  float m = mag + 0.23*airmass;
  float bright = pow(2.512, (uMagLimit - m)) * uStarGain;
  bright *= smoothstep(-1.5, 2.0, alt);
  bright /= (1.0 + uSkyBright*9.0);
  float size = uPixScale * (0.85 + 1.45*log(1.0+bright));
  gl_PointSize = clamp(size, 0.0, 46.0);
  vAlpha = clamp(bright*0.55, 0.0, 1.0);
  vColor = aColor;
}`;

const F_STAR = `#version 300 es
precision highp float;
in vec3 vColor; in float vAlpha;
out vec4 fragColor;
void main(){
  vec2 p = gl_PointCoord*2.0-1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float core = exp(-r*r*7.0);
  float halo = exp(-r*2.6)*0.22;
  float a = (core+halo)*vAlpha;
  fragColor = vec4(vColor*a, a);
}`;

const V_LINE = `#version 300 es
in vec3 aDir;
uniform mat3 uSky;
uniform vec3 uRight, uUp, uFwd;
uniform vec2 uTan;
out float vClip;
void main(){
  vec3 d = uSky * aDir;
  float z = dot(d, uFwd);
  vClip = z;
  if (z <= 0.02){ gl_Position = vec4(2.0,2.0,2.0,1.0); return; }
  gl_Position = vec4(dot(d,uRight)/(z*uTan.x), dot(d,uUp)/(z*uTan.y), 0.0, 1.0);
}`;

const F_LINE = `#version 300 es
precision highp float;
in float vClip;
uniform vec4 uColor;
out vec4 fragColor;
void main(){ if (vClip <= 0.02) discard; fragColor = vec4(uColor.rgb*uColor.a, uColor.a); }`;

const V_BODY = `#version 300 es
in vec3 aDir; in vec4 aParam;    // radius px, kind, illum, limb angle
in vec3 aColor;
out vec3 vColor; out vec4 vParam;
uniform vec3 uRight, uUp, uFwd;
uniform vec2 uTan;
void main(){
  float z = dot(aDir, uFwd);
  if (z <= 0.02){ gl_Position = vec4(2.0,2.0,2.0,1.0); gl_PointSize=0.0; vParam=vec4(0.0); return; }
  gl_Position = vec4(dot(aDir,uRight)/(z*uTan.x), dot(aDir,uUp)/(z*uTan.y), 0.0, 1.0);
  gl_PointSize = clamp(aParam.x, 2.0, 300.0);
  vColor = aColor; vParam = aParam;
}`;

const F_BODY = `#version 300 es
precision highp float;
in vec3 vColor; in vec4 vParam;
out vec4 fragColor;
void main(){
  vec2 p = gl_PointCoord*2.0-1.0;
  float r = length(p);
  float kind = vParam.y;
  if (kind < 0.5) {                       // sun / planet: disc plus bloom
    if (r > 1.0) discard;
    float disc = smoothstep(0.62, 0.42, r);
    float bloom = exp(-r*r*4.0)*0.5 + exp(-r*3.0)*0.25;
    float a = clamp(disc + bloom, 0.0, 1.0);
    fragColor = vec4(vColor*a, a);
  } else {                                 // moon: real phase
    if (r > 1.0) discard;
    float k = vParam.z, ang = vParam.w;
    float c = cos(ang), s = sin(ang);
    vec2 q = vec2(p.x*c - p.y*s, p.x*s + p.y*c);   // bright limb toward +x
    float edge = 0.66;
    float lit = 1.0;
    if (r <= edge) {
      vec2 u = q/edge;
      float term = (1.0 - 2.0*k) * sqrt(max(0.0, 1.0 - u.y*u.y));
      lit = smoothstep(term-0.035, term+0.035, u.x);
      vec3 surf = mix(vec3(0.10,0.11,0.14), vColor, lit*0.97+0.03);
      float a = smoothstep(edge+0.02, edge-0.02, r);
      float halo = exp(-max(0.0,r-edge)*3.5)*0.30*k;
      fragColor = vec4(surf*a + vColor*halo, clamp(a+halo,0.0,1.0));
    } else {
      float halo = exp(-(r-edge)*4.0)*0.34*k;
      fragColor = vec4(vColor*halo, halo);
    }
  }
}`;

const V_WLINE = `#version 300 es
in vec3 aPos;
uniform mat4 uProj, uView;
void main(){ gl_Position = uProj * uView * vec4(aPos, 1.0); }`;

const F_WLINE = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 fragColor;
void main(){ fragColor = vec4(uColor.rgb*uColor.a, uColor.a); }`;

const V_TERRAIN = `#version 300 es
in vec3 aPos; in vec3 aNrm; in vec2 aGeo; in float aElev;
out vec3 vNrm; out vec3 vPos; out vec2 vGeo; out float vElev; out float vDist;
uniform mat4 uProj; uniform mat4 uView; uniform vec3 uCamPos;
void main(){
  vNrm = aNrm; vPos = aPos; vGeo = aGeo; vElev = aElev;
  vDist = length(aPos - uCamPos);
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

const F_TERRAIN = `#version 300 es
precision highp float;
in vec3 vNrm; in vec3 vPos; in vec2 vGeo; in float vElev; in float vDist;
out vec4 fragColor;
uniform vec3 uSunDir, uMoonDir, uLpColor;
uniform float uSunAlt, uMoonAlt, uMoonIllum, uExposure, uHaze, uBoost, uLightPol;
uniform sampler2D uImgA, uImgB;          // wide drape, sharp inner drape
uniform vec2 uImgAOrigin, uImgBOrigin;   // composite origin, tile units
uniform vec2 uImgAP, uImgBP;             // (tiles across, 2^zoom)
uniform float uUseImgA, uUseImgB;
uniform float uScoutLight;               // artificial relief light for scouting
uniform float uSnowLine, uTreeLine, uBaseElev;

vec4 drape(sampler2D tex, vec2 origin, vec2 p, vec2 geo){
  float tx = (geo.x + 180.0) / 360.0 * p.y;
  float sy = sin(radians(clamp(geo.y, -85.05, 85.05)));
  float ty = (0.5 - log((1.0+sy)/(1.0-sy)) / (4.0*3.14159265)) * p.y;
  vec2 uv = (vec2(tx, ty) - origin) / p.x;
  if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) return vec4(0.0);
  float fade = 1.0 - smoothstep(0.35, 0.495, max(abs(uv.x-0.5), abs(uv.y-0.5)));
  return vec4(texture(tex, uv).rgb, fade);
}

vec3 hypsometric(float h, float slope){
  vec3 low  = vec3(0.16,0.19,0.13);
  vec3 mid  = vec3(0.28,0.26,0.18);
  vec3 high = vec3(0.34,0.31,0.28);
  vec3 rock = vec3(0.30,0.28,0.27);
  vec3 snow = vec3(0.86,0.88,0.92);
  float t1 = smoothstep(0.0, uTreeLine, h);
  float t2 = smoothstep(uTreeLine, uSnowLine, h);
  float t3 = smoothstep(uSnowLine, uSnowLine+420.0, h);
  vec3 c = mix(low, mid, t1);
  c = mix(c, high, t2);
  c = mix(c, snow, t3*(1.0 - smoothstep(0.55,0.85,slope)));
  c = mix(c, rock, smoothstep(0.5,0.85,slope)*0.8);
  return c;
}

void main(){
  vec3 n = normalize(vNrm);
  float slope = 1.0 - clamp(n.y, 0.0, 1.0);
  vec3 albedo = hypsometric(vElev, slope);
  if (uUseImgA > 0.5) { vec4 a = drape(uImgA, uImgAOrigin, uImgAP, vGeo); albedo = mix(albedo, a.rgb*1.05, a.a); }
  if (uUseImgB > 0.5) { vec4 b = drape(uImgB, uImgBOrigin, uImgBP, vGeo); albedo = mix(albedo, b.rgb*1.05, b.a); }

  float sunUp = smoothstep(-6.0, 1.0, uSunAlt);
  vec3 sunCol = mix(vec3(1.0,0.45,0.18), vec3(1.0,0.97,0.92), smoothstep(-1.0, 12.0, uSunAlt));
  float sunLam = max(0.0, dot(n, uSunDir));
  vec3 lit = sunCol * sunLam * sunUp * 1.35;

  float moonUp = smoothstep(-3.0, 6.0, uMoonAlt);
  float moonLam = max(0.0, dot(n, uMoonDir));
  lit += vec3(0.42,0.48,0.66) * moonLam * moonUp * uMoonIllum * 0.30;

  // ambient from the sky dome
  float day = smoothstep(-8.0, 2.0, uSunAlt);
  vec3 ambient = mix(vec3(0.012,0.016,0.030), vec3(0.30,0.36,0.48), day);
  ambient += uLpColor * uLightPol * 0.35 * (1.0-day);
  ambient += vec3(0.05,0.06,0.09) * uMoonIllum * moonUp * 0.5;
  ambient *= (0.45 + 0.55*clamp(n.y,0.0,1.0));

  // scouting light: a fixed north-west key so the landscape reads in the dark.
  // Never used for the eye-level planning view.
  vec3 scoutDir = normalize(vec3(-0.55, 0.62, -0.55));
  float sc = max(0.0, dot(n, scoutDir));
  lit += vec3(1.0, 0.98, 0.94) * (0.25 + 0.85*sc) * uScoutLight;

  vec3 c = albedo * (lit + ambient);
  c += albedo * uBoost * (0.35 + 0.65*clamp(n.y,0.0,1.0));

  // distance haze toward the sky colour near the horizon
  float hz = 1.0 - exp(-vDist / max(2000.0, uHaze));
  vec3 hazeCol = mix(vec3(0.020,0.028,0.050), vec3(0.55,0.66,0.85), day);
  hazeCol += uLpColor * uLightPol * 0.6 * (1.0-day);
  hazeCol += vec3(0.10,0.12,0.17) * uMoonIllum * moonUp;
  c = mix(c, hazeCol, hz*0.92);

  c *= uExposure;
  fragColor = vec4(pow(max(c,0.0), vec3(1.0/2.2)), 1.0);
}`;

/* ---------- helpers ---------- */
function compile(gl, type, src, label) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(`${label} shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}
function program(gl, vs, fs, label) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs, label + ' vert'));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs, label + ' frag'));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(`${label} link: ${gl.getProgramInfoLog(p)}`);
  const u = {}, a = {};
  const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nu; i++) { const n = gl.getActiveUniform(p, i).name.replace('[0]', ''); u[n] = gl.getUniformLocation(p, n); }
  const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) { const n = gl.getActiveAttrib(p, i).name; a[n] = gl.getAttribLocation(p, n); }
  return { p, u, a };
}
function buf(gl, data, target = gl.ARRAY_BUFFER, usage = gl.STATIC_DRAW) {
  const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, usage); return b;
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: true, alpha: false, depth: true, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: true
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl; this.canvas = canvas;
    this.progSky = program(gl, V_SKY, F_SKY, 'sky');
    this.progStar = program(gl, V_STAR, F_STAR, 'star');
    this.progLine = program(gl, V_LINE, F_LINE, 'line');
    this.progBody = program(gl, V_BODY, F_BODY, 'body');
    this.progTer = program(gl, V_TERRAIN, F_TERRAIN, 'terrain');
    this.progWLine = program(gl, V_WLINE, F_WLINE, 'world line');
    this.quad = buf(gl, new Float32Array([-1, -1, 3, -1, -1, 3]));
    this.vaoSky = gl.createVertexArray();
    gl.bindVertexArray(this.vaoSky);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.progSky.a.aPos);
    gl.vertexAttribPointer(this.progSky.a.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.lines = new Map();
    this.worldLines = new Map();
    this.terrain = null; this.stars = null; this.imagery = null; this.imageryB = null;
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
  }

  resize(w, h, dpr) {
    const c = this.canvas;
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    this.gl.viewport(0, 0, W, H);
    this.dpr = dpr; this.w = W; this.h = H;
  }

  /** stars: array of [ra,dec,mag,bv,name]; colorFn(bv)->[r,g,b] */
  setStars(list, colorFn, raDecToVec) {
    const gl = this.gl, n = list.length;
    const dir = new Float32Array(n * 3), mb = new Float32Array(n * 2), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const s = list[i], v = raDecToVec(s[0], s[1]);
      dir[i * 3] = v[0]; dir[i * 3 + 1] = v[1]; dir[i * 3 + 2] = v[2];
      mb[i * 2] = s[2]; mb[i * 2 + 1] = s[3];
      const c = colorFn(s[3]);
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    }
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const P = this.progStar.a;
    const bind = (data, loc, size) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf(gl, data));
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    bind(dir, P.aDir, 3); bind(mb, P.aMagBV, 2); bind(col, P.aColor, 3);
    gl.bindVertexArray(null);
    this.stars = { vao, count: n };
  }

  /** Named line set. space: 'sky' (J2000 unit vectors) or 'local' (render space). */
  setLines(name, dirs, { color = [1, 1, 1, 0.3], space = 'sky', mode = 'LINES' } = {}) {
    const gl = this.gl;
    if (!dirs || !dirs.length) { this.lines.delete(name); return; }
    const arr = dirs instanceof Float32Array ? dirs : new Float32Array(dirs);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf(gl, arr));
    gl.enableVertexAttribArray(this.progLine.a.aDir);
    gl.vertexAttribPointer(this.progLine.a.aDir, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    const old = this.lines.get(name);
    if (old) gl.deleteVertexArray(old.vao);
    this.lines.set(name, { vao, count: arr.length / 3, color, space, mode });
  }
  hasLines(name) { return this.lines.has(name); }
  clearLines(name) { const l = this.lines.get(name); if (l) { this.gl.deleteVertexArray(l.vao); this.lines.delete(name); } }

  setTerrain(mesh) {
    const gl = this.gl;
    if (this.terrain) {
      gl.deleteVertexArray(this.terrain.vao);
      this.terrain.buffers.forEach(b => gl.deleteBuffer(b));
    }
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const P = this.progTer.a, bufs = [];
    const bind = (data, loc, size) => {
      const b = buf(gl, data); bufs.push(b);
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    bind(mesh.pos, P.aPos, 3); bind(mesh.nrm, P.aNrm, 3);
    bind(mesh.geo, P.aGeo, 2); bind(mesh.elev, P.aElev, 1);
    // draw far ring first: reverse the ring order so the painter's algorithm holds
    const NA = mesh.azSteps, NR = mesh.radii.length;
    const Ctor = mesh.nVerts > 65535 ? Uint32Array : Uint16Array;
    const idx = new Ctor((NR - 1) * NA * 6);
    let o = 0;
    for (let i = NR - 2; i >= 0; i--) {
      for (let a = 0; a < NA; a++) {
        const a1 = (a + 1) % NA;
        const v00 = i * NA + a, v01 = i * NA + a1, v10 = (i + 1) * NA + a, v11 = (i + 1) * NA + a1;
        idx[o++] = v00; idx[o++] = v10; idx[o++] = v11;
        idx[o++] = v00; idx[o++] = v11; idx[o++] = v01;
      }
    }
    const ib = buf(gl, idx, gl.ELEMENT_ARRAY_BUFFER); bufs.push(ib);
    gl.bindVertexArray(null);
    this.terrain = {
      vao, buffers: bufs, ib, count: o,
      type: Ctor === Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      mesh
    };
  }

  /** Lines in metres, in render space (x East, y Up, z South) — drawn with the
   *  terrain camera so they sit on the ground rather than at infinity. */
  setWorldLine(name, pts, { color = [1, 1, 1, 0.8], mode = 'LINE_STRIP' } = {}) {
    const gl = this.gl;
    const old = this.worldLines.get(name);
    if (old) { gl.deleteVertexArray(old.vao); gl.deleteBuffer(old.buf); this.worldLines.delete(name); }
    if (!pts || pts.length < 6) return;
    const arr = pts instanceof Float32Array ? pts : new Float32Array(pts);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const b = buf(gl, arr);
    gl.enableVertexAttribArray(this.progWLine.a.aPos);
    gl.vertexAttribPointer(this.progWLine.a.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.worldLines.set(name, { vao, buf: b, count: arr.length / 3, color, mode });
  }

  clearTerrain() {
    const gl = this.gl;
    if (this.terrain) {
      gl.deleteVertexArray(this.terrain.vao);
      this.terrain.buffers.forEach(b => gl.deleteBuffer(b));
      this.terrain = null;
    }
  }

  setImagery(source, slot = 'A') {
    const gl = this.gl;
    const key = slot === 'B' ? 'imageryB' : 'imagery';
    if (this[key]) gl.deleteTexture(this[key].tex);
    if (!source) { this[key] = null; return; }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source.canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT,
      Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    this[key] = { tex, source };
  }

  /** view: {az, alt, roll, vfovDeg} ; sky: uniforms for the sky model. */
  draw(view, sky, bodies) {
    const gl = this.gl;
    const aspect = this.w / this.h;
    const camPos = view.pos || [0, 0, 0];
    const aerial = !!view.aerial;
    const vfov = view.vfovDeg * Math.PI / 180;
    const tanY = Math.tan(vfov / 2), tanX = tanY * aspect;
    // camera basis in render space (x East, y Up, z South)
    const a = view.az * Math.PI / 180, e = view.alt * Math.PI / 180, r = (view.roll || 0) * Math.PI / 180;
    const fwd = [Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)];
    let right = [Math.cos(a), 0, Math.sin(a)];
    let up = [fwd[1] * right[2] - fwd[2] * right[1], fwd[2] * right[0] - fwd[0] * right[2], fwd[0] * right[1] - fwd[1] * right[0]];
    up = [-up[0], -up[1], -up[2]];
    if (r) {
      const cr = Math.cos(r), sr = Math.sin(r);
      const nr = right.map((v, i) => v * cr + up[i] * sr);
      const nu = up.map((v, i) => v * cr - right[i] * sr);
      right = nr; up = nu;
    }
    this.view = { fwd, right, up, tanX, tanY, pos: camPos };

    gl.clearColor(0, 0, 0, 1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);

    /* 1. sky */
    const S = this.progSky;
    gl.useProgram(S.p);
    gl.disable(gl.BLEND);
    gl.uniform3fv(S.u.uRight, right); gl.uniform3fv(S.u.uUp, up); gl.uniform3fv(S.u.uFwd, fwd);
    gl.uniform2f(S.u.uTan, tanX, tanY);
    gl.uniformMatrix3fv(S.u.uGal, false, sky.galMatrix);
    gl.uniform3fv(S.u.uSunDir, sky.sunDir); gl.uniform3fv(S.u.uMoonDir, sky.moonDir);
    gl.uniform1f(S.u.uSunAlt, sky.sunAlt); gl.uniform1f(S.u.uMoonAlt, sky.moonAlt);
    gl.uniform1f(S.u.uMoonIllum, sky.moonIllum);
    gl.uniform1f(S.u.uMwGain, sky.mwGain); gl.uniform1f(S.u.uLightPol, sky.lightPol);
    gl.uniform1f(S.u.uExposure, sky.exposure);
    gl.uniform3fv(S.u.uLpColor, sky.lpColor);
    gl.bindVertexArray(this.vaoSky);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    /* 2. stars */
    if (this.stars && sky.showStars) {
      const P = this.progStar;
      gl.useProgram(P.p);
      gl.uniformMatrix3fv(P.u.uSky, false, sky.skyMatrix);
      gl.uniform3fv(P.u.uRight, right); gl.uniform3fv(P.u.uUp, up); gl.uniform3fv(P.u.uFwd, fwd);
      gl.uniform2f(P.u.uTan, tanX, tanY);
      gl.uniform1f(P.u.uPixScale, this.dpr * Math.max(0.55, 34 / view.vfovDeg));
      gl.uniform1f(P.u.uSkyBright, sky.skyBright);
      gl.uniform1f(P.u.uStarGain, sky.starGain);
      gl.uniform1f(P.u.uMagLimit, sky.magLimit);
      gl.bindVertexArray(this.stars.vao);
      gl.drawArrays(gl.POINTS, 0, this.stars.count);
    }

    /* 3. lines */
    const L = this.progLine;
    gl.useProgram(L.p);
    gl.uniform3fv(L.u.uRight, right); gl.uniform3fv(L.u.uUp, up); gl.uniform3fv(L.u.uFwd, fwd);
    gl.uniform2f(L.u.uTan, tanX, tanY);
    const ident = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    for (const [name, ln] of this.lines) {
      if (sky.hiddenLines && sky.hiddenLines.has(name)) continue;
      gl.uniformMatrix3fv(L.u.uSky, false, ln.space === 'sky' ? sky.skyMatrix : ident);
      gl.uniform4fv(L.u.uColor, ln.color);
      gl.bindVertexArray(ln.vao);
      gl.drawArrays(gl[ln.mode], 0, ln.count);
    }

    /* 4. bodies */
    if (bodies && bodies.length) {
      const B = this.progBody;
      gl.useProgram(B.p);
      gl.uniform3fv(B.u.uRight, right); gl.uniform3fv(B.u.uUp, up); gl.uniform3fv(B.u.uFwd, fwd);
      gl.uniform2f(B.u.uTan, tanX, tanY);
      const n = bodies.length;
      const dir = new Float32Array(n * 3), par = new Float32Array(n * 4), col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const b = bodies[i];
        dir.set(b.dir, i * 3);
        const pxPerDeg = this.h / view.vfovDeg;
        par[i * 4] = Math.max(b.minPx || 3, b.angularRadius * 2 * pxPerDeg * (b.spriteScale || 1.6));
        par[i * 4 + 1] = b.kind === 'moon' ? 1 : 0;
        par[i * 4 + 2] = b.illum === undefined ? 1 : b.illum;
        par[i * 4 + 3] = b.limbAngle || 0;
        col.set(b.color, i * 3);
      }
      if (!this.bodyVao) {
        this.bodyVao = gl.createVertexArray();
        gl.bindVertexArray(this.bodyVao);
        this.bDir = buf(gl, dir, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(B.a.aDir); gl.vertexAttribPointer(B.a.aDir, 3, gl.FLOAT, false, 0, 0);
        this.bPar = buf(gl, par, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(B.a.aParam); gl.vertexAttribPointer(B.a.aParam, 4, gl.FLOAT, false, 0, 0);
        this.bCol = buf(gl, col, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(B.a.aColor); gl.vertexAttribPointer(B.a.aColor, 3, gl.FLOAT, false, 0, 0);
      } else {
        gl.bindVertexArray(this.bodyVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bDir); gl.bufferData(gl.ARRAY_BUFFER, dir, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bPar); gl.bufferData(gl.ARRAY_BUFFER, par, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bCol); gl.bufferData(gl.ARRAY_BUFFER, col, gl.DYNAMIC_DRAW);
      }
      gl.drawArrays(gl.POINTS, 0, n);
    }

    /* 5. terrain */
    if (this.terrain && sky.showTerrain !== false) {
      const T = this.progTer;
      gl.useProgram(T.p);
      gl.disable(gl.BLEND);
      // From the eye, the polar mesh sorts correctly outward-in, so no depth
      // buffer is needed and the near plane can sit at 2 m. From the air the
      // painter's order no longer holds, so depth testing goes on and the near
      // plane moves out to keep precision.
      const near = aerial ? Math.max(20, view.camHeight * 0.05) : 2.0;
      const proj = perspective(vfov, aspect, near, 500000);
      const viewM = lookAt(camPos, fwd, up);
      if (aerial) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); }
      gl.uniformMatrix4fv(T.u.uProj, false, proj);
      gl.uniformMatrix4fv(T.u.uView, false, viewM);
      gl.uniform3fv(T.u.uCamPos, camPos);
      gl.uniform1f(T.u.uScoutLight, sky.scoutLight || 0);
      this._proj = proj; this._viewM = viewM;
      gl.uniform3fv(T.u.uSunDir, sky.sunDir); gl.uniform3fv(T.u.uMoonDir, sky.moonDir);
      gl.uniform1f(T.u.uSunAlt, sky.sunAlt); gl.uniform1f(T.u.uMoonAlt, sky.moonAlt);
      gl.uniform1f(T.u.uMoonIllum, sky.moonIllum);
      gl.uniform1f(T.u.uExposure, sky.exposure);
      gl.uniform1f(T.u.uHaze, sky.haze);
      gl.uniform1f(T.u.uBoost, sky.foregroundBoost);
      gl.uniform1f(T.u.uLightPol, sky.lightPol);
      gl.uniform3fv(T.u.uLpColor, sky.lpColor);
      gl.uniform1f(T.u.uSnowLine, sky.snowLine);
      gl.uniform1f(T.u.uTreeLine, sky.treeLine);
      gl.uniform1f(T.u.uBaseElev, this.terrain.mesh.baseElev);
      const drape = (img, unit, uTex, uOrigin, uP, uUse) => {
        if (img && sky.useImagery) {
          const s = img.source;
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, img.tex);
          gl.uniform1i(T.u[uTex], unit);
          gl.uniform1f(T.u[uUse], 1);
          gl.uniform2f(T.u[uOrigin], s.x0, s.y0);
          gl.uniform2f(T.u[uP], s.n, 1 << s.z);
        } else gl.uniform1f(T.u[uUse], 0);
      };
      drape(this.imagery, 0, 'uImgA', 'uImgAOrigin', 'uImgAP', 'uUseImgA');
      drape(this.imageryB, 1, 'uImgB', 'uImgBOrigin', 'uImgBP', 'uUseImgB');
      gl.bindVertexArray(this.terrain.vao);
      gl.drawElements(gl.TRIANGLES, this.terrain.count, this.terrain.type, 0);

      /* 6. ground bearings, drawn with the same camera */
      if (this.worldLines.size) {
        const WL = this.progWLine;
        gl.useProgram(WL.p);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniformMatrix4fv(WL.u.uProj, false, proj);
        gl.uniformMatrix4fv(WL.u.uView, false, viewM);
        gl.depthMask(false);
        for (const [name, l] of this.worldLines) {
          if (sky.hiddenLines && sky.hiddenLines.has(name)) continue;
          gl.uniform4fv(WL.u.uColor, l.color);
          gl.bindVertexArray(l.vao);
          gl.drawArrays(gl[l.mode], 0, l.count);
        }
      }
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    gl.bindVertexArray(null);
  }

  /** Project a render-space point (metres) to CSS pixels, or null if behind. */
  projectPoint(p) {
    const v = this.view; if (!v) return null;
    const c = v.pos || [0, 0, 0];
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    const L = Math.hypot(d[0], d[1], d[2]) || 1;
    return this.project([d[0] / L, d[1] / L, d[2] / L]);
  }

  /** Project a render-space unit vector to CSS pixel coordinates, or null. */
  project(dir) {
    const v = this.view; if (!v) return null;
    const z = dir[0] * v.fwd[0] + dir[1] * v.fwd[1] + dir[2] * v.fwd[2];
    if (z <= 0.02) return null;
    const x = dir[0] * v.right[0] + dir[1] * v.right[1] + dir[2] * v.right[2];
    const y = dir[0] * v.up[0] + dir[1] * v.up[1] + dir[2] * v.up[2];
    const ndcX = x / (z * v.tanX), ndcY = y / (z * v.tanY);
    return [(ndcX * 0.5 + 0.5) * this.w / this.dpr, (0.5 - ndcY * 0.5) * this.h / this.dpr, z];
  }
}

export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0
  ]);
}
export function lookAt(eye, fwd, up) {
  const f = norm(fwd), s = norm(cross(f, up)), u = cross(s, f);
  return new Float32Array([
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -dot(s, eye), -dot(u, eye), dot(f, eye), 1
  ]);
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
