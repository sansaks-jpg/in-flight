//! Camera hot-bar: clickable view / panel shortcuts along the bottom edge of the flight screen (the `COCKPIT_FOCUS` hot-bar of the
//! web version). In the cockpit it lists the panel presets (SEAT, FCU, PFD, ND, ECAM, ...), outside it lists the external views.
//! Layout, hit-testing and drawing share one [`Bar`] so what you see is exactly what you can click. No allocation: fixed array.

use crate::camera::{Focus, Interior};
use crate::gfx::ui::{Ui, View, C_CYAN, C_GREY, C_WHITE};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BarAction {
    /// fly the cockpit camera to a panel preset
    Focus(Focus),
    /// jump to an external view
    View(View),
    /// switch between the two main perspectives (cockpit <-> external)
    Toggle,
}

#[derive(Clone, Copy, Debug)]
pub struct Btn {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub action: BarAction,
    pub label: &'static str,
    pub active: bool,
}

const EMPTY: Btn = Btn { x: 0.0, y: 0.0, w: 0.0, h: 0.0, action: BarAction::Toggle, label: "", active: false };
pub const MAX_BTNS: usize = 16;

#[derive(Clone, Copy, Debug)]
pub struct Bar {
    pub items: [Btn; MAX_BTNS],
    pub n: usize,
    pub hint: &'static str,
    /// bounding box of the button strip (x, y, w, h)
    pub bounds: [f32; 4],
    pub text: f32,
}

impl Default for Bar {
    fn default() -> Self {
        Self { items: [EMPTY; MAX_BTNS], n: 0, hint: "", bounds: [0.0; 4], text: 12.0 }
    }
}

const HINT_COCKPIT: &str = "drag look  |  Shift / middle-drag lean  |  wheel zoom  |  Alt+click control: focus  |  0-9 panels  |  Home reset";
const HINT_EXTERNAL: &str = "drag orbit  |  right / middle-drag pan  |  wheel zoom  |  double-click or Home: recentre  |  Y next view";

impl Bar {
    /// Lay the bar out for a `w` x `h` px screen.
    pub fn layout(w: f32, h: f32, view: View, focus: Focus, custom: bool, interior: Interior, last_external: View) -> Bar {
        let mut b = Bar::default();
        let mut labels: [(&'static str, BarAction, bool); MAX_BTNS] = [("", BarAction::Toggle, false); MAX_BTNS];
        let mut n = 0;
        let mut push = |l: &'static str, a: BarAction, act: bool, n: &mut usize| {
            if *n < MAX_BTNS {
                labels[*n] = (l, a, act);
                *n += 1;
            }
        };
        if view.is_interior() {
            push("EXT", BarAction::Toggle, false, &mut n);
            for f in Focus::ALL {
                if f.available(interior) {
                    push(f.label(), BarAction::Focus(f), !custom && f == focus, &mut n);
                }
            }
            b.hint = HINT_COCKPIT;
        } else {
            for v in View::EXTERNAL {
                push(v.label(), BarAction::View(v), v == view, &mut n);
            }
            push("COCKPIT", BarAction::Toggle, false, &mut n);
            b.hint = HINT_EXTERNAL;
            let _ = last_external;
        }
        // size: shrink the text until the strip fits in 70 % of the width
        let mut size = (h / 52.0).clamp(10.0, 20.0);
        let gap = 4.0;
        let strip = |size: f32| -> f32 { (0..n).map(|i| Ui::text_width(size, labels[i].0.chars().count()) + size * 1.5 + gap).sum::<f32>() - gap };
        while strip(size) > w * 0.7 && size > 8.0 {
            size -= 0.5;
        }
        let bh = size * 2.1;
        let total = strip(size);
        let y = h - bh - size * 1.1;
        let mut x = (w - total) * 0.5;
        for i in 0..n {
            let bw = Ui::text_width(size, labels[i].0.chars().count()) + size * 1.5;
            b.items[i] = Btn { x, y, w: bw, h: bh, action: labels[i].1, label: labels[i].0, active: labels[i].2 };
            x += bw + gap;
        }
        b.n = n;
        b.text = size;
        b.bounds = [(w - total) * 0.5 - 6.0, y - 6.0, total + 12.0, bh + 12.0];
        b
    }

    /// The pointer is over the strip (a press there must not start a look drag or operate a control behind it).
    pub fn contains(&self, p: [f32; 2]) -> bool {
        self.n > 0 && p[0] >= self.bounds[0] && p[0] <= self.bounds[0] + self.bounds[2] && p[1] >= self.bounds[1] && p[1] <= self.bounds[1] + self.bounds[3]
    }

    pub fn hit(&self, p: [f32; 2]) -> Option<BarAction> {
        self.items[..self.n].iter().find(|b| p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h).map(|b| b.action)
    }

    pub fn draw(&self, ui: &mut Ui, mouse: [f32; 2]) {
        if self.n == 0 {
            return;
        }
        let near = self.contains(mouse);
        let s = self.text;
        // faint backing plate so the labels stay readable over bright sky / terrain
        let [bx, by, bw, bh] = self.bounds;
        ui.rect(bx, by, bw, bh, [0.01, 0.02, 0.04, if near { 0.62 } else { 0.38 }]);
        for b in &self.items[..self.n] {
            let hover = mouse[0] >= b.x && mouse[0] <= b.x + b.w && mouse[1] >= b.y && mouse[1] <= b.y + b.h;
            let fill = if b.active {
                [0.10, 0.45, 0.62, 0.92]
            } else if hover {
                [0.16, 0.26, 0.36, 0.92]
            } else {
                [0.05, 0.08, 0.12, 0.72]
            };
            ui.rect(b.x, b.y, b.w, b.h, fill);
            ui.frame(b.x, b.y, b.w, b.h, 1.0, if b.active { C_CYAN } else if hover { C_WHITE } else { [0.35, 0.42, 0.5, 0.8] });
            let tw = Ui::text_width(s, b.label.chars().count());
            ui.text(b.x + (b.w - tw) * 0.5, b.y + (b.h - s) * 0.5, s, if b.active || hover { C_WHITE } else { [0.78, 0.84, 0.9, 1.0] }, b.label);
        }
        // key hint, only while the pointer is near the strip so it never clutters the view
        if near {
            let hs = s * 0.8;
            let tw = Ui::text_width(hs, self.hint.chars().count());
            let x = ((bx + bw * 0.5) - tw * 0.5).max(6.0);
            ui.text(x, by - hs * 1.5, hs, C_GREY, self.hint);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cockpit_bar_lists_available_presets_and_fits_the_screen() {
        for (w, h) in [(1280.0, 720.0), (800.0, 600.0), (3840.0, 2160.0)] {
            for interior in [Interior::Hd, Interior::Procedural] {
                let b = Bar::layout(w, h, View::Cockpit, Focus::Pfd, false, interior, View::Chase);
                let want = 1 + Focus::ALL.iter().filter(|f| f.available(interior)).count();
                assert_eq!(b.n, want);
                for i in 0..b.n {
                    let it = b.items[i];
                    assert!(it.x >= 0.0 && it.x + it.w <= w && it.y >= 0.0 && it.y + it.h <= h, "{} at {w}x{h}", it.label);
                    // centre of a button hits that button
                    assert_eq!(b.hit([it.x + it.w * 0.5, it.y + it.h * 0.5]), Some(it.action));
                    if i > 0 {
                        assert!(b.items[i - 1].x + b.items[i - 1].w <= it.x, "buttons do not overlap");
                    }
                }
                assert_eq!(b.items[..b.n].iter().filter(|x| x.active).count(), 1);
                assert!(b.contains([w * 0.5, b.items[0].y + 2.0]) && !b.contains([w * 0.5, 10.0]));
            }
        }
    }

    #[test]
    fn external_bar_marks_the_current_view() {
        let b = Bar::layout(1280.0, 720.0, View::Wing, Focus::Seat, false, Interior::Procedural, View::Wing);
        assert_eq!(b.n, 4);
        let active: Vec<_> = b.items[..b.n].iter().filter(|x| x.active).map(|x| x.label).collect();
        assert_eq!(active, vec!["WING"]);
        assert_eq!(b.items[3].action, BarAction::Toggle);
        assert!(b.hit([2.0, 2.0]).is_none());
    }

    #[test]
    fn custom_focus_deactivates_every_preset_button() {
        let b = Bar::layout(1280.0, 720.0, View::Cockpit, Focus::Seat, true, Interior::Hd, View::Chase);
        assert!(b.items[..b.n].iter().all(|x| !x.active));
    }
}
