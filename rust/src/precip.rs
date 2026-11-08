//! Dynamic precipitation + lightning state derived from the deterministic [`Weather`] (reference: `src/sim/precip.ts`,
//! `src/sim/lightning.ts`, `src/sim/weather.ts`).
//!
//! * rain / snow only falls **below the cloud base** (the camera fades it out as it climbs through the deck),
//! * lightning is a stateless function of time: every 6.5 s slot rolls whether a stroke happens, so the flash train is
//!   reproducible, needs no allocation and can be sampled by both the renderer and the tests,
//! * the GPU side lives in `gfx/precip.wgsl` (instanced streaks wrapped around the camera).

use crate::weather::Weather;

#[derive(Clone, Copy, Debug, Default)]
pub struct PrecipState {
    /// 0..1 precipitation seen from the camera (already faded by the cloud base)
    pub intensity: f32,
    pub snow: bool,
    /// 0..1 lightning illumination of the sky / clouds this instant
    pub flash: f32,
    /// azimuth (rad, world frame) of the last stroke - drives the directional sky glow
    pub bolt_az: f32,
    /// extra extinction (1/m) added to the fog by rain: visibility drops as the downpour gets heavier
    pub extinction: f32,
    /// runway wetness 0..1 (feeds `FlightModel::wetness` => longer braking distances)
    pub wet: f32,
}

#[inline]
fn hash(k: i64, salt: u64) -> f64 {
    let mut x = (k as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ salt.wrapping_mul(0xD6E8_FEB8_6659_FD93);
    x ^= x >> 32;
    x = x.wrapping_mul(0xD6E8_FEB8_6659_FD93);
    x ^= x >> 32;
    (x >> 11) as f64 / (1u64 << 53) as f64
}

const SLOT: f64 = 6.5;

/// Lightning illumination 0..1 and stroke azimuth (rad) at time `t` (seconds). A stroke is a bright leader flash
/// followed by a weaker re-strike ~0.2 s later.
pub fn lightning(w: &Weather, t: f64) -> (f32, f32) {
    if !w.thunder {
        return (0.0, 0.0);
    }
    let slot = (t / SLOT).floor() as i64;
    let mut best = 0.0f64;
    let mut az = 0.0f64;
    // look at the current and previous slot so a stroke that started late in a slot can finish
    for k in [slot - 1, slot] {
        if hash(k, 1) > 0.45 * (0.35 + 0.65 * w.precip) {
            continue;
        }
        let dt = t - (k as f64 * SLOT + hash(k, 2) * (SLOT - 1.2));
        if !(0.0..1.4).contains(&dt) {
            continue;
        }
        let f = (-dt * 11.0).exp() + 0.65 * (-(dt - 0.2).abs() * 16.0).exp() * (dt > 0.1) as i32 as f64;
        if f > best {
            best = f;
            az = hash(k, 3) * std::f64::consts::TAU;
        }
    }
    (best.min(1.0) as f32, az as f32)
}

/// Fade factor for precipitation seen from altitude `cam_y` (m MSL): full below the deck, gone 300 m above its base.
pub fn below_cloud_factor(w: &Weather, cam_y: f64) -> f32 {
    let t = ((cam_y - (w.cloud_base_m - 150.0)) / 450.0).clamp(0.0, 1.0);
    1.0 - (t * t * (3.0 - 2.0 * t)) as f32
}

pub fn state(w: &Weather, t: f64, cam_y: f64) -> PrecipState {
    let (flash, bolt_az) = lightning(w, t);
    if w.precip <= 0.0 {
        return PrecipState::default();
    }
    let f = below_cloud_factor(w, cam_y);
    let intensity = (w.precip as f32 * f).clamp(0.0, 1.0);
    PrecipState {
        intensity,
        snow: w.snow,
        flash: flash * (0.35 + 0.65 * f),
        bolt_az,
        // ~ Koschmieder: 3.0 / V, rain at full intensity brings the 2-4 km visibility down to ~1.5 km locally
        extinction: intensity * if w.snow { 0.00055 } else { 0.00035 },
        wet: if w.snow { 0.5 * w.precip as f32 } else { (w.precip as f32 * 1.2).min(1.0) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stormy() -> Weather {
        Weather { precip: 0.9, thunder: true, cloud_cover: 1.0, ..Weather::calm() }
    }

    #[test]
    fn dry_weather_has_no_precip_or_flash() {
        let s = state(&Weather::calm(), 100.0, 100.0);
        assert_eq!(s.intensity, 0.0);
        assert_eq!(s.flash, 0.0);
        assert_eq!(lightning(&Weather::calm(), 12.3).0, 0.0);
    }

    #[test]
    fn rain_fades_out_above_the_cloud_base() {
        let w = Weather { precip: 0.8, cloud_base_m: 1500.0, ..Weather::calm() };
        let low = state(&w, 0.0, 200.0).intensity;
        let mid = state(&w, 0.0, 1500.0).intensity;
        let high = state(&w, 0.0, 2500.0).intensity;
        assert!(low > 0.79 && mid < low && mid > high && high < 1e-6, "{low} {mid} {high}");
    }

    #[test]
    fn lightning_is_bounded_deterministic_and_actually_strikes() {
        let w = stormy();
        let mut strikes = 0;
        let mut t = 0.0;
        let mut prev = 0.0;
        while t < 600.0 {
            let (f, az) = lightning(&w, t);
            assert!((0.0..=1.0).contains(&f) && az.is_finite());
            assert_eq!(lightning(&w, t).0, f, "stateless => deterministic");
            if f > 0.5 && prev <= 0.5 {
                strikes += 1;
            }
            prev = f;
            t += 0.02;
        }
        assert!(strikes > 15 && strikes < 130, "strikes in 10 min: {strikes}");
    }

    #[test]
    fn heavy_rain_wets_the_runway_and_reduces_visibility() {
        let s = state(&stormy(), 0.0, 100.0);
        assert!(s.wet > 0.9 && s.extinction > 0.0003);
        let snow = state(&Weather { precip: 0.8, snow: true, ..Weather::calm() }, 0.0, 100.0);
        assert!(snow.snow && snow.wet < s.wet);
    }
}
