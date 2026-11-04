// Lightweight slippy-map renderer on <canvas>: OSM-based raster tiles, rotation (track-up), pan/zoom/pinch, hit-testing.
import { lonToTileXf, latToTileYf, tileXToLon, tileYToLat, clamp } from '../sim/geo';
import {
  loadImage, peekImage, tileUrl, styleById,
  ROAD_OVERLAY_URL, LABEL_OVERLAY_URL, ROAD_MAX_ZOOM, LABEL_MAX_ZOOM,
  HILLSHADE_URL, HILLSHADE_MAX_ZOOM,
} from '../sim/tiles';

export type MapOverlay = (g: CanvasRenderingContext2D, m: CanvasMap) => void;

export class CanvasMap {
  lat = -2.2; lon = 118; zoom = 4.8; rot = 0; styleId = 'hybrid';
  W = 300; H = 300; dpr = 1;
  g: CanvasRenderingContext2D;
  overlay: MapOverlay | null = null;
  onViewChange: (() => void) | null = null; onTap: ((x: number, y: number, e: PointerEvent) => void) | null = null; onHover: ((x: number, y: number) => void) | null = null;
  interactive = true; showScale = true; showRoads = false; roadOpacity = 0.62; showLabels = true; showHillshade = true;
  private dirty = true; private raf = 0; private pointers = new Map<number, { x: number; y: number }>(); private lastPinch = 0; private moved = 0; private dragging = false;
  minZoom = 2; maxZoom = 17;
  private requested = new Set<string>();

  constructor(public canvas: HTMLCanvasElement) {
    this.g = canvas.getContext('2d')!;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.pd); canvas.addEventListener('pointermove', this.pm); canvas.addEventListener('pointerup', this.pu); canvas.addEventListener('pointercancel', this.pu);
    canvas.addEventListener('wheel', this.wheel, { passive: false }); canvas.addEventListener('dblclick', this.dbl);
    const loop = () => { this.raf = requestAnimationFrame(loop); if (this.dirty) { this.dirty = false; this.draw(); } };
    this.raf = requestAnimationFrame(loop);
  }
  dispose() {
    cancelAnimationFrame(this.raf); const c = this.canvas;
    c.removeEventListener('pointerdown', this.pd); c.removeEventListener('pointermove', this.pm); c.removeEventListener('pointerup', this.pu); c.removeEventListener('pointercancel', this.pu); c.removeEventListener('wheel', this.wheel); c.removeEventListener('dblclick', this.dbl);
  }
  invalidate() { this.dirty = true; }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    // A full-screen map at 2x DPR repaints millions of pixels every frame it follows the aircraft;
    // 1.5x is visually identical for raster tiles and costs ~45% less fill rate.
    const cap = r.width * r.height > 700_000 ? 1.5 : 2;
    this.dpr = Math.min(cap, window.devicePixelRatio || 1);
    this.W = Math.max(50, r.width); this.H = Math.max(50, r.height);
    this.canvas.width = Math.round(this.W * this.dpr); this.canvas.height = Math.round(this.H * this.dpr); this.invalidate();
  }
  setStyle(id: string) { this.styleId = id; this.maxZoom = Math.min(17, styleById(id).maxZoom); this.zoom = Math.min(this.zoom, this.maxZoom); this.invalidate(); }
  setView(lat: number, lon: number, zoom?: number) { this.lat = clamp(lat, -84, 84); this.lon = lon; if (zoom !== undefined) this.zoom = clamp(zoom, this.minZoom, this.maxZoom); this.invalidate(); }
  fitBounds(pts: [number, number][], pad = 70) {
    if (!pts.length) return;
    let minLa = 90, maxLa = -90, minLo = 180, maxLo = -180; for (const [la, lo] of pts) { minLa = Math.min(minLa, la); maxLa = Math.max(maxLa, la); minLo = Math.min(minLo, lo); maxLo = Math.max(maxLo, lo); }
    this.lat = (minLa + maxLa) / 2; this.lon = (minLo + maxLo) / 2;
    const w = Math.max(40, this.W - pad * 2), h = Math.max(40, this.H - pad * 2);
    const spanX = Math.max(1e-4, (maxLo - minLo) / 360), spanY = Math.max(1e-4, Math.abs(latToTileYf(minLa, 0) - latToTileYf(maxLa, 0)));
    this.zoom = clamp(Math.min(Math.log2(w / 256 / spanX), Math.log2(h / 256 / spanY)), this.minZoom, 12); this.rot = 0; this.invalidate();
  }
  // world <-> screen
  project(lat: number, lon: number): [number, number] {
    const s = 256 * 2 ** this.zoom;
    const dx = (lonToTileXf(lon, 0) - lonToTileXf(this.lon, 0)) * s, dy = (latToTileYf(lat, 0) - latToTileYf(this.lat, 0)) * s;
    const c = Math.cos(this.rot), si = Math.sin(this.rot);
    return [this.W / 2 + dx * c - dy * si, this.H / 2 + dx * si + dy * c];
  }
  unproject(x: number, y: number): [number, number] {
    const s = 256 * 2 ** this.zoom, c = Math.cos(-this.rot), si = Math.sin(-this.rot);
    const px = x - this.W / 2, py = y - this.H / 2, dx = px * c - py * si, dy = px * si + py * c;
    return [tileYToLat(latToTileYf(this.lat, 0) + dy / s, 0), tileXToLon(lonToTileXf(this.lon, 0) + dx / s, 0)];
  }

  draw() {
    const g = this.g, st = styleById(this.styleId); g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = st.dark ? '#0b1118' : '#dfe6ea'; g.fillRect(0, 0, this.W, this.H);
    const zi = clamp(Math.floor(this.zoom + 0.35), 0, st.maxZoom);
    g.save(); g.translate(this.W / 2, this.H / 2); g.rotate(this.rot);
    this.drawLayer(st.url, zi, 1);

    // Subtle 2.5D topographic hillshade relief overlay
    if (this.showHillshade) {
      const hillZ = Math.min(zi, HILLSHADE_MAX_ZOOM);
      g.save();
      g.globalCompositeOperation = st.dark ? 'overlay' : 'multiply';
      this.drawLayer(HILLSHADE_URL, hillZ, st.dark ? 0.22 : 0.32, 1.0);
      g.restore();
    }

    // Independent overlays so the user can hide roads/labels on any base map.
    const roadTpl = st.overlayUrl ?? (st.satellite ? ROAD_OVERLAY_URL : '');
    const roadOpacity = st.overlayUrl ? (st.overlayOpacity ?? 0.9) : this.roadOpacity;
    if (this.showRoads && roadTpl) this.drawLayer(roadTpl, Math.min(zi, st.overlayMaxZoom ?? (st.satellite ? ROAD_MAX_ZOOM : st.maxZoom)), roadOpacity, 1.5);
    const labelTpl = st.labelUrl ?? (st.satellite ? LABEL_OVERLAY_URL : '');
    if (this.showLabels && labelTpl) this.drawLayer(labelTpl, Math.min(zi, st.overlayMaxZoom ?? (st.satellite ? LABEL_MAX_ZOOM : st.maxZoom)), 0.95, 2.5);
    g.restore();
    if (this.overlay) this.overlay(g, this);
    this.drawScaleBar();
  }

  /** True-scale bar: metres per screen pixel at the map centre latitude. */
  private drawScaleBar() {
    if (!this.showScale || this.W < 220) return;
    const mPerPx = (156543.03392 * Math.cos((this.lat * Math.PI) / 180)) / 2 ** this.zoom;
    if (!isFinite(mPerPx) || mPerPx <= 0) return;
    const raw = Math.min(120, this.W * 0.3) * mPerPx;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const nice = [5, 2, 1].map((k) => k * pow).find((v) => v <= raw) ?? pow;
    const px = Math.max(20, nice / mPerPx);
    const label = nice >= 1000 ? `${+(nice / 1000).toFixed(nice >= 10000 ? 0 : 1)} km` : `${Math.round(nice)} m`;
    const dark = !!styleById(this.styleId).dark;
    const g = this.g, x = this.W - 14 - px, y = this.H - 24;
    g.save();
    g.lineCap = 'butt';
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + px, y);
    g.lineWidth = 3; g.strokeStyle = dark ? 'rgba(0,0,0,.7)' : 'rgba(255,255,255,.8)'; g.stroke();
    g.lineWidth = 1.4; g.strokeStyle = dark ? '#e2f2ff' : '#173247'; g.stroke();
    g.beginPath(); g.moveTo(x, y - 4); g.lineTo(x, y + 4); g.moveTo(x + px, y - 4); g.lineTo(x + px, y + 4); g.stroke();
    g.font = '600 10px ui-sans-serif, system-ui'; g.textAlign = 'right'; g.textBaseline = 'bottom';
    g.lineWidth = 3; g.strokeStyle = dark ? 'rgba(0,0,0,.8)' : 'rgba(255,255,255,.9)';
    g.strokeText(label, x + px, y - 5);
    g.fillStyle = dark ? '#e6f3ff' : '#0d2b3f'; g.fillText(label, x + px, y - 5);
    g.restore();
  }

  /** Draw one slippy-map raster layer (base imagery, road overlay or labels), with parent-tile fallback. */
  private drawLayer(tpl: string, z: number, opacity: number, prioOffset = 0) {
    const g = this.g;
    if (!tpl || opacity <= 0) return;
    const size = 256 * 2 ** (this.zoom - z);
    const cx = lonToTileXf(this.lon, z), cy = latToTileYf(this.lat, z);
    const rad = Math.hypot(this.W, this.H) / 2 / size + 1, n = 2 ** z;
    const x0 = Math.floor(cx - rad), x1 = Math.ceil(cx + rad), y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(n - 1, Math.ceil(cy + rad));
    g.globalAlpha = opacity;
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const px = (tx - cx) * size, py = (ty - cy) * size;
      const url = tileUrl(tpl, z, tx, ty); const img = peekImage(url);
      if (img) g.drawImage(img, px - 0.4, py - 0.4, size + 0.8, size + 0.8);
      else {
        // fall back to a lower-zoom parent so the map never goes blank while loading
        for (let up = 1; up <= 4 && z - up >= 0; up++) {
          const pz = z - up, ptx = Math.floor(tx / 2 ** up), pty = Math.floor(ty / 2 ** up), pimg = peekImage(tileUrl(tpl, pz, ptx, pty));
          if (pimg) { const f = 256 / 2 ** up; g.drawImage(pimg, (tx - ptx * 2 ** up) * f, (ty - pty * 2 ** up) * f, f, f, px, py, size + 0.5, size + 0.5); break; }
        }
        if (!this.requested.has(url)) {
          this.requested.add(url); if (this.requested.size > 3000) this.requested.clear();
          const prio = Math.hypot(tx - cx, ty - cy) * 0.3 + prioOffset;
          loadImage(url, prio).then(() => { this.requested.delete(url); this.invalidate(); });
        }
      }
    }
    g.globalAlpha = 1;
  }

  // ---- interaction ----
  private pd = (e: PointerEvent) => {
    if (!this.interactive) return; this.canvas.setPointerCapture(e.pointerId); const r = this.canvas.getBoundingClientRect();
    this.pointers.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
    if (this.pointers.size === 1) { this.moved = 0; this.dragging = true; }
    if (this.pointers.size === 2) { const [a, b] = [...this.pointers.values()]; this.lastPinch = Math.hypot(a.x - b.x, a.y - b.y); }
  };
  private pm = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const p = this.pointers.get(e.pointerId);
    if (!p) { this.onHover?.(x, y); return; }
    if (this.pointers.size === 1 && this.dragging) {
      const dx = x - p.x, dy = y - p.y; this.moved += Math.abs(dx) + Math.abs(dy);
      if (this.moved > 6) { this.panBy(dx, dy); this.onViewChange?.(); }
    } else if (this.pointers.size === 2) {
      p.x = x; p.y = y; const [a, b] = [...this.pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.lastPinch > 0) { this.zoomBy(Math.log2(d / this.lastPinch), (a.x + b.x) / 2, (a.y + b.y) / 2); this.onViewChange?.(); } this.lastPinch = d; this.moved = 99;
    }
    p.x = x; p.y = y;
  };
  private pu = (e: PointerEvent) => {
    const had = this.pointers.has(e.pointerId); this.pointers.delete(e.pointerId); this.lastPinch = 0;
    if (had && this.pointers.size === 0) { this.dragging = false; if (this.moved < 7) { const r = this.canvas.getBoundingClientRect(); this.onTap?.(e.clientX - r.left, e.clientY - r.top, e); } }
  };
  private wheel = (e: WheelEvent) => { if (!this.interactive) return; e.preventDefault(); const r = this.canvas.getBoundingClientRect(); this.zoomBy(-e.deltaY * 0.0016, e.clientX - r.left, e.clientY - r.top); this.onViewChange?.(); };
  private dbl = (e: MouseEvent) => { if (!this.interactive) return; const r = this.canvas.getBoundingClientRect(); this.zoomBy(1, e.clientX - r.left, e.clientY - r.top); this.onViewChange?.(); };
  panBy(dx: number, dy: number) {
    const s = 256 * 2 ** this.zoom, c = Math.cos(-this.rot), si = Math.sin(-this.rot);
    const wx = dx * c - dy * si, wy = dx * si + dy * c;
    this.lon = tileXToLon(lonToTileXf(this.lon, 0) - wx / s, 0); this.lat = clamp(tileYToLat(latToTileYf(this.lat, 0) - wy / s, 0), -84, 84); this.invalidate();
  }
  zoomBy(dz: number, x = this.W / 2, y = this.H / 2) {
    const before = this.unproject(x, y); this.zoom = clamp(this.zoom + dz, this.minZoom, this.maxZoom);
    const after = this.unproject(x, y); this.lat = clamp(this.lat + before[0] - after[0], -84, 84); this.lon += before[1] - after[1]; this.invalidate();
  }
}
