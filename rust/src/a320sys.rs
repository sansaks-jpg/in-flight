//! A320 aircraft-systems state behind the flight-deck switches (reference: `src/sim/a320/systems.ts`):
//! electrics, APU, bleed / packs, hydraulics, fuel pumps, fire protection, engine start logic (ENG MODE + ENG MASTER),
//! FCU managed / selected logic, two EFIS control panels, display brightness knobs and the exterior-light switches.
//!
//! The model is deliberately a *switch board*: every overhead / pedestal / glareshield control of the 3D deck (`deck.rs`) maps to a
//! field here, derived values (bus power, APU RPM, hydraulic pressure) follow with first-order dynamics in `update()`, and the
//! parts that act on the flight model (ENG MASTER -> starter, battery -> `ctl.battery`, autobrake, ground spoilers) are pushed
//! into `FlightModel` there.

use crate::ecam::{Ecam, EcamPage, EcpKey, Effects};
use crate::game::Flight;
use crate::gpws::Alert;
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
    /// the crew has turned / pulled / pushed this side's baro knob: the reference no longer follows the live QNH (ATIS)
    pub baro_touched: [bool; 2],
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
    /// Pre-selection made while the window is managed (dashes): remaining display time in seconds + the pre-selected value
    /// (FCOM DSC-22_10: 10 s for SPD, 45 s for HDG and V/S).
    pub spd_pre: f64,
    pub hdg_pre: f64,
    pub vs_pre: f64,
    pub spd_pre_val: f64,
    pub hdg_pre_val: f64,
    pub switching: [u8; 4], // ATT HDG, AIR DATA, EIS DMC, ND XFR (0 CAPT3, 1 NORM, 2 F/O3)
    pub master_warn: bool,
    pub master_caut: bool,
    pub chrono_run: bool,
    pub chrono_t: f64,
    pub chrono_show: bool,
    pub lamp_test: f64,
    /// ECAM control panel state machine (page keys, ALL / STS / CLR / RCL / EMER CANC / T.O CONFIG) - see `ecam.rs`
    pub ecam: Ecam,
    /// flight-phase SD page (used while no ECP key / failure selects one)
    pub page_auto: EcamPage,
    /// number of times the aural alert was cancelled (MASTER WARN / EMER CANC); an audio layer can poll this counter
    pub aural_acks: u32,
    prev_warns: Vec<&'static str>,
    warn_buf: Vec<&'static str>,
    cfg_buf: Vec<&'static str>,
    /// last human-readable notification (consumed by the UI toast)
    pub toast: Option<String>,
    /// captain's / first officer's MCDU (pedestal keyboard + CRT)
    pub mcdu: [crate::mcdu::Mcdu; 2],
    /// ECAM control panel (pedestal): page selection, ALL / STS / CLR / RCL / EMER CANC / T.O. CONFIG
    pub ecp: crate::ecp::Ecp,
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
            baro_touched: [false, false],
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
            spd_pre: 0.0,
            hdg_pre: 0.0,
            vs_pre: 0.0,
            spd_pre_val: 0.0,
            hdg_pre_val: 0.0,
            switching: [1, 1, 1, 1],
            master_warn: false,
            master_caut: false,
            chrono_run: false,
            chrono_t: 0.0,
            chrono_show: false,
            lamp_test: 0.0,
            ecam: Ecam::default(),
            page_auto: EcamPage::Door,
            aural_acks: 0,
            prev_warns: Vec::new(),
            warn_buf: Vec::new(),
            cfg_buf: Vec::new(),
            toast: None,
            mcdu: [crate::mcdu::Mcdu::new(), crate::mcdu::Mcdu::new()],
            ecp: crate::ecp::Ecp::default(),
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
        if self.efis[side].std {
            return;
        }
        self.baro_touched[side] = true;
        let e = &mut self.efis[side];
        if e.unit_in_hg {
            e.in_hg = (e.in_hg + dir).clamp(2200, 3248);
        } else {
            e.hpa = (e.hpa + dir).clamp(745, 1100);
        }
    }

    /// Pull = STD (1013 / 29.92), push = back to the selected QNH.
    pub fn efis_baro_set(&mut self, side: usize, std: bool) {
        self.efis[side].std = std;
        self.baro_touched[side] = true;
    }

    /// Outer ring: hPa / inHg. The setting is converted so the same pressure stays selected.
    pub fn efis_baro_unit(&mut self, side: usize, in_hg: bool) {
        let e = &mut self.efis[side];
        if e.unit_in_hg == in_hg {
            return;
        }
        self.baro_touched[side] = true;
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

    /// Display unit switched on? (`duOn` of the TS systems: a BRT knob turned fully anticlockwise switches the DU off.)
    pub fn pfd_on(&self, side: usize) -> bool {
        self.du_on(self.bright.pfd[side])
    }
    pub fn nd_on(&self, side: usize) -> bool {
        self.du_on(self.bright.nd[side])
    }

    /// While the crew has not touched a baro knob the reference follows the live QNH, as if it had been set from the ATIS.
    pub fn follow_qnh(&mut self, qnh: f64) {
        if !(qnh > 800.0 && qnh < 1100.0) {
            return;
        }
        for i in 0..2 {
            if !self.baro_touched[i] {
                self.efis[i].hpa = qnh.round() as i32;
                self.efis[i].in_hg = (qnh / HPA_PER_INHG * 100.0).round() as i32;
                self.efis[i].std = false;
            }
        }
        self.isis_hpa = qnh.round() as i32;
    }

    /// What the baro-set altimeter reads for a true altitude (about 27 ft per hPa), `indicatedAlt` of the TS systems.
    pub fn indicated_alt(&self, side: usize, true_ft: f64, qnh: f64) -> f64 {
        true_ft + (self.baro_setting_hpa(side) - qnh) * 27.0
    }

    /// Baro reference text of the EFIS window / PFD (`baroText`): STD, 29.92 (inHg) or 1013 (hPa).
    pub fn baro_text(&self, side: usize) -> String {
        let e = &self.efis[side];
        if e.std {
            "STD".into()
        } else if e.unit_in_hg {
            format!("{:.2}", e.in_hg as f64 / 100.0)
        } else {
            format!("{}", e.hpa)
        }
    }

    /// Selected ND range in NM.
    pub fn nd_range_nm(&self, side: usize) -> u32 {
        ND_RANGES[self.efis[side].nd_range.min(5)]
    }

    /// MASTER WARN: lit while a red warning is active (stall / GPWS) and not acknowledged.
    pub fn warn_lit(&self) -> bool {
        self.master_warn || self.ecam.warn_pending()
    }

    // ---------------- ECAM control panel ----------------
    fn apply_effects(&mut self, fx: Effects) {
        if fx.clear_master_warn {
            self.master_warn = false;
        }
        if fx.clear_master_caut {
            self.master_caut = false;
        }
        if fx.ack_aural {
            self.aural_acks += 1;
        }
        if let Some(t) = fx.toast {
            self.say(t);
        }
    }

    /// An ECP key went down (page keys act immediately, ALL / RCL keep running while held - release with [`A320Systems::ecp_up`]).
    pub fn ecp_down(&mut self, key: EcpKey) {
        let fx = self.ecam.down(key);
        self.apply_effects(fx);
    }

    pub fn ecp_up(&mut self, key: EcpKey) {
        self.ecam.up(key);
    }

    /// MASTER WARN pushed: light out, aural alert of the displayed red warnings cancelled (messages stay).
    pub fn acknowledge_master_warning(&mut self) {
        let fx = self.ecam.acknowledge_master();
        self.apply_effects(fx);
    }

    /// Page the lower ECAM really shows (ECP selection > failure page > flight-phase page).
    pub fn sd_page(&self) -> EcamPage {
        self.ecam.shown_page()
    }

    /// Lamp of an ECP key / its white bar (needs DC power; every lamp lights during a lamp test).
    pub fn ecp_lit(&self, key: EcpKey) -> bool {
        self.dc && (self.lamp_test > 0.0 || self.ecam.lit(key))
    }

    /// Display unit ON / OFF-BRT knob: fully anticlockwise (<= 0.04) switches the unit off.
    pub fn uecam_on(&self) -> bool {
        self.du_on(self.bright.uecam)
    }

    pub fn lecam_on(&self) -> bool {
        self.du_on(self.bright.lecam)
    }

    /// Alert texts the warning computer raises right now (E/WD message area).
    pub fn collect_warnings(f: &Flight, out: &mut Vec<&'static str>) {
        let fm = &f.fm;
        out.clear();
        let g = f.gpws_out.alert;
        if g != Alert::None {
            out.push(g.text());
        }
        if (fm.stall_warn || fm.stalled) && !out.contains(&"STALL") {
            out.push("STALL");
        }
        let lim = fm.limits();
        if lim.flap_over {
            out.push("FLAP OVERSPEED");
        }
        if lim.gear_over {
            out.push("L/G SPEED LIMIT");
        }
        if fm.fuel < 1500.0 {
            out.push("FUEL LOW");
        }
        if fm.eng.iter().any(|e| e.state == EngState::Off) && fm.airborne_time > 5.0 {
            out.push("ENG FAIL");
        }
        if fm.wow && fm.gs < 40.0 && fm.ctl.flaps_idx == 0 && fm.ctl.throttle > 0.6 {
            out.push("CONFIG FLAPS");
        }
    }

    /// CONFIG problems the T.O CONFIG test would report (FCOM DSC-31-15): flaps outside CONF 1+F..3, speedbrakes not retracted.
    pub fn to_config_issues(fm: &FlightModel, out: &mut Vec<&'static str>) {
        out.clear();
        if fm.ctl.flaps_idx < 1 || fm.ctl.flaps_idx > 3 {
            out.push("FLAPS NOT IN T.O CONFIG");
        }
        if fm.ctl.speedbrake > 0.03 {
            out.push("SPD BRK NOT RETRACTED");
        }
    }

    /// Flight-phase SD page (`autoPage` in `systems.ts`).
    pub fn auto_page(&self, fm: &FlightModel) -> EcamPage {
        let off = [fm.eng[0].state == EngState::Off, fm.eng[1].state == EngState::Off];
        if self.apu_rpm > 5.0 && off[0] && off[1] {
            return EcamPage::Apu;
        }
        if fm.eng.iter().any(|e| e.state == EngState::Starting) {
            return EcamPage::Eng;
        }
        if fm.wow && fm.gs < 1.0 && !fm.any_engine_running() {
            return EcamPage::Door;
        }
        if fm.wow && fm.gs < 40.0 && fm.ctl.throttle < 0.6 {
            return EcamPage::Wheel;
        }
        if !fm.wow && fm.agl < 1500.0 * crate::geo::FT {
            return EcamPage::Wheel;
        }
        EcamPage::Crz
    }

    /// Per-frame ECAM update: samples the warning computer, runs the ECP state machine, re-arms the master lights on a new alert.
    pub fn update_ecam(&mut self, dt: f64, f: &Flight) {
        let mut warns = std::mem::take(&mut self.warn_buf);
        let mut cfg = std::mem::take(&mut self.cfg_buf);
        Self::collect_warnings(f, &mut warns);
        Self::to_config_issues(&f.fm, &mut cfg);
        if warns != self.prev_warns {
            if !warns.is_empty() {
                self.master_caut = true;
            }
            if warns.iter().any(|w| !self.prev_warns.contains(w) && crate::ecam::is_red(w)) {
                self.master_warn = true;
            }
            self.prev_warns.clear();
            self.prev_warns.extend_from_slice(&warns);
        }
        self.page_auto = self.auto_page(&f.fm);
        let any_engine = f.fm.any_engine_running() || f.fm.eng.iter().any(|e| e.state == EngState::Starting);
        self.ecam.update(dt, &warns, &cfg, f.fm.wow, any_engine, self.page_auto);
        self.warn_buf = warns;
        self.cfg_buf = cfg;
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

    #[test]
    fn baro_follows_qnh_until_touched() {
        let mut s = A320Systems::default();
        s.follow_qnh(1021.4);
        assert_eq!(s.efis[0].hpa, 1021);
        assert_eq!(s.efis[1].hpa, 1021);
        assert_eq!(s.isis_hpa, 1021);
        s.efis_baro_turn(0, 2); // CAPT touches the knob -> his setting is now his own
        s.follow_qnh(1005.0);
        assert_eq!(s.efis[0].hpa, 1023, "touched side keeps its setting");
        assert_eq!(s.efis[1].hpa, 1005, "untouched side keeps following");
        s.follow_qnh(500.0); // nonsense QNH is ignored
        assert_eq!(s.efis[1].hpa, 1005);
    }

    #[test]
    fn indicated_altitude_and_baro_text() {
        let mut s = A320Systems::default();
        s.efis[0].hpa = 1013;
        assert!((s.indicated_alt(0, 5000.0, 1013.0) - 5000.0).abs() < 1e-9);
        // QNH 1003 but 1013 set: altimeter over-reads by 27 ft / hPa
        assert!((s.indicated_alt(0, 5000.0, 1003.0) - 5270.0).abs() < 1e-6);
        assert_eq!(s.baro_text(0), "1013");
        s.efis_baro_unit(0, true);
        assert_eq!(s.baro_text(0), "29.91", "1013 hPa converts to 29.91 inHg (29.92 = 1013.25)");
        s.efis_baro_set(0, true);
        assert_eq!(s.baro_text(0), "STD");
        assert!((s.indicated_alt(0, 5000.0, 1013.25) - 5000.0).abs() < 1e-6, "STD = 1013.25");
    }

    #[test]
    fn display_units_switch_off_at_the_stop() {
        let mut s = A320Systems::default();
        assert!(s.pfd_on(0) && s.nd_on(1));
        s.bright.pfd[0] = 0.0;
        s.bright.nd[1] = 0.03;
        assert!(!s.pfd_on(0) && s.pfd_on(1) && !s.nd_on(1));
        assert_eq!(s.nd_range_nm(0), 80);
    }

    #[test]
    fn ecp_keys_apply_their_effects_to_the_master_lights() {
        use crate::airports::AirportDb;
        let mut f = crate::game::Flight::new(&AirportDb::embedded(), "KSFO", "KOAK", 1_718_884_800.0).unwrap();
        let mut s = A320Systems::default();
        s.update_ecam(0.1, &f);
        assert!(!s.master_caut && !s.warn_lit());
        // a caution: MASTER CAUT lights, CLR (only cautions left) cancels it
        f.fm.fuel = 500.0;
        s.update_ecam(0.1, &f);
        assert!(s.master_caut);
        s.ecp_down(EcpKey::ClrL);
        s.ecp_up(EcpKey::ClrL);
        assert!(!s.master_caut);
        // a warning: MASTER WARN lights until acknowledged, the message stays
        f.fm.stalled = true;
        s.update_ecam(0.1, &f);
        assert!(s.warn_lit() && s.master_warn);
        s.acknowledge_master_warning();
        s.update_ecam(0.1, &f);
        assert!(!s.warn_lit(), "aural + light cancelled");
        assert_eq!(s.aural_acks, 1);
        assert!(s.ecam.alerts().any(|a| a.text == "STALL"), "the message itself stays");
        // lamps need DC power; lamp test lights everything
        let key = EcpKey::Page(s.sd_page());
        assert!(s.ecp_lit(key));
        s.dc = false;
        assert!(!s.ecp_lit(key));
        s.dc = true;
        s.lamp_test = 1.0;
        assert!(s.ecp_lit(EcpKey::EmerCanc));
    }

    #[test]
    fn automatic_sd_page_follows_the_flight_phase() {
        use crate::airports::AirportDb;
        let mut f = crate::game::Flight::new(&AirportDb::embedded(), "KSFO", "KOAK", 1_718_884_800.0).unwrap();
        let mut s = A320Systems::default();
        f.fm.eng[0].state = EngState::Off;
        f.fm.eng[1].state = EngState::Off;
        f.fm.wow = true;
        f.fm.gs = 0.0;
        assert_eq!(s.auto_page(&f.fm), EcamPage::Door);
        s.apu_rpm = 50.0;
        assert_eq!(s.auto_page(&f.fm), EcamPage::Apu);
        f.fm.eng[0].state = EngState::Starting;
        assert_eq!(s.auto_page(&f.fm), EcamPage::Eng);
        f.fm.eng[0].state = EngState::Running;
        f.fm.eng[1].state = EngState::Running;
        f.fm.gs = 10.0;
        f.fm.ctl.throttle = 0.1;
        assert_eq!(s.auto_page(&f.fm), EcamPage::Wheel);
        f.fm.wow = false;
        f.fm.agl = 5000.0;
        assert_eq!(s.auto_page(&f.fm), EcamPage::Crz);
        f.fm.agl = 100.0;
        assert_eq!(s.auto_page(&f.fm), EcamPage::Wheel);
    }
}
