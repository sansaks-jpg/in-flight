import { useEffect, useRef, useState } from 'react';
import type { Game, HudState, Toast, Result, Phase } from '../sim/game';
import { Settings, HudMode } from '../sim/storage';
import { MapPanel } from './MapPanel';
import { Modal, SettingsPanel, ControlsPanel, ScoresPanel } from './Screens';
import { Airport } from '../data/airports';
import { wrap180, clamp } from '../sim/geo';

export type { HudMode };
export type HudLayoutMode = HudMode;

const fmtT = (min: number) =>
  isFinite(min) && min < 6000
    ? `${Math.floor(min / 60)}:${String(Math.floor(min % 60)).padStart(2, '0')}`
    : '--:--';

const Btn = ({
  children,
  on,
  onClick,
  className = '',
  title,
}: {
  children: React.ReactNode;
  on?: boolean;
  onClick?: () => void;
  className?: string;
  title?: string;
}) => (
  <button
    title={title}
    onPointerDown={(e) => e.stopPropagation()}
    onClick={onClick}
    className={`px-3 py-1.5 rounded-xl text-xs font-bold border backdrop-blur-md transition active:scale-95 ${
      on
        ? 'bg-cyan-400 text-slate-950 border-cyan-300 shadow-[0_0_15px_rgba(34,211,238,0.4)]'
        : 'bg-slate-950/70 text-slate-200 border-white/15 hover:bg-slate-900/90 hover:border-white/30'
    } ${className}`}
  >
    {children}
  </button>
);

function Hold({
  onDown,
  onUp,
  children,
  className = '',
}: {
  onDown: () => void;
  onUp: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        onDown();
      }}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onContextMenu={(e) => e.preventDefault()}
      className={`select-none touch-none rounded-xl bg-slate-950/75 border border-white/20 text-white font-bold backdrop-blur-md active:bg-cyan-500/40 active:border-cyan-400 ${className}`}
    >
      {children}
    </button>
  );
}

/* =========================================================================
   PRIMARY FLIGHT DISPLAY (PFD) / GLASS COCKPIT (MSFS & GARMIN G1000 STYLE)
   ========================================================================= */

// 1. Flight Mode Annunciator (FMA) across top of PFD
function FlightModeAnnunciator({ hud }: { hud: HudState }) {
  const ap = hud.ap;
  const phaseLabel = (hud.flightPhase || 'taxi').toUpperCase();

  const phaseColor =
    hud.flightPhase === 'takeoff'
      ? 'text-cyan-300'
      : hud.flightPhase === 'climb' || hud.flightPhase === 'cruise'
      ? 'text-emerald-300'
      : hud.flightPhase === 'final'
      ? 'text-amber-300'
      : 'text-slate-300';

  const curLat = ap.nav ? 'LNAV' : ap.on ? `HDG ${String(Math.round(ap.hdg)).padStart(3, '0')}°` : 'ROLL';
  const curVert = ap.appr ? 'APPR GS' : ap.on ? `ALT ${ap.alt}FT` : 'PITCH';

  const prevLatRef = useRef(curLat);
  const prevVertRef = useRef(curVert);
  const [flashLat, setFlashLat] = useState(false);
  const [flashVert, setFlashVert] = useState(false);

  useEffect(() => {
    if (prevLatRef.current !== curLat) {
      prevLatRef.current = curLat;
      setFlashLat(true);
      const timer = setTimeout(() => setFlashLat(false), 2500);
      return () => clearTimeout(timer);
    }
  }, [curLat]);

  useEffect(() => {
    if (prevVertRef.current !== curVert) {
      prevVertRef.current = curVert;
      setFlashVert(true);
      const timer = setTimeout(() => setFlashVert(false), 2500);
      return () => clearTimeout(timer);
    }
  }, [curVert]);

  return (
    <div className="w-[390px] sm:w-[450px] rounded-t-xl bg-slate-950/90 border-t border-x border-white/20 backdrop-blur-md px-3 py-1.5 flex items-center justify-between text-[11px] font-mono select-none">
      {/* Speed / Throttle Mode */}
      <div className="text-left w-24">
        <span className="text-[9px] text-slate-400 block font-sans uppercase">Speed Mode</span>
        <span className={`font-black ${ap.on ? 'text-emerald-300' : 'text-slate-200'}`}>
          {ap.on ? `SPD ${ap.spd}KT` : `MAN THR`}
        </span>
      </div>

      {/* Lateral Mode (with 2.5s mode change flash per Section 3.4) */}
      <div className={`text-center flex-1 border-x border-white/10 px-2 rounded transition-all duration-300 ${
        flashLat ? 'bg-cyan-500/20 text-cyan-200 border-cyan-400 shadow-[0_0_10px_#22d3ee]' : ''
      }`}>
        <span className="text-[9px] text-slate-400 block font-sans uppercase">Lateral / Roll</span>
        <span className="font-black text-cyan-300">
          {curLat}
        </span>
      </div>

      {/* Vertical Mode (with 2.5s mode change flash per Section 3.4) */}
      <div className={`text-center flex-1 border-r border-white/10 px-2 rounded transition-all duration-300 ${
        flashVert ? 'bg-emerald-500/20 text-emerald-200 border-emerald-400 shadow-[0_0_10px_#34d399]' : ''
      }`}>
        <span className="text-[9px] text-slate-400 block font-sans uppercase">Vertical / Pitch</span>
        <span className="font-black text-cyan-300">
          {curVert}
        </span>
      </div>

      {/* Autopilot Master & Flight Phase Badge */}
      <div className="text-right w-28 flex flex-col items-end">
        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full ${
              ap.on ? 'bg-emerald-400 animate-pulse shadow-[0_0_8px_#34d399]' : 'bg-slate-600'
            }`}
          />
          <span className={`font-black tracking-wider ${ap.on ? 'text-emerald-300' : 'text-slate-400'}`}>
            {ap.on ? 'AP 1' : 'FD ONLY'}
          </span>
        </div>
        <span className={`text-[9px] font-black tracking-widest truncate max-w-[100px] ${phaseColor}`}>
          {phaseLabel}
        </span>
      </div>
    </div>
  );
}

// 2. Airspeed Tape (Left of PFD) - Smooth, continuous, zero-snap positioning
function AirspeedTape({
  hud,
  metric,
  minimal = false,
}: {
  hud: HudState;
  metric: boolean;
  minimal?: boolean;
}) {
  const kias = hud.kias;
  const mult = metric ? 1.852 : 1;
  const currentSpeed = kias * mult;
  const displaySpeed = Math.round(currentSpeed);
  const unit = metric ? 'KM/H' : 'KT';

  const vs0 = hud.vs0 * mult;
  const vs1 = hud.vs1 * mult;
  const v1 = hud.v1 * mult;
  const vr = hud.vr * mult;
  const v2 = hud.v2 * mult;
  const vapp = hud.vapp * mult;
  const vne = hud.vne * mult;
  const targetSpd = hud.ap.on ? hud.ap.spd * mult : null;

  const pxPerUnit = 2.4;
  const minTick = Math.max(0, Math.floor((currentSpeed - 55) / 10) * 10);
  const maxTick = Math.ceil((currentSpeed + 55) / 10) * 10;
  const ticks: number[] = [];
  for (let s = minTick; s <= maxTick; s += 10) {
    ticks.push(s);
  }

  // 6-second Speed Trend Vector (cyan bar extending from center line 120px)
  const trendPx = Math.max(-65, Math.min(65, (hud.speedTrendKt || 0) * mult * pxPerUnit));

  // Ribbon Y coordinates (relative to tape center 120px)
  const stallTopY = 120 - (vs0 - currentSpeed) * pxPerUnit;
  const flapTopY = 120 - (Math.min(vs1 * 1.6, vne) - currentSpeed) * pxPerUnit;
  const vneBottomY = 120 - (vne - currentSpeed) * pxPerUnit;
  const targetSpdY = targetSpd !== null ? 120 - (targetSpd - currentSpeed) * pxPerUnit : null;

  return (
    <div
      className={`relative w-18 h-60 bg-slate-950/85 border-y border-l border-white/20 backdrop-blur-md overflow-hidden select-none ${
        minimal ? 'rounded-xl border shadow-2xl' : ''
      }`}
    >
      {/* Top Label */}
      <div className="absolute top-1 inset-x-0 text-center text-[9px] font-bold text-slate-400 z-20 flex items-center justify-center gap-1">
        <span>IAS</span>
        <span className="text-[8px] text-cyan-300 font-mono">({unit})</span>
      </div>

      {/* Moving Tape Elements Container */}
      <div className="absolute inset-0 pointer-events-none">
        {/* Red Stall Strip on right edge: from 0 up to vs0 */}
        <div
          className="absolute right-0 w-1.5 bg-rose-600/90 shadow-[0_0_8px_rgba(244,63,94,0.6)] z-10"
          style={{
            top: `${Math.max(0, stallTopY)}px`,
            bottom: 0,
          }}
        />

        {/* White Flaps Operating Strip: from vs0 up to vfe */}
        {flapTopY < stallTopY && (
          <div
            className="absolute right-0 w-1 bg-white/60 z-10"
            style={{
              top: `${Math.max(0, flapTopY)}px`,
              height: `${Math.max(0, stallTopY - Math.max(0, flapTopY))}px`,
            }}
          />
        )}

        {/* Red Overspeed Ribbon at top edge: from vne upwards */}
        {vneBottomY > 0 && (
          <div
            className="absolute right-0 w-1.5 bg-gradient-to-b from-rose-600 via-rose-500 to-amber-500 shadow-[0_0_8px_rgba(244,63,94,0.6)] z-10"
            style={{
              top: 0,
              height: `${Math.max(0, vneBottomY)}px`,
            }}
          />
        )}

        {/* Tape scale ticks */}
        {ticks.map((spd) => {
          const dy = 120 - (spd - currentSpeed) * pxPerUnit;
          if (dy < -10 || dy > 250) return null;
          return (
            <div key={spd} className="absolute right-0 flex items-center gap-1.5" style={{ top: `${dy}px` }}>
              <span className="text-[11px] font-mono tabular-nums font-bold text-slate-300">{spd}</span>
              <span className={`h-0.5 ${spd % 20 === 0 ? 'w-3.5 bg-white' : 'w-2 bg-slate-400'}`} />
            </div>
          );
        })}

        {/* V-Speed Markers on tape */}
        {[
          { label: 'V1', val: v1, color: 'text-cyan-300 bg-cyan-950/90 border-cyan-400/50' },
          { label: 'VR', val: vr, color: 'text-amber-300 bg-amber-950/90 border-amber-400/50' },
          { label: 'V2', val: v2, color: 'text-emerald-300 bg-emerald-950/90 border-emerald-400/50' },
          { label: 'REF', val: vapp, color: 'text-fuchsia-300 bg-fuchsia-950/90 border-fuchsia-400/50' },
        ].map((v) => {
          const dy = 120 - (v.val - currentSpeed) * pxPerUnit;
          if (dy < -15 || dy > 255) return null;
          return (
            <div
              key={v.label}
              className={`absolute left-1 -translate-y-1/2 px-1 py-0.2 rounded border text-[8px] font-mono font-black z-10 ${v.color}`}
              style={{ top: `${dy}px` }}
            >
              {v.label}
            </div>
          );
        })}

        {/* Target Airspeed Bug (Cyan Triangle) */}
        {targetSpdY !== null && targetSpdY >= -10 && targetSpdY <= 250 && (
          <div
            className="absolute right-0 w-0 h-0 border-t-[5px] border-t-transparent border-b-[5px] border-b-transparent border-r-[7px] border-r-cyan-400 -translate-y-1/2 z-20 drop-shadow-[0_0_6px_#22d3ee]"
            style={{ top: `${targetSpdY}px` }}
          />
        )}

        {/* Speed Trend Vector (6-second acceleration predictor) */}
        {Math.abs(trendPx) > 2 && (
          <div
            className="absolute right-1 w-1 bg-cyan-400 z-15 pointer-events-none"
            style={{
              top: trendPx > 0 ? `${120 - trendPx}px` : '120px',
              height: `${Math.abs(trendPx)}px`,
            }}
          >
            <div
              className={`w-2.5 h-0.5 bg-cyan-300 -ml-0.5 ${
                trendPx > 0 ? 'mt-0' : 'mt-auto'
              }`}
            />
          </div>
        )}
      </div>

      {/* Center Digital Pointer Box */}
      <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-8 bg-slate-900 border-y-2 border-r-2 border-cyan-400 flex items-center justify-center shadow-lg z-30">
        <span
          className={`font-mono tabular-nums text-base font-black ${
            hud.stall ? 'text-rose-400 animate-pulse' : 'text-white'
          }`}
        >
          {displaySpeed}
        </span>
      </div>

      {/* Bottom Groundspeed & Mach readout */}
      <div className="absolute bottom-1 inset-x-0 text-center text-[9px] font-mono tabular-nums text-cyan-300 font-bold z-20 bg-slate-950/90 py-0.5 border-t border-white/5">
        GS {Math.round(metric ? hud.gsKt * 1.852 : hud.gsKt)} {hud.mach > 0.4 && `· M${hud.mach.toFixed(2)}`}
      </div>
    </div>
  );
}

// 3. Altimeter & VSI Tape (Right of PFD) - Continuous smooth tape without snapping
function AltimeterTape({
  hud,
  metric,
  minimal = false,
}: {
  hud: HudState;
  metric: boolean;
  minimal?: boolean;
}) {
  const altFt = hud.altFt;
  const mult = metric ? 0.3048 : 1;
  const currentAlt = altFt * mult;
  const displayAlt = Math.round(currentAlt);
  const unit = metric ? 'M' : 'FT';

  const step = metric ? 50 : 100;
  const pxPerUnit = metric ? 0.8 : 0.24;

  const minTick = Math.max(0, Math.floor((currentAlt - 450) / step) * step);
  const maxTick = Math.ceil((currentAlt + 450) / step) * step;
  const ticks: number[] = [];
  for (let a = minTick; a <= maxTick; a += step) {
    ticks.push(a);
  }

  // Selected Target Altitude Bug
  const targetAlt = hud.ap.alt * mult;
  const targetAltY = hud.ap.on ? 120 - (targetAlt - currentAlt) * pxPerUnit : null;

  // Vertical Speed Needle deflection (-2000 to +2000 fpm)
  const vsiClamp = Math.max(-2000, Math.min(2000, hud.vsFpm));
  const vsiDeflection = (vsiClamp / 2000) * 80;

  return (
    <div
      className={`relative w-22 h-60 bg-slate-950/85 border-y border-r border-white/20 backdrop-blur-md overflow-hidden flex select-none ${
        minimal ? 'rounded-xl border shadow-2xl' : ''
      }`}
    >
      {/* Tape Area */}
      <div className="relative flex-1 h-full overflow-hidden">
        {/* Top Selected AP Alt */}
        <div className="absolute top-1 inset-x-0 text-center text-[9px] font-mono tabular-nums text-cyan-300 font-bold z-20 flex items-center justify-center gap-1">
          <span>AP</span>
          <span>{Math.round(targetAlt)}</span>
        </div>

        {/* Moving Altitude Tape Elements */}
        <div className="absolute inset-0 pointer-events-none">
          {ticks.map((alt) => {
            const dy = 120 - (alt - currentAlt) * pxPerUnit;
            if (dy < -10 || dy > 250) return null;
            return (
              <div key={alt} className="absolute left-0 flex items-center gap-1.5" style={{ top: `${dy}px` }}>
                <span className={`h-0.5 ${alt % (step * 2) === 0 ? 'w-3.5 bg-white' : 'w-2 bg-slate-400'}`} />
                <span className="text-[10px] font-mono tabular-nums font-bold text-slate-300">{alt}</span>
              </div>
            );
          })}

          {/* Target Altitude Bug (Cyan Triangle pointing into tape) */}
          {targetAltY !== null && targetAltY >= -10 && targetAltY <= 250 && (
            <div
              className="absolute left-0 w-0 h-0 border-t-[5px] border-t-transparent border-b-[5px] border-b-transparent border-l-[7px] border-l-cyan-400 -translate-y-1/2 z-20 drop-shadow-[0_0_6px_#22d3ee]"
              style={{ top: `${targetAltY}px` }}
            />
          )}
        </div>

        {/* Center Digital Altitude Pointer Box */}
        <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-8 bg-slate-900 border-y-2 border-l-2 border-cyan-400 flex items-center justify-center shadow-lg z-30">
          <span className="font-mono tabular-nums text-sm font-black text-white">{displayAlt}</span>
          <span className="text-[9px] font-sans font-bold text-slate-400 ml-1">{unit}</span>
        </div>

        {/* Radar Altimeter (AGL) / Baro at Bottom */}
        <div className="absolute bottom-1 inset-x-0 text-center text-[9px] font-mono tabular-nums font-bold z-20 bg-slate-950/90 py-0.5 border-t border-white/5">
          {hud.aglFt < 2500 ? (
            <span
              className={
                hud.aglFt < 100
                  ? 'text-rose-400 animate-pulse font-black'
                  : hud.aglFt < 400
                  ? 'text-amber-400 animate-pulse font-black'
                  : 'text-emerald-300'
              }
            >
              RA {Math.round(hud.aglFt * mult)}
            </span>
          ) : (
            <span className="text-slate-400">29.92 IN</span>
          )}
        </div>
      </div>

      {/* VSI (Vertical Speed Indicator) on outer right edge */}
      <div className="w-6 h-full bg-slate-900/90 border-l border-white/10 flex flex-col justify-between items-center py-2 relative">
        <span className="text-[8px] font-mono text-slate-400">+2</span>
        {Math.abs(hud.vsFpm) >= 100 ? (
          <span className="text-[8px] font-mono font-bold text-cyan-300">
            {hud.vsFpm > 0 ? `+${Math.round(hud.vsFpm / 100)}` : Math.round(hud.vsFpm / 100)}
          </span>
        ) : (
          <span className="text-[8px] font-mono text-slate-400">0</span>
        )}
        <span className="text-[8px] font-mono text-slate-400">-2</span>

        {/* Moving VSI Needle indicator */}
        <div
          className="absolute right-0 w-3.5 h-1.5 bg-cyan-400 rounded-l shadow-[0_0_8px_#38bdf8] transition-all duration-75 ease-out"
          style={{ top: `calc(50% - ${vsiDeflection}px)` }}
        />
      </div>
    </div>
  );
}

// 4. Central Artificial Horizon & Pitch Ladder - With true FPV flight path vector
function AttitudeIndicator({
  hud,
  assisted = false,
}: {
  hud: HudState;
  assisted?: boolean;
}) {
  const pitchDeg = hud.pitch;
  const bankDeg = hud.bank;
  const pxPerDeg = 3.2;
  const pitchOffset = pitchDeg * pxPerDeg;

  // Flight Path Vector (FPV / bird)
  // At level flight (fpaDeg = 0), FPV aligns with the horizon line
  // Climb angle fpaDeg lifts it above horizon, descent puts it below
  const fpaDeg = hud.fpaDeg || 0;
  const fpvY = (pitchDeg - fpaDeg) * pxPerDeg;
  const clampedFpvY = Math.max(-80, Math.min(80, fpvY));

  // Lateral drift on FPV: wrap180(track - heading)
  const driftDeg = wrap180((hud.track || hud.hdg) - hud.hdg);
  const fpvX = clamp(driftDeg * pxPerDeg, -45, 45);

  // ILS Glideslope & Localizer dots
  const ils = hud.ils;
  const hasIls = ils && ils.valid && ils.dist <= 25;

  // Assisted Mode: Pitch target cue on climb (e.g. 12°)
  const pitchTargetY =
    hud.pitchTarget !== null ? -(hud.pitchTarget * pxPerDeg) : null;

  // Assisted Mode: Flare prompt when landing (< 50ft AGL on final)
  const showFlare = assisted && hud.flightPhase === 'final' && hud.aglFt < 50 && hud.aglFt > 3;

  return (
    <div className="relative w-52 sm:w-60 h-60 bg-slate-950/70 border-y border-white/20 backdrop-blur-md overflow-hidden select-none">
      {/* Rotating Sky/Ground & Pitch Ladder Group */}
      <div
        className="absolute inset-0 w-full h-full flex items-center justify-center transition-transform duration-75 ease-out"
        style={{ transform: `rotate(${-bankDeg}deg)` }}
      >
        {/* Sky / Ground Background Canvas */}
        <div
          className="absolute w-[400px] h-[600px] flex flex-col"
          style={{ transform: `translateY(${pitchOffset}px)` }}
        >
          {/* Blue Sky */}
          <div className="flex-1 bg-gradient-to-t from-sky-600/40 via-sky-700/30 to-sky-950/20" />
          {/* Horizon Line */}
          <div className="h-0.5 bg-white w-full shadow-[0_0_8px_rgba(255,255,255,0.8)]" />
          {/* Brown Ground */}
          <div className="flex-1 bg-gradient-to-b from-amber-900/40 via-amber-950/35 to-stone-950/25" />

          {/* Pitch Ladder Rungs */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            {[-25, -20, -15, -10, -5, 5, 10, 15, 20, 25].map((deg) => {
              const dy = -deg * pxPerDeg;
              const isPos = deg > 0;
              return (
                <div
                  key={deg}
                  className="absolute flex items-center gap-2"
                  style={{ top: `calc(50% + ${dy}px)` }}
                >
                  <span className="text-[9px] font-mono tabular-nums font-bold text-white/90 drop-shadow">{Math.abs(deg)}</span>
                  <div
                    className={`h-0.5 ${isPos ? 'w-10 bg-white' : 'w-10 border-b border-dashed border-white'}`}
                  />
                  <span className="text-[9px] font-mono tabular-nums font-bold text-white/90 drop-shadow">{Math.abs(deg)}</span>
                </div>
              );
            })}

            {/* Assisted Mode Pitch Target Bracket (e.g. 12° climb notch) */}
            {assisted && pitchTargetY !== null && (
              <div
                className="absolute flex items-center gap-1.5 z-10"
                style={{ top: `calc(50% + ${pitchTargetY}px)` }}
              >
                <span className="text-[9px] font-mono font-black text-emerald-300 drop-shadow">CLIMB</span>
                <div className="w-14 h-1.5 border-x-2 border-t-2 border-emerald-400 bg-emerald-400/20 shadow-[0_0_10px_#34d399]" />
                <span className="text-[9px] font-mono font-black text-emerald-300 drop-shadow">{hud.pitchTarget}°</span>
              </div>
            )}
          </div>
        </div>

        {/* Flight Path Vector (FPV 'Bird') - Roll stabilized with horizon */}
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none z-25 transition-transform duration-75 ease-out"
          style={{ transform: `translate(${fpvX}px, ${clampedFpvY}px)` }}
        >
          <div className="relative flex items-center justify-center">
            <div className="w-4 h-4 rounded-full border-2 border-cyan-300 bg-cyan-400/20 shadow-[0_0_8px_rgba(34,211,238,0.6)]" />
            <div className="absolute -left-3 w-3 h-0.5 bg-cyan-300" />
            <div className="absolute -right-3 w-3 h-0.5 bg-cyan-300" />
            <div className="absolute -top-3 w-0.5 h-3 bg-cyan-300" />
          </div>
        </div>

        {/* Bank Angle Pointer at top rim */}
        <div className="absolute top-2 w-0 h-0 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent border-t-[8px] border-t-white drop-shadow" />
      </div>

      {/* Fixed Center Aircraft Symbol (Yellow/White Wings) */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
        <div className="flex items-center">
          <div className="w-8 h-1 bg-amber-400 rounded-l shadow-[0_0_6px_#f59e0b]" />
          <div className="w-2.5 h-2.5 rounded-full border-2 border-amber-400 mx-1 bg-slate-950" />
          <div className="w-8 h-1 bg-amber-400 rounded-r shadow-[0_0_6px_#f59e0b]" />
        </div>
      </div>

      {/* Assisted Mode Flare Prompt */}
      {showFlare && (
        <div className="absolute inset-x-0 bottom-6 text-center z-30 pointer-events-none animate-bounce">
          <span className="px-3 py-1 rounded-full bg-emerald-500/90 text-slate-950 font-black text-xs tracking-wider border border-emerald-300 shadow-[0_0_15px_#34d399]">
            ⬆ PULL TO FLARE
          </span>
        </div>
      )}

      {/* ILS Glideslope & Localizer Cues */}
      {hasIls && (
        <>
          {/* Glideslope diamond on right */}
          <div
            className="absolute right-2 top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-fuchsia-400 rotate-45 border border-white shadow-[0_0_8px_#e879f9] transition-transform duration-75"
            style={{ transform: `translateY(${-Math.max(-2, Math.min(2, ils.gsDots)) * 25}px) rotate(45deg)` }}
          />
          {/* Localizer diamond at bottom */}
          <div
            className="absolute bottom-2 left-1/2 -translate-x-1/2 w-2.5 h-2.5 bg-fuchsia-400 rotate-45 border border-white shadow-[0_0_8px_#e879f9] transition-transform duration-75"
            style={{ transform: `translateX(${Math.max(-2, Math.min(2, ils.locDots)) * 25}px) rotate(45deg)` }}
          />
        </>
      )}
    </div>
  );
}

// 5. Compass Ribbon / Horizontal Situation Indicator (Bottom of PFD) - With Ground Track Bug
function CompassRibbon({ hud }: { hud: HudState }) {
  const hdg = ((hud.hdg % 360) + 360) % 360;
  const pxPerDeg = 2.4;

  const points = [
    { d: 0, l: 'N' },
    { d: 30, l: '03' },
    { d: 60, l: '06' },
    { d: 90, l: 'E' },
    { d: 120, l: '12' },
    { d: 150, l: '15' },
    { d: 180, l: 'S' },
    { d: 210, l: '21' },
    { d: 240, l: '24' },
    { d: 270, l: 'W' },
    { d: 300, l: '30' },
    { d: 330, l: '33' },
  ];

  // Ground track diamond offset
  const trackDiff = ((hud.track - hdg + 540) % 360) - 180;
  const trackDx = trackDiff * pxPerDeg;

  // AP heading bug offset
  const apDiff = ((hud.ap.hdg - hdg + 540) % 360) - 180;
  const apDx = apDiff * pxPerDeg;

  return (
    <div className="w-[390px] sm:w-[450px] h-12 rounded-b-xl bg-slate-950/90 border-b border-x border-white/20 backdrop-blur-md px-3 relative overflow-hidden flex items-center justify-between select-none">
      {/* Relative Wind Indicator (Section 3.7) */}
      <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-300 z-20">
        <div
          className="w-4 h-4 grid place-items-center transition-transform duration-150"
          style={{ transform: `rotate(${hud.relWindDir}deg)` }}
          title={`Wind direction relative to aircraft heading: ${Math.round(hud.relWindDir)}°`}
        >
          <span className="text-cyan-300 text-xs font-bold">↑</span>
        </div>
        <span>{hud.wind.kt}kt</span>
        {Math.abs(hud.crosswindKt) > 2 && (
          <span className="text-[9px] text-slate-400">
            X{Math.abs(hud.crosswindKt)}{hud.crosswindKt > 0 ? 'R' : 'L'}
          </span>
        )}
      </div>

      {/* Moving Compass Ribbon in Center */}
      <div className="absolute inset-y-0 inset-x-20 overflow-hidden flex items-center justify-center pointer-events-none">
        {[-360, 0, 360].map((shift) => (
          <div key={shift} className="absolute inset-0 flex items-center justify-center">
            {points.map((p) => {
              const degDiff = p.d + shift - hdg;
              const dx = degDiff * pxPerDeg;
              if (Math.abs(dx) > 130) return null;
              const isCardinal = p.l === 'N' || p.l === 'E' || p.l === 'S' || p.l === 'W';
              return (
                <div
                  key={p.d + shift}
                  className="absolute flex flex-col items-center"
                  style={{ transform: `translateX(${dx}px)` }}
                >
                  <span
                    className={`text-[10px] font-mono font-bold ${
                      isCardinal ? 'text-cyan-300 font-black' : 'text-slate-400'
                    }`}
                  >
                    {p.l}
                  </span>
                  <div className={`h-2 ${isCardinal ? 'w-0.5 bg-cyan-300' : 'w-px bg-slate-500'}`} />
                </div>
              );
            })}
          </div>
        ))}

        {/* AP Heading Bug (Cyan Tick) */}
        {hud.ap.on && Math.abs(apDx) <= 125 && (
          <div
            className="absolute top-1 w-0 h-0 border-l-[4px] border-l-transparent border-r-[4px] border-r-transparent border-t-[6px] border-t-cyan-400 z-10 drop-shadow-[0_0_6px_#22d3ee]"
            style={{ transform: `translateX(${apDx}px)` }}
            title={`AP Target Heading: ${Math.round(hud.ap.hdg)}°`}
          />
        )}

        {/* Ground Track Diamond (Magenta/Cyan) per Section 3.1 */}
        {Math.abs(trackDx) <= 125 && (
          <div
            className="absolute bottom-1 w-2 h-2 rotate-45 border border-fuchsia-300 bg-fuchsia-500 shadow-[0_0_6px_#d946ef] z-10"
            style={{ transform: `translateX(${trackDx}px) rotate(45deg)` }}
            title={`Actual Ground Track: ${Math.round(hud.track || hdg)}°`}
          />
        )}
      </div>

      {/* Center Lubber Line Pointer Box */}
      <div className="relative z-20 px-2 py-0.5 rounded bg-slate-900 border border-cyan-400 flex items-center gap-1 shadow">
        <span className="font-mono tabular-nums text-xs font-black text-white">
          {String(Math.round(hdg)).padStart(3, '0')}°
        </span>
        <span className="text-[9px] text-cyan-300 font-bold">MAG</span>
      </div>

      {/* Approach Runway on Right */}
      <div className="flex items-center gap-1 text-[10px] font-mono text-amber-300 z-20">
        <span>RWY {hud.apprRwy || '--'}</span>
        {hud.rwyDistNm > 0 && <span className="text-slate-400 text-[9px]">({hud.rwyDistNm.toFixed(1)}nm)</span>}
      </div>
    </div>
  );
}

// Complete Primary Flight Display Assembly
function PrimaryFlightDisplay({
  hud,
  metric,
  assisted = false,
}: {
  hud: HudState;
  metric: boolean;
  assisted?: boolean;
}) {
  return (
    <div className="flex flex-col items-center pointer-events-auto shadow-2xl animate-[fadein_.3s_ease-out]">
      <FlightModeAnnunciator hud={hud} />
      <div className="flex items-center">
        <AirspeedTape hud={hud} metric={metric} />
        <AttitudeIndicator hud={hud} assisted={assisted} />
        <AltimeterTape hud={hud} metric={metric} />
      </div>
      <CompassRibbon hud={hud} />
    </div>
  );
}

/* =========================================================================
   TOP MSFS QUICK ACCESS TOOLBAR (CAMERA, NAVMAP, AP, AUDIO, PAUSE, HUD MODE)
   ========================================================================= */
function MsfsToolbar({
  game,
  settings,
  setSettings,
  onMap,
  mapOpen,
  hudMode,
  setHudMode,
  onToggleApConsole,
  apConsoleOpen,
}: {
  game: Game;
  settings: Settings;
  setSettings: (p: Partial<Settings>) => void;
  onMap: () => void;
  mapOpen: boolean;
  hudMode: HudMode;
  setHudMode: (m: HudMode) => void;
  onToggleApConsole?: () => void;
  apConsoleOpen?: boolean;
}) {
  const nextModeMap: Record<HudMode, HudMode> = {
    standard: 'minimal',
    minimal: 'assisted',
    assisted: 'cockpit',
    cockpit: 'standard',
  };

  const handleCycleMode = () => {
    const next = nextModeMap[hudMode] || 'standard';
    setHudMode(next);
    setSettings({ hudMode: next });
  };

  const hud = game.hud();

  return (
    <div className="absolute top-2 sm:top-3 left-1/2 -translate-x-1/2 z-30 pointer-events-auto flex items-center gap-1 sm:gap-1.5 p-1 rounded-2xl bg-slate-950/85 border border-white/20 backdrop-blur-md shadow-2xl max-w-[calc(100vw-16px)] sm:max-w-none">
      <Btn
        onClick={() => game.cycleView()}
        title="Cycle Camera View (C) [Cockpit, Chase, Spotter, Aisle, Window]"
        className="flex items-center gap-1 sm:gap-1.5 !px-2 sm:!px-3"
      >
        <span>📷</span>
        <span className="uppercase tracking-wider text-[10px] hidden md:inline">{game.viewName()}</span>
      </Btn>

      <Btn onClick={onMap} on={mapOpen} title="Toggle World Moving Map (M)" className="!px-2 sm:!px-3">
        <span>🗺️</span>
        <span className="hidden sm:inline ml-1">Map</span>
      </Btn>

      <div className="flex items-center gap-0.5">
        <Btn
          onClick={() => game.action('ap')}
          on={hud.ap.on}
          title="Toggle Master Autopilot (Y)"
          className="!px-2 sm:!px-3"
        >
          <span>🕹️</span>
          <span className="hidden sm:inline ml-1">{hud.ap.on ? 'AP ON' : 'AP'}</span>
          <span className="sm:hidden ml-0.5 text-[10px]">{hud.ap.on ? 'ON' : 'AP'}</span>
        </Btn>
        {onToggleApConsole && (
          <button
            onClick={onToggleApConsole}
            className={`px-1.5 py-1.5 rounded-xl text-[10px] font-bold border backdrop-blur-md transition ${
              apConsoleOpen
                ? 'bg-cyan-400 text-slate-950 border-cyan-300'
                : 'bg-slate-950/70 text-slate-400 border-white/15 hover:text-white'
            }`}
            title="Toggle Autopilot Guidance & Tuning Console"
          >
            ⚙
          </button>
        )}
      </div>

      <button
        onClick={handleCycleMode}
        className="px-2 sm:px-2.5 py-1.5 rounded-xl text-xs font-bold border border-white/15 bg-white/5 hover:bg-white/15 backdrop-blur text-slate-200 transition flex items-center gap-1"
        title="Cycle HUD Display Mode (H) [Standard, Minimal, Assisted, Cockpit]"
      >
        <span>🖥️</span>
        <span className="uppercase text-[10px] tracking-wider text-cyan-300 hidden md:inline">
          {hudMode === 'standard'
            ? 'Standard'
            : hudMode === 'minimal'
            ? 'Minimal'
            : hudMode === 'assisted'
            ? 'Assisted'
            : 'Cockpit'}
        </span>
      </button>

      {/* Flight Phase Badge */}
      <div
        className="px-2.5 py-1 rounded-xl text-[10px] font-black uppercase tracking-wider bg-white/5 border border-white/10 text-emerald-400 font-mono hidden lg:inline-block"
        title={`Current Flight Phase: ${hud.flightPhase?.toUpperCase() || 'CRUISE'}`}
      >
        {hud.flightPhase?.toUpperCase() || 'CRUISE'}
      </div>

      <Btn
        onClick={() => {
          game.setMuted(!settings.muted);
          setSettings({ muted: !settings.muted });
        }}
        title="Toggle Master Audio"
        className="!px-2 sm:!px-3"
      >
        {settings.muted ? '🔇' : '🔊'}
      </Btn>

      <Btn onClick={() => game.pause()} title="Pause Flight (P / Esc)" className="!px-2 sm:!px-3">
        ⏸️
      </Btn>
    </div>
  );
}

/* =========================================================================
   TACTICAL ENGINE & FLIGHT CONTROLS SUB-PANEL (BOTTOM DOCK)
   ========================================================================= */
function TacticalFlightDock({
  game,
  hud,
  colorblind = false,
  onToggleApConsole,
}: {
  game: Game;
  hud: HudState;
  metric: boolean;
  colorblind?: boolean;
  onToggleApConsole?: () => void;
}) {
  const gearAllDown = hud.gear > 0.98;
  const gearTransit = hud.gear > 0.02 && hud.gear < 0.98;
  void colorblind;

  return (
    <div className="rounded-2xl bg-slate-950/85 border border-white/20 backdrop-blur-md px-2.5 sm:px-4 py-1.5 flex items-center gap-2 sm:gap-4 text-white shadow-2xl pointer-events-auto max-w-[96vw] overflow-x-auto no-scrollbar">
      {/* Throttle & Engine Thrust / N1 */}
      <div className="flex items-center gap-2">
        <div className="w-3 h-11 rounded bg-white/10 overflow-hidden flex items-end border border-white/10">
          <div
            className="w-full bg-gradient-to-t from-cyan-400 to-emerald-300 transition-all duration-75"
            style={{ height: `${hud.throttle * 100}%` }}
          />
        </div>
        <div>
          <span className="text-[9px] text-slate-400 uppercase tracking-widest block font-bold">Thrust / N1</span>
          <span className="font-mono text-sm font-black text-cyan-300 tabular-nums">
            {Math.round(hud.throttle * 100)}%
          </span>
        </div>
      </div>

      <div className="w-px h-8 bg-white/10" />

      {/* 3-Green Landing Gear Indicators */}
      <div>
        <span className="text-[9px] text-slate-400 uppercase tracking-widest block font-bold mb-1">Gear</span>
        <div className="flex items-center gap-1.5">
          {['N', 'L', 'R'].map((id) => (
            <div
              key={id}
              className={`w-3.5 h-3.5 rounded-full border grid place-items-center text-[8px] font-black ${
                gearAllDown
                  ? 'bg-emerald-400 text-slate-950 border-emerald-300 shadow-[0_0_8px_#34d399]'
                  : gearTransit
                  ? 'bg-amber-400 text-slate-950 border-amber-300 animate-pulse'
                  : 'bg-slate-800 text-slate-500 border-white/10'
              }`}
              title={gearAllDown ? 'Down & Locked' : gearTransit ? 'In Transit' : 'Gear Up'}
            >
              {id}
            </div>
          ))}
        </div>
      </div>

      <div className="w-px h-8 bg-white/10" />

      {/* Flaps, Trim & Spoilers */}
      <div>
        <span className="text-[9px] text-slate-400 uppercase tracking-widest block font-bold">Aero / Trim</span>
        <div className="flex items-center gap-2 text-xs font-mono font-bold mt-0.5 tabular-nums">
          <span className="text-sky-300">FLAP {hud.flapsIdx}/{hud.flapsDet}</span>
          <span className="text-slate-400 text-[10px]">
            TRM {hud.trim >= 0 ? `+${(hud.trim * 10).toFixed(1)}°` : `${(hud.trim * 10).toFixed(1)}°`}
          </span>
          {hud.spoilers > 0.05 && <span className="text-rose-400 animate-pulse">SPOILERS</span>}
          {hud.reverse && <span className="text-amber-400 animate-pulse">REV</span>}
        </div>
      </div>

      <div className="w-px h-8 bg-white/10" />

      {/* Autopilot Status & Controls */}
      <div>
        <span className="text-[9px] text-slate-400 uppercase tracking-widest block font-bold">Autopilot</span>
        <div className="flex items-center gap-1 mt-0.5">
          <button
            onClick={() => game.action('ap')}
            className={`font-mono text-xs font-black px-2 py-0.5 rounded transition ${
              hud.ap.on
                ? 'bg-cyan-400 text-slate-950 shadow-[0_0_8px_#22d3ee]'
                : 'bg-white/10 text-slate-400 hover:text-white hover:bg-white/20'
            }`}
            title="Toggle Master Autopilot (Y)"
          >
            {hud.ap.on ? (hud.ap.nav ? 'AP NAV' : hud.ap.appr ? 'AP APPR' : 'AP HDG') : 'AP OFF'}
          </button>
          {onToggleApConsole && (
            <button
              onClick={onToggleApConsole}
              className="text-[10px] text-slate-400 hover:text-cyan-300 px-1 py-0.5 rounded hover:bg-white/10 transition"
              title="Open Autopilot Guidance & Tuning Console"
            >
              ⚙
            </button>
          )}
        </div>
      </div>

      <div className="w-px h-8 bg-white/10" />

      {/* Brakes Status */}
      <div>
        <span className="text-[9px] text-slate-400 uppercase tracking-widest block font-bold">Brakes</span>
        <span
          className={`font-mono text-xs font-black ${
            hud.parking ? 'text-amber-400' : hud.brake ? 'text-rose-400' : 'text-slate-500'
          }`}
        >
          {hud.parking ? 'PARK BRK' : hud.brake ? 'BRAKES ON' : 'RELEASED'}
        </span>
      </div>

      <div className="w-px h-8 bg-white/10" />

      {/* Fuel Endurance & G-Force */}
      <div>
        <span className="text-[9px] text-slate-400 uppercase tracking-widest block font-bold">Fuel / Endur</span>
        <div className="flex items-center gap-1.5 text-xs font-mono font-bold mt-0.5 tabular-nums">
          <span className="text-amber-300">{Math.round(hud.fuelPct)}%</span>
          <span className="text-slate-500">·</span>
          <span className="text-cyan-300 text-[11px]" title="Estimated Fuel Time Remaining">
            {hud.fuelTimeMin > 0 ? `${fmtT(hud.fuelTimeMin)} rem` : '99m+'}
          </span>
          <span className="text-slate-500">·</span>
          <span className="text-white text-[11px]">{hud.nz.toFixed(1)}G</span>
        </div>
      </div>

      <div className="w-px h-8 bg-white/10 hidden md:block" />

      {/* Aircraft Exterior Lights */}
      <div className="hidden md:block">
        <span className="text-[9px] text-slate-400 uppercase tracking-widest block font-bold mb-1">Lights</span>
        <div className="flex items-center gap-1 text-[9px] font-mono font-bold">
          <span
            className={`px-1 rounded border ${
              hud.lights?.nav
                ? 'bg-emerald-400/20 text-emerald-300 border-emerald-400/40'
                : 'bg-white/5 text-slate-500 border-white/5'
            }`}
          >
            NAV
          </span>
          <span
            className={`px-1 rounded border ${
              hud.lights?.land
                ? 'bg-cyan-400/20 text-cyan-300 border-cyan-400/40'
                : 'bg-white/5 text-slate-500 border-white/5'
            }`}
          >
            LDG
          </span>
          <span
            className={`px-1 rounded border ${
              hud.lights?.strobe
                ? 'bg-amber-400/20 text-amber-300 border-amber-400/40'
                : 'bg-white/5 text-slate-500 border-white/5'
            }`}
          >
            STRB
          </span>
          <span
            className={`px-1 rounded border ${
              hud.lights?.beacon
                ? 'bg-rose-400/20 text-rose-300 border-rose-400/40'
                : 'bg-white/5 text-slate-500 border-white/5'
            }`}
          >
            BCN
          </span>
        </div>
      </div>

      <div className="w-px h-8 bg-white/10 hidden lg:block" />

      {/* Passenger Comfort */}
      <div className="hidden lg:flex items-center gap-2">
        <span className="text-base">{hud.comfort > 70 ? '😊' : hud.comfort > 40 ? '😐' : '😨'}</span>
        <div>
          <span className="text-[9px] text-slate-400 uppercase tracking-widest block font-bold">Pax Comfort</span>
          <div className="flex items-center gap-1.5">
            <div className="w-14 h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${hud.comfort}%`,
                  background: hud.comfort > 60 ? '#34d399' : hud.comfort > 35 ? '#fbbf24' : '#f87171',
                }}
              />
            </div>
            <span className="font-mono text-xs font-bold text-slate-300 tabular-nums">{Math.round(hud.comfort)}%</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   FLIGHT WARNINGS & ANNUNCIATOR BANNER (TOP-CENTER)
   ========================================================================= */
function WarningsBanner({
  game,
  hud,
  colorblind = false,
  showHint = true,
}: {
  game: Game;
  hud: HudState;
  colorblind?: boolean;
  showHint?: boolean;
}) {
  const warnings = hud.warn || [];
  const sorted = [...warnings].sort((a, b) => {
    if (a.acked !== b.acked) return a.acked ? 1 : -1;
    if (a.level === 'warning' && b.level !== 'warning') return -1;
    if (b.level === 'warning' && a.level !== 'warning') return 1;
    return 0;
  });

  const primary = sorted[0];
  const queueCount = sorted.length - 1;
  const isRed = primary?.level === 'warning';
  const isAcked = !!primary?.acked;

  if (warnings.length === 0 && (!showHint || !hud.hint)) {
    return null;
  }

  return (
    <div className="absolute top-12 sm:top-16 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 z-30 pointer-events-none max-w-[280px] sm:max-w-md animate-[fadein_.15s_ease-out]">
      {warnings.length > 0 && (
        <div className="pointer-events-auto flex flex-col items-center gap-1">
          <button
            onClick={() => game.action('ackWarn')}
            title="Click or press 'A' to acknowledge warning"
            className={`px-3.5 sm:px-5 py-1.5 sm:py-2 rounded-xl font-black tracking-widest text-xs sm:text-sm border shadow-2xl flex items-center gap-2 transition active:scale-95 cursor-pointer select-none ${
              isAcked
                ? 'bg-slate-900/90 border-slate-600 text-slate-300 shadow-md'
                : isRed
                ? 'bg-red-600/95 border-red-300 text-white animate-pulse shadow-[0_0_25px_rgba(239,68,68,0.7)]'
                : 'bg-amber-400/95 text-slate-950 border-amber-200 shadow-[0_0_20px_rgba(245,158,11,0.5)]'
            }`}
          >
            <span className="text-sm sm:text-base font-mono">{colorblind ? (isRed ? '▲ [WARN]' : '■ [CAUT]') : '⚠'}</span>
            <span className="uppercase">{primary.text}</span>
            {!isAcked && (
              <span className="ml-1 sm:ml-2 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-black/30 border border-white/20 text-white">
                ACK (A)
              </span>
            )}
          </button>

          {queueCount > 0 && (
            <div className="px-2.5 py-0.5 rounded-full bg-slate-950/90 border border-white/20 text-[9px] font-bold text-amber-300 backdrop-blur-md shadow-lg pointer-events-none">
              +{queueCount} MORE {queueCount === 1 ? 'ALERT' : 'ALERTS'} ACTIVE
            </div>
          )}
        </div>
      )}

      {showHint && hud.hint && (
        <div className="pointer-events-auto px-3 py-0.5 rounded-full bg-slate-950/85 border border-cyan-400/40 backdrop-blur-md text-center text-[11px] font-semibold text-cyan-200 shadow-xl flex items-center gap-1.5 max-w-sm sm:max-w-md truncate">
          <span className="text-xs">💡</span>
          <span className="truncate">{hud.hint}</span>
        </div>
      )}
    </div>
  );
}


/* =========================================================================
   ATC RADIO COMMUNICATIONS PANEL & MODAL LOG
   ========================================================================= */
function AtcPanel({
  game,
  hud,
  isMobile = false,
  onOpenLog,
}: {
  game: Game;
  hud: HudState;
  isMobile?: boolean;
  onOpenLog: () => void;
}) {
  const [minimized, setMinimized] = useState(isMobile);
  const atc = hud.atc;
  const atcLog = hud.atcLog || [];
  const prevAtcRef = useRef(atc);

  // Auto-expand when a new ATC transmission arrives
  useEffect(() => {
    if (atc && atc !== prevAtcRef.current) {
      prevAtcRef.current = atc;
      setMinimized(false);
    }
  }, [atc]);

  const handleRespond = (opt: number) => {
    game.action(`atc${opt}`);
  };

  return (
    <div
      className="w-full rounded-2xl bg-slate-950/85 border border-white/20 backdrop-blur-md p-2.5 sm:p-3 text-white shadow-2xl pointer-events-auto transition-all"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-white/10 pb-1.5 mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-xs">📻</span>
          <span className="text-[10px] font-black tracking-widest text-cyan-300 uppercase">ATC RADIO COMMS</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onOpenLog}
            className="text-[9px] font-bold text-slate-400 hover:text-white px-1.5 py-0.5 rounded bg-white/5 border border-white/10 transition"
            title="Open ATC Transmission Log Popup"
          >
            Logs ({atcLog.length})
          </button>
          <button
            onClick={() => setMinimized(!minimized)}
            className="text-[10px] font-bold text-slate-400 hover:text-white px-1 rounded hover:bg-white/10 transition"
            title={minimized ? 'Expand ATC Panel' : 'Minimize ATC Panel'}
          >
            {minimized ? '+' : '–'}
          </button>
        </div>
      </div>

      {!minimized ? (
        <>
          {/* Active Transmission */}
          {atc ? (
            <div className="rounded-xl bg-white/5 p-2 border border-white/10 text-xs mb-2">
              <div className="flex items-center justify-between mb-1">
                <span
                  className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded ${
                    atc.sender === 'PILOT'
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/30'
                      : 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/30'
                  }`}
                >
                  {atc.sender}
                </span>
                <span className="text-[9px] font-mono text-slate-400">
                  {Math.floor(atc.time / 60)}:{String(Math.floor(atc.time % 60)).padStart(2, '0')}
                </span>
              </div>
              <p className="font-medium text-slate-200 leading-snug text-[11px] sm:text-xs">{atc.text}</p>
            </div>
          ) : (
            <div className="text-slate-400 text-[11px] py-1 text-center font-mono">Standby · 121.500 MHz</div>
          )}

          {/* Quick Responses (Hotkeys 1-4) */}
          <div className="grid grid-cols-2 gap-1 pt-0.5">
            <button
              onClick={() => handleRespond(1)}
              className="px-2 py-1.5 rounded-lg bg-white/5 hover:bg-cyan-500/20 border border-white/10 hover:border-cyan-400/40 text-[10px] font-bold text-slate-200 text-left transition active:scale-95 flex items-center gap-1.5"
              title="Press 1: Wilco / Roger"
            >
              <span className="w-3.5 h-3.5 rounded bg-cyan-400/20 text-cyan-300 font-mono grid place-items-center text-[9px] font-black border border-cyan-400/30">
                1
              </span>
              <span className="truncate">Roger / Wilco</span>
            </button>
            <button
              onClick={() => handleRespond(2)}
              className="px-2 py-1.5 rounded-lg bg-white/5 hover:bg-cyan-500/20 border border-white/10 hover:border-cyan-400/40 text-[10px] font-bold text-slate-200 text-left transition active:scale-95 flex items-center gap-1.5"
              title="Press 2: Departure Clearance"
            >
              <span className="w-3.5 h-3.5 rounded bg-cyan-400/20 text-cyan-300 font-mono grid place-items-center text-[9px] font-black border border-cyan-400/30">
                2
              </span>
              <span className="truncate">Req Departure</span>
            </button>
            <button
              onClick={() => handleRespond(3)}
              className="px-2 py-1.5 rounded-lg bg-white/5 hover:bg-cyan-500/20 border border-white/10 hover:border-cyan-400/40 text-[10px] font-bold text-slate-200 text-left transition active:scale-95 flex items-center gap-1.5"
              title="Press 3: Approach Clearance"
            >
              <span className="w-3.5 h-3.5 rounded bg-cyan-400/20 text-cyan-300 font-mono grid place-items-center text-[9px] font-black border border-cyan-400/30">
                3
              </span>
              <span className="truncate">Req Approach</span>
            </button>
            <button
              onClick={() => handleRespond(4)}
              className="px-2 py-1.5 rounded-lg bg-white/5 hover:bg-cyan-500/20 border border-white/10 hover:border-cyan-400/40 text-[10px] font-bold text-slate-200 text-left transition active:scale-95 flex items-center gap-1.5"
              title="Press 4: Say Again"
            >
              <span className="w-3.5 h-3.5 rounded bg-cyan-400/20 text-cyan-300 font-mono grid place-items-center text-[9px] font-black border border-cyan-400/30">
                4
              </span>
              <span className="truncate">Say Again</span>
            </button>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-between text-[11px] text-slate-300 py-0.5">
          <span className="truncate font-mono text-[10px] max-w-[170px]">
            {atc ? `${atc.sender}: ${atc.text}` : 'Standby · 121.5 MHz'}
          </span>
          <button
            onClick={() => handleRespond(1)}
            className="ml-1 text-[9px] font-bold px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-400/30 shrink-0"
          >
            Wilco (1)
          </button>
        </div>
      )}
    </div>
  );
}

function AtcHistoryModal({
  atcLog,
  onClose,
}: {
  atcLog: Array<{ id: number; sender: string; text: string; time: number }>;
  onClose: () => void;
}) {
  return (
    <Modal title="ATC Radio Transmission Log" onClose={onClose}>
      <div className="space-y-2.5 max-h-[60vh] overflow-y-auto pr-1">
        {atcLog.length === 0 ? (
          <div className="text-slate-400 text-center py-8 font-mono text-xs">
            No radio transmissions recorded on this flight yet.
          </div>
        ) : (
          atcLog.map((m) => (
            <div key={m.id} className="p-3 rounded-xl bg-white/5 border border-white/10 flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <span
                  className={`font-mono font-bold uppercase px-2 py-0.5 rounded text-[10px] ${
                    m.sender === 'PILOT'
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/30'
                      : 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/30'
                  }`}
                >
                  {m.sender}
                </span>
                <span className="text-[10px] font-mono text-slate-400">
                  {Math.floor(m.time / 60)}:{String(Math.floor(m.time % 60)).padStart(2, '0')}
                </span>
              </div>
              <p className="text-sm text-slate-200 mt-1 font-sans">{m.text}</p>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}

/* =========================================================================
   ASSISTED MODE GUIDANCE DOCK (CONTEXTUAL COACHING)
   ========================================================================= */
function AssistedGuideDock({ hud }: { hud: HudState }) {
  const phase = hud.flightPhase || 'cruise';
  let message = '';
  let sub = '';

  switch (phase) {
    case 'taxi':
      message = 'Taxi to Runway Threshold';
      sub = `Ground speed max 20 kt · Align with runway ${hud.depRwy || ''} · Release parking brake (B)`;
      break;
    case 'takeoff':
      message = 'Takeoff Roll & Rotation';
      sub = `Full throttle (F4) · Keep centerline · Rotate at Vr (${Math.round(hud.v1 || 135)} kt) to +12° pitch`;
      break;
    case 'climb':
      message = 'Initial Climb';
      sub = 'Positive rate: retract gear (G) · Retract flaps (F5) · Climb toward cruise altitude';
      break;
    case 'cruise':
      message = 'Enroute Cruise';
      sub = 'Level flight · Autopilot available (Y) · Monitor heading & fuel consumption';
      break;
    case 'descent':
      message = 'Descent to Approach';
      sub = `Reduce throttle · Descend toward IAF · Set approach runway ${hud.apprRwy || ''}`;
      break;
    case 'final':
      if (hud.aglFt < 55) {
        message = 'TOUCHDOWN FLARE!';
        sub = 'Gently pull pitch up to 4°–5° · Retard throttle to IDLE';
      } else {
        message = 'Final Landing Approach';
        sub = `Gear 3-green (G) · Full flaps (F6) · Track ILS localizer & glideslope · Speed ${Math.round(hud.vs0 * 1.3)} kt`;
      }
      break;
    case 'rollout':
      message = 'Landing Rollout';
      sub = 'Apply reverse thrust & wheel brakes (Space/B) · Decelerate to taxi speed';
      break;
  }

  return (
    <div className="z-20 pointer-events-none animate-[fadein_.25s_ease-out]">
      <div className="px-3.5 py-1 rounded-2xl bg-slate-950/90 border border-emerald-400/40 backdrop-blur-md text-center shadow-2xl max-w-lg">
        <div className="text-[10px] font-black uppercase tracking-widest text-emerald-400 flex items-center justify-center gap-1.5 truncate">
          <span>🎓 ASSIST</span>
          <span>·</span>
          <span>{message}</span>
        </div>
        <div className="text-[11px] text-slate-200 font-medium mt-0.5 truncate">{sub}</div>
      </div>
    </div>
  );
}

/* =========================================================================
   MINIMAL HUD (UNOBSTRUCTED IMMERSION MODE)
   ========================================================================= */
function MinimalHUD({
  hud,
  metric,
  hideGauges = false,
  isMobile = false,
}: {
  hud: HudState;
  metric: boolean;
  hideGauges?: boolean;
  isMobile?: boolean;
}) {
  const pxPerDeg = 3.2;
  const pitchDeg = hud.pitch;
  const fpaDeg = hud.fpaDeg || 0;
  const fpvY = (pitchDeg - fpaDeg) * pxPerDeg;
  const clampedFpvY = Math.max(-70, Math.min(70, fpvY));

  // Lateral drift on FPV: wrap180(track - heading)
  const driftDeg = wrap180((hud.track || hud.hdg) - hud.hdg);
  const fpvX = clamp(driftDeg * pxPerDeg, -60, 60);

  return (
    <div className="absolute inset-0 pointer-events-none">
      {/* Floating Airspeed Tape on Left Edge (desktop only to clear touch throttle) */}
      {!hideGauges && !isMobile && (
        <div className="absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 pointer-events-auto opacity-80 hover:opacity-100 transition-opacity">
          <AirspeedTape hud={hud} metric={metric} />
        </div>
      )}

      {/* Floating Altimeter Tape on Right Edge (desktop only to clear touch stick) */}
      {!hideGauges && !isMobile && (
        <div className="absolute right-3 sm:right-4 top-1/2 -translate-y-1/2 pointer-events-auto opacity-80 hover:opacity-100 transition-opacity">
          <AltimeterTape hud={hud} metric={metric} />
        </div>
      )}

      {/* Floating Heading Ribbon at Bottom (elevated on mobile portrait above touch stick) */}
      {!hideGauges && (
        <div className="absolute portrait:bottom-64 landscape:bottom-3 sm:bottom-6 left-1/2 -translate-x-1/2 pointer-events-auto opacity-80 hover:opacity-100 transition-opacity">
          <CompassRibbon hud={hud} />
        </div>
      )}

      {/* Center Flight Path Vector (FPV) */}
      <div
        className="absolute left-1/2 top-1/2 -ml-4 -mt-4 w-8 h-8 pointer-events-none transition-transform duration-75"
        style={{ transform: `translate(${fpvX}px, ${clampedFpvY}px)` }}
      >
        <svg viewBox="0 0 32 32" className="w-full h-full text-emerald-400 drop-shadow-[0_0_6px_#34d399]">
          <circle cx="16" cy="16" r="5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <line x1="4" y1="16" x2="11" y2="16" stroke="currentColor" strokeWidth="1.8" />
          <line x1="21" y1="16" x2="28" y2="16" stroke="currentColor" strokeWidth="1.8" />
          <line x1="16" y1="4" x2="16" y2="11" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      </div>
    </div>
  );
}

/* =========================================================================
   TOUCH CONTROLS (MOBILE / TABLET)
   ========================================================================= */
function TouchControls({ game, hud }: { game: Game; hud: HudState }) {
  const stickRef = useRef<HTMLDivElement>(null),
    thrRef = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });

  const stick = (e: React.PointerEvent, down = false) => {
    if (down) e.currentTarget.setPointerCapture(e.pointerId);
    else if (!(e.buttons & 1) && e.pointerType === 'mouse') return;
    if (!down && !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const r = stickRef.current!.getBoundingClientRect(),
      R = r.width / 2;
    let dx = (e.clientX - r.left - R) / R,
      dy = (e.clientY - r.top - R) / R;
    const m = Math.hypot(dx, dy);
    if (m > 1) {
      dx /= m;
      dy /= m;
    }
    const dz = (v: number) => (Math.abs(v) < 0.08 ? 0 : v);
    game.touch.roll = dz(dx);
    game.touch.pitch = dz(dy);
    setKnob({ x: dx, y: dy });
  };

  const release = () => {
    game.touch.roll = 0;
    game.touch.pitch = 0;
    setKnob({ x: 0, y: 0 });
  };

  const thr = (e: React.PointerEvent, down = false) => {
    if (down) e.currentTarget.setPointerCapture(e.pointerId);
    else if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const r = thrRef.current!.getBoundingClientRect();
    game.fm.ctl.throttle = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
  };

  return (
    <>
      <div className="absolute left-2 sm:left-3 bottom-3 sm:bottom-4 flex items-end gap-2.5 sm:gap-3 z-20 pointer-events-auto">
        <div
          ref={thrRef}
          onPointerDown={(e) => {
            e.stopPropagation();
            thr(e, true);
          }}
          onPointerMove={thr}
          className="relative w-14 h-44 rounded-2xl bg-slate-950/80 border border-white/25 backdrop-blur-md touch-none overflow-hidden"
        >
          <div
            className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-cyan-400/80 to-emerald-300/70"
            style={{ height: `${hud.throttle * 100}%` }}
          />
          <div className="absolute inset-x-0 text-center text-[10px] font-bold top-1 text-white/80">THR</div>
          <div className="absolute inset-x-0 text-center text-xs font-black bottom-1 text-white">
            {Math.round(hud.throttle * 100)}%
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Hold className="w-14 h-14 text-lg" onDown={() => (game.touch.yaw = -1)} onUp={() => (game.touch.yaw = 0)}>
            ◀
          </Hold>
          <Hold className="w-14 h-14 text-lg" onDown={() => (game.touch.yaw = 1)} onUp={() => (game.touch.yaw = 0)}>
            ▶
          </Hold>
        </div>
      </div>
      <div className="absolute right-2 sm:right-3 bottom-3 sm:bottom-4 z-20 flex flex-col items-end gap-2.5 sm:gap-3 pointer-events-auto">
        <div className="grid grid-cols-3 gap-1.5">
          <Btn on={hud.gearDown} onClick={() => game.action('gear')} className="!py-2.5">
            GEAR
          </Btn>
          <Btn onClick={() => game.action('flaps-')} className="!py-2.5">
            FLAP −
          </Btn>
          <Btn onClick={() => game.action('flaps+')} className="!py-2.5">
            FLAP +
          </Btn>
          <Btn on={hud.ap.on} onClick={() => game.action('ap')} className="!py-2.5">
            AP
          </Btn>
          <Btn on={hud.parking} onClick={() => game.action('park')} className="!py-2.5">
            PARK
          </Btn>
          <Hold
            className="!py-2.5 text-[11px]"
            onDown={() => (game.touch.brake = true)}
            onUp={() => (game.touch.brake = false)}
          >
            BRAKE
          </Hold>
        </div>
        <div
          ref={stickRef}
          onPointerDown={(e) => {
            e.stopPropagation();
            stick(e, true);
          }}
          onPointerMove={stick}
          onPointerUp={release}
          onPointerCancel={release}
          className="relative w-36 h-36 rounded-full bg-slate-950/70 border-2 border-white/25 backdrop-blur-md touch-none"
        >
          <div
            className="absolute inset-0 rounded-full"
            style={{ background: 'radial-gradient(circle, rgba(255,255,255,.12), transparent 70%)' }}
          />
          <div
            className="absolute left-1/2 top-1/2 w-14 h-14 -ml-7 -mt-7 rounded-full bg-cyan-300/80 border-2 border-white shadow-lg"
            style={{ transform: `translate(${knob.x * 40}px, ${knob.y * 40}px)` }}
          />
          <div className="absolute inset-x-0 top-1 text-center text-[9px] text-white/60 font-bold">PITCH / ROLL</div>
        </div>
      </div>
    </>
  );
}

/* =========================================================================
   AUTOPILOT CONTROL PANEL (DESKTOP)
   ========================================================================= */
/* =========================================================================
   AUTOPILOT CONTROL PANEL (DESKTOP)
   ========================================================================= */
function ApPanel({ game, hud, onClose }: { game: Game; hud: HudState; onClose?: () => void }) {
  const a = hud.ap;
  const b = (id: string, l: string, on = false) => (
    <Btn on={on} onClick={() => game.action(id)} className="!px-2 !py-1">
      {l}
    </Btn>
  );
  const activeWp = hud.flightPlan && hud.flightPlan[hud.activeWpIdx];
  const phaseLabel = (hud.apPhase || 'off').toUpperCase();

  return (
    <div
      className="w-full rounded-2xl bg-slate-950/90 border border-white/20 backdrop-blur-md p-3 text-white shadow-2xl animate-[fadein_.15s_ease-out]"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-white/10 pb-2 mb-2">
        <span className="text-[10px] font-black tracking-[0.2em] text-cyan-300 uppercase">
          AUTOPILOT {a.on ? `● ${phaseLabel}` : '○ OFF'}
        </span>
        {onClose && (
          <button
            onClick={onClose}
            className="w-5 h-5 rounded-full bg-white/10 hover:bg-white/20 text-xs grid place-items-center text-slate-300 hover:text-white"
            title="Close AP Console"
          >
            ✕
          </button>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex gap-1">
          <Btn
            on={a.on}
            onClick={() => game.action('ap')}
            className="!px-2 !py-1 flex-1"
            title={hud.onGround ? 'Auto Takeoff' : 'Toggle Autopilot'}
          >
            {hud.onGround ? (a.on ? 'T/O ON' : 'AUTO T/O') : a.on ? 'AP ON' : 'AP'}
          </Btn>
          {b('apnav', 'LNAV', a.nav)}
          {b('appr', 'APPR', a.appr)}
          {b('warp', hud.timeScale > 1 ? `×${hud.timeScale}` : 'WARP', hud.timeScale > 1)}
        </div>

        {activeWp && (
          <div className="rounded-lg bg-cyan-950/50 border border-cyan-400/30 px-2.5 py-1.5 text-[10px] flex items-center justify-between">
            <span className="text-cyan-300 font-bold">WPT {hud.activeWpIdx + 1}/{hud.flightPlan.length}</span>
            <span className="font-mono text-white truncate max-w-[125px] font-semibold">{activeWp.name}</span>
          </div>
        )}

        <div className="grid grid-cols-[34px_1fr_auto_auto] items-center gap-1.5 text-[11px]">
          <span className="text-slate-400 font-bold">HDG</span>
          <span className="font-mono font-bold text-fuchsia-300">{String(Math.round(a.hdg)).padStart(3, '0')}°</span>
          {b('hdg-', '−')}
          {b('hdg+', '+')}
        </div>
        <div className="grid grid-cols-[34px_1fr_auto_auto] items-center gap-1.5 text-[11px]">
          <span className="text-slate-400 font-bold">ALT</span>
          <span className="font-mono font-bold text-fuchsia-300">{a.alt.toLocaleString()}</span>
          {b('alt-', '−')}
          {b('alt+', '+')}
        </div>
        <div className="grid grid-cols-[34px_1fr_auto_auto] items-center gap-1.5 text-[11px]">
          <span className="text-slate-400 font-bold">SPD</span>
          <span className="font-mono font-bold text-fuchsia-300">{a.spd} kt</span>
          {b('spd-', '−')}
          {b('spd+', '+')}
        </div>

        {hud.ils && (
          <button
            onClick={() => game.action('rwy')}
            className={`w-full text-left text-[11px] px-2.5 py-1.5 rounded-lg border font-mono transition ${
              hud.ils.valid ? 'border-emerald-400/50 bg-emerald-950/30 text-emerald-300' : 'border-white/10 text-slate-400'
            }`}
            title="Click to cycle approach runway"
          >
            ILS {hud.ils.ident} {hud.ils.valid ? `· ${hud.ils.dist.toFixed(1)} nm` : '· no signal'}
          </button>
        )}

        <div className="grid grid-cols-2 gap-x-2 gap-y-1 rounded-lg bg-white/5 px-2.5 py-1.5 text-[10px]">
          {hud.depRwy && (
            <>
              <span className="text-slate-400">Dep rwy</span>
              <span className="font-mono text-emerald-300 text-right">{hud.depRwy}</span>
            </>
          )}
          <span className="text-slate-400">Landing rwy</span>
          <button onClick={() => game.action('rwy')} className="font-mono text-amber-200 text-right hover:underline">
            {hud.apprRwy || '—'} · {String(Math.round(hud.rwyHdg) % 360).padStart(3, '0')}°
          </button>
          <span className="text-slate-400">Threshold</span>
          <span className="font-mono text-right">{hud.rwyDistNm.toFixed(1)} nm</span>
          <span className="text-slate-400">LOC / GS</span>
          <span className="font-mono text-right">
            {hud.ils ? `${hud.ils.locDots.toFixed(1)} / ${hud.ils.gsDots.toFixed(1)}` : '—'}
          </span>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   MAIN HUD VIEW ASSEMBLY
   ========================================================================= */
export function Hud({
  game,
  hud,
  toasts,
  settings,
  setSettings,
  onMap,
  mapOpen,
  from,
  to,
  phase,
}: {
  game: Game;
  hud: HudState;
  toasts: Toast[];
  settings: Settings;
  setSettings: (p: Partial<Settings>) => void;
  onMap: () => void;
  mapOpen: boolean;
  from: Airport;
  to: Airport;
  phase?: Phase;
}) {
  const [apConsoleOpen, setApConsoleOpen] = useState(false);
  const [atcLogOpen, setAtcLogOpen] = useState(false);

  const coarse = matchMedia('(pointer: coarse)').matches;
  const metric = settings.units === 'metric';
  const hudOn = settings.hud;
  const critical = hud.warn.some((w) => w.level === 'warning');

  // Overlay check: whether a full screen overlay / popup is active
  const isOverlayOpen =
    mapOpen ||
    atcLogOpen ||
    phase === 'paused' ||
    phase === 'crashed' ||
    phase === 'complete' ||
    phase === 'idle';

  // HUD layout mode: standard, minimal, assisted, cockpit
  const hudMode: HudMode = settings.hudMode || 'standard';
  const setHudMode = (m: HudMode) => {
    setSettings({ hudMode: m });
  };

  // Emergency elevation: in minimal or cockpit mode, critical stall/terrain alerts restore PFD visibility
  const showPfd =
    ((hudMode === 'standard' || hudMode === 'assisted') && !(hud.view === 'cockpit' && !coarse)) ||
    (critical && (hudMode === 'minimal' || hudMode === 'cockpit'));
  const showTacticalDock =
    hudMode !== 'cockpit' &&
    hudMode !== 'minimal' &&
    !coarse &&
    !(hud.view === 'cockpit');
  const showNavStack = hudMode !== 'cockpit';

  // Cruise phase dimming for secondary panels per Section 6.2
  const isCruise = hud.flightPhase === 'cruise';
  const dockDimClass = isCruise ? 'opacity-65 hover:opacity-100 transition-opacity duration-300' : 'transition-opacity duration-300';

  const scale = settings.uiScale || 1.0;
  const scaleStyle = scale !== 1.0 ? {
    width: `${100 / scale}%`,
    height: `${100 / scale}%`,
    transform: `scale(${scale})`,
    transformOrigin: 'top left',
  } : undefined;

  return (
    <div
      className="absolute inset-0 pointer-events-none text-white z-10 select-none overflow-hidden font-sans"
      style={scaleStyle}
    >
      {critical && !isOverlayOpen && (
        <div
          className="absolute inset-0 animate-pulse pointer-events-none"
          style={{ boxShadow: 'inset 0 0 140px 20px rgba(239,68,68,0.45)' }}
        />
      )}

      {/* Top MSFS Floating Quick Toolbar */}
      {!isOverlayOpen && (
        <MsfsToolbar
          game={game}
          settings={settings}
          setSettings={setSettings}
          onMap={onMap}
          mapOpen={mapOpen}
          hudMode={hudMode}
          setHudMode={setHudMode}
          onToggleApConsole={() => setApConsoleOpen(!apConsoleOpen)}
          apConsoleOpen={apConsoleOpen}
        />
      )}

      {/* Flight Warnings & GPWS Callout Banner (Top Center) */}
      {!isOverlayOpen && (
        <WarningsBanner
          game={game}
          hud={hud}
          colorblind={settings.colorblind}
          showHint={hudOn && hudMode !== 'minimal'}
        />
      )}

      {/* Right Navigation & Telemetry Stack (Minimap + Waypoint/Route Chip) */}
      {showNavStack && !isOverlayOpen && (
        <div className={`absolute right-2 sm:right-3 ${coarse ? 'top-14' : 'top-2 sm:top-3'} flex flex-col items-end gap-1.5 sm:gap-2 z-20 pointer-events-none ${dockDimClass}`}>
          {/* Live Mini-Map */}
          {!coarse && hudMode !== 'minimal' && !mapOpen && (
            <div className="w-[180px] sm:w-[200px] h-[170px] sm:h-[190px] rounded-2xl overflow-hidden border border-white/25 shadow-2xl pointer-events-auto bg-slate-950/80">
              <MapPanel
                mode="flight"
                game={game}
                from={from}
                to={to}
                styleId={settings.mapStyle}
                onStyle={() => {}}
                compact
                onExpand={onMap}
                className="w-full h-full"
              />
            </div>
          )}

          {/* Waypoint & Route Telemetry Chip */}
          <div className="w-[165px] sm:w-[210px] rounded-2xl bg-slate-950/85 border border-white/20 backdrop-blur-md px-2.5 sm:px-3 py-1.5 sm:py-2 shadow-2xl pointer-events-auto">
            <div className="flex items-center gap-1.5 text-xs font-black">
              <span className="text-emerald-400 font-mono">{hud.fromId}</span>
              <span className="text-slate-500">→</span>
              <span className="text-amber-400 font-mono">{hud.destId}</span>
              <span className="ml-auto text-[9px] text-slate-400 font-semibold truncate max-w-[70px]">
                {hud.aircraft}
              </span>
            </div>

            <div className="mt-1 h-1 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-emerald-400 via-cyan-400 to-amber-400 transition-all duration-300"
                style={{ width: `${Math.round(hud.progress * 100)}%` }}
              />
            </div>

            <div className="mt-1 flex justify-between text-[10px] font-mono text-slate-300 tabular-nums">
              <span>{hud.distNm.toFixed(hud.distNm < 100 ? 1 : 0)} nm</span>
              <span>BRG {String(Math.round(hud.brg)).padStart(3, '0')}°</span>
              <span className="text-emerald-300 font-bold">ETE {fmtT(hud.eteMin)}</span>
            </div>

            {hud.activeWp && (
              <div className="mt-1 flex items-center justify-between text-[9px] font-mono border-t border-white/10 pt-1 text-cyan-300">
                <span className="truncate max-w-[85px] font-bold">WPT {hud.activeWp.name}</span>
                <span>{hud.activeWp.distNm.toFixed(1)} nm</span>
                <span className="text-slate-300">ETA {fmtT(hud.activeWp.etaMin)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Left Side: Coordinated Autopilot Console, ATC Radio Panel & Toasts Stack */}
      {hudMode !== 'cockpit' && hudMode !== 'minimal' && !isOverlayOpen && (
        <div className="absolute left-2 sm:left-3 top-14 sm:top-16 flex flex-col items-start gap-1.5 z-30 pointer-events-none max-w-[190px] sm:max-w-[260px]">
          {/* Autopilot Console (when toggled open on desktop) */}
          {apConsoleOpen && !coarse && hudOn && (
            <div className="pointer-events-auto w-full">
              <ApPanel game={game} hud={hud} onClose={() => setApConsoleOpen(false)} />
            </div>
          )}

          {/* ATC Radio Communications Panel */}
          <div className={`pointer-events-auto w-full ${dockDimClass}`}>
            <AtcPanel
              game={game}
              hud={hud}
              isMobile={coarse}
              onOpenLog={() => setAtcLogOpen(true)}
            />
          </div>

          {/* Toast Notifications */}
          {toasts.length > 0 && (
            <div className="flex flex-col gap-1.5 w-full pointer-events-none">
              {toasts.slice(coarse ? -2 : -4).map((t) => (
                <div
                  key={t.id}
                  className={`px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-xl text-xs font-semibold backdrop-blur-md border shadow-lg animate-[fadein_.25s_ease-out] ${
                    t.level === 'good'
                      ? 'bg-emerald-500/30 border-emerald-400 text-emerald-200'
                      : t.level === 'warn'
                      ? 'bg-amber-500/30 border-amber-400 text-amber-200'
                      : t.level === 'bad'
                      ? 'bg-red-600/40 border-red-400 text-red-200'
                      : 'bg-slate-950/80 border-white/20 text-white'
                  }`}
                >
                  {t.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Minimal Mode Toasts Stack */}
      {hudMode === 'minimal' && !isOverlayOpen && toasts.length > 0 && (
        <div className="absolute left-2 sm:left-3 top-14 sm:top-16 flex flex-col gap-1.5 z-30 pointer-events-none max-w-[200px] sm:max-w-[240px]">
          {toasts.slice(-2).map((t) => (
            <div
              key={t.id}
              className="px-2.5 sm:px-3 py-1 rounded-xl text-xs font-semibold backdrop-blur-md border border-white/20 bg-slate-950/80 text-white shadow-lg animate-[fadein_.25s_ease-out]"
            >
              {t.text}
            </div>
          ))}
        </div>
      )}

      {/* ATC History Log Modal Popup */}
      {atcLogOpen && (
        <AtcHistoryModal
          atcLog={hud.atcLog || []}
          onClose={() => setAtcLogOpen(false)}
        />
      )}

      {/* Minimal Mode HUD */}
      {!isOverlayOpen && hudMode === 'minimal' && (
        <MinimalHUD hud={hud} metric={metric} hideGauges={showPfd} isMobile={coarse} />
      )}

      {/* Bottom Area: Coordinated PFD and Tactical Status Dock */}
      {!isOverlayOpen && (
        <div className="absolute portrait:bottom-60 landscape:bottom-1 sm:bottom-2 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 z-10 pointer-events-none select-none max-w-[98vw]">
          {/* Cabin Announcement Message */}
          {!coarse && hud.cabinMsg && (
            <div className="pointer-events-auto px-3.5 py-1 rounded-xl bg-white text-slate-950 text-xs font-bold shadow-2xl border border-slate-200 animate-[fadein_.2s_ease-out]">
              💬 {hud.cabinMsg}
            </div>
          )}

          {/* Assisted Mode Contextual Guidance */}
          {hudMode === 'assisted' && <AssistedGuideDock hud={hud} />}

          {/* Primary Flight Display (PFD) */}
          {showPfd && (
            <div className="pointer-events-auto origin-bottom transition-transform scale-65 landscape:scale-60 sm:scale-85 md:scale-90 lg:scale-100">
              <PrimaryFlightDisplay hud={hud} metric={metric} assisted={hudMode === 'assisted'} />
            </div>
          )}

          {/* Tactical Flight Systems Dock */}
          {showTacticalDock && (
            <div className={`pointer-events-auto max-w-[98vw] ${dockDimClass}`}>
              <TacticalFlightDock
                game={game}
                hud={hud}
                metric={metric}
                colorblind={settings.colorblind}
                onToggleApConsole={() => setApConsoleOpen(!apConsoleOpen)}
              />
            </div>
          )}
        </div>
      )}

      {/* Restart Hold Indicator */}
      {hud.restartHold > 0 && !isOverlayOpen && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center z-40">
          <div
            className="w-24 h-24 rounded-full grid place-items-center shadow-2xl"
            style={{ background: `conic-gradient(#f43f5e ${hud.restartHold * 360}deg, rgba(255,255,255,.1) 0)` }}
          >
            <div className="w-20 h-20 rounded-full bg-slate-950 grid place-items-center text-xs font-black tracking-widest text-rose-400">
              RESTART
            </div>
          </div>
        </div>
      )}

      {/* Touch Controls for Mobile */}
      {coarse && !isOverlayOpen && <TouchControls game={game} hud={hud} />}
    </div>
  );
}

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
      onClick={onGo}
    >
      <div className="text-center max-w-xl pb-10 sm:pb-0 bg-slate-950/70 border border-white/15 p-6 sm:p-8 rounded-3xl backdrop-blur-md shadow-2xl">
        <div className="text-[10px] tracking-[0.4em] text-cyan-300 font-black uppercase">
          {aircraft} · READY FOR DEPARTURE
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
          ✈ COMMENCE TAKEOFF
        </button>
        <div className="mt-4 text-xs text-slate-400 font-mono">
          Drag mouse to look around · <b>C</b> camera · <b>H</b> HUD modes · <b>P</b> pause · <b>R</b> hold to restart
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

export function FullMap({
  game,
  from,
  to,
  settings,
  setSettings,
  onClose,
}: {
  game: Game;
  from: Airport;
  to: Airport;
  settings: Settings;
  setSettings: (p: Partial<Settings>) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key.toLowerCase() === 'm') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);

  return (
    <div
      className="absolute inset-0 z-40 p-2 sm:p-6 bg-slate-950/80 backdrop-blur-md select-none font-sans"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="relative w-full h-full rounded-3xl overflow-hidden border border-white/20 shadow-2xl">
        <MapPanel
          mode="flight"
          game={game}
          from={from}
          to={to}
          styleId={settings.mapStyle}
          onStyle={(id) => setSettings({ mapStyle: id })}
          className="absolute inset-0"
        />
        <button
          onClick={onClose}
          className="absolute top-3 right-14 sm:right-16 px-3.5 py-1.5 rounded-xl bg-slate-950/90 border border-white/20 text-xs font-bold text-white hover:bg-slate-900 transition shadow-lg z-30"
        >
          ✕ Close (M)
        </button>
        <div className="absolute bottom-8 right-4 px-3.5 py-1.5 rounded-xl bg-slate-950/90 border border-white/10 text-xs text-slate-200 shadow-lg z-30 hidden sm:block">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 mr-2 align-middle animate-pulse" />
          Live Telemetry · Sim Continuing
        </div>
      </div>
    </div>
  );
}
