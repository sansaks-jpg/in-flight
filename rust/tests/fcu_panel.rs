//! FCU / EFIS glareshield panel against the REAL downloaded `cockpit.glb` (skipped when the add-on is not installed:
//! run the Marketplace download first or point `INFLIGHT_ADDON_DIR` at a cache that contains it).
//!
//! Every control is operated through the same `Deck::press / drag / release / wheel` mechanics the app uses, and both the
//! *function* (autopilot / systems state) and the *visual behaviour* (knob rotation sense and angle per detent, push / pull
//! plunger travel, lamp and legend visibility) are verified. Pure logic is covered by the unit tests in `src/fcu.rs`.

use glam::Vec3;
use inflight::a320sys::A320Systems;
use inflight::addons::AddonManager;
use inflight::airports::AirportDb;
use inflight::deck::{Deck, Hit, Kind};
use inflight::fcu;
use inflight::game::Flight;
use inflight::glb;
use inflight::specs::A320;

const T0: f64 = 1_718_884_800.0;
const DT: f32 = 1.0 / 60.0;

fn load() -> Option<Deck> {
    let (bytes, man) = AddonManager::new().read_installed()?;
    let g = glb::parse(&bytes).expect("GLB parses");
    Some(Deck::new(g, man.as_deref(), A320.eye))
}

fn flight() -> (Flight, A320Systems) {
    let f = Flight::new(&AirportDb::embedded(), "KSFO", "KOAK", T0).expect("flight");
    let mut s = A320Systems::default();
    s.sync_from_flight(&f.fm);
    (f, s)
}

/// Autopilot on in selected heading mode with every window selected (dials directly change the targets).
fn selected(f: &mut Flight, s: &mut A320Systems) {
    f.ap.on = true;
    f.ap.nav = false;
    f.ap.spd = 250.0;
    f.ap.hdg = 90.0;
    f.ap.alt_ft = 10_000.0;
    f.ap.spd_selected = true;
    f.ap.alt_selected = true;
    fcu::sync(0.0, f, s);
}

fn hit(deck: &Deck, id: &str) -> Hit {
    Hit { group: deck.groups.iter().position(|g| g.id == id).unwrap_or_else(|| panic!("missing control {id}")), dist: 1.0 }
}

fn settle(deck: &mut Deck, f: &Flight, s: &A320Systems) {
    for _ in 0..180 {
        deck.update(DT, f, s);
    }
}

/// Rotation (degrees, clockwise as seen from the captain's seat = positive) of a control, measured exactly about its real axis
/// on a rim point. Range (-180, 180]; use [`wrap`] for differences.
fn cw_deg(deck: &mut Deck, id: &str) -> f32 {
    let (pivot, dir) = deck.pose_axis(id).unwrap_or_else(|| panic!("no axis for {id}"));
    let xf = deck.group(id).unwrap().xf;
    let e = dir.cross(Vec3::Y).normalize_or(Vec3::Z) * 0.01;
    let r1 = xf.transform_point3(pivot + e) - xf.transform_point3(pivot);
    // positive turn about `dir` is counter-clockwise for an observer the axis points at
    let about = e.cross(r1).dot(dir).atan2(e.dot(r1)).to_degrees();
    if dir.dot(inflight::deck::EYE_M - pivot) > 0.0 { -about } else { about }
}

fn wrap(d: f32) -> f32 {
    (d + 540.0).rem_euclid(360.0) - 180.0
}

/// Displacement of the control's pivot along the panel normal (metres, + = towards the pilot).
fn travel(deck: &Deck, id: &str) -> f32 {
    let g = deck.group(id).unwrap();
    let (pivot, _) = (g.axis.map(|a| a.pivot).unwrap_or((g.bmin + g.bmax) * 0.5), ());
    (g.xf.transform_point3(pivot) - pivot).dot(g.nrm)
}

fn press_release(deck: &mut Deck, f: &mut Flight, s: &mut A320Systems, id: &str, button: u8, shift: bool) {
    let h = hit(deck, id);
    deck.press(&h, button, shift, f, s);
    deck.release(f, s);
}

#[test]
fn every_fcu_and_efis_glareshield_control_exists_with_the_right_kind() {
    let Some(deck) = load() else { return eprintln!("cockpit add-on not installed: skipping") };
    for id in ["spd-sel", "hdg_sel", "alt-sel", "vs-sel", "alt-sel-mode", "nd_mode", "nd_mode_fo", "nd_range", "nd_range_fo", "qnh_cpt_knb", "qnh_fo_knb", "qnh_cpt_sw", "qnh_fo_sw", "fcu_integ_knb1", "fcu_integ_knb2"] {
        assert_eq!(deck.group(id).map(|g| g.kind), Some(Kind::Knob), "knob {id}");
    }
    for b in fcu::Button::ALL {
        assert_eq!(deck.group(b.id()).map(|g| g.kind), Some(Kind::Push), "button {}", b.id());
    }
    for id in ["fd1", "fd2", "ils", "ils2", "cstr", "wpt", "vord", "ndb", "arpt", "cstr.001", "wpt.001", "vord.001", "ndb.001", "arpt.001", "master_warning", "master_caution"] {
        assert_eq!(deck.group(id).map(|g| g.kind), Some(Kind::Push), "push {id}");
    }
    for id in ["vor-adf1", "vor-adf2", "vor-adf-1-right", "vor-adf-2-right"] {
        assert_eq!(deck.group(id).map(|g| g.kind), Some(Kind::Switch), "switch {id}");
    }
    // every FCU window legend exists as a state-driven lamp, the digit meshes / dashes do not
    for n in ["spd.ind", "mach.ind", "hdg.ind", "trk.ind", "hdg2.ind", "trk2.ind", "vs.ind", "fpa.ind", "vs.ind.001", "fpa.ind.001", "spd.fmgc", "lat.fmgc", "ver.fmgc", "lvlch.ind"] {
        assert!(deck.lamp_slot(&format!("fcu:{n}")).is_some(), "legend {n}");
    }
    for n in ["alt.ind", "spd.dash", "lat.dash", "vs.dash"] {
        assert!(deck.lamp_slot(&format!("fcu:{n}")).is_none(), "{n} stays hidden");
    }
    // every control that is posed about an axis has one (the right ADF/VOR levers borrow the left one's)
    let mut deck = deck;
    for id in ["spd-sel", "hdg_sel", "alt-sel", "vs-sel", "alt-sel-mode", "qnh_cpt_knb", "qnh_fo_knb", "qnh_cpt_sw", "qnh_fo_sw", "nd_mode", "nd_range", "vor-adf1", "vor-adf-1-right", "vor-adf-2-right"] {
        let (_, dir) = deck.pose_axis(id).unwrap_or_else(|| panic!("axis of {id}"));
        assert!((dir.length() - 1.0).abs() < 1e-3, "{id}: unit axis, got {dir:?}");
    }
}

#[test]
fn fcu_controls_are_pickable_from_the_captains_seat() {
    let Some(deck) = load() else { return };
    let eye = Vec3::new(A320.eye[0] as f32, A320.eye[1] as f32, A320.eye[2] as f32);
    let ids = ["spd-sel", "hdg_sel", "alt-sel", "vs-sel", "ap1", "ap2", "a-thr", "appr", "loc", "exped", "spd-mach", "hdg-vs", "metric_alt", "fd1", "ils", "qnh_cpt_knb", "nd_mode", "nd_range"];
    let mut ok = 0;
    for id in ids {
        let g = deck.group(id).unwrap();
        let c = deck.to_body.transform_point3((g.bmin + g.bmax) * 0.5);
        let d = (c - eye).normalize();
        match deck.pick(eye, d) {
            Some(h) if deck.groups[h.group].id == id => ok += 1,
            Some(h) => eprintln!("ray to {id} hit {} first", deck.groups[h.group].id),
            None => eprintln!("ray to {id} hit nothing"),
        }
    }
    assert!(ok >= ids.len() - 3, "pick accuracy {ok}/{}", ids.len());
}

#[test]
fn window_knobs_turn_one_detent_per_click_clockwise_and_back() {
    let Some(mut deck) = load() else { return };
    let (mut f, mut s) = flight();
    selected(&mut f, &mut s);
    settle(&mut deck, &f, &s);
    for id in ["spd-sel", "hdg_sel", "alt-sel", "vs-sel"] {
        let h = hit(&deck, id);
        let rest = cw_deg(&mut deck, id);
        assert!(rest.abs() < 1.0, "{id} starts at its rest pose, got {rest}");
        // 8 clicks of wheel-up (clockwise) = 8 / 32 turn = 90 degrees, whatever the value does
        for _ in 0..8 {
            assert!(deck.wheel(&h, 1.0, false, &mut f, &mut s), "{id} consumes the wheel");
        }
        settle(&mut deck, &f, &s);
        let a = cw_deg(&mut deck, id);
        assert!((a - 90.0).abs() < 2.5, "{id}: 8 clicks clockwise should show +90 deg, got {a}");
        // coarse (shift) clicks turn the knob exactly the same amount
        deck.wheel(&h, 1.0, true, &mut f, &mut s);
        settle(&mut deck, &f, &s);
        let b = cw_deg(&mut deck, id);
        assert!((b - a - 11.25).abs() < 1.0, "{id}: one shift click = one detent, got {}", b - a);
        // wheel-down turns it back counter-clockwise
        for _ in 0..9 {
            deck.wheel(&h, -1.0, false, &mut f, &mut s);
        }
        settle(&mut deck, &f, &s);
        let z = cw_deg(&mut deck, id);
        assert!(z.abs() < 2.5, "{id}: back at rest, got {z}");
    }
    // a mouse drag turns the knob too: 14 px up = one clockwise click
    let h = hit(&deck, "alt-sel");
    let (alt0, a0) = (f.ap.alt_ft, deck.group("alt-sel").unwrap().angle);
    deck.press(&h, 0, false, &mut f, &mut s); // click = PUSH (managed)
    deck.drag(0.0, -14.0 * 3.0, &mut f, &mut s);
    deck.release(&mut f, &mut s);
    assert!(deck.group("alt-sel").unwrap().angle > a0 + 2.9 * fcu::CLICK_RAD);
    assert!(f.ap.alt_ft > alt0, "drag up raises the altitude: {} -> {}", alt0, f.ap.alt_ft);
}

#[test]
fn window_knob_values_follow_the_clicks_through_the_mouse_path() {
    let Some(mut deck) = load() else { return };
    let (mut f, mut s) = flight();
    selected(&mut f, &mut s);
    let (a, sp, hd, vs) = (hit(&deck, "alt-sel"), hit(&deck, "spd-sel"), hit(&deck, "hdg_sel"), hit(&deck, "vs-sel"));
    deck.wheel(&a, 1.0, false, &mut f, &mut s);
    assert_eq!(f.ap.alt_ft, 10_100.0);
    deck.wheel(&a, 1.0, true, &mut f, &mut s);
    assert_eq!(f.ap.alt_ft, 11_100.0);
    deck.wheel(&sp, 1.0, true, &mut f, &mut s);
    assert_eq!(f.ap.spd, 260.0);
    deck.wheel(&hd, -1.0, false, &mut f, &mut s);
    assert_eq!(f.ap.hdg, 89.0);
    // V/S: pre-select, then PULL (right click) engages, PUSH (left click) levels off
    deck.wheel(&vs, 1.0, true, &mut f, &mut s);
    assert_eq!(s.vs_target, 500.0);
    press_release(&mut deck, &mut f, &mut s, "vs-sel", 2, false);
    fcu::sync(0.0, &mut f, &mut s);
    assert!(s.vs_mode && f.ap.vs_hold_fpm == Some(500.0));
    press_release(&mut deck, &mut f, &mut s, "vs-sel", 0, false);
    assert_eq!(f.ap.vs_hold_fpm, Some(0.0));
    // Shift + click = pull as well (trackpads without a right button)
    press_release(&mut deck, &mut f, &mut s, "spd-sel", 0, false); // push: managed
    assert!(s.spd_managed && !f.ap.spd_selected);
    press_release(&mut deck, &mut f, &mut s, "spd-sel", 0, true);
    assert!(!s.spd_managed && f.ap.spd_selected, "shift+click pulls");
}

#[test]
fn push_pull_knobs_plunge_while_held_and_spring_back() {
    let Some(mut deck) = load() else { return };
    let (mut f, mut s) = flight();
    selected(&mut f, &mut s);
    settle(&mut deck, &f, &s);
    assert!(travel(&deck, "hdg_sel").abs() < 1e-5);
    // PUSH: dips ~2.5 mm into the panel while the button is down
    let h = hit(&deck, "hdg_sel");
    deck.press(&h, 0, false, &mut f, &mut s);
    settle(&mut deck, &f, &s);
    let pushed = travel(&deck, "hdg_sel");
    assert!((pushed + 0.0025).abs() < 4e-4, "pushed travel {pushed}");
    deck.release(&mut f, &mut s);
    settle(&mut deck, &f, &s);
    assert!(travel(&deck, "hdg_sel").abs() < 2e-4, "springs back");
    // PULL: comes ~4 mm out
    deck.press(&h, 2, false, &mut f, &mut s);
    settle(&mut deck, &f, &s);
    let pulled = travel(&deck, "hdg_sel");
    assert!((pulled - 0.004).abs() < 5e-4, "pulled travel {pulled}");
    deck.release(&mut f, &mut s);
    settle(&mut deck, &f, &s);
    assert!(travel(&deck, "hdg_sel").abs() < 2e-4);
    // the EFIS BARO knob stays out while STD is selected
    press_release(&mut deck, &mut f, &mut s, "qnh_cpt_knb", 2, false);
    assert!(s.efis[0].std);
    settle(&mut deck, &f, &s);
    assert!((travel(&deck, "qnh_cpt_knb") - 0.004).abs() < 5e-4, "STD = pulled out");
    press_release(&mut deck, &mut f, &mut s, "qnh_cpt_knb", 0, false);
    assert!(!s.efis[0].std);
    settle(&mut deck, &f, &s);
    assert!(travel(&deck, "qnh_cpt_knb").abs() < 2e-4, "QNH = pushed in");
}

#[test]
fn fcu_buttons_drive_the_autopilot_light_their_leds_and_depress() {
    let Some(mut deck) = load() else { return };
    let (mut f, mut s) = flight();
    f.fm.wow = false;
    f.fm.gs = 150.0 * inflight::geo::KT;
    let lit = |deck: &Deck, f: &Flight, s: &A320Systems, b: &str| deck.lamp_lit(b, s, f).unwrap_or_else(|| panic!("no lamp {b}"));
    for b in ["ap1", "ap2", "a-thr", "appr", "loc", "exped"] {
        assert!(!lit(&deck, &f, &s, b), "{b} dark at start");
    }
    // AP1 -> AP + LED, AP2 alongside, then each channel drops on its own
    press_release(&mut deck, &mut f, &mut s, "ap1", 0, false);
    assert!(f.ap.on && lit(&deck, &f, &s, "ap1") && !lit(&deck, &f, &s, "ap2"));
    assert!(lit(&deck, &f, &s, "a-thr"), "A/THR lit with the autopilot engaged");
    press_release(&mut deck, &mut f, &mut s, "ap2", 0, false);
    assert!(lit(&deck, &f, &s, "ap2"));
    press_release(&mut deck, &mut f, &mut s, "ap1", 0, false);
    assert!(f.ap.on && !lit(&deck, &f, &s, "ap1") && lit(&deck, &f, &s, "ap2"));
    // APPR / LOC / EXPED
    press_release(&mut deck, &mut f, &mut s, "appr", 0, false);
    assert!(f.ap.appr && lit(&deck, &f, &s, "appr"));
    press_release(&mut deck, &mut f, &mut s, "appr", 0, false);
    assert!(!f.ap.appr && !lit(&deck, &f, &s, "appr"));
    press_release(&mut deck, &mut f, &mut s, "loc", 0, false);
    assert!(lit(&deck, &f, &s, "loc"));
    press_release(&mut deck, &mut f, &mut s, "loc", 0, false);
    assert!(!lit(&deck, &f, &s, "loc"));
    press_release(&mut deck, &mut f, &mut s, "exped", 0, false);
    assert!(f.ap.expedite && lit(&deck, &f, &s, "exped"));
    press_release(&mut deck, &mut f, &mut s, "ap2", 0, false); // last channel off -> AP off -> EXPED drops
    fcu::sync(0.0, &mut f, &mut s);
    assert!(!f.ap.on && !lit(&deck, &f, &s, "exped") && !lit(&deck, &f, &s, "ap2"));
    // A/THR on its own
    press_release(&mut deck, &mut f, &mut s, "a-thr", 0, false);
    assert!(lit(&deck, &f, &s, "a-thr"));
    press_release(&mut deck, &mut f, &mut s, "a-thr", 0, false);
    assert!(!lit(&deck, &f, &s, "a-thr"));
    // a push-button moves ~1.8 mm into the panel while pressed and comes back on release
    settle(&mut deck, &f, &s);
    let h = hit(&deck, "a-thr");
    let base = deck.group("a-thr").unwrap().xf.w_axis.truncate();
    deck.press(&h, 0, false, &mut f, &mut s);
    settle(&mut deck, &f, &s);
    let dip = (deck.group("a-thr").unwrap().xf.w_axis.truncate() - base).dot(deck.group("a-thr").unwrap().nrm);
    assert!(dip < -0.001 && dip > -0.004, "pressed: moved {dip} m along the normal");
    deck.release(&mut f, &mut s);
    // lamp test lights everything the FCU owns
    s.lamp_test = 1.0;
    assert!(deck.lamp_lit("master_caution", &s, &f).unwrap_or(true));
}

#[test]
fn fcu_legends_and_managed_dots_follow_the_selectors() {
    let Some(mut deck) = load() else { return };
    let (mut f, mut s) = flight();
    selected(&mut f, &mut s);
    let vis = |deck: &Deck, f: &Flight, s: &A320Systems, n: &str| {
        let mut out = Vec::new();
        deck.slots(s, f, &mut out);
        let i = deck.lamp_slot(&format!("fcu:{n}")).unwrap_or_else(|| panic!("legend {n}"));
        out[i].mul[3] >= 0.5
    };
    assert!(vis(&deck, &f, &s, "spd.ind") && !vis(&deck, &f, &s, "mach.ind"));
    assert!(vis(&deck, &f, &s, "hdg.ind") && vis(&deck, &f, &s, "vs.ind") && !vis(&deck, &f, &s, "trk.ind") && !vis(&deck, &f, &s, "fpa.ind"));
    press_release(&mut deck, &mut f, &mut s, "spd-mach", 0, false);
    assert!(vis(&deck, &f, &s, "mach.ind") && !vis(&deck, &f, &s, "spd.ind"), "SPD -> MACH legend");
    press_release(&mut deck, &mut f, &mut s, "hdg-vs", 0, false);
    for n in ["trk.ind", "trk2.ind", "fpa.ind", "fpa.ind.001"] {
        assert!(vis(&deck, &f, &s, n), "{n} lit in TRK / FPA");
    }
    for n in ["hdg.ind", "hdg2.ind", "vs.ind", "vs.ind.001"] {
        assert!(!vis(&deck, &f, &s, n), "{n} dark in TRK / FPA");
    }
    press_release(&mut deck, &mut f, &mut s, "hdg-vs", 0, false);
    assert!(vis(&deck, &f, &s, "hdg.ind") && !vis(&deck, &f, &s, "trk.ind"));
    // managed dots: SPD / ALT managed (push) light their dots, HDG managed lights the LAT dot
    assert!(!vis(&deck, &f, &s, "spd.fmgc") && !vis(&deck, &f, &s, "lat.fmgc") && !vis(&deck, &f, &s, "ver.fmgc"));
    press_release(&mut deck, &mut f, &mut s, "spd-sel", 0, false);
    press_release(&mut deck, &mut f, &mut s, "alt-sel", 0, false);
    press_release(&mut deck, &mut f, &mut s, "hdg_sel", 0, false);
    fcu::sync(0.0, &mut f, &mut s);
    assert!(vis(&deck, &f, &s, "spd.fmgc") && vis(&deck, &f, &s, "lat.fmgc") && vis(&deck, &f, &s, "ver.fmgc"), "all three managed dots lit");
    press_release(&mut deck, &mut f, &mut s, "spd-sel", 2, false);
    assert!(!vis(&deck, &f, &s, "spd.fmgc"), "pull = selected: dot out");
    // LVL/CH legend when the aircraft is far from the FCU altitude
    f.fm.pos.y = 2_000.0 * inflight::geo::FT;
    assert!(vis(&deck, &f, &s, "lvlch.ind"));
    // an unpowered FCU is dark
    s.ac = false;
    for n in ["spd.ind", "hdg.ind", "vs.ind", "lvlch.ind", "spd.fmgc"] {
        assert!(!vis(&deck, &f, &s, n), "{n} dark without AC power");
    }
}

#[test]
fn alt_ring_efis_unit_ring_and_nd_selectors_work_and_pose_correctly() {
    let Some(mut deck) = load() else { return };
    let (mut f, mut s) = flight();
    selected(&mut f, &mut s);
    settle(&mut deck, &f, &s);
    // ALT 100 / 1000 ring: left = 100, right = 1000 (pose follows)
    assert!(!s.alt_step_1000);
    let r0 = cw_deg(&mut deck, "alt-sel-mode");
    press_release(&mut deck, &mut f, &mut s, "alt-sel-mode", 0, false);
    assert!(s.alt_step_1000);
    settle(&mut deck, &f, &s);
    let r1 = cw_deg(&mut deck, "alt-sel-mode");
    assert!(r1 - r0 > 40.0, "ring turns clockwise to 1000: {r0} -> {r1}");
    let a = hit(&deck, "alt-sel");
    deck.wheel(&a, 1.0, false, &mut f, &mut s);
    assert_eq!(f.ap.alt_ft, 11_000.0, "1000 ft per click with the ring on 1000");
    press_release(&mut deck, &mut f, &mut s, "alt-sel-mode", 0, false);
    assert!(!s.alt_step_1000);
    deck.wheel(&a, -1.0, false, &mut f, &mut s);
    assert_eq!(f.ap.alt_ft, 10_900.0);
    // wheel on the ring itself
    deck.wheel(&hit(&deck, "alt-sel-mode"), 1.0, false, &mut f, &mut s);
    assert!(s.alt_step_1000);
    deck.wheel(&hit(&deck, "alt-sel-mode"), -1.0, false, &mut f, &mut s);
    assert!(!s.alt_step_1000);

    // EFIS BARO unit ring: click flips hPa <-> inHg every time (state-based), pose +40 / -40 deg
    for side in 0..2 {
        let id = if side == 0 { "qnh_cpt_sw" } else { "qnh_fo_sw" };
        assert!(!s.efis[side].unit_in_hg);
        settle(&mut deck, &f, &s);
        let hpa = cw_deg(&mut deck, id);
        press_release(&mut deck, &mut f, &mut s, id, 0, false);
        assert!(s.efis[side].unit_in_hg, "{id}: inHg");
        press_release(&mut deck, &mut f, &mut s, id, 0, false);
        assert!(!s.efis[side].unit_in_hg, "{id}: second click goes back to hPa");
        press_release(&mut deck, &mut f, &mut s, id, 0, false);
        settle(&mut deck, &f, &s);
        let inhg = cw_deg(&mut deck, id);
        assert!(hpa - inhg > 70.0, "{id}: hPa stop is clockwise of the inHg stop ({hpa} vs {inhg})");
        deck.wheel(&hit(&deck, id), 1.0, false, &mut f, &mut s);
        assert!(!s.efis[side].unit_in_hg, "{id}: wheel up = clockwise = hPa");
    }

    // BARO knob: 1 hPa per click, ignored while STD
    let q0 = s.efis[0].hpa;
    let q = hit(&deck, "qnh_cpt_knb");
    deck.wheel(&q, 1.0, false, &mut f, &mut s);
    deck.wheel(&q, 1.0, false, &mut f, &mut s);
    assert_eq!(s.efis[0].hpa, q0 + 2);
    press_release(&mut deck, &mut f, &mut s, "qnh_cpt_knb", 2, false);
    deck.wheel(&q, 1.0, false, &mut f, &mut s);
    assert_eq!(s.efis[0].hpa, q0 + 2, "STD ignores the knob");
    assert_eq!(s.baro_setting_hpa(0), 1013.25);

    // ND MODE (5 stops) and ND RANGE (6 stops): 45 deg per stop, end stops, click = next / right-click = previous
    for (id, field) in [("nd_mode", 0), ("nd_range", 1)] {
        let get = |s: &A320Systems| if field == 0 { s.efis[0].nd_mode } else { s.efis[0].nd_range };
        let max = if field == 0 { 4 } else { 5 };
        for _ in 0..8 {
            deck.wheel(&hit(&deck, id), -1.0, false, &mut f, &mut s);
        }
        assert_eq!(get(&s), 0, "{id} counter-clockwise end stop");
        settle(&mut deck, &f, &s);
        let mut prev = cw_deg(&mut deck, id);
        for stop in 1..=max {
            press_release(&mut deck, &mut f, &mut s, id, 0, false);
            assert_eq!(get(&s), stop, "{id}: click = next stop");
            settle(&mut deck, &f, &s);
            let a = cw_deg(&mut deck, id);
            assert!((wrap(a - prev) - 45.0).abs() < 1.5, "{id}: stop {stop} is 45 deg clockwise of the previous one ({prev} -> {a})");
            prev = a;
        }
        press_release(&mut deck, &mut f, &mut s, id, 0, false);
        assert_eq!(get(&s), max, "{id}: clockwise end stop holds");
        press_release(&mut deck, &mut f, &mut s, id, 2, false);
        assert_eq!(get(&s), max - 1, "{id}: right-click = previous");
        deck.wheel(&hit(&deck, id), 1.0, false, &mut f, &mut s);
        assert_eq!(get(&s), max, "{id}: wheel up = clockwise");
    }

    // ADF / OFF / VOR levers: OFF -> VOR -> ADF -> OFF, right-click reverses, pose follows
    for (id, side, i) in [("vor-adf1", 0, 0), ("vor-adf2", 0, 1), ("vor-adf-1-right", 1, 0), ("vor-adf-2-right", 1, 1)] {
        assert_eq!(s.efis[side].nav[i], 0);
        press_release(&mut deck, &mut f, &mut s, id, 0, false);
        assert_eq!(s.efis[side].nav[i], 1, "{id}: VOR");
        settle(&mut deck, &f, &s);
        let vor = cw_deg(&mut deck, id);
        press_release(&mut deck, &mut f, &mut s, id, 0, false);
        assert_eq!(s.efis[side].nav[i], -1, "{id}: ADF");
        settle(&mut deck, &f, &s);
        let adf = cw_deg(&mut deck, id);
        assert!((vor - adf).abs() > 40.0, "{id}: lever swings between VOR and ADF ({vor} vs {adf})");
        press_release(&mut deck, &mut f, &mut s, id, 0, false);
        assert_eq!(s.efis[side].nav[i], 0, "{id}: OFF");
        press_release(&mut deck, &mut f, &mut s, id, 2, false);
        assert_eq!(s.efis[side].nav[i], -1, "{id}: reverse");
        press_release(&mut deck, &mut f, &mut s, id, 2, false);
        press_release(&mut deck, &mut f, &mut s, id, 2, false);
        assert_eq!(s.efis[side].nav[i], 0);
    }

    // EFIS push-buttons: FD / LS toggle, CSTR..ARPT are mutually exclusive
    press_release(&mut deck, &mut f, &mut s, "fd1", 0, false);
    assert!(!s.efis[0].fd);
    press_release(&mut deck, &mut f, &mut s, "fd1", 0, false);
    assert!(s.efis[0].fd);
    press_release(&mut deck, &mut f, &mut s, "ils2", 0, false);
    assert!(s.efis[1].ls);
    press_release(&mut deck, &mut f, &mut s, "wpt", 0, false);
    press_release(&mut deck, &mut f, &mut s, "arpt", 0, false);
    assert_eq!(s.efis[0].opt, Some(inflight::a320sys::NdOpt::Arpt));
    assert_eq!(deck.lamp_lit("arpt", &s, &f), Some(true));
    assert_eq!(deck.lamp_lit("wpt", &s, &f), Some(false));
    press_release(&mut deck, &mut f, &mut s, "arpt", 0, false);
    assert_eq!(s.efis[0].opt, None);
}

#[test]
fn fcu_brightness_knobs_dim_the_windows() {
    let Some(mut deck) = load() else { return };
    let (mut f, mut s) = flight();
    selected(&mut f, &mut s);
    assert_eq!(s.bright.fcu, 1.0);
    let h = hit(&deck, "fcu_integ_knb1");
    for _ in 0..3 {
        deck.wheel(&h, -1.0, false, &mut f, &mut s);
    }
    assert!((s.bright.fcu - 0.7).abs() < 1e-5, "{}", s.bright.fcu);
    for _ in 0..20 {
        deck.wheel(&h, -1.0, false, &mut f, &mut s);
    }
    assert!((s.bright.fcu - 0.2).abs() < 1e-5, "floor keeps the windows readable: {}", s.bright.fcu);
    settle(&mut deck, &f, &s);
    let low = cw_deg(&mut deck, "fcu_integ_knb1");
    for _ in 0..4 {
        deck.wheel(&h, 1.0, false, &mut f, &mut s);
    }
    assert!((s.bright.fcu - 0.6).abs() < 1e-5, "{}", s.bright.fcu);
    settle(&mut deck, &f, &s);
    let mid = cw_deg(&mut deck, "fcu_integ_knb1");
    for _ in 0..20 {
        deck.wheel(&h, 1.0, false, &mut f, &mut s);
    }
    assert_eq!(s.bright.fcu, 1.0);
    settle(&mut deck, &f, &s);
    let high = cw_deg(&mut deck, "fcu_integ_knb1");
    // 270 deg dimmer sweep: 0.2 -> 0.6 is half of it (135 deg), 0.6 -> 1.0 the other half
    assert!((wrap(mid - low) - 135.0).abs() < 2.0 && (wrap(high - mid) - 135.0).abs() < 2.0, "dimmer sweep {low} -> {mid} -> {high}");
    assert_eq!(fcu::display(&f, &s).brightness, 1.0);
}

#[test]
fn display_matches_what_the_pilot_dialled_in() {
    let Some(mut deck) = load() else { return };
    let (mut f, mut s) = flight();
    selected(&mut f, &mut s);
    let d = fcu::display(&f, &s);
    assert_eq!((d.spd.as_str(), d.hdg.as_str(), d.alt.as_str(), d.vs.as_str()), ("250", "090", "10000", "-----"));
    deck.wheel(&hit(&deck, "alt-sel"), 1.0, true, &mut f, &mut s);
    deck.wheel(&hit(&deck, "hdg_sel"), -1.0, true, &mut f, &mut s);
    deck.wheel(&hit(&deck, "spd-sel"), 1.0, false, &mut f, &mut s);
    let d = fcu::display(&f, &s);
    assert_eq!((d.spd.as_str(), d.hdg.as_str(), d.alt.as_str()), ("251", "080", "11000"));
    let hover = deck.hover_info(&hit(&deck, "spd-sel"), &s, &f);
    assert!(hover.value.contains("251") && hover.value.contains("SELECTED"), "{}", hover.value);
    assert!(hover.hint.contains("PUSH") && hover.hint.contains("PULL"));
    // slot buffer stays consistent with the baked mesh
    let mut slots = Vec::new();
    deck.update(DT, &f, &s);
    deck.slots(&s, &f, &mut slots);
    assert_eq!(slots.len(), deck.gpu_mesh().slot_count);
}
