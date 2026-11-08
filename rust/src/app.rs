//! Native window front-end (winit 0.30 `ApplicationHandler` + wgpu surface): menu, flight loop, input, camera rigs.

use crate::airports::AirportDb;
use crate::addons::State as AddonState;
use crate::clock::unix_now;
use crate::deckhost::DeckHost;
use crate::game::{Action, Flight, PilotInput, Status};
use crate::geo::*;
use crate::ui::{self as pre_ui, screens, Input, Key, Outcome, PreFlight};
use crate::gfx::ui::{self, HudInfo, View};
use crate::gfx::{Camera, FrameParams, Renderer};
use glam::{DQuat, DVec3, Vec3};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{KeyCode, PhysicalKey};
use winit::window::{Fullscreen, Window, WindowId};

#[derive(Clone, Debug)]
pub struct Options {
    pub dep: String,
    pub arr: String,
    pub uncapped: bool,
    pub autostart: bool,
    pub max_frames: Option<u64>,
}

impl Default for Options {
    fn default() -> Self {
        Self { dep: "KSFO".into(), arr: "KOAK".into(), uncapped: false, autostart: false, max_frames: None }
    }
}

pub use crate::cockpit::CamState;

/// Camera for `view` (see `cockpit::rig`).
pub fn make_camera(f: &Flight, view: View, cs: &mut CamState, dt: f64, orbit: Option<f64>) -> (Camera, bool) {
    crate::cockpit::rig(f, view, cs, dt, orbit)
}

struct Gpu {
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    renderer: Renderer,
    adapter_name: String,
}


#[derive(Clone, Debug)]
struct Launch {
    dep: String,
    arr: String,
    dep_rwy: Option<String>,
    arr_rwy: Option<String>,
    cruise_alt_m: Option<f64>,
}

enum Mode {
    /// pre-flight UI: boot, menu, planner, briefing, modals
    Pre,
    /// flight-loader scene; the flight is built when `frames` reaches the end of the loader
    Loading { launch: Launch, frames: u32 },
    Flight,
}

pub struct App {
    opts: Options,
    window: Option<Arc<Window>>,
    gpu: Option<Gpu>,
    db: AirportDb,
    flight: Option<Flight>,
    pre: PreFlight,
    inp: Input,
    last_mouse: Option<[f32; 2]>,
    last_launch: Option<Launch>,
    logged: bool,
    mode: Mode,
    keys: HashSet<KeyCode>,
    input: PilotInput,
    view: View,
    cam: CamState,
    paused: bool,
    help: bool,
    last: Instant,
    start: Instant,
    fps: f32,
    frame_ms: f32,
    sim_ms: f32,
    frames: u64,
    last_log: Instant,
    /// interactive HD flight deck (downloaded add-on) + A320 systems board
    host: DeckHost,
    prev_right: bool,
    /// departure airport whose ground tiles were last queued for disk-cache warm-up
    prefetched: String,
}



/// Maps a winit key to the UI key set (None for keys the pre-flight UI ignores).
fn map_key(code: KeyCode) -> Option<Key> {
    Some(match code {
        KeyCode::Enter | KeyCode::NumpadEnter => Key::Enter,
        KeyCode::Escape => Key::Escape,
        KeyCode::Backspace => Key::Backspace,
        KeyCode::Delete => Key::Delete,
        KeyCode::Tab => Key::Tab,
        KeyCode::ArrowUp => Key::Up,
        KeyCode::ArrowDown => Key::Down,
        KeyCode::ArrowLeft => Key::Left,
        KeyCode::ArrowRight => Key::Right,
        KeyCode::PageUp => Key::PageUp,
        KeyCode::PageDown => Key::PageDown,
        KeyCode::F1 => Key::F(1),
        KeyCode::F2 => Key::F(2),
        _ => return None,
    })
}

const LOADER_FRAMES: u32 = 18;

impl App {
    pub fn new(opts: Options) -> Self {
        let db = AirportDb::embedded();
        let mut pre = PreFlight::new(&db);
        pre.planner.dep = opts.dep.clone();
        pre.planner.arr = opts.arr.clone();
        Self {
            opts,
            window: None,
            gpu: None,
            db,
            flight: None,
            pre,
            inp: Input::default(),
            last_mouse: None,
            last_launch: None,
            logged: false,
            mode: Mode::Pre,
            keys: HashSet::new(),
            input: PilotInput::default(),
            view: View::Cockpit,
            cam: CamState::default(),
            paused: false,
            help: false,
            last: Instant::now(),
            start: Instant::now(),
            fps: 60.0,
            frame_ms: 16.6,
            sim_ms: 0.0,
            frames: 0,
            last_log: Instant::now(),
            host: DeckHost::default(),
            prev_right: false,
            prefetched: String::new(),
        }
    }


    /// Queue a launch: the flight-loader scene is shown for a few frames, then the flight is built.
    fn begin_launch(&mut self, launch: Launch) {
        self.last_launch = Some(launch.clone());
        self.flight = None;
        self.mode = Mode::Loading { launch, frames: 0 };
    }

    /// Builds the flight and enters the cockpit. On failure returns to the planner with the error shown.
    fn finish_launch(&mut self, launch: &Launch) {
        let utc = unix_now();
        match Flight::new_with_runways(&self.db, &launch.dep, &launch.arr, utc, launch.dep_rwy.as_deref(), launch.arr_rwy.as_deref(), launch.cruise_alt_m) {
            Ok(mut f) => {
                self.paused = false;
                self.logged = false;
                self.cam = CamState { cockpit_fov: self.pre.settings.fov, ..CamState::default() };
                self.cam.yaw = f.fm.heading.to_radians();
                if self.opts.autostart {
                    f.apply(Action::ApAutoTakeoff);
                }
                // real imagery needs a flat reference surface: physics, GPWS and the renderer share it
                f.terrain.flat = self.gpu.as_ref().is_some_and(|g| g.renderer.tiles().is_some());
                self.host.reset_for_flight(&f);

                self.flight = Some(f);
                self.mode = Mode::Flight;
            }
            Err(e) => {
                self.pre.planner.message = e;
                self.mode = Mode::Pre;
                self.pre.goto(pre_ui::Screen::Planner);
            }
        }
    }

    /// Marketplace plumbing: preload the downloaded model on a worker thread, upload it to the GPU when parsed, drop it on removal.
    fn service_addons(&mut self) {
        let ev = std::mem::take(&mut self.pre.market_event);
        if ev.started {
            self.host.failed = false;
        }
        let Some(gpu) = self.gpu.as_mut() else { return };
        if ev.removed || (ev.toggled && !self.pre.addons.enabled()) {
            self.host.unload();
            gpu.renderer.unload_deck();
        }
        if ev.toggled && self.pre.addons.enabled() {
            self.host.failed = false;
        }
        if !self.host.ready() && !self.host.loading() && !self.host.failed && self.pre.addons.state() == AddonState::Installed {
            if let Some((bytes, man)) = self.pre.addons.read_installed() {
                self.host.start_load(bytes, man, crate::specs::A320.eye);
            }
        }
        if let Some((mesh, images)) = self.host.poll() {
            gpu.renderer.load_deck(&mesh, &images);
            println!("{}", self.host.status);
        }
        self.pre.deck_ready = self.host.ready() && gpu.renderer.deck_loaded();
    }

    fn return_to_menu(&mut self) {
        self.flight = None;
        self.mode = Mode::Pre;
        self.pre.goto(pre_ui::Screen::Menu);
    }

    fn init_gpu(&mut self, window: Arc<Window>) {
        let size = window.inner_size();
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let surface = instance.create_surface(window.clone()).expect("create surface");
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
            apply_limit_buckets: true,
        }))
        .expect("no suitable GPU adapter");
        let info = adapter.get_info();
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("in-flight"), required_limits: crate::gfx::tile_limits(&adapter), ..Default::default() })).expect("device");
        let caps = surface.get_capabilities(&adapter);
        let format = caps.formats.iter().copied().find(|f| f.is_srgb()).unwrap_or(caps.formats[0]);
        let want = if self.opts.uncapped { [wgpu::PresentMode::Immediate, wgpu::PresentMode::Mailbox] } else { [wgpu::PresentMode::Fifo, wgpu::PresentMode::Fifo] };
        let present_mode = want.into_iter().find(|m| caps.present_modes.contains(m)).unwrap_or(wgpu::PresentMode::Fifo);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
            color_space: wgpu::SurfaceColorSpace::Auto,
        };
        surface.configure(&device, &config);
        let renderer = Renderer::new(device, queue, format, config.width, config.height);
        println!("GPU: {} ({:?}), present mode {:?}, format {:?}", info.name, info.backend, present_mode, format);
        self.gpu = Some(Gpu { surface, config, renderer, adapter_name: info.name });
    }


    fn key_pressed(&mut self, el: &ActiveEventLoop, code: KeyCode) {
        // window-level shortcuts available everywhere
        if code == KeyCode::F11 {
            if let Some(w) = &self.window {
                w.set_fullscreen(if w.fullscreen().is_some() { None } else { Some(Fullscreen::Borderless(None)) });
            }
            return;
        }
        match self.mode {
            Mode::Pre | Mode::Loading { .. } => {}
            Mode::Flight => {
                let status = self.flight.as_ref().map(|f| f.status);
                if matches!(status, Some(Status::Landed | Status::Crashed)) {
                    match code {
                        KeyCode::Enter | KeyCode::NumpadEnter => {
                            if let Some(l) = self.last_launch.clone() {
                                self.begin_launch(l);
                            }
                        }
                        KeyCode::Escape => self.return_to_menu(),
                        _ => {}
                    }
                    return;
                }
                let Some(f) = self.flight.as_mut() else { return };
                match code {
                    KeyCode::Escape => {
                        let _ = el;
                        self.return_to_menu();
                    }
                    KeyCode::KeyP => self.paused = !self.paused,
                    KeyCode::KeyM => {
                        // cycle the map / ground imagery style (satellite, Sentinel-2, streets, terrain, night lights, dark)
                        if let Some(h) = self.gpu.as_ref().and_then(|g| g.renderer.tiles()) {
                            h.cycle_style(1);
                        }
                    }
                    KeyCode::F1 => self.help = !self.help,

                    KeyCode::KeyC => {
                        self.view = self.view.next();
                        self.cam.spot = None;
                        self.cam.head.reset();
                    }
                    KeyCode::KeyG => f.apply(Action::ToggleGear),
                    KeyCode::KeyF => f.apply(Action::FlapsUp),
                    KeyCode::KeyV => f.apply(Action::FlapsDown),
                    KeyCode::KeyT => f.apply(Action::ToggleParking),
                    KeyCode::KeyR => f.apply(Action::ToggleReverse),
                    KeyCode::Space => f.apply(Action::ToggleSpeedbrake),
                    KeyCode::KeyK => f.apply(Action::ToggleSpoilers),
                    KeyCode::KeyJ => f.apply(Action::CycleAutobrake),
                    KeyCode::KeyX => f.apply(Action::ThrottleIdle),
                    KeyCode::KeyZ => f.apply(Action::ThrottleToga),
                    KeyCode::Tab => f.apply(Action::ApToggle),
                    KeyCode::KeyL => f.apply(Action::ApToggleAppr),
                    KeyCode::KeyN => {
                        if !f.ap.nav {
                            f.apply(Action::ApToggleNav)
                        }
                    }
                    KeyCode::KeyH => {
                        if f.ap.nav {
                            f.apply(Action::ApToggleNav)
                        }
                    }
                    KeyCode::ArrowUp => f.apply(Action::ApAlt(100.0)),
                    KeyCode::ArrowDown => f.apply(Action::ApAlt(-100.0)),
                    KeyCode::BracketRight => f.apply(Action::ApSpd(5.0)),
                    KeyCode::BracketLeft => f.apply(Action::ApSpd(-5.0)),
                    KeyCode::ArrowRight => f.apply(Action::ApHdg(5.0)),
                    KeyCode::ArrowLeft => f.apply(Action::ApHdg(-5.0)),
                    KeyCode::PageUp => f.apply(Action::ApVs(500.0)),
                    KeyCode::PageDown => f.apply(Action::ApVs(-500.0)),
                    KeyCode::Equal => f.apply(Action::TrimUp),
                    KeyCode::Minus => f.apply(Action::TrimDown),
                    _ => {}
                }
            }
        }
    }

    fn update_input(&mut self, dt: f64) {
        let k = |c: KeyCode| self.keys.contains(&c) as i32 as f64;
        let st = &self.pre.settings;
        let sgn = if st.invert_pitch { -1.0 } else { 1.0 };
        let sens = st.sens as f64;
        let tgt = ((k(KeyCode::KeyS) - k(KeyCode::KeyW)) * sgn * sens.min(1.0), (k(KeyCode::KeyD) - k(KeyCode::KeyA)) * sens.min(1.0), k(KeyCode::KeyE) - k(KeyCode::KeyQ));
        let mv = |cur: f64, t: f64| {
            let rate = if t == 0.0 { 4.0 } else { 3.0 * sens };
            cur + clamp(t - cur, -rate * dt, rate * dt)
        };
        self.input.pitch = mv(self.input.pitch, tgt.0);
        self.input.roll = mv(self.input.roll, tgt.1);
        self.input.yaw = mv(self.input.yaw, tgt.2);
        let up = self.keys.contains(&KeyCode::ShiftLeft) || self.keys.contains(&KeyCode::ShiftRight);
        let dn = self.keys.contains(&KeyCode::ControlLeft) || self.keys.contains(&KeyCode::ControlRight);
        self.input.throttle_rate = (up as i32 - dn as i32) as f64 * 0.35;
        self.input.brake = if self.keys.contains(&KeyCode::KeyB) { 1.0 } else { 0.0 };
    }

    fn redraw(&mut self, el: &ActiveEventLoop) {
        let now = Instant::now();
        let dt = (now - self.last).as_secs_f64().min(0.25);
        self.last = now;
        self.frame_ms += (dt as f32 * 1000.0 - self.frame_ms) * 0.05;
        self.fps = 1000.0 / self.frame_ms.max(0.01);
        self.update_input(dt);
        self.service_addons();

        // ---- warm the tile disk cache around a newly chosen departure airport (idle-priority, never blocks) ----
        if matches!(self.mode, Mode::Pre) {
            if self.prefetched.is_empty() {
                self.prefetched = self.pre.planner.dep.clone(); // don't prefetch the default pick at start-up
            } else if self.prefetched != self.pre.planner.dep {
                self.prefetched = self.pre.planner.dep.clone();
                if let (Some(h), Some(a)) = (self.gpu.as_ref().and_then(|g| g.renderer.tiles()), self.db.find(&self.prefetched)) {
                    h.prefetch(crate::tiles::ground::prefetch_keys(h.style(), a.lat, a.lon));
                }
            }
        }

        // ---- simulate ----

        let t_sim = Instant::now();
        if let (Mode::Flight, Some(f)) = (&self.mode, self.flight.as_mut()) {
            if !self.paused {
                f.advance(dt, &self.input);
            }
            self.host.update(if self.paused { 0.0 } else { dt }, f);
        }
        self.sim_ms += (t_sim.elapsed().as_secs_f32() * 1000.0 - self.sim_ms) * 0.05;

        // ---- logbook: record a completed landing once ----
        if let (Mode::Flight, Some(f)) = (&self.mode, self.flight.as_ref()) {
            if !self.logged && f.status == Status::Landed {
                if let Some(td) = f.touchdown {
                    self.logged = true;
                    self.pre.logbook.push(pre_ui::modals::LogEntry {
                        utc: f.utc(),
                        dep: f.dep.icao.clone(),
                        arr: f.arr.icao.clone(),
                        grade: td.grade.to_string(),
                        fpm: td.fpm,
                        speed_kt: td.speed_kt,
                        centreline_m: td.centreline_m,
                    });
                    pre_ui::modals::save_logbook(&self.pre.logbook);
                }
            }
        }

        // ---- launch state machine ----
        if let Mode::Loading { launch, frames } = &mut self.mode {
            *frames += 1;
            if *frames > LOADER_FRAMES {
                let l = launch.clone();
                self.finish_launch(&l);
            }
        }

        let Some(gpu) = self.gpu.as_mut() else { return };
        let time = self.start.elapsed().as_secs_f64();
        let in_flight = matches!(self.mode, Mode::Flight);
        let (cam, show_ac, params_data) = match (&self.flight, in_flight) {
            (Some(f), true) => {
                let (cam, third) = make_camera(f, self.view, &mut self.cam, dt, None);
                (cam, third, (f.utc(), f.lat, f.lon, f.weather.vis_km as f32, f.weather.cloud_base_m as f32, f.weather.cloud_cover as f32))
            }
            // pre-flight screens paint their own opaque background; the 3D pass only needs a harmless sky camera
            _ => (Camera { pos: DVec3::new(0.0, 100.0, 0.0), fwd: Vec3::new(0.0, 0.1, -1.0).normalize(), up: Vec3::Y, fov_deg: 60.0, near: 0.5 }, false, (unix_now(), 0.0, 0.0, 30.0f32, 3000.0f32, 0.0f32)),
        };
        let (utc, lat, lon, vis, cb, cc) = params_data;

        // ---- interactive flight deck: cursor picking, press / drag / wheel, free-look on the right button ----
        let interior = in_flight && self.view.is_interior();
        let cam_copy = Camera { pos: cam.pos, fwd: cam.fwd, up: cam.up, fov_deg: cam.fov_deg, near: cam.near };
        let deck_active = interior && self.host.ready();
        if let (true, Some(f)) = (interior, self.flight.as_mut()) {
            let right_pressed = self.inp.right_down && !self.prev_right;
            let shift = self.keys.contains(&KeyCode::ShiftLeft) || self.keys.contains(&KeyCode::ShiftRight);
            let size = gpu.config.width as f32;
            let size = (size, gpu.config.height as f32);
            let over = self.host.mouse(f, &cam_copy, self.inp.mouse, size, self.inp.pressed, self.inp.down, right_pressed, self.inp.delta, shift);
            if self.inp.right_down && !self.host.captured && !(over && right_pressed) {
                self.cam.head.apply(1.0, self.inp.delta[0] as f64 * 0.12, -(self.inp.delta[1] as f64) * 0.12, 0.0);
            }
            if self.host.wheel != 0.0 {
                self.cam.head.apply(1.0, 0.0, 0.0, self.host.wheel as f64 * 0.12);
                self.host.wheel = 0.0;
            }
            if self.host.ready() {
                gpu.renderer.set_deck_slots(&self.host.slots);
            }
        } else {
            self.host.hover = None;
            self.host.captured = false;
        }
        self.prev_right = self.inp.right_down;

        // ---- acquire frame ----
        let frame = match gpu.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                gpu.surface.configure(&gpu.renderer.device, &gpu.config);
                return;
            }
            _ => return,
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let info = HudInfo { fps: self.fps, frame_ms: self.frame_ms, sim_ms: self.sim_ms, view: self.view, paused: self.paused, help: self.help, time, panels3d: in_flight && self.view.is_interior() };
        let flight_ref = if in_flight { self.flight.as_ref() } else { None };
        let fp = FrameParams { flight: flight_ref, cam, utc, time: time as f32, lat, lon, vis_km: vis, cloud_base: cb, cloud_cover: cc, show_aircraft: show_ac, cockpit: in_flight && self.view.is_interior() };
        let fps = self.fps;
        let help = self.help;
        let wall_utc = unix_now();
        let host_ref = &self.host;
        let mouse = self.inp.mouse;
        let panels3d = in_flight && self.view.is_interior();
        let mut outcome = Outcome::None;
        {
            let pre = &mut self.pre;
            let inp = &self.inp;
            let db = &self.db;
            let mode = &self.mode;
            let out_ref = &mut outcome;
            gpu.renderer.render(&view, &fp, &mut |u| match mode {
                Mode::Pre => *out_ref = pre.frame(u, inp, db, wall_utc, dt, fps),
                Mode::Loading { launch, frames } => {
                    if let (Some(d), Some(a)) = (db.find(&launch.dep), db.find(&launch.arr)) {
                        let mut g = pre_ui::Gui::new(u, inp, time);
                        let p = (*frames as f32 / LOADER_FRAMES as f32).min(1.0);
                        let stage = ((p * 5.0) as usize).min(5);
                        let detail = ["Surveying runways and taxiways...", "Generating simulated weather...", "Building airfield scenery and terrain...", "Initialising flight model and autopilot...", "Compiling shaders and uploading fonts..."][stage.min(4)];
                        screens::draw_flight_loader(&mut g, d, a, p, stage, detail);
                    }
                }
                Mode::Flight => {
                    if let Some(f) = flight_ref {
                        ui::draw_hud(u, f, &info);
                        if deck_active || (panels3d && !host_ref.ready()) {
                            host_ref.draw_overlay(u, f, &cam_copy, mouse);
                        }
                        if help {
                            let b = (u.h / 46.0).clamp(11.0, 26.0);
                            ui::draw_help(u, b);
                        }
                    }
                }
            });
        }
        gpu.renderer.queue.present(frame);
        let stats = gpu.renderer.stats;
        self.inp.end_frame();

        self.frames += 1;
        if self.last_log.elapsed().as_secs_f32() > 5.0 {
            self.last_log = Instant::now();
            let s = stats;
            println!("{:.1} FPS | frame {:.2} ms | sim {:.2} ms | terrain {:.2} ms | scatter {:.2} ms | ui {:.2} ms | draws {} | tris {}k | rss {} MB", self.fps, self.frame_ms, self.sim_ms, s.terrain_ms, s.scatter_ms, s.ui_ms, s.draw_calls, s.triangles / 1000, rss_mb());
        }
        if self.opts.max_frames.is_some_and(|m| self.frames >= m) {
            el.exit();
        }
        match outcome {
            Outcome::None => {}
            Outcome::Quit => el.exit(),
            Outcome::Start { dep, arr, dep_rwy, arr_rwy, cruise_alt_m } => self.begin_launch(Launch { dep, arr, dep_rwy, arr_rwy, cruise_alt_m }),
        }

    }
}


/// Resident set size in MB (Linux); 0 elsewhere.
pub fn rss_mb() -> u64 {
    std::fs::read_to_string("/proc/self/statm").ok().and_then(|s| s.split_whitespace().nth(1).and_then(|v| v.parse::<u64>().ok())).map_or(0, |p| p * 4096 / 1024 / 1024)
}

impl ApplicationHandler for App {
    fn resumed(&mut self, el: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attrs = Window::default_attributes().with_title("In-Flight (Rust) - A320").with_inner_size(LogicalSize::new(1280.0, 720.0));
        let window = Arc::new(el.create_window(attrs).expect("window"));
        self.init_gpu(window.clone());
        if let Some(g) = &self.gpu {
            window.set_title(&format!("In-Flight (Rust) - A320 - {}", g.adapter_name));
        }
        self.window = Some(window);
        if self.opts.autostart {
            self.pre.skip_boot(&self.db);
            self.begin_launch(Launch { dep: self.opts.dep.clone(), arr: self.opts.arr.clone(), dep_rwy: None, arr_rwy: None, cruise_alt_m: None });
        }
    }

    fn window_event(&mut self, el: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => el.exit(),
            WindowEvent::Resized(s) => {
                if let Some(g) = self.gpu.as_mut() {
                    if s.width > 0 && s.height > 0 {
                        g.config.width = s.width;
                        g.config.height = s.height;
                        g.surface.configure(&g.renderer.device, &g.config);
                        g.renderer.resize(s.width, s.height);
                    }
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                let p = [position.x as f32, position.y as f32];
                if let Some(l) = self.last_mouse {
                    self.inp.delta = [self.inp.delta[0] + p[0] - l[0], self.inp.delta[1] + p[1] - l[1]];
                }
                self.last_mouse = Some(p);
                self.inp.mouse = p;
            }
            WindowEvent::CursorLeft { .. } => self.last_mouse = None,
            WindowEvent::MouseInput { state, button, .. } => match (button, state) {
                (MouseButton::Left, ElementState::Pressed) => {
                    self.inp.pressed = true;
                    self.inp.down = true;
                }
                (MouseButton::Left, ElementState::Released) => {
                    self.inp.released = true;
                    self.inp.down = false;
                }
                (MouseButton::Right, s) => self.inp.right_down = s == ElementState::Pressed,
                _ => {}
            },
            WindowEvent::KeyboardInput { event, .. } => {
                if let PhysicalKey::Code(code) = event.physical_key {
                    match event.state {
                        ElementState::Pressed => {
                            self.keys.insert(code);
                            if matches!(self.mode, Mode::Pre) {
                                if let Some(k) = map_key(code) {
                                    self.inp.keys.push(k);
                                } else if let Some(n) = match code {
                                    KeyCode::F2 => Some(2u8),
                                    _ => None,
                                } {
                                    let _ = n;
                                }
                                if let Some(t) = event.text.as_ref() {
                                    if !self.keys.contains(&KeyCode::ControlLeft) {
                                        self.inp.typed.push_str(t.as_str());
                                    }
                                }
                                if !event.repeat && code == KeyCode::F11 {
                                    self.key_pressed(el, code);
                                }
                            } else if !event.repeat {
                                self.key_pressed(el, code);
                            }
                        }
                        ElementState::Released => {
                            self.keys.remove(&code);
                        }
                    }
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let y = match delta {
                    MouseScrollDelta::LineDelta(_, y) => y as f64,
                    MouseScrollDelta::PixelDelta(p) => p.y / 40.0,
                };
                if matches!(self.mode, Mode::Flight) {
                    if self.view.is_interior() {
                        self.host.wheel += y as f32;
                    }
                    self.cam.dist = clamp(self.cam.dist * (1.0 - y * 0.08), 0.35, 6.0);
                } else {
                    self.inp.wheel += y as f32;
                }
            }
            WindowEvent::RedrawRequested => self.redraw(el),
            _ => {}
        }
    }

    fn about_to_wait(&mut self, _el: &ActiveEventLoop) {
        if let Some(w) = &self.window {
            w.request_redraw();
        }
    }
}

pub fn run(opts: Options) {
    let event_loop = EventLoop::new().expect("event loop");
    event_loop.set_control_flow(ControlFlow::Poll);
    let mut app = App::new(opts);
    event_loop.run_app(&mut app).expect("run");
    let _ = DQuat::IDENTITY;
}
