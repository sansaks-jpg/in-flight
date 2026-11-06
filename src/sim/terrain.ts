// Streaming 3-level terrain: real elevation (AWS Terrain Tiles / Terrarium) + satellite imagery
// (Esri World Imagery) with a transparent road/rail overlay, baked relief shading and animated water.
import * as THREE from 'three';
import { Projection, R_MERC, tileSizeMerc, D2R, smoothstep, lerp, invMercX, invMercY, clamp } from './geo';
import { loadImage, tileUrl, styleById, ELEVATION_URL, cancelQueued, DEFAULT_TILE_STYLE } from './tiles';
import { groundDetailTexture } from './textures';
import { airportsNear, airfieldSpines } from '../data/airports';
import { QualityPreset } from './storage';
import { QUALITY } from './quality';

export interface LodCfg { z: number; r: number; N: number; drop: number; }
export const LOD_ULTRA: LodCfg[] = [
  { z: 15, r: 1, N: 81, drop: 0 },
  { z: 13, r: 2, N: 97, drop: 0 },
  { z: 11, r: 2, N: 65, drop: 30 },
  { z: 9, r: 1, N: 41, drop: 80 },
  { z: 7, r: 1, N: 25, drop: 160 },
];
export const LOD_HIGH: LodCfg[] = [
  { z: 15, r: 1, N: 65, drop: 0 },
  { z: 13, r: 2, N: 97, drop: 0 },
  { z: 11, r: 1, N: 65, drop: 30 },
  { z: 9, r: 1, N: 41, drop: 80 },
  { z: 7, r: 1, N: 25, drop: 160 },
];
export const LOD_MEDIUM: LodCfg[] = [
  { z: 15, r: 1, N: 49, drop: 0 },
  { z: 13, r: 1, N: 65, drop: 0 },
  { z: 11, r: 1, N: 41, drop: 30 },
  { z: 9, r: 1, N: 25, drop: 80 },
  { z: 7, r: 1, N: 17, drop: 160 },
];
export const LOD_LOW: LodCfg[] = [
  { z: 13, r: 1, N: 49, drop: 0 },
  { z: 11, r: 1, N: 33, drop: 30 },
  { z: 9, r: 1, N: 25, drop: 80 },
  { z: 7, r: 1, N: 17, drop: 160 },
];

const LOD_MAP: Record<QualityPreset, LodCfg[]> = {
  ultra: LOD_ULTRA,
  high: LOD_HIGH,
  medium: LOD_MEDIUM,
  low: LOD_LOW,
};

const FLAT_R = 420, BLEND_R = 1800; // realistic envelope around runways preserving airport plates and surrounding plains

const _tileBox = new THREE.Box3();
const _boxMin = new THREE.Vector3();
const _boxMax = new THREE.Vector3();

interface Tile {
  key: string; lod: number; z: number; x: number; y: number; mesh: THREE.Mesh | null; heights: Float32Array | null; water: Float32Array | null;
  /** 64x64 RGBA downsampled satellite imagery: RGB = true 1:1 colour, A = canopy vegetation score (0..255). */
  satGrid: Uint8Array | null;
  demDone: boolean; texDone: boolean; tex: THREE.Texture | null; overlayTex: THREE.Texture | null; disposed: boolean; synthetic: boolean;
  /** Chebyshev distance in tiles from the camera tile; drives how deep the imagery is stitched. */
  dist: number;
  /** Timestamp (seconds) when tile was last seen in view frustum or within core zone. */
  lastSeen?: number;
}

export interface SatSample {
  r: number;
  g: number;
  b: number;
  /** 0..1 canopy vegetation confidence from green-chroma analysis */
  veg: number;
  /** 0..1 built-up / roof confidence (terracotta tile, metal sheet, concrete) */
  roof: number;
}

interface TerrainUniforms {
  uHole: { value: THREE.Vector4 };
  uHasHole: { value: number };
  uOverlay: { value: THREE.Texture };
  uOverlayOpacity: { value: number };
  uTime: { value: number };
  uSunDir: { value: THREE.Vector3 };
  uSkyColor: { value: THREE.Color };
  uWaterColor: { value: THREE.Color };
  uNoise: { value: THREE.Texture };
}


// tiny value-noise fBm used ONLY when the elevation service is unreachable
function hash2(x: number, y: number) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(hash2(xi, yi), hash2(xi + 1, yi), u), lerp(hash2(xi, yi + 1), hash2(xi + 1, yi + 1), u), v);
}
function synthHeight(mx: number, my: number) {
  let a = 0, f = 1 / 90000, amp = 1;
  for (let i = 0; i < 5; i++) { a += vnoise(mx * f, my * f) * amp; f *= 2.1; amp *= 0.5; }
  return Math.max(0, (a - 0.75) * 1100);
}
function tint(h: number, n: number) {
  let r: number, g: number, b: number;
  if (h <= 0.05) { r = 0.12; g = 0.3; b = 0.48; }
  else if (h < 250) { r = 0.3; g = 0.48; b = 0.22; }
  else if (h < 1100) { const t = (h - 250) / 850; r = lerp(0.3, 0.45, t); g = lerp(0.48, 0.44, t); b = lerp(0.22, 0.25, t); }
  else if (h < 2600) { const t = (h - 1100) / 1500; r = lerp(0.45, 0.5, t); g = lerp(0.44, 0.45, t); b = lerp(0.25, 0.4, t); }
  else { const t = smoothstep(2600, 3600, h); r = lerp(0.5, 0.93, t); g = lerp(0.45, 0.94, t); b = lerp(0.4, 0.96, t); }
  const k = 0.92 + n * 0.16;
  return [r * k, g * k, b * k];
}

/** Shared fragment code: ocean colour, fresnel sky reflection, lagoon gradients, and sun glints. */
const WATER_GLSL = `
  float waterFactor = smoothstep(0.30, 0.80, vWater);
  // Coastal elevation guard: sea-level ocean water is strictly at elevation ≈ 0; dry land above 1.2m MSL is never sea
  if (vElevation > 1.2) {
    waterFactor = 0.0;
  }
  // Satellite imagery spectral guard: confirm underlying pixel is actually dark ocean/water.
  // Real land in satellite imagery (terracotta roofs, vegetation, concrete/asphalt)
  // has distinctive warm or green chromaticity and must NEVER be flooded with water waves.
  if (waterFactor > 0.01) {
    float sR = diffuseColor.r;
    float sG = diffuseColor.g;
    float sB = diffuseColor.b;
    float sLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    bool isWarmLand = (sR > 0.14 && sR > sB * 1.12);
    bool isVegLand = (sG > 0.09 && sG > sR * 1.15 && sG > sB * 1.05);
    bool isUrbanLand = (sLum > 0.28 && sR > 0.18);
    if (isWarmLand || isVegLand || isUrbanLand) {
      waterFactor = 0.0;
    }
  }
  if (waterFactor > 0.01) {
    vec3 V = normalize(cameraPosition - vWPos);
    float dist = length(cameraPosition - vWPos);
    float near = 1.0 / (1.0 + dist * 0.00045);
    float t = uTime;
    vec2 wp = vWPos.xz;
    float p1 = wp.x * 0.11 + t * 0.85;
    float p2 = wp.y * 0.15 - t * 0.65;
    float p3 = (wp.x + wp.y) * 0.055 + t * 1.25;
    vec3 N = normalize(vec3(
      (cos(p1) * 0.11 + cos(p3) * 0.03) * near,
      1.0,
      (cos(p2) * 0.15 + cos(p3) * 0.03) * near
    ));
    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
    vec3 H = normalize(normalize(uSunDir) + V);
    float glint = pow(max(dot(N, H), 0.0), 140.0);
    vec3 deep = uWaterColor;
    vec3 shallow = vec3(0.030, 0.105, 0.105);
    vec3 waterTint = mix(shallow, deep, clamp(0.45 + dist * 0.00035, 0.0, 1.0));
    // Shore foam only in the narrow strip where land meets sea at sea level (vWater transitioning)
    float shoreBand = smoothstep(0.18, 0.48, vWater) * (1.0 - smoothstep(0.68, 0.95, vWater));
    float shoreFoam = shoreBand * (1.0 - smoothstep(0.0, 0.35, abs(vElevation))) * (sin(wp.x * 0.4 + t * 2.0) * 0.5 + 0.5) * 0.12;
    diffuseColor.rgb = mix(diffuseColor.rgb, waterTint, 0.74 * waterFactor) + vec3(shoreFoam * waterFactor);
    diffuseColor.rgb += uSkyColor * fres * 0.30 * waterFactor;
    diffuseColor.rgb += vec3(1.0, 0.96, 0.85) * glint * 0.75 * waterFactor;
  }
`;

function patchTerrainMaterial(mat: THREE.MeshLambertMaterial, uni: TerrainUniforms) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aShade;
        attribute float aWater;
        varying float vShade;
        varying float vWater;
        varying float vElevation;
        varying vec3 vWPos;
        varying vec3 vWorldNormal;
        varying vec2 vTileUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vShade = aShade;
        vWater = aWater;
        vElevation = transformed.y;
        vTileUv = uv;
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vShade;
        varying float vWater;
        varying float vElevation;
        varying vec3 vWPos;
        varying vec3 vWorldNormal;
        varying vec2 vTileUv;
        uniform sampler2D uOverlay;
        uniform sampler2D uNoise;
        uniform float uOverlayOpacity;
        uniform float uTime;
        uniform vec3 uSunDir;
        uniform vec3 uSkyColor;
        uniform vec3 uWaterColor;
        uniform vec4 uHole;
        uniform float uHasHole;`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (uHasHole > 0.5 && vWPos.x > uHole.x && vWPos.x < uHole.y && vWPos.z > uHole.z && vWPos.z < uHole.w) discard;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        if (uOverlayOpacity > 0.0) {
          vec4 road = texture2D(uOverlay, vTileUv);
          diffuseColor.rgb = mix(diffuseColor.rgb, road.rgb, road.a * uOverlayOpacity);
        }
        diffuseColor.rgb *= vShade;

        // 1. Procedural Triplanar Cliff Strata for steep mountain slopes (Bromo, Merapi, Rinjani, etc.)
        float camDist = length(cameraPosition - vWPos);
        vec3 wNorm = normalize(vWorldNormal);
        float steepness = 1.0 - clamp(abs(wNorm.y), 0.0, 1.0);
        float cliff = smoothstep(0.22, 0.38, steepness) * (1.0 - smoothstep(0.05, 0.5, vWater));
        if (cliff > 0.01) {
          float cliffFade = 1.0 - smoothstep(900.0, 6000.0, camDist);
          float strataY = sin(vWPos.y * 0.32 + sin(vWPos.x * 0.02 + vWPos.z * 0.02) * 2.2);
          // coarser secondary band (was 1.5/m = ~4m, which alias-sparkled on distant ridges)
          float fineStrata = sin(vWPos.y * 0.42 + cos(vWPos.z * 0.05) * 1.2);
          float rockNoise = strataY * 0.6 + fineStrata * (0.4 * cliffFade);
          vec3 darkRock = vec3(0.24, 0.22, 0.20);
          vec3 lightRock = vec3(0.42, 0.38, 0.34);
          vec3 rock = mix(darkRock, lightRock, rockNoise * 0.5 + 0.5);
          diffuseColor.rgb = mix(diffuseColor.rgb, rock * vShade, cliff * 0.85);
        }

        // 2. Pure 1:1 Satellite Colour Preservation + Luminance-Only Micro-Detail.
        //    Preserves authentic satellite chromaticity while fetching noise conditionally
        //    based on camera distance to eliminate wasted bandwidth.
        if (cliff < 0.5) {
          float nearF = 1.0 - smoothstep(1000.0, 4600.0, camDist);
          float nearDetail = 1.0 - smoothstep(90.0, 750.0, camDist);
          vec2 gp = vWPos.xz;
          float g = 0.0;
          if (nearF > 0.0) {
            g += (texture2D(uNoise, gp * 0.04200).b - 0.5) * 0.12 * nearF;
          }
          if (nearDetail > 0.0) {
            g += (texture2D(uNoise, gp * 0.23000).b - 0.5) * 0.10 * nearDetail;
          }
          vec3 land = max(diffuseColor.rgb, vec3(0.0));
          // Subtle aerial dehaze & natural vibrance so 1:1 satellite roofs, roads and trees pop cleanly
          float lum = dot(land, vec3(0.299, 0.587, 0.114));
          land = mix(vec3(lum), land, 1.12);
          diffuseColor.rgb = land * (1.0 + g);
        }

        // 3. Water surface with tropical coral lagoon gradient and sun glints
        ${WATER_GLSL}

        // 4. Extra aerial perspective on top of scene fog. The bulk of the depth cue is FogExp2
        //    (which fades to the exact sky-horizon colour); this small term settles distant ridges
        //    into the horizon instead of letting them end in a hard silhouette.
        float farHaze = smoothstep(28000.0, 170000.0, camDist) * 0.30;
        diffuseColor.rgb = mix(diffuseColor.rgb, uSkyColor, farHaze);`);
  };
  mat.customProgramCacheKey = () => 'terrain-satellite-v13';
}

function makeEmptyTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

const idxCache = new Map<number, THREE.BufferAttribute>();

function getIndexAttribute(N: number): THREE.BufferAttribute {
  let cached = idxCache.get(N);
  if (cached) return cached;

  const idxArr: number[] = [];
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    idxArr.push(a, c, b, b, c, d);
  }
  const edges: [number, number][][] = [[], [], [], []];
  for (let k = 0; k < N; k++) { edges[0].push([k, 0]); edges[1].push([k, N - 1]); edges[2].push([0, k]); edges[3].push([N - 1, k]); }
  let base = N * N;
  edges.forEach((e, ei) => {
    for (let k = 0; k < N - 1; k++) {
      const a = e[k][1] * N + e[k][0], b = e[k + 1][1] * N + e[k + 1][0], c = base + k, d = base + k + 1;
      if (ei === 0 || ei === 3) idxArr.push(a, b, c, b, d, c); else idxArr.push(a, c, b, b, c, d);
    }
    base += N;
  });

  cached = new THREE.BufferAttribute(new Uint16Array(idxArr), 1);
  idxCache.set(N, cached);
  return cached;
}

export class Terrain {
  group = new THREE.Group();
  tiles = new Map<string, Tile>();
  lods: LodCfg[];
  holeUniforms: { uHole: { value: THREE.Vector4 } }[];
  ringReady: boolean[] = [];
  fallbackH = 0;
  styleId = DEFAULT_TILE_STYLE;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private satCanvas = document.createElement('canvas');
  private satCtx: CanvasRenderingContext2D | null;
  private buildQueue: { tile: Tile; img: HTMLImageElement | null }[] = [];
  private maxAniso = 4;
  private emptyTex = makeEmptyTexture();
  private noiseTex: THREE.Texture;
  private timeU = { value: 0 };
  private sunU = { value: new THREE.Vector3(0.45, 0.8, 0.3).normalize() };
  private skyU = { value: new THREE.Color(0.62, 0.76, 0.9) };
  private waterU = { value: new THREE.Color(0.035, 0.10, 0.17) };
  public quality: QualityPreset = 'high';
  demFailures = 0;
  private demOk = 0;

  constructor(public proj: Projection, quality: QualityPreset, public scene: THREE.Scene, maxAniso = 4) {
    this.quality = quality;
    this.lods = LOD_MAP[quality] ?? LOD_HIGH;
    this.canvas.width = this.canvas.height = 256;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.satCanvas.width = this.satCanvas.height = 64;
    this.satCtx = this.satCanvas.getContext('2d', { willReadFrequently: true });
    this.holeUniforms = this.lods.map(() => ({ uHole: { value: new THREE.Vector4(0, 0, 0, 0) } }));
    this.maxAniso = maxAniso;
    this.noiseTex = groundDetailTexture(maxAniso);
    scene.add(this.group);
  }

  setQuality(q: QualityPreset) {
    if (q === this.quality) return;
    this.quality = q;
    this.lods = LOD_MAP[q] ?? LOD_HIGH;
    // A tier change switches the whole LOD ring layout (low starts at z13; ultra reaches z7).
    // Existing meshes were built against the previous ring heights/hole uniforms, so dispose
    // them and let the next update stream the new layout instead of mixing two geometries.
    for (const [key, t] of [...this.tiles]) this.disposeTile(t, key);
    this.buildQueue.length = 0;
    this.holeUniforms = this.lods.map(() => ({ uHole: { value: new THREE.Vector4(0, 0, 0, 0) } }));
    this.ringReady = [];
  }

  /** Lighting/time-of-day feedback used by the water and satellite shading. */
  setEnvironment(sky: THREE.Color, sunDir: THREE.Vector3) {
    this.skyU.value.copy(sky);
    this.sunU.value.copy(sunDir);
    this.waterU.value.setRGB(0.018, 0.12, 0.24).lerp(sky, 0.045);
  }

  // ---------- height / water queries ----------
  private sampleField(x: number, z: number, field: (t: Tile) => Float32Array | null): number | null {
    const mx = x / this.proj.k + this.proj.ox, my = -z / this.proj.k + this.proj.oy;
    for (let l = 0; l < this.lods.length; l++) {
      const cfg = this.lods[l], S = tileSizeMerc(cfg.z);
      const tx = Math.floor((mx + Math.PI * R_MERC) / S), ty = Math.floor((Math.PI * R_MERC - my) / S);
      const t = this.tiles.get(`${cfg.z}/${tx}/${ty}`);
      const H = t ? field(t) : null;
      if (t && H) {
        const N = cfg.N;
        const u = ((mx + Math.PI * R_MERC) / S - tx) * (N - 1), v = ((Math.PI * R_MERC - my) / S - ty) * (N - 1);
        const i = Math.min(N - 2, Math.max(0, Math.floor(u))), j = Math.min(N - 2, Math.max(0, Math.floor(v)));
        const fu = clamp(u - i, 0, 1), fv = clamp(v - j, 0, 1);
        // triangle-accurate interpolation matching mesh diagonal (a -> d split)
        const h00 = H[j * N + i], h10 = H[j * N + i + 1], h01 = H[(j + 1) * N + i], h11 = H[(j + 1) * N + i + 1];
        if (fu + fv <= 1) return h00 + (h10 - h00) * fu + (h01 - h00) * fv;
        return h11 + (h01 - h11) * (1 - fu) + (h10 - h11) * (1 - fv);
      }
    }
    return null;
  }
  /** Terrain elevation (metres MSL) from the loaded DEM mesh. */
  heightAt(x: number, z: number): number { return this.sampleField(x, z, (t) => t.heights) ?? this.fallbackH; }
  /** 0..1 water mask matching the rendered coastline (1 = sea or lake). */
  waterAt(x: number, z: number): number { return this.sampleField(x, z, (t) => t.water) ?? 0; }
  /** True once real DEM heights (not the airport fallback) are available here. */
  heightReady(x: number, z: number): boolean { return this.sampleField(x, z, (t) => t.heights) !== null; }
  /** True once 1:1 satellite pixel samples are ready under this world coordinate. */
  satReady(x: number, z: number): boolean { return this.sampleSatellite(x, z) !== null; }

  /**
   * Samples the finest loaded 1:1 satellite tile at world (x, z), returning true RGB (0..1),
   * green-canopy vegetation score (0..1), and built-up roof confidence (0..1).
   */
  sampleSatellite(x: number, z: number): SatSample | null {
    const mx = x / this.proj.k + this.proj.ox, my = -z / this.proj.k + this.proj.oy;
    for (let l = 0; l < this.lods.length; l++) {
      const cfg = this.lods[l], S = tileSizeMerc(cfg.z);
      const tx = Math.floor((mx + Math.PI * R_MERC) / S), ty = Math.floor((Math.PI * R_MERC - my) / S);
      const t = this.tiles.get(`${cfg.z}/${tx}/${ty}`);
      if (t && t.satGrid) {
        const u = clamp((mx + Math.PI * R_MERC) / S - tx, 0, 0.9999);
        const v = clamp((Math.PI * R_MERC - my) / S - ty, 0, 0.9999);
        const gx = Math.min(63, Math.floor(u * 64));
        const gy = Math.min(63, Math.floor(v * 64));
        const idx = (gy * 64 + gx) * 4;
        const g = t.satGrid;
        const r = g[idx] / 255, gr = g[idx + 1] / 255, b = g[idx + 2] / 255;
        const veg = g[idx + 3] / 255;
        const lum = 0.299 * r + 0.587 * gr + 0.114 * b;
        // Terracotta clay roof (warm red/orange) or bright galvalume/concrete roof or settlement fabric
        const clay = clamp((r - gr * 1.04) * 4.0 + (r - b * 1.15) * 2.2, 0, 1);
        const metal = lum > 0.24 && veg < 0.15 && Math.abs(r - gr) < 0.10 ? clamp((lum - 0.22) * 2.5, 0, 1) : 0;
        const urbanFabric = lum > 0.14 && lum < 0.65 && veg < 0.10 && (r > gr * 0.98 || Math.abs(r - gr) < 0.08) ? 0.35 : 0;
        const roof = veg < 0.20 ? Math.max(clay, metal, urbanFabric) : 0;
        return { r, g: gr, b, veg, roof };
      }
    }
    return null;
  }

  // ---------- streaming ----------
  setStyle(id: string) {
    if (id === this.styleId) return;
    this.styleId = id;
    cancelQueued((u) => !u.includes('elevation-tiles'));
    this.tiles.forEach((t) => {
      t.texDone = false;
      if (t.overlayTex) { t.overlayTex.dispose(); t.overlayTex = null; }
      if (t.mesh) {
        const u = (t.mesh.material as THREE.Material).userData.uni as TerrainUniforms;
        u.uOverlay.value = this.emptyTex; u.uOverlayOpacity.value = 0;
      }
      this.requestTexture(t);
    });
  }

  update(camX: number, camZ: number, time = 0, sunDir?: THREE.Vector3, frustum?: THREE.Frustum) {
    this.timeU.value = time;
    if (sunDir) this.sunU.value.copy(sunDir);
    const mx = camX / this.proj.k + this.proj.ox, my = -camZ / this.proj.k + this.proj.oy;
    const wanted = new Set<string>();
    this.lods.forEach((cfg, l) => {
      const S = tileSizeMerc(cfg.z), n = 2 ** cfg.z;
      const halfSize = (S * this.proj.k) * 0.5;
      const cx = Math.floor((mx + Math.PI * R_MERC) / S), cy = Math.floor((Math.PI * R_MERC - my) / S);
      for (let dy = -cfg.r; dy <= cfg.r; dy++) for (let dx = -cfg.r; dx <= cfg.r; dx++) {
        const ty = cy + dy; if (ty < 0 || ty >= n) continue;
        const tx = cx + dx;
        const key = `${cfg.z}/${tx}/${ty}`;

        // Mercator center to world position
        const cmx = -Math.PI * R_MERC + (tx + 0.5) * S;
        const cmy = Math.PI * R_MERC - (ty + 0.5) * S;
        const posX = (cmx - this.proj.ox) * this.proj.k;
        const posZ = -(cmy - this.proj.oy) * this.proj.k;
        const distCam = Math.hypot(posX - camX, posZ - camZ);

        // Core 360-degree zone or innermost ring is never culled
        const coreR = QUALITY[this.quality].terrainCore;
        let inView = false;
        if (l === 0 || distCam - halfSize <= coreR || !frustum) {
          inView = true;
        } else {
          _boxMin.set(posX - halfSize - 1000, -500, posZ - halfSize - 1000);
          _boxMax.set(posX + halfSize + 1000, 4500, posZ + halfSize + 1000);
          _tileBox.set(_boxMin, _boxMax);
          inView = frustum.intersectsBox(_tileBox);
        }

        if (inView) {
          wanted.add(key);
          const t = this.tiles.get(key);
          if (t) {
            t.lastSeen = time;
            if (t.mesh) t.mesh.visible = true;
          } else {
            this.createTile(key, l, cfg.z, tx, ty, Math.hypot(dx, dy));
          }
        } else {
          const t = this.tiles.get(key);
          if (t) {
            if (t.mesh) t.mesh.visible = false;
            // Graceful retention: keep in memory for up to 8s in case pilot pans camera back
            if (time - (t.lastSeen || 0) <= 8.0) {
              wanted.add(key);
            }
          }
        }
      }
    });
    // unload
    for (const [k, t] of this.tiles) if (!wanted.has(k)) this.disposeTile(t, k);
    // build at most 1-2 meshes per frame within a strict 2.2 ms frame budget
    let built = 0;
    const t0 = performance.now();
    while (this.buildQueue.length && built < 2 && performance.now() - t0 < 2.2) {
      const it = this.buildQueue.shift()!;
      if (!it.tile.disposed) { this.buildMesh(it.tile, it.img); built++; }
    }
    // hole uniforms: hide coarser tiles under finer ring when that ring is entirely built
    this.lods.forEach((cfg, l) => {
      let all = true, minX = 1e18, maxX = -1e18, minZ = 1e18, maxZ = -1e18;
      const S = tileSizeMerc(cfg.z), n = 2 ** cfg.z;
      const cx = Math.floor((mx + Math.PI * R_MERC) / S), cy = Math.floor((Math.PI * R_MERC - my) / S);
      for (let dy = -cfg.r; dy <= cfg.r; dy++) for (let dx = -cfg.r; dx <= cfg.r; dx++) {
        const ty = cy + dy; if (ty < 0 || ty >= n) continue;
        const t = this.tiles.get(`${cfg.z}/${cx + dx}/${ty}`);
        if (!t || !t.mesh) { all = false; continue; }
        minX = Math.min(minX, t.mesh.position.x - S * this.proj.k / 2); maxX = Math.max(maxX, t.mesh.position.x + S * this.proj.k / 2);
        minZ = Math.min(minZ, t.mesh.position.z - S * this.proj.k / 2); maxZ = Math.max(maxZ, t.mesh.position.z + S * this.proj.k / 2);
      }
      this.ringReady[l] = all;
      if (l + 1 < this.lods.length) {
        const u = this.holeUniforms[l + 1].uHole.value;
        if (all) u.set(minX + 350, maxX - 350, minZ + 350, maxZ - 350); else u.set(0, 0, 0, 0);
      }
    });
  }

  /** 0..1 loading progress of the innermost ring (used by loading screen). */
  progress() {
    const cfg = this.lods[0], n = Math.pow(cfg.r * 2 + 1, 2);
    let done = 0; this.tiles.forEach((t) => { if (t.lod === 0 && t.mesh && t.texDone) done++; });
    return Math.min(1, done / n);
  }
  nearReady() { return this.progress() >= 0.99; }
  get offline() { return this.demFailures > 3 && this.demOk === 0; }

  rebase(np: Projection) {
    // keep tile cache; just recompute positions & scales around the new origin
    this.proj = np;
    this.tiles.forEach((t) => { if (t.mesh) this.placeMesh(t); });
  }

  private placeMesh(t: Tile) {
    const S = tileSizeMerc(t.z), p = this.proj;
    const cmx = -Math.PI * R_MERC + (t.x + 0.5) * S, cmy = Math.PI * R_MERC - (t.y + 0.5) * S;
    t.mesh!.position.set((cmx - p.ox) * p.k, -this.lods[t.lod].drop, -(cmy - p.oy) * p.k);
    t.mesh!.scale.set(p.k, 1, p.k);
  }

  private createTile(key: string, lod: number, z: number, x: number, y: number, dist: number) {
    const t: Tile = { key, lod, z, x, y, mesh: null, heights: null, water: null, satGrid: null, demDone: false, texDone: false, tex: null, overlayTex: null, disposed: false, synthetic: false, dist, lastSeen: performance.now() / 1000 };
    this.tiles.set(key, t);
    const prio = lod * 10 + dist;
    loadImage(tileUrl(ELEVATION_URL, z, x, y), prio).then((img) => {
      if (t.disposed) return;
      if (img) this.demOk++; else this.demFailures++;
      this.buildQueue.push({ tile: t, img });
    });
    this.requestTexture(t);
  }

  private extractSatGrid(t: Tile, source: CanvasImageSource) {
    if (t.lod > 2 || !this.satCtx) return;
    try {
      this.satCtx.drawImage(source, 0, 0, 64, 64);
      const data = this.satCtx.getImageData(0, 0, 64, 64).data;
      const grid = new Uint8Array(64 * 64 * 4);
      const isSat = !!styleById(this.styleId).satellite;
      for (let i = 0; i < 64 * 64; i++) {
        const k = i * 4;
        const r = data[k] / 255, g = data[k + 1] / 255, b = data[k + 2] / 255;
        grid[k] = data[k];
        grid[k + 1] = data[k + 1];
        grid[k + 2] = data[k + 2];
        let veg = 0;
        if (isSat) {
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          const exG = 2 * g - r - b;
          const grDiff = g - r;
          const gbDiff = g - b * 0.94;
          // Tropical tree canopies in Esri World Imagery: green-dominant, mid-to-deep luminance,
          // excluding turquoise water (where B >= G) and bright concrete/clouds (lum > 0.50).
          if (lum > 0.032 && lum < 0.52 && grDiff > 0.003 && gbDiff > 0.004) {
            const canopyWeight = lum < 0.34 ? 1.32 : 0.75;
            veg = clamp((exG * 4.2 + grDiff * 3.6) * canopyWeight, 0, 1);
          }
        }
        grid[k + 3] = Math.round(veg * 255);
      }
      t.satGrid = grid;
    } catch {
      // CORS or headless environment fallback
    }
  }

  private requestTexture(t: Tile) {
    const st = styleById(this.styleId);
    const z = Math.min(t.z, st.maxZoom);
    const style = this.styleId;
    if (z !== t.z) t.texDone = true;
    else if (this.quality !== 'low' && t.lod <= 1 && t.z + 1 <= st.maxZoom) {
      // Imagery stitching. The innermost tiles go two zoom levels deeper (4x4 grid, 1024px),
      // the rest of the near ring one level (2x2, 512px).
      const deep = this.quality === 'ultra' ? (t.dist <= 1.0 && t.z + 2 <= st.maxZoom) : (this.quality === 'high' && t.dist <= 1.2 && t.z + 2 <= st.maxZoom);
      const lv = (this.quality === 'ultra' && deep) ? 2 : (this.quality === 'high' && t.lod === 0) ? 1 : deep ? 2 : 1;
      const f = 1 << lv;
      const cz = t.z + lv, cx0 = t.x * f, cy0 = t.y * f;
      const urls: string[] = [];
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) urls.push(tileUrl(st.url, cz, cx0 + dx, cy0 + dy));
      Promise.all(urls.map((u, i) => loadImage(u, 1 + i * 0.05))).then((imgs) => {
        if (t.disposed || style !== this.styleId) return;
        t.texDone = true;
        const got = imgs.filter(Boolean) as HTMLImageElement[];
        if (got.length === urls.length) { this.setStitchedTexture(t, got, f); return; }
        // Partial grid: fall back to the plain tile so the texture stays aligned to the mesh.
        loadImage(tileUrl(st.url, t.z, t.x, t.y), 1).then((img) => {
          if (t.disposed || style !== this.styleId) return;
          if (img) this.setBaseTexture(t, img);
          else if (st.fallbackUrl) {
            loadImage(tileUrl(st.fallbackUrl, Math.min(t.z, 19), t.x, t.y), 6).then((fb) => {
              if (t.disposed || style !== this.styleId || !fb) return;
              this.setBaseTexture(t, fb);
            });
          }
        });
      });
    } else {
      loadImage(tileUrl(st.url, t.z, t.x, t.y), t.lod * 10 + 1).then((img) => {
        if (t.disposed || style !== this.styleId) return;
        t.texDone = true;
        if (img) this.setBaseTexture(t, img);
        else if (st.fallbackUrl) {
          loadImage(tileUrl(st.fallbackUrl, Math.min(t.z, 19), t.x, t.y), t.lod * 10 + 6).then((fb) => {
            if (t.disposed || style !== this.styleId || !fb) return;
            this.setBaseTexture(t, fb);
          });
        }
      });
    }
    // transparent roads/rail overlay — 2D map only by default (the satellite already shows roads on the 3D mesh)
    if (st.overlayUrl && st.terrainOverlay) {
      const oz = Math.min(t.z, st.overlayMaxZoom ?? st.maxZoom);
      if (oz === t.z) {
        loadImage(tileUrl(st.overlayUrl, t.z, t.x, t.y), t.lod * 10 + 2).then((img) => {
          if (t.disposed || style !== this.styleId || !img) return;
          const tex = new THREE.Texture(img);
          tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = this.maxAniso; tex.generateMipmaps = true;
          tex.minFilter = THREE.LinearMipmapLinearFilter; tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.needsUpdate = true;
          if (t.overlayTex) t.overlayTex.dispose();
          t.overlayTex = tex; this.applyOverlay(t);
        });
      }
    }
  }

  private setBaseTexture(t: Tile, img: HTMLImageElement) {
    this.extractSatGrid(t, img);
    const tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = this.maxAniso; tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    const px = 256;
    tex.repeat.set((px - 1) / px, (px - 1) / px);
    tex.offset.set(0.5 / px, 0.5 / px);
    tex.needsUpdate = true;
    if (t.tex) t.tex.dispose();
    t.tex = tex; this.applyTexture(t);
  }

  /** Combines the four child tiles of a near tile into one 512px texture. */
  /** Combines an fxf grid of child tiles into one texture of f*256 px. */
  private setStitchedTexture(t: Tile, imgs: HTMLImageElement[], f: number) {
    const size = f * 256;
    // A PRIVATE canvas per tile. This used to be one shared `stitchCanvas`; every texture then
    // pointed at the same canvas, and because the GPU upload happens at the next render, any tiles
    // stitched in the same frame all received the *last* tile's imagery — which is why whole
    // patches of ground looked like smeared, misaligned satellite mush at low altitude.
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, size, size);
    for (let i = 0; i < imgs.length; i++) g.drawImage(imgs[i], (i % f) * 256, Math.floor(i / f) * 256, 256, 256);
    this.extractSatGrid(t, c);
    const tex = new THREE.Texture(c);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = this.maxAniso; tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.repeat.set((size - 1) / size, (size - 1) / size);
    tex.offset.set(0.5 / size, 0.5 / size);
    tex.needsUpdate = true;
    if (t.tex) t.tex.dispose();
    t.tex = tex; this.applyTexture(t);
  }

  private applyTexture(t: Tile) {
    if (!t.mesh || !t.tex) return;
    const m = t.mesh.material as THREE.MeshLambertMaterial;
    m.map = t.tex; m.vertexColors = false; m.color.set(0xffffff); m.needsUpdate = true;
  }
  private applyOverlay(t: Tile) {
    if (!t.mesh) return;
    const u = (t.mesh.material as THREE.Material).userData.uni as TerrainUniforms;
    const st = styleById(this.styleId);
    if (t.overlayTex) {
      u.uOverlay.value = t.overlayTex;
      u.uOverlayOpacity.value = (st.overlayOpacity ?? 0.9) * (t.lod === 0 ? 1 : t.lod === 1 ? 0.72 : 0.5);
    } else {
      u.uOverlay.value = this.emptyTex; u.uOverlayOpacity.value = 0;
    }
  }

  private disposeTile(t: Tile, key: string) {
    t.disposed = true; this.tiles.delete(key);
    if (t.mesh) { this.group.remove(t.mesh); t.mesh.geometry.dispose(); (t.mesh.material as THREE.Material).dispose(); }
    if (t.tex) t.tex.dispose();
    if (t.overlayTex) t.overlayTex.dispose();
  }

  private buildMesh(t: Tile, img: HTMLImageElement | null) {
    const cfg = this.lods[t.lod], N = cfg.N, S = tileSizeMerc(t.z);
    const cmx0 = -Math.PI * R_MERC + t.x * S, cmy0 = Math.PI * R_MERC - t.y * S; // NW corner (mercator)
    // 1. raw elevation
    let src: Uint8ClampedArray | null = null;
    if (img) { this.ctx.drawImage(img, 0, 0, 256, 256); try { src = this.ctx.getImageData(0, 0, 256, 256).data; } catch { src = null; } }
    const H = new Float32Array(N * N);
    const W = new Float32Array(N * N);
    const sample = (px: number, py: number) => {
      const x0 = Math.min(254, Math.floor(px)), y0 = Math.min(254, Math.floor(py)), fx = px - x0, fy = py - y0;
      const g = (xx: number, yy: number) => { const i = (yy * 256 + xx) * 4; return src![i] * 256 + src![i + 1] + src![i + 2] / 256 - 32768; };
      return lerp(lerp(g(x0, y0), g(x0 + 1, y0), fx), lerp(g(x0, y0 + 1), g(x0 + 1, y0 + 1), fx), fy);
    };
    t.synthetic = !src;
    // airports whose runways influence this tile
    const centerLat = invMercY(cmy0 - S / 2), centerLon = invMercX(cmx0 + S / 2);
    const aps = airportsNear(centerLat, centerLon, (S * Math.cos(centerLat * D2R)) * 0.75 + BLEND_R + 4000);
    const segs: { ax: number; ay: number; bx: number; by: number; elev: number; cos: number }[] = [];
    for (const a of aps) for (const r of a.runways) {
      segs.push({ ax: mx_(r.leLon), ay: my_(r.leLat), bx: mx_(r.heLon), by: my_(r.heLat), elev: a.elev, cos: Math.cos(a.lat * D2R) });
    }
    // Surveyed aprons / terminals / hangars sit level with the field too, so a parked aircraft never floats or sinks.
    for (const a of aps) for (const [la, lo] of airfieldSpines(a)) {
      segs.push({ ax: mx_(lo), ay: my_(la), bx: mx_(lo), by: my_(la), elev: a.elev, cos: Math.cos(a.lat * D2R) });
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const u = i / (N - 1), v = j / (N - 1);
      const mx = cmx0 + u * S, my = cmy0 - v * S;
      const raw = src ? sample(u * 255, v * 255) : synthHeight(mx, my);

      let bestD = 1e9, bestE = 0;
      for (const s of segs) {
        const dx = s.bx - s.ax, dy = s.by - s.ay, L2 = dx * dx + dy * dy || 1;
        const tt = clamp(((mx - s.ax) * dx + (my - s.ay) * dy) / L2, 0, 1);
        const d = Math.hypot(mx - (s.ax + dx * tt), my - (s.ay + dy * tt)) * s.cos;
        if (d < bestD) { bestD = d; bestE = s.elev; }
      }

      const nearAirport = bestD < FLAT_R + BLEND_R + 1500;
      // Below-sea-level airport support (e.g. EHAM Amsterdam at -3m, KL06 Death Valley at -64m)
      const minLandH = (nearAirport && bestE < 0) ? bestE - 2.0 : 0.0;

      // In AWS Terrarium, real ocean bathymetry is negative (seabed depth: -2m to -5000m).
      // Coastal plains near sea level (Jakarta, Miami, Bangkok) read 0.0m to 2.5m MSL with minor DEM noise.
      // Dry land above sea level (raw >= 0.0) is strictly land (water = 0).
      let water = 0;
      if (src) {
        if (!nearAirport) {
          if (raw < -0.35) {
            water = 1.0;
          } else if (raw < 0.0) {
            water = clamp(-raw / 0.35, 0, 1);
          }
        }
      } else {
        water = (!nearAirport && raw < 0.05) ? 1.0 : 0.0;
      }

      // Height: ocean surface is clamped to 0.0 MSL, while dry land and below-sea-level airports
      // preserve their true elevation down to their local floor.
      let h = src ? Math.max(minLandH, raw) : raw;

      if (bestD < FLAT_R + BLEND_R) {
        h = lerp(bestE, h, smoothstep(FLAT_R, FLAT_R + BLEND_R, bestD));
        water = 0; // airport plateau and envelope is strictly dry land
      } else if (nearAirport) {
        water = 0; // airport approach and perimeter are strictly dry land
      }
      H[j * N + i] = h;
      W[j * N + i] = water;
    }
    t.heights = H;
    t.water = W;
    t.demDone = true;
    if (!this.fallbackH && t.lod === 0) this.fallbackH = H[(N >> 1) * N + (N >> 1)];
    // 2. geometry (with skirts)
    const nv = N * N + 4 * N, pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), col = new Float32Array(nv * 3);
    const shadeArr = new Float32Array(nv), waterArr = new Float32Array(nv);
    const cell = S / (N - 1), skirt = 90 + t.lod * 150;
    const vert = (idx: number, i: number, j: number, hh: number, nx: number, ny: number, nz: number, sh: number, wtr: number) => {
      pos[idx * 3] = (i / (N - 1) - 0.5) * S; pos[idx * 3 + 1] = hh; pos[idx * 3 + 2] = (j / (N - 1) - 0.5) * S;
      nor[idx * 3] = nx; nor[idx * 3 + 1] = ny; nor[idx * 3 + 2] = nz;
      uv[idx * 2] = i / (N - 1); uv[idx * 2 + 1] = 1 - j / (N - 1);
      const c = tint(hh, 0.5); col[idx * 3] = c[0]; col[idx * 3 + 1] = c[1]; col[idx * 3 + 2] = c[2];
      shadeArr[idx] = sh; waterArr[idx] = wtr;
    };
    const hAt = (i: number, j: number) => H[clamp(j, 0, N - 1) * N + clamp(i, 0, N - 1)];
    const shadeAt = (i: number, j: number) => {
      const h = hAt(i, j);
      const avg = (hAt(i - 1, j) + hAt(i + 1, j) + hAt(i, j - 1) + hAt(i, j + 1)) * 0.25;
      const relief = clamp((h - avg) / Math.max(22, cell), -2.2, 2.2);
      const slope = Math.min(1, (Math.abs(hAt(i - 1, j) - hAt(i + 1, j)) + Math.abs(hAt(i, j - 1) - hAt(i, j + 1))) / (2 * cell));
      return clamp(0.97 + relief * 0.10 - slope * 0.08, 0.80, 1.06);
    };
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const dhx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * cell);
      const dhz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * cell);
      const invLen = 1.0 / (Math.hypot(-dhx, 1, -dhz) || 1);
      vert(j * N + i, i, j, H[j * N + i], -dhx * invLen, invLen, -dhz * invLen, shadeAt(i, j), W[j * N + i]);
    }
    // skirts: duplicate border vertices lowered
    let si = N * N;
    const edges: [number, number][][] = [[], [], [], []];
    for (let k = 0; k < N; k++) { edges[0].push([k, 0]); edges[1].push([k, N - 1]); edges[2].push([0, k]); edges[3].push([N - 1, k]); }
    edges.forEach((e) => {
      // Skirts exist only to hide hairline cracks between tiles. Shading them dark made any
      // exposed skirt read as a black wall along LOD ring edges, so keep them near ground tone.
      e.forEach(([i, j]) => { vert(si++, i, j, H[j * N + i] - skirt, 0, 1, 0, 0.9, 0); });
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aShade', new THREE.BufferAttribute(shadeArr, 1));
    geo.setAttribute('aWater', new THREE.BufferAttribute(waterArr, 1));
    geo.setIndex(getIndexAttribute(N));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 500, 0), S * 0.9);
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      polygonOffset: t.lod > 0,
      polygonOffsetFactor: t.lod,
      polygonOffsetUnits: t.lod * 2.0,
    });
    const hole = this.holeUniforms[t.lod] ?? { uHole: { value: new THREE.Vector4(0, 0, 0, 0) } };
    const uni: TerrainUniforms = {
      uHole: hole.uHole,
      uHasHole: { value: t.lod > 0 ? 1 : 0 },
      uOverlay: { value: this.emptyTex },
      uOverlayOpacity: { value: 0 },
      uTime: this.timeU,
      uSunDir: this.sunU,
      uSkyColor: this.skyU,
      uWaterColor: this.waterU,
      uNoise: { value: this.noiseTex },
    };
    (mat.userData as { uni: TerrainUniforms }).uni = uni;
    patchTerrainMaterial(mat, uni);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.matrixAutoUpdate = true; mesh.frustumCulled = true;
    t.mesh = mesh; this.placeMesh(t);
    this.group.add(mesh);
    if (t.tex) this.applyTexture(t);
    if (t.overlayTex) this.applyOverlay(t);
  }
  dispose() { this.tiles.forEach((t, k) => this.disposeTile(t, k)); this.scene.remove(this.group); this.emptyTex.dispose(); }
}
const mx_ = (lon: number) => (lon * Math.PI * R_MERC) / 180;
const my_ = (lat: number) => R_MERC * Math.log(Math.tan(Math.PI / 4 + (Math.max(-85.05, Math.min(85.05, lat)) * D2R) / 2));

/** Deprecated: DetailLayer is superseded by the unified Ring 0 (z13 65x65) terrain. Retained as a no-op stub for backward compatibility. */
export class DetailLayer {
  group = new THREE.Group();
  tiles = new Map<string, unknown>();
  z = 15;
  r = 3;
  styleId = DEFAULT_TILE_STYLE;
  constructor(public proj: Projection, public terrain: Terrain, scene: THREE.Scene) {
    scene.add(this.group);
  }
  setEnvironment(sky: THREE.Color, sunDir: THREE.Vector3) { void sky; void sunDir; }
  setStyle(id: string) { this.styleId = id; }
  clear() {}
  rebase(np: Projection) { this.proj = np; }
  refreshHeights() {}
  update(x: number, z: number, agl: number, time = 0, sunDir?: THREE.Vector3) {
    void x; void z; void agl; void time; void sunDir;
  }
}

