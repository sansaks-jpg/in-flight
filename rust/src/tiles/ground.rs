//! Satellite ground surface: virtual-texture "page table" for the terrain clipmap rings.
//!
//! Every clipmap ring `l` (see `gfx::geom`) is shaded from the shared tile atlas. Because the sim's world frame is an exact
//! affine image of Web-Mercator (`geo::Projection`), a fragment at world (x, z) maps to a tile coordinate with one
//! multiply-add, then a tiny per-level page table (16x16 tiles x 3 texels) says which atlas layer holds that tile – or the
//! nearest resident ancestor (scale + offset), plus the parent for the cross-fade. All of that is plain data written with one
//! small `write_texture`; no mesh is rebuilt and nothing is decoded on the render thread.
//!
//! Level `l` uses zoom `18 + log2(cos lat0) - l` (≈0.6 m/px · 2^l ground resolution, i.e. matched to the ring's vertex
//! spacing and viewing distance), so every ring spans ≈ 6.7 tiles regardless of latitude.

use super::hub::{Slot, TileHub};
use super::math::{tiles_at, wrap_x, TileKey};
use super::styles;
use crate::geo::{merc_x, merc_y, Projection, R_MERC};
use crate::gfx::geom::{level_spacing, LEVELS, RING_N};
use bytemuck::{Pod, Zeroable};
use std::f64::consts::TAU;

/// Tiles per side of one level's page table (power of two; the shader hashes tile coordinates modulo this).
pub const PT_N: usize = 16;
pub const PT_W: usize = PT_N * 3;
pub const PT_H: usize = LEVELS * PT_N;
const C: f64 = TAU * R_MERC;
/// Lowest zoom a ring will ever ask for.
pub const MIN_ZOOM: u8 = 4;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, PartialEq, Debug, Default)]
pub struct LevelU {
    /// frac(tile coord of the world origin).xy, tiles per metre, zoom
    pub org: [f32; 4],
    /// floor(tile coord of the world origin).xy
    pub base: [i32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, PartialEq, Debug)]
pub struct GroundU {
    pub lv: [LevelU; LEVELS],
    /// x = 1 when imagery is active
    pub misc: [f32; 4],
}

impl Default for GroundU {
    fn default() -> Self {
        Self { lv: [LevelU::default(); LEVELS], misc: [0.0; 4] }
    }
}

/// Zoom used by clipmap level `l` at Mercator scale `k = cos(lat0)`.
pub fn level_zoom(k: f64, l: usize, max_zoom: u8) -> u8 {
    let z = (18.0 + k.max(1e-3).log2() - l as f64).round() as i32;
    z.clamp(MIN_ZOOM as i32, max_zoom as i32) as u8
}

/// Best resident tile covering `key` (itself or an ancestor), without touching the LRU stamp.
fn best_resident(hub: &TileHub, key: TileKey) -> Option<(TileKey, Slot)> {
    let mut k = key;
    loop {
        if let Some(s) = hub.peek(k) {
            return Some((k, s));
        }
        k = k.parent()?;
    }
}

/// `[layer, scale, offset_u, offset_v]` addressing `key` inside the tile `found`.
fn encode(key: TileKey, found: TileKey, slot: Slot) -> [f32; 4] {
    let dz = key.z - found.z;
    let sc = 1.0 / (1u32 << dz) as f32;
    let mask = (1u32 << dz) - 1;
    [slot.layer as f32, sc, (key.x & mask) as f32 * sc, (key.y & mask) as f32 * sc]
}

pub struct GroundPlan {
    pub u: GroundU,
    /// `PT_W x PT_H` RGBA32F texels (see `ground.wgsl` for the layout)
    pub table: Vec<[f32; 4]>,
    /// atlas tiles referenced by the table; touched every frame so the LRU never evicts what is on screen
    pub used: Vec<TileKey>,
    pub zooms: [u8; LEVELS],
    /// tiles in the current windows without any resident imagery yet
    pub missing: usize,
    fresh: Vec<[f32; 4]>,
    last_version: u64,
    last_origins: [Option<(i64, i64)>; LEVELS],
    last_style: u8,
    last_proj: (f64, f64),
    refresh_at: f64,
    fade_until: f64,
}

impl Default for GroundPlan {
    fn default() -> Self {
        Self::new()
    }
}

impl GroundPlan {
    pub fn new() -> Self {
        Self {
            u: GroundU::default(),
            table: vec![[0.0; 4]; PT_W * PT_H],
            used: Vec::with_capacity(1024),
            zooms: [0; LEVELS],
            missing: 0,
            fresh: vec![[0.0; 4]; PT_W * PT_H],
            last_version: 0,
            last_origins: [None; LEVELS],
            last_style: 255,
            last_proj: (f64::NAN, f64::NAN),
            refresh_at: 0.0,
            fade_until: 0.0,
        }
    }

    /// Camera-relative per-level tile origins (written every frame; 8 x 32 bytes, so tile coordinates keep full f32
    /// precision however far from the world origin the aircraft is).
    fn update_uniforms(&mut self, hub: &TileHub, proj: &Projection, cam: (f64, f64)) {
        let st = styles::style(hub.style());
        // the GPU subtracts an f32 camera position from the vertices: use the very same rounded camera here so the
        // imagery and the geometry agree exactly even thousands of kilometres from the origin
        let (cam_x, cam_z) = (cam.0 as f32 as f64, cam.1 as f32 as f64);
        let (c_x, c_y) = (merc_x(proj.lon0) + C / 2.0 + cam_x / proj.k, C / 2.0 - merc_y(proj.lat0) + cam_z / proj.k);
        self.u.misc = [1.0, if st.unlit { 1.0 } else { 0.0 }, 0.0, 0.0];
        for l in 0..LEVELS {
            let z = level_zoom(proj.k, l, st.max_zoom);
            let n = tiles_at(z) as f64;
            let (tx, ty) = (c_x / C * n, c_y / C * n);
            let (bx, by) = (tx.floor(), ty.floor());
            self.u.lv[l] = LevelU { org: [(tx - bx) as f32, (ty - by) as f32, (n / (C * proj.k)) as f32, z as f32], base: [bx as i32, by as i32, 0, 0] };
        }
    }

    /// Refreshes uniforms (always) and the page table (only when something changed). Returns true when the page table
    /// texture must be rewritten.
    pub fn update(&mut self, hub: &TileHub, proj: &Projection, origins: &[Option<(i64, i64)>; LEVELS], cam: (f64, f64), now: f64) -> bool {
        self.update_uniforms(hub, proj, cam);
        let style = hub.style();
        let ver = hub.version();
        let force = *origins != self.last_origins || style != self.last_style || (proj.lat0, proj.lon0) != self.last_proj;
        let tick = now >= self.refresh_at;
        if !force && ver == self.last_version && now >= self.fade_until && !tick {
            return false;
        }
        let request = force || tick;
        if request {
            hub.begin_view();
            self.refresh_at = now + 0.25;
        }
        self.last_origins = *origins;
        self.last_style = style;
        self.last_proj = (proj.lat0, proj.lon0);
        self.last_version = ver;

        let st = styles::style(style);
        self.fresh.fill([0.0; 4]);
        self.used.clear();
        self.missing = 0;
        let mut fading = false;
        let (t_ox, t_oy) = (merc_x(proj.lon0) + C / 2.0, C / 2.0 - merc_y(proj.lat0));
        for l in 0..LEVELS {
            let Some(org) = origins[l] else { continue };
            let s = level_spacing(l);
            let (ox, oz) = (org.0 as f64 * s * 2.0 + s, org.1 as f64 * s * 2.0 + s);
            let ext = (RING_N as f64 / 2.0 + 1.0) * s;
            let z = level_zoom(proj.k, l, st.max_zoom);
            self.zooms[l] = z;
            let n = tiles_at(z) as f64;
            let kk = n / (C * proj.k);
            // tile coordinates of the world origin; the window is anchored to the ring (not the camera)
            let (t0x, t0y) = (t_ox / C * n, t_oy / C * n);
            let tx0 = (t0x + (ox - ext) * kk).floor() as i64;
            let tx1 = ((t0x + (ox + ext) * kk).floor() as i64).min(tx0 + PT_N as i64 - 1);
            let ty0 = (t0y + (oz - ext) * kk).floor() as i64;
            let ty1 = ((t0y + (oz + ext) * kk).floor() as i64).min(ty0 + PT_N as i64 - 1);
            let (cx, cy) = (t0x + cam.0 * kk, t0y + cam.1 * kk);
            for ty in ty0..=ty1 {
                for tx in tx0..=tx1 {
                    let (sx, sy) = (tx.rem_euclid(PT_N as i64) as usize, ty.rem_euclid(PT_N as i64) as usize);
                    let at = ((l * PT_N + sy) * PT_W) + sx * 3;
                    let inside = ty >= 0 && ty < n as i64;
                    // tiles beyond the poles stay "invalid" (w = 0) -> shader falls back to the neutral ground colour
                    if !inside {
                        continue;
                    }
                    let key = TileKey::new(style, z, wrap_x(tx, z), ty as u32);
                    let found = if request {
                        let d = ((tx as f64 + 0.5 - cx).hypot(ty as f64 + 0.5 - cy)) as f32;
                        hub.ensure(key, l as f32 * 2.0 + d)
                    } else {
                        best_resident(hub, key)
                    };
                    let mut a = [-1.0, 1.0, 0.0, 0.0];
                    let mut b = [-1.0, 1.0, 0.0, 0.0];
                    let mut blend = 1.0f32;
                    match found {
                        Some((fk, slot)) => {
                            a = encode(key, fk, slot);
                            self.used.push(fk);
                            if fk == key {
                                blend = slot.alpha(now);
                                if blend < 1.0 {
                                    fading = true;
                                    if let Some((pk, ps)) = key.parent().and_then(|p| best_resident(hub, p)) {
                                        b = encode(key, pk, ps);
                                        self.used.push(pk);
                                    }
                                }
                            }
                        }
                        None => self.missing += 1,
                    }
                    self.fresh[at] = a;
                    self.fresh[at + 1] = b;
                    self.fresh[at + 2] = [blend, tx as f32, ty as f32, 1.0];
                }
            }
        }
        if fading {
            self.fade_until = now + 0.02;
        }
        let changed = self.fresh != self.table;
        if changed {
            std::mem::swap(&mut self.table, &mut self.fresh);
        }
        changed
    }

    /// Marks the referenced tiles as used this frame (call once per frame; one lock, no allocation).
    pub fn touch(&self, hub: &TileHub) {
        hub.touch_all(&self.used);
    }
}

/// Tiles worth warming in the disk cache around an airport (the clipmap windows of the finest 4 levels).
pub fn prefetch_keys(style: u8, lat: f64, lon: f64) -> Vec<TileKey> {
    let st = styles::style(style);
    let k = lat.to_radians().cos().max(1e-3);
    let mut out = Vec::new();
    for l in 0..4usize {
        let z = level_zoom(k, l, st.max_zoom);
        let n = tiles_at(z) as f64;
        let (fx, fy) = (super::math::lon_to_x(lon, z), super::math::lat_to_y(lat, z));
        let r = if l < 2 { 3.0 } else { 4.0 }; // tiles
        let (x0, x1, y0, y1) = ((fx - r).floor() as i64, (fx + r).floor() as i64, (fy - r).floor().max(0.0) as i64, ((fy + r).floor() as i64).min(n as i64 - 1));
        for ty in y0..=y1 {
            for tx in x0..=x1 {
                out.push(TileKey::new(style, z, wrap_x(tx, z), ty as u32));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gfx::geom::{snapped_origin, LEVELS};
    use crate::tiles::hub::testing::{wait_for, FakeFetcher};
    use crate::tiles::math::{lat_to_y, lon_to_x};

    fn origins(x: f64, z: f64) -> [Option<(i64, i64)>; LEVELS] {
        let mut o = [None; LEVELS];
        for (l, slot) in o.iter_mut().enumerate() {
            *slot = Some(snapped_origin(l, x, z));
        }
        o
    }

    /// CPU replica of the fragment shader's page-table addressing.
    fn lookup(plan: &GroundPlan, l: usize, x: f64, z: f64, cam: (f64, f64)) -> ([f32; 4], [f32; 4]) {
        let lv = plan.u.lv[l];
        let (rx, rz) = (x - cam.0, z - cam.1);
        let (tfx, tfy) = (lv.org[0] as f64 + rx * lv.org[2] as f64, lv.org[1] as f64 + rz * lv.org[2] as f64);
        let (ti_x, ti_y) = (tfx.floor() as i64, tfy.floor() as i64);
        let (abx, aby) = (lv.base[0] as i64 + ti_x, lv.base[1] as i64 + ti_y);
        let (sx, sy) = (abx.rem_euclid(PT_N as i64) as usize, aby.rem_euclid(PT_N as i64) as usize);
        let at = (l * PT_N + sy) * PT_W + sx * 3;
        let e2 = plan.table[at + 2];
        assert_eq!((e2[1], e2[2], e2[3]), (abx as f32, aby as f32, 1.0), "level {l} stale/invalid page entry at ({x},{z})");
        (plan.table[at], e2)
    }

    #[test]
    fn zoom_matches_ring_resolution() {
        let k = 37.6f64.to_radians().cos();
        assert_eq!(level_zoom(k, 0, 18), 18);
        assert_eq!(level_zoom(k, 7, 18), 11);
        assert_eq!(level_zoom(1.0, 0, 18), 18);
        assert_eq!(level_zoom(60f64.to_radians().cos(), 0, 18), 17); // finer ground resolution at high latitude -> one level coarser
        assert_eq!(level_zoom(k, 0, 8), 8, "night-lights data stops at z8");
        assert!(level_zoom(0.01, 7, 18) >= MIN_ZOOM);
    }

    #[test]
    fn world_to_tile_mapping_is_exact_mercator() {
        let proj = Projection::new(37.6188, -122.375);
        let hub = TileHub::with_parts(16, FakeFetcher::new(0), None, 0);
        let mut plan = GroundPlan::new();
        plan.update(&hub, &proj, &origins(0.0, 0.0), (0.0, 0.0), 0.0);
        for l in [0usize, 3, 7] {
            let lv = plan.u.lv[l];
            let z = lv.org[3] as u8;
            assert_eq!(z, plan.zooms[l]);
            for (x, zz) in [(0.0, 0.0), (1000.0, 0.0), (0.0, -2000.0), (-3000.0, 4000.0)] {
                let tx = lv.base[0] as f64 + lv.org[0] as f64 + x * lv.org[2] as f64;
                let ty = lv.base[1] as f64 + lv.org[1] as f64 + zz * lv.org[2] as f64;
                let (lat, lon) = (proj.lat(zz), proj.lon(x));
                assert!((tx - lon_to_x(lon, z)).abs() < 2e-4, "x l{l}: {tx} vs {}", lon_to_x(lon, z));
                assert!((ty - lat_to_y(lat, z)).abs() < 2e-4, "y l{l}: {ty} vs {}", lat_to_y(lat, z));
            }
        }
    }

    #[test]
    fn page_table_covers_every_ring_point_at_every_latitude_and_the_antimeridian() {
        for (lat, lon) in [(0.0, 0.0), (37.6188, -122.375), (64.1, -21.9), (-54.8, -68.3), (-17.7, 179.99), (1.36, 103.99)] {
            let proj = Projection::new(lat, lon);
            let hub = TileHub::with_parts(16, FakeFetcher::new(0), None, 0);
            let mut plan = GroundPlan::new();
            for (cx, cz) in [(0.0, 0.0), (7777.0, -12345.0), (-250_000.0, 90_000.0)] {
                plan.update(&hub, &proj, &origins(cx, cz), (cx, cz), 1.0);
                for l in 0..LEVELS {
                    let s = level_spacing(l);
                    let (ox, oz) = (snapped_origin(l, cx, cz).0 as f64 * s * 2.0 + s, snapped_origin(l, cx, cz).1 as f64 * s * 2.0 + s);
                    let half = RING_N as f64 / 2.0 * s;
                    for i in 0..=8 {
                        for j in 0..=8 {
                            let (x, z) = (ox - half + half * 2.0 * i as f64 / 8.0, oz - half + half * 2.0 * j as f64 / 8.0);
                            lookup(&plan, l, x, z, (cx, cz));
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn ancestors_are_addressed_with_correct_scale_and_offset() {
        use crate::tiles::decode::TILE_BYTES;
        use crate::tiles::math::containing;
        let proj = Projection::new(37.6188, -122.375);
        let hub = TileHub::with_parts(64, FakeFetcher::new(0), None, 4);
        let o = origins(0.0, 0.0);
        let mut plan = GroundPlan::new();
        plan.update(&hub, &proj, &o, (0.0, 0.0), 0.0);
        let z0 = plan.zooms[0];
        let key0 = containing(0, proj.lat0, proj.lon0, z0); // the world origin lies inside this tile
        let anc = key0.ancestor(z0 - 6);
        hub.request(anc, -1000.0);
        let mut out = Vec::new();
        assert!(wait_for(
            || {
                hub.take_uploads(TILE_BYTES * 4, &mut out);
                hub.peek(anc).is_some()
            },
            5000
        ));
        // only this thread makes tiles resident (take_uploads), so the expectation below cannot race
        plan.update(&hub, &proj, &o, (0.0, 0.0), 0.1);
        let (fk, slot) = best_resident(&hub, key0).expect("an ancestor is resident");
        assert!(fk.z <= key0.z && fk.z >= 3);
        let want = encode(key0, fk, slot);
        let (e0, e2) = lookup(&plan, 0, 0.0, 0.0, (0.0, 0.0));
        assert_eq!(e0, want);
        assert!(e0[1] > 0.0 && e0[1] <= 1.0 && e0[2] + e0[1] <= 1.0001 && e0[3] + e0[1] <= 1.0001, "sub-rect must lie inside the ancestor: {e0:?}");
        assert_eq!(e2[0], if fk == key0 { slot.alpha(0.1) } else { 1.0 });
        if fk != key0 {
            let dz = key0.z - fk.z;
            assert!((e0[1] as f64 - 1.0 / (1u64 << dz) as f64).abs() < 1e-9);
        }
    }

    #[test]
    fn prefetch_list_is_bounded_and_wrapped() {
        let keys = prefetch_keys(0, 37.6188, -122.375);
        assert!(!keys.is_empty() && keys.len() < 1200, "{}", keys.len());
        assert!(keys.iter().all(|k| k.x < tiles_at(k.z) && k.y < tiles_at(k.z)));
        let anti = prefetch_keys(0, -17.7, 179.99);
        assert!(anti.iter().all(|k| k.x < tiles_at(k.z)));
        assert!(anti.iter().any(|k| k.x == 0) && anti.iter().any(|k| k.x == tiles_at(k.z) - 1), "must wrap across the antimeridian");
    }
}
