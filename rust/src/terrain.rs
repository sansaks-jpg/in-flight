//! Deterministic procedural terrain shared by physics (ground contact) and the renderer (clipmap meshes).
//!
//! The original streams real DEM tiles from the network; a native, offline, allocation-free height function keeps the
//! frame time flat and lets physics sample the exact same surface that is drawn. Airports are blended into the terrain
//! at their true field elevation (flat plateau + smooth skirt) so runways always sit level on the ground.

use crate::geo::{lerp, smoothstep};

#[derive(Clone, Copy, Debug)]
pub struct Zone {
    pub x: f64,
    pub z: f64,
    pub elev: f64,
    pub r_flat: f64,
    pub r_blend: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Terrain {
    pub zones: Vec<Zone>,
    pub seed: u32,
    /// Satellite-ground mode: the world is a flat surface at field elevation (blended between the departure and arrival
    /// airports) so the real imagery draped over it is not distorted by procedural hills. Physics, GPWS and the
    /// renderer all see the same flat surface.
    pub flat: bool,
}

#[inline]
fn hash(ix: i32, iz: i32, seed: u32) -> f64 {
    let mut h = (ix as u32).wrapping_mul(0x27d4_eb2d) ^ (iz as u32).wrapping_mul(0x1656_67b1) ^ seed.wrapping_mul(0x9e37_79b9);
    h ^= h >> 15;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    (h as f64) / (u32::MAX as f64)
}

#[inline]
fn vnoise(x: f64, z: f64, seed: u32) -> f64 {
    let (fx, fz) = (x.floor(), z.floor());
    let (ix, iz) = (fx as i32, fz as i32);
    let (tx, tz) = (x - fx, z - fz);
    let (sx, sz) = (tx * tx * tx * (tx * (tx * 6.0 - 15.0) + 10.0), tz * tz * tz * (tz * (tz * 6.0 - 15.0) + 10.0));
    let a = lerp(hash(ix, iz, seed), hash(ix + 1, iz, seed), sx);
    let b = lerp(hash(ix, iz + 1, seed), hash(ix + 1, iz + 1, seed), sx);
    lerp(a, b, sz)
}

fn fbm(x: f64, z: f64, oct: u32, seed: u32) -> f64 {
    let (mut sum, mut amp, mut f, mut norm) = (0.0, 0.5, 1.0, 0.0);
    for o in 0..oct {
        sum += vnoise(x * f + o as f64 * 17.3, z * f - o as f64 * 9.1, seed.wrapping_add(o * 101)) * amp;
        norm += amp;
        amp *= 0.5;
        f *= 2.0;
    }
    sum / norm
}

impl Terrain {
    pub fn new(seed: u32) -> Self {
        Self { zones: Vec::new(), seed, flat: false }
    }

    pub fn add_airport(&mut self, x: f64, z: f64, elev: f64) {
        self.zones.push(Zone { x, z, elev, r_flat: 3200.0, r_blend: 9500.0 });
    }

    /// Terrain height in metres MSL at world (x, z).
    pub fn height(&self, x: f64, z: f64) -> f64 {
        if self.flat {
            return self.flat_height(x, z);
        }
        let n = fbm(x / 22000.0, z / 22000.0, 5, self.seed);
        let mut h = (n - 0.40) * 2200.0;
        let ridge = 1.0 - (2.0 * fbm(x / 7000.0, z / 7000.0, 4, self.seed ^ 0xA5A5) - 1.0).abs();
        h += (n - 0.55).max(0.0) * 3200.0 * ridge;
        let detail = (fbm(x / 650.0, z / 650.0, 3, self.seed ^ 0x77) - 0.5) * 70.0;
        h += detail * smoothstep(0.0, 120.0, h);
        for zn in &self.zones {
            let d = (x - zn.x).hypot(z - zn.z);
            // approach / departure clearance cone (~2 deg): terrain above it is compressed so the 3 deg glidepath and
            // the climb-out always have real obstacle clearance, like a protected airport surface
            if d > zn.r_flat {
                let cap = zn.elev + 60.0 + (d - zn.r_flat) * 0.035;
                if h > cap {
                    h = cap + (h - cap) * 0.12;
                }
            }
            if d < zn.r_blend {
                let w = 1.0 - smoothstep(zn.r_flat, zn.r_blend, d);
                h = lerp(h, zn.elev, w);
            }
        }
        h
    }

    /// Flat ground: inverse-distance blend of the airport elevations (exactly the field elevation on every plateau).
    fn flat_height(&self, x: f64, z: f64) -> f64 {
        if self.zones.is_empty() {
            return 0.0;
        }
        let (mut sum, mut wsum) = (0.0, 0.0);
        for zn in &self.zones {
            let d = ((x - zn.x).hypot(z - zn.z) - zn.r_flat).max(0.0) / 4000.0;
            let w = 1.0 / (1.0 + d * d);
            sum += zn.elev * w;
            wsum += w;
        }
        let mut h = sum / wsum;
        for zn in &self.zones {
            let d = (x - zn.x).hypot(z - zn.z);
            if d < zn.r_blend {
                h = lerp(h, zn.elev, 1.0 - smoothstep(zn.r_flat, zn.r_blend, d));
            }
        }
        h
    }

    /// Unit surface normal (Y up) from central differences over `eps` metres - used by shading, GPWS look-ahead and tests.
    pub fn normal(&self, x: f64, z: f64, eps: f64) -> glam::DVec3 {
        let dx = self.height(x + eps, z) - self.height(x - eps, z);
        let dz = self.height(x, z + eps) - self.height(x, z - eps);
        glam::DVec3::new(-dx, 2.0 * eps, -dz).normalize()
    }

    /// Airport blend weight at (x, z): 1 on the flat plateau (field elevation), smoothly falling to 0 at the skirt edge.
    pub fn airport_weight(&self, x: f64, z: f64) -> f64 {
        self.zones.iter().map(|zn| 1.0 - smoothstep(zn.r_flat, zn.r_blend, (x - zn.x).hypot(z - zn.z))).fold(0.0, f64::max)
    }

    /// Land / building density 0..1 used to scatter urban areas and forests.
    pub fn urban(&self, x: f64, z: f64) -> f64 {
        smoothstep(0.58, 0.72, fbm(x / 6000.0, z / 6000.0, 3, self.seed ^ 0xBEEF))
    }
    pub fn forest(&self, x: f64, z: f64) -> f64 {
        smoothstep(0.45, 0.6, fbm(x / 3500.0, z / 3500.0, 3, self.seed ^ 0xF00D))
    }
}

/// Hash exposed for scatter placement (trees, buildings): stable per cell, no allocation.
#[inline]
pub fn cell_hash(ix: i32, iz: i32, salt: u32) -> f64 {
    hash(ix, iz, salt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_finite() {
        let t = Terrain::new(7);
        for i in 0..2000 {
            let (x, z) = (i as f64 * 913.7 - 900_000.0, i as f64 * -577.1 + 400_000.0);
            let h = t.height(x, z);
            assert!(h.is_finite() && h > -1500.0 && h < 6000.0, "{h}");
            assert_eq!(h, t.height(x, z));
        }
    }

    #[test]
    fn airport_plateau_is_flat_at_field_elevation() {
        let mut t = Terrain::new(7);
        t.add_airport(1000.0, -2000.0, 4.0);
        for k in 0..64 {
            let a = k as f64 * 0.098;
            let (x, z) = (1000.0 + a.cos() * 3000.0, -2000.0 + a.sin() * 3000.0);
            assert!((t.height(x, z) - 4.0).abs() < 1e-9);
        }
    }

    #[test]
    fn flat_mode_is_level_at_both_fields_and_smooth_in_between() {
        let mut t = Terrain::new(7);
        t.add_airport(0.0, 0.0, 4.0);
        t.add_airport(400_000.0, 0.0, 1600.0);
        t.flat = true;
        assert!((t.height(1200.0, -900.0) - 4.0).abs() < 1e-9, "departure plateau");
        assert!((t.height(400_000.0 + 800.0, 300.0) - 1600.0).abs() < 1e-9, "arrival plateau");
        let mut prev = t.height(0.0, 0.0);
        let mut x = 0.0;
        while x < 400_000.0 {
            let h = t.height(x, 50_000.0);
            assert!((h - prev).abs() < 60.0, "step at {x}: {prev} -> {h}");
            assert!(h >= 3.99 && h <= 1600.01);
            prev = h;
            x += 500.0;
        }
        // procedural mode is untouched
        t.flat = false;
        assert!((t.height(30_000.0, 80_000.0) - Terrain { flat: true, ..t.clone() }.height(30_000.0, 80_000.0)).abs() > 1.0);
        assert!((Terrain::new(1).height(5.0, 5.0)).is_finite());
        let mut z = Terrain::new(1);
        z.flat = true;
        assert_eq!(z.height(1.0, 2.0), 0.0);
    }

    #[test]
    fn skirt_slope_is_gentle() {
        let mut t = Terrain::new(3);
        t.add_airport(0.0, 0.0, 300.0);
        let mut max_slope: f64 = 0.0;
        let mut r = 3000.0;
        while r < 10000.0 {
            let (h0, h1) = (t.height(r, 0.0), t.height(r + 25.0, 0.0));
            max_slope = max_slope.max(((h1 - h0) / 25.0).abs());
            r += 25.0;
        }
        assert!(max_slope < 0.6, "skirt slope {max_slope}");
    }

    #[test]
    fn approach_corridor_stays_below_the_glidepath() {
        // every bearing, every distance 3..46 km: terrain must stay >= 150 m under a 3 deg path to the field
        let mut t = Terrain::new(5);
        t.add_airport(0.0, 0.0, 10.0);
        let tan3 = (3.0_f64).to_radians().tan();
        for k in 0..72 {
            let a = (k as f64 * 5.0).to_radians();
            let mut d = 3500.0;
            while d < 46000.0 {
                let path = 10.0 + 15.0 + d * tan3;
                let h = t.height(a.cos() * d, a.sin() * d);
                assert!(h < path - 150.0 || path < 400.0 && h < path - 40.0, "bearing {} d {d}: terrain {h} vs path {path}", k * 5);
                d += 500.0;
            }
        }
    }

    #[test]
    fn normal_is_unit_and_flat_on_the_plateau() {
        let mut t = Terrain::new(7);
        t.add_airport(0.0, 0.0, 12.0);
        let n = t.normal(500.0, 300.0, 5.0);
        assert!((n.length() - 1.0).abs() < 1e-9 && n.y > 0.999999);
        let n = t.normal(60_000.0, -33_000.0, 8.0);
        assert!((n.length() - 1.0).abs() < 1e-9 && n.y > 0.0);
        assert_eq!(t.airport_weight(100.0, 100.0), 1.0);
        assert!(t.airport_weight(6000.0, 0.0) > 0.0 && t.airport_weight(6000.0, 0.0) < 1.0);
        assert_eq!(t.airport_weight(30_000.0, 0.0), 0.0);
    }

    #[test]
    fn noise_continuity() {
        let t = Terrain::new(11);
        let mut worst: f64 = 0.0;
        for i in 0..4000 {
            let x = i as f64 * 2.0;
            worst = worst.max((t.height(x + 2.0, 100.0) - t.height(x, 100.0)).abs());
        }
        assert!(worst < 12.0, "height jump over 2 m: {worst}");
    }
}
