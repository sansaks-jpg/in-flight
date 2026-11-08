//! Boot loader and the MSFS-style bento main menu (ports of `Loaders.tsx`, `Screens.tsx` and the tile layout of
//! `PreGameVisuals.tsx`). The menu hosts the live day/night globe on the right and five interactive tiles on the left.

use super::globe::{Globe, GlobeView, Marks};
use super::planner::PlannerState;
use super::{a320, alpha, mix, modals::Settings, thousands, Gui, ACCENT, AMBER, BG0, BG1, DIM, GREEN, LINE, LINE_HI, MUTED, PANEL, RED, TEXT};
use crate::airports::AirportDb;
use crate::clock::{hhmm, subsolar_point};
use std::collections::HashSet;

// ------------------------------------------------------------------------------------------------ boot loader

pub const BOOT_MIN_S: f64 = 1.6;
pub const BOOT_STAGES: usize = 5;

#[derive(Clone, Debug, Default)]
pub struct DbStats {
    pub airports: usize,
    pub runways: usize,
    pub countries: usize,
    pub indonesia: usize,
}

pub fn db_stats(db: &AirportDb) -> DbStats {
    let countries: HashSet<&str> = db.airports.iter().map(|a| a.country.as_str()).collect();
    DbStats {
        airports: db.airports.len(),
        runways: db.airports.iter().map(|a| a.runways.len()).sum(),
        countries: countries.len(),
        indonesia: db.airports.iter().filter(|a| a.country == "ID").count(),
    }
}

pub struct Boot {
    pub stage: usize,
    pub frames: u32,
    pub elapsed: f64,
    pub shown: f32,
    pub stats: DbStats,
    pub land_pct: f32,
    finishing_at: Option<f64>,
    tip: usize,
}

const TIPS: [&str; 5] = [
    "Drag the globe to spin it - the mouse wheel zooms, click an airport to select it",
    "C cycles cockpit / chase / tower cameras - P pauses the flight",
    "F1 shows every control - Tab toggles the autopilot, L arms the ILS approach",
    "The sun, sky and night lighting follow the real UTC clock",
    "Dispatch picks a semicircular cruise level and the runway into the wind",
];

impl Boot {
    pub fn new() -> Self {
        Self { stage: 0, frames: 0, elapsed: 0.0, shown: 0.0, stats: DbStats::default(), land_pct: 0.0, finishing_at: None, tip: 0 }
    }

    /// Performs the real start-up work of one stage (idempotent).
    fn run_stage(&mut self, stage: usize, db: &AirportDb, planner: &mut PlannerState) {
        match stage {
            1 => self.stats = db_stats(db),
            2 => {
                // touch the embedded land mask: coverage statistic shown in the loader
                let mut land = 0u32;
                for y in 0..90 {
                    for x in 0..180 {
                        if super::globe::is_land(90.0 - (y as f64 + 0.5) * 2.0, -180.0 + (x as f64 + 0.5) * 2.0) {
                            land += 1;
                        }
                    }
                }
                self.land_pct = land as f32 / (90.0 * 180.0) * 100.0;
            }
            3 => planner.build_index(db),
            _ => {}
        }
    }

    pub fn fast_forward(&mut self, db: &AirportDb, _globe: &mut Globe, planner: &mut PlannerState) {
        for s in self.stage..BOOT_STAGES {
            self.run_stage(s, db, planner);
        }
        self.stage = BOOT_STAGES;
        self.shown = 1.0;
    }

    pub fn progress_target(&self) -> f32 {
        if self.finishing_at.is_some() {
            return 1.0;
        }
        let real = self.stage as f32 / BOOT_STAGES as f32;
        let creep = (self.elapsed as f32 / 14.0).min(0.12);
        real.max(creep).min(0.98)
    }
}

impl Default for Boot {
    fn default() -> Self {
        Self::new()
    }
}

fn stars(g: &mut Gui, t: f64, density: usize) {
    let (w, h) = (g.vw, g.vh);
    let mut seed = 0x1234_5678u32;
    for i in 0..density {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let x = (seed >> 8) as f32 / 16_777_216.0 * w;
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let y = (seed >> 8) as f32 / 16_777_216.0 * h;
        let tw = 0.5 + 0.5 * ((t as f32) * (0.6 + (i % 7) as f32 * 0.25) + i as f32).sin();
        let sz = if i % 11 == 0 { 1.6 } else { 1.0 };
        g.rect(x, y, sz, sz, [0.8, 0.9, 1.0, 0.10 + 0.35 * tw * if i % 5 == 0 { 1.0 } else { 0.5 }]);
    }
}

/// Draws the boot screen; returns true once it has faded out completely.
pub fn draw_boot(g: &mut Gui, boot: &mut Boot, db: &AirportDb, globe: &mut Globe, planner: &mut PlannerState, dt: f64) -> bool {
    let _ = globe;
    boot.elapsed += dt;
    boot.frames += 1;
    // advance one stage per frame, spaced in time so each row is visible for a moment
    if boot.stage < BOOT_STAGES && boot.elapsed >= boot.stage as f64 * 0.26 && (boot.stage < 4 || boot.frames >= 10) {
        let s = boot.stage;
        boot.run_stage(s, db, planner);
        boot.stage += 1;
    }
    if boot.stage >= BOOT_STAGES && boot.elapsed >= BOOT_MIN_S && boot.finishing_at.is_none() {
        boot.finishing_at = Some(boot.elapsed);
    }
    boot.tip = ((boot.elapsed / 4.6) as usize) % TIPS.len();
    // smoothed progress (never backwards)
    let target = boot.progress_target();
    let k = 1.0 - (-(dt as f32) * 4.2).exp();
    boot.shown = (boot.shown + (target - boot.shown) * k).max(boot.shown);
    if target - boot.shown < 0.0025 {
        boot.shown = target;
    }
    let leave = boot.finishing_at.map_or(0.0, |t| ((boot.elapsed - t - 0.42) / 0.5).clamp(0.0, 1.0)) as f32;

    let (w, h) = (g.vw, g.vh);
    g.rect_v(0.0, 0.0, w, h, BG1, BG0);
    stars(g, g.time, 120);

    // header
    g.text(36.0, 28.0, 15.0, TEXT, 0, "IN-FLIGHT");
    g.rect(24.0, 28.0, 4.0, 14.0, ACCENT);
    g.text(w - 36.0, 24.0, 13.0, TEXT, 2, "Airbus A320-200");
    g.text(w - 36.0, 41.0, 10.5, DIM, 2, "CFM56-5B  -  twin-engine narrow-body");

    // radar + aircraft
    let cx = w * 0.30;
    let cy = h * 0.50;
    let r = (h * 0.34).min(w * 0.22);
    for (i, f) in [1.0f32, 0.68, 0.36].iter().enumerate() {
        g.ring([cx, cy], r * f, 1.0, alpha(ACCENT, 0.16 + 0.03 * i as f32));
    }
    g.line([cx - r, cy], [cx + r, cy], 1.0, alpha(ACCENT, 0.12));
    g.line([cx, cy - r], [cx, cy + r], 1.0, alpha(ACCENT, 0.12));
    g.text(cx, cy - r - 18.0, 11.0, DIM, 1, "N");
    g.text(cx, cy + r + 6.0, 11.0, DIM, 1, "S");
    // rotating sweep wedge
    let sweep = (g.time as f32 * 1.6) % std::f32::consts::TAU;
    for i in 0..24 {
        let (a0, a1) = (sweep - i as f32 * 0.035, sweep - (i + 1) as f32 * 0.035);
        let a = alpha(ACCENT, 0.22 * (1.0 - i as f32 / 24.0));
        let (p0, p1) = ([cx + a0.cos() * r, cy + a0.sin() * r], [cx + a1.cos() * r, cy + a1.sin() * r]);
        let s = g.s;
        g.ui.tri([cx * s, cy * s], [p0[0] * s, p0[1] * s], [p1[0] * s, p1[1] * s], a);
    }
    let pw = r * 1.75;
    a320::draw(g, cx - pw / 2.0, cy - pw * a320::ASPECT / 2.0, pw, boot.shown, None);

    // right column
    let x = w * 0.54;
    let colw = (w - x - 48.0).min(520.0);
    let top = h * 0.5 - 150.0;
    g.text(x, top, 11.0, ACCENT, 0, "STARTING SIMULATOR");
    g.text(x, top + 20.0, 52.0, TEXT, 0, "IN-FLIGHT");
    g.text(x, top + 82.0, 12.0, DIM, 0, "Airbus A320-200 - native Rust / wgpu - 8,400+ real airports");
    // bar
    let by = top + 112.0;
    g.rect(x, by, colw, 6.0, [1.0, 1.0, 1.0, 0.10]);
    g.rect_h(x, by, (colw * boot.shown.max(0.012)).min(colw), 6.0, mix(ACCENT, [0.2, 0.4, 1.0, 1.0], 0.0), [0.55, 0.85, 1.0, 1.0]);
    let status = if boot.finishing_at.is_some() {
        "Welcome aboard"
    } else {
        match boot.stage {
            0 => "Initialising graphics and flight model...",
            1 => "Indexing airport and runway database...",
            2 => "Building Earth model and night lights...",
            3 => "Building airport search index...",
            _ => "Compiling shaders and warming the GPU...",
        }
    };
    g.text(x, by + 14.0, 12.0, TEXT, 0, status);
    g.textf(x + colw, by + 14.0, 12.0, ACCENT, 2, format_args!("{}%", (boot.shown * 100.0).round() as u32));

    let rows: [(&str, String); 5] = [
        ("Simulator core", "wgpu 30 - winit 0.30".to_string()),
        ("Airport database", format!("{} airports - {} runways", thousands(boot.stats.airports), thousands(boot.stats.runways))),
        ("Earth model & night lights", format!("{:.0}% land mask", boot.land_pct)),
        ("Airport search index", format!("{} countries", boot.stats.countries)),
        ("Graphics pipeline - shaders & fonts", String::new()),
    ];
    for (i, (label, detail)) in rows.iter().enumerate() {
        let y = by + 46.0 + i as f32 * 26.0;
        let done = i < boot.stage || boot.finishing_at.is_some();
        let active = i == boot.stage;
        let (dot, tc) = if done { (GREEN, TEXT) } else if active { (ACCENT, TEXT) } else { (MUTED, MUTED) };
        let pulse = if active { 0.6 + 0.4 * (g.time as f32 * 6.0).sin() } else { 1.0 };
        g.disc([x + 5.0, y + 7.0], 4.0, alpha(dot, pulse));
        g.text(x + 20.0, y, 12.5, tc, 0, label);
        if done && !detail.is_empty() {
            g.text(x + colw, y, 11.0, DIM, 2, detail);
        } else if done {
            g.text(x + colw, y, 11.0, DIM, 2, "ready");
        }
    }

    // footer
    g.text(36.0, h - 44.0, 12.0, DIM, 0, TIPS[boot.tip]);
    g.text(w - 36.0, h - 44.0, 11.0, MUTED, 2, "37.57 m long - 34.10 m span - 11.76 m high");
    if leave > 0.0 {
        g.rect(0.0, 0.0, w, h, [0.0, 0.0, 0.0, leave]);
    }
    boot.finishing_at.is_some() && leave >= 1.0
}

// ------------------------------------------------------------------------------------------------ main menu

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MenuAction {
    None,
    Planner,
    FreeFlight,
    Settings,
    Logbook,
    Controls,
    Quit,
}

#[derive(Clone, Copy)]
enum Art {
    Planner,
    Free,
    Settings,
    Logbook,
    Controls,
}

#[allow(clippy::too_many_arguments)]
fn tile(g: &mut Gui, x: f32, y: f32, w: f32, h: f32, art: Art, title: &str, subtitle: &str, badge: Option<&str>, title_size: f32) -> bool {
    let hov = g.hover(x, y, w, h);
    let grow = if hov { 1.5 } else { 0.0 };
    let t = g.time as f32;
    g.scissor(Some([x, y, w, h]));
    draw_art(g, art, x - grow, y - grow, w + grow * 2.0, h + grow * 2.0, t, hov);
    // legibility gradients
    g.rect_v(x, y, w, h, [0.0, 0.01, 0.03, 0.45], [0.0, 0.01, 0.03, 0.05]);
    g.rect_v(x, y + h * 0.45, w, h * 0.55, [0.0, 0.0, 0.0, 0.0], [0.0, 0.01, 0.03, 0.78]);
    if hov {
        g.rect(x, y, w, h, [1.0, 1.0, 1.0, 0.06]);
    }
    g.scissor(None);
    g.frame(x, y, w, h, if hov { 2.0 } else { 1.0 }, if hov { LINE_HI } else { [1.0, 1.0, 1.0, 0.22] });
    g.text(x + 12.0, y + 10.0, title_size, TEXT, 0, title);
    if let Some(b) = badge {
        g.text(x + 12.0, y + h - 36.0, 9.5, AMBER, 0, b);
    }
    g.text(x + 12.0, y + h - 20.0, 10.5, [0.9, 0.94, 1.0, 0.95], 0, subtitle);
    g.clicked(x, y, w, h)
}

fn draw_art(g: &mut Gui, art: Art, x: f32, y: f32, w: f32, h: f32, t: f32, hov: bool) {
    match art {
        Art::Planner => {
            g.rect_h(x, y, w, h, [0.03, 0.12, 0.26, 1.0], [0.05, 0.28, 0.42, 1.0]);
            for i in 0..14 {
                let gx = x + i as f32 * w / 13.0;
                g.line([gx, y], [gx, y + h], 1.0, [1.0, 1.0, 1.0, 0.045]);
            }
            for i in 0..5 {
                let gy = y + i as f32 * h / 4.0;
                g.line([x, gy], [x + w, gy], 1.0, [1.0, 1.0, 1.0, 0.045]);
            }
            // great-circle arc between two "airports"
            let (a, b) = ([x + w * 0.58, y + h * 0.72], [x + w * 0.92, y + h * 0.34]);
            let mut pts = [[0.0f32; 2]; 25];
            for (i, p) in pts.iter_mut().enumerate() {
                let u = i as f32 / 24.0;
                *p = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u - (std::f32::consts::PI * u).sin() * h * 0.28];
            }
            g.polyline(&pts, 1.6, [0.9, 0.5, 1.0, 0.9]);
            let m = ((t * 0.5) % 1.0) * 24.0;
            g.disc(pts[m as usize], 3.0, TEXT);
            g.disc(a, 4.0, ACCENT);
            g.disc(b, 4.0, [1.0, 0.45, 0.95, 1.0]);
            if hov {
                g.ring(a, 8.0, 1.5, ACCENT);
            }
        }
        Art::Free => {
            g.rect_v(x, y, w, h * 0.62, [0.10, 0.12, 0.34, 1.0], [0.95, 0.52, 0.28, 1.0]);
            g.rect(x, y + h * 0.62, w, h * 0.38, [0.06, 0.07, 0.10, 1.0]);
            g.disc([x + w * 0.74, y + h * 0.62], 16.0, [1.0, 0.85, 0.5, 0.95]);
            // runway in perspective
            let vp = [x + w * 0.5, y + h * 0.62];
            g.polygon(&[vp, [vp[0] + w * 0.04, vp[1]], [x + w * 0.78, y + h], [x + w * 0.22, y + h], [vp[0] - w * 0.04, vp[1]]], [0.13, 0.14, 0.17, 1.0]);
            for i in 0..6 {
                let u = ((i as f32 + (t * 0.8) % 1.0) / 6.0).min(1.0);
                let yy = vp[1] + (h * 0.38) * u * u;
                g.rect(vp[0] - 1.0 - u * 3.0, yy, 2.0 + u * 6.0, 2.0 + u * 8.0, [1.0, 1.0, 1.0, 0.85]);
            }
        }
        Art::Settings => {
            g.rect_v(x, y, w, h, [0.05, 0.20, 0.24, 1.0], [0.03, 0.09, 0.16, 1.0]);
            for i in 0..4 {
                let yy = y + h * (0.30 + i as f32 * 0.14);
                g.rect(x + w * 0.16, yy, w * 0.68, 3.0, [1.0, 1.0, 1.0, 0.18]);
                let kx = x + w * (0.22 + 0.5 * (0.5 + 0.5 * (t * 0.6 + i as f32 * 1.7).sin()) * if hov { 1.0 } else { 0.8 });
                g.rect(x + w * 0.16, yy, kx - x - w * 0.16, 3.0, ACCENT);
                g.rect(kx - 4.0, yy - 5.0, 8.0, 13.0, TEXT);
            }
        }
        Art::Logbook => {
            g.rect_v(x, y, w, h, [0.34, 0.20, 0.10, 1.0], [0.12, 0.08, 0.07, 1.0]);
            let (bx, by, bw, bh) = (x + w * 0.2, y + h * 0.16, w * 0.6, h * 0.5);
            g.rect(bx, by, bw, bh, [0.93, 0.89, 0.80, 0.96]);
            g.rect(bx + bw * 0.5 - 1.0, by, 2.0, bh, [0.55, 0.45, 0.33, 1.0]);
            for i in 0..6 {
                let ly = by + 10.0 + i as f32 * (bh - 18.0) / 6.0;
                g.rect(bx + 8.0, ly, bw * 0.5 - 16.0, 1.5, [0.45, 0.4, 0.35, 0.8]);
                g.rect(bx + bw * 0.5 + 8.0, ly, bw * 0.5 - 16.0, 1.5, [0.45, 0.4, 0.35, 0.8]);
            }
            g.rect(bx + bw - 30.0, by - 4.0, 8.0, bh * 0.5, RED);
        }
        Art::Controls => {
            g.rect_v(x, y, w, h, [0.12, 0.16, 0.22, 1.0], [0.05, 0.07, 0.11, 1.0]);
            let keys = [("W", 1, 0), ("A", 0, 1), ("S", 1, 1), ("D", 2, 1)];
            let (kx, ky, ks) = (x + w * 0.5 - 51.0, y + h * 0.18, 32.0);
            for (l, cx, cy) in keys {
                let (px, py) = (kx + cx as f32 * (ks + 4.0), ky + cy as f32 * (ks + 4.0));
                let press = hov && ((t * 1.5) as i32 % 4) == (cx + cy * 2) % 4;
                g.rect(px, py + if press { 2.0 } else { 0.0 }, ks, ks, [0.85, 0.9, 0.97, 0.95]);
                g.rect(px, py + ks - 4.0, ks, 4.0, [0.45, 0.52, 0.62, 1.0]);
                g.text(px + ks / 2.0, py + 8.0 + if press { 2.0 } else { 0.0 }, 14.0, [0.08, 0.1, 0.16, 1.0], 1, l);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn draw_menu(g: &mut Gui, globe: &mut Globe, db: &AirportDb, utc: f64, dt: f64, fps: f32, settings: &Settings, log_count: usize, _started: bool) -> MenuAction {
    let (w, h) = (g.vw, g.vh);
    let mut act = MenuAction::None;
    g.rect_v(0.0, 0.0, w, h, BG1, BG0);
    // radial glow behind the globe
    let (gcx, gcy) = (w * 0.67, h * 0.50);
    let s = g.s;
    g.ui.disc_g([gcx * s, gcy * s], h * 0.62 * s, 40, [0.06, 0.16, 0.34, 0.55], [0.0, 0.0, 0.0, 0.0]);
    stars(g, g.time, 150);

    let view = GlobeView { cx: gcx, cy: gcy, r: h * 0.36, clip: [600.0, 32.0, (w - 600.0).max(100.0), h - 64.0] };
    globe.run(g, view, utc, db, Marks::default(), true, dt);

    // left contrast vignette so the bento grid always has crisp contrast
    g.rect_h(0.0, 0.0, 680.0, h, [0.008, 0.016, 0.035, 0.94], [0.008, 0.016, 0.035, 0.80]);
    g.rect_h(680.0, 0.0, 120.0, h, [0.008, 0.016, 0.035, 0.80], [0.008, 0.016, 0.035, 0.0]);

    // top-right pilot banner
    let (hh, mm) = hhmm(utc);
    let bar_w = 560.0;
    g.rect(w - bar_w, 0.0, bar_w, 32.0, [0.04, 0.06, 0.09, 0.92]);
    g.line([w - bar_w, 32.0], [w, 32.0], 1.0, LINE);
    g.text(w - bar_w + 12.0, 10.0, 11.0, TEXT, 0, "IN-FLIGHT");
    g.textf(w - bar_w + 96.0, 10.0, 11.0, ACCENT, 0, format_args!("{} AIRPORTS", thousands(db.airports.len())));
    g.textf(w - bar_w + 240.0, 10.0, 11.0, GREEN, 0, format_args!("{} INDONESIA", db.airports.iter().filter(|a| a.country == "ID").count()));
    g.textf(w - 120.0, 10.0, 11.0, DIM, 2, format_args!("CAPT. {}", settings.name.to_uppercase()));
    g.textf(w - 56.0, 10.0, 11.0, TEXT, 2, format_args!("{hh:02}:{mm:02}Z"));
    if g.btn(w - 40.0, 4.0, 34.0, 24.0, "X", super::BtnKind::Ghost) {
        act = MenuAction::Quit;
    }

    // ---------------- bento grid (1 banner + 2 asymmetric columns)
    let (gx, gw, gap) = (44.0f32, 530.0f32, 10.0f32);
    let (h_banner, h_short, h_tall) = (112.0, 112.0, 176.0);
    let total = h_banner + gap + h_short + gap + h_tall;
    let gy = ((h - total) * 0.5).max(48.0);
    g.text(gx, gy - 38.0, 24.0, TEXT, 0, "IN-FLIGHT");
    g.text(gx, gy - 12.0, 10.5, DIM, 0, "AIRBUS A320-200  -  PRE-FLIGHT HUB");
    let col_w = (gw - gap) * 0.5;
    if tile(g, gx, gy, gw, h_banner, Art::Planner, "Flight Planner", "8,413 real airports - search, route briefing, runway diagrams", Some("GLOBE - TERMINATOR - DISPATCH"), 20.0) {
        act = MenuAction::Planner;
    }
    let y2 = gy + h_banner + gap;
    let free_sub = "Quick dispatch - start on the runway";
    if tile(g, gx, y2, col_w, h_short, Art::Free, "Free Flight", free_sub, None, 16.0) {
        act = MenuAction::FreeFlight;
    }
    if tile(g, gx, y2 + h_short + gap, col_w, h_tall, Art::Settings, "Settings", "Graphics - audio - flight assist", Some("FOV - VOLUME - UNITS"), 16.0) {
        act = MenuAction::Settings;
    }
    let x2 = gx + col_w + gap;
    let mut sub = String::new();
    {
        use std::fmt::Write;
        let _ = write!(sub, "Pilot Logbook - {log_count} flights");
    }
    if tile(g, x2, y2, col_w, h_tall, Art::Logbook, "Logbook", &sub, Some("TOUCHDOWN GRADES"), 16.0) {
        act = MenuAction::Logbook;
    }
    if tile(g, x2, y2 + h_tall + gap, col_w, h_short, Art::Controls, "Controls", "Keyboard reference - F1", None, 16.0) {
        act = MenuAction::Controls;
    }

    // ---------------- bottom bar
    let by = h - 28.0;
    g.line([0.0, by - 6.0], [w, by - 6.0], 1.0, [1.0, 1.0, 1.0, 0.06]);
    g.text(24.0, by + 2.0, 10.5, MUTED, 0, "Drag the globe - Wheel zoom - Enter: Flight Planner - F1: controls - Esc: quit");
    let (sl, so) = subsolar_point(utc);
    g.textf(w - 24.0, by + 2.0, 10.5, DIM, 2, format_args!("SUN OVERHEAD {:.1}{} {:.1}{}", sl.abs(), if sl >= 0.0 { "N" } else { "S" }, so.abs(), if so >= 0.0 { "E" } else { "W" }));
    let ok = fps >= 55.0 || fps == 0.0;
    let pill = if ok { GREEN } else { AMBER };
    let (pw, px, py) = (118.0, w * 0.5 - 59.0, by - 3.0);
    g.rect(px, py, pw, 20.0, alpha(pill, 0.14));
    g.frame(px, py, pw, 20.0, 1.0, alpha(pill, 0.6));
    g.disc([px + 11.0, py + 10.0], 3.5, pill);
    g.textf(px + 22.0, py + 5.0, 10.0, pill, 0, format_args!("{:.0} FPS {}", fps, if ok { "READY" } else { "LOW" }));
    let _ = (PANEL, LINE);

    if g.inp.key(super::Key::Enter) && !g.block {
        act = MenuAction::Planner;
    }
    act
}

// ------------------------------------------------------------------------------------------------ flight loader

/// Loading scene shown while a flight is being built (port of `FlightLoader`): route headline over the A320 plan with a
/// real progress bar and checklist (`stage` 0..=4 = rows completed).
pub fn draw_flight_loader(g: &mut Gui, dep: &crate::airports::Airport, arr: &crate::airports::Airport, progress: f32, stage: usize, detail: &str) {
    let (w, h) = (g.vw, g.vh);
    g.rect_v(0.0, 0.0, w, h, BG1, BG0);
    stars(g, g.time, 100);
    g.rect(24.0, 28.0, 4.0, 14.0, ACCENT);
    g.text(36.0, 28.0, 15.0, TEXT, 0, "IN-FLIGHT");
    let cx = w * 0.30;
    let cy = h * 0.5;
    let r = (h * 0.34).min(w * 0.22);
    for f in [1.0f32, 0.68, 0.36] {
        g.ring([cx, cy], r * f, 1.0, alpha(ACCENT, 0.18));
    }
    let pw = r * 1.75;
    a320::draw(g, cx - pw / 2.0, cy - pw * a320::ASPECT / 2.0, pw, progress, None);
    let x = w * 0.54;
    let colw = (w - x - 48.0).min(520.0);
    let top = h * 0.5 - 140.0;
    g.text(x, top, 11.0, ACCENT, 0, "PREPARING FLIGHT DISPATCH");
    g.text(x, top + 20.0, 44.0, TEXT, 0, &dep.icao);
    g.text(x + 4.0 * 26.5 + 24.0, top + 28.0, 28.0, MUTED, 0, ">");
    g.text(x + 4.0 * 26.5 + 70.0, top + 20.0, 44.0, ACCENT, 0, &arr.icao);
    let from: String = if dep.city.is_empty() { dep.name.clone() } else { dep.city.clone() };
    let to: String = if arr.city.is_empty() { arr.name.clone() } else { arr.city.clone() };
    g.textf(x, top + 76.0, 12.0, DIM, 0, format_args!("{from} > {to}"));
    let by = top + 104.0;
    g.rect(x, by, colw, 6.0, [1.0, 1.0, 1.0, 0.10]);
    g.rect_h(x, by, (colw * progress.clamp(0.012, 1.0)).min(colw), 6.0, ACCENT, [0.55, 0.85, 1.0, 1.0]);
    g.text(x, by + 14.0, 12.0, TEXT, 0, detail);
    g.textf(x + colw, by + 14.0, 12.0, ACCENT, 2, format_args!("{}%", (progress * 100.0).round() as u32));
    let rows = ["Dispatch & airfield survey", "Weather - simulated METAR", "Terrain, runways & scenery", "Flight model & autopilot", "Graphics pipeline - shaders & fonts"];
    for (i, l) in rows.iter().enumerate() {
        let y = by + 44.0 + i as f32 * 26.0;
        let (dot, tc) = if i < stage { (GREEN, TEXT) } else if i == stage { (ACCENT, TEXT) } else { (MUTED, MUTED) };
        g.disc([x + 5.0, y + 7.0], 4.0, dot);
        g.text(x + 20.0, y, 12.5, tc, 0, l);
        if i < stage {
            g.text(x + colw, y, 11.0, DIM, 2, "ready");
        }
    }
}
