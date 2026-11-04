// 6-DOF rigid-body flight model. Body frame: +X right, +Y up, -Z forward. World: +X east, +Y up, -Z north.
import { Vector3, Quaternion } from 'three';
import { AircraftSpec } from './specs';
import { clamp, lerp, smoothstep, wrap180 } from './geo';

export const G = 9.80665;
export function atmosphere(h: number) {
  const hh = Math.max(-300, h);
  const T = hh < 11000 ? 288.15 - 0.0065 * hh : 216.65;
  const rho = hh < 11000 ? 1.225 * Math.pow(T / 288.15, 4.2559) : 0.3639 * Math.exp(-(hh - 11000) / 6342);
  return { T, rho, a: Math.sqrt(1.4 * 287.05 * T), sigma: rho / 1.225 };
}

export interface Controls {
  pitch: number; roll: number; yaw: number; // pilot demand -1..1 (pitch +1 = pull back / nose up, roll +1 = right, yaw +1 = right)
  throttle: number; brake: number; parking: boolean; reverse: boolean; speedbrake: number;
  flapsIdx: number; gearDown: boolean; trim: number; assist: boolean; apHold: boolean;
}
export const defaultControls = (): Controls => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, parking: true, reverse: false, speedbrake: 0, flapsIdx: 0, gearDown: true, trim: 0, assist: true, apHold: false });

export interface GearState { comp: number; fn: number; contact: boolean; skid: number; }
export interface ContactEvent { kind: 'touchdown' | 'hull' | 'gearbreak'; vs: number; speed: number; bank: number; pitch: number; point: Vector3; severity: number; }

const _v = new Vector3(), _v2 = new Vector3(), _v3 = new Vector3(), _q = new Quaternion(), _qi = new Quaternion();
const UP = new Vector3(0, 1, 0);

export class FlightModel {
  pos = new Vector3(); vel = new Vector3(); quat = new Quaternion(); w = new Vector3(); // w: body angular velocity rad/s
  ctl = defaultControls();
  fuel: number; mass: number;
  gearPos = 1; flapsPos = 0; sbPos = 0;
  n = new Array<number>(2).fill(0.2); // engine spool 0..1 (normalised N1/RPM)
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
  private t = 0; private lastVsAir = 0; private prevAccel = new Vector3();
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

  /** Place on ground at a runway threshold, heading in degrees true. */
  placeOnRunway(x: number, z: number, hdg: number, groundY: number) {
    const s = this.spec;
    const gy = s.gear[1].pos[1];
    this.quat.setFromAxisAngle(UP, -hdg * Math.PI / 180);
    this.pos.set(x, groundY - gy - 0.05, z);
    this.vel.set(0, 0, 0); this.w.set(0, 0, 0);
    this.ctl.parking = true; this.ctl.throttle = 0;
    this.n.fill(s.idle); this.gearPos = 1; this.ctl.gearDown = true;
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
    const atm = atmosphere(this.pos.y);
    this.rho = atm.rho;

    // ---- config actuators ----
    const tgtFlap = c.flapsIdx / s.flapDetents;
    this.flapsPos += clamp(tgtFlap - this.flapsPos, -dt * 0.12, dt * 0.12);
    const gTgt = c.gearDown ? 1 : 0;
    this.gearPos += clamp(gTgt - this.gearPos, -dt / 6, dt / 6);
    this.sbPos += clamp(c.speedbrake - this.sbPos, -dt * 0.8, dt * 0.8);

    // ---- airmass-relative velocity ----
    const windNow = _v3.copy(this.wind).add(this.gust);
    const va = _v.copy(this.vel).sub(windNow);
    _qi.copy(this.quat).invert();
    const vb = va.clone().applyQuaternion(_qi);
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
    const f2 = this.forward(new Vector3());
    this.heading = ((Math.atan2(f2.x, -f2.z) * 180 / Math.PI) + 360) % 360;
    this.track = this.gs > 1 ? ((Math.atan2(this.vel.x, -this.vel.z) * 180 / Math.PI) + 360) % 360 : this.heading;

    // ---- stall model ----
    const fl = this.flapsPos;
    const CL0 = s.CL0 + s.flapCL * fl;
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
    if (c.assist) {
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
      rudCmd = c.yaw + (this.wow ? 0 : clamp(this.beta * 7, -0.5, 0.5));
    } else {
      elevCmd = pilotPitch + c.trim * 0.5 + (c.assist ? this.trimAuto * 0.7 + prot : 0);
      ailCmd = pilotRoll; rudCmd = c.yaw;
    }
    // keep auto-trim sensible on ground
    if (this.wow && c.assist) this.trimAuto += (clamp(-(s.Cm0) / s.Cmde, -0.9, 0.9) * 0.5 - this.trimAuto) * dt * 0.8;
    elevCmd = clamp(elevCmd, -1, 1); ailCmd = clamp(ailCmd, -1, 1); rudCmd = clamp(rudCmd, -1, 1);
    this.surf.el += clamp(elevCmd - this.surf.el, -dt * 4, dt * 4);
    this.surf.ail += clamp(ailCmd - this.surf.ail, -dt * 5, dt * 5);
    this.surf.rud += clamp(rudCmd - this.surf.rud, -dt * 4, dt * 4);

    // ---- engines ----
    let thrust = 0, ff = 0;
    const thr = this.fuel > 0 ? c.throttle : 0;
    this.engineOut = this.fuel <= 0;
    const nEng = s.engines;
    for (let i = 0; i < nEng; i++) {
      const tgt = this.fuel > 0 ? s.idle + (1 - s.idle) * thr : 0;
      const tau = tgt > this.n[i] ? s.spoolUp : s.spoolDown;
      this.n[i] += (tgt - this.n[i]) * Math.min(1, dt / tau);
      const N = this.n[i];
      const pf = clamp((N - s.idle) / (1 - s.idle), 0, 1); // power fraction
      let T = 0;
      if (s.kind === 'jet') {
        const lapse = Math.pow(atm.sigma, 0.78) * (1 - 0.32 * Math.min(this.mach, 1)) ;
        const idleT = 0.035;
        T = (s.thrust / nEng) * lapse * (idleT + (1 - idleT) * Math.pow(pf, 1.25));
        if (c.reverse && this.wow) T = -(s.thrust / nEng) * 0.38 * Math.pow(pf, 1.2) * lapse - 0;
      } else {
        const pw = (s.power / nEng) * (s.kind === 'piston' ? Math.max(0.1, (atm.sigma - 0.12) / 0.88) : Math.pow(atm.sigma, 0.7)) * (0.06 + 0.94 * Math.pow(pf, 1.1));
        const Vp = Math.max(0, u);
        T = (s.propEff * pw) / Math.sqrt(Vp * Vp + s.staticV0 * s.staticV0);
        if (s.kind === 'turboprop' && Vp < 5) T *= 1;
        if (c.reverse && this.wow && s.hasReverse) T = -T * 0.55;
      }
      thrust += T;
      ff += s.fuelFlow * (0.08 + 0.92 * Math.pow(Math.max(N, 0.01), 1.4)) * (this.fuel > 0 ? 1 : 0) * (s.kind === 'jet' ? Math.max(0.55, atm.sigma + 0.3) : 1);
    }
    this.thrustN = thrust; this.fuelFlow = ff;
    this.fuel = Math.max(0, this.fuel - ff * dt);
    const mass = this.totalMass; this.mass = mass;
    const inv = mass / (spec_ref_mass(s));

    // ---- aerodynamics (body frame) ----
    const dirV = vb.clone().divideScalar(V);
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
    let CD = s.CD0 + k * geF * CL * CL + s.flapCD * fl + s.gearCD * this.gearPos + s.sbCD * this.sbPos + 0.45 * Math.sin(this.alpha) ** 2 * smoothstep(aSAbs * 0.9, aSAbs * 1.5, aAbs) + 0.6 * Math.sin(this.beta) ** 2;
    if (s.kind === 'jet' && this.mach > 0.78) CD += 0.12 * (this.mach - 0.78) ** 1.5 * 12;
    CD += (this.damage / 100) * 0.02;
    const qS = this.qbar * s.S;
    const Fb = new Vector3();
    // drag along -dirV
    Fb.addScaledVector(dirV, -qS * CD);
    // lift perpendicular to velocity, in plane of body-up
    const up = new Vector3(0, 1, 0);
    const lDir = up.clone().addScaledVector(dirV, -up.dot(dirV));
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
    const Mroll = qS * s.b * (s.Clb * this.beta + s.Clp * pHat + 0.05 * rHat * 0 + 0.02 * rHat) + qCtl * s.S * s.b * s.Clda * this.surf.ail * effK * (this.stalled ? 0.35 : 1);
    const Myaw = qS * s.b * (s.Cnb * this.beta + s.Cnr * rHat) + qCtl * s.S * s.b * s.Cndr * this.surf.rud * effK * 0.9;
    // propeller torque / p-factor
    const pf = s.propTorque * (s.kind === 'jet' ? 0 : 1) * (this.n[0] - s.idle) * Math.max(0, 1 - V / 70) * (s.power / nEng) / 1000 * 0.35;
    // moments in body torque vector: x pitch-up+, z roll-right negative, y yaw-left positive
    const tau = new Vector3(Mpitch + stallBuff * qS * s.c, -(Myaw) + pf * 0.2, -(Mroll) + pf * 0.15);

    // ---- world-frame force accumulation ----
    const Fw = Fb.applyQuaternion(this.quat);
    const torqueW = new Vector3(); // from gear, in world frame
    Fw.y -= mass * G;
    // turbulence/gust updated externally into this.gust

    // ---- landing gear + ground ----
    this.groundH = this.groundAt(this.pos.x, this.pos.z);
    this.agl = this.pos.y + s.gear[1].pos[1] - this.groundH;
    let anyContact = false, maxFn = 0;
    let steer = 0;
    if (this.wow || this.agl < 4) steer = c.yaw * s.maxSteer * (1 - smoothstep(6, 45, this.gs)) ;
    const brakeIn = c.parking ? 1 : c.brake;
    const gearActive = this.gearPos > 0.9;
    s.gear.forEach((g, i) => {
      const st = this.gear[i];
      st.contact = false; st.fn = 0;
      if (!gearActive) { st.comp = 0; return; }
      const rLocal = _v2.set(g.pos[0], g.pos[1], g.pos[2]);
      const rW = rLocal.clone().applyQuaternion(this.quat);
      const pw = this.pos.clone().add(rW);
      const gh = this.groundAt(pw.x, pw.z);
      const pen = gh - pw.y;
      if (pen <= 0) { st.comp = lerp(st.comp, 0, 0.3); return; }
      const velP = this.vel.clone().add(new Vector3().copy(this.w).applyQuaternion(this.quat).cross(rW));
      const staticComp = 0.22 * (s.gearTravel / 0.35 > 1 ? 1.2 : 1);
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
      const latW = new Vector3().crossVectors(UP, fwdW).multiplyScalar(-1); // right-ish
      const vl = velP.dot(fwdW), vt = velP.dot(latW);
      const brk = g.nose ? 0 : brakeIn;
      const rollRes = 0.017 + brk * 0.52;
      const FL = -Fn * rollRes * Math.tanh(vl * 2.5);
      const lim = Fn * (g.nose ? 0.75 : 0.95);
      let FT = -Fn * (g.nose ? 0.9 : 1.0) * Math.tanh(vt * 2.2);
      FT = clamp(FT, -lim, lim);
      st.skid = Math.abs(vt) > 3 ? 1 : 0;
      const F = new Vector3(0, Fn, 0).addScaledVector(fwdW, FL).addScaledVector(latW, FT);
      Fw.add(F);
      torqueW.add(new Vector3().crossVectors(rW, F));
      // touchdown event
      if (!this.wow && this.airborneTime > 1.5 && !this._tdFlag) {
        this._tdFlag = true;
        this.events.push({ kind: 'touchdown', vs: this.lastVsAir, speed: this.gs, bank: this.bank, pitch: this.pitch, point: pw, severity: Math.abs(this.lastVsAir) / s.maxSink });
        if (-this.lastVsAir > s.maxSink * 2.6 && this.gearPos > 0.9) { this.events.push({ kind: 'gearbreak', vs: this.lastVsAir, speed: this.gs, bank: this.bank, pitch: this.pitch, point: pw, severity: 2 }); }
      }
    });
    this.wow = anyContact;
    if (!anyContact) { this.airborneTime += dt; this.lastVsAir = this.vel.y; if (this.agl > 2) this._tdFlag = false; }
    else if (this.wow) { this.airborneTime = 0; }
    // parking brake stiction
    if (this.wow && c.parking && this.gs < 1.2 && thrust < s.thrust * 0.3 + s.power * 0.00002 + 1e9 * 0 && Math.abs(c.throttle) < 0.45) {
      this.vel.x *= 0.9; this.vel.z *= 0.9;
    }

    // ---- hull contacts (belly, tail, wing tips...) ----
    for (const hp of s.hull) {
      const rW = _v2.set(hp[0], hp[1], hp[2]).applyQuaternion(this.quat);
      const pw = this.pos.clone().add(rW);
      const gh = this.groundAt(pw.x, pw.z);
      const pen = gh - pw.y;
      if (pen > 0) {
        const sp = this.vel.length();
        const vN = -this.vel.y;
        // scrape: strong friction + normal push
        const Fn = clamp(pen * mass * 12 + Math.max(0, vN) * mass * 6, 0, mass * G * 3);
        const F = new Vector3(0, Fn, 0);
        const hv = new Vector3(this.vel.x, 0, this.vel.z);
        F.addScaledVector(hv.normalize(), -Math.min(Fn * 0.6, mass * 6));
        Fw.add(F); torqueW.add(new Vector3().crossVectors(rW, F));
        const sev = Math.max(vN, 0) + sp * 0.05;
        this.damage += dt * (sp > 3 ? 20 + sp : 0) + Math.max(0, vN - 2) * 12;
        this.events.push({ kind: 'hull', vs: -vN, speed: sp, bank: this.bank, pitch: this.pitch, point: pw, severity: sev });
        if ((vN > 9 || sp > 55 && vN > 5 || this.damage >= 100) && !this.crashed) { this.crashed = true; this.crashReason = vN > 9 || sp > 55 ? 'Impact with terrain' : 'Aircraft destroyed by ground contact'; }
      }
    }

    // ---- integrate ----
    const acc = Fw.clone().divideScalar(mass);
    this.gforce.copy(acc); this.gforce.y += G; // specific force (world)
    const sf = this.gforce.clone().applyQuaternion(_qi.copy(this.quat).invert());
    this.nz = sf.y / G; this.nx = -sf.z / G; this.ny = sf.x / G;
    this.vel.addScaledVector(acc, dt);
    // torque -> body
    const tB = torqueW.applyQuaternion(_qi.copy(this.quat).invert()).add(tau);
    // I axis mapping: body X = pitch axis (Iyy), Y = yaw axis (Izz), Z = roll axis (Ixx)
    const Ib = new Vector3(s.Iyy * inv, s.Izz * inv, s.Ixx * inv);
    const Iw = new Vector3(Ib.x * this.w.x, Ib.y * this.w.y, Ib.z * this.w.z);
    const gyro = new Vector3().crossVectors(this.w, Iw);
    this.w.x += ((tB.x - gyro.x) / Ib.x) * dt;
    this.w.y += ((tB.y - gyro.y) / Ib.y) * dt;
    this.w.z += ((tB.z - gyro.z) / Ib.z) * dt;
    // ground damping to avoid numeric jitter at rest
    if (this.wow && this.gs < 2) this.w.multiplyScalar(1 - Math.min(0.5, dt * 3));
    this.w.clampLength(0, 6);
    const wl = this.w.length();
    if (wl > 1e-6) this.quat.multiply(_q.setFromAxisAngle(_v.copy(this.w).divideScalar(wl), wl * dt));
    this.quat.normalize();
    this.pos.addScaledVector(this.vel, dt);
    if (this.vel.lengthSq() > 450 * 450) this.vel.setLength(450);
    this.prevAccel.copy(acc);
    // harsh failure: ground collision destruction at huge speed handled above
  }
  _tdFlag = false;

  private alphaMoment(aStall: number) {
    // linear restoring moment up to stall, then weakens (nose-drop tendency retained)
    const a = this.alpha;
    if (a > aStall) return aStall - (a - aStall) * 0.6;
    return a;
  }

  /** Remaining headroom to V-speeds etc. used by warnings. */
  limits() {
    const s = this.spec;
    const kias = this.ias / 0.514444;
    const flapLim = s.vfe[Math.min(s.vfe.length - 1, this.ctl.flapsIdx)];
    return { kias, overspeed: kias > s.vne || (s.kind === 'jet' && this.mach > 0.82), flapOver: this.flapsPos > 0.05 && kias > s.vfe[Math.min(s.vfe.length - 1, Math.max(1, Math.ceil(this.flapsPos * s.flapDetents)))] + 6, gearOver: this.gearPos > 0.02 && kias > s.vle + 5 && !this.wow, flapLim };
  }
}
function spec_ref_mass(s: AircraftSpec) { return s.emptyMass + s.payload + s.fuelCap * 0.6; }
void wrap180;
