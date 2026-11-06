// Dedicated airport / runway navigation display (top-left). It is independent of the full-screen chart ('M'): its own
// range, orientation and content – runways with true widths and idents, taxiways, aprons, hangars, terminals, stands,
// hold-short points, the taxi route to the departure runway, the final-approach course and the aircraft drawn at its
// real wingspan / length. Range auto-scales with the phase of flight (airport diagram on the ground, approach scale
// in the air) and can be overridden with + / −.
import { useEffect, useRef, useState } from 'react';
import type { Game, HudState } from '../sim/game';
import { getAirfield, airportsNear, type Airport } from '../data/airports';
import { synthGround, rectCorners, type XZ } from '../sim/airportGround';
import { D2R, M_PER_NM } from '../sim/geo';

const RANGES = [400, 800, 1500, 3000, 6000, 12000, 25000, 50000];
const fmtRange = (m: number) => m >= 3000 ? `${(m / M_PER_NM).toFixed(m >= 9000 ? 0 : 1)} NM` : `${m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m'}`;

interface Geo {
  ap: Airport; taxi: { pts: XZ[]; w: number; ref: string }[]; aprons: XZ[][]; hangars: { ring: XZ[]; name: string }[]; terminals: XZ[][];
  stands: XZ[]; holds: { p: XZ; ref: string }[];
}
interface Cache { proj: unknown; at: number; geos: Geo[]; appr: { x: number; z: number; hdg: number; ident: string } | null; route: XZ[]; wps: { p: XZ; name: string; active: boolean }[] }

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
  const st = useRef({ auto: true, idx: 3, north: false, range: 900 });
  st.current.auto = auto; st.current.idx = idx; st.current.north = north;
  const [label, setLabel] = useState('');

  useEffect(() => {
    const cv = canvas.current!, g = cv.getContext('2d')!; let raf = 0, cache: Cache | null = null, last = performance.now(), lastLabel = '', size = 0;
    const resize = () => { const r = box.current!.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1); size = Math.round(r.width); cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d); g.setTransform(d, 0, 0, d, 0, 0); };
    resize(); const ro = new ResizeObserver(resize); ro.observe(box.current!);
    const refresh = (): Cache | null => {
      const w = game.world; if (!w || !game.fm) return null;
      const ms = game.getMapState(), proj = w.proj;
      const near = airportsNear(ms.lat, ms.lon, 30000).filter((a) => a.runways.length).sort((a, b) => Math.hypot(a.lat - ms.lat, a.lon - ms.lon) - Math.hypot(b.lat - ms.lat, b.lon - ms.lon)).slice(0, 4);
      const set = new Map<string, Airport>(); for (const a of [game.cfg.from, ...near, ...(near.length ? [] : [game.cfg.to])]) set.set(a.id, a);
      return {
        proj, at: performance.now(), geos: [...set.values()].map((a) => buildGeo(a, proj)),
        appr: ms.appr ? { x: proj.x(ms.appr.lon), z: proj.z(ms.appr.lat), hdg: ms.appr.hdg, ident: ms.appr.ident } : null,
        route: ms.navPath.map(([la, lo]) => [proj.x(lo), proj.z(la)] as XZ),
        wps: ms.flightPlan.map((wp, i) => ({ p: [proj.x(wp.lon), proj.z(wp.lat)] as XZ, name: wp.name, active: i === ms.activeWpIdx })),
      };
    };
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!game.world || !game.fm || !size) return;
      if (!cache || cache.proj !== game.world.proj || now - cache.at > 1500) cache = refresh() ?? cache;
      if (!cache) return;
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const fm = game.fm, px = fm.pos.x, pz = fm.pos.z, h = fm.heading * D2R, S = st.current;
      // ---- range ----
      const ground = fm.wow, th = game.depTh, ex = cache.appr;
      const toDep = th ? Math.hypot(px - th.startX, pz - th.startZ) : 0;
      let target: number;
      if (S.auto) {
        if (ground) target = fm.gs > 30 ? 1500 : Math.min(2600, Math.max(800, toDep * 0.7 + 300));
        else { const d = ex ? Math.hypot(px - ex.x, pz - ex.z) : 1e9; target = d < 22000 ? Math.min(12000, Math.max(3000, d * 1.1)) : 12000; }
      } else target = RANGES[S.idx];
      S.range += (target - S.range) * (1 - Math.exp(-dt * 3));
      const W = size, H = size, k = (W * 0.5 - 6) / S.range;
      const cx = W / 2, cy = ground || S.north ? H / 2 : H * 0.6;
      const fx = S.north ? 0 : Math.sin(h), fz = S.north ? -1 : -Math.cos(h), rx = -fz, rz = fx;
      const sx = (x: number, z: number) => cx + ((x - px) * rx + (z - pz) * rz) * k, sy = (x: number, z: number) => cy - ((x - px) * fx + (z - pz) * fz) * k;
      const line = (pts: XZ[], close = false) => { g.beginPath(); pts.forEach(([x, z], i) => (i ? g.lineTo(sx(x, z), sy(x, z)) : g.moveTo(sx(x, z), sy(x, z)))); if (close) g.closePath(); };
      g.clearRect(0, 0, W, H); g.fillStyle = '#0f171d'; g.fillRect(0, 0, W, H);
      g.save(); g.beginPath(); g.rect(0, 0, W, H); g.clip();
      // range rings
      g.strokeStyle = '#ffffff14'; g.lineWidth = 1; for (let i = 1; i <= 2; i++) { g.beginPath(); g.arc(cx, cy, (W * 0.5 - 6) * i / 2, 0, 7); g.stroke(); }
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
        line([[r.ax, r.az], [r.bx, r.bz]]); g.stroke();
        g.strokeStyle = '#0f171d'; g.lineWidth = 1; g.setLineDash([6, 8]); line([[r.ax, r.az], [r.bx, r.bz]]); g.stroke(); g.setLineDash([]);
        g.font = '700 10px ui-sans-serif, system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff';
        const ux = r.bx - r.ax, uz = r.bz - r.az, L = Math.hypot(ux, uz) || 1, off = 12 / k;
        if (S.range <= 12000) { g.fillText(r.rw.le, sx(r.ax - ux / L * off, r.az - uz / L * off), sy(r.ax - ux / L * off, r.az - uz / L * off)); g.fillText(r.rw.he, sx(r.bx + ux / L * off, r.bz + uz / L * off), sy(r.bx + ux / L * off, r.bz + uz / L * off)); }
      }
      // taxi route to the departure runway (from the aircraft forward)
      if (ground && th && game.depStageActive) {
        let pts: XZ[] = game.taxiPlan ? game.taxiPlan.pts.map(([la, lo]) => [game.world!.proj.x(lo), game.world!.proj.z(la)] as XZ) : (game.spawn?.path ?? [[px, pz], [th.startX, th.startZ]]);
        let bi = 0, bd = 1e18; for (let i = 0; i + 1 < pts.length; i++) { const d = Math.hypot(pts[i + 1][0] - px, pts[i + 1][1] - pz); if (d < bd) { bd = d; bi = i; } }
        pts = [[px, pz], ...pts.slice(bi + 1)];
        g.strokeStyle = '#05080b'; g.lineWidth = 5; line(pts); g.stroke(); g.strokeStyle = '#ff5cf0'; g.lineWidth = 2.4; g.setLineDash([7, 5]); g.lineDashOffset = -now / 60; line(pts); g.stroke(); g.setLineDash([]);
        g.fillStyle = '#58d68d'; g.beginPath(); g.arc(sx(th.startX, th.startZ), sy(th.startX, th.startZ), 4.5, 0, 7); g.fill();
      }
      // approach course (destination runway) and route
      if (!ground) {
        if (cache.route.length > 1) { g.strokeStyle = '#e58ada'; g.lineWidth = 2; line(cache.route); g.stroke(); }
        if (ex) { const a = ex.hdg * D2R, len = 18520; g.strokeStyle = '#4cc3ff'; g.lineWidth = 1.6; g.setLineDash([8, 6]); line([[ex.x, ex.z], [ex.x - Math.sin(a) * len, ex.z + Math.cos(a) * len]]); g.stroke(); g.setLineDash([]);
          for (const nm of [5, 10]) { const q: XZ = [ex.x - Math.sin(a) * nm * M_PER_NM, ex.z + Math.cos(a) * nm * M_PER_NM]; g.fillStyle = '#4cc3ff'; g.beginPath(); g.arc(sx(q[0], q[1]), sy(q[0], q[1]), 2.4, 0, 7); g.fill(); g.font = '600 9px ui-sans-serif'; g.textAlign = 'left'; g.fillText(`${nm}`, sx(q[0], q[1]) + 5, sy(q[0], q[1]) - 4); } }
        for (const wp of cache.wps) if (wp.active) { g.fillStyle = '#e7a0eb'; g.beginPath(); const x = sx(wp.p[0], wp.p[1]), y = sy(wp.p[0], wp.p[1]); g.moveTo(x, y - 6); g.lineTo(x + 5, y); g.lineTo(x, y + 6); g.lineTo(x - 5, y); g.fill(); }
      }
      // aircraft: real-scale footprint when large enough, symbol otherwise
      const ang = S.north ? h : 0, spec = game.spec, span = spec.wingspan * k, len = spec.length * k;
      g.save(); g.translate(cx, cy); g.rotate(ang);
      if (span > 12) { g.strokeStyle = '#ffd24a'; g.lineWidth = 1; g.strokeRect(-span / 2, -len / 2, span, len); }
      g.fillStyle = '#fff'; g.strokeStyle = '#06121c'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(0, -9); g.lineTo(6.5, 7); g.lineTo(0, 3.5); g.lineTo(-6.5, 7); g.closePath(); g.fill(); g.stroke(); g.restore();
      // north arrow
      g.save(); g.translate(W - 16, 18); g.rotate(S.north ? 0 : -h); g.fillStyle = '#ff6a5a'; g.beginPath(); g.moveTo(0, -8); g.lineTo(4.5, 4); g.lineTo(-4.5, 4); g.fill(); g.fillStyle = '#fff'; g.font = '700 8px ui-sans-serif'; g.textAlign = 'center'; g.fillText('N', 0, 14); g.restore();
      // scale bar
      const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000], bar = nice.find((n) => n * k >= 36) ?? 50000;
      g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(8, H - 10); g.lineTo(8 + bar * k, H - 10); g.stroke(); g.font = '600 9px ui-sans-serif'; g.textAlign = 'left'; g.fillText(bar >= 1000 ? `${bar / 1000} km` : `${bar} m`, 8, H - 15);
      g.restore();
      const lab = `${S.auto ? 'AUTO' : 'MAN'} · ${fmtRange(S.range)}`;
      if (lab !== lastLabel) { lastLabel = lab; setLabel(lab); }
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [game]);

  const onGround = hud.onGround, via = game.taxiPlan?.via.length ? ` via ${game.taxiPlan.via.join(' ')}` : '';
  const foot = onGround && game.depStageActive ? `TAXI${via} → RWY ${hud.depRwy || game.depRwy}` : (hud.activeWp?.name ?? hud.destId);
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
