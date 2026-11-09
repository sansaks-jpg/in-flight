//! Every PFD / ND related control of the REAL 3D flight deck (EFIS control panels, brightness knobs, source switching):
//! classification, ray picking, click / right-click / wheel / drag behaviour, tooltip text and the visible pose
//! (how the knob or lever looks when it is turned). Skipped when the cockpit add-on is not installed
//! (set `INFLIGHT_ADDON_DIR`, or download it through the Marketplace first). No GPU needed.

use glam::{Mat4, Quat, Vec3};
use inflight::a320sys::{A320Systems, NdOpt};
use inflight::addons::AddonManager;
use inflight::airports::AirportDb;
use inflight::deck::{efis_fn, efis_hint, efis_knob_theta, efis_phi_deg, efis_text, knob_rest_deg, nav_lever_theta, src_click_dir, Deck, EfisFn, Kind};
use inflight::game::Flight;
use inflight::glb;
use inflight::specs::A320;

const T0: f64 = 1_718_884_800.0;

fn load() -> Option<Deck> {
    let (bytes, man) = AddonManager::new().read_installed()?;
    Some(Deck::new(glb::parse(&bytes).expect("GLB parses"), man.as_deref(), A320.eye))
}

fn flight() -> Flight {
    Flight::new(&AirportDb::embedded(), "KSFO", "KOAK", T0).expect("flight")
}

#[allow(dead_code)]
fn ray_to(deck: &Deck, id: &str) -> (Vec3, Vec3) {
    let g = deck.group(id).unwrap_or_else(|| panic!("missing control {id}"));
    let c = deck.to_body.transform_point3((g.bmin + g.bmax) * 0.5);
    let eye = Vec3::new(A320.eye[0] as f32, A320.eye[1] as f32, A320.eye[2] as f32);
    (eye, (c - eye).normalize())
}

fn hit(deck: &Deck, id: &str) -> Option<inflight::deck::Hit> {
    // aim across the whole box: nested controls (a ring around a knob) cannot be hit through their own centre
    let g = deck.group(id).unwrap_or_else(|| panic!("missing control {id}"));
    let eye = Vec3::new(A320.eye[0] as f32, A320.eye[1] as f32, A320.eye[2] as f32);
    let n = 6;
    for i in 0..=n {
        for j in 0..=n {
            for k in 0..=n {
                let t = Vec3::new(i as f32, j as f32, k as f32) / n as f32;
                let c = deck.to_body.transform_point3(g.bmin + (g.bmax - g.bmin) * t);
                if let Some(h) = deck.pick(eye, (c - eye).normalize()) {
                    if deck.groups[h.group].id == id {
                        return Some(h);
                    }
                }
            }
        }
    }
    None
}

fn click(deck: &mut Deck, f: &mut Flight, s: &mut A320Systems, id: &str, button: u8) {
    let h = hit(deck, id).unwrap_or_else(|| panic!("ray at {id} does not pick it"));
    deck.press(&h, button, false, f, s);
    deck.release(f, s);
}

fn wheel(deck: &mut Deck, f: &mut Flight, s: &mut A320Systems, id: &str, dy: f32) {
    let h = hit(deck, id).unwrap_or_else(|| panic!("ray at {id} does not pick it"));
    assert!(deck.wheel(&h, dy, false, f, s), "{id}: wheel not consumed");
}

fn settle(deck: &mut Deck, f: &Flight, s: &A320Systems) {
    deck.update(0.016, f, s);
}

/// Rotation angle (deg) of the pose change of a group between two states.
fn turned_deg(a: &Mat4, b: &Mat4) -> f32 {
    let r = *b * a.inverse();
    let q = Quat::from_mat4(&r).normalize();
    let (_, ang) = q.to_axis_angle();
    let ang = if ang > std::f32::consts::PI { ang - std::f32::consts::TAU } else { ang };
    ang.to_degrees().abs()
}

const ALL: &[&str] = &[
    "fd1", "fd2", "ils", "ils2", "cstr", "cstr.001", "wpt", "wpt.001", "vord", "vord.001", "ndb", "ndb.001", "arpt", "arpt.001", "nd_mode", "nd_mode_fo", "nd_range", "nd_range_fo", "qnh_cpt_knb",
    "qnh_fo_knb", "qnh_cpt_sw", "qnh_fo_sw", "vor-adf1", "vor-adf2", "vor-adf-1-right", "vor-adf-2-right", "pfd_nd_xfr_sw", "pfd_nd_xfr_sw2", "pfd_brt_cpt", "pfd_brt_fo", "brightness_nd_2_cpt",
    "brightness_nd_2_fo", "brightness_nd_1_cpt", "brightness_nd_1_fo", "terr_on_nd_l", "terr_on_nd_r",
];

#[test]
fn every_efis_control_exists_is_classified_and_can_be_picked() {
    let Some(deck) = load() else { return eprintln!("cockpit add-on not installed: skipping") };
    let mut report = Vec::new();
    for id in ALL {
        let g = deck.group(id).unwrap_or_else(|| panic!("control {id} missing from the model"));
        let picked = hit(&deck, id).is_some();
        report.push(format!("{id:22} {:?} picked={picked}", g.kind));
        assert!(efis_fn(id).is_some(), "{id} not in the EFIS map");
    }
    println!("{}", report.join("\n"));
    for id in ["nd_mode", "nd_mode_fo", "nd_range", "nd_range_fo", "qnh_cpt_knb", "qnh_fo_knb", "pfd_brt_cpt", "pfd_brt_fo", "brightness_nd_2_cpt", "brightness_nd_1_fo"] {
        assert_eq!(deck.group(id).unwrap().kind, Kind::Knob, "{id} must be a rotary");
    }
    for id in ["pfd_nd_xfr_sw", "pfd_nd_xfr_sw2"] {
        assert_eq!(deck.group(id).unwrap().kind, Kind::Switch, "{id}");
    }
    let unpicked: Vec<_> = report.iter().filter(|r| r.ends_with("false")).collect();
    assert!(unpicked.len() <= 4, "too many EFIS controls cannot be picked from the captain's eye: {unpicked:?}");
}

#[test]
fn push_buttons_toggle_their_state_and_light_up() {
    let Some(mut deck) = load() else { return eprintln!("skipping") };
    let (mut f, mut s) = (flight(), A320Systems::default());
    for (id, side) in [("fd1", 0), ("fd2", 1)] {
        let before = s.efis[side].fd;
        click(&mut deck, &mut f, &mut s, id, 0);
        assert_ne!(s.efis[side].fd, before, "{id}");
        click(&mut deck, &mut f, &mut s, id, 0);
        assert_eq!(s.efis[side].fd, before, "{id} toggles back");
    }
    for (id, side) in [("ils", 0), ("ils2", 1)] {
        click(&mut deck, &mut f, &mut s, id, 0);
        assert!(s.efis[side].ls, "{id}");
        assert!(deck.group(id).is_some());
    }
    // CSTR / WPT / VOR.D / NDB / ARPT: exclusive per side, pressing the lit one clears it
    for (side, suffix) in [(0usize, ""), (1, ".001")] {
        for (base, k) in [("cstr", NdOpt::Cstr), ("wpt", NdOpt::Wpt), ("vord", NdOpt::Vord), ("ndb", NdOpt::Ndb), ("arpt", NdOpt::Arpt)] {
            let id = format!("{base}{suffix}");
            click(&mut deck, &mut f, &mut s, &id, 0);
            assert_eq!(s.efis[side].opt, Some(k), "{id}");
            assert_eq!(s.efis[1 - side].opt, None, "the other panel is independent");
        }
        click(&mut deck, &mut f, &mut s, &format!("arpt{suffix}"), 0);
        assert_eq!(s.efis[side].opt, None, "second press clears");
    }
    click(&mut deck, &mut f, &mut s, "terr_on_nd_l", 0);
    click(&mut deck, &mut f, &mut s, "terr_on_nd_r", 0);
    assert_eq!(s.terr_on_nd, [true, true]);
    for (id, side) in [("pfd_nd_xfr_sw", 0), ("pfd_nd_xfr_sw2", 1)] {
        click(&mut deck, &mut f, &mut s, id, 0);
        assert!(s.efis[side].xfr, "{id}");
        settle(&mut deck, &f, &s);
        assert_eq!(deck.group(id).unwrap().pos, 1, "{id}: switch lever follows the state");
        click(&mut deck, &mut f, &mut s, id, 0);
        assert!(!s.efis[side].xfr);
    }
}

#[test]
fn nd_mode_and_range_knobs_step_with_click_wheel_and_drag() {
    let Some(mut deck) = load() else { return eprintln!("skipping") };
    let (mut f, mut s) = (flight(), A320Systems::default());
    for (id, side) in [("nd_mode", 0usize), ("nd_mode_fo", 1)] {
        assert_eq!(s.efis[side].nd_mode, 3);
        click(&mut deck, &mut f, &mut s, id, 0); // click = next
        assert_eq!(s.efis[side].nd_mode, 4);
        click(&mut deck, &mut f, &mut s, id, 0);
        assert_eq!(s.efis[side].nd_mode, 4, "PLAN is the end stop");
        click(&mut deck, &mut f, &mut s, id, 2); // right-click = previous
        assert_eq!(s.efis[side].nd_mode, 3);
        for _ in 0..10 {
            wheel(&mut deck, &mut f, &mut s, id, -1.0);
        }
        assert_eq!(s.efis[side].nd_mode, 0, "wheel down turns anticlockwise down to LS");
        wheel(&mut deck, &mut f, &mut s, id, 1.0);
        assert_eq!(s.efis[side].nd_mode, 1);
    }
    for (id, side) in [("nd_range", 0usize), ("nd_range_fo", 1)] {
        let r0 = s.efis[side].nd_range;
        wheel(&mut deck, &mut f, &mut s, id, 1.0);
        assert_eq!(s.efis[side].nd_range, r0 + 1);
        for _ in 0..12 {
            wheel(&mut deck, &mut f, &mut s, id, 1.0);
        }
        assert_eq!(s.efis[side].nd_range, 5, "320 NM end stop");
        // drag: press, move the mouse up by 3 knob clicks, release
        let h = hit(&deck, id).unwrap();
        deck.press(&h, 0, false, &mut f, &mut s); // click-step to the next detent (clamped)
        deck.drag(0.0, -14.0 * 6.0, &mut f, &mut s);
        deck.release(&mut f, &mut s);
        assert_eq!(s.efis[side].nd_range, 5);
        for _ in 0..12 {
            wheel(&mut deck, &mut f, &mut s, id, -1.0);
        }
        assert_eq!(s.efis[side].nd_range, 0);
        let h = hit(&deck, id).unwrap();
        deck.press(&h, 0, false, &mut f, &mut s);
        deck.drag(0.0, -14.0 * 2.0, &mut f, &mut s);
        deck.release(&mut f, &mut s);
        assert_eq!(s.efis[side].nd_range, 3, "1 (press) + 2 (drag) detents");
    }
}

#[test]
fn baro_knob_turn_push_pull_and_unit_ring() {
    let Some(mut deck) = load() else { return eprintln!("skipping") };
    let (mut f, mut s) = (flight(), A320Systems::default());
    s.follow_qnh(1013.0);
    for (knob, ring, side) in [("qnh_cpt_knb", "qnh_cpt_sw", 0usize), ("qnh_fo_knb", "qnh_fo_sw", 1)] {
        wheel(&mut deck, &mut f, &mut s, knob, 1.0);
        wheel(&mut deck, &mut f, &mut s, knob, 1.0);
        assert_eq!(s.efis[side].hpa, 1015, "{knob}");
        wheel(&mut deck, &mut f, &mut s, knob, -1.0);
        assert_eq!(s.efis[side].hpa, 1014);
        // right-click = PULL = STD, left-click = PUSH = back to QNH
        click(&mut deck, &mut f, &mut s, knob, 2);
        assert!(s.efis[side].std, "{knob}: right-click pulls to STD");
        wheel(&mut deck, &mut f, &mut s, knob, 1.0);
        assert_eq!(s.efis[side].hpa, 1014, "turning while STD does nothing");
        click(&mut deck, &mut f, &mut s, knob, 0);
        assert!(!s.efis[side].std, "{knob}: left-click pushes back");
        // unit ring: click toggles, wheel selects
        click(&mut deck, &mut f, &mut s, ring, 0);
        let first = s.efis[side].unit_in_hg;
        click(&mut deck, &mut f, &mut s, ring, 0);
        assert_ne!(first, s.efis[side].unit_in_hg, "{ring} toggles");
        wheel(&mut deck, &mut f, &mut s, ring, 1.0);
        assert!(!s.efis[side].unit_in_hg, "{ring}: wheel up = hPa");
        wheel(&mut deck, &mut f, &mut s, ring, -1.0);
        assert!(s.efis[side].unit_in_hg, "{ring}: wheel down = inHg");
        click(&mut deck, &mut f, &mut s, ring, 0);
    }
    assert!(s.baro_touched[0] && s.baro_touched[1]);
}

#[test]
fn adf_vor_switches_cycle_both_ways() {
    let Some(mut deck) = load() else { return eprintln!("skipping") };
    let (mut f, mut s) = (flight(), A320Systems::default());
    for (id, side, i) in [("vor-adf1", 0usize, 0usize), ("vor-adf2", 0, 1), ("vor-adf-1-right", 1, 0), ("vor-adf-2-right", 1, 1)] {
        if hit(&deck, id).is_none() {
            eprintln!("{id}: not reachable by a ray from the eye (occluded) - state logic tested through press()");
        }
        let hit = inflight::deck::Hit { group: deck.groups.iter().position(|x| x.id == id).unwrap(), dist: 1.0 };
        for expect in [1i8, -1, 0, 1] {
            deck.press(&hit, 0, false, &mut f, &mut s);
            deck.release(&mut f, &mut s);
            assert_eq!(s.efis[side].nav[i], expect, "{id}: OFF -> VOR -> ADF -> OFF");
        }
        deck.press(&hit, 2, false, &mut f, &mut s); // right-click reverses
        deck.release(&mut f, &mut s);
        assert_eq!(s.efis[side].nav[i], 0, "{id}: VOR -> OFF when reversed");
        settle(&mut deck, &f, &s);
        assert_eq!(deck.groups[hit.group].pos, 1, "{id}: lever sits at the OFF position");
    }
}

#[test]
fn brightness_knobs_dim_and_switch_the_displays_off() {
    let Some(mut deck) = load() else { return eprintln!("skipping") };
    let (mut f, mut s) = (flight(), A320Systems::default());
    for (id, side, which) in [("pfd_brt_cpt", 0usize, 0), ("pfd_brt_fo", 1, 0), ("brightness_nd_2_cpt", 0, 1), ("brightness_nd_2_fo", 1, 1), ("brightness_nd_1_cpt", 0, 2), ("brightness_nd_1_fo", 1, 2)] {
        let get = |s: &A320Systems| match which {
            0 => s.bright.pfd[side],
            1 => s.bright.nd[side],
            _ => s.bright.nd_outer[side],
        };
        let v0 = get(&s);
        wheel(&mut deck, &mut f, &mut s, id, 1.0);
        assert!(get(&s) > v0, "{id}: clockwise brightens");
        for _ in 0..40 {
            wheel(&mut deck, &mut f, &mut s, id, -1.0);
        }
        assert_eq!(get(&s), 0.0, "{id}: anticlockwise stop");
        if which < 2 {
            assert!(!(if which == 0 { s.pfd_on(side) } else { s.nd_on(side) }), "{id}: OFF at the stop");
        }
        for _ in 0..40 {
            wheel(&mut deck, &mut f, &mut s, id, 1.0);
        }
        assert_eq!(get(&s), 1.0, "{id}: clockwise stop");
    }
}

#[test]
fn source_switching_knobs_bounce_between_the_end_stops() {
    let Some(mut deck) = load() else { return eprintln!("skipping") };
    let (mut f, mut s) = (flight(), A320Systems::default());
    assert_eq!(src_click_dir(0, 1, 0.0), 1);
    assert_eq!(src_click_dir(0, 1, -1.0), -1);
    assert_eq!(src_click_dir(0, 2, 1.0), -1);
    assert_eq!(src_click_dir(0, 0, -1.0), 1);
    assert_eq!(src_click_dir(2, 0, 1.0), -1);
    for (id, k) in [("ecam_att_hdg", 0usize), ("ecam_air_data", 1), ("ecam_eis_dmc", 2), ("ecam_nd_xfr", 3)] {
        let Some(h) = hit(&deck, id) else {
            eprintln!("{id}: not reachable from the eye - skipped");
            continue;
        };
        settle(&mut deck, &f, &s);
        assert_eq!(s.switching[k], 1);
        let mut seen = vec![s.switching[k]];
        for _ in 0..4 {
            deck.press(&h, 0, false, &mut f, &mut s);
            deck.release(&mut f, &mut s);
            settle(&mut deck, &f, &s);
            seen.push(s.switching[k]);
        }
        assert_eq!(seen, vec![1, 2, 1, 0, 1], "{id}: NORM -> F/O -> NORM -> CAPT -> NORM");
    }
}

#[test]
fn knobs_are_posed_where_the_state_says_they_are() {
    let Some(mut deck) = load() else { return eprintln!("skipping") };
    let (f, mut s) = (flight(), A320Systems::default());
    let gi = |d: &Deck, id: &str| d.groups.iter().position(|g| g.id == id).unwrap();
    // ND MODE: 45 deg per detent, in the sense of the manifest axis
    for (id, side) in [("nd_mode", 0usize), ("nd_mode_fo", 1)] {
        let i = gi(&deck, id);
        let mut prev: Option<Mat4> = None;
        for mode in 0..5 {
            s.efis[side].nd_mode = mode;
            settle(&mut deck, &f, &s);
            let m = deck.groups[i].xf;
            if let Some(p) = prev {
                let d = turned_deg(&p, &m);
                assert!((d - 45.0).abs() < 0.5, "{id}: detent {mode} turned {d} deg, expected 45");
            }
            prev = Some(m);
        }
        // the first detent (LS) is the rest pose of the mesh -> no rotation at all
        s.efis[side].nd_mode = 0;
        settle(&mut deck, &f, &s);
        assert!(turned_deg(&Mat4::IDENTITY, &deck.groups[i].xf) < 0.5, "{id}: LS = mesh at rest");
    }
    for (id, side) in [("nd_range", 0usize), ("nd_range_fo", 1)] {
        let i = gi(&deck, id);
        s.efis[side].nd_range = 0;
        settle(&mut deck, &f, &s);
        let a = deck.groups[i].xf;
        s.efis[side].nd_range = 5;
        settle(&mut deck, &f, &s);
        let d = turned_deg(&a, &deck.groups[i].xf);
        assert!((d - 225.0).abs() < 0.5 || (d - 135.0).abs() < 0.5, "{id}: 10 -> 320 NM swings 5 x 45 deg (got {d})");
    }
    // brightness knob: 270 deg sweep from OFF to MAX
    for (id, side) in [("pfd_brt_cpt", 0usize), ("pfd_brt_fo", 1)] {
        let i = gi(&deck, id);
        s.bright.pfd[side] = 0.0;
        settle(&mut deck, &f, &s);
        let a = deck.groups[i].xf;
        s.bright.pfd[side] = 1.0;
        settle(&mut deck, &f, &s);
        let d = turned_deg(&a, &deck.groups[i].xf);
        assert!((d - 90.0).abs() < 0.5 || (d - 270.0).abs() < 0.5, "{id}: OFF -> MAX = 270 deg sweep (got {d})");
    }
    // baro: slides out along the panel normal by 4 mm when pulled to STD
    for (id, side) in [("qnh_cpt_knb", 0usize), ("qnh_fo_knb", 1)] {
        let i = gi(&deck, id);
        s.efis[side].std = false;
        settle(&mut deck, &f, &s);
        let p0 = deck.groups[i].xf.transform_point3(Vec3::ZERO);
        s.efis[side].std = true;
        settle(&mut deck, &f, &s);
        let p1 = deck.groups[i].xf.transform_point3(Vec3::ZERO);
        let moved = (p1 - p0).length();
        assert!((moved - 0.004).abs() < 1e-4, "{id}: STD pull travel {moved} m");
        s.efis[side].std = false;
    }
    // ADF / OFF / VOR levers swing about 0.5 rad either side
    for (id, side, n) in [("vor-adf1", 0usize, 0usize), ("vor-adf2", 0, 1), ("vor-adf-1-right", 1, 0), ("vor-adf-2-right", 1, 1)] {
        let i = gi(&deck, id);
        s.efis[side].nav[n] = 0;
        settle(&mut deck, &f, &s);
        let off = deck.groups[i].xf;
        s.efis[side].nav[n] = 1;
        settle(&mut deck, &f, &s);
        let vor = deck.groups[i].xf;
        s.efis[side].nav[n] = -1;
        settle(&mut deck, &f, &s);
        let adf = deck.groups[i].xf;
        assert!((turned_deg(&off, &vor) - 28.65).abs() < 0.5, "{id}: VOR is 0.5 rad from OFF");
        assert!((turned_deg(&off, &adf) - 28.65).abs() < 0.5, "{id}: ADF is 0.5 rad from OFF");
        assert!(turned_deg(&vor, &adf) > 50.0, "{id}: VOR and ADF are on opposite sides");
        assert_eq!(deck.groups[i].pos, 0, "ADF position index");
    }
}

#[test]
fn tooltips_describe_every_efis_state() {
    let Some(deck) = load() else { return eprintln!("skipping") };
    let (f, mut s) = (flight(), A320Systems::default());
    s.efis[0].nav = [1, -1];
    s.efis[1].xfr = true;
    s.efis[0].unit_in_hg = true;
    s.bright.pfd[0] = 0.0;
    for id in ALL {
        let i = deck.groups.iter().position(|g| g.id == *id).unwrap();
        let t = deck.state_text(i, &s, &f);
        assert!(!t.is_empty(), "{id}: empty hover text");
    }
    let t = |id: &str| deck.state_text(deck.groups.iter().position(|g| g.id == id).unwrap(), &s, &f);
    assert_eq!(t("vor-adf1"), "VOR");
    assert_eq!(t("vor-adf2"), "ADF");
    assert_eq!(t("pfd_nd_xfr_sw2"), "PFD / ND SWAPPED");
    assert_eq!(t("qnh_cpt_sw"), "inHg");
    assert_eq!(t("pfd_brt_cpt"), "OFF");
    assert_eq!(t("nd_range"), "80 NM");
    assert!(!deck.hint(deck.groups.iter().position(|g| g.id == "qnh_cpt_knb").unwrap()).is_empty());
    assert!(efis_hint(EfisFn::Baro).contains("PULL"));
}

// ----------------------------------------------------------------- pure functions (no model needed)

#[test]
fn pointer_angles_and_rotation_senses() {
    let s = A320Systems::default();
    let e = &s.efis[0];
    assert_eq!(efis_phi_deg(EfisFn::Mode, e, &s.bright, 0, 0.0), -90.0 + 3.0 * 45.0);
    assert_eq!(efis_phi_deg(EfisFn::Range, e, &s.bright, 0, 0.0), -90.0 + 3.0 * 45.0);
    assert_eq!(efis_phi_deg(EfisFn::Unit, e, &s.bright, 0, 0.0), 40.0);
    assert!((efis_phi_deg(EfisFn::Pfd, e, &s.bright, 0, 0.0) - (-135.0 + 270.0 * 0.8)).abs() < 1e-4);
    assert!((efis_phi_deg(EfisFn::Baro, e, &s.bright, 0, 1.0) - 57.29578).abs() < 1e-3);
    assert_eq!(knob_rest_deg("nd_mode"), -90.0);
    assert_eq!(knob_rest_deg("pfd_brt_cpt"), 0.0);
    // axis pointing at the pilot (+x in model space) turns the other way round
    assert!((efis_knob_theta(45.0, 0.0, 1.0) + efis_knob_theta(45.0, 0.0, -1.0)).abs() < 1e-6);
    assert!((efis_knob_theta(-90.0, -90.0, 1.0)).abs() < 1e-6, "rest detent = no rotation");
    assert_eq!(nav_lever_theta(0), 0.0);
    assert_eq!(nav_lever_theta(1), -nav_lever_theta(-1));
    assert_eq!(efis_text(EfisFn::Mode, 0, &s), "ARC");
    assert_eq!(efis_text(EfisFn::Baro, 1, &s), "1013 hPa (QNH)");
    assert_eq!(efis_text(EfisFn::Fd, 0, &s), "ON - bars shown");
}
