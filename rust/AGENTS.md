# In-Flight Rust Port - Agent Developer Guide (AGENTS.md)

Welcome to **In-Flight (Rust)**! This document defines architectural principles, mathematical conventions, design constraints, and operational guidelines for AI coding agents and human contributors working on the native Rust desktop rewrite of the In-Flight A320 simulator.

---

## 1. Project Mission & Architecture

This subproject (`rust/`) is a high-performance, native desktop rewrite of the browser-based In-Flight flight simulator (`sansaks-jpg/in-flight`).
- **Target Platform**: Native desktop (Windows x86_64, Linux, macOS).
- **Core Technology**:
  - Language: Rust 2021 Edition (`rust-version = 1.87` or stable).
  - Graphics Backend: `wgpu` 30 (Vulkan / Metal / DirectX 12) with raw WGSL shaders.
  - Windowing & Event Loop: `winit` 0.30 (`ApplicationHandler` architecture).
  - Linear Algebra: `glam` 0.34 (SIMD-accelerated math, DVec3/Mat4/Quat).
  - Simulation Loop: Fixed 120 Hz physics sub-stepping with accumulator, 60 Hz autopilot tick.
  - Aerodynamics & Avionics: Full 6-DOF rigid body, A320 normal law FBW, envelope protections, dual CFM56-5B spool model, LNAV/VNAV, ILS autoland.

---

## 2. Core Architectural Principles

### A. Zero-Allocation Simulation & Rendering Hot Path
To guarantee flat frame times (60+ FPS) and zero memory leaks or garbage collection stalls:
1. **Never allocate on the heap inside per-step or per-frame code**:
   - `Flight::advance()` and `FlightModel::step()` must use stack math exclusively.
   - Text rendering reuses a single pre-allocated `String` buffer.
   - Geometry generators (terrain clipmaps, runway markers, tree/building scatter) refill caller-owned, pre-allocated `Vec` buffers.
2. **Fixed-Capacity GPU Buffers**:
   - All vertex, index, instance, and uniform buffers are pre-allocated at startup with fixed bounds (e.g., `MAX_TREES = 7000`, `MAX_BUILDINGS = 3500`, `STATIC_VERTS = 220000`, `MAX_UI_VERTS = 16384`).
   - Per-frame GPU updates use `queue.write_buffer()` into established slices.

### B. Numerical & Physical Conventions
- **Coordinate Systems**:
  - Aircraft Body Frame: `+X` Right (starboard), `+Y` Up, `-Z` Forward (aviation body convention, identical to Three.js source).
  - World Coordinates: Local tangent plane in meters ($m$) relative to departure projection origin.
  - Rotations: `glam::DQuat` quaternions internally. User instruments receive degrees ($^\circ$).
- **Units**:
  - Distance: Meters ($m$). Geodesic conversion: $1\text{ NM} = 1852.0\text{ m}$, $1\text{ ft} = 0.3048\text{ m}$.
  - Velocity: Meters per second ($m/s$). Aviation conversion: $1\text{ knot (kt)} = 0.514444\text{ m/s}$.
  - Vertical Speed: Feet per minute ($\text{ft/min} = \text{fpm}$).
  - Angles: Radians internally, degrees for FCU / PFD displays.
  - True vs Magnetic Heading: Internal navigation uses True Heading; runway thresholds and ILS courses use magnetic orientation where specified in `airports.json`.

### C. Reversed-Z Infinite Projection
The renderer uses an infinite far-plane with floating-point reversed depth ($1.0$ at near plane, $0.0$ at infinity):
- Provides uniform $\approx 10^{-7}$ relative depth precision at all distances.
- Completely prevents z-fighting on runway markings and taxi lines even at 50+ km distances.
- Depth test: `wgpu::CompareFunction::GreaterEqual`.
- Depth clear value: `0.0`.

---

## 3. Directory Structure & Module Map

| Rust File | Original TypeScript Equivalent | Role & Capabilities |
|---|---|---|
| `src/lib.rs` | Root library | Module exports and headless simulator entry. |
| `src/physics.rs` | `src/sim/physics.ts` | 6-DOF rigid body dynamics, ISA atmosphere model, A320 FBW normal law, CFM56-5B engines, post-stall aerodynamic polars, ground effect, landing gear spring-dampers, hull crash contacts. |
| `src/specs.rs` | `src/sim/specs.ts` | Airbus A320-200 aircraft specifications (geometry, mass, limits, gear placements, polar coefficients). |
| `src/autopilot.rs` | `src/sim/autopilot.ts` | Auto-takeoff, LNAV lateral guidance, VNAV 3° geometric path, FCU selected/managed modes, ILS localizer/glideslope capture, flare, rollout, configuration speed schedule. |
| `src/nav.rs` | `src/sim/lnav.ts` | Great-circle leg navigation, fly-by waypoint sequencing, turn anticipation, semicircular cruise level determination, flight plan generation. |
| `src/gpws.rs` | `src/sim/game.ts` (GPWS logic) | Ground Proximity Warning System: sink rate, terrain clearance lookahead, glideslope deviation, stall warning, radio altitude callouts. |
| `src/clock.rs` | `src/sim/clock.ts` | Real-world UTC time and NOAA solar position algorithm (calculates true sun position, azimuth, elevation, twilight). |
| `src/airports.rs` | `src/data/airports.ts` | Pre-indexed 8,413 real-world airport and runway database embedded via `data/airports.json`. |
| `src/geo.rs` | `src/sim/geo.ts` | WGS84 geodesy, Web-Mercator projection, distance and bearing formulas. |
| `src/terrain.rs` | `src/sim/terrain.ts` (noise generator) | Procedural multi-octave terrain elevation generator with smooth airport elevation blending. |
| `src/weather.rs` | `src/sim/weather.ts` | Deterministic seeded weather model (wind profiles, gusts, QNH, temperature, visibility, cloud ceiling). |
| `src/game.rs` | `src/sim/game.ts` | Headless flight session manager: step accumulator, pilot input processing, touchdown touchdown scoring. |
| `src/gfx/mod.rs` | `src/sim/game.ts` / Three.js renderer | `wgpu` 30 rendering engine: pipelines, render passes, camera matrices, lighting uniforms. |
| `src/gfx/geom.rs` | `src/sim/terrain.ts` / `aircraftModel.ts` | Clipmap terrain mesh generation (8 concentric LOD rings), procedural A320 exterior geometry, runway markings. |
| `src/gfx/ui.rs` | `src/ui/Hud.tsx` / `FlightHud.tsx` | Glyph atlas text renderer (`ab_glyph`) and 2D instrument overlays (PFD tape, FCU strip, moving map). |
| `src/gfx/*.wgsl` | WGSL shader files | `world.wgsl` (terrain, airport, aircraft lighting), `sky.wgsl` (atmosphere & sun), `ui.wgsl` (2D overlays). |
| `src/app.rs` | App orchestrator | `winit` application handler, interactive menus, input mapping, camera rigs (Cockpit, Chase, Tower). |
| `src/bin/inflight.rs` | Main executable | Interactive flight simulator desktop application. |
| `src/bin/shots.rs` | Visual test binary | Offscreen headless renderer exporting PNG screenshots for automated regression verification. |
| `src/bin/soak.rs` | Soak test binary | Automated leak and frame-time testing across multiple simulated flights. |
| `tests/flight.rs` | Integration tests | Headless end-to-end flight test suite (takeoff, navigation, ILS autoland). |

---

## 4. Verification & Testing Workflow

All simulation logic is decoupled from GPU presentation and can run in automated headless CI:
```bash
# 1. Run all unit and flight integration tests (38 unit + 6 full-flight tests)
cargo test --release

# 2. Fast typecheck and borrow checker validation
cargo check

# 3. Interactive simulation (menu launch)
cargo run --release

# 4. Direct route launch with auto-flight demo
cargo run --release -- --dep KSFO --arr KOAK --autostart

# 5. Headless soak test (verifies memory stability and 0 MB leak)
cargo run --release --bin soak -- --flights 6

# 6. Offscreen screenshot generation
cargo run --release --bin shots -- screenshots 1280 720
```

---

## 5. Agent Instructions for Implementing Missing Features

When implementing features from the TypeScript/Three.js web version into this Rust port:
1. **Consult `rust/TASK.md` first**: Check off completed items and follow the priority roadmap.
2. **Read the corresponding TypeScript source file** in `src/sim/` or `src/ui/` to understand the original mathematics, thresholds, and behavior.
3. **Follow the Code-First Disagreement Principle**: If documentation contradicts existing working code, match the implementation in the existing code.
4. **Maintain Zero-Allocation**: If adding audio, systems, or avionics, do not introduce dynamic heap allocations into the simulation or rendering loops.
5. **Always Add Automated Tests**: Add unit tests in the respective module or integration scenarios in `tests/flight.rs`. Verify with `cargo test --release`.
