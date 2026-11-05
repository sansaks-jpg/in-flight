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
