//! Sky / light model driven by the real sun (NOAA ephemeris in `clock.rs`): twilight phases, Rayleigh + aerosol
//! extinction of the direct sun light through the air mass, overcast desaturation and moon-phase night ambient.
//!
//! Pure, allocation-free and GPU independent - the renderer only uploads the resulting colours (`gfx::Renderer::render`).
//! Reference: `src/sim/clock.ts` (sun state) and the sky gradient of the web renderer.

use glam::Vec3;

/// Civil / nautical / astronomical twilight bands (sun centre elevation, degrees).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Phase {
    Night,
    Astronomical,
    Nautical,
    Civil,
    Golden,
    Day,
}

impl Phase {
    pub fn of(el_deg: f64) -> Phase {
        if el_deg >= 6.0 {
            Phase::Day
        } else if el_deg >= -0.833 {
            Phase::Golden
        } else if el_deg >= -6.0 {
            Phase::Civil
        } else if el_deg >= -12.0 {
            Phase::Nautical
        } else if el_deg >= -18.0 {
            Phase::Astronomical
        } else {
            Phase::Night
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Phase::Night => "NIGHT",
            Phase::Astronomical => "ASTRO TWILIGHT",
            Phase::Nautical => "NAUTICAL TWILIGHT",
            Phase::Civil => "CIVIL TWILIGHT",
            Phase::Golden => "SUNRISE/SUNSET",
            Phase::Day => "DAY",
        }
    }
}

pub struct SkyColors {
    pub zenith: Vec3,
    pub horizon: Vec3,
    pub sun_light: Vec3,
    pub ambient: Vec3,
    /// 0 = full day .. 1 = full night (stars, city lights, runway light intensity)
    pub night: f32,
}

#[inline]
fn sstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Relative optical air mass along the sun ray (Kasten & Young 1989), clamped near the horizon.
pub fn air_mass(el_deg: f32) -> f32 {
    let e = el_deg.max(-1.0);
    let m = 1.0 / (e.to_radians().sin().max(0.0) + 0.50572 * (e + 6.07995).powf(-1.6364));
    m.clamp(1.0, 18.0)
}

/// Direct sun colour after Rayleigh + aerosol extinction, normalised so the zenith sun is white-ish.
pub fn sun_transmittance(el_deg: f32) -> Vec3 {
    let tau = Vec3::new(0.065, 0.105, 0.19);
    let m = air_mass(el_deg);
    Vec3::new((-m * tau.x).exp(), (-m * tau.y).exp(), (-m * tau.z).exp()) / Vec3::new((-tau.x).exp(), (-tau.y).exp(), (-tau.z).exp())
}

/// Moon illumination 0..1 from the synodic phase (reference new moon 2000-01-06 18:14 UTC).
pub fn moon_illumination(unix: f64) -> f64 {
    let synodic = 29.530_588_853 * 86400.0;
    let phase = ((unix - 947_182_440.0) / synodic).rem_euclid(1.0);
    0.5 * (1.0 - (std::f64::consts::TAU * phase).cos())
}

/// Sky / light colours from the real sun elevation (degrees), `overcast` 0..1 (cloud cover) and moon illumination.
pub fn sky_colors_ex(el: f32, overcast: f32, moon: f32) -> SkyColors {
    let day = sstep(-6.0, 10.0, el);
    let twi = (1.0 - ((el - 1.0).abs() / 9.0).min(1.0)) * sstep(-8.0, 0.0, el);
    // deep-blue night sky lifted slightly by the moon
    let night_sky = Vec3::new(0.008, 0.012, 0.035) * (1.0 + moon * 1.6);
    let mut zenith = night_sky.lerp(Vec3::new(0.14, 0.32, 0.72), day);
    let night_hor = Vec3::new(0.025, 0.035, 0.065) * (1.0 + moon * 1.4);
    let mut horizon = night_hor.lerp(Vec3::new(0.62, 0.76, 0.92), day);
    // twilight arch: orange glow at the horizon, purple tint in the upper sky
    horizon = horizon.lerp(Vec3::new(1.0, 0.52, 0.28) * 0.85, twi * 0.65);
    zenith = zenith.lerp(Vec3::new(0.20, 0.17, 0.42), twi * 0.25);
    let tr = sun_transmittance(el);
    let sun_i = sstep(-3.0, 8.0, el) * 1.15 + 0.02;
    let mut sun_light = tr * sun_i;
    let mut ambient = (horizon * 0.5 + zenith * 0.35) * (0.35 + 0.65 * day) + Vec3::splat(0.012 + 0.02 * moon * (1.0 - day));
    // overcast: grey sky, weaker direct light, brighter diffuse
    let oc = overcast.clamp(0.0, 1.0);
    let k = sstep(0.55, 1.0, oc);
    let grey = |c: Vec3, l: f32| Vec3::splat(c.dot(Vec3::new(0.3, 0.55, 0.15)) * l);
    zenith = zenith.lerp(grey(zenith, 1.15), k * 0.7);
    horizon = horizon.lerp(grey(horizon, 1.05), k * 0.6);
    sun_light *= 1.0 - 0.75 * k;
    ambient = ambient.lerp(grey(ambient, 1.18), k * 0.6);
    SkyColors { zenith, horizon, sun_light, ambient, night: 1.0 - sstep(-10.0, 0.0, el) }
}

/// Clear-sky colours (kept for the menu / tests).
pub fn sky_colors(el: f32) -> SkyColors {
    sky_colors_ex(el, 0.0, 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phases_follow_sun_elevation() {
        assert_eq!(Phase::of(45.0), Phase::Day);
        assert_eq!(Phase::of(2.0), Phase::Golden);
        assert_eq!(Phase::of(-3.0), Phase::Civil);
        assert_eq!(Phase::of(-9.0), Phase::Nautical);
        assert_eq!(Phase::of(-15.0), Phase::Astronomical);
        assert_eq!(Phase::of(-40.0), Phase::Night);
        assert!(Phase::Day > Phase::Night);
    }

    #[test]
    fn low_sun_is_redder_than_high_sun() {
        let hi = sun_transmittance(60.0);
        let lo = sun_transmittance(2.0);
        assert!(hi.z / hi.x > 0.75, "zenith sun roughly white {hi:?}");
        assert!(lo.z / lo.x < 0.45, "setting sun red {lo:?}");
        assert!(air_mass(90.0) < 1.05 && air_mass(0.0) > 10.0);
    }

    #[test]
    fn light_and_night_factor_are_monotonic() {
        let mut prev_night = 2.0;
        let mut prev_i = -1.0;
        let mut el = -20.0;
        while el <= 30.0 {
            let c = sky_colors(el);
            assert!(c.night <= prev_night + 1e-6, "night factor must decrease with elevation");
            let i = c.sun_light.length();
            assert!(i >= prev_i - 0.05, "sun light must brighten with elevation at {el}: {i} < {prev_i}");
            assert!(c.zenith.is_finite() && c.ambient.is_finite());
            prev_night = c.night;
            prev_i = i;
            el += 0.5;
        }
        assert!(sky_colors(-30.0).night > 0.99 && sky_colors(20.0).night < 0.01);
    }

    #[test]
    fn overcast_dims_the_sun_and_desaturates() {
        let clear = sky_colors_ex(40.0, 0.0, 0.0);
        let dull = sky_colors_ex(40.0, 1.0, 0.0);
        assert!(dull.sun_light.length() < clear.sun_light.length() * 0.5);
        let sat = |c: Vec3| (c.max_element() - c.min_element()) / c.max_element();
        assert!(sat(dull.zenith) < sat(clear.zenith));
    }

    #[test]
    fn moon_phase_is_a_cycle() {
        let new_moon = 947_182_440.0;
        assert!(moon_illumination(new_moon) < 0.02);
        assert!(moon_illumination(new_moon + 14.765 * 86400.0) > 0.98);
        // 2024-06-22 ~ full moon (strawberry moon, 01:08 UTC June 22)
        assert!(moon_illumination(1_719_018_000.0) > 0.95);
    }
}
