import { AIRCRAFT, AircraftSpec, specById } from '../sim/specs';
import { AIRPORT_BY_ID, AIRPORTS, Airport } from '../data/airports';
import { bearing, haversine, M_PER_NM } from '../sim/geo';

export interface RepoFacts {
  totalAirports: number;
  indonesiaAirports: number;
  aircraftCount: number;
  engine: string;
  uiFramework: string;
  terrainSource: string;
  imagerySource: string;
  vectorSource: string;
}

export const REPO_FACTS: RepoFacts = {
  totalAirports: AIRPORTS.length,
  indonesiaAirports: AIRPORTS.filter((a) => a.country === 'ID').length,
  aircraftCount: AIRCRAFT.length,
  engine: 'Three.js WebGL 3D',
  uiFramework: 'React 19 + TypeScript 5.9',
  terrainSource: 'AWS Open Data Terrarium DEM',
  imagerySource: 'Esri World Imagery',
  vectorSource: 'OpenStreetMap & OpenFreeMap MVT',
};

export const AIRCRAFT_STUDIO_IMAGES: Record<string, string> = {
  sky: '/src/assets/images/aircraft_sky_320_1793903495799.jpg',
  trek: '/src/assets/images/aircraft_trek_turboprop_1793903495847.jpg',
  swift: '/src/assets/images/aircraft_swift_piston_1793903496888.jpg',
};

export interface MenuBentoTile {
  id: 'world_photographer' | 'challenge_league' | 'activities' | 'career' | 'free_flight' | 'marketplace';
  title: string;
  subtitle: string;
  badge?: string;
  imageUrl: string;
  action: 'planner' | 'challenge' | 'career' | 'hangar';
}

export const MENU_BENTO_TILES: MenuBentoTile[] = [
  {
    id: 'world_photographer',
    title: 'World Photographer',
    subtitle: `${AIRPORTS.length.toLocaleString()} Real Airports · ${AIRPORTS.filter((a) => a.country === 'ID').length} in Indonesia · Satellite & DEM Relief`,
    badge: 'Esri World Imagery · AWS Terrarium DEM',
    imageUrl: '/src/assets/images/menu_world_photographer_1793903487903.jpg',
    action: 'planner',
  },
  {
    id: 'challenge_league',
    title: 'Challenge League',
    subtitle: '14 km ILS Final Approach',
    imageUrl: '/src/assets/images/menu_challenge_league_1793903489548.jpg',
    action: 'challenge',
  },
  {
    id: 'activities',
    title: 'Activities',
    subtitle: '21 Curated Indonesia & World Routes',
    badge: 'ARCHIPELAGO & ALPS TOURS',
    imageUrl: '/src/assets/images/menu_activities_1793903490541.jpg',
    action: 'planner',
  },
  {
    id: 'career',
    title: 'Career',
    subtitle: 'Pilot Logbook & Flight Certifications',
    imageUrl: '/src/assets/images/menu_career_1793903492122.jpg',
    action: 'career',
  },
  {
    id: 'free_flight',
    title: 'Free Flight',
    subtitle: 'World Map & Dispatch',
    imageUrl: '/src/assets/images/menu_free_flight_1793903493342.jpg',
    action: 'planner',
  },
  {
    id: 'marketplace',
    title: 'Marketplace',
    subtitle: '3 Aircraft · 7 Liveries · Worldwide Scenery',
    imageUrl: '/src/assets/images/menu_marketplace_1793903494323.jpg',
    action: 'hangar',
  },
];

/** Converts a Web Mercator tile Y index at zoom z to geodetic latitude in degrees (-85.0511..85.0511). */
export function mercatorTileYToLatDeg(ty: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * ty) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Maps a geodetic latitude (-90..90) to a vertical pixel row (0..height) on an equirectangular texture. */
export function latDegToEquirectangularY(latDeg: number, height: number): number {
  const clamped = Math.max(-90, Math.min(90, latDeg));
  return ((90 - clamped) / 180) * height;
}

/** Converts geodetic (latDeg, lonDeg) to 3D unit-sphere coordinates matching Three.js SphereGeometry UV layout. */
export function latLonToUnitSphere(latDeg: number, lonDeg: number): [number, number, number] {
  const latRad = latDeg * (Math.PI / 180);
  const lonRad = lonDeg * (Math.PI / 180);
  return [
    Math.cos(latRad) * Math.cos(lonRad),
    Math.sin(latRad),
    -Math.cos(latRad) * Math.sin(lonRad),
  ];
}

/**
 * Computes the Three.js Euler rotation (with order 'XYZ' so R = R_x(rx) * R_y(ry))
 * that brings (latRad, lonRad) on the unit sphere to [0, 0, +1] facing the camera with North upright [0, +1, 0].
 */
export function computeGlobeEulerForLatLon(
  latRad: number,
  lonRad: number
): { rx: number; ry: number; order: 'XYZ' } {
  return {
    rx: latRad,
    ry: -lonRad - Math.PI * 0.5,
    order: 'XYZ',
  };
}

/**
 * Returns a smooth continental camera target (latDeg, lonDeg) for the initial 3D Earth menu
 * that sweeps across Eurasia, Africa, India, Southeast Asia, Indonesia, and Australia (28°E .. 122°E)
 * so the globe always faces continents and never rotates into the empty Pacific or Atlantic oceans.
 */
export function computeMenuContinentalTarget(elapsedSec: number): { latDeg: number; lonDeg: number } {
  // Smooth sinusoidal sweep with 90-second period across the Afro-Eurasian & Maritime Continent belt
  const phase = elapsedSec * 0.07;
  const lonDeg = 76.0 + Math.sin(phase) * 42.0; // Sweeps smoothly between 34°E (Africa/Europe/Middle East) and 118°E (Asia/Indonesia/Australia)
  const latDeg = 14.0 + Math.cos(phase * 0.8) * 8.0; // Gently tilts between +6°N (Indonesia/Indian Ocean rim) and +22°N (India/Arabia/East Asia)
  return { latDeg, lonDeg };
}

/** Converts (latDeg, lonDeg) to Web Mercator tile indices (tx, ty) at zoom level z. */
export function latLonToMercatorTile(
  latDeg: number,
  lonDeg: number,
  z: number
): { tx: number; ty: number; n: number } {
  const n = Math.pow(2, z);
  const clampedLat = Math.max(-85.05, Math.min(85.05, latDeg));
  const latRad = (clampedLat * Math.PI) / 180;
  const rawTx = Math.floor(((lonDeg + 180) / 360) * n);
  const tx = ((rawTx % n) + n) % n;
  const rawTy = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  const ty = Math.max(0, Math.min(n - 1, rawTy));
  return { tx, ty, n };
}

/**
 * Computes the optimal 3D globe focus point (midpoint on the unit sphere) and zoom level
 * to frame a great-circle flight route between two airports.
 */
export function computeRouteFocusView(
  dep: Airport,
  arr: Airport
): { lat: number; lon: number; zoom: number } {
  const [x1, y1, z1] = latLonToUnitSphere(dep.lat, dep.lon);
  const [x2, y2, z2] = latLonToUnitSphere(arr.lat, arr.lon);
  let mx = (x1 + x2) * 0.5;
  let my = (y1 + y2) * 0.5;
  let mz = (z1 + z2) * 0.5;
  const len = Math.hypot(mx, my, mz);
  if (len < 1e-5) {
    return { lat: dep.lat, lon: dep.lon, zoom: 1.5 };
  }
  mx /= len;
  my /= len;
  mz /= len;
  const lat = Math.asin(Math.max(-1, Math.min(1, my))) * (180 / Math.PI);
  const lon = Math.atan2(-mz, mx) * (180 / Math.PI);
  const distKm = haversine(dep.lat, dep.lon, arr.lat, arr.lon) / 1000;
  // Choose zoom so both endpoints and the great-circle path fit comfortably in the viewport
  const zoom =
    distKm < 120
      ? 11.5
      : distKm < 300
      ? 7.8
      : distKm < 650
      ? 5.2
      : distKm < 1400
      ? 3.4
      : distKm < 3000
      ? 2.1
      : 1.35;
  return { lat, lon, zoom };
}


export interface AircraftVariantInfo {
  variantId: string;
  aircraftId: string;
  title: string;
  variantLabel: string;
  liveryName: string;
  tailNumber: string;
  callSign: string;
  maker: string;
  density: string;
  surface: string;
  primaryColor: string;
  accentColor: string;
  bellyColor: string;
  imageUrl: string;
}

export const AIRCRAFT_VARIANTS: AircraftVariantInfo[] = [
  {
    variantId: 'sky-cfm-std',
    aircraftId: 'sky',
    title: 'Skyliner 320 | CFM | WF',
    variantLabel: 'Standard',
    liveryName: "Skyline Global 'Standard' PK-SKY (2026)",
    tailNumber: 'PK-SKY',
    callSign: 'SKYLINE',
    maker: 'AeroSim Works',
    density: 'Standard Density · 150 Pax',
    surface: 'Paved Runway (Asphalt / Concrete)',
    primaryColor: '#f8fafc',
    accentColor: '#2572eb',
    bellyColor: '#1e3a8a',
    imageUrl: AIRCRAFT_STUDIO_IMAGES.sky,
  },
  {
    variantId: 'sky-iae-arch',
    aircraftId: 'sky',
    title: 'Skyliner 320 | IAE | SL',
    variantLabel: 'High Density',
    liveryName: "Nusantara Trunk 'Garuda Blue' PK-NUS",
    tailNumber: 'PK-NUS',
    callSign: 'NUSANTARA',
    maker: 'AeroSim Works',
    density: 'High Density · 150 Pax',
    surface: 'Paved Runway (Asphalt / Concrete)',
    primaryColor: '#f8fafc',
    accentColor: '#0ea5e9',
    bellyColor: '#0c4a6e',
    imageUrl: AIRCRAFT_STUDIO_IMAGES.sky,
  },
  {
    variantId: 'sky-cfm-euro',
    aircraftId: 'sky',
    title: 'Skyliner 320 | CFM | SL',
    variantLabel: 'Continental',
    liveryName: "EuroJet Express 'Classic' G-EZUI",
    tailNumber: 'G-EZUI',
    callSign: 'EASY',
    maker: 'AeroSim Works',
    density: 'Single Class · 150 Pax',
    surface: 'Paved Runway (Asphalt / Concrete)',
    primaryColor: '#f8fafc',
    accentColor: '#f97316',
    bellyColor: '#334155',
    imageUrl: AIRCRAFT_STUDIO_IMAGES.sky,
  },
  {
    variantId: 'trek-pt6-stol',
    aircraftId: 'trek',
    title: 'Aero Trek T2 | PT6A | STOL',
    variantLabel: 'Standard Commuter',
    liveryName: "Pioneer Archipelago 'STOL' PK-TRK",
    tailNumber: 'PK-TRK',
    callSign: 'PIONEER',
    maker: 'Trek Aviation',
    density: 'Commuter · 12 Pax',
    surface: 'Short Field / Unpaved / Asphalt',
    primaryColor: '#f1f5f9',
    accentColor: '#ea580c',
    bellyColor: '#1e293b',
    imageUrl: AIRCRAFT_STUDIO_IMAGES.trek,
  },
  {
    variantId: 'trek-pt6-cargo',
    aircraftId: 'trek',
    title: 'Aero Trek T2 | PT6A | UTL',
    variantLabel: 'Utility / Bush',
    liveryName: "Papua Highland 'Expedition' PK-WAM",
    tailNumber: 'PK-WAM',
    callSign: 'HIGHLAND',
    maker: 'Trek Aviation',
    density: 'Combi Utility · 12 Pax',
    surface: 'Rough Strip / Mountain STOL',
    primaryColor: '#f8fafc',
    accentColor: '#10b981',
    bellyColor: '#064e3b',
    imageUrl: AIRCRAFT_STUDIO_IMAGES.trek,
  },
  {
    variantId: 'swift-io360-std',
    aircraftId: 'swift',
    title: 'Aero Swift RG | IO-360 | GA',
    variantLabel: 'Standard Trainer',
    liveryName: "AeroClub Academy 'Cobalt' PK-SWF",
    tailNumber: 'PK-SWF',
    callSign: 'SWIFT',
    maker: 'Swift Aero',
    density: 'Touring · 4 Seats',
    surface: 'All Paved & Grass Airfields',
    primaryColor: '#f8fafc',
    accentColor: '#3b82f6',
    bellyColor: '#1e3a8a',
    imageUrl: AIRCRAFT_STUDIO_IMAGES.swift,
  },
  {
    variantId: 'swift-io360-exec',
    aircraftId: 'swift',
    title: 'Aero Swift RG | IO-360 | VFR',
    variantLabel: 'Cross-Country',
    liveryName: "Pacific Coast 'Golden Hour' N402SF",
    tailNumber: 'N402SF',
    callSign: 'SIERRA',
    maker: 'Swift Aero',
    density: 'Executive · 4 Seats',
    surface: 'All Paved & Grass Airfields',
    primaryColor: '#f8fafc',
    accentColor: '#eab308',
    bellyColor: '#422006',
    imageUrl: AIRCRAFT_STUDIO_IMAGES.swift,
  },
];

export type HangarCategory = 'all' | 'piston' | 'turboprop' | 'jet';

export function filterAircraftVariants(
  category: HangarCategory,
  searchQuery: string,
  favouritesOnly = false,
  favouriteIds: string[] = []
): AircraftVariantInfo[] {
  const q = searchQuery.trim().toLowerCase();
  return AIRCRAFT_VARIANTS.filter((v) => {
    const spec = specById(v.aircraftId);
    if (category !== 'all' && spec.kind !== category) return false;
    if (favouritesOnly && !favouriteIds.includes(v.variantId)) return false;
    if (!q) return true;
    return (
      v.title.toLowerCase().includes(q) ||
      v.liveryName.toLowerCase().includes(q) ||
      v.maker.toLowerCase().includes(q) ||
      v.variantLabel.toLowerCase().includes(q) ||
      spec.name.toLowerCase().includes(q) ||
      spec.role.toLowerCase().includes(q)
    );
  });
}

export interface StatComparison {
  cruiseKt: number;
  cruiseKmh: number;
  cruiseDeltaKt: number;
  ceilingFt: number;
  ceilingDeltaFt: number;
  rangeKm: number;
  rangeNm: number;
  rangeDeltaKm: number;
  fuelCapKg: number;
  pax: number;
}

export function getAircraftStatsComparison(activeAircraftId: string, baselineAircraftId?: string): StatComparison {
  const cur = specById(activeAircraftId);
  const base = specById(baselineAircraftId || activeAircraftId);
  const ceilingFt = Math.round(cur.ceiling / 0.3048 / 100) * 100;
  const baseCeilingFt = Math.round(base.ceiling / 0.3048 / 100) * 100;
  return {
    cruiseKt: cur.cruiseKt,
    cruiseKmh: Math.round(cur.cruiseKt * 1.852),
    cruiseDeltaKt: cur.cruiseKt - base.cruiseKt,
    ceilingFt,
    ceilingDeltaFt: ceilingFt - baseCeilingFt,
    rangeKm: cur.rangeKm,
    rangeNm: Math.round((cur.rangeKm * 1000) / M_PER_NM),
    rangeDeltaKm: cur.rangeKm - base.rangeKm,
    fuelCapKg: cur.fuelCap,
    pax: cur.pax,
  };
}

export const INDONESIA_ROUTES: [string, string, string, string][] = [
  ['WIII', 'WALK', 'Jakarta to IKN Nusantara', 'Capital corridor · East Kalimantan'],
  ['WIII', 'WARC', 'Jakarta to Kediri Dhoho', 'East Java valley approach'],
  ['WADD', 'WATO', 'Bali to Labuan Bajo', 'Komodo archipelago scenic hop'],
  ['WIMM', 'WIMN', 'Medan to Silangit', 'Lake Toba volcanic caldera'],
  ['WAAA', 'WASS', 'Makassar to Sorong', 'Raja Ampat island gateway'],
  ['WIII', 'WADD', 'Jakarta to Bali', 'High-density trunk airliner route'],
  ['WIII', 'WAHI', 'Jakarta to Yogyakarta', 'Central Java heritage corridor'],
  ['WADD', 'WARR', 'Bali to Surabaya', 'Java Sea island crossing'],
  ['WADD', 'WADL', 'Bali to Lombok', 'Rinjani volcano vista approach'],
  ['WALL', 'WAAA', 'Balikpapan to Makassar', 'Makassar Strait crossing'],
  ['WIII', 'WIOK', 'Jakarta to Singkawang', 'West Kalimantan coastal hop'],
];

export const WORLD_ROUTES: [string, string, string, string][] = [
  ['KSFO', 'KLAX', 'San Francisco to Los Angeles', 'California Pacific coastline'],
  ['LSZH', 'LOWI', 'Zurich to Innsbruck', 'Challenging Inn Valley Alps approach'],
  ['EGLL', 'LFPG', 'London to Paris', 'Cross-Channel historic shuttle'],
  ['KJFK', 'KBOS', 'New York to Boston', 'New England Atlantic corridor'],
  ['RJTT', 'RJBB', 'Tokyo to Osaka', 'Mt. Fuji & Tokaido scenic flight'],
  ['YSSY', 'YMML', 'Sydney to Melbourne', 'Busiest Australian air corridor'],
  ['OMDB', 'OMAA', 'Dubai to Abu Dhabi', 'Arabian Gulf mega-hub hop'],
  ['VHHH', 'ZGSZ', 'Hong Kong to Shenzhen', 'Pearl River Delta skyline'],
  ['KDEN', 'KASE', 'Denver to Aspen', 'High-altitude Rocky Mountain runway'],
  ['SBGL', 'SBSP', 'Rio to Sao Paulo', 'Sugarloaf Bay to Congonhas urban runway'],
];

export interface CuratedRouteItem {
  fromIcao: string;
  toIcao: string;
  title: string;
  subtitle: string;
  region: 'id' | 'world';
  distanceNm: number;
  distanceKm: number;
}

export function getCuratedRoutes(filter: 'all' | 'id' | 'world', query = ''): CuratedRouteItem[] {
  const q = query.trim().toLowerCase();
  const raw: { entry: [string, string, string, string]; region: 'id' | 'world' }[] = [];
  if (filter === 'all' || filter === 'id') {
    for (const r of INDONESIA_ROUTES) raw.push({ entry: r, region: 'id' });
  }
  if (filter === 'all' || filter === 'world') {
    for (const r of WORLD_ROUTES) raw.push({ entry: r, region: 'world' });
  }
  const out: CuratedRouteItem[] = [];
  for (const { entry: [a, b, title, subtitle], region } of raw) {
    const dep = AIRPORT_BY_ID.get(a);
    const arr = AIRPORT_BY_ID.get(b);
    if (!dep || !arr) continue;
    if (
      q &&
      !a.toLowerCase().includes(q) &&
      !b.toLowerCase().includes(q) &&
      !title.toLowerCase().includes(q) &&
      !subtitle.toLowerCase().includes(q)
    ) {
      continue;
    }
    const d = haversine(dep.lat, dep.lon, arr.lat, arr.lon);
    out.push({
      fromIcao: a,
      toIcao: b,
      title,
      subtitle,
      region,
      distanceNm: Math.round(d / M_PER_NM),
      distanceKm: Math.round(d / 1000),
    });
  }
  return out;
}

export interface RouteDispatchSummary {
  distanceMeters: number;
  distanceKm: number;
  distanceNm: number;
  bearingDeg: number;
  eteMinutes: number;
  eteFormatted: string;
  fuelRequiredKg: number;
  plannedFlightLevel: number;
  maxRangeKm: number;
  inRange: boolean;
  sameAirport: boolean;
  canFly: boolean;
}

export function computeRouteDispatch(from: Airport, to: Airport, spec: AircraftSpec): RouteDispatchSummary {
  const dist = haversine(from.lat, from.lon, to.lat, to.lon);
  const brg = bearing(from.lat, from.lon, to.lat, to.lon);
  const ete = dist / (spec.cruiseKt * 0.514444) / 60 + 10;
  const km = dist / 1000;
  const nm = dist / M_PER_NM;
  const maxRangeKm = Math.round(spec.rangeKm * 0.92);
  const inRange = km <= spec.rangeKm * 0.92;
  const sameAirport = from.id === to.id;
  const canFly = inRange && !sameAirport;
  const fuelRequiredKg = Math.round((dist / 1000) * ((spec.fuelFlow * 3600) / Math.max(100, spec.cruiseKt * 1.852)) * 1.25);
  const plannedFlightLevel = spec.id === 'sky' ? 340 : spec.id === 'trek' ? 180 : 85;
  const hours = Math.floor(ete / 60);
  const mins = String(Math.round(ete % 60)).padStart(2, '0');

  return {
    distanceMeters: dist,
    distanceKm: Math.round(km),
    distanceNm: Math.round(nm),
    bearingDeg: Math.round(brg) % 360,
    eteMinutes: ete,
    eteFormatted: `${hours}h ${mins}m`,
    fuelRequiredKg,
    plannedFlightLevel,
    maxRangeKm,
    inRange,
    sameAirport,
    canFly,
  };
}

export interface ExpandedRunwayEnd {
  ident: string;
  pairIdent: string;
  lengthM: number;
  widthM: number;
  headingDeg: number;
  surface: string;
}

export function expandAirportRunways(airport: Airport): ExpandedRunwayEnd[] {
  const list: ExpandedRunwayEnd[] = [];
  for (const r of airport.runways) {
    const hdgLe = Math.round(bearing(r.leLat, r.leLon, r.heLat, r.heLon)) % 360;
    const hdgHe = (hdgLe + 180) % 360;
    const len = Math.round(r.length);
    const wid = Math.round(r.width);
    list.push({
      ident: r.le,
      pairIdent: `${r.le}/${r.he}`,
      lengthM: len,
      widthM: wid,
      headingDeg: hdgLe,
      surface: 'Asphalt',
    });
    list.push({
      ident: r.he,
      pairIdent: `${r.le}/${r.he}`,
      lengthM: len,
      widthM: wid,
      headingDeg: hdgHe,
      surface: 'Asphalt',
    });
  }
  return list;
}
