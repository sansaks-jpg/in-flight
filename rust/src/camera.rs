//! Camera system: one **cockpit** perspective (captain's eye with panel focus presets) and one **external** perspective
//! (chase / wing / tower, all freely orbitable). Reference: `src/sim/cockpit.ts` (camera rig, `COCKPIT_PANELS`, `COCKPIT_PRESETS`,
//! `framePanel`, `lookBy` / `panBy` / `smooth`) and `src/sim/game.ts::updateCamera` (chase / spotter rigs).
//!
//! Design rules (they are what keeps the motion from feeling stiff):
//!
//! * **Everything is a critically-damped spring** ([`Spring`], Unity-style SmoothDamp): no fixed lerp factors, no overshoot, no
//!   frame-rate dependence. The *base* view flies with a weighted ~0.42 s ease, the pilot's free-look rides on top with a tight
//!   ~85 ms spring and **coasts with momentum** after the button is released ([`LookRig`]).
//! * **Input never touches the output directly.** Mouse / keys only move *targets*; [`CamState::rig`] eases towards them every frame.
//! * **Cockpit presets are authored in the model's metres** (exactly the TypeScript tables) and are mapped to the body frame with the
//!   same transform as the GLB deck; every panel is framed *square-on* from the distance that fits it at the current aspect ratio.
//! * **External views blend**: switching Chase / Wing / Tower glides between the two poses (relative to the moving aircraft);
//!   going cockpit <-> external uses a short dip-to-black, because the camera would otherwise fly through the hull.
//! * Zero allocation in the per-frame path.

use crate::cockpit::{eye_body, head_motion, look_dirs};
use crate::deck::model_to_body;
use crate::game::Flight;
use crate::geo::{clamp, wrap180};
use crate::gfx::ui::View;
use crate::gfx::Camera;
use glam::{DVec3, Mat3, Quat, Vec3};

/// Flight time of a base-view move (panel focus, seat), seconds.
pub const BASE_SMOOTH: f64 = 0.42;
/// Free-look spring while the button is held / coasting.
pub const LOOK_SMOOTH: f64 = 0.085;
/// Lean (head translation) spring.
pub const LEAN_SMOOTH: f64 = 0.14;
/// Zoom spring (log space).
pub const ZOOM_SMOOTH: f64 = 0.15;
/// Total duration of the cockpit <-> external dip-to-black (the view swaps at the darkest point).
pub const FADE_S: f64 = 0.42;
/// Duration of an external <-> external pose blend.
pub const BLEND_S: f64 = 0.9;
/// Real neck limits (the TypeScript rig allows +-2.7 rad / +-1.35 rad around the forward direction).
pub const NECK_YAW: f64 = 155.0;
pub const NECK_PITCH: f64 = 77.0;
/// Largest simulated step the springs accept (a hitch must not catapult the camera).
const MAX_DT: f64 = 0.1;

// ================================================================== springs

/// Critically damped spring (value + velocity). `step` is the SmoothDamp integrator of `cockpit.ts::sd`.
#[derive(Clone, Copy, Debug, Default)]
pub struct Spring {
    pub x: f64,
    pub v: f64,
}

impl Spring {
    pub const fn at(x: f64) -> Self {
        Self { x, v: 0.0 }
    }
    pub fn snap(&mut self, x: f64) {
        self.x = x;
        self.v = 0.0;
    }
    /// Move towards `target`, reaching it in roughly `smooth` seconds with no overshoot. Returns the new value.
    pub fn step(&mut self, target: f64, smooth: f64, dt: f64) -> f64 {
        let dt = dt.clamp(0.0, MAX_DT);
        let om = 2.0 / smooth.max(1e-3);
        let x = om * dt;
        let e = 1.0 / (1.0 + x + 0.48 * x * x + 0.235 * x * x * x);
        let ch = self.x - target;
        let tmp = (self.v + om * ch) * dt;
        self.v = (self.v - om * tmp) * e;
        self.x = target + (ch + tmp) * e;
        self.x
    }
    /// Like [`Spring::step`] for an angle in degrees: always takes the shortest way round.
    pub fn step_angle(&mut self, target_deg: f64, smooth: f64, dt: f64) -> f64 {
        let t = self.x + wrap180(target_deg - self.x);
        self.step(t, smooth, dt)
    }
}

/// Smooth maximum: `max(a, b)` with a rounded corner of width `k` (no pop when the camera meets the ground).
pub fn smax(a: f64, b: f64, k: f64) -> f64 {
    0.5 * (a + b + ((a - b) * (a - b) + k * k).sqrt())
}

fn smootherstep(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

// ================================================================== free look

/// Allowed range of a [`LookRig`] (degrees). `yaw: None` = unlimited, the angle wraps (orbit cameras).
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub yaw: Option<(f64, f64)>,
    pub pitch: (f64, f64),
}

/// Free-look / orbit offset with drag momentum. Targets (`yaw`, `pitch`) are moved by the mouse; the springs ease the output.
#[derive(Clone, Debug)]
pub struct LookRig {
    pub yaw: f64,
    pub pitch: f64,
    sy: Spring,
    sp: Spring,
    coast: [f64; 2],
    vel: [f64; 2],
    idle: f64,
    smooth: f64,
}

impl Default for LookRig {
    fn default() -> Self {
        Self { yaw: 0.0, pitch: 0.0, sy: Spring::at(0.0), sp: Spring::at(0.0), coast: [0.0; 2], vel: [0.0; 2], idle: 1.0, smooth: LOOK_SMOOTH }
    }
}

impl LookRig {
    /// Smoothed output (yaw, pitch) in degrees.
    pub fn cur(&self) -> (f64, f64) {
        (self.sy.x, self.sp.x)
    }
    pub fn snap(&mut self) {
        self.sy.snap(self.yaw);
        self.sp.snap(self.pitch);
    }
    /// Back to the neutral view (the springs carry the camera there smoothly).
    pub fn reset(&mut self) {
        self.yaw = 0.0;
        self.pitch = 0.0;
        self.coast = [0.0; 2];
        self.vel = [0.0; 2];
    }
    pub fn is_coasting(&self) -> bool {
        self.coast != [0.0; 2]
    }
    fn limit(&mut self, lim: &Limits) {
        match lim.yaw {
            Some((a, b)) => self.yaw = self.yaw.clamp(a.min(b), a.max(b)),
            None => self.yaw = wrap180(self.yaw),
        }
        self.pitch = self.pitch.clamp(lim.pitch.0.min(lim.pitch.1), lim.pitch.0.max(lim.pitch.1));
    }
    /// Mouse drag converted to degrees (`dt` = time the motion took, used for the release velocity).
    pub fn drag(&mut self, dyaw: f64, dpitch: f64, dt: f64, lim: &Limits) {
        self.yaw += dyaw;
        self.pitch += dpitch;
        self.limit(lim);
        self.coast = [0.0; 2];
        let dt = dt.max(0.004);
        self.vel[0] = self.vel[0] * 0.6 + (dyaw / dt) * 0.4;
        self.vel[1] = self.vel[1] * 0.6 + (dpitch / dt) * 0.4;
        self.idle = 0.0;
    }
    /// Release of a drag: if the hand was still moving, the view keeps drifting and settles (momentum).
    pub fn release(&mut self) {
        if self.idle < 0.09 {
            self.coast = [(self.vel[0] * 0.6).clamp(-170.0, 170.0), (self.vel[1] * 0.6).clamp(-170.0, 170.0)];
        }
        self.vel = [0.0; 2];
    }
    pub fn update(&mut self, dt: f64, lim: &Limits) {
        let dt = dt.clamp(0.0, MAX_DT);
        self.idle += dt;
        if self.is_coasting() {
            self.yaw += self.coast[0] * dt;
            self.pitch += self.coast[1] * dt;
            let f = (-dt * 3.4).exp();
            self.coast[0] *= f;
            self.coast[1] *= f;
            if self.coast[0].abs() < 0.6 && self.coast[1].abs() < 0.6 {
                self.coast = [0.0; 2];
            }
        }
        self.limit(lim);
        if lim.yaw.is_some() {
            self.sy.step(self.yaw, self.smooth, dt);
        } else {
            self.sy.step_angle(self.yaw, self.smooth, dt);
        }
        self.sp.step(self.pitch, self.smooth, dt);
    }
}

// ================================================================== poses (blending)

/// Camera pose relative to the aircraft position (so a blend follows the moving aircraft instead of a stale world point).
#[derive(Clone, Copy, Debug)]
pub struct Pose {
    pub rel: DVec3,
    pub q: Quat,
    pub fov: f32,
    pub near: f32,
}

pub fn pose_of(cam: &Camera, ac: DVec3) -> Pose {
    let f = cam.fwd.normalize_or(Vec3::NEG_Z);
    let mut r = f.cross(cam.up).normalize_or_zero();
    if r == Vec3::ZERO {
        r = f.cross(Vec3::Y).normalize_or(Vec3::X);
    }
    let u = r.cross(f);
    Pose { rel: cam.pos - ac, q: Quat::from_mat3(&Mat3::from_cols(r, u, -f)).normalize(), fov: cam.fov_deg, near: cam.near }
}

pub fn camera_of(p: &Pose, ac: DVec3) -> Camera {
    Camera { pos: ac + p.rel, fwd: p.q * Vec3::NEG_Z, up: p.q * Vec3::Y, fov_deg: p.fov, near: p.near }
}

pub fn blend_poses(a: &Pose, b: &Pose, t: f64) -> Pose {
    let t = smootherstep(t);
    Pose { rel: a.rel.lerp(b.rel, t), q: a.q.slerp(b.q, t as f32), fov: a.fov + (b.fov - a.fov) * t as f32, near: a.near.min(b.near) }
}

// ================================================================== cockpit focus presets

/// Which flight deck is installed: the procedural one (body coordinates) or the downloaded HD GLB (model coordinates).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Interior {
    Procedural,
    Hd,
}

/// Named cockpit camera positions (`COCKPIT_FOCUS` in `cockpit.ts`; the number row 0-9 selects them).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Focus {
    Seat,
    Fcu,
    Pfd,
    Nd,
    Ecam,
    Mcdu,
    Efb,
    Ovhd,
    Ped,
    Panel,
    Pilot,
}

impl Focus {
    pub const ALL: [Focus; 11] = [Focus::Seat, Focus::Fcu, Focus::Pfd, Focus::Nd, Focus::Ecam, Focus::Mcdu, Focus::Efb, Focus::Ovhd, Focus::Ped, Focus::Panel, Focus::Pilot];
    pub fn label(self) -> &'static str {
        match self {
            Focus::Seat => "SEAT",
            Focus::Fcu => "FCU",
            Focus::Pfd => "PFD",
            Focus::Nd => "ND",
            Focus::Ecam => "ECAM",
            Focus::Mcdu => "MCDU",
            Focus::Efb => "EFB",
            Focus::Ovhd => "OVHD",
            Focus::Ped => "PED",
            Focus::Panel => "PANEL",
            Focus::Pilot => "PILOT",
        }
    }
    /// Number-row key (0-9) that selects the preset.
    pub fn digit(self) -> Option<u8> {
        match self {
            Focus::Seat => Some(0),
            Focus::Fcu => Some(1),
            Focus::Pfd => Some(2),
            Focus::Nd => Some(3),
            Focus::Ecam => Some(4),
            Focus::Mcdu => Some(5),
            Focus::Efb => Some(6),
            Focus::Ovhd => Some(7),
            Focus::Ped => Some(8),
            Focus::Panel => Some(9),
            Focus::Pilot => None,
        }
    }
    pub fn from_digit(d: u8) -> Option<Focus> {
        Focus::ALL.iter().copied().find(|f| f.digit() == Some(d))
    }
    /// The procedural deck has no MCDU / EFB.
    pub fn available(self, i: Interior) -> bool {
        !(i == Interior::Procedural && matches!(self, Focus::Mcdu | Focus::Efb))
    }
}

/// How a preset is described. Coordinates are model metres for the HD deck and body metres for the procedural one.
#[derive(Clone, Copy, Debug)]
enum Spec {
    /// design eye, looking forward (the user's FOV setting applies)
    Seat,
    /// look square-on at a panel of `w` x `h` metres: eye = centre + normal * distance that frames it
    Panel { c: [f32; 3], n: [f32; 3], w: f32, h: f32, fov: f32 },
    /// explicit eye + look-at
    Eye { eye: [f32; 3], at: [f32; 3], fov: f32 },
}

fn spec(focus: Focus, i: Interior) -> Option<Spec> {
    use Focus::*;
    let p = |c: [f32; 3], n: [f32; 3], w: f32, h: f32, fov: f32| Some(Spec::Panel { c, n, w, h, fov });
    match i {
        // `COCKPIT_PANELS` / `COCKPIT_PRESETS` of src/sim/cockpit.ts (model frame: -X forward, +Y up, +Z captain's side)
        Interior::Hd => match focus {
            Seat => Some(Spec::Seat),
            Fcu => p([-0.37, 0.485, 0.0], [0.957, 0.289, 0.0], 0.5, 0.15, 36.0),
            Pfd => p([-0.556, 0.224, 0.553], [1.0, 0.12, 0.0], 0.2, 0.2, 36.0),
            Nd => p([-0.556, 0.224, 0.353], [1.0, 0.12, 0.0], 0.2, 0.2, 36.0),
            Ecam => p([-0.556, 0.06, -0.013], [1.0, 0.12, 0.0], 0.2, 0.4, 36.0),
            Panel => p([-0.55, 0.16, 0.0], [1.0, 0.1, 0.0], 1.2, 0.4, 56.0),
            Mcdu => p([-0.41, -0.06, 0.18], [0.25, 1.0, 0.0], 0.2, 0.32, 36.0),
            Efb => p([-0.066, 0.3311, 0.9275], [0.5613, 0.1934, -0.8049], 0.31, 0.21, 36.0),
            Ovhd => Some(Spec::Eye { eye: [0.64, 0.58, 0.0], at: [0.2, 1.1, 0.0], fov: 84.0 }),
            Ped => Some(Spec::Eye { eye: [0.3, 0.55, 0.0], at: [-0.05, -0.05, 0.0], fov: 56.0 }),
            Pilot => Some(Spec::Eye { eye: [0.22, 0.66, 0.52], at: [-0.6, 0.2, 0.42], fov: 68.0 }),
        },
        // the procedural deck of `cockpit.rs` (body frame: +X right, +Y up, -Z forward; panel face at z = PANEL_Z)
        Interior::Procedural => match focus {
            Seat => Some(Spec::Seat),
            Fcu => p([-0.02, 1.29, -13.95], [-0.10, 0.55, 0.83], 0.6, 0.15, 36.0),
            Pfd => p([-0.60, 1.07, -13.796], [0.05, 0.08, 1.0], 0.215, 0.215, 36.0),
            Nd => p([-0.36, 1.07, -13.796], [-0.15, 0.08, 1.0], 0.215, 0.215, 36.0),
            Ecam => p([-0.02, 1.0, -13.796], [-0.30, 0.10, 1.0], 0.22, 0.46, 36.0),
            Panel => p([0.0, 1.0, -13.796], [0.0, 0.10, 1.0], 1.3, 0.45, 56.0),
            Mcdu | Efb => None,
            Ovhd => Some(Spec::Eye { eye: [-0.1, 1.5, -12.4], at: [0.0, 2.1, -13.0], fov: 84.0 }),
            Ped => Some(Spec::Eye { eye: [-0.25, 1.6, -12.7], at: [0.0, 0.95, -13.2], fov: 56.0 }),
            Pilot => Some(Spec::Eye { eye: [-0.52, 1.45, -12.9], at: [-0.6, 1.0, -13.8], fov: 68.0 }),
        },
    }
}

/// Outward normal of the panel a control sits on (model frame) - used to frame a clicked control square-on
/// (`panelNormal` in `cockpit.ts`).
pub fn panel_normal(c: Vec3) -> Vec3 {
    let n = |x: f32, y: f32, z: f32| Vec3::new(x, y, z).normalize();
    if c.z > 0.7 {
        n(0.5613, 0.1934, -0.8049)
    } else if c.y > 0.8 {
        n(0.25, -1.0, 0.0)
    } else if c.x < -0.3 && c.x > -0.43 && c.y > 0.38 && c.y < 0.6 {
        n(0.957, 0.289, 0.0)
    } else if c.x < -0.44 {
        n(1.0, 0.15, 0.0)
    } else if c.z.abs() < 0.34 && c.y < 0.2 {
        n(0.25, 1.0, 0.0)
    } else {
        n(0.35, 0.45, -(if c.z == 0.0 { 1.0 } else { c.z.signum() }) * (c.z.abs() * 2.0).min(1.0))
    }
}

/// Resolved base view of the cockpit camera in the body frame.
#[derive(Clone, Copy, Debug)]
pub struct Base {
    pub pos: DVec3,
    /// degrees, + = right
    pub yaw: f64,
    /// degrees, + = up
    pub pitch: f64,
    pub fov: f64,
}

fn aim(eye: DVec3, at: DVec3, fov: f64) -> Base {
    let d = at - eye;
    Base { pos: eye, yaw: d.x.atan2(-d.z).to_degrees(), pitch: d.y.atan2(d.x.hypot(d.z)).to_degrees(), fov }
}

/// Eye + look-at that frames a `w` x `h` m panel square-on (framePanel): the distance fits both dimensions at `aspect`.
pub fn frame_panel(c: Vec3, n: Vec3, w: f32, h: f32, fov: f32, aspect: f32) -> (Vec3, f32) {
    let tv = (fov * 0.5).to_radians().tan();
    let d = (h * 0.5 / tv).max(w * 0.5 / (tv * aspect.max(0.5))) * 1.12;
    (c + n.normalize() * d, d)
}

/// Captain's camera: base view (focus preset) + free-look + lean + zoom + g-load head motion.
#[derive(Clone, Debug, Default)]
pub struct CockpitCam {
    pub focus: Focus,
    /// Alt+click focus on a control: (eye, look-at, fov) in body metres - overrides `focus` until the next preset
    pub custom: Option<(DVec3, DVec3, f64)>,
    pos: [Spring; 3],
    yaw: Spring,
    pitch: Spring,
    fov: Spring,
    pub look: LookRig,
    lean_t: [f64; 2],
    lean: [Spring; 2],
    zoom_t: f64,
    zoom: Spring,
    head: [Spring; 3],
    shake: Spring,
    inited: bool,
}

impl Default for Focus {
    fn default() -> Self {
        Focus::Seat
    }
}

impl CockpitCam {
    /// The base view requested right now (re-evaluated every frame: it depends on the aspect ratio and the installed deck).
    pub fn base(&self, fm: &crate::physics::FlightModel, interior: Interior, aspect: f32, seat_fov: f32) -> Base {
        if let Some((e, a, fov)) = self.custom {
            return aim(e, a, fov);
        }
        let to_body = |v: Vec3| -> DVec3 {
            match interior {
                Interior::Hd => model_to_body(fm.spec.eye).transform_point3(v).as_dvec3(),
                Interior::Procedural => v.as_dvec3(),
            }
        };
        let sp = spec(self.focus, interior).or_else(|| spec(Focus::Seat, interior)).unwrap_or(Spec::Seat);
        match sp {
            Spec::Seat => Base { pos: eye_body(fm), yaw: 0.0, pitch: -4.0, fov: seat_fov as f64 },
            Spec::Eye { eye, at, fov } => aim(to_body(Vec3::from(eye)), to_body(Vec3::from(at)), fov as f64),
            Spec::Panel { c, n, w, h, fov } => {
                let (eye, _) = frame_panel(Vec3::from(c), Vec3::from(n), w, h, fov, aspect);
                aim(to_body(eye), to_body(Vec3::from(c)), fov as f64)
            }
        }
    }
    pub fn zoom_value(&self) -> f64 {
        self.zoom.x.exp()
    }
}

// ================================================================== external cameras

/// Chase camera: orbits the aircraft; the orbit frame follows the (smoothed) track.
#[derive(Clone, Debug)]
pub struct ChaseCam {
    follow: Spring,
    pub look: LookRig,
    zoom_t: f64,
    zoom: Spring,
    pan_t: [f64; 2],
    pan: [Spring; 2],
    roll: Spring,
    fov: Spring,
    inited: bool,
}

impl Default for ChaseCam {
    fn default() -> Self {
        Self { follow: Spring::default(), look: LookRig::default(), zoom_t: 0.0, zoom: Spring::default(), pan_t: [0.0; 2], pan: [Spring::default(); 2], roll: Spring::default(), fov: Spring::at(55.0), inited: false }
    }
}

/// Default elevation of the chase camera above the aircraft, degrees (the TS rig sits ~10 deg above the tail).
pub const CHASE_PITCH: f64 = 11.0;
/// Default chase distance in aircraft lengths.
pub const CHASE_DIST_LEN: f64 = 1.25;
const CHASE_ZOOM: (f64, f64) = (-0.8, 1.8); // ln of the distance multiplier

/// Head-look camera (wing tip): free 360 degree look + zoom.
#[derive(Clone, Debug, Default)]
pub struct LookCam {
    pub look: LookRig,
    zoom_t: f64,
    zoom: Spring,
}

/// Tower / spotter: fixed ground position that tracks the aircraft with a smoothed aim, re-hops when the aircraft has left.
#[derive(Clone, Debug, Default)]
pub struct TowerCam {
    pub look: LookRig,
    zoom_t: f64,
    zoom: Spring,
    spot: Option<DVec3>,
    aim: [Spring; 3],
    fov: Spring,
    aimed: bool,
}

// ================================================================== state

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DragKind {
    /// look (cockpit / wing / tower) or orbit (chase)
    Look,
    /// lean the head (cockpit) or slide the focus point (chase)
    Pan,
}

#[derive(Clone, Copy, Debug)]
struct Switch {
    to: View,
    t: f64,
    applied: bool,
}

/// All camera state. The app owns one, feeds it input (`drag`, `release`, `zoom`, `focus`, ...) and evaluates [`CamState::rig`].
pub struct CamState {
    pub cockpit_fov: f32,
    /// window aspect ratio / height in px (set by the app every frame; used for panel framing and drag sensitivity)
    pub aspect: f32,
    pub vp_h: f32,
    pub interior: Interior,
    pub cockpit: CockpitCam,
    pub chase: ChaseCam,
    pub wing: LookCam,
    pub tower: TowerCam,
    /// last external view (what `C` returns to)
    pub last_external: View,
    fov_now: f64,
    clock: f64,
    last_view: Option<View>,
    last_pose: Option<Pose>,
    blend: Option<(Pose, f64)>,
    switch: Option<Switch>,
}

impl Default for CamState {
    fn default() -> Self {
        Self {
            cockpit_fov: 62.0,
            aspect: 16.0 / 9.0,
            vp_h: 720.0,
            interior: Interior::Procedural,
            cockpit: CockpitCam::default(),
            chase: ChaseCam::default(),
            wing: LookCam::default(),
            tower: TowerCam::default(),
            last_external: View::Chase,
            fov_now: 62.0,
            clock: 0.0,
            last_view: None,
            last_pose: None,
            blend: None,
            switch: None,
        }
    }
}

impl View {
    pub const ALL: [View; 4] = [View::Cockpit, View::Chase, View::Wing, View::Tower];
    pub const EXTERNAL: [View; 3] = [View::Chase, View::Wing, View::Tower];
    /// Interior (flight deck + working displays) is visible.
    pub fn is_interior(self) -> bool {
        matches!(self, View::Cockpit)
    }
    pub fn next_external(self) -> View {
        match self {
            View::Chase => View::Wing,
            View::Wing => View::Tower,
            _ => View::Chase,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            View::Cockpit => "COCKPIT",
            View::Wing => "WING",
            View::Chase => "CHASE",
            View::Tower => "TOWER",
        }
    }
}

fn chase_limits() -> Limits {
    Limits { yaw: None, pitch: (-CHASE_PITCH - 8.0, 86.0 - CHASE_PITCH) }
}
const FREE_LIMITS: Limits = Limits { yaw: None, pitch: (-80.0, 80.0) };
const TOWER_LIMITS: Limits = Limits { yaw: None, pitch: (-55.0, 55.0) };

impl CamState {
    /// New rig whose first frame is placed instantly (no fly-in on the first frame of a flight).
    pub fn for_flight(cockpit_fov: f32) -> Self {
        Self { cockpit_fov, ..Self::default() }
    }

    // ------------------------------------------------------------ view switching

    /// Ask for another view. Returns the view to show *now*: same-perspective switches are immediate (the poses blend),
    /// cockpit <-> external starts a dip-to-black and the new view is returned by [`CamState::advance_view`] at its midpoint.
    pub fn request_view(&mut self, cur: View, to: View) -> View {
        if to == cur || self.switch.is_some() {
            return cur;
        }
        if cur.is_interior() == to.is_interior() {
            return to;
        }
        self.switch = Some(Switch { to, t: 0.0, applied: false });
        cur
    }
    /// `C`: toggle between the two main perspectives (cockpit <-> the last external view).
    pub fn toggle_perspective(&mut self, cur: View) -> View {
        let to = if cur.is_interior() { self.last_external } else { View::Cockpit };
        self.request_view(cur, to)
    }
    /// Advance a pending view switch; returns the (possibly new) current view.
    pub fn advance_view(&mut self, cur: View, dt: f64) -> View {
        let mut v = cur;
        if let Some(s) = self.switch.as_mut() {
            s.t += dt.clamp(0.0, 0.1);
            if !s.applied && s.t >= FADE_S * 0.5 {
                s.applied = true;
                v = s.to;
            }
            if s.t >= FADE_S {
                self.switch = None;
            }
        }
        v
    }
    /// Opacity (0..1) of the black overlay for the dip-to-black.
    pub fn fade(&self) -> f32 {
        self.switch.map_or(0.0, |s| {
            let u = (s.t / FADE_S).clamp(0.0, 1.0);
            smootherstep(1.0 - (2.0 * u - 1.0).abs()) as f32
        })
    }
    pub fn switching(&self) -> bool {
        self.switch.is_some()
    }

    // ------------------------------------------------------------ input

    /// Degrees per pixel of a drag, so the scene tracks the cursor at any zoom (chase: fixed orbit speed).
    fn look_scale(&self, view: View) -> f64 {
        match view {
            View::Chase => 0.26,
            _ => (self.fov_now / self.vp_h.max(240.0) as f64 * 1.15).clamp(0.01, 0.2),
        }
    }

    /// Mouse drag (`dx` right, `dy` down, in px) accumulated over `dt` seconds.
    pub fn drag(&mut self, view: View, kind: DragKind, dx: f64, dy: f64, dt: f64) {
        let k = self.look_scale(view);
        match (view, kind) {
            (View::Cockpit, DragKind::Look) => {
                let lim = self.cockpit_limits();
                self.cockpit.look.drag(dx * k, -dy * k, dt, &lim);
            }
            (View::Cockpit, DragKind::Pan) => {
                let s = 0.0011 / self.cockpit.zoom_value();
                self.cockpit.lean_t[0] = (self.cockpit.lean_t[0] + dx * s).clamp(-0.3, 0.3);
                self.cockpit.lean_t[1] = (self.cockpit.lean_t[1] - dy * s).clamp(-0.2, 0.2);
            }
            (View::Chase, DragKind::Look) => self.chase.look.drag(dx * k, dy * k, dt, &chase_limits()),
            (View::Chase, DragKind::Pan) => {
                let dist = 1.25 * 37.57 * self.chase.zoom_t.exp();
                let s = dist * 0.0012;
                self.chase.pan_t[0] = (self.chase.pan_t[0] - dx * s).clamp(-35.0, 35.0);
                self.chase.pan_t[1] = (self.chase.pan_t[1] + dy * s).clamp(-18.0, 18.0);
            }
            (View::Wing, DragKind::Look) => self.wing.look.drag(dx * k, -dy * k, dt, &FREE_LIMITS),
            (View::Tower, DragKind::Look) => self.tower.look.drag(dx * k, -dy * k, dt, &TOWER_LIMITS),
            (View::Wing | View::Tower, DragKind::Pan) => {}
        }
    }
    /// The look button was released: the view coasts on with the last hand velocity.
    pub fn release(&mut self, view: View) {
        match view {
            View::Cockpit => self.cockpit.look.release(),
            View::Chase => self.chase.look.release(),
            View::Wing => self.wing.look.release(),
            View::Tower => self.tower.look.release(),
        }
    }
    /// Zoom by wheel `notches` (positive = in): cockpit / wing / tower change the field of view, chase the distance.
    pub fn zoom(&mut self, view: View, notches: f64) {
        match view {
            View::Cockpit => self.cockpit.zoom_t = (self.cockpit.zoom_t + notches * 0.14).clamp(0.8f64.ln(), 8f64.ln()),
            View::Chase => self.chase.zoom_t = (self.chase.zoom_t - notches * 0.1).clamp(CHASE_ZOOM.0, CHASE_ZOOM.1),
            View::Wing => self.wing.zoom_t = (self.wing.zoom_t + notches * 0.14).clamp(0.6f64.ln(), 4f64.ln()),
            View::Tower => self.tower.zoom_t = (self.tower.zoom_t + notches * 0.14).clamp(0.5f64.ln(), 8f64.ln()),
        }
    }
    /// Re-centre the current view (look, lean / pan and zoom), flown smoothly. The cockpit keeps its panel focus.
    pub fn reset(&mut self, view: View) {
        match view {
            View::Cockpit => {
                self.cockpit.look.reset();
                self.cockpit.lean_t = [0.0; 2];
                self.cockpit.zoom_t = 0.0;
            }
            View::Chase => {
                self.chase.look.reset();
                self.chase.pan_t = [0.0; 2];
                self.chase.zoom_t = 0.0;
            }
            View::Wing => {
                self.wing.look.reset();
                self.wing.zoom_t = 0.0;
            }
            View::Tower => {
                self.tower.look.reset();
                self.tower.zoom_t = 0.0;
                self.tower.spot = None;
            }
        }
    }
    /// Fly the cockpit camera to a named preset (look, lean and zoom are cleared so the framing is exactly as designed).
    pub fn focus(&mut self, f: Focus) {
        let f = if f.available(self.interior) { f } else { Focus::Seat };
        self.cockpit.focus = f;
        self.cockpit.custom = None;
        self.reset(View::Cockpit);
    }
    /// Previous / next available preset in hot-bar order.
    pub fn focus_step(&mut self, dir: i32) {
        let list: [Focus; 11] = Focus::ALL;
        let cur = list.iter().position(|f| *f == self.cockpit.focus).unwrap_or(0) as i32;
        let n = list.len() as i32;
        for k in 1..=n {
            let c = list[(((cur + dir * k) % n + n) % n) as usize];
            if c.available(self.interior) {
                self.focus(c);
                return;
            }
        }
    }
    /// Frame an arbitrary point of the deck (Alt + click on a control): eye / look-at in body metres.
    pub fn focus_point(&mut self, eye: DVec3, at: DVec3, fov: f64) {
        self.cockpit.custom = Some((eye, at, fov));
        self.reset(View::Cockpit);
    }
    /// The next `rig` call places every spring exactly on its target (no fly-in): screenshots, tests, new flight.
    pub fn snap(&mut self) {
        self.cockpit.inited = false;
        self.chase.inited = false;
        self.tower.aimed = false;
        self.tower.spot = None;
        self.wing.look.snap();
        self.wing.zoom.snap(self.wing.zoom_t);
        self.tower.look.snap();
        self.tower.zoom.snap(self.tower.zoom_t);
        self.blend = None;
        self.last_pose = None;
        self.switch = None;
    }
    /// Short text for the HUD.
    pub fn label(&self, view: View) -> &'static str {
        match view {
            View::Cockpit if self.cockpit.custom.is_some() => "CONTROL",
            View::Cockpit => self.cockpit.focus.label(),
            v => v.label(),
        }
    }
    pub fn fov_now(&self) -> f64 {
        self.fov_now
    }

    fn cockpit_limits(&self) -> Limits {
        // limits are relative to the base view so a panel preset can still be looked away from by the full neck range
        let (by, bp) = (wrap180(self.cockpit.yaw.x), self.cockpit.pitch.x);
        Limits { yaw: Some((-NECK_YAW - by, NECK_YAW - by)), pitch: (-NECK_PITCH - bp, NECK_PITCH - bp) }
    }

    // ------------------------------------------------------------ the rig

    /// Camera for `view`. Returns (camera, aircraft-model-visible). `dt` in seconds.
    pub fn rig(&mut self, f: &Flight, view: View, dt: f64, orbit: Option<f64>) -> (Camera, bool) {
        let fm = &f.fm;
        if let Some(t) = orbit {
            // menu: slow orbit around the aircraft on the runway
            let a = t * 0.12;
            let pos = fm.pos + DVec3::new(a.sin() * 75.0, 14.0 + 4.0 * (t * 0.3).sin(), a.cos() * 75.0);
            let target = fm.pos + DVec3::new(0.0, 2.5, 0.0);
            let fwd = (target - pos).normalize().as_vec3();
            return (Camera { pos, fwd, up: Vec3::Y, fov_deg: 50.0, near: 0.5 }, true);
        }
        let dt = dt.clamp(0.0, MAX_DT);
        self.clock += dt;

        // external <-> external: glide from wherever the camera was
        if self.last_view != Some(view) {
            if let (Some(lv), Some(p)) = (self.last_view, self.last_pose) {
                if !lv.is_interior() && !view.is_interior() {
                    self.blend = Some((p, 0.0));
                } else {
                    self.blend = None;
                }
            }
            self.last_view = Some(view);
        }
        if !view.is_interior() {
            self.last_external = view;
        }

        let (cam, third, hop) = match view {
            View::Cockpit => (self.rig_cockpit(f, dt), false, false),
            View::Chase => (self.rig_chase(f, dt), true, false),
            View::Wing => (self.rig_wing(f, dt), true, false),
            View::Tower => {
                let (c, hop) = self.rig_tower(f, dt);
                (c, true, hop)
            }
        };
        if hop {
            if let Some(p) = self.last_pose {
                self.blend = Some((p, 0.0));
            }
        }
        let cam = match self.blend.as_mut() {
            Some((from, t)) => {
                *t += dt / BLEND_S;
                if *t >= 1.0 {
                    self.blend = None;
                    cam
                } else {
                    let to = pose_of(&cam, fm.pos);
                    camera_of(&blend_poses(from, &to, *t), fm.pos)
                }
            }
            None => cam,
        };
        self.last_pose = Some(pose_of(&cam, fm.pos));
        self.fov_now = cam.fov_deg as f64;
        (cam, third)
    }

    fn rig_cockpit(&mut self, f: &Flight, dt: f64) -> Camera {
        let fm = &f.fm;
        let base = self.cockpit.base(fm, self.interior, self.aspect, self.cockpit_fov);
        let t = self.clock;
        let c = &mut self.cockpit;
        if !c.inited {
            c.inited = true;
            c.pos[0].snap(base.pos.x);
            c.pos[1].snap(base.pos.y);
            c.pos[2].snap(base.pos.z);
            c.yaw.snap(base.yaw);
            c.pitch.snap(base.pitch);
            c.fov.snap(base.fov);
            c.zoom.snap(c.zoom_t);
            c.lean = [Spring::at(c.lean_t[0]), Spring::at(c.lean_t[1])];
            c.look.snap();
        }
        // base view: the weighted, cinematic ease
        let px = c.pos[0].step(base.pos.x, BASE_SMOOTH, dt);
        let py = c.pos[1].step(base.pos.y, BASE_SMOOTH, dt);
        let pz = c.pos[2].step(base.pos.z, BASE_SMOOTH, dt);
        let yaw0 = c.yaw.step_angle(base.yaw, BASE_SMOOTH, dt);
        let pitch0 = c.pitch.step(base.pitch, BASE_SMOOTH, dt);
        let fov0 = c.fov.step(base.fov, BASE_SMOOTH, dt);
        // free-look on top: tight while dragging, coasting after the release
        let by = wrap180(base.yaw);
        let lim = Limits { yaw: Some((-NECK_YAW - by, NECK_YAW - by)), pitch: (-NECK_PITCH - base.pitch, NECK_PITCH - base.pitch) };
        c.look.update(dt, &lim);
        let (ly, lp) = c.look.cur();
        let zoom = c.zoom.step(c.zoom_t, ZOOM_SMOOTH, dt).exp();
        let lx = c.lean[0].step(c.lean_t[0], LEAN_SMOOTH, dt);
        let lyy = c.lean[1].step(c.lean_t[1], LEAN_SMOOTH, dt);
        // sustained load factor moves the head; low-passed so turbulence never makes the picture twitch
        let hm = head_motion(fm);
        let hs = (1.0 / zoom).min(1.0);
        let hx = c.head[0].step(hm.x, 0.2, dt) * hs;
        let hy = c.head[1].step(hm.y, 0.2, dt) * hs;
        let hz = c.head[2].step(hm.z, 0.2, dt) * hs;
        // vibration: stall buffet, rolling on the ground (scaled down with the zoom so magnified details stay steady)
        let amp_t = (if fm.stalled { 0.006 } else if fm.stall_warn { 0.0025 } else { 0.0 }) + if fm.wow { clamp(fm.gs / 70.0, 0.0, 1.0) * 0.0009 } else { 0.0 };
        let k = c.shake.step(amp_t, 0.2, dt).to_degrees() / zoom;
        let sx = k * ((t * 23.1).sin() + (t * 41.7 + 1.3).sin());
        let sy = k * ((t * 19.3 + 2.0).sin() + (t * 37.9).sin());
        let sr = k * 0.6 * (t * 29.1).sin();

        let yt = yaw0 + ly;
        let yr = yt.to_radians();
        let pos_b = DVec3::new(px, py, pz) + DVec3::new(yr.cos(), 0.0, yr.sin()) * lx + DVec3::Y * lyy + DVec3::new(hx, hy, hz);
        let (fwd_b, up_b) = look_dirs(yt + sy, clamp(pitch0 + lp + sx, -85.0, 85.0));
        let right_b = fwd_b.cross(up_b);
        let up_b = up_b * sr.to_radians().cos() + right_b * sr.to_radians().sin();
        let q = fm.quat;
        let tv = (fov0.to_radians() * 0.5).tan() / zoom;
        let fov = (2.0 * tv.atan()).to_degrees().clamp(6.0, 100.0);
        Camera { pos: fm.pos + q * pos_b, fwd: (q * fwd_b).as_vec3(), up: (q * up_b).as_vec3(), fov_deg: fov as f32, near: 0.08 }
    }

    fn rig_chase(&mut self, f: &Flight, dt: f64) -> Camera {
        let fm = &f.fm;
        let len = fm.spec.length;
        let c = &mut self.chase;
        // straight from the orientation / velocity vectors (the cached `heading` readout lags until the first physics step)
        let target_yaw = if fm.gs > 15.0 { fm.vel.x.atan2(-fm.vel.z).to_degrees() } else { fm.forward().x.atan2(-fm.forward().z).to_degrees() };
        let bank = (-(fm.quat * DVec3::X).y).atan2((fm.quat * DVec3::Y).y).to_degrees();
        let fov_t = 55.0 + (fm.gs / 40.0).min(10.0);
        if !c.inited {
            c.inited = true;
            c.follow.snap(target_yaw);
            c.zoom.snap(c.zoom_t);
            c.pan = [Spring::at(c.pan_t[0]), Spring::at(c.pan_t[1])];
            c.roll.snap(0.0);
            c.fov.snap(fov_t);
            c.look.snap();
        }
        // the orbit frame trails the heading / track; the pilot's orbit is relative to it
        let follow = c.follow.step_angle(target_yaw, 0.5, dt);
        c.look.update(dt, &chase_limits());
        let (ly, lp) = c.look.cur();
        let zoom = c.zoom.step(c.zoom_t, ZOOM_SMOOTH + 0.05, dt).exp();
        let pan_x = c.pan[0].step(c.pan_t[0], LEAN_SMOOTH, dt);
        let pan_y = c.pan[1].step(c.pan_t[1], LEAN_SMOOTH, dt);
        let roll = c.roll.step(clamp(bank * 0.25, -14.0, 14.0), 0.35, dt);
        let fov = c.fov.step(fov_t, 0.6, dt);

        let yt = (follow + ly).to_radians();
        let p = (CHASE_PITCH + lp).clamp(-30.0, 89.0).to_radians();
        let dist = len * CHASE_DIST_LEN * zoom;
        let right = DVec3::new(yt.cos(), 0.0, yt.sin());
        let focus = fm.pos + DVec3::new(0.0, 1.5, 0.0) + right * pan_x + DVec3::Y * pan_y;
        let back = DVec3::new(-yt.sin() * p.cos(), p.sin(), yt.cos() * p.cos());
        let mut pos = focus + back * dist;
        // never dip below the ground: rounded corner so the camera slides over terrain instead of snapping
        let gh = f.terrain.height(pos.x, pos.z);
        pos.y = smax(pos.y, gh + 2.5, 1.5);
        let fwd = (focus - pos).normalize_or(DVec3::NEG_Z).as_vec3();
        // the horizon leans a little with the aircraft: a feeling of banking, never a nauseating full roll
        let r = fwd.cross(Vec3::Y).normalize_or(Vec3::X);
        let up0 = r.cross(fwd);
        let (sr, cr) = (roll.to_radians() as f32).sin_cos();
        let up = (up0 * cr + r * sr).normalize();
        Camera { pos, fwd, up, fov_deg: fov as f32, near: (dist * 0.02).clamp(0.3, 3.0) as f32 }
    }

    fn rig_wing(&mut self, f: &Flight, dt: f64) -> Camera {
        let fm = &f.fm;
        let c = &mut self.wing;
        c.look.update(dt, &FREE_LIMITS);
        let (ly, lp) = c.look.cur();
        let zoom = c.zoom.step(c.zoom_t, ZOOM_SMOOTH, dt).exp();
        let q = fm.quat;
        let (fwd_b, _) = look_dirs(-24.0 + ly, clamp(-4.0 + lp, -85.0, 85.0));
        let tv = (68.0f64.to_radians() * 0.5).tan() / zoom;
        let fov = (2.0 * tv.atan()).to_degrees().clamp(8.0, 100.0);
        Camera { pos: fm.pos + q * DVec3::new(16.2, 3.0, 5.2), fwd: (q * fwd_b).as_vec3(), up: (q * DVec3::Y).as_vec3(), fov_deg: fov as f32, near: 0.3 }
    }

    /// Returns the camera and whether the spot just hopped (the caller blends the jump away).
    fn rig_tower(&mut self, f: &Flight, dt: f64) -> (Camera, bool) {
        let fm = &f.fm;
        let c = &mut self.tower;
        let ahead = if fm.gs > 10.0 { DVec3::new(fm.vel.x, 0.0, fm.vel.z).normalize() } else { DVec3::new(fm.forward().x, 0.0, fm.forward().z).normalize_or(DVec3::NEG_Z) };
        let need_new = c.spot.map_or(true, |s| (s - fm.pos).length() > 1800.0 || (s - fm.pos).dot(ahead) < -150.0);
        let mut hop = false;
        if need_new {
            let right = DVec3::new(-ahead.z, 0.0, ahead.x);
            let p = fm.pos + ahead * 700.0 + right * 120.0;
            let gy = f.terrain.height(p.x, p.z) + 3.0;
            hop = c.spot.is_some();
            c.spot = Some(DVec3::new(p.x, gy, p.z));
        }
        let pos = c.spot.unwrap_or(fm.pos);
        let tgt = fm.pos + DVec3::new(0.0, 2.0, 0.0);
        if !c.aimed {
            c.aimed = true;
            c.aim = [Spring::at(tgt.x), Spring::at(tgt.y), Spring::at(tgt.z)];
            c.look.snap();
            c.zoom.snap(c.zoom_t);
        }
        // the operator follows the aircraft with a slight lag instead of being glued to it
        let aim = DVec3::new(c.aim[0].step(tgt.x, 0.22, dt), c.aim[1].step(tgt.y, 0.22, dt), c.aim[2].step(tgt.z, 0.22, dt));
        c.look.update(dt, &TOWER_LIMITS);
        let (ly, lp) = c.look.cur();
        let zoom = c.zoom.step(c.zoom_t, ZOOM_SMOOTH, dt).exp();
        let fwd0 = (aim - pos).normalize_or(DVec3::NEG_Z).as_vec3();
        let right = fwd0.cross(Vec3::Y).normalize_or(Vec3::X);
        let q = Quat::from_axis_angle(Vec3::Y, (-ly).to_radians() as f32) * Quat::from_axis_angle(right, lp.to_radians() as f32);
        let fwd = (q * fwd0).normalize();
        let dist = (fm.pos - pos).length();
        let base_fov = (35.0 - (dist / 120.0).min(25.0)).max(8.0);
        let fov_s = c.fov.step(base_fov, 0.3, dt);
        let tv = (fov_s.to_radians() * 0.5).tan() / zoom;
        let fov = (2.0 * tv.atan()).to_degrees().clamp(3.0, 70.0);
        (Camera { pos, fwd, up: Vec3::Y, fov_deg: fov as f32, near: 0.5 }, hop)
    }
}

// ================================================================== tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::airports::AirportDb;

    fn flight() -> Flight {
        Flight::new(&AirportDb::embedded(), "KSFO", "KOAK", 1_718_914_200.0).unwrap()
    }
    fn run(cs: &mut CamState, f: &Flight, v: View, secs: f64) -> Camera {
        let mut last = None;
        for _ in 0..(secs * 60.0) as usize {
            last = Some(cs.rig(f, v, 1.0 / 60.0, None).0);
        }
        last.unwrap()
    }

    #[test]
    fn spring_converges_without_overshoot() {
        let mut s = Spring::at(0.0);
        let mut prev = 0.0;
        for _ in 0..240 {
            let x = s.step(10.0, 0.4, 1.0 / 60.0);
            assert!(x >= prev - 1e-12 && x <= 10.0 + 1e-9, "monotone, never past the target: {x}");
            prev = x;
        }
        assert!((s.x - 10.0).abs() < 0.01 && s.v.abs() < 0.05);
        // a stalled frame (huge dt) must not explode
        let mut s = Spring::at(0.0);
        let x = s.step(10.0, 0.4, 5.0);
        assert!(x.is_finite() && x <= 10.0 + 1e-9);
    }

    #[test]
    fn spring_is_frame_rate_independent() {
        let (mut a, mut b) = (Spring::at(0.0), Spring::at(0.0));
        for _ in 0..60 {
            a.step(5.0, 0.5, 1.0 / 60.0);
        }
        for _ in 0..30 {
            b.step(5.0, 0.5, 1.0 / 30.0);
        }
        assert!((a.x - b.x).abs() < 0.08, "{} vs {}", a.x, b.x);
    }

    #[test]
    fn angle_spring_takes_the_short_way() {
        let mut s = Spring::at(350.0);
        let mut max_jump: f64 = 0.0;
        for _ in 0..120 {
            let before = s.x;
            s.step_angle(10.0, 0.3, 1.0 / 60.0);
            max_jump = max_jump.max((s.x - before).abs());
        }
        assert!(wrap180(s.x - 10.0).abs() < 0.5, "arrives at 10 deg: {}", s.x);
        assert!(max_jump < 5.0, "never swings the long way round: {max_jump}");
    }

    #[test]
    fn look_rig_clamps_wraps_and_coasts() {
        let lim = Limits { yaw: Some((-100.0, 100.0)), pitch: (-30.0, 30.0) };
        let mut l = LookRig::default();
        l.drag(500.0, 500.0, 0.016, &lim);
        assert_eq!((l.yaw, l.pitch), (100.0, 30.0));
        // wrapping orbit never leaves +-180
        let wrap = Limits { yaw: None, pitch: (-10.0, 80.0) };
        let mut o = LookRig::default();
        o.drag(270.0, 0.0, 0.016, &wrap);
        assert!((o.yaw + 90.0).abs() < 1e-9, "270 deg right == 90 deg left: {}", o.yaw);
        // momentum: a fast flick keeps moving, then settles
        let mut m = LookRig::default();
        for _ in 0..5 {
            m.drag(2.0, 0.0, 0.016, &wrap);
            m.update(0.016, &wrap);
        }
        let at_release = m.yaw;
        m.release();
        assert!(m.is_coasting());
        for _ in 0..300 {
            m.update(1.0 / 60.0, &wrap);
        }
        assert!(!m.is_coasting() && wrap180(m.yaw - at_release) > 3.0, "coasted on and stopped: {}", m.yaw - at_release);
        // a hand that stopped before the release does not coast
        let mut s = LookRig::default();
        s.drag(2.0, 0.0, 0.016, &wrap);
        for _ in 0..30 {
            s.update(1.0 / 60.0, &wrap);
        }
        s.release();
        assert!(!s.is_coasting());
    }

    #[test]
    fn pose_roundtrip_and_blend_endpoints() {
        let ac = DVec3::new(100.0, 50.0, -20.0);
        let cam = Camera { pos: ac + DVec3::new(10.0, 5.0, 40.0), fwd: Vec3::new(-0.2, -0.1, -1.0).normalize(), up: Vec3::Y, fov_deg: 55.0, near: 0.5 };
        let p = pose_of(&cam, ac);
        let back = camera_of(&p, ac);
        assert!((back.pos - cam.pos).length() < 1e-6 && (back.fwd - cam.fwd).length() < 1e-4);
        assert!(back.up.dot(Vec3::Y) > 0.99);
        let cam2 = Camera { pos: ac + DVec3::new(-30.0, 2.0, 0.0), fwd: Vec3::X, up: Vec3::Y, fov_deg: 68.0, near: 0.3 };
        let p2 = pose_of(&cam2, ac);
        assert!((blend_poses(&p, &p2, 0.0).rel - p.rel).length() < 1e-9);
        assert!((blend_poses(&p, &p2, 1.0).rel - p2.rel).length() < 1e-9);
        let mid = blend_poses(&p, &p2, 0.5);
        assert!(mid.fov > 55.0 && mid.fov < 68.0 && (mid.q * Vec3::NEG_Z).is_finite());
    }

    #[test]
    fn hd_seat_preset_is_the_design_eye() {
        // the TS pilot preset starts at EYE_M, which must land exactly on the aircraft's eye point
        let f = flight();
        let m = model_to_body(f.fm.spec.eye);
        let eye = m.transform_point3(crate::deck::EYE_M).as_dvec3();
        assert!((eye - eye_body(&f.fm)).length() < 1e-4, "{eye:?}");
    }

    #[test]
    fn every_focus_preset_frames_its_panel_square_on() {
        let f = flight();
        for interior in [Interior::Hd, Interior::Procedural] {
            for aspect in [1.0f32, 16.0 / 9.0, 21.0 / 9.0] {
                for foc in Focus::ALL {
                    if !foc.available(interior) {
                        continue;
                    }
                    let c = CockpitCam { focus: foc, ..Default::default() };
                    let b = c.base(&f.fm, interior, aspect, 62.0);
                    assert!(b.pos.is_finite() && b.yaw.is_finite() && b.pitch.is_finite(), "{foc:?}");
                    // the eye is inside the flight deck volume (never outside the hull or behind the seat)
                    assert!(b.pos.x.abs() < 1.35 && b.pos.y > 0.4 && b.pos.y < 2.3 && b.pos.z < -11.9 && b.pos.z > -14.6, "{interior:?} {foc:?} eye {:?}", b.pos);
                    assert!((6.0..=100.0).contains(&b.fov));
                    if let Some(Spec::Panel { c: pc, n, w, h, fov }) = spec(foc, interior) {
                        // the panel centre sits on the optical axis ...
                        let (eye, d) = frame_panel(Vec3::from(pc), Vec3::from(n), w, h, fov, aspect);
                        assert!(d > 0.05, "{foc:?}");
                        let (fwd, _) = look_dirs(b.yaw, b.pitch);
                        let to_c = match interior {
                            Interior::Hd => {
                                let m = model_to_body(f.fm.spec.eye);
                                m.transform_point3(Vec3::from(pc)).as_dvec3() - b.pos
                            }
                            Interior::Procedural => Vec3::from(pc).as_dvec3() - b.pos,
                        };
                        assert!(fwd.dot(to_c.normalize()) > 0.9999, "{foc:?} centre on axis");
                        // ... and the whole panel fits the frustum (vertical and horizontal)
                        let tv = (fov as f64 * 0.5).to_radians().tan();
                        assert!(h as f64 * 0.5 / d as f64 <= tv * 0.97, "{foc:?} height fits");
                        assert!(w as f64 * 0.5 / d as f64 <= tv * aspect as f64 * 0.97 + 1e-9, "{interior:?} {foc:?} width fits at {aspect}");
                        let _ = eye;
                    }
                }
            }
        }
    }

    #[test]
    fn panel_focus_flies_there_smoothly_and_settles() {
        let f = flight();
        let mut cs = CamState { interior: Interior::Hd, ..Default::default() };
        let start = run(&mut cs, &f, View::Cockpit, 0.2);
        cs.focus(Focus::Mcdu);
        let (start_fwd, start_fov) = (start.fwd, start.fov_deg);
        let mut prev = start;
        let mut max_step: f32 = 0.0;
        let mut fovs = Vec::new();
        for _ in 0..180 {
            let c = cs.rig(&f, View::Cockpit, 1.0 / 60.0, None).0;
            max_step = max_step.max(prev.fwd.angle_between(c.fwd).to_degrees());
            fovs.push(c.fov_deg);
            prev = c;
        }
        assert!(max_step < 3.5, "no snapping: biggest per-frame turn {max_step} deg");
        assert!(prev.fov_deg < start_fov * 0.65, "MCDU is a close-up: {} -> {}", start_fov, prev.fov_deg);
        assert!(prev.fwd.y < start_fwd.y - 0.5, "looks down at the pedestal display");
        // settled: another second changes nothing
        let after = run(&mut cs, &f, View::Cockpit, 1.0);
        assert!(after.fwd.angle_between(prev.fwd).to_degrees() < 0.05 && (after.pos - prev.pos).length() < 1e-3);
        assert!(fovs.windows(2).all(|w| w[1] <= w[0] + 1e-3), "fov eases monotonically");
    }

    #[test]
    fn drag_looks_and_zoom_changes_fov_with_neck_limits() {
        let f = flight();
        let mut cs = CamState::default();
        let c0 = run(&mut cs, &f, View::Cockpit, 0.3);
        cs.drag(View::Cockpit, DragKind::Look, 3000.0, 0.0, 0.016);
        cs.release(View::Cockpit);
        let c1 = run(&mut cs, &f, View::Cockpit, 2.0);
        let right = (f.fm.quat * DVec3::X).as_vec3();
        assert!(c1.fwd.dot(right) > 0.3, "drag right looks right");
        let yaw = cs.cockpit.look.yaw;
        assert!(yaw <= NECK_YAW + 1e-6, "neck limit {yaw}");
        cs.zoom(View::Cockpit, 20.0);
        let c2 = run(&mut cs, &f, View::Cockpit, 2.0);
        assert!(c2.fov_deg < c0.fov_deg / 4.0 && c2.fov_deg >= 6.0, "{} -> {}", c0.fov_deg, c2.fov_deg);
        cs.reset(View::Cockpit);
        let c3 = run(&mut cs, &f, View::Cockpit, 3.0);
        assert!(c3.fwd.angle_between(c0.fwd).to_degrees() < 0.2 && (c3.fov_deg - c0.fov_deg).abs() < 0.2, "reset returns to the seat view");
    }

    #[test]
    fn lean_moves_the_head_sideways_within_range() {
        let f = flight();
        let mut cs = CamState::default();
        let c0 = run(&mut cs, &f, View::Cockpit, 0.3);
        cs.drag(View::Cockpit, DragKind::Pan, 5000.0, -5000.0, 0.016);
        let c1 = run(&mut cs, &f, View::Cockpit, 1.0);
        let d = (c1.pos - c0.pos).length();
        assert!(d > 0.1 && d < 0.45, "leans {d} m, bounded");
    }

    #[test]
    fn chase_orbits_pans_zooms_and_stays_above_ground() {
        let f = flight();
        let mut cs = CamState::default();
        let c0 = run(&mut cs, &f, View::Chase, 0.5);
        let d0 = (c0.pos - f.fm.pos).length();
        assert!(d0 > 30.0 && d0 < 90.0, "default chase distance {d0}");
        assert!(c0.fwd.dot((f.fm.quat * DVec3::NEG_Z).as_vec3()) > 0.5, "starts behind the aircraft looking along it");
        // orbit 180 degrees: the camera ends up in front
        cs.drag(View::Chase, DragKind::Look, 180.0 / 0.26, 0.0, 0.5);
        let c1 = run(&mut cs, &f, View::Chase, 2.0);
        assert!(c1.fwd.dot((f.fm.quat * DVec3::NEG_Z).as_vec3()) < -0.5, "orbited to the front");
        assert!(((c1.pos - f.fm.pos).length() - d0).abs() < d0 * 0.15, "orbit keeps the distance");
        // steep drag-down: never below the ground, pitch clamped
        cs.drag(View::Chase, DragKind::Look, 0.0, -5000.0, 0.5);
        let c2 = run(&mut cs, &f, View::Chase, 2.0);
        let gh = f.terrain.height(c2.pos.x, c2.pos.z);
        assert!(c2.pos.y >= gh + 2.5, "above ground");
        cs.drag(View::Chase, DragKind::Look, 0.0, 5000.0, 0.5);
        let c3 = run(&mut cs, &f, View::Chase, 3.0);
        assert!(c3.fwd.y < -0.9 && c3.fwd.is_finite() && c3.up.is_finite(), "top-down view is valid: {:?}", c3.fwd);
        // zoom range
        cs.reset(View::Chase);
        cs.zoom(View::Chase, 100.0);
        let near = (run(&mut cs, &f, View::Chase, 3.0).pos - f.fm.pos).length();
        cs.zoom(View::Chase, -100.0);
        let far = (run(&mut cs, &f, View::Chase, 4.0).pos - f.fm.pos).length();
        assert!(near > 15.0 && near < 40.0 && far > 150.0, "{near} .. {far}");
        // pan shifts the focus off the aircraft but is bounded
        cs.reset(View::Chase);
        cs.drag(View::Chase, DragKind::Pan, -9000.0, 0.0, 0.5);
        let c4 = run(&mut cs, &f, View::Chase, 3.0);
        let p = c4.pos + (c4.fwd * (c4.pos - f.fm.pos).length() as f32).as_dvec3();
        assert!((p - f.fm.pos).length() < 70.0);
    }

    #[test]
    fn wing_and_tower_free_look() {
        let f = flight();
        let mut cs = CamState::default();
        let w0 = run(&mut cs, &f, View::Wing, 0.3);
        assert!((w0.pos - f.fm.pos).length() > 15.0);
        cs.drag(View::Wing, DragKind::Look, 4000.0, 0.0, 0.5);
        let w1 = run(&mut cs, &f, View::Wing, 2.0);
        assert!(w1.fwd.dot(w0.fwd) < 0.9, "wing view can be turned all the way round");
        cs.zoom(View::Wing, 10.0);
        assert!(run(&mut cs, &f, View::Wing, 2.0).fov_deg < w0.fov_deg * 0.5);
        let mut cs = CamState::default();
        let t0 = run(&mut cs, &f, View::Tower, 0.3);
        assert!(t0.fov_deg > 5.0 && t0.fwd.is_finite());
        let to_ac = (f.fm.pos - t0.pos).normalize().as_vec3();
        assert!(t0.fwd.dot(to_ac) > 0.99, "tower looks at the aircraft");
        cs.drag(View::Tower, DragKind::Look, 400.0, 0.0, 0.1);
        let t1 = run(&mut cs, &f, View::Tower, 1.5);
        assert!(t1.fwd.dot(to_ac) < 0.99, "tower look offset applies");
    }

    #[test]
    fn external_switch_blends_without_a_jump() {
        let f = flight();
        let mut cs = CamState::default();
        let a = run(&mut cs, &f, View::Chase, 1.0);
        let first = cs.rig(&f, View::Wing, 1.0 / 60.0, None).0;
        assert!((first.pos - a.pos).length() < 2.0, "first frame of the new view is still where the old one was");
        let mut prev = first;
        for _ in 0..120 {
            let c = cs.rig(&f, View::Wing, 1.0 / 60.0, None).0;
            assert!((c.pos - prev.pos).length() < 3.0, "no jump while blending");
            prev = c;
        }
        let wing = cs.rig(&f, View::Wing, 1.0 / 60.0, None).0;
        assert!((prev.pos - wing.pos).length() < 0.5, "blend finished");
    }

    #[test]
    fn perspective_toggle_uses_a_dip_to_black() {
        let mut cs = CamState::default();
        let mut v = View::Cockpit;
        v = cs.toggle_perspective(v);
        assert_eq!(v, View::Cockpit, "the view does not change before the screen is dark");
        let mut max_fade: f32 = 0.0;
        let mut changed_at = None;
        for i in 0..40 {
            let before = cs.fade();
            v = cs.advance_view(v, 1.0 / 60.0);
            max_fade = max_fade.max(cs.fade());
            if v != View::Cockpit && changed_at.is_none() {
                changed_at = Some(i);
                assert!(before > 0.8, "swap happens at the darkest point (fade {before})");
            }
        }
        assert_eq!(v, View::Chase);
        assert!(max_fade > 0.95 && cs.fade() == 0.0 && !cs.switching());
        // exterior -> exterior is immediate (the poses blend instead)
        assert_eq!(cs.request_view(View::Chase, View::Tower), View::Tower);
        // and `C` comes back to the last external view
        let mut cs = CamState::default();
        cs.last_external = View::Tower;
        assert_eq!(cs.toggle_perspective(View::Cockpit), View::Cockpit);
        let v = (0..40).fold(View::Cockpit, |v, _| cs.advance_view(v, 1.0 / 60.0));
        assert_eq!(v, View::Tower);
    }

    #[test]
    fn digits_map_to_presets_and_unavailable_ones_fall_back() {
        for d in 0..=9u8 {
            assert_eq!(Focus::from_digit(d).and_then(|f| f.digit()), Some(d));
        }
        assert!(Focus::from_digit(10).is_none());
        let mut cs = CamState { interior: Interior::Procedural, ..Default::default() };
        cs.focus(Focus::Efb);
        assert_eq!(cs.cockpit.focus, Focus::Seat, "no EFB in the procedural deck");
        cs.interior = Interior::Hd;
        cs.focus(Focus::Efb);
        assert_eq!(cs.cockpit.focus, Focus::Efb);
        // stepping cycles through every available preset
        let mut seen = std::collections::HashSet::new();
        for _ in 0..Focus::ALL.len() {
            cs.focus_step(1);
            seen.insert(cs.cockpit.focus);
        }
        assert_eq!(seen.len(), Focus::ALL.len());
        cs.interior = Interior::Procedural;
        cs.focus(Focus::Seat);
        for _ in 0..20 {
            cs.focus_step(-1);
            assert!(cs.cockpit.focus.available(Interior::Procedural));
        }
    }

    #[test]
    fn clicked_control_is_framed_from_the_front_of_its_panel() {
        // main instrument panel control: seen from +X (the pilot side) slightly above
        let n = panel_normal(Vec3::new(-0.55, 0.2, 0.1));
        assert!(n.x > 0.9 && n.is_normalized());
        // overhead: from below
        assert!(panel_normal(Vec3::new(0.2, 1.1, 0.0)).y < -0.9);
        // pedestal: from above
        assert!(panel_normal(Vec3::new(-0.1, 0.0, 0.1)).y > 0.9);
        // everything returns a unit vector
        for c in [Vec3::new(0.0, 0.3, 0.9), Vec3::new(-0.37, 0.5, 0.0), Vec3::new(0.3, 0.3, 0.6), Vec3::ZERO] {
            assert!(panel_normal(c).is_normalized());
        }
        let f = flight();
        let mut cs = CamState::default();
        let (eye, at) = (DVec3::new(-0.5, 1.2, -13.3), DVec3::new(-0.6, 1.05, -13.8));
        cs.focus_point(eye, at, 38.0);
        let c = run(&mut cs, &f, View::Cockpit, 2.0);
        assert!((c.fov_deg - 38.0).abs() < 0.5 && cs.label(View::Cockpit) == "CONTROL");
        cs.focus(Focus::Seat);
        assert_eq!(cs.label(View::Cockpit), "SEAT");
    }

    #[test]
    fn rig_is_finite_in_every_view_and_snap_is_instant() {
        let mut f = flight();
        f.apply(crate::game::Action::ApAutoTakeoff);
        let mut cs = CamState::default();
        for view in View::ALL {
            for _ in 0..30 {
                f.advance(1.0 / 60.0, &crate::game::PilotInput::default());
                let (c, third) = cs.rig(&f, view, 1.0 / 60.0, None);
                assert!(c.pos.is_finite() && c.fwd.is_finite() && c.up.is_finite() && c.fov_deg > 2.0 && c.fov_deg <= 100.0, "{view:?}");
                assert!((c.fwd.length() - 1.0).abs() < 1e-3 && (c.up.length() - 1.0).abs() < 1e-3);
                assert_eq!(third, !view.is_interior());
            }
        }
        // menu orbit still works
        assert!(cs.rig(&f, View::Chase, 0.016, Some(3.0)).1);
        // snap: one huge step lands exactly on the preset
        let mut a = CamState::default();
        a.focus(Focus::Nd);
        a.snap();
        let one = a.rig(&f, View::Cockpit, 1.0, None).0;
        let settled = run(&mut a, &f, View::Cockpit, 2.0);
        assert!(one.fwd.angle_between(settled.fwd).to_degrees() < 1.5, "snapped straight to the preset");
        // the menu orbit bypasses all state, even with absurd dt
        assert!(cs.rig(&f, View::Cockpit, 50.0, None).0.pos.is_finite());
    }

    #[test]
    fn cockpit_camera_sits_at_the_eye_point_and_follows_the_aircraft() {
        let f = flight();
        let mut cs = CamState::default();
        let (cap, third) = cs.rig(&f, View::Cockpit, 0.016, None);
        assert!(!third);
        let eye = f.fm.pos + f.fm.quat * eye_body(&f.fm);
        assert!((cap.pos - eye).length() < 0.1, "captain camera sits at the eye point");
        let right = (f.fm.quat * DVec3::X).as_vec3();
        let mut cs = CamState::default();
        cs.cockpit.look.yaw = 90.0;
        let c = run(&mut cs, &f, View::Cockpit, 1.5);
        assert!(c.fwd.dot(right) > 0.9, "look right turns to the aircraft's right");
    }
}
