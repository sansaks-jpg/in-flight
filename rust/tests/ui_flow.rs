//! End-to-end tests of the pre-flight UI flow (boot -> menu -> planner -> briefing -> start) driven by synthetic input and
//! painted through the CPU rasteriser, so they run without a GPU or a window.
use inflight::airports::AirportDb;
use inflight::game::Flight;
use inflight::geo::FT;
use inflight::gfx::ui::{Ui, MAX_UI_VERTS};
use inflight::nav::plan_cruise_alt_m;
use inflight::ui::planner::{Field, Filters};
use inflight::ui::raster::Raster;
use inflight::ui::{Gui, Input, Key, ModalKind, Outcome, PreFlight, Screen};

const UTC: f64 = 1_718_914_200.0;
const W: f32 = 1280.0;
const H: f32 = 720.0;

struct Rig {
    db: AirportDb,
    pre: PreFlight,
    ui: Ui,
    inp: Input,
}

impl Rig {
    fn new() -> Self {
        let db = AirportDb::embedded();
        let mut pre = PreFlight::new(&db);
        pre.settings = Default::default();
        Self { db, pre, ui: Ui::new(), inp: Input::default() }
    }
    fn step(&mut self) -> Outcome {
        self.ui.begin(W, H);
        let o = self.pre.frame(&mut self.ui, &self.inp, &self.db, UTC, 1.0 / 60.0, 60.0);
        self.ui.end();
        assert!(self.ui.verts.len() < MAX_UI_VERTS, "UI vertex budget exceeded: {}", self.ui.verts.len());
        self.inp.end_frame();
        o
    }
    fn steps(&mut self, n: usize) {
        for _ in 0..n {
            self.step();
        }
    }
    fn click(&mut self, x: f32, y: f32) -> Outcome {
        self.inp.mouse = [x, y];
        self.step();
        self.inp.pressed = true;
        self.inp.down = true;
        let o = self.step();
        self.inp.released = true;
        self.inp.down = false;
        self.step();
        o
    }
    fn key(&mut self, k: Key) -> Outcome {
        self.inp.keys.push(k);
        self.step()
    }
    fn type_text(&mut self, t: &str) {
        self.inp.typed.push_str(t);
        self.step();
    }
    fn boot(&mut self) {
        let mut n = 0;
        while self.pre.screen == Screen::Boot {
            self.step();
            n += 1;
            assert!(n < 600, "boot never finished");
        }
        self.steps(10);
    }
    fn paint(&self) -> Raster {
        let mut r = Raster::new(W as usize, H as usize);
        r.draw(&self.ui);
        r
    }
}

#[test]
fn boot_finishes_and_reaches_the_menu() {
    let mut r = Rig::new();
    r.steps(5);
    assert_eq!(r.pre.screen, Screen::Boot);
    assert!(r.pre.boot.stage < 5);
    r.boot();
    assert_eq!(r.pre.screen, Screen::Menu);
    assert_eq!(r.pre.boot.stats.airports, 8413);
    assert!(r.pre.planner.results.len() == 8413, "search index must be built during boot");
}

#[test]
fn menu_renders_globe_and_tiles() {
    let mut r = Rig::new();
    r.boot();
    r.steps(5);
    let img = r.paint();
    assert!(img.mean_luma(780, 250, 200, 200) > img.mean_luma(620, 640, 80, 40) * 2.0);
    assert!(img.mean_luma(60, 160, 480, 90) > 0.01);
    assert!(r.pre.globe.last_cells > 500);
}

#[test]
fn full_dispatch_flow_by_keyboard_and_mouse() {
    let mut r = Rig::new();
    r.boot();
    assert_eq!(r.click(300.0, 200.0), Outcome::None);
    assert_eq!(r.pre.screen, Screen::Planner);
    r.type_text("lhr");
    assert_eq!(r.pre.planner.query, "lhr");
    assert_eq!(r.db.airports[r.pre.planner.results[0] as usize].icao, "EGLL");
    r.key(Key::Enter);
    assert_eq!(r.pre.planner.dep, "EGLL");
    assert_eq!(r.pre.planner.field, Field::Arr, "selecting the departure advances to the arrival field");
    for _ in 0..3 {
        r.key(Key::Backspace);
    }
    r.type_text("cdg");
    r.key(Key::Enter);
    assert_eq!(r.pre.planner.arr, "LFPG");
    assert!(r.pre.globe.is_flying(), "selecting airports flies the globe camera");
    for _ in 0..3 {
        r.key(Key::Backspace);
    }
    assert!(r.pre.planner.query.is_empty());
    r.key(Key::Enter);
    assert_eq!(r.pre.screen, Screen::Briefing);
    let b = r.pre.planner.brief.as_ref().expect("briefing prepared");
    assert!(b.d.can_fly && b.fl >= 100);
    match r.key(Key::Enter) {
        Outcome::Start { dep, arr, dep_rwy, arr_rwy, cruise_alt_m } => {
            assert_eq!((dep.as_str(), arr.as_str()), ("EGLL", "LFPG"));
            assert!(dep_rwy.is_some() && arr_rwy.is_some() && cruise_alt_m.is_some());
        }
        o => panic!("expected Start, got {o:?}"),
    }
}

#[test]
fn escape_walks_back_and_quits() {
    let mut r = Rig::new();
    r.boot();
    r.pre.goto(Screen::Planner);
    r.pre.planner.prepare_briefing(&r.db, UTC);
    r.pre.goto(Screen::Briefing);
    r.step();
    r.key(Key::Escape);
    assert_eq!(r.pre.screen, Screen::Planner);
    r.key(Key::Escape);
    assert_eq!(r.pre.screen, Screen::Menu);
    assert_eq!(r.key(Key::Escape), Outcome::Quit);
}

#[test]
fn modals_open_block_input_and_close() {
    let mut r = Rig::new();
    r.boot();
    r.key(Key::F(1));
    assert_eq!(r.pre.modal, Some(ModalKind::Controls));
    r.click(100.0, 200.0);
    assert_eq!(r.pre.screen, Screen::Menu);
    assert_eq!(r.pre.modal, None);
    r.click(150.0, 450.0);
    assert_eq!(r.pre.modal, Some(ModalKind::Settings));
    r.key(Key::Escape);
    assert_eq!(r.pre.modal, None);
    r.click(440.0, 330.0);
    assert_eq!(r.pre.modal, Some(ModalKind::Logbook));
    r.key(Key::Escape);
    r.click(440.0, 510.0);
    assert_eq!(r.pre.modal, Some(ModalKind::Controls));
}

#[test]
fn free_flight_tile_starts_immediately() {
    let mut r = Rig::new();
    r.boot();
    match r.click(150.0, 320.0) {
        Outcome::Start { dep, arr, .. } => assert_eq!((dep.as_str(), arr.as_str()), ("KSFO", "KOAK")),
        o => panic!("{o:?}"),
    }
}

#[test]
fn settings_switch_changes_value() {
    let mut r = Rig::new();
    r.boot();
    r.pre.modal = Some(ModalKind::Settings);
    r.pre.settings_tab = 2;
    r.step();
    let before = r.pre.settings.invert_pitch;
    let (wx, wy) = ((1280.0 - 780.0) / 2.0, (720.0 - 480.0) / 2.0);
    r.click(wx + 780.0 - 22.0 - 38.0 + 10.0, wy + 138.0 + 42.0 + 8.0);
    assert_ne!(r.pre.settings.invert_pitch, before);
}

#[test]
fn globe_stays_inside_vertex_budget_at_every_zoom() {
    let db = AirportDb::embedded();
    let inp = Input::default();
    let mut globe = inflight::ui::globe::Globe::new();
    for (lat, lon, zoom) in [(0.0, 0.0, 0.7), (-2.5, 115.0, 1.0), (50.0, 8.0, 2.0), (35.0, -120.0, 6.0), (1.3, 103.9, 24.0), (89.0, 0.0, 1.0), (-85.0, 170.0, 3.0), (0.0, 179.9, 60.0)] {
        globe.snap_to(lat, lon, zoom);
        let mut ui = Ui::new();
        ui.begin(W, H);
        let mut g = Gui::new(&mut ui, &inp, 0.0);
        let view = inflight::ui::globe::GlobeView { cx: 800.0, cy: 360.0, r: 260.0, clip: [452.0, 52.0, 816.0, 608.0] };
        globe.run(&mut g, view, UTC, &db, Default::default(), false, 0.016);
        ui.end();
        assert!(ui.verts.len() < MAX_UI_VERTS, "zoom {zoom} @ {lat},{lon}: {} verts", ui.verts.len());
        assert!(globe.last_cells <= 14_000);
        assert!(globe.last_cells > 0, "nothing drawn at zoom {zoom}");
    }
}

#[test]
fn globe_click_picks_airport_and_selects_it() {
    let mut r = Rig::new();
    r.boot();
    r.pre.goto(Screen::Planner);
    r.pre.globe.auto_rotate = false;
    r.pre.globe.snap_to(37.62, -122.375, 20.0);
    r.pre.planner.field = Field::Arr;
    r.steps(3);
    let (cx, cy) = (452.0 + (1280.0 - 452.0 - 12.0) * 0.5, 52.0 + (720.0 - 52.0 - 60.0) * 0.5);
    r.click(cx, cy);
    assert_eq!(r.pre.planner.arr, "KSFO");
}

#[test]
fn filters_apply_through_the_ui_state() {
    let mut r = Rig::new();
    r.boot();
    r.pre.planner.filters = Filters { long_rwy: true, hard: true, ..Default::default() };
    r.pre.planner.refresh(&r.db);
    assert!(r.pre.planner.results.len() < 8413 && !r.pre.planner.results.is_empty());
}

#[test]
fn flight_honours_dispatched_runways_and_cruise_level() {
    let db = AirportDb::embedded();
    let ksfo = db.get("KSFO").unwrap();
    let [a, b] = ksfo.main_runway().unwrap().ends();
    for want in [&a.ident, &b.ident] {
        let f = Flight::new_with_runways(&db, "KSFO", "KJFK", UTC, Some(want), Some("13R"), Some(310.0 * 100.0 * FT)).unwrap();
        assert_eq!(&f.dep_end.ident, want);
        let cruise = plan_cruise_alt_m(&f.plan).unwrap();
        assert!((cruise - 31000.0 * FT).abs() < 50.0, "cruise {cruise}");
    }
    let f = Flight::new_with_runways(&db, "KSFO", "KLAX", UTC, Some("99X"), None, None).unwrap();
    assert!(!f.dep_end.ident.is_empty());
}
