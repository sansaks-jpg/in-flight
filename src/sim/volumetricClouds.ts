// Volumetric (fly-through) clouds.
//
// Pipeline (one extra render target pair, replaces the old billboard sprites):
//   1. the world scene is drawn into a multisampled colour + DEPTH render target,
//   2. a full-screen pass ray-marches the cloud slabs planned from LIVE weather (cloudLayers.ts). Every ray stops at the depth
//      of whatever the scene drew (terrain, aircraft, runway…), so mountains pierce decks and the aircraft can sit inside a cloud,
//   3. the result (premultiplied scattered light + transmittance) is composited over the scene and written to the canvas.
// The camera may be anywhere: below, inside or above a layer. Inside, the ray simply starts at t = 0 and the cloud's extinction
// whites the view out, exactly like flying IMC. Lighting: sun transmittance (4 taps toward the sun), a Henyey-Greenstein
// dual-lobe phase (silver lining), cheap multiple-scattering, sky ambient with dark bases, and the scene's own FogExp2 so
// distant cloud melts into the same haze colour as the terrain and sky.
import * as THREE from 'three';
import { QualityPreset } from './storage';
import { CloudLayer, CloudWxIn, planCloudLayers, stepBudget } from './cloudLayers';

const NOISE_N = 64;

// ---------- procedural, tileable 3-D noise (generated once, ≈0.2 s) ----------
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1013904223) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
const wrap = (i: number, f: number) => ((i % f) + f) % f;
/** Periodic value noise with `f` lattice cells per unit. */
function vnoise(u: number, v: number, w: number, f: number, seed: number): number {
  const x = u * f, y = v * f, z = w * f, xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const g = (dx: number, dy: number, dz: number) => hash3(wrap(xi + dx, f), wrap(yi + dy, f), wrap(zi + dz, f), seed);
  const a = g(0, 0, 0) + (g(1, 0, 0) - g(0, 0, 0)) * sx, b = g(0, 1, 0) + (g(1, 1, 0) - g(0, 1, 0)) * sx;
  const c = g(0, 0, 1) + (g(1, 0, 1) - g(0, 0, 1)) * sx, d = g(0, 1, 1) + (g(1, 1, 1) - g(0, 1, 1)) * sx;
  const e = a + (b - a) * sy, h = c + (d - c) * sy;
  return e + (h - e) * sz;
}
/** Periodic Worley: 1 - nearest feature distance (bright blob centres => billows). */
function worley(u: number, v: number, w: number, f: number, seed: number): number {
  const x = u * f, y = v * f, z = w * f, xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let best = 9;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = xi + dx, cy = yi + dy, cz = zi + dz;
    const wx = wrap(cx, f), wy = wrap(cy, f), wz = wrap(cz, f);
    const px = cx + hash3(wx, wy, wz, seed), py = cy + hash3(wx, wy, wz, seed + 11), pz = cz + hash3(wx, wy, wz, seed + 23);
    const d = (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
    if (d < best) best = d;
  }
  return Math.max(0, 1 - Math.sqrt(best) * 1.05);
}
export function makeCloudNoise(): THREE.Data3DTexture {
  const N = NOISE_N, data = new Uint8Array(N * N * N * 4);
  let k = 0;
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, w = z / N;
    const fb = vnoise(u, v, w, 3, 1) * 0.55 + vnoise(u, v, w, 6, 2) * 0.3 + vnoise(u, v, w, 12, 3) * 0.15;
    const wl = worley(u, v, w, 6, 5);
    // Perlin-Worley style base shape, stretched so its distribution fills 0..1
    const r = Math.min(1, Math.max(0, ((fb * 0.6 + wl * 0.4) - 0.28) / 0.5));
    data[k++] = r * 255;
    data[k++] = worley(u, v, w, 4, 7) * 255;
    data[k++] = worley(u, v, w, 8, 9) * 255;
    data[k++] = worley(u, v, w, 16, 13) * 255;
  }
  const t = new THREE.Data3DTexture(data, N, N, N);
  t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.unpackAlignment = 1; t.needsUpdate = true;
  return t;
}

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const CLOUD_FRAG = `
precision highp float; precision highp sampler3D;
#include <packing>
uniform sampler2D tDepth; uniform sampler3D uNoise;
uniform mat4 uProjInv; uniform mat4 uCamWorld; uniform vec3 uCamPos; uniform vec2 uNearFar;
uniform vec4 uBase; uniform vec4 uTop; uniform vec4 uCover; uniform vec4 uKind; uniform vec4 uDens; uniform vec4 uSteps;
uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uAmbTop; uniform vec3 uAmbBot;
uniform vec3 uFogCol; uniform float uFogRho; uniform vec3 uDrift; uniform float uStorm; uniform float uFlash; uniform float uMaxDist;
varying vec2 vUv;

const vec4 EXT = vec4(0.030, 0.018, 0.0045, 0.040);   // extinction (1/m) at density 1 per layer kind
float remap(float v, float lo, float hi){ return clamp((v - lo) / max(hi - lo, 1e-4), 0.0, 1.0); }

float cloudDensity(vec3 p, float h, float cover, float kind, float dens){
  vec3 q = p + uDrift;
  float wm; float cov; float grad; float scaleS; float scaleD;
  if (kind > 2.5) {                       // cumulonimbus: big cells, anvil spreading near the top
    wm = texture(uNoise, vec3(q.xz / 16000.0, 0.17)).r * 0.65 + texture(uNoise, vec3(q.xz / 6000.0 + 0.3, 0.55)).r * 0.35;
    wm = clamp((wm - 0.5) * 2.1 + 0.5, 0.0, 1.0);
    float lo = (1.0 - cover) - 0.32 * smoothstep(0.55, 0.95, h);
    cov = smoothstep(lo, lo + 0.2, wm);
    grad = smoothstep(0.0, 0.04, h) * (1.0 - smoothstep(0.86, 1.0, h)) * (0.55 + 0.45 * cov);
    scaleS = 7000.0; scaleD = 1700.0;
  } else {
    wm = texture(uNoise, vec3(q.xz / 30000.0, 0.37)).r * 0.6 + texture(uNoise, vec3(q.xz / 11000.0 + 0.31, 0.71)).r * 0.4;
    wm = clamp((wm - 0.5) * 2.2 + 0.5, 0.0, 1.0);
    float lo = 1.0 - cover * 1.25;
    cov = smoothstep(lo, lo + 0.22, wm);
    if (kind < 0.5) {                      // low deck: cumulus (rounded tops, flat bases) -> stratus
      float s = smoothstep(0.72, 0.97, cover);
      float gcu = smoothstep(0.0, 0.06, h) * (1.0 - smoothstep(0.5, 1.0, h / max(0.4, cov)));
      float gst = smoothstep(0.0, 0.1, h) * (1.0 - smoothstep(0.62, 1.0, h));
      grad = mix(gcu, gst, s); cov = mix(cov, 1.0, s * 0.8);
      scaleS = 4200.0; scaleD = 950.0;
    } else if (kind < 1.5) {               // mid: altocumulus / altostratus
      grad = smoothstep(0.0, 0.2, h) * (1.0 - smoothstep(0.45, 1.0, h));
      scaleS = 5600.0; scaleD = 1500.0;
    } else {                               // cirrus: thin, ice, stretched along the wind
      grad = smoothstep(0.0, 0.3, h) * (1.0 - smoothstep(0.35, 1.0, h));
      q.x *= 0.35; scaleS = 9000.0; scaleD = 2600.0;
    }
  }
  if (grad * cov < 0.012) return 0.0;
  vec4 sh = texture(uNoise, q / scaleS);
  vec4 dt = texture(uNoise, q / scaleD + 0.5);
  float er = dt.g * 0.5 + dt.b * 0.3 + dt.a * 0.2;
  float d0 = cov * grad * (0.55 + 0.75 * sh.r);
  float d = remap(d0, (1.0 - er) * (kind > 1.5 && kind < 2.5 ? 0.7 : 0.5), 1.0);
  return d * dens;
}

float hgPhase(float c, float g){ float g2 = g * g; return (1.0 - g2) / (12.566371 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }

void march(int li, float ta, float tb, float jit, vec3 rd, inout vec3 col, inout float T){
  float base = uBase[li], top = uTop[li], thick = top - base, cover = uCover[li], kind = uKind[li], dens = uDens[li];
  float ext = EXT[li] ;
  float minStep = thick / (kind > 2.5 ? 22.0 : 14.0);
  float cosT = dot(rd, uSunDir);
  float ph = min(4.0, 12.566371 * (mix(hgPhase(cosT, -0.18), hgPhase(cosT, 0.62), 0.55)) * 0.95);
  float ls = clamp(thick * 0.05, 70.0, 450.0);
  int N = int(uSteps[li]);
  float t = ta + jit * minStep;
  for (int i = 0; i < 72; i++) {
    if (i >= N || t >= tb || T < 0.03) break;
    vec3 p = uCamPos + rd * t;
    float h = clamp((p.y - base) / thick, 0.0, 1.0);
    float d = cloudDensity(p, h, cover, kind, dens);
    float dt = max(minStep, 0.055 * (t - ta + 350.0));
    if (d > 0.004) {
      float sigma = d * ext;
      float tau = 0.0; vec3 lp = p;
      for (int k = 0; k < 4; k++) {
        float sl = ls * (1.0 + float(k) * 1.1);
        lp += uSunDir * sl;
        if (lp.y > top) break;
        float lh = clamp((lp.y - base) / thick, 0.0, 1.0);
        tau += cloudDensity(lp, lh, cover, kind, dens) * ext * sl;
      }
      float Ls = exp(-tau), Lms = exp(-tau * 0.22);
      float powder = 1.0 - 0.55 * exp(-sigma * dt * 3.0);
      vec3 amb = mix(uAmbBot, uAmbTop, smoothstep(0.0, 0.9, h));
      vec3 S = uSunCol * (Ls * ph * powder + Lms * 0.30) + amb;
      S *= 1.0 - uStorm * (0.62 - 0.35 * h);
      S += vec3(0.75, 0.8, 1.0) * uFlash * (0.4 + 0.6 * Lms);
      float fogF = 1.0 - exp(-uFogRho * uFogRho * t * t);
      float vis = 1.0 - fogF;
      float a = exp(-sigma * dt);
      col += T * S * (1.0 - a) * vis;
      T *= mix(1.0, a, vis);
    }
    t += dt;
  }
}

void main(){
  vec4 v = uProjInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 vd = v.xyz / v.w; vd /= -vd.z;
  vec3 rd = normalize((uCamWorld * vec4(vd, 0.0)).xyz);
  float dRaw = texture2D(tDepth, vUv).x;
  float tScene = 1e9;
  if (dRaw < 0.999999) tScene = -perspectiveDepthToViewZ(dRaw, uNearFar.x, uNearFar.y) * length(vd);
  float tMax = min(tScene, uMaxDist);
  float t0[4]; float t1[4];
  for (int i = 0; i < 4; i++) {
    float ta = 1e9, tb = 0.0;
    if (uCover[i] >= 0.03) {
      float b = uBase[i], tp = uTop[i];
      if (abs(rd.y) < 1e-4) { if (uCamPos.y >= b && uCamPos.y <= tp) { ta = 0.0; tb = tMax; } }
      else { float s1 = (b - uCamPos.y) / rd.y, s2 = (tp - uCamPos.y) / rd.y; ta = max(min(s1, s2), 0.0); tb = min(max(s1, s2), tMax); }
      if (tb <= ta) { ta = 1e9; tb = 0.0; }
    }
    t0[i] = ta; t1[i] = tb;
  }
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec3 col = vec3(0.0); float T = 1.0; vec4 used = vec4(0.0);
  for (int k = 0; k < 4; k++) {            // nearest slab first
    int bi = -1; float bt = 1e9;
    for (int i = 0; i < 4; i++) if (used[i] < 0.5 && t1[i] > t0[i] && t0[i] < bt) { bt = t0[i]; bi = i; }
    if (bi < 0) break;
    used[bi] = 1.0;
    march(bi, t0[bi], t1[bi], jit, rd, col, T);
    if (T < 0.03) break;
  }
  gl_FragColor = vec4(col, T);
}`;

const COMP_FRAG = `
uniform sampler2D tScene; uniform sampler2D tCloud; varying vec2 vUv;
void main(){
  vec4 s = texture2D(tScene, vUv); vec4 c = texture2D(tCloud, vUv);
  gl_FragColor = vec4(s.rgb * c.a + c.rgb, 1.0);
  #include <colorspace_fragment>
}`;

const SCALE: Record<QualityPreset, number> = { low: 0.5, medium: 0.6, high: 0.8, ultra: 1 };
const _size = new THREE.Vector2();

export interface CloudEnv { sunDir: THREE.Vector3; sunCol: THREE.Color; ambTop: THREE.Color; ambBot: THREE.Color; flash: number; storm: number }

export class VolumetricClouds {
  readonly layers: CloudLayer[] = [];
  private steps: number[] = [0, 0, 0, 0];
  private stepTotal = 24;
  private quality: QualityPreset;
  private noise: THREE.Data3DTexture | null = null;
  private sceneRT: THREE.WebGLRenderTarget | null = null;
  private cloudRT: THREE.WebGLRenderTarget | null = null;
  private halfFloat = true;
  private orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private cloudScene = new THREE.Scene();
  private compScene = new THREE.Scene();
  private cloudMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private clearTex: THREE.DataTexture;
  private drift = new THREE.Vector3();
  private lastTime = -1;
  private camPos = new THREE.Vector3();
  active = false;

  constructor(quality: QualityPreset, stepBudgetTotal: number) {
    this.quality = quality; this.stepTotal = stepBudgetTotal;
    this.clearTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); this.clearTex.needsUpdate = true;
    const plane = new THREE.PlaneGeometry(2, 2);
    this.cloudMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: CLOUD_FRAG, depthTest: false, depthWrite: false, transparent: false,
      uniforms: {
        tDepth: { value: null }, uNoise: { value: null }, uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
        uCamPos: { value: this.camPos }, uNearFar: { value: new THREE.Vector2(2, 220000) },
        uBase: { value: new THREE.Vector4() }, uTop: { value: new THREE.Vector4() }, uCover: { value: new THREE.Vector4() },
        uKind: { value: new THREE.Vector4() }, uDens: { value: new THREE.Vector4(1, 1, 1, 1) }, uSteps: { value: new THREE.Vector4() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(1, 1, 1) },
        uAmbTop: { value: new THREE.Color(0.4, 0.5, 0.7) }, uAmbBot: { value: new THREE.Color(0.2, 0.2, 0.2) },
        uFogCol: { value: new THREE.Color(1, 1, 1) }, uFogRho: { value: 0.00003 }, uDrift: { value: this.drift },
        uStorm: { value: 0 }, uFlash: { value: 0 }, uMaxDist: { value: 90000 },
      },
    });
    const m1 = new THREE.Mesh(plane, this.cloudMat); m1.frustumCulled = false; this.cloudScene.add(m1);
    this.compMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: COMP_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tScene: { value: null }, tCloud: { value: this.clearTex } },
    });
    const m2 = new THREE.Mesh(plane, this.compMat); m2.frustumCulled = false; this.compScene.add(m2);
  }

  setQuality(q: QualityPreset, stepBudgetTotal: number) {
    this.quality = q; this.stepTotal = stepBudgetTotal;
    this.cloudRT?.dispose(); this.cloudRT = null; this.sceneRT?.dispose(); this.sceneRT = null; // re-created at the new resolution scale / MSAA
    stepBudget(this.stepTotal, this.layers.length === 4 ? this.layers : planCloudLayers(this.lastIn ?? EMPTY_IN, this.layers), this.steps);
  }

  /**
   * Loading-screen warm-up of the whole cloud pipeline, also for a clear sky: builds the CPU-generated 3D noise volume (otherwise made the
   * moment live weather first brings a layer – a mid-flight stall), uploads it and runs the real scene -> ray-march -> composite path once
   * so every program variant and render target exists before the first playable frame.
   */
  warm(r: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, env: CloudEnv) {
    if (!this.noise) this.noise = makeCloudNoise();
    r.initTexture(this.noise);
    const was = this.active;
    this.active = this.layers.length === 4; // a clear sky has no layers to march: still run the shader once
    try { this.render(r, scene, camera, env); } finally { this.active = was; }
    if (!was) this.releaseTargets(); // clear sky: keep the compiled programs, drop the (large) render targets until clouds appear
  }
  /** Frees the full-resolution render targets (used after the loading warm-up when the sky turned out to be clear: the compiled programs stay). */
  releaseTargets() { this.cloudRT?.dispose(); this.cloudRT = null; this.sceneRT?.dispose(); this.sceneRT = null; }

  private lastIn: CloudWxIn | null = null;
  /** Push the live weather; re-plans the slabs (cheap). */
  setWeather(w: CloudWxIn) {
    this.lastIn = w;
    planCloudLayers(w, this.layers);
    stepBudget(this.stepTotal, this.layers, this.steps);
    this.active = this.layers.some((l) => l.cover >= 0.03);
    if (this.active && !this.noise) this.noise = makeCloudNoise();
  }

  /** The world origin moved (floating-origin rebase): keep the cloud pattern anchored to the real ground. */
  shift(dx: number, dz: number) { this.drift.x -= dx; this.drift.z -= dz; }

  /** Per-frame: integrate wind drift on the sim clock (frozen while paused). */
  update(time: number, windX: number, windZ: number) {
    let dt = time - this.lastTime; this.lastTime = time;
    if (!(dt > 0) || dt > 2) dt = 0;
    this.drift.x += windX * dt; this.drift.z += windZ * dt;
  }

  private ensureTargets(r: THREE.WebGLRenderer) {
    r.getDrawingBufferSize(_size);
    const w = Math.max(2, Math.floor(_size.x)), h = Math.max(2, Math.floor(_size.y));
    const ext = r.extensions;
    this.halfFloat = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    if (!this.sceneRT) {
      const depth = new THREE.DepthTexture(w, h);
      this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
        type: this.halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType, depthTexture: depth, depthBuffer: true,
        samples: Math.min(this.quality === 'low' ? 2 : 4, r.capabilities.maxSamples), minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      });
      this.sceneRT.texture.colorSpace = this.halfFloat ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
    }
    if (this.sceneRT.width !== w || this.sceneRT.height !== h) this.sceneRT.setSize(w, h);
    const cw = Math.max(2, Math.floor(w * SCALE[this.quality])), ch = Math.max(2, Math.floor(h * SCALE[this.quality]));
    if (!this.cloudRT) {
      this.cloudRT = new THREE.WebGLRenderTarget(cw, ch, { type: this.halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      this.cloudRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    }
    if (this.cloudRT.width !== cw || this.cloudRT.height !== ch) this.cloudRT.setSize(cw, ch);
  }

  /** Draws `scene` through the cloud pipeline into the canvas (the caller draws the cockpit afterwards). */
  render(r: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, env: CloudEnv) {
    this.ensureTargets(r);
    const srt = this.sceneRT!, crt = this.cloudRT!;
    r.setRenderTarget(srt); r.clear(); r.render(scene, camera);
    let cloudTex: THREE.Texture = this.clearTex;
    if (this.active && this.noise) {
      camera.updateMatrixWorld();
      this.camPos.setFromMatrixPosition(camera.matrixWorld);
      const u = this.cloudMat.uniforms, L = this.layers, S = this.steps;
      u.tDepth.value = srt.depthTexture; u.uNoise.value = this.noise;
      (u.uProjInv.value as THREE.Matrix4).copy(camera.projectionMatrixInverse); (u.uCamWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
      (u.uNearFar.value as THREE.Vector2).set(camera.near, camera.far);
      (u.uBase.value as THREE.Vector4).set(L[0].base, L[1].base, L[2].base, L[3].base);
      (u.uTop.value as THREE.Vector4).set(L[0].top, L[1].top, L[2].top, L[3].top);
      (u.uCover.value as THREE.Vector4).set(L[0].cover, L[1].cover, L[2].cover, L[3].cover);
      (u.uKind.value as THREE.Vector4).set(L[0].kind, L[1].kind, L[2].kind, L[3].kind);
      (u.uDens.value as THREE.Vector4).set(L[0].density, L[1].density, L[2].density, L[3].density);
      (u.uSteps.value as THREE.Vector4).set(S[0], S[1], S[2], S[3]);
      (u.uSunDir.value as THREE.Vector3).copy(env.sunDir); (u.uSunCol.value as THREE.Color).copy(env.sunCol);
      (u.uAmbTop.value as THREE.Color).copy(env.ambTop); (u.uAmbBot.value as THREE.Color).copy(env.ambBot);
      u.uStorm.value = env.storm; u.uFlash.value = env.flash;
      const f = scene.fog as THREE.FogExp2 | null;
      if (f && f.isFogExp2) { (u.uFogCol.value as THREE.Color).copy(f.color); u.uFogRho.value = f.density; u.uMaxDist.value = Math.max(8000, Math.min(110000, 2.2 / Math.max(1e-7, f.density))); }
      r.setRenderTarget(crt); r.render(this.cloudScene, this.orthoCam);
      cloudTex = crt.texture;
    }
    this.compMat.uniforms.tScene.value = srt.texture; this.compMat.uniforms.tCloud.value = cloudTex;
    r.setRenderTarget(null); r.render(this.compScene, this.orthoCam);
  }

  dispose() {
    this.sceneRT?.dispose(); this.cloudRT?.dispose(); this.noise?.dispose(); this.clearTex.dispose();
    this.cloudMat.dispose(); this.compMat.dispose();
  }
}

const EMPTY_IN: CloudWxIn = { cover: [0, 0, 0], lowBaseMsl: 1500, midBaseMsl: 3100, highBaseMsl: 9000, rain: 0, snow: 0, fog: 0, thunder: false, latDeg: 0, groundM: 0 };
