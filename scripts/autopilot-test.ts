import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FlightModel } from '../src/sim/physics';
import { AIRCRAFT } from '../src/sim/specs';
import { Autopilot } from '../src/sim/autopilot';
import { advanceWaypoint, legGuidance, turnLeadM, interceptAngleDeg } from '../src/sim/lnav';
import { Projection, destination, haversine, bearing, wrap180, type FlightWaypoint } from '../src/sim/geo';

const LAT0 = 0.5, LON0 = 110;
const proj = new Projection(LAT0, LON0);

/** Departure RWY 09 at (LAT0, LON0) -> destination ~80 km east-north-east, same fix layout as buildFlightPlan(). */
function makePlan(spec = AIRCRAFT[0]): FlightWaypoint[] {
  const cruiseAlt = Math.max(1800, spec.cruiseAlt * 0.55), cruiseKt = spec.cruiseKt;
  const [climbLat, climbLon] = destination(LAT0, LON0, 90, 5500);
  const [dLat, dLon] = destination(LAT0, LON0, 70, 80000);
  const [arrLat, arrLon] = [dLat, dLon];
  const [fafLat, fafLon] = destination(arrLat, arrLon, 70 + 180, 8500);
  const [iafLat, iafLon] = destination(arrLat, arrLon, 70 + 180, 18500);
  const [crzLat, crzLon] = destination(LAT0, LON0, 80, 35000);
  return [
    { id: 'DEP', name: 'RWY 09', type: 'takeoff', lat: LAT0, lon: LON0, altM: 0, speedKt: 0, hdg: 90 },
    { id: 'CLIMB', name: 'CLIMB 09', type: 'climb', lat: climbLat, lon: climbLon, altM: 550, speedKt: Math.round(cruiseKt * 0.72), hdg: 90 },
    { id: 'CRZ', name: 'CRUISE', type: 'cruise', lat: crzLat, lon: crzLon, altM: cruiseAlt, speedKt: cruiseKt },
    { id: 'IAF', name: 'IAF 07', type: 'iaf', lat: iafLat, lon: iafLon, altM: 900, speedKt: 160, hdg: 70 },
    { id: 'FAF', name: 'FAF 07', type: 'faf', lat: fafLat, lon: fafLon, altM: 450, speedKt: 140, hdg: 70 },
    { id: 'ARR', name: 'RWY 07', type: 'touchdown', lat: arrLat, lon: arrLon, altM: 15, speedKt: spec.vapp, hdg: 70 },
  ];
}

test('airborne past the departure runway: the departure fix is skipped, never targeted', () => {
  const plan = makePlan();
  const [lat, lon] = destination(LAT0, LON0, 90, 3200);
  assert.equal(advanceWaypoint(plan, 0, lat, lon, 60, true), 1, 'must advance to CLIMB');
  // even if the sequencer were bypassed, guidance must not point back at the airport
  const g = legGuidance(plan, 1, lat, lon);
  assert.ok(Math.abs(wrap180(g.course - 90)) < 15, `course ${g.course} should stay roughly east`);
});

test('engaging mid-route selects the leg the aircraft is actually on', () => {
  const plan = makePlan();
  const [lat, lon] = destination(LAT0, LON0, 80, 50000); // beyond the CRZ fix
  const i = advanceWaypoint(plan, 0, lat, lon, 70, true);
  assert.ok(i >= 3, `expected IAF or later, got ${plan[i].id}`);
});

test('fly-by lead distance grows with speed and course change; cross-track gain keeps capture time constant', () => {
  assert.equal(turnLeadM(90, 92, 70), 0);
  const slow = turnLeadM(90, 180, 60), fast = turnLeadM(90, 180, 200);
  assert.ok(fast > slow * 5 && slow > 100);
  const a = interceptAngleDeg(-500, 60), b = interceptAngleDeg(-500, 240);
  assert.ok(a > b && a <= 30 && b > 0, 'slower aircraft intercept more steeply');
  assert.equal(interceptAngleDeg(1e6, 100), -30);
});

for (const spec of [AIRCRAFT[0], AIRCRAFT[AIRCRAFT.length - 1]]) {
  test(`${spec.name}: AP engaged after a manual take-off climbs away on route (no U-turn, no descent into terrain)`, () => {
    const plan = makePlan(spec);
    const fm = new FlightModel(spec, () => 0);
    // 3 km past the threshold, 600 ft AGL, manual take-off finished, wings level on runway heading
    const x0 = proj.x(destination(LAT0, LON0, 90, 3000)[1]);
    fm.placeAirborne(x0, 190, proj.z(LAT0), 90, spec.vs1 * 1.7, 0, false);
    fm.ctl.throttle = 0.9; fm.ctl.gearDown = false;
    const ap = new Autopilot(); ap.vsLimit = spec.kind === 'jet' ? 12 : spec.kind === 'turboprop' ? 7 : 4.5;
    ap.engage(fm); ap.nav = true; fm.ctl.apHold = true; fm.ctl.assist = true;
    let idx = 0, t = 0; const dt = 1 / 60;
    let minAgl = 1e9, maxAlt = 0;
    const log: string[] = [];
    for (let i = 0; i < 60 * 420; i++, t += dt) {
      const lat = proj.lat(fm.pos.z), lon = proj.lon(fm.pos.x);
      idx = advanceWaypoint(plan, idx, lat, lon, Math.max(20, fm.gs), !fm.wow);
      const c = ap.step(fm, dt, bearing(lat, lon, plan[idx].lat, plan[idx].lon), null, plan, idx, lat, lon);
      fm.ctl.pitch = c.pitch; fm.ctl.roll = c.roll; fm.ctl.yaw = c.yaw; if (c.throttle !== null) fm.ctl.throttle = c.throttle;
      if (c.gearDown !== undefined) fm.ctl.gearDown = c.gearDown; if (c.flapsIdx !== undefined) fm.ctl.flapsIdx = c.flapsIdx;
      fm.step(dt);
      if (fm.crashed) assert.fail(`crashed at t=${t.toFixed(0)}s: ${fm.crashReason} (wp ${plan[idx].id})`);
      minAgl = Math.min(minAgl, fm.agl); maxAlt = Math.max(maxAlt, fm.pos.y);
      if (i % (60 * 30) === 0) log.push(`t=${t.toFixed(0)} wp=${plan[idx].id} alt=${(fm.pos.y / 0.3048).toFixed(0)}ft kias=${(fm.ias / 0.514444).toFixed(0)} hdg=${fm.heading.toFixed(0)} dist=${(haversine(lat, lon, LAT0, LON0) / 1000).toFixed(1)}km phase=${ap.phase}`);
      if (t > 40) assert.ok(haversine(lat, lon, LAT0, LON0) > 3000 + (t - 40) * 20, `aircraft is returning to the airport at t=${t.toFixed(0)}\n${log.join('\n')}`);
    }
    assert.ok(minAgl > 60, `dipped to ${minAgl.toFixed(0)} m AGL\n${log.join('\n')}`);
    assert.ok(maxAlt > 600, `never climbed (max ${maxAlt.toFixed(0)} m)\n${log.join('\n')}`);
    assert.notEqual(plan[idx].id, 'DEP');
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Flight-plan / VNAV / approach regression tests (the autopilot used to U-turn at a mis-placed TOD, cruise at FL360 on a
// 160 NM trip, hold 185 kt on final and bounce on landing).
// ---------------------------------------------------------------------------------------------------------------------
import { buildFlightPlan } from '../src/sim/game';
import { advanceWaypoint as advance } from '../src/sim/lnav';
import { minSpeedKt } from '../src/sim/autopilot';
import type { Threshold } from '../src/sim/world';
import type { Airport } from '../src/data/airports';

const mkAirport = (id: string, lat: number, lon: number): Airport => ({ id, icao: id, name: id, city: id, country: 'ID', lat, lon, elev: 0, size: 2, iata: '', runways: [], approx: false });
const mkTh = (ap: Airport, ident: string, lat: number, lon: number, hdg: number): Threshold => ({
  ap, rw: {} as Threshold['rw'], end: 'le', ident, x: 0, z: 0, hdg, len: 3000, wid: 45, elev: 0, lat, lon, dispM: 0, startX: 0, startZ: 0,
  startLat: lat, startLon: lon, fullLen: 3000, surface: 'A', lit: true,
});
/** Route of `km` kilometres on `course` from a 1:1 departure airport, arriving on a runway aligned with the route. */
function route(km: number, course: number) {
  const dep = mkAirport('AAAA', 0.5, 110), [aLat, aLon] = destination(dep.lat, dep.lon, course, km * 1000), arr = mkAirport('BBBB', aLat, aLon);
  const depTh = mkTh(dep, '09', dep.lat, dep.lon, course), arrTh = mkTh(arr, '27', aLat, aLon, course);
  const spec = AIRCRAFT[0];
  return { dep, arr, depTh, arrTh, spec, plan: buildFlightPlan(dep, depTh, arr, arrTh, spec.cruiseAlt, spec.cruiseKt, spec.vapp, true) };
}

test('flight plan: CRUISE, TOD and IAF are in route order, the TOD sits on the 3° path, and the level fits the route', () => {
  for (const [km, course] of [[30, 20], [90, 300], [300, 110], [1000, 250], [2500, 75]] as const) {
    const { plan, depTh } = route(km, course);
    const d = (id: string) => { const w = plan.find((x) => x.id === id); return w ? haversine(depTh.lat, depTh.lon, w.lat, w.lon) : null; };
    const seq = ['CLIMB', 'CRZ', 'TOD', 'IAF'].map(d).filter((v): v is number => v !== null);
    for (let i = 1; i < seq.length; i++) assert.ok(seq[i] > seq[i - 1], `${km} km: fixes out of order ${seq.map(Math.round)}`);
    const crz = plan.find((w) => w.id === 'CRZ');
    if (crz) {
      const ft = Math.round(crz.altM / 0.3048 / 1000);
      assert.equal(ft % 2 === 1, course < 180, `${km} km / ${course}°: FL${ft * 10} breaks the semicircular rule`);
      assert.ok(crz.altM <= AIRCRAFT[0].cruiseAlt + 1, 'never above the aircraft ceiling');
      assert.ok(km > 300 || crz.altM < 9000, `${km} km: a short trip must not cruise at FL360`);
    }
    const tod = plan.find((w) => w.id === 'TOD'), arr = plan.find((w) => w.id === 'ARR')!;
    if (tod) {
      const alongToThr = haversine(tod.lat, tod.lon, arr.lat, arr.lon); // same great circle
      assert.ok(Math.abs((tod.altM - arr.altM) / Math.tan(3 * Math.PI / 180) - alongToThr) < 400, `${km} km: TOD is ${alongToThr} m out, expected the 3° point`);
    }
  }
});

test('minimum autopilot speed follows the flap configuration (clean ≈ 175 kt, CONF FULL ≈ Vref) instead of a clean-wing floor', () => {
  const spec = AIRCRAFT[0], fm = new FlightModel(spec, () => 0);
  fm.flapsPos = 0; assert.ok(Math.abs(minSpeedKt(fm) - spec.vs1 * 1.23) < 0.01);
  fm.flapsPos = 1; assert.ok(minSpeedKt(fm) <= spec.vapp, `FULL floor ${minSpeedKt(fm)} must allow Vapp ${spec.vapp}`);
});

test('closed loop: autoland over a 70 NM route follows the plan in order, touches down near Vapp and stops on the runway', () => {
  const { depTh, arrTh, spec, plan, dep } = route(130, 70);
  const proj = new Projection(dep.lat, dep.lon), fm = new FlightModel(spec, () => 0);
  fm.placeOnRunway(proj.x(depTh.lon), proj.z(depTh.lat), depTh.hdg, 0, false); fm.ctl.parking = false;
  const ap = new Autopilot(); ap.vsLimit = 12; ap.armTakeoff(fm, depTh.hdg, spec.vr, Math.max(1500, spec.cruiseAlt * 0.35)); fm.ctl.assist = true; fm.ctl.apHold = true;
  const dt = 1 / 30; let idx = 0, td: { vs: number; kias: number } | null = null, maxTodDist = 0;
  for (let i = 0; i < 30 * 3600 && !fm.crashed && ap.phase !== 'stopped'; i++) {
    const la = proj.lat(fm.pos.z), lo = proj.lon(fm.pos.x);
    const next = advance(plan, idx, la, lo, Math.max(20, fm.gs), !fm.wow);
    assert.ok(next >= idx, 'the active fix never moves backwards');
    idx = next;
    const c = ap.step(fm, dt, bearing(la, lo, plan[idx].lat, plan[idx].lon), null, plan, idx, la, lo);
    fm.ctl.pitch = c.pitch; fm.ctl.roll = c.roll; if (c.throttle !== null) fm.ctl.throttle = c.throttle; fm.ctl.yaw = c.yaw;
    if (c.gearDown !== undefined) fm.ctl.gearDown = c.gearDown; if (c.flapsIdx !== undefined) fm.ctl.flapsIdx = c.flapsIdx;
    if (c.brake) fm.ctl.brake = Math.max(fm.ctl.brake, c.brake); if (c.parking) fm.ctl.parking = true; if (c.reverse !== undefined) fm.ctl.reverse = c.reverse; if (c.speedbrake !== undefined) fm.ctl.speedbrake = c.speedbrake;
    fm.step(dt);
    for (const e of fm.events.splice(0)) if (e.kind === 'touchdown' && !td) td = { vs: e.vs * 196.85, kias: fm.ias / 0.514444 };
    if (plan[idx].id === 'TOD') maxTodDist = Math.max(maxTodDist, haversine(la, lo, plan[idx].lat, plan[idx].lon));
  }
  assert.ok(!fm.crashed, `crashed: ${fm.crashReason}`);
  assert.ok(td, 'never touched down');
  assert.ok(td!.vs > -600, `hard landing ${td!.vs.toFixed(0)} fpm`);
  assert.ok(td!.kias < spec.vapp + 12 && td!.kias > spec.vapp - 12, `touchdown at ${td!.kias.toFixed(0)} kt, Vapp ${spec.vapp}`);
  assert.equal(ap.phase, 'stopped');
  assert.ok(haversine(proj.lat(fm.pos.z), proj.lon(fm.pos.x), arrTh.lat, arrTh.lon) < 3000, 'stopped on the runway');
  assert.ok(Math.abs(wrap180(fm.heading - arrTh.hdg)) < 5, 'stopped aligned with the runway');
});
