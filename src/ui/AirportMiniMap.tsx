// Dedicated airport / runway navigation display (top-left). It is independent of the full-screen chart ('M'): its own
// range, orientation and content – runways with true widths and idents, taxiways, aprons, hangars, terminals, stands,
// hold-short points, the taxi route to the departure runway, the final-approach course and the aircraft drawn at its
// real wingspan / length. Range auto-scales with the phase of flight (airport diagram on the ground, approach scale in
// the air, en-route chart in cruise) and can be overridden with + / −.
//
// Airborne the chart keeps MSFS-mini-map / en-route-chart conventions instead of collapsing to an empty rose: the full
// flight-plan polyline (great-circle densified beyond ~120 km legs) with labelled waypoints and origin/destination
// markers, the flown track, nearby airports and NAVAIDs from the open databases, a lat/lon graticule, a rotating
// magnetic compass rose (MSFS/ND: labels in degrees magnetic, gold cardinals) with labelled range rings,
// heading/track/AP bugs, a wind arrow and a one-minute track vector with 1/2/3-minute run markers. The palette
// mirrors MapPanel.tsx (magenta plan, cyan trail, gold IAF/FAF diamonds, pink TOD) so the mini map and the full-screen
// chart ('M') read consistently.
import { useEffect, useRef, useState } from 'react';
import type { Game, HudState } from '../sim/game';
import { getAirfield, airportsNear, navaidsNear, type Airport } from '../data/airports';
import { synthGround, rectCorners, type XZ } from '../sim/airportGround';
import { D2R, R2D, M_PER_NM, clamp, greatCircle, haversine, wrap360, type FlightWaypoint } from '../sim/geo';

const RANGES = [400, 800, 1500, 3000, 6000, 12000, 25000, 50000, 100000, 200000, 400000];
const fmtRange = (m: number) => m >= 3000 ? `${(m / M_PER_NM).toFixed(m >= 9000 ? 0 : 1)} NM` : `${m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m'}`;
/** En-route auto range: past 22 km from the destination the window opens onto a cruise chart instead of capping at 12 km. */
export const enrouteRange = (dM: number) => clamp(dM * 0.55, 12000, 200000);
const GRID_LADDER = [0.05, 0.1, 0.25, 0.5, 1, 2, 5]; // graticule step candidates, degrees
/** Graticule step keeps 4–5 parallels/meridians across the window (1° lat ≈ 111,320 m). */
export const gridStepFor = (rangeM: number) => GRID_LADDER.find((s) => s * 111320 >= rangeM * 0.45) ?? 5;
/** Dash patterns & ladders hoisted out of the per-frame path (zero-allocation render rule). */
const NO_DASH: number[] = [], DASH_CENTER = [6, 8], DASH_TAXI = [7, 5], DASH_FINAL = [8, 6], DASH_PLAN = [9, 6], DASH_TRACK = [4, 3], DASH_NDB = [2, 2], DASH_VIS = [3, 4];
const SCALE_STEPS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000];
const FINAL_GATES = [5, 10]; // gate distances (NM) painted along the final course
const LBL_MAX = 96;          // label-rect capacity of the collision scratch (culling, not allocation)
/** Graticule lattice span: covers every chart range (400 km) plus rotation diagonal, metres. */
const GRID_SPAN_M = 620000;

interface Geo {
  ap: Airport; taxi: { pts: XZ[]; w: number; ref: string }[]; aprons: XZ[][]; hangars: { ring: XZ[]; name: string }[]; terminals: XZ[][];
  stands: XZ[]; holds: { p: XZ; ref: string }[];
}
interface PlanWp { p: XZ; name: string; type: FlightWaypoint['type']; active: boolean }
interface CtxNavaid { x: number; z: number; ident: string; vor: boolean }
interface CtxAirport { x: number; z: number; icao: string; size: 0 | 1 | 2 }
interface FallbackRwy { ax: number; az: number; bx: number; bz: number; w: number; le: string; he: string; dep: boolean; arr: boolean }
interface Cache {
  proj: unknown; at: number; geos: Geo[]; appr: { x: number; z: number; hdg: number; ident: string; ils: boolean } | null;
  route: XZ[]; wps: PlanWp[];
  /** Full flight-plan polyline; legs beyond ~120 km follow the great circle so long routes curve like on the chart. */
  plan: XZ[];
  /** Flown track history (MapState.trail projected into the chart plane). */
  trail: XZ[];
  /** Destination field position for the rim chevron when the field is outside the window. */
  toP: XZ;
  /** En-route context within chart reach: airports not already diagrammed + NAVAIDs (symbols + labels). */
  ctxAp: CtxAirport[]; navaids: CtxNavaid[];
  /** Origin/destination runways once the streamed world no longer covers them (> 42 km, world.rebuildAirports). */
  ctxRw: FallbackRwy[];
  /** World-fixed lat/lon lattice around the aircraft spanning GRID_SPAN_M both ways. */
  gridStep: number; lat0: number; lat1: number; lon0: number; lon1: number;
  /** Freshness keys: a waypoint sequence, phase flip or approach change redraws before the 1.5 s throttle. */
  planRef: unknown; awIdx: number; ground: boolean; apprKey: string; depRwy: string;
}

function buildGeo(ap: Airport, proj: { x(lon: number): number; z(lat: number): number }): Geo {
  const P = (r: [number, number][]) => r.map(([la, lo]) => [proj.x(lo), proj.z(la)] as XZ);
  const L = getAirfield(ap);
  if (L) return { ap, taxi: L.taxiways.map((t) => ({ pts: P(t.pts), w: Math.max(8, Math.min(30, t.width)), ref: t.ref })), aprons: L.aprons.map((a) => P(a.ring)), hangars: L.hangars.map((h) => ({ ring: P(h.ring), name: h.name })), terminals: L.terminals.map((t) => P(t.ring)), stands: L.stands.map((s) => [proj.x(s.lon), proj.z(s.lat)] as XZ), holds: L.holds.map((h) => ({ p: [proj.x(h.lon), proj.z(h.lat)] as XZ, ref: h.ref })) };
  const g = synthGround(ap, proj); const geo: Geo = { ap, taxi: [], aprons: [], hangars: [], terminals: [], stands: [], holds: [] };
  if (g) {
    geo.taxi.push({ pts: [g.taxiway.a, g.taxiway.b], w: g.taxiWidth, ref: 'A' });
    geo.aprons.push(rectCorners(g.hangarApron));
    for (const h of g.hangars) geo.hangars.push({ ring: rectCorners(h.rect), name: h.name });
    const f = [Math.sin(g.hdg * D2R), -Math.cos(g.hdg * D2R)], r = [Math.cos(g.hdg * D2R) * g.side, Math.sin(g.hdg * D2R) * g.side];
    const c: XZ = [g.cx + f[0] * g.termAlong + r[0] * (g.taxiLat + 70), g.cz + f[1] * g.termAlong + r[1] * (g.taxiLat + 70)];
    geo.terminals.push(rectCorners({ cx: c[0], cz: c[1], hl: g.gaOnly ? 13 : 110, hw: g.gaOnly ? 6 : 19, hdg: g.hdg }));
  }
  return geo;
}

export function AirportMiniMap({ game, hud }: { game: Game; hud: HudState }) {
  const canvas = useRef<HTMLCanvasElement>(null), box = useRef<HTMLDivElement>(null);
  const [auto, setAuto] = useState(true), [idx, setIdx] = useState(3), [north, setNorth] = useState(false);
  const st = useRef({ auto: true, idx: 3, north: false, range: 900, hud });
  st.current.auto = auto; st.current.idx = idx; st.current.north = north; st.current.hud = hud;
  const [label, setLabel] = useState('');

  useEffect(() => {
    const cv = canvas.current!, g = cv.getContext('2d')!; let raf = 0, cache: Cache | null = null, last = performance.now(), lastLabel = '', size = 0;
    const resize = () => { const r = box.current!.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1); size = Math.round(r.width); cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d); g.setTransform(d, 0, 0, d, 0, 0); };
    resize(); const ro = new ResizeObserver(resize); ro.observe(box.current!);
    // Label collision scratch: reused Float64Array of [x1,y1,x2,y2] rects, rewritten each frame (no per-frame allocation).
    const LBL = new Float64Array(LBL_MAX * 4); let lblN = 0;
    const lblFit = (x1: number, y1: number, x2: number, y2: number) => {
      for (let i = 0; i < lblN; i++) { const o = i * 4; if (x1 < LBL[o + 2] && x2 > LBL[o] && y1 < LBL[o + 3] && y2 > LBL[o + 1]) return false; }
      return true;
    };
    const lblPush = (x1: number, y1: number, x2: number, y2: number) => { if (lblN < LBL_MAX) { const o = lblN * 4; LBL[o] = x1; LBL[o + 1] = y1; LBL[o + 2] = x2; LBL[o + 3] = y2; lblN++; } };
    const refresh = (): Cache | null => {
      const w = game.world; if (!w || !game.fm) return null;
      const ms = game.getMapState(), proj = w.proj;
      const near = airportsNear(ms.lat, ms.lon, 30000).filter((a) => a.runways.length).sort((a, b) => Math.hypot(a.lat - ms.lat, a.lon - ms.lon) - Math.hypot(b.lat - ms.lat, b.lon - ms.lon)).slice(0, 4);
      // Origin and destination are always diagrammed so their runways survive beyond the streamed world (> 42 km).
      const set = new Map<string, Airport>(); for (const a of [game.cfg.from, game.cfg.to, ...near]) set.set(a.id, a);
      // En-route context: airports + NAVAIDs within ~2.5 chart ranges (cheap at the ~0.7 Hz refresh rate).
      const reach = clamp(st.current.range * 2.5, 50000, 500000);
      const ctxList = airportsNear(ms.lat, ms.lon, reach).filter((a) => !set.has(a.id) && a.runways.length);
      ctxList.sort((a, b) => haversine(ms.lat, ms.lon, a.lat, a.lon) - haversine(ms.lat, ms.lon, b.lat, b.lon));
      const ctxAp: CtxAirport[] = [];
      for (let i = 0; i < ctxList.length && ctxAp.length < 10; i++) ctxAp.push({ x: proj.x(ctxList[i].lon), z: proj.z(ctxList[i].lat), icao: ctxList[i].icao, size: ctxList[i].size });
      const navList = navaidsNear(ms.lat, ms.lon, reach);
      navList.sort((a, b) => haversine(ms.lat, ms.lon, a.lat, a.lon) - haversine(ms.lat, ms.lon, b.lat, b.lon));
      const navaids: CtxNavaid[] = [];
      for (let i = 0; i < navList.length && navaids.length < 12; i++) navaids.push({ x: proj.x(navList[i].lon), z: proj.z(navList[i].lat), ident: navList[i].ident, vor: navList[i].type.startsWith('VOR') || navList[i].type === 'TACAN' });
      // Runways of the diagrammed fields when world.runways does not carry them (world rebuilds at 42 km around the aircraft).
      const wAp = new Set<string>(); for (const r of w.runways) wAp.add(r.ap.id);
      const ctxRw: FallbackRwy[] = [];
      for (const G of set.values()) {
        if (wAp.has(G.id)) continue; // the streamed world already provides the surveyed geometry
        for (const r of G.runways) ctxRw.push({
          ax: proj.x(r.leLon), az: proj.z(r.leLat), bx: proj.x(r.heLon), bz: proj.z(r.heLat), w: r.width, le: r.le, he: r.he,
          dep: !!game.depTh && game.depTh.rw === r,
          arr: !!ms.appr && G.id === game.cfg.to.id && (r.le === ms.appr.ident || r.he === ms.appr.ident),
        });
      }
      // Flight-plan polyline: legs are straight in the local chart plane; beyond ~120 km they follow the great circle.
      const plan: XZ[] = [];
      for (let i = 0; i < ms.flightPlan.length; i++) {
        const a = ms.flightPlan[i];
        plan.push([proj.x(a.lon), proj.z(a.lat)]);
        if (i + 1 < ms.flightPlan.length) {
          const b = ms.flightPlan[i + 1], d = haversine(a.lat, a.lon, b.lat, b.lon);
          if (d > 120000) { const gc = greatCircle(a.lat, a.lon, b.lat, b.lon, Math.min(16, Math.round(d / 100000))); for (let j = 1; j < gc.length; j++) plan.push([proj.x(gc[j][1]), proj.z(gc[j][0])]); }
        }
      }
      const trail: XZ[] = ms.trail.map(([la, lo]) => [proj.x(lo), proj.z(la)] as XZ);
      const gs = gridStepFor(st.current.range), latSpan = GRID_SPAN_M / 111320, lonSpan = GRID_SPAN_M / (111320 * Math.max(0.2, Math.cos(ms.lat * D2R)));
      return {
        proj, at: performance.now(),
        geos: [...set.values()].map((a) => buildGeo(a, proj)),
        appr: ms.appr ? { x: proj.x(ms.appr.lon), z: proj.z(ms.appr.lat), hdg: ms.appr.hdg, ident: ms.appr.ident, ils: !!ms.appr.ils } : null,
        route: ms.navPath.map(([la, lo]) => [proj.x(lo), proj.z(la)] as XZ),
        wps: ms.flightPlan.map((wp, i) => ({ p: [proj.x(wp.lon), proj.z(wp.lat)] as XZ, name: wp.name, type: wp.type, active: i === ms.activeWpIdx })),
        plan, trail, toP: [proj.x(game.cfg.to.lon), proj.z(game.cfg.to.lat)] as XZ,
        ctxAp, navaids, ctxRw,
        gridStep: gs, lat0: ms.lat - latSpan, lat1: ms.lat + latSpan, lon0: ms.lon - lonSpan, lon1: ms.lon + lonSpan,
        planRef: ms.flightPlan, awIdx: ms.activeWpIdx, ground: game.fm.wow, apprKey: game.apprKey, depRwy: game.depRwy,
      };
    };
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!game.world || !game.fm || !size) return;
      // Rebuild early when navigation state moved (waypoint sequenced, phase flip, approach/departure runway change) —
      // the 1.5 s throttle alone could show a stale active leg for up to a full refresh interval.
      if (!cache || cache.proj !== game.world.proj || cache.planRef !== game.flightPlan || cache.awIdx !== game.activeWpIdx ||
          cache.ground !== game.fm.wow || cache.apprKey !== game.apprKey || cache.depRwy !== game.depRwy || now - cache.at > 1500) cache = refresh() ?? cache;
      if (!cache) return;
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const fm = game.fm, px = fm.pos.x, pz = fm.pos.z, h = fm.heading * D2R, S = st.current;
      // ---- range ----
      const ground = fm.wow, th = game.depTh, ex = cache.appr;
      const toDep = th ? Math.hypot(px - th.startX, pz - th.startZ) : 0;
      let target: number;
      if (S.auto) {
        if (ground) target = fm.gs > 30 ? 1500 : Math.min(2600, Math.max(800, toDep * 0.7 + 300));
        else {
          const d = ex ? Math.hypot(px - ex.x, pz - ex.z) : 1e9;
          // Approach scale inside 22 km; en-route the window opens onto a cruise chart (12–200 km) instead of flat 12 km.
          target = d < 22000 ? Math.min(12000, Math.max(3000, d * 1.1)) : enrouteRange(d);
        }
      } else target = RANGES[S.idx];
      S.range += (target - S.range) * (1 - Math.exp(-dt * 3));
      const W = size, H = size, R = W * 0.5 - 6, k = R / S.range;
      const cx = W / 2, cy = ground || S.north ? H / 2 : H * 0.6;
      const fx = S.north ? 0 : Math.sin(h), fz = S.north ? -1 : -Math.cos(h), rx = -fz, rz = fx;
      const up = S.north ? 0 : h; // screen-up bearing: the rose, bugs, track vector and wind ride this rotation
      const sx = (x: number, z: number) => cx + ((x - px) * rx + (z - pz) * rz) * k, sy = (x: number, z: number) => cy - ((x - px) * fx + (z - pz) * fz) * k;
      const line = (pts: XZ[], close = false) => { g.beginPath(); pts.forEach(([x, z], i) => (i ? g.lineTo(sx(x, z), sy(x, z)) : g.moveTo(sx(x, z), sy(x, z)))); if (close) g.closePath(); };
      const line2 = (ax: number, az: number, bx: number, bz: number) => { g.beginPath(); g.moveTo(sx(ax, az), sy(ax, az)); g.lineTo(sx(bx, bz), sy(bx, bz)); };
      const proj = game.world.proj, acLat = proj.lat(pz), acLon = proj.lon(px);
      lblN = 0;
      g.clearRect(0, 0, W, H); g.fillStyle = '#0f171d'; g.fillRect(0, 0, W, H);
      g.save(); g.beginPath(); g.rect(0, 0, W, H); g.clip();
      // ---- range rings (airport diagram) or MSFS-style compass rose (en-route) ----
      if (ground) {
        g.strokeStyle = '#ffffff14'; g.lineWidth = 1; for (let i = 1; i <= 2; i++) { g.beginPath(); g.arc(cx, cy, R * i / 2, 0, 7); g.stroke(); }
      } else {
        // MSFS/ND-style MAGNETIC rose: labels are magnetic bearings (what the HUD and the AP fly),
        // placed at their true angle (magnetic + local variation); gold cardinal letters.
        const mv = game.magv;
        g.strokeStyle = '#ffffff18'; g.lineWidth = 1;
        g.beginPath(); g.arc(cx, cy, R, 0, 7); g.stroke();
        g.beginPath(); g.arc(cx, cy, R * 0.5, 0, 7); g.stroke();
        g.font = '600 8px ui-sans-serif, system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
        for (let d = 0; d < 360; d += 5) { // d = the magnetic bearing printed on the label
          const a = wrap360(d + mv) * D2R - up, sn = Math.sin(a), co = Math.cos(a), major = d % 30 === 0;
          g.strokeStyle = major ? '#ffffff3c' : '#ffffff1a';
          g.beginPath(); g.moveTo(cx + sn * (R - (major ? 7 : 3.5)), cy - co * (R - (major ? 7 : 3.5))); g.lineTo(cx + sn * R, cy - co * R); g.stroke();
          if (major && R >= 44) {
            g.fillStyle = d % 90 === 0 ? '#ffb347' : '#c3d0da';
            g.fillText(d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d / 10), cx + sn * (R - 15), cy - co * (R - 15));
          }
        }
        // ring range labels, screen-anchored on the 45° diagonal so they never rotate away
        g.fillStyle = '#8fa3b3';
        g.fillText(fmtRange(S.range * 0.5), cx + (R * 0.5 - 8) * 0.707, cy - (R * 0.5 - 8) * 0.707);
        g.fillText(fmtRange(S.range), cx + (R - 8) * 0.707, cy - (R - 8) * 0.707);
      }
      // ---- en-route graticule: subtle meridian/parallel lattice so the chart is never empty far from airports ----
      if (!ground && cache.gridStep * 111320 * k >= 24) {
        const gsDeg = cache.gridStep;
        const latHalf = (S.range / 111320) * 1.3 + gsDeg, lonHalf = (S.range / (111320 * Math.max(0.2, Math.cos(acLat * D2R)))) * 1.3 + gsDeg;
        g.strokeStyle = 'rgba(158,186,209,.11)'; g.lineWidth = 1;
        g.beginPath();
        for (let la = Math.ceil((acLat - latHalf) / gsDeg) * gsDeg; la <= acLat + latHalf; la += gsDeg) {
          if (la < cache.lat0 || la > cache.lat1) continue;
          const wz = proj.z(la);
          g.moveTo(sx(proj.x(cache.lon0), wz), sy(proj.x(cache.lon0), wz)); g.lineTo(sx(proj.x(cache.lon1), wz), sy(proj.x(cache.lon1), wz));
        }
        for (let lo = Math.ceil((acLon - lonHalf) / gsDeg) * gsDeg; lo <= acLon + lonHalf; lo += gsDeg) {
          if (lo < cache.lon0 || lo > cache.lon1) continue;
          const wx = proj.x(lo);
          g.moveTo(sx(wx, proj.z(cache.lat0)), sy(wx, proj.z(cache.lat0))); g.lineTo(sx(wx, proj.z(cache.lat1)), sy(wx, proj.z(cache.lat1)));
        }
        g.stroke();
      }
      const detail = S.range <= 3200;
      for (const G of cache.geos) {
        g.fillStyle = '#243038'; for (const a of G.aprons) { line(a, true); g.fill(); }
        g.lineCap = 'round'; g.lineJoin = 'round';
        for (const t of G.taxi) { g.strokeStyle = '#56646e'; g.lineWidth = Math.max(1.5, t.w * k); line(t.pts); g.stroke(); }
        if (detail) for (const t of G.taxi) { g.strokeStyle = '#e8c33a66'; g.lineWidth = 1; line(t.pts); g.stroke(); }
        g.fillStyle = '#7e8b96'; for (const hg of G.hangars) { line(hg.ring, true); g.fill(); }
        g.fillStyle = '#b4c4d3'; for (const tm of G.terminals) { line(tm, true); g.fill(); }
        if (detail) { g.fillStyle = '#f5d442'; for (const s of G.stands) { g.beginPath(); g.arc(sx(s[0], s[1]), sy(s[0], s[1]), 1.6, 0, 7); g.fill(); } g.fillStyle = '#f2c200'; for (const hp of G.holds) { g.fillRect(sx(hp.p[0], hp.p[1]) - 3, sy(hp.p[0], hp.p[1]) - 1, 6, 2); } }
        if (S.range <= 1800) { g.font = '600 9px ui-sans-serif, system-ui'; g.textAlign = 'center'; g.fillStyle = '#e9eef2'; for (const hg of G.hangars) if (hg.name) { const c = hg.ring[0]; g.fillText('HGR', sx(c[0], c[1]), sy(c[0], c[1]) - 4); } g.fillStyle = '#9fb3c4'; for (const t of G.taxi) if (t.ref && t.pts.length > 1) { const m = t.pts[t.pts.length >> 1]; g.fillText(t.ref, sx(m[0], m[1]), sy(m[0], m[1]) - 3); } }
      }
      // runways: true width (min 3 px), dep = green, arrival = cyan
      for (const r of game.world.runways) {
        const dep = th && r.rw === th.rw, arr = ex && r.ap.id === game.cfg.to.id && (r.rw.le === ex.ident || r.rw.he === ex.ident);
        g.lineCap = 'butt'; g.strokeStyle = dep ? '#58d68d' : arr ? '#4cc3ff' : '#d4dbe0'; g.lineWidth = Math.max(3, r.wid * k);
        line2(r.ax, r.az, r.bx, r.bz); g.stroke();
        g.strokeStyle = '#0f171d'; g.lineWidth = 1; g.setLineDash(DASH_CENTER); line2(r.ax, r.az, r.bx, r.bz); g.stroke(); g.setLineDash(NO_DASH);
        g.font = '700 10px ui-sans-serif, system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff';
        const ux = r.bx - r.ax, uz = r.bz - r.az, L = Math.hypot(ux, uz) || 1, off = 12 / k;
        if (S.range <= 12000 || L * k > 26) { g.fillText(r.rw.le, sx(r.ax - ux / L * off, r.az - uz / L * off), sy(r.ax - ux / L * off, r.az - uz / L * off)); g.fillText(r.rw.he, sx(r.bx + ux / L * off, r.bz + uz / L * off), sy(r.bx + ux / L * off, r.bz + uz / L * off)); }
      }
      // runways beyond the streamed world (> 42 km): same styling, projected from the airport database
      for (const r of cache.ctxRw) {
        const ux = r.bx - r.ax, uz = r.bz - r.az, L = Math.hypot(ux, uz) || 1;
        g.lineCap = 'butt'; g.strokeStyle = r.dep ? '#58d68d' : r.arr ? '#4cc3ff' : '#d4dbe0'; g.lineWidth = Math.max(2.5, r.w * k);
        line2(r.ax, r.az, r.bx, r.bz); g.stroke();
        if (L * k > 4) { g.strokeStyle = '#0f171d'; g.lineWidth = 1; g.setLineDash(DASH_CENTER); line2(r.ax, r.az, r.bx, r.bz); g.stroke(); g.setLineDash(NO_DASH); }
        const off = 12 / k;
        if (S.range <= 12000 || L * k > 26) {
          g.font = '700 10px ui-sans-serif, system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff';
          g.fillText(r.le, sx(r.ax - ux / L * off, r.az - uz / L * off), sy(r.ax - ux / L * off, r.az - uz / L * off));
          g.fillText(r.he, sx(r.bx + ux / L * off, r.bz + uz / L * off), sy(r.bx + ux / L * off, r.bz + uz / L * off));
        }
      }
      // taxi route to the departure runway (from the aircraft forward)
      if (ground && th && game.depStageActive) {
        let pts: XZ[] = game.taxiPlan ? game.taxiPlan.pts.map(([la, lo]) => [game.world!.proj.x(lo), game.world!.proj.z(la)] as XZ) : (game.spawn?.path ?? [[px, pz], [th.startX, th.startZ]]);
        let bi = 0, bd = 1e18; for (let i = 0; i + 1 < pts.length; i++) { const d = Math.hypot(pts[i + 1][0] - px, pts[i + 1][1] - pz); if (d < bd) { bd = d; bi = i; } }
        pts = [[px, pz], ...pts.slice(bi + 1)];
        g.strokeStyle = '#05080b'; g.lineWidth = 5; line(pts); g.stroke(); g.strokeStyle = '#ff5cf0'; g.lineWidth = 2.4; g.setLineDash(DASH_TAXI); g.lineDashOffset = -now / 60; line(pts); g.stroke(); g.setLineDash(NO_DASH);
        g.fillStyle = '#58d68d'; g.beginPath(); g.arc(sx(th.startX, th.startZ), sy(th.startX, th.startZ), 4.5, 0, 7); g.fill();
      }
      // ---- airborne navigation content (MSFS en-route mini map) ----
      if (!ground) {
        // flown track, light so it never competes with the plan
        if (cache.trail.length > 1) { g.strokeStyle = '#35e0ff'; g.globalAlpha = 0.5; g.lineWidth = 1.2; g.lineJoin = 'round'; line(cache.trail); g.stroke(); g.globalAlpha = 1; }
        // flight-plan polyline: dark casing + dashed magenta (same palette as the full-screen chart)
        if (cache.plan.length > 1) {
          g.lineJoin = 'round'; g.lineCap = 'round';
          g.strokeStyle = '#0a0f14'; g.lineWidth = 4; line(cache.plan); g.stroke();
          g.setLineDash(DASH_PLAN); g.strokeStyle = '#e58ada'; g.lineWidth = 2; line(cache.plan); g.stroke(); g.setLineDash(NO_DASH);
        }
        // final-approach two-leg path stays live through the last 18 km
        if (cache.route.length > 1) { g.strokeStyle = '#e58ada'; g.lineWidth = 2; line(cache.route); g.stroke(); }
        // approach course (destination runway) and gate marks
        if (ex) {
          const a = ex.hdg * D2R, ext = 18520;
          g.strokeStyle = '#4cc3ff'; g.lineWidth = 1.6; g.setLineDash(DASH_FINAL);
          line2(ex.x, ex.z, ex.x - Math.sin(a) * ext, ex.z + Math.cos(a) * ext); g.stroke(); g.setLineDash(NO_DASH);
          g.fillStyle = '#4cc3ff'; g.font = '600 9px ui-sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
          for (const nm of FINAL_GATES) {
            const qx = ex.x - Math.sin(a) * nm * M_PER_NM, qz = ex.z + Math.cos(a) * nm * M_PER_NM, gx = sx(qx, qz), gy = sy(qx, qz);
            g.beginPath(); g.arc(gx, gy, 2.4, 0, 7); g.fill();
            g.fillText(`${nm}`, gx + 5, gy - 4);
          }
          const ix = sx(ex.x, ex.z), iy = sy(ex.x, ex.z);
          if (ix > 4 && iy > 4 && ix < W - 4 && iy < H - 4 && S.range <= 50000) {
            const tag = `${ex.ils ? 'ILS' : 'RWY'} ${ex.ident}`;
            g.font = '700 9px ui-sans-serif, system-ui'; g.lineWidth = 3; g.strokeStyle = 'rgba(6,14,22,.85)';
            g.strokeText(tag, ix + 8, iy + 12); g.fillStyle = '#ffd9a6'; g.fillText(tag, ix + 8, iy + 12);
          }
        }
        // NAVAIDs in reach: VOR hexagon / NDB dashed circle + ident (chart conventions)
        g.textBaseline = 'middle'; g.textAlign = 'left';
        for (const nv of cache.navaids) {
          const x = sx(nv.x, nv.z), y = sy(nv.x, nv.z);
          if (x < -12 || y < -12 || x > W + 12 || y > H + 12) continue;
          g.strokeStyle = '#7dd3fc'; g.fillStyle = 'rgba(125,211,252,.15)'; g.lineWidth = 1.3;
          g.beginPath();
          if (nv.vor) { for (let i = 0; i < 6; i++) { const va = (i / 6) * Math.PI * 2, vx = x + Math.cos(va) * 5.5, vy = y + Math.sin(va) * 5.5; if (i) g.lineTo(vx, vy); else g.moveTo(vx, vy); } g.closePath(); }
          else { g.setLineDash(DASH_NDB); g.arc(x, y, 4.5, 0, Math.PI * 2); }
          g.fill(); g.stroke(); g.setLineDash(NO_DASH);
          g.font = '600 8px ui-sans-serif, system-ui';
          const lw = g.measureText(nv.ident).width;
          if (lblFit(x + 6, y - 10, x + 9 + lw, y + 2)) {
            lblPush(x + 6, y - 10, x + 9 + lw, y + 2);
            g.lineWidth = 2.6; g.strokeStyle = 'rgba(6,14,22,.85)'; g.strokeText(nv.ident, x + 7, y - 5);
            g.fillStyle = '#a8d4ec'; g.fillText(nv.ident, x + 7, y - 5);
          }
        }
        // context airports in reach: badge + ICAO (muted, collision-culled)
        for (const ca of cache.ctxAp) {
          const x = sx(ca.x, ca.z), y = sy(ca.x, ca.z);
          if (x < -12 || y < -12 || x > W + 12 || y > H + 12) continue;
          const rad = ca.size === 0 ? 3.4 : ca.size === 1 ? 2.8 : 2.2;
          g.fillStyle = '#cfe3f2'; g.strokeStyle = '#06121c'; g.lineWidth = 1.2;
          g.beginPath(); g.arc(x, y, rad, 0, 7); g.fill(); g.stroke();
          if (ca.size === 0 || S.range <= 100000) {
            g.font = '700 9px ui-sans-serif, system-ui';
            const lw = g.measureText(ca.icao).width;
            if (lblFit(x + 5, y - 10, x + 8 + lw, y + 2)) {
              lblPush(x + 5, y - 10, x + 8 + lw, y + 2);
              g.lineWidth = 2.6; g.strokeStyle = 'rgba(6,14,22,.85)'; g.strokeText(ca.icao, x + 6, y - 5);
              g.fillStyle = '#b9c9d6'; g.fillText(ca.icao, x + 6, y - 5);
            }
          }
        }
        // flight-plan waypoints: symbol per leg type (matches MapPanel) + name label
        for (const wp of cache.wps) {
          const x = sx(wp.p[0], wp.p[1]), y = sy(wp.p[0], wp.p[1]);
          if (x < -16 || y < -16 || x > W + 16 || y > H + 16) continue;
          g.lineWidth = 1.4; g.strokeStyle = '#06121c';
          if (wp.type === 'takeoff' || wp.type === 'touchdown') {
            g.fillStyle = wp.type === 'takeoff' ? '#3ddc84' : '#ffb02e';
            g.beginPath(); g.arc(x, y, wp.active ? 5.5 : 4.5, 0, 7); g.fill(); g.stroke();
          } else if (wp.type === 'tod') {
            g.fillStyle = '#ff007f'; g.strokeStyle = '#ffffff';
            g.beginPath(); g.arc(x, y, 4.5, 0, 7); g.fill(); g.stroke();
          } else if (wp.type === 'iaf' || wp.type === 'faf') {
            g.fillStyle = '#ffd27a';
            g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x + 5, y); g.lineTo(x, y + 5); g.lineTo(x - 5, y); g.closePath(); g.fill(); g.stroke();
          } else {
            g.fillStyle = wp.active ? '#e7a0eb' : '#e2e8f0';
            g.beginPath(); g.arc(x, y, wp.active ? 4 : 2.4, 0, 7); g.fill(); g.stroke();
          }
          if (wp.active) { g.strokeStyle = '#e7a0eb'; g.beginPath(); g.arc(x, y, 8.5, 0, 7); g.stroke(); }
          g.font = wp.active ? '800 10px ui-sans-serif, system-ui' : '600 9px ui-sans-serif, system-ui';
          g.textAlign = 'left'; g.textBaseline = 'middle';
          const lw = g.measureText(wp.name).width;
          if (lblFit(x + 6, y - 10, x + 10 + lw, y + 2)) {
            lblPush(x + 6, y - 10, x + 10 + lw, y + 2);
            g.lineWidth = 3; g.strokeStyle = 'rgba(6,14,22,.85)'; g.strokeText(wp.name, x + 8, y - 5);
            g.fillStyle = wp.active ? '#e7a0eb' : '#d7e1ea'; g.fillText(wp.name, x + 8, y - 5);
          }
        }
        // active leg: aircraft → active fix, solid magenta, annotated with bearing/distance like an FMS
        const aw = cache.wps[Math.min(cache.awIdx, cache.wps.length - 1)];
        if (aw) {
          const dx = aw.p[0] - px, dz = aw.p[1] - pz, dm = Math.hypot(dx, dz);
          if (dm * k > 14) {
            g.lineCap = 'round';
            g.strokeStyle = '#0a0f14'; g.lineWidth = 4; line2(px, pz, aw.p[0], aw.p[1]); g.stroke();
            g.strokeStyle = '#e7a0eb'; g.lineWidth = 2.2; line2(px, pz, aw.p[0], aw.p[1]); g.stroke();
            if (dm * k > 90) {
              const brg = (Math.atan2(dx, -dz) * R2D + 360) % 360, txt = `${Math.round(brg)}° ${(dm / M_PER_NM).toFixed(1)} NM`;
              const mx = sx(px + dx * 0.45, pz + dz * 0.45), my = sy(px + dx * 0.45, pz + dz * 0.45);
              g.font = '700 9px ui-sans-serif, system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
              g.lineWidth = 3; g.strokeStyle = 'rgba(6,14,22,.85)'; g.strokeText(txt, mx, my - 7);
              g.fillStyle = '#ffd7f8'; g.fillText(txt, mx, my - 7);
            }
          }
        }
      }
      // destination chevron pinned to the rim when the field is outside the window (any phase)
      {
        const tx = sx(cache.toP[0], cache.toP[1]), ty = sy(cache.toP[0], cache.toP[1]);
        if (tx < 10 || ty < 10 || tx > W - 10 || ty > H - 10) {
          const ang = Math.atan2(ty - cy, tx - cx), rad = R - 18, ax = cx + Math.cos(ang) * rad, ay = cy + Math.sin(ang) * rad;
          g.save(); g.translate(ax, ay); g.rotate(ang);
          g.fillStyle = '#ffb02e'; g.strokeStyle = '#06121c'; g.lineWidth = 1.6;
          g.beginPath(); g.moveTo(8, 0); g.lineTo(-5, -6); g.lineTo(-5, 6); g.closePath(); g.fill(); g.stroke();
          g.restore();
          const txt = `${game.cfg.to.iata || game.cfg.to.icao} ${Math.round(Math.hypot(cache.toP[0] - px, cache.toP[1] - pz) / M_PER_NM)} NM`;
          g.font = '700 9px ui-sans-serif, system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.lineWidth = 3; g.strokeStyle = 'rgba(6,14,22,.85)'; g.strokeText(txt, ax, ay + 12);
          g.fillStyle = '#ffd9a0'; g.fillText(txt, ax, ay + 12);
        }
      }
      // aircraft: real-scale footprint when large enough, symbol otherwise
      const ang = S.north ? h : 0, spec = game.spec, span = spec.wingspan * k, ln = spec.length * k;
      g.save(); g.translate(cx, cy); g.rotate(ang);
      if (span > 12) { g.strokeStyle = '#ffd24a'; g.lineWidth = 1; g.strokeRect(-span / 2, -ln / 2, span, ln); }
      g.fillStyle = '#fff'; g.strokeStyle = '#06121c'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(0, -9); g.lineTo(6.5, 7); g.lineTo(0, 3.5); g.lineTo(-6.5, 7); g.closePath(); g.fill(); g.stroke(); g.restore();
      // one-minute track vector + heading/track bugs riding the rose (airborne)
      if (!ground) {
        const tl = Math.min(W * 0.42, Math.max(16, fm.gs * 60 * k)), ta = fm.track * D2R - up, tsn = Math.sin(ta), tco = Math.cos(ta);
        g.strokeStyle = '#35e0ff'; g.lineWidth = 1.6; g.setLineDash(DASH_TRACK);
        g.beginPath(); g.moveTo(cx + tsn * 12, cy - tco * 12); g.lineTo(cx + tsn * (12 + tl), cy - tco * (12 + tl)); g.stroke(); g.setLineDash(NO_DASH);
        g.save(); g.translate(cx, cy); g.rotate(fm.heading * D2R - up);
        g.fillStyle = '#f2f6f9';
        g.beginPath(); g.moveTo(0, -(R - 3)); g.lineTo(-3.2, -(R - 11)); g.lineTo(3.2, -(R - 11)); g.closePath(); g.fill();
        g.restore();
        g.save(); g.translate(cx, cy); g.rotate(fm.track * D2R - up);
        g.strokeStyle = '#35e0ff'; g.lineWidth = 1.6;
        g.beginPath(); g.moveTo(0, -(R - 3)); g.lineTo(-3.2, -(R - 11)); g.lineTo(3.2, -(R - 11)); g.closePath(); g.stroke();
        g.restore();
        // AP heading bug (magnetic, like the HDG window it is set from) riding the same rose
        if (game.ap.on) {
          const ab = wrap360(game.ap.hdg + game.magv) * D2R - up;
          g.save(); g.translate(cx + Math.sin(ab) * (R - 1), cy - Math.cos(ab) * (R - 1)); g.rotate(ab);
          g.fillStyle = '#4cc3ff';
          g.beginPath(); g.moveTo(0, -7); g.lineTo(-5.5, 2); g.lineTo(5.5, 2); g.closePath(); g.fill();
          g.restore();
        }
        // 1/2/3-minute run markers along the predicted track
        for (let m = 1; m <= 3; m++) {
          const d = Math.max(fm.gs, 5) * 60 * m, mx = px + Math.sin(fm.track * D2R) * d, mz = pz - Math.cos(fm.track * D2R) * d;
          const gx = sx(mx, mz), gy = sy(mx, mz);
          if (Math.hypot(gx - cx, gy - cy) > R * 0.92) break;
          g.fillStyle = '#35e0ff'; g.beginPath(); g.arc(gx, gy, 1.8, 0, 7); g.fill();
        }
      }
      // north arrow (airport diagram keeps its own orientation cue; en-route the rose carries the N)
      if (ground) {
        g.save(); g.translate(W - 16, 18); g.rotate(S.north ? 0 : -h); g.fillStyle = '#ff6a5a'; g.beginPath(); g.moveTo(0, -8); g.lineTo(4.5, 4); g.lineTo(-4.5, 4); g.fill(); g.fillStyle = '#fff'; g.font = '700 8px ui-sans-serif'; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillText('N', 0, 14); g.restore();
      }
      // wind arrow: points downwind relative to the map rotation, labelled with speed (top-left)
      {
        const wd = S.hud.wind;
        g.save(); g.translate(20, 26);
        g.fillStyle = 'rgba(6,18,28,.6)'; g.beginPath(); g.arc(0, 0, 10, 0, 7); g.fill();
        g.rotate((wd.dir + 180) * D2R - up);
        g.strokeStyle = '#e8eef2'; g.lineWidth = 1.6; g.lineCap = 'round';
        g.beginPath(); g.moveTo(0, 6); g.lineTo(0, -5); g.moveTo(-3.4, -1.6); g.lineTo(0, -5.5); g.lineTo(3.4, -1.6); g.stroke();
        g.restore();
        g.font = '600 8px ui-sans-serif, system-ui'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
        g.fillStyle = '#c9d6e0'; g.fillText(wd.kt < 0.5 ? 'CALM' : `${Math.round(wd.kt)} KT`, 20, 42);
      }
      // sim weather package: effective-visibility ring (world.wx.visEffM, m) + thunderstorm badge.
      // The ring shows how far the pilot can actually see right now (precipitation-degraded), the
      // badge blinks with the live bolt (lightning.light.intensity — onStrike itself stays owned
      // by the sim's thunder audio wiring, game.ts:420, and is never re-bound from the UI).
      {
        const wx = game.world.wx;
        let wyy = 54; // stacked row cursor, no allocation
        if (wx.visEffM < 25000) {
          const vtxt = `VIS ${(wx.visEffM / 1000).toFixed(wx.visEffM < 10000 ? 1 : 0)} km`, vr = wx.visEffM * k;
          if (vr < R - 8 && vr > 6) {
            g.strokeStyle = 'rgba(255,255,255,.30)'; g.lineWidth = 1.2; g.setLineDash(DASH_VIS);
            g.beginPath(); g.arc(cx, cy, vr, 0, 7); g.stroke(); g.setLineDash(NO_DASH);
            g.fillStyle = '#c9d6e0'; g.font = '600 8px ui-sans-serif, system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText(vtxt, cx + vr * 0.707, cy - vr * 0.707);
          }
          g.font = '600 8px ui-sans-serif, system-ui'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
          g.fillStyle = '#c9d6e0'; g.fillText(vtxt, 8, wyy); wyy += 12;
        }
        if (wx.thunder) {
          const flash = game.world.lightning.light.intensity > 0;
          g.strokeStyle = flash ? '#ffe27a' : '#8d7f4f'; g.lineWidth = 1.6; g.lineCap = 'round'; g.lineJoin = 'round';
          g.beginPath(); g.moveTo(16, wyy - 8); g.lineTo(20, wyy - 4); g.lineTo(17, wyy - 4); g.lineTo(21, wyy); g.stroke();
          g.font = '700 8px ui-sans-serif, system-ui'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
          g.fillStyle = flash ? '#ffe27a' : '#b9a14f'; g.fillText(flash ? 'STRIKE' : 'TS', 24, wyy);
        }
      }
      // scale bar (NM once the chart is past airport-diagram scale, matching fmtRange)
      const bar = SCALE_STEPS.find((n) => n * k >= 36) ?? 200000;
      g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(8, H - 10); g.lineTo(8 + bar * k, H - 10); g.stroke();
      g.font = '600 9px ui-sans-serif'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      g.fillText(bar >= 3000 ? (bar / M_PER_NM >= 10 ? `${Math.round(bar / M_PER_NM)} NM` : `${(bar / M_PER_NM).toFixed(1)} NM`) : bar >= 1000 ? `${bar / 1000} km` : `${bar} m`, 8, H - 15);
      g.restore();
      const lab = `${S.auto ? 'AUTO' : 'MAN'} · ${fmtRange(S.range)}`;
      if (lab !== lastLabel) { lastLabel = lab; setLabel(lab); }
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [game]);

  const onGround = hud.onGround, via = game.taxiPlan?.via.length ? ` via ${game.taxiPlan.via.join(' ')}` : '';
  const legNo = hud.flightPlan.length ? `${Math.min(hud.activeWpIdx + 1, hud.flightPlan.length)}/${hud.flightPlan.length}` : '';
  const foot = onGround && game.depStageActive ? `TAXI${via} → RWY ${hud.depRwy || game.depRwy}` : `${legNo ? `${legNo} ` : ''}${hud.activeWp?.name ?? hud.destId}`;
  const zoom = (d: number) => { setAuto(false); setIdx((i) => Math.max(0, Math.min(RANGES.length - 1, (auto ? RANGES.findIndex((r) => r >= st.current.range * 0.95) : i) + d))); };
  return <section className="flight-mini-map flight-airport-map" aria-label="Airport and runway navigation display" data-flight-ui>
    <header><span title="Aircraft heading · magnetic">HDG <b>{String(Math.round(hud.hdg)).padStart(3, '0')}</b></span><span className="flight-amap-range">{label}</span>
      <span className="flight-amap-btns">
        <button onClick={() => zoom(-1)} aria-label="Zoom in" title="Zoom in">+</button><button onClick={() => zoom(1)} aria-label="Zoom out" title="Zoom out">−</button>
        <button onClick={() => setAuto(true)} data-on={auto} title="Automatic range for the phase of flight">A</button>
        <button onClick={() => setNorth((n) => !n)} data-on={north} title={north ? 'North up' : 'Heading up'}>{north ? 'N' : 'H'}</button></span></header>
    <div className="flight-mini-chart" ref={box}><canvas ref={canvas} aria-label="Airport moving map" /></div>
    <footer><span title={foot}>{foot}</span><b>{onGround ? `${Math.round(hud.gsKt)} KT` : `${(hud.activeWp?.distNm ?? hud.distNm).toFixed(0)} NM`}</b></footer>
  </section>;
}
