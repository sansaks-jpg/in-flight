//! Glue between the app and the interactive flight deck (`deck.rs`) - everything that is NOT GPU work:
//! background parsing of the downloaded GLB (50 MB, a second or two - never on the render thread), the systems board, cursor -> body
//! ray, hover tooltip + FCU read-out overlay.

use crate::a320sys::A320Systems;
use crate::deck::{self, Deck, GpuMesh, Hit, Hover, Slot};
use crate::game::Flight;
use crate::glb::{self, Image};
use crate::gfx::ui::Ui;
use crate::gfx::{proj_infinite_reverse, view_matrix, Camera};
use glam::{DQuat, Mat4, Vec3, Vec4};
use std::sync::mpsc::{channel, Receiver, TryRecvError};

/// Largest texture side kept on the GPU (the model ships a few 4k atlases).
pub const MAX_TEX: u32 = 2048;

pub struct Loaded {
    pub deck: Deck,
    pub mesh: GpuMesh,
    pub images: Vec<Option<Image>>,
}

/// Parse + classify + bake on the calling thread (also used by tests).
pub fn build(bytes: &[u8], manifest: Option<&[u8]>, eye: [f64; 3]) -> Result<Loaded, String> {
    let g = glb::parse(bytes)?;
    let images: Vec<Option<Image>> = g.images.iter().map(|(_, b)| glb::decode_image(b, MAX_TEX).ok()).collect();
    let deck = Deck::new(g, manifest, eye);
    let mesh = deck.gpu_mesh();
    Ok(Loaded { deck, mesh, images })
}

#[derive(Default)]
pub struct DeckHost {
    pub sys: A320Systems,
    pub deck: Option<Deck>,
    rx: Option<Receiver<Result<Loaded, String>>>,
    pub status: String,
    pub hover: Option<(Hit, Hover)>,
    pub slots: Vec<Slot>,
    /// a control is being held with the mouse (suppresses free-look)
    pub captured: bool,
    pub wheel: f32,
    pub last_toast: Option<(String, f64)>,
    /// the last load attempt failed (do not retry every frame; reset when the Marketplace downloads again)
    pub failed: bool,
}

impl DeckHost {
    pub fn loading(&self) -> bool {
        self.rx.is_some()
    }

    pub fn ready(&self) -> bool {
        self.deck.is_some()
    }

    /// Parse the model on a worker thread; poll with [`DeckHost::poll`].
    pub fn start_load(&mut self, bytes: Vec<u8>, manifest: Option<Vec<u8>>, eye: [f64; 3]) {
        if self.rx.is_some() {
            return;
        }
        let (tx, rx) = channel();
        self.rx = Some(rx);
        self.status = "Loading HD flight deck...".into();
        std::thread::spawn(move || {
            let _ = tx.send(build(&bytes, manifest.as_deref(), eye));
        });
    }

    /// Returns the GPU payload once the worker is done (call every frame).
    pub fn poll(&mut self) -> Option<(GpuMesh, Vec<Option<Image>>)> {
        let rx = self.rx.as_ref()?;
        match rx.try_recv() {
            Ok(Ok(l)) => {
                self.rx = None;
                self.status = format!("HD flight deck ready: {} controls", l.deck.groups.len());
                self.deck = Some(l.deck);
                Some((l.mesh, l.images))
            }
            Ok(Err(e)) => {
                self.rx = None;
                self.failed = true;
                self.status = format!("HD flight deck failed to load: {e} (procedural cockpit in use)");
                None
            }
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => {
                self.rx = None;
                None
            }
        }
    }

    pub fn unload(&mut self) {
        self.deck = None;
        self.hover = None;
        self.captured = false;
        self.slots.clear();
    }

    /// New flight: systems back to a cold-start state that matches the flight model.
    pub fn reset_for_flight(&mut self, f: &Flight) {
        self.sys = A320Systems::default();
        self.sys.sync_from_flight(&f.fm);
        self.hover = None;
        self.captured = false;
    }

    /// Per-frame: systems, control poses, GPU slot data.
    pub fn update(&mut self, dt: f64, f: &mut Flight) {
        self.sys.update(dt, &mut f.fm);
        if let Some(t) = self.sys.toast.take() {
            self.last_toast = Some((t, 3.0));
        }
        if let Some((_, ttl)) = self.last_toast.as_mut() {
            *ttl -= dt;
            if *ttl <= 0.0 {
                self.last_toast = None;
            }
        }
        if let Some(d) = self.deck.as_mut() {
            d.update(dt as f32, f, &self.sys);
            d.slots(&self.sys, f, &mut self.slots);
        }
    }

    /// Mouse interaction for one frame. `mouse` / `size` in physical pixels. Returns true when the cursor is over a control.
    #[allow(clippy::too_many_arguments)]
    pub fn mouse(&mut self, f: &mut Flight, cam: &Camera, mouse: [f32; 2], size: (f32, f32), left_pressed: bool, left_down: bool, right_pressed: bool, delta: [f32; 2], shift: bool) -> bool {
        let Some(deck) = self.deck.as_mut() else { return false };
        let (o, d) = body_ray(f, cam, mouse, size);
        let hit = deck.pick(o, d);
        self.hover = hit.as_ref().map(|h| (h.clone(), deck.hover_info(h, &self.sys, f)));
        if left_pressed || right_pressed {
            if let Some(h) = &hit {
                if deck.press(h, if right_pressed { 2 } else { 0 }, shift, f, &mut self.sys).is_some() {
                    self.captured = true;
                }
            }
        }
        if self.captured {
            if left_down {
                deck.drag(delta[0], delta[1], f, &mut self.sys);
            } else if !left_pressed && !right_pressed {
                deck.release(f);
                self.captured = false;
            }
        }
        if self.wheel != 0.0 {
            if let Some(h) = &hit {
                if deck.wheel(h, self.wheel, shift, f, &mut self.sys) {
                    self.wheel = 0.0;
                }
            }
        }
        hit.is_some()
    }

    /// Hover tooltip + FCU read-outs (screen-space overlay on top of the 3D deck).
    pub fn draw_overlay(&self, ui: &mut Ui, f: &Flight, cam: &Camera, mouse: [f32; 2]) {
        let (w, h) = (ui.w, ui.h);
        if let Some(deck) = &self.deck {
            // FCU windows: digits anchored to the real window meshes of the glareshield
            let Some(q) = Some(f.fm.quat) else { return };
            let vp = view_proj(cam, w / h);
            for (node, text) in deck::fcu_readouts(f, &self.sys) {
                if let Some((c, size)) = deck.node_body_box(node) {
                    let world = f.fm.pos + q * glam::DVec3::new(c.x as f64, c.y as f64, c.z as f64);
                    let rel = (world - cam.pos).as_vec3();
                    let clip = vp * Vec4::new(rel.x, rel.y, rel.z, 1.0);
                    if clip.w <= 0.0 {
                        continue;
                    }
                    let (sx, sy) = ((clip.x / clip.w * 0.5 + 0.5) * w, (0.5 - clip.y / clip.w * 0.5) * h);
                    // pixel height of the window ~ model height projected
                    let px = (size.y.max(size.z).max(0.012) / clip.w * 0.5 * h / (cam.fov_deg.to_radians() * 0.5).tan()).clamp(5.0, 60.0);
                    if px > 7.0 && sx > 0.0 && sx < w && sy > 0.0 && sy < h && self.sys.bright.fcu > 0.1 {
                        let tw = Ui::text_width(px, text.chars().count());
                        ui.text(sx - tw * 0.5, sy - px * 0.5, px, [1.0, 0.70, 0.12, 0.95], &text);
                    }
                }
            }
        }
        if let Some((_, hv)) = &self.hover {
            let size = (h / 52.0).clamp(11.0, 19.0);
            let lines = [hv.label.as_str(), hv.value.as_str(), hv.hint.as_str()];
            let tw = lines.iter().map(|l| Ui::text_width(size, l.chars().count())).fold(0.0f32, f32::max) + 20.0;
            let th = size * 3.9 + 12.0;
            let (x, y) = ((mouse[0] + 18.0).min(w - tw - 6.0), (mouse[1] + 22.0).min(h - th - 6.0));
            ui.rect(x, y, tw, th, [0.02, 0.04, 0.07, 0.88]);
            ui.frame(x, y, tw, th, 1.0, [0.24, 0.72, 1.0, 0.8]);
            ui.text(x + 10.0, y + 6.0, size, [0.93, 0.96, 1.0, 1.0], lines[0]);
            if !lines[1].is_empty() {
                ui.text(x + 10.0, y + 6.0 + size * 1.3, size, [0.30, 0.92, 0.55, 1.0], lines[1]);
            }
            ui.text(x + 10.0, y + 6.0 + size * 2.6, size * 0.85, [0.60, 0.67, 0.76, 1.0], lines[2]);
        }
        if let Some((t, _)) = &self.last_toast {
            let size = (h / 46.0).clamp(12.0, 20.0);
            let tw = Ui::text_width(size, t.chars().count()) + 28.0;
            ui.rect(w * 0.5 - tw * 0.5, h * 0.1, tw, size * 2.2, [0.02, 0.05, 0.09, 0.9]);
            ui.text(w * 0.5 - tw * 0.5 + 14.0, h * 0.1 + size * 0.55, size, [0.93, 0.96, 1.0, 1.0], t);
        }
    }
}

fn view_proj(cam: &Camera, aspect: f32) -> Mat4 {
    proj_infinite_reverse(cam.fov_deg.to_radians(), aspect, cam.near) * view_matrix(cam.fwd, cam.up)
}

/// Cursor -> ray in the aircraft body frame (origin, unit direction).
pub fn body_ray(f: &Flight, cam: &Camera, mouse: [f32; 2], size: (f32, f32)) -> (Vec3, Vec3) {
    let aspect = size.0 / size.1.max(1.0);
    let t = (cam.fov_deg.to_radians() * 0.5).tan();
    let (nx, ny) = (mouse[0] / size.0.max(1.0) * 2.0 - 1.0, 1.0 - mouse[1] / size.1.max(1.0) * 2.0);
    let right = cam.fwd.cross(cam.up).normalize();
    let up = right.cross(cam.fwd);
    let dir_w = (cam.fwd + right * nx * t * aspect + up * ny * t).normalize();
    let q: DQuat = f.fm.quat.inverse();
    let o_b = q * (cam.pos - f.fm.pos);
    let d_b = q * glam::DVec3::new(dir_w.x as f64, dir_w.y as f64, dir_w.z as f64);
    (Vec3::new(o_b.x as f32, o_b.y as f32, o_b.z as f32), Vec3::new(d_b.x as f32, d_b.y as f32, d_b.z as f32).normalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::airports::AirportDb;

    #[test]
    fn cursor_centre_ray_follows_camera() {
        let f = Flight::new(&AirportDb::embedded(), "KSFO", "KOAK", 1_718_884_800.0).unwrap();
        let q = f.fm.quat;
        let eye = crate::cockpit::eye_body(&f.fm);
        let cam = Camera { pos: f.fm.pos + q * eye, fwd: (q * glam::DVec3::NEG_Z).as_vec3(), up: (q * glam::DVec3::Y).as_vec3(), fov_deg: 60.0, near: 0.05 };
        let (o, d) = body_ray(&f, &cam, [640.0, 360.0], (1280.0, 720.0));
        assert!((o - Vec3::new(eye.x as f32, eye.y as f32, eye.z as f32)).length() < 1e-3, "origin is the eye in body coordinates: {o:?}");
        assert!((d - Vec3::NEG_Z).length() < 1e-3, "centre of screen looks forward: {d:?}");
        let (_, dr) = body_ray(&f, &cam, [1280.0, 360.0], (1280.0, 720.0));
        assert!(dr.x > 0.4 && dr.z < 0.0, "right edge looks to the right: {dr:?}");
        let (_, du) = body_ray(&f, &cam, [640.0, 0.0], (1280.0, 720.0));
        assert!(du.y > 0.3, "top edge looks up: {du:?}");
    }

    #[test]
    fn async_loader_reports_failure_for_garbage() {
        let mut h = DeckHost::default();
        h.start_load(b"not a glb".to_vec(), None, [0.0; 3]);
        assert!(h.loading());
        let mut got = false;
        for _ in 0..200 {
            if !h.loading() {
                got = true;
                break;
            }
            let _ = h.poll();
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(got && !h.ready());
        assert!(h.status.contains("failed"), "{}", h.status);
    }

    #[test]
    fn real_model_loads_in_background_if_installed() {
        let Some((bytes, man)) = crate::addons::AddonManager::new().read_installed() else { return };
        let mut h = DeckHost::default();
        h.start_load(bytes, man, crate::specs::A320.eye);
        let mut payload = None;
        for _ in 0..3000 {
            payload = h.poll();
            if payload.is_some() || !h.loading() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let (mesh, images) = payload.expect("model loaded");
        assert!(h.ready() && mesh.draws.len() > 20 && images.iter().filter(|i| i.is_some()).count() >= 19, "{}", h.status);
    }
}
