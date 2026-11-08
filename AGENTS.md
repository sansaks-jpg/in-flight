# In-Flight - Agent & Contributor Guide (AGENTS.md)

Welcome to **In-Flight**! This document provides high-level architectural guidelines, system boundaries, and operational principles for AI agents and human contributors.

---

## 1. Project Mission & Structure

**In-Flight** is an Airbus A320-200 flight simulator featuring 6-DOF rigid-body aerodynamics, real-world geospatial data (8,413 global airports), authentic avionics, and an intuitive pre-flight interface.

The repository consists of two parallel implementations:

```
in-flight/
├── src/                # Track 1: Browser Web Simulator (TypeScript + Three.js + React)
│                       # → Serves as the REFERENCE SPECIFICATION & GROUND TRUTH.
├── rust/               # Track 2: Native Desktop Simulator (Rust 2021 + wgpu 30 + winit)
│                       # → High-performance standalone desktop rewrite.
├── public/             # Static web assets & model notices
└── scripts/            # Build & test validation scripts
```

---

## 2. Critical Boundaries for AI Agents

Depending on your assigned task, adhere to these non-negotiable rules:

### A. If you are working on the Rust Port (`rust/`):
- **`src/` IS STRICTLY READ-ONLY REFERENCE**:
  - Never edit, rename, or delete any file in `src/`, `public/`, `package.json`, or root configs.
  - The TypeScript codebase is your golden specification for UI/UX, mathematical formulas, and simulation thresholds.
  - Replicate the features **into Rust inside `rust/`**—do NOT modify the TypeScript files.
- **Detailed Rust Instructions**:
  - Read **[`rust/AGENTS.md`](file:///home/antigravity/sansaks-jpg/in-flight/rust/AGENTS.md)** for architecture and coding conventions.
  - Read and update **[`rust/TASK.md`](file:///home/antigravity/sansaks-jpg/in-flight/rust/TASK.md)** as the roadmap and progress changelog.

### B. If you are working on the TypeScript Web Simulator (`src/`):
- All work remains inside `src/`. Do not touch `rust/`.
- Ensure changes build cleanly with `npm run build` and pass tests with `npm test`.

---

## 3. Core Architectural Principles

1. **Target 60+ FPS & Zero-Allocation Hot Path**:
   - Never allocate objects or arrays inside per-frame update loops (`render()`, `step()`, `Flight::advance()`).
   - Reuse scratch math objects (vectors, quaternions) to prevent Garbage Collection (GC) pauses.
2. **Aviation Mathematical Conventions**:
   - **Internal Units**: SI units (meters, $m/s$, radians, kg, Newtons).
   - **Instruments / Display**: Aviation units (Knots, Feet, Feet per minute, Degrees).
   - **Coordinate System**: Aviation body frame: `+X` Right, `+Y` Up, `-Z` Forward.
   - **True vs. Magnetic**: Navigation mathematics uses True Heading; runway identifiers and ILS courses use Magnetic Heading.
3. **Code-First Disagreement Principle**:
   - If documentation ever conflicts with the existing working code, **follow the working code** as the source of truth.

---

## 4. Key Directory Map (`src/`)

| Directory | Purpose | Key Files |
|---|---|---|
| `src/sim/` | Simulation Engine | `physics.ts` (6-DOF, FBW), `autopilot.ts` (LNAV/VNAV/ILS), `game.ts` (loop), `clock.ts` (solar ephemeris), `terrain.ts` (elevation & LOD), `audio.ts` (sound) |
| `src/sim/a320/` | A320 Systems & Displays | `systems.ts` (hydraulics, fuel, electrics, FADEC), `displays.ts` (PFD, ND, ECAM, FCU) |
| `src/ui/` | UI/UX & Pre-Flight Suite | `PreGameVisuals.tsx` (MSFS bento menu), `Planner.tsx` (route planner), `AirportMiniMap.tsx` (search & diagrams), `MsfsWindows.tsx` (modals), `FlightHud.tsx` (in-flight HUD) |
| `src/data/` | Aviation Databases | `airports.ts` / `airports.json` (8,413 global airports), `frequencies.json`, `navaids.json` |

---

## 5. Development & Verification Workflows

### Web Simulator (`src/`)
```bash
npm run dev        # Launch Vite development server
npm run build      # TypeScript check and production bundle
npm test           # Run node:test regression suite
```

### Native Rust Simulator (`rust/`)
```bash
cd rust
cargo check                 # Fast compiler check
cargo test --release        # Run unit and flight integration tests
cargo run --release         # Run native interactive simulator
cargo run --release --bin shots -- screenshots  # Headless screenshot verification
```
