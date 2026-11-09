//! Multipurpose Control & Display Unit (MCDU) - the FMGC keyboard + 24x14 CRT of the A320 pedestal.
//!
//! Reference: `Mcdu` in `src/sim/a320/displays.ts` (key names follow the 3D model: `a`..`z`, `0`..`9`, `L1`..`R6`, `init`, `f-pln`, ...).
//! The TypeScript unit is a thin stub; this port keeps its pages and entry rules and finishes the parts that were left as no-ops:
//!
//! * every key of the model does something (`opt1` / `opt2` are the blank keys of the real keyboard and are deliberate no-ops),
//! * multi-page pages (F-PLN, INIT A/B, PERF TAKE OFF .. APPR, DATA index sub-pages) with working arrow keys,
//! * line-select keys with the real "empty scratchpad copies the field" behaviour, validated entries and the usual
//!   `ENTRY OUT OF RANGE` / `FORMAT ERROR` / `NOT ALLOWED` / `NOT IN DATABASE` messages,
//! * DIR TO really re-targets the autopilot's active waypoint,
//! * BRT / DIM brightness, MSG / FM / RDY annunciators, power loss.
//!
//! The screen is described as a list of [`Item`]s (text + line + alignment + colour) rebuilt at ~8 Hz and after every key, so the
//! renderer (`gfx/displays.rs`) is a trivial loop and the whole thing is unit-testable without a GPU.

use crate::fbw;
use crate::game::Flight;
use crate::geo::{haversine, WpType, FT, KT};
use std::fmt::Write;

pub const COLS: usize = 24;
/// 1 title line + 6 x (label + data) + scratchpad = 14 lines (the six LSKs sit next to lines 2, 4, .. 12).
pub const LINES: usize = 14;
pub const SCRATCH_MAX: usize = 22;
const MSG_TTL: f32 = 3.5;
const REFRESH_S: f32 = 0.125;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Page {
    Menu,
    Init,
    FPln,
    Perf,
    Prog,
    RadNav,
    Fuel,
    Data,
    Dir,
    Sec,
    Airport,
    Atc,
    DataPos,
    DataIrs,
    DataGps,
    DataStatus,
}

impl Page {
    pub fn title(self) -> &'static str {
        match self {
            Page::Menu => "MCDU MENU",
            Page::Init => "INIT",
            Page::FPln => "F-PLN",
            Page::Perf => "PERF",
            Page::Prog => "PROG",
            Page::RadNav => "RADIO NAV",
            Page::Fuel => "FUEL PRED",
            Page::Data => "DATA INDEX",
            Page::Dir => "DIR TO",
            Page::Sec => "SEC F-PLN",
            Page::Airport => "AIRPORT",
            Page::Atc => "ATC COMM",
            Page::DataPos => "POSITION MONITOR",
            Page::DataIrs => "IRS MONITOR",
            Page::DataGps => "GPS MONITOR",
            Page::DataStatus => "A/C STATUS",
        }
    }

    /// Number of sub-pages (arrow keys flip through them).
    pub fn pages(self, route_len: usize) -> usize {
        match self {
            Page::Init => 2,
            Page::Perf => 5,
            Page::FPln => route_len.max(1),
            _ => 1,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Col {
    White,
    Green,
    Cyan,
    Amber,
    Magenta,
    Grey,
}

impl Col {
    pub fn rgba(self) -> [f32; 4] {
        match self {
            Col::White => [0.96, 0.97, 1.0, 1.0],
            Col::Green => [0.25, 1.0, 0.35, 1.0],
            Col::Cyan => [0.25, 0.92, 1.0, 1.0],
            Col::Amber => [1.0, 0.72, 0.12, 1.0],
            Col::Magenta => [1.0, 0.35, 0.95, 1.0],
            Col::Grey => [0.62, 0.66, 0.72, 1.0],
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Align {
    Left,
    Right,
    Centre,
}

/// One piece of text on the CRT. `line` 0 = title .. 13 = scratchpad; `small` = label font (smaller, on the label lines).
#[derive(Clone, Debug)]
pub struct Item {
    pub line: u8,
    pub align: Align,
    pub small: bool,
    pub col: Col,
    pub text: String,
}

/// Pilot-entered data (TS `Mcdu.store`).
#[derive(Clone, Debug)]
pub struct Store {
    pub flt: String,
    /// cruise flight level
    pub crz: u32,
    pub ci: u32,
    pub v1: u32,
    pub vr: u32,
    pub v2: u32,
    pub flex: u32,
    /// tonnes
    pub zfw: f64,
    pub block: f64,
    pub trans: u32,
    pub qnh: u32,
}

impl Default for Store {
    fn default() -> Self {
        Self { flt: "IFL320".into(), crz: 350, ci: 35, v1: 0, vr: 0, v2: 0, flex: 55, zfw: 62.5, block: 0.0, trans: 5000, qnh: 1013 }
    }
}

/// Editable data fields (line-select targets).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Fld {
    Flt,
    CrzFl,
    Ci,
    Zfw,
    Block,
    V1,
    Vr,
    V2,
    Flex,
    Trans,
}

pub struct Mcdu {
    pub page: Page,
    /// sub-page (F-PLN first visible leg, INIT A/B, PERF phase)
    pub sub: usize,
    pub scratch: String,
    msg: Option<(String, f32)>,
    /// screen brightness 0.15 ..= 1 (BRT / DIM keys)
    pub brt: f32,
    pub store: Store,
    pub powered: bool,
    /// number of keys accepted since power-up (tests / diagnostics)
    pub presses: u32,
    items: Vec<Item>,
    refresh: f32,
}

impl Default for Mcdu {
    fn default() -> Self {
        Self { page: Page::Menu, sub: 0, scratch: String::new(), msg: None, brt: 1.0, store: Store::default(), powered: true, presses: 0, items: Vec::with_capacity(64), refresh: 0.0 }
    }
}

/// Every key name the 3D model exposes (without the `.cpt` / `.fo` suffix); used by tests and the deck classifier.
pub fn is_key_name(k: &str) -> bool {
    const NAMED: [&str; 28] = [
        "init", "f-pln", "f-pln2", "radnav", "fuel-pred", "prog", "perf", "data", "dir", "airport", "clr", "sp", "left", "right", "up", "down", "opt1", "opt2", "overfly", "+/-", "/", ".", "mcdu", "sec-fpln", "BRT", "DIM", "atc", "",
    ];
    if NAMED.contains(&k) {
        return true;
    }
    if k.len() == 1 && k.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) {
        return true;
    }
    let b = k.as_bytes();
    b.len() == 2 && (b[0] == b'L' || b[0] == b'R') && (b'1'..=b'6').contains(&b[1])
}

fn route_names(f: &Flight) -> impl Iterator<Item = (usize, &crate::geo::Waypoint)> {
    f.plan.iter().enumerate().skip(f.active_wp.min(f.plan.len()))
}

impl Mcdu {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn message(&self) -> Option<&str> {
        self.msg.as_ref().map(|m| m.0.as_str())
    }

    pub fn has_msg(&self) -> bool {
        self.msg.is_some()
    }

    pub fn items(&self) -> &[Item] {
        &self.items
    }

    fn set_msg(&mut self, m: &str) {
        self.msg = Some((m.to_string(), MSG_TTL));
    }

    /// Power / message timers / periodic repaint of the item list.
    pub fn update(&mut self, dt: f32, powered: bool, f: &Flight) {
        if powered != self.powered {
            self.powered = powered;
            if !powered {
                // a dead MCDU loses its scratchpad and any pending message, the stored data survive (NVM)
                self.scratch.clear();
                self.msg = None;
            }
            self.refresh = 0.0;
        }
        if let Some((_, t)) = self.msg.as_mut() {
            *t -= dt;
            if *t <= 0.0 {
                self.msg = None;
            }
        }
        self.refresh -= dt;
        if self.refresh <= 0.0 {
            self.refresh = REFRESH_S;
            self.rebuild(f);
        }
    }

    // ------------------------------------------------------------------ keys
    /// Press a key (model names, see [`is_key_name`]). Returns false when the unit is unpowered or the name is unknown.
    pub fn key(&mut self, raw: &str, f: &mut Flight) -> bool {
        if !self.powered {
            return false;
        }
        let k = raw.trim_end_matches(".cpt").trim_end_matches(".fo");
        if !is_key_name(k) {
            return false;
        }
        self.presses += 1;
        let n_route = f.plan.len().saturating_sub(f.active_wp);
        match k {
            "." | "" => self.add('.'),
            "/" => self.add('/'),
            "sp" => self.add(' '),
            "+/-" => match self.scratch.chars().last() {
                Some('-') => {
                    self.scratch.pop();
                    self.scratch.push('+');
                }
                Some('+') => {
                    self.scratch.pop();
                    self.scratch.push('-');
                }
                _ => self.add('-'),
            },
            "clr" => {
                if self.msg.is_some() {
                    self.msg = None;
                } else {
                    self.scratch.pop();
                }
            }
            "BRT" => self.brt = (((self.brt + 0.15) * 100.0).round() / 100.0).min(1.0),
            "DIM" => self.brt = (((self.brt - 0.15) * 100.0).round() / 100.0).max(0.15),
            "init" => self.go(Page::Init),
            "f-pln" => self.go(Page::FPln),
            "f-pln2" | "sec-fpln" => self.go(Page::Sec),
            "radnav" => self.go(Page::RadNav),
            "fuel-pred" => self.go(Page::Fuel),
            "prog" => self.go(Page::Prog),
            "perf" => self.go(Page::Perf),
            "data" => self.go(Page::Data),
            "dir" => self.go(Page::Dir),
            "airport" => self.go(Page::Airport),
            "atc" => self.go(Page::Atc),
            "mcdu" => self.go(Page::Menu),
            // F-PLN scrolls one leg per press; INIT / PERF flip between their pages (up = previous, down = next)
            "up" | "left" => self.flip(-1, n_route),
            "down" | "right" => self.flip(1, n_route),
            // blank keys of the real keyboard / overfly (no overfly legs are modelled)
            "overfly" | "opt1" | "opt2" => {}
            _ => {
                let b = k.as_bytes();
                if b.len() == 1 {
                    self.add(k.chars().next().unwrap().to_ascii_uppercase());
                } else if b.len() == 2 && (b[0] == b'L' || b[0] == b'R') {
                    self.lsk(b[0] == b'R', (b[1] - b'0') as usize, f);
                }
            }
        }
        self.rebuild(f);
        true
    }

    fn go(&mut self, p: Page) {
        self.page = p;
        self.sub = 0;
    }

    fn add(&mut self, c: char) {
        if self.scratch.chars().count() < SCRATCH_MAX {
            self.scratch.push(c);
        } else {
            self.set_msg("SCRATCHPAD FULL");
        }
    }

    fn flip(&mut self, d: i32, n_route: usize) {
        let pages = match self.page {
            Page::FPln => n_route.max(1),
            p => p.pages(0),
        };
        self.sub = (self.sub as i32 + d).clamp(0, pages as i32 - 1) as usize;
    }

    fn take(&mut self) -> String {
        std::mem::take(&mut self.scratch)
    }

    /// A numeric entry; returns None (and a message) when it is not a number.
    fn number(&mut self, s: &str) -> Option<f64> {
        match s.trim().parse::<f64>() {
            Ok(v) if v.is_finite() => Some(v),
            _ => {
                self.set_msg("FORMAT ERROR");
                None
            }
        }
    }

    /// Which data field lives behind a line-select key of the current page.
    fn field_at(&self, right: bool, n: usize) -> Option<Fld> {
        match (self.page, self.sub, right, n) {
            (Page::Init, 0, false, 2) => Some(Fld::Flt),
            (Page::Init, 0, true, 1) => Some(Fld::CrzFl),
            (Page::Init, 0, false, 5) => Some(Fld::Ci),
            (Page::Init, 0, true, 3) => Some(Fld::Zfw),
            (Page::Init, 1, false, 3) => Some(Fld::Block),
            (Page::Perf, 0, false, 1) => Some(Fld::V1),
            (Page::Perf, 0, false, 2) => Some(Fld::Vr),
            (Page::Perf, 0, false, 3) => Some(Fld::V2),
            (Page::Perf, 0, true, 2) => Some(Fld::Flex),
            (Page::Perf, 0, false, 4) => Some(Fld::Trans),
            _ => None,
        }
    }

    fn current(&self, fl: Fld) -> String {
        let s = &self.store;
        match fl {
            Fld::Flt => s.flt.clone(),
            Fld::CrzFl => format!("FL{}", s.crz),
            Fld::Ci => s.ci.to_string(),
            Fld::Zfw => format!("{:.1}", s.zfw),
            Fld::Block => format!("{:.1}", s.block),
            Fld::V1 => s.v1.to_string(),
            Fld::Vr => s.vr.to_string(),
            Fld::V2 => s.v2.to_string(),
            Fld::Flex => s.flex.to_string(),
            Fld::Trans => s.trans.to_string(),
        }
    }

    fn edit(&mut self, fl: Fld, f: &mut Flight) {
        let input = self.scratch.trim().to_string();
        if input.is_empty() {
            // empty scratchpad: copy the field into it (real FMGC behaviour)
            if fl != Fld::Flt || !self.store.flt.is_empty() {
                self.scratch = self.current(fl);
            }
            return;
        }
        match fl {
            Fld::Flt => {
                if input.len() > 8 || !input.chars().all(|c| c.is_ascii_alphanumeric()) {
                    return self.set_msg("FORMAT ERROR");
                }
                self.store.flt = input;
            }
            Fld::CrzFl => {
                let t = input.to_ascii_uppercase();
                let Some(v) = self.number(t.trim_start_matches("FL")) else { return };
                if !(100.0..=390.0).contains(&v) || v.fract() != 0.0 {
                    return self.set_msg("ENTRY OUT OF RANGE");
                }
                self.store.crz = v as u32;
                // TS `setApTarget('alt')`: the FCU altitude follows the cruise level
                f.ap.alt_ft = v * 100.0;
            }
            Fld::Ci => {
                let Some(v) = self.number(&input) else { return };
                if !(0.0..=200.0).contains(&v) || v.fract() != 0.0 {
                    return self.set_msg("ENTRY OUT OF RANGE");
                }
                self.store.ci = v as u32;
            }
            Fld::Zfw => {
                let Some(v) = self.number(&input) else { return };
                if !(30.0..=80.0).contains(&v) {
                    return self.set_msg("ENTRY OUT OF RANGE");
                }
                self.store.zfw = v;
            }
            Fld::Block => {
                let Some(v) = self.number(&input) else { return };
                let cap = f.fm.spec.fuel_cap / 1000.0;
                if !(0.0..=cap).contains(&v) {
                    return self.set_msg("ENTRY OUT OF RANGE");
                }
                self.store.block = v;
            }
            Fld::V1 | Fld::Vr | Fld::V2 => {
                let Some(v) = self.number(&input) else { return };
                if !(90.0..=200.0).contains(&v) || v.fract() != 0.0 {
                    return self.set_msg("ENTRY OUT OF RANGE");
                }
                match fl {
                    Fld::V1 => self.store.v1 = v as u32,
                    Fld::Vr => self.store.vr = v as u32,
                    _ => self.store.v2 = v as u32,
                }
            }
            Fld::Flex => {
                let Some(v) = self.number(&input) else { return };
                if !(0.0..=70.0).contains(&v) || v.fract() != 0.0 {
                    return self.set_msg("ENTRY OUT OF RANGE");
                }
                self.store.flex = v as u32;
            }
            Fld::Trans => {
                let Some(v) = self.number(&input) else { return };
                if !(1000.0..=18000.0).contains(&v) || v.fract() != 0.0 {
                    return self.set_msg("ENTRY OUT OF RANGE");
                }
                self.store.trans = v as u32;
            }
        }
        self.take();
    }

    fn lsk(&mut self, right: bool, n: usize, f: &mut Flight) {
        if !(1..=6).contains(&n) {
            return;
        }
        let input = self.scratch.trim().to_string();
        if let Some(fl) = self.field_at(right, n) {
            return self.edit(fl, f);
        }
        match (self.page, right, n) {
            (Page::Menu, false, 1..=6) => {
                let t = [Page::Init, Page::FPln, Page::Perf, Page::Prog, Page::Data, Page::RadNav][n - 1];
                return self.go(t);
            }
            (Page::Init, true, 5) if self.sub == 0 => return self.go(Page::Perf),
            (Page::Init, true, 6) if self.sub == 0 => {
                // ALIGN IRS: the IRS are aligned instantly by the simulation
                return self.set_msg("IRS ALIGNED");
            }
            (Page::Perf, false, 6) => {
                self.sub = self.sub.saturating_sub(1);
                return;
            }
            (Page::Perf, true, 6) => {
                self.sub = (self.sub + 1).min(4);
                return;
            }
            (Page::Data, false, 1) => return self.go(Page::DataPos),
            (Page::Data, false, 2) => return self.go(Page::DataIrs),
            (Page::Data, false, 3) => return self.go(Page::DataGps),
            (Page::Data, false, 4) => return self.go(Page::DataStatus),
            (Page::DataPos | Page::DataIrs | Page::DataGps | Page::DataStatus, false, 6) => return self.go(Page::Data),
            (Page::Sec, false, 1) => return self.set_msg("SEC F-PLN COPIED"),
            (Page::Sec, false, 2) => return self.go(Page::Init),
            (Page::FPln, false, 1..=6) if n >= 2 => {
                // pushing a leg with an empty scratchpad = DIR TO it (the TS stub only echoed its name)
                let idx = f.active_wp + self.sub + n - 2;
                if input.is_empty() {
                    if let Some(w) = f.plan.get(idx) {
                        let name = w.name.clone();
                        self.set_msg(&format!("{name} SELECTED"));
                    }
                    return;
                }
            }
            (Page::Dir, false, 1) => {
                // DIR TO [ ]: type a waypoint name and push LSK1
                if input.is_empty() {
                    return;
                }
                let want = input.to_ascii_uppercase();
                let found = route_names(f).find(|(_, w)| w.name.to_ascii_uppercase() == want).map(|(i, w)| (i, w.name.clone()));
                match found {
                    Some((i, name)) => return self.direct_to(i, &name, f),
                    None => return self.set_msg("NOT IN DATABASE"),
                }
            }
            (Page::Dir, false, 2..=5) => {
                let pick = route_names(f).nth(n - 2).map(|(i, w)| (i, w.name.clone()));
                if let Some((i, name)) = pick {
                    return self.direct_to(i, &name, f);
                }
                return;
            }
            _ => {}
        }
        if !input.is_empty() {
            self.set_msg("NOT ALLOWED");
        }
    }

    fn direct_to(&mut self, idx: usize, name: &str, f: &mut Flight) {
        f.active_wp = idx.min(f.plan.len().saturating_sub(1));
        self.take();
        self.set_msg(&format!("DIRECT TO {name}"));
        self.go(Page::FPln);
    }

    // ------------------------------------------------------------------ screen
    fn put(&mut self, line: usize, align: Align, small: bool, col: Col, text: &str) {
        if text.is_empty() {
            return;
        }
        self.items.push(Item { line: line as u8, align, small, col, text: text.chars().take(COLS).map(|c| if c == '\u{b0}' { 'o' } else { c }).collect() });
    }

    /// label line `2i-1` (small) + data line `2i` (large) of row `i` in 1..=6.
    fn row(&mut self, i: usize, ll: &str, l: &str, cl: Col, lr: &str, r: &str, cr: Col) {
        self.put(2 * i - 1, Align::Left, true, Col::White, ll);
        self.put(2 * i - 1, Align::Right, true, Col::White, lr);
        self.put(2 * i, Align::Left, false, cl, l);
        self.put(2 * i, Align::Right, false, cr, r);
    }

    fn value_or_box(v: u32) -> String {
        if v == 0 {
            "[ ]".to_string()
        } else {
            v.to_string()
        }
    }

    /// Rebuild the CRT contents from the current page + flight data.
    pub fn rebuild(&mut self, f: &Flight) {
        self.items.clear();
        if !self.powered {
            return;
        }
        let fm = &f.fm;
        let st = self.store.clone();
        let mut t = String::with_capacity(32);
        let tn = self.page.pages(f.plan.len().saturating_sub(f.active_wp));
        let sub = self.sub.min(tn.saturating_sub(1));
        self.sub = sub;
        // title (+ page number on multi-page pages)
        match self.page {
            Page::Init => {
                let _ = write!(t, "INIT");
                self.put(0, Align::Centre, false, Col::White, &t);
                self.put(0, Align::Right, false, Col::White, if sub == 0 { "A" } else { "B" });
            }
            Page::Perf => {
                let name = ["TAKE OFF", "CLB", "CRZ", "DES", "APPR"][sub];
                self.put(0, Align::Centre, false, Col::White, name);
            }
            p => self.put(0, Align::Centre, false, Col::White, p.title()),
        }
        let wpt = |w: &crate::geo::Waypoint| w.name.clone();
        match (self.page, sub) {
            (Page::Menu, _) => {
                for (i, n) in ["<INIT", "<F-PLN", "<PERF", "<PROG", "<DATA", "<RAD NAV"].iter().enumerate() {
                    self.row(i + 1, "", n, Col::Green, "", "", Col::Green);
                }
                self.put(1, Align::Right, true, Col::White, "FMGC");
            }
            (Page::Init, 0) => {
                // layout matches the line-select mapping of the TS unit: R1 CRZ FL, L2 FLT NBR, R3 ZFW, L5 COST INDEX, R5 PERF
                let ft = format!("{}/{}", f.dep.icao, f.arr.icao);
                self.row(1, "CO RTE", "-----------", Col::Cyan, "CRZ FL/TEMP", &format!("FL{}/-56\u{b0}", st.crz), Col::Cyan);
                self.row(2, "FLT NBR", &st.flt, Col::Cyan, "ALTN/CO RTE", "----/---------", Col::Cyan);
                self.row(3, "FROM/TO", &ft, Col::Cyan, "ZFW/ZFWCG", &format!("{:.1}/ 25.0", st.zfw), Col::Cyan);
                self.row(4, "LAT", "----.-", Col::White, "LONG", "-----.-", Col::White);
                self.row(5, "COST INDEX", &st.ci.to_string(), Col::Cyan, "", "PERF>", Col::Cyan);
                self.row(6, "", "", Col::White, "", "ALIGN IRS>", Col::Cyan);
            }
            (Page::Init, _) => {
                let fob = fm.fuel / 1000.0;
                self.row(1, "TAXI", "0.4", Col::Cyan, "ZFW", &format!("{:.1}", st.zfw), Col::Green);
                self.row(2, "TRIP", &format!("{:.1}", (f.dist_to_go() / 1852.0 * 0.0275).max(0.0)), Col::Green, "RTE RSV", "0.6", Col::Cyan);
                let blk = if st.block > 0.0 { format!("{:.1}", st.block) } else { "[ ]".to_string() };
                self.row(3, "BLOCK", &blk, Col::Cyan, "FOB", &format!("{fob:.1}"), Col::Green);
                self.row(4, "FINAL", "2.4", Col::Cyan, "GW", &format!("{:.1}", fm.mass / 1000.0), Col::Green);
                self.row(6, "", "<INIT A", Col::White, "", "", Col::White);
            }
            (Page::FPln, _) => {
                let from = if f.active_wp > 0 { f.plan.get(f.active_wp - 1).map(wpt).unwrap_or_default() } else { "PPOS".into() };
                self.put(1, Align::Left, true, Col::White, "FROM");
                let hdg = format!("{:03}\u{b0}", fm.heading.rem_euclid(360.0).round() as i32);
                self.row(1, "", &from, Col::White, "", &hdg, Col::Green);
                let rest: Vec<(usize, &crate::geo::Waypoint)> = route_names(f).skip(sub).take(5).collect();
                let mut prev = (f.lat, f.lon);
                if sub > 0 {
                    if let Some((_, w)) = route_names(f).nth(sub - 1) {
                        prev = (w.lat, w.lon);
                    }
                }
                let mut rows = Vec::with_capacity(5);
                for (k, (_, w)) in rest.iter().enumerate() {
                    let d = haversine(prev.0, prev.1, w.lat, w.lon) / 1852.0;
                    prev = (w.lat, w.lon);
                    let cons = if w.alt_m > 0.0 { format!("{:>5}", (w.alt_m / FT / 10.0).round() as i64 * 10) } else { String::new() };
                    rows.push((w.name.clone(), if k == 0 && sub == 0 { "TO".to_string() } else { format!("{d:.0}NM") }, cons, k == 0 && sub == 0));
                }
                let n = rows.len();
                for (k, (name, dist, cons, active)) in rows.into_iter().enumerate() {
                    self.row(k + 2, "", &name, if active { Col::Magenta } else { Col::Green }, &dist, &cons, Col::Green);
                }
                if n < 5 {
                    self.put(2 * (n + 2), Align::Centre, false, Col::White, "-----END OF F-PLN-----");
                }
            }
            (Page::Perf, 0) => {
                let flap = ["0", "1", "2", "3", "FULL"][f.fm.ctl.flaps_idx.min(4)];
                self.row(1, "V1", &Self::value_or_box(st.v1), Col::Cyan, "FLAP/THS", &format!("{flap}/UP0.0"), Col::Cyan);
                self.row(2, "VR", &Self::value_or_box(st.vr), Col::Cyan, "FLEX TO TEMP", &format!("{}\u{b0}", st.flex), Col::Cyan);
                self.row(3, "V2", &Self::value_or_box(st.v2), Col::Cyan, "ENG OUT ACC", "1500/1500", Col::Cyan);
                self.row(4, "TRANS ALT", &st.trans.to_string(), Col::Cyan, "THR RED/ACC", "1500/1500", Col::Cyan);
                let vapp = fbw::envelope(fm).vls + 5.0;
                self.row(5, "GW", &format!("{:.1}", fm.mass / 1000.0), Col::Green, "VAPP", &format!("{}", vapp.round() as i32), Col::Green);
                self.row(6, "", "<PHASE", Col::White, "", "NEXT PHASE>", Col::White);
            }
            (Page::Perf, p) => {
                let env = fbw::envelope(fm);
                let cruise_mach = format!(".{:02}", ((0.78_f64) * 100.0).round() as i32 % 100);
                match p {
                    1 => {
                        self.row(1, "ACT MODE", "MANAGED", Col::Magenta, "CI", &st.ci.to_string(), Col::Cyan);
                        self.row(2, "SPD", "250/.78", Col::Magenta, "ALT", &format!("{:.0}", f.ap.alt_ft), Col::Cyan);
                        self.row(3, "V/S LIM", "2000", Col::Green, "", "", Col::White);
                    }
                    2 => {
                        self.row(1, "CRZ FL", &format!("FL{}", st.crz), Col::Cyan, "CI", &st.ci.to_string(), Col::Cyan);
                        self.row(2, "MACH", &cruise_mach, Col::Magenta, "IAS", &format!("{:.0}", fm.ias / KT), Col::Green);
                    }
                    3 => {
                        self.row(1, "DES MODE", "MANAGED", Col::Magenta, "CI", &st.ci.to_string(), Col::Cyan);
                        self.row(2, "SPD", "/.78/300", Col::Magenta, "ALT", &format!("{:.0}", f.ap.alt_ft), Col::Cyan);
                    }
                    _ => {
                        self.row(1, "QNH", &format!("{:.0}", f.weather.qnh), Col::Cyan, "TEMP", "15\u{b0}", Col::Cyan);
                        self.row(2, "VLS", &format!("{:.0}", env.vls), Col::Amber, "VAPP", &format!("{:.0}", env.vls + 5.0), Col::Green);
                        self.row(3, "FINAL", "", Col::Cyan, "LDG CONF", ["CONF 3", "FULL"][(f.fm.ctl.flaps_idx >= 4) as usize], Col::Green);
                    }
                }
                self.row(6, "", "<PHASE", Col::White, "", "NEXT PHASE>", Col::White);
            }
            (Page::Prog, _) => {
                let fl = (fm.pos.y / FT / 100.0).round() as i64;
                self.put(0, Align::Right, false, Col::White, &format!("FL{fl}"));
                self.row(1, "CRZ", &format!("FL{}", st.crz), Col::Cyan, "OPT   REC MAX", "", Col::White);
                let dist = f.dist_to_go() / 1852.0;
                self.row(2, "TO", &f.arr.icao, Col::Green, "DIST    EFOB", &format!("{:.0}   {:.1}", dist, fm.fuel / 1000.0), Col::Green);
                let (nm, nd) = f.next_wp().map(|(w, d, _)| (w.name.clone(), format!("{:.0}NM", d / 1852.0))).unwrap_or(("----".into(), String::new()));
                self.row(3, "BRG/DIST", &nm, Col::Green, "", &nd, Col::Green);
                let ete_min = f.next_wp().map(|(_, _, e)| e / 60.0).unwrap_or(0.0);
                let utc = f.utc();
                let m = (utc / 60.0).floor() as i64 + ete_min.round() as i64;
                self.row(4, "XTK ERROR", "0.0", Col::Green, "ETA", &format!("{:02}{:02}", (m / 60) % 24, m % 60), Col::Green);
            }
            (Page::RadNav, _) => {
                self.row(1, "VOR1/FREQ", "---/--.--", Col::Cyan, "FREQ/VOR2", "--.--/---", Col::Cyan);
                self.row(2, "CRS", "---", Col::Cyan, "CRS", "---", Col::Cyan);
                let ils = if f.ils.valid { format!("{}/ ---", f.arr_end.ident) } else { "[ ]/[  ]".into() };
                self.row(3, "LS /FREQ", &ils, Col::Magenta, "", "", Col::White);
                let crs = if f.ils.valid { format!("{:03}", f.ils.course.round() as i32) } else { "---".into() };
                self.row(4, "CRS", &crs, Col::Cyan, "", "", Col::White);
            }
            (Page::Fuel, _) => {
                self.row(1, "AT", &f.arr.icao, Col::Green, "EFOB", &format!("{:.1}", (fm.fuel / 1000.0 - 1.2).max(0.0)), Col::Green);
                self.row(2, "FOB", &format!("{:.1}", fm.fuel / 1000.0), Col::Green, "FLOW", &format!("{} KG/H", (fm.fuel_flow * 3600.0).round() as i64), Col::Green);
                self.row(3, "RTE RSV", "0.6", Col::Cyan, "FINAL", "2.4", Col::Cyan);
            }
            (Page::Data, _) => {
                for (i, n) in ["<POSITION MONITOR", "<IRS MONITOR", "<GPS MONITOR", "<A/C STATUS"].iter().enumerate() {
                    self.row(i + 1, "", n, Col::White, "", "", Col::White);
                }
                self.put(10, Align::Centre, false, Col::White, "A320-214 CFM56-5B4/P");
            }
            (Page::DataPos, _) => {
                let (la, lo) = (f.lat, f.lon);
                self.row(1, "FMGC POS", &fmt_pos(la, lo), Col::Green, "", "", Col::White);
                self.row(2, "GPIRS", &fmt_pos(la, lo), Col::Green, "", "", Col::White);
                self.row(3, "MIX IRS", &fmt_pos(la, lo), Col::Green, "", "", Col::White);
                self.row(6, "", "<RETURN", Col::White, "", "", Col::White);
            }
            (Page::DataIrs, _) => {
                for i in 1..=3 {
                    self.row(i, &format!("IRS {i}"), "NAV", Col::Green, "STATUS", "ALIGNED", Col::Green);
                }
                self.row(6, "", "<RETURN", Col::White, "", "", Col::White);
            }
            (Page::DataGps, _) => {
                self.row(1, "GPS1", "NAV", Col::Green, "SATS", "12", Col::Green);
                self.row(2, "GPS2", "NAV", Col::Green, "SATS", "11", Col::Green);
                self.row(6, "", "<RETURN", Col::White, "", "", Col::White);
            }
            (Page::DataStatus, _) => {
                self.row(1, "ENG", "CFM56-5B4/P", Col::Green, "", "", Col::White);
                self.row(2, "ACTIVE DATA BASE", "", Col::White, "", "AIRAC 2411", Col::Cyan);
                self.row(6, "", "<RETURN", Col::White, "", "", Col::White);
            }
            (Page::Dir, _) => {
                self.row(1, "", "[    ]", Col::Cyan, "", "", Col::White);
                for (k, (_, w)) in route_names(f).take(4).enumerate() {
                    self.row(k + 2, "", &w.name, Col::Green, "", "", Col::White);
                }
            }
            (Page::Sec, _) => {
                self.row(1, "", "<COPY ACTIVE", Col::Cyan, "", "", Col::White);
                self.row(2, "", "<INIT", Col::Cyan, "", "", Col::White);
                self.put(8, Align::Centre, false, Col::White, "SECONDARY F-PLN NOT CREATED");
            }
            (Page::Airport, _) => {
                self.row(1, "", &f.arr.icao, Col::Green, "", &f.arr.name.chars().take(14).collect::<String>(), Col::White);
                self.row(2, "", &f.dep.icao, Col::Green, "", &f.dep.name.chars().take(14).collect::<String>(), Col::White);
                let _ = WpType::Tod;
            }
            (Page::Atc, _) => {
                self.put(6, Align::Centre, false, Col::White, "ATSU NOT AVAILABLE");
            }
        }
        // scratchpad / message line (cursor blink is done by the renderer)
        if let Some((m, _)) = &self.msg {
            let m = m.clone();
            self.put(13, Align::Left, false, Col::Amber, &m);
        } else {
            let s = self.scratch.clone();
            self.put(13, Align::Left, false, Col::White, &s);
        }
    }
}

fn fmt_pos(lat: f64, lon: f64) -> String {
    format!("{}{:02}\u{b0}{:04.1} {}{:03}\u{b0}{:04.1}", if lat >= 0.0 { 'N' } else { 'S' }, lat.abs().trunc() as i32, lat.abs().fract() * 60.0, if lon >= 0.0 { 'E' } else { 'W' }, lon.abs().trunc() as i32, lon.abs().fract() * 60.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::airports::AirportDb;

    const T0: f64 = 1_718_884_800.0;

    fn flight() -> Flight {
        Flight::new(&AirportDb::embedded(), "KSFO", "KOAK", T0).expect("flight")
    }

    fn type_str(m: &mut Mcdu, f: &mut Flight, s: &str) {
        for c in s.chars() {
            let k = match c {
                ' ' => "sp".to_string(),
                c if c.is_ascii_uppercase() => c.to_ascii_lowercase().to_string(),
                c => c.to_string(),
            };
            assert!(m.key(&k, f), "key {k}");
        }
    }

    fn texts(m: &Mcdu) -> Vec<String> {
        m.items().iter().map(|i| i.text.clone()).collect()
    }

    #[test]
    fn page_keys_select_pages() {
        let mut f = flight();
        let mut m = Mcdu::new();
        for (k, p) in [
            ("init", Page::Init),
            ("f-pln", Page::FPln),
            ("f-pln2", Page::Sec),
            ("sec-fpln", Page::Sec),
            ("radnav", Page::RadNav),
            ("fuel-pred", Page::Fuel),
            ("prog", Page::Prog),
            ("perf", Page::Perf),
            ("data", Page::Data),
            ("dir", Page::Dir),
            ("airport", Page::Airport),
            ("atc", Page::Atc),
            ("mcdu", Page::Menu),
        ] {
            assert!(m.key(k, &mut f));
            assert_eq!(m.page, p, "key {k}");
            assert!(!m.items().is_empty());
        }
    }

    #[test]
    fn every_model_key_is_accepted() {
        let mut f = flight();
        let mut m = Mcdu::new();
        let mut keys: Vec<String> = ('a'..='z').chain('0'..='9').map(|c| c.to_string()).collect();
        for n in 1..=6 {
            keys.push(format!("L{n}"));
            keys.push(format!("R{n}"));
        }
        for k in ["init", "f-pln", "f-pln2", "radnav", "fuel-pred", "prog", "perf", "data", "dir", "airport", "clr", "sp", "left", "right", "up", "down", "opt1", "opt2", "overfly", "+/-", "/", ".", "", "mcdu", "sec-fpln", "BRT", "DIM", "atc"] {
            keys.push(k.to_string());
        }
        assert_eq!(keys.len(), 26 + 10 + 12 + 28);
        for k in &keys {
            assert!(is_key_name(k), "{k}");
            assert!(m.key(&format!("{k}.cpt"), &mut f) || k.is_empty() && m.key(".", &mut f), "{k}");
        }
        assert_eq!(m.presses as usize, keys.len());
        assert!(!m.key("nonsense", &mut f));
    }

    #[test]
    fn scratchpad_typing_sign_clear_and_overflow() {
        let mut f = flight();
        let mut m = Mcdu::new();
        type_str(&mut m, &mut f, "AB12");
        assert_eq!(m.scratch, "AB12");
        m.key("/", &mut f);
        m.key(".", &mut f);
        m.key("sp", &mut f);
        assert_eq!(m.scratch, "AB12/. ");
        m.key("clr", &mut f);
        m.key("clr", &mut f);
        m.key("clr", &mut f);
        assert_eq!(m.scratch, "AB12");
        // +/- appends '-', then toggles the sign
        m.key("+/-", &mut f);
        assert!(m.scratch.ends_with('-'));
        m.key("+/-", &mut f);
        assert!(m.scratch.ends_with('+'));
        m.key("+/-", &mut f);
        assert!(m.scratch.ends_with('-'));
        for _ in 0..40 {
            m.key("a", &mut f);
        }
        assert_eq!(m.scratch.chars().count(), SCRATCH_MAX);
        assert_eq!(m.message(), Some("SCRATCHPAD FULL"));
        // CLR clears the message first and leaves the text alone
        let n = m.scratch.len();
        m.key("clr", &mut f);
        assert!(!m.has_msg() && m.scratch.len() == n);
        // the scratchpad shows up in the last line
        assert!(m.items().iter().any(|i| i.line == 13 && i.text == m.scratch));
    }

    #[test]
    fn init_page_entries_and_ranges() {
        let mut f = flight();
        let mut m = Mcdu::new();
        m.key("init", &mut f);
        // flight number (L2)
        type_str(&mut m, &mut f, "DLH123");
        m.key("L2", &mut f);
        assert_eq!(m.store.flt, "DLH123");
        assert!(m.scratch.is_empty());
        // CRZ FL (R1): FL prefix accepted, drives the FCU altitude
        type_str(&mut m, &mut f, "FL340");
        m.key("R1", &mut f);
        assert_eq!(m.store.crz, 340);
        assert_eq!(f.ap.alt_ft, 34000.0);
        // out of range keeps the entry and warns
        type_str(&mut m, &mut f, "50");
        m.key("R1", &mut f);
        assert_eq!(m.store.crz, 340);
        assert_eq!(m.message(), Some("ENTRY OUT OF RANGE"));
        assert_eq!(m.scratch, "50");
        m.key("clr", &mut f);
        m.key("clr", &mut f);
        m.key("clr", &mut f);
        assert!(m.scratch.is_empty());
        // format error
        type_str(&mut m, &mut f, "XYZ");
        m.key("L5", &mut f);
        assert_eq!(m.message(), Some("FORMAT ERROR"));
        m.key("clr", &mut f);
        m.key("clr", &mut f);
        m.key("clr", &mut f);
        m.key("clr", &mut f);
        // cost index, then an empty-scratchpad push copies the stored value back
        type_str(&mut m, &mut f, "80");
        m.key("L5", &mut f);
        assert_eq!(m.store.ci, 80);
        m.key("L5", &mut f);
        assert_eq!(m.scratch, "80");
        // an entry on a line that takes none is refused
        m.key("clr", &mut f);
        m.key("clr", &mut f);
        type_str(&mut m, &mut f, "1");
        m.key("R4", &mut f);
        assert_eq!(m.message(), Some("NOT ALLOWED"));
        // R5 jumps to PERF, ZFW on R3
        m.key("clr", &mut f);
        m.key("clr", &mut f);
        type_str(&mut m, &mut f, "64.2");
        m.key("R3", &mut f);
        assert!((m.store.zfw - 64.2).abs() < 1e-9);
        m.key("R5", &mut f);
        assert_eq!(m.page, Page::Perf);
    }

    #[test]
    fn init_b_page_via_arrows() {
        let mut f = flight();
        let mut m = Mcdu::new();
        m.key("init", &mut f);
        m.key("down", &mut f);
        assert_eq!(m.sub, 1);
        assert!(m.items().iter().any(|i| i.text == "B"));
        type_str(&mut m, &mut f, "7.5");
        m.key("L3", &mut f);
        assert!((m.store.block - 7.5).abs() < 1e-9);
        m.key("up", &mut f);
        assert_eq!(m.sub, 0);
        m.key("up", &mut f);
        assert_eq!(m.sub, 0, "no page before A");
    }

    #[test]
    fn perf_takeoff_speeds_and_phases() {
        let mut f = flight();
        let mut m = Mcdu::new();
        m.key("perf", &mut f);
        for (digits, key, get) in [("135", "L1", 0), ("140", "L2", 1), ("145", "L3", 2)] {
            type_str(&mut m, &mut f, digits);
            m.key(key, &mut f);
            let v = [m.store.v1, m.store.vr, m.store.v2][get];
            assert_eq!(v.to_string(), digits);
        }
        // V1 below 90 is out of range
        type_str(&mut m, &mut f, "50");
        m.key("L1", &mut f);
        assert_eq!(m.store.v1, 135);
        assert!(m.has_msg());
        m.key("clr", &mut f);
        m.key("clr", &mut f);
        m.key("clr", &mut f);
        type_str(&mut m, &mut f, "62");
        m.key("R2", &mut f);
        assert_eq!(m.store.flex, 62);
        m.key("clr", &mut f);
        m.key("clr", &mut f);
        // NEXT PHASE> / <PHASE walk the five phases
        for want in 1..=4 {
            m.key("R6", &mut f);
            assert_eq!(m.sub, want);
        }
        m.key("R6", &mut f);
        assert_eq!(m.sub, 4);
        for want in (0..4).rev() {
            m.key("L6", &mut f);
            assert_eq!(m.sub, want);
        }
        assert!(texts(&m).iter().any(|t| t == "135"));
    }

    #[test]
    fn menu_and_data_index_navigation() {
        let mut f = flight();
        let mut m = Mcdu::new();
        for (n, p) in [(1, Page::Init), (2, Page::FPln), (3, Page::Perf), (4, Page::Prog), (5, Page::Data), (6, Page::RadNav)] {
            m.key("mcdu", &mut f);
            m.key(&format!("L{n}"), &mut f);
            assert_eq!(m.page, p);
        }
        m.key("data", &mut f);
        for (n, p) in [(1, Page::DataPos), (2, Page::DataIrs), (3, Page::DataGps), (4, Page::DataStatus)] {
            m.key("data", &mut f);
            m.key(&format!("L{n}"), &mut f);
            assert_eq!(m.page, p);
            assert!(!m.items().is_empty());
            m.key("L6", &mut f);
            assert_eq!(m.page, Page::Data);
        }
        // right-hand keys on the menu do nothing
        m.key("mcdu", &mut f);
        m.key("R1", &mut f);
        assert_eq!(m.page, Page::Menu);
    }

    #[test]
    fn fpln_scrolls_and_dir_to_retargets_the_active_waypoint() {
        let mut f = flight();
        let mut m = Mcdu::new();
        m.key("f-pln", &mut f);
        let n = f.plan.len() - f.active_wp;
        assert!(n >= 3, "plan has legs");
        m.key("down", &mut f);
        assert_eq!(m.sub, 1);
        for _ in 0..50 {
            m.key("right", &mut f);
        }
        assert_eq!(m.sub, n - 1, "scroll stops at the last leg");
        for _ in 0..50 {
            m.key("left", &mut f);
        }
        assert_eq!(m.sub, 0);
        // empty-scratchpad LSK echoes the leg name
        m.key("L2", &mut f);
        assert!(m.message().is_some_and(|s| s.ends_with("SELECTED")));
        // DIR TO page: LSK3 = second leg of the route
        let target = f.active_wp + 1;
        let name = f.plan[target].name.clone();
        m.key("dir", &mut f);
        m.key("L3", &mut f);
        assert_eq!(f.active_wp, target);
        assert_eq!(m.page, Page::FPln);
        assert_eq!(m.message(), Some(format!("DIRECT TO {name}").as_str()));
        // typed waypoint name via LSK1; unknown names are rejected
        let name2 = f.plan[target + 1].name.clone();
        m.key("dir", &mut f);
        type_str(&mut m, &mut f, &name2.to_ascii_uppercase().replace('-', "").replace('_', ""));
        m.key("L1", &mut f);
        if f.plan[target + 1].name.chars().all(|c| c.is_ascii_alphanumeric()) {
            assert_eq!(f.active_wp, target + 1);
        }
        m.key("dir", &mut f);
        type_str(&mut m, &mut f, "QQQQQ");
        m.key("L1", &mut f);
        assert_eq!(m.message(), Some("NOT IN DATABASE"));
    }

    #[test]
    fn brightness_keys_step_and_clamp() {
        let mut f = flight();
        let mut m = Mcdu::new();
        for _ in 0..10 {
            m.key("DIM", &mut f);
        }
        assert!((m.brt - 0.15).abs() < 1e-6);
        m.key("BRT", &mut f);
        assert!((m.brt - 0.30).abs() < 1e-6);
        for _ in 0..10 {
            m.key("BRT", &mut f);
        }
        assert_eq!(m.brt, 1.0);
    }

    #[test]
    fn messages_time_out_and_power_loss_blanks_the_unit() {
        let mut f = flight();
        let mut m = Mcdu::new();
        m.key("init", &mut f);
        type_str(&mut m, &mut f, "9");
        m.key("R4", &mut f);
        assert!(m.has_msg());
        m.update(1.0, true, &f);
        assert!(m.has_msg());
        m.update(3.0, true, &f);
        assert!(!m.has_msg(), "message expires after {MSG_TTL} s");
        type_str(&mut m, &mut f, "5");
        m.update(0.1, false, &f);
        assert!(m.items().is_empty());
        assert!(!m.key("a", &mut f), "an unpowered MCDU ignores keys");
        m.update(0.1, true, &f);
        assert!(m.scratch.is_empty() && !m.items().is_empty());
        assert_eq!(m.store.crz, 350, "stored data survive a power cycle");
    }

    #[test]
    fn every_page_renders_inside_the_24x14_grid() {
        let mut f = flight();
        let mut m = Mcdu::new();
        for p in [Page::Menu, Page::Init, Page::FPln, Page::Perf, Page::Prog, Page::RadNav, Page::Fuel, Page::Data, Page::Dir, Page::Sec, Page::Airport, Page::Atc, Page::DataPos, Page::DataIrs, Page::DataGps, Page::DataStatus] {
            for sub in 0..p.pages(5).max(1) {
                m.page = p;
                m.sub = sub;
                m.rebuild(&f);
                assert!(!m.items().is_empty(), "{p:?}/{sub}");
                for it in m.items() {
                    assert!((it.line as usize) < LINES, "{p:?} line {}", it.line);
                    assert!(it.text.chars().count() <= COLS, "{p:?}: {:?}", it.text);
                    assert!(it.text.is_ascii(), "{p:?}: {:?} is not drawable with the ASCII font", it.text);
                }
                // left and right texts on the same line must not overlap
                for a in m.items() {
                    for b in m.items() {
                        if a.line == b.line && a.align == Align::Left && b.align == Align::Right && a.small == b.small {
                            assert!(a.text.chars().count() + b.text.chars().count() <= COLS + 1, "{p:?} line {}: {:?} / {:?}", a.line, a.text, b.text);
                        }
                    }
                }
            }
        }
        // airborne state renders too
        f.apply(crate::game::Action::ApAutoTakeoff);
        for _ in 0..600 {
            f.advance(1.0 / 60.0, &Default::default());
        }
        for p in [Page::FPln, Page::Prog, Page::Perf, Page::Fuel, Page::RadNav] {
            m.page = p;
            m.rebuild(&f);
            assert!(!m.items().is_empty());
        }
    }
}
