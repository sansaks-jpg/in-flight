import assert from 'node:assert/strict';
import test from 'node:test';
import { AIRPORT_BY_ID, AIRPORTS } from '../src/data/airports';
import { specById } from '../src/sim/specs';
import {
  AIRCRAFT_VARIANTS,
  computeRouteDispatch,
  expandAirportRunways,
  filterAircraftVariants,
  getAircraftStatsComparison,
  getCuratedRoutes,
  REPO_FACTS,
} from '../src/ui/flightDispatch';

test('REPO_FACTS strictly match the repository dataset counts and architecture', () => {
  assert.equal(REPO_FACTS.totalAirports, AIRPORTS.length);
  assert.equal(REPO_FACTS.totalAirports, 6615);
  assert.equal(REPO_FACTS.indonesiaAirports, 157);
  assert.equal(REPO_FACTS.aircraftCount, 3);
  assert.ok(REPO_FACTS.terrainSource.includes('AWS'));
  assert.ok(REPO_FACTS.imagerySource.includes('Esri'));
  assert.ok(REPO_FACTS.vectorSource.includes('OpenStreetMap'));
});

test('filterAircraftVariants filters by category, search query, and favourites', () => {
  const all = filterAircraftVariants('all', '');
  assert.equal(all.length, AIRCRAFT_VARIANTS.length);

  const jets = filterAircraftVariants('jet', '');
  assert.equal(jets.length, 3);
  assert.ok(jets.every((v) => v.aircraftId === 'sky'));

  const bushSearch = filterAircraftVariants('all', 'Papua');
  assert.equal(bushSearch.length, 1);
  assert.equal(bushSearch[0].aircraftId, 'trek');

  const favs = filterAircraftVariants('all', '', true, ['sky-cfm-std']);
  assert.equal(favs.length, 1);
  assert.equal(favs[0].variantId, 'sky-cfm-std');
});

test('getAircraftStatsComparison computes cruise, ceiling, range, and deltas', () => {
  const stats = getAircraftStatsComparison('sky', 'swift');
  assert.equal(stats.cruiseKt, 450);
  assert.ok(stats.cruiseDeltaKt > 250);
  assert.ok(stats.ceilingDeltaFt > 20000);
  assert.ok(stats.rangeDeltaKm > 3000);
  assert.equal(stats.pax, 150);
});

test('computeRouteDispatch calculates geodesic distance, ETE, fuel, and range eligibility', () => {
  const wiii = AIRPORT_BY_ID.get('WIII')!;
  const wahi = AIRPORT_BY_ID.get('WAHI')!;
  const swift = specById('swift');
  const summary = computeRouteDispatch(wiii, wahi, swift);
  assert.ok(summary.distanceKm > 400 && summary.distanceKm < 500);
  assert.ok(summary.distanceNm > 200 && summary.distanceNm < 300);
  assert.ok(summary.eteMinutes > 60);
  assert.equal(summary.inRange, true);
  assert.equal(summary.sameAirport, false);
  assert.equal(summary.canFly, true);
});

test('expandAirportRunways splits multi-end runway descriptors into threshold options', () => {
  const wiii = AIRPORT_BY_ID.get('WIII')!;
  const rwys = expandAirportRunways(wiii);
  assert.ok(rwys.length >= 2);
  assert.ok(rwys.some((r) => r.ident === '07R' || r.ident === '25L' || r.ident === '07L'));
  assert.ok(rwys[0].lengthM > 2000);
});

test('getCuratedRoutes returns valid routes grounded in the airport database', () => {
  const routes = getCuratedRoutes('all');
  assert.ok(routes.length >= 15);
  const idRoutes = getCuratedRoutes('id');
  assert.ok(idRoutes.length >= 10);
  assert.equal(idRoutes[0].fromIcao, 'WIII');
});
