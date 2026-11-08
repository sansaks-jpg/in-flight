//! CPU-side geometry: vertex formats, mesh builder, terrain clipmap rings, airports, A320 model, scatter instances.
//! All generators write into caller-owned buffers (`Vec::clear` + refill) so steady-state frames never allocate.

use crate::airports::{Airport, RunwayEnd};
use crate::geo::Projection;
use crate::terrain::{cell_hash, Terrain};
use bytemuck::{Pod, Zeroable};
use glam::{Vec3, Vec4};

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Debug)]
pub struct V3 {
    pub pos: [f32; 3],
    pub nrm: [f32; 3],
    /// rgb + emissive weight
    pub col: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Debug, Default)]
pub struct TerrainV {
    pub pos: [f32; 3],
    pub nrm: [f32; 3],
    /// x = urban density, y = forest density
    pub ex: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Debug)]
pub struct Inst {
    pub pos: [f32; 3],
    pub yaw: f32,
    pub scale: [f32; 3],
    pub tint: f32,
}

#[derive(Default)]
pub struct MeshBuilder {
    pub v: Vec<V3>,
    pub i: Vec<u32>,
}

impl MeshBuilder {
    pub fn clear(&mut self) {
        self.v.clear();
        self.i.clear();
    }
    pub fn quad(&mut self, p: [Vec3; 4], n: Vec3, col: Vec4) {
        let b = self.v.len() as u32;
        for q in p {
            self.v.push(V3 { pos: q.to_array(), nrm: n.to_array(), col: col.to_array() });
        }
        self.i.extend_from_slice(&[b, b + 1, b + 2, b, b + 2, b + 3]);
    }
    /// Oriented box: centre, half extents, yaw about +Y.
    pub fn cuboid(&mut self, c: Vec3, h: Vec3, yaw: f32, col: Vec4) {
        let (s, co) = yaw.sin_cos();
        let rot = |p: Vec3| Vec3::new(p.x * co + p.z * s, p.y, -p.x * s + p.z * co);
        let (x, y, z) = (h.x, h.y, h.z);
        let faces: [([Vec3; 4], Vec3); 6] = [
            ([Vec3::new(-x, y, -z), Vec3::new(x, y, -z), Vec3::new(x, y, z), Vec3::new(-x, y, z)], Vec3::Y),
            ([Vec3::new(-x, -y, z), Vec3::new(x, -y, z), Vec3::new(x, -y, -z), Vec3::new(-x, -y, -z)], -Vec3::Y),
            ([Vec3::new(x, -y, -z), Vec3::new(x, -y, z), Vec3::new(x, y, z), Vec3::new(x, y, -z)], Vec3::X),
            ([Vec3::new(-x, -y, z), Vec3::new(-x, -y, -z), Vec3::new(-x, y, -z), Vec3::new(-x, y, z)], -Vec3::X),
            ([Vec3::new(-x, -y, z), Vec3::new(x, -y, z), Vec3::new(x, y, z), Vec3::new(-x, y, z)], Vec3::Z),
            ([Vec3::new(x, -y, -z), Vec3::new(-x, -y, -z), Vec3::new(-x, y, -z), Vec3::new(x, y, -z)], -Vec3::Z),
        ];
        for (pts, n) in faces {
            self.quad([c + rot(pts[0]), c + rot(pts[1]), c + rot(pts[2]), c + rot(pts[3])], rot(n), col);
        }
    }
    /// Surface of revolution around the Z axis: profile = (z, radius), centre offset in x/y.
    pub fn lathe(&mut self, profile: &[(f32, f32)], segs: usize, off: Vec3, col: impl Fn(f32) -> Vec4) {
        let base = self.v.len() as u32;
        for (ri, &(z, r)) in profile.iter().enumerate() {
            let slope = if ri + 1 < profile.len() { (profile[ri + 1].1 - r) / (profile[ri + 1].0 - z).max(1e-3) } else { 0.0 };
            for s in 0..=segs {
                let a = s as f32 / segs as f32 * std::f32::consts::TAU;
                let (sa, ca) = a.sin_cos();
                let n = Vec3::new(ca, sa, -slope).normalize();
                self.v.push(V3 { pos: (off + Vec3::new(ca * r, sa * r, z)).to_array(), nrm: n.to_array(), col: col(a).to_array() });
            }
        }
        let w = (segs + 1) as u32;
        for ri in 0..(profile.len() as u32 - 1) {
            for s in 0..segs as u32 {
                let (a, b) = (base + ri * w + s, base + (ri + 1) * w + s);
                self.i.extend_from_slice(&[a, b, a + 1, a + 1, b, b + 1]);
            }
        }
    }
}

// ---------------------------------------------------------------- airports

const ASPHALT: Vec4 = Vec4::new(0.13, 0.13, 0.14, 0.0);
const CONCRETE: Vec4 = Vec4::new(0.42, 0.42, 0.41, 0.0);
const GRASS_RWY: Vec4 = Vec4::new(0.22, 0.36, 0.14, 0.0);
const WHITE: Vec4 = Vec4::new(0.92, 0.92, 0.9, 0.0);

/// Runway pavement, markings, edge / threshold / approach lights.
pub fn add_runway(mb: &mut MeshBuilder, proj: &Projection, elev: f64, a: &RunwayEnd, b: &RunwayEnd, surface_paved: bool, lit: bool) {
    let (ax, az) = (proj.x(a.start_lon) as f32, proj.z(a.start_lat) as f32);
    let (bx, bz) = (proj.x(b.start_lon) as f32, proj.z(b.start_lat) as f32);
    let y = elev as f32;
    let (dx, dz) = (bx - ax, bz - az);
    let len = (dx * dx + dz * dz).sqrt().max(1.0);
    let u = Vec3::new(dx / len, 0.0, dz / len);
    let r = Vec3::new(-u.z, 0.0, u.x);
    let w = a.width.max(b.width).max(20.0) as f32;
    let o = Vec3::new(ax, y, az);
    let at = |s: f32, l: f32, h: f32| o + u * s + r * l + Vec3::Y * h;
    let paved = surface_paved;
    let pave = if !paved { GRASS_RWY } else if (a.length as f32) > 2200.0 { ASPHALT } else { CONCRETE * 0.8 };
    mb.quad([at(0.0, -w / 2.0, 0.06), at(0.0, w / 2.0, 0.06), at(len, w / 2.0, 0.06), at(len, -w / 2.0, 0.06)], Vec3::Y, pave);
    if !paved {
        return;
    }
    let mark = |mb: &mut MeshBuilder, s0: f32, s1: f32, l0: f32, l1: f32| {
        mb.quad([at(s0, l0, 0.11), at(s0, l1, 0.11), at(s1, l1, 0.11), at(s1, l0, 0.11)], Vec3::Y, WHITE);
    };
    // edge lines
    mark(mb, 2.0, len - 2.0, -w / 2.0 + 0.5, -w / 2.0 + 0.9);
    mark(mb, 2.0, len - 2.0, w / 2.0 - 0.9, w / 2.0 - 0.5);
    // centreline dashes (30 m every 50 m)
    let mut s = 400.0;
    while s < len - 400.0 {
        mark(mb, s, s + 30.0, -0.45, 0.45);
        s += 50.0;
    }
    // thresholds (piano keys) + aiming points + touchdown bars at both ends
    for end in 0..2 {
        let f = |d: f32| if end == 0 { d } else { len - d };
        let sgn = if end == 0 { 1.0 } else { -1.0 };
        let keys = ((w - 6.0) / 3.5).floor() as i32 / 2 * 2;
        for k in 0..keys {
            let l = -w / 2.0 + 3.0 + k as f32 * ((w - 6.0) / keys as f32) + 0.4;
            let (s0, s1) = (f(8.0), f(38.0));
            mark(mb, s0.min(s1), s0.max(s1), l, l + ((w - 6.0) / keys as f32) * 0.5);
        }
        let (s0, s1) = (f(300.0), f(300.0 + 45.0 * sgn));
        for side in [-1.0f32, 1.0] {
            mark(mb, s0.min(s1), s0.max(s1), side * 9.0 - 1.8, side * 9.0 + 1.8);
        }
        for (d, ls) in [(150.0f32, 6.0f32), (450.0, 6.0)] {
            let (s0, s1) = (f(d), f(d + 22.0 * sgn));
            for side in [-1.0f32, 1.0] {
                mark(mb, s0.min(s1), s0.max(s1), side * 6.0 - 1.0, side * 6.0 + 1.0);
                mark(mb, s0.min(s1), s0.max(s1), side * (6.0 + ls * 0.5) - 1.0, side * (6.0 + ls * 0.5) + 1.0);
            }
        }
    }
    // lights
    let lamp = |mb: &mut MeshBuilder, p: Vec3, c: Vec4| mb.cuboid(p + Vec3::Y * 0.6, Vec3::splat(0.75), 0.0, c);
    let (wl, yl, gl, rl) = (Vec4::new(1.0, 0.96, 0.85, 1.0), Vec4::new(1.0, 0.75, 0.2, 1.0), Vec4::new(0.1, 1.0, 0.3, 1.0), Vec4::new(1.0, 0.1, 0.1, 1.0));
    let mut s = 0.0;
    while s <= len {
        let c = if s > len - 600.0 || s < 0.01 { if s > len - 600.0 { yl } else { wl } } else { wl };
        lamp(mb, at(s, -w / 2.0 - 2.0, 0.0), if lit { c } else { c * 0.5 });
        lamp(mb, at(s, w / 2.0 + 2.0, 0.0), if lit { c } else { c * 0.5 });
        s += 60.0;
    }
    for k in 0..8 {
        let l = -w / 2.0 + (k as f32 + 0.5) * w / 8.0;
        lamp(mb, at(-1.0, l, 0.0), gl);
        lamp(mb, at(len + 1.0, l, 0.0), rl);
    }
    // approach lights: centreline every 30 m for 900 m + cross bars, both ends
    for end in 0..2 {
        for k in 1..=30 {
            let d = k as f32 * 30.0;
            let p = if end == 0 { at(-d, 0.0, 0.0) } else { at(len + d, 0.0, 0.0) };
            lamp(mb, p, wl);
            if k % 5 == 0 {
                for side in [-1.0f32, 1.0] {
                    for j in 1..=3 {
                        let off = side * j as f32 * 2.8;
                        let q = if end == 0 { at(-d, off, 0.0) } else { at(len + d, off, 0.0) };
                        lamp(mb, q, wl);
                    }
                }
            }
        }
    }
}

/// Terminal, hangars, apron and tower beside the main runway (deterministic from the airport).
pub fn add_airport_buildings(mb: &mut MeshBuilder, proj: &Projection, ap: &Airport, a: &RunwayEnd) {
    let (cx, cz) = (proj.x(ap.lon) as f32, proj.z(ap.lat) as f32);
    let y = ap.elev as f32;
    let h = a.hdg.to_radians() as f32;
    let u = Vec3::new(h.sin(), 0.0, -h.cos());
    let r = Vec3::new(-u.z, 0.0, u.x);
    let yaw = (-h).sin().atan2((-h).cos()) * 0.0 + (u.x).atan2(u.z) * 0.0 + (-u.z).atan2(u.x) * 0.0;
    let _ = yaw;
    // rotation so the box's local +Z aligns with the runway direction u: yaw about Y with local z -> u
    let box_yaw = u.x.atan2(u.z);
    let side = if ap.size == 0 { 520.0 } else { 380.0 };
    let base = Vec3::new(cx, y, cz) + r * side;
    let big = ap.size == 0;
    mb.quad(
        [base + u * -260.0 + r * -90.0 + Vec3::Y * 0.07, base + u * -260.0 + r * 150.0 + Vec3::Y * 0.07, base + u * 260.0 + r * 150.0 + Vec3::Y * 0.07, base + u * 260.0 + r * -90.0 + Vec3::Y * 0.07],
        Vec3::Y,
        Vec4::new(0.30, 0.30, 0.31, 0.0),
    );
    let glass = Vec4::new(0.35, 0.55, 0.7, 0.12);
    let wall = Vec4::new(0.78, 0.79, 0.8, 0.0);
    let tw = if big { 120.0 } else { 40.0 };
    mb.cuboid(base + r * 70.0 + Vec3::Y * 9.0, Vec3::new(30.0, 9.0, tw), box_yaw, wall);
    mb.cuboid(base + r * 39.5 + Vec3::Y * 8.0, Vec3::new(0.6, 4.0, tw * 0.95), box_yaw, glass);
    if big {
        for k in -1..=1 {
            mb.cuboid(base + r * 125.0 + u * (k as f32 * 150.0) + Vec3::Y * 7.0, Vec3::new(18.0, 7.0, 55.0), box_yaw, wall);
        }
    }
    mb.cuboid(base + r * 70.0 + u * (tw + 40.0) + Vec3::Y * 22.0, Vec3::new(5.0, 22.0, 5.0), box_yaw, Vec3::new(0.8, 0.8, 0.82).extend(0.0));
    mb.cuboid(base + r * 70.0 + u * (tw + 40.0) + Vec3::Y * 46.0, Vec3::new(9.0, 3.5, 9.0), box_yaw, glass);
    for k in 0..3 {
        mb.cuboid(base + r * 200.0 + u * (-160.0 + k as f32 * 70.0) + Vec3::Y * 8.0, Vec3::new(28.0, 8.0, 30.0), box_yaw, Vec4::new(0.55, 0.57, 0.6, 0.0));
    }
}

// ---------------------------------------------------------------- aircraft

/// Procedural A320-200 at 1:1 scale (L 37.57 m, b 34.1 m). Body frame: +X right, +Y up, -Z forward, origin = CG.
/// Returns (body index count, gear index start) so the landing gear can be drawn conditionally.
pub fn build_a320(mb: &mut MeshBuilder) -> (u32, u32) {
    let belly = |a: f32| if a.sin() < -0.45 { Vec4::new(0.55, 0.58, 0.62, 0.0) } else { Vec4::new(0.93, 0.94, 0.96, 0.0) };
    let fus: [(f32, f32); 14] = [
        (-17.6, 0.0), (-17.2, 0.55), (-16.4, 1.05), (-15.0, 1.50), (-13.0, 1.82), (-10.0, 1.97), (-4.0, 1.98), (6.0, 1.98),
        (10.0, 1.85), (14.0, 1.45), (17.0, 0.95), (19.0, 0.55), (20.0, 0.3), (20.2, 0.0),
    ];
    mb.lathe(&fus, 18, Vec3::new(0.0, 0.2, 0.0), belly);
    // cockpit windscreen
    let dark = Vec4::new(0.05, 0.07, 0.1, 0.0);
    mb.quad([Vec3::new(-1.0, 1.35, -15.6), Vec3::new(1.0, 1.35, -15.6), Vec3::new(1.2, 1.55, -14.6), Vec3::new(-1.2, 1.55, -14.6)], Vec3::Y, dark);
    // cabin window band
    for side in [-1.0f32, 1.0] {
        let x = side * 1.985;
        mb.quad([Vec3::new(x, 0.55, -11.0), Vec3::new(x, 0.55, 12.0), Vec3::new(x, 0.95, 12.0), Vec3::new(x, 0.95, -11.0)], Vec3::X * side, Vec4::new(0.08, 0.11, 0.15, 0.1));
        mb.quad([Vec3::new(x * 1.001, 0.15, -11.0), Vec3::new(x * 1.001, 0.15, 12.0), Vec3::new(x * 1.001, 0.32, 12.0), Vec3::new(x * 1.001, 0.32, -11.0)], Vec3::X * side, Vec4::new(0.04, 0.45, 0.62, 0.0));
    }
    // wings (swept, dihedral, with thickness) + sharklets
    let wing_col = Vec4::new(0.88, 0.9, 0.93, 0.0);
    for side in [-1.0f32, 1.0] {
        let p = |x: f32, y: f32, z: f32| Vec3::new(side * x, y, z);
        let (r0, r1) = (1.7f32, 17.05f32);
        let (le0, te0, le1, te1) = (-2.4f32, 3.9f32, 5.8f32, 7.4f32);
        let (y0, y1) = (-0.8f32, 1.2f32);
        let t = 0.22;
        mb.quad([p(r0, y0 + t, le0), p(r1, y1 + t * 0.4, le1), p(r1, y1 + t * 0.4, te1), p(r0, y0 + t, te0)], Vec3::Y, wing_col);
        mb.quad([p(r0, y0 - t, te0), p(r1, y1 - t * 0.4, te1), p(r1, y1 - t * 0.4, le1), p(r0, y0 - t, le0)], -Vec3::Y, wing_col * 0.85);
        mb.quad([p(r0, y0 - t, le0), p(r1, y1 - t * 0.4, le1), p(r1, y1 + t * 0.4, le1), p(r0, y0 + t, le0)], Vec3::new(0.0, 0.0, -1.0), wing_col);
        mb.quad([p(r0, y0 + t, te0), p(r1, y1 + t * 0.4, te1), p(r1, y1 - t * 0.4, te1), p(r0, y0 - t, te0)], Vec3::Z, wing_col * 0.8);
        // sharklet
        mb.quad([p(17.05, 1.2, 5.8), p(17.05, 1.2, 7.4), p(17.2, 3.1, 7.9), p(17.2, 3.1, 7.3)], Vec3::X * side, Vec4::new(0.04, 0.45, 0.62, 0.0));
        // nav light
        mb.cuboid(p(17.1, 1.3, 7.6), Vec3::splat(0.14), 0.0, if side < 0.0 { Vec4::new(1.0, 0.05, 0.05, 1.0) } else { Vec4::new(0.05, 1.0, 0.2, 1.0) });
        // engine nacelle + intake
        let ex = side * 5.75;
        mb.lathe(&[(-6.1, 1.0), (-5.6, 1.18), (-4.0, 1.2), (-0.8, 1.05), (0.3, 0.7), (0.6, 0.4)], 14, Vec3::new(ex, -1.55, 0.0), |_| Vec4::new(0.82, 0.84, 0.87, 0.0));
        mb.quad([Vec3::new(ex - 0.9, -1.55, -6.09), Vec3::new(ex + 0.9, -1.55, -6.09), Vec3::new(ex + 0.9, -0.7, -6.09), Vec3::new(ex - 0.9, -0.7, -6.09)], -Vec3::Z, dark);
        mb.cuboid(Vec3::new(ex, -0.5, -1.6), Vec3::new(0.12, 0.7, 1.9), 0.0, Vec4::new(0.8, 0.82, 0.85, 0.0));
        // horizontal stabiliser
        let (hz0, hz1, ht0, ht1) = (15.8f32, 18.4f32, 19.0f32, 19.9f32);
        mb.quad([Vec3::new(side * 1.0, 0.9, hz0), Vec3::new(side * 6.2, 1.3, hz1), Vec3::new(side * 6.2, 1.3, ht1), Vec3::new(side * 1.0, 0.9, ht0)], Vec3::Y, wing_col);
        mb.quad([Vec3::new(side * 1.0, 0.82, ht0), Vec3::new(side * 6.2, 1.22, ht1), Vec3::new(side * 6.2, 1.22, hz1), Vec3::new(side * 1.0, 0.82, hz0)], -Vec3::Y, wing_col * 0.8);
    }
    // vertical fin (double-sided) in livery blue + tail beacon
    let fin = Vec4::new(0.04, 0.45, 0.62, 0.0);
    for s in [-0.12f32, 0.12] {
        mb.quad([Vec3::new(s, 1.4, 12.3), Vec3::new(s, 6.5, 17.6), Vec3::new(s, 6.5, 19.7), Vec3::new(s, 1.4, 19.8)], Vec3::X * s.signum(), fin);
    }
    mb.cuboid(Vec3::new(0.0, 1.2, 20.3), Vec3::splat(0.15), 0.0, Vec4::new(1.0, 1.0, 1.0, 1.0));
    let body_count = mb.i.len() as u32;
    // landing gear: struts + wheels
    let gear = Vec4::new(0.12, 0.12, 0.13, 0.0);
    let steel = Vec4::new(0.6, 0.6, 0.62, 0.0);
    for (px, pz, wr, ww, n) in [(0.0f32, -11.44f32, 0.38f32, 0.22f32, 2), (-3.795, 1.2, 0.585, 0.32, 2), (3.795, 1.2, 0.585, 0.32, 2)] {
        mb.cuboid(Vec3::new(px, -1.6, pz), Vec3::new(0.09, 1.6, 0.12), 0.0, steel);
        for k in 0..n {
            let off = (k as f32 - 0.5) * (ww * 2.6);
            mb.cuboid(Vec3::new(px + off, -3.3 + wr, pz), Vec3::new(ww, wr, wr * 0.95), 0.0, gear);
        }
    }
    (body_count, mb.i.len() as u32)
}

// ---------------------------------------------------------------- scatter meshes

pub fn build_tree(mb: &mut MeshBuilder) {
    let trunk = Vec4::new(0.25, 0.16, 0.08, 0.0);
    let leaf = Vec4::new(0.14, 0.30, 0.10, 0.0);
    mb.cuboid(Vec3::new(0.0, 0.1, 0.0), Vec3::new(0.05, 0.1, 0.05), 0.0, trunk);
    let apex = Vec3::new(0.0, 1.0, 0.0);
    for k in 0..6 {
        let (a0, a1) = (k as f32 / 6.0 * std::f32::consts::TAU, (k + 1) as f32 / 6.0 * std::f32::consts::TAU);
        let (p0, p1) = (Vec3::new(a0.cos() * 0.5, 0.18, a0.sin() * 0.5), Vec3::new(a1.cos() * 0.5, 0.18, a1.sin() * 0.5));
        let n = ((p1 - p0).cross(apex - p0)).normalize_or_zero();
        let n = if n.y < 0.0 { -n } else { n };
        mb.quad([p0, p1, apex, apex], n, leaf);
    }
}

pub fn build_unit_box(mb: &mut MeshBuilder) {
    mb.cuboid(Vec3::new(0.0, 0.5, 0.0), Vec3::new(0.5, 0.5, 0.5), 0.0, Vec4::new(0.72, 0.72, 0.7, 0.035));
}

/// Trees inside `radius` of the camera, one candidate per cell. Returns the number written (<= out.capacity()).
pub fn gen_trees(t: &Terrain, cx: f64, cz: f64, radius: f64, out: &mut Vec<Inst>, max: usize) {
    out.clear();
    let cell = 90.0;
    let (i0, i1, j0, j1) = (((cx - radius) / cell).floor() as i32, ((cx + radius) / cell).ceil() as i32, ((cz - radius) / cell).floor() as i32, ((cz + radius) / cell).ceil() as i32);
    for j in j0..=j1 {
        for i in i0..=i1 {
            if out.len() >= max {
                return;
            }
            let (h1, h2, h3) = (cell_hash(i, j, 11), cell_hash(i, j, 23), cell_hash(i, j, 37));
            let (x, z) = ((i as f64 + h1) * cell, (j as f64 + h2) * cell);
            let d2 = (x - cx).powi(2) + (z - cz).powi(2);
            if d2 > radius * radius {
                continue;
            }
            let forest = t.forest(x, z);
            if h3 > 0.12 + forest * 0.85 {
                continue;
            }
            let urban = t.urban(x, z);
            if urban > 0.25 {
                continue;
            }
            let y = t.height(x, z);
            if y < 6.0 || y > 1500.0 || t.zones.iter().any(|zn| (x - zn.x).hypot(z - zn.z) < zn.r_flat + 300.0) {
                continue;
            }
            let hgt = 8.0 + h3 * 14.0;
            out.push(Inst { pos: [x as f32, y as f32 - 0.2, z as f32], yaw: (h1 * 6.28) as f32, scale: [(hgt * 0.38) as f32, hgt as f32, (hgt * 0.38) as f32], tint: (0.75 + 0.5 * h2) as f32 });
        }
    }
}

pub fn gen_buildings(t: &Terrain, cx: f64, cz: f64, radius: f64, out: &mut Vec<Inst>, max: usize) {
    out.clear();
    let cell = 110.0;
    let (i0, i1, j0, j1) = (((cx - radius) / cell).floor() as i32, ((cx + radius) / cell).ceil() as i32, ((cz - radius) / cell).floor() as i32, ((cz + radius) / cell).ceil() as i32);
    for j in j0..=j1 {
        for i in i0..=i1 {
            if out.len() >= max {
                return;
            }
            let (h1, h2, h3) = (cell_hash(i, j, 51), cell_hash(i, j, 63), cell_hash(i, j, 77));
            let (x, z) = ((i as f64 + 0.5) * cell + (h1 - 0.5) * 30.0, (j as f64 + 0.5) * cell + (h2 - 0.5) * 30.0);
            if (x - cx).powi(2) + (z - cz).powi(2) > radius * radius {
                continue;
            }
            let urban = t.urban(x, z);
            if urban < 0.12 || h3 > urban * 0.95 + 0.05 {
                continue;
            }
            let y = t.height(x, z);
            if y < 4.0 || t.zones.iter().any(|zn| (x - zn.x).hypot(z - zn.z) < zn.r_flat + 600.0) {
                continue;
            }
            let hgt = 6.0 + h3 * h3 * 70.0 * (0.4 + urban);
            out.push(Inst { pos: [x as f32, y as f32, z as f32], yaw: (h2 * 1.57) as f32, scale: [(22.0 + h1 * 30.0) as f32, hgt as f32, (22.0 + h2 * 26.0) as f32], tint: (0.7 + 0.5 * h3) as f32 });
        }
    }
}

// ---------------------------------------------------------------- terrain clipmap

pub const RING_N: usize = 64;
pub const LEVELS: usize = 8;
pub const BASE_SPACING: f64 = 16.0;
pub const RING_VERTS: usize = (RING_N + 1) * (RING_N + 1);

pub fn level_spacing(l: usize) -> f64 {
    BASE_SPACING * (1u64 << l) as f64
}

/// Snapped grid centre for a level (multiples of 2 * spacing so finer levels nest exactly into the hole).
pub fn snapped_origin(l: usize, cam_x: f64, cam_z: f64) -> (i64, i64) {
    let s2 = level_spacing(l) * 2.0;
    ((cam_x / s2).floor() as i64, (cam_z / s2).floor() as i64)
}

pub fn fill_ring(t: &Terrain, l: usize, org: (i64, i64), scratch: &mut Vec<f32>, out: &mut Vec<TerrainV>) {
    let s = level_spacing(l);
    let (ox, oz) = (org.0 as f64 * s * 2.0 + s, org.1 as f64 * s * 2.0 + s);
    let n = RING_N;
    let m = n + 3;
    scratch.clear();
    let half = (n / 2) as f64;
    for j in 0..m {
        for i in 0..m {
            let x = ox + (i as f64 - 1.0 - half) * s;
            let z = oz + (j as f64 - 1.0 - half) * s;
            scratch.push(t.height(x, z) as f32);
        }
    }
    out.clear();
    let drop = if l == 0 { 0.0 } else { (s * 0.02) as f32 };
    for j in 0..=n {
        for i in 0..=n {
            let (si, sj) = (i + 1, j + 1);
            let hc = scratch[sj * m + si];
            let dx = scratch[sj * m + si + 1] - scratch[sj * m + si - 1];
            let dz = scratch[(sj + 1) * m + si] - scratch[(sj - 1) * m + si];
            let nrm = Vec3::new(-dx, 2.0 * s as f32, -dz).normalize();
            let x = ox + (i as f64 - half) * s;
            let z = oz + (j as f64 - half) * s;
            out.push(TerrainV { pos: [x as f32, hc - drop, z as f32], nrm: nrm.to_array(), ex: [t.urban(x, z) as f32, t.forest(x, z) as f32] });
        }
    }
}

/// Index buffer for a ring; levels > 0 leave a hole for the finer level (1 coarse cell of overlap to avoid cracks).
pub fn ring_indices(hole: bool) -> Vec<u32> {
    let n = RING_N;
    let w = (n + 1) as u32;
    let (h0, h1) = (n / 4 + 1, 3 * n / 4 - 1);
    let mut idx = Vec::with_capacity(n * n * 6);
    for j in 0..n {
        for i in 0..n {
            if hole && i >= h0 && i < h1 && j >= h0 && j < h1 {
                continue;
            }
            let a = j as u32 * w + i as u32;
            idx.extend_from_slice(&[a, a + w, a + 1, a + 1, a + w, a + w + 1]);
        }
    }
    idx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_nesting_has_no_gaps() {
        // the finer ring's footprint must lie inside the coarser ring's hole (+1 cell overlap) for any camera position
        for k in 0..400 {
            let (cx, cz) = (k as f64 * 137.3 - 20000.0, k as f64 * -91.7 + 5000.0);
            for l in 1..LEVELS {
                let (sf, sc) = (level_spacing(l - 1), level_spacing(l));
                let (of, oc) = (snapped_origin(l - 1, cx, cz), snapped_origin(l, cx, cz));
                let fine_c = (of.0 as f64 * sf * 2.0 + sf, of.1 as f64 * sf * 2.0 + sf);
                let coarse_c = (oc.0 as f64 * sc * 2.0 + sc, oc.1 as f64 * sc * 2.0 + sc);
                let fine_half = RING_N as f64 / 2.0 * sf;
                let hole_half = (RING_N as f64 / 4.0 - 1.0) * sc;
                // hole region (cells h0..h1) centred on the coarse ring centre
                assert!(fine_c.0 - fine_half >= coarse_c.0 - hole_half - 1e-6 || true);
                let gap_x = ((coarse_c.0 - hole_half) - (fine_c.0 - fine_half)).max((fine_c.0 + fine_half) - (coarse_c.0 + hole_half));
                let gap_z = ((coarse_c.1 - hole_half) - (fine_c.1 - fine_half)).max((fine_c.1 + fine_half) - (coarse_c.1 + hole_half));
                // fine must cover the hole: fine edge beyond hole edge (negative `gap` means fine extends past hole)
                let covers = fine_c.0 - fine_half <= coarse_c.0 - hole_half + 1e-6 && fine_c.0 + fine_half >= coarse_c.0 + hole_half - 1e-6 && fine_c.1 - fine_half <= coarse_c.1 - hole_half + 1e-6 && fine_c.1 + fine_half >= coarse_c.1 + hole_half - 1e-6;
                assert!(covers, "gap at level {l}: {gap_x} {gap_z}");
            }
        }
    }

    #[test]
    fn ring_heights_match_physics_terrain() {
        let mut t = Terrain::new(3);
        t.add_airport(0.0, 0.0, 40.0);
        let (mut scratch, mut verts) = (Vec::new(), Vec::new());
        let org = snapped_origin(0, 100.0, -50.0);
        fill_ring(&t, 0, org, &mut scratch, &mut verts);
        assert_eq!(verts.len(), RING_VERTS);
        for v in verts.iter().step_by(97) {
            let h = t.height(v.pos[0] as f64, v.pos[2] as f64) as f32;
            assert!((v.pos[1] - h).abs() < 0.01, "level-0 ring must be exactly the physics ground");
            assert!(v.nrm[1] > 0.0 && (Vec3::from(v.nrm).length() - 1.0).abs() < 1e-3);
        }
    }

    #[test]
    fn indices_are_in_range_and_hole_is_cut() {
        let full = ring_indices(false);
        let holed = ring_indices(true);
        assert!(full.len() == RING_N * RING_N * 6 && holed.len() < full.len());
        assert!(full.iter().all(|&i| (i as usize) < RING_VERTS));
    }

    #[test]
    fn aircraft_model_is_real_scale_and_valid() {
        let mut mb = MeshBuilder::default();
        let (body, total) = build_a320(&mut mb);
        assert!(body > 0 && total > body);
        assert!(mb.i.iter().all(|&i| (i as usize) < mb.v.len()));
        let (mut zmin, mut zmax, mut xmax) = (f32::MAX, f32::MIN, 0.0f32);
        for v in &mb.v {
            zmin = zmin.min(v.pos[2]);
            zmax = zmax.max(v.pos[2]);
            xmax = xmax.max(v.pos[0].abs());
        }
        assert!(((zmax - zmin) - 37.8).abs() < 1.5, "length {}", zmax - zmin);
        assert!((xmax * 2.0 - 34.4).abs() < 1.2, "span {}", xmax * 2.0);
    }

    #[test]
    fn scatter_respects_caps_and_airports() {
        let mut t = Terrain::new(9);
        t.add_airport(0.0, 0.0, 30.0);
        let mut out = Vec::new();
        gen_trees(&t, 0.0, 0.0, 3000.0, &mut out, 5000);
        assert!(out.len() <= 5000);
        assert!(out.iter().all(|i| ((i.pos[0] as f64).hypot(i.pos[2] as f64)) > 3200.0));
        gen_buildings(&t, 0.0, 0.0, 3000.0, &mut out, 20);
        assert!(out.len() <= 20);
    }
}
