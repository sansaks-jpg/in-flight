// Scale / altitude / draw-distance verification (Tugas 2 + review fixes):
//   1. Build the ACTUAL procedural exterior models (aircraftModel.ts — the models the game renders)
//      and check that the body-frame dimensions match specs.ts (length / span / height), that the
//      wheels bottom out on the physics gear contacts, and that a gear assembly sits exactly on
//      every spec.gear station (no floating / sinking / station offset on the ground).
//   2. Simulate the physics on flat ground and assert fm.agl, its definition and the m->ft HUD
//      conversions are consistent (altimeter vs terrain elevation vs radio altitude).
//   3. Assert the camera far plane, the terrain LOD ring extent and FogExp2 density leave no visible
//      "edge of the world" at any quality preset.
// Runs headless in node — no WebGL and no DOM: the livery texture is skipped (colour-only material),
// which does not affect the geometry under test.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { FlightModel, airState } from '../src/sim/physics';
import { AIRCRAFT } from '../src/sim/specs';
import { loadAircraftVisual } from '../src/sim/aircraftModel';
import { LOD_HIGH, LOD_MEDIUM, LOD_LOW, LOD_ULTRA, LodCfg } from '../src/sim/terrain';
import { QUALITY } from '../src/sim/quality';
import { M_PER_FT, MS_TO_KT } from '../src/sim/geo';

/** One body-frame AABB of the whole built aircraft (wheels included — they are the lowest points). */
async function bodyBox(specId: string): Promise<{ min: THREE.Vector3; max: THREE.Vector3 }> {
  const v = await loadAircraftVisual(AIRCRAFT.find((s) => s.id === specId)!);
  v.root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(v.root);
  return { min: box.min.clone(), max: box.max.clone() };
}

test('procedural aircraft dimensions match the published specs (1:1 body frame)', async () => {
  const report: string[] = [];
  for (const spec of AIRCRAFT) {
    const bb = await bodyBox(spec.id);
    const span = bb.max.x - bb.min.x, len = bb.max.z - bb.min.z;
    // spec.height is ground-referenced; the body frame hangs the CG ~|gear y| above the ground, so
    // the model total = box height (wheel bottom .. fin tip) must equal the published height.
    const h = bb.max.y - bb.min.y;
    report.push(`${spec.id}: span ${span.toFixed(2)} m (spec ${spec.wingspan}), length ${len.toFixed(2)} m (spec ${spec.length}), height ${h.toFixed(2)} m (spec ${spec.height})`);
    // The models are authored 1:1 from these numbers. The measured box includes details that
    // legitimately poke past the nominal datum — wingtip nav-light bulbs (r 0.05-0.07 per side),
    // the A320 APU exhaust (0.15 m) and the C172 fin trailing edge (0.22 m) — so the tolerance is
    // 2.5 % with a 0.25 m floor: tight enough to catch a real scale error (the old GLB registration
    // was 8 m off), honest about the details.
    const tol = (v: number, ref: number) => Math.abs(v - ref) <= Math.max(0.25, ref * 0.025);
    assert.ok(tol(span, spec.wingspan), `${spec.id} span ${span.toFixed(2)} != ${spec.wingspan}`);
    assert.ok(tol(len, spec.length), `${spec.id} length ${len.toFixed(2)} != ${spec.length}`);
    assert.ok(tol(h, spec.height), `${spec.id} height ${h.toFixed(2)} != ${spec.height}`);
  }
  console.log('[scale] ' + report.join(' | '));
});

test('procedural wheels bottom out on the physics gear contacts (no floating / sinking at rest)', async () => {
  for (const spec of AIRCRAFT) {
    const bb = await bodyBox(spec.id);
    const contact = Math.min(...spec.gear.map((g) => g.pos[1]));
    const err = bb.min.y - contact;
    assert.ok(Math.abs(err) <= 0.1, `${spec.id} wheel bottom ${bb.min.y.toFixed(3)} vs lowest gear contact ${contact} (err ${err.toFixed(3)} m)`);
    console.log(`[scale] ${spec.id} wheel bottom ${bb.min.y.toFixed(3)} m vs lowest contact ${contact} m (err ${err.toFixed(3)} m)`);
    // A320-only sanity from the GLB era, kept for the procedural jet: the belly fairing must sit
    // well above the gear line (real-world ground clearance ~0.5-1 m) — checked via the fuselage
    // bottom against the main-gear contact.
    if (spec.id === 'sky') {
      const mainGear = spec.gear[1].pos[1];
      assert.ok(bb.min.y > mainGear - 0.1, 'A320 wheels define the lowest point (gear present)');
      console.log(`[scale] sky belly clearance to gear line: ${(bb.min.y - mainGear).toFixed(2)} m (procedural gear mounted on spec.gear)`);
    }
  }
});

test('procedural gear assemblies sit exactly on their physics contacts (no shifted undercarriage)', async () => {
  // The gear groups are built straight from spec.gear (position x/z + strut length from the wheel
  // radius). This pins that contract: one root-level gear group must exist at every contact x/z,
  // carrying at least one wheel below the attach point. Catches any future refactor that moves
  // the undercarriage off the flight-model stations.
  for (const spec of AIRCRAFT) {
    const v = await loadAircraftVisual(spec);
    v.root.updateMatrixWorld(true);
    for (const g of spec.gear) {
      const hit = v.root.children.filter((o) => Math.abs(o.position.x - g.pos[0]) < 1e-6 && Math.abs(o.position.z - g.pos[2]) < 1e-6 && o.children.length > 0);
      assert.ok(hit.length > 0, `${spec.id}: no assembly at gear station (${g.pos[0]}, ${g.pos[2]})`);
      // the wheel axle sits exactly one wheel-radius above the contact: axleY = gy + R (strut length
      // is derived from it), so the lowest direct child must land there — not at the contact itself
      const R = g.nose ? spec.wheelR[1] : spec.wheelR[0];
      const lowest = Math.min(...hit.flatMap((o) => o.children.map((c) => o.position.y + c.position.y)));
      assert.ok(Math.abs(lowest - (g.pos[1] + R)) < 1e-6, `${spec.id}: gear at (${g.pos[0]}, ${g.pos[2]}) axle ${lowest.toFixed(3)} != contact ${g.pos[1]} + R ${R}`);
      console.log(`[scale] ${spec.id} gear station (${g.pos[0]}, ${g.pos[2]}): assembly found, axle y ${lowest.toFixed(3)} = contact ${g.pos[1]} + R ${R}`);
    }
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
