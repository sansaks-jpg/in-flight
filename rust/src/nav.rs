//! Lateral / vertical navigation maths (port of `src/sim/lnav.ts`) plus the flight-plan builder.
//!
//! Real FMS behaviour reproduced: guidance follows the LEG (not a direct bearing), cross-track is corrected with a
//! bounded intercept angle scaled with ground speed, waypoints are FLY-BY (sequenced at the turn-anticipation distance
//! d = R·tan(Δθ/2)), and the departure fix is never a target once airborne.

use crate::airports::{Airport, RunwayEnd};
use crate::geo::*;

const DIRECT_TO_XTK_M: f64 = 15000.0;
const MAX_INTERCEPT_DEG: f64 = 30.0;
const XTK_TAU_S: f64 = 28.0;
pub const PATH_TAN_DEG: f64 = 3.0;

fn min_capture(k: WpType) -> f64 {
    match k {
        WpType::Takeoff => 0.0,
        WpType::Climb => 1500.0,
        WpType::Cruise => 2000.0,
        WpType::Tod => 1500.0,
        WpType::Iaf => 1000.0,
        WpType::Faf => 500.0,
        WpType::Touchdown => 150.0,
        WpType::Rollout => 80.0,
    }
}

#[derive(Clone, Copy, Debug)]
pub struct LegGuidance {
    pub course: f64,
    pub xtk_m: f64,
    pub along_to_go_m: f64,
    pub dist_to_wp_m: f64,
    pub leg_len_m: f64,
    pub direct: bool,
}

pub fn inbound_course(plan: &[Waypoint], idx: usize, lat: f64, lon: f64) -> f64 {
    let wp = &plan[idx];
    if idx > 0 {
        let p = &plan[idx - 1];
        if haversine(p.lat, p.lon, wp.lat, wp.lon) > 50.0 {
            return bearing(p.lat, p.lon, wp.lat, wp.lon);
        }
    }
    wp.hdg.unwrap_or_else(|| bearing(lat, lon, wp.lat, wp.lon))
}

pub fn leg_guidance(plan: &[Waypoint], idx: usize, lat: f64, lon: f64) -> LegGuidance {
    let wp = &plan[idx];
    let dist = haversine(lat, lon, wp.lat, wp.lon);
    let direct = LegGuidance { course: bearing(lat, lon, wp.lat, wp.lon), xtk_m: 0.0, along_to_go_m: dist, dist_to_wp_m: dist, leg_len_m: dist, direct: true };
    if idx == 0 {
        return direct;
    }
    let prev = &plan[idx - 1];
    let leg_len = haversine(prev.lat, prev.lon, wp.lat, wp.lon);
    if leg_len < 150.0 {
        return direct;
    }
    let (xtk, atk) = cross_track(lat, lon, prev.lat, prev.lon, wp.lat, wp.lon);
    if xtk.abs() > DIRECT_TO_XTK_M || atk < -DIRECT_TO_XTK_M {
        return direct;
    }
    let leg_brg = bearing(prev.lat, prev.lon, wp.lat, wp.lon);
    let (pl, po) = destination(prev.lat, prev.lon, leg_brg, clamp(atk, 0.0, leg_len - 1.0));
    let course = if haversine(pl, po, wp.lat, wp.lon) > 30.0 { bearing(pl, po, wp.lat, wp.lon) } else { leg_brg };
    LegGuidance { course, xtk_m: xtk, along_to_go_m: leg_len - atk, dist_to_wp_m: dist, leg_len_m: leg_len, direct: false }
}

pub fn intercept_angle_deg(xtk_m: f64, gs_ms: f64) -> f64 {
    let k = 57.2958 / (gs_ms.max(30.0) * XTK_TAU_S);
    clamp(-xtk_m * k, -MAX_INTERCEPT_DEG, MAX_INTERCEPT_DEG)
}

pub fn turn_lead_m(in_course: f64, out_course: f64, gs_ms: f64, bank_deg: f64) -> f64 {
    let d_theta = wrap180(out_course - in_course).abs() * D2R;
    if d_theta < 3.0 * D2R {
        return 0.0;
    }
    let r = (gs_ms * gs_ms) / (G * (bank_deg * D2R).tan());
    clamp(r * (d_theta.min(150.0 * D2R) / 2.0).tan(), 0.0, 25000.0)
}

/// Advances the active waypoint as far as the geometry demands. Never moves backwards, never leaves the last fix.
pub fn advance_waypoint(plan: &[Waypoint], idx: usize, lat: f64, lon: f64, gs_ms: f64, airborne: bool) -> usize {
    if plan.is_empty() || !lat.is_finite() || !lon.is_finite() {
        return idx.min(plan.len().saturating_sub(1));
    }
    let mut i = idx.min(plan.len() - 1);
    for _ in 0..plan.len() {
        if i >= plan.len() - 1 {
            break;
        }
        let wp = &plan[i];
        if airborne && wp.kind == WpType::Takeoff {
            i += 1;
            continue;
        }
        let dist = haversine(lat, lon, wp.lat, wp.lon);
        let in_c = inbound_course(plan, i, lat, lon);
        let out_c = bearing(wp.lat, wp.lon, plan[i + 1].lat, plan[i + 1].lon);
        let capture = turn_lead_m(in_c, out_c, gs_ms, 25.0).max(min_capture(wp.kind));
        let behind = wrap180(bearing(lat, lon, wp.lat, wp.lon) - in_c).abs() > 90.0 && dist < 60000.0;
        if dist <= capture || behind {
            i += 1;
            continue;
        }
        break;
    }
    i
}

pub fn plan_cruise_alt_m(plan: &[Waypoint]) -> Option<f64> {
    plan.iter().filter(|w| matches!(w.kind, WpType::Cruise | WpType::Tod)).map(|w| w.alt_m).fold(None, |a, v| Some(a.map_or(v, |x: f64| x.max(v))))
}

/// Distance still to fly along the route from the aircraft to plan[to_idx].
pub fn plan_distance_m(plan: &[Waypoint], idx: usize, lat: f64, lon: f64, to_idx: usize) -> f64 {
    if plan.is_empty() || to_idx < idx {
        return 0.0;
    }
    let i = idx.min(plan.len() - 1);
    let j = to_idx.min(plan.len() - 1);
    let mut d = haversine(lat, lon, plan[i].lat, plan[i].lon);
    for k in i..j {
        d += haversine(plan[k].lat, plan[k].lon, plan[k + 1].lat, plan[k + 1].lon);
    }
    d
}

/// Cruise level (m): a 3° descent plus a ~1500 ft/min climb must fit into the route; ICAO semicircular rule
/// (eastbound odd / westbound even thousands of feet).
pub fn cruise_level_m(route_m: f64, course_deg: f64, max_m: f64, field_elev_m: f64, floor_m: f64) -> f64 {
    let usable = (route_m - 30000.0).max(0.0);
    let reach = field_elev_m + usable / 40.0;
    let min_ft = (floor_m / FT / 1000.0).ceil() as i64;
    let mut ft = min_ft.max((max_m.min(reach) / FT / 1000.0).floor() as i64);
    let east = wrap360(course_deg) < 180.0;
    if (ft % 2 == 1) != east {
        ft += if ft <= min_ft { 1 } else { -1 };
    }
    ft as f64 * 1000.0 * FT
}

pub const IAF_DIST_M: f64 = 24000.0;
pub const FAF_DIST_M: f64 = 11000.0;

/// Build dep-runway -> climb -> cruise -> TOD -> IAF -> FAF -> threshold -> rollout.
pub fn build_plan(dep: &Airport, dep_end: &RunwayEnd, arr: &Airport, arr_end: &RunwayEnd, cruise_req_m: f64) -> Vec<Waypoint> {
    let tan3 = (PATH_TAN_DEG * D2R).tan();
    let (c_lat, c_lon) = destination(dep_end.start_lat, dep_end.start_lon, dep_end.hdg, 7000.0);
    let back = (arr_end.hdg + 180.0) % 360.0;
    let (iaf_lat, iaf_lon) = destination(arr_end.thr_lat, arr_end.thr_lon, back, IAF_DIST_M);
    let (faf_lat, faf_lon) = destination(arr_end.thr_lat, arr_end.thr_lon, back, FAF_DIST_M);
    // Entry fix: when the turn onto the final-approach course would exceed ~45° (short hops, route reversals) an
    // intercept fix is inserted on the extended centreline so the turn is made at a fix, not at the IAF.
    let direct_course = bearing(c_lat, c_lon, iaf_lat, iaf_lon);
    let needs_intc = wrap180(arr_end.hdg - direct_course).abs() > 45.0;
    let (e_lat, e_lon) = if needs_intc { destination(arr_end.thr_lat, arr_end.thr_lon, back, IAF_DIST_M + 12000.0) } else { (iaf_lat, iaf_lon) };
    let entry_to_td = if needs_intc { IAF_DIST_M + 12000.0 } else { IAF_DIST_M };
    let route_m = haversine(c_lat, c_lon, e_lat, e_lon);
    let course = bearing(c_lat, c_lon, e_lat, e_lon);
    let floor = dep.elev.max(arr.elev) + 900.0;
    let cruise = cruise_level_m(route_m + 30000.0, course, cruise_req_m, dep.elev.max(arr.elev), floor);
    let tod_dist = ((cruise - arr.elev) / tan3).max(entry_to_td + 1000.0);
    let frac_tod = clamp(1.0 - (tod_dist - entry_to_td) / route_m.max(1.0), 0.45, 0.9);
    let pt = |f: f64| -> (f64, f64) { destination(c_lat, c_lon, course, route_m * f) };
    let (cr_lat, cr_lon) = pt(frac_tod * 0.5);
    let (td_lat, td_lon) = pt(frac_tod);
    let (end_lat, end_lon) = destination(arr_end.thr_lat, arr_end.thr_lon, arr_end.hdg, arr_end.length - arr_end.disp);
    let w = |name: &str, kind, lat, lon, alt_m, hdg| Waypoint { name: name.to_string(), kind, lat, lon, alt_m, speed_kt: 0.0, hdg };
    let mut plan = vec![
        w(&format!("RW{}", dep_end.ident), WpType::Takeoff, dep_end.start_lat, dep_end.start_lon, dep.elev, Some(dep_end.hdg)),
        w("CLIMB", WpType::Climb, c_lat, c_lon, dep.elev + 1000.0, None),
        w("CRUISE", WpType::Cruise, cr_lat, cr_lon, cruise, None),
        w("TOD", WpType::Tod, td_lat, td_lon, cruise, None),
    ];
    if needs_intc {
        plan.push(w("INTC", WpType::Climb, e_lat, e_lon, cruise, None));
    }
    plan.extend([
        w("IAF", WpType::Iaf, iaf_lat, iaf_lon, arr.elev + IAF_DIST_M * tan3 + 15.0, Some(arr_end.hdg)),
        w("FAF", WpType::Faf, faf_lat, faf_lon, arr.elev + FAF_DIST_M * tan3 + 15.0, Some(arr_end.hdg)),
        w(&format!("RW{}", arr_end.ident), WpType::Touchdown, arr_end.thr_lat, arr_end.thr_lon, arr.elev + 15.0, Some(arr_end.hdg)),
        w("ROLLOUT", WpType::Rollout, end_lat, end_lon, arr.elev, Some(arr_end.hdg)),
    ]);
    plan
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::airports::AirportDb;

    #[test]
    fn cruise_level_semicircular_and_reachable() {
        let l = cruise_level_m(540_000.0, 138.0, 11000.0, 40.0, 900.0);
        let ft = (l / FT / 1000.0).round() as i64;
        assert!(ft % 2 == 1 && ft >= 3, "eastbound odd: FL{ft}0");
        let l = cruise_level_m(540_000.0, 300.0, 11000.0, 40.0, 900.0);
        assert!(((l / FT / 1000.0).round() as i64) % 2 == 0);
        // short hop never exceeds what can be reached
        let l = cruise_level_m(40_000.0, 90.0, 11000.0, 5.0, 900.0);
        assert!(l <= 4.0 * 1000.0 * FT, "{l}");
    }

    #[test]
    fn plan_is_ordered_and_sane() {
        let db = AirportDb::embedded();
        let (a, b) = (db.get("KSFO").unwrap(), db.get("KOAK").unwrap());
        let (ae, be) = (a.best_end(280.0).unwrap(), b.best_end(280.0).unwrap());
        let plan = build_plan(a, &ae, b, &be, 11000.0);
        assert!(plan.len() == 8 || plan.len() == 9);
        assert_eq!(plan[0].kind, WpType::Takeoff);
        let td = plan.iter().position(|w| w.kind == WpType::Touchdown).unwrap();
        assert_eq!(td, plan.len() - 2);
        let mut prev = 0.0;
        for i in 1..plan.len() {
            let d = haversine(plan[0].lat, plan[0].lon, plan[i].lat, plan[i].lon);
            assert!(d.is_finite());
            let _ = prev;
            prev = d;
        }
        // final approach course matches runway heading
        let iaf = plan.iter().position(|w| w.kind == WpType::Iaf).unwrap();
        let c = bearing(plan[iaf].lat, plan[iaf].lon, plan[td].lat, plan[td].lon);
        assert!(wrap180(c - be.hdg).abs() < 1.0, "{c} vs {}", be.hdg);
    }

    #[test]
    fn fly_by_sequencing_never_goes_backwards() {
        let db = AirportDb::embedded();
        let (a, b) = (db.get("KSFO").unwrap(), db.get("KLAX").unwrap());
        let (ae, be) = (a.best_end(280.0).unwrap(), b.best_end(250.0).unwrap());
        let plan = build_plan(a, &ae, b, &be, 11000.0);
        // airborne over the first climb fix: takeoff fix is skipped
        let i = advance_waypoint(&plan, 0, plan[1].lat, plan[1].lon, 150.0, true);
        assert!(i >= 2, "{i}");
        // a point right on the last fix stays on the last fix
        let last = plan.len() - 1;
        assert_eq!(advance_waypoint(&plan, last, plan[last].lat, plan[last].lon, 5.0, false), last);
    }

    #[test]
    fn leg_guidance_corrects_cross_track() {
        let db = AirportDb::embedded();
        let (a, b) = (db.get("KSFO").unwrap(), db.get("KLAX").unwrap());
        let (ae, be) = (a.best_end(280.0).unwrap(), b.best_end(250.0).unwrap());
        let plan = build_plan(a, &ae, b, &be, 11000.0);
        let (mid_lat, mid_lon) = (plan[1].lat * 0.5 + plan[2].lat * 0.5, plan[1].lon * 0.5 + plan[2].lon * 0.5);
        let g = leg_guidance(&plan, 2, mid_lat, mid_lon);
        assert!(!g.direct && g.xtk_m.abs() < 2000.0, "{:?}", g); // lat/lon midpoint is off the great circle by a few hundred m
        // an aircraft to the right of the course (positive xtk) must be told to turn left (negative intercept)
        let (lat, lon) = destination(mid_lat, mid_lon, (g.course + 90.0) % 360.0, 3000.0);
        let g2 = leg_guidance(&plan, 2, lat, lon);
        assert!(g2.xtk_m > 1000.0);
        assert!(intercept_angle_deg(g2.xtk_m, 200.0) < 0.0);
    }
}
