//! Interactive flight-deck tests against the REAL downloaded `cockpit.glb` (skipped when the add-on is not installed:
//! run the Marketplace download first, or set `INFLIGHT_ADDON_DIR`). No GPU needed - classification, picking and control
//! mechanics are pure CPU code.

use glam::Vec3;
use inflight::a320sys::A320Systems;
use inflight::addons::AddonManager;
use inflight::airports::AirportDb;
use inflight::cockpit::{CELL_EWD, CELL_ND, CELL_SD};
use inflight::deck::{Deck, Hit, Kind};
use inflight::ecam::{EcamPage, EcpKey, ECP_KEYS};
use inflight::game::Flight;
use inflight::glb;
use inflight::specs::A320;

const T0: f64 = 1_718_884_800.0;

fn load() -> Option<Deck> {
    let (bytes, man) = AddonManager::new().read_installed()?;
    let g = glb::parse(&bytes).expect("GLB parses");
    Some(Deck::new(g, man.as_deref(), A320.eye))
}

fn flight() -> Flight {
    Flight::new(&AirportDb::embedded(), "KSFO", "KOAK", T0).expect("flight")
}

/// Body-frame ray from the captain's eye through the centre of control `id` (at rest).
fn ray_to(deck: &Deck, id: &str) -> (Vec3, Vec3) {
    let g = deck.group(id).unwrap_or_else(|| panic!("missing control {id}"));
    let c = deck.to_body.transform_point3((g.bmin + g.bmax) * 0.5);
    let eye = Vec3::new(A320.eye[0] as f32, A320.eye[1] as f32, A320.eye[2] as f32);
    // aim from slightly in front of the control's panel so the ray is not blocked / starts inside nothing
    (eye, (c - eye).normalize())
}

fn click(deck: &mut Deck, f: &mut Flight, s: &mut A320Systems, id: &str, button: u8) -> bool {
    let (o, d) = ray_to(deck, id);
    let Some(hit) = deck.pick(o, d) else { return false };
    if deck.groups[hit.group].id != id {
        return false;
    }
    deck.press(&hit, button, false, f, s);
    deck.release(f, s);
    true
}

#[test]
fn classifies_the_whole_flight_deck() {
    let Some(deck) = load() else { return eprintln!("cockpit add-on not installed: skipping") };
    let counts = deck.kind_counts();
    let n = |k: Kind| counts.get(&k).copied().unwrap_or(0);
    println!("groups: {} | push {} switch {} knob {} guard {} lever {} key {} stick {}", deck.groups.len(), n(Kind::Push), n(Kind::Switch), n(Kind::Knob), n(Kind::Guard), n(Kind::Lever), n(Kind::Key), n(Kind::Stick));
    assert!(deck.groups.len() > 400, "expected hundreds of interactive controls, got {}", deck.groups.len());
    assert!(n(Kind::Push) > 150 && n(Kind::Key) > 40 && n(Kind::Knob) > 20 && n(Kind::Switch) > 10 && n(Kind::Guard) > 5);
    for (id, k) in [
        ("BatteryBtn1", Kind::Push), ("APUMasterBtn", Kind::Push), ("ap1", Kind::Push), ("spd-sel", Kind::Knob), ("hdg_sel", Kind::Knob), ("alt-sel", Kind::Knob), ("vs-sel", Kind::Knob), ("FlapsLever", Kind::Lever), ("thr_l_body", Kind::Lever),
        ("SpdBrk", Kind::Lever), ("Lcutoff", Kind::Lever), ("eng_mode", Kind::Knob), ("StrobeLtSwtch", Kind::Switch), ("EvacCommandProt", Kind::Guard), ("stick", Kind::Stick), ("qnh_cpt_knb", Kind::Knob),
    ] {
        assert_eq!(deck.group(id).map(|g| g.kind), Some(k), "control {id}");
    }
    // every control has geometry, a slot and a sane box
    for g in &deck.groups {
        assert!(!g.parts.is_empty(), "{} has no parts", g.id);
        assert!(g.bmax.x >= g.bmin.x && g.slot > 0);
    }
    // manifest axes were attached to the animated controls
    assert!(deck.group("ACFlowKnb").map(|g| g.axis.is_some()).unwrap_or(false));
    // screens: PFD x2, ND x2, E/WD (+secondary), SD
    let names: Vec<&str> = deck.screens.iter().map(|s| s.node.as_str()).collect();
    for want in ["pfd1.screen", "pfd2.screen", "ND.screen", "ND_R.screen", "uecam.screen", "lecam.screen"] {
        assert!(names.contains(&want), "screen {want} missing from {names:?}");
    }
    let gpu = deck.gpu_mesh();
    assert!(!gpu.screen_v.is_empty() && gpu.screen_i.len() % 3 == 0);
    assert!(gpu.indices.len() / 3 > 400_000, "most of the 439k triangles are drawn");
    assert!(gpu.draws.iter().map(|d| d.count).sum::<u32>() as usize == gpu.indices.len());
    assert!(gpu.slot_count < 4096);
}

#[test]
fn screens_map_onto_the_model_glass() {
    let Some(deck) = load() else { return };
    let gpu = deck.gpu_mesh();
    // every screen vertex must lie on the instrument panel inside the model's real flight deck, near the pilot
    let eye = Vec3::new(A320.eye[0] as f32, A320.eye[1] as f32, A320.eye[2] as f32);
    for v in &gpu.screen_v {
        let p = Vec3::from(v.pos);
        assert!((p - eye).length() < 1.6, "screen vertex {p:?} far from the eye");
        assert!((0.0..=1.0).contains(&v.uv[0]) && (0.0..=1.0).contains(&v.uv[1]));
    }
    // PFD and ND of the captain sit left of the E/WD (body +X is right)
    let c = |n: &str| deck.screens.iter().find(|s| s.node == n).map(|s| deck.to_body.transform_point3(s.center)).unwrap();
    assert!(c("pfd1.screen").x < c("ND.screen").x && c("ND.screen").x < c("uecam.screen").x);
    assert!(c("uecam.screen").y > c("lecam.screen").y, "E/WD above SD");
    assert!(c("pfd2.screen").x > c("uecam.screen").x, "F/O PFD on the right");
}

#[test]
fn picking_hits_the_control_under_the_cursor() {
    let Some(deck) = load() else { return };
    let mut hit_ok = 0;
    let ids = ["ap1", "spd-sel", "FlapsLever", "BatteryBtn1", "APUStartBtn", "abs_low", "fd1", "gear_lever", "master_warning"];
    for id in ids {
        let (o, d) = ray_to(&deck, id);
        if let Some(h) = deck.pick(o, d) {
            if deck.groups[h.group].id == id {
                hit_ok += 1;
            } else {
                eprintln!("ray to {id} hit {} first", deck.groups[h.group].id);
            }
        } else {
            eprintln!("ray to {id} hit nothing");
        }
    }
    assert!(hit_ok >= ids.len() - 2, "picking accuracy {hit_ok}/{}", ids.len());
    // a ray into the sky hits nothing
    assert!(deck.pick(Vec3::new(0.0, 5.0, 0.0), Vec3::Y).is_none());
}

#[test]
fn controls_drive_the_systems_and_the_flight_model() {
    let Some(mut deck) = load() else { return };
    let mut f = flight();
    let mut s = A320Systems::default();
    s.sync_from_flight(&f.fm);
    // thrust lever drag: IDLE -> TOGA gate
    let (o, d) = ray_to(&deck, "thr_l_body");
    let hit = deck.pick(o, d).expect("thrust lever pickable");
    assert_eq!(deck.groups[hit.group].id, "thr_l_body");
    deck.press(&hit, 0, false, &mut f, &mut s);
    deck.drag(0.0, -400.0, &mut f, &mut s);
    deck.release(&mut f, &mut s);
    assert!((f.fm.ctl.throttle - 1.0).abs() < 1e-9, "dragged up to TOGA, got {}", f.fm.ctl.throttle);
    // flaps by wheel
    let (o, d) = ray_to(&deck, "FlapsLever");
    if let Some(h) = deck.pick(o, d) {
        if deck.groups[h.group].id == "FlapsLever" {
            let before = f.fm.ctl.flaps_idx;
            assert!(deck.wheel(&h, -1.0, false, &mut f, &mut s));
            assert_eq!(f.fm.ctl.flaps_idx, before + 1);
        }
    }
    // gear lever click
    let g0 = f.fm.ctl.gear_down;
    if click(&mut deck, &mut f, &mut s, "gear_lever", 0) {
        assert_ne!(f.fm.ctl.gear_down, g0);
    }
    // FCU knobs by wheel: altitude +100 per click, speed, heading (windows selected: a managed window only pre-selects, see tests/fcu_panel.rs)
    f.ap.spd_selected = true;
    f.ap.alt_selected = true;
    f.ap.spd = 250.0; // inside the speed window (the FCU clamps to stall margin .. 0.85 VNE like Game.setApTarget)
    inflight::fcu::sync(0.0, &mut f, &mut s);
    for (id, field) in [("alt-sel", 0), ("spd-sel", 1), ("hdg_sel", 2)] {
        let (o, d) = ray_to(&deck, id);
        let Some(h) = deck.pick(o, d) else { continue };
        if deck.groups[h.group].id != id {
            continue;
        }
        let before = (f.ap.alt_ft, f.ap.spd, f.ap.hdg);
        assert!(deck.wheel(&h, 1.0, false, &mut f, &mut s), "{id}"); // scroll up = clockwise = increase
        match field {
            0 => assert!((f.ap.alt_ft - before.0 - 100.0).abs() < 1e-6),
            1 => assert!((f.ap.spd - before.1 - 1.0).abs() < 1e-6),
            _ => assert!((f.ap.hdg - before.2 - 1.0).abs() < 1e-6 || before.2 > 358.5),
        }
    }
    // overhead / glareshield push-buttons
    let b = s.bat[0];
    if click(&mut deck, &mut f, &mut s, "BatteryBtn1", 0) {
        assert_ne!(s.bat[0], b);
    }
    // EFIS baro knob + options
    let (o, d) = ray_to(&deck, "qnh_cpt_knb");
    if let Some(h) = deck.pick(o, d) {
        if deck.groups[h.group].id == "qnh_cpt_knb" {
            let q = s.efis[0].hpa;
            deck.wheel(&h, 1.0, false, &mut f, &mut s);
            assert_eq!(s.efis[0].hpa, q + 1);
        }
    }
    // poses animate: the lever moved away from its rest matrix after update()
    deck.update(0.016, &f, &s);
    let lever = deck.group("thr_l_body").unwrap();
    assert!(lever.xf != glam::Mat4::IDENTITY, "thrust lever must be posed");
    let mut slots = Vec::new();
    deck.slots(&s, &f, &mut slots);
    assert_eq!(slots.len(), deck.gpu_mesh().slot_count);
}

#[test]
fn guarded_buttons_need_their_cover_lifted_first() {
    let Some(mut deck) = load() else { return };
    let mut f = flight();
    let mut s = A320Systems::default();
    s.sync_from_flight(&f.fm);
    assert_eq!(deck.group("EvacCommandProt").map(|g| g.pos), Some(0));
    // clicking the button under a closed guard lifts the guard first (never actuates the button)
    let (o, d) = ray_to(&deck, "EvacCommandBtn");
    if let Some(h) = deck.pick(o, d) {
        deck.press(&h, 0, false, &mut f, &mut s);
        deck.release(&mut f, &mut s);
        assert_eq!(deck.group("EvacCommandProt").map(|g| g.pos), Some(1), "guard lifted");
        assert_eq!(deck.group("EvacCommandBtn").map(|g| g.pos), Some(0), "button untouched");
    }
}

// ====================================================================== ECAM control panel (ECP)

fn hit(deck: &Deck, id: &str) -> Hit {
    Hit { group: *deck.by_id.get(id).unwrap_or_else(|| panic!("missing control {id}")), dist: 1.0 }
}

/// One simulated frame of the systems + deck animation.
fn frame(deck: &mut Deck, f: &mut Flight, s: &mut A320Systems, dt: f64) {
    s.update(dt, &mut f.fm);
    s.update_ecam(dt, f);
    deck.update(dt as f32, f, s);
}

fn frames(deck: &mut Deck, f: &mut Flight, s: &mut A320Systems, secs: f64) {
    for _ in 0..(secs / 0.0625).round() as usize {
        frame(deck, f, s, 0.0625);
    }
}

fn shift(deck: &Deck, id: &str) -> f32 {
    deck.group(id).unwrap().xf.w_axis.truncate().length()
}

/// +1 when the pose rotates clockwise as seen by the pilot (looking at the panel), -1 anticlockwise, 0 for no rotation.
fn spin(deck: &Deck, id: &str) -> i32 {
    let g = deck.group(id).unwrap();
    let u = g.nrm.any_orthonormal_vector();
    let v = g.xf.transform_vector3(u);
    let s = u.cross(v).dot(g.nrm);
    if s < -1e-3 {
        1
    } else if s > 1e-3 {
        -1
    } else {
        0
    }
}

#[test]
fn ecam_panel_is_fully_classified() {
    let Some(deck) = load() else { return };
    for (id, _) in ECP_KEYS {
        let g = deck.group(id).unwrap_or_else(|| panic!("ECP key {id} missing"));
        assert_eq!(g.kind, Kind::Push, "{id}");
        assert!(!g.mom || g.ovh, "{id}");
    }
    for id in ["ecam_brt_upper", "ecam_brt_lower"] {
        assert_eq!(deck.group(id).map(|g| g.kind), Some(Kind::Knob), "{id}");
    }
    for id in ["ecam_att_hdg", "ecam_air_data", "ecam_eis_dmc", "ecam_nd_xfr"] {
        let g = deck.group(id).unwrap_or_else(|| panic!("{id}"));
        assert_eq!((g.kind, g.steps, g.pos), (Kind::Knob, 3, 1), "{id}: 3-position selector resting on NORM");
        assert!(g.axis.is_some(), "{id} has a manifest rotation axis");
    }
    // every page key + CLR / EMER CANC has its lamp in the model
    let (f, s) = (flight(), A320Systems::default());
    for id in ["ecam_eng", "ecam_bleed", "ecam_press", "ecam_elec", "ecam_hyd", "ecam_fuel", "ecam_apu", "ecam_cond", "ecam_door", "ecam_wheel", "ecam_fctl", "ecam_sts", "ecam_clr_l", "ecam_clr_r", "ecam_emer_canc"] {
        assert!(deck.lamp_lit(id, &s, &f).is_some(), "lamp of {id} missing");
    }
}

#[test]
fn ecp_page_keys_drive_the_sd_light_their_lamp_and_move_visually() {
    let Some(mut deck) = load() else { return };
    let (mut f, mut s) = (flight(), A320Systems::default());
    s.sync_from_flight(&f.fm);
    frames(&mut deck, &mut f, &mut s, 0.2);
    let auto = s.sd_page();
    assert_eq!(auto, EcamPage::Wheel, "free flight starts on the ground with engines running: automatic WHEEL page");
    assert_eq!(deck.lamp_lit("ecam_wheel", &s, &f), Some(true));
    assert_eq!(deck.lamp_lit("ecam_hyd", &s, &f), Some(false));
    // push HYD: key goes in, page changes, lamp follows
    let h = hit(&deck, "ecam_hyd");
    assert_eq!(deck.press(&h, 0, false, &mut f, &mut s).as_deref(), Some("ecam_hyd"));
    frames(&mut deck, &mut f, &mut s, 0.1);
    assert_eq!(s.sd_page(), EcamPage::Hyd);
    assert_eq!(deck.lamp_lit("ecam_hyd", &s, &f), Some(true));
    assert_eq!(deck.lamp_lit("ecam_wheel", &s, &f), Some(false), "only the shown page key is lit");
    assert!((shift(&deck, "ecam_hyd") - 0.0018).abs() < 2e-4, "pressed key is depressed 1.8 mm, got {}", shift(&deck, "ecam_hyd"));
    deck.release(&mut f, &mut s);
    frames(&mut deck, &mut f, &mut s, 0.5);
    assert!(shift(&deck, "ecam_hyd") < 1e-5, "key springs back after release");
    assert_eq!(s.sd_page(), EcamPage::Hyd, "page stays after release");
    // the lit key again -> automatic
    deck.press(&h, 0, false, &mut f, &mut s);
    deck.release(&mut f, &mut s);
    frames(&mut deck, &mut f, &mut s, 0.1);
    assert_eq!(s.sd_page(), auto);
    // all twelve page keys select their own page (right-click behaves the same: momentary keys)
    for (id, key) in ECP_KEYS {
        if let EcpKey::Page(p) = key {
            let h = hit(&deck, id);
            deck.press(&h, 2, false, &mut f, &mut s);
            deck.release(&mut f, &mut s);
            frames(&mut deck, &mut f, &mut s, 0.1);
            assert_eq!(s.sd_page(), p, "{id}");
            assert_eq!(deck.lamp_lit(id, &s, &f), Some(true), "{id} lamp");
            deck.press(&h, 0, false, &mut f, &mut s); // second push = back to automatic
            deck.release(&mut f, &mut s);
            frames(&mut deck, &mut f, &mut s, 0.1);
        }
    }
}

#[test]
fn ecp_all_steps_while_held_and_clr_rcl_emer_canc_work_on_real_alerts() {
    let Some(mut deck) = load() else { return };
    let (mut f, mut s) = (flight(), A320Systems::default());
    s.sync_from_flight(&f.fm);
    frames(&mut deck, &mut f, &mut s, 0.2);
    let all = hit(&deck, "ecam_all");
    deck.press(&all, 0, false, &mut f, &mut s);
    let first = s.sd_page();
    frames(&mut deck, &mut f, &mut s, 1.0);
    let second = s.sd_page();
    frames(&mut deck, &mut f, &mut s, 1.0);
    let third = s.sd_page();
    assert!(first != second && second != third && first != third, "ALL held steps one page per second: {first:?} {second:?} {third:?}");
    deck.release(&mut f, &mut s);
    frames(&mut deck, &mut f, &mut s, 3.0);
    assert_eq!(s.sd_page(), third, "releasing ALL keeps the page");
    assert!(s.ecam.held.is_none());

    // a real alert from the flight model: low fuel -> amber caution, FUEL page, MASTER CAUT
    s.ecam.manual = None;
    f.fm.fuel = 900.0;
    frames(&mut deck, &mut f, &mut s, 0.2);
    assert!(s.master_caut, "new alert re-arms MASTER CAUT");
    assert_eq!(s.sd_page(), EcamPage::Fuel, "failure page replaces the automatic page");
    assert_eq!(deck.lamp_lit("ecam_clr_l", &s, &f), Some(true));
    assert_eq!(deck.lamp_lit("ecam_fuel", &s, &f), Some(true));
    // CLR clears the message and cancels MASTER CAUT; RCL brings it back
    let clr = hit(&deck, "ecam_clr_l");
    deck.press(&clr, 0, false, &mut f, &mut s);
    deck.release(&mut f, &mut s);
    frames(&mut deck, &mut f, &mut s, 0.1);
    assert_eq!(s.ecam.alert_count(), 0);
    assert!(!s.master_caut);
    assert_eq!(deck.lamp_lit("ecam_clr_l", &s, &f), Some(false));
    let rcl = hit(&deck, "ecam_rcl");
    deck.press(&rcl, 0, false, &mut f, &mut s);
    deck.release(&mut f, &mut s);
    assert_eq!(s.ecam.alert_count(), 1);
    // EMER CANC cancels the caution for the flight; STATUS page lists it; lamp lights
    let ec = hit(&deck, "ecam_emer_canc");
    deck.press(&ec, 0, false, &mut f, &mut s);
    deck.release(&mut f, &mut s);
    frames(&mut deck, &mut f, &mut s, 0.1);
    assert_eq!(s.sd_page(), EcamPage::Sts);
    assert_eq!(s.ecam.status_items(), &["FUEL LOW"]);
    assert_eq!(deck.lamp_lit("ecam_emer_canc", &s, &f), Some(true));
    assert_eq!(deck.lamp_lit("ecam_sts", &s, &f), Some(true));
    // T.O CONFIG (engines are running on the ground): wrong flaps -> CONFIG warning on the E/WD, CLR dismisses it ...
    let to = hit(&deck, "ecam_to_config");
    s.ecam.manual = None;
    f.fm.ctl.flaps_idx = 0;
    f.fm.fuel = 20000.0;
    frames(&mut deck, &mut f, &mut s, 0.2);
    deck.press(&to, 0, false, &mut f, &mut s);
    deck.release(&mut f, &mut s);
    frames(&mut deck, &mut f, &mut s, 0.1);
    assert!(s.ecam.to_cfg.is_some());
    assert!(s.ecam.ewd_lines().iter().any(|l| l.text.starts_with("CONFIG FLAPS")), "{:?}", s.ecam.ewd_lines());
    deck.press(&clr, 0, false, &mut f, &mut s);
    deck.release(&mut f, &mut s);
    assert!(s.ecam.to_cfg.is_none());
    // ... correct flaps -> "T.O CONFIG NORMAL" memo
    f.fm.ctl.flaps_idx = 1;
    frames(&mut deck, &mut f, &mut s, 0.1);
    deck.press(&to, 0, false, &mut f, &mut s);
    deck.release(&mut f, &mut s);
    frames(&mut deck, &mut f, &mut s, 0.1);
    assert!(s.ecam.to_config_normal());
}

#[test]
fn ecam_brightness_knobs_turn_with_their_value_and_switch_the_displays_off() {
    let Some(mut deck) = load() else { return };
    let (mut f, mut s) = (flight(), A320Systems::default());
    frames(&mut deck, &mut f, &mut s, 0.1);
    for (id, get) in [("ecam_brt_upper", 0usize), ("ecam_brt_lower", 1usize)] {
        let h = hit(&deck, id);
        let val = |s: &A320Systems| if get == 0 { s.bright.uecam } else { s.bright.lecam };
        assert_eq!(spin(&deck, id), 1, "{id}: full BRT = fully clockwise");
        assert!((val(&s) - 1.0).abs() < 1e-6);
        for _ in 0..5 {
            assert!(deck.wheel(&h, -1.0, false, &mut f, &mut s), "wheel turns {id}");
        }
        deck.update(0.016, &f, &s);
        assert!((val(&s) - 0.5).abs() < 1e-5, "{id}: 5 clicks of 10 %");
        assert_eq!(spin(&deck, id), 0, "{id}: mid position points straight up");
        for _ in 0..5 {
            deck.wheel(&h, -1.0, false, &mut f, &mut s);
        }
        deck.update(0.016, &f, &s);
        assert!(val(&s) <= 0.001, "{id} at the OFF stop");
        assert_eq!(spin(&deck, id), -1, "{id}: OFF = fully anticlockwise");
        deck.wheel(&h, -1.0, false, &mut f, &mut s);
        assert!(val(&s) >= 0.0, "end stop");
        // drag turns it too (vertical drag up = clockwise)
        deck.press(&h, 0, false, &mut f, &mut s);
        deck.drag(0.0, -70.0, &mut f, &mut s);
        deck.release(&mut f, &mut s);
        assert!(val(&s) > 0.2, "{id} dragged up from OFF: {}", val(&s));
    }
    s.bright.uecam = 0.0;
    assert!(!s.uecam_on() && s.lecam_on());
}

#[test]
fn ecam_source_switching_selectors_cycle_and_route_the_displays() {
    let Some(mut deck) = load() else { return };
    let (mut f, mut s) = (flight(), A320Systems::default());
    frames(&mut deck, &mut f, &mut s, 0.1);
    let sd_of = |deck: &Deck, s: &A320Systems, node: &str| {
        let mut c = Vec::new();
        deck.screen_cells(s, &mut c);
        let i = deck.screens.iter().position(|x| x.node == node).unwrap();
        c[i]
    };
    assert_eq!(sd_of(&deck, &s, "ND.screen"), CELL_ND);
    for (id, idx) in [("ecam_att_hdg", 0usize), ("ecam_air_data", 1), ("ecam_eis_dmc", 2), ("ecam_nd_xfr", 3)] {
        let h = hit(&deck, id);
        assert_eq!(spin(&deck, id), 0);
        // click: NORM -> 2 (F/O 3) -> NORM -> 0 (CAPT 3) -> NORM -> 2 ...
        let mut seen = Vec::new();
        for _ in 0..5 {
            deck.press(&h, 0, false, &mut f, &mut s);
            deck.release(&mut f, &mut s);
            deck.update(0.016, &f, &s);
            seen.push(s.switching[idx]);
        }
        assert_eq!(seen, vec![2, 1, 0, 1, 2], "{id} bounce sequence");
        assert_eq!(deck.group(id).unwrap().pos, 2);
        assert_eq!(spin(&deck, id), 1, "{id}: F/O position is clockwise of NORM");
        deck.press(&h, 2, false, &mut f, &mut s); // right-click = back
        deck.release(&mut f, &mut s);
        deck.update(0.016, &f, &s);
        deck.press(&h, 2, false, &mut f, &mut s);
        deck.release(&mut f, &mut s);
        deck.update(0.016, &f, &s);
        assert_eq!(s.switching[idx], 0);
        assert_eq!(spin(&deck, id), -1, "{id}: CAPT position is anticlockwise of NORM");
        assert!(deck.wheel(&h, 1.0, false, &mut f, &mut s));
        assert_eq!(s.switching[idx], 1, "wheel steps too");
        let h2 = deck.hover_info(&h, &s, &f);
        assert_eq!(h2.value, "NORM");
    }
    // ECAM / ND XFR: the SD appears on the captain's (position 0) or first officer's (position 2) ND
    assert_eq!(s.switching[3], 1);
    assert_eq!((sd_of(&deck, &s, "ND.screen"), sd_of(&deck, &s, "ND_R.screen")), (CELL_ND, CELL_ND));
    s.switching[3] = 0;
    assert_eq!((sd_of(&deck, &s, "ND.screen"), sd_of(&deck, &s, "ND_R.screen")), (CELL_SD, CELL_ND));
    s.switching[3] = 2;
    assert_eq!((sd_of(&deck, &s, "ND.screen"), sd_of(&deck, &s, "ND_R.screen")), (CELL_ND, CELL_SD));
    // vertices follow the routing (same count, different UVs)
    let base = deck.gpu_mesh().screen_v;
    let mut c = Vec::new();
    deck.screen_cells(&s, &mut c);
    let routed = deck.screen_vertices(&c);
    assert_eq!(routed.len(), base.len());
    assert!(routed.iter().zip(&base).any(|(a, b)| a.uv != b.uv));
    let _ = CELL_EWD;
}

#[test]
fn ecp_keys_are_pickable_from_the_captains_seat() {
    let Some(deck) = load() else { return };
    let mut ok = 0;
    for (id, _) in ECP_KEYS {
        let (o, d) = ray_to(&deck, id);
        if let Some(h) = deck.pick(o, d) {
            if deck.groups[h.group].id == id {
                ok += 1;
            } else {
                eprintln!("ray to {id} hit {} first", deck.groups[h.group].id);
            }
        }
    }
    assert!(ok >= ECP_KEYS.len() * 2 / 3, "ECP picking {ok}/{}", ECP_KEYS.len());
}
