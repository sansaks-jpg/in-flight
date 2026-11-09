//! PFD / ND behaviour tests: every glareshield EFIS control must visibly change the right display.
//!
//! There is no GPU in CI, so the 2D batches produced by `gfx::displays::draw_atlas` are replayed by a tiny CPU triangle
//! rasteriser (scissor + glyph atlas aware). The images are written to `target/efis-shots/*.png` for visual review and are
//! compared pixel-wise by the tests.

use inflight::a320sys::{A320Systems, NdOpt};
use inflight::airports::AirportDb;
use inflight::cockpit::{cell_origin, ATLAS_CELL, ATLAS_H, ATLAS_W, CELL_EWD, CELL_ND, CELL_ND2, CELL_PFD, CELL_PFD2, CELL_SD};
use inflight::game::Flight;
use inflight::gfx::displays::{brightness_of, content_of, dim_alpha, draw_atlas, Content};
use inflight::gfx::ui::{self, Ui, ATLAS_H as GA_H, ATLAS_W as GA_W};
use std::sync::OnceLock;

const T0: f64 = 1_718_884_800.0;

fn db() -> &'static AirportDb {
    static D: OnceLock<AirportDb> = OnceLock::new();
    D.get_or_init(AirportDb::embedded)
}

/// A flight shortly after take-off: climbing, banked a little, some wind, route loaded.
fn flight() -> Flight {
    let mut f = Flight::new(db(), "WIII", "WARR", T0).expect("flight");
    for _ in 0..(40.0 / inflight::game::PHYS_DT) as usize {
        f.step(inflight::game::PHYS_DT, &inflight::game::PilotInput::default());
    }
    f
}

struct Img {
    w: usize,
    h: usize,
    rgb: Vec<u8>,
}

fn glyphs() -> &'static Vec<u8> {
    static G: OnceLock<Vec<u8>> = OnceLock::new();
    G.get_or_init(ui::build_atlas)
}

/// Replay the Ui batches into an RGB image (`scale` x the atlas size).
fn rasterise(u: &Ui, scale: f32) -> Img {
    let (w, h) = ((ATLAS_W as f32 * scale) as usize, (ATLAS_H as f32 * scale) as usize);
    let mut rgb = vec![0u8; w * h * 3];
    let atlas = glyphs();
    for c in u.cmds.iter().filter(|c| !c.globe) {
        let sc = c.scissor.map(|[x, y, sw, sh]| [x as f32 * scale, y as f32 * scale, (x + sw) as f32 * scale, (y + sh) as f32 * scale]).unwrap_or([0.0, 0.0, w as f32, h as f32]);
        for tri in u.verts[c.start as usize..(c.start + c.count) as usize].chunks_exact(3) {
            let p: Vec<[f32; 2]> = tri.iter().map(|v| [v.pos[0] * scale, v.pos[1] * scale]).collect();
            let (minx, maxx) = (p.iter().map(|q| q[0]).fold(f32::MAX, f32::min), p.iter().map(|q| q[0]).fold(f32::MIN, f32::max));
            let (miny, maxy) = (p.iter().map(|q| q[1]).fold(f32::MAX, f32::min), p.iter().map(|q| q[1]).fold(f32::MIN, f32::max));
            let (x0, x1) = (minx.max(sc[0]).floor().max(0.0) as usize, (maxx.min(sc[2]).ceil() as usize).min(w));
            let (y0, y1) = (miny.max(sc[1]).floor().max(0.0) as usize, (maxy.min(sc[3]).ceil() as usize).min(h));
            let den = (p[1][1] - p[2][1]) * (p[0][0] - p[2][0]) + (p[2][0] - p[1][0]) * (p[0][1] - p[2][1]);
            if den.abs() < 1e-9 {
                continue;
            }
            for y in y0..y1 {
                for x in x0..x1 {
                    let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
                    let l0 = ((p[1][1] - p[2][1]) * (fx - p[2][0]) + (p[2][0] - p[1][0]) * (fy - p[2][1])) / den;
                    let l1 = ((p[2][1] - p[0][1]) * (fx - p[2][0]) + (p[0][0] - p[2][0]) * (fy - p[2][1])) / den;
                    let l2 = 1.0 - l0 - l1;
                    if l0 < 0.0 || l1 < 0.0 || l2 < 0.0 {
                        continue;
                    }
                    let uv = [l0 * tri[0].uv[0] + l1 * tri[1].uv[0] + l2 * tri[2].uv[0], l0 * tri[0].uv[1] + l1 * tri[1].uv[1] + l2 * tri[2].uv[1]];
                    let (tx, ty) = (((uv[0] * GA_W as f32) as usize).min(GA_W - 1), ((uv[1] * GA_H as f32) as usize).min(GA_H - 1));
                    let a = tri[0].col[3] * atlas[ty * GA_W + tx] as f32 / 255.0;
                    let o = (y * w + x) * 3;
                    for k in 0..3 {
                        rgb[o + k] = (tri[0].col[k] * 255.0 * a + rgb[o + k] as f32 * (1.0 - a)) as u8;
                    }
                }
            }
        }
    }
    Img { w, h, rgb }
}

fn save(img: &Img, name: &str) {
    let dir = std::env::var("EFIS_SHOT_DIR").unwrap_or_else(|_| "target/efis-shots".into());
    std::fs::create_dir_all(&dir).unwrap();
    let file = std::fs::File::create(format!("{dir}/{name}.png")).unwrap();
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), img.w as u32, img.h as u32);
    enc.set_color(png::ColorType::Rgb);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(&img.rgb).unwrap();
}

/// Crop one atlas cell of a rasterised image.
fn cell_img(img: &Img, cell: usize, scale: f32) -> Img {
    let [ox, oy] = cell_origin(cell);
    let (ox, oy, n) = ((ox * scale) as usize, (oy * scale) as usize, (ATLAS_CELL as f32 * scale) as usize);
    let mut rgb = Vec::with_capacity(n * n * 3);
    for y in 0..n {
        rgb.extend_from_slice(&img.rgb[((oy + y) * img.w + ox) * 3..((oy + y) * img.w + ox + n) * 3]);
    }
    Img { w: n, h: n, rgb }
}

fn atlas(f: &Flight, s: &A320Systems) -> Ui {
    let mut u = Ui::new();
    u.begin(ATLAS_W as f32, ATLAS_H as f32);
    draw_atlas(&mut u, f, s, 12.3);
    u.end();
    u
}

fn render(f: &Flight, s: &A320Systems) -> Img {
    rasterise(&atlas(f, s), 1.0)
}

/// Number of pixels that are not (almost) black.
fn lit(img: &Img) -> usize {
    img.rgb.chunks_exact(3).filter(|p| p[0] as u32 + p[1] as u32 + p[2] as u32 > 40).count()
}

fn diff(a: &Img, b: &Img) -> usize {
    a.rgb.chunks_exact(3).zip(b.rgb.chunks_exact(3)).filter(|(p, q)| (0..3).map(|k| (p[k] as i32 - q[k] as i32).abs()).sum::<i32>() > 30).count()
}

fn sys() -> A320Systems {
    let mut s = A320Systems::default();
    s.follow_qnh(1013.0);
    s
}

#[test]
fn atlas_batches_never_leave_their_cell_and_fit_the_vertex_budget() {
    let f = flight();
    let mut s = sys();
    for mode in 0..5 {
        s.efis[0].nd_mode = mode;
        s.efis[1].nd_mode = 4 - mode;
        s.efis[0].opt = Some(NdOpt::Wpt);
        s.efis[0].nav = [1, -1];
        s.efis[0].ls = true;
        s.terr_on_nd = [true, true];
        let u = atlas(&f, &s);
        assert!(u.verts.len() < ui::MAX_UI_VERTS, "mode {mode}: {} vertices", u.verts.len());
        for c in &u.cmds {
            let [x, y, w, h] = c.scissor.expect("every display batch is scissored to its cell");
            let (cx, cy) = (x / ATLAS_CELL, y / ATLAS_CELL);
            assert!((x + w - 1) / ATLAS_CELL == cx && (y + h - 1) / ATLAS_CELL == cy, "scissor {:?} straddles two cells (mode {mode})", c.scissor);
        }
    }
}

#[test]
fn pfd_and_nd_render_visible_content_on_both_sides() {
    let f = flight();
    let s = sys();
    let img = render(&f, &s);
    for cell in [CELL_PFD, CELL_ND, CELL_EWD, CELL_SD, CELL_PFD2, CELL_ND2] {
        let n = lit(&cell_img(&img, cell, 1.0));
        assert!(n > 2500, "cell {cell} nearly empty ({n} lit px)");
    }
    save(&img, "atlas_default");
    let big = rasterise(&atlas(&f, &s), 2.0);
    save(&cell_img(&big, CELL_PFD, 2.0), "pfd_capt");
    save(&cell_img(&big, CELL_ND, 2.0), "nd_capt_arc");
}

#[test]
fn nd_mode_knob_gives_five_distinct_layouts() {
    let f = flight();
    let mut s = sys();
    let mut imgs = Vec::new();
    for (m, name) in ["ls", "vor", "nav", "arc", "plan"].iter().enumerate() {
        s.efis[0].nd_mode = m;
        let big = rasterise(&atlas(&f, &s), 2.0);
        let nd = cell_img(&big, CELL_ND, 2.0);
        save(&nd, &format!("nd_mode_{m}_{name}"));
        imgs.push(cell_img(&rasterise(&atlas(&f, &s), 1.0), CELL_ND, 1.0));
    }
    for i in 0..5 {
        for j in i + 1..5 {
            assert!(diff(&imgs[i], &imgs[j]) > 120, "ND modes {i} and {j} look the same");
        }
    }
}

#[test]
fn nd_range_knob_rescales_the_map() {
    let f = flight();
    let mut s = sys();
    s.efis[0].nd_mode = 3;
    let mut prev: Option<Img> = None;
    for r in 0..6 {
        s.efis[0].nd_range = r;
        let nd = cell_img(&render(&f, &s), CELL_ND, 1.0);
        if let Some(p) = &prev {
            assert!(diff(p, &nd) > 150, "range step {r} did not change the picture");
        }
        prev = Some(nd);
    }
}

#[test]
fn option_buttons_each_add_a_magenta_layer_and_only_one_at_a_time() {
    let mut f = flight();
    // put the aircraft over a dense navaid / airport area (Singapore / Johor)
    f.lat = 1.35;
    f.lon = 103.9;
    let mut s = sys();
    s.efis[0].nd_mode = 3;
    s.efis[0].nd_range = 4;
    let _ = inflight::navaids::airport_points_blocking();
    let base = cell_img(&render(&f, &s), CELL_ND, 1.0);
    let mag = |img: &Img| img.rgb.chunks_exact(3).filter(|p| p[0] > 200 && p[1] < 140 && p[2] > 180).count();
    let base_mag = mag(&base);
    let mut seen = Vec::new();
    for (k, name) in [(NdOpt::Cstr, "cstr"), (NdOpt::Wpt, "wpt"), (NdOpt::Vord, "vord"), (NdOpt::Ndb, "ndb"), (NdOpt::Arpt, "arpt")] {
        s.efis[0].opt = Some(k);
        let big = rasterise(&atlas(&f, &s), 2.0);
        save(&cell_img(&big, CELL_ND, 2.0), &format!("nd_opt_{name}"));
        let img = cell_img(&render(&f, &s), CELL_ND, 1.0);
        eprintln!("{name}: magenta {} (base {base_mag})", mag(&img));
        seen.push((name, mag(&img), img));
    }
    // the airport layer must find airports near Singapore; the navaid layers must find navaids
    for (name, m, _) in &seen {
        if *name != "cstr" {
            assert!(*m > base_mag + 20, "{name}: no magenta symbols near WSSS");
        }
    }
    // layers differ from each other
    for i in 0..seen.len() {
        for j in i + 1..seen.len() {
            assert!(diff(&seen[i].2, &seen[j].2) > 30 || (seen[i].0 == "cstr" || seen[j].0 == "cstr"), "{} == {}", seen[i].0, seen[j].0);
        }
    }
    // pressing the lit button again clears the layer
    s.efis[0].opt = None;
    s.efis_opt(0, NdOpt::Arpt);
    s.efis_opt(0, NdOpt::Arpt);
    assert_eq!(mag(&cell_img(&render(&f, &s), CELL_ND, 1.0)), base_mag);
}

#[test]
fn adf_vor_switches_draw_bearing_pointers_and_corner_data() {
    let mut f = flight();
    f.lat = -3.7;
    f.lon = 128.2; // next to Ambon VOR-DME
    let mut s = sys();
    s.efis[0].nd_mode = 2;
    let off = cell_img(&render(&f, &s), CELL_ND, 1.0);
    s.efis[0].nav = [1, 0];
    let vor1 = cell_img(&render(&f, &s), CELL_ND, 1.0);
    save(&cell_img(&rasterise(&atlas(&f, &s), 2.0), CELL_ND, 2.0), "nd_vor1");
    s.efis[0].nav = [1, 1];
    let both = cell_img(&render(&f, &s), CELL_ND, 1.0);
    s.efis[0].nav = [-1, -1];
    let adf = cell_img(&render(&f, &s), CELL_ND, 1.0);
    assert!(diff(&off, &vor1) > 300, "VOR needle missing");
    assert!(diff(&vor1, &both) > 100, "second (double-line) needle missing");
    assert!(diff(&vor1, &adf) > 100, "ADF must differ from VOR");
    // the other side's switches do not touch this display
    s.efis[0].nav = [0, 0];
    s.efis[1].nav = [1, 1];
    assert_eq!(diff(&off, &cell_img(&render(&f, &s), CELL_ND, 1.0)), 0, "panels are independent");
}

#[test]
fn baro_knob_moves_the_altimeter_and_std_changes_the_box() {
    let f = flight();
    let mut s = sys();
    let a = cell_img(&render(&f, &s), CELL_PFD, 1.0);
    s.efis_baro_turn(0, 10);
    let b = cell_img(&render(&f, &s), CELL_PFD, 1.0);
    assert!(diff(&a, &b) > 40, "altitude tape / baro text did not react to the baro knob");
    s.efis_baro_set(0, true);
    let c = cell_img(&render(&f, &s), CELL_PFD, 1.0);
    assert!(diff(&b, &c) > 40, "STD not shown");
    // F/O display is untouched by the CAPT knob
    let fo0 = cell_img(&render(&f, &sys()), CELL_PFD2, 1.0);
    assert_eq!(diff(&fo0, &cell_img(&render(&f, &s), CELL_PFD2, 1.0)), 0);
    // units
    s.efis_baro_set(0, false);
    s.efis_baro_unit(0, true);
    let d = cell_img(&render(&f, &s), CELL_PFD, 1.0);
    assert!(diff(&b, &d) > 20, "inHg not shown");
}

#[test]
fn fd_and_ls_buttons_change_the_pfd() {
    let f = flight();
    let mut s = sys();
    let with_fd = cell_img(&render(&f, &s), CELL_PFD, 1.0);
    s.efis[0].fd = false;
    let no_fd = cell_img(&render(&f, &s), CELL_PFD, 1.0);
    assert!(diff(&with_fd, &no_fd) > 150, "FD bars not drawn / not removed");
    s.efis[0].ls = true;
    let ls = cell_img(&render(&f, &s), CELL_PFD, 1.0);
    assert!(diff(&no_fd, &ls) > 100, "LS scales not drawn");
    save(&cell_img(&rasterise(&atlas(&f, &s), 2.0), CELL_PFD, 2.0), "pfd_ls_on");
}

#[test]
fn xfr_swaps_the_images_and_nd_xfr_source_switch_puts_the_sd_on_the_nd() {
    let f = flight();
    let mut s = sys();
    assert_eq!(content_of(CELL_PFD, &s), Content::Pfd(0));
    assert_eq!(content_of(CELL_ND2, &s), Content::Nd(1));
    s.efis[0].xfr = true;
    assert_eq!(content_of(CELL_PFD, &s), Content::Nd(0));
    assert_eq!(content_of(CELL_ND, &s), Content::Pfd(0));
    assert_eq!(content_of(CELL_PFD2, &s), Content::Pfd(1), "F/O XFR is separate");
    let swapped = render(&f, &s);
    save(&swapped, "atlas_capt_xfr");
    s.efis[0].xfr = false;
    s.switching[3] = 0; // CAPT: lower ECAM on the CAPT ND
    assert_eq!(content_of(CELL_ND, &s), Content::Sd);
    assert_eq!(content_of(CELL_ND2, &s), Content::Nd(1));
    s.switching[3] = 2;
    assert_eq!(content_of(CELL_ND2, &s), Content::Sd);
    // the swapped image really differs from the normal one
    let normal = render(&f, &sys());
    assert!(diff(&cell_img(&swapped, CELL_PFD, 1.0), &cell_img(&normal, CELL_PFD, 1.0)) > 2000);
}

#[test]
fn brightness_knobs_dim_and_switch_off_the_units() {
    let f = flight();
    let mut s = sys();
    let full = cell_img(&render(&f, &s), CELL_PFD, 1.0);
    assert_eq!(dim_alpha(0.8), 0.0);
    assert!(dim_alpha(0.3) > dim_alpha(0.6));
    s.bright.pfd[0] = 0.3;
    let dim = cell_img(&render(&f, &s), CELL_PFD, 1.0);
    let sum = |i: &Img| i.rgb.iter().map(|&v| v as u64).sum::<u64>();
    assert!(sum(&dim) < sum(&full) * 8 / 10, "dimmed display must be darker");
    s.bright.pfd[0] = 0.0;
    assert_eq!(lit(&cell_img(&render(&f, &s), CELL_PFD, 1.0)), 0, "BRT fully anticlockwise = unit OFF");
    assert_eq!(brightness_of(CELL_PFD2, &s), 0.8);
    s.bright.nd[1] = 0.0;
    assert_eq!(lit(&cell_img(&render(&f, &s), CELL_ND2, 1.0)), 0);
    assert!(lit(&cell_img(&render(&f, &s), CELL_ND, 1.0)) > 2000, "the other side stays on");
}

#[test]
fn no_dc_power_means_black_pfd_and_nd() {
    let f = flight();
    let mut s = sys();
    s.dc = false;
    let img = render(&f, &s);
    assert_eq!(lit(&cell_img(&img, CELL_PFD, 1.0)), 0);
    assert_eq!(lit(&cell_img(&img, CELL_ND, 1.0)), 0);
}

#[test]
fn terr_on_nd_adds_terrain_dots_and_label() {
    let f = flight();
    let mut s = sys();
    s.efis[0].nd_mode = 3;
    let a = cell_img(&render(&f, &s), CELL_ND, 1.0);
    s.terr_on_nd[0] = true;
    let b = cell_img(&render(&f, &s), CELL_ND, 1.0);
    assert!(diff(&a, &b) > 10, "TERR label missing");
}
