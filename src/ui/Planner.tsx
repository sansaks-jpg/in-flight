import { useEffect, useMemo, useState, type MutableRefObject } from 'react';
import { specById } from '../sim/specs';
import { AIRPORT_BY_ID, Airport, searchAirports, frequenciesFor, navaidsNear, navaidFreqLabel, getAirfield } from '../data/airports';
import { startSpots } from '../sim/airfield';
import { magVar, fmtVar } from '../sim/magvar';
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
  AircraftHangarModal,
  AircraftStudioCardVisual,
  GlobeControlHandle,
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
  selectedDep?: Airport | null;
  selectedArr?: Airport | null;
  onSelectDep?: (a: Airport | null) => void;
  onSelectArr?: (a: Airport | null) => void;
  setFrom: (a: Airport) => void;
  setTo: (a: Airport) => void;
  rwySel: { dep: string; arr: string; spot: string };
  setRwySel: (f: (r: { dep: string; arr: string; spot: string }) => { dep: string; arr: string; spot: string }) => void;
  onFly: () => void;
  onBack: () => void;
  initialHangarOpen?: boolean;
  globeControlRef?: MutableRefObject<GlobeControlHandle | null>;
  scaleKm?: number;
  scalePx?: number;
}

const INDONESIAN_REGIONS: { label: string; region: string; icao: string; zoom: number }[] = [
  { label: 'Jakarta & West Java', region: 'Java Island, Indonesia', icao: 'WIII', zoom: 7.5 },
  { label: 'Bali & Nusa Tenggara', region: 'Denpasar, Indonesia', icao: 'WADD', zoom: 7.6 },
  { label: 'Yogyakarta & Central Java', region: 'Java Island, Indonesia', icao: 'WAHI', zoom: 7.5 },
  { label: 'Surabaya & East Java', region: 'Java Island, Indonesia', icao: 'WARR', zoom: 7.4 },
  { label: 'Medan & Lake Toba', region: 'North Sumatra, Indonesia', icao: 'WIMM', zoom: 7.2 },
  { label: 'Makassar & Sulawesi', region: 'South Sulawesi, Indonesia', icao: 'WAAA', zoom: 7.2 },
  { label: 'Balikpapan & Nusantara (IKN)', region: 'East Kalimantan, Indonesia', icao: 'WALL', zoom: 7.4 },
  { label: 'Jayapura & Papua Highlands', region: 'Papua, Indonesia', icao: 'WAJJ', zoom: 7.0 },
];

function MsfsAirportSearchBox({
  roleLabel,
  value,
  onSelect,
  onClear,
}: {
  roleLabel: 'Departure' | 'Arrival';
  value: Airport | null;
  onSelect: (a: Airport) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const results = useMemo(() => (open ? searchAirports(query, 10) : []), [open, query]);

  return (
    <div className="relative flex-1 min-w-0">
      <div className="flex items-center bg-[#121822]/90 border border-white/10 focus-within:border-sky-400 px-2 h-6 transition">
        <FlightIcon name="search" size={12} className="text-slate-300 mr-1.5 shrink-0" />
        <input
          aria-label={`Search ${roleLabel}`}
          value={open ? query : value ? `${value.icao} — ${value.name}` : ''}
          onFocus={(e) => {
            setOpen(true);
            setQuery('');
            e.currentTarget.select();
          }}
          onBlur={() => setTimeout(() => setOpen(false), 180)}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={roleLabel}
          className="w-full bg-transparent text-[11px] font-medium text-white placeholder:text-slate-400 outline-none truncate"
        />
        {value && !open && (
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              onClear();
            }}
            className="text-slate-400 hover:text-white ml-1 shrink-0"
            aria-label={`Clear ${roleLabel}`}
          >
            <FlightIcon name="close" size={10} />
          </button>
        )}
      </div>

      {open && results.length > 0 && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-[#111823]/98 border border-white/20 shadow-2xl max-h-60 overflow-y-auto">
          {results.map((a) => (
            <button
              key={a.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(a);
                setOpen(false);
              }}
              className="w-full text-left px-2.5 py-1.5 hover:bg-[#2572eb] border-b border-white/5 last:border-0 flex items-center justify-between gap-2 transition group"
            >
              <div className="min-w-0">
                <div className="text-xs font-bold text-white flex items-center gap-1.5">
                  <span className="font-mono text-sky-300 group-hover:text-white">{a.icao}</span>
                  {a.iata && (
                    <span className="text-[10px] text-slate-400 group-hover:text-sky-100">
                      ({a.iata})
                    </span>
                  )}
                  <span className="truncate">{a.name}</span>
                </div>
                <div className="text-[10px] text-slate-400 group-hover:text-slate-100 truncate">
                  {a.city}, {a.country}
                </div>
              </div>
              <span className="text-[10px] font-mono text-slate-300 shrink-0">
                {a.runways.length} rwy
              </span>
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
  selectedDep = null,
  selectedArr = null,
  onSelectDep,
  onSelectArr,
  onFly,
  rwySel,
  setRwySel,
  onBack,
  initialHangarOpen = false,
  globeControlRef,
  scaleKm = 1000,
  scalePx = 80,
}: Props) {
  const [hangarOpen, setHangarOpen] = useState(initialHangarOpen);
  const [efbOpen, setEfbOpen] = useState(false);
  // Keep side panels closed by default so the 3D globe and map area are never obstructed
  const [favouritesOpen, setFavouritesOpen] = useState(false);
  const [airportPanelOpen, setAirportPanelOpen] = useState(false);
  const [conditionsPopoverOpen, setConditionsPopoverOpen] = useState(false);
  const [airportTab, setAirportTab] = useState<'runways' | 'frequencies'>('runways');
  const [routeFilter, setRouteFilter] = useState<'all' | 'id' | 'world'>('all');
  const [locationQuery, setLocationQuery] = useState('');
  const [locationOpen, setLocationOpen] = useState(false);
  const selectedDepRwy = rwySel.dep, selectedArrRwy = rwySel.arr;
  const setSelectedDepRwy = (v: string) => setRwySel((r) => ({ ...r, dep: v }));
  const setSelectedArrRwy = (v: string) => setRwySel((r) => ({ ...r, arr: v }));
  const [utcMinutes, setUtcMinutes] = useState<number>(14 * 60 + 47); // 14:47 UTC matching reference images
  const [modal, setModal] = useState<null | 'scores' | 'settings' | 'controls' | 'credits'>(null);
  const [entered, setEntered] = useState(false);
  const [selectedVariantId, setSelectedVariantId] = useState<string>(() => {
    const match = AIRCRAFT_VARIANTS.find((v) => v.aircraftId === aircraftId);
    return match ? match.variantId : AIRCRAFT_VARIANTS[0].variantId;
  });

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    if (initialHangarOpen) setHangarOpen(true);
  }, [initialHangarOpen]);

  const spec = specById(aircraftId);
  const activeVariant: AircraftVariantInfo =
    AIRCRAFT_VARIANTS.find((v) => v.variantId === selectedVariantId && v.aircraftId === aircraftId) ||
    AIRCRAFT_VARIANTS.find((v) => v.aircraftId === aircraftId) ||
    AIRCRAFT_VARIANTS[0];

  const [customInspectedAirport, setCustomInspectedAirport] = useState<Airport | null>(null);
  const effectiveFrom = selectedDep || from;
  const effectiveTo = selectedArr || to;
  const inspectedAirport = customInspectedAirport || selectedDep || selectedArr || from;

  const dispatch = useMemo(
    () => computeRouteDispatch(effectiveFrom, effectiveTo, spec),
    [effectiveFrom, effectiveTo, spec]
  );
  const curatedRoutes = useMemo(
    () => getCuratedRoutes(routeFilter, ''),
    [routeFilter]
  );
  const locationResults = useMemo(
    () => (locationOpen && locationQuery.trim() ? searchAirports(locationQuery, 8) : []),
    [locationOpen, locationQuery]
  );

  const depRunways = useMemo(
    () => (selectedDep ? expandAirportRunways(selectedDep) : []),
    [selectedDep]
  );
  const arrRunways = useMemo(
    () => (selectedArr ? expandAirportRunways(selectedArr) : []),
    [selectedArr]
  );
  const depSpots = useMemo(() => (selectedDep ? startSpots(selectedDep) : []), [selectedDep]);
  const inspectedRunways = useMemo(
    () => expandAirportRunways(inspectedAirport),
    [inspectedAirport]
  );

  const canStartSelectedFlight = Boolean(selectedDep || selectedArr);

  const handleStartFlight = () => {
    // Missing endpoints are filled in by the parent (App.flyFromPlanner) at start time only
    onFly();
  };

  // Keyboard shortcuts for EFB (T) and Start Flight (Ctrl+Enter)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (hangarOpen || modal) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setEfbOpen((o) => !o);
      } else if (e.key === 'Enter' && e.ctrlKey && canStartSelectedFlight) {
        e.preventDefault();
        handleStartFlight();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const set = (p: Partial<Settings>) => setSettings({ ...settings, ...p });

  const formattedUtc = `${String(Math.floor(utcMinutes / 60)).padStart(2, '0')}:${String(
    utcMinutes % 60
  ).padStart(2, '0')} UTC`;
  const sliderPercent = Math.max(8, Math.min(94, (utcMinutes / (24 * 60)) * 100));

  return (
    <div className="fixed inset-0 bg-transparent text-white select-none overflow-hidden font-sans pointer-events-none">
      {/* 1. TOP-RIGHT PILOT & UTILITY BAR */}
      <div className="absolute top-0 right-0 z-30 pointer-events-auto">
        <MsfsTopRightBar pilotName={settings.name} onOpenModal={(m) => setModal(m)} />
      </div>

      {/* 2. TOP 3-PANEL HEADER ROW (Matches Reference Images: Aircraft Box + Centered Route Box + Flight Conditions) */}
      <div
        className={`absolute top-9 left-3.5 right-3.5 z-20 flex flex-col lg:flex-row items-stretch gap-2.5 pointer-events-none transition-all duration-500 ease-out ${
          entered ? 'translate-y-0 opacity-100' : '-translate-y-4 opacity-0'
        }`}
      >
        {/* TOP-LEFT: AIRCRAFT SELECTION BOX (Clean 265x116 card matching reference images) */}
        <button
          type="button"
          data-change-aircraft="true"
          onClick={() => setHangarOpen(true)}
          className="pointer-events-auto w-full lg:w-[265px] h-[116px] shrink-0 text-left relative overflow-hidden bg-[#162d59] border border-white/15 hover:border-sky-300 shadow-xl group transition"
          aria-label={`Change Aircraft. Currently selected: ${activeVariant.title}`}
        >
          <AircraftStudioCardVisual
            variant={activeVariant}
            className="absolute inset-0 w-full h-full"
            imgClassName="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />

          <div className="absolute inset-0 bg-gradient-to-b from-slate-950/65 via-transparent to-slate-950/35 pointer-events-none" />

          <div className="absolute top-2 left-3 right-3 z-10">
            <div className="font-extrabold text-[15px] text-white tracking-tight leading-snug drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] truncate">
              {activeVariant.title}
            </div>
            <div className="text-xs text-slate-100 font-medium leading-tight drop-shadow">
              {activeVariant.variantLabel}
            </div>
          </div>
        </button>

        {/* TOP-CENTER: ROUTE DISPLAY (Departure / Arrival '-' when unselected, timeline, and 2x2 inputs with swap button) */}
        <div className="pointer-events-auto flex-1 h-[116px] bg-[#1e2633]/88 border border-white/10 px-5 py-2 flex flex-col justify-between shadow-xl">
          {/* Upper Section: Departure / Arrival labels + '-' or ICAO + Timeline */}
          <div>
            <div className="flex items-center justify-between text-[11px] text-slate-400 font-medium leading-none">
              <span>Departure</span>
              {selectedDep && selectedArr && (
                <button
                  type="button"
                  onClick={() => globeControlRef?.current?.focusRoute(selectedDep, selectedArr)}
                  className="font-mono text-[10px] text-sky-300 hover:text-white transition"
                  title="Frame full flight route on globe"
                >
                  {dispatch.distanceNm.toLocaleString()} NM ({dispatch.distanceKm.toLocaleString()} KM) · {dispatch.eteFormatted}
                </button>
              )}
              <span>Arrival</span>
            </div>

            <div className="flex items-center justify-between text-xs font-bold text-white mt-1 leading-none">
              <button
                type="button"
                onClick={() => {
                  if (selectedDep) {
                    globeControlRef?.current?.focusLocation(selectedDep.lat, selectedDep.lon);
                  }
                }}
                className="font-mono hover:text-sky-300 transition"
              >
                {selectedDep ? selectedDep.icao : '-'}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (selectedArr) {
                    globeControlRef?.current?.focusLocation(selectedArr.lat, selectedArr.lon);
                  }
                }}
                className="font-mono hover:text-sky-300 transition"
              >
                {selectedArr ? selectedArr.icao : '-'}
              </button>
            </div>

            {/* Center Timeline Connector: Circle —— Plane —— Circle */}
            <div className="flex items-center gap-2.5 mt-1">
              <span className="w-2.5 h-2.5 rounded-full border border-white/80 flex items-center justify-center shrink-0">
                <span className="w-1 h-1 rounded-full bg-white" />
              </span>
              <div className="h-px flex-1 bg-white/40" />
              <FlightIcon name="plane" size={15} className="text-white rotate-90 shrink-0 mx-1" />
              <div className="h-px flex-1 bg-white/40" />
              <span className="w-2.5 h-2.5 rounded-full border border-white/80 flex items-center justify-center shrink-0">
                <span className="w-1 h-1 rounded-full bg-white" />
              </span>
            </div>
          </div>

          {/* Lower Section: 2x2 Inputs (Departure + Runway on left, Swap button in middle, Arrival + Runway on right) */}
          <div className="flex items-center gap-2.5">
            {/* Left Column: Departure Input + Departure Runway */}
            <div className="flex-1 flex flex-col gap-1 min-w-0">
              <MsfsAirportSearchBox
                roleLabel="Departure"
                value={selectedDep}
                onSelect={(a) => {
                  setCustomInspectedAirport(a);
                  onSelectDep?.(a);
                }}
                onClear={() => onSelectDep?.(null)}
              />
              <div className="flex items-center bg-[#121822]/90 border border-white/10 h-6 px-2">
                <select
                  aria-label="Departure Runway"
                  disabled={!selectedDep}
                  value={!selectedDep ? '' : settings.startMode !== 'runway' ? settings.startMode : rwySel.spot ? `ramp:${rwySel.spot}` : `runway:${selectedDepRwy}`}
                  onChange={(e) => {
                    const v = e.target.value;
                    const k = v.indexOf(':');
                    const kind = k < 0 ? v : v.slice(0, k), id = k < 0 ? '' : v.slice(k + 1);
                    if (kind === 'runway') { set({ startMode: 'runway' }); setRwySel((r) => ({ ...r, dep: id, spot: '' })); }
                    else if (kind === 'ramp') { set({ startMode: 'runway' }); setRwySel((r) => ({ ...r, spot: id })); }
                    else set({ startMode: kind as Settings['startMode'] });
                  }}
                  className="w-full bg-transparent text-[11px] font-medium text-slate-300 disabled:text-slate-400 outline-none truncate"
                >
                  {!selectedDep ? (
                    <option value="">Runway</option>
                  ) : (
                    <>
                      <optgroup label="Runway start">
                        <option value="runway:">AUTO runway (wind / route)</option>
                        {depRunways.map((r) => (
                          <option key={`dep-${r.ident}`} value={`runway:${r.ident}`}>
                            RWY {r.ident} · {r.lengthM}m · {r.surface} · {String(r.headingDeg).padStart(3, '0')}°M
                          </option>
                        ))}
                      </optgroup>
                      {depSpots.length > 0 && (
                        <optgroup label="Ramp start · taxi to the runway">
                          {depSpots.map((sp) => (
                            <option key={sp.id} value={`ramp:${sp.id}`}>{sp.label}</option>
                          ))}
                        </optgroup>
                      )}
                      <optgroup label="Airborne">
                        <option value="cruise">AIRBORNE CRUISE (FL{dispatch.plannedFlightLevel})</option>
                        <option value="final">14KM ILS FINAL APPROACH</option>
                      </optgroup>
                    </>
                  )}
                </select>
              </div>
              {selectedDep && settings.startMode === 'runway' && rwySel.spot && (
                <div className="flex items-center bg-[#121822]/90 border border-white/10 h-6 px-2">
                  <select
                    aria-label="Takeoff Runway"
                    value={selectedDepRwy}
                    onChange={(e) => setSelectedDepRwy(e.target.value)}
                    className="w-full bg-transparent text-[11px] font-medium text-slate-300 outline-none truncate"
                  >
                    <option value="">Takeoff: AUTO runway</option>
                    {depRunways.map((r) => (
                      <option key={`to-${r.ident}`} value={r.ident}>Takeoff: RWY {r.ident} ({r.lengthM}m)</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* Center Blue Swap Button */}
            <button
              type="button"
              onClick={() => {
                const prevDep = selectedDep;
                const prevArr = selectedArr;
                onSelectDep?.(prevArr);
                onSelectArr?.(prevDep);
              }}
              className="w-6 h-6 bg-[#1d6ae5] hover:bg-[#2572eb] text-white grid place-items-center shrink-0 transition shadow"
              aria-label="Swap Departure and Arrival"
              title="Swap Departure and Arrival"
            >
              <FlightIcon name="swapHoriz" size={13} />
            </button>

            {/* Right Column: Arrival Input + Arrival Runway */}
            <div className="flex-1 flex flex-col gap-1 min-w-0">
              <MsfsAirportSearchBox
                roleLabel="Arrival"
                value={selectedArr}
                onSelect={(a) => {
                  setCustomInspectedAirport(a);
                  onSelectArr?.(a);
                }}
                onClear={() => onSelectArr?.(null)}
              />
              <div className="flex items-center bg-[#121822]/90 border border-white/10 h-6 px-2">
                <select
                  aria-label="Arrival Runway"
                  disabled={!selectedArr}
                  value={selectedArr ? selectedArrRwy : ''}
                  onChange={(e) => setSelectedArrRwy(e.target.value)}
                  className="w-full bg-transparent text-[11px] font-medium text-slate-300 disabled:text-slate-400 outline-none truncate"
                >
                  {!selectedArr ? (
                    <option value="">Runway</option>
                  ) : (
                    <>
                      <option value="">AUTO approach runway (wind / route)</option>
                      {arrRunways.map((r) => (
                        <option key={`arr-${r.ident}`} value={r.ident}>
                          RWY {r.ident} · LDA {r.ldaM}m · {r.surface} · {String(r.headingDeg).padStart(3, '0')}°M
                        </option>
                      ))}
                    </>
                  )}
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* TOP-RIGHT: FLIGHT CONDITIONS BOX (Clean 265x116 card with UTC time & horizontal blue slider) */}
        <div className="pointer-events-auto w-full lg:w-[265px] h-[116px] shrink-0 bg-[#1e2633]/88 border border-white/10 px-3.5 py-2.5 flex flex-col justify-between shadow-xl relative overflow-visible">
          {/* Header with atmospheric shading */}
          <div>
            <div className="font-bold text-[15px] text-white leading-tight">Flight Conditions</div>
            <div className="flex items-center gap-1.5 mt-1 text-sky-300">
              <FlightIcon name="user" size={12} />
              <FlightIcon name="cloud" size={13} />
            </div>
          </div>

          {/* Middle Row: 14:47 UTC + Custom */}
          <div className="flex items-center justify-between text-xs font-bold text-white">
            <span className="font-mono">{formattedUtc}</span>
            <button
              type="button"
              onClick={() => setConditionsPopoverOpen((o) => !o)}
              className="text-slate-200 hover:text-sky-300 transition font-semibold"
            >
              Custom
            </button>
          </div>

          {/* Bottom Row: Horizontal Blue Time-of-Day Slider Bar (Matches reference images) */}
          <div className="relative h-4 bg-[#142342] border border-white/10 flex items-center overflow-hidden">
            <div
              className="h-full bg-[#2454a4]"
              style={{ width: `${sliderPercent}%` }}
            />
            <div
              className="w-1.5 h-full bg-[#4ea8ff] shrink-0 shadow-[0_0_6px_rgba(78,168,255,0.9)]"
            />
            <input
              type="range"
              aria-label="Flight UTC Time Slider"
              min={300}
              max={1320}
              value={utcMinutes}
              onChange={(e) => {
                const mins = Number(e.target.value);
                setUtcMinutes(mins);
                set({ tod: mins >= 1020 ? 'sunset' : 'day' });
              }}
              className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize"
            />
          </div>

          {/* Optional Compact Custom Weather Popover when clicking 'Custom' */}
          {conditionsPopoverOpen && (
            <div className="absolute top-[122px] right-0 z-40 w-[265px] bg-[#141c27]/96 border border-white/20 p-3 shadow-2xl space-y-2.5 text-xs">
              <div className="flex items-center justify-between border-b border-white/10 pb-1.5">
                <span className="font-bold text-white">Weather &amp; Wind Presets</span>
                <button
                  type="button"
                  onClick={() => setConditionsPopoverOpen(false)}
                  className="text-slate-400 hover:text-white"
                  aria-label="Close Weather Presets"
                >
                  <FlightIcon name="close" size={12} />
                </button>
              </div>
              <div className="grid grid-cols-3 gap-1">
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
                        : 'bg-[#0e141d] border-white/10 text-slate-300 hover:text-white'
                    }`}
                  >
                    {wLabel}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    ['calm', 'Calm 3kt'],
                    ['light', 'Light 10kt'],
                    ['strong', 'Gusty 24kt'],
                  ] as const
                ).map(([windId, windLabel]) => (
                  <button
                    key={windId}
                    type="button"
                    onClick={() => set({ wind: windId })}
                    className={`h-6 text-[11px] font-bold border transition ${
                      settings.wind === windId
                        ? 'bg-[#2572eb] border-sky-300 text-white'
                        : 'bg-[#0e141d] border-white/10 text-slate-300 hover:text-white'
                    }`}
                  >
                    {windLabel}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 3. TOP-LEFT SEARCH LOCATION BAR (Positioned cleanly right under the Aircraft Selection box) */}
      <div
        className={`absolute top-[160px] left-3.5 z-20 w-[265px] pointer-events-auto transition-all duration-500 delay-75 ease-out ${
          entered ? 'translate-x-0 opacity-100' : '-translate-x-4 opacity-0'
        }`}
      >
        <div className="relative">
          <div className="flex items-center bg-[#1e2633]/90 border border-white/10 focus-within:border-sky-400 px-2.5 h-7 shadow-lg">
            <FlightIcon name="search" size={12} className="text-slate-300 mr-2 shrink-0" />
            <input
              aria-label="Search location"
              value={locationQuery}
              onFocus={() => setLocationOpen(true)}
              onBlur={() => setTimeout(() => setLocationOpen(false), 200)}
              onChange={(e) => {
                setLocationQuery(e.target.value);
                setLocationOpen(true);
              }}
              placeholder="Search location"
              className="w-full bg-transparent text-xs text-white placeholder:text-slate-300 outline-none"
            />
            {locationQuery && (
              <button
                type="button"
                onClick={() => setLocationQuery('')}
                className="text-slate-400 hover:text-white"
                aria-label="Clear location search"
              >
                <FlightIcon name="close" size={11} />
              </button>
            )}
          </div>

          {/* Search Location Dropdown: Featured Indonesia Regions + Airport Search Results */}
          {locationOpen && (
            <div className="absolute z-50 left-0 right-0 mt-1 bg-[#111823]/98 border border-white/20 shadow-2xl max-h-72 overflow-y-auto">
              {locationQuery.trim() === '' ? (
                <>
                  <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-sky-300 bg-[#182232]">
                    Indonesia Regions &amp; Hubs ({REPO_FACTS.indonesiaAirports} Airports)
                  </div>
                  {INDONESIAN_REGIONS.map((item) => {
                    const airport = AIRPORT_BY_ID.get(item.icao);
                    if (!airport) return null;
                    return (
                      <button
                        key={item.icao}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setCustomInspectedAirport(airport);
                          globeControlRef?.current?.focusLocation(airport.lat, airport.lon);
                          setLocationQuery(item.label);
                          setLocationOpen(false);
                        }}
                        className="w-full text-left px-3 py-1.5 hover:bg-[#2572eb] border-b border-white/5 last:border-0 flex items-center justify-between gap-2 transition"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-white truncate">{item.label}</div>
                          <div className="text-[10px] text-slate-400 truncate">
                            {item.region} · {airport.icao}
                          </div>
                        </div>
                        <span className="text-[10px] font-mono text-sky-300 shrink-0">Zoom</span>
                      </button>
                    );
                  })}
                </>
              ) : (
                locationResults.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setCustomInspectedAirport(a);
                      globeControlRef?.current?.focusLocation(a.lat, a.lon);
                      setLocationQuery(`${a.icao} - ${a.city || a.name}`);
                      setLocationOpen(false);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-[#2572eb] border-b border-white/5 last:border-0 flex items-center justify-between gap-2 transition"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-white flex items-center gap-1.5">
                        <span className="font-mono text-sky-300">{a.icao}</span>
                        <span className="truncate">{a.name}</span>
                      </div>
                      <div className="text-[10px] text-slate-400 truncate">
                        {a.city}, {a.country}
                      </div>
                    </div>
                    <span className="text-[10px] font-mono text-sky-300 shrink-0">Zoom</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Optional Favourites & Curated Routes Panel (Only shown when toggled via 'Switch to Panels') */}
        {favouritesOpen && (
          <div className="mt-2 bg-[#141c27]/95 border border-white/15 shadow-2xl flex flex-col max-h-[calc(100vh-17rem)] overflow-hidden">
            <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between bg-[#1b2433]">
              <div className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider text-white">
                <FlightIcon name="star" size={12} className="text-sky-400" />
                <span>Favourites &amp; Routes</span>
              </div>
              <div className="flex items-center gap-1 text-[10px] font-bold">
                {(
                  [
                    ['all', 'ALL'],
                    ['id', 'ID'],
                    ['world', 'WORLD'],
                  ] as const
                ).map(([fId, fLabel]) => (
                  <button
                    key={fId}
                    type="button"
                    onClick={() => setRouteFilter(fId)}
                    className={`px-1.5 py-0.5 transition ${
                      routeFilter === fId
                        ? 'bg-[#2572eb] text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {fLabel}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-2 border-b border-white/10 grid grid-cols-3 gap-1.5 bg-[#0e141d]">
              {(['sky', 'trek', 'swift'] as const).map((id) => {
                const v =
                  AIRCRAFT_VARIANTS.find((item) => item.aircraftId === id) || AIRCRAFT_VARIANTS[0];
                const active = aircraftId === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setAircraft(id);
                      setSelectedVariantId(v.variantId);
                    }}
                    className={`text-left border overflow-hidden transition ${
                      active
                        ? 'border-sky-300 bg-[#2572eb]'
                        : 'border-white/10 bg-[#141c29] hover:border-white/30'
                    }`}
                  >
                    <div className="h-11 relative overflow-hidden bg-[#102347]">
                      <AircraftStudioCardVisual
                        variant={v}
                        className="w-full h-full"
                        imgClassName="w-full h-full object-cover"
                      />
                    </div>
                    <div className="px-1.5 py-1">
                      <div className="text-[10px] font-extrabold text-white truncate">
                        {specById(id).name}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-white/5">
              {curatedRoutes.map((r) => {
                const dep = AIRPORT_BY_ID.get(r.fromIcao);
                const arr = AIRPORT_BY_ID.get(r.toIcao);
                if (!dep || !arr) return null;
                const isCurrent = selectedDep?.id === dep.id && selectedArr?.id === arr.id;
                return (
                  <button
                    key={`${r.fromIcao}-${r.toIcao}`}
                    type="button"
                    onClick={() => {
                      onSelectDep?.(dep);
                      onSelectArr?.(arr);
                    }}
                    className={`w-full text-left px-3 py-2 flex items-center justify-between gap-2 transition ${
                      isCurrent ? 'bg-[#2572eb] text-white' : 'hover:bg-white/5 text-slate-200'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-bold truncate">{r.title}</div>
                      <div
                        className={`text-[10px] font-mono truncate ${
                          isCurrent ? 'text-sky-100' : 'text-slate-400'
                        }`}
                      >
                        {dep.icao} to {arr.icao} · {r.subtitle}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* 4. OPTIONAL RIGHT AIRPORT RUNWAY DETAIL DRAWER (Closed by default so globe is unobstructed) */}
      {airportPanelOpen && (
        <div className="hidden lg:flex flex-col absolute top-[160px] right-3.5 z-20 w-[265px] max-h-[calc(100vh-17rem)] bg-[#141c27]/95 border border-white/15 shadow-2xl pointer-events-auto overflow-hidden">
          <div className="px-3 py-2 bg-[#1b2433] border-b border-white/10 flex items-center justify-between">
            <div className="min-w-0">
              <div className="font-mono font-extrabold text-xs text-white truncate">
                {inspectedAirport.icao} — {inspectedAirport.name}
              </div>
              <div className="text-[10px] text-slate-400 truncate">
                {inspectedAirport.city}, {inspectedAirport.country}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setAirportPanelOpen(false)}
              className="text-slate-400 hover:text-white ml-2"
              aria-label="Close Airport Details"
            >
              <FlightIcon name="close" size={12} />
            </button>
          </div>

          <div className="px-2.5 pt-2 pb-1 grid grid-cols-2 gap-1 bg-[#141c27] border-b border-white/10">
            <button
              type="button"
              onClick={() => onSelectDep?.(inspectedAirport)}
              className={`h-6 px-2 text-[10px] font-bold flex items-center justify-center gap-1 transition ${
                selectedDep?.id === inspectedAirport.id
                  ? 'bg-emerald-600 text-white'
                  : 'bg-[#1f2937] text-emerald-300 hover:bg-emerald-600 hover:text-white'
              }`}
            >
              <FlightIcon name="plane" size={11} />
              <span>Set Departure</span>
            </button>
            <button
              type="button"
              onClick={() => onSelectArr?.(inspectedAirport)}
              className={`h-6 px-2 text-[10px] font-bold flex items-center justify-center gap-1 transition ${
                selectedArr?.id === inspectedAirport.id
                  ? 'bg-[#2572eb] text-white'
                  : 'bg-[#1f2937] text-sky-300 hover:bg-[#2572eb] hover:text-white'
              }`}
            >
              <FlightIcon name="route" size={11} />
              <span>Set Arrival</span>
            </button>
          </div>

          <div className="px-2.5 pt-2 pb-1.5 grid grid-cols-2 gap-1 bg-[#141c27]">
            <button
              type="button"
              onClick={() => setAirportTab('runways')}
              className={`h-6 px-2 text-[11px] font-bold flex items-center justify-between transition ${
                airportTab === 'runways'
                  ? 'bg-[#2572eb] text-white'
                  : 'bg-[#1f2937] text-slate-300 hover:text-white'
              }`}
            >
              <span>Runways</span>
              {airportTab === 'runways' && <FlightIcon name="check" size={11} />}
            </button>
            <button
              type="button"
              onClick={() => setAirportTab('frequencies')}
              className={`h-6 px-2 text-[11px] font-bold flex items-center justify-between transition ${
                airportTab === 'frequencies'
                  ? 'bg-[#2572eb] text-white'
                  : 'bg-[#1f2937] text-slate-300 hover:text-white'
              }`}
            >
              <span>Frequencies</span>
              {airportTab === 'frequencies' && <FlightIcon name="check" size={11} />}
            </button>
          </div>

          {airportTab === 'runways' ? (
            <div className="flex-1 overflow-y-auto divide-y divide-white/5 text-xs">
              {inspectedRunways.map((r) => (
                <div key={`${r.pairIdent}-${r.ident}`} className="w-full px-3 py-1.5 text-slate-200">
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-bold">{r.ident}</span>
                    <span className="font-mono text-[11px] text-slate-300">
                      {r.lengthM} × {r.widthM} m · {String(r.headingDeg).padStart(3, '0')}°M
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-slate-400">
                    <span>
                      {r.surface}{r.lit ? ' · lit' : ' · unlit'}{r.dispM > 0 ? ` · displaced ${r.dispM} m` : ''}{r.approx ? ' · position approx.' : ''}
                    </span>
                    <span className="flex gap-1">
                      <button type="button" disabled={selectedDep?.id !== inspectedAirport.id} onClick={() => setSelectedDepRwy(r.ident)}
                        className={`px-1.5 h-4 font-bold ${selectedDep?.id === inspectedAirport.id ? (selectedDepRwy === r.ident ? 'bg-[#2572eb] text-white' : 'bg-[#1f2937] text-sky-300 hover:bg-[#2572eb] hover:text-white') : 'bg-[#1a2230] text-slate-600'}`}>DEP</button>
                      <button type="button" disabled={selectedArr?.id !== inspectedAirport.id} onClick={() => setSelectedArrRwy(r.ident)}
                        className={`px-1.5 h-4 font-bold ${selectedArr?.id === inspectedAirport.id ? (selectedArrRwy === r.ident ? 'bg-[#2572eb] text-white' : 'bg-[#1f2937] text-sky-300 hover:bg-[#2572eb] hover:text-white') : 'bg-[#1a2230] text-slate-600'}`}>ARR</button>
                    </span>
                  </div>
                </div>
              ))}
              <div className="px-3 py-1.5 text-[10px] text-slate-400 font-mono">
                {(() => {
                  const L = getAirfield(inspectedAirport);
                  return L
                    ? `Ground layout (OSM): ${L.taxiways.length} taxiways · ${L.aprons.length} aprons · ${L.stands.length} stands · ${L.hangars.length} hangars`
                    : 'Ground layout: runways only (no taxiway survey available)';
                })()}
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-3 space-y-2 text-xs">
              <div className="space-y-1 font-mono text-[11px]">
                {frequenciesFor(inspectedAirport.id).length === 0 && (
                  <div className="py-1 text-slate-400">No published radio frequencies for this airfield.</div>
                )}
                {frequenciesFor(inspectedAirport.id).map((f, i) => (
                  <div key={`${f.type}-${i}`} className="flex justify-between py-1 border-b border-white/10">
                    <span className="text-slate-400">{f.label}</span>
                    <span className="text-white font-bold">{f.mhz.toFixed(3).replace(/0$/, '')} MHz</span>
                  </div>
                ))}
                <div className="flex justify-between py-1 border-b border-white/10">
                  <span className="text-slate-400">Magnetic variation</span>
                  <span className="text-amber-300 font-bold">{fmtVar(magVar(inspectedAirport.lat, inspectedAirport.lon))}</span>
                </div>
                {navaidsNear(inspectedAirport.lat, inspectedAirport.lon, 45000).slice(0, 6).map((n) => (
                  <div key={`${n.ident}-${n.type}-${n.freqKhz}`} className="flex justify-between py-1 border-b border-white/10">
                    <span className="text-slate-400">{n.type} {n.ident}</span>
                    <span className="text-emerald-300 font-bold">{navaidFreqLabel(n)}</span>
                  </div>
                ))}
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wider font-bold text-slate-400 mb-1">
                  3D Terrain Style
                </label>
                <select
                  aria-label="3D Terrain Style"
                  value={settings.terrainStyle}
                  onChange={(e) => set({ terrainStyle: e.target.value })}
                  className="w-full bg-[#0e141d] border border-white/15 px-2 py-1 text-xs text-white outline-none"
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
        </div>
      )}

      {/* 5. EFB FLOATING DRAWER (When toggled via [T] EFB) */}
      {efbOpen && (
        <div className="absolute bottom-28 right-3.5 z-30 w-[320px] sm:w-[360px] bg-[#141c27]/96 border border-sky-400/40 shadow-2xl p-3.5 space-y-2.5 pointer-events-auto">
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <div className="flex items-center gap-2">
              <span className="px-1.5 py-0.5 bg-[#2572eb] text-[10px] font-mono font-bold text-white">
                EFB
              </span>
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
              <FlightIcon name="close" size={13} />
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1.5 text-center bg-[#0c1119] p-2 border border-white/10">
            <div>
              <div className="font-mono font-extrabold text-xs text-white">
                {dispatch.distanceNm}
              </div>
              <div className="text-[9px] uppercase text-slate-400 font-bold">Dist (NM)</div>
            </div>
            <div>
              <div className="font-mono font-extrabold text-xs text-sky-300">
                {String(dispatch.bearingDeg).padStart(3, '0')}°
              </div>
              <div className="text-[9px] uppercase text-slate-400 font-bold">Course</div>
            </div>
            <div>
              <div className="font-mono font-extrabold text-xs text-emerald-300">
                {dispatch.eteFormatted}
              </div>
              <div className="text-[9px] uppercase text-slate-400 font-bold">Est Time</div>
            </div>
            <div>
              <div className="font-mono font-extrabold text-xs text-amber-300">
                FL{dispatch.plannedFlightLevel}
              </div>
              <div className="text-[9px] uppercase text-slate-400 font-bold">Cruise</div>
            </div>
          </div>
        </div>
      )}

      {/* 6. BOTTOM BAR: BACK / SELECT (Left), SWITCH TO PANELS / ZOOM (Center), SCALE + EFB + START FLIGHT (Right) */}
      <div
        className={`absolute bottom-3 left-3.5 right-3.5 z-20 flex items-end justify-between pointer-events-none transition-all duration-500 delay-100 ease-out ${
          entered ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
        }`}
      >
        {/* Bottom-Left: Back & Select (Matches reference images) */}
        <div className="pointer-events-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onBack}
            className="px-3.5 py-1.5 bg-[#1a2029]/90 hover:bg-[#2572eb] border border-white/15 text-xs font-bold text-white transition shadow"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => globeControlRef?.current?.resetGlobeView()}
            className="px-3.5 py-1.5 bg-[#1a2029]/90 hover:bg-white/15 border border-white/15 text-xs font-bold text-white transition shadow"
          >
            Select
          </button>
          {selectedDep && selectedArr && (
            <button
              type="button"
              onClick={() => globeControlRef?.current?.focusRoute(selectedDep, selectedArr)}
              className="px-3 py-1.5 bg-[#1d6ae5]/90 hover:bg-[#2572eb] border border-sky-300/30 text-xs font-bold text-white transition shadow"
            >
              Route View
            </button>
          )}
        </div>

        {/* Bottom-Center: Switch to Panels | NUM SUB / NUM PLUS Zoom */}
        <div className="pointer-events-auto hidden md:flex items-center gap-2 px-4 py-1.5 bg-[#1a2029]/90 border border-white/10 text-xs text-slate-200 shadow-xl">
          <button
            type="button"
            onClick={() => setFavouritesOpen((o) => !o)}
            className="font-bold hover:text-sky-300 transition"
          >
            Switch to Panels
          </button>
          <button
            type="button"
            onClick={() => globeControlRef?.current?.zoomBy(-1)}
            className="px-1.5 py-0.5 bg-white/15 hover:bg-white/25 font-mono text-[10px] font-bold text-white"
            aria-label="Zoom out world globe"
          >
            NUM SUB
          </button>
          <span>/</span>
          <button
            type="button"
            onClick={() => globeControlRef?.current?.zoomBy(1)}
            className="px-1.5 py-0.5 bg-white/15 hover:bg-white/25 font-mono text-[10px] font-bold text-white"
            aria-label="Zoom in world globe"
          >
            NUM PLUS
          </button>
          <span className="font-bold">Zoom</span>
        </div>

        {/* Bottom-Right: Scale Indicator + Blue 3-Icon Strip + Blue [T] EFB Bar + Start Flight Bar */}
        <div className="pointer-events-auto flex flex-col items-end gap-1.5 w-[250px] sm:w-[265px]">
          {/* Scale Bar ("1000 km", "20 km", "500 m") with 1:1 true geodesic pixel width */}
          <div className="w-full flex items-end justify-between pl-4">
            <div className="flex flex-col items-center text-[11px] font-semibold text-white drop-shadow">
              <div
                style={{ width: `${Math.round(scalePx)}px` }}
                className="h-1.5 border-l border-r border-b border-white/90 mb-0.5 transition-[width] duration-150"
              />
              <span>
                {scaleKm < 1
                  ? `${Math.round(scaleKm * 1000)} m`
                  : `${scaleKm >= 10 ? Math.round(scaleKm) : scaleKm.toFixed(1)} km`}
              </span>
            </div>

            <div className="flex items-center bg-[#1d6ae5] border border-sky-300/30 shadow-lg divide-x divide-white/20">
              <button
                type="button"
                onClick={() => setModal('credits')}
                className="w-8 h-6 grid place-items-center text-white hover:bg-[#2572eb] transition"
                aria-label="Aeronautical Data Information"
                title="Aeronautical Data Information"
              >
                <FlightIcon name="info" size={13} />
              </button>
              <button
                type="button"
                onClick={() => globeControlRef?.current?.resetGlobeView()}
                className="w-8 h-6 grid place-items-center text-white hover:bg-[#2572eb] transition"
                aria-label="Reset Globe View"
                title="Reset Full Globe View"
              >
                <FlightIcon name="layers" size={13} />
              </button>
              <button
                type="button"
                onClick={() => setAirportPanelOpen((o) => !o)}
                className="w-8 h-6 grid place-items-center text-white hover:bg-[#2572eb] transition"
                aria-label="Toggle Airport Runways Panel"
                title="Toggle Airport Runways Panel"
              >
                <FlightIcon name="list" size={13} />
              </button>
            </div>
          </div>

          {/* Blue [T] EFB Bar */}
          <button
            type="button"
            onClick={() => setEfbOpen((o) => !o)}
            className="w-full h-8 px-2.5 bg-[#1d6ae5] hover:bg-[#2572eb] text-white font-bold text-xs flex items-center justify-between shadow-lg transition"
          >
            <div className="flex items-center gap-2">
              <kbd className="px-1.5 py-0.5 bg-[#123e8a] border border-sky-300/40 font-mono text-[10px]">
                T
              </kbd>
              <span>EFB</span>
            </div>
            {selectedDep && selectedArr && (
              <span className="text-[10px] font-mono text-sky-100">
                {selectedDep.icao} → {selectedArr.icao}
              </span>
            )}
          </button>

          {/* Start Flight Button (Muted olive-gold when no airport selected, bright gold once selected) */}
          <button
            type="button"
            disabled={!canStartSelectedFlight}
            onClick={handleStartFlight}
            className={`w-full h-9 px-2.5 font-extrabold text-xs flex items-center justify-between transition shadow-lg ${
              canStartSelectedFlight
                ? 'bg-[#eab308] hover:bg-[#facc15] text-slate-950 cursor-pointer'
                : 'bg-[#655b1e]/85 text-slate-300/70 cursor-not-allowed'
            }`}
          >
            <div className="flex items-center gap-1.5">
              <kbd className="px-1.5 py-0.5 bg-black/15 border border-current/30 font-mono text-[10px] font-bold">
                CTRL
              </kbd>
              <span className="text-[10px] font-mono">+</span>
              <kbd className="px-1.5 py-0.5 bg-black/15 border border-current/30 font-mono text-[10px] font-bold">
                ↵
              </kbd>
              <span className="ml-1 tracking-tight text-sm">Start flight</span>
            </div>
            <FlightIcon name="plane" size={14} />
          </button>
        </div>
      </div>

      {/* 7. FULL-SCREEN CHANGE AIRCRAFT HANGAR MODAL */}
      {hangarOpen && (
        <div className="pointer-events-auto">
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
        </div>
      )}

      {/* 8. UTILITY MODALS */}
      {modal === 'scores' && (
        <div className="pointer-events-auto">
          <Modal title="Pilot Logbook & High Scores" onClose={() => setModal(null)}>
            <ScoresPanel />
          </Modal>
        </div>
      )}
      {modal === 'settings' && (
        <div className="pointer-events-auto">
          <Modal title="Simulation Settings" onClose={() => setModal(null)}>
            <SettingsPanel s={settings} set={set} />
          </Modal>
        </div>
      )}
      {modal === 'controls' && (
        <div className="pointer-events-auto">
          <Modal title="Keyboard & Controller Flight Map" wide onClose={() => setModal(null)}>
            <ControlsPanel />
          </Modal>
        </div>
      )}
      {modal === 'credits' && (
        <div className="pointer-events-auto">
          <Modal title="Aeronautical Data & Repository Architecture" onClose={() => setModal(null)}>
            <ul className="text-sm text-slate-300 space-y-2.5 list-disc pl-5">
              <li>
                <b>OurAirports + OpenStreetMap</b> — {REPO_FACTS.totalAirports.toLocaleString()} airfields, {REPO_FACTS.indonesiaAirports} in Indonesia (every mapped runway incl. grass/gravel strips) with surveyed centrelines, surfaces, displaced thresholds and taxiway/apron/stand layouts for {REPO_FACTS.indonesiaWithLayout}. Headings are magnetic (WMM2025).
              </li>
              <li>
                <b>3D Terrain &amp; Elevation</b> — {REPO_FACTS.terrainSource} heightmaps paired with {REPO_FACTS.vectorSource} road, water, and building footprints.
              </li>
              <li>
                <b>Satellite Orthophotos</b> — {REPO_FACTS.imagerySource}, OpenTopoMap, and CARTO vector styles.
              </li>
              <li>
                <b>Flight Dynamics &amp; Avionics</b> — Rigid-body 6-DOF aerodynamics, 3-axis PID autopilot, LNAV/ILS approach capture, and procedural Web Audio synthesis.
              </li>
            </ul>
          </Modal>
        </div>
      )}
    </div>
  );
}
