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
| `src/sim/autopilot.ts` | Autopilot PID controllers for HDG, ALT, VS, LNAV waypoint sequencing, and ILS glideslope / localizer tracking. |
| `src/sim/lnav.ts` | LNAV maths: leg guidance, speed-scaled intercept, fly-by turn anticipation and geometric waypoint sequencing (never targets a fix behind the aircraft). |
| `src/sim/world.ts` | World composer: assembles terrain, structures, airfield scenery, ground clutter and the clock into the runtime scene (`World`, `Threshold`). |
| `src/sim/mvt.ts` | Zero-dependency Mapbox Vector Tile (.pbf / Protobuf) decoder for streamed building/road vector data. |
| `src/sim/navAssists.ts` | Navigation assists: default checklists, approach gates, taxi ribbon and world screen markers. |
| `src/sim/flightPhase.ts` | Flight-phase state machine (`taxi`, `takeoff`, `climb`, `cruise`, `descent`, `final`, `rollout`). |
| `src/ui/globeTiles.ts` | Planner-globe satellite LOD quadtree: cross-fading tiles, parent fallback, 404-aware (Esri `blankTile=false`), prioritised/cancellable loading, LRU. |
| `src/ui/globeCamera.ts` | Google-Earth-style camera helpers: eased fly-to with pull-back arc, drag inertia, normalised wheel zoom. |
| `src/ui/globeRunways.ts` | True-scale (metres) runway markings for the globe overlay with a metres-per-pixel fade gate. |
| `src/ui/PreGameVisuals.tsx` | Interactive pre-flight globe and planner visuals: `InteractiveEarthGlobe`, runway-end anchors and airport framing helpers. |
| `src/sim/aircraftModel.ts` + `aircraftGeo.ts` | Original procedural exterior models (lofted fuselage, airfoil wings, hinged control surfaces, props, gear) built 1:1 from `specs.ts`; no imported 3D meshes. Body frame +X right, +Y up, -Z forward, CG at origin; wheel contact points come straight from `spec.gear`. |
| `src/sim/cockpit.ts` | 3D interactive cockpit models, analog gauges, interactive throttle/stick, PFD and MFD displays. |
| `src/sim/instruments.ts` | Canvas-drawn flight instruments used as textures inside the 3D cockpit. |
| `src/sim/clock.ts` | Single real-world (UTC) time source, NOAA solar position, twilight phases and clock formatting. Never use a separate game clock for time of day. |
| `src/sim/magvar.ts` | Magnetic variation from the World Magnetic Model (WMM2025); runway numbers, ILS courses, VOR radials and ATC headings are magnetic. |
| `src/sim/geo.ts` | Geodesy + Web-Mercator helpers: a single `Projection` maps lat/lon <-> world metres, plus unit constants (`M_PER_NM`, `M_PER_FT`, `MS_TO_KT`). |
| `src/sim/liveWeather.ts` | Real-time weather at the aircraft's position: raw ICAO METAR surface wind, QNH, temperature, cloud layers, wind profile and ISA deviation. |
| `src/data/runwayRefine.ts` | Live OpenStreetMap runway survey upgrade (cached) for airports with approximate runways. |
| `src/sim/specs.ts` | Aircraft performance data, engine configurations, aerodynamic coefficients, and weight balance profiles. |
| `src/sim/storage.ts` | localStorage persistence for settings, score records and the last route; defines the `QualityPreset` type. |
| `src/sim/quality.ts` | Graphics quality presets (`low`, `medium`, `high`, `ultra`) with per-preset render budgets and `resolveAutoQuality()` (mobile devices are handled via an `isMobile` flag, not a preset). |
| `src/sim/terrain.ts` | Procedural and vector terrain elevation sampling, heightmaps, and terrain meshes. |
| `src/sim/tiles.ts` | Tile streaming logic, LOD management, and bounding frustum culling. |
| `src/sim/structures.ts`| Procedural urban generation, building extrusions, runway markings, and approach lights. |
| `src/sim/airportGround.ts` | Airport ground planning shared by the 3D scenery, spawn logic, tree/building scatterer and mini map. |
| `src/sim/airfieldMesh.ts` | 3D airfield ground layout from surveyed OpenStreetMap data: taxiways, aprons, stand/hold-short markers, helipads, hangar and terminal footprints. |
| `src/sim/airfield.ts` | Ground-movement logic on the surveyed airfield layout: start positions (gates, stands, aprons, hangars) and `taxiRoute`. |
| `src/sim/departure.ts` | Spawn placement: parked at the designated stand, clear of buildings, runways and jet bridges. |
| `src/sim/effects.ts` | Pooled GPU-point particle effects: sparks, smoke, fire, dust and tyre smoke. |
| `src/sim/precip.ts` | Rain / snow streaks around the camera, advected by the real relative airflow. |
| `src/sim/clouds.ts` | Live-weather cloud field: three live-data-driven instanced layers (low = METAR ceiling, mid/cirrus = Open-Meteo geopotential bases) in a single draw call, advected by the live wind on the sim clock. |
| `src/sim/lightning.ts` | Cloud-to-ground lightning for thunderstorm conditions: billboarded bolt ribbons, a dedicated flash light, and an `onStrike` hook wired to procedural thunder in `audio.ts`. |
| `src/sim/audio.ts` | Web Audio API procedural synthesis for engines, slipstream wind noise, gear rattles, and GPWS callouts. |
| `src/sim/atc.ts` | Fully automatic ATC <-> pilot radio: per-flight generated callsigns, ICAO/FAA phraseology by airfield country, weather-aware remarks, non-towered "Information/Traffic" fields, background-traffic chatter matched to the flight phase, and the `AtcRadio` channel that transmits only while a flight is actually running (`Game.radioMayTransmit`). |
| `src/sim/speech.ts` | Speech synthesis queue (`SpeechQueue`) for warnings, callouts and ATC announcements. |
| `src/ui/CanvasMap.ts` | High-performance 2D HTML Canvas navigation moving map. |
| `src/ui/FlightMap.tsx` | React navigation maps: `NavigationMap`, `MiniMap` and `FullMap`. |
| `src/ui/MapPanel.tsx` | Planner navigation map panel sharing the `NavigationMapView` state. |
| `src/ui/AirportMiniMap.tsx` | Dedicated airport/runway navigation display: airport diagram on the ground; airborne a full en-route chart (flight-plan polyline, waypoints, nearby airports/NAVAIDs, graticule, magnetic compass rose with heading/track/AP bugs, minute markers, wind arrow). |
| `src/ui/mapLayers.ts` | Persisted 2D-map layer preferences (base style + overlays). |
| `src/ui/navigation.ts` | Single HUD/navigation display-mode order shared by the keyboard, gamepad and display menu. |
| `src/ui/Hud.tsx` | Glass HUD overlay, airspeed tape, altimeter tape, artificial horizon, and system annunciators. |
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
- **Run Test Suite** (`node:test` — 73 test blocks across ten suites; the exact executed count can differ slightly when a runner expands subtests):
  ```bash
  npm test
  ```
  Suites: `scripts/autopilot-test.ts`, `scripts/globe-tiles-test.ts`, `scripts/navigation-test.ts`, `scripts/runtime-test.ts`, `scripts/dispatch-test.ts`, `scripts/clock-test.ts`, `scripts/runway-data-test.ts`, `scripts/weather-test.ts`, `scripts/scale-terrain-test.ts`, `scripts/atc-test.ts`.
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
