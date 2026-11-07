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
import { A320Systems, CockpitHost, EcamPage } from './a320/systems';
import { Ctx, Mcdu, drawPFD, drawND, drawEWD, drawSD, drawISIS, drawFCU, drawClock } from './a320/displays';
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
  efb: { c: V(-0.0636, 0.3244, 0.9221), n: N(0.588, 0.196, -0.784), w: 0.27, h: 0.2 },
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
export type CockpitPreset = keyof typeof COCKPIT_PRESETS | CockpitPanelId;

type Kind = 'push' | 'switch' | 'knob' | 'guard' | 'lever' | 'key' | 'stick' | 'toggle';
interface Part { node: THREE.Mesh; m0: THREE.Matrix4; }
interface Group { id: string; kind: Kind; parts: Part[]; axis?: Axis; pos: number; angle: number; press: number; label: string; steps: number; box: THREE.Box3; lamps: { node: THREE.Mesh; letter: string; row: number }[]; nrm?: THREE.Vector3; }

// ---- naming helpers ----
const MCDU_KEYS = new Set(['init', 'f-pln', 'f-pln2', 'radnav', 'fuel-pred', 'prog', 'perf', 'data', 'dir', 'airport', 'clr', 'sp', 'left', 'right', 'up', 'down', 'opt1', 'opt2', 'overfly', '+/-', '/', '.', 'mcdu', 'sec-fpln']);
for (const c of 'abcdefghijklmnopqrstuvwxyz0123456789') MCDU_KEYS.add(c);
for (let i = 1; i <= 6; i++) { MCDU_KEYS.add('L' + i); MCDU_KEYS.add('R' + i); }
const ON_WHEN_IN = new Set(['APUMasterBtn', 'APUStartBtn', 'ExtPwrBtn', 'Eng1ManStartBtn', 'Eng2ManStartBtn', 'RamAirBtn', 'WingAntiIceBtn', 'Eng1AntiIceBtn', 'Eng2AntiIceBtn', 'PrbWinHeatBtn', 'EmerCallBtn', 'EvacCommandBtn', 'CrewOxyBtn', 'GalleyPwrBtn', 'CommercialBtn', 'RcdrGndCtlBtn', 'ToiletBtn', 'DitchBtn', 'MaskManOnBtn']);
const DEFAULT_OFF = new Set(['APUMasterBtn', 'APUStartBtn', 'ExtPwrBtn', 'Eng1ManStartBtn', 'Eng2ManStartBtn', 'RamAirBtn', 'DitchBtn', 'EvacCommandBtn', 'RcdrGndCtlBtn', 'MaskManOnBtn', 'WingAntiIceBtn', 'Eng1AntiIceBtn', 'Eng2AntiIceBtn', 'Lcutoff', 'Rcutoff']);
const SWITCH3 = new Set(['StrobeLtSwtch', 'LandingLtSwtch', 'LandingLtRSwtch', 'NoseLtSwtch', 'NavLogoLtSwtch', 'SeatBeltSwtch', 'NoSmokingSwtch', 'EmerExtLtSwtch', 'DomeLtSwtch', 'TurnoffLtSwtch', 'WingLtSwtch', 'AnnunciatorLtSwtch', 'CockpitDoorSwitch', 'ManVSCTLSwitch', 'DLSSysSwtch']);
const KNOB_STEPS: Record<string, number> = { IR1ModeKnb: 3, IR2ModeKnb: 3, IR3ModeKnb: 3, XbleedKnb: 3, eng_mode: 3, nd_mode: 5, nd_mode_fo: 5, nd_range: 6, nd_range_fo: 6, CockpitACKnb: 12, FwdCabinACKnb: 12, AftCabinACKnb: 12, ACFlowKnb: 3, LdgElevKnb: 12, LeftWiperKnb: 4, RightWiperKnb: 4, radar_mode: 4, radar_sys: 3, 'qnh_cpt_sw': 3, 'qnh_fo_sw': 3, 'spd-sel': 40, hdg_sel: 40, 'alt-sel': 40, 'vs-sel': 40, 'qnh_cpt_knb': 40, 'qnh_fo_knb': 40, iesi_baro_knb: 40, clock_knob: 3, LReadingLtKnb: 12, RReadingLtKnb: 12, OHPMarkLtKnb: 12 };
const FCU_TOGGLES = new Set(['ap1', 'ap2', 'a-thr', 'appr', 'loc', 'exped', 'fd1', 'fd2', 'arpt', 'arpt.001', 'cstr', 'cstr.001', 'wpt', 'wpt.001', 'vord', 'vord.001', 'ndb', 'ndb.001', 'ils', 'ils2', 'hdg-vs', 'spd-mach', 'metric_alt', 'alt-sel-mode', 'vor-adf1', 'vor-adf2', 'vor-adf-1-right', 'vor-adf-2-right', 'master_warning', 'master_caution', 'chrono_btn', 'chrono_reset', 'abs_low', 'abs_med', 'abs_max', 'ecam_all', 'ecam_clr_l', 'ecam_clr_r', 'ecam_rcl', 'ecam_emer_canc', 'ecam_to_config', 'gear_lever', 'ParkBrk', 'rev_l', 'rev_r', 'gravity_gear', 'tiller', 'tillerFo', 'RudderTrim', 'RudderTrimReset', 'thr_l_button', 'thr_r_button', 'pfd_nd_xfr_sw', 'pfd_nd_xfr_sw2', 'terr_on_nd_l', 'terr_on_nd_r', 'iesi_btn_bugs', 'iesi_btn_ls', 'iesi_btn_minus', 'iesi_btn_plus', 'iesi_btn_rst', 'clock_set', 'et_knob', 'HeadsetHangerCpt', 'extinguisher', 'brk_fan', 'FuelXFeedBtn']);
const SCREENS: Record<string, 'pfd' | 'nd' | 'uecam' | 'lecam' | 'mcdu1' | 'mcdu2' | 'isis' | 'clock'> = { 'pfd1.screen': 'pfd', 'pfd2.screen': 'pfd', 'ND.screen': 'nd', 'ND_R.screen': 'nd', 'uecam.screen': 'uecam', 'uecam.screen2': 'uecam', 'lecam.screen': 'lecam', 'mcdu1.screen': 'mcdu1', 'mcdu2.screen': 'mcdu2', iesi_screen: 'isis', clock_display: 'clock' };
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

class Screen {
  canvas = document.createElement('canvas'); tex: THREE.CanvasTexture; mat: THREE.MeshBasicMaterial; next = 0; meshes: THREE.Mesh[] = [];
  constructor(public key: string, size: number, public period: number, aspect = 1, public draw: (g: CanvasRenderingContext2D, W: number, H: number) => void) {
    this.canvas.width = size; this.canvas.height = Math.round(size / aspect);
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.flipY = false; this.tex.colorSpace = THREE.SRGBColorSpace; this.tex.anisotropy = 16; this.tex.generateMipmaps = true; this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false });
  }
  render() { const g = this.canvas.getContext('2d')!; g.save(); this.draw(g, this.canvas.width, this.canvas.height); g.restore(); this.tex.needsUpdate = true; }
}

export class Cockpit {
  scene = new THREE.Scene(); group = new THREE.Group(); root = new THREE.Group();
  camera = new THREE.PerspectiveCamera(68, 1, 0.02, 80);
  views: Record<'cockpit' | 'aisle' | 'window', View>;
  interactive: THREE.Object3D[] = []; readonly cabinHeads: THREE.Object3D[] = [];
  host?: CockpitHost; sys = new A320Systems(); mcdu = [new Mcdu(), new Mcdu()];
  ready: Promise<void>; loaded = false; fallback?: ProceduralCockpit; daylight = 1;
  zoom = 1; private zoomT = 1; private fovCur = 68; private fovT = 68;
  private groups = new Map<string, Group>(); private byNode = new Map<THREE.Object3D, Group>(); private lampNodes: { node: THREE.Mesh; base: string; kind: 'led' | 'leg'; letter: string; row: number }[] = [];
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
    const maxA = 16; const nodes = new Map<string, THREE.Mesh>(); const all: THREE.Mesh[] = [];
    model.traverse((o) => { if ((o as THREE.Mesh).isMesh) { const m = o as THREE.Mesh; all.push(m); nodes.set(m.name, m); const mt = m.material as THREE.MeshStandardMaterial; if (mt.map) { mt.map.anisotropy = maxA; mt.map.needsUpdate = true; } } });
    // ---- classify ----
    const legendRe = /^(\d)([A-Z])(\.\d+)?$/;
    const baseOfLegend = (name: string) => { for (let n = name.length - 2; n > 2; n--) { const b = name.slice(0, n); if (nodes.has(b) && legendRe.test(name.slice(n))) return { base: b, row: +name[n], letter: name[n + 1] }; } return null; };
    const isLed = (n: string) => /(_led|_on|_lit|_illuminated)(\.\w+)?$/.test(n) && !/^radio_on/.test(n) && !/_on$/.test(n.replace(/^abs_|^dec_/, 'x')) || /^(abs_(low|med|max)_on|dec_(low|med|max)_on|master_(warning|caution)_on|autoland_light_on|ecam_emer_canc_lit|EltLed|IrsOnBatLight|brk_(hot|fan)_on|terr_on_nd_on_[lr]|gpws_gs_sw_(gpws|gs)_on)/.test(n);
    const groups = this.groups; const used = new Set<THREE.Mesh>();
    const mkGroup = (id: string, kind: Kind): Group => { let g = groups.get(id); if (!g) { g = { id, kind, parts: [], axis: manifest.axes[id + '.axis'], pos: 0, angle: 0, press: 0, label: prettify(id), steps: KNOB_STEPS[id] ?? 12, box: new THREE.Box3(), lamps: [] }; groups.set(id, g); } return g; };
    const addPart = (g: Group, m: THREE.Mesh) => { m.updateMatrix(); m.matrixAutoUpdate = false; g.parts.push({ node: m, m0: m.matrix.clone() }); used.add(m); const b = new THREE.Box3().setFromObject(m); g.box.union(b); };
    for (const m of all) {
      const n = m.name; if (HIDE.test(n)) { m.visible = false; used.add(m); continue; }
      if (SCREENS[n]) continue; if (FCU_IND.has(n)) { m.visible = false; used.add(m); continue; }
      const leg = baseOfLegend(n);
      if (leg) { this.lampNodes.push({ node: m, base: leg.base, kind: 'leg', letter: leg.letter, row: leg.row }); used.add(m); continue; }
      const lb = n.match(/^(.*?)_(?:led|lit)(\.cpt|\.fo|\.ovh)?(\.\d+)?$/);
      if (lb || isLed(n)) { this.lampNodes.push({ node: m, base: lb ? lb[1] + (lb[2] ?? '') : n.replace(/(_led|_on|_lit|_illuminated)(\.\w+)?$/, ''), kind: 'led', letter: '', row: 0 }); m.visible = false; used.add(m); continue; }
      if (n === 'atc_screen' || n === 'main_panel_screen') { used.add(m); continue; }
    }
    for (const m of all) {
      if (used.has(m) || SCREENS[m.name]) continue; const n = m.name;
      const key = n.replace(/\.(cpt|fo|ovh)$/, ''), side = /\.fo$/.test(n) ? 'fo' : 'cpt';
      let kind: Kind | null = null, id = n;
      if (/\.mark$/.test(n) && nodes.has(n.replace(/\.mark$/, ''))) { const g = mkGroup(n.replace(/\.mark$/, ''), 'knob'); addPart(g, m); continue; }
      if (/\.cpt$|\.fo$/.test(n) && MCDU_KEYS.has(key)) { kind = 'key'; id = (side === 'fo' ? 'F:' : 'C:') + key; }
      else if (/(Knb)$/.test(n) || n in KNOB_STEPS || /^(brightness_|pfd_brt|ecam_brt|speaker_volume|lt_knb|flood_lt_main$|flood_lt_ped$|integ_lt$|fcu_integ_knb|light_console|nd_range|nd_mode|radar_(gain|tilt|gcs)|audio_pa_rot|radio_rot)/.test(n)) kind = 'knob';
      else if (/Swtch$|Switch$/.test(n) || SWITCH3.has(n) || /_sw$|_sw\.(cpt|fo)$|^qnh_(cpt|fo)_sw$|^(land_sw|NoseLtSwtch|trim_?\w*)$/.test(n)) kind = 'switch';
      else if (/(Guard|Prot|Cover)(\.\d+)?$/.test(n) || /^(APUFireCover|Eng[12]FireCover)$/.test(n)) kind = 'guard';
      else if (/Btn$/.test(n) || /^(OVH_button\.\d+|ecam_(?!.*(_led|_lit)$)\w+|firebtn\w*|PedestalFireBtn\.(cpt|fo)|EmerGenTest(\.\d+)?|Eng[12]FireTst|APUFireTst|CVR\w+|\w+Call|EvacHornOff|EvacCapt-Purs|SEC\dBtn|CargoSmkTest|LeftRainTest|RightRainTest|DLSSys(Next|Prev|SelCtl)Btn|atc_\w+|radio_\w+|audio_\w+|\w+\.(cpt|fo))$/.test(n) || FCU_TOGGLES.has(n) || /^(spd-sel|hdg_sel|alt-sel|vs-sel)$/.test(n)) kind = 'push';
      else if (/^(gear_lever|FlapsLever|SpdBrk|ParkBrk|thr_[lr]_body|Lcutoff|Rcutoff|eng_mode)$/.test(n)) kind = 'lever';
      else if (/^sidestick_[12]/.test(n)) { kind = 'stick'; id = 'stick'; }
      if (/(_led|_on|_lit|_glare|_illuminated)(\.\w+)?$|\.mark$|^audio_.*(_led|_glare|_sgn)/.test(n) || /^(brk_|ecam_.*_led)/.test(n)) kind = kind === 'knob' ? kind : null;
      if (!kind) continue;
      if (kind === 'lever' && /^FlapsLever_low$/.test(n)) continue;
      const g = mkGroup(id, kind); addPart(g, m);
    }
    // legends & marks follow their button
    for (const l of this.lampNodes) { if (l.kind === 'leg') { const g = groups.get(l.base); if (g) { g.lamps.push({ node: l.node, letter: l.letter, row: l.row }); this.cloneMat(l.node); addPart(g, l.node); } } }
    for (const g of groups.values()) {
      g.label = g.id.startsWith('C:') ? `MCDU KEY ${g.id.slice(2).toUpperCase()}` : g.id.startsWith('F:') ? `MCDU KEY ${g.id.slice(2).toUpperCase()} (F/O)` : prettify(g.id);
      if (g.kind === 'stick') g.label = 'SIDESTICK';
      for (const p of g.parts) this.interactive.push(p.node);
      if (!ON_WHEN_IN.has(g.id) && !DEFAULT_OFF.has(g.id)) g.pos = 1; else g.pos = 0; if (g.kind === 'switch') g.pos = 0;
      for (const p of g.parts) this.byNode.set(p.node, g);
    }
    // lamp nodes (LEDs) default hidden; legends keep texture
    // ---- merge static geometry ----
    const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>(); const lampSet = new Set(this.lampNodes.map((l) => l.node));
    const toRemove: THREE.Mesh[] = []; const rel = new THREE.Matrix4();
    for (const m of all) {
      if (used.has(m) && !lampSet.has(m)) { if (HIDE.test(m.name) || FCU_IND.has(m.name)) { m.visible = false; } else if (this.byNode.has(m)) continue; }
      if (this.byNode.has(m) || lampSet.has(m) || SCREENS[m.name] || !m.visible) continue;
      m.updateWorldMatrix(true, false); const arr = byMat.get(m.material as THREE.Material) ?? []; arr.push(flatten(m.geometry, rel.copy(this.root.matrixWorld).invert().multiply(m.matrixWorld))); /* model space, relative to this.root */ byMat.set(m.material as THREE.Material, arr); toRemove.push(m);
    }
    for (const m of toRemove) { m.parent?.remove(m); m.geometry.dispose(); }
    const merged = new THREE.Group();
    for (const [mat, geos] of byMat) { const g = mergeGeometries(geos, false); if (!g) { console.warn('[cockpit] merge failed for', (mat as THREE.Material).name); continue; } const mesh = new THREE.Mesh(g, mat); mesh.matrixAutoUpdate = false; mesh.frustumCulled = false; merged.add(mesh); for (const x of geos) x.dispose(); }
    this.root.add(merged);
    // ---- screens ----
    this.buildScreens(nodes);
    // ---- FCU overlay (digits) ----
    this.buildFcu(nodes); this.buildEfb();
    this.ctx = { d: null as unknown as PanelData, sys: this.sys, host: null as unknown as CockpitHost, t: 0, mcdu: this.mcdu[0], utc: new Date() };
    this.loaded = true; this.setPreset('pilot', true);
  }

  private cloneMat(m: THREE.Mesh) { const mt = (m.material as THREE.MeshStandardMaterial).clone(); mt.emissiveMap = mt.map; mt.emissive = new THREE.Color(0, 0, 0); m.material = mt; }

  private buildScreens(nodes: Map<string, THREE.Mesh>) {
    const q = this.quality, big = q === 'ultra' ? 2048 : q === 'high' ? 1536 : 1024, mid = q === 'ultra' || q === 'high' ? 1024 : 768;
    const mk = (key: string, size: number, period: number, draw: Screen['draw'], aspect = 1) => { const s = new Screen(key, size, period, aspect, draw); this.screens.push(s); return s; };
    const C = () => this.ctx;
    const defs: Record<string, Screen> = {
      pfd: mk('pfd', big, 1 / 24, (g, W, H) => drawPFD(g, W, H, C())), nd: mk('nd', big, 1 / 16, (g, W, H) => drawND(g, W, H, C())),
      uecam: mk('uecam', mid * 1.0, 1 / 8, (g, W, H) => drawEWD(g, W, H, C())), lecam: mk('lecam', mid, 1 / 8, (g, W, H) => drawSD(g, W, H, C())),
      mcdu1: mk('mcdu1', mid, 1 / 8, (g, W, H) => this.mcdu[0].draw(g, W, H, C())), mcdu2: mk('mcdu2', mid, 1 / 8, (g, W, H) => this.mcdu[1].draw(g, W, H, C())),
      isis: mk('isis', 512, 1 / 10, (g, W, H) => drawISIS(g, W, H, C())), clock: mk('clock', 512, 1 / 2, (g, W, H) => drawClock(g, W, H, C())),
    };
    for (const [name, key] of Object.entries(SCREENS)) { const m = nodes.get(name); if (!m) continue; const s = defs[key]; m.material = s.mat; s.meshes.push(m); if (name === 'uecam.screen2') m.visible = false; }
  }

  private buildFcu(nodes: Map<string, THREE.Mesh>) {
    // strip aligned with the original seven-segment meshes (model coords; panel normal = (0.957, 0.289, 0))
    const zc = -0.0005, w = 0.25, h = 0.017; // plane wider than the 3 windows so no digit is clipped this.fcuZ = { c: zc, w };
    const cv = document.createElement('canvas'); cv.width = 2048; cv.height = Math.round(2048 * h / w); const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 16;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
    const n = new THREE.Vector3(0.957, 0.289, 0).normalize(), up = new THREE.Vector3(-0.289, 0.957, 0), xa = new THREE.Vector3(0, 0, -1);
    const m = new THREE.Matrix4().makeBasis(xa, up, n); mesh.quaternion.setFromRotationMatrix(m); mesh.position.set(-0.3795 + n.x * 0.0012, 0.505 + n.y * 0.0012, zc); mesh.renderOrder = 5;
    this.root.add(mesh); this.fcuCanvas = cv; this.fcuTex = tex; void nodes;
  }

  // ====================================================================== EFB tablet (captain's side window mount)
  efb = new Efb(); private efbMesh?: THREE.Mesh; private efbCanvas?: HTMLCanvasElement; private efbTex?: THREE.CanvasTexture; private efbNext = 0;
  /** Overlay the live EFB page on the real tablet face of the model (EFB_cpt: panel plane located from the mesh, see COCKPIT_PANELS.efb). */
  private buildEfb() {
    const cv = document.createElement('canvas'); cv.width = Efb.W; cv.height = Efb.H;
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 16;
    const P = COCKPIT_PANELS.efb, w = 0.24, h = w * (Efb.H / Efb.W);
    const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    const hx = new THREE.Vector3(-0.8, 0, -0.6), up = new THREE.Vector3(-0.118, 0.981, 0.157).normalize();
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(hx, up, P.n)); mesh.position.copy(P.c).addScaledVector(P.n, 0.0015).addScaledVector(hx, 0.0075); mesh.renderOrder = 4; mesh.name = 'efb_screen';
    this.root.add(mesh); this.efbMesh = mesh; this.efbCanvas = cv; this.efbTex = tex;
  }
  private pickEfb(ray: THREE.Raycaster): { u: number; v: number; dist: number } | null {
    if (!this.efbMesh) return null; const h = ray.intersectObject(this.efbMesh, false)[0]; if (!h || !h.uv) return null;
    return { u: h.uv.x, v: 1 - h.uv.y, dist: h.distance };
  }

  // ====================================================================== camera rig
  // Two layers: `views.cockpit` is the eased BASE view (seat / panel preset, set by focus()); `look` is the pilot's free-look + lean offset
  // on top of it (follows the mouse tightly). focus() always clears `look`, so panel views are framed exactly as designed.
  private look = { yaw: 0, pitch: 0, x: 0, y: 0 }; private lookCur = { yaw: 0, pitch: 0, x: 0, y: 0 };
  private out = { pos: new THREE.Vector3(), yaw: 0, pitch: 0, fov: 68 };
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
    this.fovT = fov; this.zoomT = 1; this.look.yaw = this.look.pitch = this.look.x = this.look.y = 0;
    if (instant) { this.cur.pos.copy(vw.pos); this.cur.yaw = vw.yaw; this.cur.pitch = vw.pitch; this.fovCur = fov; this.zoom = 1; Object.assign(this.lookCur, this.look); }
  }
  /** Outward normal of the panel a control sits on (model frame) – used to frame double-clicked controls squarely. */
  private panelNormal(c: THREE.Vector3): THREE.Vector3 {
    if (c.z > 0.7) return COCKPIT_PANELS.efb.n.clone();
    if (c.y > 0.8) return N(0.25, -1, 0);                                          // overhead: view from below, looking forward
    if (c.x < -0.3 && c.x > -0.43 && c.y > 0.38 && c.y < 0.6) return COCKPIT_PANELS.fcu.n.clone(); // glareshield / FCU / EFIS
    if (c.x < -0.44) return N(1, 0.15, 0);                                          // main instrument panel
    if (Math.abs(c.z) < 0.34 && c.y < 0.2) return N(0.25, 1, 0);                    // pedestal & thrust quadrant: view from above
    return N(0.35, 0.45, -Math.sign(c.z || 1) * Math.min(1, Math.abs(c.z) * 2));    // side consoles etc.: from the cockpit centre
  }
  /** Fly the camera to a control group (double-click). */
  focusGroup(g: Group) {
    const c = g.box.getCenter(new THREE.Vector3()), size = Math.max(...g.box.getSize(new THREE.Vector3()).toArray());
    const n = this.panelNormal(c), dist = Math.min(0.62, Math.max(0.26, size * 4.5));
    this.focus(c.clone().addScaledVector(n, dist), c, 38);
  }
  /** Free-look: drag deltas in pixels. Sensitivity follows the current field of view so the scene tracks the cursor at any zoom. */
  lookBy(dx: number, dy: number) {
    const k = (this.out.fov * Math.PI / 180) / 720 * 2.0, vw = this.views.cockpit, L = this.look;
    L.yaw -= dx * k; L.pitch -= dy * k;
    L.yaw = Math.max(-2.7 - vw.yaw, Math.min(2.7 - vw.yaw, L.yaw)); L.pitch = Math.max(-1.35 - vw.pitch, Math.min(1.35 - vw.pitch, L.pitch));
  }
  /** Lean / pan the head sideways and up-down (middle-drag or Shift-drag), a few tens of centimetres around the base position. */
  panBy(dx: number, dy: number) {
    const k = 0.0011 / this.zoom, L = this.look; L.x = Math.max(-0.3, Math.min(0.3, L.x + dx * k)); L.y = Math.max(-0.2, Math.min(0.2, L.y - dy * k));
  }
  resetLook() { this.look.yaw = this.look.pitch = this.look.x = this.look.y = 0; }
  /** Smoothly damped camera state (body frame) for the game's camera rig: eased panel transitions, tight free-look, smooth zoom. */
  smooth(dt: number) {
    dt = Math.min(Math.max(dt, 0), 0.05);
    const vw = this.views.cockpit, kb = 1 - Math.exp(-dt * 4.6), kl = 1 - Math.exp(-dt * 16), kz = 1 - Math.exp(-dt * 9), o = this.out, c = this.cur, l = this.lookCur, L = this.look;
    c.pos.lerp(vw.pos, kb); c.yaw += (vw.yaw - c.yaw) * kb; c.pitch += (vw.pitch - c.pitch) * kb; this.fovCur += (this.fovT - this.fovCur) * kb;
    l.yaw += (L.yaw - l.yaw) * kl; l.pitch += (L.pitch - l.pitch) * kl; l.x += (L.x - l.x) * kl; l.y += (L.y - l.y) * kl;
    this.zoom += (this.zoomT - this.zoom) * kz;
    const yaw = c.yaw + l.yaw; o.pos.copy(c.pos); o.pos.x += Math.cos(yaw) * l.x; o.pos.z -= Math.sin(yaw) * l.x; o.pos.y += l.y;
    o.yaw = yaw; o.pitch = c.pitch + l.pitch; o.fov = 2 * Math.atan(Math.tan(this.fovCur * Math.PI / 360) / this.zoom) * 180 / Math.PI;
    return o;
  }
  /** Wheel zoom (field of view 1x–8x, exponential so every notch feels the same). */
  zoomBy(deltaY: number) { this.zoomT = Math.min(8, Math.max(1, this.zoomT * Math.exp(-Math.max(-300, Math.min(300, deltaY)) * 0.0014))); }
  resetZoom() { this.zoomT = 1; }
  setQuality(q: QualityPreset) { this.quality = q; this.fallback?.setQuality(q); }

  // ====================================================================== interaction
  private pickGroup(ray: THREE.Raycaster): { g: Group; hit: THREE.Intersection } | null {
    if (!this.loaded) return null;
    const hits = ray.intersectObjects(this.interactive, false);
    for (const h of hits) { const g = this.byNode.get(h.object); if (g) return { g, hit: h }; }
    return null;
  }
  hover(ray: THREE.Raycaster): CockpitHover | null {
    if (this.fallback) { const p = this.fallback.pick(ray, true); return p ? { id: p.id, label: p.id.toUpperCase(), value: '', hint: 'Click', desc: 'Flight-deck control.' } : null; }
    const p = this.pickGroup(ray), e = this.pickEfb(ray);
    if (e && (!p || e.dist < p.hit.distance)) { const tip = this.efb.hover(e.u, e.v); return { id: 'efb', label: 'EFB TABLET (CAPT)', value: tip ?? `Page: ${this.efb.page}`, hint: tip ? 'Click' : 'Click to operate · wheel scrolls · double-click to zoom', desc: 'Electronic Flight Bag – flight plan, checklists, airport data, radio frequencies, weather and procedures.' }; }
    if (!p) return null;
    const info = describeControl(p.g.id);
    return { id: p.g.id, label: p.g.kind === 'key' ? p.g.label : info.name, value: this.stateText(p.g), hint: this.hint(p.g), desc: info.text };
  }
  private hint(g: Group) { return g.kind === 'knob' || g.id === 'spd-sel' || g.id === 'hdg_sel' || g.id === 'alt-sel' ? 'Wheel / drag to turn · click = push · right-click = pull' : g.kind === 'lever' ? 'Drag to move' : g.kind === 'stick' ? 'Drag to fly' : g.kind === 'key' ? 'Click to press' : 'Click to operate · double-click to zoom'; }
  stateText(g: Group): string {
    const s = this.sys, h = this.host, id = g.id;
    switch (id) {
      case 'BatteryBtn1': return s.bat[0] ? 'AUTO' : 'OFF'; case 'BatteryBtn2': return s.bat[1] ? 'AUTO' : 'OFF';
      case 'APUMasterBtn': return s.apuMaster ? 'ON' : 'OFF'; case 'APUStartBtn': return s.apuRpm >= 95 ? 'AVAIL' : s.apuStart ? `START ${Math.round(s.apuRpm)}%` : 'OFF';
      case 'Lcutoff': return h?.fm.eng[0].state === 2 ? 'ON · RUNNING' : s.master[0] ? 'ON' : 'OFF'; case 'Rcutoff': return h?.fm.eng[1].state === 2 ? 'ON · RUNNING' : s.master[1] ? 'ON' : 'OFF';
      case 'eng_mode': return ['CRANK', 'NORM', 'IGN/START'][s.engMode]; case 'FlapsLever': return `CONF ${['0', '1', '2', '3', 'FULL'][h?.fm.ctl.flapsIdx ?? 0]}`;
      case 'gear_lever': return h?.fm.ctl.gearDown ? 'DOWN' : 'UP'; case 'ParkBrk': return h?.fm.ctl.parking ? 'ON' : 'OFF'; case 'spd-sel': return `${Math.round(h?.ap.spd ?? 0)} kt`;
      case 'hdg_sel': return `${Math.round(h?.ap.hdg ?? 0)}°`; case 'alt-sel': return `${Math.round(h?.ap.altFt ?? 0)} ft`; case 'vs-sel': return s.vsMode ? `${s.vsTarget} fpm` : 'LEVEL CH';
      case 'ap1': return h?.ap.on ? 'ENGAGED' : 'OFF'; case 'appr': return h?.ap.appr ? 'ARMED' : 'OFF';
      case 'thr_l_body': return `${Math.round((h?.fm.ctl.throttle ?? 0) * 100)}%`; case 'thr_r_body': return `${Math.round(((h?.fm.ctl.throttle ?? 0) + (h?.fm.ctl.thrOffset ?? 0)) * 100)}%`;
      case 'SpdBrk': return s.spoilerArm ? 'ARMED' : `${Math.round((h?.fm.ctl.speedbrake ?? 0) * 100)}%`;
      case 'abs_low': return s.autobrake === 1 ? 'ON' : 'OFF'; case 'abs_med': return s.autobrake === 2 ? 'ON' : 'OFF'; case 'abs_max': return s.autobrake === 3 ? 'ON' : 'OFF';
      case 'qnh_cpt_knb': return s.std ? 'STD' : s.qnhInHg ? (s.qnh * 0.02953).toFixed(2) + ' inHg' : `${Math.round(s.qnh)} hPa`;
      case 'nd_range': return `${[10, 20, 40, 80, 160, 320][s.ndRange]} NM`; case 'nd_mode': return ['LS', 'VOR', 'NAV', 'ARC', 'PLAN'][s.ndMode];
      case 'BeaconLtSwtch': return h?.lights.beacon ? 'ON' : 'OFF'; case 'SeatBeltSwtch': return h?.seatbelt ? 'ON' : 'OFF';
    }
    if (g.kind === 'key') return '';
    if (g.kind === 'switch') return SWITCH3.has(g.id) ? (['OFF / LOW', 'AUTO / MID', 'ON / HIGH'][g.pos] ?? '') : g.pos ? 'ON' : 'OFF';
    if (g.kind === 'guard') return g.pos ? 'OPEN' : 'CLOSED';
    if (g.kind === 'knob') return `position ${g.pos + 1}`;
    return this.stateOn(g.id) ? 'ON / ENGAGED' : 'OFF / NORMAL';
  }

  /** Pointer down: returns null when no control was hit; `handled:false` ids ('yoke') are completed by the game. */
  press(ray: THREE.Raycaster, button: number, shift: boolean): PressResult | null {
    if (this.fallback) { const p = this.fallback.pick(ray); return p ? { id: p.id, handled: false } : null; }
    const p = this.pickGroup(ray), e = this.pickEfb(ray);
    if (e && (!p || e.dist < p.hit.distance)) { this.efb.click(e.u, e.v); return { id: 'efb', handled: true }; }
    if (!p || !this.host) return null; const g = p.g; const h = this.host;
    if (g.kind === 'stick') return { id: 'yoke', handled: false };
    if (g.id === 'gear_lever') { h.action('gear'); return { id: g.id, handled: true }; }
    if (g.id === 'ParkBrk') { h.action('park'); return { id: g.id, handled: true }; }
    if (g.id === 'rev_l' || g.id === 'rev_r') { h.action('rev'); return { id: g.id, handled: true }; }
    if (g.kind === 'lever') { this.active = { g, sy: 0, acc: 0, v0: this.leverValue(g), kind: 'lever' }; return { id: g.id, handled: true }; }
    if (g.kind === 'key') { this.mcduKey(g.id); g.press = 1; return { id: g.id, handled: true }; }
    const fcuKnob = g.id === 'spd-sel' || g.id === 'hdg_sel' || g.id === 'alt-sel' || g.id === 'vs-sel';
    if (g.kind === 'knob' || fcuKnob) {
      if (fcuKnob) { this.active = { g, sy: 0, acc: 0, v0: 0, kind: 'knob' }; g.press = 1; this.activateKnob(g, button === 2 || shift ? 'pull' : 'push'); return { id: g.id, handled: true }; }
      this.active = { g, sy: 0, acc: 0, v0: 0, kind: 'knob' }; this.stepKnob(g, button === 2 ? -1 : 1, shift); return { id: g.id, handled: true };
    }
    this.toggle(g, button === 2 || shift ? -1 : 1); g.press = 1; return { id: g.id, handled: true };
  }
  drag(dx: number, dy: number) {
    const a = this.active; if (!a || !this.host) return false; const c = this.host.fm.ctl;
    if (a.kind === 'knob') { a.acc += -dy / 14 + dx / 28; while (Math.abs(a.acc) >= 1) { const s = Math.sign(a.acc); a.acc -= s; this.stepKnob(a.g, s, false); } return true; }
    a.sy += dy;
    switch (a.g.id) {
      case 'thr_l_body': { const R = c.throttle + c.thrOffset, v = Math.min(1, Math.max(0, a.v0 - a.sy / 170)); c.throttle = v; c.thrOffset = Math.min(1, Math.max(0, R)) - v; break; }
      case 'thr_r_body': c.thrOffset = Math.min(1, Math.max(0, a.v0 - a.sy / 170)) - c.throttle; break;
      case 'FlapsLever': c.flapsIdx = Math.min(this.spec.flapDetents, Math.max(0, Math.round(a.v0 + a.sy / 30))); break;
      case 'SpdBrk': { const v = a.v0 + a.sy / 100; if (v < -0.2) { this.sys.spoilerArm = true; c.speedbrake = 0; } else { this.sys.spoilerArm = false; c.speedbrake = Math.min(1, Math.max(0, v)); } break; }
      case 'Lcutoff': case 'Rcutoff': if (Math.abs(a.sy) > 12) { const i = a.g.id === 'Lcutoff' ? 0 : 1; this.sys.master[i] = a.sy < 0; a.sy = 0; } break;
      case 'eng_mode': if (Math.abs(a.sy) > 14) { this.sys.engMode = Math.max(0, Math.min(2, this.sys.engMode + (a.sy < 0 ? 1 : -1))) as 0 | 1 | 2; a.sy = 0; } break;
    }
    return true;
  }
  release() {
    const a = this.active; this.active = null; if (!a || !this.host) return;
    const c = this.host.fm.ctl; if (Math.abs(c.thrOffset) < 0.03) c.thrOffset = 0;
    for (const g of this.groups.values()) g.press = 0;
  }
  wheel(ray: THREE.Raycaster, deltaY: number, shift: boolean): boolean {
    if (this.fallback) return false;
    const p = this.pickGroup(ray), e = this.pickEfb(ray);
    if (e && (!p || e.dist < p.hit.distance)) { this.efb.wheel(deltaY); return true; }
    if (!p) return false; const g = p.g;
    const isK = g.kind === 'knob' || /^(spd-sel|hdg_sel|alt-sel|vs-sel)$/.test(g.id) || g.id === 'eng_mode';
    if (g.kind === 'lever' && this.host) { const c = this.host.fm.ctl, d = deltaY > 0 ? -0.05 : 0.05; if (g.id === 'thr_l_body') { const R = c.throttle + c.thrOffset; c.throttle = Math.min(1, Math.max(0, c.throttle + d)); c.thrOffset = R - c.throttle; } else if (g.id === 'thr_r_body') c.thrOffset += d; else if (g.id === 'FlapsLever') c.flapsIdx = Math.min(4, Math.max(0, c.flapsIdx + (deltaY > 0 ? 1 : -1))); else return false; return true; }
    if (!isK) return false; this.stepKnob(g, deltaY > 0 ? -1 : 1, shift); return true;
  }
  focusAt(ray: THREE.Raycaster): boolean { if (this.fallback) return false; const p = this.pickGroup(ray), e = this.pickEfb(ray); if (e && (!p || e.dist < p.hit.distance)) { this.framePanel('efb'); return true; } if (!p) return false; this.focusGroup(p.g); return true; }
  private leverValue(g: Group) { const c = this.host!.fm.ctl; return g.id === 'thr_l_body' ? c.throttle : g.id === 'thr_r_body' ? c.throttle + c.thrOffset : g.id === 'FlapsLever' ? c.flapsIdx : g.id === 'SpdBrk' ? (this.sys.spoilerArm ? -0.3 : c.speedbrake) : 0; }

  private mcduKey(id: string) { const fo = id.startsWith('F:'), k = id.slice(2); const m = this.mcdu[fo ? 1 : 0]; m.key(k === 'mcdu' ? 'menu' : k); }

  private activateKnob(g: Group, how: 'push' | 'pull') {
    const h = this.host!, s = this.sys;
    switch (g.id) {
      case 'hdg_sel': if (how === 'push') { s.hdgManaged = true; h.action('apnav'); } else { s.hdgManaged = false; h.action('aphdg'); } break;
      case 'spd-sel': s.spdManaged = how === 'push'; break;
      case 'alt-sel': s.altStep1000 = how === 'pull' ? !s.altStep1000 : s.altStep1000; if (how === 'push') h.toast('ALT: level change / open', 'info'); break;
      case 'vs-sel': if (how === 'push') { s.vsMode = false; h.ap.altFt = h.ap.altFt; } else { s.vsMode = true; this.applyVs(); } break;
    }
  }
  private applyVs() { const h = this.host!; const ap = h.ap as unknown as { vsLimit?: number }; if (this.sys.vsMode) ap.vsLimit = Math.min(15, Math.max(1, Math.abs(this.sys.vsTarget) / 196.85)); else ap.vsLimit = 8; }
  private stepKnob(g: Group, dir: number, shift: boolean) {
    const h = this.host; if (!h) return; const s = this.sys; const id = g.id;
    switch (id) {
      case 'spd-sel': h.setApTarget('spd', h.ap.spd + dir * (shift ? 10 : 1)); return;
      case 'hdg_sel': h.setApTarget('hdg', (h.ap.hdg + dir * (shift ? 10 : 1) + 360) % 360); return;
      case 'alt-sel': h.setApTarget('alt', h.ap.altFt + dir * (shift || s.altStep1000 ? 1000 : 100)); return;
      case 'vs-sel': s.vsTarget = Math.max(-6000, Math.min(6000, s.vsTarget + dir * 100)); s.vsMode = true; this.applyVs(); return;
      case 'qnh_cpt_knb': case 'qnh_fo_knb': case 'iesi_baro_knb': s.std = false; s.qnh = Math.max(950, Math.min(1050, s.qnh + dir)); g.angle += dir * 0.2; return;
      case 'nd_range': case 'nd_range_fo': s.ndRange = Math.max(0, Math.min(5, s.ndRange + dir)); g.pos = s.ndRange; return;
      case 'nd_mode': case 'nd_mode_fo': s.ndMode = Math.max(0, Math.min(4, s.ndMode + dir)); g.pos = s.ndMode; return;
      case 'eng_mode': s.engMode = Math.max(0, Math.min(2, s.engMode + dir)) as 0 | 1 | 2; g.pos = s.engMode; return;
      case 'XbleedKnb': g.pos = Math.max(0, Math.min(2, (g.pos || 1) + dir)); s.xbleed = g.pos === 0 ? 0 : 1; return;
      case 'pfd_brt_cpt': case 'pfd_brt_fo': s.bright.pfd = Math.max(0.2, Math.min(1, s.bright.pfd + dir * 0.1)); g.angle += dir * 0.3; return;
      case 'brightness_nd_cpt': case 'brightness_nd_fo': s.bright.nd = Math.max(0.2, Math.min(1, s.bright.nd + dir * 0.1)); g.angle += dir * 0.3; return;
      case 'ecam_brt_upper': s.bright.uecam = Math.max(0.2, Math.min(1, s.bright.uecam + dir * 0.1)); g.angle += dir * 0.3; return;
      case 'ecam_brt_lower': s.bright.lecam = Math.max(0.2, Math.min(1, s.bright.lecam + dir * 0.1)); g.angle += dir * 0.3; return;
    }
    const n = g.steps; const cont = n >= 12;
    g.pos = cont ? g.pos + dir : Math.max(0, Math.min(n - 1, g.pos + dir)); s.sw[id] = g.pos;
  }

  /** Toggle / cycle a push-button, switch or guard and apply its system effect. */
  private toggle(g: Group, dir: number) {
    const h = this.host!, s = this.sys, id = g.id, fm = h.fm;
    const flip = () => { g.pos = g.pos ? 0 : 1; s.sw[id] = g.pos; return !!g.pos; };
    const cycle = (n: number) => { g.pos = (g.pos + (dir > 0 ? 1 : n - 1)) % n; s.sw[id] = g.pos; return g.pos; };
    switch (id) {
      case 'BatteryBtn1': s.bat[0] = !s.bat[0]; if (!fm.ctl.battery && (s.bat[0])) { h.lights.nav = true; } return;
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
      case 'StrobeLtSwtch': { const p = cycle(3); h.lights.strobe = p === 1 || p === 2; return; }
      case 'NavLogoLtSwtch': { const p = cycle(3); h.lights.nav = p >= 1; return; }
      case 'LandingLtSwtch': case 'LandingLtRSwtch': case 'land_sw': { const p = cycle(3); h.lights.land = p === 1; return; }
      case 'SeatBeltSwtch': { cycle(2); if (g.pos === 1 !== h.seatbelt) h.action('belt'); return; }
      case 'Lcutoff': s.master[0] = !s.master[0]; return; case 'Rcutoff': s.master[1] = !s.master[1]; return;
      case 'eng_mode': s.engMode = ((s.engMode + (dir > 0 ? 1 : 2)) % 3) as 0 | 1 | 2; return;
      case 'ap1': case 'ap2': h.action('ap'); return;
      case 'a-thr': s.athrArmed = !s.athrArmed; return; case 'appr': h.action('appr'); return; case 'loc': s.sw.loc = s.sw.loc ? 0 : 1; if (s.sw.loc) h.action('apnav'); return;
      case 'exped': s.exped = !s.exped; if (s.exped) { s.vsMode = false; } return; case 'fd1': s.fd[0] = !s.fd[0]; return; case 'fd2': s.fd[1] = !s.fd[1]; return;
      case 'hdg-vs': case 'trk-fpa': s.trkFpa = !s.trkFpa; return; case 'spd-mach': s.spdMach = !s.spdMach; return; case 'metric_alt': s.metric = !s.metric; return;
      case 'arpt': case 'arpt.001': s.ndOverlay.arpt = !s.ndOverlay.arpt; return; case 'cstr': case 'cstr.001': s.ndOverlay.cstr = !s.ndOverlay.cstr; return; case 'wpt': case 'wpt.001': s.ndOverlay.wpt = !s.ndOverlay.wpt; return;
      case 'vord': case 'vord.001': s.ndOverlay.vord = !s.ndOverlay.vord; return; case 'ndb': case 'ndb.001': s.ndOverlay.ndb = !s.ndOverlay.ndb; return; case 'ils': case 'ils2': s.ndOverlay.ls = !s.ndOverlay.ls; return;
      case 'qnh_cpt_sw': case 'qnh_fo_sw': case 'iesi_btn_rst': s.std = !s.std; return;
      case 'master_warning': s.masterWarn = false; h.action('ackWarn'); return; case 'master_caution': s.masterCaut = false; h.action('ackWarn'); return;
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
    if (g.kind === 'switch') { cycle(SWITCH3.has(id) ? 3 : 2); return; }
    if (g.kind === 'guard') { flip(); return; }
    flip();
  }

  // ====================================================================== per-frame
  private setRot(g: Group, theta: number) {
    const ax = g.axis; const m = new THREE.Matrix4();
    if (ax) { const p = new THREE.Vector3(...ax.pivot), a = new THREE.Vector3(...ax.direction).normalize(); m.makeTranslation(p.x, p.y, p.z).multiply(new THREE.Matrix4().makeRotationAxis(a, theta)).multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z)); }
    for (const p of g.parts) p.node.matrix.multiplyMatrices(m, p.m0);
  }
  private rotAbout(g: Group, pivot: [number, number, number], axis: [number, number, number], theta: number) {
    const p = new THREE.Vector3(...pivot), a = new THREE.Vector3(...axis).normalize();
    const m = new THREE.Matrix4().makeTranslation(p.x, p.y, p.z).multiply(new THREE.Matrix4().makeRotationAxis(a, theta)).multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
    for (const q of g.parts) q.node.matrix.multiplyMatrices(m, q.m0);
  }
  private animate(g: Group, inp: CockpitInputs, d: PanelData) {
    const s = this.sys;
    switch (g.id) {
      case 'thr_l_body': return this.rotAbout(g, [0, -0.09, 0.022], [0, 0, 1], inp.throttle * 0.8);
      case 'thr_r_body': return this.rotAbout(g, [0, -0.09, -0.022], [0, 0, 1], Math.min(1, Math.max(0, inp.throttle + (this.host?.fm.ctl.thrOffset ?? 0))) * 0.8);
      case 'FlapsLever': return this.rotAbout(g, [0.087, -0.188, -0.1], [0, 0, 1], -inp.flapsIdx * 0.17);
      case 'SpdBrk': return this.rotAbout(g, [0.087, -0.206, 0.074], [0, 0, 1], s.spoilerArm ? 0.25 : -inp.speedbrake * 0.6);
      case 'gear_lever': return this.setRot(g, inp.gearDown ? 0 : 0.9);
      case 'ParkBrk': return this.setRot(g, this.host?.fm.ctl.parking ? 0.6 : 0);
      case 'stick': { for (const p of g.parts) { const side = p.node.name.includes('_2') ? -1 : 1; const m = new THREE.Matrix4(); const piv = new THREE.Vector3(-0.196, -0.092, 0.873 * side); const roll = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), -inp.roll * 0.35 * side), pit = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(0, 0, 1), -inp.pitch * 0.3); m.makeTranslation(piv.x, piv.y, piv.z).multiply(roll).multiply(pit).multiply(new THREE.Matrix4().makeTranslation(-piv.x, -piv.y, -piv.z)); p.node.matrix.multiplyMatrices(m, p.m0); } return; }
      case 'tiller': case 'tillerFo': return this.setRot(g, inp.yaw * 0.9);
      case 'brakes_lb_psi': case 'brakes_rb_psi': return this.setRot(g, Math.min(1, s.hyd.yellow / 3000) * 2.0 * (this.host?.fm.ctl.parking ? 0.3 : 1) + 0);
      case 'brakes_accum_psi': return this.setRot(g, s.accumPsi / 3000 * 2.0);
    }
    if (/Rudder(Pedal)/.test(g.id)) return;
    const t = g.kind === 'knob' || g.id === 'spd-sel' || g.id === 'hdg_sel' || g.id === 'alt-sel' || g.id === 'vs-sel';
    if (t) { const n = g.steps; const a = n >= 12 ? g.angle + g.pos * 0.26 : ((g.pos - (n - 1) / 2) * (n <= 3 ? 0.7 : 0.5)); g.press += 0; return this.setRot(g, a + (g.id === 'hdg_sel' ? (d.apHdg * Math.PI / 180) : g.id === 'alt-sel' ? d.apAlt / 100 * 0.26 : g.id === 'spd-sel' ? d.apSpd * 0.26 : 0)); }
    if (g.kind === 'switch') { const n = SWITCH3.has(g.id) ? 3 : 2; return this.setRot(g, (g.pos - (n - 1) / 2) * (n === 2 ? 0.8 : 0.42)); }
    if (g.kind === 'guard') return this.setRot(g, g.pos ? 1.7 : 0);
    // push buttons / keys: 1.5 mm depress while pressed (toward the panel, along the knob axis or the panel normal)
    const dep = (g.press ? 0.0018 : 0) + (g.kind === 'push' && !ON_WHEN_IN.has(g.id) && g.pos === 0 ? 0.0009 : 0);
    const nrm = g.nrm ??= this.panelNormal(g.box.getCenter(new THREE.Vector3()));
    const m = new THREE.Matrix4().makeTranslation(-nrm.x * dep, -nrm.y * dep, -nrm.z * dep); for (const p of g.parts) p.node.matrix.multiplyMatrices(m, p.m0);
  }

  private legendLit(g: Group, letter: string, row: number): [boolean, number] {
    const s = this.sys, id = g.id, h = this.host!, fm = h.fm; void row;
    const wired = this.stateOn(id); const onType = ON_WHEN_IN.has(id);
    const eng = [fm.eng[0].state === 2, fm.eng[1].state === 2];
    switch (letter) {
      case 'F': { const f = id === 'Gen1Btn' ? !s.gen[0] === false && eng[0] && !s.ac : id === 'Gen2Btn' ? false : id === 'GreenEngPump2' ? s.hydPump.green && eng[0] && s.hyd.green < 1500 : id === 'YellowEngPump' ? s.hydPump.yellow && eng[1] && s.hyd.yellow < 1500 : /FuelTank/.test(id) ? wired && s.tank.l + s.tank.r + s.tank.c < 20 : /Pack/.test(id) ? wired && eng[0] && eng[1] && s.bleedPsi[0] < 5 : false; return [f || s.lampTest > 0, 0xffb000]; }
      case 'A': return [id === 'APUStartBtn' ? s.apuRpm >= 95 : id === 'ExtPwrBtn' ? s.ext === false && fm.wow && fm.gs < 1 : false, 0x40ff60];
      case 'O': { const lit = onType ? wired : !wired; return [lit && s.dc || s.lampTest > 0, onType ? (id === 'APUStartBtn' || id === 'ExtPwrBtn' ? 0x40a8ff : 0x40a8ff) : 0xf0f6ff]; }
      case 'S': return [false || s.lampTest > 0, 0xffb000]; case 'D': return [s.lampTest > 0, 0xffb000]; case 'M': return [!wired && s.dc, 0xf0f6ff];
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
      case 'Eng1ManStartBtn': return s.master[0] && s.engMode === 2; case 'Eng2ManStartBtn': return s.master[1] && s.engMode === 2;
    }
    return !!g && g.pos === 1 ? true : false;
  }
  private ledOn(base: string): boolean {
    const s = this.sys, h = this.host!, d = this.ctx.d; if (!s.dc) return false; if (s.lampTest > 0) return true;
    switch (base) {
      case 'ap1': return h.ap.on; case 'ap2': return false; case 'a-thr': return h.ap.on || s.athrArmed; case 'appr': return h.ap.appr; case 'loc': return !!s.sw.loc; case 'exped': return s.exped; case 'fd1': return s.fd[0]; case 'fd2': return s.fd[1];
      case 'arpt': case 'arpt.001': return s.ndOverlay.arpt; case 'cstr': case 'cstr.001': return s.ndOverlay.cstr; case 'wpt': case 'wpt.001': return s.ndOverlay.wpt; case 'vord': case 'vord.001': return s.ndOverlay.vord; case 'ndb': case 'ndb.001': return s.ndOverlay.ndb; case 'ils': case 'ils2': return s.ndOverlay.ls;
      case 'master_warning': return s.masterWarn || d.warn.some((w) => /STALL|FIRE|PULL|OVERSPEED/i.test(w)); case 'master_caution': return s.masterCaut; case 'autoland_light': return h.ap.on && h.ap.appr && !!d.ils?.valid;
      case 'abs_low': return s.autobrake === 1; case 'abs_med': return s.autobrake === 2; case 'abs_max': return s.autobrake === 3; case 'dec_low': case 'dec_med': case 'dec_max': return false;
      case 'ecam_eng': return (s.page ?? s.pageAuto) === 'ENG'; case 'ecam_bleed': return (s.page ?? s.pageAuto) === 'BLEED'; case 'ecam_press': return (s.page ?? s.pageAuto) === 'PRESS'; case 'ecam_elec': return (s.page ?? s.pageAuto) === 'ELEC'; case 'ecam_hyd': return (s.page ?? s.pageAuto) === 'HYD';
      case 'ecam_fuel': return (s.page ?? s.pageAuto) === 'FUEL'; case 'ecam_apu': return (s.page ?? s.pageAuto) === 'APU'; case 'ecam_cond': return (s.page ?? s.pageAuto) === 'COND'; case 'ecam_door': return (s.page ?? s.pageAuto) === 'DOOR'; case 'ecam_wheel': return (s.page ?? s.pageAuto) === 'WHEEL';
      case 'ecam_fctl': return (s.page ?? s.pageAuto) === 'F/CTL'; case 'ecam_sts': return (s.page ?? s.pageAuto) === 'STS';
      case 'brk_fan': case 'brk_hot': return false;
    }
    if (/^radio_(on|vhf1|nav)(\.|$)/.test(base)) return true;
    const g = this.groups.get(base); return !!g && g.pos === 1 && g.kind === 'push' && !!s.sw[base];
  }

  /** Called every frame while the interior is visible. */
  update(dt: number, time: number, data: PanelData, inp: CockpitInputs, ui: CockpitUi, visible: boolean) {
    if (this.fallback) { this.fallback.update(dt, time, data, inp, ui, visible); return; }
    if (!visible || !this.loaded || !this.host) return;
    this.lastInp = inp; const h = this.host, s = this.sys;
    s.update(dt, h, data);
    this.ctx.d = data; this.ctx.host = h; this.ctx.t = time; this.ctx.utc = new Date(simNowMs());
    for (const m of this.mcdu) m.attach(h);
    // lighting (day/night)
    const dl = this.daylight; this.hemi.intensity = 0.55 + 1.5 * dl + (1 - dl) * 0.9 * s.bright.flood; /* panel / flood lights at night */ this.sun.intensity = 1.6 * dl;
    // screens
    this.camera.updateMatrixWorld(); this.pv.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse); this.frustum.setFromProjectionMatrix(this.pv);
    const br: Record<string, number> = { pfd: s.bright.pfd, nd: s.bright.nd, uecam: s.bright.uecam, lecam: s.bright.lecam };
    for (const sc of this.screens) {
      sc.mat.color.setScalar((br[sc.key] ?? 1) * (s.dc ? 1 : 0.0));
      if (time < sc.next) continue; const visibleNow = sc.meshes.some((m) => this.frustum.intersectsObject(m)); if (!visibleNow) continue;
      sc.next = time + sc.period; sc.render();
    }
    if (this.efbMesh && this.efbCanvas && this.efbTex) {
      (this.efbMesh.material as THREE.MeshBasicMaterial).color.setScalar((0.3 + 0.7 * this.daylight) * (s.dc ? 1 : 0.08));
      if ((time >= this.efbNext || this.efb.dirty) && this.frustum.intersectsObject(this.efbMesh)) { this.efbNext = time + 0.5; this.efb.draw(this.efbCanvas.getContext('2d')!, h.efbInfo?.() ?? null, this.daylight); this.efbTex.needsUpdate = true; }
    }
    if (this.fcuCanvas && this.fcuTex) {
      const key = [data.apSpd, data.apHdg, data.apAlt, s.ac, s.vsMode, s.vsTarget, s.metric, s.spdMach, s.spdManaged, s.hdgManaged].join('|');
      if (key !== this.fcuKey) { this.fcuKey = key; const cv = this.fcuCanvas, g = cv.getContext('2d')!; drawFCU(g, cv.width, cv.height, this.ctx, (z) => (this.fcuZ.c + this.fcuZ.w / 2 - z) / this.fcuZ.w); this.fcuTex.needsUpdate = true; }
    }
    // animation
    for (const g of this.groups.values()) { this.animate(g, inp, data); for (const p of g.parts) p.node.matrixWorldNeedsUpdate = true; if (g.press > 0 && !this.active) g.press = Math.max(0, g.press - dt * 6); }
    // lamps
    for (const l of this.lampNodes) {
      if (l.kind === 'led') { l.node.visible = this.ledOn(l.base); continue; }
      const g = this.groups.get(l.base); if (!g) continue; const [on, col] = this.legendLit(g, l.letter, l.row); const mt = l.node.material as THREE.MeshStandardMaterial;
      mt.emissive.setHex(on ? col : 0x000000); mt.emissiveIntensity = on ? 1.6 : 0;
    }
    // thrust-lever offset snaps back to a common setting when the two levers are close
    const c = h.fm.ctl; if (!this.active && Math.abs(c.thrOffset) < 0.03) c.thrOffset = 0;
    void ui;
  }

  /** Legacy helpers kept for the game's HUD hooks. */
  pick(ray: THREE.Raycaster, allowDisplay = false): { id: string; instance?: number; point: THREE.Vector3 } | null {
    if (this.fallback) return this.fallback.pick(ray, allowDisplay);
    const p = this.pickGroup(ray); return p ? { id: p.g.id, point: p.hit.point } : null;
  }
  get inputs() { return this.lastInp; }
  dispose() { this.fallback?.dispose(); this.scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); }); for (const s of this.screens) { s.tex.dispose(); s.mat.dispose(); } }
  /** First-person seat positions in body space (captain / first officer). */
  eyeBody(fo = false) { const e = fo ? FO_EYE_M : EYE_M; const [ex, ey, ez] = this.spec.eye; const tx = ex + EYE_M.z, ty = ey - EYE_M.y, tz = ez - EYE_M.x; return new THREE.Vector3(-e.z + tx, e.y + ty, e.x + tz); }
}
