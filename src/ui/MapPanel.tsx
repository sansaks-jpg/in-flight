import { useEffect, useRef, useState, useCallback, type RefObject } from 'react';
import { CanvasMap } from './CanvasMap';
import { AIRPORTS, Airport, getAirfield, NAVAIDS } from '../data/airports';
import { trueToMag } from '../sim/magvar';
import { TILE_STYLES, styleById } from '../sim/tiles';
import { MapLayers, loadMapLayers, saveMapLayers } from './mapLayers';
import { greatCircle, haversine, destination, D2R, M_PER_NM } from '../sim/geo';
import type { Game } from '../sim/game';
import { FlightIcon } from './FlightIcon';

type NavMode = 'explore' | 'route' | 'north' | 'track' | 'free';
export interface NavigationMapView { lat: number; lon: number; zoom: number; rot: number; nav: NavMode; focusRequest?: number }
export interface PlannerMapControlRef {
  zoomBy: (dz: number) => void;
  fitRoute: () => void;
  globeView: () => void;
  focusAirport: (a: Airport, zoom?: number) => void;
  toggleLayers: () => void;
}
interface Props {
  mode: 'planner' | 'flight'; from: Airport | null; to: Airport | null; picking?: 'from' | 'to'; onPick?: (a: Airport) => void;
  styleId: string; onStyle: (id: string) => void; game?: Game | null; compact?: boolean; onExpand?: () => void; className?: string; routeKey?: string;
  rangeKm?: number; onSetAirport?: (a: Airport, role: 'from' | 'to') => void;
  onFlyNow?: (a: Airport) => void;
  onInspectAirport?: (a: Airport) => void;
  plannerControlRef?: RefObject<PlannerMapControlRef | null>;
  hideDefaultPlannerChrome?: boolean;
  viewStateRef?: RefObject<NavigationMapView | null>; layers?: MapLayers;
  navigation?: boolean; focusTarget?: { lat: number; lon: number; request: number; label?: string };
}

/** Airports sorted by latitude so a chart rebuild only touches the handful inside the cached area (not all 8,400). */
const AIRPORTS_BY_LAT: Airport[] = [...AIRPORTS].sort((a, b) => a.lat - b.lat);
const IN_VIEW: Airport[] = [];
function airportsInView(map: CanvasMap): Airport[] {
  const c = [map.unproject(0, 0), map.unproject(map.W, 0), map.unproject(0, map.H), map.unproject(map.W, map.H)];
  let minLa = 90, maxLa = -90, minLo = 360, maxLo = -360;
  for (const [la, lo] of c) { minLa = Math.min(minLa, la); maxLa = Math.max(maxLa, la); minLo = Math.min(minLo, lo); maxLo = Math.max(maxLo, lo); }
  const padLa = 0.3, wide = maxLo - minLo > 180; // antimeridian / planetary view: only latitude culling
  let lo = 0, hi = AIRPORTS_BY_LAT.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (AIRPORTS_BY_LAT[mid].lat < minLa - padLa) lo = mid + 1; else hi = mid; }
  IN_VIEW.length = 0;
  for (let i = lo; i < AIRPORTS_BY_LAT.length; i++) {
    const a = AIRPORTS_BY_LAT[i]; if (a.lat > maxLa + padLa) break;
    if (!wide && (a.lon < minLo - 0.3 || a.lon > maxLo + 0.3)) continue;
    IN_VIEW.push(a);
  }
  return IN_VIEW;
}
const RANGES_NM = [5, 10, 20, 40], TRACK_DASH = [4, 3], GUIDANCE_DASH = [3, 5], NO_DASH: number[] = [];
const COMPASS_TICKS = Array.from({ length: 36 }, (_, i) => i * 10);

const COL = { from: '#3ddc84', to: '#ffb02e', route: '#38bdf8', dot: '#ffffff', trail: '#35e0ff' };

export function MapPanel({
  mode,
  from,
  to,
  picking,
  onPick,
  styleId,
  onStyle,
  game,
  compact,
  onExpand,
  className,
  routeKey,
  rangeKm,
  onSetAirport,
  onFlyNow,
  onInspectAirport,
  plannerControlRef,
  hideDefaultPlannerChrome = false,
  navigation = false,
  focusTarget,
  viewStateRef,
  layers: controlledLayers,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null), wrapRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<CanvasMap | null>(null);
  const lastFocusRequest = useRef(viewStateRef?.current?.focusRequest);
  const hit = useRef<{ a: Airport; x: number; y: number }[]>([]);
  const props = useRef({
    from, to, picking, onPick, mode, game, compact, rangeKm, onSetAirport, onFlyNow, onInspectAirport, navigation, focusTarget,
  });
  props.current = {
    from, to, picking, onPick, mode, game, compact, rangeKm, onSetAirport, onFlyNow, onInspectAirport, navigation, focusTarget,
  };
  const [nav, setNav] = useState<NavMode>(viewStateRef?.current?.nav ?? (mode === 'flight' ? (compact || navigation ? 'track' : 'free') : 'route'));
  const navRef = useRef(nav); navRef.current = nav;
  const [tip, setTip] = useState<{ x: number; y: number; a: Airport } | null>(null);
  const [selectedAirport, setSelectedAirport] = useState<{ a: Airport; x: number; y: number } | null>(null);
  const [layers, setLayers] = useState<MapLayers>(loadMapLayers);
  const layersRef = useRef(controlledLayers ?? layers); layersRef.current = controlledLayers ?? layers;
  const [layersOpen, setLayersOpen] = useState(false);

  const nearestAt = useCallback((x: number, y: number, r = 16) => {
    let best: Airport | null = null, bd = r * r;
    for (const h of hit.current) {
      const point = mapRef.current?.project(h.a.lat, h.a.lon);
      if (!point) continue;
      const d = (point[0] - x) ** 2 + (point[1] - y) ** 2;
      if (d < bd) { bd = d; best = h.a; }
    }
    return best;
  }, []);

  useEffect(() => {
    const m = new CanvasMap(canvasRef.current!); mapRef.current = m;
    m.showScale = !props.current.compact;
    m.showGrid = !!props.current.navigation && !props.current.compact;
    m.scaleUnits = props.current.navigation ? 'nm' : 'metric';
    m.planetaryMode = props.current.mode === 'planner' && !props.current.compact;
    m.showRoads = layersRef.current.roads;
    m.showLabels = layersRef.current.labels;
    m.showHillshade = layersRef.current.terrain;
    m.setStyle(styleId);
    let flightState = mode === 'flight' && game?.world ? game.getMapState() : null;
    const ownshipPoint = new Float64Array(2), targetPoint = new Float64Array(2);
    let nextNavigationUpdate = 0, lastTrailLat = NaN, lastTrailLon = NaN;
    m.beforeFrame = (now) => {
      const currentGame = props.current.game;
      if (!currentGame || props.current.mode !== 'flight' || !currentGame.world) return false;
      const oldLat = flightState?.lat, oldLon = flightState?.lon, oldHeading = flightState?.hdg, oldTrack = flightState?.track;
      if (!flightState || now >= nextNavigationUpdate || flightState.flightPlan !== currentGame.flightPlan ||
          flightState.activeWpIdx !== currentGame.activeWpIdx || flightState.apprRwy !== currentGame.apprKey ||
          flightState.depRwy !== currentGame.depRwy) {
        const next = currentGame.getMapState(), trailEnd = next.trail[next.trail.length - 1];
        if (!flightState || next.flightPlan !== flightState.flightPlan || next.activeWpIdx !== flightState.activeWpIdx ||
            next.apprRwy !== flightState.apprRwy || next.depRwy !== flightState.depRwy ||
            next.appr?.ident !== flightState.appr?.ident || next.from !== flightState.from || next.to !== flightState.to ||
            (trailEnd && (trailEnd[0] !== lastTrailLat || trailEnd[1] !== lastTrailLon))) m.invalidate();
        if (trailEnd) { lastTrailLat = trailEnd[0]; lastTrailLon = trailEnd[1]; }
        flightState = next; nextNavigationUpdate = now + 250;
      }
      currentGame.readMapPose(flightState);
      if (navRef.current === 'north' || navRef.current === 'track') {
        m.lat = flightState.lat; m.lon = flightState.lon;
        m.rot = navRef.current === 'track' ? -flightState.track * D2R : 0;
      }
      return oldLat !== flightState.lat || oldLon !== flightState.lon || oldHeading !== flightState.hdg || oldTrack !== flightState.track;
    };
    m.backgroundOverlay = (g, map) => {
      const p = props.current; const L = layersRef.current; const list: { a: Airport; x: number; y: number }[] = []; hit.current = list;
      const z = map.zoom; const maxSize = z < 5.6 ? 0 : z < 7.2 ? 1 : 2;
      const dark = styleById(map.styleId).dark;
      const gs = flightState;
      const labelRects: number[][] = [];
      /** Surveyed ground layout (OSM): aprons, taxiways, hangars/terminals, stands and hold-short points. */
      const drawLayout = (a: Airport, ppm: number) => {
        if (z < 11.2) return;
        const L = getAirfield(a); if (!L) return;
        const ring = (pts: [number, number][]) => { pts.forEach(([la, lo], i) => { const [x, y] = map.project(la, lo); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); };
        g.lineJoin = 'round'; g.lineCap = 'round';
        g.fillStyle = dark ? 'rgba(148,163,184,.30)' : 'rgba(71,85,105,.28)';
        for (const o of L.aprons) { g.beginPath(); ring(o.ring); g.closePath(); g.fill(); }
        for (const t of L.taxiways) {
          g.beginPath(); ring(t.pts);
          g.strokeStyle = dark ? 'rgba(4,10,16,.85)' : 'rgba(10,28,40,.55)'; g.lineWidth = Math.min(9, Math.max(1.6, t.width * ppm)) + 1.6; g.stroke();
          g.strokeStyle = dark ? '#8493a6' : '#64748b'; g.lineWidth = Math.min(9, Math.max(1.6, t.width * ppm)); g.stroke();
        }
        g.fillStyle = dark ? 'rgba(226,232,240,.55)' : 'rgba(30,41,59,.55)';
        for (const o of L.hangars.concat(L.terminals)) { g.beginPath(); ring(o.ring); g.closePath(); g.fill(); }
        if (p.mode === 'planner' && z >= 12.2) {
          g.fillStyle = '#ffe08a'; g.strokeStyle = '#0f172a'; g.lineWidth = 1.2;
          g.font = '600 10px ui-sans-serif, system-ui'; g.textAlign = 'left'; g.textBaseline = 'middle';
          for (const st of L.stands) {
            const [x, y] = map.project(st.lat, st.lon); if (x < -8 || y < -8 || x > map.W + 8 || y > map.H + 8) continue;
            g.beginPath(); g.arc(x, y, st.gate ? 3.6 : 3, 0, Math.PI * 2); g.fill(); g.stroke();
            if (z >= 15 && st.ref) { g.lineWidth = 2.5; g.strokeStyle = 'rgba(0,0,0,.8)'; g.strokeText(st.ref, x + 6, y); g.fillStyle = '#ffe9a8'; g.fillText(st.ref, x + 6, y); g.fillStyle = '#ffe08a'; g.strokeStyle = '#0f172a'; g.lineWidth = 1.2; }
          }
          g.fillStyle = '#f59e0b';
          for (const hp of L.holds) { const [x, y] = map.project(hp.lat, hp.lon); g.fillRect(x - 2.5, y - 2.5, 5, 5); }
        }
      };
      const drawRunways = (a: Airport, emphasized = false) => {
        if (!a.runways.length) return;
        const trueScale = z >= 9.4;
        if (!trueScale && !emphasized) return;
        const ppm = (256 * 2 ** z) / (40075016.7 * Math.cos(a.lat * D2R));
        const rws = trueScale ? a.runways : [a.runways.reduce((m, r) => (r.length > m.length ? r : m), a.runways[0])];
        g.lineCap = 'butt';
        let layoutDone = false;
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

          if (!layoutDone) { layoutDone = true; drawLayout(a, ppm); }
          const w = Math.min(18, Math.max(1.5, r.width * ppm));
          g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2);
          g.strokeStyle = dark ? 'rgba(4,10,16,.92)' : 'rgba(10,28,40,.65)'; g.lineWidth = w + 2.2; g.stroke();
          g.strokeStyle = p.to && a.id === p.to.id ? '#ffd27a' : dark ? '#cbd5e1' : '#64748b'; g.lineWidth = w; g.stroke();

          // When zoomed into an airport in Planner mode (like MSFS Images 4 & 8), draw threshold dots & gate/ramp nodes
          if (p.mode === 'planner' && z >= 12.2) {
            g.fillStyle = '#ffffff';
            g.strokeStyle = '#0f172a';
            g.lineWidth = 1.5;
            g.beginPath(); g.arc(x1, y1, 4.5, 0, Math.PI * 2); g.fill(); g.stroke();
            g.beginPath(); g.arc(x2, y2, 4.5, 0, Math.PI * 2); g.fill(); g.stroke();
          }
        }
      };
      if (L.airports && z >= 8.4 && !p.compact) {
        g.font = '600 9px ui-sans-serif, system-ui'; g.textAlign = 'left'; g.textBaseline = 'middle';
        for (const n of NAVAIDS) {
          const [x, y] = map.project(n.lat, n.lon); if (x < -10 || y < -10 || x > map.W + 10 || y > map.H + 10) continue;
          const vor = n.type.startsWith('VOR') || n.type === 'TACAN';
          g.strokeStyle = dark ? '#7dd3fc' : '#0369a1'; g.fillStyle = dark ? 'rgba(125,211,252,.18)' : 'rgba(3,105,161,.15)'; g.lineWidth = 1.4;
          g.beginPath();
          if (vor) { for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; const px = x + Math.cos(a) * 6, py = y + Math.sin(a) * 6; if (i) g.lineTo(px, py); else g.moveTo(px, py); } g.closePath(); }
          else { g.setLineDash([2, 2]); g.arc(x, y, 5, 0, Math.PI * 2); }
          g.fill(); g.stroke(); g.setLineDash([]);
          if (z >= 9.6) { g.fillStyle = dark ? '#bae6fd' : '#075985'; g.fillText(n.ident, x + 8, y); }
        }
      }
      const compactMap = !!p.compact || (!!p.navigation && map.viewportW < 480);
      if (L.airports && !(compactMap && z < 6.5)) for (const a of airportsInView(map)) {
        if (a.size > maxSize) continue;
        const [x, y] = map.project(a.lat, a.lon);
        if (x < -10 || y < -10 || x > map.W + 10 || y > map.H + 10) continue;
        drawRunways(a);
        if (a === p.from || a === p.to) continue;
        list.push({ a, x, y });
        if (p.mode === 'planner') {
          // MSFS 2024 style circular airport badge with inner diamond & gold star for major hubs
          const rad = a.size === 0 ? (z < 4 ? 5.2 : 6.8) : a.size === 1 ? 5.0 : 3.6;
          g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2);
          g.fillStyle = '#ffffff'; g.fill();
          g.lineWidth = 1.4; g.strokeStyle = '#0f172a'; g.stroke();
          if (rad >= 4.8) {
            g.fillStyle = '#1e293b';
            g.beginPath();
            g.moveTo(x, y - rad * 0.48);
            g.lineTo(x + rad * 0.48, y);
            g.lineTo(x, y + rad * 0.48);
            g.lineTo(x - rad * 0.48, y);
            g.closePath();
            g.fill();
          }
          if (a.size === 0 && z >= 3.8) {
            const sx = x + rad * 0.75, sy = y + rad * 0.75;
            g.beginPath(); g.arc(sx, sy, 3.6, 0, Math.PI * 2);
            g.fillStyle = '#eab308'; g.fill();
            g.strokeStyle = '#0f172a'; g.lineWidth = 1; g.stroke();
          }
        } else {
          const r = a.size === 0 ? (z < 4 ? 2.4 : 4) : a.size === 1 ? 3 : 2.2;
          g.beginPath(); g.arc(x, y, r, 0, 7); g.fillStyle = a.size === 0 ? '#7fd0ff' : a.size === 1 ? '#bfe9ff' : '#d6dde3'; g.globalAlpha = 0.95; g.fill();
          g.lineWidth = 1.2; g.strokeStyle = dark ? '#06121c' : '#0b3a57'; g.stroke(); g.globalAlpha = 1;
        }
        const wantLabel = !compactMap && ((a.size === 0 && z >= 5.2) || (a.size === 1 && z >= 7.4) || z >= 9);
        if (wantLabel) {
          const txt = a.icao; const w = txt.length * 6.8 + 4; const rect = [x + 8, y - 7, x + 8 + w, y + 7];
          if (!labelRects.some((q) => rect[0] < q[2] && rect[2] > q[0] && rect[1] < q[3] && rect[3] > q[1])) {
            labelRects.push(rect); g.font = '700 10px ui-sans-serif, system-ui'; g.textBaseline = 'middle'; g.lineWidth = 3; g.strokeStyle = dark ? 'rgba(0,0,0,.85)' : 'rgba(255,255,255,.9)'; g.strokeText(txt, x + 9, y); g.fillStyle = dark ? '#f1f5f9' : '#0d2b3f'; g.fillText(txt, x + 9, y);
          }
        }
      }
      if (L.route && p.from && p.to && p.from !== p.to) {
        const fp = gs?.flightPlan;
        if (gs && fp && fp.length > 0) {
          const pts = fp.map((wp) => map.project(wp.lat, wp.lon));
          g.save(); g.lineJoin = 'round'; g.lineCap = 'round';
          g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
          g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = compactMap ? 5 : 7; g.stroke();
          g.setLineDash(compactMap ? [] : [10, 8]); g.strokeStyle = p.navigation ? 'rgba(186,170,205,.5)' : COL.route; g.lineWidth = compactMap ? 2 : 3.5; g.stroke();
          g.restore();

          if (p.navigation) {
            const active = fp[Math.min(gs.activeWpIdx, fp.length - 1)];
            const previous = fp[Math.max(0, gs.activeWpIdx - 1)];
            const [ax, ay] = map.project(previous.lat, previous.lon);
            const [bx, by] = map.project(active.lat, active.lon);
            g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by);
            g.strokeStyle = '#e7a0eb'; g.lineWidth = 3; g.stroke();
          }

          if (z >= 4.8) {
            fp.forEach((wp, idx) => {
              const [wx, wy] = pts[idx];
              if (wx < -60 || wx > map.W + 60 || wy < -60 || wy > map.H + 60) return;
              const isActive = idx === gs.activeWpIdx;
              if (compactMap && !isActive) return;

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
                g.fillStyle = isActive ? (p.navigation ? '#e7a0eb' : '#38bdf8') : '#e2e8f0';
                g.beginPath(); g.arc(wx, wy, isActive ? 5 : 3.5, 0, Math.PI * 2); g.fill();
                g.strokeStyle = '#06121c'; g.lineWidth = 1.5; g.stroke();
              }

              if (!p.compact && (z >= 6.0 || isActive)) {
                const label = wp.name;
                const altTxt = wp.altM > 0 ? `${Math.round(wp.altM / 0.3048 / 100) * 100}ft` : '';
                g.font = isActive ? '800 11px ui-sans-serif, system-ui' : '600 10px ui-sans-serif, system-ui';
                g.textAlign = 'left'; g.textBaseline = 'middle';
                g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)';
                g.strokeText(label, wx + 8, wy - 4);
                g.fillStyle = isActive ? (p.navigation ? '#e7a0eb' : '#38bdf8') : '#f8fafc';
                g.fillText(label, wx + 8, wy - 4);

                if (altTxt && z >= 6.8 && !compactMap) {
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
          g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = compactMap ? 5 : 6.5; g.stroke();
          g.setLineDash(compactMap ? [] : [10, 7]); g.strokeStyle = '#38bdf8'; g.lineWidth = compactMap ? 2.5 : 3; g.stroke(); g.restore();
          if (gs && nav.length > 1 && !compactMap) {
            const gate = nav[0]; const [gx, gy] = map.project(gate[0], gate[1]);
            g.beginPath(); g.arc(gx, gy, 4, 0, 7); g.fillStyle = '#ffd27a'; g.fill(); g.strokeStyle = '#06121c'; g.lineWidth = 2; g.stroke();
            if (z >= 6.2) { g.font = '700 9px ui-sans-serif, system-ui'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.8)'; g.strokeText('FINAL', gx + 7, gy - 6); g.fillStyle = '#ffd9a6'; g.fillText('FINAL', gx + 7, gy - 6); }
          }
          if (!gs && !compactMap) {
            const mid = pts[Math.floor(pts.length / 2)]; const d = haversine(p.from.lat, p.from.lon, p.to.lat, p.to.lon);
            const txt = `${Math.round(d / M_PER_NM).toLocaleString()} NM · ${Math.round(d / 1000).toLocaleString()} KM`;
            g.font = '700 11px ui-sans-serif, system-ui'; const w = g.measureText(txt).width + 16; g.fillStyle = 'rgba(13,20,30,.92)'; g.beginPath(); g.roundRect(mid[0] - w / 2, mid[1] - 26, w, 21, 3); g.fill(); g.strokeStyle = 'rgba(56,189,248,.45)'; g.lineWidth = 1; g.stroke(); g.fillStyle = '#e0f2fe'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, mid[0], mid[1] - 15.5); g.textAlign = 'left';
          }
        }
      }
      if (L.route && gs && gs.trail.length > 1) { g.beginPath(); gs.trail.forEach(([la, lo], i) => { const [x, y] = map.project(la, lo); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.strokeStyle = COL.trail; g.lineWidth = 3; g.globalAlpha = 0.85; g.stroke(); g.globalAlpha = 1; }
      const pin = (a: Airport | null, col: string, label: string) => {
        if (!a) return; const [x, y] = map.project(a.lat, a.lon); list.push({ a, x, y }); drawRunways(a, true);
        g.beginPath(); g.arc(x, y, compactMap ? 6 : 8.5, 0, 7); g.fillStyle = col; g.fill(); g.lineWidth = 2.5; g.strokeStyle = '#06121c'; g.stroke();
        g.beginPath(); g.arc(x, y, compactMap ? 11 : 15, 0, 7); g.lineWidth = 2; g.strokeStyle = col; g.globalAlpha = 0.65; g.stroke(); g.globalAlpha = 1;
        if (compactMap) { drawMapCompass(g, map); return; }
        g.font = '800 11px ui-sans-serif, system-ui'; const t = `${label} ${a.icao}`; const w = g.measureText(t).width + 14; g.fillStyle = col; g.beginPath(); g.roundRect(x + 13, y - 26, w, 19, 3); g.fill(); g.fillStyle = '#06121c'; g.textBaseline = 'middle'; g.fillText(t, x + 20, y - 16.5);
      };
      pin(p.from, COL.from, 'DEP');
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
          g.fillStyle = 'rgba(56, 189, 248, 0.03)';
          g.fill();
          g.fillStyle = 'rgba(125, 211, 252, 0.9)';
          g.font = '700 10px ui-sans-serif, system-ui';
          g.fillText(`MAX RANGE (${Math.round(p.rangeKm).toLocaleString()} KM)`, fx + rPx * 0.707 + 6, fy - rPx * 0.707);
          g.restore();
        }
      }
      // Enhanced ILS Feather
      if (L.route && gs && gs.appr && z >= 4.8) {
        const ap = gs.appr;
        const [tx, ty] = map.project(ap.lat, ap.lon);
        const [blat, blon] = destination(ap.lat, ap.lon, ap.hdg + 180, 28000);
        const [bx, by] = map.project(blat, blon);
        const [coneL_lat, coneL_lon] = destination(ap.lat, ap.lon, ap.hdg + 180 - 4.5, 26000);
        const [coneR_lat, coneR_lon] = destination(ap.lat, ap.lon, ap.hdg + 180 + 4.5, 26000);
        const [cx1, cy1] = map.project(coneL_lat, coneL_lon);
        const [cx2, cy2] = map.project(coneR_lat, coneR_lon);

        g.save();
        g.beginPath();
        g.moveTo(tx, ty); g.lineTo(cx1, cy1); g.lineTo(cx2, cy2); g.closePath();
        g.fillStyle = 'rgba(255, 210, 122, 0.08)'; g.fill();
        g.strokeStyle = 'rgba(255, 210, 122, 0.28)'; g.lineWidth = 1; g.stroke();
        g.setLineDash([8, 8]); g.lineWidth = 2; g.strokeStyle = 'rgba(255,210,122,.7)';
        g.beginPath(); g.moveTo(bx, by); g.lineTo(tx, ty); g.stroke();
        g.restore();

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

        const ang = ap.hdg * D2R + map.rot, fx = Math.sin(ang), fy = -Math.cos(ang);
        g.beginPath(); g.moveTo(tx - fy * 10, ty + fx * 10); g.lineTo(tx + fy * 10, ty - fx * 10);
        g.strokeStyle = '#ffd27a'; g.lineWidth = 3; g.stroke();
        g.beginPath(); g.arc(tx, ty, 3.5, 0, Math.PI * 2); g.fillStyle = '#ffd27a'; g.fill();

        if (!compactMap && z >= 6.0) {
          const txt = `${ap.ils ? 'ILS' : 'RWY'} ${ap.ident} · ${String(Math.round(trueToMag(ap.hdg, ap.lat, ap.lon)) % 360 || 360).padStart(3, '0')}°M`;
          g.font = '700 11px ui-sans-serif, system-ui'; g.textAlign = 'left'; g.textBaseline = 'middle';
          g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.85)'; g.strokeText(txt, tx + 12, ty + 14);
          g.fillStyle = '#ffd9a6'; g.fillText(txt, tx + 12, ty + 14);
        }
      }
      if (p.navigation && p.focusTarget) {
        const [x, y] = map.project(p.focusTarget.lat, p.focusTarget.lon);
        if (x > 0 && y > 0 && x < map.W && y < map.H) {
          g.save(); g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2);
          g.strokeStyle = '#d7e7f2'; g.lineWidth = 1.5; g.stroke();
          g.beginPath(); g.moveTo(x - 13, y); g.lineTo(x - 6, y); g.moveTo(x + 6, y); g.lineTo(x + 13, y);
          g.moveTo(x, y - 13); g.lineTo(x, y - 6); g.moveTo(x, y + 6); g.lineTo(x, y + 13); g.stroke();
          if (p.focusTarget.label) {
            g.font = '600 10px ui-sans-serif, system-ui'; g.textAlign = 'left'; g.textBaseline = 'middle';
            g.lineWidth = 3; g.strokeStyle = '#0b1522'; g.strokeText(p.focusTarget.label, x + 16, y);
            g.fillStyle = '#deedf8'; g.fillText(p.focusTarget.label, x + 16, y);
          }
          g.restore();
        }
      }
    };
    m.overlay = (g, map) => {
      const p = props.current, L = layersRef.current, gs = flightState;
      const compactMap = !!p.compact, z = map.zoom;
      if (gs && L.route && p.navigation && gs.flightPlan[gs.activeWpIdx]) {
        const active = gs.flightPlan[gs.activeWpIdx];
        map.projectInto(gs.lat, gs.lon, ownshipPoint); map.projectInto(active.lat, active.lon, targetPoint);
        g.save(); g.setLineDash(compactMap ? NO_DASH : GUIDANCE_DASH); g.lineWidth = compactMap ? 2 : 1; g.strokeStyle = compactMap ? '#e58ada' : 'rgba(231,160,235,.6)';
        g.beginPath(); g.moveTo(ownshipPoint[0], ownshipPoint[1]); g.lineTo(targetPoint[0], targetPoint[1]); g.stroke(); g.restore();
      }
      if (gs) {
        map.projectInto(gs.lat, gs.lon, ownshipPoint); const x = ownshipPoint[0], y = ownshipPoint[1];
        if (!compactMap && z > 5) { const ppm = (256 * 2 ** z) / (40075016.7 * Math.cos(gs.lat * D2R)); g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1; for (const nm of RANGES_NM) { const r = nm * M_PER_NM * ppm; if (r > 24 && r < map.W) { g.beginPath(); g.arc(x, y, r, 0, 7); g.stroke(); g.fillStyle = 'rgba(255,255,255,.7)'; g.font = '10px ui-sans-serif'; g.fillText(`${nm}nm`, x + r * 0.7 + 3, y - r * 0.7); } } }
        const face = gs.track;
        const ha = face * D2R + map.rot;
        g.beginPath(); g.moveTo(x + Math.sin(ha) * 16, y - Math.cos(ha) * 16); g.lineTo(x + Math.sin(ha) * 46, y - Math.cos(ha) * 46);
        g.strokeStyle = 'rgba(53,224,255,.85)'; g.lineWidth = 2; g.setLineDash(TRACK_DASH); g.stroke(); g.setLineDash(NO_DASH);
        if (!compactMap) { g.font = '700 10px ui-sans-serif, system-ui'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillStyle = '#d9f6ff'; g.fillText(`TRK ${String(Math.round(face) % 360).padStart(3, '0')}°`, x + 18, y - 18); }
        g.save(); g.translate(x, y); g.rotate(gs.hdg * D2R + map.rot);
        g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 6; g.fillStyle = '#fff'; g.strokeStyle = '#0a1a28'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(0, -14); g.lineTo(3.5, -4); g.lineTo(14, 3); g.lineTo(14, 6.5); g.lineTo(3.2, 3.5); g.lineTo(2.6, 11); g.lineTo(6, 13.5); g.lineTo(6, 15.5); g.lineTo(0, 14); g.lineTo(-6, 15.5); g.lineTo(-6, 13.5); g.lineTo(-2.6, 11); g.lineTo(-3.2, 3.5); g.lineTo(-14, 6.5); g.lineTo(-14, 3); g.lineTo(-3.5, -4); g.closePath(); g.fill(); g.stroke(); g.restore();
      }
      const dest = p.to;
      if (L.route && dest) {
        const appr = gs?.appr ?? null;
        const target = appr ?? dest;
        map.projectInto(target.lat, target.lon, targetPoint); const dx = targetPoint[0], dy = targetPoint[1];
        if (dx < 10 || dx > map.W - 10 || dy < 10 || dy > map.H - 10) {
          const cx = map.W / 2, cy = map.H / 2, ang = Math.atan2(dy - cy, dx - cx);
          const rad = Math.min(map.W, map.H) / 2 - 24;
          const ax = cx + Math.cos(ang) * rad, ay = cy + Math.sin(ang) * rad;
          g.save(); g.translate(ax, ay); g.rotate(ang);
          g.fillStyle = '#ffb02e'; g.strokeStyle = '#06121c'; g.lineWidth = 2;
          g.beginPath(); g.moveTo(13, 0); g.lineTo(-6, -7); g.lineTo(-6, 7); g.closePath(); g.fill(); g.stroke();
          g.restore();
          if (compactMap) { drawMapCompass(g, map); return; }
          const fromLat = gs?.lat ?? p.from?.lat ?? target.lat, fromLon = gs?.lon ?? p.from?.lon ?? target.lon;
          const km = Math.round(haversine(fromLat, fromLon, target.lat, target.lon) / 1000).toLocaleString();
          const distance = p.navigation ? `${(haversine(fromLat, fromLon, target.lat, target.lon) / M_PER_NM).toFixed(0)} nm` : `${km} km`;
          const txt = `${dest.iata || dest.icao}${appr ? ` RWY ${appr.ident}` : ''} · ${distance}`;
          const lx = Math.min(map.W - 40, Math.max(40, ax)), ly = Math.min(map.H - 12, Math.max(12, ay + 20));
          g.font = '700 11px ui-sans-serif, system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.75)'; g.strokeText(txt, lx, ly);
          g.fillStyle = '#ffd9a0'; g.fillText(txt, lx, ly);
        }
      }
      if (Math.abs(map.rot) > 0.01 && !compactMap) { g.save(); g.translate(map.W - 34, 40); g.rotate(map.rot); g.fillStyle = '#ff5050'; g.beginPath(); g.moveTo(0, -14); g.lineTo(6, 4); g.lineTo(-6, 4); g.fill(); g.fillStyle = '#fff'; g.font = '700 11px ui-sans-serif'; g.textAlign = 'center'; g.fillText('N', 0, 17); g.restore(); }
      if (compactMap && p.navigation) drawMapCompass(g, map);
    };
    m.onTap = (x, y) => {
      const a = nearestAt(x, y, 18);
      if (a) {
        setSelectedAirport({ a, x, y });
        props.current.onInspectAirport?.(a);
        if (props.current.mode !== 'planner') {
          props.current.onPick?.(a);
        }
      } else {
        setSelectedAirport(null);
      }
    };
    m.onHover = (x, y) => { if (props.current.navigation) return; const a = nearestAt(x, y, 12); setTip((t) => (a ? { x, y, a } : t ? null : t)); };
    m.onViewChange = (kind) => {
      if (kind === 'pan' && props.current.mode === 'flight') { navRef.current = 'free'; setNav('free'); }
      else if (props.current.mode === 'planner' && navRef.current === 'route') { navRef.current = 'explore'; setNav('explore'); }
    };
    const ro = new ResizeObserver(() => m.resize()); ro.observe(wrapRef.current!); m.resize();
    if (mode === 'flight') {
      m.interactive = !compact;
      if (compact || navigation) { const position = game?.getMapState(); m.setView(position?.lat ?? from?.lat ?? -2.2, position?.lon ?? from?.lon ?? 118, 9); }
      else if (game && to) {
        const s = game.getMapState();
        const bounds: [number, number][] = [[s.lat, s.lon], ...s.navPath];
        if (!s.navPath.length) bounds.push([to.lat, to.lon]);
        m.fitBounds(bounds, 64);
      }
      else m.setView(from?.lat ?? -2.2, from?.lon ?? 118, 6);
    }
    else if (from && to) m.fitBounds([[from.lat, from.lon], [to.lat, to.lon]], 140);
    else if (from) m.setView(from.lat, from.lon, 6);
    else m.setView(-2.2, 118, 4.2);
    const savedView = viewStateRef?.current;
    if (savedView) {
      navRef.current = savedView.nav; setNav(savedView.nav); lastFocusRequest.current = savedView.focusRequest;
      m.setView(savedView.lat, savedView.lon, savedView.zoom); m.rot = savedView.rot;
    }
    return () => {
      if (viewStateRef) viewStateRef.current = { lat: m.lat, lon: m.lon, zoom: m.zoom, rot: m.rot, nav: navRef.current, focusRequest: lastFocusRequest.current };
      ro.disconnect(); m.dispose(); mapRef.current = null;
    };
    // eslint-disable-next-line
  }, []);

  useEffect(() => { mapRef.current?.setStyle(styleId); }, [styleId]);
  useEffect(() => {
    const active = controlledLayers ?? layers;
    saveMapLayers(active);
    const m = mapRef.current; if (!m) return;
    m.showRoads = active.roads; m.showLabels = active.labels; m.showHillshade = active.terrain; m.invalidate();
  }, [layers, controlledLayers]);
  useEffect(() => {
    const m = mapRef.current; if (!m) return; m.invalidate();
    if (mode === 'planner' && navRef.current === 'route' && from && to) m.fitBounds([[from.lat, from.lon], [to.lat, to.lon]], 140);
    else if (mode === 'planner' && from && !to && navRef.current === 'route') m.setView(from.lat, from.lon, Math.max(m.zoom, 7));
  }, [from, to, routeKey, mode]);
  useEffect(() => { mapRef.current?.invalidate(); }, [picking]);

  const setMode = useCallback((n: NavMode) => {
    navRef.current = n; setNav(n); const m = mapRef.current; if (!m) return;
    if (n === 'route' && from && to) {
      if (mode === 'flight' && game) {
        const s = game.getMapState();
        m.fitBounds([[s.lat, s.lon], ...s.flightPlan.slice(s.activeWpIdx).map((wp): [number, number] => [wp.lat, wp.lon])], 48);
      } else m.fitBounds([[from.lat, from.lon], [to.lat, to.lon]], 140);
    }
    if (n === 'north') { m.rot = 0; if (game) { const s = game.getMapState(); m.lat = s.lat; m.lon = s.lon; } }
    if (n === 'track' && game) { const s = game.getMapState(); m.rot = -s.track * D2R; m.lat = s.lat; m.lon = s.lon; }
    m.invalidate();
  }, [from, to, mode, game]);

  useEffect(() => {
    if (!plannerControlRef) return;
    plannerControlRef.current = {
      zoomBy: (dz) => mapRef.current?.zoomBy(dz),
      fitRoute: () => setMode('route'),
      globeView: () => {
        if (!mapRef.current) return;
        navRef.current = 'explore';
        setNav('explore');
        mapRef.current.setView(from?.lat ?? -2.2, from?.lon ?? 118, 2.7);
      },
      focusAirport: (a, zoom = 13.2) => {
        if (!mapRef.current) return;
        navRef.current = 'explore';
        setNav('explore');
        mapRef.current.setView(a.lat, a.lon, zoom);
        const pt = mapRef.current.project(a.lat, a.lon);
        setSelectedAirport({ a, x: pt[0], y: pt[1] });
        props.current.onInspectAirport?.(a);
      },
      toggleLayers: () => setLayersOpen((o) => !o),
    };
  }, [plannerControlRef, setMode, from]);

  useEffect(() => {
    if (!focusTarget || !mapRef.current || focusTarget.request === lastFocusRequest.current) return;
    lastFocusRequest.current = focusTarget.request;
    navRef.current = 'free'; setNav('free');
    mapRef.current.setView(focusTarget.lat, focusTarget.lon, Math.max(8, mapRef.current.zoom));
  }, [focusTarget]);

  const st = styleById(styleId);
  const btn = 'px-2.5 py-1.5 text-[11px] font-semibold rounded-md transition border backdrop-blur ';
  return (
    <div ref={wrapRef} className={`overflow-hidden bg-[#05080f] ${navigation ? 'flight-map-canvas' : ''} ${className || "relative"}`}>
      <canvas ref={canvasRef} aria-label={navigation ? 'Live navigation map. Drag to pan, scroll to zoom.' : 'Airport map'} className="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing" />
      {!compact && !navigation && !hideDefaultPlannerChrome && (
        <>
          <div className="absolute top-3 left-3 z-30 flex flex-wrap items-center gap-1.5 max-w-[calc(100%-140px)] sm:max-w-none">
            <button onClick={() => setLayersOpen((o) => !o)} className={btn + 'bg-slate-900/85 text-white border-white/20 shadow-lg flex items-center gap-1.5'}>
              <FlightIcon name="layers" size={13} />
              <span>Layers{layers.roads ? ' · roads' : ''}</span>
            </button>
            {mode === 'flight' && game && (
              <button
                onClick={() => game.cycleRunway()}
                className={btn + 'bg-slate-900/85 text-amber-300 border-amber-400/30 shadow-lg hover:border-amber-400 flex items-center gap-1.5'}
                title="Click to cycle approach runway"
              >
                <FlightIcon name="plane" size={13} />
                <span>ARR RWY: {game.apprKey || 'AUTO'}</span>
              </button>
            )}
          </div>
          <div className="absolute bottom-8 left-3 flex gap-1.5">
            {(mode === 'planner' ? [['route', 'Route'], ['explore', 'Explore']] : [['north', 'North-up'], ['track', 'Track-up'], ['free', 'Free']]).map(([id, label]) => (
              <button key={id} onClick={() => setMode(id as NavMode)} className={btn + (nav === id ? 'bg-sky-400 text-slate-950 border-sky-300' : 'bg-slate-900/70 text-slate-100 border-white/15 hover:bg-slate-800')}>{label}</button>
            ))}
          </div>
          <div className="absolute top-3 right-3 flex flex-col gap-1.5">
            <button className={btn + 'bg-slate-900/80 text-white border-white/20 w-8 grid place-items-center !py-1.5'} onClick={() => mapRef.current?.zoomBy(1)} aria-label="Zoom in"><FlightIcon name="plus" size={14} /></button>
            <button className={btn + 'bg-slate-900/80 text-white border-white/20 w-8 grid place-items-center !py-1.5'} onClick={() => mapRef.current?.zoomBy(-1)} aria-label="Zoom out"><FlightIcon name="minus" size={14} /></button>
          </div>
        </>
      )}

      {/* Layers Popover (Shared between Default & MSFS Bottom-Right Toolbar) */}
      {!compact && !navigation && layersOpen && (
        <div
          className={`absolute z-40 ${
            hideDefaultPlannerChrome ? 'bottom-28 right-4' : 'top-12 left-3'
          } w-[280px] max-w-[calc(100vw-2rem)] max-h-[70vh] overflow-y-auto border border-white/20 bg-[#101722]/96 backdrop-blur-md p-3 shadow-2xl text-white`}
        >
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <span className="text-[10px] tracking-[0.2em] font-black text-sky-300">WORLD MAP LAYERS</span>
            <button onClick={() => setLayersOpen(false)} className="w-6 h-6 bg-white/10 hover:bg-white/20 grid place-items-center" aria-label="Close layers">
              <FlightIcon name="close" size={12} />
            </button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {TILE_STYLES.filter((s) => s.id !== 'sat').map((s) => (
              <button
                key={s.id}
                onClick={() => onStyle(s.id)}
                className={`px-2.5 py-1.5 text-[11px] font-bold border text-left transition ${
                  s.id === styleId ? 'bg-[#2572eb] text-white border-sky-300' : 'bg-white/5 text-slate-200 border-white/10 hover:bg-white/10'
                }`}
              >
                {s.name}
              </button>
            ))}
          </div>
          <div className="mt-3 text-[10px] tracking-[0.2em] font-black text-sky-300">MAP OVERLAYS</div>
          <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-1">
            {([['roads', 'Roads & rail'], ['labels', 'Place labels'], ['terrain', 'Terrain relief'], ['airports', 'Airports'], ['route', 'Route & trail']] as const).map(([key, label]) => (
              <label key={key} className="flex items-center gap-1.5 py-0.5 text-[11px] text-slate-200 cursor-pointer">
                <input type="checkbox" checked={layers[key]} onChange={(e) => setLayers((l) => ({ ...l, [key]: e.target.checked }))} className="accent-sky-400" />
                {label}
              </label>
            ))}
          </div>
          <div className="mt-2.5 flex gap-1.5">
            <button onClick={() => setLayers({ roads: false, labels: false, airports: false, route: true, terrain: false })} className="flex-1 px-2 py-1 text-[10px] font-bold bg-white/5 hover:bg-white/15 border border-white/10">Minimal</button>
            <button onClick={() => setLayers({ roads: true, labels: true, airports: true, route: true, terrain: true })} className="flex-1 px-2 py-1 text-[10px] font-bold bg-white/5 hover:bg-white/15 border border-white/10">All layers</button>
          </div>
        </div>
      )}

      {navigation && !compact && (
        <>
          <div className="flight-map-top-controls">
            <button className="flight-map-control" onClick={() => setMode(nav === 'track' ? 'north' : 'track')}
              aria-label={nav === 'track' ? 'Switch to north-up' : 'Switch to track-up'} title="Map orientation">
              <FlightIcon name="arrow" size={13} />{nav === 'track' ? 'TRK UP' : nav === 'north' ? 'NORTH UP' : nav === 'route' ? 'ROUTE' : 'FREE PAN'}
            </button>
            <button className="flight-map-control" onClick={() => setMode('route')} aria-label="Fit remaining route" title="Fit remaining route">
              <FlightIcon name="route" size={14} />Route
            </button>
          </div>
          <div className="flight-map-zoom">
            <button className="flight-map-fit-icon" onClick={() => setMode('route')} aria-label="Fit remaining route" title="Fit remaining route"><FlightIcon name="route" size={16} /></button>
            <button onClick={() => mapRef.current?.zoomBy(0.5)} aria-label="Zoom in" title="Zoom in"><FlightIcon name="plus" size={17} /></button>
            <button onClick={() => mapRef.current?.zoomBy(-0.5)} aria-label="Zoom out" title="Zoom out"><FlightIcon name="minus" size={17} /></button>
            <button onClick={() => setMode(nav === 'north' ? 'north' : 'track')} aria-label="Recenter on aircraft"
              title="Recenter on aircraft" data-active={nav === 'track' || nav === 'north'}><FlightIcon name="target" size={17} /></button>
          </div>
          {(nav === 'free' || nav === 'route') && <button className="flight-map-recenter" onClick={() => setMode('track')}>
            <FlightIcon name="target" size={13} />Follow aircraft
          </button>}
        </>
      )}
      {compact && (
        <button onClick={onExpand} className="flight-mini-expand absolute inset-0 w-full h-full" aria-label="Expand map" aria-keyshortcuts="M"><span className="flight-mini-expand-hint" aria-hidden="true"><FlightIcon name="expand" size={13} />Full screen <kbd>M</kbd></span></button>
      )}
      {tip && !compact && !navigation && !selectedAirport && (
        <div
          className="pointer-events-none absolute z-20 shadow-2xl border border-white/20 overflow-hidden"
          style={{
            left: Math.max(12, Math.min(tip.x + 14, (wrapRef.current?.clientWidth || 800) - 250)),
            top: Math.max(12, Math.min(tip.y - 24, (wrapRef.current?.clientHeight || 600) - 90)),
          }}
        >
          <div className="bg-white text-slate-950 px-2.5 py-1 text-xs font-extrabold tracking-tight">
            {tip.a.icao} - {tip.a.name}
          </div>
          <div className="bg-[#1b222c]/95 text-slate-200 px-2.5 py-1.5 text-[11px] font-mono flex items-center gap-3">
            <span>{Math.round(tip.a.elev / 0.3048).toLocaleString()} ft</span>
            <span>{tip.a.runways.length} rwy</span>
            <span>{Math.max(...tip.a.runways.map((r) => Math.round(r.length))).toLocaleString()} m</span>
          </div>
        </div>
      )}

      {/* MSFS 2024 Floating Airport Context Popup on Map (Matches Images 4 & 8) */}
      {selectedAirport && !compact && mode === 'planner' && (
        <div
          className="absolute z-30 w-64 shadow-2xl select-none animate-[fadein_.15s_ease-out]"
          style={{
            left: Math.max(16, Math.min(selectedAirport.x - 30, (wrapRef.current?.clientWidth || 900) - 280)),
            top: Math.max(96, Math.min(selectedAirport.y - 40, (wrapRef.current?.clientHeight || 700) - 210)),
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* White Header Bar with Airport ICAO & Name (Image 8 style) */}
          <div className="bg-white text-slate-950 px-3 py-1.5 flex items-center justify-between gap-2 border border-white">
            <div className="font-extrabold text-xs truncate">
              {selectedAirport.a.icao} - {selectedAirport.a.name}
            </div>
            <button
              type="button"
              onClick={() => setSelectedAirport(null)}
              className="text-slate-600 hover:text-slate-950 shrink-0"
              aria-label="Close airport menu"
            >
              <FlightIcon name="close" size={13} />
            </button>
          </div>

          {/* Dark Telemetry Strip (Elevation, Wind/Runway Info) */}
          <div className="bg-[#232b35]/95 text-slate-200 px-3 py-2 text-[11px] border-x border-b border-white/15 space-y-0.5 font-mono">
            <div className="flex items-center justify-between">
              <span className="text-emerald-400 font-bold">{selectedAirport.a.city || selectedAirport.a.country}</span>
              <span>ELEV {Math.round(selectedAirport.a.elev / 0.3048).toLocaleString()} ft</span>
            </div>
            <div className="flex items-center justify-between text-slate-300">
              <span>{selectedAirport.a.runways.length} Runways</span>
              <span>
                Max {Math.max(...selectedAirport.a.runways.map((r) => Math.round(r.length))).toLocaleString()} m
              </span>
            </div>
          </div>

          {/* 3 Stacked MSFS Action Buttons (Image 4 style: White / Blue / Yellow) */}
          <div className="mt-1 border border-slate-900/80 shadow-xl flex flex-col text-xs font-bold">
            <button
              type="button"
              onClick={() => {
                if (props.current.onSetAirport) props.current.onSetAirport(selectedAirport.a, 'from');
                else props.current.onPick?.(selectedAirport.a);
                setSelectedAirport(null);
              }}
              className="w-full px-3 py-1.5 text-left bg-white hover:bg-slate-100 text-slate-950 transition flex items-center justify-between"
            >
              <span>Set as departure</span>
              <span className="text-[10px] font-mono text-slate-600">DEP</span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (props.current.onSetAirport) props.current.onSetAirport(selectedAirport.a, 'to');
                else props.current.onPick?.(selectedAirport.a);
                setSelectedAirport(null);
              }}
              className="w-full px-3 py-1.5 text-left bg-[#1d6ae5] hover:bg-[#2572eb] text-white transition flex items-center justify-between"
            >
              <span>Set as arrival</span>
              <span className="text-[10px] font-mono text-sky-200">ARR</span>
            </button>
            {onFlyNow && (
              <button
                type="button"
                onClick={() => {
                  onFlyNow(selectedAirport.a);
                  setSelectedAirport(null);
                }}
                className="w-full px-3 py-1.5 text-left bg-[#eab308] hover:bg-[#facc15] text-slate-950 font-extrabold transition flex items-center justify-between"
              >
                <span>Fly Now</span>
                <FlightIcon name="plane" size={13} />
              </button>
            )}
          </div>
        </div>
      )}
      {!compact && !hideDefaultPlannerChrome && (
        <div className={navigation ? 'flight-map-attribution' : 'absolute bottom-1 right-2 text-[10px] text-white/80 bg-black/45 px-1.5 rounded'}>
          {st.attribution}
        </div>
      )}
    </div>
  );
}

/** True-north rose uses the same projection rotation as the live map, including free-pan. */
function drawMapCompass(g: CanvasRenderingContext2D, map: CanvasMap) {
  const cx = map.W / 2, cy = map.H / 2, radius = Math.min(map.W, map.H) / 2 - 5;
  g.save(); g.strokeStyle = 'rgba(241,245,241,.65)'; g.fillStyle = '#f3f5f0'; g.lineWidth = 1;
  g.font = '600 9px ui-sans-serif, system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const degrees of COMPASS_TICKS) {
    const angle = degrees * D2R + map.rot, sn = Math.sin(angle), co = Math.cos(angle);
    const inner = radius - (degrees % 30 === 0 ? 9 : 4);
    g.beginPath(); g.moveTo(cx + sn * inner, cy - co * inner); g.lineTo(cx + sn * radius, cy - co * radius); g.stroke();
    if (degrees % 30 === 0 && radius > 56) {
      const label = degrees === 0 ? 'N' : degrees === 90 ? 'E' : degrees === 180 ? 'S' : degrees === 270 ? 'W' : String(degrees / 10);
      g.fillText(label, cx + sn * (radius - 18), cy - co * (radius - 18));
    }
  }
  g.beginPath(); g.moveTo(cx - 4, 3); g.lineTo(cx, 9); g.lineTo(cx + 4, 3); g.stroke();
  g.restore();
}
