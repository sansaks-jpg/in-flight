//! Flight dispatch maths (port of `computeRouteDispatch` / `getCuratedRoutes` in `src/ui/flightDispatch.ts`, extended with
//! the A320 briefing numbers the planner shows: semicircular cruise level, top-of-descent, block fuel, wind components).

use crate::airports::{Airport, AirportDb};
use crate::geo::*;
use crate::specs::A320;

pub const M_PER_NM: f64 = 1852.0;
/// Published A320-200 still-air range used by the original dispatcher (`spec.rangeKm`).
pub const A320_RANGE_KM: f64 = 5700.0;
/// Highest certified level of the A320 (ceiling 11 900 m ≈ FL390).
pub const MAX_FL: u32 = 390;

#[derive(Clone, Debug)]
pub struct RouteDispatch {
    pub distance_m: f64,
    pub distance_km: f64,
    pub distance_nm: f64,
    /// initial great-circle course, degrees true
    pub bearing_deg: f64,
    pub ete_minutes: f64,
    pub trip_fuel_kg: f64,
    pub contingency_kg: f64,
    pub reserve_kg: f64,
    pub taxi_kg: f64,
    /// trip + contingency + final reserve + taxi, rounded up to 10 kg
    pub block_fuel_kg: f64,
    pub fuel_exceeds_tanks: bool,
    pub planned_fl: u32,
    pub tod_nm: f64,
    pub climb_nm: f64,
    pub max_range_km: f64,
    pub in_range: bool,
    pub same_airport: bool,
    pub can_fly: bool,
}

/// "2h 05m" / "47m".
pub fn fmt_ete(min: f64) -> String {
    let m = min.round().max(0.0) as u32;
    if m >= 60 {
        format!("{}h {:02}m", m / 60, m % 60)
    } else {
        format!("{m}m")
    }
}

/// Semicircular (hemispherical) rule: tracks 000-179° use ODD flight levels (FL 310, 330, 350 ...), tracks 180-359° EVEN
/// ones (FL 320, 340, 360 ...). Returns the level closest to `target_fl` that obeys the rule (never above [`MAX_FL`]).
pub fn semicircular_fl(track_deg: f64, target_fl: u32) -> u32 {
    let eastbound = wrap360(track_deg) < 180.0;
    let want_odd = eastbound;
    let mut best = 0u32;
    let mut best_d = u32::MAX;
    let mut fl = 50u32;
    while fl <= MAX_FL {
        let is_odd = (fl / 10) % 2 == 1;
        if is_odd == want_odd {
            let d = fl.abs_diff(target_fl);
            if d < best_d {
                best_d = d;
                best = fl;
            }
        }
        fl += 10;
    }
    best
}

/// Top-of-descent distance (NM before the runway) for a 3° path from `fl` down to the arrival elevation.
pub fn tod_distance_nm(fl: u32, arr_elev_m: f64) -> f64 {
    let tan3 = (crate::nav::PATH_TAN_DEG * D2R).tan();
    ((fl as f64 * 100.0 * FT - arr_elev_m).max(0.0) / tan3) / M_PER_NM
}

/// Rough ground distance covered during the climb (average 2 200 fpm at ~300 kt ground speed).
pub fn climb_distance_nm(fl: u32, dep_elev_m: f64) -> f64 {
    let alt_ft = (fl as f64 * 100.0 - dep_elev_m / FT).max(0.0);
    alt_ft / 2200.0 * 5.0
}

/// Cruise level for a route: as high as the route is long enough for (climb + descent must fit in ~85 % of the route),
/// then snapped to the semicircular rule.
pub fn planned_flight_level(dist_nm: f64, track_deg: f64, dep_elev_m: f64, arr_elev_m: f64) -> u32 {
    let mut target = MAX_FL - 30; // FL360 preferred
    while target > 50 {
        let fl = semicircular_fl(track_deg, target);
        if climb_distance_nm(fl, dep_elev_m) + tod_distance_nm(fl, arr_elev_m) <= dist_nm * 0.85 {
            return fl;
        }
        target -= 10;
    }
    semicircular_fl(track_deg, 50)
}

pub fn compute(dep: &Airport, arr: &Airport) -> RouteDispatch {
    let dist = haversine(dep.lat, dep.lon, arr.lat, arr.lon);
    let brg = bearing(dep.lat, dep.lon, arr.lat, arr.lon);
    let km = dist / 1000.0;
    let nm = dist / M_PER_NM;
    let spec = &A320;
    let ete = dist / (spec.cruise_kt * KT) / 60.0 + 10.0;
    let max_range_km = (A320_RANGE_KM * 0.92).round();
    let in_range = km <= A320_RANGE_KM * 0.92;
    let same = dep.icao == arr.icao;
    // Calibrated to the simulator's own fuel load (`Flight::new`: 2.6 kg per route km + a fixed climb/descent allowance) so the
    // briefing and the 92 % range limit agree with the 18 730 kg tanks. (The web dispatcher's `fuelFlow * 1.25` margin
    // formula would exceed tank capacity at 70 % of the published range.)
    let trip = (km * 2.6 + 350.0).round();
    let contingency = (trip * 0.05).round();
    let reserve = (spec.fuel_flow * 0.65 * 1800.0).round();
    let taxi = 150.0;
    let block = ((trip + contingency + reserve + taxi) / 10.0).ceil() * 10.0;
    let fl = planned_flight_level(nm, brg, dep.elev, arr.elev);
    RouteDispatch {
        distance_m: dist,
        distance_km: km,
        distance_nm: nm,
        bearing_deg: brg,
        ete_minutes: ete,
        trip_fuel_kg: trip,
        contingency_kg: contingency,
        reserve_kg: reserve,
        taxi_kg: taxi,
        block_fuel_kg: block.min(spec.fuel_cap),
        fuel_exceeds_tanks: block > spec.fuel_cap,
        planned_fl: fl,
        tod_nm: tod_distance_nm(fl, arr.elev),
        climb_nm: climb_distance_nm(fl, dep.elev),
        max_range_km,
        in_range,
        same_airport: same,
        can_fly: in_range && !same,
    }
}

/// Head/tail and cross wind components (kt) for a runway heading. Headwind positive; crosswind positive from the right.
pub fn wind_components(wind_from_deg: f64, wind_kt: f64, rwy_hdg: f64) -> (f64, f64) {
    let a = (wind_from_deg - rwy_hdg) * D2R;
    (wind_kt * a.cos(), wind_kt * a.sin())
}

// ------------------------------------------------------------------------------------------------ regions

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Region {
    Indonesia,
    Americas,
    Europe,
    MiddleEast,
    Africa,
    AsiaPacific,
}

pub const REGIONS: [(Region, &str); 6] = [
    (Region::Indonesia, "Indonesia"),
    (Region::Americas, "Americas"),
    (Region::Europe, "Europe"),
    (Region::MiddleEast, "Middle East"),
    (Region::Africa, "Africa"),
    (Region::AsiaPacific, "Asia-Pacific"),
];

pub fn region_of(a: &Airport) -> Region {
    if a.country == "ID" {
        return Region::Indonesia;
    }
    let (lat, lon) = (a.lat, a.lon);
    if (-170.0..-25.0).contains(&lon) {
        return Region::Americas;
    }
    if (-25.0..45.0).contains(&lon) && lat >= 35.0 {
        return Region::Europe;
    }
    if (25.0..65.0).contains(&lon) && (12.0..42.0).contains(&lat) {
        return Region::MiddleEast;
    }
    if (-25.0..55.0).contains(&lon) && lat < 35.0 {
        return Region::Africa;
    }
    Region::AsiaPacific
}

// ------------------------------------------------------------------------------------------------ curated routes

pub const ROUTES: &[(&str, &str, &str, &str, bool)] = &[
    ("WIII", "WADD", "Jakarta to Bali", "High-density trunk airliner route", true),
    ("WADD", "WATO", "Bali to Labuan Bajo", "Komodo archipelago scenic hop", true),
    ("WIII", "WAHI", "Jakarta to Yogyakarta", "Central Java heritage corridor", true),
    ("WIMM", "WIMN", "Medan to Silangit", "Lake Toba volcanic caldera", true),
    ("WAAA", "WASS", "Makassar to Sorong", "Raja Ampat island gateway", true),
    ("WADD", "WARR", "Bali to Surabaya", "Java Sea island crossing", true),
    ("KSFO", "KLAX", "San Francisco to Los Angeles", "California Pacific coastline", false),
    ("LSZH", "LOWI", "Zurich to Innsbruck", "Challenging Inn Valley Alps approach", false),
    ("EGLL", "LFPG", "London to Paris", "Cross-Channel historic shuttle", false),
    ("KJFK", "KBOS", "New York to Boston", "New England Atlantic corridor", false),
    ("RJTT", "RJBB", "Tokyo to Osaka", "Mt. Fuji & Tokaido scenic flight", false),
    ("YSSY", "YMML", "Sydney to Melbourne", "Busiest Australian air corridor", false),
    ("OMDB", "OMAA", "Dubai to Abu Dhabi", "Arabian Gulf mega-hub hop", false),
    ("KDEN", "KASE", "Denver to Aspen", "High-altitude Rocky Mountain runway", false),
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RouteFilter {
    All,
    Indonesia,
    World,
}

/// Curated routes whose airports exist in the database: (index into [`ROUTES`], distance NM).
pub fn curated_routes(db: &AirportDb, filter: RouteFilter) -> Vec<(usize, u32)> {
    ROUTES
        .iter()
        .enumerate()
        .filter(|(_, r)| match filter {
            RouteFilter::All => true,
            RouteFilter::Indonesia => r.4,
            RouteFilter::World => !r.4,
        })
        .filter_map(|(i, r)| {
            let (a, b) = (db.get(r.0)?, db.get(r.1)?);
            Some((i, (haversine(a.lat, a.lon, b.lat, b.lon) / M_PER_NM).round() as u32))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> AirportDb {
        AirportDb::embedded()
    }

    #[test]
    fn semicircular_rule_parity() {
        for brg in [0.0, 45.0, 90.0, 179.0] {
            assert_eq!((semicircular_fl(brg, 360) / 10) % 2, 1, "eastbound must be odd: {brg}");
        }
        for brg in [180.0, 270.0, 359.0] {
            assert_eq!((semicircular_fl(brg, 350) / 10) % 2, 0, "westbound must be even: {brg}");
        }
        assert_eq!(semicircular_fl(90.0, 340), 330);
        assert_eq!(semicircular_fl(270.0, 330), 320);
    }

    #[test]
    fn sfo_lax_briefing_is_sane() {
        let d = db();
        let r = compute(d.get("KSFO").unwrap(), d.get("KLAX").unwrap());
        assert!((r.distance_nm - 294.0).abs() < 8.0, "{}", r.distance_nm);
        assert!(r.can_fly && !r.same_airport);
        assert!(r.ete_minutes > 40.0 && r.ete_minutes < 80.0, "{}", r.ete_minutes);
        // track ~138° (south-east) is in the 000-179 half -> ODD level, and climb + descent fit in the route
        assert!(r.bearing_deg > 90.0 && r.bearing_deg < 180.0, "{}", r.bearing_deg);
        assert_eq!((r.planned_fl / 10) % 2, 1, "FL{}", r.planned_fl);
        assert!(r.climb_nm + r.tod_nm <= r.distance_nm * 0.9);
        assert!(r.block_fuel_kg > r.trip_fuel_kg);
    }

    #[test]
    fn long_routes_get_high_levels_and_out_of_range_is_flagged() {
        let d = db();
        let r = compute(d.get("EGLL").unwrap(), d.get("LEMD").unwrap());
        assert!(r.planned_fl >= 340, "FL{}", r.planned_fl);
        assert!(r.in_range && r.can_fly && !r.fuel_exceeds_tanks);
        // London -> New York (5 540 km) is beyond 92 % of the A320's range
        assert!(!compute(d.get("EGLL").unwrap(), d.get("KJFK").unwrap()).in_range);
        let far = compute(d.get("EGLL").unwrap(), d.get("YSSY").unwrap());
        assert!(!far.can_fly && !far.in_range);
        let same = compute(d.get("KSFO").unwrap(), d.get("KSFO").unwrap());
        assert!(same.same_airport && !same.can_fly);
    }

    #[test]
    fn tod_matches_three_degree_rule() {
        // FL360 to sea level: 36000 ft / 318 ft per NM ≈ 113 NM
        let t = tod_distance_nm(360, 0.0);
        assert!((t - 113.0).abs() < 4.0, "{t}");
    }

    #[test]
    fn wind_components_signs() {
        let (h, x) = wind_components(280.0, 20.0, 280.0);
        assert!((h - 20.0).abs() < 1e-9 && x.abs() < 1e-9);
        let (h, _) = wind_components(100.0, 20.0, 280.0);
        assert!((h + 20.0).abs() < 1e-9);
        let (h, x) = wind_components(10.0, 10.0, 280.0); // wind from 090 off the right of a 280 runway? 10 vs 280 -> -270 = +90
        assert!(h.abs() < 1e-6 && (x - 10.0).abs() < 1e-6);
    }

    #[test]
    fn regions_classify_known_airports() {
        let d = db();
        let r = |c: &str| region_of(d.get(c).unwrap());
        assert_eq!(r("KSFO"), Region::Americas);
        assert_eq!(r("EGLL"), Region::Europe);
        assert_eq!(r("OMDB"), Region::MiddleEast);
        assert_eq!(r("YSSY"), Region::AsiaPacific);
        assert_eq!(r("WIII"), Region::Indonesia);
        assert_eq!(r("FACT"), Region::Africa);
    }

    #[test]
    fn curated_routes_resolve() {
        let d = db();
        let all = curated_routes(&d, RouteFilter::All);
        assert!(all.len() >= 12, "{}", all.len());
        assert!(curated_routes(&d, RouteFilter::Indonesia).len() < all.len());
    }

    #[test]
    fn ete_format() {
        assert_eq!(fmt_ete(47.2), "47m");
        assert_eq!(fmt_ete(125.0), "2h 05m");
    }
}
