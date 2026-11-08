# In-Flight Rust Port - Agent Developer Guide (AGENTS.md)

Welcome to **In-Flight (Rust)**! This document provides architectural principles, system boundaries, UI/UX translation specifications, and operational rules for AI coding agents and human contributors working on the native Rust rewrite of the In-Flight A320 simulator.

---

## ⚠️ CRITICAL PRIME DIRECTIVES FOR AI AGENTS (READ FIRST)

Any agent working on this repository **MUST** obey these strict boundaries:

### DIRECTIVE 1: THE TYPESCRIPT CODEBASE (`src/`) IS STRICTLY READ-ONLY REFERENCE
- **NEVER modify, rename, move, or delete any file outside the `rust/` directory.**
- Files in `src/`, `public/`, `package.json`, `index.html`, `vite.config.ts`, etc., represent the **GOLDEN SPECIFICATION** (Ground Truth).
- The TypeScript web simulator must remain 100% intact and runnable at all times.
- If you edit or replace any file in `src/` (e.g. `src/App.tsx`), **you have failed the task**. Your job is to port the TypeScript features **INTO** Rust inside `rust/`, NOT to change the TypeScript project to accommodate Rust!

### DIRECTIVE 2: TARGET ARCHITECTURE IS NATIVE RUST (NOT A WEB WASM HACK)
- Even if your sandbox runs `npm run dev` or provides a browser preview, **the project in `rust/` is a native desktop application** built with `wgpu 30` and `winit 0.30`.
- Do NOT compile `rust/` into a WebAssembly module that hijacks `src/App.tsx`.
- All features—including the pre-flight UI/UX, menus, globe, airport search, route planner, and briefing—must be implemented in Rust inside `rust/src/`.

### DIRECTIVE 3: MANDATORY `TASK.md` IMPLEMENTATION LOG & CHANGELOG
- `rust/TASK.md` is the living record of all active work and implementations.
- Dokumen ini **bukan** checklist yang sudah diisi oleh orang lain; **Anda (Agent)** yang wajib mengisinya.
- Setiap kali Anda menyelesaikan perubahan yang diminta dalam prompt user, Anda **WAJIB** mencatat dan mendokumentasikan apa yang Anda ubah dan implementasikan langsung ke dalam `rust/TASK.md` (tabel changelog dan detail perubahannya).

---

## 1. Project Mission & Technology Stack

This subproject (`rust/`) is a high-performance, native desktop rewrite of the browser-based In-Flight flight simulator (`sansaks-jpg/in-flight`).

- **Target Platform**: Native desktop (Windows x86_64, Linux, macOS).
- **Core Technology**:
  - Language: Rust 2021 Edition (`rust-version = 1.87` or stable).
  - Graphics Backend: `wgpu` 30 (Vulkan / Metal / DirectX 12) with raw WGSL shaders.
  - Windowing & Event Loop: `winit` 0.30 (`ApplicationHandler` architecture).
  - Linear Algebra: `glam` 0.34 (SIMD-accelerated math, DVec3/Mat4/Quat).
  - Font & Text Rendering: `ab_glyph` 0.2 with embedded `assets/DejaVuSansMono-Bold.ttf`.
  - Simulation Loop: Fixed 120 Hz physics sub-stepping with accumulator, 60 Hz autopilot tick.
  - Aerodynamics & Avionics: Full 6-DOF rigid body, A320 normal law FBW, envelope protections, dual CFM56-5B spool model, LNAV/VNAV, ILS autoland.

---

## 2. Core Architectural Principles

### A. Zero-Allocation Simulation & Rendering Hot Path
To guarantee flat frame times (60+ FPS) and zero memory leaks or garbage collection stalls:
1. **Never allocate on the heap inside per-step or per-frame code**:
   - `Flight::advance()` and `FlightModel::step()` must use stack math exclusively.
   - Text rendering reuses pre-allocated `String` buffers (`buf.clear(); write!(buf, ...)`).
   - Geometry generators (terrain clipmaps, runway markers, tree/building scatter) refill caller-owned, pre-allocated `Vec` buffers.
2. **Fixed-Capacity GPU Buffers**:
   - All vertex, index, instance, and uniform buffers are pre-allocated at startup with fixed bounds (e.g., `MAX_TREES = 7000`, `MAX_BUILDINGS = 3500`, `STATIC_VERTS = 220000`, `MAX_UI_VERTS = 96000`).
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
- Uniform $\approx 10^{-7}$ relative depth precision at all distances.
- Completely prevents z-fighting on runway markings and taxi lines even at 50+ km distances.
- Depth test: `wgpu::CompareFunction::GreaterEqual`.
- Depth clear value: `0.0`.

---

## 3. UI/UX Translation Guide: Porting `src/ui/` to Rust

The reference web application in `src/ui/` features a rich pre-flight suite. In the Rust port, this entire suite must be implemented in Rust native code, utilizing the 2D UI batch renderer (`Ui` in `rust/src/gfx/ui.rs`) or dedicated UI submodules under `rust/src/ui/`.

### Detailed Mapping Table:

| TypeScript Reference File | Target Rust Location | Core Features to Replicate |
|---|---|---|
| **`src/ui/PreGameVisuals.tsx`** & **`Screens.tsx`** | `rust/src/ui/screens.rs` or `rust/src/gfx/ui.rs` | **Main Menu (MSFS Bento Grid)**: 5 interactive tiles (Flight Planner, Free Flight, Settings, Logbook, About). Smooth tile hover states, status pill ("60 FPS READY"), and screen transition state machine (`Boot` → `Menu` → `Planner` → `Briefing` → `InFlight`). |
| **`src/ui/Loaders.tsx`** | `rust/src/ui/screens.rs` | **Boot & Splash Loader**: Airbus A320 vector silhouette, animated loading bar, system initialization checklist ("ALIGNING IRS", "LOADING 8,413 AIRPORTS", "COMPILING SHADERS"). |
| **`src/ui/globeCamera.ts`** & **`globeTiles.ts`** | `rust/src/ui/globe.rs` or `rust/src/gfx/globe.rs` | **3D Interactive Globe**: Ray-cast or 3D sphere mesh, camera fly-to easing, solar terminator (day/night illumination using NOAA solar equations in `clock.rs`), city night lights, and atmospheric halo glow. |
| **`src/ui/Planner.tsx`** & **`AirportMiniMap.tsx`** | `rust/src/ui/planner.rs` | **Airport Search & Picker**: Real-time search across 8,413 embedded airports by ICAO, IATA, airport name, or city. Filter toggles (Runway $\ge$ 5,000 ft, International, Hard Surface). Region quick-picks (Europe, Americas, Asia-Pacific, Middle East). |
| **`src/ui/A320Plan.tsx`** & **`flightDispatch.ts`** | `rust/src/ui/planner.rs` / `rust/src/nav.rs` | **Flight Dispatch & Route Briefing**: Departure/arrival runway selection with automatic headwind/crosswind calculation. Route distance, cruise Flight Level (semicircular rule: Eastbound ODD, Westbound EVEN), ETE, block fuel calculation, and Top-of-Descent (TOD) calculation. |
| **`src/ui/MapPanel.tsx`** & **`CanvasMap.ts`** | `rust/src/ui/map.rs` | **Route Map & Runway Layout**: 2D Web-Mercator map projection displaying great-circle flight path arc, waypoints, and true-scale runway vector geometry. |
| **`src/ui/MsfsWindows.tsx`** & **`SettingsPanels.tsx`** | `rust/src/ui/modals.rs` | **Modal Windows**: Glass-morphism styled windows for Settings (audio volumes, graphics options, FOV slider), Controls reference cheat-sheet, and Flight Logbook. |

---

## 4. UI Rendering Architecture in Rust

In `rust/src/gfx/ui.rs`, the simulator provides an immediate-mode 2D UI batch renderer:
- **`Ui` struct**: Pre-allocated vertex buffer (`MAX_UI_VERTS = 96,000`) and command queue (`DrawCmd`).
- **Primitives**:
  - `ui.rect(x, y, w, h, color)`: Solid colored quad.
  - `ui.frame(x, y, w, h, thickness, color)`: Outlined rectangular border.
  - `ui.text(x, y, size, color, align, text)`: High-performance glyph-cached text.
  - `ui.set_scissor(Some([x, y, w, h]))`: Scissor clipping for scrollable lists and panels.
- **Extending for UI/UX**:
  - You can structure complex screens into reusable helper functions or state structs (e.g. `MenuState`, `PlannerState`, `ModalState`).
  - Keep UI logic decoupled from low-level GPU draw calls by updating UI vertices once per frame during `Ui::begin()` / `Ui::end()`.

---

## 5. Directory Structure & Module Map

```
rust/
├── Cargo.toml                  # Native Rust crate config (inflight)
├── assets/                     # Embedded assets (DejaVuSansMono-Bold.ttf)
├── data/
│   └── airports.json           # 8,413 real-world airports and runways
├── src/
│   ├── lib.rs                  # Library entry & simulator exports
│   ├── app.rs                  # winit application handler, events, screens
│   ├── physics.rs              # 6-DOF physics, FBW, CFM56-5B engines
│   ├── specs.rs                # A320 aircraft dimensions, masses, limits
│   ├── autopilot.rs            # LNAV/VNAV/ILS guidance & autoland
│   ├── nav.rs                  # Great-circle navigation & flight planning
│   ├── airports.rs             # Airport database search & queries
│   ├── clock.rs                # UTC clock & solar position algorithms
│   ├── geo.rs                  # WGS84 geodesy & Web-Mercator projection
│   ├── gpws.rs                 # GPWS audio alerts & callouts logic
│   ├── terrain.rs              # Procedural terrain generator
│   ├── weather.rs              # Seeded weather and wind model
│   ├── game.rs                 # Flight session manager & scoring
│   ├── gfx/
│   │   ├── mod.rs              # wgpu pipelines, passes, uniforms
│   │   ├── geom.rs             # Terrain clipmaps, A320 3D mesh, runways
│   │   ├── ui.rs               # 2D batch UI renderer, HUD, menus
│   │   └── *.wgsl              # WGSL shaders (world, sky, ui)
│   ├── ui/                     # [RECOMMENDED] Dedicated pre-flight UI modules
│   │   ├── mod.rs
│   │   ├── screens.rs          # Main menu, bento grid, bootloader
│   │   ├── planner.rs          # Airport search, route planner, briefing
│   │   └── modals.rs           # Settings, controls, logbook
│   └── bin/
│       ├── inflight.rs         # Interactive desktop flight simulator
│       ├── shots.rs            # Headless visual test renderer (screenshots)
│       └── soak.rs             # Headless soak test runner
└── tests/
    └── flight.rs               # End-to-end headless flight test suite
```

---

## 6. Verification & Quality Assurance

Always verify your changes before committing or completing a task:

```bash
# 1. Run all unit and integration tests
cargo test --release

# 2. Fast typecheck and borrow check
cargo check

# 3. Compile native release binary
cargo build --release

# 4. Run headless visual screenshot test
cargo run --release --bin shots -- screenshots

# 5. Run headless memory/frame soak test
cargo run --release --bin soak -- --flights 2
```

---

## 7. How to Work on a Task (Step-by-Step for Agents)

1. **Check `rust/TASK.md`**: Pick an uncompleted task from the roadmap.
2. **Inspect Reference TypeScript**: Read the corresponding files in `src/ui/` or `src/sim/` to understand the exact visual layout, math, and data structures.
3. **Implement in `rust/`**: Write clean, idiomatic, zero-allocation Rust code inside `rust/src/`.
4. **Test & Verify**: Run `cargo check` and `cargo test --release`.
5. **Update `rust/TASK.md`**:
   - Mark the completed item with `[x]`.
   - Add a row to the **Changelog / History Log** table at the bottom of `rust/TASK.md`.
