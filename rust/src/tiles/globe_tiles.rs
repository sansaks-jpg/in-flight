//! Level-of-detail satellite tiles for the pre-flight globe (port of `src/ui/globeTiles.ts`).
//!
//! * A screen-space quadtree (z = 3 base, split while a tile would be drawn larger than ~300 px) selects the target tiles
//!   for the current orthographic camera; only those are requested (`TileHub::ensure` fetches a mid-level stepping stone and
//!   the z3 base too, so deep zooms sharpen in one round-trip instead of walking 14 levels).
//! * The z <= 3 base of the active style is pinned in the atlas, so there is never a hole anywhere on Earth.
//! * Drawing is painter's order, parents first. A freshly uploaded tile cross-fades in over its parent; the chain of
//!   ancestors is kept only down to the first fully opaque tile, so total opacity never dips during a multi-level change.
//!
//! The module only produces vertices (screen-space triangles with uv / atlas layer / alpha / sphere normal); the GPU does
//! all texturing and day-night shading (`globe.wgsl`).

use super::hub::{Slot, TileHub};
use super::math::{tiles_at, y_to_lat, TileKey};
use super::styles;
use bytemuck::{Pod, Zeroable};
use std::collections::{HashMap, HashSet};
use std::f64::consts::{FRAC_PI_2, TAU};

pub const BASE_Z: u8 = 3;
pub const MAX_GLOBE_VERTS: usize = 150_000;
const SPLIT_PX: f64 = 300.0;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Debug)]
pub struct GlobeV {
    pub pos: [f32; 2],
    pub uv: [f32; 2],
    pub layer: f32,
    pub alpha: f32,
    pub nrm: [f32; 3],
    pub depth: f32,
}

/// Orthographic globe camera in physical pixels.
#[derive(Clone, Copy, Debug)]
pub struct GlobeCam {
    pub lat: f64,
    pub lon: f64,
    pub cx: f32,
    pub cy: f32,
    pub r: f32,
    /// scissor rectangle x, y, w, h
    pub clip: [f32; 4],
}

#[derive(Clone, Copy)]
struct Info {
    key: TileKey,
    c: [f64; 3],
    radius: f64,
    edge: f64,
}

pub fn unit(lat: f64, lon: f64) -> [f64; 3] {
    [lat.cos() * lon.cos(), lat.sin(), -lat.cos() * lon.sin()]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

struct Basis {
    f: [f64; 3],
    e: [f64; 3],
    n: [f64; 3],
}
impl Basis {
    fn new(lat: f64, lon: f64) -> Self {
        Self { f: unit(lat, lon), e: [-lon.sin(), 0.0, -lon.cos()], n: [-lat.sin() * lon.cos(), lat.cos(), lat.sin() * lon.sin()] }
    }
}

#[derive(Default)]
pub struct GlobeTiles {
    infos: HashMap<TileKey, Info>,
    leaves: Vec<Info>,
    order: Vec<(TileKey, Slot)>,
    seen: HashSet<TileKey>,
    used: Vec<TileKey>,
    pub last_leaves: usize,
    pub last_tiles: usize,
    pub last_verts: usize,
}

fn mercator_lat(y: f64, z: u8) -> f64 {
    y_to_lat(y, z).to_radians()
}

impl GlobeTiles {
    pub fn new() -> Self {
        Self::default()
    }

    fn info(&mut self, key: TileKey) -> Info {
        if let Some(i) = self.infos.get(&key) {
            return *i;
        }
        let n = tiles_at(key.z) as f64;
        let (lon0, lon1) = ((key.x as f64 / n * 360.0 - 180.0).to_radians(), ((key.x + 1) as f64 / n * 360.0 - 180.0).to_radians());
        let (lat0, lat1) = (mercator_lat(key.y as f64, key.z), mercator_lat((key.y + 1) as f64, key.z));
        let mid = unit(mercator_lat(key.y as f64 + 0.5, key.z), (lon0 + lon1) * 0.5);
        let mut r = 0.0f64;
        for (la, lo) in [(lat0, lon0), (lat0, lon1), (lat1, lon0), (lat1, lon1)] {
            r = r.max(dot(mid, unit(la, lo)).clamp(-1.0, 1.0).acos());
        }
        let mid_lat = mercator_lat(key.y as f64 + 0.5, key.z);
        let info = Info { key, c: mid, radius: r * 1.02, edge: (TAU / n) * mid_lat.cos().max(0.04) };
        if self.infos.len() > 8000 {
            self.infos.clear();
        }
        self.infos.insert(key, info);
        info
    }

    /// Quadtree walk: fills `leaves` with the tiles to draw for this camera.
    fn select(&mut self, hub: &TileHub, cam: &GlobeCam, b: &Basis, style: u8) {
        self.leaves.clear();
        let max_z = styles::style(style).max_zoom;
        let n0 = tiles_at(BASE_Z);
        let mut stack: Vec<TileKey> = Vec::with_capacity(96);
        for y in (0..n0).rev() {
            for x in (0..n0).rev() {
                stack.push(TileKey::new(style, BASE_Z, x, y));
            }
        }
        let r = cam.r as f64;
        while let Some(key) = stack.pop() {
            let info = self.info(key);
            let (px, py, dp) = (dot(info.c, b.e), dot(info.c, b.n), dot(info.c, b.f));
            let theta = dp.clamp(-1.0, 1.0).acos();
            let alpha = (theta - info.radius).max(0.0);
            if alpha >= FRAC_PI_2 {
                continue;
            }
            // screen-space reject (centre projected, conservative bounding radius)
            let (sx, sy) = (cam.cx as f64 + px * r, cam.cy as f64 - py * r);
            let ext = info.radius * r * 1.05 + 2.0;
            let [cx0, cy0, cw, ch] = cam.clip;
            if sx + ext < cx0 as f64 || sx - ext > (cx0 + cw) as f64 || sy + ext < cy0 as f64 || sy - ext > (cy0 + ch) as f64 {
                continue;
            }
            let size_px = info.edge * r * alpha.cos().max(0.35);
            if key.z < max_z && size_px > SPLIT_PX && !hub.is_failed(key) {
                for dy in 0..2 {
                    for dx in 0..2 {
                        stack.push(key.child(dx, dy));
                    }
                }
                continue;
            }
            self.leaves.push(info);
        }
    }

    /// Selects tiles, schedules loads and appends the textured triangles to `out` (pre-projected to screen pixels).
    /// `now` is the hub clock; `unlit_sun` is only used by the caller for the uniform.
    pub fn draw(&mut self, hub: &TileHub, cam: &GlobeCam, out: &mut Vec<GlobeV>) {
        let now = hub.now();
        let style = hub.style();
        let b = Basis::new(cam.lat, cam.lon);
        self.select(hub, cam, &b, style);
        self.last_leaves = self.leaves.len();

        // request: the whole wanted set is re-stated each frame; stale requests are dropped (fast pans cancel old tiles)
        hub.begin_view();
        self.order.clear();
        self.seen.clear();
        self.used.clear();
        let leaves = std::mem::take(&mut self.leaves);
        for leaf in &leaves {
            let theta_deg = dot(leaf.c, b.f).clamp(-1.0, 1.0).acos().to_degrees() as f32;
            hub.ensure(leaf.key, theta_deg);
            // painter chain: resident ancestors up to (and including) the first fully opaque tile
            let mut k = leaf.key;
            loop {
                if let Some(slot) = hub.peek(k) {
                    if self.seen.insert(k) {
                        self.order.push((k, slot));
                    }
                    self.used.push(k);
                    if slot.alpha(now) >= 1.0 {
                        break;
                    }
                }
                match k.parent() {
                    Some(p) => k = p,
                    None => break,
                }
            }
        }
        self.leaves = leaves;
        hub.touch_all(&self.used);
        self.order.sort_by_key(|(k, _)| (k.z, k.x, k.y));
        self.last_tiles = self.order.len();

        let before = out.len();
        let order = std::mem::take(&mut self.order);
        for (key, slot) in &order {
            if out.len() + 13 * 13 * 6 > MAX_GLOBE_VERTS {
                break;
            }
            emit_tile(out, *key, slot.layer as f32, slot.alpha(now), cam, &b);
        }
        self.order = order;
        self.last_verts = out.len() - before;
    }
}

/// Tessellates one tile into a G x G grid on the sphere (uv exactly linear in Mercator Y), projected orthographically.
fn emit_tile(out: &mut Vec<GlobeV>, key: TileKey, layer: f32, alpha: f32, cam: &GlobeCam, b: &Basis) {
    let n = tiles_at(key.z) as f64;
    let lon0 = key.x as f64 / n * TAU - std::f64::consts::PI;
    let dlon = TAU / n;
    let mid_lat = mercator_lat(key.y as f64 + 0.5, key.z);
    let size = (TAU / n) * mid_lat.cos().max(0.05) * cam.r as f64;
    let g: usize = if size < 40.0 {
        2
    } else if size < 130.0 {
        4
    } else if size < 400.0 {
        8
    } else {
        12
    }
    .max(if key.z <= 4 { 8 } else { 2 });
    let mut lon_cs = [(0.0f64, 0.0f64); 13];
    for (ix, cs) in lon_cs.iter_mut().enumerate().take(g + 1) {
        let lon = lon0 + ix as f64 / g as f64 * dlon;
        *cs = (lon.cos(), lon.sin());
    }
    let mut grid = [GlobeV { pos: [0.0; 2], uv: [0.0; 2], layer, alpha, nrm: [0.0; 3], depth: 0.0 }; 13 * 13];
    let mut front = [false; 13 * 13];
    let mut any = false;
    for iy in 0..=g {
        let v = iy as f64 / g as f64;
        let lat = mercator_lat(key.y as f64 + v, key.z);
        let (sl, cl) = lat.sin_cos();
        for ix in 0..=g {
            let u = ix as f64 / g as f64;
            let p = [cl * lon_cs[ix].0, sl, -cl * lon_cs[ix].1];
            let (x, y, d) = (dot(p, b.e), dot(p, b.n), dot(p, b.f));
            let (sx, sy) = if d >= 0.0 {
                (x, y)
            } else {
                let l = (x * x + y * y).sqrt().max(1e-9);
                (x / l, y / l) // fold back-facing vertices onto the limb
            };
            let i = iy * (g + 1) + ix;
            front[i] = d >= 0.0;
            any |= front[i];
            grid[i] = GlobeV {
                pos: [cam.cx + sx as f32 * cam.r, cam.cy - sy as f32 * cam.r],
                uv: [u as f32, v as f32],
                layer,
                alpha,
                nrm: [p[0] as f32, p[1] as f32, p[2] as f32],
                depth: d as f32,
            };
        }
    }
    if !any {
        return;
    }
    for iy in 0..g {
        for ix in 0..g {
            let (i00, i10, i01, i11) = (iy * (g + 1) + ix, iy * (g + 1) + ix + 1, (iy + 1) * (g + 1) + ix, (iy + 1) * (g + 1) + ix + 1);
            if !(front[i00] || front[i10] || front[i01] || front[i11]) {
                continue;
            }
            for i in [i00, i10, i11, i00, i11, i01] {
                out.push(grid[i]);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::hub::testing::{wait_for, FakeFetcher};

    fn cam(lat: f64, lon: f64, r: f32) -> GlobeCam {
        GlobeCam { lat: lat.to_radians(), lon: lon.to_radians(), cx: 640.0, cy: 360.0, r, clip: [0.0, 0.0, 1280.0, 720.0] }
    }

    fn hub() -> TileHub {
        TileHub::with_parts(256, FakeFetcher::new(0), None, 4)
    }

    #[test]
    fn default_view_selects_the_base_level_only() {
        let h = hub();
        let mut gt = GlobeTiles::new();
        let mut out = Vec::new();
        gt.draw(&h, &cam(0.0, 0.0, 300.0), &mut out);
        assert!(gt.last_leaves > 8 && gt.last_leaves <= 64, "{}", gt.last_leaves);
        assert!(gt.leaves.iter().all(|l| l.key.z == BASE_Z), "whole globe at r=300 needs only z3");
    }

    #[test]
    fn zooming_in_refines_and_culls_to_the_visible_region() {
        let h = hub();
        let mut gt = GlobeTiles::new();
        let mut out = Vec::new();
        gt.draw(&h, &cam(37.6, -122.4, 300.0 * 24.0), &mut out);
        let deepest = gt.leaves.iter().map(|l| l.key.z).max().unwrap();
        assert!((7..=10).contains(&deepest), "deepest {deepest}");
        assert!(gt.last_leaves < 80, "culling must keep the leaf count small: {}", gt.last_leaves);
        // everything selected must actually be near the view centre
        let b = Basis::new(37.6f64.to_radians(), (-122.4f64).to_radians());
        assert!(gt.leaves.iter().all(|l| dot(l.c, b.f) > 0.9));
    }

    #[test]
    fn leaf_count_and_vertex_budget_stay_bounded_for_every_zoom_and_pole() {
        let h = hub();
        let mut gt = GlobeTiles::new();
        for (lat, lon, r) in [(0.0, 0.0, 210.0), (89.0, 0.0, 300.0), (-85.0, 170.0, 900.0), (0.0, 179.9, 18_000.0), (45.0, 90.0, 90_000.0), (1.3, 103.9, 70_000.0)] {
            let mut out = Vec::new();
            // give the loader a chance so resident chains are exercised too
            gt.draw(&h, &cam(lat, lon, r), &mut out);
            assert!(out.len() <= MAX_GLOBE_VERTS, "{} verts at {lat},{lon},{r}", out.len());
            assert!(gt.last_leaves < 400, "{} leaves at {lat},{lon},{r}", gt.last_leaves);
            assert!(out.iter().all(|v| v.pos[0].is_finite() && v.pos[1].is_finite() && v.uv[0] >= 0.0 && v.uv[0] <= 1.0));
        }
    }

    #[test]
    fn resident_tiles_are_drawn_parents_first_and_fade_in() {
        let h = hub();
        let mut gt = GlobeTiles::new();
        let mut out = Vec::new();
        let c = cam(20.0, 30.0, 300.0 * 6.0);
        gt.draw(&h, &c, &mut out);
        assert!(out.is_empty(), "nothing is resident yet -> nothing drawn (procedural underlay shows)");
        let mut up = Vec::new();
        assert!(wait_for(
            || {
                h.take_uploads(usize::MAX / 2, &mut up);
                gt.draw(&h, &c, &mut Vec::new());
                h.stats().resident >= 6 && !h.busy()
            },
            8000
        ));
        out.clear();
        gt.draw(&h, &c, &mut out);
        assert!(!out.is_empty());
        assert!(gt.last_tiles >= gt.last_leaves / 2);
        // painter order: layer-alpha pairs never decrease in zoom (checked through the sorted key order)
        let zs: Vec<u8> = gt.order.iter().map(|(k, _)| k.z).collect();
        assert!(zs.windows(2).all(|w| w[0] <= w[1]));
        assert!(out.iter().all(|v| (0.0..=1.0).contains(&v.alpha)));
    }

    #[test]
    fn cpu_cost_of_a_globe_frame_is_far_below_the_frame_budget() {
        let h = hub();
        let mut gt = GlobeTiles::new();
        let c = cam(35.0, 10.0, 300.0 * 8.0);
        let mut up = Vec::new();
        assert!(wait_for(
            || {
                h.take_uploads(usize::MAX / 2, &mut up);
                gt.draw(&h, &c, &mut Vec::new());
                h.stats().resident >= 12 && !h.busy()
            },
            10_000
        ));
        let mut out = Vec::with_capacity(MAX_GLOBE_VERTS);
        let t = std::time::Instant::now();
        let mut worst = 0.0f64;
        for i in 0..200 {
            out.clear();
            let ti = std::time::Instant::now();
            gt.draw(&h, &GlobeCam { lon: c.lon + i as f64 * 0.001, ..c }, &mut out);
            worst = worst.max(ti.elapsed().as_secs_f64() * 1000.0);
        }
        let mean = t.elapsed().as_secs_f64() * 1000.0 / 200.0;
        assert!(!out.is_empty());
        assert!(mean < 4.0 && worst < 12.0, "globe tile CPU: mean {mean:.2} ms, worst {worst:.2} ms");
    }

    #[test]
    fn mercator_uv_is_linear_in_screen_latitude_mapping() {
        // corners of a tile hit the exact tile edges
        let key = TileKey::new(0, 5, 10, 12);
        let mut out = Vec::new();
        let c = cam(0.0, 0.0, 300.0);
        let b = Basis::new(c.lat, c.lon);
        emit_tile(&mut out, key, 3.0, 1.0, &c, &b);
        let n = 32.0f64;
        let top = out.iter().find(|v| v.uv == [0.0, 0.0]).unwrap();
        let expect_lat = y_to_lat(12.0, 5).to_radians();
        let expect_lon = (10.0 / n * 360.0 - 180.0f64).to_radians();
        let p = unit(expect_lat, expect_lon);
        assert!((top.nrm[0] as f64 - p[0]).abs() < 1e-6 && (top.nrm[1] as f64 - p[1]).abs() < 1e-6 && (top.nrm[2] as f64 - p[2]).abs() < 1e-6);
        assert_eq!(top.layer, 3.0);
    }
}
