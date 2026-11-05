import { useState } from 'react';
import type { Game, HudState, Result } from '../sim/game';
import type { Settings, HudMode } from '../sim/storage';
import { Modal, SettingsPanel, ControlsPanel, ScoresPanel } from './Screens';
import type { Airport } from '../data/airports';

export { Hud } from './FlightHud';
export { FullMap } from './FlightMap';
export type { HudMode };
export type HudLayoutMode = HudMode;

/* =========================================================================
   SCREENS: LOADING, READY/BRIEFING, PAUSE, RESULT (PILOT DEBRIEFING REPORT)
   ========================================================================= */

export function LoadingScreen({
  hud,
  from,
  to,
  aircraft,
}: {
  hud: HudState | null;
  from: Airport;
  to: Airport;
  aircraft: string;
}) {
  const p = hud ? hud.loadProgress : 0;
  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-slate-950/85 backdrop-blur-md text-white text-center p-6 select-none font-sans">
      <div className="w-full max-w-md bg-slate-900/80 border border-white/15 p-8 rounded-3xl shadow-2xl">
        <div className="text-[11px] tracking-[0.4em] text-cyan-300 font-black">PREPARING FLIGHT DISPATCH</div>
        <div className="text-4xl font-black mt-3 font-mono">
          <span className="text-emerald-400">{from.icao}</span> <span className="text-slate-500">→</span>{' '}
          <span className="text-amber-400">{to.icao}</span>
        </div>
        <div className="text-slate-300 text-sm mt-1.5 font-semibold">
          {aircraft} · {from.name}
        </div>
        <div className="mt-7 h-2.5 rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-cyan-400 via-emerald-400 to-amber-300 transition-all duration-150"
            style={{ width: `${Math.max(8, p * 100)}%` }}
          />
        </div>
        <div className="text-xs text-slate-400 mt-3 font-mono">
          Streaming AWS DEM terrain elevation tiles &amp; high-res satellite imagery around {from.city || from.name}…
        </div>
      </div>
    </div>
  );
}

export function ReadyScreen({
  hud,
  from,
  to,
  onGo,
  aircraft,
}: {
  hud: HudState;
  from: Airport;
  to: Airport;
  onGo: () => void;
  aircraft: string;
}) {
  return (
    <div
      className="absolute inset-0 z-40 grid place-items-end sm:place-items-center bg-gradient-to-t from-slate-950/90 via-slate-950/30 to-transparent text-white p-4 sm:p-8 select-none font-sans pointer-events-auto"
    >
      <div className="text-center max-w-xl pb-10 sm:pb-0 bg-slate-950/70 border border-white/15 p-6 sm:p-8 rounded-3xl backdrop-blur-md shadow-2xl">
        <div className="text-[10px] tracking-[0.4em] text-cyan-300 font-black uppercase">
          {aircraft} · {hud.onGround ? 'READY FOR DEPARTURE' : 'READY TO FLY'}
        </div>
        <div className="text-4xl sm:text-5xl font-black mt-2 font-mono tracking-tight drop-shadow-lg">
          <span className="text-emerald-400">{from.icao}</span> <span className="text-slate-500">→</span>{' '}
          <span className="text-amber-400">{to.icao}</span>
        </div>
        <div className="text-slate-300 mt-2 text-sm sm:text-base font-medium">
          {Math.round(hud.distNm)} nm · wind {String(hud.wind.dir).padStart(3, '0')}° / {hud.wind.kt} kt
          {hud.depRwy && ` · Runway ${hud.depRwy}`}
        </div>
        <button
          onClick={onGo}
          className="mt-6 px-10 py-4 rounded-2xl font-black tracking-[0.25em] text-slate-950 bg-gradient-to-r from-cyan-300 via-emerald-300 to-amber-200 shadow-[0_0_50px_rgba(34,211,238,.6)] hover:brightness-110 active:scale-95 transition"
        >
          BEGIN FLIGHT
        </button>
        <div className="mt-4 text-xs text-slate-400 font-mono">
          Right mouse + drag to look around · <b>C</b> camera · <b>H</b> HUD modes · <b>P</b> pause · <b>R</b> hold to restart
        </div>
      </div>
    </div>
  );
}

export function PauseMenu({
  game,
  settings,
  setSettings,
  onMenu,
  onResume,
}: {
  game: Game;
  settings: Settings;
  setSettings: (p: Partial<Settings>) => void;
  onMenu: () => void;
  onResume: () => void;
}) {
  const [sub, setSub] = useState<null | 'settings' | 'controls' | 'scores'>(null);
  const hud = game.hud();

  return (
    <div
      className="absolute inset-0 z-40 grid place-items-center bg-slate-950/80 backdrop-blur-md text-white p-4 select-none font-sans"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="w-full max-w-md rounded-3xl border border-white/20 bg-slate-900/95 p-6 sm:p-8 text-center shadow-2xl">
        <div className="text-[11px] tracking-[0.4em] text-cyan-300 font-black">SIMULATION PAUSED</div>

        {/* Flight Snapshot Card */}
        <div className="mt-4 p-3.5 rounded-2xl bg-white/5 border border-white/10 text-left grid grid-cols-2 gap-3 text-xs">
          <div>
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Route</span>
            <span className="font-mono font-bold text-white text-sm">{hud.fromId} → {hud.destId}</span>
          </div>
          <div>
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Airspeed / Alt</span>
            <span className="font-mono font-bold text-white text-sm">{Math.round(hud.kias)} kt · {Math.round(hud.altFt).toLocaleString()} ft</span>
          </div>
          <div>
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Remaining Dist</span>
            <span className="font-mono font-bold text-cyan-300">{hud.distNm.toFixed(1)} nm</span>
          </div>
          <div>
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Pax Comfort</span>
            <span className="font-mono font-bold text-emerald-300">{Math.round(hud.comfort)}%</span>
          </div>
        </div>

        <div className="mt-5 grid gap-2.5">
          <button
            onClick={onResume}
            className="py-3.5 rounded-2xl font-black tracking-widest bg-gradient-to-r from-cyan-300 via-emerald-300 to-amber-200 text-slate-950 hover:brightness-110 active:scale-95 transition shadow-[0_0_25px_rgba(34,211,238,0.35)]"
          >
            RESUME FLIGHT
          </button>
          <button
            onClick={() => game.restart()}
            className="py-3 rounded-xl font-bold bg-white/10 hover:bg-white/20 border border-white/15 transition"
          >
            ↻ Restart Flight (R)
          </button>
          <button
            onClick={() => setSub('settings')}
            className="py-3 rounded-xl font-bold bg-white/10 hover:bg-white/20 border border-white/15 transition"
          >
            ⚙ Settings
          </button>
          <button
            onClick={() => setSub('controls')}
            className="py-3 rounded-xl font-bold bg-white/10 hover:bg-white/20 border border-white/15 transition"
          >
            ⌨ Flight Controls
          </button>
          <button
            onClick={() => setSub('scores')}
            className="py-3 rounded-xl font-bold bg-white/10 hover:bg-white/20 border border-white/15 transition"
          >
            🏆 High Scores
          </button>
          <button
            onClick={onMenu}
            className="py-3 rounded-xl font-bold bg-rose-500/20 hover:bg-rose-500/35 border border-rose-300/30 text-rose-200 transition"
          >
            Abort to World Map
          </button>
        </div>
      </div>

      {sub === 'settings' && (
        <Modal title="Settings" onClose={() => setSub(null)}>
          <SettingsPanel
            s={settings}
            set={(p) => {
              setSettings(p);
            }}
          />
        </Modal>
      )}
      {sub === 'controls' && (
        <Modal title="Controls" wide onClose={() => setSub(null)}>
          <ControlsPanel />
        </Modal>
      )}
      {sub === 'scores' && (
        <Modal title="High scores" onClose={() => setSub(null)}>
          <ScoresPanel />
        </Modal>
      )}
    </div>
  );
}

export function ResultScreen({
  r,
  onRetry,
  onNew,
  onMenu,
}: {
  r: Result;
  onRetry: () => void;
  onNew: () => void;
  onMenu: () => void;
}) {
  const crashed = r.outcome === 'crashed';
  const col = crashed
    ? 'text-rose-400'
    : r.grade === 'S' || r.grade === 'A'
    ? 'text-emerald-400'
    : r.grade === 'B' || r.grade === 'C'
    ? 'text-amber-400'
    : 'text-orange-400';

  // Landing Rate Analysis
  const landingRate = r.landing ? Math.abs(Math.round(r.landing.vsFpm)) : 0;
  const butterRating =
    landingRate < 120
      ? { text: '🧈 BUTTER LANDING - ULTRA SMOOTH', stars: '⭐⭐⭐⭐⭐', color: 'text-emerald-300' }
      : landingRate < 240
      ? { text: 'SAFE COMMERCIAL TOUCHDOWN', stars: '⭐⭐⭐⭐', color: 'text-cyan-300' }
      : landingRate < 420
      ? { text: 'FIRM TOUCHDOWN (CARRIER STYLE)', stars: '⭐⭐⭐', color: 'text-amber-300' }
      : { text: 'HARD BOUNCE LANDING', stars: '⭐⭐', color: 'text-rose-400' };

  return (
    <div
      className="absolute inset-0 z-40 grid place-items-center bg-slate-950/80 backdrop-blur-md text-white p-3 overflow-y-auto select-none font-sans"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="w-full max-w-xl rounded-3xl border border-white/20 bg-slate-900/95 p-6 sm:p-8 shadow-2xl my-auto">
        <div
          className={`text-[11px] tracking-[0.4em] font-black uppercase ${
            crashed ? 'text-rose-400' : 'text-cyan-300'
          }`}
        >
          {crashed ? 'CRITICAL INCIDENT · FLIGHT TERMINATED' : r.outcome === 'diverted' ? 'DIVERTED LANDING' : 'PILOT LOGBOOK · FLIGHT COMPLETE'}
        </div>

        <div className="flex items-end justify-between mt-3">
          <div>
            <div className="text-5xl sm:text-6xl font-black font-mono tracking-tight">{r.score.toLocaleString()}</div>
            <div className="text-xs text-slate-400 mt-1">
              points
              {r.newBest ? (
                <span className="ml-2 px-2 py-0.5 rounded bg-amber-400/20 text-amber-300 font-bold border border-amber-400/30">
                  ★ NEW PERSONAL RECORD
                </span>
              ) : r.rank > 0 && r.rank <= 20 ? (
                <span className="ml-2 font-mono">· rank #{r.rank}</span>
              ) : null}
            </div>
          </div>
          <div className={`text-7xl font-black font-mono ${col}`}>{r.grade}</div>
        </div>

        {/* Landing Performance Card */}
        {r.landing && !crashed && (
          <div className="mt-4 p-3.5 rounded-2xl bg-white/5 border border-white/10 space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className={`font-black ${butterRating.color}`}>{butterRating.text}</span>
              <span>{butterRating.stars}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-2 text-center text-xs font-mono">
              <div>
                <span className="text-[10px] text-slate-400 block font-sans uppercase">Touchdown Rate</span>
                <span className="font-bold text-white">{landingRate} fpm</span>
              </div>
              <div>
                <span className="text-[10px] text-slate-400 block font-sans uppercase">Centerline</span>
                <span className="font-bold text-white">{Math.abs(r.landing.offset).toFixed(1)}m off</span>
              </div>
              <div>
                <span className="text-[10px] text-slate-400 block font-sans uppercase">Touchdown Speed</span>
                <span className="font-bold text-white">{Math.round(r.landing.kias)} kt</span>
              </div>
            </div>
          </div>
        )}

        {crashed && (
          <div className="mt-4 text-sm text-rose-200 bg-rose-500/10 border border-rose-400/30 rounded-2xl px-4 py-3">
            {r.reason}
          </div>
        )}

        {/* Score Breakdown Table */}
        <div className="mt-4 max-h-[28vh] overflow-y-auto pr-1 space-y-1">
          {r.items.map((it, i) => (
            <div key={i} className="flex justify-between text-xs py-1.5 px-2 rounded bg-white/5">
              <span className="text-slate-300 font-medium">{it.label}</span>
              <span className={`font-mono font-bold ${it.pts < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                {it.pts > 0 ? '+' : ''}
                {it.pts}
              </span>
            </div>
          ))}
        </div>

        {/* Flight Metrics Summary */}
        <div className="grid grid-cols-3 gap-2 mt-4 text-center text-xs">
          <div className="rounded-xl bg-white/5 py-2.5">
            <div className="font-black text-lg font-mono">{Math.round(r.distanceKm)}</div>
            <div className="text-slate-400 text-[10px] uppercase font-bold tracking-wider">km flown</div>
          </div>
          <div className="rounded-xl bg-white/5 py-2.5">
            <div className="font-black text-lg font-mono">
              {Math.floor(r.flightTime / 60)}:{String(Math.floor(r.flightTime % 60)).padStart(2, '0')}
            </div>
            <div className="text-slate-400 text-[10px] uppercase font-bold tracking-wider">flight time</div>
          </div>
          <div className="rounded-xl bg-white/5 py-2.5">
            <div className="font-black text-lg font-mono">{Math.round(r.comfort)}%</div>
            <div className="text-slate-400 text-[10px] uppercase font-bold tracking-wider">comfort</div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2.5 mt-5">
          <button
            onClick={onRetry}
            className="py-3.5 rounded-2xl font-black tracking-wider text-xs bg-gradient-to-r from-cyan-300 to-emerald-300 text-slate-950 hover:brightness-110 active:scale-95 transition"
          >
            ↻ RETRY (R)
          </button>
          <button
            onClick={onNew}
            className="py-3.5 rounded-2xl font-bold text-xs bg-white/10 hover:bg-white/20 border border-white/15 transition"
          >
            New Route
          </button>
          <button
            onClick={onMenu}
            className="py-3.5 rounded-2xl font-bold text-xs bg-white/10 hover:bg-white/20 border border-white/15 transition"
          >
            World Map
          </button>
        </div>
      </div>
    </div>
  );
}
