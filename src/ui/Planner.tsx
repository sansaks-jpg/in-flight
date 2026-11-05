import { useEffect, useMemo, useRef, useState } from 'react';
import { specById } from '../sim/specs';
import { AIRPORT_BY_ID, Airport, searchAirports } from '../data/airports';
import { MapPanel, PlannerMapControlRef } from './MapPanel';
import { Settings } from '../sim/storage';
import { TILE_STYLES } from '../sim/tiles';
import { FlightIcon } from './FlightIcon';
import {
  AIRCRAFT_VARIANTS,
  AircraftVariantInfo,
  computeRouteDispatch,
  expandAirportRunways,
  getCuratedRoutes,
  REPO_FACTS,
} from './flightDispatch';
import {
  AircraftArtworkSvg,
  AircraftHangarModal,
  MsfsTopRightBar,
} from './PreGameVisuals';
import { ControlsPanel, Modal, ScoresPanel, SettingsPanel } from './Screens';

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

function MsfsAirportSearchBox({
  roleLabel,
  value,
  onSelect,
  onFocus,
}: {
  roleLabel: 'Departure' | 'Arrival';
  value: Airport;
  onSelect: (a: Airport) => void;
  onFocus: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const results = useMemo(() => (open ? searchAirports(query, 8) : []), [open, query]);

  return (
    <div className="relative flex-1 min-w-0">
      <div className="flex items-center bg-[#0d131d]/95 border border-white/15 focus-within:border-sky-400 px-2.5 h-8 transition">
        <FlightIcon name="search" size={13} className="text-slate-400 mr-2 shrink-0" />
        <input
          aria-label={`Search ${roleLabel}`}
          value={open ? query : `${value.icao} ${value.name}`}
          onFocus={(e) => {
            setOpen(true);
            setQuery('');
            onFocus();
            e.currentTarget.select();
          }}
          onBlur={() => setTimeout(() => setOpen(false), 180)}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={roleLabel}
          className="w-full bg-transparent text-xs font-semibold text-white placeholder:text-slate-400 outline-none truncate"
        />
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            setOpen(true);
            setQuery('');
            onFocus();
          }}
          className="text-slate-400 hover:text-white ml-1 shrink-0"
          aria-label={`Clear ${roleLabel} search`}
        >
          <FlightIcon name="close" size={12} />
        </button>
      </div>

      {open && results.length > 0 && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-[#0f1723]/98 border border-white/25 shadow-2xl max-h-64 overflow-y-auto">
          {results.map((a) => (
            <button
              key={a.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(a);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 hover:bg-[#2572eb] border-b border-white/5 last:border-0 flex items-center justify-between gap-2 transition group"
            >
              <div className="min-w-0">
                <div className="text-xs font-bold text-white flex items-center gap-1.5">
                  <span className="font-mono text-sky-300 group-hover:text-white">{a.icao}</span>
                  {a.iata && <span className="text-[10px] text-slate-400 group-hover:text-sky-100">({a.iata})</span>}
                  <span className="truncate">{a.name}</span>
                </div>
                <div className="text-[10px] text-slate-400 group-hover:text-slate-100 truncate">
                  {a.city}, {a.country} · {Math.round(a.elev / 0.3048).toLocaleString()} ft
                </div>
              </div>
              <span className="text-[10px] font-mono text-slate-300 shrink-0">{a.runways.length} rwy</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Planner({
  settings,
  setSettings,
  aircraftId,
  setAircraft,
  from,
  to,
  setFrom,
  setTo,
  onFly,
  onBack,
}: Props) {
  const [picking, setPicking] = useState<'from' | 'to'>('to');
  const [hangarOpen, setHangarOpen] = useState(false);
  const [efbOpen, setEfbOpen] = useState(false);
  const [favouritesOpen, setFavouritesOpen] = useState(true);
  const [airportPanelOpen, setAirportPanelOpen] = useState(true);
  const [airportTab, setAirportTab] = useState<'runways' | 'frequencies'>('runways');
  const [routeFilter, setRouteFilter] = useState<'all' | 'id' | 'world'>('all');
  const [routeQuery, setRouteQuery] = useState('');
  const [locationQuery, setLocationQuery] = useState('');
  const [locationOpen, setLocationOpen] = useState(false);
  const [inspectedAirport, setInspectedAirport] = useState<Airport>(from);
  const [selectedDepRwy, setSelectedDepRwy] = useState<string>(from.runways[0]?.le || '07R');
  const [selectedArrRwy, setSelectedArrRwy] = useState<string>(to.runways[0]?.le || '11');
  const [modal, setModal] = useState<null | 'scores' | 'settings' | 'controls' | 'credits'>(null);
  const [selectedVariantId, setSelectedVariantId] = useState<string>(() => {
    const match = AIRCRAFT_VARIANTS.find((v) => v.aircraftId === aircraftId);
    return match ? match.variantId : AIRCRAFT_VARIANTS[0].variantId;
  });

  const mapControlRef = useRef<PlannerMapControlRef | null>(null);

  const spec = specById(aircraftId);
  const activeVariant: AircraftVariantInfo =
    AIRCRAFT_VARIANTS.find((v) => v.variantId === selectedVariantId && v.aircraftId === aircraftId) ||
    AIRCRAFT_VARIANTS.find((v) => v.aircraftId === aircraftId) ||
    AIRCRAFT_VARIANTS[0];

  const dispatch = useMemo(() => computeRouteDispatch(from, to, spec), [from, to, spec]);
  const curatedRoutes = useMemo(() => getCuratedRoutes(routeFilter, routeQuery), [routeFilter, routeQuery]);
  const locationResults = useMemo(
    () => (locationOpen ? searchAirports(locationQuery, 8) : []),
    [locationOpen, locationQuery]
  );

  const depRunways = useMemo(() => expandAirportRunways(from), [from]);
  const arrRunways = useMemo(() => expandAirportRunways(to), [to]);
  const inspectedRunways = useMemo(() => expandAirportRunways(inspectedAirport), [inspectedAirport]);

  useEffect(() => {
    setSelectedDepRwy(from.runways[0]?.le || 'AUTO');
    setInspectedAirport(from);
  }, [from]);

  useEffect(() => {
    setSelectedArrRwy(to.runways[0]?.le || 'AUTO');
  }, [to]);

  // Keyboard shortcuts for EFB (T) and Start Flight (Ctrl+Enter)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (hangarOpen || modal) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setEfbOpen((o) => !o);
      } else if (e.key === 'Enter' && e.ctrlKey && dispatch.canFly) {
        e.preventDefault();
        onFly();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hangarOpen, modal, dispatch.canFly, onFly]);

  const set = (p: Partial<Settings>) => setSettings({ ...settings, ...p });

  const handleSelectAirportOnMap = (a: Airport, role: 'from' | 'to') => {
    if (role === 'from') {
      setFrom(a);
      setInspectedAirport(a);
      setPicking('to');
    } else {
      setTo(a);
      setInspectedAirport(a);
    }
  };

  return (
    <div className="fixed inset-0 bg-[#05080f] text-white select-none overflow-hidden font-sans">
      {/* 1. FULL-VIEWPORT INTERACTIVE WORLD MAP / GLOBE */}
      <MapPanel
        mode="planner"
        from={from}
        to={to}
        picking={picking}
        onPick={(a) => {
          setInspectedAirport(a);
        }}
        rangeKm={spec.rangeKm}
        onSetAirport={handleSelectAirportOnMap}
        onFlyNow={(a) => {
          if (a.id !== to.id) setFrom(a);
          onFly();
        }}
        onInspectAirport={(a) => {
          setInspectedAirport(a);
          setAirportPanelOpen(true);
        }}
        plannerControlRef={mapControlRef}
        hideDefaultPlannerChrome
        styleId={settings.mapStyle}
        onStyle={(id) => set({ mapStyle: id })}
        className="absolute inset-0 z-0"
      />

      {/* 2. TOP-RIGHT PILOT & UTILITY BAR (Matches all 8 MSFS reference images) */}
      <div className="absolute top-0 right-0 z-30">
        <MsfsTopRightBar pilotName={settings.name} onOpenModal={(m) => setModal(m)} />
      </div>

      {/* 3. TOP 3-PANEL FLOATING HEADER ROW (Aircraft Card + Departure/Arrival Bar + Flight Conditions) */}
      <div className="absolute top-10 left-3 right-3 sm:left-5 sm:right-5 z-20 flex flex-col lg:flex-row items-stretch gap-2.5 pointer-events-none">
        {/* TOP-LEFT: AIRCRAFT SELECTION CARD (Matches Images 2, 3, 4, 7, 8) */}
        <button
          type="button"
          onClick={() => setHangarOpen(true)}
          className="pointer-events-auto w-full lg:w-[290px] xl:w-[310px] h-32 sm:h-36 shrink-0 text-left relative overflow-hidden border border-sky-400/35 hover:border-sky-300 shadow-2xl group transition"
          style={{
            background:
              'linear-gradient(135deg, #2563eb 0%, #163e8f 48%, #0c1f47 82%, #071024 100%)',
          }}
          aria-label={`Change Aircraft. Currently selected: ${activeVariant.title}`}
        >
          {/* Diagonal geometric MSFS stripe overlay */}
          <div
            className="absolute inset-0 opacity-25 pointer-events-none"
            style={{
              background:
                'linear-gradient(125deg, transparent 20%, rgba(96,165,250,0.35) 20%, rgba(96,165,250,0.35) 36%, transparent 36%, transparent 55%, rgba(30,58,138,0.6) 55%)',
            }}
          />

          {/* Top-left Aircraft Title & Variant */}
          <div className="absolute top-2.5 left-3.5 right-3 z-10">
            <div className="font-extrabold text-sm sm:text-base text-white tracking-tight leading-snug drop-shadow truncate">
              {activeVariant.title}
            </div>
            <div className="text-xs text-sky-100/90 font-medium leading-tight">
              {activeVariant.variantLabel}
            </div>
          </div>

          {/* Center-Right Multi-Layered Aircraft SVG Render */}
          <div className="absolute left-6 right-1 bottom-0.5 top-8 flex items-center justify-center pointer-events-none">
            <AircraftArtworkSvg
              aircraftId={aircraftId}
              accentColor={activeVariant.accentColor}
              bellyColor={activeVariant.bellyColor}
              className="w-full h-full group-hover:scale-105 transition-transform duration-200"
            />
          </div>

          {/* Subtle bottom-right hover cue */}
          <span className="absolute bottom-2 right-2.5 z-10 px-2 py-0.5 bg-slate-950/75 border border-white/20 text-[10px] font-bold uppercase tracking-wider text-sky-200 group-hover:bg-[#2572eb] group-hover:text-white transition">
            Change Aircraft
          </span>
        </button>

        {/* TOP-CENTER: DEPARTURE & ARRIVAL ROUTE HEADER (Matches Images 2, 3, 4, 7, 8) */}
        <div className="pointer-events-auto flex-1 bg-[#18202c]/92 backdrop-blur-md border border-white/15 px-4 sm:px-5 py-2.5 flex flex-col justify-between shadow-2xl">
          {/* Row 1: Departure & Arrival Labels + ICAO Codes + Visual Plane Connector */}
          <div>
            <div className="flex items-center justify-between text-[11px] text-slate-400 font-semibold">
              <span>Departure</span>
              <span className="font-mono text-[10px] text-sky-300">
                {dispatch.distanceNm.toLocaleString()} NM ({dispatch.distanceKm.toLocaleString()} KM) · {dispatch.eteFormatted} · FL{dispatch.plannedFlightLevel}
              </span>
              <span>Arrival</span>
            </div>

            <div className="flex items-center justify-between gap-3 mt-0.5">
              <button
                type="button"
                onClick={() => mapControlRef.current?.focusAirport(from, 13)}
                className="font-extrabold text-lg sm:text-xl text-white tracking-tight hover:text-sky-300 transition font-mono"
                title={`Zoom to Departure: ${from.name}`}
              >
                {from.icao}
              </button>

              {/* Center Timeline Connector: Circle —— Plane —— Circle */}
              <div className="flex-1 flex items-center gap-2 max-w-md mx-auto">
                <span className="w-2.5 h-2.5 rounded-full border-2 border-white bg-[#18202c] shrink-0" />
                <div className="h-px flex-1 bg-white/35" />
                <FlightIcon name="plane" size={16} className="text-white rotate-90 shrink-0" />
                <div className="h-px flex-1 bg-white/35" />
                <span className="w-2.5 h-2.5 rounded-full border-2 border-white bg-[#18202c] shrink-0" />
              </div>

              <button
                type="button"
                onClick={() => mapControlRef.current?.focusAirport(to, 13)}
                className="font-extrabold text-lg sm:text-xl text-white tracking-tight hover:text-amber-300 transition font-mono text-right"
                title={`Zoom to Arrival: ${to.name}`}
              >
                {to.icao}
              </button>
            </div>
          </div>

          {/* Row 2: Searchable Departure Box + Blue Swap Button + Searchable Arrival Box */}
          <div className="flex items-center gap-2 my-1.5">
            <MsfsAirportSearchBox
              roleLabel="Departure"
              value={from}
              onSelect={(a) => {
                setFrom(a);
                setInspectedAirport(a);
                setPicking('to');
              }}
              onFocus={() => setPicking('from')}
            />

            <button
              type="button"
              onClick={() => {
                const prevFrom = from;
                setFrom(to);
                setTo(prevFrom);
              }}
              className="w-8 h-8 bg-[#1d6ae5] hover:bg-[#2572eb] active:scale-95 text-white grid place-items-center shrink-0 transition shadow"
              aria-label="Swap Departure and Arrival"
              title="Swap Departure and Arrival"
            >
              <FlightIcon name="swapHoriz" size={15} />
            </button>

            <MsfsAirportSearchBox
              roleLabel="Arrival"
              value={to}
              onSelect={(a) => {
                setTo(a);
                setInspectedAirport(a);
              }}
              onFocus={() => setPicking('to')}
            />
          </div>

          {/* Row 3: Departure Runway / Spawn Position Dropdown & Arrival Runway Dropdown */}
          <div className="grid grid-cols-2 gap-2 sm:gap-10">
            <div className="flex items-center bg-[#232d3d]/90 border border-white/10 h-7 px-2">
              <select
                aria-label="Departure Runway and Spawn Mode"
                value={`${settings.startMode}:${selectedDepRwy}`}
                onChange={(e) => {
                  const [modePart, rwyPart] = e.target.value.split(':');
                  set({ startMode: modePart as Settings['startMode'] });
                  if (rwyPart) setSelectedDepRwy(rwyPart);
                }}
                className="w-full bg-transparent text-[11px] font-semibold text-slate-200 outline-none truncate"
              >
                {depRunways.map((r) => (
                  <option key={`runway-${r.ident}`} value={`runway:${r.ident}`}>
                    RWY {r.ident} — RUNWAY TAKEOFF ({r.lengthM}m)
                  </option>
                ))}
                <option value={`cruise:${selectedDepRwy}`}>CRUISE — AIRBORNE ENROUTE (FL{dispatch.plannedFlightLevel})</option>
                <option value={`final:${selectedDepRwy}`}>FINAL — 14KM ILS APPROACH TO {to.icao}</option>
              </select>
            </div>

            <div className="flex items-center bg-[#232d3d]/90 border border-white/10 h-7 px-2">
              <select
                aria-label="Planner Arrival Runway"
                value={selectedArrRwy}
                onChange={(e) => setSelectedArrRwy(e.target.value)}
                className="w-full bg-transparent text-[11px] font-semibold text-slate-200 outline-none truncate"
              >
                {arrRunways.map((r) => (
                  <option key={`arr-${r.ident}`} value={r.ident}>
                    RWY {r.ident} — {r.lengthM}m ({r.surface})
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* TOP-RIGHT: FLIGHT CONDITIONS PANEL (Matches Images 2, 3, 4, 7, 8) */}
        <div className="pointer-events-auto w-full lg:w-[290px] xl:w-[310px] shrink-0 bg-[#18202c]/92 backdrop-blur-md border border-white/15 flex flex-col justify-between shadow-2xl overflow-hidden">
          {/* Atmospheric Header */}
          <div
            className="px-3.5 py-2 flex items-center justify-between border-b border-white/10"
            style={{
              background:
                'linear-gradient(115deg, #1d56b0 0%, #1e293b 55%, #0f172a 100%)',
            }}
          >
            <div>
              <div className="font-bold text-sm text-white leading-tight">Flight Conditions</div>
              <div className="flex items-center gap-2 mt-0.5 text-sky-200">
                <FlightIcon name="user" size={12} />
                <FlightIcon name="cloud" size={13} />
                <span className="text-[10px] font-semibold uppercase tracking-wider">
                  {settings.assist ? 'Assisted Env' : 'Realistic Sim'}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => set({ assist: !settings.assist })}
              className={`px-2 py-1 text-[10px] font-bold border transition ${
                settings.assist
                  ? 'bg-sky-400/20 border-sky-300/40 text-sky-200'
                  : 'bg-amber-400/20 border-amber-300/40 text-amber-200'
              }`}
              title="Toggle Assisted vs Realistic Flight Dynamics"
            >
              {settings.assist ? 'ASSIST ON' : 'REALISTIC'}
            </button>
          </div>

          {/* UTC Time & Daylight / Golden Hour Bar */}
          <div className="px-3.5 py-2 space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-mono font-bold text-white">
                {settings.tod === 'day' ? '14:47 UTC' : '17:42 UTC'} at {from.icao}
              </span>
              <span className="text-slate-400 text-[10px]">Solar Time</span>
            </div>

            {/* Visual Time Scrubber Bar (Now / Day / Golden Hr) */}
            <div className="grid grid-cols-2 h-6 bg-[#0d131d] border border-white/10 text-[11px] font-bold">
              <button
                type="button"
                onClick={() => set({ tod: 'day' })}
                className={`flex items-center justify-center gap-1.5 transition ${
                  settings.tod === 'day' ? 'bg-[#2572eb] text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                <FlightIcon name="sun" size={12} />
                <span>Daylight</span>
              </button>
              <button
                type="button"
                onClick={() => set({ tod: 'sunset' })}
                className={`flex items-center justify-center gap-1.5 transition ${
                  settings.tod === 'sunset' ? 'bg-[#2572eb] text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                <FlightIcon name="sunset" size={12} />
                <span>Golden Hr</span>
              </button>
            </div>

            {/* Weather & Wind Presets Row */}
            <div className="grid grid-cols-3 gap-1 pt-0.5">
              {(
                [
                  ['clear', 'Clear'],
                  ['scattered', 'Scattered'],
                  ['overcast', 'Overcast'],
                ] as const
              ).map(([wId, wLabel]) => (
                <button
                  key={wId}
                  type="button"
                  onClick={() => set({ weather: wId })}
                  className={`h-6 text-[11px] font-bold border transition ${
                    settings.weather === wId
                      ? 'bg-[#2572eb] border-sky-300 text-white'
                      : 'bg-[#121924] border-white/10 text-slate-300 hover:text-white'
                  }`}
                >
                  {wLabel}
                </button>
              ))}
            </div>

            {/* Wind Selector Strip */}
            <div className="flex items-center justify-between gap-1 text-[10px] pt-0.5">
              <span className="text-slate-400 font-semibold flex items-center gap-1">
                <FlightIcon name="wind" size={11} /> Wind:
              </span>
              <div className="flex gap-1">
                {(
                  [
                    ['calm', 'Calm (3kt)'],
                    ['light', 'Light (10kt)'],
                    ['strong', 'Gusty (24kt)'],
                  ] as const
                ).map(([windId, windLabel]) => (
                  <button
                    key={windId}
                    type="button"
                    onClick={() => set({ wind: windId })}
                    className={`px-2 py-0.5 font-bold transition ${
                      settings.wind === windId
                        ? 'bg-sky-400 text-slate-950'
                        : 'bg-white/5 text-slate-300 hover:bg-white/15'
                    }`}
                  >
                    {windLabel}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 4. LEFT FLOATING COLUMN: SEARCH LOCATION + FAVOURITES & CURATED ROUTES (Matches Images 7 & 8) */}
      <div className="hidden md:flex flex-col gap-2 absolute top-52 left-3 sm:left-5 z-20 w-[290px] xl:w-[310px] max-h-[calc(100vh-16rem)] pointer-events-none">
        {/* Search Location Input on Map */}
        <div className="relative pointer-events-auto">
          <div className="flex items-center bg-[#18202c]/92 backdrop-blur-md border border-white/15 focus-within:border-sky-400 px-3 h-8 shadow-xl">
            <FlightIcon name="search" size={13} className="text-slate-400 mr-2 shrink-0" />
            <input
              aria-label="Search location on map"
              value={locationQuery}
              onFocus={() => setLocationOpen(true)}
              onBlur={() => setTimeout(() => setLocationOpen(false), 180)}
              onChange={(e) => {
                setLocationQuery(e.target.value);
                setLocationOpen(true);
              }}
              placeholder={`Search location (${REPO_FACTS.totalAirports.toLocaleString()} airports)...`}
              className="w-full bg-transparent text-xs text-white placeholder:text-slate-400 outline-none"
            />
            {locationQuery && (
              <button
                type="button"
                onClick={() => setLocationQuery('')}
                className="text-slate-400 hover:text-white"
                aria-label="Clear location search"
              >
                <FlightIcon name="close" size={12} />
              </button>
            )}
          </div>

          {locationOpen && locationResults.length > 0 && (
            <div className="absolute z-50 left-0 right-0 mt-1 bg-[#0f1723]/98 border border-white/25 shadow-2xl max-h-60 overflow-y-auto">
              {locationResults.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setLocationOpen(false);
                    setLocationQuery(`${a.icao} - ${a.name}`);
                    mapControlRef.current?.focusAirport(a, 13.4);
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-[#2572eb] border-b border-white/5 last:border-0 flex items-center justify-between gap-2 transition"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-white truncate">
                      <span className="font-mono text-sky-300 mr-1.5">{a.icao}</span>
                      {a.name}
                    </div>
                    <div className="text-[10px] text-slate-400 truncate">
                      {a.city}, {a.country}
                    </div>
                  </div>
                  <span className="text-[10px] font-mono text-slate-300 shrink-0">{a.runways.length} rwy</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Collapsible FAVOURITES & CURATED ROUTES Box (Matches Images 7 & 8) */}
        <div className="pointer-events-auto bg-[#0d131c]/92 backdrop-blur-md border border-white/15 flex flex-col min-h-0 shadow-2xl overflow-hidden">
          <div className="px-3 py-2 bg-[#141c29] border-b border-white/10 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setFavouritesOpen((o) => !o)}
              className="flex items-center gap-1.5 text-[11px] font-extrabold tracking-wider uppercase text-white"
            >
              <FlightIcon name="heart" size={12} className="text-sky-400" />
              <span>FAVOURITES &amp; ROUTES</span>
            </button>

            <div className="flex items-center gap-1 text-[10px]">
              {(['all', 'id', 'world'] as const).map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => {
                    setRouteFilter(cat);
                    setFavouritesOpen(true);
                  }}
                  className={`px-1.5 py-0.5 font-bold uppercase transition ${
                    routeFilter === cat ? 'bg-[#2572eb] text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {cat === 'all' ? 'All' : cat === 'id' ? 'ID' : 'World'}
                </button>
              ))}
            </div>
          </div>

          {favouritesOpen && (
            <>
              {/* Horizontal Quick Aircraft Livery Cards (Matches Images 7 & 8) */}
              <div className="p-2 border-b border-white/10 grid grid-cols-3 gap-1.5 bg-[#0a0f17]">
                {AIRCRAFT_VARIANTS.filter((v) =>
                  ['sky-cfm-std', 'trek-pt6-stol', 'swift-io360-std'].includes(v.variantId)
                ).map((v) => {
                  const isAct = v.aircraftId === aircraftId;
                  return (
                    <button
                      key={v.variantId}
                      type="button"
                      onClick={() => {
                        setAircraft(v.aircraftId);
                        setSelectedVariantId(v.variantId);
                      }}
                      className={`text-left border overflow-hidden transition ${
                        isAct
                          ? 'border-sky-300 bg-[#2572eb] text-white'
                          : 'border-white/10 bg-[#18202c] text-slate-300 hover:border-white/30'
                      }`}
                    >
                      <div className="px-1.5 pt-1 text-[8px] font-mono uppercase tracking-wider opacity-85">
                        FLEET
                      </div>
                      <div className="h-9 px-1 flex items-center justify-center">
                        <AircraftArtworkSvg
                          aircraftId={v.aircraftId}
                          accentColor={v.accentColor}
                          bellyColor={v.bellyColor}
                        />
                      </div>
                      <div className="px-1.5 pb-1 text-[10px] font-bold truncate leading-tight">
                        {v.title.split('|')[0].trim()}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Filter Input inside Favourites */}
              <div className="px-2.5 py-1.5 border-b border-white/10 bg-[#111824]">
                <input
                  aria-label="Filter curated routes"
                  value={routeQuery}
                  onChange={(e) => setRouteQuery(e.target.value)}
                  placeholder="Search curated routes..."
                  className="w-full bg-[#0a0f17] border border-white/10 px-2 py-1 text-[11px] text-white placeholder:text-slate-500 outline-none"
                />
              </div>

              <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 bg-[#0d131c]">
                CURATED CORRIDORS · {curatedRoutes.length}
              </div>

              {/* Scrollable Curated Route List (Matches Image 7 list style) */}
              <div className="flex-1 overflow-y-auto divide-y divide-white/5 max-h-60">
                {curatedRoutes.map((r) => {
                  const isSelected = from.icao === r.fromIcao && to.icao === r.toIcao;
                  return (
                    <button
                      key={r.fromIcao + r.toIcao}
                      type="button"
                      onClick={() => {
                        const dep = AIRPORT_BY_ID.get(r.fromIcao)!;
                        const arr = AIRPORT_BY_ID.get(r.toIcao)!;
                        setFrom(dep);
                        setTo(arr);
                        setInspectedAirport(dep);
                      }}
                      className={`w-full text-left px-2.5 py-2 flex items-center justify-between gap-2 transition ${
                        isSelected
                          ? 'bg-[#2572eb] text-white'
                          : 'hover:bg-white/5 text-slate-200'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-bold truncate">
                          {r.title}
                        </div>
                        <div className={`text-[10px] font-mono truncate ${isSelected ? 'text-sky-100' : 'text-slate-400'}`}>
                          {r.fromIcao} to {r.toIcao} · {r.subtitle}
                        </div>
                      </div>
                      <span className={`text-[10px] font-mono font-bold shrink-0 ${isSelected ? 'text-white' : 'text-sky-300'}`}>
                        {r.distanceNm} nm
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 5. RIGHT FLOATING PANEL: INSPECTED AIRPORT RUNWAYS & FREQUENCIES (Matches Images 4 & 8) */}
      {airportPanelOpen && (
        <div className="hidden lg:flex flex-col absolute top-52 right-3 sm:right-5 z-20 w-[290px] xl:w-[310px] max-h-[calc(100vh-19.5rem)] bg-[#1b222c]/92 backdrop-blur-md border border-white/15 shadow-2xl overflow-hidden">
          {/* Airport Header */}
          <div className="px-3.5 py-2.5 bg-[#121820] border-b border-white/10 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono font-extrabold text-sm text-white">{inspectedAirport.icao}</span>
                {inspectedAirport.iata && (
                  <span className="text-[10px] font-mono font-bold px-1.5 py-0.2 bg-white/10 text-sky-300">
                    {inspectedAirport.iata}
                  </span>
                )}
                <span className="text-[10px] font-mono text-slate-400">
                  ELEV {Math.round(inspectedAirport.elev / 0.3048).toLocaleString()} FT
                </span>
              </div>
              <div className="text-xs text-slate-200 font-semibold truncate mt-0.5">
                {inspectedAirport.name}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => setFrom(inspectedAirport)}
                className={`px-1.5 py-0.5 text-[9px] font-bold border ${
                  from.id === inspectedAirport.id
                    ? 'bg-emerald-500 text-slate-950 border-emerald-300'
                    : 'bg-white/5 text-slate-300 border-white/15 hover:bg-white/15'
                }`}
              >
                DEP
              </button>
              <button
                type="button"
                onClick={() => setTo(inspectedAirport)}
                className={`px-1.5 py-0.5 text-[9px] font-bold border ${
                  to.id === inspectedAirport.id
                    ? 'bg-amber-400 text-slate-950 border-amber-300'
                    : 'bg-white/5 text-slate-300 border-white/15 hover:bg-white/15'
                }`}
              >
                ARR
              </button>
            </div>
          </div>

          {/* Segmented Tabs: Runways | Frequencies (Matches Images 4 & 8) */}
          <div className="px-3 pt-2 pb-1.5 grid grid-cols-2 gap-1.5 bg-[#161c26]">
            <button
              type="button"
              onClick={() => setAirportTab('runways')}
              className={`h-7 px-2.5 text-xs font-bold flex items-center justify-between transition ${
                airportTab === 'runways'
                  ? 'bg-[#2572eb] text-white'
                  : 'bg-[#1f2937] text-slate-300 hover:text-white'
              }`}
            >
              <span>Runways</span>
              {airportTab === 'runways' && <FlightIcon name="check" size={12} />}
            </button>
            <button
              type="button"
              onClick={() => setAirportTab('frequencies')}
              className={`h-7 px-2.5 text-xs font-bold flex items-center justify-between transition ${
                airportTab === 'frequencies'
                  ? 'bg-[#2572eb] text-white'
                  : 'bg-[#1f2937] text-slate-300 hover:text-white'
              }`}
            >
              <span>Frequencies</span>
              {airportTab === 'frequencies' && <FlightIcon name="check" size={12} />}
            </button>
          </div>

          {/* Tab Content */}
          {airportTab === 'runways' ? (
            <div className="flex-1 overflow-y-auto divide-y divide-white/5 text-xs">
              {inspectedRunways.map((r) => {
                const isSelected =
                  (inspectedAirport.id === from.id && selectedDepRwy === r.ident) ||
                  (inspectedAirport.id === to.id && selectedArrRwy === r.ident);
                return (
                  <button
                    key={r.ident}
                    type="button"
                    onClick={() => {
                      if (inspectedAirport.id === from.id) setSelectedDepRwy(r.ident);
                      else if (inspectedAirport.id === to.id) setSelectedArrRwy(r.ident);
                    }}
                    className={`w-full px-3.5 py-2 flex items-center justify-between transition ${
                      isSelected ? 'bg-[#1d4ed8]/60 text-white' : 'hover:bg-white/5 text-slate-200'
                    }`}
                  >
                    <span className="font-mono font-bold">{r.ident}</span>
                    <div className="flex items-center gap-2 text-slate-300">
                      <span className="font-mono">
                        {r.lengthM} m ({r.surface})
                      </span>
                      <FlightIcon name="wind" size={12} className="text-sky-300" />
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-3.5 space-y-2.5 text-xs">
              <div className="space-y-1 font-mono text-[11px]">
                <div className="flex justify-between py-1 border-b border-white/10">
                  <span className="text-slate-400">ATIS / WX</span>
                  <span className="text-sky-300 font-bold">126.250 MHz</span>
                </div>
                <div className="flex justify-between py-1 border-b border-white/10">
                  <span className="text-slate-400">TOWER</span>
                  <span className="text-white font-bold">118.100 MHz</span>
                </div>
                <div className="flex justify-between py-1 border-b border-white/10">
                  <span className="text-slate-400">GROUND</span>
                  <span className="text-white font-bold">121.900 MHz</span>
                </div>
                <div className="flex justify-between py-1 border-b border-white/10">
                  <span className="text-slate-400">ILS / APPR</span>
                  <span className="text-emerald-300 font-bold">110.300 MHz</span>
                </div>
              </div>

              <div className="pt-1">
                <label className="block text-[10px] uppercase tracking-wider font-bold text-slate-400 mb-1">
                  3D Terrain &amp; Satellite Imagery
                </label>
                <select
                  aria-label="3D Terrain Style"
                  value={settings.terrainStyle}
                  onChange={(e) => set({ terrainStyle: e.target.value })}
                  className="w-full bg-[#111823] border border-white/15 px-2.5 py-1.5 text-xs text-white outline-none"
                >
                  {TILE_STYLES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Bottom Blue Bar (Matches "Live Airport Traffic" bar in Images 4 & 8) */}
          <div className="px-3.5 py-1.5 bg-[#1d6ae5] text-xs font-bold text-white flex items-center justify-between">
            <span>
              {dispatch.canFly ? 'Dispatch Cleared' : dispatch.sameAirport ? 'Select DistinctARR' : 'Range Exceeded'}
            </span>
            <span className="font-mono text-[11px]">
              {dispatch.fuelRequiredKg.toLocaleString()} kg fuel
            </span>
          </div>
        </div>
      )}

      {/* 6. EFB (ELECTRONIC FLIGHT BAG) FLOATING DRAWER (Vertical Profile & Dispatch Summary) */}
      {efbOpen && (
        <div className="absolute bottom-28 right-3 sm:right-5 z-30 w-[330px] sm:w-[400px] bg-[#111824]/96 backdrop-blur-md border border-sky-400/40 shadow-2xl p-4 space-y-3 animate-[fadein_.15s_ease-out]">
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <div className="flex items-center gap-2">
              <span className="px-1.5 py-0.5 bg-[#2572eb] text-[10px] font-mono font-bold text-white">EFB</span>
              <span className="text-xs font-extrabold tracking-wide uppercase text-white">
                Flight Plan &amp; Vertical Profile
              </span>
            </div>
            <button
              type="button"
              onClick={() => setEfbOpen(false)}
              className="text-slate-400 hover:text-white"
              aria-label="Close EFB"
            >
              <FlightIcon name="close" size={14} />
            </button>
          </div>

          {/* 4-column Route Telemetry */}
          <div className="grid grid-cols-4 gap-2 text-center bg-[#0a0f17] p-2.5 border border-white/10">
            <div>
              <div className="font-mono font-extrabold text-sm text-white">{dispatch.distanceNm}</div>
              <div className="text-[9px] uppercase text-slate-400 font-bold">Dist (NM)</div>
            </div>
            <div>
              <div className="font-mono font-extrabold text-sm text-sky-300">
                {String(dispatch.bearingDeg).padStart(3, '0')}°
              </div>
              <div className="text-[9px] uppercase text-slate-400 font-bold">Course</div>
            </div>
            <div>
              <div className="font-mono font-extrabold text-sm text-emerald-300">{dispatch.eteFormatted}</div>
              <div className="text-[9px] uppercase text-slate-400 font-bold">Est Time</div>
            </div>
            <div>
              <div className="font-mono font-extrabold text-sm text-amber-300">
                {dispatch.fuelRequiredKg.toLocaleString()}
              </div>
              <div className="text-[9px] uppercase text-slate-400 font-bold">Fuel (kg)</div>
            </div>
          </div>

          {/* Vertical Flight Profile SVG */}
          <div className="h-24 w-full bg-[#090d14] border border-white/10 relative overflow-hidden flex items-end px-3 pb-2">
            <svg className="w-full h-full absolute inset-0" preserveAspectRatio="none" viewBox="0 0 300 80">
              <defs>
                <linearGradient id="efbFlightPath" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#3ddc84" />
                  <stop offset="25%" stopColor="#38bdf8" />
                  <stop offset="75%" stopColor="#38bdf8" />
                  <stop offset="100%" stopColor="#ffb02e" />
                </linearGradient>
              </defs>
              <path
                d="M 0 75 Q 40 68, 70 72 T 140 64 T 210 69 T 270 73 L 300 76 L 300 80 L 0 80 Z"
                fill="rgba(51, 65, 85, 0.5)"
              />
              <path
                d="M 12 72 L 60 22 L 235 22 L 288 73"
                fill="none"
                stroke="url(#efbFlightPath)"
                strokeWidth="2.5"
                strokeDasharray="4 2"
              />
              <circle cx="12" cy="72" r="3.5" fill="#3ddc84" />
              <circle cx="60" cy="22" r="3" fill="#38bdf8" />
              <circle cx="235" cy="22" r="3" fill="#f43f5e" />
              <circle cx="288" cy="73" r="3.5" fill="#ffb02e" />
            </svg>
            <div className="relative z-10 w-full flex justify-between text-[9px] font-mono text-slate-300">
              <span>DEP {from.icao}</span>
              <span>TOC</span>
              <span className="text-sky-300 font-bold">CRUISE FL{dispatch.plannedFlightLevel}</span>
              <span>TOD</span>
              <span>ARR {to.icao}</span>
            </div>
          </div>

          {!dispatch.inRange && (
            <div className="p-2.5 bg-rose-950/70 border border-rose-500/40 text-xs text-rose-200">
              Route distance ({dispatch.distanceKm.toLocaleString()} km) exceeds {spec.name} max operational range ({dispatch.maxRangeKm.toLocaleString()} km). Switch to <b>Skyliner 320</b> or choose a closer airport.
            </div>
          )}
        </div>
      )}

      {/* 7. BOTTOM BAR: BACK / SELECT (Left), ZOOM HINTS (Center), EFB & START FLIGHT (Right) */}
      <div className="absolute bottom-3 left-3 right-3 sm:left-5 sm:right-5 z-20 flex items-end justify-between pointer-events-none">
        {/* Bottom-Left: Back & Select / Fit Route Buttons (Matches Images 2, 3, 4, 7, 8) */}
        <div className="pointer-events-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onBack}
            className="px-4 py-2 bg-[#161c24]/95 hover:bg-[#2572eb] border border-white/20 text-xs font-bold text-white transition shadow-lg"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => mapControlRef.current?.fitRoute()}
            className="px-4 py-2 bg-[#161c24]/95 hover:bg-white/15 border border-white/20 text-xs font-bold text-slate-200 hover:text-white transition shadow-lg"
          >
            Select Route View
          </button>
          <button
            type="button"
            onClick={() => mapControlRef.current?.globeView()}
            className="hidden sm:inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#161c24]/95 hover:bg-white/15 border border-white/20 text-xs font-bold text-sky-300 hover:text-white transition shadow-lg"
          >
            <FlightIcon name="globe" size={13} />
            <span>Globe View</span>
          </button>
        </div>

        {/* Bottom-Center: MSFS Zoom & Panel Controls Pill */}
        <div className="pointer-events-auto hidden md:flex items-center gap-2 px-4 py-1.5 bg-[#0e131b]/92 border border-white/15 text-xs text-slate-200 shadow-xl">
          <button
            type="button"
            onClick={() => setFavouritesOpen((o) => !o)}
            className="font-bold hover:text-sky-300 transition"
          >
            Switch to Panels
          </button>
          <span className="text-slate-600">|</span>
          <button
            type="button"
            onClick={() => mapControlRef.current?.zoomBy(-1)}
            className="px-1.5 py-0.5 bg-white/10 hover:bg-white/20 border border-white/20 font-mono text-[10px] font-bold text-white"
            aria-label="Zoom out world map"
          >
            NUM SUB -
          </button>
          <span>/</span>
          <button
            type="button"
            onClick={() => mapControlRef.current?.zoomBy(1)}
            className="px-1.5 py-0.5 bg-white/10 hover:bg-white/20 border border-white/20 font-mono text-[10px] font-bold text-white"
            aria-label="Zoom in world map"
          >
            NUM PLUS +
          </button>
          <span className="font-semibold">Zoom</span>
        </div>

        {/* Bottom-Right: Map Utility Strip + Blue [T] EFB Bar + Yellow Start Flight Bar */}
        <div className="pointer-events-auto flex flex-col items-end gap-1.5 w-[260px] sm:w-[310px]">
          {/* Blue 3-Icon Utility Pill (Matches Images 2, 3, 4, 7, 8) */}
          <div className="flex items-center bg-[#1d6ae5] border border-sky-300/40 shadow-lg divide-x divide-white/20">
            <button
              type="button"
              onClick={() => setModal('credits')}
              className="w-9 h-7 grid place-items-center text-white hover:bg-[#2572eb] transition"
              aria-label="Map and Repository Information"
              title="Aeronautical Data & Repository Facts"
            >
              <FlightIcon name="info" size={14} />
            </button>
            <button
              type="button"
              onClick={() => mapControlRef.current?.toggleLayers()}
              className="w-9 h-7 grid place-items-center text-white hover:bg-[#2572eb] transition"
              aria-label="Toggle Map Layers"
              title="Map Layers & Satellite Imagery"
            >
              <FlightIcon name="layers" size={14} />
            </button>
            <button
              type="button"
              onClick={() => setAirportPanelOpen((o) => !o)}
              className="w-9 h-7 grid place-items-center text-white hover:bg-[#2572eb] transition"
              aria-label="Toggle Airport Runways Panel"
              title="Toggle Airport Runways & Frequencies"
            >
              <FlightIcon name="list" size={14} />
            </button>
          </div>

          {/* Blue [T] EFB Button (Matches Images 2, 3, 4, 7, 8) */}
          <button
            type="button"
            onClick={() => setEfbOpen((o) => !o)}
            className="w-full h-9 px-3 bg-[#1d6ae5] hover:bg-[#2572eb] border border-sky-300/40 text-white font-bold text-xs flex items-center justify-between shadow-lg transition"
          >
            <div className="flex items-center gap-2">
              <kbd className="px-1.5 py-0.5 bg-[#0f2957] border border-sky-300/40 font-mono text-[10px]">T</kbd>
              <span>EFB</span>
            </div>
            <span className="text-[11px] font-mono text-sky-100">
              {from.icao} to {to.icao} · {dispatch.distanceNm} NM
            </span>
          </button>

          {/* Yellow Start Flight CTA Button (Matches Images 2, 3, 4, 7, 8) */}
          <button
            type="button"
            disabled={!dispatch.canFly}
            onClick={onFly}
            className="w-full h-11 px-3 bg-[#eab308] hover:bg-[#facc15] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-extrabold text-sm flex items-center justify-between shadow-[0_0_25px_rgba(234,179,8,0.4)] transition"
          >
            <div className="flex items-center gap-2">
              <kbd className="px-1.5 py-0.5 bg-slate-950/15 border border-slate-950/40 font-mono text-[10px] font-bold">
                CTRL
              </kbd>
              <span className="text-xs font-mono">+</span>
              <kbd className="px-1.5 py-0.5 bg-slate-950/15 border border-slate-950/40 font-mono text-[10px] font-bold">
                ENTER
              </kbd>
              <span className="ml-1 tracking-tight">Start flight</span>
            </div>
            <FlightIcon name="plane" size={16} />
          </button>
        </div>
      </div>

      {/* 8. FULL-SCREEN CHANGE AIRCRAFT HANGAR MODAL (Matches Images 5 & 6) */}
      {hangarOpen && (
        <AircraftHangarModal
          aircraftId={aircraftId}
          selectedVariantId={selectedVariantId}
          onSelectAircraftAndVariant={(nextAircraftId, variant) => {
            setAircraft(nextAircraftId);
            setSelectedVariantId(variant.variantId);
          }}
          settings={settings}
          onUpdateSettings={set}
          onClose={() => setHangarOpen(false)}
        />
      )}

      {/* 9. UTILITY MODALS */}
      {modal === 'scores' && (
        <Modal title="Pilot Logbook & High Scores" onClose={() => setModal(null)}>
          <ScoresPanel />
        </Modal>
      )}
      {modal === 'settings' && (
        <Modal title="Simulation Settings" onClose={() => setModal(null)}>
          <SettingsPanel s={settings} set={set} />
        </Modal>
      )}
      {modal === 'controls' && (
        <Modal title="Keyboard & Controller Flight Map" wide onClose={() => setModal(null)}>
          <ControlsPanel />
        </Modal>
      )}
      {modal === 'credits' && (
        <Modal title="Aeronautical Data & Repository Architecture" onClose={() => setModal(null)}>
          <ul className="text-sm text-slate-300 space-y-2.5 list-disc pl-5">
            <li>
              <b>OurAirports Worldwide Runway Database</b> — 6,613 real-world airports (including 155 in Indonesia) with authentic runway coordinates, magnetic headings, thresholds, and dimensions.
            </li>
            <li>
              <b>AWS Open Data Terrain Tiles (Terrarium)</b> — global DEM elevation heightmaps, derived from SRTM, ETOPO1, and GMTED datasets.
            </li>
            <li>
              <b>Esri World Imagery</b> — high-resolution global satellite photography base for 3D terrain and tactical moving maps.
            </li>
            <li>
              <b>OpenStreetMap &amp; OpenFreeMap MVT</b> — procedural 3D building extrusions, airport terminals, control towers, hangars, highways, and coastlines.
            </li>
            <li>
              <b>Three.js + React 19 + TypeScript 5.9</b> — deterministic rigid-body flight physics, multi-point oleo strut landing gear, Web Audio synthesizer, and Garmin G1000 / MSFS PFD avionics.
            </li>
          </ul>
        </Modal>
      )}
    </div>
  );
}
