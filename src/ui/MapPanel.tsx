import { useEffect, useRef, useState, useCallback } from 'react';
import { CanvasMap } from './CanvasMap';
import { AIRPORTS, Airport } from '../data/airports';
import { TILE_STYLES, styleById } from '../sim/tiles';
import { MapLayers, loadMapLayers, saveMapLayers } from './mapLayers';
import { greatCircle, haversine, destination, D2R, M_PER_NM } from '../sim/geo';
import type { Game } from '../sim/game';

type NavMode = 'explore' | 'route' | 'north' | 'track' | 'free';
interface Props {
  mode: 'planner' | 'flight'; from: Airport | null; to: Airport | null; picking?: 'from' | 'to'; onPick?: (a: Airport) => void;
  styleId: string; onStyle: (id: string) => void; game?: Game | null; compact?: boolean; onExpand?: () => void; className?: string; routeKey?: string;
  rangeKm?: number; onSetAirport?: (a: Airport, role: 'from' | 'to') => void;
}

const COL = { from: '#3ddc84', to: '#ffb02e', route: '#ff4fd8', dot: '#7fd0ff', trail: '#35e0ff' };

export function MapPanel({ mode, from, to, picking, onPick, styleId, onStyle, game, compact, onExpand, className, routeKey, rangeKm, onSetAirport }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null), wrapRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<CanvasMap | null>(null);
  const hit = useRef<{ a: Airport; x: number; y: number }[]>([]);
  const props = useRef({ from, to, picking, onPick, mode, game, compact, rangeKm, onSetAirport });
  props.current = { from, to, picking, onPick, mode, game, compact, rangeKm, onSetAirport };
  const [nav, setNav] = useState<NavMode>(mode === 'flight' ? (compact ? 'track' : 'free') : 'route');
  const navRef = useRef(nav); navRef.current = nav;
  const [tip, setTip] = useState<{ x: number; y: number; a: Airport } | null>(null);
  const [selectedAirport, setSelectedAirport] = useState<Airport | null>(null);
  const [layers, setLayers] = useState<MapLayers>(loadMapLayers);
  const layersRef = useRef(layers); layersRef.current = layers;
  const [layersOpen, setLayersOpen] = useState(false);

  const nearestAt = useCallback((x: number, y: number, r = 14) => {
    let best: Airport | null = null, bd = r * r;
    for (const h of hit.current) { const d = (h.x - x) ** 2 + (h.y - y) ** 2; if (d < bd) { bd = d; best = h.a; } }
    return best;
  }, []);

  useEffect(() => {
    const m = new CanvasMap(canvasRef.current!); mapRef.current = m;
    m.showScale = !props.current.compact;
    m.showRoads = layersRef.current.roads;
    m.showLabels = layersRef.current.labels;
    m.showHillshade = layersRef.current.terrain;
    m.setStyle(styleId);
    m.overlay = (g, map) => {
      const p = props.current; const L = layersRef.current; const list: { a: Airport; x: number; y: number }[] = []; hit.current = list;
      const z = map.zoom; const maxSize = z < 5.6 ? 0 : z < 7.2 ? 1 : 2;
      const dark = styleById(map.styleId).dark;
      const gs = p.game && p.mode === 'flight' ? p.game.getMapState() : null;
      const labelRects: number[][] = [];
      // Runways: true-scale footprints when zoomed in, otherwise a small orientation
      // marker for the departure/arrival airports so the runway direction is never lost.
      // Runways, Taxiways & Aprons: true-scale footprints when zoomed in
      const drawRunways = (a: Airport, emphasized = false) => {
        if (!a.runways.length) return;
        const trueScale = z >= 9.4;
        if (!trueScale && !emphasized) return;
        const ppm = (256 * 2 ** z) / (40075016.7 * Math.cos(a.lat * D2R));
        const rws = trueScale ? a.runways : [a.runways.reduce((m, r) => (r.length > m.length ? r : m), a.runways[0])];
        g.lineCap = 'butt';
        for (const r of rws) {
          const [x1, y1] = map.project(r.leLat, r.leLon), [x2, y2] = map.project(r.heLat, r.heLon);
          if (Math.max(x1, x2) < -30 || Math.min(x1, x2) > map.W + 30 || Math.max(y1, y2) < -30 || Math.min(y1, y2) > map.H + 30) continue;
          if (!trueScale) {
            const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, ang = Math.atan2(y2 - y1, x2 - x1);
            const dx = Math.cos(ang) * 8, dy = Math.sin(ang) * 8;
            g.beginPath(); g.moveTo(cx - dx, cy - dy); g.lineTo(cx + dx, cy + dy);
            g.strokeStyle = dark ? 'rgba(4,10,16,.85)' : 'rgba(10,28,40,.5)'; g.lineWidth = 4.5; g.stroke();
            g.strokeStyle = p.to && a.id === p.to.id ? '#ffd27a' : dark ? '#dce9f2' : '#1f4a63'; g.lineWidth = 2; g.stroke();
            continue;
          }

          // Apron and Taxiway layout when zoomed in
          if (z >= 11.8) {
            const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
            const rdx = x2 - x1, rdy = y2 - y1;
            const rLen = Math.hypot(rdx, rdy);
            if (rLen > 5) {
              const rNormX = -rdy / rLen, rNormY = rdx / rLen;
              const taxiDistPx = 60 * ppm;
              const tx1 = x1 + rNormX * taxiDistPx, ty1 = y1 + rNormY * taxiDistPx;
              const tx2 = x2 + rNormX * taxiDistPx, ty2 = y2 + rNormY * taxiDistPx;
              const tw = Math.max(2, 20 * ppm);

              // Parallel taxiway
              g.beginPath(); g.moveTo(tx1, ty1); g.lineTo(tx2, ty2);
              g.strokeStyle = dark ? 'rgba(30, 41, 59, 0.85)' : 'rgba(51, 65, 85, 0.75)';
              g.lineWidth = tw; g.stroke();

              // Taxiway yellow centerline
              g.beginPath(); g.moveTo(tx1, ty1); g.lineTo(tx2, ty2);
              g.strokeStyle = '#facc15'; g.lineWidth = 1; g.stroke();

              // Connecting taxiways
              for (const f of [0.15, 0.5, 0.85]) {
                const mx = x1 + rdx * f, my = y1 + rdy * f;
                const mtx = tx1 + (tx2 - tx1) * f, mty = ty1 + (ty2 - ty1) * f;
                g.beginPath(); g.moveTo(mx, my); g.lineTo(mtx, mty);
                g.strokeStyle = dark ? 'rgba(30, 41, 59, 0.85)' : 'rgba(51, 65, 85, 0.75)';
                g.lineWidth = tw; g.stroke();
                g.beginPath(); g.moveTo(mx, my); g.lineTo(mtx, mty);
                g.strokeStyle = '#facc15'; g.lineWidth = 1; g.stroke();
              }

              // Main terminal apron slab
              const apronDistPx = (60 + 55) * ppm;
              const ax = cx + rNormX * apronDistPx, ay = cy + rNormY * apronDistPx;
              const aw = Math.min(rLen * 0.7, 380 * ppm), ad = 90 * ppm;
              g.save();
              g.translate(ax, ay);
              g.rotate(Math.atan2(rdy, rdx));
              g.fillStyle = dark ? 'rgba(51, 65, 85, 0.85)' : 'rgba(100, 116, 139, 0.75)';
              g.fillRect(-aw / 2, -ad / 2, aw, ad);
              g.strokeStyle = dark ? 'rgba(30, 41, 59, 0.9)' : 'rgba(71, 85, 105, 0.8)';
              g.lineWidth = 1; g.strokeRect(-aw / 2, -ad / 2, aw, ad);
              g.restore();
            }
          }

          const w = Math.min(18, Math.max(1, r.width * ppm));
          g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2);
          g.strokeStyle = dark ? 'rgba(4,10,16,.9)' : 'rgba(10,28,40,.55)'; g.lineWidth = w + 1.8; g.stroke();
          g.strokeStyle = p.to && a.id === p.to.id ? '#ffd27a' : dark ? '#c3cfd6' : '#7e8b93'; g.lineWidth = w; g.stroke();
        }
      };
      const compactMap = !!p.compact;
      if (L.airports && !(compactMap && z < 6.5)) for (const a of AIRPORTS) {
        if (a.size > maxSize) continue;
        const [x, y] = map.project(a.lat, a.lon);
        if (x < -10 || y < -10 || x > map.W + 10 || y > map.H + 10) continue;
        drawRunways(a);
        if (a === p.from || a === p.to) continue;
        list.push({ a, x, y });
        const r = a.size === 0 ? (z < 4 ? 2.4 : 4) : a.size === 1 ? 3 : 2.2;
        g.beginPath(); g.arc(x, y, r, 0, 7); g.fillStyle = a.size === 0 ? COL.dot : a.size === 1 ? '#bfe9ff' : '#d6dde3'; g.globalAlpha = 0.95; g.fill();
        g.lineWidth = 1.2; g.strokeStyle = dark ? '#06121c' : '#0b3a57'; g.stroke(); g.globalAlpha = 1;
        const wantLabel = !compactMap && ((a.size === 0 && z >= 5.2) || (a.size === 1 && z >= 7.4) || z >= 9);
        if (wantLabel) {
          const txt = a.iata || a.icao; const w = txt.length * 6.8 + 4; const rect = [x + 6, y - 7, x + 6 + w, y + 7];
          if (!labelRects.some((q) => rect[0] < q[2] && rect[2] > q[0] && rect[1] < q[3] && rect[3] > q[1])) {
            labelRects.push(rect); g.font = '600 11px ui-sans-serif, system-ui'; g.textBaseline = 'middle'; g.lineWidth = 3; g.strokeStyle = dark ? 'rgba(0,0,0,.85)' : 'rgba(255,255,255,.9)'; g.strokeText(txt, x + 7, y); g.fillStyle = dark ? '#e6f3ff' : '#0d2b3f'; g.fillText(txt, x + 7, y);
          }
        }
      }
      // The navigation map is deliberately flat 2D: raster chart, runways, route and traffic only.
      // Extruding building footprints on every redraw is what made opening it feel heavy.
      // route / navigation: multi-waypoint flight plan or great circle
      if (L.route && p.from && p.to && p.from !== p.to) {
        const fp = gs?.flightPlan;
        if (gs && fp && fp.length > 0) {
          const pts = fp.map((wp) => map.project(wp.lat, wp.lon));
          g.save(); g.lineJoin = 'round'; g.lineCap = 'round';
          // Outer glow/shadow
          g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
          g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = compactMap ? 5 : 7; g.stroke();
          // Route dashed line
          g.setLineDash(compactMap ? [] : [10, 8]); g.strokeStyle = COL.route; g.lineWidth = compactMap ? 3 : 3.5; g.stroke();
          g.restore();

          // Waypoint symbols and labels
          if (!compactMap && z >= 4.8) {
            fp.forEach((wp, idx) => {
              const [wx, wy] = pts[idx];
              if (wx < -60 || wx > map.W + 60 || wy < -60 || wy > map.H + 60) return;
              const isActive = idx === gs.activeWpIdx;

              g.save();
              if (wp.type === 'tod') {
                g.beginPath(); g.arc(wx, wy, isActive ? 6 : 4.5, 0, Math.PI * 2);
                g.fillStyle = '#ff007f'; g.fill();
                g.strokeStyle = '#ffffff'; g.lineWidth = 2; g.stroke();
              } else if (wp.type === 'faf' || wp.type === 'iaf') {
                g.fillStyle = '#ffd27a';
                g.beginPath();
                g.moveTo(wx, wy - 5); g.lineTo(wx + 5, wy); g.lineTo(wx, wy + 5); g.lineTo(wx - 5, wy);
                g.closePath(); g.fill();
                g.strokeStyle = '#06121c'; g.lineWidth = 1.5; g.stroke();
              } else if (wp.type === 'touchdown' || wp.type === 'takeoff') {
                g.fillStyle = wp.type === 'takeoff' ? COL.from : COL.to;
                g.beginPath(); g.arc(wx, wy, isActive ? 6 : 4.5, 0, Math.PI * 2); g.fill();
                g.strokeStyle = '#06121c'; g.lineWidth = 2; g.stroke();
              } else {
                g.fillStyle = isActive ? '#38bdf8' : '#e2e8f0';
                g.beginPath(); g.arc(wx, wy, isActive ? 5 : 3.5, 0, Math.PI * 2); g.fill();
                g.strokeStyle = '#06121c'; g.lineWidth = 1.5; g.stroke();
              }

              if (z >= 6.0 || isActive) {
                const label = wp.name;
                const altTxt = wp.altM > 0 ? `${Math.round(wp.altM / 0.3048 / 100) * 100}ft` : '';
                g.font = isActive ? '800 11px ui-sans-serif, system-ui' : '600 10px ui-sans-serif, system-ui';
                g.textAlign = 'left'; g.textBaseline = 'middle';
                g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)';
                g.strokeText(label, wx + 8, wy - 4);
                g.fillStyle = isActive ? '#38bdf8' : '#f8fafc';
                g.fillText(label, wx + 8, wy - 4);

                if (altTxt && z >= 6.8) {
                  g.font = '500 9px ui-sans-serif, system-ui';
                  g.strokeStyle = 'rgba(0,0,0,0.85)';
                  g.strokeText(altTxt, wx + 8, wy + 7);
                  g.fillStyle = '#94a3b8';
                  g.fillText(altTxt, wx + 8, wy + 7);
                }
              }
              g.restore();
            });
          }
        } else {
          // Standard great-circle / navPath fallback
          const end = gs?.appr ?? p.to;
          const nav = gs?.navPath ?? [];
          let ptsLL: [number, number][];
          if (gs && nav.length) {
            const anchors: [number, number][] = [[gs.lat, gs.lon], ...nav];
            ptsLL = anchors.slice(1).flatMap((to, i) => greatCircle(anchors[i][0], anchors[i][1], to[0], to[1], Math.max(16, Math.round(64 / Math.max(1, anchors.length - 1)))));
          } else {
            ptsLL = greatCircle(gs ? gs.lat : p.from.lat, gs ? gs.lon : p.from.lon, end.lat, end.lon, 48);
          }
          const pts = ptsLL.map(([la, lo]) => map.project(la, lo));
          g.save(); g.lineJoin = 'round'; g.lineCap = 'round';
          g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = compactMap ? 5 : 7; g.stroke();
          g.setLineDash(compactMap ? [] : [10, 8]); g.strokeStyle = COL.route; g.lineWidth = compactMap ? 3 : 3.5; g.stroke(); g.restore();
          if (gs && nav.length > 1 && !compactMap) {
            const gate = nav[0]; const [gx, gy] = map.project(gate[0], gate[1]);
            g.beginPath(); g.arc(gx, gy, 4, 0, 7); g.fillStyle = '#ffd27a'; g.fill(); g.strokeStyle = '#06121c'; g.lineWidth = 2; g.stroke();
            if (z >= 6.2) { g.font = '700 9px ui-sans-serif, system-ui'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.8)'; g.strokeText('FINAL', gx + 7, gy - 6); g.fillStyle = '#ffd9a6'; g.fillText('FINAL', gx + 7, gy - 6); }
          }
          if (!gs && !compactMap) {
            const mid = pts[Math.floor(pts.length / 2)]; const d = haversine(p.from.lat, p.from.lon, p.to.lat, p.to.lon);
            const txt = `${Math.round(d / 1000).toLocaleString()} km · ${Math.round(d / M_PER_NM).toLocaleString()} nm`;
            g.font = '700 12px ui-sans-serif, system-ui'; const w = g.measureText(txt).width + 16; g.fillStyle = 'rgba(8,14,22,.88)'; g.beginPath(); g.roundRect(mid[0] - w / 2, mid[1] - 26, w, 22, 11); g.fill(); g.fillStyle = '#ffd9f6'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, mid[0], mid[1] - 15); g.textAlign = 'left';
          }
        }
      }
      if (L.route && gs && gs.trail.length > 1) { g.beginPath(); gs.trail.forEach(([la, lo], i) => { const [x, y] = map.project(la, lo); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.strokeStyle = COL.trail; g.lineWidth = 3; g.globalAlpha = 0.85; g.stroke(); g.globalAlpha = 1; }
      const pin = (a: Airport | null, col: string, label: string) => {
        if (!a) return; const [x, y] = map.project(a.lat, a.lon); list.push({ a, x, y }); drawRunways(a, true);
        g.beginPath(); g.arc(x, y, compactMap ? 6 : 9, 0, 7); g.fillStyle = col; g.fill(); g.lineWidth = 3; g.strokeStyle = '#06121c'; g.stroke();
        g.beginPath(); g.arc(x, y, compactMap ? 11 : 16, 0, 7); g.lineWidth = 2; g.strokeStyle = col; g.globalAlpha = 0.6; g.stroke(); g.globalAlpha = 1;
        if (compactMap) return;
        g.font = '800 11px ui-sans-serif, system-ui'; const t = `${label} ${a.icao}`; const w = g.measureText(t).width + 14; g.fillStyle = col; g.beginPath(); g.roundRect(x + 14, y - 28, w, 20, 10); g.fill(); g.fillStyle = '#06121c'; g.textBaseline = 'middle'; g.fillText(t, x + 21, y - 18);
      };
      pin(p.from, COL.from, 'DEP');
      // Arrival marker sits on the threshold of the chosen runway in flight, not the mid-field ARP.
      const arrPin = p.to && gs?.appr ? { ...p.to, lat: gs.appr.lat, lon: gs.appr.lon } : p.to;
      pin(arrPin, COL.to, 'ARR');

      // Aircraft Range Ring in planner mode
      if (p.mode === 'planner' && p.from && p.rangeKm && !compactMap) {
        const [fx, fy] = map.project(p.from.lat, p.from.lon);
        const ppm = (256 * 2 ** z) / (40075016.7 * Math.cos(p.from.lat * D2R));
        const rPx = p.rangeKm * 1000 * ppm;
        if (rPx > 15 && rPx < map.W * 3.5) {
          g.save();
          g.beginPath();
          g.arc(fx, fy, rPx, 0, Math.PI * 2);
          g.strokeStyle = 'rgba(56, 189, 248, 0.45)';
          g.lineWidth = 1.5;
          g.setLineDash([6, 6]);
          g.stroke();
          g.fillStyle = 'rgba(56, 189, 248, 0.035)';
          g.fill();
          g.fillStyle = 'rgba(56, 189, 248, 0.85)';
          g.font = '700 10px ui-sans-serif, system-ui';
          g.fillText(`AIRCRAFT MAX RANGE (${Math.round(p.rangeKm).toLocaleString()} km)`, fx + rPx * 0.707 + 6, fy - rPx * 0.707);
          g.restore();
        }
      }
      if (gs) {
        const [x, y] = map.project(gs.lat, gs.lon);
        if (z > 5) { const pxPerNm = (256 * 2 ** z) / (360 * 60) * 1; void pxPerNm; const ppm = (256 * 2 ** z) / (40075016.7 * Math.cos(gs.lat * D2R)); g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1; for (const nm of [5, 10, 20, 40]) { const r = nm * M_PER_NM * ppm; if (r > 24 && r < map.W) { g.beginPath(); g.arc(x, y, r, 0, 7); g.stroke(); g.fillStyle = 'rgba(255,255,255,.7)'; g.font = '10px ui-sans-serif'; g.fillText(`${nm}nm`, x + r * 0.7 + 3, y - r * 0.7); } } }
        const face = gs.track;
        const ha = face * D2R + map.rot;
        g.beginPath(); g.moveTo(x + Math.sin(ha) * 16, y - Math.cos(ha) * 16); g.lineTo(x + Math.sin(ha) * 46, y - Math.cos(ha) * 46);
        g.strokeStyle = 'rgba(53,224,255,.85)'; g.lineWidth = 2; g.setLineDash([4, 3]); g.stroke(); g.setLineDash([]);
        if (!compactMap) { g.font = '700 10px ui-sans-serif, system-ui'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillStyle = '#d9f6ff'; g.fillText(`TRK ${String(Math.round(face) % 360).padStart(3, '0')}°`, x + 18, y - 18); }
        g.save(); g.translate(x, y); g.rotate(face * D2R + map.rot);
        g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 6; g.fillStyle = '#fff'; g.strokeStyle = '#0a1a28'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(0, -14); g.lineTo(3.5, -4); g.lineTo(14, 3); g.lineTo(14, 6.5); g.lineTo(3.2, 3.5); g.lineTo(2.6, 11); g.lineTo(6, 13.5); g.lineTo(6, 15.5); g.lineTo(0, 14); g.lineTo(-6, 15.5); g.lineTo(-6, 13.5); g.lineTo(-2.6, 11); g.lineTo(-3.2, 3.5); g.lineTo(-14, 6.5); g.lineTo(-14, 3); g.lineTo(-3.5, -4); g.closePath(); g.fill(); g.stroke(); g.restore();
      }
      // Enhanced ILS Feather (Extended Centerline Cone with angle markings)
      if (L.route && gs && gs.appr && z >= 4.8) {
        const ap = gs.appr;
        const [tx, ty] = map.project(ap.lat, ap.lon);
        const [blat, blon] = destination(ap.lat, ap.lon, ap.hdg + 180, 28000);
        const [bx, by] = map.project(blat, blon);
        
        // Localizer coverage wedge (+- 4.5 deg)
        const [coneL_lat, coneL_lon] = destination(ap.lat, ap.lon, ap.hdg + 180 - 4.5, 26000);
        const [coneR_lat, coneR_lon] = destination(ap.lat, ap.lon, ap.hdg + 180 + 4.5, 26000);
        const [cx1, cy1] = map.project(coneL_lat, coneL_lon);
        const [cx2, cy2] = map.project(coneR_lat, coneR_lon);

        g.save();
        // Feather cone
        g.beginPath();
        g.moveTo(tx, ty); g.lineTo(cx1, cy1); g.lineTo(cx2, cy2); g.closePath();
        g.fillStyle = 'rgba(255, 210, 122, 0.08)'; g.fill();
        g.strokeStyle = 'rgba(255, 210, 122, 0.28)'; g.lineWidth = 1; g.stroke();

        // Extended centerline
        g.setLineDash([8, 8]); g.lineWidth = 2; g.strokeStyle = 'rgba(255,210,122,.7)';
        g.beginPath(); g.moveTo(bx, by); g.lineTo(tx, ty); g.stroke();
        g.restore();

        // Distance tick marks along ILS (4nm, 8nm, 12nm)
        for (const nm of [4, 8, 12]) {
          const [tkLat, tkLon] = destination(ap.lat, ap.lon, ap.hdg + 180, nm * M_PER_NM);
          const [tkX, tkY] = map.project(tkLat, tkLon);
          const ang = ap.hdg * D2R + map.rot;
          const fx = Math.sin(ang), fy = -Math.cos(ang);
          g.beginPath(); g.moveTo(tkX - fy * 6, tkY + fx * 6); g.lineTo(tkX + fy * 6, tkY - fx * 6);
          g.strokeStyle = 'rgba(255, 210, 122, 0.85)'; g.lineWidth = 1.8; g.stroke();

          if (!compactMap && z >= 7.2) {
            g.font = '600 9px ui-sans-serif, system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillStyle = '#ffd27a'; g.fillText(`${nm}nm`, tkX + fx * 13, tkY + fy * 13);
          }
        }

        // Threshold bar & Runway label
        const ang = ap.hdg * D2R + map.rot, fx = Math.sin(ang), fy = -Math.cos(ang);
        g.beginPath(); g.moveTo(tx - fy * 10, ty + fx * 10); g.lineTo(tx + fy * 10, ty - fx * 10);
        g.strokeStyle = '#ffd27a'; g.lineWidth = 3; g.stroke();

        g.beginPath(); g.arc(tx, ty, 3.5, 0, Math.PI * 2); g.fillStyle = '#ffd27a'; g.fill();

        if (!compactMap && z >= 6.0) {
          const txt = `ILS RWY ${ap.ident} · ${String(Math.round(ap.hdg) % 360).padStart(3, '0')}°`;
          g.font = '700 11px ui-sans-serif, system-ui'; g.textAlign = 'left'; g.textBaseline = 'middle';
          g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.85)'; g.strokeText(txt, tx + 12, ty + 14);
          g.fillStyle = '#ffd9a6'; g.fillText(txt, tx + 12, ty + 14);
        }
      }
      // Destination pointer when it is outside the visible map area (threshold when an approach is active).
      const dest = p.to;
      if (L.route && dest) {
        const appr = gs?.appr ?? null;
        const target = appr ?? dest;
        const [dx, dy] = map.project(target.lat, target.lon);
        if (dx < 10 || dx > map.W - 10 || dy < 10 || dy > map.H - 10) {
          const cx = map.W / 2, cy = map.H / 2, ang = Math.atan2(dy - cy, dx - cx);
          const rad = Math.min(map.W, map.H) / 2 - 24;
          const ax = cx + Math.cos(ang) * rad, ay = cy + Math.sin(ang) * rad;
          g.save(); g.translate(ax, ay); g.rotate(ang);
          g.fillStyle = '#ffb02e'; g.strokeStyle = '#06121c'; g.lineWidth = 2;
          g.beginPath(); g.moveTo(13, 0); g.lineTo(-6, -7); g.lineTo(-6, 7); g.closePath(); g.fill(); g.stroke();
          g.restore();
          const fromLL = gs ? [gs.lat, gs.lon] : p.from ? [p.from.lat, p.from.lon] : [target.lat, target.lon];
          const km = Math.round(haversine(fromLL[0], fromLL[1], target.lat, target.lon) / 1000).toLocaleString();
          const txt = `${dest.iata || dest.icao}${appr ? ` RWY ${appr.ident}` : ''} · ${km} km`;
          const lx = Math.min(map.W - 40, Math.max(40, ax)), ly = Math.min(map.H - 12, Math.max(12, ay + 20));
          g.font = '700 11px ui-sans-serif, system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.75)'; g.strokeText(txt, lx, ly);
          g.fillStyle = '#ffd9a0'; g.fillText(txt, lx, ly);
        }
      }
      // north indicator when rotated
      if (Math.abs(map.rot) > 0.01 && !compactMap) { g.save(); g.translate(map.W - 34, 40); g.rotate(map.rot); g.fillStyle = '#ff5050'; g.beginPath(); g.moveTo(0, -14); g.lineTo(6, 4); g.lineTo(-6, 4); g.fill(); g.fillStyle = '#fff'; g.font = '700 11px ui-sans-serif'; g.textAlign = 'center'; g.fillText('N', 0, 17); g.restore(); }
    };
    m.onTap = (x, y) => {
      const a = nearestAt(x, y, 16);
      if (a) {
        setSelectedAirport(a);
        props.current.onPick?.(a);
      } else {
        setSelectedAirport(null);
      }
    };
    m.onHover = (x, y) => { const a = nearestAt(x, y, 10); setTip((t) => (a ? { x, y, a } : t ? null : t)); };
    m.onViewChange = () => { if (navRef.current !== 'free' && props.current.mode === 'flight') setNav('free'); else if (props.current.mode === 'planner' && navRef.current === 'route') setNav('explore'); };
    const ro = new ResizeObserver(() => m.resize()); ro.observe(wrapRef.current!); m.resize();
    if (mode === 'flight') {
      m.interactive = !compact;
      if (compact) m.setView(from?.lat ?? -2.2, from?.lon ?? 118, 9);
      else if (game && to) {
        const s = game.getMapState();
        const bounds: [number, number][] = [[s.lat, s.lon], ...s.navPath];
        if (!s.navPath.length) bounds.push([to.lat, to.lon]);
        m.fitBounds(bounds, 64);
      }
      else m.setView(from?.lat ?? -2.2, from?.lon ?? 118, 6);
    }
    else if (from && to) m.fitBounds([[from.lat, from.lon], [to.lat, to.lon]]);
    else if (from) m.setView(from.lat, from.lon, 6);
    else m.setView(-2.2, 118, 4.8); // featured region: Indonesia
    return () => { ro.disconnect(); m.dispose(); mapRef.current = null; };
    // eslint-disable-next-line
  }, []);

  useEffect(() => { mapRef.current?.setStyle(styleId); }, [styleId]);
  useEffect(() => {
    saveMapLayers(layers);
    const m = mapRef.current; if (!m) return;
    m.showRoads = layers.roads; m.showLabels = layers.labels; m.showHillshade = layers.terrain; m.invalidate();
  }, [layers]);
  useEffect(() => {
    const m = mapRef.current; if (!m) return; m.invalidate();
    if (mode === 'planner' && navRef.current === 'route' && from && to) m.fitBounds([[from.lat, from.lon], [to.lat, to.lon]]);
    else if (mode === 'planner' && from && !to && navRef.current === 'route') m.setView(from.lat, from.lon, Math.max(m.zoom, 7));
  }, [from, to, routeKey, mode]);
  useEffect(() => { mapRef.current?.invalidate(); }, [picking]);

  // flight-mode follow loop
  useEffect(() => {
    if (mode !== 'flight' || !game) return;
    const id = setInterval(() => {
      const m = mapRef.current; if (!m || !game.world) return; const s = game.getMapState();
      if (navRef.current !== 'free') { m.lat = s.lat; m.lon = s.lon; m.rot = navRef.current === 'track' ? -s.track * D2R : 0; }
      m.invalidate();
    }, 120);
    return () => clearInterval(id);
  }, [mode, game]);

  const setMode = (n: NavMode) => {
    setNav(n); const m = mapRef.current; if (!m) return;
    if (n === 'route' && from && to) { m.fitBounds([[from.lat, from.lon], [to.lat, to.lon]]); }
    if (n === 'north') m.rot = 0;
    if (n === 'track' && game) { const s = game.getMapState(); m.rot = -s.track * D2R; m.lat = s.lat; m.lon = s.lon; }
    m.invalidate();
  };
  const st = styleById(styleId);
  const btn = 'px-2.5 py-1.5 text-[11px] font-semibold rounded-md transition border backdrop-blur ';
  return (
    <div ref={wrapRef} className={`overflow-hidden bg-slate-900 ${className || "relative"}`}>
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing" />
      {!compact && (
        <>
          <div className="absolute top-3 left-3 z-30 flex flex-wrap items-center gap-1.5 max-w-[calc(100%-140px)] sm:max-w-none">
            <button onClick={() => setLayersOpen((o) => !o)} className={btn + 'bg-slate-900/85 text-white border-white/20 shadow-lg'}>▤ Layers{layers.roads ? ' · roads' : ''}</button>
            {mode === 'flight' && game && (
              <button
                onClick={() => game.cycleRunway()}
                className={btn + 'bg-slate-900/85 text-amber-300 border-amber-400/30 shadow-lg hover:border-amber-400'}
                title="Click to cycle approach runway"
              >
                ✈ ARR RWY: {game.apprKey || 'AUTO'}
              </button>
            )}
            {layersOpen && (
              <div className="mt-1.5 w-[268px] max-w-[calc(100vw-2rem)] max-h-[70vh] overflow-y-auto rounded-xl border border-white/20 bg-slate-950/95 backdrop-blur p-2.5 shadow-2xl">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] tracking-[0.2em] font-black text-cyan-300">BASE MAP</span>
                  <button onClick={() => setLayersOpen(false)} className="w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 text-xs" aria-label="Close layers">✕</button>
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-1">
                  {TILE_STYLES.filter((s) => s.id !== 'sat').map((s) => (
                    <button key={s.id} onClick={() => onStyle(s.id)} className={`px-2 py-1.5 rounded-md text-[11px] font-semibold border text-left ${s.id === styleId ? 'bg-cyan-400 text-slate-900 border-cyan-300' : 'bg-white/5 text-slate-200 border-white/10 hover:bg-white/10'}`}>{s.name}</button>
                  ))}
                </div>
                <div className="mt-2.5 text-[10px] tracking-[0.2em] font-black text-cyan-300">OVERLAYS</div>
                <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5">
                  {([['roads', 'Roads & rail'], ['labels', 'Place labels'], ['terrain', 'Terrain relief'], ['airports', 'Airports'], ['route', 'Route & trail']] as const).map(([key, label]) => (
                    <label key={key} className="flex items-center gap-1.5 py-0.5 text-[11px] text-slate-200 cursor-pointer">
                      <input type="checkbox" checked={layers[key]} onChange={(e) => setLayers((l) => ({ ...l, [key]: e.target.checked }))} className="accent-cyan-400" />
                      {label}
                    </label>
                  ))}
                </div>
                <div className="mt-2 flex gap-1">
                  <button onClick={() => setLayers({ roads: false, labels: false, airports: false, route: true, terrain: false })} className="flex-1 px-2 py-1 rounded-md text-[10px] font-bold bg-white/5 hover:bg-white/15 border border-white/10">Minimal</button>
                  <button onClick={() => setLayers({ roads: true, labels: true, airports: true, route: true, terrain: true })} className="flex-1 px-2 py-1 rounded-md text-[10px] font-bold bg-white/5 hover:bg-white/15 border border-white/10">All layers</button>
                </div>
                <div className="mt-1.5 text-[10px] leading-snug text-slate-500">Roads are the real street network. Live traffic isn't available in the sim; enable surface detail only when needed.</div>
              </div>
            )}
          </div>
          <div className="absolute bottom-8 left-3 flex gap-1.5">
            {(mode === 'planner' ? [['route', 'Route'], ['explore', 'Explore']] : [['north', 'North-up'], ['track', 'Track-up'], ['free', 'Free']]).map(([id, label]) => (
              <button key={id} onClick={() => setMode(id as NavMode)} className={btn + (nav === id ? 'bg-fuchsia-400 text-slate-900 border-fuchsia-300' : 'bg-slate-900/70 text-slate-100 border-white/15 hover:bg-slate-800')}>{label}</button>
            ))}
          </div>
          <div className="absolute top-3 right-3 flex flex-col gap-1.5">
            <button className={btn + 'bg-slate-900/80 text-white border-white/20 w-8 !text-base !py-1'} onClick={() => mapRef.current?.zoomBy(1)}>+</button>
            <button className={btn + 'bg-slate-900/80 text-white border-white/20 w-8 !text-base !py-1'} onClick={() => mapRef.current?.zoomBy(-1)}>−</button>
          </div>
        </>
      )}
      {compact && (
        <button onClick={onExpand} className="absolute inset-0 w-full h-full" aria-label="Expand map"><span className="absolute top-1 right-1 text-[10px] bg-black/60 text-white rounded px-1.5 py-0.5">M ⤢</span></button>
      )}
      {picking && !compact && <div className="absolute top-14 left-3 text-[11px] font-bold px-2.5 py-1 rounded-full" style={{ background: picking === 'from' ? COL.from : COL.to, color: '#06121c' }}>Click an airport to set {picking === 'from' ? 'DEPARTURE' : 'DESTINATION'}</div>}
      {tip && !compact && (
        <div className="pointer-events-none absolute z-10 px-2.5 py-1.5 rounded-lg bg-slate-950/90 text-white text-xs border border-white/15 shadow-xl" style={{ left: Math.min(tip.x + 14, (wrapRef.current?.clientWidth || 400) - 220), top: tip.y + 12 }}>
          <div className="font-bold">{tip.a.name} <span className="text-cyan-300">{tip.a.icao}{tip.a.iata ? ` / ${tip.a.iata}` : ''}</span></div>
          <div className="text-slate-300">{tip.a.city}, {tip.a.country} · {Math.round(tip.a.elev / 0.3048).toLocaleString()} ft · {tip.a.runways.length} rwy · longest {Math.max(...tip.a.runways.map((r) => r.length)).toLocaleString()} m</div>
        </div>
      )}
      {selectedAirport && !compact && mode === 'planner' && (
        <div className="absolute top-20 right-3 z-30 w-72 rounded-xl border border-white/20 bg-slate-950/95 backdrop-blur p-3.5 shadow-2xl text-white animate-[fadein_.2s_ease-out]">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-base font-black text-cyan-300">{selectedAirport.icao}</span>
                {selectedAirport.iata && <span className="text-xs px-1.5 py-0.5 rounded bg-white/10 font-bold text-slate-300">{selectedAirport.iata}</span>}
              </div>
              <div className="font-bold text-sm leading-snug mt-0.5">{selectedAirport.name}</div>
              <div className="text-xs text-slate-400">{selectedAirport.city}, {selectedAirport.country}</div>
            </div>
            <button onClick={() => setSelectedAirport(null)} className="w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 text-xs grid place-items-center">✕</button>
          </div>
          <div className="mt-2.5 pt-2 border-t border-white/10 grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-slate-400 block text-[10px] uppercase tracking-wider">Field Elevation</span>
              <span className="font-mono font-bold">{Math.round(selectedAirport.elev / 0.3048).toLocaleString()} ft</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[10px] uppercase tracking-wider">Runways</span>
              <span className="font-mono font-bold">{selectedAirport.runways.length} active</span>
            </div>
          </div>
          <div className="mt-2 max-h-24 overflow-y-auto space-y-1 pr-1 text-[11px] font-mono">
            {selectedAirport.runways.map((r, i) => (
              <div key={i} className="flex justify-between px-2 py-1 rounded bg-white/5 text-slate-300">
                <span>RWY {r.le}/{r.he}</span>
                <span>{Math.round(r.length)}m × {Math.round(r.width)}m</span>
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              onClick={() => {
                if (props.current.onSetAirport) props.current.onSetAirport(selectedAirport, 'from');
                else if (props.current.onPick) props.current.onPick(selectedAirport);
                setSelectedAirport(null);
              }}
              className="py-1.5 rounded-lg text-xs font-bold bg-emerald-500/80 hover:bg-emerald-400 text-slate-950 transition"
            >
              Set DEP
            </button>
            <button
              onClick={() => {
                if (props.current.onSetAirport) props.current.onSetAirport(selectedAirport, 'to');
                else if (props.current.onPick) props.current.onPick(selectedAirport);
                setSelectedAirport(null);
              }}
              className="py-1.5 rounded-lg text-xs font-bold bg-amber-500/80 hover:bg-amber-400 text-slate-950 transition"
            >
              Set ARR
            </button>
          </div>
        </div>
      )}
      {!compact && <div className="absolute bottom-1 right-2 text-[10px] text-white/80 bg-black/45 px-1.5 rounded">{st.attribution}</div>}
    </div>
  );
}
