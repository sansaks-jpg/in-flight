//! Flight Control Unit (glareshield) logic - the single source of truth for what every FCU control does.
//!
//! Reference (read-only golden specification): `src/sim/cockpit.ts` (`fcuTurn`, `activateKnob`, `toggle`, `syncFcu`,
//! `updateFcuInd`, `applyVsHold`), `src/sim/a320/displays.ts` (`drawFCU`) and `src/sim/game.ts` (`setApTarget`), plus the
//! Airbus A320 FCOM (DSC-22_10 "FCU"): every window knob is a rotary encoder with **PUSH = managed** and **PULL = selected**,
//! pre-selections made while a window is managed (dashes) are displayed for 10 s (SPD) / 45 s (HDG, V/S) and only become
//! active when the knob is pulled.
//!
//! The module is pure state logic (no GPU, no 3D model): `deck.rs` forwards the mouse mechanics here, `deckhost.rs` draws
//! [`FcuDisplay`] on the glareshield windows, and the unit tests at the bottom run on a real [`Flight`].
//!
//! Units: speed in kt IAS (the Mach window converts with the current IAS-per-Mach factor), heading in degrees, altitude in
//! feet, vertical speed in ft/min, flight path angle in degrees. The Rust port works in true heading everywhere (no magnetic
//! variation model), so the HDG window shows the autopilot heading unchanged.

use crate::a320sys::A320Systems;
use crate::autopilot::min_speed_kt;
use crate::game::{Action, Flight};
use crate::geo::{FT, KT};

/// IAS (kt) per Mach at sea level - used on the ground / below 30 kt where IAS / Mach is undefined.
pub const SEA_LEVEL_KT_PER_MACH: f64 = 661.5;
/// How long a pre-selection stays displayed while the window is managed (seconds).
pub const PRE_SPD_S: f64 = 10.0;
pub const PRE_HDG_S: f64 = 45.0;
pub const PRE_VS_S: f64 = 45.0;
/// FCU window ranges.
pub const ALT_MIN_FT: f64 = 100.0;
pub const ALT_MAX_FT: f64 = 49_000.0;
pub const SPD_WINDOW_MIN_KT: f64 = 100.0;
pub const SPD_WINDOW_MAX_KT: f64 = 399.0;
pub const VS_MAX_FPM: f64 = 6000.0;
pub const FPA_MAX_DEG: f64 = 9.9;
/// One full revolution of an encoder is 32 detents (the knob angle follows the clicks, never the displayed value).
pub const CLICK_RAD: f32 = std::f32::consts::PI / 16.0;

/// The four rotary push / pull encoders of the FCU.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Knob {
    Spd,
    Hdg,
    Alt,
    Vs,
}

impl Knob {
    pub const ALL: [Knob; 4] = [Knob::Spd, Knob::Hdg, Knob::Alt, Knob::Vs];

    /// Node name of the knob in the cockpit model.
    pub fn id(self) -> &'static str {
        match self {
            Knob::Spd => "spd-sel",
            Knob::Hdg => "hdg_sel",
            Knob::Alt => "alt-sel",
            Knob::Vs => "vs-sel",
        }
    }

    pub fn from_id(id: &str) -> Option<Knob> {
        Knob::ALL.into_iter().find(|k| k.id() == id)
    }
}

/// The FCU push-buttons (the ALT 100 / 1000 ring is handled by [`set_alt_step`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Button {
    Ap1,
    Ap2,
    Athr,
    Appr,
    Loc,
    Exped,
    HdgVs,
    SpdMach,
    MetricAlt,
}

impl Button {
    pub const ALL: [Button; 9] = [Button::Ap1, Button::Ap2, Button::Athr, Button::Appr, Button::Loc, Button::Exped, Button::HdgVs, Button::SpdMach, Button::MetricAlt];

    pub fn id(self) -> &'static str {
        match self {
            Button::Ap1 => "ap1",
            Button::Ap2 => "ap2",
            Button::Athr => "a-thr",
            Button::Appr => "appr",
            Button::Loc => "loc",
            Button::Exped => "exped",
            Button::HdgVs => "hdg-vs",
            Button::SpdMach => "spd-mach",
            Button::MetricAlt => "metric_alt",
        }
    }

    pub fn from_id(id: &str) -> Option<Button> {
        if id == "trk-fpa" {
            return Some(Button::HdgVs);
        }
        Button::ALL.into_iter().find(|b| b.id() == id)
    }
}

// ------------------------------------------------------------------------------------------------ helpers
/// IAS (kt) per Mach at the current flight condition - converts the Mach window to the autopilot's knot target.
pub fn mach_factor(f: &Flight) -> f64 {
    let kias = f.fm.ias / KT;
    if f.fm.mach > 0.05 && kias > 30.0 {
        kias / f.fm.mach
    } else {
        SEA_LEVEL_KT_PER_MACH
    }
}

/// Speed target limits shared with `Game.setApTarget`: stall margin .. 85 % of VNE.
fn clamp_spd(f: &Flight, v: f64) -> f64 {
    let lo = min_speed_kt(&f.fm).ceil();
    let hi = (f.fm.spec.vne * 0.85).round().max(lo);
    v.max(SPD_WINDOW_MIN_KT).min(SPD_WINDOW_MAX_KT).max(lo).min(hi)
}

/// `setApTarget('spd')`: a managed autopilot owns the speed target unless the window is selected.
fn set_spd(f: &mut Flight, v: f64) {
    if !(f.ap.on && (f.ap.nav || f.ap.appr)) || f.ap.spd_selected {
        f.ap.spd = clamp_spd(f, v.round());
    }
}

/// `setApTarget('hdg')`: always switches the lateral mode to selected heading.
fn set_hdg(f: &mut Flight, v: f64) {
    f.ap.hdg = v.round().rem_euclid(360.0);
    f.ap.set_lateral_mode_nav(false);
}

/// `setApTarget('alt')`.
fn set_alt(f: &mut Flight, v: f64) {
    if !(f.ap.on && (f.ap.nav || f.ap.appr)) || f.ap.alt_selected {
        f.ap.alt_ft = ((v / 100.0).round() * 100.0).clamp(ALT_MIN_FT, ALT_MAX_FT);
    }
}

/// Current heading rounded to a whole degree - what pulling HDG engages when nothing was pre-selected.
fn current_hdg(f: &Flight) -> f64 {
    f.fm.heading.round().rem_euclid(360.0)
}

/// Vertical speed (ft/min) equivalent to the selected flight path angle at the current ground speed.
pub fn fpa_to_fpm(fpa_deg: f64, gs_ms: f64) -> f64 {
    let gs_kt = (gs_ms / KT).max(100.0);
    (fpa_deg.to_radians().tan() * gs_kt * 1.0127).round() * 100.0
}

/// Flight path angle (deg, 0.1 resolution) equivalent to a vertical speed at the current ground speed.
pub fn fpm_to_fpa(fpm: f64, gs_ms: f64) -> f64 {
    let gs_kt = (gs_ms / KT).max(100.0);
    ((fpm / (gs_kt * 101.27)).atan().to_degrees().clamp(-FPA_MAX_DEG, FPA_MAX_DEG) * 10.0).round() / 10.0
}

/// `applyVsHold`: push the selected V/S (or FPA) into the autopilot.
pub fn apply_vs(f: &mut Flight, s: &A320Systems) {
    let fpm = if s.trk_fpa { fpa_to_fpm(s.fpa_target, f.fm.gs) } else { s.vs_target };
    f.ap.vs_hold_fpm = Some(fpm);
}

// ------------------------------------------------------------------------------------------------ rotation
/// One detent of a window encoder (`dir` = +1 clockwise / -1 counter-clockwise, `shift` = coarse step).
pub fn turn(k: Knob, dir: i32, shift: bool, f: &mut Flight, s: &mut A320Systems) {
    let d = dir.signum() as f64;
    if d == 0.0 {
        return;
    }
    match k {
        Knob::Spd => {
            // first click on a managed window only opens the pre-selection (no value change)
            if s.spd_managed && s.spd_pre <= 0.0 {
                s.spd_pre_val = f.ap.spd;
                s.spd_pre = PRE_SPD_S;
                return;
            }
            let fac = mach_factor(f);
            let cur = if s.spd_managed { s.spd_pre_val } else { f.ap.spd };
            let next = if s.spd_mach {
                (((cur / fac * 100.0).round() + d).clamp(10.0, 99.0) / 100.0 * fac).round()
            } else {
                (cur + d * if shift { 10.0 } else { 1.0 }).clamp(SPD_WINDOW_MIN_KT, SPD_WINDOW_MAX_KT)
            };
            if s.spd_managed {
                s.spd_pre_val = clamp_spd(f, next);
                s.spd_pre = PRE_SPD_S;
            } else {
                set_spd(f, next);
            }
        }
        Knob::Hdg => {
            let cur = f.ap.hdg.round().rem_euclid(360.0);
            if s.hdg_managed && s.hdg_pre <= 0.0 {
                s.hdg_pre_val = cur;
                s.hdg_pre = PRE_HDG_S;
                return;
            }
            let base = if s.hdg_managed { s.hdg_pre_val } else { cur };
            let next = (base + d * if shift { 10.0 } else { 1.0 }).rem_euclid(360.0);
            if s.hdg_managed {
                s.hdg_pre_val = next;
                s.hdg_pre = PRE_HDG_S;
            } else {
                set_hdg(f, next);
            }
        }
        Knob::Alt => {
            let step = if shift || s.alt_step_1000 { 1000.0 } else { 100.0 };
            let t = (((f.ap.alt_ft + d * step) / 100.0).round() * 100.0).clamp(ALT_MIN_FT, ALT_MAX_FT);
            // dialling a new altitude while the vertical profile is managed hands the vertical mode to the FCU target
            if s.alt_managed && f.ap.on && f.ap.nav {
                s.alt_managed = false;
                s.say("ALT: FCU target set - open climb / descent (push ALT for managed)");
            }
            f.ap.alt_selected = !s.alt_managed;
            set_alt(f, t);
        }
        Knob::Vs => {
            if s.trk_fpa {
                s.fpa_target = ((s.fpa_target + d * 0.1).clamp(-FPA_MAX_DEG, FPA_MAX_DEG) * 10.0).round() / 10.0;
            } else {
                s.vs_target = (s.vs_target + d * if shift { 500.0 } else { 100.0 }).clamp(-VS_MAX_FPM, VS_MAX_FPM);
            }
            if s.vs_mode {
                apply_vs(f, s);
            } else {
                s.vs_pre = PRE_VS_S;
            }
        }
    }
}

// ------------------------------------------------------------------------------------------------ push / pull
/// PUSH (`pull = false`: managed / level off) or PULL (`pull = true`: selected / open / V/S) of a window encoder.
pub fn push_pull(k: Knob, pull: bool, f: &mut Flight, s: &mut A320Systems) {
    match k {
        Knob::Spd => {
            if !pull {
                s.spd_managed = true;
                s.spd_pre = 0.0;
                f.ap.spd_selected = false;
                s.say("SPEED: managed (FMGS)");
            } else {
                let pre = s.spd_managed && s.spd_pre > 0.0;
                s.spd_managed = false;
                f.ap.spd_selected = true;
                if pre {
                    set_spd(f, s.spd_pre_val);
                }
                s.spd_pre = 0.0;
                s.say("SPEED: selected");
            }
        }
        Knob::Hdg => {
            if !pull {
                s.hdg_managed = true;
                s.hdg_pre = 0.0;
                if f.ap.on && !f.ap.nav {
                    f.ap.set_lateral_mode_nav(true);
                }
                s.say(if f.ap.on { "NAV: managed lateral guidance" } else { "NAV armed (engage AP)" });
            } else {
                s.hdg_managed = false;
                if s.hdg_pre > 0.0 {
                    set_hdg(f, s.hdg_pre_val);
                } else if f.ap.on && f.ap.nav {
                    // HDG engages on the heading flown now, never on a stale window value
                    f.ap.hdg = current_hdg(f);
                    f.ap.set_lateral_mode_nav(false);
                }
                s.hdg_pre = 0.0;
                s.say("HDG: selected heading");
            }
        }
        Knob::Alt => {
            if !pull {
                s.alt_managed = true;
                f.ap.alt_selected = false;
                s.say("ALT: managed climb / descent (VNAV profile)");
            } else {
                s.alt_managed = false;
                f.ap.alt_selected = true;
                s.say("ALT: open climb / descent to FCU altitude");
            }
        }
        Knob::Vs => {
            if !f.ap.on {
                s.say("V/S: engage AP1 / AP2 first");
                return;
            }
            s.vs_mode = true;
            s.vs_pre = 0.0;
            s.exped = false;
            f.ap.expedite = false;
            if !pull {
                s.vs_target = 0.0;
                s.fpa_target = 0.0;
                f.ap.vs_hold_fpm = Some(0.0);
                s.say("V/S 0 - level off");
            } else {
                apply_vs(f, s);
                // V/S flies towards the FCU altitude, not towards the managed profile
                if s.alt_managed {
                    s.alt_managed = false;
                    f.ap.alt_selected = true;
                }
                s.say("V/S mode engaged");
            }
        }
    }
}

/// ALT increment ring: `true` = 1000 ft per click, `false` = 100 ft per click.
pub fn set_alt_step(s: &mut A320Systems, thousand: bool) {
    s.alt_step_1000 = thousand;
    s.say(if thousand { "ALT step: 1000 ft" } else { "ALT step: 100 ft" });
}

// ------------------------------------------------------------------------------------------------ push-buttons
/// AP1 / AP2: each channel engages and disengages on its own; the autopilot stays on while either is engaged.
fn ap_press(i: usize, f: &mut Flight, s: &mut A320Systems) {
    let other = s.ap_eng[1 - i];
    if s.ap_eng[i] {
        s.ap_eng[i] = false;
        if !other && f.ap.on {
            f.apply(Action::ApToggle);
        }
        return;
    }
    if f.ap.on {
        s.ap_eng[i] = true;
        return;
    }
    f.apply(Action::ApToggle);
    if f.ap.on {
        s.ap_eng[i] = true;
    }
}

/// Press of an FCU push-button.
pub fn button(b: Button, f: &mut Flight, s: &mut A320Systems) {
    match b {
        Button::Ap1 => ap_press(0, f, s),
        Button::Ap2 => ap_press(1, f, s),
        Button::Athr => {
            s.athr_armed = !s.athr_armed;
            s.say(if s.athr_armed { "A/THR armed" } else { "A/THR off" });
        }
        Button::Appr => f.apply(Action::ApToggleAppr),
        Button::Loc => {
            s.loc_armed = !s.loc_armed;
            if s.loc_armed && !f.ap.on {
                s.say("LOC armed - engage AP1 / AP2 to capture the localizer");
            } else if !s.loc_armed {
                s.say("LOC disarmed");
            }
        }
        Button::Exped => {
            if !f.ap.on {
                s.exped = false;
                s.say("EXPED: engage AP1 / AP2 first");
                return;
            }
            s.exped = !s.exped;
            f.ap.expedite = s.exped;
            if s.exped {
                // EXPED cancels V/S and flies the managed / selected altitude at best climb / descent
                s.vs_mode = false;
                f.ap.vs_hold_fpm = None;
                s.say("EXPED: maximum climb / descent rate");
            }
        }
        Button::HdgVs => {
            // HDG V/S <-> TRK FPA: the vertical window keeps the same flight path
            if s.trk_fpa {
                s.vs_target = (fpa_to_fpm(s.fpa_target, f.fm.gs)).clamp(-VS_MAX_FPM, VS_MAX_FPM);
            } else {
                s.fpa_target = fpm_to_fpa(s.vs_target, f.fm.gs);
            }
            s.trk_fpa = !s.trk_fpa;
            if s.vs_mode {
                apply_vs(f, s);
            }
            s.say(if s.trk_fpa { "TRK / FPA selected" } else { "HDG / V/S selected" });
        }
        Button::SpdMach => {
            s.spd_mach = !s.spd_mach;
            s.say(if s.spd_mach { "SPD / MACH: MACH window" } else { "SPD / MACH: SPD window" });
        }
        Button::MetricAlt => {
            s.metric = !s.metric;
            s.say(if s.metric { "METRIC ALT: metres shown on PFD / ECAM" } else { "METRIC ALT off" });
        }
    }
}

// ------------------------------------------------------------------------------------------------ per frame
/// Per-frame FCU bookkeeping: pre-selection time-outs, AP channel state, V/S capture, LOC capture and the mirror of the
/// autopilot's selected / managed state (so keyboard / planner changes show up on the glareshield too).
pub fn sync(dt: f64, f: &mut Flight, s: &mut A320Systems) {
    s.spd_pre = (s.spd_pre - dt).max(0.0);
    s.hdg_pre = (s.hdg_pre - dt).max(0.0);
    s.vs_pre = (s.vs_pre - dt).max(0.0);
    s.spd_managed = !f.ap.spd_selected;
    s.alt_managed = !f.ap.alt_selected;
    if !f.ap.on {
        s.ap_eng = [false, false];
        s.exped = false;
        f.ap.vs_hold_fpm = None;
    } else {
        if !s.ap_eng[0] && !s.ap_eng[1] {
            s.ap_eng[0] = true;
        }
        s.hdg_managed = f.ap.nav;
    }
    s.vs_mode = f.ap.on && f.ap.vs_hold_fpm.is_some();
    if s.vs_mode && !s.trk_fpa {
        if let Some(v) = f.ap.vs_hold_fpm {
            s.vs_target = v.clamp(-VS_MAX_FPM, VS_MAX_FPM);
        }
    }
    f.ap.expedite = s.exped;
    if s.loc_armed && f.ap.on && f.ils.valid && !f.ap.appr {
        s.loc_armed = false;
        f.apply(Action::ApToggleAppr);
    }
}

// ------------------------------------------------------------------------------------------------ display
/// Everything the glareshield needs to show: the four windows plus the lit legends / managed dots.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FcuDisplay {
    /// FCU powered (AC bus)
    pub on: bool,
    /// 0.2 ..= 1.0 (FCU INTEG LT knob)
    pub brightness: f32,
    pub spd: String,
    pub hdg: String,
    pub alt: String,
    pub vs: String,
    /// legends
    pub mach: bool,
    pub trk: bool,
    pub fpa: bool,
    pub lvl_ch: bool,
    /// managed dots (SPD, LAT, V/S - ALT)
    pub spd_dot: bool,
    pub lat_dot: bool,
    pub ver_dot: bool,
}

fn fmt_spd(v: f64, mach: bool, fac: f64) -> String {
    if mach {
        let t = format!("{:.2}", v / fac);
        t.strip_prefix('0').map(str::to_string).unwrap_or(t)
    } else {
        format!("{:03}", v.round() as i64)
    }
}

/// Legend / dot / power state only (no strings, so it is free to call per lamp per frame).
pub fn flags(f: &Flight, s: &A320Systems) -> FcuDisplay {
    FcuDisplay {
        on: s.ac,
        brightness: s.bright.fcu,
        mach: s.spd_mach,
        trk: s.trk_fpa,
        fpa: s.trk_fpa,
        lvl_ch: f.ap.on && !s.vs_mode && (f.ap.alt_ft - f.fm.pos.y / FT).abs() > 150.0,
        spd_dot: s.spd_managed,
        lat_dot: s.hdg_managed && f.ap.on,
        ver_dot: s.alt_managed && f.ap.on,
        ..Default::default()
    }
}

pub fn display(f: &Flight, s: &A320Systems) -> FcuDisplay {
    let fac = mach_factor(f);
    let spd = if s.spd_managed {
        if s.spd_pre > 0.0 {
            fmt_spd(s.spd_pre_val, s.spd_mach, fac)
        } else {
            "---".into()
        }
    } else {
        fmt_spd(f.ap.spd, s.spd_mach, fac)
    };
    let hdg = if s.hdg_managed {
        if s.hdg_pre > 0.0 {
            format!("{:03}", s.hdg_pre_val.round() as i64)
        } else {
            "---".into()
        }
    } else {
        format!("{:03}", (f.ap.hdg.round() as i64).rem_euclid(360))
    };
    let alt = format!("{:05}", f.ap.alt_ft.round() as i64);
    let shown = s.vs_mode || s.vs_pre > 0.0;
    let vs = if !shown {
        "-----".into()
    } else if s.trk_fpa {
        format!("{}{:.1}", if s.fpa_target >= 0.0 { '+' } else { '-' }, s.fpa_target.abs())
    } else {
        format!("{}{:04}", if s.vs_target >= 0.0 { '+' } else { '-' }, s.vs_target.abs().round() as i64)
    };
    FcuDisplay { spd, hdg, alt, vs, ..flags(f, s) }
}

/// Is the named FCU legend mesh (`spd.ind`, `fpa.ind.001`, `lat.fmgc` ...) lit for this display state?
/// `None` = not an FCU legend. Mirrors `updateFcuInd` in `cockpit.ts`; `alt.ind` and the `*.dash` meshes never light.
pub fn legend_lit(name: &str, d: &FcuDisplay) -> Option<bool> {
    let on = d.on;
    Some(match name {
        "spd.ind" => on && !d.mach,
        "mach.ind" => on && d.mach,
        "hdg.ind" | "hdg2.ind" => on && !d.trk,
        "trk.ind" | "trk2.ind" => on && d.trk,
        "vs.ind" | "vs.ind.001" => on && !d.fpa,
        "fpa.ind" | "fpa.ind.001" => on && d.fpa,
        "spd.fmgc" => on && d.spd_dot,
        "lat.fmgc" => on && d.lat_dot,
        "ver.fmgc" => on && d.ver_dot,
        "lvlch.ind" => on && d.lvl_ch,
        "alt.ind" | "spd.dash" | "lat.dash" | "vs.dash" => false,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::airports::AirportDb;

    const T0: f64 = 1_718_884_800.0;

    fn setup() -> (Flight, A320Systems) {
        let f = Flight::new(&AirportDb::embedded(), "KSFO", "KOAK", T0).expect("flight");
        let mut s = A320Systems::default();
        s.sync_from_flight(&f.fm);
        (f, s)
    }

    /// Airborne-like autopilot state without running the physics: AP on in selected heading mode, all windows selected.
    fn selected(f: &mut Flight, s: &mut A320Systems) {
        f.ap.on = true;
        f.ap.nav = false;
        f.ap.spd = 250.0;
        f.ap.hdg = 90.0;
        f.ap.alt_ft = 10_000.0;
        f.ap.spd_selected = true;
        f.ap.alt_selected = true;
        sync(0.0, f, s);
    }

    #[test]
    fn ids_round_trip() {
        for k in Knob::ALL {
            assert_eq!(Knob::from_id(k.id()), Some(k));
        }
        for b in Button::ALL {
            assert_eq!(Button::from_id(b.id()), Some(b));
        }
        assert_eq!(Button::from_id("trk-fpa"), Some(Button::HdgVs));
        assert_eq!(Knob::from_id("nope"), None);
    }

    #[test]
    fn spd_selected_steps_one_knot_and_ten_with_shift() {
        let (mut f, mut s) = setup();
        selected(&mut f, &mut s);
        turn(Knob::Spd, 1, false, &mut f, &mut s);
        assert_eq!(f.ap.spd, 251.0);
        turn(Knob::Spd, 1, true, &mut f, &mut s);
        assert_eq!(f.ap.spd, 261.0);
        turn(Knob::Spd, -1, true, &mut f, &mut s);
        turn(Knob::Spd, -1, false, &mut f, &mut s);
        assert_eq!(f.ap.spd, 250.0);
        // window limits
        f.ap.spd = 399.0;
        f.ap.spd = clamp_spd(&f, 399.0);
        let top = f.ap.spd;
        turn(Knob::Spd, 1, true, &mut f, &mut s);
        assert!(f.ap.spd <= top.max(f.fm.spec.vne * 0.85 + 1.0));
    }

    #[test]
    fn spd_managed_first_click_only_opens_the_preselection() {
        let (mut f, mut s) = setup();
        selected(&mut f, &mut s);
        push_pull(Knob::Spd, false, &mut f, &mut s); // push = managed
        assert!(s.spd_managed && !f.ap.spd_selected);
        let before = f.ap.spd;
        turn(Knob::Spd, 1, false, &mut f, &mut s);
        assert_eq!(f.ap.spd, before, "managed target untouched");
        assert!(s.spd_pre > 9.9 && s.spd_pre_val == before);
        turn(Knob::Spd, 1, false, &mut f, &mut s);
        assert_eq!(s.spd_pre_val, before + 1.0);
        assert_eq!(display(&f, &s).spd, format!("{:03}", (before + 1.0) as i64), "pre-selection is shown");
        // the pre-selection times out after 10 s and the window shows dashes again
        sync(10.5, &mut f, &mut s);
        assert_eq!(display(&f, &s).spd, "---");
        // pulling after a fresh pre-selection applies it
        turn(Knob::Spd, 1, false, &mut f, &mut s);
        turn(Knob::Spd, 1, true, &mut f, &mut s);
        let want = s.spd_pre_val;
        push_pull(Knob::Spd, true, &mut f, &mut s);
        assert!(!s.spd_managed && f.ap.spd_selected);
        assert_eq!(f.ap.spd, want);
        assert_eq!(s.spd_pre, 0.0);
    }

    #[test]
    fn mach_window_steps_hundredths_of_a_mach() {
        let (mut f, mut s) = setup();
        selected(&mut f, &mut s);
        f.fm.mach = 0.5;
        f.fm.ias = 250.0 * KT;
        let fac = mach_factor(&f);
        assert!((fac - 500.0).abs() < 1e-6, "{fac}");
        button(Button::SpdMach, &mut f, &mut s);
        assert!(s.spd_mach);
        f.ap.spd = 250.0;
        assert_eq!(display(&f, &s).spd, ".50");
        turn(Knob::Spd, 1, false, &mut f, &mut s);
        assert_eq!(f.ap.spd, 255.0, "0.51 M at 500 kt/M");
        assert_eq!(display(&f, &s).spd, ".51");
        button(Button::SpdMach, &mut f, &mut s);
        assert_eq!(display(&f, &s).spd, "255");
    }

    #[test]
    fn heading_wraps_through_north_and_preselects_while_managed() {
        let (mut f, mut s) = setup();
        selected(&mut f, &mut s);
        f.ap.hdg = 359.0;
        turn(Knob::Hdg, 1, false, &mut f, &mut s);
        assert_eq!(f.ap.hdg, 0.0);
        turn(Knob::Hdg, -1, false, &mut f, &mut s);
        assert_eq!(f.ap.hdg, 359.0);
        turn(Knob::Hdg, 1, true, &mut f, &mut s);
        assert_eq!(f.ap.hdg, 9.0);
        assert!(!f.ap.nav, "turning HDG leaves managed lateral mode");
        // managed: push -> dashes + pre-selection -> pull applies it
        push_pull(Knob::Hdg, false, &mut f, &mut s);
        sync(0.0, &mut f, &mut s);
        assert!(f.ap.nav && s.hdg_managed);
        assert_eq!(display(&f, &s).hdg, "---");
        let h0 = f.ap.hdg;
        turn(Knob::Hdg, 1, false, &mut f, &mut s);
        turn(Knob::Hdg, 1, true, &mut f, &mut s);
        assert_eq!(f.ap.hdg, h0, "autopilot heading is untouched by a pre-selection");
        // click 1 only opens the pre-selection window, the shifted click 2 adds 10
        let want = (h0.round() + 10.0).rem_euclid(360.0);
        assert_eq!(s.hdg_pre_val, want);
        assert_eq!(display(&f, &s).hdg, format!("{:03}", s.hdg_pre_val as i64));
        push_pull(Knob::Hdg, true, &mut f, &mut s);
        assert!(!f.ap.nav && f.ap.hdg == want.rem_euclid(360.0));
    }

    #[test]
    fn pulling_hdg_without_preselection_engages_the_current_heading() {
        let (mut f, mut s) = setup();
        selected(&mut f, &mut s);
        f.ap.nav = true;
        sync(0.0, &mut f, &mut s);
        f.fm.heading = 123.4;
        f.ap.hdg = 7.0;
        push_pull(Knob::Hdg, true, &mut f, &mut s);
        assert!(!f.ap.nav);
        assert_eq!(f.ap.hdg, 123.0);
    }

    #[test]
    fn altitude_steps_100_or_1000_by_ring_or_shift() {
        let (mut f, mut s) = setup();
        selected(&mut f, &mut s);
        turn(Knob::Alt, 1, false, &mut f, &mut s);
        assert_eq!(f.ap.alt_ft, 10_100.0);
        turn(Knob::Alt, 1, true, &mut f, &mut s);
        assert_eq!(f.ap.alt_ft, 11_100.0);
        set_alt_step(&mut s, true);
        turn(Knob::Alt, -1, false, &mut f, &mut s);
        assert_eq!(f.ap.alt_ft, 10_100.0);
        set_alt_step(&mut s, false);
        f.ap.alt_ft = 100.0;
        turn(Knob::Alt, -1, false, &mut f, &mut s);
        assert_eq!(f.ap.alt_ft, 100.0, "lower limit");
        f.ap.alt_ft = 49_000.0;
        turn(Knob::Alt, 1, false, &mut f, &mut s);
        assert_eq!(f.ap.alt_ft, 49_000.0, "upper limit");
    }

    #[test]
    fn dialling_altitude_while_managed_nav_opens_the_climb() {
        let (mut f, mut s) = setup();
        selected(&mut f, &mut s);
        f.ap.nav = true;
        push_pull(Knob::Alt, false, &mut f, &mut s); // push = managed
        sync(0.0, &mut f, &mut s);
        assert!(s.alt_managed && s.hdg_managed);
        turn(Knob::Alt, 1, false, &mut f, &mut s);
        assert!(!s.alt_managed && f.ap.alt_selected, "FCU target takes over");
        assert_eq!(f.ap.alt_ft, 10_100.0);
        push_pull(Knob::Alt, false, &mut f, &mut s);
        assert!(s.alt_managed && !f.ap.alt_selected);
    }

    #[test]
    fn vertical_speed_engage_step_and_level_off() {
        let (mut f, mut s) = setup();
        selected(&mut f, &mut s);
        // not engaged: turning only pre-selects (window shows the value for 45 s)
        assert_eq!(display(&f, &s).vs, "-----");
        turn(Knob::Vs, 1, false, &mut f, &mut s);
        turn(Knob::Vs, 1, true, &mut f, &mut s);
        assert_eq!(s.vs_target, 600.0);
        assert_eq!(display(&f, &s).vs, "+0600");
        assert!(f.ap.vs_hold_fpm.is_none());
        sync(46.0, &mut f, &mut s);
        assert_eq!(display(&f, &s).vs, "-----");
        // pull engages the selected V/S
        turn(Knob::Vs, -1, true, &mut f, &mut s);
        turn(Knob::Vs, -1, true, &mut f, &mut s);
        assert_eq!(s.vs_target, -400.0);
        push_pull(Knob::Vs, true, &mut f, &mut s);
        sync(0.0, &mut f, &mut s);
        assert!(s.vs_mode);
        assert_eq!(f.ap.vs_hold_fpm, Some(-400.0));
        assert_eq!(display(&f, &s).vs, "-0400");
        // turning while engaged updates the autopilot immediately
        turn(Knob::Vs, 1, false, &mut f, &mut s);
        assert_eq!(f.ap.vs_hold_fpm, Some(-300.0));
        // keyboard changes of the autopilot V/S are mirrored on the window
        f.apply(Action::ApVs(-500.0));
        sync(0.0, &mut f, &mut s);
        assert_eq!(s.vs_target, -800.0);
        // push = V/S 0 (level off)
        push_pull(Knob::Vs, false, &mut f, &mut s);
        assert_eq!(f.ap.vs_hold_fpm, Some(0.0));
        assert_eq!(s.vs_target, 0.0);
        // limits
        for _ in 0..80 {
            turn(Knob::Vs, 1, true, &mut f, &mut s);
        }
        assert_eq!(s.vs_target, 6000.0);
    }

    #[test]
    fn vs_requires_the_autopilot() {
        let (mut f, mut s) = setup();
        f.ap.on = false;
        push_pull(Knob::Vs, true, &mut f, &mut s);
        assert!(!s.vs_mode && f.ap.vs_hold_fpm.is_none());
        assert!(s.toast.as_deref().unwrap_or("").contains("engage AP"));
    }

    #[test]
    fn trk_fpa_switch_converts_the_vertical_window() {
        let (mut f, mut s) = setup();
        selected(&mut f, &mut s);
        f.fm.gs = 140.0 * KT;
        s.vs_target = 700.0;
        button(Button::HdgVs, &mut f, &mut s);
        assert!(s.trk_fpa);
        assert!((s.fpa_target - 2.9).abs() < 0.11, "700 fpm at 140 kt is about 3 deg: {}", s.fpa_target);
        let d = display(&f, &s);
        assert!(d.trk && d.fpa);
        s.vs_pre = 5.0;
        assert!(display(&f, &s).vs.starts_with('+') && display(&f, &s).vs.contains('.'));
        turn(Knob::Vs, 1, false, &mut f, &mut s);
        assert!((s.fpa_target - 3.0).abs() < 0.11);
        button(Button::HdgVs, &mut f, &mut s);
        assert!(!s.trk_fpa);
        assert!((s.vs_target - 700.0).abs() <= 100.0, "{}", s.vs_target);
        // the fpm <-> fpa pair is consistent
        assert!((fpa_to_fpm(3.0, 140.0 * KT) - 700.0).abs() <= 100.0);
        assert!((fpm_to_fpa(-1000.0, 250.0 * KT) + 2.3).abs() < 0.2);
    }

    #[test]
    fn exped_needs_the_autopilot_and_cancels_vs() {
        let (mut f, mut s) = setup();
        f.ap.on = false;
        button(Button::Exped, &mut f, &mut s);
        assert!(!s.exped);
        selected(&mut f, &mut s);
        f.ap.vs_hold_fpm = Some(1000.0);
        sync(0.0, &mut f, &mut s);
        assert!(s.vs_mode);
        button(Button::Exped, &mut f, &mut s);
        sync(0.0, &mut f, &mut s);
        assert!(s.exped && f.ap.expedite && !s.vs_mode && f.ap.vs_hold_fpm.is_none());
        button(Button::Exped, &mut f, &mut s);
        assert!(!s.exped && !f.ap.expedite);
        // EXPED drops when the autopilot is disconnected
        button(Button::Exped, &mut f, &mut s);
        f.ap.disengage();
        sync(0.0, &mut f, &mut s);
        assert!(!s.exped && !f.ap.expedite);
    }

    #[test]
    fn ap_channels_and_athr_and_loc_buttons() {
        let (mut f, mut s) = setup();
        f.fm.wow = false;
        f.fm.gs = 150.0 * KT;
        button(Button::Ap1, &mut f, &mut s);
        assert!(f.ap.on && s.ap_eng[0] && !s.ap_eng[1]);
        button(Button::Ap2, &mut f, &mut s);
        assert!(s.ap_eng == [true, true], "dual AP");
        button(Button::Ap1, &mut f, &mut s);
        assert!(f.ap.on && s.ap_eng == [false, true], "autopilot stays on while the other channel is engaged");
        button(Button::Ap2, &mut f, &mut s);
        assert!(!f.ap.on && s.ap_eng == [false, false]);
        // A/THR
        button(Button::Athr, &mut f, &mut s);
        assert!(s.athr_armed);
        button(Button::Athr, &mut f, &mut s);
        assert!(!s.athr_armed);
        // LOC arms, then captures (-> APPR) as soon as a valid localizer is available with the AP on
        button(Button::Loc, &mut f, &mut s);
        assert!(s.loc_armed);
        sync(0.0, &mut f, &mut s);
        assert!(s.loc_armed && !f.ap.appr, "needs the AP");
        f.ap.on = true;
        f.ils.valid = true;
        sync(0.0, &mut f, &mut s);
        assert!(!s.loc_armed && f.ap.appr, "LOC captured");
        // APPR toggles
        button(Button::Appr, &mut f, &mut s);
        assert!(!f.ap.appr);
        button(Button::Loc, &mut f, &mut s);
        button(Button::Loc, &mut f, &mut s);
        assert!(!s.loc_armed);
    }

    #[test]
    fn metric_toggle_and_legends() {
        let (mut f, mut s) = setup();
        selected(&mut f, &mut s);
        button(Button::MetricAlt, &mut f, &mut s);
        assert!(s.metric);
        let d = display(&f, &s);
        assert!(d.on);
        assert_eq!(d.alt, "10000", "ALT window is always feet");
        for (n, want) in [("spd.ind", true), ("mach.ind", false), ("hdg.ind", true), ("trk.ind", false), ("vs.ind", true), ("fpa.ind", false), ("spd.fmgc", false), ("lat.fmgc", false), ("alt.ind", false), ("vs.dash", false)] {
            assert_eq!(legend_lit(n, &d), Some(want), "{n}");
        }
        assert_eq!(legend_lit("nonsense", &d), None);
        s.ac = false;
        let dark = display(&f, &s);
        assert!(!dark.on && legend_lit("spd.ind", &dark) == Some(false), "unpowered FCU is dark");
    }

    #[test]
    fn level_change_legend_and_managed_dots() {
        let (mut f, mut s) = setup();
        selected(&mut f, &mut s);
        f.fm.pos.y = 5_000.0 * FT;
        assert!(display(&f, &s).lvl_ch, "5000 ft away from the FCU altitude");
        f.fm.pos.y = 9_900.0 * FT;
        assert!(!display(&f, &s).lvl_ch);
        f.ap.nav = true;
        f.ap.spd_selected = false;
        f.ap.alt_selected = false;
        sync(0.0, &mut f, &mut s);
        let d = display(&f, &s);
        assert!(d.spd_dot && d.lat_dot && d.ver_dot);
        assert_eq!((d.spd.as_str(), d.hdg.as_str()), ("---", "---"));
    }

    #[test]
    fn keyboard_selection_is_mirrored_to_the_windows() {
        let (mut f, mut s) = setup();
        f.fm.wow = false;
        f.ap.on = true;
        sync(0.0, &mut f, &mut s);
        assert!(s.spd_managed && s.alt_managed);
        f.apply(Action::ApSpd(5.0));
        f.apply(Action::ApAlt(100.0));
        sync(0.0, &mut f, &mut s);
        assert!(!s.spd_managed && !s.alt_managed, "keyboard speed / altitude entries select the windows");
        assert_eq!(display(&f, &s).spd, format!("{:03}", f.ap.spd.round() as i64));
    }
}
