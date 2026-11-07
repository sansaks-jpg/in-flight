// Atmosphere regression: live-data cloud field, lightning, precipitation budgets, weather-derived
// visibility and the mid/high deck bases. Runs headless (node) — three.js object maths only, no WebGL.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { CloudField, CELL } from '../src/sim/clouds';
import { LightningSystem, BOLT_DUR } from '../src/sim/lightning';
import { Precip } from '../src/sim/precip';
import { AudioEngine } from '../src/sim/audio';
import { midHighBases, precipVisibility, OFFLINE_WX } from '../src/sim/liveWeather';
import { QUALITY } from '../src/sim/quality';

const tex = () => new THREE.DataTexture(new Uint8Array([255, 255, 255, 235]), 1, 1);

test('mid/high cloud deck bases follow the model geopotential, clamped, with ISA fallback', () => {
  assert.deepEqual(midHighBases(3120, 9420), { mid: 3120, high: 9420 });
  assert.deepEqual(midHighBases(2100, 13000), { mid: 2200, high: 12500 }, 'clamped to sane bands');
  assert.deepEqual(midHighBases(null, null), { mid: 3100, high: 9160 }, 'standard atmosphere fallback');
  assert.ok(OFFLINE_WX.midBaseMsl > 2500 && OFFLINE_WX.highBaseMsl > 8000);
});

test('precipitation haze caps visibility; clear air keeps the reported value', () => {
  assert.equal(precipVisibility(30000, 0, 0), 30000);
  assert.equal(precipVisibility(24000, 0.5, 0), 13000, 'moderate rain ~13 km');
  assert.equal(precipVisibility(30000, 0, 1), 6000, 'heavy snow ~6 km');
  assert.equal(precipVisibility(900, 1, 0), 900, 'never better than the reported METAR vis');
  assert.equal(precipVisibility(400, 0.4, 0), 400);
});

test('quality presets scale the cloud and precipitation budgets coherently', () => {
  const order = ['ultra', 'high', 'medium', 'low'] as const;
  assert.ok(QUALITY.ultra.clouds <= 48, 'ultra cloud budget must fit the CloudField instance capacity (clouds.ts CAP)');
  for (let i = 1; i < order.length; i++) {
    assert.ok(QUALITY[order[i - 1]].clouds > QUALITY[order[i]].clouds, `${order[i - 1]} clouds > ${order[i]}`);
    assert.ok(QUALITY[order[i - 1]].precipMax > QUALITY[order[i]].precipMax, `${order[i - 1]} precip > ${order[i]}`);
  }
  assert.ok(QUALITY.low.precipMax >= 400 && QUALITY.ultra.precipMax <= 6000);
});

test('CloudField: budget, live deck bases, NaN-free update', () => {
  const scene = new THREE.Scene();
  const cf = new CloudField(scene, 48, tex());
  const cam = new THREE.Vector3(0, 3000, 0);
  const sun = new THREE.Vector3(0, 1, 0);
  const lit = new THREE.Color(1, 1, 1), shadow = new THREE.Color(0.5, 0.53, 0.6), p = new THREE.Vector3();

  cf.setLiveWeather([0, 0, 0], 1500, 3100, 9100);
  cf.update(cam, 0, sun, lit, shadow, 0, 0);
  assert.equal(cf.count, 0, 'clear sky renders nothing');
  assert.equal(cf.mesh.visible, false);

  cf.setLiveWeather([1, 1, 1], 1500, 3100, 9100);
  cf.update(cam, 0, sun, lit, shadow, 0, 0);
  assert.equal(cf.count, 48, 'overcast saturates the budget');
  assert.equal(cf.mesh.visible, true);
  let low = 0, mid = 0, high = 0;
  for (let i = 0; i < cf.count; i++) {
    cf.offsetAt(i, p);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), 'no NaN instance data');
    if (p.y >= 1500 && p.y < 2000) low++;
    else if (p.y >= 3100 && p.y < 4000) mid++;
    else if (p.y >= 9100 && p.y < 10400) high++;
    else assert.fail(`instance y=${p.y} outside any live deck base band`);
  }
  assert.ok(low > 0 && mid > 0 && high > 0, `all three layers present (low=${low} mid=${mid} high=${high})`);

  cf.setBudget(14);
  cf.update(cam, 0, sun, lit, shadow, 0, 0);
  assert.ok(cf.count <= 14, 'budget respected');
  assert.ok(cf.count > 0, 'low preset still renders overcast');
});

test('CloudField: decks advect with the live wind, sheared per layer, frozen when time stops', () => {
  const scene = new THREE.Scene();
  const cf = new CloudField(scene, 48, tex());
  // camera safely inside a grid cell so a few metres of drift cannot cross a cell boundary
  const cam = new THREE.Vector3(3000, 3000, 3000);
  const sun = new THREE.Vector3(0, 1, 0);
  const lit = new THREE.Color(1, 1, 1), shadow = new THREE.Color(0.5, 0.53, 0.6), a = new THREE.Vector3(), b = new THREE.Vector3();
  cf.setLiveWeather([1, 1, 1], 1500, 3100, 9100);
  cf.update(cam, 10, sun, lit, shadow, 4, 0); // first frame: dt = 0, no drift yet

  // wind (4 m/s east) over 1 s: low deck sheared 0.75x, mid 1.0x, high 1.35x
  cf.update(cam, 11, sun, lit, shadow, 4, 0);
  const want = [3, 4, 5.4];
  const seen = [0, 0, 0];
  for (let i = 0; i < cf.count; i++) {
    cf.offsetAt(i, a);
    const layer = a.y >= 9100 ? 2 : a.y >= 3100 ? 1 : 0;
    seen[layer]++;
    cf.update(cam, 11.0001, sun, lit, shadow, 4, 0); // tiny dt must move nothing measurably
    cf.offsetAt(i, b);
    assert.ok(Math.abs(b.x - a.x) < 0.01, 'same-clock update is a no-op');
  }
  assert.ok(seen[0] > 0 && seen[1] > 0 && seen[2] > 0);
  // re-run one second and verify per-layer shear against the expected displacement
  const offsets: number[] = [];
  for (let i = 0; i < cf.count; i++) { cf.offsetAt(i, a); offsets.push(a.x, a.y, a.z); }
  cf.update(cam, 12, sun, lit, shadow, 4, 0);
  let checked = 0;
  for (let i = 0; i < cf.count; i++) {
    const layer = offsets[i * 3 + 1] >= 9100 ? 2 : offsets[i * 3 + 1] >= 3100 ? 1 : 0;
    cf.offsetAt(i, b);
    const dx = b.x - offsets[i * 3];
    assert.ok(Math.abs(dx - want[layer]) < 0.05, `layer ${layer} drift ${dx} ≈ wind ${want[layer]} m/s`);
    assert.equal(b.y, offsets[i * 3 + 1]);
    checked++;
  }
  assert.ok(checked >= 40, 'enough instances to prove the shear per layer');
  // paused (time frozen): a second update at the same clock instant must move nothing
  cf.offsetAt(0, b);
  const frozenX = b.x;
  cf.update(cam, 12, sun, lit, shadow, 4, 0);
  cf.offsetAt(0, b);
  assert.equal(b.x, frozenX, 'paused sim freezes the deck');
});

test('CloudField: hour-long wind drift keeps every deck around the camera (no empty sky downwind)', () => {
  const scene = new THREE.Scene();
  const cf = new CloudField(scene, 48, tex());
  const cam = new THREE.Vector3(3000, 3000, 3000);
  const sun = new THREE.Vector3(0, 1, 0);
  const lit = new THREE.Color(1, 1, 1), shadow = new THREE.Color(0.5, 0.53, 0.6), p = new THREE.Vector3();
  cf.setLiveWeather([1, 1, 1], 1500, 3100, 9100);
  // one full hour of 20/5 m/s wind (72/18 km of accumulated drift), advanced in 2 s steps because
  // single updates clamp dt (pause/big-jump guard) and would accumulate nothing
  cf.update(cam, 100, sun, lit, shadow, 20, 5); // first frame: dt = 0
  for (let s = 1; s <= 1800; s++) cf.update(cam, 100 + s * 2, sun, lit, shadow, 20, 5);
  assert.equal(cf.count, 48, 'budget still saturated after an hour of drift');
  const reach = (Math.ceil(Math.sqrt(48) / 2) + 2) * CELL;
  let nearest = Infinity;
  for (let i = 0; i < cf.count; i++) {
    cf.offsetAt(i, p);
    assert.ok(Math.abs(p.x - cam.x) <= reach && Math.abs(p.z - cam.z) <= reach, `instance ${i} still within the camera ring (${p.x - cam.x}, ${p.z - cam.z})`);
    nearest = Math.min(nearest, Math.hypot(p.x - cam.x, p.z - cam.z));
  }
  assert.ok(nearest < 4500, `nearest puff is overhead, not at the window edge (${nearest.toFixed(0)} m)`);
});

test('LightningSystem: strike cadence on the sim clock, distance hook, flash decays to zero', () => {
  const scene = new THREE.Scene();
  const ls = new LightningSystem(scene);
  const cam = new THREE.Vector3(0, 2000, 0);
  const strikes: number[] = [];
  ls.onStrike = (d) => strikes.push(d);
  ls.setActive(true);

  ls.update(0, cam, 1800, () => 100); // clock ticks once; the ~5 s cadence means no strike yet
  assert.equal(strikes.length, 0);
  let t = 0;
  for (t = 0.016; t <= 60 && strikes.length === 0; t += 0.016) ls.update(t, cam, 1800, () => 100);
  assert.equal(strikes.length, 1, 'a strike fires within a minute of storm onset');
  assert.ok(strikes[0] >= 2600 && strikes[0] <= 8200, `strike distance ${strikes[0]} in band`);
  assert.ok(ls.light.intensity > 0, 'flash light active');
  assert.ok(ls.group.children.some((c) => (c as THREE.Mesh).isMesh && c.visible), 'bolt visible');

  t += BOLT_DUR + 0.1;
  ls.update(t, cam, 1800, () => 100);
  assert.equal(ls.light.intensity, 0, 'flash decays to zero after the stroke envelope');
  assert.ok(ls.group.children.every((c) => !(c as THREE.Mesh).isMesh || !c.visible), 'bolt hidden again');

  ls.setActive(false);
  ls.update(t + 20, cam, 1800, () => 100);
  ls.update(t + 40, cam, 1800, () => 100);
  assert.equal(strikes.length, 1, 'no strikes when the storm is inactive');
  ls.dispose();
});

test('Precip: particle budget follows the quality preset in BOTH directions and rain intensity', () => {
  const scene = new THREE.Scene();
  // the game allocates for the LARGEST preset (game.ts) then caps to the active one
  const pr = new Precip(scene, QUALITY.ultra.precipMax);
  const cam = new THREE.Vector3(0, 500, 0);
  const rel = new THREE.Vector3(0, 0, 0);
  pr.setQuality(QUALITY.medium.precipMax);
  pr.set(1, 0);
  pr.update(0.016, cam, rel, 1e9, 1);
  assert.equal(pr.drawn, QUALITY.medium.precipMax, 'heavy rain saturates the medium budget');
  pr.set(0.2, 0);
  pr.update(0.016, cam, rel, 1e9, 1);
  assert.equal(pr.drawn, 450, 'light rain draws ~30% of the budget');
  // raising the preset mid-flight must unlock the bigger allocation too
  pr.setQuality(QUALITY.ultra.precipMax);
  pr.set(1, 0);
  pr.update(0.016, cam, rel, 1e9, 1);
  assert.equal(pr.drawn, QUALITY.ultra.precipMax, 'raising the preset gets the full ultra budget');
  pr.setQuality(700);
  pr.set(1, 0);
  pr.update(0.016, cam, rel, 1e9, 1);
  assert.equal(pr.drawn, 700, 'lowering again works without reallocating');
  pr.set(0, 0);
  pr.update(0.016, cam, rel, 1e9, 1);
  assert.equal(pr.drawn, 0, 'dry air draws nothing');
  pr.dispose();
});

test('AudioEngine.thunder is a safe no-op without an AudioContext (headless guard)', () => {
  const ae = new AudioEngine();
  assert.doesNotThrow(() => ae.thunder(0.8, 1.2));
});
