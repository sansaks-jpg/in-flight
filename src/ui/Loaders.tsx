import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { HudState } from '../sim/game';
import type { Airport } from '../data/airports';
import { loadState, type LoadSnap, type LoadStage } from '../sim/loadState';
import { A320Plan } from './A320Plan';
import './loaders.css';

/* =========================================================================
   Loading screens
   - <BootLoader>   first visit / reload: covers the menu until fonts-free UI, menu photography and the
                    satellite globe are really painted, so nothing pops in underneath.
   - <FlightLoader> entering a flight: opaque (the 3D scene is never visible while it streams in), driven by
                    real progress (survey -> scenery -> 50 MB flight deck download -> weather -> terrain tiles).
   Both share <LoadingScene>. The aircraft is a plan view of the A320-200 traced from a published three-view.
   ========================================================================= */

/** livery accent of the A320 in specs.ts (0x0b7a9e) - kept in sync by hand, it is only a tint */
const A320_ACCENT = '#0b7a9e';

type RowState = 'pending' | 'active' | 'done';
interface Row { label: string; detail?: string; state: RowState }

const TIPS: ReactNode[] = [
  <>Hold <kbd>Right mouse</kbd> and drag to look around the flight deck</>,
  <><kbd>C</kbd> cycles cameras · <kbd>H</kbd> cycles HUD modes</>,
  <><kbd>P</kbd> pauses the flight · hold <kbd>R</kbd> to restart</>,
  <>Mouse wheel zooms the flight deck camera up to 14×</>,
  <>Double-click a cockpit control to focus the camera on its panel</>,
];

/** Eases the shown value towards the real target, never backwards, so the bar neither jumps nor stalls visually. */
function useSmoothed(target: number, speed = 4.5) {
  const [v, setV] = useState(0);
  const ref = useRef({ v: 0, t: 0 });
  ref.current.t = target;
  useEffect(() => {
    let raf = 0, last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const s = ref.current;
      let nv = s.v + (s.t - s.v) * Math.min(1, dt * speed);
      if (s.t - nv < 0.0025) nv = s.t;
      if (nv > s.v + 1e-5) { s.v = nv; setV(nv); }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [speed]);
  return v;
}

function useTipIndex(count: number) {
  const [i, setI] = useState(() => Math.floor(Math.random() * count));
  useEffect(() => { const id = window.setInterval(() => setI((x) => (x + 1) % count), 4600); return () => clearInterval(id); }, [count]);
  return i;
}

function Wings({ className = '' }: { className?: string }) {
  // small brand mark: a swept-wing silhouette
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z" />
    </svg>
  );
}

function Arrow() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

interface SceneProps {
  eyebrow: string;
  headline: ReactNode;
  subline?: ReactNode;
  progress: number; // 0..1, already smoothed
  status: string;
  rows: Row[];
  leaving?: boolean;
  error?: string | null;
  onAbort?: () => void;
  aircraftName?: string;
  /** no fade-in (the static splash from index.html is cross-faded away instead) */
  instant?: boolean;
}

function LoadingScene({ eyebrow, headline, subline, progress, status, rows, leaving, error, onAbort, aircraftName = 'Airbus A320-200', instant }: SceneProps) {
  const tip = useTipIndex(TIPS.length);
  const pct = Math.round(progress * 100);
  return (
    <div className="ld-root" style={instant ? { animation: 'none' } : undefined} data-leaving={leaving ? 'true' : 'false'} data-error={error ? 'true' : 'false'} role="status" aria-live="polite" aria-busy={!leaving}>
      <div className="ld-bg" />
      <div className="ld-shell">
        <header className="ld-top">
          <div className="ld-brand"><Wings />IN-FLIGHT</div>
          <div className="ld-type"><b>{aircraftName}</b>CFM56-5B · twin-engine narrow-body</div>
        </header>

        <main className="ld-main">
          <div className="ld-radar" aria-hidden="false">
            <div className="ld-ring" /><div className="ld-ring" /><div className="ld-ring" />
            <div className="ld-cross-h" /><div className="ld-cross-v" />
            <div className="ld-sweep" />
            <span className="ld-tick" style={{ top: '-18px', left: '50%', transform: 'translateX(-50%)' }}>N</span>
            <span className="ld-tick" style={{ bottom: '-18px', left: '50%', transform: 'translateX(-50%)' }}>S</span>
            <div className="ld-plane"><A320Plan progress={progress} accent={A320_ACCENT} /></div>
          </div>

          <section aria-label="Loading progress" style={{ minWidth: 0 }}>
            <div className="ld-eyebrow">{eyebrow}</div>
            {headline}
            {subline}
            <div className="ld-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <i style={{ transform: `scaleX(${Math.max(0.012, progress)})` }} />
              {!error && progress < 0.995 && <b />}
            </div>
            <div className="ld-meta">
              <div className="ld-status">{status}</div>
              <div className="ld-pct">{pct}%</div>
            </div>
            <ul className="ld-steps" style={{ listStyle: 'none', padding: 0, margin: '20px 0 0' }}>
              {rows.map((r) => (
                <li key={r.label} className="ld-step" data-state={r.state}>
                  <span className="dot" />
                  <span>{r.label}</span>
                  <span className="detail">{r.detail}</span>
                </li>
              ))}
            </ul>
            {error && (
              <div className="ld-error" role="alert">
                {error}
                {onAbort && <div><button className="ld-btn" onClick={onAbort}>BACK TO MENU</button></div>}
              </div>
            )}
          </section>
        </main>

        <footer className="ld-foot">
          <div className="ld-tip" key={tip}>{TIPS[tip]}</div>
          <div className="ld-dims">37.57 m long · 34.10 m span · 11.76 m high</div>
        </footer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ flight entry */

const STAGE_ORDER: LoadStage[] = ['idle', 'dispatch', 'scenery', 'deck', 'weather', 'terrain', 'warm', 'done'];
const rank = (s: LoadStage) => STAGE_ORDER.indexOf(s);
const mb = (b: number) => (b / 1e6).toFixed(1); // decimal MB, like the 50.6 MB quoted in NOTICE.txt

/** Overall 0..1 progress from the real signals. Bands: survey+scenery 0-12 %, deck 12-60 %, weather 60-68 %, terrain + city streaming 68-88 %, GPU warm-up 88-99 %. */
function flightTarget(s: LoadSnap, terrain: number, finishing: boolean): number {
  if (finishing || s.stage === 'done') return 1;
  switch (s.stage) {
    case 'idle': return 0.01;
    case 'dispatch': return 0.04;
    case 'scenery': return 0.1;
    case 'deck': {
      const bytes = s.deckTotal > 0 ? Math.min(1, s.deckLoaded / s.deckTotal) : 0;
      return 0.12 + 0.48 * (s.deckTotal > 0 && s.deckLoaded >= s.deckTotal ? 0.92 : bytes * 0.9);
    }
    case 'weather': return 0.62;
    case 'terrain': return 0.68 + 0.2 * Math.max(0, Math.min(1, terrain));
    case 'warm': return 0.88 + 0.11 * Math.max(0, Math.min(1, s.warm));
  }
}

function FlightLoaderView({ hud, from, to, aircraft, finishing, leaving, onAbort }: {
  hud: HudState | null; from: Airport; to: Airport; aircraft: string; finishing: boolean; leaving: boolean; onAbort: () => void;
}) {
  const snap = useSyncExternalStore(loadState.subscribe, loadState.get);
  const terrain = hud ? hud.loadProgress : 0;
  const target = flightTarget(snap, terrain, finishing);
  const progress = useSmoothed(target);
  const r = rank(snap.stage);
  const st = (first: LoadStage, last: LoadStage = first): RowState => (finishing || r > rank(last) ? 'done' : r >= rank(first) ? 'active' : 'pending');

  const deckState = st('deck');
  let deckDetail = '';
  if (deckState === 'done') deckDetail = snap.deckCached ? 'cached' : 'ready';
  else if (deckState === 'active') {
    if (snap.deckCached) deckDetail = 'from cache';
    else if (snap.deckTotal > 0 && snap.deckLoaded < snap.deckTotal) deckDetail = `${mb(snap.deckLoaded)} / ${mb(snap.deckTotal)} MB`;
    else if (snap.deckTotal > 0) deckDetail = 'decoding';
  }
  const terrainState = st('terrain');
  const warmState = st('warm');
  const rows: Row[] = [
    { label: 'Dispatch & airfield survey', state: st('dispatch', 'scenery'), detail: st('dispatch', 'scenery') === 'done' ? 'ready' : '' },
    { label: 'A320 flight deck model', state: deckState, detail: deckDetail },
    { label: 'Live weather · METAR', state: st('weather'), detail: st('weather') === 'done' ? 'ready' : '' },
    { label: 'Terrain, imagery & city (all directions)', state: terrainState, detail: terrainState === 'active' ? `${Math.round(terrain * 100)}%` : terrainState === 'done' ? 'ready' : '' },
    { label: 'Graphics pipeline · shaders & textures', state: warmState, detail: warmState === 'active' ? `${Math.round(snap.warm * 100)}%` : warmState === 'done' ? 'ready' : '' },
  ];
  const activeRow = rows.find((x) => x.state === 'active');
  let status = 'Preparing flight…';
  if (finishing) status = 'Ready for departure';
  else if (snap.error) status = 'Flight could not be prepared';
  else if (snap.stage === 'dispatch') status = 'Surveying runways and taxiways…';
  else if (snap.stage === 'scenery') status = 'Building airfield scenery…';
  else if (snap.stage === 'deck') status = deckDetail === 'decoding' ? 'Decoding flight deck textures and meshes…' : snap.deckCached ? 'Loading flight deck from local cache…' : 'Downloading flight deck model (first launch only, then cached)…';
  else if (snap.stage === 'weather') status = `Fetching live weather for ${from.icao}…`;
  else if (snap.stage === 'terrain') status = `Streaming elevation, imagery and city around ${from.city || from.name}…`;
  else if (snap.stage === 'warm') status = 'Compiling shaders and uploading textures to the GPU…';
  else if (activeRow) status = activeRow.label;

  const headline = (
    <div className="ld-route">
      <span className="a">{from.icao}</span><Arrow /><span className="b">{to.icao}</span>
    </div>
  );
  const subline = <div className="ld-city">{from.city || from.name} → {to.city || to.name}</div>;
  return (
    <LoadingScene
      eyebrow="Preparing flight dispatch"
      headline={headline}
      subline={subline}
      progress={progress}
      status={status}
      rows={rows}
      leaving={leaving}
      error={snap.error}
      onAbort={onAbort}
      aircraftName={aircraft || 'Airbus A320-200'}
    />
  );
}

/** Visible from the moment a launch starts until the scene is ready; then completes the bar and fades out (never a hard cut). */
export function FlightLoader({ active, hud, from, to, aircraft, onAbort }: {
  active: boolean; hud: HudState | null; from: Airport; to: Airport; aircraft: string; onAbort: () => void;
}) {
  const [mounted, setMounted] = useState(active);
  const [leaving, setLeaving] = useState(false);
  const [finishing, setFinishing] = useState(false);
  useEffect(() => {
    if (active) { setMounted(true); setLeaving(false); setFinishing(false); return; }
    if (!mounted) return;
    setFinishing(true);
    const t1 = window.setTimeout(() => setLeaving(true), 480);
    const t2 = window.setTimeout(() => setMounted(false), 480 + 560);
    return () => { clearTimeout(t1); clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  if (!active && !mounted) return null;
  return <FlightLoaderView hud={hud} from={from} to={to} aircraft={aircraft} finishing={finishing || !active} leaving={leaving} onAbort={onAbort} />;
}

/* ------------------------------------------------------------------ first visit */

export interface BootTasks { images: number; globe: number; engine: boolean }

const BOOT_MIN_MS = 1400; // long enough to read as a deliberate splash, never a flash
const BOOT_MAX_MS = 12000; // a dead network must not trap the player behind the loader

export function BootLoader({ tasks, onDone }: { tasks: BootTasks; onDone: () => void }) {
  const [t0] = useState(() => performance.now());
  const [elapsedOk, setElapsedOk] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Hand over from the static splash in index.html once this loader has really been painted (two frames).
  useEffect(() => {
    let r2 = 0;
    const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => {
      const el = document.getElementById('boot-splash');
      if (el) { el.style.opacity = '0'; window.setTimeout(() => el.remove(), 520); }
    }); });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
  }, []);
  useEffect(() => {
    const a = window.setTimeout(() => setElapsedOk(true), BOOT_MIN_MS);
    const b = window.setTimeout(() => setGaveUp(true), BOOT_MAX_MS);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, []);
  const ready = (tasks.images >= 1 && tasks.globe >= 1 && tasks.engine) || gaveUp;
  const go = ready && elapsedOk;
  useEffect(() => {
    if (!go) return;
    setFinishing(true);
    const t1 = window.setTimeout(() => setLeaving(true), 420);
    const t2 = window.setTimeout(onDone, 420 + 560);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [go, onDone]);

  const real = 0.12 * (tasks.engine ? 1 : 0) + 0.3 * Math.min(1, tasks.images) + 0.58 * Math.min(1, tasks.globe);
  // Never sit at 0 %: the first second creeps along time so the bar reads as alive even before any byte arrives.
  const creep = Math.min(0.12, (performance.now() - t0) / 14000);
  const target = finishing ? 1 : Math.min(0.98, Math.max(real, creep));
  const progress = useSmoothed(target, 3.6);

  const rowState = (v: number): RowState => (finishing || v >= 1 ? 'done' : 'active');
  const pctText = (v: number) => (v >= 1 || finishing ? 'ready' : `${Math.round(v * 100)}%`);
  const rows: Row[] = [
    { label: 'Simulator core', state: tasks.engine || finishing ? 'done' : 'active', detail: tasks.engine || finishing ? 'ready' : '' },
    { label: 'Menu photography', state: rowState(tasks.images), detail: pctText(tasks.images) },
    { label: 'Earth satellite imagery', state: rowState(tasks.globe), detail: pctText(tasks.globe) },
  ];
  let status = 'Starting up…';
  if (finishing) status = 'Welcome aboard';
  else if (!tasks.engine) status = 'Initialising graphics and flight model…';
  else if (tasks.images < 1) status = 'Loading menu photography…';
  else if (tasks.globe < 1) status = 'Streaming Esri World Imagery for the globe…';
  else status = 'Almost there…';

  const headline = <div className="ld-title">IN<span>-</span>FLIGHT</div>;
  const subline = <div className="ld-city">Airbus A320-200 · interactive flight deck · 8,400+ real airports</div>;
  return (
    <LoadingScene instant eyebrow="Starting simulator" headline={headline} subline={subline} progress={progress} status={status} rows={rows} leaving={leaving} />
  );
}
