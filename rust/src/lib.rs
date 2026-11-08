//! In-Flight (Rust port): native A320 flight simulator core + wgpu renderer.
//!
//! * `geo`, `physics`, `specs`, `autopilot`, `nav`, `gpws`, `weather`, `clock`, `terrain`, `airports`, `game` form the
//!   headless simulation core (no GPU dependency, fully unit/integration tested).
//! * `gfx` is the wgpu renderer (terrain clipmaps, airports, aircraft, sky, HUD) and `app` the winit front-end.
pub mod airports;
pub mod app;
pub mod autopilot;
pub mod clock;
pub mod game;
pub mod geo;
pub mod gfx;
pub mod gpws;
pub mod nav;
pub mod physics;
pub mod specs;
pub mod terrain;
pub mod weather;
