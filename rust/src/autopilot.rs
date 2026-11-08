//! Full autopilot (port of `src/sim/autopilot.ts`): auto-takeoff, LNAV (leg-based fly-by tracking), VNAV (climb /
//! cruise / 3° descent path), auto-ILS, auto-flare and auto-rollout.
//!
//! * Lateral: turn-rate law (standard rate 3°/s) -> bank angle φ = atan(ω·V/g), limited to 25° (15° below 500 ft AGL).
//! * LNAV engages only once established in the climb; before that the runway track is held.
//! * Jet speed schedule: <= 250 KIAS below 10 000 ft MSL (FAR 91.117).
//! * A minimum safe altitude is enforced outside the approach so a bad target can never drive the aircraft into terrain.

use crate::geo::*;
use crate::nav::*;
use crate::physics::{atmosphere, FlightModel};

const TAN_3: f64 = 0.052_407_779_283_041_2; // tan(3°)
const TAN_6: f64 = 0.105_104_235_265_676_5; // tan(6°)
const SPEED_LIMIT_ALT_M: f64 = 10000.0 * FT;
const SPEED_LIMIT_KT: f64 = 250.0;
const MIN_SAFE_AGL_M: f64 = 150.0;
const LNAV_ENGAGE_AGL_M: f64 = 120.0;

#[derive(Clone, Copy, Debug, Default)]
pub struct IlsData {
    pub valid: bool,
    /// distance along the final-approach course to the threshold (m, > 0 before the threshold)
    pub dist: f64,
    /// lateral offset (m, + = right of the centreline)
    pub cross: f64,
    pub loc_dots: f64,
    /// + = aircraft is BELOW the glidepath (fly up)
    pub gs_dots: f64,
    pub course: f64,
    pub elev: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct ApCmd {
    pub pitch: f64,
    pub roll: f64,
    pub throttle: f64,
    pub yaw: f64,
    pub gear_down: bool,
    pub flaps_idx: usize,
    pub brake: f64,
    pub parking: bool,
    pub reverse: bool,
    pub speedbrake: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApPhase {
    Idle,
    Takeoff,
    Climb,
    Cruise,
    Descent,
    Approach,
    Flare,
    Rollout,
    Stopped,
}

impl ApPhase {
    pub fn label(self) -> &'static str {
        match self {
            ApPhase::Idle => "OFF",
            ApPhase::Takeoff => "TAKEOFF",
            ApPhase::Climb => "CLIMB",
            ApPhase::Cruise => "CRUISE",
            ApPhase::Descent => "DESCENT",
            ApPhase::Approach => "APPROACH",
            ApPhase::Flare => "FLARE",
            ApPhase::Rollout => "ROLLOUT",
            ApPhase::Stopped => "STOPPED",
        }
    }
}

pub fn stall_ref_kt(fm: &FlightModel) -> f64 {
    if fm.flaps_pos > 0.3 {
        fm.spec.vs0
    } else {
        fm.spec.vs1
    }
}
/// Lowest speed the autopilot will ever select: VLS ≈ 1.23 Vs of the current configuration.
pub fn min_speed_kt(fm: &FlightModel) -> f64 {
    stall_ref_kt(fm) * 1.23
}

fn managed_jet_kias(mach_cruise: f64, alt: f64, air: &crate::physics::AirState) -> f64 {
    let a = atmosphere(alt, air);
    (300.0_f64).min((mach_cruise * a.a * a.sigma.sqrt()) / KT)
}

#[derive(Clone, Copy)]
struct ApproachStage {
    kt: f64,
    flaps: usize,
    gear: bool,
}

/// Configuration / speed schedule on final by track distance D to the threshold (CONF 1 at the IAF, CONF 2, gear + CONF 3
/// about 5 NM out, CONF FULL stabilised at ~3 NM, Vapp + 3 over the threshold).
fn approach_stage(vapp: f64, detents: usize, d: f64) -> ApproachStage {
    let k = vapp / 135.0;
    let knots: [(f64, f64); 6] = [(1500.0, 3.0), (5000.0, 12.0), (9000.0, 30.0), (13000.0, 45.0), (18500.0, 60.0), (30000.0, 115.0)];
    let mut add = knots[5].1;
    if d <= knots[0].0 {
        add = knots[0].1;
    } else {
        for i in 1..knots.len() {
            if d <= knots[i].0 {
                let f = (d - knots[i - 1].0) / (knots[i].0 - knots[i - 1].0);
                add = knots[i - 1].1 + f * (knots[i].1 - knots[i - 1].1);
                break;
            }
        }
    }
    let full = detents;
    let step = if d < 6500.0 {
        full
    } else if d < 10500.0 {
        1.max(full - 1)
    } else if d < 14500.0 {
        2.min(full)
    } else if d < 20000.0 {
        1
    } else {
        0
    };
    ApproachStage { kt: vapp + add * k, flaps: step.min(full), gear: d < 10500.0 }
}

#[derive(Clone, Debug)]
pub struct Autopilot {
    pub on: bool,
    pub phase: ApPhase,
    pub nav: bool,
    pub appr: bool,
    pub gs_captured: bool,
    pub hdg: f64,
    pub alt_ft: f64,
    pub spd: f64,
    pub vs_limit: f64,
    pub alt_selected: bool,
    pub spd_selected: bool,
    pub vs_hold_fpm: Option<f64>,
    pub expedite: bool,
    pub takeoff_hdg: f64,
    pub pitch_target_rad: Option<f64>,
    sb_cmd: f64,
    prev_kias: f64,
    acc_kt: f64,
}

impl Default for Autopilot {
    fn default() -> Self {
        Self {
            on: false,
            phase: ApPhase::Idle,
            nav: true,
            appr: false,
            gs_captured: false,
            hdg: 0.0,
            alt_ft: 3000.0,
            spd: 120.0,
            vs_limit: 8.0,
            alt_selected: false,
            spd_selected: false,
            vs_hold_fpm: None,
            expedite: false,
            takeoff_hdg: 0.0,
            pitch_target_rad: None,
            sb_cmd: 0.0,
            prev_kias: 0.0,
            acc_kt: 0.0,
        }
    }
}

impl Autopilot {
    pub fn arm_takeoff(&mut self, fm: &FlightModel, rwy_hdg: f64, target_alt_m: Option<f64>) {
        self.on = true;
        self.pitch_target_rad = None;
        self.gs_captured = false;
        self.phase = ApPhase::Takeoff;
        self.nav = true;
        self.appr = false;
        self.takeoff_hdg = rwy_hdg.round();
        self.hdg = self.takeoff_hdg;
        self.alt_ft = match target_alt_m {
            Some(m) => (m / FT).round(),
            None => 3000.0_f64.max(((fm.pos.y / FT + 3000.0) / 500.0).round() * 500.0),
        };
        self.spd = (fm.spec.vr * 1.35).round();
    }

    pub fn engage(&mut self, fm: &FlightModel, initial_hdg: Option<f64>) {
        if fm.wow {
            self.arm_takeoff(fm, initial_hdg.unwrap_or(fm.heading), None);
            return;
        }
        self.on = true;
        self.pitch_target_rad = None;
        self.gs_captured = false;
        self.takeoff_hdg = initial_hdg.unwrap_or(fm.heading.round());
        self.hdg = self.takeoff_hdg;
        self.phase = ApPhase::Cruise;
        self.nav = true;
        self.appr = false;
        self.prev_kias = fm.ias / KT;
        self.acc_kt = 0.0;
        self.alt_ft = (fm.pos.y / FT / 100.0).round() * 100.0;
        self.spd = (clamp(fm.ias / KT, min_speed_kt(fm), fm.spec.vne * 0.8) / 5.0).round() * 5.0;
    }

    pub fn set_lateral_mode_nav(&mut self, nav: bool) {
        self.nav = nav;
        self.appr = false;
        self.gs_captured = false;
        if matches!(self.phase, ApPhase::Approach | ApPhase::Flare) {
            self.phase = ApPhase::Cruise;
        }
    }

    pub fn disengage(&mut self) {
        self.on = false;
        self.sb_cmd = 0.0;
        self.pitch_target_rad = None;
        self.vs_hold_fpm = None;
        self.expedite = false;
        self.phase = ApPhase::Idle;
        self.appr = false;
        self.nav = false;
        self.gs_captured = false;
    }

    /// Main autopilot step. Returns control demands for pitch, roll, throttle, yaw and aircraft systems.
    #[allow(clippy::too_many_arguments)]
    pub fn step(&mut self, fm: &FlightModel, dt: f64, ils: Option<&IlsData>, plan: &[Waypoint], active_wp: usize, cur_lat: f64, cur_lon: f64) -> ApCmd {
        let s = fm.spec;
        let v = fm.vel.length().max(25.0);
        let kias = fm.ias / KT;
        let alt = fm.pos.y;
        let agl = fm.agl;
        let track = fm.track;
        let gs_ms = fm.gs.max(20.0);
        let have_pos = cur_lat.is_finite() && cur_lon.is_finite();
        let mut idx = if plan.is_empty() { 0 } else { active_wp.min(plan.len() - 1) };
        while !plan.is_empty() && !fm.wow && plan[idx].kind == WpType::Takeoff && idx < plan.len() - 1 {
            idx += 1;
        }
        let wp = plan.get(idx);

        let mut hdg_cmd = self.hdg;
        let mut alt_target = self.alt_ft * FT;
        let mut spd_t = self.spd;
        let mut vs_cmd: Option<f64> = None;
        let mut yaw_cmd = 0.0;
        let mut thr_cmd = fm.ctl.throttle;
        let mut gear_cmd = fm.ctl.gear_down;
        let mut flaps_cmd = fm.ctl.flaps_idx;
        let mut brake_cmd = 0.0;
        let mut reverse_cmd = false;
        let mut speedbrake_cmd = fm.ctl.speedbrake;
        let mut parking_cmd = false;
        let bank_lim_deg = 25.0;

        // ---- 1. AUTO-TAKEOFF ON RUNWAY ----
        if self.phase == ApPhase::Takeoff {
            parking_cmd = false;
            gear_cmd = true;
            flaps_cmd = 2.min(s.flap_detents);
            thr_cmd = (fm.ctl.throttle + dt * 0.4).min(1.0);
            let mut steer_err = wrap180(self.takeoff_hdg - fm.heading);
            if let Some(dep) = plan.first() {
                if fm.wow && have_pos && dep.kind == WpType::Takeoff {
                    if let Some(h) = dep.hdg {
                        let (a_lat, a_lon) = destination(dep.lat, dep.lon, h, 4000.0);
                        let (xt, _) = cross_track(cur_lat, cur_lon, dep.lat, dep.lon, a_lat, a_lon);
                        if xt.abs() < 40.0 {
                            steer_err += clamp(-xt * 0.5, -5.0, 5.0);
                        }
                    }
                }
            }
            yaw_cmd = clamp(steer_err * 0.08, -1.0, 1.0);
            if fm.wow {
                vs_cmd = Some(if kias >= s.vr { 6.5 } else { -0.5 });
            } else {
                vs_cmd = Some(self.vs_limit.min(8.0));
                if agl > 12.0 && fm.vel.y > 0.5 {
                    gear_cmd = false;
                }
                if agl > LNAV_ENGAGE_AGL_M && kias > s.vs1 * 1.3 {
                    flaps_cmd = 0;
                    self.phase = ApPhase::Climb;
                }
            }
        }

        // ---- 2. LNAV + VNAV ----
        let landing_leg = wp.is_some_and(|w| matches!(w.kind, WpType::Faf | WpType::Touchdown | WpType::Rollout));
        let td_idx = plan.iter().position(|w| w.kind == WpType::Touchdown);
        let arr_wp = td_idx.map(|i| &plan[i]);
        let mut dist_to_arr = f64::INFINITY;
        let mut path_on = false;
        let mut path_alt_m = 0.0;
        let mut stage: Option<ApproachStage> = None;
        if self.phase == ApPhase::Takeoff {
            hdg_cmd = self.takeoff_hdg;
            self.hdg = self.takeoff_hdg.round();
        } else if let (true, Some(wp), true) = (self.nav, wp, have_pos) {
            let g = leg_guidance(plan, idx, cur_lat, cur_lon);
            let icpt = if g.direct { 0.0 } else { intercept_angle_deg(g.xtk_m, gs_ms) };
            hdg_cmd = wrap360(g.course + if icpt.is_finite() { icpt } else { 0.0 });
            self.hdg = wrap360(g.course).round();

            if !matches!(self.phase, ApPhase::Flare | ApPhase::Rollout) {
                let cruise_alt = plan_cruise_alt_m(plan).unwrap_or_else(|| alt.max(wp.alt_m));
                let mut managed_alt = cruise_alt;
                let mut cleared_alt = cruise_alt;
                if let (Some(arr), Some(td)) = (arr_wp, td_idx) {
                    if idx <= td {
                        let d_path = plan_distance_m(plan, idx, cur_lat, cur_lon, td);
                        let path_alt = arr.alt_m + d_path * TAN_3;
                        path_alt_m = path_alt;
                        if path_alt < cruise_alt {
                            let iaf = plan.iter().find(|w| w.kind == WpType::Iaf);
                            cleared_alt = iaf.map_or(arr.alt_m, |w| w.alt_m);
                            managed_alt = path_alt;
                            path_on = alt >= path_alt - 40.0;
                        }
                        let ahead = arr.hdg.map_or(true, |h| wrap180(bearing(cur_lat, cur_lon, arr.lat, arr.lon) - h).abs() < 90.0);
                        let d_direct = haversine(cur_lat, cur_lon, arr.lat, arr.lon);
                        dist_to_arr = if ahead { d_direct } else { -d_direct };
                        if landing_leg || d_path < 30000.0 {
                            stage = Some(approach_stage(s.vapp, s.flap_detents, if ahead { d_path } else { 0.0 }.max(0.0)));
                        }
                    }
                }
                alt_target = managed_alt;
                let managed_spd = managed_jet_kias(s.cruise_kt * KT / atmosphere(s.cruise_alt, &fm.air).a, alt, &fm.air);
                spd_t = stage.map_or(managed_spd, |st| managed_spd.min(st.kt));
                if self.alt_selected {
                    alt_target = self.alt_ft * FT;
                } else {
                    self.alt_ft = (cleared_alt / FT).round();
                }
                if self.spd_selected {
                    spd_t = self.spd;
                } else {
                    self.spd = spd_t.round();
                }
                if path_on && !self.alt_selected && vs_cmd.is_none() && self.vs_hold_fpm.is_none() {
                    vs_cmd = Some(clamp(-fm.gs * TAN_3 + clamp(path_alt_m - alt, -150.0, 150.0) * 0.05, -fm.gs * TAN_6, 2.5));
                }
                if let Some(st) = stage {
                    if landing_leg || (dist_to_arr > 0.0 && dist_to_arr < 22000.0) {
                        let vfe = s.vfe[(s.vfe.len() - 1).min(st.flaps.min(s.flap_detents))];
                        if st.flaps > fm.ctl.flaps_idx && kias <= vfe - 3.0 {
                            flaps_cmd = st.flaps;
                        }
                        if st.gear && kias <= s.vle {
                            gear_cmd = true;
                        }
                    }
                }
                if landing_leg && agl < 20.0 && dist_to_arr < 3200.0 && dist_to_arr > -3000.0 {
                    self.phase = ApPhase::Flare;
                }
            }
        }

        // ---- 3. AUTO-ILS & APPROACH ----
        let use_ils = (self.appr || self.phase == ApPhase::Approach) && ils.is_some_and(|i| i.valid);
        if let (true, Some(ils)) = (use_ils, ils) {
            self.phase = ApPhase::Approach;
            self.hdg = wrap360(ils.course).round();
            let intercept = clamp(ils.cross * 0.045, -35.0, 35.0) * clamp(ils.dist / 6000.0, 0.35, 1.0);
            hdg_cmd = ils.course - intercept;
            let st = approach_stage(s.vapp, s.flap_detents, ils.dist.max(0.0));
            stage = Some(st);
            let vfe = s.vfe[(s.vfe.len() - 1).min(st.flaps.min(s.flap_detents))];
            if ils.dist < 22000.0 && st.flaps > fm.ctl.flaps_idx && kias <= vfe - 3.0 {
                flaps_cmd = st.flaps;
            }
            if ils.dist < 22000.0 && st.gear && kias <= s.vle {
                gear_cmd = true;
            }
            spd_t = spd_t.min(st.kt);
            self.spd = spd_t.round();
            if !self.gs_captured && ils.gs_dots.abs() < 1.4 && ils.dist < 42000.0 && ils.dist > 250.0 {
                self.gs_captured = true;
            }
            if self.gs_captured {
                let gain = clamp(ils.dist / 2200.0, 0.18, 1.0);
                vs_cmd = Some(-fm.gs * TAN_3 + clamp(ils.gs_dots, -2.5, 2.5) * 1.15 * gain);
            } else {
                alt_target = alt_target.min(alt + 5.0);
                if ils.dist < 40000.0 {
                    alt_target = alt;
                }
                let beam_alt = ils.elev + 15.0 + ils.dist.max(0.0) * TAN_3;
                if ils.dist > 2500.0 && ils.dist < 42000.0 && alt > beam_alt + 60.0 {
                    vs_cmd = Some(clamp(-2.0 - (alt - beam_alt) * 0.04, -fm.gs * (5.5 * D2R).tan(), -2.0));
                }
            }
            if agl < 20.0 && ils.dist < 3200.0 {
                self.phase = ApPhase::Flare;
            }
        }

        // ---- 4. AUTO-FLARE ----
        if self.phase == ApPhase::Flare {
            vs_cmd = Some(-(0.3 + agl.max(0.0) * 0.055));
            thr_cmd = (thr_cmd - dt * 0.45).max(0.0);
            if fm.wow {
                self.phase = ApPhase::Rollout;
            }
        }

        // ---- 5. AUTO-ROLLOUT & BRAKING ----
        if self.phase == ApPhase::Rollout {
            brake_cmd = 1.0;
            speedbrake_cmd = 1.0;
            gear_cmd = true;
            if fm.gs > 15.0 {
                reverse_cmd = true;
                thr_cmd = 0.8;
            } else {
                thr_cmd = 0.0;
            }
            let arr_hdg = plan.iter().find(|w| w.kind == WpType::Touchdown).and_then(|w| w.hdg);
            let rollout_hdg = ils.map_or(arr_hdg.unwrap_or(self.takeoff_hdg), |i| i.course);
            yaw_cmd = clamp(wrap180(rollout_hdg - fm.heading) * 0.08, -1.0, 1.0);
            vs_cmd = Some(-2.0);
            if fm.gs < 1.5 {
                self.phase = ApPhase::Stopped;
                parking_cmd = true;
                brake_cmd = 1.0;
                self.on = false;
            }
        }

        // ---- 6. SPEED SCHEDULE + MINIMUM SAFE ALTITUDE ----
        let approaching = use_ils
            || landing_leg
            || (path_on && dist_to_arr < 25000.0)
            || matches!(self.phase, ApPhase::Flare | ApPhase::Rollout);
        if !approaching && self.phase != ApPhase::Takeoff && !fm.wow && agl > 5.0 {
            let ground_msl = alt - agl;
            alt_target = alt_target.max(ground_msl + MIN_SAFE_AGL_M);
        }
        if !approaching && stage.is_none() {
            let lim = SPEED_LIMIT_KT + clamp((alt - SPEED_LIMIT_ALT_M) / (1500.0 * FT), 0.0, 1.0) * 50.0;
            spd_t = spd_t.min(lim);
        }
        spd_t = clamp(spd_t, min_speed_kt(fm), s.vne * 0.85);
        if self.nav && !self.spd_selected && !use_ils && self.phase != ApPhase::Takeoff {
            self.spd = spd_t.round();
        }

        // ---- 7. LATERAL CONTROL (turn rate -> bank) ----
        let low_level = agl < 150.0 && !matches!(self.phase, ApPhase::Flare | ApPhase::Rollout);
        let bank_lim = (if low_level { 15.0 } else { bank_lim_deg }) * D2R;
        let reference = if fm.gs > 20.0 { track } else { fm.heading };
        let err = wrap180(hdg_cmd - reference);
        let rate_cmd = clamp(err * D2R * 0.3, -3.0 * D2R, 3.0 * D2R);
        let bank_cmd = if self.phase == ApPhase::Takeoff && fm.wow { 0.0 } else { clamp((rate_cmd * v / G).atan(), -bank_lim, bank_lim) };
        let mut p_rate = clamp((bank_cmd - fm.bank) * 1.25, -s.max_roll_rate * 0.6, s.max_roll_rate * 0.6);
        if matches!(self.phase, ApPhase::Flare | ApPhase::Rollout) {
            p_rate = clamp((0.0 - fm.bank) * 1.5, -0.2, 0.2);
        }

        // ---- 8. VERTICAL CONTROL ----
        if vs_cmd.is_none() {
            if let Some(fpm) = self.vs_hold_fpm {
                let d_tgt = alt_target - alt;
                if fpm != 0.0 && d_tgt.signum() == fpm.signum() && d_tgt.abs() < 18.0_f64.max(fpm.abs() * 0.00508 * 7.0) {
                    self.vs_hold_fpm = None;
                } else {
                    vs_cmd = Some(fpm * 0.00508);
                }
            }
        }
        let mut vs_cmd = match vs_cmd {
            Some(v) => v,
            None => {
                let max_climb = (self.vs_limit * if self.expedite { 1.35 } else { 1.0 }).min(4.0 + s.max_pitch_rate * 30.0);
                let d_err = alt_target - alt;
                if d_err < -30.0 {
                    (-(2.5_f64.max(fm.gs * TAN_3))).max(d_err * 0.18).max(-max_climb * 1.3)
                } else {
                    clamp(d_err * 0.14, -max_climb * 0.9, max_climb)
                }
            }
        };
        // never pitch up into a stall
        if vs_cmd > 0.0 {
            let vs_ref = stall_ref_kt(fm);
            if kias < vs_ref * 1.12 {
                vs_cmd = vs_cmd.min(0.2).min(vs_cmd * 0.15);
            } else if kias < vs_ref * 1.2 {
                vs_cmd *= 0.5;
            }
        }
        if kias > s.vne * 0.95 && vs_cmd < 0.0 {
            vs_cmd = vs_cmd.max(0.0);
        }
        let gamma = clamp(fm.vel.y / v, -1.0, 1.0).asin();
        let g_cmd = clamp(vs_cmd / v, -0.25, 0.21).asin();
        self.pitch_target_rad = Some(fm.pitch + g_cmd - gamma);
        // the short flare window needs a much firmer flight-path loop than cruise (0.88)
        let fpa_gain = if self.phase == ApPhase::Flare { 2.6 } else { 0.88 };
        let pitch_in = clamp(((g_cmd - gamma) * fpa_gain) / s.max_pitch_rate, -0.9, 0.9);

        // ---- 9. AUTOTHROTTLE (+ speedbrakes when idle thrust cannot slow the aircraft on the path) ----
        let free_phase = !matches!(self.phase, ApPhase::Takeoff | ApPhase::Flare | ApPhase::Rollout | ApPhase::Stopped);
        if free_phase {
            let want = if fm.ctl.throttle < 0.06 && fm.ctl.flaps_idx < 3 && kias > spd_t + 8.0 { clamp((kias - spd_t - 8.0) / 30.0, 0.0, 0.6) } else { 0.0 };
            self.sb_cmd += clamp(want - self.sb_cmd, -dt * 0.25, dt * 0.25);
            speedbrake_cmd = self.sb_cmd;
            let acc = if dt > 1e-4 { (kias - self.prev_kias) / dt } else { 0.0 };
            self.acc_kt += (clamp(acc, -8.0, 8.0) - self.acc_kt) * clamp(dt / 1.2, 0.0, 1.0);
            thr_cmd = clamp(
                thr_cmd + (clamp((spd_t - kias) * 0.014, -0.1, 0.1) - self.acc_kt * 0.09) * dt + if vs_cmd > 2.0 { 0.01 * dt } else { 0.0 },
                0.0,
                1.0,
            );
        }
        self.prev_kias = kias;

        // mode annunciation follows what the aircraft is actually doing
        if matches!(self.phase, ApPhase::Climb | ApPhase::Cruise | ApPhase::Descent) {
            let e = alt_target - alt;
            self.phase = if path_on || e < -90.0 {
                ApPhase::Descent
            } else if e > 90.0 {
                ApPhase::Climb
            } else {
                ApPhase::Cruise
            };
        }

        let fin = |x: f64, d: f64| if x.is_finite() { x } else { d };
        ApCmd {
            pitch: fin(pitch_in, 0.0),
            roll: fin(clamp(p_rate / s.max_roll_rate, -1.0, 1.0), 0.0),
            throttle: fin(thr_cmd, 0.5),
            yaw: fin(yaw_cmd, 0.0),
            gear_down: gear_cmd,
            flaps_idx: flaps_cmd,
            brake: fin(brake_cmd, 0.0),
            parking: parking_cmd,
            reverse: reverse_cmd,
            speedbrake: fin(speedbrake_cmd, 0.0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approach_schedule_is_monotonic() {
        let mut prev_flaps = 0;
        let mut prev_kt = 0.0;
        // moving towards the runway (distance decreasing) flaps only increase, speed only decreases
        let mut d = 30000.0;
        while d >= 0.0 {
            let s = approach_stage(135.0, 4, d);
            assert!(s.flaps >= prev_flaps, "flaps retract at {d}");
            if prev_kt > 0.0 {
                assert!(s.kt <= prev_kt + 1e-9, "speed increases at {d}");
            }
            prev_flaps = s.flaps;
            prev_kt = s.kt;
            d -= 250.0;
        }
        assert_eq!(approach_stage(135.0, 4, 3000.0).flaps, 4);
        assert!(approach_stage(135.0, 4, 3000.0).gear);
        assert!((approach_stage(135.0, 4, 500.0).kt - 138.0).abs() < 0.5, "Vapp+3 at the threshold");
    }

    #[test]
    fn min_speed_follows_configuration() {
        let mut fm = FlightModel::new(None);
        fm.flaps_pos = 0.0;
        let clean = min_speed_kt(&fm);
        fm.flaps_pos = 1.0;
        assert!(min_speed_kt(&fm) < clean);
    }
}
