# In-Flight (Rust) — native A320 simulator

A native Rust desktop port of [`sansaks-jpg/in-flight`](https://github.com/sansaks-jpg/in-flight) (TypeScript / Three.js / React).
No browser, no WebGPU-in-a-browser layer: `winit` window + `wgpu` 30 (Vulkan / Metal / DX12) + a fixed-step Rust simulation.

The original repository is cloned unmodified in `../reference/in-flight/`.

## Run

```bash
cargo run --release                         # menu: type ICAO codes, Enter to start
cargo run --release -- --dep KSFO --arr KOAK --autostart     # auto take-off + autoland demo
cargo run --release -- --uncapped           # disable vsync (benchmark)
```
Linux needs the usual X11/Wayland + Vulkan runtime (`libvulkan1` + your GPU driver). Press **F1** in the game for the controls.

## Test

```bash
cargo test --release            # 38 unit tests + 6 full-flight integration tests (no GPU needed)
cargo run --release --bin soak -- --flights 12 --gpu --frames 700 --size 640x360   # leak / frame-time soak
cargo run --release --bin shots -- screenshots 1280 720                            # offscreen visual test -> PNGs
```
`shots` and `soak --gpu` work on any wgpu adapter, including software Vulkan (Mesa lavapipe) for CI.

## What is ported (module map)

| Rust | Original TypeScript | Notes |
|---|---|---|
| `src/physics.rs` | `sim/physics.ts` | 6-DOF rigid body, ISA atmosphere, A320 normal law + protections, engines (start / spool / reverse), aero with post-stall model, ground effect, spring-damper gear, hull contacts, auto-spoilers / autobrake |
| `src/specs.rs` | `sim/specs.ts` | A320-200 spec (the original also filters to the A320) |
| `src/autopilot.rs` | `sim/autopilot.ts` | auto-takeoff, LNAV, VNAV 3° path, FCU selected/managed, ILS capture, flare, rollout, speed schedule, min-safe-altitude |
| `src/nav.rs` | `sim/lnav.ts` | leg guidance, fly-by sequencing, cruise level (semicircular rule), flight-plan builder (+ intercept fix for route reversals) |
| `src/gpws.rs` | GPWS part of `game.ts` | sink rate, terrain look-ahead, glideslope, too-low-gear, stall, overspeed, retard, radio-altitude callouts |
| `src/clock.rs` | `sim/clock.ts` | real UTC clock + NOAA solar position (sky, stars, night lighting follow the real sun) |
| `src/airports.rs` | `data/airports.ts` | the original `airports.json` (8 413 airports / runways) embedded in the binary |
| `src/geo.rs` | `sim/geo.ts` | Web-Mercator projection, great-circle maths |
| `src/gfx/*` | Three.js scene + React HUD | wgpu renderer, WGSL shaders, glyph-atlas UI, PFD / FCU / ECAM / map |

## Deliberately NOT ported (be aware)

The original is ~28 000 lines including a modelled 3D A320 cockpit (EFIS/ECAM/EFB), live OSM/DEM tile streaming, live weather,
ATC dialogue + speech synthesis, Web-Audio engine synthesis, tools windows and the React UI kit. This port is the simulation core,
a native renderer and a cockpit HUD, not a 1:1 rewrite. In particular:

* **Terrain is procedural** (deterministic, shared by physics and renderer), blended into the real airport elevations — not real DEM / satellite data.
* **Weather is a deterministic seeded model** (wind, gusts, QNH, ΔT, visibility, cloud deck), not live METAR.
* **No audio, no ATC, no cold-and-dark start-up procedure UI** (the engine start model exists in `physics.rs`).
* Only the A320 is included (like the original, which filters the C172 / ATR out).
* Heading is **true**, not magnetic (the runway numbers in the database are magnetic).

## Performance design (60 FPS, no leaks)

* Physics: fixed 120 Hz step with an accumulator (max 10 sub-steps, backlog dropped) — frame-rate independent. Measured 3.2 µs / step.
* Zero heap allocation in the hot path: `step()` uses stack math only; HUD text uses one reusable `String`; geometry generators refill caller-owned `Vec`s.
* All GPU buffers are allocated once at start-up with fixed capacity (terrain rings, scatter instances, UI, static airports); per-frame work is `write_buffer`.
* Terrain: 8-level geometry clipmap (64×64 quads per ring, 16 m … 2 km spacing, ~130 km extent), at most 2 ring rebuilds per frame, camera-relative f32 rendering, reversed-Z infinite far plane.
* Trees / buildings: instanced, rebuilt only when the camera moves > 110 m, only below 2 500 m AGL.
* vsync (`Fifo`) by default → locked to the display refresh; `--uncapped` for benchmarks.

## Licence / credits

Original project and `airports.json`: see `../reference/in-flight`. Font: DejaVu Sans Mono Bold (`assets/DEJAVU-LICENSE.txt`).

## Satellite maps

The pre-flight globe and the in-flight ground use real imagery streamed in the background (Esri World Imagery by default;
Sentinel-2, OpenStreetMap, OpenTopoMap, Aviation Chart (shaded relief), NASA night lights, dark and Voyager charts can be picked on the globe, or cycled with `M`
in flight). Tiles are cached on disk (`$INFLIGHT_TILE_CACHE`, default platform cache dir, 2 GiB LRU). Useful environment
variables: `INFLIGHT_OFFLINE=1` (cache only), `INFLIGHT_NO_TILES=1` (procedural world, no network), `INFLIGHT_TILE_CACHE_MB`.
Pre-download an area with `cargo run --release --bin tilecache -- KSFO`. See `TASK.md` section 4 for the architecture.

The main menu shows a bare, rotating globe (no airports; the airport database is not loaded yet). Zooming or dragging the
globe replaces the menu with the route-selection screen, which loads all airports in the background and draws them with
their runways (real-metre markings once zoomed in, up to about 0.5 m/px).

## Interactive 3D Cockpit & Marketplace

The A320 3D flight deck model (`cockpit.glb`, ~50.6 MB) can be downloaded via the in-game Marketplace:
press **F2** or click the **ADD-ONS (F2)** button on the main menu to open the Marketplace and download.
Once downloaded, the model is cached persistently on disk and loaded in the background with 596 interactive controls
(raycast picking, press, drag, wheel) and 6 cockpit glass displays (PFD, ND, E/WD, SD). See `TASK.md` section 3 for details.

## Camera system
Two perspectives (`C` toggles): **cockpit** (`0-9` panel presets SEAT / FCU / PFD / ND / ECAM / MCDU / EFB / OVHD / PED / PANEL, drag = look with
momentum, right / middle / Shift-drag = lean, wheel = zoom, Alt+click a control = frame it) and **external** (`Y` cycles chase / wing / tower, drag = free
orbit, right / middle-drag = pan, wheel = zoom, double-click or `Home` = recentre). All motion is critically-damped; a clickable hot-bar lists the
views. Details and tuning constants: `TASK.md` section 7, code in `src/camera.rs` and `src/camera_ui.rs`.
