//! Pre-downloads satellite / map tiles into the on-disk cache (offline play, instant first frame at an airport) and doubles
//! as a network smoke test of the tile pipeline (fetch -> disk cache -> PNG/JPEG decode).
//!
//! usage: tilecache <ICAO | lat,lon> [style id: sat|s2|osm|topo|night|dark] [extra tile radius]
//!   e.g. `tilecache KSFO`, `tilecache 35.55,139.78 sat 2`
//! The cache directory is `$INFLIGHT_TILE_CACHE` or the platform cache dir (see `tiles::disk::default_root`).
use inflight::airports::AirportDb;
use inflight::tiles::decode::decode_tile;
use inflight::tiles::disk::{default_max_bytes, default_root, DiskCache};
use inflight::tiles::ground::prefetch_keys;
use inflight::tiles::hub::{Fetcher, HttpFetcher};
use inflight::tiles::styles;
use std::time::Instant;

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(target) = args.next() else {
        eprintln!("usage: tilecache <ICAO | lat,lon> [style: sat|s2|osm|topo|night|dark]");
        std::process::exit(2);
    };
    let style = args.next().and_then(|s| styles::style_index(&s)).unwrap_or(styles::DEFAULT_STYLE);
    let (lat, lon) = if let Some((a, b)) = target.split_once(',') {
        (a.trim().parse::<f64>().expect("lat"), b.trim().parse::<f64>().expect("lon"))
    } else {
        let db = AirportDb::embedded();
        let a = db.find(&target).unwrap_or_else(|| panic!("unknown airport {target}"));
        (a.lat, a.lon)
    };
    let cache = DiskCache::open(default_root(), default_max_bytes());
    let fetcher = HttpFetcher::new();
    let mut keys = prefetch_keys(style, lat, lon);
    // plus the pinned world base (z <= 3) so the globe is complete offline too
    for z in 0..=3u8 {
        for x in 0..(1u32 << z) {
            for y in 0..(1u32 << z) {
                keys.push(inflight::tiles::TileKey::new(style, z, x, y));
            }
        }
    }
    let st = styles::style(style);
    println!("{} tiles of '{}' around {lat:.4},{lon:.4} -> {}", keys.len(), st.name, cache.root().display());
    let t0 = Instant::now();
    let (mut hit, mut got, mut missing, mut bad, mut bytes) = (0, 0, 0, 0, 0usize);
    for k in &keys {
        let path = cache.path(st.id, k.z, k.x, k.y);
        if cache.get(&path).is_some() {
            hit += 1;
            continue;
        }
        match fetcher.fetch(&st.tile_url(k.z, k.x, k.y)) {
            Ok(b) => match decode_tile(&b) {
                Ok(_) => {
                    bytes += b.len();
                    cache.put(&path, &b);
                    got += 1;
                }
                Err(e) => {
                    bad += 1;
                    eprintln!("  z{}/{}/{}: undecodable ({e})", k.z, k.x, k.y);
                }
            },
            Err(_) => missing += 1,
        }
    }
    println!("done in {:.1}s: {got} downloaded ({:.1} MB), {hit} already cached, {missing} unavailable, {bad} corrupt", t0.elapsed().as_secs_f64(), bytes as f64 / 1e6);
    println!("cache size now {:.1} MB", cache.size_bytes() as f64 / 1e6);
}
