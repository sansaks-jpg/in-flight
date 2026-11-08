//! Interactive flight-deck tests against the REAL downloaded `cockpit.glb` (skipped when the add-on is not installed:
//! run the Marketplace download first, or set `INFLIGHT_ADDON_DIR`). No GPU needed - classification, picking and control
//! mechanics are pure CPU code.

use glam::Vec3;
use inflight::a320sys::A320Systems;
use inflight::addons::AddonManager;
use inflight::airports::AirportDb;
use inflight::deck::{Deck, Kind};
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
    deck.release(f);
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
    deck.release(&mut f);
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
    // FCU knobs by wheel: altitude +100 per click, speed, heading
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
        deck.release(&mut f);
        assert_eq!(deck.group("EvacCommandProt").map(|g| g.pos), Some(1), "guard lifted");
        assert_eq!(deck.group("EvacCommandBtn").map(|g| g.pos), Some(0), "button untouched");
    }
}
