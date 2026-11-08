// Cloud layer planning — pure maths, no WebGL (so it is unit-testable headless).
//
// Turns the LIVE report (liveWeather.ts: METAR ceiling / dew-point deck, Open-Meteo low-mid-high cover, 700 & 300 hPa
// geopotential heights, present weather) into up to four horizontal slabs that the volumetric ray-marcher fills with density.
//   0  low    : fair-weather cumulus -> stratocumulus -> stratus / nimbostratus as cover and precipitation grow
//   1  mid    : altocumulus / altostratus around the 700 hPa level
//   2  high   : cirrus / cirrostratus around the 300 hPa level (thin, ice, stretched)
//   3  storm  : cumulonimbus column from the cloud base to just under the tropopause, with an anvil (thunderstorms only)
// Heights are metres MSL (the world's Y axis).

export interface CloudLayer {
  base: number; top: number;
  /** 0..1 horizontal coverage; < 0.03 means the layer is switched off */
  cover: number;
  /** 0 low cumulus/stratus, 1 mid (alto), 2 cirrus, 3 cumulonimbus */
  kind: 0 | 1 | 2 | 3;
  /** relative extinction scale */
  density: number;
}

export interface CloudWxIn {
  cover: [number, number, number];
  lowBaseMsl: number; midBaseMsl: number; highBaseMsl: number;
  rain: number; snow: number; fog: number; thunder: boolean;
  latDeg: number; groundM: number;
}

const sstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Mean tropopause height (m): ~17 km in the tropics, ~11 km at 45°, ~8.5 km at the poles. */
export function tropopauseM(latDeg: number): number {
  return 17000 - (17000 - 8500) * sstep(10, 75, Math.abs(latDeg));
}

export const NO_LAYER: CloudLayer = { base: 0, top: 0, cover: 0, kind: 0, density: 1 };

export function planCloudLayers(w: CloudWxIn, out: CloudLayer[]): CloudLayer[] {
  while (out.length < 4) out.push({ ...NO_LAYER });
  const wet = Math.max(w.rain, w.snow);
  const low = out[0], mid = out[1], high = out[2], storm = out[3];

  // ---- low deck ----
  const c0 = Math.min(1, Math.max(0, w.cover[0]));
  if (w.fog > 0.5) {
    // fog / very low stratus hugging the ground
    Object.assign(low, { base: w.groundM + 25, top: w.groundM + 260, cover: 1, kind: 0, density: 1.1 });
  } else {
    // cumulus humilis ≈ 400-600 m deep, stratocumulus ≈ 700-900 m, nimbostratus 1.5-2.5 km deep
    // cumulus grow tall (≈ 1.0 km at 45 % cover, domed towers rather than pancakes); a full deck flattens into ≈ 900 m of stratocumulus
    let thick = 550 + 1150 * c0 * (1 - 0.55 * sstep(0.7, 1, c0));
    if (wet > 0.05) thick = Math.max(thick, 1500 + 1000 * wet);
    Object.assign(low, { base: w.lowBaseMsl, top: w.lowBaseMsl + thick, cover: c0, kind: 0, density: 1 + 0.25 * wet });
  }
  const lowTop = low.cover > 0.03 ? low.top : -1e9;

  // ---- mid deck (never intersects the low deck) ----
  const mBase = Math.max(w.midBaseMsl, lowTop + 400);
  Object.assign(mid, { base: mBase, top: mBase + 500 + 800 * w.cover[1], cover: w.cover[1] * (wet > 0.3 ? 1 : 0.9), kind: 1, density: 0.9 });

  // ---- high deck ----
  const hBase = Math.max(w.highBaseMsl, mid.top + 600);
  Object.assign(high, { base: hBase, top: hBase + 700, cover: w.cover[2], kind: 2, density: 1 });

  // ---- cumulonimbus ----
  if (w.thunder) {
    const base = Math.max(w.lowBaseMsl, w.groundM + 300);
    const top = Math.max(base + 3000, Math.min(tropopauseM(w.latDeg) - 700, base + 11000));
    Object.assign(storm, { base, top, cover: 0.5, kind: 3, density: 1.15 });
  } else Object.assign(storm, NO_LAYER);
  return out;
}

/** Share of the ray-march step budget per layer (low, mid, high, storm); the storm column gets the most when active. */
export function stepBudget(total: number, layers: CloudLayer[], out: number[]): number[] {
  const wts = [0.6, 0.14, 0.1, 0.6];
  let sum = 0;
  for (let i = 0; i < 4; i++) { wts[i] = layers[i].cover >= 0.03 ? wts[i] : 0; sum += wts[i]; }
  for (let i = 0; i < 4; i++) out[i] = sum > 0 ? Math.max(wts[i] > 0 ? 4 : 0, Math.round((total * wts[i]) / sum)) : 0;
  return out;
}
