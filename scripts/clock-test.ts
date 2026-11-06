// Real-time clock / solar-position regression. Reference values were fetched from the sunrise-sunset.org API
// (independent implementation) for the dates below; our NOAA/Meeus solver must agree to within ~2 minutes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sunPosition, sunPhase, simNowMs, formatUtc, daylight, nightLights } from '../src/sim/clock';

function crossings(lat: number, lon: number, day: string) {
  const t0 = Date.parse(day + 'T00:00:00Z'); let noon = 0, best = -99, rise = 0, set = 0;
  for (let m = 0; m < 1440; m += 0.25) {
    const e = sunPosition(t0 + m * 60000, lat, lon).elevation, p = sunPosition(t0 + (m - 0.25) * 60000, lat, lon).elevation;
    if (e > best) { best = e; noon = m; }
    if (p < -0.833 && e >= -0.833 && !rise) rise = m;
    if (p >= -0.833 && e < -0.833) set = m;
  }
  return { noon, rise, set, best };
}
const min = (iso: string) => { const d = new Date(iso); return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60; };

test('solar noon / sunset match an independent reference (London, 21 Jun 2026)', () => {
  const c = crossings(51.4706, -0.4619, '2026-06-21');
  assert.ok(Math.abs(c.noon - min('2026-06-21T12:03:40+00:00')) < 2, `noon ${c.noon}`);
  assert.ok(Math.abs(c.set - min('2026-06-21T20:22:44+00:00')) < 2.5, `sunset ${c.set}`);
});
test('solar noon matches an independent reference (Jakarta, 6 Nov 2026)', () => {
  const c = crossings(-6.1256, 106.656, '2026-11-06');
  assert.ok(Math.abs(c.noon - min('2026-11-06T04:36:59+00:00')) < 2, `noon ${c.noon}`);
  assert.ok(c.best > 78 && c.best < 82);
});
test('night is dark, noon is bright, phases are ordered', () => {
  assert.equal(sunPhase(40), 'day'); assert.equal(sunPhase(-3), 'civil'); assert.equal(sunPhase(-30), 'night');
  assert.ok(daylight(40) > 0.99 && daylight(-20) < 0.01);
  assert.ok(nightLights(-10) > 0.99 && nightLights(30) < 0.01);
});
test('the simulation clock IS the real clock (no offset, no scaling)', () => {
  const a = Date.now(), s = simNowMs(), b = Date.now();
  assert.ok(s >= a && s <= b);
  assert.match(formatUtc(Date.UTC(2026, 0, 1, 7, 5, 9)), /^07:05:09$/);
});
