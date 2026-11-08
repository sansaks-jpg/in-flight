//! Volumetric cloud layers (reference: `src/sim/volumetricClouds.ts`, `src/sim/cloudLayers.ts`, `src/sim/clouds.ts`).
//!
//! Two slabs: a cumulus / stratocumulus deck at the METAR cloud base and a thin cirrus sheet near FL280. The GPU
//! ray-marches the density field in `gfx/clouds.wgsl`; this module holds the layer description derived from the
//! [`Weather`] and a **bit-compatible CPU mirror** of the density function (same integer hash, same fBm, same height
//! profile) so the simulation can answer "am I inside a cloud?" (visibility, fog colour, turbulence) and tests can
//! verify coverage without a GPU.

use crate::weather::Weather;
use glam::DVec3;

/// Noise frequency (1/m) per layer - mirrored in `clouds.wgsl`.
pub const FREQ: [f32; 2] = [1.0 / 2600.0, 1.0 / 7000.0];

#[derive(Clone, Copy, Debug, Default)]
pub struct Layer {
    /// m MSL
    pub base: f32,
    pub top: f32,
    /// 0 = absent .. 1 = overcast
    pub cover: f32,
    /// extinction coefficient (1/m) at density 1
    pub sigma: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Clouds {
    pub layers: [Layer; 2],
}

impl Clouds {
    pub fn from_weather(w: &Weather) -> Self {
        let cover = w.cloud_cover as f32;
        let base = w.cloud_base_m as f32;
        let low = Layer { base, top: base + 450.0 + 900.0 * cover, cover: if cover < 0.04 { 0.0 } else { cover }, sigma: 0.011 };
        let cb = 8200.0 + (w.cloud_base_m as f32 * 0.17).min(500.0);
        let high = Layer { base: cb, top: cb + 650.0, cover: if w.cirrus < 0.05 { 0.0 } else { w.cirrus as f32 }, sigma: 0.0016 };
        Self { layers: [low, high] }
    }
}

// ---------------------------------------------------------------- noise (mirror of clouds.wgsl)

#[inline]
fn hash3(ix: i32, iy: i32, iz: i32) -> f32 {
    let mut h = (ix as u32).wrapping_mul(0x27d4_eb2d) ^ (iy as u32).wrapping_mul(0x1656_67b1) ^ (iz as u32).wrapping_mul(0x9e37_79b9);
    h ^= h >> 15;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    (h >> 8) as f32 / 16_777_216.0
}

#[inline]
fn vnoise3(x: f32, y: f32, z: f32) -> f32 {
    let (fx, fy, fz) = (x.floor(), y.floor(), z.floor());
    let (ix, iy, iz) = (fx as i32, fy as i32, fz as i32);
    let (tx, ty, tz) = (x - fx, y - fy, z - fz);
    let (ux, uy, uz) = (tx * tx * (3.0 - 2.0 * tx), ty * ty * (3.0 - 2.0 * ty), tz * tz * (3.0 - 2.0 * tz));
    let l = |a: f32, b: f32, t: f32| a + (b - a) * t;
    let c = |dx: i32, dy: i32, dz: i32| hash3(ix + dx, iy + dy, iz + dz);
    let x00 = l(c(0, 0, 0), c(1, 0, 0), ux);
    let x10 = l(c(0, 1, 0), c(1, 1, 0), ux);
    let x01 = l(c(0, 0, 1), c(1, 0, 1), ux);
    let x11 = l(c(0, 1, 1), c(1, 1, 1), ux);
    l(l(x00, x10, uy), l(x01, x11, uy), uz)
}

#[inline]
pub fn fbm3(mut x: f32, mut y: f32, mut z: f32, oct: u32) -> f32 {
    let (mut sum, mut amp, mut norm) = (0.0, 0.5, 0.0);
    for _ in 0..oct {
        sum += vnoise3(x, y, z) * amp;
        norm += amp;
        amp *= 0.5;
        x = x * 2.02 + 17.1;
        y = y * 2.02 + 9.3;
        z = z * 2.02 + 5.7;
    }
    sum / norm
}

#[inline]
fn sstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Density 0..1 of layer `idx` at world position (x, y, z); `off` = accumulated wind drift of the pattern (m).
/// The WGSL march uses 3 octaves for the bulk and a 4th for the edge erosion - the CPU mirror evaluates the same 4.
pub fn density(l: &Layer, idx: usize, x: f32, y: f32, z: f32, off: (f32, f32)) -> f32 {
    if l.cover <= 0.0 || y < l.base || y > l.top {
        return 0.0;
    }
    let hn = (y - l.base) / (l.top - l.base);
    let profile = sstep(0.0, 0.14, hn) * (1.0 - sstep(0.55, 1.0, hn));
    let f = FREQ[idx];
    let n = fbm3((x - off.0) * f, y * f, (z - off.1) * f, 4);
    let thr = 0.62 - 0.30 * l.cover;
    ((n - thr) * 4.0).clamp(0.0, 1.0) * profile
}

impl Clouds {
    /// Density of the thickest layer at a point (0 = clear air, ~1 = in the cloud core).
    pub fn at(&self, p: DVec3, off: (f32, f32)) -> f32 {
        let mut d = 0.0f32;
        for (i, l) in self.layers.iter().enumerate() {
            d = d.max(density(l, i, p.x as f32, p.y as f32, p.z as f32, off));
        }
        d
    }

    /// Optical depth of a vertical column through layer `idx` sampled at `n` points (used by tests / planners).
    pub fn column_tau(&self, idx: usize, x: f32, z: f32, off: (f32, f32), n: usize) -> f32 {
        let l = &self.layers[idx];
        let dy = (l.top - l.base) / n as f32;
        (0..n).map(|k| density(l, idx, x, l.base + (k as f32 + 0.5) * dy, z, off)).sum::<f32>() * dy * l.sigma
    }
}

/// Pattern drift (m) after `t` seconds: the clouds move with the wind at cloud height.
pub fn drift(w: &Weather, t: f64) -> (f32, f32) {
    let v = w.wind_vec(w.cloud_base_m);
    ((v.x * t) as f32, (v.z * t) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer(cover: f32) -> Layer {
        Layer { base: 1500.0, top: 2500.0, cover, sigma: 0.011 }
    }

    #[test]
    fn density_is_bounded_zero_outside_the_slab_and_deterministic() {
        let l = layer(0.7);
        for i in 0..4000 {
            let (x, z) = (i as f32 * 137.3 - 200_000.0, i as f32 * -91.7 + 80_000.0);
            let y = 1500.0 + (i % 100) as f32 * 10.0;
            let d = density(&l, 0, x, y, z, (10.0, 20.0));
            assert!((0.0..=1.0).contains(&d));
            assert_eq!(d, density(&l, 0, x, y, z, (10.0, 20.0)));
            assert_eq!(density(&l, 0, x, 1400.0, z, (0.0, 0.0)), 0.0);
            assert_eq!(density(&l, 0, x, 2600.0, z, (0.0, 0.0)), 0.0);
        }
    }

    #[test]
    fn coverage_grows_with_the_cover_parameter() {
        let frac = |c: f32| {
            let l = layer(c);
            let mut n = 0;
            let total = 6000;
            for i in 0..total {
                let (x, z) = ((i % 100) as f32 * 700.0, (i / 100) as f32 * 700.0);
                if column_hit(&l, x, z) {
                    n += 1;
                }
            }
            n as f32 / total as f32
        };
        let (a, b, c, d) = (frac(0.0), frac(0.3), frac(0.6), frac(1.0));
        assert_eq!(a, 0.0);
        assert!(b > 0.02 && b < c && c < d, "{a} {b} {c} {d}");
        assert!(d > 0.85, "overcast must be nearly closed: {d}");
    }

    fn column_hit(l: &Layer, x: f32, z: f32) -> bool {
        (0..8).any(|k| density(l, 0, x, l.base + (k as f32 + 0.5) * 125.0, z, (0.0, 0.0)) > 0.05)
    }

    #[test]
    fn wind_drift_translates_the_pattern() {
        let l = layer(0.7);
        let (x, y, z) = (12_345.0, 1900.0, -6_789.0);
        let a = density(&l, 0, x, y, z, (0.0, 0.0));
        let b = density(&l, 0, x + 500.0, y, z + 250.0, (500.0, 250.0));
        assert!((a - b).abs() < 1e-3, "{a} vs {b}");
    }

    #[test]
    fn layers_follow_the_weather() {
        let w = Weather { cloud_base_m: 2100.0, cloud_cover: 0.8, cirrus: 0.5, ..Weather::calm() };
        let c = Clouds::from_weather(&w);
        assert_eq!(c.layers[0].base, 2100.0);
        assert!(c.layers[0].top > c.layers[0].base + 900.0 && c.layers[1].base > 8000.0);
        let clear = Clouds::from_weather(&Weather { cloud_cover: 0.0, cirrus: 0.0, ..Weather::calm() });
        assert_eq!(clear.at(DVec3::new(0.0, 2500.0, 0.0), (0.0, 0.0)), 0.0);
        // an overcast column is optically thick, a clear one is transparent
        let thick = Clouds::from_weather(&Weather { cloud_cover: 1.0, ..Weather::calm() });
        assert!(thick.column_tau(0, 100.0, 100.0, (0.0, 0.0), 24) > 3.0);
    }
}
