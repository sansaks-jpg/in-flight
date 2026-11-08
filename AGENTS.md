# Agent Developer Guide (AGENTS.md)

Welcome to **In-Flight**! This document provides technical conventions, architectural principles, and operational guidelines for AI coding agents and human contributors working on this codebase.

---

## 1. Project Mission & High-Level Architecture

In-Flight is a high-performance, real-time flight simulator running natively in the modern web browser. It combines real-world geospatial data, rigid-body aerodynamic physics, dynamic tile streaming, and realistic avionics into an accessible, responsive web application.

### Key Technology Stack
- **Engine / 3D Graphics**: Three.js (`^0.170.0`)
- **UI & Application State**: React 19 + TypeScript 5.9
- **Styling**: Tailwind CSS v4
- **Build System**: Vite 7 with single-file build options
- **Geospatial Processing**: Mapbox Vector Tile (MVT) parsing, WGS84 geodesic calculations, OpenStreetMap terrain

---

## 2. Architecture & System Boundaries

### A. Separation of Simulation & UI Layers
```
┌────────────────────────────────────────────────────────┐
│                      Browser / DOM                     │
├────────────────────────────┬───────────────────────────┤
│    Simulation Core (3D)    │     React UI Overlay      │
│     (src/sim/game.ts)      │        (src/ui/)          │
├────────────────────────────┼───────────────────────────┤
│ • RAF 60/120 FPS Loop      │ • HUD & Annunciator       │
│ • Rigid-body Physics       │ • Flight Planner & Menus  │
│ • Terrain Tile Streaming   │ • Reactive Settings       │
│ • Web Audio Synthesis      │ • Moving Map (CanvasMap)  │
└────────────────────────────┴───────────────────────────┘
```
1. **Never inject per-frame simulation values into React state**:
   - The simulation loop in `src/sim/game.ts` updates at the display refresh rate (60–144 Hz).
   - Passing raw per-frame telemetry directly to React triggers severe re-render thrashing.
   - Use batched HUD updates (`onHud` throttled callback) or direct Canvas 2D / WebGL rendering.
2. **Deterministic Physics Sub-stepping**:
   - Aerodynamics and ground gear suspension must be evaluated with fixed or clamped delta-time (`dt`) to maintain stability under frame drops.

### B. Mathematical Units & Conventions
Always adhere to these units across the codebase:
- **Internal Simulation Units**:
  - Distance / Coordinates: Meters ($m$)
  - Velocity: Meters per second ($m/s$)
  - Angles / Rotations: Radians ($rad$) internally; degrees ($^\circ$) for user-facing instruments
  - Mass: Kilograms ($kg$)
  - Force: Newtons ($N$)
  - Power: Watts ($W$)
  - Time: Seconds ($s$)
- **Aviation Display Conversions**:
  - Airspeed: $1\text{ Knot (kt)} = 0.514444\text{ m/s}$
  - Altitude: $1\text{ Foot (ft)} = 0.3048\text{ m}$
  - Vertical Speed: Feet per minute ($\text{ft/min} = \text{fpm}$)
  - Heading: $000^\circ - 359^\circ$ clockwise from True North (with magnetic variation compensation where applicable)

### C. Zero-Allocation Render Loop Rule
To prevent garbage collection (GC) micro-stutters:
- **Never allocate new objects** (`new THREE.Vector3()`, `new THREE.Matrix4()`, `new Array()`, object literals) inside `update()`, `stepFlight()`, `render()`, or any per-frame loop.
- Pre-allocate temporary scratch variables at module or class scope (e.g., `tmpV`, `tmpV2`, `tmpQ`, `tmpE`).

---

## 3. Directory Structure & Key Files

| Directory / File | Description |
|---|---|
| `src/sim/game.ts` | Simulation orchestrator: manages the game loop, input handling, camera systems, ATC, and high-level flight states. |
| `src/sim/physics.ts` | Rigid-body flight dynamics, aerodynamic force vectors, lift/drag polars, ground effect, and landing gear physics. |
| `src/sim/autopilot.ts` | Autopilot: auto-takeoff, LNAV leg tracking, VNAV (climb to the plan's cruise level, **3° geometric path descent to the threshold**, FAR 91.117 / Mach-based managed speed), `approachStage()` configuration schedule (CONF 1 at the IAF, gear + CONF 3 at ~5.7 NM, FULL at ~3.5 NM, Vapp+3 at the threshold, never past the placard speeds), automatic speedbrakes, ILS localizer / glideslope capture (descends to meet the beam from above), flare and rollout. Minimum speed is configuration-aware (`minSpeedKt()` = 1.23 × Vs of the current flap setting). |
| `src/sim/lnav.ts` | LNAV/VNAV maths: leg guidance, speed-scaled intercept, fly-by turn anticipation, geometric waypoint sequencing (never targets a fix behind the aircraft), `planDistanceM()` (distance along the route), `PATH_TAN` and `cruiseLevelM()` (cruise level that fits the route + semicircular rule). |
| `src/sim/world.ts` | World composer: assembles terrain, structures, airfield scenery, ground clutter and the clock into the runtime scene (`World`, `Threshold`). |
| `src/sim/mvt.ts` | Zero-dependency Mapbox Vector Tile (.pbf / Protobuf) decoder for streamed building/road vector data. |
| `src/sim/navAssists.ts` | Navigation assists: default checklists, approach gates, taxi ribbon and world screen markers. |
| `src/sim/flightPhase.ts` | Flight-phase state machine (`taxi`, `takeoff`, `climb`, `cruise`, `descent`, `final`, `rollout`). |
| `src/ui/globeTiles.ts` | Planner-globe satellite LOD quadtree: cross-fading tiles, parent fallback, 404-aware (Esri `blankTile=false`), prioritised/cancellable loading, LRU. |
| `src/ui/globeCamera.ts` | Google-Earth-style camera helpers: eased fly-to with pull-back arc, drag inertia, normalised wheel zoom. |
| `src/ui/globeRunways.ts` | True-scale (metres) runway markings for the globe overlay with a metres-per-pixel fade gate. |
| `src/ui/PreGameVisuals.tsx` | Interactive pre-flight globe and planner visuals: `InteractiveEarthGlobe`, runway-end anchors and airport framing helpers. |
| `src/sim/aircraftModel.ts` + `aircraftGeo.ts` | Exterior models, **all procedural** (verified against the code: no `.glb` is imported anywhere; the earlier claim that the exterior may use `src/assets/models/a320.glb` was wrong and, although AGENTS.md used to say they were removed, upstream still tracks them: see §11 — this copy omits them). The product is **A320-only** (`AIRCRAFT` in `specs.ts` is filtered to `sky`); the C172/ATR builders remain only as reference. Body frame +X right, +Y up, -Z forward, CG at origin; wheel contact points come straight from `spec.gear`. |
| `src/sim/cockpit.ts` | **A320 flight deck**: loads the FlightGear A320-family GLB (`public/models/a320/cockpit.glb`, GPL-2.0), merges static geometry per material, animates ~600 switches/knobs/levers/keys about their original axes, replaces screen textures with live canvases, handles pointer/wheel/double-click interaction and the damped camera rig (presets, 1–14x zoom). Falls back to the procedural deck if the GLB cannot be fetched. The stencil mask pass draws only `MASK_LAYER` objects (merged static surfaces + screens), not the ~380 individual knobs/switches. |
| `src/sim/a320/assets.ts` | Flight-deck GLB + manifest loader (meshopt decoder, Cache Storage). **CDN only** (verified): the 50.6 MB GLB comes from a SHA-pinned `raw.githubusercontent.com` URL (with the `github.com/.../raw/` redirect as backup) and the manifest from pinned jsDelivr; there is no local copy and no local-first lookup (the earlier text said otherwise). |
| `src/sim/a320/systems.ts` | Electrics, APU, bleed/packs, pressurisation, hydraulics, fuel, ENG MODE/MASTER start logic, autobrake/ground-spoiler arming, ECAM page selection. `CockpitHost` is the bridge to `Game`. |
| `src/sim/a320/displays.ts` | PFD, ND (ARC/ROSE/PLAN), E/WD, 13 SD pages, MCDU (2 units), ISIS, FCU digit strip and clock renderers. |
| `src/sim/a320/proceduralCockpit.ts` | Old procedural cockpit, kept only as runtime fallback. |
| `src/sim/instruments.ts` | `PanelData` telemetry type shared by the displays (plus the legacy generic instrument painters). |
| `src/sim/clock.ts` | Single real-world (UTC) time source, NOAA solar position, twilight phases and clock formatting. Never use a separate game clock for time of day. |
| `src/sim/magvar.ts` | Magnetic variation from the World Magnetic Model (WMM2025); runway numbers, ILS courses, VOR radials and ATC headings are magnetic. |
| `src/sim/geo.ts` | Geodesy + Web-Mercator helpers: a single `Projection` maps lat/lon <-> world metres, plus unit constants (`M_PER_NM`, `M_PER_FT`, `MS_TO_KT`). |
| `src/sim/liveWeather.ts` | Real-time weather at the aircraft's position: raw ICAO METAR surface wind, QNH, temperature, cloud layers, wind profile and ISA deviation. |
| `src/data/runwayRefine.ts` | Live OpenStreetMap runway survey upgrade (cached) for airports with approximate runways. |
| `src/sim/specs.ts` | Aircraft performance data, engine configurations, aerodynamic coefficients, and weight balance profiles. |
| `src/sim/storage.ts` | localStorage persistence for settings, score records and the last route; defines the `QualityPreset` type. |
| `src/sim/quality.ts` | Graphics quality presets (`low`, `medium`, `high`, `ultra`) with per-preset render budgets and `resolveAutoQuality()` (mobile devices are handled via an `isMobile` flag, not a preset). |
| `src/sim/terrain.ts` | Terrain elevation sampling, heightmaps and the LOD-ring tile streamer. Residency is by position only; `progress()` covers every ring. Tiles are fetched and built **coarsest ring first**, fine tiles stay hidden until their imagery is applied, ring bookkeeping runs at most 4x/s (see §11), and ring layering uses a depth-resolution-scaled vertex bias instead of `polygonOffset`. |
| `src/sim/tiles.ts` | Tile sources (Esri imagery, elevation, overlays) and the shared prioritised/cancellable image loader + cache. Streaming *residency* lives in `terrain.ts` / `structures.ts` and is position-based (see §9). |
| `src/sim/structures.ts`| Procedural urban generation, building extrusions, runway markings, and approach lights. |
| `src/sim/airportGround.ts` | Airport ground planning shared by the 3D scenery, spawn logic, tree/building scatterer and mini map. |
| `src/sim/airfieldMesh.ts` | 3D airfield ground layout from surveyed OpenStreetMap data: taxiways, aprons, stand/hold-short markers, helipads, hangar and terminal footprints. |
| `src/sim/airfield.ts` | Ground-movement logic on the surveyed airfield layout: start positions (gates, stands, aprons, hangars) and `taxiRoute`. |
| `src/sim/departure.ts` | Spawn placement: parked at the designated stand, clear of buildings, runways and jet bridges. |
| `src/sim/effects.ts` | Pooled GPU-point particle effects: sparks, smoke, fire, dust and tyre smoke. |
| `src/sim/precip.ts` | Rain / snow streaks around the camera, advected by the real relative airflow. |
| `src/sim/clouds.ts` | Legacy cloud field fallback. |
| `src/sim/cloudLayers.ts` | Cloud layer planning: converts live METAR/model weather into 4 MSL altitude slabs (low, mid, high, CB storm column) for volumetric ray-marching. |
| `src/sim/volumetricClouds.ts` | Fly-through volumetric ray-marched clouds with scene depth buffer intersection, three-octave (Wrenninge) multiple scattering, domed cumulus cells, empty-space skipping and a 5-tap composite filter, plus IMC white-out. Step budget comes from `QualityProfile.cloudSteps` (NOT `clouds`, which is the legacy billboard capacity capped at 48 by `weather-test`). See §11. |
| `src/sim/lightning.ts` | Cloud-to-ground lightning for thunderstorm conditions: billboarded bolt ribbons, a dedicated flash light, and an `onStrike` hook wired to procedural thunder in `audio.ts`. |
| `src/sim/loadState.ts` | Observable load-stage store (`dispatch → scenery → deck → weather → terrain → warm → done`, flight-deck GLB byte progress, GPU warm-up progress, error). |
| `src/sim/warmup.ts` | Loading-screen GPU warm-up helpers: `forceDrawAll`, `collectTextures`, `uploadTextures`, `nextFrame` (used by `Game.prewarm`). |
| `src/ui/Loaders.tsx` + `loaders.css` | Loading screens: `BootLoader` (first visit/reload) and `FlightLoader` (real-progress opaque loader from FLY click to ready). |
| `src/ui/A320Plan.tsx` | True-scale plan-view A320-200 SVG for the loaders with progressive fill progress. |
| `src/sim/audio.ts` | Web Audio API procedural synthesis (engines, slipstream, rolling, warnings tones, one-shots, thunder). `halt()` suspends the AudioContext for a pause and refuses every one-shot; `silence()` additionally forgets queued speech. Speech itself is NOT produced here any more: `speak()` is a thin adapter onto the shared `VoiceBus` (`audio.voice`). |
| `src/sim/atc.ts` | Fully automatic ATC <-> pilot radio: per-flight generated callsigns, ICAO/FAA phraseology by airfield country, weather-aware remarks, non-towered "Information/Traffic" fields, background-traffic chatter matched to the flight phase. `AtcRadio` only *sequences* exchanges (pilot call -> controller -> readback) and hands each line to the `VoiceBus`; it no longer touches `speechSynthesis`. |
| `src/sim/speech.ts` | **`VoiceBus`** — the single owner of every spoken line (ATC, pilot readbacks, crew callouts, cabin PA, GPWS) plus the `WebSpeechDriver`: priorities (chatter 0 / ATC+PA+crew 1 / callouts 2 / warnings 3), preemption with replay, flight-clock TTLs, sterile-phase holds, captions + transcript log hooks, timed silent fallback. See section 7. |
| `src/sim/comms.ts` | **`CommsDirector`**: state-aware flight-deck and cabin voice driven by a per-frame `CommsSnap` — session-start briefing, A320 PM callouts (THRUST SET / 100 / V1 / ROTATE / POSITIVE RATE / GEAR UP), flap and gear call-backs read from the real handle state, 10,000 ft calls, stabilised-approach gates (1,000 / 500 ft), landing-roll calls (spoilers / reverse / decel / 70 kt), cabin PAs, idle nudges. Every cue carries a hand-written Indonesian transcript. |
| `src/sim/translate.ts` | Rule-based EN -> ID transcript translation for the closed ATC phraseology (`translateId`, `transcriptText`). Only the transcript is translated; speech stays English. |
| `src/ui/Transcript.tsx` + `transcript.css` | `LiveTranscript` (flight-strip style lower third with speaker code, channel, progress hairline, optional EN original under the ID text), `TranscriptEntry` (history rows), `TranscriptLangSwitch` (OFF / EN / ID). |
| `src/sim/a320/cockpitRender.ts` | Cockpit render-quality helpers: mip-mapped alpha test scaling (`MIP_ALPHA_BOOST`), analytic anti-aliased edge, `alphaToCoverage` when MSAA is available, trilinear + max-anisotropy filtering, and canvas screen supersampling. |
| `src/ui/CanvasMap.ts` | High-performance 2D HTML Canvas navigation moving map. |
| `src/ui/FlightMap.tsx` | React navigation maps: `NavigationMap`, `MiniMap` and `FullMap`. |
| `src/ui/MapPanel.tsx` | Planner navigation map panel sharing the `NavigationMapView` state. |
| `src/ui/AirportMiniMap.tsx` | Dedicated airport/runway navigation display: airport diagram on the ground; airborne a full en-route chart (flight-plan polyline, waypoints, nearby airports/NAVAIDs, graticule, magnetic compass rose with heading/track/AP bugs, minute markers, wind arrow). |
| `src/ui/mapLayers.ts` | Persisted 2D-map layer preferences (base style + overlays). |
| `src/ui/navigation.ts` | Single HUD/navigation display-mode order shared by the keyboard, gamepad and display menu. |
| src/ui/Hud.tsx | Re-exports the flight HUD and holds the pre-flight **briefing** (`ReadyScreen`), the **pause screen** (`PauseMenu`: status, flight snapshot, resume, settings / controls / logbook tiles, confirm-guarded restart & abort) and the result screen. |
| src/ui/kit.cssKit.tsx | **In-game UI kit** — the one design language for every pause / settings / reference surface: tokens (`--if-*`), `Dialog` (focus trap, owns Esc), `Button`, `Section`/`Row`, `Switch`, `Segmented`, `Slider`, `Select`. New in-game surfaces must be built from these, not from ad-hoc Tailwind colours. |
| src/ui/SettingsPanels.tsx | `Modal` (thin `Dialog` wrapper used by menu and pause), categorised `SettingsPanel` (Graphics · Audio & voice · Flight & controls · Interface · Captions, with a live caption preview), `ControlsPanel` (grouped key map) and `ScoresPanel` (logbook). `Screens.tsx` re-exports them. |
| `src/ui/FlightHud.tsx` | In-flight glass HUD component (re-exported by `Hud.tsx`). |
| `src/ui/FlightInstruments.tsx` | React flight instruments: `PrimaryFlightDisplay` and `TouchControls`. |
| `src/ui/MsfsWindows.tsx` | Floating in-flight tool windows (ATC, camera, checklist, weather, EFB, systems) plus overlays: world markers, cockpit tooltips, freelook reticle. |
| `src/ui/Screens.tsx` | Start screen and menu panels: settings, controls, scores and modals. |
| `src/ui/flightWorkspace.ts` | In-flight tool-window reducer; HUD display modes never change the user's open tool. |
| `src/ui/flightDispatch.ts` | Menu content and globe maths: repo facts, menu bento tiles, aircraft studio images, lat/lon -> globe camera helpers. |
| `src/ui/Planner.tsx` | Pre-flight route planner and airport database search interface. |
| `src/data/airports.ts` | Pre-indexed airport database with 8,400+ real-world airfields and runway specifications. |
| `src/data/airports.json` | Generated airport database: 8,413 real-world airfields — the source of the "8,400+" figure. |
| `src/data/frequencies.json` | Airport radio frequencies, exposed through `frequenciesFor()` in `airports.ts`. |
| `src/data/navaids.json` | Navigation-aid table (ident, name, type, frequency, lat/lon) used by the moving map. |
| `src/data/airfields-id.json` | Generated Indonesian airfield ground layouts (taxiways, aprons, hangars, terminals, stands) — output of `scripts/build-indonesia-data.mjs`. |
| `src/data/airport-aliases.json` | Airport code alias map (local/legacy idents mapped to ICAO). |
| `src/App.tsx` | Root React component: composes the simulation core with the UI overlay — start screen, planner globe, in-flight HUD, menus and results. |
| `src/main.tsx` | DOM entry point: mounts `<App />` under React StrictMode. |
| `scripts/weather-test.ts` | `node:test` atmosphere regression suite (part of `npm test`): cloud field, lightning, precipitation budgets and weather-derived visibility — runs headless, no WebGL. |
| `scripts/scale-terrain-test.ts` | `node:test` scale verification suite (part of `npm test`): GLB model dimensions vs `specs.ts`, gear contact / AGL consistency, camera far-plane / terrain LOD / fog coverage. |

---

## 4. Development & Verification Workflows

### Available Commands
- **Start Dev Server**:
  ```bash
  npm run dev
  ```
- **Typecheck & Production Build** (`npm run typecheck` / `npm run lint` run `tsc --noEmit` alone; the build typechecks first):
  ```bash
  npm run build
  npm run typecheck
  ```
- **Preview Production Build**:
  ```bash
  npm run preview
  ```
- **Run Test Suite** (`node:test` — about 90 test blocks across eleven suites; the exact executed count can differ slightly when a runner expands subtests):
  ```bash
  npm test
  ```
  Suites: `scripts/autopilot-test.ts`, `scripts/globe-tiles-test.ts`, `scripts/navigation-test.ts`, `scripts/runtime-test.ts`, `scripts/dispatch-test.ts`, `scripts/clock-test.ts`, `scripts/runway-data-test.ts`, `scripts/weather-test.ts`, `scripts/scale-terrain-test.ts`, `scripts/atc-test.ts`, `scripts/voice-test.ts`.
- **Run Secondary Test Scripts** (outside the main `npm test` suite):
  ```bash
  npm run test:ui
  npm run test:live
  ```
  `test:ui` runs `scripts/ui-collision-test.ts`; `test:live` runs `scripts/live-navigation-test.ts`.
- **Run Physics / Autopilot Evaluation Scripts** (manual console-output checks, not part of `npm test`):
  ```bash
  npx tsx scripts/phys-test.ts
  npx tsx scripts/ap-test.ts
  ```
  `phys-test.ts` checks take-off performance against published POH figures (ISA, sea level, no wind); `ap-test.ts` flies an autopilot ILS approach for each aircraft type. Similar manual evaluation scripts: `land-test.ts`, `spawn-test.ts`, `minimap-enroute-check.ts` (run `npx tsx scripts/minimap-enroute-check.ts` to sanity-check the mini-map's en-route chart maths).
- **Run Airport / Data Generation Scripts**:
  ```bash
  node scripts/build-airports.mjs
  node scripts/build-indonesia-data.mjs
  node scripts/build-world-runways.mjs
  node scripts/compress-tree.mjs
  ```

---

## 5. Coding & Contribution Rules

1. **Strict Code-First Disagreement Principle**:
   - If project documentation and the existing working code disagree, **always follow the conventions used in the existing code**, and explicitly note the discrepancy in your final report.
2. **Preserve Documentation & Comments**:
   - Preserve existing code comments and docstrings. Do not wipe out architectural rationale or mathematical annotations unless you are explicitly refactoring that system.
3. **TypeScript Quality**:
   - Always run `npm run build` to verify type safety and build integrity before submitting changes.
   - Do not bypass type errors using untyped `@ts-ignore` without rigorous justification.
4. **Performance & Quality Presets**:
   - Ensure changes respect the quality presets (`ultra`, `high`, `medium`, `low`) defined in `src/sim/quality.ts` — the `QualityPreset` type lives in `src/sim/storage.ts`. There is no `mobile` preset: mobile devices are handled through the `isMobile` flag in `resolveAutoQuality()` / `qualityProfile()`. Keep draw calls and geometry count within the defined budgets.
5. **Asset Storage & CDN Rules**:
   - **Do NOT bundle or commit heavy binary assets** (e.g. 3D GLB/GLTF models, large textures, binary datasets) directly into the repository files.
   - All external 3D models and heavy assets must be loaded via **runtime auto-fetch from a permanent, reliable public URL/CDN** (e.g. pinned jsDelivr, GitHub releases, or Hugging Face CDN mirrors) with automated fallback (such as procedural geometry).
   - Enforcement: `*.glb` / `*.gltf` are in `.gitignore`. Previously the three exterior GLBs (`a320`, `atr72`, `c172`, 4.2 MB) were committed twice (`src/assets/models/` and the generated `public/src/assets/models/`) although nothing imported them; upstream still tracks them (§11), this copy does not. Menu photos load from the pinned jsDelivr CDN (`flightDispatch.ts`), so `src/assets/images` is not needed either.
   - Never alter `package.json` project name or delete root build scripts. Keep all dependencies and build configs aligned with Cloudflare Pages requirements.


---

## 6. A320 cockpit conventions (added)

- Model frame: -X forward, +Y up, +Z captain side. `Cockpit.group` rotates it by -90° about Y into the body frame; the captain eye point `EYE_M` is registered to `spec.eye`.
- Part names in the GLB are the control IDs (`APUStartBtn`, `FlapsLever`, `thr_l_body`, `spd-sel`, ...). Legend nodes `<btn>1F/2O/1A` are lit by emissive; `*_led`/`*_on` nodes are hidden unless lit (see `ledOn`).
- New physics controls: `thrOffset`, `autobrake`, `spoilersArmed`, `rudTrim`; jets use an A320 normal-law FBW block (load-factor demand, auto-trim, pitch/bank/alpha/high-speed protections), detent tables for flap lift/drag, and rudder trim aerodynamics.
- Overhead systems: latching push-buttons (`ovh`, `mom`), guarded switches (`GUARD_OF`) with pass-through interaction, engine and APU fire shut-off valves and extinguisher agent SQUIB discharge, ELT switch, and live 7-segment green battery voltage displays (`batt_voltage.canvas`).
- Pedestal & navigation controls: rudder trim knob with reset push-button (`RudderTrim`, `RudderTrimReset`), Radio Management Panels (`rmp`) with active/standby frequency exchange, Audio Control Panels (`acp`), MCDU BRT/DIM display brightness stepping and SEC F-PLN page.
- EFB tablet integration: spring-damper physical bezel buttons with auto-repeat for BRT/DIM, hover button feedback, and real-time cursor click state refresh.
- Discrepancies found while verifying this file against the code: the earlier text claimed "no imported 3D meshes" and listed three aircraft; the code ships GLBs and (now) a single A320.
- Asset provenance and licence: `public/models/a320/NOTICE.txt`. Do not edit the GLB by hand; re-run gltf-transform (webp -> meshopt) on the pinned upstream file if it must be regenerated.
- Cockpit rendering & camera clipping: the *deck* camera uses near 0.05 m / far 40 m (the *world* camera behind the windows has a dynamic near plane, see §11); `tuneCockpitMaterials` applies `MIP_ALPHA_BOOST` (0.30) to prevent stroke thinning under wide FOV; `SCREEN_SUPERSAMPLE` (1.4) keeps dynamic displays sharp.

---

## 7. Voice, audio & transcripts (added)

**One speaker, one queue.** Every spoken line goes through `VoiceBus` (`src/sim/speech.ts`, instance `audio.voice`). Nothing else may call `speechSynthesis.speak/cancel/pause/resume`. Producers: `AtcRadio` (ATC + pilot readbacks + background traffic), `CommsDirector` (crew, PA, nudges), `Game.pa()` / `audio.speak()` (captain PA, GPWS, RA callouts).

**Pause / menu / hidden tab.** `Game.syncVoice()` is the only gate (`voiceMayRun()`): the bus runs while playing (and on the results screen for the closing PA). Leaving that state cancels the active utterance and *replays it from its start* on release — `speechSynthesis.pause()` is never used (unreliable in Chrome with network voices, unsupported on Android). Callouts and warnings are dropped across a pause; TTLs run on a flight clock that stands still while paused. `audio.halt()` additionally suspends the `AudioContext` and refuses one-shots.

**Browser quirks the driver handles** (each verified against published reports — Chromium issues 509488 / 521666, MDN, Web Speech API compatibility notes): utterances are kept referenced until they end (GC bug); `speak()` is delayed >= 90 ms after `cancel()` (Chrome drops same-tick speech); text is split per sentence (~15 s cut-off); a 3.2 s no-`start` watchdog and an `ms*2.4+3.5 s` no-`end` watchdog turn a silent engine into a timed, silent transcript so queues and gameplay triggers never stall; after 3 consecutive failures TTS is skipped for 25 s.

**Priorities.** 3 warnings (GPWS) > 2 callouts (PM, RA) > 1 ATC / PA / crew talk > 0 background chatter. A higher priority cuts a lower one, which is replayed (max twice). `holdWhenSterile` lines (PA, nudges, chatter) wait while `bus.sterile` is true (take-off roll, below 1,500 ft AGL, landing roll — cf. 14 CFR 121.542). ATC is never held.

**Adding a cue.** Add it to `CommsDirector` as a function of `CommsSnap` (fill the field in `Game.fillCommsSnap`, allocation-free), pass EN text, Indonesian text and optionally `speech` (spelled-out form for TTS). Cues read real state (flap handle, spoilers armed, gear, speed) — never a bare timer. Verify phraseology against Airbus SOP material before adding callouts.

**Transcripts.** `hud.atcLive` is the line on air, `hud.atcLog` the history (GPWS words / RA callouts are live-only). Settings: `transcripts` (on) and `transcriptLang` (`en` default / `id`). Indonesian = `AtcMessage.textId` when the line has one, otherwise `translateId(text)`. The audio is never translated (ICAO: English on the frequency).

---

## 8. Loading screens & Volumetric Atmosphere (added)

- **Two entry points, one look.** `index.html` paints a static `#boot-splash` before any JavaScript is parsed (the single-file bundle is ~4 MB); `BootLoader` removes it (cross-fade) after its own first paint. `FlightLoader` is shown when `launching || (screen === 'flight' && phase === 'loading')`. `launching` bridges the gap between pressing FLY and `Game.load()` (the OpenStreetMap runway survey in `startFlight` can take seconds) – never remove it, or the menu freezes visibly.
- **Opaque on purpose.** The loader sits at `z-index: 60`, above the HUD/ready screen, and is fully opaque: the old 90 %-opaque blurred overlay let half-built terrain and tile pop-in show through. It stays mounted for the fade-out so the hand-over to the Ready screen is never a hard cut.
- **Progress is real.** `flightTarget()` maps `loadState` to bands (survey + scenery 0–12 %, flight deck 12–60 % from streamed bytes, weather 60–68 %, terrain + city streaming 68–88 % from `min(Terrain.progress(), Structures.progress())`, GPU warm-up 88–99 % from `loadState.warm`); `useSmoothed()` eases towards it and never moves backwards.
- **Globe gate.** `InteractiveEarthGlobe` has an `onLoadProgress` prop: it reports the 16 level-2 Esri tiles settling (loaded *or* failed) and reaches exactly 1 only after the painted texture was uploaded and a frame was rendered.
- **Volumetric Clouds.** `volumetricClouds.ts` replaces the 2D billboards with full-screen ray-marching against the scene depth buffer. `cloudLayers.ts` groups live weather into 4 MSL altitude slabs. Allows realistic flight inside IMC clouds.
- **DEM Retry & Coastlines.** Missing elevation tiles are retried with back-off and sample from coarser tiles in the interim. Coastal airport 3.7 km boundaries blend smoothly into the sea.

---

## 9. Streaming residency & GPU warm-up (added)

**Rule 1 – residency never depends on the camera.** `Terrain.update` and `Structures.update` request every tile of their rings around the *aircraft*, in every direction. They used to request outer rings only inside the view frustum (and shrank the 360° core to 40 % in the flight deck, evicting out-of-view tiles after 25 s), so imagery and meshes were fetched and rebuilt whenever the pilot turned their head, and the loading screen (which orbits the aircraft from outside) could not pre-load what the cockpit camera sees. Drawing is still culled per mesh by three.js (`frustumCulled`). Do not re-introduce a frustum/look-direction input to any loader. Tiles that leave a ring are kept for 6 s (border jitter) before disposal.

**Rule 2 – nothing is created lazily after the loading screen.** `Game.loop` (phase `loading`) first waits for `Terrain.progress()` and `Structures.progress()` (all rings, real MVT geometry, finished tree scatter), then runs `Game.prewarm()` (stage `warm`, play mode only; the attract background skips it):
1. `renderer.compileAsync` for the world and the flight-deck scene (walks hidden objects too);
2. `uploadTextures` – every texture of both scenes, two per frame (the deck alone is ~344 MB of mip-mapped RGBA: three 4096², several 2048² PNGs);
3. one real draw of everything through each frame path (`drawFrame('mask' | 'clouds' | 'plain')`) with `forceDrawAll` (visible, never culled; lights untouched because they change the shader variant), `gl.finish()`, flags restored before every yield. `VolumetricClouds.warm` also builds the CPU 3D noise volume and, for a clear sky, frees the large render targets again.
Anything new added to `world.scene` / the cockpit scene before `load()` finishes is covered automatically. A new *render path* (another way `render()` can draw a frame) must be added to `prewarm()`. A hard 30 s cap guarantees the game never hangs on the loader.

**Verification (measured, headless Chromium + SwiftShader):** after the loader finished, looking forward / left / right / up / down / back created **0** new programs, textures or geometries (`renderer.info`), versus lazy creation on first sight before.

**Known limits.** Streaming further along the route as the aircraft flies is inherent (the world is 8,400 airports): ring *changes* still fetch new tiles, but always ahead of the aircraft in all directions, never as a function of view direction. GPU timing cannot be measured in the sandbox (software GL), so the frame-time gains of the mask-pass change are reasoned from draw-call counts (deck pass: ~417 calls / ~383k triangles; the mask pass now draws roughly the merged static meshes + screens instead of all of them).

---

## 10. In-game UI conventions (added)

- **One language.** `kit.css` extends the flight-HUD palette (slate glass, a single sky accent `#9acbeb`, hairline borders, radii 6/10/14). Amber = caution/attention, red = warning/destructive, green = normal — the A320 ECAM colour convention. No second accent colour, no glow.
- **Top bar auto-hide + pin.** The flight header (route, phase, mute, pause) and the tool bar share one visibility state in `FlightHud.tsx` (`barShown`): visible on entering flight, when the pointer reaches the top 85 px, on keyboard focus, while a tool panel is open; otherwise it hides after ~6.5 s. The pin button in the tool bar persists `settings.uiPinned` (also in Settings > Interface). Hidden bars are `inert`. The bottom cockpit FOCUS bar is intentionally untouched.
- **Cockpit hover badge** (`CockpitTooltipOverlay`, `.cp-tip`). `Game.cockpitTooltip` is the source of truth. The hover raycast is rate-limited but **always evaluates the last pointer position** (trailing timer — dropping it left the badge stuck), and the badge is cleared when the pointer is not over the canvas (HUD / window edge / blur), on touch release, on drag, on view change and on every phase change. The overlay hides itself on the same signals. Never set `cockpitTooltip` without going through `clearHover()` / `evalHover()`.
- **Captions** (`transcript.css`) are film-subtitle style: no panel, light type with a layered dark edge and a feathered radial shade; speaker line above in small caps. Width is capped (`100vw - 704px`) so the line never collides with the toast stack at the lower left.
- **Verification.** Keep visual checks out of the repo (no screenshot folders or one-off test scripts); compare cockpit-facing labels with the real panels (e.g. EFIS control panel buttons CSTR / WPT / VOR.D / NDB / ARPT, FCU, ECAM, MCDU, OVHD, PED).


---

## 11. Rendering stability: depth, terrain rings, clouds (added)

**Verified discrepancy (upstream repo vs. this file).** §5 says the exterior GLBs "were removed", but upstream `sansaks-jpg/in-flight` still *tracks* `src/assets/models/*.glb`, `public/src/assets/models/*.glb`, `src/assets/tree_oak.glb`, ~25 MB of PNGs in `public/assets/aistudio/`, `src/assets/images/*.jpg`, screenshots and a `.aistudio/` artefact folder, and a 365 KB `cockpit-manifest.json` (despite `*.glb` being in `.gitignore`). None of it is imported (`grep` for `.glb` / `assets/models` finds only `a320/assets.ts`, which uses the pinned CDN). This working copy therefore **omits all of them**; the flight deck GLB (50.6 MB) and its manifest are fetched at runtime from the pinned CDN URLs in `src/sim/a320/assets.ts` (HTTP 200 verified), menu photos come from the pinned jsDelivr URL / `embeddedImages.ts`. Only the licence texts in `public/models/a320/` are kept. This working copy's `package.json` build script is plain `vite build`; run `npx tsc --noEmit` (or `npm run typecheck` upstream) before it.

**Depth precision (the cause of most "glitchy 3D objects").** Depth resolution at distance *d* is `d² / (near · 2²⁴)`. The old world camera used near 0.1–1.5 m with far 180–350 km: ~15 m of depth step at 5 km, so terrain rings, runway paint, trees, roofs and wing panels z-fought. `Game.updateCamera` now sets the world camera's near plane from height above ground (`≈ agl · 0.12`, clamped 0.5–40 m, further capped by the chase/spotter distance) and passes it to `Terrain.setDepthNear`. Never put a constant tiny near plane back. Co-planar decals (e.g. aircraft control-surface panels in `aircraftModel.ts`) must carry a `polygonOffset`.

**Terrain rings.**
1. *Coarsest first.* `prioOf()` orders imagery/DEM fetches and `update()` builds meshes coarse → fine. Fine tiles used to arrive first, leaving voids with exposed skirt walls beyond them until the coarse rings caught up.
2. *No flat fine tiles.* A tile above the two coarsest rings stays `visible = false` until its imagery is applied (12 s grace if imagery never arrives). `ringReady` / the hole uniforms also require imagery.
3. *Layering.* Coarse rings are lowered in the vertex shader by `lod · (1 + 4·d²/(near·2²⁴))` metres (`uLodBias`, `uDepthRes`), i.e. by the depth buffer's own resolution at that distance; `polygonOffset` (a fixed number of depth units) cannot do that and produced rippled z-fight bands on flat coasts. The static mesh `drop` is capped at 3 m so ring borders do not become cliffs.
4. *CPU.* The ring/hole bookkeeping (string keys, Set/Map walks) is throttled to a tile-border crossing, a finished build or 4 Hz (it cost ~2.6 ms per frame); mesh builds are time-budgeted (>= 1 per frame, <= 3 ms).

**Clouds (`volumetricClouds.ts`, `cloudLayers.ts`).** Low deck = separate cumulus cells with a low-frequency per-cloud height, a rounded (`sqrt`) edge profile and flat bases, billow + domain-warped erosion, 5 sun taps with three scattering octaves, powder term, sky-lit tops / ground-bounce bases. Marching uses big strides in empty space and steps back + fine steps at first contact (no banding). Extinction is deliberately soft (`EXT`) and the composite pass filters the half-resolution cloud buffer with 5 taps to remove the per-pixel jitter pattern. Cumulus depth is `550 + 1150·cover` m (flattening to ~stratocumulus near overcast). Per-quality cost knobs: `QualityProfile.cloudSteps` and the `SCALE` table (cloud buffer resolution, 0.5–0.85 of the back buffer). Test visually from below, beside and above a deck (`Game.setSkyPreview({ weather: 'scattered' | 'broken' | 'overcast', hour })`), not only headless.

**Verification notes.** Headless SwiftShader renders ~1–3 fps, so ring streaming is far slower than on a real GPU and *cannot* measure frame time; use it for correctness (glitches, shapes, shading) and draw-call / CPU-per-subsystem counts only. Keep scratch harnesses outside the repository — do not add one-off screenshot scripts to `scripts/`.
