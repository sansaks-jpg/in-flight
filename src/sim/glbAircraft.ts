// Real-aircraft exterior models loaded from open-source glTF files (see src/assets/models/CREDITS.md).
//   * every model is brought to its true 1:1 dimensions (length / span / height of the real type) and registered to the
//     flight-model body frame (+X right, +Y up, -Z forward, origin = CG) so the wheels sit exactly on the contact points
//     the physics uses (spec.gear);
//   * propellers / fans are split out of the baked meshes so they can spin with the real engine state;
//   * the A320 source model has no undercarriage, so a real-dimension (track 7.59 m, wheelbase 12.64 m) gear is built here.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { AircraftSpec } from './specs';
import { AircraftVisual, buildAircraftModel } from './aircraftModel';
import { FlightModel } from './physics';
const c172Url = '/src/assets/models/c172.glb';
const atr72Url = '/src/assets/models/atr72.glb';
const a320Url = '/src/assets/models/a320.glb';

type V3 = [number, number, number];
interface Lights { wing: V3; tail: V3; beacon: V3; landing: V3 }
interface ModelCfg {
  url: string;
  /** rotation about Y that turns the model's nose to -Z */
  rotY: number;
  /** per-axis scale applied in body axes (to reach the real overall dimensions) */
  scale: V3;
  /** translation applied after scaling: registers model -> CG-centred body frame */
  offset: V3;
  lights: Lights;
}

const CFG: Record<string, ModelCfg> = {
  // Cessna 172: NLM model (nose toward +Z, length 2.63m, span 3.69m). Rotate PI to face -Z. Scale to 8.28m x 11.0m.
  swift: { url: c172Url, rotY: Math.PI, scale: [11.0 / 3.69, 11.0 / 3.69, 8.28 / 2.63], offset: [0, -0.05, 0.2], lights: { wing: [5.5, 0.96, 0.95], tail: [0, 1.45, 4.2], beacon: [0, 1.62, 3.8], landing: [0, -0.2, -4.1] } },
  // ATR 72-600: metres, nose toward -X (27.2 x 26.87 x 7.62 m). Main gear at model x=-0.85, wheel bottoms y=-3.8.
  trek: { url: atr72Url, rotY: -Math.PI / 2, scale: [1, 1, 1], offset: [0, 1.75, 1.95], lights: { wing: [13.44, 1.43, 1.82], tail: [0, 5.3, 15.5], beacon: [0, 1.15, -2.5], landing: [0, -1.2, -10.8] } },
  // A320: nose toward -Z; stretched to the real 34.10 m span / 37.57 m length / 11.76 m height.
  sky: { url: a320Url, rotY: 0, scale: [34.1 / 135.5, 0.25164, 37.57 / 149.3], offset: [0, -1.956, -0.8], lights: { wing: [17.03, 0.83, 5.18], tail: [0, 1.8, 20.9], beacon: [0, 1.95, -6.0], landing: [0, -1.6, -11.2] } },
};

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const cache = new Map<string, Promise<THREE.Group>>();
function loadScene(url: string): Promise<THREE.Group> {
  let p = cache.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((g) => g.scene).catch((err) => {
      cache.delete(url);
      throw err;
    });
    cache.set(url, p);
  }
  return p;
}

/** Move the triangles of `mesh` whose scene-space centroid satisfies `pred` into a new mesh whose vertices are expressed relative to `hub`. */
function carve(mesh: THREE.Mesh, scene: THREE.Object3D, hub: THREE.Vector3, pred: (c: THREE.Vector3) => boolean): THREE.Mesh | null {
  const g = mesh.geometry as THREE.BufferGeometry; const idx = g.index; if (!idx) return null;
  const pos = g.attributes.position as THREE.BufferAttribute, nor = g.attributes.normal as THREE.BufferAttribute | undefined, uv = g.attributes.uv as THREE.BufferAttribute | undefined;
  const inv = new THREE.Matrix4().copy(scene.matrixWorld).invert();
  const m = new THREE.Matrix4().copy(mesh.matrixWorld).premultiply(inv); // mesh-local -> scene space
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cen = new THREE.Vector3();
  const keep: number[] = [], take: number[] = [];
  for (let t = 0; t < idx.count; t += 3) {
    const i0 = idx.getX(t), i1 = idx.getX(t + 1), i2 = idx.getX(t + 2);
    a.fromBufferAttribute(pos, i0).applyMatrix4(m); b.fromBufferAttribute(pos, i1).applyMatrix4(m); c.fromBufferAttribute(pos, i2).applyMatrix4(m);
    cen.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    if (pred(cen)) take.push(i0, i1, i2); else keep.push(i0, i1, i2);
  }
  if (!take.length) return null;
  const remap = new Map<number, number>(); const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
  for (const i of take) {
    let r = remap.get(i);
    if (r === undefined) {
      r = P.length / 3; remap.set(i, r);
      a.fromBufferAttribute(pos, i).applyMatrix4(m).sub(hub); P.push(a.x, a.y, a.z);
      if (nor) { b.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); N.push(b.x, b.y, b.z); }
      if (uv) U.push(uv.getX(i), uv.getY(i));
    }
    I.push(r);
  }
  const ng = new THREE.BufferGeometry();
  ng.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  if (nor) ng.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); else ng.computeVertexNormals();
  if (uv) ng.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  ng.setIndex(I);
  g.setIndex(keep);
  return new THREE.Mesh(ng, mesh.material);
}

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d')!;
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

interface Spinner { pivot: THREE.Object3D; axis: 'x' | 'z'; engine: number; blades: THREE.Object3D[]; disc?: THREE.Mesh; fan: boolean; dir: number }
interface GearPart { objs: THREE.Object3D[]; nose: boolean; drop: number }

export async function loadAircraftVisual(spec: AircraftSpec): Promise<AircraftVisual> {
  const cfg = CFG[spec.id];
  if (!cfg) return buildAircraftModel(spec);
  let scene: THREE.Group;
  try { scene = (await loadScene(cfg.url)).clone(true); } catch (e) { console.warn('GLB aircraft load failed, using procedural model', e); return buildAircraftModel(spec); }
  // per-flight copies so edits never leak between flights
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : (m.material as THREE.Material).clone();
      m.geometry = m.geometry.clone();
      m.frustumCulled = false;
      const matName = Array.isArray(m.material) ? m.material[0]?.name : (m.material as THREE.Material)?.name;
      if (matName && (/concrete/i.test(matName) || /remove_before_flight/i.test(matName))) {
        m.visible = false;
      }
    }
  });

  const root = new THREE.Group();
  const offsetG = new THREE.Group(); offsetG.position.set(...cfg.offset); root.add(offsetG);
  const scaleG = new THREE.Group(); scaleG.scale.set(...cfg.scale); offsetG.add(scaleG);
  const rotG = new THREE.Group(); rotG.rotation.y = cfg.rotY; scaleG.add(rotG);
  rotG.add(scene);
  scene.updateMatrixWorld(true);

  const spinners: Spinner[] = [];
  const gearParts: GearPart[] = [];
  const byName = (n: string) => { let r: THREE.Mesh | null = null; scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.name === n) r = o as THREE.Mesh; }); return r as THREE.Mesh | null; };
  const inv = new THREE.Matrix4().copy(scene.matrixWorld).invert();
  const sceneBox = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o).applyMatrix4(inv);
  const discMat = () => new THREE.MeshBasicMaterial({ color: 0x1c2026, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });

  if (spec.id === 'swift') {
    // If c172 has Object_50 node (the propeller in NLM model)
    const propNode = byName('Object_50');
    if (propNode) {
      const hub = sceneBox(propNode).getCenter(new THREE.Vector3());
      const pivot = new THREE.Group(); pivot.position.copy(hub); scene.add(pivot); pivot.attach(propNode);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.95, 32), discMat()); pivot.add(disc); disc.visible = false;
      spinners.push({ pivot, axis: 'z', engine: 0, blades: [propNode], disc, fan: false, dir: 1 });
    } else {
      // Cessna 172: carve the two propeller blades out of the baked mesh (thin slab at the front, outside the spinner radius).
      const hub = new THREE.Vector3(-3.775, -0.14, 0);
      const meshes: THREE.Mesh[] = []; scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
      for (const m of meshes) {
        const blades = carve(m, scene, hub, (c) => Math.abs(c.x - hub.x) < 0.07 && Math.hypot(c.y - hub.y, c.z - hub.z) > 0.16 && Math.hypot(c.y - hub.y, c.z - hub.z) < 1.05);
        if (!blades) continue;
        const pivot = new THREE.Group(); pivot.position.copy(hub); scene.add(pivot); pivot.add(blades);
        const disc = new THREE.Mesh(new THREE.CircleGeometry(0.95, 32).rotateY(Math.PI / 2), discMat()); pivot.add(disc); disc.visible = false;
        spinners.push({ pivot, axis: 'x', engine: 0, blades: [blades], disc, fan: false, dir: -1 });
      }
    }
  } else if (spec.id === 'trek') {
    // ATR 72: both propellers are baked into two meshes (black blades / yellow tips) – split per side and spin around each hub.
    const meshes = ['Cylinder.024_Black_0', 'Cylinder.024_Yellow_0'].map(byName).filter(Boolean) as THREE.Mesh[];
    if (meshes.length) {
      const bb = new THREE.Box3(); meshes.forEach((m) => bb.union(sceneBox(m)));
      const rad = (bb.max.y - bb.min.y) / 2, cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2, hz = bb.max.z - rad;
      [-1, 1].forEach((sd, k) => {
        const hub = new THREE.Vector3(cx, cy, sd * hz);
        const pivot = new THREE.Group(); pivot.position.copy(hub); scene.add(pivot);
        const parts: THREE.Object3D[] = [];
        for (const m of meshes) { const part = carve(m, scene, hub, (c) => c.z * sd > 0); if (part) { pivot.add(part); parts.push(part); } }
        const disc = new THREE.Mesh(new THREE.CircleGeometry(rad, 40).rotateY(Math.PI / 2), discMat()); pivot.add(disc); disc.visible = false;
        spinners.push({ pivot, axis: 'x', engine: k, blades: parts, disc, fan: false, dir: 1 });
      });
    }
    // landing gear is part of the baked model: group the wheel meshes so they can be "retracted"
    const lists = { nose: ['Cylinder.020_Roda_0', 'Cylinder.020_Silver_0', 'Cylinder.021_Silver_0', 'Circle.027_Body White_0', 'Cube.028_Silver_0'], main: ['Cylinder.022_Roda_0', 'Cylinder.022_Silver_0', 'Cylinder.023_Silver_0', 'Cube.027_Body White_0'] };
    for (const [k, list] of Object.entries(lists)) gearParts.push({ objs: list.map(byName).filter(Boolean) as THREE.Object3D[], nose: k === 'nose', drop: 1.4 });
  } else if (spec.id === 'sky') {
    // A320: spin the fan wheels (engine axis = Z)
    (['fanWheel', 'fanWheel_001'] as const).forEach((n, k) => {
      const m = byName(n); if (!m) return;
      const hub = sceneBox(m).getCenter(new THREE.Vector3());
      const pivot = new THREE.Group(); pivot.position.copy(hub); scene.add(pivot); pivot.attach(m);
      spinners.push({ pivot, axis: 'z', engine: k, blades: [m], fan: true, dir: 1 });
    });
  }

  // ---------- procedural real-dimension gear for the A320 ----------
  const metal = new THREE.MeshStandardMaterial({ color: 0xaab0b8, roughness: 0.35, metalness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x24282e, roughness: 0.7, metalness: 0.3 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x101113, roughness: 0.95 });
  const procGear: { g: THREE.Group; nose: boolean; side: number; wheels: THREE.Object3D[]; r: number }[] = [];
  if (spec.id === 'sky') {
    spec.gear.forEach((gs) => {
      const [gx, gy, gz] = gs.pos; const nose = !!gs.nose; const r = nose ? spec.wheelR[1] : spec.wheelR[0];
      const attachY = nose ? -1.55 : -1.45;
      const g = new THREE.Group(); g.position.set(gx, attachY, gz); root.add(g);
      const hub = gy + r - attachY; // wheel centre relative to attach (negative)
      const len = -hub;
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(nose ? 0.07 : 0.1, nose ? 0.09 : 0.13, len, 12), metal); strut.position.y = -len / 2; g.add(strut);
      const wheels: THREE.Object3D[] = [];
      for (const wx of [-0.27, 0.27]) {
        const w = new THREE.Group(); w.position.set(wx, hub, 0); g.add(w);
        w.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, nose ? 0.24 : 0.33, 24).rotateZ(Math.PI / 2), rubber));
        w.add(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.58, r * 0.58, nose ? 0.26 : 0.35, 16).rotateZ(Math.PI / 2), metal));
        w.add(new THREE.Mesh(new THREE.BoxGeometry(nose ? 0.27 : 0.36, r * 1.5, 0.05), dark));
        wheels.push(w);
      }
      const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.8, 8).rotateZ(Math.PI / 2), metal); axle.position.y = hub; g.add(axle);
      procGear.push({ g, nose, side: Math.sign(gx), wheels, r });
    });
  }

  // ---------- lights ----------
  const glowTex = glowTexture();
  const mkLight = (pos: V3, color: number, size: number) => {
    const grp = new THREE.Group(); grp.position.set(...pos);
    grp.add(new THREE.Mesh(new THREE.SphereGeometry(size * 0.35, 8, 6), new THREE.MeshBasicMaterial({ color })));
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })); sp.scale.setScalar(size * 5); grp.add(sp);
    root.add(grp); return grp;
  };
  const sz = spec.id === 'sky' ? 0.22 : spec.id === 'trek' ? 0.16 : 0.09;
  const L = cfg.lights;
  const navL = mkLight([-L.wing[0], L.wing[1], L.wing[2]], 0xff2200, sz);
  const navR = mkLight([L.wing[0], L.wing[1], L.wing[2]], 0x00ff55, sz);
  const navT = mkLight(L.tail, 0xffffff, sz);
  const strobeL = mkLight([-L.wing[0], L.wing[1] + 0.05, L.wing[2] + 0.2], 0xffffff, sz * 1.1);
  const strobeR = mkLight([L.wing[0], L.wing[1] + 0.05, L.wing[2] + 0.2], 0xffffff, sz * 1.1);
  const beacon = mkLight(L.beacon, 0xff2a10, sz * 1.2);
  const beaconB = spec.id === 'sky' ? mkLight([0, -1.9, -6.0], 0xff2a10, sz * 1.2) : null;
  const land = mkLight(L.landing, 0xfff4d8, sz * 1.6);

  let spin = 0, wheelSpin = 0, comp = 0;
  const baseY = cfg.offset[1];
  const spinAngle = [0, 0];
  const visual: AircraftVisual = {
    root, bodyParts: [], engineGlow: [],
    setVisible(v) { root.visible = v; },
    setInterior(v) {
      // In interior view, hide exterior windows and cockpit shell so they don't block
      // the pilot's forward visibility or instruments
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          const matName = Array.isArray(m.material) ? m.material[0]?.name : (m.material as THREE.Material)?.name;
          if (matName && /window|glass|cockpit/i.test(matName)) {
            m.visible = !v;
          }
        }
      });
    },
    update(fm: FlightModel, dt: number, time: number, lights) {
      // wheels touch the ground exactly: lift the rigid model by the suspension compression the physics applies
      let cs = 0, n = 0; for (let i = 1; i < fm.gear.length; i++) { cs += fm.gear[i].comp; n++; }
      comp += ((n ? cs / n : 0) - comp) * Math.min(1, dt * 12);
      offsetG.position.y = baseY + comp;
      const gp = fm.gearPos;
      for (const pg of procGear) {
        pg.g.visible = gp > 0.02;
        if (pg.nose) pg.g.rotation.x = (1 - gp) * 1.55; else pg.g.rotation.z = -pg.side * (1 - gp) * 1.5;
        for (const w of pg.wheels) w.rotation.x = wheelSpin;
      }
      wheelSpin += (fm.wow ? fm.gs : 0) * dt / 0.58 * (fm.vel.dot(fm.forward()) >= 0 ? 1 : -1);
      for (const p of gearParts) for (const o of p.objs) { o.visible = gp > 0.5; o.position.y = (1 - gp) * p.drop; }
      // propellers / fans follow the real engine state
      spin += dt;
      for (const sp of spinners) {
        const k = Math.min(sp.engine, fm.eng.length - 1);
        const nn = fm.n[k] ?? 0;
        const rps = sp.fan ? nn * 14 : (spec.kind === 'piston' ? nn * 40 : nn * 17);
        spinAngle[sp.engine] = (spinAngle[sp.engine] ?? 0) + sp.dir * rps * Math.PI * 2 * dt;
        // above ~900 rpm the eye (and a 60 Hz display) cannot resolve blades: show a translucent disc like real prop blur
        const fast = !sp.fan && rps > 9;
        const ang = fast ? spin * 3.1 : spinAngle[sp.engine];
        if (sp.axis === 'x') sp.pivot.rotation.x = ang; else sp.pivot.rotation.z = spinAngle[sp.engine];
        if (sp.disc) { sp.disc.visible = fast; (sp.disc.material as THREE.MeshBasicMaterial).opacity = fast ? Math.min(0.3, rps / 40 * 0.3) : 0; }
        if (!sp.fan) for (const b of sp.blades) b.visible = !fast;
      }
      // lights (real logic: nav, white strobes, red anti-collision beacon, landing)
      const ph = time % 1.2;
      navL.visible = navR.visible = navT.visible = lights.nav;
      strobeL.visible = strobeR.visible = lights.strobe && (ph < 0.08 || (ph > 0.2 && ph < 0.28));
      beacon.visible = lights.beacon && Math.sin(time * 9.5) > 0.2; if (beaconB) beaconB.visible = beacon.visible;
      land.visible = lights.land;
    },
  };
  return visual;
}
