import { ReactNode, useState } from 'react';
import { Settings, ScoreRecord, loadScores, clearScores } from '../sim/storage';
import { QUALITY, QUALITY_ORDER } from '../sim/quality';

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
      className="absolute inset-0 z-50 grid place-items-center bg-slate-950/75 backdrop-blur-md p-3 select-none"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className={`w-full ${
          wide ? 'max-w-4xl' : 'max-w-xl'
        } max-h-[92vh] flex flex-col rounded-3xl border border-white/20 bg-slate-900/95 text-white shadow-2xl overflow-hidden`}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-slate-950/60">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_8px_#38bdf8]" />
            <h2 className="font-black tracking-[0.25em] text-xs uppercase text-cyan-300">{title}</h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 transition grid place-items-center text-sm"
          >
            ✕
          </button>
        </div>
        <div className="p-6 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-center justify-between gap-4 py-2.5 border-b border-white/5">
    <div className="text-sm font-medium text-slate-200">{label}</div>
    <div>{children}</div>
  </div>
);

const Toggle = ({ v, on }: { v: boolean; on: (v: boolean) => void }) => (
  <button
    onClick={() => on(!v)}
    className={`w-12 h-6 rounded-full relative transition ${v ? 'bg-cyan-400' : 'bg-slate-700'}`}
  >
    <span
      className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all shadow-md ${
        v ? 'left-6' : 'left-0.5'
      }`}
    />
  </button>
);

export function SettingsPanel({ s, set }: { s: Settings; set: (p: Partial<Settings>) => void }) {
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-[10px] uppercase tracking-widest font-black text-cyan-300 mb-2">Audio &amp; Voice Systems</h4>
        <Row label="Master audio volume">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={s.volume}
            onChange={(e) => set({ volume: +e.target.value })}
            className="w-40 accent-cyan-400"
          />
        </Row>
        <Row label="Mute all audio">
          <Toggle v={s.muted} on={(v) => set({ muted: v })} />
        </Row>
        <Row label="Voice callouts & GPWS warnings (speech)">
          <Toggle v={s.voice} on={(v) => set({ voice: v })} />
        </Row>
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-widest font-black text-cyan-300 mb-2">Flight Dynamics &amp; Controls</h4>
        <Row label="Flight assist (stability & envelope protection)">
          <Toggle v={s.assist} on={(v) => set({ assist: v })} />
        </Row>
        <Row label="Invert pitch control (↑ = pull up)">
          <Toggle v={s.invertPitch} on={(v) => set({ invertPitch: v })} />
        </Row>
        <Row label="Control stick sensitivity">
          <input
            type="range"
            min={0.5}
            max={1.8}
            step={0.1}
            value={s.sens}
            onChange={(e) => set({ sens: +e.target.value })}
            className="w-40 accent-cyan-400"
          />
        </Row>
        <Row label="Dynamic cockpit camera shake">
          <Toggle v={s.shake} on={(v) => set({ shake: v })} />
        </Row>
        <Row label="Flight instructor coaching hints & HUD">
          <Toggle v={s.hud} on={(v) => set({ hud: v })} />
        </Row>
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-widest font-black text-cyan-300 mb-2">Display &amp; Units</h4>
        <Row label="HUD display mode">
          <select
            value={s.hudMode}
            onChange={(e) => set({ hudMode: e.target.value as Settings['hudMode'] })}
            className="bg-slate-800 rounded-xl px-3 py-1.5 text-xs border border-white/10 text-white outline-none"
          >
            <option value="minimal">Minimal (High immersion, unobstructed view)</option>
            <option value="standard">Standard (PFD Glass Cockpit & Telemetry)</option>
            <option value="assisted">Assisted (Standard + pitch bracket & landing guides)</option>
            <option value="cockpit">Cockpit 3D (Instruments on 3D flight deck only)</option>
          </select>
        </Row>
        <Row label="UI scale factor">
          <select
            value={s.uiScale}
            onChange={(e) => set({ uiScale: +e.target.value })}
            className="bg-slate-800 rounded-xl px-3 py-1.5 text-xs border border-white/10 text-white outline-none"
          >
            <option value={0.75}>75% (Compact / Small displays)</option>
            <option value={1.0}>100% (Standard 1080p)</option>
            <option value={1.25}>125% (Large / 1440p)</option>
            <option value={1.5}>150% (Extra Large / 4K / TV)</option>
          </select>
        </Row>
        <Row label="Colorblind high-contrast mode">
          <Toggle v={s.colorblind} on={(v) => set({ colorblind: v })} />
        </Row>
        <Row label="Instrumentation units">
          <select
            value={s.units}
            onChange={(e) => set({ units: e.target.value as Settings['units'] })}
            className="bg-slate-800 rounded-xl px-3 py-1.5 text-xs border border-white/10 text-white outline-none"
          >
            <option value="aviation">Aviation Standard (knots / feet / fpm)</option>
            <option value="metric">Metric Standard (km/h / meters / m/s)</option>
          </select>
        </Row>
        <Row label="3D world detail &amp; performance">
          <select
            value={s.quality}
            onChange={(e) => set({ quality: e.target.value as Settings['quality'] })}
            className="bg-slate-800 rounded-xl px-3 py-1.5 text-xs border border-white/10 text-white outline-none max-w-[19rem]"
          >
            {QUALITY_ORDER.map((q) => (
              <option key={q} value={q}>{QUALITY[q].menu}</option>
            ))}
            <option value="auto">Auto — Best preset for this device</option>
          </select>
        </Row>
        <div className="mt-2 mb-3 rounded-xl border border-cyan-400/15 bg-cyan-400/[0.06] px-3 py-2.5">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-[10px] font-black uppercase tracking-widest text-cyan-200">
              {s.quality === 'auto' ? 'Auto quality' : `${QUALITY[s.quality].label} detail`}
            </span>
            <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-300/90">60 FPS target</span>
          </div>
          {s.quality === 'auto' ? (
            <p className="text-[11px] leading-relaxed text-slate-300">
              Picks <b className="text-white">High</b> on desktop and <b className="text-white">Low</b> on touch devices, then scales resolution to hold 60 FPS.
            </p>
          ) : (
            <>
              <p className="text-[11px] leading-relaxed text-slate-300">{QUALITY[s.quality].summary}</p>
              <div className="flex flex-wrap gap-1 mt-2">
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
                    className={`px-1.5 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wide border ${
                      on
                        ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200'
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
            value={s.name}
            maxLength={14}
            onChange={(e) => set({ name: e.target.value })}
            className="bg-slate-800 rounded-xl px-3 py-1.5 text-xs border border-white/10 w-40 text-white font-mono outline-none"
          />
        </Row>
      </div>

      <p className="text-[11px] text-slate-400 mt-3 bg-white/5 p-3 rounded-xl border border-white/5">
        Quality changes rebuild the nearby 3D tiles immediately. Resolution auto-scales per preset with a 60 FPS target; Low removes all 3D city objects, Medium keeps trees only, High keeps buildings but skips landed houses, and Ultra renders everything.
      </p>
    </div>
  );
}

const K = ({ children }: { children: ReactNode }) => (
  <kbd className="px-2 py-0.5 rounded-lg bg-slate-800 border border-white/20 text-[11px] font-mono text-cyan-200 shadow-sm">
    {children}
  </kbd>
);

export function ControlsPanel() {
  const rows: [ReactNode, string][] = [
    [<><K>W</K> <K>S</K> / <K>↑</K> <K>↓</K></>, 'Pitch down / Pitch up'],
    [<><K>A</K> <K>D</K> / <K>←</K> <K>→</K></>, 'Aileron roll left / right'],
    [<><K>Q</K> <K>E</K></>, 'Rudder & nose-wheel taxi steering'],
    [<><K>Shift</K> <K>Ctrl</K> / <K>PgUp</K> <K>PgDn</K></>, 'Throttle increase / decrease'],
    [<><K>1</K>–<K>4</K></>, 'ATC Quick Responses 1–4 (or throttle 10–40% if no ATC pending)'],
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
    [<K>Tab</K>, 'Cycle destination approach runway'],
    [<K>H</K>, 'Cycle HUD modes (Minimal / Standard / Assisted / Cockpit)'],
    [<K>A</K>, 'Acknowledge master warning / caution alert'],
    [<K>C</K>, 'Cycle camera: Cockpit / Chase / Spotter / Cabin'],
    [<K>M</K>, 'Interactive World moving map'],
    [<><K>P</K> / <K>Esc</K></>, 'Pause flight simulation'],
    [<><K>R</K> (hold)</>, 'Instant flight restart'],
    [<>Mouse / Touch</>, 'Click and drag to look around · interact with cockpit controls'],
  ];

  return (
    <div className="grid sm:grid-cols-2 gap-x-8 gap-y-1">
      {rows.map(([k, d], i) => (
        <div key={i} className="flex items-center justify-between gap-3 py-2 border-b border-white/5 text-sm">
          <span className="whitespace-nowrap">{k}</span>
          <span className="text-slate-300 text-right text-xs font-medium">{d}</span>
        </div>
      ))}
      <div className="sm:col-span-2 text-xs text-slate-400 mt-4 leading-relaxed bg-white/5 p-3 rounded-2xl border border-white/5">
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
        <p className="text-slate-400 text-sm">No flight logs recorded yet. Complete a flight to register your first record in the pilot logbook!</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-slate-400 border-b border-white/10">
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
                  <td className="py-2.5 text-slate-400 font-mono">{i + 1}</td>
                  <td className="font-bold text-white">{r.name}</td>
                  <td className="font-mono text-cyan-300">
                    {r.from}→{r.to}
                    {r.outcome === 'crashed' && <span className="text-rose-400"> ✖</span>}
                    {r.outcome === 'diverted' && <span className="text-amber-300"> ↪</span>}
                  </td>
                  <td className="hidden sm:table-cell text-slate-400">{r.aircraft}</td>
                  <td className="text-center font-black text-cyan-300 font-mono">{r.grade}</td>
                  <td className="text-right font-mono font-black text-white">{r.score.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.length > 0 && (
        <button
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

export function StartScreen({
  onStart,
  onQuick,
  settings,
  set,
  bestScore,
  ready,
}: {
  onStart: () => void;
  onQuick: () => void;
  settings: Settings;
  set: (p: Partial<Settings>) => void;
  bestScore: number;
  ready: boolean;
}) {
  const [modal, setModal] = useState<null | 'scores' | 'settings' | 'controls' | 'credits'>(null);

  return (
    <div
      className="absolute inset-0 text-white select-none overflow-hidden"
      style={{
        background:
          'radial-gradient(ellipse at 20% 100%, rgba(2,10,22,.88), transparent 60%), linear-gradient(90deg, rgba(2,8,18,.85) 0%, rgba(2,8,18,.45) 55%, rgba(2,8,18,.15) 100%)',
      }}
    >
      <div className="absolute inset-0 flex flex-col justify-between p-6 sm:p-12">
        <div className="flex items-center gap-3 text-xs tracking-[0.35em] text-cyan-200 font-bold">
          <span className="inline-block w-8 h-px bg-cyan-400" />
          <span>MICROSOFT FLIGHT SIMULATOR EXPERIENCE</span>
        </div>

        <div className="max-w-3xl">
          <h1
            className="font-black leading-[0.85] tracking-tight text-[clamp(60px,13vw,160px)]"
            style={{ textShadow: '0 8px 45px rgba(0,0,0,.6)' }}
          >
            SKY<span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 via-emerald-300 to-amber-200">LINE</span>
          </h1>

          <p className="mt-5 text-base sm:text-xl text-slate-200 max-w-xl leading-relaxed">
            Fly any of <b>{(6613).toLocaleString()}</b> real-world airports — with <b>155 in Indonesia</b> — on satellite-scanned 3D terrain with authentic buildings, oceans, and mountain relief. Experience glass cockpits, PFD avionics, true aerodynamics, and passenger simulation.
          </p>

          <div className="mt-8 flex flex-wrap gap-4">
            <button
              onClick={onStart}
              className="px-8 py-4 rounded-2xl font-black tracking-widest text-slate-950 bg-gradient-to-r from-cyan-300 via-emerald-300 to-amber-200 hover:brightness-110 active:scale-[.98] transition shadow-[0_0_45px_rgba(34,211,238,.45)] flex items-center gap-2"
            >
              <span>🌍 WORLD FLIGHT PLANNER</span>
            </button>
            <button
              onClick={onQuick}
              disabled={!ready}
              className="px-7 py-4 rounded-2xl font-bold tracking-wider bg-white/10 border border-white/20 hover:bg-white/20 backdrop-blur-md disabled:opacity-50 active:scale-[.98] transition shadow-lg"
            >
              ⚡ QUICK FLIGHT
            </button>
          </div>

          <div className="mt-6 flex flex-wrap gap-2 text-xs">
            {(
              [
                ['scores', '🏆 Pilot Logbook'],
                ['settings', '⚙ Settings'],
                ['controls', '⌨ Flight Controls'],
                ['credits', 'ⓘ Aeronautical Data'],
              ] as const
            ).map(([id, l]) => (
              <button
                key={id}
                onClick={() => setModal(id)}
                className="px-4 py-2 rounded-full bg-slate-950/60 border border-white/15 hover:bg-white/15 backdrop-blur-md transition"
              >
                {l}
              </button>
            ))}
            {bestScore > 0 && (
              <span className="px-4 py-2 rounded-full bg-amber-400/20 border border-amber-300/40 text-amber-200 font-bold font-mono">
                Logbook Best: {bestScore.toLocaleString()}
              </span>
            )}
          </div>
        </div>

        <div className="text-[11px] text-slate-400/90 max-w-3xl leading-relaxed">
          Aeronautical Database © OurAirports · Terrain Elevation: AWS DEM Tiles · Satellite Base: Esri World Imagery · Vectors &amp; Buildings: OpenStreetMap &amp; OpenFreeMap · Three.js 3D Engine
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
        <Modal title="Aeronautical Data & Attribution" onClose={() => setModal(null)}>
          <ul className="text-sm text-slate-300 space-y-2.5 list-disc pl-5">
            <li>
              <b>Esri World Imagery</b> — high-resolution global satellite photography base for 3D terrain and moving maps. © Esri, Maxar, Earthstar Geographics.
            </li>
            <li>
              <b>AWS Open Data Terrain Tiles (Terrarium)</b> — global DEM elevation, derived from SRTM, ETOPO1, GMTED and national elevation datasets.
            </li>
            <li>
              <b>OurAirports Worldwide Runway Database</b> — 6,613 airports with authentic runway coordinates, magnetic headings, thresholds, and dimensions.
            </li>
            <li>
              <b>OpenStreetMap &amp; OpenFreeMap vector footprints</b> — real airport terminals, control towers, hangars, highways, and coastlines rendered dynamically in 3D.
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
