//! Route map, runway vector diagram, airport mini-map and vertical profile (ports of `MapPanel.tsx`,
//! `AirportMiniMap.tsx` and `CanvasMap.ts`).
//!
//! * Route map: Web-Mercator projection of the great-circle route over the embedded land mask.
//! * Runway diagram: every runway of an airport at true scale (equirectangular ENU metres), the selected runway end with
//!   its take-off direction arrow, north arrow, scale bar and the wind vector.
//! * Profile: climb / cruise / top-of-descent / descent side view of the planned flight level.

use super::dispatch::{RouteDispatch, M_PER_NM};
use super::globe::{angular_distance, is_land, slerp_lat_lon};
use super::{alpha, Gui, ACCENT, AMBER, DIM, GREEN, LINE, MAGENTA, MUTED, TEXT};
use crate::airports::{Airport, RunwayEnd};
use crate::geo::*;
use crate::gfx::ui::Col;

const OCEAN: Col = [0.025, 0.075, 0.15, 1.0];
const LAND: Col = [0.115, 0.20, 0.16, 1.0];

// ------------------------------------------------------------------------------------------------ route map

/// Web-Mercator view fitted to a pair of points.
#[derive(Clone, Copy, Debug)]
pub struct MercView {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    /// centre in mercator metres-on-unit-sphere (radians)
    pub cx: f64,
    pub cy: f64,
    /// pixels per radian
    pub k: f64,
}

impl MercView {
    pub fn fit(x: f32, y: f32, w: f32, h: f32, a: (f64, f64), b: (f64, f64)) -> Self {
        // unwrap b's longitude next to a's so routes crossing the antimeridian stay continuous
        let lon_b = a.1 + wrap180(b.1 - a.1);
        let (x0, x1) = ((a.1 * D2R).min(lon_b * D2R), (a.1 * D2R).max(lon_b * D2R));
        let m = |lat: f64| (std::f64::consts::FRAC_PI_4 + clamp(lat, -80.0, 80.0) * D2R / 2.0).tan().ln();
        let (y0, y1) = (m(a.0).min(m(b.0)), m(a.0).max(m(b.0)));
        let pad = 0.28;
        let (sx, sy) = (((x1 - x0) * (1.0 + pad * 2.0)).max(0.06), ((y1 - y0) * (1.0 + pad * 2.0)).max(0.04));
        let k = (w as f64 / sx).min(h as f64 / sy);
        Self { x, y, w, h, cx: (x0 + x1) / 2.0, cy: (y0 + y1) / 2.0, k }
    }
    pub fn to_screen(&self, lat: f64, lon: f64, ref_lon: f64) -> [f32; 2] {
        let lon = ref_lon + wrap180(lon - ref_lon);
        let my = (std::f64::consts::FRAC_PI_4 + clamp(lat, -85.0, 85.0) * D2R / 2.0).tan().ln();
        [self.x + self.w * 0.5 + ((lon * D2R - self.cx) * self.k) as f32, self.y + self.h * 0.5 - ((my - self.cy) * self.k) as f32]
    }
    pub fn to_geo(&self, sx: f32, sy: f32) -> (f64, f64) {
        let lon = (self.cx + (sx - self.x - self.w * 0.5) as f64 / self.k) * R2D;
        let my = self.cy - (sy - self.y - self.h * 0.5) as f64 / self.k;
        let lat = (2.0 * my.exp().atan() - std::f64::consts::FRAC_PI_2) * R2D;
        (lat, wrap180(lon))
    }
}

pub fn draw_route_map(g: &mut Gui, x: f32, y: f32, w: f32, h: f32, dep: &Airport, arr: &Airport, d: &RouteDispatch, fl: u32) {
    g.rect(x, y, w, h, OCEAN);
    g.scissor(Some([x, y, w, h]));
    let v = MercView::fit(x, y, w, h, (dep.lat, dep.lon), (arr.lat, arr.lon));
    // land: run-length merged cells of the land mask
    let cell = 5.0f32;
    let (cols, rows) = ((w / cell).ceil() as usize, (h / cell).ceil() as usize);
    for r in 0..rows {
        let py = y + r as f32 * cell;
        let mut run: Option<usize> = None;
        for c in 0..=cols {
            let land = c < cols && {
                let (lat, lon) = v.to_geo(x + c as f32 * cell + cell * 0.5, py + cell * 0.5);
                lat.abs() < 85.0 && is_land(lat, lon)
            };
            match (land, run) {
                (true, None) => run = Some(c),
                (false, Some(s)) => {
                    let (_, lon_s) = v.to_geo(x + s as f32 * cell, py);
                    let _ = lon_s;
                    let lat = v.to_geo(x, py + cell * 0.5).0;
                    let tint = (lat.abs() as f32 / 90.0).min(1.0);
                    g.rect(x + s as f32 * cell, py, (c - s) as f32 * cell, cell + 0.5, [LAND[0] + tint * 0.30, LAND[1] + tint * 0.28, LAND[2] + tint * 0.26, 1.0]);
                    run = None;
                }
                _ => {}
            }
        }
    }
    // graticule at a "nice" step
    let span_deg = (w as f64 / v.k) * R2D;
    let step = [0.5, 1.0, 2.0, 5.0, 10.0, 20.0, 30.0].into_iter().find(|s| span_deg / s < 7.0).unwrap_or(30.0);
    let (c_lat, c_lon) = v.to_geo(x + w * 0.5, y + h * 0.5);
    let mut lon = ((c_lon - span_deg) / step).floor() * step;
    while lon < c_lon + span_deg {
        let a = v.to_screen(0.0, lon, c_lon);
        g.line([a[0], y], [a[0], y + h], 1.0, [1.0, 1.0, 1.0, 0.06]);
        if a[0] > x + 4.0 && a[0] < x + w - 30.0 {
            g.textf(a[0] + 3.0, y + h - 13.0, 9.0, MUTED, 0, format_args!("{:.0}", lon));
        }
        lon += step;
    }
    let (lat_lo, lat_hi) = (v.to_geo(x, y + h).0, v.to_geo(x, y).0);
    let mut lat = (lat_lo / step).floor() * step;
    while lat < lat_hi + step {
        let a = v.to_screen(lat, c_lon, c_lon);
        g.line([x, a[1]], [x + w, a[1]], 1.0, [1.0, 1.0, 1.0, 0.06]);
        if a[1] > y + 4.0 && a[1] < y + h - 14.0 {
            g.textf(x + 4.0, a[1] - 11.0, 9.0, MUTED, 0, format_args!("{:.0}", lat));
        }
        lat += step;
    }
    let _ = c_lat;

    // great-circle route
    let (la, lo, lb, lc) = (dep.lat * D2R, dep.lon * D2R, arr.lat * D2R, arr.lon * D2R);
    let n = 72;
    let mut prev: Option<[f32; 2]> = None;
    let mut pts = [[0.0f32; 2]; 73];
    for (k, p) in pts.iter_mut().enumerate() {
        let (lat, lon) = slerp_lat_lon(la, lo, lb, lc, k as f64 / n as f64);
        *p = v.to_screen(lat * R2D, lon * R2D, dep.lon);
    }
    for p in pts.iter() {
        if let Some(q) = prev {
            g.line(q, *p, 5.0, alpha(ACCENT, 0.18));
            g.line(q, *p, 2.0, [0.55, 0.85, 1.0, 1.0]);
        }
        prev = Some(*p);
    }
    let total = angular_distance(la, lo, lb, lc);
    let at = |frac: f64| {
        let (lat, lon) = slerp_lat_lon(la, lo, lb, lc, frac.clamp(0.0, 1.0));
        v.to_screen(lat * R2D, lon * R2D, dep.lon)
    };
    let _ = total;
    // top of climb / top of descent markers
    let dist_nm = d.distance_nm.max(1.0);
    for (frac, label) in [(d.climb_nm / dist_nm, "T/C"), (1.0 - d.tod_nm / dist_nm, "T/D")] {
        if (0.03..0.97).contains(&frac) && d.climb_nm + d.tod_nm < dist_nm {
            let p = at(frac);
            g.rect(p[0] - 3.0, p[1] - 3.0, 6.0, 6.0, AMBER);
            g.text(p[0] + 6.0, p[1] - 14.0, 9.5, AMBER, 0, label);
        }
    }
    // moving aircraft marker
    let t = ((g.time * 0.12) % 1.0) as f64;
    let p = at(t);
    g.disc(p, 4.0, TEXT);
    // endpoints
    for (a, col) in [(dep, ACCENT), (arr, MAGENTA)] {
        let p = v.to_screen(a.lat, a.lon, dep.lon);
        g.ring(p, 8.0, 2.0, col);
        g.disc(p, 3.0, col);
        g.rect(p[0] + 10.0, p[1] - 21.0, 40.0, 15.0, [0.0, 0.02, 0.05, 0.8]);
        g.text(p[0] + 13.0, p[1] - 19.0, 11.0, col, 0, &a.icao);
    }
    let mid = at(0.5);
    g.rect(mid[0] - 40.0, mid[1] + 8.0, 80.0, 15.0, [0.0, 0.02, 0.05, 0.8]);
    g.textf(mid[0], mid[1] + 10.0, 10.5, TEXT, 1, format_args!("{:.0} NM  FL{}", d.distance_nm, fl));
    g.scissor(None);
    g.frame(x, y, w, h, 1.0, LINE);
}

// ------------------------------------------------------------------------------------------------ runway diagram

fn enu(lat0: f64, lon0: f64, lat: f64, lon: f64) -> (f64, f64) {
    ((lon - lon0) * D2R * R_EARTH * (lat0 * D2R).cos(), (lat - lat0) * D2R * R_EARTH)
}

fn nice_scale(max_m: f64) -> f64 {
    [100.0, 200.0, 500.0, 1000.0, 2000.0, 5000.0, 10000.0].into_iter().find(|&s| s >= max_m).unwrap_or(10000.0)
}

fn arrow(g: &mut Gui, from: [f32; 2], to: [f32; 2], th: f32, col: Col, head: f32) {
    g.line(from, to, th, col);
    let (dx, dy) = (to[0] - from[0], to[1] - from[1]);
    let l = (dx * dx + dy * dy).sqrt().max(1e-3);
    let (ux, uy) = (dx / l, dy / l);
    let (px, py) = (-uy, ux);
    g.polygon(&[to, [to[0] - ux * head + px * head * 0.55, to[1] - uy * head + py * head * 0.55], [to[0] - ux * head - px * head * 0.55, to[1] - uy * head - py * head * 0.55]], col);
}

/// Runway layout at true scale. `sel` highlights one runway end (ident); `wind` = (direction FROM °, kt).
pub fn draw_runway_diagram(g: &mut Gui, x: f32, y: f32, w: f32, h: f32, ap: &Airport, sel: Option<&str>, wind: Option<(f64, f64)>) {
    g.rect(x, y, w, h, [0.012, 0.03, 0.055, 1.0]);
    // faint grid
    let mut gx = x + 20.0;
    while gx < x + w {
        g.line([gx, y], [gx, y + h], 1.0, [1.0, 1.0, 1.0, 0.035]);
        gx += 20.0;
    }
    let mut gy = y + 20.0;
    while gy < y + h {
        g.line([x, gy], [x + w, gy], 1.0, [1.0, 1.0, 1.0, 0.035]);
        gy += 20.0;
    }
    g.scissor(Some([x, y, w, h]));
    let mut ext = 500.0f64;
    for r in &ap.runways {
        for (la, lo) in [(r.le_lat, r.le_lon), (r.he_lat, r.he_lon)] {
            let (ex, ny) = enu(ap.lat, ap.lon, la, lo);
            ext = ext.max(ex.abs()).max(ny.abs());
        }
    }
    let half = (w.min(h) * 0.5 - 22.0) as f64;
    let k = half / ext;
    let (cx, cy) = (x + w * 0.5, y + h * 0.5);
    let to_px = |la: f64, lo: f64| {
        let (ex, ny) = enu(ap.lat, ap.lon, la, lo);
        [cx + (ex * k) as f32, cy - (ny * k) as f32]
    };
    let sel_end: Option<RunwayEnd> = sel.and_then(|s| ap.find_end(s));
    for r in &ap.runways {
        let (a, b) = (to_px(r.le_lat, r.le_lon), to_px(r.he_lat, r.he_lon));
        let is_sel = sel_end.as_ref().map_or(false, |e| r.le == e.ident || r.he == e.ident);
        let wpx = ((r.width.max(18.0) * k) as f32).max(if is_sel { 4.5 } else { 3.0 });
        let paved = matches!(r.surface, 'A' | 'C');
        let base: Col = if paved { [0.30, 0.33, 0.38, 1.0] } else { [0.30, 0.26, 0.17, 1.0] };
        g.line(a, b, wpx + 2.0, if is_sel { alpha(ACCENT, 0.55) } else { [0.0, 0.0, 0.0, 0.0] });
        g.line(a, b, wpx, if is_sel { [0.42, 0.46, 0.53, 1.0] } else { base });
        // dashed centre-line
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len = (dx * dx + dy * dy).sqrt();
        let nd = ((len / 7.0) as usize).min(120);
        for i in 0..nd {
            if i % 2 == 0 {
                let (t0, t1) = (i as f32 / nd as f32, (i as f32 + 1.0) / nd as f32);
                g.line([a[0] + dx * t0, a[1] + dy * t0], [a[0] + dx * t1, a[1] + dy * t1], 1.0, [1.0, 1.0, 1.0, 0.55]);
            }
        }
        // idents just beyond each end
        let (ux, uy) = if len > 0.1 { (dx / len, dy / len) } else { (1.0, 0.0) };
        for (p, s, dir) in [(a, &r.le, -1.0f32), (b, &r.he, 1.0f32)] {
            let on = sel_end.as_ref().map_or(false, |e| &e.ident == s);
            let pos = [p[0] + ux * dir * 13.0, p[1] + uy * dir * 13.0];
            g.text(pos[0] - 8.0, pos[1] - 5.0, 10.0, if on { ACCENT } else { DIM }, 0, s);
        }
    }
    if let Some(e) = &sel_end {
        let a = to_px(e.start_lat, e.start_lon);
        let b = to_px(e.end_lat, e.end_lon);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l = (dx * dx + dy * dy).sqrt().max(1.0);
        let reach = (l * 0.55).max(18.0);
        let from = [a[0] + dx / l * 6.0, a[1] + dy / l * 6.0];
        arrow(g, from, [a[0] + dx / l * reach, a[1] + dy / l * reach], 2.0, GREEN, 9.0);
    }
    // north arrow
    arrow(g, [x + 20.0, y + 40.0], [x + 20.0, y + 16.0], 1.5, TEXT, 7.0);
    g.text(x + 20.0, y + 42.0, 10.0, TEXT, 1, "N");
    // scale bar
    let bar_m = nice_scale(ext * 0.5);
    let bar_px = (bar_m * k) as f32;
    g.line([x + 12.0, y + h - 14.0], [x + 12.0 + bar_px, y + h - 14.0], 2.0, TEXT);
    g.line([x + 12.0, y + h - 19.0], [x + 12.0, y + h - 9.0], 1.0, TEXT);
    g.line([x + 12.0 + bar_px, y + h - 19.0], [x + 12.0 + bar_px, y + h - 9.0], 1.0, TEXT);
    if bar_m >= 1000.0 {
        g.textf(x + 16.0 + bar_px, y + h - 19.0, 10.0, DIM, 0, format_args!("{:.0} km", bar_m / 1000.0));
    } else {
        g.textf(x + 16.0 + bar_px, y + h - 19.0, 10.0, DIM, 0, format_args!("{:.0} m", bar_m));
    }
    // wind vector (points where the wind blows TO)
    if let Some((from_deg, kt)) = wind {
        let to = (from_deg + 180.0) * D2R;
        let (wx, wy) = (x + w - 34.0, y + 36.0);
        let (ux, uy) = (to.sin() as f32, -to.cos() as f32);
        g.ring([wx, wy], 22.0, 1.0, [1.0, 1.0, 1.0, 0.18]);
        arrow(g, [wx - ux * 17.0, wy - uy * 17.0], [wx + ux * 17.0, wy + uy * 17.0], 2.0, AMBER, 8.0);
        g.textf(wx, wy + 26.0, 9.5, AMBER, 1, format_args!("{:03.0}/{:.0}", from_deg, kt));
    }
    g.scissor(None);
    g.frame(x, y, w, h, 1.0, LINE);
}

/// Compact airport inspector (AirportMiniMap): header + runway layout.
pub fn draw_airport_minimap(g: &mut Gui, x: f32, y: f32, w: f32, h: f32, ap: &Airport, sel: Option<&str>) {
    g.rect(x, y, w, h, super::PANEL);
    g.frame(x, y, w, h, 1.0, LINE);
    g.text(x + 10.0, y + 8.0, 15.0, ACCENT, 0, &ap.icao);
    if !ap.iata.is_empty() {
        g.text(x + 10.0 + 15.0 * 0.602 * (ap.icao.len().max(4) as f32 + 1.0), y + 11.0, 11.0, DIM, 0, &ap.iata);
    }
    let name: String = ap.name.chars().take(((w - 20.0) / (10.5 * 0.602)) as usize).collect();
    g.text(x + 10.0, y + 28.0, 10.5, TEXT, 0, &name);
    let main = ap.main_runway();
    g.textf(
        x + 10.0,
        y + 43.0,
        10.0,
        DIM,
        0,
        format_args!("{}, {} - elev {:.0} ft - {} rwy{}", ap.city.chars().take(14).collect::<String>(), ap.country, ap.elev / FT, ap.runways.len(), if ap.runways.len() == 1 { "" } else { "s" }),
    );
    if let Some(r) = main {
        g.textf(x + 10.0, y + 57.0, 10.0, MUTED, 0, format_args!("longest {}/{} {:.0} ft ({:.0} m)", r.le, r.he, r.length / FT, r.length));
    }
    if ap.runways.is_empty() {
        g.text(x + w * 0.5, y + h * 0.6, 11.0, MUTED, 1, "no runway data");
    } else {
        draw_runway_diagram(g, x + 8.0, y + 74.0, w - 16.0, h - 82.0, ap, sel, None);
    }
}

// ------------------------------------------------------------------------------------------------ profile

pub fn draw_profile(g: &mut Gui, x: f32, y: f32, w: f32, h: f32, d: &RouteDispatch, fl: u32, dep_elev_m: f64, arr_elev_m: f64) {
    g.rect(x, y, w, h, [0.012, 0.03, 0.055, 1.0]);
    g.frame(x, y, w, h, 1.0, LINE);
    let (px, py, pw, ph) = (x + 34.0, y + 16.0, w - 48.0, h - 34.0);
    let max_fl = 400.0f32;
    let sy = |ft: f64| py + ph - (ft as f32 / (max_fl * 100.0)) * ph;
    for lvl in [100, 200, 300, 400] {
        let yy = sy(lvl as f64 * 100.0);
        g.line([px, yy], [px + pw, yy], 1.0, [1.0, 1.0, 1.0, 0.07]);
        g.textf(px - 4.0, yy - 5.0, 9.0, MUTED, 2, format_args!("{lvl}"));
    }
    let dist = d.distance_nm.max(1.0);
    let sxn = |nm: f64| px + (nm / dist) as f32 * pw;
    let fit = d.climb_nm + d.tod_nm <= dist;
    let (tc, td) = if fit { (d.climb_nm, dist - d.tod_nm) } else { (dist * 0.45, dist * 0.55) };
    let cruise_ft = if fit { fl as f64 * 100.0 } else { (dist * 0.45) * 2200.0 / 5.0 };
    let (e0, e1) = (dep_elev_m / FT, arr_elev_m / FT);
    let pts = [[sxn(0.0), sy(e0)], [sxn(tc), sy(cruise_ft)], [sxn(td), sy(cruise_ft)], [sxn(dist), sy(e1)]];
    g.polygon(&[pts[0], pts[1], pts[2], pts[3], [pts[3][0], sy(0.0)], [pts[0][0], sy(0.0)]], alpha(ACCENT, 0.16));
    g.polyline(&pts, 2.0, ACCENT);
    g.text(sxn(0.0) + 2.0, y + h - 14.0, 9.5, DIM, 0, "DEP");
    g.text(sxn(dist) - 2.0, y + h - 14.0, 9.5, DIM, 2, "ARR");
    g.textf(sxn((tc + td) * 0.5), pts[1][1] - 14.0, 10.5, TEXT, 1, format_args!("FL{fl}"));
    g.text(sxn(tc), pts[1][1] + 4.0, 9.5, AMBER, 1, "T/C");
    g.text(sxn(td), pts[2][1] + 4.0, 9.5, AMBER, 1, "T/D");
    g.textf(px + pw * 0.5, y + h - 14.0, 9.5, MUTED, 1, format_args!("{:.0} NM  -  descent {:.0} NM (3 deg)", dist, d.tod_nm));
    let _ = M_PER_NM;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mercator_view_roundtrip_and_fit() {
        let v = MercView::fit(10.0, 20.0, 400.0, 300.0, (37.6, -122.4), (33.9, -118.4));
        let p = v.to_screen(37.6, -122.4, -122.4);
        let q = v.to_screen(33.9, -118.4, -122.4);
        for s in [p, q] {
            assert!(s[0] > 10.0 && s[0] < 410.0 && s[1] > 20.0 && s[1] < 320.0, "{s:?}");
        }
        let (lat, lon) = v.to_geo(p[0], p[1]);
        assert!((lat - 37.6).abs() < 1e-3 && (lon + 122.4).abs() < 1e-3, "{lat} {lon}");
        // north is up, east is right
        assert!(p[1] < q[1] && p[0] < q[0]);
    }

    #[test]
    fn antimeridian_routes_stay_continuous() {
        let v = MercView::fit(0.0, 0.0, 500.0, 300.0, (35.0, 170.0), (35.0, -170.0));
        let a = v.to_screen(35.0, 170.0, 170.0);
        let b = v.to_screen(35.0, -170.0, 170.0);
        assert!((b[0] - a[0]).abs() < 500.0 && b[0] > a[0], "{a:?} {b:?}");
    }

    #[test]
    fn nice_scale_rounds_up() {
        assert_eq!(nice_scale(150.0), 200.0);
        assert_eq!(nice_scale(1500.0), 2000.0);
    }
}
