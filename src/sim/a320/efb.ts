// Captain-side Electronic Flight Bag (EFB): an interactive flight guide drawn on the tablet mounted at the left sliding window.
// Pages: FLIGHT PLAN · CHECKLIST · AIRPORTS · RADIO · WEATHER · PROCEDURES. All content is live (route, checklist state, METAR, airport data).
import type { Airport } from '../../data/airports';
import { frequenciesFor } from '../../data/airports';
import type { LiveWx } from '../liveWeather';

export interface EfbChecklistItem { id: string; label: string; detail: string; done: boolean; phase: string }
export interface EfbInfo {
  dep: Airport; arr: Airport; depRwy: string; arrRwy: string; callsign: string; phase: string;
  wx: LiveWx | null; windFrom: number; windKt: number; qnh: number; oatC: number;
  route: { name: string; type: string; distNm: number }[]; activeWp: number;
  checklist: EfbChecklistItem[]; toggle(id: string): void;
  fuelKg: number; distNm: number; eteMin: number; utcMs: number;
}
type Page = 'PLAN' | 'CHECK' | 'APT' | 'RADIO' | 'WX' | 'PROC';
const PAGES: { id: Page; label: string }[] = [{ id: 'PLAN', label: 'FLIGHT PLAN' }, { id: 'CHECK', label: 'CHECKLIST' }, { id: 'APT', label: 'AIRPORTS' }, { id: 'RADIO', label: 'RADIO' }, { id: 'WX', label: 'WEATHER' }, { id: 'PROC', label: 'PROCEDURES' }];
const PHASES = ['taxi', 'takeoff', 'climb', 'cruise', 'descent', 'final', 'rollout'];

const PROCEDURES: { title: string; steps: string[] }[] = [
  { title: 'COCKPIT PREPARATION', steps: ['BAT 1 + 2 ........ AUTO (check 25.5 V min)', 'EXT PWR / APU MASTER + START ... AVAIL', 'APU BLEED ........ ON', 'BEACON ........... ON', 'Set QNH, FCU, MCDU INIT / PERF'] },
  { title: 'ENGINE START (AUTO)', steps: ['ENG MODE selector ... IGN/START', 'ENG MASTER 2 ......... ON (then 1)', 'Monitor N2, EGT, fuel flow, oil pressure', 'ENG MODE selector ... NORM', 'APU BLEED .......... OFF, packs ON'] },
  { title: 'BEFORE TAKE-OFF', steps: ['FLAPS ............ CONF 1+F or 2 (as per performance)', 'Autobrake ......... MAX, SPOILERS ARM', 'T.O CONFIG ........ TEST (no memo)', 'Strobes ON · Landing lights ON · Nose T.O.', 'Rudder / pitch trim ... check'] },
  { title: 'TAKE-OFF', steps: ['Thrust levers .... FLX / TOGA, check N1', 'At 80 kt ........ "CHECK" · V1 ... hands off thrust', 'VR (~140 kt) .... rotate smoothly ~3°/s to 15°', 'Positive rate ... GEAR UP', '1000 ft AGL ..... AP on · 3000 ft: accelerate, flaps up on schedule'] },
  { title: 'CLIMB / CRUISE', steps: ['Climb thrust (CL detent), 250 kt below FL100', 'QNH → STD at transition altitude', 'Cruise: managed speed ~M0.78', 'Monitor fuel and ECAM SD pages'] },
  { title: 'DESCENT / APPROACH', steps: ['Landing elevation / QNH set, LS pushbutton ON', 'Below FL100: 250 kt · Flaps 1 at S speed', 'FLAPS 2 .. GEAR DOWN .. FLAPS 3 / FULL', 'Spoilers ARMED · autobrake LO/MED', 'VAPP = VLS + wind correction, stabilised by 1000 ft AGL'] },
  { title: 'LANDING / ROLLOUT', steps: ['Flare at 30 ft, thrust levers IDLE', 'Ground spoilers extend, autobrake decelerates', 'Reverse thrust (REV IDLE / MAX) as required', 'Below 70 kt: reverse idle · vacate runway', 'After landing: flaps up, spoilers disarm, strobes off'] },
  { title: 'EMERGENCY', steps: ['Engine fire: THR LEVER idle → ENG MASTER OFF → FIRE pb → AGENT 1 → AGENT 2', 'Dual hydraulic loss: RAT MAN ON, use gravity gear', 'Cabin altitude warning: MASK, descend to FL100 / MEA', 'Stall: nose down, TOGA, wings level – protections active'] },
];

const bearing = (a: number, b: number, c: number, d: number) => {
  const r = Math.PI / 180, y = Math.sin((d - b) * r) * Math.cos(c * r), x = Math.cos(a * r) * Math.sin(c * r) - Math.sin(a * r) * Math.cos(c * r) * Math.cos((d - b) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
};
const pad3 = (n: number) => String(Math.round(n) % 360 || 360).padStart(3, '0');

export class Efb {
  page: Page = 'PLAN';
  /** scroll offsets per page (rows) */ private scroll: Record<Page, number> = { PLAN: 0, CHECK: 0, APT: 0, RADIO: 0, WX: 0, PROC: 0 };
  private phaseFilter = -1; private apt = 0;
  private com = { active: 118.1, stby: 121.5 };
  private hits: { x: number; y: number; w: number; h: number; tip: string; fn: () => void }[] = [];
  private lastInfo: EfbInfo | null = null;
  dirty = true; static readonly W = 1024; static readonly H = 768;

  /** Click at normalised screen coordinates (0..1, origin top-left). Returns true if a button was hit. */
  click(u: number, v: number): boolean { const h = this.at(u, v); if (!h) return false; h.fn(); this.dirty = true; return true; }
  hover(u: number, v: number): string | null { return this.at(u, v)?.tip ?? null; }
  wheel(dy: number) { this.scroll[this.page] = Math.max(0, this.scroll[this.page] + (dy > 0 ? 1 : -1)); this.dirty = true; }
  private at(u: number, v: number) { const x = u * Efb.W, y = v * Efb.H; for (let i = this.hits.length - 1; i >= 0; i--) { const h = this.hits[i]; if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h; } return null; }
  private btn(x: number, y: number, w: number, h: number, tip: string, fn: () => void) { this.hits.push({ x, y, w, h, tip, fn }); }

  draw(g: CanvasRenderingContext2D, info: EfbInfo | null, day: number) {
    const W = Efb.W, H = Efb.H; this.hits = []; this.lastInfo = info;
    const bg = day > 0.5 ? '#0e1726' : '#070c14', panel = '#16233a', accent = '#35c2ff', txt = '#e8f0ff', dim = '#7f93b3';
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    // status bar
    g.fillStyle = '#0a1018'; g.fillRect(0, 0, W, 44);
    g.fillStyle = txt; g.font = 'bold 22px sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillText('✈ A320 EFB', 18, 23);
    g.textAlign = 'right'; g.fillStyle = dim; g.font = '20px monospace';
    if (info) { const d = new Date(info.utcMs); g.fillText(`${info.callsign}   ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`, W - 18, 23); }
    // tab bar
    const tw = W / PAGES.length;
    PAGES.forEach((p, i) => {
      const act = p.id === this.page; g.fillStyle = act ? accent : panel; g.fillRect(i * tw + 2, 48, tw - 4, 46);
      g.fillStyle = act ? '#04121d' : txt; g.font = 'bold 19px sans-serif'; g.textAlign = 'center'; g.fillText(p.label, i * tw + tw / 2, 72);
      this.btn(i * tw, 48, tw, 46, `Open ${p.label}`, () => { this.page = p.id; });
    });
    g.textAlign = 'left';
    if (!info) { g.fillStyle = dim; g.font = '24px sans-serif'; g.fillText('Loading flight data…', 40, 160); return; }
    const body = { x: 20, y: 108, w: W - 40, h: H - 128 };
    switch (this.page) {
      case 'PLAN': this.drawPlan(g, info, body, { txt, dim, panel, accent }); break;
      case 'CHECK': this.drawCheck(g, info, body, { txt, dim, panel, accent }); break;
      case 'APT': this.drawApt(g, info, body, { txt, dim, panel, accent }); break;
      case 'RADIO': this.drawRadio(g, info, body, { txt, dim, panel, accent }); break;
      case 'WX': this.drawWx(g, info, body, { txt, dim, panel, accent }); break;
      case 'PROC': this.drawProc(g, body, { txt, dim, panel, accent }); break;
    }
    this.dirty = false;
  }

  private scrollBar(g: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }, total: number, rows: number, c: { panel: string; txt: string }, page: Page) {
    const maxS = Math.max(0, total - rows); this.scroll[page] = Math.min(this.scroll[page], maxS);
    if (maxS <= 0) return;
    for (const [i, lab] of ['▲', '▼'].entries()) {
      const x = b.x + b.w - 52, y = i === 0 ? b.y : b.y + b.h - 52;
      g.fillStyle = c.panel; g.fillRect(x, y, 52, 52); g.fillStyle = c.txt; g.font = 'bold 24px sans-serif'; g.textAlign = 'center'; g.fillText(lab, x + 26, y + 27); g.textAlign = 'left';
      this.btn(x, y, 52, 52, i === 0 ? 'Scroll up' : 'Scroll down (or use the mouse wheel)', () => { this.scroll[page] = Math.max(0, Math.min(maxS, this.scroll[page] + (i === 0 ? -1 : 1))); });
    }
  }

  private drawPlan(g: CanvasRenderingContext2D, i: EfbInfo, b: { x: number; y: number; w: number; h: number }, c: { txt: string; dim: string; panel: string; accent: string }) {
    g.fillStyle = c.panel; g.fillRect(b.x, b.y, b.w, 78);
    g.fillStyle = c.txt; g.font = 'bold 34px monospace'; g.fillText(`${i.dep.icao} → ${i.arr.icao}`, b.x + 18, b.y + 28);
    g.font = '19px sans-serif'; g.fillStyle = c.dim; g.fillText(`${i.dep.name}  →  ${i.arr.name}`.slice(0, 70), b.x + 18, b.y + 60);
    g.textAlign = 'right'; g.fillStyle = c.accent; g.font = 'bold 22px monospace';
    g.fillText(`DIST ${Math.round(i.distNm)} NM · ETE ${Math.floor(i.eteMin / 60)}h${String(Math.round(i.eteMin % 60)).padStart(2, '0')} · FUEL ${Math.round(i.fuelKg)} KG`, b.x + b.w - 14, b.y + 28); g.textAlign = 'left';
    g.font = '19px sans-serif'; g.fillStyle = c.dim; g.fillText(`DEP RWY ${i.depRwy || '—'}   ·   ARR RWY ${i.arrRwy || '—'}   ·   PHASE ${i.phase.toUpperCase()}`, b.x + 400, b.y + 60);
    const top = b.y + 92, rowH = 44, rows = Math.floor((b.h - 92) / rowH);
    g.fillStyle = c.dim; g.font = 'bold 16px sans-serif'; g.fillText('WAYPOINT', b.x + 60, top + 10); g.fillText('TYPE', b.x + 340, top + 10); g.fillText('DIST TO GO', b.x + 520, top + 10);
    this.scrollBar(g, { x: b.x, y: top, w: b.w, h: b.h - 92 }, i.route.length, rows - 1, c, 'PLAN');
    for (let r = 0; r < rows - 1; r++) {
      const idx = r + this.scroll.PLAN; const wp = i.route[idx]; if (!wp) break; const y = top + 26 + r * rowH;
      const act = idx === i.activeWp, past = idx < i.activeWp;
      g.fillStyle = act ? '#12384f' : r % 2 ? '#101a2c' : '#0d1626'; g.fillRect(b.x, y, b.w - 60, rowH - 4);
      g.fillStyle = past ? '#47c06a' : act ? '#ff5bd1' : c.txt; g.font = 'bold 22px monospace'; g.fillText(past ? '✓' : act ? '►' : String(idx + 1), b.x + 14, y + 22);
      g.fillStyle = past ? c.dim : c.txt; g.fillText(wp.name.slice(0, 18), b.x + 60, y + 22);
      g.font = '18px sans-serif'; g.fillStyle = c.dim; g.fillText(wp.type.toUpperCase(), b.x + 340, y + 22);
      g.fillStyle = act ? '#ff5bd1' : c.txt; g.font = '20px monospace'; g.fillText(past ? '—' : `${wp.distNm.toFixed(1)} NM`, b.x + 520, y + 22);
    }
  }

  private drawCheck(g: CanvasRenderingContext2D, i: EfbInfo, b: { x: number; y: number; w: number; h: number }, c: { txt: string; dim: string; panel: string; accent: string }) {
    const cur = Math.max(0, PHASES.indexOf(i.phase)); if (this.phaseFilter < 0) this.phaseFilter = cur;
    const bw = b.w / PHASES.length;
    PHASES.forEach((p, k) => {
      const act = k === this.phaseFilter, items = i.checklist.filter((x) => x.phase === p), done = items.filter((x) => x.done).length;
      g.fillStyle = act ? c.accent : c.panel; g.fillRect(b.x + k * bw + 2, b.y, bw - 4, 46);
      g.fillStyle = act ? '#04121d' : k === cur ? '#ffd24a' : c.txt; g.font = 'bold 16px sans-serif'; g.textAlign = 'center'; g.fillText(p.toUpperCase(), b.x + k * bw + bw / 2, b.y + 15);
      g.font = '15px monospace'; g.fillText(`${done}/${items.length}`, b.x + k * bw + bw / 2, b.y + 34); g.textAlign = 'left';
      this.btn(b.x + k * bw, b.y, bw, 46, `Show ${p} checklist`, () => { this.phaseFilter = k; this.scroll.CHECK = 0; });
    });
    const items = i.checklist.filter((x) => x.phase === PHASES[this.phaseFilter]);
    const rowH = 72, top = b.y + 58, rows = Math.floor((b.h - 58) / rowH);
    this.scrollBar(g, { x: b.x, y: top, w: b.w, h: b.h - 58 }, items.length, rows, c, 'CHECK');
    if (!items.length) { g.fillStyle = c.dim; g.font = '22px sans-serif'; g.fillText('No items for this phase.', b.x + 20, top + 30); }
    for (let r = 0; r < rows; r++) {
      const it = items[r + this.scroll.CHECK]; if (!it) break; const y = top + r * rowH;
      g.fillStyle = r % 2 ? '#101a2c' : '#0d1626'; g.fillRect(b.x, y, b.w - 60, rowH - 6);
      g.strokeStyle = it.done ? '#47c06a' : c.dim; g.lineWidth = 3; g.strokeRect(b.x + 14, y + 17, 34, 34);
      if (it.done) { g.fillStyle = '#47c06a'; g.font = 'bold 32px sans-serif'; g.fillText('✓', b.x + 18, y + 36); }
      g.fillStyle = it.done ? c.dim : c.txt; g.font = 'bold 22px sans-serif'; g.fillText(it.label.slice(0, 60), b.x + 66, y + 24);
      g.fillStyle = c.dim; g.font = '17px sans-serif'; g.fillText(it.detail.slice(0, 92), b.x + 66, y + 50);
      this.btn(b.x, y, b.w - 60, rowH - 6, 'Tick / untick checklist item', () => i.toggle(it.id));
    }
  }

  private drawApt(g: CanvasRenderingContext2D, i: EfbInfo, b: { x: number; y: number; w: number; h: number }, c: { txt: string; dim: string; panel: string; accent: string }) {
    const aps = [i.dep, i.arr];
    aps.forEach((a, k) => { const act = k === this.apt; g.fillStyle = act ? c.accent : c.panel; g.fillRect(b.x + k * (b.w / 2) + 2, b.y, b.w / 2 - 4, 46); g.fillStyle = act ? '#04121d' : c.txt; g.font = 'bold 22px sans-serif'; g.textAlign = 'center'; g.fillText(`${k ? 'ARRIVAL' : 'DEPARTURE'} · ${a.icao}`, b.x + k * (b.w / 2) + b.w / 4, b.y + 24); g.textAlign = 'left'; this.btn(b.x + k * (b.w / 2), b.y, b.w / 2, 46, `Show ${k ? 'arrival' : 'departure'} airport`, () => { this.apt = k; this.scroll.APT = 0; }); });
    const a = aps[this.apt], sel = this.apt ? i.arrRwy : i.depRwy; let y = b.y + 64;
    g.fillStyle = c.txt; g.font = 'bold 30px sans-serif'; g.fillText(a.name.slice(0, 44), b.x + 6, y + 10); y += 36;
    g.fillStyle = c.dim; g.font = '20px sans-serif'; g.fillText(`${a.city ? a.city + ', ' : ''}${a.country}  ·  IATA ${a.iata || '—'}  ·  ELEV ${Math.round(a.elev * 3.28084)} ft  ·  ${a.lat.toFixed(3)}°, ${a.lon.toFixed(3)}°`, b.x + 6, y + 10); y += 40;
    g.fillStyle = c.accent; g.font = 'bold 18px sans-serif'; g.fillText('RUNWAYS (magnetic headings approximate from threshold coordinates)', b.x + 6, y); y += 20;
    const rows = Math.floor((b.h - (y - b.y) - 10) / 40); const rw = a.runways;
    this.scrollBar(g, { x: b.x, y, w: b.w, h: b.h - (y - b.y) }, rw.length * 2, rows, c, 'APT');
    let r = 0; const list = rw.flatMap((x) => [{ id: x.le, hdg: bearing(x.leLat, x.leLon, x.heLat, x.heLon), x, disp: x.dispLe }, { id: x.he, hdg: bearing(x.heLat, x.heLon, x.leLat, x.leLon), x, disp: x.dispHe }]);
    for (const e of list.slice(this.scroll.APT, this.scroll.APT + rows)) {
      const yy = y + r * 40, isSel = e.id === sel; g.fillStyle = isSel ? '#12384f' : r % 2 ? '#101a2c' : '#0d1626'; g.fillRect(b.x, yy, b.w - 60, 36);
      g.fillStyle = isSel ? '#ffd24a' : c.txt; g.font = 'bold 22px monospace'; g.fillText(`RWY ${e.id}`, b.x + 12, yy + 19);
      g.font = '19px monospace'; g.fillStyle = c.txt; g.fillText(`${pad3(e.hdg)}°   ${Math.round(e.x.length)} x ${Math.round(e.x.width)} m   ${e.x.surface}${e.disp ? `   DTHR ${Math.round(e.disp)} m` : ''}${e.x.lit ? '  LGT' : ''}`, b.x + 190, yy + 19);
      r++;
    }
  }

  private drawRadio(g: CanvasRenderingContext2D, i: EfbInfo, b: { x: number; y: number; w: number; h: number }, c: { txt: string; dim: string; panel: string; accent: string }) {
    g.fillStyle = c.panel; g.fillRect(b.x, b.y, b.w, 84);
    g.fillStyle = c.dim; g.font = 'bold 16px sans-serif'; g.fillText('COM 1 ACTIVE', b.x + 20, b.y + 18); g.fillText('STANDBY', b.x + 330, b.y + 18);
    g.fillStyle = '#6dff8a'; g.font = 'bold 44px monospace'; g.fillText(this.com.active.toFixed(3), b.x + 20, b.y + 54);
    g.fillStyle = '#ffd24a'; g.fillText(this.com.stby.toFixed(3), b.x + 330, b.y + 54);
    g.fillStyle = c.accent; g.fillRect(b.x + 250, b.y + 22, 62, 50); g.fillStyle = '#04121d'; g.font = 'bold 30px sans-serif'; g.textAlign = 'center'; g.fillText('⇄', b.x + 281, b.y + 48); g.textAlign = 'left';
    this.btn(b.x + 250, b.y + 22, 62, 50, 'Swap active / standby', () => { const t = this.com.active; this.com.active = this.com.stby; this.com.stby = t; });
    g.fillStyle = c.dim; g.font = '17px sans-serif'; g.fillText('Tap a frequency to load it into STANDBY, then ⇄ to make it active.', b.x + 580, b.y + 46);
    const entries: { icao: string; type: string; label: string; mhz: number }[] = [];
    for (const a of [i.dep, i.arr]) for (const f of frequenciesFor(a.id)) entries.push({ icao: a.icao, type: f.type, label: f.label, mhz: f.mhz });
    entries.push({ icao: 'ALL', type: 'EMER', label: 'Guard / emergency', mhz: 121.5 });
    const top = b.y + 98, rowH = 38, rows = Math.floor((b.h - 98) / rowH);
    this.scrollBar(g, { x: b.x, y: top, w: b.w, h: b.h - 98 }, entries.length, rows, c, 'RADIO');
    for (let r = 0; r < rows; r++) {
      const e = entries[r + this.scroll.RADIO]; if (!e) break; const y = top + r * rowH;
      g.fillStyle = r % 2 ? '#101a2c' : '#0d1626'; g.fillRect(b.x, y, b.w - 60, rowH - 3);
      g.fillStyle = c.accent; g.font = 'bold 20px monospace'; g.fillText(e.icao, b.x + 12, y + 19); g.fillStyle = c.txt; g.font = '20px sans-serif'; g.fillText(`${e.type}  ${e.label}`.slice(0, 46), b.x + 110, y + 19);
      g.textAlign = 'right'; g.font = 'bold 24px monospace'; g.fillStyle = '#ffd24a'; g.fillText(e.mhz.toFixed(3), b.x + b.w - 80, y + 19); g.textAlign = 'left';
      this.btn(b.x, y, b.w - 60, rowH - 3, `Load ${e.mhz.toFixed(3)} MHz into STANDBY`, () => { this.com.stby = e.mhz; });
    }
  }

  private drawWx(g: CanvasRenderingContext2D, i: EfbInfo, b: { x: number; y: number; w: number; h: number }, c: { txt: string; dim: string; panel: string; accent: string }) {
    const w = i.wx; const line = (x: number, y: number, k: string, v: string, col = c.txt) => { g.fillStyle = c.dim; g.font = '18px sans-serif'; g.fillText(k, x, y); g.fillStyle = col; g.font = 'bold 28px monospace'; g.fillText(v, x, y + 32); };
    g.fillStyle = c.panel; g.fillRect(b.x, b.y, b.w, 88);
    g.fillStyle = c.accent; g.font = 'bold 18px sans-serif'; g.fillText(`METAR ${w?.icao || i.dep.icao}  (${w ? w.source : 'no data'}${w && w.obsAgeMin ? ', ' + Math.round(w.obsAgeMin) + ' min old' : ''})`, b.x + 14, b.y + 20);
    g.fillStyle = c.txt; g.font = '20px monospace';
    const m = w?.metar || 'No METAR available – using model weather'; const m1 = m.slice(0, 74), m2 = m.slice(74, 148); g.fillText(m1, b.x + 14, b.y + 46); if (m2) g.fillText(m2, b.x + 14, b.y + 72);
    const y0 = b.y + 112, cw = b.w / 3;
    line(b.x + 14, y0, 'WIND (from)', `${pad3(i.windFrom)}° / ${Math.round(i.windKt)} kt`);
    line(b.x + cw, y0, 'TEMPERATURE', `${Math.round(i.oatC)} °C${w ? ` (dew ${Math.round(w.dewC)})` : ''}`);
    line(b.x + 2 * cw, y0, 'QNH', `${Math.round(i.qnh)} hPa`);
    line(b.x + 14, y0 + 84, 'VISIBILITY', w ? (w.visM >= 10000 ? '10 km +' : `${(w.visM / 1000).toFixed(1)} km`) : '—');
    line(b.x + cw, y0 + 84, 'CONDITIONS', (w?.condition || '—').slice(0, 20));
    line(b.x + 2 * cw, y0 + 84, 'CLOUD BASE', w?.baseAglM ? `${Math.round(w.baseAglM * 3.28084 / 100) * 100} ft AGL` : 'none < 10000 ft');
    // runway wind components
    const rw = (id: string, a: Airport) => { const r = a.runways.find((x) => x.le === id || x.he === id); if (!r) return null; const h = id === r.le ? bearing(r.leLat, r.leLon, r.heLat, r.heLon) : bearing(r.heLat, r.heLon, r.leLat, r.leLon); const ang = (i.windFrom - h) * Math.PI / 180; return { h, head: Math.cos(ang) * i.windKt, cross: Math.sin(ang) * i.windKt }; };
    let y = y0 + 180; g.fillStyle = c.accent; g.font = 'bold 18px sans-serif'; g.fillText('RUNWAY WIND COMPONENTS', b.x + 14, y); y += 14;
    for (const [lab, id, a] of [['TAKE-OFF', i.depRwy, i.dep], ['LANDING', i.arrRwy, i.arr]] as const) {
      const r = id ? rw(id, a) : null; g.fillStyle = c.panel; g.fillRect(b.x, y + 4, b.w, 48);
      g.fillStyle = c.txt; g.font = 'bold 22px monospace';
      g.fillText(`${lab}  ${a.icao} ${id || '—'}`, b.x + 14, y + 28);
      if (r) { const hw = r.head, cx = r.cross; g.fillStyle = hw >= 0 ? '#6dff8a' : '#ff8a5a'; g.fillText(`${hw >= 0 ? 'HEADWIND' : 'TAILWIND'} ${Math.abs(Math.round(hw))} kt`, b.x + 400, y + 28); g.fillStyle = Math.abs(cx) > 25 ? '#ff5a5a' : c.txt; g.fillText(`X-WIND ${Math.abs(Math.round(cx))} kt ${cx > 0 ? 'R' : 'L'}`, b.x + 700, y + 28); }
      y += 58;
    }
    g.fillStyle = c.dim; g.font = '16px sans-serif'; g.fillText('A320 limits: max demonstrated crosswind 33 kt (take-off/landing) · max tailwind 15 kt (take-off) / 10 kt (landing).', b.x + 14, b.y + b.h - 8);
  }

  private drawProc(g: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }, c: { txt: string; dim: string; panel: string; accent: string }) {
    const lines: { t: string; head: boolean }[] = [];
    for (const p of PROCEDURES) { lines.push({ t: p.title, head: true }); for (const s of p.steps) lines.push({ t: s, head: false }); }
    const rowH = 34, rows = Math.floor(b.h / rowH); this.scrollBar(g, b, lines.length, rows, c, 'PROC');
    for (let r = 0; r < rows; r++) {
      const l = lines[r + this.scroll.PROC]; if (!l) break; const y = b.y + r * rowH;
      if (l.head) { g.fillStyle = c.panel; g.fillRect(b.x, y, b.w - 60, rowH - 3); g.fillStyle = c.accent; g.font = 'bold 21px sans-serif'; g.fillText(l.t, b.x + 12, y + 18); }
      else { g.fillStyle = c.txt; g.font = '20px monospace'; g.fillText('• ' + l.t.slice(0, 80), b.x + 24, y + 18); }
    }
  }
  get info() { return this.lastInfo; }
}
