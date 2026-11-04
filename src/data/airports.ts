import raw from './airports.json';
import { haversine, D2R } from '../sim/geo';

export interface Runway { le: string; he: string; leLat: number; leLon: number; heLat: number; heLon: number; width: number; length: number; }
export interface Airport {
  id: string; icao: string; name: string; city: string; country: string; lat: number; lon: number; elev: number; size: 0 | 1 | 2; iata: string; runways: Runway[];
}
const pad = (s: string) => (/^\d[LRC]?$/.test(s) ? '0' + s : s);

// Source: OurAirports (public domain) – https://ourairports.com/data/
export const AIRPORTS: Airport[] = (raw as unknown as any[][]).map((r) => ({
  id: r[0], icao: r[0], name: r[1], city: r[2] || '', country: r[3], lat: r[4], lon: r[5], elev: r[6], size: r[7], iata: r[8],
  runways: (r[9] as any[][]).map((w) => ({ le: pad(w[0]), he: pad(w[1]), leLat: w[2], leLon: w[3], heLat: w[4], heLon: w[5], width: w[6], length: w[7] })),
}));
export const AIRPORT_BY_ID = new Map(AIRPORTS.map((a) => [a.id, a]));

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
