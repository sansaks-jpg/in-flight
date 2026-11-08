//! Real-time UTC clock and solar position (NOAA general solar position equations).
//! In-Flight runs 1:1 with the real world clock: sky colour, stars and night lighting follow the true sun position at
//! the aircraft's actual position (no manual time-of-day).

use std::time::{SystemTime, UNIX_EPOCH};

pub fn unix_now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// (year, month 1-12, day 1-31) from days since the Unix epoch (Hinnant's civil_from_days).
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn day_of_year(unix: f64) -> (f64, i64) {
    let days = (unix / 86400.0).floor() as i64;
    let (y, _, _) = civil_from_days(days);
    let (jan1, _) = (days_from_civil(y, 1, 1), 0);
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    ((days - jan1 + 1) as f64, if leap { 366 } else { 365 })
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Solar (elevation °, azimuth ° from true north clockwise) at a unix time and position.
pub fn sun_position(unix: f64, lat: f64, lon: f64) -> (f64, f64) {
    let (doy, ndays) = day_of_year(unix);
    let hour = (unix.rem_euclid(86400.0)) / 3600.0;
    let g = 2.0 * std::f64::consts::PI / ndays as f64 * (doy - 1.0 + (hour - 12.0) / 24.0);
    let eqtime = 229.18 * (0.000075 + 0.001868 * g.cos() - 0.032077 * g.sin() - 0.014615 * (2.0 * g).cos() - 0.040849 * (2.0 * g).sin());
    let decl = 0.006918 - 0.399912 * g.cos() + 0.070257 * g.sin() - 0.006758 * (2.0 * g).cos() + 0.000907 * (2.0 * g).sin()
        - 0.002697 * (3.0 * g).cos()
        + 0.00148 * (3.0 * g).sin();
    let tst = hour * 60.0 + eqtime + 4.0 * lon;
    let ha = (tst / 4.0 - 180.0).to_radians();
    let phi = lat.to_radians();
    let cosz = (phi.sin() * decl.sin() + phi.cos() * decl.cos() * ha.cos()).clamp(-1.0, 1.0);
    let elev = 90.0 - cosz.acos().to_degrees();
    let az = ha.sin().atan2(ha.cos() * phi.sin() - decl.tan() * phi.cos()).to_degrees() + 180.0;
    (elev, az.rem_euclid(360.0))
}

/// "HH:MM" UTC.
pub fn hhmm(unix: f64) -> (u32, u32) {
    let s = unix.rem_euclid(86400.0) as u32;
    (s / 3600, (s / 60) % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2024-03-20 12:00:00 UTC = 1710936000 (equinox)
    const EQUINOX_NOON: f64 = 1_710_936_000.0;

    #[test]
    fn civil_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_802), (2024, 3, 20));
        assert_eq!(days_from_civil(2024, 3, 20), 19_802);
    }

    #[test]
    fn sun_high_at_equator_noon_and_down_at_midnight() {
        let (e, _) = sun_position(EQUINOX_NOON, 0.0, 0.0);
        assert!(e > 85.0, "{e}");
        let (e, _) = sun_position(EQUINOX_NOON + 12.0 * 3600.0, 0.0, 0.0);
        assert!(e < -85.0, "{e}");
    }

    #[test]
    fn london_summer_solstice_noon() {
        // 2024-06-20 12:00 UTC = 1718884800 ; expected elevation ~ 90 - 51.5 + 23.4 = 61.9
        let (e, az) = sun_position(1_718_884_800.0, 51.5, -0.12);
        assert!((e - 61.9).abs() < 1.5, "{e}");
        assert!((az - 180.0).abs() < 8.0, "{az}");
    }

    #[test]
    fn sun_rises_in_the_east() {
        // equinox 06:00 local at lon 0 -> sun due east, near the horizon
        let (e, az) = sun_position(EQUINOX_NOON - 6.0 * 3600.0, 0.0, 0.0);
        assert!(e.abs() < 3.0 && (az - 90.0).abs() < 5.0, "{e} {az}");
    }
}
