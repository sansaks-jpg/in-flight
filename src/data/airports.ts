import raw from './airports.json';
import layoutRaw from './airfields-id.json';
import navRaw from './navaids.json';
import freqRaw from './frequencies.json';
import aliasRaw from './airport-aliases.json';
import { haversine, D2R } from '../sim/geo';

/** A=asphalt, C=concrete, G=grass, V=gravel, D=dirt/sand/clay, W=water, U=unknown */
export type Surface = 'A' | 'C' | 'G' | 'V' | 'D' | 'W' | 'U';
export interface Runway {
  le: string; he: string; leLat: number; leLon: number; heLat: number; heLon: number; width: number; length: number;
  surface: Surface; lit: boolean;
  /** Displaced threshold at the LE / HE end, metres (landing starts here, the full length remains usable for take-off). */
  dispLe: number; dispHe: number;
  /** S = surveyed OSM centreline, O = OurAirports threshold coordinates, H = placed from declared length/heading (approximate). */
  src: 'S' | 'O' | 'H' | '';
}
export interface Airport {
  id: string; icao: string; name: string; city: string; country: string; lat: number; lon: number; elev: number; size: 0 | 1 | 2; iata: string; runways: Runway[];
  /** True when at least one runway was placed from declared length/heading only. */
  approx: boolean;
}
const pad = (s: string) => (/^\d[LRC]?$/.test(s) ? '0' + s : s);

export const SURFACE_NAME: Record<Surface, string> = { A: 'Asphalt', C: 'Concrete', G: 'Grass', V: 'Gravel', D: 'Dirt', W: 'Water', U: 'Unknown' };
export const isPaved = (s: Surface) => s === 'A' || s === 'C';

// Sources: OurAirports (public domain) for idents / surface / lights / thresholds, OpenStreetMap (ODbL) for surveyed Indonesian runway geometry.
export const AIRPORTS: Airport[] = (raw as unknown as any[][]).map((r) => ({
  id: r[0], icao: r[0], name: r[1], city: r[2] || '', country: r[3], lat: r[4], lon: r[5], elev: r[6], size: r[7], iata: r[8],
  approx: r[10] === 1,
  runways: (r[9] as any[][]).map((w): Runway => ({
    le: pad(w[0]), he: pad(w[1]), leLat: w[2], leLon: w[3], heLat: w[4], heLon: w[5], width: w[6], length: w[7],
    surface: (w[8] as Surface) || 'A', lit: w[9] === undefined ? true : w[9] === 1,
    dispLe: w[10] || 0, dispHe: w[11] || 0, src: (w[12] as Runway['src']) || '',
  })),
}));
export const AIRPORT_BY_ID = new Map(AIRPORTS.map((a) => [a.id, a]));
// Older saves / links used previous codes for some Indonesian airfields (e.g. WARJ -> WAHH): keep them resolvable.
for (const [oldId, newId] of Object.entries(aliasRaw as Record<string, string>)) {
  const a = AIRPORT_BY_ID.get(newId);
  if (a && !AIRPORT_BY_ID.has(oldId)) AIRPORT_BY_ID.set(oldId, a);
}

// ---- spatial grid (2° cells) for fast proximity queries ----
const CELL = 2;
const grid = new Map<string, Airport[]>();
const key = (la: number, lo: number) => `${Math.floor(la / CELL)},${Math.floor(lo / CELL)}`;
AIRPORTS.forEach((a) => { const k = key(a.lat, a.lon); (grid.get(k) || grid.set(k, []).get(k)!).push(a); });

export function airportsNear(lat: number, lon: number, radiusM: number): Airport[] {
  const dLat = radiusM / 111000, dLon = radiusM / (111000 * Math.max(0.2, Math.cos(lat * D2R)));
  const out: Airport[] = [];
  for (let la = Math.floor((lat - dLat) / CELL); la <= Math.floor((lat + dLat) / CELL); la++)
    for (let lo = Math.floor((lon - dLon) / CELL); lo <= Math.floor((lon + dLon) / CELL); lo++) {
      const cell = grid.get(`${la},${lo}`);
      if (cell) for (const a of cell) if (haversine(lat, lon, a.lat, a.lon) <= radiusM) out.push(a);
    }
  return out;
}

export function searchAirports(q: string, limit = 16): Airport[] {
  const s = q.trim().toLowerCase();
  // Empty search opens on the Indonesia focus (the sim's featured region); prioritize commercial airports.
  if (!s) {
    return AIRPORTS.filter((a) => a.country === 'ID' && (a.size === 0 || a.size === 1))
      .sort((a, b) => a.size - b.size || a.name.localeCompare(b.name))
      .slice(0, limit);
  }
  const scored: [number, Airport][] = [];
  for (const a of AIRPORTS) {
    let sc = 0;
    const isId = a.country === 'ID';
    const icao = a.icao.toLowerCase();
    const iata = a.iata.toLowerCase();
    const city = a.city.toLowerCase();
    const name = a.name.toLowerCase();

    if (icao === s || iata === s) sc = 100;
    else if (icao.startsWith(s) || iata.startsWith(s)) sc = 65;
    else if (city.startsWith(s)) sc = 55;
    else if (name.startsWith(s)) sc = 45;
    else if (city.includes(s)) sc = 35;
    else if (name.includes(s)) sc = 30;

    if (sc > 0) {
      if (isId) sc += 15; // boost Indonesian airports
      scored.push([sc - a.size * 4, a]);
    }
  }
  return scored.sort((x, y) => y[0] - x[0]).slice(0, limit).map((x) => x[1]);
}
// Featured region: java-to-java hop from Jakarta (CGK) to Yogyakarta (YIA), well inside the starter aircraft's range.
export const DEFAULT_FROM = 'WIII';
export const DEFAULT_TO = 'WAHI';
export const runwayLabel = (r: Runway) => `${r.le}/${r.he}`;

// ---------------------------------------------------------------------------------------------
//  Ground layout (Indonesia, OpenStreetMap): taxiways, aprons, hangars, terminals, stands, holds
// ---------------------------------------------------------------------------------------------
export type LatLon = [number, number];
export interface Taxiway { ref: string; width: number; pts: LatLon[] }
export interface Poly { name: string; ring: LatLon[] }
export interface Stand { ref: string; lat: number; lon: number; gate: boolean }
export interface HoldPoint { ref: string; lat: number; lon: number }
export interface AirfieldLayout { taxiways: Taxiway[]; aprons: Poly[]; hangars: Poly[]; terminals: Poly[]; stands: Stand[]; holds: HoldPoint[]; helipads: LatLon[] }

const layoutCache = new Map<string, AirfieldLayout | null>();
export function getAirfield(ap: Airport): AirfieldLayout | null {
  if (layoutCache.has(ap.id)) return layoutCache.get(ap.id)!;
  const L = (layoutRaw as Record<string, any>)[ap.id];
  let out: AirfieldLayout | null = null;
  if (L) {
    const dec = (a: number[]): LatLon[] => { const o: LatLon[] = []; for (let i = 0; i + 1 < a.length; i += 2) o.push([ap.lat + a[i] / 1e5, ap.lon + a[i + 1] / 1e5]); return o; };
    out = {
      taxiways: (L.tw as any[]).map((t) => ({ ref: t[0], width: t[1], pts: dec(t[2]) })),
      aprons: (L.ap as any[]).map((t) => ({ name: t[0], ring: dec(t[1]) })),
      hangars: (L.hg as any[]).map((t) => ({ name: t[0], ring: dec(t[1]) })),
      terminals: (L.tm as any[]).map((t) => ({ name: t[0], ring: dec(t[1]) })),
      stands: (L.st as any[]).map((t) => ({ ref: t[0], lat: ap.lat + t[1] / 1e5, lon: ap.lon + t[2] / 1e5, gate: t[3] === 1 })),
      holds: (L.hp as any[]).map((t) => ({ ref: t[0], lat: ap.lat + t[1] / 1e5, lon: ap.lon + t[2] / 1e5 })),
      helipads: (L.hl as any[]).map((t) => [ap.lat + t[0] / 1e5, ap.lon + t[1] / 1e5] as LatLon),
    };
  }
  layoutCache.set(ap.id, out);
  return out;
}
export const AIRFIELD_LAYOUT_COUNT = Object.keys(layoutRaw as object).length;

// ---- navaids (OurAirports) ---------------------------------------------------------------------
export interface Navaid { ident: string; name: string; type: string; freqKhz: number; lat: number; lon: number; elev: number; airport: string }
export const NAVAIDS: Navaid[] = (navRaw as unknown as any[][]).map((n) => ({ ident: n[0], name: n[1], type: n[2], freqKhz: n[3], lat: n[4], lon: n[5], elev: n[6], airport: n[7] }));
export function navaidsNear(lat: number, lon: number, radiusM: number): Navaid[] {
  const dLat = radiusM / 111000, dLon = radiusM / (111000 * Math.max(0.2, Math.cos(lat * D2R)));
  return NAVAIDS.filter((n) => Math.abs(n.lat - lat) <= dLat && Math.abs(n.lon - lon) <= dLon && haversine(lat, lon, n.lat, n.lon) <= radiusM);
}
export const navaidFreqLabel = (n: Navaid) => (n.freqKhz ? (n.type.startsWith('NDB') ? `${n.freqKhz} kHz` : `${(n.freqKhz / 1000).toFixed(2)} MHz`) : '—');

// ---- published radio frequencies (OurAirports) -------------------------------------------------
const FREQ_LABEL: Record<string, string> = { TWR: 'Tower', GND: 'Ground', ATIS: 'ATIS', APP: 'Approach', DEP: 'Departure', CTAF: 'CTAF', UNICOM: 'UNICOM', AFIS: 'AFIS', 'A/D': 'Arr/Dep', RDO: 'Radio', CLD: 'Clearance', APRON: 'Apron', CNTR: 'Centre', TML: 'Terminal' };
export interface AirportFrequency { type: string; label: string; mhz: number }
export function frequenciesFor(id: string): AirportFrequency[] {
  const f = (freqRaw as unknown as Record<string, [string, number][]>)[id] || [];
  return f.map(([type, mhz]) => ({ type, label: FREQ_LABEL[type] || type, mhz }));
}

/** Points (apron / terminal / stand clusters) the terrain flattening should reach, so ramps are as level as the runway. */
const spineCache = new Map<string, LatLon[]>();
export function airfieldSpines(ap: Airport): LatLon[] {
  const hit = spineCache.get(ap.id); if (hit) return hit;
  const L = getAirfield(ap); const out: LatLon[] = [];
  if (L) {
    const cen = (r: LatLon[]): LatLon => [r.reduce((q, p) => q + p[0], 0) / r.length, r.reduce((q, p) => q + p[1], 0) / r.length];
    for (const a of L.aprons.slice(0, 6)) if (a.ring.length) out.push(cen(a.ring));
    for (const t of L.terminals.slice(0, 3)) if (t.ring.length) out.push(cen(t.ring));
    if (L.stands.length) out.push([L.stands.reduce((q, s) => q + s.lat, 0) / L.stands.length, L.stands.reduce((q, s) => q + s.lon, 0) / L.stands.length]);
    for (const h of L.hangars.slice(0, 3)) if (h.ring.length) out.push(cen(h.ring));
  }
  const capped = out.filter((p) => haversine(ap.lat, ap.lon, p[0], p[1]) < 4500).slice(0, 8);
  spineCache.set(ap.id, capped);
  return capped;
}
