// A320 MCDU (keyboard + display), table driven: every page is a list of fields, and the SAME list drives the drawing and the line-select keys,
// so what is on the screen is always what the key acts on.
// Behaviour follows the Airbus MCDU (FCOM DSC-22_20 / FlyByWire MCDU documentation):
//  * scratchpad: 22 characters; typing replaces an amber message; data is committed by the line-select key (LSK) next to the field, then the scratchpad is blanked;
//  * CLR: clears an amber message, else deletes the last character; HELD for one second it blanks the whole scratchpad; on an EMPTY scratchpad it shows "CLR" and the
//    next LSK erases that field (back to its default / empty value);
//  * an LSK pressed with an empty scratchpad copies an editable field into the scratchpad (so it can be modified and re-entered);
//  * slew keys: up / down scroll a list vertically, left / right step through the pages of a multi-page function (INIT 1/2, PERF phases, DATA);
//  * entries are range-checked: FORMAT ERROR / ENTRY OUT OF RANGE / NOT ALLOWED (amber, stay until CLR).
import type { Ctx } from './displays';
import type { CockpitHost } from './systems';
import { haversine } from '../geo';
import { speeds } from './efisDisplays';

type G = CanvasRenderingContext2D;
const M = 'Consolas, "Courier New", monospace';
const C = { green: '#2bff4a', cyan: '#2ee6ff', amber: '#ffb000', white: '#f4f4f4', mag: '#ff5cf0', grey: '#9aa6b2' };
const NM = 1852, SCRATCH_MAX = 22;
const pad = (n: number, w: number) => String(Math.round(n)).padStart(w, '0');
const E_RANGE = 'ENTRY OUT OF RANGE', E_FMT = 'FORMAT ERROR', E_NA = 'NOT ALLOWED';

/** One data field of a page: `s`/`n` = which line-select key it sits next to (L1-L6 / R1-R6). */
interface Fld {
  s: 'L' | 'R'; n: number; label?: string; show: string; col: string;
  /** commit a scratchpad entry: returns an error message, or nothing when accepted */
  set?: (v: string) => string | void;
  /** erase (CLR + LSK) */ clr?: () => void;
  /** acts whatever the scratchpad holds (page / action keys, drawn with an arrow) */ go?: () => void;
  /** acts on an empty scratchpad only (select a list line) */ sel?: () => void;
  /** text copied into the scratchpad when the LSK is pressed on an empty scratchpad */ copy?: string;
}
interface View { t: string; sub?: string; f: Fld[]; slew?: 'v' | 'h' | 'vh'; }

const PERF_PHASES = ['TAKE OFF', 'CLB', 'CRZ', 'DES', 'APPR', 'GO AROUND'];
export class Mcdu {
  page = 'MENU'; scratch = ''; msg = ''; sub = 0;
  /** Screen brightness 0.15..1, stepped by the BRT / DIM keys. */
  brt = 1;
  store = {
    coRte: '', fromTo: '', altn: '', flt: 'IFL320', crz: 350, ci: 35, tropo: 36090, taxi: 0.4, rsvPct: 5, altnFuel: 0, final: 2.4, zfw: 62.5, zfwcg: 25, block: 0,
    v1: 0, vr: 0, v2: 0, flex: 55, trans: 5000, thrRed: 1500, acc: 1500, engOutAcc: 1500, toConf: 1, perfPhase: 0,
    qnh: 1013, temp: 15, wind: '', mda: 0, dh: 0, vapp: 0, ldgFull: false, goaThrRed: 1500, goaAcc: 1500,
    vor1: '', vor2: '', vor1c: -1, vor2c: -1, ls: '', lsc: -1, adf1: '', adf2: '',
  };
  /** Set by the cockpit every frame (live flight data); the keys need it to validate / apply entries. */
  ctx?: Ctx;
  private host?: CockpitHost; private clrT = -1; private ovfly = new Set<string>(); private ovflyArm = false; private latIdx = 0; private sec = false;
  attach(h: CockpitHost) { this.host = h; }
  /** CLR held for one second blanks the scratchpad (called every frame). */
  tick(dt: number) { if (this.clrT >= 0) { this.clrT += dt; if (this.clrT >= 1) { this.scratch = ''; this.msg = ''; this.clrT = -2; } } }
  /** Pointer released on a key. */
  release() { this.clrT = -1; }
  private setMsg(m: string) { this.msg = m; }
  private num(s: string) { const t = s.trim(); return /^[+-]?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : NaN; }
  private add(ch: string) { if (this.msg) this.msg = ''; if (this.scratch === 'CLR') this.scratch = ''; if (this.scratch.length < SCRATCH_MAX) this.scratch += ch; }

  /** Key names follow the 3D model: a.cpt … z.cpt, 0-9, L1-6, R1-6, init, f-pln, radnav, fuel-pred, prog, perf, data, dir, airport, clr, sp, ... */
  key(raw: string) {
    const k = raw.replace(/\.(cpt|fo)$/, '');
    if (/^[a-z]$/.test(k)) { this.add(k.toUpperCase()); return; }
    if (/^[0-9]$/.test(k)) { this.add(k); return; }
    switch (k) {
      case '.': this.add('.'); return; case '/': this.add('/'); return; case 'sp': this.add(' '); return;
      // +/- : appends '-', then toggles the sign character at the end of the scratchpad ('-' <-> '+')
      case '+/-': { const l = this.scratch.slice(-1); if (l === '-') this.scratch = this.scratch.slice(0, -1) + '+'; else if (l === '+') this.scratch = this.scratch.slice(0, -1) + '-'; else this.add('-'); return; }
      case 'clr':
        this.clrT = 0;
        if (this.msg) this.msg = ''; else if (this.scratch === 'CLR') this.scratch = ''; else if (this.scratch) this.scratch = this.scratch.slice(0, -1); else this.scratch = 'CLR';
        return;
      case 'BRT': this.brt = Math.min(1, +(this.brt + 0.15).toFixed(2)); return; case 'DIM': this.brt = Math.max(0.15, +(this.brt - 0.15).toFixed(2)); return;
      case 'init': this.open('INIT'); return; case 'f-pln': this.open('F-PLN'); return; case 'f-pln2': this.open('SEC'); return; case 'radnav': this.open('RADNAV'); return;
      case 'fuel-pred': this.open('FUEL'); return; case 'prog': this.open('PROG'); return; case 'data': this.open('DATA'); return; case 'dir': this.open('DIR'); return;
      case 'airport': this.open('AIRPORT'); return; case 'menu': this.open('MENU'); return;
      case 'perf': this.open('PERF'); this.store.perfPhase = this.autoPhase(); return;
      case 'up': this.slew(-1, 'v'); return; case 'down': this.slew(1, 'v'); return; case 'left': this.slew(-1, 'h'); return; case 'right': this.slew(1, 'h'); return;
      case 'overfly': if (this.page === 'F-PLN') { this.ovflyArm = !this.ovflyArm; if (this.ovflyArm) this.setMsg('SELECT WAYPOINT TO OVERFLY'); else this.msg = ''; } else this.setMsg(E_NA); return;
      case 'opt1': case 'opt2': return;                                    // blank keys on the A320 MCDU
    }
    const m = /^([LR])([1-6])$/.exec(k); if (m) this.lsk(m[1] as 'L' | 'R', +m[2]);
  }
  private open(p: string) { this.page = p; this.sub = 0; this.ovflyArm = false; }
  private slew(dir: number, axis: 'v' | 'h') {
    const c = this.ctx, v = c ? this.view(c) : null, s = v?.slew ?? ''; if (!s.includes(axis)) return;
    if (axis === 'v') { const max = Math.max(0, (this.host?.route().length ?? 1) - 1); this.sub = Math.max(0, Math.min(max, this.sub + dir)); return; }
    if (this.page === 'PERF') this.store.perfPhase = (this.store.perfPhase + dir + 6) % 6;
    else if (this.page === 'INIT' || this.page === 'DATA') this.sub = Math.max(0, Math.min(1, this.sub + dir));
  }
  private autoPhase(): number {
    const c = this.ctx; if (!c) return 0; const fm = c.host.fm, d = c.d;
    if (fm.wow) return 0; if (d.dest && d.dest.distNm < 40 && d.altFt < 12000) return 4;
    if (d.altFt < this.store.crz * 100 - 800) return d.vsFpm < -300 && d.altFt > 12000 ? 3 : 1;
    return 2;
  }
  private lsk(side: 'L' | 'R', n: number) {
    const c = this.ctx; if (!c || !this.host) return;
    const f = this.view(c).f.find((x) => x.s === side && x.n === n), input = this.scratch;
    if (!f) { if (input && input !== 'CLR') this.setMsg(E_NA); return; }
    if (f.go) { f.go(); return; }
    if (input === 'CLR') { if (f.clr) { f.clr(); this.scratch = ''; } else this.setMsg(E_NA); return; }
    if (input) { if (!f.set) { this.setMsg(E_NA); return; } const err = f.set(input.trim()); if (err) this.setMsg(err); else this.scratch = ''; return; }
    if (f.sel) { f.sel(); return; }
    if (f.set && f.copy) this.scratch = f.copy;
  }

  // ------------------------------------------------------------------ helpers for pages
  private latLon(): { lat: string; lon: string } {
    const p = this.host!.position(), f = (v: number, w: number, a: string, b: string) => { const h = v < 0 ? b : a, x = Math.abs(v), d = Math.floor(x); return `${pad(d, w)}${((x - d) * 60).toFixed(1).padStart(4, '0')}${h}`; };
    return { lat: f(p.lat, 2, 'N', 'S'), lon: f(p.lon, 3, 'E', 'W') };
  }
  private tripInfo(c: Ctx) {
    const fm = c.host.fm, d = c.d, ete = d.dest ? d.dest.eteMin : 0, flowTph = fm.fuelFlow * 3.6;   // t / h
    const trip = d.dest ? flowTph * ete / 60 : 0, fob = fm.fuel / 1000;
    return { ete, trip, fob, rsv: trip * this.store.rsvPct / 100, flowKgH: fm.fuelFlow * 3600 };
  }
  private hhmm(min: number) { const m = Math.max(0, Math.round(min)); return `${pad(Math.floor(m / 60) % 24, 2)}${pad(m % 60, 2)}`; }
  private routeDist(rt: { lat: number; lon: number }[], pos: { lat: number; lon: number }): number[] {
    const out: number[] = []; let acc = 0, la = pos.lat, lo = pos.lon;
    for (const w of rt) { acc += haversine(la, lo, w.lat, w.lon) / NM; out.push(acc); la = w.lat; lo = w.lon; }
    return out;
  }
  private directTo(k: number) {
    const h = this.host!, rt = h.route(), w = rt[k];
    if (!w || !h.directTo || !h.directTo(k)) { this.setMsg(E_NA); return; }
    h.toast(`DIR TO ${w.name}`, 'good'); this.page = 'F-PLN'; this.sub = 0;
  }
  /** numeric entry field */
  private nf(s: 'L' | 'R', n: number, label: string, shown: string, col: string, lo: number, hi: number, apply: (v: number) => void, o: { clr?: () => void; int?: boolean; pre?: (t: string) => string } = {}): Fld {
    return {
      s, n, label, show: shown, col, copy: shown.startsWith('[') ? undefined : shown,
      set: (t) => { const v = this.num(o.pre ? o.pre(t) : t); if (!Number.isFinite(v) || (o.int && !Number.isInteger(v))) return E_FMT; if (v < lo || v > hi) return E_RANGE; apply(v); },
      clr: o.clr,
    };
  }
  private fl(t: string): string { return t.replace(/^FL/i, '').replace(/\/.*$/, ''); }
  private setCrz(v: number) { const fl = v >= 1000 ? v / 100 : v; this.store.crz = Math.round(fl); this.host?.setApTarget('alt', Math.round(fl) * 100); }

  // ------------------------------------------------------------------ pages
  private view(c: Ctx): View {
    const st = this.store, h = this.host!, d = c.d, fm = h.fm, rt = h.route(), F = (o: Fld): Fld => o, ti = this.tripInfo(c);
    const go = (p: string, sub = 0) => () => { this.page = p; this.sub = sub; };
    switch (this.page) {
      case 'MENU': return { t: 'MCDU MENU', f: [
        F({ s: 'L', n: 1, show: '<INIT', col: C.green, go: go('INIT') }), F({ s: 'L', n: 2, show: '<F-PLN', col: C.green, go: go('F-PLN') }), F({ s: 'L', n: 3, show: '<PERF', col: C.green, go: () => { this.open('PERF'); st.perfPhase = this.autoPhase(); } }),
        F({ s: 'L', n: 4, show: '<PROG', col: C.green, go: go('PROG') }), F({ s: 'L', n: 5, show: '<DATA', col: C.green, go: go('DATA') }), F({ s: 'L', n: 6, show: '<RAD NAV', col: C.green, go: go('RADNAV') }),
        F({ s: 'R', n: 1, show: 'FMGC', col: C.white })] };

      case 'INIT': {
        const ll = this.latLon(), isa = Math.round(15 - 1.98 * st.crz / 10);
        if (this.sub === 1) return { t: 'INIT', sub: '2/2', slew: 'h', f: [
          this.nf('L', 1, 'TAXI', st.taxi.toFixed(1), C.cyan, 0, 2, (v) => { st.taxi = v; }),
          F({ s: 'R', n: 1, label: 'TRIP/TIME', show: d.dest ? `${ti.trip.toFixed(1)}/${this.hhmm(ti.ete)}` : '---.-/----', col: C.green }),
          this.nf('L', 2, 'RTE RSV/%', `${ti.rsv.toFixed(1)}/${st.rsvPct.toFixed(1)}`, C.cyan, 0, 15, (v) => { st.rsvPct = v; }, { pre: (t) => t.replace(/^.*\//, '') }),
          this.nf('R', 2, 'ALTN/TIME', `${st.altnFuel.toFixed(1)}/----`, C.cyan, 0, 9.9, (v) => { st.altnFuel = v; }, { pre: (t) => t.replace(/\/.*$/, '') }),
          this.nf('L', 3, 'FINAL/TIME', `${st.final.toFixed(1)}/0030`, C.cyan, 0, 9.9, (v) => { st.final = v; }, { pre: (t) => t.replace(/\/.*$/, '') }),
          F({ s: 'R', n: 3, label: 'EXTRA/TIME', show: `${Math.max(0, ti.fob - st.taxi - ti.trip - ti.rsv - st.altnFuel - st.final).toFixed(1)}/----`, col: C.green }),
          { s: 'L', n: 4, label: 'ZFW/ZFWCG', show: `${st.zfw.toFixed(1)}/${st.zfwcg.toFixed(1)}`, col: C.cyan, copy: `${st.zfw.toFixed(1)}/${st.zfwcg.toFixed(1)}`,
            set: (t) => { const [a, b] = t.split('/'), z = this.num(a), g = b === undefined || b === '' ? st.zfwcg : this.num(b); if (!Number.isFinite(z) || !Number.isFinite(g)) return E_FMT; if (z < 30 || z > 80 || g < 10 || g > 50) return E_RANGE; st.zfw = z; st.zfwcg = g; } },
          this.nf('R', 4, 'BLOCK', (st.block || ti.fob).toFixed(1), C.cyan, 0, fm.spec.fuelCap / 1000, (v) => { st.block = v; }),
          F({ s: 'L', n: 5, label: 'TOW/LW', show: `${(fm.totalMass / 1000).toFixed(1)}/---.-`, col: C.green }),
        ] };
        return { t: 'INIT', sub: '1/2', slew: 'h', f: [
          { s: 'L', n: 1, label: 'CO RTE', show: st.coRte || '----------', col: C.cyan, set: (t) => { if (!/^[A-Z0-9]{1,10}$/.test(t)) return E_FMT; st.coRte = t; }, clr: () => { st.coRte = ''; }, copy: st.coRte || undefined },
          { s: 'R', n: 1, label: 'FROM/TO', show: st.fromTo || `----/${d.dest?.id ?? '----'}`, col: C.cyan, set: (t) => { if (!/^[A-Z]{4}\/[A-Z]{4}$/.test(t)) return E_FMT; st.fromTo = t; }, clr: () => { st.fromTo = ''; } },
          { s: 'L', n: 2, label: 'ALTN/CO RTE', show: st.altn || '----/---------', col: C.cyan, set: (t) => { if (!/^[A-Z]{4}(\/[A-Z0-9]{1,10})?$/.test(t)) return E_FMT; st.altn = t; }, clr: () => { st.altn = ''; } },
          { s: 'L', n: 3, label: 'FLT NBR', show: st.flt || '--------', col: C.cyan, copy: st.flt || undefined, set: (t) => { if (!/^[A-Z0-9]{1,8}$/.test(t)) return E_FMT; st.flt = t; }, clr: () => { st.flt = ''; } },
          F({ s: 'R', n: 3, label: 'LAT', show: ll.lat, col: C.green }), F({ s: 'R', n: 4, label: 'LONG', show: ll.lon, col: C.green }),
          this.nf('L', 5, 'COST INDEX', String(st.ci), C.cyan, 0, 999, (v) => { st.ci = v; }, { int: true }),
          { s: 'R', n: 5, label: 'CRZ FL/TEMP', show: `FL${st.crz}/${isa > 0 ? '+' : ''}${isa}°`, col: C.cyan, copy: `FL${st.crz}`,
            set: (t) => { const v = this.num(this.fl(t)); if (!Number.isFinite(v)) return E_FMT; const fl = v >= 1000 ? v / 100 : v; if (fl < 100 || fl > 390) return E_RANGE; this.setCrz(fl); } },
          this.nf('L', 6, 'TROPO', String(st.tropo), C.cyan, 1000, 60000, (v) => { st.tropo = Math.round(v); }, { int: true }),
          F({ s: 'R', n: 6, show: 'ALIGN IRS>', col: C.cyan, go: () => this.setMsg('IRS ALIGNED') }),
        ] };
      }

      case 'F-PLN': {
        this.sub = Math.min(this.sub, Math.max(0, rt.length - 1));
        const pos = h.position(), dist = this.routeDist(rt, pos), f: Fld[] = [F({ s: 'L', n: 1, label: 'FROM', show: 'PPOS', col: C.white }), F({ s: 'R', n: 1, show: `${pad(((d.hdg % 360) + 360) % 360, 3)}°`, col: C.green })];
        for (let n = 2; n <= 6; n++) {
          const i = this.sub + n - 2, w = rt[i];
          if (!w) { if (i === rt.length) f.push(F({ s: 'L', n, show: '-----END OF F-PLN-----', col: C.white })); break; }
          f.push({ s: 'L', n, label: i === 0 ? 'TO' : undefined, show: w.name + (this.ovfly.has(w.name) ? ' o' : ''), col: i === 0 ? C.mag : C.green,
            sel: () => { if (this.ovflyArm) { if (this.ovfly.has(w.name)) this.ovfly.delete(w.name); else this.ovfly.add(w.name); this.ovflyArm = false; this.msg = ''; } else { this.latIdx = i; this.page = 'LATREV'; } } });
          f.push(F({ s: 'R', n, label: n === 2 ? 'DIST' : undefined, show: `${Math.round(dist[i])}`, col: C.white }));
        }
        return { t: 'F-PLN', slew: 'v', f };
      }
      case 'LATREV': {
        const w = rt[this.latIdx];
        return { t: `LAT REV FROM ${w ? w.name : '----'}`, f: [
          F({ s: 'L', n: 1, show: '<HOLD', col: C.cyan, go: () => this.setMsg(E_NA) }), F({ s: 'L', n: 2, show: '<OFFSET', col: C.cyan, go: () => this.setMsg(E_NA) }),
          F({ s: 'R', n: 1, show: 'DIR TO>', col: C.cyan, go: () => this.directTo(this.latIdx) }),
          F({ s: 'L', n: 6, show: '<RETURN', col: C.cyan, go: go('F-PLN') })] };
      }
      case 'DIR': {
        const f: Fld[] = [{ s: 'L', n: 1, label: 'DIR TO', show: '[    ]', col: C.cyan, set: (t) => { const k = rt.findIndex((w) => w.name.toUpperCase() === t); if (k < 0) return 'NOT IN DATABASE'; this.directTo(k); } }];
        for (let n = 2; n <= 6; n++) { const i = this.sub + n - 2, w = rt[i]; if (w) f.push(F({ s: 'L', n, show: w.name, col: i === 0 ? C.mag : C.green, sel: () => this.directTo(i) })); }
        return { t: 'DIR TO', slew: 'v', f };
      }
      case 'SEC': {
        const f: Fld[] = [F({ s: 'L', n: 1, show: '<COPY ACTIVE', col: C.cyan, go: () => { this.sec = true; this.setMsg('SEC F-PLN COPIED'); } }), F({ s: 'L', n: 2, show: '<INIT', col: C.cyan, go: go('INIT') })];
        if (this.sec) rt.slice(0, 3).forEach((w, i) => f.push(F({ s: 'L', n: 3 + i, show: w.name, col: C.green })));
        return { t: 'SEC F-PLN', f: this.sec ? f : [...f, F({ s: 'L', n: 4, show: 'SECONDARY F-PLN NOT CREATED', col: C.white })] };
      }

      case 'RADNAV': {
        const ident = (t: string, lo: number, hi: number) => { if (/^[A-Z]{2,4}$/.test(t)) return t; const v = this.num(t); return Number.isFinite(v) && v >= lo && v <= hi ? v.toFixed(2) : null; };
        const mk = (s: 'L' | 'R', n: number, label: string, key: 'vor1' | 'vor2' | 'adf1' | 'adf2' | 'ls', lo: number, hi: number, dflt: string, colr = C.cyan): Fld => ({
          s, n, label, show: st[key] || dflt, col: colr, copy: st[key] || undefined, clr: () => { st[key] = ''; },
          set: (t) => { const k = ident(t, lo, hi); if (k === null) return /^[0-9.]+$/.test(t) ? E_RANGE : E_FMT; st[key] = k; } });
        const crs = (s: 'L' | 'R', n: number, key: 'vor1c' | 'vor2c' | 'lsc'): Fld => this.nf(s, n, 'CRS', st[key] >= 0 ? pad(st[key], 3) : '[ ]', C.cyan, 0, 360, (v) => { st[key] = Math.round(v) % 360; }, { int: true, clr: () => { st[key] = -1; } });
        const ils = d.ils && d.ils.valid ? d.ils : null;
        return { t: 'RADIO NAV', f: [
          mk('L', 1, 'VOR1/FREQ', 'vor1', 108, 117.95, '[ ]/[   ]'), mk('R', 1, 'FREQ/VOR2', 'vor2', 108, 117.95, '[   ]/[ ]'), crs('L', 2, 'vor1c'), crs('R', 2, 'vor2c'),
          ils ? F({ s: 'L', n: 3, label: 'LS /FREQ', show: `${ils.ident}/AUTO`, col: C.mag, clr: () => { st.ls = ''; } }) : mk('L', 3, 'LS /FREQ', 'ls', 108.1, 111.95, '[ ]/[    ]', C.mag),
          ils ? F({ s: 'L', n: 4, label: 'CRS', show: pad(((d.apHdg % 360) + 360) % 360, 3), col: C.green }) : crs('L', 4, 'lsc'),
          mk('L', 5, 'ADF1/FREQ', 'adf1', 190, 1750, '[ ]/[   ]'), mk('R', 5, 'FREQ/ADF2', 'adf2', 190, 1750, '[   ]/[ ]')] };
      }

      case 'FUEL': return { t: 'FUEL PRED', f: [
        F({ s: 'L', n: 1, label: 'AT', show: d.dest?.id ?? '----', col: C.green }), F({ s: 'R', n: 1, label: 'EFOB', show: d.dest ? (ti.fob - ti.trip).toFixed(1) : '---.-', col: C.green }),
        F({ s: 'L', n: 2, label: 'FOB', show: ti.fob.toFixed(1), col: C.green }), F({ s: 'R', n: 2, label: 'FLOW', show: `${Math.round(ti.flowKgH)} KG/H`, col: C.green }),
        F({ s: 'L', n: 3, label: 'RTE RSV', show: ti.rsv.toFixed(1), col: C.cyan }), F({ s: 'R', n: 3, label: 'FINAL', show: st.final.toFixed(1), col: C.cyan }),
        F({ s: 'L', n: 4, label: 'GW', show: (fm.totalMass / 1000).toFixed(1), col: C.green }), F({ s: 'R', n: 4, label: 'ZFW', show: st.zfw.toFixed(1), col: C.green }),
        F({ s: 'L', n: 6, show: '<INIT', col: C.cyan, go: go('INIT', 1) })] };

      case 'PROG': {
        const wp = d.activeWp, utc = c.utc, eta = d.dest ? `${pad((utc.getUTCHours() + Math.floor((d.dest.eteMin + utc.getUTCMinutes()) / 60)) % 24, 2)}${pad((utc.getUTCMinutes() + d.dest.eteMin) % 60, 2)}` : '----';
        return { t: 'PROG', sub: `FL${Math.round(d.altFt / 100)}`, f: [
          this.nf('L', 1, 'CRZ', `FL${st.crz}`, C.cyan, 100, 390, (v) => this.setCrz(v), { pre: (t) => this.fl(t) }), F({ s: 'R', n: 1, label: 'OPT    REC MAX', show: `FL${st.crz}  --- FL390`, col: C.green }),
          F({ s: 'L', n: 2, label: 'TO', show: d.dest?.id ?? '----', col: C.green }), F({ s: 'R', n: 2, label: 'DIST    EFOB', show: d.dest ? `${d.dest.distNm.toFixed(0)}   ${(ti.fob - ti.trip).toFixed(1)}` : '---', col: C.green }),
          F({ s: 'L', n: 3, label: 'NEXT WPT', show: wp?.name ?? '----', col: C.mag }), F({ s: 'R', n: 3, label: 'DIST', show: wp ? `${wp.distNm.toFixed(0)}NM` : '---', col: C.green }),
          F({ s: 'R', n: 4, label: 'ETA', show: eta, col: C.green })] };
      }

      case 'PERF': {
        const ph = st.perfPhase, flapsTxt = ['0', '1', '2', '3', 'FULL'][fm.ctl.flapsIdx] ?? '1', econ = d.altFt < 10000 ? '250' : d.altFt < 25000 ? '300' : '.78';
        const nav: Fld[] = [F({ s: 'L', n: 6, show: '<PHASE', col: C.white, go: () => { st.perfPhase = (ph + 5) % 6; } }), F({ s: 'R', n: 6, show: 'NEXT PHASE>', col: C.white, go: () => { st.perfPhase = (ph + 1) % 6; } })];
        const spd = (s: 'L' | 'R', n: number, label: string, key: 'v1' | 'vr' | 'v2'): Fld => this.nf(s, n, label, st[key] ? String(st[key]) : '[ ]', C.cyan, 90, 200, (v) => { st[key] = Math.round(v); }, { int: true, clr: () => { st[key] = 0; } });
        const redAcc = (s: 'L' | 'R', n: number, label: string, a: 'thrRed' | 'goaThrRed', b: 'acc' | 'goaAcc'): Fld => ({ s, n, label, show: `${st[a]}/${st[b]}`, col: C.cyan, copy: `${st[a]}/${st[b]}`, set: (t) => { const [x, y] = t.split('/'), p = this.num(x), q = y === undefined || y === '' ? p : this.num(y); if (!Number.isFinite(p) || !Number.isFinite(q)) return E_FMT; if (p < 400 || q < 400 || p > 15000 || q > 15000) return E_RANGE; st[a] = Math.round(p); st[b] = Math.round(q); } });
        const ci = this.nf('L', 2, 'COST INDEX', String(st.ci), C.cyan, 0, 999, (v) => { st.ci = v; }, { int: true });
        switch (ph) {
          case 0: return { t: PERF_PHASES[0], sub: 'ACTIVE', slew: 'h', f: [spd('L', 1, 'V1', 'v1'), spd('L', 2, 'VR', 'vr'), spd('L', 3, 'V2', 'v2'),
            this.nf('L', 4, 'TRANS ALT', String(st.trans), C.cyan, 1000, 18000, (v) => { st.trans = Math.round(v); }, { int: true }),
            { s: 'R', n: 1, label: 'FLAP/THS', show: `${flapsTxt}/UP0.0`, col: C.cyan, set: (t) => { const v = this.num(t.replace(/\/.*$/, '')); if (!Number.isInteger(v)) return E_FMT; if (v < 0 || v > 3) return E_RANGE; st.toConf = v; } },
            { s: 'R', n: 2, label: 'FLEX TO TEMP', show: st.flex ? `${st.flex}°` : '[ ]', col: C.cyan, copy: st.flex ? String(st.flex) : undefined, set: (t) => { const v = this.num(t); if (!Number.isFinite(v)) return E_FMT; if (v < 0 || v > 70) return E_RANGE; st.flex = Math.round(v); }, clr: () => { st.flex = 0; } },
            redAcc('R', 3, 'THR RED/ACC', 'thrRed', 'acc'), this.nf('R', 4, 'ENG OUT ACC', String(st.engOutAcc), C.cyan, 400, 15000, (v) => { st.engOutAcc = Math.round(v); }, { int: true }),
            F({ s: 'L', n: 5, label: 'GW', show: (fm.totalMass / 1000).toFixed(1), col: C.green }), ...nav] };
          case 1: return { t: PERF_PHASES[1], sub: ph === this.autoPhase() ? 'ACTIVE' : 'PREVIEW', slew: 'h', f: [F({ s: 'L', n: 1, label: 'ACT MODE', show: 'MANAGED', col: C.green }), ci, F({ s: 'R', n: 1, label: 'MANAGED SPD', show: econ, col: C.mag }), F({ s: 'R', n: 2, label: 'EXPEDITE', show: 'FCU>', col: C.white }), ...nav] };
          case 2: return { t: PERF_PHASES[2], sub: ph === this.autoPhase() ? 'ACTIVE' : 'PREVIEW', slew: 'h', f: [this.nf('L', 1, 'CRZ FL', `FL${st.crz}`, C.cyan, 100, 390, (v) => this.setCrz(v), { pre: (t) => this.fl(t) }), ci, F({ s: 'R', n: 1, label: 'MANAGED SPD', show: d.altFt > 25000 ? '.78' : '300', col: C.mag }), ...nav] };
          case 3: return { t: PERF_PHASES[3], sub: ph === this.autoPhase() ? 'ACTIVE' : 'PREVIEW', slew: 'h', f: [F({ s: 'L', n: 1, label: 'ACT MODE', show: 'MANAGED', col: C.green }), ci, F({ s: 'R', n: 1, label: 'MANAGED SPD', show: d.altFt > 25000 ? '.78' : d.altFt > 10000 ? '300' : '250', col: C.mag }), ...nav] };
          case 4: return { t: PERF_PHASES[4], sub: ph === this.autoPhase() ? 'ACTIVE' : 'PREVIEW', slew: 'h', f: [
            { s: 'L', n: 1, label: 'QNH', show: String(st.qnh), col: C.cyan, copy: String(st.qnh), set: (t) => { const v = this.num(t); if (!Number.isFinite(v)) return E_FMT; if (v >= 28 && v <= 31) { st.qnh = Math.round(v * 33.8639); return; } if (v < 900 || v > 1100) return E_RANGE; st.qnh = Math.round(v); } },
            this.nf('R', 1, 'TEMP', `${st.temp}°`, C.cyan, -80, 60, (v) => { st.temp = Math.round(v); }, { pre: (t) => t.replace(/°/g, '') }),
            { s: 'L', n: 2, label: 'MAG WIND', show: st.wind || '---/---', col: C.cyan, copy: st.wind || undefined, set: (t) => { const m = /^(\d{1,3})\/(\d{1,3})$/.exec(t); if (!m) return E_FMT; if (+m[1] > 360 || +m[2] > 250) return E_RANGE; st.wind = `${pad(+m[1], 3)}/${pad(+m[2], 3)}`; }, clr: () => { st.wind = ''; } },
            this.nf('L', 3, 'TRANS ALT', String(st.trans), C.cyan, 1000, 18000, (v) => { st.trans = Math.round(v); }, { int: true }),
            this.nf('R', 3, 'BARO', st.mda ? String(st.mda) : '[ ]', C.cyan, 0, 5000, (v) => { st.mda = Math.round(v); }, { int: true, clr: () => { st.mda = 0; } }),
            this.nf('R', 4, 'RADIO', st.dh ? String(st.dh) : 'NO', C.cyan, 0, 700, (v) => { st.dh = Math.round(v); }, { int: true, clr: () => { st.dh = 0; } }),
            this.nf('L', 5, 'VAPP', String(st.vapp || Math.round(d.vSpeeds ? d.vSpeeds.vapp : speeds(h).vls + 5)), st.vapp ? C.cyan : C.green, 90, 200, (v) => { st.vapp = Math.round(v); }, { int: true, clr: () => { st.vapp = 0; } }),
            F({ s: 'R', n: 5, label: 'LDG CONF', show: st.ldgFull ? 'FULL>' : '3>', col: C.cyan, go: () => { st.ldgFull = !st.ldgFull; } }), ...nav] };
          default: return { t: PERF_PHASES[5], slew: 'h', f: [redAcc('L', 1, 'THR RED/ACC', 'goaThrRed', 'goaAcc'), F({ s: 'R', n: 1, label: 'ENG OUT ACC', show: String(st.engOutAcc), col: C.green }), ...nav] };
        }
      }

      case 'DATA': {
        if (this.sub === 1) return { t: 'DATA INDEX', sub: '2/2', slew: 'h', f: [F({ s: 'L', n: 1, show: '<WAYPOINTS', col: C.cyan, go: () => this.setMsg(E_NA) }), F({ s: 'L', n: 2, show: '<NAVAIDS', col: C.cyan, go: () => this.setMsg(E_NA) }), F({ s: 'L', n: 3, show: '<RUNWAYS', col: C.cyan, go: () => this.setMsg(E_NA) })] };
        return { t: 'DATA INDEX', sub: '1/2', slew: 'h', f: [F({ s: 'L', n: 1, show: '<POSITION MONITOR', col: C.green, go: go('POS') }), F({ s: 'L', n: 2, show: '<IRS MONITOR', col: C.green, go: go('IRS') }),
          F({ s: 'L', n: 3, show: '<GPS MONITOR', col: C.green, go: go('GPS') }), F({ s: 'L', n: 4, show: '<A/C STATUS', col: C.green, go: go('STATUS') })] };
      }
      case 'POS': { const ll = this.latLon(); return { t: 'POSITION MONITOR', f: [F({ s: 'L', n: 1, label: 'FMGC', show: ll.lat, col: C.green }), F({ s: 'R', n: 1, show: ll.lon, col: C.green }), F({ s: 'L', n: 2, label: 'GPIRS', show: ll.lat, col: C.green }), F({ s: 'R', n: 2, show: ll.lon, col: C.green }), F({ s: 'L', n: 6, show: '<RETURN', col: C.cyan, go: go('DATA') })] }; }
      case 'IRS': {
        const st3 = ['OFF', 'NAV', 'ATT'], r = (i: number) => st3[c.sys.get(`IR${i}ModeKnb`, 1)] ?? 'NAV', ll = this.latLon();
        return { t: 'IRS MONITOR', f: [F({ s: 'L', n: 1, label: 'IRS1', show: r(1), col: r(1) === 'OFF' ? C.amber : C.green }), F({ s: 'R', n: 1, show: ll.lat + ' ' + ll.lon, col: C.green }), F({ s: 'L', n: 2, label: 'IRS2', show: r(2), col: r(2) === 'OFF' ? C.amber : C.green }),
          F({ s: 'L', n: 3, label: 'IRS3', show: r(3), col: r(3) === 'OFF' ? C.amber : C.green }), F({ s: 'L', n: 6, show: '<RETURN', col: C.cyan, go: go('DATA') })] };
      }
      case 'GPS': { const ll = this.latLon(); return { t: 'GPS MONITOR', f: [F({ s: 'L', n: 1, label: 'GPS1', show: 'NAV', col: C.green }), F({ s: 'R', n: 1, show: ll.lat, col: C.green }), F({ s: 'L', n: 2, label: 'GPS2', show: 'NAV', col: C.green }), F({ s: 'R', n: 2, show: ll.lon, col: C.green }), F({ s: 'L', n: 6, show: '<RETURN', col: C.cyan, go: go('DATA') })] }; }
      case 'STATUS': return { t: 'A/C STATUS', f: [F({ s: 'L', n: 1, label: 'ENG', show: 'CFM56-5B4/P', col: C.green }), F({ s: 'L', n: 2, label: 'A/C', show: 'A320-214', col: C.green }), F({ s: 'L', n: 3, label: 'FLT NBR', show: st.flt || '--------', col: C.green }), F({ s: 'L', n: 6, show: '<RETURN', col: C.cyan, go: go('DATA') })] };
      case 'AIRPORT': return { t: 'AIRPORT', f: [F({ s: 'L', n: 1, label: 'DEST', show: d.dest?.id ?? '----', col: C.green }), F({ s: 'R', n: 1, label: d.dest ? 'DIST' : undefined, show: d.dest ? `${d.dest.distNm.toFixed(0)}NM` : '', col: C.green }),
        F({ s: 'L', n: 2, label: 'NAME', show: (d.dest?.name ?? '').slice(0, 24), col: C.white }), F({ s: 'L', n: 3, label: 'ETE', show: d.dest ? this.hhmm(d.dest.eteMin) : '----', col: C.green })] };
    }
    return { t: this.page, f: [] };
  }

  // ------------------------------------------------------------------ drawing: 14 lines x 24 characters on a 1000 x 1000 square
  draw(g: G, W: number, H: number, c: Ctx) {
    g.setTransform(W / 1000, 0, 0, H / 1000, 0, 0); g.fillStyle = '#04070b'; g.fillRect(0, 0, 1000, 1000);
    if (!c.sys.ac && !c.sys.acEss) return;
    this.ctx = c; if (!this.host) this.host = c.host;
    const ROW = 68, Y0 = 36, yData = (n: number) => Y0 + ROW * 2 * n;
    const T = (s: string, x: number, y: number, px: number, col: string, al: CanvasTextAlign) => { g.font = `bold ${px}px ${M}`; g.fillStyle = col; g.textAlign = al; g.textBaseline = 'middle'; g.fillText(s, x, y); };
    const v = this.view(c);
    T(v.t, 500, Y0, 56, C.white, 'center'); if (v.sub) T(v.sub, 975, Y0, 42, C.white, 'right');
    for (const f of v.f) {
      const x = f.s === 'L' ? 25 : 975, al: CanvasTextAlign = f.s === 'L' ? 'left' : 'right', y = yData(f.n);
      if (f.label) T(f.label, x + (f.s === 'L' ? 30 : -30), y - ROW, 38, C.white, al);
      T(f.show, x, y, 58, f.col, al);
    }
    // scratchpad (line 14) – amber message, else the typed text with a blinking cursor
    g.strokeStyle = '#223'; g.lineWidth = 2; g.beginPath(); g.moveTo(20, 888); g.lineTo(980, 888); g.stroke();
    const blink = Math.floor(c.t * 2) % 2 ? '_' : ' ';
    if (this.msg) T(this.msg, 25, Y0 + ROW * 13, 58, C.amber, 'left'); else T(this.scratch + (this.scratch === 'CLR' ? '' : blink), 25, Y0 + ROW * 13, 58, C.white, 'left');
    if (v.slew) T((v.slew.includes('v') ? '↓↑' : '') + (v.slew.includes('h') && !v.slew.includes('v') ? '←→' : ''), 975, Y0 + ROW * 13, 52, C.white, 'right');
    if (this.brt < 1) { g.fillStyle = `rgba(0,0,0,${(1 - this.brt) * 0.85})`; g.fillRect(0, 0, 1000, 1000); }
  }
}
