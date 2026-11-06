import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { AIRPORT_BY_ID, AIRPORTS } from '../src/data/airports';
import { specById } from '../src/sim/specs';
import {
  AIRCRAFT_STUDIO_IMAGES,
  AIRCRAFT_VARIANTS,
  computeGlobeEulerForLatLon,
  computeMenuContinentalTarget,
  computeRouteDispatch,
  computeRouteFocusView,
  expandAirportRunways,
  filterAircraftVariants,
  getAircraftStatsComparison,
  getCuratedRoutes,
  latDegToEquirectangularY,
  latLonToMercatorTile,
  latLonToUnitSphere,
  MENU_BENTO_TILES,
  mercatorTileYToLatDeg,
  REPO_FACTS,
} from '../src/ui/flightDispatch';

test('REPO_FACTS strictly match the repository dataset counts and architecture', () => {
  assert.equal(REPO_FACTS.totalAirports, AIRPORTS.length);
  // the world runway rebuild widened the airport set (every large/medium airport + scheduled service); never fewer than the original 7,134
  assert.ok(REPO_FACTS.totalAirports >= 7134);
  assert.equal(REPO_FACTS.indonesiaAirports, 676);
  assert.equal(REPO_FACTS.aircraftCount, 3);
  assert.ok(REPO_FACTS.terrainSource.includes('AWS'));
  assert.ok(REPO_FACTS.imagerySource.includes('Esri'));
  assert.ok(REPO_FACTS.vectorSource.includes('OpenStreetMap'));
});

test('MENU_BENTO_TILES and AIRCRAFT_VARIANTS provide valid local photographic assets for every menu box and aircraft', () => {
  assert.equal(MENU_BENTO_TILES.length, 6);
  const expectedIds = [
    'world_photographer',
    'challenge_league',
    'activities',
    'career',
    'free_flight',
    'marketplace',
  ];
  assert.deepEqual(
    MENU_BENTO_TILES.map((t) => t.id),
    expectedIds
  );
  for (const tile of MENU_BENTO_TILES) {
    assert.ok(tile.imageUrl.startsWith('/src/assets/images/menu_'));
    assert.ok(tile.title.length > 0);
    assert.ok(tile.subtitle.length > 0);
  }

  for (const variant of AIRCRAFT_VARIANTS) {
    assert.equal(variant.imageUrl, AIRCRAFT_STUDIO_IMAGES[variant.aircraftId]);
    assert.ok(variant.imageUrl.startsWith('/src/assets/images/aircraft_'));
  }
});

test('mercatorTileYToLatDeg and latDegToEquirectangularY accurately reproject satellite tiles onto the 3D sphere', () => {
  const latNorth = mercatorTileYToLatDeg(0, 2);
  const latEq = mercatorTileYToLatDeg(2, 2);
  const latSouth = mercatorTileYToLatDeg(4, 2);

  assert.ok(Math.abs(latNorth - 85.0511) < 0.01);
  assert.ok(Math.abs(latEq) < 1e-9);
  assert.ok(Math.abs(latSouth + 85.0511) < 0.01);

  assert.equal(latDegToEquirectangularY(90, 1024), 0);
  assert.equal(latDegToEquirectangularY(0, 1024), 512);
  assert.equal(latDegToEquirectangularY(-90, 1024), 1024);
});

test('computeGlobeEulerForLatLon with XYZ order centers any global airport at [0, 0, +1] with North upright', () => {
  const sampleIcaos = ['WIII', 'WADD', 'WAHI', 'WAJJ', 'EGLL', 'KJFK', 'KSFO', 'YSSY', 'RJTT'];
  for (const icao of sampleIcaos) {
    const airport = AIRPORT_BY_ID.get(icao)!;
    assert.ok(airport, `Airport ${icao} must exist`);
    const [ux, uy, uz] = latLonToUnitSphere(airport.lat, airport.lon);
    const latRad = airport.lat * (Math.PI / 180);
    const lonRad = airport.lon * (Math.PI / 180);
    const { rx, ry, order } = computeGlobeEulerForLatLon(latRad, lonRad);
    assert.equal(order, 'XYZ');

    const euler = new THREE.Euler(rx, ry, 0, order);
    const vec = new THREE.Vector3(ux, uy, uz).applyEuler(euler);
    assert.ok(Math.abs(vec.x) < 1e-6, `${icao} x=${vec.x} should be 0`);
    assert.ok(Math.abs(vec.y) < 1e-6, `${icao} y=${vec.y} should be 0`);
    assert.ok(Math.abs(vec.z - 1) < 1e-6, `${icao} z=${vec.z} should be +1`);

    // Check local North tangent vector [-sin(lat)cos(lon), cos(lat), sin(lat)sin(lon)] points to [0, +1, 0]
    const north = new THREE.Vector3(
      -Math.sin(latRad) * Math.cos(lonRad),
      Math.cos(latRad),
      Math.sin(latRad) * Math.sin(lonRad)
    ).applyEuler(euler);
    assert.ok(Math.abs(north.x) < 1e-6);
    assert.ok(Math.abs(north.y - 1) < 1e-6);
    assert.ok(Math.abs(north.z) < 1e-6);
  }
});

test('computeMenuContinentalTarget starts over Indonesia and spins continuously around the globe', () => {
  const start = computeMenuContinentalTarget(0);
  assert.ok(start.lonDeg >= 100 && start.lonDeg <= 130, `Initial menu lon ${start.lonDeg} should face Indonesia`);
  assert.ok(start.latDeg >= -10 && start.latDeg <= 5, `Initial menu lat ${start.latDeg} should face Indonesia`);

  const seenQuadrants = new Set<number>();
  for (let t = 0; t <= 200; t += 5) {
    const { latDeg, lonDeg } = computeMenuContinentalTarget(t);
    assert.ok(lonDeg >= -180 && lonDeg <= 180, `Menu lon ${lonDeg} should wrap cleanly in [-180, 180]`);
    assert.ok(latDeg >= -20 && latDeg <= 15, `Menu lat ${latDeg} should stay near the equatorial belt`);
    seenQuadrants.add(Math.floor((lonDeg + 180) / 90));
  }
  assert.ok(seenQuadrants.size >= 4, 'Menu rotation should sweep across all four longitude quadrants');
});

test('latLonToMercatorTile and computeRouteFocusView compute valid tile indices and route framing', () => {
  const wiii = AIRPORT_BY_ID.get('WIII')!;
  const wadd = AIRPORT_BY_ID.get('WADD')!;
  const tile = latLonToMercatorTile(wiii.lat, wiii.lon, 6);
  assert.equal(tile.n, 64);
  assert.ok(tile.tx >= 48 && tile.tx <= 54);
  assert.ok(tile.ty >= 32 && tile.ty <= 36);

  const focus = computeRouteFocusView(wiii, wadd);
  assert.ok(focus.lat > -9 && focus.lat < -6);
  assert.ok(focus.lon > 106 && focus.lon < 116);
  assert.ok(focus.zoom >= 3 && focus.zoom <= 10);
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

test('resolveRunwayAnchor auto-selects appropriate runway and snaps to threshold', async () => {
  const { resolveRunwayAnchor } = await import('../src/ui/PreGameVisuals');
  const wiii = AIRPORT_BY_ID.get('WIII')!;
  const warr = AIRPORT_BY_ID.get('WARR')!;
  // Auto departure towards East (WARR is east of WIII, course ~105 deg)
  const depAuto = resolveRunwayAnchor(wiii, '', 'dep', warr);
  assert.ok(depAuto);
  assert.ok(depAuto.ident.startsWith('07'), `Expected 07 end towards East, got ${depAuto.ident}`);
  assert.ok(depAuto.lat !== wiii.lat || depAuto.lon !== wiii.lon);

  // Explicit runway selection
  const dep25R = resolveRunwayAnchor(wiii, '25R', 'dep', warr);
  assert.ok(dep25R);
  assert.equal(dep25R.ident, '25R');
});


