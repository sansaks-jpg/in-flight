import { useState } from 'react';
import { Settings, loadScores } from '../sim/storage';
import { FlightIcon } from './FlightIcon';
import { InteractiveEarthGlobe, MsfsTopRightBar } from './PreGameVisuals';
import { MENU_BENTO_TILES, REPO_FACTS } from './flightDispatch';
import { ControlsPanel, Modal, ScoresPanel, SettingsPanel } from './SettingsPanels';

export { ControlsPanel, Modal, ScoresPanel, SettingsPanel };

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
        <Modal title="Pilot logbook" onClose={() => setModal(null)}>
          <ScoresPanel />
        </Modal>
      )}
      {modal === 'settings' && (
        <Modal title="Settings" onClose={() => setModal(null)}>
          <SettingsPanel s={settings} set={set} />
        </Modal>
      )}
      {modal === 'controls' && (
        <Modal title="Flight controls" wide onClose={() => setModal(null)}>
          <ControlsPanel />
        </Modal>
      )}
      {modal === 'credits' && (
        <Modal title="Release notes" onClose={() => setModal(null)}>
          <ul className="text-sm text-slate-300 space-y-2.5 list-disc pl-5">
            <li>
              <b>Esri World Imagery</b> — high-resolution global satellite photography base for 3D terrain and moving maps.
            </li>
            <li>
              <b>AWS Open Data Terrain Tiles (Terrarium)</b> — global DEM elevation heightmaps derived from SRTM, ETOPO1, and GMTED datasets.
            </li>
            <li>
              <b>OurAirports + OpenStreetMap</b> — {REPO_FACTS.totalAirports.toLocaleString()} airfields, {REPO_FACTS.indonesiaAirports} in Indonesia (every mapped runway incl. grass/gravel strips) with surveyed centrelines, surfaces, displaced thresholds and taxiway/apron/stand layouts for {REPO_FACTS.indonesiaWithLayout}. Headings are magnetic (WMM2025).
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

