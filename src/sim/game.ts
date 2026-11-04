import * as THREE from 'three';
import { Airport, airportsNear } from '../data/airports';
import { AircraftSpec, specById } from './specs';
import { FlightModel, G } from './physics';
import { Projection, haversine, bearing, wrap180, wrap360, D2R, R2D, clamp, M_PER_NM, MS_TO_KT, destination, greatCircle, FlightWaypoint } from './geo';
import { World, Threshold, TimeOfDay, Weather } from './world';
import { buildAircraftModel, AircraftVisual } from './aircraftModel';
import { Cockpit } from './cockpit';
import { PanelData } from './instruments';
import { Autopilot, IlsData } from './autopilot';
import { AudioEngine, WarnSound } from './audio';
import { Effects } from './effects';
import { Settings, addScore, QualityPreset } from './storage';
import { QUALITY } from './quality';

export type Phase = 'idle' | 'loading' | 'playing' | 'paused' | 'crashed' | 'complete';
export type ViewId = 'cockpit' | 'chase' | 'spotter' | 'aisle' | 'window';
const VIEWS: ViewId[] = ['cockpit', 'chase', 'spotter', 'aisle', 'window'];
export interface ScenarioConfig { aircraftId: string; from: Airport; to: Airport; settings: Settings; }
export type FlightPhase = 'taxi' | 'takeoff' | 'climb' | 'cruise' | 'descent' | 'final' | 'rollout';
export interface AtcMessage { id: number; sender: string; text: string; time: number; needsAck?: boolean; }
export interface Toast { id: number; text: string; level: 'info' | 'good' | 'warn' | 'bad'; }
export interface Breakdown { label: string; pts: number; }
export interface LandingInfo { vsFpm: number; kias: number; offset: number; dist: number; bank: number; pitch: number; onRunway: boolean; airportId: string; rwy: string; }
export interface Result { outcome: 'landed' | 'diverted' | 'crashed'; score: number; grade: string; items: Breakdown[]; landing: LandingInfo | null; rank: number; reason: string; distanceKm: number; flightTime: number; comfort: number; newBest: boolean; }
export interface CockpitTooltip {
  id: string;
  label: string;
  value: string;
  actionHint: string;
  x: number;
  y: number;
}

export interface WorldScreenMarker {
  id: string;
  label: string;
  distNm: number;
  altFt: number;
  type: 'waypoint' | 'airport' | 'runway';
  x: number;
  y: number;
  inView: boolean;
  angleDeg: number;
}

export interface ChecklistItem {
  id: string;
  label: string;
  detail: string;
  done: boolean;
  phase: FlightPhase;
}

export interface HudState {
  phase: Phase; view: ViewId; kias: number; altFt: number; vsFpm: number; hdg: number; gsKt: number; mach: number; pitch: number; bank: number; throttle: number; n1: number; flapsIdx: number; flapsDet: number; gear: number; gearDown: boolean; brake: boolean; parking: boolean; reverse: boolean; spoilers: number;
  fuelPct: number; fuelKg: number; aglFt: number; distNm: number; brg: number; eteMin: number; warn: { text: string; level: 'caution' | 'warning'; acked?: boolean }[]; score: number; comfort: number; ap: { on: boolean; nav: boolean; appr: boolean; hdg: number; alt: number; spd: number };
  ils: { valid: boolean; locDots: number; gsDots: number; ident: string; dist: number } | null; timeScale: number; lights: { nav: boolean; strobe: boolean; land: boolean; beacon: boolean }; seatbelt: boolean; assist: boolean; hint: string; loadProgress: number; restartHold: number;
  wind: { dir: number; kt: number }; destId: string; fromId: string; aircraft: string; progress: number; onGround: boolean; stall: boolean; nz: number; depRwy: string; apprRwy: string; rwyHdg: number; rwyDistNm: number; vr: number; vapp: number; alphaFrac: number; offline: boolean; paxCount: number; cabinMsg: string; canWarp: boolean;
  flightPlan: FlightWaypoint[]; activeWpIdx: number; apPhase: string;
  // UI/UX Enhanced fields
  flightPhase: FlightPhase;
  track: number;
  fpaDeg: number;
  speedTrendKt: number;
  vs0: number; vs1: number; v1: number; v2: number; vne: number;
  fuelTimeMin: number;
  relWindDir: number; crosswindKt: number; headwindKt: number;
  qnhInHg: number; oatC: number;
  runwayRemM: number;
  pitchTarget: number | null;
  trim: number;
  atc: AtcMessage | null;
  atcLog: AtcMessage[];
  activeWp: { name: string; distNm: number; brg: number; etaMin: number } | null;
  // MSFS UI/UX additions
  cockpitTooltip: CockpitTooltip | null;
  freelookActive: boolean;
  worldMarkers: WorldScreenMarker[];
  show3dGates: boolean;
  showTaxiRibbon: boolean;
  activeChecklist: {
    items: ChecklistItem[];
    currentPhase: FlightPhase;
    completedCount: number;
    totalCount: number;
  };
  fov: number;
}
export interface MapState { lat: number; lon: number; hdg: number; track: number; from: Airport; to: Airport; trail: [number, number][]; altFt: number; depRwy: string; apprRwy: string; appr: { lat: number; lon: number; hdg: number; ident: string } | null; navPath: [number, number][]; flightPlan: FlightWaypoint[]; activeWpIdx: number; }
interface Hooks { onHud(h: HudState): void; onToast(t: Toast): void; onPhase(p: Phase): void; onResult(r: Result): void; onCommand(cmd: string): void; }

const gLimits = { piston: { p: 5.2, n: -2.4 }, turboprop: { p: 4.4, n: -1.8 }, jet: { p: 3.6, n: -1.4 } };
const TAU = Math.PI * 2;
const FINAL_GATE_M = 18000; // join final 18 km (9.7 nm) before the threshold
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler();

export function buildFlightPlan(
  from: Airport,
  depTh: Threshold | null,
  to: Airport,
  arrTh: Threshold | null,
  cruiseAltM: number,
  cruiseSpeedKt: number,
  vappKt: number
): FlightWaypoint[] {
  const wps: FlightWaypoint[] = [];

  // 1. Departure Runway Threshold & Climb Leg
  if (depTh) {
    wps.push({
      id: 'DEP',
      name: `RWY ${depTh.ident}`,
      type: 'takeoff',
      lat: depTh.lat,
      lon: depTh.lon,
      altM: from.elev,
      speedKt: 0,
      rwyIdent: depTh.ident,
      hdg: depTh.hdg,
    });

    const [climbLat, climbLon] = destination(depTh.lat, depTh.lon, depTh.hdg, 5500);
    wps.push({
      id: 'CLIMB',
      name: `CLIMB ${depTh.ident}`,
      type: 'climb',
      lat: climbLat,
      lon: climbLon,
      altM: from.elev + 550,
      speedKt: Math.round(cruiseSpeedKt * 0.72),
      hdg: depTh.hdg,
    });
  } else {
    wps.push({
      id: 'DEP',
      name: from.icao,
      type: 'takeoff',
      lat: from.lat,
      lon: from.lon,
      altM: from.elev,
      speedKt: 0,
    });
  }

  // 2. Arrival Runway & Approach Waypoints (IAF, FAF, Touchdown)
  let iafLat = to.lat, iafLon = to.lon;
  let fafLat = to.lat, fafLon = to.lon;
  let arrLat = to.lat, arrLon = to.lon;
  let arrHdg = 0;

  if (arrTh) {
    arrLat = arrTh.lat;
    arrLon = arrTh.lon;
    arrHdg = arrTh.hdg;
    [fafLat, fafLon] = destination(arrTh.lat, arrTh.lon, arrTh.hdg + 180, 8500);
    [iafLat, iafLon] = destination(arrTh.lat, arrTh.lon, arrTh.hdg + 180, 18500);
  } else {
    const oppBrg = wrap360(bearing(from.lat, from.lon, to.lat, to.lon) + 180);
    [fafLat, fafLon] = destination(to.lat, to.lon, oppBrg, 8500);
    [iafLat, iafLon] = destination(to.lat, to.lon, oppBrg, 18500);
  }

  // 3. Cruise Leg & Top of Descent (TOD)
  const lastDep = wps[wps.length - 1];
  const enrouteDist = haversine(lastDep.lat, lastDep.lon, iafLat, iafLon);
  const descentDistM = Math.max(12000, (cruiseAltM - (to.elev + 900)) / Math.tan(3 * D2R));

  if (enrouteDist > descentDistM + 12000) {
    const gcPoints = greatCircle(lastDep.lat, lastDep.lon, iafLat, iafLon, 8);
    const midPoint = gcPoints[Math.floor(gcPoints.length / 2)];
    wps.push({
      id: 'CRZ',
      name: 'CRUISE',
      type: 'cruise',
      lat: midPoint[0],
      lon: midPoint[1],
      altM: cruiseAltM,
      speedKt: cruiseSpeedKt,
    });

    const todRatio = 1 - (descentDistM / enrouteDist);
    const todIdx = Math.min(gcPoints.length - 1, Math.max(0, Math.round(todRatio * (gcPoints.length - 1))));
    const todPt = gcPoints[todIdx];
    wps.push({
      id: 'TOD',
      name: 'TOP OF DESCENT',
      type: 'tod',
      lat: todPt[0],
      lon: todPt[1],
      altM: cruiseAltM,
      speedKt: Math.round(cruiseSpeedKt * 0.88),
    });
  }

  // 4. IAF (Initial Approach Fix)
  wps.push({
    id: 'IAF',
    name: `IAF ${arrTh?.ident ?? ''}`,
    type: 'iaf',
    lat: iafLat,
    lon: iafLon,
    altM: to.elev + 900,
    speedKt: 160,
    rwyIdent: arrTh?.ident,
    hdg: arrHdg,
  });

  // 5. FAF (Final Approach Fix)
  wps.push({
    id: 'FAF',
    name: `FAF ${arrTh?.ident ?? ''}`,
    type: 'faf',
    lat: fafLat,
    lon: fafLon,
    altM: to.elev + 450,
    speedKt: 140,
    rwyIdent: arrTh?.ident,
    hdg: arrHdg,
  });

  // 6. Touchdown Threshold
  wps.push({
    id: 'ARR',
    name: `RWY ${arrTh?.ident ?? to.icao}`,
    type: 'touchdown',
    lat: arrLat,
    lon: arrLon,
    altM: to.elev + 15,
    speedKt: vappKt,
    rwyIdent: arrTh?.ident,
    hdg: arrHdg,
  });

  // 7. Rollout / Stop Point
  if (arrTh) {
    const [rollLat, rollLon] = destination(arrTh.lat, arrTh.lon, arrTh.hdg, Math.min(1800, arrTh.len * 0.75));
    wps.push({
      id: 'ROLLOUT',
      name: 'STOP',
      type: 'rollout',
      lat: rollLat,
      lon: rollLon,
      altM: to.elev,
      speedKt: 0,
      rwyIdent: arrTh.ident,
      hdg: arrHdg,
    });
  }

  return wps;
}

export class Game {
  renderer: THREE.WebGLRenderer; camera = new THREE.PerspectiveCamera(65, 1, 2, 220000);
  audio = new AudioEngine();
  world: World | null = null; fm!: FlightModel; spec!: AircraftSpec; visual: AircraftVisual | null = null; cockpit: Cockpit | null = null; effects: Effects | null = null;
  ap = new Autopilot();
  phase: Phase = 'idle'; mode: 'attract' | 'play' = 'attract'; suspended = false;
  cfg!: ScenarioConfig; hooks: Hooks;
  viewIdx = 0; lookYaw = 0; lookPitch = 0; orbitYaw = 0; orbitPitch = 0.1; zoom = 1; chaseQ = new THREE.Quaternion(); chaseInit = false;
  private raf = 0; private last = 0; private acc = 0; time = 0; private hudT = 0; private slowT = 0; timeScale = 1; private toastId = 1;
  private emaFrameMs = 16.6; private dprScale = 1.0; private dprCooldown = 0;
  // input
  keys = new Set<string>(); private axes = { pitch: 0, roll: 0, yaw: 0 }; touch = { pitch: 0, roll: 0, yaw: 0, brake: false }; yokeDrag: { pitch: number; roll: number } | null = null; private pad = { pitch: 0, roll: 0, yaw: 0 };
  private brakeAxis = 0; private restartHold = 0; private apOverride = 0;
  private drag: { id: string; sx: number; sy: number; v: number; look?: boolean } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  // game state
  private score = 0; private items: Breakdown[] = []; private comfort = 100; private bestRem = 0; private flightTime = 0; private flownKm = 0; private lastLL: [number, number] = [0, 0];
  trail: [number, number][] = []; private trailT = 0;
  private lights = { nav: true, strobe: false, land: false, beacon: true }; seatbelt = true;
  private windFrom = 270; private windKt = 0; private turb = 0; private gustPhase = Math.random() * 100; private gust = new THREE.Vector3();
  private warnState: { text: string; level: 'caution' | 'warning'; sound: WarnSound }[] = []; private warnPenalty: Record<string, number> = {};
  private landing: LandingInfo | null = null; private takeoffDone = false; private stoppedT = 0; private endT = 0; private result: Result | null = null; private crashTimer = 0;
  private paEvents = { welcome: false, landing: false }; private cabinMsg = ''; private cabinMsgT = 0; private nextChat = 20; private shakeImpulse = 0;
  apprKey = ''; private apprLocked = false; depTh!: Threshold | null; depRwy = ''; flightPlan: FlightWaypoint[] = []; activeWpIdx = 0; private loadStart = 0; private usedAp = false; private ticks = 0;
  private prevAgl = 0; private fuelWarned = false; private wasStalled = false; private overspeedT = 0; private todShown = false;
  private raycaster = new THREE.Raycaster();
  currentFlightPhase: FlightPhase = 'taxi';
  private speedTrendSmoothed = 0;
  private prevKias = 0;
  private atcMessages: AtcMessage[] = [];
  private nextAtcId = 1;
  private ackedWarnings = new Set<string>();

  constructor(public canvas: HTMLCanvasElement, hooks: Hooks) {
    this.hooks = hooks;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: false });
    this.renderer.autoClear = false; this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.resize();
    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this.onKeyDown); window.addEventListener('keyup', this.onKeyUp); window.addEventListener('blur', this.onBlur);
    canvas.addEventListener('pointerdown', this.onPointerDown); window.addEventListener('pointermove', this.onPointerMove); window.addEventListener('pointerup', this.onPointerUp); window.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: true }); canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.phase === 'playing') this.pause(); });
    this.last = performance.now(); this.raf = requestAnimationFrame(this.loop);
    (window as any).sim = this;
  }
  get isMobile() { return matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700; }
  get quality(): QualityPreset { const q = this.cfg?.settings.quality ?? 'auto'; return q === 'auto' ? (this.isMobile ? 'low' : 'high') : q; }
  get qualityProfile() { return QUALITY[this.quality]; }
  private basePixelRatio() {
    const p = this.qualityProfile;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    // A 4K panel at DPR 2 would otherwise render 33 MP every frame. The pixel budget caps the
    // back buffer independently of the preset so even Ultra stays inside a 60 FPS fill rate.
    const budgetRatio = Math.sqrt(p.maxPixels / Math.max(1, w * h));
    return Math.min(dpr, p.pixelRatioCap, budgetRatio);
  }
  resize = () => {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    const pr = Math.max(0.5, this.basePixelRatio() * this.dprScale);
    this.renderer.setPixelRatio(pr); this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    if (this.cockpit) { this.cockpit.camera.aspect = w / h; this.cockpit.camera.updateProjectionMatrix(); }
  };
  private fovFor(base: number) { return this.camera.aspect < 1 ? base + 22 : base; }

  // =====================================================================================
  //  Scenario management
  // =====================================================================================
  async load(cfg: ScenarioConfig, mode: 'attract' | 'play', startMode: 'runway' | 'cruise' | 'final' = 'runway') {
    this.disposeScenario();
    this.cfg = cfg; this.mode = mode; this.spec = specById(cfg.aircraftId);
    this.dprScale = 1; this.emaFrameMs = 16.6; this.dprCooldown = 1.0;
    const s = cfg.settings, from = cfg.from;
    this.phase = 'loading'; this.hooks.onPhase('loading'); this.loadStart = performance.now();
    const proj = new Projection(from.lat, from.lon);
    const anisoMap: Record<QualityPreset, number> = {
      ultra: this.renderer.capabilities.getMaxAnisotropy(),
      high: Math.min(8, this.renderer.capabilities.getMaxAnisotropy()),
      medium: 4,
      low: 1,
    };
    this.world = new World(proj, {
      quality: this.quality,
      style: s.terrainStyle,
      tod: s.tod as TimeOfDay,
      weather: s.weather as Weather,
      maxAniso: anisoMap[this.quality] ?? 4,
    });
    this.world.terrain.fallbackH = from.elev;
    this.effects = new Effects(this.world.scene);
    this.visual = buildAircraftModel(this.spec); this.world.scene.add(this.visual.root);
    this.cockpit = new Cockpit(this.spec, this.quality); this.cockpit.camera.aspect = this.camera.aspect; this.cockpit.camera.updateProjectionMatrix();
    this.audio.voiceOn = s.voice; this.audio.setVolume(s.volume); this.audio.setMuted(s.muted);
    // wind (deterministic per airport so replays are comparable)
    const seed = Math.abs(Math.sin(from.lat * 12.9898 + from.lon * 78.233)) * 360;
    this.windFrom = Math.round(seed / 10) * 10; this.windKt = s.wind === 'calm' ? 0 : Math.round(s.wind === 'light' ? 6 + (seed % 5) : 14 + (seed % 7));
    this.turb = s.wind === 'calm' ? 0.02 : s.wind === 'light' ? 0.16 : 0.5; if (s.weather === 'overcast') this.turb += 0.1;
    this.world.rebuildAirports(from.lat, from.lon);
    this.resetFlight(startMode);
    this.camera.fov = 65; this.setView(mode === 'attract' ? 'chase' : s.startMode === 'runway' ? 'cockpit' : 'cockpit');
    this.world.update(this.camera, this.fm.pos, 1, 0);
    this.resize();
  }

  /** Re-spawn the aircraft (instant restart – terrain stays loaded). */
  resetFlight(startMode: 'runway' | 'cruise' | 'final') {
    const w = this.world!, cfg = this.cfg, spec = this.spec, from = cfg.from, to = cfg.to;
    if (Math.abs(w.proj.lat0 - from.lat) > 1e-6 || Math.abs(w.proj.lon0 - from.lon) > 1e-6) this.rebaseTo(from.lat, from.lon);
    const dist = haversine(from.lat, from.lon, to.lat, to.lon);
    const cruiseT = (dist / (spec.cruiseKt * 0.514)) / 3600;
    const need = Math.min(spec.fuelCap, (spec.fuelFlow * spec.engines * 0.62 * 3600) * cruiseT * 1.25 + spec.fuelFlow * spec.engines * 0.35 * 3600 * 0.5 + 20);
    this.fm = new FlightModel(spec, (x, z) => this.world!.terrain.heightAt(x, z), Math.max(need, spec.fuelCap * 0.25));
    this.fm.ctl.assist = cfg.settings.assist;
    this.ap = new Autopilot(); this.ap.vsLimit = spec.kind === 'jet' ? 12 : spec.kind === 'turboprop' ? 7 : 4.5;
    const dep = this.pickDepRunway(from);
    this.depTh = dep;
    this.depRwy = dep ? dep.ident : '';
    this.world!.rebuildAirports(from.lat, from.lon);
    const arr = this.bestApproach(to, from);
    if (!this.apprLocked) this.apprKey = arr ? arr.ident : '';
    this.rebuildFlightPlan();
    const brg = bearing(from.lat, from.lon, to.lat, to.lon);
    if (startMode === 'runway' && dep) {
      const h = dep.hdg * D2R;
      this.fm.placeOnRunway(dep.x + Math.sin(h) * 18, dep.z - Math.cos(h) * 18, dep.hdg, from.elev);
      this.fm.ctl.flapsIdx = spec.kind === 'piston' ? 1 : 0; this.fm.flapsPos = this.fm.ctl.flapsIdx / spec.flapDetents;
    } else if (startMode === 'cruise') {
      const alt = Math.max(spec.cruiseAlt * (dist < 120000 ? 0.55 : 1), from.elev + 1500, to.elev + 1500, 1500);
      const d0 = Math.min(dist * 0.12, 18000) + 3000;
      const [la, lo] = destination(from.lat, from.lon, brg, d0);
      this.fm.placeAirborne(w.proj.x(lo), alt, w.proj.z(la), brg, spec.cruiseKt * 0.9, 0, false);
      this.fm.ctl.throttle = 0.6; this.ap.engage(this.fm); this.ap.nav = true; this.fm.ctl.apHold = true; this.usedAp = true;
    } else {
      const th = this.bestApproach(to, from) ;
      const d0 = 14000, h = th.hdg * D2R;
      const x = th.x - Math.sin(h) * d0, z = th.z + Math.cos(h) * d0, alt = to.elev + 15 + Math.tan(3 * D2R) * d0 + 60;
      this.fm.placeAirborne(x, alt, z, th.hdg, spec.vapp * 1.35, 0, false);
      this.fm.ctl.throttle = 0.4; this.ap.hdg = Math.round(th.hdg); this.ap.altFt = Math.round(alt / 0.3048 / 100) * 100; this.ap.spd = Math.round(spec.vapp * 1.3);
      this.apprKey = th.ident; this.apprLocked = true;
    }
    this.fm.wind.copy(this.windVec(0));
    this.score = 0; this.items = []; this.comfort = 100; this.landing = null; this.takeoffDone = startMode !== 'runway'; this.stoppedT = 0; this.result = null; this.endT = 0; this.crashTimer = 0;
    this.visual?.setVisible(true); this.effects?.clear(); this.paEvents = { welcome: false, landing: false }; this.flightTime = 0; this.flownKm = 0; this.trail = []; this.fuelWarned = false; this.warnPenalty = {}; this.timeScale = 1; this.todShown = false;
    this.seatbelt = true; this.lights = { nav: true, strobe: startMode !== 'runway', land: false, beacon: true };
    if (startMode !== 'final') { this.apprKey = ''; this.apprLocked = false; }
    this.currentFlightPhase = startMode === 'runway' ? 'taxi' : startMode === 'final' ? 'final' : 'cruise';
    this.speedTrendSmoothed = 0;
    this.prevKias = this.fm ? this.fm.ias / 0.514444 : 0;
    this.atcMessages = [];
    const rwyInit = this.depRwy || '09';
    if (startMode === 'runway') {
      this.addAtc('GROUND', `Aero 101, ${from.icao} Ground. Cleared to taxi runway ${rwyInit} via Alpha. QNH 29.92.`, true);
    } else if (startMode === 'final') {
      this.addAtc('TOWER', `Aero 101, ${to.icao} Tower. Established final approach runway ${this.apprKey || '27'}, cleared to land.`, true);
    } else {
      this.addAtc('ENROUTE', `Aero 101, radar contact at ${Math.round(spec.cruiseAlt / 0.3048)} ft, cleared enroute ${to.icao}.`, false);
    }
    this.lastLL = [this.lat(), this.lon()]; this.bestRem = dist; this.chaseInit = false; this.shakeImpulse = 0; this.lookYaw = this.lookPitch = 0; this.zoom = 1;
    this.effects?.update(0);
    this.audio.silence();
  }

  rebuildFlightPlan() {
    if (!this.world || !this.cfg) return;
    const from = this.cfg.from, to = this.cfg.to;
    const arr = this.approachTh();
    const cruiseAltM = Math.max(this.spec.cruiseAlt * (haversine(from.lat, from.lon, to.lat, to.lon) < 120000 ? 0.55 : 1), from.elev + 1500, to.elev + 1500, 1500);
    this.flightPlan = buildFlightPlan(from, this.depTh, to, arr, cruiseAltM, this.spec.cruiseKt, this.spec.vapp);
    if (this.cfg.settings.startMode === 'runway' && !this.takeoffDone) {
      this.activeWpIdx = 0;
    } else if (this.cfg.settings.startMode === 'final') {
      const fafIdx = this.flightPlan.findIndex((w) => w.type === 'faf');
      this.activeWpIdx = fafIdx >= 0 ? fafIdx : Math.max(0, this.flightPlan.length - 2);
    } else {
      this.activeWpIdx = Math.min(1, this.flightPlan.length - 1);
    }
  }

  setDepRunway(ident: string) {
    if (!this.world) return;
    const ths = this.world.thresholds(this.cfg.from);
    const th = ths.find((t) => t.ident === ident);
    if (!th) return;
    this.depTh = th;
    this.depRwy = th.ident;
    if (this.cfg.settings.startMode === 'runway' && !this.takeoffDone && this.fm) {
      const h = th.hdg * D2R;
      this.fm.placeOnRunway(th.x + Math.sin(h) * 18, th.z - Math.cos(h) * 18, th.hdg, this.cfg.from.elev);
      this.ap.takeoffHdg = th.hdg;
      this.toast(`Departure runway ${th.ident} selected`, 'info');
    }
    this.rebuildFlightPlan();
  }

  setArrRunway(ident: string) {
    if (!this.world) return;
    const ths = this.world.thresholds(this.cfg.to);
    const th = ths.find((t) => t.ident === ident);
    if (!th) return;
    this.apprKey = th.ident;
    this.apprLocked = true;
    this.toast(`Approach runway ${th.ident} selected`, 'info');
    this.rebuildFlightPlan();
  }
  /** Departure runway: longest, with the best headwind. */
  private pickDepRunway(ap: Airport): Threshold | null {
    const ths = this.world!.thresholds(ap); if (!ths.length) return null;
    const maxLen = Math.max(...ths.map((t) => t.len));
    // Favour the active runway (headwind + length), but also prefer the end that
    // leaves toward the destination so the departure heading is not 180° off route.
    const routeBrg = bearing(ap.lat, ap.lon, this.cfg.to.lat, this.cfg.to.lon);
    let best = ths[0], bs = -1e9;
    for (const t of ths) {
      const head = Math.cos((this.windFrom - t.hdg) * D2R) * this.windKt;
      const align = Math.cos((routeBrg - t.hdg) * D2R);
      const sc = head * 0.6 + align * 9 + (t.len >= maxLen * 0.7 ? 20 : 0) + t.len / 1000;
      if (sc > bs) { bs = sc; best = t; }
    }
    return best;
  }
  private bestApproach(to: Airport, from: Airport): Threshold {
    const ths = this.world!.thresholds(to), p = this.world!.proj;
    const fx = p.x(from.lon), fz = p.z(from.lat);
    const maxLen = Math.max(...ths.map((t) => t.len));
    let best = ths[0], bs = -1e9;
    for (const t of ths) {
      const h = t.hdg * D2R, ax = t.x - Math.sin(h) * 12000, az = t.z + Math.cos(h) * 12000;
      const away = Math.hypot(ax - fx, az - fz);
      const head = Math.cos((this.windFrom - t.hdg) * D2R) * this.windKt;
      const sc = head * 0.4 + (t.len >= maxLen * 0.7 ? 10 : 0) - away / 8000;
      if (sc > bs) { bs = sc; best = t; }
    }
    return best;
  }
  private disposeScenario() {
    this.world?.dispose(); this.effects?.dispose(); this.cockpit?.dispose(); this.world = null; this.effects = null; this.cockpit = null; this.visual = null;
  }
  dispose() {
    cancelAnimationFrame(this.raf); this.disposeScenario(); this.audio.silence();
    window.removeEventListener('resize', this.resize); window.removeEventListener('keydown', this.onKeyDown); window.removeEventListener('keyup', this.onKeyUp); window.removeEventListener('blur', this.onBlur);
    this.renderer.dispose();
    if ((window as any).sim === this) delete (window as any).sim;
  }

  // ---- helpers ----
  lat() { return this.world!.proj.lat(this.fm.pos.z); }
  lon() { return this.world!.proj.lon(this.fm.pos.x); }
  private windVec(alt: number) {
    const k = 1 + clamp(alt / 2500, 0, 1.6), toward = (this.windFrom + 180) * D2R, v = this.windKt * 0.514444 * k;
    return new THREE.Vector3(Math.sin(toward) * v, 0, -Math.cos(toward) * v);
  }
  private rebaseTo(lat: number, lon: number) {
    const w = this.world!, oldP = w.proj, np = new Projection(lat, lon);
    const dx = this.fm ? np.x(oldP.lon(this.fm.pos.x)) - this.fm.pos.x : 0, dz = this.fm ? np.z(oldP.lat(this.fm.pos.z)) - this.fm.pos.z : 0;
    if (this.fm) { const la = oldP.lat(this.fm.pos.z), lo = oldP.lon(this.fm.pos.x); this.fm.pos.x = np.x(lo); this.fm.pos.z = np.z(la); }
    w.rebase(np, lat, lon); this.effects?.shift(dx, dz); this.chaseInit = false;
    if (this.depTh) this.depTh = null;
  }
  setView(v: ViewId) {
    this.viewIdx = VIEWS.indexOf(v); this.lookYaw = 0; this.lookPitch = 0; this.orbitYaw = 0; this.orbitPitch = 0.12;
    this.visual?.setInterior(this.isInterior());
  }
  cycleView() { this.setView(VIEWS[(this.viewIdx + 1) % VIEWS.length]); this.audio.click(); this.toast(`Camera: ${this.viewName()}`, 'info'); }
  viewName() { return { cockpit: 'Cockpit', chase: 'Chase', spotter: 'Spotter', aisle: 'Cabin – aisle', window: 'Cabin – window seat' }[VIEWS[this.viewIdx]]; }
  isInterior() { const v = VIEWS[this.viewIdx]; return v === 'cockpit' || v === 'aisle' || v === 'window'; }
  toast(text: string, level: Toast['level'] = 'info') { this.hooks.onToast({ id: this.toastId++, text, level }); }
  private addScore(label: string, pts: number, silent = false) { this.score += pts; if (!silent) this.items.push({ label, pts }); }
  private penalize(key: string, label: string, pts: number, cooldown = 6) {
    const t = this.time; if (t - (this.warnPenalty[key] ?? -99) < cooldown) return;
    this.warnPenalty[key] = t; this.score -= pts; this.items.push({ label, pts: -pts });
  }

  // =====================================================================================
  //  Flow control
  // =====================================================================================
  begin() { // after loading screen
    this.audio.start(); this.setPhase('playing'); this.last = performance.now();
    if (this.mode === 'play') {
      this.toast(`${this.cfg.from.icao} → ${this.cfg.to.icao}  ·  ${this.spec.name}`, 'info');
    }
  }
  setPhase(p: Phase) { if (this.phase === p) return; this.phase = p; this.hooks.onPhase(p); }
  pause() { if (this.phase !== 'playing') return; this.setPhase('paused'); this.audio.silence(); }
  resume() { if (this.phase !== 'paused') return; this.setPhase('playing'); this.last = performance.now(); }
  restart() {
    if (!this.world) return;
    const sm = this.cfg.settings.startMode;
    this.resetFlight(sm); this.setView(this.cfg.settings.startMode === 'final' ? 'cockpit' : 'cockpit');
    this.effects?.update(0.1); this.setPhase('playing'); this.last = performance.now(); this.audio.start();
    this.toast('Flight restarted', 'info');
  }
  applySettings(s: Settings) {
    if (!this.cfg) return;
    const prevQuality = this.quality;
    this.cfg.settings = s;
    const qualityChanged = this.quality !== prevQuality;
    this.audio.voiceOn = s.voice; this.audio.setVolume(s.volume); this.audio.setMuted(s.muted);
    if (this.fm && !this.ap.on) this.fm.ctl.assist = s.assist;
    this.world?.setStyle(s.terrainStyle);
    this.world?.setQuality(this.quality);
    this.cockpit?.setQuality(this.quality);
    if (qualityChanged) {
      // Start the new tier at full (already budget-limited) resolution, then let the
      // adaptive scaler settle it instead of inheriting a previous Low scale.
      this.dprScale = 1;
      this.dprCooldown = 1.2;
      this.emaFrameMs = 16.6;
    }
    this.resize();
  }
  setMuted(m: boolean) { this.audio.setMuted(m); this.cfg.settings.muted = m; }

  // =====================================================================================
  //  Input
  // =====================================================================================
  private onBlur = () => { this.keys.clear(); };
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'PageUp', 'PageDown', 'Tab'].includes(k)) e.preventDefault();
    if (e.repeat) return;
    this.keys.add(k);
    if (e.ctrlKey && k !== 'Control') e.preventDefault();
    if (this.mode === 'play' && (this.phase === 'paused' || this.phase === 'crashed' || this.phase === 'complete')) { if (k === 'r') this.restart(); else if ((k === 'p' || k === 'Escape') && this.phase === 'paused') this.resume(); return; }
    if (this.phase !== 'playing' || this.mode !== 'play') return;
    const c = this.fm.ctl;
    switch (k) {
      case 'p': case 'Escape': this.pause(); break;
      case 'g': this.action('gear'); break;
      case 'f': this.action('flaps+'); break; case 'v': this.action('flaps-'); break;
      case 'b': this.action('park'); break;
      case 't': this.action('rev'); break;
      case 'z': this.action('sb'); break;
      case 'l': this.action('land'); break; case 'o': this.action('strb'); break;
      case 'j': this.action('belt'); break; case 'k': this.action('pa'); break;
      case 'y': this.action('ap'); break; case 'n': this.action('apnav'); break; case 'u': this.action('appr'); break;
      case ',': this.action('hdg-'); break; case '.': this.action('hdg+'); break;
      case '[': this.action(e.shiftKey ? 'alt-big' : 'alt-'); break; case ']': this.action(e.shiftKey ? 'alt+big' : 'alt+'); break;
      case '-': this.action('spd-'); break; case '=': case '+': this.action('spd+'); break;
      case 'c': this.cycleView(); break; case 'm': this.hooks.onCommand('map'); break;
      case 'h': this.hooks.onCommand('cycleHudMode'); break;
      case 'a': this.action('ackWarn'); break;
      case 'x': c.throttle = 0; break; case 'Home': this.lookYaw = this.lookPitch = 0; break;
      case '\\': this.cycleWarp(); break; case 'Tab': this.cycleRunway(); break;
      case 'r': this.restartHold = 0.0001; break;
      default:
        if (['1', '2', '3', '4'].includes(k)) {
          const hasPendingAtc = this.atcMessages.some((m) => m.needsAck) ||
            (this.atcMessages.length > 0 && this.time - this.atcMessages[this.atcMessages.length - 1].time < 15);
          if (hasPendingAtc) {
            this.respondAtc(Number(k));
            break;
          }
        }
        if (/^[0-9]$/.test(k)) { c.throttle = k === '0' ? 1 : Number(k) / 10; this.ap.on && this.syncAp(); }
    }
  };
  private onKeyUp = (e: KeyboardEvent) => { const k = e.key.length === 1 ? e.key.toLowerCase() : e.key; this.keys.delete(k); if (k === 'r') this.restartHold = 0; };
  private syncAp() { /* manual throttle while AP: autothrottle will track again */ }

  /** Central action dispatcher (keys, cockpit buttons, HUD / touch buttons). */
  action(id: string) {
    if (!this.fm || this.mode !== 'play' || this.phase !== 'playing') return;
    const c = this.fm.ctl, s = this.spec, a = this.audio;
    switch (id) {
      case 'gear': c.gearDown = !c.gearDown; a.gearClunk(); this.toast(c.gearDown ? 'Gear DOWN' : 'Gear UP', 'info'); if (!c.gearDown && this.fm.wow) { c.gearDown = true; this.toast('Gear cannot retract on the ground', 'warn'); } break;
      case 'flaps+': if (c.flapsIdx < s.flapDetents) { c.flapsIdx++; a.click(); this.toast(`Flaps ${c.flapsIdx}`, 'info'); } break;
      case 'flaps-': if (c.flapsIdx > 0) { c.flapsIdx--; a.click(); this.toast(`Flaps ${c.flapsIdx}`, 'info'); } break;
      case 'park': c.parking = !c.parking; a.click(); this.toast(c.parking ? 'Parking brake ON' : 'Parking brake released', 'info'); break;
      case 'rev': if (s.hasReverse) { c.reverse = !c.reverse; a.click(); this.toast(c.reverse ? 'Reverse thrust armed' : 'Reverse thrust off', 'info'); } break;
      case 'sb': if (s.hasSpeedbrake) { c.speedbrake = c.speedbrake > 0.5 ? 0 : 1; a.click(); this.toast(c.speedbrake > 0.5 ? 'Spoilers deployed' : 'Spoilers retracted', 'info'); } break;
      case 'land': this.lights.land = !this.lights.land; a.click(); break;
      case 'nav': this.lights.nav = !this.lights.nav; a.click(); break;
      case 'bcn': this.lights.beacon = !this.lights.beacon; a.click(); break;
      case 'strb': this.lights.strobe = !this.lights.strobe; this.lights.beacon = this.lights.strobe || this.lights.beacon; a.click(); break;
      case 'belt': this.seatbelt = !this.seatbelt; a.chime(); this.toast(this.seatbelt ? 'Seat belt sign ON' : 'Seat belt sign OFF', 'info'); break;
      case 'pa': this.announce(); break;
      case 'ap': this.toggleAp(); break;
      case 'apnav':
        if (!this.ap.on) this.toggleAp(); // engaging already selects NAV
        else { this.ap.nav = !this.ap.nav; if (this.ap.nav) this.ap.appr = false; a.click(); this.toast(this.ap.nav ? 'NAV: tracking route to destination' : 'HDG mode', 'info'); }
        break;
      case 'appr': this.toggleAppr(); break;
      case 'hdg-': this.ap.hdg = wrap360(this.ap.hdg - 5); this.ap.nav = false; a.click(); break;
      case 'hdg+': this.ap.hdg = wrap360(this.ap.hdg + 5); this.ap.nav = false; a.click(); break;
      case 'alt-': this.ap.altFt = Math.max(0, this.ap.altFt - 100); a.click(); break;
      case 'alt+': this.ap.altFt = Math.min(45000, this.ap.altFt + 100); a.click(); break;
      case 'alt-big': this.ap.altFt = Math.max(0, this.ap.altFt - 1000); a.click(); break;
      case 'alt+big': this.ap.altFt = Math.min(45000, this.ap.altFt + 1000); a.click(); break;
      case 'spd-': this.ap.spd = Math.max(Math.round(s.vs1 * 1.2), this.ap.spd - 5); a.click(); break;
      case 'spd+': this.ap.spd = Math.min(Math.round(s.vne * 0.85), this.ap.spd + 5); a.click(); break;
      case 'warp': this.cycleWarp(); break;
      case 'rwy': this.cycleRunway(); break;
      case 'atc1': this.respondAtc(1); break;
      case 'atc2': this.respondAtc(2); break;
      case 'atc3': this.respondAtc(3); break;
      case 'atc4': this.respondAtc(4); break;
      case 'ackWarn': {
        if (this.warnState.length > 0) {
          const top = this.warnState[0];
          this.ackedWarnings.add(top.text);
          this.toast(`Acknowledged: ${top.text}`, 'info');
        }
        break;
      }
      case 'hudMode': this.hooks.onCommand('cycleHudMode'); break;
      case 'pause': this.pause(); break;
    }
  }
  private toggleAp() {
    if (this.ap.on) {
      this.ap.disengage();
      this.fm.ctl.apHold = false;
      this.fm.ctl.assist = this.cfg.settings.assist;
      this.audio.apOff();
      this.toast('Autopilot OFF', 'warn');
      this.timeScale = 1;
    } else if (this.fm.wow) {
      const rwyHdg = this.depTh ? this.depTh.hdg : this.fm.heading;
      this.ap.armTakeoff(this.fm, rwyHdg, this.spec.vr, Math.max(1500, this.spec.cruiseAlt * 0.35));
      this.fm.ctl.assist = true;
      this.fm.ctl.apHold = true;
      this.usedAp = true;
      this.audio.apOn();
      this.toast(`Autopilot ENGAGED – AUTO-TAKEOFF RWY ${this.depRwy || Math.round(rwyHdg) + '°'}`, 'good');
    } else {
      this.ap.engage(this.fm);
      this.fm.ctl.assist = true;
      this.fm.ctl.apHold = true;
      this.usedAp = true;
      this.ap.nav = this.cfg.from.id !== this.cfg.to.id;
      this.audio.apOn();
      this.toast(this.ap.nav ? `Autopilot ENGAGED – LNAV tracking ${this.cfg.to.icao}` : 'Autopilot ENGAGED – holding heading, altitude and speed', 'good');
    }
  }
  private toggleAppr() {
    if (!this.ap.on) { if (this.fm.wow) return; this.toggleAp(); }
    const ils = this.computeIls();
    if (!this.ap.appr && !(ils && ils.valid)) { this.toast('No ILS signal – fly within 30 nm of the destination runway', 'warn'); return; }
    this.ap.appr = !this.ap.appr; this.ap.nav = false; this.ap.gsCaptured = false; this.audio.click();
    this.toast(this.ap.appr ? `APPR armed – ILS ${ils?.ident}` : 'Approach mode off', this.ap.appr ? 'good' : 'info');
  }
  cycleWarp() {
    const ok = this.ap.on && !this.fm.wow && this.fm.agl > 400 && this.distToDest() > 35000;
    if (!ok) { this.timeScale = 1; this.toast('Time warp needs autopilot, 400 m+ AGL, and 20 nm+ from destination', 'warn'); return; }
    this.timeScale = this.timeScale >= 8 ? 1 : this.timeScale * 2; this.toast(`Time warp ×${this.timeScale}`, 'info');
  }
  cycleRunway() {
    if (this.cfg.from === this.cfg.to) return;
    const ths = this.world!.thresholds(this.cfg.to); const i = ths.findIndex((t) => t.ident === this.apprKey);
    this.apprKey = ths[(i + 1) % ths.length].ident; this.apprLocked = true; this.ap.gsCaptured = false;
    this.toast(`Approach runway ${this.apprKey} selected`, 'info');
  }
  private announce() {
    const fm = this.fm, a = this.audio, city = this.cfg.to.city || this.cfg.to.name;
    a.pa();
    if (!this.takeoffDone && !this.paEvents.welcome) {
      this.paEvents.welcome = true; this.seatbelt = true;
      a.speak(`Ladies and gentlemen, welcome aboard. Our flight to ${city}. Please fasten your seat belts for take off.`, 'pa', 1, 1, 1);
      this.toast('Cabin: welcome announcement made  +50', 'good'); this.addScore('Welcome announcement', 50);
      this.comfort = Math.min(100, this.comfort + 2);
    } else if (this.takeoffDone && !this.paEvents.landing && this.distToDest() < 60000 && fm.agl > 300) {
      this.paEvents.landing = true; this.seatbelt = true;
      a.speak('Cabin crew, prepare for landing. Passengers, please return to your seats and fasten your seat belts.', 'pa', 1, 1, 1);
      this.toast('Cabin: landing preparation announced  +100', 'good'); this.addScore('Landing announcement', 100);
      this.comfort = Math.min(100, this.comfort + 3);
    } else {
      a.speak(this.fm.nz > 1.3 || this.turb > 0.3 ? 'Ladies and gentlemen, we are experiencing some turbulence. Please remain seated.' : 'Ladies and gentlemen, this is your captain. We are cruising smoothly. Please enjoy the flight.', 'pa', 4, 1, 1);
      this.toast('Cabin: announcement made', 'info');
    }
  }

  // ---- pointer ----
  private ndc(e: PointerEvent) { const r = this.canvas.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); }
  private onPointerDown = (e: PointerEvent) => {
    this.audio.start();
    if (this.phase !== 'playing') return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.canvas.setPointerCapture?.(e.pointerId);
    if (this.mode === 'play' && this.isInterior() && this.cockpit) {
      this.cockpit.camera.updateMatrixWorld(); this.raycaster.setFromCamera(this.ndc(e), this.cockpit.camera);
      const hit = this.cockpit.pick(this.raycaster);
      if (hit) {
        const c = this.fm.ctl;
        switch (hit.id) {
          case 'throttle': this.drag = { id: 'throttle', sx: e.clientX, sy: e.clientY, v: c.throttle }; return;
          case 'flaps': this.drag = { id: 'flaps', sx: e.clientX, sy: e.clientY, v: c.flapsIdx }; return;
          case 'speedbrake': this.drag = { id: 'speedbrake', sx: e.clientX, sy: e.clientY, v: c.speedbrake }; return;
          case 'yoke': this.drag = { id: 'yoke', sx: e.clientX, sy: e.clientY, v: 0 }; this.yokeDrag = { pitch: 0, roll: 0 }; return;
          case 'pax': this.chatWithPassenger(); return;
          default: this.action(hit.id); return;
        }
      }
    }
    this.drag = { id: 'look', sx: e.clientX, sy: e.clientY, v: 0, look: true };
  };
  private onPointerMove = (e: PointerEvent) => {
    const d = this.drag; if (!d) return;
    const c = this.fm?.ctl; const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    switch (d.id) {
      case 'throttle': c.throttle = clamp(d.v - dy / 170, 0, 1); break;
      case 'flaps': c.flapsIdx = clamp(Math.round(d.v + dy / 34), 0, this.spec.flapDetents); break;
      case 'speedbrake': c.speedbrake = clamp(d.v - dy / 110, 0, 1); break;
      case 'yoke': this.yokeDrag = { pitch: clamp(dy / 80, -1, 1), roll: clamp(dx / 80, -1, 1) }; break;
      case 'look': {
        const p = this.pointers.get(e.pointerId); const mx = p ? e.clientX - p.x : 0, my = p ? e.clientY - p.y : 0;
        if (p) { p.x = e.clientX; p.y = e.clientY; }
        if (this.isInterior()) { this.lookYaw = clamp(this.lookYaw - mx * 0.0045, -2.6, 2.6); this.lookPitch = clamp(this.lookPitch - my * 0.0045, -1.2, 1.2); }
        else { this.orbitYaw -= mx * 0.006; this.orbitPitch = clamp(this.orbitPitch + my * 0.005, -0.3, 1.3); }
      }
    }
  };
  private onPointerUp = (e: PointerEvent) => { this.pointers.delete(e.pointerId); this.drag = null; this.yokeDrag = null; };
  private onWheel = (e: WheelEvent) => { this.zoom = clamp(this.zoom * (1 + e.deltaY * 0.0012), 0.4, 3); };
  private chatWithPassenger() {
    const m = this.comfort / 100;
    const good = ['“Smooth flight, Captain – thank you!”', '“The view is incredible up here!”', '“Best landing I ever felt… so far!”', '“Can I visit the cockpit later?”'];
    const bad = ['“Could you please be a bit gentler?”', '“I think I left my stomach back at the airport…”', '“Is this normal?!”', '“We would like to land. Now.”'];
    const msg = (m > 0.55 ? good : bad)[(Math.random() * 4) | 0]; this.setCabinMsg(msg); this.audio.chirp(); this.toast(`Passenger: ${msg}`, m > 0.55 ? 'good' : 'warn');
    if (m > 0.55) this.comfort = Math.min(100, this.comfort + 0.5);
  }
  private setCabinMsg(m: string) { this.cabinMsg = m; this.cabinMsgT = 6; }

  // =====================================================================================
  //  Navigation helpers
  // =====================================================================================
  distToDest() { return haversine(this.lat(), this.lon(), this.cfg.to.lat, this.cfg.to.lon); }
  /**
   * Two-leg approach path: current position → gate on the extended centreline → threshold.
   * This is what makes NAV (and the magenta line on the map) turn onto final instead
   * of driving diagonally into the runway end from any direction.
   */
  private navWaypoints(th: Threshold): [number, number][] {
    const w = this.world!;
    const thr: [number, number] = [w.proj.lat(th.z), w.proj.lon(th.x)];
    const cur: [number, number] = [this.lat(), this.lon()];
    const h = th.hdg * D2R, fx = Math.sin(h), fz = -Math.cos(h);
    // Distance still to run before the threshold along the landing direction.
    const along = -((this.fm.pos.x - th.x) * fx + (this.fm.pos.z - th.z) * fz);
    if (along > 0) {
      // Join final progressively: far out the intercept is capped at 18 km;
      // closer in it is halfway to the threshold. NAV therefore keeps turning
      // onto the centreline even when the aircraft is already inside 18 km,
      // instead of pointing straight at the runway end again.
      const intercept = clamp(along * 0.5, 1200, FINAL_GATE_M);
      if (along > intercept + 500) {
        const point = destination(thr[0], thr[1], th.hdg + 180, intercept);
        if (haversine(cur[0], cur[1], point[0], point[1]) > 700) return [point, thr];
      }
    }
    return [thr];
  }
  /** NAV aims at active flight plan waypoint, or approach gate, then runway threshold. */
  private navBearing() {
    if (this.flightPlan.length > 0 && this.activeWpIdx < this.flightPlan.length) {
      const targetWp = this.flightPlan[this.activeWpIdx];
      return bearing(this.lat(), this.lon(), targetWp.lat, targetWp.lon);
    }
    const th = this.approachTh();
    if (!th) return bearing(this.lat(), this.lon(), this.cfg.to.lat, this.cfg.to.lon);
    const wps = this.navWaypoints(th);
    let target = wps[0];
    if (wps.length > 1 && haversine(this.lat(), this.lon(), target[0], target[1]) < 700) target = wps[1];
    return bearing(this.lat(), this.lon(), target[0], target[1]);
  }
  private approachTh(): Threshold | null {
    const w = this.world!, ths = w.thresholds(this.cfg.to); if (!ths.length) return null;
    if (this.apprKey) { const t = ths.find((x) => x.ident === this.apprKey); if (t) return t; }
    return this.bestApproach(this.cfg.to, this.cfg.from);
  }
  computeIls(): (IlsData & { valid: boolean }) | null {
    const th = this.approachTh(); if (!th) return null; const fm = this.fm;
    const h = th.hdg * D2R, fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
    const rx0 = fm.pos.x - th.x, rz0 = fm.pos.z - th.z;
    const along = rx0 * fx + rz0 * fz, dist = -along, cross = rx0 * rx + rz0 * rz;
    const angle = Math.atan2(fm.pos.y - (th.elev + 15), Math.max(1, dist)) * R2D;
    const locAngle = Math.atan2(cross, Math.max(80, Math.abs(dist))) * R2D;
    const aligned = Math.abs(wrap180(fm.heading - th.hdg)) < 100;
    const valid = dist > -1500 && dist < 55500 && (dist < 0 || Math.abs(locAngle) < 35) && aligned;
    return { valid, dist, cross, locDots: -locAngle / 1.25, gsDots: dist > 0 ? (3 - angle) / 0.35 : 0, course: th.hdg, elev: th.elev, x: th.x, z: th.z, ident: `${this.cfg.to.icao} ${th.ident}`, angle };
  }
  getMapState(): MapState {
    const th = this.approachTh();
    const appr = th ? { lat: this.world!.proj.lat(th.z), lon: this.world!.proj.lon(th.x), hdg: th.hdg, ident: th.ident } : null;
    const navPath = th ? this.navWaypoints(th) : [];
    return {
      lat: this.lat(),
      lon: this.lon(),
      hdg: this.fm.heading,
      track: this.fm.track,
      from: this.cfg.from,
      to: this.cfg.to,
      trail: this.trail,
      altFt: this.fm.pos.y / 0.3048,
      depRwy: this.depRwy,
      apprRwy: this.apprKey,
      appr,
      navPath,
      flightPlan: this.flightPlan,
      activeWpIdx: this.activeWpIdx,
    };
  }

  // =====================================================================================
  //  Main loop
  // =====================================================================================
  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const frameMs = now - this.last;
    const rdt = Math.min(0.05, Math.max(0.0001, frameMs / 1000)); this.last = now;
    this.ticks++;
    if (!this.world || this.suspended) return;
    // Auto-60FPS adaptive resolution. Runs in the attract/loading views too, because a slow
    // first impression is just as bad as a slow flight. Frame gaps from tab switches are ignored.
    const perfActive = !document.hidden && (this.phase === 'playing' || this.phase === 'loading' || this.mode === 'attract');
    if (perfActive && frameMs > 4 && frameMs < 90) {
      this.emaFrameMs = this.emaFrameMs * 0.90 + frameMs * 0.10;
      this.dprCooldown -= rdt;
      if (this.dprCooldown <= 0) {
        const floor = QUALITY[this.quality].minPixelScale;
        if (this.emaFrameMs > 17.6 && this.dprScale > floor + 0.001) {
          const step = this.emaFrameMs > 24 ? 0.15 : 0.08;
          this.dprScale = Math.max(floor, +(this.dprScale - step).toFixed(2));
          this.dprCooldown = this.emaFrameMs > 24 ? 0.75 : 1.3;
          this.resize();
        } else if (this.emaFrameMs < 14.2 && this.dprScale < 1) {
          this.dprScale = Math.min(1, +(this.dprScale + 0.05).toFixed(2));
          this.dprCooldown = 3.0;
          this.resize();
        }
      }
    }
    if (this.phase === 'loading') {
      const t = this.world.terrain, waited = (now - this.loadStart) / 1000;
      this.world.update(this.camera, this.fm.pos, 1, this.time);
      this.attractCamera(rdt); this.render();
      if ((t.nearReady() && waited > 1.2) || waited > (t.offline ? 4 : 11)) { this.setPhase('idle'); this.hooks.onHud(this.hud()); }
      else if (this.ticks % 6 === 0) this.hooks.onHud(this.hud());
      return;
    }
    if (this.mode === 'attract') { this.time += rdt; this.attractCamera(rdt); this.world.update(this.camera, this.fm.pos, 1, this.time); this.visual?.update(this.fm, rdt, this.time, this.lights); this.visual!.root.position.copy(this.fm.pos); this.visual!.root.quaternion.copy(this.fm.quat); this.effects?.update(rdt); this.render(); return; }
    if (this.phase === 'playing') this.simulate(rdt);
    else if (this.phase === 'crashed' || this.phase === 'complete') this.postEnd(rdt);
    else if (this.phase === 'paused') { this.audio.update(this.audioState(true), rdt); }
    this.updateVisuals(rdt);
    this.render();
    this.hudT += rdt; if (this.hudT > 0.09) { this.hudT = 0; this.hooks.onHud(this.hud()); }
  };
  private render() {
    const r = this.renderer;
    r.clear();
    if (!this.world) return;
    r.render(this.world.scene, this.camera);
    if (this.mode === 'play' && this.isInterior() && this.cockpit && this.phase !== 'loading') { r.clearDepth(); r.render(this.cockpit.scene, this.cockpit.camera); }
  }

  private attractCamera(dt: number) {
    this.time += dt * 0.0; const t = performance.now() / 1000;
    const fm = this.fm, L = this.spec.length;
    const ang = t * 0.12 + 0.6, r = L * 1.5 + 12, hgt = 3 + L * 0.12 + Math.sin(t * 0.2) * 1.2;
    this.camera.position.set(fm.pos.x + Math.cos(ang) * r, fm.pos.y + hgt - 1.2, fm.pos.z + Math.sin(ang) * r);
    this.camera.lookAt(fm.pos.x, fm.pos.y + L * 0.05, fm.pos.z); this.camera.fov = 50; this.camera.updateProjectionMatrix();
    this.visual!.root.position.copy(fm.pos); this.visual!.root.quaternion.copy(fm.quat); this.visual!.setInterior(false); this.visual!.update(fm, dt, t, { ...this.lights, land: true, strobe: true });
  }

  private applyControls(dt: number) {
    const fm = this.fm, c = fm.ctl, s = this.spec, set = this.cfg.settings;
    const k = this.keys; const inv = set.invertPitch ? -1 : 1;
    const raw = {
      pitch: ((k.has('s') || k.has('ArrowDown') ? 1 : 0) - (k.has('w') || k.has('ArrowUp') ? 1 : 0)) * inv,
      roll: (k.has('d') || k.has('ArrowRight') ? 1 : 0) - (k.has('a') || k.has('ArrowLeft') ? 1 : 0),
      yaw: (k.has('e') ? 1 : 0) - (k.has('q') ? 1 : 0),
    };
    const up = 3.4 * set.sens, down = 6.5;
    for (const ax of ['pitch', 'roll', 'yaw'] as const) {
      const cur = this.axes[ax], tgt = raw[ax]; const rate = Math.abs(tgt) > Math.abs(cur) || Math.sign(tgt) !== Math.sign(cur) ? up : down;
      this.axes[ax] = cur + clamp(tgt - cur, -rate * dt, rate * dt);
    }
    // gamepad
    const gp = navigator.getGamepads ? navigator.getGamepads()[0] : null;
    if (gp) {
      const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : v);
      this.pad = { roll: dz(gp.axes[0] || 0), pitch: dz(gp.axes[1] || 0) * inv, yaw: dz(gp.axes[2] || 0) };
      const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0; c.throttle = clamp(c.throttle + (rt - lt) * 0.5 * dt, 0, 1);
      const edge = (i: number, id: string) => { const p = !!gp.buttons[i]?.pressed; if (p && !(this as any)['_gp' + i]) this.action(id); (this as any)['_gp' + i] = p; };
      edge(0, 'gear'); edge(1, 'park'); edge(4, 'flaps-'); edge(5, 'flaps+'); edge(3, 'pa'); edge(2, 'ap');
      // D-pad for ATC quick responses: 12: Up -> atc1, 13: Down -> atc2, 14: Left -> atc3, 15: Right -> atc4
      edge(12, 'atc1'); edge(13, 'atc2'); edge(14, 'atc3'); edge(15, 'atc4');
      edge(8, 'hudMode'); edge(9, 'pause');
    }
    const expo = (x: number) => x * 0.65 + x * x * x * 0.35;
    let pitch = clamp(expo(this.axes.pitch) + this.touch.pitch * inv + this.pad.pitch + (this.yokeDrag ? this.yokeDrag.pitch : 0), -1, 1);
    let roll = clamp(expo(this.axes.roll) + this.touch.roll + this.pad.roll + (this.yokeDrag ? this.yokeDrag.roll : 0), -1, 1);
    const yaw = clamp(this.axes.yaw + this.touch.yaw + this.pad.yaw, -1, 1);
    // throttle keys
    const thrUp = k.has('Shift') || k.has('PageUp'), thrDn = k.has('Control') || k.has('PageDown');
    if (thrUp) c.throttle = clamp(c.throttle + 0.5 * dt, 0, 1); if (thrDn) c.throttle = clamp(c.throttle - 0.5 * dt, 0, 1);
    if (k.has('Insert')) c.trim = clamp(c.trim + 0.3 * dt, -1, 1); if (k.has('Delete')) c.trim = clamp(c.trim - 0.3 * dt, -1, 1);
    // brakes
    const brakeTgt = k.has(' ') || this.touch.brake ? 1 : 0; this.brakeAxis += clamp(brakeTgt - this.brakeAxis, -dt * 8, dt * 5); c.brake = this.brakeAxis;
    // autopilot
    const manual = Math.abs(pitch) > 0.55 || Math.abs(roll) > 0.55;
    if (this.ap.on) {
      this.apOverride = manual ? this.apOverride + dt : 0;
      if (this.apOverride > 0.35) {
        this.toggleAp();
      } else if (this.ap.on) {
        // Sequentially advance flight plan waypoints
        if (this.flightPlan.length > 0 && this.activeWpIdx < this.flightPlan.length - 1) {
          const curWp = this.flightPlan[this.activeWpIdx];
          const d = haversine(this.lat(), this.lon(), curWp.lat, curWp.lon);
          const captureR = curWp.type === 'touchdown' ? 600 : curWp.type === 'faf' ? 1400 : curWp.type === 'takeoff' ? 900 : 2500;
          if (d < captureR) {
            this.activeWpIdx++;
            const nextWp = this.flightPlan[this.activeWpIdx];
            this.toast(`WPT SEQ: ${nextWp.name}`, 'info');
          }
        }

        const ils = this.computeIls();
        const brg = this.navBearing();
        const cmd = this.ap.step(fm, dt, brg, ils, this.flightPlan, this.activeWpIdx, this.lat(), this.lon());
        pitch = isFinite(cmd.pitch) ? cmd.pitch : 0;
        roll = isFinite(cmd.roll) ? cmd.roll : 0;
        if (cmd.throttle !== null && isFinite(cmd.throttle)) c.throttle = cmd.throttle;
        if (cmd.yaw !== undefined && isFinite(cmd.yaw)) c.yaw = cmd.yaw;
        if (cmd.gearDown !== undefined) c.gearDown = cmd.gearDown;
        if (cmd.flapsIdx !== undefined) c.flapsIdx = cmd.flapsIdx;
        if (cmd.brake !== undefined && cmd.brake > 0) c.brake = Math.max(c.brake, cmd.brake);
        if (cmd.parking) c.parking = true;
        if (cmd.reverse !== undefined) c.reverse = cmd.reverse;
        if (cmd.speedbrake !== undefined) c.speedbrake = cmd.speedbrake;

        if (this.ap.phase === 'stopped') {
          c.apHold = false;
          c.assist = set.assist;
          this.toast('Autoland complete – Aircraft stopped & parked', 'good');
        }
      }
    }
    if (!this.ap.on) c.yaw = yaw;
    c.pitch = pitch; c.roll = roll;
    if (!fm.wow && !this.ap.on) c.assist = set.assist;
    if (this.ap.on) c.assist = true;
    // reverse thrust only on ground
    if (!fm.wow && c.reverse) c.reverse = false;
    void s;
  }

  private simulate(rdt: number) {
    const fm = this.fm, w = this.world!; const dt = rdt;
    this.time += dt;
    const kias = fm.ias / 0.514444;
    if (dt > 0.001) {
      const accel = (kias - this.prevKias) / dt;
      this.speedTrendSmoothed = this.speedTrendSmoothed * 0.88 + accel * 6 * 0.12;
      this.prevKias = kias;
    }
    this.applyControls(dt);
    // time warp safety
    if (this.timeScale > 1 && (!this.ap.on || fm.agl < 300 || this.distToDest() < 30000)) { this.timeScale = 1; this.toast('Time warp ended', 'info'); }
    // atmosphere / gusts
    const alt = Math.max(0, fm.agl);
    const gustScale = this.turb * (alt < 800 ? 1 + (800 - alt) / 800 * 0.8 : 1) * (this.spec.kind === 'jet' ? 0.75 : 1);
    this.gustPhase += dt;
    const gp = this.gustPhase;
    this.gust.set((Math.sin(gp * 0.9) + Math.sin(gp * 2.3 + 1)) * 1.6, (Math.sin(gp * 1.3 + 2) + Math.sin(gp * 3.1)) * 1.8, (Math.sin(gp * 1.1 + 4) + Math.sin(gp * 2.7)) * 1.6).multiplyScalar(gustScale);
    fm.gust.copy(this.gust); fm.turb = gustScale;
    fm.wind.copy(this.windVec(fm.pos.y - fm.groundH));
    // physics
    const h = 1 / 120; this.acc += dt * this.timeScale; let steps = 0;
    while (this.acc >= h && steps < 140) { fm.step(h); this.acc -= h; steps++; if (fm.events.length) this.handleEvents(); if (fm.crashed) break; }
    if (this.acc > h * 8) this.acc = 0;
    this.flightTime += dt * this.timeScale;
    if (fm.crashed) { this.crash(fm.crashReason); return; }
    // structural limits
    const gl = gLimits[this.spec.kind];
    if (fm.nz > gl.p * 1.3 || fm.nz < gl.n * 1.4) { this.crash('Structural failure – airframe overstressed'); return; }
    if (fm.ias / 0.514444 > this.spec.vne * 1.3) { this.crash('Structural failure – extreme overspeed'); return; }
    // terrain at world edges: nothing. Rebase / airports every second
    this.slowT += dt;
    if (this.slowT > 1) { this.slowT = 0; this.slowTick(); }
    this.score_and_systems(dt);
    this.updateWarnings(dt);
    this.passengers(dt);
    this.checkCompletion(dt);
    if (this.restartHold > 0) { this.restartHold += dt; if (this.restartHold > 0.7) { this.restartHold = 0; this.restart(); return; } }
    w.update(this.camera, fm.pos, fm.agl, this.time);
  }

  private slowTick() {
    const fm = this.fm, w = this.world!;
    const lat = this.lat(), lon = this.lon();
    if (Math.hypot(fm.pos.x, fm.pos.z) > 80000) { this.rebaseTo(lat, lon); this.lastLL = [lat, lon]; return; }
    w.rebuildAirports(lat, lon);
    // auto approach-runway selection while far away
    if (!this.apprLocked) {
      const th = this.bestApproachFor(lat, lon); if (th && th.ident !== this.apprKey) this.apprKey = th.ident;
      if (this.distToDest() < 30000) this.apprLocked = true;
    } else if (!this.apprKey) { this.apprKey = this.approachTh()?.ident || ''; }
    // top of descent hint
    const rem = this.distToDest(); const altFt = fm.pos.y / 0.3048;
    const todNm = Math.max(8, ((altFt - this.cfg.to.elev / 0.3048) / 1000) * 3 + 8);
    if (!this.todShown && this.takeoffDone && rem / M_PER_NM < todNm && altFt > this.cfg.to.elev / 0.3048 + 3000) { this.todShown = true; this.toast(`Top of descent – ${Math.round(rem / M_PER_NM)} nm to go. Set a lower altitude and slow down.`, 'info'); }
  }
  private bestApproachFor(lat: number, lon: number): Threshold | null {
    const w = this.world!, ths = w.thresholds(this.cfg.to); if (!ths.length) return null;
    const px = w.proj.x(lon), pz = w.proj.z(lat); let best = ths[0], bs = -1e9; const maxLen = Math.max(...ths.map((t) => t.len));
    for (const t of ths) {
      const h = t.hdg * D2R, ax = t.x - Math.sin(h) * 12000, az = t.z + Math.cos(h) * 12000;
      const head = Math.cos((this.windFrom - t.hdg) * D2R) * this.windKt;
      const sc = head * 0.4 + (t.len >= maxLen * 0.7 ? 10 : 0) - Math.hypot(ax - px, az - pz) / 8000;
      if (sc > bs) { bs = sc; best = t; }
    }
    return best;
  }

  private handleEvents() {
    const fm = this.fm, evs = fm.events.splice(0); const fx = this.effects!;
    for (const e of evs) {
      if (e.kind === 'touchdown') {
        const fpm = Math.round(-e.vs * 196.85);
        const r = this.world!.runwayAt(fm.pos.x, fm.pos.z, 10);
        let dist = 0, off = 0, rwy = '', ap = '';
        if (r) {
          const fwd = Math.abs(wrap180(fm.heading - r.g.hdg)) < 90; dist = fwd ? r.along : r.g.len - r.along; off = Math.abs(r.across); rwy = fwd ? r.g.rw.le : r.g.rw.he; ap = r.g.ap.id;
        }
        if (!this.landing) this.landing = { vsFpm: fpm, kias: fm.ias / 0.514444, offset: off, dist, bank: Math.abs(fm.bank * R2D), pitch: fm.pitch * R2D, onRunway: !!r, airportId: ap, rwy };
        this.audio.touchdown(e.severity); this.shakeImpulse = Math.min(1, 0.25 + e.severity * 0.9);
        for (let i = 0; i < 14; i++) fx.tyreSmoke(e.point.clone(), fm.vel, 1);
        const q = fpm < 180 ? 'BUTTER!' : fpm < 350 ? 'Smooth touchdown' : fpm < 600 ? 'Firm touchdown' : 'HARD LANDING';
        this.toast(`${q}  ${fpm} fpm${r ? ` · ${rwy} · ${Math.round(off)} m off centre` : ' · off runway!'}`, fpm < 350 ? 'good' : fpm < 600 ? 'info' : 'bad');
        if (e.severity > 1) { this.comfort -= 18 + e.severity * 8; this.audio.speak('Hard landing', 'hl', 5); }
        else if (e.severity > 0.7) this.comfort -= 6;
      } else if (e.kind === 'gearbreak') { this.crash('Landing gear collapsed on impact'); }
      else if (e.kind === 'hull') {
        if (this.ticks % 4 === 0) { fx.sparks(e.point.clone(), 6, fm.vel); this.audio.scrape(); this.shakeImpulse = Math.max(this.shakeImpulse, 0.3); }
        if (fm.damage > 5) this.penalize('scrape', 'Aircraft scraped the ground', 100, 4);
      }
    }
  }

  private score_and_systems(dt: number) {
    const fm = this.fm, spec = this.spec, c = fm.ctl;
    // progress points
    const rem = this.distToDest();
    if (rem < this.bestRem) { const d = this.bestRem - rem; if (this.takeoffDone) this.score += d / 250; this.bestRem = rem; }
    if (this.takeoffDone) { const [la, lo] = [this.lat(), this.lon()]; this.flownKm += haversine(this.lastLL[0], this.lastLL[1], la, lo) / 1000; this.lastLL = [la, lo]; }
    else this.lastLL = [this.lat(), this.lon()];
    // takeoff detection
    if (!this.takeoffDone && !fm.wow && fm.agl > 4 && fm.vs > 0.5) {
      this.takeoffDone = true; this.addScore('Successful takeoff', 300); this.toast('Airborne!  +300', 'good'); this.audio.chirp();
      if (!this.paEvents.welcome) { this.comfort -= 3; }
      if (this.seatbelt === false) this.comfort -= 2;
    }
    // trail for map
    this.trailT += dt; if (this.trailT > 2 && this.takeoffDone) { this.trailT = 0; this.trail.push([this.lat(), this.lon()]); if (this.trail.length > 600) this.trail.shift(); }
    // fuel
    if (fm.fuelFrac < 0.1 && !this.fuelWarned) { this.fuelWarned = true; this.toast('LOW FUEL', 'bad'); this.audio.chime(); }
    if (fm.fuel <= 0 && !fm.engineOut) { /* engineOut flag set in model */ }
    // gear: wheels leave ground event, auto-lower? no. retract protect
    if (fm.gearPos > 0.02 && fm.gearPos < 0.98 && ((fm.ias / 0.514444) > spec.vle + 5)) { fm.damage += dt * 6; }
    void c;
  }

  // =====================================================================================
  //  Warnings (audible + visual): stall, overspeed, GPWS (terrain/sink/pull-up), gear, bank, config, fuel
  // =====================================================================================
  private updateWarnings(dt: number) {
    const fm = this.fm, s = this.spec, c = fm.ctl, L = fm.limits(), list: { text: string; level: 'caution' | 'warning'; sound: WarnSound }[] = [];
    const kias = L.kias; const aglM = fm.agl, vs = fm.vs;
    const inFlight = !fm.wow && fm.airborneTime > 1;
    let voice: [string, string, number] | null = null;
    if (inFlight && (fm.stalled || (fm.stallWarn && fm.alpha > fm.alphaStall * 0.97))) { list.push({ text: 'STALL', level: 'warning', sound: 'stall' }); voice = ['Stall', 'stall', 2.4]; if (!this.wasStalled) { this.penalize('stall', 'Stall', 60, 10); this.comfort -= 6; this.shakeImpulse = 0.4; } this.wasStalled = true; } else this.wasStalled = false;
    if (L.overspeed) { list.push({ text: 'OVERSPEED', level: 'warning', sound: 'overspeed' }); this.overspeedT += dt; this.penalize('os', 'Overspeed', 40, 5); voice = voice || ['Overspeed', 'os', 3]; } else this.overspeedT = 0;
    // terrain look-ahead (GPWS)
    if (inFlight) {
      const w = this.world!, v = fm.vel; let danger = 0;
      const landingCfg = c.gearDown && fm.gearPos > 0.9 && c.flapsIdx >= 1;
      const nearRwy = this.nearAirport(9000) && landingCfg;
      for (let t = 2; t <= 12 && !danger; t += 1.5) {
        const px = fm.pos.x + v.x * t, pz = fm.pos.z + v.z * t, py = fm.pos.y + v.y * t - (this.spec.gear[1].pos[1] * -1);
        const clear = py - w.terrain.heightAt(px, pz);
        if (clear < 35 && t <= 6) danger = 2; else if (clear < 110 && t <= 12) danger = 1;
      }
      if (danger && !nearRwy && aglM < 1500) { if (danger === 2) { list.push({ text: 'PULL UP', level: 'warning', sound: 'pullup' }); voice = ['Terrain. Pull up!', 'pu', 1.6]; this.penalize('gpws', 'Terrain warning (GPWS)', 75, 8); this.comfort -= 0.05; } else { list.push({ text: 'TERRAIN', level: 'caution', sound: 'terrain' }); voice = voice || ['Terrain, terrain', 'tr', 4]; } }
      if (aglM < 450 && vs < -(2.6 + aglM / 55) && !(nearRwy && aglM < 60)) { list.push({ text: 'SINK RATE', level: 'warning', sound: 'sink' }); voice = voice || ['Sink rate', 'sr', 3]; this.penalize('sink', 'Excessive sink rate', 30, 8); }
      if (!c.gearDown && fm.gearPos < 0.9 && aglM < 120 && vs < -0.5 && c.throttle < 0.7 && kias < s.vle * 1.6) { list.push({ text: 'TOO LOW – GEAR', level: 'warning', sound: 'gear' }); voice = ['Too low, gear', 'tlg', 2.5]; this.penalize('gear', 'Gear-up approach warning', 60, 10); }
      else if (!c.gearDown && c.flapsIdx >= Math.max(1, s.flapDetents - 1) && aglM < 450 && fm.gearPos < 0.9) { list.push({ text: 'CHECK GEAR', level: 'caution', sound: 'gear' }); }
      if (Math.abs(fm.bank * R2D) > 45) { list.push({ text: 'BANK ANGLE', level: 'caution', sound: 'bank' }); voice = voice || ['Bank angle', 'ba', 3]; this.penalize('bank', 'Excessive bank', 10, 8); this.comfort -= dt * 1.5; }
    }
    if (L.gearOver) { list.push({ text: 'GEAR OVERSPEED', level: 'caution', sound: 'overspeed' }); this.penalize('go', 'Gear overspeed', 20, 6); }
    if (L.flapOver && fm.flapsPos > 0.05) { list.push({ text: 'FLAPS OVERSPEED', level: 'caution', sound: 'overspeed' }); this.penalize('fo', 'Flap overspeed', 20, 6); fm.damage += dt * 2; }
    if (fm.wow && c.throttle > 0.82 && c.parking) { list.push({ text: 'PARK BRAKE', level: 'warning', sound: 'config' }); voice = voice || ['Parking brake', 'pb', 3]; }
    else if (fm.wow && c.throttle > 0.85 && fm.gs < 40 && s.kind !== 'piston' && c.flapsIdx === 0) { list.push({ text: 'CONFIG FLAPS', level: 'warning', sound: 'config' }); voice = voice || ['Flaps. Takeoff configuration', 'cf', 4]; }
    if (fm.fuelFrac < 0.1 && fm.fuel > 0) list.push({ text: 'LOW FUEL', level: 'caution', sound: 'fuel' });
    if (fm.fuel <= 0) { list.push({ text: 'ENGINE FLAMEOUT', level: 'warning', sound: 'fuel' }); voice = voice || ['Engine failure', 'ef', 8]; }
    if (!this.seatbelt && this.turb > 0.3 && this.takeoffDone) list.push({ text: 'SEATBELT SIGN', level: 'caution', sound: null });
    // altitude callouts on approach
    if (inFlight && c.gearDown && vs < -1 && !this.ap.on || (inFlight && c.gearDown && vs < -1)) {
      const ft = aglM / 0.3048; const calls: [number, string][] = [[500, 'Five hundred'], [100, 'One hundred'], [50, 'Fifty'], [30, 'Thirty'], [20, 'Twenty'], [10, 'Ten']];
      for (const [h, t] of calls) if (this.prevAgl / 0.3048 > h && ft <= h && (h >= 100 || s.kind === 'jet' || h === 50)) this.audio.speak(t, 'c' + h, 0.5, 1.15, 0.85);
      if (this.ap.appr && this.prevAgl / 0.3048 > 20 && ft <= 20 && s.kind === 'jet') this.audio.speak('Retard', 'ret', 3);
    }
    this.prevAgl = aglM;
    this.warnState = list;
    const top = list.find((x) => x.sound) || null;
    this.curSound = top ? top.sound : null;
    if (voice) this.audio.speak(voice[0], voice[1], voice[2]);
    // new warning chirps
    const sig = list.map((l) => l.text).join('|'); if (sig !== this.warnSig) { if (list.some((l) => l.level === 'caution') && !list.some((l) => l.level === 'warning') && list.length > this.warnLen) this.audio.chime(); this.warnSig = sig; this.warnLen = list.length; }
  }
  private curSound: WarnSound = null; private warnSig = ''; private warnLen = 0;
  private nearAirport(r: number) { return airportsNear(this.lat(), this.lon(), r).some((a) => a.runways.length > 0); }

  // =====================================================================================
  //  Passengers
  // =====================================================================================
  private passengers(dt: number) {
    const fm = this.fm; let drain = 0;
    const dn = Math.abs(fm.nz - 1);
    if (dn > 0.4) drain += (dn - 0.4) * 14;
    const bank = Math.abs(fm.bank * R2D); if (bank > 32) drain += (bank - 32) * 0.08;
    const p = fm.pitch * R2D; if (p > 14 || p < -9) drain += 1.5;
    if (this.turb > 0.25 && !this.seatbelt && this.takeoffDone) drain += this.turb * 2;
    else if (this.turb > 0.3) drain += this.turb * 0.5;
    if (fm.stalled) drain += 8;
    if (Math.abs(fm.ny) > 0.25) drain += 4;
    if (this.takeoffDone && this.world && !this.seatbelt && fm.agl < 400 && !fm.wow) drain += 0.3;
    this.comfort = clamp(this.comfort - drain * dt, 0, 100);
    if (drain < 0.05 && this.takeoffDone) this.comfort = Math.min(100, this.comfort + dt * 0.25);
    this.cabinMsgT -= dt; if (this.cabinMsgT <= 0) this.cabinMsg = '';
    this.nextChat -= dt;
    if (this.nextChat <= 0 && this.spec.pax > 3) {
      this.nextChat = 30 + Math.random() * 30;
      const m = this.comfort / 100;
      const lines = m > 0.7 ? ['“Wow, look at that view!”', '“Smooth ride today.”', '“Are we there yet? Kidding!”'] : m > 0.4 ? ['“It’s a bit bumpy…”', '“Could be smoother.”'] : ['“I don’t feel so good…”', '“Please, Captain, gently!”'];
      this.setCabinMsg(lines[(Math.random() * lines.length) | 0]);
    }
    if (this.comfort < 25 && !this.warnPenalty['pax']) { this.warnPenalty['pax'] = 1; this.toast('Passengers are very unhappy!', 'bad'); }
  }

  // =====================================================================================
  //  Landing / completion / crash
  // =====================================================================================
  private checkCompletion(dt: number) {
    const fm = this.fm;
    if (!this.landing || !fm.wow) { this.stoppedT = 0; return; }
    if (fm.gs < 1.2 && !this.endT) {
      this.stoppedT += dt;
      if (this.stoppedT > 2.2) {
        const near = airportsNear(this.lat(), this.lon(), 2500).find((a) => a.runways.length > 0);
        const onRwy = this.world!.runwayAt(fm.pos.x, fm.pos.z, 120);
        if (onRwy || near) this.finish(near && near.id !== this.cfg.to.id && !(onRwy && onRwy.g.ap.id === this.cfg.to.id) ? 'diverted' : 'landed');
        else if (this.stoppedT > 8) { this.toast('Stopped off-airport – take off again or restart (R)', 'warn'); this.stoppedT = -999; }
      }
    }
  }
  private finish(outcome: 'landed' | 'diverted') {
    const fm = this.fm, l = this.landing!; const items: Breakdown[] = [...this.items];
    const addI = (label: string, pts: number) => { items.push({ label, pts }); };
    let total = this.score;
    const dest = this.cfg.to.id;
    const atDest = l.airportId === dest || outcome === 'landed';
    const base = atDest ? 1000 : 400; addI(atDest ? 'Flight completed at destination' : 'Diverted landing', base); total += base;
    const vsq = l.vsFpm < 120 ? [1000, 'Butter landing'] : l.vsFpm < 250 ? [800, 'Smooth touchdown'] : l.vsFpm < 400 ? [550, 'Good touchdown'] : l.vsFpm < 600 ? [300, 'Firm touchdown'] : l.vsFpm < 800 ? [100, 'Hard touchdown'] : [0, 'Very hard touchdown'];
    addI(`${vsq[1]} (${l.vsFpm} fpm)`, vsq[0] as number); total += vsq[0] as number;
    if (l.onRunway) { const cl = Math.max(0, Math.round(300 - l.offset * 12)); addI(`Centreline (${Math.round(l.offset)} m off)`, cl); total += cl; const tz = l.dist >= 100 && l.dist <= 700 ? 200 : l.dist < 100 ? 80 : 60; addI(`Touchdown zone (${Math.round(l.dist)} m)`, tz); total += tz; }
    else { addI('Touchdown off the runway', -250); total -= 250; }
    const sp = Math.abs(l.kias - this.spec.vapp); const spp = sp < 6 ? 120 : sp < 12 ? 60 : 0; if (spp) { addI(`Approach speed (${Math.round(l.kias)} kt)`, spp); total += spp; }
    const cm = Math.round(this.comfort * 5); addI(`Passenger comfort ${Math.round(this.comfort)}%`, cm); total += cm;
    const fu = Math.round(fm.fuelFrac * 200); addI('Fuel remaining', fu); total += fu;
    if (this.usedAp) { /* flying on autopilot is fine; no penalty */ }
    const km = Math.round(this.flownKm * 0.4); addI(`Distance flown ${Math.round(this.flownKm)} km`, km); total += km;
    const skill = vsq[0] as number + (l.onRunway ? 200 : 0) + cm + (total - this.score) * 0 + items.filter((i) => i.pts < 0).reduce((a, b) => a + b.pts, 0);
    const grade = skill >= 1700 ? 'S' : skill >= 1350 ? 'A' : skill >= 950 ? 'B' : skill >= 550 ? 'C' : skill >= 200 ? 'D' : 'F';
    this.endGame({ outcome, score: Math.max(0, Math.round(total)), grade, items, landing: l, reason: '' });
  }
  crash(reason: string) {
    if (this.phase !== 'playing') return; const fm = this.fm;
    this.setPhase('crashed'); this.crashTimer = 0;
    this.effects!.explosion(fm.pos.clone(), fm.vel.clone(), Math.max(1, this.spec.length / 9));
    this.audio.silence(); this.audio.crash(); this.shakeImpulse = 1.5;
    this.visual?.setVisible(false); this.crashReason = reason;
    this.crashPos = fm.pos.clone(); fm.vel.set(0, 0, 0); fm.w.set(0, 0, 0);
    this.setView('chase'); this.zoom = 3;
    this.toast(reason, 'bad');
  }
  private crashReason = ''; private crashPos = new THREE.Vector3();
  private endGame(r: Omit<Result, 'rank' | 'distanceKm' | 'flightTime' | 'comfort' | 'newBest'>) {
    const items = r.items.slice();
    const crashed = r.outcome === 'crashed';
    const rec = addScore({ score: r.score, name: this.cfg.settings.name || 'Pilot', aircraft: this.spec.name, from: this.cfg.from.icao, to: this.cfg.to.icao, grade: r.grade, outcome: r.outcome, landingFpm: r.landing ? r.landing.vsFpm : null, date: Date.now(), distanceKm: Math.round(this.flownKm) });
    this.result = { ...r, items, rank: rec.rank, distanceKm: Math.round(this.flownKm), flightTime: this.flightTime, comfort: this.comfort, newBest: rec.rank === 1 && r.score > 0 };
    this.endT = 0.001;
    if (!crashed) { this.setPhase('complete'); this.audio.silence(); this.audio.applause(); this.audio.speak(r.grade === 'F' ? 'Flight complete.' : `Welcome to ${this.cfg.to.city || this.cfg.to.name}. Thank you for flying with us.`, 'end', 1, 1, 1); this.setView('chase'); }
    // result delivered after short delay in postEnd
  }
  private postEnd(dt: number) {
    this.endT += dt; this.crashTimer += dt;
    this.time += dt;
    if (this.phase === 'crashed') {
      if (this.crashTimer < 8 && this.ticks % 2 === 0) this.effects!.fire(this.crashPos.clone(), Math.max(1, this.spec.length / 10));
      if (!this.result && this.crashTimer > 2.2) {
        const items = [...this.items]; const pen = Math.round(this.score * 0.7); items.push({ label: 'Crash penalty (−70%)', pts: -pen });
        this.endGame({ outcome: 'crashed', score: Math.max(0, Math.round(this.score - pen)), grade: 'F', items, landing: null, reason: this.crashReason });
      }
    }
    if (this.result && this.endT > (this.phase === 'crashed' ? 0.4 : 2.0) && this.result) { const r = this.result; this.result = null; this.hooks.onResult(r); }
    this.audio.update(this.audioState(true), dt);
  }

  // =====================================================================================
  //  Visuals, camera, audio
  // =====================================================================================
  private updateVisuals(dt: number) {
    const fm = this.fm, w = this.world!, v = this.visual!, fx = this.effects!;
    if (this.phase !== 'crashed') { v.root.position.copy(fm.pos); v.root.quaternion.copy(fm.quat); v.update(fm, this.phase === 'paused' ? 0 : dt, this.time, this.lights); }
    // contact effects
    if (this.phase === 'playing') {
      for (let i = 0; i < fm.gear.length; i++) {
        const g = fm.gear[i];
        if (g.contact && fm.gs > 8 && g.skid && this.ticks % 3 === 0) fx.tyreSmoke(tmpV.set(this.spec.gear[i].pos[0], this.spec.gear[i].pos[1], this.spec.gear[i].pos[2]).applyQuaternion(fm.quat).add(fm.pos), fm.vel, 1);
      }
      if (fm.thrustN < -1000 && fm.wow && fm.gs > 15 && this.ticks % 4 === 0) fx.dust(fm.pos.clone().add(new THREE.Vector3(0, -2, 0)), 2);
      if (fm.damage > 30 && this.ticks % 5 === 0) fx.fire(fm.pos.clone().add(new THREE.Vector3(0, 0.5, 0)), 0.3);
    }
    fx.update(dt);
    // camera
    this.updateCamera(dt);
    // sim → cockpit instruments
    const interior = this.isInterior() && this.mode === 'play';
    if (interior && this.cockpit) this.cockpit.update(dt, this.time, this.panelData(), { pitch: fm.ctl.pitch, roll: fm.ctl.roll, yaw: fm.ctl.yaw, throttle: fm.ctl.throttle, flapsIdx: fm.ctl.flapsIdx, gearDown: fm.ctl.gearDown, speedbrake: fm.ctl.speedbrake }, { lights: this.lights, seatbelt: this.seatbelt, parking: fm.ctl.parking, reverse: fm.ctl.reverse, apOn: this.ap.on, apNav: this.ap.nav, apAppr: this.ap.appr, apHdg: this.ap.hdg, apAlt: this.ap.altFt, apSpd: this.ap.spd, mood: this.comfort / 100, shake: clamp(this.turb * 1.6 + this.shakeImpulse, 0, 1.6) }, true);
    v.setInterior(interior);
    if (this.phase === 'playing') this.audio.update(this.audioState(false), dt);
    w.sunLight.visible = true;
  }
  private audioState(paused: boolean) {
    const fm = this.fm; const interior = this.isInterior();
    return { kind: this.spec.kind, n: fm.n[0], thrust: fm.thrustN, ias: fm.ias, tas: fm.tas, wow: fm.wow, gs: fm.gs, view: interior ? 'inside' as const : 'outside' as const, cabin: VIEWS[this.viewIdx] === 'aisle' || VIEWS[this.viewIdx] === 'window', sound: this.phase === 'playing' ? this.curSound : null, paused: paused || this.phase !== 'playing', mood: this.comfort / 100, agl: fm.agl, vol: 1 };
  }
  private updateCamera(dt: number) {
    const fm = this.fm, cam = this.camera, L = this.spec.length, view = VIEWS[this.viewIdx], t = this.time;
    // Dynamic near/far planes keep hardware Early-Z depth buffer 100% z-fight-free at all altitudes
    cam.near = clamp(fm.agl * 0.055, 1.8, 85);
    cam.far = clamp(180000 + fm.agl * 12, 180000, 320000);
    // shake
    const set = this.cfg.settings;
    const flying = this.phase === 'playing';
    let amp = set.shake && flying ? this.turb * 0.0018 * clamp(1.5 - fm.agl / 1500, 0.6, 1.5) + (fm.stalled ? 0.006 : fm.stallWarn ? 0.0025 : 0) + (fm.wow ? clamp(fm.gs / 70, 0, 1) * 0.0009 : 0) + fm.n[0] * 0.0004 : 0;
    if (set.shake) amp += this.shakeImpulse * 0.02;
    this.shakeImpulse = Math.max(0, this.shakeImpulse - dt * 1.8);
    if (this.phase === 'crashed') amp += Math.max(0, 1 - this.crashTimer / 3) * 0.02;
    const sx = amp * (Math.sin(t * 23.1) + Math.sin(t * 41.7 + 1.3)), sy = amp * (Math.sin(t * 19.3 + 2) + Math.sin(t * 37.9)), sr = amp * 0.6 * Math.sin(t * 29.1);
    const gOff = flying ? clamp(-(fm.nz - 1) * 0.025, -0.06, 0.06) : 0;
    if (this.isInterior() && this.mode === 'play') {
      const vw = this.cockpit!.views[view as 'cockpit' | 'aisle' | 'window'];
      tmpE.set(vw.pitch + this.lookPitch + sx, vw.yaw + this.lookYaw + sy, sr, 'YXZ');
      const local = tmpQ.setFromEuler(tmpE).clone();
      const headLocal = vw.pos.clone(); headLocal.y += gOff;
      const cq = this.cockpit!.camera; cq.position.copy(headLocal); cq.quaternion.copy(local); cq.fov = this.fovFor(view === 'cockpit' ? 68 : 72); cq.updateProjectionMatrix();
      cam.position.copy(fm.pos).add(headLocal.clone().applyQuaternion(fm.quat)); cam.quaternion.copy(fm.quat).multiply(local); cam.fov = cq.fov; cam.updateProjectionMatrix();
    } else if (view === 'spotter' && this.mode === 'play') {
      const toAc = tmpV.copy(fm.pos).sub(cam.position); const d = toAc.length();
      if (!this.spotAnchor || d > 1800 || (d > 300 && toAc.dot(fm.vel) < 0 && fm.gs > 20)) {
        const vdir = tmpV2.copy(fm.vel).setY(0); if (vdir.lengthSq() < 4) vdir.set(0, 0, -1); vdir.normalize();
        const side = new THREE.Vector3(-vdir.z, 0, vdir.x);
        this.spotAnchor = fm.pos.clone().addScaledVector(vdir, 700 + fm.gs * 4).addScaledVector(side, 70 + L * 2);
        const gh = this.world!.terrain.heightAt(this.spotAnchor.x, this.spotAnchor.z); this.spotAnchor.y = Math.max(gh + 6, Math.min(fm.pos.y, gh + 150));
      }
      cam.position.copy(this.spotAnchor); cam.lookAt(fm.pos); cam.fov = clamp(2 * Math.atan(L * 1.6 / Math.max(60, d)) * R2D, 8, 50); cam.updateProjectionMatrix();
    } else {
      // chase
      if (!this.chaseInit) { this.chaseQ.copy(fm.quat); this.chaseInit = true; }
      this.chaseQ.slerp(fm.quat, 1 - Math.exp(-dt * 3.2));
      const e = new THREE.Euler().setFromQuaternion(this.chaseQ, 'YXZ'); e.z *= 0.35;
      const q = new THREE.Quaternion().setFromEuler(e);
      const off = new THREE.Vector3(0, L * 0.16 + 1.5, L * 0.95 + 5).multiplyScalar(this.zoom);
      const orb = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.orbitPitch * 0 - 0, this.orbitYaw, 0, 'YXZ'));
      off.applyAxisAngle(new THREE.Vector3(1, 0, 0), -(this.orbitPitch - 0.12) * 1.2).applyQuaternion(orb).applyQuaternion(q);
      cam.position.copy(fm.pos).add(off);
      const gh = this.world!.terrain.heightAt(cam.position.x, cam.position.z); if (cam.position.y < gh + 2.5) cam.position.y = gh + 2.5;
      cam.up.set(0, 1, 0).applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, e.z * 0.6)));
      cam.lookAt(fm.pos.x, fm.pos.y + L * 0.03, fm.pos.z); cam.up.set(0, 1, 0);
      cam.rotateX(sx); cam.rotateY(sy); cam.fov = this.fovFor(60 + Math.min(10, fm.gs / 40)); cam.updateProjectionMatrix();
    }
    if (this.phase === 'crashed') { cam.lookAt(this.crashPos); }
    cam.updateMatrixWorld();
  }
  private spotAnchor: THREE.Vector3 | null = null;

  private panelData(): PanelData {
    const fm = this.fm, s = this.spec, ils = this.computeIls(), rem = this.distToDest();
    const brg = bearing(this.lat(), this.lon(), this.cfg.to.lat, this.cfg.to.lon);
    return {
      kias: fm.ias / 0.514444, altFt: fm.pos.y / 0.3048, vsFpm: fm.vs * 196.85, hdg: fm.heading, trk: fm.track, pitch: fm.pitch * R2D, bank: fm.bank, slip: fm.beta, mach: fm.mach, gsKt: fm.gs * MS_TO_KT,
      n1: fm.n.slice(0, s.engines), fuelKg: fm.fuel, fuelFrac: fm.fuelFrac, flapsIdx: fm.ctl.flapsIdx, flapsDet: s.flapDetents, gear: fm.gearPos, throttle: fm.ctl.throttle, parking: fm.ctl.parking, reverse: fm.ctl.reverse, spoilers: fm.sbPos,
      apOn: this.ap.on, apHdg: this.ap.hdg, apAlt: this.ap.altFt, apSpd: this.ap.spd, apNav: this.ap.nav, apAppr: this.ap.appr, apVsMode: false,
      dest: { id: this.cfg.to.icao, name: this.cfg.to.name, brg: wrap180(brg), distNm: rem / M_PER_NM, eteMin: (rem / Math.max(30, fm.gs)) / 60 },
      ils: ils ? { valid: ils.valid, loc: ils.locDots, gs: ils.gsDots, ident: ils.ident, distNm: ils.dist / M_PER_NM } : null,
      warn: this.warnState.map((w) => w.text), aglFt: fm.agl / 0.3048, alphaFrac: fm.alpha / fm.alphaStall, time: this.time, thrustPct: (Math.abs(fm.thrustN) / ((s.thrust || s.power / 60) * (s.kind === 'jet' ? 1 : 1))) * 100, fuelFlowKgH: fm.fuelFlow * 3600,
    };
  }

  private coach(): string {
    if (this.mode !== 'play' || !this.cfg.settings.hud) return '';
    const fm = this.fm, c = fm.ctl, s = this.spec, kias = fm.ias / 0.514444;
    if (this.phase !== 'playing') return '';
    if (this.ap.on) {
      const wpName = this.flightPlan[this.activeWpIdx]?.name || this.cfg.to.icao;
      return `Autopilot [${this.ap.phase.toUpperCase()}] · Next: ${wpName} · Press [Y] to disengage`;
    }
    if (fm.wow && !this.landing && !this.takeoffDone) {
      if (c.parking) return 'Release parking brake [B] or engage Autopilot [Y] for Auto-Takeoff';
      if (s.kind !== 'piston' && c.flapsIdx === 0) return `Set takeoff flaps [F] or engage [Y] for Auto-Takeoff`;
      if (c.throttle < 0.6) return 'Advance throttle [Shift / 0] or engage [Y] for Auto-Takeoff';
      if (kias < s.vr - 3) return `Accelerating… keep nose straight with [Q]/[E] – rotate at ${s.vr} kt`;
      return 'ROTATE – ease nose up with [S] / ↓';
    }
    if (!fm.wow && !this.landing) {
      if (c.gearDown && fm.agl > 15 && fm.vs > 1 && this.takeoffDone && fm.agl < 800 && this.distToDest() > 20000) return 'Positive climb – retract landing gear [G]';
      if (!this.usedAp && fm.agl > 500 && this.distToDest() > 25000) return 'Level off, then press [Y] for autopilot – tracks full flight route';
      const rem = this.distToDest() / M_PER_NM;
      if (rem < 12 && !c.gearDown && fm.agl < 1500) return 'Approach – lower gear [G] and set flaps [F]';
      if (rem < 25 && !this.ap.appr && this.computeIls()?.valid) return `ILS ${this.computeIls()!.ident} available – press [U] for autoland`;
    }
    if (this.landing && fm.wow && fm.gs > 8) return `Rollout – brake with [Space]${s.hasReverse ? ', reverse thrust [T]' : ''}${s.hasSpeedbrake ? ', spoilers [Z]' : ''}`;
    return '';
  }

  private computeFlightPhase(): FlightPhase {
    const fm = this.fm;
    if (!fm) return 'taxi';
    const kias = fm.ias / 0.514444;
    const aglFt = fm.agl / 0.3048;
    const vsFpm = fm.vs * 196.85;
    const remNm = this.distToDest() / M_PER_NM;
    const c = fm.ctl;
    const prev = this.currentFlightPhase;

    // 1. On ground logic
    if (fm.wow) {
      if (this.landing || (this.takeoffDone && kias > 25)) {
        return kias > 25 ? 'rollout' : 'taxi';
      }
      if (prev === 'rollout') {
        return kias > 25 ? 'rollout' : 'taxi';
      }
      if (c.throttle > 0.55 && kias > 18) {
        return 'takeoff';
      }
      return 'taxi';
    }

    // 2. In flight logic
    // Go-around: high throttle and positive rate of climb in landing/final
    if ((prev === 'final' || prev === 'rollout') && c.throttle > 0.75 && vsFpm > 250) {
      return 'climb';
    }

    // Final Approach: close to runway with landing geometry, or flagged landing
    if (this.landing || (remNm <= 5.5 && aglFt < 2200) || (aglFt < 850 && remNm <= 9)) {
      return 'final';
    }

    // Takeoff roll transition to climb upon becoming airborne
    if (prev === 'takeoff' || prev === 'taxi') {
      return 'climb';
    }

    // Climb phase: maintain climb until reaching safe altitude and level-off, or reaching cruise
    if (prev === 'climb') {
      const cruiseAltFt = this.spec.cruiseAlt / 0.3048;
      const reachedCruise = aglFt > cruiseAltFt * 0.85 || (aglFt > 2000 && vsFpm < 150);
      if (reachedCruise && remNm > 15) {
        return 'cruise';
      }
      if (reachedCruise && remNm <= 15) {
        return 'descent';
      }
      return 'climb';
    }

    // Descent phase: approaching destination or actively descending towards airport
    const descentGateNm = Math.max(12, Math.min(45, (aglFt / 1000) * 3 + 6));
    if (this.ap?.appr || (remNm <= descentGateNm && (vsFpm < -250 || remNm <= 14))) {
      return 'descent';
    }

    if (prev === 'descent') {
      if (vsFpm > 500 && aglFt > 4000) {
        return 'climb';
      }
      return 'descent';
    }

    return 'cruise';
  }

  private onFlightPhaseChange(prev: FlightPhase, next: FlightPhase) {
    void prev;
    if (this.mode !== 'play') return;
    const depRwy = this.depRwy || '09';
    const arrRwy = this.apprKey || '27';
    const fromIcao = this.cfg.from.icao;
    const toIcao = this.cfg.to.icao;
    const wind = `${this.windFrom}° at ${this.windKt} kt`;

    switch (next) {
      case 'taxi':
        if (this.landing) {
          this.addAtc('GROUND', `Aero 101, welcome to ${toIcao}. Taxi to apron via Bravo. Contact ground 121.7.`, true);
        } else {
          this.addAtc('GROUND', `Aero 101, ${fromIcao} Ground. Taxi to holding point runway ${depRwy} via Alpha.`, true);
        }
        break;
      case 'takeoff':
        this.addAtc('TOWER', `Aero 101, ${fromIcao} Tower. Runway ${depRwy}, wind ${wind}, cleared for takeoff.`, true);
        this.audio.chirp();
        break;
      case 'climb':
        this.addAtc('DEPARTURE', `Aero 101, airborne, radar contact. Climb and maintain ${Math.round(this.spec.cruiseAlt / 0.3048)} ft, contact Departure on 124.2.`, false);
        break;
      case 'cruise':
        this.addAtc('ENROUTE', `Aero 101, reaching cruise altitude. Traffic clear, monitor frequency 133.5.`, false);
        break;
      case 'descent':
        this.addAtc('APPROACH', `Aero 101, ${toIcao} Approach. Descend and maintain 3,500 ft, QNH 29.92. Expect ILS runway ${arrRwy}.`, true);
        this.audio.chime();
        break;
      case 'final':
        this.addAtc('TOWER', `Aero 101, ${toIcao} Tower. Runway ${arrRwy}, wind ${wind}, cleared to land.`, true);
        this.audio.chime();
        break;
      case 'rollout':
        this.addAtc('TOWER', `Aero 101, rollout safe. Vacate runway left when able, contact Ground on 121.9.`, false);
        break;
    }
  }

  addAtc(sender: string, text: string, needsAck = false) {
    const msg: AtcMessage = {
      id: this.nextAtcId++,
      sender,
      text,
      time: this.time,
      needsAck,
    };
    this.atcMessages.push(msg);
    if (this.atcMessages.length > 25) this.atcMessages.shift();
  }

  respondAtc(option: number) {
    if (this.phase !== 'playing') return;
    const pending = this.atcMessages.find((m) => m.needsAck);
    if (pending) pending.needsAck = false;

    let pilotText = '';
    let ackText = '';
    const toIcao = this.cfg.to.icao;
    const fromIcao = this.cfg.from.icao;
    const rwy = this.apprKey || this.depRwy || 'active';

    switch (option) {
      case 1:
        pilotText = `Aero 101: Wilco / Roger. Reading you 5 by 5.`;
        ackText = `Roger, Aero 101. Report when ready.`;
        break;
      case 2:
        pilotText = `Aero 101: Requesting departure clearance out of ${fromIcao}.`;
        ackText = `Aero 101, cleared as filed. Squawk 4215, climb via SID.`;
        break;
      case 3:
        pilotText = `Aero 101: Inbound for landing, request approach clearance to ${toIcao}.`;
        ackText = `Aero 101, cleared ILS runway ${rwy} approach, maintain 140kt to 4 DME.`;
        break;
      case 4:
        pilotText = `Aero 101: Say again transmissions.`;
        ackText = `Aero 101, radar service terminated, monitor unicom 122.8.`;
        break;
    }

    this.audio.chirp();
    this.addAtc('PILOT', pilotText, false);
    setTimeout(() => {
      if (this.phase === 'playing') {
        this.addAtc('TOWER', ackText, false);
      }
    }, 1500);
  }

  hud(): HudState {
    const fm = this.fm, s = this.spec, ils = this.computeIls(), rem = this.distToDest();
    const brg = bearing(this.lat(), this.lon(), this.cfg.to.lat, this.cfg.to.lon);
    const th = this.approachTh();
    const rwyHdg = th ? th.hdg : 0;
    const rwyIdent = this.apprKey || (th ? th.ident : '');
    const rwyDistNm = th ? Math.hypot(fm.pos.x - th.x, fm.pos.z - th.z) / M_PER_NM : 0;
    const total = haversine(this.cfg.from.lat, this.cfg.from.lon, this.cfg.to.lat, this.cfg.to.lon) || 1;
    const loadP = this.world ? this.world.terrain.progress() : 0;

    const flightPhase = this.computeFlightPhase();
    if (flightPhase !== this.currentFlightPhase) {
      this.onFlightPhaseChange(this.currentFlightPhase, flightPhase);
      this.currentFlightPhase = flightPhase;
    }

    const relWind = wrap180(this.windFrom - fm.heading);
    const relWindRad = relWind * D2R;
    const crosswindKt = Math.round(this.windKt * Math.sin(relWindRad));
    const headwindKt = Math.round(this.windKt * Math.cos(relWindRad));
    const fuelTimeMin = fm.fuelFlow > 0.0001 ? Math.round((fm.fuel / (fm.fuelFlow * s.engines)) / 60) : 999;

    let runwayRemM = 0;
    if (this.depTh && !this.takeoffDone && fm.wow) {
      const d = Math.hypot(fm.pos.x - this.depTh.x, fm.pos.z - this.depTh.z);
      runwayRemM = Math.max(0, Math.round(this.depTh.len - d));
    } else if (th && (this.landing || flightPhase === 'final' || flightPhase === 'rollout')) {
      const d = Math.hypot(fm.pos.x - th.x, fm.pos.z - th.z);
      runwayRemM = Math.max(0, Math.round(th.len - d));
    }

    const pitchTarget = (flightPhase === 'takeoff' || flightPhase === 'climb') ? 12 : null;
    const latestAtc = this.atcMessages.length > 0 ? this.atcMessages[this.atcMessages.length - 1] : null;

    // Flight Path Angle (gamma) in degrees: atan2(vertical speed, ground speed)
    const fpaDeg = Math.atan2(fm.vs, Math.max(0.5, fm.gs)) * R2D;
    const track = fm.track;

    // Active flight plan waypoint telemetry
    let activeWp: { name: string; distNm: number; brg: number; etaMin: number } | null = null;
    if (this.flightPlan.length > 0 && this.activeWpIdx < this.flightPlan.length) {
      const wp = this.flightPlan[this.activeWpIdx];
      const d = haversine(this.lat(), this.lon(), wp.lat, wp.lon);
      const b = bearing(this.lat(), this.lon(), wp.lat, wp.lon);
      const wpDistNm = d / M_PER_NM;
      const etaMin = wpDistNm / Math.max(30, fm.gs * MS_TO_KT) * 60;
      activeWp = {
        name: wp.name,
        distNm: wpDistNm,
        brg: Math.round(b),
        etaMin,
      };
    }

    // Clean up acknowledged warnings that are no longer active
    const activeWarnTexts = new Set(this.warnState.map((w) => w.text));
    for (const acked of this.ackedWarnings) {
      if (!activeWarnTexts.has(acked)) {
        this.ackedWarnings.delete(acked);
      }
    }

    const warnList = this.warnState.map((w) => ({
      text: w.text,
      level: w.level,
      acked: this.ackedWarnings.has(w.text),
    }));

    return {
      phase: this.phase, view: VIEWS[this.viewIdx], kias: fm.ias / 0.514444, altFt: fm.pos.y / 0.3048, vsFpm: fm.vs * 196.85, hdg: fm.heading, gsKt: fm.gs * MS_TO_KT, mach: fm.mach, pitch: fm.pitch * R2D, bank: fm.bank * R2D,
      throttle: fm.ctl.throttle, n1: fm.n[0], flapsIdx: fm.ctl.flapsIdx, flapsDet: s.flapDetents, gear: fm.gearPos, gearDown: fm.ctl.gearDown, brake: fm.ctl.brake > 0.1, parking: fm.ctl.parking, reverse: fm.ctl.reverse, spoilers: fm.sbPos,
      fuelPct: fm.fuelFrac * 100, fuelKg: fm.fuel, aglFt: fm.agl / 0.3048, distNm: rem / M_PER_NM, brg, eteMin: rem / Math.max(30, fm.gs) / 60, warn: warnList,
      score: Math.round(this.score), comfort: this.comfort, ap: { on: this.ap.on, nav: this.ap.nav, appr: this.ap.appr, hdg: this.ap.hdg, alt: this.ap.altFt, spd: this.ap.spd },
      ils: ils ? { valid: ils.valid, locDots: ils.locDots, gsDots: ils.gsDots, ident: ils.ident, dist: ils.dist / M_PER_NM } : null,
      timeScale: this.timeScale, lights: { ...this.lights }, seatbelt: this.seatbelt, assist: fm.ctl.assist, hint: this.coach(), loadProgress: loadP, restartHold: clamp(this.restartHold / 0.7, 0, 1),
      wind: { dir: this.windFrom, kt: this.windKt }, destId: this.cfg.to.icao, fromId: this.cfg.from.icao, aircraft: s.name, progress: clamp(1 - rem / total, 0, 1), onGround: fm.wow, stall: fm.stalled || fm.stallWarn, nz: fm.nz,
      depRwy: this.depRwy, apprRwy: rwyIdent, rwyHdg, rwyDistNm, vr: s.vr, vapp: s.vapp, alphaFrac: fm.alpha / fm.alphaStall,
      offline: !!this.world?.terrain.offline, paxCount: s.pax, cabinMsg: this.cabinMsg, canWarp: this.ap.on && !fm.wow && fm.agl > 400 && rem > 35000,
      flightPlan: this.flightPlan, activeWpIdx: this.activeWpIdx, apPhase: this.ap.phase,
      flightPhase,
      track,
      fpaDeg,
      speedTrendKt: clamp(this.speedTrendSmoothed, -40, 40),
      vs0: s.vs0,
      vs1: s.vs1,
      v1: Math.max(20, Math.round(s.vr - 5)),
      v2: Math.round(s.vr + 10),
      vne: s.vne,
      fuelTimeMin,
      relWindDir: relWind,
      crosswindKt,
      headwindKt,
      qnhInHg: 29.92,
      oatC: Math.round(15 - (fm.pos.y / 1000) * 6.5),
      runwayRemM,
      pitchTarget,
      trim: fm.ctl.trim,
      atc: latestAtc,
      atcLog: this.atcMessages,
      activeWp,
    };
  }
}
void TAU; void G;
