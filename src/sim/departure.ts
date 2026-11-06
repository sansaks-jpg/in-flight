// Where the aircraft starts: parked outside a designated hangar (doors behind the aircraft, nose towards the taxiway),
// never inside a building, on a runway, at a passenger boarding bridge with the fuselage in the terminal wall, or in a forest.
// The geometry lives in airportGround.ts (ICAO Annex 14 clearances); this file adapts it to the sim's Spawn type.
import { Airport } from '../data/airports';
import { AircraftSpec } from './specs';
import type { Threshold, RunwayGeom } from './world';
import { chooseGroundSpawn, GroundSpawn } from './airportGround';

export interface Spawn extends GroundSpawn {}
interface Proj { x(lon: number): number; z(lat: number): number }

export function chooseSpawn(ap: Airport, th: Threshold, spec: AircraftSpec, proj: Proj, runways: RunwayGeom[], spotId?: string): Spawn {
  return chooseGroundSpawn({
    ap, spec, proj, spotId,
    runways: runways.filter((g) => g.ap.id === ap.id).map((g) => ({ ax: g.ax, az: g.az, bx: g.bx, bz: g.bz, wid: g.wid })),
    thr: { startX: th.startX, startZ: th.startZ, hdg: th.hdg, wid: th.wid, fullLen: th.fullLen },
  });
}
