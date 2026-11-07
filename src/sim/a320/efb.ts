// Captain-side Electronic Flight Bag (EFB) drawn on the tablet at the left sliding window – a FlyPad / Navigraph-style layout:
//   left navigation rail · status bar · four pages: CHECKLIST (Before Start / After Takeoff / Approach / Landing),
//   FLT PLAN (route + progress), WEATHER (live METAR for origin and destination) and RADIO (airport frequencies).
// Everything is laid out in a fixed 1024 x 768 logical space and rasterised at `scale` x so the tablet stays crisp when the camera
// zooms in on it (the cockpit raises the scale only while the tablet is large on screen). All content is live data.
import type { Airport } from '../../data/airports';
import { frequenciesFor } from '../../data/airports';
import { fetchLiveWeather, type LiveWx } from '../liveWeather';

export interface EfbChecklistItem { id: string; label: string; detail: string; done: boolean; phase: string }
export interface EfbInfo {
  dep: Airport; arr: Airport; depRwy: string; arrRwy: string; callsign: string; phase: string;
  wx: LiveWx | null; windFrom: number; windKt: number; qnh: number; oatC: number;
  route: { name: string; type: string; distNm: number }[]; activeWp: number;
  checklist: EfbChecklistItem[]; toggle(id: string): void;
  fuelKg: number; distNm: number; eteMin: number; utcMs: number;
}
export type EfbPage = 'CHECK' | 'PLAN' | 'WX' | 'RADIO';
const PAGES: { id: EfbPage; label: string; icon: string }[] = [
  { id: 'CHECK', label: 'Checklist', icon: '✓' }, { id: 'PLAN', label: 'Flight Plan', icon: '➤' }, { id: 'WX', label: 'Weather', icon: '☁' }, { id: 'RADIO', label: 'Radio', icon: '◉' },
];
/** The four airline checklists, mapped on the simulator's flight-phase items. */
export const CHECKLISTS: { id: string; label: string; phases: string[] }[] = [
  { id: 'start', label: 'Before Start', phases: ['taxi'] },
  { id: 'after', label: 'After Takeoff', phases: ['takeoff', 'climb', 'cruise'] },
  { id: 'appr', label: 'Approach', phases: ['descent'] },
  { id: 'land', label: 'Landing', phases: ['final', 'rollout'] },
];
/** Which checklist is "current" for a flight phase (used to open the tablet on the right list). */
export const checklistForPhase = (phase: string) => Math.max(0, CHECKLISTS.findIndex((c) => c.phases.includes(phase)));

const COL = { bg: '#0a1020', rail: '#0d1527', card: '#131d33', card2: '#0f182b', line: '#22304d', txt: '#f1f5f9', dim: '#94a3b8', accent: '#38bdf8', green: '#4ade80', amber: '#fbbf24', mag: '#f472b6', red: '#f87171' };
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif', MONO = 'ui-monospace, "SF Mono", Consolas, "Liberation Mono", monospace';
const pad3 = (n: number) => String(Math.round(n) % 360 || 360).padStart(3, '0');
type Rect = { x: number; y: number; w: number; h: number };
type G = CanvasRenderingContext2D;
function rr(g: G, x: number, y: number, w: number, h: number, r: number) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function fit(g: G, s: string, maxW: number) { if (g.measureText(s).width <= maxW) return s; let t = s; while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; }
function wrap(g: G, s: string, maxW: number, maxLines: number): string[] {
  const out: string[] = []; let cur = '';
  for (const w of s.split(/\s+/)) { const t = cur ? cur + ' ' + w : w; if (g.measureText(t).width > maxW && cur) { out.push(cur); cur = w; if (out.length >= maxLines) break; } else cur = t; }
  if (cur && out.length < maxLines) out.push(cur); return out;
}
const hhmm = (ms: number) => { const d = new Date(ms); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`; };

export class Efb {
  static readonly W = 1024; static readonly H = 768;
  page: EfbPage = 'CHECK'; dirty = true;
  /** Offside (F/O) view on the captain's display is read-only: the captain can look at the F/O's pages but not operate them. */
  readOnly = false; banner = '';
  private list = -1; private scroll: Record<string, number> = {};
  private com = { active: 118.1, stby: 121.5 };
  private hits: (Rect & { tip: string; fn: () => void })[] = [];
  private wxCache = new Map<string, { wx: LiveWx | null; state: 'loading' | 'ok' | 'fail'; at: number }>();

  /** Click at normalised screen coordinates (0..1, origin top-left). Returns true if a button was hit. */
  click(u: number, v: number): boolean { if (this.readOnly) return false; const h = this.at(u, v); if (!h) return false; h.fn(); this.dirty = true; return true; }
  hover(u: number, v: number): string | null { return this.readOnly ? null : this.at(u, v)?.tip ?? null; }
  wheel(dy: number) { if (this.readOnly) return; const k = this.key(); this.scroll[k] = Math.max(0, (this.scroll[k] ?? 0) + (dy > 0 ? 1 : -1)); this.dirty = true; }
  private key() { return this.page === 'CHECK' ? 'CHECK' + this.list : this.page; }
  private at(u: number, v: number) { const x = u * Efb.W, y = v * Efb.H; for (let i = this.hits.length - 1; i >= 0; i--) { const h = this.hits[i]; if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h; } return null; }
  private btn(r: Rect, tip: string, fn: () => void) { this.hits.push({ ...r, tip, fn }); }

  /** Origin / destination METAR: fetched once per airport (and refreshed every 10 min), never blocking the draw. */
  private weatherFor(a: Airport) {
    const e = this.wxCache.get(a.icao);
    if (e && (e.state === 'loading' || Date.now() - e.at < 600_000)) return e;
    const n: { wx: LiveWx | null; state: 'loading' | 'ok' | 'fail'; at: number } = { wx: e?.wx ?? null, state: 'loading', at: Date.now() }; this.wxCache.set(a.icao, n);
    fetchLiveWeather(a.lat, a.lon, a.icao).then((wx) => { n.wx = wx; n.state = wx.ok ? 'ok' : 'fail'; n.at = Date.now(); this.dirty = true; }).catch(() => { n.state = 'fail'; n.at = Date.now(); this.dirty = true; });
    return n;
  }

  draw(g: G, info: EfbInfo | null, day: number, scale = 1) {
    const W = Efb.W, H = Efb.H; this.hits = [];
    g.setTransform(scale, 0, 0, scale, 0, 0); g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillStyle = day > 0.5 ? COL.bg : '#060a14'; g.fillRect(0, 0, W, H);
    // ---- status bar ----
    g.fillStyle = COL.rail; g.fillRect(0, 0, W, 56); g.fillStyle = COL.line; g.fillRect(0, 55, W, 1);
    g.fillStyle = COL.accent; rr(g, 18, 14, 28, 28, 7); g.fill(); g.fillStyle = '#04121d'; g.font = `800 17px ${SANS}`; g.textAlign = 'center'; g.fillText('A', 32, 29);
    g.textAlign = 'left'; g.fillStyle = COL.txt; g.font = `700 22px ${SANS}`; g.fillText('A320 EFB', 58, 28);
    if (this.banner) { g.textAlign = 'left'; g.font = `800 14px ${SANS}`; const bw = g.measureText(this.banner).width + 24; g.fillStyle = COL.amber; rr(g, 214, 17, bw, 24, 12); g.fill(); g.fillStyle = '#251a00'; g.fillText(this.banner, 226, 29); }
    if (info && !this.banner) {
      g.textAlign = 'center'; g.fillStyle = COL.dim; g.font = `600 18px ${MONO}`; g.fillText(`${info.dep.icao}  ➜  ${info.arr.icao}`, W / 2, 28);
      g.textAlign = 'right'; g.fillStyle = COL.txt; g.font = `600 18px ${MONO}`; g.fillText(`${info.callsign}   ${hhmm(info.utcMs)}`, W - 20, 28);
    }
    // ---- navigation rail ----
    g.fillStyle = COL.rail; g.fillRect(0, 56, 176, H - 56); g.fillStyle = COL.line; g.fillRect(175, 56, 1, H - 56);
    PAGES.forEach((p, i) => {
      const r: Rect = { x: 12, y: 74 + i * 78, w: 152, h: 66 }, act = p.id === this.page;
      g.fillStyle = act ? COL.accent : 'transparent'; if (act) { rr(g, r.x, r.y, r.w, r.h, 12); g.fill(); }
      g.fillStyle = act ? '#04121d' : COL.dim; g.font = `600 26px ${SANS}`; g.textAlign = 'left'; g.fillText(p.icon, r.x + 16, r.y + r.h / 2);
      g.fillStyle = act ? '#04121d' : COL.txt; g.font = `${act ? 700 : 600} 18px ${SANS}`; g.fillText(p.label, r.x + 52, r.y + r.h / 2);
      this.btn(r, `Open ${p.label}`, () => { this.page = p.id; });
    });
    const body: Rect = { x: 196, y: 74, w: W - 196 - 20, h: H - 74 - 18 };
    if (!info) { g.fillStyle = COL.dim; g.font = `500 24px ${SANS}`; g.textAlign = 'left'; g.fillText('Loading flight data…', body.x + 10, body.y + 40); this.dirty = false; return; }
    switch (this.page) {
      case 'CHECK': this.drawCheck(g, info, body); break;
      case 'PLAN': this.drawPlan(g, info, body); break;
      case 'WX': this.drawWx(g, info, body); break;
      case 'RADIO': this.drawRadio(g, info, body); break;
    }
    g.textAlign = 'left'; this.dirty = false;
  }

  /** Up / down scroll buttons on the right edge of a list. Returns the (clamped) first visible row. */
  private scroller(g: G, area: Rect, total: number, rows: number, key: string): number {
    const maxS = Math.max(0, total - rows); const s = Math.min(this.scroll[key] ?? 0, maxS); this.scroll[key] = s;
    if (maxS <= 0) return 0;
    for (let i = 0; i < 2; i++) {
      const r: Rect = { x: area.x + area.w - 44, y: i === 0 ? area.y : area.y + area.h - 44, w: 44, h: 44 };
      g.fillStyle = COL.card; rr(g, r.x, r.y, r.w, r.h, 10); g.fill(); g.fillStyle = (i === 0 ? s > 0 : s < maxS) ? COL.txt : COL.line; g.font = `700 20px ${SANS}`; g.textAlign = 'center'; g.fillText(i === 0 ? '▲' : '▼', r.x + 22, r.y + 23); g.textAlign = 'left';
      this.btn(r, i === 0 ? 'Scroll up' : 'Scroll down (or mouse wheel)', () => { this.scroll[key] = Math.max(0, Math.min(maxS, s + (i === 0 ? -1 : 1))); });
    }
    return s;
  }

  // ------------------------------------------------------------------ CHECKLIST
  private drawCheck(g: G, i: EfbInfo, b: Rect) {
    const cur = checklistForPhase(i.phase); if (this.list < 0) this.list = cur;
    const tw = (b.w - 3 * 10) / 4;
    CHECKLISTS.forEach((c, k) => {
      const items = i.checklist.filter((x) => c.phases.includes(x.phase)), done = items.filter((x) => x.done).length, act = k === this.list;
      const r: Rect = { x: b.x + k * (tw + 10), y: b.y, w: tw, h: 62 };
      g.fillStyle = act ? COL.accent : COL.card; rr(g, r.x, r.y, r.w, r.h, 12); g.fill();
      g.textAlign = 'left'; g.fillStyle = act ? '#04121d' : COL.txt; g.font = `700 17px ${SANS}`; g.fillText(c.label, r.x + 14, r.y + 22);
      g.fillStyle = act ? '#0b2a3d' : COL.line; rr(g, r.x + 14, r.y + 42, r.w - 28, 6, 3); g.fill(); g.fillStyle = act ? '#04121d' : done === items.length && items.length ? COL.green : COL.accent; rr(g, r.x + 14, r.y + 42, Math.max(6, (r.w - 28) * (items.length ? done / items.length : 0)), 6, 3); g.fill();
      if (k === cur) { g.fillStyle = act ? '#04121d' : COL.amber; g.beginPath(); g.arc(r.x + r.w - 16, r.y + 20, 5, 0, Math.PI * 2); g.fill(); }
      this.btn(r, `${c.label} checklist · ${done}/${items.length} complete`, () => { this.list = k; });
    });
    const items = i.checklist.filter((x) => CHECKLISTS[this.list].phases.includes(x.phase));
    const area: Rect = { x: b.x, y: b.y + 76, w: b.w, h: b.h - 76 }, rowH = 74, rows = Math.floor(area.h / rowH);
    const s0 = this.scroller(g, area, items.length, rows, 'CHECK' + this.list);
    if (!items.length) { g.fillStyle = COL.dim; g.font = `500 20px ${SANS}`; g.fillText('No items in this checklist.', area.x + 6, area.y + 30); }
    for (let r = 0; r < rows; r++) {
      const it = items[r + s0]; if (!it) break; const y = area.y + r * rowH, w = area.w - (items.length > rows ? 54 : 0), box: Rect = { x: area.x, y, w, h: rowH - 8 };
      g.fillStyle = it.done ? COL.card2 : COL.card; rr(g, box.x, box.y, box.w, box.h, 12); g.fill();
      g.strokeStyle = it.done ? COL.green : COL.dim; g.lineWidth = 2.5; rr(g, box.x + 16, y + 17, 32, 32, 8); g.stroke();
      if (it.done) { g.fillStyle = COL.green; rr(g, box.x + 16, y + 17, 32, 32, 8); g.fill(); g.strokeStyle = '#04200f'; g.lineWidth = 4; g.lineCap = 'round'; g.beginPath(); g.moveTo(box.x + 24, y + 33); g.lineTo(box.x + 31, y + 40); g.lineTo(box.x + 42, y + 26); g.stroke(); }
      g.textAlign = 'left'; g.fillStyle = it.done ? COL.dim : COL.txt; g.font = `700 20px ${SANS}`; g.fillText(fit(g, it.label, w - 84), box.x + 66, y + 24);
      g.fillStyle = COL.dim; g.font = `500 15px ${SANS}`; g.fillText(fit(g, it.detail, w - 84), box.x + 66, y + 49);
      this.btn(box, it.done ? 'Untick item' : 'Tick item complete', () => i.toggle(it.id));
    }
  }

  // ------------------------------------------------------------------ FLIGHT PLAN
  private drawPlan(g: G, i: EfbInfo, b: Rect) {
    g.fillStyle = COL.card; rr(g, b.x, b.y, b.w, 128, 14); g.fill();
    g.textAlign = 'left'; g.fillStyle = COL.txt; g.font = `800 38px ${MONO}`; g.fillText(`${i.dep.icao} ➜ ${i.arr.icao}`, b.x + 20, b.y + 30);
    g.font = `500 16px ${SANS}`; g.fillStyle = COL.dim; g.fillText(fit(g, `${i.dep.name}  →  ${i.arr.name}`, b.w - 40), b.x + 20, b.y + 62);
    const stat = (k: string, v: string, x: number, col = COL.txt) => { g.fillStyle = COL.dim; g.font = `600 13px ${SANS}`; g.fillText(k, x, b.y + 90); g.fillStyle = col; g.font = `700 22px ${MONO}`; g.fillText(v, x, b.y + 111); };
    const ete = Math.max(0, i.eteMin);
    stat('DISTANCE', `${Math.round(i.distNm)} NM`, b.x + 20); stat('ETE', `${Math.floor(ete / 60)}h${String(Math.round(ete % 60)).padStart(2, '0')}`, b.x + 170, COL.accent);
    stat('FUEL', `${Math.round(i.fuelKg)} KG`, b.x + 300); stat('DEP RWY', i.depRwy || '—', b.x + 450, COL.amber); stat('ARR RWY', i.arrRwy || '—', b.x + 560, COL.amber); stat('PHASE', i.phase.toUpperCase(), b.x + 670);
    const area: Rect = { x: b.x, y: b.y + 142, w: b.w, h: b.h - 142 }, hdr = 30, rowH = 46, rows = Math.max(1, Math.floor((area.h - hdr) / rowH));
    const s0 = this.scroller(g, { ...area, y: area.y + hdr, h: area.h - hdr }, i.route.length, rows, 'PLAN');
    g.fillStyle = COL.dim; g.font = `700 13px ${SANS}`; g.fillText('#', area.x + 20, area.y + 12); g.fillText('WAYPOINT', area.x + 70, area.y + 12); g.fillText('TYPE', area.x + 330, area.y + 12); g.textAlign = 'right'; g.fillText('DIST TO GO', area.x + area.w - (i.route.length > rows ? 66 : 20), area.y + 12); g.textAlign = 'left';
    if (!i.route.length) { g.fillStyle = COL.dim; g.font = `500 20px ${SANS}`; g.fillText('No route loaded – direct to destination.', area.x + 6, area.y + 60); }
    for (let r = 0; r < rows; r++) {
      const idx = r + s0, wp = i.route[idx]; if (!wp) break; const y = area.y + hdr + r * rowH, w = area.w - (i.route.length > rows ? 54 : 0), act = idx === i.activeWp, past = idx < i.activeWp;
      g.fillStyle = act ? '#2a1a35' : r % 2 ? COL.card2 : COL.card; rr(g, area.x, y, w, rowH - 6, 10); g.fill();
      if (act) { g.fillStyle = COL.mag; rr(g, area.x, y, 5, rowH - 6, 2); g.fill(); }
      g.fillStyle = past ? COL.green : act ? COL.mag : COL.dim; g.font = `700 17px ${MONO}`; g.fillText(past ? '✓' : String(idx + 1), area.x + 20, y + (rowH - 6) / 2);
      g.fillStyle = past ? COL.dim : COL.txt; g.font = `700 20px ${MONO}`; g.fillText(fit(g, wp.name, 240), area.x + 70, y + (rowH - 6) / 2);
      g.fillStyle = COL.dim; g.font = `600 14px ${SANS}`; g.fillText(wp.type.toUpperCase(), area.x + 330, y + (rowH - 6) / 2);
      g.textAlign = 'right'; g.fillStyle = act ? COL.mag : past ? COL.dim : COL.txt; g.font = `700 19px ${MONO}`; g.fillText(past ? '—' : `${wp.distNm.toFixed(1)} NM`, area.x + w - 18, y + (rowH - 6) / 2); g.textAlign = 'left';
    }
  }

  // ------------------------------------------------------------------ WEATHER
  private drawWx(g: G, i: EfbInfo, b: Rect) {
    const cardH = (b.h - 14) / 2;
    ([['ORIGIN', i.dep, i.depRwy], ['DESTINATION', i.arr, i.arrRwy]] as const).forEach(([role, a, rwy], k) => {
      const r: Rect = { x: b.x, y: b.y + k * (cardH + 14), w: b.w, h: cardH }, e = this.weatherFor(a), w = e.wx;
      g.fillStyle = COL.card; rr(g, r.x, r.y, r.w, r.h, 14); g.fill();
      g.textAlign = 'left'; g.fillStyle = COL.accent; g.font = `700 13px ${SANS}`; g.fillText(role, r.x + 18, r.y + 22);
      g.fillStyle = COL.txt; g.font = `800 28px ${MONO}`; g.fillText(a.icao, r.x + 18, r.y + 52);
      g.fillStyle = COL.dim; g.font = `500 15px ${SANS}`; g.fillText(fit(g, `${a.name}${rwy ? ' · RWY ' + rwy : ''}`, r.w - 250), r.x + 120, r.y + 52);
      const st = e.state === 'loading' ? 'LOADING…' : w?.ok ? `${w.source}${w.obsAgeMin ? ' · ' + Math.round(w.obsAgeMin) + ' min old' : ''}` : 'OFFLINE · model data';
      g.textAlign = 'right'; g.fillStyle = e.state === 'ok' ? COL.green : COL.amber; g.font = `600 13px ${SANS}`; g.fillText(fit(g, st, 230), r.x + r.w - 18, r.y + 22); g.textAlign = 'left';
      g.fillStyle = COL.card2; rr(g, r.x + 14, r.y + 70, r.w - 28, 62, 10); g.fill();
      g.fillStyle = COL.txt; g.font = `500 16px ${MONO}`; const metar = w?.metar || (e.state === 'loading' ? 'Fetching METAR…' : 'No METAR available for this station.');
      wrap(g, metar, r.w - 56, 2).forEach((l, n) => g.fillText(l, r.x + 26, r.y + 92 + n * 22));
      const tiles: [string, string, string?][] = w && w.ok ? [
        ['WIND', `${pad3(w.windDir)}°/${Math.round(w.windKt)}${w.gustKt > w.windKt + 3 ? 'G' + Math.round(w.gustKt) : ''} kt`], ['TEMP / DEW', `${Math.round(w.tempC)}° / ${Math.round(w.dewC)}°C`], ['QNH', `${Math.round(w.qnh)} hPa`],
        ['VISIBILITY', w.visM >= 10000 ? '10 km +' : `${(w.visM / 1000).toFixed(1)} km`], ['CEILING', w.baseAglM ? `${Math.round(w.baseAglM * 3.28084 / 100) * 100} ft` : 'NONE'], ['SKY', (w.condition || '—').slice(0, 14)],
      ] : [['WIND', '—'], ['TEMP / DEW', '—'], ['QNH', '—'], ['VISIBILITY', '—'], ['CEILING', '—'], ['SKY', '—']];
      const tw = (r.w - 28 - 5 * 8) / 6;
      tiles.forEach(([lab, val], n) => { const x = r.x + 14 + n * (tw + 8), y = r.y + 144; g.fillStyle = COL.card2; rr(g, x, y, tw, Math.max(52, r.h - 156), 10); g.fill(); g.fillStyle = COL.dim; g.font = `600 11px ${SANS}`; g.fillText(lab, x + 10, y + 16); g.fillStyle = COL.txt; g.font = `700 ${val.length > 11 ? 14 : 16}px ${MONO}`; g.fillText(fit(g, val, tw - 16), x + 10, y + 38); });
    });
  }

  // ------------------------------------------------------------------ RADIO
  private drawRadio(g: G, i: EfbInfo, b: Rect) {
    g.fillStyle = COL.card; rr(g, b.x, b.y, b.w, 104, 14); g.fill(); g.textAlign = 'left';
    g.fillStyle = COL.dim; g.font = `700 13px ${SANS}`; g.fillText('COM 1  ACTIVE', b.x + 22, b.y + 24); g.fillText('STANDBY', b.x + 330, b.y + 24);
    g.fillStyle = COL.green; g.font = `800 44px ${MONO}`; g.fillText(this.com.active.toFixed(3), b.x + 22, b.y + 66); g.fillStyle = COL.amber; g.fillText(this.com.stby.toFixed(3), b.x + 330, b.y + 66);
    const sw: Rect = { x: b.x + 250, y: b.y + 30, w: 64, h: 52 }; g.fillStyle = COL.accent; rr(g, sw.x, sw.y, sw.w, sw.h, 12); g.fill(); g.fillStyle = '#04121d'; g.font = `800 28px ${SANS}`; g.textAlign = 'center'; g.fillText('⇄', sw.x + 32, sw.y + 27); g.textAlign = 'left';
    this.btn(sw, 'Swap active / standby', () => { const t = this.com.active; this.com.active = this.com.stby; this.com.stby = t; });
    g.fillStyle = COL.dim; g.font = `500 15px ${SANS}`; g.fillText('Tap a frequency to load STANDBY,', b.x + 600, b.y + 44); g.fillText('then ⇄ to make it active.', b.x + 600, b.y + 66);
    const entries: { icao: string; type: string; label: string; mhz: number }[] = [];
    for (const a of [i.dep, i.arr]) for (const f of frequenciesFor(a.id)) entries.push({ icao: a.icao, type: f.type, label: f.label, mhz: f.mhz });
    entries.push({ icao: 'ALL', type: 'EMER', label: 'Guard / emergency', mhz: 121.5 });
    const area: Rect = { x: b.x, y: b.y + 118, w: b.w, h: b.h - 118 }, rowH = 46, rows = Math.floor(area.h / rowH), s0 = this.scroller(g, area, entries.length, rows, 'RADIO'), w = area.w - (entries.length > rows ? 54 : 0);
    for (let r = 0; r < rows; r++) {
      const e = entries[r + s0]; if (!e) break; const y = area.y + r * rowH, box: Rect = { x: area.x, y, w, h: rowH - 6 }, act = Math.abs(e.mhz - this.com.stby) < 1e-4;
      g.fillStyle = act ? '#2b2410' : r % 2 ? COL.card2 : COL.card; rr(g, box.x, box.y, box.w, box.h, 10); g.fill();
      g.fillStyle = COL.accent; g.font = `700 17px ${MONO}`; g.fillText(e.icao, box.x + 16, y + (rowH - 6) / 2); g.fillStyle = COL.dim; g.font = `700 12px ${SANS}`; g.fillText(e.type.toUpperCase(), box.x + 90, y + (rowH - 6) / 2);
      g.fillStyle = COL.txt; g.font = `500 18px ${SANS}`; g.fillText(fit(g, e.label, w - 330), box.x + 170, y + (rowH - 6) / 2);
      g.textAlign = 'right'; g.fillStyle = COL.amber; g.font = `800 22px ${MONO}`; g.fillText(e.mhz.toFixed(3), box.x + w - 18, y + (rowH - 6) / 2); g.textAlign = 'left';
      this.btn(box, `Load ${e.mhz.toFixed(3)} MHz into STANDBY`, () => { this.com.stby = e.mhz; });
    }
  }
}
