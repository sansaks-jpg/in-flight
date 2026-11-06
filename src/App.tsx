import { useCallback, useEffect, useRef, useState, useReducer } from 'react';
import { Game, HudState, Phase, Result, Toast, ScenarioConfig } from './sim/game';
import { AIRPORT_BY_ID, Airport, DEFAULT_FROM, DEFAULT_TO } from './data/airports';
import { Settings, loadSettings, saveSettings, loadRoute, saveRoute, loadScores } from './sim/storage';
import { StartScreen } from './ui/Screens';
import { Planner } from './ui/Planner';
import { GlobeControlHandle, InteractiveEarthGlobe } from './ui/PreGameVisuals';
import { nextHudMode } from './ui/navigation';
import { flightWorkspaceReducer, INITIAL_WORKSPACE } from './ui/flightWorkspace';
import type { NavigationMapView } from './ui/MapPanel';
import { Hud, LoadingScreen, ReadyScreen, PauseMenu, ResultScreen, FullMap } from './ui/Hud';

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
  const [selectedDep, setSelectedDep] = useState<Airport | null>(null);
  const [selectedArr, setSelectedArr] = useState<Airport | null>(null);
  const [scaleKm, setScaleKm] = useState<number>(107.68);
  const [hud, setHud] = useState<HudState | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const mapView = useRef<NavigationMapView | null>(null);
  const [workspace, dispatchWorkspace] = useReducer(flightWorkspaceReducer, INITIAL_WORKSPACE);
  const [game, setGame] = useState<Game | null>(null);
  const [attractReady, setAttractReady] = useState(false);
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
    return () => { g.dispose(); gameRef.current = null; };
    // eslint-disable-next-line
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

  const startFlight = useCallback(() => {
    const g = gameRef.current; if (!g) return; const s = settingsRef.current;
    saveRoute({ from: cur.current.from.id, to: cur.current.to.id, aircraft: cur.current.aircraftId });
    setTransitioningMenuExit(false);
    g.suspended = false; mapView.current = null; setResult(null); setMapOpen(false); dispatchWorkspace({ type: 'close' }); setScreen('flight'); setToasts([]);
    g.load(cfgOf(s), 'play', s.startMode);
  }, [cfgOf]);

  const quick = useCallback(() => { startFlight(); }, [startFlight]);
  const toMenu = useCallback(() => { setOpenHangarOnEnter(false); setTransitioningMenuExit(false); setScreen('start'); loadAttract(); }, [loadAttract]);
  const toPlanner = useCallback((withHangar = false) => {
    const g = gameRef.current;
    setOpenHangarOnEnter(withHangar);
    // Start route selection with no pre-selected airport so the full globe is shown first
    setSelectedDep(null);
    setSelectedArr(null);
    if (screenRef.current === 'start') {
      setTransitioningMenuExit(true);
      window.setTimeout(() => setTransitioningMenuExit(false), 380);
    }
    setScreen('planner');
    if (g) { g.suspended = true; g.audio.silence(); }
    setResult(null);
    setMapOpen(false);
  }, []);

  // when airports change on the start screen keep background in sync
  useEffect(() => { if (screen === 'start' && gameRef.current && attractReady) { /* background already loaded for current departure */ } }, [screen, attractReady]);

  // planner → back to menu reloads attract if departure changed
  const backFromPlanner = useCallback(() => { setOpenHangarOnEnter(false); setTransitioningMenuExit(false); setScreen('start'); loadAttract(); }, [loadAttract]);

  const handleSelectAirport = useCallback((airport: Airport, role: 'from' | 'to') => {
    if (role === 'from') {
      setSelectedDep(airport);
      setFrom(airport);
      cur.current.from = airport;
      if (!selectedArr || selectedArr.id === airport.id) {
        const fallbackArr = airport.id === DEFAULT_TO ? AIRPORT_BY_ID.get(DEFAULT_FROM)! : AIRPORT_BY_ID.get(DEFAULT_TO)!;
        setSelectedArr(fallbackArr);
        setTo(fallbackArr);
        cur.current.to = fallbackArr;
      }
      globeControlRef.current?.focusLocation(airport.lat, airport.lon, 9.5);
    } else {
      setSelectedArr(airport);
      setTo(airport);
      cur.current.to = airport;
      if (!selectedDep || selectedDep.id === airport.id) {
        const fallbackDep = airport.id === DEFAULT_FROM ? AIRPORT_BY_ID.get(DEFAULT_TO)! : AIRPORT_BY_ID.get(DEFAULT_FROM)!;
        setSelectedDep(fallbackDep);
        setFrom(fallbackDep);
        cur.current.from = fallbackDep;
      }
      globeControlRef.current?.focusLocation(airport.lat, airport.lon, 9.5);
    }
  }, [selectedDep, selectedArr]);

  const handleFlyNowFromGlobe = useCallback((airport: Airport) => {
    setSelectedDep(airport);
    setFrom(airport);
    cur.current.from = airport;
    if (cur.current.to.id === airport.id) {
      const altTo = airport.id === DEFAULT_TO ? AIRPORT_BY_ID.get(DEFAULT_FROM)! : AIRPORT_BY_ID.get(DEFAULT_TO)!;
      setTo(altTo);
      cur.current.to = altTo;
    }
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
            focusLat={screen === 'start' ? 14.0 : -2.5}
            focusLon={screen === 'start' ? 85.0 : 115.0}
            selectedDep={selectedDep}
            selectedArr={selectedArr}
            onSelectAirport={handleSelectAirport}
            onFlyNow={handleFlyNowFromGlobe}
            onScaleKmChange={setScaleKm}
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
          onSelectDep={(a) => {
            setSelectedDep(a);
            if (a) {
              setFrom(a);
              cur.current.from = a;
              if (!selectedArr || selectedArr.id === a.id) {
                const fallbackArr = a.id === DEFAULT_TO ? AIRPORT_BY_ID.get(DEFAULT_FROM)! : AIRPORT_BY_ID.get(DEFAULT_TO)!;
                setSelectedArr(fallbackArr);
                setTo(fallbackArr);
                cur.current.to = fallbackArr;
              }
              globeControlRef.current?.focusLocation(a.lat, a.lon, 9.5);
            }
          }}
          onSelectArr={(a) => {
            setSelectedArr(a);
            if (a) {
              setTo(a);
              cur.current.to = a;
              if (!selectedDep || selectedDep.id === a.id) {
                const fallbackDep = a.id === DEFAULT_FROM ? AIRPORT_BY_ID.get(DEFAULT_TO)! : AIRPORT_BY_ID.get(DEFAULT_FROM)!;
                setSelectedDep(fallbackDep);
                setFrom(fallbackDep);
                cur.current.from = fallbackDep;
              }
              globeControlRef.current?.focusLocation(a.lat, a.lon, 9.5);
            }
          }}
          setFrom={setFrom}
          setTo={setTo}
          onFly={startFlight}
          onBack={backFromPlanner}
          initialHangarOpen={openHangarOnEnter}
          globeControlRef={globeControlRef}
          scaleKm={scaleKm}
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
            setMenuBgMode((prev) => {
              const next = prev === 'globe' ? 'airport' : 'globe';
              const gInst = gameRef.current;
              if (gInst) {
                if (next === 'airport') {
                  gInst.suspended = false;
                  gInst.load(cfgOf(settingsRef.current), 'attract');
                } else {
                  gInst.suspended = true;
                  gInst.audio.silence();
                }
              }
              return next;
            });
          }}
        />
      )}
      {screen === 'flight' && g && phase === 'loading' && <LoadingScreen hud={hud} from={from} to={to} aircraft={g.spec?.name || ''} />}
      {showHud && hud && g && <Hud game={g} hud={hud} toasts={toasts} settings={settings} setSettings={setSettings} onMap={() => { g.clearInput(); setMapOpen(true); }} mapOpen={mapOpen} mapViewRef={mapView} workspace={workspace} dispatchWorkspace={dispatchWorkspace} from={from} to={to} phase={phase} />}
      {playing && phase === 'idle' && g!.mode === 'play' && <ReadyScreen hud={hud!} from={from} to={to} aircraft={g!.spec.name} onGo={() => g!.begin()} />}
      {playing && phase === 'paused' && !mapOpen && <PauseMenu game={g!} settings={settings} setSettings={setSettings} onMenu={toMenu} onResume={() => g!.resume()} />}
      {playing && mapOpen && phase !== 'crashed' && <FullMap game={g!} hud={hud!} from={from} to={to} settings={settings} setSettings={setSettings} viewStateRef={mapView} onClose={() => setMapOpen(false)} />}
      {playing && result && (phase === 'crashed' || phase === 'complete') && <ResultScreen r={result} onRetry={() => { setResult(null); g!.restart(); }} onNew={() => toPlanner(false)} onMenu={toMenu} />}
      {playing && phase === 'crashed' && !result && <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(255,70,0,.25), rgba(120,0,0,.55))' }} />}
    </div>
  );
}
