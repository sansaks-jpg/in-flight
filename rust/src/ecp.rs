//! ECAM Control Panel (the key block on the pedestal's forward end) - reference: `src/sim/a320/ecam.ts` (`Ecam.down / up / lit`).
//!
//! * a system-page key (ENG .. F/CTL) shows that page on the SD and lights white; pushing the lit key again returns to the
//!   automatic (flight-phase) page,
//! * ALL: pressed and held, the SD steps through every system page (1 s per page); releasing keeps the page that is shown,
//! * STS: the STATUS page (an empty status is shown for 3 s, then the page leaves again; pushing STS again or CLR removes it),
//! * CLR (either side) removes a manually selected page, RCL recalls the automatic page, EMER CANC cancels MASTER WARN,
//! * T.O. CONFIG runs the lamp test.

/// SD system pages in ECP order (the ALL key steps through them; STS is last).
pub const PAGES: [&str; 12] = ["ENG", "BLEED", "PRESS", "ELEC", "HYD", "FUEL", "APU", "COND", "DOOR", "WHEEL", "F/CTL", "STS"];
/// Seconds per page while ALL is held (FCOM: 1 s).
pub const ALL_STEP_S: f32 = 1.0;
/// An empty STATUS page leaves after this long.
pub const STS_EXIT_S: f32 = 3.0;

#[derive(Clone, Debug, Default)]
pub struct Ecp {
    manual: Option<usize>,
    all_held: bool,
    all_t: f32,
    sts_t: f32,
    /// keys accepted so far (diagnostics / tests)
    pub presses: u32,
}

/// Control id -> page index (`ecam_eng` .. `ecam_sts`).
pub fn page_of(id: &str) -> Option<usize> {
    Some(match id {
        "ecam_eng" => 0,
        "ecam_bleed" => 1,
        "ecam_press" => 2,
        "ecam_elec" => 3,
        "ecam_hyd" => 4,
        "ecam_fuel" => 5,
        "ecam_apu" => 6,
        "ecam_cond" => 7,
        "ecam_door" => 8,
        "ecam_wheel" => 9,
        "ecam_fctl" => 10,
        "ecam_sts" => 11,
        _ => return None,
    })
}

/// Is this control id an ECP key?
pub fn is_key(id: &str) -> bool {
    page_of(id).is_some() || matches!(id, "ecam_all" | "ecam_clr_l" | "ecam_clr_r" | "ecam_rcl" | "ecam_emer_canc" | "ecam_to_config")
}

impl Ecp {
    /// The manually selected SD page (None = automatic).
    pub fn shown(&self) -> Option<&'static str> {
        self.manual.map(|i| PAGES[i])
    }

    pub fn index(&self) -> Option<usize> {
        self.manual
    }

    /// Key lamp: page keys are lit while their page is selected.
    pub fn lit(&self, id: &str) -> bool {
        page_of(id).is_some_and(|p| self.manual == Some(p)) || (id == "ecam_all" && self.all_held)
    }

    /// Key pushed. `master_warn` / `lamp_test` are the systems' flags for EMER CANC / T.O. CONFIG. Returns false for a non-ECP id.
    pub fn press(&mut self, id: &str, master_warn: &mut bool, lamp_test: &mut f64) -> bool {
        if !is_key(id) {
            return false;
        }
        self.presses += 1;
        if let Some(p) = page_of(id) {
            if self.manual == Some(p) {
                self.manual = None;
                self.sts_t = 0.0;
            } else {
                self.manual = Some(p);
                self.sts_t = if p == 11 { STS_EXIT_S } else { 0.0 };
            }
            return true;
        }
        match id {
            "ecam_all" => {
                self.all_held = true;
                self.all_t = 0.0;
                self.step();
            }
            "ecam_clr_l" | "ecam_clr_r" | "ecam_rcl" => {
                self.manual = None;
                self.sts_t = 0.0;
            }
            "ecam_emer_canc" => {
                *master_warn = false;
                self.manual = None;
                self.sts_t = 0.0;
            }
            "ecam_to_config" => *lamp_test = 1.5,
            _ => {}
        }
        true
    }

    fn step(&mut self) {
        // ALL walks the ten system pages (not STS)
        let n = PAGES.len() - 1;
        let next = match self.manual {
            Some(i) if i < n => (i + 1) % n,
            _ => 0,
        };
        self.manual = Some(next);
        self.sts_t = 0.0;
    }

    /// ALL key held / released (driven by the mouse button state).
    pub fn set_all_held(&mut self, held: bool) {
        if !held {
            self.all_held = false;
        }
    }

    pub fn all_held(&self) -> bool {
        self.all_held
    }

    pub fn update(&mut self, dt: f32) {
        if self.all_held {
            self.all_t += dt;
            while self.all_t >= ALL_STEP_S {
                self.all_t -= ALL_STEP_S;
                self.step();
            }
        }
        if self.manual == Some(11) && self.sts_t > 0.0 {
            self.sts_t -= dt;
            if self.sts_t <= 0.0 {
                self.manual = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(e: &mut Ecp, id: &str) -> bool {
        let (mut w, mut l) = (true, 0.0);
        e.press(id, &mut w, &mut l)
    }

    #[test]
    fn page_keys_toggle_and_light() {
        let mut e = Ecp::default();
        assert!(press(&mut e, "ecam_hyd"));
        assert_eq!(e.shown(), Some("HYD"));
        assert!(e.lit("ecam_hyd") && !e.lit("ecam_fuel"));
        press(&mut e, "ecam_fuel");
        assert_eq!(e.shown(), Some("FUEL"));
        press(&mut e, "ecam_fuel");
        assert_eq!(e.shown(), None, "second push returns to the automatic page");
    }

    #[test]
    fn every_page_key_selects_its_page() {
        for (i, p) in PAGES.iter().enumerate() {
            let id = ["ecam_eng", "ecam_bleed", "ecam_press", "ecam_elec", "ecam_hyd", "ecam_fuel", "ecam_apu", "ecam_cond", "ecam_door", "ecam_wheel", "ecam_fctl", "ecam_sts"][i];
            let mut e = Ecp::default();
            press(&mut e, id);
            assert_eq!(e.shown(), Some(*p));
        }
    }

    #[test]
    fn all_steps_every_second_while_held_and_keeps_page_on_release() {
        let mut e = Ecp::default();
        press(&mut e, "ecam_all");
        assert_eq!(e.shown(), Some("ENG"));
        e.update(0.99);
        assert_eq!(e.shown(), Some("ENG"));
        e.update(0.02);
        assert_eq!(e.shown(), Some("BLEED"));
        e.update(3.0);
        assert_eq!(e.shown(), Some("HYD"));
        e.set_all_held(false);
        e.update(5.0);
        assert_eq!(e.shown(), Some("HYD"));
        // wraps after all 11 system pages
        let mut e = Ecp::default();
        press(&mut e, "ecam_all");
        e.update(11.0);
        assert_eq!(e.shown(), Some("ENG"));
    }

    #[test]
    fn clr_rcl_emer_canc_and_to_config() {
        let mut e = Ecp::default();
        press(&mut e, "ecam_elec");
        press(&mut e, "ecam_clr_l");
        assert_eq!(e.shown(), None);
        press(&mut e, "ecam_apu");
        press(&mut e, "ecam_rcl");
        assert_eq!(e.shown(), None);
        press(&mut e, "ecam_door");
        let (mut w, mut l) = (true, 0.0);
        assert!(e.press("ecam_emer_canc", &mut w, &mut l));
        assert!(!w && e.shown().is_none());
        assert!(e.press("ecam_to_config", &mut w, &mut l));
        assert!(l > 1.0);
        assert!(!e.press("ecam_nonsense", &mut w, &mut l));
    }

    #[test]
    fn status_page_leaves_after_three_seconds() {
        let mut e = Ecp::default();
        press(&mut e, "ecam_sts");
        assert_eq!(e.shown(), Some("STS"));
        e.update(2.9);
        assert_eq!(e.shown(), Some("STS"));
        e.update(0.2);
        assert_eq!(e.shown(), None);
    }
}
