import { useCallback, useEffect, useRef, useState } from 'react';
import { Game, HudState, Phase, Result, Toast, ScenarioConfig } from './sim/game';
import { AIRPORT_BY_ID, Airport, DEFAULT_FROM, DEFAULT_TO } from './data/airports';
import { Settings, loadSettings, saveSettings, loadRoute, saveRoute, loadScores } from './sim/storage';
import { StartScreen } from './ui/Screens';
import { Planner } from './ui/Planner';
import { Hud, LoadingScreen, ReadyScreen, PauseMenu, ResultScreen, FullMap } from './ui/Hud';

type Screen = 'start' | 'planner' | 'flight';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const saved = useRef(loadRoute()).current;
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const [screen, setScreen] = useState<Screen>('start');
  const screenRef = useRef(screen); screenRef.current = screen;
  const [aircraftId, setAircraft] = useState(saved?.aircraft || 'swift');
  const [from, setFrom] = useState<Airport>(AIRPORT_BY_ID.get(saved?.from || DEFAULT_FROM) || AIRPORT_BY_ID.get(DEFAULT_FROM)!);
  const [to, setTo] = useState<Airport>(AIRPORT_BY_ID.get(saved?.to || DEFAULT_TO) || AIRPORT_BY_ID.get(DEFAULT_TO)!);
  const [hud, setHud] = useState<HudState | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
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
        if (p === 'crashed' || p === 'complete') setMapOpen(false);
      },
      onResult: (r) => {
        setResult(r);
        setMapOpen(false);
      },
      onCommand: (c) => {
        if (c === 'map') setMapOpen(true);
        else if (c === 'cycleHudMode') {
          const nextMap: Record<string, string> = {
            standard: 'minimal',
            minimal: 'assisted',
            assisted: 'standard',
            cockpit: 'standard',
          };
          const curMode = settingsRef.current.hudMode || 'standard';
          const next = (nextMap[curMode] || 'standard') as any;
          setSettings({ hudMode: next });
        }
      },
    });
    gameRef.current = g; setGame(g); (window as any).__sky = g;
    g.load(cfgOf(settingsRef.current), 'attract');
    return () => { g.dispose(); gameRef.current = null; };
    // eslint-disable-next-line
  }, []);


  const loadAttract = useCallback(() => {
    const g = gameRef.current; if (!g) return; g.suspended = false; setAttractReady(false); setResult(null); setMapOpen(false);
    g.load(cfgOf(settingsRef.current), 'attract');
  }, [cfgOf]);

  const startFlight = useCallback(() => {
    const g = gameRef.current; if (!g) return; const s = settingsRef.current;
    saveRoute({ from: cur.current.from.id, to: cur.current.to.id, aircraft: cur.current.aircraftId });
    g.suspended = false; setResult(null); setMapOpen(false); setScreen('flight'); setToasts([]);
    g.load(cfgOf(s), 'play', s.startMode);
  }, [cfgOf]);

  const quick = useCallback(() => { startFlight(); }, [startFlight]);
  const toMenu = useCallback(() => { setScreen('start'); loadAttract(); }, [loadAttract]);
  const toPlanner = useCallback(() => { const g = gameRef.current; setScreen('planner'); if (g) { g.suspended = true; g.audio.silence(); } setResult(null); setMapOpen(false); }, []);

  // when airports change on the start screen keep background in sync
  useEffect(() => { if (screen === 'start' && gameRef.current && attractReady) { /* background already loaded for current departure */ } }, [screen, attractReady]);

  // planner → back to menu reloads attract if departure changed
  const backFromPlanner = useCallback(() => { setScreen('start'); loadAttract(); }, [loadAttract]);

  const best = loadScores()[0]?.score || 0;
  const g = game;
  const playing = screen === 'flight' && g && hud;
  const showHud = playing && (phase === 'playing' || phase === 'paused' || phase === 'crashed' || phase === 'complete' || phase === 'idle');

  return (
    <div className="fixed inset-0 bg-[#05080f] overflow-hidden font-sans" style={{ touchAction: 'none' }}>
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block outline-none" />
      {screen === 'start' && <StartScreen onStart={() => { setScreen('planner'); if (gameRef.current) { gameRef.current.suspended = true; } }} onQuick={quick} settings={settings} set={setSettings} bestScore={best} ready={attractReady} />}
      {screen === 'planner' && <Planner settings={settings} setSettings={(s) => setSettings(s)} aircraftId={aircraftId} setAircraft={setAircraft} from={from} to={to} setFrom={setFrom} setTo={setTo} onFly={startFlight} onBack={backFromPlanner} />}
      {screen === 'flight' && g && phase === 'loading' && <LoadingScreen hud={hud} from={from} to={to} aircraft={g.spec?.name || ''} />}
      {showHud && hud && g && <Hud game={g} hud={hud} toasts={toasts} settings={settings} setSettings={setSettings} onMap={() => setMapOpen(true)} mapOpen={mapOpen} from={from} to={to} phase={phase} />}
      {playing && phase === 'idle' && g!.mode === 'play' && <ReadyScreen hud={hud!} from={from} to={to} aircraft={g!.spec.name} onGo={() => g!.begin()} />}
      {playing && phase === 'paused' && !mapOpen && <PauseMenu game={g!} settings={settings} setSettings={setSettings} onMenu={toMenu} onResume={() => g!.resume()} />}
      {playing && mapOpen && phase !== 'crashed' && <FullMap game={g!} from={from} to={to} settings={settings} setSettings={setSettings} onClose={() => setMapOpen(false)} />}
      {playing && result && (phase === 'crashed' || phase === 'complete') && <ResultScreen r={result} onRetry={() => { setResult(null); g!.restart(); }} onNew={toPlanner} onMenu={toMenu} />}
      {playing && phase === 'crashed' && !result && <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(255,70,0,.25), rgba(120,0,0,.55))' }} />}
    </div>
  );
}
