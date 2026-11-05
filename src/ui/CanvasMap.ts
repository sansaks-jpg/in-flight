// Lightweight slippy-map renderer on <canvas>: OSM-based raster tiles, rotation (track-up), pan/zoom/pinch, hit-testing.
import { lonToTileXf, latToTileYf, tileXToLon, tileYToLat, clamp } from '../sim/geo';
import {
  loadImage, peekImage, imageRetryAt, tileUrl, styleById,
  ROAD_OVERLAY_URL, LABEL_OVERLAY_URL, ROAD_MAX_ZOOM, LABEL_MAX_ZOOM,
  HILLSHADE_URL, HILLSHADE_MAX_ZOOM,
} from '../sim/tiles';

export type MapOverlay = (g: CanvasRenderingContext2D, m: CanvasMap) => void;

export class CanvasMap {
  lat = -2.2; lon = 118; zoom = 4.8; rot = 0; styleId = 'hybrid';
  W = 300; H = 300; dpr = 1;
  viewportW = 300; viewportH = 300;
  g: CanvasRenderingContext2D;
  overlay: MapOverlay | null = null;
  /** Geographic artwork is cached; only the aircraft and screen-space controls paint each frame. */
  backgroundOverlay: MapOverlay | null = null;
  beforeFrame: ((now: number) => boolean) | null = null;
  private background = document.createElement('canvas');
  private backgroundDirty = true; private disposed = false; private nextRetry = Infinity;
  private anchorLat = NaN; private anchorLon = NaN; private anchorZoom = NaN; private anchorRot = 0;
  private cacheW = 0; private cacheH = 0;
  private readonly padding = 96;
  readonly stats = { frames: 0, backgroundBuilds: 0 };
  onViewChange: ((kind: 'pan' | 'zoom') => void) | null = null; onTap: ((x: number, y: number, e: PointerEvent) => void) | null = null; onHover: ((x: number, y: number) => void) | null = null;
  interactive = true; showScale = true; showRoads = false; roadOpacity = 0.62; showLabels = true; showHillshade = true;
  showGrid = false; scaleUnits: 'metric' | 'nm' = 'metric'; planetaryMode = false;
  private dirty = true; private raf = 0; private pointers = new Map<number, { x: number; y: number }>(); private lastPinch = 0; private moved = 0; private dragging = false;
  minZoom = 2; maxZoom = 17;
  private requested = new Set<string>();

  constructor(public canvas: HTMLCanvasElement) {
    this.g = canvas.getContext('2d')!;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.pd); canvas.addEventListener('pointermove', this.pm); canvas.addEventListener('pointerup', this.pu); canvas.addEventListener('pointercancel', this.pu);
    canvas.addEventListener('wheel', this.wheel, { passive: false }); canvas.addEventListener('dblclick', this.dbl);
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const moving = this.beforeFrame?.(now) ?? false;
      if (Date.now() >= this.nextRetry) { this.nextRetry = Infinity; this.invalidate(); }
      if (this.dirty || moving) { this.dirty = false; this.draw(); }
    };
    this.raf = requestAnimationFrame(loop);
  }
  dispose() {
    this.disposed = true; cancelAnimationFrame(this.raf); const c = this.canvas;
    this.beforeFrame = null; this.overlay = null; this.backgroundOverlay = null;
    this.background.width = this.background.height = 1; this.requested.clear();
    c.removeEventListener('pointerdown', this.pd); c.removeEventListener('pointermove', this.pm); c.removeEventListener('pointerup', this.pu); c.removeEventListener('pointercancel', this.pu); c.removeEventListener('wheel', this.wheel); c.removeEventListener('dblclick', this.dbl);
  }
  invalidate() { this.dirty = true; this.backgroundDirty = true; }
  requestDraw() { this.dirty = true; }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    // A full-screen map at 2x DPR repaints millions of pixels every frame it follows the aircraft;
    // 1.5x is visually identical for raster tiles and costs ~45% less fill rate.
    const cap = r.width * r.height > 700_000 ? 1.5 : 2;
    this.dpr = Math.min(cap, window.devicePixelRatio || 1);
    this.W = this.viewportW = Math.max(50, r.width); this.H = this.viewportH = Math.max(50, r.height);
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
  /** Allocation-free projection for the RAF aircraft/compass layer. */
  projectInto(lat: number, lon: number, out: Float64Array) {
    const scale = 256 * 2 ** this.zoom;
    const dx = (lonToTileXf(lon, 0) - lonToTileXf(this.lon, 0)) * scale;
    const dy = (latToTileYf(lat, 0) - latToTileYf(this.lat, 0)) * scale;
    const c = Math.cos(this.rot), sn = Math.sin(this.rot);
    out[0] = this.W / 2 + dx * c - dy * sn; out[1] = this.H / 2 + dx * sn + dy * c;
  }
  unproject(x: number, y: number): [number, number] {
    const s = 256 * 2 ** this.zoom, c = Math.cos(-this.rot), si = Math.sin(-this.rot);
    const px = x - this.W / 2, py = y - this.H / 2, dx = px * c - py * si, dy = px * si + py * c;
    return [tileYToLat(latToTileYf(this.lat, 0) + dy / s, 0), tileXToLon(lonToTileXf(this.lon, 0) + dx / s, 0)];
  }

  draw() {
    const W = this.W, H = this.H, dpr = this.dpr, g = this.g;
    const scale = 256 * 2 ** this.zoom;
    const dx = (lonToTileXf(this.anchorLon, 0) - lonToTileXf(this.lon, 0)) * scale;
    const dy = (latToTileYf(this.anchorLat, 0) - latToTileYf(this.lat, 0)) * scale;
    const turn = this.rot - this.anchorRot;
    if (this.backgroundDirty || this.zoom !== this.anchorZoom || !isFinite(dx) ||
        Math.abs(dx) > this.padding * .65 || Math.abs(dy) > this.padding * .65 ||
        Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn))) > .105) this.buildBackground();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    // Reproject the cached geography, not a delayed aircraft pose. Both follow and track-up
    // therefore run at the simulation's RAF cadence without rescanning tiles/airports each frame.
    const ax = (lonToTileXf(this.anchorLon, 0) - lonToTileXf(this.lon, 0)) * scale;
    const ay = (latToTileYf(this.anchorLat, 0) - latToTileYf(this.lat, 0)) * scale;
    const c = Math.cos(this.rot), sn = Math.sin(this.rot);
    const showGlobeMask = this.planetaryMode && this.zoom < 4.6;
    const globeR = showGlobeMask ? Math.min(W, H) * (0.41 + Math.max(0, this.zoom - 2) * 0.16) : 0;
    if (showGlobeMask) {
      g.fillStyle = '#03060c';
      g.fillRect(0, 0, W, H);
      // Outer atmospheric blue glow in deep space
      const outerGlow = g.createRadialGradient(W / 2, H / 2, globeR * 0.88, W / 2, H / 2, globeR * 1.14);
      outerGlow.addColorStop(0, 'rgba(37, 114, 235, 0)');
      outerGlow.addColorStop(0.55, 'rgba(56, 152, 255, 0.38)');
      outerGlow.addColorStop(0.8, 'rgba(96, 185, 255, 0.55)');
      outerGlow.addColorStop(1, 'rgba(2, 6, 14, 0)');
      g.fillStyle = outerGlow;
      g.beginPath();
      g.arc(W / 2, H / 2, globeR * 1.14, 0, Math.PI * 2);
      g.fill();
    }
    g.save();
    if (showGlobeMask) {
      g.beginPath();
      g.arc(W / 2, H / 2, globeR, 0, Math.PI * 2);
      g.clip();
    }
    g.translate(W / 2 + ax * c - ay * sn, H / 2 + ax * sn + ay * c);
    g.rotate(this.rot - this.anchorRot);
    g.drawImage(this.background, -this.cacheW / 2, -this.cacheH / 2, this.cacheW, this.cacheH);
    g.restore();
    if (showGlobeMask) {
      // Inner spherical limb shading for 3D Earth curvature
      const innerRim = g.createRadialGradient(W / 2 - globeR * 0.18, H / 2 - globeR * 0.18, globeR * 0.25, W / 2, H / 2, globeR);
      innerRim.addColorStop(0, 'rgba(255, 255, 255, 0.04)');
      innerRim.addColorStop(0.7, 'rgba(14, 45, 95, 0.12)');
      innerRim.addColorStop(0.92, 'rgba(28, 108, 230, 0.42)');
      innerRim.addColorStop(1, 'rgba(90, 180, 255, 0.72)');
      g.fillStyle = innerRim;
      g.beginPath();
      g.arc(W / 2, H / 2, globeR, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(135, 206, 255, 0.65)';
      g.lineWidth = 1.8;
      g.stroke();
    }
    this.overlay?.(g, this); this.drawScaleBar(); this.stats.frames++;
  }

  private buildBackground() {
    const W = this.W, H = this.H, context = this.g;
    // The diagonal covers every track-up rotation. Bound cached pixels independently of DPR
    // so expanding a chart at 4K cannot allocate an oversized backing texture.
    const side = Math.ceil(Math.hypot(W, H) + this.padding * 2);
    const ratio = Math.min(this.dpr, Math.sqrt(5_000_000 / (side * side)));
    const pixels = Math.ceil(side * ratio);
    if (this.background.width !== pixels || this.background.height !== pixels) {
      this.background.width = pixels; this.background.height = pixels;
    }
    this.cacheW = this.cacheH = side;
    this.anchorLat = this.lat; this.anchorLon = this.lon; this.anchorZoom = this.zoom; this.anchorRot = this.rot;
    const g = this.background.getContext('2d')!, st = styleById(this.styleId);
    this.g = g; this.W = this.H = side;
    g.setTransform(pixels / side, 0, 0, pixels / side, 0, 0);
    g.fillStyle = st.dark ? '#09182e' : '#dfe6ea'; g.fillRect(0, 0, side, side);
    if (st.dark) this.drawProceduralEarthBase();
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
    if (this.showGrid || this.planetaryMode) this.drawNavigationGrid();
    this.backgroundOverlay?.(g, this);
    this.g = context; this.W = W; this.H = H;
    this.backgroundDirty = false; this.stats.backgroundBuilds++;
  }

  /** Satellite-toned ocean & continental landmass base so the map is immediately legible while tiles stream. */
  private drawProceduralEarthBase() {
    const g = this.g;
    const polys: [number, number][][] = [
      // Sumatra
      [[5.8, 95.3], [3.6, 98.7], [1.0, 102.2], [-2.8, 105.8], [-5.9, 105.8], [-5.4, 104.2], [-1.5, 100.2], [2.2, 97.2]],
      // Java & Bali & Nusa Tenggara
      [[-6.0, 105.9], [-6.2, 108.5], [-6.8, 111.5], [-7.6, 114.4], [-8.4, 115.7], [-8.8, 119.8], [-8.6, 124.5], [-9.2, 124.2], [-8.8, 115.2], [-7.8, 110.2], [-6.9, 106.2]],
      // Kalimantan / Borneo
      [[7.0, 116.8], [4.2, 117.9], [1.2, 118.8], [-3.4, 116.2], [-3.5, 111.8], [-1.2, 109.2], [1.9, 109.6], [4.8, 114.2]],
      // Sulawesi
      [[1.5, 125.0], [0.5, 124.0], [0.6, 120.2], [-1.8, 119.3], [-5.5, 119.5], [-5.4, 120.5], [-2.2, 121.5], [-4.8, 122.8], [-3.5, 123.2], [-1.2, 122.8], [0.2, 123.8]],
      // Papua / New Guinea
      [[-0.8, 131.2], [-2.2, 136.0], [-2.6, 140.8], [-6.2, 147.5], [-10.2, 150.5], [-9.2, 143.2], [-8.4, 138.8], [-5.2, 134.8], [-2.6, 131.8]],
      // Malay Peninsula & Mainland SE Asia & Eurasia
      [[1.3, 103.8], [7.2, 100.2], [13.5, 100.5], [10.2, 106.8], [21.5, 108.2], [23.2, 116.8], [31.2, 121.8], [38.8, 121.2], [45.0, 136.0], [55.0, 138.0], [66.0, 170.0], [70.0, 140.0], [71.0, 75.0], [69.0, 32.0], [60.0, 5.0], [48.0, -4.5], [36.0, -6.0], [38.0, 24.0], [41.0, 29.0], [32.0, 35.0], [12.8, 45.0], [25.0, 55.0], [24.8, 67.0], [8.1, 77.5], [21.8, 88.8], [16.5, 96.2], [6.5, 99.8]],
      // Philippines
      [[18.4, 120.6], [16.0, 122.0], [13.0, 124.0], [7.0, 126.4], [6.0, 124.2], [9.8, 122.4], [14.6, 120.2]],
      // Japan
      [[31.2, 130.6], [34.6, 135.5], [35.6, 140.8], [41.4, 141.2], [45.2, 141.9], [43.2, 145.5], [39.8, 139.9], [35.5, 133.2]],
      // Australia
      [[-12.4, 130.8], [-12.2, 136.8], [-16.8, 139.2], [-11.2, 142.5], [-19.2, 146.8], [-27.5, 153.2], [-33.9, 151.2], [-38.4, 145.0], [-35.2, 137.8], [-32.0, 128.0], [-34.2, 115.0], [-22.0, 114.0], [-16.5, 122.8]],
      // Africa
      [[35.8, -5.5], [37.0, 10.5], [31.5, 32.2], [11.8, 51.2], [-2.0, 41.2], [-15.0, 40.5], [-26.0, 32.8], [-34.4, 18.5], [-18.0, 12.0], [-5.0, 12.0], [4.5, 9.2], [5.2, -4.0], [14.7, -17.4], [28.0, -13.0]],
      // North America
      [[70.0, -160.0], [71.0, -95.0], [60.0, -64.0], [45.0, -61.0], [40.7, -74.0], [25.8, -80.2], [29.5, -95.0], [19.2, -96.1], [8.9, -79.5], [16.8, -99.9], [23.0, -110.0], [34.0, -118.4], [47.6, -122.4], [61.2, -149.9]],
      // South America
      [[10.5, -75.5], [10.6, -66.9], [5.0, -52.0], [-5.8, -35.2], [-22.9, -43.2], [-34.6, -58.4], [-54.8, -68.3], [-41.5, -73.0], [-18.5, -70.3], [-12.0, -77.1], [-0.2, -80.0]],
    ];
    g.save();
    for (const poly of polys) {
      g.beginPath();
      for (let i = 0; i < poly.length; i++) {
        const [x, y] = this.project(poly[i][0], poly[i][1]);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      g.fillStyle = '#244735';
      g.fill();
      g.strokeStyle = 'rgba(134, 189, 142, 0.35)';
      g.lineWidth = 1.2;
      g.stroke();
    }
    g.restore();
  }

  /** Geographic reference remains available when the imagery provider is offline. */
  private drawNavigationGrid() {
    const corners = [this.unproject(0, 0), this.unproject(this.W, 0), this.unproject(0, this.H), this.unproject(this.W, this.H)];
    const minLat = Math.min(...corners.map((p) => p[0])), maxLat = Math.max(...corners.map((p) => p[0]));
    const minLon = Math.min(...corners.map((p) => p[1])), maxLon = Math.max(...corners.map((p) => p[1]));
    const steps = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60];
    const step = steps.find((n) => n >= Math.max(maxLat - minLat, maxLon - minLon) / 6) ?? 60;
    const g = this.g;
    g.save(); g.beginPath(); g.lineWidth = 1; g.strokeStyle = 'rgba(170,196,216,.09)';
    for (let lat = Math.ceil(minLat / step) * step; lat < maxLat; lat += step) {
      const a = this.project(lat, minLon), b = this.project(lat, maxLon);
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
    }
    for (let lon = Math.ceil(minLon / step) * step; lon < maxLon; lon += step) {
      const a = this.project(minLat, lon), b = this.project(maxLat, lon);
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
    }
    g.stroke(); g.restore();
  }

  /** True-scale bar: metres per screen pixel at the map centre latitude. */
  private drawScaleBar() {
    if (!this.showScale || this.W < 220) return;
    const mPerPx = (156543.03392 * Math.cos((this.lat * Math.PI) / 180)) / 2 ** this.zoom;
    if (!isFinite(mPerPx) || mPerPx <= 0) return;
    const unit = this.scaleUnits === 'nm' ? 1852 : 1;
    const raw = Math.min(100, this.W * 0.25) * mPerPx / unit;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const nice = raw >= 5 * pow ? 5 * pow : raw >= 2 * pow ? 2 * pow : pow;
    const px = Math.max(20, nice * unit / mPerPx);
    const label = this.scaleUnits === 'nm' ? `${+nice.toFixed(2)} nm` : nice >= 1000 ? `${+(nice / 1000).toFixed(nice >= 10000 ? 0 : 1)} km` : `${Math.round(nice)} m`;
    const dark = !!styleById(this.styleId).dark;
    const g = this.g;
    const x = this.planetaryMode ? Math.max(16, this.W - 148 - px) : this.W - 14 - px;
    const y = this.planetaryMode ? this.H - 118 : this.H - 24;
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
    const g = this.g, now = Date.now();
    if (!tpl || opacity <= 0) return;
    const size = 256 * 2 ** (this.zoom - z);
    const cx = lonToTileXf(this.lon, z), cy = latToTileYf(this.lat, z);
    const rad = (Math.abs(Math.cos(this.rot)) + Math.abs(Math.sin(this.rot))) * Math.max(this.W, this.H) / 2 / size + 1, n = 2 ** z;
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
          const retryAt = imageRetryAt(url);
          if (now < retryAt) { this.nextRetry = Math.min(this.nextRetry, retryAt); continue; }
          this.requested.add(url); if (this.requested.size > 3000) this.requested.clear();
          const prio = Math.hypot(tx - cx, ty - cy) * 0.3 + prioOffset;
          loadImage(url, prio).then((image) => {
            this.requested.delete(url);
            if (this.disposed) return;
            if (image) this.invalidate();
            else this.nextRetry = Math.min(this.nextRetry, imageRetryAt(url) || Date.now() + 15_000);
          });
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
      if (this.moved > 6) { this.panBy(dx, dy); this.onViewChange?.('pan'); }
    } else if (this.pointers.size === 2) {
      p.x = x; p.y = y; const [a, b] = [...this.pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.lastPinch > 0) { this.zoomBy(Math.log2(d / this.lastPinch), (a.x + b.x) / 2, (a.y + b.y) / 2); this.onViewChange?.('zoom'); } this.lastPinch = d; this.moved = 99;
    }
    p.x = x; p.y = y;
  };
  private pu = (e: PointerEvent) => {
    const had = this.pointers.has(e.pointerId); this.pointers.delete(e.pointerId); this.lastPinch = 0;
    if (had && this.pointers.size === 0) { this.dragging = false; if (this.moved < 7) { const r = this.canvas.getBoundingClientRect(); this.onTap?.(e.clientX - r.left, e.clientY - r.top, e); } }
  };
  private wheel = (e: WheelEvent) => { if (!this.interactive) return; e.preventDefault(); const r = this.canvas.getBoundingClientRect(); this.zoomBy(-e.deltaY * 0.0016, e.clientX - r.left, e.clientY - r.top); this.onViewChange?.('zoom'); };
  private dbl = (e: MouseEvent) => { if (!this.interactive) return; const r = this.canvas.getBoundingClientRect(); this.zoomBy(1, e.clientX - r.left, e.clientY - r.top); this.onViewChange?.('zoom'); };
  panBy(dx: number, dy: number) {
    const s = 256 * 2 ** this.zoom, c = Math.cos(-this.rot), si = Math.sin(-this.rot);
    const wx = dx * c - dy * si, wy = dx * si + dy * c;
    this.lon = tileXToLon(lonToTileXf(this.lon, 0) - wx / s, 0); this.lat = clamp(tileYToLat(latToTileYf(this.lat, 0) - wy / s, 0), -84, 84); this.requestDraw();
  }
  zoomBy(dz: number, x = this.W / 2, y = this.H / 2) {
    const before = this.unproject(x, y); this.zoom = clamp(this.zoom + dz, this.minZoom, this.maxZoom);
    const after = this.unproject(x, y); this.lat = clamp(this.lat + before[0] - after[0], -84, 84); this.lon += before[1] - after[1]; this.invalidate();
  }
}
