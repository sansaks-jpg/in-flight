//! Cockpit + external camera rigs and the 3D flight-deck geometry (reference: `src/sim/cockpit.ts`,
//! `src/sim/a320/proceduralCockpit.ts`, `src/sim/a320/cockpitRender.ts`).
//!
//! * `rig()` builds the camera for every view: **Cockpit** (captain's eye with head-look, G-load head motion and zoom),
//!   **Panel** (captain leaning towards the glareshield / displays), **Wing** (starboard wing-tip), **Chase** (smoothed
//!   orbit around the aircraft) and **Tower** (fixed ground spot that re-hops as the aircraft leaves).
//! * `build_cockpit()` creates the opaque interior (glareshield, main panel, pedestal, window posts, overhead, floor) in
//!   aircraft body coordinates (+X right, +Y up, -Z forward) - it is drawn with the aircraft model matrix, so it rolls /
//!   pitches with the aircraft while the camera moves relative to it (real parallax when the head moves).
//! * `SCREENS` places the six display units (CPT/FO PFD + ND, E/WD, SD). Each is a quad textured from one cell of a
//!   1024x1024 render-to-texture atlas that `gfx/displays.rs` draws with the 2D UI batcher every frame.

use crate::game::Flight;
use crate::geo::{clamp, wrap180};
use crate::gfx::geom::MeshBuilder;
use crate::gfx::ui::View;
use crate::gfx::Camera;
use crate::physics::FlightModel;
use glam::{DVec3, Vec3, Vec4};

/// Camera rig state: smoothed chase yaw, tower spot, orbit zoom and the pilot's head-look.
pub struct CamState {
    pub yaw: f64,
    pub spot: Option<DVec3>,
    pub dist: f64,
    pub head: HeadLook,
    pub cockpit_fov: f32,
}

impl Default for CamState {
    fn default() -> Self {
        Self { yaw: 0.0, spot: None, dist: 1.0, head: HeadLook::default(), cockpit_fov: 62.0 }
    }
}

/// Head-look relative to the aircraft (cockpit views) or orbit offset around it (chase view). Degrees.
#[derive(Clone, Copy, Debug)]
pub struct HeadLook {
    pub yaw: f64,
    pub pitch: f64,
    pub zoom: f64,
}

impl Default for HeadLook {
    fn default() -> Self {
        Self { yaw: 0.0, pitch: 0.0, zoom: 1.0 }
    }
}

impl HeadLook {
    pub fn reset(&mut self) {
        *self = Self::default();
    }
    /// Apply a look-rate (deg/s) and zoom-rate (1/s) for `dt` seconds with the real neck limits.
    pub fn apply(&mut self, dt: f64, yaw_rate: f64, pitch_rate: f64, zoom_rate: f64) {
        self.yaw = clamp(self.yaw + yaw_rate * dt, -150.0, 150.0);
        self.pitch = clamp(self.pitch + pitch_rate * dt, -70.0, 70.0);
        self.zoom = clamp(self.zoom * (1.0 + zoom_rate * dt), 0.7, 4.0);
    }
}

impl View {
    pub const ALL: [View; 5] = [View::Cockpit, View::Panel, View::Wing, View::Chase, View::Tower];
    pub fn next(self) -> View {
        let i = View::ALL.iter().position(|v| *v == self).unwrap_or(0);
        View::ALL[(i + 1) % View::ALL.len()]
    }
    /// Interior (flight deck + working displays) is visible.
    pub fn is_interior(self) -> bool {
        matches!(self, View::Cockpit | View::Panel)
    }
    pub fn label(self) -> &'static str {
        match self {
            View::Cockpit => "CAPTAIN",
            View::Panel => "PANEL",
            View::Wing => "WING",
            View::Chase => "CHASE",
            View::Tower => "TOWER",
        }
    }
}

/// Captain's seat in body coordinates (m).
pub fn eye_body(fm: &FlightModel) -> DVec3 {
    DVec3::from_array(fm.spec.eye)
}

/// Head displacement from sustained load factor (body frame): the head sinks under +g and sways with lateral accel.
pub fn head_motion(fm: &FlightModel) -> DVec3 {
    DVec3::new(clamp(-fm.ny * 0.01, -0.03, 0.03), clamp(-(fm.nz - 1.0) * 0.018, -0.045, 0.03), clamp(-(fm.nx) * 0.012, -0.03, 0.03))
}

/// Unit forward / up (body frame) for a head orientation.
pub fn look_dirs(yaw_deg: f64, pitch_deg: f64) -> (DVec3, DVec3) {
    let (y, p) = (yaw_deg.to_radians(), pitch_deg.to_radians());
    let fwd = DVec3::new(y.sin() * p.cos(), p.sin(), -y.cos() * p.cos());
    let right = fwd.cross(DVec3::Y).normalize_or(DVec3::X);
    (fwd, right.cross(fwd))
}

/// Camera for `view`. Returns (camera, aircraft-model-visible).
pub fn rig(f: &Flight, view: View, cs: &mut CamState, dt: f64, orbit: Option<f64>) -> (Camera, bool) {
    let fm = &f.fm;
    let q = fm.quat;
    if let Some(t) = orbit {
        // menu: slow orbit around the aircraft on the runway
        let a = t * 0.12;
        let pos = fm.pos + DVec3::new(a.sin() * 75.0, 14.0 + 4.0 * (t * 0.3).sin(), a.cos() * 75.0);
        let target = fm.pos + DVec3::new(0.0, 2.5, 0.0);
        let fwd = (target - pos).normalize().as_vec3();
        return (Camera { pos, fwd, up: Vec3::Y, fov_deg: 50.0, near: 0.5 }, true);
    }
    match view {
        View::Cockpit | View::Panel => {
            let panel = view == View::Panel;
            let (mut yaw, mut pitch) = (cs.head.yaw, cs.head.pitch);
            let mut zoom = cs.head.zoom;
            let mut lean = DVec3::ZERO;
            if panel {
                // lean in and look down at the display units
                pitch -= 21.0;
                yaw += 9.0;
                zoom *= 1.45;
                lean = DVec3::new(0.22, -0.05, -0.30);
            }
            yaw = clamp(yaw, -170.0, 170.0);
            let (fwd_b, up_b) = look_dirs(yaw, clamp(pitch, -85.0, 85.0));
            let pos = fm.pos + q * (eye_body(fm) + lean + head_motion(fm));
            let fwd = (q * fwd_b).as_vec3();
            let up = (q * up_b).as_vec3();
            (Camera { pos, fwd, up, fov_deg: (cs.cockpit_fov as f64 / zoom).clamp(14.0, 90.0) as f32, near: 0.08 }, false)
        }
        View::Wing => {
            let pos = fm.pos + q * DVec3::new(16.2, 3.0, 5.2);
            let (fwd_b, _) = look_dirs(-24.0 + cs.head.yaw, -4.0 + cs.head.pitch);
            ((Camera { pos, fwd: (q * fwd_b).as_vec3(), up: (q * DVec3::Y).as_vec3(), fov_deg: (68.0 / cs.head.zoom) as f32, near: 0.3 }), true)
        }
        View::Chase => {
            let target_yaw = if fm.gs > 15.0 { fm.track.to_radians() } else { fm.heading.to_radians() };
            let d = wrap180((target_yaw - cs.yaw).to_degrees()).to_radians();
            cs.yaw += d * (1.0 - (-dt * 2.5).exp());
            let orbit_yaw = cs.yaw + cs.head.yaw.to_radians();
            let back = DVec3::new(-orbit_yaw.sin(), 0.0, orbit_yaw.cos());
            let lift = 14.0 + 6.0 * cs.dist + cs.head.pitch * 0.6 * cs.dist;
            let pos = fm.pos + back * (62.0 * cs.dist) + DVec3::new(0.0, lift.max(3.0), 0.0);
            let target = fm.pos + DVec3::new(0.0, 2.0, 0.0);
            let fwd = (target - pos).normalize().as_vec3();
            (Camera { pos, fwd, up: Vec3::Y, fov_deg: 55.0, near: 0.5 }, true)
        }
        View::Tower => {
            let ahead = if fm.gs > 10.0 { DVec3::new(fm.vel.x, 0.0, fm.vel.z).normalize() } else { DVec3::new(fm.forward().x, 0.0, fm.forward().z).normalize_or(DVec3::NEG_Z) };
            let need_new = cs.spot.map_or(true, |s| (s - fm.pos).length() > 1800.0 || (s - fm.pos).dot(ahead) < -150.0);
            if need_new {
                let right = DVec3::new(-ahead.z, 0.0, ahead.x);
                let p = fm.pos + ahead * 700.0 + right * 120.0;
                let gy = f.terrain.height(p.x, p.z) + 3.0;
                cs.spot = Some(DVec3::new(p.x, gy, p.z));
            }
            let pos = cs.spot.unwrap();
            let fwd = (fm.pos - pos).normalize().as_vec3();
            let dist = (fm.pos - pos).length();
            (Camera { pos, fwd, up: Vec3::Y, fov_deg: (35.0 - (dist / 120.0).min(25.0)).max(8.0) as f32, near: 0.5 }, true)
        }
    }
}

// ---------------------------------------------------------------- displays layout

/// One display unit: centre in body coordinates, size (m) and the atlas cell it shows.
#[derive(Clone, Copy, Debug)]
pub struct Screen {
    pub name: &'static str,
    pub center: [f32; 3],
    pub size: f32,
    pub cell: usize,
}

/// Atlas cells: 0 = PFD, 1 = ND, 2 = E/WD, 3 = SD (each ATLAS_CELL px square in a 2x2 sheet).
pub const CELL_PFD: usize = 0;
pub const CELL_ND: usize = 1;
pub const CELL_EWD: usize = 2;
pub const CELL_SD: usize = 3;
pub const ATLAS_CELL: u32 = 512;
pub const ATLAS_SIZE: u32 = ATLAS_CELL * 2;
/// Main panel face plane (body z, m).
pub const PANEL_Z: f32 = -13.80;

pub const SCREENS: [Screen; 6] = [
    Screen { name: "CPT PFD", center: [-0.60, 1.07, PANEL_Z + 0.004], size: 0.215, cell: CELL_PFD },
    Screen { name: "CPT ND", center: [-0.36, 1.07, PANEL_Z + 0.004], size: 0.215, cell: CELL_ND },
    Screen { name: "E/WD", center: [-0.02, 1.11, PANEL_Z + 0.004], size: 0.215, cell: CELL_EWD },
    Screen { name: "SD", center: [-0.02, 0.885, PANEL_Z + 0.004], size: 0.215, cell: CELL_SD },
    Screen { name: "FO ND", center: [0.32, 1.07, PANEL_Z + 0.004], size: 0.215, cell: CELL_ND },
    Screen { name: "FO PFD", center: [0.56, 1.07, PANEL_Z + 0.004], size: 0.215, cell: CELL_PFD },
];

/// Textured display vertex (position in body frame + atlas uv).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct PanelV {
    pub pos: [f32; 3],
    pub uv: [f32; 2],
}

/// 6 quads x 4 vertices, 36 indices (fixed size - uploaded once).
pub fn build_screens(v: &mut Vec<PanelV>, idx: &mut Vec<u32>) {
    v.clear();
    idx.clear();
    for s in SCREENS {
        let b = v.len() as u32;
        let h = s.size * 0.5;
        let (cu, cv) = ((s.cell % 2) as f32 * 0.5, (s.cell / 2) as f32 * 0.5);
        // inset by half a texel so bilinear filtering never bleeds into the neighbouring cell
        let e = 0.5 / ATLAS_SIZE as f32;
        let (u0, u1, v0, v1) = (cu + e, cu + 0.5 - e, cv + e, cv + 0.5 - e);
        let [x, y, z] = s.center;
        v.push(PanelV { pos: [x - h, y + h, z], uv: [u0, v0] });
        v.push(PanelV { pos: [x + h, y + h, z], uv: [u1, v0] });
        v.push(PanelV { pos: [x + h, y - h, z], uv: [u1, v1] });
        v.push(PanelV { pos: [x - h, y - h, z], uv: [u0, v1] });
        idx.extend_from_slice(&[b, b + 1, b + 2, b, b + 2, b + 3]);
    }
}

// ---------------------------------------------------------------- interior geometry

/// Opaque flight-deck geometry in body coordinates. Colours are already dimmed (interior lighting is flat).
pub fn build_cockpit(mb: &mut MeshBuilder) {
    let dark = Vec4::new(0.045, 0.048, 0.055, 0.0);
    let panel = Vec4::new(0.085, 0.09, 0.10, 0.0);
    let trim = Vec4::new(0.16, 0.165, 0.18, 0.0);
    let floor = Vec4::new(0.07, 0.07, 0.075, 0.0);
    let mut c = |x: f32, y: f32, z: f32, hx: f32, hy: f32, hz: f32, col: Vec4| mb.cuboid(Vec3::new(x, y, z), Vec3::new(hx, hy, hz), 0.0, col);

    // floor + rear bulkhead
    c(0.0, 0.50, -13.0, 1.30, 0.04, 1.9, floor);
    c(0.0, 1.20, -10.95, 1.32, 0.80, 0.04, dark);
    // lower side walls (below the side windows) + side consoles
    for s in [-1.0f32, 1.0] {
        c(s * 1.33, 0.95, -13.1, 0.04, 0.45, 1.9, panel);
        c(s * 1.12, 0.92, -13.15, 0.16, 0.05, 0.55, trim);
        // side window frames: sill + header + rear post
        c(s * 1.30, 1.50, -13.55, 0.05, 0.03, 0.72, dark);
        c(s * 1.30, 2.12, -13.55, 0.05, 0.05, 1.2, dark);
        c(s * 1.30, 1.75, -12.25, 0.05, 0.30, 0.08, dark);
        // windscreen outer post
        c(s * 1.06, 1.76, -14.62, 0.045, 0.30, 0.045, dark);
        // sidestick + pedestal-side hand-rest
        c(s * 0.96, 0.98, -13.10, 0.025, 0.07, 0.025, trim);
        c(s * 0.96, 1.05, -13.12, 0.035, 0.02, 0.045, dark);
    }
    // centre windscreen post + upper frame
    c(0.0, 1.78, -14.72, 0.035, 0.30, 0.035, dark);
    c(0.0, 2.27, -14.40, 1.25, 0.05, 0.40, dark);
    // overhead panel (lowers towards the front, like the real one)
    c(0.0, 2.12, -13.0, 0.80, 0.03, 0.75, panel);
    c(0.0, 2.24, -12.7, 1.30, 0.05, 1.3, dark);
    // glareshield with the FCU in the middle
    c(0.0, 1.245, -13.88, 1.20, 0.03, 0.22, dark);
    c(0.0, 1.245, -14.02, 1.20, 0.035, 0.08, Vec4::new(0.03, 0.03, 0.035, 0.0));
    c(-0.02, 1.285, -13.95, 0.30, 0.02, 0.06, panel);
    // FCU window glow (green / amber segments)
    c(-0.18, 1.306, -13.93, 0.035, 0.004, 0.012, Vec4::new(0.1, 0.9, 0.3, 0.9));
    c(-0.08, 1.306, -13.93, 0.035, 0.004, 0.012, Vec4::new(0.1, 0.9, 0.3, 0.9));
    c(0.04, 1.306, -13.93, 0.035, 0.004, 0.012, Vec4::new(0.1, 0.9, 0.3, 0.9));
    c(0.14, 1.306, -13.93, 0.035, 0.004, 0.012, Vec4::new(1.0, 0.65, 0.1, 0.9));
    // main instrument panel (vertical face at PANEL_Z) with lower kick panel
    c(0.0, 0.88, PANEL_Z - 0.04, 1.28, 0.36, 0.04, panel);
    c(0.0, 0.52, PANEL_Z + 0.15, 1.28, 0.15, 0.20, dark);
    // landing-gear lever panel + standby instruments (centre column, between the two PFD/ND groups)
    c(0.0, 0.64, PANEL_Z + 0.02, 0.20, 0.10, 0.03, trim);
    c(-0.24, 0.80, PANEL_Z + 0.002, 0.07, 0.07, 0.004, Vec4::new(0.02, 0.02, 0.03, 0.0));
    // pedestal with the two thrust levers
    c(0.0, 0.72, -13.05, 0.17, 0.20, 0.55, trim);
    for s in [-1.0f32, 1.0] {
        c(s * 0.055, 0.98, -13.22, 0.016, 0.08, 0.016, dark);
        c(s * 0.055, 1.07, -13.22, 0.026, 0.02, 0.04, Vec4::new(0.03, 0.03, 0.03, 0.0));
    }
    // captain's seat back + headrest (just behind the eye point)
    c(-0.52, 1.00, -12.10, 0.24, 0.30, 0.05, Vec4::new(0.12, 0.10, 0.09, 0.0));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::airports::AirportDb;

    #[test]
    fn head_look_has_real_limits() {
        let mut h = HeadLook::default();
        h.apply(100.0, 90.0, 90.0, 1.0);
        assert!(h.yaw <= 150.0 && h.pitch <= 70.0 && h.zoom <= 4.0);
        h.apply(100.0, -90.0, -90.0, -1.0);
        assert!(h.yaw >= -150.0 && h.pitch >= -70.0 && h.zoom >= 0.7);
        h.reset();
        assert_eq!((h.yaw, h.pitch, h.zoom), (0.0, 0.0, 1.0));
    }

    #[test]
    fn look_dirs_are_orthonormal_and_forward_is_minus_z() {
        let (f, u) = look_dirs(0.0, 0.0);
        assert!((f - DVec3::NEG_Z).length() < 1e-9 && (u - DVec3::Y).length() < 1e-9);
        for (y, p) in [(30.0, 10.0), (-120.0, -40.0), (90.0, 0.0)] {
            let (f, u) = look_dirs(y, p);
            assert!((f.length() - 1.0).abs() < 1e-9 && (u.length() - 1.0).abs() < 1e-9 && f.dot(u).abs() < 1e-9);
        }
        let (f, _) = look_dirs(90.0, 0.0);
        assert!(f.x > 0.99, "positive yaw looks right (+X)");
    }

    #[test]
    fn view_cycle_visits_every_view() {
        let mut v = View::Cockpit;
        let mut seen = vec![v];
        for _ in 0..View::ALL.len() {
            v = v.next();
            if !seen.contains(&v) {
                seen.push(v);
            }
        }
        assert_eq!(seen.len(), View::ALL.len());
        assert_eq!(v, View::Cockpit, "cycle closes");
    }

    #[test]
    fn rig_places_the_cameras_sensibly() {
        let db = AirportDb::embedded();
        let f = Flight::new(&db, "KSFO", "KOAK", 1_718_914_200.0).unwrap();
        let mut cs = CamState { yaw: f.fm.heading.to_radians(), ..Default::default() };
        let (cap, third) = rig(&f, View::Cockpit, &mut cs, 0.016, None);
        assert!(!third);
        let eye = f.fm.pos + f.fm.quat * eye_body(&f.fm);
        assert!((cap.pos - eye).length() < 0.1, "captain camera sits at the eye point");
        let (pan, _) = rig(&f, View::Panel, &mut cs, 0.016, None);
        assert!(pan.fov_deg < cap.fov_deg * 0.75, "panel view zooms in");
        assert!(pan.fwd.y < cap.fwd.y - 0.2, "panel view looks down");
        let (wing, third) = rig(&f, View::Wing, &mut cs, 0.016, None);
        assert!(third && (wing.pos - f.fm.pos).length() > 15.0);
        let (chase, _) = rig(&f, View::Chase, &mut cs, 0.016, None);
        assert!((chase.pos - f.fm.pos).length() > 50.0);
        let (tw, _) = rig(&f, View::Tower, &mut cs, 0.016, None);
        assert!(tw.fwd.is_finite() && tw.fov_deg > 5.0);
        // head look to the right turns the camera to the aircraft's right
        cs.head.yaw = 90.0;
        let (r, _) = rig(&f, View::Cockpit, &mut cs, 0.016, None);
        let right = (f.fm.quat * DVec3::X).as_vec3();
        assert!(r.fwd.dot(right) > 0.95);
    }

    #[test]
    fn displays_and_interior_geometry_are_valid() {
        let (mut v, mut i) = (Vec::new(), Vec::new());
        build_screens(&mut v, &mut i);
        assert_eq!((v.len(), i.len()), (24, 36));
        assert!(v.iter().all(|p| (0.0..=1.0).contains(&p.uv[0]) && (0.0..=1.0).contains(&p.uv[1])));
        // all four atlas cells are used and the screens are in front of the captain, below the glareshield
        for cell in 0..4 {
            assert!(SCREENS.iter().any(|s| s.cell == cell));
        }
        for s in SCREENS {
            assert!(s.center[2] < -13.0 && s.center[1] + s.size / 2.0 < 1.245, "{}", s.name);
        }
        let mut mb = MeshBuilder::default();
        build_cockpit(&mut mb);
        assert!(mb.v.len() > 200 && mb.i.len() % 3 == 0 && mb.i.iter().all(|k| (*k as usize) < mb.v.len()));
        // the whole interior sits inside the fuselage (nothing sticks out of the 2 m radius hull)
        assert!(mb.v.iter().all(|p| p.pos[0].abs() < 1.5 && p.pos[1] < 2.4 && p.pos[1] > 0.3));
    }
}
