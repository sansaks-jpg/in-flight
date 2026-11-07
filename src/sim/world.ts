import * as THREE from 'three';
import { Projection, wrap360, D2R, R2D, clamp, haversine, destination } from './geo';
import { Terrain, DetailLayer } from './terrain';
import { Structures } from './structures';
import { Airport, Runway, Surface, airportsNear, getAirfield, isPaved } from '../data/airports';
import { buildAirfieldMeshes } from './airfieldMesh';
import { synthGround, SynthGround, Rect } from './airportGround';
import { QualityPreset } from './storage';
import { QUALITY } from './quality';
import { sunPosition, simNowMs, nightLights } from './clock';
import { CloudField, makeCloudTexture } from './clouds';
import { LightningSystem } from './lightning';
import { precipVisibility } from './liveWeather';

/** The simulator always runs on real-world UTC time (see clock.ts); there is no manual time-of-day override. */
export type TimeOfDay = 'live';
/** PAPI glide-slope thresholds per lamp (degrees) — module constant so the per-frame loop allocates nothing. */
const PAPI_ANGLES = [2.5, 2.83, 3.17, 3.5];

export interface RunwayGeom {
  ap: Airport;
  rw: Runway;
  cx: number;
  cz: number;
  len: number;
  wid: number;
  hdg: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

export interface Threshold {
  ap: Airport;
  rw: Runway;
  end: 'le' | 'he';
  ident: string;
  x: number;
  z: number;
  hdg: number;
  len: number;
  wid: number;
  elev: number;
  lat: number;
  lon: number;
  /** Displaced threshold distance (m). x/z/lat/lon above are the LANDING threshold (displaced), start* is the physical runway end. */
  dispM: number;
  startX: number;
  startZ: number;
  startLat: number;
  startLon: number;
  /** Full physical runway length available for take-off from the physical end (m). */
  fullLen: number;
  surface: Surface;
  lit: boolean;
}

// Sky palette. Colours are authored as sRGB hex and converted to linear by THREE.Color, so the
// sky shader (which now writes through <colorspace_fragment>) and the fog colour land on exactly
// the same value on screen. That is what removes the hard, table-edge horizon: distant terrain
// fades into precisely the colour the sky has at 0 degrees elevation.
const SKY = {
  day: {
    zen: new THREE.Color(0x3977be),
    hor: new THREE.Color(0xc2d9ef),
    haze: new THREE.Color(0xe2ecf6),
    sunEl: 52,
    sunAz: 140,
    sun: new THREE.Color(0xfff3df),
    dir: 3.1,
    hemi: 0.85,
    ground: new THREE.Color(0x3a352d),
    fog: 0.000034,
  },
  sunset: {
    zen: new THREE.Color(0x2a406e),
    hor: new THREE.Color(0xffb074),
    haze: new THREE.Color(0xffd3a8),
    sunEl: 6,
    sunAz: 250,
    sun: new THREE.Color(0xffb066),
    dir: 2.7,
    hemi: 0.75,
    ground: new THREE.Color(0x2e241f),
    fog: 0.000042,
  },
  // Civil/nautical twilight (sun about 5 degrees below the horizon): deep blue zenith, rose horizon band.
  dusk: {
    zen: new THREE.Color(0x14214a),
    hor: new THREE.Color(0xb8708a),
    haze: new THREE.Color(0x7d6585),
    sunEl: -5,
    sunAz: 260,
    sun: new THREE.Color(0xff8a5a),
    dir: 0.9,
    hemi: 0.5,
    ground: new THREE.Color(0x1a1820),
    fog: 0.000044,
  },
  // Night: faint moonlight, near-black sky with stars.
  night: {
    zen: new THREE.Color(0x01030a),
    hor: new THREE.Color(0x0a1424),
    haze: new THREE.Color(0x0a1322),
    sunEl: -30,
    sunAz: 0,
    sun: new THREE.Color(0x6f86b5),
    dir: 0.32,
    hemi: 0.36,
    ground: new THREE.Color(0x090b10),
    fog: 0.000032,
  },
};
type SkyPal = typeof SKY.day;
// Solar-elevation keyframes (degrees) -> palette. Blended continuously, so dawn/dusk/night are real.
const SKY_KEYS: [number, SkyPal][] = [[-14, SKY.night], [-5, SKY.dusk], [2, SKY.sunset], [26, SKY.day]];
const skyScratch: SkyPal = {
  zen: new THREE.Color(), hor: new THREE.Color(), haze: new THREE.Color(), sunEl: 0, sunAz: 0, sun: new THREE.Color(), dir: 0, hemi: 0, ground: new THREE.Color(), fog: 0,
};
function blendSky(el: number): SkyPal {
  const K = SKY_KEYS;
  let a = K[0][1], b = K[0][1], t = 0;
  if (el >= K[K.length - 1][0]) { a = b = K[K.length - 1][1]; }
  else if (el > K[0][0]) {
    for (let i = 0; i < K.length - 1; i++) {
      if (el <= K[i + 1][0]) { a = K[i][1]; b = K[i + 1][1]; t = (el - K[i][0]) / (K[i + 1][0] - K[i][0]); break; }
    }
  }
  const o = skyScratch;
  o.zen.copy(a.zen).lerp(b.zen, t); o.hor.copy(a.hor).lerp(b.hor, t); o.haze.copy(a.haze).lerp(b.haze, t);
  o.sun.copy(a.sun).lerp(b.sun, t); o.ground.copy(a.ground).lerp(b.ground, t);
  o.dir = a.dir + (b.dir - a.dir) * t; o.hemi = a.hemi + (b.hemi - a.hemi) * t; o.fog = a.fog + (b.fog - a.fog) * t;
  return o;
}

const hashN = (a: number, b: number, s = 0) => {
  const v = Math.sin(a * 127.1 + b * 311.7 + s * 74.7) * 43758.5453;
  return v - Math.floor(v);
};

// Scratch colours for setSun (runs on the 15 s solar clock, but stays allocation-free anyway).
const tmpCloudTint = new THREE.Color();
const CLOUD_WHITE = new THREE.Color(1, 1, 1);

function runwayTexture(rw: Runway, len: number, wid: number) {
  if (!isPaved(rw.surface)) return unpavedRunwayTexture(rw, len, wid);
  const W = 512, Hh = Math.min(6144, Math.max(1024, Math.round(len * 1.6)));
  const c = document.createElement('canvas'); c.width = W; c.height = Hh;
  const g = c.getContext('2d')!;
  g.fillStyle = '#34363a'; g.fillRect(0, 0, W, Hh);
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(${hashN(i, 4) > 0.5 ? 255 : 0},${hashN(i, 4) > 0.5 ? 255 : 0},${hashN(i, 4) > 0.5 ? 255 : 0},0.035)`;
    g.fillRect(hashN(i, 5) * W, hashN(i, 6) * Hh, 2 + hashN(i, 7) * 14, 2 + hashN(i, 8) * 40);
  }
  const sx = W / wid, sy = Hh / len;
  const rect = (x: number, y: number, w: number, h: number) => g.fillRect(x * sx, Hh - (y + h) * sy, w * sx, h * sy);
  // ---- ICAO Annex 14 (Ch. 5.2) runway markings, true metres ----
  g.fillStyle = '#f0f0ec';
  // runway side stripes: 0.9 m wide (0.45 m on narrow runways), 1.5 m inside the edge
  const edgeW = wid >= 30 ? 0.9 : 0.45;
  rect(1.5, 0, edgeW, len); rect(wid - 1.5 - edgeW, 0, edgeW, len);
  // centre line: 30 m stripes / 20 m gaps (ICAO: stripe+gap = 50 m), width 0.9 m (0.45 m on non-precision)
  const clW = len >= 1500 ? 0.9 : 0.45;
  const sparse = (len - 2 * 12) % 50; void sparse;
  for (let y = 12; y + 30 <= len - 12; y += 50) rect(wid / 2 - clW / 2, y, clW, 30);
  // threshold stripes: number by runway width (18 m: 4, 23 m: 6, 30 m: 8, 45 m: 12, 60 m: 16), 30 m long, 1.8 m wide
  const nTot = wid >= 60 ? 16 : wid >= 45 ? 12 : wid >= 30 ? 8 : wid >= 23 ? 6 : 4;
  const half = nTot / 2, stripeW = 1.8, gapW = wid >= 45 ? 1.8 : 1.5;
  const centreGap = nTot >= 12 ? 3.6 : 1.8; // gap at the centre line for the 2 groups
  for (const end of [0, 1]) {
    const at = (d: number, h: number) => (end ? len - d - h : d);
    for (let grp = 0; grp < 2; grp++) {
      for (let i = 0; i < half; i++) {
        const off = centreGap / 2 + i * (stripeW + gapW);
        const xx = grp ? wid / 2 + off : wid / 2 - off - stripeW;
        rect(xx, at(6, 30), stripeW, 30);
      }
    }
    // aiming-point marking (distance from threshold / stripe length & width / inner spacing depend on runway length)
    if (len >= 800) {
      const ap = len >= 2400 ? 400 : len >= 1200 ? 300 : 250;
      const sl = len >= 2400 ? 60 : len >= 1200 ? 45 : 30, sw = len >= 2400 ? 10 : len >= 1200 ? 8 : 6, inner = len >= 1200 ? 18 : 9;
      rect(wid / 2 - inner / 2 - sw, at(ap, sl), sw, sl); rect(wid / 2 + inner / 2, at(ap, sl), sw, sl);
      // touchdown-zone stripes (22.5 m long, 1.8 m wide): 3 / 2 / 2 / 1 / 1 per side at 150 m intervals
      if (len >= 1500) {
        const tdz: [number, number][] = [[150, 3], [300, 2], [450, 2], [600, 1], [750, 1]];
        for (const [d, cnt] of tdz) {
          if (Math.abs(d - ap) < 70 || d + 30 > len / 2) continue;
          for (let i = 0; i < cnt; i++) {
            const off = 9 + i * (1.8 + 1.5);
            rect(wid / 2 - off - 1.8, at(d, 22.5), 1.8, 22.5); rect(wid / 2 + off, at(d, 22.5), 1.8, 22.5);
          }
        }
      }
    }
    const label = end ? rw.he : rw.le;
    g.save();
    g.translate(W / 2, end ? Hh - (len - 60 - 8) * sy : Hh - 70 * sy);
    if (end) g.rotate(Math.PI);
    g.fillStyle = '#f2f2ee';
    const fs = Math.min(wid * 0.55, 18) * sx * 1.35;
    g.font = `bold ${fs}px "Arial Narrow", Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'top';
    g.save(); g.scale(1, sy / sx); const m = label.match(/^(\d+)([LRC]?)$/);
    if (m) { g.fillText(m[1], 0, 0); if (m[2]) g.fillText(m[2], 0, fs * 1.0); } else g.fillText(label, 0, 0);
    g.restore(); g.restore();
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; return tex;
}

/** Grass / gravel / dirt strips: no paint beyond the numbers and a faint centreline, surface colour matches the real material. */
function unpavedRunwayTexture(rw: Runway, len: number, wid: number) {
  const W = 128, Hh = Math.min(2048, Math.max(256, Math.round(len / 3)));
  const base = rw.surface === 'G' ? '#5d7a3a' : rw.surface === 'V' ? '#9b9486' : rw.surface === 'D' ? '#9a7b55' : '#7d7a55';
  const c = document.createElement('canvas'); c.width = W; c.height = Hh;
  const g = c.getContext('2d')!;
  g.fillStyle = base; g.fillRect(0, 0, W, Hh);
  for (let i = 0; i < 900; i++) {
    const l = hashN(i, 11) > 0.5;
    g.fillStyle = `rgba(${l ? 255 : 0},${l ? 255 : 0},${l ? 255 : 0},0.05)`;
    g.fillRect(hashN(i, 12) * W, hashN(i, 13) * Hh, 2 + hashN(i, 14) * 10, 2 + hashN(i, 15) * 24);
  }
  const sy = Hh / len, sx = W / wid;
  g.fillStyle = 'rgba(240,240,232,0.75)';
  // threshold bars + dashed centreline (what a surveyed strip typically carries)
  for (const end of [0, 1]) g.fillRect(0.12 * W, end ? 0 : Hh - 1.2 * sy * 6, 0.76 * W, 1.2 * sy * 6);
  for (let y = 40; y < len - 40; y += 60) g.fillRect(W / 2 - 0.4 * sx, Hh - (y + 25) * sy, 0.8 * sx, 25 * sy);
  for (const end of [0, 1]) {
    g.save(); g.translate(W / 2, end ? Hh - (len - 14) * sy : Hh - 14 * sy - 0); if (end) g.rotate(Math.PI);
    g.font = `bold ${Math.min(wid * 0.8, 26) * sx}px Arial`; g.textAlign = 'center'; g.textBaseline = 'top';
    g.save(); g.scale(1, Math.max(0.2, sy / sx)); g.fillText(end ? rw.he : rw.le, 0, -(end ? 0 : 36 * sx * 0.0)); g.restore(); g.restore();
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; return tex;
}

// Low-poly static parked airliner with distinctive Indonesian livery tail colors
function createStaticAirliner(airlineColor: number, accentColor = 0xffffff): THREE.Group {
  const group = new THREE.Group();
  const whiteMat = new THREE.MeshLambertMaterial({ color: 0xf8fafc });
  const finMat = new THREE.MeshLambertMaterial({ color: airlineColor });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x1e293b });
  const accentMat = new THREE.MeshLambertMaterial({ color: accentColor });

  // Fuselage body
  const body = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 28, 12), whiteMat);
  body.rotation.x = Math.PI / 2;
  body.position.y = 3.6;
  group.add(body);

  // Aerodynamic nose cone
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 1.8, 5.2, 12), whiteMat);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 3.6, 16.6);
  group.add(nose);

  // Cockpit windshield
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.65, 1.8), darkMat);
  windshield.position.set(0, 4.5, 15.3);
  group.add(windshield);

  // Swept wings
  const wingGeo = new THREE.BoxGeometry(26, 0.35, 4.4);
  const wings = new THREE.Mesh(wingGeo, whiteMat);
  wings.position.set(0, 3.2, 0.5);
  group.add(wings);

  // Vertical winglets & twin turbofan engines
  for (const sgn of [-1, 1]) {
    const winglet = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.4, 1.2), finMat);
    winglet.position.set(sgn * 13, 3.9, 0.5);
    group.add(winglet);

    const engine = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 3.8, 10), whiteMat);
    engine.rotation.x = Math.PI / 2;
    engine.position.set(sgn * 5.2, 2.1, 1.2);
    group.add(engine);

    const intake = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.5, 10), darkMat);
    intake.rotation.x = Math.PI / 2;
    intake.position.set(sgn * 5.2, 2.1, 3.2);
    group.add(intake);
  }

  // Horizontal stabilizers
  const hStab = new THREE.Mesh(new THREE.BoxGeometry(9, 0.25, 2.2), whiteMat);
  hStab.position.set(0, 4.2, -12);
  group.add(hStab);

  // Vertical stabilizer (tailfin with Indonesian airline livery)
  const finGeo = new THREE.BoxGeometry(0.35, 5.5, 3.8);
  const fin = new THREE.Mesh(finGeo, finMat);
  fin.position.set(0, 6.2, -11.5);
  fin.rotation.x = -0.35;
  group.add(fin);

  // Fuselage airline cheatline
  const band = new THREE.Mesh(new THREE.BoxGeometry(3.7, 0.45, 22), accentMat);
  band.position.set(0, 3.6, 1);
  group.add(band);

  return group;
}

// Articulated passenger boarding bridge (Garbarata)
function createJetway(glassMat: THREE.Material, steelMat: THREE.Material): THREE.Group {
  const jGroup = new THREE.Group();

  const rotunda = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 4.2, 10), steelMat);
  rotunda.position.set(0, 5.5, 0);
  jGroup.add(rotunda);

  const tunnel = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.8, 14), glassMat);
  tunnel.position.set(0, 5.4, 7);
  jGroup.add(tunnel);

  const stanchion = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 4.5, 6), steelMat);
  stanchion.position.set(0, 2.25, 10);
  jGroup.add(stanchion);

  const cab = new THREE.Mesh(new THREE.BoxGeometry(3.2, 3.0, 3.6), steelMat);
  cab.position.set(1.2, 5.3, 14.5);
  cab.rotation.y = 0.32;
  jGroup.add(cab);

  return jGroup;
}

// Ground Service Equipment (GSE): pushback tug, baggage carts, fuel truck
function createGseVehicles(): THREE.Group {
  const gse = new THREE.Group();
  const yellowMat = new THREE.MeshLambertMaterial({ color: 0xf59e0b });
  const whiteMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x1f2937 });

  // Aircraft pushback tug
  const tug = new THREE.Mesh(new THREE.BoxGeometry(3.8, 1.4, 6.5), yellowMat);
  tug.position.set(0, 0.7, 18);
  gse.add(tug);
  const tugCab = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.2, 2.2), darkMat);
  tugCab.position.set(0, 1.8, 19);
  gse.add(tugCab);

  // Baggage carts
  const bTug = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.2, 3.0), whiteMat);
  bTug.position.set(-6, 0.6, 8);
  gse.add(bTug);
  for (let c = 1; c <= 2; c++) {
    const cart = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 2.4), darkMat);
    cart.position.set(-6, 0.5, 8 - c * 3.2);
    gse.add(cart);
  }

  // Fuel bowser truck
  const fuelTruck = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.2, 8.5), whiteMat);
  fuelTruck.position.set(14, 1.1, 2);
  gse.add(fuelTruck);

  return gse;
}

// Orange-and-white banded airfield windsock
function createWindsock(): { group: THREE.Group; cone: THREE.Mesh } {
  const wGroup = new THREE.Group();
  const mastMat = new THREE.MeshLambertMaterial({ color: 0x94a3b8 });
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 6.5, 8), mastMat);
  mast.position.y = 3.25;
  wGroup.add(mast);

  const coneGeo = new THREE.CylinderGeometry(0.2, 0.55, 2.8, 10, 1, true);
  coneGeo.rotateX(Math.PI / 2);
  coneGeo.translate(0, 0, 1.4); // Pivot cleanly at wide mouth hoop
  const sockMat = new THREE.MeshLambertMaterial({ color: 0xf97316, side: THREE.DoubleSide });
  const cone = new THREE.Mesh(coneGeo, sockMat);
  cone.position.set(0, 6.2, 0);
  wGroup.add(cone);

  return { group: wGroup, cone };
}

interface AlsStrobe {
  mesh: THREE.Mesh;
  order: number;
}

interface AirportScene {
  group: THREE.Group;
  ap: Airport;
  papis: { th: Threshold; boxes: THREE.Mesh[]; dirx: number; dirz: number; px: number; pz: number; elev: number }[];
  windsocks: { group: THREE.Group; cone: THREE.Mesh }[];
  strobes: AlsStrobe[];
}

export class World {
  scene = new THREE.Scene();
  terrain: Terrain;
  detail: DetailLayer;
  structures: Structures;
  sunLight: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sky: THREE.Mesh;
  skyMat: THREE.ShaderMaterial;
  /** Live-weather cloud field (one instanced draw call; see clouds.ts). */
  clouds: CloudField;
  /** Cloud-to-ground lightning with a distance hook for procedural thunder (see lightning.ts). */
  lightning: LightningSystem;
  airports = new Map<string, AirportScene>();
  /** Reused buffer for structures.update (no per-frame array allocation). */
  private airportList: Airport[] = [];
  runways: RunwayGeom[] = [];
  tod: TimeOfDay = 'live';
  /** Lighting direction (never below ~4 degrees: at night it acts as faint moonlight). */
  sunDir = new THREE.Vector3();
  /** True solar position at the aircraft, from the real UTC clock. */
  sunElevation = 45;
  sunAzimuth = 180;
  nightAmount = 0;
  private cloudColor = new THREE.Color(0xffffff);
  /** Shadowed flank tint for the cloud impostors (derived from cloudColor in setSun). */
  cloudShadow = new THREE.Color(0.5, 0.53, 0.6);
  /** Live wind (m/s, world axes) at the cloud decks, refreshed by the game at ~1 Hz (setCloudWind). */
  private windDriftX = 0;
  private windDriftZ = 0;
  /** Live (real-world) weather state driving clouds, light, fog and rain. */
  wx = { cover: [0.1, 0, 0.1] as [number, number, number], baseMsl: 1800, rain: 0, snow: 0, visM: 30000, visEffM: 30000, thunder: false };
  private _grey = new THREE.Color();
  private lastSunClockMs = 0;
  private sunFog = new THREE.FogExp2(0xffffff, 0.00003);
  private papiOn = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private papiOff = new THREE.MeshBasicMaterial({ color: 0xff2200 });
  private strobeOn = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private strobeOff = new THREE.MeshBasicMaterial({ color: 0xffe899 });
  private frustum = new THREE.Frustum();
  private projScreenMatrix = new THREE.Matrix4();
  private lastAcLat = 0;
  private lastAcLon = 0;
  /** Preallocated terrain callback for the lightning strikes (no closure churn in the frame loop). */
  private heightAtFn = (x: number, z: number): number => this.terrain.heightAt(x, z);

  constructor(
    public proj: Projection,
    public opts: { quality: QualityPreset; style: string; tod: TimeOfDay; maxAniso: number }
  ) {
    this.terrain = new Terrain(proj, opts.quality, this.scene, opts.maxAniso);
    this.terrain.styleId = opts.style;
    this.detail = new DetailLayer(proj, this.terrain, this.scene);
    this.detail.styleId = opts.style;
    this.structures = new Structures(proj, this.terrain, this.scene, opts.quality, opts.maxAniso);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x887766, 1.2);
    this.scene.add(this.hemi);
    this.sunLight = new THREE.DirectionalLight(0xffffff, 2.4);
    this.scene.add(this.sunLight, this.sunLight.target);

    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        zen: { value: new THREE.Color() },
        hor: { value: new THREE.Color() },
        haze: { value: new THREE.Color() },
        sunDir: { value: new THREE.Vector3(0, 1, 0) },
        sunCol: { value: new THREE.Color() },
        stars: { value: 0 },
      },
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position.z = gl_Position.w*0.9999; }',
      // Soft, continuous horizon:
      //  - a wide haze band that saturates at exactly the fog colour right at 0 deg elevation,
      //  - a gentle zenith falloff (no visible gradient bands / hard cut at the skyline),
      //  - the sun as a tight disc plus two broad glow lobes.
      // The final <colorspace_fragment> include is essential: without it these linear values were
      // written straight into an sRGB framebuffer, so the sky was darker than the fogged terrain
      // beneath it — the mismatch is what read as a sharp horizon line.
      fragmentShader: `varying vec3 vD; uniform vec3 zen; uniform vec3 hor; uniform vec3 haze; uniform vec3 sunDir; uniform vec3 sunCol; uniform float stars;
        void main(){
          vec3 v = normalize(vD);
          float h = max(v.y, 0.0);
          vec3 c = mix(hor, zen, pow(h, 0.42));
          float band = exp(-h * 22.0);
          c = mix(c, haze, band * 0.88);
          if (v.y < 0.0) c = mix(haze, hor, clamp(-v.y * 3.0, 0.0, 1.0));
          float s = max(dot(v, normalize(sunDir)), 0.0);
          c += sunCol * (pow(s, 900.0) * 2.2 + pow(s, 20.0) * 0.14 + pow(s, 3.0) * 0.06);
          if (stars > 0.01 && v.y > 0.02) {
            vec3 d = v * 140.0; vec3 id = floor(d); vec3 f = fract(d) - 0.5;
            float h = fract(sin(dot(id, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
            float tw = step(0.978, h) * smoothstep(0.32, 0.0, length(f));
            c += vec3(0.85, 0.9, 1.0) * tw * stars * smoothstep(0.02, 0.22, v.y) * (0.45 + 0.55 * fract(h * 91.7));
          }
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);

    this.clouds = new CloudField(this.scene, QUALITY[opts.quality]?.clouds ?? 40, makeCloudTexture());
    this.lightning = new LightningSystem(this.scene);
    this.updateSunFromClock(true);
  }

  setQuality(q: QualityPreset) {
    if (this.opts.quality === q) return;
    this.opts.quality = q;
    this.terrain.setQuality(q);
    this.structures.setQuality(q);
    this.structures.setNight(this.nightAmount);
    this.clouds.setBudget(QUALITY[q].clouds);
    // Terminal detail / airport count is preset-specific. Rebuild the (small) airport set
    // around aircraft current position immediately so a quality change doesn't leave heavy meshes.
    const lat = this.lastAcLat || this.proj.lat(0);
    const lon = this.lastAcLon || this.proj.lon(0);
    this.rebuildAirports(lat, lon, true);
  }

  /** Overall sky obscuration 0..1 (drives overcast lighting and the grey sky). */
  overcast() { return Math.min(1, Math.max(this.wx.cover[0], this.wx.cover[1] * 0.85, this.wx.cover[2] * 0.4)); }

  /** Apply real weather: cloud layers (low / mid / high), ceiling, precipitation, visibility. */
  setLiveWeather(cover: [number, number, number], baseAglM: number | null, groundM: number, rain: number, snow: number, visM: number, thunder: boolean, midBaseMsl = 3100, highBaseMsl = 9160) {
    this.wx.cover = cover; this.wx.baseMsl = groundM + (baseAglM ?? 1800); this.wx.rain = rain; this.wx.snow = snow; this.wx.visM = visM; this.wx.thunder = thunder;
    // precipitation haze: showers cut horizontal visibility beyond the station METAR value
    this.wx.visEffM = precipVisibility(visM, rain, snow);
    this.clouds.setLiveWeather(cover, this.wx.baseMsl, midBaseMsl, highBaseMsl);
    this.lightning.setActive(thunder);
    this.updateSunFromClock(true);
  }

  /** Live wind (m/s, world axes) at the cloud decks; the game refreshes this at ~1 Hz from the wind profile. */
  setCloudWind(x: number, z: number) { this.windDriftX = x; this.windDriftZ = z; }

  /**
   * Recomputes the sun from the real-world UTC clock at the aircraft's current position
   * (or the departure airfield before the flight starts). Cheap; throttled by the caller.
   */
  updateSunFromClock(force = false) {
    const now = simNowMs();
    if (!force && now - this.lastSunClockMs < 15000) return;
    this.lastSunClockMs = now;
    const lat = this.lastAcLat || this.proj.lat(0), lon = this.lastAcLon || this.proj.lon(0);
    const sp = sunPosition(now, lat, lon);
    this.setSun(sp.elevation, sp.azimuth);
  }

  setSun(elDeg: number, azDeg: number) {
    this.sunElevation = elDeg; this.sunAzimuth = azDeg;
    const c = blendSky(elDeg);
    const ov = this.overcast(), wet = Math.min(1, this.wx.rain + this.wx.snow);
    if (ov > 0.02) {
      // overcast / rainy sky: desaturate toward a grey whose brightness follows the real light level
      const lum = c.hor.r * 0.3 + c.hor.g * 0.59 + c.hor.b * 0.11, k = Math.min(1, ov * (0.55 + 0.3 * wet));
      this._grey.setRGB(lum * (0.78 - 0.2 * wet), lum * (0.8 - 0.2 * wet), lum * (0.84 - 0.18 * wet));
      c.zen.lerp(this._grey, Math.min(1, k + 0.1)); c.hor.lerp(this._grey, k); c.haze.lerp(this._grey, k);
    }
    const az = azDeg * D2R;
    const trueEl = elDeg * D2R;
    const skyDir = this.skyMat.uniforms.sunDir.value as THREE.Vector3;
    skyDir.set(Math.sin(az) * Math.cos(trueEl), Math.sin(trueEl), -Math.cos(az) * Math.cos(trueEl)).normalize();
    // Light direction: keep above the horizon so terrain is lit from above (moonlight at night).
    const lel = Math.max(elDeg, 4) * D2R;
    this.sunDir.set(Math.sin(az) * Math.cos(lel), Math.sin(lel), -Math.cos(az) * Math.cos(lel)).normalize();
    this.skyMat.uniforms.zen.value.copy(c.zen);
    this.skyMat.uniforms.hor.value.copy(c.hor);
    this.skyMat.uniforms.haze.value.copy(c.haze);
    this.skyMat.uniforms.sunCol.value.copy(c.sun);
    this.skyMat.uniforms.stars.value = Math.max(0, Math.min(1, (-elDeg - 3) / 10));
    this.sunLight.color.copy(c.sun);
    this.sunLight.intensity = c.dir * (1 - 0.72 * Math.pow(ov, 1.2));
    this.hemi.color.copy(c.zen).lerp(this.cloudColor.set(1, 1, 1), 0.5);
    this.hemi.groundColor.copy(c.ground);
    this.hemi.intensity = c.hemi * (1 + 0.18 * ov) * (1 - 0.25 * wet);
    // Exponential fog (see rationale in the original two-state version): same colour as the sky horizon haze.
    this.sunFog.color.copy(c.haze);
    // real visibility (Koschmieder: extinction = 3.912 / V), capped further by precipitation haze;
    // unlimited visibility leaves the scene's own aerial perspective alone
    const visM = this.wx.visEffM;
    const visD = visM < 20000 ? 3.912 / Math.max(150, visM) : 0;
    this.sunFog.density = Math.max(c.fog, visD * 0.9);
    this.scene.fog = this.sunFog;
    this.terrain.setEnvironment(c.haze, this.sunDir);
    this.detail.setEnvironment(c.haze, this.sunDir);
    this.nightAmount = nightLights(elDeg);
    this.structures.setNight(this.nightAmount);
    // Cloud tint: white by day, warm at sunset, dark grey-blue at night (scratch colours — no allocation).
    const dayL = clamp((elDeg + 6) / 14, 0, 1);
    tmpCloudTint.copy(c.hor).lerp(c.sun, 0.25).lerp(CLOUD_WHITE, clamp((elDeg - 2) / 20, 0, 1));
    this.cloudColor.setRGB(0.16, 0.19, 0.28).lerp(tmpCloudTint, dayL);
    this.cloudColor.multiplyScalar(1 - 0.38 * Math.min(1, ov * (0.4 + wet)));
    // shadow flank for the impostor shading: darker, pulled slightly toward the ground tone
    this.cloudShadow.copy(this.cloudColor).multiplyScalar(0.52).lerp(c.ground, 0.15);
  }

  setStyle(id: string) {
    this.terrain.setStyle(id);
    this.detail.setStyle(id);
  }

  // ---- geometry helpers ----
  thresholds(ap: Airport): Threshold[] {
    const out: Threshold[] = [];
    for (const rw of ap.runways) {
      const g = this.runwayGeom(ap, rw);
      const h2 = wrap360(g.hdg + 180);
      const mk = (end: 'le' | 'he'): Threshold => {
        const le = end === 'le';
        const hdg = le ? g.hdg : h2;
        const disp = Math.max(0, Math.min(le ? rw.dispLe : rw.dispHe, g.len * 0.5));
        const sx = le ? g.ax : g.bx, sz = le ? g.az : g.bz;
        const sLat = le ? rw.leLat : rw.heLat, sLon = le ? rw.leLon : rw.heLon;
        const fx = Math.sin(hdg * D2R), fz = -Math.cos(hdg * D2R);
        const [dLat, dLon] = disp > 0 ? destination(sLat, sLon, hdg, disp) : [sLat, sLon];
        return {
          ap, rw, end, ident: le ? rw.le : rw.he,
          x: sx + fx * disp, z: sz + fz * disp, hdg,
          len: g.len - disp, wid: g.wid, elev: ap.elev,
          lat: dLat, lon: dLon,
          dispM: disp, startX: sx, startZ: sz, startLat: sLat, startLon: sLon, fullLen: g.len,
          surface: rw.surface, lit: rw.lit,
        };
      };
      out.push(mk('le'), mk('he'));
    }
    return out;
  }

  runwayGeom(ap: Airport, rw: Runway): RunwayGeom {
    const p = this.proj;
    const ax = p.x(rw.leLon), az = p.z(rw.leLat);
    const bx = p.x(rw.heLon), bz = p.z(rw.heLat);
    const dx = bx - ax, dz = bz - az;
    return {
      ap, rw,
      cx: (ax + bx) / 2, cz: (az + bz) / 2,
      len: Math.hypot(dx, dz), wid: rw.width,
      hdg: wrap360(Math.atan2(dx, -dz) * R2D),
      ax, az, bx, bz,
    };
  }

  runwayAt(x: number, z: number, margin = 25) {
    for (const g of this.runways) {
      const dx = x - g.ax, dz = z - g.az;
      const h = g.hdg * D2R, fx = Math.sin(h), fz = -Math.cos(h);
      const along = dx * fx + dz * fz, across = dx * -fz + dz * fx;
      if (along > -margin && along < g.len + margin && Math.abs(across) < g.wid / 2 + margin) {
        return { g, along, across };
      }
    }
    return null;
  }

  // ---- airports / scenery ----
  private buildAirport(ap: Airport, detailed = true): AirportScene {
    const group = new THREE.Group();
    const papis: AirportScene['papis'] = [];
    const windsocks: AirportScene['windsocks'] = [];
    const strobes: AlsStrobe[] = [];

    const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff1c0 });
    const greenMat = new THREE.MeshBasicMaterial({ color: 0x38ff6a });

    ap.runways.forEach((rw) => {
      const g = this.runwayGeom(ap, rw);
      this.runways.push(g);

      const geo = new THREE.PlaneGeometry(g.wid, g.len);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshLambertMaterial({
        map: runwayTexture(rw, g.len, g.wid),
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });

      // Dark paved shoulder makes the runway unmistakable against satellite texture
      const shoulderGeo = new THREE.PlaneGeometry(g.wid + 16, g.len + 36);
      shoulderGeo.rotateX(-Math.PI / 2);
      const shoulder = new THREE.Mesh(
        shoulderGeo,
        new THREE.MeshLambertMaterial({ color: 0x2a2e32, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })
      );
      shoulder.position.set(g.cx, ap.elev + 0.05, g.cz);
      shoulder.rotation.y = -g.hdg * D2R;
      if (isPaved(rw.surface)) group.add(shoulder); else { shoulder.geometry.dispose(); (shoulder.material as THREE.Material).dispose(); }

      const m = new THREE.Mesh(geo, mat);
      m.position.set(g.cx, ap.elev + 0.12, g.cz);
      m.rotation.y = -g.hdg * D2R;
      group.add(m);

      // Edge lights
      const fx = Math.sin(g.hdg * D2R), fz = -Math.cos(g.hdg * D2R), rx = -fz, rz = fx;
      const n = Math.floor(g.len / 60) + 1;
      const edge = new THREE.InstancedMesh(new THREE.BoxGeometry(0.7, 0.5, 0.7), lightMat, n * 2 + 10);
      const dm = new THREE.Object3D();
      let k = 0;
      for (let i = 0; i < n; i++) {
        for (const sd of [-1, 1]) {
          dm.position.set(
            g.ax + fx * i * 60 + rx * sd * (g.wid / 2 + 1.5),
            ap.elev + 0.4,
            g.az + fz * i * 60 + rz * sd * (g.wid / 2 + 1.5)
          );
          dm.updateMatrix();
          edge.setMatrixAt(k++, dm.matrix);
        }
      }
      edge.count = k;
      edge.instanceMatrix.needsUpdate = true;
      edge.frustumCulled = false;
      if (rw.lit) group.add(edge);

      // Green threshold bars
      const thr = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.5, 1), greenMat, 24);
      let tk = 0;
      const dispOf = (end: number) => Math.max(0, Math.min(end ? rw.dispHe : rw.dispLe, g.len * 0.5));
      for (const end of [0, 1]) {
        const dd = dispOf(end);
        const bx = (end ? g.bx : g.ax) + fx * (end ? -1 : 1) * dd, bz = (end ? g.bz : g.az) + fz * (end ? -1 : 1) * dd;
        for (let i = -5; i <= 5; i++) {
          dm.position.set(
            bx + rx * i * (g.wid / 12) - fx * (end ? -1 : 1) * 1.5,
            ap.elev + 0.4,
            bz + rz * i * (g.wid / 12) - fz * (end ? -1 : 1) * 1.5
          );
          dm.updateMatrix();
          thr.setMatrixAt(tk++, dm.matrix);
        }
      }
      thr.count = tk;
      thr.frustumCulled = false;
      if (isPaved(rw.surface)) group.add(thr);

      // ALS (Approach Lighting System) with Sequenced Flashing Strobe Rabbit (15 stations extending 450m)
      if (isPaved(rw.surface) && rw.lit && g.len >= 1800) for (const end of [0, 1]) {
        const sgn = end ? 1 : -1;
        const bx = end ? g.bx : g.ax, bz = end ? g.bz : g.az;
        for (let i = 1; i <= 15; i++) {
          const sx = bx + fx * sgn * i * 30;
          const sz = bz + fz * sgn * i * 30;
          const sy = ap.elev + 0.6 + i * 0.32;

          const strobeBox = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.8), this.strobeOff);
          strobeBox.position.set(sx, sy, sz);
          group.add(strobeBox);
          strobes.push({ mesh: strobeBox, order: 15 - i });
        }
      }
    });

    // PAPI boxes for every runway end
    for (const th of this.thresholds(ap)) {
      if (!isPaved(th.surface) || th.len < 900) continue;
      const h = th.hdg * D2R, fx = Math.sin(h), fz = -Math.cos(h), rx = -fz, rz = fx;
      const px = th.x + fx * 320 - rx * (th.wid / 2 + 16);
      const pz = th.z + fz * 320 - rz * (th.wid / 2 + 16);
      const boxes: THREE.Mesh[] = [];
      for (let i = 0; i < 4; i++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.4, 1.6), this.papiOff);
        b.position.set(px - rx * i * 9, ap.elev + 1.2, pz - rz * i * 9);
        b.rotation.y = -th.hdg * D2R;
        group.add(b);
        boxes.push(b);
      }
      papis.push({ th, boxes, dirx: -fx, dirz: -fz, px, pz, elev: ap.elev + 1.2 });
    }

    const layout = getAirfield(ap);
    if (layout) buildAirfieldMeshes(ap, layout, this.proj, group, detailed);

    // High-Detail Airport Complexes: Multi-bay Terminal, Jetways, Indonesian Livery Airliners & Windsock
    if (detailed && ap.runways.length > 0) {
      const g = this.runwayGeom(ap, ap.runways[0]);
      // Airside layout is shared with the spawn logic (airportGround.ts): ICAO Annex 14 Table 3-1 taxiway separation,
      // hangar apron + hangars on the side of the airport reference point, terminal block beside it.
      const SG = synthGround(ap, this.proj)!;
      const sgn0 = SG.side;
      const fx = Math.sin(g.hdg * D2R), fz = -Math.cos(g.hdg * D2R), rx = -fz * sgn0, rz = fx * sgn0;
      const sideRot = sgn0 === 1 ? 0 : Math.PI;
      const taxiDist = SG.taxiLat;
      const taxiLen = g.len + 80;

      const taxiMat = new THREE.MeshLambertMaterial({ color: 0x24282f, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
      const apronMat = new THREE.MeshLambertMaterial({ color: 0x383e46, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
      const terminalMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
      const glassMat = new THREE.MeshPhongMaterial({ color: 0x1e293b, specular: 0x93c5fd, shininess: 85 });
      const steelMat = new THREE.MeshLambertMaterial({ color: 0x64748b });
      const towerMat = new THREE.MeshLambertMaterial({ color: 0xf1f5f9 });

      if (!layout && !SG.gaOnly) { // surveyed OSM ground layout replaces the generic placeholder apron/terminal
      // 1. Parallel Taxiway
      const pTaxiGeo = new THREE.PlaneGeometry(SG.taxiWidth, taxiLen);
      pTaxiGeo.rotateX(-Math.PI / 2);
      const pTaxi = new THREE.Mesh(pTaxiGeo, taxiMat);
      pTaxi.position.set(g.cx + rx * taxiDist, ap.elev + 0.06, g.cz + rz * taxiDist);
      pTaxi.rotation.y = -g.hdg * D2R;
      group.add(pTaxi);

      // Connecting Taxiways
      for (const frac of [-0.38, 0, 0.38]) {
        const cLen = taxiDist - g.wid / 2;
        const cGeo = new THREE.PlaneGeometry(cLen + 4, 22);
        cGeo.rotateX(-Math.PI / 2);
        const cTaxi = new THREE.Mesh(cGeo, taxiMat);
        const cx0 = g.cx + fx * (g.len * frac) + rx * (taxiDist / 2);
        const cz0 = g.cz + fz * (g.len * frac) + rz * (taxiDist / 2);
        cTaxi.position.set(cx0, ap.elev + 0.055, cz0);
        cTaxi.rotation.y = -g.hdg * D2R;
        group.add(cTaxi);
      }

      // 2. Main Apron
      const apronLen = Math.min(taxiLen * 0.65, 420);
      const apronWid = 110;
      const apronDist = taxiDist + apronWid / 2 + 11;
      const apronGeo = new THREE.PlaneGeometry(apronWid, apronLen);
      apronGeo.rotateX(-Math.PI / 2);
      const apron = new THREE.Mesh(apronGeo, apronMat);
      apron.position.set(g.cx + rx * apronDist, ap.elev + 0.07, g.cz + rz * apronDist);
      apron.rotation.y = -g.hdg * D2R;
      group.add(apron);

      // 3. Multi-bay Glass Terminal Building
      const termLen = Math.min(apronLen * 0.8, 220);
      const termWid = 38, termH = 16;
      const termDist = apronDist + apronWid / 2 + termWid / 2 + 4;
      const termMesh = new THREE.Mesh(new THREE.BoxGeometry(termWid, termH, termLen), terminalMat);
      termMesh.position.set(g.cx + rx * termDist, ap.elev + termH / 2, g.cz + rz * termDist);
      termMesh.rotation.y = -g.hdg * D2R;
      group.add(termMesh);

      // Glass facade facing apron
      const glassMesh = new THREE.Mesh(new THREE.BoxGeometry(2, termH * 0.68, termLen * 0.94), glassMat);
      glassMesh.position.set(g.cx + rx * (termDist - termWid / 2 + 1), ap.elev + termH * 0.45, g.cz + rz * termDist);
      glassMesh.rotation.y = -g.hdg * D2R;
      group.add(glassMesh);

      // Terminal curved roof canopy
      const roofCanopy = new THREE.Mesh(new THREE.BoxGeometry(termWid + 8, 1.8, termLen + 10), steelMat);
      roofCanopy.position.set(g.cx + rx * termDist, ap.elev + termH + 0.9, g.cz + rz * termDist);
      roofCanopy.rotation.y = -g.hdg * D2R;
      group.add(roofCanopy);

      // 4. Articulated Jetways (Garbarata) & Static Parked Airliners (Garuda, Citilink, Lion, Batik)
      const liveries = [
        { name: 'Garuda', color: 0x008cb4, accent: 0x002d62 },
        { name: 'Citilink', color: 0x16a34a, accent: 0xfacc15 },
        { name: 'Lion', color: 0xdc2626, accent: 0xffffff },
        { name: 'Batik', color: 0x7e22ce, accent: 0xb45309 },
      ];

      const gateOffsets = [-termLen * 0.35, -termLen * 0.12, termLen * 0.12, termLen * 0.35];

      gateOffsets.forEach((alongOffset, gateIdx) => {
        // Position of jetway base at terminal facade
        const jx = g.cx + rx * (termDist - termWid / 2) + fx * alongOffset;
        const jz = g.cz + rz * (termDist - termWid / 2) + fz * alongOffset;

        const jetway = createJetway(glassMat, steelMat);
        jetway.position.set(jx, ap.elev, jz);
        jetway.rotation.y = -g.hdg * D2R - Math.PI / 2 + sideRot;
        group.add(jetway);

        // Parked airliner at this gate
        const liv = liveries[gateIdx % liveries.length];
        const airliner = createStaticAirliner(liv.color, liv.accent);
        const acX = g.cx + rx * (termDist - termWid / 2 - 28) + fx * alongOffset;
        const acZ = g.cz + rz * (termDist - termWid / 2 - 28) + fz * alongOffset;
        airliner.position.set(acX, ap.elev, acZ);
        airliner.rotation.y = -g.hdg * D2R + Math.PI / 2 + sideRot;
        group.add(airliner);

        // Ground service vehicles (GSE) at gate
        const gse = createGseVehicles();
        gse.position.set(acX, ap.elev, acZ);
        gse.rotation.y = -g.hdg * D2R + Math.PI / 2 + sideRot;
        group.add(gse);
      });

      // 5. Control Tower
      const towerDist = termDist - 15;
      const towerOffsetAlong = termLen / 2 + 65;
      const towerX = g.cx + rx * towerDist + fx * towerOffsetAlong;
      const towerZ = g.cz + rz * towerDist + fz * towerOffsetAlong;
      const towerBaseH = 36;
      const towerShaft = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 6.5, towerBaseH, 12), towerMat);
      towerShaft.position.set(towerX, ap.elev + towerBaseH / 2, towerZ);
      group.add(towerShaft);

      const towerCab = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 7, 6.5, 12), glassMat);
      towerCab.position.set(towerX, ap.elev + towerBaseH + 3.2, towerZ);
      group.add(towerCab);

      // 6. Hangars + hangar apron (the aircraft starts outside the doors of these)
      this.addSynthHangars(group, SG, ap.elev, taxiMat, apronMat);

      }
      if (!layout && SG.gaOnly) {
        // Small airfield: parallel taxiway, tie-down / hangar apron, GA hangars and a modest terminal building
        const tGeo = new THREE.PlaneGeometry(SG.taxiWidth, taxiLen); tGeo.rotateX(-Math.PI / 2);
        const tx = new THREE.Mesh(tGeo, taxiMat); tx.position.set(g.cx + rx * taxiDist, ap.elev + 0.06, g.cz + rz * taxiDist); tx.rotation.y = -g.hdg * D2R; group.add(tx);
        for (const along of [-g.len * 0.4, g.len * 0.4, SG.termAlong]) {
          const cl = taxiDist - g.wid / 2; const cgeo = new THREE.PlaneGeometry(cl + 4, SG.taxiWidth * 0.8); cgeo.rotateX(-Math.PI / 2);
          const c = new THREE.Mesh(cgeo, taxiMat); c.position.set(g.cx + fx * along + rx * (taxiDist / 2), ap.elev + 0.055, g.cz + fz * along + rz * (taxiDist / 2)); c.rotation.y = -g.hdg * D2R; group.add(c);
        }
        const tw = 26, td = 11, th = 5;
        const term = new THREE.Mesh(new THREE.BoxGeometry(td, th, tw), terminalMat);
        const tc = [g.cx + fx * SG.termAlong + rx * (taxiDist + 60), g.cz + fz * SG.termAlong + rz * (taxiDist + 60)];
        term.position.set(tc[0], ap.elev + th / 2, tc[1]); term.rotation.y = -g.hdg * D2R; group.add(term);
        const roof = new THREE.Mesh(new THREE.BoxGeometry(td + 1.5, 0.4, tw + 1.5), steelMat); roof.position.set(tc[0], ap.elev + th + 0.2, tc[1]); roof.rotation.y = -g.hdg * D2R; group.add(roof);
        const tieApron = new THREE.Mesh(new THREE.PlaneGeometry(40, 90), apronMat); tieApron.rotateX(-Math.PI / 2);
        tieApron.position.set(g.cx + fx * SG.termAlong + rx * (taxiDist + 28), ap.elev + 0.07, g.cz + fz * SG.termAlong + rz * (taxiDist + 28)); tieApron.rotation.y = -g.hdg * D2R; group.add(tieApron);
        this.addSynthHangars(group, SG, ap.elev, taxiMat, apronMat);
      }

      // 7. Animated Windsock near runway primary threshold
      const wsOffsetDist = g.wid / 2 + 65;
      const wsX = g.ax + rx * wsOffsetDist + fx * 150;
      const wsZ = g.az + rz * wsOffsetDist + fz * 150;
      const windsock = createWindsock();
      windsock.group.position.set(wsX, ap.elev, wsZ);
      group.add(windsock.group);
      windsocks.push(windsock);
    }

    this.scene.add(group);
    return { group, ap, papis, windsocks, strobes };
  }

  /** Hangar buildings (box + barrel roof) and the concrete hangar apron in front of them. */
  private addSynthHangars(group: THREE.Group, SG: SynthGround, elev: number, _taxiMat: THREE.Material, apronMat: THREE.Material) {
    const wall = new THREE.MeshLambertMaterial({ color: 0xb4bcc6 }), roofM = new THREE.MeshLambertMaterial({ color: 0x7d8792 }), door = new THREE.MeshLambertMaterial({ color: 0x4a5560 });
    const apr: Rect = SG.hangarApron;
    const ag = new THREE.PlaneGeometry(apr.hw * 2, apr.hl * 2); ag.rotateX(-Math.PI / 2);
    const am = new THREE.Mesh(ag, apronMat); am.position.set(apr.cx, elev + 0.075, apr.cz); am.rotation.y = -apr.hdg * D2R; group.add(am);
    for (const h of SG.hangars) {
      const r = h.rect, height = h.kind === 'maintenance' ? 15 : 6.5;
      // rect: hl = depth/2 along the door normal, hw = width/2 across it
      const body = new THREE.Mesh(new THREE.BoxGeometry(r.hw * 2, height, r.hl * 2), wall);
      body.position.set(r.cx, elev + height / 2, r.cz); body.rotation.y = -r.hdg * D2R; group.add(body);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(r.hw * 2 + 0.6, 0.5, r.hl * 2 + 0.6), roofM);
      cap.position.set(r.cx, elev + height + 0.25, r.cz); cap.rotation.y = -r.hdg * D2R; group.add(cap);
      // sliding door panel on the taxiway-facing wall, flush with the apron side
      const fx = Math.sin(r.hdg * D2R), fz = -Math.cos(r.hdg * D2R);
      const dw = new THREE.Mesh(new THREE.BoxGeometry(r.hw * 2 * 0.86, height * 0.82, 0.3), door);
      dw.position.set(r.cx + fx * (r.hl + 0.16), elev + height * 0.41, r.cz + fz * (r.hl + 0.16)); dw.rotation.y = -r.hdg * D2R; group.add(dw);
    }
  }

  setSpawnClear(rect: Rect | null, extra: Rect[] = []) { this.structures.setSpawnClear(rect, extra); }

  rebuildAirports(lat: number, lon: number, force = false) {
    if (force) {
      for (const [id, sc] of [...this.airports]) this.removeAirport(id, sc);
      this.runways = [];
    }
    const qp = QUALITY[this.opts.quality];
    // Nearest airports first: the departure/arrival field gets the full terminal treatment,
    // while remote fields stay as runways/lights only. The old size sort kept the *smallest*
    // airports and could discard the field the player was actually using.
    const list = airportsNear(lat, lon, 42000)
      .filter((a) => a.runways.length)
      .map((a) => ({ a, d: haversine(lat, lon, a.lat, a.lon) }))
      .sort((p, q) => p.d - q.d)
      .slice(0, qp.maxAirports)
      .map((e) => e.a);
    const keep = new Set(list.map((a) => a.id));
    for (const [id, sc] of [...this.airports]) if (!keep.has(id)) this.removeAirport(id, sc);
    this.runways = [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!this.airports.has(a.id)) {
        const detailed = qp.airportDetail && i < qp.airportDetailCount;
        this.airports.set(a.id, this.buildAirport(a, detailed));
      } else {
        a.runways.forEach((rw) => this.runways.push(this.runwayGeom(a, rw)));
      }
    }
  }

  private removeAirport(id: string, sc: AirportScene) {
    this.scene.remove(sc.group);
    sc.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mt = m.material as THREE.MeshLambertMaterial;
      if (mt && mt.map) mt.map.dispose();
    });
    this.airports.delete(id);
  }

  rebase(np: Projection, lat: number, lon: number) {
    this.proj = np;
    this.lastAcLat = lat;
    this.lastAcLon = lon;
    this.terrain.rebase(np);
    this.detail.rebase(np);
    this.structures.rebase(np);
    for (const [id, sc] of this.airports) this.removeAirport(id, sc);
    this.rebuildAirports(lat, lon);
  }

  update(cameraOrPos: THREE.Camera | THREE.Vector3, acPos: THREE.Vector3, agl: number, time: number) {
    this.lastAcLat = this.proj.lat(acPos.z);
    this.lastAcLon = this.proj.lon(acPos.x);
    let camPos: THREE.Vector3;
    let frustum: THREE.Frustum | undefined;

    if ((cameraOrPos as THREE.Camera).isCamera) {
      const camera = cameraOrPos as THREE.Camera;
      camPos = camera.position;
      camera.updateMatrixWorld();
      this.projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.projScreenMatrix);
      frustum = this.frustum;
    } else {
      camPos = cameraOrPos as THREE.Vector3;
    }

    this.updateSunFromClock();
    this.terrain.update(acPos.x, acPos.z, time, this.sunDir, frustum);
    this.detail.update(acPos.x, acPos.z, agl, time, this.sunDir);
    // reuse the airport buffer instead of allocating a fresh array every frame
    let n = 0;
    for (const sc of this.airports.values()) this.airportList[n++] = sc.ap;
    if (this.airportList.length !== n) this.airportList.length = n;
    this.structures.update(acPos.x, acPos.z, agl, this.airportList, frustum);
    this.sky.position.copy(camPos);
    this.sunLight.position.copy(camPos).addScaledVector(this.sunDir, 1000);
    this.sunLight.target.position.copy(camPos);

    // PAPI glide slope cues
    for (const sc of this.airports.values()) {
      for (const p of sc.papis) {
        const dx = acPos.x - p.px, dz = acPos.z - p.pz;
        const d = dx * p.dirx + dz * p.dirz;
        if (d < 200 || d > 18000) continue;
        const ang = Math.atan2(acPos.y - p.elev, d) * R2D;
        for (let i = 0; i < PAPI_ANGLES.length && i < p.boxes.length; i++) {
          p.boxes[i].material = ang > PAPI_ANGLES[i] ? this.papiOn : this.papiOff;
        }
      }

      // Animate windsock flutter
      for (const ws of sc.windsocks) {
        const flutter = Math.sin(time * 3.5) * 0.12;
        ws.cone.rotation.z = flutter;
      }

      // Animate ALS sequenced flashing strobe rabbit (traveling pulse at 2 Hz)
      if (sc.strobes.length > 0) {
        const activeIdx = Math.floor((time * 24) % 15);
        for (const st of sc.strobes) {
          st.mesh.material = st.order === activeIdx ? this.strobeOn : this.strobeOff;
        }
      }
    }

    // clouds advect with the live wind (World clock freezes while paused, so the drift freezes too);
    // lightning shares the same clock and hooks the host for distance-delayed thunder audio
    this.clouds.update(camPos, time, this.sunDir, this.cloudColor, this.cloudShadow, this.windDriftX, this.windDriftZ);
    this.lightning.update(time, camPos, this.wx.baseMsl, this.heightAtFn);
  }

  dispose() {
    this.terrain.dispose();
    this.detail.clear();
    this.structures.dispose();
    for (const [id, sc] of this.airports) this.removeAirport(id, sc);
    this.clouds.dispose();
    this.lightning.dispose();
    this.papiOn.dispose();
    this.papiOff.dispose();
    this.strobeOn.dispose();
    this.strobeOff.dispose();
  }
}
