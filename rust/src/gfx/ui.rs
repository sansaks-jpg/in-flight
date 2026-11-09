//! 2D UI: glyph atlas (rasterised once from the embedded DejaVu Sans Mono Bold), a batched triangle renderer with scissor
//! support, and the cockpit HUD (PFD, FCU, ECAM-lite, moving map, GPWS banners, menu, summary).

use crate::autopilot::ApPhase;
use crate::game::{Flight, Status};
use crate::geo::*;
use crate::gpws::Alert;
use crate::nav::PATH_TAN_DEG;
use ab_glyph::{point, Font, FontRef, PxScale, ScaleFont};
use crate::tiles::globe_tiles::GlobeV;
use crate::tiles::TileHub;
use bytemuck::{Pod, Zeroable};
use std::fmt::Write;

pub const CELL_W: usize = 22;
pub const CELL_H: usize = 44;
const COLS: usize = 16;
const ROWS: usize = 7;
pub const ATLAS_W: usize = CELL_W * COLS;
pub const ATLAS_H: usize = CELL_H * ROWS;
const FONT_PX: f32 = 36.0;
const ADVANCE: f32 = 0.602;
const WHITE_CELL: usize = 100;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct UiV {
    pub pos: [f32; 2],
    pub uv: [f32; 2],
    pub col: [f32; 4],
}

pub type Col = [f32; 4];
pub const C_WHITE: Col = [1.0, 1.0, 1.0, 1.0];
pub const C_GREEN: Col = [0.2, 1.0, 0.3, 1.0];
pub const C_CYAN: Col = [0.2, 0.9, 1.0, 1.0];
pub const C_MAGENTA: Col = [1.0, 0.35, 1.0, 1.0];
pub const C_AMBER: Col = [1.0, 0.7, 0.1, 1.0];
pub const C_RED: Col = [1.0, 0.15, 0.1, 1.0];
pub const C_GREY: Col = [0.65, 0.68, 0.72, 1.0];
pub const C_PANEL: Col = [0.02, 0.03, 0.05, 0.62];
const C_SKY: Col = [0.16, 0.45, 0.85, 1.0];
const C_GND: Col = [0.45, 0.28, 0.12, 1.0];

pub fn build_atlas() -> Vec<u8> {
    let font = FontRef::try_from_slice(include_bytes!("../../assets/DejaVuSansMono-Bold.ttf")).expect("embedded font");
    let sc = PxScale::from(FONT_PX);
    let ascent = font.as_scaled(sc).ascent();
    let mut px = vec![0u8; ATLAS_W * ATLAS_H];
    for code in 32u8..128 {
        let cell = (code - 32) as usize;
        let (cx, cy) = ((cell % COLS) * CELL_W, (cell / COLS) * CELL_H);
        let gl = font.glyph_id(code as char).with_scale_and_position(sc, point(0.0, ascent));
        if let Some(og) = font.outline_glyph(gl) {
            let b = og.px_bounds();
            og.draw(|x, y, cov| {
                let (ix, iy) = (b.min.x.floor() as i32 + x as i32, b.min.y.floor() as i32 + y as i32);
                if ix >= 0 && iy >= 0 && (ix as usize) < CELL_W && (iy as usize) < CELL_H {
                    px[(cy + iy as usize) * ATLAS_W + cx + ix as usize] = (cov.clamp(0.0, 1.0) * 255.0) as u8;
                }
            });
        }
    }
    let (wx, wy) = ((WHITE_CELL % COLS) * CELL_W, (WHITE_CELL / COLS) * CELL_H);
    for y in 0..CELL_H {
        for x in 0..CELL_W {
            px[(wy + y) * ATLAS_W + wx + x] = 255;
        }
    }
    px
}

pub struct DrawCmd {
    pub start: u32,
    pub count: u32,
    pub scissor: Option<[u32; 4]>,
    /// true: `start..start+count` indexes `Ui::gverts` (textured globe tiles) instead of `Ui::verts`
    pub globe: bool,
}

pub struct Ui {
    pub verts: Vec<UiV>,
    /// textured globe-tile triangles (separate buffer + pipeline; ordered against `verts` through `cmds`)
    pub gverts: Vec<GlobeV>,
    /// sub-solar unit vector (xyz) + emissive flag (w) for the globe tile shader
    pub globe_sun: [f32; 4],
    /// handle to the tile streaming hub (None in GPU-less tests / screenshots => procedural globe only)
    pub tiles: Option<TileHub>,
    pub cmds: Vec<DrawCmd>,
    cur_scissor: Option<[u32; 4]>,
    cmd_start: u32,
    buf: String,
    pub w: f32,
    pub h: f32,
}

pub const MAX_UI_VERTS: usize = 240_000;

impl Ui {
    pub fn new() -> Self {
        Self { verts: Vec::with_capacity(MAX_UI_VERTS), gverts: Vec::new(), globe_sun: [1.0, 0.0, 0.0, 0.0], tiles: None, cmds: Vec::with_capacity(64), cur_scissor: None, cmd_start: 0, buf: String::with_capacity(256), w: 1280.0, h: 720.0 }
    }

    pub fn begin(&mut self, w: f32, h: f32) {
        self.verts.clear();
        self.gverts.clear();
        self.cmds.clear();
        self.cur_scissor = None;
        self.cmd_start = 0;
        self.w = w;
        self.h = h;
    }

    fn flush(&mut self) {
        let n = self.verts.len() as u32;
        if n > self.cmd_start {
            self.cmds.push(DrawCmd { start: self.cmd_start, count: n - self.cmd_start, scissor: self.cur_scissor, globe: false });
        }
        self.cmd_start = n;
    }

    pub fn end(&mut self) {
        self.flush();
    }

    /// Starts a textured-globe batch: pending 2D geometry is flushed first so draw order is preserved. Push the tile
    /// vertices into `gverts`, then call [`Ui::globe_end`] with the index returned here.
    pub fn globe_begin(&mut self) -> usize {
        self.flush();
        self.gverts.len()
    }

    pub fn globe_end(&mut self, start: usize) {
        let n = self.gverts.len();
        if n > start {
            self.cmds.push(DrawCmd { start: start as u32, count: (n - start) as u32, scissor: self.cur_scissor, globe: true });
        }
    }

    pub fn scissor(&mut self, r: Option<[f32; 4]>) {
        self.flush();
        self.cur_scissor = r.map(|[x, y, w, h]| {
            let (x0, y0) = (x.max(0.0).floor() as u32, y.max(0.0).floor() as u32);
            let (x1, y1) = ((x + w).min(self.w).ceil() as u32, (y + h).min(self.h).ceil() as u32);
            [x0, y0, x1.saturating_sub(x0).max(1), y1.saturating_sub(y0).max(1)]
        });
    }

    #[inline]
    fn push(&mut self, p: [f32; 2], uv: [f32; 2], c: Col) {
        if self.verts.len() < MAX_UI_VERTS {
            self.verts.push(UiV { pos: p, uv, col: c });
        }
    }

    fn white_uv() -> [f32; 2] {
        let (wx, wy) = ((WHITE_CELL % COLS) * CELL_W, (WHITE_CELL / COLS) * CELL_H);
        [(wx + CELL_W / 2) as f32 / ATLAS_W as f32, (wy + CELL_H / 2) as f32 / ATLAS_H as f32]
    }

    pub fn tri(&mut self, a: [f32; 2], b: [f32; 2], c: [f32; 2], col: Col) {
        let uv = Self::white_uv();
        self.push(a, uv, col);
        self.push(b, uv, col);
        self.push(c, uv, col);
    }
    pub fn quad(&mut self, p: [[f32; 2]; 4], col: Col) {
        self.tri(p[0], p[1], p[2], col);
        self.tri(p[0], p[2], p[3], col);
    }
    pub fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, col: Col) {
        self.quad([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], col);
    }
    pub fn frame(&mut self, x: f32, y: f32, w: f32, h: f32, t: f32, col: Col) {
        self.rect(x, y, w, t, col);
        self.rect(x, y + h - t, w, t, col);
        self.rect(x, y, t, h, col);
        self.rect(x + w - t, y, t, h, col);
    }
    pub fn line(&mut self, a: [f32; 2], b: [f32; 2], th: f32, col: Col) {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l = (dx * dx + dy * dy).sqrt().max(1e-4);
        let (nx, ny) = (-dy / l * th * 0.5, dx / l * th * 0.5);
        self.quad([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]], col);
    }
    pub fn circle(&mut self, c: [f32; 2], r: f32, col: Col) {
        for k in 0..16 {
            let (a0, a1) = (k as f32 / 16.0 * std::f32::consts::TAU, (k + 1) as f32 / 16.0 * std::f32::consts::TAU);
            self.tri(c, [c[0] + a0.cos() * r, c[1] + a0.sin() * r], [c[0] + a1.cos() * r, c[1] + a1.sin() * r], col);
        }
    }

    /// Triangle with a colour per vertex (Gouraud) - used by the pre-flight globe and gradients.
    pub fn tri_c(&mut self, a: [f32; 2], b: [f32; 2], c: [f32; 2], ca: Col, cb: Col, cc: Col) {
        let uv = Self::white_uv();
        self.push(a, uv, ca);
        self.push(b, uv, cb);
        self.push(c, uv, cc);
    }
    /// Quad with a colour per corner (order: top-left, top-right, bottom-right, bottom-left).
    pub fn quad_c(&mut self, p: [[f32; 2]; 4], c: [Col; 4]) {
        self.tri_c(p[0], p[1], p[2], c[0], c[1], c[2]);
        self.tri_c(p[0], p[2], p[3], c[0], c[2], c[3]);
    }
    /// Vertical gradient rectangle.
    pub fn rect_v(&mut self, x: f32, y: f32, w: f32, h: f32, top: Col, bottom: Col) {
        self.quad_c([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], [top, top, bottom, bottom]);
    }
    /// Horizontal gradient rectangle.
    pub fn rect_h(&mut self, x: f32, y: f32, w: f32, h: f32, left: Col, right: Col) {
        self.quad_c([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], [left, right, right, left]);
    }
    /// Filled disc with `n` segments.
    pub fn disc(&mut self, c: [f32; 2], r: f32, n: u32, col: Col) {
        for k in 0..n {
            let (a0, a1) = (k as f32 / n as f32 * std::f32::consts::TAU, (k + 1) as f32 / n as f32 * std::f32::consts::TAU);
            self.tri(c, [c[0] + a0.cos() * r, c[1] + a0.sin() * r], [c[0] + a1.cos() * r, c[1] + a1.sin() * r], col);
        }
    }
    /// Radial gradient disc (centre colour -> rim colour).
    pub fn disc_g(&mut self, c: [f32; 2], r: f32, n: u32, centre: Col, rim: Col) {
        for k in 0..n {
            let (a0, a1) = (k as f32 / n as f32 * std::f32::consts::TAU, (k + 1) as f32 / n as f32 * std::f32::consts::TAU);
            self.tri_c(c, [c[0] + a0.cos() * r, c[1] + a0.sin() * r], [c[0] + a1.cos() * r, c[1] + a1.sin() * r], centre, rim, rim);
        }
    }
    /// Ring (annulus) outline with thickness `th`.
    pub fn ring(&mut self, c: [f32; 2], r: f32, th: f32, n: u32, col: Col) {
        let (ri, ro) = (r - th * 0.5, r + th * 0.5);
        for k in 0..n {
            let (a0, a1) = (k as f32 / n as f32 * std::f32::consts::TAU, (k + 1) as f32 / n as f32 * std::f32::consts::TAU);
            self.quad(
                [[c[0] + a0.cos() * ro, c[1] + a0.sin() * ro], [c[0] + a1.cos() * ro, c[1] + a1.sin() * ro], [c[0] + a1.cos() * ri, c[1] + a1.sin() * ri], [c[0] + a0.cos() * ri, c[1] + a0.sin() * ri]],
                col,
            );
        }
    }
    /// Connected line segments.
    pub fn polyline(&mut self, pts: &[[f32; 2]], th: f32, col: Col) {
        for w in pts.windows(2) {
            self.line(w[0], w[1], th, col);
        }
    }
    /// Filled simple polygon (ear clipping, works for concave outlines up to 64 points; no heap allocation).
    pub fn polygon(&mut self, pts: &[[f32; 2]], col: Col) {
        let n = pts.len().min(64);
        if n < 3 {
            return;
        }
        let area: f32 = (0..n).map(|i| pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1]).sum();
        let sgn = if area >= 0.0 { 1.0 } else { -1.0 };
        let mut idx = [0u8; 64];
        for (i, v) in idx.iter_mut().enumerate().take(n) {
            *v = i as u8;
        }
        let mut m = n;
        let cross = |a: [f32; 2], b: [f32; 2], c: [f32; 2]| (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        let mut guard = 0;
        while m > 3 && guard < 400 {
            guard += 1;
            let mut clipped = false;
            for i in 0..m {
                let (ia, ib, ic) = (idx[(i + m - 1) % m] as usize, idx[i] as usize, idx[(i + 1) % m] as usize);
                let (a, b, c) = (pts[ia], pts[ib], pts[ic]);
                if cross(a, b, c) * sgn <= 1e-6 {
                    continue;
                }
                let mut inside = false;
                for k in 0..m {
                    let ip = idx[k] as usize;
                    if ip == ia || ip == ib || ip == ic {
                        continue;
                    }
                    let p = pts[ip];
                    if cross(a, b, p) * sgn >= 0.0 && cross(b, c, p) * sgn >= 0.0 && cross(c, a, p) * sgn >= 0.0 {
                        inside = true;
                        break;
                    }
                }
                if inside {
                    continue;
                }
                self.tri(a, b, c, col);
                for k in i..m - 1 {
                    idx[k] = idx[k + 1];
                }
                m -= 1;
                clipped = true;
                break;
            }
            if !clipped {
                break;
            }
        }
        if m == 3 {
            self.tri(pts[idx[0] as usize], pts[idx[1] as usize], pts[idx[2] as usize], col);
        }
    }

    /// Text with explicit alignment (0 left, 1 centre, 2 right) and no formatting machinery.
    pub fn text_a(&mut self, x: f32, y: f32, size: f32, col: Col, align: u8, s: &str) {
        let w = Self::text_width(size, s.chars().count());
        let x0 = match align {
            1 => x - w * 0.5,
            2 => x - w,
            _ => x,
        };
        self.text(x0, y, size, col, s);
    }

    pub fn text_width(size: f32, n: usize) -> f32 {
        n as f32 * size * ADVANCE
    }

    /// Left-aligned text at the top-left corner (x, y); `size` is the em height in pixels.
    pub fn text(&mut self, x: f32, y: f32, size: f32, col: Col, s: &str) {
        let k = size / FONT_PX;
        let mut cx = x;
        for ch in s.chars() {
            let code = if (32..128).contains(&(ch as u32)) { ch as u32 } else { b'?' as u32 };
            if code != 32 {
                let cell = (code - 32) as usize;
                let (u0, v0) = (((cell % COLS) * CELL_W) as f32 / ATLAS_W as f32, ((cell / COLS) * CELL_H) as f32 / ATLAS_H as f32);
                let (u1, v1) = (u0 + CELL_W as f32 / ATLAS_W as f32, v0 + CELL_H as f32 / ATLAS_H as f32);
                let (x1, y1) = (cx + CELL_W as f32 * k, y + CELL_H as f32 * k);
                self.push([cx, y], [u0, v0], col);
                self.push([x1, y], [u1, v0], col);
                self.push([x1, y1], [u1, v1], col);
                self.push([cx, y], [u0, v0], col);
                self.push([x1, y1], [u1, v1], col);
                self.push([cx, y1], [u0, v1], col);
            }
            cx += size * ADVANCE;
        }
    }

    /// Formatted text using a reusable scratch buffer (no per-frame heap allocation). align: 0 left, 1 centre, 2 right.
    pub fn textf(&mut self, x: f32, y: f32, size: f32, col: Col, align: u8, args: std::fmt::Arguments) {
        let mut b = std::mem::take(&mut self.buf);
        b.clear();
        let _ = b.write_fmt(args);
        let w = Self::text_width(size, b.chars().count());
        let x0 = match align {
            1 => x - w * 0.5,
            2 => x - w,
            _ => x,
        };
        self.text(x0, y, size, col, &b);
        self.buf = b;
    }
}

impl Default for Ui {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum View {
    /// captain's eye (3D flight deck with working displays)
    Cockpit,
    /// leaning towards the display units
    Panel,
    Wing,
    Chase,
    Tower,
}


pub struct HudInfo {
    pub fps: f32,
    pub frame_ms: f32,
    pub sim_ms: f32,
    pub view: View,
    pub paused: bool,
    pub help: bool,
    pub time: f64,
    /// the 3D flight deck shows the PFD / ND / ECAM itself => hide the 2D overlay copies
    pub panels3d: bool,
}

macro_rules! tf {
    ($ui:expr, $x:expr, $y:expr, $s:expr, $c:expr, $a:expr, $($arg:tt)*) => { $ui.textf($x, $y, $s, $c, $a, format_args!($($arg)*)) };
}

fn rot(c: [f32; 2], ex: [f32; 2], ey: [f32; 2], x: f32, y: f32) -> [f32; 2] {
    [c[0] + ex[0] * x + ey[0] * y, c[1] + ex[1] * x + ey[1] * y]
}

pub fn draw_pfd(ui: &mut Ui, f: &Flight, px: f32, py: f32, u: f32) {
    let fm = &f.fm;
    let kias = fm.ias / KT;
    let alt_ft = fm.pos.y / FT;
    let (aw, ah) = (8.8 * u, 7.8 * u);
    let (ax, ay) = (px + 2.6 * u, py + 0.6 * u);
    let c = [ax + aw / 2.0, ay + ah / 2.0];
    ui.rect(px - 0.2 * u, py - 0.2 * u, 14.4 * u, 10.4 * u, [0.0, 0.0, 0.0, 0.55]);
    // --- attitude ---
    ui.scissor(Some([ax, ay, aw, ah]));
    let b = fm.bank as f32;
    let ex = [b.cos(), -b.sin()];
    let ey = [b.sin(), b.cos()];
    let ppd = 0.26 * u;
    let pitch_deg = fm.pitch.to_degrees() as f32;
    let hz = rot(c, ex, ey, 0.0, pitch_deg * ppd);
    let l = 30.0 * u;
    ui.quad([rot(hz, ex, ey, -l, -l), rot(hz, ex, ey, l, -l), rot(hz, ex, ey, l, 0.0), rot(hz, ex, ey, -l, 0.0)], C_SKY);
    ui.quad([rot(hz, ex, ey, -l, 0.0), rot(hz, ex, ey, l, 0.0), rot(hz, ex, ey, l, l), rot(hz, ex, ey, -l, l)], C_GND);
    ui.line(rot(hz, ex, ey, -l, 0.0), rot(hz, ex, ey, l, 0.0), 0.05 * u, C_WHITE);
    for p in (-30i32..=30).step_by(5) {
        if p == 0 {
            continue;
        }
        let off = (pitch_deg - p as f32) * ppd;
        let half = if p % 10 == 0 { 1.2 * u } else { 0.6 * u };
        ui.line(rot(c, ex, ey, -half, off), rot(c, ex, ey, half, off), 0.04 * u, C_WHITE);
        if p % 10 == 0 {
            tf!(ui, rot(c, ex, ey, -half - 0.2 * u, off - 0.25 * u)[0], rot(c, ex, ey, -half, off - 0.25 * u)[1], 0.5 * u, C_WHITE, 2, "{}", p.abs());
        }
    }
    // bank scale (fixed ticks) + roll pointer (rotating)
    let r = 3.5 * u;
    for a in [-45.0f32, -30.0, -20.0, -10.0, 0.0, 10.0, 20.0, 30.0, 45.0] {
        let t = a.to_radians();
        let (s, co) = (t.sin(), t.cos());
        let len = if a.abs() == 30.0 || a == 0.0 { 0.35 * u } else { 0.2 * u };
        ui.line([c[0] + s * r, c[1] - co * r], [c[0] + s * (r + len), c[1] - co * (r + len)], 0.04 * u, C_WHITE);
    }
    let tp = rot(c, ex, ey, 0.0, -r + 0.05 * u);
    ui.tri(tp, rot(c, ex, ey, -0.25 * u, -r + 0.5 * u), rot(c, ex, ey, 0.25 * u, -r + 0.5 * u), C_AMBER);
    // aircraft symbol
    ui.rect(c[0] - 2.3 * u, c[1] - 0.04 * u, 1.5 * u, 0.1 * u, C_AMBER);
    ui.rect(c[0] + 0.8 * u, c[1] - 0.04 * u, 1.5 * u, 0.1 * u, C_AMBER);
    ui.rect(c[0] - 0.06 * u, c[1] - 0.06 * u, 0.14 * u, 0.14 * u, C_AMBER);
    // flight-path vector
    if fm.gs > 20.0 {
        let gamma = (fm.vel.y / fm.vel.length().max(1.0)).asin().to_degrees() as f32;
        let drift = wrap180(fm.track - fm.heading) as f32;
        let fp = [c[0] + drift * ppd, c[1] + (pitch_deg - gamma) * ppd];
        ui.circle(fp, 0.16 * u, C_GREEN);
        ui.circle(fp, 0.11 * u, [0.0, 0.0, 0.0, 1.0]);
        ui.line([fp[0] - 0.55 * u, fp[1]], [fp[0] - 0.18 * u, fp[1]], 0.05 * u, C_GREEN);
        ui.line([fp[0] + 0.18 * u, fp[1]], [fp[0] + 0.55 * u, fp[1]], 0.05 * u, C_GREEN);
        ui.line([fp[0], fp[1] - 0.18 * u], [fp[0], fp[1] - 0.45 * u], 0.05 * u, C_GREEN);
    }
    // ILS needles
    if f.ils.valid && f.ils.dist < 30000.0 && f.ils.dist > 0.0 {
        let lx = c[0] + (f.ils.loc_dots as f32) * 0.55 * u;
        let gy = c[1] + (-f.ils.gs_dots as f32) * 0.55 * u;
        ui.rect(lx - 0.05 * u, ay + ah - 0.9 * u, 0.1 * u, 0.7 * u, C_MAGENTA);
        ui.rect(ax + aw - 0.9 * u, gy - 0.05 * u, 0.7 * u, 0.1 * u, C_MAGENTA);
    }
    ui.scissor(None);
    ui.frame(ax, ay, aw, ah, 0.06 * u, C_GREY);

    // --- speed tape ---
    let (sx, sy, sw) = (px, ay, 2.4 * u);
    ui.rect(sx, sy, sw, ah, [0.08, 0.1, 0.13, 0.9]);
    ui.scissor(Some([sx, sy, sw, ah]));
    let ppk = ah / 80.0;
    let sc = sy + ah / 2.0;
    let k0 = ((kias - 40.0) / 10.0).floor() as i32 * 10;
    for k in (k0..=k0 + 90).step_by(10) {
        if k < 30 {
            continue;
        }
        let y = sc - (k as f32 - kias as f32) * ppk;
        ui.line([sx + sw - 0.5 * u, y], [sx + sw, y], 0.05 * u, C_WHITE);
        if k % 20 == 0 {
            tf!(ui, sx + sw - 0.6 * u, y - 0.28 * u, 0.55 * u, C_WHITE, 2, "{}", k);
        }
    }
    // selected speed bug + VLS / limit
    let spd_y = sc - (f.ap.spd as f32 - kias as f32) * ppk;
    ui.tri([sx + sw, spd_y], [sx + sw + 0.35 * u, spd_y - 0.25 * u], [sx + sw + 0.35 * u, spd_y + 0.25 * u], if f.ap.spd_selected { C_CYAN } else { C_MAGENTA });
    // FBW protection speeds (fbw::envelope): VLS (amber), Vα prot..Vα max (orange), VSW (red) and VMAX (red)
    let env = crate::fbw::envelope(fm);
    let yv = |v: f64| sc - (v as f32 - kias as f32) * ppk;
    let bw = 0.12 * u;
    ui.rect(sx + sw - bw, yv(env.vls), bw, ah * 2.0, C_AMBER);
    ui.rect(sx + sw - bw * 2.3, yv(env.v_alpha_prot), bw * 1.2, (yv(env.v_alpha_max) - yv(env.v_alpha_prot)).max(0.0), [1.0, 0.5, 0.05, 0.95]);
    ui.rect(sx + sw - bw * 2.3, yv(env.v_alpha_max), bw * 1.2, ah * 2.0, C_RED);
    ui.rect(sx + sw - bw, yv(env.v_sw), bw, ah * 2.0, C_RED);
    ui.rect(sx + sw - bw, sy - ah, bw, yv(env.vmax) - (sy - ah), C_RED);
    ui.scissor(None);
    ui.rect(sx, sc - 0.42 * u, sw, 0.84 * u, [0.0, 0.0, 0.0, 1.0]);
    ui.frame(sx, sc - 0.42 * u, sw, 0.84 * u, 0.04 * u, C_WHITE);
    tf!(ui, sx + sw - 0.25 * u, sc - 0.33 * u, 0.7 * u, C_GREEN, 2, "{:.0}", kias);
    ui.frame(sx, sy, sw, ah, 0.05 * u, C_GREY);
    tf!(ui, sx + 0.1 * u, sy + ah + 0.05 * u, 0.5 * u, C_GREEN, 0, "GS {:.0}", fm.gs / KT);
    tf!(ui, sx + 0.1 * u, sy - 0.65 * u, 0.5 * u, C_CYAN, 0, "M{:.2}", fm.mach);

    // --- altitude tape ---
    let (tx, ty, tw) = (px + 11.6 * u, ay, 2.4 * u);
    ui.rect(tx, ty, tw, ah, [0.08, 0.1, 0.13, 0.9]);
    ui.scissor(Some([tx, ty, tw, ah]));
    let ppf = ah / 640.0;
    let tc = ty + ah / 2.0;
    let a0 = ((alt_ft as f32 - 340.0) / 100.0).floor() as i32 * 100;
    for a in (a0..=a0 + 700).step_by(100) {
        let y = tc - (a as f32 - alt_ft as f32) * ppf;
        ui.line([tx, y], [tx + 0.5 * u, y], 0.05 * u, C_WHITE);
        if a % 200 == 0 {
            tf!(ui, tx + 0.65 * u, y - 0.28 * u, 0.55 * u, C_WHITE, 0, "{}", a);
        }
    }
    // ground (terrain) band
    let gy = tc - ((fm.ground_h / FT) as f32 - alt_ft as f32) * ppf;
    if gy < ty + ah {
        ui.rect(tx, gy.max(ty), 0.18 * u, ty + ah - gy.max(ty), C_AMBER);
    }
    let bug = tc - (f.ap.alt_ft as f32 - alt_ft as f32) * ppf;
    ui.tri([tx, bug], [tx - 0.35 * u, bug - 0.25 * u], [tx - 0.35 * u, bug + 0.25 * u], C_CYAN);
    ui.scissor(None);
    ui.rect(tx, tc - 0.42 * u, tw, 0.84 * u, [0.0, 0.0, 0.0, 1.0]);
    ui.frame(tx, tc - 0.42 * u, tw, 0.84 * u, 0.04 * u, C_WHITE);
    tf!(ui, tx + tw - 0.2 * u, tc - 0.33 * u, 0.7 * u, C_GREEN, 2, "{:.0}", alt_ft);
    ui.frame(tx, ty, tw, ah, 0.05 * u, C_GREY);
    tf!(ui, tx + 0.1 * u, ty - 0.65 * u, 0.5 * u, C_CYAN, 0, "{:.0}", f.ap.alt_ft);
    let vs_fpm = fm.vs / (FT / 60.0);
    tf!(ui, tx + 0.1 * u, ty + ah + 0.05 * u, 0.5 * u, if vs_fpm.abs() > 2000.0 { C_AMBER } else { C_GREEN }, 0, "VS {:+.0}", vs_fpm);
    if fm.agl < 800.0 && !fm.wow {
        tf!(ui, tx + 0.1 * u, ty + ah + 0.62 * u, 0.5 * u, C_AMBER, 0, "RA {:.0}", fm.agl / FT);
    }

    // --- heading tape ---
    let (hx, hy, hw, hh) = (ax, py + 8.6 * u, aw, 1.4 * u);
    ui.rect(hx, hy, hw, hh, [0.08, 0.1, 0.13, 0.9]);
    ui.scissor(Some([hx, hy, hw, hh]));
    let pph = hw / 60.0;
    let h0 = ((fm.heading - 32.0) / 5.0).floor() as i32 * 5;
    for hd in (h0..=h0 + 70).step_by(5) {
        let x = hx + hw / 2.0 + (hd as f64 - fm.heading) as f32 * pph;
        ui.line([x, hy], [x, hy + if hd % 10 == 0 { 0.45 * u } else { 0.25 * u }], 0.05 * u, C_WHITE);
        if hd % 10 == 0 {
            let v = ((hd % 360) + 360) % 360;
            tf!(ui, x, hy + 0.5 * u, 0.5 * u, C_WHITE, 1, "{:03}", v);
        }
    }
    let hb = hx + hw / 2.0 + wrap180(f.ap.hdg - fm.heading) as f32 * pph;
    ui.tri([hb, hy], [hb - 0.25 * u, hy + 0.4 * u], [hb + 0.25 * u, hy + 0.4 * u], C_CYAN);
    let tk = hx + hw / 2.0 + wrap180(fm.track - fm.heading) as f32 * pph;
    ui.tri([tk, hy + hh], [tk - 0.2 * u, hy + hh - 0.35 * u], [tk + 0.2 * u, hy + hh - 0.35 * u], C_GREEN);
    ui.scissor(None);
    ui.tri([hx + hw / 2.0, hy - 0.05 * u], [hx + hw / 2.0 - 0.2 * u, hy - 0.4 * u], [hx + hw / 2.0 + 0.2 * u, hy - 0.4 * u], C_AMBER);
    ui.frame(hx, hy, hw, hh, 0.05 * u, C_GREY);
    tf!(ui, hx + 0.1 * u, hy - 0.62 * u, 0.5 * u, C_GREEN, 0, "{:03.0}T", fm.heading);
}

pub fn draw_map(ui: &mut Ui, f: &Flight, x: f32, y: f32, s: f32) {
    ui.rect(x, y, s, s, [0.02, 0.05, 0.04, 0.78]);
    ui.scissor(Some([x, y, s, s]));
    // north-up map auto-fitted to the route, aircraft always inside
    let (mut min_x, mut max_x, mut min_z, mut max_z) = (f.fm.pos.x, f.fm.pos.x, f.fm.pos.z, f.fm.pos.z);
    let pts = |w: &crate::geo::Waypoint| (f.proj.x(w.lon), f.proj.z(w.lat));
    for w in &f.plan {
        let (wx, wz) = pts(w);
        min_x = min_x.min(wx);
        max_x = max_x.max(wx);
        min_z = min_z.min(wz);
        max_z = max_z.max(wz);
    }
    let span = ((max_x - min_x).max(max_z - min_z) * 1.25).max(6000.0);
    let (cx, cz) = ((min_x + max_x) / 2.0, (min_z + max_z) / 2.0);
    let k = s as f64 / span;
    let to = |wx: f64, wz: f64| -> [f32; 2] { [x + s / 2.0 + ((wx - cx) * k) as f32, y + s / 2.0 + ((wz - cz) * k) as f32] };
    let mut prev: Option<[f32; 2]> = None;
    for (i, w) in f.plan.iter().enumerate() {
        let (wx, wz) = pts(w);
        let p = to(wx, wz);
        if let Some(q) = prev {
            ui.line(q, p, 2.0, if i <= f.active_wp { [0.4, 0.4, 0.4, 1.0] } else { C_MAGENTA });
        }
        ui.circle(p, if i == f.active_wp { 4.0 } else { 2.5 }, if i == f.active_wp { C_WHITE } else { C_CYAN });
        prev = Some(p);
    }
    // runways
    for (ap, rw_end) in [(&f.dep, &f.dep_end), (&f.arr, &f.arr_end)] {
        let a = to(f.proj.x(rw_end.start_lon), f.proj.z(rw_end.start_lat));
        let b = to(f.proj.x(rw_end.end_lon), f.proj.z(rw_end.end_lat));
        ui.line(a, b, 3.0, C_WHITE);
        let _ = ap;
    }
    // aircraft triangle
    let p = to(f.fm.pos.x, f.fm.pos.z);
    let h = f.fm.heading.to_radians() as f32;
    let (sn, co) = (h.sin(), -h.cos());
    let (rx, rz) = (-co, sn);
    ui.tri([p[0] + sn * 9.0, p[1] + co * 9.0], [p[0] - sn * 6.0 + rx * 6.0, p[1] - co * 6.0 + rz * 6.0], [p[0] - sn * 6.0 - rx * 6.0, p[1] - co * 6.0 - rz * 6.0], C_AMBER);
    ui.scissor(None);
    ui.frame(x, y, s, s, 2.0, C_GREY);
    tf!(ui, x + 6.0, y + 4.0, 13.0, C_GREY, 0, "MAP  N");
}

pub fn draw_hud(ui: &mut Ui, f: &Flight, info: &HudInfo) {
    let (w, h) = (ui.w, ui.h);
    let base = (h / 46.0).clamp(11.0, 26.0);
    let u = (h * 0.032).clamp(10.0, 34.0);
    if !info.panels3d {
        draw_pfd(ui, f, w * 0.5 - 7.0 * u, h - 10.2 * u - 8.0, u);
        let ms = (h * 0.27).clamp(130.0, 300.0);
        draw_map(ui, f, 10.0, h - ms - 10.0, ms);
    }

    // ---- FCU / autopilot strip (top centre) ----
    let fw = (base * 34.0).min(w * 0.6);
    let fx = w * 0.5 - fw / 2.0;
    ui.rect(fx, 8.0, fw, base * 3.6, C_PANEL);
    let colw = fw / 4.0;
    let ap = &f.ap;
    let lab = |ui: &mut Ui, i: usize, name: &str, val: &str, col: Col| {
        tf!(ui, fx + colw * (i as f32 + 0.5), 10.0, base * 0.8, C_GREY, 1, "{}", name);
        tf!(ui, fx + colw * (i as f32 + 0.5), 10.0 + base * 0.85, base * 1.35, col, 1, "{}", val);
    };
    let mut sb = [0u8; 16];
    let spd = fmt_into(&mut sb, format_args!("{:.0}", ap.spd));
    lab(ui, 0, if ap.spd_selected { "SPD" } else { "SPD (managed)" }, spd, if ap.on { if ap.spd_selected { C_CYAN } else { C_MAGENTA } } else { C_GREY });
    let mut hb = [0u8; 16];
    let hd = fmt_into(&mut hb, format_args!("{:03.0}", ap.hdg));
    lab(ui, 1, if ap.nav { "HDG (LNAV)" } else { "HDG" }, hd, if ap.on { if ap.nav { C_MAGENTA } else { C_CYAN } } else { C_GREY });
    let mut ab = [0u8; 16];
    let al = fmt_into(&mut ab, format_args!("{:.0}", ap.alt_ft));
    lab(ui, 2, if ap.alt_selected { "ALT" } else { "ALT (managed)" }, al, if ap.on { if ap.alt_selected { C_CYAN } else { C_MAGENTA } } else { C_GREY });
    let mut vb = [0u8; 16];
    let vs = match ap.vs_hold_fpm {
        Some(v) => fmt_into(&mut vb, format_args!("{:+.0}", v)),
        None => "----",
    };
    lab(ui, 3, "V/S", vs, if ap.vs_hold_fpm.is_some() { C_CYAN } else { C_GREY });
    let mode = if ap.on {
        ap.phase.label()
    } else {
        "AP OFF"
    };
    tf!(ui, w * 0.5, 12.0 + base * 3.7, base * 1.0, if ap.on { C_GREEN } else { C_AMBER }, 1, "{}{}{}  {}", if ap.on { "AP1 " } else { "" }, if ap.on && ap.appr { "LOC/GS " } else { "" }, if ap.on && ap.on { "A/THR" } else { "" }, mode);

    // ---- flight info (top left) ----
    ui.rect(8.0, 8.0, base * 17.5, base * 6.9, C_PANEL);
    tf!(ui, 14.0, 10.0, base * 1.1, C_WHITE, 0, "{} > {}", f.dep.icao, f.arr.icao);
    tf!(ui, 14.0, 10.0 + base * 1.25, base * 0.9, C_GREY, 0, "RWY {} > RWY {}", f.dep_end.ident, f.arr_end.ident);
    if let Some((wp, d, eta)) = f.next_wp() {
        tf!(ui, 14.0, 10.0 + base * 2.35, base * 0.95, C_MAGENTA, 0, "NEXT {} {:.1} NM", wp.name, d / 1852.0);
        tf!(ui, 14.0, 10.0 + base * 3.45, base * 0.95, C_GREY, 0, "ETA {}:{:02}   DTG {:.0} NM", (eta / 60.0) as u32, (eta % 60.0) as u32, f.dist_to_go() / 1852.0);
    }
    let (hh_, mm_) = crate::clock::hhmm(f.utc());
    let (sun_el, _) = crate::clock::sun_position(f.utc(), f.lat, f.lon);
    tf!(ui, 14.0, 10.0 + base * 4.55, base * 0.9, C_GREY, 0, "{:02}:{:02}Z  sun {:+.0}deg", hh_, mm_, sun_el);
    let wnd = f.weather;
    tf!(ui, 14.0, 10.0 + base * 5.5, base * 0.9, C_GREY, 0, "WIND {:03.0}/{:.0}  QNH {:.0}", wnd.wind_from_deg, wnd.wind_kt, wnd.qnh);

    // ---- ECAM-lite (top right) ----
    if !info.panels3d {
    let ew = base * 15.0;
    let ex = w - ew - 8.0;
    ui.rect(ex, 8.0, ew, base * 12.0, C_PANEL);
    let fm = &f.fm;
    tf!(ui, ex + ew / 2.0, 10.0, base * 0.9, C_GREY, 1, "ENG  N1 %");
    for (i, n) in fm.n.iter().enumerate() {
        let bx = ex + 14.0 + i as f32 * (ew / 2.0 - 4.0);
        let bw = ew / 2.0 - 24.0;
        ui.rect(bx, 10.0 + base * 1.3, bw, base * 0.9, [0.15, 0.15, 0.18, 1.0]);
        ui.rect(bx, 10.0 + base * 1.3, bw * *n as f32, base * 0.9, if *n > 0.95 { C_AMBER } else { C_GREEN });
        tf!(ui, bx + bw / 2.0, 10.0 + base * 2.3, base * 0.95, C_GREEN, 1, "{:.0}", n * 100.0);
    }
    tf!(ui, ex + 12.0, 10.0 + base * 3.6, base * 0.9, C_WHITE, 0, "FF {:.0} KG/H", fm.fuel_flow * 3600.0);
    tf!(ui, ex + 12.0, 10.0 + base * 4.6, base * 0.9, if fm.fuel < 1500.0 { C_AMBER } else { C_WHITE }, 0, "FUEL {:.0} KG", fm.fuel);
    tf!(ui, ex + 12.0, 10.0 + base * 5.6, base * 0.9, C_WHITE, 0, "GW {:.1} T", fm.mass / 1000.0);
    let gear = if fm.gear_pos > 0.98 { "DOWN" } else if fm.gear_pos < 0.02 { "UP" } else { "TRANSIT" };
    tf!(ui, ex + 12.0, 10.0 + base * 6.6, base * 0.9, if fm.gear_pos > 0.98 { C_GREEN } else { C_AMBER }, 0, "GEAR {}", gear);
    let fl = ["0", "1", "2", "3", "FULL"][fm.ctl.flaps_idx.min(4)];
    tf!(ui, ex + 12.0, 10.0 + base * 7.6, base * 0.9, C_GREEN, 0, "CONF {}", fl);
    tf!(ui, ex + 12.0, 10.0 + base * 8.6, base * 0.9, C_WHITE, 0, "SPD BRK {:.0}%  {}", fm.sb_pos * 100.0, if fm.ctl.spoilers_armed { "GND SPLR ARM" } else { "" });
    tf!(ui, ex + 12.0, 10.0 + base * 9.6, base * 0.9, C_WHITE, 0, "A/BRK {}  {}", ["OFF", "LO", "MED", "MAX"][fm.ctl.autobrake.min(3) as usize], if fm.ctl.parking { "PARK BRK" } else { "" });
    tf!(ui, ex + 12.0, 10.0 + base * 10.4, base * 0.85, C_GREY, 0, "G {:.2}  AOA {:.1}deg", fm.nz, fm.alpha.to_degrees());
    }
    let fm = &f.fm;

    // ---- perf (bottom right) ----
    let px = w - base * 15.0 - 8.0;
    ui.rect(px, h - base * 4.4 - 8.0, base * 15.0, base * 4.4, C_PANEL);
    let fc = if info.fps >= 58.0 { C_GREEN } else if info.fps >= 30.0 { C_AMBER } else { C_RED };
    tf!(ui, px + 8.0, h - base * 4.4 - 4.0, base * 1.1, fc, 0, "{:.0} FPS", info.fps);
    tf!(ui, px + 8.0, h - base * 3.1 - 4.0, base * 0.85, C_GREY, 0, "frame {:.2} ms  sim {:.2} ms", info.frame_ms, info.sim_ms);
    tf!(ui, px + 8.0, h - base * 2.1 - 4.0, base * 0.85, C_GREY, 0, "view {:?} [C]  help [F1]", info.view);

    // ---- messages (left, under the info block) ----
    let mut y = 20.0 + base * 7.2;
    for (t, m) in f.msgs.iter().rev().take(5) {
        let age = (f.t - t) as f32;
        if age < 9.0 {
            let a = (1.0 - (age - 6.0).max(0.0) / 3.0).clamp(0.0, 1.0);
            tf!(ui, 14.0, y, base * 0.95, [1.0, 1.0, 1.0, a], 0, "{}", m);
            y += base * 1.15;
        }
    }

    // ---- GPWS / alerts (centre) ----
    let g = f.gpws_out;
    if g.alert != Alert::None {
        let flash = ((info.time * 4.0) as i64 % 2 == 0) || !g.alert.is_warning();
        if flash {
            let col = if g.alert.is_warning() { C_RED } else { C_AMBER };
            tf!(ui, w * 0.5, h * 0.2, base * 2.4, col, 1, "{}", g.alert.text());
        }
    }
    if let Some(c) = g.callout_ft {
        tf!(ui, w * 0.5, h * 0.27, base * 2.0, C_GREEN, 1, "{}", c);
    }
    if fm.ctl.reverse && fm.wow {
        tf!(ui, w * 0.5, h * 0.33, base * 1.2, C_GREEN, 1, "REV");
    }

    // ---- end-of-flight summary ----
    if matches!(f.status, Status::Landed | Status::Crashed) {
        ui.rect(0.0, 0.0, w, h, [0.0, 0.0, 0.0, 0.5]);
        let (pw, ph) = (base * 30.0, base * 15.0);
        let (x0, y0) = (w / 2.0 - pw / 2.0, h / 2.0 - ph / 2.0);
        ui.rect(x0, y0, pw, ph, [0.03, 0.05, 0.09, 0.95]);
        ui.frame(x0, y0, pw, ph, 2.0, if f.status == Status::Crashed { C_RED } else { C_GREEN });
        if f.status == Status::Crashed {
            tf!(ui, w / 2.0, y0 + base, base * 2.0, C_RED, 1, "FLIGHT TERMINATED");
            tf!(ui, w / 2.0, y0 + base * 3.6, base * 1.1, C_WHITE, 1, "{}", fm.crash_reason);
        } else {
            tf!(ui, w / 2.0, y0 + base, base * 2.0, C_GREEN, 1, "FLIGHT COMPLETE");
            if let Some(td) = f.touchdown {
                tf!(ui, w / 2.0, y0 + base * 3.6, base * 1.6, C_WHITE, 1, "{}", td.grade);
                tf!(ui, w / 2.0, y0 + base * 5.6, base * 1.0, C_GREY, 1, "touchdown {:.0} fpm  {:.0} kt", td.fpm, td.speed_kt);
                tf!(ui, w / 2.0, y0 + base * 6.9, base * 1.0, C_GREY, 1, "pitch {:+.1}  bank {:+.1}  centreline {:+.1} m", td.pitch_deg, td.bank_deg, td.centreline_m);
            }
        }
        tf!(ui, w / 2.0, y0 + base * 8.6, base * 1.0, C_GREY, 1, "flight time {:.0} min  fuel left {:.0} kg", f.t / 60.0, fm.fuel);
        tf!(ui, w / 2.0, y0 + ph - base * 2.2, base * 1.1, C_CYAN, 1, "[ENTER] new flight    [ESC] quit");
    }

    if info.help {
        draw_help(ui, base);
    }
    if info.paused && matches!(f.status, Status::Ready | Status::Flying) {
        ui.rect(0.0, 0.0, w, h, [0.0, 0.0, 0.0, 0.45]);
        tf!(ui, w / 2.0, h * 0.4, base * 3.0, C_WHITE, 1, "PAUSED");
        tf!(ui, w / 2.0, h * 0.4 + base * 3.6, base * 1.2, C_GREY, 1, "[P] resume   [F1] controls   [ESC] menu");
    }
    let _ = PATH_TAN_DEG;
    let _ = ApPhase::Idle;
}

fn fmt_into<'a>(buf: &'a mut [u8; 16], args: std::fmt::Arguments) -> &'a str {
    struct W<'b> {
        b: &'b mut [u8; 16],
        n: usize,
    }
    impl Write for W<'_> {
        fn write_str(&mut self, s: &str) -> std::fmt::Result {
            let by = s.as_bytes();
            let k = by.len().min(16 - self.n);
            self.b[self.n..self.n + k].copy_from_slice(&by[..k]);
            self.n += k;
            Ok(())
        }
    }
    let mut w = W { b: buf, n: 0 };
    let _ = w.write_fmt(args);
    let n = w.n;
    std::str::from_utf8(&buf[..n]).unwrap_or("")
}

pub const HELP: [(&str, &str); 23] = [
    ("W / S", "pitch down / up (sidestick)"),
    ("A / D", "roll left / right"),
    ("Q / E", "rudder / nosewheel"),
    ("Shift / Ctrl", "throttle up / down"),
    ("X / Z", "throttle idle / TOGA"),
    ("B", "wheel brakes (hold)"),
    ("T", "toggle parking brake"),
    ("G", "landing gear"),
    ("F / V", "flaps up / down"),
    ("Space", "speedbrake   R reverse thrust"),
    ("K / J", "arm ground spoilers / cycle autobrake"),
    ("P", "pause"),
    ("Tab", "autopilot on / off (auto take-off on runway)"),
    ("N / H", "LNAV / HDG mode      L  approach (LOC/GS)"),
    ("Up / Down", "FCU altitude +-100 ft   [ ]  speed"),
    ("Left / Right", "FCU heading -+5      PgUp/PgDn  V/S"),
    ("C", "camera: captain / panel / wing / chase / tower"),
    ("Mouse drag / Num 4 6 8 2", "look around     Num 5 centre"),
    ("Mouse wheel / Num + -", "zoom (chase: distance)"),
    ("F1", "this help"),
    ("F11", "fullscreen"),
    ("Esc", "menu / quit"),
    ("Enter", "start / restart"),
];

pub fn draw_help(ui: &mut Ui, base: f32) {
    let (w, h) = (ui.w, ui.h);
    let (pw, ph) = (base * 44.0, base * 27.5);
    let (x0, y0) = (w / 2.0 - pw / 2.0, h / 2.0 - ph / 2.0);
    ui.rect(x0, y0, pw, ph, [0.02, 0.03, 0.06, 0.94]);
    ui.frame(x0, y0, pw, ph, 2.0, C_CYAN);
    tf!(ui, w / 2.0, y0 + base * 0.5, base * 1.5, C_CYAN, 1, "CONTROLS");
    for (i, (k, d)) in HELP.iter().enumerate() {
        let y = y0 + base * 2.6 + i as f32 * base * 1.08;
        tf!(ui, x0 + base, y, base * 0.9, C_AMBER, 0, "{}", k);
        tf!(ui, x0 + base * 12.5, y, base * 0.9, C_WHITE, 0, "{}", d);
    }
}

pub struct MenuState {
    pub dep: String,
    pub arr: String,
    pub field: usize,
    pub msg: String,
    pub dep_name: String,
    pub arr_name: String,
}

pub fn draw_menu(ui: &mut Ui, m: &MenuState, time: f64, fps: f32) {
    let (w, h) = (ui.w, ui.h);
    let base = (h / 40.0).clamp(12.0, 30.0);
    let (pw, ph) = (base * 34.0, base * 25.0);
    let (x0, y0) = (w * 0.5 - pw / 2.0, h * 0.5 - ph / 2.0);
    ui.rect(x0, y0, pw, ph, [0.02, 0.03, 0.06, 0.92]);
    ui.frame(x0, y0, pw, ph, 2.0, C_CYAN);
    tf!(ui, w * 0.5, y0 + base * 0.7, base * 3.4, C_WHITE, 1, "IN-FLIGHT");
    tf!(ui, w * 0.5, y0 + base * 4.4, base * 1.0, C_GREY, 1, "A320-200 simulator  -  native Rust / wgpu");
    for (i, (label, val, name)) in [("DEPARTURE", &m.dep, &m.dep_name), ("ARRIVAL", &m.arr, &m.arr_name)].into_iter().enumerate() {
        let y = y0 + base * (7.0 + i as f32 * 4.6);
        tf!(ui, x0 + base * 1.5, y, base * 0.9, C_GREY, 0, "{}", label);
        let sel = m.field == i;
        ui.rect(x0 + base * 1.5, y + base * 1.1, base * 8.0, base * 1.9, if sel { [0.1, 0.2, 0.3, 1.0] } else { [0.06, 0.08, 0.12, 1.0] });
        ui.frame(x0 + base * 1.5, y + base * 1.1, base * 8.0, base * 1.9, 1.5, if sel { C_CYAN } else { C_GREY });
        let cursor = if sel && ((time * 2.0) as i64 % 2 == 0) { "_" } else { " " };
        tf!(ui, x0 + base * 2.0, y + base * 1.3, base * 1.5, C_WHITE, 0, "{}{}", val, cursor);
        tf!(ui, x0 + base * 10.5, y + base * 1.55, base * 1.0, if name.is_empty() { C_RED } else { C_GREEN }, 0, "{}", if name.is_empty() { "unknown airport" } else { name });
    }
    if !m.msg.is_empty() {
        tf!(ui, w * 0.5, y0 + base * 16.7, base * 1.0, C_AMBER, 1, "{}", m.msg);
    }
    tf!(ui, w * 0.5, y0 + base * 18.6, base * 1.0, C_WHITE, 1, "type ICAO / IATA   [TAB] switch field   [ENTER] start");
    tf!(ui, w * 0.5, y0 + base * 20.0, base * 0.9, C_GREY, 1, "presets: F2 KSFO>KOAK  F3 KLAX>KSAN  F4 EGLL>EGKK  F5 KJFK>KEWR  F6 EDDF>EDDM");
    tf!(ui, w * 0.5, y0 + base * 21.4, base * 0.9, C_GREY, 1, "F7 KSEA>KPDX  F8 LFPG>LFPO  F9 YSSY>YMML  [F1] controls  [ESC] quit");
    tf!(ui, w - 10.0, h - base * 1.6, base * 0.9, C_GREY, 2, "{:.0} FPS", fps);
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ui_line_quad_vertices() {
        let mut ui = Ui::new();
        ui.line([10.0, 10.0], [110.0, 10.0], 4.0, C_WHITE);
        assert_eq!(ui.verts.len(), 6);
        for v in &ui.verts {
            assert!(v.pos[1] >= 8.0 && v.pos[1] <= 12.0, "y coordinate {} outside expected bounds [8, 12]", v.pos[1]);
        }
    }
}
