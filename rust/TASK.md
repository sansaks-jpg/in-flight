# In-Flight Rust Port - Implementation Roadmap & Task Tracker (TASK.md)

This document tracks all features, avionics systems, visual enhancements, and operational subsystems present in the original TypeScript / Three.js web application (`src/`) that are either partially ported or pending port to the native Rust simulator (`rust/`).

Use this document to prioritize development, claim tasks, track implementation status, and verify parity with the reference web simulator.

---

## Progress Overview

| Subsystem | Web Source Reference | Rust Target Module | Status | Priority |
|---|---|---|---|---|
| **6-DOF Physics & FBW** | `src/sim/physics.ts` | `rust/src/physics.rs` | ✅ Ported (120 Hz) | Core |
| **Autopilot (LNAV/VNAV/ILS)** | `src/sim/autopilot.ts` | `rust/src/autopilot.rs` | ✅ Ported (60 Hz) | Core |
| **Airport Database (8,413)** | `src/data/airports.ts` | `rust/src/airports.rs` | ✅ Ported | Core |
| **Solar & UTC Clock** | `src/sim/clock.ts` | `rust/src/clock.rs` | ✅ Ported | Core |
| **GPWS Alert Logic** | `src/sim/game.ts` | `rust/src/gpws.rs` | 🟡 Logic Ported, Audio Pending | High |
| **Procedural Audio Engine** | `src/sim/audio.ts` | `rust/src/audio/` | ❌ Pending Port | **High** |
| **A320 Systems Architecture** | `src/sim/a320/systems.ts` | `rust/src/systems/` | ❌ Pending Port | **High** |
| **A320 Cockpit & EFIS Displays** | `src/sim/a320/displays.ts` | `rust/src/gfx/cockpit/` | 🟡 Partial HUD Tape | **High** |
| **Interactive 3D Flight Deck** | `src/sim/cockpit.ts` | `rust/src/gfx/cockpit_3d.rs` | ❌ Pending Port | Medium |
| **Speech, VoiceBus & Comms** | `src/sim/speech.ts`, `comms.ts` | `rust/src/comms/` | ❌ Pending Port | Medium |
| **Air Traffic Control (ATC)** | `src/sim/atc.ts` | `rust/src/atc/` | ❌ Pending Port | Medium |
| **Surveyed Airfield Ground Layouts** | `src/sim/airfieldMesh.ts` | `rust/src/airfield.rs` | ❌ Pending Port | Medium |
| **Volumetric Clouds & Weather FX**| `src/sim/volumetricClouds.ts` | `rust/src/gfx/clouds.rs` | ❌ Pending Port | Medium |
| **Real DEM & Vector Tiles (MVT)** | `src/sim/mvt.ts`, `terrain.ts` | `rust/src/terrain_mvt.rs` | ❌ Pending Port (uses procedural) | Low |
| **CI/CD Executable Build** | `.github/workflows/rust-ci.yml`| `.github/workflows/` | 🟡 In Progress | **High** |

---

## 1. Procedural Audio Engine (`src/sim/audio.ts`)
**Priority**: High  
**Goal**: Native real-time procedural sound synthesis without browser Web Audio API, using `cpal` / `rodio` or custom ring-buffer audio callback.

- [ ] **1.1 CFM56-5B Engine Sound Synthesis**
  - Synthesize N1 fan blade passage howl (frequency proportional to N1 RPM).
  - Synthesize N2 combustor and turbine core rumble (frequency proportional to N2 RPM).
  - Jet exhaust shear noise (pink noise filtered by engine thrust and forward airspeed).
  - Reverse thrust deep roar when reverse deployers are engaged.
- [ ] **1.2 Airflow & Airframe Acoustics**
  - Slipstream hiss proportional to dynamic pressure $q = \frac{1}{2} \rho v^2$.
  - Gear extension wind drag turbulence and structural thud on lock.
  - Flap actuator hydraulic motor whine during extension/retraction.
  - Ground roll rumble on tarmac and tyre squeal on touchdown (energy proportional to touchdown sink rate).
- [ ] **1.3 Cockpit Annunciators & Warning Chimes**
  - Master Warning repeating chime (single chime for Caution).
  - Autopilot disconnect cavalry charge tone.
  - Click sounds for switch toggles, knob detents, and pushbuttons.
- [ ] **1.4 GPWS Voice Callouts**
  - Radio altitude callouts ("2500", "1000", "500", "400", "300", "200", "100", "50", "40", "30", "20", "10", "RETARD").
  - Warning callouts: "SINK RATE", "PULL UP", "TERRAIN", "GLIDESLOPE", "TOO LOW GEAR", "WINDSHEAR".

---

## 2. A320 Aircraft Systems (`src/sim/a320/systems.ts`)
**Priority**: High  
**Goal**: Complete model of A320 physical systems simulating interdependencies (electrics -> hydraulics -> flight controls).

- [ ] **2.1 Electrical System**
  - AC Buses: AC BUS 1, AC BUS 2, AC ESS, AC ESS SHED.
  - DC Buses: DC BUS 1, DC BUS 2, DC ESS, DC BAT BUS, HOT BUS 1/2.
  - Sources: External Power (EXT PWR), APU Generator, Engine IDG 1 & 2, Emergency RAT generator, Batteries 1 & 2.
  - Bus tie contactor logic (automatic priority switching).
- [ ] **2.2 Bleed Air & Pressurization**
  - Engine 1/2 bleed valves, APU bleed valve, crossbleed selector.
  - Air conditioning packs 1 & 2 with pack flow control.
  - Cabin pressure controller: automatic climb/cruise/descent profile, outflow valve actuation.
- [ ] **2.3 Hydraulic System**
  - Three independent networks: Green (Engine 1 + PTU), Blue (electric pump + RAT), Yellow (Engine 2 + PTU + electric pump).
  - Power Transfer Unit (PTU) bidirectional pressure transfer when differential $> 500\text{ psi}$.
  - System consumers: flight control surfaces, flaps/slats, landing gear actuation, nose wheel steering, braking.
- [ ] **2.4 Fuel System**
  - Left, Center, and Right wing tanks with main and standby pumps.
  - Crossfeed valve operation and gravity feed capability.
  - Engine fuel shutoff valves linked to Engine Fire pushbuttons.
- [ ] **2.5 Engine FADEC & Starting Logic**
  - FADEC state machine: auto-start sequence (crank, fuel valve opening, igniter firing, starter cutout at 50% N2).
  - Manual start option.
  - Engine Fire handles: isolation of fuel, hydraulics, bleed air, electrics, and 2 discharge squibs per engine.

---

## 3. Cockpit Displays & Avionics Instruments (`src/sim/a320/displays.ts`)
**Priority**: High  
**Goal**: Render authentic Airbus Glass Cockpit electronic displays onto textures or direct UI geometry.

- [ ] **3.1 Primary Flight Display (PFD)**
  - Artificial Horizon with pitch ladder and roll scale with bank angle protection pointers.
  - Airspeed tape: current CAS, trend vector (10 s), $V_{LS}$ (minimum selectable speed), $V_{\alpha\text{ prot}}$, $V_{\alpha\text{ max}}$, $V_{FE}$ next, $V_{MO} / M_{MO}$.
  - Altitude tape: current barometric altitude, vertical trend, metric altitude indicator, target altitude bug.
  - Vertical Speed Indicator (VSI) with TCAS resolution advisory resolution windows.
  - Flight Mode Annunciator (FMA) 5-column annunciator strip (A/THR, VERTICAL, LATERAL, APPR CAPABILITIES, AP/FD/A-THR engagement).
  - Flight Director (FD) crossbars or bird (track/flight path angle).
- [ ] **3.2 Navigation Display (ND)**
  - Modes: ROSE LS, ROSE VOR, ROSE NAV, ARC (90° forward sector), PLAN (North-up flight plan inspection).
  - Waypoints, active flight plan leg, turn arcs, deceleration points, top-of-descent (T/D) pseudo-waypoint.
  - Embedded compass rose with track line, heading bug, wind vector arrow and drift angle.
  - Runway symbols and ILS course feather.
- [ ] **3.3 Engine & Warning Display (E/WD)**
  - Primary engine parameters: N1 gauges with command arcs, EGT dial, N2 indications, Fuel Flow (FF).
  - Flap / Slat configuration indicator with transit animations.
  - Upper memo area (e.g., `IR IN ALIGN`, `TCAS STBY`, `AUTO BRK MED`, `SEAT BELTS`).
- [ ] **3.4 System Display (SD)**
  - 13 ECAM synoptic pages: `ENG`, `BLEED`, `PRESS`, `ELEC AC`, `ELEC DC`, `HYD`, `FUEL`, `APU`, `COND`, `DOOR`, `WHEEL`, `F/CTL`, `STS`.
  - Automatic phase-based page selection (e.g., WHEEL on ground, CRUISE in flight).
- [ ] **3.5 Flight Control Unit (FCU)**
  - Speed/Mach window (knots or Mach, push for managed, pull for selected).
  - Heading/Track window.
  - Altitude window (100 / 1000 step toggle, push for managed climb/descent, pull for open).
  - Vertical Speed / FPA window.
  - Barometric pressure setting window (QNH or STD).

---

## 4. Voice, Radio Comms & ATC (`src/sim/speech.ts`, `src/sim/atc.ts`, `src/sim/comms.ts`)
**Priority**: Medium  
**Goal**: Automatic air traffic control and crew monitoring voice interactions.

- [ ] **4.1 VoiceBus Dispatcher (`speech.ts`)**
  - Priority queue: 0: Background chatter, 1: ATC & Cabin PA, 2: Pilot Monitoring callouts, 3: Master GPWS warnings.
  - Preemption logic: higher priority speech halts and interrupts lower priority lines.
  - Subtitle broadcast hook for live transcription.
- [ ] **4.2 Automated ATC System (`atc.ts`)**
  - Real-world ICAO & FAA phraseology based on airport country.
  - Sequence: clearance delivery -> pushback & taxi -> tower departure -> departure radar -> en-route center -> approach radar -> tower landing -> ground taxi to gate.
  - Automatic pilot readback generation.
  - Background air traffic radio chatter matched to the current flight phase.
- [ ] **4.3 Flight Deck Comms Director (`comms.ts`)**
  - Pilot Monitoring (PM) standard callouts: "THRUST SET", "EIGHTY KNOTS", "V1", "ROTATE", "POSITIVE RATE", "GEAR UP", "FLAPS ONE", "TEN THOUSAND".
  - Stabilised approach gate checks at 1,000 ft and 500 ft AGL ("STABILISED" or "GO AROUND").
  - Rollout decelerations: "SPOILERS", "REVERSE GREEN", "DECEL", "SEVENTY KNOTS".
  - Indonesian language transcript translation support (`translate.ts`).

---

## 5. 3D Airfield Scenery & Ground Operations (`src/sim/airfieldMesh.ts`, `airfield.ts`)
**Priority**: Medium  
**Goal**: Render actual surveyed OpenStreetMap airfield ground layouts instead of generic rectangles.

- [ ] **5.1 Surveyed Airport Ground Layouts**
  - Ingest `src/data/airfields-id.json` and OpenStreetMap airfield data.
  - Generate 3D ground geometry: taxiway polylines, aprons, parking stands, hold-short lines.
  - Terminal and hangar 3D massing extrusions.
- [ ] **5.2 Ground Navigation & Taxiing**
  - Ground movement graph solver: calculate shortest taxi route from gate to runway holding point.
  - Visual 3D taxi ribbon assist overlaid on the tarmac.
  - Realistic spawn positions at actual terminal gates and stands.

---

## 6. Atmosphere, Clouds & Visual FX (`src/sim/volumetricClouds.ts`, `precip.ts`, `effects.ts`)
**Priority**: Medium  
**Goal**: Photorealistic atmospheric conditions and weather visual effects in `wgpu`.

- [ ] **6.1 Volumetric Ray-Marched Clouds**
  - 4 altitude layers: Low cumulus, Mid altostratus, High cirrus, and CB storm column.
  - Three-octave multiple scattering approximation.
  - Depth buffer intersection to correctly occlude mountains and aircraft surfaces.
  - Inside-cloud IMC (Instrument Meteorological Conditions) white-out effect.
- [ ] **6.2 Dynamic Precipitation**
  - Camera-relative GPU rain and snow streaks advected by true relative airflow velocity.
  - Cockpit windscreen water droplet simulation with wiper clearance.
- [ ] **6.3 Lightning & Thunder**
  - Dynamic procedural lightning ribbon generation for convective storm cells.
  - Synchronized screen flash and distance-delayed audio thunder boom.
- [ ] **6.4 GPU Particle Effects**
  - Touchdown tyre smoke puffs with dynamic drift.
  - Engine jet exhaust heat distortion.
  - Tail strike and gear collapse spark particles.

---

## 7. Interactive 3D Cockpit Model & Interaction (`src/sim/cockpit.ts`)
**Priority**: Medium  
**Goal**: Full 3D interactive flight deck loaded from GLB or procedural mesh.

- [ ] **7.1 Flight Deck Geometry**
  - Load A320 cockpit GLB model using `gltf` / `tobj` crate.
  - Batch static geometry per material to maintain single-digit draw calls.
  - Animate ~600 moving controls (throttles, sidestick, flap lever, speedbrake, switches, knobs).
- [ ] **7.2 Cockpit Controls Interaction**
  - Ray-cast mouse picking for pushbuttons, rotary switches, and drag levers.
  - Damped camera rig with presets: Captain Eye, First Officer, Overhead Panel, Pedestal, MCDU, Glareshield.

---

## 8. Continuous Integration & Windows Release Pipeline
**Priority**: High (Immediate)  
**Goal**: Fully automated GitHub Actions workflow to build, test, and release the native `.exe`.

- [x] Create `.github/workflows/rust-ci.yml`.
- [x] Automated compilation and test run on Windows runner (`windows-latest`).
- [x] Build optimized release binary `inflight.exe`.
- [x] Upload Windows `.exe` executable as GitHub Actions artifact and release asset.
