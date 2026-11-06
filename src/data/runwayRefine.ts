/**
 * Live runway survey refinement.
 *
 * The bundled database (`airports.json`) carries OpenStreetMap-surveyed runway centrelines for the airports
 * covered at build time (src 'S'). For every other airport the geometry is either OurAirports threshold
 * coordinates ('O') or placed from declared length/heading ('H', approximate). When the player selects such an
 * airport, this module asks OpenStreetMap (Overpass) for the real `aeroway=runway` centrelines around it,
 * conflates them with the bundled runways by ident / heading / proximity, upgrades them in place to src 'S',
 * and adds any real runway the database did not know about. Results are cached (localStorage) so each airfield
 * is only fetched once; failures are silent and fall back to the bundled data.
 */
import { Airport, Runway, Surface } from './airports';
import { bearing, haversine } from '../sim/geo';
import { magVar } from '../sim/magvar';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const KEY = (id: string) => `skyline.osmrw.v1.${id}`;
const TTL_OK = 30 * 86400_000, TTL_EMPTY = 3 * 86400_000;

interface OsmRunway { ids: string[]; a: [number, number]; b: [number, number]; len: number; hdg: number; width: number; surface: string }
interface CacheEntry { t: number; runways: OsmRunway[] }

const inflight = new Map<string, Promise<boolean>>();
const done = new Set<string>();
const listeners = new Set<() => void>();
/** Subscribe to "runway geometry of some airport was upgraded" events (UI re-renders / marker cache reset). */
export function onRunwaysRefined(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }

const pad = (s: string) => (/^\d[LRC]?$/.test(s) ? '0' + s : s);
const wrap180 = (a: number) => ((((a % 360) + 540) % 360)) - 180;
const axisDiff = (h1: number, h2: number) => Math.min(Math.abs(wrap180(h1 - h2)), Math.abs(wrap180(h1 - h2 - 180)));
const refIdents = (ref: string) => ref.toUpperCase().replace(/\s+/g, '').split(/[/;,-]/).map((s) => pad(s.trim())).filter((s) => /^\d{2}[LRC]?$/.test(s));
const identNum = (s: string) => { const n = parseInt(s, 10); return isNaN(n) ? NaN : n * 10; };
const oppIdent = (id: string) => { const m = /^(\d{2})([LRC]?)$/.exec(id); if (!m) return ''; let n = (parseInt(m[1], 10) + 18) % 36; if (n === 0) n = 36; return String(n).padStart(2, '0') + ({ L: 'R', R: 'L', C: 'C', '': '' } as Record<string, string>)[m[2]]; };
function surfaceCode(s: string | undefined): Surface {
  s = (s || '').toLowerCase();
  if (!s) return 'U';
  if (/con/.test(s)) return 'C';
  if (/asp|bit|tar|mac|tac|pav|pem/.test(s)) return 'A';
  if (/gras|grs|turf/.test(s)) return 'G';
  if (/grav|gvl|coral|stone|rock|compact/.test(s)) return 'V';
  if (/dirt|soil|earth|sand|mud|ground|unpaved|clay|natural/.test(s)) return 'D';
  return 'U';
}

/** Group OSM ways of one runway (often split into several ways) and reduce them to one centreline. */
function groupWays(ways: { tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] }[]): OsmRunway[] {
  const groups: { ids: string[]; parts: typeof ways }[] = [];
  for (const w of ways) {
    if (!w.geometry || w.geometry.length < 2) continue;
    const ids = refIdents(w.tags?.ref || '');
    const g = ids.length ? groups.find((x) => x.ids.some((i) => ids.includes(i))) : null;
    if (g) { g.parts.push(w); ids.forEach((i) => !g.ids.includes(i) && g.ids.push(i)); } else groups.push({ ids, parts: [w] });
  }
  const out: OsmRunway[] = [];
  for (const g of groups) {
    const pts = g.parts.flatMap((p) => p.geometry!);
    const first = g.parts[0].geometry!, last0 = first[first.length - 1];
    const ax = bearing(first[0].lat, first[0].lon, last0.lat, last0.lon) * Math.PI / 180;
    const kx = Math.cos(pts[0].lat * Math.PI / 180);
    const proj = (p: { lat: number; lon: number }) => (p.lon - pts[0].lon) * kx * Math.sin(ax) + (p.lat - pts[0].lat) * Math.cos(ax);
    let a = pts[0], b = pts[0];
    for (const p of pts) { if (proj(p) < proj(a)) a = p; if (proj(p) > proj(b)) b = p; }
    const len = haversine(a.lat, a.lon, b.lat, b.lon);
    if (len < 180) continue;
    const tags = Object.assign({}, ...g.parts.map((p) => p.tags || {}));
    out.push({ ids: g.ids, a: [a.lat, a.lon], b: [b.lat, b.lon], len, hdg: bearing(a.lat, a.lon, b.lat, b.lon), width: Math.round(+tags.width) || 0, surface: tags.surface || '' });
  }
  return out;
}

async function fetchOsm(ap: Airport): Promise<OsmRunway[] | null> {
  const q = `[out:json][timeout:20];way["aeroway"="runway"](around:4500,${ap.lat},${ap.lon});out geom tags;`;
  for (const ep of ENDPOINTS) {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
      clearTimeout(to);
      if (!r.ok) continue;
      const j = await r.json();
      return groupWays(j.elements || []);
    } catch { /* try next mirror */ }
  }
  return null;
}

function loadCache(id: string): CacheEntry | null {
  try {
    const c = JSON.parse(localStorage.getItem(KEY(id)) || 'null') as CacheEntry | null;
    if (!c) return null;
    return Date.now() - c.t < (c.runways.length ? TTL_OK : TTL_EMPTY) ? c : null;
  } catch { return null; }
}

/** Conflate OSM centrelines into `ap.runways` in place. Returns true when anything changed. */
function apply(ap: Airport, osm: OsmRunway[]): boolean {
  if (!osm.length) return false;
  let changed = false;
  const used = new Set<OsmRunway>();
  const mv = magVar(ap.lat, ap.lon);
  for (const rw of ap.runways) {
    if (rw.src === 'S') { // already surveyed: just mark the matching OSM runway as consumed
      const m = osm.find((g) => g.ids.includes(rw.le) || g.ids.includes(rw.he)); if (m) used.add(m);
      continue;
    }
    const mid = [(rw.leLat + rw.heLat) / 2, (rw.leLon + rw.heLon) / 2];
    const want = (() => { const n = identNum(rw.le); return isNaN(n) ? bearing(rw.leLat, rw.leLon, rw.heLat, rw.heLon) : n + mv; })();
    let m = osm.find((g) => !used.has(g) && g.ids.length && (g.ids.includes(rw.le) || g.ids.includes(rw.he)));
    if (!m) m = osm.filter((g) => !used.has(g) && !g.ids.length && axisDiff(g.hdg, want) < 15 && haversine(g.a[0], g.a[1], mid[0], mid[1]) < 2500)
      .sort((p, q) => haversine(p.a[0], p.a[1], mid[0], mid[1]) - haversine(q.a[0], q.a[1], mid[0], mid[1]))[0];
    // a heading/proximity match for a runway with a different declared ident: accept only when clearly the same strip
    if (!m) m = osm.filter((g) => !used.has(g) && axisDiff(g.hdg, want) < 8 && haversine((g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2, mid[0], mid[1]) < 600)[0];
    if (!m || m.len < Math.max(300, rw.length * 0.5) || axisDiff(m.hdg, want) > 35) continue;
    used.add(m);
    let p = m.a, q = m.b;
    if (Math.abs(wrap180(m.hdg - want)) > 90) { p = m.b; q = m.a; }
    rw.leLat = p[0]; rw.leLon = p[1]; rw.heLat = q[0]; rw.heLon = q[1];
    rw.length = Math.round(m.len);
    if (m.width) rw.width = m.width;
    if (rw.surface === 'U' && m.surface) rw.surface = surfaceCode(m.surface);
    rw.src = 'S'; changed = true;
  }
  // real runways the database did not list at all
  for (const g of osm) {
    if (used.has(g) || g.len < 400 || haversine((g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2, ap.lat, ap.lon) > 3500) continue;
    const le = g.ids[0] || '', he = g.ids[1] || (le ? oppIdent(le) : '');
    if (!le || !he) continue;
    if (ap.runways.some((r) => r.le === le || r.he === le || r.le === he || r.he === he)) continue;
    let p = g.a, q = g.b;
    const n = identNum(le); if (!isNaN(n) && Math.abs(wrap180(g.hdg - (n + mv))) > 90) { p = g.b; q = g.a; }
    ap.runways.push({ le, he, leLat: p[0], leLon: p[1], heLat: q[0], heLon: q[1], width: g.width || (g.len >= 2800 ? 45 : g.len >= 1800 ? 30 : 23), length: Math.round(g.len), surface: surfaceCode(g.surface), lit: false, dispLe: 0, dispHe: 0, src: 'S' } as Runway);
    changed = true;
  }
  if (changed) { ap.approx = ap.runways.some((r) => r.src === 'H'); }
  return changed;
}

/** True when this airport still has any non-surveyed runway worth upgrading. */
export const needsRefine = (ap: Airport) => ap.runways.some((r) => r.src !== 'S');

/**
 * Upgrades the runway geometry of one airport from live OpenStreetMap data (cached). Safe to call repeatedly.
 * Resolves true if the airport's runways were changed.
 */
export function refineAirportRunways(ap: Airport | null | undefined): Promise<boolean> {
  if (!ap || done.has(ap.id) || !needsRefine(ap) || typeof fetch === 'undefined') return Promise.resolve(false);
  const hit = inflight.get(ap.id); if (hit) return hit;
  const p = (async () => {
    let osm: OsmRunway[] | null = loadCache(ap.id)?.runways ?? null;
    if (!osm) {
      osm = await fetchOsm(ap);
      if (osm === null) return false; // offline / rate-limited: retry on a later selection
      try { localStorage.setItem(KEY(ap.id), JSON.stringify({ t: Date.now(), runways: osm } satisfies CacheEntry)); } catch { /* quota */ }
    }
    done.add(ap.id);
    const changed = apply(ap, osm);
    if (changed) listeners.forEach((cb) => cb());
    return changed;
  })().finally(() => inflight.delete(ap.id));
  inflight.set(ap.id, p);
  return p;
}

/** Waits for a refinement but never longer than `ms` (used right before a flight loads). */
export const refineWithin = (ap: Airport | null | undefined, ms = 3500) =>
  Promise.race([refineAirportRunways(ap), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
