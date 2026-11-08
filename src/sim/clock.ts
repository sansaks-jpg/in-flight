/**
 * Real-world simulation clock.
 *
 * The simulator runs 1:1 with the real world: there is exactly ONE time source — the system clock
 * (`Date.now()`, i.e. UTC "Zulu" time) — and everything time-dependent (sun position, sky colour,
 * night lighting, HUD clock, ETA wall-clock times, magnetic model epoch) derives from it.
 * The in-game time can therefore never drift from the real time, regardless of pausing, frame
 * rate, or how long the flight has been running.
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Current real-world instant in epoch milliseconds (UTC). Single source of truth for sim time. */
let timeOffsetMs = 0;
export const simNowMs = (): number => Date.now() + timeOffsetMs;

/**
 * Optional "what would the sky look like at…" shift applied to the ONE clock (MSFS-style time-of-day override).
 * 0 (the default) is the true real-world UTC time; every consumer still reads `simNowMs()`, so nothing can drift apart.
 */
export function setSimTimeOffsetMs(ms: number) { timeOffsetMs = Number.isFinite(ms) ? ms : 0; }
export const getSimTimeOffsetMs = () => timeOffsetMs;
/** Shift the clock so that LOCAL MEAN SOLAR time at `lonDeg` reads `hour` (0..24) today; `null` returns to real time. */
export function setLocalSolarHour(hour: number | null, lonDeg: number) {
  if (hour === null) { timeOffsetMs = 0; return; }
  const now = Date.now(), utcH = (((now / 3600000) % 24) + 24) % 24, localH = (utcH + lonDeg / 15 + 24) % 24;
  let d = hour - localH; if (d > 12) d -= 24; if (d < -12) d += 24;
  timeOffsetMs = d * 3600000;
}

export interface SunPosition {
  /** Degrees above the (geometric) horizon, negative below. Includes standard atmospheric refraction. */
  elevation: number;
  /** Degrees clockwise from true north. */
  azimuth: number;
  /** Solar declination, degrees. */
  declination: number;
}

/**
 * Solar position for an instant and a location (NOAA Solar Calculator algorithm, J. Meeus
 * "Astronomical Algorithms"; accurate to well under 0.1° for the modern era).
 */
export function sunPosition(ms: number, latDeg: number, lonDeg: number): SunPosition {
  const jd = ms / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525.0;
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = M * D2R;
  const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T)
    + Math.sin(3 * Mr) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * D2R);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = (eps0 + 0.00256 * Math.cos(omega * D2R)) * D2R;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda * D2R));
  const y = Math.tan(eps / 2) ** 2;
  const L0r = L0 * D2R;
  const eqTime = 4 * R2D * (
    y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r)
    - 0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr)
  ); // minutes
  const utcMin = (((ms / 60000) % 1440) + 1440) % 1440;
  const tst = (((utcMin + eqTime + 4 * lonDeg) % 1440) + 1440) % 1440; // true solar time, minutes
  const ha = (tst / 4 - 180) * D2R;
  const lat = latDeg * D2R;
  const sinEl = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const geo = Math.asin(Math.max(-1, Math.min(1, sinEl))) * R2D;
  // Atmospheric refraction (Saemundsson), standard pressure / temperature.
  let refr = 0;
  if (geo > -1) refr = 1.02 / Math.tan((geo + 10.3 / (geo + 5.11)) * D2R) / 60;
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) * R2D + 180;
  return { elevation: geo + refr, azimuth: ((az % 360) + 360) % 360, declination: decl * R2D };
}

export interface MoonPosition { elevation: number; azimuth: number; /** illuminated fraction 0 (new) … 1 (full) */ illumination: number; /** elongation from the sun, degrees */ elongation: number }

/**
 * Low-precision lunar position (Meeus, "Astronomical Algorithms" ch. 47 truncated to the dominant terms: ≈0.3° — far below
 * what a 1° moon disc can show) plus its phase. Used for the night sky and moonlit scenery.
 */
export function moonPosition(ms: number, latDeg: number, lonDeg: number): MoonPosition {
  const d = ms / 86400000 + 2440587.5 - 2451545.0; // days since J2000
  const L = 218.316 + 13.176396 * d, M = 134.963 + 13.064993 * d, F = 93.272 + 13.229350 * d;
  const lon = (L + 6.289 * Math.sin(M * D2R)) * D2R, lat = 5.128 * Math.sin(F * D2R) * D2R;
  const eps = (23.4393 - 3.563e-7 * d) * D2R;
  const ra = Math.atan2(Math.sin(lon) * Math.cos(eps) - Math.tan(lat) * Math.sin(eps), Math.cos(lon));
  const dec = Math.asin(Math.sin(lat) * Math.cos(eps) + Math.cos(lat) * Math.sin(eps) * Math.sin(lon));
  const gmst = (280.46061837 + 360.98564736629 * d) % 360;
  const ha = (gmst + lonDeg) * D2R - ra, phi = latDeg * D2R;
  const sinEl = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha);
  const az = Math.atan2(-Math.sin(ha) * Math.cos(dec), Math.cos(phi) * Math.sin(dec) - Math.sin(phi) * Math.cos(dec) * Math.cos(ha));
  const sunLon = (280.46646 + 0.98564736 * d + 1.915 * Math.sin((357.529 + 0.98560028 * d) * D2R)) * D2R;
  const elong = Math.acos(Math.max(-1, Math.min(1, Math.cos(lat) * Math.cos(lon - sunLon))));
  return { elevation: Math.asin(sinEl) * R2D, azimuth: ((az * R2D) % 360 + 360) % 360, illumination: (1 - Math.cos(elong)) / 2, elongation: elong * R2D };
}

export type SunPhase = 'day' | 'golden' | 'civil' | 'nautical' | 'astronomical' | 'night';

/** Light condition from sun elevation (civil / nautical / astronomical twilight definitions). */
export function sunPhase(elevationDeg: number): SunPhase {
  if (elevationDeg >= 10) return 'day';
  if (elevationDeg >= -0.833) return 'golden';
  if (elevationDeg >= -6) return 'civil';
  if (elevationDeg >= -12) return 'nautical';
  if (elevationDeg >= -18) return 'astronomical';
  return 'night';
}

export const SUN_PHASE_LABEL: Record<SunPhase, string> = {
  day: 'Daylight', golden: 'Sunrise / sunset', civil: 'Civil twilight', nautical: 'Nautical twilight', astronomical: 'Astronomical twilight', night: 'Night',
};

const p2 = (n: number) => String(n).padStart(2, '0');

/** `HH:MM:SS` in UTC. */
export function formatUtc(ms: number, seconds = true): string {
  const d = new Date(ms);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}${seconds ? ':' + p2(d.getUTCSeconds()) : ''}`;
}

/** `DD MMM YYYY` in UTC. */
export function formatUtcDate(ms: number): string {
  const d = new Date(ms);
  const m = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getUTCMonth()];
  return `${p2(d.getUTCDate())} ${m} ${d.getUTCFullYear()}`;
}

/**
 * Local time at a location. Without a bundled tz database, civil time is approximated by the
 * nominal 15°-per-hour zone for the longitude (the actual legal zone can differ by an hour or so),
 * which is the same value `Intl` would give for most airports and is always consistent with the sun.
 */
export function localOffsetHours(lonDeg: number): number {
  return Math.round(lonDeg / 15);
}
export function formatLocal(ms: number, lonDeg: number, seconds = false): string {
  return formatUtc(ms + localOffsetHours(lonDeg) * 3600000, seconds);
}
export function localLabel(lonDeg: number): string {
  const o = localOffsetHours(lonDeg);
  return `UTC${o >= 0 ? '+' : '−'}${Math.abs(o)}`;
}

/** Sky/ground lighting factor 0 (full night) … 1 (full day) from solar elevation. */
export function daylight(elevationDeg: number): number {
  const t = (elevationDeg + 8) / 14; // dark below −8°, full light above +6°
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/** 0 by day … 1 when it is dark enough for city / street / window lights (sun below about −1°). */
export function nightLights(elevationDeg: number): number {
  const t = (2 - elevationDeg) / 8;
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}
