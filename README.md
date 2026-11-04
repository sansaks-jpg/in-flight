# In-Flight ✈️

> A photorealistic, high-performance web flight simulator built with **Three.js**, **React 19**, and **TypeScript**, powered by worldwide OpenStreetMap data and real-time terrain streaming.

![Skyline Flight Simulator](screenshots/06-cockpit-app.png)

---

## 🌟 Features

### 🌍 Worldwide Terrain & Dynamic Tile Streaming
- **Streamed Real-World Geospatial Data**: Procedural streaming of terrain heightmaps, satellite/vector land cover, roads, and coastlines using OpenStreetMap and Mapbox Vector Tiles (MVT).
- **6,600+ Global Airports**: Database of real-world airports (`src/data/airports.ts`) with accurate runway orientations, dimensions, ICAO identifiers, and field elevations.
- **Procedural Scenery & Urban Environments**: High-density 3D building generation, road networks, runway lighting, PAPI lights, and instanced 3D tree vegetation.

### 🛩️ Rigid-Body Aerodynamic Physics
- **Realistic Flight Dynamics**:
  - Lift curve slopes ($C_L$), drag polars ($C_{D0}$ + induced drag), and dynamic stalls.
  - Flap extension aerodynamics ($C_{L,\text{flap}}$, $C_{D,\text{flap}}$) and landing gear parasite drag.
  - Trim elevator adjustments, ground effect lift cushioning, and crosswind weathercocking.
- **Ground Handling & Suspension**:
  - Multi-point oleo strut spring-damper suspension physics.
  - Ground friction, differential braking, and steerable nose/tail wheels.
  - Reverse thrust and spoiler aerodynamic speedbrakes.

### 🧭 Full Avionics & Autopilot System
- **Autopilot Modes**:
  - **HDG** (Heading Select & Hold)
  - **ALT** (Barometric Altitude Hold)
  - **VS** (Vertical Speed Select)
  - **NAV** (LNAV Waypoint Tracking with Great-Circle navigation)
  - **APPR** (ILS Approach mode with Localizer and 3° Glideslope intercept)
- **Air Traffic Control (ATC)**:
  - Interactive ATC dialog system with frequency handoffs, runway clearances, altitude assignments, and vectoring.
- **Glass & Analog Instrumentation**:
  - Primary Flight Display (PFD) with artificial horizon, flight director, airspeed tape, altimeter tape, vertical speed indicator, and compass rose.
  - Top-down tactical navigation moving map (`CanvasMap`) with airspace boundaries, ILS feathers, and flight plan waypoints.

### 🔊 Procedural Web Audio & GPWS
- Real-time synthesized engine sounds: piston rumble, turboprop whine, and twin-spool turbofan jet roar.
- Aerodynamic wind rush scaling with airspeed ($V^2$) and flap/gear extension.
- Wheel touchdown tire screech and airframe roll rumbling.
- **Ground Proximity Warning System (GPWS)**:
  - Callouts: *"Sink Rate"*, *"Terrain, Pull Up"*, *"Glideslope"*, *"500"*, *"Minimums"*.
  - Stall warning horn and overspeed clacker.

---

## ✈️ Aircraft Roster

| Aircraft | Type | Engines | Cruise Speed | Ceiling | Features |
|---|---|:---:|:---:|:---:|---|
| **Aero Swift RG** | Light Single | 1x Piston (165 kW) | 125 kt | 18,000 ft | Retractable gear, forgiving flight envelope, analog 6-pack instruments. Perfect for VFR training. |
| **Aero Trek T2** | Commuter STOL | 2x Turboprop (1,300 kW) | 190 kt | 28,000 ft | High-lift slotted flaps, beta reverse thrust, rugged short-field performance. |
| **Skyliner 320** | Narrow-body Jet | 2x Turbofan (225 kN) | 450 kt | 39,000 ft | Glass cockpit, flight management system, speedbrakes, reverse thrust, CAT-III ILS autoland. |

---

## 🎮 Flight Controls

### Keyboard & Mouse

| Action | Primary Key | Secondary / Description |
|---|---|---|
| **Elevator (Pitch)** | `W` / `S` | `ArrowUp` (Push down) / `ArrowDown` (Pull up) |
| **Aileron (Roll)** | `A` / `D` | `ArrowLeft` / `ArrowRight` |
| **Rudder (Yaw / Steer)** | `Q` / `E` | Nosewheel steering on ground |
| **Throttle Increase / Decrease** | `Shift` / `Ctrl` | `PageUp` / `PageDown` (Hold to adjust) |
| **Throttle Presets** | `1` - `9`, `0` | `1` = 10%, `5` = 50%, `0` = 100%, `X` = Cut to Idle |
| **Wheel Brakes** | `Space` | Progressive pneumatic / hydraulic braking |
| **Parking Brake** | `B` | Toggle parking brake |
| **Landing Gear** | `G` | Toggle gear extension (inhibited on ground) |
| **Flaps Extend / Retract** | `F` / `V` | Cycle flap detents |
| **Speedbrake / Spoilers** | `Z` | Deploy / retract aerodynamic spoilers (Jet only) |
| **Reverse Thrust** | `T` | Toggle thrust reversers (Turboprop & Jet) |
| **Elevator Trim** | `Insert` / `Delete` | Trim pitch up / down |
| **Camera View** | `C` | Cycle Cockpit / Chase / Orbit / Flyby |
| **Look Around** | `Right Click + Drag` | Pan camera (`Home` to reset view) |
| **Autopilot Master** | `Y` | Engage / Disengage Autopilot |
| **Autopilot NAV Mode** | `N` | Toggle LNAV waypoint tracking |
| **Autopilot APPR Mode** | `U` | Arm / Engage ILS Approach |
| **Heading Bug Adjust** | `,` / `.` | Heading decrements / increments |
| **Altitude Target Adjust** | `[` / `]` | `Shift + [` / `]` for 1000 ft steps |
| **Speed Target Adjust** | `-` / `=` | Target airspeed adjust |
| **Navigation Map** | `M` | Toggle tactical moving map overlay |
| **HUD Mode** | `H` | Cycle HUD display styles |
| **Time Warp** | `\` | Cycle 1x, 2x, 4x simulation rate |
| **ATC Response** | `1`, `2`, `3`, `4` | Select active ATC communication option |
| **Pause / Resume** | `Esc` or `P` | Pause simulation |
| **Restart Flight** | `R` (Hold) | Reset flight to runway |

### Gamepad Support (Xbox / PlayStation / Generic)
- **Left Stick**: Pitch and Roll
- **Right Stick / Triggers**: Rudder / Yaw, Left Trigger / Right Trigger for Throttle
- **A / Cross**: Toggle Landing Gear
- **B / Circle**: Parking Brake
- **LB / RB**: Flaps Down / Flaps Up
- **Y / Triangle**: Autopilot Toggle
- **D-Pad**: ATC Quick Responses (Up: 1, Down: 2, Left: 3, Right: 4)

---

## 📸 Screenshots

| High-Altitude Cruise | Cockpit & Avionics |
|:---:|:---:|
| ![Cruise View](screenshots/05-city-2500m.png) | ![Cockpit Flight](screenshots/06-cockpit-app.png) |

| Urban Scenery & Water Shaders | Aerodrome Approach |
|:---:|:---:|
| ![Water & Ground](screenshots/04-after-facades-water.png) | ![Approach](screenshots/02-after-roofs-roads-ground.png) |

---

## 🛠️ Technology Stack

- **Graphics Core**: [Three.js](https://threejs.org/) (Custom shaders, PBR materials, instanced meshes, shadow cascades)
- **Frontend Framework**: [React 19](https://react.dev/) + [TypeScript 5.9](https://www.typescriptlang.org/)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/)
- **Bundler & Tooling**: [Vite 7](https://vitejs.dev/) with Singlefile bundling support
- **Spatial Math & Geodesy**: WGS84 coordinates, Vincenty / Haversine great-circle navigation, Web Mercator projection

---

## 🚀 Getting Started

### Prerequisites
- Node.js (v18.0.0 or higher recommended)
- npm or pnpm / yarn

### Installation
```bash
git clone https://github.com/sansaks-jpg/in-flight.git
cd in-flight
npm install
```

### Development Server
```bash
npm run dev
```
Open your browser and navigate to `http://localhost:5173` (or the port indicated in your console).

### Production Build
```bash
npm run build
```
The optimized bundle will be created inside the `dist/` directory.

---

## 📂 Project Structure

```text
in-flight/
├── public/                 # Static assets
├── screenshots/            # Showcase images
├── scripts/                # Airport builders, asset compression, unit test scripts
│   ├── build-airports.mjs  # Airport database generator
│   ├── compress-tree.mjs   # glTF/GLB geometry optimizer
│   └── phys-test.ts        # Physics verification routines
├── src/
│   ├── assets/             # 3D models and textures (GLB, shaders)
│   ├── data/               # 6,600+ Airport database and runway threshold specifications
│   ├── sim/                # Core simulation engine
│   │   ├── aircraftModel.ts# 3D aircraft visual representation & control surface articulation
│   │   ├── audio.ts        # Procedural Web Audio engine & GPWS synthesizer
│   │   ├── autopilot.ts    # PID controllers, flight director, ILS guidance
│   │   ├── cockpit.ts      # 3D cockpit interior, dials, levers, PFD/MFD screens
│   │   ├── game.ts         # Main game loop, state machine, ATC dispatcher
│   │   ├── geo.ts          # Geodetic calculations, coordinate transformations
│   │   ├── instruments.ts  # HUD instrumentation, tape gauges, compass
│   │   ├── mvt.ts          # Mapbox vector tile parser & terrain geometry
│   │   ├── physics.ts      # Flight physics, aerodynamic coefficients, gear dynamics
│   │   ├── quality.ts      # Performance presets (Ultra, High, Medium, Low, Mobile)
│   │   ├── specs.ts        # Aircraft configuration & aerodynamic parameters
│   │   ├── structures.ts   # Procedural buildings, runway markings, approach lighting
│   │   ├── terrain.ts      # Elevation sampling & terrain mesh management
│   │   └── world.ts        # Atmosphere, skybox, sun/moon, volumetric fog & clouds
│   ├── ui/                 # React UI layer
│   │   ├── CanvasMap.ts    # Tactical 2D moving map
│   │   ├── Hud.tsx         # In-flight HUD overlay, instruments, annunciator panel
│   │   ├── MapPanel.tsx    # Interactive flight planner map
│   │   ├── Planner.tsx     # Route planning & runway departure/arrival selector
│   │   └── Screens.tsx     # Main menu, aircraft selection, settings
│   ├── App.tsx             # Main application orchestrator
│   └── main.tsx            # React DOM entry point
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## 📄 License

This project is licensed under the MIT License.
Third-party 3D model assets are licensed under their respective authors (see `src/assets/LICENSE-kenney-nature.txt`).
