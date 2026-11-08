// Geodesy + Web-Mercator helpers. A single Projection object maps lat/lon <-> world metres,
// and EVERYTHING (terrain tiles, runways, map markers, aircraft) goes through it so they stay aligned.
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
export const R_MERC = 6378137; // WebMercator sphere radius
export const R_EARTH = 6371008.8; // mean radius for great-circle maths
export const M_PER_NM = 1852;
export const M_PER_FT = 0.3048;
export const MS_TO_KT = 1 / 0.514444;

export const mercX = (lon: number) => R_MERC * lon * D2R;
export const mercY = (lat: number) => R_MERC * Math.log(Math.tan(Math.PI / 4 + (Math.max(-85.05, Math.min(85.05, lat)) * D2R) / 2));
export const invMercX = (x: number) => (x / R_MERC) * R2D;
export const invMercY = (y: number) => (2 * Math.atan(Math.exp(y / R_MERC)) - Math.PI / 2) * R2D;

/** World frame: +X east, +Y up (MSL metres), -Z north. Scale k=cos(lat0) makes world units ~true metres near origin. */
export class Projection {
  k: number; ox: number; oy: number;
  constructor(public lat0: number, public lon0: number) {
    this.k = Math.cos(lat0 * D2R);
    this.ox = mercX(lon0);
    this.oy = mercY(lat0);
  }
  x(lon: number) { return (mercX(lon) - this.ox) * this.k; }
  z(lat: number) { return -(mercY(lat) - this.oy) * this.k; }
  lon(x: number) { return invMercX(x / this.k + this.ox); }
  lat(z: number) { return invMercY(-z / this.k + this.oy); }
}

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dp = p2 - p1, dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function bearing(lat1: number, lon1: number, lat2: number, lon2: number) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}
/** Points along the great circle (for drawing routes on the map). */
export function greatCircle(lat1: number, lon1: number, lat2: number, lon2: number, n = 64): [number, number][] {
  const p1 = lat1 * D2R, l1 = lon1 * D2R, p2 = lat2 * D2R, l2 = lon2 * D2R;
  const d = haversine(lat1, lon1, lat2, lon2) / R_EARTH;
  const out: [number, number][] = [];
  if (d < 1e-9) return [[lat1, lon1], [lat2, lon2]];
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    out.push([Math.atan2(z, Math.hypot(x, y)) * R2D, Math.atan2(y, x) * R2D]);
  }
  return out;
}
/** Point a fraction f (0..1) of the way along the great circle from point 1 to point 2. */
/** Point at fraction `f` along the great circle. Per-frame callers pass `out` to avoid allocating the result tuple. */
export function gcPoint(lat1: number, lon1: number, lat2: number, lon2: number, f: number, out: [number, number] = [0, 0]): [number, number] {
  const d = haversine(lat1, lon1, lat2, lon2) / R_EARTH;
  if (d < 1e-9) { out[0] = lat1; out[1] = lon1; return out; }
  const p1 = lat1 * D2R, l1 = lon1 * D2R, p2 = lat2 * D2R, l2 = lon2 * D2R;
  const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
  const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
  const z = A * Math.sin(p1) + B * Math.sin(p2);
  out[0] = Math.atan2(z, Math.hypot(x, y)) * R2D; out[1] = Math.atan2(y, x) * R2D;
  return out;
}
/** Destination point; per-frame callers pass `out` to avoid allocating the result tuple. */
export function destination(lat: number, lon: number, hdg: number, dist: number, out: [number, number] = [0, 0]): [number, number] {
  const p1 = lat * D2R, l1 = lon * D2R, th = hdg * D2R, dl = dist / R_EARTH;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(dl) + Math.cos(p1) * Math.sin(dl) * Math.cos(th));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(dl) * Math.cos(p1), Math.cos(dl) - Math.sin(p1) * Math.sin(p2));
  out[0] = p2 * R2D; out[1] = ((l2 * R2D + 540) % 360) - 180;
  return out;
}

/**
 * Spherical cross-track distance from a great-circle path (lat1,lon1 -> lat2,lon2) to a point (lat,lon).
 * Positive = right of course, Negative = left of course. Returns [crossTrackMeters, alongTrackMeters].
 */
export function crossTrack(lat: number, lon: number, lat1: number, lon1: number, lat2: number, lon2: number, out: [number, number] = [0, 0]): [number, number] {
  if (!isFinite(lat) || !isFinite(lon) || !isFinite(lat1) || !isFinite(lon1) || !isFinite(lat2) || !isFinite(lon2)) {
    out[0] = 0; out[1] = 0; return out;
  }
  const d = haversine(lat1, lon1, lat2, lon2);
  if (d < 10) { out[0] = 0; out[1] = 0; return out; }
  const d13 = haversine(lat1, lon1, lat, lon) / R_EARTH;
  const th13 = bearing(lat1, lon1, lat, lon) * D2R;
  const th12 = bearing(lat1, lon1, lat2, lon2) * D2R;
  const sinXt = clamp(Math.sin(d13) * Math.sin(th13 - th12), -1, 1);
  const xtAng = Math.asin(sinXt);
  const xtM = xtAng * R_EARTH;
  const cosXt = Math.cos(xtAng);
  const atAng = Math.abs(cosXt) > 1e-6 ? Math.acos(clamp(Math.cos(d13) / cosXt, -1, 1)) : 0;
  const isForward = Math.cos(th13 - th12) >= 0;
  out[0] = isFinite(xtM) ? xtM : 0; out[1] = isFinite(atAng) ? (isForward ? atAng * R_EARTH : -atAng * R_EARTH) : 0;
  return out;
}

export interface FlightWaypoint {
  id: string;
  name: string;
  type: 'takeoff' | 'climb' | 'cruise' | 'tod' | 'iaf' | 'faf' | 'touchdown' | 'rollout';
  lat: number;
  lon: number;
  altM: number;
  speedKt: number;
  rwyIdent?: string;
  hdg?: number;
}

export const wrap360 = (a: number) => ((a % 360) + 360) % 360;
export const wrap180 = (a: number) => ((a + 540) % 360) - 180;
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---- slippy-map tile maths ----
export const tileSizeMerc = (z: number) => (2 * Math.PI * R_MERC) / 2 ** z;
export const lonToTileXf = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
export const latToTileYf = (lat: number, z: number) => {
  const s = Math.sin(clamp(lat, -85.05, 85.05) * D2R);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
};
export const tileXToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
export const tileYToLat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return R2D * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};
