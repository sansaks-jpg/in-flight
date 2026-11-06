import { ReactNode, useState } from 'react';
import { Settings, ScoreRecord, loadScores, clearScores } from '../sim/storage';
import { QUALITY, QUALITY_ORDER } from '../sim/quality';
import { FlightIcon } from './FlightIcon';
import { InteractiveEarthGlobe, MsfsTopRightBar } from './PreGameVisuals';
import { MENU_BENTO_TILES, REPO_FACTS } from './flightDispatch';

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/85 p-3 select-none font-sans animate-[fadein_.15s_ease-out]"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className={`w-full ${
          wide ? 'max-w-4xl' : 'max-w-xl'
        } max-h-[90vh] flex flex-col border border-white/20 bg-[#141b26] text-white shadow-2xl overflow-hidden`}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/15 bg-[#0d131c]">
          <h2 className="font-extrabold tracking-[0.18em] text-xs uppercase text-sky-300">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="w-7 h-7 bg-white/10 hover:bg-[#2572eb] transition grid place-items-center text-white"
          >
            <FlightIcon name="close" size={14} />
          </button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-center justify-between gap-4 py-2.5 border-b border-white/10">
    <div className="text-xs sm:text-sm font-medium text-slate-200">{label}</div>
    <div>{children}</div>
  </div>
);

const Toggle = ({ v, on, label }: { v: boolean; on: (v: boolean) => void; label?: string }) => (
  <button
    type="button"
    aria-label={label}
    onClick={() => on(!v)}
    className={`w-11 h-6 relative transition border ${
      v ? 'bg-[#2572eb] border-sky-300' : 'bg-[#0d131c] border-white/20'
    }`}
  >
    <span
      className={`absolute top-0.5 w-4 h-4 bg-white transition-all ${
        v ? 'left-5' : 'left-0.5'
      }`}
    />
  </button>
);

export function SettingsPanel({ s, set }: { s: Settings; set: (p: Partial<Settings>) => void }) {
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-[10px] uppercase tracking-widest font-extrabold text-sky-300 mb-2">
          Audio &amp; Voice Systems
        </h4>
        <Row label="Master audio volume">
          <input
            type="range"
            aria-label="Master audio volume"
            min={0}
            max={1}
            step={0.05}
            value={s.volume}
            onChange={(e) => set({ volume: +e.target.value })}
            className="w-40 accent-sky-400"
          />
        </Row>
        <Row label="Mute all audio">
          <Toggle label="Mute all audio" v={s.muted} on={(v) => set({ muted: v })} />
        </Row>
        <Row label="Voice callouts & GPWS warnings (speech)">
          <Toggle label="Voice callouts" v={s.voice} on={(v) => set({ voice: v })} />
        </Row>
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-widest font-extrabold text-sky-300 mb-2">
          Flight Dynamics &amp; Controls
        </h4>
        <Row label="Flight assist (stability & envelope protection)">
          <Toggle label="Flight assist" v={s.assist} on={(v) => set({ assist: v })} />
        </Row>
        <Row label="Invert pitch control (Up = pull up)">
          <Toggle label="Invert pitch control" v={s.invertPitch} on={(v) => set({ invertPitch: v })} />
        </Row>
        <Row label="Control stick sensitivity">
          <input
            type="range"
            aria-label="Control stick sensitivity"
            min={0.5}
            max={1.8}
            step={0.1}
            value={s.sens}
            onChange={(e) => set({ sens: +e.target.value })}
            className="w-40 accent-sky-400"
          />
        </Row>
        <Row label="Dynamic cockpit camera shake">
          <Toggle label="Dynamic cockpit camera shake" v={s.shake} on={(v) => set({ shake: v })} />
        </Row>
        <Row label="Flight instructor coaching hints & HUD">
          <Toggle label="Flight instructor coaching hints" v={s.hud} on={(v) => set({ hud: v })} />
        </Row>
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-widest font-extrabold text-sky-300 mb-2">
          Display &amp; Units
        </h4>
        <Row label="HUD display mode">
          <select
            aria-label="HUD display mode"
            value={s.hudMode}
            onChange={(e) => set({ hudMode: e.target.value as Settings['hudMode'] })}
            className="bg-[#0d131c] px-3 py-1.5 text-xs border border-white/15 text-white outline-none"
          >
            <option value="minimal">Minimal (High immersion, unobstructed view)</option>
            <option value="standard">Standard (PFD Glass Cockpit & Telemetry)</option>
            <option value="assisted">Assisted (Standard + pitch bracket & landing guides)</option>
            <option value="cockpit">Cockpit 3D (Instruments on 3D flight deck only)</option>
          </select>
        </Row>
        <Row label="In-flight text size">
          <select
            aria-label="In-flight text size"
            value={s.uiScale}
            onChange={(e) => set({ uiScale: +e.target.value })}
            className="bg-[#0d131c] px-3 py-1.5 text-xs border border-white/15 text-white outline-none"
          >
            <option value={0.75}>Compact</option>
            <option value={1.0}>Default</option>
            <option value={1.25}>Large text</option>
            <option value={1.5}>Extra large text</option>
          </select>
        </Row>
        <Row label="Colorblind high-contrast mode">
          <Toggle label="Colorblind high-contrast mode" v={s.colorblind} on={(v) => set({ colorblind: v })} />
        </Row>
        <Row label="Instrumentation units">
          <select
            aria-label="Instrumentation units"
            value={s.units}
            onChange={(e) => set({ units: e.target.value as Settings['units'] })}
            className="bg-[#0d131c] px-3 py-1.5 text-xs border border-white/15 text-white outline-none"
          >
            <option value="aviation">Aviation Standard (knots / feet / fpm)</option>
            <option value="metric">Metric Standard (km/h / meters / m/s)</option>
          </select>
        </Row>
        <Row label="3D world detail &amp; performance">
          <select
            aria-label="3D world detail and performance"
            value={s.quality}
            onChange={(e) => set({ quality: e.target.value as Settings['quality'] })}
            className="bg-[#0d131c] px-3 py-1.5 text-xs border border-white/15 text-white outline-none max-w-[19rem]"
          >
            {QUALITY_ORDER.map((q) => (
              <option key={q} value={q}>
                {QUALITY[q].menu}
              </option>
            ))}
            <option value="auto">Auto — Best preset for this device</option>
          </select>
        </Row>
        <div className="mt-2 mb-3 border border-sky-400/20 bg-sky-400/[0.06] px-3 py-2.5">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-[10px] font-black uppercase tracking-widest text-sky-200">
              {s.quality === 'auto' ? 'Auto quality' : `${QUALITY[s.quality].label} detail`}
            </span>
            <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-300/90">
              60 FPS target
            </span>
          </div>
          {s.quality === 'auto' ? (
            <p className="text-[11px] leading-relaxed text-slate-300">
              Picks <b className="text-white">High</b> on desktop and <b className="text-white">Low</b> on touch devices, then scales resolution to hold 60 FPS.
            </p>
          ) : (
            <>
              <p className="text-[11px] leading-relaxed text-slate-300">{QUALITY[s.quality].summary}</p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {[
                  ['Buildings', QUALITY[s.quality].buildings !== 'none'],
                  ['Houses', QUALITY[s.quality].buildings === 'all'],
                  ['Trees', QUALITY[s.quality].trees],
                  ['Roads 3D', QUALITY[s.quality].roads],
                  ['Airport 3D', QUALITY[s.quality].airportDetail],
                  ['Street lights', QUALITY[s.quality].streetLights],
                ].map(([label, on]) => (
                  <span
                    key={String(label)}
                    className={`px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide border ${
                      on
                        ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
                        : 'border-white/10 bg-white/[0.03] text-slate-500 line-through'
                    }`}
                  >
                    {label}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
        <Row label="Pilot logbook callsign">
          <input
            aria-label="Pilot logbook callsign"
            value={s.name}
            maxLength={14}
            onChange={(e) => set({ name: e.target.value })}
            className="bg-[#0d131c] px-3 py-1.5 text-xs border border-white/15 w-40 text-white font-mono outline-none"
          />
        </Row>
      </div>
    </div>
  );
}

const K = ({ children }: { children: ReactNode }) => (
  <kbd className="px-2 py-0.5 bg-[#0d131c] border border-white/20 text-[11px] font-mono text-sky-200">
    {children}
  </kbd>
);

export function ControlsPanel() {
  const rows: [ReactNode, string][] = [
    [<><K>W</K> <K>S</K> / <K>Up</K> <K>Down</K></>, 'Pitch down / Pitch up'],
    [<><K>A</K> <K>D</K> / <K>Left</K> <K>Right</K></>, 'Aileron roll left / right'],
    [<><K>Q</K> <K>E</K></>, 'Rudder & nose-wheel taxi steering'],
    [<><K>Shift</K> <K>Ctrl</K> / <K>PgUp</K> <K>PgDn</K></>, 'Throttle increase / decrease'],
    [<><K>1</K>–<K>4</K></>, 'Radio replies when Radio is open · otherwise throttle 10–40%'],
    [<><K>5</K>–<K>9</K> <K>0</K> <K>X</K></>, 'Direct throttle 50–100% · Idle (X)'],
    [<K>Space</K>, 'Wheel brakes (hold to brake)'],
    [<K>B</K>, 'Parking brake toggle'],
    [<><K>F</K> <K>V</K></>, 'Flaps extend / retract'],
    [<K>G</K>, 'Landing gear extend / retract'],
    [<K>T</K>, 'Reverse thrust (ground braking)'],
    [<K>Z</K>, 'Flight spoilers / Speedbrake'],
    [<><K>L</K> <K>O</K></>, 'Landing lights · Strobe & beacon lights'],
    [<><K>J</K> <K>K</K></>, 'Seatbelt chime · Cabin passenger announcement'],
    [<K>Y</K>, 'Autopilot master engage / disengage'],
    [<><K>N</K> <K>U</K></>, 'LNAV route navigation · ILS autoland approach'],
    [<><K>,</K> <K>.</K> <K>[</K> <K>]</K> <K>-</K> <K>=</K></>, 'Autopilot heading · altitude · speed adjustment'],
    [<K>\</K>, 'Time acceleration (cruise time warp)'],
    [<K>Tab</K>, 'Navigate interface controls · choose arrival runway in Autopilot'],
    [<>Alert ACK button</>, 'Acknowledge the on-screen warning / caution'],
    [<K>C</K>, 'Cycle camera: Cockpit / Chase / Spotter / Cabin'],
    [<K>M</K>, 'Full-screen map · M or Esc to return'],
    [<K>H</K>, 'Cycle Standard / Minimal / Assisted / Cockpit HUD'],
    [<><K>P</K> / <K>Esc</K></>, 'Pause simulation · Esc closes an open flight tool first'],
    [<><K>R</K> (hold)</>, 'Instant flight restart'],
    [<>Mouse / Touch</>, 'Right-drag to look · click cockpit controls · Home resets the view'],
  ];

  return (
    <div className="grid sm:grid-cols-2 gap-x-8 gap-y-1">
      {rows.map(([k, d], i) => (
        <div key={i} className="flex items-center justify-between gap-3 py-2 border-b border-white/10 text-sm">
          <span className="whitespace-nowrap">{k}</span>
          <span className="text-slate-300 text-right text-xs font-medium">{d}</span>
        </div>
      ))}
      <div className="sm:col-span-2 text-xs text-slate-300 mt-4 leading-relaxed bg-[#0d131c] p-3 border border-white/10">
        <b>Gamepad Controller:</b> Left stick = Pitch &amp; Roll, Right stick X = Rudder, Triggers = Throttle, A = Gear, B = Parking brake, Bumpers = Flaps, D-Pad = ATC 1–4, Back/Select = Cycle HUD mode, Start = Pause.
      </div>
    </div>
  );
}

export function ScoresPanel() {
  const [list, setList] = useState<ScoreRecord[]>(loadScores());
  return (
    <div>
      {list.length === 0 ? (
        <p className="text-slate-300 text-sm">
          No flight logs recorded yet. Complete a flight to register your first record in the pilot logbook.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-slate-400 border-b border-white/15">
                <th className="text-left py-2">#</th>
                <th className="text-left">Pilot</th>
                <th className="text-left">Route</th>
                <th className="text-left hidden sm:table-cell">Aircraft</th>
                <th className="text-center">Grade</th>
                <th className="text-right">Score</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={i} className="border-b border-white/5">
                  <td className="py-2.5 text-slate-400 font-mono tabular-nums">{i + 1}</td>
                  <td className="font-bold text-white">{r.name}</td>
                  <td className="font-mono text-sky-300">
                    {r.from} to {r.to}
                    {r.outcome === 'crashed' && (
                      <span className="ml-1.5 text-[10px] text-rose-400 font-bold uppercase">[CRASHED]</span>
                    )}
                    {r.outcome === 'diverted' && (
                      <span className="ml-1.5 text-[10px] text-amber-300 font-bold uppercase">[DIVERTED]</span>
                    )}
                  </td>
                  <td className="hidden sm:table-cell text-slate-400">{r.aircraft}</td>
                  <td className="text-center font-black text-sky-300 font-mono">{r.grade}</td>
                  <td className="text-right font-mono font-black text-white tabular-nums">
                    {r.score.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.length > 0 && (
        <button
          type="button"
          onClick={() => {
            clearScores();
            setList([]);
          }}
          className="mt-4 text-xs text-rose-300 hover:text-rose-200 underline"
        >
          Clear Logbook Records
        </button>
      )}
    </div>
  );
}

/* =========================================================================
   MSFS 2024 MAIN MENU HUB (Matches Reference Image 1: image_77d50b99.png)
   ========================================================================= */

export function StartScreen({
  onStart,
  onOpenHangar,
  onQuick,
  settings,
  set,
  bestScore,
  ready,
  exiting = false,
  hideGlobe = false,
  bgMode: controlledBgMode,
  onToggleBgMode,
}: {
  onStart: () => void;
  onOpenHangar?: () => void;
  onQuick: () => void;
  settings: Settings;
  set: (p: Partial<Settings>) => void;
  bestScore: number;
  ready: boolean;
  exiting?: boolean;
  hideGlobe?: boolean;
  bgMode?: 'globe' | 'airport';
  onToggleBgMode?: () => void;
}) {
  const [modal, setModal] = useState<null | 'scores' | 'settings' | 'controls' | 'credits'>(null);
  const [localBgMode, setLocalBgMode] = useState<'globe' | 'airport'>('globe');
  const bgMode = controlledBgMode ?? localBgMode;
  const toggleBgMode = onToggleBgMode ?? (() => setLocalBgMode((m) => (m === 'globe' ? 'airport' : 'globe')));
  const scoresCount = loadScores().length;

  const tileWorldPhoto = MENU_BENTO_TILES[0];
  const tileChallenge = MENU_BENTO_TILES[1];
  const tileActivities = MENU_BENTO_TILES[2];
  const tileCareer = MENU_BENTO_TILES[3];
  const tileFreeFlight = MENU_BENTO_TILES[4];
  const tileMarketplace = MENU_BENTO_TILES[5];

  return (
    <div
      className={`fixed inset-0 text-white select-none overflow-hidden font-sans transition-opacity duration-300 ${
        exiting ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
      style={{
        background:
          bgMode === 'globe'
            ? hideGlobe
              ? 'transparent'
              : 'radial-gradient(circle at 66% 50%, #091730 0%, #03060e 58%, #010307 100%)'
            : 'linear-gradient(90deg, rgba(2,5,11,0.92) 0%, rgba(2,5,11,0.72) 44%, rgba(2,5,11,0.18) 100%)',
      }}
    >
      {/* Authentic 3D Satellite Earth Globe on the Right Side (No airports included) */}
      {bgMode === 'globe' && !hideGlobe && (
        <InteractiveEarthGlobe mode="menu" className="absolute inset-0 w-full h-full z-0" />
      )}

      {/* Left contrast vignette so the MSFS Bento Grid always has crisp contrast */}
      <div
        className="absolute inset-y-0 left-0 w-full sm:w-[680px] pointer-events-none z-10"
        style={{
          background:
            'linear-gradient(90deg, rgba(2,4,9,0.94) 0%, rgba(2,4,9,0.78) 65%, rgba(2,4,9,0) 100%)',
        }}
      />

      {/* Top-Right Pilot Banner & Utility Bar */}
      <div className="absolute top-0 right-0 z-30 flex items-center gap-3">
        <div className="hidden md:flex items-center gap-2 text-xs font-mono text-slate-300 bg-[#0b1018]/90 border-b border-l border-white/10 px-3 h-8">
          <span className="font-extrabold tracking-widest text-white">IN-FLIGHT</span>
          <span className="text-slate-600">|</span>
          <span className="text-sky-300">{REPO_FACTS.totalAirports.toLocaleString()} AIRPORTS</span>
          <span className="text-slate-600">|</span>
          <span className="text-emerald-300">{REPO_FACTS.indonesiaAirports} INDONESIA</span>
        </div>
        <MsfsTopRightBar pilotName={settings.name} onOpenModal={(m) => setModal(m)} />
      </div>

      {/* Main Layout Container: Left Bento Grid + Bottom Bar */}
      <div
        className={`relative z-20 h-full flex flex-col justify-between px-5 sm:px-11 pt-10 pb-4 pointer-events-none transition-all duration-300 ease-out ${
          exiting ? '-translate-x-10 opacity-0' : 'translate-x-0 opacity-100'
        }`}
      >
        {/* Left Asymmetric MSFS 2024 Bento Tile Grid (Matches Reference Image 1) */}
        <div className="w-full max-w-[530px] flex-1 flex flex-col justify-center gap-2.5 pointer-events-auto max-h-[83vh]">
          {/* TILE 1 (Full-Width Top Banner): World Photographer */}
          <button
            type="button"
            onClick={onStart}
            className="w-full h-24 sm:h-28 relative overflow-hidden border border-white/20 hover:border-white/75 text-left group transition bg-[#0c131f] shadow-2xl"
          >
            <img
              src={tileWorldPhoto.imageUrl}
              alt={tileWorldPhoto.title}
              referrerPolicy="no-referrer"
              className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-slate-950/70 via-slate-950/20 to-transparent" />
            <div className="relative z-10 p-3 flex flex-col justify-between h-full">
              <div className="font-bold text-base sm:text-lg text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.85)]">
                {tileWorldPhoto.title}
              </div>
              <div className="text-[11px] text-slate-100/95 font-medium drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">
                {tileWorldPhoto.subtitle}
              </div>
            </div>
          </button>

          {/* MIDDLE 2-COLUMN ASYMMETRIC BENTO GRID */}
          <div className="grid grid-cols-2 gap-2.5">
            {/* Left Column: Challenge League (short) + Activities (tall) */}
            <div className="flex flex-col gap-2.5">
              {/* Challenge League Tile */}
              <button
                type="button"
                onClick={() => {
                  set({ startMode: 'final' });
                  onQuick();
                }}
                className="h-24 sm:h-28 relative overflow-hidden border border-white/20 hover:border-white/75 text-left group transition bg-[#111926] shadow-xl"
              >
                <img
                  src={tileChallenge.imageUrl}
                  alt={tileChallenge.title}
                  referrerPolicy="no-referrer"
                  className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950/75 via-transparent to-slate-950/45" />
                <div className="relative z-10 p-3 flex flex-col justify-between h-full">
                  <div className="font-bold text-sm sm:text-base text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.85)]">
                    {tileChallenge.title}
                  </div>
                  <div className="text-[10px] font-mono text-amber-200 font-semibold drop-shadow">
                    {tileChallenge.subtitle}
                  </div>
                </div>
              </button>

              {/* Activities Tile */}
              <button
                type="button"
                onClick={onStart}
                className="h-40 sm:h-44 relative overflow-hidden border border-white/20 hover:border-white/75 text-left group transition bg-[#0d192b] shadow-xl"
              >
                <img
                  src={tileActivities.imageUrl}
                  alt={tileActivities.title}
                  referrerPolicy="no-referrer"
                  className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950/85 via-transparent to-slate-950/40" />
                <div className="relative z-10 p-3 flex flex-col justify-between h-full">
                  <div className="font-bold text-sm sm:text-base text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.85)]">
                    {tileActivities.title}
                  </div>
                  <div>
                    <div className="text-[11px] font-extrabold tracking-wider uppercase text-amber-300 drop-shadow">
                      {tileActivities.badge}
                    </div>
                    <div className="text-[10px] text-slate-100 mt-0.5 drop-shadow">
                      {tileActivities.subtitle}
                    </div>
                  </div>
                </div>
              </button>
            </div>

            {/* Right Column: Career (tall) + Free Flight (primary hero tile) */}
            <div className="flex flex-col gap-2.5">
              {/* Career & Pilot Logbook Tile */}
              <button
                type="button"
                onClick={() => setModal('scores')}
                className="h-40 sm:h-44 relative overflow-hidden border border-white/20 hover:border-white/75 text-left group transition bg-[#121a26] shadow-xl"
              >
                <img
                  src={tileCareer.imageUrl}
                  alt={tileCareer.title}
                  referrerPolicy="no-referrer"
                  className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950/85 via-transparent to-slate-950/40" />
                <div className="relative z-10 p-3 flex flex-col justify-between h-full">
                  <div className="font-bold text-sm sm:text-base text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.85)]">
                    {tileCareer.title}
                  </div>
                  <div>
                    <div className="text-xs font-bold text-white drop-shadow">
                      Pilot Logbook · {scoresCount} Flights
                    </div>
                    <div className="text-[11px] font-mono text-amber-300 font-bold drop-shadow">
                      Best Score: {bestScore.toLocaleString()} pts
                    </div>
                  </div>
                </div>
              </button>

              {/* Free Flight Tile (Primary selected tile matching Image 1) */}
              <button
                type="button"
                data-start="true"
                onClick={onStart}
                className="h-24 sm:h-28 relative overflow-hidden border-2 border-white hover:border-sky-300 text-left group transition bg-[#1e3a6e] shadow-[0_0_24px_rgba(255,255,255,0.22)]"
              >
                <img
                  src={tileFreeFlight.imageUrl}
                  alt={tileFreeFlight.title}
                  referrerPolicy="no-referrer"
                  className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                />
                <div className="absolute inset-0 bg-gradient-to-r from-white/20 via-transparent to-slate-950/25" />
                <div className="relative z-10 p-3 flex flex-col justify-between h-full">
                  <div className="font-extrabold text-sm sm:text-base text-slate-950 drop-shadow-[0_1px_2px_rgba(255,255,255,0.85)]">
                    {tileFreeFlight.title}
                  </div>
                  <div className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-950/80 text-white text-[10px] font-bold uppercase tracking-wider w-fit">
                    <span>{tileFreeFlight.subtitle}</span>
                    <FlightIcon name="chevron" size={11} />
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* TILE 6 (Full-Width Bottom Showcase Tile with Caption Footer, matching Marketplace in Image 1) */}
          <div className="w-full border border-white/20 overflow-hidden bg-[#0a0f17]/95 shadow-2xl">
            <button
              type="button"
              onClick={onOpenHangar || onStart}
              className="w-full h-24 sm:h-28 relative overflow-hidden text-left block group bg-[#121924]"
            >
              <img
                src={tileMarketplace.imageUrl}
                alt={tileMarketplace.title}
                referrerPolicy="no-referrer"
                className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
              />
              <div className="absolute inset-0 bg-gradient-to-r from-slate-950/65 via-transparent to-slate-950/35" />
              <div className="absolute top-2.5 left-3.5 z-10">
                <div className="font-bold text-sm sm:text-base text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)]">
                  {tileMarketplace.title}
                </div>
                <div className="text-[10px] font-semibold text-emerald-300 uppercase tracking-wider mt-0.5 drop-shadow">
                  {tileMarketplace.subtitle}
                </div>
              </div>
            </button>
            <div className="px-3.5 py-2 bg-[#070b11] text-[11px] text-slate-300 leading-snug border-t border-white/10">
              Check out the Aircraft Hangar &amp; World Scenery to configure <b>Aero Swift RG</b>, <b>Aero Trek T2</b>, and <b>Skyliner 320</b> across {REPO_FACTS.totalAirports.toLocaleString()} airports.
            </div>
          </div>
        </div>

        {/* Bottom Action Bar (Matches Image 1 bottom-left action links + preserves QUICK FLIGHT for automated tests) */}
        <div className="pt-2.5 flex flex-wrap items-center justify-between gap-3 pointer-events-auto">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onQuick}
              className="px-4 py-1.5 bg-[#eab308] hover:bg-[#facc15] text-slate-950 font-extrabold text-xs tracking-wide transition flex items-center gap-1.5 shadow-lg"
            >
              <FlightIcon name="bolt" size={13} />
              <span>QUICK FLIGHT</span>
              {!ready && <span className="text-[10px] font-mono opacity-75">(Ready)</span>}
            </button>

            <button
              type="button"
              onClick={onStart}
              className="px-4 py-1.5 bg-[#1d6ae5] hover:bg-[#2572eb] text-white font-bold text-xs transition flex items-center gap-1.5 shadow-lg"
            >
              <FlightIcon name="globe" size={13} />
              <span>World Flight Planner</span>
            </button>

            <button
              type="button"
              onClick={() => setModal('controls')}
              className="px-3 py-1.5 bg-transparent hover:bg-white/10 text-xs font-bold text-slate-200 hover:text-white transition"
            >
              Flight Controls
            </button>

            <button
              type="button"
              onClick={() => setModal('settings')}
              className="px-3 py-1.5 bg-transparent hover:bg-white/10 text-xs font-bold text-slate-200 hover:text-white transition"
            >
              Settings
            </button>

            <button
              type="button"
              onClick={() => setModal('credits')}
              className="px-3 py-1.5 bg-transparent hover:bg-white/10 text-xs font-bold text-slate-200 hover:text-white transition"
            >
              Release notes
            </button>
          </div>

          <button
            type="button"
            onClick={toggleBgMode}
            className="px-3.5 py-1.5 bg-[#0d131c]/90 hover:bg-white/15 border border-white/20 text-xs font-bold text-sky-300 flex items-center gap-1.5 transition"
          >
            <FlightIcon name={bgMode === 'globe' ? 'camera' : 'globe'} size={13} />
            <span>{bgMode === 'globe' ? 'Live 3D Airport Preview' : '3D Earth Globe View'}</span>
          </button>
        </div>
      </div>

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
        <Modal title="Release Notes & Repository Specifications" onClose={() => setModal(null)}>
          <ul className="text-sm text-slate-300 space-y-2.5 list-disc pl-5">
            <li>
              <b>Esri World Imagery</b> — high-resolution global satellite photography base for 3D terrain and moving maps.
            </li>
            <li>
              <b>AWS Open Data Terrain Tiles (Terrarium)</b> — global DEM elevation heightmaps derived from SRTM, ETOPO1, and GMTED datasets.
            </li>
            <li>
              <b>OurAirports Worldwide Runway Database</b> — {REPO_FACTS.totalAirports.toLocaleString()} airports ({REPO_FACTS.indonesiaAirports} in Indonesia) with authentic runway coordinates, magnetic headings, thresholds, and dimensions.
            </li>
            <li>
              <b>OpenStreetMap &amp; OpenFreeMap MVT</b> — real airport terminals, control towers, hangars, highways, and coastlines rendered dynamically in 3D.
            </li>
            <li>
              <b>Aviation Glass Cockpit Avionics</b> — Garmin G1000 &amp; MSFS style PFD with attitude director indicator, airspeed tape, altimeter tape, horizontal situation indicator, and flight mode annunciator.
            </li>
          </ul>
        </Modal>
      )}
    </div>
  );
}

