// Magnetic variation from the World Magnetic Model (WMM2025, NOAA/BGS) – the same model used by real avionics.
// Runway numbers, ILS courses, VOR radials, ATC headings and the cockpit compass are all MAGNETIC; the simulator's
// physics and geography are TRUE. These helpers are the single place where the two are converted.
import * as geomagnetism from 'geomagnetism';

let model: ReturnType<typeof geomagnetism.model> | null = null;
const cache = new Map<string, number>();
const wrap360 = (a: number) => ((a % 360) + 360) % 360;

/** Magnetic variation in degrees, EAST positive (true = magnetic + variation). */
export function magVar(lat: number, lon: number): number {
  const k = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  try {
    model ||= geomagnetism.model(new Date(), { allowOutOfBoundsModel: true });
    const d = model.point([lat, lon]).decl;
    const v = Number.isFinite(d) ? d : 0;
    cache.set(k, v);
    return v;
  } catch {
    return 0;
  }
}
export const trueToMag = (trueDeg: number, lat: number, lon: number) => wrap360(trueDeg - magVar(lat, lon));
export const magToTrue = (magDeg: number, lat: number, lon: number) => wrap360(magDeg + magVar(lat, lon));
/** "0.6°E" / "1.2°W" */
export function fmtVar(v: number) { return `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'E' : 'W'}`; }
