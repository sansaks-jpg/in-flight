// Shared tile image cache + tile sources.
// The default is a satellite "hybrid": Esri World Imagery as the base, with Esri's
// transparent road/rail/place-label overlays composited on top. OpenStreetMap and
// other map styles remain available for the planner/moving map.
export interface TileStyle {
  id: string; name: string; url: string; maxZoom: number; attribution: string; dark?: boolean;
  /** transparent overlay with roads/railways (drawn on the 3D terrain and on the map) */
  overlayUrl?: string;
  /** transparent place/boundary labels (2D map only) */
  labelUrl?: string;
  overlayMaxZoom?: number;
  overlayOpacity?: number;
  /** draw the road overlay on the 3D terrain too (labels are baked into Esri's overlay, so this is off by default) */
  terrainOverlay?: boolean;
  /** fallback base map if the primary provider is unreachable */
  fallbackUrl?: string;
  /** true when the base is aerial/satellite imagery */
  satellite?: boolean;
  blurb?: string;
}

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const ESRI_ROADS = `${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`;
const ESRI_LABELS = `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`;
/**
 * Esri answers HTTP 200 with a grey "Map data not yet available" JPEG wherever its imagery coverage ends.
 * `blankTile=false` (documented ArcGIS map-tile parameter, verified live) makes the service answer 404 instead, so every
 * consumer (2D chart, 3D terrain, globe) can fall back to the last real parent tile instead of drawing grey squares.
 */
export const ESRI_IMAGERY_URL = `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false`;
const ESRI_ATTR = 'Imagery © Esri, Maxar, Earthstar Geographics';
// Independent overlay templates: usable on any satellite base, even without a style-provided overlay.
export const ROAD_OVERLAY_URL = ESRI_ROADS;
export const LABEL_OVERLAY_URL = ESRI_LABELS;
export const HILLSHADE_URL = `${ESRI}/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}`;
export const ROAD_MAX_ZOOM = 18;
export const LABEL_MAX_ZOOM = 18;
export const HILLSHADE_MAX_ZOOM = 13;

export const TILE_STYLES: TileStyle[] = [
  {
    id: 'hybrid', name: 'Satellite', url: ESRI_IMAGERY_URL,
    maxZoom: 18, attribution: `${ESRI_ATTR} · Overlays © Esri`, dark: true, satellite: true,
    overlayUrl: ESRI_ROADS, labelUrl: ESRI_LABELS, overlayMaxZoom: 18, overlayOpacity: 0.92,
    fallbackUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    blurb: 'Aerial imagery with optional roads, labels and airport overlays',
  },
  {
    id: 'sat', name: 'Satellite', url: ESRI_IMAGERY_URL,
    maxZoom: 18, attribution: ESRI_ATTR, dark: true, satellite: true,
    fallbackUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    blurb: 'Pure aerial imagery, no labels',
  },
  {
    id: 'relief', name: 'Aviation Chart', url: `${ESRI}/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}`,
    maxZoom: 13, attribution: ESRI_ATTR, dark: false,
    overlayUrl: ESRI_ROADS, labelUrl: ESRI_LABELS, overlayMaxZoom: 18, overlayOpacity: 0.95,
    fallbackUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    blurb: 'High-contrast topographic relief aviation chart',
  },
  {
    id: 's2cloudless', name: 'Sentinel-2 Cloudless',
    url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg',
    maxZoom: 17, attribution: 'Sentinel-2 cloudless by EOX (CC BY 4.0) · Copernicus Sentinel data',
    dark: false, satellite: true,
    overlayUrl: ESRI_ROADS, labelUrl: ESRI_LABELS, overlayMaxZoom: 18, overlayOpacity: 0.9,
    fallbackUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    blurb: 'Cloud-free ESA Sentinel-2 mosaic, free with attribution and no API key',
  },
  { id: 'osm', name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '© OpenStreetMap contributors (ODbL)', blurb: 'Classic street map' },
  { id: 'topo', name: 'Topographic', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', maxZoom: 17, attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)', blurb: 'Contours and elevation shading' },
  { id: 'dark', name: 'Night / Dark', url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', maxZoom: 19, attribution: '© OpenStreetMap contributors © CARTO', dark: true, blurb: 'Low-light chart' },
  { id: 'voyager', name: 'Light / Voyager', url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', maxZoom: 19, attribution: '© OpenStreetMap contributors © CARTO', blurb: 'Clean light chart' },
];
export const DEFAULT_TILE_STYLE = 'hybrid';
export const styleById = (id: string) => TILE_STYLES.find((s) => s.id === id) || TILE_STYLES[0];
export const ELEVATION_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export function tileUrl(tpl: string, z: number, x: number, y: number) {
  if (!isFinite(z) || !isFinite(x) || !isFinite(y)) return '';
  const n = 2 ** z;
  const xx = ((x % n) + n) % n;
  return tpl.replace('{s}', 'abc'[(xx + y) % 3]).replace('{z}', String(z)).replace('{x}', String(xx)).replace('{y}', String(y));
}

// ---- image loader with concurrency limit, de-duplication and LRU ----
type Entry = { img: HTMLImageElement | null; failed: boolean; promise: Promise<HTMLImageElement | null>; t: number; attempts: number; retryAt: number };
// A disconnected imagery provider must not turn every map/terrain frame into another request.
const RETRY_BASE_MS = 15_000, RETRY_MAX_MS = 120_000;
const cache = new Map<string, Entry>();
// Keep retry deadlines independently of raster LRU eviction. Opening/zooming a large chart
// can evict >900 failed images; eviction must not silently bypass the network backoff.
const failures = new Map<string, { attempts: number; retryAt: number }>();
const NO_IMAGE = Promise.resolve<HTMLImageElement | null>(null);
function rememberFailure(url: string, entry: Entry) {
  failures.delete(url); failures.set(url, { attempts: entry.attempts, retryAt: entry.retryAt });
  if (failures.size <= 4096) return;
  const now = Date.now();
  for (const [key, failure] of failures) {
    if (failure.retryAt <= now && key !== url) failures.delete(key);
    if (failures.size <= 3072) break;
  }
  while (failures.size > 4096) failures.delete(failures.keys().next().value!);
}
const queue: { url: string; start: () => void; cancel: () => void; prio: number }[] = [];
let active = 0;
const MAX_ACTIVE = 10;
let clock = 0;

function pump() {
  if (active < MAX_ACTIVE && queue.length > 1) {
    queue.sort((a, b) => a.prio - b.prio);
  }
  while (active < MAX_ACTIVE && queue.length) {
    queue.shift()!.start();
  }
}
export function loadImage(url: string, prio = 5): Promise<HTMLImageElement | null> {
  if (!url || url.includes('NaN')) return NO_IMAGE;
  const failure = failures.get(url);
  if (failure && Date.now() < failure.retryAt) return NO_IMAGE;
  const hit = cache.get(url);
  if (hit && (!hit.failed || Date.now() < hit.retryAt)) { hit.t = ++clock; return hit.promise; }
  let entry: Entry;
  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const start = () => {
      active++;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      let settled = false;
      const timeout = setTimeout(() => finish(false), 12_000);
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); img.onload = img.onerror = null; active--;
        if (ok) { entry.img = img; entry.retryAt = 0; failures.delete(url); }
        else {
          entry.failed = true;
          entry.retryAt = Date.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(4, entry.attempts - 1));
          rememberFailure(url, entry);
          img.src = ''; // Release a hung network request, not just its concurrency slot.
        }
        resolve(ok ? img : null); pump();
      };
      // Decode off the main thread BEFORE the image is handed out, so the first drawImage()/texImage2D() never stalls a frame.
      // Once the bytes have arrived the request is a success: the 12 s watchdog must not fire while a busy main thread is still
      // decoding (that used to turn a delivered DEM tile into a "failure" and, with it, into random synthetic terrain).
      img.onload = () => {
        clearTimeout(timeout);
        if (typeof img.decode !== 'function') { finish(true); return; }
        const guard = setTimeout(() => finish(true), 4000);
        img.decode().then(() => { clearTimeout(guard); finish(true); }, () => { clearTimeout(guard); finish(true); });
      };
      img.onerror = () => finish(false);
      img.src = url;
    };
    queue.push({ url, start, cancel: () => resolve(null), prio });
  });
  entry = { img: null, failed: false, promise, t: ++clock, attempts: Math.max(hit?.attempts ?? 0, failure?.attempts ?? 0) + 1, retryAt: 0 };
  cache.set(url, entry);
  if (cache.size > 2400) {
    const old = [...cache.entries()].filter(([, e]) => e.img || e.failed).sort((a, b) => a[1].t - b[1].t).slice(0, 400);
    old.forEach(([k]) => cache.delete(k));
  }
  pump();
  return promise;
}
/** Earliest retry after a failed request; zero means an image may be requested now. */
export function imageRetryAt(url: string): number { return failures.get(url)?.retryAt ?? cache.get(url)?.retryAt ?? 0; }

/** Synchronously peek at an already loaded image (used by the canvas map). */
export function peekImage(url: string): HTMLImageElement | null {
  const e = cache.get(url);
  if (e && e.img) { e.t = ++clock; return e.img; }
  return null;
}
export function bumpPriority(url: string, prio: number) {
  const q = queue.find((i) => i.url === url);
  if (q) q.prio = prio;
}
export function cancelQueued(pred: (url: string) => boolean) {
  for (let i = queue.length - 1; i >= 0; i--) if (pred(queue[i].url)) { const q = queue.splice(i, 1)[0]; cache.delete(q.url); q.cancel(); }
}
