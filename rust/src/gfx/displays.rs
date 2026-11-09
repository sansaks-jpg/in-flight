//! Working A320 display units (PFD, ND, upper ECAM E/WD, lower ECAM SD, MCDU) in the render-to-texture atlas.
//! Reference: `src/sim/a320/displays.ts`, `efisDisplays.ts`, `ecam.ts`.
//!
//! The atlas is a 3 x 3 grid of 512 px cells:
//! | 0 | CAPT PFD  | `efis::draw_pfd` (side 0): attitude, baro-corrected altitude, speed tape, FMA, flight director, ILS |
//! | 1 | CAPT ND   | `efis::draw_nd` (side 0): ROSE LS / VOR / NAV, ARC, PLAN + option layers + navaids |
//! | 2 | E/WD      | `ewd`: N1 / EGT gauges, fuel, flaps / slats, memos, warnings |
//! | 3 | SD        | `sd`: 12 system pages (ENG, BLEED, PRESS, ELEC, HYD, FUEL, APU, COND, DOOR, WHEEL, F/CTL, STS) |
//! | 4 | F/O PFD   | `efis::draw_pfd` (side 1) |
//! | 5 | F/O ND    | `efis::draw_nd` (side 1) |
//! | 6 | CAPT MCDU | `mcdu_screen`: 24 x 14 CRT scratchpad & pages |
//! | 7 | F/O MCDU  | `mcdu_screen`: 24 x 14 CRT scratchpad & pages |

use crate::a320sys::A320Systems;
use crate::cockpit::{cell_origin, ATLAS_CELL, CELL_EWD, CELL_MCDU1, CELL_MCDU2, CELL_ND, CELL_ND2, CELL_PFD, CELL_PFD2, CELL_SD};
use crate::ecam::{EcamPage, EwdColour};
use crate::game::Flight;
use crate::geo::FT;
use crate::gfx::ui::{Col, Ui, C_AMBER, C_CYAN, C_GREEN, C_GREY, C_RED, C_WHITE};
use crate::mcdu::{self, Mcdu};
use crate::physics::{atmosphere, EngState};

const S: f32 = ATLAS_CELL as f32;

macro_rules! tf {
    ($ui:expr, $x:expr, $y:expr, $s:expr, $c:expr, $a:expr, $($arg:tt)*) => { $ui.textf($x, $y, $s, $c, $a, format_args!($($arg)*)) };
}

fn begin_cell(ui: &mut Ui, x: f32, y: f32) {
    ui.scissor(Some([x, y, S, S]));
    ui.rect(x, y, S, S, [0.004, 0.006, 0.01, 1.0]);
}

/// What a display unit shows. The PFD / ND images are per EFIS side; the XFR switches and the ND XFR switching knob
/// can re-route them.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Content {
    Pfd(usize),
    Nd(usize),
    Ewd,
    Sd,
    Mcdu(usize),
}

/// Resolve the content of an atlas cell for the current switching state.
pub fn content_of(cell: usize, sys: &A320Systems) -> Content {
    match cell {
        CELL_PFD | CELL_PFD2 => {
            let side = (cell == CELL_PFD2) as usize;
            if sys.efis[side].xfr {
                Content::Nd(side)
            } else {
                Content::Pfd(side)
            }
        }
        CELL_ND | CELL_ND2 => {
            let side = (cell == CELL_ND2) as usize;
            if (side == 0 && sys.switching[3] == 0) || (side == 1 && sys.switching[3] == 2) {
                Content::Sd
            } else if sys.efis[side].xfr {
                Content::Pfd(side)
            } else {
                Content::Nd(side)
            }
        }
        CELL_EWD => Content::Ewd,
        CELL_SD => Content::Sd,
        CELL_MCDU1 => Content::Mcdu(0),
        CELL_MCDU2 => Content::Mcdu(1),
        _ => Content::Ewd,
    }
}

/// Reading of the brightness potentiometer feeding this display cell (0..=1).
pub fn brightness_of(cell: usize, sys: &A320Systems) -> f32 {
    match cell {
        CELL_PFD | CELL_PFD2 => sys.bright.pfd[(cell == CELL_PFD2) as usize],
        CELL_ND | CELL_ND2 => sys.bright.nd[(cell == CELL_ND2) as usize],
        CELL_EWD => sys.bright.uecam,
        CELL_SD => sys.bright.lecam,
        CELL_MCDU1 | CELL_MCDU2 => if sys.dc { 1.0 } else { 0.0 },
        _ => 1.0,
    }
}

/// Dimming overlay alpha for a brightness knob position (0.8 = the normal detent = no dimming).
pub fn dim_alpha(b: f32) -> f32 {
    ((0.8 - b) / 0.8).clamp(0.0, 1.0) * 0.8
}

/// Draw all display cells into the atlas.
pub fn draw_atlas(ui: &mut Ui, f: &Flight, sys: &A320Systems, time: f64) {
    for cell in [CELL_PFD, CELL_ND, CELL_EWD, CELL_SD, CELL_PFD2, CELL_ND2, CELL_MCDU1, CELL_MCDU2] {
        let [ox, oy] = cell_origin(cell);
        begin_cell(ui, ox, oy);
        let b = brightness_of(cell, sys);
        if !sys.du_on(b) {
            continue; // knob fully anticlockwise: the unit is dark
        }
        match content_of(cell, sys) {
            Content::Pfd(side) => super::efis::draw_pfd(ui, cell, f, sys, side, time),
            Content::Nd(side) => super::efis::draw_nd(ui, cell, f, sys, side, time),
            Content::Ewd => ewd(ui, f, sys, ox, oy, time),
            Content::Sd => {
                if sys.uecam_on() {
                    sd(ui, f, sys, ox, oy);
                } else {
                    ewd(ui, f, sys, ox, oy, time);
                }
            }
            Content::Mcdu(side) => mcdu_screen(ui, &sys.mcdu[side], ox, oy, time),
        }
        let a = dim_alpha(b);
        if a > 0.01 {
            ui.scissor(Some([ox, oy, S, S]));
            ui.rect(ox, oy, S, S, [0.0, 0.0, 0.0, a]);
        }
    }
    ui.scissor(None);
}

fn pt(c: [f32; 2], r: f32, deg: f32) -> [f32; 2] {
    let a = deg.to_radians();
    [c[0] + r * a.sin(), c[1] - r * a.cos()]
}

fn arc(ui: &mut Ui, c: [f32; 2], r: f32, a0: f32, a1: f32, th: f32, col: Col) {
    let n = 32;
    for k in 0..n {
        let (t0, t1) = (a0 + (a1 - a0) * k as f32 / n as f32, a0 + (a1 - a0) * (k + 1) as f32 / n as f32);
        ui.line(pt(c, r, t0), pt(c, r, t1), th, col);
    }
}


// ---------------------------------------------------------------- MCDU

/// 24 x 14 character CRT (layout comes from `mcdu::Mcdu::items`): line 0 title, 1..=12 label / data pairs, 13 scratchpad.
fn mcdu_screen(ui: &mut Ui, m: &Mcdu, ox: f32, oy: f32, time: f64) {
    if !m.powered {
        return;
    }
    let (mx, lh) = (S * 0.03, S / mcdu::LINES as f32);
    let big = (S - 2.0 * mx) / mcdu::COLS as f32 / 0.602;
    let small = big * 0.72;
    let cell_h = 44.0 / 36.0;
    for it in m.items() {
        let size = if it.small { small } else { big };
        let y = oy + it.line as f32 * lh + (lh - size * cell_h) * 0.5 + if it.small { lh * 0.12 } else { 0.0 };
        let (x, al) = match it.align {
            mcdu::Align::Left => (ox + mx, 0),
            mcdu::Align::Right => (ox + S - mx, 2),
            mcdu::Align::Centre => (ox + S * 0.5, 1),
        };
        ui.text_a(x, y, size, it.col.rgba(), al, &it.text);
    }
    // scratchpad: blinking cursor behind the typed text (a message replaces the cursor)
    if !m.has_msg() && (time * 2.0) as i64 % 2 == 0 {
        let n = m.scratch.chars().count();
        let y = oy + 13.0 * lh + (lh - big * cell_h) * 0.5;
        ui.text(ox + mx + Ui::text_width(big, n), y, big, mcdu::Col::White.rgba(), "_");
    }
    ui.rect(ox + 10.0, oy + 13.0 * lh - 1.0, S - 20.0, 2.0, [0.13, 0.14, 0.24, 1.0]);
    if m.brt < 1.0 {
        ui.rect(ox, oy, S, S, [0.0, 0.0, 0.0, (1.0 - m.brt) * 0.85]);
    }
}


// ---------------------------------------------------------------- E/WD & SD

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

fn ewd(ui: &mut Ui, f: &Flight, sys: &A320Systems, ox: f32, oy: f32, time: f64) {
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
    // message area: ECAM alerts (red flash until MASTER WARN / EMER CANC acknowledges them, amber steady), CLR'd ones are gone, then the
    // T.O memo / memo lines while there is room
    let mut y = oy + 322.0;
    let mut line = |ui: &mut Ui, col: Col, s: &str, visible: bool| {
        if y < oy + S - 24.0 {
            if visible {
                tf!(ui, ox + 12.0, y, 22.0, col, 0, "{}", s);
            }
            y += 26.0;
        }
    };
    let flash = (time * 3.0) as i64 % 2 == 0;
    let unacknowledged = sys.warn_lit();
    for l in sys.ecam.ewd_lines() {
        let (col, red) = match l.colour {
            EwdColour::Red => (C_RED, true),
            EwdColour::Amber => (C_AMBER, false),
            EwdColour::Green => (C_GREEN, false),
            EwdColour::Cyan => (C_CYAN, false),
            EwdColour::White => (C_WHITE, false),
        };
        line(ui, col, &l.text, !red || !unacknowledged || flash);
    }
    if sys.ecam.to_config_normal() {
        line(ui, C_GREEN, "T.O CONFIG NORMAL", true);
    }
    if fm.ctl.parking {
        line(ui, C_GREEN, "PARK BRK", true);
    }
    if fm.ctl.autobrake > 0 {
        line(ui, C_GREEN, ["", "AUTO BRK LO", "AUTO BRK MED", "AUTO BRK MAX"][fm.ctl.autobrake.min(3) as usize], true);
    }
    if fm.ctl.spoilers_armed {
        line(ui, C_GREEN, "GND SPLRS ARMED", true);
    }
    if fm.ctl.gear_down && !fm.wow {
        line(ui, C_GREEN, "LDG GEAR DN", true);
    }
    if f.ap.on {
        line(ui, C_GREEN, "AP1 ENGAGED", true);
    }
    if sys.ecam.status_pending() {
        tf!(ui, ox + S - 12.0, oy + S - 28.0, 20.0, C_WHITE, 2, "STS");
    }
}

// ---------------------------------------------------------------- SD (system display, 13 pages selected by the ECAM control panel)

fn page_title(p: EcamPage) -> &'static str {
    match p {
        EcamPage::Eng => "ENGINE",
        EcamPage::Bleed => "BLEED",
        EcamPage::Press => "CAB PRESS",
        EcamPage::Elec => "ELEC",
        EcamPage::Hyd => "HYD",
        EcamPage::Fuel => "FUEL",
        EcamPage::Apu => "APU",
        EcamPage::Cond => "COND",
        EcamPage::Door => "DOOR / OXY",
        EcamPage::Wheel => "WHEEL",
        EcamPage::Fctl => "F/CTL",
        EcamPage::Sts => "STATUS",
        EcamPage::Crz => "CRUISE",
    }
}

/// Cabin altitude (ft) and differential pressure (psi) from a simple pressurisation schedule (cabin climbs at ~0.22 ft per ft, max 8000 ft).
pub fn cabin_state(f: &Flight) -> (f64, f64) {
    let alt_ft = f.fm.pos.y / FT;
    let cab_ft = if f.fm.wow { alt_ft.max(0.0) } else { (alt_ft * 0.22).clamp(0.0, 8000.0).max(alt_ft.min(1000.0)) };
    let p = |ft: f64| 1013.25 * (1.0 - 2.25577e-5 * ft * FT).max(0.0).powf(5.25588);
    let dp = if f.fm.wow { 0.0 } else { ((p(cab_ft) - p(alt_ft)) * 0.0145038).clamp(0.0, 8.6) };
    (cab_ft, dp)
}

fn tbl(ui: &mut Ui, ox: f32, oy: f32, y0: f32, rows: &[(&str, String, Col)]) {
    for (k, (label, val, col)) in rows.iter().enumerate() {
        let y = oy + y0 + k as f32 * 30.0;
        if y > oy + 440.0 {
            break;
        }
        tf!(ui, ox + 24.0, y, 22.0, C_CYAN, 0, "{}", label);
        tf!(ui, ox + S - 24.0, y, 22.0, *col, 2, "{}", val);
    }
}

fn state_col(on: bool) -> Col {
    if on {
        C_GREEN
    } else {
        C_AMBER
    }
}

fn open_close(on: bool) -> String {
    if on { "OPEN" } else { "CLOSED" }.into()
}

fn on_off(on: bool) -> String {
    if on { "ON" } else { "OFF" }.into()
}

fn vbar(ui: &mut Ui, x: f32, y: f32, h: f32, frac: f32, col: Col, label: &str, value: &str) {
    ui.rect(x - 16.0, y, 32.0, h, [0.12, 0.14, 0.18, 1.0]);
    ui.frame(x - 16.0, y, 32.0, h, 1.5, [0.5, 0.52, 0.58, 1.0]);
    let fh = h * frac.clamp(0.0, 1.0);
    ui.rect(x - 14.0, y + h - fh, 28.0, fh, col);
    tf!(ui, x, y + h + 6.0, 20.0, C_CYAN, 1, "{}", label);
    tf!(ui, x, y + h + 30.0, 22.0, col, 1, "{}", value);
}

fn sd(ui: &mut Ui, f: &Flight, sys: &A320Systems, ox: f32, oy: f32) {
    let fm = &f.fm;
    ui.scissor(Some([ox, oy, S, S]));
    let page = sys.sd_page();
    tf!(ui, ox + S / 2.0, oy + 8.0, 28.0, C_WHITE, 1, "{}", page_title(page));
    ui.rect(ox + S / 2.0 - 100.0, oy + 42.0, 200.0, 2.0, C_WHITE);
    let run = [fm.eng[0].state == EngState::Running, fm.eng[1].state == EngState::Running];
    let n = [fm.n[0] as f32, fm.n[1] as f32];
    let (cab_ft, dp) = cabin_state(f);
    match page {
        EcamPage::Eng => {
            for i in 0..2 {
                let cx = ox + 130.0 + i as f32 * 252.0;
                tf!(ui, cx, oy + 60.0, 24.0, C_WHITE, 1, "ENG {}", i + 1);
                let r = run[i];
                let rows: [(f32, String, Col); 5] = [
                    (110.0, if r { "13.8".into() } else { "0.0".into() }, state_col(r)),
                    (160.0, format!("{:.0}", if r { 45.0 + 25.0 * n[i] } else { 0.0 }), state_col(r)),
                    (210.0, format!("{:.1}", if r { 0.3 + 0.2 * n[i] } else { 0.0 }), C_GREEN),
                    (260.0, format!("{:.1}", if r { 0.4 + 0.3 * n[i] } else { 0.0 }), C_GREEN),
                    (310.0, format!("{:.0}", if r { 18.0 + 22.0 * n[i] } else { 0.0 }), state_col(r)),
                ];
                for (dy, v, c) in rows {
                    tf!(ui, cx + 60.0, oy + dy, 26.0, c, 2, "{}", v);
                }
                let st = match fm.eng[i].state {
                    EngState::Off => ("OFF", C_GREY),
                    EngState::Starting => ("START", C_AMBER),
                    EngState::Running => ("AVAIL", C_GREEN),
                };
                tf!(ui, cx, oy + 360.0, 22.0, st.1, 1, "{}", st.0);
            }
            for (dy, l) in [(110.0, "OIL QT"), (160.0, "OIL PSI"), (210.0, "VIB N1"), (260.0, "VIB N2"), (310.0, "BLEED PSI")] {
                tf!(ui, ox + S / 2.0, oy + dy + 2.0, 20.0, C_CYAN, 1, "{}", l);
            }
            tf!(ui, ox + S / 2.0, oy + 360.0, 20.0, C_CYAN, 1, "ENG MODE {}", ["CRANK", "NORM", "IGN/START"][sys.eng_mode.min(2) as usize]);
        }
        EcamPage::Bleed => {
            let psi = |i: usize| if run[i] || sys.apu_rpm >= 95.0 { 35.0 + 8.0 * n[i] } else { 0.0 };
            tbl(
                ui,
                ox,
                oy,
                62.0,
                &[
                    ("ENG 1 BLEED", open_close(sys.eng_bleed[0]), state_col(sys.eng_bleed[0])),
                    ("ENG 2 BLEED", open_close(sys.eng_bleed[1]), state_col(sys.eng_bleed[1])),
                    ("APU BLEED", open_close(sys.apu_bleed), if sys.apu_bleed { C_GREEN } else { C_GREY }),
                    ("X BLEED", ["SHUT", "AUTO", "OPEN"][(sys.xbleed as usize).min(2)].into(), C_GREEN),
                    ("PACK 1", on_off(sys.packs[0]), state_col(sys.packs[0])),
                    ("PACK 2", on_off(sys.packs[1]), state_col(sys.packs[1])),
                    ("BLEED PSI 1", format!("{:.0}", psi(0)), C_GREEN),
                    ("BLEED PSI 2", format!("{:.0}", psi(1)), C_GREEN),
                    ("WING ANTI ICE", on_off(sys.wing_ai), if sys.wing_ai { C_GREEN } else { C_GREY }),
                    ("ENG 1 ANTI ICE", on_off(sys.eng_ai[0]), if sys.eng_ai[0] { C_GREEN } else { C_GREY }),
                    ("ENG 2 ANTI ICE", on_off(sys.eng_ai[1]), if sys.eng_ai[1] { C_GREEN } else { C_GREY }),
                ],
            );
        }
        EcamPage::Press => {
            tbl(
                ui,
                ox,
                oy,
                70.0,
                &[
                    ("CAB ALT FT", format!("{cab_ft:.0}"), if cab_ft > 8800.0 { C_RED } else { C_GREEN }),
                    ("CAB V/S FT/MN", format!("{:.0}", if fm.wow { 0.0 } else { (fm.vs / FT * 60.0 * 0.22).clamp(-2000.0, 2000.0) }), C_GREEN),
                    ("DELTA P PSI", format!("{dp:.1}"), if dp > 8.5 { C_AMBER } else { C_GREEN }),
                    ("PACK 1", on_off(sys.packs[0]), state_col(sys.packs[0])),
                    ("PACK 2", on_off(sys.packs[1]), state_col(sys.packs[1])),
                    ("OUTFLOW VALVE", if fm.wow { "OPEN" } else { "AUTO" }.into(), C_GREEN),
                    ("LDG ELEV", "AUTO".into(), C_GREEN),
                    ("SAFETY VALVES", "CLOSED".into(), C_GREEN),
                ],
            );
        }
        EcamPage::Elec => {
            let gen_on = [run[0] && sys.gen[0], run[1] && sys.gen[1]];
            tbl(
                ui,
                ox,
                oy,
                62.0,
                &[
                    ("BAT 1", if sys.bat[0] { format!("{:.1} V", sys.bat_v[0]) } else { "OFF".into() }, state_col(sys.bat[0])),
                    ("BAT 2", if sys.bat[1] { format!("{:.1} V", sys.bat_v[1]) } else { "OFF".into() }, state_col(sys.bat[1])),
                    ("GEN 1", if gen_on[0] { "115 V 400 HZ".into() } else { "OFF".into() }, state_col(gen_on[0])),
                    ("GEN 2", if gen_on[1] { "115 V 400 HZ".into() } else { "OFF".into() }, state_col(gen_on[1])),
                    ("APU GEN", if sys.apu_rpm >= 95.0 && sys.apu_gen { "ON".into() } else { "OFF".into() }, if sys.apu_rpm >= 95.0 && sys.apu_gen { C_GREEN } else { C_GREY }),
                    ("EXT PWR", if sys.ext { "AVAIL".into() } else { "OFF".into() }, if sys.ext { C_GREEN } else { C_GREY }),
                    ("AC BUS", if sys.ac { "NORM".into() } else { "LOST".into() }, state_col(sys.ac)),
                    ("DC BUS", if sys.dc { "NORM".into() } else { "LOST".into() }, state_col(sys.dc)),
                    ("EMER GEN (RAT)", if sys.rat_out { "DEPLOYED".into() } else { "STOWED".into() }, if sys.rat_out { C_AMBER } else { C_GREY }),
                ],
            );
        }
        EcamPage::Hyd => {
            let names = ["GREEN", "YELLOW", "BLUE"];
            // sys.hyd = [green, yellow, blue]
            for (k, name) in names.iter().enumerate() {
                let p = sys.hyd[k] as f32;
                let col = if p > 2500.0 { C_GREEN } else if p > 1500.0 { C_AMBER } else { C_RED };
                vbar(ui, ox + 90.0 + k as f32 * 166.0, oy + 70.0, 170.0, p / 3500.0, col, name, &format!("{p:.0}"));
            }
            tbl(
                ui,
                ox,
                oy,
                318.0,
                &[
                    ("ENG 1 PUMP (G)", on_off(sys.hyd_green_pump), state_col(sys.hyd_green_pump)),
                    ("ENG 2 PUMP (Y)", on_off(sys.hyd_yellow_pump), state_col(sys.hyd_yellow_pump)),
                    ("ELEC PUMP B / Y", format!("{} / {}", on_off(sys.hyd_blue_pump), on_off(sys.hyd_yelec_pump)), C_GREEN),
                    ("PTU", if sys.ptu { "AUTO" } else { "OFF" }.into(), if sys.ptu { C_GREEN } else { C_AMBER }),
                ],
            );
        }
        EcamPage::Fuel => {
            let cap = fm.spec.fuel_cap;
            let (wing_cap, ctr_cap) = (cap * 0.305, cap * 0.39);
            let ctr = (fm.fuel - 2.0 * wing_cap).clamp(0.0, ctr_cap);
            let wing = (fm.fuel - ctr) / 2.0;
            let pump = |a: bool| if a { C_GREEN } else { C_AMBER };
            vbar(ui, ox + 90.0, oy + 70.0, 150.0, (wing / wing_cap) as f32, if wing < 500.0 { C_AMBER } else { C_GREEN }, "LEFT", &format!("{wing:.0}"));
            vbar(ui, ox + 256.0, oy + 70.0, 150.0, (ctr / ctr_cap) as f32, C_GREEN, "CTR", &format!("{ctr:.0}"));
            vbar(ui, ox + 422.0, oy + 70.0, 150.0, (wing / wing_cap) as f32, if wing < 500.0 { C_AMBER } else { C_GREEN }, "RIGHT", &format!("{wing:.0}"));
            let p = sys.pumps;
            tbl(
                ui,
                ox,
                oy,
                290.0,
                &[
                    ("L PUMPS 1 / 2", format!("{} / {}", on_off(p[0]), on_off(p[1])), pump(p[0] || p[1])),
                    ("CTR PUMPS 1 / 2", format!("{} / {}", on_off(p[2]), on_off(p[3])), pump(p[2] || p[3])),
                    ("R PUMPS 1 / 2", format!("{} / {}", on_off(p[4]), on_off(p[5])), pump(p[4] || p[5])),
                    ("X FEED", open_close(sys.xfeed), if sys.xfeed { C_GREEN } else { C_GREY }),
                    ("FOB KG", format!("{:.0}", fm.fuel), if fm.fuel < 1500.0 { C_AMBER } else { C_GREEN }),
                ],
            );
        }
        EcamPage::Apu => {
            let avail = sys.apu_rpm >= 95.0;
            tbl(
                ui,
                ox,
                oy,
                70.0,
                &[
                    ("MASTER SW", on_off(sys.apu_master), if sys.apu_master { C_GREEN } else { C_GREY }),
                    ("STATUS", if avail { "AVAIL" } else if sys.apu_start { "START" } else { "OFF" }.into(), if avail { C_GREEN } else if sys.apu_start { C_AMBER } else { C_GREY }),
                    ("RPM %", format!("{:.0}", sys.apu_rpm), if sys.apu_rpm > 107.0 { C_RED } else { C_GREEN }),
                    ("EGT C", format!("{:.0}", 20.0 + sys.apu_rpm * 6.5), C_GREEN),
                    ("GEN", on_off(avail && sys.apu_gen), if avail && sys.apu_gen { C_GREEN } else { C_GREY }),
                    ("BLEED", open_close(sys.apu_bleed && avail), if sys.apu_bleed && avail { C_GREEN } else { C_GREY }),
                ],
            );
        }
        EcamPage::Cond => {
            tbl(
                ui,
                ox,
                oy,
                70.0,
                &[
                    ("COCKPIT  C", if sys.packs[0] || sys.packs[1] { "24".into() } else { "--".into() }, state_col(sys.packs[0] || sys.packs[1])),
                    ("FWD CABIN  C", if sys.packs[0] || sys.packs[1] { "23".into() } else { "--".into() }, state_col(sys.packs[0] || sys.packs[1])),
                    ("AFT CABIN  C", if sys.packs[0] || sys.packs[1] { "23".into() } else { "--".into() }, state_col(sys.packs[0] || sys.packs[1])),
                    ("PACK 1 FLOW", if sys.packs[0] { "NORM" } else { "OFF" }.into(), state_col(sys.packs[0])),
                    ("PACK 2 FLOW", if sys.packs[1] { "NORM" } else { "OFF" }.into(), state_col(sys.packs[1])),
                    ("HOT AIR", "OPEN".into(), C_GREEN),
                ],
            );
        }
        EcamPage::Door => {
            let rows: Vec<(&str, String, Col)> = ["FWD L/R PAX", "AFT L/R PAX", "FWD CARGO", "AFT CARGO", "AVIONICS", "EMER EXIT L/R"].iter().map(|n| (*n, "CLOSED".to_string(), C_GREEN)).collect();
            tbl(ui, ox, oy, 62.0, &rows);
            tf!(ui, ox + 24.0, oy + 262.0, 22.0, C_CYAN, 0, "SLIDES");
            tf!(ui, ox + S - 24.0, oy + 262.0, 22.0, C_GREEN, 2, "{}", if fm.wow && fm.gs < 1.0 { "ARMED" } else { "DISARMED" });
            tf!(ui, ox + 24.0, oy + 292.0, 22.0, C_CYAN, 0, "OXY CREW PSI");
            tf!(ui, ox + S - 24.0, oy + 292.0, 22.0, C_GREEN, 2, "1850");
        }
        EcamPage::Wheel => {
            tf!(ui, ox + S / 2.0, oy + 60.0, 22.0, C_WHITE, 1, "L/G");
            let down = fm.gear_pos > 0.98;
            let up = fm.gear_pos < 0.02;
            let (gc, label) = if down { (C_GREEN, "DOWN") } else if up { (C_GREY, "UP") } else { (C_RED, "TRANSIT") };
            for (dx, dy) in [(0.0f32, 0.0f32), (-90.0, 36.0), (90.0, 36.0)] {
                let p = [ox + S / 2.0 + dx, oy + 110.0 + dy];
                if !up {
                    ui.tri([p[0] - 18.0, p[1] - 14.0], [p[0] + 18.0, p[1] - 14.0], [p[0], p[1] + 16.0], gc);
                } else {
                    ui.frame(p[0] - 16.0, p[1] - 12.0, 32.0, 24.0, 1.5, [0.3, 0.32, 0.36, 1.0]);
                }
            }
            tf!(ui, ox + S / 2.0, oy + 190.0, 22.0, gc, 1, "{}", label);
            let brake = if sys.hyd[1] > 1500.0 { "NORM" } else { "ACCU" };
            tbl(
                ui,
                ox,
                oy,
                240.0,
                &[
                    ("AUTO BRK", ["OFF", "LO", "MED", "MAX"][fm.ctl.autobrake.min(3) as usize].into(), if fm.ctl.autobrake > 0 { C_GREEN } else { C_GREY }),
                    ("PARK BRK", on_off(fm.ctl.parking), if fm.ctl.parking { C_AMBER } else { C_GREY }),
                    ("BRAKES", brake.into(), if brake == "NORM" { C_GREEN } else { C_AMBER }),
                    ("ANTI SKID / NWS", "ON / ON".into(), C_GREEN),
                    ("GND SPLRS", if fm.ctl.spoilers_armed { "ARMED" } else { "OFF" }.into(), if fm.ctl.spoilers_armed { C_GREEN } else { C_GREY }),
                ],
            );
        }
        EcamPage::Fctl => {
            let bar = |ui: &mut Ui, x: f32, y: f32, h: f32, v: f64, label: &str| {
                ui.rect(x - 7.0, y, 14.0, h, [0.12, 0.14, 0.18, 1.0]);
                ui.frame(x - 7.0, y, 14.0, h, 1.5, [0.5, 0.52, 0.58, 1.0]);
                let c = y + h / 2.0;
                ui.rect(x - 12.0, c - 1.0, 24.0, 2.0, C_WHITE);
                let m = c - (v as f32).clamp(-1.0, 1.0) * h * 0.46;
                ui.rect(x - 11.0, m - 3.0, 22.0, 6.0, C_GREEN);
                tf!(ui, x, y + h + 4.0, 18.0, C_CYAN, 1, "{}", label);
            };
            bar(ui, ox + 70.0, oy + 70.0, 100.0, -fm.surf.ail, "AIL L");
            bar(ui, ox + S - 70.0, oy + 70.0, 100.0, fm.surf.ail, "AIL R");
            bar(ui, ox + S / 2.0 - 40.0, oy + 70.0, 100.0, fm.surf.el, "ELEV");
            bar(ui, ox + S / 2.0 + 40.0, oy + 70.0, 100.0, fm.surf.rud, "RUD");
            tf!(ui, ox + 24.0, oy + 210.0, 22.0, C_CYAN, 0, "SPLR");
            ui.rect(ox + 100.0, oy + 214.0, 220.0, 12.0, [0.12, 0.14, 0.18, 1.0]);
            ui.rect(ox + 100.0, oy + 214.0, 220.0 * fm.sb_pos as f32, 12.0, if fm.sb_pos > 0.05 { C_GREEN } else { C_GREY });
            tf!(ui, ox + S - 24.0, oy + 210.0, 22.0, C_GREEN, 2, "{:.0}%", fm.sb_pos * 100.0);
            let fl = ["0", "1", "2", "3", "FULL"];
            tbl(
                ui,
                ox,
                oy,
                254.0,
                &[
                    ("FLAPS CONF", fl[fm.ctl.flaps_idx.min(4)].into(), C_GREEN),
                    ("PITCH TRIM", format!("{:+.1}", fm.ctl.trim * 4.0), C_GREEN),
                    ("RUD TRIM", format!("{:+.1}", fm.ctl.rud_trim * 20.0), C_GREEN),
                    ("G / B / Y HYD", format!("{:.0} / {:.0} / {:.0}", sys.hyd[0] / 10.0, sys.hyd[2] / 10.0, sys.hyd[1] / 10.0), C_GREEN),
                ],
            );
        }
        EcamPage::Sts => {
            let items = sys.ecam.status_items();
            if items.is_empty() {
                tf!(ui, ox + S / 2.0, oy + 120.0, 30.0, C_GREEN, 1, "NORMAL");
            } else {
                tf!(ui, ox + S / 2.0, oy + 70.0, 24.0, C_WHITE, 1, "CANCELLED CAUTION");
                for (k, t) in items.iter().enumerate() {
                    tf!(ui, ox + 40.0, oy + 116.0 + k as f32 * 30.0, 22.0, C_AMBER, 0, "{}", t);
                }
            }
            tf!(ui, ox + S / 2.0, oy + 400.0, 18.0, C_GREY, 1, "CLR: leave   RCL (3 s): recall");
        }
        EcamPage::Crz => {
            tbl(
                ui,
                ox,
                oy,
                70.0,
                &[
                    ("FOB KG", format!("{:.0}", fm.fuel), if fm.fuel < 1500.0 { C_AMBER } else { C_GREEN }),
                    ("CAB ALT FT", format!("{cab_ft:.0}"), C_GREEN),
                    ("DELTA P PSI", format!("{dp:.1}"), C_GREEN),
                    ("PACK 1 / 2", format!("{} / {}", on_off(sys.packs[0]), on_off(sys.packs[1])), state_col(sys.packs[0] && sys.packs[1])),
                    ("G / B / Y HYD", format!("{:.0} / {:.0} / {:.0}", sys.hyd[0] / 10.0, sys.hyd[2] / 10.0, sys.hyd[1] / 10.0), C_GREEN),
                ],
            );
            ui.rect(ox + 24.0, oy + 250.0, S - 48.0, 14.0, [0.12, 0.14, 0.18, 1.0]);
            ui.rect(ox + 24.0, oy + 250.0, (S - 48.0) * (fm.fuel / fm.spec.fuel_cap).clamp(0.0, 1.0) as f32, 14.0, if fm.fuel < 1500.0 { C_AMBER } else { C_GREEN });
        }
    }
    // footer common to every page: SAT / GW / UTC
    ui.rect(ox + 8.0, oy + 462.0, S - 16.0, 2.0, [0.5, 0.52, 0.58, 1.0]);
    let sat = atmosphere(fm.pos.y, &fm.air).t - 273.15;
    let (hh, mm) = crate::clock::hhmm(f.utc());
    tf!(ui, ox + 10.0, oy + 480.0, 20.0, C_CYAN, 0, "SAT {:+.0}C", sat);
    tf!(ui, ox + S / 2.0, oy + 480.0, 20.0, C_GREEN, 1, "GW {:.0}KG", fm.mass);
    tf!(ui, ox + S - 10.0, oy + 480.0, 20.0, C_WHITE, 2, "{:02}:{:02}Z", hh, mm);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::airports::AirportDb;
    use crate::ecam::ALL_PAGES;

    fn flight() -> Flight {
        Flight::new(&AirportDb::embedded(), "KSFO", "KOAK", 1_718_884_800.0).expect("flight")
    }

    fn atlas(f: &Flight, sys: &A320Systems) -> Vec<u8> {
        let mut ui = Ui::new();
        ui.begin(crate::cockpit::ATLAS_W as f32, crate::cockpit::ATLAS_H as f32);
        draw_atlas(&mut ui, f, sys, 1.0);
        ui.end();
        bytemuck::cast_slice::<_, u8>(&ui.verts).to_vec()
    }

    #[test]
    fn every_sd_page_renders_and_differs() {
        let f = flight();
        let mut sys = A320Systems::default();
        let mut seen: Vec<Vec<u8>> = Vec::new();
        for p in ALL_PAGES.iter().copied().chain([EcamPage::Sts]) {
            sys.ecam.manual = Some(p);
            let v = atlas(&f, &sys);
            assert!(!v.is_empty(), "{p:?} drew nothing");
            assert!(!seen.contains(&v), "{p:?} looks identical to another page");
            seen.push(v);
        }
        assert_eq!(seen.len(), 13);
    }

    #[test]
    fn brightness_knobs_dim_and_switch_displays_off_and_the_ewd_moves_down() {
        let f = flight();
        let mut sys = A320Systems::default();
        let full = atlas(&f, &sys);
        sys.bright.lecam = 0.5;
        let dimmed = atlas(&f, &sys);
        assert_ne!(full, dimmed, "SD brightness changes the picture");
        sys.bright.lecam = 0.0;
        let sd_off = atlas(&f, &sys);
        assert!(sd_off.len() < full.len(), "SD OFF draws nothing in the lower cell");
        sys.bright.lecam = 1.0;
        sys.bright.uecam = 0.0;
        let ewd_down = atlas(&f, &sys);
        assert_ne!(ewd_down, full, "E/WD moves to the lower display");
        sys.bright.lecam = 0.0;
        let both_off = atlas(&f, &sys);
        assert!(both_off.len() < ewd_down.len());
    }

    #[test]
    fn ewd_shows_alerts_and_clr_removes_them() {
        let mut f = flight();
        f.fm.fuel = 800.0;
        let mut sys = A320Systems::default();
        sys.update_ecam(0.1, &f);
        let with = atlas(&f, &sys);
        sys.ecp_down(crate::ecam::EcpKey::ClrL);
        sys.ecp_up(crate::ecam::EcpKey::ClrL);
        sys.update_ecam(0.1, &f);
        assert_ne!(with, atlas(&f, &sys), "CLR removed the FUEL LOW line");
    }
}
