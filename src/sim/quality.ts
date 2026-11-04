import type { QualityPreset } from './storage';

/**
 * One place that owns what each graphics preset actually renders.
 *
 * The tiers are intentionally different content sets, not just "the same city with
 * fewer objects":
 *   low    – satellite terrain + airports only (no 3D world objects at all)
 *   medium – 3D compressed GLB trees only (no 3D buildings or houses)
 *   high   – buildings / ruko / industrial / towers + 3D compressed GLB trees (no landed houses)
 *   ultra  – everything: all buildings, houses, settlement infill and 3D compressed GLB trees
 *
 * Budgets are per streamed z14 tile, not global. They are deliberately small because
 * the scene rebuilds and draws several tiles in every direction.
 */
export interface QualityProfile {
  id: QualityPreset;
  label: string;
  menu: string;
  summary: string;
  /** What kind of buildings are extruded. */
  buildings: 'none' | 'major' | 'all';
  trees: boolean;
  streetLights: boolean;
  roads: boolean;
  airportDetail: boolean;
  airportDetailCount: number;
  maxAirports: number;
  /** 3D city is switched off above this AGL (m). */
  structureMaxAgl: number;
  /** Extra roof-only ring around the 3x3 core while high enough. */
  outerRing: boolean;
  clouds: number;
  buildingBudget: { full: number; roof: number; settlement: number };
  treeBudget: {
    count: number;
    maxDist: number;
    step: number;
    /** Full-detail GLB trees nearest to the camera, low-poly trees beyond. */
    fullCount: number;
    fullDist: number;
  };
  /** Terrain / structure frustum core in metres. */
  terrainCore: number;
  structureCore: number;
  pixelRatioCap: number;
  /** Lowest adaptive-resolution multiplier (relative to the cap). */
  minPixelScale: number;
  /** Hard back-buffer pixel budget, so a 4K screen cannot explode the fill rate. */
  maxPixels: number;
}

export const QUALITY: Record<QualityPreset, QualityProfile> = {
  low: {
    id: 'low',
    label: 'Low',
    menu: 'Low — Satellite only (no 3D map objects)',
    summary: 'Fastest 60 FPS mode. Pure satellite terrain, runway strips and lighting. Absolutely no 3D buildings, houses, or trees.',
    buildings: 'none',
    trees: false,
    streetLights: false,
    roads: false,
    airportDetail: false,
    airportDetailCount: 0,
    maxAirports: 3,
    structureMaxAgl: 0,
    outerRing: false,
    clouds: 14,
    buildingBudget: { full: 0, roof: 0, settlement: 0 },
    treeBudget: { count: 0, maxDist: 0, step: 0, fullCount: 0, fullDist: 0 },
    terrainCore: 1500,
    structureCore: 1200,
    pixelRatioCap: 1.0,
    minPixelScale: 0.65,
    maxPixels: 2_000_000,
  },
  medium: {
    id: 'medium',
    label: 'Medium',
    menu: 'Medium — Trees only (compressed GLB oak, no buildings)',
    summary: 'Smooth 60 FPS natural landscape. 3D compressed GLB oak trees across hills and forests. Zero 3D buildings or houses.',
    buildings: 'none',
    trees: true,
    streetLights: false,
    roads: false,
    airportDetail: false,
    airportDetailCount: 0,
    maxAirports: 4,
    structureMaxAgl: 9000,
    outerRing: false,
    clouds: 24,
    buildingBudget: { full: 0, roof: 0, settlement: 0 },
    treeBudget: { count: 850, maxDist: 3000, step: 16, fullCount: 850, fullDist: 3000 },
    terrainCore: 1800,
    structureCore: 1500,
    pixelRatioCap: 1.25,
    minPixelScale: 0.68,
    maxPixels: 3_200_000,
  },
  high: {
    id: 'high',
    label: 'High',
    menu: 'High — Buildings & trees (no landed houses)',
    summary: 'Recommended 60 FPS urban tier. Full 3D towers, offices, ruko, industrial buildings and 3D compressed GLB trees; landed houses and infill are skipped.',
    buildings: 'major',
    trees: true,
    streetLights: false,
    roads: true,
    airportDetail: true,
    airportDetailCount: 2,
    maxAirports: 6,
    structureMaxAgl: 13000,
    outerRing: false,
    clouds: 36,
    buildingBudget: { full: 600, roof: 850, settlement: 0 },
    treeBudget: { count: 850, maxDist: 3000, step: 16, fullCount: 850, fullDist: 3000 },
    terrainCore: 2500,
    structureCore: 2000,
    pixelRatioCap: 1.5,
    minPixelScale: 0.7,
    maxPixels: 4_500_000,
  },
  ultra: {
    id: 'ultra',
    label: 'Ultra',
    menu: 'Ultra — Everything (buildings + houses + trees)',
    summary: 'Maximum realistic immersion. All towers, buildings, landed houses, settlement infill, street lights, airport complexes, and dense 3D compressed GLB trees.',
    buildings: 'all',
    trees: true,
    streetLights: true,
    roads: true,
    airportDetail: true,
    airportDetailCount: 4,
    maxAirports: 8,
    structureMaxAgl: 16000,
    outerRing: false,
    clouds: 48,
    buildingBudget: { full: 900, roof: 1200, settlement: 350 },
    treeBudget: { count: 1500, maxDist: 3800, step: 14, fullCount: 1500, fullDist: 3800 },
    terrainCore: 3000,
    structureCore: 2400,
    pixelRatioCap: 1.75,
    minPixelScale: 0.75,
    maxPixels: 5_500_000,
  },
};

/** Auto keeps phones/tablets at the satellite-only tier and desktops at buildings. */
export function resolveAutoQuality(isMobile: boolean): QualityPreset {
  return isMobile ? 'low' : 'high';
}

export function qualityProfile(q: QualityPreset | 'auto', isMobile: boolean): QualityProfile {
  return QUALITY[q === 'auto' ? resolveAutoQuality(isMobile) : q];
}

/** Stable order for settings menus and docs. */
export const QUALITY_ORDER: QualityPreset[] = ['ultra', 'high', 'medium', 'low'];
