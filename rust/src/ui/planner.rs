//! Airport search + filters, flight planner and A320 route briefing (ports of `Planner.tsx`, `AirportMiniMap.tsx`,
//! `A320Plan`/`flightDispatch.ts`). The planner screen pairs a searchable list of all 8,413 airports with the interactive
//! globe; the briefing screen shows distance, ETE, block fuel, semicircular cruise level, TOD, runway selection with
//! wind components, a Mercator route map and the vertical profile.

use super::dispatch::{self, compute, curated_routes, fmt_ete, region_of, wind_components, Region, RouteDispatch, RouteFilter, MAX_FL, REGIONS, ROUTES};
use super::globe::{route_focus, Globe, GlobeView, Marks};
use super::map::{draw_airport_minimap, draw_profile, draw_route_map, draw_runway_diagram};
use super::{alpha, thousands, BtnKind, Gui, Key, Outcome, ACCENT, AMBER, DIM, GREEN, LINE, LINE_HI, MAGENTA, MUTED, PANEL, RED, TEXT};
use crate::airports::{Airport, AirportDb, RunwayEnd};
use crate::clock::hhmm;
use crate::game::seed_for;
use crate::geo::*;
use crate::specs::A320;
use crate::weather::Weather;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Field {
    Dep,
    Arr,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tab {
    Airports,
    Routes,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Filters {
    /// longest runway at least 5,000 ft
    pub long_rwy: bool,
    pub intl: bool,
    pub hard: bool,
    pub region: Option<Region>,
}

pub const LONG_RWY_M: f64 = 5000.0 * FT;

pub fn is_international(a: &Airport) -> bool {
    a.size == 0 || a.name.contains("Intl") || a.name.contains("International")
}

pub fn passes(a: &Airport, f: &Filters) -> bool {
    if f.long_rwy && !a.main_runway().is_some_and(|r| r.length >= LONG_RWY_M) {
        return false;
    }
    if f.intl && !is_international(a) {
        return false;
    }
    if f.hard && !a.main_runway().is_some_and(|r| matches!(r.surface, 'A' | 'C')) {
        return false;
    }
    if let Some(r) = f.region {
        if region_of(a) != r {
            return false;
        }
    }
    true
}

/// Search index entry: lower-case "icao iata name city country".
pub fn haystack(a: &Airport) -> String {
    format!("{} {} {} {} {}", a.icao, a.iata, a.name, a.city, a.country).to_ascii_lowercase()
}

/// Rank of a match (lower = better): 0 exact code, 1 code prefix, 2 word prefix, 3 substring.
fn rank(a: &Airport, hay: &str, tokens: &[&str]) -> Option<u8> {
    let mut worst = 0u8;
    for (ti, t) in tokens.iter().enumerate() {
        if !hay.contains(t) {
            return None;
        }
        let (icao, iata) = (a.icao.to_ascii_lowercase(), a.iata.to_ascii_lowercase());
        let r = if icao == *t || iata == *t {
            0
        } else if icao.starts_with(t) || (!iata.is_empty() && iata.starts_with(t)) {
            1
        } else if hay.split(' ').any(|w| w.starts_with(t)) {
            2
        } else {
            3
        };
        if ti == 0 {
            worst = r;
        } else {
            worst = worst.max(r);
        }
    }
    Some(worst)
}

/// Filtered + ranked airport indices for a query (empty query lists the major hubs first).
pub fn search(db: &AirportDb, hay: &[String], query: &str, f: &Filters) -> Vec<u32> {
    let q = query.trim().to_ascii_lowercase();
    let tokens: Vec<&str> = q.split_whitespace().collect();
    let mut hits: Vec<(u8, u8, i32, u32)> = Vec::new();
    for (i, a) in db.airports.iter().enumerate() {
        if !passes(a, f) {
            continue;
        }
        let r = if tokens.is_empty() {
            Some(0)
        } else {
            let h = hay.get(i).map(String::as_str).unwrap_or("");
            rank(a, h, &tokens)
        };
        if let Some(r) = r {
            hits.push((r, a.size, -(a.main_runway().map_or(0.0, |w| w.length) as i32), i as u32));
        }
    }
    hits.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)).then_with(|| db.airports[a.3 as usize].icao.cmp(&db.airports[b.3 as usize].icao)));
    hits.into_iter().map(|h| h.3).collect()
}

// ------------------------------------------------------------------------------------------------ state

pub struct Briefing {
    pub dep: usize,
    pub arr: usize,
    pub d: RouteDispatch,
    pub fl: u32,
    pub wx: Weather,
    pub dep_ends: Vec<RunwayEnd>,
    pub arr_ends: Vec<RunwayEnd>,
    pub dep_sel: usize,
    pub arr_sel: usize,
    pub utc: f64,
}

pub struct PlannerState {
    pub dep: String,
    pub arr: String,
    pub field: Field,
    pub query: String,
    pub hay: Vec<String>,
    pub results: Vec<u32>,
    pub filters: Filters,
    pub scroll: f32,
    pub cursor: usize,
    pub inspected: Option<usize>,
    pub tab: Tab,
    pub route_filter: RouteFilter,
    pub brief: Option<Briefing>,
    dirty: bool,
    pub message: String,
}

impl PlannerState {
    pub fn new(_db: &AirportDb) -> Self {
        Self {
            dep: "KSFO".into(),
            arr: "KOAK".into(),
            field: Field::Dep,
            query: String::new(),
            hay: Vec::new(),
            results: Vec::new(),
            filters: Filters::default(),
            scroll: 0.0,
            cursor: 0,
            inspected: None,
            tab: Tab::Airports,
            route_filter: RouteFilter::All,
            brief: None,
            dirty: true,
            message: String::new(),
        }
    }

    /// Builds the lower-case search index (boot stage) and the first result list.
    pub fn build_index(&mut self, db: &AirportDb) {
        self.hay = db.airports.iter().map(haystack).collect();
        self.refresh(db);
    }

    pub fn refresh(&mut self, db: &AirportDb) {
        if self.hay.len() != db.airports.len() {
            self.hay = db.airports.iter().map(haystack).collect();
        }
        self.results = search(db, &self.hay, &self.query, &self.filters);
        self.scroll = 0.0;
        self.cursor = 0;
        self.dirty = false;
    }

    pub fn dep_idx(&self, db: &AirportDb) -> Option<usize> {
        db.airports.iter().position(|a| a.icao == self.dep)
    }
    pub fn arr_idx(&self, db: &AirportDb) -> Option<usize> {
        db.airports.iter().position(|a| a.icao == self.arr)
    }

    pub fn select(&mut self, db: &AirportDb, idx: usize, globe: &mut Globe) {
        let icao = db.airports[idx].icao.clone();
        match self.field {
            Field::Dep => {
                self.dep = icao;
                self.field = Field::Arr;
            }
            Field::Arr => self.arr = icao,
        }
        self.inspected = Some(idx);
        self.message.clear();
        self.fly(db, globe, idx);
    }

    fn fly(&self, db: &AirportDb, globe: &mut Globe, focus: usize) {
        if let (Some(d), Some(a)) = (self.dep_idx(db), self.arr_idx(db)) {
            if d != a {
                let (lat, lon, z) = route_focus(&db.airports[d], &db.airports[a]);
                globe.fly_to(lat, lon, z);
                return;
            }
        }
        let a = &db.airports[focus];
        globe.fly_to(a.lat, a.lon, 6.0);
    }

    /// Validates the current pair; returns the dispatch summary when flyable.
    pub fn validate(&self, db: &AirportDb) -> Result<RouteDispatch, String> {
        let d = db.airports.iter().find(|a| a.icao == self.dep).ok_or("Select a departure airport")?;
        let a = db.airports.iter().find(|a| a.icao == self.arr).ok_or("Select an arrival airport")?;
        if d.runways.is_empty() {
            return Err(format!("{} has no runway data", d.icao));
        }
        if a.runways.is_empty() {
            return Err(format!("{} has no runway data", a.icao));
        }
        let r = compute(d, a);
        if r.same_airport {
            return Err("Departure and arrival are the same airport".into());
        }
        if !r.in_range {
            return Err(format!("{:.0} km exceeds the A320 planning range ({:.0} km)", r.distance_km, r.max_range_km));
        }
        Ok(r)
    }

    pub fn prepare_briefing(&mut self, db: &AirportDb, utc: f64) {
        let (Some(di), Some(ai)) = (self.dep_idx(db), self.arr_idx(db)) else { return };
        let (dep, arr) = (&db.airports[di], &db.airports[ai]);
        let d = compute(dep, arr);
        // the simulator uses one weather system seeded from the departure airport and the date
        let wx = Weather::generate(seed_for(utc, &dep.icao));
        let ends = |a: &Airport| -> Vec<RunwayEnd> { a.runways.iter().flat_map(|r| r.ends()).collect() };
        let (dep_ends, arr_ends) = (ends(dep), ends(arr));
        let pick = |a: &Airport, list: &[RunwayEnd]| {
            let best = a.best_end(wx.wind_from_deg).map(|e| e.ident);
            best.and_then(|b| list.iter().position(|e| e.ident == b)).unwrap_or(0)
        };
        let (dep_sel, arr_sel) = (pick(dep, &dep_ends), pick(arr, &arr_ends));
        self.brief = Some(Briefing { dep: di, arr: ai, fl: d.planned_fl, d, wx, dep_ends, arr_ends, dep_sel, arr_sel, utc });
    }

    pub fn start_outcome(&self) -> Outcome {
        match &self.brief {
            Some(b) => Outcome::Start {
                dep: self.dep.clone(),
                arr: self.arr.clone(),
                dep_rwy: b.dep_ends.get(b.dep_sel).map(|e| e.ident.clone()),
                arr_rwy: b.arr_ends.get(b.arr_sel).map(|e| e.ident.clone()),
                cruise_alt_m: Some(b.fl as f64 * 100.0 * FT),
            },
            None => Outcome::Start { dep: self.dep.clone(), arr: self.arr.clone(), dep_rwy: None, arr_rwy: None, cruise_alt_m: None },
        }
    }
}

// ------------------------------------------------------------------------------------------------ planner screen

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PlannerAction {
    None,
    Back,
    Briefing,
}

fn top_bar(g: &mut Gui, title: &str, step: usize, utc: f64) -> bool {
    let w = g.vw;
    g.rect(0.0, 0.0, w, 44.0, [0.02, 0.035, 0.06, 0.96]);
    g.line([0.0, 44.0], [w, 44.0], 1.0, LINE);
    let back = g.btn(10.0, 8.0, 76.0, 28.0, "< BACK", BtnKind::Ghost);
    g.text(100.0, 15.0, 15.0, TEXT, 0, title);
    for (i, label) in ["1 ROUTE", "2 BRIEFING"].iter().enumerate() {
        let x = w * 0.5 + i as f32 * 120.0 - 60.0;
        let on = i + 1 == step;
        g.text(x, 17.0, 11.0, if on { ACCENT } else { MUTED }, 0, label);
        if on {
            g.rect(x, 34.0, 100.0, 2.0, ACCENT);
        }
    }
    let (h, m) = hhmm(utc);
    g.textf(w - 14.0, 17.0, 11.0, DIM, 2, format_args!("{h:02}:{m:02}Z"));
    back
}

fn airport_card(g: &mut Gui, x: f32, y: f32, w: f32, label: &str, icao: &str, db: &AirportDb, active: bool, col: [f32; 4]) -> bool {
    let h = 62.0;
    let hov = g.hover(x, y, w, h);
    g.rect(x, y, w, h, if active { alpha(col, 0.16) } else if hov { [1.0, 1.0, 1.0, 0.07] } else { PANEL });
    g.frame(x, y, w, h, if active { 2.0 } else { 1.0 }, if active { col } else { LINE });
    g.text(x + 10.0, y + 7.0, 9.5, col, 0, label);
    match db.get(icao) {
        Some(a) => {
            g.text(x + 10.0, y + 20.0, 22.0, TEXT, 0, &a.icao);
            let n: String = a.name.chars().take(((w - 20.0) / (9.5 * 0.602)) as usize).collect();
            g.text(x + 10.0, y + 46.0, 9.5, DIM, 0, &n);
        }
        None => g.text(x + 10.0, y + 24.0, 13.0, MUTED, 0, "select airport"),
    }
    g.clicked(x, y, w, h)
}

pub fn draw_planner(g: &mut Gui, p: &mut PlannerState, globe: &mut Globe, db: &AirportDb, utc: f64, dt: f64) -> PlannerAction {
    let (w, h) = (g.vw, g.vh);
    let mut act = PlannerAction::None;
    if p.hay.is_empty() {
        p.refresh(db);
    }
    g.rect_v(0.0, 0.0, w, h, [0.02, 0.05, 0.10, 1.0], [0.004, 0.012, 0.03, 1.0]);

    // ---------------- keyboard: type to search
    let mut changed = false;
    for ch in g.inp.typed.chars() {
        if (ch.is_ascii_alphanumeric() || ch == ' ' || ch == '-' || ch == '\'') && p.query.len() < 28 && !g.block {
            p.query.push(ch);
            changed = true;
        }
    }
    if g.inp.key(Key::Backspace) && !g.block && p.query.pop().is_some() {
        changed = true;
    }
    if g.inp.key(Key::Delete) && !g.block && !p.query.is_empty() {
        p.query.clear();
        changed = true;
    }
    if g.inp.key(Key::Tab) && !g.block {
        p.field = if p.field == Field::Dep { Field::Arr } else { Field::Dep };
    }
    if changed {
        p.tab = Tab::Airports;
        p.refresh(db);
    }
    let n_res = p.results.len();
    if g.inp.key(Key::Down) && !g.block && p.cursor + 1 < n_res {
        p.cursor += 1;
    }
    if g.inp.key(Key::Up) && !g.block {
        p.cursor = p.cursor.saturating_sub(1);
    }
    if g.inp.key(Key::PageDown) && !g.block {
        p.cursor = (p.cursor + 10).min(n_res.saturating_sub(1));
    }
    if g.inp.key(Key::PageUp) && !g.block {
        p.cursor = p.cursor.saturating_sub(10);
    }

    // ---------------- globe (right area)
    let (gx0, gy0) = (452.0f32, 52.0f32);
    let (gw, gh) = ((w - gx0 - 12.0).max(200.0), (h - gy0 - 60.0).max(200.0));
    let view = GlobeView { cx: gx0 + gw * 0.5, cy: gy0 + gh * 0.5, r: gw.min(gh) * 0.46, clip: [gx0, gy0, gw, gh] };
    let marks = Marks { dep: p.dep_idx(db), arr: p.arr_idx(db), hover_lock: false };
    let out = globe.run(g, view, utc, db, marks, true, dt);
    if let Some(i) = out.picked {
        p.select(db, i, globe);
    }
    if let Some(i) = out.hover {
        p.inspected = Some(i);
    }
    g.frame(gx0, gy0, gw, gh, 1.0, [1.0, 1.0, 1.0, 0.07]);
    g.text(gx0 + 10.0, gy0 + 8.0, 10.0, MUTED, 0, "DRAG: ROTATE   WHEEL: ZOOM   CLICK AIRPORT: SELECT");
    {
        let (sl, so) = crate::clock::subsolar_point(utc);
        g.textf(gx0 + gw - 10.0, gy0 + 8.0, 10.0, AMBER, 2, format_args!("TERMINATOR - SUN {:.0}{} {:.0}{}", sl.abs(), if sl >= 0.0 { "N" } else { "S" }, so.abs(), if so >= 0.0 { "E" } else { "W" }));
    }

    // inspector (mini-map) over the globe, bottom-right
    let insp = p.inspected.or_else(|| p.dep_idx(db)).and_then(|i| db.airports.get(i));
    if let Some(a) = insp {
        let (iw, ih) = (300.0f32, 232.0f32);
        let sel = if p.field == Field::Dep { None } else { None };
        draw_airport_minimap(g, gx0 + gw - iw - 10.0, gy0 + gh - ih - 10.0, iw, ih, a, sel);
    }

    // ---------------- left panel
    let (lx, ly, lw) = (12.0f32, 52.0f32, 428.0f32);
    let lh = h - ly - 60.0;
    g.rect(lx, ly, lw, lh, [0.02, 0.035, 0.06, 0.94]);
    g.frame(lx, ly, lw, lh, 1.0, LINE);
    let cw = (lw - 20.0 - 34.0 - 12.0) / 2.0;
    if airport_card(g, lx + 10.0, ly + 10.0, cw, "DEPARTURE", &p.dep, db, p.field == Field::Dep, ACCENT) {
        p.field = Field::Dep;
    }
    if g.btn(lx + 10.0 + cw + 6.0, ly + 24.0, 34.0, 32.0, "<>", BtnKind::Ghost) {
        std::mem::swap(&mut p.dep, &mut p.arr);
        if let Some(i) = p.dep_idx(db) {
            p.fly(db, globe, i);
        }
    }
    if airport_card(g, lx + 10.0 + cw + 46.0, ly + 10.0, cw, "ARRIVAL", &p.arr, db, p.field == Field::Arr, MAGENTA) {
        p.field = Field::Arr;
    }

    // search box
    let sy = ly + 84.0;
    g.rect(lx + 10.0, sy, lw - 20.0, 32.0, [0.0, 0.01, 0.03, 1.0]);
    g.frame(lx + 10.0, sy, lw - 20.0, 32.0, 1.5, ACCENT);
    let cur = if ((g.time * 2.0) as i64) % 2 == 0 { "_" } else { " " };
    if p.query.is_empty() {
        g.text(lx + 30.0, sy + 9.0, 12.5, MUTED, 0, "Search ICAO, IATA, city or name...");
        g.text(lx + 20.0, sy + 9.0, 12.5, TEXT, 0, cur);
    } else {
        g.textf(lx + 20.0, sy + 9.0, 12.5, TEXT, 0, format_args!("{}{}", p.query, cur));
        if g.btn(lx + lw - 44.0, sy + 5.0, 26.0, 22.0, "x", BtnKind::Ghost) {
            p.query.clear();
            p.refresh(db);
        }
    }
    g.textf(lx + 12.0, sy + 38.0, 10.0, DIM, 0, format_args!("{} / {} airports", thousands(n_res), thousands(db.airports.len())));
    g.text(lx + lw - 12.0, sy + 38.0, 10.0, MUTED, 2, "TAB: DEP/ARR  ENTER: PICK");

    // filter chips
    let fy = sy + 56.0;
    let mut f = p.filters;
    let chips: [(&str, bool, u8); 3] = [("RWY 5000FT+", f.long_rwy, 0), ("INTL", f.intl, 1), ("HARD SURFACE", f.hard, 2)];
    let mut cx = lx + 10.0;
    for (label, on, id) in chips {
        let cwid = label.len() as f32 * 6.4 + 16.0;
        if g.chip(cx, fy, cwid, 22.0, label, on) {
            match id {
                0 => f.long_rwy = !f.long_rwy,
                1 => f.intl = !f.intl,
                _ => f.hard = !f.hard,
            }
        }
        cx += cwid + 6.0;
    }
    // region quick picks
    let ry = fy + 28.0;
    let mut cx = lx + 10.0;
    let mut yy = ry;
    let all_w = 34.0;
    if g.chip(cx, yy, all_w, 22.0, "ALL", f.region.is_none()) {
        f.region = None;
    }
    cx += all_w + 6.0;
    for (reg, label) in REGIONS {
        let cwid = label.len() as f32 * 6.4 + 14.0;
        if cx + cwid > lx + lw - 10.0 {
            cx = lx + 10.0;
            yy += 28.0;
        }
        if g.chip(cx, yy, cwid, 22.0, label, f.region == Some(reg)) {
            f.region = if f.region == Some(reg) { None } else { Some(reg) };
        }
        cx += cwid + 6.0;
    }
    if f != p.filters {
        p.filters = f;
        p.tab = Tab::Airports;
        p.refresh(db);
    }

    // tabs
    let ty = yy + 32.0;
    for (i, (label, t)) in [("AIRPORTS", Tab::Airports), ("CURATED ROUTES", Tab::Routes)].iter().enumerate() {
        let x = lx + 10.0 + i as f32 * 120.0;
        let on = p.tab == *t;
        if g.hover(x, ty, 112.0, 22.0) && g.inp.pressed {
            p.tab = *t;
        }
        g.text(x, ty + 5.0, 11.0, if on { TEXT } else { MUTED }, 0, label);
        if on {
            g.rect(x, ty + 20.0, 104.0, 2.0, ACCENT);
        }
    }
    g.line([lx + 10.0, ty + 22.0], [lx + lw - 10.0, ty + 22.0], 1.0, LINE);

    // list
    let list_y = ty + 28.0;
    let list_h = (ly + lh - list_y - 6.0).max(40.0);
    let in_list = g.hover(lx, list_y, lw, list_h);
    match p.tab {
        Tab::Airports => {
            let row_h = 38.0f32;
            if in_list && g.inp.wheel != 0.0 {
                p.scroll -= g.inp.wheel * row_h * 2.0;
            }
            // keep the keyboard cursor visible
            let (cy0, cy1) = (p.cursor as f32 * row_h, (p.cursor + 1) as f32 * row_h);
            if g.inp.key(Key::Down) || g.inp.key(Key::Up) || g.inp.key(Key::PageDown) || g.inp.key(Key::PageUp) {
                if cy0 < p.scroll {
                    p.scroll = cy0;
                }
                if cy1 > p.scroll + list_h {
                    p.scroll = cy1 - list_h;
                }
            }
            let max_scroll = (n_res as f32 * row_h - list_h).max(0.0);
            p.scroll = p.scroll.clamp(0.0, max_scroll);
            g.scissor(Some([lx, list_y, lw, list_h]));
            let first = (p.scroll / row_h) as usize;
            let last = (((p.scroll + list_h) / row_h) as usize + 1).min(n_res);
            let mut pick: Option<usize> = None;
            for r in first..last {
                let ai = p.results[r] as usize;
                let a = &db.airports[ai];
                let y = list_y + r as f32 * row_h - p.scroll;
                let hov = g.hover(lx, y, lw - 8.0, row_h) && g.hover(lx, list_y, lw, list_h);
                let is_dep = a.icao == p.dep;
                let is_arr = a.icao == p.arr;
                if r == p.cursor {
                    g.rect(lx + 4.0, y, lw - 14.0, row_h - 2.0, alpha(ACCENT, 0.10));
                }
                if hov {
                    g.rect(lx + 4.0, y, lw - 14.0, row_h - 2.0, [1.0, 1.0, 1.0, 0.07]);
                    p.inspected = Some(ai);
                }
                let tag = if is_dep { Some(("DEP", ACCENT)) } else if is_arr { Some(("ARR", MAGENTA)) } else { None };
                g.text(lx + 12.0, y + 5.0, 14.0, if tag.is_some() { tag.unwrap().1 } else { ACCENT }, 0, &a.icao);
                if !a.iata.is_empty() {
                    g.text(lx + 12.0 + 14.0 * 0.602 * (a.icao.len().max(4) as f32 + 1.0), y + 8.0, 10.0, DIM, 0, &a.iata);
                }
                let nm: String = a.name.chars().take(34).collect();
                g.text(lx + 12.0, y + 22.0, 10.0, TEXT, 0, &nm);
                let rw = a.main_runway();
                if let Some(rw) = rw {
                    g.textf(lx + lw - 16.0, y + 5.0, 10.0, DIM, 2, format_args!("{:.0} ft", rw.length / FT));
                }
                let city: String = format!("{}, {}", a.city, a.country).chars().take(24).collect();
                g.text(lx + lw - 16.0, y + 22.0, 9.5, MUTED, 2, &city);
                if let Some((t, c)) = tag {
                    g.text(lx + 175.0, y + 8.0, 9.5, c, 0, t);
                }
                if hov && g.inp.pressed {
                    pick = Some(ai);
                }
            }
            if n_res == 0 {
                g.text(lx + lw * 0.5, list_y + 40.0, 12.0, MUTED, 1, "No airports match");
            }
            g.scissor(None);
            // scrollbar
            if max_scroll > 0.0 {
                let th = (list_h * list_h / (n_res as f32 * row_h)).max(24.0);
                let ty2 = list_y + (list_h - th) * (p.scroll / max_scroll);
                g.rect(lx + lw - 6.0, list_y, 3.0, list_h, [1.0, 1.0, 1.0, 0.05]);
                g.rect(lx + lw - 6.0, ty2, 3.0, th, alpha(ACCENT, 0.7));
            }
            if g.inp.key(Key::Enter) && !g.block {
                if !p.query.is_empty() && p.cursor < n_res {
                    pick = Some(p.results[p.cursor] as usize);
                } else if pick.is_none() && p.validate(db).is_ok() {
                    act = PlannerAction::Briefing;
                }
            }
            if let Some(i) = pick {
                p.select(db, i, globe);
            }
        }
        Tab::Routes => {
            // route filter chips
            let list = curated_routes(db, p.route_filter);
            let row_h = 46.0f32;
            let top = list_y;
            for (i, (label, rf)) in [("ALL", RouteFilter::All), ("INDONESIA", RouteFilter::Indonesia), ("WORLD", RouteFilter::World)].iter().enumerate() {
                if g.chip(lx + 10.0 + i as f32 * 84.0, top, 78.0, 20.0, label, p.route_filter == *rf) {
                    p.route_filter = *rf;
                }
            }
            let top = top + 26.0;
            let vis_h = list_h - 26.0;
            if in_list && g.inp.wheel != 0.0 {
                p.scroll -= g.inp.wheel * row_h * 2.0;
            }
            p.scroll = p.scroll.clamp(0.0, (list.len() as f32 * row_h - vis_h).max(0.0));
            g.scissor(Some([lx, top, lw, vis_h]));
            for (k, (ri, nm)) in list.iter().enumerate() {
                let r = ROUTES[*ri];
                let y = top + k as f32 * row_h - p.scroll;
                let hov = g.hover(lx, y, lw - 8.0, row_h) && g.hover(lx, top, lw, vis_h);
                if hov {
                    g.rect(lx + 4.0, y, lw - 14.0, row_h - 3.0, [1.0, 1.0, 1.0, 0.07]);
                }
                g.text(lx + 12.0, y + 5.0, 12.5, TEXT, 0, r.2);
                g.text(lx + 12.0, y + 22.0, 10.0, DIM, 0, r.3);
                g.textf(lx + lw - 16.0, y + 5.0, 10.5, AMBER, 2, format_args!("{nm} NM"));
                g.textf(lx + lw - 16.0, y + 22.0, 9.5, MUTED, 2, format_args!("{} > {}", r.0, r.1));
                if hov && g.inp.pressed {
                    p.dep = r.0.to_string();
                    p.arr = r.1.to_string();
                    p.field = Field::Arr;
                    p.message.clear();
                    if let Some(i) = p.dep_idx(db) {
                        p.inspected = Some(i);
                        p.fly(db, globe, i);
                    }
                }
            }
            g.scissor(None);
        }
    }

    // ---------------- bottom bar
    let by = h - 52.0;
    g.rect(0.0, by, w, 52.0, [0.02, 0.035, 0.06, 0.96]);
    g.line([0.0, by], [w, by], 1.0, LINE);
    match p.validate(db) {
        Ok(d) => {
            g.textf(24.0, by + 10.0, 15.0, TEXT, 0, format_args!("{} > {}", p.dep, p.arr));
            g.textf(24.0, by + 31.0, 11.0, DIM, 0, format_args!("{:.0} NM  -  {:.0} km  -  TRK {:03.0}  -  ETE {}  -  FL{}", d.distance_nm, d.distance_km, d.bearing_deg, fmt_ete(d.ete_minutes), d.planned_fl));
            if g.btn(w - 214.0, by + 8.0, 200.0, 36.0, "FLIGHT BRIEFING  >", BtnKind::Primary) {
                act = PlannerAction::Briefing;
            }
        }
        Err(e) => {
            g.text(24.0, by + 10.0, 13.0, AMBER, 0, "Route not ready");
            g.text(24.0, by + 30.0, 11.0, DIM, 0, &e);
            g.btn(w - 214.0, by + 8.0, 200.0, 36.0, "FLIGHT BRIEFING  >", BtnKind::Ghost);
        }
    }
    if top_bar(g, "FLIGHT PLANNER", 1, utc) {
        act = PlannerAction::Back;
    }
    act
}

// ------------------------------------------------------------------------------------------------ briefing screen

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BriefingAction {
    None,
    Back,
    Start,
}

fn stat_card(g: &mut Gui, x: f32, y: f32, w: f32, h: f32, label: &str, value: &str, sub: &str, col: [f32; 4]) {
    g.rect(x, y, w, h, PANEL);
    g.frame(x, y, w, h, 1.0, LINE);
    g.rect(x, y, 3.0, h, col);
    g.text(x + 12.0, y + 8.0, 9.5, DIM, 0, label);
    g.text(x + 12.0, y + 23.0, 20.0, TEXT, 0, value);
    g.text(x + 12.0, y + h - 17.0, 9.5, MUTED, 0, sub);
}

fn runway_card(g: &mut Gui, x: f32, y: f32, w: f32, h: f32, title: &str, col: [f32; 4], ap: &Airport, ends: &[RunwayEnd], sel: &mut usize, wx: &Weather) {
    g.rect(x, y, w, h, PANEL);
    g.frame(x, y, w, h, 1.0, LINE);
    g.rect(x, y, w, 3.0, col);
    g.text(x + 12.0, y + 10.0, 9.5, col, 0, title);
    g.textf(x + 12.0, y + 23.0, 18.0, TEXT, 0, format_args!("{}", ap.icao));
    let nm: String = ap.name.chars().take(((w - 100.0) / (10.0 * 0.602)) as usize).collect();
    g.text(x + 12.0 + 18.0 * 0.602 * 5.0, y + 28.0, 10.0, DIM, 0, &nm);
    // runway end chips
    let mut cx = x + 12.0;
    let mut cy = y + 52.0;
    for (i, e) in ends.iter().enumerate() {
        let cwid = e.ident.len() as f32 * 7.4 + 14.0;
        if cx + cwid > x + w - 10.0 {
            cx = x + 12.0;
            cy += 24.0;
            if cy > y + 52.0 + 24.0 {
                break;
            }
        }
        if g.chip(cx, cy, cwid, 20.0, &e.ident, i == *sel) {
            *sel = i;
        }
        cx += cwid + 5.0;
    }
    let diag_y = cy + 28.0;
    let info_h = 62.0;
    let diag_h = (y + h - diag_y - info_h - 8.0).max(60.0);
    let e = &ends[(*sel).min(ends.len().saturating_sub(1))];
    draw_runway_diagram(g, x + 8.0, diag_y, w - 16.0, diag_h, ap, Some(&e.ident), Some((wx.wind_from_deg, wx.wind_kt)));
    let (head, cross) = wind_components(wx.wind_from_deg, wx.wind_kt, e.hdg);
    let iy = diag_y + diag_h + 6.0;
    g.textf(x + 12.0, iy, 11.5, TEXT, 0, format_args!("RWY {}  HDG {:03.0}T", e.ident, e.hdg));
    g.textf(x + 12.0, iy + 17.0, 10.0, DIM, 0, format_args!("{:.0} m ({:.0} ft) x {:.0} m  {}", e.length, e.length / FT, e.width, if e.paved { "paved" } else { "unpaved" }));
    let hc = if head >= 0.0 { GREEN } else { RED };
    let xc = if cross.abs() > 15.0 { RED } else if cross.abs() > 8.0 { AMBER } else { GREEN };
    g.textf(x + 12.0, iy + 33.0, 11.0, hc, 0, format_args!("{} {:.0} kt", if head >= 0.0 { "HEADWIND" } else { "TAILWIND" }, head.abs()));
    g.textf(x + w * 0.5, iy + 33.0, 11.0, xc, 0, format_args!("XWIND {:.0} kt {}", cross.abs(), if cross > 0.5 { "from R" } else if cross < -0.5 { "from L" } else { "" }));
    if e.disp > 0.0 {
        g.textf(x + w - 12.0, iy, 10.0, AMBER, 2, format_args!("DISPL THR {:.0} m", e.disp));
    }
}

pub fn draw_briefing(g: &mut Gui, p: &mut PlannerState, globe: &mut Globe, db: &AirportDb, utc: f64, dt: f64) -> BriefingAction {
    let _ = (globe, dt);
    let (w, h) = (g.vw, g.vh);
    let mut act = BriefingAction::None;
    g.rect_v(0.0, 0.0, w, h, [0.02, 0.05, 0.10, 1.0], [0.004, 0.012, 0.03, 1.0]);
    let Some(b) = p.brief.as_mut() else {
        g.text(w * 0.5, h * 0.5, 14.0, DIM, 1, "No route selected");
        if top_bar(g, "A320 ROUTE BRIEFING", 2, utc) {
            act = BriefingAction::Back;
        }
        return act;
    };
    let (dep, arr) = (&db.airports[b.dep], &db.airports[b.arr]);
    let top = 56.0f32;
    let bottom = h - 60.0;

    // ---------------- left: numbers
    let lw = 372.0f32;
    let lx = 12.0f32;
    let cw = (lw - 8.0) / 2.0;
    let d = &b.d;
    let rule = if wrap360(d.bearing_deg) < 180.0 { "eastbound - ODD levels" } else { "westbound - EVEN levels" };
    stat_card(g, lx, top, cw, 70.0, "DISTANCE", &format!("{:.0} NM", d.distance_nm), &format!("{:.0} km  TRK {:03.0} T", d.distance_km, d.bearing_deg), ACCENT);
    stat_card(g, lx + cw + 8.0, top, cw, 70.0, "ETE", &fmt_ete(d.ete_minutes), &format!("cruise {:.0} kt + 10 min", A320.cruise_kt), GREEN);
    stat_card(g, lx, top + 78.0, cw, 70.0, "CRUISE LEVEL", &format!("FL{}", b.fl), rule, AMBER);
    let tod = dispatch::tod_distance_nm(b.fl, arr.elev);
    let climb = dispatch::climb_distance_nm(b.fl, dep.elev);
    stat_card(g, lx + cw + 8.0, top + 78.0, cw, 70.0, "TOP OF DESCENT", &format!("{:.0} NM", tod), &format!("before RWY - T/C {:.0} NM", climb), MAGENTA);
    // FL -/+ (keeps the semicircular parity: steps of 20)
    if g.btn(lx + cw - 52.0, top + 78.0 + 6.0, 22.0, 18.0, "-", BtnKind::Ghost) && b.fl >= 70 {
        b.fl -= 20;
    }
    if g.btn(lx + cw - 26.0, top + 78.0 + 6.0, 22.0, 18.0, "+", BtnKind::Ghost) && b.fl + 20 <= MAX_FL {
        b.fl += 20;
    }
    // fuel
    let fy = top + 156.0;
    let fh = 150.0f32;
    g.rect(lx, fy, lw, fh, PANEL);
    g.frame(lx, fy, lw, fh, 1.0, LINE);
    g.text(lx + 12.0, fy + 8.0, 9.5, DIM, 0, "FUEL PLAN");
    g.textf(lx + lw - 12.0, fy + 6.0, 16.0, if d.fuel_exceeds_tanks { RED } else { TEXT }, 2, format_args!("{:.0} kg BLOCK", d.block_fuel_kg));
    let rows = [("Trip (incl. 25% climb/descent margin)", d.trip_fuel_kg), ("Contingency 5%", d.contingency_kg), ("Final reserve 30 min", d.reserve_kg), ("Taxi", d.taxi_kg)];
    for (i, (l, v)) in rows.iter().enumerate() {
        let y = fy + 34.0 + i as f32 * 16.0;
        g.text(lx + 12.0, y, 10.0, DIM, 0, l);
        g.textf(lx + lw - 12.0, y, 10.0, TEXT, 2, format_args!("{:.0} kg", v));
    }
    let bar_y = fy + fh - 28.0;
    let frac = (d.block_fuel_kg / A320.fuel_cap) as f32;
    g.rect(lx + 12.0, bar_y, lw - 24.0, 8.0, [1.0, 1.0, 1.0, 0.1]);
    g.rect(lx + 12.0, bar_y, (lw - 24.0) * frac.min(1.0), 8.0, if d.fuel_exceeds_tanks { RED } else if frac > 0.85 { AMBER } else { ACCENT });
    g.textf(lx + 12.0, bar_y + 11.0, 9.0, MUTED, 0, format_args!("tanks {:.0} kg  -  {:.0}% full", A320.fuel_cap, frac * 100.0));
    // status
    let sy = fy + fh + 8.0;
    let (msg, mc) = if d.fuel_exceeds_tanks {
        ("Planned fuel exceeds tank capacity", RED)
    } else if d.can_fly {
        ("Route within A320 range - CLEARED FOR DEPARTURE", GREEN)
    } else {
        ("Route outside planning range", RED)
    };
    g.rect(lx, sy, lw, 28.0, alpha(mc, 0.12));
    g.frame(lx, sy, lw, 28.0, 1.0, alpha(mc, 0.6));
    g.text(lx + 12.0, sy + 8.0, 10.5, mc, 0, msg);
    // weather
    let wy = sy + 36.0;
    g.rect(lx, wy, lw, 62.0, PANEL);
    g.frame(lx, wy, lw, 62.0, 1.0, LINE);
    g.text(lx + 12.0, wy + 8.0, 9.5, DIM, 0, "SIMULATION WEATHER (DEPARTURE)");
    g.textf(lx + 12.0, wy + 24.0, 12.0, TEXT, 0, format_args!("WIND {:03.0}/{:.0}KT G{:.0}   QNH {:.0}", b.wx.wind_from_deg, b.wx.wind_kt, b.wx.gust_kt.max(b.wx.wind_kt), b.wx.qnh));
    g.textf(lx + 12.0, wy + 42.0, 10.5, DIM, 0, format_args!("VIS {:.0} km   CLOUD BASE {:.0} ft   ISA{:+.0}", b.wx.vis_km, b.wx.cloud_base_m / FT, b.wx.d_t));

    // ---------------- right: runway cards
    let rw = 372.0f32;
    let rx = w - rw - 12.0;
    let rh = (bottom - top - 8.0) * 0.5;
    let wx_copy = Weather { ..b.wx };
    let (dep_ends, arr_ends) = (b.dep_ends.clone(), b.arr_ends.clone());
    runway_card(g, rx, top, rw, rh, "DEPARTURE RUNWAY", ACCENT, dep, &dep_ends, &mut b.dep_sel, &wx_copy);
    runway_card(g, rx, top + rh + 8.0, rw, rh, "ARRIVAL RUNWAY", MAGENTA, arr, &arr_ends, &mut b.arr_sel, &wx_copy);

    // ---------------- centre: route map + profile
    let cx = lx + lw + 12.0;
    let cwid = (rx - cx - 12.0).max(200.0);
    let prof_h = 150.0f32;
    let map_h = (bottom - top - prof_h - 8.0).max(120.0);
    draw_route_map(g, cx, top, cwid, map_h, dep, arr, &b.d, b.fl);
    g.text(cx + 8.0, top + 8.0, 10.0, TEXT, 0, "ROUTE MAP - GREAT CIRCLE");
    draw_profile(g, cx, top + map_h + 8.0, cwid, prof_h, &b.d, b.fl, dep.elev, arr.elev);

    // ---------------- bottom bar
    let by = h - 52.0;
    g.rect(0.0, by, w, 52.0, [0.02, 0.035, 0.06, 0.96]);
    g.line([0.0, by], [w, by], 1.0, LINE);
    let dep_id = b.dep_ends.get(b.dep_sel).map(|e| e.ident.as_str()).unwrap_or("-");
    let arr_id = b.arr_ends.get(b.arr_sel).map(|e| e.ident.as_str()).unwrap_or("-");
    g.textf(24.0, by + 10.0, 15.0, TEXT, 0, format_args!("{} RWY {}  >  {} RWY {}", dep.icao, dep_id, arr.icao, arr_id));
    g.textf(24.0, by + 31.0, 11.0, DIM, 0, format_args!("{} - FL{} - block {:.0} kg - ETE {}", "Airbus A320-200 CFM56-5B", b.fl, b.d.block_fuel_kg, fmt_ete(b.d.ete_minutes)));
    if g.btn(w - 330.0, by + 8.0, 100.0, 36.0, "BACK", BtnKind::Secondary) {
        act = BriefingAction::Back;
    }
    let can = b.d.can_fly;
    if g.btn(w - 220.0, by + 8.0, 206.0, 36.0, "START FLIGHT  >", if can { BtnKind::Primary } else { BtnKind::Ghost }) && can {
        act = BriefingAction::Start;
    }
    if g.inp.key(Key::Enter) && can && !g.block {
        act = BriefingAction::Start;
    }
    if top_bar(g, "A320 ROUTE BRIEFING", 2, utc) {
        act = BriefingAction::Back;
    }
    let _ = LINE_HI;
    act
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (AirportDb, Vec<String>) {
        let db = AirportDb::embedded();
        let hay: Vec<String> = db.airports.iter().map(haystack).collect();
        (db, hay)
    }

    #[test]
    fn search_exact_codes_rank_first() {
        let (db, hay) = setup();
        let r = search(&db, &hay, "sfo", &Filters::default());
        assert_eq!(db.airports[r[0] as usize].icao, "KSFO");
        let r = search(&db, &hay, "EGLL", &Filters::default());
        assert_eq!(db.airports[r[0] as usize].icao, "EGLL");
        let r = search(&db, &hay, "lhr", &Filters::default());
        assert_eq!(db.airports[r[0] as usize].icao, "EGLL");
    }

    #[test]
    fn search_by_city_and_multiple_tokens() {
        let (db, hay) = setup();
        let r = search(&db, &hay, "jakarta", &Filters::default());
        assert!(r.iter().any(|&i| db.airports[i as usize].icao == "WIII"));
        let r = search(&db, &hay, "san francisco intl", &Filters::default());
        assert_eq!(db.airports[r[0] as usize].icao, "KSFO");
        assert!(search(&db, &hay, "zzzzqqq", &Filters::default()).is_empty());
    }

    #[test]
    fn empty_query_lists_all_and_hubs_first() {
        let (db, hay) = setup();
        let r = search(&db, &hay, "", &Filters::default());
        assert_eq!(r.len(), db.airports.len());
        assert_eq!(db.airports[r[0] as usize].size, 0);
    }

    #[test]
    fn filters_narrow_results_correctly() {
        let (db, hay) = setup();
        let all = search(&db, &hay, "", &Filters::default()).len();
        let long = search(&db, &hay, "", &Filters { long_rwy: true, ..Default::default() });
        assert!(!long.is_empty() && long.len() < all);
        for &i in &long {
            assert!(db.airports[i as usize].main_runway().unwrap().length >= LONG_RWY_M);
        }
        let hard = search(&db, &hay, "", &Filters { hard: true, ..Default::default() });
        assert!(!hard.is_empty() && hard.len() < all);
        let id = search(&db, &hay, "", &Filters { region: Some(Region::Indonesia), ..Default::default() });
        assert_eq!(id.len(), 676);
        let intl_eu = search(&db, &hay, "", &Filters { intl: true, region: Some(Region::Europe), ..Default::default() });
        assert!(intl_eu.iter().any(|&i| db.airports[i as usize].icao == "EGLL"));
        assert!(intl_eu.iter().all(|&i| region_of(&db.airports[i as usize]) == Region::Europe));
    }

    #[test]
    fn validation_and_briefing_flow() {
        let (db, _) = setup();
        let mut p = PlannerState::new(&db);
        p.build_index(&db);
        assert!(p.validate(&db).is_ok());
        p.arr = p.dep.clone();
        assert!(p.validate(&db).is_err());
        p.arr = "YSSY".into();
        p.dep = "EGLL".into();
        assert!(p.validate(&db).unwrap_err().contains("range"));
        p.arr = "LFPG".into();
        p.prepare_briefing(&db, 1_718_914_200.0);
        let b = p.brief.as_ref().unwrap();
        assert!(!b.dep_ends.is_empty() && !b.arr_ends.is_empty());
        match p.start_outcome() {
            Outcome::Start { dep, arr, dep_rwy, arr_rwy, cruise_alt_m } => {
                assert_eq!((dep.as_str(), arr.as_str()), ("EGLL", "LFPG"));
                assert!(dep_rwy.is_some() && arr_rwy.is_some());
                let alt = cruise_alt_m.unwrap();
                assert!(alt > 3000.0 && alt <= MAX_FL as f64 * 100.0 * FT + 1.0, "{alt}");
            }
            o => panic!("{o:?}"),
        }
    }
}
