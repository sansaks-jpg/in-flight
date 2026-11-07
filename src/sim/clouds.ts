// Live-weather cloud field — one instanced draw call replaces the old per-sprite cloud layer.
//   * three real layers (low = METAR ceiling / dew-point deck, mid ≈ 700 hPa, cirrus ≈ 300 hPa)
//     whose cover fractions and base heights come straight from the live report (liveWeather.ts),
//   * camera-facing impostor quads shaded in the fragment shader toward/away from the true sun
//     position (bright flank + silver lining when backlit, blue-grey shadow flank), dissolving
//     into exactly the scene's FogExp2 colour/density so distant decks melt into the haze,
//   * deck advection by the live wind vector (per-layer shear: surface friction slows the low
//     deck, cirrus rides the faster upper flow), integrated on the sim clock — frozen while paused,
//   * deterministic hash grid so the pattern is stable as the camera moves; quality presets only
//     change the sprite budget (ultra 48 … low 14), never the look.
// Zero-allocation: update() writes into preallocated instance arrays and reuses uniform objects.
import * as THREE from 'three';

const CAP = 48; // largest preset budget (QUALITY.ultra.clouds); allocated once, here
export const CELL = 6500; // grid cell size in metres (same spacing the old sprite grid used)

const hashN = (a: number, b: number, s = 0) => {
  const v = Math.sin(a * 127.1 + b * 311.7 + s * 74.7) * 43758.5453;
  return v - Math.floor(v);
};

// Per-layer look: sprite footprint (m), vertical flattening, opacity, wind advection scale
// (boundary-layer friction slows the low deck; the upper flow carries cirrus faster) and base jitter (m).
const LAYERS = [
  { size: 3800, flat: 0.46, opacity: 0.92, wind: 0.75, jit: 220 },
  { size: 5600, flat: 0.4, opacity: 0.85, wind: 1.0, jit: 700 },
  { size: 7600, flat: 0.22, opacity: 0.55, wind: 1.35, jit: 1200 },
];

// Procedural multi-lobed puffy cumulus cloud texture with self-shadowed base.
// Sun shading itself happens per-pixel in the shader (see fragment below); this texture only
// carries the puff silhouette and a slightly darker, translucent base band.
export function makeCloudTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;

  for (let i = 0; i < 28; i++) {
    const x = 128 + (hashN(i, 1) - 0.5) * 110;
    const y = 140 + (hashN(i, 2) - 0.5) * 55;
    const r = 30 + hashN(i, 3) * 36;
    const gr = g.createRadialGradient(x, y - r * 0.25, r * 0.1, x, y, r);
    const isBase = y > 145;
    const alpha = isBase ? 0.36 : 0.62;
    gr.addColorStop(0, `rgba(255,255,255,${alpha})`);
    gr.addColorStop(0.5, isBase ? 'rgba(215,220,230,0.26)' : 'rgba(245,248,255,0.32)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 1×1 white stand-in so the module also constructs on non-DOM hosts (tests, workers). */
function fallbackTexture(): THREE.Texture {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 235]), 1, 1);
  t.needsUpdate = true;
  return t;
}

export class CloudField {
  mesh: THREE.Mesh;
  private geo = new THREE.InstancedBufferGeometry();
  private mat: THREE.ShaderMaterial;
  private off = new Float32Array(CAP * 3);
  private scl = new Float32Array(CAP * 2);
  private rnd = new Float32Array(CAP * 4);
  private scene: THREE.Scene;
  private budget: number;
  private cover: [number, number, number] = [0.1, 0, 0.1];
  private bases = [1800, 3100, 9160]; // MSL base per layer (low / mid / high)
  private driftX = 0;
  private driftZ = 0;
  private lastTime = -1;
  private timeInit = false;
  /** Per-layer drift-frame camera X/Z scratch (6 floats, preallocated — no per-frame allocation). */
  private effCam = [0, 0, 0, 0, 0, 0];

  constructor(scene: THREE.Scene, budget: number, tex?: THREE.Texture) {
    this.scene = scene;
    this.budget = Math.max(0, Math.min(CAP, Math.round(budget)));
    const plane = new THREE.PlaneGeometry(1, 1); // unit quad: iScale carries the true size
    this.geo.index = plane.index;
    this.geo.attributes.position = plane.attributes.position;
    this.geo.attributes.uv = plane.attributes.uv;
    this.geo.setAttribute('iOffset', new THREE.InstancedBufferAttribute(this.off, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iScale', new THREE.InstancedBufferAttribute(this.scl, 2).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iRand', new THREE.InstancedBufferAttribute(this.rnd, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false, // fog is blended manually below, with the exact scene fog colour/density
      uniforms: {
        map: { value: tex ?? fallbackTexture() },
        sunDir: { value: new THREE.Vector3(0, 1, 0) },
        litCol: { value: new THREE.Color(1, 1, 1) },
        shadowCol: { value: new THREE.Color(0.5, 0.53, 0.6) },
        fogColor: { value: new THREE.Color(1, 1, 1) },
        fogDensity: { value: 0.000034 },
        nearFade: { value: 250 },
        farStart: { value: 11000 },
        farEnd: { value: 26000 },
      },
      // Billboard in view space (mv.xy offset) — every quad faces the camera without per-instance
      // matrices; the sun-facing factor is evaluated once per instance in the vertex stage.
      vertexShader: `
        attribute vec3 iOffset; attribute vec2 iScale; attribute vec4 iRand;
        uniform vec3 sunDir;
        varying vec2 vUv; varying vec4 vData; varying vec2 vRot;
        void main(){
          vec4 mv = viewMatrix * vec4(iOffset, 1.0);
          mv.xy += position.xy * iScale;
          vUv = uv;
          vData.x = -mv.z;
          vData.y = dot(normalize(iOffset - cameraPosition), sunDir); // -1 away from sun … +1 toward it
          vData.z = iRand.y;
          vData.w = iRand.z;
          vRot = vec2(cos(iRand.x), sin(iRand.x));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D map; uniform vec3 litCol; uniform vec3 shadowCol;
        uniform vec3 fogColor; uniform float fogDensity; uniform float nearFade; uniform float farStart; uniform float farEnd;
        varying vec2 vUv; varying vec4 vData; varying vec2 vRot;
        void main(){
          // per-instance puff rotation so the shared texture never tiles recognisably
          vec2 p = vUv - 0.5;
          vec2 uv = vec2(p.x * vRot.x - p.y * vRot.y, p.x * vRot.y + p.y * vRot.x) + 0.5;
          vec4 tex = texture2D(map, uv);
          float dist = vData.x;
          // near fade: dissolve quads when crossing/deck-diving; far fade: dissolve into the haze
          float nearA = smoothstep(nearFade, nearFade * 3.2, dist);
          float farA = 1.0 - smoothstep(farStart, farEnd, dist);
          // FogExp2 (three's fog_fragment): distant clouds take exactly the colour terrain fades to
          float fogF = 1.0 - exp(-fogDensity * fogDensity * dist * dist);
          float fac = clamp(0.35 + 0.65 * (vData.y * 0.5 + 0.5) * tex.r, 0.0, 1.0);
          vec3 col = mix(shadowCol, litCol, fac);
          col += litCol * pow(max(vData.y, 0.0), 8.0) * 0.45 * tex.r; // silver lining when backlit
          col = mix(col, fogColor, clamp(fogF, 0.0, 1.0));
          float alpha = tex.a * vData.z * (0.8 + 0.2 * vData.w) * nearA * farA * (1.0 - fogF * 0.85);
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(col, alpha);
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4; // above the sky dome (-10), below precipitation (20)
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  setBudget(budget: number) {
    this.budget = Math.max(0, Math.min(CAP, Math.round(budget)));
  }

  /** Instances rendered by the last update (tests / debug). */
  get count() { return this.geo.instanceCount; }

  /** World position of instance i into the caller's vector (allocation-free). */
  offsetAt(i: number, out: THREE.Vector3): THREE.Vector3 { return out.set(this.off[i * 3], this.off[i * 3 + 1], this.off[i * 3 + 2]); }

  /** Push a live report: cover per layer (0..1) and the MSL base of each deck (see liveWeather.ts). */
  setLiveWeather(cover: [number, number, number], lowBaseMsl: number, midBaseMsl: number, highBaseMsl: number) {
    this.cover = cover;
    this.bases[0] = lowBaseMsl;
    this.bases[1] = Math.max(2200, Math.min(5500, midBaseMsl)); // clamp band matches liveWeather.midHighBases
    this.bases[2] = Math.max(7000, Math.min(12500, highBaseMsl));
  }

  /**
   * @param time    simulation clock (seconds — frozen while paused, so the drift freezes too)
   * @param windX/Z live wind (m/s, world axes) at the cloud decks; each layer shears it by LAYERS[].wind
   */
  update(cam: THREE.Vector3, time: number, sunDir: THREE.Vector3, lit: THREE.Color, shadow: THREE.Color, windX: number, windZ: number) {
    let dt = time - this.lastTime;
    this.lastTime = time;
    if (!this.timeInit) { dt = 0; this.timeInit = true; } // the very first frame must not step the wind
    if (!(dt > 0) || dt > 2) dt = 0;                      // pause or a big clock jump
    this.driftX += windX * dt;
    this.driftZ += windZ * dt;

    // fog follows the scene exactly (World.setSun owns the colour + Koschmieder density)
    const f = this.scene.fog as THREE.FogExp2 | null;
    const u = this.mat.uniforms;
    if (f && (f as THREE.FogExp2).isFogExp2) {
      (u.fogColor.value as THREE.Color).copy(f.color);
      const rho = f.density;
      u.fogDensity.value = rho;
      // clouds dissolve where FogExp2 saturates (≈1.6 extinction lengths), bounded to the field extent
      const farEnd = Math.max(2500, Math.min(30000, 1.6 / Math.max(1e-7, rho)));
      u.farStart.value = farEnd * 0.45;
      u.farEnd.value = farEnd;
    }
    (u.sunDir.value as THREE.Vector3).copy(sunDir);
    (u.litCol.value as THREE.Color).copy(lit);
    (u.shadowCol.value as THREE.Color).copy(shadow);

    // Deterministic hash grid around the camera, filled RING BY RING from the centre out so the
    // sprite budget is spent on the cells overhead first — never on the far edge of the window.
    // Within each cell layers fill low → high, so scarce budget favours the deck that matters most.
    // Each layer samples the grid at the camera offset BACKWARD by its accumulated wind drift and
    // adds the drift back to the world position: the pattern advects with the live wind while the
    // sampled cells always stay within one cell of the aircraft, so hours of unbounded drift can
    // never sail the whole field downwind and leave an empty sky.
    const target = this.budget;
    const R = Math.ceil(Math.sqrt(target) / 2) + 1;
    const cov = this.cover, bases = this.bases, eff = this.effCam;
    for (let l = 0; l < 3; l++) {
      eff[l * 2] = cam.x - this.driftX * LAYERS[l].wind;
      eff[l * 2 + 1] = cam.z - this.driftZ * LAYERS[l].wind;
    }
    let k = 0;
    for (let r = 0; r <= R && k < target; r++) {
      for (let i = -r; i <= r && k < target; i++) {
        for (let j = -r; j <= r && k < target; j++) {
          if (r > 0 && Math.abs(i) !== r && Math.abs(j) !== r) continue; // interior came with ring r-1
          for (let l = 0; l < 3 && k < target; l++) {
            const c = cov[l];
            const gx = Math.floor(eff[l * 2] / CELL) + i, gz = Math.floor(eff[l * 2 + 1] / CELL) + j;
            // seed = layer * 23 + property index: unique per (property, layer) so no two sprite
            // properties (presence, jitter, size, rotation) ever share one hash value
            const S = l * 23;
            if (c <= 0.04 || hashN(gx, gz, S + 0) > Math.min(1, c * 1.05)) continue;
            const L = LAYERS[l];
            const o = k * 3, q = k * 2, rr = k * 4;
            // fuller layers merge into a continuous deck: bigger, flatter sprites
            const merge = 0.75 + c * 0.9;
            const sz = L.size * (0.7 + hashN(gx, gz, S + 2) * 0.8) * merge;
            this.off[o] = (gx + hashN(gx, gz, S + 3)) * CELL + this.driftX * L.wind;
            this.off[o + 1] = bases[l] + hashN(gx, gz, S + 1) * L.jit;
            this.off[o + 2] = (gz + hashN(gx, gz, S + 4)) * CELL + this.driftZ * L.wind;
            this.scl[q] = sz;
            this.scl[q + 1] = sz * (l === 0 && c > 0.7 ? 0.3 : L.flat);
            this.rnd[rr] = hashN(gx, gz, S + 5) * 6.2831853; // texture rotation
            this.rnd[rr + 1] = L.opacity;
            this.rnd[rr + 2] = c; // denser decks render slightly more solid
            this.rnd[rr + 3] = 0;
            k++;
          }
        }
      }
    }
    this.geo.instanceCount = k;
    this.mesh.visible = k > 0;
    if (k > 0) {
      (this.geo.attributes.iOffset as THREE.InstancedBufferAttribute).needsUpdate = true;
      (this.geo.attributes.iScale as THREE.InstancedBufferAttribute).needsUpdate = true;
      (this.geo.attributes.iRand as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    const map = this.mat.uniforms.map?.value as THREE.Texture | undefined;
    map?.dispose();
    this.scene.remove(this.mesh);
  }
}
