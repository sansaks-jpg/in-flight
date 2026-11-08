//! 6-DOF rigid-body flight model (port of `src/sim/physics.ts`).
//!
//! Body frame: +X right, +Y up, -Z forward. World: +X east, +Y up, -Z north.
//! The step function is allocation-free (no heap use in the hot path) so it can run at 120 Hz without GC-like spikes
//! or leaks. Ground height is supplied as a closure so the model has no dependency on the renderer.

use crate::fbw;
use crate::geo::{clamp, lerp, smoothstep, G, KT};
use crate::specs::{AircraftSpec, A320};
use glam::{DQuat, DVec3};

/// Real-time air state: ISA temperature deviation (K) and sea-level pressure (hPa).
#[derive(Clone, Copy, Debug)]
pub struct AirState {
    pub d_t: f64,
    pub qnh: f64,
}
impl Default for AirState {
    fn default() -> Self {
        Self { d_t: 0.0, qnh: 1013.25 }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Atmosphere {
    pub t: f64,
    pub rho: f64,
    pub p: f64,
    pub a: f64,
    pub sigma: f64,
}

pub fn atmosphere(h: f64, air: &AirState) -> Atmosphere {
    let hh = h.max(-300.0);
    let t_isa = if hh < 11000.0 { 288.15 - 0.0065 * hh } else { 216.65 };
    let t = t_isa + air.d_t * if hh < 11000.0 { 1.0 - hh / 22000.0 } else { 0.5 };
    let p_isa = if hh < 11000.0 {
        101325.0 * (t_isa / 288.15).powf(5.2559)
    } else {
        22632.0 * (-(hh - 11000.0) / 6342.0).exp()
    };
    let p = p_isa * (1.0 + (air.qnh / 1013.25 - 1.0) * (-hh / 9000.0).exp());
    let rho = p / (287.05 * t);
    Atmosphere { t, rho, p, a: (1.4 * 287.05 * t).sqrt(), sigma: rho / 1.225 }
}

#[derive(Clone, Copy, Debug)]
pub struct Controls {
    /// pilot demand -1..1 (pitch +1 = pull back / nose up, roll +1 = right, yaw +1 = right)
    pub pitch: f64,
    pub roll: f64,
    pub yaw: f64,
    pub throttle: f64,
    pub brake: f64,
    pub parking: bool,
    pub reverse: bool,
    pub speedbrake: f64,
    pub flaps_idx: usize,
    pub gear_down: bool,
    pub trim: f64,
    pub assist: bool,
    pub ap_hold: bool,
    pub brake_l: f64,
    pub brake_r: f64,
    pub battery: bool,
    pub thr_offset: f64,
    /// 0 off / 1 LO / 2 MED / 3 MAX
    pub autobrake: u8,
    pub spoilers_armed: bool,
    pub rud_trim: f64,
    pub brake_press: f64,
    pub thr_limit: f64,
}
impl Default for Controls {
    fn default() -> Self {
        Self {
            pitch: 0.0,
            roll: 0.0,
            yaw: 0.0,
            throttle: 0.0,
            brake: 0.0,
            parking: true,
            reverse: false,
            speedbrake: 0.0,
            flaps_idx: 0,
            gear_down: true,
            trim: 0.0,
            assist: true,
            ap_hold: false,
            brake_l: 0.0,
            brake_r: 0.0,
            battery: true,
            thr_offset: 0.0,
            autobrake: 0,
            spoilers_armed: false,
            rud_trim: 0.0,
            brake_press: 1.0,
            thr_limit: 1.0,
        }
    }
}

/// A320 slat/flap detents (0, 1, 2, 3, FULL) -> fraction of full-flap lift / drag.
const FLAP_LIFT: [f64; 5] = [0.0, 0.12, 0.40, 0.62, 1.0];
const FLAP_DRAG: [f64; 5] = [0.0, 0.08, 0.30, 0.58, 1.0];
/// Fraction of full-flap lift at flap position `fl` (0..1) - shared with `fbw::speed_at_alpha_kt`.
pub fn flap_lift_fraction(fl: f64) -> f64 {
    tab(&FLAP_LIFT, fl)
}
fn tab(t: &[f64; 5], x: f64) -> f64 {
    let f = clamp(x, 0.0, 1.0) * (t.len() - 1) as f64;
    let i = ((t.len() - 2) as f64).min(f.floor()) as usize;
    t[i] + (t[i + 1] - t[i]) * (f - i as f64)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct GearState {
    pub comp: f64,
    pub fnorm: f64,
    pub contact: bool,
    pub skid: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ContactKind {
    Touchdown,
    Hull,
    GearBreak,
}

#[derive(Clone, Copy, Debug)]
pub struct ContactEvent {
    pub kind: ContactKind,
    pub vs: f64,
    pub speed: f64,
    pub bank: f64,
    pub pitch: f64,
    pub point: DVec3,
    pub severity: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum EngState {
    #[default]
    Off,
    Starting,
    Running,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Engine {
    pub state: EngState,
    pub t: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Surfaces {
    pub el: f64,
    pub ail: f64,
    pub rud: f64,
}

pub const MAX_EVENTS: usize = 32;
const UP: DVec3 = DVec3::Y;

pub struct FlightModel {
    pub spec: &'static AircraftSpec,
    pub air: AirState,
    pub pos: DVec3,
    pub vel: DVec3,
    pub quat: DQuat,
    /// body angular velocity rad/s (x pitch, y yaw, z roll)
    pub w: DVec3,
    pub ctl: Controls,
    pub fuel: f64,
    pub mass: f64,
    pub gear_pos: f64,
    pub flaps_pos: f64,
    pub sb_pos: f64,
    pub n: [f64; 2],
    pub eng: [Engine; 2],
    pub friction: f64,
    pub wetness: f64,
    pub surf: Surfaces,
    pub trim_auto: f64,
    pub gear: [GearState; 3],
    pub on_ground: bool,
    pub wow: bool,
    pub airborne_time: f64,
    // outputs for instruments / warnings
    pub alpha: f64,
    pub beta: f64,
    pub ias: f64,
    pub tas: f64,
    pub gs: f64,
    pub vs: f64,
    pub mach: f64,
    pub qbar: f64,
    pub nz: f64,
    pub nx: f64,
    pub ny: f64,
    pub pitch: f64,
    pub bank: f64,
    pub heading: f64,
    pub track: f64,
    pub rho: f64,
    pub stall_warn: bool,
    pub stalled: bool,
    pub alpha_stall: f64,
    pub thrust_n: f64,
    pub fuel_flow: f64,
    pub damage: f64,
    pub engine_out: bool,
    pub wind: DVec3,
    pub gust: DVec3,
    pub agl: f64,
    pub ground_h: f64,
    pub events: Vec<ContactEvent>,
    pub crashed: bool,
    pub crash_reason: &'static str,
    t: f64,
    last_vs_air: f64,
    td_flag: bool,
    pub auto_sb: f64,
    auto_brk: f64,
    share: [f64; 3],
}

fn spec_ref_mass(s: &AircraftSpec) -> f64 {
    s.empty_mass + s.payload + s.fuel_cap * 0.6
}

impl FlightModel {
    pub fn new(fuel_kg: Option<f64>) -> Self {
        let spec: &'static AircraftSpec = &A320;
        let fuel = fuel_kg.unwrap_or(spec.fuel_cap);
        // static load share from geometry so the aircraft sits level on its gear (CG between nose and mains)
        let nose = spec.gear.iter().find(|g| g.nose).unwrap();
        let mains: Vec<_> = spec.gear.iter().filter(|g| !g.nose).collect();
        let zm = mains.iter().map(|g| g.pos[2]).sum::<f64>() / mains.len() as f64;
        let zn = -nose.pos[2];
        let sn = zm / (zm + zn);
        let mut share = [0.0; 3];
        for (i, g) in spec.gear.iter().enumerate() {
            share[i] = if g.nose { sn } else { (1.0 - sn) / mains.len() as f64 };
        }
        Self {
            spec,
            air: AirState::default(),
            pos: DVec3::ZERO,
            vel: DVec3::ZERO,
            quat: DQuat::IDENTITY,
            w: DVec3::ZERO,
            ctl: Controls::default(),
            fuel,
            mass: spec.empty_mass + spec.payload + fuel,
            gear_pos: 1.0,
            flaps_pos: 0.0,
            sb_pos: 0.0,
            n: [0.2; 2],
            eng: [Engine { state: EngState::Running, t: 0.0 }; 2],
            friction: 1.0,
            wetness: 0.0,
            surf: Surfaces::default(),
            trim_auto: 0.0,
            gear: [GearState::default(); 3],
            on_ground: true,
            wow: false,
            airborne_time: 0.0,
            alpha: 0.0,
            beta: 0.0,
            ias: 0.0,
            tas: 0.0,
            gs: 0.0,
            vs: 0.0,
            mach: 0.0,
            qbar: 0.0,
            nz: 1.0,
            nx: 0.0,
            ny: 0.0,
            pitch: 0.0,
            bank: 0.0,
            heading: 0.0,
            track: 0.0,
            rho: 1.225,
            stall_warn: false,
            stalled: false,
            alpha_stall: 0.28,
            thrust_n: 0.0,
            fuel_flow: 0.0,
            damage: 0.0,
            engine_out: false,
            wind: DVec3::ZERO,
            gust: DVec3::ZERO,
            agl: 0.0,
            ground_h: 0.0,
            events: Vec::with_capacity(MAX_EVENTS),
            crashed: false,
            crash_reason: "",
            t: 0.0,
            last_vs_air: 0.0,
            td_flag: false,
            auto_sb: 0.0,
            auto_brk: 0.0,
            share,
        }
    }

    pub fn total_mass(&self) -> f64 {
        self.spec.empty_mass + self.spec.payload + self.fuel
    }
    pub fn forward(&self) -> DVec3 {
        self.quat * DVec3::new(0.0, 0.0, -1.0)
    }
    pub fn engines_running(&self) -> bool {
        self.eng.iter().all(|e| e.state == EngState::Running)
    }
    pub fn any_engine_running(&self) -> bool {
        self.eng.iter().any(|e| e.state == EngState::Running)
    }

    /// Real start-up: starter engages (needs battery and fuel). Returns a refusal reason or "".
    pub fn start_engine(&mut self, i: usize) -> &'static str {
        if i >= 2 {
            return "No such engine";
        }
        match self.eng[i].state {
            EngState::Starting => return "Engine already starting",
            EngState::Running => return "Engine already running",
            EngState::Off => {}
        }
        if !self.ctl.battery {
            return "Battery is OFF - no electrical power for the starter";
        }
        if self.fuel <= 0.0 {
            return "No fuel";
        }
        self.eng[i] = Engine { state: EngState::Starting, t: 0.0 };
        ""
    }
    pub fn stop_engine(&mut self, i: usize) {
        if i < 2 {
            self.eng[i] = Engine { state: EngState::Off, t: 0.0 };
        }
    }

    /// Place on ground (runway threshold / stand), heading in degrees true.
    pub fn place_on_runway(&mut self, x: f64, z: f64, hdg: f64, ground_y: f64, cold_dark: bool) {
        let s = self.spec;
        let gy = s.gear[1].pos[1];
        self.quat = DQuat::from_axis_angle(UP, -hdg.to_radians());
        // rest at the static oleo deflection so the struts do not "settle" with a jolt on the first frames
        let static_comp = 0.06_f64.max(s.gear_travel * 0.45);
        self.pos = DVec3::new(x, ground_y - gy - static_comp, z);
        self.vel = DVec3::ZERO;
        self.w = DVec3::ZERO;
        self.ctl.parking = true;
        self.ctl.throttle = 0.0;
        self.n = [if cold_dark { 0.0 } else { s.idle }; 2];
        self.gear_pos = 1.0;
        self.ctl.gear_down = true;
        let st = if cold_dark { EngState::Off } else { EngState::Running };
        self.eng = [Engine { state: st, t: 0.0 }; 2];
        self.ctl.battery = !cold_dark;
        self.events.clear();
        self.crashed = false;
        self.damage = 0.0;
        // resting on the gear from the very first frame (so autopilot / state machine see "on ground" immediately)
        self.wow = true;
        self.on_ground = true;
        self.airborne_time = 0.0;
        self.td_flag = false;
    }

    /// Spawn in stable flight (trimmed for level flight).
    #[allow(clippy::too_many_arguments)]
    pub fn place_airborne(&mut self, x: f64, y: f64, z: f64, hdg: f64, kt: f64, flaps_idx: usize, gear_down: bool) {
        let s = self.spec;
        self.quat = DQuat::from_axis_angle(UP, -hdg.to_radians());
        self.pos = DVec3::new(x, y, z);
        let v = kt * KT;
        self.w = DVec3::ZERO;
        self.ctl.parking = false;
        self.ctl.flaps_idx = flaps_idx;
        self.flaps_pos = flaps_idx as f64 / s.flap_detents as f64;
        self.ctl.gear_down = gear_down;
        self.gear_pos = if gear_down { 1.0 } else { 0.0 };
        self.ctl.throttle = 0.55;
        self.n = [0.55; 2];
        self.on_ground = false;
        self.airborne_time = 30.0;
        self.eng = [Engine { state: EngState::Running, t: 0.0 }; 2];
        self.ctl.battery = true;
        let q = 0.5 * atmosphere(y, &self.air).rho * v * v;
        let cl = self.total_mass() * G / (q * s.s);
        let al = (cl - s.cl0 - s.flap_cl * self.flaps_pos) / s.cla;
        let q0 = self.quat;
        self.quat = q0 * DQuat::from_axis_angle(DVec3::X, al);
        self.vel = (q0 * DQuat::from_axis_angle(DVec3::X, 0.0)) * DVec3::new(0.0, 0.0, -v);
        self.trim_auto = clamp(-(s.cm0 + s.cma * al) / s.cmde, -0.9, 0.9);
        self.events.clear();
        self.crashed = false;
    }

    fn alpha_moment(&self, a_stall: f64) -> f64 {
        let a = self.alpha;
        if a > a_stall {
            a_stall - (a - a_stall) * 0.6
        } else {
            a
        }
    }

    fn push_event(&mut self, e: ContactEvent) {
        if self.events.len() < MAX_EVENTS {
            self.events.push(e);
        }
    }

    pub fn step(&mut self, dt: f64, ground_at: &dyn Fn(f64, f64) -> f64) {
        let s = self.spec;
        let mut c = self.ctl;
        self.t += dt;
        let atm = atmosphere(self.pos.y, &self.air);
        self.rho = atm.rho;

        // ---- config actuators ----
        let tgt_flap = c.flaps_idx as f64 / s.flap_detents as f64;
        self.flaps_pos += clamp(tgt_flap - self.flaps_pos, -dt * 0.12, dt * 0.12);
        let g_tgt = if c.gear_down { 1.0 } else { 0.0 };
        self.gear_pos += clamp(g_tgt - self.gear_pos, -dt / 6.0, dt / 6.0);
        // ground spoilers: armed + weight on wheels + idle thrust (or reversers) above 72 kt
        let g_spoil = c.spoilers_armed && self.wow && self.gs > 36.0 && (c.throttle < 0.12 || c.reverse);
        if !self.wow || self.gs < 20.0 {
            self.auto_sb = 0.0;
        } else if g_spoil {
            self.auto_sb = 1.0;
        }
        self.sb_pos += clamp(c.speedbrake.max(self.auto_sb) - self.sb_pos, -dt * 0.8, dt * 0.8);

        // ---- airmass-relative velocity ----
        let wind_now = self.wind + self.gust;
        let va = self.vel - wind_now;
        let qi = self.quat.inverse();
        let vb = qi * va;
        let vmag = vb.length().max(0.1);
        let u = -vb.z;
        self.alpha = (-vb.y).atan2(u.max(0.5));
        self.beta = vb.x.atan2(u.max(0.5));
        self.tas = vmag;
        self.ias = vmag * atm.sigma.sqrt();
        self.qbar = 0.5 * atm.rho * vmag * vmag;
        self.mach = vmag / atm.a;
        self.gs = self.vel.x.hypot(self.vel.z);
        self.vs = self.vel.y;

        // attitude readouts
        let fwd = self.forward();
        self.pitch = clamp(fwd.y, -1.0, 1.0).asin();
        let right_w = self.quat * DVec3::X;
        let up_w = self.quat * DVec3::Y;
        self.bank = (-right_w.y).atan2(up_w.y); // + = right wing down
        self.heading = ((fwd.x.atan2(-fwd.z)).to_degrees() + 360.0) % 360.0;
        self.track = if self.gs > 1.0 {
            ((self.vel.x.atan2(-self.vel.z)).to_degrees() + 360.0) % 360.0
        } else {
            self.heading
        };

        // ---- stall model ----
        let fl = self.flaps_pos;
        let fl_l = tab(&FLAP_LIFT, fl);
        let fl_d = tab(&FLAP_DRAG, fl);
        let cl0 = s.cl0 + s.flap_cl * fl_l;
        let cl_max_e = s.clmax + s.flap_cl * fl * 1.05;
        let a_stall = 0.26_f64.max((cl_max_e - cl0) / s.cla + 0.05 * fl);
        self.alpha_stall = a_stall;
        let a_stall_neg = -(a_stall * 0.8) - 0.04;
        let v_stall_ref = (if fl > 0.3 { s.vs0 } else { s.vs1 }) * KT;
        self.stall_warn = self.airborne_time > 1.2 && !self.wow && (self.alpha > a_stall * fbw::ALPHA_SW_FRAC || self.ias < v_stall_ref * 1.04);
        self.stalled = self.airborne_time > 1.2 && !self.wow && (self.alpha > a_stall + 0.02 || self.ias < v_stall_ref * 0.95);

        // ---- flight control system ----
        let (elev_cmd, ail_cmd, rud_cmd);
        let (pilot_pitch, pilot_roll) = (c.pitch, c.roll);
        if c.assist {
            // A320 NORMAL LAW: sidestick = load-factor / roll-rate demand, flight-path hold with stick neutral,
            // auto-trim, pitch / bank / alpha / high-speed protections.
            let v = self.tas.max(60.0);
            let q = self.w.x;
            let cb = self.bank.cos().max(0.2);
            let kias = self.ias / KT;
            let nz_max = if self.flaps_pos > 0.05 { fbw::NZ_UP_FLAPS } else { fbw::NZ_UP_CLEAN };
            let mut q_cmd = (G / v) * (if pilot_pitch > 0.0 { pilot_pitch * (nz_max - 1.0) } else { pilot_pitch * 2.0 })
                + (G * self.bank.tan() * self.bank.sin()) / v;
            let pitch_deg = self.pitch.to_degrees();
            let p_lim = if self.flaps_pos > 0.9 { fbw::PITCH_UP_FLAPS_DEG } else { fbw::PITCH_UP_CLEAN_DEG };
            if pitch_deg > p_lim && q_cmd > 0.0 {
                q_cmd = -(pitch_deg - p_lim) * 0.04;
            }
            if pitch_deg < fbw::PITCH_DOWN_DEG && q_cmd < 0.0 {
                q_cmd = (fbw::PITCH_DOWN_DEG - pitch_deg) * 0.04;
            }
            let a_prot = a_stall * fbw::ALPHA_PROT_FRAC;
            let a_max = a_stall * fbw::ALPHA_MAX_FRAC;
            if !self.wow && self.alpha > a_prot {
                // alpha-protection: stick neutral holds alpha prot, full back stick commands alpha max (linear in between)
                let a_dem = a_prot + (a_max - a_prot) * pilot_pitch.max(0.0);
                q_cmd = q_cmd.min((a_dem - self.alpha) * 2.5);
            }
            if self.alpha > a_max {
                q_cmd = q_cmd.min(-0.15);
            }
            let ovsp = (kias - s.vne).max((self.mach - fbw::MMO) * 300.0);
            if ovsp > 0.0 {
                q_cmd = q_cmd.max((ovsp * 0.004).min(0.1));
            }
            let err = q_cmd - q;
            if !self.wow {
                if pilot_pitch.abs() < 0.04 && !c.ap_hold {
                    self.trim_auto = clamp(self.trim_auto + err * 0.9 * dt * 0.7, -0.95, 0.95);
                } else {
                    self.trim_auto = clamp(self.trim_auto + err * 0.15 * dt, -0.95, 0.95);
                }
            }
            elev_cmd = self.trim_auto + err * 1.6 + c.trim * 0.3;
            let bank_deg = self.bank.to_degrees();
            let mut p_cmd = pilot_roll * s.max_roll_rate;
            if !c.ap_hold && pilot_roll.abs() < 0.03 && bank_deg.abs() < fbw::BANK_NEUTRAL_DEG {
                p_cmd = -self.bank * 0.9;
            } else if !c.ap_hold && pilot_roll.abs() < 0.03 {
                p_cmd = -(bank_deg - bank_deg.signum() * fbw::BANK_NEUTRAL_DEG).to_radians() * 0.9;
            }
            if bank_deg.abs() > fbw::BANK_MAX_DEG && pilot_roll.signum() == bank_deg.signum() {
                p_cmd = 0.0;
            }
            if self.alpha > a_max {
                p_cmd *= 0.5;
            }
            ail_cmd = (p_cmd - (-self.w.z)) * 1.1 / cb;
            let rud_lim = clamp(1.0 - (kias - 160.0) / 220.0, 0.25, 1.0);
            let ground_yaw = if self.wow {
                if c.yaw.abs() < 0.05 && self.gs > 3.0 {
                    clamp(self.w.y * 0.9, -0.5, 0.5)
                } else {
                    0.0
                }
            } else {
                clamp(self.beta * 7.0, -0.5, 0.5)
            };
            rud_cmd = c.yaw * rud_lim + c.rud_trim * 0.3 + ground_yaw;
        } else {
            elev_cmd = pilot_pitch + c.trim * 0.5;
            ail_cmd = pilot_roll;
            rud_cmd = c.yaw + c.rud_trim * 0.3;
        }
        if self.wow && c.assist {
            let tgt = clamp(-s.cm0 / s.cmde, -0.9, 0.9) * 0.5;
            self.trim_auto += (tgt - self.trim_auto) * dt * 0.8;
        }
        let (elev_cmd, ail_cmd, rud_cmd) = (clamp(elev_cmd, -1.0, 1.0), clamp(ail_cmd, -1.0, 1.0), clamp(rud_cmd, -1.0, 1.0));
        self.surf.el += clamp(elev_cmd - self.surf.el, -dt * 4.0, dt * 4.0);
        self.surf.ail += clamp(ail_cmd - self.surf.ail, -dt * 5.0, dt * 5.0);
        self.surf.rud += clamp(rud_cmd - self.surf.rud, -dt * 4.0, dt * 4.0);

        // ---- engines (real start-up sequence: OFF -> starter -> light-off -> idle -> running) ----
        let mut thrust = 0.0;
        let mut ff = 0.0;
        // alpha-floor (normal law): near the stall the FADEC commands TOGA whatever the lever position
        let alpha_floor = c.assist && !self.wow && self.airborne_time > 1.2 && self.alpha > a_stall * fbw::ALPHA_FLOOR_FRAC;
        let thr_cmd = if alpha_floor { 1.0 } else { c.throttle };
        let thr_base = if self.fuel > 0.0 { thr_cmd } else { 0.0 };
        let n_eng = s.engines;
        let mut any_out = false;
        for i in 0..n_eng {
            let mut e = self.eng[i];
            if self.fuel <= 0.0 && e.state != EngState::Off {
                e.state = EngState::Off;
                any_out = true;
            }
            let thr = (if i == 1 { clamp(thr_base + c.thr_offset, 0.0, 1.0) } else { thr_base }) * c.thr_limit;
            let (tgt, tau);
            match e.state {
                EngState::Starting => {
                    e.t += dt;
                    let k = clamp(e.t / s.start_secs, 0.0, 1.0);
                    let crank = (k / 0.45 * 0.4).min(0.4);
                    let accel = if k > 0.45 { smoothstep(0.45, 1.0, k) } else { 0.0 };
                    self.n[i] = s.idle * (crank + (1.0 - 0.4) * accel);
                    if !c.battery && k < 0.45 {
                        e = Engine { state: EngState::Off, t: 0.0 };
                    }
                    if k >= 1.0 {
                        e = Engine { state: EngState::Running, t: 0.0 };
                    }
                    tgt = self.n[i];
                    tau = 1e9;
                }
                EngState::Running => {
                    tgt = s.idle + (1.0 - s.idle) * thr;
                    tau = if tgt > self.n[i] { s.spool_up } else { s.spool_down };
                }
                EngState::Off => {
                    tgt = 0.0;
                    tau = 9.0;
                }
            }
            self.eng[i] = e;
            if e.state != EngState::Starting {
                self.n[i] += (tgt - self.n[i]) * (dt / tau).min(1.0);
            }
            let nn = self.n[i];
            let run = e.state == EngState::Running;
            let pf = clamp((nn - s.idle) / (1.0 - s.idle), 0.0, 1.0);
            let mut t = 0.0;
            if run {
                let lapse = atm.sigma.powf(0.78) * (1.0 - 0.32 * self.mach.min(1.0));
                let idle_t = 0.05;
                t = (s.thrust / n_eng as f64) * lapse * (idle_t + (1.0 - idle_t) * pf.powf(1.25));
                if c.reverse && self.wow {
                    t = -(s.thrust / n_eng as f64) * 0.38 * pf.powf(1.2) * lapse;
                }
            }
            thrust += t;
            let starting = if e.state == EngState::Starting && e.t / s.start_secs > 0.45 { 0.5 } else { 0.0 };
            ff += s.fuel_flow
                * (0.08 + 0.92 * nn.max(0.01).powf(1.4))
                * (if run { 1.0 } else { starting })
                * (if self.fuel > 0.0 { 1.0 } else { 0.0 })
                * (atm.sigma + 0.3).max(0.55);
        }
        self.engine_out = self.fuel <= 0.0 || any_out;
        self.thrust_n = thrust;
        self.fuel_flow = ff;
        self.fuel = (self.fuel - ff * dt).max(0.0);
        let mass = self.total_mass();
        self.mass = mass;
        let inv = mass / spec_ref_mass(s);

        // ---- aerodynamics (body frame) ----
        let dir_v = vb / vmag;
        let cl_lin = cl0 + s.cla * self.alpha;
        let a_pos = self.alpha >= 0.0;
        let a_s = if a_pos { a_stall } else { a_stall_neg };
        let (a_abs, a_s_abs) = (self.alpha.abs(), a_s.abs());
        let cl = if a_abs < a_s_abs - 0.03 {
            cl_lin
        } else {
            let peak = cl0 + s.cla * a_s;
            let fp = (if a_pos { 1.0 } else { -1.0 }) * 1.15 * (2.0 * a_abs.min(std::f64::consts::FRAC_PI_2)).sin();
            let t = smoothstep(a_s_abs - 0.03, a_s_abs + 0.09, a_abs);
            let soft = if a_pos { cl_lin.min(peak) } else { cl_lin.max(peak) };
            lerp(soft, fp * 0.95, t)
        };
        // ground effect
        let h = self.agl.max(0.5);
        let ge = (16.0 * h / s.b).powi(2);
        let ge_f = ge / (1.0 + ge);
        let k = 1.0 / (std::f64::consts::PI * s.e * (s.b * s.b / s.s));
        let mut cd = s.cd0
            + k * ge_f * cl * cl
            + s.flap_cd * fl_d
            + s.gear_cd * self.gear_pos
            + s.sb_cd * self.sb_pos
            + 0.45 * self.alpha.sin().powi(2) * smoothstep(a_s_abs * 0.9, a_s_abs * 1.5, a_abs)
            + 0.6 * self.beta.sin().powi(2);
        if self.mach > 0.78 {
            cd += 0.12 * (self.mach - 0.78).powf(1.5) * 12.0;
        }
        cd += (self.damage / 100.0) * 0.02;
        let qs = self.qbar * s.s;
        let mut fb = dir_v * (-qs * cd);
        let l_dir = DVec3::Y - dir_v * DVec3::Y.dot(dir_v);
        if l_dir.length_squared() > 1e-6 {
            fb += l_dir.normalize() * (qs * cl);
        }
        fb.x += -qs * 0.9 * self.beta;
        fb.z -= thrust;

        // ---- aerodynamic moments ----
        let vm = vmag.max(20.0);
        let q_ctl = self.qbar;
        let eff_k = smoothstep(0.0, 6.0, vmag);
        let (p, qrate, r) = (-self.w.z, self.w.x, -self.w.y);
        let (p_hat, q_hat, r_hat) = (p * s.b / (2.0 * vm), qrate * s.c / (2.0 * vm), r * s.b / (2.0 * vm));
        let m_pitch = qs * s.c * (s.cm0 + s.cma * self.alpha_moment(a_stall) + s.cmq * q_hat) + q_ctl * s.s * s.c * s.cmde * self.surf.el * eff_k;
        let stall_buff = if self.stalled { (self.t * 31.0).sin() * 0.02 } else { 0.0 };
        let m_roll = qs * s.b * (s.clb * self.beta + s.clp * p_hat + 0.02 * r_hat)
            + q_ctl * s.s * s.b * s.clda * self.surf.ail * eff_k * (if self.stalled { 0.35 } else { 1.0 });
        let m_yaw = qs * s.b * (s.cnb * self.beta + s.cnr * r_hat) + q_ctl * s.s * s.b * s.cndr * self.surf.rud * eff_k * 0.9;
        let tau_aero = DVec3::new(m_pitch + stall_buff * qs * s.c, -m_yaw, -m_roll);

        // ---- world-frame force accumulation ----
        let mut fw = self.quat * fb;
        let mut torque_w = DVec3::ZERO;
        fw.y -= mass * G;

        // ---- landing gear + ground ----
        self.ground_h = ground_at(self.pos.x, self.pos.z);
        self.agl = self.pos.y + s.gear[1].pos[1] - self.ground_h;
        let mut any_contact = false;
        let mut steer = 0.0;
        if self.wow || self.agl < 4.0 {
            let damp = if c.assist && c.yaw.abs() < 0.05 && self.gs > 3.0 { clamp(self.w.y * 0.6, -0.3, 0.3) } else { 0.0 };
            steer = (c.yaw + damp) * s.max_steer * (1.0 - smoothstep(8.0, 40.0, self.gs));
        }
        // autobrake: decel target LO 1.7 / MED 3.0 / MAX 4.0 m/s² once ground spoilers are out
        let mut ab_brake = 0.0;
        if c.autobrake > 0 && self.wow && self.auto_sb > 0.0 && self.gs > 6.0 && c.brake < 0.3 {
            let tgt = [0.0, 1.7, 3.0, 4.0][c.autobrake.min(3) as usize];
            self.auto_brk = clamp(self.auto_brk + (tgt - (-self.nx * G)) * 0.22 * dt, 0.0, 1.0);
            ab_brake = self.auto_brk;
        } else {
            self.auto_brk = 0.0;
            if c.brake >= 0.3 {
                self.ctl.autobrake = 0;
                c.autobrake = 0;
            }
        }
        let brake_in = if c.parking { 1.0 } else { c.brake.max(ab_brake) * c.brake_press };
        let gear_active = self.gear_pos > 0.9;
        let ang_w_world = self.quat * self.w;
        for (i, g) in s.gear.iter().enumerate() {
            let mut st = GearState::default();
            let prev_comp = self.gear[i].comp;
            if !gear_active {
                self.gear[i] = st;
                continue;
            }
            let r_w = self.quat * DVec3::from_array(g.pos);
            let pw = self.pos + r_w;
            let gh = ground_at(pw.x, pw.z);
            let pen = gh - pw.y;
            if pen <= 0.0 {
                st.comp = lerp(prev_comp, 0.0, 0.3);
                self.gear[i] = st;
                continue;
            }
            let vel_p = self.vel + ang_w_world.cross(r_w);
            let static_comp = 0.06_f64.max(s.gear_travel * 0.45);
            let gsh = self.share[i];
            let k_spring = (mass * G * gsh) / static_comp;
            let m_eff = mass * gsh;
            let d_damp = 2.0 * 0.55 * (k_spring * m_eff).sqrt();
            let comp_c = pen.min(s.gear_travel);
            let mut fn_ = k_spring * comp_c + if pen > s.gear_travel { k_spring * 6.0 * (pen - s.gear_travel) } else { 0.0 };
            let cdot = -vel_p.y;
            fn_ += d_damp * clamp(cdot, -2.0, 8.0) * if cdot > 0.0 { 1.0 } else { 0.5 };
            fn_ = fn_.max(0.0);
            st.comp = comp_c;
            st.fnorm = fn_;
            st.contact = true;
            any_contact = true;
            // tyre friction
            let mut fwd_w = self.quat * DVec3::new(0.0, 0.0, -1.0);
            fwd_w.y = 0.0;
            if fwd_w.length_squared() < 1e-4 {
                fwd_w = DVec3::new(0.0, 0.0, -1.0);
            }
            fwd_w = fwd_w.normalize();
            if g.nose && steer != 0.0 {
                fwd_w = DQuat::from_axis_angle(UP, -steer) * fwd_w;
            }
            let lat_w = UP.cross(fwd_w) * -1.0;
            let (vl, vt) = (vel_p.dot(fwd_w), vel_p.dot(lat_w));
            let brk = if g.nose { 0.0 } else { clamp(brake_in + if g.pos[0] > 0.0 { c.brake_r } else { c.brake_l }, 0.0, 1.0) };
            let roll_res = 0.015 + (0.0008 * vl.abs()).min(0.012) + brk * 0.45 * self.friction * (1.0 - 0.5 * self.wetness);
            let fl_ = -fn_ * roll_res * (vl * 2.5).tanh();
            let lim = fn_ * (if g.nose { 0.75 } else { 0.95 }) * self.friction;
            let ft = clamp(-fn_ * (if g.nose { 0.9 } else { 1.0 }) * (vt * 2.2).tanh(), -lim, lim);
            st.skid = vt.abs() > 3.0;
            let f = DVec3::new(0.0, fn_, 0.0) + fwd_w * fl_ + lat_w * ft;
            fw += f;
            torque_w += r_w.cross(f);
            self.gear[i] = st;
            // touchdown event
            if !self.wow && self.airborne_time > 1.5 && !self.td_flag {
                self.td_flag = true;
                let ev = ContactEvent {
                    kind: ContactKind::Touchdown,
                    vs: self.last_vs_air,
                    speed: self.gs,
                    bank: self.bank,
                    pitch: self.pitch,
                    point: pw,
                    severity: self.last_vs_air.abs() / s.max_sink,
                };
                self.push_event(ev);
                if -self.last_vs_air > s.max_sink * 2.6 && self.gear_pos > 0.9 {
                    self.push_event(ContactEvent { kind: ContactKind::GearBreak, severity: 2.0, ..ev });
                }
            }
        }
        self.wow = any_contact;
        if !any_contact {
            self.airborne_time += dt;
            self.last_vs_air = self.vel.y;
            if self.agl > 2.0 {
                self.td_flag = false;
            }
        } else {
            self.airborne_time = 0.0;
        }
        // parking brake stiction
        if self.wow && c.parking && self.gs < 1.2 && c.throttle.abs() < 0.45 {
            self.vel.x *= 0.9;
            self.vel.z *= 0.9;
        }

        // ---- hull contacts (belly, tail, wing tips, engines) ----
        for hp in s.hull.iter() {
            let r_w = self.quat * DVec3::from_array(*hp);
            let pw = self.pos + r_w;
            let pen = ground_at(pw.x, pw.z) - pw.y;
            if pen > 0.0 {
                let sp = self.vel.length();
                let v_n = -self.vel.y;
                let fnn = clamp(pen * mass * 12.0 + v_n.max(0.0) * mass * 6.0, 0.0, mass * G * 3.0);
                let mut f = DVec3::new(0.0, fnn, 0.0);
                let hv = DVec3::new(self.vel.x, 0.0, self.vel.z);
                f += hv.normalize_or_zero() * -(fnn * 0.6).min(mass * 6.0);
                fw += f;
                torque_w += r_w.cross(f);
                let sev = v_n.max(0.0) + sp * 0.05;
                self.damage += dt * if sp > 3.0 { 20.0 + sp } else { 0.0 } + (v_n - 2.0).max(0.0) * 12.0;
                self.push_event(ContactEvent {
                    kind: ContactKind::Hull,
                    vs: -v_n,
                    speed: sp,
                    bank: self.bank,
                    pitch: self.pitch,
                    point: pw,
                    severity: sev,
                });
                if (v_n > 9.0 || (sp > 55.0 && v_n > 5.0) || self.damage >= 100.0) && !self.crashed {
                    self.crashed = true;
                    self.crash_reason = if v_n > 9.0 || sp > 55.0 { "Impact with terrain" } else { "Aircraft destroyed by ground contact" };
                }
            }
        }

        // ---- integrate ----
        let acc = fw / mass;
        let sf = qi * (acc + DVec3::new(0.0, G, 0.0));
        self.nz = sf.y / G;
        self.nx = -sf.z / G;
        self.ny = sf.x / G;
        self.vel += acc * dt;
        let t_b = qi * torque_w + tau_aero;
        // I axis mapping: body X = pitch axis (Iyy), Y = yaw axis (Izz), Z = roll axis (Ixx)
        let ib = DVec3::new(s.iyy * inv, s.izz * inv, s.ixx * inv);
        let iw = ib * self.w;
        let gyro = self.w.cross(iw);
        self.w.x += ((t_b.x - gyro.x) / ib.x) * dt;
        self.w.y += ((t_b.y - gyro.y) / ib.y) * dt;
        self.w.z += ((t_b.z - gyro.z) / ib.z) * dt;
        if self.wow && self.gs < 2.0 {
            self.w *= 1.0 - (dt * 3.0).min(0.5);
        }
        self.w = self.w.clamp_length_max(6.0);
        let wl = self.w.length();
        if wl > 1e-6 {
            self.quat *= DQuat::from_axis_angle(self.w / wl, wl * dt);
        }
        self.quat = self.quat.normalize();
        self.pos += self.vel * dt;
        if self.vel.length_squared() > 450.0 * 450.0 {
            self.vel = self.vel.normalize() * 450.0;
        }
        // numeric safety net: never let a NaN poison the simulation
        if !(self.pos.is_finite() && self.vel.is_finite() && self.quat.is_finite() && self.w.is_finite()) {
            self.crashed = true;
            self.crash_reason = "Simulation instability";
            self.vel = DVec3::ZERO;
            self.w = DVec3::ZERO;
            if !self.pos.is_finite() {
                self.pos = DVec3::ZERO;
            }
            if !self.quat.is_finite() {
                self.quat = DQuat::IDENTITY;
            }
        }
        self.ctl = Controls { autobrake: c.autobrake, ..self.ctl };
    }

    /// Speed / configuration limit checks used by warnings.
    pub fn limits(&self) -> Limits {
        let s = self.spec;
        let kias = self.ias / KT;
        let last = s.vfe.len() - 1;
        let flap_lim = s.vfe[last.min(self.ctl.flaps_idx)];
        let det = ((self.flaps_pos * s.flap_detents as f64).ceil() as usize).max(1).min(last);
        Limits {
            kias,
            overspeed: kias > s.vne || self.mach > 0.82,
            flap_over: self.flaps_pos > 0.05 && kias > s.vfe[det] + 6.0,
            gear_over: self.gear_pos > 0.02 && kias > s.vle + 5.0 && !self.wow,
            flap_lim,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub kias: f64,
    pub overspeed: bool,
    pub flap_over: bool,
    pub gear_over: bool,
    pub flap_lim: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isa_sea_level_and_tropopause() {
        let a = atmosphere(0.0, &AirState::default());
        assert!((a.rho - 1.225).abs() < 0.002, "{}", a.rho);
        assert!((a.t - 288.15).abs() < 1e-9);
        assert!((a.a - 340.3).abs() < 0.3);
        let b = atmosphere(11000.0, &AirState::default());
        assert!((b.rho - 0.3639).abs() < 0.006, "{}", b.rho);
        assert!((b.t - 216.65).abs() < 1e-9);
    }

    #[test]
    fn parked_aircraft_settles_and_stays_put() {
        let mut fm = FlightModel::new(None);
        fm.place_on_runway(0.0, 0.0, 0.0, 0.0, false);
        let g = |_x: f64, _z: f64| 0.0;
        for _ in 0..(120 * 20) {
            fm.step(1.0 / 120.0, &g);
        }
        assert!(fm.wow, "must have weight on wheels");
        assert!(!fm.crashed);
        assert!(fm.gs < 0.2, "parking brake must hold, gs={}", fm.gs);
        assert!(fm.damage < 1.0);
        // ride height: main gear compressed by roughly the static deflection (not sunk into the ground)
        assert!(fm.agl.abs() < 0.5, "agl={}", fm.agl);
        // static load: sum of gear forces ~ weight
        let total: f64 = fm.gear.iter().map(|g| g.fnorm).sum();
        let w = fm.mass * G;
        assert!((total - w).abs() / w < 0.06, "gear load {total} vs weight {w}");
    }

    #[test]
    fn trimmed_cruise_holds_level_flight() {
        let mut fm = FlightModel::new(Some(8000.0));
        fm.place_airborne(0.0, 3000.0, 0.0, 90.0, 250.0, 0, false);
        let g = |_x: f64, _z: f64| 0.0;
        let h0 = fm.pos.y;
        for _ in 0..(120 * 30) {
            // hold speed with a crude thrust law so energy is conserved
            let kias = fm.ias / KT;
            fm.ctl.throttle = clamp(fm.ctl.throttle + (250.0 - kias) * 0.0004, 0.0, 1.0);
            fm.step(1.0 / 120.0, &g);
        }
        assert!(!fm.crashed && !fm.stalled);
        // Normal law holds pitch *rate* with the stick neutral (not altitude), so a gentle phugoid is expected;
        // the vertical-speed-hold test lives in the autopilot suite. Here we require a bounded, stable response.
        assert!((fm.pos.y - h0).abs() < 450.0, "altitude drift {}", fm.pos.y - h0);
        assert!(fm.vs.abs() < 25.0, "vs {}", fm.vs);
        assert!(fm.bank.to_degrees().abs() < 2.0, "bank {}", fm.bank.to_degrees());
        assert!((fm.ias / KT - 250.0).abs() < 40.0, "ias {}", fm.ias / KT);
    }

    #[test]
    fn engines_spool_and_fuel_burns() {
        let mut fm = FlightModel::new(Some(5000.0));
        fm.place_airborne(0.0, 3000.0, 0.0, 0.0, 250.0, 0, false);
        let g = |_x: f64, _z: f64| 0.0;
        fm.ctl.throttle = 1.0;
        let f0 = fm.fuel;
        for _ in 0..(120 * 20) {
            fm.step(1.0 / 120.0, &g);
        }
        assert!(fm.n[0] > 0.9);
        assert!(fm.fuel < f0);
        let burn = (f0 - fm.fuel) / 20.0;
        assert!(burn > 0.8 && burn < 4.0, "fuel burn {burn} kg/s");
    }

    #[test]
    fn hard_impact_crashes() {
        let mut fm = FlightModel::new(Some(5000.0));
        fm.place_airborne(0.0, 60.0, 0.0, 0.0, 200.0, 0, false);
        fm.vel.y = -30.0;
        fm.ctl.gear_down = false;
        let g = |_x: f64, _z: f64| 0.0;
        for _ in 0..(120 * 6) {
            fm.step(1.0 / 120.0, &g);
        }
        assert!(fm.crashed, "gear-up 30 m/s sink must be fatal");
    }

    #[test]
    fn nan_guard() {
        let mut fm = FlightModel::new(None);
        fm.place_airborne(0.0, 1000.0, 0.0, 0.0, 200.0, 0, false);
        fm.vel = DVec3::new(f64::NAN, 0.0, 0.0);
        fm.step(1.0 / 120.0, &|_, _| 0.0);
        assert!(fm.pos.is_finite() && fm.vel.is_finite() && fm.quat.is_finite());
    }
}
