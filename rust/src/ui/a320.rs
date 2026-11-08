//! Airbus A320-200 plan view (nose to the right) for the loading screens - port of `src/ui/A320Plan.tsx`.
//!
//! The coordinates are the original three-view's pixel grid (nose left, centre-line y = 570); they are mirrored so the
//! aircraft flies to the right and the lower half is the flipped upper half. `progress` 0..1 paints the airframe from
//! tail to nose over a blueprint outline, like a scan sweeping in the direction of flight.

use super::{Gui, ACCENT};
use crate::gfx::ui::Col;

pub const NOSE_X: f32 = 30.0;
pub const TAIL_X: f32 = 655.0;
pub const CENTRE_Y: f32 = 570.0;
const VB: [f32; 4] = [20.0, 280.0, 650.0, 580.0];
/// aspect ratio (height / width) of the drawing
pub const ASPECT: f32 = VB[3] / VB[2];

type Pts = ([[f32; 2]; 48], usize);

fn push(p: &mut Pts, x: f32, y: f32) {
    if p.1 < 48 {
        p.0[p.1] = [x, y];
        p.1 += 1;
    }
}
fn cubic(p: &mut Pts, a: [f32; 2], c1: [f32; 2], c2: [f32; 2], b: [f32; 2], n: usize) {
    for i in 1..=n {
        let t = i as f32 / n as f32;
        let u = 1.0 - t;
        push(
            p,
            u * u * u * a[0] + 3.0 * u * u * t * c1[0] + 3.0 * u * t * t * c2[0] + t * t * t * b[0],
            u * u * u * a[1] + 3.0 * u * u * t * c1[1] + 3.0 * u * t * t * c2[1] + t * t * t * b[1],
        );
    }
}
fn quad(p: &mut Pts, a: [f32; 2], c: [f32; 2], b: [f32; 2], n: usize) {
    for i in 1..=n {
        let t = i as f32 / n as f32;
        let u = 1.0 - t;
        push(p, u * u * a[0] + 2.0 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2.0 * u * t * c[1] + t * t * b[1]);
    }
}
fn poly(list: &[[f32; 2]]) -> Pts {
    let mut p: Pts = ([[0.0; 2]; 48], 0);
    for q in list {
        push(&mut p, q[0], q[1]);
    }
    p
}

fn fuselage() -> Pts {
    let mut p: Pts = ([[0.0; 2]; 48], 0);
    push(&mut p, 30.0, 570.0);
    cubic(&mut p, [30.0, 570.0], [30.0, 552.0], [56.0, 537.0], [96.0, 537.0], 9);
    push(&mut p, 500.0, 537.0);
    cubic(&mut p, [500.0, 537.0], [560.0, 537.0], [620.0, 556.0], [655.0, 565.0], 9);
    push(&mut p, 655.0, 570.0);
    p
}
fn wing() -> Pts {
    poly(&[[235.0, 537.0], [372.0, 288.0], [402.0, 290.0], [346.0, 462.0], [343.0, 537.0]])
}
fn nacelle() -> Pts {
    let mut p: Pts = ([[0.0; 2]; 48], 0);
    push(&mut p, 223.0, 463.0);
    quad(&mut p, [223.0, 463.0], [217.0, 475.0], [223.0, 488.0], 5);
    push(&mut p, 262.0, 492.0);
    quad(&mut p, [262.0, 492.0], [276.0, 490.0], [277.0, 482.0], 4);
    push(&mut p, 277.0, 468.0);
    quad(&mut p, [277.0, 468.0], [276.0, 460.0], [262.0, 458.0], 4);
    p
}
fn tailplane() -> Pts {
    poly(&[[566.0, 549.0], [611.0, 467.0], [640.0, 467.0], [622.0, 555.0]])
}
fn windscreen() -> Pts {
    let mut p: Pts = ([[0.0; 2]; 48], 0);
    push(&mut p, 52.0, 555.0);
    quad(&mut p, [52.0, 555.0], [68.0, 543.0], [92.0, 541.0], 5);
    push(&mut p, 92.0, 550.0);
    quad(&mut p, [92.0, 550.0], [74.0, 551.0], [62.0, 560.0], 5);
    p
}
fn fin_spine() -> Pts {
    let mut p: Pts = ([[0.0; 2]; 48], 0);
    push(&mut p, 505.0, 570.0);
    cubic(&mut p, [505.0, 570.0], [520.0, 565.0], [600.0, 564.0], [640.0, 566.0], 8);
    push(&mut p, 640.0, 570.0);
    p
}

struct Xf {
    x: f32,
    y: f32,
    k: f32,
}
impl Xf {
    /// drawing -> screen, mirrored (nose to the right), optionally flipped about the centre-line
    fn map(&self, q: [f32; 2], flip: bool) -> [f32; 2] {
        let dx = NOSE_X + TAIL_X - q[0];
        let dy = if flip { CENTRE_Y * 2.0 - q[1] } else { q[1] };
        [self.x + (dx - VB[0]) * self.k, self.y + (dy - VB[1]) * self.k]
    }
}

fn draw_shape(g: &mut Gui, xf: &Xf, shape: &Pts, flip: bool, fill: Option<Col>, stroke: Col, th: f32) {
    let mut buf = [[0.0f32; 2]; 49];
    let n = shape.1;
    for i in 0..n {
        buf[i] = xf.map(shape.0[i], flip);
    }
    if let Some(c) = fill {
        g.polygon(&buf[..n], c);
    }
    buf[n] = buf[0];
    g.polyline(&buf[..n + 1], th, stroke);
}

fn draw_airframe(g: &mut Gui, xf: &Xf, lit: bool, accent: Col) {
    let stroke: Col = if lit { [0.08, 0.13, 0.24, 0.6] } else { [0.59, 0.75, 1.0, 0.72] };
    let th = if lit { 0.9 } else { 1.0 };
    let wing_fill = if lit { Some([0.87, 0.90, 0.93, 1.0]) } else { None };
    let (fus, wng, nac, tp, ws, fin) = (fuselage(), wing(), nacelle(), tailplane(), windscreen(), fin_spine());
    for flip in [false, true] {
        draw_shape(g, xf, &wng, flip, wing_fill, stroke, th);
        draw_shape(g, xf, &nac, flip, if lit { Some([0.93, 0.95, 0.97, 1.0]) } else { None }, stroke, th);
        if lit {
            let a = xf.map([223.0, 465.0], flip);
            let b = xf.map([223.0, 486.0], flip);
            g.line(a, b, 2.4, accent);
        }
        draw_shape(g, xf, &tp, flip, wing_fill, stroke, th);
        draw_shape(g, xf, &fus, flip, if lit { Some([0.93, 0.95, 0.98, 1.0]) } else { None }, stroke, th);
        draw_shape(g, xf, &ws, flip, if lit { Some([0.11, 0.17, 0.27, 1.0]) } else { None }, stroke, th * 0.9);
        // hinge lines (flaps / slats)
        let hinge = [[331.0, 537.0], [334.0, 466.0], [388.0, 293.0]];
        let pts: [[f32; 2]; 3] = [xf.map(hinge[0], flip), xf.map(hinge[1], flip), xf.map(hinge[2], flip)];
        g.polyline(&pts, 0.8, [stroke[0], stroke[1], stroke[2], stroke[3] * 0.7]);
    }
    // fin seen from above
    for flip in [false, true] {
        draw_shape(g, xf, &fin, flip, if lit { Some(accent) } else { None }, if lit { [0.04, 0.12, 0.16, 0.6] } else { stroke }, 1.0);
    }
}

/// Draws the A320 plan inside a box of width `w` at (x, y) (virtual px). Height is `w * ASPECT`.
pub fn draw(g: &mut Gui, x: f32, y: f32, w: f32, progress: f32, accent: Option<Col>) {
    let accent = accent.unwrap_or([0.043, 0.478, 0.62, 1.0]);
    let k = w / VB[2];
    let xf = Xf { x, y, k };
    let p = progress.clamp(0.0, 1.0);
    let h = w * ASPECT;
    // blueprint layer
    draw_airframe(g, &xf, false, accent);
    // painted layer revealed by the sweep (left to right on screen: the tail first)
    if p > 0.0 {
        g.scissor(Some([x - 4.0, y - 4.0, p * w + 4.0, h + 8.0]));
        draw_airframe(g, &xf, true, accent);
        g.scissor(None);
    }
    if p > 0.002 && p < 0.998 {
        let edge = x + p * w;
        g.rect_h(edge - 46.0 * k, y + 2.0 * k, 46.0 * k, h - 4.0 * k, [0.37, 0.64, 1.0, 0.0], [0.55, 0.76, 1.0, 0.55]);
        g.rect(edge - 0.75, y + 2.0 * k, 1.5, h - 4.0 * k, [0.66, 0.82, 1.0, 1.0]);
    }
    let _ = ACCENT;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_fit_the_viewbox_and_are_non_degenerate() {
        for s in [fuselage(), wing(), nacelle(), tailplane(), windscreen(), fin_spine()] {
            assert!(s.1 >= 4);
            for q in &s.0[..s.1] {
                assert!(q[0] >= VB[0] - 1.0 && q[0] <= VB[0] + VB[2] + 1.0, "{q:?}");
                assert!(q[1] >= VB[1] - 1.0 && q[1] <= CENTRE_Y + 1.0, "{q:?}");
            }
        }
    }

    #[test]
    fn mirror_puts_the_nose_on_the_right() {
        let xf = Xf { x: 0.0, y: 0.0, k: 1.0 };
        assert!(xf.map([NOSE_X, CENTRE_Y], false)[0] > xf.map([TAIL_X, CENTRE_Y], false)[0]);
        let (a, b) = (xf.map([300.0, 400.0], false), xf.map([300.0, 400.0], true));
        assert!((a[1] + b[1] - 2.0 * (CENTRE_Y - VB[1])).abs() < 1e-3);
    }
}
