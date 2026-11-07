import { ClockReadout } from './LiveClock';
import React, { useState, useRef } from 'react';
import type { Game, HudState, FlightPhase, WorldScreenMarker, CockpitTooltip } from '../sim/game';
import { Settings } from '../sim/storage';
import { MapPanel } from './MapPanel';
import { Airport } from '../data/airports';
import { clamp } from '../sim/geo';
import { FlightIcon, FlightIconName } from './FlightIcon';

const fmtT = (min: number) =>
  isFinite(min) && min < 6000
    ? `${Math.floor(min / 60)}:${String(Math.floor(min % 60)).padStart(2, '0')}`
    : '--:--';

/* =========================================================================
   GENERIC DRAGGABLE ACRYLIC FLOATING WINDOW
   ========================================================================= */
export function MsfsFloatingWindow({
  title,
  icon,
  onClose,
  initialPos,
  width = 380,
  children,
  headerExtras,
}: {
  title: string;
  icon: FlightIconName;
  onClose: () => void;
  initialPos: { x: number; y: number };
  width?: number;
  children: React.ReactNode;
  headerExtras?: React.ReactNode;
}) {
  const [pos, setPos] = useState(initialPos);
  const [minimized, setMinimized] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; posX: number; posY: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      posX: pos.x,
      posY: pos.y,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    const maxX = Math.max(10, window.innerWidth - width - 20);
    const maxY = Math.max(10, window.innerHeight - 80);
    setPos({
      x: clamp(dragRef.current.posX + dx, 10, maxX),
      y: clamp(dragRef.current.posY + dy, 40, maxY),
    });
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  return (
    <div
      style={{
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        width: `${width}px`,
      }}
      className="fixed z-40 select-none pointer-events-auto rounded-2xl border border-white/25 bg-slate-950/85 backdrop-blur-xl shadow-[0_20px_50px_rgba(0,0,0,0.6)] text-white overflow-hidden flex flex-col font-sans animate-[fadein_.15s_ease-out]"
    >
      {/* Window Titlebar */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="flex items-center justify-between px-3.5 py-2.5 bg-white/10 border-b border-white/15 cursor-grab active:cursor-grabbing hover:bg-white/15 transition-colors"
      >
        <div className="flex items-center gap-2">
          <FlightIcon name={icon} size={15} className="text-cyan-300" />
          <span className="text-xs font-black tracking-widest uppercase text-cyan-300 drop-shadow">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
          {headerExtras}
          <button
            onClick={() => setMinimized(!minimized)}
            className="w-6 h-6 rounded-lg bg-white/10 hover:bg-white/20 grid place-items-center text-xs font-bold text-slate-300 hover:text-white transition"
            title={minimized ? 'Expand' : 'Minimize'}
          >
            <FlightIcon name={minimized ? 'expand' : 'minus'} size={12} />
          </button>
          <button
            onClick={onClose}
            className="w-6 h-6 rounded-lg bg-rose-500/20 hover:bg-rose-500/40 border border-rose-400/30 grid place-items-center text-xs font-bold text-rose-300 hover:text-white transition"
            title="Close Window"
          >
            <FlightIcon name="close" size={12} />
          </button>
        </div>
      </div>

      {/* Window Body */}
      {!minimized && (
        <div className="p-3.5 max-h-[72vh] overflow-y-auto overflow-x-hidden text-xs">
          {children}
        </div>
      )}
    </div>
  );
}

/* =========================================================================
   1. COCKPIT INTERACTIVE TOOLTIP OVERLAY
   ========================================================================= */
export function CockpitTooltipOverlay({ tooltip, game }: { tooltip: CockpitTooltip | null; game?: Game }) {
  // Minimalist dark-glass badge that sticks next to the cursor:  NAME · STATE · function.
  // It is driven straight from the pointer + the game's hover state (no React render per mouse move) so it vanishes the moment the cursor leaves a control.
  const el = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<CockpitTooltip | null>(tooltip);
  React.useEffect(() => {
    let raf = 0, key = '', px = -999, py = -999;
    const place = () => {
      const n = el.current; if (!n) return;
      const w = n.offsetWidth, h = n.offsetHeight, x = px + 16 + w > window.innerWidth - 8 ? px - 12 - w : px + 16, y = py + 22 + h > window.innerHeight - 8 ? py - 14 - h : py + 22;
      n.style.transform = `translate3d(${Math.max(6, x)}px, ${Math.max(6, y)}px, 0)`;
    };
    const move = (e: PointerEvent) => { px = e.clientX; py = e.clientY; place(); };
    const tick = () => {
      const t = game ? game.cockpitTooltip : tooltip, k = t ? `${t.id}|${t.value}` : '';
      if (k !== key) { key = k; setLive(t ? { ...t } : null); }
      raf = requestAnimationFrame(tick);
    };
    window.addEventListener('pointermove', move, { passive: true }); raf = requestAnimationFrame(tick);
    return () => { window.removeEventListener('pointermove', move); cancelAnimationFrame(raf); };
  }, [game, tooltip]);
  React.useLayoutEffect(() => { const n = el.current; if (n && live) { const x = (live.x ?? 0), y = (live.y ?? 0); if (!n.style.transform) n.style.transform = `translate3d(${x + 16}px, ${y + 22}px, 0)`; } }, [live]);
  if (!live) return null;
  return (
    <div ref={el} className="cp-tip" role="status" aria-live="off">
      <b>{live.label}</b>
      {live.value && <><i>·</i><span className="cp-tip-state">{live.value}</span></>}
      {live.description && <><i>·</i><span className="cp-tip-fn">{live.description}</span></>}
    </div>
  );
}

/** Camera focus hot-bar: one click (or keypad 0-9) flies the camera to a panel – nothing on the panel is operated. */
export function CockpitFocusBar({ game, items }: { game: Game; items: { id: string; label: string; key: string }[] }) {
  return (
    <div className="cp-focusbar" data-flight-ui role="toolbar" aria-label="Cockpit camera focus">
      <span className="cp-focusbar-title">FOCUS</span>
      {items.map((it) => (
        <button key={it.id} type="button" title={`Fly camera to ${it.label} (keypad ${it.key})`} onClick={() => { game.setCockpitSubview(it.id as never); requestAnimationFrame(() => game.canvas.focus({ preventScroll: true })); }}>
          {it.label}<kbd>{it.key}</kbd>
        </button>
      ))}
    </div>
  );
}

/* =========================================================================
   2. FREELOOK CENTER RETICLE (WHITE DOT)
   ========================================================================= */
export function FreelookReticle({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-30">
      <div className="w-1.5 h-1.5 rounded-full bg-white shadow-[0_0_6px_rgba(0,0,0,0.9)] ring-1 ring-black/60" />
    </div>
  );
}

/* =========================================================================
   3. 3D SPATIAL WORLD MARKERS (WAYPOINTS & RUNWAY PINS)
   ========================================================================= */
export function WorldMarkersOverlay({ markers }: { markers: WorldScreenMarker[] }) {
  if (!markers || markers.length === 0) return null;

  return (
    <div className="fixed inset-0 pointer-events-none z-20 overflow-hidden select-none">
      {markers.map((m) => {
        if (m.inView) {
          return (
            <div
              key={m.id}
              style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }}
              className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center group transition-all duration-75"
            >
              {/* Floating Diamond Target */}
              <div
                className={`w-3.5 h-3.5 rotate-45 border-2 shadow-lg grid place-items-center ${
                  m.type === 'runway'
                    ? 'border-emerald-400 bg-emerald-950/80'
                    : 'border-cyan-400 bg-cyan-950/80'
                }`}
              >
                <div
                  className={`w-1 h-1 rounded-full ${
                    m.type === 'runway' ? 'bg-emerald-300' : 'bg-cyan-300'
                  }`}
                />
              </div>

              {/* Marker Badge Tag */}
              <div className="mt-1 px-2 py-0.5 rounded-lg border border-white/20 bg-slate-950/80 backdrop-blur-md shadow-xl flex items-center gap-1.5 whitespace-nowrap">
                <span
                  className={`text-[10px] font-black uppercase font-mono ${
                    m.type === 'runway' ? 'text-emerald-300' : 'text-cyan-300'
                  }`}
                >
                  {m.label}
                </span>
                <span className="text-[9px] text-slate-300 font-mono">
                  {m.distNm.toFixed(1)} NM
                </span>
                {m.altFt > 0 && (
                  <span className="text-[9px] text-amber-300 font-mono font-bold">
                    {m.altFt.toLocaleString()} FT
                  </span>
                )}
              </div>
            </div>
          );
        }

        // Off-screen indicator (clamped to perimeter with directional arrow)
        return (
          <div
            key={m.id}
            style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }}
            className="absolute -translate-x-1/2 -translate-y-1/2 flex items-center gap-1 px-2 py-0.5 rounded-lg border border-cyan-400/50 bg-slate-950/85 backdrop-blur-md text-cyan-300 text-[9px] font-black font-mono shadow-xl"
          >
            <span
              style={{ transform: `rotate(${m.angleDeg}deg)` }}
              className="inline-flex transition-transform"
            >
              <FlightIcon name="arrowRight" size={11} />
            </span>
            <span>{m.label}</span>
            <span className="text-slate-300 font-normal">{m.distNm.toFixed(0)} NM</span>
          </div>
        );
      })}
    </div>
  );
}

/* =========================================================================
   4. ATC RADIO COMMUNICATIONS WINDOW
   ========================================================================= */
export function AtcWindow({
  game,
  hud,
  onClose,
}: {
  game: Game;
  hud: HudState;
  onClose: () => void;
}) {
  const atcLog = hud.atcLog || [];
  const activeFreq = hud.flightPhase === 'taxi' || hud.flightPhase === 'rollout' ? '121.900' : '118.700';
  const roleName = hud.flightPhase === 'taxi' || hud.flightPhase === 'rollout' ? 'GROUND' : 'TOWER';

  return (
    <MsfsFloatingWindow
      title="ATC Communications"
      icon="radio"
      onClose={onClose}
      initialPos={{ x: 20, y: 70 }}
      width={390}
    >
      {/* Frequency Header */}
      <div className="flex items-center justify-between p-2.5 rounded-xl bg-white/5 border border-white/10 mb-3">
        <div>
          <span className="text-[9px] text-slate-400 uppercase tracking-widest block font-bold">
            Active Frequency · {hud.fromId} {roleName}
          </span>
          <span className="font-mono text-base font-black text-cyan-300 tracking-wider">
            {activeFreq} MHz
          </span>
        </div>
        <div className="px-2 py-1 rounded bg-emerald-500/20 border border-emerald-400/30 text-emerald-300 font-mono text-[10px] font-bold">
          LIVE CONNECTED
        </div>
      </div>

      {/* Communications Transcript */}
      <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1 mb-3">
        {atcLog.length === 0 ? (
          <div className="text-center py-6 text-slate-400 text-xs italic">
            Listening on frequency {activeFreq}...
          </div>
        ) : (
          atcLog.map((msg) => (
            <div
              key={msg.id}
              className={`p-2 rounded-xl border text-xs ${
                msg.sender === 'PILOT'
                  ? 'bg-cyan-500/15 border-cyan-400/30 text-cyan-100 ml-4'
                  : 'bg-white/5 border-white/10 text-slate-200 mr-4'
              }`}
            >
              <div className="flex items-center justify-between text-[9px] font-bold uppercase tracking-wider mb-1 opacity-70">
                <span className={msg.sender === 'PILOT' ? 'text-cyan-300' : 'text-amber-300'}>
                  {msg.sender}
                </span>
                <span>{fmtT(msg.time / 60)}</span>
              </div>
              <div>{msg.text}</div>
            </div>
          ))
        )}
      </div>

      {/* Pilot Quick Responses */}
      <div className="border-t border-white/10 pt-2.5 space-y-1.5">
        <span className="text-[9px] text-slate-400 uppercase tracking-wider font-bold block">
          Pilot Response Options (Key 1–4)
        </span>
        <button
          onClick={() => game.respondAtc(1)}
          className="w-full text-left p-2 rounded-xl bg-white/5 hover:bg-white/15 border border-white/10 text-xs flex items-center justify-between transition group"
        >
          <span className="font-medium text-slate-200 group-hover:text-white">
            1. Acknowledge / Wilco Roger
          </span>
          <kbd className="px-1.5 py-0.5 rounded bg-black/40 text-[9px] font-mono text-cyan-300">1</kbd>
        </button>
        <button
          onClick={() => game.respondAtc(2)}
          className="w-full text-left p-2 rounded-xl bg-white/5 hover:bg-white/15 border border-white/10 text-xs flex items-center justify-between transition group"
        >
          <span className="font-medium text-slate-200 group-hover:text-white">
            2. Request Departure Clearance
          </span>
          <kbd className="px-1.5 py-0.5 rounded bg-black/40 text-[9px] font-mono text-cyan-300">2</kbd>
        </button>
        <button
          onClick={() => game.respondAtc(3)}
          className="w-full text-left p-2 rounded-xl bg-white/5 hover:bg-white/15 border border-white/10 text-xs flex items-center justify-between transition group"
        >
          <span className="font-medium text-slate-200 group-hover:text-white">
            3. Request Inbound / Approach Clearance
          </span>
          <kbd className="px-1.5 py-0.5 rounded bg-black/40 text-[9px] font-mono text-cyan-300">3</kbd>
        </button>
        <button
          onClick={() => game.respondAtc(4)}
          className="w-full text-left p-2 rounded-xl bg-white/5 hover:bg-white/15 border border-white/10 text-xs flex items-center justify-between transition group"
        >
          <span className="font-medium text-slate-200 group-hover:text-white">
            4. Say Again Transmissions
          </span>
          <kbd className="px-1.5 py-0.5 rounded bg-black/40 text-[9px] font-mono text-cyan-300">4</kbd>
        </button>
      </div>
    </MsfsFloatingWindow>
  );
}

/* =========================================================================
   5. CAMERA & SHOWCASE WINDOW
   ========================================================================= */
export function CameraWindow({
  game,
  hud,
  onClose,
}: {
  game: Game;
  hud: HudState;
  onClose: () => void;
}) {
  const [fov, setFov] = useState(hud.fov || 65);

  const handleFov = (newFov: number) => {
    setFov(newFov);
    game.setFov(newFov);
  };

  return (
    <MsfsFloatingWindow
      title="Camera & Showcase"
      icon="camera"
      onClose={onClose}
      initialPos={{ x: 60, y: 70 }}
      width={360}
    >
      <div className="space-y-3.5">
        {/* Cockpit Subviews */}
        <div>
          <span className="text-[9px] text-slate-400 uppercase tracking-widest font-bold block mb-1.5">
            Cockpit Perspective
          </span>
          <div className="grid grid-cols-2 gap-1.5">
            {([
              ['pilot', 'Captain Eye', 'Forward view, left seat'], ['copilot', 'First Officer', 'Right seat view'], ['instruments', 'Main Panel', 'PFD · ND · ECAM'],
              ['pfd', 'PFD', 'Primary flight display'], ['nd', 'ND', 'Navigation display'], ['ecam', 'ECAM', 'E/WD + system display'],
              ['fcu', 'FCU / EFIS', 'Autoflight & glareshield'], ['overhead', 'Overhead', 'Systems panel'], ['pedestal', 'Pedestal', 'Thrust · flaps · MCDU · ENG'], ['mcdu', 'MCDU', 'FMGC keypad'],
            ] as const).map(([id, title, sub]) => (
              <button key={id} onClick={() => game.setCockpitSubview(id)} className="p-2 rounded-xl bg-white/5 hover:bg-white/15 border border-white/10 text-left font-bold text-xs transition">
                {title}
                <span className="block text-[9px] text-slate-400 font-normal">{sub}</span>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[9px] text-slate-400">Wheel zooms smoothly (up to 8×) · keypad 0–9 or the FOCUS bar flies to a panel · Alt-click frames a control without operating it · wheel over a knob turns it (Ctrl-wheel always zooms).</p>
        </div>

        {/* External & Cinematic Showcase */}
        <div>
          <span className="text-[9px] text-slate-400 uppercase tracking-widest font-bold block mb-1.5">
            External &amp; Cinematic Views
          </span>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => game.setView('chase')}
              className={`p-2 rounded-xl border text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                hud.view === 'chase' ? 'bg-cyan-500/25 border-cyan-400 text-cyan-200' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/15'
              }`}
            >
              <FlightIcon name="plane" size={12} />
              <span>Chase</span>
            </button>
            <button
              onClick={() => game.setView('spotter')}
              className={`p-2 rounded-xl border text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                hud.view === 'spotter' ? 'bg-cyan-500/25 border-cyan-400 text-cyan-200' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/15'
              }`}
            >
              <FlightIcon name="camera" size={12} />
              <span>Spotter</span>
            </button>
          </div>
        </div>

        {/* Field of View (FOV) Zoom Slider */}
        <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
          <div className="flex justify-between text-xs font-bold mb-1">
            <span className="text-slate-300">Field of View (FOV)</span>
            <span className="text-cyan-300 font-mono">{fov}°</span>
          </div>
          <input
            type="range"
            min="40"
            max="85"
            step="1"
            value={fov}
            onChange={(e) => handleFov(Number(e.target.value))}
            className="w-full accent-cyan-400 cursor-pointer"
          />
          <div className="flex justify-between text-[9px] text-slate-400 mt-1">
            <span>Telephoto (40°)</span>
            <span>Standard (65°)</span>
            <span>Wide (85°)</span>
          </div>
        </div>

        {/* Freelook Tip */}
        <div className="text-[10px] text-slate-400 bg-white/5 p-2 rounded-lg border border-white/10 flex items-center gap-2">
          <FlightIcon name="info" size={13} className="text-cyan-300 shrink-0" />
          <span>Hold right-click or drag to rotate view freely. Center dot aids orientation.</span>
        </div>
      </div>
    </MsfsFloatingWindow>
  );
}

/* =========================================================================
   6. CHECKLIST & FLIGHT OBJECTIVES WINDOW
   ========================================================================= */
export function ChecklistWindow({
  game,
  hud,
  onClose,
}: {
  game: Game;
  hud: HudState;
  onClose: () => void;
}) {
  const currentPhase = hud.flightPhase || 'taxi';
  const [selectedPhase, setSelectedPhase] = useState<FlightPhase>(currentPhase);
  const checklist = hud.activeChecklist?.items || [];
  const phaseItems = checklist.filter((x) => x.phase === selectedPhase);
  const phaseDoneCount = phaseItems.filter((x) => x.done).length;

  const phases: { id: FlightPhase; label: string }[] = [
    { id: 'taxi', label: 'Taxi' },
    { id: 'takeoff', label: 'Takeoff' },
    { id: 'climb', label: 'Climb' },
    { id: 'cruise', label: 'Cruise' },
    { id: 'descent', label: 'Descent' },
    { id: 'final', label: 'Final' },
    { id: 'rollout', label: 'Rollout' },
  ];

  return (
    <MsfsFloatingWindow
      title="Checklist & Objectives"
      icon="list"
      onClose={onClose}
      initialPos={{ x: 100, y: 70 }}
      width={400}
    >
      {/* Flight Phase Selector Pills */}
      <div className="flex items-center gap-1 overflow-x-auto pb-2 border-b border-white/10 mb-3 no-scrollbar">
        {phases.map((p) => {
          const isCurrent = p.id === currentPhase;
          const isSelected = p.id === selectedPhase;
          return (
            <button
              key={p.id}
              onClick={() => setSelectedPhase(p.id)}
              className={`px-2.5 py-1 rounded-xl text-xs font-bold whitespace-nowrap transition flex items-center gap-1 ${
                isSelected
                  ? 'bg-cyan-400 text-slate-950 font-black'
                  : 'bg-white/5 text-slate-300 hover:bg-white/15'
              }`}
            >
              {isCurrent && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Phase Status Banner */}
      <div className="flex items-center justify-between p-2.5 rounded-xl bg-white/5 border border-white/10 mb-3">
        <div>
          <span className="text-[9px] text-slate-400 uppercase tracking-widest block font-bold">
            Phase Progress
          </span>
          <span className="text-xs font-bold text-white">
            {selectedPhase.toUpperCase()} PROCEDURES ({phaseDoneCount}/{phaseItems.length})
          </span>
        </div>
        <button
          onClick={() => game.autoCompletePhaseChecklist(selectedPhase)}
          className="px-2.5 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/40 border border-emerald-400/40 text-emerald-300 text-xs font-bold transition flex items-center gap-1"
        >
          <FlightIcon name="check" size={12} />
          <span>Complete All</span>
        </button>
      </div>

      {/* Checklist Items */}
      <div className="space-y-1.5 max-h-[260px] overflow-y-auto pr-1">
        {phaseItems.length === 0 ? (
          <div className="text-center py-6 text-slate-400 italic">No checklist items for this phase.</div>
        ) : (
          phaseItems.map((it) => (
            <div
              key={it.id}
              onClick={() => game.toggleChecklistItem(it.id)}
              className={`p-2.5 rounded-xl border flex items-center justify-between cursor-pointer transition ${
                it.done
                  ? 'bg-emerald-950/30 border-emerald-500/40 text-slate-200'
                  : 'bg-white/5 border-white/10 hover:bg-white/15 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <div
                  className={`w-5 h-5 rounded-lg border grid place-items-center text-xs font-black transition ${
                    it.done
                      ? 'bg-emerald-400 border-emerald-300 text-slate-950'
                      : 'border-white/30 text-transparent'
                  }`}
                >
                  <FlightIcon name="check" size={12} />
                </div>
                <div>
                  <div className={`text-xs font-bold ${it.done ? 'line-through text-slate-400' : 'text-white'}`}>
                    {it.label}
                  </div>
                  <div className="text-[10px] text-slate-400">{it.detail}</div>
                </div>
              </div>
              <span className={`text-[10px] font-mono font-bold ${it.done ? 'text-emerald-300' : 'text-cyan-300'}`}>
                {it.done ? 'DONE' : '+25 PTS'}
              </span>
            </div>
          ))
        )}
      </div>
    </MsfsFloatingWindow>
  );
}

/* =========================================================================
   7. WEATHER & TIME OF DAY WINDOW
   ========================================================================= */
export function WeatherWindow({
  game: _game,
  hud,
  onClose,
}: {
  game: Game;
  hud: HudState;
  onClose: () => void;
}) {
  const metarText = hud.wxMetar || hud.wxText;

  return (
    <MsfsFloatingWindow
      title="Live Weather & Time of Day"
      icon="cloud"
      onClose={onClose}
      initialPos={{ x: 140, y: 70 }}
      width={380}
    >
      <div className="space-y-3.5">
        {/* Real-world time (locked): the sim clock is the system UTC clock */}
        <div>
          <span className="text-[9px] text-slate-400 uppercase tracking-widest font-bold block mb-1.5">
            Real-World Time · Synchronised
          </span>
          <div className="p-2.5 rounded-xl bg-white/5 border border-white/10 flex items-center gap-2.5">
            <FlightIcon name="sun" size={16} className="text-amber-300" />
            <ClockReadout lat={Number.isFinite(hud.lat) ? hud.lat : 0} lon={Number.isFinite(hud.lon) ? hud.lon : 0} />
          </div>
          <p className="text-[9px] text-slate-500 mt-1">Sun position, sky and lighting follow the real UTC time at the aircraft's location.</p>
        </div>

        {/* LIVE weather: real METAR + model data, no presets */}
        <div>
          <span className="text-[9px] text-slate-400 uppercase tracking-widest font-bold block mb-1.5">
            Real-world conditions · {hud.wxSource}
          </span>
          <div className="grid grid-cols-2 gap-1.5 text-xs">
            <div className="p-2 rounded-xl bg-white/5 border border-white/10"><div className="text-[9px] text-slate-400 uppercase">Sky / weather</div><div className="font-bold text-sky-200">{hud.wxCondition || '—'}</div></div>
            <div className="p-2 rounded-xl bg-white/5 border border-white/10"><div className="text-[9px] text-slate-400 uppercase">Precipitation</div><div className="font-bold text-sky-200">{hud.wxRain > 0.02 ? `${Math.round(hud.wxRain * 100)}% intensity` : 'None'}</div></div>
            <div className="p-2 rounded-xl bg-white/5 border border-white/10"><div className="text-[9px] text-slate-400 uppercase">Wind at aircraft</div><div className="font-bold text-sky-200">{String(Math.round(hud.wind.dir)).padStart(3, '0')}° / {Math.round(hud.wind.kt)} kt</div></div>
            <div className="p-2 rounded-xl bg-white/5 border border-white/10"><div className="text-[9px] text-slate-400 uppercase">Visibility</div><div className="font-bold text-sky-200">{hud.wxVisKm >= 10 ? '10 km+' : `${hud.wxVisKm.toFixed(1)} km`}</div></div>
          </div>
          <p className="text-[9px] text-slate-500 mt-1">Wind, rain, cloud, visibility, temperature and pressure are fetched for your position and refreshed every 10 minutes (and when you fly 60 km). They drive the physics: density altitude, headwind, gusts and runway friction.</p>
        </div>

        {/* Decoded METAR Report Box */}
        <div className="p-2.5 rounded-xl bg-slate-900 border border-white/15 font-mono">
          <div className="text-[9px] text-slate-400 uppercase tracking-wider mb-1 flex items-center justify-between">
            <span>{hud.wxMetar ? 'LIVE METAR' : 'LIVE MODEL WEATHER'}</span>
            <span className="text-emerald-400">{hud.wxMetar ? `${hud.wxObsAge} min old` : 'MODEL'}</span>
          </div>
          <div className="text-xs text-amber-300 font-bold leading-relaxed break-words">{metarText}</div>
          <div className="mt-2 text-[10px] text-slate-400 border-t border-white/10 pt-1.5 flex justify-between">
            <span>QNH: {hud.qnhInHg} inHg / {Math.round(hud.wxQnhHpa)} hPa</span>
            <span>OAT: {hud.oatC}°C</span>
            <span>Headwind: {hud.headwindKt} kt</span>
          </div>
        </div>
      </div>
    </MsfsFloatingWindow>
  );
}

/* =========================================================================
   8. EFB (ELECTRONIC FLIGHT BAG) & VFR NAVMAP TABLET WINDOW
   ========================================================================= */
export function EfbWindow({
  game,
  hud,
  from,
  to,
  settings,
  onClose,
}: {
  game: Game;
  hud: HudState;
  from: Airport;
  to: Airport;
  settings: Settings;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'map' | 'profile' | 'navlog' | 'freq'>('map');
  const flightPlan = hud.flightPlan || [];

  return (
    <MsfsFloatingWindow
      title="Electronic Flight Bag (EFB)"
      icon="map"
      onClose={onClose}
      initialPos={{ x: 180, y: 70 }}
      width={460}
      headerExtras={
        <div className="flex items-center gap-1 mr-2 text-[9px] font-mono text-emerald-300">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
          <span>GPS 3D</span>
          <span>· 98% BAT</span>
        </div>
      }
    >
      {/* EFB Navigation Tabs */}
      <div className="flex items-center gap-1 pb-2 border-b border-white/10 mb-3">
        <button
          onClick={() => setTab('map')}
          className={`flex-1 py-1.5 rounded-xl text-xs font-bold transition ${
            tab === 'map' ? 'bg-cyan-400 text-slate-950 font-black' : 'bg-white/5 text-slate-300 hover:bg-white/15'
          }`}
        >
          Moving Map
        </button>
        <button
          onClick={() => setTab('profile')}
          className={`flex-1 py-1.5 rounded-xl text-xs font-bold transition ${
            tab === 'profile' ? 'bg-cyan-400 text-slate-950 font-black' : 'bg-white/5 text-slate-300 hover:bg-white/15'
          }`}
        >
          Vertical Profile
        </button>
        <button
          onClick={() => setTab('navlog')}
          className={`flex-1 py-1.5 rounded-xl text-xs font-bold transition ${
            tab === 'navlog' ? 'bg-cyan-400 text-slate-950 font-black' : 'bg-white/5 text-slate-300 hover:bg-white/15'
          }`}
        >
          Nav Log
        </button>
        <button
          onClick={() => setTab('freq')}
          className={`flex-1 py-1.5 rounded-xl text-xs font-bold transition ${
            tab === 'freq' ? 'bg-cyan-400 text-slate-950 font-black' : 'bg-white/5 text-slate-300 hover:bg-white/15'
          }`}
        >
          Frequencies
        </button>
      </div>

      {/* Tab 1: Moving Map */}
      {tab === 'map' && (
        <div className="h-[280px] rounded-2xl overflow-hidden border border-white/15 bg-slate-950">
          <MapPanel
            mode="flight"
            game={game}
            from={from}
            to={to}
            styleId={settings.mapStyle}
            onStyle={() => {}}
            className="w-full h-full"
          />
        </div>
      )}

      {/* Tab 2: Vertical Flight Elevation Profile */}
      {tab === 'profile' && (
        <div className="space-y-3">
          <div className="p-3 rounded-2xl bg-slate-950/90 border border-white/15">
            <span className="text-[9px] text-slate-400 uppercase tracking-widest font-bold block mb-2">
              Route Altitude & Descent Glidepath Cross-Section
            </span>
            <svg viewBox="0 0 400 150" className="w-full h-36 overflow-visible font-mono">
              {/* Ground Terrain Fill */}
              <path
                d="M 20 135 L 70 132 L 140 120 L 210 115 L 280 122 L 340 133 L 380 135 L 380 145 L 20 145 Z"
                fill="rgba(34, 197, 94, 0.2)"
                stroke="#22c55e"
                strokeWidth="1.5"
              />
              {/* Cruise Flight Plan Path */}
              <path
                d="M 30 135 L 90 40 L 290 40 L 370 135"
                fill="none"
                stroke="#38bdf8"
                strokeWidth="2"
                strokeDasharray="4 3"
              />
              {/* Current Aircraft Altitude Position */}
              {(() => {
                const px = clamp(30 + hud.progress * 340, 30, 370);
                const py = clamp(135 - (hud.altFt / 25000) * 95, 30, 135);
                return (
                  <g transform={`translate(${px}, ${py})`}>
                    <circle r="5" fill="#f59e0b" className="animate-pulse" />
                    <text x="8" y="3" fill="#f59e0b" fontSize="9" fontWeight="bold">
                      {Math.round(hud.altFt).toLocaleString()} ft
                    </text>
                  </g>
                );
              })()}
              {/* Waypoint Markers */}
              <text x="30" y="145" fill="#94a3b8" fontSize="8" textAnchor="middle">DEP</text>
              <text x="90" y="32" fill="#38bdf8" fontSize="8" textAnchor="middle">TOC</text>
              <text x="290" y="32" fill="#38bdf8" fontSize="8" textAnchor="middle">TOD</text>
              <text x="370" y="145" fill="#f59e0b" fontSize="8" textAnchor="middle">{hud.destId}</text>
            </svg>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-xs font-mono">
            <div className="p-2 rounded-xl bg-white/5 border border-white/10">
              <span className="text-[9px] text-slate-400 block font-sans">CURRENT ALT</span>
              <span className="font-bold text-white">{Math.round(hud.altFt).toLocaleString()} ft</span>
            </div>
            <div className="p-2 rounded-xl bg-white/5 border border-white/10">
              <span className="text-[9px] text-slate-400 block font-sans">RADAR AGL</span>
              <span className="font-bold text-cyan-300">{Math.round(hud.aglFt).toLocaleString()} ft</span>
            </div>
            <div className="p-2 rounded-xl bg-white/5 border border-white/10">
              <span className="text-[9px] text-slate-400 block font-sans">V/S RATE</span>
              <span className={`font-bold ${hud.vsFpm < -100 ? 'text-amber-300' : 'text-emerald-300'}`}>
                {hud.vsFpm > 0 ? '+' : ''}{Math.round(hud.vsFpm)} fpm
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: Waypoints Navigation Log */}
      {tab === 'navlog' && (
        <div className="max-h-[260px] overflow-y-auto space-y-1.5 pr-1 font-mono text-xs">
          {flightPlan.length === 0 ? (
            <div className="text-center py-6 text-slate-400 italic font-sans">No route active.</div>
          ) : (
            flightPlan.map((wp, idx) => {
              const isActive = idx === hud.activeWpIdx;
              return (
                <div
                  key={wp.id}
                  className={`p-2 rounded-xl border flex items-center justify-between ${
                    isActive
                      ? 'bg-cyan-500/20 border-cyan-400 text-white shadow-lg'
                      : 'bg-white/5 border-white/10 text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-5 text-[10px] text-slate-400 font-bold">{idx + 1}</span>
                    <div>
                      <div className="font-bold text-cyan-300">{wp.name}</div>
                      <div className="text-[9px] text-slate-400 uppercase">{wp.type}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold">{Math.round(wp.altM / 0.3048).toLocaleString()} ft</div>
                    <div className="text-[10px] text-slate-400">{wp.speedKt} kt</div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Tab 4: Frequencies */}
      {tab === 'freq' && (
        <div className="space-y-2 text-xs">
          <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
            <span className="text-[9px] text-slate-400 uppercase tracking-widest block font-bold mb-1">
              {from.name} ({from.icao})
            </span>
            <div className="grid grid-cols-2 gap-2 font-mono">
              <div>Tower: <span className="text-cyan-300 font-bold">118.700</span></div>
              <div>Ground: <span className="text-cyan-300 font-bold">121.900</span></div>
              <div>ATIS: <span className="text-cyan-300 font-bold">128.500</span></div>
              <div>Elev: <span className="text-white font-bold">{from.elev} ft</span></div>
            </div>
          </div>
          <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
            <span className="text-[9px] text-slate-400 uppercase tracking-widest block font-bold mb-1">
              Destination {to.name} ({to.icao})
            </span>
            <div className="grid grid-cols-2 gap-2 font-mono">
              <div>Tower: <span className="text-amber-300 font-bold">119.100</span></div>
              <div>Approach: <span className="text-amber-300 font-bold">124.200</span></div>
              <div>ILS Runway: <span className="text-amber-300 font-bold">{hud.apprRwy || '27'}</span></div>
              <div>Elev: <span className="text-white font-bold">{to.elev} ft</span></div>
            </div>
          </div>
        </div>
      )}
    </MsfsFloatingWindow>
  );
}

/* =========================================================================
   9. AI COPILOT & ASSISTANCES WINDOW
   ========================================================================= */
export function CopilotWindow({
  game,
  hud,
  onClose,
}: {
  game: Game;
  hud: HudState;
  onClose: () => void;
}) {
  return (
    <MsfsFloatingWindow
      title="AI Copilot & Assistances"
      icon="autopilot"
      onClose={onClose}
      initialPos={{ x: 220, y: 70 }}
      width={360}
    >
      <div className="space-y-3">
        {/* 3D Visual Aids */}
        <div>
          <span className="text-[9px] text-slate-400 uppercase tracking-widest font-bold block mb-1.5">
            3D Spatial Navigation Assists
          </span>
          <div className="space-y-1.5">
            <button
              onClick={() => game.setAssistGates(!hud.show3dGates)}
              className={`w-full p-2.5 rounded-xl border text-xs font-bold flex items-center justify-between transition ${
                hud.show3dGates ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/15'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <FlightIcon name="target" size={13} />
                <span>3D Approach Corridor Gates</span>
              </span>
              <span className="font-mono text-[10px]">{hud.show3dGates ? 'ENABLED' : 'OFF'}</span>
            </button>
            <button
              onClick={() => game.setAssistTaxi(!hud.showTaxiRibbon)}
              className={`w-full p-2.5 rounded-xl border text-xs font-bold flex items-center justify-between transition ${
                hud.showTaxiRibbon ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/15'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <FlightIcon name="route" size={13} />
                <span>3D Taxi Ribbon Chevrons</span>
              </span>
              <span className="font-mono text-[10px]">{hud.showTaxiRibbon ? 'ENABLED' : 'OFF'}</span>
            </button>
          </div>
        </div>

        {/* Piloting Assistance */}
        <div>
          <span className="text-[9px] text-slate-400 uppercase tracking-widest font-bold block mb-1.5">
            Flight Dynamics Assistance
          </span>
          <div className="p-2.5 rounded-xl bg-white/5 border border-white/10 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-slate-300">Auto-Rudder &amp; Coordination</span>
              <span className="text-emerald-400 font-mono font-bold">ACTIVE</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-300">Assisted Yoke Stability</span>
              <span className="text-emerald-400 font-mono font-bold">ACTIVE</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-300">Auto-Takeoff / Land Guidance</span>
              <span className="text-cyan-400 font-mono font-bold">READY [Y]</span>
            </div>
          </div>
        </div>

        {/* Autopilot Quick Links */}
        <div className="border-t border-white/10 pt-2.5 grid grid-cols-2 gap-1.5">
          <button
            onClick={() => game.action('ap')}
            className={`p-2 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition ${
              hud.ap.on ? 'bg-cyan-400 text-slate-950 border-cyan-300' : 'bg-white/10 border-white/15 text-slate-200'
            }`}
          >
            <FlightIcon name={hud.ap.on ? 'check' : 'autopilot'} size={13} />
            <span>{hud.ap.on ? 'AP DISENGAGE' : 'ENGAGE AP'}</span>
          </button>
          <button
            onClick={() => game.action('apnav')}
            className={`p-2 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition ${
              hud.ap.nav ? 'bg-emerald-400 text-slate-950 border-emerald-300' : 'bg-white/10 border-white/15 text-slate-200'
            }`}
          >
            <FlightIcon name="compass" size={13} />
            <span>LNAV ROUTE</span>
          </button>
        </div>
      </div>
    </MsfsFloatingWindow>
  );
}

/* =========================================================================
   10. AIRCRAFT SYSTEMS & FUEL WINDOW
   ========================================================================= */
export function SystemsWindow({
  game,
  hud,
  onClose,
}: {
  game: Game;
  hud: HudState;
  onClose: () => void;
}) {
  return (
    <MsfsFloatingWindow
      title="Aircraft Systems & Fuel"
      icon="settings"
      onClose={onClose}
      initialPos={{ x: 260, y: 70 }}
      width={370}
    >
      <div className="space-y-3">
        {/* Fuel Breakdown */}
        <div>
          <span className="text-[9px] text-slate-400 uppercase tracking-widest font-bold block mb-1.5">
            Fuel Tanks & Endurance
          </span>
          <div className="p-2.5 rounded-xl bg-white/5 border border-white/10 space-y-2">
            <div>
              <div className="flex justify-between text-xs font-bold mb-1">
                <span className="text-slate-300">Total Fuel Quantity</span>
                <span className="text-emerald-400 font-mono">{Math.round(hud.fuelPct)}% ({Math.round(hud.fuelKg)} kg)</span>
              </div>
              <div className="w-full h-2 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full bg-emerald-400 transition-all duration-300"
                  style={{ width: `${Math.round(hud.fuelPct)}%` }}
                />
              </div>
            </div>
            <div className="flex justify-between text-[10px] text-slate-400 border-t border-white/10 pt-1 font-mono">
              <span>Estimated Endurance:</span>
              <span className="text-white font-bold">{fmtT(hud.fuelTimeMin)}</span>
            </div>
          </div>
        </div>

        {/* Exterior Lights Switches */}
        <div>
          <span className="text-[9px] text-slate-400 uppercase tracking-widest font-bold block mb-1.5">
            Lighting Master Panel
          </span>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => game.action('nav')}
              className={`p-2 rounded-xl border text-xs font-bold transition flex items-center justify-between ${
                hud.lights.nav ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200' : 'bg-white/5 border-white/10 text-slate-300'
              }`}
            >
              <span>Navigation</span>
              <span className="font-mono text-[9px]">{hud.lights.nav ? 'ON' : 'OFF'}</span>
            </button>
            <button
              onClick={() => game.action('strb')}
              className={`p-2 rounded-xl border text-xs font-bold transition flex items-center justify-between ${
                hud.lights.strobe ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200' : 'bg-white/5 border-white/10 text-slate-300'
              }`}
            >
              <span>Strobe</span>
              <span className="font-mono text-[9px]">{hud.lights.strobe ? 'ON' : 'OFF'}</span>
            </button>
            <button
              onClick={() => game.action('bcn')}
              className={`p-2 rounded-xl border text-xs font-bold transition flex items-center justify-between ${
                hud.lights.beacon ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200' : 'bg-white/5 border-white/10 text-slate-300'
              }`}
            >
              <span>Beacon</span>
              <span className="font-mono text-[9px]">{hud.lights.beacon ? 'ON' : 'OFF'}</span>
            </button>
            <button
              onClick={() => game.action('land')}
              className={`p-2 rounded-xl border text-xs font-bold transition flex items-center justify-between ${
                hud.lights.land ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200' : 'bg-white/5 border-white/10 text-slate-300'
              }`}
            >
              <span>Landing</span>
              <span className="font-mono text-[9px]">{hud.lights.land ? 'ON' : 'OFF'}</span>
            </button>
          </div>
        </div>

        {/* Cabin Management */}
        <div>
          <span className="text-[9px] text-slate-400 uppercase tracking-widest font-bold block mb-1.5">
            Passenger Cabin & Comfort ({Math.round(hud.comfort)}%)
          </span>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => game.action('belt')}
              className={`p-2 rounded-xl border text-xs font-bold transition flex items-center justify-between ${
                hud.seatbelt ? 'bg-amber-500/25 border-amber-400 text-amber-200' : 'bg-white/5 border-white/10 text-slate-300'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <FlightIcon name="bell" size={12} />
                <span>Fasten Belts</span>
              </span>
              <span className="font-mono text-[9px]">{hud.seatbelt ? 'ON' : 'OFF'}</span>
            </button>
            <button
              onClick={() => game.action('pa')}
              className="p-2 rounded-xl bg-white/5 hover:bg-white/15 border border-white/10 text-xs font-bold transition text-left flex items-center gap-1.5"
            >
              <FlightIcon name="volume" size={12} />
              <span>Captain PA</span>
            </button>
          </div>
        </div>
      </div>
    </MsfsFloatingWindow>
  );
}

/* =========================================================================
   11. MSFS EXTERNAL CHASE HUD (CORNER CLUSTERS)
   ========================================================================= */
export function MsfsExternalHud({
  hud,
  metric,
}: {
  hud: HudState;
  metric: boolean;
}) {
  const kias = hud.kias;
  const alt = metric ? hud.altFt * 0.3048 : hud.altFt;
  const altUnit = metric ? 'M' : 'FT';
  const speedUnit = metric ? 'KM/H' : 'KTS';
  const speedVal = metric ? kias * 1.852 : kias;

  return (
    <div className="absolute inset-0 pointer-events-none select-none overflow-hidden z-20 font-sans">
      {/* =======================================================
          BOTTOM-LEFT CLUSTER: SPEED TAPE, COMPASS, ENGINE POWER
          ======================================================= */}
      <div className="absolute left-3 sm:left-4 bottom-3 sm:bottom-4 flex items-end gap-3 pointer-events-auto">
        {/* Vertical Airspeed Tape */}
        <div className="w-16 sm:w-18 h-48 sm:h-54 rounded-2xl bg-slate-950/85 border border-white/20 backdrop-blur-md shadow-2xl p-2 flex flex-col justify-between items-center relative overflow-hidden">
          <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{speedUnit}</div>

          {/* Speed Value Window */}
          <div className="my-auto py-1 px-1.5 rounded-lg bg-black/60 border border-cyan-400/50 shadow-inner text-center w-full">
            <span className="font-mono text-lg sm:text-xl font-black text-cyan-300 tabular-nums">
              {Math.round(speedVal)}
            </span>
            {hud.mach > 0.4 && (
              <span className="block text-[8px] text-slate-400 font-mono">M {hud.mach.toFixed(2)}</span>
            )}
          </div>

          <div className="text-[9px] font-mono text-slate-400">GS {Math.round(hud.gsKt)}</div>
        </div>

        {/* Heading & Wind Widget */}
        <div className="rounded-2xl bg-slate-950/85 border border-white/20 backdrop-blur-md shadow-2xl p-2.5 flex flex-col items-center">
          <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">HEADING</div>
          <div className="w-16 h-16 rounded-full border-2 border-white/20 relative grid place-items-center bg-black/40">
            {/* Heading bug marker */}
            <div
              style={{ transform: `rotate(${hud.hdg}deg)` }}
              className="absolute inset-0 flex justify-center items-start transition-transform duration-75"
            >
              <div className="w-1.5 h-2.5 bg-cyan-400 rounded-b shadow-[0_0_8px_#22d3ee]" />
            </div>
            {/* Center Heading Readout */}
            <span className="font-mono text-xs font-black text-white">
              {String(Math.round(hud.hdg)).padStart(3, '0')}°
            </span>
          </div>

          {/* Wind readout */}
          <div className="mt-1.5 text-[9px] font-mono text-cyan-300 flex items-center gap-1">
            <FlightIcon name="wind" size={11} />
            <span>{hud.wind.kt} KT</span>
          </div>
        </div>

        {/* Engine Thrust & Sim Rate */}
        <div className="rounded-2xl bg-slate-950/85 border border-white/20 backdrop-blur-md shadow-2xl p-2.5 flex flex-col justify-between h-48 sm:h-54">
          <div>
            <span className="text-[9px] text-slate-400 uppercase tracking-widest block font-bold">THRUST</span>
            <div className="w-4 h-24 rounded bg-white/10 overflow-hidden flex items-end border border-white/10 mt-1 mx-auto">
              <div
                className="w-full bg-gradient-to-t from-cyan-400 to-emerald-300"
                style={{ height: `${hud.throttle * 100}%` }}
              />
            </div>
            <span className="font-mono text-xs font-black text-cyan-300 block text-center mt-1">
              {Math.round(hud.throttle * 100)}%
            </span>
          </div>

          <div className="border-t border-white/10 pt-1 text-center">
            <span className="text-[8px] text-slate-400 block font-bold">SIM RATE</span>
            <span className="font-mono text-[10px] text-emerald-300 font-bold">1:1 LIVE</span>
          </div>
        </div>
      </div>

      {/* =======================================================
          BOTTOM-RIGHT CLUSTER: ALTITUDE TAPE, VSI, TRIM & GEAR
          ======================================================= */}
      <div className="absolute right-3 sm:right-4 bottom-3 sm:bottom-4 flex items-end gap-3 pointer-events-auto">
        {/* Aircraft Configuration & Flaps / Gear */}
        <div className="rounded-2xl bg-slate-950/85 border border-white/20 backdrop-blur-md shadow-2xl p-2.5 flex flex-col justify-between h-48 sm:h-54">
          <div>
            <span className="text-[9px] text-slate-400 uppercase tracking-widest block font-bold mb-1">GEAR</span>
            <div className="grid grid-cols-3 gap-1">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className={`w-3.5 h-3.5 rounded-full border grid place-items-center ${
                    hud.gear > 0.98
                      ? 'bg-emerald-400 border-emerald-300 shadow-[0_0_8px_#34d399]'
                      : hud.gear > 0.05
                      ? 'bg-amber-400 border-amber-300 animate-pulse'
                      : 'bg-white/10 border-white/20'
                  }`}
                />
              ))}
            </div>
          </div>

          <div className="my-auto">
            <span className="text-[9px] text-slate-400 uppercase tracking-widest block font-bold mb-0.5">FLAPS</span>
            <div className="font-mono text-xs font-black text-cyan-300">
              {hud.flapsIdx} / {hud.flapsDet}
            </div>
          </div>

          <div>
            <span className="text-[9px] text-slate-400 uppercase tracking-widest block font-bold mb-0.5">TRIM</span>
            <div className="font-mono text-xs font-bold text-white">
              {(hud.trim * 100).toFixed(0)}%
            </div>
          </div>
        </div>

        {/* Vertical Altimeter & VSI Tape */}
        <div className="w-20 sm:w-22 h-48 sm:h-54 rounded-2xl bg-slate-950/85 border border-white/20 backdrop-blur-md shadow-2xl p-2 flex flex-col justify-between items-center relative overflow-hidden">
          <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{altUnit} ALT</div>

          {/* Altitude Value Window */}
          <div className="my-auto py-1 px-1.5 rounded-lg bg-black/60 border border-emerald-400/50 shadow-inner text-center w-full">
            <span className="font-mono text-lg sm:text-xl font-black text-emerald-300 tabular-nums">
              {Math.round(alt).toLocaleString()}
            </span>
            {hud.aglFt < 2500 && (
              <span className="block text-[8px] text-amber-300 font-mono font-bold">
                RA {Math.round(hud.aglFt)}
              </span>
            )}
          </div>

          <div className="text-[9px] font-mono text-slate-400">
            {hud.vsFpm > 0 ? '+' : ''}{Math.round(hud.vsFpm)} FPM
          </div>
        </div>
      </div>
    </div>
  );
}
