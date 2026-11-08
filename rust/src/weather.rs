//! Deterministic weather: wind profile, turbulence, pressure and temperature deviation. The original fetches live METAR /
//! Open-Meteo data; the native port derives a stable weather state from a seed (date + airport) so every run is
//! reproducible and the physics tests are deterministic.

use crate::geo::{clamp, KT};
use glam::DVec3;

#[derive(Clone, Copy, Debug)]
pub struct Weather {
    pub wind_from_deg: f64,
    pub wind_kt: f64,
    pub gust_kt: f64,
    pub d_t: f64,
    pub qnh: f64,
    pub turb: f64,
    pub vis_km: f64,
    pub cloud_base_m: f64,
    pub cloud_cover: f64,
    /// precipitation intensity 0 (dry) .. 1 (downpour); only falls out of a broken / overcast deck
    pub precip: f64,
    /// precipitation falls as snow (cold air mass)
    pub snow: bool,
    /// embedded convection: lightning flashes (needs heavy rain)
    pub thunder: bool,
    /// high cirrus / cirrostratus coverage 0..1 (layer near FL280)
    pub cirrus: f64,
}

fn hash01(seed: u64, k: u64) -> f64 {
    let mut x = seed.wrapping_add(k.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    x ^= x >> 30;
    x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x ^= x >> 27;
    x = x.wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^= x >> 31;
    (x >> 11) as f64 / (1u64 << 53) as f64
}

impl Weather {
    pub fn generate(seed: u64) -> Self {
        let r = |k| hash01(seed, k);
        let cover = r(9);
        // rain needs a thick deck; the roll keeps ~1 day in 3 wet so the effect shows up regularly
        let wet = if cover > 0.55 && r(10) > 0.45 { r(11) * ((cover - 0.55) / 0.45).min(1.0) } else { 0.0 };
        let precip = if wet > 0.08 { wet } else { 0.0 };
        let d_t = (r(4) - 0.5) * 16.0;
        Self {
            wind_from_deg: (r(1) * 360.0).floor(),
            wind_kt: 3.0 + r(2) * 14.0,
            gust_kt: r(3) * 8.0,
            d_t,
            qnh: 1013.25 + (r(5) - 0.5) * 36.0,
            turb: r(6) * 0.5,
            vis_km: (6.0 + r(7) * 24.0) * (1.0 - 0.65 * precip),
            cloud_base_m: 1200.0 + r(8) * 2200.0,
            cloud_cover: cover,
            precip,
            snow: precip > 0.0 && d_t < -5.0 && r(12) > 0.35,
            thunder: precip > 0.55 && r(13) > 0.4 && d_t > -3.0,
            cirrus: r(14) * 0.85,
        }
    }

    pub fn calm() -> Self {
        Self { wind_from_deg: 0.0, wind_kt: 0.0, gust_kt: 0.0, d_t: 0.0, qnh: 1013.25, turb: 0.0, vis_km: 30.0, cloud_base_m: 3000.0, cloud_cover: 0.2, precip: 0.0, snow: false, thunder: false, cirrus: 0.15 }
    }

    /// Steady wind vector (m/s, world frame: +X east, -Z north; direction the air moves TO) at altitude.
    pub fn wind_vec(&self, agl: f64) -> DVec3 {
        let spd = self.wind_kt * KT * (1.0 + clamp(agl, 0.0, 3000.0) / 1500.0).min(2.6);
        let to = (self.wind_from_deg + 180.0).to_radians();
        DVec3::new(to.sin() * spd, 0.0, -to.cos() * spd)
    }

    /// Smooth turbulence / gust vector (m/s) - sums of incommensurate sines, no state, no allocation.
    pub fn gust_vec(&self, t: f64, agl: f64) -> DVec3 {
        let low = (-agl / 400.0).exp();
        let amp = (self.gust_kt * KT * 0.5 * low + self.turb * 2.2 * (0.4 + 0.6 * (agl / 2000.0).clamp(0.0, 1.0))).max(0.0);
        let s = |f: f64, p: f64| (t * f + p).sin();
        DVec3::new(
            amp * (0.6 * s(0.31, 0.0) + 0.3 * s(0.97, 1.3) + 0.1 * s(2.3, 2.1)),
            amp * 0.6 * (0.6 * s(0.43, 4.0) + 0.3 * s(1.31, 0.7) + 0.1 * s(3.1, 5.2)),
            amp * (0.6 * s(0.27, 2.2) + 0.3 * s(1.13, 3.4) + 0.1 * s(2.7, 0.4)),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deterministic_and_in_range() {
        for seed in 0..500u64 {
            let w = Weather::generate(seed);
            assert_eq!(w.wind_from_deg, Weather::generate(seed).wind_from_deg);
            assert!(w.wind_kt >= 3.0 && w.wind_kt <= 17.0 && w.qnh > 990.0 && w.qnh < 1040.0);
            assert!(w.cloud_cover >= 0.0 && w.cloud_cover <= 1.0);
            assert!((0.0..=1.0).contains(&w.precip) && (w.precip == 0.0 || w.cloud_cover > 0.55), "rain needs a thick deck");
            assert!(!w.thunder || w.precip > 0.5);
            assert!(w.vis_km > 2.0);
        }
    }
    #[test]
    fn wind_direction_convention() {
        let w = Weather { wind_from_deg: 270.0, wind_kt: 10.0, ..Weather::calm() };
        let v = w.wind_vec(0.0);
        assert!(v.x > 4.0 && v.z.abs() < 0.1, "westerly wind blows towards the east: {v:?}");
        let n = Weather { wind_from_deg: 0.0, wind_kt: 10.0, ..Weather::calm() };
        assert!(n.wind_vec(0.0).z > 4.0, "northerly wind blows towards the south (+Z)");
    }
    #[test]
    fn gusts_are_bounded() {
        let w = Weather { gust_kt: 20.0, turb: 0.5, ..Weather::calm() };
        let mut m: f64 = 0.0;
        for i in 0..20000 {
            m = m.max(w.gust_vec(i as f64 * 0.05, 0.0).length());
        }
        assert!(m < 15.0 && m > 0.1, "{m}");
    }
}
