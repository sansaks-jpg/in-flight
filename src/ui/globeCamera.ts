// Google-Earth-style camera helpers for the planner globe: eased "fly-to" animations with a pull-back arc,
// drag inertia and normalised wheel input. All angles in radians, zoom is a multiplicative factor (>= 1).
const TWO_PI = Math.PI * 2;

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
export const smooth01 = (t: number) => t * t * (3 - 2 * t);

export function wrapPi(a: number) { return ((((a + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI; }

/** Great-circle angular distance (rad) between two lat/lon points. */
export function angularDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const s = Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return Math.acos(Math.max(-1, Math.min(1, s)));
}

/** Spherical interpolation along the great circle (t in 0..1). Writes lat/lon (rad) into `out`. */
export function slerpLatLon(lat1: number, lon1: number, lat2: number, lon2: number, t: number, out: { lat: number; lon: number }) {
  const d = angularDistance(lat1, lon1, lat2, lon2);
  if (d < 1e-7) { out.lat = lat2; out.lon = lon1 + wrapPi(lon2 - lon1) * t; return; }
  const a = Math.sin((1 - t) * d) / Math.sin(d), b = Math.sin(t * d) / Math.sin(d);
  const x = a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2);
  const y = a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2);
  const z = a * Math.sin(lat1) + b * Math.sin(lat2);
  out.lat = Math.atan2(z, Math.hypot(x, y));
  // Keep longitude continuous with the start so the camera never "unwinds" the globe.
  out.lon = lon1 + wrapPi(Math.atan2(y, x) - lon1);
}

/**
 * Timed camera flight. Position follows the great circle with ease-in-out; zoom eases separately and, for long hops,
 * pulls back over the middle of the trip (like Google Earth) so you see where you are going before diving in.
 */
export class GlobeFlight {
  active = false;
  private t0 = 0; private dur = 1;
  private lat0 = 0; private lon0 = 0; private lat1 = 0; private lon1 = 0; private lz0 = 0; private lz1 = 0; private arc = 0;
  private tmp = { lat: 0, lon: 0 };
  /** Wall-clock end (ms), handy for hosts that want to know when it will finish. */
  endsAt = 0;

  start(now: number, from: { lat: number; lon: number; zoom: number }, to: { lat: number; lon: number; zoom: number }) {
    this.lat0 = from.lat; this.lon0 = from.lon; this.lat1 = to.lat; this.lon1 = from.lon + wrapPi(to.lon - from.lon);
    this.lz0 = Math.log(Math.max(1, from.zoom)); this.lz1 = Math.log(Math.max(1, to.zoom));
    const dist = angularDistance(this.lat0, this.lon0, this.lat1, this.lon1);
    const dz = Math.abs(this.lz1 - this.lz0);
    // Duration grows with distance and zoom change, but stays within a comfortable 1.2 – 3.8 s.
    this.dur = Math.min(3.8, Math.max(1.2, 0.85 + dist * 1.9 + dz * 0.13));
    // Pull-back depth: how far (in ln zoom) the camera rises above the higher of the two end altitudes.
    const hi = Math.max(this.lz0, this.lz1);
    this.arc = Math.min(hi, dist * 2.4);
    this.t0 = now; this.endsAt = now + this.dur * 1000; this.active = true;
  }
  cancel() { this.active = false; }

  /** Writes the camera state for `now`. Returns false once the flight has finished (final state is written). */
  sample(now: number, out: { lat: number; lon: number; zoom: number }): boolean {
    if (!this.active) return false;
    const t = Math.min(1, Math.max(0, (now - this.t0) / (this.dur * 1000)));
    const pe = easeInOutCubic(t);
    slerpLatLon(this.lat0, this.lon0, this.lat1, this.lon1, pe, this.tmp);
    out.lat = this.tmp.lat; out.lon = this.tmp.lon;
    const base = this.lz0 + (this.lz1 - this.lz0) * easeInOutSine(t);
    out.zoom = Math.exp(Math.max(0, base - this.arc * Math.sin(Math.PI * smooth01(t))));
    if (t >= 1) { this.active = false; out.lat = this.lat1; out.lon = this.lon1; out.zoom = Math.exp(this.lz1); return false; }
    return true;
  }
}

/** Normalises a WheelEvent to "pixels", so mice, trackpads and browsers with line/page deltas feel the same. */
export function normalizedWheelDelta(e: { deltaY: number; deltaMode: number; ctrlKey?: boolean }) {
  const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 400 : 1;
  return Math.max(-260, Math.min(260, e.deltaY * unit));
}
/** ln-zoom change for a wheel / pinch gesture: ~1.2x per mouse notch, finer for trackpads, 3x faster for pinch. */
export function wheelToLogZoom(e: { deltaY: number; deltaMode: number; ctrlKey?: boolean }) {
  return -normalizedWheelDelta(e) * (e.ctrlKey ? 0.0075 : 0.0018);
}

/** Exponential decay of a velocity (per-second friction), stopping cleanly below a threshold. */
export function decayVelocity(v: number, dt: number, friction = 3.4) {
  const r = v * Math.exp(-friction * dt);
  return Math.abs(r) < 1e-6 ? 0 : r;
}
