//! A320 ECAM control panel (ECP) logic - a pure state machine (no rendering, no GPU, no flight model), so every key behaviour
//! can be unit-tested. Port of `src/sim/a320/ecam.ts` (read-only reference) which follows the A320 FCOM DSC-31-30 "ECAM Controls":
//!
//! * **system page pb** (ENG ... F/CTL, STS): shows the page on the SD and lights white; pushing the lit key again returns to the
//!   automatic page. A failure-related page replaces a manually selected one.
//! * **ALL**: pressed and held, the SD steps through every system page (1 s per page); releasing keeps the page that is shown.
//! * **STS**: STATUS page, lit while shown; an empty status shows NORMAL for 3 s; pushing STS again or CLR removes the page.
//! * **CLR** (x2): lit while the E/WD shows a warning / caution or the SD shows STATUS; each push clears the first message.
//! * **RCL**: recalls messages cleared with CLR (still active) or shows NORMAL for 3 s; held > 3 s it also recalls EMER CANC'd cautions.
//! * **EMER CANC**: warning -> aural + MASTER WARN cancelled (message stays); caution -> cancelled for the rest of the flight, the
//!   STATUS page shows CANCELLED CAUTION.
//! * **T.O CONFIG**: simulates take-off power; the E/WD shows the CONFIG warnings or "T.O CONFIG NORMAL" in the T.O MEMO.
//!
//! Side effects on other systems (MASTER WARN / CAUT lights, aural alert, toast) are *returned* as [`Effects`] and applied by
//! `A320Systems` - this module never touches anything but its own state.

/// SD (lower ECAM) pages. `Crz` is the automatic cruise page, `Sts` the STATUS page.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EcamPage {
    Eng,
    Bleed,
    Press,
    Elec,
    Hyd,
    Fuel,
    Apu,
    Cond,
    Door,
    Wheel,
    Fctl,
    Sts,
    Crz,
}

impl EcamPage {
    pub const fn name(self) -> &'static str {
        match self {
            EcamPage::Eng => "ENG",
            EcamPage::Bleed => "BLEED",
            EcamPage::Press => "PRESS",
            EcamPage::Elec => "ELEC",
            EcamPage::Hyd => "HYD",
            EcamPage::Fuel => "FUEL",
            EcamPage::Apu => "APU",
            EcamPage::Cond => "COND",
            EcamPage::Door => "DOOR",
            EcamPage::Wheel => "WHEEL",
            EcamPage::Fctl => "F/CTL",
            EcamPage::Sts => "STS",
            EcamPage::Crz => "CRZ",
        }
    }
}

/// Pages stepped through by the ALL key (the eleven SD system pages, CRUISE last).
pub const ALL_PAGES: [EcamPage; 12] = [
    EcamPage::Eng,
    EcamPage::Bleed,
    EcamPage::Press,
    EcamPage::Elec,
    EcamPage::Hyd,
    EcamPage::Fuel,
    EcamPage::Apu,
    EcamPage::Cond,
    EcamPage::Door,
    EcamPage::Wheel,
    EcamPage::Fctl,
    EcamPage::Crz,
];

/// Seconds between pages while ALL is held (FCOM: successive pages at 1 s intervals).
pub const ALL_STEP_S: f64 = 1.0;
/// RCL held longer than this also recalls EMER CANC'd cautions.
pub const RCL_HOLD_S: f64 = 3.0;
/// Duration of the "NORMAL" message.
pub const NORMAL_MSG_S: f64 = 3.0;
/// How long the T.O CONFIG test result stays on the E/WD.
pub const TO_CONFIG_S: f64 = 120.0;

/// Every key of the ECAM control panel that has momentary behaviour (the brightness knobs and the source-switching knobs are
/// plain rotary controls handled by `deck.rs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EcpKey {
    Page(EcamPage),
    All,
    ClrL,
    ClrR,
    Rcl,
    EmerCanc,
    ToConfig,
}

/// (model node / control id, key) for every ECP push button.
pub const ECP_KEYS: [(&str, EcpKey); 18] = [
    ("ecam_eng", EcpKey::Page(EcamPage::Eng)),
    ("ecam_bleed", EcpKey::Page(EcamPage::Bleed)),
    ("ecam_press", EcpKey::Page(EcamPage::Press)),
    ("ecam_elec", EcpKey::Page(EcamPage::Elec)),
    ("ecam_hyd", EcpKey::Page(EcamPage::Hyd)),
    ("ecam_fuel", EcpKey::Page(EcamPage::Fuel)),
    ("ecam_apu", EcpKey::Page(EcamPage::Apu)),
    ("ecam_cond", EcpKey::Page(EcamPage::Cond)),
    ("ecam_door", EcpKey::Page(EcamPage::Door)),
    ("ecam_wheel", EcpKey::Page(EcamPage::Wheel)),
    ("ecam_fctl", EcpKey::Page(EcamPage::Fctl)),
    ("ecam_sts", EcpKey::Page(EcamPage::Sts)),
    ("ecam_all", EcpKey::All),
    ("ecam_clr_l", EcpKey::ClrL),
    ("ecam_clr_r", EcpKey::ClrR),
    ("ecam_rcl", EcpKey::Rcl),
    ("ecam_emer_canc", EcpKey::EmerCanc),
    ("ecam_to_config", EcpKey::ToConfig),
];

impl EcpKey {
    pub fn from_id(id: &str) -> Option<EcpKey> {
        ECP_KEYS.iter().find(|k| k.0 == id).map(|k| k.1)
    }

    pub fn id(self) -> &'static str {
        ECP_KEYS.iter().find(|k| k.1 == self).map(|k| k.0).unwrap_or("")
    }

    /// Short legend printed on the key.
    pub fn legend(self) -> &'static str {
        match self {
            EcpKey::Page(p) => p.name(),
            EcpKey::All => "ALL",
            EcpKey::ClrL | EcpKey::ClrR => "CLR",
            EcpKey::Rcl => "RCL",
            EcpKey::EmerCanc => "EMER CANC",
            EcpKey::ToConfig => "T.O CONFIG",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EwdColour {
    Red,
    Amber,
    Green,
    Cyan,
    White,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EwdLine {
    pub text: String,
    pub colour: EwdColour,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EcamAlert {
    pub text: &'static str,
    pub red: bool,
}

/// Consequences of a key press for the rest of the aircraft (applied by `A320Systems`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Effects {
    pub clear_master_warn: bool,
    pub clear_master_caut: bool,
    /// cancel the aural alert of the game's warning system
    pub ack_aural: bool,
    pub toast: Option<&'static str>,
}

const RED_WORDS: [&str; 10] = ["STALL", "FIRE", "OVERSPEED", "PULL UP", "SINK", "TERRAIN", "TOO LOW", "CONFIG", "PARK BRAKE", "FLAMEOUT"];

/// Red (warning) vs amber (caution): same word list as `RED` in `ecam.ts`.
pub fn is_red(text: &str) -> bool {
    let t = text.to_ascii_uppercase();
    RED_WORDS.iter().any(|w| t.contains(w))
}

/// Which SD page a failure shows automatically (`alertPage` in `ecam.ts`).
pub fn alert_page(text: &str) -> Option<EcamPage> {
    let t = text.to_ascii_uppercase();
    let has = |ws: &[&str]| ws.iter().any(|w| t.contains(w));
    Some(if has(&["ENG", "FIRE", "FLAMEOUT"]) {
        EcamPage::Eng
    } else if has(&["GEAR", "L/G", "WHEEL", "BRAKE", "SINK"]) {
        EcamPage::Wheel
    } else if has(&["FLAP", "SPD BRK", "SPLR", "STALL", "CONFIG", "SLAT"]) {
        EcamPage::Fctl
    } else if has(&["HYD"]) {
        EcamPage::Hyd
    } else if has(&["FUEL"]) {
        EcamPage::Fuel
    } else if has(&["ELEC", "GEN", "BAT"]) {
        EcamPage::Elec
    } else if has(&["BLEED", "PACK", "PRESS", "CAB"]) {
        EcamPage::Press
    } else if has(&["APU"]) {
        EcamPage::Apu
    } else {
        return None;
    })
}

fn set_has(v: &[&'static str], s: &str) -> bool {
    v.iter().any(|x| *x == s)
}

fn set_add(v: &mut Vec<&'static str>, s: &'static str) {
    if !set_has(v, s) {
        v.push(s);
    }
}

#[derive(Clone, Debug)]
pub struct Ecam {
    /// Page selected with an ECP key (None = automatic). `Sts` is the STATUS page.
    pub manual: Option<EcamPage>,
    /// messages removed with CLR (they return with RCL)
    pub cleared: Vec<&'static str>,
    /// cautions cancelled with EMER CANC (return with RCL > 3 s)
    pub cancelled: Vec<&'static str>,
    pub aural_cancelled: Vec<&'static str>,
    /// seconds of simulated time (own clock - keeps this module independent of the game's clock)
    pub now: f64,
    /// E/WD "NORMAL" message shown until this time (RCL with nothing to recall)
    pub normal_until: f64,
    /// STATUS page auto-exit (an empty status shows NORMAL for 3 s)
    pub sts_exit_at: Option<f64>,
    /// T.O CONFIG test started at this time
    pub to_cfg: Option<f64>,
    pub inhibit_suppressed: bool,
    pub held: Option<EcpKey>,
    pub held_t: f64,
    rcl_long_done: bool,
    all_t: f64,
    // ---- environment sampled every frame ----
    warns: Vec<&'static str>,
    to_cfg_issues: Vec<&'static str>,
    wow: bool,
    any_engine: bool,
    auto_page: EcamPage,
    last_warns: Vec<&'static str>,
}

impl Default for Ecam {
    fn default() -> Self {
        Self {
            manual: None,
            cleared: Vec::new(),
            cancelled: Vec::new(),
            aural_cancelled: Vec::new(),
            now: 0.0,
            normal_until: 0.0,
            sts_exit_at: None,
            to_cfg: None,
            inhibit_suppressed: false,
            held: None,
            held_t: 0.0,
            rcl_long_done: false,
            all_t: 0.0,
            warns: Vec::new(),
            to_cfg_issues: Vec::new(),
            wow: true,
            any_engine: false,
            auto_page: EcamPage::Door,
            last_warns: Vec::new(),
        }
    }
}

impl Ecam {
    // ------------------------------------------------------------------ derived state
    /// Alerts currently displayed on the E/WD (not cleared with CLR, cautions not cancelled with EMER CANC).
    pub fn alerts(&self) -> impl Iterator<Item = EcamAlert> + '_ {
        self.warns.iter().filter(|w| !set_has(&self.cleared, w) && !set_has(&self.cancelled, w)).map(|w| EcamAlert { text: w, red: is_red(w) })
    }

    pub fn alert_count(&self) -> usize {
        self.alerts().count()
    }

    /// CONFIG problems of the T.O CONFIG test (only while the test result is displayed).
    pub fn to_cfg_issues(&self) -> &[&'static str] {
        if self.to_cfg.is_some() {
            &self.to_cfg_issues
        } else {
            &[]
        }
    }

    /// Things the STATUS page lists.
    pub fn status_items(&self) -> &[&'static str] {
        &self.cancelled
    }

    pub fn status_pending(&self) -> bool {
        !self.cancelled.is_empty()
    }

    /// Page the SD displays: ECP selection, else the page of an active failure, else the flight-phase page.
    pub fn shown_page(&self) -> EcamPage {
        if let Some(p) = self.manual {
            return p;
        }
        for a in self.alerts() {
            if let Some(p) = alert_page(a.text) {
                return p;
            }
        }
        self.auto_page
    }

    /// Lamp states of the ECP keys (the white bar in the key).
    pub fn lit(&self, key: EcpKey) -> bool {
        match key {
            EcpKey::Page(p) => p == self.shown_page(),
            EcpKey::ClrL | EcpKey::ClrR => self.alerts().next().is_some() || self.manual == Some(EcamPage::Sts) || !self.to_cfg_issues().is_empty(),
            EcpKey::EmerCanc => !self.cancelled.is_empty() || !self.aural_cancelled.is_empty(),
            _ => false,
        }
    }

    /// True while a warning is displayed whose aural alert / MASTER WARN has not been cancelled.
    pub fn warn_pending(&self) -> bool {
        self.alerts().any(|a| a.red && !set_has(&self.aural_cancelled, a.text))
    }

    /// True while the "NORMAL" message is on the E/WD.
    pub fn normal_shown(&self) -> bool {
        self.now < self.normal_until
    }

    /// E/WD message area, top to bottom (memo lines are added by the renderer when this is empty).
    pub fn ewd_lines(&self) -> Vec<EwdLine> {
        let mut l = Vec::new();
        for a in self.alerts() {
            l.push(EwdLine { text: a.text.to_ascii_uppercase().chars().take(34).collect(), colour: if a.red { EwdColour::Red } else { EwdColour::Amber } });
        }
        for i in self.to_cfg_issues() {
            l.push(EwdLine { text: format!("CONFIG {i}").chars().take(34).collect(), colour: EwdColour::Red });
        }
        if self.normal_shown() {
            l.push(EwdLine { text: "NORMAL".into(), colour: EwdColour::Green });
        }
        l
    }

    /// Green "T.O CONFIG NORMAL" line of the T.O MEMO.
    pub fn to_config_normal(&self) -> bool {
        self.to_cfg.is_some() && self.to_cfg_issues.is_empty()
    }

    // ------------------------------------------------------------------ per-frame
    /// Sample the aircraft (`warns` = active alert texts, `to_cfg_issues` = CONFIG problems if take-off power were applied now).
    pub fn update(&mut self, dt: f64, warns: &[&'static str], to_cfg_issues: &[&'static str], wow: bool, any_engine: bool, auto_page: EcamPage) {
        self.now += dt;
        self.warns.clear();
        self.warns.extend_from_slice(warns);
        self.to_cfg_issues.clear();
        self.to_cfg_issues.extend_from_slice(to_cfg_issues);
        self.wow = wow;
        self.any_engine = any_engine;
        self.auto_page = auto_page;
        // CLR / aural cancel end with the failure; EMER CANC'd cautions stay cancelled for the rest of the flight (only RCL > 3 s restores them)
        let live = &self.warns;
        self.cleared.retain(|w| set_has(live, w));
        self.aural_cancelled.retain(|w| set_has(live, w));
        // a NEW failure replaces a manually selected page and re-arms the master lights
        if self.warns != self.last_warns {
            let fresh = self.warns.iter().any(|w| !set_has(&self.last_warns, w) && !set_has(&self.cancelled, w) && !set_has(&self.cleared, w));
            if fresh {
                self.manual = None;
            }
            self.last_warns.clear();
            self.last_warns.extend_from_slice(&self.warns);
        }
        if self.manual == Some(EcamPage::Sts) {
            if let Some(t) = self.sts_exit_at {
                if self.now >= t {
                    self.manual = None;
                    self.sts_exit_at = None;
                }
            }
        }
        if let Some(since) = self.to_cfg {
            if !wow || self.now - since > TO_CONFIG_S {
                self.to_cfg = None;
            }
        }
        // held keys
        if let Some(h) = self.held {
            self.held_t += dt;
            if h == EcpKey::All {
                self.all_t += dt;
                while self.all_t >= ALL_STEP_S {
                    self.all_t -= ALL_STEP_S;
                    self.step_all();
                }
            }
            if h == EcpKey::Rcl && !self.rcl_long_done && self.held_t >= RCL_HOLD_S {
                self.rcl_long_done = true;
                self.recall_cancelled();
            }
        }
    }

    // ------------------------------------------------------------------ key actions
    pub fn down(&mut self, key: EcpKey) -> Effects {
        self.held = Some(key);
        self.held_t = 0.0;
        self.all_t = 0.0;
        self.rcl_long_done = false;
        let mut fx = Effects::default();
        match key {
            EcpKey::Page(p) => self.page_key(p),
            EcpKey::All => self.step_all(),
            EcpKey::ClrL | EcpKey::ClrR => self.clr(&mut fx),
            EcpKey::Rcl => self.rcl(),
            EcpKey::EmerCanc => self.emer_canc(&mut fx),
            EcpKey::ToConfig => self.to_config(&mut fx),
        }
        fx
    }

    pub fn up(&mut self, key: EcpKey) {
        if self.held == Some(key) {
            self.held = None;
        }
    }

    /// MASTER WARN pressed: lights out and the aural alert of every displayed red warning is cancelled (the messages stay).
    pub fn acknowledge_master(&mut self) -> Effects {
        let reds: Vec<&'static str> = self.alerts().filter(|a| a.red).map(|a| a.text).collect();
        for t in reds {
            set_add(&mut self.aural_cancelled, t);
        }
        Effects { clear_master_warn: true, ack_aural: true, ..Default::default() }
    }

    fn page_key(&mut self, p: EcamPage) {
        if self.manual == Some(p) {
            // second push: back to the automatic page
            self.manual = None;
            self.sts_exit_at = None;
            return;
        }
        self.manual = Some(p);
        self.sts_exit_at = None;
        if p == EcamPage::Sts && !self.status_pending() && self.alerts().next().is_none() {
            self.sts_exit_at = Some(self.now + NORMAL_MSG_S); // empty status: NORMAL for 3 s
        }
    }

    fn step_all(&mut self) {
        let cur = self.shown_page();
        let i = ALL_PAGES.iter().position(|p| *p == cur).map(|i| (i + 1) % ALL_PAGES.len()).unwrap_or(0);
        self.manual = Some(ALL_PAGES[i]);
        self.sts_exit_at = None;
    }

    fn clr(&mut self, fx: &mut Effects) {
        if self.manual == Some(EcamPage::Sts) {
            self.manual = None;
            self.sts_exit_at = None;
            return;
        }
        let first = self.alerts().next();
        if let Some(first) = first {
            self.cleared.push(first.text);
            if !self.alerts().any(|a| !a.red) {
                fx.clear_master_caut = true;
            }
            return;
        }
        if self.to_cfg.is_some() {
            self.to_cfg = None;
        }
    }

    fn rcl(&mut self) {
        if !self.cleared.is_empty() {
            self.cleared.clear();
            return;
        }
        if self.manual.is_none() {
            self.normal_until = self.now + NORMAL_MSG_S;
        }
    }

    fn recall_cancelled(&mut self) {
        self.inhibit_suppressed = true;
        if !self.cancelled.is_empty() || !self.aural_cancelled.is_empty() {
            self.cancelled.clear();
            self.aural_cancelled.clear();
            self.cleared.clear();
            if self.manual == Some(EcamPage::Sts) {
                self.manual = None;
            }
        } else {
            self.normal_until = self.now + NORMAL_MSG_S;
        }
    }

    fn emer_canc(&mut self, fx: &mut Effects) {
        let active: Vec<EcamAlert> = self.alerts().collect();
        let mut caution = false;
        for a in &active {
            if a.red {
                set_add(&mut self.aural_cancelled, a.text);
            } else {
                set_add(&mut self.cancelled, a.text);
                caution = true;
            }
        }
        fx.clear_master_warn = true;
        fx.clear_master_caut = true;
        if !active.is_empty() {
            fx.ack_aural = true;
        }
        if caution {
            // CANCELLED CAUTION is listed on the STATUS page
            self.manual = Some(EcamPage::Sts);
            self.sts_exit_at = None;
        }
    }

    fn to_config(&mut self, fx: &mut Effects) {
        if !self.wow {
            return;
        }
        if !self.any_engine {
            fx.toast = Some("T.O CONFIG test: start an engine first");
            return;
        }
        self.to_cfg = Some(self.now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use EcamPage::*;

    /// 1/16 s steps: exactly representable, so "1 s" really is 16 steps (no float drift in the timers).
    fn run(e: &mut Ecam, secs: f64, warns: &[&'static str]) {
        let steps = (secs / 0.0625).round() as usize;
        for _ in 0..steps {
            e.update(0.0625, warns, &[], true, true, Door);
        }
    }

    #[test]
    fn every_ecp_key_has_a_stable_id_roundtrip() {
        for (id, k) in ECP_KEYS {
            assert_eq!(EcpKey::from_id(id), Some(k));
            assert_eq!(k.id(), id);
        }
        assert!(EcpKey::from_id("ecam_brt_upper").is_none(), "brightness knobs are not push keys");
        assert_eq!(ECP_KEYS.len(), 18);
    }

    #[test]
    fn page_key_selects_lights_and_toggles_back_to_auto() {
        let mut e = Ecam::default();
        run(&mut e, 0.1, &[]);
        assert_eq!(e.shown_page(), Door);
        assert!(e.lit(EcpKey::Page(Door)) && !e.lit(EcpKey::Page(Hyd)));
        e.down(EcpKey::Page(Hyd));
        e.up(EcpKey::Page(Hyd));
        assert_eq!(e.shown_page(), Hyd);
        assert!(e.lit(EcpKey::Page(Hyd)) && !e.lit(EcpKey::Page(Door)), "only the shown page key is lit");
        e.down(EcpKey::Page(Fuel));
        assert_eq!(e.shown_page(), Fuel, "another key replaces the selection");
        e.down(EcpKey::Page(Fuel));
        assert_eq!(e.manual, None, "pushing the lit key again returns to the automatic page");
        assert_eq!(e.shown_page(), Door);
    }

    #[test]
    fn all_key_steps_once_per_second_while_held_and_keeps_the_page() {
        let mut e = Ecam::default();
        run(&mut e, 0.1, &[]);
        // automatic page is DOOR: the first push steps to the next page in the ALL sequence (WHEEL)
        e.down(EcpKey::All);
        assert_eq!(e.shown_page(), Wheel);
        run(&mut e, 0.9, &[]);
        assert_eq!(e.shown_page(), Wheel, "no second step before 1 s");
        run(&mut e, 0.1, &[]);
        assert_eq!(e.shown_page(), Fctl, "one page per second while held");
        run(&mut e, 2.0, &[]);
        assert_eq!(e.shown_page(), Eng, "F/CTL -> CRZ -> wraps to ENG");
        e.up(EcpKey::All);
        run(&mut e, 5.0, &[]);
        assert_eq!(e.shown_page(), Eng, "releasing keeps the page that is shown");
        // STS is not part of the sequence: stepping from it restarts at ENG
        e.manual = Some(Sts);
        e.down(EcpKey::All);
        assert_eq!(e.shown_page(), Eng);
    }

    #[test]
    fn sts_page_with_empty_status_shows_normal_then_exits() {
        let mut e = Ecam::default();
        run(&mut e, 0.1, &[]);
        e.down(EcpKey::Page(Sts));
        e.up(EcpKey::Page(Sts));
        assert_eq!(e.shown_page(), Sts);
        assert!(e.lit(EcpKey::ClrL), "CLR lights while STATUS is displayed");
        run(&mut e, 2.5, &[]);
        assert_eq!(e.shown_page(), Sts);
        run(&mut e, 1.0, &[]);
        assert_eq!(e.manual, None, "empty STATUS leaves after 3 s");
        // CLR removes a STATUS page too
        e.down(EcpKey::Page(Sts));
        e.down(EcpKey::ClrL);
        assert_eq!(e.manual, None);
    }

    #[test]
    fn a_new_failure_replaces_the_manual_page_and_selects_its_system_page() {
        let mut e = Ecam::default();
        run(&mut e, 0.1, &[]);
        e.down(EcpKey::Page(Cond));
        e.up(EcpKey::Page(Cond));
        run(&mut e, 0.1, &["FUEL LOW"]);
        assert_eq!(e.manual, None, "a new failure drops the manual selection");
        assert_eq!(e.shown_page(), Fuel);
        assert!(e.lit(EcpKey::Page(Fuel)) && e.lit(EcpKey::ClrL) && e.lit(EcpKey::ClrR));
        // a manual selection made AFTER the failure is kept
        e.down(EcpKey::Page(Hyd));
        run(&mut e, 0.5, &["FUEL LOW"]);
        assert_eq!(e.shown_page(), Hyd);
    }

    #[test]
    fn clr_clears_first_message_and_rcl_brings_it_back() {
        let mut e = Ecam::default();
        run(&mut e, 0.1, &["FUEL LOW", "ENG FAIL"]);
        assert_eq!(e.alert_count(), 2);
        let fx = e.down(EcpKey::ClrL);
        assert_eq!(e.alert_count(), 1, "each push clears the first message");
        assert!(!fx.clear_master_caut, "another caution is still displayed: MASTER CAUT stays");
        let fx = e.down(EcpKey::ClrL);
        assert!(fx.clear_master_caut, "last caution cleared -> MASTER CAUT is cancelled");
        assert_eq!(e.alert_count(), 0);
        assert!(!e.lit(EcpKey::ClrL));
        e.down(EcpKey::Rcl);
        assert_eq!(e.alert_count(), 2, "RCL recalls everything cleared with CLR");
        // a cleared message ends with the failure
        e.down(EcpKey::ClrL);
        run(&mut e, 0.1, &["ENG FAIL"]);
        assert!(e.cleared.is_empty());
    }

    #[test]
    fn rcl_with_nothing_to_recall_shows_normal_for_three_seconds() {
        let mut e = Ecam::default();
        run(&mut e, 0.1, &[]);
        e.down(EcpKey::Rcl);
        e.up(EcpKey::Rcl);
        assert!(e.normal_shown());
        assert_eq!(e.ewd_lines().last().map(|l| l.text.as_str()), Some("NORMAL"));
        run(&mut e, 3.1, &[]);
        assert!(!e.normal_shown());
    }

    #[test]
    fn emer_canc_cancels_warnings_aurally_and_cautions_for_the_flight() {
        let mut e = Ecam::default();
        run(&mut e, 0.1, &["STALL", "FUEL LOW"]);
        assert!(e.warn_pending());
        let fx = e.down(EcpKey::EmerCanc);
        assert!(fx.clear_master_warn && fx.clear_master_caut && fx.ack_aural);
        assert!(!e.warn_pending(), "aural + MASTER WARN cancelled");
        let texts: Vec<_> = e.alerts().map(|a| a.text).collect();
        assert_eq!(texts, vec!["STALL"], "warning message stays, caution is removed");
        assert_eq!(e.shown_page(), Sts, "CANCELLED CAUTION is on the STATUS page");
        assert_eq!(e.status_items(), &["FUEL LOW"]);
        assert!(e.lit(EcpKey::EmerCanc));
        // it stays cancelled while the failure persists ...
        run(&mut e, 1.0, &["STALL", "FUEL LOW"]);
        assert_eq!(e.alert_count(), 1);
        // ... and only RCL held > 3 s restores it
        e.up(EcpKey::EmerCanc);
        e.down(EcpKey::Rcl);
        run(&mut e, 2.9, &["STALL", "FUEL LOW"]);
        assert_eq!(e.alert_count(), 1);
        run(&mut e, 0.3, &["STALL", "FUEL LOW"]);
        e.up(EcpKey::Rcl);
        assert_eq!(e.alert_count(), 2);
        assert!(!e.lit(EcpKey::EmerCanc));
    }

    #[test]
    fn acknowledge_master_cancels_aural_but_keeps_messages() {
        let mut e = Ecam::default();
        run(&mut e, 0.1, &["OVERSPEED"]);
        assert!(e.warn_pending());
        let fx = e.acknowledge_master();
        assert!(fx.clear_master_warn && fx.ack_aural);
        assert!(!e.warn_pending());
        assert_eq!(e.alert_count(), 1);
    }

    #[test]
    fn to_config_needs_ground_and_engine_and_expires() {
        let mut e = Ecam::default();
        e.update(0.1, &[], &["FLAPS NOT IN T.O CONFIG"], true, false, Door);
        let fx = e.down(EcpKey::ToConfig);
        assert!(fx.toast.is_some() && e.to_cfg.is_none(), "no engine: only a hint");
        e.update(0.1, &[], &["FLAPS NOT IN T.O CONFIG"], true, true, Door);
        e.down(EcpKey::ToConfig);
        assert!(e.to_cfg.is_some());
        assert_eq!(e.ewd_lines()[0].text, "CONFIG FLAPS NOT IN T.O CONFIG");
        assert_eq!(e.ewd_lines()[0].colour, EwdColour::Red);
        assert!(e.lit(EcpKey::ClrL) && !e.to_config_normal());
        e.down(EcpKey::ClrL);
        assert!(e.to_cfg.is_none(), "CLR dismisses the test result");
        // NORMAL result, then airborne drops it
        e.update(0.1, &[], &[], true, true, Door);
        e.down(EcpKey::ToConfig);
        assert!(e.to_config_normal());
        e.update(0.1, &[], &[], false, true, Door);
        assert!(e.to_cfg.is_none());
    }

    #[test]
    fn colour_and_page_classification_matches_the_reference() {
        for t in ["STALL", "PULL UP", "OVERSPEED", "FLAP OVERSPEED", "TERRAIN  TERRAIN", "CONFIG FLAPS", "TOO LOW GEAR"] {
            assert!(is_red(t), "{t}");
        }
        for t in ["FUEL LOW", "ENG FAIL", "L/G SPEED LIMIT", "RETARD", "BANK ANGLE"] {
            assert!(!is_red(t), "{t}");
        }
        assert_eq!(alert_page("ENG FAIL"), Some(Eng));
        assert_eq!(alert_page("TOO LOW GEAR"), Some(Wheel));
        assert_eq!(alert_page("FLAP OVERSPEED"), Some(Fctl));
        assert_eq!(alert_page("FUEL LOW"), Some(Fuel));
        assert_eq!(alert_page("BANK ANGLE"), None);
    }
}
