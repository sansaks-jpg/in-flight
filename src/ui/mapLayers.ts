// Persisted 2D-map layer preferences (Google-Maps-style base + overlays).
export interface MapLayers {
  roads: boolean;
  labels: boolean;
  airports: boolean;
  route: boolean;
  /** Esri hillshade relief under the raster base */
  terrain: boolean;
}

export const DEFAULT_MAP_LAYERS: MapLayers = { roads: false, labels: true, airports: true, route: true, terrain: true };
const KEY = 'skyline.maplayers.v1';

export function loadMapLayers(): MapLayers {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEFAULT_MAP_LAYERS, ...raw };
  } catch {
    return { ...DEFAULT_MAP_LAYERS };
  }
}

export function saveMapLayers(layers: MapLayers) {
  try { localStorage.setItem(KEY, JSON.stringify(layers)); } catch { /* storage unavailable */ }
}
