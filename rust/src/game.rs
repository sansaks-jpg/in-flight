//! Flight session: owns the aircraft, autopilot, flight plan, terrain, weather and run state.
//!
//! The simulation runs on a fixed 120 Hz step (autopilot at 60 Hz) driven by an accumulator in [`Flight::advance`], so
//! physics are frame-rate independent and a slow frame can never destabilise the aircraft. Nothing here allocates per
//! step (messages reuse a bounded buffer).

use crate::airports::{Airport, AirportDb, RunwayEnd};
use crate::autopilot::{ApPhase, Autopilot, IlsData};
use crate::geo::*;
use crate::gpws::{Alert, Gpws, GpwsOut};
use crate::nav::*;
use crate::physics::{ContactKind, FlightModel};
use crate::terrain::Terrain;
use crate::weather::Weather;

pub const PHYS_HZ: f64 = 120.0;
pub const PHYS_DT: f64 = 1.0 / PHYS_HZ;
const MAX_SUBSTEPS: u32 = 10;
const MAX_MSGS: usize = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Ready,
    Flying,
    Landed,
    Crashed,
}

/// Continuous pilot demands (keyboard / gamepad mapped by the app).
#[derive(Clone, Copy, Debug, Default)]
pub struct PilotInput {
    pub pitch: f64,
    pub roll: f64,
    pub yaw: f64,
    /// throttle lever change per second (-1..1); the lever itself persists in the model
    pub throttle_rate: f64,
    pub brake: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Action {
    ToggleGear,
    FlapsUp,
    FlapsDown,
    ToggleParking,
    ToggleReverse,
    ToggleSpeedbrake,
    CycleAutobrake,
    ToggleSpoilers,
    ApToggle,
    ApAutoTakeoff,
    ApToggleAppr,
    ApToggleNav,
    ApAlt(f64),
    ApSpd(f64),
    ApHdg(f64),
    ApVs(f64),
    TrimUp,
    TrimDown,
    ThrottleIdle,
    ThrottleToga,
}

#[derive(Clone, Copy, Debug)]
pub struct Touchdown {
    pub fpm: f64,
    pub speed_kt: f64,
    pub bank_deg: f64,
    pub pitch_deg: f64,
    pub centreline_m: f64,
    pub grade: &'static str,
}

pub struct Flight {
    pub proj: Projection,
    pub dep: Airport,
    pub arr: Airport,
    pub dep_end: RunwayEnd,
    pub arr_end: RunwayEnd,
    pub plan: Vec<Waypoint>,
    pub active_wp: usize,
    pub fm: FlightModel,
    pub ap: Autopilot,
    pub terrain: Terrain,
    pub weather: Weather,
    pub gpws: Gpws,
    pub gpws_out: GpwsOut,
    pub ils: IlsData,
    pub utc0: f64,
    pub t: f64,
    pub status: Status,
    pub lat: f64,
    pub lon: f64,
    pub touchdown: Option<Touchdown>,
    pub msgs: Vec<(f64, &'static str)>,
    pub steps: u64,
    pub arr_xz: (f64, f64),
    pub dep_xz: (f64, f64),
    acc: f64,
    ap_tick: u32,
    gpws_tick: u32,
    was_airborne: bool,
    last_wow_gs: f64,
}

fn seed_for(utc: f64, icao: &str) -> u64 {
    let day = (utc / 86400.0).floor() as u64;
    icao.bytes().fold(day.wrapping_mul(0x9E37_79B9), |a, b| a.rotate_left(5) ^ (b as u64).wrapping_mul(0x100_0000_01B3))
}

impl Flight {
    /// Cold-start free-flight: aircraft on the departure runway, engines running, parking brake set.
    pub fn new(db: &AirportDb, dep_code: &str, arr_code: &str, utc: f64) -> Result<Self, String> {
        let dep = db.find(dep_code).ok_or_else(|| format!("Unknown departure airport '{dep_code}'"))?.clone();
        let arr = db.find(arr_code).ok_or_else(|| format!("Unknown arrival airport '{arr_code}'"))?.clone();
        if dep.runways.is_empty() {
            return Err(format!("{} has no runway data", dep.icao));
        }
        if arr.runways.is_empty() {
            return Err(format!("{} has no runway data", arr.icao));
        }
        let weather = Weather::generate(seed_for(utc, &dep.icao));
        let dep_end = dep.best_end(weather.wind_from_deg).ok_or("no departure runway")?;
        let arr_end = arr.best_end(weather.wind_from_deg).ok_or("no arrival runway")?;
        let proj = Projection::new(dep.lat, dep.lon);
        let mut terrain = Terrain::new((seed_for(0.0, "TERRAIN") & 0xffff) as u32);
        let dep_xz = (proj.x(dep.lon), proj.z(dep.lat));
        let arr_xz = (proj.x(arr.lon), proj.z(arr.lat));
        terrain.add_airport(dep_xz.0, dep_xz.1, dep.elev);
        if haversine(dep.lat, dep.lon, arr.lat, arr.lon) > 100.0 {
            terrain.add_airport(arr_xz.0, arr_xz.1, arr.elev);
        }
        let plan = build_plan(&dep, &dep_end, &arr, &arr_end, 11000.0);
        let mut fm = FlightModel::new(None);
        // fuel for the trip + reserves (the original loads trip fuel as well)
        let route = haversine(dep.lat, dep.lon, arr.lat, arr.lon);
        fm.fuel = clamp(2600.0 + route / 1000.0 * 2.6, 3200.0, fm.spec.fuel_cap);
        fm.mass = fm.total_mass();
        let (x, z) = (proj.x(dep_end.start_lon), proj.z(dep_end.start_lat));
        fm.place_on_runway(x, z, dep_end.hdg, terrain.height(x, z), false);
        fm.ctl.flaps_idx = fm.spec.flap_detents.min(2);
        fm.flaps_pos = fm.ctl.flaps_idx as f64 / fm.spec.flap_detents as f64;
        fm.air.d_t = weather.d_t;
        fm.air.qnh = weather.qnh;
        let mut f = Self {
            proj,
            dep,
            arr,
            dep_end,
            arr_end,
            plan,
            active_wp: 0,
            fm,
            ap: Autopilot::default(),
            terrain,
            weather,
            gpws: Gpws::default(),
            gpws_out: GpwsOut { alert: Alert::None, callout_ft: None },
            ils: IlsData::default(),
            utc0: utc,
            t: 0.0,
            status: Status::Ready,
            lat: 0.0,
            lon: 0.0,
            touchdown: None,
            msgs: Vec::with_capacity(MAX_MSGS + 1),
            steps: 0,
            arr_xz,
            dep_xz,
            acc: 0.0,
            ap_tick: 0,
            gpws_tick: 0,
            was_airborne: false,
            last_wow_gs: 0.0,
        };
        f.ap.hdg = f.dep_end.hdg.round();
        f.ap.alt_ft = (plan_cruise_alt_m(&f.plan).unwrap_or(1000.0) / FT).round();
        f.update_geo();
        f.say("Ready for departure. Parking brake SET, flaps CONF 2.");
        Ok(f)
    }

    pub fn utc(&self) -> f64 {
        self.utc0 + self.t
    }

    pub fn say(&mut self, m: &'static str) {
        if self.msgs.len() >= MAX_MSGS {
            self.msgs.remove(0);
        }
        self.msgs.push((self.t, m));
    }

    fn update_geo(&mut self) {
        self.lat = self.proj.lat(self.fm.pos.z);
        self.lon = self.proj.lon(self.fm.pos.x);
    }

    pub fn ground_at(&self, x: f64, z: f64) -> f64 {
        self.terrain.height(x, z)
    }

    fn update_ils(&mut self) {
        let e = &self.arr_end;
        let (tx, tz) = (self.proj.x(e.thr_lon), self.proj.z(e.thr_lat));
        let h = e.hdg.to_radians();
        let (dx, dz) = (self.fm.pos.x - tx, self.fm.pos.z - tz);
        let along = dx * h.sin() - dz * h.cos();
        let cross = dx * h.cos() + dz * h.sin();
        let dist = -along;
        let valid = dist < 46000.0 && dist > -4000.0 && if dist > 0.0 { (cross.abs() / dist.max(1.0)).atan().to_degrees() < 40.0 } else { cross.abs() < 300.0 };
        let elev = self.arr.elev;
        let beam = elev + 15.0 + dist.max(0.0) * (3.0 * D2R).tan();
        let d_eff = dist.max(300.0);
        self.ils = IlsData {
            valid,
            dist,
            cross,
            loc_dots: clamp(-cross / (d_eff * 0.0218), -2.5, 2.5),
            gs_dots: clamp((beam - self.fm.pos.y) / (d_eff * 0.0061), -2.5, 2.5),
            course: e.hdg,
            elev,
        };
    }

    pub fn apply(&mut self, a: Action) {
        let fm = &mut self.fm;
        let det = fm.spec.flap_detents;
        match a {
            Action::ToggleGear => {
                fm.ctl.gear_down = !fm.ctl.gear_down;
                self.say(if self.fm.ctl.gear_down { "Gear DOWN" } else { "Gear UP" });
            }
            Action::FlapsUp => fm.ctl.flaps_idx = fm.ctl.flaps_idx.saturating_sub(1),
            Action::FlapsDown => fm.ctl.flaps_idx = (fm.ctl.flaps_idx + 1).min(det),
            Action::ToggleParking => {
                fm.ctl.parking = !fm.ctl.parking;
                self.say(if self.fm.ctl.parking { "Parking brake SET" } else { "Parking brake RELEASED" });
            }
            Action::ToggleReverse => fm.ctl.reverse = !fm.ctl.reverse,
            Action::ToggleSpeedbrake => fm.ctl.speedbrake = if fm.ctl.speedbrake > 0.1 { 0.0 } else { 0.6 },
            Action::CycleAutobrake => fm.ctl.autobrake = (fm.ctl.autobrake + 1) % 4,
            Action::ToggleSpoilers => fm.ctl.spoilers_armed = !fm.ctl.spoilers_armed,
            Action::TrimUp => fm.ctl.trim = clamp(fm.ctl.trim + 0.05, -1.0, 1.0),
            Action::TrimDown => fm.ctl.trim = clamp(fm.ctl.trim - 0.05, -1.0, 1.0),
            Action::ThrottleIdle => fm.ctl.throttle = 0.0,
            Action::ThrottleToga => fm.ctl.throttle = 1.0,
            Action::ApToggle => {
                if self.ap.on {
                    self.ap.disengage();
                    self.fm.ctl.ap_hold = false;
                    self.say("AUTOPILOT OFF");
                } else {
                    self.engage_ap();
                }
            }
            Action::ApAutoTakeoff => {
                if self.fm.wow && self.fm.gs < 5.0 {
                    self.engage_ap();
                }
            }
            Action::ApToggleAppr => {
                self.ap.appr = !self.ap.appr;
                if !self.ap.appr {
                    self.ap.gs_captured = false;
                }
                self.say(if self.ap.appr { "APPR armed" } else { "APPR off" });
            }
            Action::ApToggleNav => {
                let n = !self.ap.nav;
                self.ap.set_lateral_mode_nav(n);
                self.say(if n { "LNAV (managed)" } else { "HDG (selected)" });
            }
            Action::ApAlt(d) => {
                self.ap.alt_selected = true;
                self.ap.alt_ft = clamp(self.ap.alt_ft + d, 0.0, 41000.0);
            }
            Action::ApSpd(d) => {
                self.ap.spd_selected = true;
                self.ap.spd = clamp(self.ap.spd + d, 120.0, 340.0);
            }
            Action::ApHdg(d) => {
                self.ap.set_lateral_mode_nav(false);
                self.ap.hdg = wrap360(self.ap.hdg + d);
            }
            Action::ApVs(d) => {
                let cur = self.ap.vs_hold_fpm.unwrap_or(0.0);
                self.ap.vs_hold_fpm = Some(clamp(cur + d, -4000.0, 4000.0));
                self.ap.alt_selected = true;
            }
        }
    }

    fn engage_ap(&mut self) {
        if self.fm.wow && self.fm.gs < 5.0 {
            let tgt = plan_cruise_alt_m(&self.plan);
            self.fm.ctl.parking = false;
            self.ap.arm_takeoff(&self.fm, self.dep_end.hdg, tgt);
            self.ap.alt_selected = false;
            self.ap.spd_selected = false;
            self.active_wp = 1;
            self.say("AUTO TAKEOFF - TOGA");
        } else {
            let hdg = self.fm.heading.round();
            self.ap.engage(&self.fm, Some(hdg));
            self.ap.alt_selected = false;
            self.ap.spd_selected = false;
            self.active_wp = advance_waypoint(&self.plan, self.active_wp, self.lat, self.lon, self.fm.gs, true);
            self.say("AUTOPILOT ON - LNAV / VNAV");
        }
        self.fm.ctl.ap_hold = true;
    }

    /// Advance the simulation by `frame_dt` real seconds using fixed physics steps. Returns the number of steps taken.
    pub fn advance(&mut self, frame_dt: f64, input: &PilotInput) -> u32 {
        self.acc += frame_dt.clamp(0.0, 0.25);
        let mut n = 0;
        while self.acc >= PHYS_DT && n < MAX_SUBSTEPS {
            self.step(PHYS_DT, input);
            self.acc -= PHYS_DT;
            n += 1;
        }
        if n == MAX_SUBSTEPS {
            self.acc = 0.0; // drop the backlog instead of spiralling
        }
        n
    }

    pub fn step(&mut self, dt: f64, input: &PilotInput) {
        if self.status == Status::Crashed {
            return;
        }
        self.steps += 1;
        self.t += dt;
        // ---- environment ----
        let agl = self.fm.agl.max(0.0);
        self.fm.wind = self.weather.wind_vec(agl);
        self.fm.gust = if self.status == Status::Ready { glam::DVec3::ZERO } else { self.weather.gust_vec(self.t, agl) };
        self.update_geo();
        self.update_ils();

        // ---- pilot / autopilot ----
        self.ap_tick += 1;
        if self.ap_tick >= 2 {
            self.ap_tick = 0;
            if self.ap.on {
                self.active_wp = advance_waypoint(&self.plan, self.active_wp, self.lat, self.lon, self.fm.gs, !self.fm.wow);
                // auto-capture the localizer / glideslope once established on the landing leg
                let landing = self.plan.get(self.active_wp).is_some_and(|w| matches!(w.kind, WpType::Faf | WpType::Touchdown));
                if landing && self.ils.valid && self.ils.dist < 30000.0 && self.ils.cross.abs() < 1800.0 && !self.ap.appr {
                    self.ap.appr = true;
                }
                let cmd = self.ap.step(&self.fm, dt * 2.0, Some(&self.ils), &self.plan, self.active_wp, self.lat, self.lon);
                let c = &mut self.fm.ctl;
                c.pitch = cmd.pitch;
                c.roll = cmd.roll;
                c.yaw = cmd.yaw;
                c.throttle = cmd.throttle;
                c.gear_down = cmd.gear_down;
                c.flaps_idx = cmd.flaps_idx;
                c.brake = cmd.brake;
                c.parking = cmd.parking;
                c.reverse = cmd.reverse;
                c.speedbrake = cmd.speedbrake;
                c.ap_hold = true;
                // a firm stick input disconnects the autopilot (like the real sidestick takeover)
                if input.pitch.abs() > 0.7 || input.roll.abs() > 0.7 {
                    self.ap.disengage();
                    self.fm.ctl.ap_hold = false;
                    self.say("AUTOPILOT OFF (stick takeover)");
                }
                if !self.ap.on && self.ap.phase == ApPhase::Stopped {
                    self.fm.ctl.ap_hold = false;
                }
            }
        }
        if !self.ap.on {
            let c = &mut self.fm.ctl;
            c.ap_hold = false;
            c.pitch = input.pitch;
            c.roll = input.roll;
            c.yaw = input.yaw;
            c.throttle = clamp(c.throttle + input.throttle_rate * dt, 0.0, 1.0);
            if !c.parking {
                c.brake = input.brake;
            } else if input.brake > 0.1 {
                c.brake = input.brake;
            }
        }

        // ---- physics ----
        let terrain = &self.terrain;
        let ground = |x: f64, z: f64| terrain.height(x, z);
        self.fm.step(dt, &ground);

        // ---- state machine / events ----
        if !self.fm.wow && self.fm.airborne_time > 2.0 && self.fm.agl > 3.0 {
            if !self.was_airborne {
                self.was_airborne = true;
                self.status = Status::Flying;
                self.say("Airborne");
            }
        }
        if self.fm.wow {
            self.last_wow_gs = self.fm.gs;
        }
        let mut ev_buf = [None; 4];
        let mut k = 0;
        for e in self.fm.events.drain(..) {
            if e.kind != ContactKind::Hull && k < ev_buf.len() {
                ev_buf[k] = Some(e);
                k += 1;
            }
        }
        for e in ev_buf.iter().flatten() {
            if e.kind == ContactKind::Touchdown && self.touchdown.is_none() && self.was_airborne {
                let fpm = -e.vs * 196.85;
                let (px, pz) = (e.point.x, e.point.z);
                let (tx, tz) = (self.proj.x(self.arr_end.thr_lon), self.proj.z(self.arr_end.thr_lat));
                let h = self.arr_end.hdg.to_radians();
                let cl = (px - tx) * h.cos() + (pz - tz) * h.sin();
                let grade = if fpm < 120.0 { "BUTTER" } else if fpm < 240.0 { "SMOOTH" } else if fpm < 420.0 { "FIRM" } else if fpm < 600.0 { "HARD" } else { "VERY HARD" };
                self.touchdown = Some(Touchdown { fpm, speed_kt: e.speed / KT, bank_deg: e.bank.to_degrees(), pitch_deg: e.pitch.to_degrees(), centreline_m: cl, grade });
                self.say("Touchdown");
            }
        }
        if self.fm.crashed {
            self.status = Status::Crashed;
            self.ap.disengage();
            self.say("AIRCRAFT DESTROYED");
        } else if self.was_airborne && self.fm.wow && self.fm.gs < 1.0 && self.touchdown.is_some() {
            if self.status != Status::Landed {
                self.status = Status::Landed;
                self.say("Flight complete - aircraft stopped");
            }
        }

        // ---- GPWS (20 Hz) ----
        self.gpws_tick += 1;
        if self.gpws_tick >= 6 {
            self.gpws_tick = 0;
            let terrain = &self.terrain;
            let g = |x: f64, z: f64| terrain.height(x, z);
            self.gpws_out = self.gpws.update(&self.fm, Some(&self.ils), &g);
        }
    }

    /// Distance (m) and ETA (s) to the active waypoint.
    pub fn next_wp(&self) -> Option<(&Waypoint, f64, f64)> {
        let mut i = self.active_wp.min(self.plan.len().saturating_sub(1));
        while i + 1 < self.plan.len() && !self.fm.wow && self.plan[i].kind == WpType::Takeoff {
            i += 1;
        }
        let w = self.plan.get(i)?;
        let d = haversine(self.lat, self.lon, w.lat, w.lon);
        Some((w, d, d / self.fm.gs.max(40.0)))
    }

    /// Total distance (m) still to fly to the touchdown fix.
    pub fn dist_to_go(&self) -> f64 {
        match self.plan.iter().position(|w| w.kind == WpType::Touchdown) {
            Some(td) => plan_distance_m(&self.plan, self.active_wp.min(td), self.lat, self.lon, td),
            None => 0.0,
        }
    }
}
