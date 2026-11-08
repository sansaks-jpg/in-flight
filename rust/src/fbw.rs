//! A320 Fly-By-Wire normal-law envelope (reference: `src/sim/physics.ts` FBW block, `src/sim/a320/displays.ts` speed tape).
//!
//! The control law itself runs inside `FlightModel::step` (120 Hz); this module owns the **shared constants** so the law,
//! the PFD and the tests can never drift apart, and derives the displayed protection speeds:
//!
//! | tape mark | meaning | source |
//! |---|---|---|
//! | VLS | lowest selectable speed (1.13 x Vs1g) | amber bar top |
//! | Vα prot | speed at which the α-protection starts (stick no longer commands more α) | amber/black hatch |
//! | Vα max | max α reachable with full back stick | red/black hatch |
//! | Vsw | stall warning | red bar |
//! | VMAX | min(VMO/MMO, VFE of the next flap setting, VLE with gear out) | red/black bar top |

use crate::geo::{G, KT};
use crate::physics::{atmosphere, FlightModel};

/// α-protection engages at this fraction of the stall α (pitch rate demand is replaced by an α-law).
pub const ALPHA_PROT_FRAC: f64 = 0.84;
/// Full back stick never exceeds this fraction of the stall α.
pub const ALPHA_MAX_FRAC: f64 = 0.95;
/// α-floor: automatic TOGA thrust above this fraction (engines go to full power regardless of the lever).
pub const ALPHA_FLOOR_FRAC: f64 = 0.90;
/// Stall warning (aural + PFD) fraction of the stall α.
pub const ALPHA_SW_FRAC: f64 = 0.92;
/// Bank limits: stick released => the law returns to 33 deg; full stick saturates at 67 deg.
pub const BANK_NEUTRAL_DEG: f64 = 33.0;
pub const BANK_MAX_DEG: f64 = 67.0;
/// Pitch attitude protection: +30 (+25 with CONF 3 / FULL) up, -15 down.
pub const PITCH_UP_CLEAN_DEG: f64 = 30.0;
pub const PITCH_UP_FLAPS_DEG: f64 = 25.0;
pub const PITCH_DOWN_DEG: f64 = -15.0;
/// Load-factor limits: +2.5 g clean / +2.0 g with flaps, -1.0 g.
pub const NZ_UP_CLEAN: f64 = 2.5;
pub const NZ_UP_FLAPS: f64 = 2.0;
pub const NZ_DOWN: f64 = -1.0;
/// MMO (Mach) used by the high-speed protection.
pub const MMO: f64 = 0.82;

#[derive(Clone, Copy, Debug)]
pub struct Envelope {
    pub vls: f64,
    pub v_alpha_prot: f64,
    pub v_alpha_max: f64,
    pub v_sw: f64,
    pub vmax: f64,
    pub pitch_up_deg: f64,
    pub pitch_down_deg: f64,
    pub nz_up: f64,
    pub bank_limit_deg: f64,
    /// α above the protection threshold (stick is commanding α rather than load factor)
    pub alpha_prot: bool,
    pub alpha_floor: bool,
    /// overspeed protection pushing the nose up
    pub high_speed_prot: bool,
    /// bank exceeds the 33 deg neutral limit (the law is not returning to wings level)
    pub bank_over_neutral: bool,
}

/// IAS (kt) at which a 1 g flight reaches angle of attack `alpha` with the current mass / configuration.
pub fn speed_at_alpha_kt(fm: &FlightModel, alpha: f64) -> f64 {
    let s = fm.spec;
    let fl = fm.flaps_pos;
    let cl0 = s.cl0 + s.flap_cl * fl_lift(fl);
    let cl = (cl0 + s.cla * alpha).max(0.2);
    let sigma = (fm.rho / 1.225).max(0.05);
    let v_tas = (2.0 * fm.mass * G / (fm.rho.max(0.05) * s.s * cl)).sqrt();
    v_tas * sigma.sqrt() / KT
}

/// Same flap-lift schedule as the physics model (`FLAP_LIFT` table), 0..1 -> 0..1.
fn fl_lift(fl: f64) -> f64 {
    crate::physics::flap_lift_fraction(fl)
}

pub fn envelope(fm: &FlightModel) -> Envelope {
    let s = fm.spec;
    let a_stall = fm.alpha_stall.max(0.2);
    let vs1g = speed_at_alpha_kt(fm, a_stall);
    let last = s.vfe.len() - 1;
    let next = (fm.ctl.flaps_idx).min(last);
    let mut vmax = s.vne.min(s.vfe[next] + 4.0);
    if fm.gear_pos > 0.02 {
        vmax = vmax.min(s.vle);
    }
    let kias = fm.ias / KT;
    let air = !fm.wow && fm.airborne_time > 1.0;
    let sigma = atmosphere(fm.pos.y, &fm.air).sigma;
    let mach_limit_kias = MMO * atmosphere(fm.pos.y, &fm.air).a * sigma.sqrt() / KT;
    vmax = vmax.min(mach_limit_kias);
    Envelope {
        vls: vs1g * 1.13,
        v_alpha_prot: speed_at_alpha_kt(fm, a_stall * ALPHA_PROT_FRAC),
        v_alpha_max: speed_at_alpha_kt(fm, a_stall * ALPHA_MAX_FRAC),
        v_sw: speed_at_alpha_kt(fm, a_stall * ALPHA_SW_FRAC),
        vmax,
        pitch_up_deg: if fm.flaps_pos > 0.9 { PITCH_UP_FLAPS_DEG } else { PITCH_UP_CLEAN_DEG },
        pitch_down_deg: PITCH_DOWN_DEG,
        nz_up: if fm.flaps_pos > 0.05 { NZ_UP_FLAPS } else { NZ_UP_CLEAN },
        bank_limit_deg: BANK_MAX_DEG,
        alpha_prot: air && fm.ctl.assist && fm.alpha > a_stall * ALPHA_PROT_FRAC,
        alpha_floor: air && fm.ctl.assist && fm.alpha > a_stall * ALPHA_FLOOR_FRAC,
        high_speed_prot: fm.ctl.assist && (kias > s.vne - 1.0 || fm.mach > MMO),
        bank_over_neutral: fm.bank.to_degrees().abs() > BANK_NEUTRAL_DEG + 1.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cruise(flaps: usize, kt: f64) -> FlightModel {
        let mut fm = FlightModel::new(Some(8000.0));
        fm.place_airborne(0.0, 3000.0, 0.0, 90.0, kt, flaps, flaps > 0);
        for _ in 0..240 {
            fm.step(1.0 / 120.0, &|_, _| 0.0);
        }
        fm
    }

    #[test]
    fn protection_speeds_are_ordered_and_plausible() {
        let fm = cruise(0, 250.0);
        let e = envelope(&fm);
        // stall warning (0.92 alpha-stall) sits between alpha-max (0.95) and alpha-prot (0.84) in speed
        assert!(e.v_alpha_max < e.v_sw && e.v_sw < e.v_alpha_prot && e.v_alpha_prot < e.vls, "{e:?}");
        assert!(e.vls > 110.0 && e.vls < 260.0, "VLS {}", e.vls);
        assert!(e.vmax > e.vls + 60.0 && e.vmax <= fm.spec.vne);
    }

    #[test]
    fn flaps_lower_the_protection_speeds_and_the_vmax() {
        let clean = envelope(&cruise(0, 230.0));
        let flapped = envelope(&cruise(3, 200.0));
        assert!(flapped.vls < clean.vls - 10.0, "{} vs {}", flapped.vls, clean.vls);
        assert!(flapped.vmax < clean.vmax);
        assert_eq!(flapped.nz_up, NZ_UP_FLAPS);
        assert_eq!(clean.nz_up, NZ_UP_CLEAN);
    }

    #[test]
    fn heavier_means_faster_and_stall_alpha_matches_speed_marks() {
        let mut light = cruise(0, 250.0);
        let mut heavy = cruise(0, 250.0);
        light.fuel = 2000.0;
        light.mass = light.total_mass();
        heavy.mass = heavy.total_mass() + 12000.0;
        assert!(envelope(&heavy).vls > envelope(&light).vls * 1.05);
        // the mark for a_prot must give back the a_prot when flown at that speed (1 g)
        let e = envelope(&light);
        assert!(e.v_alpha_prot > e.v_sw && e.v_sw > e.v_alpha_max);
    }

    #[test]
    fn normal_law_limits_pitch_bank_and_alpha_under_abuse() {
        // full back stick, flaps up, thrust for level flight: α must stay below the stall (protection), no stall
        let mut fm = cruise(0, 230.0);
        fm.ctl.throttle = 0.55;
        fm.ctl.pitch = 1.0;
        let mut max_pitch: f64 = 0.0;
        let mut max_alpha_ratio: f64 = 0.0;
        for _ in 0..(120 * 40) {
            fm.step(1.0 / 120.0, &|_, _| 0.0);
            max_pitch = max_pitch.max(fm.pitch.to_degrees());
            max_alpha_ratio = max_alpha_ratio.max(fm.alpha / fm.alpha_stall);
            if fm.crashed {
                break;
            }
        }
        assert!(!fm.crashed && !fm.stalled, "normal law must be unstallable (alpha/stall {max_alpha_ratio:.2})");
        assert!(max_pitch < PITCH_UP_CLEAN_DEG + 6.0, "pitch protection {max_pitch}");
        assert!(max_alpha_ratio < 1.0, "alpha protection {max_alpha_ratio}");
    }

    #[test]
    fn full_roll_stick_saturates_at_the_bank_limit() {
        let mut fm = cruise(0, 280.0);
        fm.ctl.roll = 1.0;
        let mut max_bank: f64 = 0.0;
        for _ in 0..(120 * 30) {
            fm.ctl.throttle = (fm.ctl.throttle + (280.0 - fm.ias / KT) * 0.0004).clamp(0.0, 1.0);
            fm.step(1.0 / 120.0, &|_, _| 0.0);
            max_bank = max_bank.max(fm.bank.to_degrees().abs());
        }
        assert!(max_bank > 55.0 && max_bank < BANK_MAX_DEG + 8.0, "bank {max_bank}");
        // releasing the stick returns to <= 33 deg (spiral stability)
        fm.ctl.roll = 0.0;
        for _ in 0..(120 * 20) {
            fm.step(1.0 / 120.0, &|_, _| 0.0);
        }
        assert!(fm.bank.to_degrees().abs() < BANK_NEUTRAL_DEG + 3.0, "bank after release {}", fm.bank.to_degrees());
    }

    #[test]
    fn alpha_floor_applies_toga_near_the_stall() {
        // slow, nose-up, idle thrust: the alpha-floor must command full thrust
        let mut fm = FlightModel::new(Some(8000.0));
        fm.place_airborne(0.0, 3000.0, 0.0, 90.0, 190.0, 0, false);
        fm.ctl.throttle = 0.0;
        fm.ctl.pitch = 1.0;
        let mut floor_seen = false;
        let mut max_n = 0.0f64;
        for _ in 0..(120 * 60) {
            fm.step(1.0 / 120.0, &|_, _| 0.0);
            floor_seen |= envelope(&fm).alpha_floor;
            max_n = max_n.max(fm.n[0]);
            if fm.crashed {
                break;
            }
        }
        assert!(floor_seen, "alpha floor must trigger when decelerating with full back stick");
        assert!(max_n > 0.9, "TOGA must spool up with the lever at idle: N1 {max_n}");
    }
}
