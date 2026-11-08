//! Web-Mercator (slippy-map) tile arithmetic shared by the globe, the ground renderer and the loader.

use std::f64::consts::{PI, TAU};

/// Edge length (px) of every tile texture on the GPU (non-256 sources are resampled by the decoder).
pub const TILE_PX: usize = 256;
/// Latitude limit of the Web-Mercator square.
pub const MAX_LAT: f64 = 85.051_128_78;

/// Identity of one map tile of one style. `Hash`/`Eq` so it can key the resident / failure / queue tables.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct TileKey {
    pub style: u8,
    pub z: u8,
    pub x: u32,
    pub y: u32,
}

impl TileKey {
    pub const fn new(style: u8, z: u8, x: u32, y: u32) -> Self {
        Self { style, z, x, y }
    }
    pub fn parent(&self) -> Option<TileKey> {
        (self.z > 0).then(|| TileKey { style: self.style, z: self.z - 1, x: self.x >> 1, y: self.y >> 1 })
    }
    /// Ancestor `dz` levels up (clamped at z = 0).
    pub fn ancestor(&self, dz: u8) -> TileKey {
        let dz = dz.min(self.z);
        TileKey { style: self.style, z: self.z - dz, x: self.x >> dz, y: self.y >> dz }
    }
    pub fn child(&self, dx: u32, dy: u32) -> TileKey {
        TileKey { style: self.style, z: self.z + 1, x: self.x * 2 + dx, y: self.y * 2 + dy }
    }
}

#[inline]
pub fn tiles_at(z: u8) -> u32 {
    1u32 << z
}

/// Wraps a (possibly negative / overflowing) X index around the antimeridian.
#[inline]
pub fn wrap_x(x: i64, z: u8) -> u32 {
    x.rem_euclid(1i64 << z) as u32
}

/// Fractional tile X of a longitude (degrees) at zoom `z`.
pub fn lon_to_x(lon: f64, z: u8) -> f64 {
    (lon + 180.0) / 360.0 * tiles_at(z) as f64
}

/// Fractional tile Y of a latitude (degrees) at zoom `z`.
pub fn lat_to_y(lat: f64, z: u8) -> f64 {
    let s = lat.clamp(-MAX_LAT, MAX_LAT).to_radians().sin();
    (0.5 - ((1.0 + s) / (1.0 - s)).ln() / (4.0 * PI)) * tiles_at(z) as f64
}

/// Longitude (deg) at fractional tile X.
pub fn x_to_lon(x: f64, z: u8) -> f64 {
    x / tiles_at(z) as f64 * 360.0 - 180.0
}

/// Latitude (deg) at fractional tile Y.
pub fn y_to_lat(y: f64, z: u8) -> f64 {
    let n = PI - TAU * y / tiles_at(z) as f64;
    (0.5 * (n.exp() - (-n).exp())).atan().to_degrees()
}

/// Tile containing a lat/lon (degrees).
pub fn containing(style: u8, lat: f64, lon: f64, z: u8) -> TileKey {
    let n = tiles_at(z);
    let x = (lon_to_x(lon, z).floor().max(0.0) as u32).min(n - 1);
    let y = (lat_to_y(lat, z).floor().max(0.0) as u32).min(n - 1);
    TileKey { style, z, x, y }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_lat_lon() {
        for z in [0u8, 4, 12, 18] {
            for (lat, lon) in [(0.0, 0.0), (37.6, -122.4), (-33.9, 151.2), (60.0, 179.0), (-80.0, -179.0)] {
                let (x, y) = (lon_to_x(lon, z), lat_to_y(lat, z));
                assert!((x_to_lon(x, z) - lon).abs() < 1e-9, "lon z{z}");
                assert!((y_to_lat(y, z) - lat).abs() < 1e-9, "lat z{z}");
            }
        }
    }

    #[test]
    fn known_tile_san_francisco() {
        // KSFO (37.6188, -122.375) at z10 -> 163 / 396 (downtown SF, 37.77 N, is 395: standard slippy numbering)
        let k = containing(0, 37.6188, -122.375, 10);
        assert_eq!((k.x, k.y), (163, 396));
        assert_eq!(containing(0, 37.7749, -122.4194, 10).y, 395);
    }

    #[test]
    fn ancestors_and_wrapping() {
        let k = TileKey::new(0, 10, 163, 395);
        assert_eq!(k.parent().unwrap(), TileKey::new(0, 9, 81, 197));
        assert_eq!(k.ancestor(3), TileKey::new(0, 7, 20, 49));
        assert_eq!(k.ancestor(200).z, 0);
        assert_eq!(TileKey::new(0, 0, 0, 0).parent(), None);
        assert_eq!(wrap_x(-1, 3), 7);
        assert_eq!(wrap_x(8, 3), 0);
        assert_eq!(k.child(1, 0), TileKey::new(0, 11, 327, 790));
    }

    #[test]
    fn poles_clamp_inside_square() {
        let k = containing(0, 90.0, 0.0, 5);
        assert_eq!(k.y, 0);
        let k = containing(0, -90.0, 180.0, 5);
        assert_eq!((k.x, k.y), (31, 31));
    }
}
