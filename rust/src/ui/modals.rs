//! Modal windows: settings (graphics / audio / flight / interface / captions), keyboard controls reference and the pilot
//! logbook (ports of `MsfsWindows.tsx` and `SettingsPanels.tsx`). Settings and the logbook persist as small text files in
//! `$INFLIGHT_HOME` (default `~/.inflight/`).

use super::{alpha, BtnKind, Gui, ACCENT, AMBER, DIM, GREEN, LINE, LINE_HI, MUTED, PANEL, RED, TEXT};
use crate::gfx::ui::HELP;
use std::fmt::Write;
use std::path::PathBuf;

// ------------------------------------------------------------------------------------------------ settings model

pub const QUALITY_NAMES: [&str; 5] = ["Low", "Medium", "High", "Ultra", "Auto"];
const QUALITY_TAGS: [&str; 5] = ["Satellite terrain", "+ 3D trees", "+ Buildings", "+ Houses", "Best for device"];
const QUALITY_SUMMARY: [&str; 5] = [
    "Terrain clipmaps, runways and the aircraft only. Lightest on the GPU.",
    "Adds 3D trees around the airfield.",
    "Adds city buildings - the recommended desktop tier.",
    "Adds houses and the full scatter density.",
    "Picks High on desktop and scales down automatically to hold 60 FPS.",
];
pub const UI_SCALES: [f32; 4] = [0.75, 1.0, 1.25, 1.5];

#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub quality: u8,
    pub fov: f32,
    pub volume: f32,
    pub muted: bool,
    pub voice: bool,
    pub assist: bool,
    pub invert_pitch: bool,
    pub sens: f32,
    pub shake: bool,
    pub hints: bool,
    pub hud_mode: u8,
    pub metric: bool,
    pub ui_scale: u8,
    pub name: String,
    pub captions: bool,
    pub caption_lang: u8,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            quality: 4,
            fov: 62.0,
            volume: 0.8,
            muted: false,
            voice: true,
            assist: true,
            invert_pitch: false,
            sens: 1.0,
            shake: true,
            hints: true,
            hud_mode: 1,
            metric: false,
            ui_scale: 1,
            name: "PILOT".into(),
            captions: true,
            caption_lang: 0,
        }
    }
}

pub fn config_dir() -> PathBuf {
    if let Ok(p) = std::env::var("INFLIGHT_HOME") {
        return PathBuf::from(p);
    }
    match std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        Ok(h) => PathBuf::from(h).join(".inflight"),
        Err(_) => PathBuf::from(".inflight"),
    }
}

impl Settings {
    pub fn to_text(&self) -> String {
        let mut s = String::new();
        let b = |v: bool| if v { 1 } else { 0 };
        let _ = writeln!(s, "quality={}\nfov={}\nvolume={}\nmuted={}\nvoice={}\nassist={}\ninvert_pitch={}\nsens={}\nshake={}\nhints={}\nhud_mode={}\nmetric={}\nui_scale={}\nname={}\ncaptions={}\ncaption_lang={}",
            self.quality, self.fov, self.volume, b(self.muted), b(self.voice), b(self.assist), b(self.invert_pitch), self.sens, b(self.shake), b(self.hints), self.hud_mode, b(self.metric), self.ui_scale, self.name, b(self.captions), self.caption_lang);
        s
    }

    pub fn from_text(t: &str) -> Self {
        let mut s = Self::default();
        for line in t.lines() {
            let Some((k, v)) = line.split_once('=') else { continue };
            let (v, f, on) = (v.trim(), v.trim().parse::<f32>().ok(), v.trim() == "1");
            match k.trim() {
                "quality" => s.quality = f.map_or(s.quality, |x| (x as u8).min(4)),
                "fov" => s.fov = f.map_or(s.fov, |x| x.clamp(40.0, 100.0)),
                "volume" => s.volume = f.map_or(s.volume, |x| x.clamp(0.0, 1.0)),
                "muted" => s.muted = on,
                "voice" => s.voice = on,
                "assist" => s.assist = on,
                "invert_pitch" => s.invert_pitch = on,
                "sens" => s.sens = f.map_or(s.sens, |x| x.clamp(0.5, 1.8)),
                "shake" => s.shake = on,
                "hints" => s.hints = on,
                "hud_mode" => s.hud_mode = f.map_or(s.hud_mode, |x| (x as u8).min(3)),
                "metric" => s.metric = on,
                "ui_scale" => s.ui_scale = f.map_or(s.ui_scale, |x| (x as u8).min(3)),
                "name" => s.name = v.chars().filter(|c| c.is_ascii_graphic() || *c == ' ').take(14).collect(),
                "captions" => s.captions = on,
                "caption_lang" => s.caption_lang = f.map_or(s.caption_lang, |x| (x as u8).min(1)),
                _ => {}
            }
        }
        s
    }

    pub fn load() -> Self {
        std::fs::read_to_string(config_dir().join("settings.cfg")).map(|t| Self::from_text(&t)).unwrap_or_default()
    }

    pub fn save(&self) {
        let dir = config_dir();
        if std::fs::create_dir_all(&dir).is_ok() {
            let _ = std::fs::write(dir.join("settings.cfg"), self.to_text());
        }
    }
}

// ------------------------------------------------------------------------------------------------ logbook

#[derive(Clone, Debug, PartialEq)]
pub struct LogEntry {
    pub utc: f64,
    pub dep: String,
    pub arr: String,
    pub grade: String,
    pub fpm: f64,
    pub speed_kt: f64,
    pub centreline_m: f64,
}

impl LogEntry {
    pub fn to_line(&self) -> String {
        format!("{:.0}\t{}\t{}\t{}\t{:.0}\t{:.0}\t{:.1}", self.utc, self.dep, self.arr, self.grade, self.fpm, self.speed_kt, self.centreline_m)
    }
    pub fn from_line(l: &str) -> Option<Self> {
        let mut it = l.split('\t');
        Some(Self {
            utc: it.next()?.parse().ok()?,
            dep: it.next()?.to_string(),
            arr: it.next()?.to_string(),
            grade: it.next()?.to_string(),
            fpm: it.next()?.parse().ok()?,
            speed_kt: it.next()?.parse().ok()?,
            centreline_m: it.next()?.parse().ok()?,
        })
    }
}

pub fn parse_logbook(t: &str) -> Vec<LogEntry> {
    t.lines().filter_map(LogEntry::from_line).collect()
}

pub fn load_logbook() -> Vec<LogEntry> {
    std::fs::read_to_string(config_dir().join("logbook.tsv")).map(|t| parse_logbook(&t)).unwrap_or_default()
}

pub fn save_logbook(list: &[LogEntry]) {
    let dir = config_dir();
    if std::fs::create_dir_all(&dir).is_ok() {
        let text: String = list.iter().map(|e| e.to_line() + "\n").collect();
        let _ = std::fs::write(dir.join("logbook.tsv"), text);
    }
}

pub fn grade_color(grade: &str) -> [f32; 4] {
    match grade {
        "BUTTER" | "SMOOTH" => GREEN,
        "FIRM" => AMBER,
        _ => RED,
    }
}

/// "2024-06-20 20:10Z" from unix seconds.
pub fn fmt_date(unix: f64) -> String {
    let days = (unix / 86400.0).floor() as i64;
    let (y, m, d) = crate::clock::civil_from_days(days);
    let (hh, mm) = crate::clock::hhmm(unix);
    format!("{y:04}-{m:02}-{d:02} {hh:02}:{mm:02}Z")
}

// ------------------------------------------------------------------------------------------------ windows

const CATEGORIES: [(&str, &str); 5] = [
    ("Graphics", "How much of the 3D world is drawn around the aircraft. Lower tiers stream less and hold frame rate on modest hardware."),
    ("Audio & voice", "Engine, aerodynamic and cockpit sound plus the spoken radio, crew callouts and cabin announcements."),
    ("Flight & controls", "How the aircraft responds to your inputs and how much help you get."),
    ("Interface", "On-screen instruments, text size and units. These apply to the in-flight overlay."),
    ("Captions", "On-screen text for every spoken line, in the style of film subtitles."),
];

pub(super) fn window(g: &mut Gui, w: f32, h: f32, title: &str, close: &mut bool) -> (f32, f32) {
    let (vw, vh) = (g.vw, g.vh);
    g.rect(0.0, 0.0, vw, vh, [0.0, 0.005, 0.015, 0.72]);
    let (x, y) = ((vw - w) * 0.5, (vh - h) * 0.5);
    if g.pressed() && !g.hover(x, y, w, h) {
        *close = true;
    }
    g.rect(x - 1.0, y - 1.0, w + 2.0, h + 2.0, [0.0, 0.0, 0.0, 0.4]);
    g.rect_v(x, y, w, h, [0.055, 0.08, 0.12, 0.98], [0.03, 0.045, 0.07, 0.98]);
    g.frame(x, y, w, h, 1.0, LINE_HI);
    g.rect(x, y, w, 40.0, [1.0, 1.0, 1.0, 0.04]);
    g.line([x, y + 40.0], [x + w, y + 40.0], 1.0, LINE);
    g.rect(x + 14.0, y + 14.0, 4.0, 14.0, ACCENT);
    g.text(x + 28.0, y + 13.0, 15.0, TEXT, 0, title);
    if g.btn(x + w - 40.0, y + 7.0, 28.0, 26.0, "X", BtnKind::Ghost) {
        *close = true;
    }
    (x, y)
}

fn row(g: &mut Gui, x: f32, y: f32, w: f32, label: &str, hint: &str) -> f32 {
    g.text(x, y + 2.0, 12.0, TEXT, 0, label);
    if !hint.is_empty() {
        g.text(x, y + 18.0, 9.5, MUTED, 0, hint);
    }
    g.line([x, y + 36.0], [x + w, y + 36.0], 1.0, [1.0, 1.0, 1.0, 0.05]);
    y + 42.0
}

fn section(g: &mut Gui, x: f32, y: f32, label: &str) -> f32 {
    g.text(x, y, 9.5, ACCENT, 0, &label.to_uppercase());
    y + 20.0
}

#[allow(clippy::too_many_arguments)]
fn settings_window(g: &mut Gui, s: &mut Settings, tab: &mut usize, close: &mut bool, changed: &mut bool) {
    let (w, h) = (780.0f32, 480.0f32);
    let (x, y) = window(g, w, h, "SETTINGS", close);
    let before = s.clone();
    // nav
    for (i, (label, _)) in CATEGORIES.iter().enumerate() {
        let (nx, ny) = (x + 12.0, y + 54.0 + i as f32 * 38.0);
        let on = *tab == i;
        let hov = g.hover(nx, ny, 170.0, 32.0);
        g.rect(nx, ny, 170.0, 32.0, if on { alpha(ACCENT, 0.18) } else if hov { [1.0, 1.0, 1.0, 0.06] } else { [0.0; 4] });
        if on {
            g.rect(nx, ny, 3.0, 32.0, ACCENT);
        }
        g.text(nx + 14.0, ny + 10.0, 12.0, if on { TEXT } else { DIM }, 0, label);
        if g.clicked(nx, ny, 170.0, 32.0) {
            *tab = i;
        }
    }
    g.line([x + 196.0, y + 40.0], [x + 196.0, y + h], 1.0, LINE);
    let (px, pw) = (x + 214.0, w - 214.0 - 22.0);
    let mut py = y + 56.0;
    let t = (*tab).min(4);
    g.text(px, py - 2.0, 18.0, TEXT, 0, CATEGORIES[t].0);
    // wrap the lead line manually at ~86 chars
    let lead = CATEGORIES[t].1;
    let cut = lead.char_indices().take_while(|(i, _)| *i < 88).last().map_or(lead.len(), |(i, _)| i);
    let split = if lead.len() > 88 { lead[..cut].rfind(' ').unwrap_or(cut) } else { lead.len() };
    g.text(px, py + 22.0, 10.0, DIM, 0, &lead[..split]);
    if split < lead.len() {
        g.text(px, py + 35.0, 10.0, DIM, 0, lead[split..].trim_start());
    }
    py += 62.0;
    match t {
        0 => {
            let cw = (pw - 4.0 * 8.0) / 5.0;
            for i in 0..5 {
                let cx = px + i as f32 * (cw + 8.0);
                let on = s.quality as usize == i;
                let hov = g.hover(cx, py, cw, 62.0);
                g.rect(cx, py, cw, 62.0, if on { alpha(ACCENT, 0.18) } else if hov { [1.0, 1.0, 1.0, 0.07] } else { PANEL });
                g.frame(cx, py, cw, 62.0, if on { 2.0 } else { 1.0 }, if on { ACCENT } else { LINE });
                if i < 4 {
                    for b in 0..4 {
                        let bh = 5.0 + 3.0 * b as f32;
                        g.rect(cx + 10.0 + b as f32 * 6.0, py + 24.0 - bh + 4.0, 4.0, bh, if b <= i { ACCENT } else { [1.0, 1.0, 1.0, 0.18] });
                    }
                } else {
                    g.text(cx + 10.0, py + 8.0, 13.0, AMBER, 0, "AUTO");
                }
                g.text(cx + 10.0, py + 32.0, 12.0, TEXT, 0, QUALITY_NAMES[i]);
                let tag: String = QUALITY_TAGS[i].chars().take(((cw - 14.0) / 5.8) as usize).collect();
                g.text(cx + 10.0, py + 48.0, 9.0, MUTED, 0, &tag);
                if g.clicked(cx, py, cw, 62.0) {
                    s.quality = i as u8;
                }
            }
            py += 76.0;
            g.rect(px, py, pw, 50.0, [1.0, 1.0, 1.0, 0.04]);
            g.frame(px, py, pw, 50.0, 1.0, LINE);
            g.textf(px + 12.0, py + 8.0, 9.5, ACCENT, 0, format_args!("{} DETAIL  -  60 FPS TARGET", QUALITY_NAMES[s.quality as usize].to_uppercase()));
            g.text(px + 12.0, py + 26.0, 10.5, DIM, 0, QUALITY_SUMMARY[s.quality as usize]);
            py += 64.0;
            py = section(g, px, py, "Camera");
            let ny = py;
            py = row(g, px, py, pw, "Cockpit field of view", "Vertical FOV of the flight-deck camera.");
            s.fov = g.slider(px + pw - 220.0, ny + 6.0, 170.0, s.fov, 40.0, 100.0).round();
            g.textf(px + pw, ny + 4.0, 12.0, TEXT, 2, format_args!("{:.0} deg", s.fov));
            let _ = py;
        }
        1 => {
            py = section(g, px, py, "Output");
            let ny = py;
            py = row(g, px, py, pw, "Master volume", "");
            s.volume = (g.slider(px + pw - 220.0, ny + 4.0, 170.0, s.volume, 0.0, 1.0) * 20.0).round() / 20.0;
            g.textf(px + pw, ny + 2.0, 12.0, TEXT, 2, format_args!("{:.0}%", s.volume * 100.0));
            let ny = py;
            py = row(g, px, py, pw, "Mute all audio", "");
            s.muted = g.switch(px + pw - 38.0, ny + 2.0, s.muted);
            py = section(g, px, py + 8.0, "Voice");
            let ny = py;
            py = row(g, px, py, pw, "Spoken voice", "ATC, pilot readbacks, crew callouts, cabin PA and GPWS.");
            s.voice = g.switch(px + pw - 38.0, ny + 2.0, s.voice);
            g.text(px, py + 8.0, 10.0, MUTED, 0, "Speech is always English, as on a real frequency.");
        }
        2 => {
            py = section(g, px, py, "Handling");
            let ny = py;
            py = row(g, px, py, pw, "Flight assist", "Stability and envelope protection.");
            s.assist = g.switch(px + pw - 38.0, ny + 2.0, s.assist);
            let ny = py;
            py = row(g, px, py, pw, "Invert pitch", "Off: pushing forward pitches the nose down.");
            s.invert_pitch = g.switch(px + pw - 38.0, ny + 2.0, s.invert_pitch);
            let ny = py;
            py = row(g, px, py, pw, "Control sensitivity", "");
            s.sens = (g.slider(px + pw - 220.0, ny + 4.0, 170.0, s.sens, 0.5, 1.8) * 10.0).round() / 10.0;
            g.textf(px + pw, ny + 2.0, 12.0, TEXT, 2, format_args!("{:.1}x", s.sens));
            py = section(g, px, py + 8.0, "Camera & guidance");
            let ny = py;
            py = row(g, px, py, pw, "Cockpit camera shake", "Subtle motion from turbulence and ground roll.");
            s.shake = g.switch(px + pw - 38.0, ny + 2.0, s.shake);
            let ny = py;
            let _ = row(g, px, py, pw, "Instructor hints", "Coaching tips during take-off, approach and landing.");
            s.hints = g.switch(px + pw - 38.0, ny + 2.0, s.hints);
        }
        3 => {
            py = section(g, px, py, "Flight display");
            let ny = py;
            py = row(g, px, py, pw, "HUD mode", "Minimal / Standard / Assisted / Cockpit 3D");
            s.hud_mode = g.segmented(px + pw - 330.0, ny + 2.0, 330.0, 24.0, &["Minimal", "Standard", "Assisted", "Cockpit"], s.hud_mode as usize) as u8;
            let ny = py;
            py = row(g, px, py, pw, "Units", "");
            s.metric = g.segmented(px + pw - 200.0, ny + 2.0, 200.0, 24.0, &["kt - ft", "km/h - m"], s.metric as usize) == 1;
            py = section(g, px, py + 8.0, "Readability");
            let ny = py;
            py = row(g, px, py, pw, "Text size", "");
            s.ui_scale = g.segmented(px + pw - 330.0, ny + 2.0, 330.0, 24.0, &["Compact", "Default", "Large", "X-Large"], s.ui_scale as usize) as u8;
            py = section(g, px, py + 8.0, "Pilot");
            let ny = py;
            let _ = row(g, px, py, pw, "Logbook callsign", "Type to edit - 14 characters");
            g.rect(px + pw - 200.0, ny - 2.0, 200.0, 26.0, [0.0, 0.01, 0.03, 1.0]);
            g.frame(px + pw - 200.0, ny - 2.0, 200.0, 26.0, 1.0, ACCENT);
            let cur = if ((g.time * 2.0) as i64) % 2 == 0 { "_" } else { " " };
            g.textf(px + pw - 192.0, ny + 4.0, 12.0, TEXT, 0, format_args!("{}{}", s.name, cur));
            for ch in g.inp.typed.chars() {
                if (ch.is_ascii_alphanumeric() || ch == ' ' || ch == '-') && s.name.len() < 14 {
                    s.name.push(ch.to_ascii_uppercase());
                }
            }
            if g.inp.key(super::Key::Backspace) {
                s.name.pop();
            }
        }
        _ => {
            let ny = py;
            py = row(g, px, py, pw, "Show captions", "Transcribes ATC, pilots, crew and cabin announcements.");
            s.captions = g.switch(px + pw - 38.0, ny + 2.0, s.captions);
            let ny = py;
            py = row(g, px, py, pw, "Caption language", "Indonesian shows the English original beneath the translation.");
            s.caption_lang = g.segmented(px + pw - 200.0, ny + 2.0, 200.0, 24.0, &["English", "Indonesia"], s.caption_lang as usize) as u8;
            g.rect(px, py + 14.0, pw, 56.0, [0.0, 0.0, 0.0, 0.5]);
            g.frame(px, py + 14.0, pw, 56.0, 1.0, LINE);
            let dim = !s.captions;
            let c = if dim { MUTED } else { TEXT };
            g.text(px + pw * 0.5, py + 26.0, 12.5, c, 1, if s.caption_lang == 0 { "Skyline 320, cleared to land runway 28R." } else { "Skyline 320, diizinkan mendarat landasan 28R." });
            g.text(px + pw * 0.5, py + 46.0, 9.5, MUTED, 1, "TOWER");
        }
    }
    if *s != before {
        *changed = true;
    }
    if g.btn(x + 12.0, y + h - 40.0, 170.0, 28.0, "RESET DEFAULTS", BtnKind::Ghost) {
        let name = s.name.clone();
        *s = Settings { name, ..Settings::default() };
        *changed = true;
    }
}

fn controls_window(g: &mut Gui, close: &mut bool) {
    let rows = HELP.len();
    let half = rows.div_ceil(2);
    let (w, h) = (780.0f32, 100.0 + half as f32 * 24.0 + 20.0);
    let (x, y) = window(g, w, h, "CONTROLS", close);
    g.text(x + 20.0, y + 52.0, 10.0, DIM, 0, "KEYBOARD REFERENCE - flight deck and menu shortcuts");
    for (i, (k, d)) in HELP.iter().enumerate() {
        let (col, rowi) = (i / half, i % half);
        let (cx, cy) = (x + 20.0 + col as f32 * 380.0, y + 78.0 + rowi as f32 * 24.0);
        let kw = (k.len() as f32 * 7.2 + 14.0).max(30.0);
        g.rect(cx, cy, kw, 19.0, [0.85, 0.9, 0.97, 0.12]);
        g.frame(cx, cy, kw, 19.0, 1.0, [1.0, 1.0, 1.0, 0.3]);
        g.text(cx + kw * 0.5, cy + 4.0, 10.5, AMBER, 1, k);
        let desc: String = d.chars().take(40).collect();
        g.text(cx + 128.0, cy + 4.0, 10.0, TEXT, 0, &desc);
    }
}

fn logbook_window(g: &mut Gui, log: &mut Vec<LogEntry>, scroll: &mut f32, close: &mut bool) {
    let (w, h) = (780.0f32, 480.0f32);
    let (x, y) = window(g, w, h, "PILOT LOGBOOK", close);
    let n = log.len();
    let avg = if n > 0 { log.iter().map(|e| e.fpm).sum::<f64>() / n as f64 } else { 0.0 };
    let best = log.iter().map(|e| e.fpm).fold(f64::MAX, f64::min);
    for (i, (l, v)) in [("FLIGHTS", format!("{n}")), ("AVG TOUCHDOWN", if n > 0 { format!("{avg:.0} fpm") } else { "-".into() }), ("SOFTEST", if n > 0 { format!("{best:.0} fpm") } else { "-".into() })].iter().enumerate() {
        let cx = x + 20.0 + i as f32 * 200.0;
        g.text(cx, y + 54.0, 9.5, DIM, 0, l);
        g.text(cx, y + 68.0, 18.0, TEXT, 0, v);
    }
    if n > 0 && g.btn(x + w - 120.0, y + 56.0, 100.0, 26.0, "CLEAR", BtnKind::Danger) {
        log.clear();
        save_logbook(log);
    }
    let (ty, th) = (y + 100.0, h - 112.0);
    g.line([x + 14.0, ty], [x + w - 14.0, ty], 1.0, LINE);
    for (c, l) in [(0.0, "DATE (UTC)"), (150.0, "ROUTE"), (290.0, "GRADE"), (390.0, "V/S"), (470.0, "SPEED"), (560.0, "CENTRELINE")] {
        g.text(x + 20.0 + c, ty + 6.0, 9.0, MUTED, 0, l);
    }
    let rows_y = ty + 24.0;
    let vis_h = th - 24.0;
    let rh = 26.0;
    if g.hover(x, rows_y, w, vis_h) && g.inp.wheel != 0.0 {
        *scroll -= g.inp.wheel * rh * 2.0;
    }
    *scroll = scroll.clamp(0.0, (n as f32 * rh - vis_h).max(0.0));
    if n == 0 {
        g.text(x + w * 0.5, rows_y + 60.0, 12.0, MUTED, 1, "No flights logged yet - land the aircraft to record one.");
    }
    g.scissor(Some([x, rows_y, w, vis_h]));
    for (i, e) in log.iter().rev().enumerate() {
        let ry = rows_y + i as f32 * rh - *scroll;
        if ry + rh < rows_y || ry > rows_y + vis_h {
            continue;
        }
        if i % 2 == 0 {
            g.rect(x + 14.0, ry, w - 28.0, rh - 2.0, [1.0, 1.0, 1.0, 0.03]);
        }
        g.text(x + 20.0, ry + 7.0, 10.5, DIM, 0, &fmt_date(e.utc));
        g.textf(x + 170.0, ry + 7.0, 10.5, TEXT, 0, format_args!("{} > {}", e.dep, e.arr));
        g.text(x + 310.0, ry + 7.0, 10.5, grade_color(&e.grade), 0, &e.grade);
        g.textf(x + 410.0, ry + 7.0, 10.5, TEXT, 0, format_args!("{:.0} fpm", e.fpm));
        g.textf(x + 490.0, ry + 7.0, 10.5, TEXT, 0, format_args!("{:.0} kt", e.speed_kt));
        g.textf(x + 580.0, ry + 7.0, 10.5, TEXT, 0, format_args!("{:.1} m", e.centreline_m));
    }
    g.scissor(None);
}

#[allow(clippy::too_many_arguments)]
pub fn draw_modal(g: &mut Gui, kind: super::ModalKind, s: &mut Settings, tab: &mut usize, log: &mut Vec<LogEntry>, scroll: &mut f32, close: &mut bool, changed: &mut bool) {
    match kind {
        super::ModalKind::Settings => settings_window(g, s, tab, close, changed),
        super::ModalKind::Controls => controls_window(g, close),
        super::ModalKind::Logbook => logbook_window(g, log, scroll, close),
        super::ModalKind::Marketplace => {} // drawn by `PreFlight::frame` (needs the add-on manager)
    }
    let _ = (DIM, PANEL);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_roundtrip_and_clamping() {
        let s = Settings { quality: 2, fov: 75.0, volume: 0.35, muted: true, invert_pitch: true, sens: 1.4, name: "CAPT X".into(), metric: true, ..Settings::default() };
        assert_eq!(Settings::from_text(&s.to_text()), s);
        let bad = Settings::from_text("quality=99\nfov=500\nvolume=-3\nsens=0\ngarbage\nname=\n");
        assert_eq!(bad.quality, 4);
        assert_eq!(bad.fov, 100.0);
        assert_eq!(bad.volume, 0.0);
        assert_eq!(bad.sens, 0.5);
        assert_eq!(Settings::from_text("").quality, Settings::default().quality);
    }

    #[test]
    fn logbook_roundtrip() {
        let e = LogEntry { utc: 1_718_914_200.0, dep: "KSFO".into(), arr: "KOAK".into(), grade: "SMOOTH".into(), fpm: 180.0, speed_kt: 138.0, centreline_m: 1.5 };
        assert_eq!(LogEntry::from_line(&e.to_line()), Some(e.clone()));
        let list = parse_logbook(&format!("{}\nbroken line\n{}\n", e.to_line(), e.to_line()));
        assert_eq!(list.len(), 2);
        assert_eq!(fmt_date(1_718_914_200.0), "2024-06-20 20:10Z");
    }
}
