// Lateral navigation (LNAV) maths shared by the autopilot and the game's waypoint sequencer.
//
// Real FMS/autopilot behaviour this module reproduces:
//  * Guidance follows the LEG (previous fix -> active fix), not a direct bearing to the fix, and corrects cross-track error
//    with a bounded intercept angle (max 30°) whose gain is scaled with speed so the capture time is constant.
//  * Waypoints are FLY-BY: the sequence happens at the turn-anticipation distance  d = R·tan(Δθ/2)  (R = V²/(g·tan φ)),
//    or when the aircraft is abeam / past the fix — never by "getting within a radius" of a fix that is behind the aircraft.
//  * A runway-departure waypoint is never a navigation target once the aircraft is on/after it, so engaging the autopilot
//    after take-off can no longer make it turn back to the airport.
import { bearing, haversine, crossTrack, destination, wrap180, clamp, D2R, FlightWaypoint } from './geo';

const G = 9.80665;
/** Beyond this cross-track error the autopilot flies "direct-to" instead of intercepting the leg (real FMS: ~8 NM). */
const DIRECT_TO_XTK_M = 15000;
const MAX_INTERCEPT_DEG = 30;
/** Capture-time constant of the cross-track loop (s). */
const XTK_TAU_S = 28;

/** Minimum fly-by capture distance per fix type (m); the computed turn-anticipation distance is used if larger. */
const MIN_CAPTURE_M: Record<FlightWaypoint['type'], number> = {
  takeoff: 0, climb: 1500, cruise: 2000, tod: 1500, iaf: 1000, faf: 500, touchdown: 150, rollout: 80,
};

export interface LegGuidance {
  /** Desired ground track (° true) at the aircraft's present position on the leg (before the intercept correction). */
  course: number;
  /** Cross-track error (m). Positive = right of the leg. */
  xtkM: number;
  /** Distance still to fly along the leg (m). */
  alongToGoM: number;
  distToWpM: number;
  legLenM: number;
  /** True when the aircraft is too far off the leg to intercept it, so it flies direct to the fix. */
  direct: boolean;
}

/** Course the aircraft is meant to be flying when it arrives at plan[idx]. */
export function inboundCourse(plan: FlightWaypoint[], idx: number, lat: number, lon: number): number {
  const wp = plan[idx];
  if (idx > 0) {
    const p = plan[idx - 1];
    if (haversine(p.lat, p.lon, wp.lat, wp.lon) > 50) return bearing(p.lat, p.lon, wp.lat, wp.lon);
  }
  if (wp.hdg !== undefined) return wp.hdg;
  return bearing(lat, lon, wp.lat, wp.lon);
}

export function legGuidance(plan: FlightWaypoint[], idx: number, lat: number, lon: number): LegGuidance {
  const wp = plan[idx];
  const dist = haversine(lat, lon, wp.lat, wp.lon);
  const direct = (): LegGuidance => ({ course: bearing(lat, lon, wp.lat, wp.lon), xtkM: 0, alongToGoM: dist, distToWpM: dist, legLenM: dist, direct: true });
  const prev = idx > 0 ? plan[idx - 1] : null;
  if (!prev) return direct();
  const legLen = haversine(prev.lat, prev.lon, wp.lat, wp.lon);
  if (legLen < 150) return direct();
  const [xtk, atk] = crossTrack(lat, lon, prev.lat, prev.lon, wp.lat, wp.lon);
  if (Math.abs(xtk) > DIRECT_TO_XTK_M || atk < -DIRECT_TO_XTK_M) return direct();
  // Great-circle course changes along the leg: take it at the aircraft's own along-track position.
  const legBrg = bearing(prev.lat, prev.lon, wp.lat, wp.lon);
  const [pl, po] = destination(prev.lat, prev.lon, legBrg, clamp(atk, 0, legLen - 1));
  const course = haversine(pl, po, wp.lat, wp.lon) > 30 ? bearing(pl, po, wp.lat, wp.lon) : legBrg;
  return { course, xtkM: xtk, alongToGoM: legLen - atk, distToWpM: dist, legLenM: legLen, direct: false };
}

/** Heading offset (°) that intercepts / holds the leg. Gain scales with ground speed for a constant capture time. */
export function interceptAngleDeg(xtkM: number, gsMs: number): number {
  const k = 57.2958 / (Math.max(30, gsMs) * XTK_TAU_S); // deg per metre
  return clamp(-xtkM * k, -MAX_INTERCEPT_DEG, MAX_INTERCEPT_DEG);
}

/** Fly-by turn anticipation distance for a course change, at a given ground speed and bank angle. */
export function turnLeadM(inCourse: number, outCourse: number, gsMs: number, bankDeg = 25): number {
  const dTheta = Math.abs(wrap180(outCourse - inCourse)) * D2R;
  if (dTheta < 3 * D2R) return 0;
  const r = (gsMs * gsMs) / (G * Math.tan(bankDeg * D2R));
  return clamp(r * Math.tan(Math.min(dTheta, 150 * D2R) / 2), 0, 25000);
}

/**
 * Advances the active waypoint as far as the geometry demands (can skip several fixes at once, e.g. when the
 * autopilot is engaged in the middle of a route). Never moves backwards and never leaves the last fix.
 * @param airborne  departure-runway fixes are skipped outright once the aircraft has left the ground.
 */
export function advanceWaypoint(
  plan: FlightWaypoint[], idx: number, lat: number, lon: number, gsMs: number, airborne: boolean,
): number {
  if (!plan.length || !isFinite(lat) || !isFinite(lon)) return clamp(idx, 0, Math.max(0, plan.length - 1));
  let i = clamp(Math.floor(idx), 0, plan.length - 1);
  for (let guard = 0; guard < plan.length && i < plan.length - 1; guard++) {
    const wp = plan[i];
    if (airborne && wp.type === 'takeoff') { i++; continue; }
    const dist = haversine(lat, lon, wp.lat, wp.lon);
    const inC = inboundCourse(plan, i, lat, lon);
    const outC = bearing(wp.lat, wp.lon, plan[i + 1].lat, plan[i + 1].lon);
    const capture = Math.max(turnLeadM(inC, outC, gsMs), MIN_CAPTURE_M[wp.type]);
    // "Passed": the fix is now behind the aircraft relative to the course that leads to it.
    const behind = Math.abs(wrap180(bearing(lat, lon, wp.lat, wp.lon) - inC)) > 90 && dist < 60000;
    // A passed fix is only skipped when the aircraft is actually on / near its leg; far off-route it keeps flying direct-to.
    if (dist <= capture || behind) { i++; continue; }
    break;
  }
  return i;
}

/** Highest cruise-level altitude in the plan (null when the route is too short to have a cruise segment). */
export function planCruiseAltM(plan: FlightWaypoint[]): number | null {
  let best: number | null = null;
  for (const w of plan) if ((w.type === 'cruise' || w.type === 'tod') && (best === null || w.altM > best)) best = w.altM;
  return best;
}
