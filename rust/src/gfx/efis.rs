//! A320 PFD and ND renderers driven by the per-side EFIS control panel (reference: `src/sim/a320/efisDisplays.ts`, `drawPFD` / `drawND`).
//!
//! Both drawers work on the TS 1000 x 1000 virtual canvas ([`Cv`] maps it onto one 512 px atlas cell) and take the EFIS side
//! (0 = CAPT, 1 = F/O). Everything a glareshield button / knob changes is visible here:
//!
//! | control | PFD | ND |
//! |---|---|---|
//! | FD | flight-director bars, FD1/FD2 annunciation | - |
//! | LS | localizer / glideslope scales + course pointer | - |
//! | baro knob / STD / hPa-inHg | altimeter reading, baro box, wrong-reference flash | - |
//! | ND MODE (LS VOR NAV ARC PLAN) | - | ROSE-LS / ROSE-VOR / ROSE-NAV / ARC / PLAN layouts |
//! | ND RANGE (10..320) | - | scale, ring labels, symbol placement |
//! | CSTR WPT VOR.D NDB ARPT | - | magenta optional-data layer |
//! | ADF/VOR 1 + 2 | - | bearing pointers (single / double line) + bottom-corner read-outs |
//! | TERR ON ND | - | relative terrain dots |
//! | PFD/ND XFR | the other display image is shown | (handled by `displays::draw_atlas`) |
//!
//! Deliberate deviations from the TS source: headings are TRUE (the Rust port has no WMM, like the rest of the Rust displays);
//! fly-by turn arcs are not drawn on the ND route line; rotated glyphs (compass numbers) are drawn upright.

use super::ui::{Col, Ui};
use crate::a320sys::{A320Systems, NdOpt, ND_RANGES};
use crate::autopilot::ApPhase;
use crate::cockpit::{cell_origin, ATLAS_CELL};
use crate::game::Flight;
use crate::geo::{bearing, haversine, wrap180, WpType, Waypoint, FT, KT};
use crate::navaids;
use std::cell::Cell;
use std::f32::consts::{FRAC_PI_2, PI};
use std::fmt::Arguments;

const fn c(r: u8, g: u8, b: u8) -> Col {
    [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, 1.0]
}
pub const GREEN: Col = c(0x27, 0xff, 0x3c);
pub const CYAN: Col = c(0x44, 0xd4, 0xff);
pub const AMBER: Col = c(0xff, 0xb0, 0x00);
pub const RED: Col = c(0xff, 0x30, 0x30);
pub const WHITE: Col = c(0xf6, 0xf6, 0xf6);
pub const MAG: Col = c(0xff, 0x5c, 0xf0);
pub const YELLOW: Col = c(0xff, 0xd8, 0x00);
pub const SKY: Col = c(0x00, 0xae, 0xdd);
pub const GND: Col = c(0xb7, 0x8d, 0x27);
pub const TAPE: Col = c(0x8a, 0xa0, 0xab);
const BLACK: Col = [0.0, 0.0, 0.0, 1.0];
const FMA_SEP: Col = c(0x51, 0x60, 0x6b);

pub const LEFT: u8 = 0;
pub const CENTER: u8 = 1;
pub const RIGHT: u8 = 2;

/// DejaVu Sans Mono Bold is a little larger than the TS Arial Bold for the same `px`.
const TEXT_SCALE: f32 = 0.86;
/// Vertical centre of a digit inside the glyph cell, as a fraction of the em size.
const TEXT_MID: f32 = 0.56;

// =============================================================== canvas helper

/// One display cell: the TS 1000 x 1000 virtual canvas mapped onto 512 atlas pixels.
pub struct Cv<'a> {
    pub ui: &'a mut Ui,
    ox: f32,
    oy: f32,
    k: f32,
}

impl<'a> Cv<'a> {
    pub fn new(ui: &'a mut Ui, cell: usize) -> Self {
        let [ox, oy] = cell_origin(cell);
        Self { ui, ox, oy, k: ATLAS_CELL as f32 / 1000.0 }
    }

    #[inline]
    pub fn p(&self, x: f32, y: f32) -> [f32; 2] {
        [self.ox + x * self.k, self.oy + y * self.k]
    }

    /// Scissor to a virtual-canvas rectangle (never leaves the cell).
    pub fn clip(&mut self, x: f32, y: f32, w: f32, h: f32) {
        let (x0, y0) = (x.max(0.0), y.max(0.0));
        let (x1, y1) = ((x + w).min(1000.0), (y + h).min(1000.0));
        let k = self.k;
        self.ui.scissor(Some([self.ox + x0 * k, self.oy + y0 * k, ((x1 - x0) * k).max(1.0), ((y1 - y0) * k).max(1.0)]));
    }
    pub fn unclip(&mut self) {
        self.clip(0.0, 0.0, 1000.0, 1000.0);
    }

    pub fn line(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, col: Col, w: f32) {
        let (a, b) = (self.p(x1, y1), self.p(x2, y2));
        self.ui.line(a, b, (w * self.k).max(1.0), col);
    }
    pub fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, col: Col) {
        let p = self.p(x, y);
        self.ui.rect(p[0], p[1], w * self.k, h * self.k, col);
    }
    pub fn frame(&mut self, x: f32, y: f32, w: f32, h: f32, col: Col, lw: f32) {
        let p = self.p(x, y);
        self.ui.frame(p[0], p[1], w * self.k, h * self.k, (lw * self.k).max(1.0), col);
    }
    /// Filled simple polygon (virtual coordinates, up to 64 points).
    pub fn poly(&mut self, pts: &[[f32; 2]], col: Col) {
        let mut t = [[0.0f32; 2]; 64];
        let n = pts.len().min(64);
        for i in 0..n {
            t[i] = self.p(pts[i][0], pts[i][1]);
        }
        self.ui.polygon(&t[..n], col);
    }
    /// Filled CONVEX polygon (triangle fan, no limit on the point count).
    pub fn fan(&mut self, pts: &[[f32; 2]], col: Col) {
        for i in 1..pts.len().saturating_sub(1) {
            let (a, b, c) = (self.p(pts[0][0], pts[0][1]), self.p(pts[i][0], pts[i][1]), self.p(pts[i + 1][0], pts[i + 1][1]));
            self.ui.tri(a, b, c, col);
        }
    }
    pub fn poly_stroke(&mut self, pts: &[[f32; 2]], col: Col, w: f32, closed: bool) {
        let n = pts.len();
        for i in 0..n.saturating_sub(1) {
            self.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], col, w);
        }
        if closed && n > 2 {
            self.line(pts[n - 1][0], pts[n - 1][1], pts[0][0], pts[0][1], col, w);
        }
    }
    pub fn ring(&mut self, cx: f32, cy: f32, r: f32, col: Col, w: f32) {
        let p = self.p(cx, cy);
        self.ui.ring(p, r * self.k, (w * self.k).max(1.0), 40, col);
    }
    pub fn disc(&mut self, cx: f32, cy: f32, r: f32, col: Col) {
        let p = self.p(cx, cy);
        self.ui.circle(p, r * self.k, col);
    }
    /// Arc with canvas angles (radians, 0 = +x, increasing clockwise on screen).
    pub fn arc(&mut self, cx: f32, cy: f32, r: f32, a0: f32, a1: f32, col: Col, w: f32) {
        let n = (((a1 - a0).abs() / (PI / 30.0)).ceil() as usize).clamp(4, 120);
        let mut prev = [cx + r * a0.cos(), cy + r * a0.sin()];
        for i in 1..=n {
            let a = a0 + (a1 - a0) * i as f32 / n as f32;
            let q = [cx + r * a.cos(), cy + r * a.sin()];
            self.line(prev[0], prev[1], q[0], q[1], col, w);
            prev = q;
        }
    }
    /// Dashed arc (`dash` / `gap` in virtual px along the arc).
    pub fn arc_dashed(&mut self, cx: f32, cy: f32, r: f32, a0: f32, a1: f32, col: Col, w: f32, dash: f32, gap: f32) {
        let total = r * (a1 - a0).abs();
        let dir = if a1 >= a0 { 1.0 } else { -1.0 };
        let mut s = 0.0;
        while s < total {
            let e = (s + dash).min(total);
            self.arc(cx, cy, r, a0 + dir * s / r, a0 + dir * e / r, col, w);
            s += dash + gap;
        }
    }
    pub fn line_dashed(&mut self, a: [f32; 2], b: [f32; 2], col: Col, w: f32, dash: f32, gap: f32) {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len = (dx * dx + dy * dy).sqrt();
        if len < 1e-3 {
            return;
        }
        let (ux, uy) = (dx / len, dy / len);
        let mut s = 0.0;
        while s < len {
            let e = (s + dash).min(len);
            self.line(a[0] + ux * s, a[1] + uy * s, a[0] + ux * e, a[1] + uy * e, col, w);
            s += dash + gap;
        }
    }
    pub fn text(&mut self, x: f32, y: f32, px: f32, col: Col, al: u8, s: &str) {
        let size = px * self.k * TEXT_SCALE;
        let p = self.p(x, y);
        self.ui.text_a(p[0], p[1] - size * TEXT_MID, size, col, al, s);
    }
    pub fn textf(&mut self, x: f32, y: f32, px: f32, col: Col, al: u8, args: Arguments) {
        let size = px * self.k * TEXT_SCALE;
        let p = self.p(x, y);
        self.ui.textf(p[0], p[1] - size * TEXT_MID, size, col, al, args);
    }
}

macro_rules! ct {
    ($cv:expr, $x:expr, $y:expr, $px:expr, $col:expr, $al:expr, $($arg:tt)*) => { $cv.textf($x, $y, $px, $col, $al, format_args!($($arg)*)) };
}

/// Rotate (x, y) clockwise on screen by `th` radians (canvas `rotate`).
#[inline]
fn rot(x: f32, y: f32, th: f32) -> [f32; 2] {
    let (s, c) = th.sin_cos();
    [x * c - y * s, x * s + y * c]
}

// =============================================================== convex clip region

/// Convex clip region of the virtual canvas (a circle, a rectangle, or an intersection of them with half-planes).
#[derive(Clone)]
pub struct Clip {
    p: [[f32; 2]; 96],
    n: usize,
}

impl Clip {
    fn empty() -> Self {
        Self { p: [[0.0; 2]; 96], n: 0 }
    }
    fn push(&mut self, q: [f32; 2]) {
        if self.n < 96 {
            self.p[self.n] = q;
            self.n += 1;
        }
    }
    pub fn circle(cx: f32, cy: f32, r: f32) -> Self {
        let mut o = Self::empty();
        let n = 56;
        for i in 0..n {
            let a = i as f32 / n as f32 * 2.0 * PI;
            o.push([cx + r * a.cos(), cy + r * a.sin()]);
        }
        o
    }
    pub fn rect(x: f32, y: f32, w: f32, h: f32) -> Self {
        let mut o = Self::empty();
        for q in [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] {
            o.push(q);
        }
        o
    }
    pub fn points(&self) -> &[[f32; 2]] {
        &self.p[..self.n]
    }
    /// Keep the part with `a x + b y + c >= 0`.
    pub fn half(&self, a: f32, b: f32, c0: f32) -> Clip {
        let mut o = Self::empty();
        let n = self.n;
        for i in 0..n {
            let (p, q) = (self.p[i], self.p[(i + 1) % n]);
            let (fp, fq) = (a * p[0] + b * p[1] + c0, a * q[0] + b * q[1] + c0);
            if fp >= 0.0 {
                o.push(p);
            }
            if (fp >= 0.0) != (fq >= 0.0) {
                let t = fp / (fp - fq);
                o.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
            }
        }
        o
    }
    fn sgn(&self) -> f32 {
        let n = self.n;
        let area: f32 = (0..n).map(|i| self.p[i][0] * self.p[(i + 1) % n][1] - self.p[(i + 1) % n][0] * self.p[i][1]).sum();
        if area >= 0.0 {
            1.0
        } else {
            -1.0
        }
    }
    pub fn contains(&self, x: f32, y: f32) -> bool {
        if self.n < 3 {
            return false;
        }
        let s = self.sgn();
        (0..self.n).all(|i| {
            let (a, b) = (self.p[i], self.p[(i + 1) % self.n]);
            ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) * s >= -1e-3
        })
    }
    /// Cyrus-Beck: the part of segment a-b inside the region.
    pub fn seg(&self, a: [f32; 2], b: [f32; 2]) -> Option<([f32; 2], [f32; 2])> {
        if self.n < 3 {
            return None;
        }
        let s = self.sgn();
        let (mut t0, mut t1) = (0.0f32, 1.0f32);
        for i in 0..self.n {
            let (p, q) = (self.p[i], self.p[(i + 1) % self.n]);
            let f = |x: f32, y: f32| ((q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0])) * s;
            let (fa, fb) = (f(a[0], a[1]), f(b[0], b[1]));
            if fa < 0.0 && fb < 0.0 {
                return None;
            }
            if fa < 0.0 {
                t0 = t0.max(fa / (fa - fb));
            } else if fb < 0.0 {
                t1 = t1.min(fa / (fa - fb));
            }
            if t0 > t1 {
                return None;
            }
        }
        Some(([a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1]))
    }
}

fn clipped_line(cv: &mut Cv, cl: &Clip, a: [f32; 2], b: [f32; 2], col: Col, w: f32) {
    if let Some((p, q)) = cl.seg(a, b) {
        cv.line(p[0], p[1], q[0], q[1], col, w);
    }
}

// =============================================================== shared helpers

fn pad(v: f64, w: usize) -> String {
    format!("{:0w$}", v.round() as i64, w = w)
}

fn thr_name(t: f64) -> &'static str {
    if t > 0.97 {
        "TOGA"
    } else if t > 0.82 {
        "FLX/MCT"
    } else if t > 0.6 {
        "CL"
    } else if t < 0.05 {
        "IDLE"
    } else {
        ""
    }
}

/// Index of the TO fix in `f.plan` (the same rule as `Flight::next_wp`).
pub fn route_start(f: &Flight) -> usize {
    let mut i = f.active_wp.min(f.plan.len().saturating_sub(1));
    while i + 1 < f.plan.len() && !f.fm.wow && f.plan[i].kind == WpType::Takeoff {
        i += 1;
    }
    i
}

thread_local! {
    /// speed-trend memory per side: (last kias, last time, filtered kt/s)
    static TREND: Cell<[(f64, f64, f64); 2]> = const { Cell::new([(0.0, -1.0, 0.0); 2]) };
}

// =============================================================== PFD

/// Speeds (kt IAS) shown on the tape, from the FBW envelope of the flight model.
struct Speeds {
    vls: f64,
    vaprot: f64,
    vsw: f64,
    green: f64,
    vmax: f64,
}

fn speeds(f: &Flight) -> Speeds {
    let e = crate::fbw::envelope(&f.fm);
    Speeds { vls: e.vls, vaprot: e.v_alpha_prot, vsw: e.v_sw, green: e.vls / 1.23 * 1.6, vmax: e.vmax.min(350.0) }
}

/// PFD of EFIS `side` into atlas cell `cell`. Draws a black screen when there is no DC power.
pub fn draw_pfd(ui: &mut Ui, cell: usize, f: &Flight, sys: &A320Systems, side: usize, time: f64) {
    let mut g = Cv::new(ui, cell);
    g.unclip();
    g.rect(0.0, 0.0, 1000.0, 1000.0, BLACK);
    if !sys.dc {
        return;
    }
    let fm = &f.fm;
    let ef = &sys.efis[side];
    let (cx, cy, px) = (470.0f32, 500.0f32, 12.6f32);
    let kias = fm.ias / KT;
    let true_alt = fm.pos.y / FT;
    let alt = sys.indicated_alt(side, true_alt, f.weather.qnh);
    let corr = alt - true_alt;
    let pitch = fm.pitch.to_degrees() as f32;
    let bank = fm.bank as f32;
    let hdg = fm.heading;
    let (sb, cb) = bank.sin_cos();
    // local (horizon-fixed) -> canvas
    let to_w = |lx: f32, ly: f32| [cx + lx * cb + ly * sb, cy - lx * sb + ly * cb];
    let hy = pitch * px;

    // ---- attitude sphere: circle trimmed by two vertical edges, rotated by the bank ----
    let region = Clip::circle(cx, cy, 288.0).half(1.0, 0.0, -(cx - 246.0)).half(-1.0, 0.0, cx + 246.0).half(0.0, 1.0, -150.0).half(0.0, -1.0, 850.0);
    // sky: local y - hy <= 0  <=>  -sin b * x - cos b * y + hy + sin b * cx + cos b * cy >= 0
    let k0 = hy + sb * cx + cb * cy;
    let sky = region.half(-sb, -cb, k0);
    let gnd = region.half(sb, cb, -k0);
    g.fan(sky.points(), SKY);
    g.fan(gnd.points(), GND);
    clipped_line(&mut g, &region, to_w(-500.0, hy), to_w(500.0, hy), WHITE, 4.0);
    let mut p = -30.0f32;
    while p <= 30.0 {
        if p.abs() > 0.01 {
            let y = hy - p * px;
            let ten = (p % 10.0).abs() < 0.01;
            let five = (p % 5.0).abs() < 0.01;
            let w = if ten {
                66.0
            } else if five {
                36.0
            } else {
                18.0
            };
            clipped_line(&mut g, &region, to_w(-w, y), to_w(w, y), WHITE, 3.0);
            if ten {
                for sx in [-1.0f32, 1.0] {
                    let q = to_w(sx * (w + 34.0), y);
                    if region.contains(q[0], q[1]) {
                        ct!(g, q[0], q[1], 30.0, WHITE, CENTER, "{}", p.abs() as i32);
                    }
                }
            }
        }
        p += 2.5;
    }
    // attitude-limit brackets (fixed, white)
    for sx in [-1.0f32, 1.0] {
        for sy in [-1.0f32, 1.0] {
            let (x, y) = (cx + sx * 200.0, cy + sy * 135.0);
            g.poly_stroke(&[[x - sx * 62.0, y], [x, y], [x, y - sy * 36.0]], WHITE, 3.0, false);
        }
    }
    // roll scale (fixed) + fixed index + sky pointer / slip (rotate with the horizon)
    for a in [-60.0f32, -45.0, -30.0, -20.0, -10.0, 10.0, 20.0, 30.0, 45.0, 60.0] {
        let l = if a % 30.0 == 0.0 { 34.0 } else { 20.0 };
        let (s, co) = a.to_radians().sin_cos();
        g.line(cx + s * 290.0, cy - co * 290.0, cx + s * (290.0 + l), cy - co * (290.0 + l), WHITE, 4.0);
    }
    let tri = [[cx, cy - 292.0], [cx - 17.0, cy - 322.0], [cx + 17.0, cy - 322.0]];
    g.poly(&tri, BLACK);
    g.poly_stroke(&tri, YELLOW, 4.0, true);
    let rp = |x: f32, y: f32| {
        let r = rot(x, y, -bank);
        [cx + r[0], cy + r[1]]
    };
    let sp = [rp(0.0, -284.0), rp(-24.0, -240.0), rp(24.0, -240.0)];
    g.poly_stroke(&sp, YELLOW, 4.0, true);
    let sl = (fm.beta as f32 * 0.95 * 6.0).clamp(-1.0, 1.0);
    let slip_box = [rp(-26.0 + sl * 30.0, -232.0), rp(26.0 + sl * 30.0, -232.0), rp(26.0 + sl * 30.0, -218.0), rp(-26.0 + sl * 30.0, -218.0)];
    g.poly_stroke(&slip_box, YELLOW, 4.0, true);

    // ---- flight director (per-side FD button) ----
    if ef.fd {
        let dh = wrap180(f.ap.hdg - hdg);
        let roll_cmd = (dh * 1.2).clamp(-25.0, 25.0) as f32;
        let pitch_cmd = ((f.ap.alt_ft - true_alt) / 150.0).clamp(-10.0, 15.0) as f32;
        let by = ((pitch - pitch_cmd) * px).clamp(-150.0, 150.0);
        g.line(cx - 110.0, cy + by, cx + 110.0, cy + by, GREEN, 8.0);
        let bx = ((roll_cmd + bank.to_degrees()) * 4.0).clamp(-150.0, 150.0);
        g.line(cx + bx, cy - 110.0, cx + bx, cy + 110.0, GREEN, 8.0);
    }
    // aircraft symbol (fixed, yellow with black core)
    for s in [-1.0f32, 1.0] {
        let pts = [[cx + s * 245.0, cy - 14.0], [cx + s * 100.0, cy - 14.0], [cx + s * 100.0, cy + 38.0], [cx + s * 128.0, cy + 38.0], [cx + s * 128.0, cy + 14.0], [cx + s * 245.0, cy + 14.0]];
        g.poly(&pts, BLACK);
        g.poly_stroke(&pts, YELLOW, 6.0, true);
    }
    g.frame(cx - 7.0, cy - 7.0, 14.0, 14.0, YELLOW, 6.0);

    // ---- FMA (5 columns) ----
    for x in [281.0f32, 449.0, 616.0, 778.0] {
        g.line(x, 44.0, x, 150.0, FMA_SEP, 4.0);
    }
    let detent = thr_name(fm.ctl.throttle);
    let airborne = !fm.wow;
    let engaged = f.ap.on || ef.fd;
    let to_roll = (f.ap.phase == ApPhase::Takeoff || (fm.wow && fm.ctl.throttle > 0.8)) && engaged;
    let alt_err = f.ap.alt_ft - true_alt;
    let ils_ok = f.ils.valid && f.ils.dist < 46000.0;
    let ls_cap = f.ap.appr && ils_ok;
    let v_mode = if !engaged {
        ""
    } else if to_roll {
        "SRS"
    } else if ls_cap {
        "G/S"
    } else if alt_err.abs() < 120.0 {
        "ALT"
    } else if sys.vs_mode {
        "V/S"
    } else if alt_err > 0.0 {
        "OP CLB"
    } else {
        "OP DES"
    };
    let l_mode = if !engaged {
        ""
    } else if to_roll {
        "RWY"
    } else if ls_cap {
        "LOC"
    } else if f.ap.nav {
        "NAV"
    } else {
        "HDG"
    };
    let v_arm = if !engaged {
        ""
    } else if to_roll {
        "CLB"
    } else if f.ap.appr && !ls_cap {
        "G/S"
    } else {
        ""
    };
    let l_arm = if !engaged {
        ""
    } else if to_roll && !f.plan.is_empty() {
        "NAV"
    } else if f.ap.appr && !ls_cap {
        "LOC"
    } else {
        ""
    };
    let manual = if airborne { !f.ap.on } else { detent == "TOGA" || detent == "FLX/MCT" };
    let thr_txt = if fm.wow && detent == "TOGA" {
        "MAN TOGA"
    } else if fm.wow && detent == "FLX/MCT" {
        "MAN FLX"
    } else if manual {
        if detent == "CL" {
            "THR CLB"
        } else if fm.ctl.throttle > 0.85 && airborne {
            "MAN THR"
        } else {
            ""
        }
    } else if sys.spd_mach {
        "MACH"
    } else {
        "SPEED"
    };
    if !thr_txt.is_empty() {
        if thr_txt.starts_with("MAN") {
            g.frame(70.0, 52.0, 200.0, 66.0, WHITE, 3.0);
            g.text(170.0, 86.0, 30.0, WHITE, CENTER, thr_txt);
        } else {
            g.text(170.0, 70.0, 32.0, GREEN, CENTER, thr_txt);
        }
    }
    if !v_mode.is_empty() {
        if to_roll {
            g.frame(300.0, 52.0, 134.0, 40.0, WHITE, 3.0);
        }
        g.text(365.0, 72.0, 34.0, GREEN, CENTER, v_mode);
    }
    if !v_arm.is_empty() {
        g.text(365.0, 116.0, 34.0, CYAN, CENTER, v_arm);
    }
    if !l_mode.is_empty() {
        if to_roll {
            g.frame(466.0, 52.0, 134.0, 40.0, WHITE, 3.0);
        }
        g.text(533.0, 72.0, 34.0, GREEN, CENTER, l_mode);
    }
    if !l_arm.is_empty() {
        g.text(533.0, 116.0, 34.0, CYAN, CENTER, l_arm);
    }
    if ls_cap {
        g.text(697.0, 72.0, 32.0, WHITE, CENTER, "CAT1");
    }
    let (fd1, fd2) = (sys.efis[0].fd, sys.efis[1].fd);
    if f.ap.on {
        g.text(890.0, 62.0, 32.0, WHITE, CENTER, "AP1");
    }
    if fd1 || fd2 {
        ct!(g, 890.0, 100.0, 32.0, WHITE, CENTER, "{}FD{}", if fd1 { '1' } else { '-' }, if fd2 { '2' } else { '-' });
    }
    if f.ap.on || sys.athr_armed {
        g.frame(808.0, 118.0, 164.0, 38.0, WHITE, 3.0);
        g.text(890.0, 138.0, 30.0, if f.ap.on { WHITE } else { CYAN }, CENTER, "A/THR");
    }

    // ---- speed tape ----
    let sp = speeds(f);
    let k = kias.max(30.0);
    let ppk = 5.3f32;
    let y_of = |v: f64| 500.0 - (v - k) as f32 * ppk;
    g.clip(50.0, 255.0, 110.0, 490.0);
    g.rect(50.0, 255.0, 110.0, 490.0, TAPE);
    let mut v = ((k - 50.0) / 10.0).floor().max(3.0) * 10.0;
    while v <= k + 50.0 {
        let y = y_of(v);
        g.line(118.0, y, 160.0, y, WHITE, 3.0);
        if v % 20.0 == 0.0 {
            g.text(78.0, y, 36.0, WHITE, CENTER, &pad(v, 3));
        }
        v += 10.0;
    }
    let mut y = y_of(sp.vmax + 60.0);
    while y < y_of(sp.vmax) {
        g.rect(146.0, y, 14.0, 10.0f32.min(y_of(sp.vmax) - y), c(0xdd, 0, 0));
        y += 20.0;
    }
    g.rect(150.0, y_of(sp.vls), 8.0, y_of(sp.vaprot) - y_of(sp.vls), AMBER);
    let mut y = y_of(sp.vaprot);
    while y < y_of(sp.vsw) {
        g.rect(150.0, y, 8.0, 8.0, AMBER);
        y += 16.0;
    }
    g.rect(150.0, y_of(sp.vsw), 10.0, y_of(sp.vsw - 70.0) - y_of(sp.vsw), RED);
    if fm.flaps_pos < 0.05 {
        g.ring(136.0, y_of(sp.green), 9.0, GREEN, 4.0);
    }
    let bug_col = if sys.spd_managed { MAG } else { CYAN };
    let by = y_of(f.ap.spd).clamp(262.0, 738.0);
    g.poly_stroke(&[[160.0, by], [138.0, by - 14.0], [138.0, by + 14.0]], bug_col, 5.0, true);
    // trend vector (kt/s, low-pass filtered, 10 s look-ahead)
    let mut tr = TREND.with(|t| t.get());
    {
        let e = &mut tr[side];
        if e.1 < 0.0 || time < e.1 || time - e.1 > 1.0 {
            *e = (kias, time, 0.0);
        } else if time - e.1 > 0.05 {
            e.2 += ((kias - e.0) / (time - e.1) - e.2) * 0.15;
            e.0 = kias;
            e.1 = time;
        }
    }
    TREND.with(|t| t.set(tr));
    let tv = (tr[side].2 * 10.0).clamp(-40.0, 40.0) as f32;
    if tv.abs() > 2.0 {
        let ty = 500.0 - tv * ppk;
        let sg = tv.signum();
        g.line(150.0, 500.0, 150.0, ty, YELLOW, 5.0);
        g.poly(&[[150.0, ty - sg * 2.0], [140.0, ty + sg * 14.0], [160.0, ty + sg * 14.0]], YELLOW);
    }
    g.unclip();
    g.poly(&[[150.0, 500.0], [184.0, 484.0], [184.0, 516.0]], YELLOW);
    g.line(160.0, 500.0, 50.0, 500.0, YELLOW, 5.0);
    g.line(50.0, 250.0, 160.0, 250.0, WHITE, 3.0);
    if sys.spd_mach {
        ct!(g, 105.0, 224.0, 40.0, bug_col, CENTER, ".{:02.0}", f.ap.spd / 661.5 * 100.0);
    } else {
        g.text(105.0, 224.0, 40.0, bug_col, CENTER, &pad(f.ap.spd, 3));
    }
    if fm.mach > 0.5 {
        ct!(g, 105.0, 775.0, 36.0, GREEN, CENTER, ".{:02.0}", fm.mach * 100.0);
    }

    // ---- V/S scale ----
    let vs_y = |fpm: f64| -> f32 {
        let a = (fpm.abs() / 1000.0) as f32;
        let s = if fpm >= 0.0 { 1.0 } else { -1.0 };
        500.0 - s * if a <= 1.0 {
            a * 215.0
        } else if a <= 2.0 {
            215.0 + (a - 1.0) * 38.0
        } else {
            253.0 + (a - 2.0).min(4.0) * 9.5
        }
    };
    g.poly(&[[900.0, 205.0], [950.0, 235.0], [950.0, 765.0], [900.0, 795.0]], TAPE);
    for v in [-6000.0, -2000.0, -1000.0, 1000.0, 2000.0, 6000.0] {
        let y = vs_y(v);
        g.line(925.0, y, 944.0, y, WHITE, 3.0);
        ct!(g, 912.0, y, 24.0, WHITE, CENTER, "{}", (v.abs() / 1000.0) as i32);
    }
    for v in [-1500.0, -500.0, 500.0, 1500.0] {
        let y = vs_y(v);
        g.line(936.0, y, 944.0, y, WHITE, 2.0);
    }
    g.line(928.0, 500.0, 950.0, 500.0, WHITE, 3.0);
    let vs_fpm = fm.vs / (FT / 60.0);
    let vsv = vs_fpm.clamp(-6000.0, 6000.0);
    let vy = vs_y(vsv);
    g.line(965.0, 500.0, 905.0, vy, GREEN, 5.0);
    if vs_fpm.abs() > 200.0 {
        ct!(g, 880.0, vy + if vsv > 0.0 { -26.0 } else { 26.0 }, 28.0, GREEN, CENTER, "{:02.0}", vs_fpm.abs() / 100.0);
    }

    // ---- altitude tape (baro-corrected) ----
    let ppf = 0.5f32;
    let y_a = |v: f64| 500.0 - (v - alt) as f32 * ppf;
    g.clip(740.0, 255.0, 96.0, 490.0);
    g.rect(740.0, 255.0, 96.0, 490.0, TAPE);
    let mut v = ((alt - 520.0) / 100.0).floor() * 100.0;
    while v <= alt + 520.0 {
        let y = y_a(v);
        g.line(740.0, y, if v % 500.0 == 0.0 { 790.0 } else { 770.0 }, y, WHITE, 3.0);
        if v % 200.0 == 0.0 {
            ct!(g, 788.0, y, 30.0, WHITE, LEFT, "{}{:03}", if v < 0.0 { "-" } else { "" }, (v.abs() / 100.0).round() as i64);
        }
        v += 100.0;
    }
    let bug_a = y_a(f.ap.alt_ft + corr).clamp(262.0, 738.0);
    g.poly_stroke(&[[740.0, bug_a], [770.0, bug_a - 18.0], [770.0, bug_a + 18.0]], CYAN, 5.0, true);
    g.unclip();
    g.rect(826.0, 452.0, 100.0, 96.0, BLACK);
    g.frame(826.0, 452.0, 100.0, 96.0, YELLOW, 4.0);
    let ab = alt.abs();
    ct!(g, 856.0, 500.0, 44.0, GREEN, CENTER, "{}{:02}", if alt < 0.0 { "-" } else { "" }, (ab / 100.0).floor() as i64);
    g.clip(886.0, 456.0, 38.0, 88.0);
    let a20 = (ab / 20.0).floor() * 20.0;
    for i in -2..=3 {
        let v = a20 + i as f64 * 20.0;
        let y = 500.0 - ((v - ab) / 20.0) as f32 * 36.0;
        ct!(g, 905.0, y, 30.0, GREEN, CENTER, "{:02}", ((v as i64 % 100) + 100) % 100);
    }
    g.unclip();
    g.line(740.0, 250.0, 836.0, 250.0, WHITE, 3.0);
    g.text(790.0, 224.0, 40.0, CYAN, CENTER, &pad(f.ap.alt_ft, 5));
    // baro reference: flashing amber box = wrong reference for the altitude (STD below the transition altitude, QNH above the transition level)
    let flash = (ef.std && alt < 4900.0 && !fm.wow) || (!ef.std && alt > 6100.0);
    if !flash || (time * 2.0).floor() as i64 % 2 == 0 {
        if flash {
            g.frame(770.0, 805.0, 190.0, 50.0, AMBER, 4.0);
        }
        if ef.std {
            g.text(855.0, 830.0, 42.0, CYAN, CENTER, "STD");
        } else {
            g.text(780.0, 830.0, 26.0, WHITE, LEFT, "QNH");
            g.text(852.0, 830.0, 36.0, CYAN, LEFT, &sys.baro_text(side));
        }
    }
    let agl_ft = fm.agl / FT;
    if agl_ft < 2500.0 {
        let ra = (agl_ft - 18.0).round().max(0.0);
        ct!(g, cx, 700.0, 42.0, if ra < 400.0 { AMBER } else { GREEN }, CENTER, "{:.0}", ra);
    }

    // ---- heading strip ----
    g.clip(232.0, 862.0, 476.0, 66.0);
    g.rect(232.0, 862.0, 476.0, 66.0, TAPE);
    let pph = 9.1f32;
    let x_h = |v: f64| cx + wrap180(v - hdg) as f32 * pph;
    let mut v = 0.0;
    while v < 360.0 {
        let x = x_h(v);
        let ten = v % 10.0 == 0.0;
        if (225.0..=715.0).contains(&x) {
            g.line(x, 862.0, x, if ten { 888.0 } else { 876.0 }, WHITE, 3.0);
            if ten {
                let lab = ((v / 10.0) as i64) % 36;
                ct!(g, x, 906.0, if wrap180(v - hdg).abs() < 5.0 { 44.0 } else { 32.0 }, WHITE, CENTER, "{:02}", if lab == 0 { 36 } else { lab });
            }
        }
        v += 5.0;
    }
    if !sys.hdg_managed {
        let hb = x_h(f.ap.hdg).clamp(236.0, 704.0);
        g.poly(&[[hb, 864.0], [hb - 15.0, 886.0], [hb + 15.0, 886.0]], CYAN);
    }
    if ef.ls && ils_ok {
        let cxp = x_h(f.ils.course).clamp(236.0, 704.0);
        g.line(cxp, 862.0, cxp, 928.0, MAG, 5.0);
    }
    g.unclip();
    g.line(cx, 826.0, cx, 862.0, YELLOW, 6.0);
    let tx = x_h(fm.track).clamp(236.0, 704.0);
    g.poly_stroke(&[[tx, 836.0], [tx + 13.0, 850.0], [tx, 864.0], [tx - 13.0, 850.0]], GREEN, 4.0, true);

    // ---- LS (landing system): only while the LS pushbutton is lit ----
    if ef.ls {
        if ils_ok {
            let lx = cx + (f.ils.loc_dots as f32).clamp(-2.4, 2.4) * 60.0;
            let gy = cy - (f.ils.gs_dots as f32).clamp(-2.4, 2.4) * 60.0;
            for i in [-2.0f32, -1.0, 1.0, 2.0] {
                g.ring(cx + i * 60.0, 755.0, 7.0, WHITE, 3.0);
                g.ring(cx + 275.0, cy + i * 60.0, 7.0, WHITE, 3.0);
            }
            g.line(cx, 740.0, cx, 770.0, YELLOW, 4.0);
            g.line(cx + 262.0, cy, cx + 288.0, cy, YELLOW, 4.0);
            for (x, y) in [(lx, 755.0f32), (cx + 275.0, gy)] {
                g.poly(&[[x, y - 15.0], [x + 15.0, y], [x, y + 15.0], [x - 15.0, y]], MAG);
            }
            g.text(60.0, 800.0, 28.0, MAG, LEFT, &f.arr_end.ident);
            ct!(g, 60.0, 836.0, 28.0, WHITE, LEFT, "{:.1}", f.ils.dist / 1852.0);
            g.text(150.0, 836.0, 22.0, CYAN, LEFT, "NM");
        } else {
            g.text(cx, 755.0, 30.0, AMBER, CENTER, "LOC");
            g.text(cx + 278.0, cy, 30.0, AMBER, CENTER, "G/S");
        }
    }
    // protections / law status (Rust sim extra: the FBW envelope is part of the aircraft model)
    let env = crate::fbw::envelope(fm);
    let (txt, col) = if env.alpha_floor {
        ("A.FLOOR", RED)
    } else if fm.stall_warn {
        ("STALL", RED)
    } else if env.alpha_prot {
        ("ALPHA PROT", AMBER)
    } else if env.high_speed_prot {
        ("HS PROT", AMBER)
    } else if !fm.ctl.assist {
        ("DIRECT LAW", AMBER)
    } else {
        ("", GREEN)
    };
    if !txt.is_empty() {
        g.text(cx, if fm.stall_warn { 600.0 } else { 975.0 }, if fm.stall_warn { 46.0 } else { 30.0 }, col, CENTER, txt);
    }
    if sys.lamp_test > 0.0 {
        g.text(cx, 420.0, 40.0, AMBER, CENTER, "TEST");
    }
}

// =============================================================== ND

fn star(g: &mut Cv, x: f32, y: f32, r: f32, col: Col) {
    let pts = [[x, y - r], [x + r * 0.28, y - r * 0.28], [x + r, y], [x + r * 0.28, y + r * 0.28], [x, y + r], [x - r * 0.28, y + r * 0.28], [x - r, y], [x - r * 0.28, y - r * 0.28]];
    g.poly(&pts, col);
}

/// Display geometry of one ND (exposed for tests): mode flags, range and the lat/lon -> canvas projection.
#[derive(Clone, Copy, Debug)]
pub struct NdGeom {
    pub mode: usize,
    pub rng: f32,
    pub arc: bool,
    pub plan: bool,
    pub ls_mode: bool,
    pub show_map: bool,
    pub cx: f32,
    pub cy: f32,
    pub r: f32,
    pub nm_px: f32,
    pub ref_lat: f64,
    pub ref_lon: f64,
    pub hdg: f64,
}

impl NdGeom {
    pub fn new(sys: &A320Systems, side: usize, f: &Flight) -> Self {
        let ef = &sys.efis[side];
        let mode = ef.nd_mode.min(4);
        let rng = ND_RANGES[ef.nd_range.min(5)] as f32;
        let (arc, plan, ls_mode) = (mode == 3, mode == 4, mode == 0);
        let show_map = mode == 2 || arc || plan;
        let (cx, cy, r) = (500.0, if arc { 850.0 } else { 540.0 }, if arc { 640.0 } else { 400.0 });
        let nm_px = if arc { r / rng } else { r / (rng / 2.0) };
        let (mut ref_lat, mut ref_lon) = (f.lat, f.lon);
        if plan {
            if let Some(w) = f.plan.get(route_start(f)) {
                ref_lat = w.lat;
                ref_lon = w.lon;
            }
        }
        Self { mode, rng, arc, plan, ls_mode, show_map, cx, cy, r, nm_px, ref_lat, ref_lon, hdg: f.fm.heading }
    }

    /// (x, y) on the canvas, distance NM and true bearing of a position.
    pub fn proj(&self, lat: f64, lon: f64) -> ([f32; 2], f32, f32) {
        let dx = ((lon - self.ref_lon) * self.ref_lat.to_radians().cos() * 60.0) as f32;
        let dy = ((lat - self.ref_lat) * 60.0) as f32;
        let r = (dx * dx + dy * dy).sqrt();
        let br = dx.atan2(dy).to_degrees();
        if self.plan {
            ([self.cx + dx * self.nm_px, self.cy - dy * self.nm_px], r, br)
        } else {
            let a = (br - self.hdg as f32).to_radians();
            ([self.cx + a.sin() * r * self.nm_px, self.cy - a.cos() * r * self.nm_px], r, br)
        }
    }

    pub fn visible(&self, p: [f32; 2]) -> bool {
        let (dx, dy) = (p[0] - self.cx, p[1] - self.cy);
        (dx * dx + dy * dy).sqrt() <= self.r * 1.02 && (!self.arc || p[1] < self.cy + 20.0)
    }

    pub fn clip(&self) -> Clip {
        if self.arc {
            Clip::rect(0.0, 150.0, 1000.0, 700.0)
        } else {
            Clip::circle(self.cx, self.cy, self.r + 4.0)
        }
    }
}

fn rel_mag(v: f64, hdg: f64) -> f32 {
    wrap180(v - hdg) as f32
}

/// ND of EFIS `side` into atlas cell `cell`.
pub fn draw_nd(ui: &mut Ui, cell: usize, f: &Flight, sys: &A320Systems, side: usize, _time: f64) {
    let mut g = Cv::new(ui, cell);
    g.unclip();
    g.rect(0.0, 0.0, 1000.0, 1000.0, BLACK);
    if !sys.dc {
        return;
    }
    let fm = &f.fm;
    let ef = &sys.efis[side];
    let ng = NdGeom::new(sys, side, f);
    let (cx, cy, r, rng) = (ng.cx, ng.cy, ng.r, ng.rng);
    let (arc, plan, ls_mode, show_map) = (ng.arc, ng.plan, ng.ls_mode, ng.show_map);
    let hdg = fm.heading;
    let (pos_lat, pos_lon) = (f.lat, f.lon);
    let i0 = route_start(f);
    let rt: &[Waypoint] = if f.plan.is_empty() { &[] } else { &f.plan[i0..] };
    let own = ng.proj(pos_lat, pos_lon).0;
    let cl = ng.clip();
    let outer_a = (sys.bright.nd_outer[side] * 1.6).clamp(0.25, 1.0);
    let with_a = |col: Col, a: f32| [col[0], col[1], col[2], col[3] * a];

    g.clip(0.0, 0.0, 1000.0, 1000.0);
    // ---- optional data layer (magenta): one at a time ----
    if let (Some(opt), true) = (ef.opt, show_map) {
        let reach = rng as f64 * if arc { 1.05 } else { 0.55 };
        match opt {
            NdOpt::Arpt => {
                let mut shown = 0;
                let draw_ap = |g: &mut Cv, icao: &str, lat: f64, lon: f64| {
                    let (p, ..) = ng.proj(lat, lon);
                    if !ng.visible(p) || !cl.contains(p[0], p[1]) {
                        return;
                    }
                    g.ring(p[0], p[1], 9.0, MAG, 3.0);
                    g.line(p[0] - 14.0, p[1], p[0] + 14.0, p[1], MAG, 3.0);
                    g.line(p[0], p[1] - 14.0, p[0], p[1] + 14.0, MAG, 3.0);
                    g.text(p[0] + 18.0, p[1] - 16.0, 24.0, MAG, LEFT, icao);
                };
                for a in [&f.dep, &f.arr] {
                    if navaids::flat_nm(ng.ref_lat, ng.ref_lon, a.lat, a.lon) <= reach {
                        draw_ap(&mut g, &a.icao, a.lat, a.lon);
                    }
                }
                for a in navaids::airport_points() {
                    if shown >= 80 {
                        break;
                    }
                    if a.icao == f.dep.icao || a.icao == f.arr.icao {
                        continue;
                    }
                    if navaids::flat_nm(ng.ref_lat, ng.ref_lon, a.lat, a.lon) <= reach {
                        draw_ap(&mut g, &a.icao, a.lat, a.lon);
                        shown += 1;
                    }
                }
            }
            NdOpt::Cstr => {
                for w in rt {
                    let (p, ..) = ng.proj(w.lat, w.lon);
                    if ng.visible(p) {
                        g.ring(p[0], p[1], 18.0, MAG, 3.0);
                    }
                }
            }
            _ => {
                for n in navaids::all() {
                    if (opt == NdOpt::Ndb && !n.ndb) || (opt == NdOpt::Vord && n.ndb) {
                        continue;
                    }
                    if navaids::flat_nm(ng.ref_lat, ng.ref_lon, n.lat, n.lon) > reach {
                        continue;
                    }
                    let (p, ..) = ng.proj(n.lat, n.lon);
                    if !ng.visible(p) || !cl.contains(p[0], p[1]) {
                        continue;
                    }
                    if opt == NdOpt::Wpt {
                        star(&mut g, p[0], p[1], 11.0, MAG);
                    } else if n.ndb {
                        for a in 0..6 {
                            g.disc(p[0] + (a as f32).cos() * 9.0, p[1] + (a as f32).sin() * 9.0, 2.2, MAG);
                        }
                        g.disc(p[0], p[1], 4.0, MAG);
                    } else {
                        let mut hex = [[0.0f32; 2]; 6];
                        for (a, h) in hex.iter_mut().enumerate() {
                            let t = a as f32 * PI / 3.0;
                            *h = [p[0] + t.cos() * 12.0, p[1] + t.sin() * 12.0];
                        }
                        g.poly_stroke(&hex, MAG, 3.0, true);
                        g.rect(p[0] - 2.0, p[1] - 2.0, 4.0, 4.0, MAG);
                    }
                    g.text(p[0] + 18.0, p[1] - 16.0, 24.0, MAG, LEFT, &n.ident);
                }
            }
        }
    }
    // ---- TERR ON ND: coarse relative-terrain dots (brightness follows the outer ND knob) ----
    if sys.terr_on_nd[side] && show_map {
        let step = if arc { 34.0f32 } else { 38.0 };
        let alt_ft = fm.pos.y / FT;
        let mut yy = -r;
        while yy <= r {
            let mut xx = -r;
            while xx <= r {
                let (px, py) = (cx + xx, cy + yy);
                if (xx * xx + yy * yy).sqrt() <= r && !(arc && py > cy) {
                    let r_nm = (xx * xx + yy * yy).sqrt() as f64 / ng.nm_px as f64;
                    let ang = (xx as f64).atan2(-yy as f64) + if plan { 0.0 } else { hdg.to_radians() };
                    let lat = ng.ref_lat + ang.cos() * r_nm / 60.0;
                    let lon = ng.ref_lon + ang.sin() * r_nm / 60.0 / ng.ref_lat.to_radians().cos();
                    let t = f.terrain.height(f.proj.x(lon), f.proj.z(lat)) / FT;
                    let dz = alt_ft - t;
                    if dz <= 2000.0 && t >= 50.0 {
                        let col = if dz < 250.0 {
                            RED
                        } else if dz < 1000.0 {
                            AMBER
                        } else {
                            GREEN
                        };
                        let a = outer_a * if dz < 1000.0 { 0.9 } else { 0.55 };
                        for q in 0..5 {
                            g.rect(px - 15.0 + ((q * 7) % 5) as f32 * 6.0, py - 15.0 + ((q * 11) % 5) as f32 * 6.0, 4.0, 4.0, with_a(col, a));
                        }
                    }
                }
                xx += step;
            }
            yy += step;
        }
    }
    // ---- flight plan: LEG from the previous fix to the TO fix, then the rest ----
    if show_map && !rt.is_empty() {
        let from = if i0 > 0 { f.plan.get(i0 - 1) } else { None };
        let lf = from.is_some();
        let mut prev: Option<[f32; 2]> = None;
        let fixes = from.into_iter().chain(rt.iter());
        let mut pts_buf: [([f32; 2], bool); 48] = [([0.0; 2], false); 48];
        let mut n = 0;
        for (i, w) in fixes.enumerate().take(48) {
            let (p, ..) = ng.proj(w.lat, w.lon);
            pts_buf[n] = (p, lf && i == 0);
            n += 1;
            if let Some(q) = prev {
                clipped_line(&mut g, &cl, q, p, GREEN, 5.0);
            }
            prev = Some(p);
        }
        let to_idx = if lf { 1 } else { 0 };
        let names = from.into_iter().chain(rt.iter());
        for (i, w) in names.enumerate().take(n) {
            let (p, from_fix) = pts_buf[i];
            if from_fix || (!ng.visible(p) && !plan) || !cl.contains(p[0], p[1]) {
                continue;
            }
            let col = if i == to_idx { WHITE } else { GREEN };
            star(&mut g, p[0], p[1], 13.0, col);
            g.text(p[0] + 18.0, p[1] - 18.0, 28.0, col, LEFT, &w.name);
        }
    }
    // ---- runways of the departure / arrival airports (always useful on the map) ----
    if show_map {
        for e in [&f.dep_end, &f.arr_end] {
            let (a, ..) = ng.proj(e.start_lat, e.start_lon);
            let (b, ..) = ng.proj(e.end_lat, e.end_lon);
            clipped_line(&mut g, &cl, a, b, WHITE, 5.0);
        }
    }
    // ---- bearing pointers (ADF / VOR switches; 1 = single line, 2 = double line) ----
    let mut nav_info: [Option<(bool, &'static navaids::Navaid, f32)>; 2] = [None, None];
    if !plan {
        for i in 0..2 {
            let sel = ef.nav[i];
            if sel == 0 {
                continue;
            }
            let Some((nv, d_nm)) = navaids::nearest(pos_lat, pos_lon, sel < 0) else { continue };
            let brg = bearing(pos_lat, pos_lon, nv.lat, nv.lon);
            nav_info[i] = Some((sel > 0, nv, d_nm as f32));
            let th = rel_mag(brg, hdg).to_radians();
            let col = if sel > 0 { WHITE } else { GREEN };
            let offs: &[f32] = if i == 0 { &[0.0] } else { &[-5.0, 5.0] };
            for &o in offs {
                for (y0, y1) in [(-r * 0.22, -r + 34.0), (r * 0.22, r * 0.55)] {
                    let (a, b) = (rot(o, y0, th), rot(o, y1, th));
                    clipped_line(&mut g, &cl, [cx + a[0], cy + a[1]], [cx + b[0], cy + b[1]], col, 4.0);
                }
            }
            let head = [rot(-14.0, -r + 62.0, th), rot(0.0, -r + 34.0, th), rot(14.0, -r + 62.0, th)];
            let hp = [[cx + head[0][0], cy + head[0][1]], [cx + head[1][0], cy + head[1][1]], [cx + head[2][0], cy + head[2][1]]];
            clipped_line(&mut g, &cl, hp[0], hp[1], col, 4.0);
            clipped_line(&mut g, &cl, hp[1], hp[2], col, 4.0);
        }
    }
    // ---- rose LS: ILS course / deviation bar ----
    if ls_mode && f.ils.valid {
        let th = rel_mag(f.ils.course, hdg).to_radians();
        let seg = |y0: f32, y1: f32| {
            let (a, b) = (rot(0.0, y0, th), rot(0.0, y1, th));
            ([cx + a[0], cy + a[1]], [cx + b[0], cy + b[1]])
        };
        for (y0, y1) in [(-r + 10.0, -r * 0.62), (r * 0.62, r - 10.0)] {
            let (a, b) = seg(y0, y1);
            clipped_line(&mut g, &cl, a, b, MAG, 5.0);
        }
        let dev = (f.ils.loc_dots as f32).clamp(-2.0, 2.0) * 40.0;
        let q = [rot(dev - 4.0, -r * 0.55, th), rot(dev + 4.0, -r * 0.55, th), rot(dev + 4.0, r * 0.55, th), rot(dev - 4.0, r * 0.55, th)];
        let qp = [[cx + q[0][0], cy + q[0][1]], [cx + q[1][0], cy + q[1][1]], [cx + q[2][0], cy + q[2][1]], [cx + q[3][0], cy + q[3][1]]];
        g.fan(&qp, MAG);
        for i in [-2.0f32, -1.0, 1.0, 2.0] {
            let p = rot(i * 40.0, 0.0, th);
            g.disc(cx + p[0], cy + p[1], 6.0, WHITE);
        }
    }
    // ---- track line and selected-heading line ----
    if !plan {
        let tr = rel_mag(fm.track, hdg).to_radians();
        clipped_line(&mut g, &cl, [cx, cy], [cx + tr.sin() * r, cy - tr.cos() * r], GREEN, 4.0);
        if !sys.hdg_managed && !ls_mode {
            let hb = rel_mag(f.ap.hdg, hdg).to_radians();
            if let Some((a, b)) = cl.seg([cx, cy], [cx + hb.sin() * r, cy - hb.cos() * r]) {
                g.line_dashed(a, b, CYAN, 3.0, 14.0, 12.0);
            }
        }
    }

    // ---- compass / range rings ----
    g.unclip();
    let span = if arc { 58.0f32 } else { 180.0 };
    if !plan {
        let mut a = 0;
        while a < 360 {
            let rel = rel_mag(a as f64, hdg);
            if rel.abs() <= span {
                let th = rel.to_radians();
                let ten = a % 10 == 0;
                let r2 = r - if ten { 28.0 } else { 15.0 };
                g.line(cx + th.sin() * r, cy - th.cos() * r, cx + th.sin() * r2, cy - th.cos() * r2, WHITE, if ten { 3.0 } else { 2.0 });
                if ten {
                    ct!(g, cx + th.sin() * (r - 62.0), cy - th.cos() * (r - 62.0), if a % 30 == 0 { 44.0 } else { 32.0 }, WHITE, CENTER, "{}", if a % 360 == 0 { 36 } else { (a / 10) % 36 });
                }
            }
            a += 5;
        }
        if arc {
            g.arc(cx, cy, r, -FRAC_PI_2 - span.to_radians(), -FRAC_PI_2 + span.to_radians(), WHITE, 3.0);
        } else {
            g.ring(cx, cy, r, WHITE, 3.0);
        }
        g.line(cx, cy - r - 22.0, cx, cy - r + 36.0, YELLOW, 8.0);
        // track diamond
        let trel = rel_mag(fm.track, hdg).clamp(-span, span).to_radians();
        let (dxm, dym) = (cx + trel.sin() * r, cy - trel.cos() * r);
        g.poly_stroke(&[[dxm, dym - 14.0], [dxm + 11.0, dym], [dxm, dym + 14.0], [dxm - 11.0, dym]], GREEN, 4.0, true);
        if !sys.hdg_managed {
            // selected-heading bug (cyan), digital read-out when off the visible scale
            let rel = rel_mag(f.ap.hdg, hdg);
            let clr = rel.clamp(-span, span).to_radians();
            let (bx, by) = (cx + clr.sin() * r, cy - clr.cos() * r);
            let pts = [rot(-14.0, -2.0, clr), rot(14.0, -2.0, clr), rot(0.0, -22.0, clr)];
            g.poly_stroke(&[[bx + pts[0][0], by + pts[0][1]], [bx + pts[1][0], by + pts[1][1]], [bx + pts[2][0], by + pts[2][1]]], CYAN, 5.0, true);
            let base = [rot(-14.0, 8.0, clr), rot(14.0, 8.0, clr), rot(14.0, -2.0, clr), rot(-14.0, -2.0, clr)];
            let bp = [[bx + base[0][0], by + base[0][1]], [bx + base[1][0], by + base[1][1]], [bx + base[2][0], by + base[2][1]], [bx + base[3][0], by + base[3][1]]];
            g.poly_stroke(&bp, CYAN, 5.0, true);
            if rel.abs() > span {
                g.text(cx + rel.signum() * 300.0, cy - r * 0.92 + if arc { 0.0 } else { 20.0 }, 34.0, CYAN, CENTER, &pad(f.ap.hdg.rem_euclid(360.0), 3));
            }
        }
    } else {
        g.text(cx, cy - r - 28.0, 38.0, CYAN, CENTER, "N");
        g.ring(cx, cy, r, WHITE, 3.0);
        for a in (0..360).step_by(30) {
            let th = (a as f32).to_radians();
            g.line(cx + th.sin() * r, cy - th.cos() * r, cx + th.sin() * (r - 18.0), cy - th.cos() * (r - 18.0), WHITE, 3.0);
        }
    }
    let fr: &[f32] = if arc { &[0.25, 0.5, 0.75] } else { &[0.5] };
    for &fq in fr {
        if arc {
            g.arc_dashed(cx, cy, r * fq, -FRAC_PI_2 - 56f32.to_radians(), -FRAC_PI_2 + 56f32.to_radians(), WHITE, 2.0, 9.0, 13.0);
        } else {
            g.arc_dashed(cx, cy, r * fq, 0.0, 2.0 * PI, WHITE, 2.0, 9.0, 13.0);
        }
    }
    let fmt = |v: f32| if v.fract() != 0.0 { format!("{:.1}", v) } else { format!("{}", v as i32) };
    if arc {
        for &fq in fr {
            for s in [-1.0f32, 1.0] {
                g.text(cx + s * 42f32.to_radians().sin() * r * fq, cy - 42f32.to_radians().cos() * r * fq + 24.0, 30.0, CYAN, CENTER, &fmt(rng * fq));
            }
        }
    } else {
        let q = std::f32::consts::FRAC_1_SQRT_2;
        g.text(cx - q * r * 0.5 + 4.0, cy + q * r * 0.5 + 4.0, 28.0, CYAN, CENTER, &fmt(rng / 4.0));
        g.text(cx - q * r * 0.98 + 4.0, cy + q * r * 0.98 + 4.0, 28.0, CYAN, CENTER, &fmt(rng / 2.0));
    }
    // ---- ownship ----
    let (ox, oy) = if plan { (own[0], own[1]) } else { (cx, cy) };
    let th = if plan { hdg.to_radians() as f32 } else { 0.0 };
    for ((x1, y1), (x2, y2), w) in [((0.0, -34.0), (0.0, 42.0), 8.0), ((-38.0, 10.0), (38.0, 10.0), 8.0), ((-15.0, 40.0), (15.0, 40.0), 7.0)] {
        let (a, b) = (rot(x1, y1, th), rot(x2, y2, th));
        g.line(ox + a[0], oy + a[1], ox + b[0], oy + b[1], YELLOW, w);
    }
    // ---- mode annunciation (the selected ND MODE page) ----
    g.text(600.0, 40.0, 26.0, if arc { CYAN } else { WHITE }, CENTER, ["ROSE LS", "ROSE VOR", "ROSE NAV", "ARC", "PLAN"][ng.mode]);
    // ---- header: GS / TAS / wind ----
    let gs_kt = fm.gs / KT;
    let tas = fm.tas / KT;
    g.text(34.0, 40.0, 28.0, WHITE, LEFT, "GS");
    ct!(g, 100.0, 40.0, 40.0, GREEN, LEFT, "{:.0}", gs_kt);
    g.text(215.0, 40.0, 28.0, WHITE, LEFT, "TAS");
    if tas >= 100.0 {
        ct!(g, 290.0, 40.0, 40.0, GREEN, LEFT, "{:.0}", tas);
    } else {
        g.text(290.0, 40.0, 40.0, WHITE, LEFT, "---");
    }
    let w = &f.weather;
    if w.wind_kt >= 1.0 {
        ct!(g, 34.0, 92.0, 36.0, GREEN, LEFT, "{:03.0}", w.wind_from_deg.rem_euclid(360.0));
        g.text(120.0, 92.0, 36.0, WHITE, LEFT, "/");
        ct!(g, 146.0, 92.0, 36.0, GREEN, LEFT, "{:.0}", w.wind_kt);
        if w.wind_kt > 2.0 {
            let th = ((w.wind_from_deg + 180.0 - hdg) as f32).to_radians();
            let tp = |x: f32, y: f32| {
                let r = rot(x, y, th);
                [70.0 + r[0], 150.0 + r[1]]
            };
            let (a, b) = (tp(0.0, 26.0), tp(0.0, -22.0));
            g.line(a[0], a[1], b[0], b[1], GREEN, 5.0);
            g.poly(&[tp(0.0, -34.0), tp(-12.0, -14.0), tp(12.0, -14.0)], GREEN);
        }
    } else {
        g.text(34.0, 92.0, 36.0, WHITE, LEFT, "---/--");
    }
    // ---- header: TO waypoint (NAV / ARC / PLAN), ILS data (rose LS) ----
    if show_map && !rt.is_empty() {
        let w0 = &rt[0];
        let dd = haversine(pos_lat, pos_lon, w0.lat, w0.lon) / 1852.0;
        let brg = bearing(pos_lat, pos_lon, w0.lat, w0.lon).rem_euclid(360.0);
        let t = f.utc() + dd / gs_kt.max(60.0) * 3600.0;
        g.text(966.0, 40.0, 36.0, WHITE, RIGHT, &w0.name);
        ct!(g, 966.0, 84.0, 34.0, GREEN, RIGHT, "{:03.0}", brg);
        g.text(966.0, 128.0, 28.0, CYAN, RIGHT, "NM");
        ct!(g, 896.0, 128.0, 34.0, GREEN, RIGHT, "{:.1}", dd);
        ct!(g, 966.0, 172.0, 34.0, GREEN, RIGHT, "{:02}:{:02}", ((t / 3600.0).floor() as i64).rem_euclid(24), ((t / 60.0).floor() as i64).rem_euclid(60));
    } else if ls_mode && f.ils.valid {
        g.text(966.0, 40.0, 30.0, MAG, RIGHT, &f.arr_end.ident);
        ct!(g, 966.0, 84.0, 30.0, WHITE, RIGHT, "{:.1} NM", f.ils.dist / 1852.0);
        ct!(g, 966.0, 128.0, 30.0, MAG, RIGHT, "CRS {:03.0}", f.ils.course.rem_euclid(360.0));
    } else if ls_mode {
        g.text(966.0, 40.0, 30.0, AMBER, RIGHT, "NO ILS");
    }
    // ---- bottom corners: selected ADF / VOR data ----
    if !plan {
        for (i, info) in nav_info.iter().enumerate() {
            let sel = ef.nav[i];
            if sel == 0 {
                continue;
            }
            let (x, al) = if i == 0 { (34.0f32, LEFT) } else { (966.0, RIGHT) };
            let col = if sel < 0 { GREEN } else { WHITE };
            match info {
                None => {
                    ct!(g, x, 900.0, 32.0, col, al, "{}{}", if sel > 0 { "VOR" } else { "ADF" }, i + 1);
                    g.text(x, 940.0, 32.0, WHITE, al, "---");
                }
                Some((vor, nv, d_nm)) => {
                    ct!(g, x, 880.0, 34.0, col, al, "{}{}", if *vor { "VOR" } else { "ADF" }, i + 1);
                    g.text(x, 920.0, 34.0, col, al, &nv.ident);
                    if *vor {
                        ct!(g, if i == 0 { x } else { x - 62.0 }, 960.0, 34.0, GREEN, al, "{:.1}", d_nm);
                        g.text(if i == 0 { x + 100.0 } else { x }, 960.0, 26.0, CYAN, al, "NM");
                    }
                }
            }
        }
    }
    if sys.chrono_show {
        g.rect(30.0, 780.0, 150.0, 52.0, c(0x5c, 0x6a, 0x75));
        let t = sys.chrono_t.floor() as i64;
        ct!(g, 105.0, 807.0, 36.0, CYAN, CENTER, "{}'{:02}\"", t / 60, t % 60);
    }
    if sys.terr_on_nd[side] {
        g.text(966.0, 800.0, 30.0, CYAN, RIGHT, "TERR");
    }
    if sys.lamp_test > 0.0 {
        g.text(cx, cy - 120.0, 40.0, AMBER, CENTER, "TEST");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_circle_contains_and_segments() {
        let c = Clip::circle(500.0, 500.0, 100.0);
        assert!(c.contains(500.0, 500.0));
        assert!(c.contains(590.0, 500.0));
        assert!(!c.contains(620.0, 500.0));
        // a chord through the middle is trimmed to the circle (a 56-gon is slightly inside the true circle)
        let (a, b) = c.seg([0.0, 500.0], [1000.0, 500.0]).unwrap();
        assert!((a[0] - 400.0).abs() < 2.5 && (b[0] - 600.0).abs() < 2.5, "{a:?} {b:?}");
        // a segment that misses entirely
        assert!(c.seg([0.0, 0.0], [1000.0, 0.0]).is_none());
        // a segment fully inside is untouched
        let (a, b) = c.seg([480.0, 500.0], [520.0, 510.0]).unwrap();
        assert_eq!((a, b), ([480.0, 500.0], [520.0, 510.0]));
    }

    #[test]
    fn half_plane_splits_the_region() {
        let r = Clip::rect(0.0, 0.0, 100.0, 100.0);
        let top = r.half(0.0, -1.0, 50.0); // y <= 50
        assert!(top.contains(50.0, 25.0) && !top.contains(50.0, 75.0));
        let bot = r.half(0.0, 1.0, -50.0); // y >= 50
        assert!(bot.contains(50.0, 75.0) && !bot.contains(50.0, 25.0));
        assert!(r.half(1.0, 0.0, -200.0).n < 3, "fully clipped away");
    }

    #[test]
    fn rotation_is_clockwise_on_screen() {
        let p = rot(0.0, -1.0, FRAC_PI_2); // up -> right
        assert!((p[0] - 1.0).abs() < 1e-6 && p[1].abs() < 1e-6);
    }

    #[test]
    fn thrust_detent_names() {
        assert_eq!(thr_name(1.0), "TOGA");
        assert_eq!(thr_name(0.9), "FLX/MCT");
        assert_eq!(thr_name(0.7), "CL");
        assert_eq!(thr_name(0.0), "IDLE");
        assert_eq!(thr_name(0.3), "");
    }
}
