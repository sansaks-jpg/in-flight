//! Airport / runway database (OurAirports + OSM derived, 8 413 airports) shared with the original project.
//! The JSON is embedded in the binary and parsed once at start-up.

use crate::geo::{bearing, destination, haversine};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct Runway {
    pub le: String,
    pub he: String,
    pub le_lat: f64,
    pub le_lon: f64,
    pub he_lat: f64,
    pub he_lon: f64,
    pub width: f64,
    pub length: f64,
    pub surface: char,
    pub lit: bool,
    pub disp_le: f64,
    pub disp_he: f64,
}

/// One usable direction of a runway.
#[derive(Clone, Debug)]
pub struct RunwayEnd {
    pub ident: String,
    /// physical start of the pavement (take-off start)
    pub start_lat: f64,
    pub start_lon: f64,
    /// landing threshold (start + displaced threshold)
    pub thr_lat: f64,
    pub thr_lon: f64,
    pub end_lat: f64,
    pub end_lon: f64,
    pub hdg: f64,
    pub length: f64,
    pub width: f64,
    pub disp: f64,
    pub paved: bool,
}

impl Runway {
    pub fn ends(&self) -> [RunwayEnd; 2] {
        let hdg = bearing(self.le_lat, self.le_lon, self.he_lat, self.he_lon);
        let len = haversine(self.le_lat, self.le_lon, self.he_lat, self.he_lon).max(50.0);
        let mk = |ident: &str, slat, slon, elat, elon, hdg: f64, disp: f64| {
            let (tlat, tlon) = if disp > 0.0 { destination(slat, slon, hdg, disp.min(len * 0.4)) } else { (slat, slon) };
            RunwayEnd {
                ident: ident.to_string(),
                start_lat: slat,
                start_lon: slon,
                thr_lat: tlat,
                thr_lon: tlon,
                end_lat: elat,
                end_lon: elon,
                hdg,
                length: len,
                width: self.width.max(18.0),
                disp,
                paved: matches!(self.surface, 'A' | 'C'),
            }
        };
        [
            mk(&self.le, self.le_lat, self.le_lon, self.he_lat, self.he_lon, hdg, self.disp_le),
            mk(&self.he, self.he_lat, self.he_lon, self.le_lat, self.le_lon, (hdg + 180.0) % 360.0, self.disp_he),
        ]
    }
}

#[derive(Clone, Debug)]
pub struct Airport {
    pub icao: String,
    pub name: String,
    pub city: String,
    pub country: String,
    pub lat: f64,
    pub lon: f64,
    pub elev: f64,
    pub size: u8,
    pub iata: String,
    pub runways: Vec<Runway>,
}

impl Airport {
    /// Longest paved runway (or longest at all as a fallback).
    pub fn main_runway(&self) -> Option<&Runway> {
        self.runways
            .iter()
            .filter(|r| matches!(r.surface, 'A' | 'C'))
            .max_by(|a, b| a.length.total_cmp(&b.length))
            .or_else(|| self.runways.iter().max_by(|a, b| a.length.total_cmp(&b.length)))
    }

    /// Pick the runway end that points most into the wind (wind_from in degrees true).
    pub fn best_end(&self, wind_from: f64) -> Option<RunwayEnd> {
        let rw = self.main_runway()?;
        let ends = rw.ends();
        let score = |e: &RunwayEnd| ((e.hdg - wind_from).to_radians()).cos();
        let [a, b] = ends;
        Some(if score(&a) >= score(&b) { a } else { b })
    }

    pub fn find_end(&self, ident: &str) -> Option<RunwayEnd> {
        self.runways.iter().flat_map(|r| r.ends()).find(|e| e.ident == ident)
    }
}

pub struct AirportDb {
    pub airports: Vec<Airport>,
    index: HashMap<String, usize>,
}

fn pad(s: &str) -> String {
    let b = s.as_bytes();
    if !b.is_empty() && b[0].is_ascii_digit() && (b.len() == 1 || (b.len() == 2 && matches!(b[1], b'L' | b'R' | b'C'))) {
        format!("0{s}")
    } else {
        s.to_string()
    }
}

fn num(v: &Value, i: usize) -> f64 {
    v.get(i).and_then(Value::as_f64).unwrap_or(0.0)
}
fn text(v: &Value, i: usize) -> String {
    v.get(i).and_then(Value::as_str).unwrap_or("").to_string()
}

impl AirportDb {
    pub fn embedded() -> Self {
        Self::from_json(include_str!("../data/airports.json"))
    }

    pub fn from_json(json: &str) -> Self {
        let root: Value = serde_json::from_str(json).expect("airports.json is valid JSON");
        let mut airports = Vec::with_capacity(9000);
        for r in root.as_array().expect("airport array") {
            let runways = r
                .get(9)
                .and_then(Value::as_array)
                .map(|ws| {
                    ws.iter()
                        .map(|w| Runway {
                            le: pad(&text(w, 0)),
                            he: pad(&text(w, 1)),
                            le_lat: num(w, 2),
                            le_lon: num(w, 3),
                            he_lat: num(w, 4),
                            he_lon: num(w, 5),
                            width: num(w, 6),
                            length: num(w, 7),
                            surface: text(w, 8).chars().next().unwrap_or('A'),
                            lit: w.get(9).and_then(Value::as_f64).map(|v| v == 1.0).unwrap_or(true),
                            disp_le: num(w, 10),
                            disp_he: num(w, 11),
                        })
                        .collect()
                })
                .unwrap_or_default();
            airports.push(Airport {
                icao: text(r, 0),
                name: text(r, 1),
                city: text(r, 2),
                country: text(r, 3),
                lat: num(r, 4),
                lon: num(r, 5),
                elev: num(r, 6),
                size: num(r, 7) as u8,
                iata: text(r, 8),
                runways,
            });
        }
        let index = airports.iter().enumerate().map(|(i, a)| (a.icao.clone(), i)).collect();
        Self { airports, index }
    }

    pub fn get(&self, icao: &str) -> Option<&Airport> {
        self.index.get(&icao.to_ascii_uppercase()).map(|&i| &self.airports[i])
    }

    /// Case-insensitive lookup by ICAO or IATA.
    pub fn find(&self, code: &str) -> Option<&Airport> {
        let c = code.trim().to_ascii_uppercase();
        self.get(&c).or_else(|| if c.len() == 3 { self.airports.iter().find(|a| a.iata == c) } else { None })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn database_loads_and_known_airports_resolve() {
        let db = AirportDb::embedded();
        assert!(db.airports.len() > 8000, "{}", db.airports.len());
        let sfo = db.get("KSFO").expect("KSFO");
        assert_eq!(sfo.iata, "SFO");
        assert!(sfo.runways.len() >= 4);
        assert!(db.find("lhr").is_some_and(|a| a.icao == "EGLL"));
    }

    #[test]
    fn runway_geometry_is_consistent() {
        let db = AirportDb::embedded();
        let sfo = db.get("KSFO").unwrap();
        let rw = sfo.main_runway().unwrap();
        assert_eq!(rw.le, "10L");
        let [a, b] = rw.ends();
        // runway numbers are MAGNETIC: SFO 10L is ~118 deg TRUE (declination ~ -13 deg); 28R is the reciprocal
        assert!((a.hdg - 118.0).abs() < 3.0, "{}", a.hdg);
        assert!(((a.hdg - b.hdg).abs() - 180.0).abs() < 1e-6);
        assert!((a.length - 3613.0).abs() < 120.0, "{}", a.length);
        // 28R has a 91 m displaced threshold
        assert!(b.disp > 80.0);
        let d = haversine(b.start_lat, b.start_lon, b.thr_lat, b.thr_lon);
        assert!((d - b.disp).abs() < 2.0);
    }

    #[test]
    fn best_end_points_into_wind() {
        let db = AirportDb::embedded();
        let sfo = db.get("KSFO").unwrap();
        let e = sfo.best_end(280.0).unwrap();
        assert!(e.ident.starts_with("28"), "{}", e.ident);
        let e = sfo.best_end(100.0).unwrap();
        assert!(e.ident.starts_with("10"), "{}", e.ident);
    }

    #[test]
    fn every_airport_has_finite_coordinates() {
        let db = AirportDb::embedded();
        assert!(db.airports.iter().all(|a| a.lat.is_finite() && a.lon.is_finite() && a.lat.abs() <= 90.0));
    }
}
