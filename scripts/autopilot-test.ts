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
