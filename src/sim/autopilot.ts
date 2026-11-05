// Full Autopilot: Auto-Takeoff, LNAV (Segment tracking), VNAV (Climb/Cruise/TOD descent), Auto-ILS, Auto-Flare, and Auto-Rollout.
import { FlightModel } from './physics';
import { clamp, wrap180, wrap360, D2R, crossTrack, FlightWaypoint } from './geo';

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
  takeoffHdg = 0;
  targetWpIdx = 0;
  activeWpName = '';
  /** Instrument telemetry only: the attitude reference implied by the existing FPA controller. */
  pitchTargetRad: number | null = null;

  armTakeoff(fm: FlightModel, rwyHdg: number, vrKt?: number, targetAltM?: number) {
    this.on = true; this.pitchTargetRad = null;
    this.gsCaptured = false;
    this.phase = 'takeoff';
    this.nav = true;
    this.appr = false;
    this.takeoffHdg = Math.round(rwyHdg);
    this.hdg = this.takeoffHdg;
    this.altFt = targetAltM ? Math.round(targetAltM / 0.3048) : Math.max(3000, Math.round((fm.pos.y / 0.3048 + 3000) / 500) * 500);
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
    this.altFt = Math.round(fm.pos.y / 0.3048 / 100) * 100;
    this.spd = Math.round(clamp(fm.ias / 0.514444, fm.spec.vs1 * 1.3, fm.spec.vne * 0.8) / 5) * 5;
  }

  /** Changing lateral guidance must also release a captured automatic approach. */
  setLateralMode(mode: 'heading' | 'nav') {
    this.nav = mode === 'nav'; this.appr = false; this.gsCaptured = false;
    if (this.phase === 'approach' || this.phase === 'flare') this.phase = 'cruise';
  }

  disengage() {
    this.on = false; this.pitchTargetRad = null;
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
    const kias = fm.ias / 0.514444;
    const alt = fm.pos.y, agl = fm.agl;
    const track = fm.track;

    let hdgCmd = this.hdg;
    let altTarget = this.altFt * 0.3048;
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

    // -------------------------------------------------------------
    // 1. AUTO-TAKEOFF ON RUNWAY
    // -------------------------------------------------------------
    if (this.phase === 'takeoff') {
      parkingCmd = false;
      gearCmd = true;
      flapsCmd = s.kind === 'piston' ? 1 : Math.min(2, s.flapDetents);
      thrCmd = Math.min(1.0, (fm.ctl.throttle || 0) + dt * 0.4);

      // Rudder steering keeps aircraft centered on runway heading
      const hdgError = wrap180(this.takeoffHdg - fm.heading);
      yawCmd = clamp(hdgError * 0.08, -1, 1);

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
        if (agl > 15) gearCmd = false;
        if (agl > 120 && kias > s.vs1 * 1.35) {
          flapsCmd = 0;
          this.phase = 'climb';
        }
      }
    }

    // -------------------------------------------------------------
    // 2. LNAV & WAYPOINT TRACKING
    // -------------------------------------------------------------
    if (this.phase === 'takeoff') {
      hdgCmd = this.takeoffHdg;
      this.hdg = Math.round(this.takeoffHdg);
    } else if (this.nav && flightPlan && flightPlan.length > 0) {
      const idx = activeWpIndex ?? this.targetWpIdx;
      const targetWp = flightPlan[Math.min(idx, flightPlan.length - 1)];
      this.activeWpName = targetWp.name;

      // Update altitude & speed from waypoint profile if in managed VNAV
      if (this.phase !== 'flare' && this.phase !== 'rollout') {
        altTarget = targetWp.altM;
        this.altFt = Math.round(altTarget / 0.3048);
        spdT = targetWp.speedKt;
        this.spd = spdT;
      }

      // Cross-track course correction between prev waypoint and target waypoint
      let interceptAngle = 0;
      if (curLat !== undefined && curLon !== undefined && isFinite(curLat) && isFinite(curLon)) {
        const prevWp = idx > 0 ? flightPlan[idx - 1] : targetWp;
        const [xtM] = crossTrack(curLat, curLon, prevWp.lat, prevWp.lon, targetWp.lat, targetWp.lon);
        interceptAngle = clamp(-xtM * 0.035, -35, 35);
      }
      const segBearing = navBearing ?? this.hdg;
      hdgCmd = wrap360(segBearing + (isFinite(interceptAngle) ? interceptAngle : 0));
      this.hdg = Math.round(hdgCmd);
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

      // Automatically configure aircraft for landing
      if (ils.dist < 22000) gearCmd = true;
      if (ils.dist < 18000) flapsCmd = Math.min(2, s.flapDetents);
      if (ils.dist < 10000) flapsCmd = s.flapDetents;

      // Approach speed reduction
      spdT = Math.min(spdT, s.vapp + 4 + Math.max(0, ils.dist - 3500) / 1600);
      this.spd = Math.round(spdT);

      if (!this.gsCaptured && Math.abs(ils.gsDots) < 1.4 && ils.dist < 42000 && ils.dist > 250) {
        this.gsCaptured = true;
      }

      if (this.gsCaptured) {
        // Track 3 degree glideslope
        const gain = clamp(ils.dist / 2200, 0.18, 1);
        vsCmd = -fm.gs * Math.tan(3 * D2R) + clamp(ils.gsDots, -2.5, 2.5) * 1.15 * gain;
      } else {
        altTarget = Math.min(altTarget, alt + 5);
        if (ils.dist < 40000) altTarget = alt;
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
      const rolloutHdg = ils ? ils.course : this.takeoffHdg;
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
    // 6. LATERAL CONTROL (Bank & Roll Rate)
    // -------------------------------------------------------------
    const err = wrap180(hdgCmd - (fm.gs > 20 ? track : fm.heading));
    const bankLim = (s.kind === 'jet' ? 25 : 30) * D2R;
    const bankCmd = clamp(err * D2R * 1.5, -bankLim, bankLim);
    let pRate = clamp((bankCmd - fm.bank) * 1.25, -s.maxRollRate * 0.6, s.maxRollRate * 0.6);
    if (this.phase === 'flare' || this.phase === 'rollout') {
      pRate = clamp((0 - fm.bank) * 1.5, -0.2, 0.2); // wings level
    }

    // -------------------------------------------------------------
    // 7. VERTICAL CONTROL (Pitch Rate & Speed Protection)
    // -------------------------------------------------------------
    if (vsCmd === null) {
      const climb = Math.min(this.vsLimit, 4 + s.maxPitchRate * 30);
      vsCmd = clamp((altTarget - alt) * 0.12, -climb * 0.9, climb);
    }
    // Speed & Stall Protection: NEVER pitch up into a stall!
    if (vsCmd > 0) {
      if (kias < s.vs1 * 1.12) {
        // Airspeed near stall: lower nose immediately
        vsCmd = Math.min(0.2, vsCmd * 0.15);
      } else if (kias < s.vs1 * 1.25) {
        vsCmd *= 0.5;
      }
    }
    // Limit flight path angle to safe flight envelope (-15° to +12°)
    const gamma = Math.asin(clamp(fm.vel.y / V, -1, 1));
    const gCmd = Math.asin(clamp(vsCmd / V, -0.25, 0.21));
    this.pitchTargetRad = fm.pitch + gCmd - gamma;
    const pitchIn = clamp(((gCmd - gamma) * 0.88) / s.maxPitchRate, -0.9, 0.9);

    // -------------------------------------------------------------
    // 8. AUTOTHROTTLE
    // -------------------------------------------------------------
    if (this.phase !== 'takeoff' && this.phase !== 'flare' && this.phase !== 'rollout' && this.phase !== 'stopped') {
      thrCmd = clamp(
        thrCmd + clamp((spdT - kias) * 0.035, -0.35, 0.35) * dt + (vsCmd > 2 ? 0.012 * dt : 0),
        0,
        1
      );
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
