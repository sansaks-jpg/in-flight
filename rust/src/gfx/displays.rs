//! Airbus electronic displays drawn with the 2D UI batcher into a render-to-texture atlas (reference:
//! `src/sim/a320/displays.ts`, `efisDisplays.ts`, `ecam.ts`). The atlas is 2x2 cells of 512 px:
//!
//! | cell | unit | content |
//! |---|---|---|
//! | 0 | PFD | attitude, speed tape (VLS / Vα prot / Vα max / VSW / VMAX), altitude + VS, heading, FMA, ILS, protections |
//! | 1 | ND  | heading-up ARC display: route, runways, range arcs, compass arc, wind, GS/TAS, TO waypoint |
//! | 2 | E/WD | N1 / EGT / N2 / FF, fuel on board, flaps, memo + warnings (GPWS, stall, overspeed, config) |
//! | 3 | SD  | flight-control surfaces, spoilers, landing gear, fuel, weights / SAT |

use super::ui::*;
use crate::autopilot::ApPhase;
use crate::fbw;
use crate::game::Flight;
use crate::geo::{FT, KT};
use crate::gpws::Alert;
use crate::physics::{atmosphere, EngState};

const S: f32 = crate::cockpit::ATLAS_CELL as f32;

macro_rules! tf {
    ($ui:expr, $x:expr, $y:expr, $s:expr, $c:expr, $a:expr, $($arg:tt)*) => { $ui.textf($x, $y, $s, $c, $a, format_args!($($arg)*)) };
}

fn begin_cell(ui: &mut Ui, x: f32, y: f32) {
    ui.scissor(Some([x, y, S, S]));
    ui.rect(x, y, S, S, [0.004, 0.006, 0.01, 1.0]);
}

/// Draw all four display cells.
pub fn draw_atlas(ui: &mut Ui, f: &Flight, time: f64) {
    begin_cell(ui, 0.0, 0.0);
    pfd(ui, f, 0.0, 0.0, time);
    begin_cell(ui, S, 0.0);
    nd(ui, f, S, 0.0);
    begin_cell(ui, 0.0, S);
    ewd(ui, f, 0.0, S, time);
    begin_cell(ui, S, S);
    sd(ui, f, S, S);
    ui.scissor(None);
}

fn pt(c: [f32; 2], r: f32, deg: f32) -> [f32; 2] {
    let a = deg.to_radians();
    [c[0] + r * a.sin(), c[1] - r * a.cos()]
}

/// Polyline arc, angles in degrees clockwise from "up".
fn arc(ui: &mut Ui, c: [f32; 2], r: f32, a0: f32, a1: f32, th: f32, col: Col) {
    let n = 32;
    for k in 0..n {
        let (t0, t1) = (a0 + (a1 - a0) * k as f32 / n as f32, a0 + (a1 - a0) * (k + 1) as f32 / n as f32);
        ui.line(pt(c, r, t0), pt(c, r, t1), th, col);
    }
}

// ---------------------------------------------------------------- PFD

fn pfd(ui: &mut Ui, f: &Flight, ox: f32, oy: f32, time: f64) {
    let fm = &f.fm;
    let env = fbw::envelope(fm);
    let u = 33.0;
    draw_pfd(ui, f, ox + (S - 14.0 * u) / 2.0 + 0.2 * u, oy + 82.0, u);
    ui.scissor(Some([ox, oy, S, S]));
    // ---- FMA (flight mode annunciator): 5 columns ----
    ui.frame(ox + 4.0, oy + 4.0, S - 8.0, 70.0, 2.0, [0.35, 0.37, 0.42, 1.0]);
    for k in 1..5 {
        ui.rect(ox + 4.0 + (S - 8.0) / 5.0 * k as f32, oy + 4.0, 1.5, 70.0, [0.25, 0.27, 0.3, 1.0]);
    }
    let cw = (S - 8.0) / 5.0;
    let col = |k: usize| ox + 4.0 + cw * (k as f32 + 0.5);
    let ap = &f.ap;
    let thr = if fm.ctl.throttle > 0.97 { "TOGA" } else if ap.on { "SPEED" } else { "MAN THR" };
    tf!(ui, col(0), oy + 10.0, 21.0, if ap.on { C_GREEN } else { C_WHITE }, 1, "{}", thr);
    let vert = if !ap.on {
        ""
    } else {
        match ap.phase {
            ApPhase::Takeoff => "SRS",
            ApPhase::Climb => "CLB",
            ApPhase::Cruise => "ALT CRZ",
            ApPhase::Descent => "DES",
            _ => ap.phase.label(),
        }
    };
    tf!(ui, col(1), oy + 10.0, 21.0, C_GREEN, 1, "{}", vert);
    let lat = if !ap.on { "" } else if ap.appr { "LOC" } else if ap.nav { "NAV" } else { "HDG" };
    tf!(ui, col(2), oy + 10.0, 21.0, C_GREEN, 1, "{}", lat);
    tf!(ui, col(3), oy + 10.0, 21.0, C_GREEN, 1, "{}", if ap.on && ap.appr { "G/S" } else { "" });
    tf!(ui, col(4), oy + 10.0, 21.0, C_WHITE, 1, "{}", if ap.on { "AP1 A/THR" } else { "" });
    // second FMA line: protections / law status
    let flash = (time * 3.0) as i64 % 2 == 0;
    let (txt, c) = if env.alpha_floor {
        ("A.FLOOR", C_RED)
    } else if fm.stall_warn {
        ("STALL", if flash { C_RED } else { C_AMBER })
    } else if env.alpha_prot {
        ("ALPHA PROT", C_AMBER)
    } else if env.high_speed_prot {
        ("HS PROT", C_AMBER)
    } else if fm.ctl.assist {
        ("NORMAL LAW", C_GREEN)
    } else {
        ("DIRECT LAW", C_AMBER)
    };
    tf!(ui, col(1), oy + 40.0, 21.0, c, 1, "{}", txt);
    tf!(ui, col(3), oy + 40.0, 21.0, C_CYAN, 1, "{}", if env.bank_over_neutral && fm.ctl.assist { "BANK>33" } else { "" });
    // pitch / bank / load-factor limits strip under the PFD
    let y = oy + 82.0 + 10.4 * u + 12.0;
    tf!(ui, ox + 12.0, y, 20.0, C_GREY, 0, "QNH {:.0}", f.weather.qnh);
    tf!(ui, ox + S / 2.0, y, 20.0, C_GREY, 1, "LIM {:+.0}/{:.0}  {:.1}G", env.pitch_up_deg, env.pitch_down_deg, env.nz_up);
    tf!(ui, ox + S - 12.0, y, 20.0, if fm.nz > 2.0 { C_AMBER } else { C_GREY }, 2, "{:.2}G", fm.nz);
    // VLS / alpha-prot speeds as numeric reference
    tf!(ui, ox + 12.0, y + 26.0, 20.0, C_AMBER, 0, "VLS {:.0}", env.vls);
    tf!(ui, ox + S / 2.0, y + 26.0, 20.0, C_AMBER, 1, "VAP {:.0}", env.v_alpha_prot);
    tf!(ui, ox + S - 12.0, y + 26.0, 20.0, C_RED, 2, "VMAX {:.0}", env.vmax);
}

// ---------------------------------------------------------------- ND

fn nd(ui: &mut Ui, f: &Flight, ox: f32, oy: f32) {
    let fm = &f.fm;
    ui.scissor(Some([ox, oy, S, S]));
    // aircraft at the bottom centre; arc covers +-70 deg
    let c = [ox + S / 2.0, oy + S * 0.80];
    let r_out = S * 0.62;
    let range_nm: f64 = if fm.agl < 1500.0 { 10.0 } else if fm.pos.y < 6000.0 { 20.0 } else { 40.0 };
    let k = (r_out as f64) / (range_nm * 1852.0);
    let hdg = fm.heading.to_radians();
    let (sh, ch) = (hdg.sin(), hdg.cos());
    let rot = |wx: f64, wz: f64| -> [f32; 2] {
        let (dx, dz) = (wx - fm.pos.x, wz - fm.pos.z);
        let fwd = dx * sh - dz * ch;
        let right = dx * ch + dz * sh;
        [c[0] + (right * k) as f32, c[1] - (fwd * k) as f32]
    };
    // range arcs
    for i in 1..=3 {
        let r = r_out * i as f32 / 3.0;
        arc(ui, c, r, -70.0, 70.0, 1.5, [0.42, 0.45, 0.5, 1.0]);
        tf!(ui, c[0] + 4.0, c[1] - r - 16.0, 17.0, C_CYAN, 0, "{:.0}", range_nm * i as f64 / 3.0);
    }
    // route
    let mut prev: Option<[f32; 2]> = None;
    for (i, w) in f.plan.iter().enumerate() {
        let p = rot(f.proj.x(w.lon), f.proj.z(w.lat));
        if let Some(q) = prev {
            let active = i == f.active_wp;
            ui.line(q, p, if active { 3.5 } else { 2.0 }, if i <= f.active_wp && !active { [0.4, 0.4, 0.45, 1.0] } else if active { C_MAGENTA } else { [0.8, 0.8, 0.85, 1.0] });
        }
        if (p[0] - c[0]).abs() < S * 0.7 && p[1] > oy && p[1] < oy + S {
            ui.circle(p, if i == f.active_wp { 6.0 } else { 4.0 }, if i == f.active_wp { C_MAGENTA } else { C_WHITE });
            if i + 1 >= f.active_wp && i <= f.active_wp + 2 {
                tf!(ui, p[0] + 9.0, p[1] - 8.0, 18.0, if i == f.active_wp { C_MAGENTA } else { C_WHITE }, 0, "{}", w.name);
            }
        }
        prev = Some(p);
    }
    // runways
    for e in [&f.dep_end, &f.arr_end] {
        let a = rot(f.proj.x(e.start_lon), f.proj.z(e.start_lat));
        let b = rot(f.proj.x(e.end_lon), f.proj.z(e.end_lat));
        ui.line(a, b, 4.0, C_WHITE);
    }
    // compass arc with heading ticks (rotating with the aircraft)
    let r_c = r_out + 14.0;
    arc(ui, c, r_c, -75.0, 75.0, 2.0, C_WHITE);
    let h0 = ((fm.heading - 80.0) / 5.0).floor() as i32 * 5;
    for hd in (h0..=h0 + 170).step_by(5) {
        let rel = (hd as f64 - fm.heading) as f32;
        if rel.abs() > 75.0 {
            continue;
        }
        let long = hd % 10 == 0;
        ui.line(pt(c, r_c, rel), pt(c, r_c + if long { 12.0 } else { 6.0 }, rel), 2.0, C_WHITE);
        if hd % 30 == 0 {
            let v = ((hd % 360) + 360) % 360;
            let p = pt(c, r_c + 30.0, rel);
            tf!(ui, p[0], p[1] - 9.0, 19.0, C_WHITE, 1, "{}", v / 10);
        }
    }
    // track bug + selected heading bug
    let trk = pt(c, r_c, crate::geo::wrap180(fm.track - fm.heading) as f32);
    ui.tri([trk[0], trk[1]], [trk[0] - 6.0, trk[1] + 11.0], [trk[0] + 6.0, trk[1] + 11.0], C_GREEN);
    let hb = crate::geo::wrap180(f.ap.hdg - fm.heading) as f32;
    if hb.abs() < 75.0 {
        let p = pt(c, r_c, hb);
        ui.rect(p[0] - 5.0, p[1] - 5.0, 10.0, 10.0, C_CYAN);
    }
    // aircraft symbol
    ui.line([c[0], c[1] - 18.0], [c[0], c[1] + 14.0], 3.0, C_AMBER);
    ui.line([c[0] - 14.0, c[1] + 3.0], [c[0] + 14.0, c[1] + 3.0], 3.0, C_AMBER);
    ui.line([c[0] - 6.0, c[1] + 12.0], [c[0] + 6.0, c[1] + 12.0], 3.0, C_AMBER);
    // header: GS / TAS, wind, TO waypoint
    ui.scissor(Some([ox, oy, S, S]));
    tf!(ui, ox + 8.0, oy + 6.0, 22.0, C_WHITE, 0, "GS");
    tf!(ui, ox + 44.0, oy + 6.0, 22.0, C_GREEN, 0, "{:.0}", fm.gs / KT);
    tf!(ui, ox + 100.0, oy + 6.0, 22.0, C_WHITE, 0, "TAS");
    tf!(ui, ox + 156.0, oy + 6.0, 22.0, C_GREEN, 0, "{:.0}", fm.tas / KT);
    if let Some((wp, d, eta)) = f.next_wp() {
        tf!(ui, ox + S - 8.0, oy + 6.0, 22.0, C_MAGENTA, 2, "{}", wp.name);
        tf!(ui, ox + S - 8.0, oy + 32.0, 20.0, C_WHITE, 2, "{:.1}NM", d / 1852.0);
        tf!(ui, ox + S - 8.0, oy + 56.0, 20.0, C_WHITE, 2, "{}:{:02}", (eta / 60.0) as u32, (eta % 60.0) as u32);
    }
    let w = f.weather;
    // wind relative to the heading: arrow shows where the air moves
    let rel_wind = (w.wind_from_deg - fm.heading).to_radians() as f32;
    tf!(ui, ox + 8.0, oy + 34.0, 20.0, C_GREEN, 0, "{:03.0}/{:.0}", w.wind_from_deg, w.wind_kt);
    let wc = [ox + 50.0, oy + 90.0];
    let tail = pt(wc, 22.0, rel_wind.to_degrees());
    let head = pt(wc, 22.0, rel_wind.to_degrees() + 180.0);
    ui.line(tail, head, 3.0, C_GREEN);
    let dirv = [head[0] - tail[0], head[1] - tail[1]];
    let l = (dirv[0] * dirv[0] + dirv[1] * dirv[1]).sqrt().max(1.0);
    let (ux, uy) = (dirv[0] / l, dirv[1] / l);
    ui.tri(head, [head[0] - ux * 11.0 - uy * 6.0, head[1] - uy * 11.0 + ux * 6.0], [head[0] - ux * 11.0 + uy * 6.0, head[1] - uy * 11.0 - ux * 6.0], C_GREEN);
    tf!(ui, ox + 8.0, oy + S - 26.0, 19.0, C_CYAN, 0, "ARC {:.0}NM", range_nm);
    if f.ils.valid && f.ils.dist < 46000.0 {
        tf!(ui, ox + S - 8.0, oy + S - 26.0, 19.0, C_MAGENTA, 2, "ILS {:03.0} {:.1}NM", f.ils.course, f.ils.dist / 1852.0);
    }
}

// ---------------------------------------------------------------- E/WD

fn n1_gauge(ui: &mut Ui, c: [f32; 2], r: f32, v: f32, label_col: Col) {
    let (a0, a1) = (-135.0, 90.0);
    let ang = |x: f32| a0 + (a1 - a0) * (x / 110.0).clamp(0.0, 1.0);
    arc(ui, c, r, a0, a1, 3.0, [0.7, 0.72, 0.78, 1.0]);
    arc(ui, c, r + 4.0, ang(100.0), ang(110.0), 5.0, C_RED); // max N1 band
    for t in [0.0, 20.0, 40.0, 60.0, 80.0, 100.0] {
        ui.line(pt(c, r - 9.0, ang(t)), pt(c, r + 3.0, ang(t)), 2.0, C_WHITE);
    }
    let col = if v > 100.5 { C_AMBER } else { label_col };
    ui.line(pt(c, r * 0.12, ang(v) + 180.0), pt(c, r - 2.0, ang(v)), 4.0, col);
    ui.circle(c, 6.0, [0.8, 0.8, 0.85, 1.0]);
}

fn ewd(ui: &mut Ui, f: &Flight, ox: f32, oy: f32, time: f64) {
    let fm = &f.fm;
    ui.scissor(Some([ox, oy, S, S]));
    // engine parameters (derived from the spool state: N1 = spool fraction, N2 / EGT follow the same curve)
    for i in 0..2 {
        let running = fm.eng[i].state != EngState::Off;
        let n1 = (fm.n[i] * 100.0) as f32 * if running { 1.0 } else { 0.0 };
        let c = [ox + 135.0 + i as f32 * 235.0, oy + 118.0];
        n1_gauge(ui, c, 68.0, n1, C_GREEN);
        tf!(ui, c[0] + 62.0, c[1] - 6.0, 34.0, if running { C_GREEN } else { C_AMBER }, 2, "{:.0}", n1.min(110.0));
        tf!(ui, c[0], c[1] - 108.0, 22.0, C_CYAN, 1, "N1 %");
        let n = fm.n[i];
        let egt = if running { 380.0 + 560.0 * n.powf(1.7) } else { 25.0 };
        let n2 = if running { 55.0 + 45.0 * n.powf(0.8) } else { 0.0 };
        let ff = if fm.eng[i].state == EngState::Running { fm.fuel_flow * 3600.0 / 2.0 } else { 0.0 };
        let x = ox + 24.0 + i as f32 * 235.0;
        tf!(ui, x + 50.0, oy + 204.0, 28.0, if egt > 900.0 { C_AMBER } else { C_GREEN }, 2, "{:.0}", egt);
        tf!(ui, x + 50.0, oy + 238.0, 28.0, C_GREEN, 2, "{:.1}", n2);
        tf!(ui, x + 50.0, oy + 272.0, 28.0, C_GREEN, 2, "{:.0}", ff);
        ui.rect(x + 66.0, oy + 214.0, 100.0 * (egt as f32 / 1000.0).min(1.0), 8.0, if egt > 900.0 { C_AMBER } else { [0.2, 0.7, 0.3, 1.0] });
    }
    for (y, l, u2) in [(204.0, "EGT", "C"), (238.0, "N2", "%"), (272.0, "F.FLOW", "KG/H")] {
        tf!(ui, ox + 260.0, oy + y + 4.0, 20.0, C_CYAN, 1, "{}", l);
        let _ = u2;
    }
    ui.rect(ox + 8.0, oy + 312.0, S - 16.0, 2.0, [0.5, 0.52, 0.58, 1.0]);
    // flaps / slats + fuel on board (right-hand column of the lower area)
    let fl = ["0", "1", "1+F", "2", "3", "FULL"];
    let idx = match fm.ctl.flaps_idx {
        0 => 0,
        1 => 2,
        2 => 3,
        3 => 4,
        _ => 5,
    };
    tf!(ui, ox + S - 12.0, oy + 322.0, 20.0, C_CYAN, 2, "S F");
    tf!(ui, ox + S - 12.0, oy + 346.0, 26.0, C_GREEN, 2, "{}", fl[idx.min(5)]);
    tf!(ui, ox + S - 12.0, oy + 386.0, 20.0, C_CYAN, 2, "FOB");
    tf!(ui, ox + S - 12.0, oy + 408.0, 26.0, if fm.fuel < 1500.0 { C_AMBER } else { C_GREEN }, 2, "{:.0}", fm.fuel);
    tf!(ui, ox + S - 12.0, oy + 438.0, 18.0, C_CYAN, 2, "KG");
    // memo / warnings, most severe first (max 6 lines)
    let mut y = oy + 322.0;
    let mut line = |ui: &mut Ui, col: Col, s: &str| {
        if y < oy + S - 24.0 {
            tf!(ui, ox + 12.0, y, 22.0, col, 0, "{}", s);
            y += 26.0;
        }
    };
    let flash = (time * 3.0) as i64 % 2 == 0;
    let g = f.gpws_out;
    if g.alert != Alert::None && (flash || !g.alert.is_warning()) {
        line(ui, if g.alert.is_warning() { C_RED } else { C_AMBER }, g.alert.text());
    }
    let lim = fm.limits();
    if lim.flap_over {
        line(ui, C_AMBER, "FLAP OVERSPEED");
    }
    if lim.gear_over {
        line(ui, C_AMBER, "L/G SPEED LIMIT");
    }
    if fm.fuel < 1500.0 {
        line(ui, C_AMBER, "FUEL LOW");
    }
    if fm.eng.iter().any(|e| e.state == EngState::Off) && fm.airborne_time > 5.0 {
        line(ui, C_RED, "ENG FAIL");
    }
    if fm.wow && fm.gs < 40.0 && fm.ctl.flaps_idx == 0 && fm.ctl.throttle > 0.6 {
        line(ui, C_AMBER, "CONFIG FLAPS");
    }
    if fm.ctl.parking {
        line(ui, C_GREEN, "PARK BRK");
    }
    if fm.ctl.autobrake > 0 {
        line(ui, C_GREEN, ["", "AUTO BRK LO", "AUTO BRK MED", "AUTO BRK MAX"][fm.ctl.autobrake.min(3) as usize]);
    }
    if fm.ctl.spoilers_armed {
        line(ui, C_GREEN, "GND SPLRS ARMED");
    }
    if fm.ctl.gear_down && !fm.wow {
        line(ui, C_GREEN, "LDG GEAR DN");
    }
    if f.ap.on {
        line(ui, C_GREEN, "AP1 ENGAGED");
    }
}

// ---------------------------------------------------------------- SD

fn sd(ui: &mut Ui, f: &Flight, ox: f32, oy: f32) {
    let fm = &f.fm;
    ui.scissor(Some([ox, oy, S, S]));
    tf!(ui, ox + S / 2.0, oy + 8.0, 28.0, C_GREEN, 1, "F/CTL");
    // surfaces: aileron L/R, elevator, rudder (position bars, + = deflection)
    let bar = |ui: &mut Ui, x: f32, y: f32, h: f32, v: f64, label: &str| {
        ui.rect(x - 7.0, y, 14.0, h, [0.12, 0.14, 0.18, 1.0]);
        ui.frame(x - 7.0, y, 14.0, h, 1.5, [0.5, 0.52, 0.58, 1.0]);
        let c = y + h / 2.0;
        ui.rect(x - 12.0, c - 1.0, 24.0, 2.0, C_WHITE);
        let m = c - (v as f32).clamp(-1.0, 1.0) * h * 0.46;
        ui.rect(x - 11.0, m - 3.0, 22.0, 6.0, C_GREEN);
        tf!(ui, x, y + h + 4.0, 18.0, C_CYAN, 1, "{}", label);
    };
    bar(ui, ox + 70.0, oy + 54.0, 90.0, -fm.surf.ail, "AIL L");
    bar(ui, ox + S - 70.0, oy + 54.0, 90.0, fm.surf.ail, "AIL R");
    bar(ui, ox + S / 2.0 - 40.0, oy + 54.0, 90.0, fm.surf.el, "ELEV");
    bar(ui, ox + S / 2.0 + 40.0, oy + 54.0, 90.0, fm.surf.rud, "RUD");
    // spoilers / speedbrake
    tf!(ui, ox + 12.0, oy + 172.0, 20.0, C_CYAN, 0, "SPLR");
    ui.rect(ox + 80.0, oy + 176.0, 200.0, 12.0, [0.12, 0.14, 0.18, 1.0]);
    ui.rect(ox + 80.0, oy + 176.0, 200.0 * fm.sb_pos as f32, 12.0, if fm.sb_pos > 0.05 { C_GREEN } else { C_GREY });
    tf!(ui, ox + 290.0, oy + 172.0, 20.0, C_GREEN, 0, "{:.0}%", fm.sb_pos * 100.0);
    // landing gear: nose / left / right triangles
    tf!(ui, ox + S / 2.0, oy + 214.0, 24.0, C_WHITE, 1, "L/G");
    let down = fm.gear_pos > 0.98;
    let up = fm.gear_pos < 0.02;
    let (gc, label) = if down { (C_GREEN, "DOWN") } else if up { (C_GREY, "UP") } else { (C_RED, "TRANSIT") };
    for (dx, dy) in [(0.0f32, 0.0f32), (-70.0, 34.0), (70.0, 34.0)] {
        let p = [ox + S / 2.0 + dx, oy + 262.0 + dy];
        if !up {
            ui.tri([p[0] - 18.0, p[1] - 14.0], [p[0] + 18.0, p[1] - 14.0], [p[0], p[1] + 16.0], gc);
        } else {
            ui.frame(p[0] - 16.0, p[1] - 12.0, 32.0, 24.0, 1.5, [0.3, 0.32, 0.36, 1.0]);
        }
    }
    tf!(ui, ox + S / 2.0, oy + 334.0, 20.0, gc, 1, "{}", label);
    // fuel + weights
    ui.rect(ox + 8.0, oy + 366.0, S - 16.0, 2.0, [0.5, 0.52, 0.58, 1.0]);
    tf!(ui, ox + 14.0, oy + 380.0, 20.0, C_CYAN, 0, "FUEL");
    ui.rect(ox + 80.0, oy + 384.0, 260.0, 14.0, [0.12, 0.14, 0.18, 1.0]);
    ui.rect(ox + 80.0, oy + 384.0, 260.0 * (fm.fuel / fm.spec.fuel_cap).clamp(0.0, 1.0) as f32, 14.0, if fm.fuel < 1500.0 { C_AMBER } else { C_GREEN });
    tf!(ui, ox + S - 12.0, oy + 378.0, 24.0, C_GREEN, 2, "{:.0}", fm.fuel);
    let sat = atmosphere(fm.pos.y, &fm.air).t - 273.15;
    tf!(ui, ox + 14.0, oy + 422.0, 20.0, C_CYAN, 0, "SAT");
    tf!(ui, ox + 70.0, oy + 422.0, 20.0, C_GREEN, 0, "{:+.0}C", sat);
    tf!(ui, ox + S / 2.0 + 20.0, oy + 422.0, 20.0, C_CYAN, 0, "GW");
    tf!(ui, ox + S - 12.0, oy + 422.0, 20.0, C_GREEN, 2, "{:.0}KG", fm.mass);
    tf!(ui, ox + 14.0, oy + 452.0, 20.0, C_CYAN, 0, "ALT");
    tf!(ui, ox + 70.0, oy + 452.0, 20.0, C_GREEN, 0, "{:.0}FT", fm.pos.y / FT);
    let (hh, mm) = crate::clock::hhmm(f.utc());
    tf!(ui, ox + S - 12.0, oy + 452.0, 20.0, C_WHITE, 2, "{:02}:{:02}Z", hh, mm);
}
