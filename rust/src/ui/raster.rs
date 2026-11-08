//! Tiny CPU rasteriser for the 2D UI batch ([`crate::gfx::ui::Ui`]): replays the exact vertices the GPU would receive
//! (scissor, atlas sampling, alpha blending in linear space, sRGB encode) so the whole pre-flight UI can be screenshotted
//! and pixel-tested on machines without any GPU (CI, this sandbox).

use crate::gfx::ui::{build_atlas, Ui, ATLAS_H, ATLAS_W};

pub struct Raster {
    pub w: usize,
    pub h: usize,
    /// linear RGB, row-major
    pub px: Vec<[f32; 3]>,
    atlas: Vec<u8>,
}

fn srgb(v: f32) -> u8 {
    let v = v.clamp(0.0, 1.0);
    let e = if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
    (e * 255.0 + 0.5) as u8
}

impl Raster {
    pub fn new(w: usize, h: usize) -> Self {
        Self { w, h, px: vec![[0.0; 3]; w * h], atlas: build_atlas() }
    }

    pub fn clear(&mut self) {
        self.px.iter_mut().for_each(|p| *p = [0.0; 3]);
    }

    fn sample(&self, u: f32, v: f32) -> f32 {
        let (fx, fy) = (u * ATLAS_W as f32 - 0.5, v * ATLAS_H as f32 - 0.5);
        let (x0, y0) = (fx.floor(), fy.floor());
        let (tx, ty) = (fx - x0, fy - y0);
        let at = |x: f32, y: f32| self.atlas[(y.clamp(0.0, ATLAS_H as f32 - 1.0) as usize) * ATLAS_W + x.clamp(0.0, ATLAS_W as f32 - 1.0) as usize] as f32 / 255.0;
        let a = at(x0, y0) * (1.0 - tx) + at(x0 + 1.0, y0) * tx;
        let b = at(x0, y0 + 1.0) * (1.0 - tx) + at(x0 + 1.0, y0 + 1.0) * tx;
        a * (1.0 - ty) + b * ty
    }

    /// Draws everything recorded in `ui` (call after `ui.end()`).
    pub fn draw(&mut self, ui: &Ui) {
        for c in &ui.cmds {
            let sc = c.scissor.unwrap_or([0, 0, self.w as u32, self.h as u32]);
            let (sx0, sy0, sx1, sy1) = (sc[0] as i32, sc[1] as i32, (sc[0] + sc[2]).min(self.w as u32) as i32, (sc[1] + sc[3]).min(self.h as u32) as i32);
            let verts = &ui.verts[c.start as usize..(c.start + c.count) as usize];
            for t in verts.chunks_exact(3) {
                let (a, b, cc) = (t[0], t[1], t[2]);
                let min_x = (a.pos[0].min(b.pos[0]).min(cc.pos[0]).floor() as i32).max(sx0);
                let max_x = (a.pos[0].max(b.pos[0]).max(cc.pos[0]).ceil() as i32).min(sx1);
                let min_y = (a.pos[1].min(b.pos[1]).min(cc.pos[1]).floor() as i32).max(sy0);
                let max_y = (a.pos[1].max(b.pos[1]).max(cc.pos[1]).ceil() as i32).min(sy1);
                let area = (b.pos[0] - a.pos[0]) * (cc.pos[1] - a.pos[1]) - (b.pos[1] - a.pos[1]) * (cc.pos[0] - a.pos[0]);
                if area.abs() < 1e-6 {
                    continue;
                }
                let inv = 1.0 / area;
                for y in min_y..max_y {
                    for x in min_x..max_x {
                        let p = [x as f32 + 0.5, y as f32 + 0.5];
                        let w0 = ((b.pos[0] - p[0]) * (cc.pos[1] - p[1]) - (b.pos[1] - p[1]) * (cc.pos[0] - p[0])) * inv;
                        let w1 = ((cc.pos[0] - p[0]) * (a.pos[1] - p[1]) - (cc.pos[1] - p[1]) * (a.pos[0] - p[0])) * inv;
                        let w2 = 1.0 - w0 - w1;
                        if w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4 {
                            continue;
                        }
                        let mut col = [0.0f32; 4];
                        for (k, ck) in col.iter_mut().enumerate() {
                            *ck = a.col[k] * w0 + b.col[k] * w1 + cc.col[k] * w2;
                        }
                        let u = a.uv[0] * w0 + b.uv[0] * w1 + cc.uv[0] * w2;
                        let v = a.uv[1] * w0 + b.uv[1] * w1 + cc.uv[1] * w2;
                        let al = col[3] * self.sample(u, v);
                        let d = &mut self.px[y as usize * self.w + x as usize];
                        for k in 0..3 {
                            d[k] = col[k] * al + d[k] * (1.0 - al);
                        }
                    }
                }
            }
        }
    }

    pub fn rgba8(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.w * self.h * 4);
        for p in &self.px {
            out.extend_from_slice(&[srgb(p[0]), srgb(p[1]), srgb(p[2]), 255]);
        }
        out
    }

    /// Mean linear luminance of a rectangle (tests use it to assert "something was painted here").
    pub fn mean_luma(&self, x: usize, y: usize, w: usize, h: usize) -> f32 {
        let mut s = 0.0;
        for yy in y..(y + h).min(self.h) {
            for xx in x..(x + w).min(self.w) {
                let p = self.px[yy * self.w + xx];
                s += 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
            }
        }
        s / (w * h) as f32
    }

    pub fn pixel(&self, x: usize, y: usize) -> [f32; 3] {
        self.px[y * self.w + x]
    }
}
