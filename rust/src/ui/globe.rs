//! Interactive 3D globe (port of `globeCamera.ts` / `globeTiles.ts` / the `InteractiveEarthGlobe` of `PreGameVisuals.tsx`).
//!
//! The Earth is an orthographic sphere tessellated into lat/lon cells that are Gouraud-shaded straight into the 2D batch
//! renderer: land comes from an embedded 0.5° mask (Natural Earth 110 m, see `tools/gen_land_mask.py`), the day/night
//! terminator and twilight glow from the real sub-solar point at the current UTC (`clock::subsolar_point`, NOAA
//! equations), airports glow as "city lights" on the night side. Dragging spins the globe with inertia, the wheel zooms,
//! and [`Globe::fly_to`] performs the Google-Earth-style eased great-circle flight with a pull-back arc.

use super::{Gui, ACCENT, AMBER, DIM, MAGENTA, MUTED};
use crate::tiles::globe_tiles::{GlobeCam, GlobeTiles};
use crate::tiles::styles;
use crate::airports::{Airport, AirportDb};
use crate::clock::subsolar_point;
use crate::gfx::ui::{Col, Ui};
use std::f64::consts::{PI, TAU};

/// Mean Earth radius (m): the sphere the globe, the tiles and the runway overlay share.
pub const EARTH_R_M: f64 = 6_371_000.0;
/// Zoom range (multiples of the whole-globe framing). `MAX_ZOOM` puts the camera ~0.55 km above the ground like
/// `MAX_GLOBE_ZOOM` of `PreGameVisuals.tsx` (<= 0.6 m/px = the z18 satellite resolution), `MIN_ZOOM` shows the whole disc.
pub const MIN_ZOOM: f64 = 0.7;
pub const MAX_ZOOM: f64 = 48_000.0;
/// Zoom at which one globe-view height covers 1 km of ground for the planner globe (`view.r = 0.46 * min(w, h)`):
/// `zoom = ZOOM_KM / visible_km` (see [`zoom_for_visible_km`]).
const ZOOM_KM: f64 = 13_834.0;
/// Runway markings fade in between these ground resolutions (m / px), `RUNWAY_FADE_*_MPP` of `globeRunways.ts`.
pub const RUNWAY_FADE_FAR_MPP: f64 = 24.0;
pub const RUNWAY_FADE_NEAR_MPP: f64 = 8.0;

const MASK_W: usize = 720;
const MASK_H: usize = 360;
static LAND_MASK: &[u8] = include_bytes!("../../assets/land_mask.bin");

#[inline]
fn mask_bit(ix: i32, iy: i32) -> f32 {
    let x = ix.rem_euclid(MASK_W as i32) as usize;
    let y = iy.clamp(0, MASK_H as i32 - 1) as usize;
    let i = y * MASK_W + x;
    ((LAND_MASK[i >> 3] >> (7 - (i & 7))) & 1) as f32
}

/// Smoothed land coverage 0..1 at a lat/lon (degrees): bilinear over the 0.5° mask.
pub fn land_at(lat: f64, lon: f64) -> f32 {
    let fx = (lon + 180.0) / 360.0 * MASK_W as f64 - 0.5;
    let fy = (90.0 - lat) / 180.0 * MASK_H as f64 - 0.5;
    let (x0, y0) = (fx.floor(), fy.floor());
    let (tx, ty) = ((fx - x0) as f32, (fy - y0) as f32);
    let (ix, iy) = (x0 as i32, y0 as i32);
    let a = mask_bit(ix, iy) * (1.0 - tx) + mask_bit(ix + 1, iy) * tx;
    let b = mask_bit(ix, iy + 1) * (1.0 - tx) + mask_bit(ix + 1, iy + 1) * tx;
    a * (1.0 - ty) + b * ty
}

/// Hard land/sea test (nearest mask pixel).
pub fn is_land(lat: f64, lon: f64) -> bool {
    mask_bit(((lon + 180.0) / 360.0 * MASK_W as f64) as i32, ((90.0 - lat) / 180.0 * MASK_H as f64) as i32) > 0.5
}

// ------------------------------------------------------------------------------------------------ camera helpers

pub fn ease_in_out_cubic(t: f64) -> f64 {
    if t < 0.5 {
        4.0 * t * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
    }
}
pub fn ease_in_out_sine(t: f64) -> f64 {
    -((PI * t).cos() - 1.0) / 2.0
}
pub fn smooth01(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}
pub fn wrap_pi(a: f64) -> f64 {
    (a + PI).rem_euclid(TAU) - PI
}

/// Great-circle angular distance (rad).
pub fn angular_distance(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    (lat1.sin() * lat2.sin() + lat1.cos() * lat2.cos() * (lon2 - lon1).cos()).clamp(-1.0, 1.0).acos()
}

/// Spherical interpolation along the great circle (t 0..1). Radians in, radians out; longitude stays continuous with `lon1`.
pub fn slerp_lat_lon(lat1: f64, lon1: f64, lat2: f64, lon2: f64, t: f64) -> (f64, f64) {
    let d = angular_distance(lat1, lon1, lat2, lon2);
    if d < 1e-7 {
        return (lat2, lon1 + wrap_pi(lon2 - lon1) * t);
    }
    let a = ((1.0 - t) * d).sin() / d.sin();
    let b = (t * d).sin() / d.sin();
    let x = a * lat1.cos() * lon1.cos() + b * lat2.cos() * lon2.cos();
    let y = a * lat1.cos() * lon1.sin() + b * lat2.cos() * lon2.sin();
    let z = a * lat1.sin() + b * lat2.sin();
    (z.atan2(x.hypot(y)), lon1 + wrap_pi(y.atan2(x) - lon1))
}

/// Timed camera flight: position follows the great circle with ease-in-out; zoom eases separately and pulls back over the
/// middle of long hops. Duration 1.2 – 3.8 s.
#[derive(Clone, Copy, Debug)]
pub struct GlobeFlight {
    t0: f64,
    dur: f64,
    lat0: f64,
    lon0: f64,
    lat1: f64,
    lon1: f64,
    lz0: f64,
    lz1: f64,
    arc: f64,
}

impl GlobeFlight {
    pub fn start(now: f64, from: (f64, f64, f64), to: (f64, f64, f64)) -> Self {
        let lon1 = from.1 + wrap_pi(to.1 - from.1);
        let (lz0, lz1) = (from.2.max(1.0).ln(), to.2.max(1.0).ln());
        let dist = angular_distance(from.0, from.1, to.0, lon1);
        let dz = (lz1 - lz0).abs();
        let dur = (0.85 + dist * 1.9 + dz * 0.13).clamp(1.2, 3.8);
        let hi = lz0.max(lz1);
        Self { t0: now, dur, lat0: from.0, lon0: from.1, lat1: to.0, lon1, lz0, lz1, arc: hi.min(dist * 2.4) }
    }
    pub fn duration(&self) -> f64 {
        self.dur
    }
    /// (lat, lon, zoom, finished)
    pub fn sample(&self, now: f64) -> (f64, f64, f64, bool) {
        let t = ((now - self.t0) / self.dur).clamp(0.0, 1.0);
        let (lat, lon) = slerp_lat_lon(self.lat0, self.lon0, self.lat1, self.lon1, ease_in_out_cubic(t));
        let base = self.lz0 + (self.lz1 - self.lz0) * ease_in_out_sine(t);
        let zoom = (base - self.arc * (PI * smooth01(t)).sin()).max(0.0).exp();
        if t >= 1.0 {
            (self.lat1, self.lon1, self.lz1.exp(), true)
        } else {
            (lat, lon, zoom, false)
        }
    }
}

/// Zoom that shows `visible_km` of ground over the height of the planner globe view.
pub fn zoom_for_visible_km(visible_km: f64) -> f64 {
    (ZOOM_KM / visible_km.max(0.05)).clamp(MIN_ZOOM, MAX_ZOOM)
}

/// Smooth fade-in of the runway layer from the ground resolution (port of `runwayAlpha`).
pub fn runway_alpha(metres_per_px: f64) -> f64 {
    let t = ((RUNWAY_FADE_FAR_MPP - metres_per_px) / (RUNWAY_FADE_FAR_MPP - RUNWAY_FADE_NEAR_MPP)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Camera that frames a whole airfield (every runway) in ~55 % of the view height, centred on the runways
/// (port of `frameAirportView`): (lat°, lon°, zoom).
pub fn frame_airport(a: &Airport) -> (f64, f64, f64) {
    let (mut min_la, mut max_la, mut min_lo, mut max_lo) = (90.0f64, -90.0f64, 180.0f64, -180.0f64);
    for rw in &a.runways {
        for (la, lo) in [(rw.le_lat, rw.le_lon), (rw.he_lat, rw.he_lon)] {
            min_la = min_la.min(la);
            max_la = max_la.max(la);
            min_lo = min_lo.min(lo);
            max_lo = max_lo.max(lo);
        }
    }
    if min_la > max_la {
        return (a.lat, a.lon, zoom_for_visible_km(4.0 / 0.4));
    }
    let extent_km = (crate::geo::haversine(min_la, min_lo, max_la, max_lo) / 1000.0).max(1.6);
    ((min_la + max_la) * 0.5, (min_lo + max_lo) * 0.5, zoom_for_visible_km(extent_km / 0.55).max(zoom_for_visible_km(45.0)))
}

/// Zoom framing a route (port of `computeRouteFocusView`): (lat°, lon°, zoom).
pub fn route_focus(dep: &Airport, arr: &Airport) -> (f64, f64, f64) {
    let u = |a: &Airport| unit(a.lat * crate::geo::D2R, a.lon * crate::geo::D2R);
    let (p, q) = (u(dep), u(arr));
    let m = [(p[0] + q[0]) * 0.5, (p[1] + q[1]) * 0.5, (p[2] + q[2]) * 0.5];
    let len = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).sqrt();
    if len < 1e-5 {
        return (dep.lat, dep.lon, 1.5);
    }
    let (mx, my, mz) = (m[0] / len, m[1] / len, m[2] / len);
    let lat = my.clamp(-1.0, 1.0).asin().to_degrees();
    let lon = (-mz).atan2(mx).to_degrees();
    let km = crate::geo::haversine(dep.lat, dep.lon, arr.lat, arr.lon) / 1000.0;
    let zoom = if km < 120.0 {
        24.0
    } else if km < 300.0 {
        12.0
    } else if km < 650.0 {
        6.0
    } else if km < 1400.0 {
        3.4
    } else if km < 3000.0 {
        2.1
    } else {
        1.35
    };
    (lat, lon, zoom)
}

/// Unit-sphere vector (matches the three.js SphereGeometry layout used by the web globe).
pub fn unit(lat: f64, lon: f64) -> [f64; 3] {
    [lat.cos() * lon.cos(), lat.sin(), -lat.cos() * lon.sin()]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/// Number of threshold stripes by runway width (ICAO Annex 14).
fn stripe_count(width_m: f32) -> usize {
    if width_m >= 60.0 {
        16
    } else if width_m >= 45.0 {
        12
    } else if width_m >= 30.0 {
        8
    } else if width_m >= 23.0 {
        6
    } else {
        4
    }
}

/// A runway placed on the screen: origin = LE end, unit direction towards the HE end, pixels per metre along it.
#[derive(Clone, Copy, Debug)]
pub struct RunwayFrame {
    pub o: [f64; 2],
    pub u: [f64; 2],
    pub len_px: f64,
    pub len_m: f64,
    pub k: f64,
}

impl RunwayFrame {
    /// Projects the two runway ends (database coordinates) through the orthographic camera `b` centred on (cx, cy) with
    /// radius `r` px. `None` when an end is behind the horizon or the runway is degenerate.
    fn project(b: &Basis, cx: f64, cy: f64, r: f64, rw: &crate::airports::Runway) -> Option<Self> {
        let end = |lat: f64, lon: f64| {
            let (x, y, d) = b.proj(unit(lat.to_radians(), lon.to_radians()));
            (d > 0.0).then(|| [cx + x * r, cy - y * r])
        };
        let (p, q) = (end(rw.le_lat, rw.le_lon)?, end(rw.he_lat, rw.he_lon)?);
        let (dx, dy) = (q[0] - p[0], q[1] - p[1]);
        let len_px = dx.hypot(dy);
        let len_m = crate::geo::haversine(rw.le_lat, rw.le_lon, rw.he_lat, rw.he_lon);
        (len_px > 1e-6 && len_m > 1.0).then(|| Self { o: p, u: [dx / len_px, dy / len_px], len_px, len_m, k: len_px / len_m })
    }
}

/// Screen frame of a runway for a camera centred on (lat°, lon°) at `zoom` in a view of radius `r0` px: test / tooling hook.
pub fn runway_frame_at(lat_deg: f64, lon_deg: f64, zoom: f64, r0: f64, rw: &crate::airports::Runway) -> Option<RunwayFrame> {
    let b = Basis::new(lat_deg.to_radians(), lon_deg.to_radians());
    RunwayFrame::project(&b, 0.0, 0.0, r0 * zoom, rw)
}

// ------------------------------------------------------------------------------------------------ globe

/// Where the globe sits on screen (virtual pixels): centre and radius at zoom 1, plus the clip rectangle.
#[derive(Clone, Copy, Debug)]
pub struct GlobeView {
    pub cx: f32,
    pub cy: f32,
    pub r: f32,
    pub clip: [f32; 4],
}

#[derive(Default, Clone, Copy)]
pub struct Marks {
    pub dep: Option<usize>,
    pub arr: Option<usize>,
    pub hover_lock: bool,
    /// chosen departure / arrival runway end: (runway index in the airport, 0 = LE, 1 = HE)
    pub dep_rwy: Option<(usize, u8)>,
    pub arr_rwy: Option<(usize, u8)>,
}

#[derive(Default, Clone, Copy, Debug, PartialEq)]
pub struct GlobeOut {
    pub picked: Option<usize>,
    pub hover: Option<usize>,
    /// the user zoomed or panned the globe this frame (drives the menu -> route-selection transition)
    pub engaged: bool,
}

/// Pointer travel (physical px) after which a press on the globe counts as a pan, not a click.
pub const PAN_THRESHOLD_PX: f32 = 6.0;

#[derive(Clone, Copy)]
struct Vtx {
    x: f32,
    y: f32,
    col: Col,
    front: bool,
}

pub struct Globe {
    /// view centre, radians
    pub lat: f64,
    pub lon: f64,
    pub zoom: f64,
    vlat: f64,
    vlon: f64,
    fly: Option<GlobeFlight>,
    dragging: bool,
    drag_dist: f32,
    idle: f64,
    clock: f64,
    pub auto_rotate: bool,
    /// draw airport markers / runways (false on the boot + menu globe, which is a bare rotating Earth)
    pub markers: bool,
    /// resume the idle rotation when the current fly-to ends (set by [`Globe::reset_to_menu`])
    rotate_after_fly: bool,
    row_a: Vec<Vtx>,
    row_b: Vec<Vtx>,
    /// number of cells emitted last frame (diagnostics / budget tests)
    pub last_cells: usize,
    /// satellite / map tile LOD (textured on top of the procedural surface when a tile hub is attached)
    pub tiles: GlobeTiles,
}

struct Basis {
    f: [f64; 3],
    e: [f64; 3],
    n: [f64; 3],
}

impl Basis {
    fn new(lat: f64, lon: f64) -> Self {
        Self {
            f: unit(lat, lon),
            e: [-lon.sin(), 0.0, -lon.cos()],
            n: [-lat.sin() * lon.cos(), lat.cos(), lat.sin() * lon.sin()],
        }
    }
    /// (screen x offset, screen y offset (up positive), depth) for a unit vector.
    fn proj(&self, p: [f64; 3]) -> (f64, f64, f64) {
        (dot(p, self.e), dot(p, self.n), dot(p, self.f))
    }
}

impl Default for Globe {
    fn default() -> Self {
        Self::new()
    }
}

impl Globe {
    pub fn new() -> Self {
        Self {
            lat: -2.5f64.to_radians(),
            lon: 115.0f64.to_radians(),
            zoom: 1.0,
            vlat: 0.0,
            vlon: 0.0,
            fly: None,
            dragging: false,
            drag_dist: 0.0,
            idle: 0.0,
            clock: 0.0,
            auto_rotate: true,
            markers: true,
            rotate_after_fly: false,
            row_a: Vec::with_capacity(512),
            row_b: Vec::with_capacity(512),
            last_cells: 0,
            tiles: GlobeTiles::new(),
        }
    }

    pub fn is_flying(&self) -> bool {
        self.fly.is_some()
    }

    /// Eased fly-to (degrees in): great-circle motion with a pull-back arc.
    pub fn fly_to(&mut self, lat_deg: f64, lon_deg: f64, zoom: f64) {
        self.fly = Some(GlobeFlight::start(self.clock, (self.lat, self.lon, self.zoom), (lat_deg.to_radians(), lon_deg.to_radians(), zoom)));
        self.vlat = 0.0;
        self.vlon = 0.0;
        self.auto_rotate = false;
    }

    pub fn snap_to(&mut self, lat_deg: f64, lon_deg: f64, zoom: f64) {
        self.lat = lat_deg.to_radians();
        self.lon = lon_deg.to_radians();
        self.zoom = zoom.clamp(MIN_ZOOM, MAX_ZOOM);
        self.fly = None;
        self.auto_rotate = false;
    }

    /// Back to the bare rotating Earth of the main menu: eases out to the whole-globe framing, then spins again.
    pub fn reset_to_menu(&mut self) {
        self.fly_to(self.lat.to_degrees(), self.lon.to_degrees(), 1.0);
        self.rotate_after_fly = true;
    }

    fn radius_px(&self, v: &GlobeView, s: f32) -> f32 {
        v.r * s * self.zoom as f32
    }

    fn visible_airport(size: u8, zoom: f64) -> bool {
        if zoom < 2.5 {
            size == 0
        } else if zoom < 7.0 {
            size <= 1
        } else {
            true
        }
    }

    /// Interaction + drawing for one frame. `interactive` enables drag / wheel / picking.
    pub fn run(&mut self, g: &mut Gui, view: GlobeView, utc: f64, db: &AirportDb, marks: Marks, interactive: bool, dt: f64) -> GlobeOut {
        self.clock += dt;
        let s = g.s;
        let (cx, cy) = (view.cx * s, view.cy * s);
        let r = self.radius_px(&view, s);
        let mut out = GlobeOut::default();

        // ---------------- interaction
        let m = g.inp.mouse;
        let picker = Self::picker_rect(&view);
        let on_picker = g.ui.tiles.is_some() && g.hover(picker[0], picker[1], picker[2], picker[3]);
        let in_clip = g.hover(view.clip[0], view.clip[1], view.clip[2], view.clip[3]) && !on_picker;
        let in_disc = in_clip && ((m[0] - cx).powi(2) + (m[1] - cy).powi(2)) <= r * r;
        if interactive {
            if g.pressed() && in_clip {
                self.dragging = true;
                self.drag_dist = 0.0;
                self.vlat = 0.0;
                self.vlon = 0.0;
                self.fly = None;
                self.rotate_after_fly = false;
            }
            if self.dragging {
                if g.inp.down {
                    let (dx, dy) = (g.inp.delta[0] as f64, g.inp.delta[1] as f64);
                    self.drag_dist += (dx.abs() + dy.abs()) as f32;
                    if self.drag_dist >= PAN_THRESHOLD_PX {
                        out.engaged = true;
                    }
                    let k = 1.0 / r as f64;
                    let dlon = -dx * k / self.lat.cos().abs().max(0.35);
                    let dlat = dy * k;
                    self.lon += dlon;
                    self.lat = (self.lat + dlat).clamp(-1.45, 1.45);
                    let inv = 1.0 / dt.max(1e-3);
                    self.vlon = self.vlon * 0.6 + dlon * inv * 0.4;
                    self.vlat = self.vlat * 0.6 + dlat * inv * 0.4;
                    self.idle = 0.0;
                }
                if g.inp.released || !g.inp.down {
                    self.dragging = false;
                    if self.drag_dist < 5.0 {
                        self.vlon = 0.0;
                        self.vlat = 0.0;
                        if self.markers {
                            out.picked = self.pick(db, &view, s, m);
                        }
                    }
                }
            }
            if in_clip && g.inp.wheel != 0.0 {
                // ~1.2x per mouse notch (like `wheelZoomDelta` in `globeCamera.ts`); exponential so the same gesture feels
                // identical from orbit down to the runway
                self.zoom = (self.zoom * (g.inp.wheel as f64 * 0.18).exp()).clamp(MIN_ZOOM, MAX_ZOOM);
                self.fly = None;
                self.idle = 0.0;
                self.rotate_after_fly = false;
                out.engaged = true;
            }
        }
        if let Some(f) = self.fly {
            let (la, lo, z, done) = f.sample(self.clock);
            self.lat = la;
            self.lon = lo;
            self.zoom = z;
            if done {
                self.fly = None;
                if std::mem::take(&mut self.rotate_after_fly) {
                    self.auto_rotate = true;
                    self.idle = 0.0;
                }
            }
        } else if !self.dragging {
            // inertia
            self.lon += self.vlon * dt;
            self.lat = (self.lat + self.vlat * dt).clamp(-1.45, 1.45);
            let decay = (-3.2 * dt).exp();
            self.vlon *= decay;
            self.vlat *= decay;
            self.idle += dt;
            if self.auto_rotate && self.idle > 0.5 {
                self.lon += 2.2f64.to_radians() * dt;
            }
        }
        self.lon = wrap_pi(self.lon);
        let r = self.radius_px(&view, s);
        if interactive && self.markers && !self.dragging && in_disc && !marks.hover_lock {
            out.hover = self.pick(db, &view, s, m);
        }

        // ---------------- drawing
        let (sl, so) = subsolar_point(utc);
        let sun = unit(sl.to_radians(), so.to_radians());
        let b = Basis::new(self.lat, self.lon);
        let clip = view.clip;
        g.scissor(Some(clip));
        // limb / terminator / sun decorations are meaningless (and numerically huge) once the camera is near the ground
        let orbital = self.zoom < 60.0;
        if orbital {
            self.draw_atmosphere(g, cx, cy, r, &b, &sun);
        }
        self.draw_surface(g, cx, cy, r, &b, &sun, &view);
        self.draw_tiles(g, cx, cy, r, &sun, &view);
        if self.zoom < 3.5 {
            self.draw_graticule(g, cx, cy, r, &b);
        }
        if orbital {
            self.draw_terminator(g, cx, cy, r, &b, &sun);
        }
        if self.markers {
            let rw_alpha = runway_alpha(EARTH_R_M / r as f64) as f32;
            self.draw_airports(g, cx, cy, r, &b, &sun, db, marks, rw_alpha);
            if rw_alpha > 0.01 {
                self.draw_runways(g, cx, cy, r, &b, db, marks, rw_alpha, &view);
            }
            self.draw_route(g, cx, cy, r, &b, db, marks);
        }
        if orbital {
            self.draw_sun_marker(g, cx, cy, r, &b, &sun);
        }
        self.draw_layer_picker(g, &view);
        g.scissor(None);
        out
    }

    /// Streams + draws the satellite tile layer (GPU textured, day/night shaded). No-op without a tile hub.
    fn draw_tiles(&mut self, g: &mut Gui, cx: f32, cy: f32, r: f32, sun: &[f64; 3], view: &GlobeView) {
        let Some(hub) = g.ui.tiles.clone() else { return };
        let s = g.s;
        let cam = GlobeCam { lat: self.lat, lon: self.lon, cx, cy, r, clip: [view.clip[0] * s, view.clip[1] * s, view.clip[2] * s, view.clip[3] * s] };
        g.ui.globe_sun = [sun[0] as f32, sun[1] as f32, sun[2] as f32, if styles::style(hub.style()).unlit { 1.0 } else { 0.0 }];
        let start = g.ui.globe_begin();
        self.tiles.draw(&hub, &cam, &mut g.ui.gverts);
        g.ui.globe_end(start);
    }

    const PICK_W: f32 = 66.0;
    const PICK_H: f32 = 20.0;
    const PICK_GAP: f32 = 4.0;

    /// Bottom-right corner of the globe area: [x, y, w, h] of the map-style chip row (virtual px).
    fn picker_rect(view: &GlobeView) -> [f32; 4] {
        let n = styles::STYLES.len() as f32;
        let w = n * (Self::PICK_W + Self::PICK_GAP) - Self::PICK_GAP;
        [view.clip[0] + view.clip[2] - 8.0 - w, view.clip[1] + view.clip[3] - 8.0 - Self::PICK_H, w, Self::PICK_H]
    }

    /// Map layer selector (satellite / Sentinel-2 / streets / terrain / night lights / dark) + attribution + load status.
    fn draw_layer_picker(&mut self, g: &mut Gui, view: &GlobeView) {
        let Some(hub) = g.ui.tiles.clone() else { return };
        let [x0, y, w, _] = Self::picker_rect(view);
        let cur = hub.style();
        let right = x0 + w;
        g.rect(x0 - 6.0, y - 24.0, w + 12.0, Self::PICK_H + 30.0, [0.0, 0.0, 0.0, 0.38]);
        for (i, st) in styles::STYLES.iter().enumerate() {
            if g.chip(x0 + i as f32 * (Self::PICK_W + Self::PICK_GAP), y, Self::PICK_W, Self::PICK_H, st.short, i as u8 == cur) {
                hub.set_style(i as u8);
            }
        }
        let st = styles::style(cur);
        g.textf(right, y - 20.0, 9.0, DIM, 2, format_args!("MAP: {}", st.name.to_uppercase()));
        let s = hub.stats();
        if hub.busy() {
            g.textf(x0, y - 20.0, 9.0, AMBER, 0, format_args!("LOADING {} TILES", s.queued + s.inflight + s.ready));
        } else if s.net_fail > 0 && s.resident == 0 {
            g.text(x0, y - 20.0, 9.0, AMBER, 0, "OFFLINE - CACHED TILES ONLY");
        }
        g.text(right, y - 10.0, 8.0, MUTED, 2, st.attribution);
    }

    /// Nearest drawn airport to a screen point (physical px), within ~14 px.
    fn pick(&self, db: &AirportDb, view: &GlobeView, s: f32, m: [f32; 2]) -> Option<usize> {
        let (cx, cy) = (view.cx * s, view.cy * s);
        let r = self.radius_px(view, s) as f64;
        let b = Basis::new(self.lat, self.lon);
        let mut best: Option<(usize, f64)> = None;
        for (i, a) in db.airports.iter().enumerate() {
            if !Self::visible_airport(a.size, self.zoom) {
                continue;
            }
            let (x, y, d) = b.proj(unit(a.lat.to_radians(), a.lon.to_radians()));
            if d <= 0.02 {
                continue;
            }
            let (sx, sy) = (cx as f64 + x * r, cy as f64 - y * r);
            let dist = ((sx - m[0] as f64).powi(2) + (sy - m[1] as f64).powi(2)).sqrt();
            let score = dist - (2 - a.size) as f64 * 2.5;
            if dist < 14.0 * s as f64 && best.map_or(true, |(_, bs)| score < bs) {
                best = Some((i, score));
            }
        }
        best.map(|(i, _)| i)
    }

    fn draw_atmosphere(&mut self, g: &mut Gui, cx: f32, cy: f32, r: f32, b: &Basis, sun: &[f64; 3]) {
        // soft blue halo outside the limb, brighter towards the sun side
        let lit = (dot(*sun, b.f) * 0.5 + 0.5).clamp(0.0, 1.0) as f32;
        let n = 64;
        let w = r * 0.085;
        for k in 0..n {
            let (a0, a1) = (k as f32 / n as f32 * std::f32::consts::TAU, (k + 1) as f32 / n as f32 * std::f32::consts::TAU);
            let sun_side = |a: f32| {
                let (sx, sy) = (dot(*sun, b.e) as f32, dot(*sun, b.n) as f32);
                let l = (a.cos() * sx - a.sin() * sy).clamp(-1.0, 1.0); // screen y is down
                0.35 + 0.65 * (l * 0.5 + 0.5)
            };
            let (c0, c1) = (sun_side(a0), sun_side(a1));
            let inner = |c: f32| [0.25, 0.55, 1.0, 0.42 * c * (0.4 + 0.6 * lit)];
            let outer = [0.2, 0.45, 1.0, 0.0];
            let p = |a: f32, rr: f32| [cx + a.cos() * rr, cy + a.sin() * rr];
            g.ui.quad_c([p(a0, r * 0.995), p(a1, r * 0.995), p(a1, r + w), p(a0, r + w)], [inner(c0), inner(c1), outer, outer]);
        }
    }

    fn shade(lat: f64, lon: f64, p: [f64; 3], sun: &[f64; 3], depth: f64) -> Col {
        let l = dot(p, *sun) as f32;
        let day = smoothstep(-0.105, 0.14, l);
        let land = smoothstep(0.30, 0.70, land_at(lat, lon));
        let alat = lat.abs() as f32;
        // pseudo-biomes: arid belts + polar ice, mottled by cheap noise
        let nz = ((lon as f32 * 0.19 + lat as f32 * 0.31).sin() * (lat as f32 * 0.43 - lon as f32 * 0.13).sin()) * 0.5 + 0.5;
        let green = [0.16 + 0.07 * nz, 0.36 + 0.10 * nz, 0.15];
        let arid = [0.60 + 0.08 * nz, 0.49 + 0.06 * nz, 0.30];
        let ice = [0.86, 0.90, 0.94];
        let mut land_c = lerp3(green, arid, smoothstep(14.0, 24.0, alat) * (1.0 - smoothstep(34.0, 42.0, alat)) * smoothstep(0.35, 0.6, nz));
        land_c = lerp3(land_c, ice, smoothstep(58.0, 70.0, alat));
        let lit = 0.30 + 0.70 * l.max(0.0).powf(0.7);
        let ocean_day = [0.03 + 0.05 * lit, 0.16 + 0.17 * lit, 0.34 + 0.26 * lit];
        let day_c = lerp3(ocean_day, [land_c[0] * lit, land_c[1] * lit, land_c[2] * lit], land);
        let night_c = lerp3([0.006, 0.014, 0.038], [0.014, 0.022, 0.034], land);
        let mut c = lerp3(night_c, day_c, day);
        // twilight: warm band at the terminator
        let tw = (-(l / 0.075).powi(2)).exp() * 0.42;
        c = lerp3(c, [1.0, 0.50, 0.22], tw * (0.35 + 0.65 * land.max(0.35)));
        // ocean sun glint
        if land < 0.5 && l > 0.0 {
            let glint = l.powf(14.0) * 0.28 * (depth as f32).max(0.0);
            c = [c[0] + glint, c[1] + glint * 0.95, c[2] + glint * 0.8];
        }
        // limb darkening + blue haze
        let d = (depth as f32).clamp(0.0, 1.0);
        let haze = (1.0 - d).powi(3) * (0.25 + 0.75 * day);
        [c[0] * (0.55 + 0.45 * d) + 0.20 * haze, c[1] * (0.55 + 0.45 * d) + 0.38 * haze, c[2] * (0.55 + 0.45 * d) + 0.75 * haze, 1.0]
    }

    fn vertex(&self, lat_d: f64, lon_d: f64, cx: f32, cy: f32, r: f32, b: &Basis, sun: &[f64; 3]) -> Vtx {
        let p = unit(lat_d.to_radians(), lon_d.to_radians());
        let (x, y, d) = b.proj(p);
        let col = Self::shade(lat_d, lon_d, p, sun, d);
        if d >= 0.0 {
            Vtx { x: cx + x as f32 * r, y: cy - y as f32 * r, col, front: true }
        } else {
            // fold back-facing vertices onto the limb so partially visible cells keep a clean silhouette
            let l = (x * x + y * y).sqrt().max(1e-9);
            Vtx { x: cx + (x / l) as f32 * r, y: cy - (y / l) as f32 * r, col, front: false }
        }
    }

    fn draw_surface(&mut self, g: &mut Gui, cx: f32, cy: f32, r: f32, b: &Basis, sun: &[f64; 3], view: &GlobeView) {
        // angular radius of the visible cap that can reach the clip rectangle
        let s = g.s;
        let c = view.clip;
        let far = [(c[0], c[1]), (c[0] + c[2], c[1]), (c[0], c[1] + c[3]), (c[0] + c[2], c[1] + c[3])]
            .iter()
            .map(|&(x, y)| ((x * s - cx).powi(2) + (y * s - cy).powi(2)).sqrt())
            .fold(0.0f32, f32::max);
        let theta = if far >= r { PI / 2.0 } else { ((far / r) as f64).asin() };
        let step = (2.0 / self.zoom.powf(0.72)).clamp(0.25, 2.0);
        let (lat_c, lon_c) = (self.lat.to_degrees(), self.lon.to_degrees());
        let span = theta.to_degrees() + step * 1.5;
        let lat0 = ((lat_c - span) / step).floor() * step;
        let lat1 = (((lat_c + span) / step).ceil() * step).min(90.0);
        let lat0 = lat0.max(-90.0);
        let polar = lat_c.abs() + span >= 89.0;
        let lon_half = if polar || theta >= PI / 2.0 - 1e-6 {
            180.0
        } else {
            let sl = theta.sin() / self.lat.cos().max(1e-3);
            if sl >= 1.0 {
                180.0
            } else {
                (sl.asin().to_degrees() + step * 1.5).min(180.0)
            }
        };
        let lon_start = ((lon_c - lon_half) / step).floor() * step;
        let ncols = ((2.0 * lon_half / step).ceil() as usize + 1).min((360.0 / step) as usize + 2);
        let nrows = ((lat1 - lat0) / step).round() as usize;
        let mut cells = 0usize;
        let mut prev = std::mem::take(&mut self.row_a);
        let mut cur = std::mem::take(&mut self.row_b);
        let build = |this: &Self, lat: f64, row: &mut Vec<Vtx>| {
            row.clear();
            for j in 0..=ncols {
                row.push(this.vertex(lat, lon_start + j as f64 * step, cx, cy, r, b, sun));
            }
        };
        build(self, lat0, &mut prev);
        for i in 1..=nrows {
            let lat = lat0 + i as f64 * step;
            build(self, lat, &mut cur);
            for j in 0..ncols {
                let (a, bq, c2, d) = (prev[j], prev[j + 1], cur[j + 1], cur[j]);
                if !(a.front || bq.front || c2.front || d.front) {
                    continue;
                }
                if cells >= 14_000 {
                    break;
                }
                cells += 1;
                g.ui.quad_c([[a.x, a.y], [bq.x, bq.y], [c2.x, c2.y], [d.x, d.y]], [a.col, bq.col, c2.col, d.col]);
            }
            std::mem::swap(&mut prev, &mut cur);
        }
        self.row_a = prev;
        self.row_b = cur;
        self.last_cells = cells;
    }

    /// Projects lat/lon (deg) with altitude factor; returns None when behind the horizon.
    fn proj_pt(b: &Basis, cx: f32, cy: f32, r: f32, p: [f64; 3], lift: f64) -> Option<[f32; 2]> {
        let (x, y, d) = b.proj(p);
        if d <= 0.0 {
            return None;
        }
        Some([cx + (x * (1.0 + lift)) as f32 * r, cy - (y * (1.0 + lift)) as f32 * r])
    }

    fn draw_graticule(&self, g: &mut Gui, cx: f32, cy: f32, r: f32, b: &Basis) {
        let col: Col = [1.0, 1.0, 1.0, 0.055];
        let th = (g.s * 1.0).max(1.0);
        let mut meridian = -180;
        while meridian < 180 {
            let mut last: Option<[f32; 2]> = None;
            for k in 0..=36 {
                let lat = -90.0 + k as f64 * 5.0;
                let p = Self::proj_pt(b, cx, cy, r, unit(lat.to_radians(), (meridian as f64).to_radians()), 0.0);
                if let (Some(a), Some(c)) = (last, p) {
                    g.ui.line(a, c, th, col);
                }
                last = p;
            }
            meridian += 30;
        }
        for lat in [-60, -30, 0, 30, 60] {
            let mut last: Option<[f32; 2]> = None;
            for k in 0..=72 {
                let lon = -180.0 + k as f64 * 5.0;
                let p = Self::proj_pt(b, cx, cy, r, unit((lat as f64).to_radians(), lon.to_radians()), 0.0);
                if let (Some(a), Some(c)) = (last, p) {
                    g.ui.line(a, c, th, if lat == 0 { [1.0, 1.0, 1.0, 0.09] } else { col });
                }
                last = p;
            }
        }
    }

    /// Day/night terminator: the great circle 90° from the sub-solar point.
    fn draw_terminator(&self, g: &mut Gui, cx: f32, cy: f32, r: f32, b: &Basis, sun: &[f64; 3]) {
        // orthonormal basis (u, v) of the plane perpendicular to the sun vector
        let helper = if sun[1].abs() < 0.9 { [0.0, 1.0, 0.0] } else { [1.0, 0.0, 0.0] };
        let cross = |a: [f64; 3], b: [f64; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        let norm = |a: [f64; 3]| {
            let l = dot(a, a).sqrt();
            [a[0] / l, a[1] / l, a[2] / l]
        };
        let u = norm(cross(*sun, helper));
        let v = norm(cross(*sun, u));
        let n = 180;
        let mut last: Option<[f32; 2]> = None;
        let th = g.s;
        for k in 0..=n {
            let a = k as f64 / n as f64 * TAU;
            let p = [u[0] * a.cos() + v[0] * a.sin(), u[1] * a.cos() + v[1] * a.sin(), u[2] * a.cos() + v[2] * a.sin()];
            let pt = Self::proj_pt(b, cx, cy, r, p, 0.0);
            if let (Some(p0), Some(p1)) = (last, pt) {
                g.ui.line(p0, p1, th * 5.0, [AMBER[0], AMBER[1], AMBER[2], 0.10]);
                g.ui.line(p0, p1, th * 1.6, [AMBER[0], AMBER[1], AMBER[2], 0.85]);
            }
            last = pt;
        }
    }

    fn draw_sun_marker(&self, g: &mut Gui, cx: f32, cy: f32, r: f32, b: &Basis, sun: &[f64; 3]) {
        if let Some(p) = Self::proj_pt(b, cx, cy, r, *sun, 0.0) {
            let s = g.s;
            g.ui.disc_g(p, 11.0 * s, 16, [1.0, 0.9, 0.5, 0.9], [1.0, 0.7, 0.2, 0.0]);
            g.ui.disc(p, 3.0 * s, 10, [1.0, 0.97, 0.8, 1.0]);
        }
    }

    fn draw_airports(&self, g: &mut Gui, cx: f32, cy: f32, r: f32, b: &Basis, sun: &[f64; 3], db: &AirportDb, marks: Marks, rw_alpha: f32) {
        let s = g.s;
        let mut drawn = 0;
        for (i, a) in db.airports.iter().enumerate() {
            if !Self::visible_airport(a.size, self.zoom) || drawn > 2600 {
                continue;
            }
            let p = unit(a.lat.to_radians(), a.lon.to_radians());
            let Some(pt) = Self::proj_pt(b, cx, cy, r, p, 0.0) else { continue };
            if pt[0] < -20.0 || pt[1] < -20.0 || pt[0] > g.ui.w + 20.0 || pt[1] > g.ui.h + 20.0 {
                continue;
            }
            drawn += 1;
            if rw_alpha > 0.98 {
                continue; // the runways themselves mark the airfield once they are drawn at full strength
            }
            let night = 1.0 - smoothstep(-0.12, 0.05, dot(p, *sun) as f32);
            let sz = [2.2, 1.7, 1.3][a.size.min(2) as usize] * s * (1.0 + (self.zoom as f32).ln().max(0.0) * 0.18);
            if night > 0.05 {
                g.ui.disc_g(pt, sz * 3.2, 8, [1.0, 0.78, 0.35, 0.30 * night], [1.0, 0.7, 0.2, 0.0]);
            }
            let col: Col = if night > 0.5 { [1.0, 0.86, 0.5, 0.95] } else { [1.0, 1.0, 1.0, 0.75] };
            g.ui.disc(pt, sz, 6, [col[0], col[1], col[2], col[3] * (1.0 - rw_alpha)]);
            let _ = i;
        }
        // selected endpoints
        for (idx, col, label) in [(marks.dep, ACCENT, "DEP"), (marks.arr, MAGENTA, "ARR")] {
            let Some(i) = idx else { continue };
            let a = &db.airports[i];
            if let Some(pt) = Self::proj_pt(b, cx, cy, r, unit(a.lat.to_radians(), a.lon.to_radians()), 0.0) {
                let pulse = 1.0 + 0.18 * (self.clock as f32 * 3.0).sin();
                g.ui.ring(pt, 9.0 * s * pulse, 2.0 * s, 28, col);
                g.ui.disc(pt, 3.2 * s, 10, col);
                g.ui.rect(pt[0] + 13.0 * s, pt[1] - 17.0 * s, (8.0 + 7.8 * 4.0) * s + 6.0 * s, 14.0 * s, [0.0, 0.02, 0.05, 0.75]);
                g.ui.text(pt[0] + 16.0 * s, pt[1] - 16.0 * s, 12.0 * s, col, &a.icao);
                let _ = label;
            }
        }
    }

    /// Runway markings in REAL-WORLD METRES (ICAO Annex 14 proportions, port of `drawRunwayMarkings` in `globeRunways.ts`):
    /// a faint pavement wash, edge stripes, 30 m / 20 m centreline dashes, threshold piano keys and the designators. The
    /// geometry comes straight from the runway end coordinates of the airport database, projected with the same
    /// orthographic camera as the satellite tiles, so the markings sit exactly on the real runway in the imagery. The layer
    /// fades in with the ground resolution and costs nothing while zoomed out.
    #[allow(clippy::too_many_arguments)]
    fn draw_runways(&self, g: &mut Gui, cx: f32, cy: f32, r: f32, b: &Basis, db: &AirportDb, marks: Marks, alpha: f32, view: &GlobeView) {
        let s = g.s as f64;
        let mpp = EARTH_R_M / r as f64;
        let clip = [view.clip[0] as f64 * s, view.clip[1] as f64 * s, view.clip[2] as f64 * s, view.clip[3] as f64 * s];
        // airports whose centre is closer to the view centre than the half diagonal of the view (+ a margin for long runways)
        let half_diag = (clip[2] * clip[2] + clip[3] * clip[3]).sqrt() * 0.5 + (cx as f64 - (clip[0] + clip[2] * 0.5)).hypot(cy as f64 - (clip[1] + clip[3] * 0.5));
        let reach = (half_diag * mpp + 12_000.0) / EARTH_R_M;
        if reach >= 1.0 {
            return;
        }
        let cos_reach = reach.cos();
        for (ai, a) in db.airports.iter().enumerate() {
            if a.runways.is_empty() || dot(unit(a.lat.to_radians(), a.lon.to_radians()), b.f) < cos_reach {
                continue;
            }
            for (ri, rw) in a.runways.iter().enumerate() {
                let Some(f) = RunwayFrame::project(b, cx as f64, cy as f64, r as f64, rw) else { continue };
                if f.len_px < 10.0 || f.len_m < 100.0 {
                    continue;
                }
                let (mx, my) = (f.o[0] + f.u[0] * f.len_px * 0.5, f.o[1] + f.u[1] * f.len_px * 0.5);
                if mx + f.len_px < clip[0] || mx - f.len_px > clip[0] + clip[2] || my + f.len_px < clip[1] || my - f.len_px > clip[1] + clip[3] {
                    continue;
                }
                self.runway_markings(g, &f, rw, alpha, marks, ai, ri, s as f32);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn runway_markings(&self, g: &mut Gui, f: &RunwayFrame, rw: &crate::airports::Runway, alpha: f32, marks: Marks, ai: usize, ri: usize, s: f32) {
        let k = f.k as f32;
        let w = (rw.width as f32).clamp(18.0, 75.0);
        let len = f.len_m as f32;
        let white = |a: f32| [1.0, 1.0, 1.0, (a * alpha).clamp(0.0, 1.0)];
        // local metre frame -> screen px
        let (o, u) = ([f.o[0] as f32, f.o[1] as f32], [f.u[0] as f32, f.u[1] as f32]);
        let nrm = [-u[1], u[0]];
        let pt = |a: f32, c: f32| [o[0] + (u[0] * a + nrm[0] * c) * k, o[1] + (u[1] * a + nrm[1] * c) * k];
        let quad = |g: &mut Gui, a0: f32, a1: f32, c0: f32, c1: f32, col: Col| {
            g.ui.quad([pt(a0, c0), pt(a1, c0), pt(a1, c1), pt(a0, c1)], col);
        };
        // 1. faint pavement wash: the real runway in the imagery stays visible underneath
        quad(g, 0.0, len, -w * 0.5, w * 0.5, [0.086, 0.102, 0.125, 0.24 * alpha]);
        // 2. edge stripes
        if w * k >= 4.5 {
            quad(g, 0.0, len, -w * 0.5 + 1.4, -w * 0.5 + 1.75, white(0.5));
            quad(g, 0.0, len, w * 0.5 - 1.75, w * 0.5 - 1.4, white(0.5));
        }
        // 3. centreline: 30 m dashes, 20 m gaps (explicit rectangles, so they scale with the ground and never alias)
        if 0.9 * k >= 0.3 && len > 160.0 {
            let mut a = 75.0;
            while a + 30.0 <= len - 75.0 {
                quad(g, a, a + 30.0, -0.45, 0.45, white(0.8));
                a += 50.0;
            }
        }
        // 4. threshold piano keys + designators at both ends (the far end is the same drawing turned by 180 deg)
        for end in 0..2u8 {
            let (sg, base) = if end == 0 { (1.0f32, 0.0f32) } else { (-1.0, len) };
            let ident = if end == 0 { &rw.le } else { &rw.he };
            if w * k >= 5.0 {
                let half = stripe_count(w) / 2;
                let pitch = (w * 0.5 - 2.2 - 1.8) / half as f32;
                let key_w = (pitch * 0.52).max(0.9);
                for i in 0..half {
                    let off = 1.8 + i as f32 * pitch;
                    quad(g, base + sg * 6.0, base + sg * 36.0, off, off + key_w, white(0.74));
                    quad(g, base + sg * 6.0, base + sg * 36.0, -off - key_w, -off, white(0.74));
                }
            }
            if w * k >= 7.0 && k >= 0.55 {
                let size = (12.0 * k * 1.0).clamp(9.0 * s, 26.0 * s);
                let p = pt(base + sg * 52.0, 0.0);
                let tw = Ui::text_width(size, ident.chars().count());
                g.ui.text(p[0] - tw * 0.5, p[1] - size * 0.5, size, white(0.82), ident);
            }
        }
        // 5. selected departure / arrival runway: outline in screen pixels + chevron on the threshold in use
        for (idx, sel, col) in [(marks.dep, marks.dep_rwy, [0.29, 0.87, 0.5, 0.92]), (marks.arr, marks.arr_rwy, [0.98, 0.75, 0.14, 0.92])] {
            let Some((sri, end)) = sel else { continue };
            if idx != Some(ai) || sri != ri {
                continue;
            }
            let (e, th) = (1.0 / k, 2.2 * s);
            let (a0, a1, c0, c1) = (-e * 1.0, len + e * 1.0, -w * 0.5 - 1.8 * e, w * 0.5 + 1.8 * e);
            let (p0, p1, p2, p3) = (pt(a0, c0), pt(a1, c0), pt(a1, c1), pt(a0, c1));
            for (x, y) in [(p0, p1), (p1, p2), (p2, p3), (p3, p0)] {
                g.ui.line(x, y, th, col);
            }
            let (x0, dir) = if end == 0 { (0.0, 1.0f32) } else { (len, -1.0) };
            g.ui.tri(pt(x0 + dir * 24.0 * e, 0.0), pt(x0 + dir * 9.0 * e, -7.0 * e), pt(x0 + dir * 9.0 * e, 7.0 * e), [col[0], col[1], col[2], 1.0]);
        }
    }

    /// Great-circle route arc between the selected airports, lifted above the surface.
    fn draw_route(&self, g: &mut Gui, cx: f32, cy: f32, r: f32, b: &Basis, db: &AirportDb, marks: Marks) {
        let (Some(i), Some(j)) = (marks.dep, marks.arr) else { return };
        let (a, c) = (&db.airports[i], &db.airports[j]);
        let (la, lo, lb, lc) = (a.lat.to_radians(), a.lon.to_radians(), c.lat.to_radians(), c.lon.to_radians());
        let d = angular_distance(la, lo, lb, lc);
        let n = ((d * 40.0) as usize).clamp(24, 120);
        let mut last: Option<[f32; 2]> = None;
        let s = g.s;
        for k in 0..=n {
            let t = k as f64 / n as f64;
            let (lat, lon) = slerp_lat_lon(la, lo, lb, lc, t);
            let lift = 0.06 * (PI * t).sin() * (d / PI).min(1.0) * 2.0;
            let pt = Self::proj_pt(b, cx, cy, r, unit(lat, lon), lift);
            if let (Some(p0), Some(p1)) = (last, pt) {
                let k = t as f32;
                let col = [0.24 + 0.76 * k, 0.72 - 0.27 * k, 1.0 - 0.05 * k, 1.0];
                g.ui.line(p0, p1, 5.0 * s, [col[0], col[1], col[2], 0.16]);
                g.ui.line(p0, p1, 2.0 * s, col);
            }
            last = pt;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn land_mask_knows_continents_and_oceans() {
        assert!(is_land(39.0, -98.0), "kansas");
        assert!(is_land(48.0, 10.0), "germany");
        assert!(is_land(-25.0, 134.0), "australia");
        assert!(is_land(-80.0, 0.0), "antarctica");
        assert!(!is_land(0.0, -150.0), "pacific");
        assert!(!is_land(-40.0, -30.0), "south atlantic");
        assert!(!is_land(-30.0, 90.0), "indian ocean");
        let land_frac = (0..360).flat_map(|y| (0..720).map(move |x| (x, y))).filter(|&(x, y)| mask_bit(x, y) > 0.5).count() as f64 / (720.0 * 360.0);
        assert!((0.25..0.40).contains(&land_frac), "{land_frac}");
    }

    #[test]
    fn terminator_day_side_is_lit() {
        // at the sub-solar point shading is bright; at the anti-solar point it is near black
        let utc = 1_710_936_000.0; // 2024-03-20 12:00Z
        let (sl, so) = subsolar_point(utc);
        let sun = unit(sl.to_radians(), so.to_radians());
        let day = Globe::shade(sl, so, sun, &sun, 1.0);
        let anti = unit((-sl).to_radians(), (so + 180.0).to_radians());
        let night = Globe::shade(-sl, so + 180.0, anti, &sun, 1.0);
        assert!(day[2] > 0.4, "{day:?}");
        assert!(night[0] + night[1] + night[2] < 0.15, "{night:?}");
    }

    #[test]
    fn fly_to_reaches_target_and_pulls_back() {
        let f = GlobeFlight::start(0.0, (0.0, 0.0, 12.0), (0.9, 2.0, 12.0));
        assert!((1.2..=3.8).contains(&f.duration()));
        let (_, _, zmid, _) = f.sample(f.duration() * 0.5);
        assert!(zmid < 12.0, "camera must pull back mid-flight: {zmid}");
        let (la, lo, z, done) = f.sample(f.duration() + 1.0);
        assert!(done && (la - 0.9).abs() < 1e-9 && (lo - 2.0).abs() < 1e-9 && (z - 12.0).abs() < 1e-6);
    }

    #[test]
    fn slerp_endpoints_and_continuity() {
        let (la, lo) = slerp_lat_lon(0.5, 3.0, -0.2, -3.0, 1.0); // crosses the antimeridian
        assert!((la + 0.2).abs() < 1e-9);
        assert!(wrap_pi(lo - (-3.0)).abs() < 1e-9);
        let (_, lo_mid) = slerp_lat_lon(0.5, 3.0, -0.2, -3.0, 0.5);
        assert!((lo_mid - 3.0).abs() < 0.5, "must stay continuous with the start: {lo_mid}");
    }

    #[test]
    fn route_focus_zoom_scales_with_distance() {
        let db = AirportDb::embedded();
        let z = |a: &str, b: &str| route_focus(db.get(a).unwrap(), db.get(b).unwrap()).2;
        assert!(z("KSFO", "KOAK") > z("KSFO", "KLAX"));
        assert!(z("KSFO", "KLAX") > z("EGLL", "KJFK"));
    }

    #[test]
    fn runway_overlay_is_geometrically_exact() {
        // the runway of the database, projected through the globe camera, must have the true bearing, the true length and
        // be centred on the camera when the camera looks at its midpoint: that is what lays it over the real runway
        let db = AirportDb::embedded();
        for icao in ["KSFO", "EGLL", "KJFK", "WIII", "YSSY", "RJTT", "FAOR", "SBGR"] {
            let a = db.get(icao).unwrap_or_else(|| panic!("{icao}"));
            let rw = a.main_runway().unwrap();
            let (mla, mlo) = ((rw.le_lat + rw.he_lat) * 0.5, (rw.le_lon + rw.he_lon) * 0.5);
            let r0 = 260.0;
            let z = EARTH_R_M / r0 / 4.0; // 4 m / px
            let f = runway_frame_at(mla, mlo, z, r0, rw).unwrap();
            let true_hdg = crate::geo::bearing(rw.le_lat, rw.le_lon, rw.he_lat, rw.he_lon);
            let screen_hdg = f.u[0].atan2(-f.u[1]).to_degrees().rem_euclid(360.0); // from screen-north, clockwise
            let d = ((screen_hdg - true_hdg + 540.0).rem_euclid(360.0) - 180.0).abs();
            assert!(d < 0.5, "{icao}: screen heading {screen_hdg:.2} vs true {true_hdg:.2}");
            assert!((f.k * 4.0 - 1.0).abs() < 0.01, "{icao}: scale {} px/m", f.k);
            assert!((f.len_px - f.len_m * f.k).abs() < 1e-6);
            // centred: the midpoint of the two ends is the camera centre (origin of the test camera)
            let mid = [f.o[0] + f.u[0] * f.len_px * 0.5, f.o[1] + f.u[1] * f.len_px * 0.5];
            assert!(mid[0].abs() < 1.5 && mid[1].abs() < 1.5, "{icao}: runway centre off by {mid:?}");
        }
    }

    #[test]
    fn runway_layer_fade_follows_ground_resolution() {
        assert_eq!(runway_alpha(100.0), 0.0);
        assert_eq!(runway_alpha(RUNWAY_FADE_FAR_MPP), 0.0);
        assert_eq!(runway_alpha(RUNWAY_FADE_NEAR_MPP), 1.0);
        assert_eq!(runway_alpha(1.0), 1.0);
        let mid = runway_alpha(16.0);
        assert!((mid - 0.5).abs() < 1e-9);
        assert!(runway_alpha(20.0) < runway_alpha(12.0));
    }

    #[test]
    fn airport_framing_reaches_runway_detail() {
        let db = AirportDb::embedded();
        // a compact airfield is framed tightly enough that its runways are drawn (< 24 m / px at the planner view size)
        let ksfo = db.get("KSFO").unwrap();
        let (_, _, z) = frame_airport(ksfo);
        let r_px = 280.0; // planner globe radius at 1280x720
        assert!(runway_alpha(EARTH_R_M / (r_px * z)) > 0.0, "KSFO frame zoom {z}");
        // a remote strip is never framed wider than ~45 km
        let tiny = db.airports.iter().find(|a| a.runways.len() == 1).unwrap();
        let (_, _, z) = frame_airport(tiny);
        assert!(z >= zoom_for_visible_km(45.0) - 1e-9);
        assert!((MIN_ZOOM..=MAX_ZOOM).contains(&zoom_for_visible_km(0.0001)));
        assert!(MAX_ZOOM * 260.0 >= EARTH_R_M / 0.6, "max zoom must reach the z18 satellite resolution");
    }

    #[test]
    fn engagement_needs_real_pan_or_zoom() {
        let db = AirportDb::embedded();
        let mut globe = Globe::new();
        globe.markers = false;
        let view = GlobeView { cx: 800.0, cy: 360.0, r: 260.0, clip: [452.0, 52.0, 816.0, 608.0] };
        let mut ui = Ui::new();
        let mut run = |globe: &mut Globe, inp: &super::super::Input| {
            ui.begin(1280.0, 720.0);
            let mut g = Gui::new(&mut ui, inp, 0.0);
            let o = globe.run(&mut g, view, 1_718_914_200.0, &db, Marks::default(), true, 1.0 / 60.0);
            ui.end();
            o
        };
        let mut inp = super::super::Input { mouse: [800.0, 360.0], ..Default::default() };
        assert!(!run(&mut globe, &inp).engaged, "hovering does nothing");
        inp.wheel = -1.0;
        assert!(run(&mut globe, &inp).engaged, "wheel zoom engages");
        inp.end_frame();
        inp.pressed = true;
        inp.down = true;
        assert!(!run(&mut globe, &inp).engaged, "press alone does not");
        inp.end_frame();
        inp.delta = [2.0, 1.0];
        assert!(!run(&mut globe, &inp).engaged, "tiny jitter does not");
        inp.delta = [10.0, 0.0];
        assert!(run(&mut globe, &inp).engaged, "pan beyond the threshold engages");
    }
}
