// Interactive Airbus A320 flight deck. The 3D model is the FlightGear A320-family cockpit (GPL-2.0, see public/models/a320/NOTICE.txt):
// ~1,200 named parts in real-world metres. Static geometry is merged by material for speed; every switch / knob / lever / key stays a
// separate node that is animated about its original axis (cockpit-manifest.json). Screens are replaced by live canvases.
// Model frame: -X forward, +Y up, +Z captain's side (left). Body frame: -Z forward, +X right -> group.rotation.y = -90°.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { AircraftSpec } from './specs';
import { PanelData } from './instruments';
import { QualityPreset } from './storage';
import { loadCockpitAssets, Axis } from './a320/assets';
import { A320Systems, CockpitHost, EcamPage, THR_DETENTS, snapThrottle, thrDetentName, ND_MODE_NAMES, ND_RANGES } from './a320/systems';
import { Ctx, Mcdu, drawPFD, drawND, drawEWD, drawSD, drawISIS, drawFCU, drawBaro, drawClock } from './a320/displays';
import { PAGE_KEYS } from './a320/ecam';
import { ProceduralCockpit, CockpitInputs, CockpitUi, View } from './a320/proceduralCockpit';
import { simNowMs } from './clock';
import { describeControl } from './a320/controlInfo';
import { Efb } from './a320/efb';

export type { CockpitInputs, CockpitUi, View, CockpitHost };
export interface CockpitHover { id: string; label: string; value: string; hint: string; desc: string; }
export interface PressResult { id: string; handled: boolean; }

const EYE_M = new THREE.Vector3(0.22, 0.66, 0.52);       // captain's design eye point (model metres)
const FO_EYE_M = new THREE.Vector3(0.22, 0.66, -0.52);
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** Named camera presets: eye + look-at point in model coordinates and a vertical FOV. */
// Panel presets are built from the panel centre and its outward normal (model metres), so the camera always looks square-on at the
// panel (no skew / roll) from a distance that frames the whole panel. Eye = centre + normal * distance (see framePanel()).
const N = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();
export const COCKPIT_PANELS = {
  fcu: { c: V(-0.37, 0.485, 0.0), n: N(0.957, 0.289, 0), w: 0.5, h: 0.15 },
  pfd: { c: V(-0.556, 0.224, 0.553), n: N(1, 0.12, 0), w: 0.2, h: 0.2 },
  nd: { c: V(-0.556, 0.224, 0.353), n: N(1, 0.12, 0), w: 0.2, h: 0.2 },
  ecam: { c: V(-0.556, 0.06, -0.013), n: N(1, 0.12, 0), w: 0.2, h: 0.4 },
  instruments: { c: V(-0.55, 0.16, 0.0), n: N(1, 0.1, 0), w: 1.2, h: 0.4 },
  mcdu: { c: V(-0.41, -0.06, 0.18), n: N(0.25, 1, 0), w: 0.2, h: 0.32 },
  efb: { c: V(-0.066, 0.3311, 0.9275), n: N(0.5613, 0.1934, -0.8049), w: 0.31, h: 0.21 }, // centred on glass + bezel button column (u -40..240 mm)
} as const;
/** Named camera presets: eye + look-at point in model coordinates and a vertical FOV (pilot / seat / wide views). */
export const COCKPIT_PRESETS = {
  pilot: { eye: EYE_M, at: V(-0.6, 0.2, 0.42), fov: 68 },
  copilot: { eye: FO_EYE_M, at: V(-0.6, 0.2, -0.42), fov: 68 },
  // the overhead panel text reads with the top of the characters towards the tail: look FORWARD and up from behind the seats
  overhead: { eye: V(0.64, 0.58, 0.0), at: V(0.2, 1.1, 0.0), fov: 84 },
  pedestal: { eye: V(0.3, 0.55, 0.0), at: V(-0.05, -0.05, 0.0), fov: 56 },
} as const;
export type CockpitPanelId = keyof typeof COCKPIT_PANELS;
/** Dedicated camera-focus shortcuts (hot-bar buttons + number row 0-9 / numeric keypad). Focusing never touches a control, so zooming can no longer flip a switch. */
export const COCKPIT_FOCUS: { id: CockpitPreset; label: string; key: string }[] = [
  { id: 'pilot', label: 'Seat', key: '0' }, { id: 'fcu', label: 'FCU', key: '1' }, { id: 'pfd', label: 'PFD', key: '2' }, { id: 'nd', label: 'ND', key: '3' }, { id: 'ecam', label: 'ECAM', key: '4' },
  { id: 'mcdu', label: 'MCDU', key: '5' }, { id: 'efb', label: 'EFB', key: '6' }, { id: 'overhead', label: 'OVHD', key: '7' }, { id: 'pedestal', label: 'PED', key: '8' }, { id: 'instruments', label: 'PANEL', key: '9' },
];
export type CockpitPreset = keyof typeof COCKPIT_PRESETS | CockpitPanelId;

type Kind = 'push' | 'switch' | 'knob' | 'guard' | 'lever' | 'key' | 'stick' | 'toggle';
interface Part { node: THREE.Mesh; m0: THREE.Matrix4; }
interface Group { id: string; kind: Kind; parts: Part[]; axis?: Axis; pos: number; angle: number; press: number; label: string; steps: number; box: THREE.Box3; lamps: { node: THREE.Mesh; letter: string; row: number }[]; nrm?: THREE.Vector3;
  /** current model-space pose matrix · fallback axis derived from the bounding box · static (state-driven) control · last pose key */
  xf: THREE.Matrix4; fb?: Axis; still: boolean; lastKey: number;
  /** overhead push-button: `ovh` = lives on the overhead panel, `mom` = momentary (springs back) – every other overhead push-button latches (IN = engaged / AUTO, OUT = OFF) */
  ovh?: boolean; mom?: boolean; sgn?: number; }
/** Parts that ride on another control: the A/THR disconnect pushbuttons and the reverse flaps move with their thrust lever. */
/** Controls whose pose depends on live flight data, not just on their own switch position – never skipped by the static-pose optimisation. */
const THR_PIVOT_L: [number, number, number] = [-0.1097, -0.09, 0.0215], THR_PIVOT_R: [number, number, number] = [-0.1097, -0.09, -0.0215];
const DYNAMIC = new Set(['Lcutoff', 'Rcutoff', 'RudderTrim', 'gear_lever', 'ParkBrk', 'tiller', 'tillerFo', 'rev_l', 'rev_r', 'thr_l_button', 'thr_r_button', 'brakes_lb_psi', 'brakes_rb_psi', 'brakes_accum_psi']);
const LEADER: Record<string, string> = { thr_l_button: 'thr_l_body', thr_r_button: 'thr_r_body', rev_l: 'thr_l_body', rev_r: 'thr_r_body' };
/** Real (model-space) corners of the captain's EFB screen face – bottom-left, bottom-right, top-right, top-left as seen by the pilot. */
const EFB_CORNERS: [number, number, number][] = [[0.01997, 0.22737, 0.96257], [-0.17911, 0.264, 0.83253], [-0.17586, 0.43924, 0.87692], [0.02322, 0.40261, 1.00695]]; // exact vertices of the glass quad in the GLB (planar parallelogram)
/** Reference frame the bezel-button positions (EFB_BTNS, mm) were measured in: origin = bottom-left, u = towards bottom-right, v = towards top-left. */
const EFB_BTN_FRAME: [number, number, number][] = [[0.0200, 0.2274, 0.9626], [-0.1778, 0.2644, 0.8307], [-0.1747, 0.4396, 0.8752], [0.0245, 0.4031, 1.0052]];

/** The model's tablet bezel plate is a triangle fan that bridges the screen opening: parts of it (and a stray tilted glass quad plus a very thin sliver running
 *  corner-to-corner) sit 1-5 mm in FRONT of the live page overlay and show up as a black half-screen or a thin dark diagonal line.
 *  The live overlay replaces the glass completely, so every EFB_cpt triangle near the screen plane (within 20 mm, inside the glass rectangle +/-15 %)
 *  whose CENTROID lies inside the opening is removed. Bezel-ring triangles (centroid outside the opening), mount, buttons and housing stay. */
function stripEfbGlass(mesh: THREE.Mesh): number {
  const geo = mesh.geometry, idx = geo.index, pos = geo.attributes.position; if (!idx || !pos) return 0;
  const c = EFB_CORNERS.map((p) => new THREE.Vector3(...p)), eu = c[1].clone().sub(c[0]), ev = c[3].clone().sub(c[0]), n = new THREE.Vector3().crossVectors(eu, ev).normalize();
  const lu = eu.lengthSq(), lv = ev.lengthSq(), d = new THREE.Vector3(), P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const near = (p: THREE.Vector3) => { d.copy(p).sub(c[0]); const a = d.dot(eu) / lu, b = d.dot(ev) / lv; return a > -0.15 && a < 1.15 && b > -0.15 && b < 1.15 && Math.abs(d.dot(n)) < 0.02; };
  const keep: number[] = []; let dropped = 0;
  for (let t = 0; t < idx.count; t += 3) {
    for (let k = 0; k < 3; k++) P[k].fromBufferAttribute(pos, idx.getX(t + k));
    if (P.every(near)) { d.copy(P[0]).add(P[1]).add(P[2]).multiplyScalar(1 / 3).sub(c[0]); const a = d.dot(eu) / lu, b = d.dot(ev) / lv; if (a > 0.02 && a < 0.98 && b > 0.02 && b < 0.98) { dropped++; continue; } }
    keep.push(idx.getX(t), idx.getX(t + 1), idx.getX(t + 2));
  }
  if (dropped) geo.setIndex(keep);
  return dropped;
}
/** Bezel controls of the captain's EFB display unit, in millimetres in the screen frame (u right, v up from the bottom-left corner of the glass).
 *  Positions are the measured bounding boxes of the real button caps in the GLB (EFB_cpt, 10 triangles each; legends are quads of EFB_cpt_glare).
 *  `cap` = [u0, u1, v0, v1] of a pressable cap: it is lifted out of the baked tablet mesh and travels `travel` mm into the bezel while held.
 *  The two USB ports are fixed sockets (no travel). All hot-spots are cap + 0.5 mm. */
interface EfbBtn { id: string; u: number; v: number; w: number; h: number; label: string; desc: string; cap?: [number, number, number, number]; travel?: number; repeat?: boolean }
const EFB_BTNS: EfbBtn[] = [
  { id: 'efb_usb1', u: -26.05, v: 175.85, w: 16.6, h: 12.2, label: 'EFB USB PORT 1', desc: 'USB data port of the captain\'s EFB display unit (keyboard / data load). No device is connected in the simulator.' },
  { id: 'efb_pwr', u: -27.75, v: 154.5, w: 10.3, h: 11.2, cap: [-32.4, -23.1, 149.4, 159.6], travel: 1.2, label: 'EFB DISPLAY (PWR)', desc: 'Switches the EFB display backlight on / off. The EFB itself stays active when the backlight is off; pressing again restores the last BRT/DIM setting.' },
  { id: 'efb_brt', u: -27.75, v: 132.15, w: 10.3, h: 11.3, cap: [-32.4, -23.1, 127, 137.3], travel: 1.2, repeat: true, label: 'EFB BRT', desc: 'Increases the EFB display backlight intensity in 10 % steps. Hold to keep increasing.' },
  { id: 'efb_dim', u: -27.75, v: 118.6, w: 10.3, h: 11.2, cap: [-32.4, -23.1, 113.5, 123.7], travel: 1.2, repeat: true, label: 'EFB DIM', desc: 'Decreases the EFB display backlight intensity in 10 % steps (minimum 10 %). Hold to keep decreasing.' },
  { id: 'efb_view', u: -25.45, v: 56.85, w: 14.7, h: 11.3, cap: [-32.3, -18.6, 51.7, 62], travel: 1.4, label: 'EFB VIEW OFFSIDE', desc: 'Shows the first officer\'s (offside) EFB page on this display, read-only. Press again to return to your own EFB.' },
  { id: 'efb_usb2', u: -25.95, v: 7.85, w: 16.6, h: 12.2, label: 'EFB USB PORT 2', desc: 'Second USB data port of the captain\'s EFB display unit. No device is connected in the simulator.' },
];

// ---- naming helpers ----
const MCDU_KEYS = new Set(['init', 'f-pln', 'f-pln2', 'radnav', 'fuel-pred', 'prog', 'perf', 'data', 'dir', 'airport', 'clr', 'sp', 'left', 'right', 'up', 'down', 'opt1', 'opt2', 'overfly', '+/-', '/', '.', 'mcdu', 'sec-fpln', 'BRT', 'DIM', '']);
for (const c of 'abcdefghijklmnopqrstuvwxyz0123456789') MCDU_KEYS.add(c);
for (let i = 1; i <= 6; i++) { MCDU_KEYS.add('L' + i); MCDU_KEYS.add('R' + i); }
const ON_WHEN_IN = new Set(['APUMasterBtn', 'APUStartBtn', 'ExtPwrBtn', 'Eng1ManStartBtn', 'Eng2ManStartBtn', 'RamAirBtn', 'WingAntiIceBtn', 'Eng1AntiIceBtn', 'Eng2AntiIceBtn', 'EmerCallBtn', 'EvacCommandBtn', 'RcdrGndCtlBtn', 'ToiletBtn', 'DitchBtn', 'MaskManOnBtn']);
/** Overhead push-buttons that spring back (tests, calls, guarded one-shot actions, ACP call keys). Every other overhead push-button is a LATCHING pb-sw: IN = engaged (ON / AUTO), OUT = released (OFF). */
const MOMENTARY = /(Test|FireTst)(\.\d+)?$|Call$|^(EmerGenTest|CVRErase|EvacHornOff|DLSSys(Next|Prev|SelCtl)Btn|EltTestRst|RATMan|EmerElecManOnBtn|EmerCallBtn|APUExtReset|IDG[12]Btn|APUFireAgtBtn|Eng[12]FireAgt[12]Btn|FwdCargoDischBtn|AftCargoDischBtn)(\.\d+)?$|^audio_(reset|voice|call_\w+|att|mech)\.ovh$/;
/** Guarded controls -> their cover: the button can only be operated with the guard lifted (a click on a closed guard opens it first). */
const GUARD_OF: Record<string, string> = { EvacCommandBtn: 'EvacCommandProt', DitchBtn: 'DitchProt', Eng1ManStartBtn: 'Eng1ManStartProt', Eng2ManStartBtn: 'Eng2ManStartProt', Eng1N1Btn: 'Eng1N1Prot', Eng2N1Btn: 'Eng2N1Prot', RamAirBtn: 'RamAirBtnProt', RATMan: 'RATManGuard', EmerElecManOnBtn: 'EmerManOnGuard', EmerGenTest: 'EmerGenTestGuard', 'EmerGenTest.002': 'EmerGenTestGuard', 'EmerGenTest.003': 'EmerGenTestGuard', MaskManOnBtn: 'MaskManOnGuard', AftCargoDischBtn: 'AftCargoDischGuard', FwdCargoDischBtn: 'FwdCargoDischGuard', IDG1Btn: 'IDG1Prot', IDG2Btn: 'IDG2Prot', BlueElecPump: 'BlueElecPumpProt', EmerCallBtn: 'EmerCallProt', ELTSw: 'ELTSwGuard', firebtn1: 'Eng1FireCover', firebtn2: 'Eng2FireCover', firebtnapu: 'APUFireCover' };
/** Extinguisher agent buttons: index into A320Systems.agentDisch (ENG1 A1, A2 · ENG2 A1, A2 · APU) and the FIRE pb that arms them. */
const AGENT_IDX: Record<string, number> = { Eng1FireAgt1Btn: 0, Eng1FireAgt2Btn: 1, Eng2FireAgt1Btn: 2, Eng2FireAgt2Btn: 3, APUFireAgtBtn: 4 };
const fireOf = (agent: number) => (agent === 4 ? 2 : agent >> 1);
/** Legend text of the 3-position overhead switches, lowest lever position first (as printed on the panel, bottom -> top). */
const SWITCH_LABELS: Record<string, string[]> = { StrobeLtSwtch: ['OFF', 'AUTO', 'ON'], BeaconLtSwtch: ['OFF', 'ON'], LandingLtSwtch: ['RETRACT', 'OFF', 'ON'], LandingLtRSwtch: ['RETRACT', 'OFF', 'ON'], NavLogoLtSwtch: ['2', 'OFF', '1'], SeatBeltSwtch: ['OFF', 'AUTO', 'ON'], NoSmokingSwtch: ['OFF', 'AUTO', 'ON'], DomeLtSwtch: ['OFF', 'DIM', 'BRT'], ELTSw: ['ARM', 'ON'] };
const DEFAULT_OFF = new Set(['APUMasterBtn', 'APUStartBtn', 'ExtPwrBtn', 'Eng1ManStartBtn', 'Eng2ManStartBtn', 'RamAirBtn', 'DitchBtn', 'EvacCommandBtn', 'RcdrGndCtlBtn', 'MaskManOnBtn', 'WingAntiIceBtn', 'Eng1AntiIceBtn', 'Eng2AntiIceBtn', 'Lcutoff', 'Rcutoff']);
const SWITCH3 = new Set(['vor-adf1', 'vor-adf2', 'vor-adf-1-right', 'vor-adf-2-right', 'StrobeLtSwtch', 'LandingLtSwtch', 'LandingLtRSwtch', 'NoseLtSwtch', 'NavLogoLtSwtch', 'SeatBeltSwtch', 'NoSmokingSwtch', 'EmerExtLtSwtch', 'DomeLtSwtch', 'TurnoffLtSwtch', 'WingLtSwtch', 'AnnunciatorLtSwtch', 'CockpitDoorSwitch', 'ManVSCTLSwitch', 'DLSSysSwtch']);
const KNOB_STEPS: Record<string, number> = { IR1ModeKnb: 3, IR2ModeKnb: 3, IR3ModeKnb: 3, XbleedKnb: 3, eng_mode: 3, RudderTrim: 41, nd_mode: 5, nd_mode_fo: 5, nd_range: 6, nd_range_fo: 6, CockpitACKnb: 12, FwdCabinACKnb: 12, AftCabinACKnb: 12, ACFlowKnb: 3, LdgElevKnb: 12, LeftWiperKnb: 4, RightWiperKnb: 4, radar_mode: 4, radar_sys: 3, 'qnh_cpt_sw': 2, 'qnh_fo_sw': 2, 'alt-sel-mode': 2, 'spd-sel': 40, hdg_sel: 40, 'alt-sel': 40, 'vs-sel': 40, 'qnh_cpt_knb': 40, 'qnh_fo_knb': 40, iesi_baro_knb: 40, clock_knob: 3, LReadingLtKnb: 12, RReadingLtKnb: 12, OHPMarkLtKnb: 12 };
/** Rotary push/pull encoders of the FCU and the EFIS BARO knobs: rotate, PUSH (managed / QNH) and PULL (selected / STD). Knob angle follows the clicks (32 per turn), never the value. */
const PUSHPULL = new Set(['spd-sel', 'hdg_sel', 'alt-sel', 'vs-sel', 'qnh_cpt_knb', 'qnh_fo_knb']);
/** Two-position rings: ALT 100/1000 ft step ring, EFIS hPa/inHg ring (position 0 = left). */
const RING = new Set(['alt-sel-mode', 'qnh_cpt_sw', 'qnh_fo_sw']);
/** Initial positions that must match the system state (ADF-OFF-VOR switches rest in OFF, ND selectors in ARC / 80 NM). */
const POS0: Record<string, number> = { LeftWiperKnb: 0, RightWiperKnb: 0, LReadingLtKnb: 0, RReadingLtKnb: 0, LdgElevKnb: 0, 'alt-sel-mode': 0, qnh_cpt_sw: 1, qnh_fo_sw: 1, 'vor-adf1': 1, 'vor-adf2': 1, 'vor-adf-1-right': 1, 'vor-adf-2-right': 1, 'audio_int_rad.cpt': 1, 'audio_int_rad.fo': 1, nd_mode: 3, nd_mode_fo: 3, nd_range: 3, nd_range_fo: 3 };
const ECP_KEYS = new Set([...Object.keys(PAGE_KEYS), 'ecam_all', 'ecam_clr_l', 'ecam_clr_r', 'ecam_rcl', 'ecam_emer_canc', 'ecam_to_config']);
/** Source switching knobs (pedestal switching panel) -> field of A320Systems.switching and the legend of each position. */
const SRC_KNOBS: Record<string, { key: 'attHdg' | 'airData' | 'eisDmc' | 'ndXfr'; legend: string[] }> = {
  ecam_att_hdg: { key: 'attHdg', legend: ['CAPT 3', 'NORM', 'F/O 3'] }, ecam_air_data: { key: 'airData', legend: ['CAPT 3', 'NORM', 'F/O 3'] },
  ecam_eis_dmc: { key: 'eisDmc', legend: ['CAPT 3', 'NORM', 'F/O 3'] }, ecam_nd_xfr: { key: 'ndXfr', legend: ['CAPT', 'NORM', 'F/O'] },
};
const BRT_KNOBS: Record<string, 'uecam' | 'lecam'> = { ecam_brt_upper: 'uecam', ecam_brt_lower: 'lecam' };
const FCU_TOGGLES = new Set(['ap1', 'ap2', 'a-thr', 'appr', 'loc', 'exped', 'fd1', 'fd2', 'arpt', 'arpt.001', 'cstr', 'cstr.001', 'wpt', 'wpt.001', 'vord', 'vord.001', 'ndb', 'ndb.001', 'ils', 'ils2', 'hdg-vs', 'spd-mach', 'metric_alt', 'alt-sel-mode', 'vor-adf1', 'vor-adf2', 'vor-adf-1-right', 'vor-adf-2-right', 'master_warning', 'master_caution', 'chrono_btn', 'chrono_reset', 'abs_low', 'abs_med', 'abs_max', 'ecam_all', 'ecam_clr_l', 'ecam_clr_r', 'ecam_rcl', 'ecam_emer_canc', 'ecam_to_config', 'gear_lever', 'ParkBrk', 'rev_l', 'rev_r', 'gravity_gear', 'tiller', 'tillerFo', 'RudderTrim', 'RudderTrimReset', 'thr_l_button', 'thr_r_button', 'pfd_nd_xfr_sw', 'pfd_nd_xfr_sw2', 'terr_on_nd_l', 'terr_on_nd_r', 'iesi_btn_bugs', 'iesi_btn_ls', 'iesi_btn_minus', 'iesi_btn_plus', 'iesi_btn_rst', 'clock_set', 'et_knob', 'HeadsetHangerCpt', 'extinguisher', 'brk_fan', 'FuelXFeedBtn']);
const SCREENS: Record<string, 'pfd' | 'pfd2' | 'nd' | 'nd2' | 'uecam' | 'lecam' | 'mcdu1' | 'mcdu2' | 'isis' | 'clock'> = { 'pfd1.screen': 'pfd', 'pfd2.screen': 'pfd2', 'ND.screen': 'nd', 'ND_R.screen': 'nd2', 'uecam.screen': 'uecam', 'uecam.screen2': 'uecam', 'lecam.screen': 'lecam', 'mcdu1.screen': 'mcdu1', 'mcdu2.screen': 'mcdu2', iesi_screen: 'isis', clock_display: 'clock' };
/** EFIS control panels: control id -> side (0 CAPT, 1 F/O) and function. Every id below exists in the upstream GLB. */
type EfisFn = 'fd' | 'ls' | 'cstr' | 'wpt' | 'vord' | 'ndb' | 'arpt' | 'mode' | 'range' | 'baro' | 'unit' | 'nav0' | 'nav1' | 'xfr' | 'pfd' | 'nd' | 'ndOuter' | 'terr';
const EFIS_MAP: Record<string, { side: 0 | 1; fn: EfisFn }> = {
  fd1: { side: 0, fn: 'fd' }, fd2: { side: 1, fn: 'fd' }, ils: { side: 0, fn: 'ls' }, ils2: { side: 1, fn: 'ls' },
  cstr: { side: 0, fn: 'cstr' }, 'cstr.001': { side: 1, fn: 'cstr' }, wpt: { side: 0, fn: 'wpt' }, 'wpt.001': { side: 1, fn: 'wpt' }, vord: { side: 0, fn: 'vord' }, 'vord.001': { side: 1, fn: 'vord' },
  ndb: { side: 0, fn: 'ndb' }, 'ndb.001': { side: 1, fn: 'ndb' }, arpt: { side: 0, fn: 'arpt' }, 'arpt.001': { side: 1, fn: 'arpt' },
  nd_mode: { side: 0, fn: 'mode' }, nd_mode_fo: { side: 1, fn: 'mode' }, nd_range: { side: 0, fn: 'range' }, nd_range_fo: { side: 1, fn: 'range' },
  qnh_cpt_knb: { side: 0, fn: 'baro' }, qnh_fo_knb: { side: 1, fn: 'baro' }, qnh_cpt_sw: { side: 0, fn: 'unit' }, qnh_fo_sw: { side: 1, fn: 'unit' },
  'vor-adf1': { side: 0, fn: 'nav0' }, 'vor-adf2': { side: 0, fn: 'nav1' }, 'vor-adf-1-right': { side: 1, fn: 'nav0' }, 'vor-adf-2-right': { side: 1, fn: 'nav1' },
  pfd_nd_xfr_sw: { side: 0, fn: 'xfr' }, pfd_nd_xfr_sw2: { side: 1, fn: 'xfr' },
  pfd_brt_cpt: { side: 0, fn: 'pfd' }, pfd_brt_fo: { side: 1, fn: 'pfd' }, brightness_nd_2_cpt: { side: 0, fn: 'nd' }, brightness_nd_2_fo: { side: 1, fn: 'nd' }, brightness_nd_1_cpt: { side: 0, fn: 'ndOuter' }, brightness_nd_1_fo: { side: 1, fn: 'ndOuter' },
  terr_on_nd_l: { side: 0, fn: 'terr' }, terr_on_nd_r: { side: 1, fn: 'terr' },
};
/** Lever direction of the ADF / OFF / VOR switches (positive turn about the manifest axis swings the lever to the captain's left = ADF). */
const NAV_SWITCH_SIGN = -1;
const OPT_FN = new Set<string>(['cstr', 'wpt', 'vord', 'ndb', 'arpt']);
/** Pointer angle (degrees clockwise from 12 o'clock) of each knob's mesh at rest, measured from the model's pointer mark. */
const KNOB_REST_DEG: Record<string, number> = { nd_mode: -90, nd_mode_fo: -90, nd_range: -90, nd_range_fo: -90 };   // verified against a straight-on render: the mesh rests on its first detent (LS / 10 NM)
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const briOf = (b: number) => (b < 0.03 ? 0 : Math.min(1, 0.35 + 0.8 * b));
const HIDE = /^hud|hud_|\.tmp$|^dummy|glass|^fcu_hud\.plug|ovh_eng_iae|glare_ovh_eng_iae|fcu_labels_hud|^visor_glass|^WindowGlass/i;
const FCU_IND = new Set(['spd.ind', 'hdg.ind', 'alt.ind', 'vs.ind', 'lvlch.ind', 'mach.ind', 'trk.ind', 'trk2.ind', 'fpa.ind', 'fpa.ind.001', 'vs.ind.001', 'hdg2.ind', 'spd.dash', 'lat.dash', 'vs.dash', 'ver.fmgc', 'lat.fmgc', 'spd.fmgc']);
const prettify = (n: string) => n.replace(/(Btn|Knb|Swtch|Switch)$/, '').replace(/\.(cpt|fo)$/, m => (m === '.cpt' ? ' (CAPT)' : ' (F/O)')).replace(/[_-]/g, ' ').replace(/([a-z])([A-Z0-9])/g, '$1 $2').toUpperCase();

function flatten(src: THREE.BufferGeometry, mat: THREE.Matrix4): THREE.BufferGeometry {
  // Always emits position + normal + uv + 32-bit index so every geometry can be merged regardless of how the GLB stored it.
  const out = new THREE.BufferGeometry(); const pos = src.attributes.position, n = pos.count;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), U = new Float32Array(n * 2), nrm = src.attributes.normal, uv = src.attributes.uv;
  for (let i = 0; i < n; i++) {
    P[i * 3] = pos.getX(i); P[i * 3 + 1] = pos.getY(i); P[i * 3 + 2] = pos.getZ(i);
    if (nrm) { N[i * 3] = nrm.getX(i); N[i * 3 + 1] = nrm.getY(i); N[i * 3 + 2] = nrm.getZ(i); } else N[i * 3 + 1] = 1;
    if (uv) { U[i * 2] = uv.getX(i); U[i * 2 + 1] = uv.getY(i); }
  }
  out.setAttribute('position', new THREE.BufferAttribute(P, 3)); out.setAttribute('normal', new THREE.BufferAttribute(N, 3)); out.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  const idx = src.index; const I = new Uint32Array(idx ? idx.count : n);
  if (idx) for (let i = 0; i < idx.count; i++) I[i] = idx.getX(i); else for (let i = 0; i < n; i++) I[i] = i;
  out.setIndex(new THREE.BufferAttribute(I, 1)); out.applyMatrix4(mat); return out;
}

/** Canvas side lengths a display may use; the scheduler picks the smallest that still gives one texel per device pixel. */
const RES_TIERS = [384, 512, 768, 1024, 1536, 2048];
/** A live display: its own canvas texture, repaint period, priority and adaptive resolution. */
class Screen {
  canvas = document.createElement('canvas'); tex: THREE.CanvasTexture; mat: THREE.MeshBasicMaterial; next = 0; meshes: THREE.Mesh[] = [];
  res: number; vis = false; px = 0; lowSince = 0; urgency = 0; idx = 0; sphere = new THREE.Sphere();
  constructor(public key: string, public maxRes: number, public period: number, public aspect: number, public prio: number, public draw: (g: CanvasRenderingContext2D, W: number, H: number) => void) {
    this.res = Math.min(maxRes, 768); this.canvas.width = this.res; this.canvas.height = Math.round(this.res / aspect);
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.flipY = false; this.tex.colorSpace = THREE.SRGBColorSpace; this.tex.anisotropy = 8; this.tex.generateMipmaps = true; this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false });
  }
  /** Resize the backing canvas (the GPU texture is re-allocated on the next upload). */
  setRes(r: number) { if (r === this.res) return; this.res = r; this.canvas.width = r; this.canvas.height = Math.round(r / this.aspect); this.tex.dispose(); this.next = 0; }
  render() { const g = this.canvas.getContext('2d', { alpha: false })!; g.save(); this.draw(g, this.canvas.width, this.canvas.height); g.restore(); this.tex.needsUpdate = true; }
}

export class Cockpit {
  scene = new THREE.Scene(); group = new THREE.Group(); root = new THREE.Group();
  camera = new THREE.PerspectiveCamera(68, 1, 0.02, 80);
  views: Record<'cockpit' | 'aisle' | 'window', View>;
  interactive: THREE.Object3D[] = []; readonly cabinHeads: THREE.Object3D[] = [];
  /** Radio management panels (CAPT / F/O): power, selected radio, BFO / AM. Audio control panels: receive keys + the selected transmit key. */
  private rmp = [{ on: true, sel: 'vhf1', bfo: false, am: false }, { on: true, sel: 'vhf2', bfo: false, am: false }];
  private acp = [{ rx: { vhf1: true, int: true } as Record<string, boolean>, tx: 'vhf1' }, { rx: { vhf2: true, int: true } as Record<string, boolean>, tx: 'vhf2' }];
  private dtA = 0.016; private rudSm = 0; private mstSm: number[] = [0, 0];
  host?: CockpitHost; sys = new A320Systems(); mcdu = [new Mcdu(), new Mcdu()];
  ready: Promise<void>; loaded = false; fallback?: ProceduralCockpit; daylight = 1;
  zoom = 1; private zoomT = 1; private fovCur = 68; private fovT = 68;
  private groups = new Map<string, Group>(); private byNode = new Map<THREE.Object3D, Group>(); private lampNodes: { node: THREE.Mesh; base: string; kind: 'led' | 'leg'; letter: string; row: number; m0?: THREE.Matrix4 }[] = [];
  private fcuInd = new Map<string, THREE.Mesh>(); private baro: { cv: HTMLCanvasElement; tex: THREE.CanvasTexture; key: string; side: 0 | 1 }[] = []; private slideDir = new Map<string, number>();
  private screenDefs: Record<string, Screen> = {}; private screenMesh: Map<string, THREE.Mesh> = new Map();
  private screens: Screen[] = []; private fcuCanvas?: HTMLCanvasElement; private fcuTex?: THREE.CanvasTexture; private fcuKey = '';
  private hemi = new THREE.HemisphereLight(0xffffff, 0x777777, 2); private sun = new THREE.DirectionalLight(0xffffff, 1.6);
  private cur = { pos: new THREE.Vector3(), yaw: 0, pitch: 0 }; private t = new THREE.Vector3(); private tBody = new THREE.Vector3();
  private active: { g: Group; sy: number; acc: number; v0: number; kind: string } | null = null; 
  private lastInp?: CockpitInputs; private ctx!: Ctx; private frustum = new THREE.Frustum(); private pv = new THREE.Matrix4();
  private fcuZ = { c: 0, w: 1 };

  constructor(public spec: AircraftSpec, private quality: QualityPreset) {
    const [ex, ey, ez] = spec.eye;
    this.views = { cockpit: { pos: new THREE.Vector3(ex, ey, ez), yaw: 0, pitch: -0.1 }, aisle: { pos: new THREE.Vector3(ex, ey, ez), yaw: 0, pitch: -0.1 }, window: { pos: new THREE.Vector3(ex, ey, ez), yaw: 0, pitch: -0.1 } };
    this.scene.add(this.group, this.hemi, this.sun); this.sun.position.set(-2, 4, -3);
    this.group.add(this.root);
    // model -> body frame (see header)
    this.group.rotation.y = -Math.PI / 2; this.group.position.set(ex + EYE_M.z, ey - EYE_M.y, ez - EYE_M.x);
    this.ready = this.load().catch((e) => { console.warn('[cockpit] GLB unavailable, using procedural flight deck', e); this.fallback = new ProceduralCockpit(spec, quality); this.fallback.camera.aspect = this.camera.aspect; });
  }

  /** The scene the game renders (procedural fallback if the model could not be loaded). */
  get activeScene() { return this.fallback ? this.fallback.scene : this.scene; }
  get activeCamera() { return this.fallback ? this.fallback.camera : this.camera; }

  private async load() {
    const { scene: model, manifest } = await loadCockpitAssets();
    this.root.add(model); model.updateMatrixWorld(true);
    // GLTFLoader sanitises node names (drops '.'), but every control id below uses the ORIGINAL glTF name (e.g. 'pfd1.screen', 'ap1.cpt'):
    model.traverse((o) => { const u = o.userData as { name?: string; sourceName?: string }; const real = u.name || u.sourceName; if (real) o.name = real; });
    model.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.name === 'EFB_cpt') stripEfbGlass(o as THREE.Mesh); });
    this.extractEfbCaps(model);
    this.efbFo.page = 'PLAN'; this.efbFo.readOnly = true; this.efbFo.banner = 'OFFSIDE · F/O EFB (read-only)';
    const maxA = 16; const nodes = new Map<string, THREE.Mesh>(); const all: THREE.Mesh[] = [];
    model.traverse((o) => { if ((o as THREE.Mesh).isMesh) { const m = o as THREE.Mesh; all.push(m); nodes.set(m.name, m); const mt = m.material as THREE.MeshStandardMaterial; if (mt.map) { mt.map.anisotropy = maxA; mt.map.needsUpdate = true; } } });
    // ---- classify ----
    const legendRe = /^(\d)([A-Z])(\.\d+)?$/;
    const baseOfLegend = (name: string) => { for (let n = name.length - 2; n > 2; n--) { const b = name.slice(0, n); if (nodes.has(b) && legendRe.test(name.slice(n))) return { base: b, row: +name[n], letter: name[n + 1] }; } return null; };
    const isLed = (n: string) => /(_led|_on|_lit|_illuminated)(\.\w+)?$/.test(n) && !/^radio_on/.test(n) && !/_on$/.test(n.replace(/^abs_|^dec_/, 'x')) || /^(abs_(low|med|max)_on|dec_(low|med|max)_on|master_(warning|caution)_on|autoland_light_on|ecam_emer_canc_lit|EltLed|IrsOnBatLight|brk_(hot|fan)_on|terr_on_nd_on_[lr]|gpws_gs_sw_(gpws|gs)_on)/.test(n);
    const groups = this.groups; const used = new Set<THREE.Mesh>();
    const mkGroup = (id: string, kind: Kind): Group => { let g = groups.get(id); if (!g) { g = { id, kind, parts: [], axis: manifest.axes[id + '.axis'], pos: 0, angle: 0, press: 0, label: prettify(id), steps: KNOB_STEPS[id] ?? 12, box: new THREE.Box3(), lamps: [], xf: new THREE.Matrix4(), still: !DYNAMIC.has(id) && (kind === 'push' || kind === 'switch' || kind === 'guard' || kind === 'key'), lastKey: NaN }; groups.set(id, g); } return g; };
    const addPart = (g: Group, m: THREE.Mesh) => { m.updateMatrix(); m.matrixAutoUpdate = false; g.parts.push({ node: m, m0: m.matrix.clone() }); used.add(m); const b = new THREE.Box3().setFromObject(m); g.box.union(b); };
    for (const m of all) {
      const n = m.name; if (HIDE.test(n)) { m.visible = false; used.add(m); continue; }
      if (/^batt_voltage\.canvas\.[LR]$/.test(n)) { this.battMesh.push({ mesh: m, side: n.endsWith('R') ? 1 : 0, key: '' }); used.add(m); continue; }
      if (SCREENS[n]) continue; if (FCU_IND.has(n)) { this.fcuInd.set(n, m); m.visible = false; used.add(m); continue; }
      if (/^mcdu_ann_\w+\.(cpt|fo)$/.test(n) || /^engine_(fire|fault)_[12]$/.test(n) || n === 'thr_quad_lts') { this.lampNodes.push({ node: m, base: n, kind: 'led', letter: '', row: 0 }); m.visible = false; used.add(m); continue; }
      if (/^(audio|radio)_\w+_glare\.(cpt|fo)$/.test(n)) { this.lampNodes.push({ node: m, base: n.replace('_glare', ''), kind: 'led', letter: '', row: 0 }); m.visible = false; used.add(m); continue; }
      const leg = baseOfLegend(n);
      if (leg) { this.lampNodes.push({ node: m, base: leg.base, kind: 'leg', letter: leg.letter, row: leg.row }); used.add(m); continue; }
      const lb = n.match(/^(.*?)_(?:led|lit)(\.cpt|\.fo|\.ovh)?(\.\d+)?$/);
      if (lb || isLed(n)) { this.lampNodes.push({ node: m, base: lb ? lb[1] + (lb[2] ?? (/^(arpt|cstr|wpt|vord|ndb)$/.test(lb[1]) ? (lb[3] ?? '') : '')) : n.replace(/(_led|_on|_lit|_illuminated)(\.\w+)?$/, ''), kind: 'led', letter: '', row: 0 }); m.visible = false; used.add(m); continue; }
      if (n === 'atc_screen' || n === 'main_panel_screen') { used.add(m); continue; }
    }
    for (const m of all) {
      if (used.has(m) || SCREENS[m.name]) continue; const n = m.name;
      const key = n.replace(/\.(cpt|fo|ovh)$/, ''), side = /\.fo$/.test(n) ? 'fo' : 'cpt';
      let kind: Kind | null = null, id = n;
      const im = /^audio_int_rad\.mark\.(cpt|fo)$/.exec(n); if (im) { addPart(mkGroup('audio_int_rad.' + im[1], 'switch'), m); continue; }
      if (/\.mark(\.ovh)?$/.test(n) && nodes.has(n.replace(/\.mark/, ''))) { const g = mkGroup(n.replace(/\.mark/, ''), 'knob'); addPart(g, m); continue; }
      if (/\.cpt$|\.fo$/.test(n) && MCDU_KEYS.has(key)) { kind = 'key'; id = (side === 'fo' ? 'F:' : 'C:') + key; }
      else if (/(Knb)$/.test(n) || n in KNOB_STEPS || /^(brightness_|pfd_brt|ecam_brt|speaker_volume|lt_knb|flood_lt_main$|flood_lt_ped$|integ_lt$|fcu_integ_knb|light_console|nd_range|nd_mode|radar_(gain|tilt|gcs)|audio_pa_rot|radio_rot)/.test(n)) kind = 'knob';
      else if (/Swtch$|Switch$|^ELTSw$/.test(n) || SWITCH3.has(n) || /^pfd_nd_xfr_sw2?$/.test(n) || /_sw$|_sw\.(cpt|fo)$|^qnh_(cpt|fo)_sw$|^(land_sw|NoseLtSwtch|trim_?\w*)$/.test(n)) kind = 'switch';
      else if (/(Guard|Prot|Cover)(\.\d+)?$/.test(n) || /^(APUFireCover|Eng[12]FireCover)$/.test(n)) kind = 'guard';
      else if (/Btn$/.test(n) || /^(BatteryBtn\d|GreenEngPump2|YellowEngPump|BlueElecPump|YellowElecPump|PTU2|RATMan|EltTestRst|APUExtReset)$/.test(n) || /^audio_[a-z0-9_]+\.ovh$/.test(n) && !/(_glare|_led|_sgn|_rot|\.mark|_int_rad)\./.test(n) || /^(OVH_button\.\d+|ecam_(?!.*(_led|_lit)$)\w+|firebtn\w*|PedestalFireBtn\.(cpt|fo)|EmerGenTest(\.\d+)?|Eng[12]FireTst|APUFireTst|CVR\w+|\w+Call|EvacHornOff|EvacCapt-Purs|SEC\dBtn|CargoSmkTest|LeftRainTest|RightRainTest|DLSSys(Next|Prev|SelCtl)Btn|atc_\w+|radio_\w+|audio_\w+|\w+\.(cpt|fo))$/.test(n) || FCU_TOGGLES.has(n) || /^(spd-sel|hdg_sel|alt-sel|vs-sel)$/.test(n)) kind = 'push';
      else if (/^(gear_lever|FlapsLever|SpdBrk|ParkBrk|thr_[lr]_body|Lcutoff|Rcutoff|eng_mode)$/.test(n)) kind = 'lever';
      else if (/^sidestick_[12]/.test(n)) { kind = 'stick'; id = 'stick'; }
      if (/(_led|_on|_lit|_glare|_illuminated)(\.\w+)?$|\.mark$|^audio_.*(_led|_glare|_sgn)/.test(n) || /^(brk_|ecam_.*_led)/.test(n)) kind = kind === 'knob' ? kind : null;
      if (/^radio_on\.(cpt|fo)$/.test(n) || /^radar_(multiscan|pws)$/.test(n) || n === 'CockpitDoorVideoButton') kind = 'push';   // RMP ON/OFF, weather-radar MULTISCAN / PWS, door video
      if (/^audio_int_rad\.(cpt|fo)$/.test(n)) kind = 'switch';                                                                          // ACP INT / OFF / RAD 3-position switch
      if (!kind) continue;
      if (kind === 'lever' && /^FlapsLever_low$/.test(n)) continue;
      const g = mkGroup(id, kind); addPart(g, m);
    }
    // legends & marks follow their button
    for (const l of this.lampNodes) { if (l.kind === 'leg') { const g = groups.get(l.base); if (g) { g.lamps.push({ node: l.node, letter: l.letter, row: l.row }); this.cloneMat(l.node); addPart(g, l.node); } } }
    for (const g of groups.values()) {
      { const c0 = g.box.getCenter(new THREE.Vector3()); g.ovh = g.kind === 'push' && c0.y > 0.78 && c0.x > -0.3; g.mom = !!g.ovh && MOMENTARY.test(g.id); }
      g.label = g.id.startsWith('C:') ? `MCDU KEY ${(g.id.slice(2) || '.').toUpperCase()}` : g.id.startsWith('F:') ? `MCDU KEY ${(g.id.slice(2) || '.').toUpperCase()} (F/O)` : prettify(g.id);
      if (g.kind === 'stick') g.label = 'SIDESTICK';
      for (const p of g.parts) this.interactive.push(p.node);
      if (!ON_WHEN_IN.has(g.id) && !DEFAULT_OFF.has(g.id)) g.pos = 1; else g.pos = 0; if (g.kind === 'switch' || g.kind === 'guard') g.pos = 0; /* guard covers start CLOSED */ if (g.kind === 'knob' && g.steps >= 12 && g.steps < 40) g.pos = 6; if (g.ovh && /^audio_/.test(g.id)) g.pos = 0; if (g.id in POS0) g.pos = POS0[g.id];
      for (const p of g.parts) this.byNode.set(p.node, g);
    }
    // lamp nodes (LEDs) default hidden; legends keep texture
    // ---- merge static geometry ----
    const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>(); const lampSet = new Set(this.lampNodes.map((l) => l.node));
    const toRemove: THREE.Mesh[] = []; const rel = new THREE.Matrix4();
    for (const m of all) {
      if (used.has(m) && !lampSet.has(m)) { if (HIDE.test(m.name) || FCU_IND.has(m.name)) { m.visible = false; } else if (this.byNode.has(m)) continue; }
      if (this.byNode.has(m) || lampSet.has(m) || SCREENS[m.name] || !m.visible || this.battMesh.some((b) => b.mesh === m)) continue;
      m.updateWorldMatrix(true, false); const arr = byMat.get(m.material as THREE.Material) ?? []; arr.push(flatten(m.geometry, rel.copy(this.root.matrixWorld).invert().multiply(m.matrixWorld))); /* model space, relative to this.root */ byMat.set(m.material as THREE.Material, arr); toRemove.push(m);
    }
    for (const m of toRemove) { m.parent?.remove(m); m.geometry.dispose(); }
    const merged = new THREE.Group();
    for (const [mat, geos] of byMat) { const g = mergeGeometries(geos, false); if (!g) { console.warn('[cockpit] merge failed for', (mat as THREE.Material).name); continue; } const mesh = new THREE.Mesh(g, mat); mesh.matrixAutoUpdate = false; mesh.frustumCulled = false; merged.add(mesh); for (const x of geos) x.dispose(); }
    this.root.add(merged);
    // ---- screens ----
    this.buildScreens(nodes);
    // ---- FCU overlay (digits) ----
    this.buildFcu(nodes); this.buildEfb(); this.buildBatt();
    this.ctx = { d: null as unknown as PanelData, sys: this.sys, host: null as unknown as CockpitHost, t: 0, mcdu: this.mcdu[0], utc: new Date() };
    this.collectMaskMats();
    const lead = new Set(Object.values(LEADER)); this.animOrder = [...this.groups.values()].sort((a, b) => (lead.has(b.id) ? 1 : 0) - (lead.has(a.id) ? 1 : 0));
    for (const g of this.animOrder) if (LEADER[g.id]) g.still = false; // followers ride on moving levers
    this.loaded = true; this.setPreset('pilot', true);
  }

  private cloneMat(m: THREE.Mesh) { const mt = (m.material as THREE.MeshStandardMaterial).clone(); mt.emissiveMap = mt.map; mt.emissive = new THREE.Color(0, 0, 0); m.material = mt; }

  private buildScreens(nodes: Map<string, THREE.Mesh>) {
    const q = this.quality, big = q === 'ultra' ? 2048 : q === 'high' ? 1536 : q === 'medium' ? 1024 : 768, mid = q === 'ultra' || q === 'high' ? 1024 : q === 'medium' ? 768 : 512;
    // repaint rates: PFD 30 Hz (smooth tapes / horizon) · ND 20 Hz · E/WD, SD 15 Hz · ISIS 20 Hz · MCDU 8 Hz · clock 2 Hz – the old code repainted everything at 8-24 Hz at full 2K
    const mk = (key: string, maxRes: number, hz: number, prio: number, draw: Screen['draw'], aspect = 1) => { const s = new Screen(key, maxRes, 1 / hz, aspect, prio, draw); s.idx = this.screens.length; this.screens.push(s); return s; };
    const C = () => this.ctx;
    const defs: Record<string, Screen> = {
      pfd: mk('pfd', big, 30, 3, (g, W, H) => (this.sys.efis[0].xfr ? drawND(g, W, H, C(), 0) : drawPFD(g, W, H, C(), 0))), nd: mk('nd', big, 20, 2, (g, W, H) => (this.sys.efis[0].xfr ? drawPFD(g, W, H, C(), 0) : drawND(g, W, H, C(), 0))),
      pfd2: mk('pfd2', big, 30, 3, (g, W, H) => (this.sys.efis[1].xfr ? drawND(g, W, H, C(), 1) : drawPFD(g, W, H, C(), 1))), nd2: mk('nd2', big, 20, 2, (g, W, H) => (this.sys.efis[1].xfr ? drawPFD(g, W, H, C(), 1) : drawND(g, W, H, C(), 1))),
      uecam: mk('uecam', mid, 15, 1.5, (g, W, H) => drawEWD(g, W, H, C())), lecam: mk('lecam', mid, 15, 1.2, (g, W, H) => (this.sys.duOn('uecam') ? drawSD(g, W, H, C()) : drawEWD(g, W, H, C()))),
      mcdu1: mk('mcdu1', mid, 8, 1, (g, W, H) => this.mcdu[0].draw(g, W, H, C())), mcdu2: mk('mcdu2', mid, 8, 1, (g, W, H) => this.mcdu[1].draw(g, W, H, C())),
      isis: mk('isis', 768, 20, 1.6, (g, W, H) => drawISIS(g, W, H, C())), clock: mk('clock', 512, 2, 0.5, (g, W, H) => drawClock(g, W, H, C())),
    };
    this.screenDefs = defs;
    for (const [name, key] of Object.entries(SCREENS)) { const m = nodes.get(name); if (!m) continue; const s = defs[key]; m.material = s.mat; s.meshes.push(m); this.screenMesh.set(name, m); if (name === 'uecam.screen2') m.visible = false; }
  }
  // ====================================================================== BAT 1 / BAT 2 voltage windows (ELEC panel)
  private battMesh: { mesh: THREE.Mesh; side: 0 | 1; key: string; cv?: HTMLCanvasElement; tex?: THREE.CanvasTexture }[] = [];
  private buildBatt() {
    for (const b of this.battMesh) {
      const cv = document.createElement('canvas'); cv.width = 192; cv.height = 76; const tex = new THREE.CanvasTexture(cv); tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      b.cv = cv; b.tex = tex; b.mesh.material = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, side: THREE.DoubleSide });   // one window quad is wound the other way round
    }
  }
  /** Live battery voltage (28 V nominal; reads 0 with the battery pb OFF): green 7-segment-style digits on black, repainted only when the reading changes. */
  private drawBatt(s: A320Systems) {
    for (const b of this.battMesh) {
      if (!b.cv || !b.tex) continue; const v = s.batV[b.side], txt = v > 1 ? v.toFixed(1) : '', key = txt; if (key === b.key) continue; b.key = key;
      const g = b.cv.getContext('2d')!; g.fillStyle = '#050805'; g.fillRect(0, 0, b.cv.width, b.cv.height);
      g.fillStyle = '#69ff8a'; g.font = 'bold 50px "Courier New", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.shadowColor = '#3dff6a'; g.shadowBlur = 8; if (txt) g.fillText(txt, b.cv.width / 2, b.cv.height / 2 + 3);
      b.tex.needsUpdate = true;
    }
  }


  private buildFcu(nodes: Map<string, THREE.Mesh>) {
    // strip aligned with the original seven-segment meshes (model coords; panel normal = (0.957, 0.289, 0))
    const zc = -0.0005, w = 0.25, h = 0.017; // plane wider than the 3 windows so no digit is clipped
    this.fcuZ = { c: zc, w }; // (was swallowed by the comment above -> digit positions were mapped against c=0, w=1 and drawn misaligned)
    const cv = document.createElement('canvas'); cv.width = 2048; cv.height = Math.round(2048 * h / w) + 0; const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 16;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
    const n = new THREE.Vector3(0.957, 0.289, 0).normalize(), up = new THREE.Vector3(-0.289, 0.957, 0), xa = new THREE.Vector3(0, 0, -1);
    const m = new THREE.Matrix4().makeBasis(xa, up, n); mesh.quaternion.setFromRotationMatrix(m); mesh.position.set(-0.3795 + n.x * 0.0012, 0.505 + n.y * 0.0012, zc); mesh.renderOrder = 5;
    this.root.add(mesh); this.fcuCanvas = cv; this.fcuTex = tex; void nodes;
    // EFIS BARO windows (blank in the model): centres / sizes measured on the panel, same plane as the FCU strip
    for (let i = 0; i < 2; i++) {
      const z = i === 0 ? 0.251 : -0.2397;
      const bc = document.createElement('canvas'); bc.width = 256; bc.height = 112; const bt = new THREE.CanvasTexture(bc); bt.colorSpace = THREE.SRGBColorSpace; bt.anisotropy = 8;
      const bm = new THREE.Mesh(new THREE.PlaneGeometry(0.0306, 0.0136), new THREE.MeshBasicMaterial({ map: bt, transparent: true, depthWrite: false, toneMapped: false }));
      bm.quaternion.setFromRotationMatrix(m); bm.position.set(-0.3722 + n.x * 0.0008, 0.4967 + n.y * 0.0008, z); bm.renderOrder = 5; this.root.add(bm); this.baro.push({ cv: bc, tex: bt, key: '', side: i as 0 | 1 });
    }
  }

  // ====================================================================== EFB tablet (captain's side window mount)
  efb = new Efb(); efbFo = new Efb(); efbPower = true; efbBright = 1; efbOffside = false; private efbBtnMeshes: THREE.Mesh[] = []; private efbFlash = new Map<string, number>();
  /** Pressable bezel caps lifted out of the tablet mesh: group = cap + legend, `pos` 0 (released) .. 1 (fully pressed), `vel` for the spring. */
  private efbCaps = new Map<string, { group: THREE.Group; travel: number; pos: number; vel: number }>();
  /** Button currently held down by the pointer (BRT / DIM auto-repeat while held). */
  private efbHeld: { id: string; t: number; rep: number } | null = null; private efbFn = new THREE.Vector3(0, 0, 1);
  private efbFrame() {
    const fc = EFB_BTN_FRAME.map((p) => new THREE.Vector3(...p)), eu = fc[1].clone().sub(fc[0]).normalize(), ev = fc[3].clone().sub(fc[0]).normalize();
    return { fc, eu, ev, fn: new THREE.Vector3().crossVectors(eu, ev).normalize() };
  }
  /** The bezel buttons are baked into EFB_cpt (each cap = 10 triangles) and their legends into EFB_cpt_glare (2 triangles). Lift every pressable cap + legend out
   *  into its own group so it can physically travel into the bezel along the screen normal. A cap is only extracted when exactly 10 + 2 triangles are found
   *  (otherwise the baked geometry stays untouched and the button falls back to the flash hot-spot). */
  private extractEfbCaps(model: THREE.Object3D) {
    let body: THREE.Mesh | undefined, glare: THREE.Mesh | undefined;
    model.traverse((o) => { if (!(o as THREE.Mesh).isMesh) return; if (o.name === 'EFB_cpt') body = o as THREE.Mesh; else if (o.name === 'EFB_cpt_glare') glare = o as THREE.Mesh; });
    if (!body || !glare) return;
    this.root.updateWorldMatrix(true, true);
    const { fc, eu, ev, fn } = this.efbFrame(), inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert(), d = new THREE.Vector3(), v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this.efbFn.copy(fn);
    const caps = EFB_BTNS.filter((b) => b.cap);
    const scan = (mesh: THREE.Mesh, wLo: number, wHi: number) => {
      const found = new Map<string, number[]>(), idx = mesh.geometry.index!, pos = mesh.geometry.attributes.position, rel = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
      for (let t = 0; t < idx.count; t += 3) {
        for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(pos, idx.getX(t + k)).applyMatrix4(rel);
        for (const c of caps) {
          const [u0, u1, v0, v1] = c.cap!;
          if (v.every((p) => { d.copy(p).sub(fc[0]); const u = d.dot(eu) * 1000, vv = d.dot(ev) * 1000, w = d.dot(fn) * 1000; return u >= u0 - 0.6 && u <= u1 + 0.6 && vv >= v0 - 0.6 && vv <= v1 + 0.6 && w > wLo && w < wHi; })) { (found.get(c.id) ?? found.set(c.id, []).get(c.id)!).push(t); break; }
        }
      }
      return found;
    };
    const fBody = scan(body, 2, 8), fGlare = scan(glare, 5, 10);
    const build = (mesh: THREE.Mesh, tris: number[]) => {
      const g = mesh.geometry, idx = g.index!, pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv, rel = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld), nm = new THREE.Matrix3().getNormalMatrix(rel);
      const P: number[] = [], Nn: number[] = [], U: number[] = [], t3 = new THREE.Vector3();
      for (const t of tris) for (let k = 0; k < 3; k++) { const i = idx.getX(t + k); t3.fromBufferAttribute(pos, i).applyMatrix4(rel); P.push(t3.x, t3.y, t3.z); t3.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); Nn.push(t3.x, t3.y, t3.z); U.push(uv.getX(i), uv.getY(i)); }
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
      const m = new THREE.Mesh(geo, mesh.material); m.frustumCulled = false; return m;
    };
    const drop = (mesh: THREE.Mesh, tris: Set<number>) => { const idx = mesh.geometry.index!, keep: number[] = []; for (let t = 0; t < idx.count; t += 3) if (!tris.has(t)) keep.push(idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)); mesh.geometry.setIndex(keep); };
    const dropB = new Set<number>(), dropG = new Set<number>();
    for (const c of caps) {
      const tb = fBody.get(c.id), tg = fGlare.get(c.id);
      if (!tb || tb.length !== 10 || !tg || tg.length !== 2) { console.warn('[cockpit] EFB cap', c.id, 'not extracted', tb?.length, tg?.length); continue; }
      const grp = new THREE.Group(); grp.name = 'efbcap_' + c.id; grp.add(build(body, tb), build(glare, tg)); this.root.add(grp);
      tb.forEach((t) => dropB.add(t)); tg.forEach((t) => dropG.add(t));
      this.efbCaps.set(c.id, { group: grp, travel: (c.travel ?? 1.2) / 1000, pos: 0, vel: 0 });
    }
    if (dropB.size) drop(body, dropB); if (dropG.size) drop(glare, dropG);
  }
  private get efbShown() { return this.efbOffside ? this.efbFo : this.efb; }
  private efbMesh?: THREE.Mesh; private efbCanvas?: HTMLCanvasElement; private efbTex?: THREE.CanvasTexture; private efbNext = 0;
  /** Overlay the live EFB page exactly on the glass of the model's tablet (EFB_cpt). The four corners are the real (slightly non-coplanar, 9.3° rotated)
   *  vertices of the screen face, decoded from the GLB, so the page can neither skew nor sit behind the bezel. Model coordinates (m). */
  private buildEfb() {
    const cv = document.createElement('canvas'); cv.width = Efb.W; cv.height = Efb.H;
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 16; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
    const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const c = EFB_CORNERS.map((p) => new THREE.Vector3(...p)); // BL, BR, TR, TL as seen by the pilot
    const ctr = c[0].clone().add(c[1]).add(c[2]).add(c[3]).multiplyScalar(0.25), n = new THREE.Vector3().crossVectors(c[1].clone().sub(c[0]), c[3].clone().sub(c[0])).normalize();
    const inset = 0.992, lift = 0.003, pos: number[] = [];
    for (const p of c) { const q = p.clone().sub(ctr).multiplyScalar(inset).add(ctr).addScaledVector(n, lift); pos.push(q.x, q.y, q.z); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2)); geo.setIndex([0, 1, 3, 1, 2, 3]); /* same TL-BR diagonal as the real glass, so the slightly non-planar quad can never show a seam */ geo.computeVertexNormals(); geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat); mesh.renderOrder = 4; mesh.name = 'efb_screen'; mesh.frustumCulled = false;
    this.root.add(mesh); this.efbMesh = mesh; this.efbCanvas = cv; this.efbTex = tex;
    // bezel hot-spots, registered to the real button caps (frame: u along the bottom edge, v up the left edge, w out of the glass)
    const { fc, eu, ev, fn } = this.efbFrame(), q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(eu, ev, fn));
    for (const b of EFB_BTNS) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(b.w / 1000, b.h / 1000), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      m.position.copy(fc[0]).addScaledVector(eu, b.u / 1000).addScaledVector(ev, b.v / 1000).addScaledVector(fn, 0.006); m.quaternion.copy(q); m.name = b.id; m.renderOrder = 6; m.frustumCulled = false;
      this.root.add(m); this.efbBtnMeshes.push(m);
    }
  }
  private pickEfbBtn(ray: THREE.Raycaster): { id: string; dist: number } | null { const h = ray.intersectObjects(this.efbBtnMeshes, false)[0]; return h ? { id: h.object.name, dist: h.distance } : null; }
  private efbBtnInfo(id: string) { return EFB_BTNS.find((b) => b.id === id)!; }
  private efbBtnState(id: string): string {
    switch (id) { case 'efb_pwr': return this.efbPower ? 'BACKLIGHT ON' : 'BACKLIGHT OFF'; case 'efb_brt': case 'efb_dim': return this.efbPower ? `BRIGHTNESS ${Math.round(this.efbBright * 100)} %` : 'BACKLIGHT OFF'; case 'efb_view': return this.efbOffside ? 'OFFSIDE (F/O) VIEW' : 'OWN VIEW'; default: return 'NO DEVICE'; }
  }
  /** Pointer down on a bezel button: acts once, then (BRT / DIM) repeats while held – see updateEfb(). */
  private pressEfbBtn(id: string) { this.efbFlash.set(id, 0.12); this.efbHeld = { id, t: 0, rep: 0 }; this.actEfbBtn(id, true); }
  private actEfbBtn(id: string, announce: boolean) {
    const h = this.host!;
    switch (id) {
      case 'efb_pwr': this.efbPower = !this.efbPower; h.toast(this.efbPower ? 'EFB display backlight ON' : 'EFB display backlight OFF', 'info'); break;
      case 'efb_brt': if (this.efbPower) { const was = this.efbBright; this.efbBright = Math.min(1, Math.round((this.efbBright + 0.1) * 10) / 10); if (announce || this.efbBright === 1 && was !== 1) h.toast(`EFB brightness ${Math.round(this.efbBright * 100)} %`, 'info'); } else if (announce) h.toast('EFB display backlight is OFF – press DISPLAY first', 'info'); break;
      case 'efb_dim': if (this.efbPower) { const was = this.efbBright; this.efbBright = Math.max(0.1, Math.round((this.efbBright - 0.1) * 10) / 10); if (announce || this.efbBright === 0.1 && was !== 0.1) h.toast(`EFB brightness ${Math.round(this.efbBright * 100)} %`, 'info'); } else if (announce) h.toast('EFB display backlight is OFF – press DISPLAY first', 'info'); break;
      case 'efb_view': this.efbOffside = !this.efbOffside; h.toast(this.efbOffside ? 'EFB: offside (F/O) view – read-only' : 'EFB: own view', 'info'); break;
      default: h.toast('USB port – no device connected', 'info');
    }
    this.efb.dirty = this.efbFo.dirty = true;
  }
  private pickEfb(ray: THREE.Raycaster): { u: number; v: number; dist: number } | null {
    if (!this.efbMesh) return null; const h = ray.intersectObject(this.efbMesh, false)[0]; if (!h || !h.uv) return null;
    return { u: h.uv.x, v: 1 - h.uv.y, dist: h.distance };
  }

  // ====================================================================== camera rig
  // Two layers, both critically-damped springs (no fixed lerp – the motion has inertia and never overshoots):
  //   * `views.cockpit` is the BASE view (seat / panel preset, set by focus()) – flown with a slow, weighted ease (≈ 0.4 s).
  //   * `look` is the pilot's free-look + lean offset on top – tight (≈ 80 ms) while dragging, then it coasts to a stop with momentum, like MSFS.
  // Wheel zoom is exponential and damped in log space. focus() clears `look` so panel views are framed exactly as designed.
  private look = { yaw: 0, pitch: 0, x: 0, y: 0 }; private lookCur = { yaw: 0, pitch: 0, x: 0, y: 0 };
  private out = { pos: new THREE.Vector3(), yaw: 0, pitch: 0, fov: 68 };
  private vel: Record<string, number> = {}; private coast = { yaw: 0, pitch: 0 }; private lookV = { yaw: 0, pitch: 0 }; private lastLookT = 0; private lastZoomT = 0;
  setPreset(p: CockpitPreset, instant = false) {
    if (p in COCKPIT_PANELS) { this.framePanel(p as CockpitPanelId, instant); return; }
    const pr = COCKPIT_PRESETS[p as keyof typeof COCKPIT_PRESETS]; this.focus(pr.eye, pr.at, pr.fov, instant);
  }
  /** Look square-on at a panel from the distance that frames it fully for the current aspect ratio. */
  framePanel(id: CockpitPanelId, instant = false) {
    const p = COCKPIT_PANELS[id], fov = id === 'instruments' ? 56 : 36, tv = Math.tan(fov * Math.PI / 360), asp = Math.max(0.5, this.camera.aspect || 1.78);
    const d = Math.max(p.h / 2 / tv, p.w / 2 / (tv * asp)) * 1.12;
    this.focus(p.c.clone().addScaledVector(p.n, d), p.c, fov, instant);
  }
  /** Point the cockpit camera: eye + target in model coordinates. Clears free-look so the framing is exact. */
  focus(eye: THREE.Vector3, at: THREE.Vector3, fov: number, instant = false) {
    const [ex, ey, ez] = this.spec.eye; const tx = ex + EYE_M.z, ty = ey - EYE_M.y, tz = ez - EYE_M.x;
    const b = (v: THREE.Vector3, o: THREE.Vector3) => o.set(-v.z + tx, v.y + ty, v.x + tz);
    const E = b(eye, this.t), A = b(at, this.tBody); const dx = A.x - E.x, dy = A.y - E.y, dz = A.z - E.z;
    const vw = this.views.cockpit; vw.pos.copy(E); vw.yaw = Math.atan2(-dx, -dz); vw.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    this.fovT = fov; this.zoomT = 1; this.look.yaw = this.look.pitch = this.look.x = this.look.y = 0; this.coast.yaw = this.coast.pitch = 0;
    if (instant) { this.cur.pos.copy(vw.pos); this.cur.yaw = vw.yaw; this.cur.pitch = vw.pitch; this.fovCur = fov; this.zoom = 1; Object.assign(this.lookCur, this.look); this.vel = {}; }
  }
  /** Outward normal of the panel a control sits on (model frame) – used to frame controls squarely and to push buttons into their panel. */
  private panelNormal(c: THREE.Vector3): THREE.Vector3 {
    if (c.z > 0.7) return COCKPIT_PANELS.efb.n.clone();
    if (c.y > 0.8) return N(0.25, -1, 0);                                          // overhead: view from below, looking forward
    if (c.x < -0.3 && c.x > -0.43 && c.y > 0.38 && c.y < 0.6) return COCKPIT_PANELS.fcu.n.clone(); // glareshield / FCU / EFIS
    if (c.x < -0.44) return N(1, 0.15, 0);                                          // main instrument panel
    if (Math.abs(c.z) < 0.34 && c.y < 0.2) return N(0.25, 1, 0);                    // pedestal & thrust quadrant: view from above
    return N(0.35, 0.45, -Math.sign(c.z || 1) * Math.min(1, Math.abs(c.z) * 2));    // side consoles etc.: from the cockpit centre
  }
  /** Fly the camera to the control under the cursor (Alt + click). Never actuates anything. */
  focusGroup(g: Group) {
    const c = g.box.getCenter(new THREE.Vector3()), size = Math.max(...g.box.getSize(new THREE.Vector3()).toArray());
    const n = this.panelNormal(c), dist = Math.min(0.62, Math.max(0.26, size * 4.5));
    this.focus(c.clone().addScaledVector(n, dist), c, 38);
  }
  private clampLook() { const vw = this.views.cockpit, L = this.look; L.yaw = Math.max(-2.7 - vw.yaw, Math.min(2.7 - vw.yaw, L.yaw)); L.pitch = Math.max(-1.35 - vw.pitch, Math.min(1.35 - vw.pitch, L.pitch)); }
  /** Free-look: drag deltas in pixels. Radians-per-pixel follow the current field of view and viewport, so the scene tracks the cursor at any zoom. */
  lookBy(dx: number, dy: number) {
    const k = (this.out.fov * Math.PI / 180) / Math.max(360, this.vpH) * 1.15, L = this.look, now = performance.now(), dtm = Math.max(0.004, (now - this.lastLookT) / 1000); this.lastLookT = now;
    L.yaw -= dx * k; L.pitch -= dy * k; this.clampLook(); this.coast.yaw = this.coast.pitch = 0;
    this.lookV.yaw = this.lookV.yaw * 0.6 + (-dx * k / dtm) * 0.4; this.lookV.pitch = this.lookV.pitch * 0.6 + (-dy * k / dtm) * 0.4;
  }
  /** Release of a look-drag: the view keeps drifting with the last hand velocity and settles (momentum). */
  endLook() {
    if (performance.now() - this.lastLookT < 90) { this.coast.yaw = Math.max(-3, Math.min(3, this.lookV.yaw * 0.6)); this.coast.pitch = Math.max(-3, Math.min(3, this.lookV.pitch * 0.6)); }
    this.lookV.yaw = this.lookV.pitch = 0;
  }
  /** Lean / pan the head sideways and up-down (middle-drag or Shift-drag), a few tens of centimetres around the base position. */
  panBy(dx: number, dy: number) {
    const k = 0.0011 / this.zoom, L = this.look; L.x = Math.max(-0.3, Math.min(0.3, L.x + dx * k)); L.y = Math.max(-0.2, Math.min(0.2, L.y - dy * k));
  }
  resetLook() { this.look.yaw = this.look.pitch = this.look.x = this.look.y = 0; this.coast.yaw = this.coast.pitch = 0; }
  /** Critically-damped spring step (Unity-style SmoothDamp): returns the new value, keeps velocity in `vel[key]`. */
  private sd(cur: number, tgt: number, key: string, smooth: number, dt: number) {
    const om = 2 / Math.max(1e-3, smooth), x = om * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x), v = this.vel[key] ?? 0, ch = cur - tgt, tmp = (v + om * ch) * dt;
    this.vel[key] = (v - om * tmp) * e; return tgt + (ch + tmp) * e;
  }
  /** Smoothly damped camera state (body frame) for the game's camera rig. */
  smooth(dt: number) {
    dt = Math.min(Math.max(dt, 0), 0.05); const vw = this.views.cockpit, o = this.out, c = this.cur, l = this.lookCur, L = this.look;
    if (this.coast.yaw || this.coast.pitch) {
      L.yaw += this.coast.yaw * dt; L.pitch += this.coast.pitch * dt; this.clampLook(); const f = Math.exp(-dt * 3.4); this.coast.yaw *= f; this.coast.pitch *= f;
      if (Math.abs(this.coast.yaw) < 0.01 && Math.abs(this.coast.pitch) < 0.01) this.coast.yaw = this.coast.pitch = 0;
    }
    const BT = 0.42;                                                                // base-view flight time (s): weighted, cinematic
    c.pos.x = this.sd(c.pos.x, vw.pos.x, 'px', BT, dt); c.pos.y = this.sd(c.pos.y, vw.pos.y, 'py', BT, dt); c.pos.z = this.sd(c.pos.z, vw.pos.z, 'pz', BT, dt);
    let dyaw = vw.yaw - c.yaw; dyaw -= Math.round(dyaw / (2 * Math.PI)) * 2 * Math.PI;  // shortest way round
    c.yaw = this.sd(c.yaw, c.yaw + dyaw, 'yaw', BT, dt); c.pitch = this.sd(c.pitch, vw.pitch, 'pitch', BT, dt); this.fovCur = this.sd(this.fovCur, this.fovT, 'fov', BT, dt);
    l.yaw = this.sd(l.yaw, L.yaw, 'ly', 0.085, dt); l.pitch = this.sd(l.pitch, L.pitch, 'lp', 0.085, dt); l.x = this.sd(l.x, L.x, 'lx', 0.14, dt); l.y = this.sd(l.y, L.y, 'lyy', 0.14, dt);
    this.zoom = Math.exp(this.sd(Math.log(this.zoom), Math.log(this.zoomT), 'z', 0.15, dt));
    const yaw = c.yaw + l.yaw; o.pos.copy(c.pos); o.pos.x += Math.cos(yaw) * l.x; o.pos.z -= Math.sin(yaw) * l.x; o.pos.y += l.y;
    o.yaw = yaw; o.pitch = c.pitch + l.pitch; o.fov = 2 * Math.atan(Math.tan(this.fovCur * Math.PI / 360) / this.zoom) * 180 / Math.PI;
    return o;
  }
  /** Wheel zoom (field of view 1x–8x, exponential so every notch feels the same). */
  zoomBy(deltaY: number) { this.lastZoomT = performance.now(); this.zoomT = Math.min(8, Math.max(1, this.zoomT * Math.exp(-Math.max(-300, Math.min(300, deltaY)) * 0.0014))); }
  resetZoom() { this.zoomT = 1; }
  setQuality(q: QualityPreset) { this.quality = q; this.fallback?.setQuality(q); }

  // ====================================================================== interaction
  private pickGroup(ray: THREE.Raycaster): { g: Group; hit: THREE.Intersection } | null {
    if (!this.loaded) return null;
    const hits = ray.intersectObjects(this.interactive, false);
    for (let i = 0; i < hits.length; i++) {
      const g = this.byNode.get(hits[i].object); if (!g) continue;
      // a LIFTED guard stands clear of its button: the click goes through to the button underneath it
      if (g.kind === 'guard' && g.pos) for (let j = i + 1; j < hits.length; j++) { const b = this.byNode.get(hits[j].object); if (b && GUARD_OF[b.id] === g.id) return { g: b, hit: hits[j] }; }
      return { g, hit: hits[i] };
    }
    return null;
  }
  hover(ray: THREE.Raycaster): CockpitHover | null {
    if (this.fallback) { const p = this.fallback.pick(ray, true); return p ? { id: p.id, label: p.id.toUpperCase(), value: '', hint: 'Click', desc: 'Flight-deck control.' } : null; }
    const p = this.pickGroup(ray), e = this.pickEfb(ray), eb = this.pickEfbBtn(ray);
    if (!(e && (!p || e.dist < p.hit.distance)) || (eb && eb.dist < e.dist)) { this.efb.leave(); this.efbFo.leave(); }
    if (eb && (!p || eb.dist < p.hit.distance)) { const b = this.efbBtnInfo(eb.id); return { id: eb.id, label: b.label, value: this.efbBtnState(eb.id), hint: eb.id.startsWith('efb_usb') ? 'Port' : 'Click to press', desc: b.desc }; }
    if (e && (!p || e.dist < p.hit.distance)) { const tip = this.efbShown.hover(e.u, e.v); return { id: 'efb', label: 'EFB TABLET (CAPT)', value: tip ?? `Page: ${this.efbShown.page}${this.efbOffside ? ' (F/O)' : ''}`, hint: tip ? 'Click' : 'Click to operate · wheel scrolls', desc: 'Electronic Flight Bag – flight plan, checklists, airport data, radio frequencies, weather and procedures.' }; }
    if (!p) return null;
    const info = describeControl(p.g.id);
    return { id: p.g.id, label: p.g.kind === 'key' ? p.g.label : info.name, value: this.stateText(p.g), hint: this.hint(p.g), desc: info.text };
  }
  private hint(g: Group) { const ef = EFIS_MAP[g.id]; if (ef) { const t = this.efisHint(ef.fn); if (t) return t; } return g.kind === 'knob' || g.id === 'spd-sel' || g.id === 'hdg_sel' || g.id === 'alt-sel' ? 'Wheel / drag to turn · click = push · right-click = pull' : g.kind === 'lever' ? 'Drag to move · detents snap' : g.kind === 'stick' ? 'Drag to fly' : g.kind === 'key' ? 'Click to press' : 'Click to operate'; }
  stateText(g: Group): string {
    const s = this.sys, h = this.host, id = g.id;
    switch (id) {
      case 'BatteryBtn1': return s.bat[0] ? 'AUTO' : 'OFF'; case 'BatteryBtn2': return s.bat[1] ? 'AUTO' : 'OFF';
      case 'APUMasterBtn': return s.apuMaster ? 'ON' : 'OFF'; case 'APUStartBtn': return s.apuRpm >= 95 ? 'AVAIL' : s.apuStart ? `START ${Math.round(s.apuRpm)}%` : 'OFF';
      case 'Lcutoff': return h?.fm.eng[0].state === 2 ? 'ON · RUNNING' : s.master[0] ? 'ON' : 'OFF'; case 'Rcutoff': return h?.fm.eng[1].state === 2 ? 'ON · RUNNING' : s.master[1] ? 'ON' : 'OFF';
      case 'RudderTrim': { const u = Math.round((h?.fm.ctl.rudTrim ?? 0) * 20); return u === 0 ? 'NEUTRAL' : `${Math.abs(u)} ${u < 0 ? 'L' : 'R'}`; }
      case 'eng_mode': return ['CRANK', 'NORM', 'IGN/START'][s.engMode]; case 'FlapsLever': return `CONF ${['0', '1', '2', '3', 'FULL'][h?.fm.ctl.flapsIdx ?? 0]}`; case 'rev_l': case 'rev_r': return h?.fm.ctl.reverse ? 'REV DEPLOYED' : 'STOWED';
      case 'gear_lever': return h?.fm.ctl.gearDown ? 'DOWN' : 'UP'; case 'ParkBrk': return h?.fm.ctl.parking ? 'ON' : 'OFF'; case 'spd-sel': return `${Math.round(h?.ap.spd ?? 0)} kt`;
      case 'hdg_sel': return `${Math.round(h?.ap.hdg ?? 0)}°`; case 'alt-sel': return `${Math.round(h?.ap.altFt ?? 0)} ft`; case 'vs-sel': return s.vsMode ? `${s.vsTarget} fpm` : 'LEVEL CH';
      case 'ap1': return h?.ap.on ? 'ENGAGED' : 'OFF'; case 'appr': return h?.ap.appr ? 'ARMED' : 'OFF';
      case 'thr_l_body': return thrDetentName(h?.fm.ctl.throttle ?? 0, !!h?.fm.ctl.reverse); case 'thr_r_body': return thrDetentName(Math.min(1, Math.max(0, (h?.fm.ctl.throttle ?? 0) + (h?.fm.ctl.thrOffset ?? 0))), !!h?.fm.ctl.reverse);
      case 'SpdBrk': return s.spoilerArm ? 'ARMED' : `${Math.round((h?.fm.ctl.speedbrake ?? 0) * 100)}%`;
      case 'abs_low': return s.autobrake === 1 ? 'ON' : 'OFF'; case 'abs_med': return s.autobrake === 2 ? 'ON' : 'OFF'; case 'abs_max': return s.autobrake === 3 ? 'ON' : 'OFF';
      case 'iesi_baro_knb': return s.isis.std ? 'STD' : `${Math.round(s.isis.hpa)} hPa`;
      case 'BeaconLtSwtch': return h?.lights.beacon ? 'ON' : 'OFF'; case 'SeatBeltSwtch': return h?.seatbelt ? 'ON' : 'OFF';
    }
    const ef = EFIS_MAP[id]; if (ef) { const t = this.efisText(ef.side, ef.fn); if (t) return t; }
    if (g.kind === 'key') return '';
    if (SWITCH_LABELS[id]) return SWITCH_LABELS[id][g.pos] ?? '';
    if (g.ovh) { const a = AGENT_IDX[id]; if (a !== undefined) return s.agentDisch[a] ? 'DISCHARGED' : s.fireOut[fireOf(a)] ? 'ARMED' : 'SAFE'; return g.mom ? 'MOMENTARY' : this.stateOn(id) ? 'ON / AUTO · pushed in' : 'OFF · released'; }
    if (g.kind === 'switch') return SWITCH3.has(g.id) ? (['OFF / LOW', 'AUTO / MID', 'ON / HIGH'][g.pos] ?? '') : g.pos ? 'ON' : 'OFF';
    if (g.kind === 'guard') return g.pos ? 'OPEN' : 'CLOSED';
    if (g.kind === 'knob') return `position ${g.pos + 1}`;
    return this.stateOn(g.id) ? 'ON / ENGAGED' : 'OFF / NORMAL';
  }

  /** Pointer down: returns null when no control was hit; `handled:false` ids ('yoke') are completed by the game. */
  press(ray: THREE.Raycaster, button: number, shift: boolean): PressResult | null {
    if (this.fallback) { const p = this.fallback.pick(ray); return p ? { id: p.id, handled: false } : null; }
    const p = this.pickGroup(ray), e = this.pickEfb(ray), eb = this.pickEfbBtn(ray);
    if (eb && this.host && (!p || eb.dist < p.hit.distance)) { this.pressEfbBtn(eb.id); return { id: eb.id, handled: true }; }
    if (e && (!p || e.dist < p.hit.distance)) { this.efbShown.click(e.u, e.v); return { id: 'efb', handled: true }; }
    if (!p || !this.host) return null; const g = p.g; const h = this.host;
    if (g.kind === 'stick') return { id: 'yoke', handled: false };
    const cover = GUARD_OF[g.id] && this.groups.get(GUARD_OF[g.id]); if (cover && !cover.pos) { this.setGuard(cover, 1); cover.press = 1; this.active = { g: cover, sy: 0, acc: 0, v0: 0, kind: 'push' }; return { id: cover.id, handled: true }; }   // lift the guard first
    if (g.id === 'gear_lever') { h.action('gear'); return { id: g.id, handled: true }; }
    if (g.id === 'ParkBrk') { h.action('park'); return { id: g.id, handled: true }; }
    if (g.id === 'rev_l' || g.id === 'rev_r') { h.action('rev'); return { id: g.id, handled: true }; }
    if (g.id === 'Lcutoff' || g.id === 'Rcutoff') { this.toggle(g, 1); return { id: g.id, handled: true }; }
    if (g.kind === 'lever') { this.active = { g, sy: 0, acc: 0, v0: this.leverValue(g), kind: 'lever' }; return { id: g.id, handled: true }; }
    if (g.kind === 'key') { this.mcduKey(g.id); g.press = 1; return { id: g.id, handled: true }; }
    if (ECP_KEYS.has(g.id)) { this.sys.ecam.down(g.id); g.press = 1; this.active = { g, sy: 0, acc: 0, v0: 0, kind: 'hold' }; return { id: g.id, handled: true }; }
    const fcuKnob = PUSHPULL.has(g.id);
    if (RING.has(g.id)) { this.stepKnob(g, g.pos ? -1 : 1, false); g.press = 1; return { id: g.id, handled: true }; }
    if (g.kind === 'knob' || fcuKnob) {
      if (fcuKnob) { this.active = { g, sy: 0, acc: 0, v0: 0, kind: 'knob' }; g.press = 1; this.activateKnob(g, button === 2 || shift ? 'pull' : 'push'); return { id: g.id, handled: true }; }
      this.active = { g, sy: 0, acc: 0, v0: 0, kind: 'knob' };
      if (SRC_KNOBS[g.id]) { const dir = button === 2 ? -1 : g.pos >= 2 ? -1 : g.pos <= 0 ? 1 : g.angle < 0 ? -1 : 1; g.angle = dir; this.stepKnob(g, dir, false); return { id: g.id, handled: true }; }
      this.stepKnob(g, button === 2 ? -1 : 1, shift); return { id: g.id, handled: true };
    }
    this.toggle(g, button === 2 || shift ? -1 : 1); g.press = 1; this.active = { g, sy: 0, acc: 0, v0: 0, kind: 'push' };
    return { id: g.id, handled: true };
  }
  drag(dx: number, dy: number) {
    const a = this.active; if (!a || !this.host) return false; const c = this.host.fm.ctl;
    if (a.kind === 'knob') { a.acc += -dy / 14 + dx / 28; while (Math.abs(a.acc) >= 1) { const s = Math.sign(a.acc); a.acc -= s; this.stepKnob(a.g, s, false); } return true; }
    a.sy += dy;
    switch (a.g.id) {
      case 'thr_l_body': { const R = c.throttle + c.thrOffset, v = snapThrottle(a.v0 - a.sy / 170); c.throttle = v; c.thrOffset = Math.min(1, Math.max(0, R)) - v; break; }   // magnetic IDLE / CL / FLX-MCT / TOGA gates
      case 'thr_r_body': c.thrOffset = snapThrottle(a.v0 - a.sy / 170) - c.throttle; break;
      case 'FlapsLever': c.flapsIdx = Math.min(this.spec.flapDetents, Math.max(0, Math.round(a.v0 + a.sy / 30))); break;
      case 'SpdBrk': { const v = a.v0 + a.sy / 100; if (v < -0.2) { this.sys.spoilerArm = true; c.speedbrake = 0; } else { this.sys.spoilerArm = false; c.speedbrake = Math.min(1, Math.max(0, v)); } break; }
      case 'Lcutoff': case 'Rcutoff': if (Math.abs(a.sy) > 12) { const i = a.g.id === 'Lcutoff' ? 0 : 1; this.sys.master[i] = a.sy < 0; a.sy = 0; } break;
      case 'eng_mode': if (Math.abs(a.sy) > 14) { this.sys.engMode = Math.max(0, Math.min(2, this.sys.engMode + (a.sy < 0 ? 1 : -1))) as 0 | 1 | 2; a.sy = 0; } break;
    }
    return true;
  }
  release() {
    this.efbHeld = null;
    const a = this.active; this.active = null; if (a && ECP_KEYS.has(a.g.id)) this.sys.ecam.up(a.g.id); if (!a || !this.host) return;
    const c = this.host.fm.ctl; if (Math.abs(c.thrOffset) < 0.03) c.thrOffset = 0;
    for (const g of this.groups.values()) g.press = 0;
  }
  wheel(ray: THREE.Raycaster, deltaY: number, shift: boolean): boolean {
    if (this.fallback) return false;
    if (performance.now() - this.lastZoomT < 450) return false; // a zoom gesture in progress never turns a knob that slides under the cursor
    const p = this.pickGroup(ray), e = this.pickEfb(ray);
    if (e && (!p || e.dist < p.hit.distance)) { this.efbShown.wheel(deltaY); return true; }
    if (!p) return false; const g = p.g;
    const isK = g.kind === 'knob' || PUSHPULL.has(g.id) || g.id === 'eng_mode';
    if (g.kind === 'lever' && this.host) { const c = this.host.fm.ctl, d = deltaY > 0 ? -0.05 : 0.05; if (g.id === 'thr_l_body') { const R = c.throttle + c.thrOffset; c.throttle = this.stepDetent(c.throttle, d); c.thrOffset = R - c.throttle; } else if (g.id === 'thr_r_body') c.thrOffset = this.stepDetent(c.throttle + c.thrOffset, d) - c.throttle; else if (g.id === 'FlapsLever') c.flapsIdx = Math.min(4, Math.max(0, c.flapsIdx + (deltaY > 0 ? 1 : -1))); else return false; return true; }
    if (!isK) return false; this.stepKnob(g, deltaY > 0 ? -1 : 1, shift); return true;
  }
  focusAt(ray: THREE.Raycaster): boolean { if (this.fallback) return false; const p = this.pickGroup(ray), e = this.pickEfb(ray); if (e && (!p || e.dist < p.hit.distance)) { this.framePanel('efb'); return true; } if (!p) return false; this.focusGroup(p.g); return true; }
  /** Wheel step on a thrust lever: 5 % notches that stop at (and then pass) each FADEC detent. */
  private stepDetent(v: number, d: number) { const n = v + d; for (const t of THR_DETENTS) if ((v - t.v) * (n - t.v) < 0) return t.v; return snapThrottle(n, 0.012); }
  private leverValue(g: Group) { const c = this.host!.fm.ctl; return g.id === 'thr_l_body' ? c.throttle : g.id === 'thr_r_body' ? c.throttle + c.thrOffset : g.id === 'FlapsLever' ? c.flapsIdx : g.id === 'SpdBrk' ? (this.sys.spoilerArm ? -0.3 : c.speedbrake) : 0; }

  private mcduKey(id: string) { const fo = id.startsWith('F:'), k = id.slice(2) || '.'; const m = this.mcdu[fo ? 1 : 0]; m.key(k === 'mcdu' ? 'menu' : k); }

  private stepKnob(g: Group, dir: number, shift: boolean) {
    const h = this.host; if (!h) return; const s = this.sys; const id = g.id;
    switch (id) {
      case 'spd-sel': case 'hdg_sel': case 'alt-sel': case 'vs-sel': this.fcuTurn(g, dir, shift); return;
      case 'qnh_cpt_knb': case 'qnh_fo_knb': s.efisBaroTurn(id === 'qnh_fo_knb' ? 1 : 0, dir); g.angle += dir * 0.2; return;
      case 'qnh_cpt_sw': case 'qnh_fo_sw': s.efisBaroUnit(id === 'qnh_fo_sw' ? 1 : 0, dir < 0); return;
      case 'iesi_baro_knb': s.isis.std = false; s.isis.hpa = Math.max(950, Math.min(1050, s.isis.hpa + dir)); g.angle += dir * 0.2; return;
      case 'alt-sel-mode': g.pos = dir > 0 ? 1 : 0; s.altStep1000 = g.pos === 1; return;
      case 'fcu_integ_knb1': case 'fcu_integ_knb2': s.bright.fcu = this.clampN(s.bright.fcu + dir * 0.1, 0.2, 1); g.angle += dir * 0.3; return;
      case 'nd_range': case 'nd_range_fo': { const e = s.efis[id === 'nd_range_fo' ? 1 : 0]; e.ndRange = Math.max(0, Math.min(5, e.ndRange + dir)); return; }
      case 'nd_mode': case 'nd_mode_fo': { const e = s.efis[id === 'nd_mode_fo' ? 1 : 0]; e.ndMode = Math.max(0, Math.min(4, e.ndMode + dir)); return; }
      case 'eng_mode': s.engMode = Math.max(0, Math.min(2, s.engMode + dir)) as 0 | 1 | 2; g.pos = s.engMode; return;
      case 'RudderTrim': h.fm.ctl.rudTrim = this.clampN(Math.round((h.fm.ctl.rudTrim + dir * 0.05) * 20) / 20, -1, 1); return;
      case 'XbleedKnb': g.pos = Math.max(0, Math.min(2, (g.pos || 1) + dir)); s.xbleed = g.pos === 0 ? 0 : 1; return;
      case 'pfd_brt_cpt': case 'pfd_brt_fo': { const i = id === 'pfd_brt_fo' ? 1 : 0; s.bright.pfd[i] = clamp01(s.bright.pfd[i] + dir * 0.05); return; }
      case 'brightness_nd_2_cpt': case 'brightness_nd_2_fo': { const i = id === 'brightness_nd_2_fo' ? 1 : 0; s.bright.nd[i] = clamp01(s.bright.nd[i] + dir * 0.05); return; }
      case 'brightness_nd_1_cpt': case 'brightness_nd_1_fo': { const i = id === 'brightness_nd_1_fo' ? 1 : 0; s.bright.ndOuter[i] = clamp01(s.bright.ndOuter[i] + dir * 0.05); return; }
      case 'ecam_brt_upper': case 'ecam_brt_lower': { const k = BRT_KNOBS[id]; s.bright[k] = Math.max(0, Math.min(1, Math.round((s.bright[k] + dir * 0.1) * 10) / 10)); return; }
      case 'ecam_att_hdg': case 'ecam_air_data': case 'ecam_eis_dmc': case 'ecam_nd_xfr': { g.pos = Math.max(0, Math.min(2, g.pos + dir)); s.switching[SRC_KNOBS[id].key] = g.pos; s.sw[id] = g.pos; this.routeDisplays(); return; }
    }
    const n = g.steps; const cont = n >= 40;
    g.pos = cont ? g.pos + dir : Math.max(0, Math.min(n - 1, g.pos + dir)); s.sw[id] = g.pos;   // rotary selectors / dimmers have end stops
  }
/** Toggle / cycle a push-button, switch or guard and apply its system effect. */
  private toggle(g: Group, dir: number) {
    const h = this.host!, s = this.sys, id = g.id.replace(/^(EmerGenTest)\.\d+$/, '$1'), fm = h.fm;
    const flip = () => { g.pos = g.pos ? 0 : 1; s.sw[id] = g.pos; return !!g.pos; };
    const cycle = (n: number) => { g.pos = (g.pos + (dir > 0 ? 1 : n - 1)) % n; s.sw[id] = g.pos; return g.pos; };
    const rmp = /^radio_(\w+)\.(cpt|fo)$/.exec(id);
    if (rmp) { const st = this.rmp[rmp[2] === 'fo' ? 1 : 0], k = rmp[1]; if (k === 'on') st.on = !st.on; else if (st.on) { if (k === 'bfo') st.bfo = !st.bfo; else if (k === 'am') st.am = !st.am; else if (k === 'exchange') h.toast('RMP · active / standby frequency exchanged', 'info'); else if (k !== 'opt') st.sel = k; } return; }
    const acp = /^audio_(\w+)\.(cpt|fo)$/.exec(id);
    if (acp && acp[1] !== 'int_rad' && acp[1] !== 'pa_rot') { const st = this.acp[acp[2] === 'fo' ? 1 : 0], k = acp[1]; if (k === 'reset') { st.rx = {}; } else if (k.startsWith('call_')) { st.tx = k.slice(5); st.rx[st.tx] = true; } else st.rx[k] = !st.rx[k]; return; }
    switch (id) {
      case 'RudderTrimReset': fm.ctl.rudTrim = 0; return;
      case 'BatteryBtn1': s.bat[0] = !s.bat[0]; return;
      case 'firebtn1': this.fireToggle(0); return; case 'firebtn2': this.fireToggle(1); return; case 'firebtnapu': this.fireToggle(2); return;
      case 'Eng1FireAgt1Btn': case 'Eng1FireAgt2Btn': case 'Eng2FireAgt1Btn': case 'Eng2FireAgt2Btn': case 'APUFireAgtBtn': this.discharge(AGENT_IDX[id]); return;
      case 'ELTSw': flip(); s.elt = g.pos === 1; h.toast(s.elt ? 'ELT ON – transmitting on 121.5 / 243 / 406 MHz' : 'ELT ARMED (will trigger on impact)', s.elt ? 'warn' : 'info'); return;
      case 'EltTestRst': s.lampTest = 1.5; h.toast('ELT test – transmitter light checked', 'info'); return;
      case 'APUExtReset': h.toast('APU auto-shutdown RESET', 'info'); return;
      case 'BatteryBtn2': s.bat[1] = !s.bat[1]; return;
      case 'ExtPwrBtn': s.ext = !s.ext; if (s.ext) h.toast('EXT PWR connected', 'info'); return;
      case 'APUMasterBtn': s.apuMaster = !s.apuMaster; return;
      case 'APUStartBtn': if (s.apuMaster && s.dc) s.apuStart = true; else h.toast('Switch APU MASTER SW on first', 'warn'); return;
      case 'APUGenBtn': s.apuGen = !s.apuGen; return; case 'APUBleedBtn': s.apuBleed = !s.apuBleed; return;
      case 'Gen1Btn': s.gen[0] = !s.gen[0]; return; case 'Gen2Btn': s.gen[1] = !s.gen[1]; return;
      case 'Eng1BleedBtn': s.engBleed[0] = !s.engBleed[0]; return; case 'Eng2BleedBtn': s.engBleed[1] = !s.engBleed[1]; return;
      case 'ACPack1Btn': s.packs[0] = !s.packs[0]; return; case 'ACPack2Btn': s.packs[1] = !s.packs[1]; return;
      case 'WingAntiIceBtn': s.wingAI = !s.wingAI; g.pos = s.wingAI ? 1 : 0; return;
      case 'Eng1AntiIceBtn': s.engAI[0] = !s.engAI[0]; g.pos = s.engAI[0] ? 1 : 0; return; case 'Eng2AntiIceBtn': s.engAI[1] = !s.engAI[1]; g.pos = s.engAI[1] ? 1 : 0; return;
      case 'LFuelTank1Btn': s.pumps[0] = !s.pumps[0]; return; case 'LFuelTank2Btn': s.pumps[1] = !s.pumps[1]; return; case 'CFuelTank1Btn': s.pumps[2] = !s.pumps[2]; return;
      case 'CFuelTank2Btn': s.pumps[3] = !s.pumps[3]; return; case 'RFuelTank1Btn': s.pumps[4] = !s.pumps[4]; return; case 'RFuelTank2Btn': s.pumps[5] = !s.pumps[5]; return;
      case 'FuelXFeedBtn': s.xfeed = !s.xfeed; return;
      case 'GreenEngPump2': s.hydPump.green = !s.hydPump.green; return; case 'YellowEngPump': s.hydPump.yellow = !s.hydPump.yellow; return; case 'BlueElecPump': s.hydPump.blue = !s.hydPump.blue; return;
      case 'YellowElecPump': s.hydPump.yElec = !s.hydPump.yElec; g.pos = s.hydPump.yElec ? 1 : 0; return; case 'PTU2': s.hydPump.ptu = !s.hydPump.ptu; return;
      case 'RATMan': s.ratOut = true; return;
      case 'BeaconLtSwtch': { const on = flip(); h.lights.beacon = !!on; g.pos = on ? 1 : 0; if (!on) g.pos = 0; return; }
      case 'StrobeLtSwtch': { const p = cycle(3); h.lights.strobe = p >= 1; return; }                 // OFF / AUTO / ON
      case 'NavLogoLtSwtch': { const p = cycle(3); h.lights.nav = p !== 1; return; }                  // 2 / OFF / 1
      case 'LandingLtSwtch': case 'LandingLtRSwtch': case 'land_sw': { const p = cycle(3); h.lights.land = p === 2; return; }   // RETRACT / OFF / ON
      case 'SeatBeltSwtch': { const p = cycle(3); if ((p === 2) !== h.seatbelt) h.action('belt'); return; }   // OFF / AUTO / ON
      case 'Lcutoff': s.master[0] = !s.master[0]; return; case 'Rcutoff': s.master[1] = !s.master[1]; return;
      case 'eng_mode': s.engMode = ((s.engMode + (dir > 0 ? 1 : 2)) % 3) as 0 | 1 | 2; return;
      case 'ap1': this.apPress(0); return; case 'ap2': this.apPress(1); return;
      case 'a-thr': s.athrArmed = !s.athrArmed; return; case 'appr': h.action('appr'); return; case 'loc': s.locArmed = !s.locArmed; if (s.locArmed && !h.ap.on) h.toast('LOC armed – engage AP1 / AP2 to capture the localizer', 'info'); return;
      case 'exped': s.exped = !s.exped; if (s.exped) { s.vsMode = false; } return; 
      case 'hdg-vs': case 'trk-fpa': s.trkFpa = !s.trkFpa; return; case 'spd-mach': s.spdMach = !s.spdMach; return; case 'metric_alt': s.metric = !s.metric; return;
      case 'fd1': case 'fd2': case 'ils': case 'ils2': case 'cstr': case 'cstr.001': case 'wpt': case 'wpt.001': case 'vord': case 'vord.001': case 'ndb': case 'ndb.001': case 'arpt': case 'arpt.001':
      case 'pfd_nd_xfr_sw': case 'pfd_nd_xfr_sw2': case 'terr_on_nd_l': case 'terr_on_nd_r': { const m = EFIS_MAP[id], e = s.efis[m.side];
        if (m.fn === 'fd') e.fd = !e.fd; else if (m.fn === 'ls') e.ls = !e.ls; else if (OPT_FN.has(m.fn)) s.efisOpt(m.side, m.fn as 'cstr'); else if (m.fn === 'xfr') e.xfr = !e.xfr; else s.terrOnNd[m.side] = !s.terrOnNd[m.side]; return; }
      case 'vor-adf1': case 'vor-adf2': case 'vor-adf-1-right': case 'vor-adf-2-right': { const m = EFIS_MAP[id], e = s.efis[m.side], i = m.fn === 'nav1' ? 1 : 0, order = [0, 1, -1]; e.nav[i] = order[(order.indexOf(e.nav[i]) + (dir > 0 ? 1 : 2)) % 3]; return; }   // OFF -> VOR -> ADF -> OFF
      case 'iesi_btn_rst': s.isis.std = !s.isis.std; return;
      case 'master_warning': s.ecam.acknowledgeMaster(); h.action('ackWarn'); return; case 'master_caution': s.masterCaut = false; h.action('ackWarn'); return;
      case 'chrono_btn': s.chronoRun = !s.chronoRun; s.chronoShow = true; return; case 'chrono_reset': s.chronoT = 0; s.chronoRun = false; s.chronoShow = false; return;
      case 'abs_low': s.autobrake = s.autobrake === 1 ? 0 : 1; return; case 'abs_med': s.autobrake = s.autobrake === 2 ? 0 : 2; return; case 'abs_max': s.autobrake = s.autobrake === 3 ? 0 : 3; return;
      case 'AnnunciatorLtSwtch': s.lampTest = 3; return; case 'APUFireTst': case 'Eng1FireTst': case 'Eng2FireTst': s.lampTest = 2; return;
      case 'IDG1Btn': case 'IDG2Btn': { const i = id === 'IDG1Btn' ? 0 : 1; s.gen[i] = false; s.sw[id] = 1; h.toast(`IDG ${i + 1} DISCONNECTED – generator ${i + 1} lost`, 'warn'); return; }
      case 'EmerElecManOnBtn': s.ratOut = true; h.toast('RAT deployed – emergency electrical power', 'warn'); return;
      case 'GPWSBtn': s.gpws.sys = !s.gpws.sys; flip(); return; case 'GPWSGSBtn': s.gpws.gs = !s.gpws.gs; flip(); return;
      case 'GPWSFlpBtn': s.gpws.flap = !s.gpws.flap; flip(); return; case 'GPWSTerrBtn': s.gpws.terr = !s.gpws.terr; flip(); return;
      case 'FuelModeBtn': s.fuelMode = !s.fuelMode; flip(); return;
      case 'EmerGenTest': case 'CVRTest': case 'CargoSmkTest': case 'LeftRainTest': case 'RightRainTest': s.lampTest = 1.5; return;
      case 'EvacCommandBtn': flip(); h.toast(s.sw[id] ? 'EVAC COMMAND ON – evacuation horn' : 'EVAC COMMAND OFF', 'warn'); return;
      case 'MaskManOnBtn': flip(); h.toast(s.sw[id] ? 'Passenger oxygen masks released' : 'Mask MAN ON reset', 'warn'); return;
      case 'EmerCallBtn': case 'AllCabinCall': case 'FwdCabinCall': case 'AftCabinCall': case 'GroundCall': h.toast('Interphone call – ' + g.label, 'info'); return;
      case 'ecam_all': { const pages: EcamPage[] = ['ENG', 'BLEED', 'PRESS', 'ELEC', 'HYD', 'FUEL', 'APU', 'COND', 'DOOR', 'WHEEL', 'F/CTL', 'STS']; s.page = pages[(pages.indexOf(s.page ?? 'ENG') + 1) % pages.length]; return; }
      case 'ecam_clr_l': case 'ecam_clr_r': case 'ecam_emer_canc': case 'ecam_rcl': s.page = null; return; case 'ecam_to_config': s.lampTest = 1.5; return;
      case 'ecam_eng': s.page = 'ENG'; return; case 'ecam_bleed': s.page = 'BLEED'; return; case 'ecam_press': s.page = 'PRESS'; return; case 'ecam_elec': s.page = 'ELEC'; return; case 'ecam_hyd': s.page = 'HYD'; return;
      case 'ecam_fuel': s.page = 'FUEL'; return; case 'ecam_apu': s.page = 'APU'; return; case 'ecam_cond': s.page = 'COND'; return; case 'ecam_door': s.page = 'DOOR'; return; case 'ecam_wheel': s.page = 'WHEEL'; return;
      case 'ecam_fctl': s.page = 'F/CTL'; return; case 'ecam_sts': s.page = 'STS'; return;
    }
    if (g.kind === 'switch') { cycle(SWITCH3.has(id) || /^audio_int_rad/.test(id) ? 3 : 2); return; }
    if (g.kind === 'guard') { this.setGuard(g, g.pos ? 0 : 1); return; }
    if (g.mom) { if (!/^audio_/.test(id)) h.toast(`${g.label} pressed`, 'info'); return; }
    flip();
  }
  /** Lifts / closes a guard cover (both halves of split covers such as the ELT guard move together). */
  private setGuard(g: Group, v: number) { const base = g.id.replace(/\.\d+$/, ''); for (const x of this.groups.values()) if (x.kind === 'guard' && x.id.replace(/\.\d+$/, '') === base) { x.pos = v; this.sys.sw[x.id] = v; } }
  /** ENG 1 / ENG 2 / APU FIRE pb-sw: released = fuel, hydraulic and bleed shut-off, generator off, agents armed; pushed back in = restored (FCOM DSC-26). */
  private fireToggle(i: number) {
    const h = this.host!, s = this.sys, nm = i === 2 ? 'APU' : `ENG ${i + 1}`;
    if (!s.fireOut[i]) { s.fireOut[i] = true; if (i < 2) { s.master[i] = false; s.gen[i] = false; s.engBleed[i] = false; } else { s.apuMaster = false; s.apuStart = false; s.apuBleed = false; s.apuGen = false; } h.toast(`${nm} FIRE pb released – fuel, hydraulic, bleed & generator shut off · agent SQUIBs armed`, 'warn'); }
    else { s.fireOut[i] = false; if (i < 2) { s.gen[i] = true; s.engBleed[i] = true; } else s.apuGen = true; h.toast(`${nm} FIRE pb pushed back in – systems restored`, 'info'); }
  }
  private discharge(a: number) {
    const h = this.host!, s = this.sys; if (!s.fireOut[fireOf(a)]) { h.toast('AGENT not armed – release the FIRE pb first', 'warn'); return; }
    if (s.agentDisch[a]) { h.toast('AGENT already discharged', 'info'); return; } s.agentDisch[a] = true; h.toast('AGENT discharged', 'good');
  }
  /** Keeps the posed 3-position light / sign switches equal to the real light state (also when it was changed by keyboard or another path). */
  private syncSwitches(h: CockpitHost) {
    const G = (id: string) => this.groups.get(id), L = h.lights; let g = G('BeaconLtSwtch'); if (g && L.beacon !== (g.pos === 1)) g.pos = L.beacon ? 1 : 0;
    g = G('StrobeLtSwtch'); if (g && L.strobe !== (g.pos >= 1)) g.pos = L.strobe ? 2 : 0;
    for (const id of ['LandingLtSwtch', 'LandingLtRSwtch']) { g = G(id); if (g && L.land !== (g.pos === 2)) g.pos = L.land ? 2 : 1; }
    g = G('NavLogoLtSwtch'); if (g && L.nav !== (g.pos !== 1)) g.pos = L.nav ? 2 : 1;
    g = G('SeatBeltSwtch'); if (g && h.seatbelt !== (g.pos === 2)) g.pos = h.seatbelt ? 2 : 0;
  }

  // ====================================================================== EFIS control panels (CAPT / F/O)
  private efisText(side: 0 | 1, fn: EfisFn): string {
    const e = this.sys.efis[side], b = (v: number) => (v < 0.03 ? 'OFF' : `${Math.round(v * 100)} %`);
    switch (fn) {
      case 'fd': return e.fd ? 'ON · bars shown' : 'OFF · bars removed'; case 'ls': return e.ls ? 'ON · LOC/GS scales' : 'OFF';
      case 'cstr': case 'wpt': case 'vord': case 'ndb': case 'arpt': return e.opt === fn ? 'ON' : 'OFF';
      case 'mode': return ND_MODE_NAMES[e.ndMode]; case 'range': return `${ND_RANGES[e.ndRange]} NM`;
      case 'baro': return e.std ? 'STD (pulled)' : e.unitInHg ? `${(e.inHg / 100).toFixed(2)} inHg (QNH)` : `${Math.round(e.hpa)} hPa (QNH)`;
      case 'unit': return e.unitInHg ? 'inHg' : 'hPa'; case 'nav0': return ['ADF', 'OFF', 'VOR'][e.nav[0] + 1]; case 'nav1': return ['ADF', 'OFF', 'VOR'][e.nav[1] + 1];
      case 'xfr': return e.xfr ? 'PFD / ND SWAPPED' : 'NORM';
      case 'pfd': return b(this.sys.bright.pfd[side]); case 'nd': return b(this.sys.bright.nd[side]); case 'ndOuter': return b(this.sys.bright.ndOuter[side]);
      case 'terr': return this.sys.terrOnNd[side] ? 'ON' : 'OFF';
    }
  }
  private efisHint(fn: EfisFn): string {
    switch (fn) {
      case 'baro': return 'Wheel / drag = set pressure · left-click = PUSH (QNH) · right-click or Shift = PULL (STD)';
      case 'unit': return 'Click or wheel = hPa / inHg';
      case 'mode': case 'range': return 'Wheel / drag to rotate · click = next · right-click = previous';
      case 'nav0': case 'nav1': return 'Click: OFF → VOR → ADF → OFF · right-click reverses';
      case 'pfd': case 'nd': case 'ndOuter': return 'Wheel / drag to rotate · fully counter-clockwise = OFF';
      default: return '';
    }
  }
  /** Keeps the posed state of the 3-position / 2-position EFIS switches equal to the systems state (also after another code path changed it). */
  private syncEfisGroups() {
    for (const id in EFIS_MAP) { const g = this.groups.get(id); if (!g) continue; const m = EFIS_MAP[id], e = this.sys.efis[m.side]; if (m.fn === 'nav0') g.pos = e.nav[0] + 1; else if (m.fn === 'nav1') g.pos = e.nav[1] + 1; else if (m.fn === 'xfr') g.pos = e.xfr ? 1 : 0; }
  }
  /** Pose of EFIS knobs / levers from the real state. Rotation sense: positive turn about an axis pointing at the pilot is counter-clockwise, so the pointer angle (clockwise
   *  from 12 o'clock) is mapped with the sign of the axis direction; the baro knob also slides out along the panel normal when pulled (STD) and dips when pressed. */
  private animateEfis(g: Group): boolean {
    const m = EFIS_MAP[g.id]; if (!m) return false; const e = this.sys.efis[m.side], rad = Math.PI / 180, br = this.sys.bright;
    let phi = 0, push = 0, lever = false;
    switch (m.fn) {
      case 'mode': phi = -90 + e.ndMode * 45; break;
      case 'range': phi = -90 + e.ndRange * 45; break;
      case 'baro': phi = g.angle / rad; push = e.std ? 0.004 : 0; break;
      case 'unit': phi = e.unitInHg ? -40 : 40; break;
      case 'pfd': phi = -135 + 270 * br.pfd[m.side]; break; case 'nd': phi = -135 + 270 * br.nd[m.side]; break; case 'ndOuter': phi = -135 + 270 * br.ndOuter[m.side]; break;
      case 'nav0': case 'nav1': lever = true; break;
      default: return false;
    }
    let ax = g.axis;
    if (lever && !ax) { const src = this.groups.get(g.id === 'vor-adf-1-right' ? 'vor-adf2' : 'vor-adf1')?.axis; if (src) ax = g.axis = { pivot: [src.pivot[0], src.pivot[1], g.box.getCenter(this.cv3).z], direction: src.direction }; }
    ax ??= this.axisOf(g);
    const th = lever ? NAV_SWITCH_SIGN * e.nav[m.fn === 'nav1' ? 1 : 0] * 0.5 : (ax.direction[0] > 0 ? -1 : 1) * (phi - (KNOB_REST_DEG[g.id] ?? 0)) * rad;
    this.rotMat(g.xf, ax.pivot[0], ax.pivot[1], ax.pivot[2], ax.direction[0], ax.direction[1], ax.direction[2], th);
    const dz = push - g.press * 0.0015;
    if (dz) { const n = g.nrm ??= this.panelNormal(g.box.getCenter(new THREE.Vector3())); this.tB.makeTranslation(n.x * dz, n.y * dz, n.z * dz); g.xf.premultiply(this.tB); }
    this.pose(g); return true;
  }

  // ====================================================================== posing (all matrices are model-space, allocation-free)
  private tA = new THREE.Matrix4(); private tB = new THREE.Matrix4(); private av3 = new THREE.Vector3(); private cv3 = new THREE.Vector3(); private sv3 = new THREE.Vector3();
  /** out = T(p) · R(axis, θ) · T(-p): rotation about an arbitrary axis through the pivot point p. */
  private rotMat(out: THREE.Matrix4, px: number, py: number, pz: number, ax: number, ay: number, az: number, th: number) {
    out.makeRotationAxis(this.av3.set(ax, ay, az).normalize(), th); const e = out.elements;
    e[12] = px - (e[0] * px + e[4] * py + e[8] * pz); e[13] = py - (e[1] * px + e[5] * py + e[9] * pz); e[14] = pz - (e[2] * px + e[6] * py + e[10] * pz); return out;
  }
  /** Mechanical axis of a control: the upstream manifest axis, otherwise derived from the part's bounding box (rotary knobs: through the centre along the
   *  panel normal; toggles: at the base of the lever, tilting about the horizontal in-panel axis) so no control can pivot about the model origin. */
  private axisOf(g: Group): Axis {
    if (g.axis) return g.axis; if (g.fb) return g.fb;
    const c = g.box.getCenter(this.cv3.set(0, 0, 0)), sz = g.box.getSize(this.sv3), n = this.panelNormal(c).clone();
    const half = 0.5 * (Math.abs(n.x) * sz.x + Math.abs(n.y) * sz.y + Math.abs(n.z) * sz.z);
    let d = n.clone(), px = c.x, py = c.y, pz = c.z;
    if (g.kind === 'switch' || g.kind === 'guard') { d = new THREE.Vector3().crossVectors(n, new THREE.Vector3(0, 1, 0)); if (d.lengthSq() < 1e-4) d.set(0, 0, 1); d.normalize(); px -= n.x * half; py -= n.y * half; pz -= n.z * half; }
    return (g.fb = { pivot: [px, py, pz], direction: [d.x, d.y, d.z] });
  }
  private setRot(g: Group, theta: number) { const a = this.axisOf(g); this.rotMat(g.xf, a.pivot[0], a.pivot[1], a.pivot[2], a.direction[0], a.direction[1], a.direction[2], theta); this.pose(g); }
  private rotAbout(g: Group, pivot: [number, number, number], axis: [number, number, number], theta: number) { this.rotMat(g.xf, pivot[0], pivot[1], pivot[2], axis[0], axis[1], axis[2], theta); this.pose(g); }
  /** Followers (A/THR disconnect button, reverse flap) ride on their thrust lever, so they never detach from it. */
  private pose(g: Group) {
    const lead = LEADER[g.id]; if (lead) { const l = this.groups.get(lead); if (l) g.xf.premultiply(l.xf); }
    for (const p of g.parts) p.node.matrix.multiplyMatrices(g.xf, p.m0);
  }
  /** Thrust-lever angle (rad) about its pivot, positive = forward. Reverse: pulled aft of IDLE by up to 20 deg. */
  private thrAngle(t: number, reverse = false) { return reverse ? -(0.17 + 0.18 * Math.min(1, Math.max(0, t))) : Math.min(1, Math.max(0, t)) * (Math.PI / 4); }
  private animate(g: Group, inp: CockpitInputs, d: PanelData) {
    const s = this.sys, ctl = this.host?.fm.ctl;
    if (EFIS_MAP[g.id] && this.animateEfis(g)) return;
    switch (g.id) {
      // pivot = where the lever's own centre line meets the quadrant slot (measured on the mesh: base (-0.095,-0.042), tip (-0.059,0.076) -> x = -0.110 at y = -0.09); 45 deg IDLE -> TOGA, reverse idle 20 deg aft of IDLE
      case 'thr_l_body': return this.rotAbout(g, THR_PIVOT_L, [0, 0, 1], this.thrAngle(inp.throttle, ctl?.reverse));
      case 'thr_r_body': return this.rotAbout(g, THR_PIVOT_R, [0, 0, 1], this.thrAngle(Math.min(1, Math.max(0, inp.throttle + (ctl?.thrOffset ?? 0))), ctl?.reverse));
      case 'Lcutoff': case 'Rcutoff': { const i = g.id === 'Lcutoff' ? 0 : 1, ax = this.axisOf(g), aft = ax.direction[2] < 0 ? 1 : -1; this.mstSm[i] += ((s.master[i] ? 0 : 1) - this.mstSm[i]) * Math.min(1, this.dtA * 16); return this.rotAbout(g, ax.pivot, ax.direction, aft * 0.6 * this.mstSm[i]); }
      case 'RudderTrim': { const ax = this.axisOf(g); this.rudSm += ((ctl?.rudTrim ?? 0) - this.rudSm) * Math.min(1, this.dtA * 12); return this.rotAbout(g, ax.pivot, ax.direction, this.rudSm * 1.3 * (ax.direction[1] < 0 ? 1 : -1)); }
      case 'rev_l': case 'rev_r': { const ax = g.axis; if (ax) return this.rotAbout(g, ax.pivot, ax.direction, ctl?.reverse ? -0.45 : 0); break; }
      case 'FlapsLever': return this.rotAbout(g, [0.087, -0.188, -0.1], [0, 0, 1], -inp.flapsIdx * 0.17);
      case 'SpdBrk': return this.rotAbout(g, [0.087, -0.206, 0.074], [0, 0, 1], s.spoilerArm ? 0.25 : -inp.speedbrake * 0.6);
      case 'gear_lever': return this.setRot(g, inp.gearDown ? 0 : 0.9);
      case 'ParkBrk': return this.setRot(g, ctl?.parking ? 0.6 : 0);
      case 'stick': {
        for (const p of g.parts) { const side = p.node.name.includes('_2') ? -1 : 1, z = 0.873 * side; this.rotMat(this.tA, -0.196, -0.092, z, 1, 0, 0, -inp.roll * 0.35 * side); this.rotMat(this.tB, -0.196, -0.092, z, 0, 0, 1, -inp.pitch * 0.3); g.xf.multiplyMatrices(this.tA, this.tB); p.node.matrix.multiplyMatrices(g.xf, p.m0); }
        return;
      }
      case 'tiller': case 'tillerFo': return this.setRot(g, inp.yaw * 0.9);
      case 'brakes_lb_psi': case 'brakes_rb_psi': return this.setRot(g, Math.min(1, s.hyd.yellow / 3000) * 2.0 * (ctl?.parking ? 0.3 : 1));
      case 'brakes_accum_psi': return this.setRot(g, s.accumPsi / 3000 * 2.0);
    }
    if (/Rudder(Pedal)/.test(g.id)) return;
    const t = g.kind === 'knob' || g.id === 'spd-sel' || g.id === 'hdg_sel' || g.id === 'alt-sel' || g.id === 'vs-sel';
    if (t) { const n = g.steps; const a = n >= 40 ? g.angle + g.pos * 0.26 : n >= 12 ? (g.pos - (n - 1) / 2) * (4.71 / (n - 1)) : ((g.pos - (n - 1) / 2) * (n <= 3 ? 0.7 : 0.5)); /* 270° sweep for 12-detent dimmers / temperature knobs */ return this.setRot(g, a + (g.id === 'hdg_sel' ? (d.apHdg * Math.PI / 180) : g.id === 'alt-sel' ? d.apAlt / 100 * 0.26 : g.id === 'spd-sel' ? d.apSpd * 0.26 : 0)); }
    if (g.kind === 'switch') { const n = SWITCH3.has(g.id) || /^audio_int_rad/.test(g.id) ? 3 : 2; return this.setRot(g, this.leverSign(g) * (g.pos - (n - 1) / 2) * (n === 2 ? 0.8 : 0.42)); }
    if (g.kind === 'guard') return this.setRot(g, g.pos ? 1.7 : 0);
    // overhead pb-sw: engaged (ON / AUTO) = flush IN, released (OFF) = 3.5 mm OUT; pressing adds 2 mm travel. Momentary keys only move while held.
    if (g.ovh) { const nr = g.nrm ??= this.panelNormal(g.box.getCenter(new THREE.Vector3())), o = (g.mom || this.stateOn(g.id) ? 0 : 0.0035) - (g.press ? 0.002 : 0); g.xf.makeTranslation(nr.x * o, nr.y * o, nr.z * o); this.pose(g); return; }
    // push buttons / keys: 1.8 mm depress while pressed, 0.9 mm when latched IN (toward the panel, along the panel normal)
    const dep = (g.press ? 0.0018 : 0) + (g.kind === 'push' && !ON_WHEN_IN.has(g.id) && g.pos === 0 ? 0.0009 : 0);
    const nrm = g.nrm ??= this.panelNormal(g.box.getCenter(new THREE.Vector3()));
    g.xf.makeTranslation(-nrm.x * dep, -nrm.y * dep, -nrm.z * dep); this.pose(g);
  }

  /** Overhead toggle levers: the highest position (ON / BRT / ON) is the one printed at the TOP of the legend. The overhead is read looking up with the tops of the characters
   *  towards the tail (see COCKPIT_PRESETS.overhead), so the top position is the AFT one (model +X). The sign of the model's hinge axis differs from switch to
   *  switch, so the turn direction is derived once from the lever geometry: a positive turn about the axis must swing the lever tip aft, otherwise it is mirrored. */
  private leverSign(g: Group): number {
    if (g.sgn !== undefined) return g.sgn; const c = g.box.getCenter(new THREE.Vector3());
    if (!(c.y > 0.78 && c.x > -0.3)) return (g.sgn = 1);
    const ax = this.axisOf(g), d = new THREE.Vector3(...ax.direction).normalize(), r = c.sub(new THREE.Vector3(...ax.pivot)), fwd = new THREE.Vector3().crossVectors(d, r).x;   // x-component of the tip velocity for a positive turn (+ = aft)
    return (g.sgn = fwd > 1e-6 ? 1 : -1);
  }

  private legendLit(g: Group, letter: string, row: number): [boolean, number] {
    const s = this.sys, id = g.id, h = this.host!, fm = h.fm; void row;
    const wired = this.stateOn(id); const onType = ON_WHEN_IN.has(id);
    const eng = [fm.eng[0].state === 2, fm.eng[1].state === 2];
    switch (letter) {
      case 'F': { const f = id === 'Gen1Btn' ? !s.gen[0] === false && eng[0] && !s.ac : id === 'Gen2Btn' ? false : id === 'GreenEngPump2' ? s.hydPump.green && eng[0] && s.hyd.green < 1500 : id === 'YellowEngPump' ? s.hydPump.yellow && eng[1] && s.hyd.yellow < 1500 : /FuelTank/.test(id) ? wired && s.tank.l + s.tank.r + s.tank.c < 20 : /Pack/.test(id) ? wired && eng[0] && eng[1] && s.bleedPsi[0] < 5 : false; return [f || s.lampTest > 0, 0xffb000]; }
      case 'A': return [id === 'APUStartBtn' ? s.apuRpm >= 95 : id === 'ExtPwrBtn' ? s.ext === false && fm.wow && fm.gs < 1 : false, 0x40ff60];
      case 'O': { const lit = onType ? wired : !wired; return [lit && s.dc || s.lampTest > 0, onType ? (id === 'APUStartBtn' || id === 'ExtPwrBtn' ? 0x40a8ff : 0x40a8ff) : 0xf0f6ff]; }
      case 'S': { const a = AGENT_IDX[id]; return [s.lampTest > 0 || (a !== undefined && s.fireOut[fireOf(a)] && !s.agentDisch[a]), 0xffb000]; }
      case 'D': { const a = AGENT_IDX[id]; return [s.lampTest > 0 || (a !== undefined && s.agentDisch[a]), 0xffb000]; }
      case 'M': return [!wired && s.dc, 0xf0f6ff];
    }
    return [false, 0];
  }
  private stateOn(id: string): boolean {
    const s = this.sys, g = this.groups.get(id);
    switch (id) {
      case 'BatteryBtn1': return s.bat[0]; case 'BatteryBtn2': return s.bat[1]; case 'ExtPwrBtn': return s.ext; case 'APUMasterBtn': return s.apuMaster; case 'APUStartBtn': return s.apuStart || s.apuRpm >= 95; case 'APUGenBtn': return s.apuGen; case 'APUBleedBtn': return s.apuBleed;
      case 'Gen1Btn': return s.gen[0]; case 'Gen2Btn': return s.gen[1]; case 'Eng1BleedBtn': return s.engBleed[0]; case 'Eng2BleedBtn': return s.engBleed[1]; case 'ACPack1Btn': return s.packs[0]; case 'ACPack2Btn': return s.packs[1];
      case 'WingAntiIceBtn': return s.wingAI; case 'Eng1AntiIceBtn': return s.engAI[0]; case 'Eng2AntiIceBtn': return s.engAI[1];
      case 'LFuelTank1Btn': return s.pumps[0]; case 'LFuelTank2Btn': return s.pumps[1]; case 'CFuelTank1Btn': return s.pumps[2]; case 'CFuelTank2Btn': return s.pumps[3]; case 'RFuelTank1Btn': return s.pumps[4]; case 'RFuelTank2Btn': return s.pumps[5];
      case 'GreenEngPump2': return s.hydPump.green; case 'YellowEngPump': return s.hydPump.yellow; case 'BlueElecPump': return s.hydPump.blue; case 'YellowElecPump': return s.hydPump.yElec; case 'PTU2': return s.hydPump.ptu;
      case 'firebtn1': return !s.fireOut[0]; case 'firebtn2': return !s.fireOut[1]; case 'firebtnapu': return !s.fireOut[2];
      case 'Eng1ManStartBtn': return s.master[0] && s.engMode === 2; case 'Eng2ManStartBtn': return s.master[1] && s.engMode === 2;
    }
    return !!g && g.pos === 1 ? true : false;
  }
  private ledOn(base: string): boolean {
    const s = this.sys, h = this.host!, d = this.ctx.d; if (!s.dc) return false; if (s.lampTest > 0) return true;
    switch (base) {
      case 'ap1': return s.apEng[0]; case 'ap2': return s.apEng[1]; case 'a-thr': return h.ap.on || s.athrArmed; case 'appr': return h.ap.appr; case 'loc': return s.locArmed; case 'exped': return s.exped; case 'fd1': return s.efis[0].fd; case 'fd2': return s.efis[1].fd; case 'terr_on_nd_on_l': return s.terrOnNd[0]; case 'terr_on_nd_on_r': return s.terrOnNd[1];
      case 'arpt': case 'cstr': case 'wpt': case 'vord': case 'ndb': return s.efis[0].opt === base; case 'arpt.001': case 'cstr.001': case 'wpt.001': case 'vord.001': case 'ndb.001': return s.efis[1].opt === base.replace('.001', ''); case 'ils': return s.efis[0].ls; case 'ils2': return s.efis[1].ls;
      case 'master_warning': return s.warnLit; case 'master_caution': return s.masterCaut; case 'autoland_light': return h.ap.on && h.ap.appr && !!d.ils?.valid;
      case 'abs_low': return s.autobrake === 1; case 'abs_med': return s.autobrake === 2; case 'abs_max': return s.autobrake === 3; case 'dec_low': case 'dec_med': case 'dec_max': return false;
      case 'ecam_eng': case 'ecam_bleed': case 'ecam_press': case 'ecam_elec': case 'ecam_hyd': case 'ecam_fuel': case 'ecam_apu': case 'ecam_cond': case 'ecam_door': case 'ecam_wheel': case 'ecam_fctl': case 'ecam_sts': case 'ecam_clr_l': case 'ecam_clr_r': case 'ecam_emer_canc': return s.ecam.lit(base);
      case 'brk_fan': case 'brk_hot': return false;
    }
    const rm = /^radio_(\w+?)\.(cpt|fo)$/.exec(base);
    if (rm) { const st = this.rmp[rm[2] === 'fo' ? 1 : 0], k = rm[1]; if (!st.on) return false; if (k === 'sel') return st.sel !== (rm[2] === 'fo' ? 'vhf2' : 'vhf1'); if (k === 'nav') return st.sel === 'nav' || st.sel === 'vor' || st.sel === 'ls' || st.sel === 'adf'; if (k === 'bfo') return st.bfo; if (k === 'am') return st.am; if (k === 'on' || k === 'opt' || k === 'exchange') return k === 'on'; return st.sel === k; }
    const am = /^audio_(\w+?)\.(cpt|fo)$/.exec(base);
    if (am) { const st = this.acp[am[2] === 'fo' ? 1 : 0]; return am[1].startsWith('call_') ? st.tx === am[1].slice(5) : !!st.rx[am[1]]; }
    const an = /^mcdu_ann_(\w+)\.(cpt|fo)$/.exec(base);
    if (an) { const mc = this.mcdu[an[2] === 'fo' ? 1 : 0]; switch (an[1]) { case 'msg': return !!mc.msg; case 'rdy': return !mc.msg; case 'fm1': return an[2] === 'cpt'; case 'fm2': return an[2] === 'fo'; default: return false; } }
    if (base === 'thr_quad_lts') return this.daylight < 0.5 && s.bright.flood > 0.05;
    if (/^engine_(fire|fault)_[12]$/.test(base)) return false;
    const g = this.groups.get(base); return !!g && g.pos === 1 && g.kind === 'push' && !!s.sw[base];
  }

  /** Called every frame while the interior is visible. */
  update(dt: number, time: number, data: PanelData, inp: CockpitInputs, ui: CockpitUi, visible: boolean) {
    if (this.fallback) { this.fallback.update(dt, time, data, inp, ui, visible); return; }
    if (!visible || !this.loaded || !this.host) return;
    this.lastInp = inp; const h = this.host, s = this.sys; this.frameNo++; this.dtA = dt;
    s.update(dt, h, data); this.syncFcu(dt, h, data);
    this.ctx.d = data; this.ctx.host = h; this.ctx.t = time; this.ctx.utc = new Date(simNowMs());
    for (const m of this.mcdu) m.attach(h);
    // lighting (day/night)
    const dl = this.daylight; this.hemi.intensity = 0.55 + 1.5 * dl + (1 - dl) * (0.9 * s.bright.flood + [0, 0.25, 0.7][this.groups.get('DomeLtSwtch')?.pos ?? 0]);   // DOME lt DIM / BRT /* panel / flood lights at night */ this.sun.intensity = 1.6 * dl;
    // screens: culled, resolution-scaled and time-sliced (PFD first, secondary pages at 10-20 Hz, clock 2 Hz) – see scheduleScreens()
    this.camera.updateMatrixWorld(); this.pv.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse); this.frustum.setFromProjectionMatrix(this.pv);
    this.scheduleScreens(time, s);
    this.updateEfb(dt, time, s, h); this.drawBaros(s); this.drawBatt(s); this.syncSwitches(h);
    if (this.fcuCanvas && this.fcuTex) {
      const key = [data.apSpd, data.apHdg, data.apAlt, s.ac, s.vsMode, s.vsTarget, s.fpaTarget, s.trkFpa, s.spdMach, s.spdManaged, s.hdgManaged, s.spdPre > 0, s.hdgPre > 0, s.vsPre > 0, s.spdPreVal, s.hdgPreVal, s.bright.fcu, Math.round(this.machFactor())].join('|');
      if (key !== this.fcuKey) { this.fcuKey = key; const cv = this.fcuCanvas, g = cv.getContext('2d')!; drawFCU(g, cv.width, cv.height, this.ctx, (z) => (this.fcuZ.c + this.fcuZ.w / 2 - z) / this.fcuZ.w); this.fcuTex.needsUpdate = true; }
    }
    this.updateFcuInd(s, data);
    // animation – every control is posed about its own pivot axis; static switches / buttons are only re-posed when their state changes
    this.syncEfisGroups();
    for (const g of this.animOrder) {
      if (g.ovh && !g.mom) g.pos = this.stateOn(g.id) ? 1 : 0;   // pose always follows the real system state
      if (g.still) { const k = g.pos * 7 + g.press * 13 + g.angle * 3; if (k === g.lastKey) { if (g.press > 0 && !this.active) g.press = Math.max(0, g.press - dt * 6); continue; } g.lastKey = k; }
      this.animate(g, inp, data); for (const p of g.parts) p.node.matrixWorldNeedsUpdate = true;
      if (g.press > 0 && !this.active) g.press = Math.max(0, g.press - dt * 6);
    }
    // lamps (20 Hz is plenty for annunciators)
    if (this.frameNo % 3 === 0) for (const l of this.lampNodes) {
      if (l.kind === 'led') {
        l.node.visible = this.ledOn(l.base);
        const kg = this.groups.get(l.base);
        if (kg && kg.kind === 'push' && l.node.visible) { if (!l.m0) { l.node.updateMatrix(); l.m0 = l.node.matrix.clone(); l.node.matrixAutoUpdate = false; } l.node.matrix.multiplyMatrices(kg.xf, l.m0); l.node.matrixWorldNeedsUpdate = true; }
        continue;
      }
      const g = this.groups.get(l.base); if (!g) continue; const [on, col] = this.legendLit(g, l.letter, l.row); const mt = l.node.material as THREE.MeshStandardMaterial;
      mt.emissive.setHex(on ? col : 0x000000); mt.emissiveIntensity = on ? 1.6 : 0;
    }
    // thrust-lever offset snaps back to a common setting when the two levers are close
    const c = h.fm.ctl; if (!this.active && Math.abs(c.thrOffset) < 0.03) c.thrOffset = 0;
    void ui;
  }

  // ---------------------------------------------------------------- screen scheduler
  /** Viewport height (px) and device pixel ratio – set by the game so each canvas can be sized to what is really visible. */
  vpH = 1080; dpr = 1; /** >1 while the frame rate is low: stretches every repaint period */ perfLoad = 1;
  private frameNo = 0; private due: Screen[] = []; private animOrder: Group[] = [];
  private byUrgency = (a: Screen, b: Screen) => b.urgency - a.urgency;
  private projPx(sphere: THREE.Sphere) { const d = Math.max(0.05, sphere.center.distanceTo(this.camera.position) - sphere.radius * 0.2), tv = Math.tan(this.camera.fov * Math.PI / 360); return (sphere.radius * 2 / (d * 2 * tv)) * this.vpH; }
  private scheduleScreens(time: number, s: A320Systems) {
    const br = this.brMap; br.pfd = briOf(s.bright.pfd[0]); br.pfd2 = briOf(s.bright.pfd[1]); br.nd = briOf(s.bright.nd[0]); br.nd2 = briOf(s.bright.nd[1]); br.uecam = s.bright.uecam; br.lecam = s.bright.lecam;
    if (this.frameNo === 1) this.group.updateMatrixWorld(true);
    this.due.length = 0;
    for (const sc of this.screens) {
      const lvl = br[sc.key] ?? 1, off = (sc.key === 'uecam' || sc.key === 'lecam') && lvl <= 0.04;
      sc.mat.color.setScalar(off ? 0 : lvl * (s.dc ? 1 : 0.0));
      if (!s.dc || off) { sc.next = 0; continue; }                                  // powered down: black, no repaint at all
      if ((this.frameNo + sc.idx) % 5 === 0 || sc.px === 0) {                // visibility + needed resolution: re-evaluated at 12 Hz
        // a Screen can drive several meshes (CAPT + F/O PFD, ND, E/WD): visible if any is in view, sized for the largest
        sc.vis = false; sc.px = 0.001;
        for (const m of sc.meshes) {
          if (!m.visible) continue; if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere(); sc.sphere.copy(m.geometry.boundingSphere!).applyMatrix4(m.matrixWorld);
          if (this.frustum.intersectsSphere(sc.sphere)) { sc.vis = true; sc.px = Math.max(sc.px, this.projPx(sc.sphere)); }
        }
        if (sc.vis) {
          const need = sc.px / 1.41 * Math.max(1, this.dpr);               // side of the screen in device pixels
          const want = RES_TIERS.find((t) => t >= need * 0.95) ?? RES_TIERS[RES_TIERS.length - 1], tgt = Math.min(sc.maxRes, want);
          if (tgt > sc.res) { sc.setRes(tgt); sc.lowSince = 0; }
          else if (tgt < sc.res) { sc.lowSince = sc.lowSince || time; if (time - sc.lowSince > 1.5) { sc.setRes(tgt); sc.lowSince = 0; } } else sc.lowSince = 0;
        }
      }
      if (!sc.vis || sc.px < 12) continue;                                   // off-screen or smaller than a dozen pixels
      if (time >= sc.next) { sc.urgency = sc.prio * (time - sc.next + sc.period) / sc.period; this.due.push(sc); }
    }
    if (!this.due.length) return;
    if (this.due.length > 1) this.due.sort(this.byUrgency);
    const t0 = performance.now(); let n = 0;
    for (const sc of this.due) {
      if (n > 0 && performance.now() - t0 > 3.2) { sc.next = Math.min(sc.next, time); continue; }    // frame budget spent: postpone, keeps priority next frame
      sc.next = time + sc.period * this.perfLoad; sc.render(); n++;
    }
  }
  // ---------------------------------------------------------------- stencil occlusion mask
  // The opaque flight deck covers roughly half of the forward view (glareshield, panels, pillars). Writing its silhouette to the stencil buffer FIRST lets the
  // game draw the (very expensive) world – terrain, city, sky, clouds – only through the windows: hidden fragments are rejected before shading.
  // Per-material stencil flags (instead of an override material) keep alpha-cut-out shapes exact; transparent parts never write the mask.
  private maskMats: THREE.Material[] = [];
  private collectMaskMats() { const set = new Set<THREE.Material>(); this.scene.traverse((o) => { const m = o as THREE.Mesh; if (!m.isMesh) return; for (const mt of Array.isArray(m.material) ? m.material : [m.material]) if (!mt.transparent) set.add(mt); }); for (const sc of this.screens) set.add(sc.mat); this.maskMats = [...set]; }
  get canMask() { return this.loaded && !this.fallback && this.maskMats.length > 0; }
  /** Colour-less pass that stamps stencil = 1 wherever the opaque flight deck is visible. */
  renderMask(r: THREE.WebGLRenderer) {
    for (const m of this.maskMats) { m.colorWrite = false; m.stencilWrite = true; m.stencilRef = 1; m.stencilFunc = THREE.AlwaysStencilFunc; m.stencilZPass = THREE.ReplaceStencilOp; }
    r.render(this.scene, this.camera);
    for (const m of this.maskMats) { m.colorWrite = true; m.stencilWrite = false; }
  }
  private brMap: Record<string, number> = {};
  private efbScale = 1; private efbLast = 0;
  private updateEfb(dt: number, time: number, s: A320Systems, h: CockpitHost) {
    const m = this.efbMesh; if (!m || !this.efbCanvas || !this.efbTex) return;
    // bezel buttons: BRT / DIM auto-repeat after 0.45 s (every 0.12 s) while the pointer is held
    const hd = this.efbHeld; if (hd && EFB_BTNS.find((b) => b.id === hd.id)?.repeat) { hd.t += dt; if (hd.t > 0.45) { hd.rep += dt; while (hd.rep >= 0.12) { hd.rep -= 0.12; this.actEfbBtn(hd.id, false); } } }
    // cap travel: critically damped spring towards pressed (held / just tapped) or released – a tap always shows at least ~0.12 s of travel
    for (const [id, c] of this.efbCaps) {
      const f = Math.max(0, (this.efbFlash.get(id) ?? 0) - dt); this.efbFlash.set(id, f); const target = hd?.id === id || f > 0 ? 1 : 0;
      const k = 900, z = 2 * Math.sqrt(k); c.vel += ((target - c.pos) * k - c.vel * z) * dt; c.pos = Math.min(1.05, Math.max(0, c.pos + c.vel * dt));
      c.group.position.copy(this.efbFn).multiplyScalar(-c.travel * c.pos);
    }
    (m.material as THREE.MeshBasicMaterial).color.setScalar((0.3 + 0.7 * this.daylight) * (s.dc ? 1 : 0.08) * (this.efbPower ? 0.25 + 0.75 * this.efbBright : 0)); // PWR = backlight, BRT/DIM = intensity
    for (const b of this.efbBtnMeshes) { if (this.efbCaps.has(b.name)) continue; const f = Math.max(0, (this.efbFlash.get(b.name) ?? 0) - dt); this.efbFlash.set(b.name, f); (b.material as THREE.MeshBasicMaterial).opacity = f > 0 ? 0.35 : 0; } // ports / un-extractable caps: brief shadow = pressed
    if (this.frameNo % 5 === 0 || !this.efbSphere.radius) { this.efbSphere.copy(m.geometry.boundingSphere ?? (m.geometry.computeBoundingSphere(), m.geometry.boundingSphere!)).applyMatrix4(m.matrixWorld); this.efbVis = this.frustum.intersectsSphere(this.efbSphere); this.efbPx = this.efbVis ? this.projPx(this.efbSphere) : 0; }
    if (!this.efbVis || this.efbPx < 14) return;
    const want = this.efbPx * Math.max(1, this.dpr) / 1.2 > 1024 ? 2 : this.efbPx * Math.max(1, this.dpr) / 1.2 > 640 ? 1.5 : 1; // tablet face ≈ 83 % of the sphere diameter
    if (want !== this.efbScale) { this.efbScale = want; this.efbCanvas.width = Math.round(Efb.W * want); this.efbCanvas.height = Math.round(Efb.H * want); this.efbTex.dispose(); this.efb.dirty = this.efbFo.dirty = true; this.efbNext = 0; }
    const dirty = this.efbShown.dirty, gap = dirty ? 1 / 20 : 0.5;                              // clicks repaint at ≤ 20 Hz, idle refresh (clock / METAR) at 2 Hz
    if (time >= this.efbNext || (dirty && time - this.efbLast > gap)) { this.efbNext = time + 0.5; this.efbLast = time; this.efbShown.draw(this.efbCanvas.getContext('2d')!, h.efbInfo?.() ?? null, this.daylight, this.efbScale); this.efbTex.needsUpdate = true; }
  }
  private efbSphere = new THREE.Sphere(); private efbVis = false; private efbPx = 0;

  /** Legacy helpers kept for the game's HUD hooks. */
  pick(ray: THREE.Raycaster, allowDisplay = false): { id: string; instance?: number; point: THREE.Vector3 } | null {
    if (this.fallback) return this.fallback.pick(ray, allowDisplay);
    const p = this.pickGroup(ray); return p ? { id: p.g.id, point: p.hit.point } : null;
  }
  get inputs() { return this.lastInp; }
  dispose() { this.fallback?.dispose(); this.scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); }); for (const s of this.screens) { s.tex.dispose(); s.mat.dispose(); } }
  /** First-person seat positions in body space (captain / first officer). */
  eyeBody(fo = false) { const e = fo ? FO_EYE_M : EYE_M; const [ex, ey, ez] = this.spec.eye; const tx = ex + EYE_M.z, ty = ey - EYE_M.y, tz = ez - EYE_M.x; return new THREE.Vector3(-e.z + tx, e.y + ty, e.x + tz); }

  /** Per-frame FCU logic that does not belong to a single control: AP channel bookkeeping, preselect time-outs, V/S capture, LOC capture. */
  private syncFcu(dt: number, h: CockpitHost, d: PanelData) {
    const s = this.sys, ap = h.ap;
    s.spdPre = Math.max(0, s.spdPre - dt); s.hdgPre = Math.max(0, s.hdgPre - dt); s.vsPre = Math.max(0, s.vsPre - dt);
    if (!ap.on) { s.apEng[0] = s.apEng[1] = false; s.exped = false; ap.vsHoldFpm = null; }
    else { if (!s.apEng[0] && !s.apEng[1]) s.apEng[0] = true; s.hdgManaged = ap.nav; }
    s.vsMode = ap.on && ap.vsHoldFpm != null;
    ap.expedite = s.exped; ap.spdSelected = !s.spdManaged; ap.altSelected = !s.altManaged;
    if (s.locArmed && ap.on && d.ils?.valid && !ap.appr) { s.locArmed = false; h.action('appr'); }
  }
  /** FCU window legends (SPD/MACH, HDG/TRK, V/S/FPA, LVL/CH) and the managed dots are meshes of the model; they are lit by state. */
  private updateFcuInd(s: A320Systems, d: PanelData) {
    const on = s.ac || s.acEss, ap = this.host!.ap; const show = (n: string, v: boolean) => { const m = this.fcuInd.get(n); if (m) m.visible = on && v; };
    show('spd.ind', !s.spdMach); show('mach.ind', s.spdMach); show('hdg.ind', !s.trkFpa); show('trk.ind', s.trkFpa); show('hdg2.ind', !s.trkFpa); show('trk2.ind', s.trkFpa);
    show('vs.ind', !s.trkFpa); show('fpa.ind', s.trkFpa); show('vs.ind.001', !s.trkFpa); show('fpa.ind.001', s.trkFpa);
    show('spd.fmgc', s.spdManaged); show('lat.fmgc', s.hdgManaged && ap.on); show('ver.fmgc', s.altManaged && ap.on);
    show('lvlch.ind', ap.on && !s.vsMode && Math.abs(d.apAlt - d.altFt) > 150);
  }
  private drawBaros(s: A320Systems) {
    for (const b of this.baro) {
      const e = s.efis[b.side];
      const key = [s.dc, e.std, e.unitInHg, e.hpa, e.inHg, s.bright.integ].join('|'); if (key === b.key) continue; b.key = key;
      drawBaro(b.cv.getContext('2d')!, b.cv.width, b.cv.height, this.ctx, b.side); b.tex.needsUpdate = true;
    }
  }

  /** PUSH / PULL of a rotary encoder (FCOM DSC-22_10: push = managed / level-off / QNH, pull = selected / open / V/S / STD). */
  private activateKnob(g: Group, how: 'push' | 'pull') {
    const h = this.host!, s = this.sys; this.slideDir.set(g.id, how === 'push' ? 1 : -1);
    switch (g.id) {
      case 'spd-sel':
        if (how === 'push') { s.spdManaged = true; s.spdPre = 0; h.toast('SPEED: managed (FMGS)', 'info'); }
        else { const pre = s.spdManaged && s.spdPre > 0; s.spdManaged = false; h.ap.spdSelected = true; if (pre) h.setApTarget('spd', s.spdPreVal); s.spdPre = 0; h.toast('SPEED: selected', 'info'); }
        break;
      case 'hdg_sel':
        if (how === 'push') { s.hdgManaged = true; s.hdgPre = 0; if (h.ap.on && !h.ap.nav) h.action('apnav'); h.toast(h.ap.on ? 'NAV: managed lateral guidance' : 'NAV armed (engage AP)', 'info'); }
        else { s.hdgManaged = false; if (s.hdgPre > 0) h.setApTarget('hdg', s.hdgPreVal); else if (h.ap.on && h.ap.nav) h.action('aphdg'); s.hdgPre = 0; h.toast('HDG: selected heading', 'info'); }
        break;
      case 'alt-sel':
        if (how === 'push') { s.altManaged = true; h.ap.altSelected = false; h.toast('ALT: managed climb / descent (VNAV profile)', 'info'); }
        else { s.altManaged = false; h.ap.altSelected = true; h.toast('ALT: open climb / descent to FCU altitude', 'info'); }
        break;
      case 'vs-sel':
        if (!h.ap.on) { h.toast('V/S: engage AP1 / AP2 first', 'warn'); break; }
        s.vsMode = true; s.vsPre = 0;
        if (how === 'push') { s.vsTarget = 0; s.fpaTarget = 0; h.ap.vsHoldFpm = 0; h.toast('V/S 0 – level off', 'info'); } else { this.applyVsHold(); h.toast('V/S mode engaged', 'info'); }
        break;
      case 'qnh_cpt_knb': s.efisBaroSet(0, how === 'pull'); break;
      case 'qnh_fo_knb': s.efisBaroSet(1, how === 'pull'); break;
    }
  }
  private clampN(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }
  /** IAS per Mach at the current flight condition (sea-level 661.5 kt/M on the ground) – converts the FCU Mach window to the autopilot's knot target. */
  private machFactor() { const d = this.ctx.d; return d.mach > 0.05 && d.kias > 30 ? d.kias / d.mach : 661.5; }
  private applyVsHold() { const h = this.host!, s = this.sys; h.ap.vsHoldFpm = s.trkFpa ? Math.round(Math.tan(s.fpaTarget * Math.PI / 180) * Math.max(100, this.ctx.d.gsKt) * 1.0127) * 100 : s.vsTarget; }
  /** One click of an FCU encoder (32 clicks per turn). Managed windows show a preselection (10 s SPD, 45 s HDG / V/S) until the knob is pulled. */
  private fcuTurn(g: Group, dir: number, shift: boolean) {
    const h = this.host!, s = this.sys; g.angle += dir * Math.PI / 16;
    switch (g.id) {
      case 'spd-sel': {
        if (s.spdManaged && s.spdPre <= 0) { s.spdPreVal = h.ap.spd; s.spdPre = 10; return; }
        const f = this.machFactor(), cur = s.spdManaged ? s.spdPreVal : h.ap.spd;
        const next = Math.round(s.spdMach ? this.clampN(Math.round(cur / f * 100) + dir, 10, 99) / 100 * f : this.clampN(cur + dir * (shift ? 10 : 1), 100, 399));
        if (s.spdManaged) { s.spdPreVal = next; s.spdPre = 10; } else h.setApTarget('spd', next);
        return;
      }
      case 'hdg_sel': {
        const cur = ((Math.round(h.ap.hdg + h.magVar(h.ap.hdg)) % 360) + 360) % 360;
        if (s.hdgManaged && s.hdgPre <= 0) { s.hdgPreVal = cur; s.hdgPre = 45; return; }
        const next = ((s.hdgManaged ? s.hdgPreVal : cur) + dir * (shift ? 10 : 1) + 360) % 360;
        if (s.hdgManaged) { s.hdgPreVal = next; s.hdgPre = 45; } else h.setApTarget('hdg', next);
        return;
      }
      case 'alt-sel': {
        const t = this.clampN(Math.round((h.ap.altFt + dir * (shift ? 1000 : s.altStep1000 ? 1000 : 100)) / 100) * 100, 100, 49000);
        if (s.altManaged && h.ap.on && h.ap.nav) { s.altManaged = false; h.toast('ALT: FCU target set – open climb / descent (push ALT for managed)', 'info'); }
        h.ap.altSelected = !s.altManaged; h.setApTarget('alt', t); return;
      }
      case 'vs-sel': {
        if (s.trkFpa) s.fpaTarget = Math.round(this.clampN(s.fpaTarget + dir * 0.1, -9.9, 9.9) * 10) / 10; else s.vsTarget = this.clampN(s.vsTarget + dir * (shift ? 500 : 100), -6000, 6000);
        if (s.vsMode) this.applyVsHold(); else s.vsPre = 45;
        return;
      }
    }
  }
  /** AP1 / AP2 pushbuttons: each channel engages and disengages on its own; the autopilot stays on while either is engaged (dual-AP for approach). */
  private apPress(i: 0 | 1) {
    const h = this.host!, s = this.sys, other = s.apEng[1 - i];
    if (s.apEng[i]) { s.apEng[i] = false; if (!other && h.ap.on) h.action('ap'); return; }
    if (h.ap.on) { s.apEng[i] = true; return; }
    h.action('ap'); if (h.ap.on) s.apEng[i] = true;
  }
  private routeDisplays() {
    const d = this.screenDefs, sw = this.sys.switching; if (!d.pfd) return;
    const own = sw.attHdg !== 1 || sw.airData !== 1;
    const target: Record<string, string> = {
      'pfd1.screen': 'pfd', 'pfd2.screen': own ? 'pfd2' : 'pfd', 'ND.screen': sw.ndXfr === 0 ? 'lecam' : 'nd', 'ND_R.screen': sw.ndXfr === 2 ? 'lecam' : own ? 'nd2' : 'nd',
      'uecam.screen': 'uecam', 'uecam.screen2': 'uecam', 'lecam.screen': 'lecam', 'mcdu1.screen': 'mcdu1', 'mcdu2.screen': 'mcdu2', iesi_screen: 'isis', clock_display: 'clock',
    };
    for (const sc of Object.values(d) as Screen[]) sc.meshes.length = 0;
    for (const [name, m] of this.screenMesh) { const sc = d[target[name]]; if (!sc) continue; sc.meshes.push(m); m.material = sc.mat; }
    for (const sc of Object.values(d) as Screen[]) sc.px = 0;
  }

}
