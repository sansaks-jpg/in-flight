import { useState } from 'react';
import type { Game, HudState, Result } from '../sim/game';
import type { Settings, HudMode } from '../sim/storage';
import { Modal, SettingsPanel, ControlsPanel, ScoresPanel } from './Screens';
import type { Airport } from '../data/airports';
import { FlightIcon } from './FlightIcon';
import { Button, Kbd } from './Kit';
import { FLIGHT_PHASE_LABELS, formatAltitude, formatDistance, formatEte, formatSpeed } from './navigation';

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
    <div className="absolute inset-0 z-30 grid place-items-center bg-[#060a12]/90 backdrop-blur-md text-white text-center p-6 select-none font-sans">
      <div className="w-full max-w-md bg-[#0c1424]/95 border border-white/15 p-8 rounded-sm shadow-2xl">
        <div className="text-[11px] tracking-[0.35em] text-[#5ea2ff] font-black uppercase">PREPARING FLIGHT DISPATCH</div>
        <div className="text-4xl font-black mt-3 font-mono flex items-center justify-center gap-3">
          <span className="text-emerald-400">{from.icao}</span>
          <FlightIcon name="arrowRight" className="w-5 h-5 text-slate-500" />
          <span className="text-amber-400">{to.icao}</span>
        </div>
        <div className="text-slate-300 text-sm mt-1.5 font-semibold">
          {aircraft} · {from.name}
        </div>
        <div className="mt-7 h-2 rounded-sm bg-white/10 overflow-hidden">
          <div
            className="h-full bg-[#2572eb] transition-all duration-150"
            style={{ width: `${Math.max(8, p * 100)}%` }}
          />
        </div>
        <div className="text-xs text-slate-400 mt-3 font-mono">
          Streaming AWS Terrarium DEM elevation tiles &amp; Esri World Imagery around {from.city || from.name}...
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
    <div className="if-scrim if-ready" onPointerDown={(e) => e.stopPropagation()}>
      <div className="if-dialog" role="dialog" aria-label="Flight briefing">
        <div className="if-pause-hero">
          <span className="if-pause-status"><FlightIcon name="plane" size={12} />{hud.onGround ? 'Ready for departure' : 'Ready to fly'}</span>
          <div className="if-pause-route"><span>{from.icao}</span><FlightIcon name="arrowRight" size={20} /><span>{to.icao}</span></div>
          <div className="if-pause-sub">{aircraft} · {from.city || from.name} to {to.city || to.name}</div>
        </div>
        <div className="if-stats">
          <div className="if-stat"><span>Distance</span><strong>{Math.round(hud.distNm)}<small>NM</small></strong></div>
          <div className="if-stat"><span>Wind</span><strong>{String(hud.wind.dir).padStart(3, '0')}°<small>{hud.wind.kt} KT</small></strong></div>
          <div className="if-stat"><span>Runway</span><strong>{hud.depRwy || '—'}</strong></div>
          <div className="if-stat"><span>Ete</span><strong>{formatEte(hud.eteMin, true)}</strong></div>
        </div>
        <div className="if-pause-actions">
          <Button variant="primary" icon="play" onClick={onGo} autoFocus>Begin flight</Button>
          <div className="if-pause-hint">
            <span><Kbd>C</Kbd>camera</span><span><Kbd>H</Kbd>HUD mode</span><span><Kbd>P</Kbd>pause</span><span><Kbd>R</Kbd>hold to restart</span>
          </div>
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
  const [confirm, setConfirm] = useState<null | 'restart' | 'abort'>(null);
  const hud = game.hud();
  const metric = settings.units === 'metric';
  const units = metric ? 'metric' : 'aviation';
  return (
    <div className="if-scrim if-pause" onPointerDown={(e) => e.stopPropagation()}>
      <div className="if-dialog" role="dialog" aria-label="Flight paused">
        <div className="if-pause-hero">
          <span className="if-pause-status"><span className="if-pause-glyph" aria-hidden="true" />Paused</span>
          <div className="if-pause-route"><span>{hud.fromId}</span><FlightIcon name="arrowRight" size={20} /><span>{hud.destId}</span></div>
          <div className="if-pause-sub">{game.spec.name} · {FLIGHT_PHASE_LABELS[hud.flightPhase]}</div>
        </div>
        <div className="if-stats">
          <div className="if-stat"><span>Airspeed</span><strong>{formatSpeed(hud.kias, units)}<small>{metric ? 'KM/H' : 'KT'}</small></strong></div>
          <div className="if-stat"><span>Altitude</span><strong>{formatAltitude(hud.altFt, units)}<small>{metric ? 'M' : 'FT'}</small></strong></div>
          <div className="if-stat"><span>To go</span><strong>{formatDistance(hud.distNm)}<small>NM</small></strong></div>
          <div className="if-stat"><span>Ete</span><strong>{formatEte(hud.eteMin, hud.gsKt > 5)}</strong></div>
        </div>
        <div className="if-pause-actions">
          <Button variant="primary" icon="play" kbd="Esc" onClick={onResume} autoFocus>Resume flight</Button>
          <div className="if-tiles">
            <button type="button" className="if-tile" onClick={() => setSub('settings')}><FlightIcon name="settings" size={20} />Settings</button>
            <button type="button" className="if-tile" onClick={() => setSub('controls')}><FlightIcon name="keyboard" size={20} />Controls</button>
            <button type="button" className="if-tile" onClick={() => setSub('scores')}><FlightIcon name="trophy" size={20} />Logbook</button>
          </div>
          {confirm ? (
            <div className="if-confirm" role="alertdialog" aria-label="Confirm">
              <span>{confirm === 'restart' ? 'Restart from the beginning of this flight?' : 'Leave this flight and return to the world map?'}</span>
              <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button variant="danger" autoFocus onClick={() => (confirm === 'restart' ? game.restart() : onMenu())}>{confirm === 'restart' ? 'Restart' : 'Leave'}</Button>
            </div>
          ) : (
            <div className="if-pause-secondary">
              <Button grow icon="reset" onClick={() => setConfirm('restart')}>Restart</Button>
              <Button grow variant="danger" icon="globe" onClick={() => setConfirm('abort')}>Abort to map</Button>
            </div>
          )}
        </div>
      </div>

      {sub === 'settings' && (
        <Modal title="Settings" onClose={() => setSub(null)}>
          <SettingsPanel s={settings} set={setSettings} />
        </Modal>
      )}
      {sub === 'controls' && (
        <Modal title="Flight controls" wide onClose={() => setSub(null)}>
          <ControlsPanel />
        </Modal>
      )}
      {sub === 'scores' && (
        <Modal title="Pilot logbook" onClose={() => setSub(null)}>
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
      ? { text: 'BUTTER LANDING - ULTRA SMOOTH', starCount: 5, color: 'text-emerald-300' }
      : landingRate < 240
      ? { text: 'SAFE COMMERCIAL TOUCHDOWN', starCount: 4, color: 'text-cyan-300' }
      : landingRate < 420
      ? { text: 'FIRM TOUCHDOWN (CARRIER STYLE)', starCount: 3, color: 'text-amber-300' }
      : { text: 'HARD BOUNCE LANDING', starCount: 2, color: 'text-rose-400' };

  return (
    <div
      className="absolute inset-0 z-40 grid place-items-center bg-[#05080f]/85 backdrop-blur-md text-white p-3 overflow-y-auto select-none font-sans"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="w-full max-w-xl rounded-sm border border-white/20 bg-[#0d1626]/95 p-6 sm:p-8 shadow-2xl my-auto">
        <div
          className={`text-[11px] tracking-[0.35em] font-black uppercase ${
            crashed ? 'text-rose-400' : 'text-[#5ea2ff]'
          }`}
        >
          {crashed ? 'CRITICAL INCIDENT · FLIGHT TERMINATED' : r.outcome === 'diverted' ? 'DIVERTED LANDING' : 'PILOT LOGBOOK · FLIGHT COMPLETE'}
        </div>

        <div className="flex items-end justify-between mt-3">
          <div>
            <div className="text-5xl sm:text-6xl font-black font-mono tracking-tight">{r.score.toLocaleString()}</div>
            <div className="text-xs text-slate-400 mt-1 flex items-center gap-2">
              <span>points</span>
              {r.newBest ? (
                <span className="px-2 py-0.5 rounded-sm bg-amber-400/20 text-amber-300 font-bold border border-amber-400/30 inline-flex items-center gap-1">
                  <FlightIcon name="trophy" className="w-3 h-3 text-amber-300" />
                  <span>NEW PERSONAL RECORD</span>
                </span>
              ) : r.rank > 0 && r.rank <= 20 ? (
                <span className="font-mono">· rank #{r.rank}</span>
              ) : null}
            </div>
          </div>
          <div className={`text-7xl font-black font-mono ${col}`}>{r.grade}</div>
        </div>

        {/* Landing Performance Card */}
        {r.landing && !crashed && (
          <div className="mt-4 p-3.5 rounded-sm bg-white/5 border border-white/10 space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className={`font-black ${butterRating.color}`}>{butterRating.text}</span>
              <span className="inline-flex items-center gap-0.5 text-amber-300">
                {Array.from({ length: butterRating.starCount }).map((_, idx) => (
                  <FlightIcon key={idx} name="star" className="w-3.5 h-3.5" />
                ))}
              </span>
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
          <div className="mt-4 text-sm text-rose-200 bg-rose-500/10 border border-rose-400/30 rounded-sm px-4 py-3">
            {r.reason}
          </div>
        )}

        {/* Score Breakdown Table */}
        <div className="mt-4 max-h-[28vh] overflow-y-auto pr-1 space-y-1">
          {r.items.map((it, i) => (
            <div key={i} className="flex justify-between text-xs py-1.5 px-2 rounded-sm bg-white/5">
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
          <div className="rounded-sm bg-white/5 py-2.5">
            <div className="font-black text-lg font-mono">{Math.round(r.distanceKm)}</div>
            <div className="text-slate-400 text-[10px] uppercase font-bold tracking-wider">km flown</div>
          </div>
          <div className="rounded-sm bg-white/5 py-2.5">
            <div className="font-black text-lg font-mono">
              {Math.floor(r.flightTime / 60)}:{String(Math.floor(r.flightTime % 60)).padStart(2, '0')}
            </div>
            <div className="text-slate-400 text-[10px] uppercase font-bold tracking-wider">flight time</div>
          </div>
          <div className="rounded-sm bg-white/5 py-2.5">
            <div className="font-black text-lg font-mono">{Math.round(r.comfort)}%</div>
            <div className="text-slate-400 text-[10px] uppercase font-bold tracking-wider">comfort</div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2.5 mt-5">
          <button
            onClick={onRetry}
            className="py-3.5 rounded-sm font-black tracking-wider text-xs bg-[#eab308] hover:bg-[#facc15] text-slate-950 active:scale-95 transition cursor-pointer"
          >
            RETRY (R)
          </button>
          <button
            onClick={onNew}
            className="py-3.5 rounded-sm font-bold text-xs bg-white/10 hover:bg-white/20 border border-white/15 transition cursor-pointer"
          >
            New Route
          </button>
          <button
            onClick={onMenu}
            className="py-3.5 rounded-sm font-bold text-xs bg-white/10 hover:bg-white/20 border border-white/15 transition cursor-pointer"
          >
            World Map
          </button>
        </div>
      </div>
    </div>
  );
}

