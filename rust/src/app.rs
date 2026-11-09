//! Native window front-end (winit 0.30 `ApplicationHandler` + wgpu surface): menu, flight loop, input, camera rigs.

use crate::airports::{AirportDb, AirportLoader};
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
use std::time::{Duration, Instant};
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{DeviceEvent, DeviceId, ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{KeyCode, PhysicalKey};
use winit::window::{CursorGrabMode, Fullscreen, Window, WindowId};

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

pub use crate::camera::CamState;
use crate::camera::{DragKind, Focus, Interior};
use crate::camera_ui::{Bar, BarAction};

/// Camera for `view` (see `camera::CamState::rig`).
pub fn make_camera(f: &Flight, view: View, cs: &mut CamState, dt: f64, orbit: Option<f64>) -> (Camera, bool) {
    cs.rig(f, view, dt, orbit)
}

// ---------------------------------------------------------------- camera control tuning

/// Numpad look speed expressed as an equivalent drag speed (px / s).
const KEY_LOOK_PX_PER_S: f64 = 650.0;
/// Two presses closer than this (s) and without dragging in between recentre the view.
const DOUBLE_CLICK_S: f64 = 0.32;

/// Mouse button that started the current camera drag.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LookBtn {
    Left,
    Right,
    Middle,
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
    /// empty until the route-selection screen (or a flight) asks for it, then parsed on a worker thread
    db: AirportDb,
    loader: Option<AirportLoader>,
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
    /// raw (device) mouse motion accumulated since the last frame: keeps look / orbit alive at the screen edge
    raw_delta: [f32; 2],
    /// active camera drag: which button started it and whether it pans / leans (`DragKind::Pan`) or looks / orbits
    look_btn: Option<(LookBtn, DragKind)>,
    middle_down: bool,
    prev_middle: bool,
    /// time (s, app clock) of the last press that started a look drag + how far the pointer travelled during it (double-click detection)
    click_t: f64,
    click_travel: f64,
    /// camera hot-bar layout of the current frame
    bar: Bar,
    /// cursor is currently confined + hidden for a camera drag
    grabbed: bool,
    /// the cursor was over an interactive deck control at the end of the last frame
    over_ctl: bool,
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
        // the boot screen and the main menu (a bare rotating globe) need no airports: they load with route selection
        let db = AirportDb::empty();
        let mut pre = PreFlight::new(&db);
        pre.planner.dep = opts.dep.clone();
        pre.planner.arr = opts.arr.clone();
        Self {
            opts,
            window: None,
            gpu: None,
            db,
            loader: None,
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
            raw_delta: [0.0, 0.0],
            look_btn: None,
            middle_down: false,
            prev_middle: false,
            click_t: -10.0,
            click_travel: 1e9,
            bar: Bar::default(),
            grabbed: false,
            over_ctl: false,
        }
    }


    /// Queue a launch: the flight-loader scene is shown for a few frames, then the flight is built.
    fn begin_launch(&mut self, launch: Launch) {
        self.require_airports();
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
                self.cam = CamState::for_flight(self.pre.settings.fov);
                self.look_btn = None;
                self.over_ctl = false;
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
    /// Starts / polls the background airport load requested by the UI (route selection). Never blocks the frame.
    fn service_airports(&mut self) {
        if !self.db.is_empty() {
            return;
        }
        if self.pre.airports_requested && self.loader.is_none() {
            self.loader = Some(AirportLoader::spawn());
        }
        if let Some(db) = self.loader.as_ref().and_then(|l| l.poll()) {
            self.db = db;
            self.loader = None;
        }
    }

    /// A flight needs the database right now: wait for the loader (it has usually finished long ago).
    fn require_airports(&mut self) {
        if self.db.is_empty() {
            self.db = self.loader.take().map(AirportLoader::wait).unwrap_or_else(AirportDb::embedded);
        }
    }

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
        self.look_btn = None;
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
        // Several passes (sky, globe tiles, clouds, UI) write non-1.0 alpha. On Windows the first advertised alpha mode can be
        // a pre/post-multiplied one, which composites the window with the desktop (see-through / smeared output). Always
        // prefer an opaque swap-chain.
        let alpha_mode = if caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::Opaque) { wgpu::CompositeAlphaMode::Opaque } else { caps.alpha_modes[0] };
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode,
            alpha_mode,
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
            color_space: wgpu::SurfaceColorSpace::Auto,
        };
        surface.configure(&device, &config);
        let renderer = Renderer::new(device, queue, format, config.width, config.height);
        println!("GPU: {} ({:?}), present mode {:?}, alpha {:?}, format {:?}", info.name, info.backend, present_mode, alpha_mode, format);
        self.gpu = Some(Gpu { surface, config, renderer, adapter_name: info.name });
    }

    /// Keeps the swap-chain, the depth buffer and the UI screen uniform in step with the real window size. `Resized` can be
    /// missed or coalesced on Windows (maximise, DPI change, monitor switch); a stale surface presents a stretched frame.
    fn sync_surface(&mut self) {
        let Some(win) = self.window.as_ref() else { return };
        let s = win.inner_size();
        if s.width == 0 || s.height == 0 {
            return;
        }
        if let Some(g) = self.gpu.as_mut() {
            if g.config.width != s.width || g.config.height != s.height {
                g.config.width = s.width;
                g.config.height = s.height;
                g.surface.configure(&g.renderer.device, &g.config);
                g.renderer.resize(s.width, s.height);
            }
        }
    }

    /// Confines + hides the cursor while a camera drag is active (so the drag never stalls at the window edge).
    fn set_look_grab(&mut self, on: bool) {
        if self.grabbed == on {
            return;
        }
        self.grabbed = on;
        if let Some(w) = &self.window {
            if on {
                let _ = w.set_cursor_grab(CursorGrabMode::Confined).or_else(|_| w.set_cursor_grab(CursorGrabMode::Locked));
                w.set_cursor_visible(false);
            } else {
                let _ = w.set_cursor_grab(CursorGrabMode::None);
                w.set_cursor_visible(true);
            }
        }
    }

    /// Camera input for one frame - runs BEFORE the camera rig is evaluated so the view follows the mouse with no frame lag.
    /// * left drag: look (cockpit / wing / tower) or orbit (chase); right / middle / Shift+left drag: lean (cockpit) or pan (chase)
    ///   (interior: only when the press is not on a flight-deck control or the camera hot-bar)
    /// * releasing a moving drag lets the view coast on with momentum; a double-click on empty space recentres
    /// * numpad 4 6 8 2 look, 5 centre, + / - zoom (the controls advertised in F1)
    fn update_look(&mut self, dt: f64) {
        let raw = std::mem::take(&mut self.raw_delta);
        let right_pressed = self.inp.right_down && !self.prev_right;
        let middle_pressed = self.middle_down && !self.prev_middle;
        if !(matches!(self.mode, Mode::Flight) && self.flight.is_some()) {
            self.look_btn = None;
            self.set_look_grab(false);
            return;
        }
        let view = self.view;
        // ---- keyboard look / zoom ----
        let (nl, nr, nu, nd) = (self.keys.contains(&KeyCode::Numpad4), self.keys.contains(&KeyCode::Numpad6), self.keys.contains(&KeyCode::Numpad8), self.keys.contains(&KeyCode::Numpad2));
        let (kx, ky) = ((nr as i32 - nl as i32) as f64, (nd as i32 - nu as i32) as f64);
        if kx != 0.0 || ky != 0.0 {
            // a held key is a steady drag: no momentum on release, the spring does the smoothing
            self.cam.drag(view, DragKind::Look, kx * KEY_LOOK_PX_PER_S * dt, ky * KEY_LOOK_PX_PER_S * dt, dt);
        }
        if self.keys.contains(&KeyCode::Numpad5) {
            self.cam.reset(view);
        }
        let (zin, zout) = (self.keys.contains(&KeyCode::NumpadAdd), self.keys.contains(&KeyCode::NumpadSubtract));
        if zin || zout {
            self.cam.zoom(view, (zin as i32 - zout as i32) as f64 * 6.0 * dt);
        }

        // ---- mouse drag ----
        let shift = self.keys.contains(&KeyCode::ShiftLeft) || self.keys.contains(&KeyCode::ShiftRight);
        let left_pressed = self.inp.pressed;
        let mut started = false;
        if self.look_btn.is_none() && (left_pressed || right_pressed || middle_pressed) {
            // on the flight deck a press on a control belongs to the control, on the hot-bar to the bar, anywhere else it starts a look
            let blocked = (view.is_interior() && (self.over_ctl || self.host.captured)) || self.bar.contains(self.inp.mouse);
            if !blocked {
                let btn = if left_pressed {
                    LookBtn::Left
                } else if right_pressed {
                    LookBtn::Right
                } else {
                    LookBtn::Middle
                };
                let kind = if btn == LookBtn::Left && !shift { DragKind::Look } else { DragKind::Pan };
                self.look_btn = Some((btn, kind));
                started = true;
                // double-click (two quick presses with almost no movement) recentres the view
                let now = self.start.elapsed().as_secs_f64();
                if btn == LookBtn::Left && now - self.click_t < DOUBLE_CLICK_S && self.click_travel < 6.0 {
                    self.cam.reset(view);
                    self.click_t = -10.0;
                } else {
                    self.click_t = now;
                }
                self.click_travel = 0.0;
            }
        }
        if let Some((btn, kind)) = self.look_btn {
            let held = match btn {
                LookBtn::Left => self.inp.down,
                LookBtn::Right => self.inp.right_down,
                LookBtn::Middle => self.middle_down,
            };
            if !held {
                self.look_btn = None;
                self.cam.release(view);
            } else if !started {
                // raw device motion keeps working when the cursor is pinned at the edge of the window / screen;
                // fall back to the cursor delta where raw input is unavailable (remote desktop, some VMs)
                let d = if raw != [0.0, 0.0] { raw } else { self.inp.delta };
                self.click_travel += (d[0].abs() + d[1].abs()) as f64;
                self.cam.drag(view, kind, d[0] as f64, d[1] as f64, dt);
            }
        }
        let on = self.look_btn.is_some();
        self.set_look_grab(on);
    }

    /// Per-frame camera context + hot-bar + look gestures (everything that must run before the rig is evaluated).
    fn update_camera_input(&mut self, dt: f64) {
        let in_flight = matches!(self.mode, Mode::Flight) && self.flight.is_some();
        if let Some(g) = &self.gpu {
            let (w, h) = (g.config.width as f32, g.config.height.max(1) as f32);
            self.cam.aspect = w / h;
            self.cam.vp_h = h;
            self.bar = if in_flight {
                Bar::layout(w, h, self.view, self.cam.cockpit.focus, self.cam.cockpit.custom.is_some(), self.cam.interior, self.cam.last_external)
            } else {
                Bar::default()
            };
        }
        self.cam.interior = if self.host.ready() { Interior::Hd } else { Interior::Procedural };
        if !in_flight {
            self.update_look(dt);
            return;
        }
        // dip-to-black between cockpit and external: the view swaps at the darkest point
        self.view = self.cam.advance_view(self.view, dt);
        // a click on the hot-bar
        if self.inp.pressed && self.look_btn.is_none() {
            if let Some(a) = self.bar.hit(self.inp.mouse) {
                self.camera_action(a);
            }
        }
        self.update_look(dt);
    }

    /// Hot-bar / shortcut action: switch view or panel through the dip-to-black logic.
    fn camera_action(&mut self, a: BarAction) {
        match a {
            BarAction::Focus(f) => {
                if !self.view.is_interior() {
                    self.view = self.cam.request_view(self.view, View::Cockpit);
                }
                self.cam.focus(f);
            }
            BarAction::View(v) => self.view = self.cam.request_view(self.view, v),
            BarAction::Toggle => self.view = self.cam.toggle_perspective(self.view),
        }
        self.look_btn = None;
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

                    KeyCode::KeyC => self.camera_action(BarAction::Toggle),
                    KeyCode::KeyY => {
                        // next external view (from the cockpit: go outside first)
                        let next = if self.view.is_interior() { self.cam.last_external } else { self.view.next_external() };
                        self.camera_action(BarAction::View(next));
                    }
                    KeyCode::Home => {
                        let v = self.view;
                        self.cam.reset(v);
                        if v.is_interior() {
                            self.cam.focus(Focus::Seat);
                        }
                    }
                    KeyCode::Comma | KeyCode::Period => {
                        if self.view.is_interior() {
                            self.cam.focus_step(if code == KeyCode::Period { 1 } else { -1 });
                        }
                    }
                    KeyCode::Digit0 | KeyCode::Digit1 | KeyCode::Digit2 | KeyCode::Digit3 | KeyCode::Digit4 | KeyCode::Digit5 | KeyCode::Digit6 | KeyCode::Digit7 | KeyCode::Digit8 | KeyCode::Digit9 => {
                        let d = match code {
                            KeyCode::Digit0 => 0,
                            KeyCode::Digit1 => 1,
                            KeyCode::Digit2 => 2,
                            KeyCode::Digit3 => 3,
                            KeyCode::Digit4 => 4,
                            KeyCode::Digit5 => 5,
                            KeyCode::Digit6 => 6,
                            KeyCode::Digit7 => 7,
                            KeyCode::Digit8 => 8,
                            _ => 9,
                        };
                        if let Some(foc) = Focus::from_digit(d) {
                            self.camera_action(BarAction::Focus(foc));
                        }
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
        // minimised (0x0 client area): nothing to draw, and do not spin the CPU at 100 %
        if let Some(w) = &self.window {
            let s = w.inner_size();
            if s.width == 0 || s.height == 0 {
                self.last = Instant::now();
                self.inp.end_frame();
                std::thread::sleep(Duration::from_millis(16));
                return;
            }
        }
        self.sync_surface();

        let now = Instant::now();
        let dt = (now - self.last).as_secs_f64().min(0.25);
        self.last = now;
        self.frame_ms += (dt as f32 * 1000.0 - self.frame_ms) * 0.05;
        self.fps = 1000.0 / self.frame_ms.max(0.01);
        self.update_input(dt);
        self.service_addons();
        self.service_airports();
        self.update_camera_input(dt);

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

        // ---- interactive flight deck: cursor picking, press / drag / wheel (look gestures: see `update_look`) ----
        let interior = in_flight && self.view.is_interior();
        let cam_copy = Camera { pos: cam.pos, fwd: cam.fwd, up: cam.up, fov_deg: cam.fov_deg, near: cam.near };
        let deck_active = interior && self.host.ready();
        if let (true, Some(f)) = (interior, self.flight.as_mut()) {
            let right_pressed = self.inp.right_down && !self.prev_right;
            let shift = self.keys.contains(&KeyCode::ShiftLeft) || self.keys.contains(&KeyCode::ShiftRight);
            let alt = self.keys.contains(&KeyCode::AltLeft) || self.keys.contains(&KeyCode::AltRight);
            let size = (gpu.config.width as f32, gpu.config.height as f32);
            // the hot-bar sits on top of the deck: nothing behind it may react (unless a control is already being dragged)
            let on_bar = self.bar.contains(self.inp.mouse) && !self.host.captured;
            if on_bar {
                self.host.hover = None;
                self.over_ctl = false;
            } else {
                let mut left_pressed = self.inp.pressed;
                // Alt + click frames the control under the cursor (never operates it)
                if alt && left_pressed {
                    if let Some((eye, at, fov)) = self.host.focus_at(f, &cam_copy, self.inp.mouse, size) {
                        self.cam.focus_point(eye, at, fov);
                        left_pressed = false;
                    }
                }
                let over = self.host.mouse(f, &cam_copy, self.inp.mouse, size, left_pressed, self.inp.down, right_pressed, self.inp.delta, shift);
                self.over_ctl = over;
            }
            if self.look_btn.is_some() {
                // no tooltip while the head is turning
                self.host.hover = None;
            }
            // wheel left over by the deck (nothing under the cursor to turn) zooms the view
            if self.host.wheel != 0.0 {
                self.cam.zoom(View::Cockpit, self.host.wheel as f64);
                self.host.wheel = 0.0;
            }
            if self.host.ready() {
                gpu.renderer.set_deck_slots(&self.host.slots);
            }
        } else {
            self.host.hover = None;
            self.host.captured = false;
            self.host.wheel = 0.0;
            self.over_ctl = false;
        }
        self.prev_right = self.inp.right_down;
        self.prev_middle = self.middle_down;

        // ---- acquire frame ----
        let mut reconfigure = false;
        let frame = match gpu.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) => t,
            // still presentable, but the surface no longer matches the window: reconfigure after presenting
            wgpu::CurrentSurfaceTexture::Suboptimal(t) => {
                reconfigure = true;
                t
            }
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                gpu.surface.configure(&gpu.renderer.device, &gpu.config);
                // a skipped frame must not leave a huge pointer delta / wheel burst for the next one
                self.inp.delta = [0.0, 0.0];
                self.inp.wheel = 0.0;
                return;
            }
            _ => {
                self.inp.delta = [0.0, 0.0];
                self.inp.wheel = 0.0;
                return;
            }
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let info = HudInfo { fps: self.fps, frame_ms: self.frame_ms, sim_ms: self.sim_ms, view: self.view, cam_label: self.cam.label(self.view), paused: self.paused, help: self.help, time, panels3d: in_flight && self.view.is_interior() };
        let flight_ref = if in_flight { self.flight.as_ref() } else { None };
        let fp = FrameParams { flight: flight_ref, cam, utc, time: time as f32, lat, lon, vis_km: vis, cloud_base: cb, cloud_cover: cc, show_aircraft: show_ac, cockpit: in_flight && self.view.is_interior() };
        let fps = self.fps;
        let help = self.help;
        let wall_utc = unix_now();
        let host_ref = &self.host;
        let mouse = self.inp.mouse;
        let bar = self.bar;
        let fade = self.cam.fade();
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
                        bar.draw(u, mouse);
                        if help {
                            let b = (u.h / 46.0).clamp(11.0, 26.0);
                            ui::draw_help(u, b);
                        }
                        if fade > 0.002 {
                            u.rect(0.0, 0.0, u.w, u.h, [0.0, 0.0, 0.0, fade]);
                        }
                    }
                }
            });
        }
        gpu.renderer.queue.present(frame);
        if reconfigure {
            gpu.surface.configure(&gpu.renderer.device, &gpu.config);
        }
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

    /// Raw mouse motion (not clipped by the window / screen edge, no pointer acceleration): drives camera drags.
    fn device_event(&mut self, _el: &ActiveEventLoop, _id: DeviceId, event: DeviceEvent) {
        if let DeviceEvent::MouseMotion { delta } = event {
            self.raw_delta[0] += delta.0 as f32;
            self.raw_delta[1] += delta.1 as f32;
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
            // focus lost (alt-tab, window switch): the matching key / button release events never arrive, which left
            // keys, mouse buttons and a camera drag "stuck" after coming back
            WindowEvent::Focused(false) => {
                self.keys.clear();
                self.inp.down = false;
                self.inp.pressed = false;
                self.inp.released = false;
                self.inp.right_down = false;
                self.prev_right = false;
                self.middle_down = false;
                self.prev_middle = false;
                self.last_mouse = None;
                self.look_btn = None;
                self.raw_delta = [0.0, 0.0];
                self.set_look_grab(false);
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
                (MouseButton::Middle, s) => self.middle_down = s == ElementState::Pressed,
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
                                }
                                if let Some(t) = event.text.as_ref() {
                                    let ctrl = self.keys.contains(&KeyCode::ControlLeft) || self.keys.contains(&KeyCode::ControlRight);
                                    if !ctrl {
                                        // Enter / Tab / Esc / Backspace also carry a control character in `text`;
                                        // those are handled as keys and must not end up in the text fields (drawn as '?')
                                        for ch in t.chars().filter(|c| !c.is_control()) {
                                            self.inp.typed.push(ch);
                                        }
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
                    let ctrl = self.keys.contains(&KeyCode::ControlLeft) || self.keys.contains(&KeyCode::ControlRight);
                    if self.view.is_interior() && !ctrl {
                        // first offered to the control under the cursor (knobs / levers); the rest zooms the head view
                        self.host.wheel += y as f32;
                    } else {
                        // Ctrl + wheel always zooms, even over a knob
                        self.cam.zoom(self.view, y);
                    }
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
