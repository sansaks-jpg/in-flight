//! Offscreen visual test: renders a set of gameplay scenarios (menu, ground, take-off, cruise, approach, night, landing,
//! summary) through the real renderer and writes PNGs. Works on any wgpu adapter (hardware or lavapipe).
//!
//! usage: shots [out_dir] [width] [height]
use inflight::airports::AirportDb;
use inflight::app::{make_camera, CamState};
use inflight::camera::Focus;
use inflight::game::{Action, Flight, PilotInput, Status, PHYS_DT};
use inflight::gfx::ui::{self, HudInfo, MenuState, View};
use inflight::gfx::{new_headless, FrameParams};
use std::io::BufWriter;
use std::time::Instant;

const DAY: f64 = 1_718_914_200.0; // 2024-06-20 20:10Z  (solar noon at SFO)
const NIGHT: f64 = 1_718_870_400.0; // 2024-06-20 08:00Z (01:00 local)
const DUSK: f64 = 1_718_941_500.0; // 2024-06-21 03:45Z (sunset)

fn save(path: &str, w: u32, h: u32, rgba: &[u8]) {
    let file = BufWriter::new(std::fs::File::create(path).expect("png file"));
    let mut enc = png::Encoder::new(file, w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().expect("png header").write_image_data(rgba).expect("png data");
}

fn run_until(f: &mut Flight, secs: f64, pred: impl Fn(&Flight) -> bool) {
    let inp = PilotInput::default();
    let n = (secs / PHYS_DT) as u64;
    for _ in 0..n {
        f.step(PHYS_DT, &inp);
        if pred(f) || matches!(f.status, Status::Crashed) {
            break;
        }
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = args.next().unwrap_or_else(|| "shots".into());
    let w: u32 = args.next().and_then(|v| v.parse().ok()).unwrap_or(1280);
    let h: u32 = args.next().and_then(|v| v.parse().ok()).unwrap_or(720);
    std::fs::create_dir_all(&dir).expect("out dir");
    let (mut r, off, adapter) = new_headless(w, h).expect("headless GPU");
    println!("adapter: {adapter}, {w}x{h}");
    let db = AirportDb::embedded();
    let mut pixels = Vec::new();

    let mut shot = |name: &str, f: &Flight, view: View, focus: Focus, menu: Option<&MenuState>, help: bool| {
        // every screenshot is taken with the springs already settled (a fly-in would only show a half-way frame)
        let mut cs = CamState::default();
        cs.focus(focus);
        cs.snap();
        let t = 5.0;
        let (cam, third) = make_camera(f, view, &mut cs, 1.0, if menu.is_some() { Some(t) } else { None });
        let fp = FrameParams {
            flight: Some(f),
            cam,
            utc: f.utc(),
            time: t as f32,
            lat: f.lat,
            lon: f.lon,
            vis_km: f.weather.vis_km as f32,
            cloud_base: f.weather.cloud_base_m as f32,
            cloud_cover: f.weather.cloud_cover as f32,
            show_aircraft: third || menu.is_some(),
            cockpit: view.is_interior() && menu.is_none(),
            sys: None,
        };
        let info = HudInfo { fps: 60.0, frame_ms: 16.6, sim_ms: 0.4, view, cam_label: cs.label(view), paused: false, help, time: t, panels3d: view.is_interior() };
        let t0 = Instant::now();
        // two frames: the first builds the terrain rings / scatter, the second is the steady-state frame
        for _ in 0..2 {
            r.render(&off.view, &fp, &mut |u| {
                if let Some(m) = menu {
                    ui::draw_menu(u, m, t, 60.0);
                    if help {
                        ui::draw_help(u, 16.0);
                    }
                } else {
                    ui::draw_hud(u, f, &info);
                }
            });
        }
        off.read_rgba(&r, &mut pixels);
        save(&format!("{dir}/{name}.png"), w, h, &pixels);
        let s = r.stats;
        println!(
            "{name}: {:.0} ms (2 frames + readback) | draws {} | {}k tris | terrain {:.2} ms scatter {:.2} ms ui {:.2} ms | rings rebuilt {}",
            t0.elapsed().as_secs_f64() * 1000.0,
            s.draw_calls,
            s.triangles / 1000,
            s.terrain_ms,
            s.scatter_ms,
            s.ui_ms,
            s.rings_rebuilt
        );
    };

    // 1. menu with the airport preview
    let f = Flight::new(&db, "KSFO", "KOAK", DAY).unwrap();
    let menu = MenuState { dep: "KSFO".into(), arr: "KOAK".into(), field: 0, msg: String::new(), dep_name: "KSFO - San Francisco Intl".into(), arr_name: "KOAK - Oakland San Francisco Bay".into() };
    shot("01-menu", &f, View::Chase, Focus::Seat, Some(&menu), false);
    // 2. cockpit on the runway, daytime
    shot("02-cockpit-runway", &f, View::Cockpit, Focus::Seat, None, false);
    shot("02b-chase-runway", &f, View::Chase, Focus::Seat, None, false);
    shot("02c-help", &f, View::Cockpit, Focus::Seat, None, true);

    // 3. auto take-off, just after rotation
    let mut f = Flight::new(&db, "KSFO", "KOAK", DAY).unwrap();
    f.apply(Action::ApAutoTakeoff);
    run_until(&mut f, 120.0, |f| f.fm.agl > 60.0);
    shot("03-takeoff-chase", &f, View::Chase, Focus::Seat, None, false);
    shot("03b-takeoff-cockpit", &f, View::Cockpit, Focus::Seat, None, false);

    // 4. cruise (LAX -> SAN, long enough to reach a real cruise level)
    let mut f = Flight::new(&db, "KLAX", "KSAN", DAY).unwrap();
    f.apply(Action::ApAutoTakeoff);
    run_until(&mut f, 600.0, |f| f.fm.pos.y > 6500.0 && f.ap.phase == inflight::autopilot::ApPhase::Cruise);
    shot("04-cruise-chase", &f, View::Chase, Focus::Seat, None, false);
    shot("04b-cruise-cockpit", &f, View::Cockpit, Focus::Seat, None, false);

    // 5. short final: day + night + dusk
    for (tag, utc) in [("day", DAY), ("night", NIGHT), ("dusk", DUSK)] {
        let mut f = Flight::new(&db, "KSFO", "KOAK", utc).unwrap();
        f.apply(Action::ApAutoTakeoff);
        run_until(&mut f, 1500.0, |f| f.ils.valid && f.ils.dist < 2200.0 && f.fm.agl < 260.0);
        shot(&format!("05-final-cockpit-{tag}"), &f, View::Cockpit, Focus::Seat, None, false);
        shot(&format!("05-final-tower-{tag}"), &f, View::Tower, Focus::Seat, None, false);
        if tag == "night" {
            shot("05-final-chase-night", &f, View::Chase, Focus::Seat, None, false);
        }
        if tag == "day" {
            run_until(&mut f, 120.0, |f| f.status == Status::Landed);
            shot("06-landed-summary", &f, View::Cockpit, Focus::Seat, None, false);
        }
    }
    // 7. flight deck close-ups: panel view on the ramp and in cruise (live PFD / ND / E-WD / SD textures)
    let f = Flight::new(&db, "KSFO", "KOAK", DAY).unwrap();
    shot("07-panel-ground", &f, View::Cockpit, Focus::Panel, None, false);
    let mut f = Flight::new(&db, "KLAX", "KSAN", DAY).unwrap();
    f.apply(Action::ApAutoTakeoff);
    run_until(&mut f, 400.0, |f| f.fm.pos.y > 4500.0 && f.ap.phase == inflight::autopilot::ApPhase::Climb);
    shot("07b-panel-climb", &f, View::Cockpit, Focus::Panel, None, false);
    // one close-up per panel preset (the camera hot-bar / number row 1-9)
    for foc in [Focus::Fcu, Focus::Pfd, Focus::Nd, Focus::Ecam, Focus::Ovhd, Focus::Ped] {
        shot(&format!("07d-focus-{}", foc.label().to_lowercase()), &f, View::Cockpit, foc, None, false);
    }
    shot("07c-wing-climb", &f, View::Wing, Focus::Seat, None, false);

    // 8. weather: overcast + thunderstorm on final (volumetric clouds, rain streaks, lightning, wet runway)
    {
        use inflight::weather::Weather;
        let storm = Weather { cloud_cover: 0.95, cloud_base_m: 900.0, precip: 0.85, thunder: true, vis_km: 4.5, cirrus: 0.5, wind_from_deg: 280.0, wind_kt: 14.0, ..Weather::calm() };
        let mut f = Flight::new(&db, "KSFO", "KOAK", DAY).unwrap();
        f.weather = storm;
        f.fm.wetness = 0.85;
        f.apply(Action::ApAutoTakeoff);
        run_until(&mut f, 150.0, |f| f.fm.agl > 400.0);
        shot("08-storm-climb-chase", &f, View::Chase, Focus::Seat, None, false);
        shot("08b-storm-climb-cockpit", &f, View::Cockpit, Focus::Seat, None, false);
        // find a lightning flash for the sky glow
        let mut tt = 5.0;
        while inflight::precip::lightning(&f.weather, tt).0 < 0.7 && tt < 400.0 {
            tt += 0.05;
        }
        println!("lightning flash at t = {tt:.2} s");
        // fair-weather cumulus seen from above and below
        let mut f = Flight::new(&db, "KLAX", "KSAN", DAY).unwrap();
        f.weather = Weather { cloud_cover: 0.62, cloud_base_m: 2200.0, cirrus: 0.35, ..Weather::calm() };
        f.apply(Action::ApAutoTakeoff);
        run_until(&mut f, 500.0, |f| f.fm.pos.y > 3600.0);
        shot("09-cumulus-above-chase", &f, View::Chase, Focus::Seat, None, false);
        shot("09b-cumulus-above-cockpit", &f, View::Cockpit, Focus::Seat, None, false);
        let mut f = Flight::new(&db, "KSFO", "KOAK", DUSK).unwrap();
        f.weather = Weather { cloud_cover: 0.55, cloud_base_m: 1800.0, cirrus: 0.6, ..Weather::calm() };
        f.apply(Action::ApAutoTakeoff);
        run_until(&mut f, 200.0, |f| f.fm.agl > 700.0);
        shot("10-dusk-clouds-cockpit", &f, View::Cockpit, Focus::Seat, None, false);
    }
    println!("done -> {dir}/");
}
