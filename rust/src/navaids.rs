//! Radio navaids (VOR / VOR-DME / NDB) and a lightweight airport point list for the ND option layers
//! (reference: `src/data/airports.ts` -> `NAVAIDS`, `airportsNear`, and `efisDisplays.ts::nearestNav`).
//!
//! * The navaid table is `data/navaids.json`, a byte-identical copy of the TypeScript project's `src/data/navaids.json`
//!   (rows: `[ident, name, type, freq, lat, lon, elev, airport]`, NDB frequencies in kHz, VOR in kHz * 10).
//! * The ND `ARPT` layer needs every airport position but must never parse the 1.4 MB airport JSON on the render thread, so
//!   [`airport_points`] starts a background parse on first use and returns an empty slice until it is ready.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static NAVAIDS_JSON: &str = include_str!("../data/navaids.json");

#[derive(Clone, Debug)]
pub struct Navaid {
    pub ident: String,
    pub name: String,
    /// `type` column of the database (`NDB`, `NDB-DME`, `VOR`, `VOR-DME`, `VORTAC`, `DME` ...)
    pub kind: String,
    pub ndb: bool,
    pub freq: i64,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Clone, Debug)]
pub struct AirportPt {
    pub icao: String,
    pub lat: f64,
    pub lon: f64,
}

/// Parse the navaid table (`serde_json`, tolerant of malformed rows).
pub fn parse(json: &str) -> Vec<Navaid> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return Vec::new() };
    let Some(rows) = v.as_array() else { return Vec::new() };
    rows.iter()
        .filter_map(|r| {
            let r = r.as_array()?;
            let kind = r.get(2)?.as_str()?.to_string();
            Some(Navaid {
                ident: r.first()?.as_str()?.to_string(),
                name: r.get(1)?.as_str()?.to_string(),
                ndb: kind.starts_with("NDB"),
                kind,
                freq: r.get(3)?.as_i64().unwrap_or(0),
                lat: r.get(4)?.as_f64()?,
                lon: r.get(5)?.as_f64()?,
            })
        })
        .collect()
}

pub fn all() -> &'static [Navaid] {
    static N: OnceLock<Vec<Navaid>> = OnceLock::new();
    N.get_or_init(|| parse(NAVAIDS_JSON))
}

/// Flat-earth distance in NM (the same approximation as the TS ND: `hypot(dLon * cos(lat) * 60, dLat * 60)`).
#[inline]
pub fn flat_nm(lat0: f64, lon0: f64, lat: f64, lon: f64) -> f64 {
    let k = lat0.to_radians().cos();
    (((lon - lon0) * k * 60.0).powi(2) + ((lat - lat0) * 60.0).powi(2)).sqrt()
}

/// Nearest VOR (or NDB when `adf`) within 200 NM (120 NM for NDBs) - `nearestNav` of the TS ND. Returns the navaid and its distance in NM.
pub fn nearest(lat: f64, lon: f64, adf: bool) -> Option<(&'static Navaid, f64)> {
    let limit = if adf { 120.0 } else { 200.0 };
    let mut best: Option<(&Navaid, f64)> = None;
    for n in all() {
        if n.ndb != adf {
            continue;
        }
        let d = flat_nm(lat, lon, n.lat, n.lon);
        if d > limit {
            continue;
        }
        if best.map_or(true, |b| d < b.1) {
            best = Some((n, d));
        }
    }
    best
}

static APTS: OnceLock<Vec<AirportPt>> = OnceLock::new();
static APTS_STARTED: AtomicBool = AtomicBool::new(false);

/// Every airport position; empty until the background parse has finished (the first call starts it).
pub fn airport_points() -> &'static [AirportPt] {
    if let Some(v) = APTS.get() {
        return v;
    }
    if !APTS_STARTED.swap(true, Ordering::SeqCst) {
        let work = || {
            let db = crate::airports::AirportDb::embedded();
            let v: Vec<AirportPt> = db.airports.iter().map(|a| AirportPt { icao: a.icao.clone(), lat: a.lat, lon: a.lon }).collect();
            let _ = APTS.set(v);
        };
        if std::thread::Builder::new().name("nd-airports".into()).spawn(work).is_err() {
            // could not start a thread: leave the layer empty rather than stalling a frame
            let _ = APTS.set(Vec::new());
        }
    }
    &[]
}

/// Blocking variant for tests / tools.
pub fn airport_points_blocking() -> &'static [AirportPt] {
    loop {
        let p = airport_points();
        if !p.is_empty() || APTS.get().is_some() {
            return APTS.get().map(|v| v.as_slice()).unwrap_or(&[]);
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_parses_and_has_both_kinds() {
        let n = all();
        assert!(n.len() > 100, "{} navaids", n.len());
        assert!(n.iter().any(|x| x.ndb) && n.iter().any(|x| !x.ndb));
        let a = n.iter().find(|x| x.ident == "AMN").expect("Ambon VOR-DME");
        assert!(!a.ndb && (a.lat + 3.61492).abs() < 1e-4);
    }

    #[test]
    fn nearest_filters_by_kind_and_range() {
        // right on top of Ambon VOR-DME
        let (v, d) = nearest(-3.61492, 128.186, false).unwrap();
        assert_eq!(v.ident, "AMN");
        assert!(d < 0.1);
        let (a, _) = nearest(-3.3475, 128.926, true).unwrap();
        assert!(a.ndb);
        // middle of the South Atlantic: nothing within range
        assert!(nearest(-40.0, -20.0, false).is_none());
    }

    #[test]
    fn malformed_rows_are_skipped() {
        assert_eq!(parse("not json").len(), 0);
        assert_eq!(parse("[[1,2],[\"X\",\"n\",\"VOR\",1,2.0,3.0,0,\"\"]]").len(), 1);
    }
}
