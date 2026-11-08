//! Headless screenshots of the pre-flight UI (boot, menu, globe, planner, briefing, modals) rendered by the CPU
//! rasteriser - no GPU needed. usage: uishots [out_dir] [width] [height]
use inflight::airports::AirportDb;
use inflight::gfx::ui::Ui;
use inflight::ui::modals::{LogEntry, Settings};
use inflight::ui::planner::{Field, Filters, Tab};
use inflight::ui::raster::Raster;
use inflight::ui::{dispatch::Region, Input, ModalKind, PreFlight, Screen};
use std::io::BufWriter;

const UTC: f64 = 1_718_914_200.0; // 2024-06-20 20:10Z

fn save(path: &str, w: u32, h: u32, rgba: &[u8]) {
    let file = BufWriter::new(std::fs::File::create(path).expect("png file"));
    let mut enc = png::Encoder::new(file, w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().expect("png header").write_image_data(rgba).expect("png data");
}

fn frame(ui: &mut Ui, ras: &mut Raster, db: &AirportDb, pre: &mut PreFlight, inp: &mut Input, n: usize) {
    let (w, h) = (ras.w as f32, ras.h as f32);
    for _ in 0..n {
        ui.begin(w, h);
        let _ = pre.frame(ui, inp, db, UTC, 1.0 / 60.0, 60.0);
        ui.end();
        inp.end_frame();
    }
    ras.clear();
    ras.draw(ui);
}

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = args.next().unwrap_or_else(|| "uishots".into());
    let w: usize = args.next().and_then(|v| v.parse().ok()).unwrap_or(1280);
    let h: usize = args.next().and_then(|v| v.parse().ok()).unwrap_or(720);
    std::fs::create_dir_all(&dir).expect("out dir");
    let db = AirportDb::embedded();
    let mut pre = PreFlight::new(&db);
    pre.settings = Settings::default();
    pre.logbook = Vec::new();
    let mut ui = Ui::new();
    let mut ras = Raster::new(w, h);
    let mut inp = Input { mouse: [w as f32 * 0.4, h as f32 * 0.5], ..Default::default() };

    let shot = |ras: &Raster, name: &str, verts: usize| {
        save(&format!("{dir}/{name}.png"), w as u32, h as u32, &ras.rgba8());
        println!("{name}: {verts} UI vertices");
    };

    // 1. boot loader (real stages: run a few frames at 60 Hz)
    frame(&mut ui, &mut ras, &db, &mut pre, &mut inp, 45);
    shot(&ras, "01-boot-mid", ui.verts.len());
    // wait for the splash to finish
    let mut guard = 0;
    while pre.screen == Screen::Boot && guard < 400 {
        frame(&mut ui, &mut ras, &db, &mut pre, &mut inp, 1);
        guard += 1;
    }
    frame(&mut ui, &mut ras, &db, &mut pre, &mut inp, 30);
    shot(&ras, "02-menu", ui.verts.len());

    // hover a tile
    inp.mouse = [300.0, 200.0];
    frame(&mut ui, &mut ras, &db, &mut pre, &mut inp, 2);
    shot(&ras, "02b-menu-hover", ui.verts.len());
    inp.mouse = [w as f32 * 0.8, h as f32 * 0.9];

    pre.logbook = vec![
        LogEntry { utc: UTC, dep: "KSFO".into(), arr: "KOAK".into(), grade: "SMOOTH".into(), fpm: 186.0, speed_kt: 136.0, centreline_m: 1.8 },
        LogEntry { utc: UTC - 86400.0, dep: "EGLL".into(), arr: "EGKK".into(), grade: "FIRM".into(), fpm: 310.0, speed_kt: 141.0, centreline_m: 4.2 },
        LogEntry { utc: UTC - 2.0 * 86400.0, dep: "WIII".into(), arr: "WADD".into(), grade: "HARD".into(), fpm: 480.0, speed_kt: 144.0, centreline_m: 6.0 },
    ];
    for (name, kind) in [("03-settings", ModalKind::Settings), ("04-controls", ModalKind::Controls), ("05-logbook", ModalKind::Logbook)] {
        pre.modal = Some(kind);
        frame(&mut ui, &mut ras, &db, &mut pre, &mut inp, 2);
        shot(&ras, name, ui.verts.len());
    }
    for tab in 1..5 {
        pre.modal = Some(ModalKind::Settings);
        pre.settings_tab = tab;
        frame(&mut ui, &mut ras, &db, &mut pre, &mut inp, 2);
        shot(&ras, &format!("03-settings-tab{tab}"), ui.verts.len());
    }
    pre.modal = None;

    // 2. planner: default route, globe flies to frame it
    pre.goto(Screen::Planner);
    pre.planner.dep = "KSFO".into();
    pre.planner.arr = "KLAX".into();
    pre.planner.field = Field::Arr;
    pre.globe.fly_to(36.0, -120.0, 6.0);
    frame(&mut ui, &mut ras, &db, &mut pre, &mut inp, 240);
    shot(&ras, "06-planner", ui.verts.len());

    pre.planner.query = "lon".into();
    pre.planner.filters = Filters { intl: true, long_rwy: true, region: Some(Region::Europe), hard: false };
    pre.planner.refresh(&db);
    pre.planner.dep = "EGLL".into();
    pre.planner.arr = "LFPG".into();
    pre.planner.field = Field::Arr;
    pre.globe.fly_to(50.0, 1.0, 5.0);
    frame(&mut ui, &mut ras, &db, &mut pre, &mut inp, 240);
    shot(&ras, "07-planner-search", ui.verts.len());

    pre.planner.query.clear();
    pre.planner.filters = Filters::default();
    pre.planner.refresh(&db);
    pre.planner.tab = Tab::Routes;
    pre.planner.dep = "WIII".into();
    pre.planner.arr = "WADD".into();
    pre.globe.fly_to(-7.0, 110.0, 4.0);
    frame(&mut ui, &mut ras, &db, &mut pre, &mut inp, 240);
    shot(&ras, "08-planner-routes", ui.verts.len());

    // 3. briefings
    for (tag, a, b) in [("09-briefing-sfo-lax", "KSFO", "KLAX"), ("10-briefing-egll-kjfk", "EGLL", "KJFK"), ("11-briefing-wiii-wadd", "WIII", "WADD")] {
        pre.planner.dep = a.into();
        pre.planner.arr = b.into();
        pre.planner.prepare_briefing(&db, UTC);
        pre.goto(Screen::Briefing);
        frame(&mut ui, &mut ras, &db, &mut pre, &mut inp, 40);
        shot(&ras, tag, ui.verts.len());
    }

    // 4. globe close-ups (night side lights + terminator)
    pre.goto(Screen::Planner);
    pre.planner.tab = Tab::Airports;
    pre.globe.snap_to(25.0, 20.0, 1.0);
    frame(&mut ui, &mut ras, &db, &mut pre, &mut inp, 5);
    shot(&ras, "12-globe-terminator", ui.verts.len());
    pre.globe.snap_to(1.0, 104.0, 9.0);
    frame(&mut ui, &mut ras, &db, &mut pre, &mut inp, 5);
    shot(&ras, "13-globe-zoom-singapore", ui.verts.len());

    // 5. flight loader
    ui.begin(w as f32, h as f32);
    {
        let mut g = inflight::ui::Gui::new(&mut ui, &inp, 1.0);
        inflight::ui::screens::draw_flight_loader(&mut g, db.get("KSFO").unwrap(), db.get("KOAK").unwrap(), 0.55, 2, "Building airfield scenery and terrain...");
    }
    ui.end();
    ras.clear();
    ras.draw(&ui);
    shot(&ras, "14-flight-loader", ui.verts.len());
    println!("done -> {dir}/");
}
