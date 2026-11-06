// Airport ground planning shared by the 3D scenery, the spawn logic, the tree/building scatterer and the mini map.
//
// Real-world rules used here (verified against ICAO Annex 14 Vol. I, Table 3-1 and 3.12.6):
//   * runway centre line -> parallel taxiway centre line : code 3 / 4 instrument  168 m (code C, 176 m code D),
//                                                           code 1-2 instrument 77.5-87 m, non-instrument 30-93 m
//   * aircraft stand clearance to any building / other aircraft (code C) : 4.5 m
//   * runway-holding position distance from the runway centre line      : 75-90 m (code 3-4), 40-60 m (code 1-2)
// Aircraft start OUTSIDE a hangar, in front of its doors (as if the tug had just pulled it out), on the apron side that
// faces the taxiway – never inside a building, on a runway, or in a wood.
import { Airport, getAirfield, AirfieldLayout } from '../data/airports';
import type { AircraftSpec } from './specs';
import { D2R, R2D } from './geo';

export interface Rect { cx: number; cz: number; hl: number; hw: number; hdg: number }
export type XZ = [number, number];
interface Proj { x(lon: number): number; z(lat: number): number }
export const ICAO_STAND_CLEARANCE = 4.5;

const fwd = (hdg: number): XZ => [Math.sin(hdg * D2R), -Math.cos(hdg * D2R)];
const rgt = (hdg: number): XZ => [Math.cos(hdg * D2R), Math.sin(hdg * D2R)];
export const hdgOfVec = (dx: number, dz: number) => (Math.atan2(dx, -dz) * R2D + 360) % 360;

export function rectCorners(r: Rect): XZ[] {
  const [fx, fz] = fwd(r.hdg), [rx, rz] = rgt(r.hdg);
  return ([[1, 1], [1, -1], [-1, -1], [-1, 1]] as [number, number][]).map(([a, b]) => [r.cx + fx * r.hl * a + rx * r.hw * b, r.cz + fz * r.hl * a + rz * r.hw * b] as XZ);
}
export function inRect(r: Rect, x: number, z: number, margin = 0): boolean {
  const [fx, fz] = fwd(r.hdg), [rx, rz] = rgt(r.hdg), dx = x - r.cx, dz = z - r.cz;
  return Math.abs(dx * fx + dz * fz) <= r.hl + margin && Math.abs(dx * rx + dz * rz) <= r.hw + margin;
}
export function inPoly(ring: XZ[], x: number, z: number): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi || 1e-9) + xi) c = !c;
  }
  return c;
}
export function distToSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9; let t = ((px - ax) * dx + (pz - az) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}
function segsCross(a: XZ, b: XZ, c: XZ, d: XZ) {
  const o = (p: XZ, q: XZ, r: XZ) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
/** True when the oriented rectangle (grown by `margin`) overlaps / touches the polygon. */
export function rectHitsRing(r: Rect, ring: XZ[], margin = 0): boolean {
  const g: Rect = { ...r, hl: r.hl + margin, hw: r.hw + margin }, cs = rectCorners(g);
  for (const c of cs) if (inPoly(ring, c[0], c[1])) return true;
  for (const p of ring) if (inRect(g, p[0], p[1])) return true;
  for (let i = 0; i < 4; i++) for (let j = 0; j < ring.length; j++) if (segsCross(cs[i], cs[(i + 1) % 4], ring[j], ring[(j + 1) % ring.length])) return true;
  return false;
}

/** Fast spatial test used by the tree / house scatterer: segments (taxiways), rectangles (aprons, parked aircraft), polygons. */
export class GroundClear {
  segs: { ax: number; az: number; bx: number; bz: number; r2: number }[] = [];
  rects: Rect[] = [];
  polys: { ring: XZ[]; minX: number; maxX: number; minZ: number; maxZ: number; m: number }[] = [];
  clear() { this.segs.length = 0; this.rects.length = 0; this.polys.length = 0; }
  addSeg(a: XZ, b: XZ, r: number) { this.segs.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], r2: r * r }); }
  addRect(r: Rect) { this.rects.push(r); }
  addPoly(ring: XZ[], m = 12) {
    if (ring.length < 3) return;
    let minX = 1e18, maxX = -1e18, minZ = 1e18, maxZ = -1e18;
    for (const [x, z] of ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    this.polys.push({ ring, minX: minX - m, maxX: maxX + m, minZ: minZ - m, maxZ: maxZ + m, m });
  }
  contains(x: number, z: number): boolean {
    for (const s of this.segs) { const dx = s.bx - s.ax, dz = s.bz - s.az, L2 = dx * dx + dz * dz || 1e-9; let t = ((x - s.ax) * dx + (z - s.az) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t; const ex = x - s.ax - dx * t, ez = z - s.az - dz * t; if (ex * ex + ez * ez < s.r2) return true; }
    for (const r of this.rects) if (inRect(r, x, z)) return true;
    for (const p of this.polys) if (x >= p.minX && x <= p.maxX && z >= p.minZ && z <= p.maxZ && (inPoly(p.ring, x, z) || this.nearRing(p, x, z))) return true;
    return false;
  }
  private nearRing(p: { ring: XZ[]; m: number }, x: number, z: number) {
    for (let i = 0; i < p.ring.length; i++) { const a = p.ring[i], b = p.ring[(i + 1) % p.ring.length]; if (distToSeg(x, z, a[0], a[1], b[0], b[1]) < p.m) return true; }
    return false;
  }
  /** Any vertex of a building footprint (world x/z) inside the cleared area. */
  hitsFootprint(pts: XZ[]): boolean { for (const p of pts) if (this.contains(p[0], p[1])) return true; return false; }
}

// -----------------------------------------------------------------------------------------------------------
//  Synthetic ground (airports without an OSM survey): parallel taxiway, hangar apron, hangars, terminal side
// -----------------------------------------------------------------------------------------------------------
export interface SynthHangar { rect: Rect; kind: 'maintenance' | 'ga'; name: string; door: XZ }
export interface SynthGround {
  cx: number; cz: number; hdg: number; len: number; wid: number; side: 1 | -1;
  /** distance runway centre line -> parallel taxiway centre line (ICAO Annex 14 Table 3-1) */
  taxiLat: number; holdLat: number; taxiWidth: number;
  gaOnly: boolean;
  taxiway: { a: XZ; b: XZ };
  hangars: SynthHangar[];
  hangarApron: Rect;
  /** along-runway position (m from the runway centre) of the terminal block */
  termAlong: number;
}

export function taxiSeparation(len: number, wid: number) {
  // length-based proxy for the ICAO reference code: 4 -> 168/176 m, 3 -> 93-120 m, 2 -> 87 m, 1 -> 45 m
  return Math.max(wid / 2 + 40, len >= 1800 ? 168 : len >= 1200 ? 120 : len >= 800 ? 87 : 45);
}
export function holdDistance(len: number) { return len >= 1800 ? 90 : len >= 1200 ? 75 : len >= 800 ? 60 : 40; }

const synthCache = new Map<string, SynthGround | null>();
export function synthGround(ap: Airport, proj: Proj): SynthGround | null {
  const rw = ap.runways[0]; if (!rw) return null;
  const key = `${ap.id}:${proj.x(ap.lon).toFixed(1)}:${proj.z(ap.lat).toFixed(1)}`;
  if (synthCache.has(key)) return synthCache.get(key)!;
  if (synthCache.size > 40) synthCache.clear();
  const ax = proj.x(rw.leLon), az = proj.z(rw.leLat), bx = proj.x(rw.heLon), bz = proj.z(rw.heLat);
  const len = Math.hypot(bx - ax, bz - az), hdg = hdgOfVec(bx - ax, bz - az), cx = (ax + bx) / 2, cz = (az + bz) / 2;
  const [fx, fz] = fwd(hdg), [rx, rz] = rgt(hdg);
  const prefSide: 1 | -1 = ((proj.x(ap.lon) - cx) * rx + (proj.z(ap.lat) - cz) * rz) >= 0 ? 1 : -1;
  const taxiLat0 = taxiSeparation(len, rw.width), holdLat = holdDistance(len);
  const gaOnly = ap.size === 2 || len < 1500;
  const room = Math.max(60, len / 2 - 90);
  // every other runway of the field: nothing airside may sit on top of them
  const others = ap.runways.slice(1).map((r) => ({ ax: proj.x(r.leLon), az: proj.z(r.leLat), bx: proj.x(r.heLon), bz: proj.z(r.heLat), wid: r.width }));

  const build = (side: 1 | -1, sg: 1 | -1, k = 1, extraLat = 0): SynthGround => {
    const taxiLat = taxiLat0 + extraLat;
    const P = (along: number, lat: number): XZ => [cx + fx * along + rx * side * lat, cz + fz * along + rz * side * lat];
    // door normal: pointing from the hangar front towards the taxiway
    const doorDir: XZ = [-rx * side, -rz * side], doorHdg = hdgOfVec(doorDir[0], doorDir[1]);
    const mkHangar = (along: number, frontLat: number, w: number, d: number, kind: 'maintenance' | 'ga', name: string): SynthHangar => {
      const c = P(along, frontLat + d / 2);
      return { rect: { cx: c[0], cz: c[1], hl: d / 2, hw: w / 2, hdg: doorHdg }, kind, name, door: P(along, frontLat) };
    };
    const hangars: SynthHangar[] = [];
    const aM = -sg * Math.min(room * k, 290);
    if (!gaOnly) hangars.push(mkHangar(aM, taxiLat + 78, 70, 52, 'maintenance', 'Maintenance Hangar'));
    const aG = gaOnly ? -sg * Math.min(room * k, 70) : aM + sg * 100;
    for (let i = 0; i < 3; i++) hangars.push(mkHangar(aG + sg * i * 34, taxiLat + 42, 26, 20, 'ga', `GA Hangar ${i + 1}`));
    const apronAlong = gaOnly ? aG + sg * 34 : aM + sg * 50;
    const ac = P(apronAlong, taxiLat + 38);
    const hangarApron: Rect = { cx: ac[0], cz: ac[1], hl: gaOnly ? 30 : 41, hw: gaOnly ? 80 : 115, hdg: doorHdg };
    return {
      cx, cz, hdg, len, wid: rw.width, side, taxiLat, holdLat, taxiWidth: gaOnly ? 15 : 23, gaOnly,
      taxiway: { a: P(-len / 2 - 40, taxiLat), b: P(len / 2 + 40, taxiLat) },
      hangars, hangarApron, termAlong: gaOnly ? -sg * Math.min(room * k, 120) : 0,
    };
  };
  const valid = (g: SynthGround) => {
    if (!others.length) return true;
    const tc = synthPoint(g, g.termAlong, g.taxiLat + 70);
    const rects: Rect[] = [g.hangarApron, ...g.hangars.map((h) => h.rect), { cx: tc[0], cz: tc[1], hl: g.gaOnly ? 40 : 130, hw: g.gaOnly ? 50 : 90, hdg: g.hdg }];
    for (const o of others) for (const r of rects) for (const c of [...rectCorners(r), [r.cx, r.cz] as XZ]) if (distToSeg(c[0], c[1], o.ax, o.az, o.bx, o.bz) < o.wid / 2 + 60) return false;
    return true;
  };
  let g = build(prefSide, 1);
  search: for (const el of [0, 120, 300, 600]) for (const k of [1, 0.55, 0.25]) for (const [sd, sg] of [[prefSide, 1], [prefSide, -1], [-prefSide, 1], [-prefSide, -1]] as [1 | -1, 1 | -1][]) { const c = build(sd, sg, k, el); if (valid(c)) { g = c; break search; } }
  synthCache.set(key, g);
  return g;
}
export const synthPoint = (g: SynthGround, along: number, lat: number): XZ => {
  const [fx, fz] = fwd(g.hdg), [rx, rz] = rgt(g.hdg);
  return [g.cx + fx * along + rx * g.side * lat, g.cz + fz * along + rz * g.side * lat];
};

// -----------------------------------------------------------------------------------------------------------
//  Spawn: parked outside a hangar
// -----------------------------------------------------------------------------------------------------------
export interface GroundSpawn {
  x: number; z: number; hdg: number; label: string; kind: 'hangar' | 'gate' | 'stand' | 'apron';
  pushback: boolean; pushDir: number;
  path: XZ[] | null; synthetic: boolean;
  /** aircraft footprint (+ clearance) – scenery must stay clear of it */
  footprint: Rect;
  hangar?: string;
}

/** Aircraft footprint: fuselage length x wing span, with the ICAO stand clearance. */
export function footprintOf(spec: AircraftSpec, x: number, z: number, hdg: number, margin = ICAO_STAND_CLEARANCE): Rect {
  return { cx: x, cz: z, hl: spec.length / 2 + margin, hw: spec.wingspan / 2 + margin, hdg };
}

interface RwyLine { ax: number; az: number; bx: number; bz: number; wid: number }
interface Obstacles { rings: XZ[][]; runways: RwyLine[] }
function footprintFree(fp: Rect, ob: Obstacles): boolean {
  for (const r of ob.rings) if (rectHitsRing(fp, r)) return false;
  const cs = [...rectCorners(fp), [fp.cx, fp.cz] as XZ];
  for (const g of ob.runways) for (const c of cs) if (distToSeg(c[0], c[1], g.ax, g.az, g.bx, g.bz) < g.wid / 2 + 30) return false;
  return true;
}

function minAreaBox(pts: XZ[]) {
  let best = { cx: 0, cz: 0, ang: 0, w: 1, d: 1 }, ba = 1e18;
  for (let a = 0; a < 180; a += 3) {
    const c = Math.cos(a * D2R), s = Math.sin(a * D2R); let u0 = 1e18, u1 = -1e18, v0 = 1e18, v1 = -1e18;
    for (const [x, z] of pts) { const u = x * c + z * s, v = -x * s + z * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const area = (u1 - u0) * (v1 - v0);
    if (area < ba) { ba = area; const um = (u0 + u1) / 2, vm = (v0 + v1) / 2; best = { cx: um * c - vm * s, cz: um * s + vm * c, ang: a, w: u1 - u0, d: v1 - v0 }; }
  }
  return best;
}
export const ringArea = (r: XZ[]) => { let a = 0; for (let i = 0; i < r.length; i++) { const [x1, z1] = r[i], [x2, z2] = r[(i + 1) % r.length]; a += x1 * z2 - x2 * z1; } return Math.abs(a) / 2; };

/** Minimum hangar footprint (m²) for the type: a Skyhawk fits a T-hangar, an ATR / A320 needs a real maintenance hall. */
const minHangarArea = (spec: AircraftSpec) => spec.kind === 'jet' ? 1400 : spec.kind === 'turboprop' ? 700 : 80;

export function listHangarsXZ(ap: Airport, proj: Proj): { name: string; ring: XZ[]; idx: number }[] {
  const L = getAirfield(ap); if (!L) return [];
  return L.hangars.filter((h) => h.ring.length >= 3).slice(0, 10).map((h, idx) => ({ name: h.name, idx, ring: h.ring.map(([la, lo]) => [proj.x(lo), proj.z(la)] as XZ) }));
}

function obstaclesOf(L: AirfieldLayout | null, proj: Proj, rwys: RwyLine[]): Obstacles {
  const rings: XZ[][] = [];
  if (L) for (const b of [...L.hangars, ...L.terminals]) if (b.ring.length >= 3) rings.push(b.ring.map(([la, lo]) => [proj.x(lo), proj.z(la)] as XZ));
  return { rings, runways: rwys };
}

export interface SpawnReq {
  ap: Airport; spec: AircraftSpec; proj: Proj; runways: RwyLine[];
  thr: { startX: number; startZ: number; hdg: number; wid: number; fullLen: number }; spotId?: string;
}

/** Candidate positions in front of each face of a hangar, nose pointing away from the doors. */
function hangarFronts(ring: XZ[], spec: AircraftSpec, clear = 10) {
  const bx = minAreaBox(ring), a = bx.ang * D2R, ux = Math.cos(a), uz = Math.sin(a), vx = -Math.sin(a), vz = Math.cos(a);
  const out: { x: number; z: number; hdg: number }[] = [];
  for (const [nx, nz, half] of [[ux, uz, bx.w / 2], [-ux, -uz, bx.w / 2], [vx, vz, bx.d / 2], [-vx, -vz, bx.d / 2]] as [number, number, number][]) {
    const d = half + clear + spec.length / 2;
    out.push({ x: bx.cx + nx * d, z: bx.cz + nz * d, hdg: hdgOfVec(nx, nz) });
  }
  return out;
}

export function chooseGroundSpawn(q: SpawnReq): GroundSpawn {
  const { ap, spec, proj, runways, thr } = q, L = getAirfield(ap), ob = obstaclesOf(L, proj, runways);
  const apx = proj.x(ap.lon), apz = proj.z(ap.lat);
  const dist2thr = (x: number, z: number) => Math.hypot(x - thr.startX, z - thr.startZ);
  const mk = (x: number, z: number, hdg: number, kind: GroundSpawn['kind'], label: string, extra: Partial<GroundSpawn> = {}): GroundSpawn =>
    ({ x, z, hdg, kind, label, pushback: false, pushDir: hdg, path: null, synthetic: false, footprint: footprintOf(spec, x, z, hdg), ...extra });

  if (L && (L.hangars.length || L.stands.length || L.aprons.length || L.taxiways.length)) {
    const taxi = L.taxiways.filter((t) => t.pts.length > 1).map((t) => ({ w: Math.max(8, Math.min(30, t.width)), pts: t.pts.map(([la, lo]) => [proj.x(lo), proj.z(la)] as XZ) }));
    const apronRings = L.aprons.filter((a) => a.ring.length >= 3).map((a) => a.ring.map(([la, lo]) => [proj.x(lo), proj.z(la)] as XZ));
    const nearestTaxi = (x: number, z: number) => {
      let b = 1e9;
      for (const t of taxi) for (let i = 0; i + 1 < t.pts.length; i++) b = Math.min(b, distToSeg(x, z, t.pts[i][0], t.pts[i][1], t.pts[i + 1][0], t.pts[i + 1][1]));
      for (const r of apronRings) if (inPoly(r, x, z)) b = 0;
      return b;
    };
    const taxiClearOK = (fp: Rect) => { // no part of the aircraft overhangs a taxiway surface
      for (const c of rectCorners(fp)) for (const t of taxi) for (let i = 0; i + 1 < t.pts.length; i++) if (distToSeg(c[0], c[1], t.pts[i][0], t.pts[i][1], t.pts[i + 1][0], t.pts[i + 1][1]) < t.w / 2) return false;
      return true;
    };
    const hangars = listHangarsXZ(ap, proj);
    const tryHangar = (h: { name: string; ring: XZ[] }, idx: number) => {
      let best: GroundSpawn | null = null, bs = 1e18;
      for (const f of hangarFronts(h.ring, spec)) {
        const fp = footprintOf(spec, f.x, f.z, f.hdg);
        if (!footprintFree(fp, ob) || !taxiClearOK(fp)) continue;
        const dt = nearestTaxi(f.x, f.z); if (dt > 700 || Math.hypot(f.x - apx, f.z - apz) > 3500) continue;
        const sc = dt + dist2thr(f.x, f.z) * 0.05;
        if (sc < bs) { bs = sc; best = mk(f.x, f.z, f.hdg, 'hangar', h.name ? `Hangar · ${h.name}` : `Hangar ${idx + 1}`, { hangar: h.name || `Hangar ${idx + 1}` }); }
      }
      return best ? { sp: best, score: bs } : null;
    };
    if (q.spotId?.startsWith('hangar:')) {
      const i = Number(q.spotId.slice(7)); if (hangars[i]) { const r = tryHangar(hangars[i], i); if (r) return r.sp; }
    } else if (!q.spotId) {
      const need = minHangarArea(spec); let best: GroundSpawn | null = null, bs = 1e18;
      hangars.forEach((h, i) => {
        const area = ringArea(h.ring); if (area < need) return;
        const r = tryHangar(h, i); if (!r) return;
        // prefer the smallest hangar that fits (a Skyhawk belongs in a T-hangar, an A320 in a maintenance hall)
        const sc = r.score + Math.min(area, 30000) * (spec.kind === 'piston' ? 0.15 : 0.02);
        if (sc < bs) { bs = sc; best = r.sp; }
      });
      if (best) return best;
    }
    // explicit stand / gate / apron choice, or no suitable hangar: the surveyed spot, pulled back so nothing overlaps
    const stds = L.stands.map((s) => ({ ...s, kind: (s.gate ? 'gate' : 'stand') as 'gate' | 'stand' }));
    const pick = q.spotId && !q.spotId.startsWith('hangar:') ? q.spotId : '';
    const cands: { x: number; z: number; kind: 'gate' | 'stand' | 'apron'; label: string; exit: number }[] = [];
    const exitHdg = (x: number, z: number) => {
      let b = 1e9, bq: XZ | null = null;
      for (const t of taxi) for (let i = 0; i + 1 < t.pts.length; i++) {
        const [ax, az] = t.pts[i], [bx, bz] = t.pts[i + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
        const tt = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), d = Math.hypot(x - ax - dx * tt, z - az - dz * tt);
        if (d < b) { b = d; bq = [ax + dx * tt, az + dz * tt]; }
      }
      return bq ? hdgOfVec(bq[0] - x, bq[1] - z) : thr.hdg;
    };
    if (pick.startsWith('gate:') || pick.startsWith('stand:')) {
      const m = /:(\d+)$/.exec(pick), i = m ? Number(m[1]) : -1;
      const s = pick.startsWith('gate:') ? stds.filter((x) => x.kind === 'gate')[i] : stds.filter((x) => x.kind === 'stand')[i];
      if (s) { const x = proj.x(s.lon), z = proj.z(s.lat); cands.push({ x, z, kind: s.kind, label: `${s.kind === 'gate' ? 'Gate' : 'Stand'} ${s.ref || i + 1}`, exit: exitHdg(x, z) }); }
    } else {
      apronRings.map((r) => ({ r, a: ringArea(r) })).sort((p, o) => o.a - p.a).slice(0, 6).forEach(({ r }, i) => {
        const cx = r.reduce((s, p) => s + p[0], 0) / r.length, cz = r.reduce((s, p) => s + p[1], 0) / r.length;
        cands.push({ x: cx, z: cz, kind: 'apron', label: `Apron ${i + 1}`, exit: exitHdg(cx, cz) });
      });
      for (const s of stds.slice(0, 40)) { const x = proj.x(s.lon), z = proj.z(s.lat); cands.push({ x, z, kind: s.kind, label: `${s.kind === 'gate' ? 'Gate' : 'Stand'} ${s.ref || ''}`.trim(), exit: exitHdg(x, z) }); }
    }
    let best: GroundSpawn | null = null, bs = 1e18;
    for (const c of cands) {
      // The parking-position mark is where the NOSE WHEEL stops: the CG sits behind it, so the aircraft body never enters the terminal.
      const nosein = spec.kind !== 'piston' && (c.kind === 'gate' || c.kind === 'stand');
      const hdg = nosein ? (c.exit + 180) % 360 : c.exit, [hx, hz] = fwd(hdg), back = spec.length * 0.42 + 2;
      for (const extra of [0, 6, 14, 24, 36]) {
        const sgn = nosein ? -1 : 1, d = nosein ? back + extra : extra;
        const x = c.x + sgn * hx * d, z = c.z + sgn * hz * d, fp = footprintOf(spec, x, z, hdg);
        if (!footprintFree(fp, ob)) continue;
        const sc = (c.kind === 'apron' ? 0 : 1) * 500 + dist2thr(x, z) * 0.1 + extra;
        if (sc < bs) { bs = sc; best = mk(x, z, hdg, c.kind, c.label, { pushback: nosein, pushDir: c.exit }); }
        break;
      }
    }
    if (best) return best;
  }
  return syntheticHangarSpawn(q);
}

function syntheticHangarSpawn(q: SpawnReq): GroundSpawn {
  const { ap, spec, proj, thr } = q, g = synthGround(ap, proj)!;
  const hz = g.hangars.find((h) => (spec.kind === 'piston' ? h.kind === 'ga' : h.kind === 'maintenance')) ?? g.hangars[0];
  const [dx, dz] = hz.door, rr = rgt(g.hdg), nx = -g.side * rr[0], nz = -g.side * rr[1];
  const off = 10 + spec.length / 2;
  const x = dx + nx * off, z = dz + nz * off, hdg = hdgOfVec(nx, nz);
  // taxi: off the hangar apron onto the parallel taxiway, along it to the runway end, hold short, line up
  const f = fwd(g.hdg), along = (x - g.cx) * f[0] + (z - g.cz) * f[1];
  const T0 = synthPoint(g, along, g.taxiLat);
  const thAlong = (thr.startX - g.cx) * f[0] + (thr.startZ - g.cz) * f[1];
  const T1 = synthPoint(g, thAlong + (thAlong > along ? -25 : 25), g.taxiLat), H1 = synthPoint(g, thAlong, g.holdLat + 3);
  const diff = Math.abs(((thr.hdg - g.hdg + 540) % 360) - 180), sameRwy = diff < 5 || diff > 175;
  const path: XZ[] = sameRwy ? [[x, z], T0, T1, H1, [thr.startX, thr.startZ]] : [[x, z], T0, [thr.startX, thr.startZ]];
  return { x, z, hdg, kind: 'hangar', label: `${hz.name} apron · ${ap.icao}`, pushback: false, pushDir: hdg, path, synthetic: true, footprint: footprintOf(spec, x, z, hdg), hangar: hz.name };
}

/** Ground zones that must stay free of woodland and houses: taxiways, aprons, hangar aprons, surveyed apron polygons. */
export function airportClearZones(ap: Airport, proj: Proj, out: GroundClear) {
  const L = getAirfield(ap), P = (ring: [number, number][]) => ring.map(([la, lo]) => [proj.x(lo), proj.z(la)] as XZ);
  if (L) {
    for (const t of L.taxiways) { const p = P(t.pts); for (let i = 0; i + 1 < p.length; i++) out.addSeg(p[i], p[i + 1], Math.max(8, Math.min(30, t.width)) / 2 + 14); }
    for (const a of L.aprons) out.addPoly(P(a.ring), 18);
    for (const a of L.terminals) out.addPoly(P(a.ring), 30);
    for (const a of L.hangars) out.addPoly(P(a.ring), 20);
    for (const s of L.stands) out.addRect({ cx: proj.x(s.lon), cz: proj.z(s.lat), hl: 25, hw: 25, hdg: 0 });
    for (const h of L.holds) out.addRect({ cx: proj.x(h.lon), cz: proj.z(h.lat), hl: 12, hw: 12, hdg: 0 });
  } else {
    const g = synthGround(ap, proj); if (!g) return;
    out.addSeg(g.taxiway.a, g.taxiway.b, g.taxiWidth / 2 + 16);
    out.addRect({ ...g.hangarApron, hl: g.hangarApron.hl + 14, hw: g.hangarApron.hw + 14 });
    for (const h of g.hangars) out.addRect({ ...h.rect, hl: h.rect.hl + 14, hw: h.rect.hw + 14 });
    const c = synthPoint(g, g.termAlong, g.taxiLat + 70); out.addRect({ cx: c[0], cz: c[1], hl: g.gaOnly ? 40 : 130, hw: g.gaOnly ? 50 : 90, hdg: g.hdg });
  }
}
