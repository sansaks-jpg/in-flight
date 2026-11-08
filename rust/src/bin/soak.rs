//! Soak / leak / frame-time test.
//!
//! * Part A (always): many complete autopilot flights through the headless simulation, step-time statistics + RSS.
//! * Part B (always): 10 simulated minutes of terrain-ring + scatter generation along a flight path (the CPU part of
//!   rendering), per-frame time statistics + RSS.
//! * Part C (`--gpu`): the real renderer into an offscreen target for N frames, frame-time percentiles + RSS.
//!
//! usage: soak [--flights N] [--gpu] [--frames N] [--size WxH]
use inflight::airports::AirportDb;
use inflight::app::{make_camera, rss_mb, CamState};
use inflight::game::{Action, Flight, PilotInput, Status, PHYS_DT};
use inflight::gfx::geom::*;
use inflight::gfx::ui::{self, HudInfo, View};
use inflight::gfx::{new_headless, FrameParams};
use std::time::Instant;

fn pct(v: &mut [f32], p: f32) -> f32 {
    v.sort_by(|a, b| a.total_cmp(b));
    v[((v.len() as f32 - 1.0) * p) as usize]
}

fn main() {
    let mut flights = 12usize;
    let mut gpu = false;
    let mut frames = 600usize;
    let (mut w, mut h) = (640u32, 360u32);
    let mut a = std::env::args().skip(1);
    while let Some(x) = a.next() {
        match x.as_str() {
            "--flights" => flights = a.next().and_then(|v| v.parse().ok()).unwrap_or(flights),
            "--gpu" => gpu = true,
            "--frames" => frames = a.next().and_then(|v| v.parse().ok()).unwrap_or(frames),
            "--size" => {
                if let Some((sw, sh)) = a.next().and_then(|v| v.split_once('x').map(|(p, q)| (p.parse().unwrap_or(w), q.parse().unwrap_or(h)))) {
                    (w, h) = (sw, sh);
                }
            }
            _ => {}
        }
    }
    let db = AirportDb::embedded();
    let pairs = [("KSFO", "KOAK"), ("KLAX", "KSAN"), ("EGLL", "EGKK"), ("KJFK", "KEWR"), ("EDDF", "EDDM"), ("KSEA", "KPDX")];
    let base_utc = 1_718_884_800.0;

    // ------------------------------------------------------------ Part A
    println!("== A: {flights} complete autopilot flights (headless simulation, 120 Hz physics) ==");
    let mut rss: Vec<u64> = Vec::new();
    let (mut total_steps, mut worst_us, mut sum_us) = (0u64, 0.0f64, 0.0f64);
    let mut landed = 0;
    let mut batch_us: Vec<f32> = Vec::with_capacity(400_000);
    for k in 0..flights {
        let (d, ar) = pairs[k % pairs.len()];
        let mut f = Flight::new(&db, d, ar, base_utc + 86400.0 * (k as f64 * 3.0 + 1.0)).unwrap();
        f.apply(Action::ApAutoTakeoff);
        let inp = PilotInput::default();
        let mut steps = 0u64;
        loop {
            let t0 = Instant::now();
            for _ in 0..120 {
                f.step(PHYS_DT, &inp);
            }
            let us = t0.elapsed().as_secs_f64() * 1e6 / 120.0;
            sum_us += us * 120.0;
            worst_us = worst_us.max(us);
            if batch_us.len() < 400_000 {
                batch_us.push(us as f32);
            }
            steps += 120;
            if matches!(f.status, Status::Landed | Status::Crashed) || steps > 120 * 60 * 80 {
                break;
            }
        }
        total_steps += steps;
        if f.status == Status::Landed {
            landed += 1;
        }
        rss.push(rss_mb());
        println!("  flight {:>2} {}>{}: {:?} after {:.1} sim-min, touchdown {:.0} fpm | rss {} MB", k + 1, d, ar, f.status, f.t / 60.0, f.touchdown.map_or(0.0, |t| t.fpm), rss.last().unwrap());
    }
    let p99 = pct(&mut batch_us, 0.99);
    println!(
        "  landed {landed}/{flights} | {} physics steps ({:.1} sim-hours) | mean {:.2} us/step, p99 {:.2} us, worst-second {:.2} us (budget at 120 Hz: 8333 us)",
        total_steps,
        total_steps as f64 / 120.0 / 3600.0,
        sum_us / total_steps as f64,
        p99,
        worst_us
    );
    let growth = rss.last().copied().unwrap_or(0) as i64 - rss.get(1).copied().unwrap_or(0) as i64;
    println!("  RSS after warm-up flight: {} MB -> {} MB (growth {} MB)", rss.get(1).copied().unwrap_or(0), rss.last().copied().unwrap_or(0), growth);
    assert!(growth < 8, "possible memory leak in the simulation: +{growth} MB");
    assert_eq!(landed, flights, "every autopilot flight must land");

    // ------------------------------------------------------------ Part B
    println!("== B: 10 simulated minutes of terrain rings + scatter generation at 60 Hz ==");
    let f = Flight::new(&db, "KLAX", "KSAN", base_utc).unwrap();
    let (mut scratch, mut verts, mut trees, mut bldgs) = (Vec::new(), Vec::new(), Vec::with_capacity(7000), Vec::with_capacity(3500));
    let mut origins = [None; LEVELS];
    let mut frame_ms: Vec<f32> = Vec::with_capacity(60 * 600);
    let (mut cx, mut cz) = (f.fm.pos.x, f.fm.pos.z);
    let (mut last_c, mut rings) = ((f64::MAX, f64::MAX), 0u64);
    let mut rss0 = 0;
    for i in 0..(60 * 600) {
        let t0 = Instant::now();
        cx += 230.0 / 60.0;
        cz -= 80.0 / 60.0;
        let mut budget = 2;
        for l in 0..LEVELS {
            let o = snapped_origin(l, cx, cz);
            if origins[l] != Some(o) && (budget > 0 || origins[l].is_none()) {
                fill_ring(&f.terrain, l, o, &mut scratch, &mut verts);
                origins[l] = Some(o);
                budget -= 1;
                rings += 1;
            }
        }
        if (cx - last_c.0).hypot(cz - last_c.1) > 110.0 {
            last_c = (cx, cz);
            gen_trees(&f.terrain, cx, cz, 1800.0, &mut trees, 7000);
            gen_buildings(&f.terrain, cx, cz, 3200.0, &mut bldgs, 3500);
        }
        frame_ms.push(t0.elapsed().as_secs_f32() * 1000.0);
        if i == 600 {
            rss0 = rss_mb();
        }
        if i % 12000 == 11999 {
            println!("  t={:>3} s  rss {} MB  rings rebuilt {rings}", i / 60, rss_mb());
        }
    }
    let worst = frame_ms.iter().cloned().fold(0.0, f32::max);
    println!("  CPU world-gen per frame: p50 {:.3} ms, p99 {:.3} ms, worst {:.3} ms | RSS {} -> {} MB", pct(&mut frame_ms.clone(), 0.5), pct(&mut frame_ms, 0.99), worst, rss0, rss_mb());
    assert!(rss_mb() as i64 - rss0 as i64 <= 8, "world generation leaks memory");

    // ------------------------------------------------------------ Part C
    if gpu {
        println!("== C: real renderer, offscreen {w}x{h}, {frames} frames ==");
        let (mut r, off, adapter) = new_headless(w, h).expect("headless GPU");
        println!("  adapter: {adapter}");
        let mut f = Flight::new(&db, "KLAX", "KSAN", base_utc).unwrap();
        f.apply(Action::ApAutoTakeoff);
        let (mut cs, mut times, mut px) = (CamState::default(), Vec::with_capacity(frames), Vec::new());
        let mut rss_samples = Vec::new();
        for i in 0..frames {
            let t0 = Instant::now();
            // 8 frames of simulation per rendered frame so the aircraft really travels and the terrain rings stream
            let inp = PilotInput::default();
            for _ in 0..8 {
                f.advance(1.0 / 60.0, &inp);
            }
            let view = if i % 400 < 200 { View::Chase } else { View::Cockpit };
            let (cam, third) = make_camera(&f, view, &mut cs, 1.0 / 60.0, None);
            let fp = FrameParams {
                flight: Some(&f),
                cam,
                utc: f.utc(),
                time: i as f32 / 60.0,
                lat: f.lat,
                lon: f.lon,
                vis_km: f.weather.vis_km as f32,
                cloud_base: f.weather.cloud_base_m as f32,
                cloud_cover: f.weather.cloud_cover as f32,
                show_aircraft: third,
            };
            let info = HudInfo { fps: 60.0, frame_ms: 16.6, sim_ms: 0.4, view, paused: false, help: false, time: i as f64 / 60.0 };
            r.render(&off.view, &fp, &mut |u| ui::draw_hud(u, &f, &info));
            if i % 50 == 49 {
                off.read_rgba(&r, &mut px); // forces the GPU queue to drain so timings include GPU work
            }
            times.push(t0.elapsed().as_secs_f32() * 1000.0);
            if i % 100 == 99 {
                rss_samples.push(rss_mb());
                println!("  frame {:>4}: rss {} MB | alt {:.0} m | draws {} | {}k tris", i + 1, rss_mb(), f.fm.pos.y, r.stats.draw_calls, r.stats.triangles / 1000);
            }
        }
        let (p50, p99) = (pct(&mut times.clone(), 0.5), pct(&mut times, 0.99));
        let g = rss_samples.last().copied().unwrap_or(0) as i64 - rss_samples.get(1).copied().unwrap_or(0) as i64;
        println!("  frame time (8 sim-frames + render submit): p50 {p50:.2} ms, p99 {p99:.2} ms | RSS growth after warm-up: {g} MB");
        assert!(g < 12, "possible memory leak in the renderer: +{g} MB");
    }
    println!("SOAK OK");
}
