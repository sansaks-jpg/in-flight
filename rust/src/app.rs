//! Native window front-end (winit 0.30 `ApplicationHandler` + wgpu surface): menu, flight loop, input, camera rigs.

use crate::airports::AirportDb;
use crate::clock::unix_now;
use crate::game::{Action, Flight, PilotInput, Status};
use crate::geo::*;
use crate::gfx::ui::{self, HudInfo, MenuState, View};
use crate::gfx::{Camera, FrameParams, Renderer};
use glam::{DQuat, DVec3, Vec3};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, MouseScrollDelta, WindowEvent};
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

/// Camera rig state (smoothed chase yaw, tower spot).
pub struct CamState {
    pub yaw: f64,
    pub spot: Option<DVec3>,
    pub dist: f64,
}
impl Default for CamState {
    fn default() -> Self {
        Self { yaw: 0.0, spot: None, dist: 1.0 }
    }
}

pub fn make_camera(f: &Flight, view: View, cs: &mut CamState, dt: f64, orbit: Option<f64>) -> (Camera, bool) {
    let fm = &f.fm;
    let q = fm.quat;
    if let Some(t) = orbit {
        // menu: slow orbit around the aircraft on the runway
        let a = t * 0.12;
        let pos = fm.pos + DVec3::new(a.sin() * 75.0, 14.0 + 4.0 * (t * 0.3).sin(), a.cos() * 75.0);
        let target = fm.pos + DVec3::new(0.0, 2.5, 0.0);
        let fwd = (target - pos).normalize().as_vec3();
        return (Camera { pos, fwd, up: Vec3::Y, fov_deg: 50.0, near: 0.5 }, true);
    }
    match view {
        View::Cockpit => {
            let eye = DVec3::from_array(fm.spec.eye);
            let pos = fm.pos + q * eye;
            let fwd = (q * DVec3::new(0.0, 0.0, -1.0)).as_vec3();
            let up = (q * DVec3::Y).as_vec3();
            (Camera { pos, fwd, up, fov_deg: 62.0, near: 0.3 }, false)
        }
        View::Chase => {
            let target_yaw = if fm.gs > 15.0 { fm.track.to_radians() } else { fm.heading.to_radians() };
            let d = wrap180((target_yaw - cs.yaw).to_degrees()).to_radians();
            cs.yaw += d * (1.0 - (-dt * 2.5).exp());
            let back = DVec3::new(-cs.yaw.sin(), 0.0, cs.yaw.cos());
            let pos = fm.pos + back * (62.0 * cs.dist) + DVec3::new(0.0, 14.0 + 6.0 * cs.dist, 0.0);
            let target = fm.pos + DVec3::new(0.0, 2.0, 0.0);
            let fwd = (target - pos).normalize().as_vec3();
            (Camera { pos, fwd, up: Vec3::Y, fov_deg: 55.0, near: 0.5 }, true)
        }
        View::Tower => {
            let ahead = if fm.gs > 10.0 { DVec3::new(fm.vel.x, 0.0, fm.vel.z).normalize() } else { DVec3::new(fm.forward().x, 0.0, fm.forward().z).normalize_or(DVec3::NEG_Z) };
            let need_new = cs.spot.map_or(true, |s| (s - fm.pos).length() > 1800.0 || (s - fm.pos).dot(ahead) < -150.0);
            if need_new {
                let right = DVec3::new(-ahead.z, 0.0, ahead.x);
                let p = fm.pos + ahead * 700.0 + right * 120.0;
                let gy = f.terrain.height(p.x, p.z) + 3.0;
                cs.spot = Some(DVec3::new(p.x, gy, p.z));
            }
            let pos = cs.spot.unwrap();
            let fwd = (fm.pos - pos).normalize().as_vec3();
            let dist = (fm.pos - pos).length();
            (Camera { pos, fwd, up: Vec3::Y, fov_deg: (35.0 - (dist / 120.0).min(25.0)).max(8.0) as f32, near: 0.5 }, true)
        }
    }
}

struct Gpu {
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    renderer: Renderer,
    adapter_name: String,
}

enum Mode {
    Menu,
    Flight,
}

pub struct App {
    opts: Options,
    window: Option<Arc<Window>>,
    gpu: Option<Gpu>,
    db: AirportDb,
    flight: Option<Flight>,
    menu: MenuState,
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
}

impl App {
    pub fn new(opts: Options) -> Self {
        let db = AirportDb::embedded();
        let menu = MenuState { dep: opts.dep.clone(), arr: opts.arr.clone(), field: 0, msg: String::new(), dep_name: String::new(), arr_name: String::new() };
        let mut a = Self {
            opts,
            window: None,
            gpu: None,
            db,
            flight: None,
            menu,
            mode: Mode::Menu,
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
        };
        a.refresh_preview();
        a
    }

    /// Validate the typed airports and build a preview flight (parked on the departure runway).
    fn refresh_preview(&mut self) {
        let name = |db: &AirportDb, c: &str| db.find(c).map(|a| format!("{} - {}", a.icao, a.name)).unwrap_or_default();
        self.menu.dep_name = name(&self.db, &self.menu.dep);
        self.menu.arr_name = name(&self.db, &self.menu.arr);
        self.menu.msg.clear();
        if !self.menu.dep_name.is_empty() && !self.menu.arr_name.is_empty() {
            match Flight::new(&self.db, &self.menu.dep, &self.menu.arr, unix_now()) {
                Ok(f) => self.flight = Some(f),
                Err(e) => self.menu.msg = e,
            }
        }
    }

    fn start_flight(&mut self) {
        self.refresh_preview();
        if self.menu.dep_name.is_empty() || self.menu.arr_name.is_empty() {
            self.menu.msg = "Enter two valid airports".into();
            return;
        }
        if self.flight.is_some() && self.menu.msg.is_empty() {
            self.mode = Mode::Flight;
            self.paused = false;
            self.cam = CamState::default();
            if let Some(f) = self.flight.as_mut() {
                self.cam.yaw = f.fm.heading.to_radians();
                if self.opts.autostart {
                    f.apply(Action::ApAutoTakeoff);
                }
            }
        }
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
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("in-flight"), ..Default::default() })).expect("device");
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

    fn key_pressed(&mut self, el: &ActiveEventLoop, code: KeyCode, text: Option<&str>) {
        match self.mode {
            Mode::Menu => {
                match code {
                    KeyCode::Escape => el.exit(),
                    KeyCode::Enter | KeyCode::NumpadEnter => self.start_flight(),
                    KeyCode::Tab | KeyCode::ArrowDown | KeyCode::ArrowUp => self.menu.field = 1 - self.menu.field,
                    KeyCode::Backspace => {
                        let f = if self.menu.field == 0 { &mut self.menu.dep } else { &mut self.menu.arr };
                        f.pop();
                        self.refresh_preview();
                    }
                    KeyCode::F1 => self.help = !self.help,
                    KeyCode::F2 | KeyCode::F3 | KeyCode::F4 | KeyCode::F5 | KeyCode::F6 | KeyCode::F7 | KeyCode::F8 | KeyCode::F9 => {
                        let p = match code {
                            KeyCode::F2 => ("KSFO", "KOAK"),
                            KeyCode::F3 => ("KLAX", "KSAN"),
                            KeyCode::F4 => ("EGLL", "EGKK"),
                            KeyCode::F5 => ("KJFK", "KEWR"),
                            KeyCode::F6 => ("EDDF", "EDDM"),
                            KeyCode::F7 => ("KSEA", "KPDX"),
                            KeyCode::F8 => ("LFPG", "LFPO"),
                            _ => ("YSSY", "YMML"),
                        };
                        self.menu.dep = p.0.into();
                        self.menu.arr = p.1.into();
                        self.refresh_preview();
                    }
                    _ => {
                        if let Some(t) = text {
                            let f = if self.menu.field == 0 { &mut self.menu.dep } else { &mut self.menu.arr };
                            for ch in t.chars().filter(|c| c.is_ascii_alphanumeric()) {
                                if f.len() < 4 {
                                    f.push(ch.to_ascii_uppercase());
                                }
                            }
                            self.refresh_preview();
                        }
                    }
                }
            }
            Mode::Flight => {
                let status = self.flight.as_ref().map(|f| f.status);
                if matches!(status, Some(Status::Landed | Status::Crashed)) {
                    match code {
                        KeyCode::Enter | KeyCode::NumpadEnter => {
                            self.refresh_preview();
                            self.start_flight();
                        }
                        KeyCode::Escape => el.exit(),
                        _ => {}
                    }
                    return;
                }
                let Some(f) = self.flight.as_mut() else { return };
                match code {
                    KeyCode::Escape => {
                        self.mode = Mode::Menu;
                        self.refresh_preview();
                    }
                    KeyCode::KeyP => self.paused = !self.paused,
                    KeyCode::F1 => self.help = !self.help,
                    KeyCode::F11 => {
                        if let Some(w) = &self.window {
                            w.set_fullscreen(if w.fullscreen().is_some() { None } else { Some(Fullscreen::Borderless(None)) });
                        }
                    }
                    KeyCode::KeyC => {
                        self.view = match self.view {
                            View::Cockpit => View::Chase,
                            View::Chase => View::Tower,
                            View::Tower => View::Cockpit,
                        };
                        self.cam.spot = None;
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
        let tgt = (k(KeyCode::KeyS) - k(KeyCode::KeyW), k(KeyCode::KeyD) - k(KeyCode::KeyA), k(KeyCode::KeyE) - k(KeyCode::KeyQ));
        let mv = |cur: f64, t: f64| {
            let rate = if t == 0.0 { 4.0 } else { 3.0 };
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

        // ---- simulate ----
        let t_sim = Instant::now();
        if let (Mode::Flight, Some(f)) = (&self.mode, self.flight.as_mut()) {
            if !self.paused {
                f.advance(dt, &self.input);
            }
        } else if let Some(f) = self.flight.as_mut() {
            // menu preview: parked aircraft, keep physics settled
            f.advance(dt, &PilotInput::default());
        }
        self.sim_ms += (t_sim.elapsed().as_secs_f32() * 1000.0 - self.sim_ms) * 0.05;

        let Some(gpu) = self.gpu.as_mut() else { return };
        let time = self.start.elapsed().as_secs_f64();
        let orbit = if matches!(self.mode, Mode::Menu) { Some(time) } else { None };
        let (cam, show_ac, params_data) = if let Some(f) = self.flight.as_ref() {
            let (cam, third) = make_camera(f, self.view, &mut self.cam, dt, orbit);
            (Some(cam), third, Some((f.utc(), f.lat, f.lon, f.weather.vis_km as f32, f.weather.cloud_base_m as f32, f.weather.cloud_cover as f32)))
        } else {
            (None, false, None)
        };

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
        let info = HudInfo { fps: self.fps, frame_ms: self.frame_ms, sim_ms: self.sim_ms, view: self.view, paused: self.paused, help: self.help, time };
        let menu = &self.menu;
        let in_menu = matches!(self.mode, Mode::Menu);
        let flight_ref = self.flight.as_ref();
        if let (Some(cam), Some((utc, lat, lon, vis, cb, cc))) = (cam, params_data) {
            let fp = FrameParams { flight: flight_ref, cam, utc, time: time as f32, lat, lon, vis_km: vis, cloud_base: cb, cloud_cover: cc, show_aircraft: show_ac || in_menu };
            let (fps, help) = (self.fps, self.help);
            gpu.renderer.render(&view, &fp, &mut |u| {
                if in_menu {
                    ui::draw_menu(u, menu, time, fps);
                    if help {
                        let b = (u.h / 46.0).clamp(11.0, 26.0);
                        ui::draw_help(u, b);
                    }
                } else if let Some(f) = flight_ref {
                    ui::draw_hud(u, f, &info);
                }
            });
        }
        gpu.renderer.queue.present(frame);

        self.frames += 1;
        if self.last_log.elapsed().as_secs_f32() > 5.0 {
            self.last_log = Instant::now();
            let s = gpu.renderer.stats;
            println!("{:.1} FPS | frame {:.2} ms | sim {:.2} ms | terrain {:.2} ms | scatter {:.2} ms | ui {:.2} ms | draws {} | tris {}k | rss {} MB", self.fps, self.frame_ms, self.sim_ms, s.terrain_ms, s.scatter_ms, s.ui_ms, s.draw_calls, s.triangles / 1000, rss_mb());
        }
        if self.opts.max_frames.is_some_and(|m| self.frames >= m) {
            el.exit();
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
            self.start_flight();
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
            WindowEvent::KeyboardInput { event, .. } => {
                if let PhysicalKey::Code(code) = event.physical_key {
                    match event.state {
                        ElementState::Pressed => {
                            self.keys.insert(code);
                            if !event.repeat {
                                let text = event.text.as_ref().map(|t| t.as_str().to_owned());
                                self.key_pressed(el, code, text.as_deref());
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
                self.cam.dist = clamp(self.cam.dist * (1.0 - y * 0.08), 0.35, 6.0);
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
