//! Interactive 3D A320 flight deck driven by the downloaded GLB (reference: `src/sim/cockpit.ts`).
//!
//! The model is the FlightGear A320-family cockpit: ~1,200 named parts in real-world metres, model frame `-X` forward, `+Y` up,
//! `+Z` captain's side. Body frame is `-Z` forward, `+X` right, so `body = (-z_m + tx, y_m + ty, x_m + tz)` with the translation chosen
//! so the model's design eye point lands exactly on `spec.eye` (see [`model_to_body`]).
//!
//! * `Deck::new` classifies every node into a control group (push-button / switch / knob / guard / lever / key / stick) with the same
//!   naming rules as `cockpit.ts`, attaches legends and lamp nodes, and extracts the display screens (`pfd1.screen` ...).
//! * Controls are animated about their original axis (`cockpit-manifest.json`; fallback axis derived from the bounding box).
//! * `pick` casts a camera ray against the controls (AABB + exact triangles, in each control's current pose); `press / drag /
//!   release / wheel` implement the mouse mechanics and drive [`A320Systems`] and the flight model.
//! * `gpu_mesh` bakes everything into one vertex/index buffer sorted by material for the renderer in `gfx/deck.rs`.

use crate::a320sys::{A320Systems, Bright, Efis, NdOpt, ND_MODE_NAMES, ND_RANGES};
use crate::cockpit::{cell_uv, PanelV, CELL_EWD, CELL_MCDU1, CELL_MCDU2, CELL_ND, CELL_ND2, CELL_PFD, CELL_PFD2, CELL_SD};
use crate::ecam::EcpKey;
use crate::fcu::{self, Button as FcuButton, Knob as FcuKnob};
use crate::game::{Action, Flight};
use crate::glb::Glb;
use glam::{Mat4, Vec3};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// Captain's design eye point in model metres.
pub const EYE_M: Vec3 = Vec3::new(0.22, 0.66, 0.52);

/// Model -> aircraft body frame (rotation y = -90 deg + translation so `EYE_M` maps to `eye`).
pub fn model_to_body(eye: [f64; 3]) -> Mat4 {
    let t = Vec3::new(eye[0] as f32 + EYE_M.z, eye[1] as f32 - EYE_M.y, eye[2] as f32 - EYE_M.x);
    // columns: model X -> body +Z, model Y -> body +Y, model Z -> body -X
    Mat4::from_cols(Vec3::Z.extend(0.0), Vec3::Y.extend(0.0), (-Vec3::X).extend(0.0), t.extend(1.0))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Push,
    Switch,
    Knob,
    Guard,
    Lever,
    Key,
    Stick,
}

#[derive(Clone, Copy, Debug)]
pub struct Axis {
    pub pivot: Vec3,
    pub dir: Vec3,
}

pub struct Group {
    pub id: String,
    pub kind: Kind,
    pub parts: Vec<usize>,
    pub axis: Option<Axis>,
    fb: Option<Axis>,
    pub pos: i32,
    /// Click angle of a rotary encoder (rad, clockwise = positive): one detent = `fcu::CLICK_RAD`, never derived from the value.
    pub angle: f32,
    pub press: f32,
    /// Smoothed on-screen rotation of a knob (rad, clockwise as seen by the pilot) - chases `angle` / the state target.
    pub vis: f32,
    /// Smoothed push / pull travel along the panel normal (metres, + = towards the pilot).
    pub slide: f32,
    /// Momentary plunger demand of a push / pull knob while the mouse is down: -1 pushed in, +1 pulled out, 0 at rest.
    pub plunge: f32,
    pub label: String,
    pub steps: i32,
    pub bmin: Vec3,
    pub bmax: Vec3,
    pub lamps: Vec<(usize, char)>,
    pub nrm: Vec3,
    pub xf: Mat4,
    pub ovh: bool,
    pub mom: bool,
    sgn: Option<f32>,
    pub slot: u32,
    tris: Vec<[Vec3; 3]>,
}

struct Lamp {
    mesh: usize,
    base: String,
    leg: Option<char>,
    slot: u32,
}

/// One display screen replaced by the live atlas texture.
pub struct ScreenDef {
    pub node: String,
    pub cell: usize,
    pub center: Vec3,
    pub size: [f32; 2],
}

/// Per-vertex data for the deck renderer.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct DeckV {
    pub pos: [f32; 3],
    pub nrm: [f32; 3],
    pub uv: [f32; 2],
    pub slot: u32,
    pub mat: u32,
}

/// Per-slot GPU state: pose matrix (model -> body), colour multiplier (a = 0 hides) and additive emissive.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Slot {
    pub m: [[f32; 4]; 4],
    pub mul: [f32; 4],
    pub add: [f32; 4],
}

#[derive(Clone, Copy, Debug)]
pub struct Draw {
    pub mat: u32,
    pub first: u32,
    pub count: u32,
}

/// Baked, GPU-ready model.
pub struct GpuMesh {
    pub verts: Vec<DeckV>,
    pub indices: Vec<u32>,
    pub draws: Vec<Draw>,
    pub materials: Vec<crate::glb::Material>,
    pub screen_v: Vec<PanelV>,
    pub screen_i: Vec<u32>,
    pub slot_count: usize,
}

#[derive(Clone, Debug)]
pub struct Hover {
    pub id: String,
    pub label: String,
    pub value: String,
    pub hint: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Hit {
    pub group: usize,
    pub dist: f32,
}

// ------------------------------------------------------------------ naming tables (same as cockpit.ts)
struct Re {
    legend: Regex,
    hide: Regex,
    knob: Regex,
    switch1: Regex,
    guard: Regex,
    guard2: Regex,
    push_btn: Regex,
    push_names: Regex,
    push_audio: Regex,
    push_misc: Regex,
    lever: Regex,
    stick: Regex,
    lamp_name: Regex,
    led1: Regex,
    led2: Regex,
    led_excl: Regex,
    momentary: Regex,
    mcdu_ann: Regex,
    audio_glare: Regex,
    led_base: Regex,
}

fn re() -> &'static Re {
    static R: OnceLock<Re> = OnceLock::new();
    R.get_or_init(|| {
        let r = |s: &str| Regex::new(s).unwrap();
        Re {
            legend: r(r"^(\d)([A-Z])(\.\d+)?$"),
            hide: r(r"(?i)^hud|hud_|\.tmp$|^dummy|glass|^fcu_hud\.plug|ovh_eng_iae|glare_ovh_eng_iae|fcu_labels_hud|^visor_glass|^WindowGlass"),
            knob: r(r"(Knb)$|^(brightness_|pfd_brt|ecam_brt|speaker_volume|lt_knb|flood_lt_main$|flood_lt_ped$|integ_lt$|fcu_integ_knb|light_console|nd_range|nd_mode|radar_(gain|tilt|gcs)|audio_pa_rot|radio_rot)"),
            switch1: r(r"Swtch$|Switch$|^ELTSw$|^pfd_nd_xfr_sw2?$|_sw$|_sw\.(cpt|fo)$|^qnh_(cpt|fo)_sw$|^(land_sw|NoseLtSwtch|trim_?\w*)$"),
            guard: r(r"(Guard|Prot|Cover)(\.\d+)?$"),
            guard2: r(r"^(APUFireCover|Eng[12]FireCover)$"),
            push_btn: r(r"Btn$"),
            push_names: r(r"^(BatteryBtn\d|GreenEngPump2|YellowEngPump|BlueElecPump|YellowElecPump|PTU2|RATMan|EltTestRst|APUExtReset)$"),
            push_audio: r(r"^audio_[a-z0-9_]+\.ovh$"),
            push_misc: r(r"^(OVH_button\.\d+|ecam_\w+|firebtn\w*|PedestalFireBtn\.(cpt|fo)|EmerGenTest(\.\d+)?|Eng[12]FireTst|APUFireTst|CVR\w+|\w+Call|EvacHornOff|EvacCapt-Purs|SEC\dBtn|CargoSmkTest|LeftRainTest|RightRainTest|DLSSys(Next|Prev|SelCtl)Btn|atc_\w+|radio_\w+|audio_\w+|\w+\.(cpt|fo))$"),
            lever: r(r"^(gear_lever|FlapsLever|SpdBrk|ParkBrk|thr_[lr]_body|Lcutoff|Rcutoff|eng_mode)$"),
            stick: r(r"^sidestick_[12]"),
            lamp_name: r(r"(_led|_on|_lit|_glare|_illuminated)(\.\w+)?$|\.mark$|^audio_.*(_led|_glare|_sgn)|^brk_|^ecam_.*_led"),
            led1: r(r"(_led|_on|_lit|_illuminated)(\.\w+)?$"),
            led2: r(r"^(abs_(low|med|max)_on|dec_(low|med|max)_on|master_(warning|caution)_on|autoland_light_on|ecam_emer_canc_lit|EltLed|IrsOnBatLight|brk_(hot|fan)_on|terr_on_nd_on_[lr]|gpws_gs_sw_(gpws|gs)_on)"),
            led_excl: r(r"^radio_on"),
            momentary: r(r"(Test|FireTst)(\.\d+)?$|Call$|^(EmerGenTest|CVRErase|EvacHornOff|DLSSys(Next|Prev|SelCtl)Btn|EltTestRst|RATMan|EmerElecManOnBtn|EmerCallBtn|APUExtReset|IDG[12]Btn|APUFireAgtBtn|Eng[12]FireAgt[12]Btn|FwdCargoDischBtn|AftCargoDischBtn)(\.\d+)?$|^audio_(reset|voice|call_\w+|att|mech)\.ovh$"),
            mcdu_ann: r(r"^mcdu_ann_\w+\.(cpt|fo)$|^engine_(fire|fault)_[12]$|^thr_quad_lts$"),
            audio_glare: r(r"^(audio|radio)_\w+_glare\.(cpt|fo)$"),
            led_base: r(r"^(.*?)_(?:led|lit)(\.cpt|\.fo|\.ovh)?(\.\d+)?$"),
        }
    })
}

const FCU_IND: [&str; 18] = ["spd.ind", "hdg.ind", "alt.ind", "vs.ind", "lvlch.ind", "mach.ind", "trk.ind", "trk2.ind", "fpa.ind", "fpa.ind.001", "vs.ind.001", "hdg2.ind", "spd.dash", "lat.dash", "vs.dash", "ver.fmgc", "lat.fmgc", "spd.fmgc"];
const FCU_TOGGLES: &[&str] = &[
    "ap1", "ap2", "a-thr", "appr", "loc", "exped", "fd1", "fd2", "arpt", "arpt.001", "cstr", "cstr.001", "wpt", "wpt.001", "vord", "vord.001", "ndb", "ndb.001", "ils", "ils2", "hdg-vs", "spd-mach", "metric_alt", "alt-sel-mode", "vor-adf1", "vor-adf2",
    "vor-adf-1-right", "vor-adf-2-right", "master_warning", "master_caution", "chrono_btn", "chrono_reset", "abs_low", "abs_med", "abs_max", "ecam_all", "ecam_clr_l", "ecam_clr_r", "ecam_rcl", "ecam_emer_canc", "ecam_to_config", "gear_lever", "ParkBrk", "rev_l",
    "rev_r", "gravity_gear", "tiller", "tillerFo", "RudderTrim", "RudderTrimReset", "thr_l_button", "thr_r_button", "pfd_nd_xfr_sw", "pfd_nd_xfr_sw2", "terr_on_nd_l", "terr_on_nd_r", "iesi_btn_bugs", "iesi_btn_ls", "iesi_btn_minus", "iesi_btn_plus", "iesi_btn_rst",
    "clock_set", "et_knob", "HeadsetHangerCpt", "extinguisher", "brk_fan", "FuelXFeedBtn",
];
pub const TRIM_WHEEL_RAD: f32 = 3.0;

const KNOB_STEPS: &[(&str, i32)] = &[
    ("ecam_att_hdg", 3), ("ecam_air_data", 3), ("ecam_eis_dmc", 3), ("ecam_nd_xfr", 3),
    ("IR1ModeKnb", 3), ("IR2ModeKnb", 3), ("IR3ModeKnb", 3), ("XbleedKnb", 3), ("eng_mode", 3), ("RudderTrim", 41), ("nd_mode", 5), ("nd_mode_fo", 5), ("nd_range", 6), ("nd_range_fo", 6), ("CockpitACKnb", 12), ("FwdCabinACKnb", 12), ("AftCabinACKnb", 12),
    ("ACFlowKnb", 3), ("LdgElevKnb", 12), ("LeftWiperKnb", 4), ("RightWiperKnb", 4), ("radar_mode", 4), ("radar_sys", 3), ("qnh_cpt_sw", 2), ("qnh_fo_sw", 2), ("alt-sel-mode", 2), ("spd-sel", 40), ("hdg_sel", 40), ("alt-sel", 40), ("vs-sel", 40), ("qnh_cpt_knb", 40),
    ("qnh_fo_knb", 40), ("iesi_baro_knb", 40), ("clock_knob", 3), ("LReadingLtKnb", 12), ("RReadingLtKnb", 12), ("OHPMarkLtKnb", 12),
];
const SWITCH3: &[&str] = &[
    "vor-adf1", "vor-adf2", "vor-adf-1-right", "vor-adf-2-right", "StrobeLtSwtch", "LandingLtSwtch", "LandingLtRSwtch", "NoseLtSwtch", "NavLogoLtSwtch", "SeatBeltSwtch", "NoSmokingSwtch", "EmerExtLtSwtch", "DomeLtSwtch", "TurnoffLtSwtch", "WingLtSwtch",
    "AnnunciatorLtSwtch", "CockpitDoorSwitch", "ManVSCTLSwitch", "DLSSysSwtch",
];
const PUSHPULL: &[&str] = &["spd-sel", "hdg_sel", "alt-sel", "vs-sel", "qnh_cpt_knb", "qnh_fo_knb"];
const RING: &[&str] = &["alt-sel-mode", "qnh_cpt_sw", "qnh_fo_sw"];
const ON_WHEN_IN: &[&str] = &["APUMasterBtn", "APUStartBtn", "ExtPwrBtn", "Eng1ManStartBtn", "Eng2ManStartBtn", "RamAirBtn", "WingAntiIceBtn", "Eng1AntiIceBtn", "Eng2AntiIceBtn", "EmerCallBtn", "EvacCommandBtn", "RcdrGndCtlBtn", "ToiletBtn", "DitchBtn", "MaskManOnBtn"];
pub const GUARD_OF: &[(&str, &str)] = &[
    ("EvacCommandBtn", "EvacCommandProt"), ("DitchBtn", "DitchProt"), ("Eng1ManStartBtn", "Eng1ManStartProt"), ("Eng2ManStartBtn", "Eng2ManStartProt"), ("Eng1N1Btn", "Eng1N1Prot"), ("Eng2N1Btn", "Eng2N1Prot"), ("RamAirBtn", "RamAirBtnProt"), ("RATMan", "RATManGuard"),
    ("EmerElecManOnBtn", "EmerManOnGuard"), ("EmerGenTest", "EmerGenTestGuard"), ("EmerGenTest.002", "EmerGenTestGuard"), ("EmerGenTest.003", "EmerGenTestGuard"), ("MaskManOnBtn", "MaskManOnGuard"), ("AftCargoDischBtn", "AftCargoDischGuard"),
    ("FwdCargoDischBtn", "FwdCargoDischGuard"), ("IDG1Btn", "IDG1Prot"), ("IDG2Btn", "IDG2Prot"), ("BlueElecPump", "BlueElecPumpProt"), ("EmerCallBtn", "EmerCallProt"), ("ELTSw", "ELTSwGuard"), ("firebtn1", "Eng1FireCover"), ("firebtn2", "Eng2FireCover"),
    ("firebtnapu", "APUFireCover"),
];
const AGENT_IDX: &[(&str, usize)] = &[("Eng1FireAgt1Btn", 0), ("Eng1FireAgt2Btn", 1), ("Eng2FireAgt1Btn", 2), ("Eng2FireAgt2Btn", 3), ("APUFireAgtBtn", 4)];
const LEADER: &[(&str, &str)] = &[("thr_l_button", "thr_l_body"), ("thr_r_button", "thr_r_body"), ("rev_l", "thr_l_body"), ("rev_r", "thr_r_body")];
const THR_PIVOT_L: Vec3 = Vec3::new(-0.1097, -0.09, 0.0215);
const THR_PIVOT_R: Vec3 = Vec3::new(-0.1097, -0.09, -0.0215);
pub const THR_DETENTS: [(&str, f64); 4] = [("IDLE", 0.0), ("CL", 25.0 / 45.0), ("FLX/MCT", 35.0 / 45.0), ("TOGA", 1.0)];

pub fn snap_throttle(v: f64, capture: f64) -> f64 {
    for d in THR_DETENTS {
        if (v - d.1).abs() < capture {
            return d.1;
        }
    }
    v.clamp(0.0, 1.0)
}

pub fn thr_detent_name(v: f64, reverse: bool) -> String {
    if reverse {
        return "REV".into();
    }
    for d in THR_DETENTS {
        if (v - d.1).abs() < 0.045 {
            return d.0.into();
        }
    }
    let tla = (v * 45.0).round();
    if v < 25.0 / 45.0 {
        format!("IDLE-CL TLA {tla}")
    } else if v < 35.0 / 45.0 {
        format!("CL-FLX/MCT TLA {tla}")
    } else {
        format!("FLX/MCT-TOGA TLA {tla}")
    }
}

fn step_detent(v: f64, d: f64) -> f64 {
    let n = v + d;
    for t in THR_DETENTS {
        if (v - t.1) * (n - t.1) < 0.0 {
            return t.1;
        }
    }
    snap_throttle(n, 0.012)
}

pub fn prettify(n: &str) -> String {
    let mut s = n.to_string();
    for suf in ["Btn", "Knb", "Swtch", "Switch"] {
        if let Some(x) = s.strip_suffix(suf) {
            s = x.to_string();
            break;
        }
    }
    if let Some(x) = s.strip_suffix(".cpt") {
        s = format!("{x} (CAPT)");
    } else if let Some(x) = s.strip_suffix(".fo") {
        s = format!("{x} (F/O)");
    }
    let mut out = String::new();
    let mut prev: Option<char> = None;
    for c in s.chars() {
        let c = if c == '_' || c == '-' { ' ' } else { c };
        if let Some(p) = prev {
            if p.is_ascii_lowercase() && (c.is_ascii_uppercase() || c.is_ascii_digit()) {
                out.push(' ');
            }
        }
        out.push(c);
        prev = Some(c);
    }
    out.to_uppercase()
}

fn guard_of(id: &str) -> Option<&'static str> {
    GUARD_OF.iter().find(|g| g.0 == id).map(|g| g.1)
}

fn ray_tri(o: Vec3, d: Vec3, t: &[Vec3; 3]) -> Option<f32> {
    let (e1, e2) = (t[1] - t[0], t[2] - t[0]);
    let p = d.cross(e2);
    let det = e1.dot(p);
    if det.abs() < 1e-12 {
        return None;
    }
    let inv = 1.0 / det;
    let s = o - t[0];
    let u = s.dot(p) * inv;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = s.cross(e1);
    let v = d.dot(q) * inv;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let dist = e2.dot(q) * inv;
    (dist > 1e-5).then_some(dist)
}

fn ray_box(o: Vec3, d: Vec3, mn: Vec3, mx: Vec3) -> bool {
    let (mut t0, mut t1) = (0.0f32, f32::INFINITY);
    for k in 0..3 {
        if d[k].abs() < 1e-9 {
            if o[k] < mn[k] || o[k] > mx[k] {
                return false;
            }
        } else {
            let (a, b) = ((mn[k] - o[k]) / d[k], (mx[k] - o[k]) / d[k]);
            t0 = t0.max(a.min(b));
            t1 = t1.min(a.max(b));
            if t0 > t1 {
                return false;
            }
        }
    }
    true
}

fn rot_about(pivot: Vec3, axis: Vec3, th: f32) -> Mat4 {
    let a = axis.normalize_or(Vec3::Z);
    Mat4::from_translation(pivot) * Mat4::from_axis_angle(a, th) * Mat4::from_translation(-pivot)
}

#[derive(Clone, Copy, Default)]
struct Active {
    group: usize,
    sy: f32,
    acc: f32,
    v0: f64,
    kind: u8, // 0 push, 1 knob, 2 lever, 3 hold
}

pub struct Deck {
    pub glb: Glb,
    pub groups: Vec<Group>,
    pub by_id: HashMap<String, usize>,
    mesh_group: Vec<Option<usize>>,
    hidden: Vec<bool>,
    lamps: Vec<Lamp>,
    pub screens: Vec<ScreenDef>,
    screen_mesh: HashMap<usize, usize>,
    pub to_body: Mat4,
    from_body: Mat4,
    active: Option<Active>,
    pub ecam_page: Option<&'static str>,
    pub efb_power: bool,
    mst_sm: [f32; 2],
    rud_sm: f32,
    pub ecp_hold: bool,
}

fn screen_cell(n: &str) -> Option<usize> {
    Some(match n {
        "pfd1.screen" | "PFD.screen" => CELL_PFD,
        "pfd2.screen" | "PFD_R.screen" => CELL_PFD2,
        "ND.screen" => CELL_ND,
        "ND_R.screen" => CELL_ND2,
        "uecam.screen" | "uecam.screen2" | "ECAM1.screen" => CELL_EWD,
        "lecam.screen" | "ECAM2.screen" => CELL_SD,
        "MCDU.screen" | "mcdu_screen_cpt" | "mcdu1.screen" => CELL_MCDU1,
        "mcdu_screen_fo" | "mcdu2.screen" => CELL_MCDU2,
        _ => return None,
    })
}

impl Deck {
    pub fn new(glb: Glb, manifest: Option<&[u8]>, eye: [f64; 3]) -> Self {
        let r = re();
        let mut axes: HashMap<String, Axis> = HashMap::new();
        if let Some(v) = manifest.and_then(|m| serde_json::from_slice::<serde_json::Value>(m).ok()) {
            if let Some(o) = v["axes"].as_object() {
                for (k, a) in o {
                    let g = |x: &serde_json::Value| Vec3::new(x[0].as_f64().unwrap_or(0.0) as f32, x[1].as_f64().unwrap_or(0.0) as f32, x[2].as_f64().unwrap_or(0.0) as f32);
                    axes.insert(k.trim_end_matches(".axis").to_string(), Axis { pivot: g(&a["pivot"]), dir: g(&a["direction"]) });
                }
            }
        }
        let n = glb.meshes.len();
        let names: HashMap<&str, usize> = glb.meshes.iter().enumerate().map(|(i, m)| (m.name.as_str(), i)).collect();
        let mut used = vec![false; n];
        let mut hidden = vec![false; n];
        let mut lamps: Vec<Lamp> = Vec::new();
        let mut screens = Vec::new();
        let mut screen_mesh = HashMap::new();
        let mut groups: Vec<Group> = Vec::new();
        let mut by_id: HashMap<String, usize> = HashMap::new();
        let mut mesh_group: Vec<Option<usize>> = vec![None; n];
        let efb_skip = |s: &str| s.starts_with("EFB_");

        let base_of_legend = |name: &str| -> Option<(String, char)> {
            let len = name.len();
            if len < 4 {
                return None;
            }
            for k in (3..=len - 2).rev() {
                if !name.is_char_boundary(k) {
                    continue;
                }
                let b = &name[..k];
                if names.contains_key(b) && r.legend.is_match(&name[k..]) {
                    return Some((b.to_string(), name.as_bytes()[k + 1] as char));
                }
            }
            None
        };
        let is_led = |s: &str| (r.led1.is_match(s) && !r.led_excl.is_match(s) && !s.trim_start_matches("abs_").trim_start_matches("dec_").ends_with("_on")) || r.led2.is_match(s);

        // pass 1: hidden / lamp / screen nodes
        for (i, m) in glb.meshes.iter().enumerate() {
            let nm = m.name.as_str();
            if r.hide.is_match(nm) {
                hidden[i] = true;
                used[i] = true;
                continue;
            }
            if let Some(c) = screen_cell(nm) {
                let _ = c;
                continue;
            }
            if FCU_IND.contains(&nm) {
                used[i] = true;
                // legends (SPD / MACH, HDG / TRK, V/S / FPA, LVL/CH) and the managed dots are lit by the FCU state
                // (`updateFcuInd` in cockpit.ts); the digit meshes, `alt.ind` and the dashes stay hidden (drawn as text)
                if fcu::legend_lit(nm, &fcu::FcuDisplay { on: true, ..Default::default() }).is_some() && !matches!(nm, "alt.ind" | "spd.dash" | "lat.dash" | "vs.dash") {
                    lamps.push(Lamp { mesh: i, base: format!("fcu:{nm}"), leg: None, slot: 0 });
                } else {
                    hidden[i] = true;
                }
                continue;
            }
            if r.mcdu_ann.is_match(nm) {
                lamps.push(Lamp { mesh: i, base: nm.to_string(), leg: None, slot: 0 });
                used[i] = true;
                continue;
            }
            if r.audio_glare.is_match(nm) {
                lamps.push(Lamp { mesh: i, base: nm.replacen("_glare", "", 1), leg: None, slot: 0 });
                used[i] = true;
                continue;
            }
            if let Some((b, l)) = base_of_legend(nm) {
                lamps.push(Lamp { mesh: i, base: b, leg: Some(l), slot: 0 });
                used[i] = true;
                continue;
            }
            let lb = r.led_base.captures(nm);
            if lb.is_some() || is_led(nm) {
                let base = match &lb {
                    Some(c) => {
                        let b = c.get(1).unwrap().as_str();
                        let suffix = match c.get(2) {
                            Some(s) => s.as_str().to_string(),
                            None => {
                                if matches!(b, "arpt" | "cstr" | "wpt" | "vord" | "ndb") {
                                    c.get(3).map(|s| s.as_str().to_string()).unwrap_or_default()
                                } else {
                                    String::new()
                                }
                            }
                        };
                        format!("{b}{suffix}")
                    }
                    None => r.led1.replace(nm, "").to_string(),
                };
                lamps.push(Lamp { mesh: i, base, leg: None, slot: 0 });
                used[i] = true;
            }
        }
        // pass 2: control groups
        let mk = |groups: &mut Vec<Group>, by_id: &mut HashMap<String, usize>, id: &str, kind: Kind| -> usize {
            if let Some(&g) = by_id.get(id) {
                return g;
            }
            let steps = KNOB_STEPS.iter().find(|k| k.0 == id).map(|k| k.1).unwrap_or(12);
            groups.push(Group {
                id: id.to_string(),
                kind,
                parts: vec![],
                axis: axes.get(id).copied(),
                fb: None,
                pos: 0,
                angle: 0.0,
                press: 0.0,
                vis: f32::NAN,
                slide: 0.0,
                plunge: 0.0,
                label: prettify(id),
                steps,
                bmin: Vec3::splat(f32::MAX),
                bmax: Vec3::splat(f32::MIN),
                lamps: vec![],
                nrm: Vec3::Y,
                xf: Mat4::IDENTITY,
                ovh: false,
                mom: false,
                sgn: None,
                slot: 0,
                tris: vec![],
            });
            by_id.insert(id.to_string(), groups.len() - 1);
            groups.len() - 1
        };
        for (i, m) in glb.meshes.iter().enumerate() {
            let nm = m.name.as_str();
            if used[i] || screen_cell(nm).is_some() || efb_skip(nm) {
                continue;
            }
            let key = nm.strip_suffix(".cpt").or_else(|| nm.strip_suffix(".fo")).or_else(|| nm.strip_suffix(".ovh")).unwrap_or(nm);
            let fo = nm.ends_with(".fo");
            let mut kind: Option<Kind> = None;
            let mut id = nm.to_string();
            let is_mcdu_key = (nm.ends_with(".cpt") || nm.ends_with(".fo")) && is_mcdu_key(key);
            if nm.starts_with("audio_int_rad.mark.") {
                let side = nm.rsplit('.').next().unwrap_or("cpt");
                let g = mk(&mut groups, &mut by_id, &format!("audio_int_rad.{side}"), Kind::Switch);
                groups[g].parts.push(i);
                mesh_group[i] = Some(g);
                continue;
            }
            if (nm.ends_with(".mark") || nm.ends_with(".mark.ovh")) && names.contains_key(nm.replacen(".mark", "", 1).as_str()) {
                let g = mk(&mut groups, &mut by_id, &nm.replacen(".mark", "", 1), Kind::Knob);
                groups[g].parts.push(i);
                mesh_group[i] = Some(g);
                continue;
            }
            if is_mcdu_key {
                kind = Some(Kind::Key);
                id = format!("{}:{}", if fo { "F" } else { "C" }, key);
            } else if r.knob.is_match(nm) || KNOB_STEPS.iter().any(|k| k.0 == nm) {
                kind = Some(Kind::Knob);
            } else if r.switch1.is_match(nm) || SWITCH3.contains(&nm) {
                kind = Some(Kind::Switch);
            } else if r.guard.is_match(nm) || r.guard2.is_match(nm) {
                kind = Some(Kind::Guard);
            } else if r.push_btn.is_match(nm)
                || r.push_names.is_match(nm)
                || (r.push_audio.is_match(nm) && !["_glare.", "_led.", "_sgn.", "_rot.", ".mark.", "_int_rad."].iter().any(|x| nm.contains(x)))
                || (r.push_misc.is_match(nm) && !(nm.starts_with("ecam_") && (nm.ends_with("_led") || nm.ends_with("_lit"))))
                || FCU_TOGGLES.contains(&nm)
                || matches!(nm, "spd-sel" | "hdg_sel" | "alt-sel" | "vs-sel")
            {
                kind = Some(Kind::Push);
            } else if r.lever.is_match(nm) {
                kind = Some(Kind::Lever);
            } else if r.stick.is_match(nm) {
                kind = Some(Kind::Stick);
                id = "stick".into();
            }
            if r.lamp_name.is_match(nm) {
                kind = if kind == Some(Kind::Knob) { kind } else { None };
            }
            if r.led_excl.is_match(nm) && nm.ends_with(".cpt") || nm.starts_with("radio_on.") || matches!(nm, "radar_multiscan" | "radar_pws" | "CockpitDoorVideoButton") {
                kind = Some(Kind::Push);
            }
            if nm == "audio_int_rad.cpt" || nm == "audio_int_rad.fo" {
                kind = Some(Kind::Switch);
            }
            let Some(kind) = kind else { continue };
            if kind == Kind::Lever && nm == "FlapsLever_low" {
                continue;
            }
            let g = mk(&mut groups, &mut by_id, &id, kind);
            groups[g].parts.push(i);
            mesh_group[i] = Some(g);
        }
        // group boxes + triangles (rest pose)
        for g in groups.iter_mut() {
            for &pi in &g.parts {
                let m = &glb.meshes[pi];
                for p in &m.pos {
                    g.bmin = g.bmin.min(Vec3::from(*p));
                    g.bmax = g.bmax.max(Vec3::from(*p));
                }
                for t in m.idx.chunks_exact(3) {
                    g.tris.push([Vec3::from(m.pos[t[0] as usize]), Vec3::from(m.pos[t[1] as usize]), Vec3::from(m.pos[t[2] as usize])]);
                }
            }
            let c = (g.bmin + g.bmax) * 0.5;
            g.nrm = if g.kind == Kind::Key { MCDU_KEY_NORMAL.normalize() } else { panel_normal(c) };
            g.ovh = c.y > 0.78 && c.x > -0.3;
            g.mom = r.momentary.is_match(&g.id) || momentary_extra(&g.id);
            g.pos = match g.id.as_str() {
                "qnh_cpt_sw" | "qnh_fo_sw" | "vor-adf1" | "vor-adf2" | "vor-adf-1-right" | "vor-adf-2-right" | "audio_int_rad.cpt" | "audio_int_rad.fo" => 1,
                "nd_mode" | "nd_mode_fo" | "nd_range" | "nd_range_fo" => 3,
                _ => 0,
            };
            if g.id == "eng_mode" {
                g.pos = 1;
            }
        }
        // attach legends / lamps
        for (li, l) in lamps.iter().enumerate() {
            if let Some(&gi) = by_id.get(&l.base) {
                if let Some(c) = l.leg {
                    groups[gi].lamps.push((li, c));
                }
            }
        }
        // slots: 0 = static, 1.. = groups, then lamps
        for (i, g) in groups.iter_mut().enumerate() {
            g.slot = 1 + i as u32;
        }
        let base = 1 + groups.len() as u32;
        for (i, l) in lamps.iter_mut().enumerate() {
            l.slot = base + i as u32;
        }
        // screens
        let to_body = model_to_body(eye);
        for (i, m) in glb.meshes.iter().enumerate() {
            if let Some(cell) = screen_cell(&m.name) {
                if m.pos.is_empty() {
                    continue;
                }
                let (mut mn, mut mx) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
                for p in &m.pos {
                    mn = mn.min(Vec3::from(*p));
                    mx = mx.max(Vec3::from(*p));
                }
                screen_mesh.insert(i, screens.len());
                screens.push(ScreenDef { node: m.name.clone(), cell, center: (mn + mx) * 0.5, size: [0.0, 0.0] });
            }
        }
        let mut d = Deck {
            glb,
            groups,
            by_id,
            mesh_group,
            hidden,
            lamps,
            screens,
            screen_mesh,
            from_body: to_body.inverse(),
            to_body,
            active: None,
            ecam_page: None,
            efb_power: true,
            mst_sm: [0.0; 2],
            rud_sm: 0.0,
            ecp_hold: false,
        };
        for g in 0..d.groups.len() {
            d.groups[g].xf = Mat4::IDENTITY;
        }
        d
    }

    pub fn group(&self, id: &str) -> Option<&Group> {
        self.by_id.get(id).map(|&i| &self.groups[i])
    }

    /// Lamp / legend node lookup (tests + diagnostics): lit state of lamp `base` (`"ap1"`, `"fcu:spd.ind"` ...), `None` if the model has no such lamp.
    pub fn lamp_lit(&self, base: &str, s: &A320Systems, f: &Flight) -> Option<bool> {
        self.lamps.iter().any(|l| l.base == base).then(|| self.led_lit(base, s, f).0)
    }

    /// GPU slot index of the first lamp node called `base` (index into the vector filled by [`Deck::slots`]).
    pub fn lamp_slot(&self, base: &str) -> Option<usize> {
        self.lamps.iter().find(|l| l.base == base).map(|l| l.slot as usize)
    }

    /// Mechanical axis (pivot, direction) used to pose control `id` - the manifest axis or the derived fallback.
    pub fn pose_axis(&mut self, id: &str) -> Option<(Vec3, Vec3)> {
        let gi = *self.by_id.get(id)?;
        let a = self.axis_of(gi);
        Some((a.pivot, a.dir))
    }

    pub fn kind_counts(&self) -> HashMap<Kind, usize> {
        let mut m = HashMap::new();
        for g in &self.groups {
            *m.entry(g.kind).or_insert(0) += 1;
        }
        m
    }

    // ------------------------------------------------------------------ axes / poses
    fn axis_of(&mut self, gi: usize) -> Axis {
        let g = &self.groups[gi];
        if let Some(a) = g.axis.or(g.fb) {
            return a;
        }
        let c = (g.bmin + g.bmax) * 0.5;
        // the F/O ADF-OFF-VOR levers have no manifest axis: they swing about the captain's lever axis at their own z
        let twin = match g.id.as_str() {
            "vor-adf-1-right" => Some("vor-adf1"),
            "vor-adf-2-right" => Some("vor-adf2"),
            _ => None,
        };
        if let Some(src) = twin.and_then(|t| self.by_id.get(t)).and_then(|&i| self.groups[i].axis) {
            let a = Axis { pivot: Vec3::new(src.pivot.x, src.pivot.y, c.z), dir: src.dir };
            self.groups[gi].fb = Some(a);
            return a;
        }
        let sz = g.bmax - g.bmin;
        let n = g.nrm;
        let half = 0.5 * (n.x.abs() * sz.x + n.y.abs() * sz.y + n.z.abs() * sz.z);
        let (mut d, mut p) = (n, c);
        if g.kind == Kind::Switch || g.kind == Kind::Guard {
            d = n.cross(Vec3::Y);
            if d.length_squared() < 1e-4 {
                d = Vec3::Z;
            }
            d = d.normalize();
            p -= n * half;
        }
        let a = Axis { pivot: p, dir: d };
        self.groups[gi].fb = Some(a);
        a
    }

    fn lever_sign(&mut self, gi: usize) -> f32 {
        if let Some(s) = self.groups[gi].sgn {
            return s;
        }
        let c = (self.groups[gi].bmin + self.groups[gi].bmax) * 0.5;
        if !(c.y > 0.78 && c.x > -0.3) {
            self.groups[gi].sgn = Some(1.0);
            return 1.0;
        }
        let ax = self.axis_of(gi);
        let fwd = ax.dir.normalize_or(Vec3::Z).cross(c - ax.pivot).x;
        let s = if fwd > 1e-6 { 1.0 } else { -1.0 };
        self.groups[gi].sgn = Some(s);
        s
    }

    // ------------------------------------------------------------------ state helpers
    fn state_on(&self, id: &str, s: &A320Systems, f: &Flight) -> bool {
        match id {
            "BatteryBtn1" => s.bat[0],
            "BatteryBtn2" => s.bat[1],
            "ExtPwrBtn" => s.ext,
            "APUMasterBtn" => s.apu_master,
            "APUStartBtn" => s.apu_start || s.apu_rpm >= 95.0,
            "APUGenBtn" => s.apu_gen,
            "APUBleedBtn" => s.apu_bleed,
            "Gen1Btn" => s.gen[0],
            "Gen2Btn" => s.gen[1],
            "Eng1BleedBtn" => s.eng_bleed[0],
            "Eng2BleedBtn" => s.eng_bleed[1],
            "ACPack1Btn" => s.packs[0],
            "ACPack2Btn" => s.packs[1],
            "WingAntiIceBtn" => s.wing_ai,
            "Eng1AntiIceBtn" => s.eng_ai[0],
            "Eng2AntiIceBtn" => s.eng_ai[1],
            "LFuelTank1Btn" => s.pumps[0],
            "LFuelTank2Btn" => s.pumps[1],
            "CFuelTank1Btn" => s.pumps[2],
            "CFuelTank2Btn" => s.pumps[3],
            "RFuelTank1Btn" => s.pumps[4],
            "RFuelTank2Btn" => s.pumps[5],
            "FuelXFeedBtn" => s.xfeed,
            "GreenEngPump2" => s.hyd_green_pump,
            "YellowEngPump" => s.hyd_yellow_pump,
            "BlueElecPump" => s.hyd_blue_pump,
            "YellowElecPump" => s.hyd_yelec_pump,
            "PTU2" => s.ptu,
            "RATMan" => s.rat_out,
            "ap1" => s.ap_eng[0] && f.ap.on,
            "ap2" => s.ap_eng[1] && f.ap.on,
            "a-thr" => s.athr_armed,
            "appr" => f.ap.appr,
            "loc" => s.loc_armed,
            "exped" => s.exped,
            "hdg-vs" | "trk-fpa" => s.trk_fpa,
            "spd-mach" => s.spd_mach,
            "metric_alt" => s.metric,
            "fd1" => s.efis[0].fd,
            "fd2" => s.efis[1].fd,
            "ils" => s.efis[0].ls,
            "ils2" => s.efis[1].ls,
            "abs_low" => f.fm.ctl.autobrake == 1,
            "abs_med" => f.fm.ctl.autobrake == 2,
            "abs_max" => f.fm.ctl.autobrake == 3,
            "cstr" => s.efis[0].opt == Some(NdOpt::Cstr),
            "cstr.001" => s.efis[1].opt == Some(NdOpt::Cstr),
            "wpt" => s.efis[0].opt == Some(NdOpt::Wpt),
            "wpt.001" => s.efis[1].opt == Some(NdOpt::Wpt),
            "vord" => s.efis[0].opt == Some(NdOpt::Vord),
            "vord.001" => s.efis[1].opt == Some(NdOpt::Vord),
            "ndb" => s.efis[0].opt == Some(NdOpt::Ndb),
            "ndb.001" => s.efis[1].opt == Some(NdOpt::Ndb),
            "arpt" => s.efis[0].opt == Some(NdOpt::Arpt),
            "arpt.001" => s.efis[1].opt == Some(NdOpt::Arpt),
            "terr_on_nd_l" => s.terr_on_nd[0],
            "terr_on_nd_r" => s.terr_on_nd[1],
            "pfd_nd_xfr_sw" => s.efis[0].xfr,
            "pfd_nd_xfr_sw2" => s.efis[1].xfr,
            "chrono_btn" => s.chrono_run,
            "Lcutoff" => s.master[0],
            "Rcutoff" => s.master[1],
            "ELTSw" => s.elt,
            _ => self.group(id).map(|g| g.pos != 0).unwrap_or(false),
        }
    }

    pub fn state_text(&self, gi: usize, s: &A320Systems, f: &Flight) -> String {
        let g = &self.groups[gi];
        let ctl = &f.fm.ctl;
        let id = g.id.as_str();
        if let Some((side, func)) = efis_fn(id) {
            return efis_text(func, side, s);
        }
        if let Some(v) = brightness_of(id, s) {
            return if !s.du_on(v) { "OFF".into() } else { format!("BRT {}%", (v * 100.0).round()) };
        }
        if g.kind == Kind::Key {
            let m = &s.mcdu[(id.starts_with("F:")) as usize];
            return if !m.powered { "MCDU OFF".into() } else { format!("{}  [{}]", m.page.title(), m.scratch) };
        }
        if crate::ecp::is_key(id) {
            return if s.ecp.lit(id) { "SELECTED (lit)" } else { "released" }.into();
        }
        match id {
            "BatteryBtn1" => return if s.bat[0] { "AUTO" } else { "OFF" }.into(),
            "BatteryBtn2" => return if s.bat[1] { "AUTO" } else { "OFF" }.into(),
            "APUMasterBtn" => return if s.apu_master { "ON" } else { "OFF" }.into(),
            "APUStartBtn" => return if s.apu_rpm >= 95.0 { "AVAIL".into() } else if s.apu_start { format!("START {}%", s.apu_rpm.round()) } else { "OFF".into() },
            "Lcutoff" => return if f.fm.eng[0].state == crate::physics::EngState::Running { "ON - RUNNING" } else if s.master[0] { "ON" } else { "OFF" }.into(),
            "Rcutoff" => return if f.fm.eng[1].state == crate::physics::EngState::Running { "ON - RUNNING" } else if s.master[1] { "ON" } else { "OFF" }.into(),
            "RudderTrim" => {
                let u = (ctl.rud_trim * 20.0).round() as i32;
                return if u == 0 { "NEUTRAL".into() } else { format!("{} {}", u.abs(), if u < 0 { "L" } else { "R" }) };
            }
            "eng_mode" => return ["CRANK", "NORM", "IGN/START"][s.eng_mode as usize].into(),
            "FlapsLever" => return format!("CONF {}", ["0", "1", "2", "3", "FULL"][ctl.flaps_idx.min(4)]),
            "rev_l" | "rev_r" => return if ctl.reverse { "REV DEPLOYED" } else { "STOWED" }.into(),
            "gear_lever" => return if ctl.gear_down { "DOWN" } else { "UP" }.into(),
            "ParkBrk" => return if ctl.parking { "ON" } else { "OFF" }.into(),
            "spd-sel" | "hdg_sel" | "alt-sel" | "vs-sel" => {
                let d = fcu::display(f, s);
                let managed = |m: bool| if m { "MANAGED (push)" } else { "SELECTED (pull)" };
                return match id {
                    "spd-sel" => format!("{}{} - {}", d.spd, if d.mach { " M" } else { " kt" }, managed(s.spd_managed)),
                    "hdg_sel" => format!("{}{} - {}", d.hdg, if d.trk { " TRK" } else { " deg" }, managed(s.hdg_managed)),
                    "alt-sel" => format!("{} ft - {} - step {}", d.alt, managed(s.alt_managed), if s.alt_step_1000 { "1000" } else { "100" }),
                    _ => format!("{}{} - {}", d.vs, if d.fpa { " deg" } else { " fpm" }, if s.vs_mode { "V/S ENGAGED" } else { "LEVEL CH / HOLD" }),
                };
            }
            "alt-sel-mode" => return if s.alt_step_1000 { "1000 ft per click" } else { "100 ft per click" }.into(),
            "ap1" => return if s.ap_eng[0] && f.ap.on { "ENGAGED" } else { "OFF" }.into(),
            "ap2" => return if s.ap_eng[1] && f.ap.on { "ENGAGED" } else { "OFF" }.into(),
            "a-thr" => return if s.athr_armed || f.ap.on { "ARMED / ACTIVE" } else { "OFF" }.into(),
            "loc" => return if s.loc_armed { "ARMED" } else { "OFF" }.into(),
            "exped" => return if s.exped { "ENGAGED" } else { "OFF" }.into(),
            "hdg-vs" | "trk-fpa" => return if s.trk_fpa { "TRK / FPA" } else { "HDG / V/S" }.into(),
            "spd-mach" => return if s.spd_mach { "MACH" } else { "SPD" }.into(),
            "metric_alt" => return if s.metric { "METRIC ON" } else { "OFF" }.into(),
            "appr" => return if f.ap.appr { "ARMED" } else { "OFF" }.into(),
            "thr_l_body" => return thr_detent_name(ctl.throttle, ctl.reverse),
            "thr_r_body" => return thr_detent_name((ctl.throttle + ctl.thr_offset).clamp(0.0, 1.0), ctl.reverse),
            "SpdBrk" => return if ctl.spoilers_armed { "ARMED".into() } else { format!("{}%", (ctl.speedbrake * 100.0).round()) },
            "abs_low" => return if ctl.autobrake == 1 { "ON" } else { "OFF" }.into(),
            "abs_med" => return if ctl.autobrake == 2 { "ON" } else { "OFF" }.into(),
            "abs_max" => return if ctl.autobrake == 3 { "ON" } else { "OFF" }.into(),
            "iesi_baro_knb" => return if s.isis_std { "STD".into() } else { format!("{} hPa", s.isis_hpa) },
            "BeaconLtSwtch" => return if s.lights.beacon { "ON" } else { "OFF" }.into(),
            "SeatBeltSwtch" => return if s.lights.seatbelt { "ON" } else { "OFF" }.into(),
            "nd_mode" | "nd_mode_fo" => return ND_MODE_NAMES[s.efis[(id == "nd_mode_fo") as usize].nd_mode.min(4)].into(),
            "nd_range" | "nd_range_fo" => return format!("{} NM", ND_RANGES[s.efis[(id == "nd_range_fo") as usize].nd_range.min(5)]),
            "qnh_cpt_knb" | "qnh_fo_knb" => {
                let e = &s.efis[(id == "qnh_fo_knb") as usize];
                return if e.std { "STD".into() } else if e.unit_in_hg { format!("{:.2} inHg", e.in_hg as f64 / 100.0) } else { format!("{} hPa", e.hpa) };
            }
            _ => {}
        }
        if g.kind == Kind::Key {
            return String::new();
        }
        if let Some(&(_, a)) = AGENT_IDX.iter().find(|x| x.0 == id) {
            let fire = if a == 4 { 2 } else { a >> 1 };
            return if s.agent_disch[a] { "DISCHARGED" } else if s.fire_out[fire] { "ARMED" } else { "SAFE" }.into();
        }
        if let Some(labels) = switch_labels(id) {
            return labels.get(g.pos as usize).copied().unwrap_or("").to_string();
        }
        if g.ovh {
            return if g.mom { "MOMENTARY" } else if self.state_on(id, s, f) { "ON / AUTO - pushed in" } else { "OFF - released" }.into();
        }
        match g.kind {
            Kind::Switch => if SWITCH3.contains(&id) { ["OFF / LOW", "AUTO / MID", "ON / HIGH"].get(g.pos as usize).copied().unwrap_or("").to_string() } else if g.pos != 0 { "ON".into() } else { "OFF".into() },
            Kind::Guard => if g.pos != 0 { "OPEN" } else { "CLOSED" }.into(),
            Kind::Knob => format!("position {}", g.pos + 1),
            _ => if self.state_on(id, s, f) { "ON / ENGAGED" } else { "OFF / NORMAL" }.into(),
        }
    }

    pub fn hint(&self, gi: usize) -> &'static str {
        let g = &self.groups[gi];
        if let Some((_, func)) = efis_fn(&g.id) {
            let t = efis_hint(func);
            if !t.is_empty() {
                return t;
            }
        }
        match EcpKey::from_id(&g.id) {
            Some(EcpKey::All) => return "Hold: SD steps through all pages (1 page / s)",
            Some(EcpKey::Rcl) => return "Click: recall - hold 3 s: recall EMER CANC cautions",
            Some(EcpKey::Page(_)) => return "Click to show - click the lit key again for automatic",
            Some(_) => return "Click to press",
            None => {}
        }
        if g.id.starts_with("ecam_brt_") {
            return "Wheel / drag to turn - fully anticlockwise = OFF";
        }
        if is_src_knob(&g.id) {
            return "Click / wheel: CAPT 3 - NORM - F/O 3 (right-click = back)";
        }
        match g.id.as_str() {
            "spd-sel" | "hdg_sel" | "alt-sel" | "vs-sel" => return "Wheel / drag = turn - click = PUSH (managed) - right-click / Shift+click = PULL (selected) - Shift = coarse",
            "alt-sel-mode" => return "Click or wheel = ALT step 100 / 1000 ft",
            "qnh_cpt_knb" | "qnh_fo_knb" => return "Wheel / drag = set pressure - click = PUSH (QNH) - right-click / Shift+click = PULL (STD)",
            "qnh_cpt_sw" | "qnh_fo_sw" => return "Click or wheel = hPa / inHg",
            "nd_mode" | "nd_mode_fo" | "nd_range" | "nd_range_fo" => return "Wheel / drag to rotate - click = next - right-click = previous",
            "vor-adf1" | "vor-adf2" | "vor-adf-1-right" | "vor-adf-2-right" => return "Click: OFF - VOR - ADF - OFF - right-click reverses",
            _ => {}
        }
        match g.kind {
            Kind::Knob => "Wheel / drag to turn - click = push - right-click = pull",
            Kind::Lever => "Drag or wheel to move - detents snap",
            Kind::Stick => "Use W/A/S/D to fly",
            Kind::Key => "Click to press",
            _ if PUSHPULL.contains(&g.id.as_str()) => "Wheel / drag to turn - click = push - right-click = pull",
            _ => "Click to operate (right-click / Shift = reverse)",
        }
    }

    pub fn hover_info(&self, hit: &Hit, s: &A320Systems, f: &Flight) -> Hover {
        let g = &self.groups[hit.group];
        Hover { id: g.id.clone(), label: g.label.clone(), value: self.state_text(hit.group, s, f), hint: self.hint(hit.group).to_string() }
    }

    // ------------------------------------------------------------------ picking
    /// Camera ray in the aircraft body frame -> nearest control. A lifted guard lets the click through to the button below it.
    pub fn pick(&self, o_body: Vec3, d_body: Vec3) -> Option<Hit> {
        let o_m = self.from_body.transform_point3(o_body);
        let d_m = self.from_body.transform_vector3(d_body).normalize_or(Vec3::NEG_X);
        let mut hits: Vec<Hit> = Vec::new();
        for (gi, g) in self.groups.iter().enumerate() {
            if g.tris.is_empty() {
                continue;
            }
            let inv = g.xf.inverse();
            let (o, d) = (inv.transform_point3(o_m), inv.transform_vector3(d_m));
            let pad = Vec3::splat(0.003);
            if !ray_box(o, d, g.bmin - pad, g.bmax + pad) {
                continue;
            }
            let mut best = f32::INFINITY;
            for t in &g.tris {
                if let Some(h) = ray_tri(o, d, t) {
                    best = best.min(h);
                } else if let Some(h) = ray_tri(o, d, &[t[0], t[2], t[1]]) {
                    best = best.min(h);
                }
            }
            if best.is_finite() {
                hits.push(Hit { group: gi, dist: best });
            }
        }
        hits.sort_by(|a, b| a.dist.total_cmp(&b.dist));
        for i in 0..hits.len() {
            let g = &self.groups[hits[i].group];
            if g.kind == Kind::Guard && g.pos != 0 {
                for j in i + 1..hits.len() {
                    let b = &self.groups[hits[j].group];
                    if guard_of(&b.id) == Some(g.id.as_str()) {
                        return Some(hits[j].clone());
                    }
                }
            }
            return Some(hits[i].clone());
        }
        None
    }

    // ------------------------------------------------------------------ mouse mechanics
    /// Pointer down. Returns the pressed control id (None when nothing was hit).
    pub fn press(&mut self, hit: &Hit, button: u8, shift: bool, f: &mut Flight, s: &mut A320Systems) -> Option<String> {
        let gi = hit.group;
        let id = self.groups[gi].id.clone();
        let kind = self.groups[gi].kind;
        if kind == Kind::Stick {
            return Some(id);
        }
        if let Some(cover) = guard_of(&id).and_then(|c| self.by_id.get(c).copied()) {
            if self.groups[cover].pos == 0 {
                self.set_guard(cover, 1);
                self.groups[cover].press = 1.0;
                self.active = Some(Active { group: cover, kind: 0, ..Default::default() });
                return Some(self.groups[cover].id.clone());
            }
        }
        match id.as_str() {
            "gear_lever" => f.apply(Action::ToggleGear),
            "ParkBrk" => f.apply(Action::ToggleParking),
            "rev_l" | "rev_r" => f.apply(Action::ToggleReverse),
            "Lcutoff" | "Rcutoff" => {
                let i = (id == "Rcutoff") as usize;
                let on = !s.master[i];
                s.set_master(i, on, &mut f.fm);
            }
            _ if kind == Kind::Lever => {
                let v0 = self.lever_value(&id, f, s);
                self.active = Some(Active { group: gi, kind: 2, v0, ..Default::default() });
            }
            _ if kind == Kind::Key => {
                // MCDU keyboard: `C:<key>` (captain) / `F:<key>` (first officer); the key stays depressed while the button is held
                self.groups[gi].press = 1.0;
                self.active = Some(Active { group: gi, kind: 3, ..Default::default() });
                let (side, key) = id.split_once(':').unwrap_or(("C", ""));
                let i = (side == "F") as usize;
                let k = if key.is_empty() { "." } else { key };
                let f_ptr: &mut Flight = f;
                s.mcdu[i].key(k, f_ptr);
            }
            _ if EcpKey::from_id(&id).is_some() || crate::ecp::is_key(&id) => {
                self.groups[gi].press = 1.0;
                self.active = Some(Active { group: gi, kind: 3, ..Default::default() });
                if let Some(k) = EcpKey::from_id(&id) {
                    s.ecp_down(k);
                }
                if crate::ecp::is_key(&id) {
                    let (mut mw, mut lt) = (s.master_warn, s.lamp_test);
                    s.ecp.press(&id, &mut mw, &mut lt);
                    s.master_warn = mw;
                    s.lamp_test = lt;
                    self.ecp_hold = id == "ecam_all";
                }
            }
            _ if RING.contains(&id.as_str()) => {
                // a click flips the two-position ring; the direction comes from the real state, never from a stale pose
                let d = match id.as_str() {
                    "qnh_cpt_sw" => if s.efis[0].unit_in_hg { 1 } else { -1 },
                    "qnh_fo_sw" => if s.efis[1].unit_in_hg { 1 } else { -1 },
                    _ => if s.alt_step_1000 { -1 } else { 1 },
                };
                self.step_knob(gi, d, false, f, s);
                self.groups[gi].press = 1.0;
            }
            _ if kind == Kind::Knob || PUSHPULL.contains(&id.as_str()) => {
                self.active = Some(Active { group: gi, kind: 1, ..Default::default() });
                if PUSHPULL.contains(&id.as_str()) {
                    self.groups[gi].press = 1.0;
                    self.activate_knob(gi, button == 2 || shift, f, s);
                } else {
                    let dir = if is_src_knob(&id) {
                        let d = src_click_dir(button, self.groups[gi].pos, self.groups[gi].angle);
                        self.groups[gi].angle = d as f32;
                        d
                    } else if button == 2 {
                        -1
                    } else {
                        1
                    };
                    self.step_knob(gi, dir, shift, f, s);
                }
            }
            _ => {
                self.toggle(gi, if button == 2 || shift { -1 } else { 1 }, f, s);
                self.groups[gi].press = 1.0;
                self.active = Some(Active { group: gi, kind: 0, ..Default::default() });
            }
        }
        Some(id)
    }

    fn lever_value(&self, id: &str, f: &Flight, s: &A320Systems) -> f64 {
        let c = &f.fm.ctl;
        match id {
            "thr_l_body" => c.throttle,
            "thr_r_body" => c.throttle + c.thr_offset,
            "FlapsLever" => c.flaps_idx as f64,
            "SpdBrk" => if c.spoilers_armed { -0.3 } else { c.speedbrake },
            _ => {
                let _ = s;
                0.0
            }
        }
    }

    pub fn drag(&mut self, dx: f32, dy: f32, f: &mut Flight, s: &mut A320Systems) -> bool {
        let Some(mut a) = self.active else { return false };
        let gi = a.group;
        if a.kind == 1 {
            a.acc += -dy / 14.0 + dx / 28.0;
            while a.acc.abs() >= 1.0 {
                let sg = a.acc.signum();
                a.acc -= sg;
                self.step_knob(gi, sg as i32, false, f, s);
            }
            self.active = Some(a);
            return true;
        }
        a.sy += dy;
        let id = self.groups[gi].id.clone();
        let det = f.fm.spec.flap_detents as f64;
        let c = &mut f.fm.ctl;
        match id.as_str() {
            "thr_l_body" => {
                let r = c.throttle + c.thr_offset;
                let v = snap_throttle(a.v0 - a.sy as f64 / 170.0, 0.04);
                c.throttle = v;
                c.thr_offset = r.clamp(0.0, 1.0) - v;
            }
            "thr_r_body" => c.thr_offset = snap_throttle(a.v0 - a.sy as f64 / 170.0, 0.04) - c.throttle,
            "FlapsLever" => c.flaps_idx = (a.v0 + a.sy as f64 / 30.0).round().clamp(0.0, det) as usize,
            "SpdBrk" => {
                let v = a.v0 + a.sy as f64 / 100.0;
                if v < -0.2 {
                    c.spoilers_armed = true;
                    c.speedbrake = 0.0;
                } else {
                    c.spoilers_armed = false;
                    c.speedbrake = v.clamp(0.0, 1.0);
                }
            }
            _ => {}
        }
        self.active = Some(a);
        true
    }

    pub fn release(&mut self, f: &mut Flight, s: &mut A320Systems) {
        self.ecp_hold = false;
        if let Some(a) = self.active.take() {
            if let Some(k) = EcpKey::from_id(&self.groups[a.group].id) {
                s.ecp_up(k);
            }
        }
        if f.fm.ctl.thr_offset.abs() < 0.03 {
            f.fm.ctl.thr_offset = 0.0;
        }
        for g in self.groups.iter_mut() {
            g.press = 0.0;
            g.plunge = 0.0;
        }
    }

    pub fn release_flight(&mut self, f: &mut Flight) {
        let mut dummy = A320Systems::default();
        self.release(f, &mut dummy);
    }

    /// Scroll wheel over a control: turns knobs, steps levers. Returns true when a control consumed it.
    pub fn wheel(&mut self, hit: &Hit, dy: f32, shift: bool, f: &mut Flight, s: &mut A320Systems) -> bool {
        let gi = hit.group;
        let id = self.groups[gi].id.clone();
        let kind = self.groups[gi].kind;
        if kind == Kind::Lever {
            let d = if dy > 0.0 { 0.05 } else { -0.05 };
            let c = &mut f.fm.ctl;
            match id.as_str() {
                "thr_l_body" => {
                    let r = c.throttle + c.thr_offset;
                    c.throttle = step_detent(c.throttle, d);
                    c.thr_offset = r - c.throttle;
                }
                "thr_r_body" => c.thr_offset = step_detent(c.throttle + c.thr_offset, d) - c.throttle,
                "FlapsLever" => c.flaps_idx = (c.flaps_idx as i32 + if dy > 0.0 { -1 } else { 1 }).clamp(0, 4) as usize,
                // speed-brake lever: ARM (forward) - RET - 25 % steps - FULL; wheel up moves it forward
                "SpdBrk" => {
                    let cur = if c.spoilers_armed { -1 } else { (c.speedbrake * 4.0).round() as i32 };
                    let n = (cur + if dy > 0.0 { -1 } else { 1 }).clamp(-1, 4);
                    c.spoilers_armed = n < 0;
                    c.speedbrake = n.max(0) as f64 / 4.0;
                }
                _ => return false,
            }
            return true;
        }
        if kind == Kind::Knob || PUSHPULL.contains(&id.as_str()) || id == "eng_mode" {
            self.step_knob(gi, if dy > 0.0 { 1 } else { -1 }, shift, f, s);
            return true;
        }
        false
    }

    fn set_guard(&mut self, gi: usize, v: i32) {
        let base = self.groups[gi].id.split('.').next().unwrap_or("").to_string();
        for g in self.groups.iter_mut() {
            if g.kind == Kind::Guard && g.id.split('.').next().unwrap_or("") == base {
                g.pos = v;
            }
        }
    }

    // ------------------------------------------------------------------ control effects
    /// PUSH (`pull = false`) / PULL (`pull = true`) of a rotary encoder. The four FCU window knobs are handled by
    /// [`fcu::push_pull`]; the EFIS BARO knobs: push = QNH, pull = STD. The knob plunges while the mouse button is down.
    fn activate_knob(&mut self, gi: usize, pull: bool, f: &mut Flight, s: &mut A320Systems) {
        let id = self.groups[gi].id.clone();
        self.groups[gi].plunge = if pull { 1.0 } else { -1.0 };
        if let Some(k) = FcuKnob::from_id(&id) {
            fcu::push_pull(k, pull, f, s);
            return;
        }
        match id.as_str() {
            "qnh_cpt_knb" => s.efis_baro_set(0, pull),
            "qnh_fo_knb" => s.efis_baro_set(1, pull),
            _ => {}
        }
    }

    /// One detent of an FCU window encoder: the knob turns by exactly one click, the logic lives in [`fcu::turn`].
    fn fcu_turn(&mut self, gi: usize, dir: i32, shift: bool, f: &mut Flight, s: &mut A320Systems) {
        self.groups[gi].angle += dir.signum() as f32 * fcu::CLICK_RAD;
        if let Some(k) = FcuKnob::from_id(&self.groups[gi].id) {
            fcu::turn(k, dir, shift, f, s);
        }
    }

    fn step_knob(&mut self, gi: usize, dir: i32, shift: bool, f: &mut Flight, s: &mut A320Systems) {
        let id = self.groups[gi].id.clone();
        let side = |a: &str| (id == a) as usize;
        match id.as_str() {
            "spd-sel" | "hdg_sel" | "alt-sel" | "vs-sel" => return self.fcu_turn(gi, dir, shift, f, s),
            "qnh_cpt_knb" | "qnh_fo_knb" => {
                s.efis_baro_turn(side("qnh_fo_knb"), dir);
                self.groups[gi].angle += dir as f32 * 0.2;
                return;
            }
            "qnh_cpt_sw" | "qnh_fo_sw" => {
                // ring left (counter-clockwise) = inHg, right (clockwise) = hPa
                s.efis_baro_unit(side("qnh_fo_sw"), dir < 0);
                self.groups[gi].pos = if dir < 0 { 0 } else { 1 };
                return;
            }
            "iesi_baro_knb" => {
                s.isis_std = false;
                s.isis_hpa = (s.isis_hpa + dir).clamp(950, 1050);
                self.groups[gi].angle += dir as f32 * 0.2;
                return;
            }
            "alt-sel-mode" => {
                // ALT increment ring: left = 100 ft per click, right = 1000 ft per click
                self.groups[gi].pos = (dir > 0) as i32;
                if s.alt_step_1000 != (dir > 0) {
                    fcu::set_alt_step(s, dir > 0);
                }
                return;
            }
            "fcu_integ_knb1" | "fcu_integ_knb2" => {
                s.bright.fcu = ((s.bright.fcu + dir as f32 * 0.1) * 10.0).round() / 10.0;
                s.bright.fcu = s.bright.fcu.clamp(0.2, 1.0);
                return;
            }
            "nd_range" | "nd_range_fo" => {
                let e = &mut s.efis[side("nd_range_fo")];
                e.nd_range = (e.nd_range as i32 + dir).clamp(0, 5) as usize;
                self.groups[gi].pos = e.nd_range as i32;
                return;
            }
            "nd_mode" | "nd_mode_fo" => {
                let e = &mut s.efis[side("nd_mode_fo")];
                e.nd_mode = (e.nd_mode as i32 + dir).clamp(0, 4) as usize;
                self.groups[gi].pos = e.nd_mode as i32;
                return;
            }
            "eng_mode" => {
                let m = (s.eng_mode as i32 + dir).clamp(0, 2) as u8;
                s.set_eng_mode(m, &mut f.fm);
                self.groups[gi].pos = s.eng_mode as i32;
                return;
            }
            "trim_1" => {
                f.apply(if dir > 0 { Action::TrimUp } else { Action::TrimDown });
                self.groups[gi].angle += dir as f32 * 0.1;
                return;
            }
            "RudderTrim" => {
                f.fm.ctl.rud_trim = (((f.fm.ctl.rud_trim + dir as f64 * 0.05) * 20.0).round() / 20.0).clamp(-1.0, 1.0);
                return;
            }
            "XbleedKnb" => {
                let p = ((self.groups[gi].pos).max(1) + dir).clamp(0, 2);
                self.groups[gi].pos = p;
                s.xbleed = if p == 0 { 0 } else { 1 };
                return;
            }
            "pfd_brt_cpt" | "pfd_brt_fo" => {
                let e = &mut s.bright.pfd[side("pfd_brt_fo")];
                *e = (*e + dir as f32 * 0.05).clamp(0.0, 1.0);
                return;
            }
            "brightness_nd_2_cpt" | "brightness_nd_2_fo" => {
                let e = &mut s.bright.nd[side("brightness_nd_2_fo")];
                *e = (*e + dir as f32 * 0.05).clamp(0.0, 1.0);
                return;
            }
            "brightness_nd_1_cpt" | "brightness_nd_1_fo" => {
                let e = &mut s.bright.nd_outer[side("brightness_nd_1_fo")];
                *e = (*e + dir as f32 * 0.05).clamp(0.0, 1.0);
                return;
            }
            "ecam_brt_upper" => s.bright.uecam = (((s.bright.uecam + dir as f32 * 0.1) * 10.0).round() / 10.0).clamp(0.0, 1.0),
            "ecam_brt_lower" => s.bright.lecam = (((s.bright.lecam + dir as f32 * 0.1) * 10.0).round() / 10.0).clamp(0.0, 1.0),
            "ecam_att_hdg" | "ecam_air_data" | "ecam_eis_dmc" | "ecam_nd_xfr" => {
                let p = (self.groups[gi].pos + dir).clamp(0, 2);
                self.groups[gi].pos = p;
                let k = match id.as_str() {
                    "ecam_att_hdg" => 0,
                    "ecam_air_data" => 1,
                    "ecam_eis_dmc" => 2,
                    _ => 3,
                };
                s.switching[k] = p as u8;
                s.sw.insert(id, p);
                return;
            }
            _ => {}
        }
        let n = self.groups[gi].steps;
        let cont = n >= 40;
        let g = &mut self.groups[gi];
        g.pos = if cont { g.pos + dir } else { (g.pos + dir).clamp(0, n - 1) };
        s.sw.insert(id, g.pos);
    }

    fn toggle(&mut self, gi: usize, dir: i32, f: &mut Flight, s: &mut A320Systems) {
        let raw = self.groups[gi].id.clone();
        let id = if raw.starts_with("EmerGenTest.") { "EmerGenTest".to_string() } else { raw };
        let flip = |g: &mut Group| {
            g.pos = if g.pos != 0 { 0 } else { 1 };
            g.pos != 0
        };
        let cycle = |g: &mut Group, n: i32| {
            g.pos = (g.pos + if dir > 0 { 1 } else { n - 1 }) % n;
            g.pos
        };
        match id.as_str() {
            "RudderTrimReset" => f.fm.ctl.rud_trim = 0.0,
            "BatteryBtn1" => s.bat[0] = !s.bat[0],
            "BatteryBtn2" => s.bat[1] = !s.bat[1],
            "firebtn1" => s.fire_toggle(0, &mut f.fm),
            "firebtn2" => s.fire_toggle(1, &mut f.fm),
            "firebtnapu" => s.fire_toggle(2, &mut f.fm),
            "Eng1FireAgt1Btn" | "Eng1FireAgt2Btn" | "Eng2FireAgt1Btn" | "Eng2FireAgt2Btn" | "APUFireAgtBtn" => {
                if let Some(&(_, a)) = AGENT_IDX.iter().find(|x| x.0 == id) {
                    s.discharge(a);
                }
            }
            "ELTSw" => {
                flip(&mut self.groups[gi]);
                s.elt = self.groups[gi].pos == 1;
                s.say(if s.elt { "ELT ON - transmitting on 121.5 / 243 / 406 MHz" } else { "ELT ARMED (will trigger on impact)" });
            }
            "EltTestRst" => {
                s.lamp_test = 1.5;
                s.say("ELT test - transmitter light checked");
            }
            "ExtPwrBtn" => s.ext = !s.ext,
            "APUMasterBtn" => s.apu_master = !s.apu_master,
            "APUStartBtn" => s.apu_start_press(),
            "APUGenBtn" => s.apu_gen = !s.apu_gen,
            "APUBleedBtn" => s.apu_bleed = !s.apu_bleed,
            "Gen1Btn" => s.gen[0] = !s.gen[0],
            "Gen2Btn" => s.gen[1] = !s.gen[1],
            "Eng1BleedBtn" => s.eng_bleed[0] = !s.eng_bleed[0],
            "Eng2BleedBtn" => s.eng_bleed[1] = !s.eng_bleed[1],
            "ACPack1Btn" => s.packs[0] = !s.packs[0],
            "ACPack2Btn" => s.packs[1] = !s.packs[1],
            "WingAntiIceBtn" => s.wing_ai = !s.wing_ai,
            "Eng1AntiIceBtn" => s.eng_ai[0] = !s.eng_ai[0],
            "Eng2AntiIceBtn" => s.eng_ai[1] = !s.eng_ai[1],
            "LFuelTank1Btn" => s.pumps[0] = !s.pumps[0],
            "LFuelTank2Btn" => s.pumps[1] = !s.pumps[1],
            "CFuelTank1Btn" => s.pumps[2] = !s.pumps[2],
            "CFuelTank2Btn" => s.pumps[3] = !s.pumps[3],
            "RFuelTank1Btn" => s.pumps[4] = !s.pumps[4],
            "RFuelTank2Btn" => s.pumps[5] = !s.pumps[5],
            "FuelXFeedBtn" => s.xfeed = !s.xfeed,
            "GreenEngPump2" => s.hyd_green_pump = !s.hyd_green_pump,
            "YellowEngPump" => s.hyd_yellow_pump = !s.hyd_yellow_pump,
            "BlueElecPump" => s.hyd_blue_pump = !s.hyd_blue_pump,
            "YellowElecPump" => s.hyd_yelec_pump = !s.hyd_yelec_pump,
            "PTU2" => s.ptu = !s.ptu,
            "RATMan" => s.rat_out = true,
            "BeaconLtSwtch" => s.lights.beacon = flip(&mut self.groups[gi]),
            "StrobeLtSwtch" => s.lights.strobe = cycle(&mut self.groups[gi], 3) >= 1,
            "NavLogoLtSwtch" => s.lights.nav = cycle(&mut self.groups[gi], 3) != 1,
            "LandingLtSwtch" | "LandingLtRSwtch" | "land_sw" => s.lights.land = cycle(&mut self.groups[gi], 3) == 2,
            "SeatBeltSwtch" => s.lights.seatbelt = cycle(&mut self.groups[gi], 3) == 2,
            "eng_mode" => {
                let m = ((s.eng_mode as i32 + if dir > 0 { 1 } else { 2 }) % 3) as u8;
                s.set_eng_mode(m, &mut f.fm);
            }
            // FCU push-buttons: AP1 / AP2 / A/THR / APPR / LOC / EXPED / HDG-VS (TRK-FPA) / SPD-MACH / METRIC ALT
            "ap1" | "ap2" | "a-thr" | "appr" | "loc" | "exped" | "hdg-vs" | "trk-fpa" | "spd-mach" | "metric_alt" => {
                if let Some(b) = FcuButton::from_id(&id) {
                    fcu::button(b, f, s);
                }
            }
            "fd1" | "fd2" => {
                let e = &mut s.efis[(id == "fd2") as usize];
                e.fd = !e.fd;
            }
            "ils" | "ils2" => {
                let e = &mut s.efis[(id == "ils2") as usize];
                e.ls = !e.ls;
            }
            "cstr" | "cstr.001" | "wpt" | "wpt.001" | "vord" | "vord.001" | "ndb" | "ndb.001" | "arpt" | "arpt.001" => {
                let side = id.ends_with(".001") as usize;
                let k = match id.trim_end_matches(".001") {
                    "cstr" => NdOpt::Cstr,
                    "wpt" => NdOpt::Wpt,
                    "vord" => NdOpt::Vord,
                    "ndb" => NdOpt::Ndb,
                    _ => NdOpt::Arpt,
                };
                s.efis_opt(side, k);
            }
            "pfd_nd_xfr_sw" | "pfd_nd_xfr_sw2" => {
                let e = &mut s.efis[(id == "pfd_nd_xfr_sw2") as usize];
                e.xfr = !e.xfr;
            }
            "terr_on_nd_l" | "terr_on_nd_r" => {
                let i = (id == "terr_on_nd_r") as usize;
                s.terr_on_nd[i] = !s.terr_on_nd[i];
            }
            "vor-adf1" | "vor-adf2" | "vor-adf-1-right" | "vor-adf-2-right" => {
                let side = id.contains("right") as usize;
                let i = (id.ends_with('2') || id.contains("adf-2")) as usize;
                let order = [0i8, 1, -1];
                let cur = order.iter().position(|&x| x == s.efis[side].nav[i]).unwrap_or(0);
                s.efis[side].nav[i] = order[(cur + if dir > 0 { 1 } else { 2 }) % 3];
                self.groups[gi].pos = (s.efis[side].nav[i] + 1) as i32;
            }
            "iesi_btn_rst" => s.isis_std = !s.isis_std,
            "master_warning" => s.acknowledge_master_warning(),
            "master_caution" => s.master_caut = false,
            "chrono_btn" => {
                s.chrono_run = !s.chrono_run;
                s.chrono_show = true;
            }
            "chrono_reset" => {
                s.chrono_t = 0.0;
                s.chrono_run = false;
                s.chrono_show = false;
            }
            "abs_low" | "abs_med" | "abs_max" => {
                let v = match id.as_str() {
                    "abs_low" => 1,
                    "abs_med" => 2,
                    _ => 3,
                };
                f.fm.ctl.autobrake = if f.fm.ctl.autobrake == v { 0 } else { v };
            }
            "AnnunciatorLtSwtch" => {
                s.lamp_test = 3.0;
                cycle(&mut self.groups[gi], 3);
            }
            _ => {
                // generic behaviour: guards open / close, 2- and 3-position switches cycle, push-buttons latch (overhead) or flash
                let g = &mut self.groups[gi];
                match g.kind {
                    Kind::Guard => {
                        let v = if g.pos != 0 { 0 } else { 1 };
                        self.set_guard(gi, v);
                    }
                    Kind::Switch => {
                        let n = if SWITCH3.contains(&id.as_str()) || id.starts_with("audio_int_rad") { 3 } else { 2 };
                        cycle(g, n);
                        s.sw.insert(id.clone(), g.pos);
                    }
                    _ => {
                        if !g.mom {
                            flip(g);
                            s.sw.insert(id.clone(), g.pos);
                        }
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------ animation
    /// Advance the control poses (call once per frame).
    pub fn update(&mut self, dt: f32, f: &Flight, s: &A320Systems) {
        for g in self.groups.iter_mut() {
            g.press += (0.0 - g.press) * 0.0; // press is held until release()
        }
        let ctl = &f.fm.ctl;
        let k = (dt * 16.0).min(1.0);
        for i in 0..2 {
            self.mst_sm[i] += ((if s.master[i] { 0.0 } else { 1.0 }) - self.mst_sm[i]) * k;
        }
        self.rud_sm += (ctl.rud_trim as f32 - self.rud_sm) * (dt * 12.0).min(1.0);
        self.animate_knobs(dt, s);
        let order: Vec<usize> = {
            let mut v: Vec<usize> = (0..self.groups.len()).collect();
            v.sort_by_key(|&i| !LEADER.iter().any(|l| l.1 == self.groups[i].id));
            v
        };
        for gi in order {
            let id = self.groups[gi].id.clone();
            let kind = self.groups[gi].kind;
            let xf = match id.as_str() {
                "thr_l_body" => rot_about(THR_PIVOT_L, Vec3::Z, thr_angle(ctl.throttle, ctl.reverse)),
                "thr_r_body" => rot_about(THR_PIVOT_R, Vec3::Z, thr_angle((ctl.throttle + ctl.thr_offset).clamp(0.0, 1.0), ctl.reverse)),
                "Lcutoff" | "Rcutoff" => {
                    let i = (id == "Rcutoff") as usize;
                    let ax = self.axis_of(gi);
                    let aft = if ax.dir.z < 0.0 { 1.0 } else { -1.0 };
                    rot_about(ax.pivot, ax.dir, aft * 0.6 * self.mst_sm[i])
                }
                "RudderTrim" => {
                    let ax = self.axis_of(gi);
                    rot_about(ax.pivot, ax.dir, self.rud_sm * 1.3 * if ax.dir.y < 0.0 { 1.0 } else { -1.0 })
                }
                "rev_l" | "rev_r" if self.groups[gi].axis.is_some() => {
                    let ax = self.groups[gi].axis.unwrap();
                    rot_about(ax.pivot, ax.dir, if ctl.reverse { -0.45 } else { 0.0 })
                }
                "FlapsLever" => rot_about(Vec3::new(0.087, -0.188, -0.1), Vec3::Z, -(ctl.flaps_idx as f32) * 0.17),
                "SpdBrk" => rot_about(Vec3::new(0.087, -0.206, 0.074), Vec3::Z, if ctl.spoilers_armed { 0.25 } else { -(ctl.speedbrake as f32) * 0.6 }),
                "gear_lever" => {
                    let ax = self.axis_of(gi);
                    rot_about(ax.pivot, ax.dir, if ctl.gear_down { 0.0 } else { 0.9 })
                }
                "ParkBrk" => {
                    let ax = self.axis_of(gi);
                    rot_about(ax.pivot, ax.dir, if ctl.parking { 0.6 } else { 0.0 })
                }
                "stick" => Mat4::IDENTITY,
                "tiller" | "tillerFo" => {
                    let ax = self.axis_of(gi);
                    rot_about(ax.pivot, ax.dir, ctl.yaw as f32 * 0.9)
                }
                _ => {
                    let g = &self.groups[gi];
                    let knobby = kind == Kind::Knob || PUSHPULL.contains(&id.as_str());
                    if knobby {
                        let ax = self.axis_of(gi);
                        let g = &self.groups[gi];
                        // glareshield knobs turn exactly as the pilot sees them: clockwise on screen whatever the axis direction
                        // (a positive turn about an axis pointing at the pilot's eye is counter-clockwise from the seat)
                        let sign = if cw_driven(&id) && ax.dir.dot(EYE_M - ax.pivot) > 0.0 { -1.0 } else { 1.0 };
                        // push / pull travel rides on the panel normal (towards the pilot = pulled)
                        Mat4::from_translation(g.nrm * g.slide) * rot_about(ax.pivot, ax.dir, sign * g.vis)
                    } else if kind == Kind::Switch {
                        let n = if SWITCH3.contains(&id.as_str()) || id.starts_with("audio_int_rad") { 3.0 } else { 2.0 };
                        let sg = self.lever_sign(gi);
                        let (pos, ax) = (self.groups[gi].pos as f32, self.axis_of(gi));
                        if id.starts_with("vor-adf") {
                            rot_about(ax.pivot, ax.dir, self.groups[gi].vis)
                        } else {
                            rot_about(ax.pivot, ax.dir, sg * (pos - (n - 1.0) / 2.0) * if n == 2.0 { 0.8 } else { 0.42 })
                        }
                    } else if kind == Kind::Guard {
                        let (pos, ax) = (g.pos, self.axis_of(gi));
                        rot_about(ax.pivot, ax.dir, if pos != 0 { 1.7 } else { 0.0 })
                    } else if g.ovh {
                        let on = self.state_on(&id, s, f);
                        let g = &self.groups[gi];
                        let o = (if g.mom || on { 0.0 } else { 0.0035 }) - if g.press > 0.0 { 0.002 } else { 0.0 };
                        Mat4::from_translation(g.nrm * o)
                    } else {
                        let on_in = !ON_WHEN_IN.contains(&id.as_str()) && kind == Kind::Push && g.pos == 0;
                        let dep = if g.press > 0.0 { 0.0018 } else { 0.0 } + if on_in { 0.0009 } else { 0.0 };
                        Mat4::from_translation(-g.nrm * dep)
                    }
                }
            };
            let mut xf = xf;
            if let Some(lead) = LEADER.iter().find(|l| l.0 == id).and_then(|l| self.by_id.get(l.1)) {
                xf = self.groups[*lead].xf * xf;
            }
            self.groups[gi].xf = xf;
        }
    }

    /// State -> pose of every rotary control: re-sync the two/three-position EFIS switches with the systems state, then chase the
    /// target angle / plunger travel with a critically damped-looking exponential (knobs never teleport).
    fn animate_knobs(&mut self, dt: f32, s: &A320Systems) {
        for (id, side, i) in [("vor-adf1", 0, 0), ("vor-adf2", 0, 1), ("vor-adf-1-right", 1, 0), ("vor-adf-2-right", 1, 1)] {
            if let Some(&gi) = self.by_id.get(id) {
                self.groups[gi].pos = (s.efis[side].nav[i] + 1) as i32;
            }
        }
        for (id, side) in [("pfd_nd_xfr_sw", 0), ("pfd_nd_xfr_sw2", 1)] {
            if let Some(&gi) = self.by_id.get(id) {
                self.groups[gi].pos = s.efis[side].xfr as i32;
            }
        }
        for (id, side) in [("qnh_cpt_sw", 0), ("qnh_fo_sw", 1)] {
            if let Some(&gi) = self.by_id.get(id) {
                self.groups[gi].pos = !s.efis[side].unit_in_hg as i32;
            }
        }
        if let Some(&gi) = self.by_id.get("alt-sel-mode") {
            self.groups[gi].pos = s.alt_step_1000 as i32;
        }
        let kr = (1.0 - (-dt * 26.0).exp()).clamp(0.0, 1.0);
        let kp = (1.0 - (-dt * 30.0).exp()).clamp(0.0, 1.0);
        for g in self.groups.iter_mut() {
            let rotary = g.kind == Kind::Knob || PUSHPULL.contains(&g.id.as_str()) || (g.kind == Kind::Switch && g.id.starts_with("vor-adf"));
            if !rotary {
                continue;
            }
            let target = knob_target(g, s);
            if g.vis.is_nan() {
                g.vis = target;
            } else {
                g.vis += (target - g.vis) * kr;
                if (target - g.vis).abs() < 1e-4 {
                    g.vis = target;
                }
            }
            g.slide += (plunger_target(g, s) - g.slide) * kp;
        }
    }

    fn legend_lit(&self, id: &str, letter: char, s: &A320Systems, f: &Flight) -> (bool, [f32; 3]) {
        let wired = self.state_on(id, s, f);
        let on_type = ON_WHEN_IN.contains(&id);
        let eng = [f.fm.eng[0].state == crate::physics::EngState::Running, f.fm.eng[1].state == crate::physics::EngState::Running];
        match letter {
            'F' => {
                let fault = match id {
                    "GreenEngPump2" => s.hyd_green_pump && eng[0] && s.hyd[0] < 1500.0,
                    "YellowEngPump" => s.hyd_yellow_pump && eng[1] && s.hyd[1] < 1500.0,
                    _ => false,
                };
                (fault || s.lamp_test > 0.0, [1.0, 0.69, 0.0])
            }
            'A' => (id == "APUStartBtn" && s.apu_rpm >= 95.0, [0.25, 1.0, 0.38]),
            'O' => ((if on_type { wired } else { !wired }) && s.dc || s.lamp_test > 0.0, if on_type { [0.25, 0.66, 1.0] } else { [0.94, 0.96, 1.0] }),
            'S' | 'D' => {
                let a = AGENT_IDX.iter().find(|x| x.0 == id).map(|x| x.1);
                let lit = match (a, letter) {
                    (Some(a), 'S') => s.fire_out[if a == 4 { 2 } else { a >> 1 }] && !s.agent_disch[a],
                    (Some(a), _) => s.agent_disch[a],
                    _ => false,
                };
                (lit || s.lamp_test > 0.0, [1.0, 0.69, 0.0])
            }
            'M' => (!wired && s.dc, [0.94, 0.96, 1.0]),
            _ => (false, [0.0; 3]),
        }
    }

    fn led_lit(&self, base: &str, s: &A320Systems, f: &Flight) -> (bool, [f32; 3]) {
        let e = &s.efis;
        let amber = [1.0, 0.69, 0.0];
        let green = [0.25, 1.0, 0.38];
        let white = [0.94, 0.96, 1.0];
        if let Some(name) = base.strip_prefix("fcu:") {
            let d = fcu::flags(f, s);
            return (fcu::legend_lit(name, &d).unwrap_or(false), white);
        }
        // MCDU annunciators: MSG (message waiting), RDY, FM1 / FM2 (the FMGC in use), FAIL / FM (never failed here)
        if let Some(rest) = base.strip_prefix("mcdu_ann_") {
            let side = rest.ends_with(".fo") as usize;
            let m = &s.mcdu[side];
            let (lit, col) = match rest.trim_end_matches(".cpt").trim_end_matches(".fo") {
                "msg" => (m.has_msg(), white),
                "rdy" => (m.powered && !m.has_msg(), green),
                "fm1" => (m.powered && side == 0, green),
                "fm2" => (m.powered && side == 1, green),
                "fail" | "fm" => (false, amber),
                _ => (false, white),
            };
            return (lit || (s.lamp_test > 0.0 && m.powered), col);
        }
        // ECP key lamps
        if let Some(k) = EcpKey::from_id(base) {
            return (s.ecp_lit(k), white);
        }
        if crate::ecp::page_of(base).is_some() || base == "ecam_all" {
            return (s.ecp.lit(base), white);
        }
        let lit = match base {
            "ap1" => (s.ap_eng[0] && f.ap.on, green),
            "ap2" => (s.ap_eng[1] && f.ap.on, green),
            // A/THR is lit while the autothrust is armed or the autopilot is flying the speed (cockpit.ts `ledOn`)
            "a-thr" => (s.athr_armed || f.ap.on, green),
            "appr" => (f.ap.appr, green),
            "loc" => (s.loc_armed, green),
            "exped" => (s.exped, green),
            "fd1" => (e[0].fd, green),
            "fd2" => (e[1].fd, green),
            "ils" => (e[0].ls, green),
            "ils2" => (e[1].ls, green),
            "cstr" => (e[0].opt == Some(NdOpt::Cstr), green),
            "wpt" => (e[0].opt == Some(NdOpt::Wpt), green),
            "vord" => (e[0].opt == Some(NdOpt::Vord), green),
            "ndb" => (e[0].opt == Some(NdOpt::Ndb), green),
            "arpt" => (e[0].opt == Some(NdOpt::Arpt), green),
            "cstr.001" => (e[1].opt == Some(NdOpt::Cstr), green),
            "wpt.001" => (e[1].opt == Some(NdOpt::Wpt), green),
            "vord.001" => (e[1].opt == Some(NdOpt::Vord), green),
            "ndb.001" => (e[1].opt == Some(NdOpt::Ndb), green),
            "arpt.001" => (e[1].opt == Some(NdOpt::Arpt), green),
            "abs_low" => (f.fm.ctl.autobrake == 1, green),
            "abs_med" => (f.fm.ctl.autobrake == 2, green),
            "abs_max" => (f.fm.ctl.autobrake == 3, green),
            "master_warning" => (s.warn_lit(), [1.0, 0.1, 0.1]),
            "master_caution" => (s.master_caut, amber),
            _ => (false, white),
        };
        (lit.0 || (s.lamp_test > 0.0 && matches!(base, "master_warning" | "master_caution")), lit.1)
    }

    /// Atlas cell shown on each screen mesh (`self.screens` order). The ECAM / ND XFR knob routes the lower ECAM (SD) onto the
    /// captain's (CAPT) or first officer's (F/O) navigation display.
    pub fn screen_cells(&self, s: &A320Systems, out: &mut Vec<usize>) {
        out.clear();
        for sc in &self.screens {
            out.push(match sc.node.as_str() {
                "ND.screen" if s.switching[3] == 0 => CELL_SD,
                "ND_R.screen" if s.switching[3] == 2 => CELL_SD,
                _ => sc.cell,
            });
        }
    }

    /// Display-quad vertices for the given routing (same count / order as `GpuMesh::screen_v`, only the UVs differ).
    pub fn screen_vertices(&self, cells: &[usize]) -> Vec<PanelV> {
        let (mut v, mut idx) = (Vec::new(), Vec::new());
        for (i, m) in self.glb.meshes.iter().enumerate() {
            if self.hidden[i] || m.idx.is_empty() {
                continue;
            }
            if let Some(&si) = self.screen_mesh.get(&i) {
                self.bake_screen(m, cells.get(si).copied().unwrap_or(self.screens[si].cell), &mut v, &mut idx);
            }
        }
        v
    }

    /// Fill `out` (slot 0 = static geometry, then groups, then lamp nodes).
    pub fn slots(&self, s: &A320Systems, f: &Flight, out: &mut Vec<Slot>) {
        out.clear();
        let t = self.to_body;
        let slot = |m: Mat4, mul: [f32; 4], add: [f32; 4]| Slot { m: m.to_cols_array_2d(), mul, add };
        out.push(slot(t, [1.0; 4], [0.0; 4]));
        for g in &self.groups {
            out.push(slot(t * g.xf, [1.0; 4], [0.0; 4]));
        }
        for l in &self.lamps {
            let (m, gi) = match self.by_id.get(&l.base) {
                Some(&gi) => (t * self.groups[gi].xf, Some(gi)),
                None => (t, None),
            };
            let _ = gi;
            let (lit, c) = match l.leg {
                Some(letter) => self.legend_lit(&l.base, letter, s, f),
                None => self.led_lit(&l.base, s, f),
            };
            // legends keep their printed texture, lit ones glow; LED nodes are only visible when lit
            let (mul, add) = if l.base.starts_with("fcu:") {
                // FCU legend meshes keep their own material, they are simply shown / hidden
                (if lit { [1.0; 4] } else { [0.0; 4] }, [0.0; 4])
            } else if l.leg.is_some() {
                (if lit { [1.0; 4] } else { [0.35, 0.35, 0.35, 1.0] }, if lit { [c[0] * 0.8, c[1] * 0.8, c[2] * 0.8, 0.0] } else { [0.0; 4] })
            } else {
                ([c[0], c[1], c[2], if lit { 1.0 } else { 0.0 }], if lit { [c[0] * 0.7, c[1] * 0.7, c[2] * 0.7, 0.0] } else { [0.0; 4] })
            };
            out.push(slot(m, mul, add));
        }
    }

    // ------------------------------------------------------------------ GPU bake
    pub fn gpu_mesh(&self) -> GpuMesh {
        let mut verts: Vec<DeckV> = Vec::new();
        let mut per_mat: Vec<Vec<u32>> = vec![Vec::new(); self.glb.materials.len()];
        let lamp_slot: HashMap<usize, u32> = self.lamps.iter().map(|l| (l.mesh, l.slot)).collect();
        let mut screen_v: Vec<PanelV> = Vec::new();
        let mut screen_i: Vec<u32> = Vec::new();
        for (i, m) in self.glb.meshes.iter().enumerate() {
            if self.hidden[i] || m.idx.is_empty() {
                continue;
            }
            if let Some(&si) = self.screen_mesh.get(&i) {
                self.bake_screen(m, self.screens[si].cell, &mut screen_v, &mut screen_i);
                continue;
            }
            if m.name.starts_with("EFB_") && false {
                continue;
            }
            let slot = match (self.mesh_group[i], lamp_slot.get(&i)) {
                (Some(g), _) => self.groups[g].slot,
                (None, Some(&s)) => s,
                _ => 0,
            };
            let base = verts.len() as u32;
            for k in 0..m.pos.len() {
                verts.push(DeckV { pos: m.pos[k], nrm: m.nrm[k], uv: m.uv[k], slot, mat: m.material as u32 });
            }
            per_mat[m.material].extend(m.idx.iter().map(|x| x + base));
        }
        // opaque + alpha-test first, blended last (so transparent glass is drawn over everything)
        let mut order: Vec<usize> = (0..per_mat.len()).collect();
        order.sort_by_key(|&k| (self.glb.materials[k].mode == 2) as u8);
        let mut indices = Vec::new();
        let mut draws = Vec::new();
        for k in order {
            if per_mat[k].is_empty() {
                continue;
            }
            draws.push(Draw { mat: k as u32, first: indices.len() as u32, count: per_mat[k].len() as u32 });
            indices.extend_from_slice(&per_mat[k]);
        }
        GpuMesh { verts, indices, draws, materials: self.glb.materials.clone(), screen_v, screen_i, slot_count: 1 + self.groups.len() + self.lamps.len() }
    }

    /// Project a screen mesh onto its plane and map it onto one cell of the display atlas (square aspect cells, glass fills the cell).
    fn bake_screen(&self, m: &crate::glb::MeshData, cell: usize, v: &mut Vec<PanelV>, idx: &mut Vec<u32>) {
        let pts: Vec<Vec3> = m.pos.iter().map(|p| Vec3::from(*p)).collect();
        let mut n = Vec3::ZERO;
        for t in m.idx.chunks_exact(3) {
            let (a, b, c) = (pts[t[0] as usize], pts[t[1] as usize], pts[t[2] as usize]);
            n += (b - a).cross(c - a);
        }
        let mut n = n.normalize_or(Vec3::X);
        if n.x < 0.0 {
            n = -n; // glass faces the pilot (model +X is aft)
        }
        let right = (-n).cross(Vec3::Y).normalize_or(-Vec3::Z);
        let up = right.cross(-n).normalize_or(Vec3::Y);
        let c0 = pts[0];
        let (mut u0, mut u1, mut v0, mut v1) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
        for p in &pts {
            let (u, w) = ((*p - c0).dot(right), (*p - c0).dot(up));
            u0 = u0.min(u);
            u1 = u1.max(u);
            v0 = v0.min(w);
            v1 = v1.max(w);
        }
        let [u0_c, v0_c, u1_c, v1_c] = cell_uv(cell);
        let base = v.len() as u32;
        for p in &pts {
            let (u, w) = (((*p - c0).dot(right) - u0) / (u1 - u0).max(1e-6), ((*p - c0).dot(up) - v0) / (v1 - v0).max(1e-6));
            let body = self.to_body.transform_point3(*p + n * 0.0015);
            v.push(PanelV { pos: body.to_array(), uv: [u0_c + u * (u1_c - u0_c), v0_c + (1.0 - w) * (v1_c - v0_c)] });
        }
        // wind triangles so they face the pilot after the model->body transform (the panel pipeline is double-sided anyway)
        idx.extend(m.idx.iter().map(|x| x + base));
    }

    /// Body-frame centre + size of a model node (used to anchor the FCU read-outs).
    pub fn node_body_box(&self, name: &str) -> Option<(Vec3, Vec3)> {
        let m = self.glb.meshes.iter().find(|m| m.name == name)?;
        let (mut mn, mut mx) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
        for p in &m.pos {
            let b = self.to_body.transform_point3(Vec3::from(*p));
            mn = mn.min(b);
            mx = mx.max(b);
        }
        Some(((mn + mx) * 0.5, mx - mn))
    }

    pub fn ids_of_kind(&self, k: Kind) -> HashSet<&str> {
        self.groups.iter().filter(|g| g.kind == k).map(|g| g.id.as_str()).collect()
    }
}

/// Controls whose pose is a pure function of the systems state / click angle and which are rotated *clockwise as seen by the pilot*.
fn cw_driven(id: &str) -> bool {
    matches!(
        id,
        "spd-sel" | "hdg_sel" | "alt-sel" | "vs-sel" | "alt-sel-mode" | "qnh_cpt_knb" | "qnh_fo_knb" | "qnh_cpt_sw" | "qnh_fo_sw" | "iesi_baro_knb" | "nd_mode" | "nd_mode_fo" | "nd_range" | "nd_range_fo"
            | "pfd_brt_cpt" | "pfd_brt_fo" | "brightness_nd_2_cpt" | "brightness_nd_2_fo" | "brightness_nd_1_cpt" | "brightness_nd_1_fo" | "fcu_integ_knb1" | "fcu_integ_knb2"
            | "ecam_brt_upper" | "ecam_brt_lower" | "ecam_att_hdg" | "ecam_air_data" | "ecam_eis_dmc" | "ecam_nd_xfr"
    )
}

/// Target rotation (radians) of a rotary control. For [`cw_driven`] controls it is clockwise-positive as seen by the pilot:
/// * FCU window encoders / BARO knobs / ISIS baro: the accumulated click angle (32 detents per turn, independent of the value);
/// * ALT 100 / 1000 ring and the EFIS hPa / inHg ring: two stops left / right;
/// * ND MODE (LS-VOR-NAV-ARC-PLAN) and ND RANGE (10 .. 320): 45 deg per detent from the first stop;
/// * brightness dimmers: 270 deg sweep, fully counter-clockwise = OFF.
fn knob_target(g: &Group, s: &A320Systems) -> f32 {
    let side = |a: &str| (g.id == a) as usize;
    let sweep = |v: f32| (-135.0 + 270.0 * v.clamp(0.0, 1.0)).to_radians();
    match g.id.as_str() {
        "spd-sel" | "hdg_sel" | "alt-sel" | "vs-sel" | "qnh_cpt_knb" | "qnh_fo_knb" | "iesi_baro_knb" => g.angle,
        "alt-sel-mode" => if s.alt_step_1000 { 0.45 } else { -0.45 },
        "qnh_cpt_sw" | "qnh_fo_sw" => (if s.efis[side("qnh_fo_sw")].unit_in_hg { -40.0f32 } else { 40.0 }).to_radians(),
        "nd_mode" | "nd_mode_fo" => (s.efis[side("nd_mode_fo")].nd_mode as f32 * 45.0).to_radians(),
        "nd_range" | "nd_range_fo" => (s.efis[side("nd_range_fo")].nd_range as f32 * 45.0).to_radians(),
        "pfd_brt_cpt" | "pfd_brt_fo" => sweep(s.bright.pfd[side("pfd_brt_fo")]),
        "brightness_nd_2_cpt" | "brightness_nd_2_fo" => sweep(s.bright.nd[side("brightness_nd_2_fo")]),
        "brightness_nd_1_cpt" | "brightness_nd_1_fo" => sweep(s.bright.nd_outer[side("brightness_nd_1_fo")]),
        "fcu_integ_knb1" | "fcu_integ_knb2" => sweep((s.bright.fcu - 0.2) / 0.8),
        "ecam_brt_upper" => sweep(s.bright.uecam),
        "ecam_brt_lower" => sweep(s.bright.lecam),
        "ecam_att_hdg" => (s.switching[0] as f32 - 1.0) * 0.785,
        "ecam_air_data" => (s.switching[1] as f32 - 1.0) * 0.785,
        "ecam_eis_dmc" => (s.switching[2] as f32 - 1.0) * 0.785,
        "ecam_nd_xfr" => (s.switching[3] as f32 - 1.0) * 0.785,
        // ADF (-1) / OFF (0) / VOR (+1) lever: positive turn about the manifest axis swings it towards ADF
        id if id.starts_with("vor-adf") => {
            let (side, i) = match id {
                "vor-adf1" => (0, 0),
                "vor-adf2" => (0, 1),
                "vor-adf-1-right" => (1, 0),
                _ => (1, 1),
            };
            -0.5 * s.efis[side].nav[i] as f32
        }
        _ => {
            let n = g.steps as f32;
            if n >= 40.0 {
                g.angle + g.pos as f32 * 0.26
            } else if n >= 12.0 {
                (g.pos as f32 - (n - 1.0) / 2.0) * (4.71 / (n - 1.0))
            } else {
                (g.pos as f32 - (n - 1.0) / 2.0) * if n <= 3.0 { 0.7 } else { 0.5 }
            }
        }
    }
}

/// Push / pull travel (metres along the panel normal, + = towards the pilot): a push-pull knob dips 2.5 mm when pushed and
/// comes out 4 mm when pulled while the mouse is down; the EFIS BARO knob stays 4 mm out while STD is selected.
fn plunger_target(g: &Group, s: &A320Systems) -> f32 {
    if !PUSHPULL.contains(&g.id.as_str()) {
        return 0.0;
    }
    let held = if g.plunge < 0.0 { -0.0025 } else if g.plunge > 0.0 { 0.004 } else { 0.0 };
    let std_out = match g.id.as_str() {
        "qnh_cpt_knb" => s.efis[0].std,
        "qnh_fo_knb" => s.efis[1].std,
        _ => false,
    };
    if held != 0.0 { held } else if std_out { 0.004 } else { 0.0 }
}

fn thr_angle(t: f64, reverse: bool) -> f32 {
    if reverse {
        -(0.17 + 0.18 * t.clamp(0.0, 1.0) as f32)
    } else {
        t.clamp(0.0, 1.0) as f32 * std::f32::consts::FRAC_PI_4
    }
}

fn is_mcdu_key(k: &str) -> bool {
    k == "atc_comm" || crate::mcdu::is_key_name(k)
}

/// Keys of the MCDU keyboard sit on a surface tilted ~10 deg towards the pilot (measured on the model: 1.6 cm rise over 9.4 cm).
const MCDU_KEY_NORMAL: Vec3 = Vec3::new(0.17, 0.985, 0.0);

/// Controls that spring back (only move while held) although the TS naming regex does not list them.
fn momentary_extra(id: &str) -> bool {
    matches!(id, "thr_l_button" | "thr_r_button" | "RudderTrimReset" | "chrono_reset" | "master_warning" | "master_caution" | "iesi_btn_rst" | "iesi_btn_bugs" | "iesi_btn_ls" | "iesi_btn_minus" | "iesi_btn_plus" | "clock_set" | "et_knob")
        || crate::ecp::is_key(id)
        || EcpKey::from_id(id).is_some()
        || id.starts_with("C:")
        || id.starts_with("F:")
}

fn panel_normal(c: Vec3) -> Vec3 {
    if c.z > 0.7 {
        return Vec3::new(0.5613, 0.1934, -0.8049).normalize();
    }
    if c.y > 0.8 {
        return Vec3::new(0.25, -1.0, 0.0).normalize();
    }
    if c.x < -0.3 && c.x > -0.43 && c.y > 0.38 && c.y < 0.6 {
        return Vec3::new(0.957, 0.289, 0.0).normalize();
    }
    if c.x < -0.44 {
        return Vec3::new(1.0, 0.15, 0.0).normalize();
    }
    if c.z.abs() < 0.34 && c.y < 0.2 {
        return Vec3::new(0.25, 1.0, 0.0).normalize();
    }
    let sg = if c.z == 0.0 { 1.0 } else { c.z.signum() };
    Vec3::new(0.35, 0.45, -sg * (c.z.abs() * 2.0).min(1.0)).normalize()
}

fn switch_labels(id: &str) -> Option<&'static [&'static str]> {
    Some(match id {
        "StrobeLtSwtch" => &["OFF", "AUTO", "ON"],
        "BeaconLtSwtch" => &["OFF", "ON"],
        "LandingLtSwtch" | "LandingLtRSwtch" => &["RETRACT", "OFF", "ON"],
        "NavLogoLtSwtch" => &["2", "OFF", "1"],
        "SeatBeltSwtch" | "NoSmokingSwtch" => &["OFF", "AUTO", "ON"],
        "DomeLtSwtch" => &["OFF", "DIM", "BRT"],
        "ELTSw" => &["ARM", "ON"],
        _ => return None,
    })
}

/// Centres (model frame, metres) of the four FCU windows and the two EFIS BARO windows on the glareshield panel plane
/// (measured on the model, same numbers as `buildFcu` in `cockpit.ts`): `(x, y, z)` of the plane origin, panel normal.
pub const FCU_PLANE_ORIGIN: Vec3 = Vec3::new(-0.3795, 0.505, 0.0);
pub const FCU_NORMAL: Vec3 = Vec3::new(0.957, 0.289, 0.0);
/// z (model frame) of the SPD, HDG, ALT and V/S windows.
pub const FCU_WINDOW_Z: [f32; 4] = [0.0985, 0.0575, -0.0435, -0.0895];
/// EFIS BARO windows: captain (z = 0.251) and first officer (z = -0.2397), size (m).
pub const BARO_WINDOW: [(Vec3, [f32; 2]); 2] = [(Vec3::new(-0.3722, 0.4967, 0.251), [0.0306, 0.0136]), (Vec3::new(-0.3722, 0.4967, -0.2397), [0.0306, 0.0136])];
/// Character height of the FCU digits (m): the strip is 17 mm high, digits fill 68 % of it.
pub const FCU_DIGIT_H: f32 = 0.0116;

/// Display unit brightness knob -> brightness value (0..1).
pub fn brightness_of(id: &str, s: &A320Systems) -> Option<f32> {
    Some(match id {
        "ecam_brt_upper" => s.bright.uecam,
        "ecam_brt_lower" => s.bright.lecam,
        "pfd_brt_cpt" => s.bright.pfd[0],
        "pfd_brt_fo" => s.bright.pfd[1],
        "brightness_nd_2_cpt" => s.bright.nd[0],
        "brightness_nd_2_fo" => s.bright.nd[1],
        "brightness_nd_1_cpt" => s.bright.nd_outer[0],
        "brightness_nd_1_fo" => s.bright.nd_outer[1],
        _ => return None,
    })
}

/// What a glareshield / pedestal control does on an EFIS side (`EfisFn` of `cockpit.ts`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EfisFn {
    Fd,
    Ls,
    Opt(NdOpt),
    Mode,
    Range,
    Baro,
    Unit,
    Nav0,
    Nav1,
    Xfr,
    Pfd,
    Nd,
    NdOuter,
    Terr,
}

pub fn efis_fn(id: &str) -> Option<(usize, EfisFn)> {
    use EfisFn::*;
    Some(match id {
        "fd1" => (0, Fd),
        "fd2" => (1, Fd),
        "ils" => (0, Ls),
        "ils2" => (1, Ls),
        "cstr" => (0, Opt(NdOpt::Cstr)),
        "cstr.001" => (1, Opt(NdOpt::Cstr)),
        "wpt" => (0, Opt(NdOpt::Wpt)),
        "wpt.001" => (1, Opt(NdOpt::Wpt)),
        "vord" => (0, Opt(NdOpt::Vord)),
        "vord.001" => (1, Opt(NdOpt::Vord)),
        "ndb" => (0, Opt(NdOpt::Ndb)),
        "ndb.001" => (1, Opt(NdOpt::Ndb)),
        "arpt" => (0, Opt(NdOpt::Arpt)),
        "arpt.001" => (1, Opt(NdOpt::Arpt)),
        "nd_mode" => (0, Mode),
        "nd_mode_fo" => (1, Mode),
        "nd_range" => (0, Range),
        "nd_range_fo" => (1, Range),
        "qnh_cpt_knb" => (0, Baro),
        "qnh_fo_knb" => (1, Baro),
        "qnh_cpt_sw" => (0, Unit),
        "qnh_fo_sw" => (1, Unit),
        "vor-adf1" => (0, Nav0),
        "vor-adf2" => (0, Nav1),
        "vor-adf-1-right" => (1, Nav0),
        "vor-adf-2-right" => (1, Nav1),
        "pfd_nd_xfr_sw" => (0, Xfr),
        "pfd_nd_xfr_sw2" => (1, Xfr),
        "pfd_brt_cpt" => (0, Pfd),
        "pfd_brt_fo" => (1, Pfd),
        "brightness_nd_2_cpt" => (0, Nd),
        "brightness_nd_2_fo" => (1, Nd),
        "brightness_nd_1_cpt" => (0, NdOuter),
        "brightness_nd_1_fo" => (1, NdOuter),
        "terr_on_nd_l" => (0, Terr),
        "terr_on_nd_r" => (1, Terr),
        _ => return None,
    })
}

/// The ND MODE / RANGE meshes rest on their FIRST detent (LS / 10 NM): TS `KNOB_REST_DEG`, verified against a straight-on render.
pub fn knob_rest_deg(id: &str) -> f32 {
    match id {
        "nd_mode" | "nd_mode_fo" | "nd_range" | "nd_range_fo" => -90.0,
        _ => 0.0,
    }
}

/// Lever direction of the ADF / OFF / VOR switches (positive turn about the manifest axis swings the lever to the captain's left = ADF).
pub const NAV_SWITCH_SIGN: f32 = -1.0;

/// Pointer angle of an EFIS rotary (degrees clockwise from 12 o'clock): detents 45 deg apart starting at -90, brightness knobs sweep
/// 270 deg (-135 .. +135, fully anticlockwise = display OFF), the hPa / inHg ring tilts +-40 deg, the baro knob follows `baro_angle` (rad).
pub fn efis_phi_deg(func: EfisFn, e: &Efis, br: &Bright, side: usize, baro_angle: f32) -> f32 {
    match func {
        EfisFn::Mode => -90.0 + e.nd_mode as f32 * 45.0,
        EfisFn::Range => -90.0 + e.nd_range as f32 * 45.0,
        EfisFn::Baro => baro_angle.to_degrees(),
        EfisFn::Unit => if e.unit_in_hg { -40.0 } else { 40.0 },
        EfisFn::Pfd => -135.0 + 270.0 * br.pfd[side],
        EfisFn::Nd => -135.0 + 270.0 * br.nd[side],
        EfisFn::NdOuter => -135.0 + 270.0 * br.nd_outer[side],
        _ => 0.0,
    }
}

/// Mesh rotation (rad) about the manifest axis for a pointer angle. A positive turn about an axis pointing at the pilot is
/// counter-clockwise, so the clockwise pointer angle is mapped with the sign of the axis direction.
pub fn efis_knob_theta(phi_deg: f32, rest_deg: f32, axis_dir_x: f32) -> f32 {
    (if axis_dir_x > 0.0 { -1.0 } else { 1.0 }) * (phi_deg - rest_deg).to_radians()
}

/// Rotation (rad) of an ADF(-1) / OFF(0) / VOR(1) lever.
pub fn nav_lever_theta(nav: i8) -> f32 {
    NAV_SWITCH_SIGN * nav as f32 * 0.5
}

/// Hover read-out of an EFIS control (`efisText`).
pub fn efis_text(func: EfisFn, side: usize, s: &A320Systems) -> String {
    let e = &s.efis[side];
    let b = |v: f32| if v < 0.03 { "OFF".to_string() } else { format!("{} %", (v * 100.0).round()) };
    let onoff = |v: bool| if v { "ON" } else { "OFF" }.to_string();
    let nav = |v: i8| ["ADF", "OFF", "VOR"][(v + 1).clamp(0, 2) as usize].to_string();
    match func {
        EfisFn::Fd => if e.fd { "ON - bars shown" } else { "OFF - bars removed" }.into(),
        EfisFn::Ls => if e.ls { "ON - LOC/GS scales" } else { "OFF" }.into(),
        EfisFn::Opt(k) => onoff(e.opt == Some(k)),
        EfisFn::Mode => ND_MODE_NAMES[e.nd_mode.min(4)].into(),
        EfisFn::Range => format!("{} NM", ND_RANGES[e.nd_range.min(5)]),
        EfisFn::Baro => if e.std { "STD (pulled)".into() } else if e.unit_in_hg { format!("{:.2} inHg (QNH)", e.in_hg as f64 / 100.0) } else { format!("{} hPa (QNH)", e.hpa) },
        EfisFn::Unit => if e.unit_in_hg { "inHg" } else { "hPa" }.into(),
        EfisFn::Nav0 => nav(e.nav[0]),
        EfisFn::Nav1 => nav(e.nav[1]),
        EfisFn::Xfr => if e.xfr { "PFD / ND SWAPPED" } else { "NORM" }.into(),
        EfisFn::Pfd => b(s.bright.pfd[side]),
        EfisFn::Nd => b(s.bright.nd[side]),
        EfisFn::NdOuter => b(s.bright.nd_outer[side]),
        EfisFn::Terr => onoff(s.terr_on_nd[side]),
    }
}

/// Mouse hint of an EFIS control (`efisHint`); empty = use the generic hint.
pub fn efis_hint(func: EfisFn) -> &'static str {
    match func {
        EfisFn::Baro => "Wheel / drag = set pressure - left-click = PUSH (QNH) - right-click or Shift = PULL (STD)",
        EfisFn::Unit => "Click or wheel = hPa / inHg",
        EfisFn::Mode | EfisFn::Range => "Wheel / drag to rotate - click = next - right-click = previous",
        EfisFn::Nav0 | EfisFn::Nav1 => "Click: OFF -> VOR -> ADF -> OFF - right-click reverses",
        EfisFn::Pfd | EfisFn::Nd | EfisFn::NdOuter => "Wheel / drag to rotate - fully counter-clockwise = OFF",
        _ => "",
    }
}

/// Source-switching knobs on the pedestal (`SRC_KNOBS`): ATT HDG, AIR DATA, EIS DMC, ND XFR.
pub fn is_src_knob(id: &str) -> bool {
    matches!(id, "ecam_att_hdg" | "ecam_air_data" | "ecam_eis_dmc" | "ecam_nd_xfr")
}

/// Direction of a click on a 3-position source-switching knob: right-click reverses, the end stops bounce back, the middle
/// continues in the direction it last moved (`g.angle` remembers it).
pub fn src_click_dir(button: u8, pos: i32, last: f32) -> i32 {
    if button == 2 || pos >= 2 {
        -1
    } else if pos <= 0 {
        1
    } else if last < 0.0 {
        -1
    } else {
        1
    }
}
