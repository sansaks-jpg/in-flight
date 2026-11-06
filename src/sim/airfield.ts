// Ground-movement logic built on the surveyed OpenStreetMap airfield layout:
//   * start positions (gates, stands, aprons, hangars)
//   * a taxi graph (taxiways + runways) and a shortest-path taxi route with real taxiway names
import { Airport, AirfieldLayout, LatLon, getAirfield } from '../data/airports';
import { D2R, R2D } from './geo';

export type SpotKind = 'gate' | 'stand' | 'apron' | 'hangar';
export interface StartSpot { id: string; kind: SpotKind; label: string; lat: number; lon: number; hdg: number }
export interface TaxiRoute { pts: LatLon[]; via: string[]; lengthM: number }

interface Frame { lat0: number; lon0: number; kx: number; ky: number }
const frameOf = (ap: Airport): Frame => ({ lat0: ap.lat, lon0: ap.lon, kx: 111320 * Math.cos(ap.lat * D2R), ky: 110574 });
const toXY = (f: Frame, lat: number, lon: number): [number, number] => [(lon - f.lon0) * f.kx, (lat - f.lat0) * f.ky];
const toLL = (f: Frame, x: number, y: number): LatLon => [f.lat0 + y / f.ky, f.lon0 + x / f.kx];

interface Edge { a: number; b: number; ref: string; rwy: boolean }
interface Graph { f: Frame; nx: number[]; ny: number[]; edges: Edge[]; hasTaxi: boolean }

const graphCache = new Map<string, Graph>();

function segProj(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t, qy = ay + dy * t;
  return { t, qx, qy, d: Math.hypot(px - qx, py - qy) };
}

function buildGraph(ap: Airport, layout: AirfieldLayout): Graph {
  const f = frameOf(ap);
  const nx: number[] = [], ny: number[] = [];
  const hash = new Map<string, number[]>();
  const CELL = 6;
  const addNode = (x: number, y: number): number => {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const c = hash.get(`${cx + i},${cy + j}`);
      if (c) for (const n of c) if (Math.hypot(nx[n] - x, ny[n] - y) < 4.5) return n;
    }
    const id = nx.length; nx.push(x); ny.push(y);
    const k = `${cx},${cy}`; (hash.get(k) || hash.set(k, []).get(k)!).push(id);
    return id;
  };
  const edges: Edge[] = [];
  const addLine = (pts: LatLon[], ref: string, rwy: boolean) => {
    let prev = -1;
    for (const [la, lo] of pts) {
      const [x, y] = toXY(f, la, lo); const n = addNode(x, y);
      if (prev >= 0 && prev !== n) edges.push({ a: prev, b: n, ref, rwy });
      prev = n;
    }
  };
  for (const t of layout.taxiways) addLine(t.pts, t.ref, false);
  const nTaxiEdges = edges.length;
  const runwayStart = edges.length;
  for (const r of ap.runways) addLine([[r.leLat, r.leLon], [r.heLat, r.heLon]], r.le + '/' + r.he, true);

  // T-junctions: dangling taxiway ends snap onto the nearest edge (taxiway or runway) they touch.
  const deg = new Int32Array(nx.length);
  for (const e of edges) { deg[e.a]++; deg[e.b]++; }
  const snaps: { n: number; e: number; qx: number; qy: number; t: number }[] = [];
  for (let n = 0; n < nx.length; n++) {
    if (deg[n] > 1) continue;
    let best = -1, bd = 1e9, bq: { qx: number; qy: number; t: number } | null = null;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]; if (e.a === n || e.b === n) continue;
      const lim = e.rwy ? 70 : 12;
      const p = segProj(nx[n], ny[n], nx[e.a], ny[e.a], nx[e.b], ny[e.b]);
      if (p.d < lim && p.d < bd) { bd = p.d; best = i; bq = p; }
    }
    if (best >= 0 && bq) snaps.push({ n, e: best, qx: bq.qx, qy: bq.qy, t: bq.t });
  }
  // apply snaps: split edges at the junction point (per-edge, ordered along the edge)
  const byEdge = new Map<number, typeof snaps>();
  for (const s of snaps) (byEdge.get(s.e) || byEdge.set(s.e, []).get(s.e)!).push(s);
  const dead = new Set<number>();
  for (const [ei, list] of byEdge) {
    const e = edges[ei]; dead.add(ei);
    list.sort((p, q) => p.t - q.t);
    let prev = e.a;
    for (const s of list) {
      const j = addNode(s.qx, s.qy);
      if (j !== prev) edges.push({ a: prev, b: j, ref: e.ref, rwy: e.rwy });
      if (j !== s.n) edges.push({ a: s.n, b: j, ref: e.rwy ? '' : e.ref, rwy: false });
      prev = j;
    }
    if (prev !== e.b) edges.push({ a: prev, b: e.b, ref: e.ref, rwy: e.rwy });
  }
  const finalEdges = edges.filter((_, i) => !dead.has(i));
  void nTaxiEdges; void runwayStart;
  return { f, nx, ny, edges: finalEdges, hasTaxi: layout.taxiways.length > 0 };
}

function graphFor(ap: Airport): Graph | null {
  const layout = getAirfield(ap);
  if (!layout || !layout.taxiways.length) return null;
  let g = graphCache.get(ap.id);
  if (!g) { g = buildGraph(ap, layout); graphCache.set(ap.id, g); }
  return g;
}

/** Shortest taxi route (m) from a start position to the physical end of a runway. Null when the airfield has no taxiway data. */
export function taxiRoute(ap: Airport, from: LatLon, to: LatLon, rwyPair: string): TaxiRoute | null {
  const g = graphFor(ap); if (!g) return null;
  const { f, nx, ny, edges } = g;
  const N = nx.length;
  const adj: { to: number; w: number; ref: string; rwy: boolean }[][] = Array.from({ length: N + 2 }, () => []);
  for (const e of edges) {
    const len = Math.hypot(nx[e.a] - nx[e.b], ny[e.a] - ny[e.b]);
    // Other runways are crossed only when needed, the departure runway can be used for back-taxi.
    const pen = e.rwy ? (e.ref === rwyPair ? 1.4 : 5) : 1;
    adj[e.a].push({ to: e.b, w: len * pen, ref: e.ref, rwy: e.rwy });
    adj[e.b].push({ to: e.a, w: len * pen, ref: e.ref, rwy: e.rwy });
  }
  const S = N, T = N + 1;
  const [sx, sy] = toXY(f, from[0], from[1]), [tx, ty] = toXY(f, to[0], to[1]);
  const near = (x: number, y: number, k: number, max: number) => {
    const arr: [number, number][] = [];
    for (let i = 0; i < N; i++) { const d = Math.hypot(nx[i] - x, ny[i] - y); if (d < max) arr.push([d, i]); }
    return arr.sort((p, q) => p[0] - q[0]).slice(0, k);
  };
  const sN = near(sx, sy, 3, 600); if (!sN.length) return null;
  const tN = near(tx, ty, 2, 400); if (!tN.length) return null;
  for (const [d, i] of sN) { adj[S].push({ to: i, w: d * 1.1, ref: '', rwy: false }); adj[i].push({ to: S, w: d * 1.1, ref: '', rwy: false }); }
  for (const [d, i] of tN) { adj[i].push({ to: T, w: d, ref: '', rwy: false }); adj[T].push({ to: i, w: d, ref: '', rwy: false }); }
  // Dijkstra (binary heap)
  const dist = new Float64Array(N + 2).fill(Infinity), prev = new Int32Array(N + 2).fill(-1), prevRef = new Array<string>(N + 2).fill('');
  const heap: [number, number][] = [[0, S]]; dist[S] = 0;
  const push = (it: [number, number]) => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  while (heap.length) {
    const [d, u] = pop(); if (d > dist[u]) continue; if (u === T) break;
    for (const e of adj[u]) { const nd = d + e.w; if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; prevRef[e.to] = e.ref; push([nd, e.to]); } }
  }
  if (!isFinite(dist[T])) return null;
  const idx: number[] = []; const refs: string[] = [];
  for (let c = T; c !== -1; c = prev[c]) { idx.push(c); refs.push(prevRef[c]); }
  idx.reverse(); refs.reverse();
  const pts: LatLon[] = []; let length = 0, last: [number, number] | null = null;
  for (const i of idx) {
    const x = i === S ? sx : i === T ? tx : nx[i], y = i === S ? sy : i === T ? ty : ny[i];
    if (last) length += Math.hypot(x - last[0], y - last[1]);
    last = [x, y]; pts.push(toLL(f, x, y));
  }
  const via: string[] = [];
  for (const r of refs) { const nm = r.includes('/') ? '' : r; if (nm && via[via.length - 1] !== nm) via.push(nm); }
  return { pts, via, lengthM: length };
}

function ringArea(r: LatLon[]) { let a = 0; for (let i = 0; i < r.length; i++) { const [y1, x1] = r[i], [y2, x2] = r[(i + 1) % r.length]; a += x1 * y2 - x2 * y1; } return Math.abs(a) / 2; }
const ringCentroid = (r: LatLon[]): LatLon => [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];

/** Direction (true degrees) a parked aircraft should face: towards the closest taxiway, else towards `fallback`. */
function exitHeading(ap: Airport, lat: number, lon: number, fallback: LatLon): number {
  const g = graphFor(ap);
  if (g) {
    const [px, py] = toXY(g.f, lat, lon);
    let best = 1e9, bq: [number, number] | null = null;
    for (const e of g.edges) {
      if (e.rwy) continue;
      const p = segProj(px, py, g.nx[e.a], g.ny[e.a], g.nx[e.b], g.ny[e.b]);
      if (p.d < best) { best = p.d; bq = [p.qx, p.qy]; }
    }
    if (bq && best < 400 && best > 3) return ((Math.atan2(bq[0] - px, bq[1] - py) * R2D) + 360) % 360;
  }
  const [px, py] = toXY(frameOf(ap), lat, lon), [fx, fy] = toXY(frameOf(ap), fallback[0], fallback[1]);
  return ((Math.atan2(fx - px, fy - py) * R2D) + 360) % 360;
}

const spotCache = new Map<string, StartSpot[]>();
/** Parking / start positions available at an airfield (from surveyed gates, stands, aprons and hangars). */
export function startSpots(ap: Airport): StartSpot[] {
  const hit = spotCache.get(ap.id); if (hit) return hit;
  const L = getAirfield(ap); const out: StartSpot[] = [];
  if (L) {
    const r0 = ap.runways[0]; const fb: LatLon = r0 ? [r0.leLat, r0.leLon] : [ap.lat, ap.lon];
    const gates = L.stands.filter((s) => s.gate), stands = L.stands.filter((s) => !s.gate);
    const labelOf = (s: { ref: string }, i: number, pre: string) => (s.ref ? `${pre} ${s.ref}` : `${pre} #${i + 1}`);
    gates.slice(0, 30).forEach((s, i) => out.push({ id: `gate:${s.ref || i}:${i}`, kind: 'gate', label: labelOf(s, i, 'Gate'), lat: s.lat, lon: s.lon, hdg: exitHeading(ap, s.lat, s.lon, fb) }));
    stands.slice(0, 30).forEach((s, i) => out.push({ id: `stand:${s.ref || i}:${i}`, kind: 'stand', label: labelOf(s, i, 'Stand'), lat: s.lat, lon: s.lon, hdg: exitHeading(ap, s.lat, s.lon, fb) }));
    L.aprons.filter((a) => a.ring.length >= 3).map((a) => ({ a, area: ringArea(a.ring) })).sort((p, q) => q.area - p.area).slice(0, 6).forEach(({ a }, i) => {
      const [la, lo] = ringCentroid(a.ring);
      out.push({ id: `apron:${i}`, kind: 'apron', label: a.name ? `Apron · ${a.name}` : `Apron ${i + 1}`, lat: la, lon: lo, hdg: exitHeading(ap, la, lo, fb) });
    });
    L.hangars.filter((h) => h.ring.length >= 3).slice(0, 10).forEach((h, i) => {
      const [la, lo] = ringCentroid(h.ring);
      out.push({ id: `hangar:${i}`, kind: 'hangar', label: h.name ? `Hangar · ${h.name}` : `Hangar ${i + 1}`, lat: la, lon: lo, hdg: exitHeading(ap, la, lo, fb) });
    });
  }
  if (L && !out.length) {
    const r0 = ap.runways[0]; const fb: LatLon = r0 ? [r0.leLat, r0.leLon] : [ap.lat, ap.lon];
    L.terminals.filter((t) => t.ring.length >= 3).slice(0, 4).forEach((t, i) => {
      const [la, lo] = ringCentroid(t.ring);
      out.push({ id: `terminal:${i}`, kind: 'apron', label: t.name ? `Terminal · ${t.name}` : `Terminal ${i + 1}`, lat: la, lon: lo, hdg: exitHeading(ap, la, lo, fb) });
    });
  }
  spotCache.set(ap.id, out);
  return out;
}
export const findStartSpot = (ap: Airport, id: string) => startSpots(ap).find((s) => s.id === id) || null;
