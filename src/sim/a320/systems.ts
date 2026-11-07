// A320 aircraft-systems state behind the flight-deck switches: electrics, APU, bleed/packs, hydraulics, fuel, pressurisation,
// engine start logic (ENG MODE + ENG MASTER), autobrake / ground spoilers and the cockpit "switch board".
import type { FlightModel } from '../physics';
import type { PanelData } from '../instruments';

export interface CockpitHost {
  fm: FlightModel;
  ap: { on: boolean; nav: boolean; appr: boolean; hdg: number; altFt: number; spd: number };
  lights: { nav: boolean; strobe: boolean; land: boolean; beacon: boolean };
  seatbelt: boolean;
  action(id: string): void;
  setApTarget(t: 'hdg' | 'alt' | 'spd', v: number): void;
  toast(msg: string, kind?: 'info' | 'warn' | 'good'): void;
  route(): { name: string; lat: number; lon: number }[];
  position(): { lat: number; lon: number };
  magVar(hdg: number): number;
}

export type EcamPage = 'ENG' | 'BLEED' | 'PRESS' | 'ELEC' | 'HYD' | 'FUEL' | 'APU' | 'COND' | 'DOOR' | 'WHEEL' | 'F/CTL' | 'STS' | 'CRZ';
const KG_PER_FT_NONE = 0;
void KG_PER_FT_NONE;

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
  tank = { l: 0, c: 0, r: 0 };
  // ---- engines ----
  engMode: 0 | 1 | 2 = 1; // 0 CRANK, 1 NORM, 2 IGN/START
  master = [false, false]; n2 = [0, 0]; egt = [0, 0]; ff = [0, 0]; oilPsi = [0, 0]; oilQty = [14, 14]; vib = [0, 0]; ignA = [false, false];
  // ---- flight deck ----
  autobrake = 0 as 0 | 1 | 2 | 3; spoilerArm = false; antiSkid = true; nwStrg = true;
  gpws = { sys: true, gs: true, flap: true, terr: true };
  page: EcamPage | null = null; pageAuto: EcamPage = 'DOOR'; lampTest = 0;
  bright = { pfd: 1, nd: 1, uecam: 1, lecam: 1, integ: 1, fcu: 1, flood: 0.7 };
  qnh = 1013; std = true; qnhInHg = false; ndMode = 3; ndRange = 3; ndOverlay = { cstr: false, wpt: false, vord: false, ndb: false, arpt: false, ls: false };
  fd = [true, true]; athrArmed = false; exped = false; spdMach = false; trkFpa = false; metric = false; altStep1000 = false; vsTarget = 0; vsMode = false; spdManaged = false; hdgManaged = false;
  masterWarn = false; masterCaut = false; chronoRun = false; chronoT = 0; chronoShow = false; seatbeltPrev = false;
  startMsg = '';
  private prevWarn = ''; private prevMaster = [false, false];

  /** Name of the lit legend state for a push-button: 1 = normal (in), 0 = pushed (OFF/FAULT legend shown). */
  get(name: string, d = 1) { return this.sw[name] ?? d; }

  update(dt: number, h: CockpitHost, d: PanelData) {
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
    const packOn = (this.packs[0] && this.bleedPsi[0] > 20) || (this.packs[1] && this.bleedPsi[1] > 20);
    let tgtCab = onGround ? altFt - 0 : Math.min(altFt, Math.max(0, altFt * 0.22 - 400));
    if (!packOn) tgtCab = altFt; // unpressurised
    const cabNow = this.cabAltFt, step = (packOn ? 500 : 3000) * dt / 60;
    const prev = this.cabAltFt; this.cabAltFt += Math.max(-step, Math.min(step, tgtCab - cabNow));
    this.cabVs = (this.cabAltFt - prev) / Math.max(dt, 1e-3) * 60;
    const pCab = 14.696 * Math.pow(1 - 6.8756e-6 * this.cabAltFt, 5.2559);
    this.deltaP = Math.max(0, pCab - pOutside); this.outflow = packOn ? Math.min(1, 0.3 + this.deltaP / 12) : 1;
    // ---------------- hydraulics ----------------
    const g = this.hydPump.green && engRun[0] ? 3000 : 0;
    const yEng = this.hydPump.yellow && engRun[1] ? 3000 : 0;
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
    if (this.engMode !== 2) { this.msg(h, `ENG ${i + 1}: set ENG MODE selector to IGN/START first`, 'warn'); this.master[i] = false; return; }
    if (!this.dc) { this.master[i] = false; return; }
    if (!(this.bleedPsi[i] > 20 || other || this.bleedPsi[1 - i] > 20)) { this.msg(h, `ENG ${i + 1}: no bleed air – start the APU and open APU BLEED`, 'warn'); this.master[i] = false; return; }
    const r = fm.startEngine(i); if (r) { this.msg(h, r, 'warn'); this.master[i] = false; } else this.msg(h, `ENG ${i + 1} START`, 'good');
  }
  private msg(h: CockpitHost, m: string, k: 'info' | 'warn' | 'good') { this.startMsg = m; h.toast(m, k); setTimeout(() => { if (this.startMsg === m) this.startMsg = ''; }, 4000); }
}
