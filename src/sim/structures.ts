// Real-world 3D structures, 1:1 buildings, 3D tropical forests and highways around airports & cities.
// Powered by OpenFreeMap Cloudflare CDN (<80ms worldwide) vector tiles (.pbf) with zero rate limits,
// instant procedural fallback, architectural facade shader, terracotta roofs, and 2.5D map footprints.
import * as THREE from 'three';
import { GroundClear, airportClearZones, Rect, rectCorners, XZ } from './airportGround';
import { Airport } from '../data/airports';
import { Projection, lonToTileXf, latToTileYf, tileXToLon, tileYToLat } from './geo';
import { Terrain } from './terrain';
import { fetchMvtTile, areaM2, LL } from './mvt';
import { getTreeVariants, getGlbTreeTexture, TREE_MODEL_HEIGHT } from './treeModel';
import { asphaltTexture, groundDetailTexture } from './textures';
import { QualityPreset } from './storage';
import { QUALITY, QualityProfile } from './quality';

export interface Building {
  ring: LL[];
  height: number;
  /** Absent when the vector tile carries no `colour` tag (the common case). */
  color?: number;
  type?: string;
  area: number;
  minHeight?: number;
}

export interface MapFootprint {
  lat: number;
  lon: number;
  w: number;
  d: number;
  h: number;
  type: string;
  ring?: LL[];
  color?: number;
}

interface Area {
  buildings: Building[];
  water: { ring: LL[] }[];
  forests?: { ring: LL[] }[];
  roads?: { points: LL[]; highway: string; layer?: number; brunnel?: string }[];
  /** residential / commercial / industrial landuse, used to fill unmapped districts. */
  urban?: { ring: LL[]; type: string }[];
}

const ZOOM = 14;

const hash = (n: number) => {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
};

// ---- Procedural Urban & Vegetation Fallback ----
function generateProceduralArea(minLat: number, minLon: number, maxLat: number, maxLon: number, profile: QualityProfile): Area {
  const buildings: Building[] = [];
  const forests: { ring: LL[] }[] = [];
  const seed = Math.sin(minLat * 193.1 + minLon * 311.7) * 43758.5453;
  // Low/medium never extrude buildings. High gets a handful of larger blocks so a tile
  // does not look empty while the real MVT footprints are still in flight.
  const count = profile.buildings === 'all'
    ? 16 + Math.floor((Math.abs(seed) % 1) * 28)
    : profile.buildings === 'major'
      ? 6 + Math.floor((Math.abs(seed) % 1) * 8)
      : 0;
  const dLat = maxLat - minLat, dLon = maxLon - minLon;

  for (let i = 0; i < count; i++) {
    const s1 = hash(seed + i * 13.7), s2 = hash(seed + i * 29.3);
    const la0 = minLat + dLat * (0.08 + s1 * 0.84), lo0 = minLon + dLon * (0.08 + s2 * 0.84);
    const w = (10 + hash(s1 + i) * 16) / 111320;
    const l = (12 + hash(s2 + i) * 20) / 110574;
    const h = profile.buildings === 'major'
      ? 12 + hash(s1 * s2 + i) * 22
      : 4.2 + hash(s1 * s2 + i) * 14;
    const isCommercial = h > 10;
    const col = isCommercial ? 0xcbd5e1 : 0xd8c8b4;
    const ring: LL[] = [
      [la0, lo0],
      [la0 + l, lo0],
      [la0 + l, lo0 + w],
      [la0, lo0 + w],
    ];
    buildings.push({ ring, height: h, color: col, area: areaM2(ring) });
  }

  // Add 1-2 procedural green forest patches per tile
  for (let f = 0; f < 2; f++) {
    const fla = minLat + dLat * (0.2 + hash(seed + f * 41.3) * 0.6);
    const flo = minLon + dLon * (0.2 + hash(seed + f * 57.1) * 0.6);
    const fw = (40 + hash(seed + f * 9.1) * 60) / 111320;
    const fl = (40 + hash(seed + f * 17.3) * 60) / 110574;
    forests.push({
      ring: [
        [fla, flo],
        [fla + fl, flo],
        [fla + fl, flo + fw],
        [fla, flo + fw],
      ],
    });
  }

  return { buildings, water: [], forests };
}

// ---- Vegetation (100% Exclusive GLB 3D Tree Models: Tree 1 & Tree 2) --------------------------
const sharedGeos = new Set<THREE.BufferGeometry>();

/** Compressed 3D tree models from tree_low_poly_lowpoly.glb (Tree 1 & Tree 2 variants). */
let glbTreeGeos: [THREE.BufferGeometry, THREE.BufferGeometry] | null = null;
let glbTreeMat: THREE.MeshLambertMaterial | null = null;

function getGlbTreeGeometries(): [THREE.BufferGeometry, THREE.BufferGeometry] {
  if (glbTreeGeos) return glbTreeGeos;
  const variants = getTreeVariants();
  const build = (m: (typeof variants)[0]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
    g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    g.computeBoundingSphere();
    sharedGeos.add(g);
    return g;
  };
  glbTreeGeos = [build(variants[0]), build(variants[1])];
  return glbTreeGeos;
}

function getGlbTreeMaterial(): THREE.MeshLambertMaterial {
  if (glbTreeMat) return glbTreeMat;
  const tex = getGlbTreeTexture();
  glbTreeMat = tex
    ? new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.35, side: THREE.DoubleSide, vertexColors: true })
    : new THREE.MeshLambertMaterial({ color: 0x3b6e32, side: THREE.DoubleSide, vertexColors: true });
  return glbTreeMat;
}

/** Fewer draw calls and a stable look: classify before budgets so houses never eat a high-tier slot. */
interface BuildingClass {
  industrial: boolean;
  ruko: boolean;
  house: boolean;
}

function classifyBuilding(b: Building): BuildingClass {
  const type = (b.type || '').toLowerCase();
  const industrial =
    /^(industrial|warehouse|hangar|factory|manufacture|shed|garages|supermarket)/.test(type) ||
    (b.area > 520 && b.height < 14.5);
  const ruko =
    !industrial &&
    ((/^(commercial|retail|shop|shophouse)/.test(type) && b.height < 17) ||
      (b.height >= 7.4 && b.height < 15.5 && b.area >= 70 && b.area <= 440));
  const explicitlyHouse = /^(house|residential|home|living|dwelling|apartments?_small|detached|semidetached|terrace|bungalow|villa|hut|cabin|dormitory)/.test(type);
  // Any footprint that is not industrial or ruko, and is either explicitly residential,
  // has domestic height (<10.5m), or small domestic footprint (<220m2), is classified as a house.
  const house = !industrial && !ruko && (explicitlyHouse || b.height < 10.5 || b.area < 220);
  return { industrial, ruko, house };
}

interface VBuf {
  pos: number[];
  nor: number[];
  col: number[];
  uv: number[];
  isWall: number[];
  /** 0 = glass tower, 1 = render/plaster facade, 2 = dark ribbon facade (only read for walls). */
  style: number[];
  /** Per-building random 0..1: phase/width of the window grid so no two blocks repeat. */
  seed: number[];
}

type Vert5 = [number, number, number, number, number]; // x, y, z, u, v

/**
 * Emits one triangle, reordering its vertices so the geometric winding agrees with the supplied
 * normal. Footprints coming out of the vector tiles are not consistently wound in the projected
 * frame, and `ShapeUtils.triangulateShape` can return either orientation. three flips the shading
 * normal on back faces, so a mis-wound roof was shaded as if it faced the ground — which is why
 * every rooftop in the city rendered almost black instead of sunlit tile/metal.
 */
function pushTri(
  buf: VBuf,
  a: Vert5, b: Vert5, c: Vert5,
  n: [number, number, number],
  col: THREE.Color, kind: number, style: number, seed: number
) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
  const dot = gx * n[0] + gy * n[1] + gz * n[2];
  const verts: Vert5[] = dot >= 0 ? [a, b, c] : [a, c, b];
  for (const [x, y, z, u, v] of verts) {
    buf.pos.push(x, y, z);
    buf.nor.push(n[0], n[1], n[2]);
    buf.col.push(col.r, col.g, col.b);
    buf.uv.push(u, v);
    buf.isWall.push(kind);
    buf.style.push(style);
    buf.seed.push(seed);
  }
}

function addRoof(buf: VBuf, contour: THREE.Vector2[], y: number, c: THREE.Color, isRoof = true, roofStyle = 0) {
  if (contour.length < 3) return;
  try {
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const tri of tris) {
      const p = contour[tri[0]], q = contour[tri[1]], r = contour[tri[2]];
      pushTri(buf,
        [p.x, y, p.y, p.x * 0.25, p.y * 0.25],
        [q.x, y, q.y, q.x * 0.25, q.y * 0.25],
        [r.x, y, r.y, r.x * 0.25, r.y * 0.25],
        [0, 1, 0], c, isRoof ? 0 : -1, roofStyle, 0);
    }
  } catch {
    // degenerate or self-intersecting polygon safely skipped
  }
}

/** Sign of the ring's shoelace area in world (x, z) space; +1 for an MVT exterior ring. */
function ringSign(c: THREE.Vector2[]): number {
  let a = 0;
  for (let i = 0; i < c.length; i++) {
    const p = c[i], q = c[(i + 1) % c.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a >= 0 ? 1 : -1;
}

/**
 * Grows a footprint outward by `d` metres (mitered, clamped). Used for roof eaves and parapet
 * lips: from the air the thin overhang shadow line is what separates a house from a painted patch
 * on the ground, which is why flat-topped extrusions read as 2D.
 */
function offsetRing(c: THREE.Vector2[], d: number): THREE.Vector2[] {
  const n = c.length;
  if (n < 3) return c;
  const sgn = ringSign(c);
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const p = c[(i - 1 + n) % n], q = c[i], r = c[(i + 1) % n];
    const e0x = q.x - p.x, e0y = q.y - p.y, l0 = Math.hypot(e0x, e0y) || 1;
    const e1x = r.x - q.x, e1y = r.y - q.y, l1 = Math.hypot(e1x, e1y) || 1;
    const n0x = (sgn * e0y) / l0, n0y = (-sgn * e0x) / l0;
    const n1x = (sgn * e1y) / l1, n1y = (-sgn * e1x) / l1;
    let mx = n0x + n1x, my = n0y + n1y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-4) { mx = n0x; my = n0y; } else { mx /= ml; my /= ml; }
    const cosHalf = Math.max(0.42, mx * n0x + my * n0y);
    out.push(new THREE.Vector2(q.x + (mx * d) / cosHalf, q.y + (my * d) / cosHalf));
  }
  return out;
}

/**
 * True when every turn around the ring has the same sign. Sloped roofs are built by fanning edges
 * to a centroid, which only stays watertight on convex footprints; L-shaped plans keep a flat roof.
 */
function isConvexRing(c: THREE.Vector2[]): boolean {
  let sign = 0;
  for (let i = 0; i < c.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length], d = c[(i + 2) % c.length];
    const cross = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
    if (Math.abs(cross) < 1e-6) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function addWalls(buf: VBuf, contour: THREE.Vector2[], base: number, top: number, c: THREE.Color, kind = 1, style = 0, seed = 0) {
  let s = 0;
  const sgn = ringSign(contour);
  for (let i = 0; i < contour.length; i++) {
    const p = contour[i], q = contour[(i + 1) % contour.length];
    const dx = q.x - p.x, dz = q.y - p.y;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    const nx = (sgn * dz) / len, nz = (-sgn * dx) / len;
    const s0 = s, s1 = s + len;
    s = s1;
    const h = top - base;
    const n: [number, number, number] = [nx, 0, nz];
    pushTri(buf, [p.x, base, p.y, s0, 0], [q.x, top, q.y, s1, h], [q.x, base, q.y, s1, 0], n, c, kind, style, seed);
    pushTri(buf, [p.x, base, p.y, s0, 0], [p.x, top, p.y, s0, h], [q.x, top, q.y, s1, h], n, c, kind, style, seed);
  }
}

/**
 * Sloped roof (hip/pyramid) over a footprint: every wall edge rises to an apex above the centroid,
 * with per-face normals so the sun really lights one slope and shades the other. This is what makes
 * Indonesian low-rise roofs read as tiles rather than as flat painted plates.
 */
function addSlopedRoof(buf: VBuf, contour: THREE.Vector2[], baseY: number, rise: number, c: THREE.Color, roofStyle = 1) {
  if (contour.length < 3 || rise <= 0.15) return;
  let cx = 0, cz = 0;
  for (const p of contour) { cx += p.x; cz += p.y; }
  cx /= contour.length; cz /= contour.length;
  const apexY = baseY + rise;
  const tri = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, px: number, py: number, pz: number) => {
    // face normal from the winding, so each slope is shaded independently
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = px - ax, vy = py - ay, vz = pz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; } // always point upward
    const edgeLen = Math.hypot(ux, uz);
    const slopeLen = Math.hypot(px - (ax + bx) * 0.5, py - ay, pz - (az + bz) * 0.5);
    pushTri(buf,
      [ax, ay, az, 0, 0],
      [bx, by, bz, edgeLen, 0],
      [px, py, pz, edgeLen * 0.5, slopeLen],
      [nx, ny, nz], c, 0, roofStyle, 0);
  };
  const n = contour.length;
  for (let i = 0; i < n; i++) {
    const p = contour[i], q = contour[(i + 1) % n];
    tri(p.x, baseY, p.y, q.x, baseY, q.y, cx, apexY, cz);
  }
}

/**
 * Deterministic facade palette for buildings whose tile carries no `colour` tag (most of them).
 * Dense tropical cities mix whitewashed concrete, cream, sandstone and the occasional painted
 * wall; without this every building renders as the same beige box.
 */
const FACADE_PALETTE = [
  0xece7dc, 0xe3dccd, 0xd8d3c6, 0xcfd3d1, 0xe6dfd0,
  0xd9cdb6, 0xcbd3d7, 0xd2c9bd, 0xe0d5c4, 0xc9cfc8,
];

function facadeColor(seed: number): number {
  return FACADE_PALETTE[Math.floor(hash(seed) * FACADE_PALETTE.length) % FACADE_PALETTE.length];
}

/** Fired-clay roof tiles: the dominant colour of Indonesian low-rise housing stock. */
const ROOF_TILE = [0x9c4a33, 0xa4543c, 0x8d402c, 0xad6044, 0xa05539];
/** Galvalume sheeting, asbestos-cement and bare concrete: the majority of real roofs. */
const ROOF_METAL = [0x8d949b, 0x767d84, 0xa4abb1, 0x676e74, 0x98a0a6, 0x828a90, 0xb2b8bd];
/**
 * Flat roofs of commercial blocks: weathered concrete and bitumen membrane. These used to reuse
 * the facade colour (× 0.92), so every warehouse and office block had a near-white roof and the
 * city read as a field of paper cut-outs from the air.
 */
const ROOF_COMMERCIAL = [0x6f757a, 0x5d6367, 0x7d8388, 0x555b60, 0x878d92, 0x686f74];

function contourOf(proj: Projection, ring: LL[]): THREE.Vector2[] {
  const contour: THREE.Vector2[] = [];
  for (const [la, lo] of ring) {
    const p = new THREE.Vector2(proj.x(lo), proj.z(la));
    const prev = contour[contour.length - 1];
    if (!prev || prev.distanceToSquared(p) > 1e-4) contour.push(p);
  }
  if (contour.length > 2 && contour[0].distanceToSquared(contour[contour.length - 1]) < 1e-4) contour.pop();
  return contour;
}

function isPointInPoly(px: number, py: number, poly: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

type BuildingUniforms = { uSunset: { value: number }; uNoise: { value: THREE.Texture } };

function patchBuildingShader(mat: THREE.MeshLambertMaterial, uniforms: BuildingUniforms) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSunset = uniforms.uSunset;
    sh.uniforms.uNoise = uniforms.uNoise;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aBuildingUv;
        attribute float aIsWall;
        attribute float aStyle;
        attribute float aSeed;
        varying vec2 vBUv;
        varying float vWall;
        varying float vStyle;
        varying float vSeed;
        varying vec3 vBWPos;
        varying vec3 vBWNormal;
      `)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vBUv = aBuildingUv;
        vWall = aIsWall;
        vStyle = aStyle;
        vSeed = aSeed;
        vBWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vBWNormal = normal;
      `);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vBUv;
        varying float vWall;
        varying float vStyle;
        varying float vSeed;
        varying vec3 vBWPos;
        varying vec3 vBWNormal;
        uniform float uSunset;
        uniform sampler2D uNoise;
        float bHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
      `)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // aIsWall:
        //   4 = industrial / warehouse corrugated cladding
        //   3 = parapet / fascia / rooftop HVAC
        //   2 = landed house (residential masonry + domestic windows/doors)
        //   1 = multi-storey facade (vStyle: 0=glass tower, 1=punched apartment, 2=ribbon office, 3=ruko shophouse)
        //   0 = roof (vStyle: 1=pitched clay tile / corrugated sheet, 0=flat concrete membrane)
        //  -1 = water
        vec3 wN = normalize(vBWNormal);
        vec3 toCam = normalize(cameraPosition - vBWPos);
        float fres = pow(1.0 - clamp(abs(dot(wN, toCam)), 0.0, 1.0), 3.0);
        vec3 skyRefl = mix(vec3(0.46, 0.62, 0.80), vec3(0.92, 0.58, 0.36), uSunset);
        float baseAO = mix(0.72, 1.0, smoothstep(0.0, 7.0, vBUv.y));
        float pxW = max(1.0, length(cameraPosition - vBWPos)) * 0.0017;

        if (vWall > 3.5) {
          // ---- Tipologi Gudang / Pabrik / Hanggar (Industrial Cladding) ---------------------
          float ribFade = 1.0 - smoothstep(0.18, 0.65, pxW);
          float rib = sin(vBUv.x * 8.5) * 0.065 * ribFade;
          float seam = (1.0 - smoothstep(0.0, 0.08, abs(mod(vBUv.y, 2.4) - 1.2))) * 0.06 * ribFade;
          // Loading bay roller doors every ~14 m along the ground floor
          float bayX = mod(vBUv.x + vSeed * 9.0, 14.0);
          float inDoor = step(4.5, bayX) * step(bayX, 9.5) * step(vBUv.y, 4.0);
          float doorRib = sin(vBUv.y * 14.0) * 0.05 * ribFade;
          vec3 clad = diffuseColor.rgb * (0.94 + rib - seam);
          // Concrete dado wall at base (0..1.3 m)
          clad = mix(clad * 0.76, clad, smoothstep(1.1, 1.4, vBUv.y));
          vec3 doorCol = vec3(0.24, 0.27, 0.30) + vec3(doorRib);
          diffuseColor.rgb = mix(clad, doorCol, inDoor * ribFade) * baseAO;
        } else if (vWall > 2.5) {
          // Parapet band / rooftop plant: plain painted concrete.
          float g = texture2D(uNoise, vBWPos.xz * 0.10).b;
          diffuseColor.rgb *= 0.86 + g * 0.14;
        } else if (vWall > 1.5) {
          // ---- Tipologi Rumah Tapak / Kampung (Landed House with Windows & Doors) -----------
          float grain = texture2D(uNoise, vec2(vBUv.x * 0.30, vBUv.y * 0.18)).b;
          float streak = texture2D(uNoise, vec2(vBUv.x * 0.045, vBUv.y * 0.012)).g;
          vec3 wall = diffuseColor.rgb * (0.93 + grain * 0.12) * (0.95 + streak * 0.10);
          // Dark masonry plinth at the bottom 0.55 m
          wall *= mix(0.66, 1.0, smoothstep(0.0, 0.65, vBUv.y));
          // Domestic window & door openings every ~3.4 m bay
          float bay = 3.4;
          float floorH = 3.0;
          float detFade = 1.0 - smoothstep(0.28, 0.85, pxW / bay);
          if (detFade > 0.01) {
            float gx = mod(vBUv.x + vSeed * 7.0, bay);
            float gy = mod(vBUv.y, floorH);
            float bayIdx = floor((vBUv.x + vSeed * 7.0) / bay);
            float isDoorBay = step(0.68, bHash(vec2(bayIdx, vSeed * 19.0))) * step(vBUv.y, 2.35);
            // Wooden door on ground floor vs casement window
            float doorMask = isDoorBay * smoothstep(0.32 * bay, 0.36 * bay, gx) * (1.0 - smoothstep(0.64 * bay, 0.68 * bay, gx)) * step(vBUv.y, 2.15);
            float winX = smoothstep(0.24 * bay, 0.28 * bay, gx) * (1.0 - smoothstep(0.72 * bay, 0.76 * bay, gx));
            float winY = smoothstep(0.30 * floorH, 0.35 * floorH, gy) * (1.0 - smoothstep(0.72 * floorH, 0.77 * floorH, gy));
            float winMask = (1.0 - isDoorBay) * winX * winY;
            vec3 glass = mix(vec3(0.10, 0.14, 0.17), skyRefl, 0.25 + fres * 0.45);
            float lit = bHash(vec2(bayIdx, floor(vBUv.y / floorH)) + vSeed * 31.0);
            glass = mix(glass, vec3(1.0, 0.84, 0.52), uSunset * step(0.58, lit) * 0.85);
            vec3 woodDoor = vec3(0.28, 0.18, 0.11);
            wall = mix(wall, glass, winMask * detFade * 0.88);
            wall = mix(wall, woodDoor, doorMask * detFade * 0.90);
          }
          diffuseColor.rgb = wall * mix(0.74, 1.0, smoothstep(0.0, 2.5, vBUv.y));
        } else if (vWall > 0.5) {
          // Window grids are a sub-pixel pattern past ~500 m, and unlike a texture they have no mip
          // chain to prefilter them: fade to the analytically averaged colour as the grid approaches
          // the pixel size, so distant blocks stay smooth and correctly toned.
          if (vStyle < 0.5) {
            // ---- 0: curtain-wall glass tower -------------------------------------------------
            float bay = mix(1.65, 2.75, vSeed);
            float floorH = mix(3.5, 4.3, fract(vSeed * 7.13));
            float gx = mod(vBUv.x + vSeed * 11.0, bay);
            float gy = mod(vBUv.y, floorH);
            float mull = max(1.0 - smoothstep(0.05, 0.13, min(gx, bay - gx)),
                             1.0 - smoothstep(0.10, 0.22, min(gy, floorH - gy)));
            float spandrel = 1.0 - smoothstep(0.12, 0.34, min(gy, floorH - gy));
            vec3 glass = mix(vec3(0.055, 0.105, 0.13), skyRefl, 0.28 + fres * 0.60);
            glass += vec3(0.03, 0.05, 0.05) * (1.0 - gy / floorH);
            vec3 spandrelCol = vec3(0.58, 0.59, 0.58) * mix(0.92, 0.62, uSunset);
            vec3 c = mix(glass, spandrelCol, spandrel * 0.75);
            c = mix(vec3(0.16, 0.17, 0.18), c, mull);
            float litRnd = bHash(floor(vec2(vBUv.x / bay, vBUv.y / floorH)) + vSeed * 37.0);
            c = mix(c, vec3(1.0, 0.86, 0.58) * (0.45 + 0.55 * litRnd),
                    uSunset * step(0.70, litRnd) * (1.0 - mull) * 0.9);
            vec3 avg = mix(glass, spandrelCol, 0.38);
            diffuseColor.rgb = mix(avg, c, 1.0 - smoothstep(0.35, 1.1, pxW / bay)) * baseAO;
          } else if (vStyle < 1.5) {
            // ---- 1: plastered concrete with punched windows ----------------------------------
            float bay = mix(2.2, 3.3, vSeed);
            float floorH = mix(2.9, 3.7, fract(vSeed * 5.71));
            float gx = mod(vBUv.x + vSeed * 5.0, bay);
            float gy = mod(vBUv.y, floorH);
            float wx = smoothstep(0.20 * bay, 0.24 * bay, gx) * (1.0 - smoothstep(0.76 * bay, 0.80 * bay, gx));
            float wy = smoothstep(0.24 * floorH, 0.28 * floorH, gy) * (1.0 - smoothstep(0.70 * floorH, 0.74 * floorH, gy));
            float win = wx * wy;
            vec3 glass = mix(vec3(0.085, 0.125, 0.16), skyRefl, 0.22 + fres * 0.55);
            float litRnd = bHash(floor(vec2(vBUv.x / bay, vBUv.y / floorH)) + vSeed * 17.0);
            glass = mix(glass, vec3(1.0, 0.82, 0.50), uSunset * step(0.62, litRnd) * 0.85);
            vec3 wall = diffuseColor.rgb * (0.95 + texture2D(uNoise, vec2(vBUv.x * 0.32, vBUv.y * 0.26)).b * 0.10);
            float sill = (1.0 - smoothstep(0.0, 0.10, abs(gy - 0.24 * floorH))) * wx;
            vec3 pat = mix(wall, glass, win) + vec3(0.10, 0.095, 0.085) * sill;
            vec3 avg = mix(wall, glass, 0.34);
            diffuseColor.rgb = mix(avg, pat, 1.0 - smoothstep(0.30, 0.95, pxW / bay)) * baseAO;
          } else if (vStyle < 2.5) {
            // ---- 2: dark grey ribbon glazing between concrete bands --------------------------
            float bay = 1.55;
            float floorH = mix(3.15, 3.85, vSeed);
            float gy = mod(vBUv.y, floorH);
            float ribbon = smoothstep(0.18 * floorH, 0.24 * floorH, gy) * (1.0 - smoothstep(0.76 * floorH, 0.82 * floorH, gy));
            float mull = 1.0 - smoothstep(0.05, 0.11, abs(mod(vBUv.x + vSeed * 3.3, bay) - bay * 0.5));
            vec3 body = diffuseColor.rgb * 0.86 * (0.94 + texture2D(uNoise, vBWPos.xz * 0.15).b * 0.10);
            vec3 glass = mix(vec3(0.10, 0.13, 0.16), skyRefl, 0.30 + fres * 0.55);
            float litRnd = bHash(floor(vec2(vBUv.x / bay, vBUv.y / floorH)) + vSeed * 23.0);
            glass = mix(glass, vec3(0.95, 0.80, 0.50), uSunset * step(0.72, litRnd) * 0.75);
            vec3 pat = mix(body, glass, ribbon * (1.0 - mull * 0.88));
            vec3 avg = mix(body, glass, 0.40);
            diffuseColor.rgb = mix(avg, pat, 1.0 - smoothstep(0.30, 0.95, pxW / bay)) * baseAO;
          } else {
            // ---- 3: Tipologi Ruko / Shophouse (2-4 storeys, ground-floor rolling door) -------
            float bay = 4.2;
            float floorH = 3.3;
            float gx = mod(vBUv.x + vSeed * 6.0, bay);
            float gy = mod(vBUv.y, floorH);
            float unitId = floor((vBUv.x + vSeed * 6.0) / bay);
            vec3 wall = diffuseColor.rgb * (0.94 + texture2D(uNoise, vec2(vBUv.x * 0.25, vBUv.y * 0.25)).b * 0.10);
            // Party-wall pilaster between ruko units
            float pilaster = 1.0 - smoothstep(0.14, 0.22, min(gx, bay - gx));
            vec3 pat = wall * (1.0 - pilaster * 0.08);
            if (vBUv.y < 3.45) {
              // Ground-floor rolling door / storefront + shop signboard band
              float inRoll = smoothstep(0.12 * bay, 0.16 * bay, gx) * (1.0 - smoothstep(0.84 * bay, 0.88 * bay, gx)) * step(vBUv.y, 2.85);
              float slats = sin(vBUv.y * 22.0) * 0.04;
              vec3 rollCol = vec3(0.30, 0.33, 0.36) + vec3(slats);
              float signBand = smoothstep(2.85, 2.92, vBUv.y) * (1.0 - smoothstep(3.35, 3.42, vBUv.y)) * (1.0 - pilaster);
              float sHue = bHash(vec2(unitId, vSeed * 13.0));
              vec3 signCol = sHue < 0.33 ? vec3(0.72, 0.18, 0.16) : sHue < 0.66 ? vec3(0.14, 0.36, 0.68) : vec3(0.16, 0.54, 0.32);
              pat = mix(pat, rollCol, inRoll);
              pat = mix(pat, signCol, signBand * 0.85);
            } else {
              // Upper-storey ruko twin windows
              float wx = smoothstep(0.18 * bay, 0.22 * bay, gx) * (1.0 - smoothstep(0.78 * bay, 0.82 * bay, gx));
              float wy = smoothstep(0.24 * floorH, 0.28 * floorH, gy) * (1.0 - smoothstep(0.72 * floorH, 0.76 * floorH, gy));
              vec3 glass = mix(vec3(0.09, 0.13, 0.16), skyRefl, 0.24 + fres * 0.50);
              float litRnd = bHash(vec2(unitId, floor(vBUv.y / floorH)) + vSeed * 19.0);
              glass = mix(glass, vec3(1.0, 0.84, 0.52), uSunset * step(0.65, litRnd) * 0.80);
              pat = mix(pat, glass, wx * wy);
            }
            vec3 avg = mix(wall, vec3(0.22, 0.25, 0.28), 0.28);
            diffuseColor.rgb = mix(avg, pat, 1.0 - smoothstep(0.30, 0.95, pxW / bay)) * baseAO;
          }
        } else if (vWall > -0.5) {
          // Rooftops: 1:1 satellite-sampled base colour modulated by tile/corrugation micro-relief
          float coarse = texture2D(uNoise, vBWPos.xz * 0.030).g;
          float fine = texture2D(uNoise, vBWPos.xz * 0.28).b;
          float modShade = 0.90 + coarse * 0.14 + fine * 0.06;
          if (vStyle > 0.5) {
            // Pitched clay-tile or corrugated metal roof ribs (band-limited so they never alias)
            float ribFade = 1.0 - smoothstep(0.12, 0.48, pxW);
            float tileRib = sin(vBUv.x * 16.0) * 0.045 + sin(vBUv.y * 9.5) * 0.035;
            modShade += tileRib * ribFade;
          }
          diffuseColor.rgb *= modShade;
        }
      `);
  };
  mat.customProgramCacheKey = () => 'building-facade-shader-v5';
}

function makeMesh(buf: VBuf, mat: THREE.Material): THREE.Mesh | null {
  if (!buf.pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nor, 3));
  // Colours are quantised to 8 bit and uploaded normalised: identical on screen, 9 bytes/vertex smaller
  // (a dense z14 tile holds >100k vertices, so this is tens of MB of VRAM per tile ring).
  const col = new Uint8Array(buf.col.length);
  for (let i = 0; i < buf.col.length; i++) col[i] = Math.max(0, Math.min(255, Math.round(buf.col[i] * 255)));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
  geo.setAttribute('aBuildingUv', new THREE.Float32BufferAttribute(buf.uv, 2));
  geo.setAttribute('aIsWall', new THREE.Float32BufferAttribute(buf.isWall, 1));
  geo.setAttribute('aStyle', new THREE.Float32BufferAttribute(buf.style, 1));
  geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(buf.seed, 1));
  geo.computeBoundingSphere();
  return new THREE.Mesh(geo, mat);
}

function disposeGroup(group: THREE.Group) {
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    // shared tree geometries/materials outlive individual tiles
    if (mesh.geometry && !sharedGeos.has(mesh.geometry)) mesh.geometry.dispose();
  });
}

/** Per-tile material clones so a tile can fade in/out (anti pop-in) without touching other tiles.
 *  The clones share the same shader program (patchBuildingShader re-applies the same cache key). */
interface TileMats { solid: THREE.MeshLambertMaterial; water: THREE.MeshPhongMaterial; tree: THREE.MeshLambertMaterial | null }

/** Dispose the per-tile material clones (the originals on the Structures instance outlive them). */
function disposeTileMats(mats: TileMats) { mats.solid.dispose(); mats.water.dispose(); if (mats.tree) mats.tree.dispose(); }

interface TileEntry {
  key: string;
  group: THREE.Group;
  area: Area;
  isProcedural: boolean;
  lights: THREE.InstancedMesh | null;
  lastSeen?: number;
  /** 0..1 opacity of this tile's meshes: fades in when streamed, out at the AGL gate / prune. */
  fade: number;
  fadeTgt: number;
  mats: TileMats;
}

interface BuiltTile {
  group: THREE.Group;
  lights: THREE.InstancedMesh | null;
  mats: TileMats;
}

/**
 * Per-tile geometry budgets. A single z14 tile in a dense Indonesian city can carry 20-30k building
 * polygons; extruding every one of them produced 6.8M vertices / ~300MB of attributes for a 3x3 ring
 * and blocked the main thread for seconds. Buildings are therefore ranked by distance and split into
 * full-detail (walls + roof + rooftop plant) and roof-only (aerial silhouette) tiers.
 */
const NEAR_FULL_M = 1900;      // full facade detail inside this radius
const FAR_VISIBLE_M = 6500;    // beyond this a building is a speck: drop it
const TALL_ALWAYS_H = 36;      // landmark height that keeps full detail regardless of distance
// Above this AGL the 3x3 ring no longer covers the visible city, so a second, roof-only ring is
// streamed around it. Without that the 3D blocks ended on a dead-straight tile boundary in the
// middle of the urban area, which is far more noticeable than the buildings themselves.
const OUTER_RING_AGL = 1100;

// ---- roads -------------------------------------------------------------------------------------
// The previous road mesh was one independent quad per OSM segment: consecutive quads met at a
// wedge-shaped notch (so bends read as broken/chopped) and every crossing drew two coplanar
// surfaces on the same Y (so they z-fought). What follows builds one continuous, mitered,
// terrain-draped ribbon per way, and paints the asphalt + lane markings procedurally.

interface RoadBuf {
  pos: number[];
  nor: number[];
  uv: number[];
  cls: number[];
  wid: number[];
}

function roadWidth(hw: string): number {
  if (/motorway|trunk/.test(hw)) return 11.5;
  if (/primary/.test(hw)) return 8.2;
  if (/secondary/.test(hw)) return 7.0;
  return 5.6;
}

function roadClass(hw: string): number {
  if (/motorway|trunk/.test(hw)) return 0;
  if (/primary|secondary/.test(hw)) return 1;
  return 2;
}

function addRoadRibbon(
  out: RoadBuf,
  pts: THREE.Vector2[],
  width: number,
  cls: number,
  heightAt: (x: number, z: number) => number,
  elev = 0
) {
  if (pts.length < 2) return;
  const lift = 0.32 + (2 - cls) * 0.03;
  const halfW = width / 2;

  // 1. Resample: keep every OSM bend (they define the miter angles), but add mid-segment samples
  //    so a long straight following a ridge is draped on the DEM instead of tunnelling through it.
  const px: number[] = [], pz: number[] = [], py: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = a.distanceTo(b);
    if (len < 0.25) continue;
    const steps = Math.min(96, Math.max(1, Math.ceil(len / 26)));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t, z = a.y + (b.y - a.y) * t;
      px.push(x); pz.push(z); py.push(heightAt(x, z) + lift);
    }
  }
  const tail = pts[pts.length - 1];
  px.push(tail.x); pz.push(tail.y); py.push(heightAt(tail.x, tail.y) + lift);
  const n = px.length;
  if (n < 2) return;
  if (Math.abs(px[n - 1] - px[n - 2]) < 0.1 && Math.abs(pz[n - 1] - pz[n - 2]) < 0.1) {
    px.pop(); pz.pop(); py.pop();
  }
  const m = px.length;
  if (m < 2) return;

  // 2. Miter offset at every vertex, clamped so a hairpin cannot shoot a spike across the block.
  const lx = new Float64Array(m), lz = new Float64Array(m), rx = new Float64Array(m), rz = new Float64Array(m);
  const ly = new Float64Array(m), ry = new Float64Array(m), along = new Float64Array(m);
  let acc = 0;
  for (let i = 0; i < m; i++) {
    const p0x = px[i], p0z = pz[i];
    let d0x = p0x - px[Math.max(0, i - 1)], d0z = p0z - pz[Math.max(0, i - 1)];
    let d1x = px[Math.min(m - 1, i + 1)] - p0x, d1z = pz[Math.min(m - 1, i + 1)] - p0z;
    let l0 = Math.hypot(d0x, d0z), l1 = Math.hypot(d1x, d1z);
    if (l0 < 1e-4) { d0x = d1x; d0z = d1z; l0 = l1; }
    if (l1 < 1e-4) { d1x = d0x; d1z = d0z; l1 = l0; }
    if (l0 < 1e-4) { lx[i] = p0x; lz[i] = p0z; rx[i] = p0x; rz[i] = p0z; ly[i] = ry[i] = py[i]; along[i] = acc; continue; }
    d0x /= l0; d0z /= l0; d1x /= l1; d1z /= l1;
    const n0x = -d0z, n0z = d0x, n1x = -d1z, n1z = d1x;
    let mx = n0x + n1x, mz = n0z + n1z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-4) { mx = n0x; mz = n0z; } else { mx /= ml; mz /= ml; }
    const cosHalf = Math.max(0.40, mx * n0x + mz * n0z);
    const off = halfW / cosHalf;
    lx[i] = p0x + mx * off; lz[i] = p0z + mz * off;
    rx[i] = p0x - mx * off; rz[i] = p0z - mz * off;
    ly[i] = Math.max(py[i], heightAt(lx[i], lz[i]) + lift);
    ry[i] = Math.max(py[i], heightAt(rx[i], rz[i]) + lift);
    if (i > 0) acc += Math.hypot(px[i] - px[i - 1], pz[i] - pz[i - 1]);
    along[i] = acc;
  }

  // Flyovers / stacked ramps: raise the whole way by `elev`, but ramp into it over ~90 m at each
  // end so the deck does not end in a vertical step where the OSM bridge way stops.
  if (elev > 0.05 && m > 1) {
    const total = along[m - 1];
    for (let i = 0; i < m; i++) {
      const ramp = Math.min(1, along[i] / 90, (total - along[i]) / 90);
      if (ramp > 0) { ly[i] += elev * ramp; ry[i] += elev * ramp; }
    }
  }

  // 3. Triangles, wound so the geometric normal points up (FrontSide material, no back-face fill).
  // Pack bridge flag (+10) into cls so surface roads can feather their shoulders into 1:1 satellite
  // imagery while elevated bridges/flyovers keep a solid concrete deck edge.
  const clsPacked = cls + (elev > 0.2 ? 10 : 0);
  const tri = (
    a: [number, number, number, number, number],
    b: [number, number, number, number, number],
    c: [number, number, number, number, number]
  ) => {
    const up = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const verts = up >= 0 ? [a, b, c] : [a, c, b];
    for (const [x, y, z, u, v] of verts) {
      out.pos.push(x, y, z);
      out.nor.push(0, 1, 0);
      out.uv.push(u, v);
      out.cls.push(clsPacked);
      out.wid.push(width);
    }
  };

  for (let i = 0; i < m - 1; i++) {
    const aL: [number, number, number, number, number] = [lx[i], ly[i], lz[i], 0, along[i]];
    const aR: [number, number, number, number, number] = [rx[i], ry[i], rz[i], 1, along[i]];
    const bL: [number, number, number, number, number] = [lx[i + 1], ly[i + 1], lz[i + 1], 0, along[i + 1]];
    const bR: [number, number, number, number, number] = [rx[i + 1], ry[i + 1], rz[i + 1], 1, along[i + 1]];
    tri(aL, aR, bL);
    tri(aR, bR, bL);
  }
}

type RoadUniforms = { uAsphalt: { value: THREE.Texture | null } };

function patchRoadShader(mat: THREE.MeshLambertMaterial, uniforms: RoadUniforms) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uAsphalt = uniforms.uAsphalt;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aRoadUv;
        attribute float aRoadWidth;
        attribute float aRoadClass;
        varying vec2 vRoadUv;
        varying float vRoadW;
        varying float vRoadC;
        varying vec3 vRoadPos;
      `)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vRoadUv = aRoadUv;
        vRoadW = aRoadWidth;
        vRoadC = aRoadClass;
        vRoadPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vRoadUv;
        varying float vRoadW;
        varying float vRoadC;
        varying vec3 vRoadPos;
        uniform sampler2D uAsphalt;
      `)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float laneU = clamp(vRoadUv.x, 0.0, 1.0);
        float along = vRoadUv.y;
        float isBridge = step(5.0, vRoadC);
        float rClass = mod(vRoadC, 10.0);

        // Dark asphalt with aggregate grain. One texture repeat ≈ 5 m, so it mips to a flat,
        // believable tarmac from altitude instead of sparkling.
        float grain = texture2D(uAsphalt, vec2(laneU * vRoadW * 0.40, along * 0.20)).r;
        vec3 tarmac = vec3(0.105, 0.111, 0.118) * (0.72 + grain * 0.55);

        // polished wheel tracks and grimy shoulders
        float tracks = smoothstep(0.16, 0.03, abs(laneU - 0.31)) + smoothstep(0.16, 0.03, abs(laneU - 0.69));
        tarmac *= 1.0 - tracks * 0.055;
        tarmac *= mix(0.80, 1.0, smoothstep(0.0, 0.09, min(laneU, 1.0 - laneU)));

        // ---- painted markings ------------------------------------------------------------------
        float camDist = length(cameraPosition - vRoadPos);
        float px = max(1.0, camDist) * 0.0017;           // metres covered by one pixel
        float halfW = max(0.5, vRoadW * 0.5);
        float wLine = 0.075 / halfW;                     // true half width, in across-road units
        float aa = max(wLine * 0.55, px / halfW);        // antialiasing footprint
        float ha = max(wLine, aa * 0.5);
        float cover = clamp((wLine / max(aa, 1e-5)) * 1.6, 0.0, 1.0);
        float markFade = 1.0 - smoothstep(0.45, 1.15, px);
        float edgeLine = (1.0 - smoothstep(ha - aa * 0.5, ha + aa * 0.5, abs(laneU - 0.075)))
                       + (1.0 - smoothstep(ha - aa * 0.5, ha + aa * 0.5, abs(laneU - 0.925)));
        float dash = step(fract(along / 12.0), 0.45);
        float wc = wLine * 0.85;
        float hc = max(wc, aa * 0.5);
        float centreLine = (1.0 - smoothstep(hc - aa * 0.5, hc + aa * 0.5, abs(laneU - 0.5))) * dash;
        float paint = clamp(edgeLine + centreLine, 0.0, 1.0) * step(rClass, 1.5) * markFade * cover;
        diffuseColor.rgb = mix(tarmac, vec3(0.62, 0.61, 0.57), paint * 0.9);
        // Soft-shoulder blending: surface roads feather into the 1:1 satellite texture at their edges,
        // while elevated flyovers/bridges remain 100% solid.
        float shoulder = smoothstep(0.0, 0.16, min(laneU, 1.0 - laneU));
        diffuseColor.a = mix(shoulder * 0.86, 1.0, isBridge);
      `);
  };
  mat.customProgramCacheKey = () => 'road-asphalt-v2';
}

const _structBox = new THREE.Box3();
const _sMin = new THREE.Vector3();
const _sMax = new THREE.Vector3();

interface TileBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface TreeSpawn { x: number; y: number; z: number; d2: number; veg: number }

/** Time-sliced tree scatter: scanning a whole tile in one frame caused 100–250 ms hitches. */
interface TreeJob {
  key: string;
  group: THREE.Group;
  occ: Uint8Array;
  bounds: TileBounds;
  focusX: number;
  focusZ: number;
  outer: boolean;
  gridN: number;
  cellW: number;
  cellD: number;
  maxR2: number;
  row: number;
  spawned: TreeSpawn[];
  boundingSphere: THREE.Sphere;
}

interface RunwayZone {
  ax: number;
  az: number;
  dx: number;
  dz: number;
  invL2: number;
  rSq: number;
}

export class Structures {
  group = new THREE.Group();
  private tiles = new Map<string, TileEntry>();
  private requested = new Set<string>();
  private uniforms = { uSunset: { value: 0 } };
  private uniformsNoise: { uNoise: { value: THREE.Texture } };
  private solidMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  // Water polygons (rivers, canals, lakes).
  private waterMat = new THREE.MeshPhongMaterial({
    vertexColors: true,
    specular: 0x1c313a,
    shininess: 24,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  // Roads are drawn slightly above the terrain *and* with a polygon offset, with soft-shoulder transparency.
  private roadMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  private roadUniforms = { uAsphalt: { value: null as THREE.Texture | null } };
  private lightMat = new THREE.MeshBasicMaterial({ color: 0xffb84d });
  private poleMat = new THREE.MeshLambertMaterial({ color: 0x3b3f44 });
  /** Aircraft position used to rank building detail (world metres). */
  private focus = { x: 0, z: 0 };
  private activeAirports: Airport[] = [];
  private runwayZones: RunwayZone[] = [];
  /** Taxiways, aprons, hangars, terminals: no woodland or procedural houses on the airfield. */
  private groundClear = new GroundClear();
  /** The parked aircraft's footprint: neither trees nor mapped buildings may overlap it. */
  private spawnClear = new GroundClear(); private spawnKey = '';
  /** Decoded MVT areas waiting for a slice of main-thread time (one build per frame). */
  private buildQueue: { key: string; area: Area; x: number; z: number; bounds: TileBounds; tries: number; outer: boolean }[] = [];
  /** Deferred tree scatter/instance jobs, processed a few grid rows per frame. */
  private treeJobs = new Map<string, TreeJob>();
  /** Wall-clock timestamp of the previous update() call — drives the per-tile fade. */
  private lastFrameMs = 0;

  constructor(
    private proj: Projection,
    private terrain: Terrain,
    scene: THREE.Scene,
    public quality: QualityPreset = 'high',
    private maxAniso = 4
  ) {
    this.uniformsNoise = { uNoise: { value: groundDetailTexture(this.maxAniso) } };
    patchBuildingShader(this.solidMat, { ...this.uniforms, ...this.uniformsNoise });
    this.roadUniforms.uAsphalt.value = asphaltTexture(this.maxAniso);
    patchRoadShader(this.roadMat, this.roadUniforms);
    scene.add(this.group);
  }

  private get profile(): QualityProfile { return QUALITY[this.quality]; }

  /** Per-tile material clones (shader-patched like the originals, sharing the same program cache key). */
  private cloneTileMats(): TileMats {
    const solid = this.solidMat.clone();
    const water = this.waterMat.clone();
    patchBuildingShader(solid, { ...this.uniforms, ...this.uniformsNoise });
    solid.opacity = 0; solid.transparent = true;
    water.opacity = 0; water.transparent = true;
    return { solid, water, tree: null };
  }

  /** Advance every tile's fade toward its target and drive group visibility + material opacity.
   *  Fade-in 450 ms when a tile streams in; fade-out 300 ms at the AGL gate, retention or prune. */
  private stepTileFades(dtMs: number) {
    for (const t of this.tiles.values()) {
      t.fade = Math.max(0, Math.min(1, t.fade + (t.fadeTgt > t.fade ? dtMs / 450 : -dtMs / 300)));
      const op = t.fade, transparent = op < 0.999;
      t.mats.solid.opacity = op; t.mats.solid.transparent = transparent;
      t.mats.water.opacity = op; t.mats.water.transparent = transparent;
      if (t.mats.tree) { t.mats.tree.opacity = op; t.mats.tree.transparent = transparent; }
      t.group.visible = t.fade > 0.02;
    }
  }

  setQuality(q: QualityPreset) {
    if (q === this.quality) return;
    this.quality = q;
    // The tier is a different content set, not a density multiplier. Drop every built tile
    // (including its GPU buffers) and let the streamer rebuild with the new preset.
    this.clearTiles();
  }

  private clearTiles() {
    for (const [, t] of [...this.tiles]) {
      this.group.remove(t.group);
      disposeGroup(t.group);
      disposeTileMats(t.mats);
    }
    this.tiles.clear();
    this.requested.clear();
    this.buildQueue.length = 0;
    this.treeJobs.clear();
  }

  /** `night` 0 (daylight) … 1 (dark): drives lit windows, sky reflection tint and street/city lights. */
  setNight(night: number) {
    this.uniforms.uSunset.value = night;
    // Sodium-vapour street glow only reads after sundown; by day the lamps are just dark poles.
    const on = night > 0.5;
    for (const t of this.tiles.values()) if (t.lights) t.lights.visible = on;
  }

  private updateRunwayZones(airports: Airport[]) {
    this.runwayZones.length = 0;
    this.groundClear.clear();
    for (const a of airports) airportClearZones(a, this.proj, this.groundClear);
    for (let i = 0; i < airports.length; i++) {
      const ap = airports[i];
      for (let j = 0; j < ap.runways.length; j++) {
        const rw = ap.runways[j];
        const ax = this.proj.x(rw.leLon), az = this.proj.z(rw.leLat);
        const bx = this.proj.x(rw.heLon), bz = this.proj.z(rw.heLat);
        const dx = bx - ax, dz = bz - az;
        const L2 = dx * dx + dz * dz || 1;
        const radius = rw.width * 0.5 + 165;
        this.runwayZones.push({
          ax,
          az,
          dx,
          dz,
          invL2: 1 / L2,
          rSq: radius * radius,
        });
      }
    }
  }

  /** Returns true when world (x, z) lies inside an active airport runway/taxiway/apron exclusion envelope. */
  private isNearRunway(x: number, z: number): boolean {
    if (this.groundClear.contains(x, z) || this.spawnClear.contains(x, z)) return true;
    for (let i = 0; i < this.runwayZones.length; i++) {
      const r = this.runwayZones[i];
      const rx = x - r.ax, rz = z - r.az;
      const t = (rx * r.dx + rz * r.dz) * r.invL2;
      const cl = t < 0 ? 0 : t > 1 ? 1 : t;
      const nx = rx - r.dx * cl, nz = rz - r.dz * cl;
      if (nx * nx + nz * nz < r.rSq) return true;
    }
    return false;
  }

  /** Keep the aircraft's parking footprint (plus a margin) free of scenery. Re-streams tiles only when it actually moves. */
  setSpawnClear(rect: Rect | null, extra: Rect[] = []) {
    const key = rect ? [rect, ...extra].map((r) => `${r.cx.toFixed(1)},${r.cz.toFixed(1)},${r.hdg.toFixed(0)}`).join('|') : '';
    if (key === this.spawnKey) return;
    this.spawnKey = key; this.spawnClear.clear();
    if (rect) { this.spawnClear.addRect({ ...rect, hl: rect.hl + 6, hw: rect.hw + 6 }); for (const e of extra) this.spawnClear.addRect(e); }
    this.clearTiles();
  }
  private blockedBySpawn(ring: [number, number][]): boolean {
    if (!this.spawnClear.rects.length) return false;
    const pts: XZ[] = ring.map(([la, lo]) => [this.proj.x(lo), this.proj.z(la)] as XZ);
    if (this.spawnClear.hitsFootprint(pts)) return true;
    for (const r of this.spawnClear.rects) for (const c of rectCorners(r)) { let inside = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { if ((pts[i][1] > c[1]) !== (pts[j][1] > c[1]) && c[0] < ((pts[j][0] - pts[i][0]) * (c[1] - pts[i][1])) / (pts[j][1] - pts[i][1] || 1e-9) + pts[i][0]) inside = !inside; } if (inside) return true; }
    return false;
  }

  update(x: number, z: number, agl: number, airports: Airport[], frustum?: THREE.Frustum) {
    if (this.activeAirports !== airports) {
      this.activeAirports = airports;
      this.updateRunwayZones(airports);
    }
    this.focus.x = x; this.focus.z = z;
    const profile = this.profile;
    // Low has no 3D world layer at all: no MVT fetches, no mesh rebuilds, no per-tile
    // bookkeeping. The airport/terrain streams remain fully functional.
    if (profile.buildings === 'none' && !profile.trees) {
      for (const t of this.tiles.values()) t.group.visible = false;
      return;
    }
    const cityOn = agl <= profile.structureMaxAgl;
    // Frame delta for the per-tile fade (structures.update runs once per rendered frame).
    const nowMs = performance.now();
    const dtMs = Math.min(100, Math.max(0, nowMs - this.lastFrameMs));
    this.lastFrameMs = nowMs;
    if (!cityOn) {
      // Cross the structureMaxAgl gate by fading the whole city layer instead of vanishing it,
      // which used to pop every building in view in a single frame.
      for (const t of this.tiles.values()) t.fadeTgt = 0;
      this.stepTileFades(dtMs);
      return;
    }

    // Spend at most one deferred MVT build per frame so a dense tile cannot stall the frame.
    const t0 = performance.now();
    while (this.buildQueue.length && performance.now() - t0 < 1.5) {
      const job = this.buildQueue[0];
      const entry = this.tiles.get(job.key);
      if (!entry) { this.buildQueue.shift(); continue; }
      // Wait until real DEM heights AND 1:1 satellite pixel samples exist under this tile so
      // roofs and green-pixel trees match the satellite map 1:1 on the first build.
      const demOk = this.terrain.heightReady(job.x, job.z);
      const satOk = this.terrain.satReady(job.x, job.z);
      if ((job.tries < 80 && !demOk) || (job.tries < 55 && !satOk)) {
        job.tries++;
        break;
      }
      this.buildQueue.shift();
      const built = this.buildAreaGroup(job.area, job.outer, job.bounds, false, job.key);
      this.group.remove(entry.group);
      disposeGroup(entry.group);
      disposeTileMats(entry.mats);
      // seamless procedural -> MVT swap: inherit the old tile's fade so nothing pops at the swap
      built.mats.solid.opacity = entry.fade; built.mats.solid.transparent = entry.fade < 0.999;
      built.mats.water.opacity = entry.fade; built.mats.water.transparent = entry.fade < 0.999;
      this.tiles.set(job.key, {
        key: job.key,
        group: built.group,
        area: job.area,
        isProcedural: false,
        lights: built.lights,
        lastSeen: entry.lastSeen || performance.now(),
        fade: entry.fade,
        fadeTgt: entry.fadeTgt,
        mats: built.mats,
      });
      if (built.lights) built.lights.visible = this.uniforms.uSunset.value > 0.5;
      break;
    }

    // Tree scatter is time-sliced so a dense tile cannot stall the render loop.
    const treeBudgetMs = profile.trees ? (profile.id === 'ultra' ? 1.5 : 1.2) : 0;
    if (treeBudgetMs > 0) {
      this.processTreeJobs(treeBudgetMs);
    }

    const lat = this.proj.lat(z), lon = this.proj.lon(x);
    const cx = Math.floor(lonToTileXf(lon, ZOOM));
    const cy = Math.floor(latToTileYf(lat, ZOOM));

    // Stream 3x3 tiles around the aircraft. (The outerRing tier flag exists but is disabled on
    // every preset, so the 5x5 roof-only branch never engages today.)
    const ring = profile.outerRing && agl > OUTER_RING_AGL ? 2 : 1;
    const wanted = new Set<string>();
    const now = performance.now();

    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        const tx = cx + dx, ty = cy + dy;
        const key = `${ZOOM}/${tx}/${ty}`;

        const minLon = tileXToLon(tx, ZOOM);
        const maxLon = tileXToLon(tx + 1, ZOOM);
        const maxLat = tileYToLat(ty, ZOOM);
        const minLat = tileYToLat(ty + 1, ZOOM);
        const x0 = this.proj.x(minLon), x1 = this.proj.x(maxLon);
        const z0 = this.proj.z(maxLat), z1 = this.proj.z(minLat);
        const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
        const minZ = Math.min(z0, z1), maxZ = Math.max(z0, z1);
        const tileCenterX = (minX + maxX) * 0.5;
        const tileCenterZ = (minZ + maxZ) * 0.5;
        const distCam = Math.hypot(tileCenterX - x, tileCenterZ - z);

        // Core zone or center tile is never culled
        const coreR = profile.structureCore;
        let inView = false;
        if ((dx === 0 && dy === 0) || distCam <= coreR || !frustum) {
          inView = true;
        } else {
          _sMin.set(minX - 600, -200, minZ - 600);
          _sMax.set(maxX + 600, 3000, maxZ + 600);
          _structBox.set(_sMin, _sMax);
          inView = frustum.intersectsBox(_structBox);
        }

        if (inView) {
          wanted.add(key);
          const t = this.tiles.get(key);
          if (t) {
            t.lastSeen = now;
            t.fadeTgt = 1; // visibility itself is driven by the fade (see stepTileFades)
          } else {
            this.loadTile(key, tx, ty, Math.max(Math.abs(dx), Math.abs(dy)) > 1);
          }
        } else {
          const t = this.tiles.get(key);
          if (t) {
            t.fadeTgt = 0;
            // Graceful retention: keep in memory for up to 6s
            if (now - (t.lastSeen || 0) < 6000) {
              wanted.add(key);
            }
          }
        }
      }
    }

    // Advance the per-tile fades BEFORE pruning so tiles leaving the wanted set dissolve first.
    this.stepTileFades(dtMs);

    // Prune distant tiles
    for (const [key, t] of this.tiles) {
      if (!wanted.has(key)) {
        if (t.fade > 0.02) { t.fadeTgt = 0; continue; } // dissolve first, dispose on a later pass
        this.group.remove(t.group);
        disposeGroup(t.group);
        disposeTileMats(t.mats);
        this.tiles.delete(key);
        this.treeJobs.delete(key);
        // Allow a re-entry to rebuild from the MVT cache instead of keeping the procedural stand-in.
        this.requested.delete(key);
      }
    }
  }

  private loadTile(key: string, tx: number, ty: number, outer = false) {
    const minLon = tileXToLon(tx, ZOOM);
    const maxLon = tileXToLon(tx + 1, ZOOM);
    const maxLat = tileYToLat(ty, ZOOM);
    const minLat = tileYToLat(ty + 1, ZOOM);
    const x0 = this.proj.x(minLon), x1 = this.proj.x(maxLon);
    const z0 = this.proj.z(maxLat), z1 = this.proj.z(minLat);
    const bounds: TileBounds = {
      minX: Math.min(x0, x1),
      maxX: Math.max(x0, x1),
      minZ: Math.min(z0, z1),
      maxZ: Math.max(z0, z1),
    };

    // 1. Immediately spawn procedural placeholder area for seamless visuals
    const procArea = generateProceduralArea(minLat, minLon, maxLat, maxLon, this.profile);
    const proc = this.buildAreaGroup(procArea, outer, bounds, true, key);
    proc.group.visible = true;
    this.tiles.set(key, { key, group: proc.group, area: procArea, isProcedural: true, lights: proc.lights, lastSeen: performance.now(), fade: 0, fadeTgt: 1, mats: proc.mats });

    // 2. Fetch real 1:1 OpenFreeMap MVT vector data (<80ms CDN)
    if (!this.requested.has(key)) {
      this.requested.add(key);
      fetchMvtTile(ZOOM, tx, ty).then((mvt) => {
        if (!this.tiles.has(key)) return;
        const area: Area = mvt
          ? {
              buildings: mvt.buildings,
              water: mvt.water,
              forests: mvt.forests,
              roads: mvt.roads,
              urban: mvt.urban,
            }
          : { buildings: [], water: [], forests: [], roads: [], urban: [] };
        // Even if MVT has few features in a rural tile, queue it so 1:1 satellite green-pixel
        // trees are spawned across the rural hillsides and forests.
        const cLat = (minLat + maxLat) / 2, cLon = (minLon + maxLon) / 2;
        this.buildQueue.push({ key, area, x: this.proj.x(cLon), z: this.proj.z(cLat), bounds, tries: 0, outer });
      });
    }
  }

  private buildAreaGroup(area: Area, outer = false, bounds?: TileBounds, isPlaceholder = false, key = ''): BuiltTile {
    const group = new THREE.Group();
    const solid: VBuf = { pos: [], nor: [], col: [], uv: [], isWall: [], style: [], seed: [] };
    const liquid: VBuf = { pos: [], nor: [], col: [], uv: [], isWall: [], style: [], seed: [] };

    // Tile world bounds & bounding sphere (enables hardware frustum culling on all InstancedMeshes)
    const bMinX = bounds ? bounds.minX : this.focus.x - 1200;
    const bMaxX = bounds ? bounds.maxX : this.focus.x + 1200;
    const bMinZ = bounds ? bounds.minZ : this.focus.z - 1200;
    const bMaxZ = bounds ? bounds.maxZ : this.focus.z + 1200;
    const spanX = Math.max(1, bMaxX - bMinX), spanZ = Math.max(1, bMaxZ - bMinZ);
    const tileCx = (bMinX + bMaxX) * 0.5, tileCz = (bMinZ + bMaxZ) * 0.5;
    const tileCy = this.terrain.heightAt(tileCx, tileCz);
    const tileBoundingSphere = new THREE.Sphere(
      new THREE.Vector3(tileCx, tileCy + 120, tileCz),
      Math.hypot(spanX, spanZ) * 0.62 + 350
    );

    // ---- Fast 128x128 Tile Occupancy Bitmap (O(1) spatial collision & land-cover lookup) --------
    // Bit 1: Road + shoulder buffer
    // Bit 2: Mapped building footprint + buffer
    // Bit 4: Water body
    // Bit 8: OSM Forest / Park polygon
    const G = 128;
    const occ = new Uint8Array(G * G);
    const toGx = (x: number) => Math.max(0, Math.min(G - 1, Math.floor(((x - bMinX) / spanX) * G)));
    const toGz = (z: number) => Math.max(0, Math.min(G - 1, Math.floor(((z - bMinZ) / spanZ) * G)));
    const markBox = (x0: number, z0: number, x1: number, z1: number, bit: number, padM = 0) => {
      const gx0 = toGx(Math.min(x0, x1) - padM), gx1 = toGx(Math.max(x0, x1) + padM);
      const gz0 = toGz(Math.min(z0, z1) - padM), gz1 = toGz(Math.max(z0, z1) + padM);
      for (let gz = gz0; gz <= gz1; gz++) {
        const row = gz * G;
        for (let gx = gx0; gx <= gx1; gx++) occ[row + gx] |= bit;
      }
    };
    const rasterizePoly = (contour: THREE.Vector2[], bit: number) => {
      if (contour.length < 3) return;
      let minZ = Infinity, maxZ = -Infinity;
      for (const p of contour) { if (p.y < minZ) minZ = p.y; if (p.y > maxZ) maxZ = p.y; }
      const gz0 = toGz(minZ), gz1 = toGz(maxZ);
      const xHits: number[] = [];
      for (let gz = gz0; gz <= gz1; gz++) {
        const y = bMinZ + ((gz + 0.5) / G) * spanZ;
        xHits.length = 0;
        for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
          const yi = contour[i].y, yj = contour[j].y;
          if ((yi > y) !== (yj > y)) {
            xHits.push(contour[i].x + ((contour[j].x - contour[i].x) * (y - yi)) / (yj - yi));
          }
        }
        xHits.sort((a, b) => a - b);
        const row = gz * G;
        for (let k = 0; k + 1 < xHits.length; k += 2) {
          const c0 = toGx(xHits[k]), c1 = toGx(xHits[k + 1]);
          for (let gx = c0; gx <= c1; gx++) occ[row + gx] |= bit;
        }
      }
    };

    // 1. 3D Extruded Buildings with 4 Architectural Typologies & 1:1 Satellite Roof Colour Sampling
    const qp = this.profile;
    const buildingsOn = qp.buildings !== 'none';
    const focus = this.focus;
    const far2 = FAR_VISIBLE_M * FAR_VISIBLE_M;
    const maxFull = buildingsOn && !outer ? qp.buildingBudget.full : 0;
    const maxRoof = buildingsOn ? (outer ? Math.round(qp.buildingBudget.roof * 0.45) : qp.buildingBudget.roof) : 0;
    const near2 = NEAR_FULL_M * NEAR_FULL_M;

    // Pass 1: distance ranking from a cheap geodetic centroid.
    // On high, landed houses are rejected here (before the budget) so they can never consume a
    // slot that a real tower/ruko/industrial block could have used.
    const pre: { b: Building; d2: number; cls: BuildingClass }[] = [];
    if (buildingsOn) {
      for (const b of area.buildings) {
        const ring = b.ring;
        if (!ring || ring.length < 3) continue;
        const cls = classifyBuilding(b);
        if (qp.buildings === 'major' && cls.house) continue;
        if (this.blockedBySpawn(ring)) continue;
        let cla = 0, clo = 0;
        for (const p of ring) { cla += p[0]; clo += p[1]; }
        cla /= ring.length; clo /= ring.length;
        const dcx = this.proj.x(clo) - focus.x, dcz = this.proj.z(cla) - focus.z;
        const d2 = dcx * dcx + dcz * dcz;
        if (d2 <= far2) pre.push({ b, d2, cls });
      }
      pre.sort((p, q) => p.d2 - q.d2);
    } else if (qp.trees) {
      // Tree-only tier: keep the building footprints in the occupancy grid so trees never
      // sprout out of a satellite rooftop (they would otherwise look like floating canopies).
      for (const b of area.buildings) {
        const ring = b.ring;
        if (!ring || ring.length < 3) continue;
        let minLa = Infinity, maxLa = -Infinity, minLo = Infinity, maxLo = -Infinity;
        for (const [la, lo] of ring) {
          if (la < minLa) minLa = la; if (la > maxLa) maxLa = la;
          if (lo < minLo) minLo = lo; if (lo > maxLo) maxLo = lo;
        }
        markBox(this.proj.x(minLo), this.proj.z(maxLa), this.proj.x(maxLo), this.proj.z(minLa), 2, 4.5);
      }
    }

    // Pass 2: project footprints & mark building occupancy
    const cap = maxFull + maxRoof;
    const cand: { b: Building; contour: THREE.Vector2[]; d2: number; cls: BuildingClass }[] = [];
    for (let i = 0; i < pre.length && cand.length < cap; i++) {
      const contour = contourOf(this.proj, pre[i].b.ring);
      if (contour.length < 3) continue;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of contour) {
        if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
        if (p.y < z0) z0 = p.y; if (p.y > z1) z1 = p.y;
      }
      markBox(x0, z0, x1, z1, 2, 4.5);
      cand.push({ b: pre[i].b, contour, d2: pre[i].d2, cls: pre[i].cls });
    }

    let nFull = 0, nRoof = 0;
    const satTint = new THREE.Color();

    for (const { b, contour, d2, cls } of cand) {
      let ccx = 0, ccz = 0;
      for (const p of contour) { ccx += p.x; ccz += p.y; }
      ccx /= contour.length; ccz /= contour.length;

      const distM = Math.sqrt(d2);
      if (distM > 3800 && hash(ccx * 13.31 + ccz * 7.77) > Math.max(0, 1 - (distM - 3800) / 2600)) continue;

      const wantFull = (d2 <= near2 || b.height >= TALL_ALWAYS_H) && nFull < maxFull;
      if (wantFull) nFull++;
      else if (nRoof < maxRoof) nRoof++;
      else continue;

      const seed = hash(ccx * 0.37 + ccz * 0.71);
      const seed2 = hash(ccz * 0.53 + ccx * 0.19);
      const stylePick = hash(ccx * 1.93 + ccz * 2.71);
      const styleSeed = hash(ccz * 3.11 + ccx * 5.37);

      // ---- Classify into 4 Architectural Typologies --------------------------------------------
      // 1. Industrial / Warehouse / Hangar (corrugated metal cladding + wide low-pitch roof)
      // 2. Ruko / Shophouse (2-4 storeys with ground-floor rolling door & signboard)
      // 3. Landed House / Kampung (1-2 storeys with masonry wall, domestic windows/doors & pitched roof)
      // 4. High-Rise / Office / Apartment Tower (curtain glass, punched concrete, or ribbon glazing)
      const { industrial: isIndustrial, ruko: isRuko, house: isHouse } = cls;

      const style = isRuko ? 3 : stylePick < 0.36 ? 0 : stylePick < 0.74 ? 1 : 2;
      const c = new THREE.Color(
        b.color ?? (isIndustrial ? (seed < 0.5 ? 0xd6dde3 : 0xc5ced6) : facadeColor(seed))
      );

      // Base architectural roof colour
      const roofColor = isHouse
        ? new THREE.Color(seed2 < 0.42
          ? ROOF_TILE[Math.floor(seed * ROOF_TILE.length) % ROOF_TILE.length]
          : ROOF_METAL[Math.floor(seed * ROOF_METAL.length) % ROOF_METAL.length])
        : isIndustrial
          ? new THREE.Color(seed2 < 0.25 ? 0x3b6998 : ROOF_METAL[Math.floor(seed * ROOF_METAL.length) % ROOF_METAL.length])
          : new THREE.Color(ROOF_COMMERCIAL[Math.floor(seed2 * ROOF_COMMERCIAL.length) % ROOF_COMMERCIAL.length]);

      // ---- 1:1 Satellite Roof Colour Sampling --------------------------------------------------
      // Sample the real satellite pixel right under the building centroid so red clay tiles, blue
      // factory roofs, and bright galvalume roofs match the underlying 1:1 satellite map seamlessly.
      const sat = this.terrain.sampleSatellite(ccx, ccz);
      if (sat && sat.veg < 0.36) {
        const lum = 0.299 * sat.r + 0.587 * sat.g + 0.114 * sat.b;
        if (lum > 0.08 && lum < 0.88) {
          // Normalize overly dark aerial shadow samples so the 3D roof stays sunlit-ready
          const gain = lum < 0.22 ? 0.22 / Math.max(0.08, lum) : 1.0;
          satTint.setRGB(
            Math.min(0.92, sat.r * gain),
            Math.min(0.92, sat.g * gain),
            Math.min(0.92, sat.b * gain)
          );
          roofColor.lerp(satTint, 0.70);
        }
      }

      if (!wantFull) {
        const g = this.terrain.heightAt(ccx, ccz);
        const wallKind = isIndustrial ? 4 : isHouse ? 2 : 1;
        addWalls(solid, contour, g - 2, g + b.height, c, wallKind, style, styleSeed);
        addRoof(solid, offsetRing(contour, 0.30), g + b.height, roofColor, true, isHouse || isIndustrial ? 1 : 0);
        continue;
      }

      let minH = Infinity, maxH = -Infinity, sum = 0;
      for (const p of contour) {
        const h = this.terrain.heightAt(p.x, p.y);
        minH = Math.min(minH, h); maxH = Math.max(maxH, h); sum += h;
      }
      const ground = (sum / contour.length) * 0.75 + maxH * 0.25;

      if (isHouse) {
        // Tipologi 1: Rumah Tapak / Kampung — domestic windows/doors, overhanging eaves & pitched tile/metal roof
        const eaves = Math.min(6.6, Math.max(3.0, b.height * 0.74));
        const wallTop = ground + eaves;
        addWalls(solid, contour, minH - 1.2, wallTop, c, 2, 0, styleSeed);
        const overhang = Math.min(0.6, 0.25 + Math.sqrt(Math.max(8, b.area)) * 0.018);
        const roofRing = offsetRing(contour, overhang);
        addWalls(solid, roofRing, wallTop - 0.30, wallTop, roofColor.clone().multiplyScalar(0.82), 3);
        if (isConvexRing(roofRing)) {
          const rise = Math.min(3.4, Math.max(1.35, Math.sqrt(Math.max(8, b.area)) * 0.26));
          addSlopedRoof(solid, roofRing, wallTop, rise, roofColor, 1);
        } else {
          addRoof(solid, roofRing, wallTop, roofColor, true, 1);
        }
      } else if (isIndustrial) {
        // Tipologi 2: Gudang / Pabrik / Hanggar — corrugated metal cladding + low-pitch industrial roof
        const wallTop = ground + b.height;
        addWalls(solid, contour, minH - 1.4, wallTop, c, 4, 0, styleSeed);
        const roofRing = offsetRing(contour, 0.38);
        addWalls(solid, roofRing, wallTop - 0.45, wallTop, roofColor.clone().multiplyScalar(0.85), 3);
        if (isConvexRing(roofRing)) {
          const rise = Math.min(2.6, Math.max(1.1, Math.sqrt(Math.max(16, b.area)) * 0.075));
          addSlopedRoof(solid, roofRing, wallTop, rise, roofColor, 1);
        } else {
          addRoof(solid, roofRing, wallTop, roofColor, true, 1);
        }
      } else {
        // Tipologi 3 (Ruko 2-4 storeys, style=3) & Tipologi 4 (High-Rise Towers, style=0..2)
        const top = ground + b.height;
        addWalls(solid, contour, minH - 1.2, top, c, 1, style, styleSeed);
        const roofRing = offsetRing(contour, 0.22);
        addWalls(solid, roofRing, top - 0.8, top, c.clone().multiplyScalar(0.88), 3);
        addRoof(solid, roofRing, top, roofColor, true, isRuko ? 1 : 0);

        // Rooftop HVAC box for taller buildings (>18m)
        if (b.height > 18) {
          const boxContour = [
            new THREE.Vector2(ccx - 2.5, ccz - 2.5),
            new THREE.Vector2(ccx + 2.5, ccz - 2.5),
            new THREE.Vector2(ccx + 2.5, ccz + 2.5),
            new THREE.Vector2(ccx - 2.5, ccz + 2.5),
          ];
          const hvacColor = new THREE.Color(0x475569);
          addWalls(solid, boxContour, top, top + 2.4, hvacColor, 3);
          addRoof(solid, boxContour, top + 2.4, hvacColor, true, 0);
        }
      }
    }

    // 2. Water Polygons (rasterized into occupancy grid so trees/infill never land in rivers/lakes)
    for (const w of area.water) {
      const contour = contourOf(this.proj, w.ring);
      if (contour.length < 3) continue;
      rasterizePoly(contour, 4);
    }

    // 3. Roads: continuous mitered, terrain-draped ribbon + occupancy marking so trees/infill
    //    never spawn on highways or street corridors.
    let lightInst: THREE.InstancedMesh | null = null;
    if (area.roads && area.roads.length > 0) {
      const rb: RoadBuf = { pos: [], nor: [], uv: [], cls: [], wid: [] };
      const lightPositions: THREE.Vector3[] = [];
      const drawRoads = qp.roads;

      for (const r of area.roads) {
        const pts: THREE.Vector2[] = [];
        for (const [la, lo] of r.points) pts.push(new THREE.Vector2(this.proj.x(lo), this.proj.z(la)));
        const cls = roadClass(r.highway);
        const width = roadWidth(r.highway);
        const layer = r.layer ?? 0;
        const elev = Math.max(0, layer) * 4.5 + (r.brunnel === 'bridge' ? 4.5 : 0);
        if (drawRoads) addRoadRibbon(rb, pts, width, cls, (x, z) => this.terrain.heightAt(x, z), elev);

        // Mark road corridor in occupancy bitmap (every ~12m along segment)
        const pad = width * 0.5 + 8.5;
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i], b = pts[i + 1];
          const len = a.distanceTo(b);
          const steps = Math.max(1, Math.ceil(len / 12));
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const rx = a.x + (b.x - a.x) * t, rz = a.y + (b.y - a.y) * t;
            markBox(rx, rz, rx, rz, 1, pad);
          }
        }

        // Street lamps along the major corridors, every ~70 m, just outside the carriageway.
        if (qp.streetLights && cls <= 1 && !outer) {
          let acc = 0;
          for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], b = pts[i + 1];
            const len = a.distanceTo(b);
            if (len < 1) continue;
            const dx = (b.x - a.x) / len, dz = (b.y - a.y) / len;
            const nx = -dz * (width * 0.5 + 1.6), nz = dx * (width * 0.5 + 1.6);
            for (; acc <= len; acc += 70) {
              const x = a.x + dx * acc + nx, z = a.y + dz * acc + nz;
              lightPositions.push(new THREE.Vector3(x, this.terrain.heightAt(x, z), z));
            }
            acc -= len;
          }
        }
      }

      if (drawRoads && rb.pos.length > 0) {
        const roadGeo = new THREE.BufferGeometry();
        roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(rb.pos, 3));
        roadGeo.setAttribute('normal', new THREE.Float32BufferAttribute(rb.nor, 3));
        roadGeo.setAttribute('aRoadUv', new THREE.Float32BufferAttribute(rb.uv, 2));
        roadGeo.setAttribute('aRoadWidth', new THREE.Float32BufferAttribute(rb.wid, 1));
        roadGeo.setAttribute('aRoadClass', new THREE.Float32BufferAttribute(rb.cls, 1));
        roadGeo.computeBoundingSphere();
        const roadMesh = new THREE.Mesh(roadGeo, this.roadMat);
        roadMesh.renderOrder = 2;
        group.add(roadMesh);
      }

      if (qp.streetLights && lightPositions.length > 0) {
        const maxLights = Math.min(lightPositions.length, 220);
        const dummy = new THREE.Object3D();
        const poleInst = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.2, 8.6, 5), this.poleMat, maxLights);
        lightInst = new THREE.InstancedMesh(new THREE.BoxGeometry(1.0, 0.34, 1.0), this.lightMat, maxLights);
        for (let i = 0; i < maxLights; i++) {
          const p = lightPositions[i];
          dummy.position.set(p.x, p.y + 4.3, p.z);
          dummy.updateMatrix();
          poleInst.setMatrixAt(i, dummy.matrix);
          dummy.position.set(p.x, p.y + 8.6, p.z);
          dummy.updateMatrix();
          lightInst.setMatrixAt(i, dummy.matrix);
        }
        poleInst.instanceMatrix.needsUpdate = true;
        poleInst.boundingSphere = tileBoundingSphere;
        poleInst.frustumCulled = true;
        lightInst.instanceMatrix.needsUpdate = true;
        lightInst.boundingSphere = tileBoundingSphere;
        lightInst.frustumCulled = true;
        lightInst.visible = this.uniforms.uSunset.value > 0.5;
        group.add(poleInst, lightInst);
      }
    }

    // Rasterize OSM forest/park polygons into occupancy bit 8
    if (area.forests) {
      for (const f of area.forests) {
        const contour = contourOf(this.proj, f.ring);
        if (contour.length >= 3) rasterizePoly(contour, 8);
      }
    }

    // 1b. Smart Satellite-Guided Settlement Infill (ultra only).
    //     Fills urban districts and unmapped residential clusters (kampungs, suburbs, shophouse rows).
    //     Checks the O(1) occupancy bitmap AND 1:1 satellite pixel classifier so procedural
    //     houses only appear on built-up/roof pixels and NEVER on green trees, roads, or water.
    const capFill = qp.buildings === 'all' && !outer ? qp.buildingBudget.settlement : 0;
    let filled = 0;

    if (capFill > 0 && area.urban && area.urban.length) {
      let tries = 1000;
      for (const u of area.urban) {
        if (filled >= capFill || tries <= 0) break;
        const contour = contourOf(this.proj, u.ring);
        if (contour.length < 3) continue;

        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        let minLa = Infinity, maxLa = -Infinity, minLo = Infinity, maxLo = -Infinity;
        for (const p of contour) {
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
          minZ = Math.min(minZ, p.y); maxZ = Math.max(maxZ, p.y);
        }
        for (const [la, lo] of u.ring) {
          minLa = Math.min(minLa, la); maxLa = Math.max(maxLa, la);
          minLo = Math.min(minLo, lo); maxLo = Math.max(maxLo, lo);
        }
        const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
        if (Math.hypot(cx - focus.x, cz - focus.z) > 5400) continue;

        const polyArea = areaM2(u.ring);
        if (polyArea < 1500) continue;

        let inBox = 0;
        for (const b of area.buildings) {
          const p = b.ring[0];
          if (p && p[0] >= minLa && p[0] <= maxLa && p[1] >= minLo && p[1] <= maxLo) inBox++;
        }
        if (inBox / Math.max(1, polyArea) > 1 / 400) continue;

        const industrial = /industrial|commercial|retail|quarry|construction|brownfield/.test(u.type);
        const step = industrial ? 35 : 18;
        const hMin = industrial ? 6.5 : 3.6;
        const hSpan = industrial ? 6.5 : 3.8;
        const sizeA = industrial ? 24 : 7, sizeB = industrial ? 34 : 6;
        let local = 0;
        for (let qx = minX + step * 0.5; qx < maxX && local < 140 && filled < capFill && tries > 0; qx += step) {
          for (let qz = minZ + step * 0.5; qz < maxZ && local < 140 && filled < capFill && tries > 0; qz += step) {
            tries--;
            const jx = qx + (hash(qx * 1.37 + qz * 0.71) - 0.5) * step * 0.7;
            const jz = qz + (hash(qz * 2.11 + qx * 0.37) - 0.5) * step * 0.7;
            // Fast O(1) check against roads (1), mapped buildings (2), water (4), and forests (8)
            const cell = occ[toGz(jz) * G + toGx(jx)];
            if ((cell & (1 | 2 | 4 | 8)) !== 0) continue;
            if (this.terrain.waterAt(jx, jz) > 0.20 || this.isNearRunway(jx, jz)) continue;
            // Satellite check: never place a house on green vegetation; require plausible roof/built-up tone
            const sat = this.terrain.sampleSatellite(jx, jz);
            if (sat && (sat.veg > 0.18 || sat.roof < 0.08)) continue;
            if (!isPointInPoly(jx, jz, contour)) continue;

            const r1 = hash(jx * 3.7 + jz * 1.9), r2 = hash(jz * 5.3 + jx * 0.7);
            const hw = (sizeA * (0.75 + r1 * 0.6)) / 2, hd = (sizeB * (0.7 + r2 * 0.7)) / 2;
            const ang = r2 * Math.PI, ca = Math.cos(ang), sa = Math.sin(ang);
            const corner = (sx: number, sz: number) => new THREE.Vector2(jx + sx * ca - sz * sa, jz + sx * sa + sz * ca);
            const ring = [corner(-hw, -hd), corner(hw, -hd), corner(hw, hd), corner(-hw, hd)];
            markBox(jx - hw, jz - hd, jx + hw, jz + hd, 2, 3.0);

            const gy = this.terrain.heightAt(jx, jz);
            const h = hMin + hash(jx * 0.9 + jz * 2.3) * hSpan;
            const cc = new THREE.Color(facadeColor(hash(jx * 0.31 + jz * 0.77))).multiplyScalar(0.86);
            const rc = new THREE.Color(hash(jz * 0.41 + jx * 0.19) < 0.38
              ? ROOF_TILE[Math.floor(hash(jx * 1.1) * ROOF_TILE.length) % ROOF_TILE.length]
              : ROOF_METAL[Math.floor(hash(jz * 1.3) * ROOF_METAL.length) % ROOF_METAL.length]);
            if (sat) {
              satTint.setRGB(Math.min(0.9, sat.r * 1.1), Math.min(0.9, sat.g * 1.1), Math.min(0.9, sat.b * 1.1));
              rc.lerp(satTint, 0.68);
            }
            if (industrial) {
              addWalls(solid, ring, gy - 1.5, gy + h, cc, 4, 0, r1);
              addRoof(solid, ring, gy + h, rc, true, 1);
            } else {
              addWalls(solid, ring, gy - 1.2, gy + h, cc, 2, 0, r1);
              addSlopedRoof(solid, ring, gy + h, 1.4 + r1 * 1.5, rc, 1);
            }
            local++; filled++;
          }
        }
      }
    }

    // 1c. Tile-wide smart settlement scanner for unmapped villages, kampungs, and shophouse strips
    if (capFill > 0 && filled < capFill) {
      const scanStep = 28;
      let scanTries = 1200;
      const sizeA = 7.6, sizeB = 6.4;
      for (let qx = bMinX + scanStep * 0.5; qx < bMaxX - scanStep * 0.5 && filled < capFill && scanTries > 0; qx += scanStep) {
        for (let qz = bMinZ + scanStep * 0.5; qz < bMaxZ - scanStep * 0.5 && filled < capFill && scanTries > 0; qz += scanStep) {
          scanTries--;
          const jx = qx + (hash(qx * 1.37 + qz * 0.71) - 0.5) * scanStep * 0.65;
          const jz = qz + (hash(qz * 2.11 + qx * 0.37) - 0.5) * scanStep * 0.65;
          const cell = occ[toGz(jz) * G + toGx(jx)];
          if ((cell & (1 | 2 | 4 | 8)) !== 0) continue;
          if (this.terrain.waterAt(jx, jz) > 0.18 || this.isNearRunway(jx, jz)) continue;

          const sat = this.terrain.sampleSatellite(jx, jz);
          // Only spawn houses if the terrain pixel is NOT green canopy (sat.veg < 0.16)
          // AND indicates plausible roof/settlement tones (sat.roof >= 0.08 or warm clay/pavement)
          if (!sat || sat.veg >= 0.16) continue;
          const isSettlement = sat.roof >= 0.08 || (sat.r > sat.g * 1.02 && sat.r > sat.b * 1.05);
          if (!isSettlement) continue;

          const r1 = hash(jx * 3.7 + jz * 1.9), r2 = hash(jz * 5.3 + jx * 0.7);
          const hw = (sizeA * (0.8 + r1 * 0.5)) / 2, hd = (sizeB * (0.8 + r2 * 0.5)) / 2;
          const ang = r2 * Math.PI, ca = Math.cos(ang), sa = Math.sin(ang);
          const corner = (sx: number, sz: number) => new THREE.Vector2(jx + sx * ca - sz * sa, jz + sx * sa + sz * ca);
          const ring = [corner(-hw, -hd), corner(hw, -hd), corner(hw, hd), corner(-hw, hd)];
          markBox(jx - hw, jz - hd, jx + hw, jz + hd, 2, 3.0);

          const gy = this.terrain.heightAt(jx, jz);
          const h = 3.6 + hash(jx * 0.9 + jz * 2.3) * 3.8;
          const cc = new THREE.Color(facadeColor(hash(jx * 0.31 + jz * 0.77))).multiplyScalar(0.86);
          const rc = new THREE.Color(hash(jz * 0.41 + jx * 0.19) < 0.45
            ? ROOF_TILE[Math.floor(hash(jx * 1.1) * ROOF_TILE.length) % ROOF_TILE.length]
            : ROOF_METAL[Math.floor(hash(jz * 1.3) * ROOF_METAL.length) % ROOF_METAL.length]);
          satTint.setRGB(Math.min(0.92, sat.r * 1.1), Math.min(0.92, sat.g * 1.1), Math.min(0.92, sat.b * 1.1));
          rc.lerp(satTint, 0.70);

          if (outer) {
            addSlopedRoof(solid, ring, gy + h, 1.4 + r1 * 1.4, rc, 1);
          } else {
            addWalls(solid, ring, gy - 1.2, gy + h, cc, 2, 0, r1);
            addSlopedRoof(solid, ring, gy + h, 1.4 + r1 * 1.4, rc, 1);
          }
          filled++;
        }
      }
    }

    // Per-tile material clones: they start fully transparent and fade in via stepTileFades (anti pop-in).
    const mats = this.cloneTileMats();
    const sm = makeMesh(solid, mats.solid);
    if (sm) group.add(sm);
    const wm = makeMesh(liquid, mats.water);
    if (wm) { wm.renderOrder = 1; group.add(wm); }

    // 4. Hybrid 1:1 3D Tropical Trees (Satellite Green-Pixel Canopy Detection + OSM Forests)
    //    The scatter scan is expensive, so it is queued here and time-sliced across frames by
    //    processTreeJobs(). The buildings/roads are already visible while the canopy fills in.
    if (!isPlaceholder && qp.trees && key && bounds) {
      const gridN = outer ? 52 : (qp.id === 'medium' ? 64 : 72);
      const spanX = Math.max(1, bounds.maxX - bounds.minX);
      const spanZ = Math.max(1, bounds.maxZ - bounds.minZ);
      this.treeJobs.set(key, {
        key, group, occ, bounds,
        focusX: focus.x, focusZ: focus.z,
        outer, gridN,
        cellW: spanX / gridN, cellD: spanZ / gridN,
        maxR2: qp.treeBudget.maxDist * qp.treeBudget.maxDist,
        row: 0, spawned: [],
        boundingSphere: tileBoundingSphere,
      });
    }

    this.group.add(group);
    return { group, lights: lightInst, mats };
  }

  /** Scatter one canopy-grid row. Called from processTreeJobs with a small per-frame budget. */
  private scatterTreeRow(job: TreeJob) {
    const { bounds, gridN, cellW, cellD, maxR2, occ } = job;
    const spanX = Math.max(1, bounds.maxX - bounds.minX);
    const spanZ = Math.max(1, bounds.maxZ - bounds.minZ);
    const occScaleX = 128 / spanX, occScaleZ = 128 / spanZ;
    const gz = job.row;
    for (let gx = 0; gx < gridN; gx++) {
      const cx0 = bounds.minX + (gx + 0.5) * cellW;
      const cz0 = bounds.minZ + (gz + 0.5) * cellD;
      const dcx = cx0 - job.focusX, dcz = cz0 - job.focusZ;
      if (dcx * dcx + dcz * dcz >= maxR2) continue;

      const ox = Math.max(0, Math.min(127, Math.floor((cx0 - bounds.minX) * occScaleX)));
      const oz = Math.max(0, Math.min(127, Math.floor((cz0 - bounds.minZ) * occScaleZ)));
      const cell = occ[oz * 128 + ox];
      if ((cell & (1 | 2 | 4)) !== 0) continue;

      const inOsmForest = (cell & 8) !== 0;
      const sat = this.terrain.sampleSatellite(cx0, cz0);
      const satGreen = sat ? sat.veg >= 0.13 : false;
      const osmGreen = inOsmForest && (!sat || (sat.veg >= 0.06 && sat.roof < 0.25));
      if (!satGreen && !osmGreen) continue;

      const vegStrength = sat ? Math.max(sat.veg, inOsmForest ? 0.45 : 0) : 0.5;
      if (vegStrength < 0.20 && hash(gx * 7.1 + gz * 3.3) > vegStrength * 3.8) continue;

      // Dense canopy gets two trees per cell; sparse vegetation gets one (after jitter).
      const count = vegStrength > 0.48 ? 2 : 1;
      for (let k = 0; k < count; k++) {
        const jx = bounds.minX + (gx + 0.2 + hash(gx * 13.7 + gz * 3.1 + k * 7.3) * 0.6) * cellW;
        const jz = bounds.minZ + (gz + 0.2 + hash(gz * 19.3 + gx * 5.7 + k * 11.9) * 0.6) * cellD;
        const dx = jx - job.focusX, dz = jz - job.focusZ;
        const d2 = dx * dx + dz * dz;
        if (d2 >= maxR2) continue;
        if (this.terrain.waterAt(jx, jz) > 0.15 || this.isNearRunway(jx, jz)) continue;
        const y = this.terrain.heightAt(jx, jz);
        job.spawned.push({ x: jx, y, z: jz, d2, veg: vegStrength });
      }
    }
  }

  private processTreeJobs(budgetMs: number) {
    if (!this.treeJobs.size) return;
    const t0 = performance.now();
    for (const job of this.treeJobs.values()) {
      const entry = this.tiles.get(job.key);
      if (!entry || entry.group !== job.group) { this.treeJobs.delete(job.key); continue; }
      while (job.row < job.gridN && performance.now() - t0 < budgetMs) {
        this.scatterTreeRow(job);
        job.row++;
      }
      if (job.row >= job.gridN) {
        this.finishTreeJob(job);
        this.treeJobs.delete(job.key);
        // Break after completing one tree job so multiple heavy InstancedMeshes are never built in one frame
        break;
      }
      if (performance.now() - t0 >= budgetMs) break;
    }
  }

  private finishTreeJob(job: TreeJob) {
    const qp = this.profile;
    const trees = job.spawned;
    if (!trees.length) return;
    trees.sort((a, b) => a.d2 - b.d2);
    const treeBudget = job.outer ? Math.min(qp.treeBudget.count, 450) : qp.treeBudget.count;
    if (trees.length > treeBudget) trees.length = treeBudget;

    // Distribute 100% of trees exclusively across the compressed GLB Oak models (Tree 1 & Tree 2 variants)
    const buckets: [TreeSpawn[], TreeSpawn[]] = [[], []];
    for (const t of trees) {
      const vIdx = hash(t.x * 5.3 + t.z * 2.9) < 0.5 ? 0 : 1;
      buckets[vIdx].push(t);
    }

    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();
    const addInstances = (list: TreeSpawn[], geo: THREE.BufferGeometry, mat: THREE.Material, yOffset: number) => {
      if (!list.length) return;
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      for (let i = 0; i < list.length; i++) {
        const tp = list[i];
        const r1 = hash(tp.x * 1.7 + tp.z * 2.3), r2 = hash(tp.z * 4.1 + tp.x * 0.9);
        const h = (7.0 + r1 * 8.5 + tp.veg * 3.0) / TREE_MODEL_HEIGHT;
        const wScale = h * (0.85 + r2 * 0.30);
        dummy.position.set(tp.x, tp.y + yOffset, tp.z);
        dummy.rotation.set(0, r2 * Math.PI * 2, 0);
        dummy.scale.set(wScale, h, wScale);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
        // Neutral white-balanced variation keeps trunks/foliage true
        const v = 0.90 + hash(tp.x * 9.3 + tp.z * 5.1) * 0.16;
        tint.setRGB(v, v, v);
        inst.setColorAt(i, tint);
      }
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.boundingSphere = job.boundingSphere;
      inst.frustumCulled = true;
      job.group.add(inst);
    };

    const glbGeos = getGlbTreeGeometries();
    const glbMat = getGlbTreeMaterial();
    // Per-tile tree material clone so the canopy fades with the tile (entry guaranteed alive:
    // processTreeJobs drops jobs whose tile was pruned before calling finishTreeJob).
    const entry = this.tiles.get(job.key);
    if (entry && !entry.mats.tree) {
      const treeMat = glbMat.clone();
      treeMat.opacity = entry.fade;
      treeMat.transparent = entry.fade < 0.999;
      entry.mats.tree = treeMat;
    }
    const treeMat = (entry && entry.mats.tree) || glbMat;
    for (let v = 0; v < 2; v++) {
      addInstances(buckets[v], glbGeos[v], treeMat, -0.2);
    }
  }

  rebase(np: Projection) {
    this.proj = np;
    this.runwayZones.length = 0;
    if (this.activeAirports.length) this.updateRunwayZones(this.activeAirports);
    for (const [, t] of [...this.tiles]) {
      this.group.remove(t.group);
      disposeGroup(t.group);
      disposeTileMats(t.mats);
    }
    this.tiles.clear();
    this.requested.clear();
  }

  dispose() {
    for (const t of this.tiles.values()) {
      this.group.remove(t.group);
      disposeGroup(t.group);
      disposeTileMats(t.mats);
    }
    this.tiles.clear();
    this.requested.clear();
    this.solidMat.dispose();
    this.waterMat.dispose();
    this.roadMat.dispose();
    this.lightMat.dispose();
    this.poleMat.dispose();
    this.group.removeFromParent();
  }
}
