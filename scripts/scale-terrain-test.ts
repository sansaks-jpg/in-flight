// Scale / altitude / draw-distance verification (Tugas 2 + review fixes):
//   1. Load the actual .glb model files with the app's OWN GLTFLoader + MeshoptDecoder (so the
//      measurement is runtime-exact: EXT_mesh_gpu_instancing proxies and quantised accessors are
//      handled exactly like in the game) and check that the registered body-frame dimensions match
//      specs.ts (length / span / height), that the wheels bottom out on the physics gear contacts
//      AND sit on their z stations (no floating / sinking / station offset on the ground).
//   2. Simulate the physics on flat ground and assert fm.agl, its definition and the m->ft HUD
//      conversions are consistent (altimeter vs terrain elevation vs radio altitude).
//   3. Assert the camera far plane, the terrain LOD ring extent and FogExp2 density leave no visible
//      "edge of the world" at any quality preset.
// Runs headless in node — no WebGL (texture decode failures are irrelevant to geometry).
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { readFileSync } from 'node:fs';
import { FlightModel, airState } from '../src/sim/physics';
import { AIRCRAFT, AircraftSpec } from '../src/sim/specs';
import { CFG } from '../src/sim/glbAircraft';
import { LOD_HIGH, LOD_MEDIUM, LOD_LOW, LOD_ULTRA, LodCfg } from '../src/sim/terrain';
import { QUALITY } from '../src/sim/quality';
import { M_PER_FT, MS_TO_KT } from '../src/sim/geo';

// node has no Image/self: GLTFLoader needs them only for TEXTURES, which do not affect geometry
(globalThis as any).self = globalThis;
(globalThis as any).Image = class {
  width = 1; height = 1;
  onload: (() => void) | null = null; onerror: (() => void) | null = null;
  decode() { return Promise.resolve(); }
  set src(_v: string) { setTimeout(() => this.onload?.(), 0); }
  get src() { return ''; }
};

interface MeshInfo { name: string; instanced: boolean; min: number[]; max: number[]; material: string | null }

const glbCache = new Map<string, MeshInfo[]>();
/** Loads the GLB with the app's own loader and returns one FILE-frame AABB per mesh, annotated with
 *  material name and instancing so callers can replicate glbAircraft's visibility filters exactly. */
async function glbMeshes(path: string): Promise<MeshInfo[]> {
  const hit = glbCache.get(path);
  if (hit) return hit;
  const bin = readFileSync(path);
  const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const meshes = await new Promise<MeshInfo[]>((resolve, reject) => {
    loader.parse(ab, '', (gltf) => {
      const scene = gltf.scene;
      scene.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(scene.matrixWorld).invert(); // root identity -> no-op
      const out: MeshInfo[] = [];
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const b = new THREE.Box3().setFromObject(m).applyMatrix4(inv);
        const mat = Array.isArray(m.material) ? (m.material[0]?.name ?? null) : ((m.material as THREE.Material)?.name ?? null);
        out.push({ name: m.name || '(unnamed)', instanced: (o as any).isInstancedMesh === true, min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z], material: mat });
      });
      resolve(out);
    }, reject);
  });
  glbCache.set(path, meshes);
  return meshes;
}

const RY = (a: number, p: number[]): number[] => {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]];
};
/** Native mesh boxes -> flight-model body frame, replicating the registration AND BOTH visibility
 *  filters glbAircraft.ts applies at load time: meshes hidden by material name (/concrete/i or
 *  /remove_before_flight/i) and Sketchfab stand leftovers whose geometry reaches more than 25 cm
 *  under the wheels' ground plane (in the file's own frame). */
async function bodyBox(path: string, rotY: number, scale: number[], offset: number[], contactY: number): Promise<{ min: number[]; max: number[]; hiddenMeshes: number }> {
  const hideBelow = (contactY - 0.25 - offset[1]) / scale[1];
  const out = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], hiddenMeshes: 0 };
  for (const b of await glbMeshes(path)) {
    if (b.min[1] < hideBelow || (b.material && (/concrete/i.test(b.material) || /remove_before_flight/i.test(b.material)))) { out.hiddenMeshes++; continue; }
    for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) {
      const r = RY(rotY, [x, y, z]);
      const p = [r[0] * scale[0] + offset[0], r[1] * scale[1] + offset[1], r[2] * scale[2] + offset[2]];
      for (let i = 0; i < 3; i++) { out.min[i] = Math.min(out.min[i], p[i]); out.max[i] = Math.max(out.max[i], p[i]); }
    }
  }
  return out;
}

const FILE_BY_ID: Record<string, string> = { swift: 'src/assets/models/c172.glb', trek: 'src/assets/models/atr72.glb', sky: 'src/assets/models/a320.glb' };

test('GLB aircraft dimensions registered to the body frame match the published specs', async () => {
  const expect: Record<string, { length: number; span: number; height: number; note: string }> = {
    swift: { length: 8.28, span: 11.0, height: 2.72, note: 'C172S' },
    trek: { length: 27.17, span: 27.05, height: 7.65, note: 'ATR 72-600' },
    sky: { length: 37.57, span: 34.1, height: 11.76, note: 'A320-200' },
  };
  const report: string[] = [];
  for (const spec of AIRCRAFT) {
    const cfg = CFG[spec.id];
    if (!cfg) { report.push(`${spec.id}: procedural fallback model (no GLB cfg)`); continue; }
    const e = expect[spec.id];
    if (!e) { report.push(`${spec.id}: no expected-dimension entry (add one when registering a new type)`); continue; }
    const contactY = Math.min(...spec.gear.map((g) => g.pos[1]));
    const bb = await bodyBox(FILE_BY_ID[spec.id], cfg.rotY, cfg.scale, cfg.offset, contactY);
    const span = bb.max[0] - bb.min[0], len = bb.max[2] - bb.min[2], h = bb.max[1] - bb.min[1];
    report.push(`${spec.id} (${e.note}, ${bb.hiddenMeshes} stand meshes hidden): span ${span.toFixed(2)} m (spec ${e.span}), length ${len.toFixed(2)} m (spec ${e.length}), height ${h.toFixed(2)} m (spec ${e.height})`);
    // The registered model must reproduce the real overall dimensions: within 2 % of the reference,
    // with a 0.35 m absolute floor so small dimensions (C172 height 2.72 m) are not untestable.
    const tol = (v: number, ref: number) => Math.abs(v - ref) <= Math.max(0.35, ref * 0.02);
    assert.ok(tol(span, e.span), `${spec.id} span ${span.toFixed(2)} != ${e.span}`);
    assert.ok(tol(len, e.length), `${spec.id} length ${len.toFixed(2)} != ${e.length}`);
    if (spec.id !== 'sky') assert.ok(tol(h, e.height), `${spec.id} height ${h.toFixed(2)} != ${e.height}`);
  }
  console.log('[scale] ' + report.join(' | '));
});

test('GLB wheels bottom out on the physics gear contacts (no floating / sinking at rest)', async () => {
  for (const spec of AIRCRAFT) {
    const cfg = CFG[spec.id];
    if (!cfg) continue;
    if (spec.id === 'sky') {
      // A320 has no gear in the GLB: the procedural struts build the wheel bottoms at spec.gear y by
      // construction (hub = gy + r - attachY), and the belly must sit above the gear line, not under it.
      const contactY = Math.min(...spec.gear.map((g) => g.pos[1]));
      const bb = await bodyBox(FILE_BY_ID.sky, cfg.rotY, cfg.scale, cfg.offset, contactY);
      const belly = bb.min[1];
      // real-world A320 ground clearance under the fuselage is roughly 0.5-1 m
      assert.ok(belly > spec.gear[1].pos[1] + 0.5, `A320 belly ${belly.toFixed(2)} must clear the -3.3 m gear line`);
      assert.ok(belly < spec.gear[1].pos[1] + 2.6, `A320 belly ${belly.toFixed(2)} suspiciously high above the gear line`);
      console.log(`[scale] sky belly at body y=${belly.toFixed(2)} m, gear contact at ${spec.gear[1].pos[1]} m (belly clearance ${(belly - spec.gear[1].pos[1]).toFixed(2)} m)`);
      continue;
    }
    const contactY = Math.min(...spec.gear.map((g) => g.pos[1]));
    const bb = await bodyBox(FILE_BY_ID[spec.id], cfg.rotY, cfg.scale, cfg.offset, contactY);
    const wheelBottom = bb.min[1];
    const contact = spec.gear[1].pos[1];
    const err = wheelBottom - contact;
    assert.ok(Math.abs(err) <= 0.1, `${spec.id} wheel bottom ${wheelBottom.toFixed(3)} vs gear contact ${contact} (err ${err.toFixed(3)} m)`);
    console.log(`[scale] ${spec.id} wheel bottom ${wheelBottom.toFixed(3)} m vs contact ${contact} m (err ${err.toFixed(3)} m)`);
  }
});

test('GLB wheel stations line up with the physics contacts along Z (no shifted undercarriage)', async () => {
  // Decode wheel vertices (tyre bottoms) through the runtime loader, convert each to the body frame
  // with the registered CFG, cluster them around each spec.gear contact and assert the cluster's Z
  // centre against the contact station. This catches registration offsets a bbox height test cannot see.
  const STATION_TOL = 0.35;
  for (const spec of AIRCRAFT) {
    const cfg = CFG[spec.id];
    if (!cfg || spec.id === 'sky') continue; // A320 mounts a procedural gear built exactly on spec.gear
    const bin = readFileSync(FILE_BY_ID[spec.id]);
    const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const errs = await new Promise<number[]>((resolve, reject) => {
      loader.parse(ab, '', (gltf) => {
        gltf.scene.updateMatrixWorld(true);
        const v = new THREE.Vector3();
        const toBody = (p: THREE.Vector3): [number, number, number] => {
          const r = RY(cfg.rotY, [p.x, p.y, p.z]);
          return [r[0] * cfg.scale[0] + cfg.offset[0], r[1] * cfg.scale[1] + cfg.offset[1], r[2] * cfg.scale[2] + cfg.offset[2]];
        };
        const verts: [number, number, number][] = [];
        let bottom = Infinity;
        gltf.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const mat = Array.isArray(m.material) ? m.material[0]?.name ?? '' : (m.material as THREE.Material)?.name ?? '';
          if (/concrete|remove_before_flight/i.test(mat)) return;
          const pos = (m.geometry as THREE.BufferGeometry).attributes.position as THREE.BufferAttribute;
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
            const b = toBody(v);
            verts.push(b);
            if (b[1] < bottom) bottom = b[1];
          }
        });
        // one cluster per gear contact: tyre bottoms (10 cm band) within 1.2 m of the contact in x/z
        const out: number[] = [];
        for (const g of spec.gear) {
          const zs: number[] = [];
          for (const b of verts) {
            if (b[1] > bottom + 0.1) continue;
            if (Math.hypot(b[0] - g.pos[0], b[2] - g.pos[2]) < 1.2) zs.push(b[2]);
          }
          if (!zs.length) { reject(new Error(`${spec.id}: no wheel vertices near contact z=${g.pos[2]}`)); return; }
          out.push((Math.min(...zs) + Math.max(...zs)) / 2 - g.pos[2]);
        }
        resolve(out);
      }, reject);
    });
    spec.gear.forEach((g, i) => {
      assert.ok(Math.abs(errs[i]) <= STATION_TOL, `${spec.id} wheel station ${i} (z=${g.pos[2]}) err ${errs[i].toFixed(2)} m > ${STATION_TOL}`);
      console.log(`[scale] ${spec.id} wheel station ${i} (z=${g.pos[2]}): err ${errs[i].toFixed(2)} m`);
    });
  }
});

test('AGL at rest: defined on the main-gear contact, small vs the static oleo, consistent with y - terrain', () => {
  airState.dT = 0; airState.qnh = 1013.25;
  const GY = 100; // terrain elevation under the aircraft (m MSL)
  for (const spec of AIRCRAFT) {
    const fm = new FlightModel(spec, () => GY);
    fm.placeOnRunway(0, 0, 90, GY);
    const dt = 1 / 120;
    for (let i = 0; i < 120 * 4; i++) fm.step(dt); // settle onto the springs
    assert.ok(fm.wow, `${spec.id} must be on the ground`);
    // definition check: agl is measured from the terrain to the main-gear attachment point
    assert.ok(Math.abs(fm.agl - (fm.pos.y + spec.gear[1].pos[1] - GY)) < 1e-6, `${spec.id} agl definition`);
    // at rest the gear attachment penetrates by the static oleo compression only
    assert.ok(fm.agl > -spec.gearTravel && fm.agl < 0.05, `${spec.id} resting agl ${fm.agl.toFixed(3)} m outside [-gearTravel, +0.05]`);
    // HUD readouts are the same state converted with the geo.ts constants (algebraic identity of the agl definition)
    const aglFt = fm.agl / M_PER_FT, altFt = fm.pos.y / M_PER_FT, groundFt = GY / M_PER_FT;
    assert.ok(Math.abs(aglFt - (altFt - (groundFt - spec.gear[1].pos[1] / M_PER_FT))) < 1e-6, `${spec.id} aglFt/altFt consistency`);
    // the whole aircraft body must not float above or sink through the terrain: belly/tail above ground
    for (const hp of spec.hull) assert.ok(fm.pos.y + hp[1] > GY - 0.25, `${spec.id} hull point y=${hp[1]} below ground at rest`);
    console.log(`[agl] ${spec.id}: resting agl ${fm.agl.toFixed(3)} m (${(fm.agl / M_PER_FT).toFixed(1)} ft), comp ${(fm.gear[1].comp).toFixed(3)} m, alt ${(fm.pos.y).toFixed(2)} m MSL`);
  }
});

test('m/ft conversions used by the HUD are exact (bound to geo.ts constants)', () => {
  assert.equal(M_PER_FT, 0.3048, 'M_PER_FT is the exact definition');
  assert.ok(Math.abs(1000 / M_PER_FT - 3280.839895) < 1e-4, 'm -> ft');
  assert.ok(Math.abs(5 / M_PER_FT * 60 - 984.252) < 1e-3, 'm/s -> fpm (1 fpm = 5.08 mm/s)');
  assert.ok(Math.abs(60 * MS_TO_KT - 116.63084) < 1e-3, 'm/s -> kt (MS_TO_KT multiplies)');
});

// ---------- draw distance ----------
const farPlane = (agl: number) => Math.max(180000, Math.min(350000, 180000 + agl * 12));
const fogFactor = (density: number, dist: number) => 1 - Math.exp(-density * density * dist * dist);
const EARTH_EQ_KM = 40075.017;
const tileKm = (z: number) => EARTH_EQ_KM / (1 << z);

test('far plane matches the dynamic formula and clears the horizon at 10,000 ft; above that, haze takes over', () => {
  const h10000 = 3048;
  assert.equal(farPlane(h10000), 216576);
  const horizon = 3.57 * Math.sqrt(h10000) * 1000; // geometric horizon, km formula in metres
  const horizonRefr = 3.86 * Math.sqrt(h10000) * 1000; // with standard atmospheric refraction
  assert.ok(farPlane(h10000) > horizon, `far ${farPlane(h10000)} m > horizon ${horizon.toFixed(0)} m at 10k ft`);
  assert.ok(farPlane(h10000) > horizonRefr, 'far exceeds the refracted horizon too');
  assert.equal(farPlane(0), 180000);
  // A320 cruise (11 km): far 312 km is BELOW the geometric horizon (~369 km) by design — the visual
  // protection up there comes from the saturated FogExp2 haze over the LOD ring (asserted next).
  assert.equal(farPlane(11000), 312000, '180k + 132k = 312 km');
});

test('the terrain LOD ring reaches past the far plane band and the haze fully saturates its edge at every preset', () => {
  const presets: [string, LodCfg[]][] = [['ultra', LOD_ULTRA], ['high', LOD_HIGH], ['medium', LOD_MEDIUM], ['low', LOD_LOW]];
  // clearest the scene ever gets: the night palette fog floor (world.ts SKY.night.fog = 3.2e-5, the
  // global minimum — the day/visibility branches only ADD density via Math.max, world.ts setSun).
  const MIN_DENSITY = 3.2e-5;
  // ground width shrinks with cos(lat); use the extreme service latitude (±45°, far beyond the
  // Indonesian network) so the invariant holds for any field the sim can load.
  const LAT_FACTOR = Math.cos(Math.PI / 4);
  for (const [name, lods] of presets) {
    const last = lods[lods.length - 1];
    const edgeMin = last.r * tileKm(last.z) * 1000 * LAT_FACTOR; // closest the ring edge can ever be
    const ff = fogFactor(MIN_DENSITY, edgeMin);
    assert.ok(ff > 0.995, `${name}: ring edge fog factor ${ff.toFixed(4)} must fully saturate the haze — no world edge visible`);
    console.log(`[draw] ${name}: z${last.z} r${last.r} ring edge >= ${(edgeMin / 1000).toFixed(0)} km (worst latitude), far ${farPlane(11000) / 1000} km, fog at edge ${ff.toFixed(4)}`);
  }
});

test('structure / tree draw radii stay inside the preset budgets (reported, not enforced here)', () => {
  for (const q of Object.values(QUALITY)) {
    // every preset currently streams a 3x3 z14 ring: outerRing is false on all tiers
    // (quality.ts), so the structures.ts outer-ring branch never engages — report the real budget
    assert.ok(!q.outerRing, `${q.id}: outerRing is disabled in every preset — update this report if it is ever enabled`);
    const structHalf = 1.5 * tileKm(14);
    console.log(`[draw] ${q.id}: structures <=${structHalf.toFixed(1)} km (3x3 z14), trees <=${q.treeBudget.maxDist / 1000} km, structureMaxAgl ${q.structureMaxAgl} m, clouds ${q.clouds}, precip ${q.precipMax}`);
    // Trees scatter within treeBudget.maxDist of the aircraft at build time; the streamed 3x3 z14
    // ring reaches up to 2 tiles in the worst case, so the tree radius must stay inside that.
    assert.ok(q.treeBudget.maxDist <= 2.0 * tileKm(14) * 1000, `${q.id} tree radius inside the streamed structure ring`);
  }
});
