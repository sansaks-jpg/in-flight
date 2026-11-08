//! Headless full-flight integration tests: gameplay flow + physics + autopilot, no GPU needed.

use inflight::airports::AirportDb;
use inflight::game::{Action, Flight, PilotInput, Status, PHYS_DT};
use inflight::geo::*;
use inflight::weather::Weather;

const T0: f64 = 1_718_884_800.0; // 2024-06-20 12:00 UTC

fn db() -> AirportDb {
    AirportDb::embedded()
}

struct Report {
    status: Status,
    minutes: f64,
    max_bank: f64,
    max_g: f64,
    min_g: f64,
    stalled: bool,
    max_ias: f64,
    min_agl_airborne: f64,
    fuel_used: f64,
    cruise_alt_ft: f64,
}

fn fly(f: &mut Flight, max_minutes: f64) -> Report {
    let input = PilotInput::default();
    let mut r = Report { status: f.status, minutes: 0.0, max_bank: 0.0, max_g: 1.0, min_g: 1.0, stalled: false, max_ias: 0.0, min_agl_airborne: f64::MAX, fuel_used: 0.0, cruise_alt_ft: 0.0 };
    let fuel0 = f.fm.fuel;
    let steps = (max_minutes * 60.0 / PHYS_DT) as u64;
    for i in 0..steps {
        f.step(PHYS_DT, &input);
        r.max_bank = r.max_bank.max(f.fm.bank.to_degrees().abs());
        r.max_g = r.max_g.max(f.fm.nz);
        r.min_g = r.min_g.min(f.fm.nz);
        r.max_ias = r.max_ias.max(f.fm.ias / KT);
        r.cruise_alt_ft = r.cruise_alt_ft.max(f.fm.pos.y / FT);
        if f.fm.stalled {
            r.stalled = true;
        }
        // terrain clearance en route: more than 6 km from both airfields (the last metres of the flare are excluded)
        if !f.fm.wow && f.fm.airborne_time > 3.0 {
            let far = haversine(f.lat, f.lon, f.dep.lat, f.dep.lon) > 6000.0 && haversine(f.lat, f.lon, f.arr.lat, f.arr.lon) > 6000.0;
            if far {
                r.min_agl_airborne = r.min_agl_airborne.min(f.fm.agl);
            }
        }
        assert!(f.fm.pos.is_finite() && f.fm.vel.is_finite(), "non finite state at step {i}");
        if matches!(f.status, Status::Landed | Status::Crashed) {
            r.minutes = i as f64 * PHYS_DT / 60.0;
            break;
        }
    }
    r.status = f.status;
    r.fuel_used = fuel0 - f.fm.fuel;
    if r.minutes == 0.0 {
        r.minutes = max_minutes;
    }
    r
}

#[test]
fn ready_state_is_parked_and_stable() {
    let db = db();
    let mut f = Flight::new(&db, "KSFO", "KOAK", T0).unwrap();
    assert_eq!(f.status, Status::Ready);
    for _ in 0..(120 * 30) {
        f.step(PHYS_DT, &PilotInput::default());
    }
    assert!(f.fm.wow && f.fm.gs < 0.3 && !f.fm.crashed, "gs {}", f.fm.gs);
    assert_eq!(f.status, Status::Ready);
}

#[test]
fn unknown_airports_are_rejected() {
    let db = db();
    assert!(Flight::new(&db, "ZZZZ", "KOAK", T0).is_err());
    assert!(Flight::new(&db, "KSFO", "NOPE", T0).is_err());
}

#[test]
fn manual_takeoff_accelerates_rotates_and_climbs() {
    let db = db();
    let mut f = Flight::new(&db, "KSFO", "KOAK", T0).unwrap();
    // calm air so the test is about the model, not luck
    f.weather = Weather::calm();
    f.apply(Action::ToggleParking);
    f.fm.ctl.throttle = 1.0;
    let mut rotated_at = None;
    let mut input = PilotInput::default();
    for i in 0..(120 * 90) {
        let kias = f.fm.ias / KT;
        // hold the centreline with rudder, rotate at Vr
        input.yaw = clamp(wrap180(f.dep_end.hdg - f.fm.heading) * 0.08, -1.0, 1.0);
        input.pitch = if kias > f.fm.spec.vr && rotated_at.is_none() { rotated_at = Some(i); 0.35 } else if rotated_at.is_some() { if f.fm.pitch.to_degrees() < 14.0 { 0.2 } else { 0.0 } } else { 0.0 };
        f.step(PHYS_DT, &input);
        if f.fm.agl > 150.0 {
            break;
        }
        assert!(!f.fm.crashed, "crashed during take-off at t={}", f.t);
    }
    assert!(f.fm.agl > 100.0, "never climbed: agl {} ias {}", f.fm.agl, f.fm.ias / KT);
    assert!(rotated_at.is_some());
    assert!(f.fm.vs > 1.0, "positive rate of climb");
    // runway length check: lifted off before the end of the 3.6 km runway
    let run = haversine(f.dep_end.start_lat, f.dep_end.start_lon, f.lat, f.lon);
    assert!(run < 5200.0, "ground roll + initial climb distance {run}");
    assert!(f.status == Status::Flying);
}

#[test]
fn auto_flight_ksfo_koak_takeoff_to_landing() {
    let db = db();
    let mut f = Flight::new(&db, "KSFO", "KOAK", T0).unwrap();
    f.apply(Action::ApAutoTakeoff);
    assert!(f.ap.on);
    let r = fly(&mut f, 25.0);
    report("KSFO-KOAK", &f, &r);
    assert_eq!(r.status, Status::Landed, "flight did not complete: status {:?}, phase {:?}, wp {}", r.status, f.ap.phase, f.active_wp);
    assert_flight_quality(&f, &r);
}

#[test]
fn auto_flight_klax_ksan_regional() {
    let db = db();
    let mut f = Flight::new(&db, "KLAX", "KSAN", T0 + 86400.0 * 3.0).unwrap();
    f.apply(Action::ApAutoTakeoff);
    let r = fly(&mut f, 60.0);
    report("KLAX-KSAN", &f, &r);
    assert_eq!(r.status, Status::Landed, "status {:?} phase {:?} wp {}", r.status, f.ap.phase, f.active_wp);
    assert_flight_quality(&f, &r);
    assert!(r.cruise_alt_ft > 10000.0, "should have reached a real cruise level, got {} ft", r.cruise_alt_ft);
}

#[test]
fn auto_flight_across_weather_seeds() {
    let db = db();
    for (i, (a, b)) in [("EGLL", "EGKK"), ("KJFK", "KEWR"), ("EDDF", "EDDM")].iter().enumerate() {
        let mut f = Flight::new(&db, a, b, T0 + 86400.0 * (i as f64 * 11.0 + 1.0)).unwrap();
        f.apply(Action::ApAutoTakeoff);
        let r = fly(&mut f, 70.0);
        report(&format!("{a}-{b}"), &f, &r);
        assert_eq!(r.status, Status::Landed, "{a}-{b}: status {:?} phase {:?} wp {}", r.status, f.ap.phase, f.active_wp);
        assert_flight_quality(&f, &r);
    }
}

fn report(name: &str, f: &Flight, r: &Report) {
    let td = f.touchdown.expect("touchdown recorded");
    eprintln!(
        "[{name}] {:?} in {:.1} min | max bank {:.1}° | g {:.2}..{:.2} | max IAS {:.0} kt | fuel {:.0} kg | TD {:.0} fpm @ {:.0} kt, pitch {:.1}°, bank {:.1}°, cl {:.1} m ({}) | wind {:.0}°/{:.0} kt",
        r.status, r.minutes, r.max_bank, r.min_g, r.max_g, r.max_ias, r.fuel_used, td.fpm, td.speed_kt, td.pitch_deg, td.bank_deg, td.centreline_m, td.grade, f.weather.wind_from_deg, f.weather.wind_kt
    );
}

fn assert_flight_quality(f: &Flight, r: &Report) {
    let td = f.touchdown.expect("touchdown recorded");
    assert!(!r.stalled, "aircraft stalled during the flight");
    assert!(r.max_bank < 45.0, "excessive bank {}", r.max_bank);
    assert!(r.max_g < 2.6 && r.min_g > 0.3, "g loads {}..{}", r.min_g, r.max_g);
    assert!(r.max_ias < f.fm.spec.vne, "overspeed {}", r.max_ias);
    assert!(r.min_agl_airborne > 100.0, "airborne clearance {}", r.min_agl_airborne);
    assert!(td.fpm < 600.0, "hard landing {} fpm", td.fpm);
    assert!(td.bank_deg.abs() < 8.0, "touchdown bank {}", td.bank_deg);
    assert!(td.centreline_m.abs() < f.arr_end.width * 1.2 + 15.0, "off centreline {} m", td.centreline_m);
    assert!(f.fm.damage < 20.0, "damage {}", f.fm.damage);
    // stopped on the runway (within its length plus overrun margin) at the arrival airfield
    let end = haversine(f.arr_end.thr_lat, f.arr_end.thr_lon, f.lat, f.lon);
    assert!(end < f.arr_end.length + 200.0, "stopped {} m from threshold, runway {} m", end, f.arr_end.length);
    assert!(f.fm.fuel > 500.0, "fuel exhausted");
}
