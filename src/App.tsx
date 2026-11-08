import { useCallback, useEffect, useRef, useState, useReducer } from 'react';
import { Game, HudState, Phase, Result, Toast, ScenarioConfig } from './sim/game';
import { AIRPORT_BY_ID, Airport, DEFAULT_FROM, DEFAULT_TO } from './data/airports';
import { Settings, loadSettings, saveSettings, loadRoute, saveRoute, loadScores } from './sim/storage';
import { StartScreen } from './ui/Screens';
import { Planner } from './ui/Planner';
import { refineWithin } from './data/runwayRefine';
import { GlobeControlHandle, InteractiveEarthGlobe } from './ui/PreGameVisuals';
import { nextHudMode } from './ui/navigation';
import { flightWorkspaceReducer, INITIAL_WORKSPACE } from './ui/flightWorkspace';
import type { NavigationMapView } from './ui/MapPanel';
import { Hud, ReadyScreen, PauseMenu, ResultScreen, FullMap } from './ui/Hud';
import { BootLoader, FlightLoader, type BootTasks } from './ui/Loaders';
import { loadState } from './sim/loadState';
import { AIRCRAFT_STUDIO_IMAGES, MENU_BENTO_TILES } from './ui/flightDispatch';

type Screen = 'start' | 'planner' | 'flight';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const globeControlRef = useRef<GlobeControlHandle | null>(null);
  const saved = useRef(loadRoute()).current;
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const [screen, setScreen] = useState<Screen>('start');
  const screenRef = useRef(screen); screenRef.current = screen;
  const [transitioningMenuExit, setTransitioningMenuExit] = useState(false);
  const [openHangarOnEnter, setOpenHangarOnEnter] = useState(false);
  const [menuBgMode, setMenuBgMode] = useState<'globe' | 'airport'>('globe');
  const [aircraftId, setAircraft] = useState(saved?.aircraft || 'sky');
  const [from, setFrom] = useState<Airport>(AIRPORT_BY_ID.get(saved?.from || DEFAULT_FROM) || AIRPORT_BY_ID.get(DEFAULT_FROM)!);
  const [to, setTo] = useState<Airport>(AIRPORT_BY_ID.get(saved?.to || DEFAULT_TO) || AIRPORT_BY_ID.get(DEFAULT_TO)!);
  const [rwySel, setRwySel] = useState<{ dep: string; arr: string; spot: string }>({ dep: '', arr: '', spot: '' });
  const launchPlan = useRef(false);
  const rwySelRef = useRef(rwySel); rwySelRef.current = rwySel;
  const [selectedDep, setSelectedDep] = useState<Airport | null>(null);
  const [selectedArr, setSelectedArr] = useState<Airport | null>(null);
  const selectedDepRef = useRef(selectedDep); selectedDepRef.current = selectedDep;
  const selectedArrRef = useRef(selectedArr); selectedArrRef.current = selectedArr;
  const [scaleInfo, setScaleInfo] = useState<{ km: number; px: number }>({ km: 1000, px: 80 });
  const [hud, setHud] = useState<HudState | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const mapView = useRef<NavigationMapView | null>(null);
  const [workspace, dispatchWorkspace] = useReducer(flightWorkspaceReducer, INITIAL_WORKSPACE);
  const [game, setGame] = useState<Game | null>(null);
  const [attractReady, setAttractReady] = useState(false);
  // Loading screens: `launching` covers the gap between pressing FLY and Game.load() (airfield survey), `booting` the first paint.
  const [launching, setLaunching] = useState(false);
  const launchingRef = useRef(false);
  const [booting, setBooting] = useState(true);
  const [bootTasks, setBootTasks] = useState<BootTasks>({ images: 0, globe: 0, engine: false });
  const onBootDone = useCallback(() => setBooting(false), []);
  const onGlobeProgress = useCallback((f: number) => setBootTasks((t) => (f > t.globe ? { ...t, globe: f } : t)), []);
  const cur = useRef({ aircraftId, from, to }); cur.current = { aircraftId, from, to };

  const setSettings = useCallback((p: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...p }; setSettingsState(next); saveSettings(next); gameRef.current?.applySettings(next);
  }, []);

  const cfgOf = useCallback((s: Settings): ScenarioConfig => ({ aircraftId: cur.current.aircraftId, from: cur.current.from, to: cur.current.to, settings: s }), []);

  // ---- create the game once ----
  useEffect(() => {
    const g = new Game(canvasRef.current!, {
      onHud: (h) => setHud(h),
      onToast: (t) => { setToasts((l) => [...l.slice(-5), t]); setTimeout(() => setToasts((l) => l.filter((x) => x.id !== t.id)), 4800); },
      onPhase: (p) => {
        setPhase(p);
        if (p === 'playing') setResult(null);
        if (p === 'idle' && g.mode === 'attract') setAttractReady(true);
        if (p === 'paused' || p === 'crashed' || p === 'complete') setMapOpen(false);
      },
      onResult: (r) => {
        setResult(r);
        setMapOpen(false);
      },
      onCommand: (c) => {
        if (c === 'map' || c === 'fullMap') { gameRef.current?.clearInput(); setMapOpen((open) => !open); }
        else if (c === 'cycleHudMode') {
          setSettings({ hudMode: nextHudMode(settingsRef.current.hudMode) });
        }
      },
    });
    gameRef.current = g; setGame(g); (window as any).__sky = g;
    g.suspended = true;
    setAttractReady(true);
    setBootTasks((t) => ({ ...t, engine: true }));
    return () => { g.dispose(); gameRef.current = null; };
    // eslint-disable-next-line
  }, []);


  // ---- first visit: decode the menu photography before the menu is revealed (it is otherwise fetched tile by tile) ----
  useEffect(() => {
    let cancelled = false;
    const urls = Array.from(new Set([...MENU_BENTO_TILES.map((t) => t.imageUrl), AIRCRAFT_STUDIO_IMAGES.sky]));
    let settled = 0;
    const settle = () => { settled++; if (!cancelled) setBootTasks((t) => ({ ...t, images: settled / urls.length })); };
    for (const url of urls) {
      const img = new Image();
      img.decoding = 'async';
      let once = false;
      const done = () => { if (!once) { once = true; clearTimeout(timer); settle(); } };
      const timer = window.setTimeout(done, 9000); // offline / slow CDN: the tiles have solid fallbacks, never wait forever
      img.src = url;
      (typeof img.decode === 'function' ? img.decode() : Promise.reject()).then(done, done);
    }
    return () => { cancelled = true; };
  }, []);

  const loadAttract = useCallback(() => {
    const g = gameRef.current; if (!g) return;
    setResult(null); setMapOpen(false);
    if (menuBgMode === 'airport') {
      g.suspended = false;
      setAttractReady(false);
      g.load(cfgOf(settingsRef.current), 'attract');
    } else {
      g.suspended = true;
      setAttractReady(true);
    }
  }, [cfgOf, menuBgMode]);

  const startFlight = useCallback(async () => {
    const g = gameRef.current; if (!g || launchingRef.current) return; const s = settingsRef.current;
    // The loading screen goes up immediately: the survey below can take seconds on a slow network.
    launchingRef.current = true; loadState.begin('dispatch'); setLaunching(true);
    // Make sure both airfields use surveyed (OpenStreetMap) runway geometry before the scenery is built.
    try { await Promise.all([refineWithin(cur.current.from, 3500), refineWithin(cur.current.to, 3500)]); } catch { /* keep the approximate runways */ }
    saveRoute({ from: cur.current.from.id, to: cur.current.to.id, aircraft: cur.current.aircraftId });
    setTransitioningMenuExit(false);
    g.suspended = false; mapView.current = null; setResult(null); setMapOpen(false); dispatchWorkspace({ type: 'close' }); setScreen('flight'); setToasts([]);
    const plan = launchPlan.current ? rwySelRef.current : null;
    // Game.load() switches the phase to 'loading' synchronously, so `launching` can be dropped in the same React batch.
    const loading = g.load({ ...cfgOf(s), depRwy: plan?.dep || undefined, arrRwy: plan?.arr || undefined, startSpot: plan && s.startMode === 'runway' ? plan.spot || undefined : undefined }, 'play', s.startMode);
    launchingRef.current = false; setLaunching(false);
    loading.catch((e) => { console.error('[flight] scenario failed to load', e); loadState.fail('The flight could not be prepared. Check your connection and try again.'); });
  }, [cfgOf]);

  const quick = useCallback(() => { launchPlan.current = false; startFlight(); }, [startFlight]);
  const toMenu = useCallback(() => { gameRef.current?.stopRadio(); setOpenHangarOnEnter(false); setTransitioningMenuExit(false); setScreen('start'); loadAttract(); }, [loadAttract]);
  const toPlanner = useCallback((withHangar = false) => {
    const g = gameRef.current;
    setOpenHangarOnEnter(withHangar);
    // Start route selection with no pre-selected airport so the full globe is shown first
    setSelectedDep(null);
    setSelectedArr(null);
    setRwySel({ dep: '', arr: '', spot: '' });
    if (screenRef.current === 'start') {
      setTransitioningMenuExit(true);
      window.setTimeout(() => setTransitioningMenuExit(false), 380);
    }
    setScreen('planner');
    if (g) { g.suspended = true; g.stopRadio(); }
    setResult(null);
    setMapOpen(false);
  }, []);

  // when airports change on the start screen keep background in sync
  useEffect(() => { if (screen === 'start' && gameRef.current && attractReady) { /* background already loaded for current departure */ } }, [screen, attractReady]);

  // planner → back to menu reloads attract if departure changed
  const backFromPlanner = useCallback(() => { gameRef.current?.stopRadio(); setOpenHangarOnEnter(false); setTransitioningMenuExit(false); setScreen('start'); loadAttract(); }, [loadAttract]);

  // Selecting one endpoint never auto-fills the other one. If the user picks the airport that is
  // currently set on the opposite field, that opposite field is simply cleared (no silent WIII default).
  const selectDep = useCallback((airport: Airport | null) => {
    setSelectedDep(airport);
    setRwySel((r) => ({ ...r, dep: '', spot: '' }));
    if (!airport) return;
    setFrom(airport);
    cur.current.from = airport;
    setSelectedArr((prev) => (prev && prev.id === airport.id ? null : prev));
    // Fly to the runway the aircraft will actually use (best runway towards the arrival), not the airport reference point.
    globeControlRef.current?.focusRunway(airport, '', 'dep', selectedArrRef.current && selectedArrRef.current.id !== airport.id ? selectedArrRef.current : null);
  }, []);

  const selectArr = useCallback((airport: Airport | null) => {
    setSelectedArr(airport);
    setRwySel((r) => ({ ...r, arr: '' }));
    if (!airport) return;
    setTo(airport);
    cur.current.to = airport;
    setSelectedDep((prev) => (prev && prev.id === airport.id ? null : prev));
    globeControlRef.current?.focusRunway(airport, '', 'arr', selectedDepRef.current && selectedDepRef.current.id !== airport.id ? selectedDepRef.current : null);
  }, []);

  const handleSelectAirport = useCallback((airport: Airport, role: 'from' | 'to') => {
    if (role === 'from') selectDep(airport);
    else selectArr(airport);
  }, [selectDep, selectArr]);

  const handleSelectRunway = useCallback((airport: Airport, rwyIdent: string, role?: 'dep' | 'arr') => {
    if (role === 'arr' || (selectedArrRef.current?.id === airport.id && selectedDepRef.current?.id !== airport.id)) {
      if (selectedArrRef.current?.id !== airport.id) {
        setSelectedArr(airport);
        setTo(airport);
        cur.current.to = airport;
        setSelectedDep((prev) => (prev && prev.id === airport.id ? null : prev));
      }
      setRwySel((r) => ({ ...r, arr: rwyIdent }));
    } else {
      if (selectedDepRef.current?.id !== airport.id) {
        setSelectedDep(airport);
        setFrom(airport);
        cur.current.from = airport;
        setSelectedArr((prev) => (prev && prev.id === airport.id ? null : prev));
      }
      setRwySel((r) => ({ ...r, dep: rwyIdent, spot: '' }));
    }
  }, []);

  const fallbackAirport = (avoid: Airport | null, preferred: string, alternate: string) =>
    avoid && avoid.id === preferred ? AIRPORT_BY_ID.get(alternate)! : AIRPORT_BY_ID.get(preferred)!;

  // Only when the flight actually starts do we fill a missing endpoint with a sensible default
  const flyFromPlanner = useCallback(() => {
    const dep = selectedDepRef.current || fallbackAirport(selectedArrRef.current, DEFAULT_FROM, DEFAULT_TO);
    const arr = selectedArrRef.current || fallbackAirport(dep, DEFAULT_TO, DEFAULT_FROM);
    setFrom(dep);
    setTo(arr);
    cur.current.from = dep;
    cur.current.to = arr;
    launchPlan.current = true;
    startFlight();
  }, [startFlight]);

  const handleFlyNowFromGlobe = useCallback((airport: Airport) => {
    setSelectedDep(airport);
    setFrom(airport);
    cur.current.from = airport;
    const arr = selectedArrRef.current && selectedArrRef.current.id !== airport.id
      ? selectedArrRef.current
      : fallbackAirport(airport, DEFAULT_TO, DEFAULT_FROM);
    setTo(arr);
    cur.current.to = arr;
    launchPlan.current = false;
    startFlight();
  }, [startFlight]);

  const best = loadScores()[0]?.score || 0;
  const g = game;
  const playing = screen === 'flight' && g && hud;
  const showHud = playing && (phase === 'playing' || phase === 'paused' || phase === 'crashed' || phase === 'complete' || phase === 'idle');

  return (
    <div className="fixed inset-0 bg-[#020408] overflow-hidden font-sans" style={{ touchAction: 'none' }}>
      <canvas ref={canvasRef} tabIndex={-1} aria-label="Flight view" className="absolute inset-0 w-full h-full block outline-none" />
      {(screen === 'start' || screen === 'planner') && (
        <div
          className={`fixed inset-0 z-0 bg-[#020408] transition-opacity duration-500 ${
            screen === 'start' && menuBgMode === 'airport' ? 'opacity-0 pointer-events-none' : 'opacity-100'
          }`}
        >
          <InteractiveEarthGlobe
            mode={screen === 'start' ? 'menu' : 'planner'}
            focusLat={-2.5}
            focusLon={115.0}
            selectedDep={selectedDep}
            selectedArr={selectedArr}
            depRunway={rwySel.dep}
            arrRunway={rwySel.arr}
            onSelectAirport={handleSelectAirport}
            onSelectRunway={handleSelectRunway}
            onFlyNow={handleFlyNowFromGlobe}
            onScaleKmChange={(km, px) => setScaleInfo({ km, px })}
            onLoadProgress={onGlobeProgress}
            controlRef={globeControlRef}
            className="w-full h-full pointer-events-auto"
          />
        </div>
      )}
      {screen === 'planner' && (
        <Planner
          settings={settings}
          setSettings={(s) => setSettings(s)}
          aircraftId={aircraftId}
          setAircraft={setAircraft}
          from={from}
          to={to}
          selectedDep={selectedDep}
          selectedArr={selectedArr}
          onSelectDep={selectDep}
          onSelectArr={selectArr}
          setFrom={setFrom}
          setTo={setTo}
          rwySel={rwySel}
          setRwySel={setRwySel}
          onFly={flyFromPlanner}
          onBack={backFromPlanner}
          initialHangarOpen={openHangarOnEnter}
          globeControlRef={globeControlRef}
          scaleKm={scaleInfo.km}
          scalePx={scaleInfo.px}
        />
      )}
      {(screen === 'start' || transitioningMenuExit) && (
        <StartScreen
          onStart={() => toPlanner(false)}
          onOpenHangar={() => toPlanner(true)}
          onQuick={quick}
          settings={settings}
          set={setSettings}
          bestScore={best}
          ready={attractReady}
          exiting={screen !== 'start'}
          hideGlobe
          bgMode={menuBgMode}
          onToggleBgMode={() => {
            // Side effects stay out of the setState updater: StrictMode invokes updaters twice, which loaded the scene twice.
            const next = menuBgMode === 'globe' ? 'airport' : 'globe';
            const gInst = gameRef.current;
            if (gInst) {
              if (next === 'airport') {
                gInst.suspended = false;
                void gInst.load(cfgOf(settingsRef.current), 'attract');
              } else {
                gInst.suspended = true;
                gInst.stopRadio();
              }
            }
            setMenuBgMode(next);
          }}
        />
      )}
      <FlightLoader active={launching || (screen === 'flight' && !!g && phase === 'loading')} hud={hud} from={from} to={to} aircraft={g?.spec?.name || ''} onAbort={toMenu} />
      {showHud && hud && g && <Hud game={g} hud={hud} toasts={toasts} settings={settings} setSettings={setSettings} onMap={() => { g.clearInput(); setMapOpen(true); }} mapOpen={mapOpen} mapViewRef={mapView} workspace={workspace} dispatchWorkspace={dispatchWorkspace} from={from} to={to} phase={phase} />}
      {playing && phase === 'idle' && g!.mode === 'play' && <ReadyScreen hud={hud!} from={from} to={to} aircraft={g!.spec.name} onGo={() => g!.begin()} />}
      {playing && phase === 'paused' && !mapOpen && <PauseMenu game={g!} settings={settings} setSettings={setSettings} onMenu={toMenu} onResume={() => g!.resume()} />}
      {playing && mapOpen && phase !== 'crashed' && <FullMap game={g!} hud={hud!} from={from} to={to} settings={settings} setSettings={setSettings} viewStateRef={mapView} onClose={() => setMapOpen(false)} />}
      {playing && result && (phase === 'crashed' || phase === 'complete') && <ResultScreen r={result} onRetry={() => { setResult(null); g!.restart(); }} onNew={() => toPlanner(false)} onMenu={toMenu} />}
      {playing && phase === 'crashed' && !result && <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(255,70,0,.25), rgba(120,0,0,.55))' }} />}
      {booting && <BootLoader tasks={bootTasks} onDone={onBootDone} />}
    </div>
  );
}
