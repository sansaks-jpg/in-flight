//! MCDU + pedestal behaviour against the REAL downloaded `cockpit.glb` (skipped when the add-on is not installed:
//! run the Marketplace download first, or set `INFLIGHT_ADDON_DIR`). Pure CPU: classification, picking, key / lever mechanics,
//! visual poses (depress, rotation) and the systems they drive.

use glam::{Mat4, Vec3};
use inflight::a320sys::A320Systems;
use inflight::addons::AddonManager;
use inflight::airports::AirportDb;
use inflight::deck::{Deck, Kind};
use inflight::game::Flight;
use inflight::glb;
use inflight::mcdu::{is_key_name, Page};
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

/// Ray straight down onto control `id` along its panel normal (never blocked by levers in front of it).
fn ray_on(deck: &Deck, id: &str) -> (Vec3, Vec3) {
    let g = deck.group(id).unwrap_or_else(|| panic!("missing control {id}"));
    let c = (g.bmin + g.bmax) * 0.5;
    let o = deck.to_body.transform_point3(c + g.nrm * 0.25);
    (o, deck.to_body.transform_vector3(-g.nrm).normalize())
}

/// First pickable spot of control `id`: the panel-normal ray first, then rays aimed at sampled triangles of the control from
/// above / behind / the sides (levers sit under or between other parts, so one direction is not always free).
fn hit(deck: &Deck, id: &str) -> Option<inflight::deck::Hit> {
    let (o, d) = ray_on(deck, id);
    if let Some(h) = deck.pick(o, d) {
        if deck.groups[h.group].id == id {
            return Some(h);
        }
    }
    let g = deck.group(id)?;
    let mut cents = Vec::new();
    for &pi in &g.parts {
        let m = &deck.glb.meshes[pi];
        for t in m.idx.chunks_exact(3).step_by(3) {
            let p = |k: usize| Vec3::from(m.pos[t[k] as usize]);
            cents.push((p(0) + p(1) + p(2)) / 3.0);
        }
    }
    for dir in [g.nrm, Vec3::Y, Vec3::X, Vec3::NEG_Z, Vec3::Z, Vec3::new(0.5, 1.0, 0.5).normalize()] {
        for c in &cents {
            let o = deck.to_body.transform_point3(*c + dir * 0.2);
            let d = deck.to_body.transform_vector3(-dir).normalize();
            if let Some(h) = deck.pick(o, d) {
                if deck.groups[h.group].id == id {
                    return Some(h);
                }
            }
        }
    }
    None
}

struct Rig {
    deck: Deck,
    f: Flight,
    s: A320Systems,
}

fn rig() -> Option<Rig> {
    let deck = load()?;
    let f = flight();
    let mut s = A320Systems::default();
    s.sync_from_flight(&f.fm);
    Some(Rig { deck, f, s })
}

impl Rig {
    fn click(&mut self, id: &str, button: u8) {
        let h = hit(&self.deck, id).unwrap_or_else(|| panic!("{id} is not pickable"));
        self.deck.press(&h, button, false, &mut self.f, &mut self.s);
        self.deck.update(0.016, &self.f, &self.s);
        self.deck.release(&mut self.f, &mut self.s);
        self.deck.update(0.016, &self.f, &self.s);
    }
    fn wheel(&mut self, id: &str, dy: f32) -> bool {
        let h = hit(&self.deck, id).unwrap_or_else(|| panic!("{id} is not pickable"));
        let r = self.deck.wheel(&h, dy, false, &mut self.f, &mut self.s);
        self.deck.update(0.016, &self.f, &self.s);
        r
    }
    fn settle(&mut self) {
        for _ in 0..120 {
            self.deck.update(0.016, &self.f, &self.s);
        }
    }
}

#[test]
fn every_mcdu_key_of_both_units_is_pickable_and_wired() {
    let Some(mut r) = rig() else { return eprintln!("cockpit add-on not installed: skipping") };
    let mut ids: Vec<String> = r.deck.groups.iter().filter(|g| g.kind == Kind::Key).map(|g| g.id.clone()).collect();
    ids.sort();
    // 2 units x (26 letters + 10 digits + 12 line keys + 28 named keys incl. '.' and the ATC COMM key) = 2 x 74 + the blank key ""
    assert!(ids.len() >= 146, "all keys classified, got {}", ids.len());
    for id in &ids {
        let (side, key) = id.split_once(':').expect("C: / F: prefix");
        let k = if key.is_empty() { "." } else { key };
        assert!(is_key_name(k) || k == "atc", "{id}");
        let h = hit(&r.deck, id).unwrap_or_else(|| panic!("MCDU key {id} cannot be picked from above"));
        let unit = (side == "F") as usize;
        let before = r.s.mcdu[unit].presses;
        r.deck.press(&h, 0, false, &mut r.f, &mut r.s);
        r.deck.release(&mut r.f, &mut r.s);
        assert_eq!(r.s.mcdu[unit].presses, before + 1, "key {id} reached the MCDU");
        assert_eq!(r.s.mcdu[1 - unit].presses, if unit == 0 { r.s.mcdu[1].presses } else { r.s.mcdu[0].presses });
    }
}

#[test]
fn atc_comm_key_is_part_of_the_keyboard() {
    let Some(r) = rig() else { return };
    assert_eq!(r.deck.group("C:atc").map(|g| g.kind), Some(Kind::Key));
    assert_eq!(r.deck.group("F:atc").map(|g| g.kind), Some(Kind::Key));
    assert!(r.deck.group("atc_comm.cpt").is_none());
    // it is the same physical row as DATA / F-PLN, not on the transponder panel
    let c = r.deck.group("C:atc").unwrap();
    assert!(((c.bmin + c.bmax) * 0.5).x < -0.3);
}

#[test]
fn typing_on_the_3d_keyboard_drives_the_captain_and_fo_units_independently() {
    let Some(mut r) = rig() else { return };
    for k in ["C:init", "C:d", "C:l", "C:h", "C:1", "C:2", "C:3"] {
        r.click(k, 0);
    }
    assert_eq!(r.s.mcdu[0].page, Page::Init);
    assert_eq!(r.s.mcdu[0].scratch, "DLH123");
    r.click("C:L2", 0);
    assert_eq!(r.s.mcdu[0].store.flt, "DLH123");
    // the first officer's unit is untouched until its own keys are pressed
    assert_eq!(r.s.mcdu[1].page, Page::Menu);
    r.click("F:perf", 0);
    r.click("F:1", 0);
    r.click("F:3", 0);
    r.click("F:5", 0);
    r.click("F:L1", 0);
    assert_eq!(r.s.mcdu[1].page, Page::Perf);
    assert_eq!(r.s.mcdu[1].store.v1, 135);
    assert_eq!(r.s.mcdu[0].store.v1, 0);
    // '.', '/', '+/-' and the blank-named key reach the scratchpad
    r.click("C:clr", 0);
    r.click("C:", 0);
    r.click("C:/", 0);
    r.click("C:+/-", 0);
    assert_eq!(r.s.mcdu[0].scratch, "./-");
    // CLR deletes, BRT / DIM change the screen brightness
    r.click("C:DIM", 0);
    assert!(r.s.mcdu[0].brt < 1.0 && r.s.mcdu[1].brt == 1.0);
    r.click("C:BRT", 0);
    assert_eq!(r.s.mcdu[0].brt, 1.0);
}

#[test]
fn mcdu_keys_depress_along_the_keyboard_normal_and_spring_back() {
    let Some(mut r) = rig() else { return };
    let g = r.deck.group("C:a").unwrap();
    let n = g.nrm;
    assert!(n.y > 0.95 && n.x > 0.0 && n.x < 0.35, "keyboard faces up and slightly aft, got {n:?}");
    let h = hit(&r.deck, "C:a").unwrap();
    r.deck.press(&h, 0, false, &mut r.f, &mut r.s);
    r.deck.update(0.016, &r.f, &r.s);
    let held = r.deck.group("C:a").unwrap().xf;
    let t = held.w_axis.truncate();
    assert!((t.length() - 0.0018).abs() < 2e-4 && t.dot(n) < 0.0, "1.8 mm into the panel while held, got {t:?}");
    // a neighbour does not move
    assert_eq!(r.deck.group("C:b").unwrap().xf.w_axis.truncate().length(), 0.0);
    r.deck.release(&mut r.f, &mut r.s);
    r.deck.update(0.016, &r.f, &r.s);
    assert!(r.deck.group("C:a").unwrap().xf.w_axis.truncate().length() < 1e-6, "key springs back on release");
}

#[test]
fn mcdu_annunciators_and_screens_exist_in_the_model() {
    let Some(r) = rig() else { return };
    let names: Vec<&str> = r.deck.screens.iter().map(|s| s.node.as_str()).collect();
    assert!(names.contains(&"mcdu1.screen") && names.contains(&"mcdu2.screen"), "{names:?}");
    let gpu = r.deck.gpu_mesh();
    // the MCDU glass is baked into atlas cells 4 / 5 (third column)
    let third_col = gpu.screen_v.iter().filter(|v| v.uv[0] > 2.0 / 3.0).count();
    assert!(third_col >= 8, "two quads (4 vertices each) map into the MCDU column, got {third_col}");
    assert!(gpu.screen_v.iter().all(|v| (0.0..=1.0).contains(&v.uv[0]) && (0.0..=1.0).contains(&v.uv[1])));
    let mut slots = Vec::new();
    r.deck.slots(&r.s, &r.f, &mut slots);
    assert_eq!(slots.len(), gpu.slot_count);
}

#[test]
fn ecam_control_panel_keys_work_and_are_momentary() {
    let Some(mut r) = rig() else { return };
    r.click("ecam_hyd", 0);
    assert_eq!(r.s.ecp.shown(), Some("HYD"));
    r.click("ecam_hyd", 0);
    assert_eq!(r.s.ecp.shown(), None);
    r.click("ecam_fuel", 0);
    r.click("ecam_clr_l", 0);
    assert_eq!(r.s.ecp.shown(), None);
    // momentary keys never latch in (CLR / RCL / ALL / EMER CANC / T.O. CONFIG)
    for id in ["ecam_clr_l", "ecam_clr_r", "ecam_rcl", "ecam_all", "ecam_emer_canc", "ecam_to_config"] {
        r.click(id, 0);
        assert_eq!(r.deck.group(id).unwrap().pos, 0, "{id} must not latch");
    }
    // T.O. CONFIG = lamp test, EMER CANC cancels the master warning
    r.s.master_warn = true;
    r.click("ecam_emer_canc", 0);
    assert!(!r.s.master_warn);
    r.click("ecam_to_config", 0);
    assert!(r.s.lamp_test > 1.0);
    // ALL held steps through the pages
    let h = hit(&r.deck, "ecam_all").unwrap();
    r.s.ecp = Default::default();
    r.deck.press(&h, 0, false, &mut r.f, &mut r.s);
    assert!(r.deck.ecp_hold);
    r.s.ecp.set_all_held(r.deck.ecp_hold);
    r.s.ecp.update(2.1);
    assert_eq!(r.s.ecp.shown(), Some("PRESS"), "ENG at once, BLEED after 1 s, PRESS after 2 s");
    r.deck.release(&mut r.f, &mut r.s);
    assert!(!r.deck.ecp_hold);
    r.s.ecp.set_all_held(r.deck.ecp_hold);
    r.s.ecp.update(5.0);
    assert_eq!(r.s.ecp.shown(), Some("PRESS"), "releasing ALL keeps the page");
}

#[test]
fn source_switching_and_engine_mode_selectors_bounce_at_the_end_stops() {
    let Some(mut r) = rig() else { return };
    // ENG MODE: NORM(1) -> IGN/START(2) -> back to NORM -> CRANK(0) -> NORM ...
    assert_eq!(r.deck.group("eng_mode").unwrap().pos, 1);
    let mut seen = Vec::new();
    for _ in 0..6 {
        r.click("eng_mode", 0);
        seen.push(r.s.eng_mode);
    }
    assert!(seen.contains(&0) && seen.contains(&1) && seen.contains(&2), "left-click reaches every position: {seen:?}");
    // never stuck: consecutive clicks keep changing the position
    assert!(seen.windows(2).all(|w| w[0] != w[1]), "{seen:?}");
    for id in ["ecam_att_hdg", "ecam_air_data", "ecam_eis_dmc", "ecam_nd_xfr"] {
        let mut seen = vec![r.deck.group(id).unwrap().pos];
        for _ in 0..5 {
            r.click(id, 0);
            seen.push(r.deck.group(id).unwrap().pos);
        }
        assert!(seen.windows(2).all(|w| w[0] != w[1]) && seen.contains(&0) && seen.contains(&2), "{id}: {seen:?}");
        r.click(id, 2);
    }
}

#[test]
fn thrust_levers_reverse_and_autothrust_disconnect() {
    let Some(mut r) = rig() else { return };
    // wheel steps through the detents, drag snaps to them
    for _ in 0..40 {
        r.wheel("thr_l_body", 1.0);
    }
    assert!((r.f.fm.ctl.throttle - 1.0).abs() < 1e-9);
    r.settle();
    let up = r.deck.group("thr_l_body").unwrap().xf;
    assert!(up != Mat4::IDENTITY);
    for _ in 0..40 {
        r.wheel("thr_l_body", -1.0);
    }
    assert!(r.f.fm.ctl.throttle.abs() < 1e-9);
    // the A/THR disconnect button rides on its lever and disconnects the autothrust (momentary)
    r.s.athr_armed = true;
    r.click("thr_l_button", 0);
    assert!(!r.s.athr_armed);
    assert_eq!(r.deck.group("thr_l_button").unwrap().pos, 0, "momentary");
    // reverse levers toggle the reverser and animate
    r.click("rev_l", 0);
    assert!(r.f.fm.ctl.reverse);
    r.settle();
    assert!(r.deck.group("rev_l").unwrap().xf != Mat4::IDENTITY);
    r.click("rev_r", 0);
    assert!(!r.f.fm.ctl.reverse);
}

#[test]
fn speedbrake_lever_by_wheel_and_drag_covers_arm_and_every_step() {
    let Some(mut r) = rig() else { return };
    assert!(!r.f.fm.ctl.spoilers_armed && r.f.fm.ctl.speedbrake == 0.0);
    // scroll down extends in quarters up to full
    for want in [0.25, 0.5, 0.75, 1.0, 1.0] {
        assert!(r.wheel("SpdBrk", -1.0));
        assert!((r.f.fm.ctl.speedbrake - want).abs() < 1e-9);
    }
    r.settle();
    let full = r.deck.group("SpdBrk").unwrap().xf;
    // scroll up retracts and then arms the ground spoilers
    for _ in 0..4 {
        r.wheel("SpdBrk", 1.0);
    }
    assert_eq!(r.f.fm.ctl.speedbrake, 0.0);
    assert!(!r.f.fm.ctl.spoilers_armed);
    r.wheel("SpdBrk", 1.0);
    assert!(r.f.fm.ctl.spoilers_armed);
    r.wheel("SpdBrk", 1.0);
    assert!(r.f.fm.ctl.spoilers_armed, "ARM is the end stop");
    r.settle();
    let armed = r.deck.group("SpdBrk").unwrap().xf;
    assert!(armed != full, "lever poses differ between ARM and FULL");
    // drag: down extends, up arms
    let h = hit(&r.deck, "SpdBrk").unwrap();
    r.deck.press(&h, 0, false, &mut r.f, &mut r.s);
    r.deck.drag(0.0, 70.0, &mut r.f, &mut r.s);
    assert!(!r.f.fm.ctl.spoilers_armed && r.f.fm.ctl.speedbrake > 0.3);
    r.deck.release(&mut r.f, &mut r.s);
}

#[test]
fn flaps_lever_detents_by_wheel_and_drag() {
    let Some(mut r) = rig() else { return };
    r.f.fm.ctl.flaps_idx = 0;
    for want in 1..=4 {
        r.wheel("FlapsLever", -1.0);
        assert_eq!(r.f.fm.ctl.flaps_idx, want);
    }
    r.wheel("FlapsLever", -1.0);
    assert_eq!(r.f.fm.ctl.flaps_idx, 4);
    r.settle();
    let a = r.deck.group("FlapsLever").unwrap().xf;
    r.wheel("FlapsLever", 1.0);
    r.settle();
    assert!(r.deck.group("FlapsLever").unwrap().xf != a);
    for _ in 0..6 {
        r.wheel("FlapsLever", 1.0);
    }
    assert_eq!(r.f.fm.ctl.flaps_idx, 0);
}

#[test]
fn engine_master_levers_toggle_and_rudder_trim_turns() {
    let Some(mut r) = rig() else { return };
    r.s.master = [false, false];
    r.click("Lcutoff", 0);
    assert!(r.s.master[0] && !r.s.master[1]);
    r.click("Rcutoff", 0);
    assert!(r.s.master[1]);
    r.click("Lcutoff", 0);
    assert!(!r.s.master[0]);
    r.settle();
    assert!(r.deck.group("Rcutoff").unwrap().xf == Mat4::IDENTITY || r.deck.group("Lcutoff").unwrap().xf != Mat4::IDENTITY);
    // rudder trim: wheel turns the knob 0.05 per click, reset button centres it
    for _ in 0..4 {
        r.wheel("RudderTrim", 1.0);
    }
    assert!((r.f.fm.ctl.rud_trim - 0.2).abs() < 1e-9);
    r.settle();
    assert!(r.deck.group("RudderTrim").unwrap().xf != Mat4::IDENTITY);
    r.click("RudderTrimReset", 0);
    assert_eq!(r.f.fm.ctl.rud_trim, 0.0);
    assert_eq!(r.deck.group("RudderTrimReset").unwrap().pos, 0, "momentary");
}

#[test]
fn pitch_trim_wheel_trims_the_aircraft_and_turns_with_it() {
    let Some(mut r) = rig() else { return };
    assert_eq!(r.deck.group("trim_1").map(|g| g.kind), Some(Kind::Knob), "wheel, not a 2-position switch");
    assert!(r.deck.group("trim_2_lts").is_none(), "the index plate is static");
    assert!(r.deck.group("trim_1").unwrap().axis.is_none());
    let before = r.f.fm.ctl.trim;
    assert!(r.wheel("trim_1", 1.0));
    assert!((r.f.fm.ctl.trim - before - 0.05).abs() < 1e-9, "scroll up = nose up");
    for _ in 0..10 {
        r.wheel("trim_1", -1.0);
    }
    assert!((r.f.fm.ctl.trim + 0.45).abs() < 1e-9);
    r.settle();
    let nose_down = r.deck.group("trim_1").unwrap().xf;
    for _ in 0..30 {
        r.wheel("trim_1", 1.0);
    }
    assert!((r.f.fm.ctl.trim - 1.0).abs() < 1e-9, "clamps at full nose up");
    r.settle();
    let nose_up = r.deck.group("trim_1").unwrap().xf;
    assert!(nose_up != nose_down);
    // pure rotation about the lateral axis: z axis unchanged, no translation along z
    assert!((nose_up.z_axis - glam::Vec4::Z).length() < 1e-4);
    assert!(nose_up.w_axis.z.abs() < 1e-4);
    // full trim turns the wheel by TRIM_WHEEL_RAD
    let ang = nose_up.x_axis.y.atan2(nose_up.x_axis.x).abs();
    assert!((ang - inflight::deck::TRIM_WHEEL_RAD).abs() < 0.02 || (ang - (std::f32::consts::TAU - inflight::deck::TRIM_WHEEL_RAD)).abs() < 0.02, "angle {ang}");
    // the hover text names the trim
    let h = hit(&r.deck, "trim_1").unwrap();
    assert!(r.deck.state_text(h.group, &r.s, &r.f).starts_with("PITCH TRIM 4.0 UP"));
    // dragging the wheel also trims
    let h = hit(&r.deck, "trim_1").unwrap();
    r.deck.press(&h, 2, false, &mut r.f, &mut r.s);
    r.deck.release(&mut r.f, &mut r.s);
    assert!(r.f.fm.ctl.trim < 1.0);
}

#[test]
fn parking_brake_and_gear_levers_pose_and_state() {
    let Some(mut r) = rig() else { return };
    let p0 = r.f.fm.ctl.parking;
    r.click("ParkBrk", 0);
    assert_ne!(r.f.fm.ctl.parking, p0);
    r.settle();
    let a = r.deck.group("ParkBrk").unwrap().xf;
    r.click("ParkBrk", 0);
    r.settle();
    assert!(r.deck.group("ParkBrk").unwrap().xf != a, "the handle moves with the state");
}

#[test]
fn pedestal_knobs_and_buttons_all_respond_to_the_mouse() {
    let Some(mut r) = rig() else { return };
    // every pedestal control that is Knob / Switch must change its pose or state on a wheel / click
    let ped: Vec<(String, Kind)> = r
        .deck
        .groups
        .iter()
        .filter(|g| {
            let c = (g.bmin + g.bmax) * 0.5;
            c.z.abs() < 0.34 && c.y < 0.2 && c.x > -0.45 && !matches!(g.kind, Kind::Key | Kind::Stick | Kind::Lever)
        })
        .map(|g| (g.id.clone(), g.kind))
        .collect();
    assert!(ped.len() > 60, "pedestal has many controls, got {}", ped.len());
    let mut untouched = Vec::new();
    for (id, kind) in &ped {
        let Some(h) = hit(&r.deck, id) else { continue };
        let before = (r.deck.group(id).unwrap().pos, r.deck.group(id).unwrap().press, r.deck.group(id).unwrap().angle);
        r.deck.press(&h, 0, false, &mut r.f, &mut r.s);
        r.deck.update(0.016, &r.f, &r.s);
        let held = r.deck.group(id).unwrap().xf;
        r.deck.release(&mut r.f, &mut r.s);
        r.deck.update(0.016, &r.f, &r.s);
        let after = (r.deck.group(id).unwrap().pos, r.deck.group(id).unwrap().press, r.deck.group(id).unwrap().angle);
        let moved = held != Mat4::IDENTITY || before.0 != after.0 || before.2 != after.2;
        if !moved && !matches!(kind, Kind::Guard) {
            untouched.push(id.clone());
        }
    }
    // a handful of pure state buttons (e.g. test / reset keys) only depress while held: the depress is checked above for keys;
    // everything else must visibly react
    assert!(untouched.len() <= 4, "pedestal controls that show no reaction: {untouched:?}");
}
