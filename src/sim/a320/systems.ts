// A320 aircraft-systems state behind the flight-deck switches: electrics, APU, bleed/packs, hydraulics, fuel, pressurisation,
// engine start logic (ENG MODE + ENG MASTER), autobrake / ground spoilers and the cockpit "switch board".
import type { FlightModel } from '../physics';
import type { PanelData } from '../instruments';
import { airState } from '../physics';
import { Ecam } from './ecam';

export interface CockpitHost {
  fm: FlightModel;
  ap: { on: boolean; nav: boolean; appr: boolean; hdg: number; altFt: number; spd: number; altSelected?: boolean; spdSelected?: boolean; vsHoldFpm?: number | null; expedite?: boolean; vsLimit?: number };
  lights: { nav: boolean; strobe: boolean; land: boolean; beacon: boolean };
  seatbelt: boolean;
  action(id: string): void;
  setApTarget(t: 'hdg' | 'alt' | 'spd', v: number): void;
  toast(msg: string, kind?: 'info' | 'warn' | 'good'): void;
  route(): { name: string; lat: number; lon: number }[];
  /** Fix the active leg starts from (null on the first leg): lets the ND draw the LEG the autopilot flies, not just a line to the TO fix. */
  legFrom?(): { lat: number; lon: number } | null;
  position(): { lat: number; lon: number };
  /** MCDU DIR TO: make route waypoint `routeIndex` (0 = the current TO fix, as listed by route()) the active leg. Returns false when it does not exist. */
  directTo?(routeIndex: number): boolean;
  magVar(hdg: number): number;
  /** Live flight data for the captain's EFB tablet. */
  efbInfo?(): import('./efb').EfbInfo | null;
  /** Terrain elevation (ft AMSL) under a lat/lon – feeds the TERR ON ND overlay. */
  terrainFt?(lat: number, lon: number): number;
}

export type EcamPage = 'ENG' | 'BLEED' | 'PRESS' | 'ELEC' | 'HYD' | 'FUEL' | 'APU' | 'COND' | 'DOOR' | 'WHEEL' | 'F/CTL' | 'STS' | 'CRZ';
const KG_PER_FT_NONE = 0;
void KG_PER_FT_NONE;

export const HPA_PER_INHG = 33.8639;
export const ND_MODE_NAMES = ['LS', 'VOR', 'NAV', 'ARC', 'PLAN'] as const;
export const ND_RANGES = [10, 20, 40, 80, 160, 320] as const;
export type NdOpt = 'cstr' | 'wpt' | 'vord' | 'ndb' | 'arpt';
/** One EFIS control panel (glareshield). nav: ADF(-1) / OFF(0) / VOR(1) for bearing pointers 1 and 2. */
export interface EfisState {
  fd: boolean; ls: boolean; std: boolean; hpa: number; inHg: number; unitInHg: boolean;
  ndMode: number; ndRange: number; opt: NdOpt | null; nav: [number, number]; xfr: boolean;
}
const newEfis = (): EfisState => ({ fd: true, ls: false, std: false, hpa: 1013, inHg: 2992, unitInHg: false, ndMode: 3, ndRange: 3, opt: null, nav: [0, 0], xfr: false });

export class A320Systems {
  // ---- generic switch board: position per control name (see controls.ts for meaning) ----
  sw: Record<string, number> = {};
  // ---- electrics ----
  bat = [true, true]; ext = false; apuGen = true; gen = [true, true];
  dc = false; ac = false; acEss = false; batV = [27.6, 27.6];
  // ---- APU ----
  apuMaster = false; apuStart = false; apuRpm = 0; apuBleed = false; apuEgt = 0;
  // ---- bleed / air ----
  engBleed = [true, true]; packs = [true, true]; xbleed = 1; bleedPsi = [0, 0]; wingAI = false; engAI = [false, false];
  cabAltFt = 0; cabVs = 0; deltaP = 0; outflow = 0; cabTemp = 22;
  // ---- hydraulics ----
  hydPump = { green: true, yellow: true, blue: true, yElec: false, ptu: true };
  hyd = { green: 0, yellow: 0, blue: 0 }; accumPsi = 0; ratOut = false;
  // ---- fuel ----
  pumps = [true, true, true, true, true, true]; xfeed = false; fuelMode = true;
  // ---- fire protection: FIRE pb released (out) per ENG 1 / ENG 2 / APU, extinguisher agents discharged (ENG1 A1,A2 · ENG2 A1,A2 · APU A1), ELT switch ----
  fireOut = [false, false, false]; agentDisch = [false, false, false, false, false]; elt = false;
  tank = { l: 0, c: 0, r: 0 };
  // ---- engines ----
  engMode: 0 | 1 | 2 = 1; // 0 CRANK, 1 NORM, 2 IGN/START
  master = [false, false]; n2 = [0, 0]; egt = [0, 0]; ff = [0, 0]; oilPsi = [0, 0]; oilQty = [14, 14]; vib = [0, 0]; ignA = [false, false];
  // ---- flight deck ----
  autobrake = 0 as 0 | 1 | 2 | 3; spoilerArm = false; antiSkid = true; nwStrg = true;
  gpws = { sys: true, gs: true, flap: true, terr: true };
  /** ECAM control panel state machine (page keys, ALL / STS / CLR / RCL / EMER CANC / T.O CONFIG) – see ecam.ts. */
  ecam = new Ecam(this);
  /** Page selected with an ECP key (null = automatic) – a view on the ECAM state. */
  get page(): EcamPage | null { return this.ecam.manual; }
  set page(p: EcamPage | null) { this.ecam.manual = p; }
  pageAuto: EcamPage = 'DOOR'; lampTest = 0;
  /** The page the lower ECAM really shows (ECP selection > failure page > flight-phase page). */
  get sdPage(): EcamPage { return this.ecam.shownPage(this.pageAuto); }
  /** MASTER WARN lamp: a displayed red warning whose aural alert has not been cancelled. */
  get warnLit(): boolean { return this.masterWarn || this.ecam.alerts.some((a) => a.red && !this.ecam.auralCancelled.has(a.text)); }
  /** Source switching panel: 0 = CAPT 3 (or CAPT for ECAM/ND XFR), 1 = NORM, 2 = F/O 3 (F/O). */
  switching = { attHdg: 1, airData: 1, eisDmc: 1, ndXfr: 1 };
  /** Display unit OFF / BRT knobs: a knob turned fully anticlockwise switches the display off. */
  duOn(k: 'pfd' | 'nd' | 'uecam' | 'lecam') { const v = this.bright[k]; return (Array.isArray(v) ? v[0] : v) > 0.04; }
  // Display brightness: 0 = off (knob fully counter-clockwise) … 1 = max. PFD / ND knobs exist per side (index 0 = CAPT, 1 = F/O).
  bright = { pfd: [0.8, 0.8], nd: [0.8, 0.8], ndOuter: [0.5, 0.5], uecam: 1, lecam: 1, integ: 1, fcu: 1, flood: 0.7 };
  /** Two independent EFIS control panels (CAPT / F/O) – see EfisState. */
  efis: [EfisState, EfisState] = [newEfis(), newEfis()];
  /** ISIS (standby instrument) baro reference – its own knob, independent of both EFIS panels. */
  isis = { hpa: 1013, std: false };
  terrOnNd = [false, false];
  /** While the crew has not touched a baro knob the reference follows the live QNH (as if set from ATIS). */
  private baroTouched = [false, false];
  fd = [true, true]; athrArmed = false; exped = false; spdMach = false; trkFpa = false; metric = false; altStep1000 = false; vsTarget = 0; vsMode = false;
  // FCU: pushed = managed (dashes + dot), pulled = selected. Pre-selections made while managed show for 10 s (SPD) / 45 s (HDG, V/S) – FCOM DSC-22_10.
  spdManaged = true; hdgManaged = false; altManaged = true; spdPre = 0; hdgPre = 0; vsPre = 0; spdPreVal = 0; hdgPreVal = 0; fpaTarget = 0; apEng = [false, false]; locArmed = false;
  /** EFIS ADF/OFF/VOR switches (0 = ADF, 1 = OFF, 2 = VOR) for needle 1 and 2, captain and first officer. */
  vorAdf = { c1: 1, c2: 1, f1: 1, f2: 1 };
  masterWarn = false; masterCaut = false; chronoRun = false; chronoT = 0; chronoShow = false; seatbeltPrev = false;
  startMsg = '';
  private prevWarn = ''; private prevMaster = [false, false];

  /** Name of the lit legend state for a push-button: 1 = normal (in), 0 = pushed (OFF/FAULT legend shown). */
  get(name: string, d = 1) { return this.sw[name] ?? d; }

  // ---------------- EFIS control panel logic (per side) ----------------
  /** Baro knob rotation: 1 hPa (or 0.01 inHg) per click. Ignored while STD is selected, like the real FCU. */
  efisBaroTurn(side: 0 | 1, dir: number) {
    const e = this.efis[side]; if (e.std) return; this.baroTouched[side] = true;
    if (e.unitInHg) e.inHg = Math.max(2200, Math.min(3248, e.inHg + dir)); else e.hpa = Math.max(745, Math.min(1100, e.hpa + dir));
  }
  /** Pull = STD (1013 / 29.92), push = back to the selected QNH. */
  efisBaroSet(side: 0 | 1, std: boolean) { this.efis[side].std = std; this.baroTouched[side] = true; }
  /** Outer ring: hPa / inHg. The setting is converted so the same pressure stays selected. */
  efisBaroUnit(side: 0 | 1, inHg: boolean) {
    const e = this.efis[side]; if (e.unitInHg === inHg) return; this.baroTouched[side] = true;
    if (inHg) e.inHg = Math.round(e.hpa / HPA_PER_INHG * 100); else e.hpa = Math.round(e.inHg / 100 * HPA_PER_INHG);
    e.unitInHg = inHg;
  }
  /** CSTR / WPT / VOR.D / NDB / ARPT: only one can be lit at a time; pressing the lit one again clears it. */
  efisOpt(side: 0 | 1, k: NdOpt) { const e = this.efis[side]; e.opt = e.opt === k ? null : k; }
  /** Pressure setting currently shown on a PFD in hPa (STD = 1013.25). */
  baroSettingHpa(side: 0 | 1) { const e = this.efis[side]; return e.std ? 1013.25 : e.unitInHg ? e.inHg / 100 * HPA_PER_INHG : e.hpa; }
  /** Altimeter indication: what the baro-set altimeter reads for a given true altitude (≈ 27 ft per hPa). */
  indicatedAlt(side: 0 | 1, trueFt: number) { return trueFt + (this.baroSettingHpa(side) - airState.qnh) * 27; }
  /** ND mode / range actually shown on a side (the F/O ND can show the CAPT image when the XFR switch is used – handled by the screen). */

  update(dt: number, h: CockpitHost, d: PanelData) {
    for (let i = 0; i < 2; i++) if (!this.baroTouched[i] && airState.qnh > 800 && airState.qnh < 1100) { const q = airState.qnh; this.efis[i].hpa = Math.round(q); this.efis[i].inHg = Math.round(q / HPA_PER_INHG * 100); this.efis[i].std = false; this.isis.hpa = Math.round(q); }
    const fm = h.fm, spec = fm.spec, onGround = fm.wow;
    // ---------------- electrics ----------------
    const engRun = [fm.eng[0].state === 2, fm.eng[1].state === 2];
    const apuAvail = this.apuRpm >= 95;
    const genOn = [engRun[0] && this.gen[0] && fm.n[0] > 0.4, engRun[1] && this.gen[1] && fm.n[1] > 0.4];
    this.ac = (this.ext && onGround && fm.gs < 1) || (apuAvail && this.apuGen) || genOn[0] || genOn[1];
    this.acEss = this.ac || (this.bat[0] || this.bat[1]) && !onGround && fm.ias > 50;
    this.dc = this.bat[0] || this.bat[1] || this.ac;
    fm.ctl.battery = this.dc || this.ac;
    for (let i = 0; i < 2; i++) this.batV[i] += ((this.bat[i] ? (this.ac ? 28.1 : 25.6) : 0) - this.batV[i]) * Math.min(1, dt * 2);
    // ---------------- APU ----------------
    if (!this.apuMaster) { this.apuStart = false; }
    if (this.apuMaster && this.apuStart && this.dc) { this.apuRpm = Math.min(100, this.apuRpm + dt * (100 / 28)); }
    else if (!this.apuMaster || !this.apuStart) { this.apuRpm = Math.max(0, this.apuRpm - dt * (this.apuMaster ? 0 : 100 / 40)); }
    if (this.apuRpm >= 99.9) this.apuStart = false;
    this.apuEgt += ((this.apuRpm > 5 ? 330 + (this.apuRpm < 95 ? 260 * Math.sin(this.apuRpm / 95 * Math.PI) : 0) : 20) - this.apuEgt) * Math.min(1, dt * 0.6);
    // ---------------- engines (ENG MASTER / ENG MODE) ----------------
    for (let i = 0; i < 2; i++) {
      const e = fm.eng[i], n = fm.n[i], pf = Math.max(0, (n - spec.idle) / (1 - spec.idle));
      this.n2[i] = e.state === 0 ? n / spec.idle * 60 * (n > 0.01 ? 1 : 0) : e.state === 1 ? n / spec.idle * 61 : 61 + pf * 36;
      const tgtEgt = e.state === 2 ? 380 + 520 * Math.pow(pf, 1.3) + (this.cabAltFt > 0 ? 0 : 0) : e.state === 1 ? 120 + 520 * Math.max(0, e.t / spec.startSecs - 0.45) * (1 - e.t / spec.startSecs) * 4 : Math.max(20, this.egt[i] * 0.995);
      this.egt[i] += (tgtEgt - this.egt[i]) * Math.min(1, dt * 0.8);
      this.ff[i] = e.state ? fm.fuelFlow * 3600 / spec.engines : 0;
      this.oilPsi[i] = e.state === 2 ? 50 + pf * 12 : e.state === 1 ? 20 * Math.min(1, n / spec.idle) : 0;
      this.vib[i] = e.state === 2 ? 0.3 + pf * 0.6 : 0;
      this.ignA[i] = e.state === 1 && e.t / spec.startSecs < 0.9;
      // switching the master OFF shuts the engine down; a start only begins from a master ON edge with air + electrics
      if (!this.master[i] && e.state !== 0 && this.prevMaster[i]) fm.stopEngine(i);
      if (this.master[i] && !this.prevMaster[i] && e.state === 0) this.tryStart(i, h);
      this.prevMaster[i] = this.master[i];
      if (e.state === 2 && !this.master[i]) this.master[i] = true; // engines already running (hot start / spawn)
      if (e.state === 0 && this.master[i] && this.startMsg === '') { /* waiting – start refused earlier */ }
    }
    // ---------------- bleed & packs ----------------
    const bleedSrc = (i: number) => (this.engBleed[i] && fm.eng[i].state === 2 ? 35 + fm.n[i] * 10 : 0);
    const apuB = this.apuBleed && apuAvail ? 36 : 0;
    this.bleedPsi[0] = Math.max(bleedSrc(0), apuB, this.xbleed ? bleedSrc(1) * 0.9 : 0);
    this.bleedPsi[1] = Math.max(bleedSrc(1), apuB, this.xbleed ? bleedSrc(0) * 0.9 : 0);
    // ---------------- pressurisation (cabin altitude schedule, max ΔP 8.06 psi) ----------------
    const altFt = d.altFt, pOutside = 14.696 * Math.pow(1 - 6.8756e-6 * Math.max(0, altFt), 5.2559);
    const packOn = !this.sw.DitchBtn && ((this.packs[0] && this.bleedPsi[0] > 20) || (this.packs[1] && this.bleedPsi[1] > 20));   // DITCHING pb closes outflow valve and pack flow
    let tgtCab = onGround ? altFt - 0 : Math.min(altFt, Math.max(0, altFt * 0.22 - 400));
    if (!packOn) tgtCab = altFt; // unpressurised
    const cabNow = this.cabAltFt, step = (packOn ? 500 : 3000) * dt / 60;
    const prev = this.cabAltFt; this.cabAltFt += Math.max(-step, Math.min(step, tgtCab - cabNow));
    this.cabVs = (this.cabAltFt - prev) / Math.max(dt, 1e-3) * 60;
    const pCab = 14.696 * Math.pow(1 - 6.8756e-6 * this.cabAltFt, 5.2559);
    this.deltaP = Math.max(0, pCab - pOutside); this.outflow = packOn ? Math.min(1, 0.3 + this.deltaP / 12) : 1;
    // ---------------- hydraulics ----------------
    const g = this.hydPump.green && engRun[0] && !this.fireOut[0] ? 3000 : 0;   // FIRE pb released closes the hydraulic fire shut-off valve
    const yEng = this.hydPump.yellow && engRun[1] && !this.fireOut[1] ? 3000 : 0;
    const yEl = this.hydPump.yElec && this.ac ? 3000 : 0;
    const bl = this.hydPump.blue && this.ac ? 3000 : 0;
    const ptu = this.hydPump.ptu && (g > 0) !== (yEng + yEl > 0) && (engRun[0] || engRun[1]) ? 2500 : 0;
    const tg = { green: g || ptu * (yEng + yEl > 0 ? 1 : 0), yellow: yEng || yEl || (g ? ptu : 0), blue: bl || (this.ratOut && fm.ias > 120 * 0.514 ? 2400 : 0) };
    for (const k of ['green', 'yellow', 'blue'] as const) this.hyd[k] += (tg[k] - this.hyd[k]) * Math.min(1, dt * 0.7);
    this.accumPsi += ((this.hyd.yellow > 2000 ? 3000 : Math.max(0, this.accumPsi - dt * 2)) - this.accumPsi) * Math.min(1, dt * 0.4);
    // ---------------- fuel tanks ----------------
    const total = fm.fuel, ctrCap = 6500, wingCap = (spec.fuelCap - ctrCap) / 2;
    const ctr = Math.min(ctrCap, Math.max(0, total - 2 * wingCap)); const wing = (total - ctr) / 2;
    this.tank.c = ctr; this.tank.l = wing; this.tank.r = wing;
    // ---------------- brakes: autobrake + ground spoilers ----------------
    fm.ctl.autobrake = this.autobrake; fm.ctl.spoilersArmed = this.spoilerArm;
    // ---------------- chrono ----------------
    if (this.chronoRun) this.chronoT += dt;
    // ---------------- warnings ----------------
    const warn = d.warn.join('|') + (this.lampTest ? 'T' : '');
    if (warn !== this.prevWarn) { if (d.warn.length) { this.masterCaut = true; } this.prevWarn = warn; }
    if (this.lampTest > 0) this.lampTest -= dt;
    // auto ECAM page selection by flight phase
    this.pageAuto = this.autoPage(h, d);
    this.ecam.update(dt, {
      warns: d.warn, toCfgIssues: this.toConfigIssues(h), wow: fm.wow, anyEngine: fm.anyEngineRunning || fm.eng[0].state === 1 || fm.eng[1].state === 1, autoPage: this.pageAuto,
      ackAural: () => h.action('ackWarn'), toast: (m) => h.toast(m, 'warn'),
    });
    this.applyConsequences(dt, h, d);
  }

  /** CONFIG problems the T.O CONFIG test would report (FCOM DSC-31-15): flaps outside CONF 1+F..3, speedbrakes not retracted. */
  private toConfigIssues(h: CockpitHost): string[] {
    const c = h.fm.ctl, out: string[] = [];
    if (c.flapsIdx < 1 || c.flapsIdx > 3) out.push('FLAPS NOT IN T.O CONFIG');
    if (c.speedbrake > 0.03) out.push('SPD BRK NOT RETRACTED');
    return out;
  }

  // ---------------- consequences of the overhead / pedestal switches on the flight model ----------------
  /** Hydraulics are considered "armed" after the first time any system has been pressurised (cold & dark never locks controls). */
  private hydArmed = false; private flapHold = -1; private gearHold = true; private starve = [0, 0]; private lastLockToast = 0;
  /** Seconds each engine has been without a fuel feed (all feeding pumps OFF above the gravity-feed ceiling). */
  get fuelStarveS() { return this.starve; }
  private applyConsequences(dt: number, h: CockpitHost, d: PanelData) {
    const fm = h.fm, c = fm.ctl, hy = this.hyd;
    if (hy.green > 2000 || hy.yellow > 2000 || hy.blue > 2000) this.hydArmed = true;
    // Brakes: normal braking is Yellow; the accumulator gives a few applications; parking brake keeps its own accumulator hold
    c.brakePress = hy.yellow > 1500 ? 1 : this.accumPsi > 1200 ? 0.55 : 0;
    if (this.hydArmed) {
      const warn = (m: string) => { const t = performance.now(); if (t - this.lastLockToast > 3500) { this.lastLockToast = t; h.toast(m, 'warn'); } };
      // Flaps / slats: Blue + Green hydraulic motors – with both lost the surfaces stay where they are
      if (hy.green < 1500 && hy.blue < 1500) { if (this.flapHold < 0) this.flapHold = c.flapsIdx; if (c.flapsIdx !== this.flapHold) { c.flapsIdx = this.flapHold; warn('FLAPS / SLATS INOP – GREEN + BLUE HYD LOST'); } } else this.flapHold = -1;
      // Landing gear: retraction needs Green; extension falls back to gravity (GRVTY GEAR EXTN)
      if (hy.green < 1500) { if (!c.gearDown && this.gearHold) { c.gearDown = true; warn('GEAR RETRACTION INOP – GREEN HYD LOST'); } }
      // Track the handle while Green is healthy; once it is lost the gear is held down (and gravity-extends if it was up).
      this.gearHold = hy.green >= 1500 ? c.gearDown : true;
      // Spoilers / speedbrakes: each of G / B / Y drives two surfaces per wing
      const sources = (hy.green > 1500 ? 1 : 0) + (hy.blue > 1500 ? 1 : 0) + (hy.yellow > 1500 ? 1 : 0);
      c.speedbrake = Math.min(c.speedbrake, sources / 3 + 0.001);
      if (sources === 0) c.spoilersArmed = false;
    } else { this.flapHold = -1; this.gearHold = c.gearDown; }
    // Fuel feed: each engine is fed by its wing-tank pumps (or the centre-tank pumps while the centre tank holds fuel, or X-FEED).
    // With every feeding pump OFF the engine gravity-feeds up to ~25 000 ft, above that it flames out after a few seconds.
    const pumpsL = this.pumps[0] || this.pumps[1], pumpsR = this.pumps[4] || this.pumps[5], ctrP = (this.pumps[2] || this.pumps[3]) && this.tank.c > 50;
    const feed = [pumpsL || ctrP || (this.xfeed && pumpsR), pumpsR || ctrP || (this.xfeed && pumpsL)];
    for (let i = 0; i < 2; i++) {
      const running = fm.eng[i].state === 2;
      if (running && !feed[i] && d.altFt > 25000) {
        this.starve[i] += dt;
        if (this.starve[i] > 4) { fm.stopEngine(i); this.master[i] = false; this.starve[i] = 0; h.toast(`ENG ${i + 1} FLAME OUT – FUEL FEED LOST (pumps OFF above FL250)`, 'warn'); }
      } else this.starve[i] = Math.max(0, this.starve[i] - dt);
    }
    // FADEC thrust limit penalties (CFM56-5B): engine anti-ice ≈ -2.5 %, wing anti-ice ≈ -1.2 %, pack bleed ≈ -0.8 %
    const bleedLoad = (this.packs[0] || this.packs[1]) && (this.engBleed[0] || this.engBleed[1]) ? 0.008 : 0;
    c.thrLimit = 1 - (this.engAI[0] || this.engAI[1] ? 0.025 : 0) - (this.wingAI ? 0.012 : 0) - bleedLoad;
  }

  private autoPage(h: CockpitHost, d: PanelData): EcamPage {
    const fm = h.fm;
    if (this.apuRpm > 5 && !fm.eng[0].state && !fm.eng[1].state) return 'APU';
    if (fm.eng[0].state === 1 || fm.eng[1].state === 1) return 'ENG';
    if (fm.wow && fm.gs < 1 && !fm.anyEngineRunning) return 'DOOR';
    if (fm.wow && fm.gs < 40 && fm.ctl.throttle < 0.6) return 'WHEEL' as EcamPage;
    if (fm.wow || d.aglFt < 1500) return d.aglFt < 1500 && !fm.wow ? 'WHEEL' as EcamPage : 'CRZ';
    return 'CRZ';
  }

  private tryStart(i: number, h: CockpitHost) {
    const fm = h.fm, other = fm.eng[1 - i].state === 2;
    if (this.fireOut[i]) { this.msg(h, `ENG ${i + 1}: FIRE pb released – push it back in before starting`, 'warn'); this.master[i] = false; return; }
    if (this.engMode !== 2) { this.msg(h, `ENG ${i + 1}: set ENG MODE selector to IGN/START first`, 'warn'); this.master[i] = false; return; }
    if (!this.dc) { this.master[i] = false; return; }
    if (!(this.bleedPsi[i] > 20 || other || this.bleedPsi[1 - i] > 20)) { this.msg(h, `ENG ${i + 1}: no bleed air – start the APU and open APU BLEED`, 'warn'); this.master[i] = false; return; }
    const r = fm.startEngine(i); if (r) { this.msg(h, r, 'warn'); this.master[i] = false; } else this.msg(h, `ENG ${i + 1} START`, 'good');
  }
  private msg(h: CockpitHost, m: string, k: 'info' | 'warn' | 'good') { this.startMsg = m; h.toast(m, k); setTimeout(() => { if (this.startMsg === m) this.startMsg = ''; }, 4000); }
}

/** Airbus FADEC thrust-lever detents. Lever position 0..1 ↔ TLA 0..45°: IDLE 0°, CL 25°, FLX/MCT 35°, TOGA 45° (A320 FCOM 1.70). */
export const THR_DETENTS = [{ name: 'IDLE', v: 0 }, { name: 'CL', v: 25 / 45 }, { name: 'FLX/MCT', v: 35 / 45 }, { name: 'TOGA', v: 1 }] as const;
/** Snap a lever position to the nearest detent when within `capture` (≈ 1.8° of TLA) – gives the guarded "gate" feel. */
export function snapThrottle(v: number, capture = 0.04): number { for (const d of THR_DETENTS) if (Math.abs(v - d.v) < capture) return d.v; return Math.min(1, Math.max(0, v)); }
export function thrDetentName(v: number, reverse = false): string {
  if (reverse) return 'REV';
  for (const d of THR_DETENTS) if (Math.abs(v - d.v) < 0.045) return d.name;
  const tla = Math.round(v * 45);
  return v < 25 / 45 ? `IDLE–CL · TLA ${tla}°` : v < 35 / 45 ? `CL–FLX/MCT · TLA ${tla}°` : `FLX/MCT–TOGA · TLA ${tla}°`;
}
