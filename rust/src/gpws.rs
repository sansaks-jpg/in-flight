//! Ground Proximity Warning System: sink rate, terrain, glideslope, too-low-gear, stall, overspeed, "retard" and the
//! radio-altitude callouts (1000 … 10). Pure logic: the HUD renders text; audio can hook the same outputs.

use crate::autopilot::IlsData;
use crate::geo::{FT, KT};
use crate::physics::FlightModel;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Alert {
    None,
    Retard,
    BankAngle,
    Overspeed,
    TooLowGear,
    Glideslope,
    SinkRate,
    Stall,
    Terrain,
    PullUp,
}

impl Alert {
    pub fn text(self) -> &'static str {
        match self {
            Alert::None => "",
            Alert::Retard => "RETARD",
            Alert::BankAngle => "BANK ANGLE",
            Alert::Overspeed => "OVERSPEED",
            Alert::TooLowGear => "TOO LOW GEAR",
            Alert::Glideslope => "GLIDESLOPE",
            Alert::SinkRate => "SINK RATE",
            Alert::Stall => "STALL",
            Alert::Terrain => "TERRAIN  TERRAIN",
            Alert::PullUp => "PULL UP",
        }
    }
    pub fn is_warning(self) -> bool {
        matches!(self, Alert::Stall | Alert::Terrain | Alert::PullUp)
    }
}

const CALLOUTS_FT: [i32; 11] = [1000, 500, 400, 300, 200, 100, 50, 40, 30, 20, 10];

#[derive(Default)]
pub struct Gpws {
    last_callout_idx: Option<usize>,
}

#[derive(Clone, Copy, Debug)]
pub struct GpwsOut {
    pub alert: Alert,
    pub callout_ft: Option<i32>,
}

impl Gpws {
    pub fn reset(&mut self) {
        self.last_callout_idx = None;
    }

    pub fn update(&mut self, fm: &FlightModel, ils: Option<&IlsData>, ground_at: &dyn Fn(f64, f64) -> f64) -> GpwsOut {
        let mut alert = Alert::None;
        let mut raise = |a: Alert| {
            if a > alert {
                alert = a;
            }
        };
        let kias = fm.ias / KT;
        let agl = fm.agl;
        let airborne = !fm.wow && fm.airborne_time > 1.0;
        let landing_cfg = fm.ctl.gear_down && fm.ctl.flaps_idx >= 3;
        if airborne {
            // mode 1: excessive sink rate (limit grows with height)
            let sink = -fm.vs;
            if agl < 750.0 && agl > 15.0 {
                let limit = 5.0 + agl * 0.011;
                if sink > limit {
                    raise(Alert::SinkRate);
                }
                if sink > limit * 1.6 && agl < 300.0 {
                    raise(Alert::PullUp);
                }
            }
            // mode 2 / look-ahead terrain: three probes along the track (inhibited in landing configuration near the field)
            if agl > 30.0 && !(landing_cfg && ils.is_some_and(|i| i.valid && i.dist < 20000.0)) {
                let (sx, sz) = (fm.vel.x, fm.vel.z);
                for t in [4.0, 8.0, 12.0] {
                    let (px, pz) = (fm.pos.x + sx * t, fm.pos.z + sz * t);
                    let alt = fm.pos.y + fm.vel.y.min(0.0) * t;
                    let clear = alt - ground_at(px, pz);
                    if clear < 60.0 {
                        raise(if t <= 4.0 { Alert::PullUp } else { Alert::Terrain });
                        break;
                    }
                }
            }
            // mode 5: below glideslope
            if let Some(i) = ils {
                if i.valid && agl < 300.0 && agl > 30.0 && i.gs_dots > 1.3 && i.dist > 500.0 {
                    raise(Alert::Glideslope);
                }
            }
            // mode 4: too low gear
            if agl < 250.0 && agl > 20.0 && !fm.ctl.gear_down && kias < 200.0 && fm.vs < -1.0 {
                raise(Alert::TooLowGear);
            }
            // flare: retard
            if agl < 7.0 && fm.ctl.throttle > 0.15 && fm.ctl.gear_down {
                raise(Alert::Retard);
            }
            if fm.bank.to_degrees().abs() > 40.0 && agl < 300.0 {
                raise(Alert::BankAngle);
            }
        }
        if fm.stall_warn {
            raise(Alert::Stall);
        }
        let lim = fm.limits();
        if lim.overspeed {
            raise(Alert::Overspeed);
        }

        // radio-altitude callouts on descent (gear down)
        let mut callout = None;
        if airborne && fm.ctl.gear_down && fm.vs < -0.5 {
            let ft = agl / FT;
            // the lowest threshold already passed
            let mut idx = None;
            for (i, c) in CALLOUTS_FT.iter().enumerate() {
                if ft <= *c as f64 {
                    idx = Some(i);
                }
            }
            if let Some(i) = idx {
                if ft > *CALLOUTS_FT.last().unwrap() as f64 * 0.5 && self.last_callout_idx.map_or(true, |l| i > l) {
                    callout = Some(CALLOUTS_FT[i]);
                    self.last_callout_idx = Some(i);
                }
            }
        }
        if agl > 400.0 || fm.vs > 1.0 {
            self.last_callout_idx = None;
        }
        GpwsOut { alert, callout_ft: callout }
    }
}
