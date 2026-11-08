//! A320 aircraft-systems state behind the flight-deck switches (reference: `src/sim/a320/systems.ts`):
//! electrics, APU, bleed / packs, hydraulics, fuel pumps, fire protection, engine start logic (ENG MODE + ENG MASTER),
//! FCU managed / selected logic, two EFIS control panels, display brightness knobs and the exterior-light switches.
//!
//! The model is deliberately a *switch board*: every overhead / pedestal / glareshield control of the 3D deck (`deck.rs`) maps to a
//! field here, derived values (bus power, APU RPM, hydraulic pressure) follow with first-order dynamics in `update()`, and the
//! parts that act on the flight model (ENG MASTER -> starter, battery -> `ctl.battery`, autobrake, ground spoilers) are pushed
//! into `FlightModel` there.

use crate::physics::{EngState, FlightModel};
use std::collections::HashMap;

pub const HPA_PER_INHG: f64 = 33.8639;
pub const ND_MODE_NAMES: [&str; 5] = ["LS", "VOR", "NAV", "ARC", "PLAN"];
pub const ND_RANGES: [u32; 6] = [10, 20, 40, 80, 160, 320];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NdOpt {
    Cstr,
    Wpt,
    Vord,
    Ndb,
    Arpt,
}

/// One EFIS control panel (glareshield). `nav`: ADF(-1) / OFF(0) / VOR(1) for bearing pointers 1 and 2.
#[derive(Clone, Debug)]
pub struct Efis {
    pub fd: bool,
    pub ls: bool,
    pub std: bool,
    pub hpa: i32,
    /// hundredths of inHg (2992 = 29.92)
    pub in_hg: i32,
    pub unit_in_hg: bool,
    pub nd_mode: usize,
    pub nd_range: usize,
    pub opt: Option<NdOpt>,
    pub nav: [i8; 2],
    pub xfr: bool,
}

impl Default for Efis {
    fn default() -> Self {
        Self { fd: true, ls: false, std: false, hpa: 1013, in_hg: 2992, unit_in_hg: false, nd_mode: 3, nd_range: 3, opt: None, nav: [0, 0], xfr: false }
    }
}

#[derive(Clone, Debug)]
pub struct Bright {
    pub pfd: [f32; 2],
    pub nd: [f32; 2],
    pub nd_outer: [f32; 2],
    pub uecam: f32,
    pub lecam: f32,
    pub integ: f32,
    pub fcu: f32,
    pub flood: f32,
}

#[derive(Clone, Debug)]
pub struct Lights {
    pub nav: bool,
    pub strobe: bool,
    pub land: bool,
    pub beacon: bool,
    pub seatbelt: bool,
}

pub struct A320Systems {
    /// generic switch board: control id -> position (rotary selectors, 3-position switches, source switching ...)
    pub sw: HashMap<String, i32>,
    // electrics
    pub bat: [bool; 2],
    pub ext: bool,
    pub apu_gen: bool,
    pub gen: [bool; 2],
    pub dc: bool,
    pub ac: bool,
    pub bat_v: [f64; 2],
    // APU
    pub apu_master: bool,
    pub apu_start: bool,
    pub apu_rpm: f64,
    pub apu_bleed: bool,
    // air
    pub eng_bleed: [bool; 2],
    pub packs: [bool; 2],
    pub xbleed: u8,
    pub wing_ai: bool,
    pub eng_ai: [bool; 2],
    // hydraulics
    pub hyd_green_pump: bool,
    pub hyd_yellow_pump: bool,
    pub hyd_blue_pump: bool,
    pub hyd_yelec_pump: bool,
    pub ptu: bool,
    pub hyd: [f64; 3],
    pub rat_out: bool,
    // fuel
    pub pumps: [bool; 6],
    pub xfeed: bool,
    // fire protection
    pub fire_out: [bool; 3],
    pub agent_disch: [bool; 5],
    pub elt: bool,
    // engines: 0 CRANK, 1 NORM, 2 IGN/START
    pub eng_mode: u8,
    pub master: [bool; 2],
    // flight deck
    pub efis: [Efis; 2],
    pub isis_hpa: i32,
    pub isis_std: bool,
    pub terr_on_nd: [bool; 2],
    pub bright: Bright,
    pub lights: Lights,
    /// FCU
    pub athr_armed: bool,
    pub exped: bool,
    pub spd_mach: bool,
    pub trk_fpa: bool,
    pub metric: bool,
    pub alt_step_1000: bool,
    pub vs_mode: bool,
    pub vs_target: f64,
    pub fpa_target: f64,
    pub spd_managed: bool,
    pub hdg_managed: bool,
    pub alt_managed: bool,
    pub ap_eng: [bool; 2],
    pub loc_armed: bool,
    pub switching: [u8; 4], // ATT HDG, AIR DATA, EIS DMC, ND XFR (0 CAPT3, 1 NORM, 2 F/O3)
    pub master_warn: bool,
    pub master_caut: bool,
    pub chrono_run: bool,
    pub chrono_t: f64,
    pub chrono_show: bool,
    pub lamp_test: f64,
    /// last human-readable notification (consumed by the UI toast)
    pub toast: Option<String>,
}

impl Default for A320Systems {
    fn default() -> Self {
        Self {
            sw: HashMap::new(),
            bat: [true, true],
            ext: false,
            apu_gen: true,
            gen: [true, true],
            dc: true,
            ac: true,
            bat_v: [27.6, 27.6],
            apu_master: false,
            apu_start: false,
            apu_rpm: 0.0,
            apu_bleed: false,
            eng_bleed: [true, true],
            packs: [true, true],
            xbleed: 1,
            wing_ai: false,
            eng_ai: [false, false],
            hyd_green_pump: true,
            hyd_yellow_pump: true,
            hyd_blue_pump: true,
            hyd_yelec_pump: false,
            ptu: true,
            hyd: [0.0; 3],
            rat_out: false,
            pumps: [true; 6],
            xfeed: false,
            fire_out: [false; 3],
            agent_disch: [false; 5],
            elt: false,
            eng_mode: 1,
            master: [false, false],
            efis: [Efis::default(), Efis::default()],
            isis_hpa: 1013,
            isis_std: false,
            terr_on_nd: [false, false],
            bright: Bright { pfd: [0.8; 2], nd: [0.8; 2], nd_outer: [0.5; 2], uecam: 1.0, lecam: 1.0, integ: 1.0, fcu: 1.0, flood: 0.7 },
            lights: Lights { nav: true, strobe: false, land: false, beacon: true, seatbelt: false },
            athr_armed: false,
            exped: false,
            spd_mach: false,
            trk_fpa: false,
            metric: false,
            alt_step_1000: false,
            vs_mode: false,
            vs_target: 0.0,
            fpa_target: 0.0,
            spd_managed: true,
            hdg_managed: false,
            alt_managed: true,
            ap_eng: [false, false],
            loc_armed: false,
            switching: [1, 1, 1, 1],
            master_warn: false,
            master_caut: false,
            chrono_run: false,
            chrono_t: 0.0,
            chrono_show: false,
            lamp_test: 0.0,
            toast: None,
        }
    }
}

impl A320Systems {
    /// Cold-start free flight: engines already running, so the masters start ON.
    pub fn sync_from_flight(&mut self, fm: &FlightModel) {
        for i in 0..2 {
            self.master[i] = fm.eng[i].state != EngState::Off;
        }
        self.hyd = if fm.any_engine_running() { [3000.0; 3] } else { [0.0; 3] };
        for i in 0..2 {
            self.bat_v[i] = 27.6;
        }
    }

    pub fn say(&mut self, m: &str) {
        self.toast = Some(m.to_string());
    }

    pub fn get(&self, id: &str, default: i32) -> i32 {
        self.sw.get(id).copied().unwrap_or(default)
    }

    // ---------------- EFIS control panel logic (per side) ----------------
    /// Baro knob rotation: 1 hPa (or 0.01 inHg) per click. Ignored while STD is selected, like the real FCU.
    pub fn efis_baro_turn(&mut self, side: usize, dir: i32) {
        let e = &mut self.efis[side];
        if e.std {
            return;
        }
        if e.unit_in_hg {
            e.in_hg = (e.in_hg + dir).clamp(2200, 3248);
        } else {
            e.hpa = (e.hpa + dir).clamp(745, 1100);
        }
    }

    /// Pull = STD (1013 / 29.92), push = back to the selected QNH.
    pub fn efis_baro_set(&mut self, side: usize, std: bool) {
        self.efis[side].std = std;
    }

    /// Outer ring: hPa / inHg. The setting is converted so the same pressure stays selected.
    pub fn efis_baro_unit(&mut self, side: usize, in_hg: bool) {
        let e = &mut self.efis[side];
        if e.unit_in_hg == in_hg {
            return;
        }
        if in_hg {
            e.in_hg = (e.hpa as f64 / HPA_PER_INHG * 100.0).round() as i32;
        } else {
            e.hpa = (e.in_hg as f64 / 100.0 * HPA_PER_INHG).round() as i32;
        }
        e.unit_in_hg = in_hg;
    }

    /// CSTR / WPT / VOR.D / NDB / ARPT: only one can be lit at a time; pressing the lit one again clears it.
    pub fn efis_opt(&mut self, side: usize, k: NdOpt) {
        let e = &mut self.efis[side];
        e.opt = if e.opt == Some(k) { None } else { Some(k) };
    }

    /// Pressure setting shown on a PFD in hPa (STD = 1013.25).
    pub fn baro_setting_hpa(&self, side: usize) -> f64 {
        let e = &self.efis[side];
        if e.std {
            1013.25
        } else if e.unit_in_hg {
            e.in_hg as f64 / 100.0 * HPA_PER_INHG
        } else {
            e.hpa as f64
        }
    }

    pub fn du_on(&self, v: f32) -> bool {
        v > 0.04
    }

    /// MASTER WARN: lit while a red warning is active (stall / GPWS) and not acknowledged.
    pub fn warn_lit(&self) -> bool {
        self.master_warn
    }

    // ---------------- engine / APU actions ----------------
    pub fn set_master(&mut self, i: usize, on: bool, fm: &mut FlightModel) {
        self.master[i] = on;
        if on {
            if self.eng_mode == 2 {
                let r = fm.start_engine(i);
                if !r.is_empty() {
                    self.say(r);
                }
            } else if fm.eng[i].state == EngState::Off {
                self.say("Set ENG MODE to IGN/START to start the engine");
            }
        } else if fm.eng[i].state != EngState::Off {
            fm.stop_engine(i);
            self.say(if i == 0 { "ENG 1 MASTER OFF - engine shut down" } else { "ENG 2 MASTER OFF - engine shut down" });
        }
    }

    pub fn set_eng_mode(&mut self, m: u8, fm: &mut FlightModel) {
        self.eng_mode = m.min(2);
        if self.eng_mode == 2 {
            for i in 0..2 {
                if self.master[i] && fm.eng[i].state == EngState::Off {
                    let r = fm.start_engine(i);
                    if !r.is_empty() {
                        self.say(r);
                    }
                }
            }
        }
    }

    pub fn fire_toggle(&mut self, i: usize, fm: &mut FlightModel) {
        self.fire_out[i] = !self.fire_out[i];
        if self.fire_out[i] && i < 2 {
            self.master[i] = false;
            fm.stop_engine(i);
            self.say("ENG FIRE pb released - fuel and hydraulics shut off");
        }
    }

    pub fn discharge(&mut self, agent: usize) {
        let fire = if agent == 4 { 2 } else { agent >> 1 };
        if self.fire_out[fire] {
            self.agent_disch[agent] = true;
            self.say("EXTINGUISHER AGENT DISCHARGED");
        } else {
            self.say("Release the FIRE pb first");
        }
    }

    pub fn apu_start_press(&mut self) {
        if self.apu_master && self.dc {
            self.apu_start = true;
        } else {
            self.say("Switch APU MASTER SW on first");
        }
    }

    // ---------------- per-frame update ----------------
    pub fn update(&mut self, dt: f64, fm: &mut FlightModel) {
        let dt = dt.clamp(0.0, 0.25);
        let run = [fm.eng[0].state == EngState::Running, fm.eng[1].state == EngState::Running];
        let apu_avail = self.apu_rpm >= 95.0;
        let gen_on = [run[0] && self.gen[0] && fm.n[0] > 0.4, run[1] && self.gen[1] && fm.n[1] > 0.4];
        self.ac = (self.ext && fm.wow && fm.gs < 1.0) || (apu_avail && self.apu_gen) || gen_on[0] || gen_on[1];
        self.dc = self.bat[0] || self.bat[1] || self.ac;
        fm.ctl.battery = self.dc;
        for i in 0..2 {
            let target = if self.bat[i] { if self.ac { 28.1 } else { 25.6 } } else { 0.0 };
            self.bat_v[i] += (target - self.bat_v[i]) * (dt * 2.0).min(1.0);
        }
        // APU: MASTER + START spool up in 28 s, MASTER off spools down
        if !self.apu_master {
            self.apu_start = false;
        }
        if self.apu_master && self.apu_start && self.dc {
            self.apu_rpm = (self.apu_rpm + dt * (100.0 / 28.0)).min(100.0);
        } else {
            self.apu_rpm = (self.apu_rpm - dt * if self.apu_master { 0.0 } else { 100.0 / 40.0 }).max(0.0);
        }
        // hydraulics: engine pumps / electric pumps -> pressure with first-order lag
        let eng_hyd = [run[0] && self.hyd_green_pump && !self.fire_out[0], run[1] && self.hyd_yellow_pump && !self.fire_out[1]];
        let tgt = [
            if eng_hyd[0] { 3000.0 } else if self.ptu && eng_hyd[1] { 2400.0 } else { 0.0 },
            if eng_hyd[1] || (self.hyd_yelec_pump && self.ac) { 3000.0 } else if self.ptu && eng_hyd[0] { 2400.0 } else { 0.0 },
            if (self.hyd_blue_pump && self.ac) || self.rat_out && fm.ias > 100.0 { 3000.0 } else { 0.0 },
        ];
        for i in 0..3 {
            self.hyd[i] += (tgt[i] - self.hyd[i]) * (dt * 0.8).min(1.0);
        }
        // ground spoilers / autobrake
        if self.chrono_run {
            self.chrono_t += dt;
        }
        self.lamp_test = (self.lamp_test - dt).max(0.0);
        // master warning follows stall / GPWS-type alerts raised by the flight model
        self.master_warn = fm.stall_warn || fm.stalled;
        // engines that were shut down while the master is on (e.g. FIRE pb) keep the lever consistent
        for i in 0..2 {
            if self.master[i] && fm.eng[i].state == EngState::Off && self.eng_mode != 2 && !run[i] && self.fire_out[i] {
                self.master[i] = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn efis_baro_and_units() {
        let mut s = A320Systems::default();
        s.efis_baro_turn(0, 5);
        assert_eq!(s.efis[0].hpa, 1018);
        s.efis_baro_set(0, true);
        s.efis_baro_turn(0, 5);
        assert_eq!(s.efis[0].hpa, 1018, "STD ignores the knob");
        assert!((s.baro_setting_hpa(0) - 1013.25).abs() < 1e-9);
        s.efis_baro_set(0, false);
        s.efis_baro_unit(0, true);
        assert_eq!(s.efis[0].in_hg, (1018.0 / HPA_PER_INHG * 100.0).round() as i32);
        s.efis_baro_unit(0, false);
        assert!((s.efis[0].hpa - 1018).abs() <= 1);
        s.efis_baro_turn(1, -1000);
        assert_eq!(s.efis[1].hpa, 745, "clamped to the low stop");
    }

    #[test]
    fn nd_option_buttons_are_exclusive() {
        let mut s = A320Systems::default();
        s.efis_opt(0, NdOpt::Wpt);
        assert_eq!(s.efis[0].opt, Some(NdOpt::Wpt));
        s.efis_opt(0, NdOpt::Ndb);
        assert_eq!(s.efis[0].opt, Some(NdOpt::Ndb));
        s.efis_opt(0, NdOpt::Ndb);
        assert_eq!(s.efis[0].opt, None);
        assert_eq!(s.efis[1].opt, None, "panels are independent");
    }

    #[test]
    fn apu_start_requires_master() {
        let mut s = A320Systems::default();
        s.apu_start_press();
        assert!(!s.apu_start);
        assert!(s.toast.is_some());
        s.apu_master = true;
        s.apu_start_press();
        assert!(s.apu_start);
    }

    #[test]
    fn fire_agent_needs_released_pb() {
        let mut s = A320Systems::default();
        s.discharge(0);
        assert!(!s.agent_disch[0]);
        s.fire_out[0] = true;
        s.discharge(1);
        assert!(s.agent_disch[1]);
        s.discharge(4);
        assert!(!s.agent_disch[4], "APU agent needs the APU FIRE pb");
    }
}
