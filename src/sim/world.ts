import * as THREE from 'three';
import { Projection, wrap360, D2R, R2D, clamp, haversine } from './geo';
import { Terrain, DetailLayer } from './terrain';
import { Structures } from './structures';
import { Airport, Runway, airportsNear } from '../data/airports';
import { QualityPreset } from './storage';
import { QUALITY } from './quality';

export type TimeOfDay = 'day' | 'sunset';
export type Weather = 'clear' | 'scattered' | 'overcast';

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
};

const hashN = (a: number, b: number, s = 0) => {
  const v = Math.sin(a * 127.1 + b * 311.7 + s * 74.7) * 43758.5453;
  return v - Math.floor(v);
};

// Procedural multi-lobed puffy cumulus cloud texture with self-shadowed base
function cloudTexture() {
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

function runwayTexture(rw: Runway, len: number, wid: number) {
  const W = 256, Hh = Math.min(4096, Math.max(1024, Math.round(len / 2)));
  const c = document.createElement('canvas'); c.width = W; c.height = Hh;
  const g = c.getContext('2d')!;
  g.fillStyle = '#34363a'; g.fillRect(0, 0, W, Hh);
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(${hashN(i, 4) > 0.5 ? 255 : 0},${hashN(i, 4) > 0.5 ? 255 : 0},${hashN(i, 4) > 0.5 ? 255 : 0},0.035)`;
    g.fillRect(hashN(i, 5) * W, hashN(i, 6) * Hh, 2 + hashN(i, 7) * 14, 2 + hashN(i, 8) * 40);
  }
  const sx = W / wid, sy = Hh / len;
  const rect = (x: number, y: number, w: number, h: number) => g.fillRect(x * sx, Hh - (y + h) * sy, w * sx, h * sy);
  g.fillStyle = '#f0f0ec';
  rect(1.2, 0, 0.5, len); rect(wid - 1.7, 0, 0.5, len);
  const cl = (wid / 2) - 0.45;
  for (let y = 60; y < len - 60; y += 50) rect(cl, y, 0.9, 30);
  const nb = Math.max(3, Math.min(8, Math.floor(wid / 8)));
  for (const end of [0, 1]) {
    const at = (d: number, h: number) => (end ? len - d - h : d);
    for (let i = 0; i < nb * 2; i++) {
      const xx = 2.4 + (i * (wid - 4.8)) / (nb * 2 - 0.4);
      if (Math.abs(xx - wid / 2) < 1.8) continue;
      rect(Math.min(xx, wid - 4), at(7, 30), 1.2, 30);
    }
    if (len > 1200) { rect(wid / 2 - 9 - 3, at(300, 45), 3, 45); rect(wid / 2 + 9, at(300, 45), 3, 45); }
    if (len > 2000) for (const d of [450, 600, 750]) { rect(wid / 2 - 8, at(d, 22), 2, 22); rect(wid / 2 + 6, at(d, 22), 2, 22); }
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
  clouds: THREE.Sprite[] = [];
  cloudCover = 0.4;
  cloudTex: THREE.Texture;
  private cloudTarget = 40;
  airports = new Map<string, AirportScene>();
  runways: RunwayGeom[] = [];
  tod: TimeOfDay = 'day';
  sunDir = new THREE.Vector3();
  private papiOn = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private papiOff = new THREE.MeshBasicMaterial({ color: 0xff2200 });
  private strobeOn = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private strobeOff = new THREE.MeshBasicMaterial({ color: 0xffe899 });
  private frustum = new THREE.Frustum();
  private projScreenMatrix = new THREE.Matrix4();
  private lastAcLat = 0;
  private lastAcLon = 0;

  constructor(
    public proj: Projection,
    public opts: { quality: QualityPreset; style: string; tod: TimeOfDay; weather: Weather; maxAniso: number }
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
      },
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position.z = gl_Position.w*0.9999; }',
      // Soft, continuous horizon:
      //  - a wide haze band that saturates at exactly the fog colour right at 0 deg elevation,
      //  - a gentle zenith falloff (no visible gradient bands / hard cut at the skyline),
      //  - the sun as a tight disc plus two broad glow lobes.
      // The final <colorspace_fragment> include is essential: without it these linear values were
      // written straight into an sRGB framebuffer, so the sky was darker than the fogged terrain
      // beneath it — the mismatch is what read as a sharp horizon line.
      fragmentShader: `varying vec3 vD; uniform vec3 zen; uniform vec3 hor; uniform vec3 haze; uniform vec3 sunDir; uniform vec3 sunCol;
        void main(){
          vec3 v = normalize(vD);
          float h = max(v.y, 0.0);
          vec3 c = mix(hor, zen, pow(h, 0.42));
          float band = exp(-h * 22.0);
          c = mix(c, haze, band * 0.88);
          if (v.y < 0.0) c = mix(haze, hor, clamp(-v.y * 3.0, 0.0, 1.0));
          float s = max(dot(v, normalize(sunDir)), 0.0);
          c += sunCol * (pow(s, 900.0) * 2.2 + pow(s, 20.0) * 0.14 + pow(s, 3.0) * 0.06);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);

    this.cloudTex = cloudTexture();
    this.setWeather(opts.weather);
    this.setTimeOfDay(opts.tod);
    this.syncCloudBudget(QUALITY[opts.quality]?.clouds ?? 40);
  }

  private makeCloud(): THREE.Sprite {
    const sp = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.cloudTex,
        transparent: true,
        depthWrite: false,
        opacity: 0.92,
        fog: true,
      })
    );
    sp.visible = false;
    this.scene.add(sp);
    this.clouds.push(sp);
    return sp;
  }

  private syncCloudBudget(target: number) {
    this.cloudTarget = target;
    while (this.clouds.length < target) this.makeCloud();
    for (let i = target; i < this.clouds.length; i++) this.clouds[i].visible = false;
  }

  setQuality(q: QualityPreset) {
    if (this.opts.quality === q) return;
    this.opts.quality = q;
    this.terrain.setQuality(q);
    this.structures.setQuality(q);
    this.structures.setTimeOfDay(this.tod);
    this.syncCloudBudget(QUALITY[q].clouds);
    // Terminal detail / airport count is preset-specific. Rebuild the (small) airport set
    // around aircraft current position immediately so a quality change doesn't leave heavy meshes.
    const lat = this.lastAcLat || this.proj.lat(0);
    const lon = this.lastAcLon || this.proj.lon(0);
    this.rebuildAirports(lat, lon, true);
  }

  setWeather(w: Weather) {
    this.cloudCover = w === 'clear' ? 0.12 : w === 'scattered' ? 0.42 : 0.8;
  }

  setTimeOfDay(t: TimeOfDay) {
    this.tod = t;
    const c = SKY[t];
    const el = c.sunEl * D2R, az = c.sunAz * D2R;
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    this.skyMat.uniforms.zen.value.copy(c.zen);
    this.skyMat.uniforms.hor.value.copy(c.hor);
    this.skyMat.uniforms.haze.value.copy(c.haze);
    this.skyMat.uniforms.sunDir.value.copy(this.sunDir);
    this.skyMat.uniforms.sunCol.value.copy(c.sun);
    this.sunLight.color.copy(c.sun);
    this.sunLight.intensity = c.dir;
    this.hemi.color.copy(c.zen).lerp(new THREE.Color(1, 1, 1), 0.5);
    this.hemi.groundColor.copy(c.ground);
    this.hemi.intensity = c.hemi;
    // Exponential (not linear) fog: it fades every distance band by the same *fraction*, so there
    // is no "fog starts here" band and no hard rim where the terrain mesh ends. The colour is the
    // sky's own horizon haze, so the last visible ground melts into the sky with no seam at all.
    this.scene.fog = new THREE.FogExp2(c.haze.clone(), c.fog);
    this.terrain.setEnvironment(c.haze, this.sunDir);
    this.detail.setEnvironment(c.haze, this.sunDir);
    this.structures.setTimeOfDay(t);
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
      out.push({
        ap, rw, end: 'le', ident: rw.le,
        x: g.ax, z: g.az, hdg: g.hdg,
        len: g.len, wid: g.wid, elev: ap.elev,
        lat: rw.leLat, lon: rw.leLon,
      });
      out.push({
        ap, rw, end: 'he', ident: rw.he,
        x: g.bx, z: g.bz, hdg: h2,
        len: g.len, wid: g.wid, elev: ap.elev,
        lat: rw.heLat, lon: rw.heLon,
      });
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
      group.add(shoulder);

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
      group.add(edge);

      // Green threshold bars
      const thr = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.5, 1), greenMat, 24);
      let tk = 0;
      for (const end of [0, 1]) {
        const bx = end ? g.bx : g.ax, bz = end ? g.bz : g.az;
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
      group.add(thr);

      // ALS (Approach Lighting System) with Sequenced Flashing Strobe Rabbit (15 stations extending 450m)
      for (const end of [0, 1]) {
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

    // High-Detail Airport Complexes: Multi-bay Terminal, Jetways, Indonesian Livery Airliners & Windsock
    if (detailed && ap.runways.length > 0) {
      const g = this.runwayGeom(ap, ap.runways[0]);
      const fx = Math.sin(g.hdg * D2R), fz = -Math.cos(g.hdg * D2R), rx = -fz, rz = fx;
      const taxiDist = g.wid / 2 + 55;
      const taxiLen = Math.max(400, g.len * 0.85);

      const taxiMat = new THREE.MeshLambertMaterial({ color: 0x24282f, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
      const apronMat = new THREE.MeshLambertMaterial({ color: 0x383e46, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
      const terminalMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
      const glassMat = new THREE.MeshPhongMaterial({ color: 0x1e293b, specular: 0x93c5fd, shininess: 85 });
      const steelMat = new THREE.MeshLambertMaterial({ color: 0x64748b });
      const hangarMat = new THREE.MeshLambertMaterial({ color: 0x94a3b8 });
      const towerMat = new THREE.MeshLambertMaterial({ color: 0xf1f5f9 });

      // 1. Parallel Taxiway
      const pTaxiGeo = new THREE.PlaneGeometry(22, taxiLen);
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
        jetway.rotation.y = -g.hdg * D2R - Math.PI / 2;
        group.add(jetway);

        // Parked airliner at this gate
        const liv = liveries[gateIdx % liveries.length];
        const airliner = createStaticAirliner(liv.color, liv.accent);
        const acX = g.cx + rx * (termDist - termWid / 2 - 28) + fx * alongOffset;
        const acZ = g.cz + rz * (termDist - termWid / 2 - 28) + fz * alongOffset;
        airliner.position.set(acX, ap.elev, acZ);
        airliner.rotation.y = -g.hdg * D2R + Math.PI / 2;
        group.add(airliner);

        // Ground service vehicles (GSE) at gate
        const gse = createGseVehicles();
        gse.position.set(acX, ap.elev, acZ);
        gse.rotation.y = -g.hdg * D2R + Math.PI / 2;
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

      // 6. Maintenance Hangars
      for (const sgn of [-1, 1]) {
        const hDist = termDist + 8;
        const hAlong = -termLen / 2 - 55 + sgn * 55;
        const hx = g.cx + rx * hDist + fx * hAlong;
        const hz = g.cz + rz * hDist + fz * hAlong;
        const hangar = new THREE.Mesh(new THREE.CylinderGeometry(24, 24, 48, 16, 1, false, 0, Math.PI), hangarMat);
        hangar.rotation.z = Math.PI / 2;
        hangar.rotation.y = -g.hdg * D2R;
        hangar.position.set(hx, ap.elev + 0.5, hz);
        group.add(hangar);
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

    this.terrain.update(acPos.x, acPos.z, time, this.sunDir, frustum);
    this.detail.update(acPos.x, acPos.z, agl, time, this.sunDir);
    this.structures.update(acPos.x, acPos.z, agl, [...this.airports.values()].map((s) => s.ap), frustum);
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
        [2.5, 2.83, 3.17, 3.5].forEach((thr, i) => {
          p.boxes[i].material = ang > thr ? this.papiOn : this.papiOff;
        });
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

    this.updateClouds(camPos, time);
  }

  private updateClouds(cam: THREE.Vector3, time: number) {
    const cell = 6500;
    const target = this.cloudTarget;
    const R = Math.ceil(Math.sqrt(target) / 2) + 1;
    const cx = Math.floor(cam.x / cell), cz = Math.floor(cam.z / cell);
    let k = 0;

    for (let i = -R; i <= R && k < target; i++) {
      for (let j = -R; j <= R && k < target; j++) {
        const gx = cx + i, gz = cz + j;
        if (hashN(gx, gz, 1) > this.cloudCover) continue;

        const sp = this.clouds[k++];
        const layer = hashN(gx, gz, 2) < 0.7 ? 0 : 1;
        const base = layer ? 5800 + hashN(gx, gz, 3) * 1400 : 1600 + hashN(gx, gz, 4) * 1600;
        const sz = (layer ? 7200 : 3800) * (0.7 + hashN(gx, gz, 5) * 0.8);

        sp.position.set((gx + hashN(gx, gz, 6)) * cell + time * 3, base, (gz + hashN(gx, gz, 7)) * cell);
        sp.scale.set(sz, sz * 0.46, 1);

        const d = Math.hypot(sp.position.x - cam.x, sp.position.y - cam.y, sp.position.z - cam.z);
        const m = sp.material as THREE.SpriteMaterial;
        m.opacity = clamp((d - 250) / 700, 0, 1) * 0.92;
        sp.visible = m.opacity > 0.02;
        m.color.set(this.tod === 'sunset' ? 0xffdfc4 : 0xffffff);
      }
    }

    for (; k < target; k++) this.clouds[k].visible = false;
    for (let i = target; i < this.clouds.length; i++) this.clouds[i].visible = false;
  }

  dispose() {
    this.terrain.dispose();
    this.detail.clear();
    this.structures.dispose();
    for (const [id, sc] of this.airports) this.removeAirport(id, sc);
    this.cloudTex.dispose();
    this.papiOn.dispose();
    this.papiOff.dispose();
    this.strobeOn.dispose();
    this.strobeOff.dispose();
  }
}
