//! Geodesy + Web-Mercator helpers (port of `src/sim/geo.ts`).
//!
//! World frame: +X east, +Y up (MSL metres), -Z north. The scale factor `k = cos(lat0)` makes world units ~true metres
//! near the projection origin, exactly like the original TypeScript `Projection`.

pub const D2R: f64 = std::f64::consts::PI / 180.0;
pub const R2D: f64 = 180.0 / std::f64::consts::PI;
pub const R_MERC: f64 = 6_378_137.0;
pub const R_EARTH: f64 = 6_371_008.8;
pub const FT: f64 = 0.3048;
pub const KT: f64 = 0.514444;
pub const G: f64 = 9.80665;

#[inline]
pub fn clamp(v: f64, a: f64, b: f64) -> f64 {
    if v < a {
        a
    } else if v > b {
        b
    } else {
        v
    }
}
#[inline]
pub fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}
#[inline]
pub fn smoothstep(a: f64, b: f64, x: f64) -> f64 {
    let t = clamp((x - a) / (b - a), 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
#[inline]
pub fn wrap360(a: f64) -> f64 {
    ((a % 360.0) + 360.0) % 360.0
}
#[inline]
pub fn wrap180(a: f64) -> f64 {
    ((a + 540.0) % 360.0 + 360.0) % 360.0 - 180.0
}

pub fn merc_x(lon: f64) -> f64 {
    R_MERC * lon * D2R
}
pub fn merc_y(lat: f64) -> f64 {
    R_MERC * (std::f64::consts::FRAC_PI_4 + (clamp(lat, -85.05, 85.05) * D2R) / 2.0).tan().ln()
}
pub fn inv_merc_x(x: f64) -> f64 {
    (x / R_MERC) * R2D
}
pub fn inv_merc_y(y: f64) -> f64 {
    (2.0 * (y / R_MERC).exp().atan() - std::f64::consts::FRAC_PI_2) * R2D
}

/// Single lat/lon <-> world-metres mapping used by terrain, runways and the aircraft.
#[derive(Clone, Copy, Debug)]
pub struct Projection {
    pub lat0: f64,
    pub lon0: f64,
    pub k: f64,
    ox: f64,
    oy: f64,
}

impl Projection {
    pub fn new(lat0: f64, lon0: f64) -> Self {
        Self { lat0, lon0, k: (lat0 * D2R).cos(), ox: merc_x(lon0), oy: merc_y(lat0) }
    }
    #[inline]
    pub fn x(&self, lon: f64) -> f64 {
        (merc_x(lon) - self.ox) * self.k
    }
    #[inline]
    pub fn z(&self, lat: f64) -> f64 {
        -(merc_y(lat) - self.oy) * self.k
    }
    #[inline]
    pub fn lon(&self, x: f64) -> f64 {
        inv_merc_x(x / self.k + self.ox)
    }
    #[inline]
    pub fn lat(&self, z: f64) -> f64 {
        inv_merc_y(-z / self.k + self.oy)
    }
}

pub fn haversine(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (p1, p2) = (lat1 * D2R, lat2 * D2R);
    let (dp, dl) = (p2 - p1, (lon2 - lon1) * D2R);
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * R_EARTH * a.sqrt().min(1.0).asin()
}

pub fn bearing(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (p1, p2, dl) = (lat1 * D2R, lat2 * D2R, (lon2 - lon1) * D2R);
    let y = dl.sin() * p2.cos();
    let x = p1.cos() * p2.sin() - p1.sin() * p2.cos() * dl.cos();
    (y.atan2(x) * R2D + 360.0) % 360.0
}

pub fn destination(lat: f64, lon: f64, hdg: f64, dist: f64) -> (f64, f64) {
    let (p1, l1, th, dl) = (lat * D2R, lon * D2R, hdg * D2R, dist / R_EARTH);
    let p2 = (p1.sin() * dl.cos() + p1.cos() * dl.sin() * th.cos()).asin();
    let l2 = l1 + (th.sin() * dl.sin() * p1.cos()).atan2(dl.cos() - p1.sin() * p2.sin());
    (p2 * R2D, ((l2 * R2D + 540.0) % 360.0) - 180.0)
}

/// Spherical cross-track distance (m, + = right of course) and along-track distance (m) of a point from the path 1->2.
pub fn cross_track(lat: f64, lon: f64, lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> (f64, f64) {
    if ![lat, lon, lat1, lon1, lat2, lon2].iter().all(|v| v.is_finite()) {
        return (0.0, 0.0);
    }
    if haversine(lat1, lon1, lat2, lon2) < 10.0 {
        return (0.0, 0.0);
    }
    let d13 = haversine(lat1, lon1, lat, lon) / R_EARTH;
    let th13 = bearing(lat1, lon1, lat, lon) * D2R;
    let th12 = bearing(lat1, lon1, lat2, lon2) * D2R;
    let xt_ang = clamp(d13.sin() * (th13 - th12).sin(), -1.0, 1.0).asin();
    let cos_xt = xt_ang.cos();
    let at_ang = if cos_xt.abs() > 1e-6 { clamp(d13.cos() / cos_xt, -1.0, 1.0).acos() } else { 0.0 };
    let fwd = (th13 - th12).cos() >= 0.0;
    (xt_ang * R_EARTH, if fwd { at_ang * R_EARTH } else { -at_ang * R_EARTH })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WpType {
    Takeoff,
    Climb,
    Cruise,
    Tod,
    Iaf,
    Faf,
    Touchdown,
    Rollout,
}

#[derive(Clone, Debug)]
pub struct Waypoint {
    pub name: String,
    pub kind: WpType,
    pub lat: f64,
    pub lon: f64,
    pub alt_m: f64,
    pub speed_kt: f64,
    pub hdg: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_roundtrip() {
        let p = Projection::new(37.62, -122.37);
        for (la, lo) in [(37.7, -122.2), (38.5, -121.0), (36.0, -123.5)] {
            let (x, z) = (p.x(lo), p.z(la));
            assert!((p.lat(z) - la).abs() < 1e-9 && (p.lon(x) - lo).abs() < 1e-9);
        }
    }

    #[test]
    fn world_units_are_metres_near_origin() {
        let p = Projection::new(37.62, -122.37);
        // 0.01 deg of latitude ~ 1111 m
        let dz = p.z(37.63) - p.z(37.62);
        assert!((dz.abs() - 1111.9).abs() < 6.0, "dz={dz}");
        // north is -Z
        assert!(dz < 0.0);
    }

    #[test]
    fn known_distances() {
        // SFO -> LAX ~ 543 km
        let d = haversine(37.61981, -122.37482, 33.9425, -118.408);
        assert!((d / 1000.0 - 543.0).abs() < 6.0, "{d}");
        let b = bearing(37.61981, -122.37482, 33.9425, -118.408);
        assert!((b - 138.0).abs() < 3.0, "{b}");
        let (la, lo) = destination(37.0, -122.0, 90.0, 10_000.0);
        assert!((haversine(37.0, -122.0, la, lo) - 10_000.0).abs() < 1.0);
    }

    #[test]
    fn wraps() {
        assert_eq!(wrap360(-10.0), 350.0);
        assert_eq!(wrap180(190.0), -170.0);
        assert_eq!(wrap180(-190.0), 170.0);
        assert_eq!(wrap180(0.0), 0.0);
    }

    #[test]
    fn cross_track_sign() {
        // path due east along lat 0; a point to the south is on the right of an eastbound course.
        let (xt, at) = cross_track(-0.01, 0.05, 0.0, 0.0, 0.0, 0.1);
        assert!(xt > 0.0 && at > 0.0, "{xt} {at}");
    }
}
