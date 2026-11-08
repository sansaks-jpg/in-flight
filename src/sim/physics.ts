// 6-DOF rigid-body flight model. Body frame: +X right, +Y up, -Z forward. World: +X east, +Y up, -Z north.
import { Vector3, Quaternion } from 'three';
import { AircraftSpec } from './specs';
import { clamp, lerp, smoothstep, wrap180 } from './geo';

export const G = 9.80665;
/**
 * Real-time air state, fed from live weather (see liveWeather.ts): ISA temperature deviation (K) and the sea-level pressure (hPa)
 * that applies at the aircraft's position. Density altitude, true airspeed, Mach and engine lapse all follow from these.
 */
export const airState = { dT: 0, qnh: 1013.25 };
export interface Atmosphere { T: number; rho: number; p: number; a: number; sigma: number; }
/** ISA + live deviation. Pass `out` from per-frame code to avoid allocating the result object. */
export function atmosphere(h: number, out: Atmosphere = { T: 0, rho: 0, p: 0, a: 0, sigma: 0 }): Atmosphere {
  const hh = Math.max(-300, h);
  const Tisa = hh < 11000 ? 288.15 - 0.0065 * hh : 216.65;
  const T = Tisa + airState.dT * (hh < 11000 ? 1 - hh / 22000 : 0.5);
  const pIsa = hh < 11000 ? 101325 * Math.pow(Tisa / 288.15, 5.2559) : 22632 * Math.exp(-(hh - 11000) / 6342);
  // a sea-level pressure anomaly decays with height (roughly follows the column mass)
  const p = pIsa * (1 + (airState.qnh / 1013.25 - 1) * Math.exp(-hh / 9000));
  const rho = p / (287.05 * T);
  out.T = T; out.rho = rho; out.p = p; out.a = Math.sqrt(1.4 * 287.05 * T); out.sigma = rho / 1.225;
  return out;
}

export interface Controls {
  pitch: number; roll: number; yaw: number; // pilot demand -1..1 (pitch +1 = pull back / nose up, roll +1 = right, yaw +1 = right)
  throttle: number; brake: number; parking: boolean; reverse: boolean; speedbrake: number;
  flapsIdx: number; gearDown: boolean; trim: number; assist: boolean; apHold: boolean;
  /** Differential wheel brakes (added to `brake`): left / right main gear, 0..1. */
  brakeL: number; brakeR: number;
  /** Aircraft electrics + piston mixture (0 = cut-off, 1 = full rich). */
  battery: boolean; mixture: number;
  /** A320 extras: right-engine lever offset (right − left), autobrake 0 off / 1 LO / 2 MED / 3 MAX, ground-spoiler arming. */
  thrOffset: number; autobrake: number; spoilersArmed: boolean;
  /** Rudder trim, -1 (full left, 20 units L) .. +1 (full right, 20 units R): a constant rudder offset set from the pedestal RUD TRIM knob. */
  rudTrim: number;
  /** Hydraulic brake authority 0..1 (Yellow system / accumulator, set by A320Systems) and FADEC thrust limit factor (engine / wing anti-ice and bleed penalties). */
  brakePress: number; thrLimit: number;
}
export const defaultControls = (): Controls => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, parking: true, reverse: false, speedbrake: 0, flapsIdx: 0, gearDown: true, trim: 0, assist: true, apHold: false, brakeL: 0, brakeR: 0, battery: true, mixture: 1, thrOffset: 0, rudTrim: 0, autobrake: 0, brakePress: 1, thrLimit: 1, spoilersArmed: false });

/** A320 slat/flap detents (0, 1, 2, 3, FULL) -> fraction of full-flap lift / drag. CONF 1 is slats only (little CL0, lots of CLmax). */
const FLAP_LIFT = [0, 0.12, 0.40, 0.62, 1], FLAP_DRAG = [0, 0.08, 0.30, 0.58, 1];
const tab = (t: number[], x: number) => { const f = clamp(x, 0, 1) * (t.length - 1), i = Math.min(t.length - 2, Math.floor(f)); return t[i] + (t[i + 1] - t[i]) * (f - i); };

export interface GearState { comp: number; fn: number; contact: boolean; skid: number; }
export interface ContactEvent { kind: 'touchdown' | 'hull' | 'gearbreak'; vs: number; speed: number; bank: number; pitch: number; point: Vector3; severity: number; }

const _v = new Vector3(), _v2 = new Vector3(), _v3 = new Vector3(), _q = new Quaternion(), _qi = new Quaternion();
const UP = new Vector3(0, 1, 0);
// Scratch objects for step() / helpers: the flight model runs ~120 times a second, so nothing may be allocated inside it (AGENTS.md §2C).
const _vb = new Vector3(), _dirV = new Vector3(), _Fb = new Vector3(), _lDir = new Vector3(), _tauB = new Vector3(), _torqueW = new Vector3();
const _rW = new Vector3(), _pw = new Vector3(), _velP = new Vector3(), _wv = new Vector3(), _latW = new Vector3(), _F = new Vector3(), _cr = new Vector3();
const _hv = new Vector3(), _f2 = new Vector3(), _acc = new Vector3(), _sf = new Vector3(), _atm: Atmosphere = { T: 0, rho: 0, p: 0, a: 0, sigma: 0 };
const AUTOBRAKE_DECEL = [0, 1.7, 3.0, 4.0];

export class FlightModel {
  pos = new Vector3(); vel = new Vector3(); quat = new Quaternion(); w = new Vector3(); // w: body angular velocity rad/s
  ctl = defaultControls();
  fuel: number; mass: number;
  gearPos = 1; flapsPos = 0; sbPos = 0;
  n = new Array<number>(2).fill(0.2); // engine spool 0..1 (normalised N1/RPM)
  /** Engine state: 0 = shut down, 1 = starting (starter engaged), 2 = running. `t` = seconds since starter engage. */
  eng: { state: 0 | 1 | 2; t: number }[] = [{ state: 2, t: 0 }, { state: 2, t: 0 }];
  /** Runway/taxiway surface friction multiplier (1 dry, ~0.55 wet, ~0.3 snow/ice) – from live weather. */
  friction = 1;
  /** Water depth proxy (0..1) for hydroplaning drag/loss of braking on a flooded runway. */
  wetness = 0;
  surf = { el: 0, ail: 0, rud: 0 };
  trimAuto = 0;
  gear: GearState[];
  onGround = true; wow = false; airborneTime = 0;
  // outputs for instruments / warnings
  alpha = 0; beta = 0; ias = 0; tas = 0; gs = 0; vs = 0; mach = 0; qbar = 0; nz = 1; nx = 0; ny = 0;
  pitch = 0; bank = 0; heading = 0; track = 0; rho = 1.225; stallWarn = false; stalled = false; alphaStall = 0.28;
  thrustN = 0; fuelFlow = 0; damage = 0; engineOut = false;
  wind = new Vector3(); turb = 0; gust = new Vector3();
  agl = 0; groundH = 0;
  events: ContactEvent[] = [];
  crashed = false; crashReason = '';
  private t = 0; private lastVsAir = 0;
  private gforce = new Vector3();

  constructor(public spec: AircraftSpec, public groundAt: (x: number, z: number) => number, fuelKg?: number) {
    this.fuel = fuelKg ?? spec.fuelCap;
    this.mass = spec.emptyMass + spec.payload + this.fuel;
    this.gear = spec.gear.map(() => ({ comp: 0, fn: 0, contact: false, skid: 0 }));
    // static load share from geometry so the aircraft sits level on its gear (CG between nose and mains)
    const nose = spec.gear.find((g) => g.nose)!, mains = spec.gear.filter((g) => !g.nose);
    const zm = mains.reduce((a, g) => a + g.pos[2], 0) / mains.length, zn = -nose.pos[2];
    const sn = zm / (zm + zn);
    this.share = spec.gear.map((g) => (g.nose ? sn : (1 - sn) / mains.length));
  }
  share: number[];

  get fuelFrac() { return this.fuel / this.spec.fuelCap; }
  get totalMass() { return this.spec.emptyMass + this.spec.payload + this.fuel; }
  forward(out = new Vector3()) { return out.set(0, 0, -1).applyQuaternion(this.quat); }

  /** Real start-up: starter engages (needs battery; piston needs mixture rich; fuel > 0). Returns a refusal reason or ''. */
  startEngine(i: number): string {
    const s = this.spec, e = this.eng[i]; if (!e) return 'No such engine';
    if (e.state !== 0) return e.state === 1 ? 'Engine already starting' : 'Engine already running';
    if (!this.ctl.battery) return 'Battery is OFF – no electrical power for the starter';
    if (this.fuel <= 0) return 'No fuel';
    if (s.kind === 'piston' && this.ctl.mixture < 0.3) return 'Mixture is lean – set the mixture rich before start';
    e.state = 1; e.t = 0; return '';
  }
  stopEngine(i: number) { const e = this.eng[i]; if (e) { e.state = 0; e.t = 0; } }
  get enginesRunning() { for (let i = 0; i < this.spec.engines; i++) if (this.eng[i].state !== 2) return false; return true; }
  get anyEngineRunning() { for (let i = 0; i < this.spec.engines; i++) if (this.eng[i].state === 2) return true; return false; }
  /** Place on ground (runway threshold / stand), heading in degrees true. `coldDark` = engines off, battery off, parking brake set. */
  placeOnRunway(x: number, z: number, hdg: number, groundY: number, coldDark = false) {
    const s = this.spec;
    const gy = s.gear[1].pos[1];
    this.quat.setFromAxisAngle(UP, -hdg * Math.PI / 180);
    this.pos.set(x, groundY - gy - 0.05, z);
    this.vel.set(0, 0, 0); this.w.set(0, 0, 0);
    this.ctl.parking = true; this.ctl.throttle = 0;
    this.n.fill(coldDark ? 0 : s.idle); this.gearPos = 1; this.ctl.gearDown = true;
    this.eng.forEach((e) => { e.state = coldDark ? 0 : 2; e.t = 0; });
    this.ctl.battery = !coldDark; this.ctl.mixture = coldDark && s.kind === 'piston' ? 0 : 1;
  }
  /** Spawn in stable flight. */
  placeAirborne(x: number, y: number, z: number, hdg: number, kt: number, flapsIdx = 0, gearDown = false) {
    const s = this.spec;
    this.quat.setFromAxisAngle(UP, -hdg * Math.PI / 180);
    this.pos.set(x, y, z);
    const v = kt * 0.514444;
    this.vel.set(0, 0, -v).applyQuaternion(this.quat);
    this.w.set(0, 0, 0);
    this.ctl.parking = false; this.ctl.flapsIdx = flapsIdx; this.flapsPos = flapsIdx / (s.flapDetents); this.ctl.gearDown = gearDown; this.gearPos = gearDown ? 1 : 0;
    this.ctl.throttle = 0.55; this.n.fill(0.55); this.onGround = false; this.airborneTime = 30;
    this.eng.forEach((e) => { e.state = 2; e.t = 0; }); this.ctl.battery = true; this.ctl.mixture = 1;
    // trim pitch to level flight: solve approx alpha
    const q = 0.5 * atmosphere(y).rho * v * v;
    const cl = this.totalMass * G / (q * s.S);
    const al = (cl - s.CL0 - s.flapCL * this.flapsPos) / s.CLa;
    this.quat.multiply(_q.setFromAxisAngle(new Vector3(1, 0, 0), al));
    this.vel.set(0, 0, -v).applyQuaternion(this.quat.clone().multiply(_q.setFromAxisAngle(new Vector3(1, 0, 0), -al)));
    this.trimAuto = clamp(-(s.Cm0 + s.Cma * al) / s.Cmde, -0.9, 0.9);
  }

  step(dt: number) {
    const s = this.spec, c = this.ctl;
    this.t += dt;
    const atm = atmosphere(this.pos.y, _atm);
    this.rho = atm.rho;

    // ---- config actuators ----
    const tgtFlap = c.flapsIdx / s.flapDetents;
    this.flapsPos += clamp(tgtFlap - this.flapsPos, -dt * 0.12, dt * 0.12);
    const gTgt = c.gearDown ? 1 : 0;
    if (s.fixedGear) { this.gearPos = 1; c.gearDown = true; } else this.gearPos += clamp(gTgt - this.gearPos, -dt / 6, dt / 6);
    // ground spoilers: armed + weight on wheels + idle thrust (or reversers) above 72 kt -> full extension automatically
    const gSpoil = c.spoilersArmed && this.wow && this.gs > 36 && (c.throttle < 0.12 || c.reverse) ? 1 : 0;
    if (!this.wow || this.gs < 20) this.autoSb = 0; else if (gSpoil) this.autoSb = 1;
    this.sbPos += clamp(Math.max(c.speedbrake, this.autoSb) - this.sbPos, -dt * 0.8, dt * 0.8);

    // ---- airmass-relative velocity ----
    const windNow = _v3.copy(this.wind).add(this.gust);
    const va = _v.copy(this.vel).sub(windNow);
    _qi.copy(this.quat).invert();
    const vb = _vb.copy(va).applyQuaternion(_qi);
    const V = Math.max(0.1, vb.length());
    const u = -vb.z;
    this.alpha = Math.atan2(-vb.y, Math.max(0.5, u));
    this.beta = Math.atan2(vb.x, Math.max(0.5, u));
    this.tas = V; this.ias = V * Math.sqrt(atm.sigma);
    this.qbar = 0.5 * atm.rho * V * V;
    this.mach = V / atm.a;
    const gvel = _v2.copy(this.vel); this.gs = Math.hypot(gvel.x, gvel.z); this.vs = this.vel.y;

    // attitude readouts
    const fwd = this.forward(_v2);
    this.pitch = Math.asin(clamp(fwd.y, -1, 1));
    const rightW = _v2.set(1, 0, 0).applyQuaternion(this.quat);
    const upW = _v3.set(0, 1, 0).applyQuaternion(this.quat);
    this.bank = Math.atan2(-rightW.y, upW.y); // + = right wing down
    const f2 = this.forward(_f2);
    this.heading = ((Math.atan2(f2.x, -f2.z) * 180 / Math.PI) + 360) % 360;
    this.track = this.gs > 1 ? ((Math.atan2(this.vel.x, -this.vel.z) * 180 / Math.PI) + 360) % 360 : this.heading;

    // ---- stall model ----
    const fl = this.flapsPos;
    const flL = s.kind === 'jet' ? tab(FLAP_LIFT, fl) : fl, flD = s.kind === 'jet' ? tab(FLAP_DRAG, fl) : fl;
    const CL0 = s.CL0 + s.flapCL * flL;
    const CLmaxE = s.CLmax + s.flapCL * fl * 1.05;
    // Real-world stall AoA: 15-18 degrees (0.26-0.31 rad)
    const aStall = Math.max(0.26, (CLmaxE - CL0) / s.CLa + 0.05 * fl);
    this.alphaStall = aStall;
    const aStallNeg = -(aStall * 0.8) - 0.04;
    const vStallRef = (fl > 0.3 ? s.vs0 : s.vs1) * 0.514444;
    this.stallWarn = this.airborneTime > 1.2 && !this.wow && (this.alpha > aStall * 0.92 || this.ias < vStallRef * 1.04);
    this.stalled = this.airborneTime > 1.2 && !this.wow && (this.alpha > aStall + 0.02 || this.ias < vStallRef * 0.95);

    // ---- flight control system ----
    let elevCmd: number, ailCmd: number, rudCmd: number;
    const pilotPitch = c.pitch, pilotRoll = c.roll;
    const aLim = aStall * 0.86;
    const prot = c.assist && this.alpha > aLim ? -(this.alpha - aLim) * 9 : 0; // soft alpha protection (assist)
    if (c.assist && s.kind === 'jet') {
      // ---- A320 NORMAL LAW: sidestick = load-factor / roll-rate demand, flight-path hold with stick neutral, auto-trim, protections ----
      const V = Math.max(60, this.tas), q = this.w.x, cb = Math.max(0.2, Math.cos(this.bank)), kias = this.ias / 0.514444;
      const nzMax = this.flapsPos > 0.05 ? 2.0 : 2.5;
      let qCmd = (G / V) * (pilotPitch > 0 ? pilotPitch * (nzMax - 1) : pilotPitch * 2) + (G * Math.tan(this.bank) * Math.sin(this.bank)) / V;
      const pitchDeg = this.pitch * 180 / Math.PI, pLim = this.flapsPos > 0.9 ? 25 : 30;
      if (pitchDeg > pLim && qCmd > 0) qCmd = -(pitchDeg - pLim) * 0.04;           // pitch attitude protection +30 / +25 (CONF FULL)
      if (pitchDeg < -15 && qCmd < 0) qCmd = (-15 - pitchDeg) * 0.04;               // −15
      const aProt = aStall * 0.84, aMax = aStall * 0.95;
      if (!this.wow && this.alpha > aProt) qCmd = Math.min(qCmd, -(this.alpha - aProt) * 2.5);  // alpha protection: stick back no longer raises alpha beyond alpha max
      if (this.alpha > aMax) qCmd = Math.min(qCmd, -0.15);
      const ovsp = Math.max(kias - (s.vne - 0), (this.mach - 0.82) * 300);
      if (ovsp > 0) qCmd = Math.max(qCmd, Math.min(0.1, ovsp * 0.004));            // high-speed protection: nose-up bias
      const err = qCmd - q;
      if (!this.wow) {
        if (Math.abs(pilotPitch) < 0.04 && !c.apHold) this.trimAuto = clamp(this.trimAuto + err * 0.9 * dt * 0.7, -0.95, 0.95);
        else this.trimAuto = clamp(this.trimAuto + err * 0.15 * dt, -0.95, 0.95);
      }
      elevCmd = this.trimAuto + err * 1.6 + c.trim * 0.3;
      const bankDeg = this.bank * 180 / Math.PI;
      let pCmd = pilotRoll * s.maxRollRate;                                           // roll-rate demand (≈15–20 °/s)
      if (!c.apHold && Math.abs(pilotRoll) < 0.03 && Math.abs(bankDeg) < 33) pCmd = -this.bank * 0.9; // neutral stick: wings level below 33°
      else if (!c.apHold && Math.abs(pilotRoll) < 0.03) pCmd = -(bankDeg - Math.sign(bankDeg) * 33) * Math.PI / 180 * 0.9; // beyond 33° return to 33°
      if (Math.abs(bankDeg) > 67 && Math.sign(pilotRoll) === Math.sign(bankDeg)) pCmd = 0; // bank angle protection 67°
      if (this.alpha > aMax) pCmd *= 0.5;
      ailCmd = (pCmd - (-this.w.z)) * 1.1 / cb;
      const rudLim = clamp(1 - (kias - 160) / 220, 0.25, 1);                           // rudder travel limiter
      rudCmd = c.yaw * rudLim + c.rudTrim * 0.3 + (this.wow ? (Math.abs(c.yaw) < 0.05 && this.gs > 3 ? clamp(this.w.y * 0.9, -0.5, 0.5) : 0) : clamp(this.beta * 7, -0.5, 0.5)); // yaw damper + turn coordination
    } else if (c.assist) {
      const sp = clamp(this.ias / (s.vs1 * 0.514 * 1.5), 0.55, 1.4);
      const qCmd = pilotPitch * s.maxPitchRate / Math.sqrt(sp);
      const q = this.w.x;
      const err = qCmd - q;
      if (!this.wow) {
        if (Math.abs(pilotPitch) < 0.04 && !c.apHold) this.trimAuto = clamp(this.trimAuto + err * 0.9 * dt * 0.7, -0.95, 0.95);
        else this.trimAuto = clamp(this.trimAuto + err * 0.15 * dt, -0.95, 0.95);
      }
      elevCmd = this.trimAuto + err * 1.6 + prot + c.trim * 0.3;
      const bankDeg = this.bank * 180 / Math.PI;
      let pCmd = pilotRoll * s.maxRollRate;
      if (!c.apHold && Math.abs(pilotRoll) < 0.03 && Math.abs(bankDeg) < 22) pCmd = -this.bank * 0.9;
      if (Math.abs(bankDeg) > 62 && Math.sign(pilotRoll) === Math.sign(bankDeg)) pCmd = 0;
      ailCmd = (pCmd - (-this.w.z)) * 1.1;
      rudCmd = c.yaw + c.rudTrim * 0.3 + (this.wow ? (Math.abs(c.yaw) < 0.05 && this.gs > 3 ? clamp(this.w.y * 0.9, -0.5, 0.5) : 0) : clamp(this.beta * 7, -0.5, 0.5));
    } else {
      elevCmd = pilotPitch + c.trim * 0.5 + (c.assist ? this.trimAuto * 0.7 + prot : 0);
      ailCmd = pilotRoll; rudCmd = c.yaw + c.rudTrim * 0.3;
    }
    // keep auto-trim sensible on ground
    if (this.wow && c.assist) this.trimAuto += (clamp(-(s.Cm0) / s.Cmde, -0.9, 0.9) * 0.5 - this.trimAuto) * dt * 0.8;
    elevCmd = clamp(elevCmd, -1, 1); ailCmd = clamp(ailCmd, -1, 1); rudCmd = clamp(rudCmd, -1, 1);
    this.surf.el += clamp(elevCmd - this.surf.el, -dt * 4, dt * 4);
    this.surf.ail += clamp(ailCmd - this.surf.ail, -dt * 5, dt * 5);
    this.surf.rud += clamp(rudCmd - this.surf.rud, -dt * 4, dt * 4);

    // ---- engines (real start-up sequence: OFF -> starter -> light-off -> idle -> running) ----
    let thrust = 0, ff = 0;
    const thrBase = this.fuel > 0 ? c.throttle : 0;
    const nEng = s.engines;
    let anyOut = false;
    for (let i = 0; i < nEng; i++) {
      const e = this.eng[i];
      if (this.fuel <= 0 && e.state !== 0) { e.state = 0; anyOut = true; }
      if (s.kind === 'piston' && e.state === 2 && c.mixture < 0.15) e.state = 0; // idle cut-off
      const thr = (i === 1 ? clamp(thrBase + c.thrOffset, 0, 1) : thrBase) * (s.kind === 'jet' ? c.thrLimit : 1);
      let tgt: number, tau: number;
      if (e.state === 1) {
        e.t += dt;
        const k = clamp(e.t / s.startSecs, 0, 1);
        // starter motoring to ~40% of idle, light-off at 45% of the sequence, then self-accelerating to idle
        const crank = Math.min(0.4, k / 0.45 * 0.4);
        const accel = k > 0.45 ? smoothstep(0.45, 1, k) : 0;
        this.n[i] = s.idle * (crank + (1 - 0.4) * accel);
        if (!c.battery && k < 0.45) { e.state = 0; e.t = 0; }
        if (k >= 1) { e.state = 2; e.t = 0; }
        tgt = this.n[i]; tau = 1e9;
      } else if (e.state === 2) {
        tgt = s.idle + (1 - s.idle) * thr; tau = tgt > this.n[i] ? s.spoolUp : s.spoolDown;
      } else {
        tgt = 0; tau = s.kind === 'jet' ? 9 : s.kind === 'turboprop' ? 7 : 1.2; // run-down
      }
      if (e.state !== 1) this.n[i] += (tgt - this.n[i]) * Math.min(1, dt / tau);
      const N = this.n[i];
      const run = e.state === 2 ? 1 : 0;
      const pf = clamp((N - s.idle) / (1 - s.idle), 0, 1); // power fraction
      let T = 0;
      if (run) {
        if (s.kind === 'jet') {
          const lapse = Math.pow(atm.sigma, 0.78) * (1 - 0.32 * Math.min(this.mach, 1)) ;
          const idleT = 0.05;
          T = (s.thrust / nEng) * lapse * (idleT + (1 - idleT) * Math.pow(pf, 1.25));
          if (c.reverse && this.wow) T = -(s.thrust / nEng) * 0.38 * Math.pow(pf, 1.2) * lapse;
        } else {
          const pw = (s.power / nEng) * (s.kind === 'piston' ? Math.max(0.1, (atm.sigma - 0.12) / 0.88) * clamp(0.35 + c.mixture * 0.65, 0.35, 1) : Math.pow(atm.sigma, 0.7)) * (0.06 + 0.94 * Math.pow(pf, 1.1));
          const Vp = Math.max(0, u);
          T = (s.propEff * pw) / Math.sqrt(Vp * Vp + s.staticV0 * s.staticV0);
          if (c.reverse && this.wow && s.hasReverse) T = -T * 0.55;
        }
      }
      thrust += T;
      const starting = e.state === 1 && e.t / s.startSecs > 0.45 ? 0.5 : 0;
      ff += s.fuelFlow * (0.08 + 0.92 * Math.pow(Math.max(N, 0.01), 1.4)) * (run ? 1 : starting) * (this.fuel > 0 ? 1 : 0) * (s.kind === 'jet' ? Math.max(0.55, atm.sigma + 0.3) : 1);
    }
    this.engineOut = this.fuel <= 0 || anyOut;
    this.thrustN = thrust; this.fuelFlow = ff;
    this.fuel = Math.max(0, this.fuel - ff * dt);
    const mass = this.totalMass; this.mass = mass;
    const inv = mass / (spec_ref_mass(s));

    // ---- aerodynamics (body frame) ----
    const dirV = _dirV.copy(vb).divideScalar(V);
    // lift coefficient with post-stall blending
    let CLlin = CL0 + s.CLa * this.alpha;
    let CL: number;
    const aPos = this.alpha >= 0;
    const aS = aPos ? aStall : aStallNeg;
    const aAbs = Math.abs(this.alpha), aSAbs = Math.abs(aS);
    if (aAbs < aSAbs - 0.03) CL = CLlin;
    else {
      const peak = CL0 + s.CLa * aS;
      const fp = (aPos ? 1 : -1) * 1.15 * Math.sin(2 * Math.min(aAbs, Math.PI / 2));
      const t = smoothstep(aSAbs - 0.03, aSAbs + 0.09, aAbs);
      const soft = aPos ? Math.min(CLlin, peak) : Math.max(CLlin, peak);
      CL = lerp(soft, fp * 0.95, t);
    }
    // ground effect
    const h = Math.max(0.5, this.agl);
    const ge = (16 * h / s.b) ** 2; const geF = ge / (1 + ge);
    const k = 1 / (Math.PI * s.e * (s.b * s.b / s.S));
    let CD = s.CD0 + k * geF * CL * CL + s.flapCD * flD + s.gearCD * this.gearPos + s.sbCD * this.sbPos + 0.45 * Math.sin(this.alpha) ** 2 * smoothstep(aSAbs * 0.9, aSAbs * 1.5, aAbs) + 0.6 * Math.sin(this.beta) ** 2;
    if (s.kind === 'jet' && this.mach > 0.78) CD += 0.12 * (this.mach - 0.78) ** 1.5 * 12;
    CD += (this.damage / 100) * 0.02;
    const qS = this.qbar * s.S;
    const Fb = _Fb.set(0, 0, 0);
    // drag along -dirV
    Fb.addScaledVector(dirV, -qS * CD);
    // lift perpendicular to velocity, in plane of body-up
    const lDir = _lDir.copy(UP).addScaledVector(dirV, -UP.dot(dirV));
    if (lDir.lengthSq() > 1e-6) { lDir.normalize(); Fb.addScaledVector(lDir, qS * CL); }
    // side force
    Fb.x += -qS * 0.9 * this.beta;
    // thrust (along -Z)
    Fb.z -= thrust;
    // ---- aerodynamic moments ----
    const Vm = Math.max(V, 20);
    let wash = 0;
    if (s.kind !== 'jet') wash = (Math.max(0, thrust) / s.S) * 0.9;
    const qCtl = this.qbar + wash;
    const effK = smoothstep(0, 6, V); // below a few m/s nothing works
    const p = -this.w.z, qrate = this.w.x, r = -this.w.y;
    const pHat = p * s.b / (2 * Vm), qHat = qrate * s.c / (2 * Vm), rHat = r * s.b / (2 * Vm);
    const Mpitch = qS * s.c * (s.Cm0 + s.Cma * this.alphaMoment(aStall) + s.Cmq * qHat) + qCtl * s.S * s.c * s.Cmde * this.surf.el * effK;
    const stallBuff = this.stalled ? Math.sin(this.t * 31) * 0.02 : 0;
    const Mroll = qS * s.b * (s.Clb * this.beta + s.Clp * pHat + 0.02 * rHat) + qCtl * s.S * s.b * s.Clda * this.surf.ail * effK * (this.stalled ? 0.35 : 1);
    const Myaw = qS * s.b * (s.Cnb * this.beta + s.Cnr * rHat) + qCtl * s.S * s.b * s.Cndr * this.surf.rud * effK * 0.9;
    // propeller torque / p-factor
    const pf = s.propTorque * (s.kind === 'jet' ? 0 : 1) * (this.n[0] - s.idle) * Math.max(0, 1 - V / 70) * (s.power / nEng) / 1000 * 0.35;
    // moments in body torque vector: x pitch-up+, z roll-right negative, y yaw-left positive
    const tau = _tauB.set(Mpitch + stallBuff * qS * s.c, -(Myaw) + pf * 0.2, -(Mroll) + pf * 0.15);

    // ---- world-frame force accumulation ----
    const Fw = Fb.applyQuaternion(this.quat);
    const torqueW = _torqueW.set(0, 0, 0); // from gear, in world frame
    Fw.y -= mass * G;
    // turbulence/gust updated externally into this.gust

    // ---- landing gear + ground ----
    this.groundH = this.groundAt(this.pos.x, this.pos.z);
    this.agl = this.pos.y + s.gear[1].pos[1] - this.groundH;
    let anyContact = false, maxFn = 0;
    let steer = 0;
    if (this.wow || this.agl < 4) steer = (c.yaw + (c.assist && Math.abs(c.yaw) < 0.05 && this.gs > 3 ? clamp(this.w.y * 0.6, -0.3, 0.3) : 0)) * s.maxSteer * (1 - smoothstep(8, 40, this.gs));
    // autobrake: decel target LO 1.7 / MED 3.0 / MAX 4.0 m/s² once the ground spoilers are out; pedals above 30 % disarm it
    let abBrake = 0;
    if (c.autobrake > 0 && this.wow && this.autoSb > 0 && this.gs > 6 && c.brake < 0.3) {
      const tgt = AUTOBRAKE_DECEL[Math.min(3, c.autobrake)];
      this.autoBrk = clamp(this.autoBrk + (tgt - (-this.nx * G)) * 0.22 * dt, 0, 1);
      abBrake = this.autoBrk;
    } else { this.autoBrk = 0; if (c.brake >= 0.3) c.autobrake = 0; }
    const brakeIn = c.parking ? 1 : Math.max(c.brake, abBrake) * c.brakePress; // no Yellow pressure / accumulator -> no wheel braking (parking brake still holds)
    const gearActive = this.gearPos > 0.9;
    for (let i = 0; i < s.gear.length; i++) {
      const g = s.gear[i], st = this.gear[i];
      st.contact = false; st.fn = 0;
      if (!gearActive) { st.comp = 0; continue; }
      const rW = _rW.set(g.pos[0], g.pos[1], g.pos[2]).applyQuaternion(this.quat);
      const pw = _pw.copy(this.pos).add(rW);
      const gh = this.groundAt(pw.x, pw.z);
      const pen = gh - pw.y;
      if (pen <= 0) { st.comp = lerp(st.comp, 0, 0.3); continue; }
      const velP = _velP.copy(this.vel).add(_wv.copy(this.w).applyQuaternion(this.quat).cross(rW));
      const staticComp = Math.max(0.06, s.gearTravel * 0.45); // static oleo / spring deflection
      const gsh = this.share[i];
      const kSpring = (mass * G * gsh) / staticComp;
      const mEff = mass * gsh;
      const dDamp = 2 * 0.55 * Math.sqrt(kSpring * mEff);
      const compC = Math.min(pen, s.gearTravel);
      let Fn = kSpring * compC + (pen > s.gearTravel ? kSpring * 6 * (pen - s.gearTravel) : 0);
      const cdot = -velP.y;
      Fn += dDamp * clamp(cdot, -2, 8) * (cdot > 0 ? 1 : 0.5);
      Fn = Math.max(0, Fn);
      st.comp = compC; st.fn = Fn; st.contact = true; anyContact = true; maxFn = Math.max(maxFn, Fn);
      // tyre friction
      const fwdW = _v.set(0, 0, -1).applyQuaternion(this.quat); fwdW.y = 0; if (fwdW.lengthSq() < 1e-4) fwdW.set(0, 0, -1); fwdW.normalize();
      if (g.nose && steer) fwdW.applyAxisAngle(UP, -steer);
      const latW = _latW.crossVectors(UP, fwdW).multiplyScalar(-1); // right-ish
      const vl = velP.dot(fwdW), vt = velP.dot(latW);
      const brk = g.nose ? 0 : clamp(brakeIn + (g.pos[0] > 0 ? c.brakeR : c.brakeL), 0, 1);
      const rollRes = 0.015 + Math.min(0.012, 0.0008 * Math.abs(vl)) + brk * 0.45 * this.friction * (1 - 0.5 * this.wetness);
      const FL = -Fn * rollRes * Math.tanh(vl * 2.5);
      const lim = Fn * (g.nose ? 0.75 : 0.95) * this.friction;
      let FT = -Fn * (g.nose ? 0.9 : 1.0) * Math.tanh(vt * 2.2);
      FT = clamp(FT, -lim, lim);
      st.skid = Math.abs(vt) > 3 ? 1 : 0;
      const F = _F.set(0, Fn, 0).addScaledVector(fwdW, FL).addScaledVector(latW, FT);
      Fw.add(F);
      torqueW.add(_cr.crossVectors(rW, F));
      // touchdown event
      if (!this.wow && this.airborneTime > 1.5 && !this._tdFlag) {
        this._tdFlag = true;
        this.events.push({ kind: 'touchdown', vs: this.lastVsAir, speed: this.gs, bank: this.bank, pitch: this.pitch, point: pw.clone(), severity: Math.abs(this.lastVsAir) / s.maxSink });
        if (-this.lastVsAir > s.maxSink * 2.6 && this.gearPos > 0.9) { this.events.push({ kind: 'gearbreak', vs: this.lastVsAir, speed: this.gs, bank: this.bank, pitch: this.pitch, point: pw.clone(), severity: 2 }); }
      }
    }
    this.wow = anyContact;
    if (!anyContact) { this.airborneTime += dt; this.lastVsAir = this.vel.y; if (this.agl > 2) this._tdFlag = false; }
    else if (this.wow) { this.airborneTime = 0; }
    // parking brake stiction
    if (this.wow && c.parking && this.gs < 1.2 && thrust < s.thrust * 0.3 + s.power * 0.00002 && Math.abs(c.throttle) < 0.45) {
      this.vel.x *= 0.9; this.vel.z *= 0.9;
    }

    // ---- hull contacts (belly, tail, wing tips...) ----
    for (let hi = 0; hi < s.hull.length; hi++) {
      const hp = s.hull[hi];
      const rW = _rW.set(hp[0], hp[1], hp[2]).applyQuaternion(this.quat);
      const pw = _pw.copy(this.pos).add(rW);
      const gh = this.groundAt(pw.x, pw.z);
      const pen = gh - pw.y;
      if (pen > 0) {
        const sp = this.vel.length();
        const vN = -this.vel.y;
        // scrape: strong friction + normal push
        const Fn = clamp(pen * mass * 12 + Math.max(0, vN) * mass * 6, 0, mass * G * 3);
        const F = _F.set(0, Fn, 0);
        const hv = _hv.set(this.vel.x, 0, this.vel.z);
        F.addScaledVector(hv.normalize(), -Math.min(Fn * 0.6, mass * 6));
        Fw.add(F); torqueW.add(_cr.crossVectors(rW, F));
        const sev = Math.max(vN, 0) + sp * 0.05;
        this.damage += dt * (sp > 3 ? 20 + sp : 0) + Math.max(0, vN - 2) * 12;
        this.events.push({ kind: 'hull', vs: -vN, speed: sp, bank: this.bank, pitch: this.pitch, point: pw.clone(), severity: sev });
        if ((vN > 9 || sp > 55 && vN > 5 || this.damage >= 100) && !this.crashed) { this.crashed = true; this.crashReason = vN > 9 || sp > 55 ? 'Impact with terrain' : 'Aircraft destroyed by ground contact'; }
      }
    }

    // ---- integrate ----
    const acc = _acc.copy(Fw).divideScalar(mass);
    this.gforce.copy(acc); this.gforce.y += G; // specific force (world)
    const sf = _sf.copy(this.gforce).applyQuaternion(_qi.copy(this.quat).invert());
    this.nz = sf.y / G; this.nx = -sf.z / G; this.ny = sf.x / G;
    this.vel.addScaledVector(acc, dt);
    // torque -> body
    const tB = torqueW.applyQuaternion(_qi.copy(this.quat).invert()).add(tau);
    // I axis mapping: body X = pitch axis (Iyy), Y = yaw axis (Izz), Z = roll axis (Ixx)
    const ibx = s.Iyy * inv, iby = s.Izz * inv, ibz = s.Ixx * inv;
    const iwx = ibx * this.w.x, iwy = iby * this.w.y, iwz = ibz * this.w.z;
    const gyx = this.w.y * iwz - this.w.z * iwy, gyy = this.w.z * iwx - this.w.x * iwz, gyz = this.w.x * iwy - this.w.y * iwx; // w × (I·w)
    this.w.x += ((tB.x - gyx) / ibx) * dt;
    this.w.y += ((tB.y - gyy) / iby) * dt;
    this.w.z += ((tB.z - gyz) / ibz) * dt;
    // ground damping to avoid numeric jitter at rest
    if (this.wow && this.gs < 2) this.w.multiplyScalar(1 - Math.min(0.5, dt * 3));
    this.w.clampLength(0, 6);
    const wl = this.w.length();
    if (wl > 1e-6) this.quat.multiply(_q.setFromAxisAngle(_v.copy(this.w).divideScalar(wl), wl * dt));
    this.quat.normalize();
    this.pos.addScaledVector(this.vel, dt);
    if (this.vel.lengthSq() > 450 * 450) this.vel.setLength(450);
    // harsh failure: ground collision destruction at huge speed handled above
  }
  _tdFlag = false; autoSb = 0; autoBrk = 0;

  private alphaMoment(aStall: number) {
    // linear restoring moment up to stall, then weakens (nose-drop tendency retained)
    const a = this.alpha;
    if (a > aStall) return aStall - (a - aStall) * 0.6;
    return a;
  }

  /** Remaining headroom to V-speeds etc. used by warnings. */
  limits(out: { kias: number; overspeed: boolean; flapOver: boolean; gearOver: boolean; flapLim: number } = { kias: 0, overspeed: false, flapOver: false, gearOver: false, flapLim: 0 }) {
    const s = this.spec;
    const kias = this.ias / 0.514444;
    out.kias = kias;
    out.flapLim = s.vfe[Math.min(s.vfe.length - 1, this.ctl.flapsIdx)];
    out.overspeed = kias > s.vne || (s.kind === 'jet' && this.mach > 0.82);
    out.flapOver = this.flapsPos > 0.05 && kias > s.vfe[Math.min(s.vfe.length - 1, Math.max(1, Math.ceil(this.flapsPos * s.flapDetents)))] + 6;
    out.gearOver = this.gearPos > 0.02 && kias > s.vle + 5 && !this.wow;
    return out;
  }
}
function spec_ref_mass(s: AircraftSpec) { return s.emptyMass + s.payload + s.fuelCap * 0.6; }
void wrap180;
