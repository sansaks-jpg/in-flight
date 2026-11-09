//! Glue between the app and the interactive flight deck (`deck.rs`) - everything that is NOT GPU work:
//! background parsing of the downloaded GLB (50 MB, a second or two - never on the render thread), the systems board, cursor -> body
//! ray, hover tooltip + FCU read-out overlay.

use crate::a320sys::A320Systems;
use crate::cockpit::PanelV;
use crate::deck::{self, Deck, GpuMesh, Hit, Hover, Slot};
use crate::fcu;
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
    /// atlas cell currently baked into the GPU display quads, per screen (ND XFR re-routes them)
    cells_applied: Vec<usize>,
    cells_tmp: Vec<usize>,
    pending_screens: Option<Vec<PanelV>>,
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
                // the freshly baked quads use each screen's default cell
                self.cells_applied = l.deck.screens.iter().map(|s| s.cell).collect();
                self.pending_screens = None;
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
        self.sys.follow_qnh(f.weather.qnh);
        self.sys.update_ecam(dt, f);
        // FCU bookkeeping (pre-selection time-outs, AP channels, V/S + LOC capture, selected / managed mirror)
        crate::fcu::sync(dt, f, &mut self.sys);
        if let Some(t) = self.sys.toast.take() {
            self.last_toast = Some((t, 3.0));
        }
        if let Some((_, ttl)) = self.last_toast.as_mut() {
            *ttl -= dt;
            if *ttl <= 0.0 {
                self.last_toast = None;
            }
        }
        // pedestal units: MCDU CRTs (powered from the DC buses) and the ECAM control panel
        let powered = self.sys.dc;
        for m in self.sys.mcdu.iter_mut() {
            m.update(dt as f32, powered, f);
        }
        if let Some(d) = &self.deck {
            self.sys.ecp.set_all_held(d.ecp_hold);
        }
        self.sys.ecp.update(dt as f32);
        if let Some(d) = self.deck.as_mut() {
            d.update(dt as f32, f, &self.sys);
            d.slots(&self.sys, f, &mut self.slots);
            // ND XFR: re-aim the display quads when the routing changed
            d.screen_cells(&self.sys, &mut self.cells_tmp);
            if self.cells_tmp != self.cells_applied {
                self.pending_screens = Some(d.screen_vertices(&self.cells_tmp));
                std::mem::swap(&mut self.cells_applied, &mut self.cells_tmp);
            }
        }
    }

    /// New display-quad vertices to upload to the GPU (only after the screen routing changed).
    pub fn take_screen_update(&mut self) -> Option<Vec<PanelV>> {
        self.pending_screens.take()
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
                deck.release(f, &mut self.sys);
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

    /// Alt + click: eye / look-at / fov (body metres, degrees) that frames the control under the cursor square-on
    /// (`focusGroup` in `cockpit.ts`: distance 4.5x the control's size, 0.26 .. 0.62 m, 38 deg). `None` when nothing is under the cursor.
    pub fn focus_at(&self, f: &Flight, cam: &Camera, mouse: [f32; 2], size: (f32, f32)) -> Option<(glam::DVec3, glam::DVec3, f64)> {
        let deck = self.deck.as_ref()?;
        let (o, d) = body_ray(f, cam, mouse, size);
        let hit = deck.pick(o, d)?;
        let g = &deck.groups[hit.group];
        let c = (g.bmin + g.bmax) * 0.5;
        let extent = (g.bmax - g.bmin).max_element();
        let eye = c + crate::camera::panel_normal(c) * (extent * 4.5).clamp(0.26, 0.62);
        let (eye_b, at_b) = (deck.to_body.transform_point3(eye), deck.to_body.transform_point3(c));
        Some((eye_b.as_dvec3(), at_b.as_dvec3(), 38.0))
    }

    /// Hover tooltip + FCU read-outs (screen-space overlay on top of the 3D deck).
    pub fn draw_overlay(&self, ui: &mut Ui, f: &Flight, cam: &Camera, mouse: [f32; 2]) {
        let (w, h) = (ui.w, ui.h);
        if let Some(deck) = &self.deck {
            let vp = view_proj(cam, w / h);
            let q = f.fm.quat;
            // model-space point -> (screen x, screen y, pixels per metre at that depth); None when behind the camera
            let project = |p: Vec3| -> Option<(f32, f32, f32)> {
                let b = deck.to_body.transform_point3(p);
                let world = f.fm.pos + q * glam::DVec3::new(b.x as f64, b.y as f64, b.z as f64);
                let rel = (world - cam.pos).as_vec3();
                let clip = vp * Vec4::new(rel.x, rel.y, rel.z, 1.0);
                if clip.w <= 0.0 {
                    return None;
                }
                let ppm = 0.5 * h / (cam.fov_deg.to_radians() * 0.5).tan() / clip.w;
                Some(((clip.x / clip.w * 0.5 + 0.5) * w, (0.5 - clip.y / clip.w * 0.5) * h, ppm))
            };
            let on_screen = |sx: f32, sy: f32| sx > 0.0 && sx < w && sy > 0.0 && sy < h;
            let fcu = fcu::display(f, &self.sys);
            if fcu.on && fcu.brightness > 0.05 {
                // the four FCU windows: digits sit on the glareshield strip exactly where the model's seven-segment windows are
                let alpha = 0.4 + 0.6 * fcu.brightness;
                let texts = [fcu.spd.as_str(), fcu.hdg.as_str(), fcu.alt.as_str(), fcu.vs.as_str()];
                for (k, text) in texts.iter().enumerate() {
                    let c = deck::FCU_PLANE_ORIGIN + deck::FCU_NORMAL.normalize() * 0.0012 + Vec3::new(0.0, 0.0, deck::FCU_WINDOW_Z[k]);
                    if let Some((sx, sy, ppm)) = project(c) {
                        let px = (deck::FCU_DIGIT_H / 0.73 * ppm).clamp(5.0, 90.0);
                        if px > 7.0 && on_screen(sx, sy) {
                            let tw = Ui::text_width(px, text.chars().count());
                            ui.text(sx - tw * 0.5, sy - px * 0.5, px, [1.0, 0.70, 0.24, alpha], text);
                        }
                    }
                }
            }
            // EFIS BARO windows (blank in the model): QNH in hPa / inHg, or "Std"
            if self.sys.dc {
                for (side, (c, size)) in deck::BARO_WINDOW.iter().enumerate() {
                    let e = &self.sys.efis[side];
                    let text = if e.std {
                        "Std".to_string()
                    } else if e.unit_in_hg {
                        format!("{:.2}", e.in_hg as f64 / 100.0)
                    } else {
                        format!("{:4}", e.hpa)
                    };
                    if let Some((sx, sy, ppm)) = project(*c) {
                        let px = (size[1] * 0.62 / 0.73 * ppm).clamp(5.0, 70.0);
                        if px > 7.0 && on_screen(sx, sy) {
                            let tw = Ui::text_width(px, text.chars().count());
                            ui.text(sx - tw * 0.5, sy - px * 0.35, px, [0.81, 0.91, 1.0, 0.95], &text);
                        }
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
