//! In-Flight (Rust port): native A320 flight simulator core + wgpu renderer.
//!
//! * `geo`, `physics`, `specs`, `autopilot`, `nav`, `gpws`, `weather`, `clock`, `terrain`, `airports`, `game` form the
//!   headless simulation core (no GPU dependency, fully unit/integration tested).
//! * `gfx` is the wgpu renderer (terrain clipmaps, airports, aircraft, sky, HUD) and `app` the winit front-end.
pub mod a320sys;
pub mod addons;
pub mod airports;
pub mod atmosphere;
pub mod app;
pub mod autopilot;
pub mod camera;
pub mod camera_ui;
pub mod clock;
pub mod clouds;
pub mod cockpit;
pub mod deck;
pub mod deckhost;
pub mod fbw;
pub mod game;
pub mod geo;
pub mod gfx;
pub mod glb;
pub mod gpws;
pub mod nav;
pub mod physics;
pub mod precip;
pub mod specs;
pub mod terrain;
pub mod tiles;
pub mod ui;
pub mod weather;

