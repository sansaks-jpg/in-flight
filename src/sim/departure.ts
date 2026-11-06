// Where the aircraft starts: on a real stand / gate / apron – never on the runway.
//   * surveyed airfields (OSM layout): the best-ranked stand for the aircraft type that is NOT inside any runway corridor;
//   * everywhere else: a stand synthesised on the airport-reference-point side of the runway, with ICAO-typical runway-to-taxiway
//     separation (code 4: 168 m, code 3: ~120 m, code 1-2: ~75 m), a parallel taxiway, a hold-short point and the line-up.
import { Airport } from '../data/airports';
import { startSpots, findStartSpot } from './airfield';
import { AircraftSpec } from './specs';
import type { Threshold, RunwayGeom } from './world';
import { D2R, R2D } from './geo';

export interface Spawn {
  x: number; z: number; hdg: number; label: string; kind: string;
  /** Nose-in stand: the tug must push the aircraft back before it can taxi. */
  pushback: boolean; pushDir: number;
  /** Synthetic taxi path (world x/z) when the airfield has no surveyed taxiway graph. */
  path: [number, number][] | null;
  synthetic: boolean;
}
interface Proj { x(lon: number): number; z(lat: number): number }

function distToSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1; let t = ((px - ax) * dx + (pz - az) * dz) / L2; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}
const hdgOf = (dx: number, dz: number) => (Math.atan2(dx, -dz) * R2D + 360) % 360;

export function chooseSpawn(ap: Airport, th: Threshold, spec: AircraftSpec, proj: Proj, runways: RunwayGeom[], spotId?: string): Spawn {
  const inRunway = (x: number, z: number) => runways.some((g) => distToSeg(x, z, g.ax, g.az, g.bx, g.bz) < g.wid / 2 + 55);
  const big = spec.kind !== 'piston';
  const mk = (s: { lat: number; lon: number; hdg: number; kind: string; label: string }): Spawn => {
    const nosein = big && (s.kind === 'gate' || s.kind === 'stand');
    return { x: proj.x(s.lon), z: proj.z(s.lat), hdg: nosein ? (s.hdg + 180) % 360 : s.hdg, label: s.label, kind: s.kind, pushback: nosein, pushDir: s.hdg, path: null, synthetic: false };
  };
  if (spotId) { const s = findStartSpot(ap, spotId); if (s) return mk(s); }
  const spots = startSpots(ap).map((s) => ({ s, x: proj.x(s.lon), z: proj.z(s.lat) })).filter((c) => !inRunway(c.x, c.z));
  if (spots.length) {
    const rank: Record<string, number> = spec.kind === 'jet' ? { gate: 0, stand: 1, apron: 2, hangar: 6 } : spec.kind === 'turboprop' ? { stand: 0, gate: 1, apron: 2, hangar: 6 } : { apron: 0, stand: 1, hangar: 2, gate: 5 };
    let best = spots[0], bs = 1e18;
    for (const c of spots) { const sc = (rank[c.s.kind] ?? 9) * 1e6 + Math.hypot(c.x - th.startX, c.z - th.startZ); if (sc < bs) { bs = sc; best = c; } }
    return mk(best.s);
  }
  // ---- synthetic apron + parallel taxiway ----
  const h = th.hdg * D2R, fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
  const sx = th.startX, sz = th.startZ, L = Math.max(500, th.fullLen);
  const side = Math.sign((proj.x(ap.lon) - sx) * rx + (proj.z(ap.lat) - sz) * rz) || 1;
  const taxiLat = Math.max(th.wid / 2 + 45, spec.kind === 'jet' ? 168 : spec.kind === 'turboprop' ? 120 : 75);
  const standLat = taxiLat + (spec.kind === 'jet' ? 75 : spec.kind === 'turboprop' ? 60 : 32);
  const along = Math.min(Math.max(L * 0.4, 250), Math.max(250, L - 250));
  const pt = (a: number, lat: number): [number, number] => [sx + fx * a + rx * side * lat, sz + fz * a + rz * side * lat];
  const S = pt(along, standLat), P1 = pt(along, taxiLat), P2 = pt(-5, taxiLat), P3 = pt(0, th.wid / 2 + 62), P4: [number, number] = [sx, sz];
  const toTaxi = hdgOf(P1[0] - S[0], P1[1] - S[1]);
  return { x: S[0], z: S[1], hdg: toTaxi, label: `${spec.kind === 'piston' ? 'General aviation apron' : 'Apron stand'} · ${ap.icao}`, kind: 'apron', pushback: false, pushDir: toTaxi, path: [S, P1, P2, P3, P4], synthetic: true };
}
