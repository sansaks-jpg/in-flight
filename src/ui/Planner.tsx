import { useMemo, useState } from 'react';
import { AIRCRAFT } from '../sim/specs';
import { AIRPORT_BY_ID, Airport, searchAirports } from '../data/airports';
import { MapPanel } from './MapPanel';
import { Settings } from '../sim/storage';
import { TILE_STYLES, styleById } from '../sim/tiles';
import { bearing, haversine, M_PER_NM } from '../sim/geo';

interface Props {
  settings: Settings;
  setSettings: (s: Settings) => void;
  aircraftId: string;
  setAircraft: (id: string) => void;
  from: Airport;
  to: Airport;
  setFrom: (a: Airport) => void;
  setTo: (a: Airport) => void;
  onFly: () => void;
  onBack: () => void;
}

const INDONESIA_ROUTES: [string, string, string, string][] = [
  ['WIII', 'WALK', 'Jakarta → IKN Nusantara', 'Capital corridor · East Kalimantan'],
  ['WIII', 'WARC', 'Jakarta → Kediri Dhoho', 'East Java valley approach'],
  ['WADD', 'WATO', 'Bali → Labuan Bajo', 'Komodo archipelago scenic hop'],
  ['WIMM', 'WIMN', 'Medan → Silangit', 'Lake Toba volcanic caldera'],
  ['WAAA', 'WASS', 'Makassar → Sorong', 'Raja Ampat island gateway'],
  ['WIII', 'WADD', 'Jakarta → Bali', 'High-density trunk airliner route'],
  ['WIII', 'WAHI', 'Jakarta → Yogyakarta', 'Central Java heritage corridor'],
  ['WADD', 'WARR', 'Bali → Surabaya', 'Java Sea island crossing'],
  ['WADD', 'WADL', 'Bali → Lombok', 'Rinjani volcano vista approach'],
  ['WALL', 'WAAA', 'Balikpapan → Makassar', 'Makassar Strait crossing'],
  ['WIII', 'WIOK', 'Jakarta → Singkawang', 'West Kalimantan coastal hop'],
];

const WORLD_ROUTES: [string, string, string, string][] = [
  ['KSFO', 'KLAX', 'San Francisco → Los Angeles', 'California Pacific coastline'],
  ['LSZH', 'LOWI', 'Zurich → Innsbruck', 'Challenging Inn Valley Alps approach'],
  ['EGLL', 'LFPG', 'London → Paris', 'Cross-Channel historic shuttle'],
  ['KJFK', 'KBOS', 'New York → Boston', 'New England Atlantic corridor'],
  ['RJTT', 'RJBB', 'Tokyo → Osaka', 'Mt. Fuji & Tokaido scenic flight'],
  ['YSSY', 'YMML', 'Sydney → Melbourne', 'Busiest Australian air corridor'],
  ['OMDB', 'OMAA', 'Dubai → Abu Dhabi', 'Arabian Gulf mega-hub hop'],
  ['VHHH', 'ZGSZ', 'Hong Kong → Shenzhen', 'Pearl River Delta skyline'],
  ['KDEN', 'KASE', 'Denver → Aspen', 'High-altitude Rocky Mountain runway'],
  ['SBGL', 'SBSP', 'Rio → São Paulo', 'Sugarloaf Bay to Congonhas urban runway'],
];

function AirportField({
  label,
  badge,
  color,
  value,
  onSelect,
  active,
  onFocus,
}: {
  label: string;
  badge: string;
  color: string;
  value: Airport;
  onSelect: (a: Airport) => void;
  active: boolean;
  onFocus: () => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const res = useMemo(() => (open ? searchAirports(q, 8) : []), [q, open]);
  const longestRwy = value.runways.reduce((m, r) => (r.length > m.length ? r : m), value.runways[0] || { length: 0, le: '--', he: '--' });

  return (
    <div className="relative">
      <div
        className={`flex items-center gap-3 rounded-xl border p-2.5 transition cursor-pointer ${
          active ? 'border-cyan-400/80 bg-cyan-950/40 shadow-[0_0_15px_rgba(34,211,238,0.2)]' : 'border-white/10 bg-slate-900/60 hover:border-white/20'
        }`}
        onClick={onFocus}
      >
        <div className="w-1.5 h-11 rounded-full shrink-0" style={{ background: color }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1 text-[10px] uppercase font-bold tracking-widest text-slate-400">
            <span>{label}</span>
            <span className="px-1.5 py-0.2 rounded text-[9px] font-black tracking-wider" style={{ background: `${color}25`, color }}>
              {badge}
            </span>
          </div>
          <div className="flex items-baseline gap-2 mt-0.5">
            <span className="font-mono text-base font-black text-white">{value.icao}</span>
            {value.iata && <span className="font-mono text-xs text-cyan-300 font-bold">({value.iata})</span>}
            <span className="text-xs text-slate-300 truncate font-semibold">{value.name}</span>
          </div>
          <input
            value={open ? q : `${value.city}, ${value.country} · ${Math.round(value.elev / 0.3048).toLocaleString()} ft · RWY ${longestRwy.le}/${longestRwy.he} (${Math.round(longestRwy.length)}m)`}
            onFocus={(e) => {
              setOpen(true);
              setQ('');
              onFocus();
              e.currentTarget.select();
            }}
            onBlur={() => setTimeout(() => setOpen(false), 200)}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search airport, city, ICAO or IATA..."
            className="w-full bg-transparent outline-none text-[11px] text-slate-400 truncate placeholder:text-slate-500 font-medium"
          />
        </div>
      </div>

      {open && res.length > 0 && (
        <div className="absolute z-40 left-0 right-0 mt-1.5 rounded-xl overflow-hidden bg-slate-950/98 border border-white/20 shadow-2xl max-h-72 overflow-y-auto backdrop-blur-md">
          {res.map((a) => (
            <button
              key={a.id}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(a);
                setOpen(false);
              }}
              className="w-full text-left px-3.5 py-2.5 hover:bg-cyan-500/15 border-b border-white/5 last:border-0 flex items-center justify-between gap-2 transition"
            >
              <div className="min-w-0">
                <div className="text-sm font-bold text-white flex items-center gap-2">
                  <span className="font-mono text-cyan-300">{a.icao}</span>
                  {a.iata && <span className="text-xs text-slate-400">({a.iata})</span>}
                  <span className="truncate">{a.name}</span>
                </div>
                <div className="text-[11px] text-slate-400 truncate">
                  {a.city}, {a.country} · {Math.round(a.elev / 0.3048).toLocaleString()} ft elevation
                </div>
              </div>
              <div className="text-[10px] font-mono text-slate-400 shrink-0 text-right">
                {a.runways.length} rwy
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const Seg = <T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) => (
  <div className="flex rounded-lg bg-slate-900/80 p-0.5 border border-white/10">
    {options.map(([v, l]) => (
      <button
        key={v}
        onClick={() => onChange(v)}
        className={`flex-1 px-2.5 py-1.5 text-xs font-semibold rounded-md transition ${
          v === value ? 'bg-cyan-400 text-slate-950 shadow-sm font-bold' : 'text-slate-400 hover:text-white'
        }`}
      >
        {l}
      </button>
    ))}
  </div>
);

const Bar = ({ v, c }: { v: number; c: string }) => (
  <div className="h-1.5 rounded-full bg-white/10 overflow-hidden mt-1">
    <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, Math.round(v * 100))}%`, background: c }} />
  </div>
);

export function Planner({ settings, setSettings, aircraftId, setAircraft, from, to, setFrom, setTo, onFly, onBack }: Props) {
  const [picking, setPicking] = useState<'from' | 'to'>('to');
  const [tab, setTab] = useState<'aircraft' | 'route' | 'conditions' | 'map'>('route');
  const [routeFilter, setRouteFilter] = useState<'all' | 'id' | 'world'>('all');

  const spec = AIRCRAFT.find((a) => a.id === aircraftId)!;
  const dist = haversine(from.lat, from.lon, to.lat, to.lon);
  const brg = bearing(from.lat, from.lon, to.lat, to.lon);
  const ete = (dist / (spec.cruiseKt * 0.514444)) / 60 + 10;
  const km = dist / 1000;
  const nm = dist / M_PER_NM;
  const inRange = km <= spec.rangeKm * 0.92;
  const same = from.id === to.id;
  const canFly = inRange && !same;

  const set = (p: Partial<Settings>) => setSettings({ ...settings, ...p });
  const pick = (a: Airport) => {
    if (picking === 'from') {
      setFrom(a);
      setPicking('to');
    } else {
      setTo(a);
    }
  };

  const startOpts: [Settings['startMode'], string][] = [
    ['runway', 'Runway (T/O)'],
    ['cruise', 'Cruise (Airborne)'],
    ['final', 'Final (14km)'],
  ];

  const fuelRequiredKg = Math.round((dist / 1000) * (spec.fuelFlow * 3600 / Math.max(100, spec.cruiseKt * 1.852)) * 1.25);
  const plannedFL = spec.id === 'sky' ? 340 : spec.id === 'trek' ? 180 : 85;

  return (
    <div className="absolute inset-0 flex flex-col bg-slate-950 text-white select-none overflow-hidden font-sans">
      {/* MSFS Top Global Flight Header */}
      <header className="h-16 shrink-0 border-b border-white/10 bg-slate-950/90 backdrop-blur-md px-4 sm:px-6 flex items-center justify-between z-30">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="w-10 h-10 rounded-xl bg-white/5 hover:bg-white/15 border border-white/10 grid place-items-center transition active:scale-95"
            aria-label="Back to Main Menu"
            title="Back to Main Menu"
          >
            ←
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] tracking-[0.3em] font-black text-cyan-400">WORLD MAP &amp; FLIGHT PLANNER</span>
              <span className="hidden sm:inline-block px-1.5 py-0.5 rounded text-[9px] font-black bg-cyan-400/15 text-cyan-300 border border-cyan-400/30">
                MSFS VFR/IFR
              </span>
            </div>
            <div className="text-sm font-extrabold tracking-tight text-slate-100 flex items-center gap-2">
              <span>{spec.name}</span>
              <span className="text-slate-500">·</span>
              <span className="text-emerald-400 font-mono">{from.icao}</span>
              <span className="text-slate-400">→</span>
              <span className="text-amber-400 font-mono">{to.icao}</span>
            </div>
          </div>
        </div>

        {/* Top Route Quick Metrics */}
        <div className="hidden md:flex items-center gap-6 text-xs">
          <div className="text-right">
            <div className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Total Distance</div>
            <div className="font-mono font-black text-white">{Math.round(nm).toLocaleString()} <span className="text-slate-400 text-[10px]">NM</span> · {Math.round(km).toLocaleString()} <span className="text-slate-400 text-[10px]">KM</span></div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Flight Level</div>
            <div className="font-mono font-black text-cyan-300">FL{plannedFL} <span className="text-slate-400 text-[10px]">({plannedFL * 100} ft)</span></div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Est. Enroute</div>
            <div className="font-mono font-black text-emerald-300">{Math.floor(ete / 60)}h {String(Math.round(ete % 60)).padStart(2, '0')}m</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Track Bearing</div>
            <div className="font-mono font-black text-amber-300">{String(Math.round(brg)).padStart(3, '0')}° MAG</div>
          </div>
        </div>

        {/* Quick Launch CTA Button in Header */}
        <div className="flex items-center gap-2">
          <button
            disabled={!canFly}
            onClick={onFly}
            className="px-5 py-2.5 rounded-xl font-black text-xs tracking-widest text-slate-950 bg-gradient-to-r from-cyan-300 via-emerald-300 to-amber-200 hover:brightness-110 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_0_25px_rgba(34,211,238,0.35)] transition"
          >
            ✈ FLY NOW
          </button>
        </div>
      </header>

      {/* Main Body: Sidebar Drawer + Full Interactive Map */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0 relative">
        {/* Left Flight Briefing Sidebar */}
        <aside className="lg:w-[440px] xl:w-[480px] shrink-0 flex flex-col min-h-0 border-b lg:border-b-0 lg:border-r border-white/10 bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 z-20 order-2 lg:order-1 flex-1 lg:flex-none">
          {/* Navigation Tabs */}
          <div className="flex border-b border-white/10 text-xs font-bold bg-slate-950/60">
            {(
              [
                ['route', '🗺️ ROUTE'],
                ['aircraft', '✈️ HANGAR'],
                ['conditions', '⛅ FLIGHT OPS'],
                ['map', '🌍 MAP VIEW'],
              ] as const
            ).map(([t, l]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-3 text-center transition tracking-wider ${
                  tab === t
                    ? 'text-cyan-300 border-b-2 border-cyan-400 bg-cyan-400/5 font-black'
                    : 'text-slate-400 hover:text-slate-200'
                } ${t === 'map' ? 'lg:hidden' : ''}`}
              >
                {l}
              </button>
            ))}
          </div>

          {/* Drawer Content */}
          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {/* TAB: ROUTE & NAVLOG */}
            <div className={`${tab === 'route' ? 'space-y-4' : 'hidden'}`}>
              <div>
                <h3 className="text-[11px] uppercase tracking-widest text-slate-400 font-bold mb-2 flex items-center justify-between">
                  <span>Airport Waypoints</span>
                  <span className="text-[10px] text-cyan-300">Click map to inspect</span>
                </h3>
                <div className="space-y-2">
                  <AirportField
                    label="Departure (Origin)"
                    badge="DEP"
                    color="#3ddc84"
                    value={from}
                    onSelect={(a) => {
                      setFrom(a);
                      setPicking('to');
                    }}
                    active={picking === 'from'}
                    onFocus={() => setPicking('from')}
                  />
                  <div className="flex justify-center -my-1 relative z-10">
                    <button
                      onClick={() => {
                        const f = from;
                        setFrom(to);
                        setTo(f);
                      }}
                      className="px-3.5 py-1 text-xs rounded-full bg-slate-800 border border-white/15 hover:bg-cyan-500/20 hover:border-cyan-400/40 text-slate-300 hover:text-white transition flex items-center gap-1.5 shadow"
                      title="Swap Departure and Destination"
                    >
                      <span className="text-cyan-400 font-bold">⇄</span> Swap Route
                    </button>
                  </div>
                  <AirportField
                    label="Destination (Arrival)"
                    badge="ARR"
                    color="#ffb02e"
                    value={to}
                    onSelect={setTo}
                    active={picking === 'to'}
                    onFocus={() => setPicking('to')}
                  />
                </div>
              </div>

              {/* Route Clearance & Flight Performance Card */}
              <div
                className={`rounded-2xl p-3.5 border transition ${
                  canFly ? 'border-emerald-500/30 bg-emerald-950/20' : 'border-rose-500/40 bg-rose-950/25'
                }`}
              >
                {same ? (
                  <div className="text-rose-300 text-xs font-semibold py-1">
                    Departure and destination airports cannot be the same. Select a different airport.
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between text-xs pb-2 border-b border-white/10">
                      <span className="font-bold text-slate-300">ROUTE DISPATCH CLEARANCE</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-black ${canFly ? 'bg-emerald-400/20 text-emerald-300 border border-emerald-400/30' : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'}`}>
                        {canFly ? '✓ DISPATCH CLEARED' : '⚠ RANGE EXCEEDED'}
                      </span>
                    </div>

                    <div className="grid grid-cols-4 gap-2 pt-3 text-center">
                      <div>
                        <div className="text-lg font-black font-mono text-white">{Math.round(nm).toLocaleString()}</div>
                        <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Distance (nm)</div>
                      </div>
                      <div>
                        <div className="text-lg font-black font-mono text-cyan-300">{String(Math.round(brg)).padStart(3, '0')}°</div>
                        <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Track Mag</div>
                      </div>
                      <div>
                        <div className="text-lg font-black font-mono text-emerald-300">{Math.floor(ete / 60)}:{String(Math.round(ete % 60)).padStart(2, '0')}</div>
                        <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">ETE Enroute</div>
                      </div>
                      <div>
                        <div className="text-lg font-black font-mono text-amber-300">{fuelRequiredKg}</div>
                        <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Fuel (kg)</div>
                      </div>
                    </div>

                    {!inRange && (
                      <div className="mt-3 text-rose-300 text-xs leading-relaxed bg-rose-950/40 p-2.5 rounded-xl border border-rose-500/30">
                        Route distance ({Math.round(km)} km) exceeds the {spec.name}’s maximum range ({Math.round(spec.rangeKm * 0.92)} km). Please choose a closer airport or switch to the <b>Skyliner 320</b>.
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Route Elevation Profile Cross-Section */}
              <div className="rounded-2xl p-3.5 border border-white/10 bg-slate-900/60 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-slate-300 uppercase tracking-wider text-[10px]">Vertical Flight Profile</span>
                  <span className="text-[10px] font-mono text-cyan-300">Cruise: FL{plannedFL} ({plannedFL * 100} ft)</span>
                </div>
                {/* SVG Visual Cross-section */}
                <div className="h-20 w-full rounded-xl bg-slate-950/80 border border-white/5 relative overflow-hidden flex items-end px-3 pb-2">
                  <svg className="w-full h-full absolute inset-0" preserveAspectRatio="none" viewBox="0 0 300 80">
                    <defs>
                      <linearGradient id="flightPathGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="#3ddc84" />
                        <stop offset="25%" stopColor="#38bdf8" />
                        <stop offset="75%" stopColor="#38bdf8" />
                        <stop offset="100%" stopColor="#ffb02e" />
                      </linearGradient>
                      <linearGradient id="terrainGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" stopColor="rgba(100,116,139,0.35)" />
                        <stop offset="100%" stopColor="rgba(30,41,59,0.8)" />
                      </linearGradient>
                    </defs>
                    {/* Simulated Terrain Profile */}
                    <path
                      d="M 0 75 Q 40 68, 70 72 T 140 64 T 210 69 T 270 73 L 300 76 L 300 80 L 0 80 Z"
                      fill="url(#terrainGrad)"
                    />
                    {/* Waypoint Flight Level Arc */}
                    <path
                      d="M 10 74 L 55 24 L 235 24 L 290 75"
                      fill="none"
                      stroke="url(#flightPathGrad)"
                      strokeWidth="2.5"
                      strokeDasharray="4 2"
                    />
                    {/* Waypoint Dots */}
                    <circle cx="10" cy="74" r="3.5" fill="#3ddc84" />
                    <circle cx="55" cy="24" r="3" fill="#38bdf8" />
                    <circle cx="235" cy="24" r="3" fill="#f43f5e" />
                    <circle cx="290" cy="75" r="3.5" fill="#ffb02e" />
                  </svg>
                  <div className="relative z-10 w-full flex justify-between text-[9px] font-mono text-slate-400">
                    <span>DEP {from.icao}</span>
                    <span>CLIMB</span>
                    <span className="text-cyan-300 font-bold">CRUISE FL{plannedFL}</span>
                    <span>TOD</span>
                    <span>ARR {to.icao}</span>
                  </div>
                </div>
              </div>

              {/* Curated Routes Section */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">Curated Routes</h3>
                  <div className="flex gap-1 text-[10px]">
                    {(['all', 'id', 'world'] as const).map((cat) => (
                      <button
                        key={cat}
                        onClick={() => setRouteFilter(cat)}
                        className={`px-2 py-0.5 rounded-full capitalize font-semibold transition ${
                          routeFilter === cat ? 'bg-cyan-400 text-slate-950 font-bold' : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        {cat === 'all' ? 'All' : cat === 'id' ? 'Indonesia' : 'World'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-1.5 max-h-48 overflow-y-auto pr-1">
                  {(routeFilter === 'all' || routeFilter === 'id' ? INDONESIA_ROUTES : [])
                    .concat(routeFilter === 'all' || routeFilter === 'world' ? WORLD_ROUTES : [])
                    .filter(([a, b]) => AIRPORT_BY_ID.has(a) && AIRPORT_BY_ID.has(b))
                    .map(([a, b, title, desc]) => {
                      const isSel = from.icao === a && to.icao === b;
                      return (
                        <button
                          key={a + b}
                          onClick={() => {
                            setFrom(AIRPORT_BY_ID.get(a)!);
                            setTo(AIRPORT_BY_ID.get(b)!);
                          }}
                          className={`text-left px-3 py-2 rounded-xl border transition flex items-center justify-between gap-2 ${
                            isSel
                              ? 'border-cyan-400 bg-cyan-950/40 text-white'
                              : 'border-white/5 bg-slate-900/40 hover:bg-slate-800/60 text-slate-300'
                          }`}
                        >
                          <div>
                            <div className="text-xs font-bold text-white flex items-center gap-1.5">
                              <span className="text-cyan-300 font-mono">{a}</span>
                              <span className="text-slate-500">→</span>
                              <span className="text-amber-300 font-mono">{b}</span>
                              <span className="ml-1 text-[11px] text-slate-200">{title}</span>
                            </div>
                            <div className="text-[10px] text-slate-400">{desc}</div>
                          </div>
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 border border-white/10 shrink-0 font-mono">
                            {Math.round(haversine(AIRPORT_BY_ID.get(a)!.lat, AIRPORT_BY_ID.get(a)!.lon, AIRPORT_BY_ID.get(b)!.lat, AIRPORT_BY_ID.get(b)!.lon) / M_PER_NM)} nm
                          </span>
                        </button>
                      );
                    })}
                </div>
              </div>
            </div>

            {/* TAB: AIRCRAFT HANGAR */}
            <div className={`${tab === 'aircraft' ? 'space-y-4' : 'hidden'}`}>
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">Fleet Selection</h3>
                <span className="text-[10px] text-cyan-300 font-bold">Range ring active on map</span>
              </div>

              <div className="grid gap-3">
                {AIRCRAFT.map((a) => {
                  const isSel = a.id === aircraftId;
                  return (
                    <button
                      key={a.id}
                      onClick={() => setAircraft(a.id)}
                      className={`text-left rounded-2xl border p-3.5 transition relative overflow-hidden ${
                        isSel
                          ? 'border-cyan-400 bg-gradient-to-br from-cyan-950/60 via-slate-900 to-slate-950 shadow-[0_0_20px_rgba(34,211,238,0.25)]'
                          : 'border-white/10 bg-slate-900/50 hover:bg-slate-900/80 hover:border-white/20'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <svg
                            viewBox="0 0 64 40"
                            className="w-16 h-10 shrink-0"
                            fill="none"
                            stroke={isSel ? '#38bdf8' : '#94a3b8'}
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            {a.id === 'sky' ? (
                              <path d="M4 20 L50 18 Q60 20 50 22 L4 22 M22 20 L34 4 L38 4 L32 20 M22 22 L34 36 L38 36 L32 22 M6 20 L2 10 L8 10 L12 20" />
                            ) : a.id === 'trek' ? (
                              <path d="M6 20 L52 19 Q60 20.5 52 22 L6 22 M18 17 L48 17 M20 8 L30 8 L28 19 M20 32 L30 32 L28 22 M6 20 L3 12 L9 12 L12 19" />
                            ) : (
                              <path d="M8 20 L48 19 Q56 20.5 48 22 L8 22 M20 16 L40 16 M22 8 L32 8 L28 19 M22 32 L32 32 L28 22 M8 20 L5 13 L11 13 L14 19 M52 12 L52 28" />
                            )}
                          </svg>
                          <div>
                            <div className="font-extrabold text-base text-white">{a.name}</div>
                            <div className="text-[11px] text-cyan-300 font-semibold">{a.role}</div>
                          </div>
                        </div>

                        <span
                          className={`text-[9px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider ${
                            a.id === 'swift'
                              ? 'bg-emerald-400/20 text-emerald-300 border border-emerald-400/30'
                              : a.id === 'trek'
                              ? 'bg-cyan-400/20 text-cyan-300 border border-cyan-400/30'
                              : 'bg-amber-400/20 text-amber-300 border border-amber-400/30'
                          }`}
                        >
                          {a.id === 'swift' ? 'TRAINER' : a.id === 'trek' ? 'COMMUTER' : 'AIRLINER'}
                        </span>
                      </div>

                      <p className="text-xs text-slate-300 mt-2.5 leading-relaxed">{a.blurb}</p>

                      <div className="grid grid-cols-3 gap-3 mt-3 pt-3 border-t border-white/5 text-[10px] text-slate-300">
                        <div>
                          <span className="text-slate-400 block text-[9px] uppercase tracking-wider">Cruise Speed</span>
                          <span className="font-mono font-bold text-white text-xs">{a.cruiseKt} kt</span>
                          <Bar v={a.cruiseKt / 480} c="#38bdf8" />
                        </div>
                        <div>
                          <span className="text-slate-400 block text-[9px] uppercase tracking-wider">Flight Range</span>
                          <span className="font-mono font-bold text-white text-xs">{a.rangeKm.toLocaleString()} km</span>
                          <Bar v={a.rangeKm / 5000} c="#34d399" />
                        </div>
                        <div>
                          <span className="text-slate-400 block text-[9px] uppercase tracking-wider">Payload / Pax</span>
                          <span className="font-mono font-bold text-white text-xs">{a.pax} seats</span>
                          <Bar v={a.pax / 150} c="#fbbf24" />
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* TAB: CONDITIONS & FLIGHT OPS */}
            <div className={`${tab === 'conditions' ? 'space-y-4' : 'hidden'}`}>
              <h3 className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">Flight Operations &amp; Atmosphere</h3>

              <div className="space-y-3.5">
                <div>
                  <div className="text-xs text-slate-300 font-semibold mb-1.5">Departure Position</div>
                  <Seg value={settings.startMode} options={startOpts} onChange={(v) => set({ startMode: v })} />
                  <div className="text-[11px] text-slate-400 mt-1.5 leading-relaxed bg-white/5 p-2 rounded-lg">
                    {settings.startMode === 'runway'
                      ? 'Parked on the runway threshold — full takeoff roll, climbout and navigation to touchdown.'
                      : settings.startMode === 'cruise'
                      ? 'Spawn airborne at cruising altitude with active autopilot tracking route.'
                      : 'Established on a 14 km final approach to destination runway — practice ILS precision landing.'}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs text-slate-300 font-semibold mb-1">Time of Day</div>
                    <Seg
                      value={settings.tod}
                      options={[
                        ['day', 'Daylight'],
                        ['sunset', 'Golden Hr'],
                      ]}
                      onChange={(v) => set({ tod: v })}
                    />
                  </div>
                  <div>
                    <div className="text-xs text-slate-300 font-semibold mb-1">Wind Conditions</div>
                    <Seg
                      value={settings.wind}
                      options={[
                        ['calm', 'Calm'],
                        ['light', 'Light'],
                        ['strong', 'Gusty'],
                      ]}
                      onChange={(v) => set({ wind: v })}
                    />
                  </div>
                  <div>
                    <div className="text-xs text-slate-300 font-semibold mb-1">Cloud Coverage</div>
                    <Seg
                      value={settings.weather}
                      options={[
                        ['clear', 'Clear'],
                        ['scattered', 'Scattered'],
                        ['overcast', 'Overcast'],
                      ]}
                      onChange={(v) => set({ weather: v })}
                    />
                  </div>
                  <div>
                    <div className="text-xs text-slate-300 font-semibold mb-1">Flight Dynamics</div>
                    <Seg
                      value={settings.assist ? 'a' : 'r'}
                      options={[
                        ['a', 'Assisted'],
                        ['r', 'Realistic'],
                      ]}
                      onChange={(v) => set({ assist: v === 'a' })}
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between text-xs text-slate-300 font-semibold mb-1">
                    <span>3D Terrain &amp; Satellite Imagery</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-400/20 text-cyan-300 font-bold">AWS DEM 3D</span>
                  </div>
                  <select
                    value={settings.terrainStyle}
                    onChange={(e) => set({ terrainStyle: e.target.value })}
                    className="w-full rounded-xl bg-slate-900 border border-white/15 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                  >
                    {TILE_STYLES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <div className="text-[11px] text-slate-400 mt-1">
                    {styleById(settings.terrainStyle).blurb} · real elevation relief, coastal bathymetry and building footprints.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Dispatch Footer */}
          <div className="p-4 border-t border-white/10 bg-slate-950/90 backdrop-blur-md">
            <button
              disabled={!canFly}
              onClick={onFly}
              className="w-full py-3.5 rounded-xl font-black text-sm tracking-widest text-slate-950 bg-gradient-to-r from-cyan-300 via-emerald-300 to-amber-200 disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 active:scale-[0.99] transition shadow-[0_0_35px_rgba(34,211,238,0.4)] flex items-center justify-center gap-2"
            >
              <span>✈ COMMENCE FLIGHT</span>
              <span className="font-mono text-xs opacity-80">
                ({from.iata || from.icao} → {to.iata || to.icao})
              </span>
            </button>
            <div className="mt-2 text-center text-[11px] text-slate-400 font-medium">
              Flight mode: <b className="text-white">{settings.startMode.toUpperCase()}</b> · Wind:{' '}
              <b className="text-white">{settings.wind.toUpperCase()}</b> · Weather:{' '}
              <b className="text-white">{settings.weather.toUpperCase()}</b>
            </div>
          </div>
        </aside>

        {/* Right Interactive World Map Area */}
        <main className={`order-1 lg:order-2 lg:flex-1 min-w-0 relative ${tab === 'map' ? 'flex-1' : 'h-[36vh]'} lg:h-auto`}>
          <MapPanel
            mode="planner"
            from={from}
            to={to}
            picking={picking}
            onPick={pick}
            rangeKm={spec.rangeKm}
            onSetAirport={(a, role) => {
              if (role === 'from') {
                setFrom(a);
                setPicking('to');
              } else {
                setTo(a);
              }
            }}
            styleId={settings.mapStyle}
            onStyle={(id) => set({ mapStyle: id })}
            className="absolute inset-0"
          />

          {/* Quick Origin/Destination Pin Switcher floating on map */}
          <div className="absolute top-4 right-4 hidden sm:flex rounded-full bg-slate-950/85 border border-white/20 p-0.5 text-xs font-bold shadow-xl backdrop-blur-md z-20">
            <button
              onClick={() => setPicking('from')}
              className={`px-3.5 py-1.5 rounded-full transition flex items-center gap-1.5 ${
                picking === 'from' ? 'bg-emerald-400 text-slate-950 shadow' : 'text-slate-300 hover:text-white'
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span>Set Departure</span>
            </button>
            <button
              onClick={() => setPicking('to')}
              className={`px-3.5 py-1.5 rounded-full transition flex items-center gap-1.5 ${
                picking === 'to' ? 'bg-amber-400 text-slate-950 shadow' : 'text-slate-300 hover:text-white'
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-amber-400" />
              <span>Set Destination</span>
            </button>
          </div>
        </main>
      </div>
    </div>
  );
}
