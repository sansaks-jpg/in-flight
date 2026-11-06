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
| `src/ui/globeTiles.ts` | Planner-globe satellite LOD quadtree: cross-fading tiles, parent fallback, 404-aware (Esri `blankTile=false`), prioritised/cancellable loading, LRU. |
| `src/ui/globeCamera.ts` | Google-Earth-style camera helpers: eased fly-to with pull-back arc, drag inertia, normalised wheel zoom. |
| `src/ui/globeRunways.ts` | True-scale (metres) runway markings for the globe overlay with a metres-per-pixel fade gate. |
| `src/sim/cockpit.ts` | 3D interactive cockpit models, analog gauges, interactive throttle/stick, PFD and MFD displays. |
| `src/sim/clock.ts` | Single real-world (UTC) time source, NOAA solar position, twilight phases and clock formatting. Never use a separate game clock for time of day. |
| `src/data/runwayRefine.ts` | Live OpenStreetMap runway survey upgrade (cached) for airports with approximate runways. |
| `src/sim/specs.ts` | Aircraft performance data, engine configurations, aerodynamic coefficients, and weight balance profiles. |
| `src/sim/terrain.ts` | Procedural and vector terrain elevation sampling, heightmaps, and terrain meshes. |
| `src/sim/tiles.ts` | Tile streaming logic, LOD management, and bounding frustum culling. |
| `src/sim/structures.ts`| Procedural urban generation, building extrusions, runway markings, and approach lights. |
| `src/sim/audio.ts` | Web Audio API procedural synthesis for engines, slipstream wind noise, gear rattles, and GPWS callouts. |
| `src/ui/CanvasMap.ts` | High-performance 2D HTML Canvas navigation moving map. |
| `src/ui/Hud.tsx` | Glass HUD overlay, airspeed tape, altimeter tape, artificial horizon, and system annunciators. |
| `src/ui/Planner.tsx` | Pre-flight route planner and airport database search interface. |
| `src/data/airports.ts` | Pre-indexed airport database with 8,400+ real-world airfields and runway specifications. |

---

## 4. Development & Verification Workflows

### Available Commands
- **Start Dev Server**:
  ```bash
  npm run dev
  ```
- **Typecheck & Production Build**:
  ```bash
  npm run build
  ```
- **Preview Production Build**:
  ```bash
  npm run preview
  ```
- **Run Airport Generation / Scenery Scripts**:
  ```bash
  npx tsx scripts/phys-test.ts
  npx tsx scripts/ap-test.ts
  node scripts/build-airports.mjs
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
   - Ensure changes respect the quality presets (`ultra`, `high`, `medium`, `low`, `mobile`) defined in `src/sim/quality.ts`. Keep draw calls and geometry count within the defined budgets.
