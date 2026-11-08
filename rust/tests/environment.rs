//! Environment integration tests: real-sun twilight sequence over a day, wet-weather flights, cloud / precipitation
//! consistency with the weather model (all headless - no GPU needed).

use inflight::airports::AirportDb;
use inflight::atmosphere::{sky_colors_ex, Phase};
use inflight::clock::sun_position;
use inflight::clouds::{self, Clouds};
use inflight::game::{Action, Flight, PilotInput, Status, PHYS_DT};
use inflight::precip;
use inflight::weather::Weather;

const DAY: f64 = 1_718_914_200.0; // 2024-06-20 20:10Z = solar noon at SFO

fn db() -> AirportDb {
    AirportDb::embedded()
}

#[test]
fn a_full_day_at_sfo_walks_through_every_twilight_phase_in_order() {
    // 2024-06-20 00:00Z .. +24 h at KSFO, one sample / 2 min
    let (lat, lon) = (37.62, -122.38);
    let t0 = 1_718_841_600.0;
    let mut seq: Vec<Phase> = Vec::new();
    let mut max_el: f64 = -90.0;
    let mut min_el: f64 = 90.0;
    for k in 0..720 {
        let (el, _az) = sun_position(t0 + k as f64 * 120.0, lat, lon);
        max_el = max_el.max(el);
        min_el = min_el.min(el);
        let p = Phase::of(el);
        if seq.last() != Some(&p) {
            seq.push(p);
        }
    }
    assert!(max_el > 70.0 && max_el < 80.0, "June solstice noon elevation at 37.6N ~ 75.8 deg: {max_el}");
    assert!(min_el < -25.0, "midnight sun elevation {min_el}");
    // the sun never skips a phase: consecutive phases differ by exactly one step
    let rank = |p: &Phase| *p as i32;
    for w in seq.windows(2) {
        assert_eq!((rank(&w[0]) - rank(&w[1])).abs(), 1, "phase jump {:?} -> {:?}", w[0], w[1]);
    }
    assert!(seq.contains(&Phase::Day) && seq.contains(&Phase::Night) && seq.contains(&Phase::Civil) && seq.contains(&Phase::Nautical));
}

#[test]
fn sky_light_follows_the_real_sun_through_the_day() {
    let (lat, lon) = (37.62, -122.38);
    let t0 = 1_718_841_600.0;
    let mut dark = 0;
    let mut bright = 0;
    for k in 0..288 {
        let (el, _) = sun_position(t0 + k as f64 * 300.0, lat, lon);
        let c = sky_colors_ex(el as f32, 0.2, 0.3);
        assert!(c.ambient.is_finite() && c.sun_light.is_finite());
        if c.night > 0.95 {
            dark += 1;
            assert!(c.sun_light.length() < 0.1);
        }
        if c.night < 0.02 {
            bright += 1;
        }
    }
    assert!(dark > 60 && bright > 100, "dark {dark} bright {bright}");
}

#[test]
fn wet_weather_wets_the_runway_and_cuts_visibility() {
    let db = db();
    // scan days for a rainy one - the generator makes roughly 1 day in 4 wet
    let mut found = None;
    for d in 0..80 {
        let f = Flight::new(&db, "KSFO", "KOAK", DAY + d as f64 * 86400.0).unwrap();
        if f.weather.precip > 0.0 {
            found = Some(f);
            break;
        }
    }
    let f = found.expect("a wet day within 80 days");
    assert!(f.fm.wetness > 0.2, "wetness {}", f.fm.wetness);
    assert!(f.weather.cloud_cover > 0.55);
    assert!(f.weather.vis_km <= 30.0 * (1.0 - 0.65 * f.weather.precip) + 1e-9, "rain visibility {}", f.weather.vis_km);
}

#[test]
fn takeoff_in_a_thunderstorm_stays_controllable() {
    let db = db();
    let mut f = Flight::new(&db, "KSFO", "KOAK", DAY).unwrap();
    f.weather = Weather { cloud_cover: 0.95, cloud_base_m: 900.0, precip: 0.9, thunder: true, vis_km: 4.0, turb: 0.5, gust_kt: 8.0, wind_kt: 14.0, wind_from_deg: 280.0, ..Weather::calm() };
    f.fm.wetness = 0.9;
    f.apply(Action::ApAutoTakeoff);
    let inp = PilotInput::default();
    for _ in 0..(120 * 150) {
        f.step(PHYS_DT, &inp);
        if f.fm.agl > 600.0 || f.status == Status::Crashed {
            break;
        }
    }
    assert_ne!(f.status, Status::Crashed, "wet-runway storm take-off must be survivable");
    assert!(f.fm.agl > 300.0, "airborne, agl {}", f.fm.agl);
    assert!(!f.fm.stalled);
}

#[test]
fn flying_through_the_deck_is_detected_as_in_cloud_and_rain_stops_above_it() {
    let w = Weather { cloud_cover: 0.95, cloud_base_m: 1200.0, precip: 0.8, ..Weather::calm() };
    let c = Clouds::from_weather(&w);
    let l = c.layers[0];
    let off = clouds::drift(&w, 100.0);
    // sample the slab: some points are in cloud, none outside
    let mut inside = 0;
    for i in 0..400 {
        let p = glam::DVec3::new(i as f64 * 311.0, (l.base + l.top) as f64 * 0.4, i as f64 * -97.0);
        if c.at(p, off) > 0.35 {
            inside += 1;
        }
        assert_eq!(c.at(glam::DVec3::new(p.x, l.base as f64 - 50.0, p.z), off), 0.0);
    }
    assert!(inside > 150, "an overcast deck is mostly solid: {inside}/400");
    assert!(precip::state(&w, 0.0, 300.0).intensity > 0.7);
    assert!(precip::state(&w, 0.0, 3000.0).intensity < 1e-4);
}
