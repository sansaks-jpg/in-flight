//! Satellite / map tile system (native port of `src/sim/tiles.ts`, `src/sim/terrain.ts` imagery and `src/ui/globeTiles.ts`).
//!
//! * [`styles`]      – tile providers (Esri World Imagery, Sentinel-2, OSM, Topo, VIIRS night lights, dark chart).
//! * [`math`]        – Web-Mercator tile arithmetic.
//! * [`decode`]      – PNG/JPEG -> 256x256 RGBA + mips (worker threads only).
//! * [`disk`]        – persistent LRU-bounded disk cache.
//! * [`hub`]         – asynchronous streaming: priority queue, worker pool, back-off, resident table, bounded upload rationing.
//! * [`gpu`]         – shared texture-array atlas, ground page table, globe tile pipeline.
//! * [`ground`]      – page-table planner that drapes imagery over the terrain clipmap.
//! * [`globe_tiles`] – screen-space quadtree LOD for the pre-flight globe.
//!
//! The render thread never performs network, disk or decode work: see `hub` for the threading model and the TASK.md
//! architecture notes for the 60 FPS guarantees.

pub mod decode;
pub mod disk;
pub mod globe_tiles;
pub mod gpu;
pub mod ground;
pub mod hub;
pub mod math;
pub mod styles;

pub use hub::{TileHub, TileStats};
pub use math::TileKey;
