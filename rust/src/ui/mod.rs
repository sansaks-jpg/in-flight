//! Pre-flight UI/UX (native port of `src/ui/*.tsx`): boot loader, MSFS bento main menu, interactive day/night globe,
//! airport search + filters, flight planner / A320 route briefing and the modal windows (settings, controls, logbook).
//!
//! Everything is an immediate-mode screen drawn through the existing 2D batch renderer ([`crate::gfx::ui::Ui`]); there is
//! no GPU or windowing dependency in here, so the whole flow is unit-testable and can be rasterised headlessly
//! (`cargo run --release --bin uishots`). The winit front-end (`app.rs`) only feeds an [`Input`] snapshot per frame.
//!
//! Module map:
//! * [`dispatch`] – pure route maths: distance, ETE, block fuel, semicircular cruise FL, TOD, wind components.
//! * [`globe`]    – orthographic 3D globe: land mask, NOAA terminator, fly-to camera (port of `globeCamera.ts`).
//! * [`a320`]     – vector plan view of the A320-200 (port of `A320Plan.tsx`).
//! * [`screens`]  – boot loader + bento main menu (`Loaders.tsx`, `Screens.tsx`, `PreGameVisuals.tsx`).
//! * [`planner`]  – airport search/filter, region quick-picks, curated routes, briefing (`Planner.tsx`, `A320Plan`).
//! * [`map`]      – Mercator route map, runway vector diagram, airport mini-map (`MapPanel.tsx`, `AirportMiniMap.tsx`).
//! * [`raster`]   – CPU rasteriser of the UI batch for GPU-less screenshots and pixel tests.
//! * [`modals`]   – settings, controls and logbook windows (`MsfsWindows.tsx`, `SettingsPanels.tsx`).

pub mod a320;
pub mod dispatch;
pub mod globe;
pub mod map;
pub mod market;
pub mod modals;
pub mod planner;
pub mod raster;
pub mod screens;

use crate::airports::AirportDb;
use crate::gfx::ui::{Col, Ui};

// ------------------------------------------------------------------------------------------------ palette

pub const BG0: Col = [0.004, 0.012, 0.03, 1.0];
pub const BG1: Col = [0.02, 0.05, 0.11, 1.0];
pub const PANEL: Col = [0.035, 0.055, 0.09, 0.93];
pub const PANEL_HI: Col = [0.07, 0.10, 0.16, 0.95];
pub const LINE: Col = [1.0, 1.0, 1.0, 0.16];
pub const LINE_HI: Col = [1.0, 1.0, 1.0, 0.72];
pub const TEXT: Col = [0.93, 0.96, 1.0, 1.0];
pub const DIM: Col = [0.60, 0.67, 0.76, 1.0];
pub const MUTED: Col = [0.38, 0.45, 0.55, 1.0];
pub const ACCENT: Col = [0.24, 0.72, 1.0, 1.0];
pub const AMBER: Col = [1.0, 0.76, 0.22, 1.0];
pub const GREEN: Col = [0.30, 0.92, 0.55, 1.0];
pub const RED: Col = [1.0, 0.32, 0.28, 1.0];
pub const MAGENTA: Col = [1.0, 0.45, 0.95, 1.0];

pub fn alpha(c: Col, a: f32) -> Col {
    [c[0], c[1], c[2], c[3] * a]
}
pub fn mix(a: Col, b: Col, t: f32) -> Col {
    let t = t.clamp(0.0, 1.0);
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]
}

/// 8413 -> "8,413".
pub fn thousands(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

// ------------------------------------------------------------------------------------------------ input

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Key {
    Enter,
    Escape,
    Backspace,
    Delete,
    Tab,
    Up,
    Down,
    Left,
    Right,
    PageUp,
    PageDown,
    F(u8),
}

/// Per-frame input snapshot in physical pixels (filled by the winit front-end or by tests).
#[derive(Default, Clone)]
pub struct Input {
    pub mouse: [f32; 2],
    pub delta: [f32; 2],
    pub down: bool,
    pub pressed: bool,
    pub released: bool,
    pub right_down: bool,
    pub wheel: f32,
    pub typed: String,
    pub keys: Vec<Key>,
}

impl Input {
    pub fn key(&self, k: Key) -> bool {
        self.keys.contains(&k)
    }
    /// Clears the per-frame edges (called by the owner after each frame).
    pub fn end_frame(&mut self) {
        self.pressed = false;
        self.released = false;
        self.wheel = 0.0;
        self.delta = [0.0, 0.0];
        self.typed.clear();
        self.keys.clear();
    }
}

// ------------------------------------------------------------------------------------------------ gui wrapper

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum BtnKind {
    Primary,
    Secondary,
    Ghost,
    Danger,
}

/// Immediate-mode drawing + hit-testing in *virtual* pixels (the layout is authored for ~1280x720 and scaled by `s`).
pub struct Gui<'a> {
    pub ui: &'a mut Ui,
    pub inp: &'a Input,
    pub s: f32,
    pub vw: f32,
    pub vh: f32,
    /// when true, widgets ignore the mouse (a modal window is on top)
    pub block: bool,
    /// ignore the left-click edge this frame (see `PreFlight::frame`)
    pub mute_click: bool,
    pub time: f64,
}

impl<'a> Gui<'a> {
    pub fn new(ui: &'a mut Ui, inp: &'a Input, time: f64) -> Self {
        let s = (ui.h / 720.0).min(ui.w / 1100.0).clamp(0.5, 3.0);
        let (vw, vh) = (ui.w / s, ui.h / s);
        Self { ui, inp, s, vw, vh, block: false, mute_click: false, time }
    }
    pub fn mouse(&self) -> [f32; 2] {
        [self.inp.mouse[0] / self.s, self.inp.mouse[1] / self.s]
    }
    pub fn hover(&self, x: f32, y: f32, w: f32, h: f32) -> bool {
        if self.block {
            return false;
        }
        let m = self.mouse();
        m[0] >= x && m[0] < x + w && m[1] >= y && m[1] < y + h
    }
    pub fn pressed(&self) -> bool {
        self.inp.pressed && !self.mute_click
    }
    pub fn clicked(&self, x: f32, y: f32, w: f32, h: f32) -> bool {
        self.pressed() && self.hover(x, y, w, h)
    }

    pub fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, c: Col) {
        let s = self.s;
        self.ui.rect(x * s, y * s, w * s, h * s, c);
    }
    pub fn rect_v(&mut self, x: f32, y: f32, w: f32, h: f32, top: Col, bottom: Col) {
        let s = self.s;
        self.ui.rect_v(x * s, y * s, w * s, h * s, top, bottom);
    }
    pub fn rect_h(&mut self, x: f32, y: f32, w: f32, h: f32, l: Col, r: Col) {
        let s = self.s;
        self.ui.rect_h(x * s, y * s, w * s, h * s, l, r);
    }
    pub fn frame(&mut self, x: f32, y: f32, w: f32, h: f32, t: f32, c: Col) {
        let s = self.s;
        self.ui.frame(x * s, y * s, w * s, h * s, (t * s).max(1.0), c);
    }
    pub fn line(&mut self, a: [f32; 2], b: [f32; 2], th: f32, c: Col) {
        let s = self.s;
        self.ui.line([a[0] * s, a[1] * s], [b[0] * s, b[1] * s], (th * s).max(1.0), c);
    }
    pub fn disc(&mut self, c: [f32; 2], r: f32, col: Col) {
        let s = self.s;
        self.ui.disc([c[0] * s, c[1] * s], r * s, 20, col);
    }
    pub fn ring(&mut self, c: [f32; 2], r: f32, th: f32, col: Col) {
        let s = self.s;
        self.ui.ring([c[0] * s, c[1] * s], r * s, (th * s).max(1.0), 40, col);
    }
    pub fn polygon(&mut self, pts: &[[f32; 2]], c: Col) {
        let s = self.s;
        let mut buf = [[0.0f32; 2]; 64];
        let n = pts.len().min(64);
        for i in 0..n {
            buf[i] = [pts[i][0] * s, pts[i][1] * s];
        }
        self.ui.polygon(&buf[..n], c);
    }
    pub fn polyline(&mut self, pts: &[[f32; 2]], th: f32, c: Col) {
        for w in pts.windows(2) {
            self.line(w[0], w[1], th, c);
        }
    }
    pub fn scissor(&mut self, r: Option<[f32; 4]>) {
        let s = self.s;
        self.ui.scissor(r.map(|[x, y, w, h]| [x * s, y * s, w * s, h * s]));
    }
    /// Text with its top-left (or centre / right per `align`) at virtual (x, y). `size` is the em height.
    pub fn text(&mut self, x: f32, y: f32, size: f32, c: Col, align: u8, t: &str) {
        let s = self.s;
        self.ui.text_a(x * s, y * s, size * s, c, align, t);
    }
    pub fn textf(&mut self, x: f32, y: f32, size: f32, c: Col, align: u8, args: std::fmt::Arguments) {
        let s = self.s;
        self.ui.textf(x * s, y * s, size * s, c, align, args);
    }
    pub fn text_w(&self, size: f32, n: usize) -> f32 {
        Ui::text_width(size, n)
    }

    /// Glass panel with a hairline border.
    pub fn panel(&mut self, x: f32, y: f32, w: f32, h: f32) {
        self.rect(x, y, w, h, PANEL);
        self.frame(x, y, w, h, 1.0, LINE);
    }

    /// Rectangular button. Returns true when clicked this frame.
    pub fn btn(&mut self, x: f32, y: f32, w: f32, h: f32, label: &str, kind: BtnKind) -> bool {
        let hov = self.hover(x, y, w, h);
        let (fill, border, txt) = match kind {
            BtnKind::Primary => (if hov { [0.35, 0.80, 1.0, 1.0] } else { ACCENT }, ACCENT, [0.01, 0.05, 0.1, 1.0]),
            BtnKind::Danger => (if hov { [0.9, 0.25, 0.2, 1.0] } else { [0.7, 0.18, 0.16, 1.0] }, RED, TEXT),
            BtnKind::Secondary => (if hov { PANEL_HI } else { PANEL }, if hov { LINE_HI } else { [1.0, 1.0, 1.0, 0.32] }, TEXT),
            BtnKind::Ghost => (if hov { [1.0, 1.0, 1.0, 0.10] } else { [1.0, 1.0, 1.0, 0.0] }, if hov { LINE_HI } else { LINE }, if hov { TEXT } else { DIM }),
        };
        self.rect(x, y, w, h, fill);
        self.frame(x, y, w, h, 1.0, border);
        let size = (h * 0.42).min(15.0);
        self.text(x + w * 0.5, y + (h - size) * 0.5, size, txt, 1, label);
        self.clicked(x, y, w, h)
    }

    /// Toggle chip (filters). Returns true when clicked.
    pub fn chip(&mut self, x: f32, y: f32, w: f32, h: f32, label: &str, on: bool) -> bool {
        let hov = self.hover(x, y, w, h);
        let fill = if on { alpha(ACCENT, 0.22) } else if hov { [1.0, 1.0, 1.0, 0.08] } else { [1.0, 1.0, 1.0, 0.03] };
        self.rect(x, y, w, h, fill);
        self.frame(x, y, w, h, 1.0, if on { ACCENT } else if hov { LINE_HI } else { LINE });
        let size = (h * 0.46).min(12.5);
        self.text(x + w * 0.5, y + (h - size) * 0.5, size, if on { TEXT } else { DIM }, 1, label);
        self.clicked(x, y, w, h)
    }

    /// Pill switch; returns the new value.
    pub fn switch(&mut self, x: f32, y: f32, on: bool) -> bool {
        let (w, h) = (38.0, 20.0);
        let hov = self.hover(x, y, w, h);
        self.rect(x, y, w, h, if on { alpha(ACCENT, if hov { 1.0 } else { 0.85 }) } else { [1.0, 1.0, 1.0, if hov { 0.22 } else { 0.14 }] });
        let kx = if on { x + w - h + 2.0 } else { x + 2.0 };
        self.rect(kx, y + 2.0, h - 4.0, h - 4.0, if on { [0.02, 0.06, 0.12, 1.0] } else { TEXT });
        if self.clicked(x, y, w, h) {
            !on
        } else {
            on
        }
    }

    /// Horizontal slider; returns the new value.
    pub fn slider(&mut self, x: f32, y: f32, w: f32, v: f32, lo: f32, hi: f32) -> f32 {
        let t = ((v - lo) / (hi - lo)).clamp(0.0, 1.0);
        let hov = self.hover(x - 6.0, y - 8.0, w + 12.0, 22.0);
        self.rect(x, y + 5.0, w, 4.0, [1.0, 1.0, 1.0, 0.16]);
        self.rect(x, y + 5.0, w * t, 4.0, ACCENT);
        self.rect(x + w * t - 5.0, y + 1.0, 10.0, 12.0, if hov { [1.0, 1.0, 1.0, 1.0] } else { TEXT });
        if hov && self.inp.down {
            let m = self.mouse();
            lo + ((m[0] - x) / w).clamp(0.0, 1.0) * (hi - lo)
        } else {
            v
        }
    }

    /// Segmented selector; returns the chosen index.
    pub fn segmented(&mut self, x: f32, y: f32, w: f32, h: f32, labels: &[&str], sel: usize) -> usize {
        let n = labels.len().max(1) as f32;
        let bw = w / n;
        let mut out = sel;
        for (i, l) in labels.iter().enumerate() {
            if self.chip(x + bw * i as f32, y, bw, h, l, i == sel) {
                out = i;
            }
        }
        out
    }
}

// ------------------------------------------------------------------------------------------------ state machine

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Screen {
    Boot,
    Menu,
    Planner,
    Briefing,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ModalKind {
    Settings,
    Controls,
    Logbook,
    /// add-on downloader (`market.rs`)
    Marketplace,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    None,
    Quit,
    /// Dispatch complete: start the flight with these parameters.
    Start { dep: String, arr: String, dep_rwy: Option<String>, arr_rwy: Option<String>, cruise_alt_m: Option<f64> },
}

pub struct PreFlight {
    pub screen: Screen,
    pub modal: Option<ModalKind>,
    pub boot: screens::Boot,
    pub globe: globe::Globe,
    pub planner: planner::PlannerState,
    pub settings: modals::Settings,
    pub logbook: Vec<modals::LogEntry>,
    pub settings_tab: usize,
    pub logbook_scroll: f32,
    pub fade: f32,
    pub time: f64,
    pub started: bool,
    /// add-on manager behind the Marketplace window (persistent cache + background downloads)
    pub addons: crate::addons::AddonManager,
    /// the HD flight deck is parsed and uploaded (set by the app, shown in the Marketplace)
    pub deck_ready: bool,
    /// last Marketplace interaction (the app consumes it: preload / unload the model)
    pub market_event: market::MarketEvent,
    /// the route-selection screen (or a flight) needs the airport database: the app loads it off-thread on demand. The
    /// boot screen and the main menu run without it (a bare rotating globe, no markers)
    pub airports_requested: bool,
}

impl PreFlight {
    pub fn new(db: &AirportDb) -> Self {
        Self {
            screen: Screen::Boot,
            modal: None,
            boot: screens::Boot::new(),
            globe: globe::Globe::new(),
            planner: planner::PlannerState::new(db),
            settings: modals::Settings::load(),
            logbook: modals::load_logbook(),
            settings_tab: 0,
            logbook_scroll: 0.0,
            fade: 0.0,
            time: 0.0,
            started: false,
            addons: crate::addons::AddonManager::new(),
            deck_ready: false,
            market_event: market::MarketEvent::default(),
            airports_requested: false,
        }
    }

    /// Skips the boot splash (used by tests, `--autostart`, and headless screenshots).
    pub fn skip_boot(&mut self, db: &AirportDb) {
        while self.screen == Screen::Boot {
            self.boot.fast_forward(db, &mut self.globe, &mut self.planner);
            self.screen = Screen::Menu;
        }
    }

    pub fn goto(&mut self, s: Screen) {
        if self.screen != s {
            if s == Screen::Menu && self.screen != Screen::Boot {
                // back from route selection: the globe returns to a bare rotating Earth
                self.globe.reset_to_menu();
            }
            if matches!(s, Screen::Planner | Screen::Briefing) {
                self.airports_requested = true;
            }
            self.screen = s;
            self.fade = 1.0;
        }
    }

    /// True while the airport database is needed but has not been delivered yet.
    pub fn waiting_for_airports(&self, db: &AirportDb) -> bool {
        db.is_empty() && matches!(self.screen, Screen::Planner | Screen::Briefing)
    }

    /// Runs one UI frame: updates state from `inp` and draws everything. `utc` is the real-time clock (unix seconds).
    pub fn frame(&mut self, ui: &mut Ui, inp: &Input, db: &AirportDb, utc: f64, dt: f64, fps: f32) -> Outcome {
        self.time += dt;
        self.fade = (self.fade - dt as f32 * 3.2).max(0.0);
        let time = self.time;
        let mut out = Outcome::None;
        let mut g = Gui::new(ui, inp, time);

        // Escape: close modal -> step back one screen -> quit from the menu
        if inp.key(Key::Escape) && self.screen != Screen::Boot {
            if self.modal.is_some() {
                self.modal = None;
            } else {
                match self.screen {
                    Screen::Briefing => self.goto(Screen::Planner),
                    Screen::Planner => self.goto(Screen::Menu),
                    Screen::Menu => out = Outcome::Quit,
                    Screen::Boot => {}
                }
            }
        }
        if inp.key(Key::F(1)) && self.screen != Screen::Boot {
            self.modal = if self.modal == Some(ModalKind::Controls) { None } else { Some(ModalKind::Controls) };
        }

        if inp.key(Key::F(2)) && self.screen != Screen::Boot {
            self.modal = if self.modal == Some(ModalKind::Marketplace) { None } else { Some(ModalKind::Marketplace) };
        }

        let had_modal = self.modal.is_some();
        g.block = had_modal;
        // the boot / menu globe is a bare rotating Earth: airports only exist on the route-selection screens
        self.globe.markers = matches!(self.screen, Screen::Planner | Screen::Briefing);
        let loading = self.waiting_for_airports(db);
        match self.screen {
            Screen::Boot => {
                if screens::draw_boot(&mut g, &mut self.boot, db, &mut self.globe, &mut self.planner, dt) {
                    self.screen = Screen::Menu;
                    self.fade = 0.0;
                }
            }
            Screen::Menu => {
                let act = screens::draw_menu(&mut g, &mut self.globe, db, utc, dt, fps, &self.settings, self.logbook.len(), self.started);
                match act {
                    screens::MenuAction::None => {}
                    screens::MenuAction::Planner => self.goto(Screen::Planner),
                    screens::MenuAction::FreeFlight => {
                        out = Outcome::Start { dep: self.planner.dep.clone(), arr: self.planner.arr.clone(), dep_rwy: None, arr_rwy: None, cruise_alt_m: None };
                    }
                    screens::MenuAction::Settings => self.modal = Some(ModalKind::Settings),
                    screens::MenuAction::Logbook => self.modal = Some(ModalKind::Logbook),
                    screens::MenuAction::Controls => self.modal = Some(ModalKind::Controls),
                    screens::MenuAction::Marketplace => self.modal = Some(ModalKind::Marketplace),
                    screens::MenuAction::Quit => out = Outcome::Quit,
                }
            }
            Screen::Planner | Screen::Briefing if loading => {
                if planner::draw_loading(&mut g, &mut self.globe, utc, dt) {
                    self.goto(Screen::Menu);
                }
            }
            Screen::Planner => {
                match planner::draw_planner(&mut g, &mut self.planner, &mut self.globe, db, utc, dt) {
                    planner::PlannerAction::None => {}
                    planner::PlannerAction::Back => self.goto(Screen::Menu),
                    planner::PlannerAction::Briefing => {
                        self.planner.prepare_briefing(db, utc);
                        self.goto(Screen::Briefing);
                    }
                }
            }
            Screen::Briefing => match planner::draw_briefing(&mut g, &mut self.planner, &mut self.globe, db, utc, dt) {
                planner::BriefingAction::None => {}
                planner::BriefingAction::Back => self.goto(Screen::Planner),
                planner::BriefingAction::Start => {
                    out = self.planner.start_outcome();
                }
            },
        }

        if let Some(kind) = self.modal {
            g.block = false;
            // the click that just opened the window must not also act inside it (e.g. close it as a backdrop click)
            g.mute_click = !had_modal;
            let (mut close, mut settings_changed) = (false, false);
            if kind == ModalKind::Marketplace {
                let ev = market::draw_marketplace(&mut g, &mut self.addons, self.deck_ready, &mut close);
                self.market_event.started |= ev.started;
                self.market_event.toggled |= ev.toggled;
                self.market_event.removed |= ev.removed;
            } else {
                modals::draw_modal(&mut g, kind, &mut self.settings, &mut self.settings_tab, &mut self.logbook, &mut self.logbook_scroll, &mut close, &mut settings_changed);
            }
            if settings_changed {
                self.settings.save();
            }
            if close {
                self.modal = None;
            }
        }

        // screen transition veil
        if self.fade > 0.0 {
            g.rect(0.0, 0.0, g.vw, g.vh, [0.0, 0.0, 0.0, self.fade * 0.8]);
        }
        if matches!(out, Outcome::Start { .. }) {
            self.started = true;
        }
        out
    }
}
