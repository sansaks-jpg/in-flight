//! Flight-deck geometry + display layout (reference: `src/sim/cockpit.ts`, `src/sim/a320/proceduralCockpit.ts`,
//! `src/sim/a320/cockpitRender.ts`). The camera rigs live in `camera.rs`.
//!
//! * `build_cockpit()` creates the opaque interior (glareshield, main panel, pedestal, window posts, overhead, floor) in
//!   aircraft body coordinates (+X right, +Y up, -Z forward) - it is drawn with the aircraft model matrix, so it rolls /
//!   pitches with the aircraft while the camera moves relative to it (real parallax when the head moves).
//! * `SCREENS` places the six display units (CPT/FO PFD + ND, E/WD, SD). Each is a quad textured from one cell of a
//!   1024x1024 render-to-texture atlas that `gfx/displays.rs` draws with the 2D UI batcher every frame.

use crate::geo::clamp;
use crate::gfx::geom::MeshBuilder;
use crate::physics::FlightModel;
use glam::{DVec3, Vec3, Vec4};


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
/// Atlas cells (each ATLAS_CELL px square in a 3 x 3 sheet):
/// Row 0: 0 = CAPT PFD, 1 = CAPT ND, 2 = E/WD
/// Row 1: 3 = SD, 4 = FO PFD, 5 = FO ND
/// Row 2: 6 = CAPT MCDU, 7 = FO MCDU, 8 = spare
pub const CELL_PFD: usize = 0;
pub const CELL_ND: usize = 1;
pub const CELL_EWD: usize = 2;
pub const CELL_SD: usize = 3;
pub const CELL_PFD2: usize = 4;
pub const CELL_ND2: usize = 5;
pub const CELL_MCDU1: usize = 6;
pub const CELL_MCDU2: usize = 7;
pub const ATLAS_CELL: u32 = 512;
pub const ATLAS_COLS: u32 = 3;
pub const ATLAS_ROWS: u32 = 3;
pub const ATLAS_W: u32 = ATLAS_CELL * ATLAS_COLS;
pub const ATLAS_H: u32 = ATLAS_CELL * ATLAS_ROWS;
pub const ATLAS_SIZE: u32 = ATLAS_W;

/// Pixel origin of an atlas cell.
pub fn cell_origin(cell: usize) -> [f32; 2] {
    [(cell as u32 % ATLAS_COLS * ATLAS_CELL) as f32, (cell as u32 / ATLAS_COLS * ATLAS_CELL) as f32]
}

/// UV rectangle `[u0, v0, u1, v1]` of a cell, inset by half a texel so bilinear filtering never bleeds into the neighbouring cell.
pub fn cell_uv(cell: usize) -> [f32; 4] {
    let [ox, oy] = cell_origin(cell);
    let (w, h) = (ATLAS_W as f32, ATLAS_H as f32);
    let c = ATLAS_CELL as f32;
    [(ox + 0.5) / w, (oy + 0.5) / h, (ox + c - 0.5) / w, (oy + c - 0.5) / h]
}
/// Main panel face plane (body z, m).
pub const PANEL_Z: f32 = -13.80;

pub const SCREENS: [Screen; 6] = [
    Screen { name: "CPT PFD", center: [-0.60, 1.07, PANEL_Z + 0.004], size: 0.215, cell: CELL_PFD },
    Screen { name: "CPT ND", center: [-0.36, 1.07, PANEL_Z + 0.004], size: 0.215, cell: CELL_ND },
    Screen { name: "E/WD", center: [-0.02, 1.11, PANEL_Z + 0.004], size: 0.215, cell: CELL_EWD },
    Screen { name: "SD", center: [-0.02, 0.885, PANEL_Z + 0.004], size: 0.215, cell: CELL_SD },
    Screen { name: "FO ND", center: [0.32, 1.07, PANEL_Z + 0.004], size: 0.215, cell: CELL_ND2 },
    Screen { name: "FO PFD", center: [0.56, 1.07, PANEL_Z + 0.004], size: 0.215, cell: CELL_PFD2 },
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
        let [u0, v0, u1, v1] = cell_uv(s.cell);
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
    fn displays_and_interior_geometry_are_valid() {
        let (mut v, mut i) = (Vec::new(), Vec::new());
        build_screens(&mut v, &mut i);
        assert_eq!((v.len(), i.len()), (24, 36));
        assert!(v.iter().all(|p| (0.0..=1.0).contains(&p.uv[0]) && (0.0..=1.0).contains(&p.uv[1])));
        // all four atlas cells are used and the screens are in front of the captain, below the glareshield
        for cell in [CELL_PFD, CELL_ND, CELL_EWD, CELL_SD, CELL_PFD2, CELL_ND2] {
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
