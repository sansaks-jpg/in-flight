//! Marketplace / add-on manager window (menu tile "ADD-ONS" or F2): download, cancel, enable / disable and remove the HD A320
//! flight deck. All state lives in `addons::AddonManager`; the heavy download runs on its own thread, this window only polls it.

use super::{alpha, modals, BtnKind, Gui, ACCENT, AMBER, DIM, GREEN, LINE, MUTED, RED, TEXT};
use crate::addons::{AddonManager, State};

/// Result of one frame of the window (the app reacts: preload the model, drop it, ...).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct MarketEvent {
    pub started: bool,
    pub toggled: bool,
    pub removed: bool,
}

pub fn fmt_mb(b: u64) -> String {
    format!("{:.1} MB", b as f64 / 1_000_000.0)
}

/// Greedy word wrap (monospace font: `chars` characters per line).
pub fn wrap(text: &str, chars: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut cur = String::new();
    for w in text.split_whitespace() {
        if !cur.is_empty() && cur.len() + 1 + w.len() > chars {
            lines.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(w);
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    lines
}

pub fn draw_marketplace(g: &mut Gui, m: &mut AddonManager, deck_ready: bool, close: &mut bool) -> MarketEvent {
    let mut ev = MarketEvent::default();
    let (w, h) = (820.0f32, 470.0f32);
    let (x, y) = modals::window(g, w, h, "MARKETPLACE - ADD-ONS", close);
    g.text(x + 24.0, y + 54.0, 11.0, DIM, 0, "Optional content is downloaded on demand and cached on this PC - nothing is bundled in the installer.");

    let (cx, cy, cw, ch) = (x + 24.0, y + 84.0, w - 48.0, 258.0);
    g.rect(cx, cy, cw, ch, [1.0, 1.0, 1.0, 0.045]);
    g.frame(cx, cy, cw, ch, 1.0, LINE);
    // thumbnail (stylised cockpit glareshield)
    let (tx, ty, tw, th) = (cx + 16.0, cy + 16.0, 200.0, 128.0);
    g.rect_v(tx, ty, tw, th, [0.10, 0.14, 0.20, 1.0], [0.03, 0.05, 0.08, 1.0]);
    g.frame(tx, ty, tw, th, 1.0, LINE);
    for i in 0..3 {
        let sx = tx + 18.0 + i as f32 * 58.0;
        g.rect(sx, ty + 22.0, 50.0, 50.0, [0.02, 0.05, 0.08, 1.0]);
        g.frame(sx, ty + 22.0, 50.0, 50.0, 1.0, alpha(ACCENT, 0.7));
        g.line([sx + 6.0, ty + 47.0], [sx + 44.0, ty + 47.0], 1.0, alpha(GREEN, 0.8));
    }
    for i in 0..8 {
        g.disc([tx + 20.0 + i as f32 * 23.0, ty + 100.0], 5.0, alpha(AMBER, 0.55));
    }

    let a = m.addon.clone();
    let p = m.progress();
    let (nx, mut ny) = (tx + tw + 20.0, cy + 16.0);
    g.text(nx, ny, 18.0, TEXT, 0, &a.name);
    ny += 26.0;
    g.textf(nx, ny, 11.0, MUTED, 0, format_args!("v{}  -  {}  -  {}", a.version, a.author, a.license));
    ny += 22.0;
    for l in wrap(&a.description, 66).iter().take(4) {
        g.text(nx, ny, 11.0, DIM, 0, l);
        ny += 16.0;
    }
    g.textf(nx, cy + 142.0, 11.0, DIM, 0, format_args!("Download size {}  -  {} triangles, 21 textures", fmt_mb(a.total_size()), "439,000"));

    // status line + progress
    let (st_txt, st_col) = match &p.state {
        State::NotInstalled => ("NOT INSTALLED - procedural cockpit in use".to_string(), AMBER),
        State::Downloading => (format!("DOWNLOADING {}  mirror {}/{}", p.file, p.mirror + 1, a.files.iter().find(|f| f.name == p.file).map(|f| f.urls.len()).unwrap_or(1)), ACCENT),
        State::Installed if m.enabled() => (if deck_ready { "INSTALLED - HD flight deck active".to_string() } else { "INSTALLED - loading model...".to_string() }, GREEN),
        State::Installed => ("INSTALLED - disabled (procedural cockpit in use)".to_string(), AMBER),
        State::Failed(e) => (format!("FAILED: {}", e.chars().take(92).collect::<String>()), RED),
    };
    g.text(cx + 16.0, cy + 176.0, 11.5, st_col, 0, &st_txt);
    let (bx, by, bw) = (cx + 16.0, cy + 196.0, cw - 32.0);
    g.rect(bx, by, bw, 10.0, [1.0, 1.0, 1.0, 0.10]);
    let frac = match p.state {
        State::Installed => 1.0,
        State::Downloading => p.fraction(),
        _ => 0.0,
    };
    g.rect(bx, by, bw * frac, 10.0, if matches!(p.state, State::Failed(_)) { RED } else if p.state == State::Installed { GREEN } else { ACCENT });
    if p.state == State::Downloading {
        g.textf(bx, by + 16.0, 10.5, DIM, 0, format_args!("{} / {}  ({:.0}%)", fmt_mb(p.loaded), fmt_mb(p.total), frac * 100.0));
    } else {
        g.textf(bx, by + 16.0, 10.0, MUTED, 0, format_args!("Cache: {}", m.dir().display().to_string().chars().take(100).collect::<String>()));
    }

    // buttons
    let by2 = cy + ch + 16.0;
    match p.state {
        State::Downloading => {
            if g.btn(cx, by2, 150.0, 34.0, "CANCEL", BtnKind::Danger) {
                m.cancel();
            }
        }
        State::Installed => {
            let on = m.enabled();
            g.text(cx, by2 + 10.0, 12.0, TEXT, 0, "Use HD flight deck");
            let now = g.switch(cx + 170.0, by2 + 7.0, on);
            if now != on {
                m.set_enabled(now);
                ev.toggled = true;
            }
            if g.btn(cx + 250.0, by2, 150.0, 34.0, "REMOVE FILES", BtnKind::Danger) {
                m.uninstall();
                ev.removed = true;
            }
        }
        _ => {
            let label = if matches!(p.state, State::Failed(_)) { "RETRY DOWNLOAD" } else { "DOWNLOAD" };
            if g.btn(cx, by2, 190.0, 34.0, label, BtnKind::Primary) {
                m.start_download();
                ev.started = true;
            }
        }
    }
    g.text(x + w - 24.0, by2 + 11.0, 10.5, MUTED, 2, "Source: github.com/radebit/flight-simulator (pinned commit)  -  F2 to open");
    ev
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_respects_width() {
        let l = wrap("alpha beta gamma delta epsilon zeta", 12);
        assert!(l.iter().all(|s| s.len() <= 12), "{l:?}");
        assert_eq!(l.join(" "), "alpha beta gamma delta epsilon zeta");
        assert!(wrap("", 10).is_empty());
    }

    #[test]
    fn megabytes() {
        assert_eq!(fmt_mb(50_576_144), "50.6 MB");
    }
}
