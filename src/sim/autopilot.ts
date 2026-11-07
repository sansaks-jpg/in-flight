// Full Autopilot: Auto-Takeoff, LNAV (leg-based fly-by tracking), VNAV (climb / cruise / 3° descent path),
// Auto-ILS or visual 3° final, Auto-Flare, and Auto-Rollout.
//
// Modelled on real flight-guidance behaviour:
//  * Lateral: turn-rate law (standard rate = 3°/s) -> bank angle  φ = atan(ω·V/g), limited to 25° (15° below 500 ft AGL).
//  * LNAV engages only after the aircraft is established in the climb (>= 400 ft AGL); before that, runway track is held.
//  * LNAV guides along the active LEG and anticipates turns (fly-by) — see lnav.ts. It never targets a fix behind the aircraft.
//  * VNAV climbs to the plan's cruise level at the speed schedule, holds it, and starts a 3° path descent at the TOD fix.
//  * Jet/turboprop speed schedule: <= 250 KIAS below 10,000 ft MSL (FAR 91.117).
//  * A minimum safe altitude is enforced outside the approach so a bad target can never drive the aircraft into terrain.
import { FlightModel, atmosphere } from './physics';
import { clamp, wrap180, wrap360, D2R, destination, crossTrack, bearing, haversine, FlightWaypoint } from './geo';
import { legGuidance, interceptAngleDeg, planCruiseAltM, planDistanceM } from './lnav';

export interface IlsData {
  valid: boolean;
  dist: number;
  cross: number;
  locDots: number;
  gsDots: number;
  course: number;
  elev: number;
  x: number;
  z: number;
  ident: string;
  angle: number;
}

export interface ApCmd {
  pitch: number;
  roll: number;
  throttle: number | null;
  yaw: number;
  gearDown?: boolean;
  flapsIdx?: number;
  brake?: number;
  parking?: boolean;
  reverse?: boolean;
  speedbrake?: number;
}

export type ApPhase = 'idle' | 'takeoff' | 'climb' | 'cruise' | 'descent' | 'approach' | 'flare' | 'rollout' | 'stopped';

const G = 9.80665;
const FT = 0.3048;
const KT = 0.514444;
/** 3° descent / glide path. */
const TAN_3 = Math.tan(3 * D2R);
const TAN_6 = Math.tan(6 * D2R);
/** FAR 91.117: 250 KIAS below 10,000 ft MSL. */
const SPEED_LIMIT_ALT_M = 10000 * FT;
const SPEED_LIMIT_KT = 250;
/** Minimum clearance above terrain for any non-approach target altitude (≈ 500 ft). */
const MIN_SAFE_AGL_M = 150;
/** LNAV is not engaged below this height after take-off (≈ 400 ft AGL). */
const LNAV_ENGAGE_AGL_M = 120;

/** Stall-speed reference for the present flap configuration (same switch-over as the stall model in physics.ts). */
export function stallRefKt(fm: FlightModel): number { return fm.flapsPos > 0.3 ? fm.spec.vs0 : fm.spec.vs1; }
/** Lowest speed the autopilot will ever select: VLS ≈ 1.23 Vs of the CURRENT configuration (clean ≈ green dot, flaps FULL ≈ Vref). */
export function minSpeedKt(fm: FlightModel): number { return stallRefKt(fm) * 1.23; }
/** KIAS that corresponds to the cruise Mach (jets) at an altitude, capped at the 300 kt climb / descent speed. */
function managedJetKias(machCruise: number, alt: number): number {
  const a = atmosphere(alt);
  return Math.min(300, (machCruise * a.a * Math.sqrt(a.sigma)) / KT);
}
interface ApproachStage { kt: number; flaps: number; gear: boolean }
/**
 * Configuration / speed schedule on final, by track distance D to the threshold (airline practice: CONF 1 at the IAF,
 * CONF 2, gear + CONF 3 about 5 NM out, CONF FULL stabilised at ~3 NM, Vapp + 3 over the threshold). Speeds are
 * Vapp-relative so they stay valid for every aircraft; every stage stays below the flap placard (checked in step()).
 */
function approachStage(s: { vapp: number; flapDetents: number }, D: number): ApproachStage {
  const k = s.vapp / 135, full = s.flapDetents;
  const knots: [number, number][] = [[1500, 3], [5000, 12], [9000, 30], [13000, 45], [18500, 60], [30000, 115]];
  let add = knots[knots.length - 1][1];
  if (D <= knots[0][0]) add = knots[0][1];
  else for (let i = 1; i < knots.length; i++) if (D <= knots[i][0]) { const f = (D - knots[i - 1][0]) / (knots[i][0] - knots[i - 1][0]); add = knots[i - 1][1] + f * (knots[i][1] - knots[i - 1][1]); break; }
  const step = D < 6500 ? full : D < 10500 ? Math.max(1, full - 1) : D < 14500 ? Math.min(2, full) : D < 20000 ? 1 : 0;
  return { kt: s.vapp + add * k, flaps: Math.min(step, full), gear: D < 10500 };
}

export class Autopilot {
  on = false;
  phase: ApPhase = 'idle';
  nav = true;
  appr = false;
  gsCaptured = false;
  hdg = 0;
  altFt = 3000;
  spd = 120;
  vsLimit = 8;
  /** FCU selected (pulled) vs managed (pushed) guidance: when selected, VNAV/LNAV no longer overwrite the FCU target. */
  altSelected = false; spdSelected = false;
  /** FCU V/S mode: commanded vertical speed in ft/min (null = altitude guidance). Cleared on altitude capture or AP disconnect. */
  vsHoldFpm: number | null = null;
  /** FCU EXPED pushbutton: higher climb / descent rate limit. */
  expedite = false;
  takeoffHdg = 0;
  targetWpIdx = 0;
  activeWpName = '';
  /** Instrument telemetry only: the attitude reference implied by the existing FPA controller. */
  pitchTargetRad: number | null = null;
  private sbCmd = 0;
  private prevKias = 0;
  private accKt = 0;

  armTakeoff(fm: FlightModel, rwyHdg: number, vrKt?: number, targetAltM?: number) {
    this.on = true; this.pitchTargetRad = null;
    this.gsCaptured = false;
    this.phase = 'takeoff';
    this.nav = true;
    this.appr = false;
    this.takeoffHdg = Math.round(rwyHdg);
    this.hdg = this.takeoffHdg;
    this.altFt = targetAltM ? Math.round(targetAltM / FT) : Math.max(3000, Math.round((fm.pos.y / FT + 3000) / 500) * 500);
    this.spd = Math.round((vrKt ?? fm.spec.vr) * 1.35);
  }

  engage(fm: FlightModel, initialHdg?: number) {
    if (fm.wow) {
      this.armTakeoff(fm, initialHdg ?? fm.heading);
      return;
    }
    this.on = true; this.pitchTargetRad = null;
    this.gsCaptured = false;
    this.takeoffHdg = initialHdg ?? Math.round(fm.heading);
    this.hdg = this.takeoffHdg;
    this.phase = 'cruise';
    this.nav = true;
    this.appr = false;
    this.prevKias = fm.ias / KT; this.accKt = 0;
    this.altFt = Math.round(fm.pos.y / FT / 100) * 100;
    this.spd = Math.round(clamp(fm.ias / KT, minSpeedKt(fm), fm.spec.vne * 0.8) / 5) * 5;
  }

  /** Changing lateral guidance must also release a captured automatic approach. */
  setLateralMode(mode: 'heading' | 'nav') {
    this.nav = mode === 'nav'; this.appr = false; this.gsCaptured = false;
    if (this.phase === 'approach' || this.phase === 'flare') this.phase = 'cruise';
  }

  disengage() {
    this.on = false; this.sbCmd = 0; this.pitchTargetRad = null; this.vsHoldFpm = null; this.expedite = false;
    this.phase = 'idle';
    this.appr = false;
    this.nav = false;
    this.gsCaptured = false;
  }

  /**
   * Main autopilot step called every frame.
   * Returns control demands for elevator, aileron, throttle, rudder, and aircraft systems.
   */
  step(
    fm: FlightModel,
    dt: number,
    navBearing: number | null,
    ils: IlsData | null,
    flightPlan?: FlightWaypoint[],
    activeWpIndex?: number,
    curLat?: number,
    curLon?: number
  ): ApCmd {
    const s = fm.spec;
    const V = Math.max(25, fm.vel.length());
    const kias = fm.ias / KT;
    const alt = fm.pos.y, agl = fm.agl;
    const track = fm.track;
    const gsMs = Math.max(20, fm.gs);
    const havePos = curLat !== undefined && curLon !== undefined && isFinite(curLat) && isFinite(curLon);
    const plan = flightPlan ?? [];
    let idx = plan.length ? clamp(Math.floor(activeWpIndex ?? this.targetWpIdx), 0, plan.length - 1) : 0;
    // Safety net: the departure-runway fix is never a navigation target once the aircraft has left the ground.
    while (plan.length && !fm.wow && plan[idx].type === 'takeoff' && idx < plan.length - 1) idx++;
    const wp: FlightWaypoint | undefined = plan.length ? plan[idx] : undefined;

    let hdgCmd = this.hdg;
    let altTarget = this.altFt * FT;
    let spdT = this.spd;
    let vsCmd: number | null = null;
    let yawCmd = 0;
    let thrCmd = fm.ctl.throttle;
    let gearCmd = fm.ctl.gearDown;
    let flapsCmd = fm.ctl.flapsIdx;
    let brakeCmd = 0;
    let reverseCmd = false;
    let speedbrakeCmd = fm.ctl.speedbrake;
    let parkingCmd = false;
    const bankLimDeg = 25; // standard-rate turns never need more; keeps passengers (and light aircraft) comfortable

    // -------------------------------------------------------------
    // 1. AUTO-TAKEOFF ON RUNWAY
    // -------------------------------------------------------------
    if (this.phase === 'takeoff') {
      parkingCmd = false;
      gearCmd = true;
      flapsCmd = s.kind === 'piston' ? 1 : Math.min(2, s.flapDetents);
      thrCmd = Math.min(1.0, (fm.ctl.throttle || 0) + dt * 0.4);

      // Rudder steering keeps the aircraft on the runway centreline: heading error + (bounded) cross-track correction.
      let steerErr = wrap180(this.takeoffHdg - fm.heading);
      const dep = plan[0];
      if (fm.wow && havePos && dep && dep.type === 'takeoff' && dep.hdg !== undefined) {
        const [aLat, aLon] = destination(dep.lat, dep.lon, dep.hdg, 4000);
        const [xt] = crossTrack(curLat!, curLon!, dep.lat, dep.lon, aLat, aLon);
        if (Math.abs(xt) < 40) steerErr += clamp(-xt * 0.5, -5, 5);
      }
      yawCmd = clamp(steerErr * 0.08, -1, 1);

      if (fm.wow) {
        if (kias >= s.vr) {
          // Smooth rotation to realistic climb rate (no sudden tailstrike or over-rotation!)
          const climbTarget = s.kind === 'jet' ? 6.5 : s.kind === 'turboprop' ? 4.5 : 3.2;
          vsCmd = climbTarget;
        } else {
          // Keep nose firmly on the ground during roll
          vsCmd = -0.5;
        }
      } else {
        // Airborne! Maintain positive climb rate
        const climbTarget = s.kind === 'jet' ? Math.min(this.vsLimit, 8.0) : s.kind === 'turboprop' ? 5.2 : 3.8;
        vsCmd = climbTarget;
        // Positive rate -> gear up
        if (agl > 12 && fm.vel.y > 0.5) gearCmd = false;
        // Acceleration height reached with a safe margin over stall: clean up and hand over to the climb (LNAV may engage now).
        if (agl > LNAV_ENGAGE_AGL_M && kias > s.vs1 * 1.3) {
          flapsCmd = 0;
          this.phase = 'climb';
        }
      }
    }

    // -------------------------------------------------------------
    // 2. LNAV (leg guidance) + VNAV (altitude path / speed profile)
    // -------------------------------------------------------------
    const landingLeg = !!wp && (wp.type === 'faf' || wp.type === 'touchdown' || wp.type === 'rollout');
    const tdIdx = plan.findIndex((w) => w.type === 'touchdown');
    const arrWp: FlightWaypoint | undefined = tdIdx >= 0 ? plan[tdIdx] : undefined;
    let distToArr = Infinity; // signed: > 0 while the threshold is still ahead
    let pathOn = false;       // VNAV is flying the 3° path to the threshold
    let pathAltM = 0;
    let stage: ApproachStage | null = null;
    if (this.phase === 'takeoff') {
      hdgCmd = this.takeoffHdg;
      this.hdg = Math.round(this.takeoffHdg);
    } else if (this.nav && wp && havePos) {
      this.activeWpName = wp.name;
      // --- lateral: follow the LEG, intercept with a speed-scaled angle ---
      const g = legGuidance(plan, idx, curLat!, curLon!);
      const icpt = g.direct ? 0 : interceptAngleDeg(g.xtkM, gsMs);
      hdgCmd = wrap360(g.course + (isFinite(icpt) ? icpt : 0));
      this.hdg = Math.round(wrap360(g.course)); // FCU read-out shows the leg course, not the momentary intercept heading

      // --- vertical + speed profile ---
      if (this.phase !== 'flare' && this.phase !== 'rollout') {
        const cruiseAlt = planCruiseAltM(plan) ?? Math.max(alt, wp.altM);
        let managedAlt = cruiseAlt;
        let clearedAlt = cruiseAlt; // what the FCU altitude window shows (never the moving path)
        if (arrWp && idx <= tdIdx) {
          const dPath = planDistanceM(plan, idx, curLat!, curLon!, tdIdx);
          const pathAlt = arrWp.altM + dPath * TAN_3; pathAltM = pathAlt;
          if (pathAlt < cruiseAlt) {
            // VNAV path descent: the target is the 3° path itself. Below it (still climbing, or engaged low) the aircraft climbs to
            // meet it - the path law below only takes over once the path is reached, so it never flies parallel underneath it.
            const iaf = plan.find((w) => w.type === 'iaf');
            clearedAlt = iaf ? iaf.altM : arrWp.altM;
            managedAlt = pathAlt;
            pathOn = alt >= pathAlt - 40;
          }
          const ahead = arrWp.hdg === undefined || Math.abs(wrap180(bearing(curLat!, curLon!, arrWp.lat, arrWp.lon) - arrWp.hdg)) < 90;
          const dDirect = haversine(curLat!, curLon!, arrWp.lat, arrWp.lon);
          distToArr = ahead ? dDirect : -dDirect;
          if (landingLeg || dPath < 30000) stage = approachStage(s, Math.max(0, ahead ? dPath : 0));
        }
        altTarget = managedAlt;
        // Jets: managed speed is Mach-based (cruiseKt is a TAS at the cruise level) -> the KIAS that corresponds to it, <= 300.
        const managedSpd = s.kind === 'jet' ? managedJetKias(s.cruiseKt * KT / atmosphere(s.cruiseAlt).a, alt) : (wp.speedKt > 0 ? wp.speedKt : spdT);
        spdT = stage ? Math.min(managedSpd, stage.kt) : managedSpd;
        if (this.altSelected) altTarget = this.altFt * FT; else this.altFt = Math.round(clearedAlt / FT);
        if (this.spdSelected) spdT = this.spd; else this.spd = Math.round(spdT);
        if (pathOn && !this.altSelected && vsCmd === null && this.vsHoldFpm === null) {
          // Follow the geometric path: ground-speed-scaled sink rate plus a gentle correction for the vertical deviation.
          vsCmd = clamp(-fm.gs * TAN_3 + clamp(pathAltM - alt, -150, 150) * 0.05, -fm.gs * TAN_6, 2.5);
        }
        if (stage && (landingLeg || (distToArr > 0 && distToArr < 22000))) {
          // Configure for landing - never beyond the flap / gear placard speeds.
          const vfe = s.vfe[Math.min(s.vfe.length - 1, Math.max(0, Math.min(stage.flaps, s.flapDetents)))];
          if (stage.flaps > fm.ctl.flapsIdx && kias <= vfe - 3) flapsCmd = stage.flaps;
          if (stage.gear && kias <= s.vle) gearCmd = true;
        }
        if (landingLeg && agl < 16 && distToArr < 3200 && distToArr > -3000) this.phase = 'flare';
      }
    } else if (this.nav && navBearing !== null) {
      hdgCmd = navBearing;
      this.hdg = Math.round(wrap360(navBearing));
    }

    // -------------------------------------------------------------
    // 3. AUTO-ILS & APPROACH
    // -------------------------------------------------------------
    const useIls = (this.appr || this.phase === 'approach') && ils && ils.valid;
    if (useIls && ils) {
      this.phase = 'approach';
      this.hdg = Math.round(wrap360(ils.course));
      const interceptAngle = clamp(ils.cross * 0.045, -35, 35) * clamp(ils.dist / 6000, 0.35, 1);
      hdgCmd = ils.course - interceptAngle;

      stage = approachStage(s, Math.max(0, ils.dist));
      const vfe = s.vfe[Math.min(s.vfe.length - 1, Math.max(0, Math.min(stage.flaps, s.flapDetents)))];
      if (ils.dist < 22000 && stage.flaps > fm.ctl.flapsIdx && kias <= vfe - 3) flapsCmd = stage.flaps;
      if (ils.dist < 22000 && stage.gear && kias <= s.vle) gearCmd = true;
      spdT = Math.min(spdT, stage.kt);
      this.spd = Math.round(spdT);

      if (!this.gsCaptured && Math.abs(ils.gsDots) < 1.4 && ils.dist < 42000 && ils.dist > 250) {
        this.gsCaptured = true;
      }

      if (this.gsCaptured) {
        // Track 3 degree glideslope
        const gain = clamp(ils.dist / 2200, 0.18, 1);
        vsCmd = -fm.gs * TAN_3 + clamp(ils.gsDots, -2.5, 2.5) * 1.15 * gain;
      } else {
        altTarget = Math.min(altTarget, alt + 5);
        if (ils.dist < 40000) altTarget = alt;
        // Too high to meet the beam (it only comes down towards a level aircraft from below): descend at up to 5.5° to intercept it from above.
        const beamAlt = ils.elev + 15 + Math.max(0, ils.dist) * TAN_3;
        if (ils.dist > 2500 && ils.dist < 42000 && alt > beamAlt + 60) {
          vsCmd = clamp(-2 - (alt - beamAlt) * 0.04, -fm.gs * Math.tan(5.5 * D2R), -2);
        }
      }

      // Auto-flare trigger
      if (agl < 16 && ils.dist < 3200) {
        this.phase = 'flare';
      }
    }

    // -------------------------------------------------------------
    // 4. AUTO-FLARE (Near Touchdown)
    // -------------------------------------------------------------
    if (this.phase === 'flare') {
      vsCmd = -(0.4 + Math.max(0, agl) * 0.07);
      thrCmd = Math.max(0, thrCmd - dt * 0.45);
      if (fm.wow) {
        this.phase = 'rollout';
      }
    }

    // -------------------------------------------------------------
    // 5. AUTO-ROLLOUT & BRAKING (Touchdown to Stop)
    // -------------------------------------------------------------
    if (this.phase === 'rollout') {
      thrCmd = 0;
      brakeCmd = 1.0;
      speedbrakeCmd = 1.0;
      gearCmd = true;

      // Reverse thrust down to 30 kt
      if (s.hasReverse && fm.gs > 15) {
        reverseCmd = true;
        thrCmd = 0.8;
      } else {
        reverseCmd = false;
        thrCmd = 0;
      }

      // Keep aircraft centered on runway heading
      const arrHdg = plan.find((w) => w.type === 'touchdown')?.hdg;
      const rolloutHdg = ils ? ils.course : (arrHdg ?? this.takeoffHdg);
      const rwyError = wrap180(rolloutHdg - fm.heading);
      yawCmd = clamp(rwyError * 0.08, -1, 1);
      vsCmd = -2.0;

      // Stop!
      if (fm.gs < 1.5) {
        this.phase = 'stopped';
        parkingCmd = true;
        brakeCmd = 1.0;
        this.on = false; // complete flight!
      }
    }

    // -------------------------------------------------------------
    // 6. SPEED SCHEDULE + MINIMUM SAFE ALTITUDE
    // -------------------------------------------------------------
    const approaching = !!useIls || landingLeg || pathOn && distToArr < 25000 || this.phase === 'flare' || this.phase === 'rollout';
    if (!approaching && this.phase !== 'takeoff' && !fm.wow && agl > 5) {
      // Never command a level below the terrain + 500 ft (e.g. a stale/low target must not fly the aircraft into the ground).
      const groundMsl = alt - agl;
      altTarget = Math.max(altTarget, groundMsl + MIN_SAFE_AGL_M);
    }
    if (s.kind !== 'piston' && !approaching && !stage) {
      // FAR 91.117: 250 KIAS below 10,000 ft - decelerating over the 1,500 ft above it so the speed is stable when the limit applies.
      const lim = SPEED_LIMIT_KT + clamp((alt - SPEED_LIMIT_ALT_M) / (1500 * FT), 0, 1) * 50;
      spdT = Math.min(spdT, lim);
    }
    spdT = clamp(spdT, minSpeedKt(fm), s.vne * 0.85);
    if (this.nav && !this.spdSelected && !useIls && this.phase !== 'takeoff') this.spd = Math.round(spdT);

    // -------------------------------------------------------------
    // 7. LATERAL CONTROL (turn rate -> bank)
    // -------------------------------------------------------------
    const lowLevel = agl < 150 && this.phase !== 'flare' && this.phase !== 'rollout';
    const bankLim = (lowLevel ? 15 : bankLimDeg) * D2R;
    const ref = fm.gs > 20 ? track : fm.heading;
    const err = wrap180(hdgCmd - ref);
    // Rate-one turns at most (3°/s); gentle proportional roll-in so the turn rolls out on the target without overshoot.
    const rateCmd = clamp(err * D2R * 0.3, -3 * D2R, 3 * D2R);
    const bankCmd = this.phase === 'takeoff' && fm.wow ? 0 : clamp(Math.atan((rateCmd * V) / G), -bankLim, bankLim);
    let pRate = clamp((bankCmd - fm.bank) * 1.25, -s.maxRollRate * 0.6, s.maxRollRate * 0.6);
    if (this.phase === 'flare' || this.phase === 'rollout') {
      pRate = clamp((0 - fm.bank) * 1.5, -0.2, 0.2); // wings level
    }

    // -------------------------------------------------------------
    // 8. VERTICAL CONTROL (Pitch Rate & Speed Protection)
    // -------------------------------------------------------------
    if (vsCmd === null && this.vsHoldFpm !== null) {
      // FCU V/S mode: hold the selected rate (1 ft/min = 0.00508 m/s); capture the FCU altitude when it is reached in the direction of travel.
      const dTgt = altTarget - alt;
      if (this.vsHoldFpm !== 0 && Math.sign(dTgt) === Math.sign(this.vsHoldFpm) && Math.abs(dTgt) < Math.max(18, Math.abs(this.vsHoldFpm) * 0.00508 * 7)) this.vsHoldFpm = null;
      else vsCmd = this.vsHoldFpm * 0.00508;
    }
    if (vsCmd === null) {
      const maxClimb = Math.min(this.vsLimit * (this.expedite ? 1.35 : 1), 4 + s.maxPitchRate * 30);
      const dErr = altTarget - alt;
      if (dErr < -30) {
        // Descend on a 3° path (not a dive), then capture the level smoothly.
        vsCmd = Math.max(-Math.max(2.5, fm.gs * TAN_3), dErr * 0.18, -maxClimb * 1.3);
      } else {
        vsCmd = clamp(dErr * 0.14, -maxClimb * 0.9, maxClimb);
      }
    }
    // Speed & Stall Protection: NEVER pitch up into a stall!
    if (vsCmd > 0) {
      const vsRef = stallRefKt(fm);
      if (kias < vsRef * 1.12) {
        // Airspeed near stall: lower nose immediately
        vsCmd = Math.min(0.2, vsCmd * 0.15);
      } else if (kias < vsRef * 1.2) {
        vsCmd *= 0.5;
      }
    }
    // Overspeed protection: trade altitude for speed instead of diving through Vne.
    if (kias > s.vne * 0.95 && vsCmd < 0) vsCmd = Math.max(vsCmd, 0);
    // Limit flight path angle to safe flight envelope (-15° to +12°)
    const gamma = Math.asin(clamp(fm.vel.y / V, -1, 1));
    const gCmd = Math.asin(clamp(vsCmd / V, -0.25, 0.21));
    this.pitchTargetRad = fm.pitch + gCmd - gamma;
    const pitchIn = clamp(((gCmd - gamma) * 0.88) / s.maxPitchRate, -0.9, 0.9);

    // -------------------------------------------------------------
    // 9. AUTOTHROTTLE (+ speedbrakes when idle thrust cannot slow the aircraft on the path)
    // -------------------------------------------------------------
    if (s.hasSpeedbrake && this.phase !== 'takeoff' && this.phase !== 'flare' && this.phase !== 'rollout' && this.phase !== 'stopped') {
      // Smoothly extended at most 60 %, only with idle thrust, and never with CONF 3 / FULL (Airbus FCOM limitation).
      const want = fm.ctl.throttle < 0.06 && fm.ctl.flapsIdx < 3 && kias > spdT + 8 ? clamp((kias - spdT - 8) / 30, 0, 0.6) : 0;
      this.sbCmd += clamp(want - this.sbCmd, -dt * 0.25, dt * 0.25);
      speedbrakeCmd = this.sbCmd;
    }
    if (this.phase !== 'takeoff' && this.phase !== 'flare' && this.phase !== 'rollout' && this.phase !== 'stopped') {
      // Damped speed hold: integral on speed error, minus acceleration feedback (stops the throttle hunting 0 <-> 1).
      const acc = dt > 1e-4 ? (kias - this.prevKias) / dt : 0;
      this.accKt += (clamp(acc, -8, 8) - this.accKt) * clamp(dt / 1.2, 0, 1);
      thrCmd = clamp(thrCmd + (clamp((spdT - kias) * 0.014, -0.1, 0.1) - this.accKt * 0.09) * dt + (vsCmd > 2 ? 0.01 * dt : 0), 0, 1);
    }
    this.prevKias = kias;

    // Mode annunciation follows what the aircraft is actually doing.
    if (this.phase === 'climb' || this.phase === 'cruise' || this.phase === 'descent') {
      const e = altTarget - alt;
      this.phase = pathOn || e < -90 ? 'descent' : e > 90 ? 'climb' : 'cruise';
    }

    return {
      pitch: isFinite(pitchIn) ? pitchIn : 0,
      roll: isFinite(pRate) ? clamp(pRate / s.maxRollRate, -1, 1) : 0,
      throttle: isFinite(thrCmd) ? thrCmd : 0.5,
      yaw: isFinite(yawCmd) ? yawCmd : 0,
      gearDown: gearCmd,
      flapsIdx: flapsCmd,
      brake: isFinite(brakeCmd) ? brakeCmd : 0,
      parking: parkingCmd,
      reverse: reverseCmd,
      speedbrake: isFinite(speedbrakeCmd) ? speedbrakeCmd : 0,
    };
  }
}
